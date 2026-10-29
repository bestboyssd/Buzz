import React, { useState, useMemo, useRef, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { motion, AnimatePresence } from 'motion/react';
import { useNavigate } from 'react-router-dom';
import { useCart } from '../lib/CartContext';
import { checkoutNewBill, logActivity, updateBill, revertBillFromHold, Product, getEffectiveProductCost, consumeProductCostBatchesForSale, UdhaarHoldOptions } from '../lib/firestoreHooks';
import { useAuth } from '../lib/AuthContext';
import { useGlobalProducts } from '../lib/ProductsContext';
import { triggerHaptic } from '../lib/haptics';
import { formatPrice, MAX_BILL_AMOUNT, useOptimizedTransition, useHardwareAcceleration } from '../lib/utils';
import { BadgeCheck, ShoppingCart, Minus, Plus, Trash2, ArrowLeft, PauseCircle, User, Phone, FileText, X } from 'lucide-react';
import { ProfileMenu } from '../components/ProfileMenu';
import { ProductImagePlaceholder } from '../components/ProductImagePlaceholder';
import { getImageUrl } from '../lib/imageUtils';

export function Checkout() {
  const { cart, removeFromCart, addToCart, setQuantity, setPrice, totalAmount, clearCart, editingBill, reservedByOthers, setCheckoutInProgress } = useCart();
  const { products } = useGlobalProducts("");
  const { user } = useAuth();
  const navigate = useNavigate();
  const [isSuccess, setIsSuccess] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const isSubmittingOrSuccessRef = useRef(false);
  isSubmittingOrSuccessRef.current = isSuccess || isSubmitting;
  const [errorMessage, setErrorMessage] = useState("");
  const [editingQuantities, setEditingQuantities] = useState<Record<string, string>>({});
  const [editingPrices, setEditingPrices] = useState<Record<string, string>>({});
  const [completedSummary, setCompletedSummary] = useState<{
    total: number;
    units: number;
    itemsCount: number;
    isEdit: boolean;
    isHold?: boolean;
    customerName?: string;
    linkedToOtherCosts?: boolean;
  } | null>(null);

  // Udhar Modal State
  const [showHoldModal, setShowHoldModal] = useState(false);
  const [customerName, setCustomerName] = useState("");
  const [customerPhone, setCustomerPhone] = useState("");
  const [udhaarNote, setUdhaarNote] = useState("");
  const [udhaarError, setUdhaarError] = useState("");
  const customerNameInputRef = useRef<HTMLInputElement>(null);

  const openHoldModal = () => {
    if (cart.length === 0 || isSubmitting) return;
    if (totalAmount <= 0) {
      triggerHaptic('error');
      setErrorMessage("Cannot put a ₹0 bill on Udhar. Please verify item prices and quantities.");
      return;
    }
    triggerHaptic('selection');
    const existingName = editingBill?.customerName?.trim() || "";
    setCustomerName(existingName === "Walk-in Customer" ? "" : existingName);
    setCustomerPhone(editingBill?.customerPhone || "");
    setUdhaarNote(editingBill?.udhaarNote || "");
    setUdhaarError("");
    setShowHoldModal(true);
  };

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
    let errTimer: number | undefined;
    const handleMaxBillLimit = (e: Event) => {
      if (isSubmittingOrSuccessRef.current) return;
      const customEvent = e as CustomEvent<{ max?: number; message?: string }>;
      setErrorMessage(
        customEvent?.detail?.message || 'Cannot add more than ₹10,000 value in cart.'
      );
      if (errTimer) window.clearTimeout(errTimer);
      errTimer = window.setTimeout(() => setErrorMessage(''), 3200);
    };
    window.addEventListener('maxBillLimitReached', handleMaxBillLimit);
    return () => {
      clearHoldTimer();
      setCheckoutInProgress(false);
      window.removeEventListener('maxBillLimitReached', handleMaxBillLimit);
      if (errTimer) window.clearTimeout(errTimer);
    };
  }, []);

  const clearDraftQty = (prodId: string) => {
    setEditingQuantities((prev) => {
      if (!Object.prototype.hasOwnProperty.call(prev, prodId)) return prev;
      const next = { ...prev };
      delete next[prodId];
      return next;
    });
  };

  const startMinusHold = (
    e: React.PointerEvent,
    productId: string | undefined,
    prodIdKey: string
  ) => {
    if (!productId) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    clearHoldTimer();
    holdTriggeredRef.current = false;
    pointerStartRef.current = { x: e.clientX, y: e.clientY };

    holdTimerRef.current = window.setTimeout(() => {
      holdTimerRef.current = null;
      holdTriggeredRef.current = true;
      clearDraftQty(prodIdKey);
      removeFromCart(productId, 10);
    }, 420);
  };

  const startPlusHold = (
    e: React.PointerEvent,
    product: Product,
    prodIdKey: string,
    isAtMax: boolean
  ) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    clearHoldTimer();
    holdTriggeredRef.current = false;
    pointerStartRef.current = { x: e.clientX, y: e.clientY };

    holdTimerRef.current = window.setTimeout(() => {
      holdTimerRef.current = null;
      holdTriggeredRef.current = true;
      clearDraftQty(prodIdKey);
      const unitPrice = Math.max(0, Number(product.price) || 0);
      if (unitPrice > 0 && totalAmount + unitPrice > MAX_BILL_AMOUNT) {
        triggerHaptic('warning');
        window.dispatchEvent(
          new CustomEvent('maxBillLimitReached', {
            detail: { max: MAX_BILL_AMOUNT, message: 'Cannot add more than ₹10,000 value in cart.' },
          })
        );
      } else if (isAtMax) {
        triggerHaptic('warning');
      } else {
        addToCart(product, 10);
      }
    }, 420);
  };

  const moveHold = (e: React.PointerEvent) => {
    if (!pointerStartRef.current || holdTimerRef.current === null) return;
    const dx = e.clientX - pointerStartRef.current.x;
    const dy = e.clientY - pointerStartRef.current.y;
    if (Math.hypot(dx, dy) > 10) {
      clearHoldTimer();
    }
  };

  const endHold = () => {
    clearHoldTimer();
    pointerStartRef.current = null;
  };

  const totalUnits = useMemo(
    () => cart.reduce((sum, item) => sum + item.quantity, 0),
    [cart]
  );

  const handleCancelEdit = async () => {
    if (!editingBill?.id || isSubmitting) return;
    setIsSubmitting(true);
    triggerHaptic('heavy');

    try {
      revertBillFromHold(editingBill.id, editingBill.status || 'completed').catch((e) => {
        console.error('Cancel edit background error:', e);
      });
      triggerHaptic('light');
      clearCart();
      setIsSubmitting(false);
      navigate('/');
    } catch (e: any) {
      console.error('Cancel edit failed:', e);
      triggerHaptic('error');
      setErrorMessage(`Failed to cancel edit: ${e.message || e}`);
      setIsSubmitting(false);
    }
  };

  const handleCheckout = async (holdOptions?: UdhaarHoldOptions) => {
    if (cart.length === 0 && editingBill?.id) {
      await handleCancelEdit();
      return;
    }

    if (cart.length === 0 || isSuccess || isSubmitting) {
      return;
    }

    if (totalAmount <= 0) {
      triggerHaptic('error');
      setErrorMessage("Cannot checkout with a total of ₹0. Please verify item prices and quantities.");
      return;
    }

    if (totalAmount > MAX_BILL_AMOUNT) {
      triggerHaptic('error');
      setErrorMessage("Maximum bill limit is ₹10,000. Please reduce item quantities or prices.");
      return;
    }

    const isHoldOrder = Boolean(holdOptions?.isHold);
    if (isHoldOrder && !holdOptions?.customerName?.trim()) {
      triggerHaptic('error');
      setUdhaarError("Customer name is required to put a bill on Udhar.");
      customerNameInputRef.current?.focus();
      return;
    }
    setShowHoldModal(false);
    setUdhaarError("");
    setErrorMessage("");
    setCheckoutInProgress(true);
    setIsSubmitting(true);
    isSubmittingOrSuccessRef.current = true;
    triggerHaptic('heavy');

    const snapshotTotal = totalAmount;
    const snapshotUnits = totalUnits;
    const snapshotItemsCount = cart.length;
    const snapshotIsEdit = Boolean(editingBill?.id);

    const billItems = cart.map((item) => {
      const liveProd = products.find((p) => p.id === item.product.id) || item.product;
      const qty = Math.max(1, Number(item.quantity || 1));
      const { unitCostPrice } = consumeProductCostBatchesForSale(liveProd, qty);
      return {
        productId: item.product.id || 'unknown_product',
        name: item.product.name || 'Unknown Product',
        price: Math.max(0, Number(item.product.price || 0)),
        ...(unitCostPrice > 0 ? { costPrice: unitCostPrice } : {}),
        quantity: qty,
      };
    });

    try {
      if (editingBill?.id) {
        const effectiveHoldOpts: UdhaarHoldOptions = isHoldOrder
          ? holdOptions!
          : {
              isHold: false,
              customerName: '',
              customerPhone: '',
              udhaarNote: '',
              linkToOtherCosts: false,
            };

        await updateBill(
          editingBill.id,
          billItems,
          editingBill.items,
          snapshotTotal,
          effectiveHoldOpts,
          user?.uid
        );

        if (user) {
          logActivity(
            'checkout',
            isHoldOrder
              ? `Updated Hold / Udhaar bill #${editingBill.id} for ${holdOptions?.customerName?.trim()} (₹${formatPrice(snapshotTotal)}).`
              : `Edited transaction bill #${editingBill.id} (New Total: ₹${formatPrice(snapshotTotal)}) with ${snapshotUnits} items.`,
            user.uid,
            user.displayName || 'User',
            user.email || ''
          ).catch((e) => console.error(e));
        }
      } else {
        await checkoutNewBill(
          billItems,
          snapshotTotal,
          {
            uid: user?.uid || '',
            displayName: user?.displayName || 'Staff',
            email: user?.email || '',
          },
          isHoldOrder ? holdOptions : undefined
        );

        if (user) {
          logActivity(
            'checkout',
            isHoldOrder
              ? `Placed bill on hold / Udhaar for ${holdOptions?.customerName?.trim()} (Total: ₹${formatPrice(snapshotTotal)}).`
              : `Created transaction bill (Total: ₹${formatPrice(snapshotTotal)}) with ${snapshotUnits} items.`,
            user.uid,
            user.displayName || 'User',
            user.email || ''
          ).catch((e) => console.error(e));
        }
      }

      triggerHaptic('success');
      setCompletedSummary({
        total: snapshotTotal,
        units: snapshotUnits,
        itemsCount: snapshotItemsCount,
        isEdit: snapshotIsEdit,
        isHold: isHoldOrder,
        customerName: holdOptions?.customerName?.trim() || undefined,
        linkedToOtherCosts: Boolean(isHoldOrder && holdOptions?.linkToOtherCosts),
      });
      setIsSuccess(true);
      setIsSubmitting(false);

      setTimeout(() => {
        clearCart();
        setCheckoutInProgress(false);
        setIsSuccess(false);
        navigate('/');
      }, 1150);
    } catch (e: any) {
      console.error('Checkout failed:', e);
      triggerHaptic('error');
      setCheckoutInProgress(false);
      isSubmittingOrSuccessRef.current = false;
      setErrorMessage(e?.isInsufficientStock ? e.message : `Checkout failed: ${e.message || e}`);
      setIsSubmitting(false);
    }
  };

  const pageTransition = useOptimizedTransition({ duration: 0.35, ease: [0.16, 1, 0.3, 1] });
  const gpuClass = useHardwareAcceleration();

  return (
    <>
      <motion.div
        initial={{ opacity: 0, scale: 0.98 }}
        animate={{ opacity: 1, scale: 1 }}
        exit={{ opacity: 0, scale: 0.95 }}
        transition={pageTransition}
        className={`min-h-full h-full flex flex-col pb-2 px-4 pt-10 w-full max-w-lg md:max-w-2xl mx-auto ${gpuClass}`}
      >
        <header className="mb-5 pl-1 flex justify-between items-center shrink-0">
          <div>
            <h1 className="text-3xl font-extrabold tracking-tight text-slate-900 dark:text-slate-100 flex items-center gap-2.5">
              <span>Order <span className="text-indigo-600 dark:text-indigo-400">Checkout</span></span>
            </h1>
            <p className="text-[13px] leading-snug text-slate-500 dark:text-slate-400 font-medium mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5">
              {editingBill ? (
                <>
                  <span className="font-semibold text-amber-600 dark:text-amber-400">
                    Modifying Bill #{editingBill.id?.slice(-5)}
                  </span>
                  <span className="text-slate-300 dark:text-slate-700">•</span>
                  <span className="font-semibold text-slate-700 dark:text-slate-300 tabular-nums">
                    {totalUnits} {totalUnits === 1 ? 'unit' : 'units'}
                  </span>
                </>
              ) : cart.length > 0 ? (
                <>
                  <span>Active order summary</span>
                  <span className="text-slate-300 dark:text-slate-700">•</span>
                  <span className="font-semibold text-indigo-600 dark:text-indigo-400 tabular-nums">
                    {cart.length} {cart.length === 1 ? 'item' : 'items'} ({totalUnits} {totalUnits === 1 ? 'unit' : 'units'})
                  </span>
                </>
              ) : (
                <span>Review selected items & confirm billing</span>
              )}
            </p>
          </div>
          <ProfileMenu />
        </header>

        <div className="flex-1 min-h-0 w-full relative flex flex-col">
          <AnimatePresence mode="wait">
            {cart.length === 0 && !isSuccess ? (
              <motion.div
                key="empty-cart"
                initial={{ opacity: 0, scale: 0.96 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 0.96 }}
                className="glass-card flex-1 flex flex-col items-center justify-center p-8 text-center text-slate-500 dark:text-slate-400 gap-3"
              >
                <div className="w-16 h-16 rounded-2xl bg-slate-100 dark:bg-slate-800/80 flex items-center justify-center text-slate-400 dark:text-slate-500 mb-1">
                  <ShoppingCart size={32} />
                </div>
                <p className="text-base font-bold text-slate-800 dark:text-slate-200">
                  Your billing cart is empty
                </p>
                <p className="text-xs text-slate-500 dark:text-slate-400 max-w-xs">
                  Select products from the POS screen to build a customer bill.
                </p>

                <div className="flex items-center gap-3 mt-3">
                  <motion.button
                    whileTap={{ scale: 0.96 }}
                    onClick={() => {
                      triggerHaptic('selection');
                      navigate('/');
                    }}
                    className="px-5 py-2.5 bg-indigo-600 hover:bg-indigo-700 text-white text-xs font-bold rounded-full flex items-center gap-2 shadow-sm shadow-indigo-600/20 transition-colors"
                  >
                    <ArrowLeft size={15} />
                    <span>Browse POS Items</span>
                  </motion.button>

                  {editingBill && (
                    <motion.button
                      whileTap={{ scale: 0.96 }}
                      onClick={handleCancelEdit}
                      className="px-5 py-2.5 bg-slate-200 dark:bg-slate-800 text-slate-700 dark:text-slate-300 text-xs font-bold rounded-full flex items-center justify-center transition-colors"
                    >
                      Cancel Edit
                    </motion.button>
                  )}
                </div>
              </motion.div>
            ) : (
              <motion.div
                key="cart-list"
                initial={{ opacity: 0, scale: 0.97 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 0.97 }}
                className="glass-panel p-4 sm:p-5 rounded-[2rem] relative z-10 flex flex-col min-h-0 flex-1"
              >
                <div className="flex items-center justify-between gap-3 mb-3.5 px-1 shrink-0 border-b border-slate-200/70 dark:border-slate-800/90 pb-3.5">
                  <div className="flex flex-col gap-0.5 min-w-0">
                    <h2 className="text-[11px] font-extrabold uppercase tracking-widest text-slate-400 dark:text-slate-400 leading-tight">
                      Order Summary
                    </h2>
                    <div className="flex items-center gap-1.5 text-xs font-bold text-slate-700 dark:text-slate-200 font-mono tabular-nums leading-tight">
                      <span>
                        {totalUnits} {totalUnits === 1 ? 'unit' : 'units'}
                      </span>
                      <span className="text-slate-300 dark:text-slate-600">·</span>
                      <span className="text-slate-500 dark:text-slate-400 font-sans font-semibold">
                        {cart.length} {cart.length === 1 ? 'item' : 'items'}
                      </span>
                    </div>
                  </div>
                  <div className="flex items-center gap-2.5 shrink-0">
                    {!editingBill && (
                      <button
                        type="button"
                        onClick={() => {
                          clearCart();
                        }}
                        className="text-xs font-bold text-red-500 hover:text-red-600 dark:text-red-400 flex items-center gap-1 px-2.5 py-1.5 rounded-xl bg-red-50/80 dark:bg-red-500/10 hover:bg-red-100/80 dark:hover:bg-red-500/20 border border-red-200/50 dark:border-red-500/15 transition-colors shrink-0"
                      >
                        <Trash2 size={13} />
                        <span>Clear</span>
                      </button>
                    )}
                    <span className="text-indigo-600 dark:text-indigo-400 font-mono tabular-nums text-lg sm:text-xl font-extrabold tracking-tight leading-none">
                      ₹{formatPrice(totalAmount)}
                    </span>
                  </div>
                </div>

                <div className="flex-1 min-h-0 overflow-y-auto mb-2 space-y-2.5 p-1 -mx-1 custom-scrollbar">
                  {cart.map((item, idx) => {
                    const prodId = item.product.id || `idx_${idx}`;
                    const imgUrl = item.product.image ? getImageUrl(item.product.image) : null;
                    const liveProd = products.find((p) => p.id === item.product.id);
                    const originalItem = editingBill?.items.find((i) => i.productId === item.product.id);
                    const originalQty = originalItem ? Number(originalItem.quantity || 0) : 0;
                    const reservedByOther = item.product.id
                      ? Math.max(0, Number(reservedByOthers[item.product.id]) || 0)
                      : 0;
                    const maxAvailable = Math.max(
                      0,
                      (Number(liveProd?.stock ?? item.product.stock) || 0) + originalQty - reservedByOther
                    );
                    const isEditingQty = Object.prototype.hasOwnProperty.call(editingQuantities, prodId);
                    const isEditingPrice = Object.prototype.hasOwnProperty.call(editingPrices, prodId);

                    return (
                      <div
                        key={item.product.id ? `cart_${item.product.id}` : `cart_item_${idx}`}
                        className="flex justify-between items-center gap-2.5 sm:gap-3 bg-white/75 dark:bg-slate-850/80 p-2.5 sm:p-3 rounded-2xl text-slate-800 dark:text-slate-100 border border-slate-200/70 dark:border-slate-800 shadow-xs"
                      >
                        <div className="flex items-center gap-2.5 sm:gap-3 min-w-0 flex-1 overflow-hidden">
                          <div className="w-12 h-12 sm:w-14 sm:h-14 shrink-0 rounded-xl overflow-hidden relative border border-slate-200/60 dark:border-slate-700/60 bg-slate-50 dark:bg-slate-900/50">
                            {imgUrl ? (
                              <img
                                src={imgUrl}
                                alt={item.product.name}
                                referrerPolicy="no-referrer"
                                className="w-full h-full object-cover"
                              />
                            ) : (
                              <ProductImagePlaceholder
                                category={item.product.category}
                                name={item.product.name}
                                size={22}
                                className="w-full h-full"
                                rounded="rounded-xl"
                                showBorder={false}
                                showShadow={false}
                              />
                            )}
                          </div>
                          <div className="min-w-0 flex-1 flex flex-col justify-center">
                            <span className="font-bold text-slate-900 dark:text-slate-100 truncate text-sm sm:text-[15px] leading-snug">
                              {item.product.name}
                            </span>
                            <div className="flex items-center gap-1 mt-1">
                              <span className="font-mono text-indigo-600 dark:text-indigo-400 text-xs font-bold shrink-0">
                                ₹
                              </span>
                              <input
                                type="text"
                                inputMode="decimal"
                                aria-label={`${item.product.name} unit price`}
                                placeholder={String(item.product.price ?? 0)}
                                value={
                                  isEditingPrice
                                    ? editingPrices[prodId]
                                    : item.product.price === 0
                                    ? '0'
                                    : String(item.product.price || '')
                                }
                                onFocus={() => {
                                  setEditingPrices((prev) => ({ ...prev, [prodId]: '' }));
                                }}
                                onChange={(e) => {
                                  const raw = e.target.value.replace(/[^0-9.]/g, '');
                                  const val = parseFloat(raw);
                                  if (!isNaN(val) && val >= 0) {
                                    const otherTotal = cart.reduce(
                                      (sum, c) =>
                                        c.product.id === item.product.id
                                          ? sum
                                          : sum + (Number(c.product.price) || 0) * (Number(c.quantity) || 0),
                                      0
                                    );
                                    const itemQty = Math.max(1, Number(item.quantity) || 1);
                                    const maxUnitPrice = Math.max(
                                      0,
                                      Math.floor(((MAX_BILL_AMOUNT - otherTotal) / itemQty) * 100) / 100
                                    );
                                    const clampedPrice = Math.min(val, maxUnitPrice);
                                    if (val > maxUnitPrice) {
                                      triggerHaptic('warning');
                                      window.dispatchEvent(
                                        new CustomEvent('maxBillLimitReached', { detail: { max: MAX_BILL_AMOUNT } })
                                      );
                                    }
                                    setEditingPrices((prev) => ({
                                      ...prev,
                                      [prodId]: val > maxUnitPrice ? String(clampedPrice) : raw,
                                    }));
                                    setPrice(item.product.id!, clampedPrice);
                                  } else {
                                    setEditingPrices((prev) => ({ ...prev, [prodId]: raw }));
                                  }
                                }}
                                onBlur={() => {
                                  setEditingPrices((prev) => {
                                    const next = { ...prev };
                                    delete next[prodId];
                                    return next;
                                  });
                                }}
                                onKeyDown={(e) => {
                                  if (e.key === 'Enter') {
                                    e.currentTarget.blur();
                                  }
                                }}
                                className="w-14 sm:w-16 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 font-mono tabular-nums text-xs font-bold text-indigo-600 dark:text-indigo-400 placeholder:text-indigo-300 dark:placeholder:text-indigo-500/40 focus:outline-none focus:ring-2 focus:ring-indigo-500/40 rounded-lg px-2 py-1 [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none transition-all"
                              />
                            </div>
                          </div>
                        </div>

                        {/* Ergonomic Stepper Controls */}
                        <div className="flex items-center gap-1 bg-slate-100/90 dark:bg-slate-900/80 p-1 rounded-2xl border border-slate-200/70 dark:border-slate-800 shrink-0 select-none">
                          <motion.button
                            type="button"
                            aria-label="Decrease quantity"
                            whileTap={{ scale: 0.88 }}
                            onContextMenu={(e) => e.preventDefault()}
                            onPointerDown={(e) => startMinusHold(e, item.product.id, prodId)}
                            onPointerMove={moveHold}
                            onPointerUp={endHold}
                            onPointerCancel={endHold}
                            onPointerLeave={endHold}
                            onClick={() => {
                              if (holdTriggeredRef.current) {
                                holdTriggeredRef.current = false;
                                return;
                              }
                              clearDraftQty(prodId);
                              removeFromCart(item.product.id!, 1);
                            }}
                            className="w-8 h-8 sm:w-9 sm:h-9 flex items-center justify-center text-slate-700 hover:text-slate-950 dark:text-slate-300 dark:hover:text-white transition-colors rounded-xl bg-white dark:bg-slate-800 shadow-xs active:bg-slate-100 select-none"
                          >
                            <Minus size={14} strokeWidth={2.5} />
                          </motion.button>
                          <input
                            type="text"
                            inputMode="numeric"
                            pattern="[0-9]*"
                            aria-label={`${item.product.name} quantity`}
                            placeholder={String(item.quantity)}
                            value={isEditingQty ? editingQuantities[prodId] : String(item.quantity)}
                            onFocus={() => {
                              setEditingQuantities((prev) => ({
                                ...prev,
                                [prodId]: '',
                              }));
                            }}
                            onChange={(e) => {
                              const digitsOnly = e.target.value.replace(/[^0-9]/g, '');
                              if (digitsOnly === '') {
                                setEditingQuantities((prev) => ({
                                  ...prev,
                                  [prodId]: '',
                                }));
                                return;
                              }
                              const val = parseInt(digitsOnly, 10);
                              if (isNaN(val)) return;
                              if (val === 0) {
                                setEditingQuantities((prev) => ({
                                  ...prev,
                                  [prodId]: '0',
                                }));
                                return;
                              }
                              let capped =
                                maxAvailable > 0 ? Math.min(val, maxAvailable) : val;
                              const unitPrice = Math.max(0, Number(item.product.price) || 0);
                              if (unitPrice > 0) {
                                const otherTotal = cart.reduce(
                                  (sum, c) =>
                                    c.product.id === item.product.id
                                      ? sum
                                      : sum + (Number(c.product.price) || 0) * (Number(c.quantity) || 0),
                                  0
                                );
                                const maxByBill = Math.max(
                                  0,
                                  Math.floor((MAX_BILL_AMOUNT - otherTotal + 1e-6) / unitPrice)
                                );
                                if (val > maxByBill || otherTotal + val * unitPrice > MAX_BILL_AMOUNT) {
                                  capped = Math.min(capped, maxByBill);
                                  triggerHaptic('warning');
                                  window.dispatchEvent(
                                    new CustomEvent('maxBillLimitReached', {
                                      detail: {
                                        max: MAX_BILL_AMOUNT,
                                        message: 'Cannot add more than ₹10,000 value in cart.',
                                      },
                                    })
                                  );
                                }
                              }
                              if (maxAvailable > 0 && val > maxAvailable) {
                                triggerHaptic('warning');
                              }
                              setEditingQuantities((prev) => ({
                                ...prev,
                                [prodId]: String(capped),
                              }));
                              setQuantity(item.product.id!, capped);
                            }}
                            onBlur={() => {
                              const draft = editingQuantities[prodId];
                              setEditingQuantities((prev) => {
                                const next = { ...prev };
                                delete next[prodId];
                                return next;
                              });
                              if (draft === '0') {
                                setQuantity(item.product.id!, 0);
                              }
                            }}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') {
                                e.currentTarget.blur();
                              }
                            }}
                            className="w-9 sm:w-10 bg-transparent text-center font-extrabold text-xs sm:text-sm font-mono tabular-nums text-slate-900 dark:text-slate-100 placeholder:text-slate-400/60 dark:placeholder:text-slate-500/60 focus:outline-none focus:ring-2 focus:ring-indigo-500/40 rounded-lg py-1 [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
                          />
                          <motion.button
                            type="button"
                            aria-label="Increase quantity"
                            whileTap={{ scale: 0.88 }}
                            onContextMenu={(e) => e.preventDefault()}
                            onPointerDown={(e) =>
                              startPlusHold(
                                e,
                                item.product,
                                prodId,
                                maxAvailable > 0 && item.quantity >= maxAvailable
                              )
                            }
                            onPointerMove={moveHold}
                            onPointerUp={endHold}
                            onPointerCancel={endHold}
                            onPointerLeave={endHold}
                            onClick={() => {
                              if (holdTriggeredRef.current) {
                                holdTriggeredRef.current = false;
                                return;
                              }
                              clearDraftQty(prodId);
                              const unitPrice = Math.max(0, Number(item.product.price) || 0);
                              if (unitPrice > 0 && totalAmount + unitPrice > MAX_BILL_AMOUNT) {
                                triggerHaptic('warning');
                                window.dispatchEvent(
                                  new CustomEvent('maxBillLimitReached', {
                                    detail: {
                                      max: MAX_BILL_AMOUNT,
                                      message: 'Cannot add more than ₹10,000 value in cart.',
                                    },
                                  })
                                );
                              } else if (maxAvailable > 0 && item.quantity >= maxAvailable) {
                                triggerHaptic('warning');
                              } else {
                                addToCart(item.product, 1);
                              }
                            }}
                            className="w-8 h-8 sm:w-9 sm:h-9 flex items-center justify-center text-slate-700 hover:text-slate-950 dark:text-slate-300 dark:hover:text-white transition-colors rounded-xl bg-white dark:bg-slate-800 shadow-xs active:bg-slate-100 select-none"
                          >
                            <Plus size={14} strokeWidth={2.5} />
                          </motion.button>
                        </div>
                      </div>
                    );
                  })}
                </div>

                <div className="shrink-0 pt-3 border-t border-slate-200/70 dark:border-slate-800 flex flex-col gap-2">
                  <div className="grid grid-cols-1 sm:grid-cols-12 gap-2">
                    <motion.button
                      type="button"
                      whileTap={{ scale: 0.97 }}
                      onClick={openHoldModal}
                      disabled={isSubmitting}
                      className="sm:col-span-5 h-12 sm:h-13 px-3.5 bg-amber-500/12 hover:bg-amber-500/20 dark:bg-amber-500/15 dark:hover:bg-amber-500/25 text-amber-700 dark:text-amber-300 border border-amber-500/30 font-bold rounded-2xl flex justify-center items-center gap-2 transition-colors text-xs sm:text-sm disabled:opacity-50 cursor-pointer"
                    >
                      <User size={16} className="shrink-0" />
                      <span className="truncate">
                        {editingBill?.isUdhar && editingBill?.customerName
                          ? `Udhar: ${editingBill.customerName}`
                          : 'Put on Udhar'}
                      </span>
                    </motion.button>

                    <motion.button
                      type="button"
                      whileTap={{ scale: 0.97 }}
                      onClick={() => handleCheckout()}
                      disabled={isSubmitting}
                      className="sm:col-span-7 h-12 sm:h-13 bg-indigo-600 hover:bg-indigo-700 dark:bg-indigo-600 dark:hover:bg-indigo-500 text-white font-bold rounded-2xl flex justify-center items-center gap-2 transition-all shadow-lg shadow-indigo-600/25 text-sm sm:text-base disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer"
                    >
                      {isSubmitting ? (
                        <span className="w-5 h-5 border-2 border-white border-t-transparent rounded-full animate-spin" />
                      ) : (
                        <>
                          <span>{editingBill ? 'Mark Paid & Save' : 'Collect Payment'}</span>
                          <span>·</span>
                          <span className="font-mono tabular-nums font-extrabold">
                            ₹{formatPrice(totalAmount)}
                          </span>
                        </>
                      )}
                    </motion.button>
                  </div>

                  {editingBill && (
                    <motion.button
                      whileTap={{ scale: 0.97 }}
                      onClick={handleCancelEdit}
                      disabled={isSubmitting}
                      className="w-full h-10 bg-slate-100 dark:bg-slate-800/60 text-slate-600 dark:text-slate-300 font-bold rounded-xl flex justify-center items-center transition-colors hover:bg-slate-200 dark:hover:bg-slate-800 text-xs border border-slate-200/60 dark:border-slate-700/60 disabled:opacity-50"
                    >
                      Cancel Edit & Restore Bill
                    </motion.button>
                  )}
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </motion.div>

      {createPortal(
        <AnimatePresence>
          {isSuccess && (
            <motion.div
              key="checkout-success-modal"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.18 }}
              className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-slate-950/60 dark:bg-slate-950/80 backdrop-blur-md"
            >
              <motion.div
                initial={{ scale: 0.88, opacity: 0, y: 18 }}
                animate={{ scale: 1, opacity: 1, y: 0 }}
                exit={{ scale: 0.92, opacity: 0, y: 10 }}
                transition={{ type: 'spring', stiffness: 400, damping: 28, mass: 0.75 }}
                className="w-full max-w-[290px] bg-white dark:bg-[#151822] border border-slate-200/90 dark:border-white/[0.08] p-6 rounded-[2rem] shadow-2xl flex flex-col items-center text-center relative overflow-hidden"
              >
                {/* Animated Checkmark Ring */}
                <motion.div
                  initial={{ scale: 0.5, opacity: 0 }}
                  animate={{ scale: 1, opacity: 1 }}
                  transition={{ type: 'spring', stiffness: 420, damping: 22, delay: 0.05 }}
                  className="w-16 h-16 rounded-full bg-emerald-500/12 dark:bg-emerald-500/15 border border-emerald-500/25 flex items-center justify-center mb-4"
                >
                  <svg
                    viewBox="0 0 24 24"
                    fill="none"
                    className="w-8 h-8 text-emerald-500 dark:text-emerald-400"
                  >
                    <motion.path
                      d="M5 13l4 4L19 7"
                      stroke="currentColor"
                      strokeWidth={3}
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      initial={{ pathLength: 0 }}
                      animate={{ pathLength: 1 }}
                      transition={{ duration: 0.38, ease: 'easeOut', delay: 0.12 }}
                    />
                  </svg>
                </motion.div>

                <h2 className="text-lg font-extrabold tracking-tight text-slate-900 dark:text-white">
                  {completedSummary?.isHold
                    ? 'Placed on Udhar'
                    : completedSummary?.isEdit
                    ? 'Bill Updated'
                    : 'Payment Recorded'}
                </h2>
                <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5 font-medium">
                  {completedSummary?.isHold
                    ? `${completedSummary.customerName || 'Customer Udhar'}${
                        completedSummary.linkedToOtherCosts ? ' · Linked to Other Costs' : ''
                      }`
                    : completedSummary
                    ? `${completedSummary.itemsCount} ${
                        completedSummary.itemsCount === 1 ? 'item' : 'items'
                      } · ${completedSummary.units} ${
                        completedSummary.units === 1 ? 'unit' : 'units'
                      } billed`
                    : 'Transaction saved to ledger'}
                </p>

                {completedSummary && (
                  <div className="mt-4 w-full py-2.5 px-4 rounded-2xl bg-slate-50 dark:bg-slate-900/90 border border-slate-200/70 dark:border-white/[0.06] flex items-center justify-between">
                    <span className="text-[11px] font-bold uppercase tracking-wider text-slate-400 dark:text-slate-500">
                      {completedSummary.isHold ? 'Udhar / Unpaid' : 'Collected'}
                    </span>
                    <span
                      className={`text-lg font-extrabold font-mono tabular-nums ${
                        completedSummary.isHold
                          ? 'text-amber-600 dark:text-amber-400'
                          : 'text-emerald-600 dark:text-emerald-400'
                      }`}
                    >
                      ₹{formatPrice(completedSummary.total)}
                    </span>
                  </div>
                )}

                {/* Smooth Auto-Close Progress Bar */}
                <div className="w-full h-1 bg-slate-100 dark:bg-slate-800 rounded-full overflow-hidden mt-5">
                  <motion.div
                    initial={{ width: '0%' }}
                    animate={{ width: '100%' }}
                    transition={{ duration: 1.05, ease: 'linear' }}
                    className={`h-full rounded-full ${
                      completedSummary?.isHold
                        ? 'bg-amber-500 dark:bg-amber-400'
                        : 'bg-emerald-500 dark:bg-emerald-400'
                    }`}
                  />
                </div>
              </motion.div>
            </motion.div>
          )}
          {showHoldModal && (
            <motion.div
              key="udhaar-hold-modal"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-slate-950/60 dark:bg-slate-950/80 backdrop-blur-md"
            >
              <motion.div
                initial={{ scale: 0.94, opacity: 0, y: 12 }}
                animate={{ scale: 1, opacity: 1, y: 0 }}
                exit={{ scale: 0.94, opacity: 0, y: 10 }}
                transition={{ type: 'spring', stiffness: 380, damping: 28 }}
                className="w-full max-w-md bg-white dark:bg-[#151822] border border-slate-200/90 dark:border-white/[0.08] p-5 sm:p-6 rounded-[2rem] shadow-2xl relative z-10 max-h-[90vh] overflow-y-auto"
              >
                <div className="flex items-center justify-between pb-3.5 mb-4 border-b border-slate-100 dark:border-white/[0.06]">
                  <div className="flex items-center gap-2.5">
                    <div className="w-9 h-9 rounded-xl bg-amber-500/15 text-amber-600 dark:text-amber-400 flex items-center justify-center">
                      <User size={19} />
                    </div>
                    <div>
                      <h3 className="text-base font-extrabold text-slate-900 dark:text-white leading-tight">
                        Put on Udhar
                      </h3>
                      <p className="text-[11px] text-slate-500 dark:text-slate-400 font-medium">
                        Unpaid amount:{' '}
                        <span className="font-mono font-bold text-amber-600 dark:text-amber-400">
                          ₹{formatPrice(totalAmount)}
                        </span>
                      </p>
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => setShowHoldModal(false)}
                    className="w-8 h-8 rounded-full bg-slate-100 dark:bg-slate-800 flex items-center justify-center text-slate-500 dark:text-slate-400 hover:bg-slate-200 dark:hover:bg-slate-700 transition-colors cursor-pointer"
                  >
                    <X size={16} />
                  </button>
                </div>

                <div className="space-y-3">
                  <div>
                    <label className="block text-[11px] font-bold text-slate-600 dark:text-slate-300 mb-1">
                      Customer Name (Required)
                    </label>
                    <div className="relative">
                      <User
                        size={15}
                        className="absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-400"
                      />
                      <input
                        ref={customerNameInputRef}
                        type="text"
                        required
                        value={customerName}
                        onChange={(e) => {
                          setCustomerName(e.target.value);
                          if (udhaarError) setUdhaarError("");
                        }}
                        placeholder="e.g. Rahul Sharma"
                        className={`w-full pl-9 pr-3.5 py-2.5 rounded-xl bg-slate-50 dark:bg-slate-900 border ${
                          udhaarError
                            ? 'border-red-500 focus:ring-red-500/40'
                            : 'border-slate-200 dark:border-slate-800 focus:ring-amber-500/40'
                        } text-xs font-bold text-slate-900 dark:text-white placeholder:text-slate-400 focus:outline-none focus:ring-2`}
                      />
                    </div>
                    {udhaarError && (
                      <p className="mt-1.5 text-[11px] font-bold text-red-500 dark:text-red-400">
                        {udhaarError}
                      </p>
                    )}
                  </div>

                  <div>
                    <label className="block text-[11px] font-bold text-slate-600 dark:text-slate-300 mb-1">
                      Phone Number (Optional)
                    </label>
                    <div className="relative">
                      <Phone
                        size={15}
                        className="absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-400"
                      />
                      <input
                        type="tel"
                        inputMode="tel"
                        value={customerPhone}
                        onChange={(e) => setCustomerPhone(e.target.value.replace(/[^0-9+\-\s]/g, ''))}
                        placeholder="e.g. 9876543210"
                        className="w-full pl-9 pr-3.5 py-2.5 rounded-xl bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-800 text-xs font-mono font-bold text-slate-900 dark:text-white placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-amber-500/40"
                      />
                    </div>
                  </div>

                  <div>
                    <label className="block text-[11px] font-bold text-slate-600 dark:text-slate-300 mb-1">
                      Udhar Note (Optional)
                    </label>
                    <div className="relative">
                      <FileText
                        size={15}
                        className="absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-400"
                      />
                      <input
                        type="text"
                        value={udhaarNote}
                        onChange={(e) => setUdhaarNote(e.target.value)}
                        placeholder="e.g. Will pay on Friday evening"
                        className="w-full pl-9 pr-3.5 py-2.5 rounded-xl bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-800 text-xs font-semibold text-slate-900 dark:text-white placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-amber-500/40"
                      />
                    </div>
                  </div>
                </div>

                <div className="flex items-center gap-2.5 mt-5">
                  <button
                    type="button"
                    onClick={() => {
                      setUdhaarError("");
                      setShowHoldModal(false);
                    }}
                    className="flex-1 py-3 rounded-xl bg-slate-100 hover:bg-slate-200 dark:bg-slate-800 dark:hover:bg-slate-700 text-slate-700 dark:text-slate-300 text-xs font-bold transition-colors cursor-pointer"
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      const trimmedName = customerName.trim();
                      if (!trimmedName) {
                        triggerHaptic('error');
                        setUdhaarError("Customer name is required to put a bill on Udhar.");
                        customerNameInputRef.current?.focus();
                        return;
                      }
                      handleCheckout({
                        isHold: true,
                        customerName: trimmedName,
                        customerPhone: customerPhone.trim(),
                        udhaarNote: udhaarNote.trim(),
                        linkToOtherCosts: true,
                        costCategory: 'borrow',
                      });
                    }}
                    className="flex-[1.5] py-3 rounded-xl bg-amber-500 hover:bg-amber-600 text-white text-xs font-extrabold shadow-md shadow-amber-500/20 transition-colors cursor-pointer"
                  >
                    Confirm Udhar · ₹{formatPrice(totalAmount)}
                  </button>
                </div>
              </motion.div>
            </motion.div>
          )}
          {errorMessage && (
            <div
              key="checkout-error-modal"
              className="fixed inset-0 z-[100] flex items-center justify-center p-4"
            >
              <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                onClick={() => setErrorMessage("")}
                className="absolute inset-0 bg-slate-900/40 backdrop-blur-sm"
              />
              <motion.div
                initial={{ scale: 0.9, opacity: 0 }}
                animate={{ scale: 1, opacity: 1 }}
                exit={{ scale: 0.9, opacity: 0 }}
                className="glass-panel w-full max-w-sm p-6 relative z-10 text-center rounded-[2rem]"
              >
                <div className="w-12 h-12 bg-red-50 dark:bg-red-500/10 text-red-500 rounded-full flex items-center justify-center mx-auto mb-3 font-bold text-xl">
                  !
                </div>
                <h3 className="text-base font-extrabold text-slate-900 dark:text-white mb-2">
                  Checkout Notice
                </h3>
                <p className="text-xs text-slate-500 dark:text-slate-400 mb-5 leading-relaxed">
                  {errorMessage}
                </p>
                <button
                  onClick={() => {
                    triggerHaptic('light');
                    setErrorMessage("");
                  }}
                  className="w-full py-3 bg-indigo-600 hover:bg-indigo-700 text-white font-bold rounded-xl text-xs"
                >
                  Dismiss
                </button>
              </motion.div>
            </div>
          )}
        </AnimatePresence>,
        document.body
      )}
    </>
  );
}
