import { useState, useEffect, useMemo } from 'react';
import { collection, query, onSnapshot, addDoc, updateDoc, deleteDoc, doc, orderBy, where, serverTimestamp, setDoc, getDoc, getDocs, increment, writeBatch, runTransaction } from 'firebase/firestore';
import { db, handleFirestoreError, OperationType } from './firebase';
import { useAuth } from './AuthContext';
import { sqliteSaveBill, sqliteSaveProduct, sqliteDeleteProduct, sqliteDeleteBill } from './sqliteAdapter';
import {
    markProductDeletedLocal,
    unmarkProductsDeletedLocal,
    getDeletedProductIds,
    getDeletedProductNames,
    purgeStockAlertsForDeletedProducts,
    getLocalSavedBuyPricesMap,
    saveLocalBuyPriceEntry,
    saveLocalCostBatchesEntry,
} from './ProductsContext';

export interface CostBatch {
    id: string;
    costPrice: number;
    remainingQty?: number;
    quantity?: number;
    effectiveDate: number;
    createdAt: number;
    note?: string;
}

export interface Product {
    id?: string;
    name: string;
    price: number;
    costPrice?: number;
    costBatches?: CostBatch[];
    stock: number;
    category?: 'fresh' | 'frozen' | 'cold-drink' | string;
    image?: string;
    createdAt: number;
    soldCount?: number;
    updatedAt?: number;
}

export interface BillItem {
    productId: string;
    name: string;
    price: number;
    costPrice?: number;
    quantity: number;
}

export const normalizeCostBatches = (
    rawBatches: any,
    maxStockCap?: number
): CostBatch[] => {
    if (!Array.isArray(rawBatches) || rawBatches.length === 0) return [];
    let remainingCap =
        maxStockCap !== undefined && !isNaN(Number(maxStockCap))
            ? Math.max(0, Number(maxStockCap))
            : Infinity;
    const out: CostBatch[] = [];
    for (let i = 0; i < rawBatches.length; i++) {
        const b = rawBatches[i];
        if (!b || typeof b !== 'object') continue;
        const cp = Number(b.costPrice);
        const rawRem = Math.max(0, Number(b.remainingQty ?? b.quantity ?? 0));
        if (isNaN(cp) || cp <= 0 || rawRem <= 0) continue;
        const clampedRem = remainingCap === Infinity ? rawRem : Math.min(rawRem, Math.max(0, remainingCap));
        if (clampedRem <= 0) continue;
        if (remainingCap !== Infinity) {
            remainingCap -= clampedRem;
        }
        out.push({
            id: String(b.id || `batch_${Date.now()}_${i}`),
            costPrice: cp,
            remainingQty: clampedRem,
            quantity: Math.max(clampedRem, Number(b.quantity ?? rawRem)),
            effectiveDate: Number(b.effectiveDate || b.createdAt) || Date.now(),
            createdAt: Number(b.createdAt) || Date.now(),
            ...(b.note ? { note: String(b.note) } : {}),
        });
    }
    return out;
};

/**
 * Resolves the currently active unit buy cost (purchase price) of a product.
 * - If legacy stock batches (`costBatches`) still have remaining units (> 0), returns the FIFO front batch's costPrice.
 * - Otherwise, returns `product.costPrice` if set (> 0).
 * - If no buy price is set, returns `0` (so unset products are excluded from profit calculation).
 */
export const getEffectiveProductCost = (
    product?: Partial<Product> | null,
    _atTimestamp: number = Date.now()
): number => {
    if (!product) return 0;
    const stockCap =
        product.stock !== undefined && !isNaN(Number(product.stock))
            ? Math.max(0, Number(product.stock))
            : undefined;
    const activeBatches = normalizeCostBatches(product.costBatches, stockCap);
    if (activeBatches.length > 0) {
        return Math.max(0, Number(activeBatches[0].costPrice) || 0);
    }
    if (typeof product.costPrice === 'number' && !isNaN(product.costPrice) && product.costPrice > 0) {
        return Math.max(0, Number(product.costPrice));
    }
    const savedMap = getLocalSavedBuyPricesMap();
    const idKey = product.id ? `id:${String(product.id).trim()}` : '';
    const nameKey = product.name ? `name:${String(product.name).toLowerCase().trim()}` : '';
    if (idKey && savedMap[idKey] !== undefined && Number(savedMap[idKey]) > 0) {
        return Math.max(0, Number(savedMap[idKey]));
    }
    if (nameKey && savedMap[nameKey] !== undefined && Number(savedMap[nameKey]) > 0) {
        return Math.max(0, Number(savedMap[nameKey]));
    }
    return 0;
};

export interface ProductFifoStatus {
    hasBuyPrice: boolean;
    activeUnitCost: number;
    nextUnitCost: number;
    hasLockedLegacyStock: boolean;
    lockedLegacyUnits: number;
    batches: CostBatch[];
}

export const getProductFifoStatus = (product?: Partial<Product> | null): ProductFifoStatus => {
    if (!product) {
        return {
            hasBuyPrice: false,
            activeUnitCost: 0,
            nextUnitCost: 0,
            hasLockedLegacyStock: false,
            lockedLegacyUnits: 0,
            batches: [],
        };
    }
    const stockCap =
        product.stock !== undefined && !isNaN(Number(product.stock))
            ? Math.max(0, Number(product.stock))
            : undefined;
    const batches = normalizeCostBatches(product.costBatches, stockCap);
    let baseCost =
        typeof product.costPrice === 'number' && !isNaN(product.costPrice) && product.costPrice > 0
            ? Math.max(0, Number(product.costPrice))
            : 0;
    if (baseCost <= 0) {
        const savedMap = getLocalSavedBuyPricesMap();
        const idKey = product.id ? `id:${String(product.id).trim()}` : '';
        const nameKey = product.name ? `name:${String(product.name).toLowerCase().trim()}` : '';
        if (idKey && savedMap[idKey] !== undefined && Number(savedMap[idKey]) > 0) {
            baseCost = Math.max(0, Number(savedMap[idKey]));
        } else if (nameKey && savedMap[nameKey] !== undefined && Number(savedMap[nameKey]) > 0) {
            baseCost = Math.max(0, Number(savedMap[nameKey]));
        }
    }
    const activeUnitCost = batches.length > 0 ? batches[0].costPrice : baseCost;
    const nextUnitCost = baseCost > 0 ? baseCost : activeUnitCost;
    const lockedLegacyUnits = batches.reduce(
        (sum, b) => sum + Math.max(0, Number(b.remainingQty ?? b.quantity ?? 0)),
        0
    );
    const hasLockedLegacyStock =
        lockedLegacyUnits > 0 &&
        nextUnitCost > 0 &&
        batches.some((b) => Number(b.costPrice) !== nextUnitCost);

    return {
        hasBuyPrice: activeUnitCost > 0 || nextUnitCost > 0,
        activeUnitCost,
        nextUnitCost,
        hasLockedLegacyStock,
        lockedLegacyUnits: hasLockedLegacyStock ? lockedLegacyUnits : 0,
        batches,
    };
};

/**
 * Computes the updated `{ costPrice, costBatches }` when an admin sets or updates a product's buy price.
 * If the product already has a set buy price (> 0) and currently has stock (> 0),
 * those existing stock units remain locked at their previous buy price in `costBatches` (FIFO),
 * and `newCostPrice` takes effect automatically after those units are sold.
 */
export const buildUpdatedCostStateForPriceChange = (
    product: Partial<Product> | null | undefined,
    newCostPrice: number
): { costPrice: number; costBatches: CostBatch[] } => {
    const cleanNewCost = Math.min(10000, Math.max(0, Number(newCostPrice) || 0));
    if (cleanNewCost <= 0 || !product) {
        return { costPrice: 0, costBatches: [] };
    }

    const currentStock = Math.max(0, Number(product.stock) || 0);
    const prevBaseCost =
        typeof product.costPrice === 'number' && !isNaN(product.costPrice) && product.costPrice > 0
            ? Number(product.costPrice)
            : 0;
    const existingBatches = normalizeCostBatches(product.costBatches, currentStock);

    // If out of stock OR buy price is being set for the very first time, apply newCostPrice immediately to all units
    if (currentStock <= 0 || (prevBaseCost <= 0 && existingBatches.length === 0)) {
        return { costPrice: cleanNewCost, costBatches: [] };
    }

    const alreadyQueuedUnits = existingBatches.reduce(
        (sum, b) => sum + Math.max(0, Number(b.remainingQty ?? b.quantity ?? 0)),
        0
    );
    const unqueuedCurrentStock = Math.max(0, currentStock - alreadyQueuedUnits);
    const nextBatches: CostBatch[] = existingBatches.map((b) => ({ ...b }));

    // Lock the unqueued portion of existing stock at prevBaseCost before switching future stock to cleanNewCost
    if (unqueuedCurrentStock > 0 && prevBaseCost > 0 && prevBaseCost !== cleanNewCost) {
        const lastBatch = nextBatches[nextBatches.length - 1];
        if (lastBatch && Number(lastBatch.costPrice) === prevBaseCost) {
            const nextRem = Math.max(0, Number(lastBatch.remainingQty ?? lastBatch.quantity ?? 0)) + unqueuedCurrentStock;
            lastBatch.remainingQty = nextRem;
            lastBatch.quantity = Math.max(Number(lastBatch.quantity || 0), nextRem);
        } else {
            const now = Date.now();
            nextBatches.push({
                id: `batch_${now}_${Math.random().toString(36).slice(2, 6)}`,
                costPrice: prevBaseCost,
                remainingQty: unqueuedCurrentStock,
                quantity: unqueuedCurrentStock,
                effectiveDate: now,
                createdAt: now,
                note: `Locked ${unqueuedCurrentStock} units at ₹${prevBaseCost}`,
            });
        }
    }

    // If the user changed the new price back to match the trailing locked batch price, absorb that redundant tail batch
    while (
        nextBatches.length > 0 &&
        Number(nextBatches[nextBatches.length - 1].costPrice) === cleanNewCost
    ) {
        nextBatches.pop();
    }

    return {
        costPrice: cleanNewCost,
        costBatches: nextBatches,
    };
};

