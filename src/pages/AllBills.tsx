import React, { useState, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { motion, AnimatePresence } from 'motion/react';
import { useNavigate, Navigate } from 'react-router-dom';
import { Receipt, Search, ArrowLeft, X } from 'lucide-react';
import { useGlobalProducts } from '../lib/ProductsContext';
import { useGlobalBills } from '../lib/BillsContext';
import { Bill } from '../lib/firestoreHooks';
import { useAuth } from '../lib/AuthContext';
import { triggerHaptic } from '../lib/haptics';
import { BillReceiptModal } from '../components/BillReceiptModal';
import { formatPrice, useOptimizedTransition, useHardwareAcceleration } from '../lib/utils';

const formatDateToDMY = (timestamp: number | string | Date) => {
  const d = new Date(timestamp);
  if (isNaN(d.getTime())) return "";
  const day = String(d.getDate()).padStart(2, "0");
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const year = d.getFullYear();
  return `${day}/${month}/${year}`;
};

export function AllBills() {
  const { user, isAdmin: isUserAdmin, isRealAdmin } = useAuth();
  const isAdmin = isRealAdmin || isUserAdmin || sessionStorage.getItem('adminAuth') === 'true';
  const { products } = useGlobalProducts();
  const { bills } = useGlobalBills();
  const navigate = useNavigate();
  
  const [search, setSearch] = useState('');
  const [selectedBill, setSelectedBill] = useState<Bill | null>(null);

  const filtered = useMemo(() => {
    const searchLower = search.trim().toLowerCase();
    return bills.filter((b) => {
      if (!searchLower) return true;
      const d = formatDateToDMY(b.date).toLowerCase();
      const total = formatPrice(b.total).toLowerCase();
      const billId = (b.id || '').toLowerCase();
      const custName = (b.customerName || '').toLowerCase();
      const custPhone = (b.customerPhone || '').toLowerCase();
      const matchesItems = (b.items || []).some((item) =>
        (item.name || '').toLowerCase().includes(searchLower)
      );
      return (
        d.includes(searchLower) ||
        total.includes(searchLower) ||
        billId.includes(searchLower) ||
        custName.includes(searchLower) ||
        custPhone.includes(searchLower) ||
        (b.isUdhar && 'udhar'.includes(searchLower)) ||
        matchesItems
      );
    });
  }, [bills, search]);

  const groupedBills = useMemo(() => {
    const sorted = [...filtered].sort(
      (a, b) => new Date(b.date).getTime() - new Date(a.date).getTime()
    );

    const now = new Date();
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    const yesterdayStart = todayStart - 86400000;

    const groups: Array<{ label: string; key: string; items: Bill[] }> = [];
    const groupMap = new Map<string, { label: string; key: string; items: Bill[] }>();

    sorted.forEach((bill) => {
      const d = new Date(bill.date);
      const dayStart = isNaN(d.getTime())
        ? 0
        : new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();

      let label = formatDateToDMY(bill.date) || 'Unknown Date';
      let key = label;

      if (dayStart === todayStart) {
        label = 'Today';
        key = 'today';
      } else if (dayStart === yesterdayStart) {
        label = 'Yesterday';
        key = 'yesterday';
      }

      let group = groupMap.get(key);
      if (!group) {
        group = { label, key, items: [] };
        groupMap.set(key, group);
        groups.push(group);
      }
      group.items.push(bill);
    });

    return groups;
  }, [filtered]);

  const totalRevenue = bills.reduce((sum, bill) => sum + bill.total, 0);

  if (!isAdmin) {
    return <Navigate to="/admin" replace />;
  }

  const pageTransition = useOptimizedTransition({ duration: 0.45, ease: [0.16, 1, 0.3, 1] });
  const gpuClass = useHardwareAcceleration();

  return (
    <motion.div 
      initial={{ opacity: 0, scale: 0.98 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, scale: 0.95 }}
      transition={pageTransition}
      className={`min-h-full flex flex-col pb-2 px-4 pt-12 w-full max-w-lg mx-auto ${gpuClass}`}
    >
      <header className="mb-6 pl-2 flex items-center gap-4">
        <button 
          onClick={() => navigate('/admin')}
          className="w-10 h-10 flex-shrink-0 flex items-center justify-center bg-slate-200 dark:bg-slate-700 rounded-full shadow-sm hover:scale-105 active:scale-95 transition-all text-slate-700 dark:text-slate-200 border border-transparent outline-none pointer-events-auto"
        >
          <ArrowLeft size={20} />
        </button>
        <div>
           <h1 className="text-3xl font-bold tracking-tight text-slate-900 dark:text-slate-100">
             All <span className="text-indigo-600 dark:text-indigo-400">Bills</span>
           </h1>
           <p className="text-slate-500 dark:text-slate-400 font-medium mt-1">Total {bills.length} bills · ₹{formatPrice(totalRevenue)}</p>
        </div>
      </header>

      <motion.div initial={{ y: 20, opacity: 0 }} animate={{ y: 0, opacity: 1 }} transition={{ delay: 0.1 }} className="flex-1 flex flex-col">
        <div className="relative mb-5">
            <input 
                type="text" 
                placeholder="Search by item, bill ID, date, or amount..."
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className={`glass-input w-full !pl-10 ${search ? '!pr-10' : '!pr-4'} text-xs sm:text-sm font-medium`}
            />
            <Search className="absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-400 z-10 pointer-events-none dark:text-slate-500" size={16} />
            {search && (
              <button
                type="button"
                onClick={() => {
                  triggerHaptic('soft');
                  setSearch('');
                }}
                aria-label="Clear search"
                className="absolute right-2.5 top-1/2 -translate-y-1/2 w-8 h-8 rounded-full flex items-center justify-center text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors"
              >
                <X size={15} />
              </button>
            )}
        </div>

        <div className="text-slate-800 dark:text-slate-200 flex-1 flex flex-col">
          {filtered.length === 0 ? (
             <div className="p-8 text-center text-slate-400 dark:text-slate-500 glass-card flex-1 flex flex-col items-center justify-center gap-2">
               <Receipt className="mx-auto mb-1 opacity-50" size={36} />
               <p className="font-bold text-slate-700 dark:text-slate-300 text-sm">No bills found</p>
               <p className="text-xs text-slate-500 dark:text-slate-400">
                 {search ? 'Try clearing your search filter.' : 'Completed bills will appear here.'}
               </p>
             </div>
          ) : (
            <div className="space-y-6">
              {groupedBills.map((group) => (
                <div key={group.key} className="space-y-3">
                  <div className="flex items-center justify-between px-2">
                    <h2 className="text-xs font-extrabold uppercase tracking-widest text-slate-400 dark:text-slate-500">
                      {group.label}
                    </h2>
                    <span className="text-[11px] font-mono tabular-nums font-semibold text-slate-400 dark:text-slate-500">
                      {group.items.length} {group.items.length === 1 ? 'bill' : 'bills'}
                    </span>
                  </div>
                  <motion.ul
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    className="space-y-3"
                  >
                    {group.items.map((bill, idx) => (
                      <motion.li 
                        initial={{ opacity: 0, scale: 0.98 }}
                        animate={{ opacity: 1, scale: 1 }}
                        key={bill.id ? `${bill.id}_${idx}` : `bill_${group.key}_${idx}`} 
                        onClick={() => { triggerHaptic('heavy'); setSelectedBill(bill); }} 
                        className="glass-card p-4 flex items-center justify-between transition-colors cursor-pointer group"
                      >
                        <div className="flex gap-4 items-center min-w-0">
                          <div className="w-12 h-12 shrink-0 rounded-2xl bg-indigo-50/80 dark:bg-indigo-500/10 flex items-center justify-center text-indigo-400 transition-transform text-xs font-bold font-mono">
                              #{bill.id?.slice(-5) || '00000'}
                          </div>
                          <div className="min-w-0">
                              <div className="flex items-center gap-2 flex-wrap">
                                  <p className="font-medium text-slate-900 dark:text-slate-100">Bill</p>
                                  {bill.isUdhar && (
                                      <span className="px-2 py-0.5 rounded-full bg-amber-100 dark:bg-amber-500/20 text-amber-700 dark:text-amber-400 text-[10px] font-bold uppercase tracking-wide">On Udhar</span>
                                  )}
                                  {bill.status === 'on_hold' && (
                                      <span className="px-2 py-0.5 rounded-full bg-amber-100 dark:bg-amber-500/20 text-amber-700 dark:text-amber-400 text-[10px] font-bold uppercase tracking-wide">On Hold</span>
                                  )}
                                  {bill.pendingOfflineSync && (
                                      <span className="px-2 py-0.5 rounded-full bg-amber-500/15 text-amber-600 dark:text-amber-400 text-[10px] font-bold uppercase tracking-wide border border-amber-500/25">Pending Sync</span>
                                  )}
                              </div>
                              <p className="text-xs text-slate-500 dark:text-slate-400">
                                {formatDateToDMY(bill.date)} • {new Date(bill.date).toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'})}
                              </p>
                          </div>
                        </div>
                        <span className="font-bold text-slate-900 dark:text-slate-100 font-mono text-lg shrink-0">₹{formatPrice(bill.total)}</span>
                      </motion.li>
                    ))}
                  </motion.ul>
                </div>
              ))}
            </div>
          )}
        </div>
      </motion.div>

      {createPortal(
        <AnimatePresence>
            {selectedBill && (
               <BillReceiptModal selectedBill={selectedBill} onClose={() => setSelectedBill(null)} products={products} />
            )}
        </AnimatePresence>,
        document.body
      )}

    </motion.div>
  );
}
