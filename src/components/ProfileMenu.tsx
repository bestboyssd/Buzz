import React, { useState, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { motion, AnimatePresence } from 'motion/react';
import { Shield, Settings, X, User } from 'lucide-react';
import { useAuth } from '../lib/AuthContext';
import { triggerHaptic } from '../lib/haptics';
import { useNavigate } from 'react-router-dom';

const sheetVariants = {
  hidden: {
    opacity: 0,
    y: 28,
    scale: 0.92,
    filter: 'blur(6px)',
  },
  visible: {
    opacity: 1,
    y: 0,
    scale: 1,
    filter: 'blur(0px)',
    transition: {
      type: 'spring' as const,
      stiffness: 410,
      damping: 31,
      mass: 0.78,
      staggerChildren: 0.045,
      delayChildren: 0.02,
    },
  },
  exit: {
    opacity: 0,
    y: 18,
    scale: 0.95,
    filter: 'blur(4px)',
    transition: {
      duration: 0.16,
      ease: [0.32, 0, 0.67, 0] as [number, number, number, number],
      staggerChildren: 0.02,
      staggerDirection: -1,
    },
  },
};

const itemVariants = {
  hidden: {
    opacity: 0,
    y: 12,
    scale: 0.97,
  },
  visible: {
    opacity: 1,
    y: 0,
    scale: 1,
    transition: {
      type: 'spring' as const,
      stiffness: 460,
      damping: 32,
      mass: 0.7,
    },
  },
  exit: {
    opacity: 0,
    y: 6,
    scale: 0.98,
    transition: {
      duration: 0.11,
      ease: 'easeIn' as const,
    },
  },
};

export function ProfileMenu() {
  const { user, isAdmin } = useAuth();
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

  useEffect(() => {
    if (!isOpen) return;
    const handleAndroidBack = (e: Event) => {
      e.preventDefault();
      setIsOpen(false);
    };
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setIsOpen(false);
    };
    window.addEventListener('androidBackPress', handleAndroidBack);
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('androidBackPress', handleAndroidBack);
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [isOpen]);

  return (
    <>
      <div className="flex items-center gap-2">
        <motion.button
          type="button"
          whileHover={{ scale: 1.04 }}
          whileTap={{ scale: 0.9 }}
          animate={{ scale: isOpen ? 0.94 : 1 }}
          transition={{ type: "spring", stiffness: 500, damping: 28 }}
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
        <AnimatePresence mode="wait">
          {isOpen && (
            <div className="fixed inset-0 z-[100] flex items-end sm:items-center justify-center p-4 sm:p-0">
              <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
                onClick={() => {
                  triggerHaptic("light");
                  setIsOpen(false);
                }}
                className="absolute inset-0 bg-slate-900/45 dark:bg-slate-950/70 backdrop-blur-md transform-gpu"
              />
              <motion.div
                variants={sheetVariants}
                initial="hidden"
                animate="visible"
                exit="exit"
                className="bg-[#fcf8ff] dark:bg-[#161923] border border-slate-200/80 dark:border-white/[0.08] shadow-2xl w-full max-w-sm p-6 relative z-10 overflow-hidden rounded-[2.25rem] origin-bottom sm:origin-center transform-gpu will-change-[transform,opacity,filter]"
              >
                <motion.div
                  variants={itemVariants}
                  className="flex justify-between items-center mb-6"
                >
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
                  <motion.button
                    type="button"
                    whileHover={{ scale: 1.06, rotate: 90 }}
                    whileTap={{ scale: 0.9 }}
                    transition={{ type: "spring", stiffness: 450, damping: 26 }}
                    onClick={() => {
                      triggerHaptic("light");
                      setIsOpen(false);
                    }}
                    className="p-2 bg-slate-100/80 dark:bg-slate-800/80 hover:bg-slate-200 dark:hover:bg-slate-700 rounded-full text-slate-500 dark:text-slate-400 transition-colors duration-150 cursor-pointer"
                  >
                    <X size={20} />
                  </motion.button>
                </motion.div>

                <div className="space-y-2 text-slate-900 dark:text-slate-100">
                  <motion.button
                    type="button"
                    variants={itemVariants}
                    whileHover={{ x: 3 }}
                    whileTap={{ scale: 0.975 }}
                    onClick={() => {
                      triggerHaptic('light');
                      setIsOpen(false);
                      navigate('/account');
                    }}
                    className="w-full flex items-center gap-4 p-4 rounded-2xl hover:bg-slate-100/80 dark:hover:bg-slate-800/60 transition-colors duration-150 text-left cursor-pointer"
                  >
                    <div className="w-10 h-10 rounded-full bg-blue-50 dark:bg-blue-500/20 flex items-center justify-center text-blue-600 dark:text-blue-400 shrink-0">
                      <User size={20} />
                    </div>
                    <div>
                      <h3 className="font-bold">My Account</h3>
                      <p className="text-xs text-slate-500 dark:text-slate-400">Profile & Sign out</p>
                    </div>
                  </motion.button>

                  <motion.button
                    type="button"
                    variants={itemVariants}
                    whileHover={{ x: 3 }}
                    whileTap={{ scale: 0.975 }}
                    onClick={() => {
                      triggerHaptic('medium');
                      setIsOpen(false);
                      navigate('/admin');
                    }}
                    className="w-full flex items-center gap-4 p-4 rounded-2xl hover:bg-slate-100/80 dark:hover:bg-slate-800/60 transition-colors duration-150 text-left cursor-pointer"
                  >
                    <div className="w-10 h-10 rounded-full bg-indigo-50 dark:bg-indigo-500/20 flex items-center justify-center text-indigo-600 dark:text-indigo-400 shrink-0">
                      <Shield size={20} />
                    </div>
                    <div>
                      <h3 className="font-bold">Admin</h3>
                      <p className="text-xs text-slate-500 dark:text-slate-400">Analytics and all bills</p>
                    </div>
                  </motion.button>

                  <motion.button
                    type="button"
                    variants={itemVariants}
                    whileHover={{ x: 3 }}
                    whileTap={{ scale: 0.975 }}
                    onClick={() => {
                      triggerHaptic('light');
                      setIsOpen(false);
                      navigate('/settings');
                    }}
                    className="w-full flex items-center gap-4 p-4 rounded-2xl hover:bg-slate-100/80 dark:hover:bg-slate-800/60 transition-colors duration-150 text-left cursor-pointer"
                  >
                    <div className="w-10 h-10 rounded-full bg-slate-100 dark:bg-slate-700 flex items-center justify-center text-slate-600 dark:text-slate-400 shrink-0">
                      <Settings size={20} />
                    </div>
                    <div>
                      <h3 className="font-bold">Settings</h3>
                      <p className="text-xs text-slate-500 dark:text-slate-400">App configuration</p>
                    </div>
                  </motion.button>
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
