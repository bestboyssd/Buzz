import React, { createContext, useContext, useEffect, useState } from 'react';
import { collection, onSnapshot, orderBy, query } from 'firebase/firestore';
import { db } from './firebase';
import { useAuth } from './AuthContext';
import { Bill } from './firestoreHooks';
import { sqliteSaveBills, sqliteGetBills } from './sqliteAdapter';

interface BillsContextType {
    bills: Bill[];
    loading: boolean;
    addBillOptimistic: (bill: Bill) => void;
    removeBillOptimistic: (billId: string) => void;
    clearBillsOptimistic: () => void;
    restoreBillsOptimistic: (restoredBills: Bill[]) => void;
}

const BillsContext = createContext<BillsContextType>({
    bills: [],
    loading: true,
    addBillOptimistic: () => {},
    removeBillOptimistic: () => {},
    clearBillsOptimistic: () => {},
    restoreBillsOptimistic: () => {},
});

export const getPendingOfflineBillsFromStorage = (): Bill[] => {
    try {
        const raw = localStorage.getItem("offline_pending_bills_v1");
        if (raw) {
            const parsed = JSON.parse(raw);
            if (Array.isArray(parsed)) return parsed;
        }
    } catch {}
    return [];
};

export const parseBillTimestamp = (rawDate: any): number => {
    if (typeof rawDate === 'number' && Number.isFinite(rawDate) && rawDate > 0) {
        return rawDate;
    }
    if (rawDate && typeof rawDate === 'object') {
        if (typeof rawDate.seconds === 'number') {
            return rawDate.seconds * 1000;
        }
        if (typeof rawDate.toMillis === 'function') {
            return rawDate.toMillis();
        }
    }
    if (typeof rawDate === 'string' && rawDate.trim()) {
        const asNum = Number(rawDate);
        if (Number.isFinite(asNum) && asNum > 0) return asNum;
        const parsed = new Date(rawDate).getTime();
        if (!isNaN(parsed) && parsed > 0) return parsed;
    }
    return Date.now();
};

export const normalizeAndDedupeBills = (rawBills: any[]): Bill[] => {
    let savedBuyPrices: Record<string, number> = {};
    try {
        const raw = localStorage.getItem("local_product_buy_prices");
        if (raw) {
            const parsed = JSON.parse(raw);
            if (parsed && typeof parsed === "object") savedBuyPrices = parsed;
        }
    } catch {}

    const map = new Map<string, Bill>();
    for (let i = 0; i < rawBills.length; i++) {
        const b = rawBills[i];
        if (!b || typeof b !== 'object') continue;
        const payload = b.data && typeof b.data === 'object' ? { ...b.data, id: b.id || b.data.id } : b;
        const rawItems = Array.isArray(payload.items) ? payload.items : [];
        const normalizedItems = rawItems.map((item: any) => {
            const pid = String(item?.productId || item?.id || '').trim();
            const itemName = String(item?.name || 'Item').trim();
            let resolvedItemCost: number | undefined = undefined;
            if (
                item?.costPrice !== undefined &&
                item?.costPrice !== null &&
                String(item.costPrice).trim() !== '' &&
                !isNaN(Number(item.costPrice)) &&
                Number(item.costPrice) > 0
            ) {
                resolvedItemCost = Number(item.costPrice);
            } else if (
                item?.buyPrice !== undefined &&
                item?.buyPrice !== null &&
                String(item.buyPrice).trim() !== '' &&
                !isNaN(Number(item.buyPrice)) &&
                Number(item.buyPrice) > 0
            ) {
                resolvedItemCost = Number(item.buyPrice);
            } else if (pid && savedBuyPrices[`id:${pid}`] !== undefined && Number(savedBuyPrices[`id:${pid}`]) > 0) {
                resolvedItemCost = Number(savedBuyPrices[`id:${pid}`]);
            } else if (itemName && savedBuyPrices[`name:${itemName.toLowerCase()}`] !== undefined && Number(savedBuyPrices[`name:${itemName.toLowerCase()}`]) > 0) {
                resolvedItemCost = Number(savedBuyPrices[`name:${itemName.toLowerCase()}`]);
            }

            return {
                productId: pid,
                name: itemName,
                price: Math.max(0, Number(item?.price) || 0),
                ...(resolvedItemCost !== undefined ? { costPrice: resolvedItemCost } : {}),
                quantity: Math.max(1, Number(item?.quantity) || 1),
            };
        });
        const computedTotal =
            payload.total !== undefined && payload.total !== null && !isNaN(Number(payload.total))
                ? Math.max(0, Number(payload.total))
                : normalizedItems.reduce((sum: number, it: any) => sum + it.price * it.quantity, 0);
        const dateVal = parseBillTimestamp(payload.date ?? payload.timestamp ?? payload.createdAt);
        const idStr = String(payload.id || `bill_${dateVal}_${i}`).trim();
        const custName = payload.customerName ? String(payload.customerName).trim() : '';
        const custPhone = payload.customerPhone ? String(payload.customerPhone).trim() : '';
        const udhaarNote = payload.udhaarNote ? String(payload.udhaarNote).trim() : '';
        const linkedOtherCostId = payload.linkedOtherCostId ? String(payload.linkedOtherCostId).trim() : '';
        const costCategory =
            payload.costCategory === 'due' ? 'due' : payload.costCategory === 'borrow' ? 'borrow' : undefined;
        const normalized: Bill = {
            ...payload,
            id: idStr,
            items: normalizedItems,
            total: computedTotal,
            date: dateVal,
            status: payload.status === 'on_hold' ? 'on_hold' : 'completed',
            isUdhar: Boolean(payload.isUdhar || payload.status === 'on_udhar'),
            ...(custName ? { customerName: custName } : {}),
            ...(custPhone ? { customerPhone: custPhone } : {}),
            ...(udhaarNote ? { udhaarNote } : {}),
            ...(linkedOtherCostId ? { linkedOtherCostId } : {}),
            ...(costCategory ? { costCategory } : {}),
        };
        if (!custName) delete (normalized as any).customerName;
        if (!custPhone) delete (normalized as any).customerPhone;
        if (!udhaarNote) delete (normalized as any).udhaarNote;
        if (!linkedOtherCostId) delete (normalized as any).linkedOtherCostId;
        if (!costCategory) delete (normalized as any).costCategory;

        if (!map.has(idStr)) {
            map.set(idStr, normalized);
        }
    }
    return Array.from(map.values()).sort((a, b) => (Number(b.date) || 0) - (Number(a.date) || 0));
};