/**
 * Consumes `saleQty` units from the product's FIFO `costBatches` (if any) and returns:
 * - `unitCostPrice`: the exact FIFO weighted unit cost for this sale (`0` if buy price is unset)
 * - `updatedCostBatches`: the remaining `CostBatch[]` after deducting `saleQty`
 */
export const consumeProductCostBatchesForSale = (
    product: Partial<Product> | null | undefined,
    saleQty: number
): { unitCostPrice: number; updatedCostBatches: CostBatch[] } => {
    const qty = Math.max(1, Number(saleQty) || 1);
    if (!product) {
        return { unitCostPrice: 0, updatedCostBatches: [] };
    }
    const stockCap =
        product.stock !== undefined && !isNaN(Number(product.stock))
            ? Math.max(0, Number(product.stock))
            : undefined;
    const batches = normalizeCostBatches(product.costBatches, stockCap);
    const baseCost =
        typeof product.costPrice === 'number' && !isNaN(product.costPrice) && product.costPrice > 0
            ? Number(product.costPrice)
            : 0;

    if (batches.length === 0) {
        return {
            unitCostPrice: baseCost > 0 ? baseCost : 0,
            updatedCostBatches: [],
        };
    }

    let remainingToSell = qty;
    let totalCost = 0;
    let pricedUnits = 0;
    const updatedCostBatches: CostBatch[] = [];

    for (const b of batches) {
        const rem = Math.max(0, Number(b.remainingQty ?? b.quantity ?? 0));
        if (rem <= 0) continue;
        if (remainingToSell > 0) {
            const take = Math.min(rem, remainingToSell);
            totalCost += take * Number(b.costPrice);
            pricedUnits += take;
            remainingToSell -= take;
            const left = rem - take;
            if (left > 0) {
                updatedCostBatches.push({
                    ...b,
                    remainingQty: left,
                });
            }
        } else {
            updatedCostBatches.push({
                ...b,
                remainingQty: rem,
            });
        }
    }

    // Any units beyond the locked legacy batches use the new/updated product.costPrice
    if (remainingToSell > 0 && baseCost > 0) {
        totalCost += remainingToSell * baseCost;
        pricedUnits += remainingToSell;
    }

    const unitCostPrice =
        pricedUnits > 0 ? Math.round((totalCost / pricedUnits) * 10000) / 10000 : 0;

    return {
        unitCostPrice,
        updatedCostBatches,
    };
};

/**
 * Restores `restoredQty` units at `restoredUnitCost` back into `costBatches` when a bill is voided/deleted.
 */
export const restoreProductCostBatchesFromDeletedSale = (
    product: Partial<Product> | null | undefined,
    restoredQty: number,
    restoredUnitCost?: number
): CostBatch[] => {
    const qty = Math.max(0, Number(restoredQty) || 0);
    const unitCost = Number(restoredUnitCost) || 0;
    const existingBatches = normalizeCostBatches(product?.costBatches);
    const baseCost =
        typeof product?.costPrice === 'number' && !isNaN(product.costPrice) && product.costPrice > 0
            ? Number(product.costPrice)
            : 0;

    if (qty <= 0 || unitCost <= 0 || unitCost === baseCost) {
        return existingBatches;
    }

    const nextBatches = existingBatches.map((b) => ({ ...b }));
    if (nextBatches.length > 0 && Number(nextBatches[0].costPrice) === unitCost) {
        const nextRem = Math.max(0, Number(nextBatches[0].remainingQty ?? nextBatches[0].quantity ?? 0)) + qty;
        nextBatches[0].remainingQty = nextRem;
        nextBatches[0].quantity = Math.max(Number(nextBatches[0].quantity || 0), nextRem);
        return nextBatches;
    }

    const now = Date.now();
    return [
        {
            id: `batch_restored_${now}_${Math.random().toString(36).slice(2, 6)}`,
            costPrice: unitCost,
            remainingQty: qty,
            quantity: qty,
            effectiveDate: now,
            createdAt: now,
            note: `Restored ${qty} units at ₹${unitCost}`,
        },
        ...nextBatches,
    ];
};

export const getUpcomingCostBatch = (
    _product?: Partial<Product> | null,
    _now: number = Date.now()
): CostBatch | null => null;

export interface Bill {
    id?: string;
    items: BillItem[];
    total: number;
    date: number;
    status?: 'completed' | 'on_hold';
    pendingOfflineSync?: boolean;
    userId?: string;
    userName?: string;
    userEmail?: string;
    customerName?: string;
    customerPhone?: string;
    udhaarNote?: string;
    isUdhar?: boolean;
    linkedOtherCostId?: string;
    costCategory?: 'borrow' | 'due';
}

export interface UdhaarHoldOptions {
    isHold: boolean;
    customerName?: string;
    customerPhone?: string;
    udhaarNote?: string;
    linkToOtherCosts?: boolean;
    costCategory?: 'borrow' | 'due';
}

export const getUdhaarOtherCostDocId = (billId: string): string => `udhaar_bill_${billId}`;

export const syncUdhaarOtherCost = async (
    billId: string,
    total: number,
    options: UdhaarHoldOptions,
    ownerId?: string,
    existingCostId?: string
): Promise<string | undefined> => {
    const costId = existingCostId || getUdhaarOtherCostDocId(billId);
    if (!options.isHold || !options.linkToOtherCosts) {
        await removeUdhaarOtherCost(billId, existingCostId);
        return undefined;
    }

    const rawName = (options.customerName || '').trim();
    const hasCustomName = rawName.length > 0 && rawName.toLowerCase() !== 'walk-in customer';
    const custName = hasCustomName ? rawName : '';
    const custPhone = (options.customerPhone || '').trim();
    const note = (options.udhaarNote || '').trim();
    const shortBill = billId.slice(-5).toUpperCase();
    const fullTitle = hasCustomName ? `Udhar · ${rawName}` : `Udhar Bill #${shortBill}`;

    const record = {
        id: costId,
        title: fullTitle,
        name: fullTitle,
        amount: Math.min(10000, Math.max(0, Number(total) || 0)),
        category: options.costCategory === 'due' ? 'due' : 'borrow',
        date: Date.now(),
        ownerId: ownerId || 'offline_user',
        linkedBillId: billId,
        customerName: custName,
        customerPhone: custPhone,
        udhaarNote: note,
    };

    try {
        const raw = localStorage.getItem('local_other_costs_fallback');
        const list = raw ? JSON.parse(raw) : [];
        const safeList = Array.isArray(list) ? list : [];
        const filtered = safeList.filter((c: any) => c && c.id !== costId && c.linkedBillId !== billId);
        const updated = [record, ...filtered];
        localStorage.setItem('local_other_costs_fallback', JSON.stringify(updated));
        window.dispatchEvent(new CustomEvent('otherCostsUpdated', { detail: updated }));
    } catch {}

    setDoc(doc(db, 'other_costs', costId), record, { merge: true }).catch((e) =>
        console.warn('Could not sync Udhaar to other_costs:', e)
    );

    return costId;
};

export const removeUdhaarOtherCost = async (billId: string, explicitCostId?: string): Promise<void> => {
    const deterministicId = getUdhaarOtherCostDocId(billId);
    const idsToRemove = new Set<string>([deterministicId]);
    if (explicitCostId) idsToRemove.add(explicitCostId);

    try {
        const raw = localStorage.getItem('local_other_costs_fallback');
        if (raw) {
            const list = JSON.parse(raw);
            if (Array.isArray(list)) {
                list.forEach((c: any) => {
                    if (c?.linkedBillId === billId && c?.id) {
                        idsToRemove.add(String(c.id));
                    }
                });
                const next = list.filter(
                    (c: any) => c && !idsToRemove.has(String(c.id)) && c.linkedBillId !== billId
                );
                localStorage.setItem('local_other_costs_fallback', JSON.stringify(next));
                window.dispatchEvent(new CustomEvent('otherCostsUpdated', { detail: next }));
            }
        }
    } catch {}

    for (const cid of idsToRemove) {
        deleteDoc(doc(db, 'other_costs', cid)).catch(() => {});
    }
};

export interface SyncConflictItem {
    productId: string;
    name: string;
    productName?: string;
    requestedQty: number;
    availableStock: number;
}

export interface SyncConflictRecord {
    id: string;
    billId: string;
    items: BillItem[];
    conflictingItems: SyncConflictItem[];
    conflicts?: SyncConflictItem[];
    total: number;
    billDate: number;
    createdAt?: number;
    failedAt: number;
    conflictDetectedAt?: number;
    userId: string;
    userName: string;
    userEmail: string;
    reason: string;
    status: 'unresolved' | 'resolved_voided' | 'resolved_forced' | 'resolved_force_approved' | 'resolved_retried';
    resolvedAt?: number;
    resolvedBy?: string;
}

const OFFLINE_PENDING_BILLS_KEY = 'offline_pending_bills_v1';

export const getOfflinePendingBills = (): Bill[] => {
    try {
        const raw = localStorage.getItem(OFFLINE_PENDING_BILLS_KEY);
        if (raw) {
            const parsed = JSON.parse(raw);
            if (Array.isArray(parsed)) return parsed;
        }
    } catch {}
    return [];
};

export const saveOfflinePendingBills = (bills: Bill[]) => {
    try {
        if (bills.length === 0) {
            localStorage.removeItem(OFFLINE_PENDING_BILLS_KEY);
        } else {
            localStorage.setItem(OFFLINE_PENDING_BILLS_KEY, JSON.stringify(bills));
        }
        window.dispatchEvent(
            new CustomEvent('offlineQueueUpdated', { detail: { count: bills.length } })
        );
    } catch {}
};

