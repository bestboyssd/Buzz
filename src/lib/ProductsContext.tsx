import React, {
  createContext,
  useContext,
  useEffect,
  useState,
  useMemo,
  useRef,
} from "react";
import {
  collection,
  onSnapshot,
  deleteDoc,
  doc,
  setDoc,
  getDoc,
} from "firebase/firestore";
import { db } from "./firebase";
import { useAuth } from "./AuthContext";
import { showLocalNotification, getAppBusinessIsoDate } from "./utils";
import { getImageUrl, preloadProductImages } from "./imageUtils";
import {
  sqliteSaveProducts,
  sqliteSaveProduct,
  sqliteDeleteProduct,
  sqliteGetProducts,
  sqliteClearProducts,
} from "./sqliteAdapter";
import type { CostBatch } from "./firestoreHooks";

export const getDeletedProductIds = (): Set<string> => {
  try {
    const raw = localStorage.getItem("deleted_product_ids");
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return new Set(parsed.map(String));
    }
  } catch {}
  return new Set<string>();
};

export const getDeletedProductNames = (): Set<string> => {
  try {
    const raw = localStorage.getItem("deleted_product_names");
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        return new Set(parsed.map((n) => String(n).toLowerCase().trim()).filter(Boolean));
      }
    }
  } catch {}
  return new Set<string>();
};

export const markProductDeletedLocal = (id: string, name?: string) => {
  try {
    if (id) {
      const set = getDeletedProductIds();
      set.add(String(id));
      localStorage.setItem("deleted_product_ids", JSON.stringify(Array.from(set).slice(-500)));
    }
    if (name && String(name).trim()) {
      const nameSet = getDeletedProductNames();
      nameSet.add(String(name).toLowerCase().trim());
      localStorage.setItem(
        "deleted_product_names",
        JSON.stringify(Array.from(nameSet).slice(-500))
      );
    }
  } catch {}
};

export const unmarkProductsDeletedLocal = (ids?: string[], names?: string[]) => {
  try {
    if (!ids && !names) {
      localStorage.removeItem("deleted_product_ids");
      localStorage.removeItem("deleted_product_names");
      localStorage.removeItem("products_purged_at");
      return;
    }
    if (ids && ids.length > 0) {
      const set = getDeletedProductIds();
      ids.forEach((id) => set.delete(String(id)));
      localStorage.setItem("deleted_product_ids", JSON.stringify(Array.from(set)));
    }
    if (names && names.length > 0) {
      const nameSet = getDeletedProductNames();
      names.forEach((n) => nameSet.delete(String(n).toLowerCase().trim()));
      localStorage.setItem("deleted_product_names", JSON.stringify(Array.from(nameSet)));
    }
  } catch {}
};

/**
 * Removes stock alert events for deleted products (or clears the entire stock_alerts_feed when clearAll=true)
 * from both local storage tracking and Firestore `settings/stock_alerts_feed`.
 */
