import React, { useState, useRef } from "react";
import { createPortal } from "react-dom";
import { motion, AnimatePresence, useDragControls } from "motion/react";
import {
  Package,
  Plus,
  Search,
  Image as ImageIcon,
  X,
  Trash2,
  Edit2,
  AlertTriangle,
  Maximize2,
  Minimize2,
} from "lucide-react";
import {
  formatPrice,
  MAX_PRODUCT_STOCK,
  MAX_BILL_AMOUNT,
  useOptimizedTransition,
  useHardwareAcceleration,
  isPerformanceModeEnabled,
} from "../lib/utils";
import {
  addProduct,
  deleteProduct,
  updateProduct,
  Product,
  logActivity,
} from "../lib/firestoreHooks";
import { collection, doc } from "firebase/firestore";
import { db } from "../lib/firebase";
import { Capacitor } from "@capacitor/core";
import { Camera as CapCamera, CameraResultType, CameraSource } from "@capacitor/camera";
import {
  useGlobalProducts,
  getDeletedProductIds,
  getDeletedProductNames,
} from "../lib/ProductsContext";
import { useAuth } from "../lib/AuthContext";
import { triggerHaptic } from "../lib/haptics";
import { resizeImage, base64ToBytes, getImageUrl, preloadProductImages } from "../lib/imageUtils";
import { ProfileMenu } from "../components/ProfileMenu";
import { ProductImagePlaceholder } from "../components/ProductImagePlaceholder";
import { normalizeProductCategory } from "../lib/geminiApi";

const SHEET_BACKDROP_TRANSITION = {
  duration: 0.22,
  ease: [0.22, 1, 0.36, 1] as const,
};

const SHEET_VARIANTS = {
  hidden: {
    y: "100%",
    opacity: 0.6,
    scale: 0.985,
  },
  visible: {
    y: 0,
    opacity: 1,
    scale: 1,
    transition: {
      type: "spring" as const,
      stiffness: 395,
      damping: 32,
      mass: 0.78,
      staggerChildren: 0.04,
      delayChildren: 0.02,
    },
  },
  exit: {
    y: "104%",
    opacity: 0,
    scale: 0.985,
    transition: {
      duration: 0.19,
      ease: [0.32, 0, 0.67, 0] as const,
    },
  },
};

const SHEET_ITEM_VARIANTS = {
  hidden: {
    opacity: 0,
    y: 12,
    scale: 0.98,
  },
  visible: {
    opacity: 1,
    y: 0,
    scale: 1,
    transition: {
      type: "spring" as const,
      stiffness: 430,
      damping: 28,
      mass: 0.7,
    },
  },
  exit: {
    opacity: 0,
    y: 6,
    scale: 0.98,
    transition: {
      duration: 0.11,
      ease: "easeIn" as const,
    },
  },
};