export const removeOfflinePendingBill = (billId: string) => {
    const current = getOfflinePendingBills();
    const next = current.filter((b) => b.id !== billId);
    saveOfflinePendingBills(next);
};

export function useProducts(searchQuery: string = '') {
    const [products, setProducts] = useState<Product[]>([]);
    const [loading, setLoading] = useState(true);
    const { user } = useAuth();

    useEffect(() => {
        if (!user) {
            setProducts([]);
            setLoading(false);
            return;
        }

        const q = query(
            collection(db, 'products'),
            orderBy('createdAt', 'desc')
        );

        const unsubscribe = onSnapshot(q, (snapshot) => {
            const data: Product[] = [];
            snapshot.forEach((doc) => {
                data.push({ id: doc.id, ...doc.data() } as Product);
            });
            data.sort((a, b) => (b.soldCount || 0) - (a.soldCount || 0));
            setProducts(data);
            setLoading(false);
        }, (error) => {
            handleFirestoreError(error, OperationType.LIST, 'products');
        });

        return () => unsubscribe();
    }, [user]);

    const filtered = useMemo(() => {
        if (!searchQuery) return products;
        const lower = searchQuery.toLowerCase();
        return products.filter(p => (p.name || '').toLowerCase().includes(lower));
    }, [products, searchQuery]);

    return { products: filtered, loading };
}

export function useBills() {
    const [bills, setBills] = useState<Bill[]>([]);
    const [loading, setLoading] = useState(true);
    const { user } = useAuth();

    useEffect(() => {
        if (!user) {
            setBills([]);
            setLoading(false);
            return;
        }

        const q = query(
            collection(db, 'bills'),
            orderBy('date', 'desc')
        );

        const unsubscribe = onSnapshot(q, (snapshot) => {
            const data: Bill[] = [];
            snapshot.forEach((doc) => {
                data.push({ id: doc.id, ...doc.data() } as Bill);
            });
            setBills(data);
            setLoading(false);
        }, (error) => {
            handleFirestoreError(error, OperationType.LIST, 'bills');
        });

        return () => unsubscribe();
    }, [user]);

    return { bills, loading };
}

// Helper: execute a Firestore write that queues immediately in persistent IndexedDB cache.
// In Firestore with persistentLocalCache, calling setDoc/updateDoc/deleteDoc/batch.commit()
// synchronously enqueues the mutation locally and triggers local onSnapshot listeners in <5ms,
// while the returned Promise waits for the remote cloud server round-trip ACK.
// Resolving after a brief 40ms tick ensures the UI never gets stuck on "Saving..." on mobile
// while Firestore's background sync engine guarantees cloud delivery.
const commitOfflineReady = async (writePromise: Promise<any>, path: string, op: OperationType) => {
    writePromise.catch((e) => {
        console.warn(`Firestore background sync warning (${op} on ${path}):`, e);
    });
    await new Promise((resolve) => setTimeout(resolve, 40));
};

export const addProduct = async (product: Omit<Product, 'id'>, existingId?: string): Promise<string> => {
    const newDocRef = existingId ? doc(db, 'products', existingId) : doc(collection(db, 'products'));
    const cleanName = String(product.name || '').trim();
    unmarkProductsDeletedLocal([newDocRef.id], cleanName ? [cleanName] : undefined);
    const resolvedCostPrice =
        product.costPrice !== undefined && product.costPrice !== null && !isNaN(Number(product.costPrice)) && Number(product.costPrice) >= 0
            ? Math.min(10000, Math.max(0, Number(product.costPrice)))
            : undefined;
    const normalizedProduct = {
        ...product,
        name: cleanName,
        price: Math.min(10000, Math.max(0, Number(product.price) || 0)),
        ...(resolvedCostPrice !== undefined ? { costPrice: resolvedCostPrice } : {}),
        stock: Math.min(2000, Math.max(0, Number(product.stock) || 0)),
        soldCount: Math.max(0, Number(product.soldCount) || 0),
        createdAt: Number(product.createdAt) || Date.now(),
        updatedAt: Date.now(),
    };
    if (resolvedCostPrice !== undefined) {
        saveLocalBuyPriceEntry(newDocRef.id, cleanName, resolvedCostPrice);
        setDoc(
            doc(db, 'settings', 'product_buy_prices'),
            {
                items: {
                    [newDocRef.id]: {
                        id: newDocRef.id,
                        name: cleanName,
                        costPrice: resolvedCostPrice,
                        updatedAt: Date.now(),
                    },
                },
                updatedAt: Date.now(),
            },
            { merge: true }
        ).catch(() => {});
    }
    sqliteSaveProduct({ id: newDocRef.id, ...normalizedProduct }).catch(() => {});
    await commitOfflineReady(
        setDoc(newDocRef, normalizedProduct),
        'products',
        OperationType.CREATE
    );
    return newDocRef.id;
};

export const updateProduct = async (id: string, data: Partial<Product>): Promise<void> => {
    if (getDeletedProductIds().has(String(id))) return;
    if (data.name && getDeletedProductNames().has(String(data.name).toLowerCase().trim())) {
        unmarkProductsDeletedLocal([id], [data.name]);
    }
    const sanitizedData: Partial<Product> = { ...data };
    if (sanitizedData.stock !== undefined) {
        sanitizedData.stock = Math.min(2000, Math.max(0, Number(sanitizedData.stock) || 0));
    }
    if (sanitizedData.price !== undefined) {
        sanitizedData.price = Math.min(10000, Math.max(0, Number(sanitizedData.price) || 0));
    }
    if (Array.isArray(sanitizedData.costBatches)) {
        sanitizedData.costBatches = normalizeCostBatches(
            sanitizedData.costBatches,
            sanitizedData.stock
        );
        saveLocalCostBatchesEntry(id, sanitizedData.name, sanitizedData.costBatches);
    }
    if (sanitizedData.costPrice !== undefined || Array.isArray(sanitizedData.costBatches)) {
        if (sanitizedData.costPrice !== undefined) {
            sanitizedData.costPrice = Math.min(10000, Math.max(0, Number(sanitizedData.costPrice) || 0));
            saveLocalBuyPriceEntry(id, sanitizedData.name, sanitizedData.costPrice);
            if (sanitizedData.costPrice > 0) {
                backfillPreviousUnsetBillsWithBuyPrice(
                    id,
                    sanitizedData.name || '',
                    sanitizedData.costPrice
                );
            }
        }
        setDoc(
            doc(db, 'settings', 'product_buy_prices'),
            {
                items: {
                    [id]: {
                        id,
                        ...(sanitizedData.name ? { name: sanitizedData.name } : {}),
                        ...(sanitizedData.costPrice !== undefined
                            ? { costPrice: sanitizedData.costPrice }
                            : {}),
                        ...(Array.isArray(sanitizedData.costBatches)
                            ? { costBatches: sanitizedData.costBatches }
                            : {}),
                        updatedAt: Date.now(),
                    },
                },
                updatedAt: Date.now(),
            },
            { merge: true }
        ).catch(() => {});
    }
    const payload = { ...sanitizedData, updatedAt: Date.now() };
    sqliteSaveProduct({ id, ...payload } as Product).catch(() => {});
    await commitOfflineReady(
        setDoc(doc(db, 'products', id), payload, { merge: true }),
        `products/${id}`,
        OperationType.UPDATE
    );
};

/**
 * Retroactively backfills `costPrice` onto any previous bills where a line item matching
 * `productId` or `productName` was billed while its buy price was unset (`costPrice` missing or <= 0).
 * Bills that already had a positive `costPrice` recorded are preserved untouched.
 */
export const backfillPreviousUnsetBillsWithBuyPrice = (
    productId: string,
    productName: string,
    newBuyPrice: number
): void => {
    const cleanCost = Math.min(10000, Math.max(0, Number(newBuyPrice) || 0));
    if (cleanCost <= 0) return;
    const targetId = String(productId || '').toLowerCase().trim();
    const targetName = String(productName || '').toLowerCase().trim();
    if (!targetId && !targetName) return;

    try {
        localStorage.removeItem('local_z_reports_fallback');
        window.dispatchEvent(
            new CustomEvent('backfillBillsProductBuyPrice', {
                detail: {
                    productId: String(productId || '').trim(),
                    productName: String(productName || '').trim(),
                    costPrice: cleanCost,
                },
            })
        );
    } catch {}

    // Also update matching Firestore bills in the background so cloud records and future restores have the backfilled costPrice
    getDocs(collection(db, 'bills'))
        .then(async (snap) => {
            const updates: Array<{ id: string; items: BillItem[] }> = [];
            snap.forEach((docSnap) => {
                const data = docSnap.data();
                const rawItems = Array.isArray(data?.items) ? data.items : [];
                let modified = false;
                const nextItems = rawItems.map((it: any) => {
                    if (!it || typeof it !== 'object') return it;
                    const itId = String(it.productId || it.id || '').toLowerCase().trim();
                    const itName = String(it.name || '').toLowerCase().trim();
                    const matchesProduct =
                        (targetId && itId === targetId) || (targetName && itName === targetName);
                    const hasExistingPositiveCost =
                        it.costPrice !== undefined &&
                        it.costPrice !== null &&
                        !isNaN(Number(it.costPrice)) &&
                        Number(it.costPrice) > 0;
                    if (matchesProduct && !hasExistingPositiveCost) {
                        modified = true;
                        return { ...it, costPrice: cleanCost };
                    }
                    return it;
                });
                if (modified) {
                    updates.push({ id: docSnap.id, items: nextItems });
                }
            });

            for (let i = 0; i < updates.length; i += 400) {
                const batch = writeBatch(db);
                updates.slice(i, i + 400).forEach((u) => {
                    batch.update(doc(db, 'bills', u.id), { items: u.items });
                });
                await batch.commit();
            }
        })
        .catch(() => {});
};