export const purgeStockAlertsForDeletedProducts = async (
  productIds?: string[],
  productNames?: string[],
  clearAll: boolean = false
): Promise<void> => {
  const idSet = new Set((productIds || []).map((id) => String(id).trim()).filter(Boolean));
  const nameSet = new Set(
    (productNames || []).map((n) => String(n).toLowerCase().trim()).filter(Boolean)
  );

  // 1. Clean local stock tracking & buy price maps so stale stock states or buy-cost reminders never fire
  try {
    if (clearAll) {
      localStorage.removeItem("last_seen_stocks_v1");
      localStorage.removeItem("unset_buy_cost_first_seen_v1");
      localStorage.removeItem("local_product_buy_prices");
      localStorage.removeItem("local_product_cost_batches");
    } else if (idSet.size > 0 || nameSet.size > 0) {
      const rawStocks = localStorage.getItem("last_seen_stocks_v1");
      if (rawStocks) {
        const parsed = JSON.parse(rawStocks);
        if (parsed && typeof parsed === "object") {
          idSet.forEach((id) => delete parsed[id]);
          localStorage.setItem("last_seen_stocks_v1", JSON.stringify(parsed));
        }
      }
      const rawFirstSeen = localStorage.getItem("unset_buy_cost_first_seen_v1");
      if (rawFirstSeen) {
        const parsed = JSON.parse(rawFirstSeen);
        if (parsed && typeof parsed === "object") {
          idSet.forEach((id) => delete parsed[id]);
          localStorage.setItem("unset_buy_cost_first_seen_v1", JSON.stringify(parsed));
        }
      }
      const rawBuyPrices = localStorage.getItem("local_product_buy_prices");
      if (rawBuyPrices) {
        const parsed = JSON.parse(rawBuyPrices);
        if (parsed && typeof parsed === "object") {
          idSet.forEach((id) => delete parsed[`id:${id}`]);
          nameSet.forEach((n) => delete parsed[`name:${n}`]);
          localStorage.setItem("local_product_buy_prices", JSON.stringify(parsed));
        }
      }
      const rawBatches = localStorage.getItem("local_product_cost_batches");
      if (rawBatches) {
        const parsed = JSON.parse(rawBatches);
        if (parsed && typeof parsed === "object") {
          idSet.forEach((id) => delete parsed[`id:${id}`]);
          nameSet.forEach((n) => delete parsed[`name:${n}`]);
          localStorage.setItem("local_product_cost_batches", JSON.stringify(parsed));
        }
      }
    }
  } catch {}

  // 2. Clean Firestore `settings/product_buy_prices` so deleted products do not remain in cloud settings
  try {
    const buyPricesRef = doc(db, "settings", "product_buy_prices");
    if (clearAll) {
      await setDoc(buyPricesRef, { items: {}, updatedAt: Date.now() });
    } else if (idSet.size > 0 || nameSet.size > 0) {
      const bpSnap = await getDoc(buyPricesRef);
      if (bpSnap.exists()) {
        const bpData = bpSnap.data();
        const existingItems =
          bpData?.items && typeof bpData.items === "object" ? { ...bpData.items } : {};
        let bpChanged = false;
        for (const key of Object.keys(existingItems)) {
          const entry = existingItems[key];
          const entryId = String(entry?.id || key || "").trim();
          const entryName = String(entry?.name || "").toLowerCase().trim();
          if ((entryId && idSet.has(entryId)) || (entryName && nameSet.has(entryName))) {
            delete existingItems[key];
            bpChanged = true;
          }
        }
        if (bpChanged) {
          await setDoc(buyPricesRef, { items: existingItems, updatedAt: Date.now() });
        }
      }
    }
  } catch {}

  // 3. Clean Firestore `settings/stock_alerts_feed`
  try {
    const feedRef = doc(db, "settings", "stock_alerts_feed");
    if (clearAll) {
      await setDoc(
        feedRef,
        { latestAlerts: [], items: [], updatedAt: Date.now() },
        { merge: true }
      );
      return;
    }

    if (idSet.size === 0 && nameSet.size === 0) return;

    const snap = await getDoc(feedRef);
    if (!snap.exists()) return;
    const data = snap.data();
    const latestAlerts: any[] = Array.isArray(data?.latestAlerts) ? data.latestAlerts : [];
    const items: any[] = Array.isArray(data?.items) ? data.items : [];

    const shouldKeep = (entry: any) => {
      if (!entry || typeof entry !== "object") return false;
      const pid = String(entry.productId || "").trim();
      const pname = String(entry.productName || "").toLowerCase().trim();
      if (pid && idSet.has(pid)) return false;
      if (pname && nameSet.has(pname)) return false;
      return true;
    };

    const filteredLatest = latestAlerts.filter(shouldKeep);
    const filteredItems = items.filter(shouldKeep);

    if (
      filteredLatest.length !== latestAlerts.length ||
      filteredItems.length !== items.length
    ) {
      await setDoc(
        feedRef,
        {
          latestAlerts: filteredLatest,
          items: filteredItems,
          updatedAt: Date.now(),
        },
        { merge: true }
      );
    }
  } catch {}
};

export const isDummyProduct = (raw: any) => {
  if (!raw || typeof raw !== "object") return true;
  const p = raw.data && typeof raw.data === "object" && !Array.isArray(raw.data) ? { ...raw.data, ...raw } : raw;
  const id = String(p.id || "").toLowerCase().trim();
  const rawName = typeof p.name === "string" ? p.name.trim() : "";
  const name = rawName.toLowerCase();
  const hasInvalidPrice =
    p.price === undefined || p.price === null || isNaN(Number(p.price));

  return (
    !rawName ||
    hasInvalidPrice ||
    ["p1", "p2", "p3", "p4", "p5", "p6", "p7"].includes(id) ||
    name.includes("bytes test")
  );
};

export const getLocalSavedBuyPricesMap = (): Record<string, number> => {
  try {
    const raw = localStorage.getItem("local_product_buy_prices");
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object") return parsed;
    }
  } catch {}
  return {};
};

export const saveLocalBuyPriceEntry = (id?: string, name?: string, costPrice?: number) => {
  if (costPrice === undefined || costPrice === null || isNaN(Number(costPrice)) || Number(costPrice) < 0) return;
  try {
    const map = getLocalSavedBuyPricesMap();
    const numCost = Number(costPrice);
    if (id) map[`id:${String(id).trim()}`] = numCost;
    if (name) map[`name:${String(name).toLowerCase().trim()}`] = numCost;
    localStorage.setItem("local_product_buy_prices", JSON.stringify(map));
  } catch {}
};

export const getLocalSavedCostBatchesMap = (): Record<string, CostBatch[]> => {
  try {
    const raw = localStorage.getItem("local_product_cost_batches");
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object") return parsed;
    }
  } catch {}
  return {};
};

export const saveLocalCostBatchesEntry = (id?: string, name?: string, batches?: CostBatch[]) => {
  if (!Array.isArray(batches)) return;
  try {
    const map = getLocalSavedCostBatchesMap();
    const clean = batches
      .filter(
        (b) =>
          b &&
          typeof b === "object" &&
          !isNaN(Number(b.costPrice)) &&
          Number(b.costPrice) > 0 &&
          Math.max(0, Number(b.remainingQty ?? b.quantity ?? 0)) > 0
      )
      .map((b, idx) => {
        const rem = Math.max(0, Number(b.remainingQty ?? b.quantity ?? 0));
        const initQty = Math.max(rem, Number(b.quantity ?? b.remainingQty ?? rem));
        return {
          id: String(b.id || `batch_${Date.now()}_${idx}`),
          costPrice: Number(b.costPrice),
          remainingQty: rem,
          quantity: initQty,
          effectiveDate: Number(b.effectiveDate || b.createdAt) || Date.now(),
          createdAt: Number(b.createdAt) || Date.now(),
          ...(b.note ? { note: String(b.note) } : {}),
        };
      });
    if (id) map[`id:${String(id).trim()}`] = clean;
    if (name) map[`name:${String(name).toLowerCase().trim()}`] = clean;
    localStorage.setItem("local_product_cost_batches", JSON.stringify(map));
  } catch {}
};

