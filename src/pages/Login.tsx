import React, { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { AlertTriangle, ArrowRight } from 'lucide-react';
import { useAuth } from '../lib/AuthContext';
import { triggerHaptic } from '../lib/haptics';

export function Login() {
  const { signInWithGoogle } = useAuth();
  const [error, setError] = useState(() => {
    const forcedMsg = localStorage.getItem('adminLogoutMessage');
    if (forcedMsg) {
      localStorage.removeItem('adminLogoutMessage');
      return forcedMsg;
    }
    return '';
  });
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    const consumePendingMessage = () => {
      const msg = localStorage.getItem('adminLogoutMessage');
      if (msg) {
        localStorage.removeItem('adminLogoutMessage');
        setError(msg);
        triggerHaptic('error');
      }
    };
    consumePendingMessage();

    const handleBlockedEvent = (e: Event) => {
      const customEvt = e as CustomEvent<string>;
      const detailMsg = customEvt?.detail || localStorage.getItem('adminLogoutMessage');
      if (detailMsg) {
        localStorage.removeItem('adminLogoutMessage');
        setError(detailMsg);
        triggerHaptic('error');
      }
    };

    window.addEventListener('adminLogoutMessage', handleBlockedEvent);
    return () => window.removeEventListener('adminLogoutMessage', handleBlockedEvent);
  }, []);

  const handleGoogleAuth = async () => {
    setLoading(true);
    setError('');
    try {
      await signInWithGoogle();
      const pendingBlockedMsg = localStorage.getItem('adminLogoutMessage');
      if (pendingBlockedMsg) {
        localStorage.removeItem('adminLogoutMessage');
        setError(pendingBlockedMsg);
        triggerHaptic('error');
        return;
      }
      triggerHaptic('success');
    } catch (err: any) {
      console.error(err);
      
      const stringError = (err.message || err.code || '').toLowerCase();

      if (stringError.includes('blocked by the administrator') || stringError.includes('account has been blocked')) {
        localStorage.removeItem('adminLogoutMessage');
        setError('Your account has been blocked by the administrator. You cannot log in to this app.');
        triggerHaptic('error');
        return;
      }
      
      let friendlyError = '';
      if (stringError.includes('unauthorized-domain')) {
        friendlyError = "Security check failed: This domain is not authorized. If you're building the app, please add this URL to your Firebase Authorized Domains.";
      } else if (
        stringError === '10' ||
        stringError.includes('error 10') ||
        stringError.includes('code 10') ||
        stringError.includes('statuscode=10') ||
        stringError.includes('developer_error') ||
        stringError.includes('10:')
      ) {
        friendlyError = "Google Sign-In Error 10 (Developer Error): Ensure your APK signing SHA-1 certificate (e.g. 32:1E:14:73:A7:38:FD:78:C7:10:EB:DE:08:B7:1D:A1:9C:28:F3:0A) is registered under com.smartrooti.billing in Firebase Console.";
      } else if (stringError.includes('popup-closed-by-user') || stringError.includes('cancelled') || stringError.includes('canceled')) {
        friendlyError = "Your sign-in request was cancelled. Please try again.";
      } else if (stringError.includes('network-request-failed')) {
        friendlyError = "Network connection failed. Please check your internet and try again.";
      } else if (stringError.includes('invalid-api-key')) {
        friendlyError = "Configuration error: The Firebase API Key is missing or invalid.";
      } else {
        friendlyError = err.message || 'We could not sign you in right now. Please try again later.';
      }
      
      setError(friendlyError);
      triggerHaptic('error');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center p-6 relative overflow-hidden">
      
      {/* Decorative Background Elements specific to Login */}
      <div className="absolute inset-0 pointer-events-none overflow-hidden -z-10">
          <motion.div 
             initial={{ opacity: 0, scale: 0.8 }}
             animate={{ opacity: 0.5, scale: 1 }}
             transition={{ duration: 1.5, ease: "easeOut" }}
             className="absolute top-[-10%] right-[-10%] w-[50vw] h-[50vw] rounded-full bg-[radial-gradient(circle_at_center,theme(colors.indigo.400)_0%,transparent_70%)] dark:bg-[radial-gradient(circle_at_center,theme(colors.indigo.900/60)_0%,transparent_70%)] blur-3xl opacity-50" 
          />
      </div>

      <motion.div 
        initial={{ opacity: 0, y: 30 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.6, ease: [0.16, 1, 0.3, 1] }}
        className="w-full max-w-sm"
      >
        <div className="text-center mb-10">
            <motion.div 
               initial={{ scale: 0, rotate: -90 }} 
               animate={{ scale: 1, rotate: 0 }} 
               transition={{ type: "spring", damping: 15, stiffness: 200, delay: 0.1 }}
               className="w-24 h-24 rounded-[2rem] flex items-center justify-center mx-auto mb-6 shadow-2xl shadow-indigo-600/40 relative overflow-hidden border border-white/10"
            >
                <img
                  src="/pwa-192x192.png"
                  alt="SmartPOS Logo"
                  referrerPolicy="no-referrer"
                  className="w-full h-full object-cover"
                />
            </motion.div>
            
            <motion.h1 
               initial={{ opacity: 0, y: 10 }}
               animate={{ opacity: 1, y: 0 }}
               transition={{ delay: 0.2 }}
               className="text-3xl font-black tracking-tight text-slate-900 dark:text-slate-100"
            >
               SmartRooti <br/> <span className="text-indigo-600 dark:text-indigo-400">Management</span>
            </motion.h1>
            
            <motion.p 
               initial={{ opacity: 0 }}
               animate={{ opacity: 1 }}
               transition={{ delay: 0.3 }}
               className="text-slate-500 mt-3 font-medium text-lg leading-relaxed"
            >
               Welcome back. <br className="hidden sm:block"/> Please sign in to access your dashboard.
            </motion.p>
        </div>

        <motion.div 
             initial={{ opacity: 0, y: 20 }}
             animate={{ opacity: 1, y: 0 }}
             transition={{ delay: 0.4 }}
             className="relative z-10"
        >
            <AnimatePresence mode="wait">
              {error && (
                <motion.div 
                  initial={{ opacity: 0, height: 0, scale: 0.95 }}
                  animate={{ opacity: 1, height: 'auto', scale: 1 }}
                  exit={{ opacity: 0, height: 0, scale: 0.95 }}
                  className="bg-red-50 dark:bg-red-500/10 text-red-600 dark:text-red-400 p-4 rounded-2xl mb-6 flex items-start gap-3 border border-red-200 dark:border-red-500/20 shadow-sm"
                >
                  <AlertTriangle size={20} className="shrink-0 mt-0.5" />
                  <p className="text-sm font-medium">{error}</p>
                </motion.div>
              )}
            </AnimatePresence>

            <motion.button 
              whileHover={{ scale: 1.02 }}
              whileTap={{ scale: 0.98 }}
              disabled={loading}
              onClick={handleGoogleAuth}
              type="button"
              className="w-full bg-white dark:bg-slate-900 border-2 border-slate-200 dark:border-slate-800 hover:border-indigo-500 dark:hover:border-indigo-500/50 flex items-center justify-center gap-4 py-5 rounded-[1.5rem] font-bold text-slate-700 dark:text-slate-200 transition-all shadow-xl shadow-slate-200/50 dark:shadow-none group relative overflow-hidden disabled:opacity-70 disabled:cursor-not-allowed"
            >
              <div className="absolute inset-0 bg-indigo-50/50 dark:bg-indigo-500/5 opacity-0 group-hover:opacity-100 transition-opacity"></div>
              
              {loading ? (
                  <span className="w-6 h-6 border-3 border-indigo-200 border-t-indigo-600 rounded-full animate-spin z-10" />
              ) : (
                <>
                  <svg viewBox="0 0 24 24" width="28" height="28" xmlns="http://www.w3.org/2000/svg" className="z-10">
                    <g transform="matrix(1, 0, 0, 1, 27.009001, -39.238998)">
                      <path fill="#4285F4" d="M -3.264 51.509 C -3.264 50.719 -3.334 49.969 -3.454 49.239 L -14.754 49.239 L -14.754 53.419 L -8.284 53.419 C -8.554 54.819 -9.414 55.979 -10.564 56.759 L -10.564 59.479 L -6.704 59.479 C -4.434 57.379 -3.264 54.669 -3.264 51.509 Z"/>
                      <path fill="#34A853" d="M -14.754 63.239 C -11.514 63.239 -8.804 62.159 -6.824 60.329 L -10.684 57.609 C -11.764 58.339 -13.134 58.749 -14.754 58.749 C -17.884 58.749 -20.534 56.629 -21.484 53.799 L -25.464 53.799 L -25.464 56.889 C -23.494 60.809 -19.424 63.239 -14.754 63.239 Z"/>
                      <path fill="#FBBC05" d="M -21.484 53.799 C -21.734 53.049 -21.864 52.259 -21.864 51.449 C -21.864 50.639 -21.724 49.849 -21.484 49.099 L -21.484 46.009 L -25.464 46.009 C -26.284 47.649 -26.754 49.499 -26.754 51.449 C -26.754 53.399 -26.284 55.249 -25.464 56.889 L -21.484 53.799 Z"/>
                      <path fill="#EA4335" d="M -14.754 44.149 C -12.984 44.149 -11.394 44.759 -10.144 45.959 L -6.594 42.409 C -8.764 40.389 -11.514 39.239 -14.754 39.239 C -19.424 39.239 -23.494 41.669 -25.464 45.589 L -21.484 48.679 C -20.534 45.849 -17.884 44.149 -14.754 44.149 Z"/>
                    </g>
                  </svg>
                  <span className="text-lg z-10 tracking-wide text-slate-800 dark:text-slate-100">Continue with Google</span>
                  <ArrowRight size={20} className="text-slate-400 group-hover:text-indigo-600 group-hover:translate-x-1 transition-all z-10" />
                </>
              )}
            </motion.button>
            
            <p className="mt-8 text-center text-xs font-medium text-slate-400 dark:text-slate-500 max-w-[250px] mx-auto">
                By continuing, you agree to our Terms of Service and Privacy Policy.
            </p>
        </motion.div>
      </motion.div>
    </div>
  );
}