export const deleteProduct = async (id: string, productName?: string): Promise<void> => {
    const cleanName = productName ? String(productName).trim() : '';
    markProductDeletedLocal(id, cleanName || undefined);
    sqliteDeleteProduct(id).catch(() => {});
    purgeStockAlertsForDeletedProducts(
        [id],
        cleanName ? [cleanName] : undefined,
        false
    ).catch(() => {});

    // Also sweep any duplicate product documents in Firestore that share the same name
    if (cleanName) {
        const lowerTarget = cleanName.toLowerCase();
        getDocs(collection(db, 'products'))
            .then((snap) => {
                snap.forEach((docSnap) => {
                    const dName = String(docSnap.data()?.name || '').toLowerCase().trim();
                    if (docSnap.id === id || (lowerTarget && dName === lowerTarget)) {
                        markProductDeletedLocal(docSnap.id, cleanName);
                        sqliteDeleteProduct(docSnap.id).catch(() => {});
                        deleteDoc(doc(db, 'products', docSnap.id)).catch(() => {});
                    }
                });
            })
            .catch(() => {});
    }

    await commitOfflineReady(
        deleteDoc(doc(db, 'products', id)),
        `products/${id}`,
        OperationType.DELETE
    );
};

export const addBill = async (bill: Omit<Bill, 'id'>) => {
    const newBillRef = doc(collection(db, 'bills'));
    const fullBill: Bill = {
        ...bill,
        id: newBillRef.id,
        date: Number(bill.date) || Date.now(),
        total: Math.min(10000, Math.max(0, Number(bill.total) || 0)),
    };
    sqliteSaveBill(fullBill).catch(() => {});
    await commitOfflineReady(
        setDoc(newBillRef, {
            items: fullBill.items,
            total: fullBill.total,
            date: fullBill.date,
            status: fullBill.status || 'completed',
        }),
        'bills',
        OperationType.CREATE
    );
};

export const checkoutNewBill = async (
    billItems: BillItem[],
    totalAmount: number,
    cashier?: { uid?: string; displayName?: string; email?: string },
    holdOptions?: UdhaarHoldOptions
) => {
    const billsColl = collection(db, 'bills');
    const newBillRef = doc(billsColl);
    const now = Date.now();

    const isHold = Boolean(holdOptions?.isHold);
    const custName = holdOptions?.customerName?.trim() || '';
    const custPhone = holdOptions?.customerPhone?.trim() || '';
    const udhaarNote = holdOptions?.udhaarNote?.trim() || '';
    const linkedCostId =
        isHold && holdOptions?.linkToOtherCosts ? getUdhaarOtherCostDocId(newBillRef.id) : undefined;
    const costCategory =
        isHold && holdOptions?.linkToOtherCosts ? holdOptions?.costCategory || 'borrow' : undefined;

    const billData: Bill = {
        id: newBillRef.id,
        items: billItems,
        total: Math.min(10000, Math.max(0, Number(totalAmount) || 0)),
        date: now,
        status: 'completed' as const,
        isUdhar: isHold,
        userId: cashier?.uid || '',
        userName: cashier?.displayName || 'Staff',
        userEmail: cashier?.email || '',
        ...(custName ? { customerName: custName } : {}),
        ...(custPhone ? { customerPhone: custPhone } : {}),
        ...(udhaarNote ? { udhaarNote } : {}),
        ...(linkedCostId ? { linkedOtherCostId: linkedCostId } : {}),
        ...(costCategory ? { costCategory } : {}),
    };

    const firestoreBillDoc: Record<string, any> = {
        items: billItems,
        total: billData.total,
        date: billData.date,
        status: 'completed',
        isUdhar: isHold,
        userId: billData.userId,
        userName: billData.userName,
        userEmail: billData.userEmail,
        ...(custName ? { customerName: custName } : {}),
        ...(custPhone ? { customerPhone: custPhone } : {}),
        ...(udhaarNote ? { udhaarNote } : {}),
        ...(linkedCostId ? { linkedOtherCostId: linkedCostId } : {}),
        ...(costCategory ? { costCategory } : {}),
    };

    // Aggregate quantities per productId to validate total required stock per product
    const aggregated = new Map<string, { productId: string; name: string; quantity: number }>();
    for (const item of billItems) {
        if (!item.productId) continue;
        const qty = Math.max(1, Number(item.quantity) || 1);
        const existing = aggregated.get(item.productId);
        if (existing) {
            existing.quantity += qty;
        } else {
            aggregated.set(item.productId, {
                productId: item.productId,
                name: item.name || 'Product',
                quantity: qty,
            });
        }
    }

    const isOnline = typeof navigator === 'undefined' ? true : navigator.onLine;

    if (isOnline && aggregated.size > 0) {
        let timedOut = false;
        try {
            const updatedProductsForCache: Product[] = [];
            await Promise.race([
                runTransaction(db, async (tx) => {
                    const entries = Array.from(aggregated.entries());
                    const snaps = await Promise.all(
                        entries.map(([productId]) => tx.get(doc(db, 'products', productId)))
                    );
                    if (timedOut) {
                        throw new Error('Transaction aborted after timeout');
                    }

                    const productSnaps = new Map<string, any>();
                    entries.forEach(([productId], idx) => {
                        productSnaps.set(productId, snaps[idx]);
                    });

                    // Validate live stock for all items before mutating anything
                    for (const [productId, req] of aggregated.entries()) {
                        const snap = productSnaps.get(productId);
                        if (!snap || !snap.exists()) {
                            const err: any = new Error(`"${req.name}" is no longer available in stock.`);
                            err.isInsufficientStock = true;
                            throw err;
                        }
                        const data = snap.data();
                        const currentStock = Math.max(0, Number(data?.stock ?? 0));
                        if (currentStock < req.quantity) {
                            const err: any = new Error(
                                currentStock <= 0
                                    ? `"${data?.name || req.name}" is out of stock (sold to another user).`
                                    : `Only ${currentStock} unit${currentStock === 1 ? '' : 's'} of "${data?.name || req.name}" left in stock (you selected ${req.quantity}).`
                            );
                            err.isInsufficientStock = true;
                            throw err;
                        }
                    }

                    // All items have sufficient stock; deduct atomically, consume FIFO costBatches, and record bill
                    const consumedUnitCostByProdId = new Map<string, number>();
                    for (const [productId, req] of aggregated.entries()) {
                        const snap = productSnaps.get(productId);
                        const data = snap.data();
                        const currentStock = Math.max(0, Number(data?.stock ?? 0));
                        const currentSold = Math.max(0, Number(data?.soldCount ?? 0));
                        const nextStock = currentStock - req.quantity;
                        const nextSold = currentSold + req.quantity;
                        const productRef = doc(db, 'products', productId);

                        const { unitCostPrice, updatedCostBatches } = consumeProductCostBatchesForSale(
                            { ...data, id: productId, stock: currentStock },
                            req.quantity
                        );
                        consumedUnitCostByProdId.set(productId, unitCostPrice);

                        tx.update(productRef, {
                            stock: nextStock,
                            soldCount: nextSold,
                            costBatches: updatedCostBatches,
                            updatedAt: now,
                        });

                        updatedProductsForCache.push({
                            ...data,
                            id: productId,
                            name: data?.name || req.name,
                            price: Number(data?.price ?? 0),
                            ...(data?.costPrice !== undefined && !isNaN(Number(data.costPrice))
                                ? { costPrice: Number(data.costPrice) }
                                : {}),
                            costBatches: updatedCostBatches,
                            stock: nextStock,
                            soldCount: nextSold,
                            createdAt: Number(data?.createdAt) || now,
                            updatedAt: now,
                        });
                    }

                    // Ensure every bill item records its exact FIFO unit buy cost (or omits costPrice if unset)
                    const enrichedItems = billItems.map((it) => {
                        const fifoUnitCost = consumedUnitCostByProdId.get(it.productId);
                        if (fifoUnitCost !== undefined) {
                            const cleaned = { ...it };
                            if (fifoUnitCost > 0) {
                                cleaned.costPrice = fifoUnitCost;
                            } else {
                                delete cleaned.costPrice;
                            }
                            return cleaned;
                        }
                        if (it.costPrice !== undefined && !isNaN(Number(it.costPrice)) && Number(it.costPrice) > 0) {
                            return { ...it, costPrice: Number(it.costPrice) };
                        }
                        const cleaned = { ...it };
                        delete cleaned.costPrice;
                        return cleaned;
                    });
                    billData.items = enrichedItems;
                    firestoreBillDoc.items = enrichedItems;

                    tx.set(newBillRef, firestoreBillDoc);
                }),
                new Promise((_, reject) =>
                    setTimeout(() => {
                        timedOut = true;
                        reject(new Error('Transaction timeout'));
                    }, 7500)
                ),
            ]);

            if (isHold && holdOptions?.linkToOtherCosts) {
                await syncUdhaarOtherCost(newBillRef.id, billData.total, holdOptions, cashier?.uid);
            }

            // Also persist updated FIFO costBatches in settings/product_buy_prices & local cache
            for (const p of updatedProductsForCache) {
                if (p.id && Array.isArray(p.costBatches)) {
                    saveLocalCostBatchesEntry(p.id, p.name, p.costBatches);
                    setDoc(
                        doc(db, 'settings', 'product_buy_prices'),
                        {
                            items: {
                                [p.id]: {
                                    id: p.id,
                                    name: p.name,
                                    ...(p.costPrice !== undefined ? { costPrice: p.costPrice } : {}),
                                    costBatches: p.costBatches,
                                    updatedAt: now,
                                },
                            },
                            updatedAt: now,
                        },
                        { merge: true }
                    ).catch(() => {});
                }
            }

            sqliteSaveBill(billData).catch(() => {});
            window.dispatchEvent(new CustomEvent('offlineBillQueued', { detail: billData }));
            window.dispatchEvent(
                new CustomEvent('offlineStockAdjust', {
                    detail: updatedProductsForCache.map((p) => ({
                        productId: String(p.id),
                        exactStock: p.stock,
                        exactSoldCount: p.soldCount,
                        exactCostBatches: p.costBatches,
                    })),
                })
            );

            for (const p of updatedProductsForCache) {
                sqliteSaveProduct(p).catch(() => {});
            }
            return newBillRef.id;
        } catch (txErr: any) {
            if (txErr?.isInsufficientStock) {
                throw txErr;
            }
            console.debug('Switching to offline queue fallback for checkout:', txErr?.message || txErr);
        }
    }

    // OFFLINE QUEUE MODE:
    // Verify against local cached stock first so the offline user cannot exceed locally known stock.
    let localProductsList: Product[] = [];
    try {
        const rawLocal = localStorage.getItem('local_products_fallback');
        if (rawLocal) {
            const parsed = JSON.parse(rawLocal);
            if (Array.isArray(parsed)) localProductsList = parsed;
        }
    } catch {}
    const localProdMap = new Map<string, Product>(
        localProductsList.filter((p) => p && p.id).map((p) => [String(p.id), p])
    );

    const offlineConsumedUnitCosts = new Map<string, number>();
    const offlineUpdatedBatches = new Map<string, CostBatch[]>();

    for (const [productId, req] of aggregated.entries()) {
        const cachedProd = localProdMap.get(productId);
        if (cachedProd) {
            const currentStock = Math.max(0, Number(cachedProd.stock ?? 0));
            if (currentStock < req.quantity) {
                const err: any = new Error(
                    currentStock <= 0
                        ? `"${cachedProd.name || req.name}" is out of stock.`
                        : `Only ${currentStock} unit${currentStock === 1 ? '' : 's'} of "${cachedProd.name || req.name}" left in stock (you selected ${req.quantity}).`
                );
                err.isInsufficientStock = true;
                throw err;
            }
            const { unitCostPrice, updatedCostBatches } = consumeProductCostBatchesForSale(
                cachedProd,
                req.quantity
            );
            offlineConsumedUnitCosts.set(productId, unitCostPrice);
            offlineUpdatedBatches.set(productId, updatedCostBatches);
        } else {
            try {
                const productRef = doc(db, 'products', productId);
                const snap: any = await Promise.race([
                    getDoc(productRef),
                    new Promise((_, reject) => setTimeout(() => reject(new Error('getDoc timeout')), 600)),
                ]);
                if (snap && snap.exists()) {
                    const data = snap.data();
                    const currentStock = Math.max(0, Number(data?.stock ?? 0));
                    if (currentStock < req.quantity) {
                        const err: any = new Error(
                            currentStock <= 0
                                ? `"${data?.name || req.name}" is out of stock.`
                                : `Only ${currentStock} unit${currentStock === 1 ? '' : 's'} of "${data?.name || req.name}" left in stock (you selected ${req.quantity}).`
                        );
                        err.isInsufficientStock = true;
                        throw err;
                    }
                    const { unitCostPrice, updatedCostBatches } = consumeProductCostBatchesForSale(
                        { ...data, id: productId, stock: currentStock },
                        req.quantity
                    );
                    offlineConsumedUnitCosts.set(productId, unitCostPrice);
                    offlineUpdatedBatches.set(productId, updatedCostBatches);
                }
            } catch (err: any) {
                if (err?.isInsufficientStock) throw err;
            }
        }
    }

    const enrichedOfflineItems = billItems.map((it) => {
        const fifoCost = offlineConsumedUnitCosts.get(it.productId);
        if (fifoCost !== undefined) {
            const cleaned = { ...it };
            if (fifoCost > 0) {
                cleaned.costPrice = fifoCost;
            } else {
                delete cleaned.costPrice;
            }
            return cleaned;
        }
        return it;
    });

    const offlineBill: Bill = {
        ...billData,
        items: enrichedOfflineItems,
        pendingOfflineSync: true,
    };

    if (isHold && holdOptions?.linkToOtherCosts) {
        await syncUdhaarOtherCost(newBillRef.id, billData.total, holdOptions, cashier?.uid);
    }

    const currentQueue = getOfflinePendingBills();
    saveOfflinePendingBills([offlineBill, ...currentQueue.filter((b) => b.id !== offlineBill.id)]);
    sqliteSaveBill(offlineBill).catch(() => {});

    // Optimistically reflect the bill, stock deduction, and FIFO costBatches deduction in local UI while offline
    window.dispatchEvent(new CustomEvent('offlineBillQueued', { detail: offlineBill }));
    window.dispatchEvent(
        new CustomEvent('offlineStockAdjust', {
            detail: Array.from(aggregated.values()).map((req) => ({
                productId: req.productId,
                stockDelta: -req.quantity,
                soldDelta: req.quantity,
                ...(offlineUpdatedBatches.has(req.productId)
                    ? { exactCostBatches: offlineUpdatedBatches.get(req.productId) }
                    : {}),
            })),
        })
    );

    return newBillRef.id;
};

