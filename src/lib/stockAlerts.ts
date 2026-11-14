import { doc, getDoc, setDoc } from 'firebase/firestore';
import { db, auth } from './firebase';
import {
  getDeviceId,
  showLocalNotification,
  buildCanonicalStockKey,
  markNativeAlertHandled,
  wasNativeAlertHandled,
} from './utils';

export type StockAlertSeverity = 'out_of_stock' | 'critical_low' | 'low_stock';

export interface StockTransitionInput {
  productId: string;
  productName: string;
  prevStock: number;
  nextStock: number;
}

export interface StockAlertFeedEntry {
  id: string;
  productId: string;
  productName: string;
  type: StockAlertSeverity;
  stock: number;
  prevStock: number;
  timestamp: number;
  sourceUid?: string;
  sourceDeviceId?: string;
}

const RECENT_LOCAL_TRANSITIONS = new Map<string, number>();
const LOCAL_TRANSITION_TTL_MS = 30 * 1000;
const TWENTY_FOUR_HOURS_MS = 24 * 60 * 60 * 1000;

/**
 * Determines whether a stock level drop crosses a threshold that warrants an instant alert.
 */
export function classifyStockTransition(
  prevStock: number,
  nextStock: number
): StockAlertSeverity | null {
  const prev = Math.max(0, Number(prevStock) || 0);
  const next = Math.max(0, Number(nextStock) || 0);
  if (next >= prev) return null;
  if (next === 0 && prev > 0) return 'out_of_stock';
  if (next > 0 && next <= 3 && prev > 3) return 'critical_low';
  if (next > 3 && next <= 10 && prev > 10) return 'low_stock';
  return null;
}

/**
 * Checks whether a stock alert event was already emitted locally very recently
 * so snapshots triggered by our own write don't double-notify.
 */
export function wasStockTransitionRecentlyHandled(
  productId: string,
  type: StockAlertSeverity,
  stock: number
): boolean {
  const key = `${productId}:${type}:${stock}`;
  const last = RECENT_LOCAL_TRANSITIONS.get(key) || 0;
  return Date.now() - last < LOCAL_TRANSITION_TTL_MS;
}

export function markStockTransitionHandled(
  productId: string,
  type: StockAlertSeverity,
  stock: number
): void {
  const key = `${productId}:${type}:${stock}`;
  const now = Date.now();
  RECENT_LOCAL_TRANSITIONS.set(key, now);
  if (RECENT_LOCAL_TRANSITIONS.size > 150) {
    for (const [k, ts] of RECENT_LOCAL_TRANSITIONS.entries()) {
      if (now - ts > LOCAL_TRANSITION_TTL_MS) {
        RECENT_LOCAL_TRANSITIONS.delete(k);
      }
    }
  }
}

export function formatStockAlertNotification(entry: {
  productName: string;
  type: StockAlertSeverity;
  stock: number;
}): { title: string; body: string } {
  if (entry.type === 'out_of_stock') {
    return {
      title: '🚫 Out of Stock Alert',
      body: `"${entry.productName}" just ran out of stock (0 left)!`,
    };
  }
  if (entry.type === 'critical_low') {
    return {
      title: '⚠️ Critical Low Stock',
      body: `"${entry.productName}" has only ${entry.stock} unit${entry.stock === 1 ? '' : 's'} left!`,
    };
  }
  return {
    title: '📉 Low Stock Alert',
    body: `"${entry.productName}" is running low (${entry.stock} left).`,
  };
}

/**
 * Determines whether a stock alert from `settings/stock_alerts_feed` should trigger
 * a local notification on this device. Prevents fresh installs and newly signed-in
 * users from receiving alerts for historical out-of-stock events.
 */
export function shouldNotifyFeedStockAlert(params: {
  eventTimestamp: number;
  baselineTimestamp: number;
  isFirstSnapshot: boolean;
  hasPriorNotifiedHistory: boolean;
  fromSelf: boolean;
  alreadyHandledNative: boolean;
  recentlyHandledLocal: boolean;
}): boolean {
  if (params.fromSelf || params.alreadyHandledNative || params.recentlyHandledLocal) {
    return false;
  }
  // On a fresh install or first login for this user on this device, the first snapshot
  // seeds existing feed alerts as baseline and must never notify.
  if (params.isFirstSnapshot || !params.hasPriorNotifiedHistory) {
    return false;
  }
  // Never notify for events that occurred at or before the user's install/session baseline.
  if ((Number(params.eventTimestamp) || 0) <= (Number(params.baselineTimestamp) || 0)) {
    return false;
  }
  return true;
}