export const normalizeAndDedupeProducts = (items: any[]): Product[] => {
  const deletedIds = getDeletedProductIds();
  const deletedNames = getDeletedProductNames();
  const savedBuyPrices = getLocalSavedBuyPricesMap();
  const savedCostBatches = getLocalSavedCostBatchesMap();
  const map = new Map<string, Product>();
  for (const rawItem of items) {
    if (!rawItem || typeof rawItem !== "object") continue;
    const item =
      rawItem.data && typeof rawItem.data === "object" && !Array.isArray(rawItem.data)
        ? { ...rawItem.data, ...rawItem, id: rawItem.id || rawItem.data.id }
        : rawItem;
    if (isDummyProduct(item)) continue;
    const cleanName = String(item.name || "").trim();
    const lowerName = cleanName.toLowerCase();
    const idStr = item.id ? String(item.id).trim() : undefined;
    if (idStr && deletedIds.has(idStr)) continue;
    if (lowerName && deletedNames.has(lowerName)) continue;

    const currentStock = Math.max(0, Number(item.stock) || 0);

    let rawBatches: any[] | undefined = Array.isArray(item.costBatches)
      ? item.costBatches
      : idStr && Array.isArray(savedCostBatches[`id:${idStr}`])
      ? savedCostBatches[`id:${idStr}`]
      : cleanName && Array.isArray(savedCostBatches[`name:${lowerName}`])
      ? savedCostBatches[`name:${lowerName}`]
      : undefined;

    let normalizedBatches: CostBatch[] | undefined = undefined;
    if (Array.isArray(rawBatches)) {
      let remainingCap = currentStock;
      const cleaned: CostBatch[] = [];
      for (let i = 0; i < rawBatches.length; i++) {
        const b = rawBatches[i];
        if (!b || typeof b !== "object") continue;
        const cp = Number(b.costPrice);
        const rawRem = Math.max(0, Number(b.remainingQty ?? b.quantity ?? 0));
        if (isNaN(cp) || cp <= 0 || rawRem <= 0) continue;
        const clampedRem = Math.min(rawRem, Math.max(0, remainingCap));
        if (clampedRem <= 0) continue;
        remainingCap -= clampedRem;
        cleaned.push({
          id: String(b.id || `batch_${Date.now()}_${i}`),
          costPrice: cp,
          remainingQty: clampedRem,
          quantity: Math.max(clampedRem, Number(b.quantity ?? rawRem)),
          effectiveDate: Number(b.effectiveDate || b.createdAt) || Date.now(),
          createdAt: Number(b.createdAt) || Date.now(),
          ...(b.note ? { note: String(b.note) } : {}),
        });
      }
      normalizedBatches = cleaned;
      saveLocalCostBatchesEntry(idStr, cleanName, cleaned);
    }

    let resolvedCostPrice: number | undefined = undefined;
    if (
      item.costPrice !== undefined &&
      item.costPrice !== null &&
      String(item.costPrice).trim() !== "" &&
      !isNaN(Number(item.costPrice)) &&
      Number(item.costPrice) >= 0
    ) {
      resolvedCostPrice = Number(item.costPrice);
    } else if (
      item.buyPrice !== undefined &&
      item.buyPrice !== null &&
      String(item.buyPrice).trim() !== "" &&
      !isNaN(Number(item.buyPrice)) &&
      Number(item.buyPrice) >= 0
    ) {
      resolvedCostPrice = Number(item.buyPrice);
    } else if (idStr && savedBuyPrices[`id:${idStr}`] !== undefined) {
      resolvedCostPrice = Number(savedBuyPrices[`id:${idStr}`]);
    } else if (cleanName && savedBuyPrices[`name:${lowerName}`] !== undefined) {
      resolvedCostPrice = Number(savedBuyPrices[`name:${lowerName}`]);
    } else if (Array.isArray(normalizedBatches) && normalizedBatches.length > 0) {
      const lastBatch = normalizedBatches[normalizedBatches.length - 1];
      if (lastBatch && !isNaN(Number(lastBatch.costPrice)) && Number(lastBatch.costPrice) >= 0) {
        resolvedCostPrice = Number(lastBatch.costPrice);
      }
    }

    if (resolvedCostPrice !== undefined) {
      saveLocalBuyPriceEntry(idStr, cleanName, resolvedCostPrice);
    }

    const normalized: Product = {
      ...item,
      id: idStr,
      name: cleanName,
      price: Math.max(0, Number(item.price) || 0),
      ...(resolvedCostPrice !== undefined ? { costPrice: resolvedCostPrice } : {}),
      ...(normalizedBatches !== undefined ? { costBatches: normalizedBatches } : {}),
      stock: currentStock,
      soldCount: Math.max(0, Number(item.soldCount) || 0),
      createdAt: Number(item.createdAt) || Date.now(),
    };
    const key = lowerName || normalized.id || "";
    if (!map.has(key)) {
      map.set(key, normalized);
    } else {
      const existing = map.get(key)!;
      map.set(key, {
        ...existing,
        ...(existing.costPrice === undefined && normalized.costPrice !== undefined
          ? { costPrice: normalized.costPrice }
          : {}),
        ...((!existing.costBatches || existing.costBatches.length === 0) &&
        normalized.costBatches &&
        normalized.costBatches.length > 0
          ? { costBatches: normalized.costBatches }
          : {}),
      });
    }
  }
  return Array.from(map.values());
};

