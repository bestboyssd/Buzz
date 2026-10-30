import React from 'react';
import { Package, Receipt, Activity, ShoppingCart } from 'lucide-react';
import { useLocation, useNavigate } from 'react-router-dom';
import { triggerHaptic } from '../lib/haptics';
import { useCart } from '../lib/CartContext';
import { motion, AnimatePresence } from 'motion/react';

export function BottomNav() {
  const { cart } = useCart();
  const quantityInCart = cart.reduce((sum, item) => sum + item.quantity, 0);
  const [isKeyboardOpen, setIsKeyboardOpen] = React.useState(false);
  const location = useLocation();
  const [isAdmin, setIsAdmin] = React.useState(() => sessionStorage.getItem('adminAuth') === 'true');

  React.useEffect(() => {
    const handleAdminChange = () => {
      setIsAdmin(sessionStorage.getItem('adminAuth') === 'true');
    };
    window.addEventListener('adminAuthChanged', handleAdminChange);
    return () => window.removeEventListener('adminAuthChanged', handleAdminChange);
  }, []);

  React.useEffect(() => {
    const baselineHeight = window.screen?.height
      ? Math.min(window.innerHeight, window.screen.height)
      : window.innerHeight;

    const handleResize = () => {
      if (window.visualViewport) {
        setIsKeyboardOpen(window.visualViewport.height < baselineHeight * 0.78);
      }
    };

    const handleNativeKeyboard = (e: Event) => {
      const custom = e as CustomEvent<{ isOpen: boolean; height: number }>;
      if (custom.detail) {
        setIsKeyboardOpen(Boolean(custom.detail.isOpen));
      }
    };

    window.visualViewport?.addEventListener('resize', handleResize);
    window.addEventListener('nativeKeyboardStateChanged', handleNativeKeyboard);
    return () => {
      window.visualViewport?.removeEventListener('resize', handleResize);
      window.removeEventListener('nativeKeyboardStateChanged', handleNativeKeyboard);
    };
  }, []);

  if (isKeyboardOpen) return null;
  if (location.pathname === '/admin' && !isAdmin) return null;

  return (
    <div
      id="bottom-nav-container"
      className="fixed left-0 right-0 z-[60] px-4 flex justify-center pointer-events-none no-print select-none [-webkit-touch-callout:none]"
      style={{ bottom: "calc(1.1rem + env(safe-area-inset-bottom))" }}
      onContextMenu={(e) => e.preventDefault()}
    >
      <motion.nav
        initial={{ y: 24, opacity: 0, scale: 0.95 }}
        animate={{ y: 0, opacity: 1, scale: 1 }}
        transition={{ type: "spring", stiffness: 460, damping: 30, mass: 0.72 }}
        className="bg-[#f3edf7]/95 dark:bg-[#191c26]/95 backdrop-blur-2xl border border-slate-200/80 dark:border-white/[0.08] shadow-[0_12px_32px_-8px_rgba(15,23,42,0.18)] dark:shadow-[0_12px_32px_-8px_rgba(0,0,0,0.65)] p-1.5 flex items-center justify-center gap-1 rounded-full pointer-events-auto select-none [-webkit-touch-callout:none] transform-gpu"
      >
        <NavItem to="/" icon={<Receipt size={20} />} label="POS" />
        <NavItem to="/checkout" icon={<ShoppingCart size={20} />} label="Checkout" badge={quantityInCart} />
        <NavItem to="/history" icon={<Activity size={20} />} label="Activity" />
        <NavItem to="/products" icon={<Package size={20} />} label="Stock" />
      </motion.nav>
    </div>
  );
}

function NavItem({ to, icon, label, badge }: { to: string; icon: React.ReactNode; label: string; badge?: number }) {
  const location = useLocation();
  const navigate = useNavigate();
  const isActive = location.pathname === to;

  return (
    <motion.button
      type="button"
      whileTap={{ scale: 0.91 }}
      transition={{ type: "spring", stiffness: 520, damping: 26 }}
      onClick={() => {
        triggerHaptic(isActive ? 'soft' : 'selection');
        if (!isActive) {
          navigate(to);
        }
      }}
      onContextMenu={(e) => e.preventDefault()}
      draggable={false}
      className={`relative flex flex-col items-center justify-center min-w-[70px] sm:min-w-[78px] h-13 px-3 rounded-full transition-colors duration-200 z-10 select-none [-webkit-touch-callout:none] outline-none cursor-pointer ${
        isActive
          ? 'text-indigo-950 dark:text-indigo-100'
          : 'text-slate-600 hover:text-slate-900 dark:text-slate-400 dark:hover:text-slate-100'
      }`}
    >
      {isActive && (
        <motion.div
          layoutId="active-pill"
          className="absolute inset-0 bg-[#e0e7ff] dark:bg-indigo-500/25 rounded-full -z-10 border border-indigo-200/70 dark:border-indigo-400/30 shadow-2xs"
          transition={{ type: "spring", stiffness: 460, damping: 30, mass: 0.65 }}
        />
      )}
      <div className="relative flex items-center justify-center">
        <motion.div
          animate={{ scale: isActive ? 1.1 : 1, y: isActive ? -1.5 : 0 }}
          transition={{ type: "spring", stiffness: 460, damping: 28, mass: 0.65 }}
        >
          {icon}
        </motion.div>
        <AnimatePresence>
          {badge !== undefined && badge > 0 && (
            <motion.div
              key={`nav-badge-${badge}`}
              initial={{ scale: 0, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0, opacity: 0 }}
              transition={{ type: "spring", stiffness: 540, damping: 22, mass: 0.55 }}
              className="absolute -top-1.5 -right-3 bg-indigo-600 dark:bg-indigo-500 text-white text-[10px] min-w-[18px] h-[18px] px-1 rounded-full flex items-center justify-center font-bold font-mono tabular-nums shadow-sm ring-2 ring-[#f3edf7] dark:ring-[#191c26]"
            >
              {badge}
            </motion.div>
          )}
        </AnimatePresence>
      </div>
      <span className={`text-[10px] tracking-tight mt-0.5 whitespace-nowrap leading-none ${isActive ? 'font-bold' : 'font-medium'}`}>
        {label}
      </span>
    </motion.button>
  );
}

