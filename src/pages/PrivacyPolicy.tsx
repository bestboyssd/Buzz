import React from 'react';
import { ArrowLeft, Shield, Lock, Database, Smartphone, CheckCircle2 } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { motion } from 'motion/react';
import { triggerHaptic } from '../lib/haptics';

export function PrivacyPolicy() {
  const navigate = useNavigate();

  React.useEffect(() => {
    const scrollContainer = document.getElementById('app-scroll-container');
    if (scrollContainer) {
      scrollContainer.scrollTo({ top: 0, left: 0, behavior: 'instant' as ScrollBehavior });
    }
    window.scrollTo(0, 0);
  }, []);

  const handleBack = () => {
    triggerHaptic('light');
    if (window.history.length > 2) {
      navigate(-1);
    } else {
      navigate('/settings', { replace: true });
    }
  };

  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -10 }}
      transition={{ duration: 0.25, ease: [0.16, 1, 0.3, 1] }}
      className="pb-2 px-4 pt-10 max-w-lg mx-auto"
    >
      <header className="mb-6 flex items-center gap-3.5">
        <button
          type="button"
          onClick={handleBack}
          className="w-10 h-10 shrink-0 flex items-center justify-center bg-white dark:bg-slate-800/90 border border-slate-200/80 dark:border-slate-700/80 rounded-2xl shadow-xs hover:bg-slate-50 dark:hover:bg-slate-800 active:scale-95 transition-all text-slate-700 dark:text-slate-200 outline-none cursor-pointer"
          aria-label="Go back"
        >
          <ArrowLeft size={19} />
        </button>
        <div className="min-w-0">
          <h1 className="text-2xl font-extrabold text-slate-900 dark:text-white tracking-tight leading-tight">
            Privacy & Security
          </h1>
          <p className="text-xs text-slate-500 dark:text-slate-400 font-medium mt-0.5">
            Data handling, cloud sync & device permissions
          </p>
        </div>
      </header>

      {/* Top Assurance Banner */}
      <div className="mb-4 p-4 rounded-2xl bg-emerald-500/10 dark:bg-emerald-500/10 border border-emerald-500/20 flex items-start gap-3">
        <div className="w-9 h-9 rounded-xl bg-emerald-500/15 border border-emerald-500/25 flex items-center justify-center text-emerald-600 dark:text-emerald-400 shrink-0 mt-0.5">
          <Shield size={18} />
        </div>
        <div className="min-w-0">
          <div className="flex items-center gap-1.5">
            <h2 className="text-xs font-extrabold uppercase tracking-wider text-emerald-700 dark:text-emerald-300">
              Merchant Data Protection
            </h2>
            <CheckCircle2 size={13} className="text-emerald-500 shrink-0" />
          </div>
          <p className="text-xs text-slate-600 dark:text-slate-300 leading-relaxed mt-1">
            Your store catalog, billing ledger, and financial records belong exclusively to your business and are never sold or shared with third-party advertisers.
          </p>
        </div>
      </div>

      {/* Policy Sections (Static surface without active tap-flash glitch) */}
      <div className="bg-white/90 dark:bg-slate-900/90 backdrop-blur-xl border border-slate-200/80 dark:border-slate-800/80 rounded-3xl p-5 sm:p-6 space-y-5 shadow-xs text-slate-700 dark:text-slate-300">
        <section className="flex items-start gap-3.5">
          <div className="w-9 h-9 rounded-xl bg-indigo-500/10 dark:bg-indigo-500/15 border border-indigo-500/20 flex items-center justify-center text-indigo-600 dark:text-indigo-400 shrink-0 mt-0.5">
            <Lock size={17} />
          </div>
          <div className="min-w-0 flex-1">
            <h3 className="text-sm font-bold text-slate-900 dark:text-slate-100 mb-1">
              1. Local-First Processing
            </h3>
            <p className="text-xs text-slate-600 dark:text-slate-400 leading-relaxed">
              POS cart calculations, instant search, and offline SQLite caching run directly on your device so billing continues seamlessly even during network interruptions.
            </p>
          </div>
        </section>

        <div className="border-t border-slate-100 dark:border-slate-800/80" />

        <section className="flex items-start gap-3.5">
          <div className="w-9 h-9 rounded-xl bg-blue-500/10 dark:bg-blue-500/15 border border-blue-500/20 flex items-center justify-center text-blue-600 dark:text-blue-400 shrink-0 mt-0.5">
            <Database size={17} />
          </div>
          <div className="min-w-0 flex-1">
            <h3 className="text-sm font-bold text-slate-900 dark:text-slate-100 mb-1">
              2. Cloud Database Sync & Backups
            </h3>
            <p className="text-xs text-slate-600 dark:text-slate-400 leading-relaxed">
              When signed in, your products, transaction bills, and expenses are synchronized in real time with your connected Firebase Firestore database for multi-device access and instant recovery.
            </p>
          </div>
        </section>

        <div className="border-t border-slate-100 dark:border-slate-800/80" />

        <section className="flex items-start gap-3.5">
          <div className="w-9 h-9 rounded-xl bg-violet-500/10 dark:bg-violet-500/15 border border-violet-500/20 flex items-center justify-center text-violet-600 dark:text-violet-400 shrink-0 mt-0.5">
            <Smartphone size={17} />
          </div>
          <div className="min-w-0 flex-1">
            <h3 className="text-sm font-bold text-slate-900 dark:text-slate-100 mb-1">
              3. Device Permissions
            </h3>
            <p className="text-xs text-slate-600 dark:text-slate-400 leading-relaxed">
              Permissions such as Notifications (for low-stock and security alerts), Microphone (for optional voice commands), and Screen Wake Lock are used strictly when enabled by you.
            </p>
          </div>
        </section>

        <div className="pt-3 border-t border-slate-100 dark:border-slate-800/80 flex items-center justify-between text-[11px] text-slate-400 dark:text-slate-500 font-medium">
          <span>End-to-End Encrypted Transport (TLS)</span>
          <span className="font-mono">Updated 2026</span>
        </div>
      </div>
    </motion.div>
  );
}

