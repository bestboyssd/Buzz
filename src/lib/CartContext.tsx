import React, { createContext, useContext, useState, useMemo, useEffect, useRef, ReactNode } from 'react';
import { doc, onSnapshot, updateDoc, setDoc, deleteField } from 'firebase/firestore';
import { db } from './firebase';
import { useAuth } from './AuthContext';
import { useGlobalProducts } from './ProductsContext';
import { Product, Bill } from './firestoreHooks';
import { triggerHaptic } from './haptics';
import { MAX_BILL_AMOUNT } from './utils';

export interface CartItem {
  product: Product;
  quantity: number;
}

interface ActiveCartSession {
  uid?: string;
  userName?: string;
  startedAt?: number;
  updatedAt: number;
  items: Record<string, number>;
}

interface CartContextType {
  cart: CartItem[];
  addToCart: (product: Product, amount?: number) => void;
  removeFromCart: (productId: string, amount?: number) => void;
  setQuantity: (productId: string, quantity: number) => void;
  setPrice: (productId: string, price: number) => void;
  clearCart: () => void;
  setCart: React.Dispatch<React.SetStateAction<CartItem[]>>;
  totalAmount: number;
  editingBill: Bill | null;
  setEditingBill: React.Dispatch<React.SetStateAction<Bill | null>>;
  reservedByOthers: Record<string, number>;
  setCheckoutInProgress: (active: boolean) => void;
}

const CartContext = createContext<CartContextType | null>(null);

const CART_RESERVATION_TTL_MS = 5 * 60 * 1000; // 5 minutes TTL for inactive carts

