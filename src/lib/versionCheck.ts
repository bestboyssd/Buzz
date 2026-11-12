import { useState, useEffect, useCallback } from "react";
import { Capacitor } from "@capacitor/core";
import { App as CapApp } from "@capacitor/app";
import { Filesystem, Directory } from "@capacitor/filesystem";
import metadata from "../../metadata.json";
import pkg from "../../package.json";
import { showLocalNotification } from "./utils";
import { getApiBaseUrl } from "./geminiApi";

const GITHUB_RELEASES_API = "https://api.github.com/repos/bestboyssd/Buzz/releases";
const GITHUB_LATEST_RELEASE_API = "https://api.github.com/repos/bestboyssd/Buzz/releases/latest";
export const GITHUB_RELEASES_FALLBACK_URL =
  "https://github.com/bestboyssd/Buzz/releases/latest/download/Buzz.apk";
const STORAGE_CACHE_KEY = "buzz_github_latest_release";
const GRACE_PERIOD_MS = 3 * 24 * 60 * 60 * 1000; // 3 days in milliseconds

export interface ReleaseCheckResult {
  version: string;
  downloadUrl: string;
  apiAssetUrl?: string;
  htmlUrl: string;
  notes?: string;
  publishedAt?: string;
  sizeBytes?: number;
}

export interface ApkDownloadProgressState {
  isDownloading: boolean;
  progress: number;
  downloadedBytes: number;
  totalBytes: number;
  status: "idle" | "downloading" | "installing" | "completed" | "error";
  error?: string;
  version?: string;
}

let globalDownloadState: ApkDownloadProgressState = {
  isDownloading: false,
  progress: 0,
  downloadedBytes: 0,
  totalBytes: 0,
  status: "idle",
};

let activeDownloadAbortController: AbortController | null = null;
let cachedDownloadedApkBlob: { version: string; blob: Blob } | null = null;
let cachedNativeApkUri: { version: string; uri: string } | null = null;

function emitApkProgress(next: Partial<ApkDownloadProgressState>) {
  globalDownloadState = {
    ...globalDownloadState,
    ...next,
  };
  if (typeof window !== "undefined") {
    window.dispatchEvent(
      new CustomEvent("apkDownloadProgress", {
        detail: globalDownloadState,
      })
    );
  }
}

export function cancelApkDownload(): void {
  try {
    const nativeExporter = (window as any).AndroidExporter;
    if (nativeExporter && typeof nativeExporter.cancelApkDownload === "function") {
      nativeExporter.cancelApkDownload();
    }
  } catch {}

  if (activeDownloadAbortController) {
    try {
      activeDownloadAbortController.abort();
    } catch {}
    activeDownloadAbortController = null;
  }

  emitApkProgress({
    isDownloading: false,
    progress: 0,
    downloadedBytes: 0,
    totalBytes: 0,
    status: "idle",
    error: "",
  });
}

