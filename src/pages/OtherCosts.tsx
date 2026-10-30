import React, { useState, useEffect, useMemo } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { useNavigate, Navigate } from 'react-router-dom';
import { ArrowLeft, Plus, Trash2, Calendar, FileText, AlertCircle, TrendingDown, DollarSign, Users, PiggyBank, Check } from 'lucide-react';
import { triggerHaptic } from '../lib/haptics';
import { formatPrice, getAppBusinessIsoDate, isPerformanceModeEnabled } from '../lib/utils';
import { db, handleFirestoreError, OperationType } from '../lib/firebase';
import { collection, query, onSnapshot, setDoc, deleteDoc, doc, orderBy } from 'firebase/firestore';
import { useAuth } from '../lib/AuthContext';
import { logActivity, settleHoldBill } from '../lib/firestoreHooks';
import { useGlobalBills } from '../lib/BillsContext';

export interface OtherCost {
    id?: string;
    title: string;
    amount: number;
    category: 'expense' | 'borrow' | 'due' | 'other';
    date: number;
    ownerId: string;
    linkedBillId?: string;
    customerName?: string;
    customerPhone?: string;
    udhaarNote?: string;
}

export function OtherCosts() {
    const navigate = useNavigate();
    const { user, isAdmin: isUserAdmin, isRealAdmin } = useAuth();
    const isAdmin = isRealAdmin || isUserAdmin || sessionStorage.getItem('adminAuth') === 'true';

    useEffect(() => {
        if (isRealAdmin || isUserAdmin) {
            sessionStorage.setItem('adminAuth', 'true');
        }
    }, [isRealAdmin, isUserAdmin]);

    const [costs, setCosts] = useState<OtherCost[]>(() => {
        try {
            const cached = localStorage.getItem('local_other_costs_fallback');
            if (cached) {
                const parsed = JSON.parse(cached);
                if (Array.isArray(parsed)) return parsed;
            }
        } catch {}
        return [];
    });
    const [loading, setLoading] = useState(() => {
        try {
            return !localStorage.getItem('local_other_costs_fallback');
        } catch {
            return true;
        }
    });
    
    // Add Cost Form fields & Filter
    const [isAdding, setIsAdding] = useState(false);
    const [selectedFilter, setSelectedFilter] = useState<'all' | 'expense' | 'borrow' | 'due' | 'other'>('all');
    const [title, setTitle] = useState('');
    const [amount, setAmount] = useState('');
    const [category, setCategory] = useState<'expense' | 'borrow' | 'due' | 'other'>('expense');
    const [dateValue, setDateValue] = useState(() => getAppBusinessIsoDate());
    const [isSaving, setIsSaving] = useState(false);

    const { bills } = useGlobalBills();

    // Fetch Other Costs in real-time
    useEffect(() => {
        if (!isAdmin || !user) {
            setLoading(false);
            return;
        }

        const collRef = collection(db, 'other_costs');

        const unsubscribe = onSnapshot(collRef, (snapshot) => {
            const list: OtherCost[] = [];
            snapshot.forEach((docSnap) => {
                const raw = docSnap.data() || {};
                list.push({
                    ...raw,
                    id: docSnap.id,
                    title: String(raw.title || raw.name || 'Untitled Expense'),
                    amount: Number(raw.amount) || 0,
                    category: (raw.category as any) || 'other',
                    date: Number(raw.date) || Date.now(),
                    ownerId: String(raw.ownerId || ''),
                } as OtherCost);
            });
            list.sort((a, b) => (Number(b.date) || 0) - (Number(a.date) || 0));
            setCosts(list);
            try {
                localStorage.setItem('local_other_costs_fallback', JSON.stringify(list));
            } catch {}
            setLoading(false);
        }, (error) => {
            handleFirestoreError(error, OperationType.LIST, 'other_costs');
            setLoading(false);
        });

        const handleLocalOtherCostsUpdate = (e: Event) => {
            const customEvent = e as CustomEvent<OtherCost[]>;
            if (Array.isArray(customEvent.detail)) {
                const sorted = [...customEvent.detail].sort((a, b) => (Number(b.date) || 0) - (Number(a.date) || 0));
                setCosts(sorted);
            }
        };
        window.addEventListener('otherCostsUpdated', handleLocalOtherCostsUpdate);
        window.addEventListener('localOtherCostsUpdated', handleLocalOtherCostsUpdate);

        return () => {
            unsubscribe();
            window.removeEventListener('otherCostsUpdated', handleLocalOtherCostsUpdate);
            window.removeEventListener('localOtherCostsUpdated', handleLocalOtherCostsUpdate);
        };
    }, [isAdmin, user]);

    // Handle submit new cost
    const handleAddCost = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!title.trim() || !amount || isSaving || !user) return;

        triggerHaptic('heavy');
        setIsSaving(true);

        const parsedAmount = parseFloat(amount);
        if (isNaN(parsedAmount) || parsedAmount <= 0) {
            triggerHaptic('error');
            setIsSaving(false);
            return;
        }

        // Parse date: if matches current business day (up to 1 AM), use current timestamp; otherwise local noon of selected date
        const todayBizIso = getAppBusinessIsoDate();
        let parsedDate = Date.now();
        if (dateValue && dateValue !== todayBizIso) {
            const [y, m, d] = dateValue.split('-').map(Number);
            if (y && m && d) {
                parsedDate = new Date(y, m - 1, d, 12, 0, 0, 0).getTime();
            }
        }

        try {
            const loggedTitle = title.trim();
            const loggedAmount = parsedAmount;
            const loggedCategory = category;

            const newCostRef = doc(collection(db, 'other_costs'));
            setDoc(newCostRef, {
                title: loggedTitle,
                amount: loggedAmount,
                category: loggedCategory,
                date: parsedDate,
                ownerId: user.uid
            }).catch(err => console.error('Failed to save other cost in bg:', err));

            if (user) {
                logActivity(
                    'add_cost',
                    `Added other cost/fee: "${loggedTitle}" under category "${loggedCategory}" (Amount: ₹${formatPrice(loggedAmount)}).`,
                    user.uid,
                    user.displayName || 'Admin',
                    user.email || ''
                ).catch(e => console.error(e));
            }
            
            // Reset form
            setTitle('');
            setAmount('');
            setCategory('expense');
            setDateValue(getAppBusinessIsoDate());
            setIsAdding(false);
            triggerHaptic('success');
        } catch (err) {
            console.error('Failed to save other cost:', err);
            triggerHaptic('error');
        } finally {
            setIsSaving(false);
        }
    };

    // Handle delete cost item
    const handleDeleteCost = (id: string) => {
        if (!id) return;
        triggerHaptic('success');
        try {
            const costItem = costs.find(c => c.id === id);
            setCosts(prev => {
                const next = prev.filter(c => c.id !== id);
                try {
                    localStorage.setItem('local_other_costs_fallback', JSON.stringify(next));
                } catch {}
                return next;
            });
            if (costItem?.linkedBillId) {
                const linkedBill = bills.find(b => b.id === costItem.linkedBillId);
                if (linkedBill && linkedBill.isUdhar) {
                    settleHoldBill(linkedBill).catch(e => console.error('Failed to settle linked Udhar bill:', e));
                }
            }
            deleteDoc(doc(db, 'other_costs', id)).catch(err => console.error('Failed to delete in bg:', err));
            if (user && costItem) {
                logActivity(
                    'delete_cost',
                    `Deleted other cost/fee: "${costItem.title}" (Amount: ₹${formatPrice(costItem.amount)}).`,
                    user.uid,
                    user.displayName || 'Admin',
                    user.email || ''
                ).catch(e => console.error(e));
            }
        } catch (err) {
            console.error('Failed to delete item:', err);
            handleFirestoreError(err, OperationType.DELETE, `other_costs/${id}`);
        }
    };

    // Category styling helpers
    const getCategoryStyles = (cat: string) => {
        switch (cat) {
            case 'expense':
                return {
                    bg: 'bg-rose-50 dark:bg-rose-500/10 text-rose-600 dark:text-rose-400 border-rose-200/50 dark:border-rose-500/20',
                    label: 'Expense',
                    shortLabel: 'Expense',
                    icon: <TrendingDown size={15} />
                };
            case 'borrow':
                return {
                    bg: 'bg-amber-50 dark:bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-200/50 dark:border-amber-500/20',
                    label: 'Borrowed / Debt',
                    shortLabel: 'Borrowed',
                    icon: <Users size={15} />
                };
            case 'due':
                return {
                    bg: 'bg-indigo-50 dark:bg-indigo-500/10 text-indigo-600 dark:text-indigo-400 border-indigo-200/50 dark:border-indigo-500/20',
                    label: 'Due',
                    shortLabel: 'Due',
                    icon: <DollarSign size={15} />
                };
            default:
                return {
                    bg: 'bg-slate-50 dark:bg-slate-500/10 text-slate-600 dark:text-slate-400 border-slate-200/50 dark:border-slate-500/20',
                    label: 'Other Cost',
                    shortLabel: 'Other',
                    icon: <PiggyBank size={15} />
                };
        }
    };

    const getDisplayTitle = (item: OtherCost) => {
        if (item.linkedBillId) {
            const shortBill = item.linkedBillId.slice(-5).toUpperCase();
            const cust = (item.customerName || '').trim();
            if (cust && cust.toLowerCase() !== 'walk-in customer') {
                return `Udhar · ${cust}`;
            }
            if (!item.title || item.title.toLowerCase().includes('walk-in customer')) {
                return `Udhar Bill #${shortBill}`;
            }
            return item.title.replace(/\s*·\s*Bill\s*#[A-Za-z0-9]+/i, '').trim() || `Udhar Bill #${shortBill}`;
        }
        return item.title;
    };

    // Compute totals & filtered costs
    const grandTotal = useMemo(() => {
        return costs.reduce((sum, item) => sum + item.amount, 0);
    }, [costs]);

    const filteredCosts = useMemo(() => {
        if (selectedFilter === 'all') return costs;
        return costs.filter((c) => c.category === selectedFilter);
    }, [costs, selectedFilter]);

    if (!isAdmin) {
        return <Navigate to="/admin" replace />;
    }

    return (
        <motion.div 
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8, transition: { duration: 0.18, ease: [0.16, 1, 0.3, 1] } }}
            transition={{ duration: 0.25, ease: [0.16, 1, 0.3, 1] }}
            className="min-h-full flex flex-col pb-2 px-4 pt-12 w-full max-w-lg mx-auto transform-gpu will-change-transform"
        >
            <header className="mb-8 flex items-center justify-between pl-2">
                <div className="flex items-center gap-4">
                    <motion.button 
                        whileHover={{ scale: 1.06, x: -1 }}
                        whileTap={{ scale: 0.9 }}
                        transition={{ type: 'spring', stiffness: 500, damping: 24 }}
                        onClick={() => { triggerHaptic('heavy'); navigate('/admin'); }}
                        className="w-10 h-10 flex-shrink-0 flex items-center justify-center bg-slate-200 dark:bg-slate-700 rounded-full shadow-sm transition-colors text-slate-700 dark:text-slate-200 border border-transparent outline-none pointer-events-auto cursor-pointer"
                    >
                        <ArrowLeft size={20} />
                    </motion.button>
                    <div>
                        <h1 className="text-3xl font-extrabold tracking-tight text-slate-900 dark:text-slate-100">
                            Other <span className="text-indigo-600 dark:text-indigo-400">Costs</span>
                        </h1>
                        <p className="text-[13px] leading-snug text-slate-500 dark:text-slate-400 font-medium mt-1">
                            Track dues, borrowings & business expenses
                        </p>
                    </div>
                </div>
                <motion.button 
                    type="button"
                    whileHover={{ scale: 1.06 }}
                    whileTap={{ scale: 0.88 }}
                    transition={{ type: 'spring', stiffness: 500, damping: 24 }}
                    onClick={() => { triggerHaptic('light'); setIsAdding((prev) => !prev); }}
                    aria-label={isAdding ? 'Close add cost form' : 'Open add cost form'}
                    className={`w-10 h-10 shrink-0 aspect-square rounded-full text-white flex items-center justify-center shadow-lg transition-colors duration-200 cursor-pointer outline-none ${
                        isAdding
                            ? 'bg-slate-800 hover:bg-slate-900 dark:bg-slate-700 dark:hover:bg-slate-600 shadow-slate-900/20'
                            : 'bg-indigo-600 hover:bg-indigo-700 shadow-indigo-600/30'
                    }`}
                >
                    <motion.span
                        initial={false}
                        animate={{ rotate: isAdding ? 45 : 0 }}
                        transition={{ type: 'spring', stiffness: 480, damping: 26, mass: 0.6 }}
                        className="flex items-center justify-center origin-center transform-gpu"
                    >
                        <Plus size={22} strokeWidth={2.5} />
                    </motion.span>
                </motion.button>
            </header>

            {/* Total Summary Card */}
            <div className="glass-card p-6 mb-6 flex justify-between items-center bg-gradient-to-tr from-rose-500/20 via-rose-500/5 to-transparent border-rose-500/10">
                <div>
                    <h3 className="text-xs font-black uppercase tracking-widest text-slate-400 dark:text-slate-500 mb-1">Total Costs (to deduct)</h3>
                    <p className="text-3xl font-black tracking-tight text-rose-600 dark:text-rose-400">₹{formatPrice(grandTotal)}</p>
                    <p className="text-[10px] text-slate-500 dark:text-slate-400 font-medium mt-1">This amount will be auto-deducted from Analytics revenue</p>
                </div>
                <div className="p-3 bg-rose-50 dark:bg-rose-500/15 rounded-2xl flex items-center justify-center text-rose-500">
                    <TrendingDown size={28} />
                </div>
            </div>

            {/* Slide Down Form overlay */}
            <AnimatePresence initial={false}>
                {isAdding && (
                    <motion.div
                        key="add-cost-form-drawer"
                        initial={{ height: 0, opacity: 0 }}
                        animate={{
                            height: 'auto',
                            opacity: 1,
                            transition: {
                                height: { duration: 0.28, ease: [0.22, 1, 0.36, 1] },
                                opacity: { duration: 0.2, delay: 0.04, ease: 'easeOut' },
                            },
                        }}
                        exit={{
                            height: 0,
                            opacity: 0,
                            transition: {
                                height: { duration: 0.24, ease: [0.22, 1, 0.36, 1] },
                                opacity: { duration: 0.14, ease: 'easeIn' },
                            },
                        }}
                        className="overflow-hidden will-change-[height,opacity]"
                    >
                        <div className="pb-6 pt-0.5">
                            <form onSubmit={handleAddCost} className="bg-white dark:bg-[#1b1f2b] rounded-[28px] p-5 border border-indigo-500/20 dark:border-indigo-400/20 shadow-[0_4px_20px_-2px_rgba(79,70,229,0.08)] dark:shadow-none space-y-4">
                                <h3 className="text-sm font-bold text-slate-900 dark:text-slate-100 flex items-center gap-2">
                                    <Plus size={16} className="text-indigo-600 dark:text-indigo-400" />
                                    Add Cost / Borrow Record
                                </h3>
                            
                            <div>
                                <label className="block text-xs font-bold text-slate-500 dark:text-slate-400 mb-1">Title / Description</label>
                                <input 
                                    type="text" 
                                    value={title}
                                    onChange={(e) => setTitle(e.target.value)}
                                    placeholder="e.g. John borrowed amount, Tea, Rent..."
                                    required
                                    className="w-full px-4 py-2.5 rounded-xl border border-slate-200 dark:border-slate-800 bg-white/50 dark:bg-slate-950/50 text-slate-900 dark:text-slate-100 text-sm focus:outline-none focus:border-indigo-500"
                                />
                            </div>

                            <div className="grid grid-cols-2 gap-3">
                                <div>
                                    <label className="block text-xs font-bold text-slate-500 dark:text-slate-400 mb-1">Amount (₹)</label>
                                    <input 
                                        type="number" 
                                        step="any"
                                        value={amount}
                                        onChange={(e) => setAmount(e.target.value)}
                                        placeholder="0.00"
                                        required
                                        className="w-full px-4 py-2.5 rounded-xl border border-slate-200 dark:border-slate-800 bg-white/50 dark:bg-slate-950/50 text-slate-900 dark:text-slate-100 text-sm focus:outline-none focus:border-indigo-500 font-mono"
                                    />
                                </div>
                                <div>
                                    <label className="block text-xs font-bold text-slate-500 dark:text-slate-400 mb-1">Date</label>
                                    <input 
                                        type="date" 
                                        value={dateValue}
                                        onChange={(e) => setDateValue(e.target.value)}
                                        required
                                        className="w-full px-4 py-2.5 rounded-xl border border-slate-200 dark:border-slate-800 bg-white/50 dark:bg-slate-950/50 text-slate-900 dark:text-slate-100 text-sm focus:outline-none focus:border-indigo-500 font-mono"
                                    />
                                </div>
                            </div>

                            <div>
                                <label className="block text-xs font-bold text-slate-500 dark:text-slate-400 mb-2">Category</label>
                                <div
                                    onTouchStart={(e) => {
                                        const touch = e.touches[0];
                                        if (!touch) return;
                                        const rect = e.currentTarget.getBoundingClientRect();
                                        if (rect.width <= 0) return;
                                        const cats = ['expense', 'borrow', 'due', 'other'] as const;
                                        const relX = Math.max(0, Math.min(rect.width - 1, touch.clientX - rect.left));
                                        const idx = Math.min(cats.length - 1, Math.max(0, Math.floor((relX / rect.width) * cats.length)));
                                        const next = cats[idx];
                                        if (next && next !== category) {
                                            triggerHaptic('selection');
                                            setCategory(next);
                                        }
                                    }}
                                    onTouchMove={(e) => {
                                        const touch = e.touches[0];
                                        if (!touch) return;
                                        const rect = e.currentTarget.getBoundingClientRect();
                                        if (rect.width <= 0) return;
                                        const cats = ['expense', 'borrow', 'due', 'other'] as const;
                                        const relX = Math.max(0, Math.min(rect.width - 1, touch.clientX - rect.left));
                                        const idx = Math.min(cats.length - 1, Math.max(0, Math.floor((relX / rect.width) * cats.length)));
                                        const next = cats[idx];
                                        if (next && next !== category) {
                                            triggerHaptic('selection');
                                            setCategory(next);
                                        }
                                    }}
                                    onPointerMove={(e) => {
                                        if (e.buttons !== 1) return;
                                        const rect = e.currentTarget.getBoundingClientRect();
                                        if (rect.width <= 0) return;
                                        const cats = ['expense', 'borrow', 'due', 'other'] as const;
                                        const relX = Math.max(0, Math.min(rect.width - 1, e.clientX - rect.left));
                                        const idx = Math.min(cats.length - 1, Math.max(0, Math.floor((relX / rect.width) * cats.length)));
                                        const next = cats[idx];
                                        if (next && next !== category) {
                                            triggerHaptic('selection');
                                            setCategory(next);
                                        }
                                    }}
                                    className="relative grid grid-cols-4 p-1 bg-[#ece6f0]/90 dark:bg-[#161922]/95 border border-slate-200/80 dark:border-white/[0.07] rounded-2xl select-none touch-pan-y isolate"
                                >
                                    <div
                                        aria-hidden="true"
                                        style={{
                                            width: 'calc((100% - 8px) / 4)',
                                            transform: `translate3d(${
                                                (['expense', 'borrow', 'due', 'other'] as const).indexOf(category) * 100
                                            }%, 0, 0)`,
                                            transition: 'transform 260ms cubic-bezier(0.22, 1, 0.36, 1)',
                                        }}
                                        className="absolute top-1 bottom-1 left-1 bg-[#e0e7ff] dark:bg-indigo-500/25 border border-indigo-200/70 dark:border-indigo-400/30 rounded-xl shadow-2xs pointer-events-none will-change-transform"
                                    />
                                    {(['expense', 'borrow', 'due', 'other'] as const).map((cat) => {
                                        const styles = getCategoryStyles(cat);
                                        const active = category === cat;
                                        return (
                                            <button
                                                key={cat}
                                                type="button"
                                                onClick={() => {
                                                    if (category === cat) return;
                                                    triggerHaptic('selection');
                                                    setCategory(cat);
                                                }}
                                                className={`relative z-10 py-2.5 px-1 rounded-xl text-[10px] font-bold transition-colors duration-200 flex flex-col items-center justify-center gap-1 outline-none cursor-pointer ${
                                                    active 
                                                        ? 'text-indigo-950 dark:text-indigo-100' 
                                                        : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200 active:scale-95'
                                                }`}
                                            >
                                                <span className="relative z-10">{styles.icon}</span>
                                                <span className="relative z-10 truncate max-w-full">{styles.shortLabel}</span>
                                            </button>
                                        );
                                    })}
                                </div>
                            </div>

                            <button
                                type="submit"
                                disabled={isSaving}
                                className="w-full py-3 bg-indigo-600 hover:bg-indigo-700 text-white rounded-full text-sm font-bold shadow-md shadow-indigo-600/25 active:scale-95 transition-all disabled:opacity-50"
                            >
                                {isSaving ? 'Processing...' : 'Add Cost Entry'}
                            </button>
                        </form>
                        </div>
                    </motion.div>
                )}
            </AnimatePresence>

            {/* Material 3 Segmented Category Filter Bar */}
            <div
                onTouchStart={(e) => {
                    const touch = e.touches[0];
                    if (!touch) return;
                    const rect = e.currentTarget.getBoundingClientRect();
                    if (rect.width <= 0) return;
                    const tabs = ['all', 'expense', 'borrow', 'due', 'other'] as const;
                    const relX = Math.max(0, Math.min(rect.width - 1, touch.clientX - rect.left));
                    const idx = Math.min(tabs.length - 1, Math.max(0, Math.floor((relX / rect.width) * tabs.length)));
                    const next = tabs[idx];
                    if (next && next !== selectedFilter) {
                        triggerHaptic('selection');
                        setSelectedFilter(next);
                    }
                }}
                onTouchMove={(e) => {
                    const touch = e.touches[0];
                    if (!touch) return;
                    const rect = e.currentTarget.getBoundingClientRect();
                    if (rect.width <= 0) return;
                    const tabs = ['all', 'expense', 'borrow', 'due', 'other'] as const;
                    const relX = Math.max(0, Math.min(rect.width - 1, touch.clientX - rect.left));
                    const idx = Math.min(tabs.length - 1, Math.max(0, Math.floor((relX / rect.width) * tabs.length)));
                    const next = tabs[idx];
                    if (next && next !== selectedFilter) {
                        triggerHaptic('selection');
                        setSelectedFilter(next);
                    }
                }}
                onPointerMove={(e) => {
                    if (e.buttons !== 1) return;
                    const rect = e.currentTarget.getBoundingClientRect();
                    if (rect.width <= 0) return;
                    const tabs = ['all', 'expense', 'borrow', 'due', 'other'] as const;
                    const relX = Math.max(0, Math.min(rect.width - 1, e.clientX - rect.left));
                    const idx = Math.min(tabs.length - 1, Math.max(0, Math.floor((relX / rect.width) * tabs.length)));
                    const next = tabs[idx];
                    if (next && next !== selectedFilter) {
                        triggerHaptic('selection');
                        setSelectedFilter(next);
                    }
                }}
                className="relative grid grid-cols-5 p-1 mb-5 bg-[#ece6f0]/90 dark:bg-[#161922]/95 border border-slate-200/80 dark:border-white/[0.07] rounded-full select-none touch-pan-y isolate"
            >
                <div
                    aria-hidden="true"
                    style={{
                        width: 'calc((100% - 8px) / 5)',
                        transform: `translate3d(${
                            (['all', 'expense', 'borrow', 'due', 'other'] as const).indexOf(selectedFilter) * 100
                        }%, 0, 0)`,
                        transition: 'transform 260ms cubic-bezier(0.22, 1, 0.36, 1)',
                    }}
                    className="absolute top-1 bottom-1 left-1 bg-[#e0e7ff] dark:bg-indigo-500/25 border border-indigo-200/70 dark:border-indigo-400/30 rounded-full shadow-2xs pointer-events-none will-change-transform"
                />
                {(
                    [
                        { id: 'all', label: 'All' },
                        { id: 'expense', label: 'Expense' },
                        { id: 'borrow', label: 'Borrow' },
                        { id: 'due', label: 'Due' },
                        { id: 'other', label: 'Other' },
                    ] as const
                ).map((tab) => {
                    const active = selectedFilter === tab.id;
                    return (
                        <button
                            key={tab.id}
                            type="button"
                            onClick={() => {
                                if (selectedFilter === tab.id) return;
                                triggerHaptic('selection');
                                setSelectedFilter(tab.id);
                            }}
                            className={`relative z-10 min-w-0 min-h-[38px] px-1.5 py-1.5 rounded-full text-[11px] sm:text-xs font-bold outline-none transition-colors duration-200 flex items-center justify-center whitespace-nowrap cursor-pointer ${
                                active
                                    ? 'text-indigo-950 dark:text-indigo-100'
                                    : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200 active:scale-95'
                            }`}
                        >
                            <span className="relative z-10 truncate">{tab.label}</span>
                        </button>
                    );
                })}
            </div>

            {/* List entries */}
            <div className="flex-1 flex flex-col space-y-3">
                {loading && costs.length === 0 ? (
                    <div className="text-center py-10 font-medium text-slate-500 dark:text-slate-400 flex-1 flex items-center justify-center">Loading cost receipts...</div>
                ) : filteredCosts.length === 0 ? (
                    <div className="glass-card p-8 text-center flex-1 flex flex-col items-center justify-center">
                        <AlertCircle className="text-slate-300 dark:text-slate-700 mb-2" size={36} />
                        <p className="text-sm font-bold text-slate-700 dark:text-slate-300">No costs recorded yet</p>
                        <p className="text-xs text-slate-500 mt-1">Tap the plus button above to add expenses, borrow accounts, or dynamic dues.</p>
                    </div>
                ) : (
                    <AnimatePresence initial={false}>
                    {filteredCosts.map((item, idx) => {
                        const style = getCategoryStyles(item.category);
                        const linkedBill = item.linkedBillId
                            ? bills.find((b) => b.id === item.linkedBillId)
                            : undefined;
                        const displayTitle = getDisplayTitle(item);
                        const shortBillId = item.linkedBillId ? item.linkedBillId.slice(-5).toUpperCase() : '';
                        const subDetail = [item.customerPhone, item.udhaarNote].filter(Boolean).join(' · ');

                        const perfMode = isPerformanceModeEnabled();

                        return (
                            <motion.div 
                                layout={!perfMode}
                                initial={perfMode ? false : { opacity: 0, y: 12, scale: 0.97 }}
                                animate={{ opacity: 1, y: 0, scale: 1 }}
                                exit={perfMode ? undefined : { opacity: 0, scale: 0.94, y: -6, transition: { duration: 0.16 } }}
                                whileHover={perfMode ? undefined : { y: -1.5 }}
                                transition={
                                    perfMode
                                        ? { duration: 0 }
                                        : {
                                              type: 'spring',
                                              stiffness: 480,
                                              damping: 32,
                                              mass: 0.65,
                                              delay: Math.min(idx * 0.03, 0.18),
                                          }
                                }
                                key={item.id || `cost_${idx}`}
                                className="glass-card p-4 relative overflow-hidden group hover:border-slate-300 dark:hover:border-slate-800 transition-colors transform-gpu"
                            >
                                {/* Top Row: Icon + Title/Meta + Amount (+ Delete for standard costs) */}
                                <div className="flex items-center justify-between gap-3">
                                    <div className="flex items-center gap-3 min-w-0 flex-1">
                                        <div className={`w-10 h-10 rounded-xl border shrink-0 flex items-center justify-center ${style.bg}`}>
                                            {style.icon}
                                        </div>
                                        <div className="min-w-0 flex-1">
                                            <h4 className="font-bold text-slate-900 dark:text-slate-100 text-sm leading-snug truncate">
                                                {displayTitle}
                                            </h4>
                                            <div className="flex items-center gap-1.5 mt-0.5 whitespace-nowrap overflow-hidden">
                                                <span className="text-[10px] font-extrabold text-slate-400 dark:text-slate-500 uppercase tracking-wider shrink-0">
                                                    {style.shortLabel}
                                                </span>
                                                <span className="text-slate-300 dark:text-slate-700 text-[10px] shrink-0">•</span>
                                                <span className="text-[11px] font-mono text-slate-500 dark:text-slate-400 shrink-0">
                                                    {new Date(item.date).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}
                                                </span>
                                            </div>
                                        </div>
                                    </div>

                                    <div className="flex items-center gap-2.5 shrink-0">
                                        <span className="font-mono font-extrabold text-rose-600 dark:text-rose-400 text-base whitespace-nowrap">
                                            -₹{formatPrice(item.amount)}
                                        </span>
                                        {!item.linkedBillId && (
                                            <motion.button 
                                                type="button"
                                                whileHover={{ scale: 1.08 }}
                                                whileTap={{ scale: 0.9 }}
                                                transition={{ type: 'spring', stiffness: 500, damping: 24 }}
                                                onClick={() => {
                                                    if (item.id) handleDeleteCost(item.id);
                                                }}
                                                className="w-8 h-8 flex items-center justify-center bg-slate-100/80 dark:bg-slate-800/80 hover:bg-rose-50 dark:hover:bg-rose-500/15 hover:text-rose-600 text-slate-400 rounded-xl transition-colors cursor-pointer"
                                                title="Delete entry"
                                            >
                                                <Trash2 size={15} />
                                            </motion.button>
                                        )}
                                    </div>
                                </div>

                                {/* Bottom Action Row for Linked Udhar Bills */}
                                {item.linkedBillId && (
                                    <div className="mt-3 pt-2.5 border-t border-slate-200/70 dark:border-white/[0.06] flex items-center justify-between gap-2">
                                        <div className="flex items-center gap-2 min-w-0">
                                            <span className="px-2 py-0.5 rounded-md bg-amber-500/15 text-amber-600 dark:text-amber-400 border border-amber-500/20 text-[10px] font-extrabold uppercase tracking-wider whitespace-nowrap shrink-0">
                                                Udhar #{shortBillId}
                                            </span>
                                            {subDetail && (
                                                <span className="text-[11px] font-medium text-slate-500 dark:text-slate-400 truncate">
                                                    {subDetail}
                                                </span>
                                            )}
                                        </div>
                                        <div className="flex items-center gap-2 shrink-0">
                                            <motion.button
                                                type="button"
                                                whileHover={{ scale: 1.03, y: -1 }}
                                                whileTap={{ scale: 0.94 }}
                                                transition={{ type: 'spring', stiffness: 500, damping: 24 }}
                                                onClick={() => {
                                                    if (item.id) {
                                                        handleDeleteCost(item.id);
                                                    } else if (linkedBill) {
                                                        triggerHaptic('success');
                                                        settleHoldBill(linkedBill).catch(() => {});
                                                    }
                                                }}
                                                className="px-3.5 py-1.5 bg-emerald-600 hover:bg-emerald-700 text-white rounded-xl text-[11px] font-bold flex items-center gap-1.5 shadow-2xs transition-colors cursor-pointer"
                                                title="Settle Udhar Bill"
                                            >
                                                <Check size={13} strokeWidth={2.5} />
                                                <span>Settle</span>
                                            </motion.button>
                                        </div>
                                    </div>
                                )}
                            </motion.div>
                        );
                    })}
                    </AnimatePresence>
                )}
            </div>
        </motion.div>
    );
}