const getOrCreateCartSessionId = (): string => {
  if (typeof window === 'undefined') return 'server_session';
  try {
    let sid =
      localStorage.getItem('pos_cart_session_id') ||
      sessionStorage.getItem('pos_cart_session_id');
    if (!sid) {
      sid = `sess_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    }
    localStorage.setItem('pos_cart_session_id', sid);
    sessionStorage.setItem('pos_cart_session_id', sid);
    return sid;
  } catch {
    return `sess_${Date.now().toString(36)}`;
  }
};

const notifyMaxBillLimitReached = (message?: string) => {
  if (typeof window !== 'undefined') {
    window.setTimeout(() => {
      window.dispatchEvent(
        new CustomEvent('maxBillLimitReached', {
          detail: {
            max: MAX_BILL_AMOUNT,
            message: message || 'Maximum cart value is ₹10,000.',
          },
        })
      );
    }, 0);
  }
};

export const CartProvider = ({ children }: { children: ReactNode }) => {
  const [cart, setCart] = useState<CartItem[]>([]);
  const [editingBill, setEditingBill] = useState<Bill | null>(null);
  const [remoteSessions, setRemoteSessions] = useState<Record<string, ActiveCartSession>>({});
  const [nowTick, setNowTick] = useState<number>(() => Date.now());

  const { user } = useAuth();
  const { products } = useGlobalProducts('');

  const sessionIdRef = useRef<string>(getOrCreateCartSessionId());
  const sessionStartedAtRef = useRef<number>(Date.now());
  const isCheckingOutRef = useRef<boolean>(false);
  const productsRef = useRef<Product[]>(products);
  productsRef.current = products;

  const setCheckoutInProgress = (active: boolean) => {
    isCheckingOutRef.current = active;
  };

  // Listen to real-time active cart reservations across all connected devices
  useEffect(() => {
    if (!user) {
      setRemoteSessions({});
      return;
    }

    const activeCartsRef = doc(db, 'settings', 'active_carts');
    const unsubscribe = onSnapshot(
      activeCartsRef,
      (snap) => {
        if (!snap.exists()) {
          setRemoteSessions({});
          return;
        }
        const data = snap.data();
        const sessions = (data?.sessions && typeof data.sessions === 'object')
          ? (data.sessions as Record<string, ActiveCartSession>)
          : {};
        setRemoteSessions(sessions);
      },
      (err) => {
        console.debug('Active carts sync listener warning:', err);
      }
    );

    const expireInterval = window.setInterval(() => {
      setNowTick(Date.now());
    }, 15000);

    return () => {
      unsubscribe();
      window.clearInterval(expireInterval);
    };
  }, [user?.uid]);

  // Compute how many units of each product are reserved by OTHER active users' carts
  const reservedByOthers = useMemo(() => {
    const map: Record<string, number> = {};
    const mySid = sessionIdRef.current;
    const myUid = user?.uid;
    const now = Date.now();

    for (const [sid, session] of Object.entries(remoteSessions)) {
      if (sid === mySid || !session) continue;
      if (myUid && session.uid && session.uid === myUid) continue;
      const updatedAt = Number(session.updatedAt) || 0;
      if (now - updatedAt > CART_RESERVATION_TTL_MS) continue;
      const items = session.items || {};
      for (const [productId, qty] of Object.entries(items)) {
        const safeQty = Math.max(0, Math.floor(Number(qty) || 0));
        if (safeQty > 0) {
          map[productId] = (map[productId] || 0) + safeQty;
        }
      }
    }
    return map;
  }, [remoteSessions, nowTick, user?.uid]);

  const reservedByOthersRef = useRef<Record<string, number>>(reservedByOthers);
  reservedByOthersRef.current = reservedByOthers;

  // Helper to push our current cart holds to Firestore in real-time
  const syncMyCartToCloud = (currentCart: CartItem[], currentEditingBill: Bill | null) => {
    if (!user) return;
    const mySid = sessionIdRef.current;
    const activeCartsRef = doc(db, 'settings', 'active_carts');

    const cleanupPayload: Record<string, any> = {};
    for (const [sid, sess] of Object.entries(remoteSessions)) {
      if (sid !== mySid && sess?.uid === user.uid) {
        cleanupPayload[`sessions.${sid}`] = deleteField();
      }
    }

    const heldItems: Record<string, number> = {};
    for (const item of currentCart) {
      const pid = item.product.id;
      if (!pid) continue;
      const origItem = currentEditingBill?.items.find((i) => i.productId === pid);
      const origQty = origItem ? Math.max(0, Number(origItem.quantity) || 0) : 0;
      const netHold = Math.max(0, Math.floor(Number(item.quantity) || 0) - origQty);
      if (netHold > 0) {
        heldItems[pid] = netHold;
      }
    }

    if (Object.keys(heldItems).length === 0) {
      sessionStartedAtRef.current = Date.now();
      updateDoc(activeCartsRef, {
        ...cleanupPayload,
        [`sessions.${mySid}`]: deleteField(),
      }).catch(() => {});
    } else {
      const sessionPayload: ActiveCartSession = {
        uid: user.uid,
        userName: user.displayName || 'User',
        startedAt: sessionStartedAtRef.current,
        updatedAt: Date.now(),
        items: heldItems,
      };
      updateDoc(activeCartsRef, {
        ...cleanupPayload,
        [`sessions.${mySid}`]: sessionPayload,
      }).catch(() => {
        setDoc(
          activeCartsRef,
          { sessions: { [mySid]: sessionPayload } },
          { merge: true }
        ).catch(() => {});
      });
    }
  };

  // Sync cart changes to Firestore immediately and keep a heartbeat while items are in cart
  useEffect(() => {
    if (!user) return;
    if (cart.length === 1 && sessionStartedAtRef.current === 0) {
      sessionStartedAtRef.current = Date.now();
    }
    syncMyCartToCloud(cart, editingBill);

    if (cart.length === 0) return;
    const heartbeat = window.setInterval(() => {
      syncMyCartToCloud(cart, editingBill);
    }, 60000);

    return () => window.clearInterval(heartbeat);
  }, [cart, editingBill, user?.uid]);

  // Clear reservation on tab close / unload
  useEffect(() => {
    const handleUnload = () => {
      if (!user) return;
      const mySid = sessionIdRef.current;
      updateDoc(doc(db, 'settings', 'active_carts'), {
        [`sessions.${mySid}`]: deleteField(),
      }).catch(() => {});
    };
    window.addEventListener('pagehide', handleUnload);
    window.addEventListener('beforeunload', handleUnload);
    return () => {
      window.removeEventListener('pagehide', handleUnload);
      window.removeEventListener('beforeunload', handleUnload);
    };
  }, [user?.uid]);

  // Reconcile local cart if live database stock drops or if an earlier session reserved overlapping stock simultaneously
  useEffect(() => {
    if (cart.length === 0 || isCheckingOutRef.current) return;

    const mySid = sessionIdRef.current;
    const myUid = user?.uid;
    const mySession = remoteSessions[mySid];
    const myStart = Number(mySession?.startedAt || sessionStartedAtRef.current || Date.now());
    const now = Date.now();

    let adjustedProductNames: string[] = [];

    setCart((prev) => {
      if (prev.length === 0 || isCheckingOutRef.current) return prev;
      let changed = false;
      const next: CartItem[] = [];

      for (const item of prev) {
        const pid = item.product.id;
        if (!pid) {
          next.push(item);
          continue;
        }
        const liveProd = products.find((p) => p.id === pid);
        const baseStock = Math.max(0, Number(liveProd ? liveProd.stock : item.product.stock) || 0);
        const origItem = editingBill?.items.find((i) => i.productId === pid);
        const origQty = origItem ? Math.max(0, Number(origItem.quantity) || 0) : 0;

        // Calculate reservations from other users' sessions that started BEFORE (or tie-broken by sessionId) our session
        let prioritizedOtherHold = 0;
        for (const [sid, sess] of Object.entries(remoteSessions)) {
          if (sid === mySid || !sess) continue;
          if (myUid && sess.uid && sess.uid === myUid) continue;
          if (now - (Number(sess.updatedAt) || 0) > CART_RESERVATION_TTL_MS) continue;
          const otherQty = Math.max(0, Number(sess.items?.[pid]) || 0);
          if (otherQty <= 0) continue;
          const otherStart = Number(sess.startedAt || sess.updatedAt || 0);
          if (otherStart < myStart || (otherStart === myStart && sid < mySid)) {
            prioritizedOtherHold += otherQty;
          }
        }

        const maxAllowedForMe = Math.max(0, baseStock + origQty - prioritizedOtherHold);
        const updatedProductObj = liveProd ? { ...liveProd, price: item.product.price } : item.product;

        if (item.quantity > maxAllowedForMe) {
          changed = true;
          if (prioritizedOtherHold > 0) {
            adjustedProductNames.push(updatedProductObj.name);
          }
          if (maxAllowedForMe > 0) {
            next.push({ product: updatedProductObj, quantity: maxAllowedForMe });
          }
        } else if (liveProd && liveProd.stock !== item.product.stock) {
          changed = true;
          next.push({ product: updatedProductObj, quantity: item.quantity });
        } else {
          next.push(item);
        }
      }

      if (changed && adjustedProductNames.length > 0 && !isCheckingOutRef.current) {
        triggerHaptic('warning');
        notifyMaxBillLimitReached(
          `Stock for "${adjustedProductNames[0]}" was claimed by another user. Cart updated.`
        );
      }

      return changed ? next : prev;
    });
  }, [products, remoteSessions, editingBill, user?.uid]);

  const getMaxStockForProduct = (product: Product, productId?: string) => {
    const pid = productId || product.id || '';
    const liveProd = productsRef.current.find((p) => p.id === pid);
    const baseStock = Math.max(0, Number(liveProd ? liveProd.stock : product.stock) || 0);
    const originalItem = editingBill?.items.find((i) => i.productId === pid);
    const originalQty = originalItem ? Math.max(0, Number(originalItem.quantity || 0)) : 0;
    const otherReserved = pid ? (reservedByOthersRef.current[pid] || 0) : 0;
    return Math.max(0, baseStock + originalQty - otherReserved);
  };

  const setQuantity = (productId: string, quantity: number) => {
    triggerHaptic('light');
    setCart(prev => {
      if (quantity <= 0) {
        return prev.filter(item => item.product.id !== productId);
      }
      const otherItemsTotal = prev.reduce((sum, item) => {
        if (item.product.id === productId) return sum;
        return sum + ((Number(item.product?.price) || 0) * (Number(item.quantity) || 0));
      }, 0);
      const remainingBudget = Math.max(0, MAX_BILL_AMOUNT - otherItemsTotal);

      return prev.map(item => {
        if (item.product.id === productId) {
          const maxStock = getMaxStockForProduct(item.product, productId);
          const unitPrice = Math.max(0, Number(item.product?.price) || 0);
          const maxAffordableQty = unitPrice > 0 ? Math.floor((remainingBudget + 1e-9) / unitPrice) : maxStock;
          const allowedMax = Math.min(maxStock, maxAffordableQty);
          if (unitPrice > 0 && (quantity > maxAffordableQty || otherItemsTotal + quantity * unitPrice > MAX_BILL_AMOUNT)) {
            triggerHaptic('warning');
            notifyMaxBillLimitReached('Cannot add more than ₹10,000 value in cart.');
          } else if (quantity > maxStock) {
            triggerHaptic('warning');
            const otherHold = reservedByOthersRef.current[productId] || 0;
            if (otherHold > 0) {
              notifyMaxBillLimitReached(`Max in cart — ${otherHold} reserved in another user's cart.`);
            }
          }
          const newQuantity = Math.max(item.quantity > 0 && allowedMax === 0 ? 1 : 0, Math.min(quantity, allowedMax));
          return { ...item, quantity: newQuantity };
        }
        return item;
      });
    });
  };

  const setPrice = (productId: string, price: number) => {
    setCart(prev => {
      const otherItemsTotal = prev.reduce((sum, item) => {
        if (item.product.id === productId) return sum;
        return sum + ((Number(item.product?.price) || 0) * (Number(item.quantity) || 0));
      }, 0);
      const remainingBudget = Math.max(0, MAX_BILL_AMOUNT - otherItemsTotal);

      return prev.map(item => {
        if (item.product.id === productId) {
          const qty = Math.max(1, Number(item.quantity) || 1);
          const maxUnitPrice = Math.floor((remainingBudget / qty) * 100) / 100;
          const safePrice = Number.isFinite(price) ? Math.max(0, price) : 0;
          if (safePrice > maxUnitPrice) {
            triggerHaptic('warning');
            notifyMaxBillLimitReached('Cannot add more than ₹10,000 value in cart.');
          }
          const clampedPrice = Math.min(safePrice, maxUnitPrice);
          return { ...item, product: { ...item.product, price: clampedPrice } };
        }
        return item;
      });
    });
  };

  const addToCart = (product: Product, amount: number = 1) => {
    const step = Math.max(1, Math.floor(Number(amount) || 1));
    setCart(prev => {
      if (prev.length === 0) {
        sessionStartedAtRef.current = Date.now();
      }
      const existing = prev.find(item => item.product.id === product.id);
      const maxStock = getMaxStockForProduct(product, product.id);
      const otherHold = product.id ? (reservedByOthersRef.current[product.id] || 0) : 0;

      if (maxStock <= 0 || (existing && existing.quantity >= maxStock)) {
        triggerHaptic('error');
        if (otherHold > 0) {
          notifyMaxBillLimitReached(`Max in cart — ${otherHold} reserved in another user's cart.`);
        }
        return prev;
      }

      const currentTotal = prev.reduce(
        (sum, item) => sum + ((Number(item.product?.price) || 0) * (Number(item.quantity) || 0)),
        0
      );
      const unitPrice = Math.max(0, Number(existing ? existing.product.price : product.price) || 0);
      const remainingBudget = Math.max(0, MAX_BILL_AMOUNT - currentTotal);
      const maxAddableByBudget = unitPrice > 0 ? Math.floor((remainingBudget + 1e-9) / unitPrice) : step;

      if (unitPrice > 0 && (maxAddableByBudget <= 0 || currentTotal + unitPrice > MAX_BILL_AMOUNT)) {
        triggerHaptic('error');
        notifyMaxBillLimitReached('Cannot add more than ₹10,000 value in cart.');
        return prev;
      }

      const effectiveStep = Math.min(step, maxAddableByBudget);
      if (unitPrice > 0 && (effectiveStep < step || currentTotal + unitPrice * step > MAX_BILL_AMOUNT)) {
        triggerHaptic('warning');
        notifyMaxBillLimitReached('Cannot add more than ₹10,000 value in cart.');
      } else {
        triggerHaptic(step > 1 ? 'heavy' : 'medium');
      }

      if (existing) {
        const nextQuantity = Math.min(maxStock, existing.quantity + effectiveStep);
        return prev.map(item => item.product.id === product.id ? { ...item, quantity: nextQuantity } : item);
      }
      if (maxStock > 0 && effectiveStep > 0) {
        const initialQuantity = Math.min(maxStock, effectiveStep);
        return [...prev, { product, quantity: initialQuantity }];
      }
      return prev;
    });
  };

  const removeFromCart = (productId: string, amount: number = 1) => {
    const step = Math.max(1, Math.floor(Number(amount) || 1));
    triggerHaptic(step > 1 ? 'heavy' : 'rigid');
    setCart(prev => {
      const existing = prev.find(item => item.product.id === productId);
      if (existing && existing.quantity > step) {
        return prev.map(item => item.product.id === productId ? { ...item, quantity: item.quantity - step } : item);
      }
      return prev.filter(item => item.product.id !== productId);
    });
  };

  const clearCart = () => {
    triggerHaptic('warning');
    setCart([]);
    setEditingBill(null);
    if (user) {
      const mySid = sessionIdRef.current;
      updateDoc(doc(db, 'settings', 'active_carts'), {
        [`sessions.${mySid}`]: deleteField(),
      }).catch(() => {});
    }
  };

  const totalAmount = useMemo(() => {
    const rawTotal = cart.reduce((sum, item) => {
      const p = Number(item.product?.price);
      const q = Number(item.quantity);
      const safeP = Number.isFinite(p) && p > 0 ? p : 0;
      const safeQ = Number.isFinite(q) && q > 0 ? q : 0;
      return sum + safeP * safeQ;
    }, 0);
    if (!Number.isFinite(rawTotal)) return MAX_BILL_AMOUNT;
    return Math.min(MAX_BILL_AMOUNT, Math.round(rawTotal * 100) / 100);
  }, [cart]);

    return (
    <CartContext.Provider
      value={{
        cart,
        addToCart,
        removeFromCart,
        setQuantity,
        setPrice,
        clearCart,
        setCart,
        totalAmount,
        editingBill,
        setEditingBill,
        reservedByOthers,
        setCheckoutInProgress,
      }}
    >
      {children}
    </CartContext.Provider>
  );
};

export const useCart = () => {
  const context = useContext(CartContext);
  if (!context) {
    throw new Error('useCart must be used within a CartProvider');
  }
  return context;
};