export async function cleanupInstalledApkFiles(): Promise<void> {
  cachedDownloadedApkBlob = null;
  cachedNativeApkUri = null;

  // 1. Native Android bridge cleanup (cache/updates, externalCache/updates, filesDir)
  try {
    const nativeExporter = (window as any).AndroidExporter;
    if (nativeExporter && typeof nativeExporter.cleanupDownloadedApks === "function") {
      nativeExporter.cleanupDownloadedApks();
    }
  } catch {}

  // 2. Capacitor Filesystem cleanup for any cached .apk / .apk.part files
  if (Capacitor.isNativePlatform()) {
    const dirs = [Directory.Cache, Directory.ExternalCache, Directory.Data];
    for (const directory of dirs) {
      try {
        const res = await Filesystem.readdir({ path: "", directory });
        for (const entry of res.files || []) {
          const name = typeof entry === "string" ? entry : entry?.name || "";
          const lower = name.toLowerCase();
          if (lower.endsWith(".apk") || lower.endsWith(".apk.part")) {
            await Filesystem.deleteFile({ path: name, directory }).catch(() => {});
          }
        }
      } catch {}
      try {
        const resUpdates = await Filesystem.readdir({ path: "updates", directory });
        for (const entry of resUpdates.files || []) {
          const name = typeof entry === "string" ? entry : entry?.name || "";
          const lower = name.toLowerCase();
          if (lower.endsWith(".apk") || lower.endsWith(".apk.part")) {
            await Filesystem.deleteFile({ path: `updates/${name}`, directory }).catch(() => {});
          }
        }
      } catch {}
    }
  }
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
    const metaVer = extractCleanVersion((metadata as any)?.name) || "1.2.0";
    const pkgVer = extractCleanVersion((pkg as any)?.version) || "1.2.0";
    return compareSemver(pkgVer, metaVer) > 0 ? pkgVer : metaVer;
  } catch {
    return "1.2.0";
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
    apiAssetUrl: typeof apkAsset?.url === "string" ? apkAsset.url : undefined,
    htmlUrl: rel.html_url || "https://github.com/bestboyssd/Buzz/releases/latest",
    notes: typeof rel.body === "string" ? rel.body.trim() : undefined,
    publishedAt: typeof rel.published_at === "string" ? rel.published_at : undefined,
    sizeBytes: typeof apkAsset?.size === "number" && apkAsset.size > 0 ? apkAsset.size : undefined,
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

function triggerBrowserBlobDownload(blob: Blob, cleanVer: string) {
  const blobUrl = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = blobUrl;
  a.download = `Buzz-v${cleanVer}.apk`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => {
    URL.revokeObjectURL(blobUrl);
  }, 5000);
}

function isValidZipMagicHeader(firstChunk?: Uint8Array): boolean {
  if (!firstChunk || firstChunk.byteLength < 4) return false;
  // Standard ZIP / Android APK magic bytes: PK\x03\x04 (0x50, 0x4B, 0x03, 0x04)
  return (
    firstChunk[0] === 0x50 &&
    firstChunk[1] === 0x4b &&
    firstChunk[2] === 0x03 &&
    firstChunk[3] === 0x04
  );
}