let isSyncingOfflineBillsLock = false;

export const syncOfflinePendingBills = async (): Promise<void> => {
    if (isSyncingOfflineBillsLock) return;
    if (typeof navigator !== 'undefined' && !navigator.onLine) return;

    const queue = getOfflinePendingBills();
    if (queue.length === 0) return;

    isSyncingOfflineBillsLock = true;
    window.dispatchEvent(new CustomEvent('offlineSyncStateChanged', { detail: { syncing: true, count: queue.length } }));

    try {
        // Process oldest offline bills first
        const ordered = [...queue].sort((a, b) => (Number(a.date) || 0) - (Number(b.date) || 0));

        for (const pendingBill of ordered) {
            if (typeof navigator !== 'undefined' && !navigator.onLine) break;
            const billId = String(pendingBill.id || `bill_${Date.now()}`);
            const billItems = Array.isArray(pendingBill.items) ? pendingBill.items : [];

            const aggregated = new Map<string, { productId: string; name: string; quantity: number }>();
            for (const item of billItems) {
                if (!item.productId) continue;
                const qty = Math.max(1, Number(item.quantity) || 1);
                const existing = aggregated.get(item.productId);
                if (existing) {
                    existing.quantity += qty;
                } else {
                    aggregated.set(item.productId, {
                        productId: item.productId,
                        name: item.name || 'Product',
                        quantity: qty,
                    });
                }
            }

            try {
                const updatedProductsForCache: Product[] = [];
                await Promise.race([
                    runTransaction(db, async (tx) => {
                        const productSnaps = new Map<string, any>();
                        for (const [productId] of aggregated.entries()) {
                            const productRef = doc(db, 'products', productId);
                            const snap = await tx.get(productRef);
                            productSnaps.set(productId, snap);
                        }

                        const conflictingItems: SyncConflictItem[] = [];
                        const liveSnapshots: Array<{ productId: string; stock: number; soldCount: number }> = [];

                        for (const [productId, req] of aggregated.entries()) {
                            const snap = productSnaps.get(productId);
                            if (!snap || !snap.exists()) {
                                conflictingItems.push({
                                    productId,
                                    name: req.name,
                                    requestedQty: req.quantity,
                                    availableStock: 0,
                                });
                            } else {
                                const data = snap.data();
                                const currentStock = Math.max(0, Number(data?.stock ?? 0));
                                const currentSold = Math.max(0, Number(data?.soldCount ?? 0));
                                liveSnapshots.push({ productId, stock: currentStock, soldCount: currentSold });
                                if (currentStock < req.quantity) {
                                    conflictingItems.push({
                                        productId,
                                        name: data?.name || req.name,
                                        requestedQty: req.quantity,
                                        availableStock: currentStock,
                                    });
                                }
                            }
                        }

                        if (conflictingItems.length > 0) {
                            const conflictErr: any = new Error(
                                conflictingItems
                                    .map(
                                        (c) =>
                                            `${c.name} (billed ${c.requestedQty} offline, only ${c.availableStock} left online)`
                                    )
                                    .join(', ')
                            );
                            conflictErr.isOfflineStockConflict = true;
                            conflictErr.conflictingItems = conflictingItems;
                            conflictErr.liveSnapshots = liveSnapshots;
                            throw conflictErr;
                        }

                        const now = Date.now();
                        const consumedUnitCostByProdId = new Map<string, number>();
                        for (const [productId, req] of aggregated.entries()) {
                            const snap = productSnaps.get(productId);
                            const data = snap.data();
                            const currentStock = Math.max(0, Number(data?.stock ?? 0));
                            const currentSold = Math.max(0, Number(data?.soldCount ?? 0));
                            const nextStock = currentStock - req.quantity;
                            const nextSold = currentSold + req.quantity;
                            const productRef = doc(db, 'products', productId);

                            const { unitCostPrice, updatedCostBatches } = consumeProductCostBatchesForSale(
                                { ...data, id: productId, stock: currentStock },
                                req.quantity
                            );
                            consumedUnitCostByProdId.set(productId, unitCostPrice);

                            tx.update(productRef, {
                                stock: nextStock,
                                soldCount: nextSold,
                                costBatches: updatedCostBatches,
                                updatedAt: now,
                            });

                            updatedProductsForCache.push({
                                ...data,
                                id: productId,
                                name: data?.name || req.name,
                                price: Number(data?.price ?? 0),
                                ...(data?.costPrice !== undefined && !isNaN(Number(data.costPrice))
                                    ? { costPrice: Number(data.costPrice) }
                                    : {}),
                                costBatches: updatedCostBatches,
                                stock: nextStock,
                                soldCount: nextSold,
                                createdAt: Number(data?.createdAt) || now,
                                updatedAt: now,
                            });
                        }

                        const syncedItems = billItems.map((it) => {
                            const fifoCost = consumedUnitCostByProdId.get(it.productId);
                            if (fifoCost !== undefined) {
                                const cleaned = { ...it };
                                if (fifoCost > 0) {
                                    cleaned.costPrice = fifoCost;
                                } else {
                                    delete cleaned.costPrice;
                                }
                                return cleaned;
                            }
                            return it;
                        });

                        tx.set(doc(db, 'bills', billId), {
                            items: syncedItems,
                            total: Math.min(10000, Math.max(0, Number(pendingBill.total) || 0)),
                            date: Number(pendingBill.date) || Date.now(),
                            status: pendingBill.status || 'completed',
                            isUdhar: Boolean(pendingBill.isUdhar),
                            ...(pendingBill.userId ? { userId: pendingBill.userId } : {}),
                            ...(pendingBill.userName ? { userName: pendingBill.userName } : {}),
                            ...(pendingBill.userEmail ? { userEmail: pendingBill.userEmail } : {}),
                            ...(pendingBill.customerName ? { customerName: pendingBill.customerName } : {}),
                            ...(pendingBill.customerPhone ? { customerPhone: pendingBill.customerPhone } : {}),
                            ...(pendingBill.udhaarNote ? { udhaarNote: pendingBill.udhaarNote } : {}),
                            ...(pendingBill.linkedOtherCostId ? { linkedOtherCostId: pendingBill.linkedOtherCostId } : {}),
                            ...(pendingBill.costCategory ? { costCategory: pendingBill.costCategory } : {}),
                        });
                    }),
                    new Promise((_, reject) =>
                        setTimeout(() => reject(new Error('Sync transaction timeout')), 5000)
                    ),
                ]);

                // Offline bill succeeded server stock validation!
                removeOfflinePendingBill(billId);
                const syncedBill: Bill = { ...pendingBill, pendingOfflineSync: false };
                sqliteSaveBill(syncedBill).catch(() => {});
                window.dispatchEvent(new CustomEvent('offlineBillQueued', { detail: syncedBill }));
                window.dispatchEvent(new CustomEvent('offlineConflictResolvedByRetry', { detail: { billId, conflictId: `conflict_${billId}` } }));
                if (updatedProductsForCache.length > 0) {
                    window.dispatchEvent(
                        new CustomEvent('offlineStockAdjust', {
                            detail: updatedProductsForCache.map((p) => ({
                                productId: String(p.id),
                                exactStock: p.stock,
                                exactSoldCount: p.soldCount,
                                exactCostBatches: p.costBatches,
                            })),
                        })
                    );
                }
                // If this bill previously had a sync_conflicts entry, mark it resolved via retry
                const existingConflictRef = doc(db, 'sync_conflicts', `conflict_${billId}`);
                getDoc(existingConflictRef)
                    .then((snap) => {
                        if (snap.exists() && snap.data()?.status === 'unresolved') {
                            return setDoc(
                                existingConflictRef,
                                {
                                    status: 'resolved_retried',
                                    resolvedAt: Date.now(),
                                    resolvedBy: `${pendingBill.userName || 'Cashier'} (Retry All)`,
                                },
                                { merge: true }
                            );
                        }
                    })
                    .catch(() => {});
            } catch (syncErr: any) {
                if (syncErr?.isOfflineStockConflict) {
                    // Online user already billed this stock while this user was offline!
                    // 1. Remove the invalid offline bill from queue, SQLite, and BillsContext
                    removeOfflinePendingBill(billId);
                    sqliteDeleteBill(billId).catch(() => {});
                    window.dispatchEvent(new CustomEvent('offlineBillRejected', { detail: { billId } }));

                    // 2. Sync local product stock with real live cloud stock
                    if (Array.isArray(syncErr.liveSnapshots) && syncErr.liveSnapshots.length > 0) {
                        window.dispatchEvent(
                            new CustomEvent('offlineStockAdjust', {
                                detail: syncErr.liveSnapshots.map((s: any) => ({
                                    productId: s.productId,
                                    exactStock: s.stock,
                                    exactSoldCount: s.soldCount,
                                })),
                            })
                        );
                    }

                    // 3. Record Sync Conflict in Firestore for Admin review and notify the user
                    const conflictId = `conflict_${billId}`;
                    const nowTs = Date.now();
                    const normalizedConflicts: SyncConflictItem[] = (syncErr.conflictingItems || []).map((c: any) => ({
                        productId: String(c.productId || ''),
                        name: String(c.name || c.productName || 'Product'),
                        productName: String(c.productName || c.name || 'Product'),
                        requestedQty: Number(c.requestedQty) || 0,
                        availableStock: Number(c.availableStock) || 0,
                    }));
                    const conflictRecord: SyncConflictRecord = {
                        id: conflictId,
                        billId,
                        items: billItems,
                        conflictingItems: normalizedConflicts,
                        conflicts: normalizedConflicts,
                        total: Number(pendingBill.total) || 0,
                        billDate: Number(pendingBill.date) || nowTs,
                        createdAt: Number(pendingBill.date) || nowTs,
                        failedAt: nowTs,
                        conflictDetectedAt: nowTs,
                        userId: pendingBill.userId || '',
                        userName: pendingBill.userName || 'Staff',
                        userEmail: pendingBill.userEmail || '',
                        reason: `Offline bill #${billId.slice(-5)} failed validation because stock was already billed online: ${syncErr.message}`,
                        status: 'unresolved',
                    };

                    setDoc(doc(db, 'sync_conflicts', conflictId), conflictRecord, { merge: true }).catch((e) =>
                        console.warn('Failed to write sync_conflicts doc:', e)
                    );

                    logActivity(
                        'sync_conflict',
                        conflictRecord.reason,
                        conflictRecord.userId || 'offline_user',
                        conflictRecord.userName || 'Staff',
                        conflictRecord.userEmail || ''
                    ).catch(() => {});

                    window.dispatchEvent(
                        new CustomEvent('offlineSyncConflictDetected', { detail: conflictRecord })
                    );
                } else {
                    // Network hiccup or timeout — keep in queue for next online retry
                    console.warn('Offline bill sync deferred due to network:', syncErr);
                    break;
                }
            }
        }
    } finally {
        isSyncingOfflineBillsLock = false;
        window.dispatchEvent(
            new CustomEvent('offlineSyncStateChanged', {
                detail: { syncing: false, count: getOfflinePendingBills().length },
            })
        );
    }
};

