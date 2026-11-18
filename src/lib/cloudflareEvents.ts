import { CLOUDFLARE_EDGE_AI_URL } from "./geminiApi";
import {
  getDeviceId,
  showLocalNotification,
  markNativeAlertHandled,
  wasNativeAlertHandled,
} from "./utils";

export interface CloudflareStoreEventInput {
  id?: string;
  kind: "stock" | "broadcast" | "security" | "conflict" | "account_governance" | "digest";
  severity?: "out_of_stock" | "critical_low" | "low_stock" | "high" | "normal";
  title: string;
  body: string;
  canonicalKey?: string;
  targetAudience?: "all" | "admins" | "users";
  sourceUid?: string;
  sourceDeviceId?: string;
  productId?: string;
  productName?: string;
  stock?: number;
  timestamp?: number;
}

export interface CloudflareStoreEvent extends CloudflareStoreEventInput {
  id: string;
  cursor: number;
  canonicalKey: string;
  targetAudience: "all" | "admins" | "users";
  timestamp: number;
}

const PENDING_PUBLISH_KEY = "buzz_cf_pending_events_v1";

function loadPendingQueue(): CloudflareStoreEventInput[] {
  try {
    const raw = localStorage.getItem(PENDING_PUBLISH_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function savePendingQueue(list: CloudflareStoreEventInput[]): void {
  try {
    if (list.length === 0) {
      localStorage.removeItem(PENDING_PUBLISH_KEY);
    } else {
      localStorage.setItem(PENDING_PUBLISH_KEY, JSON.stringify(list.slice(-40)));
    }
  } catch {}
}

function isNotificationsEnabledForUser(uid: string): boolean {
  try {
    if (localStorage.getItem(`notifications_${uid}`) === "false") return false;
    if (localStorage.getItem("notifications") === "false") return false;
  } catch {}
  return true;
}

/**
 * Publishes one or more store events to the 24/7 Cloudflare Worker Event Hub
 * so online phones receive them in <50ms and offline phones receive them immediately upon reconnecting.
 */
export async function publishCloudflareEvents(
  events: CloudflareStoreEventInput[]
): Promise<void> {
  if (!Array.isArray(events) || events.length === 0) return;

  const deviceId = getDeviceId();
  const stamped = events.map((ev) => ({
    ...ev,
    sourceDeviceId: ev.sourceDeviceId || deviceId,
    timestamp: ev.timestamp || Date.now(),
  }));

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    const res = await fetch(`${CLOUDFLARE_EDGE_AI_URL}/api/events/publish`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ events: stamped }),
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
  } catch {
    // Queue locally so events flush as soon as internet reconnects
    const existing = loadPendingQueue();
    savePendingQueue([...existing, ...stamped]);
  }
}

export async function publishCloudflareEvent(
  event: CloudflareStoreEventInput
): Promise<void> {
  return publishCloudflareEvents([event]);
}

export async function flushPendingCloudflareEvents(): Promise<void> {
  const pending = loadPendingQueue();
  if (pending.length === 0) return;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    const res = await fetch(`${CLOUDFLARE_EDGE_AI_URL}/api/events/publish`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ events: pending }),
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (res.ok) {
      savePendingQueue([]);
    }
  } catch {}
}

/**
 * Sends checkout stock deductions to Cloudflare server-authoritative stock tracker
 * so multi-phone stock threshold crossings automatically publish Out-of-Stock alerts even if this phone disconnects.
 */
export async function publishAtomicCheckoutToEdge(payload: {
  billId: string;
  items: Array<{ productId: string; productName: string; quantity: number; prevStock?: number }>;
  sourceUid?: string;
}): Promise<void> {
  if (!payload?.items?.length) return;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    await fetch(`${CLOUDFLARE_EDGE_AI_URL}/api/pos/atomic-checkout`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...payload,
        sourceDeviceId: getDeviceId(),
      }),
      signal: controller.signal,
    });
    clearTimeout(timer);
  } catch {}
}

/**
 * Mirrors account governance updates (blocks, deletions, photo timestamps) to Cloudflare KV.
 */
export async function syncCloudflareAuthGovernance(payload: {
  blockedUids?: string[];
  blockedEmails?: string[];
  deletedUids?: Record<string, number>;
  deletedEmails?: Record<string, number>;
  forcedLogoutAt?: number;
  photoVersion?: { key: string; ts: number };
}): Promise<void> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 4500);
    await fetch(`${CLOUDFLARE_EDGE_AI_URL}/api/auth/status`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    clearTimeout(timer);
  } catch {}
}

/**
 * Fetches the canonical cross-platform profile photo for an email from Cloudflare Edge KV (<30ms).
 * Keeps Web (Google AI Studio) and Native Android UIDs 100% synced to the latest uploaded photo.
 */