export interface Product {
  id?: string;
  name: string;
  price: number;
  costPrice?: number;
  costBatches?: CostBatch[];
  stock: number;
  category?: "fresh" | "frozen" | "cold drinks" | "cold-drink" | string;
  image?: any;
  createdAt: number;
  soldCount?: number;
  updatedAt?: number;
}

interface ProductsContextType {
  products: Product[];
  loading: boolean;
  addProductOptimistic: (prod: Product) => void;
  updateProductOptimistic: (id: string, updates: Partial<Product>) => void;
  removeProductOptimistic: (id: string, name?: string) => void;
  clearProductsOptimistic: () => void;
  restoreProductsOptimistic: (restoredProducts: Product[]) => void;
}

const ProductsContext = createContext<ProductsContextType>({
  products: [],
  loading: true,
  addProductOptimistic: () => {},
  updateProductOptimistic: () => {},
  removeProductOptimistic: () => {},
  clearProductsOptimistic: () => {},
  restoreProductsOptimistic: () => {},
});

const persistLocalProductsFallback = (items: Product[]) => {
  try {
    localStorage.setItem("local_products_fallback", JSON.stringify(items));
  } catch {
    try {
      const light = items.map(({ image, ...rest }) => ({
        ...rest,
        image: typeof image === "string" && image.length < 2048 ? image : undefined,
      }));
      localStorage.setItem("local_products_fallback", JSON.stringify(light));
    } catch {}
  }
};

