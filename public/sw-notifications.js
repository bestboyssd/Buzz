// Background Notification Service Worker Extension for Buzz POS
let notifConfig = null;
const swNotifiedIds = new Set();

function parseFirestoreField(val) {
  if (!val || typeof val !== "object") return undefined;
  if ("stringValue" in val) return val.stringValue;
  if ("integerValue" in val) return Number(val.integerValue);
  if ("doubleValue" in val) return Number(val.doubleValue);
  if ("booleanValue" in val) return Boolean(val.booleanValue);
  if ("nullValue" in val) return null;
  if ("arrayValue" in val) {
    const values = val.arrayValue && Array.isArray(val.arrayValue.values) ? val.arrayValue.values : [];
    return values.map(parseFirestoreField);
  }
  if ("mapValue" in val) {
    const fields = val.mapValue && val.mapValue.fields ? val.mapValue.fields : {};
    const out = {};
    for (const k of Object.keys(fields)) {
      out[k] = parseFirestoreField(fields[k]);
    }
    return out;
  }
  return undefined;
}

function parseFirestoreDoc(docJson) {
  if (!docJson || !docJson.fields) return null;
  const out = {};
  for (const k of Object.keys(docJson.fields)) {
    out[k] = parseFirestoreField(docJson.fields[k]);
  }
  return out;
}

async function fetchSettingDoc(docId) {
  if (!notifConfig || !notifConfig.projectId || !notifConfig.apiKey) return null;
  const dbId = notifConfig.databaseId || "(default)";
  const url = `https://firestore.googleapis.com/v1/projects/${encodeURIComponent(
    notifConfig.projectId
  )}/databases/${encodeURIComponent(
    dbId
  )}/documents/settings/${encodeURIComponent(docId)}?key=${encodeURIComponent(
    notifConfig.apiKey
  )}`;
  const headers = {};
  if (notifConfig.idToken) {
    headers["Authorization"] = `Bearer ${notifConfig.idToken}`;
  }
  try {
    const res = await fetch(url, { headers, cache: "no-store" });
    if (!res.ok) return null;
    const json = await res.json();
    return parseFirestoreDoc(json);
  } catch {
    return null;
  }
}

async function checkBackgroundNotifications() {
  if (!notifConfig || !notifConfig.userUid || !notifConfig.notificationsEnabled) {
    return;
  }

  // Only fire from Service Worker when no client window is currently focused/visible,
  // or if explicitly requested while backgrounded
  let hasVisibleClient = false;
  try {
    const clientList = await self.clients.matchAll({
      type: "window",
      includeUncontrolled: true,
    });
    for (const c of clientList) {
      if (c.visibilityState === "visible") {
        hasVisibleClient = true;
        break;
      }
    }
  } catch {}

  if (hasVisibleClient) {
    return;
  }

  const uid = notifConfig.userUid;
  const isAdmin = Boolean(notifConfig.isAdmin || notifConfig.isRealAdmin);
  const cutoff = Math.max(Date.now() - 86400000, (Number(notifConfig.configLoadedAt) || Date.now()) - 60000);

  // 1. Check Admin Broadcast Notification
  const broadcast = await fetchSettingDoc("admin_broadcast_notification");
  if (broadcast && Number(broadcast.timestamp) > cutoff) {
    const ts = Number(broadcast.timestamp);
    const acked =
      Array.isArray(broadcast.acknowledgedBy) &&
      broadcast.acknowledgedBy.includes(uid);
    const bKey = `sw_broadcast_${ts}`;
    const target = broadcast.targetAudience || "all";
    const matchesRole =
      target === "all" ||
      (target === "admins" && isAdmin) ||
      (target === "users" && !isAdmin);

    if (
      broadcast.senderUid !== uid &&
      matchesRole &&
      !acked &&
      ts > (Number(notifConfig.lastBroadcastNotifiedTime) || 0) &&
      !swNotifiedIds.has(bKey)
    ) {
      swNotifiedIds.add(bKey);
      notifConfig.lastBroadcastNotifiedTime = ts;
      await self.registration.showNotification(
        `🔔 ${broadcast.title || "Admin Announcement"}`,
        {
          body: broadcast.message || "",
          icon: "/pwa-192x192.png",
          badge: "/pwa-192x192.png",
          tag: `admin_broadcast_${ts}`,
          renotify: true,
          vibrate: [180, 80, 180],
        }
      );
    }
  }

  // 2. Check Security Alerts (Admins Only)
  if (notifConfig.isRealAdmin === true) {
    const secDoc = await fetchSettingDoc("global_security_message");
    if (secDoc) {
      const events = Array.isArray(secDoc.events)
        ? secDoc.events
        : secDoc.timestamp
        ? [secDoc]
        : [];
      for (const ev of events) {
        const ts = Number(ev.timestamp) || 0;
        const evId = String(ev.id || ev.alertId || `sec_${ts}`);
        const acked =
          (Array.isArray(ev.acknowledgedBy) && ev.acknowledgedBy.includes(uid)) ||
          (Array.isArray(secDoc.acknowledgedBy) && secDoc.acknowledgedBy.includes(uid));
        const sameUserEmail =
          Boolean(notifConfig.userEmail && ev.userEmail) &&
          String(ev.userEmail).trim().toLowerCase() ===
            String(notifConfig.userEmail).trim().toLowerCase();
        const sameDevice =
          Boolean(notifConfig.deviceId && (ev.deviceId || secDoc.deviceId)) &&
          String(ev.deviceId || secDoc.deviceId) === String(notifConfig.deviceId);
        const locallyTriggered =
          Array.isArray(notifConfig.localTriggeredSecurityIds) &&
          notifConfig.localTriggeredSecurityIds.includes(evId);

        if (
          ts > cutoff &&
          ev.userUid !== uid &&
          ev.userId !== uid &&
          !sameUserEmail &&
          !sameDevice &&
          !locallyTriggered &&
          !acked &&
          !swNotifiedIds.has(evId) &&
          !(Array.isArray(notifConfig.notifiedSecurityIds) && notifConfig.notifiedSecurityIds.includes(evId))
        ) {
          swNotifiedIds.add(evId);
          await self.registration.showNotification("🚨 Security Alert", {
            body:
              ev.message ||
              `Non-Admin account "${ev.userName || "Someone"}" broke into the Admin Panel.`,
            icon: "/pwa-192x192.png",
            badge: "/pwa-192x192.png",
            tag: `security_alert_${evId}`,
            renotify: true,
            vibrate: [220, 100, 220],
          });
        }
      }
    }
  }
}

self.addEventListener("message", (event) => {
  const data = event.data;
  if (!data || typeof data !== "object") return;
  if (data.type === "CLEAR_NOTIFICATION_CONTEXT") {
    notifConfig = null;
    return;
  }
  if (data.type === "SET_NOTIFICATION_CONTEXT") {
    const prevUid = notifConfig && notifConfig.userUid;
    const nextUid = data.payload && data.payload.userUid;
    const configLoadedAt =
      prevUid && prevUid === nextUid && notifConfig.configLoadedAt
        ? notifConfig.configLoadedAt
        : Date.now();
    notifConfig = {
      ...(notifConfig || {}),
      ...data.payload,
      configLoadedAt,
    };
  } else if (data.type === "CHECK_NOTIFICATIONS_NOW") {
    checkBackgroundNotifications().catch(() => {});
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
    self.clients
      .matchAll({ type: "window", includeUncontrolled: true })
      .then((clientList) => {
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