export async function triggerInstantApkDownload(
  url?: string | null,
  version?: string | null,
  expectedSizeBytes?: number
) {
  if (globalDownloadState.isDownloading) return;

  const cleanVer = extractCleanVersion(version) || "latest";

  // 0. If this exact version was already downloaded in the current session, re-trigger install immediately without re-downloading 36.5 MB!
  try {
    const nativeExporter = (window as any).AndroidExporter;
    if (
      nativeExporter &&
      typeof nativeExporter.installDownloadedApk === "function" &&
      (globalDownloadState.status === "completed" || globalDownloadState.status === "installing")
    ) {
      if (nativeExporter.installDownloadedApk(cleanVer)) {
        return;
      }
    }
  } catch {}

  if (
    cachedDownloadedApkBlob &&
    cachedDownloadedApkBlob.version === cleanVer &&
    cachedDownloadedApkBlob.blob.size > 100 * 1024
  ) {
    emitApkProgress({
      isDownloading: false,
      progress: 100,
      downloadedBytes: cachedDownloadedApkBlob.blob.size,
      totalBytes: cachedDownloadedApkBlob.blob.size,
      status: "installing",
      error: "",
      version: cleanVer,
    });
    triggerBrowserBlobDownload(cachedDownloadedApkBlob.blob, cleanVer);
    setTimeout(() => {
      emitApkProgress({
        isDownloading: false,
        progress: 100,
        status: "completed",
        version: cleanVer,
      });
    }, 1200);
    return;
  }

  if (typeof navigator !== "undefined" && navigator.onLine === false) {
    emitApkProgress({
      isDownloading: false,
      progress: 0,
      status: "error",
      error: "You are currently offline. Connect to the internet to download the update.",
      version: cleanVer,
    });
    return;
  }

  let targetUrl = (url || "").trim();
  let resolvedSize = expectedSizeBytes || 0;

  // Ensure targetUrl is always a direct binary .apk URL (never the HTML release page)
  if (
    !targetUrl ||
    targetUrl.endsWith("/releases/latest") ||
    targetUrl.includes("/releases/tag/")
  ) {
    try {
      const freshRelease = await fetchLatestGithubRelease();
      if (freshRelease?.downloadUrl) {
        targetUrl = freshRelease.downloadUrl;
        if (!resolvedSize && freshRelease.sizeBytes) {
          resolvedSize = freshRelease.sizeBytes;
        }
      }
    } catch {}
    if (!targetUrl || targetUrl.endsWith("/releases/latest") || targetUrl.includes("/releases/tag/")) {
      targetUrl =
        cleanVer !== "latest"
          ? `https://github.com/bestboyssd/Buzz/releases/download/v${cleanVer}/Buzz-v${cleanVer}.apk`
          : GITHUB_RELEASES_FALLBACK_URL;
    }
  }

  // 1. Native Android In-App Downloader + FileProvider Package Installer
  try {
    const nativeExporter = (window as any).AndroidExporter;
    if (
      nativeExporter &&
      typeof nativeExporter.downloadAndInstallApk === "function"
    ) {
      emitApkProgress({
        isDownloading: true,
        progress: 1,
        downloadedBytes: 0,
        totalBytes: resolvedSize,
        status: "downloading",
        error: "",
        version: cleanVer,
      });
      const started = nativeExporter.downloadAndInstallApk(targetUrl, cleanVer);
      if (started) return;
    }
  } catch {}

  // 2. Capacitor Native Filesystem.downloadFile with real native 'progress' listener (for APK shells without AndroidExporter.downloadAndInstallApk)
  if (Capacitor.isNativePlatform() && typeof Filesystem.downloadFile === "function") {
    let progressListener: { remove: () => Promise<void> } | null = null;
    try {
      emitApkProgress({
        isDownloading: true,
        progress: 1,
        downloadedBytes: 0,
        totalBytes: resolvedSize,
        status: "downloading",
        error: "",
        version: cleanVer,
      });

      progressListener = await Filesystem.addListener("progress", (prog) => {
        const bytes = Number(prog?.bytes) || 0;
        const total =
          (Number(prog?.contentLength) > 0 ? Number(prog.contentLength) : resolvedSize) ||
          36.5 * 1024 * 1024;
        const pct = Math.min(99, Math.max(1, Math.round((bytes / total) * 100)));
        emitApkProgress({
          isDownloading: true,
          progress: pct,
          downloadedBytes: bytes,
          totalBytes: Math.max(total, bytes),
          status: "downloading",
          error: "",
          version: cleanVer,
        });
      });

      const filePath = `updates/buzz_update_${cleanVer}.apk`;
      const dlResult = await Filesystem.downloadFile({
        url: targetUrl,
        path: filePath,
        directory: Directory.ExternalCache,
        progress: true,
        recursive: true,
      });

      if (progressListener) {
        await progressListener.remove().catch(() => {});
        progressListener = null;
      }

      if (dlResult?.path) {
        cachedNativeApkUri = { version: cleanVer, uri: dlResult.path };
        emitApkProgress({
          isDownloading: false,
          progress: 100,
          downloadedBytes: resolvedSize || 36516119,
          totalBytes: resolvedSize || 36516119,
          status: "installing",
          error: "",
          version: cleanVer,
        });

        try {
          const nativeExporter = (window as any).AndroidExporter;
          if (
            nativeExporter &&
            typeof nativeExporter.installDownloadedApk === "function" &&
            nativeExporter.installDownloadedApk(cleanVer)
          ) {
            return;
          }
        } catch {}

        emitApkProgress({
          isDownloading: false,
          progress: 100,
          status: "completed",
          error: "",
          version: cleanVer,
        });
        return;
      }
    } catch {
      if (progressListener) {
        await progressListener.remove().catch(() => {});
      }
      // Fall through to streaming proxy fetch
    }
  }

  // 3. In-App JavaScript Streaming Download with Live 0%–100% Progress & Binary APK Verification
  activeDownloadAbortController = new AbortController();
  const { signal } = activeDownloadAbortController;

  emitApkProgress({
    isDownloading: true,
    progress: 1,
    downloadedBytes: 0,
    totalBytes: resolvedSize,
    status: "downloading",
    error: "",
    version: cleanVer,
  });

  const proxyQuery = `?url=${encodeURIComponent(targetUrl)}&version=${encodeURIComponent(cleanVer)}`;
  const streamUrlsToTry: string[] = [];

  if (!Capacitor.isNativePlatform()) {
    streamUrlsToTry.push(`/api/github/apk-download${proxyQuery}`);
  }
  const baseApiUrl = getApiBaseUrl();
  if (baseApiUrl) {
    streamUrlsToTry.push(`${baseApiUrl}/api/github/apk-download${proxyQuery}`);
  }
  streamUrlsToTry.push(
    `https://ais-pre-2tctwvbwywftkcy73fkqkj-549311647835.asia-southeast1.run.app/api/github/apk-download${proxyQuery}`,
    `https://ais-dev-2tctwvbwywftkcy73fkqkj-549311647835.asia-southeast1.run.app/api/github/apk-download${proxyQuery}`
  );

  const uniqueStreamUrls = Array.from(new Set(streamUrlsToTry));
  let lastErrorMsg = "Could not download update package. Please check your connection and retry.";

  for (const candidateUrl of uniqueStreamUrls) {
    if (signal.aborted) return;
    try {
      const response = await fetch(candidateUrl, {
        method: "GET",
        redirect: "follow",
        signal,
      });
      if (!response.ok || !response.body) {
        lastErrorMsg = `Download server returned HTTP ${response.status}`;
        continue;
      }

      const contentType = String(response.headers.get("content-type") || "").toLowerCase();
      if (contentType.includes("text/html") || contentType.includes("application/json")) {
        lastErrorMsg = "Unexpected response format from update server.";
        continue;
      }

      const contentLengthHeader = response.headers.get("content-length");
      const contentLength = contentLengthHeader ? parseInt(contentLengthHeader, 10) : 0;
      const totalBytes =
        (contentLength > 0 ? contentLength : 0) ||
        resolvedSize ||
        36.5 * 1024 * 1024;

      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let downloadedBytes = 0;
      let lastEmit = 0;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (signal.aborted) {
          await reader.cancel().catch(() => {});
          return;
        }
        if (value && value.byteLength > 0) {
          chunks.push(value);
          downloadedBytes += value.byteLength;
          const pct = Math.min(
            99,
            Math.max(1, Math.round((downloadedBytes / totalBytes) * 100))
          );
          const now = Date.now();
          if (now - lastEmit >= 70 || pct >= 99) {
            lastEmit = now;
            emitApkProgress({
              isDownloading: true,
              progress: pct,
              downloadedBytes,
              totalBytes: Math.max(totalBytes, downloadedBytes),
              status: "downloading",
              error: "",
              version: cleanVer,
            });
          }
        }
      }

      if (contentLength > 0 && downloadedBytes < contentLength) {
        lastErrorMsg = `Download interrupted (${(downloadedBytes / (1024 * 1024)).toFixed(1)} MB of ${(contentLength / (1024 * 1024)).toFixed(1)} MB). Tap to retry.`;
        continue;
      }

      if (downloadedBytes < 100 * 1024 || !isValidZipMagicHeader(chunks[0])) {
        lastErrorMsg = "Downloaded package is invalid or incomplete.";
        continue;
      }

      activeDownloadAbortController = null;
      const blob = new Blob(chunks, {
        type: "application/vnd.android.package-archive",
      });
      cachedDownloadedApkBlob = { version: cleanVer, blob };

      emitApkProgress({
        isDownloading: false,
        progress: 100,
        downloadedBytes,
        totalBytes: downloadedBytes,
        status: "installing",
        error: "",
        version: cleanVer,
      });

      triggerBrowserBlobDownload(blob, cleanVer);

      setTimeout(() => {
        emitApkProgress({
          isDownloading: false,
          progress: 100,
          downloadedBytes,
          totalBytes: downloadedBytes,
          status: "completed",
          error: "",
          version: cleanVer,
        });
      }, 1500);
      return;
    } catch (err: any) {
      if (signal.aborted || err?.name === "AbortError") {
        return;
      }
      lastErrorMsg = err?.message || "Connection interrupted during download.";
    }
  }

  activeDownloadAbortController = null;
  emitApkProgress({
    isDownloading: false,
    progress: 0,
    downloadedBytes: 0,
    totalBytes: 0,
    status: "error",
    error: lastErrorMsg,
    version: cleanVer,
  });
}