export const retryAllOfflineConflictBills = async (conflictsToRetry: SyncConflictRecord[]): Promise<void> => {
    const existingQueue = getOfflinePendingBills();
    const byId = new Map<string, Bill>();
    existingQueue.forEach((b) => {
        if (b && b.id) byId.set(String(b.id), b);
    });
    conflictsToRetry.forEach((c) => {
        if (!c || !c.billId) return;
        byId.set(String(c.billId), {
            id: c.billId,
            items: Array.isArray(c.items) ? c.items : [],
            total: Number(c.total) || 0,
            date: Number(c.billDate || c.createdAt) || Date.now(),
            status: 'completed',
            pendingOfflineSync: true,
            userId: c.userId || '',
            userName: c.userName || 'Staff',
            userEmail: c.userEmail || '',
        });
    });
    const combined = Array.from(byId.values());
    if (combined.length > 0) {
        saveOfflinePendingBills(combined);
    }
    await syncOfflinePendingBills();
};

export const resolveSyncConflictVoid = async (conflictId: string, adminName: string) => {
    await setDoc(
        doc(db, 'sync_conflicts', conflictId),
        {
            status: 'resolved_voided',
            resolvedAt: Date.now(),
            resolvedBy: adminName || 'Admin',
        },
        { merge: true }
    );
};

export const resolveSyncConflictForceApprove = async (
    conflict: SyncConflictRecord,
    adminName: string
) => {
    const now = Date.now();
    const clampedTotal = Math.min(10000, Math.max(0, Number(conflict.total) || 0));
    const billDate = Number(conflict.billDate || conflict.createdAt) || now;
    const approvedBill: Bill = {
        id: conflict.billId,
        items: conflict.items || [],
        total: clampedTotal,
        date: billDate,
        status: 'completed',
        pendingOfflineSync: false,
    };

    // Create the bill in Firestore and clamp product stock to >= 0
    await setDoc(
        doc(db, 'bills', conflict.billId),
        {
            items: approvedBill.items,
            total: approvedBill.total,
            date: approvedBill.date,
            status: 'completed',
        },
        { merge: true }
    );
    sqliteSaveBill(approvedBill).catch(() => {});
    window.dispatchEvent(new CustomEvent('offlineBillQueued', { detail: approvedBill }));

    for (const item of conflict.items || []) {
        if (!item?.productId) continue;
        try {
            const pRef = doc(db, 'products', item.productId);
            const pSnap = await getDoc(pRef);
            if (pSnap.exists()) {
                const pData = pSnap.data();
                const curStock = Math.max(0, Number(pData?.stock ?? 0));
                const curSold = Math.max(0, Number(pData?.soldCount ?? 0));
                const qty = Math.max(1, Number(item.quantity) || 1);
                const nextStock = Math.max(0, curStock - qty);
                const nextSold = curSold + qty;
                await setDoc(
                    pRef,
                    {
                        stock: nextStock,
                        soldCount: nextSold,
                        updatedAt: now,
                    },
                    { merge: true }
                );
                window.dispatchEvent(
                    new CustomEvent('offlineStockAdjust', {
                        detail: [{ productId: item.productId, exactStock: nextStock, exactSoldCount: nextSold }],
                    })
                );
            }
        } catch {}
    }

    await setDoc(
        doc(db, 'sync_conflicts', conflict.id),
        {
            status: 'resolved_forced',
            resolvedAt: now,
            resolvedBy: adminName || 'Admin',
        },
        { merge: true }
    );
};

export const deleteBill = async (id: string) => {
    removeOfflinePendingBill(id);
    sqliteDeleteBill(id).catch(() => {});
    window.dispatchEvent(new CustomEvent('offlineBillRejected', { detail: { billId: id } }));
    await commitOfflineReady(
        deleteDoc(doc(db, 'bills', id)),
        `bills/${id}`,
        OperationType.DELETE
    );
};