export function ProductsProvider({ children }: { children: React.ReactNode }) {
  // Initialize immediately from localStorage cache so catalog never flashes empty
  const [products, setProducts] = useState<Product[]>(() => {
    try {
      const cached = localStorage.getItem("local_products_fallback");
      if (cached) {
        const parsed = JSON.parse(cached) as Product[];
        const clean = normalizeAndDedupeProducts(parsed);
        preloadProductImages(clean);
        return clean;
      }
    } catch (e) {
      console.warn("Failed reading initial local_products_fallback", e);
    }
    return [];
  });

  const [loading, setLoading] = useState(true);
  const [isCloudSynced, setIsCloudSynced] = useState(false);
  const { user } = useAuth();
  const userRef = useRef(user);
  userRef.current = user;
  const lastSeenStocks = useRef<Record<string, number>>((() => {
    try {
      const saved = localStorage.getItem("last_seen_stocks_v1");
      if (saved) {
        const parsed = JSON.parse(saved);
        if (parsed && typeof parsed === "object") return parsed;
      }
      const fallback = localStorage.getItem("local_products_fallback");
      if (fallback) {
        const arr = JSON.parse(fallback);
        if (Array.isArray(arr)) {
          const map: Record<string, number> = {};
          arr.forEach((p: any) => {
            if (p && p.id !== undefined) map[String(p.id)] = Number(p.stock) || 0;
          });
          return map;
        }
      }
    } catch {}
    return {};
  })());
  const hasReceivedFirestoreSnapshot = useRef(false);

  // 1. Initial hydration from SQLite persistent database cache (restores full base64 images stripped from localStorage)
  useEffect(() => {
    const mountTime = Date.now();
    sqliteGetProducts()
      .then((cachedProds) => {
        if (hasReceivedFirestoreSnapshot.current) return;
        const purgedAt = Number(localStorage.getItem("products_purged_at") || "0");
        if (purgedAt >= mountTime) return;

        if (cachedProds && cachedProds.length > 0) {
          const clean = normalizeAndDedupeProducts(cachedProds);
          if (clean.length === 0) return;
          preloadProductImages(clean);
          setProducts((prev) => {
            if (hasReceivedFirestoreSnapshot.current) return prev;
            if (prev.length === 0) return clean;
            // Merge full images from SQLite into any lightweight localStorage fallback items
            const sqliteById = new Map<string, Product>();
            const sqliteByName = new Map<string, Product>();
            clean.forEach((sp) => {
              if (sp.id) sqliteById.set(sp.id, sp);
              if (sp.name) sqliteByName.set(sp.name.toLowerCase().trim(), sp);
            });
            const hydrated = prev.map((item) => {
              if (item.image) return item;
              const match =
                (item.id ? sqliteById.get(item.id) : undefined) ||
                (item.name ? sqliteByName.get(item.name.toLowerCase().trim()) : undefined);
              return match?.image ? { ...item, image: match.image } : item;
            });
            return normalizeAndDedupeProducts([...hydrated, ...clean]);
          });
          setLoading(false);
        }
      })
      .catch((e) => {
        console.warn("Error hydrating from SQLite cache:", e);
      });
  }, []);

  const addProductOptimistic = (newProd: Product) => {
    if (isDummyProduct(newProd)) return;
    unmarkProductsDeletedLocal(
      newProd.id ? [newProd.id] : undefined,
      newProd.name ? [newProd.name] : undefined
    );
    preloadProductImages([newProd]);
    sqliteSaveProduct(newProd).catch(() => {});
    setProducts((prev) => {
      const filtered = prev.filter(
        (p) =>
          !isDummyProduct(p) &&
          p.id !== newProd.id &&
          (p.name || "").toLowerCase().trim() !== (newProd.name || "").toLowerCase().trim()
      );
      const updated = normalizeAndDedupeProducts([newProd, ...filtered]);
      persistLocalProductsFallback(updated);
      return updated;
    });
  };

  const updateProductOptimistic = (id: string, updates: Partial<Product>) => {
    if (getDeletedProductIds().has(String(id))) return;
    if (updates.name && getDeletedProductNames().has(String(updates.name).toLowerCase().trim())) {
      unmarkProductsDeletedLocal([id], [updates.name]);
    }
    if (updates.image) preloadProductImages([{ image: updates.image }]);
    setProducts((prev) => {
      const updated = normalizeAndDedupeProducts(
        prev
          .filter((p) => !isDummyProduct(p))
          .map((p) => {
            if (p.id === id) {
              const merged = { ...p, ...updates, id };
              sqliteSaveProduct(merged).catch(() => {});
              return merged;
            }
            return p;
          })
      );
      persistLocalProductsFallback(updated);
      return updated;
    });
  };

  const removeProductOptimistic = (id: string, explicitName?: string) => {
    const targetObj = products.find((p) => p.id === id);
    const resolvedName = explicitName || targetObj?.name || "";
    const lowerName = resolvedName.toLowerCase().trim();

    // Also find any duplicate entries with the same name so they are removed together
    const matchingIds = new Set<string>([String(id)]);
    products.forEach((p) => {
      if (p.id && lowerName && (p.name || "").toLowerCase().trim() === lowerName) {
        matchingIds.add(String(p.id));
      }
    });

    matchingIds.forEach((delId) => {
      markProductDeletedLocal(delId, resolvedName);
      sqliteDeleteProduct(delId).catch(() => {});
    });

    setProducts((prev) => {
      const updated = prev.filter(
        (p) =>
          !isDummyProduct(p) &&
          (!p.id || !matchingIds.has(String(p.id))) &&
          (!lowerName || (p.name || "").toLowerCase().trim() !== lowerName)
      );
      persistLocalProductsFallback(updated);
      if (updated.length === 0) {
        sqliteClearProducts().catch(() => {});
        purgeStockAlertsForDeletedProducts(undefined, undefined, true).catch(() => {});
      } else {
        purgeStockAlertsForDeletedProducts(
          Array.from(matchingIds),
          resolvedName ? [resolvedName] : undefined,
          false
        ).catch(() => {});
      }
      return updated;
    });
  };

  const clearProductsOptimistic = () => {
    try {
      const currentIds = products.map((p) => p.id).filter(Boolean) as string[];
      const currentNames = products
        .map((p) => (p.name || "").toLowerCase().trim())
        .filter(Boolean);
      const idSet = getDeletedProductIds();
      currentIds.forEach((id) => idSet.add(String(id)));
      localStorage.setItem("deleted_product_ids", JSON.stringify(Array.from(idSet).slice(-500)));

      const nameSet = getDeletedProductNames();
      currentNames.forEach((n) => nameSet.add(n));
      localStorage.setItem(
        "deleted_product_names",
        JSON.stringify(Array.from(nameSet).slice(-500))
      );

      localStorage.setItem("products_purged_at", String(Date.now()));
      localStorage.setItem("local_products_fallback", "[]");
    } catch {}
    sqliteClearProducts().catch(() => {});
    purgeStockAlertsForDeletedProducts(undefined, undefined, true).catch(() => {});
    setProducts([]);
  };

  const restoreProductsOptimistic = (restoredProducts: Product[]) => {
    if (!Array.isArray(restoredProducts) || restoredProducts.length === 0) return;
    unmarkProductsDeletedLocal();
    setProducts((prev) => {
      const merged = normalizeAndDedupeProducts([...restoredProducts, ...prev]);
      merged.sort((a, b) => {
        const countA = Number(a.soldCount) || 0;
        const countB = Number(b.soldCount) || 0;
        if (countB !== countA) return countB - countA;
        return (Number(b.createdAt) || 0) - (Number(a.createdAt) || 0);
      });
      try {
        localStorage.setItem("local_products_fallback", JSON.stringify(merged));
      } catch {
        try {
          const light = merged.map(({ image, ...rest }) => ({
            ...rest,
            image: typeof image === "string" && image.length < 2048 ? image : undefined,
          }));
          localStorage.setItem("local_products_fallback", JSON.stringify(light));
        } catch {}
      }
      sqliteSaveProducts(merged).catch(() => {});
      return merged;
    });
  };

  useEffect(() => {
    const handleOfflineStockAdjust = (e: Event) => {
      const custom = e as CustomEvent<
        Array<{
          productId: string;
          stockDelta?: number;
          soldDelta?: number;
          exactStock?: number;
          exactSoldCount?: number;
          exactCostBatches?: CostBatch[];
        }>
      >;
      const adjustments = custom.detail;
      if (!Array.isArray(adjustments) || adjustments.length === 0) return;

      const deletedIds = getDeletedProductIds();
      const adjMap = new Map(
        adjustments
          .filter((a) => a && a.productId && !deletedIds.has(String(a.productId)))
          .map((a) => [a.productId, a])
      );
      if (adjMap.size === 0) return;

      setProducts((prev) => {
        const updated = prev.map((p) => {
          if (!p.id || !adjMap.has(p.id)) return p;
          const adj = adjMap.get(p.id)!;
          const nextStock =
            adj.exactStock !== undefined
              ? Math.max(0, Number(adj.exactStock) || 0)
              : Math.max(0, (Number(p.stock) || 0) + (Number(adj.stockDelta) || 0));
          const nextSold =
            adj.exactSoldCount !== undefined
              ? Math.max(0, Number(adj.exactSoldCount) || 0)
              : Math.max(0, (Number(p.soldCount) || 0) + (Number(adj.soldDelta) || 0));

          let nextBatches: CostBatch[] | undefined = p.costBatches;
          if (Array.isArray(adj.exactCostBatches)) {
            nextBatches = adj.exactCostBatches;
          } else if (Array.isArray(p.costBatches) && p.costBatches.length > 0 && Number(adj.stockDelta) < 0) {
            let toConsume = Math.abs(Number(adj.stockDelta));
            const remainingBatches: CostBatch[] = [];
            for (const b of p.costBatches) {
              const rem = Math.max(0, Number(b.remainingQty ?? b.quantity ?? 0));
              if (rem <= 0) continue;
              if (toConsume > 0) {
                const take = Math.min(rem, toConsume);
                toConsume -= take;
                const left = rem - take;
                if (left > 0) {
                  remainingBatches.push({ ...b, remainingQty: left });
                }
              } else {
                remainingBatches.push({ ...b, remainingQty: rem });
              }
            }
            nextBatches = remainingBatches;
          }

          if (Array.isArray(nextBatches)) {
            saveLocalCostBatchesEntry(p.id, p.name, nextBatches);
          }

          const merged: Product = {
            ...p,
            stock: nextStock,
            soldCount: nextSold,
            ...(nextBatches !== undefined ? { costBatches: nextBatches } : {}),
          };
          sqliteSaveProduct(merged).catch(() => {});
          return merged;
        });
        try {
          localStorage.setItem("local_products_fallback", JSON.stringify(updated));
        } catch {}
        return updated;
      });
    };

    window.addEventListener("offlineStockAdjust", handleOfflineStockAdjust);
    return () => window.removeEventListener("offlineStockAdjust", handleOfflineStockAdjust);
  }, []);

  useEffect(() => {
    // Subscribe once immediately on mount (during splash screen) without restarting when user object updates
    const collRef = collection(db, "products");

    const unsubscribe = onSnapshot(
      collRef,
      (snapshot) => {
        hasReceivedFirestoreSnapshot.current = true;
        setIsCloudSynced(true);
        const deletedIds = getDeletedProductIds();
        const deletedNames = getDeletedProductNames();
        const data: Product[] = [];
        const seenLiveByName = new Map<string, { id: string; updatedAt: number }>();

        snapshot.forEach((docSnap) => {
          const p = { ...docSnap.data(), id: docSnap.id } as Product;
          const lowerName = String(p.name || "").toLowerCase().trim();
          if (
            isDummyProduct(p) ||
            deletedIds.has(docSnap.id) ||
            (lowerName && deletedNames.has(lowerName))
          ) {
            // Actively purge dummy, ghost, or explicitly deleted product docs from database and SQLite
            deleteDoc(doc(db, "products", docSnap.id)).catch(() => {});
            sqliteDeleteProduct(docSnap.id).catch(() => {});
          } else {
            // If duplicate docs with the exact same name exist in Firestore, keep the most recently updated one and purge the ghost duplicate
            if (lowerName && seenLiveByName.has(lowerName)) {
              const prevSeen = seenLiveByName.get(lowerName)!;
              const currTime = Number(p.updatedAt || p.createdAt || 0);
              if (currTime > prevSeen.updatedAt) {
                deleteDoc(doc(db, "products", prevSeen.id)).catch(() => {});
                sqliteDeleteProduct(prevSeen.id).catch(() => {});
                const idx = data.findIndex((item) => item.id === prevSeen.id);
                if (idx !== -1) data.splice(idx, 1);
                seenLiveByName.set(lowerName, { id: docSnap.id, updatedAt: currTime });
                data.push(p);
              } else {
                deleteDoc(doc(db, "products", docSnap.id)).catch(() => {});
                sqliteDeleteProduct(docSnap.id).catch(() => {});
              }
            } else {
              if (lowerName) {
                seenLiveByName.set(lowerName, {
                  id: docSnap.id,
                  updatedAt: Number(p.updatedAt || p.createdAt || 0),
                });
              }
              data.push(p);
            }
          }
        });

        // Normalize and deduplicate products first so we evaluate clean canonical stock per product
        const cleanData = normalizeAndDedupeProducts(data);

        // Sort in memory: popularity first (soldCount desc), then newest first (createdAt desc)
        cleanData.sort((a, b) => {
          const countA = Number(a.soldCount) || 0;
          const countB = Number(b.soldCount) || 0;
          if (countB !== countA) {
            return countB - countA;
          }
          const timeA = Number(a.createdAt) || 0;
          const timeB = Number(b.createdAt) || 0;
          return timeB - timeA;
        });

        preloadProductImages(cleanData);
        setProducts(cleanData);
        persistLocalProductsFallback(cleanData);
        // Persist to local SQLite database cache (also clears SQLite if cleanData is empty)
        sqliteSaveProducts(cleanData).catch((e) => {
          console.warn("Failed saving products to SQLite cache:", e);
        });

        // If the authoritative catalog is empty, ensure stock_alerts_feed is wiped clean so deleted products never alert
        if (cleanData.length === 0) {
          purgeStockAlertsForDeletedProducts(undefined, undefined, true).catch(() => {});
        } else {
          // Prune any stale alerts in stock_alerts_feed belonging to products no longer in cleanData
          const validIds = new Set(cleanData.map((p) => String(p.id || "")).filter(Boolean));
          const feedRef = doc(db, "settings", "stock_alerts_feed");
          getDoc(feedRef)
            .then((snap) => {
              if (!snap.exists()) return;
              const fData = snap.data();
              const latest: any[] = Array.isArray(fData?.latestAlerts) ? fData.latestAlerts : [];
              const items: any[] = Array.isArray(fData?.items) ? fData.items : [];
              const nextLatest = latest.filter((it) => it && validIds.has(String(it.productId || "")));
              const nextItems = items.filter((it) => it && validIds.has(String(it.productId || "")));
              if (nextLatest.length !== latest.length || nextItems.length !== items.length) {
                setDoc(
                  feedRef,
                  { latestAlerts: nextLatest, items: nextItems, updatedAt: Date.now() },
                  { merge: true }
                ).catch(() => {});
              }
            })
            .catch(() => {});
        }

        setLoading(false);
      },
      (error) => {
        console.warn("Firestore products fetch failed. Loading SQLite cache...", error);
        if (!hasReceivedFirestoreSnapshot.current) {
          sqliteGetProducts()
            .then((cached) => {
              if (cached && cached.length > 0) {
                const clean = normalizeAndDedupeProducts(cached);
                preloadProductImages(clean);
                setProducts(clean);
              }
            })
            .catch((e) => {
              console.warn("Failed reading SQLite on error", e);
            })
            .finally(() => {
              setLoading(false);
            });
        } else {
          setLoading(false);
        }
      }
    );

    return () => unsubscribe();
  }, []);

  // Daily Morning Stock Reminder (Once in the morning, then again tomorrow — matching Set Buy Price schedule)
  useEffect(() => {
    if (!user || loading || !isCloudSynced) return;

    const evaluateDailyMorningStockReminder = () => {
      const uid = user.uid;
      const deletedIds = getDeletedProductIds();
      const deletedNames = getDeletedProductNames();
      const validProducts = products.filter(
        (p) =>
          p &&
          p.id &&
          !deletedIds.has(String(p.id)) &&
          !deletedNames.has(String(p.name || "").toLowerCase().trim())
      );

      const now = Date.now();
      const todayKey = getAppBusinessIsoDate(now);
      const userDailyKey = `daily_stock_notified_${uid}_${todayKey}`;
      const deviceDailyKey = `daily_stock_notified_device_${todayKey}`;

      if (validProducts.length === 0) {
        return;
      }

      // Load product IDs already notified today on this device/account
      const getDailySet = (key: string): Set<string> => {
        try {
          const raw = localStorage.getItem(key);
          if (raw) {
            const parsed = JSON.parse(raw);
            if (Array.isArray(parsed)) return new Set(parsed.map(String));
          }
        } catch {}
        return new Set<string>();
      };

      const userNotifiedSet = getDailySet(userDailyKey);
      const deviceNotifiedSet = getDailySet(deviceDailyKey);

      // If any product was restocked above 10, remove it from today's notified set
      let setsModified = false;
      validProducts.forEach((p) => {
        const s = Number(p.stock) || 0;
        if (s > 10 && p.id) {
          if (userNotifiedSet.has(p.id)) {
            userNotifiedSet.delete(p.id);
            setsModified = true;
          }
          if (deviceNotifiedSet.has(p.id)) {
            deviceNotifiedSet.delete(p.id);
            setsModified = true;
          }
        }
      });

      const outOfStockItems = validProducts.filter((p) => p.id && (Number(p.stock) || 0) === 0);
      const lowStockItems = validProducts.filter((p) => {
        const s = Number(p.stock) || 0;
        return p.id && s > 0 && s <= 10;
      });
      const allAttentionItems = [...outOfStockItems, ...lowStockItems];

      if (allAttentionItems.length === 0) {
        if (setsModified) {
          try {
            localStorage.setItem(userDailyKey, JSON.stringify(Array.from(userNotifiedSet)));
            localStorage.setItem(deviceDailyKey, JSON.stringify(Array.from(deviceNotifiedSet)));
          } catch {}
        }
        return;
      }

      // If this user account was just created within the last 3 minutes, silently seed today's set
      // so a brand-new account is never showered with notifications upon registration.
      const creationTimeStr = (user as any)?.metadata?.creationTime;
      const creationMs = creationTimeStr ? new Date(creationTimeStr).getTime() : 0;
      const isBrandNewAccount = creationMs > 0 && now - creationMs < 3 * 60 * 1000;
      if (isBrandNewAccount) {
        allAttentionItems.forEach((p) => {
          if (p.id) {
            userNotifiedSet.add(p.id);
            deviceNotifiedSet.add(p.id);
          }
        });
        try {
          localStorage.setItem(userDailyKey, JSON.stringify(Array.from(userNotifiedSet)));
          localStorage.setItem(deviceDailyKey, JSON.stringify(Array.from(deviceNotifiedSet)));
        } catch {}
        return;
      }

      // Check if we already fired the daily morning stock summary today on this device or for this user
      const dailySummarySentKey = `daily_stock_summary_sent_${todayKey}`;
      const userSummarySentKey = `daily_stock_summary_sent_${uid}_${todayKey}`;
      const alreadySentDailySummary =
        localStorage.getItem(dailySummarySentKey) === "true" ||
        localStorage.getItem(userSummarySentKey) === "true";

      const unnotifiedItems = allAttentionItems.filter(
        (p) => p.id && !userNotifiedSet.has(p.id) && !deviceNotifiedSet.has(p.id)
      );

      // Only fire ONCE per day (morning / first check of the day, and again tomorrow)
      if (!alreadySentDailySummary && unnotifiedItems.length > 0) {
        allAttentionItems.forEach((p) => {
          if (p.id) {
            userNotifiedSet.add(p.id);
            deviceNotifiedSet.add(p.id);
          }
        });
        try {
          localStorage.setItem(userDailyKey, JSON.stringify(Array.from(userNotifiedSet)));
          localStorage.setItem(deviceDailyKey, JSON.stringify(Array.from(deviceNotifiedSet)));
          localStorage.setItem(dailySummarySentKey, "true");
          localStorage.setItem(userSummarySentKey, "true");
        } catch {}

        const storageKey = `notifications_${uid}`;
        const notificationsEnabled = localStorage.getItem(storageKey) !== "false";
        if (!notificationsEnabled) return;

        const sampleNames = allAttentionItems
          .slice(0, 3)
          .map((p) => `"${p.name}" (${Number(p.stock) || 0})`)
          .join(", ");
        const moreCount = allAttentionItems.length - 3;

        let title = "📉 Daily Stock Reminder";
        let body = "";

        if (outOfStockItems.length > 0 && lowStockItems.length > 0) {
          title = `🚫 ${outOfStockItems.length} Out of Stock · ${lowStockItems.length} Low Stock`;
          body = `${sampleNames}${moreCount > 0 ? ` +${moreCount} more` : ""} need restocking today.`;
        } else if (outOfStockItems.length > 0) {
          title =
            outOfStockItems.length === 1
              ? "🚫 Out of Stock Reminder"
              : `🚫 ${outOfStockItems.length} Products Out of Stock`;
          body =
            outOfStockItems.length === 1
              ? `"${outOfStockItems[0].name}" is out of stock. Tap to restock in Inventory.`
              : `${sampleNames}${moreCount > 0 ? ` +${moreCount} more` : ""} are out of stock today.`;
        } else {
          title =
            lowStockItems.length === 1
              ? "📉 Low Stock Reminder"
              : `📉 ${lowStockItems.length} Products Running Low`;
          body =
            lowStockItems.length === 1
              ? `"${lowStockItems[0].name}" has only ${Number(lowStockItems[0].stock) || 0} left in stock.`
              : `${sampleNames}${moreCount > 0 ? ` +${moreCount} more` : ""} are running low on stock today.`;
        }

        showLocalNotification(
          title,
          body,
          getImageUrl(allAttentionItems[0]?.image),
          `daily_stock_reminder_${todayKey}`
        );
      } else if (setsModified) {
        try {
          localStorage.setItem(userDailyKey, JSON.stringify(Array.from(userNotifiedSet)));
          localStorage.setItem(deviceDailyKey, JSON.stringify(Array.from(deviceNotifiedSet)));
        } catch {}
      }
    };

    evaluateDailyMorningStockReminder();
    const interval = setInterval(evaluateDailyMorningStockReminder, 60 * 1000);
    document.addEventListener("visibilitychange", evaluateDailyMorningStockReminder);

    return () => {
      clearInterval(interval);
      document.removeEventListener("visibilitychange", evaluateDailyMorningStockReminder);
    };
  }, [user?.uid, loading, isCloudSynced, products]);

  return (
    <ProductsContext.Provider
      value={{
        products,
        loading,
        addProductOptimistic,
        updateProductOptimistic,
        removeProductOptimistic,
        clearProductsOptimistic,
        restoreProductsOptimistic,
      }}
    >
      {children}
    </ProductsContext.Provider>
  );
}

export function useGlobalProducts(searchQuery: string = "") {
  const context = useContext(ProductsContext);

  const filtered = useMemo(() => {
    if (!searchQuery) return context.products;
    const lower = searchQuery.toLowerCase().trim();
    return context.products.filter((p) =>
      (p.name || "").toLowerCase().includes(lower)
    );
  }, [context.products, searchQuery]);

  return {
    ...context,
    allProducts: context.products,
    products: filtered,
  };
}