const ACTIVE_OUTDATED_FIRST_SEEN_KEY = "buzz_outdated_active_first_seen";

function clearOutdatedGraceTimestamps(): void {
  try {
    localStorage.removeItem(ACTIVE_OUTDATED_FIRST_SEEN_KEY);
    const keysToRemove: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith("buzz_outdated_first_seen")) {
        keysToRemove.push(k);
      }
    }
    for (const k of keysToRemove) {
      localStorage.removeItem(k);
    }
    sessionStorage.removeItem("buzz_update_passed_session");
  } catch {}
}

/**
 * Anchors the first-seen timestamp to the entire outdated cycle (not per remote patch tag)
 * so releasing 1.2.4 after 1.2.3 cannot reset an elapsed grace period.
 */
export function getOrSetOutdatedFirstSeen(remoteVersion: string, installedVersion?: string): number {
  const perRemoteKey = `buzz_outdated_first_seen_${remoteVersion}`;
  const perInstalledKey = installedVersion ? `buzz_outdated_first_seen_from_${installedVersion}` : null;
  try {
    const candidates: number[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (
        k &&
        (k === ACTIVE_OUTDATED_FIRST_SEEN_KEY || k.startsWith("buzz_outdated_first_seen"))
      ) {
        const parsed = parseInt(localStorage.getItem(k) || "", 10);
        if (!isNaN(parsed) && parsed > 0) {
          candidates.push(parsed);
        }
      }
    }
    const earliest = candidates.length > 0 ? Math.min(...candidates) : Date.now();
    localStorage.setItem(ACTIVE_OUTDATED_FIRST_SEEN_KEY, String(earliest));
    localStorage.setItem(perRemoteKey, String(earliest));
    if (perInstalledKey) {
      localStorage.setItem(perInstalledKey, String(earliest));
    }
    return earliest;
  } catch {
    return Date.now();
  }
}