export const deleteBillAndRestoreStock = async (billId: string, items: BillItem[]) => {
    try {
        const billRef = doc(db, 'bills', billId);
        const pendingQueue = getOfflinePendingBills();
        const wasPendingOffline = pendingQueue.some((b) => b.id === billId);

        // 1. Remove from offline pending queue, linked Other Costs, and local UI / SQLite immediately
        removeOfflinePendingBill(billId);
        removeUdhaarOtherCost(billId).catch(() => {});
        sqliteDeleteBill(billId).catch(() => {});
        window.dispatchEvent(new CustomEvent('offlineBillRejected', { detail: { billId } }));

        // Delete the bill document from Firestore (if it was already synced or queued)
        if (!wasPendingOffline) {
            deleteDoc(billRef).catch((delErr) => {
                console.error('Failed to delete bill document from Firestore:', delErr);
            });
        }

        // 2. Restore product quantities locally & in Firestore
        if (items && Array.isArray(items) && items.length > 0) {
            const aggregated = new Map<
                string,
                { productId: string; name: string; price: number; quantity: number; costPrice?: number }
            >();
            for (const item of items) {
                if (!item || !item.productId) continue;
                const pid = item.productId;
                const q = Math.max(1, Number(item.quantity || 1));
                const p = Number(item.price || 0);
                const cp =
                    item.costPrice !== undefined && !isNaN(Number(item.costPrice)) && Number(item.costPrice) > 0
                        ? Number(item.costPrice)
                        : undefined;
                const n = item.name || 'Restored Product';
                if (aggregated.has(pid)) {
                    const existing = aggregated.get(pid)!;
                    existing.quantity += q;
                    if (existing.costPrice === undefined && cp !== undefined) {
                        existing.costPrice = cp;
                    }
                } else {
                    aggregated.set(pid, { productId: pid, name: n, price: p, quantity: q, costPrice: cp });
                }
            }

            // Immediately restore stock in local ProductsContext & SQLite
            window.dispatchEvent(
                new CustomEvent('offlineStockAdjust', {
                    detail: Array.from(aggregated.values()).map((req) => ({
                        productId: req.productId,
                        stockDelta: req.quantity,
                        soldDelta: -req.quantity,
                    })),
                })
            );

            // If the bill was only in the local offline queue, stock was never deducted in cloud Firestore
            if (wasPendingOffline) return;

            const deletedIds = getDeletedProductIds();
            const deletedNames = getDeletedProductNames();
            for (const { productId, name, price, quantity, costPrice: itemCostPrice } of aggregated.values()) {
                if (deletedIds.has(productId) || (name && deletedNames.has(String(name).toLowerCase().trim()))) continue;
                const productRef = doc(db, 'products', productId);
                try {
                    let productSnap: any = null;
                    try {
                        productSnap = await Promise.race([
                            getDoc(productRef),
                            new Promise((_, reject) => setTimeout(() => reject(new Error('getDoc timeout')), 1200)),
                        ]);
                    } catch (getErr) {
                        console.warn(`Could not read product ${productId}:`, getErr);
                    }

                    if (
                        productSnap &&
                        productSnap.exists() &&
                        !getDeletedProductIds().has(productId) &&
                        !getDeletedProductNames().has(String(productSnap.data()?.name || name || '').toLowerCase().trim())
                    ) {
                        const currentData = productSnap.data();
                        const currentStock = Number(currentData?.stock ?? 0);
                        const currentSoldCount = Number(currentData?.soldCount ?? 0);
                        const restoredBatches = restoreProductCostBatchesFromDeletedSale(
                            currentData,
                            quantity,
                            itemCostPrice
                        );
                        const updatedProduct: Product = {
                            ...currentData,
                            name: currentData.name || name,
                            price: Number(currentData.price ?? price),
                            costBatches: restoredBatches,
                            stock: currentStock + quantity,
                            soldCount: Math.max(0, currentSoldCount - quantity),
                            updatedAt: Date.now(),
                        };
                        saveLocalCostBatchesEntry(productId, updatedProduct.name, restoredBatches);
                        setDoc(productRef, updatedProduct).catch(() => {});
                        sqliteSaveProduct({ id: productId, ...updatedProduct }).catch(() => {});
                        window.dispatchEvent(
                            new CustomEvent('offlineStockAdjust', {
                                detail: [
                                    {
                                        productId,
                                        exactStock: updatedProduct.stock,
                                        exactSoldCount: updatedProduct.soldCount,
                                        exactCostBatches: restoredBatches,
                                    },
                                ],
                            })
                        );
                    }
                } catch (itemErr) {
                    console.warn(`Error updating product ${productId}:`, itemErr);
                }
            }
        }
    } catch (e) {
        console.error('Unexpected error in deleteBillAndRestoreStock:', e);
    }
};

export const putBillOnHold = async (billId: string, items?: BillItem[], currentStatus?: string) => {
    const pendingQueue = getOfflinePendingBills();
    if (pendingQueue.some((b) => b.id === billId)) {
        saveOfflinePendingBills(
            pendingQueue.map((b) => (b.id === billId ? { ...b, status: 'on_hold' } : b))
        );
        return;
    }
    const billRef = doc(db, 'bills', billId);
    await commitOfflineReady(
        setDoc(billRef, { status: 'on_hold' }, { merge: true }),
        `bills/${billId}`,
        OperationType.UPDATE
    );
};

export const revertBillFromHold = async (billId: string, originalStatus: string = 'completed') => {
    const pendingQueue = getOfflinePendingBills();
    if (pendingQueue.some((b) => b.id === billId)) {
        saveOfflinePendingBills(
            pendingQueue.map((b) =>
                b.id === billId ? { ...b, status: originalStatus as 'completed' | 'on_hold' } : b
            )
        );
        return;
    }
    const billRef = doc(db, 'bills', billId);
    await commitOfflineReady(
        setDoc(billRef, { status: originalStatus }, { merge: true }),
        `bills/${billId}`,
        OperationType.UPDATE
    );
};

export const settleHoldBill = async (bill: Bill): Promise<Bill> => {
    const billId = String(bill.id || '');
    if (!billId) return bill;
    await removeUdhaarOtherCost(billId, bill.linkedOtherCostId);

    const settledBill: Bill = {
        ...bill,
        status: 'completed',
        isUdhar: false,
        customerName: undefined,
        customerPhone: undefined,
        udhaarNote: undefined,
        linkedOtherCostId: undefined,
        costCategory: undefined,
    };

    const pendingQueue = getOfflinePendingBills();
    if (pendingQueue.some((b) => b.id === billId)) {
        saveOfflinePendingBills(
            pendingQueue.map((b) => (b.id === billId ? settledBill : b))
        );
    } else {
        setDoc(
            doc(db, 'bills', billId),
            {
                status: 'completed',
                isUdhar: false,
                customerName: '',
                customerPhone: '',
                udhaarNote: '',
                linkedOtherCostId: '',
                costCategory: '',
            },
            { merge: true }
        ).catch((e) => console.warn('Failed settling Udhar bill:', e));
    }

    sqliteSaveBill(settledBill).catch(() => {});
    window.dispatchEvent(new CustomEvent('offlineBillQueued', { detail: settledBill }));
    return settledBill;
};

export const saveBillUdhaarDetails = async (
    bill: Bill,
    options: UdhaarHoldOptions,
    ownerId?: string
): Promise<Bill> => {
    const billId = String(bill.id || '');
    if (!billId) return bill;

    const custName = (options.customerName || '').trim();
    const custPhone = (options.customerPhone || '').trim();
    const udhaarNote = (options.udhaarNote || '').trim();
    const isUdhar = Boolean(options.isHold);

    let linkedCostId: string | undefined = undefined;
    if (isUdhar && options.linkToOtherCosts) {
        linkedCostId = await syncUdhaarOtherCost(
            billId,
            bill.total,
            options,
            ownerId,
            bill.linkedOtherCostId
        );
    } else {
        await removeUdhaarOtherCost(billId, bill.linkedOtherCostId);
    }

    const updatedBill: Bill = {
        ...bill,
        status: 'completed',
        isUdhar,
        customerName: custName || undefined,
        customerPhone: custPhone || undefined,
        udhaarNote: udhaarNote || undefined,
        linkedOtherCostId: linkedCostId,
        costCategory: isUdhar && options.linkToOtherCosts ? options.costCategory || 'borrow' : undefined,
    };

    const firestorePayload = {
        status: 'completed',
        isUdhar,
        customerName: custName,
        customerPhone: custPhone,
        udhaarNote: udhaarNote,
        linkedOtherCostId: linkedCostId || '',
        costCategory: updatedBill.costCategory || '',
    };

    const pendingQueue = getOfflinePendingBills();
    if (pendingQueue.some((b) => b.id === billId)) {
        saveOfflinePendingBills(
            pendingQueue.map((b) => (b.id === billId ? updatedBill : b))
        );
    } else {
        setDoc(doc(db, 'bills', billId), firestorePayload, { merge: true }).catch((e) =>
            console.warn('Failed updating bill Udhar details:', e)
        );
    }

    sqliteSaveBill(updatedBill).catch(() => {});
    window.dispatchEvent(new CustomEvent('offlineBillQueued', { detail: updatedBill }));
    return updatedBill;
};

