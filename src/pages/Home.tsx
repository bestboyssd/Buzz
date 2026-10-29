import React, { useState, useMemo, useRef, useEffect } from "react";
import { motion, AnimatePresence } from "motion/react";
import { useNavigate } from "react-router-dom";
import {
  formatPrice,
  MAX_BILL_AMOUNT,
  useOptimizedTransition,
  useHardwareAcceleration,
} from "../lib/utils";
import { Search, ShoppingBag, X, Minus, Plus, ArrowRight, AlertTriangle } from "lucide-react";
import { useGlobalBills } from "../lib/BillsContext";
import { useGlobalProducts } from "../lib/ProductsContext";
import { triggerHaptic } from "../lib/haptics";
import { ProfileMenu } from "../components/ProfileMenu";
import { useCart } from "../lib/CartContext";
import { ProductImagePlaceholder } from "../components/ProductImagePlaceholder";
import { getImageUrl } from "../lib/imageUtils";
import { Product } from "../lib/firestoreHooks";
import { normalizeProductCategory } from "../lib/geminiApi";

export function Home() {
  const [search, setSearch] = useState("");
  const [selectedCategory, setSelectedCategory] = useState<string>("all");
  const [maxBillNotice, setMaxBillNotice] = useState<string>("");
  const { products, loading: productsLoading } = useGlobalProducts(search);
  const { bills } = useGlobalBills();
  const { cart, addToCart, removeFromCart, totalAmount, editingBill, reservedByOthers } = useCart();
  const navigate = useNavigate();
  const categories = ["all", "fresh", "frozen", "cold drinks"];

  useEffect(() => {
    let timer: number | undefined;
    const handleMaxBillLimit = (e: Event) => {
      const customEvent = e as CustomEvent<{ max?: number; message?: string }>;
      setMaxBillNotice(
        customEvent?.detail?.message || "Cannot add more than ₹10,000 value in cart."
      );
      if (timer) window.clearTimeout(timer);
      timer = window.setTimeout(() => setMaxBillNotice(""), 3200);
    };
    window.addEventListener("maxBillLimitReached", handleMaxBillLimit);
    return () => {
      window.removeEventListener("maxBillLimitReached", handleMaxBillLimit);
      if (timer) window.clearTimeout(timer);
    };
  }, []);

  // Long-press (+10) state for all products
  const holdTimerRef = useRef<number | null>(null);
  const holdTriggeredRef = useRef<boolean>(false);
  const pointerStartRef = useRef<{ x: number; y: number } | null>(null);

  const clearHoldTimer = () => {
    if (holdTimerRef.current !== null) {
      window.clearTimeout(holdTimerRef.current);
      holdTimerRef.current = null;
    }
  };

  useEffect(() => {
    return () => clearHoldTimer();
  }, []);

  const startProductHold = (
    e: React.PointerEvent,
    product: Product,
    disableAdd: boolean,
    wouldExceedMaxBill: boolean = false
  ) => {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    clearHoldTimer();
    holdTriggeredRef.current = false;
    pointerStartRef.current = { x: e.clientX, y: e.clientY };

    holdTimerRef.current = window.setTimeout(() => {
      holdTimerRef.current = null;
      holdTriggeredRef.current = true;
      const pPrice = Math.max(0, Number(product.price) || 0);
      if (wouldExceedMaxBill || (pPrice > 0 && totalAmount + pPrice > MAX_BILL_AMOUNT)) {
        triggerHaptic("error");
        window.dispatchEvent(
          new CustomEvent("maxBillLimitReached", {
            detail: {
              max: MAX_BILL_AMOUNT,
              message: "Cannot add more than ₹10,000 value in cart.",
            },
          })
        );
      } else if (!disableAdd) {
        addToCart(product, 10);
      } else {
        triggerHaptic("error");
      }
    }, 420);
  };

  const startMinusHold = (
    e: React.PointerEvent,
    productId: string | undefined
  ) => {
    if (!productId) return;
    if (e.pointerType === "mouse" && e.button !== 0) return;
    clearHoldTimer();
    holdTriggeredRef.current = false;
    pointerStartRef.current = { x: e.clientX, y: e.clientY };

    holdTimerRef.current = window.setTimeout(() => {
      holdTimerRef.current = null;
      holdTriggeredRef.current = true;
      removeFromCart(productId, 10);
    }, 420);
  };

  const moveProductHold = (e: React.PointerEvent) => {
    if (!pointerStartRef.current || holdTimerRef.current === null) return;
    const dx = e.clientX - pointerStartRef.current.x;
    const dy = e.clientY - pointerStartRef.current.y;
    if (Math.hypot(dx, dy) > 10) {
      clearHoldTimer();
    }
  };

  const endProductHold = () => {
    clearHoldTimer();
    pointerStartRef.current = null;
  };

  const totalItemsInCart = useMemo(
    () => cart.reduce((sum, item) => sum + item.quantity, 0),
    [cart]
  );

  // Compute product sales to determine popularity
  const sortedProducts = useMemo(() => {
    const baseProducts = [...(products || [])];

    // If editing a bill that references products deleted from catalog, surface them while editing
    if (editingBill && Array.isArray(editingBill.items)) {
      for (const billItem of editingBill.items) {
        if (!billItem?.productId) continue;
        const exists = baseProducts.some((p) => p.id === billItem.productId);
        if (!exists) {
          const cartMatch = cart.find((c) => c.product.id === billItem.productId);
          baseProducts.push({
            id: billItem.productId,
            name: billItem.name || cartMatch?.product.name || "Restored Item",
            price: Number(cartMatch?.product.price ?? billItem.price) || 0,
            stock: 0,
            category: cartMatch?.product.category || "fresh",
            createdAt: Date.now(),
          });
        }
      }
    }

    const salesCount: Record<string, number> = {};
    bills.forEach((bill) => {
      (bill.items || []).forEach((item) => {
        if (item?.productId) {
          salesCount[item.productId] =
            (salesCount[item.productId] || 0) + (Number(item.quantity) || 0);
        }
      });
    });

    const matchesCategory = (p: Product, selected: string) => {
      if (selected === "all") return true;
      const effectiveCat = normalizeProductCategory(p.category, p.name);
      const normProd = effectiveCat.toLowerCase().replace(/[\s-_]+/g, "");
      const normSel = selected.toLowerCase().replace(/[\s-_]+/g, "");
      return normProd === normSel;
    };

    const prods = baseProducts.filter((p) =>
      matchesCategory(p, selectedCategory)
    );

    if (!search && bills.length > 0) {
      prods.sort((a, b) => (salesCount[b.id!] || 0) - (salesCount[a.id!] || 0));
    }
    return prods;
  }, [products, bills, search, selectedCategory, editingBill, cart]);

  const pageTransition = useOptimizedTransition({
    duration: 0.35,
    ease: [0.16, 1, 0.3, 1],
  });
  const gpuClass = useHardwareAcceleration();

  return (
    <motion.div
      initial={{ opacity: 0, scale: 0.98 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={{ opacity: 0, scale: 0.98 }}
      transition={pageTransition}
      className={`min-h-full flex flex-col pb-2 px-4 pt-10 w-full max-w-lg md:max-w-3xl lg:max-w-5xl mx-auto ${gpuClass}`}
    >
      <header className="mb-5 pl-1 flex justify-between items-center gap-4">
        <div>
          <div className="flex items-center gap-2.5">
            <h1 className="text-3xl font-extrabold tracking-tight text-slate-900 dark:text-slate-100">
              Smart<span className="text-indigo-600 dark:text-indigo-400">POS</span>
            </h1>
            {editingBill && (
              <span className="text-xs font-semibold text-amber-600 dark:text-amber-400 font-mono">
                · Editing #{editingBill.id?.slice(-5)}
              </span>
            )}
          </div>
          <p className="text-[13px] leading-snug text-slate-500 dark:text-slate-400 font-medium mt-1">
            Quick billing terminal
          </p>
        </div>
        <div className="flex items-center gap-2.5">
          {totalItemsInCart > 0 && (
            <motion.button
              initial={{ opacity: 0, scale: 0.9 }}
              animate={{ opacity: 1, scale: 1 }}
              whileTap={{ scale: 0.95 }}
              onClick={() => {
                triggerHaptic("medium");
                navigate("/checkout");
              }}
              className="hidden sm:inline-flex items-center gap-2 px-4 py-2.5 rounded-full bg-indigo-600 hover:bg-indigo-700 text-white text-xs font-bold shadow-md shadow-indigo-600/20 transition-all whitespace-nowrap shrink-0"
            >
              <span>{totalItemsInCart} items</span>
              <span>·</span>
              <span className="font-mono tabular-nums">₹{formatPrice(totalAmount)}</span>
              <ArrowRight size={14} />
            </motion.button>
          )}
          <ProfileMenu />
        </div>
      </header>

      <AnimatePresence>
        {maxBillNotice && (
          <motion.div
            initial={{ opacity: 0, y: -8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            className="sticky top-2 z-40 mb-3 px-3.5 py-2.5 rounded-2xl bg-amber-50/95 dark:bg-slate-900/95 backdrop-blur-md border border-amber-300 dark:border-amber-500/40 text-amber-800 dark:text-amber-300 text-xs font-bold shadow-md flex items-center justify-between gap-2"
          >
            <span className="flex items-center gap-2">
              <AlertTriangle size={14} className="shrink-0 text-amber-600 dark:text-amber-400" />
              <span>{maxBillNotice}</span>
            </span>
            <button
              type="button"
              onClick={() => setMaxBillNotice("")}
              className="text-amber-600 dark:text-amber-300 hover:opacity-80"
            >
              <X size={14} />
            </button>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Search Bar with Instant Clear Button */}
      <div className="relative mb-4">
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

      {/* Material 3 Interactive Category Segmented Filter Bar */}
      {categories.length > 1 && (
        <div className="relative grid grid-cols-4 p-1 mb-5 bg-[#ece6f0]/90 dark:bg-[#161922]/95 border border-slate-200/80 dark:border-white/[0.07] rounded-full select-none">
          <motion.div
            initial={false}
            animate={{
              x: `${Math.max(0, categories.indexOf(selectedCategory)) * 100}%`,
            }}
            transition={{
              type: "spring",
              stiffness: 400,
              damping: 30,
              mass: 0.65,
            }}
            style={{ width: `calc((100% - 8px) / ${categories.length})` }}
            className="absolute top-1 bottom-1 left-1 bg-[#e0e7ff] dark:bg-indigo-500/25 border border-indigo-200/70 dark:border-indigo-400/30 rounded-full shadow-2xs pointer-events-none transform-gpu will-change-transform"
          />
          {categories.map((cat) => {
            const isActive = selectedCategory === cat;
            return (
              <button
                key={cat}
                type="button"
                onClick={() => {
                  if (selectedCategory === cat) return;
                  triggerHaptic("selection");
                  setSelectedCategory(cat);
                }}
                className={`relative z-10 min-w-0 min-h-[36px] px-1.5 sm:px-3 py-1.5 rounded-full whitespace-nowrap text-[11px] sm:text-xs font-bold outline-none transition-colors duration-200 flex items-center justify-center cursor-pointer ${
                  isActive
                    ? "text-indigo-950 dark:text-indigo-100"
                    : "text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200 active:scale-95"
                }`}
              >
                <span className="relative z-10 truncate">
                  {cat === "all" ? "All Items" : cat.charAt(0).toUpperCase() + cat.slice(1)}
                </span>
              </button>
            );
          })}
        </div>
      )}

      {productsLoading ? null : sortedProducts.length === 0 ? (
        <div className="glass-card text-center py-14 px-6 text-slate-500 flex-1 flex flex-col items-center justify-center gap-2">
          <ShoppingBag
            size={44}
            className="text-slate-300 dark:text-slate-600 mb-1"
          />
          <p className="font-bold text-slate-800 dark:text-slate-200 text-base">
            No matching products
          </p>
          <p className="text-xs text-slate-500 dark:text-slate-400 max-w-xs">
            {search || selectedCategory !== "all"
              ? "Try clearing your search query or switching back to All Items."
              : "Add products in the Stock tab to start billing."}
          </p>
          {(search || selectedCategory !== "all") && (
            <button
              onClick={() => {
                triggerHaptic("light");
                setSearch("");
                setSelectedCategory("all");
              }}
              className="mt-3 px-4 py-2 rounded-xl bg-indigo-50 dark:bg-indigo-500/15 text-indigo-600 dark:text-indigo-400 text-xs font-bold hover:bg-indigo-100 transition-colors"
            >
              Reset Filters
            </button>
          )}
        </div>
      ) : (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: 0.25 }}
          className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3 sm:gap-4"
        >
          {sortedProducts.map((product, idx) => {
            const cartItem = cart.find((c) => c.product.id === product.id);
            const quantityInCart = cartItem?.quantity || 0;
            const originalItem = editingBill?.items.find(
              (i) => i.productId === product.id
            );
            const originalQty = originalItem
              ? Number(originalItem.quantity || 0)
              : 0;
            const pStock = Number(product.stock) || 0;
            const pPrice = Math.max(0, Number(product.price) || 0);
            const reservedByOther = product.id
              ? Math.max(0, Number(reservedByOthers[product.id]) || 0)
              : 0;
            const catalogStock = pStock + originalQty;
            const maxStock = Math.max(0, catalogStock - reservedByOther);
            const remainingStock = Math.max(0, maxStock - quantityInCart);
            const isOutOfStock = catalogStock === 0;
            const isMaxAdded = remainingStock === 0 && !isOutOfStock;
            const wouldExceedMaxBill =
              pPrice > 0 && totalAmount + pPrice > MAX_BILL_AMOUNT;
            const disableAdd = isOutOfStock || isMaxAdded;

            return (
              <motion.div
                key={product.id ? `pos_${product.id}` : `product_${idx}`}
                whileTap={!disableAdd ? { scale: 0.97 } : undefined}
                onContextMenu={(e) => e.preventDefault()}
                onPointerDown={(e) => startProductHold(e, product, disableAdd, wouldExceedMaxBill)}
                onPointerMove={moveProductHold}
                onPointerUp={endProductHold}
                onPointerCancel={endProductHold}
                onPointerLeave={endProductHold}
                onClick={() => {
                  if (holdTriggeredRef.current) {
                    holdTriggeredRef.current = false;
                    return;
                  }
                  if (wouldExceedMaxBill) {
                    triggerHaptic("error");
                    window.dispatchEvent(
                      new CustomEvent("maxBillLimitReached", {
                        detail: {
                          max: MAX_BILL_AMOUNT,
                          message: "Cannot add more than ₹10,000 value in cart.",
                        },
                      })
                    );
                  } else if (!disableAdd) {
                    addToCart(product, 1);
                  } else {
                    triggerHaptic("error");
                    if (isMaxAdded) {
                      window.dispatchEvent(
                        new CustomEvent("maxBillLimitReached", {
                          detail: {
                            message:
                              reservedByOther > 0
                                ? `Max in cart — ${reservedByOther} ${product.name} reserved in another active cart.`
                                : `Max available ${product.name} (${maxStock}) already in cart.`,
                          },
                        })
                      );
                    }
                  }
                }}
                className={`group/card flex flex-col justify-between relative overflow-hidden text-slate-800 dark:text-slate-200 transition-all duration-200 rounded-[1.75rem] border select-none ${
                  isOutOfStock
                    ? "cursor-not-allowed bg-white dark:bg-slate-900 border-slate-200/80 dark:border-slate-800/90"
                    : quantityInCart > 0
                    ? `border-indigo-500 dark:border-indigo-500/90 bg-white dark:bg-slate-900 shadow-md shadow-indigo-500/10 ring-1 ring-indigo-500/30 ${
                        isMaxAdded ? "cursor-not-allowed" : "cursor-pointer"
                      }`
                    : isMaxAdded
                    ? "cursor-not-allowed border-amber-300/80 dark:border-amber-500/40 bg-white dark:bg-slate-900 shadow-xs"
                    : "border-slate-200/80 dark:border-slate-800/90 bg-white dark:bg-slate-900 shadow-xs hover:shadow-md hover:border-slate-300 dark:hover:border-slate-700 cursor-pointer"
                }`}
              >
                <div className="p-2 pb-0">
                  <div className="relative w-full aspect-square bg-slate-100 dark:bg-slate-950 overflow-hidden rounded-[1.35rem] group/image">
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
                          className={`w-full h-full object-cover pointer-events-none ${
                            isOutOfStock ? "opacity-55 grayscale-[30%]" : ""
                          }`}
                        />
                      ) : (
                        <ProductImagePlaceholder
                          name={product.name}
                          category={product.category}
                          size={72}
                          className={`w-full h-full ${
                            isOutOfStock ? "opacity-55 grayscale-[30%]" : ""
                          }`}
                          rounded="rounded-[1.35rem]"
                          showBorder={false}
                          showShadow={false}
                          isHome={true}
                        />
                      );
                    })()}
                    <div className="absolute inset-0 bg-gradient-to-t from-black/15 via-transparent to-transparent pointer-events-none" />

                    {/* Interactive Quantity Stepper Overlay when item is in cart */}
                    <AnimatePresence>
                      {quantityInCart > 0 && (
                        <motion.div
                          key={`stepper_${product.id || idx}`}
                          initial={{ scale: 0.8, opacity: 0 }}
                          animate={{ scale: 1, opacity: 1 }}
                          exit={{ scale: 0.8, opacity: 0 }}
                          transition={{ duration: 0.15 }}
                          onPointerDown={(e) => e.stopPropagation()}
                          onClick={(e) => e.stopPropagation()}
                          className="absolute top-2 right-2 z-20 flex items-center gap-1 bg-slate-900/90 dark:bg-indigo-600/95 backdrop-blur-md text-white p-1 rounded-full shadow-lg border border-white/15"
                        >
                          <button
                            type="button"
                            aria-label={`Decrease ${product.name} quantity`}
                            onPointerDown={(e) => {
                              e.stopPropagation();
                              startMinusHold(e, product.id);
                            }}
                            onPointerMove={moveProductHold}
                            onPointerUp={endProductHold}
                            onPointerCancel={endProductHold}
                            onPointerLeave={endProductHold}
                            onClick={(e) => {
                              e.stopPropagation();
                              if (holdTriggeredRef.current) {
                                holdTriggeredRef.current = false;
                                return;
                              }
                              if (product.id) removeFromCart(product.id, 1);
                            }}
                            className="w-7 h-7 rounded-full flex items-center justify-center bg-white/15 hover:bg-white/25 active:scale-90 transition-all"
                          >
                            <Minus size={13} strokeWidth={2.5} />
                          </button>
                          <span className="min-w-[22px] text-center font-mono tabular-nums text-xs font-extrabold px-0.5">
                            {quantityInCart}
                          </span>
                          <button
                            type="button"
                            aria-label={`Increase ${product.name} quantity`}
                            disabled={disableAdd && !wouldExceedMaxBill}
                            onPointerDown={(e) => {
                              e.stopPropagation();
                              startProductHold(e, product, disableAdd, wouldExceedMaxBill);
                            }}
                            onPointerMove={moveProductHold}
                            onPointerUp={endProductHold}
                            onPointerCancel={endProductHold}
                            onPointerLeave={endProductHold}
                            onClick={(e) => {
                              e.stopPropagation();
                              if (holdTriggeredRef.current) {
                                holdTriggeredRef.current = false;
                                return;
                              }
                              if (wouldExceedMaxBill) {
                                triggerHaptic("error");
                                window.dispatchEvent(
                                  new CustomEvent("maxBillLimitReached", {
                                    detail: {
                                      max: MAX_BILL_AMOUNT,
                                      message: "Cannot add more than ₹10,000 value in cart.",
                                    },
                                  })
                                );
                              } else if (!disableAdd) {
                                addToCart(product, 1);
                              } else {
                                triggerHaptic("error");
                              }
                            }}
                            className="w-7 h-7 rounded-full flex items-center justify-center bg-white/15 hover:bg-white/25 active:scale-90 transition-all disabled:opacity-40"
                          >
                            <Plus size={13} strokeWidth={2.5} />
                          </button>
                        </motion.div>
                      )}
                    </AnimatePresence>
                  </div>
                </div>

                <div className="p-3.5 pt-3 relative z-10 flex flex-col flex-1 justify-between">
                  <h3
                    className={`font-bold text-[15px] leading-snug mb-2 line-clamp-1 transition-colors ${
                      isOutOfStock
                        ? "text-slate-400 dark:text-slate-500"
                        : "text-slate-900 dark:text-slate-100 group-hover/card:text-indigo-600 dark:group-hover/card:text-indigo-400"
                    }`}
                  >
                    {product.name}
                  </h3>
                  <div className="flex justify-between items-baseline w-full gap-1 mt-auto">
                    <span
                      className={`font-extrabold font-mono tabular-nums tracking-tight text-base sm:text-[17px] ${
                        isOutOfStock
                          ? "text-slate-400 dark:text-slate-500"
                          : "text-slate-900 dark:text-white"
                      }`}
                    >
                      ₹{formatPrice(product.price)}
                    </span>

                    {/* Clean Unboxed Stock Status Metadata */}
                    {isOutOfStock ? (
                      <span className="text-[11px] font-bold text-red-600 dark:text-red-400 whitespace-nowrap">
                        Sold out
                      </span>
                    ) : isMaxAdded ? (
                      <span className="text-[11px] font-bold text-amber-600 dark:text-amber-400 whitespace-nowrap">
                        Max in cart
                      </span>
                    ) : remainingStock <= 3 ? (
                      <span className="text-[11px] font-bold text-amber-600 dark:text-amber-400 font-mono tabular-nums whitespace-nowrap">
                        {remainingStock} left
                      </span>
                    ) : (
                      <span className="text-[11px] font-medium text-slate-500 dark:text-slate-400 font-mono tabular-nums whitespace-nowrap">
                        {remainingStock} left
                      </span>
                    )}
                  </div>
                </div>
              </motion.div>
            );
          })}
        </motion.div>
      )}
    </motion.div>
  );
}
