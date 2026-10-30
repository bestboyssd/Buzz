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
import { App as CapApp } from "@capacitor/app";
import { LocalNotifications } from "@capacitor/local-notifications";
import metadata from "../../metadata.json";
import pkg from "../../package.json";
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

const GITHUB_RELEASES_API = "https://api.github.com/repos/bestboyssd/Buzz/releases";
const GITHUB_LATEST_RELEASE_API = "https://api.github.com/repos/bestboyssd/Buzz/releases/latest";
const GITHUB_RELEASES_FALLBACK_URL = "https://github.com/bestboyssd/Buzz/releases/latest";

function extractCleanVersion(raw?: string | null): string | null {
  if (!raw) return null;
  const match = String(raw).match(/(\d+\.\d+\.\d+(?:\.\d+)?)/);
  return match ? match[1] : null;
}

function compareSemver(a: string, b: string): number {
  const pa = (extractCleanVersion(a) || "0.0.0")
    .split(".")
    .map((n) => parseInt(n, 10) || 0);
  const pb = (extractCleanVersion(b) || "0.0.0")
    .split(".")
    .map((n) => parseInt(n, 10) || 0);
  const len = Math.max(pa.length, pb.length, 3);
  for (let i = 0; i < len; i++) {
    const na = pa[i] ?? 0;
    const nb = pb[i] ?? 0;
    if (na > nb) return 1;
    if (na < nb) return -1;
  }
  return 0;
}

interface ReleaseCheckResult {
  version: string;
  downloadUrl: string;
  htmlUrl: string;
}

function parseReleaseEntry(rel: any): ReleaseCheckResult | null {
  if (!rel || rel.draft) return null;
  const assets = Array.isArray(rel.assets) ? rel.assets : [];
  const apkAsset =
    assets.find(
      (a: any) =>
        typeof a?.browser_download_url === "string" &&
        (String(a?.name || "").toLowerCase().endsWith(".apk") ||
          String(a?.content_type || "")
            .toLowerCase()
            .includes("android.package-archive"))
    ) || assets.find((a: any) => typeof a?.browser_download_url === "string");

  const ver =
    extractCleanVersion(rel.tag_name) ||
    extractCleanVersion(rel.name) ||
    extractCleanVersion(apkAsset?.name);

  if (!ver) return null;

  const tag = String(rel.tag_name || `v${ver}`).trim();
  const downloadUrl =
    apkAsset?.browser_download_url ||
    `https://github.com/bestboyssd/Buzz/releases/download/${tag}/Buzz-${tag}.apk`;

  return {
    version: ver,
    downloadUrl,
    htmlUrl: rel.html_url || GITHUB_RELEASES_FALLBACK_URL,
  };
}

async function fetchLatestGithubRelease(): Promise<ReleaseCheckResult | null> {
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
  };

  try {
    const res = await fetch(`${GITHUB_RELEASES_API}?per_page=10&t=${Date.now()}`, {
      cache: "no-store",
      headers,
    });
    if (res.ok) {
      const list = await res.json();
      if (Array.isArray(list) && list.length > 0) {
        let best: ReleaseCheckResult | null = null;
        for (const item of list) {
          const parsed = parseReleaseEntry(item);
          if (parsed && (!best || compareSemver(parsed.version, best.version) > 0)) {
            best = parsed;
          }
        }
        if (best) return best;
      }
    }
  } catch (e) {
    console.warn("GitHub releases list check failed, trying /latest:", e);
  }

  try {
    const res = await fetch(`${GITHUB_LATEST_RELEASE_API}?t=${Date.now()}`, {
      cache: "no-store",
      headers,
    });
    if (res.ok) {
      const item = await res.json();
      const parsed = parseReleaseEntry(item);
      if (parsed) return parsed;
    }
  } catch (e) {
    console.warn("GitHub latest release check failed:", e);
  }

  return null;
}

