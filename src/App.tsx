/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useEffect, useState, useRef } from "react";
import { BrowserRouter, Routes, Route, useLocation, useNavigate } from "react-router-dom";
import { AnimatePresence, motion } from "motion/react";
import { BottomNav } from "./components/BottomNav";
import { Home } from "./pages/Home";
import { Products } from "./pages/Products";
import { History } from "./pages/History";
import { Analytics } from "./pages/Analytics";
import { Settings } from "./pages/Settings";
import { Checkout } from "./pages/Checkout";
import { Admin } from "./pages/Admin";
import { AllBills } from "./pages/AllBills";
import { OtherCosts } from "./pages/OtherCosts";
import { Login } from "./pages/Login";
import { Account } from "./pages/Account";
import { PrivacyPolicy } from "./pages/PrivacyPolicy";
import { AuthProvider, useAuth } from "./lib/AuthContext";
import { CartProvider } from "./lib/CartContext";

import {
  ProductsProvider,
  useGlobalProducts,
  getDeletedProductIds,
  getDeletedProductNames,
} from "./lib/ProductsContext";
import { BillsProvider, useGlobalBills } from "./lib/BillsContext";
import { getImageUrl } from "./lib/imageUtils";
import { KeepAwake } from "@capacitor-community/keep-awake";
import { Capacitor } from "@capacitor/core";
import { SplashScreen } from "@capacitor/splash-screen";
import { LocalNotifications } from "@capacitor/local-notifications";
import { AlertOctagon, Bell, WifiOff, RefreshCw, AlertTriangle, IndianRupee } from "lucide-react";
import {
  doc,
  onSnapshot,
  getDoc,
  getDocs,
  collection,
  deleteDoc,
  setDoc,
  query,
  orderBy,
  limit,
  arrayUnion,
} from "firebase/firestore";
import { db } from "./lib/firebase";
import {
  getOfflinePendingBills,
  syncOfflinePendingBills,
  retryAllOfflineConflictBills,
  SyncConflictRecord,
  getEffectiveProductCost,
  Product,
} from "./lib/firestoreHooks";
import {
  showLocalNotification,
  ensureNotificationChannel,
  formatPrice,
  getAppBusinessIsoDate,
  getDeviceId,
  isLocalSecurityAlertTriggered,
} from "./lib/utils";
import appletConfig from "../firebase-applet-config.json";

const formatDateToDMY = (timestamp: number | string | Date) => {
  const d = new Date(timestamp);
  if (isNaN(d.getTime())) return "";
  const day = String(d.getDate()).padStart(2, "0");
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const year = d.getFullYear();
  return `${day}/${month}/${year}`;
};

function AnimatedRoutes() {
  const location = useLocation();
  const { isAdmin, isRealAdmin } = useAuth();

  useEffect(() => {
    // Reset main scroll container to top on route navigation
    const scrollContainer = document.getElementById("app-scroll-container");
    if (scrollContainer) {
      scrollContainer.scrollTo({ top: 0, left: 0, behavior: "instant" as ScrollBehavior });
    }

    // Keep adminAuth active for permanent admins; only clear temporary PIN unlock when leaving admin pages
    if (isRealAdmin || isAdmin) {
      sessionStorage.setItem("adminAuth", "true");
    } else {
      const adminRoutes = ["/admin", "/all-bills", "/analytics", "/other-costs"];
      if (!adminRoutes.includes(location.pathname)) {
        sessionStorage.removeItem("adminAuth");
        window.dispatchEvent(new Event("adminAuthChanged"));
      }
    }
  }, [location.pathname, isAdmin, isRealAdmin]);

  return (
    <AnimatePresence mode="wait">
      <Routes location={location} key={location.pathname}>
        <Route path="/" element={<Home />} />
        <Route path="/checkout" element={<Checkout />} />
        <Route path="/products" element={<Products />} />
        <Route path="/history" element={<History />} />
        <Route path="/admin" element={<Admin />} />
        <Route path="/all-bills" element={<AllBills />} />
        <Route path="/analytics" element={<Analytics />} />
        <Route path="/other-costs" element={<OtherCosts />} />
        <Route path="/settings" element={<Settings />} />
        <Route path="/account" element={<Account />} />
        <Route path="/privacy" element={<PrivacyPolicy />} />
      </Routes>
    </AnimatePresence>
  );
}

