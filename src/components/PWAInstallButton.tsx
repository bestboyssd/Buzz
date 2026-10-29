import React, { useState } from 'react';
import { Download, Smartphone, X } from 'lucide-react';
import { usePWAInstall } from '../lib/usePWAInstall';
import { triggerHaptic } from '../lib/haptics';

export const PWAInstallButton: React.FC = () => {
  const { isInstallable, isInstalled, isIOS, install } = usePWAInstall();
  const [showIOSGuide, setShowIOSGuide] = useState(false);

  if (isInstalled) {
    return null;
  }

  if (isInstallable) {
    return (
      <div className="p-4 flex items-center justify-between transition-colors">
        <div className="flex items-center gap-3.5 min-w-0 pr-3">
          <div className="w-10 h-10 shrink-0 rounded-2xl bg-[#ece6f0] dark:bg-[#252936] flex items-center justify-center">
            <Download size={20} className="text-indigo-500" />
          </div>
          <div className="min-w-0">
            <h3 className="font-bold text-sm sm:text-base text-slate-900 dark:text-slate-100 truncate">
              Install Buzz App
            </h3>
            <p className="text-xs text-slate-500 dark:text-slate-400 truncate mt-0.5">
              Offline-ready home screen app with Workbox cache
            </p>
          </div>
        </div>
        <button
          onClick={() => {
            triggerHaptic('medium');
            install();
          }}
          className="shrink-0 flex items-center gap-1.5 rounded-full bg-indigo-600 hover:bg-indigo-700 active:scale-95 px-4 py-2 text-xs font-bold text-white shadow-sm transition-all cursor-pointer"
        >
          <Download size={14} />
          <span>Install</span>
        </button>
      </div>
    );
  }

  if (isIOS) {
    return (
      <>
        <div className="p-4 flex items-center justify-between transition-colors">
          <div className="flex items-center gap-3.5 min-w-0 pr-3">
            <div className="w-10 h-10 shrink-0 rounded-2xl bg-[#ece6f0] dark:bg-[#252936] flex items-center justify-center">
              <Smartphone size={20} className="text-indigo-500" />
            </div>
            <div className="min-w-0">
              <h3 className="font-bold text-sm sm:text-base text-slate-900 dark:text-slate-100 truncate">
                Install on iOS
              </h3>
              <p className="text-xs text-slate-500 dark:text-slate-400 truncate mt-0.5">
                Add Buzz POS to your home screen for offline access
              </p>
            </div>
          </div>
          <button
            onClick={() => {
              triggerHaptic('light');
              setShowIOSGuide(true);
            }}
            className="shrink-0 rounded-full border border-indigo-500/30 bg-indigo-500/10 px-3.5 py-1.5 text-xs font-bold text-indigo-600 dark:text-indigo-300 hover:bg-indigo-500/20 transition cursor-pointer"
          >
            How to Install
          </button>
        </div>

        {showIOSGuide && (
          <div className="fixed inset-0 z-[200] flex items-center justify-center bg-slate-950/60 backdrop-blur-sm p-4">
            <div className="w-full max-w-sm rounded-3xl bg-white dark:bg-[#1c1f2a] p-6 shadow-2xl border border-slate-200/80 dark:border-white/10">
              <div className="flex items-center justify-between mb-3">
                <h3 className="text-base font-bold text-slate-900 dark:text-white">
                  Install on iPhone / iPad
                </h3>
                <button
                  onClick={() => setShowIOSGuide(false)}
                  className="w-8 h-8 rounded-full flex items-center justify-center text-slate-500 hover:bg-slate-100 dark:hover:bg-white/10"
                >
                  <X size={16} />
                </button>
              </div>
              <p className="text-xs sm:text-sm text-slate-600 dark:text-slate-300 space-y-2 leading-relaxed">
                1. Tap the <strong>Share</strong> button in your Safari toolbar.<br />
                2. Scroll down and tap <strong>Add to Home Screen</strong>.
              </p>
              <button
                onClick={() => setShowIOSGuide(false)}
                className="mt-5 w-full rounded-full bg-indigo-600 py-2.5 text-xs font-bold text-white hover:bg-indigo-700 transition cursor-pointer"
              >
                Got it
              </button>
            </div>
          </div>
        )}
      </>
    );
  }

  return null;
};
