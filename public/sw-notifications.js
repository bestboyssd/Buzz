// Background Notification Service Worker for Buzz POS
// Persists context in CacheStorage so idle Service Worker wakeups (periodicsync, sync, push, message)
// never lose user context and deliver instant background notifications.

const SW_STATE_CACHE = "buzz-sw-notif-state-v1";
const SW_STATE_URL = "/__buzz_sw_notif_state__.json";

let notifConfig = null;
const swNotifiedIds = new Set();
const swStockTransitionTimes = new Map();
const CANONICAL_STOCK_TTL_MS = 180000; // 3 minutes

async function saveStateToCache() {
  try {
    if (typeof caches === "undefined") return;
    const cache = await caches.open(SW_STATE_CACHE);
    const payload = {
      notifConfig,
      notifiedIds: Array.from(swNotifiedIds).slice(-350),
      savedAt: Date.now(),
    };
    await cache.put(
      SW_STATE_URL,
      new Response(JSON.stringify(payload), {
        headers: { "Content-Type": "application/json" },
      })
    );
  } catch (e) {
    // Ignore storage errors
  }
}

async function restoreStateFromCache() {
  if (notifConfig) return notifConfig;
  try {
    if (typeof caches === "undefined") return null;
    const cache = await caches.open(SW_STATE_CACHE);
    const resp = await cache.match(SW_STATE_URL);
    if (!resp) return null;
    const data = await resp.json();
    if (data && data.notifConfig) {
      notifConfig = data.notifConfig;
    }
    if (data && Array.isArray(data.notifiedIds)) {
      data.notifiedIds.forEach((id) => swNotifiedIds.add(String(id)));
    }
    return notifConfig;
  } catch (e) {
    return null;
  }
}

function parseFirestoreValue(valObj) {
  if (!valObj || typeof valObj !== "object") return undefined;
  if ("stringValue" in valObj) return valObj.stringValue;
  if ("integerValue" in valObj) return Number(valObj.integerValue);
  if ("doubleValue" in valObj) return Number(valObj.doubleValue);
  if ("booleanValue" in valObj) return Boolean(valObj.booleanValue);
  if ("nullValue" in valObj) return null;
  if ("arrayValue" in valObj) {
    const values = valObj.arrayValue?.values || [];
    return values.map(parseFirestoreValue);
  }
  if ("mapValue" in valObj) {
    return parseFirestoreFields(valObj.mapValue?.fields || {});
  }
  return undefined;
}

function parseFirestoreFields(fields) {
  if (!fields) return {};
  const result = {};
  for (const key of Object.keys(fields)) {
    result[key] = parseFirestoreValue(fields[key]);
  }
  return result;
}

async function fetchFirestoreDoc(docPath) {
  const cfg = notifConfig || (await restoreStateFromCache());
  if (!cfg || !cfg.projectId) return null;
  const dbId = encodeURIComponent(cfg.databaseId || "(default)");
  const apiKeyParam = cfg.apiKey ? `?key=${encodeURIComponent(cfg.apiKey)}` : "";
  const url = `https://firestore.googleapis.com/v1/projects/${encodeURIComponent(
    cfg.projectId
  )}/databases/${dbId}/documents/${docPath}${apiKeyParam}`;

  const headers = {};
  if (cfg.idToken) {
    headers["Authorization"] = `Bearer ${cfg.idToken}`;
  }

  try {
    let res = await fetch(url, { headers, cache: "no-store" });
    if ((res.status === 401 || res.status === 403) && headers["Authorization"]) {
      // Retry without expired bearer token since settings & sync_conflicts allow public read for background alerts
      res = await fetch(url, { cache: "no-store" });
    }
    if (!res.ok) return null;
    const json = await res.json();
    return parseFirestoreFields(json.fields);
  } catch (e) {
    return null;
  }
}

async function fetchFirestoreCollection(collectionPath, pageSize = 25) {
  const cfg = notifConfig || (await restoreStateFromCache());
  if (!cfg || !cfg.projectId) return [];
  const dbId = encodeURIComponent(cfg.databaseId || "(default)");
  const keyPart = cfg.apiKey ? `&key=${encodeURIComponent(cfg.apiKey)}` : "";
  const url = `https://firestore.googleapis.com/v1/projects/${encodeURIComponent(
    cfg.projectId
  )}/databases/${dbId}/documents/${collectionPath}?pageSize=${pageSize}${keyPart}`;

  const headers = {};
  if (cfg.idToken) {
    headers["Authorization"] = `Bearer ${cfg.idToken}`;
  }

  try {
    let res = await fetch(url, { headers, cache: "no-store" });
    if ((res.status === 401 || res.status === 403) && headers["Authorization"]) {
      res = await fetch(url, { cache: "no-store" });
    }
    if (!res.ok) return [];
    const json = await res.json();
    const docs = Array.isArray(json.documents) ? json.documents : [];
    return docs.map((d) => {
      const parsed = parseFirestoreFields(d.fields);
      const nameParts = String(d.name || "").split("/");
      parsed._docId = nameParts[nameParts.length - 1] || "";
      return parsed;
    });
  } catch (e) {
    return [];
  }
}