function AppContent() {
  const { user, loading, isAdmin, isRealAdmin } = useAuth();
  const [securityMessage, setSecurityMessage] = useState<any | null>(null);
  const [broadcastNotification, setBroadcastNotification] = useState<any | null>(null);
  const [showExitToast, setShowExitToast] = useState(false);

  useEffect(() => {
    let timer: any;
    const handleExitToast = () => {
      setShowExitToast(true);
      clearTimeout(timer);
      timer = setTimeout(() => {
        setShowExitToast(false);
      }, 2000);
    };

    window.addEventListener('showExitToast', handleExitToast);
    return () => {
      window.removeEventListener('showExitToast', handleExitToast);
      clearTimeout(timer);
    };
  }, []);
  
  // Ref to prevent double notifications in the same session
  const lastNotifiedRef = useRef<number>(0);
  const appMountTimeRef = useRef<number>(Date.now());
  const isInitialSecurityPassRef = useRef<boolean>(true);
  const isInitialStockPassRef = useRef<boolean>(true);

  const [isOnline, setIsOnline] = useState(() =>
    typeof navigator !== "undefined" ? navigator.onLine : true
  );
  const [offlineQueueCount, setOfflineQueueCount] = useState<number>(() =>
    getOfflinePendingBills().length
  );
  const [isSyncingOffline, setIsSyncingOffline] = useState(false);
  const [offlineConflictAlerts, setOfflineConflictAlerts] = useState<SyncConflictRecord[]>([]);
  const [isRetryingConflicts, setIsRetryingConflicts] = useState(false);

  const handleRetryAllOfflineBills = async () => {
    if (isRetryingConflicts) return;
    setIsRetryingConflicts(true);
    try {
      const toRetry = [...offlineConflictAlerts];
      setOfflineConflictAlerts([]);
      await retryAllOfflineConflictBills(toRetry);
    } catch (err) {
      console.warn("Retry all offline bills failed:", err);
    } finally {
      setIsRetryingConflicts(false);
    }
  };

  useEffect(() => {
    const handleOnline = () => {
      setIsOnline(true);
      syncOfflinePendingBills().catch(() => {});
    };
    const handleOffline = () => setIsOnline(false);
    const handleQueueUpdated = (e: Event) => {
      const custom = e as CustomEvent<{ count?: number }>;
      setOfflineQueueCount(
        custom.detail?.count !== undefined
          ? custom.detail.count
          : getOfflinePendingBills().length
      );
    };
    const handleSyncState = (e: Event) => {
      const custom = e as CustomEvent<{ syncing?: boolean; count?: number }>;
      setIsSyncingOffline(Boolean(custom.detail?.syncing));
      if (custom.detail?.count !== undefined) {
        setOfflineQueueCount(custom.detail.count);
      }
    };
    const handleConflictDetected = (e: Event) => {
      const custom = e as CustomEvent<SyncConflictRecord>;
      const conflict = custom.detail;
      if (!conflict) return;
      setOfflineConflictAlerts((prev) => {
        const existsIdx = prev.findIndex((c) => c.id === conflict.id);
        if (existsIdx !== -1) {
          const updated = [...prev];
          updated[existsIdx] = conflict;
          return updated;
        }
        return [...prev, conflict];
      });
      showLocalNotification(
        `⚠️ Offline Bill #${conflict.billId.slice(-5)} Failed`,
        `Stock was already billed online while you were offline. Bill (₹${formatPrice(
          conflict.total
        )}) was cancelled.`,
        "/pwa-192x192.png",
        `offline_conflict_${conflict.id}`
      );
    };
    const handleConflictResolvedByRetry = (e: Event) => {
      const custom = e as CustomEvent<{ billId?: string; conflictId?: string }>;
      const cid = custom.detail?.conflictId;
      const bid = custom.detail?.billId;
      setOfflineConflictAlerts((prev) =>
        prev.filter((c) => c.id !== cid && c.billId !== bid)
      );
    };

    if (typeof navigator === "undefined" || navigator.onLine) {
      syncOfflinePendingBills().catch(() => {});
    }

    window.addEventListener("online", handleOnline);
    window.addEventListener("offline", handleOffline);
    window.addEventListener("offlineQueueUpdated", handleQueueUpdated);
    window.addEventListener("offlineSyncStateChanged", handleSyncState);
    window.addEventListener("offlineSyncConflictDetected", handleConflictDetected);
    window.addEventListener("offlineConflictResolvedByRetry", handleConflictResolvedByRetry);
    return () => {
      window.removeEventListener("online", handleOnline);
      window.removeEventListener("offline", handleOffline);
      window.removeEventListener("offlineQueueUpdated", handleQueueUpdated);
      window.removeEventListener("offlineSyncStateChanged", handleSyncState);
      window.removeEventListener("offlineSyncConflictDetected", handleConflictDetected);
      window.removeEventListener("offlineConflictResolvedByRetry", handleConflictResolvedByRetry);
    };
  }, []);

  const getDismissedKey = (uid?: string) =>
    uid ? `dismissedSecurityMessageTime_${uid}` : user ? `dismissedSecurityMessageTime_${user.uid}` : "dismissedSecurityMessageTime";
  const getNotifiedKey = (uid?: string) =>
    uid ? `lastSecurityNotifiedTime_${uid}` : user ? `lastSecurityNotifiedTime_${user.uid}` : "lastSecurityNotifiedTime";

  const [dismissedMessageTime, setDismissedMessageTime] = useState<number>(() => {
    return parseInt(localStorage.getItem(getDismissedKey()) || "0", 10);
  });

  // Keep state in sync with user changes and reset session baseline so new/switched accounts are never showered with old notifications
  useEffect(() => {
    appMountTimeRef.current = Date.now();
    isInitialSecurityPassRef.current = true;
    isInitialStockPassRef.current = true;
    if (!user) {
      setSecurityMessage(null);
      setDismissedMessageTime(0);
      lastNotifiedRef.current = 0;
      return;
    }
    const userDismissed = parseInt(localStorage.getItem(getDismissedKey(user.uid)) || "0", 10);
    const userNotified = parseInt(localStorage.getItem(getNotifiedKey(user.uid)) || "0", 10);
    setDismissedMessageTime(userDismissed);
    lastNotifiedRef.current = userNotified;
  }, [user?.uid]);

  const getNotifiedSecurityIdsKey = (uid?: string) =>
    uid ? `notified_security_ids_${uid}` : user ? `notified_security_ids_${user.uid}` : "notified_security_ids";

  const handleDismissSecurityMessage = (alertObj: any) => {
    const timestamp = Number(alertObj?.timestamp) || Date.now();
    setDismissedMessageTime(timestamp);
    setSecurityMessage(null);
    if (user?.uid) {
      localStorage.setItem(getDismissedKey(user.uid), timestamp.toString());
      // Record per-admin acknowledgment in Firestore without deleting or hiding the alert for other admins
      const updatedEvents = Array.isArray(alertObj?.events)
        ? alertObj.events.map((ev: any) => ({
            ...ev,
            acknowledgedBy: Array.from(
              new Set([...(Array.isArray(ev?.acknowledgedBy) ? ev.acknowledgedBy : []), user.uid])
            ),
          }))
        : undefined;

      setDoc(
        doc(db, "settings", "global_security_message"),
        {
          acknowledgedBy: arrayUnion(user.uid),
          ...(updatedEvents ? { events: updatedEvents } : {}),
        },
        { merge: true }
      ).catch(() => {});

      const allIdsToAck = new Set<string>();
      const primaryId = alertObj?.alertId || alertObj?.id;
      if (primaryId) allIdsToAck.add(String(primaryId));
      if (Array.isArray(alertObj?.unreadEvents)) {
        alertObj.unreadEvents.forEach((ev: any) => {
          const eid = ev?.alertId || ev?.id;
          if (eid && !String(eid).startsWith("legacy_")) allIdsToAck.add(String(eid));
        });
      }
      allIdsToAck.forEach((targetAlertId) => {
        setDoc(
          doc(db, "security_alerts", targetAlertId),
          { acknowledgedBy: arrayUnion(user.uid) },
          { merge: true }
        ).catch(() => {});
      });
    }
  };

  // Admin Broadcast Notification Listener (Target: All, Admins Only, or Normal Users)
  const lastBroadcastNotifiedRef = useRef<number>(0);
  const getDismissedBroadcastKey = (uid?: string) =>
    uid ? `dismissedBroadcastTime_${uid}` : user ? `dismissedBroadcastTime_${user.uid}` : "dismissedBroadcastTime";
  const getNotifiedBroadcastKey = (uid?: string) =>
    uid ? `lastBroadcastNotifiedTime_${uid}` : user ? `lastBroadcastNotifiedTime_${user.uid}` : "lastBroadcastNotifiedTime";

  const [dismissedBroadcastTime, setDismissedBroadcastTime] = useState<number>(() => {
    return parseInt(localStorage.getItem(getDismissedBroadcastKey()) || "0", 10);
  });

  useEffect(() => {
    if (!user) {
      setBroadcastNotification(null);
      setDismissedBroadcastTime(0);
      lastBroadcastNotifiedRef.current = 0;
      return;
    }
    const currentUid = user.uid;
    setDismissedBroadcastTime(
      parseInt(localStorage.getItem(getDismissedBroadcastKey(currentUid)) || "0", 10)
    );
    lastBroadcastNotifiedRef.current = parseInt(
      localStorage.getItem(getNotifiedBroadcastKey(currentUid)) || "0",
      10
    );

    const broadcastDocRef = doc(db, "settings", "admin_broadcast_notification");
    const unsubBroadcast = onSnapshot(
      broadcastDocRef,
      (docSnap) => {
        if (!docSnap.exists()) {
          setBroadcastNotification(null);
          return;
        }
        const data = docSnap.data();
        const ts = Number(data?.timestamp) || 0;
        if (!ts || ts <= Date.now() - 86400000) {
          setBroadcastNotification(null);
          return;
        }
        // Do not notify the admin who sent it
        if (data?.senderUid === currentUid) {
          setBroadcastNotification(null);
          return;
        }
        // Check audience targeting
        const target = data?.targetAudience || "all";
        const userIsAdmin = Boolean(isRealAdmin || isAdmin);
        if (target === "admins" && !userIsAdmin) {
          setBroadcastNotification(null);
          return;
        }
        if (target === "users" && userIsAdmin) {
          setBroadcastNotification(null);
          return;
        }
        // Check if already acknowledged
        if (Array.isArray(data?.acknowledgedBy) && data.acknowledgedBy.includes(currentUid)) {
          setBroadcastNotification(null);
          return;
        }
        const dismissedTs = parseInt(
          localStorage.getItem(getDismissedBroadcastKey(currentUid)) || "0",
          10
        );
        if (ts <= dismissedTs) {
          setBroadcastNotification(null);
          return;
        }

        setBroadcastNotification(data);
        const lastNotified = Math.max(
          parseInt(localStorage.getItem(getNotifiedBroadcastKey(currentUid)) || "0", 10),
          lastBroadcastNotifiedRef.current
        );
        if (ts > lastNotified) {
          lastBroadcastNotifiedRef.current = ts;
          localStorage.setItem(getNotifiedBroadcastKey(currentUid), ts.toString());
          if (ts >= appMountTimeRef.current - 120000) {
            showLocalNotification(
              `🔔 ${data.title || "Admin Announcement"}`,
              data.message || "",
              "/pwa-192x192.png",
              `admin_broadcast_${ts}`
            );
          }
        }
      },
      (err) => {
        console.warn("Broadcast notification listener error bypassed", err);
      }
    );

    return () => unsubBroadcast();
  }, [user?.uid, isAdmin, isRealAdmin]);

  const handleDismissBroadcastNotification = (notifObj: any) => {
    const ts = Number(notifObj?.timestamp) || Date.now();
    setDismissedBroadcastTime(ts);
    setBroadcastNotification(null);
    if (user?.uid) {
      localStorage.setItem(getDismissedBroadcastKey(user.uid), ts.toString());
      setDoc(
        doc(db, "settings", "admin_broadcast_notification"),
        { acknowledgedBy: arrayUnion(user.uid) },
        { merge: true }
      ).catch(() => {});
    }
  };

  // 2. Subscribe to both global_security_message and security_alerts so EVERY admin on OTHER devices receives ALL unacknowledged alerts + exact break-in count
  useEffect(() => {
    if (!user || !isRealAdmin) {
      setSecurityMessage(null);
      return;
    }

    const currentUid = user.uid;
    const currentEmail = String(user.email || "").trim().toLowerCase();
    const currentDeviceId = getDeviceId();
    let latestGlobalDoc: any = null;
    let collectionAlertDocs: any[] = [];
    let globalSnapLoaded = false;
    let collectionSnapLoaded = false;

    const getNotifiedIdSet = (): Set<string> => {
      try {
        const raw = localStorage.getItem(getNotifiedSecurityIdsKey(currentUid));
        if (raw) {
          const parsed = JSON.parse(raw);
          if (Array.isArray(parsed)) return new Set(parsed.map(String));
        }
      } catch {}
      return new Set<string>();
    };

    const saveNotifiedIdSet = (set: Set<string>) => {
      try {
        localStorage.setItem(
          getNotifiedSecurityIdsKey(currentUid),
          JSON.stringify(Array.from(set).slice(-200))
        );
      } catch {}
    };

    const evaluateActiveAlert = (isInitialSnapshotPass: boolean) => {
      if (!isRealAdmin) {
        setSecurityMessage(null);
        return;
      }
      const dismissedTime = parseInt(
        localStorage.getItem(getDismissedKey(currentUid)) || "0",
        10
      );
      const cutoff = Date.now() - 86400000;

      // Gather all events from global_security_message.events + top-level global_security_message + security_alerts collection
      const allEventsMap = new Map<string, any>();

      if (latestGlobalDoc) {
        const globalAcked =
          Array.isArray(latestGlobalDoc.acknowledgedBy) &&
          latestGlobalDoc.acknowledgedBy.includes(currentUid);

        if (Array.isArray(latestGlobalDoc.events) && latestGlobalDoc.events.length > 0) {
          latestGlobalDoc.events.forEach((ev: any) => {
            if (!ev) return;
            const ts = Number(ev.timestamp) || 0;
            const id = String(ev.alertId || ev.id || `ev_${ts}`);
            allEventsMap.set(id, {
              ...ev,
              id,
              alertId: id,
              deviceId: ev.deviceId || latestGlobalDoc.deviceId || "",
              acknowledgedBy: Array.isArray(ev.acknowledgedBy)
                ? ev.acknowledgedBy
                : globalAcked
                ? [currentUid]
                : [],
            });
          });
        } else if (latestGlobalDoc.timestamp) {
          const ts = Number(latestGlobalDoc.timestamp) || 0;
          const id = String(latestGlobalDoc.alertId || latestGlobalDoc.id || `ev_${ts}`);
          allEventsMap.set(id, {
            ...latestGlobalDoc,
            id,
            alertId: id,
            deviceId: latestGlobalDoc.deviceId || "",
          });
        }
      }

      collectionAlertDocs.forEach((d: any) => {
        if (!d) return;
        const ts = Number(d.timestamp) || 0;
        const id = String(d.alertId || d.id || `ev_${ts}`);
        if (!allEventsMap.has(id)) {
          allEventsMap.set(id, { ...d, id, alertId: id, deviceId: d.deviceId || "" });
        }
      });

      const recentEvents = Array.from(allEventsMap.values())
        .filter((item) => {
          const ts = Number(item?.timestamp) || 0;
          const itemEmail = String(item?.userEmail || "").trim().toLowerCase();
          const isSameUser =
            item.userUid === currentUid ||
            item.userId === currentUid ||
            (Boolean(currentEmail && itemEmail) && itemEmail === currentEmail);
          const isSameDevice =
            (Boolean(item.deviceId && currentDeviceId) &&
              String(item.deviceId) === String(currentDeviceId)) ||
            isLocalSecurityAlertTriggered(item.id || item.alertId);
          return ts > cutoff && !isSameUser && !isSameDevice;
        })
        .sort((a, b) => Number(a.timestamp) - Number(b.timestamp));

      const unreadEvents = recentEvents.filter((item) => {
        const ts = Number(item?.timestamp) || 0;
        const acked =
          Array.isArray(item.acknowledgedBy) && item.acknowledgedBy.includes(currentUid);
        return !acked && ts > dismissedTime;
      });

      // Consolidate cold-start security alerts so opening the app doesn't chime for historical events
      const notifiedSet = getNotifiedIdSet();
      let setModified = false;

      if (isInitialSecurityPassRef.current || isInitialSnapshotPass) {
        if (globalSnapLoaded && collectionSnapLoaded) {
          isInitialSecurityPassRef.current = false;
        }
        unreadEvents.forEach((ev) => {
          const evId = String(ev.alertId || ev.id || `ev_${ev.timestamp}`);
          if (!notifiedSet.has(evId)) {
            notifiedSet.add(evId);
            setModified = true;
            const ts = Number(ev.timestamp) || Date.now();
            if (ts > lastNotifiedRef.current) {
              lastNotifiedRef.current = ts;
              localStorage.setItem(getNotifiedKey(currentUid), ts.toString());
            }
          }
        });
      } else {
        unreadEvents.forEach((ev, idx) => {
          const evId = String(ev.alertId || ev.id || `ev_${ev.timestamp}`);
          if (!notifiedSet.has(evId)) {
            notifiedSet.add(evId);
            setModified = true;
            const ts = Number(ev.timestamp) || Date.now();
            if (ts > lastNotifiedRef.current) {
              lastNotifiedRef.current = ts;
              localStorage.setItem(getNotifiedKey(currentUid), ts.toString());
            }
            // Only fire system push notification for live events that occurred while this session is active
            if (ts >= appMountTimeRef.current - 15000) {
              const breachNum = ev.breachCount || idx + 1;
              const msg =
                ev.type === "pin_login_bypass"
                  ? `⚠️ Non-Admin account "${ev.userName || "Anonymous"}" (${
                      ev.userEmail || "no email"
                    }) logged into Admin Panel using PIN (Break-In #${breachNum}).`
                  : ev.message ||
                    `${ev.userName || "Someone"} triggered a security alert on the Admin Panel.`;

              showLocalNotification(
                breachNum > 1 ? `🚨 Security Alert (Break-In #${breachNum})` : "🚨 Security Alert",
                msg,
                "/pwa-192x192.png",
                `security_alert_${evId}`
              );
            }
          }
        });
      }

      if (setModified) {
        saveNotifiedIdSet(notifiedSet);
      }

      if (unreadEvents.length > 0) {
        const latestUnread = unreadEvents[unreadEvents.length - 1];
        // Count how many times this user broke into the Admin Panel across unread events (and 24h events)
        const sameUserUnread = unreadEvents.filter(
          (e) =>
            (e.userUid && e.userUid === latestUnread.userUid) ||
            (e.userEmail && e.userEmail === latestUnread.userEmail)
        );
        const computedBreachCount = Math.max(
          Number(latestUnread.breachCount) || 0,
          sameUserUnread.length,
          unreadEvents.length
        );

        const displayMessage =
          latestUnread.type === "pin_login_bypass"
            ? computedBreachCount > 1
              ? `⚠️ Security Warning! Non-Admin account "${
                  latestUnread.userName || "Anonymous"
                }" (${
                  latestUnread.userEmail || "No email"
                }) broke into the Admin Panel ${computedBreachCount} times using the security PIN.`
              : `⚠️ Security Warning! Non-Admin account "${
                  latestUnread.userName || "Anonymous"
                }" (${
                  latestUnread.userEmail || "No email"
                }) successfully logged into the Admin Panel using the security PIN (1 time).`
            : latestUnread.message;

        setSecurityMessage({
          ...latestUnread,
          message: displayMessage,
          breachCount: computedBreachCount,
          unreadEvents,
          events: latestGlobalDoc?.events || unreadEvents,
        });
      } else {
        setSecurityMessage(null);
      }
    };

    const docRef = doc(db, "settings", "global_security_message");
    const unsubGlobal = onSnapshot(
      docRef,
      (docSnap) => {
        const wasInitial = !globalSnapLoaded;
        globalSnapLoaded = true;
        latestGlobalDoc = docSnap.exists() ? docSnap.data() : null;
        evaluateActiveAlert(wasInitial);
      },
      (err) => {
        globalSnapLoaded = true;
        console.warn("Global security message listener error bypassed", err);
      }
    );

    const alertsQuery = query(
      collection(db, "security_alerts"),
      orderBy("timestamp", "desc"),
      limit(30)
    );
    const unsubAlerts = onSnapshot(
      alertsQuery,
      (snap) => {
        const wasInitial = !collectionSnapLoaded;
        collectionSnapLoaded = true;
        collectionAlertDocs = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
        evaluateActiveAlert(wasInitial);
      },
      (err) => {
        collectionSnapLoaded = true;
        console.warn("Security alerts overlay listener error bypassed", err);
      }
    );

    const handleWakeOrOnline = () => {
      if (document.visibilityState === "visible" || navigator.onLine) {
        evaluateActiveAlert(false);
      }
    };
    document.addEventListener("visibilitychange", handleWakeOrOnline);
    window.addEventListener("online", handleWakeOrOnline);
    window.addEventListener("focus", handleWakeOrOnline);
    window.addEventListener("appResumed", handleWakeOrOnline);

    return () => {
      unsubGlobal();
      unsubAlerts();
      document.removeEventListener("visibilitychange", handleWakeOrOnline);
      window.removeEventListener("online", handleWakeOrOnline);
      window.removeEventListener("focus", handleWakeOrOnline);
      window.removeEventListener("appResumed", handleWakeOrOnline);
    };
  }, [user?.uid, isRealAdmin]);

  // Background Service Worker + Unthrottled Web Worker Notification Bridge
  useEffect(() => {
    ensureNotificationChannel().catch(() => {});
    if (!user) {
      if ("serviceWorker" in navigator) {
        navigator.serviceWorker
          .getRegistration()
          .then((reg) => {
            const targetSW = reg?.active || reg?.waiting || navigator.serviceWorker.controller;
            targetSW?.postMessage({ type: "CLEAR_NOTIFICATION_CONTEXT" });
          })
          .catch(() => {});
      }
      return;
    }

    let bgWorker: Worker | null = null;
    let workerUrl: string | null = null;

    const syncContextToServiceWorker = async () => {
      if (!("serviceWorker" in navigator)) return;
      try {
        const reg = await navigator.serviceWorker.getRegistration();
        const targetSW = reg?.active || reg?.waiting || navigator.serviceWorker.controller;
        if (!targetSW) return;

        let idToken = "";
        try {
          if (typeof (user as any).getIdToken === "function") {
            idToken = await (user as any).getIdToken();
          }
        } catch {}

        const storageKey = `notifications_${user.uid}`;
        const notificationsEnabled = localStorage.getItem(storageKey) !== "false";
        const notifiedSecurityIds = (() => {
          try {
            return JSON.parse(localStorage.getItem(getNotifiedSecurityIdsKey(user.uid)) || "[]");
          } catch {
            return [];
          }
        })();
        const localTriggeredSecurityIds = (() => {
          try {
            return JSON.parse(localStorage.getItem("local_triggered_security_alerts_v1") || "[]");
          } catch {
            return [];
          }
        })();
        const notifiedStockIds = (() => {
          try {
            return JSON.parse(localStorage.getItem(`notified_stock_events_v2_${user.uid}`) || "[]");
          } catch {
            return [];
          }
        })();

        targetSW.postMessage({
          type: "SET_NOTIFICATION_CONTEXT",
          payload: {
            projectId: appletConfig.projectId || "",
            databaseId: appletConfig.firestoreDatabaseId || "(default)",
            apiKey: appletConfig.apiKey || "",
            userUid: user.uid,
            userEmail: user.email || "",
            deviceId: getDeviceId(),
            isAdmin: Boolean(isAdmin),
            isRealAdmin: Boolean(isRealAdmin),
            idToken,
            notificationsEnabled,
            lastBroadcastNotifiedTime: parseInt(
              localStorage.getItem(getNotifiedBroadcastKey(user.uid)) || "0",
              10
            ),
            notifiedSecurityIds,
            localTriggeredSecurityIds,
            notifiedStockIds,
          },
        });
      } catch {}
    };

    const pollBackgroundAlertsNative = async () => {
      if (!user) return;
      const uid = user.uid;
      const storageKey = `notifications_${uid}`;
      if (localStorage.getItem(storageKey) === "false") return;
      const cutoff = Date.now() - 86400000;

      // 1. Poll Admin Broadcast
      try {
        const bSnap = await getDoc(doc(db, "settings", "admin_broadcast_notification"));
        if (bSnap.exists()) {
          const data = bSnap.data();
          const ts = Number(data?.timestamp) || 0;
          const target = data?.targetAudience || "all";
          const userIsAdmin = Boolean(isRealAdmin || isAdmin);
          const roleMatches =
            target === "all" ||
            (target === "admins" && userIsAdmin) ||
            (target === "users" && !userIsAdmin);
          const acked =
            Array.isArray(data?.acknowledgedBy) && data.acknowledgedBy.includes(uid);
          const dismissedTs = parseInt(
            localStorage.getItem(getDismissedBroadcastKey(uid)) || "0",
            10
          );
          const lastNotified = Math.max(
            parseInt(localStorage.getItem(getNotifiedBroadcastKey(uid)) || "0", 10),
            lastBroadcastNotifiedRef.current
          );

          if (
            ts > cutoff &&
            data?.senderUid !== uid &&
            roleMatches &&
            !acked &&
            ts > dismissedTs &&
            ts > lastNotified
          ) {
            lastBroadcastNotifiedRef.current = ts;
            localStorage.setItem(getNotifiedBroadcastKey(uid), ts.toString());
            setBroadcastNotification(data);
            if (ts >= appMountTimeRef.current - 60000) {
              showLocalNotification(
                `🔔 ${data.title || "Admin Announcement"}`,
                data.message || "",
                "/pwa-192x192.png",
                `admin_broadcast_${ts}`
              );
            }
          }
        }
      } catch {}
    };

    syncContextToServiceWorker();
    pollBackgroundAlertsNative().catch(() => {});

    // Register periodic background sync if supported by browser/PWA
    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.ready
        .then((reg: any) => {
          if (reg && reg.periodicSync && typeof reg.periodicSync.register === "function") {
            reg.periodicSync
              .register("buzz-pos-bg-notifications", { minInterval: 60 * 1000 })
              .catch(() => {});
          }
        })
        .catch(() => {});
    }

    // Create an unthrottled Web Worker timer that triggers native & Service Worker background checks while app is minimized/hidden
    try {
      const workerCode = `
        setInterval(() => {
          self.postMessage('TICK');
        }, 3000);
      `;
      const blob = new Blob([workerCode], { type: "application/javascript" });
      workerUrl = URL.createObjectURL(blob);
      bgWorker = new Worker(workerUrl);
      bgWorker.onmessage = () => {
        if (document.visibilityState === "hidden" || Capacitor.isNativePlatform()) {
          pollBackgroundAlertsNative().catch(() => {});
        }
        syncContextToServiceWorker().then(() => {
          if (document.visibilityState === "hidden" && "serviceWorker" in navigator) {
            navigator.serviceWorker.getRegistration().then((reg) => {
              const targetSW = reg?.active || navigator.serviceWorker.controller;
              targetSW?.postMessage({ type: "CHECK_NOTIFICATIONS_NOW" });
            }).catch(() => {});
          }
        });
      };
    } catch {}

    const handleVisChange = () => {
      syncContextToServiceWorker();
      if (document.visibilityState === "visible") {
        pollBackgroundAlertsNative().catch(() => {});
      }
    };
    document.addEventListener("visibilitychange", handleVisChange);

    return () => {
      document.removeEventListener("visibilitychange", handleVisChange);
      if (bgWorker) {
        bgWorker.terminate();
      }
      if (workerUrl) {
        URL.revokeObjectURL(workerUrl);
      }
    };
  }, [user?.uid, isAdmin, isRealAdmin]);

  useEffect(() => {
    const getStorageKey = (key: string) => (user ? `${key}_${user.uid}` : key);
    let wakeLockSentinel: any = null;

    const updateWakeLock = async () => {
      try {
        const shouldKeepOn =
          localStorage.getItem(getStorageKey("keepScreenOn")) === "true";
        if (shouldKeepOn) {
          // Native Capacitor keep-awake
          try {
            await KeepAwake.keepAwake();
          } catch (nativeErr) {
            console.debug("Native KeepAwake failed:", nativeErr);
          }

          // Web Wake Lock fallback
          if ("wakeLock" in navigator) {
            try {
              if (!wakeLockSentinel) {
                wakeLockSentinel = await navigator.wakeLock.request("screen");
              }
            } catch (webErr: any) {
              const msg = String(webErr?.message || webErr);
              if (!msg.includes("permissions policy") && !msg.includes("disallowed")) {
                console.warn("Web WakeLock request failed:", webErr);
              } else {
                console.debug("Web WakeLock request failed (expected in sandbox):", webErr);
              }
            }
          }
        } else {
          // Native release
          try {
            await KeepAwake.allowSleep();
          } catch (nativeErr) {
            console.debug("Native allowSleep failed:", nativeErr);
          }

          // Web release
          if (wakeLockSentinel) {
            try {
              await wakeLockSentinel.release();
              wakeLockSentinel = null;
            } catch (webErr) {
              console.debug("Web WakeLock release failed:", webErr);
            }
          }
        }
      } catch (e) {
        console.debug("Update wake lock error:", e);
      }
    };

    const handleVisibilityChange = async () => {
      const shouldKeepOn =
        localStorage.getItem(getStorageKey("keepScreenOn")) === "true";
      if (shouldKeepOn && document.visibilityState === "visible") {
        if ("wakeLock" in navigator && !wakeLockSentinel) {
          try {
            wakeLockSentinel = await navigator.wakeLock.request("screen");
          } catch (err: any) {
            const msg = String(err?.message || err);
            if (!msg.includes("permissions policy") && !msg.includes("disallowed")) {
              console.warn("Re-requesting web WakeLock failed:", err);
            } else {
              console.debug("Re-requesting web WakeLock failed (expected in sandbox):", err);
            }
          }
        }
      }
    };

    updateWakeLock();
    window.addEventListener("keepScreenOnChanged", updateWakeLock);
    document.addEventListener("visibilitychange", handleVisibilityChange);

    // Request notification permission initially
    const requestPermissions = async () => {
      try {
        if (Capacitor.isNativePlatform()) {
          const { display } = await LocalNotifications.checkPermissions();
          if (display !== "granted") {
            await LocalNotifications.requestPermissions();
          }
        } else if (
          "Notification" in window &&
          Notification.permission === "default"
        ) {
          await Notification.requestPermission();
        }
      } catch (e) {
        console.warn("Initial notification permission request failed:", e);
      }
    };
    requestPermissions();

    return () => {
      KeepAwake.allowSleep().catch(() => {});
      if (wakeLockSentinel) {
        wakeLockSentinel.release().catch(() => {});
      }
      window.removeEventListener("keepScreenOnChanged", updateWakeLock);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [user]);

  const navigate = useNavigate();
  const { products, allProducts, loading: productsLoading } = useGlobalProducts();
  const { loading: billsLoading } = useGlobalBills();
  const [maxSplashReached, setMaxSplashReached] = useState(false);
  const [imagesPreloaded, setImagesPreloaded] = useState(false);
  const [overdueUnsetBuyCostProducts, setOverdueUnsetBuyCostProducts] = useState<Product[]>([]);
  const [buyCostReminderDismissedToday, setBuyCostReminderDismissedToday] = useState(false);

  // Daily Admin Notification & Reminder for products without a Buy Cost after 24 hours (1 day)
  useEffect(() => {
    if (!user || productsLoading) return;

    const evaluateUnsetBuyCostReminders = () => {
      // Only permanent Real Administrators should ever receive Buy Cost notifications or reminder modals
      const hasAdminAccess = Boolean(isRealAdmin);

      if (!hasAdminAccess) {
        setOverdueUnsetBuyCostProducts([]);
        return;
      }

      const deletedIds = getDeletedProductIds();
      const deletedNames = getDeletedProductNames();
      const rawCatalogList = allProducts && allProducts.length > 0 ? allProducts : products;
      const catalogList = (rawCatalogList || []).filter(
        (p) =>
          p &&
          p.id &&
          !deletedIds.has(String(p.id)) &&
          !deletedNames.has(String(p.name || "").toLowerCase().trim())
      );
      if (catalogList.length === 0) {
        setOverdueUnsetBuyCostProducts([]);
        return;
      }

      const now = Date.now();
      const ONE_DAY_MS = 24 * 60 * 60 * 1000;
      const firstSeenStorageKey = "unset_buy_cost_first_seen_v1";
      let firstSeenMap: Record<string, number> = {};
      try {
        const raw = localStorage.getItem(firstSeenStorageKey);
        if (raw) {
          const parsed = JSON.parse(raw);
          if (parsed && typeof parsed === "object") {
            firstSeenMap = parsed;
          }
        }
      } catch {}

      let firstSeenModified = false;
      const overdueList: Product[] = [];

      for (const p of catalogList) {
        if (!p || !p.id) continue;
        const effectiveCost = getEffectiveProductCost(p);
        if (effectiveCost > 0) {
          if (firstSeenMap[p.id]) {
            delete firstSeenMap[p.id];
            firstSeenModified = true;
          }
          continue;
        }

        let createdTime = Number(p.createdAt) || 0;
        if (createdTime <= 0) {
          if (firstSeenMap[p.id] && firstSeenMap[p.id] > 0) {
            createdTime = firstSeenMap[p.id];
          } else {
            createdTime = now;
            firstSeenMap[p.id] = createdTime;
            firstSeenModified = true;
          }
        }

        if (now - createdTime >= ONE_DAY_MS) {
          overdueList.push(p);
        }
      }

      if (firstSeenModified) {
        try {
          localStorage.setItem(firstSeenStorageKey, JSON.stringify(firstSeenMap));
        } catch {}
      }

      setOverdueUnsetBuyCostProducts(overdueList);

      const todayKey = getAppBusinessIsoDate(now);
      const modalDismissKey = `unset_buy_cost_modal_dismissed_${user.uid}_${todayKey}`;
      setBuyCostReminderDismissedToday(localStorage.getItem(modalDismissKey) === "true");

      if (overdueList.length === 0) return;

      const dailyNotifiedKey = `unset_buy_cost_notified_${user.uid}_${todayKey}`;
      let notifiedTodayIds: string[] = [];
      try {
        const raw = localStorage.getItem(dailyNotifiedKey);
        if (raw) {
          const parsed = JSON.parse(raw);
          if (Array.isArray(parsed)) notifiedTodayIds = parsed;
        }
      } catch {}

      const notifiedSet = new Set(notifiedTodayIds);
      const unnotifiedOverdue = overdueList.filter((p) => !notifiedSet.has(p.id));

      if (unnotifiedOverdue.length > 0) {
        unnotifiedOverdue.forEach((p) => notifiedSet.add(p.id));
        try {
          localStorage.setItem(dailyNotifiedKey, JSON.stringify(Array.from(notifiedSet)));
        } catch {}

        const storageKey = `notifications_${user.uid}`;
        const notificationsEnabled = localStorage.getItem(storageKey) !== "false";
        if (notificationsEnabled) {
          const sampleNames = overdueList
            .slice(0, 3)
            .map((p) => p.name)
            .join(", ");
          const moreCount = overdueList.length - 3;
          const title =
            overdueList.length === 1
              ? "💰 Buy Cost Pending (Over 1 Day)"
              : `💰 ${overdueList.length} Products Missing Buy Cost`;
          const body =
            overdueList.length === 1
              ? `"${overdueList[0].name}" has no buy cost set for over 24 hours. Set its buy price in Admin so past & future bills calculate profit.`
              : `${sampleNames}${moreCount > 0 ? ` +${moreCount} more` : ""} still need a buy cost set. Tap to update in Admin → Buy Prices.`;

          showLocalNotification(
            title,
            body,
            "/pwa-192x192.png",
            `unset_buy_cost_${todayKey}`
          );
        }
      }
    };

    evaluateUnsetBuyCostReminders();
    const interval = setInterval(evaluateUnsetBuyCostReminders, 60 * 1000);
    window.addEventListener("adminProductBuyPricesUpdated", evaluateUnsetBuyCostReminders);
    window.addEventListener("adminAuthChanged", evaluateUnsetBuyCostReminders);
    document.addEventListener("visibilitychange", evaluateUnsetBuyCostReminders);

    return () => {
      clearInterval(interval);
      window.removeEventListener("adminProductBuyPricesUpdated", evaluateUnsetBuyCostReminders);
      window.removeEventListener("adminAuthChanged", evaluateUnsetBuyCostReminders);
      document.removeEventListener("visibilitychange", evaluateUnsetBuyCostReminders);
    };
  }, [user, isAdmin, isRealAdmin, products, allProducts, productsLoading]);

  const handleDismissBuyCostReminderToday = () => {
    if (!user) return;
    const todayKey = getAppBusinessIsoDate();
    const modalDismissKey = `unset_buy_cost_modal_dismissed_${user.uid}_${todayKey}`;
    try {
      localStorage.setItem(modalDismissKey, "true");
    } catch {}
    setBuyCostReminderDismissedToday(true);
  };

  const handleOpenAdminBuyCostSetup = () => {
    handleDismissBuyCostReminderToday();
    navigate("/admin?view=costs&filter=unset");
    setTimeout(() => {
      window.dispatchEvent(new Event("openAdminBuyCosts"));
    }, 60);
  };

  // Safety max timeout so offline startup never holds the native splash screen indefinitely
  useEffect(() => {
    const maxTimer = setTimeout(() => setMaxSplashReached(true), 2000);
    return () => {
      clearTimeout(maxTimer);
    };
  }, []);

  // Preload and decode product images while the real native splash screen is active
  useEffect(() => {
    if (productsLoading) return;
    if (!products || products.length === 0) {
      setImagesPreloaded(true);
      return;
    }

    let cancelled = false;
    const urls = products
      .slice(0, 24)
      .map((p) => getImageUrl(p.image))
      .filter((u): u is string => Boolean(u));

    if (urls.length === 0) {
      setImagesPreloaded(true);
      return;
    }

    const preloadPromises = urls.map(
      (url) =>
        new Promise<void>((resolve) => {
          const img = new Image();
          img.onload = () => {
            if (typeof img.decode === "function") {
              img.decode().catch(() => {}).finally(() => resolve());
            } else {
              resolve();
            }
          };
          img.onerror = () => resolve();
          img.src = url;
        })
    );

    const safetyTimer = setTimeout(() => {
      if (!cancelled) setImagesPreloaded(true);
    }, 800);

    Promise.all(preloadPromises).finally(() => {
      clearTimeout(safetyTimer);
      if (!cancelled) setImagesPreloaded(true);
    });

    return () => {
      cancelled = true;
      clearTimeout(safetyTimer);
    };
  }, [productsLoading, products]);

  const allAssetsReady =
    !loading &&
    (!user || (!productsLoading && !billsLoading && imagesPreloaded));

  // Hide the real native Capacitor splash screen ONLY once products, bills, and images are fully loaded (or safety timeout reached)
  useEffect(() => {
    if (!allAssetsReady && !maxSplashReached) return;
    if (Capacitor.isNativePlatform()) {
      SplashScreen.hide({ fadeOutDuration: 180 }).catch(() => {});
    }
  }, [allAssetsReady, maxSplashReached]);

  return (
    <>
      {!loading && !user ? (
        <div className="flex-1 overflow-y-auto relative z-10 w-full min-h-0">
          <Login />
        </div>
      ) : user ? (
        <>
          {/* Refined Offline & Queue Sync Status Pill */}
          <AnimatePresence mode="wait">
            {!isOnline ? (
              <motion.div
                key="offline-status-banner"
                initial={{ opacity: 0, y: -24, scale: 0.96 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0, y: -20, scale: 0.96 }}
                transition={{ duration: 0.24, ease: [0.16, 1, 0.3, 1] }}
                className="fixed left-1/2 -translate-x-1/2 z-[75] pointer-events-none select-none"
                style={{ top: "calc(0.55rem + env(safe-area-inset-top))" }}
              >
                <div className="flex items-center gap-2.5 pl-2 pr-3.5 py-1.5 bg-slate-900/95 dark:bg-[#0d1324]/95 text-slate-100 rounded-2xl text-xs font-bold tracking-tight shadow-2xl shadow-black/30 backdrop-blur-xl border border-amber-500/35">
                  <div className="w-6 h-6 rounded-xl bg-amber-500/15 border border-amber-500/30 text-amber-400 flex items-center justify-center shrink-0">
                    <WifiOff size={13} />
                  </div>
                  <div className="flex items-center gap-1.5 whitespace-nowrap">
                    <span className="text-white font-extrabold text-[11.5px]">Offline</span>
                    <span className="text-slate-500">·</span>
                    <span className="text-amber-300/95 font-semibold text-[11px] font-mono tabular-nums">
                      {offlineQueueCount > 0
                        ? `${offlineQueueCount} ${offlineQueueCount === 1 ? "bill" : "bills"} queued`
                        : "Local queue ready"}
                    </span>
                  </div>
                </div>
              </motion.div>
            ) : isSyncingOffline && offlineQueueCount > 0 ? (
              <motion.div
                key="syncing-status-banner"
                initial={{ opacity: 0, y: -24, scale: 0.96 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0, y: -20, scale: 0.96 }}
                transition={{ duration: 0.24, ease: [0.16, 1, 0.3, 1] }}
                className="fixed left-1/2 -translate-x-1/2 z-[75] pointer-events-none select-none"
                style={{ top: "calc(0.55rem + env(safe-area-inset-top))" }}
              >
                <div className="flex items-center gap-2.5 pl-2 pr-3.5 py-1.5 bg-slate-900/95 dark:bg-[#0d1324]/95 text-slate-100 rounded-2xl text-xs font-bold tracking-tight shadow-2xl shadow-black/30 backdrop-blur-xl border border-indigo-500/35">
                  <div className="w-6 h-6 rounded-xl bg-indigo-500/15 border border-indigo-500/30 text-indigo-400 flex items-center justify-center shrink-0">
                    <RefreshCw size={13} className="animate-spin" />
                  </div>
                  <span className="text-indigo-200 font-semibold text-[11px] whitespace-nowrap">
                    Validating {offlineQueueCount} offline {offlineQueueCount === 1 ? "bill" : "bills"}...
                  </span>
                </div>
              </motion.div>
            ) : null}
          </AnimatePresence>

          <div
            id="app-scroll-container"
            className="flex-1 overflow-y-auto overflow-x-hidden relative z-10 w-full min-h-0"
            style={{
              paddingTop: "env(safe-area-inset-top)",
              paddingBottom: "calc(5.5rem + env(safe-area-inset-bottom))",
            }}
          >
            <AnimatedRoutes />
          </div>
          <BottomNav />
        </>
      ) : null}

      {/* Global Security Warning Modal Overlay */}
      <AnimatePresence>
        {securityMessage &&
          securityMessage.timestamp > dismissedMessageTime && (
            <div className="fixed inset-0 z-[999] flex items-center justify-center p-4">
              <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                onClick={() => handleDismissSecurityMessage(securityMessage)}
                className="absolute inset-0 bg-slate-950/70 backdrop-blur-md"
              />
              <motion.div
                initial={{ scale: 0.9, opacity: 0 }}
                animate={{ scale: 1, opacity: 1 }}
                exit={{ scale: 0.9, opacity: 0 }}
                className="bg-white/95 dark:bg-slate-900/95 backdrop-blur-xl border-2 border-red-500/80 w-full max-w-sm rounded-[2.5rem] p-6 relative z-10 shadow-2xl text-center"
              >
                <div className="w-16 h-16 bg-red-500/10 dark:bg-red-500/20 rounded-2xl flex items-center justify-center text-red-500 mx-auto mb-3 border border-red-500/20">
                  <AlertOctagon size={32} />
                </div>
                <div className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-red-500/15 dark:bg-red-500/25 border border-red-500/30 text-red-600 dark:text-red-300 text-[11px] font-black uppercase tracking-wider mb-2">
                  <span>
                    🔓 Broke Into Admin Panel:{" "}
                    {Math.max(1, Number(securityMessage.breachCount) || 1)}{" "}
                    {Math.max(1, Number(securityMessage.breachCount) || 1) === 1
                      ? "Time"
                      : "Times"}
                  </span>
                </div>
                <h3 className="text-xl font-black text-slate-950 dark:text-white mb-2">
                  🚨 Security Alert
                </h3>
                <p className="text-sm text-red-600 dark:text-red-400 font-bold mb-4 leading-relaxed bg-red-500/5 dark:bg-red-500/5 p-4 rounded-2xl border border-red-500/10">
                  {securityMessage.message}
                </p>
                <p className="text-[10px] text-slate-400 dark:text-slate-500 mb-6 font-bold uppercase tracking-widest">
                  Latest Timestamp:{" "}
                  {formatDateToDMY(securityMessage.timestamp)} -{" "}
                  {new Date(securityMessage.timestamp).toLocaleTimeString()}
                </p>
                <button
                  onClick={() => handleDismissSecurityMessage(securityMessage)}
                  className="w-full py-3.5 bg-red-600 hover:bg-red-700 active:scale-95 text-white font-black rounded-2xl text-xs shadow-lg shadow-red-600/20 transition-all outline-none cursor-pointer"
                >
                  Acknowledge Alert
                </button>
              </motion.div>
            </div>
          )}
      </AnimatePresence>

      {/* Admin Broadcast Notification Modal Overlay */}
      <AnimatePresence>
        {broadcastNotification &&
          broadcastNotification.timestamp > dismissedBroadcastTime && (
            <div className="fixed inset-0 z-[998] flex items-center justify-center p-4">
              <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                onClick={() => handleDismissBroadcastNotification(broadcastNotification)}
                className="absolute inset-0 bg-slate-950/70 backdrop-blur-md"
              />
              <motion.div
                initial={{ scale: 0.9, opacity: 0, y: 12 }}
                animate={{ scale: 1, opacity: 1, y: 0 }}
                exit={{ scale: 0.9, opacity: 0, y: 12 }}
                className="bg-white/95 dark:bg-slate-900/95 backdrop-blur-xl border-2 border-violet-500/75 w-full max-w-sm rounded-[2.5rem] p-6 relative z-10 shadow-2xl text-center"
              >
                <div className="w-16 h-16 bg-violet-500/10 dark:bg-violet-500/20 rounded-2xl flex items-center justify-center text-violet-600 dark:text-violet-400 mx-auto mb-3 border border-violet-500/20">
                  <Bell size={30} />
                </div>
                <div className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full bg-violet-500/10 text-violet-600 dark:text-violet-300 text-[10px] font-black uppercase tracking-wider mb-2">
                  <span>
                    {broadcastNotification.targetAudience === "admins"
                      ? "Admins Only"
                      : broadcastNotification.targetAudience === "users"
                      ? "User Notice"
                      : "Broadcast to All"}
                  </span>
                </div>
                <h3 className="text-xl font-black text-slate-950 dark:text-white mb-2">
                  {broadcastNotification.title || "Admin Announcement"}
                </h3>
                <p className="text-sm text-slate-700 dark:text-slate-200 font-semibold mb-4 leading-relaxed bg-violet-500/5 dark:bg-violet-500/10 p-4 rounded-2xl border border-violet-500/15 whitespace-pre-wrap">
                  {broadcastNotification.message}
                </p>
                <p className="text-[10px] text-slate-400 dark:text-slate-500 mb-5 font-bold uppercase tracking-widest">
                  From {broadcastNotification.senderName || "Admin"} •{" "}
                  {formatDateToDMY(broadcastNotification.timestamp)}{" "}
                  {new Date(broadcastNotification.timestamp).toLocaleTimeString([], {
                    hour: "2-digit",
                    minute: "2-digit",
                  })}
                </p>
                <button
                  onClick={() => handleDismissBroadcastNotification(broadcastNotification)}
                  className="w-full py-3.5 bg-violet-600 hover:bg-violet-700 active:scale-95 text-white font-black rounded-2xl text-xs shadow-lg shadow-violet-600/20 transition-all outline-none cursor-pointer"
                >
                  Got It
                </button>
              </motion.div>
            </div>
          )}
      </AnimatePresence>

      {/* Offline Bill Sync Conflict Error Modal (shown when an offline bill fails validation upon reconnecting) */}
      <AnimatePresence>
        {offlineConflictAlerts.length > 0 && (
          <div className="fixed inset-0 z-[999] flex items-center justify-center p-4">
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => setOfflineConflictAlerts((prev) => prev.slice(1))}
              className="absolute inset-0 bg-slate-950/75 backdrop-blur-md"
            />
            {(() => {
              const activeConflict = offlineConflictAlerts[0];
              return (
                <motion.div
                  key={activeConflict.id}
                  initial={{ scale: 0.94, opacity: 0, y: 12 }}
                  animate={{ scale: 1, opacity: 1, y: 0 }}
                  exit={{ scale: 0.94, opacity: 0, y: 12 }}
                  transition={{ type: "spring", stiffness: 400, damping: 28, mass: 0.7 }}
                  className="bg-white dark:bg-[#0c1222] border border-rose-500/40 w-full max-w-sm rounded-[28px] p-5 relative z-10 shadow-2xl"
                >
                  <div className="flex items-center justify-between gap-3 mb-3.5">
                    <div className="flex items-center gap-3 min-w-0">
                      <div className="w-11 h-11 bg-rose-500/15 border border-rose-500/25 rounded-2xl flex items-center justify-center text-rose-500 shrink-0">
                        <AlertTriangle size={22} />
                      </div>
                      <div className="min-w-0">
                        <h3 className="text-base font-extrabold text-slate-900 dark:text-white tracking-tight leading-tight">
                          Offline Bill Conflict
                        </h3>
                        <p className="text-xs text-rose-600 dark:text-rose-400 font-semibold mt-0.5">
                          Bill #{activeConflict.billId.slice(-5)} · ₹{formatPrice(activeConflict.total)}
                        </p>
                      </div>
                    </div>
                    {offlineConflictAlerts.length > 1 && (
                      <span className="px-2.5 py-1 rounded-full bg-rose-500/15 text-rose-600 dark:text-rose-300 border border-rose-500/25 text-[10px] font-extrabold uppercase tracking-wider shrink-0">
                        {offlineConflictAlerts.length} bills
                      </span>
                    )}
                  </div>

                  <p className="text-xs text-slate-600 dark:text-slate-300 leading-relaxed mb-3.5">
                    This bill was created while you were offline, but an online user already billed the remaining stock before your device reconnected.
                  </p>

                  <div className="rounded-2xl bg-rose-500/5 dark:bg-rose-500/10 border border-rose-500/20 p-3 space-y-2 mb-4">
                    <div className="text-[10.5px] font-bold uppercase tracking-wider text-rose-600 dark:text-rose-300">
                      Out-of-Stock Discrepancies
                    </div>
                    {(activeConflict.conflictingItems || activeConflict.conflicts || []).map((item, idx) => (
                      <div
                        key={`${item.productId}_${idx}`}
                        className="flex items-center justify-between gap-2 text-xs border-t border-rose-500/15 pt-1.5 first:border-t-0 first:pt-0"
                      >
                        <span className="font-bold text-slate-800 dark:text-slate-100 truncate">
                          {item.name || item.productName}
                        </span>
                        <span className="font-mono text-[11px] text-rose-600 dark:text-rose-300 font-bold shrink-0">
                          Billed {item.requestedQty} · {item.availableStock} left
                        </span>
                      </div>
                    ))}
                  </div>

                  <p className="text-[11px] text-slate-500 dark:text-slate-400 leading-snug mb-4">
                    If stock has been replenished, tap <span className="font-bold text-slate-700 dark:text-slate-200">Retry All</span> to re-submit all queued and conflicted bills.
                  </p>

                  <div className="grid grid-cols-2 gap-2.5">
                    <button
                      type="button"
                      disabled={isRetryingConflicts}
                      onClick={() => setOfflineConflictAlerts((prev) => prev.slice(1))}
                      className="h-11 bg-slate-100 hover:bg-slate-200 dark:bg-slate-800/90 dark:hover:bg-slate-700 active:scale-95 text-slate-700 dark:text-slate-200 font-bold rounded-xl text-xs border border-slate-200/80 dark:border-slate-700/70 transition-all cursor-pointer disabled:opacity-50"
                    >
                      Understood
                    </button>
                    <button
                      type="button"
                      disabled={isRetryingConflicts}
                      onClick={handleRetryAllOfflineBills}
                      className="h-11 bg-indigo-600 hover:bg-indigo-500 active:scale-95 text-white font-bold rounded-xl text-xs shadow-md shadow-indigo-600/25 transition-all flex items-center justify-center gap-1.5 cursor-pointer disabled:opacity-60"
                    >
                      <RefreshCw
                        size={14}
                        className={isRetryingConflicts ? "animate-spin" : ""}
                      />
                      <span>{isRetryingConflicts ? "Retrying..." : "Retry All"}</span>
                    </button>
                  </div>
                </motion.div>
              );
            })()}
          </div>
        )}
      </AnimatePresence>

      {/* Daily Admin Reminder Modal for Products Missing Buy Cost (>24h) */}
      <AnimatePresence>
        {overdueUnsetBuyCostProducts.length > 0 && !buyCostReminderDismissedToday && (
          <div className="fixed inset-0 z-[997] flex items-center justify-center p-4">
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={handleDismissBuyCostReminderToday}
              className="absolute inset-0 bg-slate-950/70 backdrop-blur-md"
            />
            <motion.div
              initial={{ scale: 0.92, opacity: 0, y: 12 }}
              animate={{ scale: 1, opacity: 1, y: 0 }}
              exit={{ scale: 0.92, opacity: 0, y: 12 }}
              transition={{ type: "spring", stiffness: 380, damping: 28, mass: 0.7 }}
              className="bg-white dark:bg-[#0c1222] border border-amber-500/40 w-full max-w-sm rounded-[28px] p-5 relative z-10 shadow-2xl"
            >
              <div className="flex items-center gap-3 mb-3.5">
                <div className="w-11 h-11 bg-amber-500/15 border border-amber-500/30 rounded-2xl flex items-center justify-center text-amber-500 shrink-0">
                  <IndianRupee size={22} />
                </div>
                <div className="min-w-0">
                  <span className="inline-block px-2 py-0.5 rounded-md bg-amber-500/15 text-amber-600 dark:text-amber-300 text-[10px] font-extrabold uppercase tracking-wider mb-0.5">
                    Daily Admin Reminder
                  </span>
                  <h3 className="text-base font-extrabold text-slate-900 dark:text-white tracking-tight leading-tight">
                    {overdueUnsetBuyCostProducts.length === 1
                      ? "1 Product Needs Buy Cost"
                      : `${overdueUnsetBuyCostProducts.length} Products Need Buy Cost`}
                  </h3>
                </div>
              </div>

              <p className="text-xs text-slate-600 dark:text-slate-300 leading-relaxed mb-3.5">
                These products were added over 24 hours ago without a buy cost. Once you set their buy price, all previous and future bills with these items will automatically calculate profit.
              </p>

              <div className="rounded-2xl bg-amber-500/5 dark:bg-amber-500/10 border border-amber-500/20 p-3 space-y-1.5 mb-4 max-h-40 overflow-y-auto overscroll-contain">
                {overdueUnsetBuyCostProducts.slice(0, 6).map((item) => (
                  <div
                    key={item.id}
                    className="flex items-center justify-between gap-2 text-xs border-t border-amber-500/15 pt-1.5 first:border-t-0 first:pt-0"
                  >
                    <span className="font-bold text-slate-800 dark:text-slate-100 truncate">
                      {item.name}
                    </span>
                    <span className="font-mono text-[11px] text-amber-600 dark:text-amber-300 font-bold shrink-0">
                      Sell ₹{formatPrice(item.price)} · No buy cost
                    </span>
                  </div>
                ))}
                {overdueUnsetBuyCostProducts.length > 6 && (
                  <div className="text-[11px] font-bold text-amber-600 dark:text-amber-400 pt-1 text-center">
                    +{overdueUnsetBuyCostProducts.length - 6} more products
                  </div>
                )}
              </div>

              <div className="grid grid-cols-2 gap-2.5">
                <button
                  type="button"
                  onClick={handleDismissBuyCostReminderToday}
                  className="h-11 bg-slate-100 hover:bg-slate-200 dark:bg-slate-800/90 dark:hover:bg-slate-700 active:scale-95 text-slate-700 dark:text-slate-200 font-bold rounded-xl text-xs border border-slate-200/80 dark:border-slate-700/70 transition-all cursor-pointer"
                >
                  Remind Tomorrow
                </button>
                <button
                  type="button"
                  onClick={handleOpenAdminBuyCostSetup}
                  className="h-11 bg-amber-500 hover:bg-amber-400 active:scale-95 text-slate-950 font-extrabold rounded-xl text-xs shadow-md shadow-amber-500/20 transition-all flex items-center justify-center gap-1.5 cursor-pointer"
                >
                  <IndianRupee size={14} strokeWidth={2.5} />
                  <span>Set Buy Prices</span>
                </button>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      {/* Double back button exit toast for Android wrapper */}
      <AnimatePresence>
        {showExitToast && (
          <div className="fixed bottom-28 left-1/2 -translate-x-1/2 z-[9999] pointer-events-none">
            <motion.div
              initial={{ opacity: 0, y: 15, scale: 0.95 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: 10, scale: 0.95 }}
              transition={{ duration: 0.2, ease: [0.16, 1, 0.3, 1] }}
              className="bg-slate-950/90 dark:bg-slate-900/95 text-white dark:text-slate-100 font-extrabold text-[11px] uppercase tracking-wider py-3 px-6 rounded-2xl shadow-2xl border border-slate-800/80 dark:border-slate-800 backdrop-blur-md flex items-center gap-2 whitespace-nowrap"
            >
              <span>Press back again to exit</span>
            </motion.div>
          </div>
        )}
      </AnimatePresence>
    </>
  );
}

import { ErrorBoundary } from "./components/ErrorBoundary";
import { enableNetwork, disableNetwork } from "firebase/firestore";

export default function App() {
  return (
    <ErrorBoundary>
      <AuthProvider>
        <ProductsProvider>
          <BillsProvider>
            <CartProvider>
              <BrowserRouter>
                <div
                  className="h-[100dvh] w-full overflow-hidden text-slate-800 dark:text-slate-100 bg-slate-50 dark:bg-[#0b0e17] selection:bg-indigo-500/30 selection:text-indigo-900 font-sans relative transition-colors duration-300 flex flex-col"
                >
                  <div className="absolute inset-0 overflow-hidden -z-10 pointer-events-none bg-slate-50 dark:bg-[#0b0e17]" />

                  <AppContent />
                </div>
              </BrowserRouter>
            </CartProvider>
          </BillsProvider>
        </ProductsProvider>
      </AuthProvider>
    </ErrorBoundary>
  );
}
