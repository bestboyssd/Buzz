import { useState, useEffect, useCallback } from "react";
import { Capacitor } from "@capacitor/core";
import { App as CapApp } from "@capacitor/app";
import metadata from "../../metadata.json";
import pkg from "../../package.json";
import { showLocalNotification } from "./utils";

const GITHUB_RELEASES_API = "https://api.github.com/repos/bestboyssd/Buzz/releases";
const GITHUB_LATEST_RELEASE_API = "https://api.github.com/repos/bestboyssd/Buzz/releases/latest";
export const GITHUB_RELEASES_FALLBACK_URL = "https://github.com/bestboyssd/Buzz/releases/latest";
const STORAGE_CACHE_KEY = "buzz_github_latest_release";
const GRACE_PERIOD_MS = 3 * 24 * 60 * 60 * 1000; // 3 days in milliseconds

export interface ReleaseCheckResult {
  version: string;
  downloadUrl: string;
  htmlUrl: string;
  notes?: string;
  publishedAt?: string;
}

export function extractCleanVersion(raw?: string | null): string | null {
  if (!raw) return null;
  const match = String(raw).match(/(\d+\.\d+\.\d+(?:\.\d+)?)/);
  return match ? match[1] : null;
}

export function compareSemver(a: string, b: string): number {
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

export function getInitialBundledVersion(): string {
  try {
    const metaVer = extractCleanVersion((metadata as any)?.name) || "1.0.0";
    const pkgVer = extractCleanVersion((pkg as any)?.version) || "1.0.0";
    return compareSemver(pkgVer, metaVer) > 0 ? pkgVer : metaVer;
  } catch {
    return "1.0.0";
  }
}

export async function getInstalledAppVersion(): Promise<string> {
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
  return currentVer;
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
    notes: typeof rel.body === "string" ? rel.body.trim() : undefined,
    publishedAt: typeof rel.published_at === "string" ? rel.published_at : undefined,
  };
}