export async function fetchEdgeProfilePhoto(
  email: string
): Promise<{ photoUrl: string; displayName: string; photoUpdatedAt: number } | null> {
  const normEmail = String(email || "").trim().toLowerCase();
  if (!normEmail) return null;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 2000);
    const res = await fetch(
      `${CLOUDFLARE_EDGE_AI_URL}/api/profile/photo?email=${encodeURIComponent(normEmail)}`,
      { method: "GET", cache: "no-store", signal: controller.signal }
    );
    clearTimeout(timer);
    if (!res.ok) return null;
    const data = await res.json().catch(() => null);
    if (data?.ok && data?.found && data?.photoUrl) {
      return {
        photoUrl: String(data.photoUrl || "").trim(),
        displayName: String(data.displayName || "").trim(),
        photoUpdatedAt: Number(data.photoUpdatedAt || 0),
      };
    }
  } catch {}
  return null;
}

/**
 * Publishes the latest profile photo for an email to Cloudflare Edge KV (monotonic timestamp guard).
 */
export async function pushEdgeProfilePhoto(payload: {
  email: string;
  photoUrl: string;
  displayName?: string;
  photoUpdatedAt: number;
}): Promise<void> {
  const normEmail = String(payload?.email || "").trim().toLowerCase();
  if (!normEmail) return;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 4000);
    await fetch(`${CLOUDFLARE_EDGE_AI_URL}/api/profile/photo`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: normEmail,
        photoUrl: String(payload.photoUrl || "").trim(),
        displayName: String(payload.displayName || "").trim(),
        photoUpdatedAt: Number(payload.photoUpdatedAt || Date.now()),
      }),
      signal: controller.signal,
    });
    clearTimeout(timer);
  } catch {}
}

function handleIncomingCloudflareEvent(
  ev: CloudflareStoreEvent,
  uid: string
): void {
  if (!ev || !ev.id) return;
  if (!isNotificationsEnabledForUser(uid)) return;

  const kind = ev.kind === "digest" ? "broadcast" : ev.kind || "stock";
  const ts = Number(ev.timestamp || ev.cursor || Date.now());
  const canonicalKey = ev.canonicalKey || ev.id;

  const alreadyHandled =
    wasNativeAlertHandled(kind as any, ev.id, ts) ||
    wasNativeAlertHandled(kind as any, canonicalKey, ts);
  if (alreadyHandled) return;

  showLocalNotification(
    ev.title || "Buzz POS Alert",
    ev.body || "",
    "/pwa-192x192.png",
    canonicalKey
  ).catch(() => {});

  markNativeAlertHandled(kind as any, ev.id, ts);
  markNativeAlertHandled(kind as any, canonicalKey, ts);
}

/**
 * Pulls all missed notifications from the Cloudflare 24/7 Event Hub since the last cursor.
 * On first login/install for this user, seeds the cursor cleanly without firing historical alerts.
 */
export async function pullCloudflareEvents(
  uid: string,
  isAdmin: boolean
): Promise<void> {
  if (!uid) return;
  flushPendingCloudflareEvents().catch(() => {});

  const cursorKey = `buzz_cf_last_cursor_${uid}`;
  const rawCursor = localStorage.getItem(cursorKey);
  const isFirstSeed = rawCursor === null;
  const since = isFirstSeed ? 0 : Math.max(0, Number(rawCursor) || 0);
  const role = isAdmin ? "admin" : "user";
  const deviceId = getDeviceId();

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 6000);
    const url =
      `${CLOUDFLARE_EDGE_AI_URL}/api/events/pull` +
      `?since=${encodeURIComponent(String(since))}` +
      `&uid=${encodeURIComponent(uid)}` +
      `&role=${encodeURIComponent(role)}` +
      `&deviceId=${encodeURIComponent(deviceId)}`;

    const res = await fetch(url, { method: "GET", cache: "no-store", signal: controller.signal });
    clearTimeout(timer);
    if (!res.ok) return;
    const data = await res.json().catch(() => null);
    if (!data?.ok) return;

    const latestCursor = Math.max(
      since,
      Number(data.latestCursor || 0),
      isFirstSeed ? Number(data.serverTime || Date.now()) : 0
    );
    if (latestCursor > 0) {
      localStorage.setItem(cursorKey, String(latestCursor));
    }

    if (isFirstSeed) {
      // Seed baseline on first run so fresh installs never spam historical notifications
      return;
    }

    const events: CloudflareStoreEvent[] = Array.isArray(data.events) ? data.events : [];
    for (const ev of events) {
      handleIncomingCloudflareEvent(ev, uid);
    }
  } catch {}
}

/**
 * Keeps the foreground session synced with the 24/7 Cloudflare Event Hub without holding open
 * a heavy EventSource socket that reconnects/errors every 20s on mobile WebViews.
 * Immediate catch-up runs on mount, online reconnect, and app resume, plus a light 25s visible check.
 */
export function startCloudflareEventStream(
  uid: string,
  isAdmin: boolean
): () => void {
  if (!uid || typeof window === "undefined") {
    return () => {};
  }

  let closed = false;
  pullCloudflareEvents(uid, isAdmin).catch(() => {});

  const intervalId = setInterval(() => {
    if (closed) return;
    if (typeof navigator !== "undefined" && !navigator.onLine) return;
    if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
    pullCloudflareEvents(uid, isAdmin).catch(() => {});
  }, 25000);

  return () => {
    closed = true;
    clearInterval(intervalId);
  };
}