export function Products() {
  const { user } = useAuth();
  const [isAdding, setIsAdding] = useState(false);
  const [showAddOptions, setShowAddOptions] = useState(false);
  const [isAddingStock, setIsAddingStock] = useState(false);
  const [editingProduct, setEditingProduct] = useState<Product | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [stockFilter, setStockFilter] = useState<"all" | "low" | "out">("all");
  const [optionsShake, setOptionsShake] = useState(false);
  const [perfMode, setPerfMode] = useState(() => isPerformanceModeEnabled());
  const segDragRef = useRef<{ startX: number; dragged: boolean }>({ startX: 0, dragged: false });

  React.useEffect(() => {
    const syncPerf = () => setPerfMode(isPerformanceModeEnabled());
    window.addEventListener("performanceModeChanged", syncPerf);
    return () => window.removeEventListener("performanceModeChanged", syncPerf);
  }, []);

  // Close active modal on Escape key or Android hardware back button
  React.useEffect(() => {
    const anyModalOpen =
      Boolean(confirmDeleteId) ||
      isAdding ||
      Boolean(editingProduct) ||
      isAddingStock ||
      showAddOptions;

    if (!anyModalOpen) return;

    const closeTopModal = () => {
      if (confirmDeleteId) {
        setConfirmDeleteId(null);
      } else if (isAdding) {
        setIsAdding(false);
      } else if (editingProduct) {
        setEditingProduct(null);
      } else if (isAddingStock) {
        setIsAddingStock(false);
      } else if (showAddOptions) {
        setShowAddOptions(false);
      }
    };

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        closeTopModal();
      }
    };

    const handleAndroidBack = (e: Event) => {
      e.preventDefault();
      closeTopModal();
    };

    window.addEventListener("keydown", handleKeyDown);
    window.addEventListener("androidBackPress", handleAndroidBack);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("androidBackPress", handleAndroidBack);
    };
  }, [confirmDeleteId, isAdding, editingProduct, isAddingStock, showAddOptions]);

  const {
    products,
    allProducts,
    loading,
    removeProductOptimistic,
    updateProductOptimistic,
  } = useGlobalProducts(search);

  const catalogStats = React.useMemo(() => {
    const source = Array.isArray(allProducts) ? allProducts : products;
    let low = 0;
    let out = 0;
    source.forEach((p) => {
      const s = Number(p.stock) || 0;
      if (s <= 0) out += 1;
      else if (s <= 5) low += 1;
    });
    return {
      total: source.length,
      low,
      out,
    };
  }, [allProducts, products]);

  // Auto-heal any product that was created with an invalid category like "General"
  const healedProductIdsRef = React.useRef<Set<string>>(new Set());
  React.useEffect(() => {
    const deletedIds = getDeletedProductIds();
    const deletedNames = getDeletedProductNames();
    products.forEach((p) => {
      if (
        !p.id ||
        healedProductIdsRef.current.has(p.id) ||
        deletedIds.has(String(p.id)) ||
        deletedNames.has(String(p.name || "").toLowerCase().trim())
      ) {
        return;
      }
      const rawCat = String(p.category || "").toLowerCase().trim();
      if (rawCat !== "fresh" && rawCat !== "frozen" && rawCat !== "cold drinks") {
        healedProductIdsRef.current.add(p.id);
        const healedCat = normalizeProductCategory(p.category, p.name);
        updateProductOptimistic(p.id, { category: healedCat });
        updateProduct(p.id, { category: healedCat }).catch(() => {});
      }
    });
  }, [products, updateProductOptimistic]);

  const filteredProducts = React.useMemo(() => {
    if (stockFilter === "all") return products;
    return products.filter((p) => {
      const s = Number(p.stock) || 0;
      if (stockFilter === "out") return s <= 0;
      if (stockFilter === "low") return s > 0 && s <= 5;
      return true;
    });
  }, [products, stockFilter]);

  const handleDeleteClick = (id?: string) => {
    if (!id) return;
    triggerHaptic("medium");
    setConfirmDeleteId(id);
  };

  const confirmDelete = async () => {
    if (!confirmDeleteId) return;
    const sourceList = Array.isArray(allProducts) ? allProducts : products;
    const targetProduct = sourceList.find((p) => p.id === confirmDeleteId);
    const targetName = targetProduct ? targetProduct.name : "";
    const delId = confirmDeleteId;
    setConfirmDeleteId(null);
    try {
      removeProductOptimistic(delId, targetName || undefined);
      await deleteProduct(delId, targetName || undefined);
      if (user) {
        logActivity(
          "stock_modification",
          `Product deleted: "${targetName || "Unknown Product"}"`,
          user.uid,
          user.displayName || "Admin",
          user.email || ""
        ).catch((err) => console.error(err));
      }
      triggerHaptic("success");
    } catch (err: any) {
      console.error("Failed to delete product:", err);
      triggerHaptic("error");
    }
  };

  const pageTransition = useOptimizedTransition({
    duration: 0.35,
    ease: [0.16, 1, 0.3, 1],
  });
  const gpuClass = useHardwareAcceleration();

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.18 }}
      className="min-h-full flex flex-col pb-2 px-4 pt-10 w-full max-w-lg md:max-w-2xl mx-auto [overflow-anchor:none]"
    >
      <header className="flex items-center justify-between mb-5 pl-1 shrink-0">
        <div>
          <h1 className="text-3xl font-extrabold tracking-tight text-slate-900 dark:text-slate-100">
            Inventory <span className="text-indigo-600 dark:text-indigo-400">Stock</span>
          </h1>
          <p className="text-xs sm:text-sm text-slate-500 dark:text-slate-400 font-medium mt-1 flex items-center gap-1.5 flex-wrap">
            <span className="font-mono tabular-nums font-semibold text-slate-600 dark:text-slate-300">
              {catalogStats.total}
            </span>{" "}
            in catalog
            <span className="text-slate-300 dark:text-slate-600" aria-hidden="true">
              ·
            </span>
            <span
              className={
                catalogStats.low > 0
                  ? "text-amber-600 dark:text-amber-400 font-semibold"
                  : ""
              }
            >
              <span className="font-mono tabular-nums font-bold">{catalogStats.low}</span> low
            </span>
            <span className="text-slate-300 dark:text-slate-600" aria-hidden="true">
              ·
            </span>
            <span
              className={
                catalogStats.out > 0
                  ? "text-red-600 dark:text-red-400 font-semibold"
                  : ""
              }
            >
              <span className="font-mono tabular-nums font-bold">{catalogStats.out}</span> out of stock
            </span>
          </p>
        </div>
        <div className="flex items-center gap-2.5">
          <motion.button
            type="button"
            aria-label="Add product or stock"
            whileHover={{ scale: 1.06 }}
            whileTap={{ scale: 0.9 }}
            transition={{ type: "spring", stiffness: 450, damping: 24 }}
            onClick={() => {
              triggerHaptic("heavy");
              setShowAddOptions(true);
            }}
            className="bg-indigo-600 hover:bg-indigo-700 text-white rounded-full shadow-md shadow-indigo-600/25 w-10 h-10 flex items-center justify-center transition-colors duration-150 cursor-pointer transform-gpu"
          >
            <motion.span
              animate={{ rotate: showAddOptions ? 45 : 0 }}
              transition={{ type: "spring", stiffness: 420, damping: 24 }}
              className="flex items-center justify-center"
            >
              <Plus size={20} strokeWidth={2.5} />
            </motion.span>
          </motion.button>
          <ProfileMenu />
        </div>
      </header>

      <div className="relative mb-4 shrink-0">
        <input
          type="text"
          placeholder="Search products..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className={`glass-input w-full !pl-10 ${
            search ? "!pr-10" : "!pr-4"
          } text-xs sm:text-sm font-medium`}
        />
        <Search
          className="absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-400 z-10 pointer-events-none"
          size={16}
        />
        {search && (
          <button
            type="button"
            onClick={() => {
              triggerHaptic("soft");
              setSearch("");
            }}
            aria-label="Clear search"
            className="absolute right-2.5 top-1/2 -translate-y-1/2 w-8 h-8 rounded-full flex items-center justify-center text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors"
          >
            <X size={15} />
          </button>
        )}
      </div>

      {/* Material 3 Segmented Stock Health Filter Tabs — Pure GPU Compositor translate3d */}
      <div
        onPointerDown={(e) => {
          segDragRef.current = { startX: e.clientX, dragged: false };
        }}
        onTouchStart={(e) => {
          const touch = e.touches[0];
          if (!touch) return;
          segDragRef.current = { startX: touch.clientX, dragged: false };
        }}
        onTouchMove={(e) => {
          const touch = e.touches[0];
          if (!touch) return;
          if (Math.abs(touch.clientX - segDragRef.current.startX) <= 6) return;
          segDragRef.current.dragged = true;
          const rect = e.currentTarget.getBoundingClientRect();
          const innerWidth = Math.max(1, rect.width - 8);
          const tabs = ["all", "low", "out"] as const;
          const relX = Math.max(0, Math.min(innerWidth - 1, touch.clientX - (rect.left + 4)));
          const idx = Math.min(tabs.length - 1, Math.max(0, Math.floor((relX / innerWidth) * tabs.length)));
          const next = tabs[idx];
          if (next && next !== stockFilter) {
            triggerHaptic("selection");
            setStockFilter(next);
          }
        }}
        onPointerMove={(e) => {
          if (e.buttons !== 1) return;
          if (Math.abs(e.clientX - segDragRef.current.startX) <= 6) return;
          segDragRef.current.dragged = true;
          const rect = e.currentTarget.getBoundingClientRect();
          const innerWidth = Math.max(1, rect.width - 8);
          const tabs = ["all", "low", "out"] as const;
          const relX = Math.max(0, Math.min(innerWidth - 1, e.clientX - (rect.left + 4)));
          const idx = Math.min(tabs.length - 1, Math.max(0, Math.floor((relX / innerWidth) * tabs.length)));
          const next = tabs[idx];
          if (next && next !== stockFilter) {
            triggerHaptic("selection");
            setStockFilter(next);
          }
        }}
        className="relative grid grid-cols-3 p-1 mb-5 bg-[#ece6f0] dark:bg-[#161922] border border-slate-200/80 dark:border-white/[0.07] rounded-full select-none touch-pan-y shrink-0 isolate"
      >
        <div
          aria-hidden="true"
          style={{
            width: "calc((100% - 8px) / 3)",
            transform: `translate3d(${
              stockFilter === "all" ? 0 : stockFilter === "low" ? 100 : 200
            }%, 0, 0)`,
            transition: "transform 260ms cubic-bezier(0.22, 1, 0.36, 1)",
          }}
          className="absolute top-1 bottom-1 left-1 bg-[#e0e7ff] dark:bg-indigo-500/25 border border-indigo-200/70 dark:border-indigo-400/30 rounded-full shadow-2xs dark:shadow-none pointer-events-none transform-gpu will-change-transform"
        />
        {(
          [
            { id: "all", label: "All Items" },
            { id: "low", label: "Low Stock" },
            { id: "out", label: "Out of Stock" },
          ] as const
        ).map((tab) => {
          const active = stockFilter === tab.id;
          return (
            <button
              key={tab.id}
              type="button"
              onClick={() => {
                if (segDragRef.current.dragged) {
                  segDragRef.current.dragged = false;
                  return;
                }
                if (stockFilter === tab.id) return;
                triggerHaptic("selection");
                setStockFilter(tab.id);
              }}
              className={`relative z-10 min-w-0 min-h-[36px] px-2 sm:px-3 py-1.5 rounded-full text-xs font-bold outline-none transition-colors duration-150 flex items-center justify-center whitespace-nowrap cursor-pointer ${
                active
                  ? "text-indigo-950 dark:text-indigo-100"
                  : "text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200"
              }`}
            >
              <span className="relative z-10 truncate">{tab.label}</span>
            </button>
          );
        })}
      </div>

      {/* Stable height & scroll-anchor-isolated inventory list container */}
      <div className="flex-1 flex flex-col min-h-[320px] [overflow-anchor:none]">
        {loading ? null : filteredProducts.length === 0 ? (
          <div
            key="stock-empty-state"
            className="bg-white dark:bg-[#1b1f2b] border border-slate-200/75 dark:border-white/[0.07] rounded-[28px] text-center py-14 px-6 text-slate-500 flex-1 flex flex-col items-center justify-center gap-2 shadow-[0_1px_3px_rgba(15,23,42,0.04)] dark:shadow-none"
          >
            <Package
              size={44}
              className="text-slate-300 dark:text-slate-600 mb-1"
            />
            <p className="font-bold text-slate-800 dark:text-slate-200 text-base">
              {stockFilter === "low"
                ? "No low stock products"
                : stockFilter === "out"
                ? "No out-of-stock products"
                : "No matching products"}
            </p>
            <p className="text-xs text-slate-500 dark:text-slate-400 max-w-xs">
              {stockFilter === "low"
                ? "All stocked items currently have more than 5 units available."
                : stockFilter === "out"
                ? "Every product in your catalog currently has stock available."
                : search
                ? "No products match your search query."
                : "Tap the + button above to add your first product."}
            </p>
            {(stockFilter !== "all" || search) && (
              <button
                type="button"
                onClick={() => {
                  triggerHaptic("light");
                  setStockFilter("all");
                  setSearch("");
                }}
                className="mt-2 px-4 py-2 rounded-full bg-indigo-50 dark:bg-indigo-500/15 text-indigo-600 dark:text-indigo-300 text-xs font-bold hover:bg-indigo-100 dark:hover:bg-indigo-500/25 transition-colors cursor-pointer"
              >
                Show All Items
              </button>
            )}
          </div>
        ) : (
          <div key="stock-list-state" className="space-y-3 [overflow-anchor:none]">
            {filteredProducts.map((product, idx) => {
              const pStock = Number(product.stock) || 0;
              const isLowStock = pStock > 0 && pStock <= 5;
              const isOutOfStock = pStock === 0;

              return (
                <div
                  key={product.id ? `prod_${product.id}` : `prod_idx_${idx}`}
                  className={`bg-white dark:bg-[#1b1f2b] hover:bg-[#f8f5fc] dark:hover:bg-[#222736] transition-colors duration-150 border rounded-[28px] shadow-[0_1px_3px_rgba(15,23,42,0.04)] dark:shadow-none p-3.5 sm:p-4 flex items-center gap-3.5 overflow-hidden relative group text-slate-800 ${
                    isOutOfStock
                      ? "border-red-500/40 dark:border-red-500/35"
                      : isLowStock
                      ? "border-amber-500/40 dark:border-amber-500/35"
                      : "border-slate-200/75 dark:border-white/[0.07]"
                  }`}
                >
                  <div className="w-18 h-18 sm:w-20 sm:h-20 shrink-0 rounded-2xl overflow-hidden bg-slate-100 dark:bg-slate-800 border border-slate-200/60 dark:border-slate-700/60">
                    {(() => {
                      const imgUrl = getImageUrl(product.image);
                      return imgUrl ? (
                        <img
                          src={imgUrl}
                          alt={product.name}
                          loading="eager"
                          decoding="sync"
                          draggable={false}
                          referrerPolicy="no-referrer"
                          className="w-full h-full object-cover"
                        />
                      ) : (
                        <ProductImagePlaceholder
                          name={product.name}
                          category={product.category}
                          rounded="rounded-2xl"
                          size={38}
                          className="w-full h-full"
                          showBorder={false}
                          showShadow={false}
                          monogramSize="bottom-0.5 right-2 text-[40px] font-black"
                        />
                      );
                    })()}
                  </div>

                  <div className="flex-1 min-w-0 flex flex-col justify-center gap-1">
                    <h3 className="font-bold text-base sm:text-lg text-slate-900 dark:text-slate-100 truncate leading-snug">
                      {product.name}
                    </h3>

                    {/* Clean unboxed metadata row */}
                    <div className="flex items-center gap-2 text-xs font-medium flex-wrap">
                      <span
                        className={`font-mono tabular-nums font-bold ${
                          isOutOfStock
                            ? "text-red-600 dark:text-red-400"
                            : isLowStock
                            ? "text-amber-600 dark:text-amber-400"
                            : "text-slate-500 dark:text-slate-400"
                        }`}
                      >
                        {isOutOfStock
                          ? "Out of stock"
                          : isLowStock
                          ? `Low stock (${pStock})`
                          : `${pStock} in stock`}
                      </span>
                      <span className="text-slate-500 dark:text-slate-400 capitalize">
                        {normalizeProductCategory(product.category, product.name)}
                      </span>
                    </div>

                    <span className="font-extrabold text-indigo-600 dark:text-indigo-400 font-mono tabular-nums text-base sm:text-lg mt-0.5">
                      ₹{formatPrice(product.price)}
                    </span>
                  </div>

                  {/* Ergonomic 40x40px Action Buttons */}
                  <div className="flex items-center gap-2 pl-2 border-l border-slate-200/70 dark:border-slate-800 shrink-0">
                    <motion.button
                      type="button"
                      aria-label={`Edit ${product.name}`}
                      whileHover={{ scale: 1.06, y: -1 }}
                      whileTap={{ scale: 0.9 }}
                      transition={{ type: "spring", stiffness: 450, damping: 24 }}
                      onClick={() => {
                        triggerHaptic("selection");
                        setEditingProduct(product);
                      }}
                      className="w-10 h-10 flex items-center justify-center bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-200 hover:bg-indigo-50 hover:text-indigo-600 dark:hover:bg-indigo-500/20 dark:hover:text-indigo-300 border border-slate-200/80 dark:border-slate-700 rounded-xl transition-colors duration-150 cursor-pointer transform-gpu"
                    >
                      <Edit2 size={16} />
                    </motion.button>
                    <motion.button
                      type="button"
                      aria-label={`Delete ${product.name}`}
                      whileHover={{ scale: 1.06, y: -1 }}
                      whileTap={{ scale: 0.9 }}
                      transition={{ type: "spring", stiffness: 450, damping: 24 }}
                      onClick={() => handleDeleteClick(product.id)}
                      className="w-10 h-10 flex items-center justify-center bg-red-50/80 dark:bg-red-500/10 text-red-600 dark:text-red-400 hover:bg-red-100 dark:hover:bg-red-500/20 border border-red-200/80 dark:border-red-500/25 rounded-xl transition-colors duration-150 cursor-pointer transform-gpu"
                    >
                      <Trash2 size={16} />
                    </motion.button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Delete Confirmation & Modals */}
      {createPortal(
        <>
          <AnimatePresence>
            {confirmDeleteId && (
              <div
                key="delete-modal"
                className="fixed inset-0 z-[100] flex items-center justify-center p-4"
              >
                <motion.div
                  initial={perfMode ? false : { opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={perfMode ? undefined : { opacity: 0 }}
                  transition={perfMode ? { duration: 0 } : SHEET_BACKDROP_TRANSITION}
                  onClick={() => setConfirmDeleteId(null)}
                  className="absolute inset-0 bg-slate-900/45 dark:bg-slate-950/70 backdrop-blur-md transform-gpu"
                />
                <motion.div
                  initial={perfMode ? false : { scale: 0.9, opacity: 0, y: 12, filter: "blur(6px)" }}
                  animate={{ scale: 1, opacity: 1, y: 0, filter: "blur(0px)" }}
                  exit={perfMode ? undefined : { scale: 0.93, opacity: 0, y: 8, filter: "blur(4px)" }}
                  transition={
                    perfMode
                      ? { duration: 0 }
                      : {
                          type: "spring",
                          stiffness: 420,
                          damping: 29,
                          mass: 0.75,
                        }
                  }
                  className="bg-white dark:bg-[#1b1f2b] w-full max-w-sm p-6 relative z-10 rounded-[2rem] text-center shadow-2xl border border-slate-200/80 dark:border-white/[0.08] transform-gpu will-change-transform"
                >
                  <motion.div
                    initial={perfMode ? false : { scale: 0.7, opacity: 0, rotate: -10 }}
                    animate={{ scale: 1, opacity: 1, rotate: 0 }}
                    transition={
                      perfMode
                        ? { duration: 0 }
                        : {
                            type: "spring",
                            stiffness: 440,
                            damping: 22,
                            delay: 0.04,
                          }
                    }
                    className="mx-auto w-16 h-16 bg-red-100 dark:bg-red-500/20 text-red-600 dark:text-red-400 rounded-full flex items-center justify-center mb-4"
                  >
                    <AlertTriangle size={32} />
                  </motion.div>
                  <h2 className="text-xl font-bold text-slate-900 dark:text-slate-100 mb-2">
                    Delete Product
                  </h2>
                  <p className="text-slate-500 dark:text-slate-400 mb-6">
                    Are you sure you want to delete this product? This action
                    cannot be undone.
                  </p>
                  <div className="flex gap-3">
                    <motion.button
                      type="button"
                      whileHover={perfMode ? undefined : { scale: 1.02 }}
                      whileTap={perfMode ? undefined : { scale: 0.96 }}
                      onClick={() => setConfirmDeleteId(null)}
                      className="flex-1 py-3 rounded-xl font-bold text-slate-700 dark:text-slate-200 bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 transition-colors duration-150 cursor-pointer"
                    >
                      Cancel
                    </motion.button>
                    <motion.button
                      type="button"
                      whileHover={perfMode ? undefined : { scale: 1.02 }}
                      whileTap={perfMode ? undefined : { scale: 0.96 }}
                      onClick={confirmDelete}
                      className="flex-1 py-3 rounded-xl font-bold text-white bg-red-600 hover:bg-red-700 transition-colors duration-150 shadow-lg shadow-red-600/30 cursor-pointer"
                    >
                      Delete
                    </motion.button>
                  </div>
                </motion.div>
              </div>
            )}
          </AnimatePresence>

          <AnimatePresence>
            {showAddOptions && (
              <div
                key="add-options-sheet"
                className="fixed inset-0 z-[100] flex items-end justify-center p-0"
              >
                <motion.div
                  initial={perfMode ? false : { opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={perfMode ? undefined : { opacity: 0 }}
                  transition={perfMode ? { duration: 0 } : SHEET_BACKDROP_TRANSITION}
                  onClick={() => setShowAddOptions(false)}
                  className="absolute inset-0 bg-slate-900/45 dark:bg-slate-950/70 backdrop-blur-md transform-gpu"
                />
                <motion.div
                  drag="y"
                  dragConstraints={{ top: 0, bottom: 0 }}
                  dragElastic={{ top: 0.08, bottom: 0.45 }}
                  onDrag={(e, info) => {
                    if (info.offset.y < -35 && !optionsShake) {
                      setOptionsShake(true);
                      triggerHaptic("medium");
                      setTimeout(() => setOptionsShake(false), 800);
                    }
                  }}
                  onDragEnd={(e, info) => {
                    if (info.offset.y > 80 || (info.offset.y > 40 && info.velocity.y > 380)) {
                      setShowAddOptions(false);
                    }
                  }}
                  variants={perfMode ? undefined : SHEET_VARIANTS}
                  initial={perfMode ? false : "hidden"}
                  animate={perfMode ? undefined : "visible"}
                  exit={perfMode ? undefined : "exit"}
                  className="bg-[#fcf8ff] dark:bg-[#161923] border border-slate-200/80 dark:border-white/[0.08] w-full max-w-lg p-6 pb-[calc(env(safe-area-inset-bottom)+2rem)] relative z-10 flex flex-col rounded-t-[2.5rem] rounded-b-none border-b-0 overflow-visible space-y-3 shadow-2xl transform-gpu will-change-transform"
                >
                  <div
                    aria-hidden="true"
                    className="pointer-events-none absolute top-[calc(100%-2px)] inset-x-[-1px] h-[100dvh] bg-[#fcf8ff] dark:bg-[#161923] border-x border-slate-200/80 dark:border-white/[0.08]"
                  />
                  <motion.div
                    variants={perfMode ? undefined : SHEET_ITEM_VARIANTS}
                    className="flex flex-col items-center"
                  >
                    <motion.div
                      animate={
                        optionsShake
                          ? { x: [-6, 6, -6, 6, -3, 3, 0], y: [-2, 2, -2, 2, 0] }
                          : {}
                      }
                      transition={{ duration: 0.4 }}
                      className="w-12 h-1.5 bg-slate-200 dark:bg-slate-700 rounded-full mx-auto mb-4"
                    />
                    <h2 className="text-xl font-bold text-slate-900 dark:text-slate-100 mb-3 text-center">
                      Update Inventory
                    </h2>
                  </motion.div>

                  <motion.button
                    type="button"
                    variants={perfMode ? undefined : SHEET_ITEM_VARIANTS}
                    whileHover={perfMode ? undefined : { scale: 1.012, y: -1 }}
                    whileTap={perfMode ? undefined : { scale: 0.975 }}
                    onClick={() => {
                      triggerHaptic("medium");
                      setShowAddOptions(false);
                      setIsAdding(true);
                    }}
                    className="w-full bg-indigo-600 hover:bg-indigo-700 text-white p-4 rounded-2xl font-bold flex items-center justify-center gap-3 shadow-lg shadow-indigo-600/20 transition-colors duration-150 cursor-pointer transform-gpu"
                  >
                    <Plus size={20} /> Create New Product
                  </motion.button>

                  <motion.button
                    type="button"
                    variants={perfMode ? undefined : SHEET_ITEM_VARIANTS}
                    whileHover={perfMode ? undefined : { scale: 1.012, y: -1 }}
                    whileTap={perfMode ? undefined : { scale: 0.975 }}
                    onClick={() => {
                      triggerHaptic("medium");
                      setShowAddOptions(false);
                      setIsAddingStock(true);
                    }}
                    className="w-full bg-white dark:bg-[#1b1f2b] hover:bg-[#f8f5fc] dark:hover:bg-[#222736] p-4 rounded-2xl font-bold flex items-center justify-center gap-3 text-slate-700 dark:text-slate-200 transition-colors duration-150 border border-slate-200/80 dark:border-white/[0.08] hover:border-indigo-500/30 cursor-pointer transform-gpu"
                  >
                    <Package size={20} /> Add Stock to Existing
                  </motion.button>
                </motion.div>
              </div>
            )}
          </AnimatePresence>

          <AnimatePresence>
            {isAdding && (
              <AddProductModal
                key="add-product-modal"
                onClose={() => setIsAdding(false)}
                products={products}
              />
            )}
          </AnimatePresence>

          <AnimatePresence>
            {editingProduct && (
              <AddProductModal
                key={`edit-product-modal-${editingProduct.id || "item"}`}
                editingProduct={editingProduct}
                onClose={() => setEditingProduct(null)}
                products={products}
              />
            )}
          </AnimatePresence>

          <AnimatePresence>
            {isAddingStock && (
              <AddStockModal
                key="add-stock-modal"
                onClose={() => setIsAddingStock(false)}
                products={products}
              />
            )}
          </AnimatePresence>
        </>,
        document.body
      )}
    </motion.div>
  );
}

function AddProductModal({
  onClose,
  editingProduct = null,
  products = [],
}: {
  onClose: () => void;
  editingProduct?: Product | null;
  products: Product[];
}) {
  const { user } = useAuth();
  const { addProductOptimistic, updateProductOptimistic } = useGlobalProducts("");
  const [name, setName] = useState(editingProduct?.name || "");
  const [price, setPrice] = useState(editingProduct?.price.toString() || "");
  const [stock, setStock] = useState(editingProduct?.stock.toString() || "");
  const [category, setCategory] = useState<string>(
    editingProduct
      ? normalizeProductCategory(editingProduct.category, editingProduct.name)
      : "fresh"
  );
  const [image, setImage] = useState<string | undefined>(
    editingProduct ? getImageUrl(editingProduct.image) : undefined
  );
  const [isImageChanged, setIsImageChanged] = useState(false);
  const [isProcessingImage, setIsProcessingImage] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [productShake, setProductShake] = useState(false);
  const [formError, setFormError] = useState("");
  const perfMode = isPerformanceModeEnabled();
  const productDragControls = useDragControls();

  const fileInputRef = React.useRef<HTMLInputElement>(null);

  const processFileToBase64 = async (file: File) => {
    if (!file.type.startsWith("image/")) {
      setFormError("Please select an image file");
      return;
    }
    if (file.size > 20 * 1024 * 1024) {
      setFormError("Image must be less than 20MB");
      return;
    }
    setIsProcessingImage(true);
    try {
      const resized = await Promise.race([
        resizeImage(file),
        new Promise<string>((_, reject) =>
          setTimeout(() => reject(new Error("Image processing timed out")), 6000)
        ),
      ]);
      setImage(resized);
      setIsImageChanged(true);
      setFormError("");
    } catch (err) {
      console.error("Image processing failed", err);
      setFormError("Failed to process image");
    } finally {
      setIsProcessingImage(false);
    }
  };

  const handleImage = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (file) {
      await processFileToBase64(file);
    }
  };

  const handlePickProductPhoto = async (e: React.MouseEvent) => {
    if (isProcessingImage) return;
    if (Capacitor.isNativePlatform()) {
      e.preventDefault();
      try {
        const photo = await CapCamera.getPhoto({
          quality: 85,
          allowEditing: false,
          resultType: CameraResultType.DataUrl,
          source: CameraSource.Photos,
        });
        if (photo.dataUrl) {
          setIsProcessingImage(true);
          const res = await fetch(photo.dataUrl);
          const blob = await res.blob();
          const file = new File([blob], "product.jpg", { type: "image/jpeg" });
          await processFileToBase64(file);
        }
      } catch (err: any) {
        const msg = String(err?.message || err || "");
        if (!msg.toLowerCase().includes("cancel")) {
          fileInputRef.current?.click();
        }
      } finally {
        setIsProcessingImage(false);
      }
    }
  };

  const handleSave = async () => {
    if (!name.trim()) {
      triggerHaptic("error");
      setProductShake(true);
      setTimeout(() => setProductShake(false), 500);
      setFormError("Please enter a product name.");
      return;
    }

    const parsedPrice = parseFloat(price);
    if (isNaN(parsedPrice) || parsedPrice <= 0) {
      triggerHaptic("error");
      setProductShake(true);
      setTimeout(() => setProductShake(false), 500);
      setFormError("Price must be greater than zero.");
      return;
    }
    if (parsedPrice > MAX_BILL_AMOUNT) {
      triggerHaptic("error");
      setProductShake(true);
      setTimeout(() => setProductShake(false), 500);
      setFormError(`Price cannot exceed ₹${MAX_BILL_AMOUNT.toLocaleString("en-IN")} (maximum bill limit).`);
      return;
    }

    const parsedStock = parseInt(stock, 10);
    if (isNaN(parsedStock) || parsedStock < 0) {
      triggerHaptic("error");
      setProductShake(true);
      setTimeout(() => setProductShake(false), 500);
      setFormError("Stock cannot be negative.");
      return;
    }
    if (parsedStock > MAX_PRODUCT_STOCK) {
      triggerHaptic("error");
      setProductShake(true);
      setTimeout(() => setProductShake(false), 500);
      setFormError(`Cannot stock more than ${MAX_PRODUCT_STOCK.toLocaleString("en-IN")} units per product.`);
      return;
    }

    if (!user) {
      triggerHaptic("error");
      setProductShake(true);
      setTimeout(() => setProductShake(false), 500);
      setFormError("Authenticating session... Please try again.");
      return;
    }

    if (isSubmitting) return;

    // Check for duplicate names if we are not editing or the name changed
    if (
      !editingProduct ||
      editingProduct.name.toLowerCase().trim() !== name.toLowerCase().trim()
    ) {
      const isDuplicate = products.some(
        (p) => (p.name || "").toLowerCase().trim() === name.toLowerCase().trim()
      );
      if (isDuplicate) {
        triggerHaptic("error");
        setProductShake(true);
        setTimeout(() => setProductShake(false), 500);
        setFormError(
          'A product with this name already exists. Please use "Add Stock" instead.'
        );
        return;
      }
    }

    setIsSubmitting(true);
    triggerHaptic("medium");
    setFormError("");

    const productPayload: Omit<Product, "id"> = {
      name: name.trim(),
      price: parsedPrice,
      stock: parsedStock,
      category: category || "fresh",
      createdAt: editingProduct ? (Number(editingProduct.createdAt) || Date.now()) : Date.now(),
      soldCount: editingProduct ? (Number(editingProduct.soldCount) || 0) : 0,
      ...(editingProduct && editingProduct.costPrice !== undefined
        ? { costPrice: editingProduct.costPrice }
        : {}),
      ...(editingProduct && Array.isArray(editingProduct.costBatches)
        ? { costBatches: editingProduct.costBatches }
        : {}),
      image: isImageChanged
        ? (image || "")
        : (editingProduct ? (editingProduct.image || "") : (image || "")),
    };

    try {
      if (editingProduct && editingProduct.id) {
        updateProductOptimistic(editingProduct.id, productPayload);
        updateProduct(editingProduct.id, productPayload).catch((err) =>
          console.error("Background product update error:", err)
        );
        if (user) {
          logActivity(
            "stock_modification",
            `Product updated: "${name.trim()}" (Price: ₹${parsedPrice}, Stock: ${parsedStock})`,
            user.uid,
            user.displayName || "Admin",
            user.email || ""
          ).catch((err) => console.error(err));
        }
      } else {
        const newId = doc(collection(db, "products")).id;
        addProductOptimistic({
          id: newId,
          ...productPayload,
        });
        addProduct(productPayload, newId).catch((err) =>
          console.error("Background product add error:", err)
        );
        if (user) {
          logActivity(
            "stock_modification",
            `New product added: "${name.trim()}" with stock of ${parsedStock} (Price: ₹${parsedPrice})`,
            user.uid,
            user.displayName || "Admin",
            user.email || ""
          ).catch((err) => console.error(err));
        }
      }
      triggerHaptic("success");
      onClose();
    } catch (e: any) {
      console.error("Failed to save product:", e);
      let errMsg = "Failed to save product. Please try again.";
      if (e?.message) {
        try {
          const parsed = JSON.parse(e.message);
          errMsg = parsed.error || e.message;
        } catch (_) {
          errMsg = e.message;
        }
      }
      setFormError(errMsg);
      triggerHaptic("error");
      setIsSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[70] flex items-end justify-center p-0">
      <motion.div
        initial={perfMode ? false : { opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={perfMode ? undefined : { opacity: 0 }}
        transition={perfMode ? { duration: 0 } : SHEET_BACKDROP_TRANSITION}
        onClick={onClose}
        className="absolute inset-0 bg-slate-900/45 dark:bg-slate-950/70 backdrop-blur-md transform-gpu"
      />
      <motion.div
        drag="y"
        dragControls={productDragControls}
        dragListener={false}
        dragConstraints={{ top: 0, bottom: 0 }}
        dragElastic={{ top: 0.08, bottom: 0.45 }}
        onDrag={(e, info) => {
          if (info.offset.y < -35 && !productShake) {
            setProductShake(true);
            triggerHaptic("medium");
            setTimeout(() => setProductShake(false), 800);
          }
        }}
        onDragEnd={(e, info) => {
          if (info.offset.y > 85 || (info.offset.y > 40 && info.velocity.y > 400)) {
            onClose();
          }
        }}
        variants={perfMode ? undefined : SHEET_VARIANTS}
        initial={perfMode ? false : "hidden"}
        animate={perfMode ? undefined : "visible"}
        exit={perfMode ? undefined : "exit"}
        className="bg-[#fcf8ff] dark:bg-[#161923] border border-slate-200/80 dark:border-white/[0.08] shadow-2xl w-full max-w-lg p-5 pb-8 sm:pb-6 relative z-10 max-h-[90dvh] flex flex-col rounded-t-[2.5rem] rounded-b-none border-b-0 overflow-visible transform-gpu will-change-transform"
      >
        <div
          aria-hidden="true"
          className="pointer-events-none absolute top-[calc(100%-2px)] inset-x-[-1px] h-[100dvh] bg-[#fcf8ff] dark:bg-[#161923] border-x border-slate-200/80 dark:border-white/[0.08]"
        />
        <motion.div
          variants={perfMode ? undefined : SHEET_ITEM_VARIANTS}
          onPointerDown={(e) => productDragControls.start(e)}
          className="pt-1 pb-2 -mt-1 cursor-row-resize touch-none select-none shrink-0"
        >
          <motion.div
            animate={
              productShake
                ? { x: [-6, 6, -6, 6, -3, 3, 0], y: [-2, 2, -2, 2, 0] }
                : {}
            }
            transition={{ duration: 0.4 }}
            className="w-12 h-1.5 bg-slate-200 dark:bg-slate-700 rounded-full mx-auto mb-2 shrink-0 sm:hidden"
          />
          <div className="flex justify-between items-center shrink-0">
            <h2 className="text-xl font-bold text-slate-900 dark:text-slate-100">
              {editingProduct ? "Edit Product" : "Add Product"}
            </h2>
            <motion.button
              type="button"
              whileHover={perfMode ? undefined : { scale: 1.06, rotate: 90 }}
              whileTap={perfMode ? undefined : { scale: 0.9 }}
              transition={perfMode ? { duration: 0 } : { type: "spring", stiffness: 420, damping: 24 }}
              onPointerDown={(e) => e.stopPropagation()}
              onClick={onClose}
              className="p-2 bg-slate-100/50 dark:bg-slate-800/50 hover:bg-slate-200 dark:hover:bg-slate-700 rounded-full text-slate-500 dark:text-slate-400 transition-colors shrink-0 cursor-pointer"
            >
              <X size={20} />
            </motion.button>
          </div>
        </motion.div>

        <AnimatePresence initial={false}>
          {formError && (
            <motion.div
              key="product-form-error"
              initial={perfMode ? false : { opacity: 0, y: -8, scale: 0.97 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={perfMode ? undefined : { opacity: 0, y: -6, scale: 0.97 }}
              transition={perfMode ? { duration: 0 } : { type: "spring", stiffness: 420, damping: 28 }}
              className="p-3 mb-3 bg-red-50 dark:bg-red-500/10 border border-red-200 dark:border-red-900/30 text-red-600 dark:text-red-400 rounded-xl text-xs font-semibold flex items-center justify-between shrink-0"
            >
              <span className="flex items-center gap-2">
                <AlertTriangle size={14} className="shrink-0" />
                {formError}
              </span>
              <button onClick={() => setFormError("")} className="text-red-500 hover:text-red-700">
                <X size={14} />
              </button>
            </motion.div>
          )}
        </AnimatePresence>

        <div className="space-y-2 text-slate-800 dark:text-slate-200 flex-1 px-1 flex flex-col justify-between">
          <div>
            <motion.div
              variants={perfMode ? undefined : SHEET_ITEM_VARIANTS}
              className="flex justify-center mb-3 relative"
            >
              <motion.label
                whileHover={perfMode ? undefined : { scale: 1.03, y: -1 }}
                whileTap={perfMode ? undefined : { scale: 0.96 }}
                transition={perfMode ? { duration: 0 } : { type: "spring", stiffness: 420, damping: 25 }}
                onClick={handlePickProductPhoto}
                className={`w-24 h-24 rounded-[1.25rem] border-2 border-dashed ${
                  image
                    ? "border-transparent shadow-md"
                    : "border-indigo-200 dark:border-indigo-500/30"
                } bg-indigo-50/50 dark:bg-indigo-500/10 flex flex-col items-center justify-center text-slate-400 cursor-pointer overflow-hidden relative hover:bg-indigo-50 dark:hover:bg-indigo-500/20 transition-colors transform-gpu`}
              >
                {image ? (
                  <img
                    src={image}
                    alt="Preview"
                    className="w-full h-full object-cover"
                  />
                ) : (
                  <>
                    {isProcessingImage ? (
                      <span className="animate-spin border-2 border-slate-300 border-t-indigo-600 w-5 h-5 rounded-full"></span>
                    ) : (
                      <>
                        <ImageIcon size={24} className="mb-1 text-indigo-400" />
                        <span className="text-[9px] font-bold uppercase tracking-widest text-indigo-600">
                          Add Photo
                        </span>
                      </>
                    )}
                  </>
                )}
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="image/*"
                  className="hidden"
                  onChange={handleImage}
                  disabled={isProcessingImage}
                />
              </motion.label>
              <AnimatePresence>
                {image && (
                  <motion.button
                    key="remove-product-photo"
                    type="button"
                    initial={perfMode ? false : { scale: 0, opacity: 0 }}
                    animate={{ scale: 1, opacity: 1 }}
                    exit={perfMode ? undefined : { scale: 0, opacity: 0 }}
                    whileHover={perfMode ? undefined : { scale: 1.12 }}
                    whileTap={perfMode ? undefined : { scale: 0.9 }}
                    onClick={() => {
                      setImage(undefined);
                      setIsImageChanged(true);
                    }}
                    className="absolute bg-white dark:bg-slate-800 text-red-500 border border-red-100 dark:border-red-500/30 rounded-full p-1 translate-x-10 -translate-y-2 shadow-md hover:bg-red-50 transition-colors cursor-pointer"
                  >
                    <X size={12} />
                  </motion.button>
                )}
              </AnimatePresence>
            </motion.div>

            <motion.div variants={perfMode ? undefined : SHEET_ITEM_VARIANTS} className="mb-2">
              <label className="block text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-1 pl-1">
                Product Name
              </label>
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                className="glass-input w-full py-2"
                placeholder="e.g. Premium Wheat"
              />
            </motion.div>

            <motion.div
              variants={perfMode ? undefined : SHEET_ITEM_VARIANTS}
              className="grid grid-cols-2 gap-3 mb-3"
            >
              <div>
                <label className="block text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-1 pl-1">
                  Price (₹)
                </label>
                <input
                  type="number"
                  min="1"
                  max={MAX_BILL_AMOUNT}
                  step="1"
                  value={price}
                  onChange={(e) => {
                    const raw = e.target.value;
                    if (raw === "") {
                      setPrice("");
                      return;
                    }
                    const num = parseFloat(raw);
                    if (!isNaN(num) && num > MAX_BILL_AMOUNT) {
                      triggerHaptic("warning");
                      setPrice(String(MAX_BILL_AMOUNT));
                      setFormError(`Maximum product price is ₹${MAX_BILL_AMOUNT.toLocaleString("en-IN")}.`);
                    } else {
                      setPrice(raw);
                    }
                  }}
                  className="glass-input w-full font-mono text-base py-2"
                  placeholder="0"
                />
              </div>
              <div>
                <label className="block text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-1 pl-1">
                  Stock (Max 2,000)
                </label>
                <input
                  type="number"
                  min="0"
                  max={MAX_PRODUCT_STOCK}
                  value={stock}
                  onChange={(e) => {
                    const raw = e.target.value;
                    if (raw === "") {
                      setStock("");
                      return;
                    }
                    const num = parseInt(raw, 10);
                    if (!isNaN(num) && num > MAX_PRODUCT_STOCK) {
                      triggerHaptic("warning");
                      setStock(String(MAX_PRODUCT_STOCK));
                      setFormError(`Maximum stock is ${MAX_PRODUCT_STOCK.toLocaleString("en-IN")} units.`);
                    } else {
                      setStock(raw);
                    }
                  }}
                  className="glass-input w-full font-mono text-base py-2"
                  placeholder="0"
                />
              </div>
            </motion.div>

            <motion.div variants={perfMode ? undefined : SHEET_ITEM_VARIANTS} className="mb-4">
              <label className="block text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-2 pl-1">
                Category
              </label>
              <div className="relative grid grid-cols-3 p-1 bg-[#ece6f0]/90 dark:bg-[#161922]/95 border border-slate-200/80 dark:border-white/[0.07] rounded-full select-none">
                <motion.div
                  initial={false}
                  animate={{
                    x: `${
                      category === "fresh"
                        ? 0
                        : category === "frozen"
                        ? 100
                        : 200
                    }%`,
                  }}
                  transition={
                    perfMode
                      ? { duration: 0 }
                      : {
                          type: "spring",
                          stiffness: 400,
                          damping: 30,
                          mass: 0.65,
                        }
                  }
                  style={{ width: "calc((100% - 8px) / 3)" }}
                  className="absolute top-1 bottom-1 left-1 bg-[#e0e7ff] dark:bg-indigo-500/25 rounded-full border border-indigo-200/70 dark:border-indigo-400/30 shadow-2xs pointer-events-none transform-gpu will-change-transform"
                />
                {["fresh", "frozen", "cold drinks"].map((cat) => (
                  <button
                    key={cat}
                    type="button"
                    onClick={() => {
                      triggerHaptic("selection");
                      setCategory(cat);
                    }}
                    className={`min-w-0 relative py-2.5 px-2 text-xs sm:text-sm font-bold z-10 transition-colors duration-200 outline-none rounded-full whitespace-nowrap cursor-pointer ${
                      category === cat
                        ? "text-indigo-950 dark:text-indigo-100"
                        : "text-slate-600 hover:text-slate-900 dark:text-slate-400 dark:hover:text-slate-200 active:scale-95"
                    }`}
                  >
                    <span className="relative z-20 capitalize tracking-tight truncate block">
                      {cat === "cold drinks" ? "Cold Drinks" : cat}
                    </span>
                  </button>
                ))}
              </div>
            </motion.div>
          </div>

          <motion.div
            variants={perfMode ? undefined : SHEET_ITEM_VARIANTS}
            className="pt-2 bg-transparent shrink-0"
          >
            <motion.button
              whileHover={isSubmitting || perfMode ? undefined : { scale: 1.01, y: -1 }}
              whileTap={isSubmitting || perfMode ? undefined : { scale: 0.975, y: 1 }}
              disabled={isSubmitting}
              onClick={() => {
                if (!isSubmitting) {
                  triggerHaptic("heavy");
                  handleSave();
                }
              }}
              className={`w-full text-white font-bold uppercase tracking-widest py-3 rounded-xl shadow-lg transition-colors cursor-pointer transform-gpu ${
                isSubmitting
                  ? "bg-indigo-400 cursor-not-allowed shadow-none"
                  : "bg-indigo-600 shadow-indigo-600/30 hover:bg-indigo-700"
              }`}
            >
              {isSubmitting
                ? "Saving..."
                : editingProduct
                ? "Save Changes"
                : "Save Product"}
            </motion.button>
          </motion.div>
        </div>
      </motion.div>
    </div>
  );
}

function AddStockModal({
  onClose,
  products,
}: {
  onClose: () => void;
  products: Product[];
}) {
  const { user } = useAuth();
  const { updateProductOptimistic } = useGlobalProducts("");
  const [selectedProducts, setSelectedProducts] = useState<Product[]>([]);
  const [amount, setAmount] = useState("10");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [pullState, setPullState] = useState<"half" | "full">("half");
  const [searchQuery, setSearchQuery] = useState("");
  const [isMobile, setIsMobile] = useState(false);
  const [stockError, setStockError] = useState("");
  const perfMode = isPerformanceModeEnabled();
  const stockDragControls = useDragControls();

  React.useEffect(() => {
    preloadProductImages(products);
  }, [products]);

  React.useEffect(() => {
    const checkMobile = () => setIsMobile(window.innerWidth < 640);
    checkMobile();
    window.addEventListener("resize", checkMobile);
    return () => window.removeEventListener("resize", checkMobile);
  }, []);

  const filteredProducts = products.filter((p) =>
    p.name.toLowerCase().includes(searchQuery.toLowerCase())
  );

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (selectedProducts.length === 0 || !amount || isSubmitting) return;
    const addedStockCount = parseInt(amount, 10);
    if (isNaN(addedStockCount) || addedStockCount < 1) {
      triggerHaptic("error");
      setStockError("Stock amount must be at least 1.");
      return;
    }
    const exceedingProduct = selectedProducts.find(
      (product) => (Number(product.stock) || 0) + addedStockCount > MAX_PRODUCT_STOCK
    );
    if (exceedingProduct) {
      triggerHaptic("error");
      const current = Number(exceedingProduct.stock) || 0;
      const maxCanAdd = Math.max(0, MAX_PRODUCT_STOCK - current);
      setStockError(
        `Cannot exceed maximum stock of ${MAX_PRODUCT_STOCK.toLocaleString("en-IN")} units for "${exceedingProduct.name}" (current: ${current}, max you can add: ${maxCanAdd}).`
      );
      return;
    }
    setStockError("");
    setIsSubmitting(true);
    triggerHaptic("medium");
    try {
      for (const product of selectedProducts) {
        if (!product.id) continue;
        const currentStock = Number(product.stock) || 0;
        const newStock = Math.min(MAX_PRODUCT_STOCK, currentStock + addedStockCount);
        updateProductOptimistic(product.id, { stock: newStock });
        updateProduct(product.id, { stock: newStock }).catch((err) =>
          console.error("Background stock update error:", err)
        );
        if (user) {
          logActivity(
            "stock_modification",
            `Bulk added ${addedStockCount} units to stock of "${
              product.name
            }" (New stock: ${newStock})`,
            user.uid,
            user.displayName || "Admin",
            user.email || ""
          ).catch((err) => console.error(err));
        }
      }
      triggerHaptic("success");
      onClose();
    } catch (err: any) {
      console.error("Failed to add stock:", err);
      setStockError(err.message || "Failed to update stock. Please try again.");
      triggerHaptic("error");
      setIsSubmitting(false);
    }
  };

  const targetSheetHeight =
    pullState === "full"
      ? "92dvh"
      : selectedProducts.length > 0
      ? "74dvh"
      : "64dvh";

  return (
    <div className="fixed inset-0 z-[70] flex items-end justify-center p-0">
      <motion.div
        initial={perfMode ? false : { opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={perfMode ? undefined : { opacity: 0 }}
        transition={perfMode ? { duration: 0 } : SHEET_BACKDROP_TRANSITION}
        onClick={onClose}
        className="absolute inset-0 bg-slate-950/45 dark:bg-slate-950/70 backdrop-blur-md transform-gpu"
      />
      <motion.div
        drag="y"
        dragControls={stockDragControls}
        dragListener={false}
        dragConstraints={{ top: 0, bottom: 0 }}
        dragElastic={{ top: 0.12, bottom: 0.45 }}
        onDragEnd={(e, info) => {
          const expandOffsetThreshold = 75;
          const closeOffsetThreshold = 85;
          const swipeVelocityThreshold = 380;

          if (pullState === "half") {
            if (
              info.offset.y < -expandOffsetThreshold ||
              (info.offset.y < -35 && info.velocity.y < -swipeVelocityThreshold)
            ) {
              setPullState("full");
              triggerHaptic("medium");
            } else if (
              info.offset.y > closeOffsetThreshold ||
              (info.offset.y > 40 && info.velocity.y > swipeVelocityThreshold)
            ) {
              triggerHaptic("light");
              onClose();
            }
          } else if (pullState === "full") {
            if (info.offset.y > 190 || (info.offset.y > 95 && info.velocity.y > 650)) {
              triggerHaptic("light");
              onClose();
            } else if (
              info.offset.y > expandOffsetThreshold ||
              (info.offset.y > 35 && info.velocity.y > swipeVelocityThreshold)
            ) {
              setPullState("half");
              triggerHaptic("medium");
            }
          }
        }}
        initial={perfMode ? false : { y: "100%", opacity: 0.6, height: targetSheetHeight }}
        animate={{
          y: 0,
          opacity: 1,
          height: targetSheetHeight,
        }}
        exit={
          perfMode
            ? undefined
            : {
                y: "104%",
                opacity: 0,
                transition: {
                  y: { duration: 0.2, ease: [0.32, 0, 0.67, 0] },
                  opacity: { duration: 0.16, ease: "easeIn" },
                },
              }
        }
        transition={
          perfMode
            ? { duration: 0 }
            : {
                y: { type: "spring", stiffness: 390, damping: 32, mass: 0.8 },
                height: { type: "spring", stiffness: 370, damping: 32, mass: 0.8 },
                opacity: { duration: 0.18, ease: "easeOut" },
              }
        }
        className="bg-[#fcf8ff] dark:bg-[#161923] w-full max-w-lg p-5 pb-6 sm:pb-6 relative z-10 flex flex-col rounded-t-[2.5rem] rounded-b-none border-b-0 max-h-[92dvh] overflow-visible shadow-2xl border border-slate-200/80 dark:border-white/[0.08] transform-gpu will-change-transform"
      >
        <div
          aria-hidden="true"
          className="pointer-events-none absolute top-[calc(100%-2px)] inset-x-[-1px] h-[100dvh] bg-[#fcf8ff] dark:bg-[#161923] border-x border-slate-200/80 dark:border-white/[0.08]"
        />
        {/* Dedicated top drag handle & header zone — only dragging here moves/expands the sheet */}
        <div
          onPointerDown={(e) => stockDragControls.start(e)}
          className="pt-1.5 pb-1.5 -mt-1 cursor-row-resize touch-none select-none shrink-0"
        >
          <div className="w-12 h-1.5 bg-slate-200 dark:bg-slate-700 rounded-full mx-auto mb-3 shrink-0 transition-transform" />

          <div className="flex justify-between items-center mb-3 shrink-0">
            <div>
              <h2 className="text-xl font-bold text-slate-900 dark:text-slate-100">
                Add Stock to Existing
              </h2>
              <p className="text-[10px] text-slate-400 dark:text-slate-500 font-bold uppercase tracking-wider mt-0.5">
                Select and enter restock quantities
              </p>
            </div>
            <div
              onPointerDown={(e) => e.stopPropagation()}
              className="flex gap-1.5 shrink-0"
            >
              <motion.button
                type="button"
                whileHover={{ scale: 1.06 }}
                whileTap={{ scale: 0.9 }}
                transition={{ type: "spring", stiffness: 430, damping: 24 }}
                onClick={() => {
                  triggerHaptic("medium");
                  setPullState(pullState === "full" ? "half" : "full");
                }}
                className="p-2.5 bg-slate-100/60 hover:bg-slate-200/80 dark:bg-slate-800/60 dark:hover:bg-slate-750 rounded-2xl text-indigo-600 dark:text-indigo-400 transition-colors cursor-pointer transform-gpu"
                title={pullState === "full" ? "Minimize View" : "Maximize View"}
              >
                <AnimatePresence mode="wait" initial={false}>
                  {pullState === "full" ? (
                    <motion.span
                      key="minimize-icon"
                      initial={{ scale: 0.65, opacity: 0, rotate: -45 }}
                      animate={{ scale: 1, opacity: 1, rotate: 0 }}
                      exit={{ scale: 0.65, opacity: 0, rotate: 45 }}
                      transition={{ duration: 0.14, ease: "easeOut" }}
                      className="flex items-center justify-center"
                    >
                      <Minimize2 size={16} />
                    </motion.span>
                  ) : (
                    <motion.span
                      key="maximize-icon"
                      initial={{ scale: 0.65, opacity: 0, rotate: 45 }}
                      animate={{ scale: 1, opacity: 1, rotate: 0 }}
                      exit={{ scale: 0.65, opacity: 0, rotate: -45 }}
                      transition={{ duration: 0.14, ease: "easeOut" }}
                      className="flex items-center justify-center"
                    >
                      <Maximize2 size={16} />
                    </motion.span>
                  )}
                </AnimatePresence>
              </motion.button>
              <motion.button
                type="button"
                whileHover={{ scale: 1.06, rotate: 90 }}
                whileTap={{ scale: 0.9 }}
                transition={{ type: "spring", stiffness: 430, damping: 24 }}
                onClick={onClose}
                className="p-2.5 bg-slate-100/60 hover:bg-slate-200/80 dark:bg-slate-800/60 dark:hover:bg-slate-750 rounded-2xl text-slate-500 dark:text-slate-400 transition-colors cursor-pointer transform-gpu"
              >
                <X size={16} />
              </motion.button>
            </div>
          </div>
        </div>

        <AnimatePresence initial={false}>
          {stockError && (
            <motion.div
              key="stock-error-banner"
              initial={{ opacity: 0, y: -8, scale: 0.97 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: -6, scale: 0.97 }}
              transition={{ type: "spring", stiffness: 420, damping: 28 }}
              className="p-3 mb-3 bg-red-50 dark:bg-red-500/10 border border-red-200 dark:border-red-900/30 text-red-600 dark:text-red-400 rounded-xl text-xs font-semibold flex items-center justify-between shrink-0"
            >
              <span className="flex items-center gap-2">
                <AlertTriangle size={14} className="shrink-0" />
                {stockError}
              </span>
              <button onClick={() => setStockError("")} className="text-red-500 hover:text-red-700">
                <X size={14} />
              </button>
            </motion.div>
          )}
        </AnimatePresence>

        {products.length === 0 ? (
          <div className="flex flex-col items-center justify-center p-8 text-center bg-slate-50 dark:bg-slate-800/50 rounded-3xl mt-4">
            <Package
              size={48}
              className="text-slate-400 dark:text-slate-500 mb-4"
            />
            <h3 className="text-lg font-bold text-slate-800 dark:text-slate-100 mb-2">
              No Products Found
            </h3>
            <p className="text-sm font-medium text-slate-500 dark:text-slate-400 max-w-[200px] mb-6">
              You need to create a product first before you can add stock to it.
            </p>
            <motion.button
              whileHover={{ scale: 1.02 }}
              whileTap={{ scale: 0.96 }}
              onClick={onClose}
              className="bg-indigo-600 hover:bg-indigo-700 text-white font-bold tracking-wide rounded-xl py-3 px-6 shadow-lg shadow-indigo-600/30 transition-colors text-sm cursor-pointer"
            >
              Close & Add Product
            </motion.button>
          </div>
        ) : (
          <form
            onSubmit={handleSubmit}
            className="space-y-3 flex flex-col flex-1 min-h-0"
          >
            <div className="flex flex-col flex-1 min-h-0">
              <div className="flex items-center gap-2 mb-3 shrink-0">
                <label className="text-xs font-bold text-slate-400 dark:text-slate-500 uppercase tracking-wider">
                  Select Product
                </label>
                <div className="flex-1 relative">
                  <input
                    type="text"
                    placeholder="Search products..."
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    className="w-full bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800/80 rounded-xl px-3 py-2 text-sm outline-none placeholder-slate-400 dark:placeholder-slate-500 text-slate-800 dark:text-slate-100 font-medium transition-all focus:border-indigo-500"
                  />
                </div>
              </div>

              <div className="flex-1 min-h-0 overflow-y-auto overscroll-contain custom-scrollbar">
                <div
                  className={`grid gap-3 p-1 pb-4 auto-rows-max ${
                    pullState === "full"
                      ? "grid-cols-2 sm:grid-cols-3 md:grid-cols-4"
                      : "grid-cols-2"
                  }`}
                >
                  {filteredProducts.length === 0 && (
                    <p className="text-sm text-slate-400 col-span-full text-center py-8">
                      No products match your search.
                    </p>
                  )}
                  {filteredProducts.map((p, idx) => {
                    const isSelected = selectedProducts.some(
                      (sp) => sp.id === p.id
                    );
                    const pImgUrl = getImageUrl(p.image);
                    return (
                      <motion.div
                        key={p.id || `p_${idx}`}
                        whileHover={{ y: -1.5, scale: 1.01 }}
                        whileTap={{ scale: 0.97 }}
                        transition={{
                          scale: { type: "spring", stiffness: 450, damping: 25 },
                        }}
                        onClick={() => {
                          if (isSelected) {
                            setSelectedProducts(
                              selectedProducts.filter((sp) => sp.id !== p.id)
                            );
                          } else {
                            setSelectedProducts([...selectedProducts, p]);
                          }
                          triggerHaptic("light");
                        }}
                        className={`p-3 rounded-[1.25rem] cursor-pointer border-2 transition-colors duration-150 flex flex-col justify-between h-fit min-h-fit relative transform-gpu ${
                          isSelected
                            ? "border-indigo-500 bg-indigo-50/80 dark:bg-indigo-950/50 shadow-[0_4px_20px_rgba(99,102,241,0.14)]"
                            : "border-slate-200/80 dark:border-white/[0.08] hover:border-indigo-500/40 bg-white dark:bg-[#1b1f2b] shadow-[0_1px_3px_rgba(15,23,42,0.04)] dark:shadow-none"
                        }`}
                      >
                        {pullState === "full" && (
                          <div className="w-full overflow-hidden rounded-xl shrink-0 mb-2.5">
                            <div className="w-full aspect-square rounded-xl overflow-hidden bg-slate-100 dark:bg-slate-950 flex items-center justify-center relative">
                              {pImgUrl ? (
                                <img
                                  src={pImgUrl}
                                  alt={p.name}
                                  loading="eager"
                                  decoding="sync"
                                  draggable={false}
                                  referrerPolicy="no-referrer"
                                  className="w-full h-full object-cover pointer-events-none"
                                />
                              ) : (
                                <ProductImagePlaceholder
                                  name={p.name}
                                  category={normalizeProductCategory(p.category, p.name)}
                                  size={64}
                                  className="w-full h-full"
                                  rounded="rounded-xl"
                                  showBorder={false}
                                  showShadow={false}
                                  isHome={true}
                                  monogramSize="bottom-0 right-2 text-[92px] sm:text-[108px] font-black"
                                />
                              )}
                              <div className="absolute inset-0 bg-gradient-to-t from-black/15 via-transparent to-transparent pointer-events-none" />
                            </div>
                          </div>
                        )}
                        <div className="min-w-0 w-full shrink-0">
                          <p className="font-bold text-sm text-slate-800 dark:text-slate-200 truncate leading-snug">
                            {p.name}
                          </p>
                          <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5 leading-snug">
                            Stock:{" "}
                            <span className="font-mono font-bold text-slate-700 dark:text-slate-300">
                              {p.stock}
                            </span>
                          </p>
                        </div>
                      </motion.div>
                    );
                  })}
                </div>
              </div>
            </div>

            <AnimatePresence initial={false}>
              {selectedProducts.length > 0 && (
                <motion.div
                  key="selected-restock-footer"
                  initial={{ opacity: 0, y: 16, scale: 0.98 }}
                  animate={{ opacity: 1, y: 0, scale: 1 }}
                  exit={{ opacity: 0, y: 12, scale: 0.98 }}
                  transition={{
                    type: "spring",
                    stiffness: 410,
                    damping: 30,
                    mass: 0.72,
                  }}
                  className="space-y-4 pt-2 shrink-0"
                >
                  <div className="bg-slate-50/60 dark:bg-slate-900/40 p-4 rounded-2xl border border-slate-100 dark:border-slate-800/50">
                    <div className="flex justify-between items-center mb-2.5">
                      <label className="text-xs font-bold text-slate-400 dark:text-slate-500 uppercase tracking-wider">
                        Add Quantity to {selectedProducts.length} Item(s)
                      </label>
                      <span className="text-[10px] bg-indigo-50 dark:bg-indigo-950/50 text-indigo-600 dark:text-indigo-400 px-2 py-0.5 rounded-full font-bold">
                        Selected
                      </span>
                    </div>
                    <input
                      type="number"
                      min="1"
                      max={MAX_PRODUCT_STOCK}
                      required
                      value={amount}
                      onChange={(e) => {
                        const raw = e.target.value;
                        if (raw === "") {
                          setAmount("");
                          return;
                        }
                        const num = parseInt(raw, 10);
                        if (!isNaN(num) && num > MAX_PRODUCT_STOCK) {
                          triggerHaptic("warning");
                          setAmount(String(MAX_PRODUCT_STOCK));
                          setStockError(`Maximum stock per product is ${MAX_PRODUCT_STOCK.toLocaleString("en-IN")} units.`);
                        } else {
                          setAmount(raw);
                        }
                      }}
                      className="glass-input w-full font-mono text-xl py-2.5 px-4 rounded-xl border border-slate-200 dark:border-slate-800 focus:border-indigo-500"
                      placeholder="e.g. 10"
                    />
                  </div>
                  <motion.button
                    type="submit"
                    disabled={isSubmitting}
                    whileHover={isSubmitting ? undefined : { scale: 1.01, y: -1 }}
                    whileTap={isSubmitting ? undefined : { scale: 0.975 }}
                    className="w-full py-4 rounded-2xl font-black text-white bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors shadow-lg shadow-indigo-600/30 flex items-center justify-center gap-2 cursor-pointer transform-gpu"
                  >
                    {isSubmitting ? (
                      <span className="w-5 h-5 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                    ) : (
                      "Confirm Restock"
                    )}
                  </motion.button>
                </motion.div>
              )}
            </AnimatePresence>
          </form>
        )}
      </motion.div>
    </div>
  );
}