export async function fetchLatestGithubRelease(): Promise<ReleaseCheckResult | null> {
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

export function triggerInstantApkDownload(url?: string | null) {
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

function getOrSetOutdatedFirstSeen(remoteVersion: string): number {
  const key = `buzz_outdated_first_seen_${remoteVersion}`;
  try {
    const raw = localStorage.getItem(key);
    if (raw) {
      const parsed = parseInt(raw, 10);
      if (!isNaN(parsed) && parsed > 0) {
        return parsed;
      }
    }
    const now = Date.now();
    localStorage.setItem(key, String(now));
    return now;
  } catch {
    return Date.now();
  }
}

export function useAppVersionCheck() {
  const [appVersion, setAppVersion] = useState<string>(() =>
    getInitialBundledVersion()
  );
  const [latestRelease, setLatestRelease] = useState<ReleaseCheckResult | null>(() => {
    try {
      const cached = localStorage.getItem(STORAGE_CACHE_KEY);
      return cached ? (JSON.parse(cached) as ReleaseCheckResult) : null;
    } catch {
      return null;
    }
  });
  const [checkingVersion, setCheckingVersion] = useState<boolean>(false);
  const [passedThisSession, setPassedThisSession] = useState<boolean>(() => {
    try {
      return sessionStorage.getItem("buzz_update_passed_session") === "true";
    } catch {
      return false;
    }
  });

  const refreshVersionCheck = useCallback(async () => {
    setCheckingVersion(true);
    try {
      const currentVer = await getInstalledAppVersion();
      setAppVersion(currentVer);

      const release = await fetchLatestGithubRelease();
      if (release) {
        setLatestRelease(release);
        try {
          localStorage.setItem(STORAGE_CACHE_KEY, JSON.stringify(release));
        } catch {}
        window.dispatchEvent(
          new CustomEvent("appReleaseCheckUpdated", {
            detail: { release, appVersion: currentVer },
          })
        );

        if (compareSemver(release.version, currentVer) > 0) {
          const firstSeen = getOrSetOutdatedFirstSeen(release.version);
          const remMs = Math.max(0, GRACE_PERIOD_MS - (Date.now() - firstSeen));
          const daysLeft = Math.max(0, Math.ceil(remMs / (24 * 60 * 60 * 1000)));
          const notifKey = `buzz_outdated_notified_${release.version}`;
          if (sessionStorage.getItem(notifKey) !== "true") {
            sessionStorage.setItem(notifKey, "true");
            showLocalNotification(
              remMs > 0
                ? `App Update Available (v${release.version})`
                : `Mandatory Update Required (v${release.version})`,
              remMs > 0
                ? `Buzz v${release.version} is available. You can pass for ${daysLeft} more ${daysLeft === 1 ? "day" : "days"} before updating is mandatory.`
                : `Your 3-day update grace period has expired. Please update to Buzz v${release.version} to continue using the app.`,
              "/pwa-192x192.png",
              `update_notice_${release.version}`
            );
          }
        }
      }
      return { release, currentVer };
    } finally {
      setCheckingVersion(false);
    }
  }, []);

  useEffect(() => {
    refreshVersionCheck();

    const handleSyncEvent = (e: Event) => {
      const custom = e as CustomEvent<{
        release?: ReleaseCheckResult;
        appVersion?: string;
        passedSession?: boolean;
      }>;
      if (custom.detail?.release) {
        setLatestRelease(custom.detail.release);
      }
      if (custom.detail?.appVersion) {
        setAppVersion(custom.detail.appVersion);
      }
      if (custom.detail?.passedSession !== undefined) {
        setPassedThisSession(Boolean(custom.detail.passedSession));
      }
    };

    const handleResumeOrFocus = () => {
      refreshVersionCheck();
    };

    window.addEventListener("appReleaseCheckUpdated", handleSyncEvent);
    window.addEventListener("appResumed", handleResumeOrFocus);
    window.addEventListener("focus", handleResumeOrFocus);
    window.addEventListener("online", handleResumeOrFocus);

    const interval = setInterval(() => {
      if (typeof navigator === "undefined" || navigator.onLine) {
        refreshVersionCheck();
      }
    }, 60000);

    return () => {
      window.removeEventListener("appReleaseCheckUpdated", handleSyncEvent);
      window.removeEventListener("appResumed", handleResumeOrFocus);
      window.removeEventListener("focus", handleResumeOrFocus);
      window.removeEventListener("online", handleResumeOrFocus);
      clearInterval(interval);
    };
  }, [refreshVersionCheck]);

  const isOutdated = Boolean(
    latestRelease && compareSemver(latestRelease.version, appVersion) > 0
  );
  const isUpdated = Boolean(
    latestRelease && compareSemver(latestRelease.version, appVersion) <= 0
  );

  let remainingGraceMs = GRACE_PERIOD_MS;
  if (isOutdated && latestRelease) {
    const firstSeen = getOrSetOutdatedFirstSeen(latestRelease.version);
    remainingGraceMs = Math.max(0, GRACE_PERIOD_MS - (Date.now() - firstSeen));
  }

  const canPassUpdate = isOutdated && remainingGraceMs > 0;
  const graceDaysLeft = Math.max(
    0,
    Math.ceil(remainingGraceMs / (24 * 60 * 60 * 1000))
  );

  const passUpdateThisTime = useCallback(() => {
    if (!canPassUpdate) return;
    setPassedThisSession(true);
    try {
      sessionStorage.setItem("buzz_update_passed_session", "true");
    } catch {}
    window.dispatchEvent(
      new CustomEvent("appReleaseCheckUpdated", {
        detail: { passedSession: true },
      })
    );
  }, [canPassUpdate]);

  return {
    appVersion,
    latestRelease,
    checkingVersion,
    isOutdated,
    isUpdated,
    canPassUpdate,
    graceDaysLeft,
    passedThisSession,
    passUpdateThisTime,
    refreshVersionCheck,
  };
}