export const updateBill = async (
    billId: string,
    newItems: BillItem[],
    oldItems: BillItem[],
    total: number,
    holdOptions?: UdhaarHoldOptions,
    ownerId?: string
) => {
    const billRef = doc(db, 'bills', billId);
    const now = Date.now();
    const clampedTotal = Math.min(10000, Math.max(0, Number(total) || 0));

    const stockDiffs: Record<
        string,
        { stockDiff: number; soldCountDiff: number; name: string; price: number; oldCostPrice?: number }
    > = {};

    if (oldItems && Array.isArray(oldItems)) {
        for (const item of oldItems) {
            if (!item.productId) continue;
            if (!stockDiffs[item.productId]) {
                stockDiffs[item.productId] = {
                    stockDiff: 0,
                    soldCountDiff: 0,
                    name: item.name || 'Restored Product',
                    price: Math.max(0, Number(item.price || 0)),
                    oldCostPrice:
                        item.costPrice !== undefined && !isNaN(Number(item.costPrice)) && Number(item.costPrice) > 0
                            ? Number(item.costPrice)
                            : undefined,
                };
            }
            stockDiffs[item.productId].stockDiff += Number(item.quantity || 0);
            stockDiffs[item.productId].soldCountDiff -= Number(item.quantity || 0);
        }
    }

    if (newItems && Array.isArray(newItems)) {
        for (const item of newItems) {
            if (!item.productId) continue;
            if (!stockDiffs[item.productId]) {
                stockDiffs[item.productId] = {
                    stockDiff: 0,
                    soldCountDiff: 0,
                    name: item.name || 'Restored Product',
                    price: Math.max(0, Number(item.price || 0)),
                };
            } else {
                if (item.name) stockDiffs[item.productId].name = item.name;
                if (item.price !== undefined) stockDiffs[item.productId].price = Math.max(0, Number(item.price || 0));
            }
            stockDiffs[item.productId].stockDiff -= Number(item.quantity || 0);
            stockDiffs[item.productId].soldCountDiff += Number(item.quantity || 0);
        }
    }

    const deletedIds = getDeletedProductIds();

    // First verify that any net stock deductions (stockDiff < 0) have sufficient stock
    for (const [productId, diffs] of Object.entries(stockDiffs)) {
        if (diffs.stockDiff >= 0 || deletedIds.has(productId)) continue;
        const neededExtra = Math.abs(diffs.stockDiff);
        const productRef = doc(db, 'products', productId);
        try {
            const productSnap: any = await Promise.race([
                getDoc(productRef),
                new Promise((_, reject) => setTimeout(() => reject(new Error('getDoc timeout')), 1200)),
            ]);
            if (productSnap && productSnap.exists()) {
                const currentData = productSnap.data();
                const currentStock = Math.max(0, Number(currentData?.stock ?? 0));
                if (currentStock < neededExtra) {
                    const err: any = new Error(
                        currentStock <= 0
                            ? `"${currentData?.name || diffs.name}" has no extra stock available.`
                            : `Only ${currentStock} extra unit${currentStock === 1 ? '' : 's'} of "${currentData?.name || diffs.name}" left in stock.`
                    );
                    err.isInsufficientStock = true;
                    throw err;
                }
            }
        } catch (checkErr: any) {
            if (checkErr?.isInsufficientStock) throw checkErr;
        }
    }

    const pendingQueue = getOfflinePendingBills();
    const isPendingOffline = pendingQueue.some((b) => b.id === billId);

    const isHold = Boolean(holdOptions?.isHold);
    const custName = (holdOptions?.customerName || '').trim();
    const custPhone = (holdOptions?.customerPhone || '').trim();
    const udhaarNote = (holdOptions?.udhaarNote || '').trim();

    let linkedCostId: string | undefined = undefined;
    if (holdOptions !== undefined) {
        if (isHold && holdOptions.linkToOtherCosts) {
            linkedCostId = await syncUdhaarOtherCost(billId, clampedTotal, holdOptions, ownerId);
        } else {
            await removeUdhaarOtherCost(billId);
        }
    }

    const updatedBillObj: Bill = {
        id: billId,
        items: newItems,
        total: clampedTotal,
        date: now,
        status: 'completed',
        isUdhar: isHold,
        pendingOfflineSync: isPendingOffline,
        ...(custName ? { customerName: custName } : {}),
        ...(custPhone ? { customerPhone: custPhone } : {}),
        ...(udhaarNote ? { udhaarNote } : {}),
        ...(linkedCostId ? { linkedOtherCostId: linkedCostId } : {}),
        ...(isHold && holdOptions?.linkToOtherCosts
            ? { costCategory: holdOptions.costCategory || 'borrow' }
            : {}),
    };

    if (isPendingOffline) {
        saveOfflinePendingBills(
            pendingQueue.map((b) => (b.id === billId ? { ...b, ...updatedBillObj } : b))
        );
    } else {
        setDoc(
            billRef,
            {
                items: newItems,
                total: clampedTotal,
                status: 'completed',
                isUdhar: isHold,
                date: now,
                ...(holdOptions !== undefined
                    ? {
                          customerName: custName,
                          customerPhone: custPhone,
                          udhaarNote,
                          linkedOtherCostId: linkedCostId || '',
                          costCategory:
                              isHold && holdOptions.linkToOtherCosts
                                  ? holdOptions.costCategory || 'borrow'
                                  : '',
                      }
                    : {}),
            },
            { merge: true }
        ).catch((e) => console.warn('Failed updating bill doc:', e));
    }

    sqliteSaveBill(updatedBillObj).catch(() => {});
    window.dispatchEvent(new CustomEvent('offlineBillQueued', { detail: updatedBillObj }));
    window.dispatchEvent(
        new CustomEvent('offlineStockAdjust', {
            detail: Object.entries(stockDiffs)
                .filter(([, d]) => d.stockDiff !== 0 || d.soldCountDiff !== 0)
                .map(([pid, d]) => ({
                    productId: pid,
                    stockDelta: d.stockDiff,
                    soldDelta: d.soldCountDiff,
                })),
        })
    );

    if (isPendingOffline) return;

    for (const [productId, diffs] of Object.entries(stockDiffs)) {
        if (diffs.stockDiff === 0 && diffs.soldCountDiff === 0) continue;
        if (deletedIds.has(productId)) continue;
        const productRef = doc(db, 'products', productId);
        try {
            const productSnap: any = await Promise.race([
                getDoc(productRef),
                new Promise((_, reject) => setTimeout(() => reject(new Error('getDoc timeout')), 1200)),
            ]);
            if (productSnap && productSnap.exists() && !getDeletedProductIds().has(productId)) {
                const currentData = productSnap.data();
                const currentStock = Number(currentData?.stock ?? 0);
                const currentSold = Number(currentData?.soldCount ?? 0);
                let nextBatches = normalizeCostBatches(currentData?.costBatches, currentStock);
                if (diffs.stockDiff < 0) {
                    const consumed = consumeProductCostBatchesForSale(
                        { ...currentData, stock: currentStock },
                        Math.abs(diffs.stockDiff)
                    );
                    nextBatches = consumed.updatedCostBatches;
                } else if (diffs.stockDiff > 0) {
                    nextBatches = restoreProductCostBatchesFromDeletedSale(
                        currentData,
                        diffs.stockDiff,
                        diffs.oldCostPrice
                    );
                }
                const updatedProduct: Product = {
                    ...currentData,
                    name: currentData?.name || diffs.name,
                    price: Number(currentData?.price ?? diffs.price) || 0,
                    costBatches: nextBatches,
                    stock: Math.max(0, currentStock + diffs.stockDiff),
                    soldCount: Math.max(0, currentSold + diffs.soldCountDiff),
                    createdAt: Number(currentData?.createdAt) || now,
                    updatedAt: now,
                };
                saveLocalCostBatchesEntry(productId, updatedProduct.name, nextBatches);
                setDoc(productRef, updatedProduct).catch(() => {});
                sqliteSaveProduct({ ...updatedProduct, id: productId }).catch(() => {});
            }
        } catch (prodErr) {
            console.warn(`Could not adjust stock for product ${productId} during bill edit:`, prodErr);
        }
    }
};

export function useAdminPin() {
    const [pin, setPin] = useState<string>(() => localStorage.getItem('adminPin') || '8521');
    const [loading, setLoading] = useState(true);
    const { user } = useAuth();
    
    useEffect(() => {
        const handlePinUpdated = (e: Event) => {
            const customEvent = e as CustomEvent<string>;
            if (customEvent.detail) {
                setPin(String(customEvent.detail));
            } else {
                const localPin = localStorage.getItem('adminPin');
                if (localPin) setPin(localPin);
            }
        };
        window.addEventListener('adminPinUpdated', handlePinUpdated);

        if (!user) {
            setLoading(false);
            return () => window.removeEventListener('adminPinUpdated', handlePinUpdated);
        }

        const unsubscribe = onSnapshot(doc(db, 'settings', 'admin_pin'), (docSnap) => {
            if (docSnap.exists() && docSnap.data().pin) {
                const remotePin = String(docSnap.data().pin);
                setPin(remotePin);
                localStorage.setItem('adminPin', remotePin);
            } else {
                const localPin = localStorage.getItem('adminPin');
                setPin(localPin || '8521'); // Default PIN
            }
            setLoading(false);
        }, (error) => {
            const localPin = localStorage.getItem('adminPin');
            setPin(localPin || '8521');
            setLoading(false);
            console.debug("Could not fetch admin PIN from database:", error.message || error);
        });

        return () => {
            unsubscribe();
            window.removeEventListener('adminPinUpdated', handlePinUpdated);
        };
    }, [user]);

    return { adminPin: pin, loading };
}

export const updateAdminPin = async (userId: string, newPin: string) => {
    localStorage.setItem('adminPin', newPin);
    window.dispatchEvent(new CustomEvent('adminPinUpdated', { detail: newPin }));
    await commitOfflineReady(
        setDoc(doc(db, 'settings', 'admin_pin'), { pin: newPin }, { merge: true }),
        'settings/admin_pin',
        OperationType.UPDATE
    );
}

export interface ActivityLog {
    id?: string;
    eventType: 'failed_login' | 'privilege_change' | 'stock_modification' | 'backup' | string;
    description: string;
    timestamp: number;
    userId: string;
    userName: string;
    userEmail: string;
}

export const logActivity = async (
    eventType: 'failed_login' | 'privilege_change' | 'stock_modification' | 'backup' | string,
    description: string,
    userId: string,
    userName: string,
    userEmail: string
) => {
    try {
        const logRef = doc(collection(db, 'activity_logs'));
        setDoc(logRef, {
            eventType,
            description,
            timestamp: Date.now(),
            userId,
            userName,
            userEmail,
        }).catch((e) => {
            console.debug('Failed to log activity:', e);
        });
    } catch (e) {
        console.debug('Failed to log activity:', e);
    }
}