function triggerInstantApkDownload(url: string) {
  const targetUrl = (url || GITHUB_RELEASES_FALLBACK_URL).trim();

  // 1. Native Android bridge if available
  try {
    const nativeExporter = (window as any).AndroidExporter;
    if (
      nativeExporter &&
      typeof nativeExporter.openExternalDownload === "function"
    ) {
      const opened = nativeExporter.openExternalDownload(targetUrl);
      if (opened) return;
    }
  } catch {}

  // 2. Native Capacitor WebView: navigating to an external host triggers Bridge.shouldOverrideUrlLoading -> Intent.ACTION_VIEW
  if (Capacitor.isNativePlatform()) {
    window.location.href = targetUrl;
    return;
  }

  // 3. Web / Mobile Browser / PWA: anchor click with download & _blank
  try {
    const a = document.createElement("a");
    a.href = targetUrl;
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    a.setAttribute("download", "");
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  } catch {
    window.location.assign(targetUrl);
  }
}

export function Settings() {
  const navigate = useNavigate();
  const { user } = useAuth();

  const getInitialBundledVersion = () => {
    try {
      const metaVer = extractCleanVersion((metadata as any)?.name) || "1.0.0";
      const pkgVer = extractCleanVersion((pkg as any)?.version) || "1.0.0";
      return compareSemver(pkgVer, metaVer) > 0 ? pkgVer : metaVer;
    } catch {
      return "1.0.0";
    }
  };

  const [appVersion, setAppVersion] = useState<string>(() =>
    getInitialBundledVersion()
  );
  const [latestRelease, setLatestRelease] = useState<ReleaseCheckResult | null>(() => {
    try {
      const cached = localStorage.getItem("buzz_github_latest_release");
      return cached ? (JSON.parse(cached) as ReleaseCheckResult) : null;
    } catch {
      return null;
    }
  });
  const [checkingVersion, setCheckingVersion] = useState<boolean>(false);

  useEffect(() => {
    let mounted = true;

    const syncVersionAndCheckRepo = async () => {
      let currentVer = getInitialBundledVersion();
      if (Capacitor.isNativePlatform()) {
        try {
          const info = await CapApp.getInfo();
          const nativeVer = extractCleanVersion(info?.version);
          if (nativeVer && compareSemver(nativeVer, currentVer) > 0) {
            currentVer = nativeVer;
          }
        } catch {}
      }
      if (mounted) {
        setAppVersion(currentVer);
        setCheckingVersion(true);
      }

      const release = await fetchLatestGithubRelease();
      if (!mounted) return;
      setCheckingVersion(false);
      if (release) {
        setLatestRelease(release);
        try {
          localStorage.setItem(
            "buzz_github_latest_release",
            JSON.stringify(release)
          );
        } catch {}
      }
    };

    syncVersionAndCheckRepo();

    const handleResumeOrFocus = () => {
      syncVersionAndCheckRepo();
    };
    window.addEventListener("appResumed", handleResumeOrFocus);
    window.addEventListener("focus", handleResumeOrFocus);
    return () => {
      mounted = false;
      window.removeEventListener("appResumed", handleResumeOrFocus);
      window.removeEventListener("focus", handleResumeOrFocus);
    };
  }, []);

  const isOutdated = Boolean(
    latestRelease && compareSemver(latestRelease.version, appVersion) > 0
  );
  const isUpdated = Boolean(
    latestRelease && compareSemver(latestRelease.version, appVersion) <= 0
  );

  const handleAppVersionClick = async () => {
    if (isOutdated && latestRelease) {
      triggerHaptic("heavy");
      triggerInstantApkDownload(latestRelease.downloadUrl);
      return;
    }

    // Re-verify live with GitHub when tapped; if a newer release was just published, download it immediately
    triggerHaptic("light");
    setCheckingVersion(true);
    const freshRelease = await fetchLatestGithubRelease();
    setCheckingVersion(false);
    if (freshRelease) {
      setLatestRelease(freshRelease);
      try {
        localStorage.setItem(
          "buzz_github_latest_release",
          JSON.stringify(freshRelease)
        );
      } catch {}
      if (compareSemver(freshRelease.version, appVersion) > 0) {
        triggerHaptic("heavy");
        triggerInstantApkDownload(freshRelease.downloadUrl);
      }
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
              badge={
                isOutdated ? (
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
                isOutdated && latestRelease
                  ? `${appVersion} · v${latestRelease.version} available (Tap to download)`
                  : appVersion
              }
              action={
                isOutdated ? (
                  <Download size={18} className="text-rose-500 dark:text-rose-400" />
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