/**
 * Determines whether the daily out-of-stock / low-stock reminder should be silently
 * seeded instead of firing a notification because the app was just installed on this
 * device or this user is signing in on this device for the first time.
 */
export function shouldSuppressInitialInstallStockReminder(params: {
  hasDeviceBaselineSeeded: boolean;
  hasUserBaselineSeeded: boolean;
  isBrandNewAccount?: boolean;
}): boolean {
  if (params.isBrandNewAccount) return true;
  if (!params.hasDeviceBaselineSeeded || !params.hasUserBaselineSeeded) return true;
  return false;
}

/**
 * Immediately notifies on the local device and publishes threshold drops to Firestore
 * `settings/stock_alerts_feed` so all devices & background Android workers alert instantly.
 */
export async function publishStockTransitionAlerts(
  transitions: StockTransitionInput[]
): Promise<void> {
  if (!Array.isArray(transitions) || transitions.length === 0) return;

  const now = Date.now();
  const currentUid = auth.currentUser?.uid || '';
  const deviceId = getDeviceId();
  const entries: StockAlertFeedEntry[] = [];

  for (const t of transitions) {
    if (!t?.productId) continue;
    const prevStock = Math.max(0, Number(t.prevStock) || 0);
    const nextStock = Math.max(0, Number(t.nextStock) || 0);
    const type = classifyStockTransition(prevStock, nextStock);
    if (!type) continue;

    if (wasStockTransitionRecentlyHandled(t.productId, type, nextStock)) {
      continue;
    }
    markStockTransitionHandled(t.productId, type, nextStock);

    const productName = String(t.productName || 'Product').trim() || 'Product';
    const canonicalKey = buildCanonicalStockKey(type, String(t.productId), nextStock);
    const eventId = `stock_${type}_${t.productId}_${nextStock}_${now}`;
    const entry: StockAlertFeedEntry = {
      id: eventId,
      productId: String(t.productId),
      productName,
      type,
      stock: nextStock,
      prevStock,
      timestamp: now,
      sourceUid: currentUid,
      sourceDeviceId: deviceId,
    };
    entries.push(entry);

    const alreadyNotifiedNative =
      wasNativeAlertHandled('stock', eventId, now) ||
      wasNativeAlertHandled('stock', canonicalKey, now);
    markNativeAlertHandled('stock', eventId, now);
    markNativeAlertHandled('stock', canonicalKey, now);

    if (!alreadyNotifiedNative) {
      const { title, body } = formatStockAlertNotification(entry);
      showLocalNotification(title, body, '/pwa-192x192.png', canonicalKey).catch(() => {});
    }
  }

  if (entries.length === 0) return;

  try {
    const feedRef = doc(db, 'settings', 'stock_alerts_feed');
    let existingAlerts: StockAlertFeedEntry[] = [];
    try {
      const snap = await Promise.race([
        getDoc(feedRef),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), 1500)),
      ]);
      if (snap && snap.exists()) {
        const data = snap.data();
        const raw = Array.isArray(data?.latestAlerts) ? data.latestAlerts : [];
        existingAlerts = raw.filter(
          (item: any) => item && Number(item.timestamp || 0) > now - TWENTY_FOUR_HOURS_MS
        );
      }
    } catch {}

    const byKey = new Map<string, StockAlertFeedEntry>();
    for (const item of existingAlerts) {
      if (item?.id) byKey.set(String(item.id), item);
    }
    for (const item of entries) {
      byKey.set(item.id, item);
    }

    const merged = Array.from(byKey.values())
      .sort((a, b) => (Number(b.timestamp) || 0) - (Number(a.timestamp) || 0))
      .slice(0, 25);

    await setDoc(
      feedRef,
      {
        latestAlerts: merged,
        updatedAt: now,
      },
      { merge: true }
    );
  } catch (err) {
    console.debug('Failed to publish stock_alerts_feed event:', err);
  }
}
