import React, { useState, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { motion, AnimatePresence } from 'motion/react';
import { Shield, Settings, X, LogOut, User } from 'lucide-react';
import { useAuth } from '../lib/AuthContext';
import { triggerHaptic } from '../lib/haptics';
import { useNavigate } from 'react-router-dom';

export function ProfileMenu() {
  const { user, isAdmin, signOut } = useAuth();
  const [isOpen, setIsOpen] = useState(false);
  const [imageError, setImageError] = useState(false);
  const navigate = useNavigate();

  useEffect(() => {
    setImageError(false);
  }, [user?.photoURL]);

  useEffect(() => {
    const handlePhotoUpdated = () => {
      setImageError(false);
    };
    window.addEventListener("profilePhotoUpdated", handlePhotoUpdated);
    return () => window.removeEventListener("profilePhotoUpdated", handlePhotoUpdated);
  }, []);

  return (
    <>
      <div className="flex items-center gap-2">
        <motion.button
          type="button"
          whileTap={{ scale: 0.92 }}
          transition={{ duration: 0.12, ease: [0.16, 1, 0.3, 1] }}
          onClick={() => {
            triggerHaptic("heavy");
            setIsOpen(true);
          }}
          className="w-10 h-10 rounded-full bg-slate-200 dark:bg-slate-700 flex items-center justify-center text-sm font-bold text-indigo-600 dark:text-indigo-400 shadow-sm transition-colors duration-150 outline-none hover:bg-slate-300 dark:hover:bg-slate-600 overflow-hidden shrink-0 transform-gpu cursor-pointer"
        >
          {user?.photoURL && !imageError ? (
            <img
              src={user.photoURL}
              alt="Profile"
              draggable={false}
              className="w-full h-full rounded-full object-cover border-[3px] border-slate-300 dark:border-slate-500 pointer-events-none"
              referrerPolicy="no-referrer"
              onError={() => setImageError(true)}
            />
          ) : (
            <div className="w-full h-full rounded-full flex items-center justify-center text-xs font-black uppercase tracking-tight text-indigo-600 dark:text-indigo-400 bg-indigo-50 dark:bg-indigo-950/40 pointer-events-none">
              {user?.displayName ? user.displayName.slice(0, 2) : "SR"}
            </div>
          )}
        </motion.button>
      </div>

      {createPortal(
        <AnimatePresence>
          {isOpen && (
            <div className="fixed inset-0 z-[100] flex items-end sm:items-center justify-center p-4 sm:p-0">
              <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.16, ease: "easeOut" }}
                onClick={() => setIsOpen(false)}
                className="absolute inset-0 bg-slate-900/40 dark:bg-slate-950/65 backdrop-blur-md transform-gpu"
              />
              <motion.div
                initial={{ opacity: 0, y: 24, scale: 0.96 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0, y: 16, scale: 0.96 }}
                transition={{
                  duration: 0.18,
                  ease: [0.16, 1, 0.3, 1],
                }}
                className="bg-[#fcf8ff] dark:bg-[#161923] border border-slate-200/80 dark:border-white/[0.08] shadow-2xl w-full max-w-sm p-6 relative z-10 overflow-hidden rounded-[2.25rem] transform-gpu will-change-transform"
              >
                <div className="flex justify-between items-center mb-6">
                  <div>
                    <div className="flex items-center gap-2">
                      <h2 className="text-xl font-bold text-slate-900 dark:text-slate-100">
                        Quick Actions
                      </h2>
                      {isAdmin ? (
                        <span className="px-2 py-0.5 rounded-full text-[10px] font-black uppercase tracking-wider bg-indigo-100 text-indigo-700 dark:bg-indigo-950/60 dark:text-indigo-300 border border-indigo-200 dark:border-indigo-800">
                          Admin
                        </span>
                      ) : (
                        <span className="px-2 py-0.5 rounded-full text-[10px] font-bold text-slate-500 bg-slate-100 dark:bg-slate-800 dark:text-slate-400">
                          User
                        </span>
                      )}
                    </div>
                    {user?.email && (
                      <p className="text-xs font-mono text-slate-500 mt-0.5">
                        {user.email}
                      </p>
                    )}
                  </div>
                  <button
                    type="button"
                    onClick={() => setIsOpen(false)}
                    className="p-2 bg-slate-100/80 dark:bg-slate-800/80 hover:bg-slate-200 dark:hover:bg-slate-700 active:scale-95 rounded-full text-slate-500 dark:text-slate-400 transition-colors duration-150 cursor-pointer"
                  >
                    <X size={20} />
                  </button>
                </div>

                <div className="space-y-2 text-slate-900 dark:text-slate-100">
                  <button 
                    type="button"
                    onClick={() => { triggerHaptic('light'); setIsOpen(false); navigate('/account'); }}
                    className="w-full flex items-center gap-4 p-4 rounded-2xl hover:bg-slate-100/80 dark:hover:bg-slate-800/60 active:scale-[0.99] transition-colors duration-150 text-left cursor-pointer"
                  >
                    <div className="w-10 h-10 rounded-full bg-blue-50 dark:bg-blue-500/20 flex items-center justify-center text-blue-600 dark:text-blue-400 shrink-0">
                      <User size={20} />
                    </div>
                    <div>
                      <h3 className="font-bold">My Account</h3>
                      <p className="text-xs text-slate-500 dark:text-slate-400">Profile & Sign out</p>
                    </div>
                  </button>
                  
                  <button 
                    type="button"
                    onClick={() => { triggerHaptic('medium'); setIsOpen(false); navigate('/admin'); }}
                    className="w-full flex items-center gap-4 p-4 rounded-2xl hover:bg-slate-100/80 dark:hover:bg-slate-800/60 active:scale-[0.99] transition-colors duration-150 text-left cursor-pointer"
                  >
                    <div className="w-10 h-10 rounded-full bg-indigo-50 dark:bg-indigo-500/20 flex items-center justify-center text-indigo-600 dark:text-indigo-400 shrink-0">
                      <Shield size={20} />
                    </div>
                    <div>
                      <h3 className="font-bold">Admin</h3>
                      <p className="text-xs text-slate-500 dark:text-slate-400">Analytics and all bills</p>
                    </div>
                  </button>

                  <button 
                    type="button"
                    onClick={() => { triggerHaptic('light'); setIsOpen(false); navigate('/settings'); }}
                    className="w-full flex items-center gap-4 p-4 rounded-2xl hover:bg-slate-100/80 dark:hover:bg-slate-800/60 active:scale-[0.99] transition-colors duration-150 text-left cursor-pointer"
                  >
                    <div className="w-10 h-10 rounded-full bg-slate-100 dark:bg-slate-700 flex items-center justify-center text-slate-600 dark:text-slate-400 shrink-0">
                      <Settings size={20} />
                    </div>
                    <div>
                      <h3 className="font-bold">Settings</h3>
                      <p className="text-xs text-slate-500 dark:text-slate-400">App configuration</p>
                    </div>
                  </button>
                </div>
              </motion.div>
            </div>
          )}
        </AnimatePresence>,
        document.body
      )}
    </>
  );
}