export function BillsProvider({ children }: { children: React.ReactNode }) {
    const { user } = useAuth();
    const [bills, setBills] = useState<Bill[]>(() => {
        try {
            const pendingOffline = getPendingOfflineBillsFromStorage();
            const cached = localStorage.getItem("local_bills_fallback");
            const parsedCached = cached ? JSON.parse(cached) : [];
            return normalizeAndDedupeBills([...pendingOffline, ...(Array.isArray(parsedCached) ? parsedCached : [])]);
        } catch {}
        return [];
    });
    const [loading, setLoading] = useState(true);
    const hasReceivedFirestoreSnapshot = React.useRef(false);

    const addBillOptimistic = React.useCallback((newBill: Bill) => {
        if (!newBill) return;
        setBills((prev) => {
            const merged = normalizeAndDedupeBills([newBill, ...prev]);
            try {
                localStorage.setItem("local_bills_fallback", JSON.stringify(merged.slice(0, 100)));
            } catch {}
            sqliteSaveBills(merged).catch(() => {});
            return merged;
        });
    }, []);

    const removeBillOptimistic = React.useCallback((billId: string) => {
        if (!billId) return;
        setBills((prev) => {
            const filtered = prev.filter((b) => b.id !== billId);
            try {
                localStorage.setItem("local_bills_fallback", JSON.stringify(filtered.slice(0, 100)));
            } catch {}
            sqliteSaveBills(filtered).catch(() => {});
            return filtered;
        });
    }, []);

    const clearBillsOptimistic = React.useCallback(() => {
        setBills([]);
        try {
            localStorage.removeItem("local_bills_fallback");
            localStorage.removeItem("offline_pending_bills_v1");
        } catch {}
        sqliteSaveBills([]).catch(() => {});
    }, []);

    const restoreBillsOptimistic = React.useCallback((restoredBills: Bill[]) => {
        if (!Array.isArray(restoredBills) || restoredBills.length === 0) return;
        setBills((prev) => {
            const merged = normalizeAndDedupeBills([...restoredBills, ...prev]);
            try {
                localStorage.setItem("local_bills_fallback", JSON.stringify(merged.slice(0, 100)));
            } catch {}
            sqliteSaveBills(merged).catch(() => {});
            return merged;
        });
    }, []);

    useEffect(() => {
        const handleOfflineBillQueued = (e: Event) => {
            const custom = e as CustomEvent<Bill>;
            if (custom.detail) {
                addBillOptimistic(custom.detail);
            }
        };
        const handleOfflineBillRejected = (e: Event) => {
            const custom = e as CustomEvent<{ billId: string }>;
            if (custom.detail?.billId) {
                removeBillOptimistic(custom.detail.billId);
            }
        };
        const handleBackfillProductBuyPrice = (e: Event) => {
            const custom = e as CustomEvent<{
                productId?: string;
                productName?: string;
                costPrice?: number;
            }>;
            const detail = custom.detail;
            const cleanCost = Number(detail?.costPrice);
            if (!detail || isNaN(cleanCost) || cleanCost <= 0) return;
            const targetId = String(detail.productId || '').toLowerCase().trim();
            const targetName = String(detail.productName || '').toLowerCase().trim();
            if (!targetId && !targetName) return;

            setBills((prev) => {
                let anyChanged = false;
                const updated = prev.map((b) => {
                    const items = Array.isArray(b.items) ? b.items : [];
                    let billModified = false;
                    const nextItems = items.map((it) => {
                        const itId = String(it.productId || '').toLowerCase().trim();
                        const itName = String(it.name || '').toLowerCase().trim();
                        const matches =
                            (targetId && itId === targetId) || (targetName && itName === targetName);
                        const hasPositiveCost =
                            it.costPrice !== undefined &&
                            it.costPrice !== null &&
                            !isNaN(Number(it.costPrice)) &&
                            Number(it.costPrice) > 0;
                        if (matches && !hasPositiveCost) {
                            billModified = true;
                            anyChanged = true;
                            return { ...it, costPrice: cleanCost };
                        }
                        return it;
                    });
                    return billModified ? { ...b, items: nextItems } : b;
                });

                if (anyChanged) {
                    try {
                        localStorage.setItem(
                            "local_bills_fallback",
                            JSON.stringify(updated.slice(0, 100))
                        );
                        const offlineRaw = localStorage.getItem("offline_pending_bills_v1");
                        if (offlineRaw) {
                            const offlineParsed = JSON.parse(offlineRaw);
                            if (Array.isArray(offlineParsed)) {
                                const nextOffline = offlineParsed.map((ob: any) => {
                                    const matchUpdated = updated.find((u) => u.id === ob?.id);
                                    return matchUpdated ? { ...ob, items: matchUpdated.items } : ob;
                                });
                                localStorage.setItem(
                                    "offline_pending_bills_v1",
                                    JSON.stringify(nextOffline)
                                );
                            }
                        }
                    } catch {}
                    sqliteSaveBills(updated).catch(() => {});
                }
                return anyChanged ? updated : prev;
            });
        };
        window.addEventListener("offlineBillQueued", handleOfflineBillQueued);
        window.addEventListener("offlineBillRejected", handleOfflineBillRejected);
        window.addEventListener("backfillBillsProductBuyPrice", handleBackfillProductBuyPrice);
        return () => {
            window.removeEventListener("offlineBillQueued", handleOfflineBillQueued);
            window.removeEventListener("offlineBillRejected", handleOfflineBillRejected);
            window.removeEventListener("backfillBillsProductBuyPrice", handleBackfillProductBuyPrice);
        };
    }, [addBillOptimistic, removeBillOptimistic]);

    // Hydrate bills from SQLite database immediately on cold start before Firestore responds
    useEffect(() => {
        sqliteGetBills().then((cachedBills) => {
            if (hasReceivedFirestoreSnapshot.current) return;
            const pendingOffline = getPendingOfflineBillsFromStorage();
            if ((cachedBills && cachedBills.length > 0) || pendingOffline.length > 0) {
                const clean = normalizeAndDedupeBills([...pendingOffline, ...(cachedBills || [])]);
                setBills((prev) => (prev.length === 0 ? clean : normalizeAndDedupeBills([...pendingOffline, ...prev])));
                setLoading(false);
            }
        }).catch((err) => {
            console.warn("Failed hydrating bills from SQLite:", err);
        });
    }, []);

    useEffect(() => {
        let isMounted = true;
        let retryTimer: any = null;
        let unsubscribe: (() => void) | null = null;

        const subscribeBills = () => {
            if (!isMounted) return;
            const collRef = collection(db, 'bills');

            unsubscribe = onSnapshot(collRef, (snapshot) => {
                if (!isMounted) return;
                hasReceivedFirestoreSnapshot.current = true;
                const data: Bill[] = [];
                snapshot.forEach((docSnap) => {
                    data.push({ ...docSnap.data(), id: docSnap.id } as Bill);
                });
                const pendingOffline = getPendingOfflineBillsFromStorage();
                const cleanBills = normalizeAndDedupeBills([...pendingOffline, ...data]);
                setBills(cleanBills);
                try {
                    if (cleanBills.length > 0) {
                        localStorage.setItem("local_bills_fallback", JSON.stringify(cleanBills.slice(0, 100)));
                    } else {
                        localStorage.removeItem("local_bills_fallback");
                    }
                } catch {}
                sqliteSaveBills(cleanBills).catch(() => {});
                setLoading(false);
            }, (error) => {
                if (!isMounted) return;
                console.warn("Firestore bills fetch failed. Loading SQLite cache...", error);
                if (!hasReceivedFirestoreSnapshot.current) {
                    sqliteGetBills().then((cached) => {
                        const pendingOffline = getPendingOfflineBillsFromStorage();
                        if (((cached && cached.length > 0) || pendingOffline.length > 0) && isMounted) {
                            setBills(normalizeAndDedupeBills([...pendingOffline, ...(cached || [])]));
                        }
                    }).catch(() => {}).finally(() => {
                        if (isMounted) setLoading(false);
                    });
                } else {
                    setLoading(false);
                }
                retryTimer = setTimeout(() => {
                    if (isMounted) {
                        if (unsubscribe) unsubscribe();
                        subscribeBills();
                    }
                }, 2000);
            });
        };

        subscribeBills();

        return () => {
            isMounted = false;
            if (retryTimer) clearTimeout(retryTimer);
            if (unsubscribe) unsubscribe();
        };
    }, [user?.uid]);

    return (
        <BillsContext.Provider value={{ bills, loading, addBillOptimistic, removeBillOptimistic, clearBillsOptimistic, restoreBillsOptimistic }}>
            {children}
        </BillsContext.Provider>
    );
}

export function useGlobalBills() {
    return useContext(BillsContext);
}
