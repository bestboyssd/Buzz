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
  X,
  Radio,
  Sparkles,
  CheckCircle2,
} from "lucide-react";
import { useNavigate } from "react-router-dom";
import { triggerHaptic } from "../lib/haptics";
import { useAuth } from "../lib/AuthContext";
import { updateStatusBarTheme } from "../lib/capacitor";
import { isPerformanceModeEnabled, applyPerformanceMode } from "../lib/utils";

import { Capacitor } from "@capacitor/core";
import { LocalNotifications } from "@capacitor/local-notifications";
import { db } from "../lib/firebase";
import { doc, getDoc, getDocFromServer, setDoc } from "firebase/firestore";
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
  cancelApkDownload,
} from "../lib/versionCheck";
import { wakeUpBuzzServer, getApiBaseUrl, isCookieGatedAiStudioUrl, CLOUDFLARE_EDGE_AI_URL } from "../lib/geminiApi";

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
  const [batteryUnrestricted, setBatteryUnrestricted] = useState<boolean>(() => {
    try {
      const nativeExporter = (window as any).AndroidExporter;
      if (nativeExporter && typeof nativeExporter.isIgnoringBatteryOptimizations === "function") {
        return Boolean(nativeExporter.isIgnoringBatteryOptimizations());
      }
    } catch {}
    return true;
  });

  const [showAiModal, setShowAiModal] = useState(false);
  const [customServerUrl, setCustomServerUrl] = useState(() => localStorage.getItem("buzz_api_server_url") || "");
  const [aiTestResult, setAiTestResult] = useState<string | null>(null);
  const [isTestingAi, setIsTestingAi] = useState(false);

  const testAiConnection = async () => {
    setIsTestingAi(true);
    setAiTestResult(null);
    try {
      wakeUpBuzzServer();
      const baseUrl = getApiBaseUrl();
      const targets = Array.from(
        new Set([
          baseUrl ? `${baseUrl}/api/health` : !Capacitor.isNativePlatform() ? "/api/health" : "",
          `${CLOUDFLARE_EDGE_AI_URL}/api/health`,
        ].filter(Boolean))
      );
      for (const target of targets) {
        try {
          const res = await fetch(target, { method: "GET", cache: "no-store" });
          const contentType = res.headers.get("content-type") || "";
          if (res.ok && contentType.includes("application/json")) {
            const data = await res.json().catch(() => null);
            if (data?.status === "ok" || data?.ok) {
              setAiTestResult(
                data?.geminiConfigured === false
                  ? "Server reached, but AI key is missing on the server."
                  : data?.provider === "cloudflare-workers-ai"
                  ? "Connected! 24/7 Cloudflare Edge AI is online."
                  : "Connected! Live Buzz AI server is online."
              );
              return;
            }
          }
        } catch {}
      }

      // Check Firestore bridge config heartbeat honestly
      const bridgeRef = doc(db, "settings", "ai_bridge_config");
      const snap = await getDocFromServer(bridgeRef).catch(() => getDoc(bridgeRef).catch(() => null));
      const data = snap?.exists() ? snap.data() : null;
      const lastBeat = Number(data?.lastHeartbeat || data?.updatedAt || 0);
      const ageSec = lastBeat > 0 ? Math.round((Date.now() - lastBeat) / 1000) : Infinity;
      const serverUrl = String(data?.serverUrl || "");

      if (data?.serverOnline && ageSec < 180) {
        setAiTestResult(
          isCookieGatedAiStudioUrl(serverUrl)
            ? "Connected via Firestore RPC Bridge (AI Studio Preview is active)."
            : "Connected via Firestore RPC Bridge (Buzz AI server is online)."
        );
      } else {
        setAiTestResult(
          "AI server is currently offline. Open AI Studio preview or deploy server.ts (Render/Railway) and enter its URL above."
        );
      }
    } catch {
      setAiTestResult(
        "Could not reach Buzz AI server. Check your internet connection or configure a hosted Buzz AI Server URL above."
      );
    } finally {
      setIsTestingAi(false);
    }
  };

  const saveCustomServerUrl = (url: string) => {
    const trimmed = url.trim().replace(/\/$/, "");
    setCustomServerUrl(trimmed);
    if (trimmed) {
      localStorage.setItem("buzz_api_server_url", trimmed);
    } else {
      localStorage.removeItem("buzz_api_server_url");
    }
    wakeUpBuzzServer();
  };

  useEffect(() => {
    const syncBatteryState = () => {
      try {
        const nativeExporter = (window as any).AndroidExporter;
        if (nativeExporter && typeof nativeExporter.isIgnoringBatteryOptimizations === "function") {
          setBatteryUnrestricted(Boolean(nativeExporter.isIgnoringBatteryOptimizations()));
        }
      } catch {}
    };
    window.addEventListener("focus", syncBatteryState);
    window.addEventListener("appResumed", syncBatteryState);
    return () => {
      window.removeEventListener("focus", syncBatteryState);
      window.removeEventListener("appResumed", syncBatteryState);
    };
  }, []);

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
    updateSettingInFirestore("performanceMode", checked, { performanceModeResetV2: true });
  };

  const toggleHaptics = (checked: boolean) => {
    setHaptics(checked);
    localStorage.setItem(getStorageKey("hapticsEnabled"), checked.toString());
    if (checked) triggerHaptic("medium");
    updateSettingInFirestore("hapticsEnabled", checked);
  };

  const toggleNotifications = async (checked: boolean) => {
    triggerHaptic("medium");
    try {
      const nativeExporter = (window as any).AndroidExporter;
      if (nativeExporter && typeof nativeExporter.setNotificationsEnabled === "function") {
        nativeExporter.setNotificationsEnabled(Boolean(checked));
      }
    } catch {}
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
      initial={performanceMode ? false : { opacity: 0, y: 8, scale: 0.992 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={
        performanceMode
          ? undefined
          : {
              opacity: 0,
              y: -4,
              scale: 0.992,
              transition: { duration: 0.11, ease: [0.32, 0, 0.67, 0] },
            }
      }
      transition={
        performanceMode
          ? { duration: 0 }
          : { duration: 0.22, ease: [0.22, 1, 0.36, 1] }
      }
      className="pb-2 px-4 pt-12 max-w-lg mx-auto transform-gpu"
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
              description="Instant alerts for stock drops & bill conflicts"
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
            <SettingItem
              singleLine
              icon={
                <Radio
                  size={20}
                  className={
                    notifications && batteryUnrestricted ? "text-emerald-500" : "text-amber-500"
                  }
                />
              }
              label="Background Alerts"
              description={
                !notifications
                  ? "Enable notifications first"
                  : batteryUnrestricted
                  ? "Real-time push & sync active"
                  : "Tap to allow background sync"
              }
              action={
                <div className="flex items-center gap-1.5">
                  <span
                    className={`px-2 py-0.5 rounded-full text-[10px] font-bold tracking-tight whitespace-nowrap border ${
                      notifications && batteryUnrestricted
                        ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/25"
                        : "bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-500/25"
                    }`}
                  >
                    {!notifications ? "Paused" : batteryUnrestricted ? "Active" : "Restricted"}
                  </span>
                  <ChevronRight size={18} className="text-slate-400" />
                </div>
              }
              onClick={() => {
                triggerHaptic("light");
                try {
                  const nativeExporter = (window as any).AndroidExporter;
                  if (
                    nativeExporter &&
                    typeof nativeExporter.requestIgnoreBatteryOptimizations === "function"
                  ) {
                    nativeExporter.requestIgnoreBatteryOptimizations();
                    return;
                  }
                } catch {}
                if (!notifications) {
                  toggleNotifications(true);
                  return;
                }
                if ("Notification" in window && Notification.permission !== "granted") {
                  Notification.requestPermission().catch(() => {});
                }
              }}
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

        {/* Buzz AI Engine */}
        <motion.section
          initial={performanceMode ? false : { opacity: 0, y: 14, scale: 0.98 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          transition={
            performanceMode
              ? { duration: 0 }
              : { type: "spring", stiffness: 410, damping: 30, mass: 0.72, delay: 0.13 }
          }
        >
          <h2 className="text-xs font-bold uppercase tracking-widest text-slate-400 mb-3 pl-2">
            Buzz AI Engine
          </h2>
          <div className="glass-card overflow-hidden divide-y divide-slate-100/50 dark:divide-white/10">
            <SettingItem
              icon={<Sparkles size={20} className="text-violet-500" />}
              label="AI Bridge & Engine"
              badge={
                <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-extrabold bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border border-emerald-500/20">
                  <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />
                  Active
                </span>
              }
              description={
                customServerUrl
                  ? `Custom: ${customServerUrl}`
                  : "Automatic Firestore RPC + Cloud Bridge"
              }
              action={<ChevronRight size={20} className="text-slate-400" />}
              onClick={() => {
                triggerHaptic("light");
                setShowAiModal(true);
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
            <div>
              <SettingItem
                icon={<Smartphone size={20} className="text-slate-500" />}
                label="App Version"
                badge={
                  downloadState.isDownloading ? (
                    <span className="px-2 py-0.5 rounded-full text-[10px] font-bold tracking-tight whitespace-nowrap border bg-indigo-500/12 text-indigo-600 dark:text-indigo-400 border-indigo-500/25">
                      Updating
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
                  downloadState.status === "completed" && isOutdated ? (
                    <span className="inline-flex items-center flex-wrap gap-y-0.5 text-emerald-600 dark:text-emerald-400 font-semibold">
                      <span>v{latestRelease?.version} APK ready</span>
                      <span className="ml-2 underline">(Tap to install)</span>
                    </span>
                  ) : isOutdated && latestRelease ? (
                    <span className="inline-flex items-center flex-wrap gap-y-0.5">
                      <span className="font-mono font-semibold text-slate-500 dark:text-slate-400">
                        v{appVersion}
                      </span>
                      <span className="mx-1.5 text-slate-400 dark:text-slate-500 font-bold">
                        →
                      </span>
                      <span className="font-mono font-bold text-emerald-600 dark:text-emerald-400">
                        v{latestRelease.version}
                      </span>
                      {!downloadState.isDownloading && (
                        <span className="ml-2 text-rose-500 dark:text-rose-400 font-semibold">
                          (Tap to download)
                        </span>
                      )}
                    </span>
                  ) : (
                    <span className="font-mono">v{appVersion}</span>
                  )
                }
                action={
                  downloadState.isDownloading ? (
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        triggerHaptic("light");
                        cancelApkDownload();
                      }}
                      title="Cancel download"
                      className="w-8 h-8 rounded-full flex items-center justify-center bg-slate-100 dark:bg-white/[0.07] text-slate-500 hover:text-rose-500 hover:bg-rose-500/15 transition-colors cursor-pointer"
                    >
                      <X size={15} strokeWidth={2.5} />
                    </button>
                  ) : isOutdated ? (
                    <Download
                      size={18}
                      className="text-rose-500 dark:text-rose-400"
                    />
                  ) : undefined
                }
                onClick={handleAppVersionClick}
              />

              {downloadState.isDownloading && (
                <div className="px-3.5 sm:px-4 pb-3.5 pt-0.5">
                  <div className="p-3 rounded-2xl bg-indigo-500/[0.06] dark:bg-indigo-500/[0.09] border border-indigo-500/20 space-y-2">
                    <div className="flex items-center justify-between gap-2 text-[11px] font-bold">
                      <span className="text-indigo-700 dark:text-indigo-300 truncate">
                        Downloading v{latestRelease?.version || "latest"}
                      </span>
                      <span className="font-mono tabular-nums whitespace-nowrap text-slate-700 dark:text-slate-200 shrink-0">
                        {downloadState.totalBytes > 0
                          ? `${(downloadState.downloadedBytes / (1024 * 1024)).toFixed(1)} / ${(downloadState.totalBytes / (1024 * 1024)).toFixed(1)} MB · ${downloadState.progress}%`
                          : `${downloadState.progress}%`}
                      </span>
                    </div>
                    <div className="w-full h-2 rounded-full bg-slate-200/90 dark:bg-slate-800 overflow-hidden">
                      <div
                        className="h-full rounded-full bg-gradient-to-r from-indigo-500 to-violet-500 transition-[width] duration-150 ease-out"
                        style={{
                          width: `${Math.max(4, Math.min(100, downloadState.progress))}%`,
                        }}
                      />
                    </div>
                  </div>
                </div>
              )}

              {downloadState.status === "error" && isOutdated && (
                <div className="px-3.5 sm:px-4 pb-3.5 pt-0.5">
                  <button
                    type="button"
                    onClick={handleAppVersionClick}
                    className="w-full p-2.5 rounded-xl bg-rose-500/10 border border-rose-500/25 flex items-center justify-between gap-2 text-left cursor-pointer hover:bg-rose-500/15 transition-colors"
                  >
                    <span className="text-[11px] font-semibold text-rose-600 dark:text-rose-400 truncate">
                      {downloadState.error || "Download failed"}
                    </span>
                    <span className="text-[11px] font-extrabold text-rose-600 dark:text-rose-300 underline whitespace-nowrap shrink-0">
                      Retry
                    </span>
                  </button>
                </div>
              )}
            </div>
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

        {showAiModal && (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm">
            <div className="w-full max-w-sm p-5 rounded-3xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-white/10 shadow-2xl space-y-4">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Sparkles size={20} className="text-violet-500" />
                  <h3 className="font-bold text-base text-slate-800 dark:text-slate-100">Buzz AI Engine</h3>
                </div>
                <button
                  type="button"
                  onClick={() => setShowAiModal(false)}
                  className="p-1 rounded-full text-slate-400 hover:text-slate-600 dark:hover:text-slate-200"
                >
                  <X size={18} />
                </button>
              </div>

              <p className="text-xs text-slate-500 dark:text-slate-400 leading-relaxed">
                Buzz AI connects dynamically to your preview origin or Firestore RPC bridge so natural language cashier commands and voice queries work offline and online.
              </p>

              <div className="space-y-1.5">
                <label className="text-[11px] font-bold text-slate-600 dark:text-slate-300">
                  Custom AI Server URL (Optional)
                </label>
                <input
                  type="text"
                  placeholder="https://your-server-or-tunnel.app"
                  value={customServerUrl}
                  onChange={(e) => saveCustomServerUrl(e.target.value)}
                  className="w-full px-3 py-2 text-xs rounded-xl border border-slate-200 dark:border-white/10 bg-slate-50 dark:bg-slate-800/80 text-slate-800 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-violet-500"
                />
              </div>

              {aiTestResult && (
                <div className="p-2.5 rounded-xl text-xs font-semibold bg-violet-500/10 border border-violet-500/20 text-violet-700 dark:text-violet-300">
                  {aiTestResult}
                </div>
              )}

              <div className="flex items-center gap-2 pt-2">
                <button
                  type="button"
                  disabled={isTestingAi}
                  onClick={testAiConnection}
                  className="flex-1 py-2.5 px-3 rounded-xl bg-violet-600 hover:bg-violet-500 text-white font-bold text-xs shadow-md transition-colors disabled:opacity-50"
                >
                  {isTestingAi ? "Pinging Bridge..." : "Test AI Connection"}
                </button>
                <button
                  type="button"
                  onClick={() => setShowAiModal(false)}
                  className="py-2.5 px-4 rounded-xl bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-200 font-bold text-xs transition-colors"
                >
                  Done
                </button>
              </div>
            </div>
          </div>
        )}
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
  singleLine,
}: {
  icon: React.ReactNode;
  label: string;
  badge?: React.ReactNode;
  description?: React.ReactNode;
  action?: React.ReactNode;
  onClick?: () => void;
  singleLine?: boolean;
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
          <div className={`flex items-center gap-2 ${singleLine ? "flex-nowrap" : "flex-wrap"}`}>
            <h3
              className={`font-bold text-sm sm:text-base text-slate-900 dark:text-slate-100 leading-snug ${
                singleLine ? "truncate whitespace-nowrap" : ""
              }`}
            >
              {label}
            </h3>
            {badge}
          </div>
          {description && (
            <div
              className={`text-[11px] sm:text-xs text-slate-500 dark:text-slate-400 leading-snug mt-0.5 ${
                singleLine ? "truncate whitespace-nowrap" : "break-words"
              }`}
            >
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
