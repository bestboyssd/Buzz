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
} from "lucide-react";
import { useNavigate } from "react-router-dom";
import { triggerHaptic } from "../lib/haptics";
import { useAuth } from "../lib/AuthContext";
import { updateStatusBarTheme } from "../lib/capacitor";
import { isPerformanceModeEnabled, applyPerformanceMode } from "../lib/utils";

import { Capacitor } from "@capacitor/core";
import { LocalNotifications } from "@capacitor/local-notifications";
import metadata from "../../metadata.json";
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

export function Settings() {
  const navigate = useNavigate();
  const { user } = useAuth();

  const getAppVersion = () => {
    try {
      const name = (metadata as any).name || "";
      const match = name.match(/(?:v)?(\d+\.\d+\.\d+)/i);
      return match ? match[1] : "1.0.0";
    } catch (e) {
      return "1.0.0";
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
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{
        opacity: 0,
        y: -10,
        transition: { duration: 0.2, ease: [0.16, 1, 0.3, 1] },
      }}
      transition={{ duration: 0.3, ease: [0.16, 1, 0.3, 1] }}
      className="pb-2 px-4 pt-12 max-w-lg mx-auto"
    >
      <header className="mb-8 pl-2 flex items-center gap-4">
        <motion.button
          whileHover={{ scale: 1.06, x: -1 }}
          whileTap={{ scale: 0.9 }}
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
      </header>

      <div className="space-y-6">
        {/* Appearance */}
        <section>
          <h2 className="text-xs font-bold uppercase tracking-widest text-slate-400 mb-3 pl-2">
            Appearance
          </h2>
          <div className="glass-card overflow-hidden divide-y divide-slate-100/50 dark:divide-white/10">
            <SettingItem
              icon={<Moon size={20} className="text-indigo-500" />}
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
        </section>

        {/* Preferences */}
        <section>
          <h2 className="text-xs font-bold uppercase tracking-widest text-slate-400 mb-3 pl-2">
            Preferences
          </h2>
          <div className="glass-card overflow-hidden divide-y divide-slate-100/50 dark:divide-white/10">
            <SettingItem
              icon={<Vibrate size={20} className="text-emerald-500" />}
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
              icon={<Bell size={20} className="text-rose-500" />}
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
        </section>

        {/* Data & Security */}
        <section>
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
        </section>

        {/* Support */}
        <section>
          <h2 className="text-xs font-bold uppercase tracking-widest text-slate-400 mb-3 pl-2">
            Support
          </h2>
          <div className="glass-card overflow-hidden divide-y divide-slate-100/50 dark:divide-white/10">
            <PWAInstallButton />
            <SettingItem
              icon={<Smartphone size={20} className="text-slate-500" />}
              label="App Version"
              description={getAppVersion()}
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
        </section>
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
  description?: string;
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
            <p className="text-[11px] sm:text-xs text-slate-500 dark:text-slate-400 leading-snug break-words mt-0.5">
              {description}
            </p>
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