async function showSwNotification(title, body, tag) {
  if (swNotifiedIds.has(tag)) return;
  swNotifiedIds.add(tag);
  saveStateToCache();
  try {
    await self.registration.showNotification(title, {
      body,
      icon: "/pwa-192x192.png",
      badge: "/pwa-192x192.png",
      tag,
      renotify: false,
      vibrate: [200, 100, 200],
      data: { url: "/" },
    });
  } catch (e) {
    // Ignore permission errors if revoked
  }
}

async function checkBackgroundNotifications() {
  const cfg = notifConfig || (await restoreStateFromCache());
  if (!cfg || !cfg.userUid || cfg.notificationsEnabled === false) return;

  // Check if any window client is currently focused and visible; if so, let foreground handle it
  try {
    const clientList = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    const hasVisibleClient = clientList.some((c) => c.visibilityState === "visible");
    if (hasVisibleClient) return;
  } catch (e) {}

  const now = Date.now();
  const cutoff = now - 86400000;
  const uid = cfg.userUid;
  const email = (cfg.userEmail || "").toLowerCase();
  const deviceId = cfg.deviceId || "";
  const isAdmin = Boolean(cfg.isAdmin || cfg.isRealAdmin);
  const isRealAdmin = Boolean(cfg.isRealAdmin);

  // 1. Check Admin Broadcast Notification
  const broadcast = await fetchFirestoreDoc("settings/admin_broadcast_notification");
  if (broadcast && broadcast.timestamp) {
    const ts = Number(broadcast.timestamp) || 0;
    const tag = `admin_broadcast_${ts}`;
    const acked = Array.isArray(broadcast.acknowledgedBy) && broadcast.acknowledgedBy.includes(uid);
    const target = broadcast.targetAudience || "all";
    const roleMatches =
      target === "all" ||
      (target === "admins" && isAdmin) ||
      (target === "users" && !isAdmin);

    if (
      ts > cutoff &&
      broadcast.senderUid !== uid &&
      roleMatches &&
      !acked &&
      ts > (cfg.lastBroadcastNotifiedTime || 0) &&
      !swNotifiedIds.has(tag)
    ) {
      cfg.lastBroadcastNotifiedTime = ts;
      await showSwNotification(
        `🔔 ${broadcast.title || "Admin Announcement"}`,
        broadcast.message || "",
        tag
      );
    }
  }

  // 2. Check Security Alerts (Real Admins Only)
  if (isRealAdmin) {
    const secDoc = await fetchFirestoreDoc("settings/global_security_message");
    if (secDoc) {
      const events =
        Array.isArray(secDoc.events) && secDoc.events.length > 0
          ? secDoc.events
          : secDoc.timestamp
          ? [secDoc]
          : [];
      for (let i = 0; i < events.length; i++) {
        const ev = events[i];
        if (!ev) continue;
        const ts = Number(ev.timestamp) || 0;
        const evId = String(ev.alertId || ev.id || `ev_${ts}`);
        const tag = `security_alert_${evId}`;
        const evEmail = String(ev.userEmail || "").toLowerCase();
        const isSameUser =
          ev.userUid === uid || ev.userId === uid || (email && evEmail && email === evEmail);
        const isSameDevice =
          (deviceId && ev.deviceId && String(deviceId) === String(ev.deviceId)) ||
          (Array.isArray(cfg.localTriggeredSecurityIds) &&
            cfg.localTriggeredSecurityIds.includes(evId));
        const acked =
          (Array.isArray(ev.acknowledgedBy) && ev.acknowledgedBy.includes(uid)) ||
          (Array.isArray(secDoc.acknowledgedBy) && secDoc.acknowledgedBy.includes(uid));

        if (
          ts > cutoff &&
          !isSameUser &&
          !isSameDevice &&
          !acked &&
          !swNotifiedIds.has(tag)
        ) {
          const breachNum = ev.breachCount || i + 1;
          const msg =
            ev.type === "pin_login_bypass"
              ? `⚠️ Non-Admin account "${ev.userName || "Anonymous"}" (${
                  ev.userEmail || "no email"
                }) logged into Admin Panel using PIN (Break-In #${breachNum}).`
              : ev.message ||
                `${ev.userName || "Someone"} triggered a security alert on the Admin Panel.`;
          await showSwNotification(
            breachNum > 1 ? `🚨 Security Alert (Break-In #${breachNum})` : "🚨 Security Alert",
            msg,
            tag
          );
        }
      }
    }
  }

  // 3. Check Stock Alerts Feed (Every User Except Sender / Device)
  const stockFeed = await fetchFirestoreDoc("settings/stock_alerts_feed");
  const stockEvents = stockFeed
    ? Array.isArray(stockFeed.latestAlerts)
      ? stockFeed.latestAlerts
      : Array.isArray(stockFeed.events)
      ? stockFeed.events
      : []
    : [];
  if (stockEvents.length > 0) {
    const recentCutoff = now - 3600000; // last 1 hour
    for (const ev of stockEvents) {
      if (!ev) continue;
      const ts = Number(ev.timestamp) || 0;
      const evId = String(ev.id || `stock_${ts}`);
      const prodId = String(ev.productId || ev.productName || "unknown")
        .trim()
        .toLowerCase();
      const stock = Number(ev.stock ?? 0);
      const type = ev.type || (stock <= 0 ? "out_of_stock" : "low_stock");
      const canonicalTag = `stock_alert_${type}_${prodId}_${stock}`;
      const evDevice = ev.sourceDeviceId || ev.deviceId || "";
      const fromSelf =
        ev.triggeredByUid === uid ||
        (deviceId && evDevice && String(deviceId) === String(evDevice));

      const lastCanonicalTs = Number(swStockTransitionTimes.get(canonicalTag) || 0);
      const recentlyNotifiedCanonical =
        lastCanonicalTs > 0 && now - lastCanonicalTs < CANONICAL_STOCK_TTL_MS;

      if (
        ts > recentCutoff &&
        !fromSelf &&
        !swNotifiedIds.has(evId) &&
        !swNotifiedIds.has(canonicalTag) &&
        !recentlyNotifiedCanonical
      ) {
        swNotifiedIds.add(evId);
        swStockTransitionTimes.set(canonicalTag, now);
        const name = ev.productName || "Product";
        const title =
          type === "out_of_stock"
            ? "🚫 Out of Stock Alert"
            : type === "critical_low"
            ? "⚠️ Critical Low Stock"
            : "📉 Low Stock Alert";
        const body =
          type === "out_of_stock"
            ? `"${name}" just ran out of stock (0 left)!`
            : `"${name}" has only ${stock} unit${stock === 1 ? "" : "s"} left!`;
        await showSwNotification(title, body, canonicalTag);
      }
    }
  }

  // 4. Check Sync Conflicts (Offline Bill Stock Adjustment Alerts)
  const conflicts = await fetchFirestoreCollection("sync_conflicts", 20);
  if (Array.isArray(conflicts) && conflicts.length > 0) {
    const recentConflictCutoff = now - 3600000;
    for (const c of conflicts) {
      if (!c) continue;
      const resolved = Boolean(c.resolved);
      const ts = Number(c.timestamp) || 0;
      const docId = String(c._docId || c.id || `conflict_${ts}`);
      const tag = `conflict_alert_${docId}`;
      const targetUserId = String(c.userId || "");
      const isRelevant = isAdmin || (targetUserId && targetUserId === uid);
      if (!resolved && ts > recentConflictCutoff && isRelevant && !swNotifiedIds.has(tag)) {
        const prodName = c.productName || "Item";
        const requested = Number(c.requestedQty ?? 0);
        const fulfilled = Number(c.fulfilledQty ?? 0);
        await showSwNotification(
          "⚠️ Offline Bill Stock Conflict",
          `"${prodName}": requested ${requested}, only ${fulfilled} available during sync.`,
          tag
        );
      }
    }
  }
}

