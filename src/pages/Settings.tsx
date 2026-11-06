import React, { useState, useEffect } from "react";
import { motion } from "motion/react";
import {
  ArrowLeft,
  Moon,
  Sun,
  Cloud,
  Vibrate,
  Shield,
  Smartphone,
  Bell,
  ChevronRight,
  Printer,
  Zap,
  Download,
} from "lucide-react";
import { useNavigate } from "react-router-dom";
import { triggerHaptic } from "../lib/haptics";
import { useAuth } from "../lib/AuthContext";
import { updateStatusBarTheme } from "../lib/capacitor";
import { isPerformanceModeEnabled, applyPerformanceMode } from "../lib/utils";

import { Capacitor } from "@capacitor/core";
import { LocalNotifications } from "@capacitor/local-notifications";
import { db } from "../lib/firebase";
import { doc, setDoc } from "firebase/firestore";
import { PWAInstallButton } from "../components/PWAInstallButton";
import {
  PrinterState,
  getPrinterState,
  subscribePrinterState,
  connectRealPrinter,
  disconnectRealPrinter,
} from "../lib/printerManager";
import {
  useAppVersionCheck,
  compareSemver,
  triggerInstantApkDownload,
} from "../lib/versionCheck";

export function Settings() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const {
    appVersion,
    latestRelease,
    checkingVersion,
    isOutdated,
    isUpdated,
    refreshVersionCheck,
    downloadState,
  } = useAppVersionCheck();

  const handleAppVersionClick = async () => {
    if (downloadState.isDownloading) return;
    if (isOutdated && latestRelease) {
      triggerHaptic("heavy");
      triggerInstantApkDownload(
        latestRelease.downloadUrl,
        latestRelease.version,
        latestRelease.sizeBytes
      );
      return;
    }

    triggerHaptic("light");
    const result = await refreshVersionCheck();
    if (
      result?.release &&
      compareSemver(result.release.version, result.currentVer) > 0
    ) {
      triggerHaptic("heavy");
      triggerInstantApkDownload(
        result.release.downloadUrl,
        result.release.version,
        result.release.sizeBytes
      );
    }
  };

  const getStorageKey = (key: string) => (user ? `${key}_${user.uid}` : key);

  const [darkMode, setDarkMode] = useState(() => {
    const stored = localStorage.getItem(getStorageKey("theme")) || localStorage.getItem("theme");
    if (stored === "dark" || stored === "light") {
      return stored === "dark";
    }
    return document.documentElement.classList.contains("dark");
  });
  const [performanceMode, setPerformanceMode] = useState(() =>
    isPerformanceModeEnabled(user?.uid)
  );
  const [haptics, setHaptics] = useState(
    () => localStorage.getItem(getStorageKey("hapticsEnabled")) !== "false"
  );
  const [notifications, setNotifications] = useState(
    () => localStorage.getItem(getStorageKey("notifications")) !== "false"
  );
  const [keepScreenOn, setKeepScreenOn] = useState(() => {
    const resetKey = user ? `keepScreenOn_reset_v2_${user.uid}` : "keepScreenOn_reset_v2";
    if (localStorage.getItem(resetKey) !== "true") {
      localStorage.setItem(resetKey, "true");
      localStorage.setItem("keepScreenOn", "false");
      localStorage.setItem(getStorageKey("keepScreenOn"), "false");
      return false;
    }
    return localStorage.getItem(getStorageKey("keepScreenOn")) === "true";
  });
  const [printerState, setPrinterState] = useState<PrinterState>(() =>
    getPrinterState()
  );

  useEffect(() => {
    return subscribePrinterState((state) => {
      setPrinterState(state);
    });
  }, []);

  useEffect(() => {
    const stored = localStorage.getItem(getStorageKey("theme")) || localStorage.getItem("theme");
    setDarkMode(
      stored === "dark" || stored === "light"
        ? stored === "dark"
        : document.documentElement.classList.contains("dark")
    );
    setPerformanceMode(isPerformanceModeEnabled(user?.uid));
    setHaptics(
      localStorage.getItem(getStorageKey("hapticsEnabled")) !== "false"
    );
    setNotifications(
      localStorage.getItem(getStorageKey("notifications")) !== "false"
    );
    const resetKey = user ? `keepScreenOn_reset_v2_${user.uid}` : "keepScreenOn_reset_v2";
    if (localStorage.getItem(resetKey) !== "true") {
      localStorage.setItem(resetKey, "true");
      localStorage.setItem("keepScreenOn", "false");
      localStorage.setItem(getStorageKey("keepScreenOn"), "false");
      setKeepScreenOn(false);
    } else {
      setKeepScreenOn(
        localStorage.getItem(getStorageKey("keepScreenOn")) === "true"
      );
    }
  }, [user]);

  useEffect(() => {
    const handleKeepScreenChanged = () => {
      setKeepScreenOn(
        localStorage.getItem(getStorageKey("keepScreenOn")) === "true"
      );
    };
    window.addEventListener("keepScreenOnChanged", handleKeepScreenChanged);
    return () => window.removeEventListener("keepScreenOnChanged", handleKeepScreenChanged);
  }, [user]);

  useEffect(() => {
    const handlePerfChanged = (e: Event) => {
      const customEvt = e as CustomEvent<{ enabled?: boolean }>;
      if (customEvt.detail?.enabled !== undefined) {
        setPerformanceMode(Boolean(customEvt.detail.enabled));
      } else {
        setPerformanceMode(isPerformanceModeEnabled(user?.uid));
      }
    };
    window.addEventListener("performanceModeChanged", handlePerfChanged);
    return () => window.removeEventListener("performanceModeChanged", handlePerfChanged);
  }, [user]);

  useEffect(() => {
    const handleThemeChanged = (e: Event) => {
      const customEvt = e as CustomEvent<{ theme?: "dark" | "light" }>;
      if (customEvt.detail?.theme) {
        setDarkMode(customEvt.detail.theme === "dark");
      } else {
        setDarkMode(document.documentElement.classList.contains("dark"));
      }
    };
    window.addEventListener("themeChanged", handleThemeChanged);
    return () => window.removeEventListener("themeChanged", handleThemeChanged);
  }, []);

  const updateSettingInFirestore = (key: string, value: any, extra?: Record<string, any>) => {
    if (!user) return;
    setDoc(
      doc(db, "settings", `profile_${user.uid}`),
      {
        [key]: value,
        ...(extra || {}),
        updatedAt: Date.now(),
      },
      { merge: true }
    ).catch((e) => {
      console.warn("Failed to persist setting in Firestore:", e);
    });
  };

  const toggleDarkMode = (checked: boolean) => {
    triggerHaptic("medium");
    setDarkMode(checked);
    const value = checked ? "dark" : "light";
    if (checked) {
      document.documentElement.classList.add("dark");
      localStorage.setItem("theme", "dark");
      localStorage.setItem(getStorageKey("theme"), "dark");
      updateStatusBarTheme(true);
    } else {
      document.documentElement.classList.remove("dark");
      localStorage.setItem("theme", "light");
      localStorage.setItem(getStorageKey("theme"), "light");
      updateStatusBarTheme(false);
    }
    window.dispatchEvent(new CustomEvent("themeChanged", { detail: { theme: value } }));
    updateSettingInFirestore("theme", value);
  };

  const togglePerformanceMode = (checked: boolean) => {
    triggerHaptic("medium");
    setPerformanceMode(checked);
    applyPerformanceMode(checked, user?.uid);
    updateSettingInFirestore("performanceMode", checked);
  };

  const toggleHaptics = (checked: boolean) => {
    setHaptics(checked);
    localStorage.setItem(getStorageKey("hapticsEnabled"), checked.toString());
    if (checked) triggerHaptic("medium");
    updateSettingInFirestore("hapticsEnabled", checked);
  };

  const toggleNotifications = async (checked: boolean) => {
    triggerHaptic("medium");
    if (checked) {
      setNotifications(true);
      localStorage.setItem(getStorageKey("notifications"), "true");
      updateSettingInFirestore("notifications", true);
      try {
        if (Capacitor.isNativePlatform()) {
          const { display } = await LocalNotifications.requestPermissions();
          if (display === "granted") {
            await LocalNotifications.schedule({
              notifications: [
                {
                  title: "Notifications enabled!",
                  body: "You will receive useful alerts.",
                  id: 1,
                  schedule: { at: new Date(Date.now() + 1000) },
                },
              ],
            });
          }
        } else if ("Notification" in window) {
          Notification.requestPermission()
            .then((permission) => {
              if (permission === "granted") {
                new Notification("Notifications enabled!", {
                  body: "You will receive useful alerts.",
                });
              }
            })
            .catch((e) => console.warn("Notification permission error:", e));
        }
      } catch (e) {
        console.warn("Notification permission error:", e);
      }
    } else {
      setNotifications(false);
      localStorage.setItem(getStorageKey("notifications"), "false");
      updateSettingInFirestore("notifications", false);
    }
  };

  const toggleKeepScreenOn = async (checked: boolean) => {
    triggerHaptic("medium");
    setKeepScreenOn(checked);
    const resetKey = user ? `keepScreenOn_reset_v2_${user.uid}` : "keepScreenOn_reset_v2";
    localStorage.setItem(resetKey, "true");
    localStorage.setItem("keepScreenOn", checked.toString());
    localStorage.setItem(getStorageKey("keepScreenOn"), checked.toString());
    window.dispatchEvent(new Event("keepScreenOnChanged"));
    updateSettingInFirestore("keepScreenOn", checked, { keepScreenOnResetV2: true });
  };

  const togglePrinterConnected = async () => {
    if (printerState.connecting) return;
    triggerHaptic("medium");
    if (printerState.connected) {
      await disconnectRealPrinter();
      triggerHaptic("light");
    } else {
      const ok = await connectRealPrinter();
      triggerHaptic(ok ? "success" : "error");
    }
  };

  return (
    <motion.div
      initial={performanceMode ? false : { opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={
        performanceMode
          ? undefined
          : {
              opacity: 0,
              y: -10,
              transition: { duration: 0.2, ease: [0.16, 1, 0.3, 1] },
            }
      }
      transition={
        performanceMode
          ? { duration: 0 }
          : { duration: 0.3, ease: [0.16, 1, 0.3, 1] }
      }
      className="pb-2 px-4 pt-12 max-w-lg mx-auto"
    >
      <motion.header
        initial={performanceMode ? false : { opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={
          performanceMode
            ? { duration: 0 }
            : { type: "spring", stiffness: 420, damping: 30, mass: 0.7 }
        }
        className="mb-8 pl-2 flex items-center gap-4"
      >
        <motion.button
          whileHover={performanceMode ? undefined : { scale: 1.06, x: -1 }}
          whileTap={performanceMode ? undefined : { scale: 0.9 }}
          transition={{ type: "spring", stiffness: 500, damping: 24 }}
          onClick={() => {
            triggerHaptic("heavy");
            navigate(-1);
          }}
          className="w-10 h-10 flex-shrink-0 flex items-center justify-center bg-slate-200 dark:bg-slate-700 rounded-full shadow-sm transition-colors text-slate-700 dark:text-slate-200 border border-transparent outline-none pointer-events-auto cursor-pointer"
        >
          <ArrowLeft size={20} />
        </motion.button>
        <h1 className="text-3xl font-bold tracking-tight text-slate-900 dark:text-slate-100">
          Settings
        </h1>
      </motion.header>

      <div className="space-y-6">
        {/* Appearance */}
        <motion.section
          initial={performanceMode ? false : { opacity: 0, y: 14, scale: 0.98 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          transition={
            performanceMode
              ? { duration: 0 }
              : { type: "spring", stiffness: 410, damping: 30, mass: 0.72, delay: 0.03 }
          }
        >
          <h2 className="text-xs font-bold uppercase tracking-widest text-slate-400 mb-3 pl-2">
            Appearance
          </h2>
          <div className="glass-card overflow-hidden divide-y divide-slate-100/50 dark:divide-white/10">
            <SettingItem
              icon={
                <motion.div
                  key={darkMode ? "dark-icon" : "light-icon"}
                  initial={performanceMode ? false : { rotate: -35, scale: 0.75, opacity: 0 }}
                  animate={{ rotate: 0, scale: 1, opacity: 1 }}
                  transition={
                    performanceMode
                      ? { duration: 0 }
                      : { type: "spring", stiffness: 440, damping: 22 }
                  }
                >
                  {darkMode ? (
                    <Moon size={20} className="text-indigo-500" />
                  ) : (
                    <Sun size={20} className="text-amber-500" />
                  )}
                </motion.div>
              }
              label="Dark Mode"
              description="Switch between light and dark themes"
              action={
                <Switch
                  checked={darkMode}
                  onChange={() => toggleDarkMode(!darkMode)}
                />
              }
            />
            <SettingItem
              icon={<Zap size={20} className="text-amber-500" />}
              label="Remove Animations"
              description="Disable animations to save battery"
              action={
                <Switch
                  checked={performanceMode}
                  onChange={() => togglePerformanceMode(!performanceMode)}
                />
              }
            />
          </div>
        </motion.section>

        {/* Preferences */}
        <motion.section
          initial={performanceMode ? false : { opacity: 0, y: 14, scale: 0.98 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          transition={
            performanceMode
              ? { duration: 0 }
              : { type: "spring", stiffness: 410, damping: 30, mass: 0.72, delay: 0.07 }
          }
        >
          <h2 className="text-xs font-bold uppercase tracking-widest text-slate-400 mb-3 pl-2">
            Preferences
          </h2>
          <div className="glass-card overflow-hidden divide-y divide-slate-100/50 dark:divide-white/10">
            <SettingItem
              icon={
                <motion.div
                  key={`haptics-${haptics}`}
                  animate={
                    !performanceMode && haptics
                      ? { rotate: [0, -12, 12, -8, 8, 0] }
                      : { rotate: 0 }
                  }
                  transition={{ duration: 0.35 }}
                >
                  <Vibrate size={20} className="text-emerald-500" />
                </motion.div>
              }
              label="Tactile Haptics & Audio"
              description="Vibration & subtle acoustic feedback on taps"
              action={
                <Switch
                  checked={haptics}
                  onChange={() => toggleHaptics(!haptics)}
                />
              }
            />
            <SettingItem
              icon={
                <motion.div
                  key={`notif-${notifications}`}
                  animate={
                    !performanceMode && notifications
                      ? { rotate: [0, -15, 15, -10, 10, 0] }
                      : { rotate: 0 }
                  }
                  transition={{ duration: 0.38 }}
                >
                  <Bell size={20} className="text-rose-500" />
                </motion.div>
              }
              label="Notifications"
              description="Alerts for sales and low stock"
              action={
                <Switch
                  checked={notifications}
                  onChange={() => toggleNotifications(!notifications)}
                />
              }
            />
            <SettingItem
              icon={<Smartphone size={20} className="text-blue-500" />}
              label="Keep Screen On"
              description="Prevent sleep while selling"
              action={
                <Switch
                  checked={keepScreenOn}
                  onChange={() => toggleKeepScreenOn(!keepScreenOn)}
                />
              }
            />
            <SettingItem
              icon={<Printer size={20} className="text-violet-500" />}
              label="Enable Printer"
              description={
                printerState.connecting
                  ? "Pairing thermal printer..."
                  : printerState.connected
                  ? printerState.deviceName || "Thermal printer connected"
                  : "Pair thermal receipt printer"
              }
              action={
                <Switch
                  checked={printerState.connected}
                  onChange={togglePrinterConnected}
                />
              }
            />
          </div>
        </motion.section>

        {/* Data & Security */}
        <motion.section
          initial={performanceMode ? false : { opacity: 0, y: 14, scale: 0.98 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          transition={
            performanceMode
              ? { duration: 0 }
              : { type: "spring", stiffness: 410, damping: 30, mass: 0.72, delay: 0.11 }
          }
        >
          <h2 className="text-xs font-bold uppercase tracking-widest text-slate-400 mb-3 pl-2">
            Data & Security
          </h2>
          <div className="glass-card overflow-hidden divide-y divide-slate-100/50 dark:divide-white/10">
            <SettingItem
              icon={<Shield size={20} className="text-emerald-500" />}
              label="Privacy Policy"
              description="Read our data policies"
              action={<ChevronRight size={20} className="text-slate-400" />}
              onClick={() => {
                triggerHaptic("light");
                navigate("/privacy");
              }}
            />
          </div>
        </motion.section>

        {/* Support */}
        <motion.section
          initial={performanceMode ? false : { opacity: 0, y: 14, scale: 0.98 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          transition={
            performanceMode
              ? { duration: 0 }
              : { type: "spring", stiffness: 410, damping: 30, mass: 0.72, delay: 0.15 }
          }
        >
          <h2 className="text-xs font-bold uppercase tracking-widest text-slate-400 mb-3 pl-2">
            Support
          </h2>
          <div className="glass-card overflow-hidden divide-y divide-slate-100/50 dark:divide-white/10">
            <PWAInstallButton />
            <SettingItem
              icon={<Smartphone size={20} className="text-slate-500" />}
              label="App Version"
              badge={
                downloadState.isDownloading ? (
                  <span className="px-2 py-0.5 rounded-full text-[10px] font-bold tracking-tight whitespace-nowrap border bg-indigo-500/12 text-indigo-600 dark:text-indigo-400 border-indigo-500/25">
                    {downloadState.progress}%
                  </span>
                ) : isOutdated ? (
                  <span className="px-2 py-0.5 rounded-full text-[10px] font-bold tracking-tight whitespace-nowrap border bg-rose-500/10 text-rose-600 dark:text-rose-400 border-rose-500/25">
                    Outdated
                  </span>
                ) : isUpdated ? (
                  <span className="px-2 py-0.5 rounded-full text-[10px] font-bold tracking-tight whitespace-nowrap border bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/25">
                    Updated
                  </span>
                ) : checkingVersion ? (
                  <span className="px-2 py-0.5 rounded-full text-[10px] font-bold tracking-tight whitespace-nowrap border bg-slate-100 dark:bg-slate-800/90 text-slate-500 dark:text-slate-400 border-slate-200/80 dark:border-white/[0.08]">
                    Checking...
                  </span>
                ) : null
              }
              description={
                downloadState.isDownloading ? (
                  <div className="mt-1 space-y-1">
                    <div className="flex items-center justify-between text-[11px] font-semibold text-indigo-600 dark:text-indigo-400">
                      <span>
                        Downloading v{latestRelease?.version || "latest"}...
                      </span>
                      <span className="font-mono">{downloadState.progress}%</span>
                    </div>
                    <div className="w-full h-1.5 rounded-full bg-slate-200 dark:bg-slate-800 overflow-hidden">
                      <div
                        className="h-full rounded-full bg-indigo-600 dark:bg-indigo-500 transition-all duration-150"
                        style={{
                          width: `${Math.max(4, Math.min(100, downloadState.progress))}%`,
                        }}
                      />
                    </div>
                  </div>
                ) : isOutdated && latestRelease ? (
                  <span className="inline-flex items-center flex-wrap gap-y-0.5">
                    <span className="font-mono font-semibold text-slate-500 dark:text-slate-400">
                      v{appVersion}
                    </span>
                    <span className="mx-2 text-slate-400 dark:text-slate-500 font-bold">
                      →
                    </span>
                    <span className="font-mono font-bold text-emerald-600 dark:text-emerald-400">
                      v{latestRelease.version} available
                    </span>
                    <span className="ml-2.5 text-rose-500 dark:text-rose-400 font-semibold">
                      (Tap to download)
                    </span>
                  </span>
                ) : (
                  <span className="font-mono">v{appVersion}</span>
                )
              }
              action={
                isOutdated ? (
                  <Download
                    size={18}
                    className={`text-rose-500 dark:text-rose-400 ${
                      downloadState.isDownloading ? "animate-bounce text-indigo-500 dark:text-indigo-400" : ""
                    }`}
                  />
                ) : undefined
              }
              onClick={handleAppVersionClick}
            />
            <SettingItem
              icon={<ChevronRight size={20} className="text-slate-400" />}
              label="Contact Support"
              description="dassusuman2009@gmail.com"
              onClick={() => {
                triggerHaptic("light");
                window.location.href = "mailto:dassusuman2009@gmail.com";
              }}
            />
          </div>
        </motion.section>
      </div>
    </motion.div>
  );
}

function SettingItem({
  icon,
  label,
  badge,
  description,
  action,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  badge?: React.ReactNode;
  description?: React.ReactNode;
  action?: React.ReactNode;
  onClick?: () => void;
}) {
  return (
    <motion.div
      whileTap={onClick ? { scale: 0.985 } : undefined}
      transition={{ type: "spring", stiffness: 500, damping: 30 }}
      onClick={onClick}
      className={`p-3.5 sm:p-4 flex items-center justify-between gap-3 transition-colors ${
        onClick
          ? "cursor-pointer hover:bg-[#f0ebf8]/60 dark:hover:bg-white/[0.04]"
          : ""
      }`}
    >
      <div className="flex items-center gap-3 min-w-0 flex-1">
        <div className="w-10 h-10 shrink-0 rounded-2xl bg-[#ece6f0] dark:bg-[#252936] flex items-center justify-center">
          {icon}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center flex-wrap gap-2">
            <h3 className="font-bold text-sm sm:text-base text-slate-900 dark:text-slate-100 leading-snug">
              {label}
            </h3>
            {badge}
          </div>
          {description && (
            <div className="text-[11px] sm:text-xs text-slate-500 dark:text-slate-400 leading-snug break-words mt-0.5">
              {description}
            </div>
          )}
        </div>
      </div>
      {action && <div className="shrink-0">{action}</div>}
    </motion.div>
  );
}

function Switch({
  checked,
  onChange,
}: {
  checked: boolean;
  onChange: () => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={onChange}
      className={`relative w-[52px] h-[32px] rounded-full transition-colors duration-200 flex items-center p-1 cursor-pointer outline-none ${
        checked
          ? "bg-indigo-600 dark:bg-indigo-400 border-2 border-indigo-600 dark:border-indigo-400 justify-end"
          : "bg-[#e6e0e9] dark:bg-[#2b2930] border-2 border-slate-400 dark:border-slate-500 justify-start"
      }`}
    >
      <motion.div
        layout
        transition={{
          type: "spring",
          stiffness: 500,
          damping: 30,
          mass: 0.6,
        }}
        className={`rounded-full shadow-xs ${
          checked
            ? "w-6 h-6 bg-white dark:bg-indigo-950"
            : "w-4 h-4 ml-0.5 bg-slate-600 dark:bg-slate-300"
        }`}
      />
    </button>
  );
}