export function computeGraceState(
  firstSeenMs: number,
  nowMs: number = Date.now(),
  gracePeriodMs: number = GRACE_PERIOD_MS
): { remainingGraceMs: number; canPassUpdate: boolean; graceDaysLeft: number } {
  const elapsed = Math.max(0, nowMs - firstSeenMs);
  const remainingGraceMs = Math.max(0, gracePeriodMs - elapsed);
  return {
    remainingGraceMs,
    canPassUpdate: remainingGraceMs > 0,
    graceDaysLeft: Math.max(0, Math.ceil(remainingGraceMs / (24 * 60 * 60 * 1000))),
  };
}

export function useAppVersionCheck() {
  const [nowMs, setNowMs] = useState<number>(() => Date.now());
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
  const [downloadState, setDownloadState] = useState<ApkDownloadProgressState>(
    () => globalDownloadState
  );

  const refreshVersionCheck = useCallback(async () => {
    setNowMs(Date.now());
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

        if (compareSemver(release.version, currentVer) <= 0) {
          // App is up to date! Clear outdated grace stamps and delete any leftover APKs
          clearOutdatedGraceTimestamps();
          setPassedThisSession(false);
          cleanupInstalledApkFiles().catch(() => {});
        } else {
          const firstSeen = getOrSetOutdatedFirstSeen(release.version, currentVer);
          const { remainingGraceMs: remMs } = computeGraceState(firstSeen, Date.now());
          const notifKey = `buzz_outdated_notified_${release.version}`;
          if (sessionStorage.getItem(notifKey) !== "true") {
            sessionStorage.setItem(notifKey, "true");
            showLocalNotification(
              remMs > 0
                ? `Update Available (v${release.version})`
                : `Update Required (v${release.version})`,
              remMs > 0
                ? `A newer version of Buzz POS (v${release.version}) is ready to install.`
                : `Please update Buzz POS to v${release.version} to continue using the app.`,
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
    // Always run APK cleanup on initial mount so any just-installed APK is deleted immediately
    cleanupInstalledApkFiles().catch(() => {});
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

    const handleApkProgressEvent = (e: Event) => {
      const custom = e as CustomEvent<{
        progress?: number;
        downloadedBytes?: number;
        totalBytes?: number;
        status?: "idle" | "downloading" | "installing" | "completed" | "error";
        error?: string;
        version?: string;
      }>;
      const d = custom.detail;
      if (!d) return;
      const status = d.status || "downloading";
      const isDownloading = status === "downloading";
      const next: ApkDownloadProgressState = {
        isDownloading,
        progress: typeof d.progress === "number" ? d.progress : 0,
        downloadedBytes: typeof d.downloadedBytes === "number" ? d.downloadedBytes : 0,
        totalBytes: typeof d.totalBytes === "number" ? d.totalBytes : 0,
        status,
        error: d.error || "",
        version: d.version || globalDownloadState.version,
      };
      globalDownloadState = next;
      setDownloadState(next);
    };

    const handleResumeOrFocus = () => {
      setNowMs(Date.now());
      refreshVersionCheck();
    };

    window.addEventListener("appReleaseCheckUpdated", handleSyncEvent);
    window.addEventListener("apkDownloadProgress", handleApkProgressEvent);
    window.addEventListener("appResumed", handleResumeOrFocus);
    window.addEventListener("focus", handleResumeOrFocus);
    window.addEventListener("online", handleResumeOrFocus);

    const interval = setInterval(() => {
      setNowMs(Date.now());
      if (typeof navigator === "undefined" || navigator.onLine) {
        refreshVersionCheck();
      }
    }, 60000);

    return () => {
      window.removeEventListener("appReleaseCheckUpdated", handleSyncEvent);
      window.removeEventListener("apkDownloadProgress", handleApkProgressEvent);
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
    const firstSeen = getOrSetOutdatedFirstSeen(latestRelease.version, appVersion);
    remainingGraceMs = computeGraceState(firstSeen, nowMs).remainingGraceMs;
  }

  const canPassUpdate = isOutdated && remainingGraceMs > 0;
  const graceDaysLeft = Math.max(
    0,
    Math.ceil(remainingGraceMs / (24 * 60 * 60 * 1000))
  );

  // Immediately revoke any session pass the moment the grace deadline elapses (even if app stays open)
  useEffect(() => {
    if (!isOutdated) return;
    if (remainingGraceMs <= 0) {
      if (passedThisSession) {
        setPassedThisSession(false);
        try {
          sessionStorage.removeItem("buzz_update_passed_session");
        } catch {}
      }
      return;
    }
    // Schedule an automatic wakeup timer at the exact expiration deadline (capped for 32-bit timer safety)
    const waitMs = Math.min(remainingGraceMs + 250, 24 * 60 * 60 * 1000);
    const expiryTimer = setTimeout(() => {
      setNowMs(Date.now());
    }, waitMs);
    return () => clearTimeout(expiryTimer);
  }, [isOutdated, remainingGraceMs, passedThisSession]);

  const passUpdateThisTime = useCallback(() => {
    // Re-evaluate directly against current clock so a stale closure can never bypass an expired deadline
    if (isOutdated && latestRelease) {
      const freshFirstSeen = getOrSetOutdatedFirstSeen(latestRelease.version, appVersion);
      if (computeGraceState(freshFirstSeen, Date.now()).remainingGraceMs <= 0) {
        setNowMs(Date.now());
        setPassedThisSession(false);
        try {
          sessionStorage.removeItem("buzz_update_passed_session");
        } catch {}
        return;
      }
    }
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
  }, [canPassUpdate, isOutdated, latestRelease, appVersion]);

  const startApkDownload = useCallback(() => {
    if (!latestRelease) return;
    triggerInstantApkDownload(
      latestRelease.downloadUrl,
      latestRelease.version,
      latestRelease.sizeBytes
    );
  }, [latestRelease]);

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
    downloadState,
    startApkDownload,
    cancelApkDownload,
  };
}