self.addEventListener("message", (event) => {
  const data = event.data;
  if (!data || typeof data !== "object") return;

  if (data.type === "SET_NOTIFICATION_CONTEXT") {
    notifConfig = data.payload || null;
    if (notifConfig) {
      if (Array.isArray(notifConfig.notifiedSecurityIds)) {
        notifConfig.notifiedSecurityIds.forEach((id) => swNotifiedIds.add(`security_alert_${id}`));
      }
      if (Array.isArray(notifConfig.notifiedStockIds)) {
        notifConfig.notifiedStockIds.forEach((id) => {
          swNotifiedIds.add(String(id));
          if (String(id).startsWith("stock_alert_")) {
            swStockTransitionTimes.set(String(id), Date.now());
          }
        });
      }
    }
    event.waitUntil(saveStateToCache());
  } else if (data.type === "CLEAR_NOTIFICATION_CONTEXT") {
    notifConfig = null;
    event.waitUntil(saveStateToCache());
  } else if (data.type === "CHECK_NOTIFICATIONS_NOW") {
    event.waitUntil(checkBackgroundNotifications());
  }
});

self.addEventListener("periodicsync", (event) => {
  if (event.tag === "buzz-pos-bg-notifications") {
    event.waitUntil(checkBackgroundNotifications());
  }
});

self.addEventListener("sync", (event) => {
  if (event.tag === "buzz-pos-bg-notifications") {
    event.waitUntil(checkBackgroundNotifications());
  }
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if ("focus" in client) {
          return client.focus();
        }
      }
      if (self.clients.openWindow) {
        return self.clients.openWindow("/");
      }
    })
  );
});
