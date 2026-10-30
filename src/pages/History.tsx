import React, { useState, useMemo, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { motion, AnimatePresence } from 'motion/react';
import { Activity, DollarSign, Receipt, Search, X, TrendingUp } from 'lucide-react';
import { useGlobalProducts } from '../lib/ProductsContext';
import { useGlobalBills } from '../lib/BillsContext';
import { Bill } from '../lib/firestoreHooks';
import { triggerHaptic } from '../lib/haptics';
import { ProfileMenu } from '../components/ProfileMenu';
import { BillReceiptModal } from '../components/BillReceiptModal';
import { formatPrice, useOptimizedTransition, useHardwareAcceleration, getBillCalendarIsoDate, isPerformanceModeEnabled } from '../lib/utils';

const formatDateToDMY = (timestamp: number | string | Date) => {
  const d = new Date(timestamp);
  if (isNaN(d.getTime())) return "";
  const day = String(d.getDate()).padStart(2, "0");
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const year = d.getFullYear();
  return `${day}/${month}/${year}`;
};

export function History() {
  const { products } = useGlobalProducts();
  const { bills } = useGlobalBills();
  const [todayIso, setTodayIso] = useState(() => getBillCalendarIsoDate());

  useEffect(() => {
    const syncToday = () => {
      const current = getBillCalendarIsoDate();
      setTodayIso((prev) => (prev === current ? prev : current));
    };
    const interval = window.setInterval(syncToday, 15000);
    window.addEventListener('focus', syncToday);
    document.addEventListener('visibilitychange', syncToday);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener('focus', syncToday);
      document.removeEventListener('visibilitychange', syncToday);
    };
  }, []);

  const todayBills = useMemo(() => {
    return bills.filter((bill) => {
      if (bill.date === undefined || bill.date === null) return false;
      const d = new Date(bill.date);
      if (isNaN(d.getTime())) return false;
      return getBillCalendarIsoDate(d) === todayIso;
    });
  }, [bills, todayIso]);

  const todayRevenue = useMemo(
    () => todayBills.reduce((sum, bill) => sum + (Number(bill.total) || 0), 0),
    [todayBills]
  );
  const todaySalesCount = todayBills.length;

  const [search, setSearch] = useState('');
  const [selectedBill, setSelectedBill] = useState<Bill | null>(null);

  const filtered = useMemo(() => {
    const searchLower = search.trim().toLowerCase();
    return todayBills.filter((b) => {
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
  }, [todayBills, search]);

  const pageTransition = useOptimizedTransition({ duration: 0.35, ease: [0.16, 1, 0.3, 1] });
  const gpuClass = useHardwareAcceleration();

  return (
    <motion.div
      initial={{ opacity: 0, scale: 0.98 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, scale: 0.95 }}
      transition={pageTransition}
      className={`min-h-full flex flex-col pb-2 px-4 pt-10 w-full max-w-lg md:max-w-2xl mx-auto no-print ${gpuClass}`}
    >
      <header className="mb-6 pl-1 flex justify-between items-center">
        <div>
          <h1 className="text-3xl font-extrabold tracking-tight text-slate-900 dark:text-slate-100">
            Business <span className="text-indigo-600 dark:text-indigo-400">Activity</span>
          </h1>
          <p className="text-[13px] leading-snug text-slate-500 dark:text-slate-400 font-medium mt-1">
            <span>Live sales & receipt ledger</span>
          </p>
        </div>
        <ProfileMenu />
      </header>

      <div className="grid grid-cols-2 gap-3.5 mb-7">
        <motion.div
          initial={isPerformanceModeEnabled() ? false : { y: 14, opacity: 0, scale: 0.96 }}
          animate={{ y: 0, opacity: 1, scale: 1 }}
          whileHover={isPerformanceModeEnabled() ? undefined : { y: -2, scale: 1.01 }}
          transition={isPerformanceModeEnabled() ? { duration: 0 } : { type: "spring", stiffness: 460, damping: 30, delay: 0.04 }}
        >
          <StatCard
            icon={<DollarSign size={20} className="text-indigo-600 dark:text-indigo-400" />}
            label="Today's Flow"
            value={`₹${formatPrice(todayRevenue)}`}
            color="border-indigo-200/70 dark:border-indigo-500/20"
          />
        </motion.div>
        <motion.div
          initial={isPerformanceModeEnabled() ? false : { y: 14, opacity: 0, scale: 0.96 }}
          animate={{ y: 0, opacity: 1, scale: 1 }}
          whileHover={isPerformanceModeEnabled() ? undefined : { y: -2, scale: 1.01 }}
          transition={isPerformanceModeEnabled() ? { duration: 0 } : { type: "spring", stiffness: 460, damping: 30, delay: 0.08 }}
        >
          <StatCard
            icon={<TrendingUp size={20} className="text-emerald-600 dark:text-emerald-400" />}
            label="Today's Receipts"
            value={todaySalesCount.toString()}
            color="border-emerald-200/70 dark:border-emerald-500/20"
          />
        </motion.div>
      </div>

      <motion.div
        initial={isPerformanceModeEnabled() ? false : { y: 12, opacity: 0 }}
        animate={{ y: 0, opacity: 1 }}
        transition={isPerformanceModeEnabled() ? { duration: 0 } : { delay: 0.12 }}
        className="flex-1 flex flex-col"
      >
        <div className="flex items-center justify-between px-1 mb-3">
          <h2 className="text-base font-bold text-slate-900 dark:text-slate-100 flex items-center gap-2">
            <Activity size={18} className="text-indigo-600 dark:text-indigo-400" />
            <span>{search.trim() ? 'Matching Bills' : "Today's Bills"}</span>
          </h2>
          <span className="text-xs font-mono tabular-nums text-slate-500 dark:text-slate-400">
            {filtered.length} {filtered.length === 1 ? 'receipt' : 'receipts'}
          </span>
        </div>

        <div className="relative mb-4">
          <input
            type="text"
            placeholder="Search bills..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className={`glass-input w-full !pl-10 ${
              search ? '!pr-10' : '!pr-4'
            } text-xs sm:text-sm font-medium`}
          />
          <Search className="absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-400 z-10 pointer-events-none" size={16} />
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
            <div className="p-10 text-center text-slate-400 dark:text-slate-500 glass-card flex-1 flex flex-col items-center justify-center gap-2">
              <Receipt className="opacity-50 mb-1" size={36} />
              <p className="font-bold text-slate-700 dark:text-slate-300 text-sm">
                No matching bills found
              </p>
              <p className="text-xs text-slate-500 dark:text-slate-400">
                {search ? 'Try clearing your search filter.' : 'Completed checkouts today will appear here.'}
              </p>
            </div>
          ) : (
            <motion.ul
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              className="space-y-2.5"
            >
              <AnimatePresence initial={false}>
              {filtered.map((bill, idx) => {
                const perfMode = isPerformanceModeEnabled();
                return (
                  <motion.li
                    layout={!perfMode}
                    initial={perfMode ? false : { opacity: 0, y: 10, scale: 0.97 }}
                    animate={{ opacity: 1, y: 0, scale: 1 }}
                    exit={perfMode ? undefined : { opacity: 0, scale: 0.95, transition: { duration: 0.15 } }}
                    whileHover={perfMode ? undefined : { y: -1.5, scale: 1.005 }}
                    whileTap={perfMode ? undefined : { scale: 0.975 }}
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
                    key={bill.id ? `${bill.id}_${idx}` : `bill_${idx}`}
                    onClick={() => {
                      triggerHaptic('medium');
                      setSelectedBill(bill);
                    }}
                    className="glass-card p-3.5 sm:p-4 flex items-center justify-between gap-3 transition-colors cursor-pointer group transform-gpu"
                  >
                    <div className="flex gap-3.5 items-center min-w-0">
                      <div className="w-12 h-12 shrink-0 rounded-2xl bg-indigo-50/90 dark:bg-indigo-500/15 border border-indigo-100 dark:border-indigo-500/20 flex items-center justify-center text-indigo-600 dark:text-indigo-400 text-xs font-extrabold font-mono tabular-nums group-hover:scale-105 transition-transform">
                        #{bill.id?.slice(-5) || '00000'}
                      </div>
                      <div className="min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <p className="font-bold text-slate-900 dark:text-slate-100 text-sm font-mono tabular-nums truncate">
                            #{bill.id?.slice(-5) || '00000'}
                          </p>
                          {bill.isUdhar && (
                            <span className="text-[11px] font-bold text-amber-600 dark:text-amber-400 shrink-0">
                              · On Udhar
                            </span>
                          )}
                          {bill.status === 'on_hold' && (
                            <span className="text-[11px] font-bold text-amber-600 dark:text-amber-400 shrink-0">
                              · On Hold
                            </span>
                          )}
                          {bill.pendingOfflineSync && (
                            <span className="px-2 py-0.5 rounded-full bg-amber-500/15 text-amber-600 dark:text-amber-400 text-[10px] font-bold uppercase tracking-wide border border-amber-500/25 shrink-0">
                              Pending Sync
                            </span>
                          )}
                        </div>
                        <p className="text-xs text-slate-500 dark:text-slate-400 font-mono tabular-nums mt-0.5 truncate">
                          {formatDateToDMY(bill.date)} · {new Date(bill.date).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                        </p>
                      </div>
                    </div>
                    <span className="font-extrabold text-slate-900 dark:text-slate-100 font-mono tabular-nums text-base sm:text-lg shrink-0">
                      ₹{formatPrice(bill.total)}
                    </span>
                  </motion.li>
                );
              })}
              </AnimatePresence>
            </motion.ul>
          )}
        </div>
      </motion.div>

      {createPortal(
        <AnimatePresence>
          {selectedBill && (
            <BillReceiptModal
              selectedBill={selectedBill}
              onClose={() => setSelectedBill(null)}
              products={products}
            />
          )}
        </AnimatePresence>,
        document.body
      )}
    </motion.div>
  );
}

function StatCard({ icon, label, value, color }: { icon: React.ReactNode; label: string; value: string; color: string }) {
  return (
    <div className={`glass-card p-4 sm:p-5 flex flex-col items-start gap-3 ${color}`}>
      <div className="w-10 h-10 rounded-xl bg-slate-100/80 dark:bg-slate-800/80 flex items-center justify-center">
        {icon}
      </div>
      <div>
        <p className="text-xs font-semibold text-slate-500 dark:text-slate-400">{label}</p>
        <p className="text-xl sm:text-2xl font-extrabold text-slate-900 dark:text-slate-100 font-mono tabular-nums mt-0.5">
          {value}
        </p>
      </div>
    </div>
  );
}
