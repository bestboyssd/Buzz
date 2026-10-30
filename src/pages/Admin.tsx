import React, { useState, useEffect, useLayoutEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { motion, AnimatePresence } from "motion/react";
import { useNavigate } from "react-router-dom";
import {
  Shield,
  ShieldOff,
  Lock,
  BarChart3,
  Receipt,
  ArrowLeft,
  Delete,
  X,
  KeyRound,
  LogOut,
  Trash2,
  IndianRupee,
  AlertTriangle,
  User,
  Edit2,
  Search,
  RefreshCw,
  UserCheck,
  UserX,
  Ban,
  Unlock,
  Camera,
  Download,
  Database,
  Upload,
  Cloud,
  Sparkles,
  Zap,
  Copy,
  Check,
  Share2,
  ClipboardPaste,
  Bell,
  Send,
  Users,
  Package,
  Calendar,
  Plus,
  Clock,
  TrendingUp,
  FileText,
} from "lucide-react";
import { AdminAIAssistant } from "../components/AdminAIAssistant";
import appletConfig from "../../firebase-applet-config.json";
import { triggerHaptic } from "../lib/haptics";
import {
  useAdminPin,
  updateAdminPin,
  logActivity,
  SyncConflictRecord,
  resolveSyncConflictVoid,
  resolveSyncConflictForceApprove,
  updateProduct,
  CostBatch,
  getEffectiveProductCost,
  getUpcomingCostBatch,
  getProductFifoStatus,
  buildUpdatedCostStateForPriceChange,
  normalizeCostBatches,
  backfillPreviousUnsetBillsWithBuyPrice,
  Product,
} from "../lib/firestoreHooks";
import {
  formatPrice,
  MAX_BILL_AMOUNT,
  MAX_PRODUCT_STOCK,
  getDeviceId,
  markLocalSecurityAlertTriggered,
} from "../lib/utils";
import { useAuth } from "../lib/AuthContext";
import {
  useGlobalProducts,
  getDeletedProductIds,
  getDeletedProductNames,
  unmarkProductsDeletedLocal,
  purgeStockAlertsForDeletedProducts,
  saveLocalBuyPriceEntry,
  getLocalSavedBuyPricesMap,
  saveLocalCostBatchesEntry,
  getLocalSavedCostBatchesMap,
  normalizeAndDedupeProducts,
} from "../lib/ProductsContext";
import { useGlobalBills, normalizeAndDedupeBills } from "../lib/BillsContext";
import { sqliteClearProducts, sqliteClearBills } from "../lib/sqliteAdapter";
import { getImageUrl } from "../lib/imageUtils";
import { ProductImagePlaceholder } from "../components/ProductImagePlaceholder";
import { db, app } from "../lib/firebase";
import {
  doc,
  setDoc,
  getDoc,
  getDocFromServer,
  addDoc,
  collection,
  getDocs,
  getDocsFromServer,
  deleteDoc,
  onSnapshot,
  query,
  orderBy,
  limit,
  writeBatch,
} from "firebase/firestore";
import { compressProfileImage } from "../lib/imageUtils";
import { Capacitor } from "@capacitor/core";
import { Camera as CapCamera, CameraResultType, CameraSource } from "@capacitor/camera";

const formatDateToDMY = (timestamp: number | string | Date) => {
  const d = new Date(timestamp);
  if (isNaN(d.getTime())) return "";
  const day = String(d.getDate()).padStart(2, "0");
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const year = d.getFullYear();
  return `${day}/${month}/${year}`;
};

function M3CircularProgress({
  size = 20,
  strokeWidth = 3.8,
  className = "",
}: {
  size?: number;
  strokeWidth?: number;
  className?: string;
}) {
  return (
    <svg
      className={`m3-circular-spinner ${className}`}
      width={size}
      height={size}
      viewBox="0 0 50 50"
      aria-hidden="true"
    >
      <circle
        cx="25"
        cy="25"
        r="20"
        fill="none"
        stroke="currentColor"
        strokeWidth={strokeWidth}
      />
    </svg>
  );
}

function M3RefreshIndicator({
  active,
  label = "Syncing...",
}: {
  active: boolean;
  label?: string;
}) {
  return (
    <AnimatePresence>
      {active && (
        <motion.div
          initial={{ opacity: 0, height: 0, y: -8 }}
          animate={{ opacity: 1, height: "auto", y: 0 }}
          exit={{ opacity: 0, height: 0, y: -8 }}
          transition={{ type: "spring", stiffness: 420, damping: 30, mass: 0.7 }}
          className="overflow-hidden"
        >
          <div className="pb-3 flex flex-col items-center gap-2">
            {/* M3 Indeterminate Linear Progress Track */}
            <div className="w-full h-1 rounded-full bg-indigo-500/15 dark:bg-indigo-400/15 overflow-hidden relative text-indigo-600 dark:text-indigo-400">
              <div className="m3-linear-bar-1" />
              <div className="m3-linear-bar-2" />
            </div>
            {/* M3 Surface Container High Pull-to-Refresh Pill */}
            <div className="inline-flex items-center gap-2.5 pl-2.5 pr-4 py-1.5 rounded-full bg-[#f3edf7] dark:bg-[#222736] border border-indigo-500/20 dark:border-indigo-400/25 shadow-md shadow-indigo-500/10 text-indigo-600 dark:text-indigo-300">
              <div className="w-6 h-6 rounded-full bg-indigo-500/10 dark:bg-indigo-400/15 flex items-center justify-center">
                <M3CircularProgress size={15} strokeWidth={4.2} />
              </div>
              <span className="text-[11px] font-extrabold tracking-wide">
                {label}
              </span>
            </div>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

export function Admin() {
  const navigate = useNavigate();
  const {
    user,
    isAdmin,
    isRealAdmin,
    loading: authLoading,
    failedAttempts,
    lockedByAdmin,
    incrementFailedAttempts,
    resetFailedAttempts,
  } = useAuth();
  const { adminPin, loading: pinLoading } = useAdminPin();
  const {
    products: globalProducts,
    clearProductsOptimistic,
    updateProductOptimistic,
    restoreProductsOptimistic,
  } = useGlobalProducts();
  const { bills: globalBills, clearBillsOptimistic, restoreBillsOptimistic } = useGlobalBills();
  const [isAuthenticated, setIsAuthenticated] = useState(
    () => isRealAdmin || sessionStorage.getItem("adminAuth") === "true"
  );
  const [pin, setPin] = useState("");
  const pinRef = useRef("");
  const isUnlockingRef = useRef(false);
  const [error, setError] = useState(false);
  const [success, setSuccess] = useState(false);
  const [isChangingPin, setIsChangingPin] = useState(false);
  const [newPin, setNewPin] = useState("");
  const newPinRef = useRef("");
  const savePinTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [isPinSaved, setIsPinSaved] = useState(false);

  useEffect(() => {
    return () => {
      if (savePinTimerRef.current) {
        clearTimeout(savePinTimerRef.current);
      }
    };
  }, []);

  // Automatically bypass PIN login screen if the current account is a real admin
  useEffect(() => {
    if (isRealAdmin) {
      handleSetAuthenticated(true);
    }
  }, [isRealAdmin]);

  // Safety net: whenever all 4 dots turn green (success === true), guarantee transition to Admin Panel
  useEffect(() => {
    if (!success) return;
    const fallbackTimer = setTimeout(() => {
      handleSetAuthenticated(true);
      setSuccess(false);
      setPin("");
      pinRef.current = "";
      isUnlockingRef.current = false;
    }, 420);
    return () => clearTimeout(fallbackTimer);
  }, [success]);

  // User Accounts Management State
  const [isViewingAccounts, setIsViewingAccounts] = useState(false);

  // Activity Logs, Sync Conflicts, Product Buy Costs & Backup State
  const [isAIAssistantOpen, setIsAIAssistantOpen] = useState(false);
  const [isViewingActivityLogs, setIsViewingActivityLogs] = useState(false);
  const [isViewingSyncConflicts, setIsViewingSyncConflicts] = useState(false);
  const [isViewingProductCosts, setIsViewingProductCosts] = useState(() => {
    try {
      const params = new URLSearchParams(window.location.search);
      return params.get("view") === "costs";
    } catch {
      return false;
    }
  });
  const [costFilter, setCostFilter] = useState<"all" | "set" | "unset">(() => {
    try {
      const params = new URLSearchParams(window.location.search);
      return params.get("filter") === "unset" ? "unset" : "all";
    } catch {
      return "all";
    }
  });
  const [quickCostDrafts, setQuickCostDrafts] = useState<Record<string, string>>({});

  useEffect(() => {
    const handleOpenBuyCosts = () => {
      setIsViewingProductCosts(true);
      setCostFilter("unset");
    };
    window.addEventListener("openAdminBuyCosts", handleOpenBuyCosts);
    return () => window.removeEventListener("openAdminBuyCosts", handleOpenBuyCosts);
  }, []);
  const [savingCostProductId, setSavingCostProductId] = useState<string | null>(null);
  const [justSavedCostProductId, setJustSavedCostProductId] = useState<string | null>(null);
  const segDragRef = useRef<{ startX: number; dragged: boolean }>({ startX: 0, dragged: false });

  const [syncConflicts, setSyncConflicts] = useState<SyncConflictRecord[]>([]);
  const [syncConflictsLoading, setSyncConflictsLoading] = useState(false);
  const [isRefreshingConflicts, setIsRefreshingConflicts] = useState(false);
  const [refreshConflictsTrigger, setRefreshConflictsTrigger] = useState(0);
  const [conflictFilter, setConflictFilter] = useState<"all" | "unresolved" | "resolved">("all");
  const [resolvingConflictId, setResolvingConflictId] = useState<string | null>(null);
  const [showClearConflictsConfirm, setShowClearConflictsConfirm] = useState(false);
  const [clearingConflicts, setClearingConflicts] = useState(false);

  // Ensure sub-views (User Accounts, Activity Logs, Sync Conflicts, Product Costs, Reset PIN) mount at scrollTop = 0 before browser paint
  useLayoutEffect(() => {
    const scrollContainer = document.getElementById("app-scroll-container");
    if (scrollContainer) {
      scrollContainer.scrollTop = 0;
    }
    window.scrollTo(0, 0);
    document.documentElement.scrollTop = 0;
    document.body.scrollTop = 0;
  }, [
    isViewingAccounts,
    isViewingActivityLogs,
    isViewingSyncConflicts,
    isViewingProductCosts,
    isChangingPin,
    isAuthenticated,
  ]);
  const [activityLogs, setActivityLogs] = useState<any[]>([]);
  const [activityLogsLoading, setActivityLogsLoading] = useState(false);
  const [clearingLogs, setClearingLogs] = useState(false);
  const [showClearLogsConfirm, setShowClearLogsConfirm] = useState(false);
  const [refreshLogsTrigger, setRefreshLogsTrigger] = useState(0);
  const [showBackupModal, setShowBackupModal] = useState(false);

  const [accounts, setAccounts] = useState<any[]>([]);
  const [accountsLoading, setAccountsLoading] = useState(false);
  const [isRefreshingAccounts, setIsRefreshingAccounts] = useState(false);
  const [isRefreshingLogs, setIsRefreshingLogs] = useState(false);
  const [accountsPermissionError, setAccountsPermissionError] = useState(false);
  const [activityLogsPermissionError, setActivityLogsPermissionError] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [activityFilter, setActivityFilter] = useState<
    "all" | "stock_modification" | "failed_login" | "privilege_change" | "backup"
  >("all");
  const [editingAccount, setEditingAccount] = useState<any | null>(null);
  const [editName, setEditName] = useState("");
  const [editPhoto, setEditPhoto] = useState("");
  const [editEmail, setEditEmail] = useState("");
  const [editIsAdmin, setEditIsAdmin] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState("");
  const [accountToDelete, setAccountToDelete] = useState<any | null>(null);
  const [isDeletingAccount, setIsDeletingAccount] = useState(false);
  const deletedAccountTimestampsRef = useRef<Map<string, number>>(new Map());

  const buildUnifiedAccountsList = (docs: any[]) => {
    const profilesMap: Record<string, any> = {};
    const attemptsMap: Record<string, { failedCount: number; lockedByAdmin: boolean }> = {};
    const blockedUidsSet = new Set<string>();
    const blockedEmailsSet = new Set<string>();
    const deletedUidsMap: Record<string, number> = {};
    const deletedEmailsMap: Record<string, number> = {};

    // First pass: collect blocked_accounts and deleted_accounts registries
    docs.forEach((docSnap) => {
      const id = docSnap.id;
      const data = typeof docSnap.data === "function" ? docSnap.data() : docSnap;
      if (id === "blocked_accounts") {
        if (Array.isArray(data?.blockedUids)) {
          data.blockedUids.forEach((u: any) => {
            if (u) blockedUidsSet.add(String(u).trim());
          });
        }
        if (Array.isArray(data?.blockedEmails)) {
          data.blockedEmails.forEach((em: any) => {
            if (em) blockedEmailsSet.add(String(em).trim().toLowerCase());
          });
        }
      } else if (id === "deleted_accounts") {
        if (data?.deletedUids && typeof data.deletedUids === "object") {
          Object.entries(data.deletedUids).forEach(([k, v]) => {
            const ts = Number(v) || 0;
            if (k && ts > 0) deletedUidsMap[k] = ts;
          });
        }
        if (data?.deletedEmails && typeof data.deletedEmails === "object") {
          Object.entries(data.deletedEmails).forEach(([k, v]) => {
            const ts = Number(v) || 0;
            if (k && ts > 0) deletedEmailsMap[String(k).trim().toLowerCase()] = ts;
          });
        }
      }
    });

    // Second pass: process profile_* and attempts_* documents
    docs.forEach((docSnap) => {
      const id = docSnap.id;
      const data = typeof docSnap.data === "function" ? docSnap.data() : docSnap;
      if (id.startsWith("profile_")) {
        const uid = id.replace("profile_", "");
        if (uid.startsWith("local_dev_bypass")) {
          deleteDoc(doc(db, "settings", id)).catch(() => {});
          return;
        }
        const emailLower = String(data?.email || "").trim().toLowerCase();
        const deletedAt = Math.max(
          deletedAccountTimestampsRef.current.get(uid) || 0,
          deletedUidsMap[uid] || 0,
          emailLower ? deletedEmailsMap[emailLower] || 0 : 0
        );
        const docRecreatedAt = Number(data?.recreatedAt) || 0;
        // If this account is in deleted_accounts and was NOT explicitly recreated after deletion,
        // purge any lingering or resurrected profile doc immediately!
        if (deletedAt > 0 && docRecreatedAt <= deletedAt) {
          deleteDoc(doc(db, "settings", id)).catch(() => {});
          return;
        }
        // Ignore empty presence-only stubs that have no uid, email, or displayName
        if (!data?.uid && !data?.email && !data?.displayName) {
          return;
        }
        profilesMap[uid] = { uid, ...data };
        // Auto-clean any legacy tempAdminAuth flags left on non-owner profiles
        const isOwnerEmail =
          emailLower === "suman.das.199972@gmail.com";
        if (data.tempAdminAuth === true && !isOwnerEmail) {
          setDoc(
            doc(db, "settings", id),
            { isAdmin: false, role: "user", tempAdminAuth: false },
            { merge: true }
          ).catch(() => {});
        }
      } else if (id.startsWith("attempts_")) {
        const uid = id.replace("attempts_", "");
        if (uid.startsWith("local_dev_bypass")) {
          deleteDoc(doc(db, "settings", id)).catch(() => {});
          return;
        }
        if (
          (deletedAccountTimestampsRef.current.has(uid) || Boolean(deletedUidsMap[uid])) &&
          !profilesMap[uid]
        ) {
          return;
        }
        const count = data.failedCount || 0;
        attemptsMap[uid] = {
          failedCount: count,
          lockedByAdmin:
            data.lockedByAdmin === true ||
            (count >= 3 && data.reason !== "failed_attempts"),
        };
      }
    });

    const allUids = Array.from(
      new Set([...Object.keys(profilesMap), ...Object.keys(attemptsMap)])
    );

    const rawList = allUids
      .map((uid) => {
        const profile = profilesMap[uid] || {};
        const attemptInfo = attemptsMap[uid] || { failedCount: 0, lockedByAdmin: false };
        const hasProfileDoc = Boolean(profilesMap[uid]);
        // Skip orphan attempt docs that have no profile document
        if (!hasProfileDoc) {
          return null;
        }
        const emailStr = String(profile.email || "").trim();
        const emailLower = emailStr.toLowerCase();
        const isOwner = emailLower === "suman.das.199972@gmail.com";

        let isActuallyAdmin = false;
        if (profile.tempAdminAuth === true && !isOwner) {
          isActuallyAdmin = false;
        } else if (profile.isAdmin !== undefined) {
          isActuallyAdmin = profile.isAdmin === true;
        } else if (profile.role !== undefined) {
          isActuallyAdmin = profile.role === "admin";
        } else {
          isActuallyAdmin = isOwner;
        }

        const isBlocked =
          !isOwner &&
          !isActuallyAdmin &&
          (profile.isBlocked === true ||
            blockedUidsSet.has(uid) ||
            (Boolean(emailLower) && blockedEmailsSet.has(emailLower)));

        const actualRole = isActuallyAdmin ? "admin" : "user";
        const isActuallyOnline =
          !isBlocked &&
          (uid === user?.uid ||
            (profile.isOnline === true &&
              Date.now() - (Number(profile.lastActive) || 0) <= 60000));

        return {
          uid,
          allUids: [uid],
          displayName: profile.displayName || "Anonymous User",
          email: emailStr || "No Email provided",
          customPhotoURL: profile.customPhotoURL || profile.photoURL || "",
          failedCount: isActuallyAdmin ? 0 : attemptInfo.failedCount,
          lockedByAdmin: isActuallyAdmin ? false : attemptInfo.lockedByAdmin,
          isBlocked,
          recreatedAt: Number(profile.recreatedAt) || 0,
          updatedAt: profile.updatedAt || 0,
          isAdmin: isActuallyAdmin,
          role: actualRole,
          isOnline: isActuallyOnline,
          lastActive: profile.lastActive || 0,
        };
      })
      .filter(Boolean) as any[];

    // Deduplicate accounts by normalized email so a user signing in on both PC and Mobile APK appears once
    const byKey = new Map<string, any>();
    rawList.forEach((acc) => {
      const normEmail =
        acc.email && acc.email !== "No Email provided"
          ? acc.email.trim().toLowerCase()
          : `uid:${acc.uid}`;
      const existing = byKey.get(normEmail);
      if (!existing) {
        byKey.set(normEmail, { ...acc, allUids: [acc.uid] });
      } else {
        // If one profile was freshly recreated after an account deletion and the other is an older stale profile doc,
        // delete the stale profile doc so old custom names ("meow") or roles never merge back in!
        const accRecreated = Number(acc.recreatedAt) || 0;
        const existingRecreated = Number(existing.recreatedAt) || 0;
        if (accRecreated > existingRecreated && accRecreated > (existing.updatedAt || 0)) {
          existing.allUids.forEach((staleUid: string) => {
            if (staleUid !== acc.uid) {
              deleteDoc(doc(db, "settings", `profile_${staleUid}`)).catch(() => {});
              deleteDoc(doc(db, "settings", `attempts_${staleUid}`)).catch(() => {});
            }
          });
          byKey.set(normEmail, { ...acc, allUids: [acc.uid] });
          return;
        }
        if (existingRecreated > accRecreated && existingRecreated > (acc.updatedAt || 0)) {
          if (acc.uid !== existing.uid) {
            deleteDoc(doc(db, "settings", `profile_${acc.uid}`)).catch(() => {});
            deleteDoc(doc(db, "settings", `attempts_${acc.uid}`)).catch(() => {});
          }
          return;
        }

        const mergedUids = Array.from(new Set([...existing.allUids, acc.uid]));
        const preferCurrent = acc.uid === user?.uid || (acc.updatedAt || 0) >= (existing.updatedAt || 0);
        const mergedAdmin = Boolean((preferCurrent ? acc : existing).isAdmin);
        const mergedLocked = mergedAdmin ? false : existing.lockedByAdmin || acc.lockedByAdmin;
        const mergedBlocked = mergedAdmin ? false : Boolean(existing.isBlocked || acc.isBlocked);
        const mergedFailed = mergedAdmin ? 0 : Math.max(existing.failedCount || 0, acc.failedCount || 0);
        byKey.set(normEmail, {
          ...(preferCurrent ? acc : existing),
          uid: acc.uid === user?.uid ? acc.uid : existing.uid === user?.uid ? existing.uid : (preferCurrent ? acc.uid : existing.uid),
          allUids: mergedUids,
          displayName:
            preferCurrent && acc.displayName !== "Anonymous User"
              ? acc.displayName
              : existing.displayName !== "Anonymous User"
              ? existing.displayName
              : acc.displayName,
          customPhotoURL: (preferCurrent ? acc.customPhotoURL : existing.customPhotoURL) || existing.customPhotoURL || acc.customPhotoURL,
          isAdmin: mergedAdmin,
          role: mergedAdmin ? "admin" : "user",
          failedCount: mergedFailed,
          lockedByAdmin: mergedLocked,
          isBlocked: mergedBlocked,
          isOnline: mergedBlocked ? false : existing.isOnline || acc.isOnline,
          lastActive: Math.max(existing.lastActive || 0, acc.lastActive || 0),
          recreatedAt: Math.max(existingRecreated, accRecreated),
          updatedAt: Math.max(existing.updatedAt || 0, acc.updatedAt || 0),
        });
      }
    });

    const list = Array.from(byKey.values());
    list.sort((a, b) => {
      if (user && (a.uid === user.uid || a.allUids?.includes(user.uid))) return -1;
      if (user && (b.uid === user.uid || b.allUids?.includes(user.uid))) return 1;
      return (b.updatedAt || 0) - (a.updatedAt || 0);
    });
    return list;
  };

  const fetchAccounts = async () => {
    setAccountsLoading(true);
    setAccountsPermissionError(false);
    if (!isAuthenticated || !user) {
      setAccountsPermissionError(true);
      setAccountsLoading(false);
      return;
    }
    try {
      const snap = await getDocsFromServer(collection(db, "settings")).catch(() =>
        getDocs(collection(db, "settings"))
      );
      const list = buildUnifiedAccountsList(snap.docs);
      setAccounts(list);
      localStorage.setItem("admin_cached_accounts", JSON.stringify(list));
    } catch (err: any) {
      console.debug("Accounts fetch fallback used:", err);
      const cached = localStorage.getItem("admin_cached_accounts");
      if (cached) {
        try {
          setAccounts(JSON.parse(cached));
        } catch (e) {}
      } else {
        const strErr = String(err.message || err).toLowerCase();
        if (strErr.includes("permission") || strErr.includes("insufficient")) {
          setAccountsPermissionError(true);
        }
      }
    } finally {
      setAccountsLoading(false);
    }
  };

  useEffect(() => {
    if (!isAuthenticated || !user) return;

    let isMounted = true;
    let retryTimer: any = null;
    let unsubscribeSnapshot: (() => void) | null = null;

    const startAccountsSubscription = () => {
      if (!isMounted) return;
      setAccountsLoading(true);
      setAccountsPermissionError(false);

      unsubscribeSnapshot = onSnapshot(
        collection(db, "settings"),
        (snap) => {
          if (!isMounted) return;
          const list = buildUnifiedAccountsList(snap.docs);
          setAccounts(list);
          setAccountsPermissionError(false);
          localStorage.setItem("admin_cached_accounts", JSON.stringify(list));
          setAccountsLoading(false);
        },
        (err) => {
          if (!isMounted) return;
          console.debug("Accounts stream waiting for sync:", err);
          const cached = localStorage.getItem("admin_cached_accounts");
          if (cached) {
            try {
              setAccounts(JSON.parse(cached));
            } catch (e) {}
          }
          setAccountsLoading(false);
          retryTimer = setTimeout(() => {
            if (isMounted) {
              if (unsubscribeSnapshot) unsubscribeSnapshot();
              startAccountsSubscription();
            }
          }, 1500);
        }
      );
    };

    startAccountsSubscription();

    return () => {
      isMounted = false;
      if (retryTimer) clearTimeout(retryTimer);
      if (unsubscribeSnapshot) unsubscribeSnapshot();
    };
  }, [isAuthenticated, user?.uid, isAdmin]);

  useEffect(() => {
    if (isAuthenticated && user) {
      setActivityLogsLoading(true);
      setActivityLogsPermissionError(false);
      const q = query(
        collection(db, "activity_logs"),
        orderBy("timestamp", "desc"),
        limit(150)
      );
      const unsubscribe = onSnapshot(
        q,
        (snapshot) => {
          const logs: any[] = [];
          snapshot.forEach((docSnap) => {
            logs.push({ id: docSnap.id, ...docSnap.data() });
          });
          setActivityLogs(logs);
          setActivityLogsLoading(false);
        },
        (err) => {
          console.debug("Failed to listen to activity logs:", err);
          setActivityLogsLoading(false);
          const strErr = String(err.message || err).toLowerCase();
          if (strErr.includes("permission") || strErr.includes("insufficient")) {
            setActivityLogsPermissionError(true);
          }
        }
      );
      return () => unsubscribe();
    }
  }, [isAuthenticated, user, isAdmin, refreshLogsTrigger]);

  // Real-time Sync Conflicts listener
  useEffect(() => {
    if (isAuthenticated && user) {
      setSyncConflictsLoading(true);
      const unsubscribe = onSnapshot(
        collection(db, "sync_conflicts"),
        (snapshot) => {
          const list: SyncConflictRecord[] = [];
          snapshot.forEach((docSnap) => {
            list.push({ ...(docSnap.data() as SyncConflictRecord), id: docSnap.id });
          });
          list.sort(
            (a, b) =>
              (Number(b.failedAt || b.conflictDetectedAt || b.billDate) || 0) -
              (Number(a.failedAt || a.conflictDetectedAt || a.billDate) || 0)
          );
          setSyncConflicts(list);
          setSyncConflictsLoading(false);
        },
        (err) => {
          console.debug("Failed to listen to sync_conflicts:", err);
          setSyncConflictsLoading(false);
        }
      );
      return () => unsubscribe();
    }
  }, [isAuthenticated, user, isAdmin, refreshConflictsTrigger]);

  const handleResolveConflictVoid = async (conflict: SyncConflictRecord) => {
    if (!user || resolvingConflictId) return;
    triggerHaptic("medium");
    setResolvingConflictId(conflict.id);
    try {
      await resolveSyncConflictVoid(
        conflict.id,
        user.displayName || user.email || "Admin"
      );
      logActivity(
        "sync_conflict_resolved",
        `Admin confirmed offline bill #${conflict.billId.slice(-6).toUpperCase()} (${formatPrice(conflict.total)}) as voided due to stock conflict.`,
        user.uid,
        user.displayName || "Admin",
        user.email || ""
      ).catch(() => {});
      triggerHaptic("success");
    } catch (err: any) {
      console.error("Failed to resolve conflict as voided:", err);
      setActionErrorMessage(`Resolution failed: ${err.message || err}`);
    } finally {
      setResolvingConflictId(null);
    }
  };

  const handleResolveConflictForceApprove = async (conflict: SyncConflictRecord) => {
    if (!user || resolvingConflictId) return;
    triggerHaptic("heavy");
    setResolvingConflictId(conflict.id);
    try {
      await resolveSyncConflictForceApprove(
        conflict,
        user.displayName || user.email || "Admin"
      );
      logActivity(
        "sync_conflict_resolved",
        `Admin force-approved offline bill #${conflict.billId.slice(-6).toUpperCase()} (${formatPrice(conflict.total)}) and adjusted remaining stock.`,
        user.uid,
        user.displayName || "Admin",
        user.email || ""
      ).catch(() => {});
      triggerHaptic("success");
    } catch (err: any) {
      console.error("Failed to force-approve conflict bill:", err);
      setActionErrorMessage(`Force approve failed: ${err.message || err}`);
    } finally {
      setResolvingConflictId(null);
    }
  };

  const handleDeleteSingleConflict = async (conflictId: string) => {
    if (!isRealAdmin) return;
    triggerHaptic("light");
    setSyncConflicts((prev) => prev.filter((c) => c.id !== conflictId));
    try {
      await deleteDoc(doc(db, "sync_conflicts", conflictId));
    } catch (err) {
      console.warn("Failed to delete conflict record:", err);
    }
  };

  const handleClearAllConflicts = async () => {
    if (!isRealAdmin || clearingConflicts) return;
    triggerHaptic("heavy");
    setClearingConflicts(true);
    try {
      const snap = await getDocs(collection(db, "sync_conflicts"));
      const docs = snap.docs;
      for (let i = 0; i < docs.length; i += 400) {
        const batch = writeBatch(db);
        docs.slice(i, i + 400).forEach((d) => batch.delete(d.ref));
        await batch.commit();
      }
      setSyncConflicts([]);
      setShowClearConflictsConfirm(false);
      triggerHaptic("success");
    } catch (err) {
      console.error("Failed to clear sync conflicts:", err);
    } finally {
      setClearingConflicts(false);
    }
  };

  const handleSaveProductBuyPrice = async (product: Product, rawValue: string) => {
    if (!product.id) return;
    const trimmed = rawValue.trim();
    const parsed = trimmed === "" ? 0 : parseFloat(trimmed);
    if (isNaN(parsed) || parsed < 0 || parsed > MAX_BILL_AMOUNT) {
      triggerHaptic("error");
      return;
    }
    triggerHaptic("medium");
    setSavingCostProductId(product.id);

    try {
      const { costPrice: nextCostPrice, costBatches: nextCostBatches } =
        buildUpdatedCostStateForPriceChange(product, parsed);
      const fifoMeta = getProductFifoStatus({
        ...product,
        costPrice: nextCostPrice,
        costBatches: nextCostBatches,
      });

      updateProductOptimistic(product.id, {
        costPrice: nextCostPrice,
        costBatches: nextCostBatches,
      });
      if (nextCostPrice > 0) {
        backfillPreviousUnsetBillsWithBuyPrice(product.id, product.name, nextCostPrice);
      }
      await updateProduct(product.id, {
        costPrice: nextCostPrice,
        costBatches: nextCostBatches,
        stock: product.stock,
        name: product.name,
      });
      if (user) {
        const logDesc = fifoMeta.hasLockedLegacyStock
          ? `Updated buy price for "${product.name}" to ₹${formatPrice(parsed)}/unit (FIFO: ${fifoMeta.lockedLegacyUnits} current stock units locked at ₹${formatPrice(fifoMeta.activeUnitCost)}/unit first, then ₹${formatPrice(fifoMeta.nextUnitCost)}/unit after)`
          : `Saved buy price for "${product.name}": ₹${formatPrice(parsed)}/unit (Selling MRP: ₹${formatPrice(product.price)})`;
        logActivity(
          "stock_modification",
          logDesc,
          user.uid,
          user.displayName || "Admin",
          user.email || ""
        ).catch(() => {});
      }
      setQuickCostDrafts((prev) => {
        const next = { ...prev };
        delete next[product.id!];
        return next;
      });
      setJustSavedCostProductId(product.id);
      setTimeout(() => {
        setJustSavedCostProductId((curr) => (curr === product.id ? null : curr));
      }, 1800);
      triggerHaptic("success");
    } catch (err) {
      console.error("Failed saving buy price:", err);
      triggerHaptic("error");
    } finally {
      setSavingCostProductId(null);
    }
  };

  const handleTriggerBackup = async () => {
    triggerHaptic("success");
    setIsProcessing(true);
    try {
      const safeSize = async (collName: string) => {
        try {
          const snap = await Promise.race([
            getDocs(collection(db, collName)),
            new Promise<null>((resolve) => setTimeout(() => resolve(null), 1500)),
          ]);
          return snap ? snap.size : 0;
        } catch {
          return 0;
        }
      };

      const [productsCount, billsCount, otherCostsCount] = await Promise.all([
        safeSize("products"),
        safeSize("bills"),
        safeSize("other_costs"),
      ]);

      const backupData = {
        timestamp: Date.now(),
        triggeredBy: user?.email || "Admin",
        productsCount,
        billsCount,
        otherCostsCount,
        status: "completed",
        details: "Self-contained snapshot stored inside settings/backups",
      };

      setDoc(doc(db, "settings", `backup_${Date.now()}`), backupData).catch((e) =>
        console.warn("Background backup sync warning:", e)
      );

      if (user) {
        logActivity(
          "backup",
          `Manual database backup triggered successfully. Products: ${productsCount}, Bills: ${billsCount}.`,
          user.uid,
          user.displayName || "Admin",
          user.email || ""
        ).catch(() => {});
      }
      setActionSuccessMessage(
        "A manual backup of the Firestore collections has been completed and stored securely."
      );
    } catch (err: any) {
      console.error("Backup trigger failed:", err);
      setActionErrorMessage(`Backup failed: ${err.message || err}`);
    } finally {
      setIsProcessing(false);
    }
  };

  // Broadcast Notification State & Handler
  const [showBroadcastModal, setShowBroadcastModal] = useState(false);
  const [broadcastTitle, setBroadcastTitle] = useState("");
  const [broadcastMessage, setBroadcastMessage] = useState("");
  const [broadcastTarget, setBroadcastTarget] = useState<"all" | "admins" | "users">("all");
  const [sendingBroadcast, setSendingBroadcast] = useState(false);

  const handleSendBroadcastNotification = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    const trimmedMessage = broadcastMessage.trim();
    if (!trimmedMessage || !user) return;

    triggerHaptic("success");
    setSendingBroadcast(true);
    try {
      const ts = Date.now();
      const targetLabel =
        broadcastTarget === "admins"
          ? "Admins Only"
          : broadcastTarget === "users"
          ? "Normal Users"
          : "All Accounts";
      const payload = {
        id: `broadcast_${ts}`,
        title: broadcastTitle.trim() || "Admin Announcement",
        message: trimmedMessage,
        targetAudience: broadcastTarget,
        senderUid: user.uid,
        senderName: user.displayName || "Admin",
        senderEmail: user.email || "",
        timestamp: ts,
        acknowledgedBy: [user.uid],
      };

      await setDoc(doc(db, "settings", "admin_broadcast_notification"), payload);

      logActivity(
        "admin_broadcast",
        `Sent broadcast notification to ${targetLabel}: "${payload.title} — ${trimmedMessage}"`,
        user.uid,
        user.displayName || "Admin",
        user.email || ""
      ).catch(() => {});

      setShowBroadcastModal(false);
      setBroadcastTitle("");
      setBroadcastMessage("");
      setActionSuccessTitle("Notification Sent");
      setActionSuccessMessage(
        `Your notification "${payload.title}" was broadcast in real time to ${targetLabel}.`
      );
    } catch (err: any) {
      console.error("Failed to send broadcast notification:", err);
      setActionErrorMessage(`Failed to send notification: ${err.message || err}`);
    } finally {
      setSendingBroadcast(false);
    }
  };

  const sanitizeFirestoreData = (obj: any): any => {
    if (obj === null || obj === undefined) return null;
    if (Array.isArray(obj)) {
      return obj.map((item) => sanitizeFirestoreData(item)).filter((v) => v !== undefined);
    }
    if (typeof obj === "object" && !(obj instanceof Date)) {
      const cleaned: Record<string, any> = {};
      for (const [k, v] of Object.entries(obj)) {
        if (v !== undefined) {
          cleaned[k] = sanitizeFirestoreData(v);
        }
      }
      return cleaned;
    }
    return obj;
  };

  // Helper to count actual unique user accounts in settings collection (ignoring system settings/attempts/backups)
  const countUserAccountsFromSettings = (items: Array<{ id?: string; email?: string; data?: any }>): number => {
    const keys = new Set<string>();
    items.forEach((item) => {
      const docId = String(item?.id || "");
      const payload = item?.data || item || {};
      if (docId.startsWith("profile_")) {
        const email = String(payload?.email || "").trim().toLowerCase();
        keys.add(email || docId.replace("profile_", ""));
      }
    });
    return keys.size;
  };

  // Build a daily Z-Reports summary list from bills, products (with buy prices), and other_costs outlays
  const buildZReportsSnapshot = (
    productsList: any[],
    billsList: any[],
    otherCostsList: any[]
  ) => {
    const prodById = new Map<string, any>();
    const prodByName = new Map<string, any>();
    productsList.forEach((p: any) => {
      if (!p) return;
      if (p.id) prodById.set(String(p.id).toLowerCase().trim(), p);
      if (p.name) prodByName.set(String(p.name).toLowerCase().trim(), p);
    });

    const resolveUnitCost = (item: any, ts: number): number => {
      if (
        item?.costPrice !== undefined &&
        item?.costPrice !== null &&
        !isNaN(Number(item.costPrice)) &&
        Number(item.costPrice) > 0
      ) {
        return Math.max(0, Number(item.costPrice));
      }
      const idKey = String(item?.productId || "").toLowerCase().trim();
      const nameKey = String(item?.name || "").toLowerCase().trim();
      const matched = prodById.get(idKey) || prodByName.get(nameKey);
      return matched ? getEffectiveProductCost(matched, ts) : 0;
    };

    const byDate = new Map<
      string,
      {
        date: string;
        completedBillsCount: number;
        heldBillsCount: number;
        heldBillsTotal: number;
        udharBillsCount: number;
        udharBillsTotal: number;
        grossSales: number;
        avgBillValue: number;
        totalDiscount: number;
        totalUnitsSold: number;
        shiftCogs: number;
        grossProductProfitDay: number;
        grossMarginPctDay: number;
        dayOtherCosts: number;
        netShiftProfit: number;
        expectedCashInDrawer: number;
        firstBillTs: number | null;
        lastBillTs: number | null;
        firstBillTime: string;
        lastBillTime: string;
        cashierMap: Record<string, { name: string; bills: number; sales: number; profit: number }>;
        itemSoldMap: Record<
          string,
          {
            name: string;
            qty: number;
            unitSellPrice: number;
            unitBuyCost: number;
            revenue: number;
            cogs: number;
            profit: number;
          }
        >;
        dayOutlayItems: { id: string; title: string; category: string; amount: number; time: string }[];
      }
    >();

    const ensureDay = (isoDate: string) => {
      if (!byDate.has(isoDate)) {
        byDate.set(isoDate, {
          date: isoDate,
          completedBillsCount: 0,
          heldBillsCount: 0,
          heldBillsTotal: 0,
          udharBillsCount: 0,
          udharBillsTotal: 0,
          grossSales: 0,
          avgBillValue: 0,
          totalDiscount: 0,
          totalUnitsSold: 0,
          shiftCogs: 0,
          grossProductProfitDay: 0,
          grossMarginPctDay: 0,
          dayOtherCosts: 0,
          netShiftProfit: 0,
          expectedCashInDrawer: 0,
          firstBillTs: null,
          lastBillTs: null,
          firstBillTime: "—",
          lastBillTime: "—",
          cashierMap: {},
          itemSoldMap: {},
          dayOutlayItems: [],
        });
      }
      return byDate.get(isoDate)!;
    };

    // Bills use 12:00 AM midnight cutoff (billing stops ~11:30 PM)
    const toBillIsoDate = (rawTs: any): string | null => {
      const d = new Date(Number(rawTs) || rawTs);
      if (isNaN(d.getTime())) return null;
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
        d.getDate()
      ).padStart(2, "0")}`;
    };

    // App-wide non-bill items (shift outlays/expenses) use 1:00 AM business day cutoff
    const toAppShiftIsoDate = (rawTs: any): string | null => {
      const raw = new Date(Number(rawTs) || rawTs);
      if (isNaN(raw.getTime())) return null;
      const d = new Date(raw.getTime() - 60 * 60 * 1000);
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
        d.getDate()
      ).padStart(2, "0")}`;
    };

    billsList.forEach((b: any) => {
      if (!b) return;
      const rawTs = b.date ?? b.timestamp ?? b.createdAt;
      const iso = toBillIsoDate(rawTs);
      if (!iso) return;
      const entry = ensureDay(iso);
      const billTotal = Number(b.total) || 0;
      if (b.status === "on_hold") {
        entry.heldBillsCount += 1;
        entry.heldBillsTotal += billTotal;
        return;
      }
      if (b.isUdhar || b.status === "on_udhar") {
        entry.udharBillsCount += 1;
        entry.udharBillsTotal += billTotal;
        return;
      }
      entry.completedBillsCount += 1;
      const billDiscount = Number(b.discount) || 0;
      entry.grossSales += billTotal;
      entry.totalDiscount += billDiscount;
      const ts = new Date(Number(rawTs) || rawTs || Date.now()).getTime();
      if (!isNaN(ts)) {
        if (entry.firstBillTs === null || ts < entry.firstBillTs) entry.firstBillTs = ts;
        if (entry.lastBillTs === null || ts > entry.lastBillTs) entry.lastBillTs = ts;
      }

      const cashierName =
        String(b.userName || b.billerName || "Store Counter").trim() || "Store Counter";
      if (!entry.cashierMap[cashierName]) {
        entry.cashierMap[cashierName] = { name: cashierName, bills: 0, sales: 0, profit: 0 };
      }
      entry.cashierMap[cashierName].bills += 1;
      entry.cashierMap[cashierName].sales += billTotal;

      let billCogs = 0;
      let billProfit = 0;
      const items = Array.isArray(b.items) ? b.items : [];
      items.forEach((it: any) => {
        const qty = Math.max(1, Number(it?.quantity) || 1);
        const sellPrice = Number(it?.price) || 0;
        const unitCost = resolveUnitCost(it, ts);
        const hasSetBuyPrice = unitCost > 0;
        const itemRev = sellPrice * qty;
        const itemCogs = hasSetBuyPrice ? unitCost * qty : 0;
        const itemProfit = hasSetBuyPrice ? itemRev - itemCogs : 0;

        entry.totalUnitsSold += qty;
        billCogs += itemCogs;
        billProfit += itemProfit;
        entry.shiftCogs += itemCogs;
        entry.grossProductProfitDay += itemProfit;

        const key = String(it?.productId || it?.name || "item").toLowerCase().trim();
        if (!entry.itemSoldMap[key]) {
          entry.itemSoldMap[key] = {
            name: String(it?.name || "Item"),
            qty: 0,
            unitSellPrice: sellPrice,
            unitBuyCost: unitCost,
            revenue: 0,
            cogs: 0,
            profit: 0,
          };
        }
        entry.itemSoldMap[key].qty += qty;
        entry.itemSoldMap[key].revenue += itemRev;
        entry.itemSoldMap[key].cogs += itemCogs;
        entry.itemSoldMap[key].profit += itemProfit;
        if (unitCost > 0 && entry.itemSoldMap[key].unitBuyCost <= 0) {
          entry.itemSoldMap[key].unitBuyCost = unitCost;
        }
      });

      const billEstimatedProfit = Math.max(
        billDiscount > 0 ? billProfit - billDiscount : billProfit,
        billProfit - billDiscount
      );
      entry.cashierMap[cashierName].profit += billEstimatedProfit;
    });

    otherCostsList.forEach((c: any) => {
      if (!c || c.linkedBillId || String(c.id || "").startsWith("udhaar_bill_")) return;
      const rawDate = c.createdAt ?? c.date ?? c.timestamp;
      const iso = toAppShiftIsoDate(rawDate);
      if (!iso) return;
      const entry = ensureDay(iso);
      const amt = Number(c.amount) || 0;
      entry.dayOtherCosts += amt;
      const ts = new Date(Number(rawDate) || rawDate || Date.now()).getTime();
      entry.dayOutlayItems.push({
        id: String(c.id || Math.random()),
        title: String(c.title || c.name || "Shop Expense"),
        category: String(c.category || "expense"),
        amount: amt,
        time: !isNaN(ts)
          ? new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
          : "—",
      });
    });

    return Array.from(byDate.values())
      .map((entry) => {
        const grossProductProfitDay = entry.grossProductProfitDay - entry.totalDiscount;
        const netShiftProfit = grossProductProfitDay - entry.dayOtherCosts;
        const expectedCashInDrawer = Math.max(0, entry.grossSales - entry.dayOtherCosts);
        const grossMarginPctDay =
          entry.grossSales > 0 ? Math.round((grossProductProfitDay / entry.grossSales) * 100) : 0;
        const avgBillValue =
          entry.completedBillsCount > 0
            ? Math.round(entry.grossSales / entry.completedBillsCount)
            : 0;
        const firstBillTime = entry.firstBillTs
          ? new Date(entry.firstBillTs).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
          : "—";
        const lastBillTime = entry.lastBillTs
          ? new Date(entry.lastBillTs).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
          : "—";
        const cashiers = Object.values(entry.cashierMap).sort((a, b) => b.sales - a.sales);
        const soldItems = Object.values(entry.itemSoldMap).sort((a, b) => b.revenue - a.revenue);
        const { cashierMap, itemSoldMap, firstBillTs, lastBillTs, ...rest } = entry;
        return {
          ...rest,
          avgBillValue,
          grossProductProfitDay,
          grossMarginPctDay,
          netShiftProfit,
          expectedCashInDrawer,
          firstBillTime,
          lastBillTime,
          cashiers,
          soldItems,
        };
      })
      .sort((a, b) => b.date.localeCompare(a.date));
  };

  // Collects a 100% complete snapshot of all collections and local state (including Buy Prices & Z-Reports)
  const collectFullSystemSnapshot = async () => {
    const safeFetchCollection = async (collName: string): Promise<any[]> => {
      try {
        const snap = await Promise.race([
          getDocs(collection(db, collName)),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error("Collection fetch timeout")), 5000)
          ),
        ]);
        return snap.docs.map((docSnap) => ({
          ...(docSnap.data() as Record<string, any>),
          id: docSnap.id,
        }));
      } catch (e) {
        console.warn(`Optional collection ${collName} skipped during snapshot:`, e);
        return [];
      }
    };

    const [
      fetchedProducts,
      fetchedBills,
      fetchedOtherCosts,
      fetchedSettings,
      fetchedActivityLogs,
      fetchedSyncConflicts,
    ] = await Promise.all([
      safeFetchCollection("products"),
      safeFetchCollection("bills"),
      safeFetchCollection("other_costs"),
      safeFetchCollection("settings"),
      safeFetchCollection("activity_logs"),
      safeFetchCollection("sync_conflicts"),
    ]);

    let localFallbackProducts: any[] = [];
    try {
      const raw = localStorage.getItem("local_products_fallback");
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) localFallbackProducts = parsed;
      }
    } catch {}

    let localFallbackBills: any[] = [];
    try {
      const raw = localStorage.getItem("local_bills_fallback");
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) localFallbackBills = parsed;
      }
    } catch {}

    let localFallbackOtherCosts: any[] = [];
    try {
      const raw = localStorage.getItem("local_other_costs_fallback");
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) localFallbackOtherCosts = parsed;
      }
    } catch {}

    // Extract any buy prices and FIFO costBatches stored in settings/product_buy_prices or localStorage
    const savedBuyPricesMap = getLocalSavedBuyPricesMap();
    const savedCostBatchesMap = getLocalSavedCostBatchesMap();
    const settingsBuyPricesDoc = fetchedSettings.find(
      (s: any) => String(s?.id || "") === "product_buy_prices"
    );
    if (settingsBuyPricesDoc && settingsBuyPricesDoc.items && typeof settingsBuyPricesDoc.items === "object") {
      Object.values(settingsBuyPricesDoc.items).forEach((entry: any) => {
        if (entry && entry.costPrice !== undefined && !isNaN(Number(entry.costPrice))) {
          saveLocalBuyPriceEntry(entry.id, entry.name, Number(entry.costPrice));
          if (entry.id) savedBuyPricesMap[`id:${String(entry.id).trim()}`] = Number(entry.costPrice);
          if (entry.name) savedBuyPricesMap[`name:${String(entry.name).toLowerCase().trim()}`] = Number(entry.costPrice);
        }
        if (entry && Array.isArray(entry.costBatches) && entry.costBatches.length > 0) {
          saveLocalCostBatchesEntry(entry.id, entry.name, entry.costBatches);
          if (entry.id) savedCostBatchesMap[`id:${String(entry.id).trim()}`] = entry.costBatches;
          if (entry.name) savedCostBatchesMap[`name:${String(entry.name).toLowerCase().trim()}`] = entry.costBatches;
        }
      });
    }

    // Merge products from Firestore + globalProducts + local_products_fallback, preserving costPrice (Buy Price) & FIFO costBatches
    const deletedIds = getDeletedProductIds();
    const deletedNames = getDeletedProductNames();
    const productsMap = new Map<string, any>();
    [...localFallbackProducts, ...fetchedProducts, ...globalProducts].forEach((p: any, idx: number) => {
      if (!p || typeof p !== "object") return;
      const payload = p.data && typeof p.data === "object" && !Array.isArray(p.data) ? { ...p.data, ...p } : p;
      const idStr = String(payload.id || payload.name || `prod_${idx}`).trim();
      const nameStr = String(payload.name || "").trim();
      if (!nameStr) return;
      if (deletedIds.has(idStr) || deletedNames.has(nameStr.toLowerCase())) return;

      const existing = productsMap.get(idStr) || {};
      const resolvedBatches = normalizeCostBatches(
        Array.isArray(payload.costBatches) && payload.costBatches.length > 0
          ? payload.costBatches
          : Array.isArray(existing.costBatches) && existing.costBatches.length > 0
          ? existing.costBatches
          : savedCostBatchesMap[`id:${idStr}`] ??
            savedCostBatchesMap[`name:${nameStr.toLowerCase()}`]
      );

      let resolvedCost: number | undefined = undefined;
      for (const candidate of [
        payload.costPrice,
        payload.buyPrice,
        existing.costPrice,
        existing.buyPrice,
        savedBuyPricesMap[`id:${idStr}`],
        savedBuyPricesMap[`name:${nameStr.toLowerCase()}`],
      ]) {
        if (
          candidate !== undefined &&
          candidate !== null &&
          String(candidate).trim() !== "" &&
          !isNaN(Number(candidate)) &&
          Number(candidate) >= 0
        ) {
          resolvedCost = Number(candidate);
          break;
        }
      }
      if (resolvedCost === undefined && resolvedBatches.length > 0) {
        const frontActive = resolvedBatches.find(
          (b) => b.remainingQty === undefined || b.remainingQty === null || Number(b.remainingQty) > 0
        );
        const fallbackBatch = frontActive || resolvedBatches[resolvedBatches.length - 1];
        if (fallbackBatch && !isNaN(Number(fallbackBatch.costPrice)) && Number(fallbackBatch.costPrice) >= 0) {
          resolvedCost = Number(fallbackBatch.costPrice);
        }
      }

      if (resolvedCost !== undefined) {
        saveLocalBuyPriceEntry(idStr, nameStr, resolvedCost);
      }
      if (resolvedBatches.length > 0) {
        saveLocalCostBatchesEntry(idStr, nameStr, resolvedBatches);
      }

      const mergedProd: Record<string, any> = {
        ...existing,
        ...payload,
        id: idStr,
        name: nameStr,
        price: Math.max(0, Number(payload.price ?? existing.price ?? 0) || 0),
        stock: Math.max(0, Number(payload.stock ?? existing.stock ?? 0) || 0),
        soldCount: Math.max(0, Number(payload.soldCount ?? existing.soldCount ?? 0) || 0),
        createdAt: Number(payload.createdAt ?? existing.createdAt) || Date.now(),
        updatedAt: Number(payload.updatedAt ?? existing.updatedAt) || Date.now(),
      };
      if (resolvedCost !== undefined) {
        mergedProd.costPrice = resolvedCost;
      } else {
        delete mergedProd.costPrice;
      }
      if (resolvedBatches.length > 0) {
        mergedProd.costBatches = resolvedBatches;
      } else {
        delete mergedProd.costBatches;
      }
      productsMap.set(idStr, mergedProd);
    });
    const productsList = Array.from(productsMap.values());

    // Build explicit product_buy_prices map so buy prices and FIFO costBatches are also backed up standalone
    const productBuyPricesItems: Record<string, any> = {};
    productsList.forEach((p: any) => {
      if (
        p.id &&
        ((p.costPrice !== undefined && !isNaN(Number(p.costPrice)) && Number(p.costPrice) >= 0) ||
          (Array.isArray(p.costBatches) && p.costBatches.length > 0))
      ) {
        productBuyPricesItems[String(p.id)] = {
          id: String(p.id),
          name: String(p.name || ""),
          costPrice: Number(p.costPrice) || 0,
          ...(Array.isArray(p.costBatches) && p.costBatches.length > 0
            ? { costBatches: p.costBatches }
            : {}),
          updatedAt: Number(p.updatedAt) || Date.now(),
        };
      }
    });

    // Merge and normalize bills (enriching item costPrice from productsList only if a positive buy price is set)
    const prodCostById = new Map<string, number>();
    const prodCostByName = new Map<string, number>();
    productsList.forEach((p: any) => {
      const effectiveCost = getEffectiveProductCost(p);
      if (effectiveCost > 0) {
        if (p.id) prodCostById.set(String(p.id).toLowerCase().trim(), effectiveCost);
        if (p.name) prodCostByName.set(String(p.name).toLowerCase().trim(), effectiveCost);
      }
    });

    const billsList = normalizeAndDedupeBills([
      ...(Array.isArray(globalBills) ? globalBills : []),
      ...(Array.isArray(fetchedBills) ? fetchedBills : []),
      ...localFallbackBills,
    ]).map((b: any) => ({
      ...b,
      items: (Array.isArray(b.items) ? b.items : []).map((it: any) => {
        if (
          it?.costPrice !== undefined &&
          it?.costPrice !== null &&
          !isNaN(Number(it.costPrice)) &&
          Number(it.costPrice) > 0
        ) {
          return { ...it, costPrice: Number(it.costPrice) };
        }
        const matchedCost =
          prodCostById.get(String(it?.productId || "").toLowerCase().trim()) ??
          prodCostByName.get(String(it?.name || "").toLowerCase().trim());
        return matchedCost !== undefined && matchedCost > 0
          ? { ...it, costPrice: matchedCost }
          : it;
      }),
    }));

    // Merge other_costs from Firestore + local_other_costs_fallback
    const otherCostsMap = new Map<string, any>();
    [...localFallbackOtherCosts, ...fetchedOtherCosts].forEach((c: any, idx: number) => {
      if (!c || typeof c !== "object") return;
      const payload = c.data && typeof c.data === "object" && !Array.isArray(c.data) ? { ...c.data, ...c } : c;
      const key = String(payload.id || `cost_${payload.date || Date.now()}_${idx}`).trim();
      otherCostsMap.set(key, {
        ...otherCostsMap.get(key),
        ...payload,
        id: key,
        title: String(payload.title || payload.name || "Untitled Expense"),
        amount: Math.max(0, Number(payload.amount) || 0),
        category: payload.category || "expense",
        date: Number(payload.date || payload.createdAt || payload.timestamp) || Date.now(),
        ownerId: String(payload.ownerId || user?.uid || ""),
      });
    });
    const otherCostsList = Array.from(otherCostsMap.values()).sort(
      (a, b) => (Number(b.date) || 0) - (Number(a.date) || 0)
    );

    // Build daily Z-Report summaries
    const zReportsList = buildZReportsSnapshot(productsList, billsList, otherCostsList);

    // Merge settings and ensure admin_pin, product_buy_prices, and z_reports_snapshot are included
    const settingsMap = new Map<string, any>();
    fetchedSettings.forEach((s: any, idx: number) => {
      if (!s || typeof s !== "object") return;
      const key = String(s.id || `setting_${idx}`).trim();
      settingsMap.set(key, { ...s, id: key });
    });
    const currentPin = localStorage.getItem("adminPin") || adminPin || "8521";
    settingsMap.set("admin_pin", {
      ...(settingsMap.get("admin_pin") || {}),
      id: "admin_pin",
      pin: currentPin,
    });
    settingsMap.set("product_buy_prices", {
      id: "product_buy_prices",
      items: productBuyPricesItems,
      updatedAt: Date.now(),
    });
    settingsMap.set("z_reports_snapshot", {
      id: "z_reports_snapshot",
      reports: zReportsList,
      updatedAt: Date.now(),
    });
    const settingsList = Array.from(settingsMap.values());

    // Merge activity_logs
    const logsMap = new Map<string, any>();
    [...(Array.isArray(activityLogs) ? activityLogs : []), ...fetchedActivityLogs].forEach(
      (logItem: any, idx: number) => {
        if (!logItem || typeof logItem !== "object") return;
        const key = String(
          logItem.id || `${logItem.eventType || "event"}_${logItem.timestamp || idx}_${idx}`
        );
        logsMap.set(key, { ...logsMap.get(key), ...logItem, id: logItem.id || key });
      }
    );
    const activityLogsList = Array.from(logsMap.values()).sort(
      (a, b) => (Number(b.timestamp) || 0) - (Number(a.timestamp) || 0)
    );

    // Merge sync_conflicts
    const conflictsMap = new Map<string, any>();
    [...(Array.isArray(syncConflicts) ? syncConflicts : []), ...fetchedSyncConflicts].forEach(
      (cItem: any, idx: number) => {
        if (!cItem || typeof cItem !== "object") return;
        const key = String(cItem.id || `conflict_${idx}`);
        conflictsMap.set(key, { ...conflictsMap.get(key), ...cItem, id: cItem.id || key });
      }
    );
    const syncConflictsList = Array.from(conflictsMap.values());

    return {
      version: "2.0",
      timestamp: Date.now(),
      projectId: appletConfig.projectId || "",
      sourceDatabaseId: appletConfig.firestoreDatabaseId || "",
      adminPin: currentPin,
      products: productsList,
      product_buy_prices: productBuyPricesItems,
      bills: billsList,
      other_costs: otherCostsList,
      z_reports: zReportsList,
      settings: settingsList,
      activity_logs: activityLogsList,
      sync_conflicts: syncConflictsList,
    };
  };

  // Restores 100% of system data from either a parsed JSON backup or a fetched Database ID payload
  const restoreFullSystemData = async (rawInput: any) => {
    const backupObj = Array.isArray(rawInput) ? { products: rawInput } : rawInput || {};

    // Also check if settings contains a `latest_full_snapshot` fallback when collections are empty
    const rawSettingsArr: any[] = Array.isArray(backupObj.settings) ? backupObj.settings : [];
    const embeddedSnapshotDoc = rawSettingsArr.find((s: any) => {
      const id = String(s?.id || "");
      return id === "latest_full_snapshot";
    });
    const embeddedSnapshot =
      embeddedSnapshotDoc?.data && typeof embeddedSnapshotDoc.data === "object"
        ? embeddedSnapshotDoc.data
        : embeddedSnapshotDoc || {};

    const pickArray = (primary: any, secondary: any): any[] => {
      if (Array.isArray(primary) && primary.length > 0) return primary;
      if (Array.isArray(secondary) && secondary.length > 0) return secondary;
      return Array.isArray(primary) ? primary : [];
    };

    const rawProductsArr = pickArray(backupObj.products, embeddedSnapshot.products);
    const rawBillsArr = pickArray(
      backupObj.bills || backupObj.transactions || backupObj.receipts,
      embeddedSnapshot.bills
    );
    const rawOtherCostsArr = pickArray(
      backupObj.other_costs || backupObj.otherCosts,
      embeddedSnapshot.other_costs
    );
    const settingsArr = pickArray(backupObj.settings, embeddedSnapshot.settings);
    const rawActivityLogsArr = pickArray(
      backupObj.activity_logs || backupObj.activityLogs,
      embeddedSnapshot.activity_logs
    );
    const rawSyncConflictsArr = pickArray(
      backupObj.sync_conflicts || backupObj.syncConflicts,
      embeddedSnapshot.sync_conflicts
    );
    const rawZReportsArr = pickArray(
      backupObj.z_reports || backupObj.zReports,
      embeddedSnapshot.z_reports
    );

    // 1. Extract and hydrate all Product Buy Prices (`costPrice` & FIFO `costBatches`) from top-level `product_buy_prices`, `settings/product_buy_prices`, and `products`
    const buyPriceLookupById = new Map<string, number>();
    const buyPriceLookupByName = new Map<string, number>();
    const costBatchesLookupById = new Map<string, CostBatch[]>();
    const costBatchesLookupByName = new Map<string, CostBatch[]>();

    const registerBuyPrice = (id?: any, name?: any, cost?: any, batches?: any) => {
      const idStr = id ? String(id).trim() : "";
      const nameStr = name ? String(name).trim() : "";
      const normBatches = normalizeCostBatches(batches);
      if (normBatches.length > 0) {
        if (idStr) costBatchesLookupById.set(idStr.toLowerCase(), normBatches);
        if (nameStr) costBatchesLookupByName.set(nameStr.toLowerCase(), normBatches);
        saveLocalCostBatchesEntry(idStr || undefined, nameStr || undefined, normBatches);
      }
      if (cost === undefined || cost === null || String(cost).trim() === "" || isNaN(Number(cost))) {
        return;
      }
      const num = Number(cost);
      if (num < 0) return;
      if (idStr) buyPriceLookupById.set(idStr.toLowerCase(), num);
      if (nameStr) buyPriceLookupByName.set(nameStr.toLowerCase(), num);
      saveLocalBuyPriceEntry(idStr || undefined, nameStr || undefined, num);
    };

    const topBuyPrices = backupObj.product_buy_prices || backupObj.productBuyPrices || embeddedSnapshot.product_buy_prices;
    if (topBuyPrices && typeof topBuyPrices === "object") {
      if (Array.isArray(topBuyPrices)) {
        topBuyPrices.forEach((entry: any) => {
          registerBuyPrice(
            entry?.id,
            entry?.name,
            entry?.costPrice ?? entry?.buyPrice,
            entry?.costBatches
          );
        });
      } else {
        Object.entries(topBuyPrices).forEach(([k, entry]: [string, any]) => {
          if (typeof entry === "number") {
            registerBuyPrice(k, undefined, entry);
          } else if (entry && typeof entry === "object") {
            registerBuyPrice(
              entry.id || k,
              entry.name,
              entry.costPrice ?? entry.buyPrice,
              entry.costBatches
            );
          }
        });
      }
    }

    settingsArr.forEach((s: any) => {
      if (!s || typeof s !== "object") return;
      const payload = s.data && typeof s.data === "object" && !Array.isArray(s.data) ? { ...s.data, ...s } : s;
      const docId = String(payload.id || "").trim();
      if (docId === "product_buy_prices" && payload.items && typeof payload.items === "object") {
        Object.entries(payload.items).forEach(([k, entry]: [string, any]) => {
          if (entry && typeof entry === "object") {
            registerBuyPrice(
              entry.id || k,
              entry.name,
              entry.costPrice ?? entry.buyPrice,
              entry.costBatches
            );
          }
        });
      }
    });

    // 2. Normalize Products and attach Buy Prices (`costPrice` & FIFO `costBatches`)
    const normalizedProducts: Product[] = [];
    rawProductsArr.forEach((rawProd: any, idx: number) => {
      if (!rawProd || typeof rawProd !== "object") return;
      const payload =
        rawProd.data && typeof rawProd.data === "object" && !Array.isArray(rawProd.data)
          ? { ...rawProd.data, ...rawProd, id: rawProd.id || rawProd.data.id }
          : rawProd;
      const nameStr = String(payload.name || "").trim();
      if (!nameStr) return;
      const idStr = String(payload.id || `prod_${Date.now()}_${idx}`).trim();

      const resolvedBatches = normalizeCostBatches(
        Array.isArray(payload.costBatches) && payload.costBatches.length > 0
          ? payload.costBatches
          : costBatchesLookupById.get(idStr.toLowerCase()) ??
            costBatchesLookupByName.get(nameStr.toLowerCase())
      );

      let resolvedCost: number | undefined = undefined;
      for (const candidate of [
        payload.costPrice,
        payload.buyPrice,
        buyPriceLookupById.get(idStr.toLowerCase()),
        buyPriceLookupByName.get(nameStr.toLowerCase()),
      ]) {
        if (
          candidate !== undefined &&
          candidate !== null &&
          String(candidate).trim() !== "" &&
          !isNaN(Number(candidate)) &&
          Number(candidate) >= 0
        ) {
          resolvedCost = Number(candidate);
          break;
        }
      }
      if (resolvedCost === undefined && resolvedBatches.length > 0) {
        const frontActive = resolvedBatches.find(
          (b) => b.remainingQty === undefined || b.remainingQty === null || Number(b.remainingQty) > 0
        );
        const fallbackBatch = frontActive || resolvedBatches[resolvedBatches.length - 1];
        if (fallbackBatch && !isNaN(Number(fallbackBatch.costPrice)) && Number(fallbackBatch.costPrice) >= 0) {
          resolvedCost = Number(fallbackBatch.costPrice);
        }
      }

      if (resolvedCost !== undefined || resolvedBatches.length > 0) {
        registerBuyPrice(idStr, nameStr, resolvedCost, resolvedBatches);
      }

      const prodObj: any = {
        ...payload,
        id: idStr,
        name: nameStr,
        price: Math.max(0, Number(payload.price) || 0),
        stock: Math.max(0, Number(payload.stock) || 0),
        soldCount: Math.max(0, Number(payload.soldCount) || 0),
        createdAt: Number(payload.createdAt) || Date.now(),
        updatedAt: Number(payload.updatedAt) || Date.now(),
      };
      delete prodObj.data;
      if (resolvedCost !== undefined) {
        prodObj.costPrice = resolvedCost;
      } else {
        delete prodObj.costPrice;
      }
      if (resolvedBatches.length > 0) {
        prodObj.costBatches = resolvedBatches;
      } else {
        delete prodObj.costBatches;
      }
      normalizedProducts.push(prodObj as Product);
    });

    if (normalizedProducts.length > 0) {
      unmarkProductsDeletedLocal();
      restoreProductsOptimistic(normalizedProducts);
    } else if (
      buyPriceLookupById.size > 0 ||
      buyPriceLookupByName.size > 0 ||
      costBatchesLookupById.size > 0 ||
      costBatchesLookupByName.size > 0
    ) {
      // Even if only buy prices or costBatches were restored, apply them to existing globalProducts
      globalProducts.forEach((p) => {
        if (!p.id) return;
        const matchedCost =
          buyPriceLookupById.get(String(p.id).toLowerCase()) ??
          buyPriceLookupByName.get(String(p.name || "").toLowerCase());
        const matchedBatches =
          costBatchesLookupById.get(String(p.id).toLowerCase()) ??
          costBatchesLookupByName.get(String(p.name || "").toLowerCase());
        if (matchedCost !== undefined || matchedBatches !== undefined) {
          updateProductOptimistic(p.id, {
            ...(matchedCost !== undefined ? { costPrice: matchedCost } : {}),
            ...(matchedBatches !== undefined ? { costBatches: matchedBatches } : {}),
          });
        }
      });
    }

    // 3. Normalize Bills and enrich items with restored Buy Prices (`costPrice`) only when > 0
    const normalizedBills = normalizeAndDedupeBills(rawBillsArr).map((b: any) => ({
      ...b,
      items: (Array.isArray(b.items) ? b.items : []).map((it: any) => {
        if (
          it?.costPrice !== undefined &&
          it?.costPrice !== null &&
          !isNaN(Number(it.costPrice)) &&
          Number(it.costPrice) > 0
        ) {
          return { ...it, costPrice: Number(it.costPrice) };
        }
        const matchedCost =
          buyPriceLookupById.get(String(it?.productId || "").toLowerCase().trim()) ??
          buyPriceLookupByName.get(String(it?.name || "").toLowerCase().trim());
        return matchedCost !== undefined && matchedCost > 0
          ? { ...it, costPrice: matchedCost }
          : it;
      }),
    }));

    if (normalizedBills.length > 0) {
      restoreBillsOptimistic(normalizedBills);
    }

    // 4. Normalize Other Costs (Store Outlays for Z-Report + Udhar Records) and immediately hydrate localStorage + listeners
    const normalizedOtherCosts = rawOtherCostsArr
      .filter((c: any) => c && typeof c === "object")
      .map((rawCost: any, idx: number) => {
        const payload =
          rawCost.data && typeof rawCost.data === "object" && !Array.isArray(rawCost.data)
            ? { ...rawCost.data, ...rawCost, id: rawCost.id || rawCost.data.id }
            : rawCost;
        const docId = String(payload.id || `cost_${Date.now()}_${idx}`).trim();
        const cleaned: Record<string, any> = {
          ...payload,
          id: docId,
          title: String(payload.title || payload.name || "Untitled Expense"),
          name: String(payload.name || payload.title || "Untitled Expense"),
          amount: Math.max(0, Number(payload.amount) || 0),
          category: payload.category || "expense",
          date: Number(payload.date || payload.createdAt || payload.timestamp) || Date.now(),
          ownerId: String(payload.ownerId || user?.uid || ""),
        };
        delete cleaned.data;
        return cleaned;
      });

    if (normalizedOtherCosts.length > 0) {
      try {
        const existingRaw = localStorage.getItem("local_other_costs_fallback");
        const existingList = existingRaw ? JSON.parse(existingRaw) : [];
        const costMap = new Map<string, any>();
        [...(Array.isArray(existingList) ? existingList : []), ...normalizedOtherCosts].forEach(
          (c: any) => {
            if (c && c.id) costMap.set(String(c.id), c);
          }
        );
        const mergedCosts = Array.from(costMap.values()).sort(
          (a, b) => (Number(b.date) || 0) - (Number(a.date) || 0)
        );
        localStorage.setItem("local_other_costs_fallback", JSON.stringify(mergedCosts));
        window.dispatchEvent(new CustomEvent("otherCostsUpdated", { detail: mergedCosts }));
        window.dispatchEvent(new CustomEvent("localOtherCostsUpdated", { detail: mergedCosts }));
      } catch {}
    }

    // 5. Normalize Activity Logs and hydrate state immediately
    const normalizedLogs = rawActivityLogsArr
      .filter((item: any) => item && typeof item === "object")
      .map((item: any, idx: number) => {
        const payload =
          item.data && typeof item.data === "object" && !Array.isArray(item.data)
            ? { ...item.data, ...item, id: item.id || item.data.id }
            : item;
        const ts =
          typeof payload.timestamp === "number"
            ? payload.timestamp
            : typeof payload.timestamp === "string" && payload.timestamp.trim() !== ""
            ? Number(payload.timestamp) || Date.parse(payload.timestamp) || Date.now()
            : payload.timestamp?.seconds
            ? payload.timestamp.seconds * 1000
            : Date.now();
        const cleaned: Record<string, any> = {
          ...payload,
          id: String(payload.id || `log_${ts}_${idx}`).trim(),
          eventType: String(payload.eventType || "system"),
          description: String(payload.description || ""),
          userId: String(payload.userId || ""),
          userName: String(payload.userName || "System"),
          userEmail: String(payload.userEmail || ""),
          timestamp: ts,
        };
        delete cleaned.data;
        return cleaned;
      });

    if (normalizedLogs.length > 0) {
      setActivityLogs((prev) => {
        const map = new Map<string, any>();
        [...normalizedLogs, ...prev].forEach((l) => {
          if (l && l.id) map.set(String(l.id), l);
        });
        return Array.from(map.values()).sort(
          (a, b) => (Number(b.timestamp) || 0) - (Number(a.timestamp) || 0)
        );
      });
    }

    // 6. Normalize Sync Conflicts and hydrate state immediately
    const normalizedConflicts = rawSyncConflictsArr
      .filter((item: any) => item && typeof item === "object")
      .map((item: any, idx: number) => {
        const payload =
          item.data && typeof item.data === "object" && !Array.isArray(item.data)
            ? { ...item.data, ...item, id: item.id || item.data.id }
            : item;
        const cleaned: Record<string, any> = {
          ...payload,
          id: String(payload.id || `conflict_${Date.now()}_${idx}`).trim(),
        };
        delete cleaned.data;
        return cleaned;
      });

    if (normalizedConflicts.length > 0) {
      setSyncConflicts((prev) => {
        const map = new Map<string, any>();
        [...normalizedConflicts, ...prev].forEach((c) => {
          if (c && c.id) map.set(String(c.id), c);
        });
        return Array.from(map.values()) as SyncConflictRecord[];
      });
    }

    // 7. Normalize Settings (including admin_pin, user profiles, attempts, product_buy_prices, and z_reports_snapshot)
    const settingsMap = new Map<string, any>();
    settingsArr.forEach((rawSetting: any, idx: number) => {
      if (!rawSetting || typeof rawSetting !== "object") return;
      const payload =
        rawSetting.data && typeof rawSetting.data === "object" && !Array.isArray(rawSetting.data)
          ? { ...rawSetting.data, ...rawSetting, id: rawSetting.id || rawSetting.data.id }
          : rawSetting;
      const docId = String(payload.id || `setting_${Date.now()}_${idx}`).trim();
      if (!docId || docId === "latest_full_snapshot") return;
      const cleaned: Record<string, any> = { ...payload, id: docId };
      delete cleaned.data;
      settingsMap.set(docId, cleaned);
    });

    if (backupObj.adminPin && String(backupObj.adminPin).trim().length === 4) {
      const pinStr = String(backupObj.adminPin).trim();
      settingsMap.set("admin_pin", {
        ...(settingsMap.get("admin_pin") || {}),
        id: "admin_pin",
        pin: pinStr,
      });
    }

    const adminPinDoc = settingsMap.get("admin_pin");
    if (adminPinDoc?.pin && String(adminPinDoc.pin).trim().length === 4) {
      const restoredPin = String(adminPinDoc.pin).trim();
      localStorage.setItem("adminPin", restoredPin);
      window.dispatchEvent(new CustomEvent("adminPinUpdated", { detail: restoredPin }));
    }

    // Persist buy prices map in settings/product_buy_prices as well
    const buyPricesSettingsItems: Record<string, any> = {};
    normalizedProducts.forEach((p) => {
      if (p.id && p.costPrice !== undefined && !isNaN(Number(p.costPrice))) {
        buyPricesSettingsItems[String(p.id)] = {
          id: String(p.id),
          name: String(p.name || ""),
          costPrice: Number(p.costPrice),
          ...(Array.isArray(p.costBatches) ? { costBatches: p.costBatches } : {}),
          updatedAt: Number(p.updatedAt) || Date.now(),
        };
      }
    });
    if (Object.keys(buyPricesSettingsItems).length > 0) {
      const existingBpDoc = settingsMap.get("product_buy_prices") || {};
      settingsMap.set("product_buy_prices", {
        ...existingBpDoc,
        id: "product_buy_prices",
        items: { ...(existingBpDoc.items || {}), ...buyPricesSettingsItems },
        updatedAt: Date.now(),
      });
    }

    // Persist Z-Reports snapshot in settings/z_reports_snapshot
    const computedZReports =
      rawZReportsArr.length > 0
        ? rawZReportsArr
        : buildZReportsSnapshot(normalizedProducts, normalizedBills, normalizedOtherCosts);
    if (computedZReports.length > 0) {
      settingsMap.set("z_reports_snapshot", {
        id: "z_reports_snapshot",
        reports: computedZReports,
        updatedAt: Date.now(),
      });
    }

    const normalizedSettings = Array.from(settingsMap.values());
    if (normalizedSettings.length > 0) {
      const restoredAccounts = buildUnifiedAccountsList(normalizedSettings);
      if (restoredAccounts.length > 0) {
        setAccounts(restoredAccounts);
        try {
          localStorage.setItem("admin_cached_accounts", JSON.stringify(restoredAccounts));
        } catch {}
      }
    }

    // 8. Resilient batch write to Firestore (with per-document setDoc fallback if any chunk fails)
    const resilientWriteCollection = async (collName: string, items: any[]) => {
      let count = 0;
      for (let i = 0; i < items.length; i += 350) {
        const chunk = items.slice(i, i + 350);
        try {
          const batch = writeBatch(db);
          chunk.forEach((item, idx) => {
            if (!item || typeof item !== "object") return;
            const docId = String(item.id || `${collName}_${Date.now()}_${i + idx}`).trim();
            if (!docId) return;
            batch.set(
              doc(db, collName, docId),
              sanitizeFirestoreData({ ...item, id: docId }),
              { merge: true }
            );
            count++;
          });
          await batch.commit();
        } catch (batchErr) {
          console.warn(`Batch chunk fallback for ${collName}:`, batchErr);
          for (let j = 0; j < chunk.length; j++) {
            const item = chunk[j];
            if (!item || typeof item !== "object") continue;
            const docId = String(item.id || `${collName}_${Date.now()}_${i + j}`).trim();
            if (!docId) continue;
            try {
              await setDoc(
                doc(db, collName, docId),
                sanitizeFirestoreData({ ...item, id: docId }),
                { merge: true }
              );
              count++;
            } catch (docErr) {
              console.warn(`Skipped invalid doc ${collName}/${docId}:`, docErr);
            }
          }
        }
      }
      return count;
    };

    const [
      importedProducts,
      importedBills,
      importedOtherCosts,
      importedSettings,
      importedActivityLogs,
      importedSyncConflicts,
    ] = await Promise.all([
      normalizedProducts.length > 0
        ? resilientWriteCollection("products", normalizedProducts)
        : Promise.resolve(0),
      normalizedBills.length > 0
        ? resilientWriteCollection("bills", normalizedBills)
        : Promise.resolve(0),
      normalizedOtherCosts.length > 0
        ? resilientWriteCollection("other_costs", normalizedOtherCosts)
        : Promise.resolve(0),
      normalizedSettings.length > 0
        ? resilientWriteCollection("settings", normalizedSettings)
        : Promise.resolve(0),
      normalizedLogs.length > 0
        ? resilientWriteCollection("activity_logs", normalizedLogs)
        : Promise.resolve(0),
      normalizedConflicts.length > 0
        ? resilientWriteCollection("sync_conflicts", normalizedConflicts)
        : Promise.resolve(0),
    ]);

    const buyPricesCount = normalizedProducts.filter(
      (p) => p.costPrice !== undefined && !isNaN(Number(p.costPrice)) && Number(p.costPrice) > 0
    ).length;
    const restoredAccountsCount = countUserAccountsFromSettings(normalizedSettings);

    return {
      importedProducts,
      buyPricesCount,
      importedBills,
      zReportsCount: computedZReports.length,
      importedOtherCosts,
      importedSettings,
      importedActivityLogs,
      importedSyncConflicts,
      restoredAccountsCount,
    };
  };

  const handleExportJSONBackup = async () => {
    triggerHaptic("success");
    setIsProcessing(true);
    setActionSuccessTitle("Operation Complete");
    setActionSuccessMessage("");
    setActionErrorMessage("");
    setLastExportedBackup(null);
    try {
      const backupObj = await collectFullSystemSnapshot();

      // Save latest snapshot locally so Copy-Paste Database ID on this device can also recover it
      try {
        const dbId = appletConfig.firestoreDatabaseId || "";
        if (dbId) {
          localStorage.setItem(`db_snapshot_${dbId}`, JSON.stringify(backupObj));
        }
        localStorage.setItem("latest_full_snapshot_v1", JSON.stringify(backupObj));
      } catch {}

      const jsonString = JSON.stringify(backupObj, null, 2);
      const fileName = `buzz_backup_${new Date().toISOString().slice(0, 10)}_${Date.now()}.json`;
      setLastExportedBackup(null);

      let savedViaNativeAndroid = false;
      const androidExporter = (window as any).AndroidExporter;
      if (androidExporter && typeof androidExporter.saveJsonToDownloads === "function") {
        try {
          savedViaNativeAndroid = Boolean(
            androidExporter.saveJsonToDownloads(fileName, jsonString)
          );
        } catch (nativeErr) {
          console.warn("AndroidExporter fallback:", nativeErr);
        }
      }

      if (!savedViaNativeAndroid) {
        const blob = new Blob([jsonString], {
          type: "application/json;charset=utf-8",
        });
        const url = URL.createObjectURL(blob);
        const link = document.createElement("a");
        link.href = url;
        link.download = fileName;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        setTimeout(() => URL.revokeObjectURL(url), 4000);
      }

      const exportedAccountsCount = countUserAccountsFromSettings(backupObj.settings);
      const savedBuyPricesCount = Object.keys(backupObj.product_buy_prices || {}).length;

      if (user) {
        await logActivity(
          "backup",
          `Exported JSON system backup (${backupObj.products.length} products, ${savedBuyPricesCount} buy prices, ${backupObj.bills.length} bills, ${backupObj.z_reports.length} Z-reports, ${backupObj.other_costs.length} other costs, ${exportedAccountsCount} accounts).`,
          user.uid,
          user.displayName || "Admin",
          user.email || ""
        );
      }

      setActionSuccessTitle("Backup Downloaded");
      setActionSuccessMessage(
        `Saved ${backupObj.products.length} products (${savedBuyPricesCount} buy prices), ${backupObj.bills.length} bills (${backupObj.z_reports.length} Z-report days), ${backupObj.other_costs.length} expenses, ${backupObj.activity_logs.length} logs, and ${exportedAccountsCount} accounts to ${fileName}.`
      );
    } catch (err: any) {
      console.warn("Failed to export JSON backup:", err);
      setActionErrorMessage(`Export failed: ${err.message || err}`);
    } finally {
      setIsProcessing(false);
    }
  };

  const handleImportJSONBackup = async (file: File) => {
    if (!file) return;
    triggerHaptic("medium");
    setIsProcessing(true);
    setActionSuccessTitle("Operation Complete");
    setActionSuccessMessage("");
    setActionErrorMessage("");
    setLastExportedBackup(null);
    try {
      const text = await file.text();
      const parsed = JSON.parse(text);

      const backupObj = Array.isArray(parsed)
        ? { products: parsed }
        : parsed || {};

      if (
        !Array.isArray(backupObj.products) &&
        !backupObj.product_buy_prices &&
        !backupObj.productBuyPrices &&
        !Array.isArray(backupObj.bills) &&
        !Array.isArray(backupObj.transactions) &&
        !Array.isArray(backupObj.receipts) &&
        !Array.isArray(backupObj.other_costs) &&
        !Array.isArray(backupObj.otherCosts) &&
        !Array.isArray(backupObj.settings) &&
        !Array.isArray(backupObj.activity_logs) &&
        !Array.isArray(backupObj.activityLogs) &&
        !Array.isArray(backupObj.sync_conflicts) &&
        !Array.isArray(backupObj.syncConflicts) &&
        !Array.isArray(backupObj.z_reports)
      ) {
        throw new Error(
          "Invalid backup file format. Expected JSON containing products, buy prices, bills, Z-reports, other_costs, settings, activity_logs, or sync_conflicts."
        );
      }

      const result = await restoreFullSystemData(backupObj);

      if (user) {
        await logActivity(
          "backup",
          `Imported JSON backup file. Products: ${result.importedProducts} (${result.buyPricesCount} buy prices), Bills: ${result.importedBills} (${result.zReportsCount} Z-report days), Other Costs: ${result.importedOtherCosts}, Activity Logs: ${result.importedActivityLogs}, Accounts: ${result.restoredAccountsCount}.`,
          user.uid,
          user.displayName || "Admin",
          user.email || ""
        );
      }

      triggerHaptic("success");
      setActionSuccessTitle("Backup Restored");
      setActionSuccessMessage(
        `Restored ${result.importedProducts} products (${result.buyPricesCount} buy prices), ${result.importedBills} bills (${result.zReportsCount} Z-report days), ${result.importedOtherCosts} expenses, ${result.importedActivityLogs} activity logs & ${result.restoredAccountsCount} accounts.`
      );
    } catch (err: any) {
      console.warn("Failed to import backup:", err);
      setActionErrorMessage(`Import failed: ${err.message || err}`);
    } finally {
      setIsProcessing(false);
    }
  };

  const handleDirectDatabaseCopy = async (oldDatabaseId: string) => {
    const rawTrimmed = oldDatabaseId.trim();
    const currentDatabaseId = appletConfig.firestoreDatabaseId || "";

    setLastExportedBackup(null);

    if (!rawTrimmed) {
      triggerHaptic("light");
      setActionSuccessTitle("Enter Database ID");
      setActionSuccessMessage(
        "Please paste or enter a source Database ID to sync records from another database."
      );
      return;
    }

    triggerHaptic("heavy");
    setIsProcessing(true);
    setActionSuccessTitle("Operation Complete");
    setActionSuccessMessage("");
    setActionErrorMessage("");

    try {
      // If the user pasted a JSON backup directly into the Database ID input, restore it directly!
      if (rawTrimmed.startsWith("{") || rawTrimmed.startsWith("[")) {
        const parsedJson = JSON.parse(rawTrimmed);
        const res = await restoreFullSystemData(parsedJson);
        triggerHaptic("success");
        setActionSuccessTitle("Database Synced");
        setActionSuccessMessage(
          `Recovered ${res.importedProducts} products (${res.buyPricesCount} buy prices), ${res.importedBills} bills (${res.zReportsCount} Z-report days), ${res.importedOtherCosts} expenses, ${res.importedActivityLogs} activity logs & ${res.restoredAccountsCount} accounts.`
        );
        return;
      }

      // Normalize the Database ID if the user pasted a URL or quoted string
      let trimmedId = rawTrimmed.replace(/^["']+|["']+$/g, "").trim();
      const dbMatch = trimmedId.match(/databases\/([^/?#\s]+)/i);
      if (dbMatch && dbMatch[1]) {
        trimmedId = decodeURIComponent(dbMatch[1]);
      }
      if (appletConfig.projectId && trimmedId === appletConfig.projectId) {
        trimmedId = currentDatabaseId;
      }

      // Helper to parse Firestore REST API value format when falling back to HTTP REST
      const parseRestValue = (valObj: any): any => {
        if (!valObj || typeof valObj !== "object") return null;
        if ("stringValue" in valObj) return valObj.stringValue;
        if ("integerValue" in valObj) return Number(valObj.integerValue);
        if ("doubleValue" in valObj) return Number(valObj.doubleValue);
        if ("booleanValue" in valObj) return Boolean(valObj.booleanValue);
        if ("nullValue" in valObj) return null;
        if ("timestampValue" in valObj) return valObj.timestampValue;
        if ("arrayValue" in valObj) {
          return (valObj.arrayValue?.values || []).map(parseRestValue);
        }
        if ("mapValue" in valObj) {
          const out: Record<string, any> = {};
          const fields = valObj.mapValue?.fields || {};
          for (const [k, v] of Object.entries(fields)) {
            out[k] = parseRestValue(v);
          }
          return out;
        }
        return null;
      };

      let idToken = "";
      try {
        if (user && typeof (user as any).getIdToken === "function") {
          idToken = await (user as any).getIdToken();
        }
      } catch {}

      const fetchViaRestFallback = async (
        projectId: string,
        databaseId: string,
        apiKey: string,
        collName: string
      ): Promise<Array<{ id: string; data: Record<string, any> }>> => {
        const results: Array<{ id: string; data: Record<string, any> }> = [];
        let pageToken = "";
        for (let page = 0; page < 5; page++) {
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), 7000);
          try {
            const baseUrl = `https://firestore.googleapis.com/v1/projects/${encodeURIComponent(
              projectId
            )}/databases/${encodeURIComponent(databaseId)}/documents/${encodeURIComponent(
              collName
            )}?pageSize=400&key=${encodeURIComponent(apiKey)}${
              pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ""
            }`;
            let res = await fetch(baseUrl, {
              signal: controller.signal,
              headers: idToken ? { Authorization: `Bearer ${idToken}` } : undefined,
            });
            if (!res.ok && idToken) {
              res = await fetch(baseUrl, { signal: controller.signal });
            }
            if (!res.ok) break;
            const json = await res.json();
            const docs = Array.isArray(json.documents) ? json.documents : [];
            docs.forEach((d: any) => {
              const parts = String(d.name || "").split("/");
              const id = parts[parts.length - 1] || `${collName}_${Date.now()}`;
              const data: Record<string, any> = {};
              const fields = d.fields || {};
              for (const [k, v] of Object.entries(fields)) {
                data[k] = parseRestValue(v);
              }
              results.push({ id, data });
            });
            if (json.nextPageToken) {
              pageToken = String(json.nextPageToken);
            } else {
              break;
            }
          } catch {
            break;
          } finally {
            clearTimeout(timer);
          }
        }
        return results;
      };

      const targetDbId = trimmedId;
      const isSameDb = targetDbId === currentDatabaseId;

      const { initializeApp: initApp, getApps: gApps, deleteApp: dApp } = await import("firebase/app");
      const {
        initializeFirestore: initFirestore,
        getFirestore: gFirestore,
        collection: fCollection,
        getDocs: fGetDocs,
      } = await import("firebase/firestore");

      // Prefer primary `app` instance first so current Firebase Auth credentials (`request.auth`) are automatically attached
      let primaryTargetDb: any = null;
      let legacyApp: any = null;
      let secondaryTargetDb: any = null;

      if (isSameDb) {
        primaryTargetDb = db;
      } else {
        try {
          primaryTargetDb = gFirestore(app, targetDbId);
        } catch {}

        const externalConfig = {
          projectId: appletConfig.projectId,
          appId: appletConfig.appId,
          apiKey: appletConfig.apiKey,
          authDomain: appletConfig.authDomain,
          firestoreDatabaseId: targetDbId,
          storageBucket: appletConfig.storageBucket,
          messagingSenderId: appletConfig.messagingSenderId,
        };

        const existingApp = gApps().find((a) => a.name === "legacy-import-app");
        if (existingApp) {
          try {
            await dApp(existingApp);
          } catch {}
        }
        legacyApp = initApp(externalConfig, "legacy-import-app");
        try {
          secondaryTargetDb = initFirestore(
            legacyApp,
            { experimentalForceLongPolling: true },
            targetDbId
          );
        } catch {
          secondaryTargetDb = gFirestore(legacyApp, targetDbId);
        }
      }

      const fetchCollectionDocs = async (
        collName: string
      ): Promise<Array<{ id: string; data: Record<string, any> }>> => {
        const mergedDocs = new Map<string, { id: string; data: Record<string, any> }>();

        // 1. Try authenticated primary app Firestore instance
        if (primaryTargetDb) {
          try {
            const snap = await Promise.race([
              fGetDocs(fCollection(primaryTargetDb, collName)),
              new Promise<never>((_, reject) =>
                setTimeout(() => reject(new Error("Primary SDK timeout")), 5000)
              ),
            ]);
            snap.docs.forEach((d: any) => {
              mergedDocs.set(d.id, { id: d.id, data: d.data() });
            });
          } catch {}
        }

        // 2. If empty and secondary long-polling instance exists, try secondary SDK instance
        if (mergedDocs.size === 0 && secondaryTargetDb) {
          try {
            const snap = await Promise.race([
              fGetDocs(fCollection(secondaryTargetDb, collName)),
              new Promise<never>((_, reject) =>
                setTimeout(() => reject(new Error("Secondary SDK timeout")), 5000)
              ),
            ]);
            snap.docs.forEach((d: any) => {
              mergedDocs.set(d.id, { id: d.id, data: d.data() });
            });
          } catch {}
        }

        // 3. Also query REST API fallback if SDK returned 0 docs
        if (mergedDocs.size === 0) {
          const restDocs = await fetchViaRestFallback(
            appletConfig.projectId,
            targetDbId,
            appletConfig.apiKey,
            collName
          );
          restDocs.forEach((d) => {
            mergedDocs.set(d.id, d);
          });
        }

        return Array.from(mergedDocs.values());
      };

      const [
        productsDocs,
        billsDocs,
        otherCostsDocs,
        settingsDocs,
        activityLogsDocs,
        syncConflictsDocs,
      ] = await Promise.all([
        fetchCollectionDocs("products"),
        fetchCollectionDocs("bills"),
        fetchCollectionDocs("other_costs"),
        fetchCollectionDocs("settings"),
        fetchCollectionDocs("activity_logs"),
        fetchCollectionDocs("sync_conflicts"),
      ]);

      if (legacyApp) {
        try {
          await dApp(legacyApp);
        } catch {}
      }

      // Check if there is also a local snapshot saved for this Database ID (e.g. from Copy ID or Export)
      let localDbSnapshot: any = null;
      try {
        const rawSnap =
          localStorage.getItem(`db_snapshot_${targetDbId}`) ||
          (isSameDb ? localStorage.getItem("latest_full_snapshot_v1") : null);
        if (rawSnap) {
          localDbSnapshot = JSON.parse(rawSnap);
        }
      } catch {}

      const mergeById = (
        cloudDocs: Array<{ id: string; data: Record<string, any> }>,
        snapList?: any[]
      ) => {
        const map = new Map<string, any>();
        if (Array.isArray(snapList)) {
          snapList.forEach((item: any, idx: number) => {
            if (!item || typeof item !== "object") return;
            const key = String(item.id || `snap_${idx}`);
            map.set(key, { ...item, id: key });
          });
        }
        cloudDocs.forEach((d) => {
          const existing = map.get(d.id) || {};
          const merged = { ...existing, ...d.data, id: d.id };
          // Preserve costPrice and FIFO costBatches if existing snapshot had them and cloud doc omitted them
          if (merged.costPrice === undefined && existing.costPrice !== undefined) {
            merged.costPrice = existing.costPrice;
          }
          if (
            (!Array.isArray(merged.costBatches) || merged.costBatches.length === 0) &&
            Array.isArray(existing.costBatches) &&
            existing.costBatches.length > 0
          ) {
            merged.costBatches = existing.costBatches;
          }
          map.set(d.id, merged);
        });
        return Array.from(map.values());
      };

      const combinedPayload = {
        products: mergeById(productsDocs, localDbSnapshot?.products),
        product_buy_prices: localDbSnapshot?.product_buy_prices || {},
        bills: mergeById(billsDocs, localDbSnapshot?.bills),
        other_costs: mergeById(otherCostsDocs, localDbSnapshot?.other_costs),
        settings: mergeById(settingsDocs, localDbSnapshot?.settings),
        activity_logs: mergeById(activityLogsDocs, localDbSnapshot?.activity_logs),
        sync_conflicts: mergeById(syncConflictsDocs, localDbSnapshot?.sync_conflicts),
        z_reports: localDbSnapshot?.z_reports || [],
        adminPin: localDbSnapshot?.adminPin,
      };

      const result = await restoreFullSystemData(combinedPayload);

      if (
        result.importedProducts === 0 &&
        result.importedBills === 0 &&
        result.importedOtherCosts === 0 &&
        result.importedSettings === 0 &&
        result.importedActivityLogs === 0 &&
        result.importedSyncConflicts === 0
      ) {
        triggerHaptic("light");
        setActionSuccessTitle("No Records Found");
        setActionSuccessMessage(
          "No records were found in that source Database ID, or it is currently empty."
        );
        return;
      }

      if (user) {
        await logActivity(
          "backup",
          `Direct database sync from "${trimmedId}". Products: ${result.importedProducts} (${result.buyPricesCount} buy prices), Bills: ${result.importedBills} (${result.zReportsCount} Z-report days), Other Costs: ${result.importedOtherCosts}, Activity Logs: ${result.importedActivityLogs}, Accounts: ${result.restoredAccountsCount}.`,
          user.uid,
          user.displayName || "Admin",
          user.email || ""
        );
      }

      triggerHaptic("success");
      setActionSuccessTitle("Database Synced");
      setActionSuccessMessage(
        `Recovered ${result.importedProducts} products (${result.buyPricesCount} buy prices), ${result.importedBills} bills (${result.zReportsCount} Z-report days), ${result.importedOtherCosts} expenses, ${result.importedActivityLogs} activity logs & ${result.restoredAccountsCount} accounts.`
      );
    } catch (err: any) {
      console.warn("Direct cloud copy warning:", err);
      setActionErrorMessage(
        `Recovery failed: ${err.message || err}. Please verify the source Database ID or use Complete Snapshot (JSON).`
      );
    } finally {
      setIsProcessing(false);
    }
  };

  const handleSaveAccount = async () => {
    if (!editingAccount) return;
    const isSelfEdit =
      editingAccount.uid === user?.uid ||
      (Array.isArray(editingAccount.allUids) &&
        Boolean(user?.uid && editingAccount.allUids.includes(user.uid))) ||
      String(editingAccount.email || "").trim().toLowerCase() === "suman.das.199972@gmail.com";
    const safeEditIsAdmin = isSelfEdit
      ? true
      : !isRealAdmin
      ? Boolean(editingAccount.isAdmin)
      : editIsAdmin;

    const trimmedName = editName.trim();
    const trimmedPhoto = (editPhoto || "").trim();
    const origName = (editingAccount.displayName || "").trim();
    const origPhoto = (editingAccount.customPhotoURL || "").trim();
    const origAdmin = Boolean(editingAccount.isAdmin);

    const hasAccountChanges =
      trimmedName.length > 0 &&
      (trimmedName !== origName ||
        trimmedPhoto !== origPhoto ||
        safeEditIsAdmin !== origAdmin);

    if (!hasAccountChanges) return;

    triggerHaptic("medium");
    setIsProcessing(true);
    try {
      if ((!isAuthenticated && !isAdmin) || !isRealAdmin) {
        throw new Error(
          "Action Denied: Only permanent Administrators can modify user accounts or roles."
        );
      }

      const targetUids: string[] =
        Array.isArray(editingAccount.allUids) && editingAccount.allUids.length > 0
          ? editingAccount.allUids
          : [editingAccount.uid];

      const preservedEmail = editingAccount.email || "No Email provided";

      // Update local state immediately for instant feedback
      setAccounts((prev) => {
        const nextList = prev.map((acc) =>
          acc.uid === editingAccount.uid
            ? {
                ...acc,
                displayName: trimmedName,
                customPhotoURL: trimmedPhoto,
                email: preservedEmail,
                isAdmin: safeEditIsAdmin,
                role: safeEditIsAdmin ? "admin" : "user",
                failedCount: safeEditIsAdmin ? 0 : acc.failedCount,
                lockedByAdmin: safeEditIsAdmin ? false : acc.lockedByAdmin,
                updatedAt: Date.now(),
              }
            : acc
        );
        try {
          localStorage.setItem("admin_cached_accounts", JSON.stringify(nextList));
        } catch {}
        return nextList;
      });

      // Queue writes in persistent local cache and sync in background
      Promise.all(
        targetUids.map((tUid) => {
          const profileRef = doc(db, "settings", `profile_${tUid}`);
          return setDoc(
            profileRef,
            {
              uid: tUid,
              displayName: trimmedName,
              customPhotoURL: trimmedPhoto,
              email: preservedEmail,
              isAdmin: safeEditIsAdmin,
              role: safeEditIsAdmin ? "admin" : "user",
              tempAdminAuth: false,
              updatedAt: Date.now(),
            },
            { merge: true }
          );
        })
      ).catch((e) => console.warn("Background save account warning:", e));

      // Log the profile update and/or privilege change
      if (user) {
        if (editingAccount.isAdmin !== safeEditIsAdmin) {
          logActivity(
            "privilege_change",
            `Changed role of "${trimmedName}" to ${
              safeEditIsAdmin ? "Admin" : "Standard User"
            }.`,
            user.uid,
            user.displayName || "Admin",
            user.email || ""
          ).catch(() => {});
        } else {
          logActivity(
            "admin_update_profile",
            `Updated profile/settings for user "${trimmedName}".`,
            user.uid,
            user.displayName || "Admin",
            user.email || ""
          ).catch(() => {});
        }
      }

      // If we are making them an admin, reset their failed login attempts across all their UIDs
      if (editIsAdmin) {
        Promise.all(
          targetUids.map((tUid) =>
            setDoc(
              doc(db, "settings", `attempts_${tUid}`),
              { failedCount: 0, lockedByAdmin: false, reason: "reset" },
              { merge: true }
            )
          )
        ).catch(() => {});
      }

      if (user && targetUids.includes(user.uid)) {
        localStorage.setItem(`custom_user_photo_${user.uid}`, trimmedPhoto);
        if (safeEditIsAdmin) {
          localStorage.setItem(`is_admin_cached_${user.uid}`, "true");
          localStorage.setItem(`is_real_admin_cached_${user.uid}`, "true");
          localStorage.removeItem("tempAdminAuth");
          localStorage.removeItem(`tempAdminAuth_${user.uid}`);
        } else {
          localStorage.setItem(`is_admin_cached_${user.uid}`, "false");
          localStorage.setItem(`is_real_admin_cached_${user.uid}`, "false");
        }
      } else {
        targetUids.forEach((tUid) => {
          localStorage.setItem(
            `is_admin_cached_${tUid}`,
            safeEditIsAdmin ? "true" : "false"
          );
          localStorage.setItem(
            `is_real_admin_cached_${tUid}`,
            safeEditIsAdmin ? "true" : "false"
          );
        });
      }

      triggerHaptic("success");
      setActionSuccessTitle("Profile Updated");
      setActionSuccessMessage("User profile updated successfully.");
      setEditingAccount(null);
    } catch (err: any) {
      console.error("Failed to update user profile:", err);
      setActionErrorMessage(
        `Error updating user profile: ${err.message || err}`
      );
    } finally {
      setIsProcessing(false);
    }
  };

  const handleResetAttempts = async (uid: string) => {
    if ((!isAuthenticated && !isAdmin) || !isRealAdmin) {
      setActionErrorMessage(
        "Error: Only permanent Administrators can modify access lock status."
      );
      return;
    }
    const targetAccount = accounts.find((a) => a.uid === uid);
    if (targetAccount?.isBlocked) {
      setActionErrorMessage(
        "Action Denied: Blocked accounts cannot be unlocked or locked until unblocked."
      );
      return;
    }
    triggerHaptic("success");
    setIsProcessing(true);
    try {
      const targetUids: string[] =
        Array.isArray(targetAccount?.allUids) && targetAccount.allUids.length > 0
          ? targetAccount.allUids
          : [uid];

      setAccounts((prev) => {
        const nextList = prev.map((a) =>
          a.uid === uid ? { ...a, failedCount: 0, lockedByAdmin: false } : a
        );
        try {
          localStorage.setItem("admin_cached_accounts", JSON.stringify(nextList));
        } catch {}
        return nextList;
      });

      Promise.all(
        targetUids.map((tUid) =>
          setDoc(
            doc(db, "settings", `attempts_${tUid}`),
            { failedCount: 0, lockedByAdmin: false, reason: "reset" },
            { merge: true }
          )
        )
      ).catch((e) => console.warn("Background unlock warning:", e));

      if (user) {
        const targetName =
          targetAccount?.displayName || targetAccount?.email || "User";
        logActivity(
          "admin_reset_attempts",
          `Restored admin access / unlocked user "${targetName}".`,
          user.uid,
          user.displayName || "Admin",
          user.email || ""
        ).catch(() => {});
      }
      setActionSuccessTitle("Account Unlocked");
      setActionSuccessMessage("User account unlocked.");
    } catch (err: any) {
      console.error("Failed to reset attempts:", err);
      setActionErrorMessage(
        `Error unlocking account: ${err.message || err}`
      );
    } finally {
      setIsProcessing(false);
    }
  };

  const handleLockAccount = async (uid: string) => {
    if ((!isAuthenticated && !isAdmin) || !isRealAdmin) {
      setActionErrorMessage(
        "Error: Only permanent Administrators can modify access lock status."
      );
      return;
    }
    const targetAccount = accounts.find((a) => a.uid === uid);
    if (
      uid === user?.uid ||
      targetAccount?.allUids?.includes(user?.uid) ||
      targetAccount?.isAdmin
    ) {
      setActionErrorMessage(
        "Action Denied: Administrator accounts cannot be locked."
      );
      return;
    }
    if (targetAccount?.isBlocked) {
      setActionErrorMessage(
        "Action Denied: Blocked accounts cannot be locked."
      );
      return;
    }
    triggerHaptic("heavy");
    setIsProcessing(true);
    try {
      const targetUids: string[] =
        Array.isArray(targetAccount?.allUids) && targetAccount.allUids.length > 0
          ? targetAccount.allUids
          : [uid];

      setAccounts((prev) => {
        const nextList = prev.map((a) =>
          a.uid === uid ? { ...a, failedCount: 3, lockedByAdmin: true } : a
        );
        try {
          localStorage.setItem("admin_cached_accounts", JSON.stringify(nextList));
        } catch {}
        return nextList;
      });

      Promise.all(
        targetUids.map((tUid) =>
          setDoc(
            doc(db, "settings", `attempts_${tUid}`),
            { failedCount: 3, lockedByAdmin: true, reason: "admin_lock" },
            { merge: true }
          )
        )
      ).catch((e) => console.warn("Background lock warning:", e));

      if (user) {
        const targetName =
          targetAccount?.displayName || targetAccount?.email || "User";
        logActivity(
          "admin_lock_account",
          `Manually locked admin access for user "${targetName}".`,
          user.uid,
          user.displayName || "Admin",
          user.email || ""
        ).catch(() => {});
      }
      setActionSuccessTitle("Access Locked");
      setActionSuccessMessage("User admin access locked.");
    } catch (err: any) {
      console.error("Failed to lock account:", err);
      setActionErrorMessage(`Error locking account: ${err.message || err}`);
    } finally {
      setIsProcessing(false);
    }
  };

  const handleToggleAdmin = async (uid: string, currentIsAdmin: boolean) => {
    triggerHaptic("medium");
    setIsProcessing(true);
    try {
      if (!isAuthenticated && !isAdmin) {
        throw new Error(
          "Action Denied: You must be authenticated as an Administrator to grant or revoke Admin role privileges."
        );
      }
      if (!isRealAdmin) {
        throw new Error(
          "Action Denied: Temporary PIN sessions cannot permanently modify Administrator roles."
        );
      }
      const targetAccount = accounts.find((a) => a.uid === uid);
      if (
        (uid === user?.uid || targetAccount?.allUids?.includes(user?.uid)) &&
        currentIsAdmin
      ) {
        throw new Error("Action Denied: You cannot demote your own account.");
      }

      const newIsAdmin = !currentIsAdmin;
      const targetUids: string[] =
        Array.isArray(targetAccount?.allUids) && targetAccount.allUids.length > 0
          ? targetAccount.allUids
          : [uid];

      // Immediately update local accounts list and cache
      setAccounts((prev) => {
        const nextList = prev.map((acc) =>
          acc.uid === uid
            ? {
                ...acc,
                isAdmin: newIsAdmin,
                role: newIsAdmin ? "admin" : "user",
                failedCount: newIsAdmin ? 0 : acc.failedCount,
                lockedByAdmin: newIsAdmin ? false : acc.lockedByAdmin,
                updatedAt: Date.now(),
              }
            : acc
        );
        try {
          localStorage.setItem("admin_cached_accounts", JSON.stringify(nextList));
        } catch {}
        return nextList;
      });

      Promise.all(
        targetUids.map((tUid) =>
          setDoc(
            doc(db, "settings", `profile_${tUid}`),
            {
              isAdmin: newIsAdmin,
              role: newIsAdmin ? "admin" : "user",
              tempAdminAuth: false,
              updatedAt: Date.now(),
            },
            { merge: true }
          )
        )
      ).catch((e) => console.warn("Background role update warning:", e));

      // Log the privilege change
      const targetName = targetAccount?.displayName || "User";
      logActivity(
        "privilege_change",
        `Changed role of "${targetName}" to ${
          newIsAdmin ? "Admin" : "Standard User"
        }.`,
        user?.uid || "",
        user?.displayName || "Admin",
        user?.email || ""
      ).catch(() => {});

      // If promoting, reset failedCount to ensure they aren't locked out
      if (newIsAdmin) {
        Promise.all(
          targetUids.map((tUid) =>
            setDoc(
              doc(db, "settings", `attempts_${tUid}`),
              { failedCount: 0, lockedByAdmin: false, reason: "reset" },
              { merge: true }
            )
          )
        ).catch(() => {});
      }

      targetUids.forEach((tUid) => {
        if (newIsAdmin) {
          localStorage.setItem(`is_admin_cached_${tUid}`, "true");
          localStorage.setItem(`is_real_admin_cached_${tUid}`, "true");
          localStorage.removeItem("tempAdminAuth");
          localStorage.removeItem(`tempAdminAuth_${tUid}`);
        } else {
          localStorage.setItem(`is_admin_cached_${tUid}`, "false");
          localStorage.setItem(`is_real_admin_cached_${tUid}`, "false");
          localStorage.removeItem("tempAdminAuth");
          localStorage.removeItem(`tempAdminAuth_${tUid}`);
        }
      });

      setActionSuccessTitle(newIsAdmin ? "Admin Granted" : "Admin Revoked");
      setActionSuccessMessage(
        `Successfully ${
          newIsAdmin
            ? "promoted user to Admin"
            : "demoted user to standard User"
        }.`
      );
    } catch (err: any) {
      console.error("Failed to toggle admin role:", err);
      setActionErrorMessage(`Error updating role: ${err.message || err}`);
    } finally {
      setIsProcessing(false);
    }
  };

  const handleToggleBlockAccount = async (targetAccount: any) => {
    if ((!isAuthenticated && !isAdmin) || !isRealAdmin) {
      setActionErrorMessage(
        "Action Denied: Only permanent Administrators can block or unblock user accounts."
      );
      return;
    }
    if (
      !targetAccount ||
      targetAccount.uid === user?.uid ||
      targetAccount.allUids?.includes(user?.uid) ||
      targetAccount.isAdmin ||
      String(targetAccount.email || "").trim().toLowerCase() === "suman.das.199972@gmail.com"
    ) {
      setActionErrorMessage(
        "Action Denied: Administrator accounts cannot be blocked."
      );
      return;
    }

    const nextBlocked = !targetAccount.isBlocked;
    triggerHaptic(nextBlocked ? "heavy" : "success");
    setIsProcessing(true);

    try {
      const targetUids: string[] =
        Array.isArray(targetAccount.allUids) && targetAccount.allUids.length > 0
          ? targetAccount.allUids
          : [targetAccount.uid];
      const normEmail =
        targetAccount.email && targetAccount.email !== "No Email provided"
          ? String(targetAccount.email).trim().toLowerCase()
          : "";

      setAccounts((prev) => {
        const nextList = prev.map((a) =>
          a.uid === targetAccount.uid
            ? {
                ...a,
                isBlocked: nextBlocked,
                ...(nextBlocked ? { failedCount: 0, lockedByAdmin: false } : {}),
                isOnline: nextBlocked ? false : a.isOnline,
                updatedAt: Date.now(),
              }
            : a
        );
        try {
          localStorage.setItem("admin_cached_accounts", JSON.stringify(nextList));
        } catch {}
        return nextList;
      });
      setEditingAccount((prev: any) =>
        prev && prev.uid === targetAccount.uid
          ? {
              ...prev,
              isBlocked: nextBlocked,
              ...(nextBlocked ? { failedCount: 0, lockedByAdmin: false } : {}),
              isOnline: nextBlocked ? false : prev.isOnline,
            }
          : prev
      );

      const blockedDocRef = doc(db, "settings", "blocked_accounts");
      const blockedSnap = await getDocFromServer(blockedDocRef)
        .catch(() => getDoc(blockedDocRef))
        .catch(() => null);
      const existingData = blockedSnap?.exists() ? blockedSnap.data() : {};
      const currentUids = new Set<string>(
        Array.isArray(existingData?.blockedUids) ? existingData.blockedUids : []
      );
      const currentEmails = new Set<string>(
        Array.isArray(existingData?.blockedEmails) ? existingData.blockedEmails : []
      );

      if (nextBlocked) {
        targetUids.forEach((id) => currentUids.add(id));
        if (normEmail) currentEmails.add(normEmail);
      } else {
        targetUids.forEach((id) => {
          currentUids.delete(id);
          localStorage.removeItem(`is_blocked_cached_${id}`);
        });
        if (normEmail) currentEmails.delete(normEmail);
      }

      await Promise.all([
        setDoc(blockedDocRef, {
          blockedUids: Array.from(currentUids),
          blockedEmails: Array.from(currentEmails),
          updatedAt: Date.now(),
        }),
        ...targetUids.map((tUid) =>
          setDoc(
            doc(db, "settings", `profile_${tUid}`),
            {
              isBlocked: nextBlocked,
              blockedAt: nextBlocked ? Date.now() : null,
              ...(nextBlocked ? { isOnline: false } : {}),
              updatedAt: Date.now(),
            },
            { merge: true }
          )
        ),
        ...(nextBlocked
          ? targetUids.map((tUid) =>
              setDoc(
                doc(db, "settings", `attempts_${tUid}`),
                { failedCount: 0, lockedByAdmin: false, reason: "reset" },
                { merge: true }
              )
            )
          : []),
      ]);

      if (user) {
        const targetName =
          targetAccount.displayName || targetAccount.email || "User";
        logActivity(
          "privilege_change",
          `${nextBlocked ? "Blocked" : "Unblocked"} user account "${targetName}" (${targetAccount.email}).`,
          user.uid,
          user.displayName || "Admin",
          user.email || ""
        ).catch(() => {});
      }

      setActionSuccessTitle(nextBlocked ? "Account Blocked" : "Account Unblocked");
      setActionSuccessMessage(
        nextBlocked
          ? `"${targetAccount.displayName || targetAccount.email}" has been blocked and cannot log in to the app.`
          : `"${targetAccount.displayName || targetAccount.email}" has been unblocked and can now log in again.`
      );
    } catch (err: any) {
      console.error("Failed to toggle block status:", err);
      setActionErrorMessage(
        `Error updating block status: ${err.message || err}`
      );
    } finally {
      setIsProcessing(false);
    }
  };

  const handleDeleteUserAccount = async () => {
    if (!accountToDelete || isDeletingAccount) return;
    if ((!isAuthenticated && !isAdmin) || !isRealAdmin) {
      setActionErrorMessage(
        "Action Denied: Only permanent Administrators can delete user accounts."
      );
      return;
    }
    const targetAccount = accountToDelete;
    if (
      targetAccount.uid === user?.uid ||
      targetAccount.allUids?.includes(user?.uid) ||
      targetAccount.isAdmin ||
      String(targetAccount.email || "").trim().toLowerCase() === "suman.das.199972@gmail.com"
    ) {
      setActionErrorMessage(
        "Action Denied: Administrator accounts cannot be deleted. Revoke Admin role first if needed."
      );
      return;
    }

    triggerHaptic("heavy");
    setIsDeletingAccount(true);
    setIsProcessing(true);

    try {
      const targetUids: string[] =
        Array.isArray(targetAccount.allUids) && targetAccount.allUids.length > 0
          ? targetAccount.allUids
          : [targetAccount.uid];
      const normEmail =
        targetAccount.email && targetAccount.email !== "No Email provided"
          ? String(targetAccount.email).trim().toLowerCase()
          : "";

      const maxExistingTs = Math.max(
        Number(targetAccount.recreatedAt) || 0,
        Number(targetAccount.updatedAt) || 0
      );
      const now = Math.max(Date.now(), maxExistingTs + 1000);
      targetUids.forEach((id) => {
        deletedAccountTimestampsRef.current.set(id, now);
      });

      // Immediately remove from UI and local cache
      setAccounts((prev) => {
        const nextList = prev.filter(
          (a) =>
            a.uid !== targetAccount.uid &&
            !targetUids.includes(a.uid) &&
            (!normEmail || String(a.email || "").trim().toLowerCase() !== normEmail)
        );
        try {
          localStorage.setItem("admin_cached_accounts", JSON.stringify(nextList));
        } catch {}
        return nextList;
      });
      setAccountToDelete(null);

      // Scan fresh server settings collection for any matching profile_* or attempts_* docs by UID or email,
      // and also remove from blocked_accounts so they can register a brand-new account cleanly
      const snap = await getDocsFromServer(collection(db, "settings")).catch(() =>
        getDocs(collection(db, "settings"))
      );
      const batch = writeBatch(db);
      const matchedUids = new Set<string>(targetUids);

      snap.docs.forEach((d) => {
        if (d.id.startsWith("profile_")) {
          const docUid = d.id.replace("profile_", "");
          const docEmail = String(d.data()?.email || "").trim().toLowerCase();
          if (
            matchedUids.has(docUid) ||
            (Boolean(normEmail) && docEmail === normEmail)
          ) {
            matchedUids.add(docUid);
            deletedAccountTimestampsRef.current.set(docUid, now);
            batch.delete(d.ref);
          }
        }
      });

      snap.docs.forEach((d) => {
        if (d.id.startsWith("attempts_")) {
          const docUid = d.id.replace("attempts_", "");
          if (matchedUids.has(docUid)) {
            batch.delete(d.ref);
          }
        }
      });

      // Ensure direct refs for all matchedUids are deleted and local cache keys are cleared
      matchedUids.forEach((id) => {
        batch.delete(doc(db, "settings", `profile_${id}`));
        batch.delete(doc(db, "settings", `attempts_${id}`));
        localStorage.removeItem(`is_blocked_cached_${id}`);
        localStorage.removeItem(`custom_user_photo_${id}`);
        localStorage.removeItem(`is_admin_cached_${id}`);
        localStorage.removeItem(`is_real_admin_cached_${id}`);
      });

      // Unconditionally update blocked_accounts (WITHOUT merge:true) so any prior ban for these UIDs or email is removed
      const blockedDocSnap = snap.docs.find((d) => d.id === "blocked_accounts");
      const bData = blockedDocSnap ? blockedDocSnap.data() : {};
      const nextBlockedUids = (
        Array.isArray(bData?.blockedUids) ? bData.blockedUids : []
      ).filter((id: string) => !matchedUids.has(id));
      const nextBlockedEmails = (
        Array.isArray(bData?.blockedEmails) ? bData.blockedEmails : []
      ).filter((em: string) => !normEmail || String(em).trim().toLowerCase() !== normEmail);
      batch.set(doc(db, "settings", "blocked_accounts"), {
        blockedUids: nextBlockedUids,
        blockedEmails: nextBlockedEmails,
        updatedAt: now,
      });

      // Record deletion timestamp in settings/deleted_accounts (WITHOUT merge:true so map keys are authoritative)
      const deletedDocSnap = snap.docs.find((d) => d.id === "deleted_accounts");
      const existingDelData = deletedDocSnap ? deletedDocSnap.data() : {};
      const nextDeletedUids: Record<string, number> =
        existingDelData?.deletedUids && typeof existingDelData.deletedUids === "object"
          ? { ...existingDelData.deletedUids }
          : {};
      const nextDeletedEmails: Record<string, number> =
        existingDelData?.deletedEmails && typeof existingDelData.deletedEmails === "object"
          ? { ...existingDelData.deletedEmails }
          : {};
      matchedUids.forEach((id) => {
        nextDeletedUids[id] = now;
      });
      if (normEmail) {
        nextDeletedEmails[normEmail] = now;
      }
      batch.set(doc(db, "settings", "deleted_accounts"), {
        deletedUids: nextDeletedUids,
        deletedEmails: nextDeletedEmails,
        updatedAt: now,
      });

      await batch.commit();

      if (user) {
        const targetName =
          targetAccount.displayName || targetAccount.email || "User";
        logActivity(
          "privilege_change",
          `Permanently deleted user account "${targetName}" (${targetAccount.email}) from the database.`,
          user.uid,
          user.displayName || "Admin",
          user.email || ""
        ).catch(() => {});
      }

      triggerHaptic("success");
      setActionSuccessTitle("Account Deleted");
      setActionSuccessMessage(
        `"${targetAccount.displayName || targetAccount.email}" was permanently deleted from the database. They can sign in again to create a new account.`
      );
    } catch (err: any) {
      console.error("Failed to delete user account:", err);
      setActionErrorMessage(
        `Error deleting account: ${err.message || err}`
      );
    } finally {
      setIsDeletingAccount(false);
      setIsProcessing(false);
    }
  };

  const handleSetAuthenticated = (status: boolean) => {
    if (status) {
      sessionStorage.setItem("adminAuth", "true");
    } else {
      sessionStorage.removeItem("adminAuth");
    }
    setIsAuthenticated(status);
    window.dispatchEvent(new Event("adminAuthChanged"));
  };

  const handleExitAdmin = () => {
    triggerHaptic("light");
    sessionStorage.removeItem("adminAuth");
    localStorage.removeItem("tempAdminAuth");
    if (user) {
      localStorage.removeItem(`tempAdminAuth_${user.uid}`);
    }
    setIsAuthenticated(false);
    navigate("/");
  };

  const [logoutConfirm, setLogoutConfirm] = useState(false);
  const [deleteConfMode, setDeleteConfMode] = useState<
    "none" | "products" | "bills" | "other_costs"
  >("none");
  const [dangerConfirmText, setDangerConfirmText] = useState("");
  const [isProcessing, setIsProcessing] = useState(false);
  const [actionSuccessTitle, setActionSuccessTitle] = useState("Operation Complete");
  const [actionSuccessMessage, setActionSuccessMessage] = useState("");
  const [actionErrorMessage, setActionErrorMessage] = useState("");
  const [lastExportedBackup, setLastExportedBackup] = useState<{
    fileName: string;
    jsonString: string;
  } | null>(null);
  const [copiedBackupJson, setCopiedBackupJson] = useState(false);
  const [oldDatabaseIdInput, setOldDatabaseIdInput] = useState("");
  const [copiedDbId, setCopiedDbId] = useState(false);
  const jsonFileInputRef = useRef<HTMLInputElement>(null);

  const handleCopyCurrentDatabaseId = () => {
    const dbIdToCopy = appletConfig.firestoreDatabaseId || "";
    triggerHaptic("light");
    try {
      localStorage.setItem("last_copied_db_id", dbIdToCopy);
    } catch {}
    // Also capture a full background snapshot for this Database ID so pasting it later can recover 100% of records (including Buy Prices & Z-Reports)
    collectFullSystemSnapshot()
      .then((snap) => {
        try {
          if (dbIdToCopy) {
            localStorage.setItem(`db_snapshot_${dbIdToCopy}`, JSON.stringify(snap));
          }
          localStorage.setItem("latest_full_snapshot_v1", JSON.stringify(snap));
        } catch {}
        const lightweightSnap = {
          ...snap,
          products: (snap.products || []).map(({ image, ...rest }: any) => ({
            ...rest,
            image: typeof image === "string" && image.length < 2048 ? image : undefined,
          })),
        };
        setDoc(
          doc(db, "settings", "latest_full_snapshot"),
          sanitizeFirestoreData(lightweightSnap),
          { merge: true }
        ).catch(() => {});
      })
      .catch(() => {});
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(dbIdToCopy).catch(() => {
        const textArea = document.createElement("textarea");
        textArea.value = dbIdToCopy;
        textArea.style.position = "fixed";
        textArea.style.opacity = "0";
        document.body.appendChild(textArea);
        textArea.select();
        try {
          document.execCommand("copy");
        } catch {}
        document.body.removeChild(textArea);
      });
    } else {
      const textArea = document.createElement("textarea");
      textArea.value = dbIdToCopy;
      textArea.style.position = "fixed";
      textArea.style.opacity = "0";
      document.body.appendChild(textArea);
      textArea.select();
      try {
        document.execCommand("copy");
      } catch {}
      document.body.removeChild(textArea);
    }
    setCopiedDbId(true);
    setTimeout(() => setCopiedDbId(false), 2000);
  };

  const handlePasteDatabaseId = async () => {
    triggerHaptic("light");
    try {
      if (navigator.clipboard && navigator.clipboard.readText) {
        const clipText = await navigator.clipboard.readText();
        if (clipText && clipText.trim()) {
          setOldDatabaseIdInput(clipText.trim());
          return;
        }
      }
    } catch {}
    const fallbackCopied =
      localStorage.getItem("last_copied_db_id") ||
      appletConfig.firestoreDatabaseId ||
      "";
    if (fallbackCopied) {
      setOldDatabaseIdInput(fallbackCopied);
    }
  };

  const handleLogoutAllOtherSessions = async () => {
    if (!user) return;
    triggerHaptic("heavy");
    setLogoutConfirm(false);
    setActionSuccessTitle("Operation Complete");
    setActionSuccessMessage(
      "Logout signal broadcasted successfully to all non-admin instances."
    );
    try {
      const securityRef = doc(db, "settings", "security_status");
      await setDoc(securityRef, {
        forcedLogoutAt: Date.now(),
        adminUid: user.uid,
      });
      triggerHaptic("success");
    } catch (err) {
      console.error(err);
      triggerHaptic("error");
    }
  };

  const handleDeleteAllProducts = async () => {
    triggerHaptic("heavy");
    setDeleteConfMode("none");
    setDangerConfirmText("");
    setLastExportedBackup(null);

    // 1. Collect all known product IDs from live context before clearing
    const knownIds = new Set<string>();
    globalProducts.forEach((p) => {
      if (p.id) knownIds.add(p.id);
    });

    // 2. Optimistically clear UI & mark all current products as deleted in tombstone set + clear SQLite
    clearProductsOptimistic();
    await sqliteClearProducts().catch(() => {});

    setActionSuccessTitle("Operation Complete");
    setActionSuccessMessage("All database products dropped successfully.");

    try {
      const snap = await getDocs(collection(db, "products"));
      snap.docs.forEach((d) => knownIds.add(d.id));

      const allIds = Array.from(knownIds);
      if (allIds.length > 0) {
        for (let i = 0; i < allIds.length; i += 450) {
          const batchInstance = writeBatch(db);
          const chunk = allIds.slice(i, i + 450);
          chunk.forEach((id) => {
            batchInstance.delete(doc(db, "products", id));
          });
          await batchInstance.commit();
        }
      }
      localStorage.removeItem("local_products_fallback");
      await sqliteClearProducts().catch(() => {});
      await purgeStockAlertsForDeletedProducts(undefined, undefined, true).catch(() => {});

      if (user) {
        try {
          await logActivity(
            "purge_database",
            `Purged all inventory products from the database (Total ${allIds.length} products deleted).`,
            user.uid,
            user.displayName || "Admin",
            user.email || ""
          );
        } catch (err) {
          console.error("Failed to log purge activity:", err);
        }
      }
      triggerHaptic("success");
    } catch (err: any) {
      console.error(err);
      triggerHaptic("error");
      setActionErrorMessage(
        `Error purging products: ${
          err.message || err
        }. Ensure you have administrative Firestore permissions.`
      );
    }
  };

  const handleDeleteAllBills = async () => {
    triggerHaptic("heavy");
    setDeleteConfMode("none");
    setDangerConfirmText("");
    setLastExportedBackup(null);
    clearBillsOptimistic();
    await sqliteClearBills().catch(() => {});
    setActionSuccessTitle("Operation Complete");
    setActionSuccessMessage(
      "All POS transaction bills dropped successfully."
    );
    
    try {
      // 1. Fetch all bills
      const billsSnap = await getDocs(collection(db, "bills"));

      // 2. Delete all bills in chunks using writeBatch
      if (billsSnap.size > 0) {
        const docs = billsSnap.docs;
        for (let i = 0; i < docs.length; i += 500) {
          const batchInstance = writeBatch(db);
          const chunk = docs.slice(i, i + 500);
          chunk.forEach((docSnap) => {
            batchInstance.delete(doc(db, "bills", docSnap.id));
          });
          await batchInstance.commit();
        }
      }
      // Also delete any other_costs linked to bills (Udhar records)
      try {
        const costsSnap = await getDocs(collection(db, "other_costs"));
        const linkedCostDocs = costsSnap.docs.filter(
          (d) => d.id.startsWith("udhaar_bill_") || Boolean(d.data()?.linkedBillId)
        );
        for (let i = 0; i < linkedCostDocs.length; i += 500) {
          const batchInstance = writeBatch(db);
          const chunk = linkedCostDocs.slice(i, i + 500);
          chunk.forEach((docSnap) => {
            batchInstance.delete(doc(db, "other_costs", docSnap.id));
          });
          await batchInstance.commit();
        }
        const rawFallback = localStorage.getItem("local_other_costs_fallback");
        if (rawFallback) {
          const parsed = JSON.parse(rawFallback);
          if (Array.isArray(parsed)) {
            const remaining = parsed.filter(
              (c: any) => !String(c?.id || "").startsWith("udhaar_bill_") && !c?.linkedBillId
            );
            localStorage.setItem("local_other_costs_fallback", JSON.stringify(remaining));
            window.dispatchEvent(new CustomEvent("localOtherCostsUpdated", { detail: remaining }));
          }
        }
      } catch (e) {
        console.warn("Could not clean linked Udhar costs during bill purge:", e);
      }

      localStorage.removeItem("local_bills_fallback");
      await sqliteClearBills().catch(() => {});

      if (user) {
        try {
          await logActivity(
            "purge_bills",
            `Purged all transaction bills from the database (Total ${billsSnap.size} bills deleted).`,
            user.uid,
            user.displayName || "Admin",
            user.email || ""
          );
        } catch (err) {
          console.error("Failed to log purge activity:", err);
        }
      }

      triggerHaptic("success");
    } catch (err: any) {
      console.error(err);
      triggerHaptic("error");
      setActionErrorMessage(
        `Error purging bills: ${
          err.message || err
        }. Ensure you have administrative Firestore permissions.`
      );
    }
  };

  const handleDeleteAllOtherCosts = async () => {
    triggerHaptic("heavy");
    setDeleteConfMode("none");
    setDangerConfirmText("");
    setActionSuccessMessage(
      "All other costs dropped successfully."
    );
    
    try {
      const snap = await getDocs(collection(db, "other_costs"));
      if (snap.size > 0) {
        const docs = snap.docs;
        for (let i = 0; i < docs.length; i += 500) {
          const batchInstance = writeBatch(db);
          const chunk = docs.slice(i, i + 500);
          chunk.forEach((docSnap) => {
            batchInstance.delete(doc(db, "other_costs", docSnap.id));
          });
          await batchInstance.commit();
        }
      }
      localStorage.removeItem("local_other_costs_fallback");
      window.dispatchEvent(new CustomEvent("localOtherCostsUpdated", { detail: [] }));

      if (user) {
        try {
          await logActivity(
            "purge_database",
            `Purged all other costs from the database (Total ${snap.size} records deleted).`,
            user.uid,
            user.displayName || "Admin",
            user.email || ""
          );
        } catch (err) {
          console.error("Failed to log purge activity:", err);
        }
      }

      triggerHaptic("success");
    } catch (err: any) {
      console.error(err);
      triggerHaptic("error");
      setActionErrorMessage(
        `Error purging other costs: ${
          err.message || err
        }. Ensure you have administrative Firestore permissions.`
      );
    }
  };

  const handleClearAllLogs = async () => {
    setShowClearLogsConfirm(false);
    setClearingLogs(true);
    triggerHaptic("heavy");
    try {
      const snap = await getDocs(collection(db, "activity_logs"));
      if (snap.size > 0) {
        const docs = snap.docs;
        for (let i = 0; i < docs.length; i += 500) {
          const batchInstance = writeBatch(db);
          const chunk = docs.slice(i, i + 500);
          chunk.forEach((docSnap) => {
            batchInstance.delete(doc(db, "activity_logs", docSnap.id));
          });
          await batchInstance.commit();
        }
      }

      triggerHaptic("success");
      setActionSuccessMessage("All activity logs cleared successfully.");
    } catch (err: any) {
      console.error("Failed to clear logs:", err);
      triggerHaptic("error");
    } finally {
      setClearingLogs(false);
    }
  };

  const handlePinInput = async (num: string) => {
    if (
      isUnlockingRef.current ||
      pinRef.current.length >= 4 ||
      failedAttempts >= 3 ||
      lockedByAdmin
    ) {
      return;
    }
    triggerHaptic("light");
    const newPin = pinRef.current + num;
    pinRef.current = newPin;
    setPin(newPin);
    if (error) setError(false);

    if (newPin.length === 4) {
      const expectedPin = (adminPin || localStorage.getItem("adminPin") || "8521").trim();
      if (newPin === expectedPin) {
        isUnlockingRef.current = true;
        triggerHaptic("success");
        // Set adminAuth in sessionStorage immediately so AuthContext never mistakes this active session for a stale temp session
        sessionStorage.setItem("adminAuth", "true");
        setSuccess(true);

        if (user) {
          resetFailedAttempts().catch((e) => {
            console.debug("Failed to reset attempts:", e);
          });
        }

        // If a non-admin account enters the correct PIN, do NOT make them a temporary admin in Firestore;
        // keep their role as a normal user and broadcast the multi-admin security alert to OTHER devices with exact breach count.
        if (!isRealAdmin && user) {
          const now = Date.now();
          const currentDeviceId = getDeviceId();
          const alertRef = doc(collection(db, "security_alerts"));
          // Immediately mark this alert ID locally so the device used to unlock the Admin Panel NEVER notifies itself
          markLocalSecurityAlertTriggered(alertRef.id);
          const intruderName = user.displayName || "Anonymous";
          const intruderEmail = user.email || "No email";
          const intruderUid = user.uid;

          (async () => {
            try {
              const globalMsgRef = doc(db, "settings", "global_security_message");
              let prevEvents: any[] = [];
              try {
                const snap = await getDoc(globalMsgRef);
                if (snap.exists()) {
                  const data = snap.data();
                  const cutoff = now - 86400000;
                  if (Array.isArray(data?.events)) {
                    prevEvents = data.events.filter((e: any) => Number(e?.timestamp) > cutoff);
                  } else if (data?.timestamp && Number(data.timestamp) > cutoff) {
                    prevEvents = [
                      {
                        id: data.alertId || `legacy_${data.timestamp}`,
                        timestamp: Number(data.timestamp),
                        type: data.type || "pin_login_bypass",
                        deviceId: data.deviceId || "",
                        userUid: data.userUid || "",
                        userName: data.userName || "Anonymous",
                        userEmail: data.userEmail || "",
                        acknowledgedBy: Array.isArray(data.acknowledgedBy) ? data.acknowledgedBy : [],
                      },
                    ];
                  }
                }
              } catch {}

              const priorUserBreaches = prevEvents.filter(
                (e: any) =>
                  (e.userUid === intruderUid || e.userEmail === intruderEmail) &&
                  (e.type === "pin_login_bypass" || e.type === "intrusion")
              ).length;
              const breachCount = priorUserBreaches + 1;

              const alertMessage =
                breachCount > 1
                  ? `⚠️ Security Warning! Non-Admin account "${intruderName}" (${intruderEmail}) broke into the Admin Panel ${breachCount} times using the security PIN.`
                  : `⚠️ Security Warning! Non-Admin account "${intruderName}" (${intruderEmail}) successfully logged into the Admin Panel using the security PIN (1 time).`;

              const newEvent = {
                id: alertRef.id,
                alertId: alertRef.id,
                deviceId: currentDeviceId,
                timestamp: now,
                type: "pin_login_bypass",
                userId: intruderUid,
                userUid: intruderUid,
                userName: intruderName,
                userEmail: intruderEmail,
                breachCount,
                message: alertMessage,
                acknowledgedBy: [intruderUid],
              };

              const updatedEvents = [...prevEvents, newEvent].slice(-30);

              // 1. Store security alert in security_alerts collection with deviceId and acknowledgedBy: [intruderUid]
              await setDoc(alertRef, newEvent).catch(() => {});

              // 2. Update global_security_message with full events list & breachCount so all admins on other devices receive every notification
              await setDoc(globalMsgRef, {
                alertId: alertRef.id,
                deviceId: currentDeviceId,
                timestamp: now,
                type: "pin_login_bypass",
                message: alertMessage,
                userUid: intruderUid,
                userName: intruderName,
                userEmail: intruderEmail,
                breachCount,
                events: updatedEvents,
                acknowledgedBy: [intruderUid],
              }).catch(() => {});

              // 3. Record permanent audit entry in activity logs
              await logActivity(
                "pin_login_bypass",
                `Non-Admin account "${intruderName}" (${intruderEmail}) unlocked the Admin Terminal with PIN (Break-in #${breachCount}).`,
                intruderUid,
                intruderName,
                intruderEmail
              ).catch(() => {});
            } catch (e) {
              console.debug("Failed logging pin bypass alert:", e);
            }
          })();
        }

        setTimeout(() => {
          handleSetAuthenticated(true);
          setSuccess(false);
          setPin("");
          pinRef.current = "";
          isUnlockingRef.current = false;
        }, 280);
      } else {
        triggerHaptic("error");
        setError(true);
        if (user) {
          incrementFailedAttempts().catch((e) => {
            console.debug("Failed to update attempts:", e);
          });
        }
        setTimeout(() => {
          setPin("");
          pinRef.current = "";
        }, 500);
      }
    }
  };

  const handleBackspace = () => {
    if (isUnlockingRef.current) return;
    if (pinRef.current.length > 0) {
      triggerHaptic("light");
      const next = pinRef.current.slice(0, -1);
      pinRef.current = next;
      setPin(next);
    }
  };

  const handleCloseChangePin = () => {
    if (savePinTimerRef.current) {
      clearTimeout(savePinTimerRef.current);
      savePinTimerRef.current = null;
    }
    newPinRef.current = "";
    setNewPin("");
    setIsPinSaved(false);
    setIsChangingPin(false);
  };

  const handleNewPinInput = (num: string) => {
    if (isPinSaved || newPinRef.current.length >= 4) return;
    triggerHaptic("light");
    const next = newPinRef.current + num;
    newPinRef.current = next;
    setNewPin(next);
  };

  const handleSavePin = () => {
    const pinToSave = newPinRef.current;
    if (pinToSave.length !== 4 || isPinSaved) return;
    if (user) {
      triggerHaptic("success");
      setIsPinSaved(true);
      // Fire-and-forget background sync without stalling UI
      updateAdminPin(user.uid, pinToSave).catch((e) => {
        console.warn("Failed to update PIN backend, using cache", e);
      });
      logActivity(
        "admin_pin_changed",
        "Updated the admin dashboard security PIN.",
        user.uid,
        user.displayName || "Admin",
        user.email || ""
      ).catch((e) => console.warn(e));

      if (savePinTimerRef.current) {
        clearTimeout(savePinTimerRef.current);
      }
      savePinTimerRef.current = setTimeout(() => {
        savePinTimerRef.current = null;
        newPinRef.current = "";
        setIsPinSaved(false);
        setIsChangingPin(false);
        setNewPin("");
      }, 2500);
    }
  };

  const handleNewPinBackspace = () => {
    if (isPinSaved) return;
    if (newPinRef.current.length > 0) {
      triggerHaptic("light");
      const next = newPinRef.current.slice(0, -1);
      newPinRef.current = next;
      setNewPin(next);
    }
  };

  if (authLoading) {
    return null; // Or a transparent loader
  }

  const renderActionFeedbackPortal = () =>
    createPortal(
      <AnimatePresence>
        {actionSuccessMessage && (
          <div
            key="admin-success-modal"
            className="fixed inset-0 z-[120] flex items-center justify-center p-4"
          >
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => {
                setActionSuccessMessage("");
                setLastExportedBackup(null);
                setCopiedBackupJson(false);
              }}
              className="absolute inset-0 bg-slate-950/70 backdrop-blur-md"
            />
            <motion.div
              initial={{ scale: 0.94, opacity: 0, y: 10 }}
              animate={{ scale: 1, opacity: 1, y: 0 }}
              exit={{ scale: 0.94, opacity: 0, y: 10 }}
              transition={{ type: "spring", stiffness: 400, damping: 28, mass: 0.7 }}
              className="w-full max-w-sm bg-white dark:bg-[#0c1222] border border-slate-200/80 dark:border-slate-800/90 p-6 relative z-10 text-center rounded-[28px] shadow-2xl"
            >
              <div className="w-12 h-12 bg-emerald-500/15 text-emerald-500 rounded-2xl flex items-center justify-center mx-auto mb-3.5 border border-emerald-500/25">
                <Check size={22} className="stroke-[2.75]" />
              </div>
              <h3 className="text-base font-extrabold text-slate-900 dark:text-white tracking-tight mb-1.5">
                {actionSuccessTitle || "Operation Complete"}
              </h3>
              <p className="text-xs font-medium text-slate-600 dark:text-slate-300 leading-relaxed mb-5 px-1 break-words">
                {actionSuccessMessage}
              </p>

              <button
                type="button"
                onClick={() => {
                  setActionSuccessMessage("");
                  setLastExportedBackup(null);
                  setCopiedBackupJson(false);
                }}
                className="w-full h-11 bg-indigo-600 hover:bg-indigo-500 active:scale-95 text-white font-bold rounded-xl text-xs shadow-md shadow-indigo-600/20 transition-all cursor-pointer"
              >
                Done
              </button>
            </motion.div>
          </div>
        )}

        {actionErrorMessage && (
          <div
            key="admin-error-modal"
            className="fixed inset-0 z-[120] flex items-center justify-center p-4"
          >
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => setActionErrorMessage("")}
              className="absolute inset-0 bg-slate-950/70 backdrop-blur-md"
            />
            <motion.div
              initial={{ scale: 0.94, opacity: 0, y: 10 }}
              animate={{ scale: 1, opacity: 1, y: 0 }}
              exit={{ scale: 0.94, opacity: 0, y: 10 }}
              transition={{ type: "spring", stiffness: 400, damping: 28, mass: 0.7 }}
              className="w-full max-w-sm bg-white dark:bg-[#0c1222] border border-slate-200/80 dark:border-slate-800/90 p-6 relative z-10 text-center rounded-[28px] shadow-2xl"
            >
              <div className="w-12 h-12 bg-rose-500/15 text-rose-500 rounded-2xl flex items-center justify-center mx-auto mb-3.5 border border-rose-500/25">
                <AlertTriangle size={22} />
              </div>
              <h3 className="text-base font-extrabold text-slate-900 dark:text-white tracking-tight mb-1.5">
                Operation Failed
              </h3>
              <p className="text-xs font-medium text-slate-600 dark:text-slate-300 leading-relaxed mb-5 px-1 break-words">
                {actionErrorMessage}
              </p>
              <button
                type="button"
                onClick={() => setActionErrorMessage("")}
                className="w-full h-11 bg-rose-600 hover:bg-rose-500 active:scale-95 text-white font-bold rounded-xl text-xs shadow-md shadow-rose-600/20 transition-all cursor-pointer"
              >
                Dismiss
              </button>
            </motion.div>
          </div>
        )}
      </AnimatePresence>,
      document.body
    );

  if (isAuthenticated) {
    if (isChangingPin) {
      return (
        <motion.div
          key="admin-change-pin-view"
          initial={{ opacity: 0, scale: 0.98 }}
          animate={{ opacity: 1, scale: 1 }}
          exit={{
            opacity: 0,
            scale: 0.98,
            transition: { duration: 0.3, ease: [0.16, 1, 0.3, 1] },
          }}
          transition={{ duration: 0.35, ease: [0.16, 1, 0.3, 1] }}
          className="pb-6 px-4 pt-4 max-w-sm mx-auto min-h-[85vh] flex flex-col justify-between relative"
        >
          <header className="w-full flex items-center justify-between pt-2">
            <button
              type="button"
              onClick={() => {
                triggerHaptic("light");
                handleCloseChangePin();
              }}
              className="w-11 h-11 flex-shrink-0 flex items-center justify-center bg-slate-50 hover:bg-slate-100 dark:bg-slate-900/80 dark:hover:bg-slate-850 text-slate-800 dark:text-slate-100 border border-slate-200/80 dark:border-slate-800 rounded-2xl shadow-sm active:scale-95 transition-all outline-none"
              title="Go Back"
            >
              <ArrowLeft size={18} />
            </button>
            <span className="text-[10px] font-extrabold uppercase tracking-widest text-slate-400 dark:text-slate-500">
              Security Terminal
            </span>
          </header>

          <AnimatePresence mode="wait">
            {isPinSaved ? (
              <motion.div
                key="pin-saved-confirmation"
                initial={{ scale: 0.92, opacity: 0, y: 10 }}
                animate={{ scale: 1, opacity: 1, y: 0 }}
                exit={{ scale: 0.95, opacity: 0, y: -10 }}
                transition={{ type: "spring", stiffness: 380, damping: 28, mass: 0.7 }}
                className="my-auto flex flex-col items-center justify-center w-full px-2"
              >
                <motion.div
                  initial={{ scale: 0.6, rotate: -12 }}
                  animate={{ scale: 1, rotate: 0 }}
                  transition={{ type: "spring", stiffness: 420, damping: 20 }}
                  className="w-20 h-20 rounded-3xl bg-emerald-50 dark:bg-emerald-500/10 flex items-center justify-center mx-auto mb-6 border border-emerald-500/20 shadow-[0_8px_30px_rgba(16,185,129,0.15)]"
                >
                  <KeyRound className="text-emerald-500" size={38} />
                </motion.div>
                <h1 className="text-3xl font-black tracking-tight text-slate-900 dark:text-slate-100">
                  PIN Saved!
                </h1>
                <p className="text-slate-500 dark:text-slate-400 mt-2 text-center text-sm leading-relaxed max-w-xs">
                  Your new admin PIN has been updated successfully.
                </p>

                <button
                  type="button"
                  onClick={() => {
                    triggerHaptic("light");
                    handleCloseChangePin();
                  }}
                  className="mt-8 px-6 py-3.5 w-full bg-indigo-600 hover:bg-indigo-700 active:scale-95 text-white rounded-2xl font-bold text-sm transition-all shadow-lg shadow-indigo-600/25 flex items-center justify-center gap-2"
                >
                  <span>Back to Admin Terminal</span>
                </button>
              </motion.div>
            ) : (
              <motion.div
                key="pin-keypad-entry"
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -8 }}
                transition={{ duration: 0.22, ease: "easeOut" }}
                className="my-auto flex flex-col items-center w-full"
              >
                <div className="mb-7 text-center">
                  <div className="w-20 h-20 rounded-3xl bg-indigo-50 relative dark:bg-indigo-500/10 flex items-center justify-center mx-auto mb-5 border border-indigo-100/60 dark:border-indigo-500/20 shadow-[0_8px_30px_rgb(99,102,241,0.08)]">
                    <KeyRound
                      className="text-indigo-600 dark:text-indigo-400"
                      size={38}
                    />
                  </div>
                  <h1 className="text-3xl font-black tracking-tight text-slate-900 dark:text-slate-100">
                    New{" "}
                    <span className="text-indigo-600 dark:text-indigo-400">
                      PIN
                    </span>
                  </h1>
                  <p className="text-slate-400 dark:text-slate-500 text-[10px] font-extrabold uppercase tracking-widest mt-2">
                    Enter Your New 4-Digit PIN
                  </p>
                </div>

                <div className="flex gap-4 mb-8 justify-center">
                  {[0, 1, 2, 3].map((i) => {
                    const filled = i < newPin.length;
                    return (
                      <div
                        key={i}
                        className={`w-4 h-4 rounded-full transition-all duration-300 ${
                          filled
                            ? "bg-indigo-600 dark:bg-indigo-400 shadow-[0_0_12px_rgba(99,102,241,0.6)] scale-110"
                            : "bg-slate-200 dark:bg-slate-800 scale-100"
                        }`}
                      />
                    );
                  })}
                </div>

                <div className="grid grid-cols-3 gap-3.5 w-full px-4">
                  {[1, 2, 3, 4, 5, 6, 7, 8, 9].map((num) => (
                    <button
                      type="button"
                      key={num}
                      onClick={() => handleNewPinInput(num.toString())}
                      className="text-2xl font-black bg-white/60 dark:bg-slate-900/60 backdrop-blur-md rounded-2xl h-15 flex items-center justify-center text-slate-850 dark:text-slate-100 border border-slate-200/50 dark:border-slate-800/80 shadow-sm active:scale-90 active:bg-slate-100 dark:active:!bg-slate-800 transition-all outline-none select-none"
                    >
                      {num}
                    </button>
                  ))}
                  <div />
                  <button
                    type="button"
                    onClick={() => handleNewPinInput("0")}
                    className="text-2xl font-black bg-white/60 dark:bg-slate-900/60 backdrop-blur-md rounded-2xl h-15 flex items-center justify-center text-slate-850 dark:text-slate-100 border border-slate-200/50 dark:border-slate-800/80 shadow-sm active:scale-90 active:bg-slate-100 dark:active:!bg-slate-800 transition-all outline-none select-none"
                  >
                    0
                  </button>
                  <button
                    type="button"
                    onClick={handleNewPinBackspace}
                    className="text-2xl font-black bg-white/60 dark:bg-slate-900/60 backdrop-blur-md rounded-2xl h-15 flex items-center justify-center text-slate-400 dark:text-slate-500 border border-slate-200/50 dark:border-slate-800/80 shadow-sm active:scale-90 active:bg-slate-100 dark:active:!bg-slate-800 transition-all outline-none select-none"
                  >
                    <Delete size={22} className="stroke-[2.5]" />
                  </button>
                </div>

                {/* Fixed-height action slot prevents keypad from jumping when 4th digit is entered */}
                <div className="w-full px-4 mt-5 h-14 flex items-center justify-center">
                  <AnimatePresence initial={false}>
                    {newPin.length === 4 && (
                      <motion.button
                        key="save-new-pin-btn"
                        type="button"
                        initial={{ opacity: 0, scale: 0.94, y: 6 }}
                        animate={{ opacity: 1, scale: 1, y: 0 }}
                        exit={{ opacity: 0, scale: 0.94, y: 6 }}
                        transition={{ type: "spring", stiffness: 420, damping: 28, mass: 0.7 }}
                        onClick={handleSavePin}
                        className="w-full py-3.5 bg-indigo-600 hover:bg-indigo-700 text-white rounded-2xl font-bold shadow-lg shadow-indigo-500/25 active:scale-95 transition-all"
                      >
                        Save PIN
                      </motion.button>
                    )}
                  </AnimatePresence>
                </div>
              </motion.div>
            )}
          </AnimatePresence>

          <div className="w-full text-center text-[10px] text-slate-400 dark:text-slate-600 font-medium py-1">
            Terminal Secured with 256-bit Firestore Encryption
          </div>
          <style>
            {"#bottom-nav-container { display: none !important; } #app-scroll-container { padding-bottom: calc(1rem + env(safe-area-inset-bottom)) !important; }"}
          </style>
        </motion.div>
      );
    }

    if (isViewingSyncConflicts) {
      const conflictTabs = [
        { id: "all", label: "All Conflicts" },
        { id: "unresolved", label: "Unresolved" },
        { id: "resolved", label: "Resolved" },
      ] as const;

      const unresolvedCount = syncConflicts.filter(
        (c) => c.status === "unresolved"
      ).length;

      const filteredConflicts = syncConflicts
        .filter((c) => {
          if (conflictFilter === "unresolved" && c.status !== "unresolved")
            return false;
          if (conflictFilter === "resolved" && c.status === "unresolved")
            return false;
          if (!searchQuery.trim()) return true;
          const q = searchQuery.toLowerCase();
          const cItems = c.conflictingItems || c.conflicts || [];
          const matchesItems = cItems.some((it) =>
            (it.name || it.productName || "").toLowerCase().includes(q)
          );
          return (
            (c.billId || "").toLowerCase().includes(q) ||
            (c.userName || "").toLowerCase().includes(q) ||
            (c.userEmail || "").toLowerCase().includes(q) ||
            matchesItems
          );
        })
        .sort(
          (a, b) =>
            (Number(b.failedAt || b.conflictDetectedAt || b.billDate) || 0) -
            (Number(a.failedAt || a.conflictDetectedAt || a.billDate) || 0)
        );

      const groupedConflicts: { label: string; items: SyncConflictRecord[] }[] = [];
      const groupMap = new Map<string, SyncConflictRecord[]>();
      const today = new Date();
      const yesterday = new Date();
      yesterday.setDate(today.getDate() - 1);

      const isSameCalendarDay = (d1: Date, d2: Date) =>
        d1.getDate() === d2.getDate() &&
        d1.getMonth() === d2.getMonth() &&
        d1.getFullYear() === d2.getFullYear();

      filteredConflicts.forEach((item) => {
        const ts =
          Number(item.failedAt || item.conflictDetectedAt || item.billDate || item.createdAt) ||
          Date.now();
        const itemDate = new Date(ts);
        let label = formatDateToDMY(ts) || "Recent";

        if (!isNaN(itemDate.getTime())) {
          if (isSameCalendarDay(itemDate, today)) {
            label = "Today";
          } else if (isSameCalendarDay(itemDate, yesterday)) {
            label = "Yesterday";
          }
        }

        if (!groupMap.has(label)) {
          const arr: SyncConflictRecord[] = [];
          groupMap.set(label, arr);
          groupedConflicts.push({ label, items: arr });
        }
        groupMap.get(label)!.push(item);
      });

      return (
        <motion.div
          key="admin-sync-conflicts-view"
          initial={{ opacity: 0, y: 15 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: 15 }}
          transition={{ duration: 0.4, ease: [0.16, 1, 0.3, 1] }}
          className="min-h-full flex flex-col pb-2 px-4 pt-10 w-full max-w-lg mx-auto"
        >
          {/* Header */}
          <header className="mb-5 flex flex-col gap-4">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3.5">
                <button
                  onClick={() => {
                    triggerHaptic("light");
                    setIsViewingSyncConflicts(false);
                    setSearchQuery("");
                    setConflictFilter("all");
                  }}
                  className="m3-icon-btn flex-shrink-0 pointer-events-auto"
                >
                  <ArrowLeft size={18} />
                </button>
                <div>
                  <h1 className="text-2xl font-black tracking-tight text-slate-900 dark:text-white">
                    Sync{" "}
                    <span className="text-amber-600 dark:text-amber-400">
                      Conflicts
                    </span>
                  </h1>
                  <p className="text-[13px] leading-snug font-medium text-slate-500 dark:text-slate-400 mt-0.5">
                    Offline billing stock discrepancies
                  </p>
                </div>
              </div>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => {
                    triggerHaptic("heavy");
                    setIsRefreshingConflicts(true);
                    setRefreshConflictsTrigger((prev) => prev + 1);
                    setTimeout(() => {
                      setIsRefreshingConflicts(false);
                    }, 900);
                  }}
                  className={`m3-icon-btn ${
                    syncConflictsLoading || isRefreshingConflicts
                      ? "!bg-[#e8def8] dark:!bg-indigo-500/25 !text-indigo-700 dark:!text-indigo-300 !border-indigo-300/80 dark:!border-indigo-400/40 scale-95"
                      : ""
                  }`}
                  title="Refresh conflicts"
                >
                  {syncConflictsLoading || isRefreshingConflicts ? (
                    <M3CircularProgress size={18} strokeWidth={4.2} />
                  ) : (
                    <RefreshCw size={16} />
                  )}
                </button>
                <button
                  onClick={() => setShowClearConflictsConfirm(true)}
                  disabled={
                    !isRealAdmin ||
                    clearingConflicts ||
                    syncConflicts.length === 0
                  }
                  className="m3-icon-btn-error"
                  title="Clear all conflict logs"
                >
                  {clearingConflicts ? (
                    <M3CircularProgress size={18} strokeWidth={4.2} />
                  ) : (
                    <Trash2 size={16} />
                  )}
                </button>
              </div>
            </div>

            {/* Summary KPI Banner */}
            <div className="grid grid-cols-2 gap-3">
              <div className="p-3.5 rounded-[22px] bg-[#f3edf7]/90 dark:bg-[#1b1f2b]/95 border border-slate-200/80 dark:border-white/[0.08] flex flex-col gap-0.5 shadow-2xs">
                <span className="text-[10px] font-extrabold uppercase tracking-widest text-slate-500 dark:text-slate-400">
                  Needs Resolution
                </span>
                <span
                  className={`text-2xl font-black ${
                    unresolvedCount > 0
                      ? "text-amber-600 dark:text-amber-400"
                      : "text-emerald-600 dark:text-emerald-400"
                  }`}
                >
                  {unresolvedCount}{" "}
                  <span className="text-xs font-semibold text-slate-400 dark:text-slate-500">
                    pending
                  </span>
                </span>
              </div>
              <div className="p-3.5 rounded-[22px] bg-[#f3edf7]/90 dark:bg-[#1b1f2b]/95 border border-slate-200/80 dark:border-white/[0.08] flex flex-col gap-0.5 shadow-2xs">
                <span className="text-[10px] font-extrabold uppercase tracking-widest text-slate-500 dark:text-slate-400">
                  Total Recorded
                </span>
                <span className="text-2xl font-black text-slate-900 dark:text-slate-100">
                  {syncConflicts.length}{" "}
                  <span className="text-xs font-semibold text-slate-400 dark:text-slate-500">
                    events
                  </span>
                </span>
              </div>
            </div>
          </header>

          {/* Search Bar */}
          <div className="relative mb-4">
            <span className="absolute inset-y-0 left-0 flex items-center pl-4 pointer-events-none text-slate-400 dark:text-slate-500">
              <Search size={16} />
            </span>
            <input
              type="text"
              placeholder="Search by cashier, product, or bill ID..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="m3-search-bar"
            />
            {searchQuery && (
              <button
                onClick={() => setSearchQuery("")}
                className="absolute inset-y-0 right-0 flex items-center pr-4 text-slate-400 hover:text-slate-600 dark:hover:text-slate-200"
              >
                <X size={16} />
              </button>
            )}
          </div>

          {/* Filter Tabs */}
          <div
            onPointerDown={(e) => {
              segDragRef.current = { startX: e.clientX, dragged: false };
            }}
            onTouchStart={(e) => {
              const touch = e.touches[0];
              if (!touch) return;
              segDragRef.current = { startX: touch.clientX, dragged: false };
            }}
            onTouchMove={(e) => {
              const touch = e.touches[0];
              if (!touch) return;
              if (Math.abs(touch.clientX - segDragRef.current.startX) <= 6) return;
              segDragRef.current.dragged = true;
              const rect = e.currentTarget.getBoundingClientRect();
              const innerWidth = Math.max(1, rect.width - 8);
              const relX = Math.max(0, Math.min(innerWidth - 1, touch.clientX - (rect.left + 4)));
              const idx = Math.min(
                conflictTabs.length - 1,
                Math.max(0, Math.floor((relX / innerWidth) * conflictTabs.length))
              );
              const next = conflictTabs[idx]?.id;
              if (next && next !== conflictFilter) {
                triggerHaptic("selection");
                setConflictFilter(next);
              }
            }}
            onPointerMove={(e) => {
              if (e.buttons !== 1) return;
              if (Math.abs(e.clientX - segDragRef.current.startX) <= 6) return;
              segDragRef.current.dragged = true;
              const rect = e.currentTarget.getBoundingClientRect();
              const innerWidth = Math.max(1, rect.width - 8);
              const relX = Math.max(0, Math.min(innerWidth - 1, e.clientX - (rect.left + 4)));
              const idx = Math.min(
                conflictTabs.length - 1,
                Math.max(0, Math.floor((relX / innerWidth) * conflictTabs.length))
              );
              const next = conflictTabs[idx]?.id;
              if (next && next !== conflictFilter) {
                triggerHaptic("selection");
                setConflictFilter(next);
              }
            }}
            className="relative grid grid-cols-3 p-1 mb-5 bg-[#ece6f0] dark:bg-[#161922] border border-slate-200/80 dark:border-white/[0.07] rounded-full select-none touch-pan-y shrink-0 isolate"
          >
            <div
              aria-hidden="true"
              style={{
                width: "calc((100% - 8px) / 3)",
                transform: `translate3d(${
                  conflictTabs.findIndex((t) => t.id === conflictFilter) * 100
                }%, 0, 0)`,
                transition: "transform 260ms cubic-bezier(0.22, 1, 0.36, 1)",
              }}
              className="absolute top-1 bottom-1 left-1 bg-[#e0e7ff] dark:bg-indigo-500/25 border border-indigo-200/70 dark:border-indigo-400/30 rounded-full shadow-2xs dark:shadow-none pointer-events-none transform-gpu will-change-transform"
            />
            {conflictTabs.map((tab) => {
              const isActive = conflictFilter === tab.id;
              return (
                <button
                  key={tab.id}
                  type="button"
                  onClick={() => {
                    if (segDragRef.current.dragged) {
                      segDragRef.current.dragged = false;
                      return;
                    }
                    if (conflictFilter === tab.id) return;
                    triggerHaptic("selection");
                    setConflictFilter(tab.id);
                  }}
                  className={`relative z-10 min-w-0 min-h-[36px] px-2 py-1.5 rounded-full text-xs font-bold tracking-tight transition-colors duration-200 whitespace-nowrap outline-none flex items-center justify-center cursor-pointer ${
                    isActive
                      ? "text-indigo-950 dark:text-indigo-100"
                      : "text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200"
                  }`}
                >
                  <span className="relative z-10 truncate">{tab.label}</span>
                </button>
              );
            })}
          </div>

          {/* Conflicts List */}
          <div className="relative flex-1 flex flex-col min-h-[320px] [overflow-anchor:none]">
            <M3RefreshIndicator
              active={syncConflictsLoading || isRefreshingConflicts}
              label="Syncing conflict logs..."
            />

            {syncConflictsLoading && syncConflicts.length === 0 ? (
              <div
                key="conflicts-loading-state"
                className="py-20 flex-1 flex flex-col items-center justify-center bg-white dark:bg-[#1b1f2b] border border-slate-200/75 dark:border-white/[0.07] rounded-[28px] shadow-[0_1px_3px_rgba(15,23,42,0.04)] dark:shadow-none"
              >
                <div className="w-14 h-14 rounded-full bg-amber-500/15 text-amber-600 dark:text-amber-400 flex items-center justify-center mb-4 shadow-sm">
                  <M3CircularProgress size={28} strokeWidth={4} />
                </div>
                <p className="text-xs font-extrabold text-slate-600 dark:text-slate-300 uppercase tracking-widest">
                  Checking offline sync conflicts...
                </p>
              </div>
            ) : filteredConflicts.length === 0 ? (
              <div
                key="conflicts-empty-state"
                className="text-center py-16 bg-white dark:bg-[#1b1f2b] border border-slate-200/75 dark:border-white/[0.07] rounded-[28px] p-6 flex-1 flex flex-col items-center justify-center shadow-[0_1px_3px_rgba(15,23,42,0.04)] dark:shadow-none"
              >
                <div className="w-12 h-12 rounded-full bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 flex items-center justify-center mx-auto mb-3 border border-emerald-500/20">
                  <Check size={22} />
                </div>
                <p className="text-sm font-bold text-slate-700 dark:text-slate-200">
                  No sync conflicts found
                </p>
                <p className="text-xs text-slate-400 dark:text-slate-500 mt-1 max-w-xs mx-auto leading-relaxed">
                  Offline bills that fail validation due to concurrent online stock updates will appear here for manual resolution.
                </p>
              </div>
            ) : (
              <motion.div
                key="conflicts-list-state"
                animate={{
                  opacity: isRefreshingConflicts ? 0.72 : 1,
                  scale: isRefreshingConflicts ? 0.992 : 1,
                }}
                transition={{ duration: 0.22 }}
                className="space-y-6 [overflow-anchor:none]"
              >
                {groupedConflicts.map((group) => (
                  <div key={group.label} className="space-y-3">
                    <div className="flex items-center justify-between px-1.5">
                      <span className="text-xs font-bold uppercase tracking-wider text-slate-400 dark:text-slate-500">
                        {group.label}
                      </span>
                      <span className="text-[11px] font-semibold font-mono tabular-nums text-slate-400 dark:text-slate-500">
                        {group.items.length}{" "}
                        {group.items.length === 1 ? "conflict" : "conflicts"}
                      </span>
                    </div>

                    <div className="space-y-3">
                      {group.items.map((conflict, idx) => {
                        const isUnresolved = conflict.status === "unresolved";
                        const isForceApproved =
                          conflict.status === "resolved_force_approved" ||
                          conflict.status === "resolved_forced";
                        const isRetried = conflict.status === "resolved_retried";
                        const isResolving = resolvingConflictId === conflict.id;
                        const detectedTime =
                          conflict.failedAt || conflict.conflictDetectedAt || conflict.billDate;
                        const conflictItemsList =
                          conflict.conflictingItems || conflict.conflicts || [];

                        return (
                          <div
                            key={conflict.id || `conflict_${idx}`}
                            className={`p-4 glass-card rounded-[24px] flex flex-col gap-3 border ${
                              isUnresolved
                                ? "border-amber-500/35 dark:border-amber-500/30"
                                : "border-slate-200/70 dark:border-white/[0.07]"
                            }`}
                          >
                            {/* Top Status & Timestamp Row */}
                            <div className="flex items-center justify-between gap-2">
                              <div className="flex items-center gap-2 min-w-0">
                                <span
                                  className={`px-2.5 py-0.5 rounded-full text-[10px] font-extrabold uppercase tracking-wider ${
                                    isUnresolved
                                      ? "bg-amber-500/15 text-amber-700 dark:text-amber-300 border border-amber-500/30"
                                      : isForceApproved
                                      ? "bg-indigo-500/15 text-indigo-700 dark:text-indigo-300 border border-indigo-500/30"
                                      : "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 border border-emerald-500/30"
                                  }`}
                                >
                                  {isUnresolved
                                    ? "Unresolved"
                                    : isForceApproved
                                    ? "Force Approved"
                                    : isRetried
                                    ? "Synced on Retry"
                                    : "Void Confirmed"}
                                </span>
                                <span className="text-xs font-mono font-bold text-slate-500 dark:text-slate-400 truncate">
                                  #{String(conflict.billId || "").slice(-6).toUpperCase()}
                                </span>
                              </div>

                              <div className="flex items-center gap-2 shrink-0">
                                <span className="text-[10px] text-slate-400 dark:text-slate-500 font-mono font-semibold">
                                  {detectedTime
                                    ? new Date(detectedTime).toLocaleTimeString([], {
                                        hour: "2-digit",
                                        minute: "2-digit",
                                      })
                                    : ""}
                                </span>
                                {isRealAdmin && (
                                  <button
                                    type="button"
                                    onClick={() =>
                                      handleDeleteSingleConflict(conflict.id)
                                    }
                                    className="w-6 h-6 rounded-full flex items-center justify-center text-slate-400 hover:text-rose-500 hover:bg-rose-500/10 transition-colors cursor-pointer"
                                    title="Delete conflict log"
                                  >
                                    <X size={13} />
                                  </button>
                                )}
                              </div>
                            </div>

                            {/* Cashier & Bill Total */}
                            <div className="flex items-center justify-between gap-2">
                              <div className="min-w-0">
                                <p className="text-xs font-bold text-slate-800 dark:text-slate-100 truncate">
                                  Billed offline by {conflict.userName || "Cashier"}
                                </p>
                                <p className="text-[11px] text-slate-400 dark:text-slate-500 truncate">
                                  {conflict.userEmail || "Offline session"}
                                </p>
                              </div>
                              <div className="text-right shrink-0">
                                <span className="text-sm font-black font-mono text-slate-900 dark:text-white">
                                  ₹{formatPrice(Number(conflict.total) || 0)}
                                </span>
                                <span className="block text-[10px] font-semibold text-slate-400 dark:text-slate-500">
                                  {(conflict.items || []).reduce(
                                    (s, i) => s + (Number(i.quantity) || 0),
                                    0
                                  )}{" "}
                                  items
                                </span>
                              </div>
                            </div>

                            {/* Conflicting Stock Breakdown */}
                            <div className="rounded-2xl bg-rose-500/[0.06] dark:bg-rose-500/[0.08] border border-rose-500/20 p-3 space-y-2">
                              <div className="flex items-center gap-1.5 text-[10px] font-extrabold uppercase tracking-wider text-rose-600 dark:text-rose-400">
                                <AlertTriangle size={12} />
                                <span>Concurrent Stock Discrepancy</span>
                              </div>
                              <div className="space-y-1.5">
                                {conflictItemsList.map((cItem, cIdx) => (
                                  <div
                                    key={`${cItem.productId}_${cIdx}`}
                                    className="flex items-center justify-between gap-2 text-xs bg-white/70 dark:bg-slate-900/70 px-2.5 py-1.5 rounded-xl border border-rose-500/15"
                                  >
                                    <span className="font-bold text-slate-800 dark:text-slate-200 truncate">
                                      {cItem.name || cItem.productName}
                                    </span>
                                    <div className="flex items-center gap-1.5 shrink-0 font-mono text-[11px]">
                                      <span className="px-1.5 py-0.5 rounded bg-rose-500/15 text-rose-600 dark:text-rose-300 font-bold">
                                        Billed: {cItem.requestedQty}
                                      </span>
                                      <span className="px-1.5 py-0.5 rounded bg-slate-200/80 dark:bg-slate-800 text-slate-700 dark:text-slate-300 font-bold">
                                        In Stock: {cItem.availableStock}
                                      </span>
                                    </div>
                                  </div>
                                ))}
                              </div>
                            </div>

                            {/* Resolution Actions or Resolution Audit */}
                            {isUnresolved ? (
                              <div className="grid grid-cols-2 gap-2 pt-1">
                                <button
                                  type="button"
                                  disabled={isResolving}
                                  onClick={() => handleResolveConflictVoid(conflict)}
                                  className="py-2.5 px-3 rounded-xl bg-slate-200/80 hover:bg-slate-300/80 dark:bg-slate-800 dark:hover:bg-slate-700 text-slate-800 dark:text-slate-200 font-extrabold text-[11px] transition-all active:scale-95 flex items-center justify-center gap-1.5 cursor-pointer disabled:opacity-50"
                                >
                                  <Check size={13} />
                                  <span>Confirm Voided</span>
                                </button>
                                <button
                                  type="button"
                                  disabled={isResolving}
                                  onClick={() =>
                                    handleResolveConflictForceApprove(conflict)
                                  }
                                  className="py-2.5 px-3 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white font-extrabold text-[11px] shadow-sm shadow-indigo-600/20 transition-all active:scale-95 flex items-center justify-center gap-1.5 cursor-pointer disabled:opacity-50"
                                >
                                  <Receipt size={13} />
                                  <span>Force Approve Bill</span>
                                </button>
                              </div>
                            ) : (
                              <div className="flex items-center justify-between text-[10px] font-bold text-slate-400 dark:text-slate-500 border-t border-slate-100 dark:border-white/[0.06] pt-2">
                                <span>
                                  Resolved by {conflict.resolvedBy || "Admin"}
                                </span>
                                <span>
                                  {conflict.resolvedAt
                                    ? formatDateToDMY(conflict.resolvedAt)
                                    : ""}
                                </span>
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  </div>
                ))}
              </motion.div>
            )}
          </div>

          {showClearConflictsConfirm && (
            <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
              <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                onClick={() => setShowClearConflictsConfirm(false)}
                className="absolute inset-0 bg-slate-950/60 backdrop-blur-md"
              />
              <motion.div
                initial={{ scale: 0.94, opacity: 0, y: 8 }}
                animate={{ scale: 1, opacity: 1, y: 0 }}
                exit={{ scale: 0.94, opacity: 0, y: 8 }}
                className="glass-panel relative p-6 max-w-sm w-full text-center rounded-[28px]"
              >
                <div className="w-14 h-14 rounded-full bg-[#f9dedc] dark:bg-rose-500/20 text-rose-600 dark:text-rose-400 flex items-center justify-center mx-auto mb-4">
                  <Trash2 size={24} />
                </div>
                <h3 className="text-lg font-black text-slate-900 dark:text-white mb-1.5">
                  Clear Sync Conflicts?
                </h3>
                <p className="text-xs text-slate-500 dark:text-slate-400 mb-6 leading-relaxed">
                  All recorded offline sync conflict logs will be permanently removed.
                </p>
                <div className="flex gap-2.5">
                  <button
                    onClick={() => setShowClearConflictsConfirm(false)}
                    className="flex-1 py-3 bg-[#ece6f0] hover:bg-[#e2dce7] dark:bg-slate-800 dark:hover:bg-slate-700 text-slate-700 dark:text-slate-200 font-bold rounded-full text-xs transition-all active:scale-95 cursor-pointer"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={handleClearAllConflicts}
                    className="flex-1 py-3 bg-rose-600 hover:bg-rose-700 text-white font-bold rounded-full text-xs shadow-md shadow-rose-600/25 transition-all active:scale-95 flex items-center justify-center gap-2 cursor-pointer"
                    disabled={clearingConflicts}
                  >
                    {clearingConflicts ? (
                      <M3CircularProgress size={16} strokeWidth={4} />
                    ) : (
                      "Clear All"
                    )}
                  </button>
                </div>
              </motion.div>
            </div>
          )}
          {renderActionFeedbackPortal()}
          <style>{"#bottom-nav-container { display: none !important; } #app-scroll-container { padding-bottom: calc(1.25rem + env(safe-area-inset-bottom)) !important; }"}</style>
        </motion.div>
      );
    }

    if (isViewingActivityLogs) {
      const activityTabs = [
        { id: "all", label: "All", weight: 0.56 },
        { id: "stock_modification", label: "Stock Edit", weight: 1.08 },
        { id: "failed_login", label: "Failed Login", weight: 1.24 },
        { id: "privilege_change", label: "Role Change", weight: 1.24 },
        { id: "backup", label: "Backup", weight: 0.88 },
      ] as const;
      const totalTabWeight = 5;
      const activeTabIdx = Math.max(
        0,
        activityTabs.findIndex((t) => t.id === activityFilter)
      );
      const activeTabWeight = activityTabs[activeTabIdx]?.weight ?? 1;
      const activeTabOffsetWeight = activityTabs
        .slice(0, activeTabIdx)
        .reduce((sum, t) => sum + t.weight, 0);
      const resolveTabByRatio = (ratio: number) => {
        let cumulative = 0;
        for (const t of activityTabs) {
          cumulative += t.weight / totalTabWeight;
          if (ratio <= cumulative) return t.id;
        }
        return activityTabs[activityTabs.length - 1].id;
      };

      const filteredLogs = activityLogs.filter((log) => {
        const evt = String(log.eventType || "").toLowerCase();
        const matchesCategory =
          activityFilter === "all"
            ? true
            : activityFilter === "stock_modification"
            ? evt === "stock_modification" ||
              evt === "add_product" ||
              evt === "edit_product" ||
              evt === "delete_product" ||
              evt === "restock" ||
              evt === "purge_database" ||
              evt === "sync_conflict" ||
              evt === "sync_conflict_resolved"
            : activityFilter === "failed_login"
            ? evt === "failed_login" || evt === "pin_login_bypass"
            : activityFilter === "privilege_change"
            ? evt === "privilege_change" ||
              evt === "admin_lock_account" ||
              evt === "admin_reset_attempts"
            : activityFilter === "backup"
            ? evt === "backup"
            : true;

        if (!matchesCategory) return false;
        if (!searchQuery.trim()) return true;

        const q = searchQuery.toLowerCase();
        return (
          (log.description || "").toLowerCase().includes(q) ||
          (log.userName || "").toLowerCase().includes(q) ||
          evt.includes(q)
        );
      }).sort((a, b) => (Number(b.timestamp) || 0) - (Number(a.timestamp) || 0));

      const groupedLogs: { label: string; items: any[] }[] = [];
      const groupMap = new Map<string, any[]>();
      const today = new Date();
      const yesterday = new Date();
      yesterday.setDate(today.getDate() - 1);

      const isSameCalendarDay = (d1: Date, d2: Date) =>
        d1.getDate() === d2.getDate() &&
        d1.getMonth() === d2.getMonth() &&
        d1.getFullYear() === d2.getFullYear();

      filteredLogs.forEach((log) => {
        const ts = Number(log.timestamp) || Date.now();
        const logDate = new Date(ts);
        let label = formatDateToDMY(ts) || "Recent";

        if (!isNaN(logDate.getTime())) {
          if (isSameCalendarDay(logDate, today)) {
            label = "Today";
          } else if (isSameCalendarDay(logDate, yesterday)) {
            label = "Yesterday";
          }
        }

        if (!groupMap.has(label)) {
          const arr: any[] = [];
          groupMap.set(label, arr);
          groupedLogs.push({ label, items: arr });
        }
        groupMap.get(label)!.push(log);
      });

      return (
        <motion.div
          key="admin-activity-logs-view"
          initial={{ opacity: 0, y: 15 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: 15 }}
          transition={{ duration: 0.4, ease: [0.16, 1, 0.3, 1] }}
          className="min-h-full flex flex-col pb-2 px-4 pt-10 w-full max-w-lg mx-auto"
        >
          {/* Header */}
          <header className="mb-6 flex flex-col gap-4">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3.5">
                <button
                  onClick={() => {
                    triggerHaptic("light");
                    setIsViewingActivityLogs(false);
                    setSearchQuery("");
                    setActivityFilter("all");
                  }}
                  className="m3-icon-btn flex-shrink-0 pointer-events-auto"
                >
                  <ArrowLeft size={18} />
                </button>
                <div>
                  <h1 className="text-2xl font-black tracking-tight text-slate-900 dark:text-white">
                    All{" "}
                    <span className="text-indigo-600 dark:text-indigo-400">
                      Activity Logs
                    </span>
                  </h1>
                  <p className="text-[13px] leading-snug font-medium text-slate-500 dark:text-slate-400 mt-0.5">
                    Critical system & security events
                  </p>
                </div>
              </div>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => {
                    triggerHaptic("heavy");
                    setIsRefreshingLogs(true);
                    setRefreshLogsTrigger((prev) => prev + 1);
                    setTimeout(() => {
                      setIsRefreshingLogs(false);
                    }, 900);
                  }}
                  className={`m3-icon-btn ${
                    activityLogsLoading || isRefreshingLogs
                      ? "!bg-[#e8def8] dark:!bg-indigo-500/25 !text-indigo-700 dark:!text-indigo-300 !border-indigo-300/80 dark:!border-indigo-400/40 scale-95"
                      : ""
                  }`}
                  title="Refresh log"
                >
                  {activityLogsLoading || isRefreshingLogs ? (
                    <M3CircularProgress size={18} strokeWidth={4.2} />
                  ) : (
                    <RefreshCw size={16} />
                  )}
                </button>
                <button
                  onClick={() => setShowClearLogsConfirm(true)}
                  disabled={!isRealAdmin || clearingLogs || activityLogs.length === 0}
                  className="m3-icon-btn-error"
                  title="Clear all logs"
                >
                  {clearingLogs ? (
                    <M3CircularProgress size={18} strokeWidth={4.2} />
                  ) : (
                    <Trash2 size={16} />
                  )}
                </button>
              </div>
            </div>
          </header>

          {/* Material 3 Search Bar (div:nth-of-type(1)) */}
          <div className="relative mb-4">
            <span className="absolute inset-y-0 left-0 flex items-center pl-4 pointer-events-none text-slate-400 dark:text-slate-500">
              <Search size={16} />
            </span>
            <input
              type="text"
              placeholder="Search logs by user, event, or keyword..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="m3-search-bar"
            />
            {searchQuery && (
              <button
                onClick={() => setSearchQuery("")}
                className="absolute inset-y-0 right-0 flex items-center pr-4 text-slate-400 hover:text-slate-600 dark:hover:text-slate-200"
              >
                <X size={16} />
              </button>
            )}
          </div>

          {/* Material 3 Event Quick Filter Segmented Selection (div:nth-of-type(2)) */}
          <div
            onPointerDown={(e) => {
              segDragRef.current = { startX: e.clientX, dragged: false };
            }}
            onTouchStart={(e) => {
              const touch = e.touches[0];
              if (!touch) return;
              segDragRef.current = { startX: touch.clientX, dragged: false };
            }}
            onTouchMove={(e) => {
              const touch = e.touches[0];
              if (!touch) return;
              if (Math.abs(touch.clientX - segDragRef.current.startX) <= 6) return;
              segDragRef.current.dragged = true;
              const rect = e.currentTarget.getBoundingClientRect();
              const innerWidth = Math.max(1, rect.width - 8);
              const relX = Math.max(0, Math.min(innerWidth - 1, touch.clientX - (rect.left + 4)));
              const next = resolveTabByRatio(relX / innerWidth);
              if (next && next !== activityFilter) {
                triggerHaptic("selection");
                setActivityFilter(next);
              }
            }}
            onPointerMove={(e) => {
              if (e.buttons !== 1) return;
              if (Math.abs(e.clientX - segDragRef.current.startX) <= 6) return;
              segDragRef.current.dragged = true;
              const rect = e.currentTarget.getBoundingClientRect();
              const innerWidth = Math.max(1, rect.width - 8);
              const relX = Math.max(0, Math.min(innerWidth - 1, e.clientX - (rect.left + 4)));
              const next = resolveTabByRatio(relX / innerWidth);
              if (next && next !== activityFilter) {
                triggerHaptic("selection");
                setActivityFilter(next);
              }
            }}
            style={{
              gridTemplateColumns: "0.56fr 1.08fr 1.24fr 1.24fr 0.88fr",
            }}
            className="relative grid p-1 mb-5 bg-[#ece6f0] dark:bg-[#161922] border border-slate-200/80 dark:border-white/[0.07] rounded-full select-none touch-pan-y shrink-0 isolate"
          >
            <div
              aria-hidden="true"
              style={{
                left: `calc(4px + (100% - 8px) * ${activeTabOffsetWeight / totalTabWeight})`,
                width: `calc((100% - 8px) * ${activeTabWeight / totalTabWeight})`,
                transition:
                  "left 260ms cubic-bezier(0.22, 1, 0.36, 1), width 260ms cubic-bezier(0.22, 1, 0.36, 1)",
              }}
              className="absolute top-1 bottom-1 bg-[#e0e7ff] dark:bg-indigo-500/25 border border-indigo-200/70 dark:border-indigo-400/30 rounded-full shadow-2xs dark:shadow-none pointer-events-none transform-gpu"
            />
            {activityTabs.map((tab) => {
              const isActive = activityFilter === tab.id;
              return (
                <button
                  key={tab.id}
                  type="button"
                  onClick={() => {
                    if (segDragRef.current.dragged) {
                      segDragRef.current.dragged = false;
                      return;
                    }
                    if (activityFilter === tab.id) return;
                    triggerHaptic("selection");
                    setActivityFilter(tab.id);
                  }}
                  className={`relative z-10 min-w-0 min-h-[36px] px-1 py-1.5 rounded-full text-[10.5px] sm:text-xs font-bold tracking-tight transition-colors duration-200 whitespace-nowrap outline-none flex items-center justify-center cursor-pointer ${
                    isActive
                      ? "text-indigo-950 dark:text-indigo-100"
                      : "text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200"
                  }`}
                >
                  <span className="relative z-10 leading-none">{tab.label}</span>
                </button>
              );
            })}
          </div>

          {/* Activity Logs List Container (div:nth-of-type(3)) */}
          <div className="relative flex-1 flex flex-col min-h-[320px] [overflow-anchor:none]">
            <M3RefreshIndicator
              active={activityLogsLoading || isRefreshingLogs}
              label="Syncing audit logs..."
            />

            {activityLogsPermissionError ? (
              <div
                key="logs-permission-error"
                className="text-center py-16 bg-rose-500/5 dark:bg-rose-500/5 rounded-[28px] p-6 border border-rose-500/20 flex-1 flex flex-col items-center justify-center"
              >
                <div className="w-12 h-12 rounded-full bg-rose-100 dark:bg-rose-950/40 flex items-center justify-center mx-auto mb-3 text-rose-500">
                  <ShieldOff size={20} />
                </div>
                <p className="text-sm font-bold text-rose-600 dark:text-rose-400">
                  Database Access Denied
                </p>
                <p className="text-xs text-slate-500 mt-2 leading-relaxed max-w-xs mx-auto">
                  Only registered Administrators are permitted to view system security activity logs.
                </p>
              </div>
            ) : activityLogsLoading && activityLogs.length === 0 ? (
              <div
                key="logs-loading-state"
                className="py-20 flex-1 flex flex-col items-center justify-center bg-white dark:bg-[#1b1f2b] border border-slate-200/75 dark:border-white/[0.07] rounded-[28px] shadow-[0_1px_3px_rgba(15,23,42,0.04)] dark:shadow-none"
              >
                <div className="w-14 h-14 rounded-full bg-[#e8def8]/70 dark:bg-indigo-500/15 text-indigo-600 dark:text-indigo-400 flex items-center justify-center mb-4 shadow-sm">
                  <M3CircularProgress size={28} strokeWidth={4} />
                </div>
                <p className="text-xs font-extrabold text-slate-600 dark:text-slate-300 uppercase tracking-widest">
                  Querying audit trail...
                </p>
              </div>
            ) : filteredLogs.length === 0 ? (
              <div
                key="logs-empty-state"
                className="text-center py-16 bg-white dark:bg-[#1b1f2b] border border-slate-200/75 dark:border-white/[0.07] rounded-[28px] p-6 flex-1 flex flex-col items-center justify-center shadow-[0_1px_3px_rgba(15,23,42,0.04)] dark:shadow-none"
              >
                <div className="w-12 h-12 rounded-full bg-[#ece6f0] dark:bg-slate-800 flex items-center justify-center mx-auto mb-3 text-slate-500 dark:text-slate-400">
                  <Shield size={20} />
                </div>
                <p className="text-sm font-bold text-slate-700 dark:text-slate-200">
                  No events recorded
                </p>
                <p className="text-xs text-slate-400 dark:text-slate-500 mt-1">
                  Audit log is empty or no events match your filter
                </p>
              </div>
            ) : (
              <motion.div
                key="logs-list-state"
                animate={{
                  opacity: isRefreshingLogs ? 0.72 : 1,
                  scale: isRefreshingLogs ? 0.992 : 1,
                }}
                transition={{ duration: 0.22 }}
                className="space-y-6 [overflow-anchor:none]"
              >
                {groupedLogs.map((group) => (
                  <div key={group.label} className="space-y-2.5">
                    <div className="flex items-center justify-between px-1.5">
                      <span className="text-xs font-bold uppercase tracking-wider text-slate-400 dark:text-slate-500">
                        {group.label}
                      </span>
                      <span className="text-[11px] font-semibold font-mono tabular-nums text-slate-400 dark:text-slate-500">
                        {group.items.length} {group.items.length === 1 ? "event" : "events"}
                      </span>
                    </div>
                    <div className="space-y-2.5">
                      {group.items.map((log, idx) => {
                        let badgeColor =
                          "bg-[#ece6f0] text-slate-700 dark:bg-slate-800 dark:text-slate-300";
                        if (
                          log.eventType === "failed_login" ||
                          log.eventType === "pin_login_bypass" ||
                          log.eventType === "sync_conflict"
                        )
                          badgeColor =
                            "bg-[#f9dedc] text-rose-800 dark:bg-rose-500/15 dark:text-rose-300 border border-rose-300/40 dark:border-rose-500/25";
                        if (log.eventType === "privilege_change" || log.eventType === "admin_lock_account")
                          badgeColor =
                            "bg-amber-100/80 text-amber-800 dark:bg-amber-500/15 dark:text-amber-300 border border-amber-300/40 dark:border-amber-500/25";
                        if (log.eventType === "stock_modification")
                          badgeColor =
                            "bg-[#e8def8] text-indigo-800 dark:bg-indigo-500/20 dark:text-indigo-300 border border-indigo-300/40 dark:border-indigo-500/25";
                        if (
                          log.eventType === "backup" ||
                          log.eventType === "admin_reset_attempts" ||
                          log.eventType === "sync_conflict_resolved"
                        )
                          badgeColor =
                            "bg-emerald-100/80 text-emerald-800 dark:bg-emerald-500/15 dark:text-emerald-300 border border-emerald-300/40 dark:border-emerald-500/25";

                        return (
                          <div
                            key={log.id ? `${log.id}_${idx}` : `log_${idx}`}
                            className="p-4 glass-card rounded-[24px] flex flex-col gap-2"
                          >
                            <div className="flex items-center justify-between gap-2">
                              <span
                                className={`px-3 py-1 rounded-full text-[10px] font-extrabold capitalize tracking-wide ${badgeColor}`}
                              >
                                {log.eventType
                                  ? log.eventType.replace(/_/g, " ")
                                  : "System"}
                              </span>
                              <span className="text-[10px] text-slate-400 dark:text-slate-500 font-mono font-semibold">
                                {log.timestamp
                                  ? new Date(log.timestamp).toLocaleTimeString([], {
                                      hour: "2-digit",
                                      minute: "2-digit",
                                    })
                                  : ""}{" "}
                                ·{" "}
                                {log.timestamp
                                  ? formatDateToDMY(log.timestamp)
                                  : ""}
                              </span>
                            </div>

                            <p className="text-sm font-semibold text-slate-800 dark:text-slate-100 leading-snug first-letter:uppercase">
                              {log.description}
                            </p>

                            <div className="flex items-center gap-1.5 text-[10px] font-bold text-slate-400 dark:text-slate-500 border-t border-slate-100 dark:border-white/[0.06] pt-2 mt-0.5">
                              <span className="truncate">
                                {log.userName || "System"} · {log.userEmail || "no email"}
                              </span>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                ))}
              </motion.div>
            )}
          </div>

          {showClearLogsConfirm && (
            <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
              <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                onClick={() => setShowClearLogsConfirm(false)}
                className="absolute inset-0 bg-slate-950/60 backdrop-blur-md"
              />
              <motion.div
                initial={{ scale: 0.94, opacity: 0, y: 8 }}
                animate={{ scale: 1, opacity: 1, y: 0 }}
                exit={{ scale: 0.94, opacity: 0, y: 8 }}
                className="glass-panel relative p-6 max-w-sm w-full text-center rounded-[28px]"
              >
                <div className="w-14 h-14 rounded-full bg-[#f9dedc] dark:bg-rose-500/20 text-rose-600 dark:text-rose-400 flex items-center justify-center mx-auto mb-4">
                  <Trash2 size={24} />
                </div>
                <h3 className="text-lg font-black text-slate-900 dark:text-white mb-1.5">
                  Clear Activity Logs?
                </h3>
                <p className="text-xs text-slate-500 dark:text-slate-400 mb-6 leading-relaxed">
                  All audit history will be permanently removed.
                </p>
                <div className="flex gap-2.5">
                  <button
                    onClick={() => setShowClearLogsConfirm(false)}
                    className="flex-1 py-3 bg-[#ece6f0] hover:bg-[#e2dce7] dark:bg-slate-800 dark:hover:bg-slate-700 text-slate-700 dark:text-slate-200 font-bold rounded-full text-xs transition-all active:scale-95 cursor-pointer"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={handleClearAllLogs}
                    className="flex-1 py-3 bg-rose-600 hover:bg-rose-700 text-white font-bold rounded-full text-xs shadow-md shadow-rose-600/25 transition-all active:scale-95 flex items-center justify-center gap-2 cursor-pointer"
                    disabled={clearingLogs}
                  >
                    {clearingLogs ? (
                      <M3CircularProgress size={16} strokeWidth={4} />
                    ) : (
                      "Clear Logs"
                    )}
                  </button>
                </div>
              </motion.div>
            </div>
          )}
          {renderActionFeedbackPortal()}
          <style>{"#bottom-nav-container { display: none !important; } #app-scroll-container { padding-bottom: calc(1.25rem + env(safe-area-inset-bottom)) !important; }"}</style>
        </motion.div>
      );
    }

    if (isViewingAccounts) {
      const filteredAccounts = accounts.filter(
        (acc) =>
          (acc.displayName || "")
            .toLowerCase()
            .includes(searchQuery.toLowerCase()) ||
          (acc.email || "").toLowerCase().includes(searchQuery.toLowerCase())
      );

      const totalUsers = accounts.length;
      const restrictedUsers = accounts.filter(
        (acc) => acc.isBlocked || (!acc.isAdmin && acc.failedCount >= 3)
      ).length;

      return (
        <motion.div
          key="admin-accounts-view"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.18 }}
          className="min-h-full flex flex-col pb-4 px-4 pt-12 w-full max-w-lg mx-auto [overflow-anchor:none]"
        >
          {/* Header */}
          <header className="mb-6 flex flex-col gap-4 shrink-0">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3.5">
                <button
                  onClick={() => setIsViewingAccounts(false)}
                  className="m3-icon-btn flex-shrink-0 pointer-events-auto"
                >
                  <ArrowLeft size={18} />
                </button>
                <div>
                  <h1 className="text-2xl font-black tracking-tight text-slate-900 dark:text-white">
                    User{" "}
                    <span className="text-indigo-600 dark:text-indigo-400">
                      Accounts
                    </span>
                  </h1>
                  <p className="text-xs font-semibold text-slate-400 dark:text-slate-500 mt-0.5">
                    Control levels, login blocks & account removal
                  </p>
                </div>
              </div>
              <button
                onClick={() => {
                  triggerHaptic("heavy");
                  setIsRefreshingAccounts(true);
                  fetchAccounts();
                  setTimeout(() => {
                    setIsRefreshingAccounts(false);
                  }, 900);
                }}
                className={`m3-icon-btn ${
                  accountsLoading || isRefreshingAccounts
                    ? "!bg-[#e8def8] dark:!bg-indigo-500/25 !text-indigo-700 dark:!text-indigo-300 !border-indigo-300/80 dark:!border-indigo-400/40 scale-95"
                    : ""
                }`}
                title="Refresh accounts list"
              >
                {accountsLoading || isRefreshingAccounts ? (
                  <M3CircularProgress size={18} strokeWidth={4.2} />
                ) : (
                  <RefreshCw size={16} />
                )}
              </button>
            </div>

            {/* Quick stats banner (Material 3 Surface Cards) */}
            <div className="grid grid-cols-2 gap-3">
              <div className="p-4 rounded-[24px] bg-[#f3edf7]/90 dark:bg-[#1b1f2b]/95 border border-slate-200/80 dark:border-white/[0.08] flex flex-col gap-1 shadow-2xs">
                <span className="text-[10px] font-extrabold uppercase tracking-widest text-slate-500 dark:text-slate-400">
                  Total Registered
                </span>
                <span className="text-2xl font-black font-mono tabular-nums text-slate-900 dark:text-slate-100">
                  {totalUsers}{" "}
                  <span className="text-xs font-sans font-semibold text-slate-400 dark:text-slate-500">
                    users
                  </span>
                </span>
              </div>
              <div className="p-4 rounded-[24px] bg-[#f3edf7]/90 dark:bg-[#1b1f2b]/95 border border-slate-200/80 dark:border-white/[0.08] flex flex-col gap-1 shadow-2xs">
                <span className="text-[10px] font-extrabold uppercase tracking-widest text-slate-500 dark:text-slate-400">
                  Blocked / Locked
                </span>
                <span
                  className={`text-2xl font-black font-mono tabular-nums ${
                    restrictedUsers > 0
                      ? "text-rose-600 dark:text-rose-400"
                      : "text-slate-700 dark:text-slate-300"
                  }`}
                >
                  {restrictedUsers}{" "}
                  <span className="text-xs font-sans font-semibold text-slate-400 dark:text-slate-500">
                    restricted
                  </span>
                </span>
              </div>
            </div>
          </header>

          {/* Material 3 Search Bar */}
          <div className="relative mb-5 shrink-0">
            <span className="absolute inset-y-0 left-0 flex items-center pl-4 pointer-events-none text-slate-400 dark:text-slate-500">
              <Search size={16} />
            </span>
            <input
              type="text"
              placeholder="Search by name or email address..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="m3-search-bar"
            />
            {searchQuery && (
              <button
                onClick={() => setSearchQuery("")}
                className="absolute inset-y-0 right-0 flex items-center pr-4 text-slate-400 hover:text-slate-600 dark:hover:text-slate-200"
              >
                <X size={16} />
              </button>
            )}
          </div>

          <M3RefreshIndicator
            active={accountsLoading || isRefreshingAccounts}
            label="Syncing user accounts..."
          />

          {/* Accounts List */}
          <div className="flex-1 flex flex-col min-h-[320px] [overflow-anchor:none]">
            {accountsPermissionError ? (
              <div
                key="accounts-permission-error"
                className="text-center py-16 bg-rose-500/5 dark:bg-rose-500/5 rounded-[28px] p-6 border border-rose-500/20"
              >
                <div className="w-12 h-12 rounded-full bg-rose-100 dark:bg-rose-950/40 flex items-center justify-center mx-auto mb-3 text-rose-500">
                  <ShieldOff size={20} />
                </div>
                <p className="text-sm font-bold text-rose-600 dark:text-rose-400">
                  Database Access Denied
                </p>
                <p className="text-xs text-slate-500 mt-2 leading-relaxed max-w-xs mx-auto">
                  Only registered Administrators are permitted to read or modify user account records.
                </p>
              </div>
            ) : accountsLoading && accounts.length === 0 ? (
              <div
                key="accounts-loading-state"
                className="py-20 flex-1 flex flex-col items-center justify-center bg-white dark:bg-[#1b1f2b] border border-slate-200/75 dark:border-white/[0.07] rounded-[28px] shadow-[0_1px_3px_rgba(15,23,42,0.04)] dark:shadow-none"
              >
                <div className="w-14 h-14 rounded-full bg-[#e8def8]/70 dark:bg-indigo-500/15 text-indigo-600 dark:text-indigo-400 flex items-center justify-center mb-4 shadow-sm">
                  <M3CircularProgress size={28} strokeWidth={4} />
                </div>
                <p className="text-xs font-extrabold text-slate-600 dark:text-slate-300 uppercase tracking-widest">
                  Gathering registered accounts...
                </p>
              </div>
            ) : filteredAccounts.length === 0 ? (
              <div
                key="accounts-empty-state"
                className="text-center py-16 bg-white dark:bg-[#1b1f2b] border border-slate-200/75 dark:border-white/[0.07] rounded-[28px] p-6 flex-1 flex flex-col items-center justify-center shadow-[0_1px_3px_rgba(15,23,42,0.04)] dark:shadow-none"
              >
                <div className="w-12 h-12 rounded-full bg-[#ece6f0] dark:bg-slate-800 flex items-center justify-center mx-auto mb-3 text-slate-500 dark:text-slate-400">
                  <User size={20} />
                </div>
                <p className="text-sm font-bold text-slate-700 dark:text-slate-200">
                  No active accounts matched
                </p>
                <p className="text-xs text-slate-400 dark:text-slate-500 mt-1">
                  Try expanding or clearing your search term
                </p>
              </div>
            ) : (
              <motion.div
                key="accounts-list-state"
                animate={{
                  opacity: isRefreshingAccounts ? 0.72 : 1,
                  scale: isRefreshingAccounts ? 0.992 : 1,
                }}
                transition={{ duration: 0.22 }}
                className="space-y-3.5 [overflow-anchor:none]"
              >
                {filteredAccounts.map((acc, idx) => {
                  const isBlocked = Boolean(!acc.isAdmin && acc.isBlocked);
                  const isLocked = !acc.isAdmin && !isBlocked && acc.failedCount >= 3;
                  const isSelfOrOwner =
                    acc.uid === user?.uid ||
                    Boolean(user?.uid && acc.allUids?.includes(user.uid)) ||
                    String(acc.email || "").trim().toLowerCase() === "suman.das.199972@gmail.com";
                  const isOnline =
                    !isBlocked &&
                    (acc.uid === user?.uid ||
                      (acc.isOnline === true &&
                        Date.now() - (Number(acc.lastActive) || 0) <= 60000));
                  return (
                    <div
                      key={acc.uid ? `${acc.uid}_${idx}` : `acc_${idx}`}
                      className={`p-4 sm:p-5 bg-white dark:bg-[#1b1f2b] rounded-[28px] flex flex-col gap-3.5 overflow-hidden border shadow-[0_1px_3px_rgba(15,23,42,0.04)] dark:shadow-none ${
                        isBlocked
                          ? "border-rose-500/35 dark:border-rose-500/30"
                          : "border-slate-200/80 dark:border-white/[0.08]"
                      }`}
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div className="flex items-center gap-3.5 min-w-0">
                          {/* Profile Image with unclipped outer wrapper for Block / Lock badge */}
                          <div className="relative w-14 h-14 flex-shrink-0">
                            <div
                              className={`w-full h-full rounded-full overflow-hidden bg-gradient-to-tr from-slate-100 to-slate-200 dark:from-slate-800 dark:to-slate-700 flex items-center justify-center border-2 border-white dark:border-slate-800 shadow-[0_4px_12px_rgba(0,0,0,0.06)] relative ${
                                isBlocked ? "opacity-60 grayscale-[35%]" : ""
                              }`}
                            >
                              <User
                                size={22}
                                className="text-slate-400 dark:text-slate-500 absolute"
                              />
                              {acc.customPhotoURL && (
                                <img
                                  src={acc.customPhotoURL}
                                  alt={acc.displayName}
                                  className="w-full h-full object-cover absolute inset-0 z-10"
                                  referrerPolicy="no-referrer"
                                  onError={(e) => {
                                    e.currentTarget.style.opacity = "0";
                                  }}
                                />
                              )}
                            </div>
                            {isBlocked ? (
                              <div className="absolute -bottom-0.5 -right-0.5 w-6 h-6 bg-rose-600 text-white rounded-full flex items-center justify-center shadow-md border-2 border-white dark:border-slate-800 z-20">
                                <Ban size={11} className="stroke-[3]" />
                              </div>
                            ) : isLocked ? (
                              <div className="absolute -bottom-0.5 -right-0.5 w-6 h-6 bg-amber-500 text-white rounded-full flex items-center justify-center shadow-md border-2 border-white dark:border-slate-800 z-20">
                                <Lock size={11} className="stroke-[3]" />
                              </div>
                            ) : null}
                          </div>

                          {/* Account Credentials info */}
                          <div className="min-w-0">
                            <div className="flex items-center gap-1.5 flex-wrap">
                              <h3 className="font-bold text-slate-900 dark:text-slate-100 truncate text-[15px]">
                                {acc.displayName}
                              </h3>
                              {acc.uid === user?.uid && (
                                <span className="px-2 py-0.5 rounded-full bg-[#e8def8] dark:bg-indigo-950/60 text-[9px] font-black tracking-widest text-indigo-700 dark:text-indigo-300 border border-indigo-200/60 dark:border-indigo-800/50">
                                  YOU
                                </span>
                              )}
                            </div>
                            <p className="text-xs font-semibold text-slate-400 dark:text-slate-400/90 truncate mt-0.5 max-w-[200px] sm:max-w-xs">
                              {acc.email}
                            </p>

                            {/* Heartbeat & Status badges */}
                            <div className="mt-1.5 flex items-center gap-2 flex-wrap">
                              <span className="relative flex h-2 w-2">
                                {isBlocked ? (
                                  <span className="relative inline-flex rounded-full h-2 w-2 bg-rose-500" />
                                ) : isOnline ? (
                                  <>
                                    <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75" />
                                    <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-500" />
                                  </>
                                ) : (
                                  <span className="relative inline-flex rounded-full h-2 w-2 bg-slate-400 dark:bg-slate-500" />
                                )}
                              </span>
                              <span
                                className={`text-[10px] font-extrabold uppercase tracking-widest ${
                                  isBlocked
                                    ? "text-rose-500 dark:text-rose-400"
                                    : isOnline
                                    ? "text-emerald-500"
                                    : "text-slate-400 dark:text-slate-500"
                                }`}
                              >
                                {isBlocked ? "Login Blocked" : isOnline ? "Online" : "Offline"}
                              </span>
                              {acc.isAdmin && (
                                <span className="px-2 py-0.5 rounded-full bg-amber-500/10 text-[9px] font-extrabold uppercase tracking-widest text-amber-600 dark:text-amber-400 border border-amber-500/20 ml-0.5">
                                  Admin
                                </span>
                              )}
                              {isLocked && !isBlocked && (
                                <span className="px-2 py-0.5 rounded-full bg-amber-500/10 text-[9px] font-extrabold uppercase tracking-widest text-amber-600 dark:text-amber-400 border border-amber-500/20 ml-0.5">
                                  PIN Locked
                                </span>
                              )}
                            </div>
                          </div>
                        </div>

                        {/* M3 Tonal Edit Icon Button */}
                        <button
                          disabled={!isRealAdmin}
                          onClick={() => {
                            if (!isRealAdmin) return;
                            triggerHaptic("light");
                            setEditingAccount(acc);
                            setEditName(acc.displayName);
                            setEditPhoto(acc.customPhotoURL);
                            setEditEmail(
                              acc.email === "No Email provided" ? "" : acc.email
                            );
                            setEditIsAdmin(acc.isAdmin || false);
                          }}
                          className="w-9 h-9 rounded-full flex items-center justify-center bg-[#ece6f0]/80 hover:bg-[#e2dce7] dark:bg-slate-800/70 dark:hover:bg-slate-700/80 text-slate-600 dark:text-slate-300 transition-all border border-slate-200/50 dark:border-white/[0.07] active:scale-92 shrink-0 disabled:opacity-35 disabled:pointer-events-none cursor-pointer"
                          title={
                            !isRealAdmin
                              ? "Only Administrators can edit user accounts"
                              : "Edit profile settings"
                          }
                        >
                          <Edit2 size={14} />
                        </button>
                      </div>

                      {/* Bottom Action Bar */}
                      <div className="flex items-center justify-between pt-3.5 border-t border-slate-200/60 dark:border-white/[0.07] mt-0.5 gap-2">
                        <div className="flex items-center gap-2 text-[11px] font-semibold text-slate-400 dark:text-slate-500 whitespace-nowrap shrink-0">
                          {acc.updatedAt ? (
                            <span>Synced {formatDateToDMY(acc.updatedAt)}</span>
                          ) : (
                            <span>No recent activity</span>
                          )}
                        </div>

                        <div className="flex items-center gap-2 shrink-0">
                          {/* 1. Admin Role toggle */}
                          {acc.isAdmin ? (
                            <button
                              disabled={isSelfOrOwner || !isRealAdmin}
                              onClick={() => handleToggleAdmin(acc.uid, true)}
                              className="px-3 py-1.5 rounded-full bg-amber-500/10 hover:bg-amber-500/20 dark:bg-amber-950/30 dark:hover:bg-amber-900/40 text-amber-600 dark:text-amber-400 border border-amber-500/25 dark:border-amber-500/30 active:scale-95 transition-all text-xs font-bold flex items-center gap-1.5 whitespace-nowrap disabled:opacity-35 disabled:pointer-events-none cursor-pointer"
                              title={
                                isSelfOrOwner
                                  ? "You cannot demote yourself"
                                  : "Demote from Admin"
                              }
                            >
                              <ShieldOff size={13} className="stroke-[2.5]" />
                              <span>Revoke</span>
                            </button>
                          ) : (
                            <button
                              disabled={!isRealAdmin || isBlocked}
                              onClick={() => handleToggleAdmin(acc.uid, false)}
                              className="px-3 py-1.5 rounded-full bg-slate-100 hover:bg-slate-200/80 dark:bg-slate-800/60 dark:hover:bg-slate-800 text-slate-600 dark:text-slate-300 border border-slate-200/60 dark:border-white/[0.07] active:scale-95 transition-all text-xs font-bold flex items-center gap-1.5 whitespace-nowrap disabled:opacity-35 disabled:pointer-events-none cursor-pointer"
                              title="Promote to Admin"
                            >
                              <Shield size={13} className="stroke-[2.5]" />
                              <span>Make Admin</span>
                            </button>
                          )}

                          {/* 2. Lock / Unlock control */}
                          {(isAuthenticated || isAdmin) &&
                            (isLocked ? (
                              <button
                                disabled={!isRealAdmin || isBlocked}
                                onClick={() => handleResetAttempts(acc.uid)}
                                className="px-3 py-1.5 rounded-full bg-emerald-500/10 hover:bg-emerald-500/20 dark:bg-emerald-950/30 dark:hover:bg-emerald-900/40 text-emerald-600 dark:text-emerald-400 border border-emerald-500/25 dark:border-emerald-500/30 active:scale-95 transition-all text-xs font-bold flex items-center gap-1.5 whitespace-nowrap disabled:opacity-35 disabled:pointer-events-none cursor-pointer"
                              >
                                <UserCheck size={13} className="stroke-[2.6]" />
                                <span>Unlock</span>
                              </button>
                            ) : (
                              <button
                                disabled={isSelfOrOwner || acc.isAdmin || !isRealAdmin || isBlocked}
                                onClick={() => handleLockAccount(acc.uid)}
                                className="px-3 py-1.5 rounded-full bg-rose-500/10 hover:bg-rose-500/20 dark:bg-rose-950/25 dark:hover:bg-rose-900/35 text-rose-600 dark:text-rose-400 border border-rose-500/20 dark:border-rose-500/25 active:scale-95 transition-all text-xs font-bold flex items-center gap-1.5 whitespace-nowrap disabled:opacity-35 disabled:pointer-events-none cursor-pointer"
                              >
                                <UserX size={13} className="stroke-[2.5]" />
                                <span>Lock</span>
                              </button>
                            ))}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </motion.div>
            )}
          </div>

          {/* Delete User Account Confirmation Modal */}
          <AnimatePresence>
            {accountToDelete && (
              <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
                <motion.div
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  transition={{ duration: 0.14 }}
                  onClick={() => !isDeletingAccount && setAccountToDelete(null)}
                  className="absolute inset-0 bg-slate-950/65"
                />
                <motion.div
                  initial={{ scale: 0.94, opacity: 0, y: 8 }}
                  animate={{ scale: 1, opacity: 1, y: 0 }}
                  exit={{ scale: 0.94, opacity: 0, y: 8 }}
                  transition={{ duration: 0.16, ease: [0.22, 1, 0.36, 1] }}
                  className="glass-panel relative z-10 p-6 max-w-sm w-full text-center rounded-[28px] border border-slate-200/80 dark:border-slate-700/60 shadow-2xl"
                >
                  <div className="w-14 h-14 rounded-full bg-[#f9dedc] dark:bg-rose-500/20 text-rose-600 dark:text-rose-400 flex items-center justify-center mx-auto mb-4">
                    <Trash2 size={24} />
                  </div>
                  <h3 className="text-lg font-black text-slate-900 dark:text-white mb-1.5">
                    Delete User Account?
                  </h3>
                  <p className="text-xs font-bold text-slate-700 dark:text-slate-200 truncate px-2">
                    {accountToDelete.displayName} ({accountToDelete.email})
                  </p>
                  <p className="text-xs text-slate-500 dark:text-slate-400 mt-2 mb-6 leading-relaxed">
                    This account will be permanently deleted from the database. They will be signed out immediately, and can sign in again later if they want to create a brand-new account.
                  </p>
                  <div className="flex gap-2.5">
                    <button
                      type="button"
                      disabled={isDeletingAccount}
                      onClick={() => setAccountToDelete(null)}
                      className="flex-1 py-3 bg-[#ece6f0] hover:bg-[#e2dce7] dark:bg-slate-800 dark:hover:bg-slate-700 text-slate-700 dark:text-slate-200 font-bold rounded-full text-xs transition-all active:scale-95 cursor-pointer disabled:opacity-50"
                    >
                      Cancel
                    </button>
                    <button
                      type="button"
                      disabled={isDeletingAccount}
                      onClick={handleDeleteUserAccount}
                      className="flex-1 py-3 bg-rose-600 hover:bg-rose-700 text-white font-bold rounded-full text-xs shadow-md shadow-rose-600/25 transition-all active:scale-95 flex items-center justify-center gap-2 cursor-pointer disabled:opacity-60"
                    >
                      {isDeletingAccount ? (
                        <M3CircularProgress size={16} strokeWidth={4} />
                      ) : (
                        <>
                          <Trash2 size={14} />
                          <span>Delete Account</span>
                        </>
                      )}
                    </button>
                  </div>
                </motion.div>
              </div>
            )}
          </AnimatePresence>

          {/* Edit Account Modal with compact, non-scrolling layout */}
          <AnimatePresence>
            {editingAccount && (() => {
              const hasAccountEditChanges =
                editName.trim().length > 0 &&
                (editName.trim() !== (editingAccount.displayName || "").trim() ||
                  (editPhoto || "").trim() !== (editingAccount.customPhotoURL || "").trim() ||
                  Boolean(editIsAdmin) !== Boolean(editingAccount.isAdmin));

              return (
                <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
                  <motion.div
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0 }}
                    onClick={() => setEditingAccount(null)}
                    className="absolute inset-0 bg-slate-950/60 backdrop-blur-md"
                  />
                  <motion.div
                    initial={{ scale: 0.95, y: 15, opacity: 0 }}
                    animate={{ scale: 1, y: 0, opacity: 1 }}
                    exit={{ scale: 0.95, y: 15, opacity: 0 }}
                    transition={{ type: "spring", damping: 25, stiffness: 350, mass: 0.8 }}
                    className="glass-panel w-full max-w-sm p-5 relative z-10 rounded-[2rem] border border-slate-200/80 dark:border-slate-700/60 shadow-2xl overflow-hidden"
                  >
                    <button
                      onClick={() => setEditingAccount(null)}
                      className="absolute top-3.5 right-3.5 w-8 h-8 rounded-full bg-slate-100 dark:bg-slate-800 flex items-center justify-center text-slate-500 dark:text-slate-400 hover:bg-slate-200 dark:hover:bg-slate-700 transition-all outline-none"
                    >
                      <X size={15} />
                    </button>

                    <div className="text-center mb-3.5">
                      {/* Active photo view with upload triggers and haptic feedback */}
                      <div
                        onClick={async () => {
                          triggerHaptic("light");
                          if (Capacitor.isNativePlatform()) {
                            try {
                              const photo = await CapCamera.getPhoto({
                                quality: 85,
                                allowEditing: false,
                                resultType: CameraResultType.DataUrl,
                                source: CameraSource.Photos,
                              });
                              if (photo.dataUrl) {
                                setUploading(true);
                                setUploadError("");
                                const res = await fetch(photo.dataUrl);
                                const blob = await res.blob();
                                const file = new File([blob], "avatar.jpg", {
                                  type: "image/jpeg",
                                });
                                const compressedUrl = await compressProfileImage(file);
                                setEditPhoto(compressedUrl);
                                triggerHaptic("success");
                              }
                            } catch (err: any) {
                              const msg = String(err?.message || err || "");
                              if (!msg.toLowerCase().includes("cancel")) {
                                document
                                  .getElementById("adminAccountImageUpload")
                                  ?.click();
                              }
                            } finally {
                              setUploading(false);
                            }
                          } else {
                            document
                              .getElementById("adminAccountImageUpload")
                              ?.click();
                          }
                        }}
                        className="relative group cursor-pointer w-20 h-20 rounded-full overflow-hidden bg-gradient-to-tr from-indigo-500 to-purple-600 flex items-center justify-center p-1 mx-auto mb-1.5 shadow-lg shadow-indigo-500/15 hover:scale-105 active:scale-95 transition-all duration-300 border border-slate-200/20"
                      >
                        <div className="w-full h-full rounded-full bg-white dark:bg-slate-800 overflow-hidden flex items-center justify-center relative">
                          {uploading ? (
                            <div className="w-6 h-6 border-2 border-indigo-500 border-t-transparent rounded-full animate-spin" />
                          ) : (
                            <>
                              <User
                                size={30}
                                className="text-slate-400 dark:text-slate-500 absolute"
                              />
                              {editPhoto && (
                                <img
                                  src={editPhoto}
                                  alt="Preview"
                                  className="w-full h-full object-cover transition-transform duration-300 group-hover:scale-110 absolute inset-0 z-10"
                                  referrerPolicy="no-referrer"
                                  onError={(e) => {
                                    e.currentTarget.style.opacity = "0";
                                  }}
                                />
                              )}
                            </>
                          )}
                          <div className="absolute inset-0 bg-slate-950/40 flex flex-col items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity z-20">
                            <Camera className="text-white" size={20} />
                          </div>
                        </div>
                      </div>
                      <input
                        id="adminAccountImageUpload"
                        type="file"
                        accept="image/*"
                        className="hidden"
                        onChange={async (e) => {
                          const file = e.target.files?.[0];
                          e.target.value = "";
                          if (file) {
                            if (file.size > 20000000) {
                              setUploadError("Image must be less than 20MB");
                              triggerHaptic("error");
                              return;
                            }
                            setUploading(true);
                            setUploadError("");
                            try {
                              const compressedUrl = await compressProfileImage(
                                file
                              );
                              setEditPhoto(compressedUrl);
                              triggerHaptic("success");
                            } catch (err) {
                              console.error(err);
                              setUploadError("Failed to load image");
                              triggerHaptic("error");
                            } finally {
                              setUploading(false);
                            }
                          }
                        }}
                      />

                      {uploadError ? (
                        <p className="text-[11px] font-bold text-rose-500 mt-1">
                          {uploadError}
                        </p>
                      ) : (
                        <p
                          className="text-[10px] font-extrabold uppercase tracking-wider text-slate-400 dark:text-slate-400 mt-0.5 cursor-pointer hover:text-indigo-500 dark:hover:text-indigo-400 transition-colors"
                          onClick={() =>
                            document
                              .getElementById("adminAccountImageUpload")
                              ?.click()
                          }
                        >
                          Tap photo to upload image
                        </p>
                      )}

                      <h3 className="text-base font-black text-slate-900 dark:text-slate-100 mt-1.5">
                        Edit Profile
                      </h3>
                      <p className="text-xs font-semibold text-slate-400 dark:text-slate-400 mt-0.5 truncate px-2">
                        {editingAccount.email}
                      </p>
                    </div>

                    <div className="space-y-3 mb-4">
                      <div>
                        <label className="block text-[10px] font-extrabold uppercase tracking-widest text-slate-400 dark:text-slate-400 mb-1.5 pl-1">
                          Display Name
                        </label>
                        <input
                          type="text"
                          placeholder="E.g. Suman Das"
                          value={editName}
                          onChange={(e) => setEditName(e.target.value)}
                          className="w-full px-3.5 py-2.5 rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950/50 text-sm font-semibold text-slate-900 dark:text-slate-100 focus:outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500/30"
                        />
                      </div>

                      {editingAccount.uid !== user?.uid &&
                        !(
                          Array.isArray(editingAccount.allUids) &&
                          Boolean(user?.uid && editingAccount.allUids.includes(user.uid))
                        ) &&
                        String(editingAccount.email || "").trim().toLowerCase() !==
                          "suman.das.199972@gmail.com" && (
                          <>
                            <div className="flex items-center justify-between p-3 rounded-2xl border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950/50">
                              <div className="pr-2">
                                <span className="block text-xs font-extrabold text-slate-800 dark:text-slate-200">
                                  Administrator Role
                                </span>
                                <span className="block text-[10px] text-slate-400 dark:text-slate-500 leading-snug mt-0.5">
                                  Allow this user to authenticate on the Admin Dashboard
                                </span>
                              </div>
                              <button
                                type="button"
                                role="switch"
                                disabled={!isRealAdmin || Boolean(editingAccount.isBlocked)}
                                aria-checked={editIsAdmin}
                                onClick={() => {
                                  if (!isRealAdmin || editingAccount.isBlocked) {
                                    return;
                                  }
                                  triggerHaptic("selection");
                                  setEditIsAdmin(!editIsAdmin);
                                }}
                                className={`relative w-[52px] h-[32px] shrink-0 rounded-full transition-colors duration-200 flex items-center p-1 cursor-pointer outline-none disabled:opacity-35 disabled:pointer-events-none ${
                                  editIsAdmin
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
                                    editIsAdmin
                                      ? "w-6 h-6 bg-white dark:bg-indigo-950"
                                      : "w-4 h-4 ml-0.5 bg-slate-600 dark:bg-slate-300"
                                  }`}
                                />
                              </button>
                            </div>

                            {/* Account Access & Removal Controls inside Edit Modal */}
                            <div>
                              <label className="block text-[10px] font-extrabold uppercase tracking-widest text-slate-400 dark:text-slate-400 mb-1.5 pl-1">
                                Account Access & Removal
                              </label>
                              <div className="grid grid-cols-2 gap-2.5">
                                {editingAccount.isBlocked ? (
                                  <button
                                    type="button"
                                    disabled={!isRealAdmin}
                                    onClick={() => handleToggleBlockAccount(editingAccount)}
                                    className="py-2.5 px-3 rounded-xl bg-emerald-500/15 hover:bg-emerald-500/25 dark:bg-emerald-950/40 dark:hover:bg-emerald-900/50 text-emerald-600 dark:text-emerald-400 border border-emerald-500/30 font-extrabold text-xs flex items-center justify-center gap-1.5 active:scale-95 transition-all cursor-pointer disabled:opacity-35 disabled:pointer-events-none"
                                  >
                                    <Unlock size={14} className="stroke-[2.5] shrink-0" />
                                    <span>Unblock Login</span>
                                  </button>
                                ) : (
                                  <button
                                    type="button"
                                    disabled={!isRealAdmin || Boolean(editingAccount.isAdmin) || editIsAdmin}
                                    onClick={() => handleToggleBlockAccount(editingAccount)}
                                    className="py-2.5 px-3 rounded-xl bg-amber-500/10 hover:bg-amber-500/20 dark:bg-amber-950/30 dark:hover:bg-amber-900/40 text-amber-600 dark:text-amber-400 border border-amber-500/25 font-extrabold text-xs flex items-center justify-center gap-1.5 active:scale-95 transition-all cursor-pointer disabled:opacity-35 disabled:pointer-events-none"
                                  >
                                    <Ban size={14} className="stroke-[2.5] shrink-0" />
                                    <span>Block Login</span>
                                  </button>
                                )}

                                <button
                                  type="button"
                                  disabled={!isRealAdmin || Boolean(editingAccount.isAdmin) || editIsAdmin}
                                  onClick={() => {
                                    triggerHaptic("medium");
                                    const target = editingAccount;
                                    setEditingAccount(null);
                                    setAccountToDelete(target);
                                  }}
                                  className="py-2.5 px-3 rounded-xl bg-rose-500/10 hover:bg-rose-500/20 dark:bg-rose-950/30 dark:hover:bg-rose-900/40 text-rose-600 dark:text-rose-400 border border-rose-500/25 font-extrabold text-xs flex items-center justify-center gap-1.5 active:scale-95 transition-all cursor-pointer disabled:opacity-35 disabled:pointer-events-none"
                                >
                                  <Trash2 size={14} className="stroke-[2.5] shrink-0" />
                                  <span>Delete Account</span>
                                </button>
                              </div>
                            </div>
                          </>
                        )}
                    </div>

                    <div className="grid grid-cols-2 gap-3">
                      <button
                        onClick={() => setEditingAccount(null)}
                        className="py-2.5 bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 text-slate-700 dark:text-slate-300 font-extrabold rounded-xl text-xs active:scale-95 transition-all cursor-pointer"
                      >
                        Cancel
                      </button>
                      <button
                        disabled={!hasAccountEditChanges || isProcessing || uploading}
                        onClick={handleSaveAccount}
                        className="py-2.5 bg-indigo-600 hover:bg-indigo-700 disabled:bg-slate-200 dark:disabled:bg-slate-800 disabled:text-slate-400 dark:disabled:text-slate-600 text-white font-extrabold rounded-xl text-xs shadow-md shadow-indigo-600/10 disabled:shadow-none active:scale-95 transition-all cursor-pointer disabled:cursor-not-allowed"
                      >
                        Save Changes
                      </button>
                    </div>
                  </motion.div>
                </div>
              );
            })()}
          </AnimatePresence>
          {renderActionFeedbackPortal()}
          <style>{"#bottom-nav-container { display: none !important; } #app-scroll-container { padding-bottom: calc(1.25rem + env(safe-area-inset-bottom)) !important; }"}</style>
        </motion.div>
      );
    }

    if (isViewingProductCosts) {
      const productsWithCostMeta = globalProducts.map((p) => {
        const fifo = getProductFifoStatus(p);
        const savedCost = fifo.activeUnitCost;
        return {
          ...p,
          savedCost,
          fifo,
        };
      });

      const configuredCount = productsWithCostMeta.filter((p) => p.savedCost > 0).length;
      const missingCount = Math.max(0, globalProducts.length - configuredCount);

      const filteredCostProducts = productsWithCostMeta.filter((p) => {
        if (costFilter === "set" && p.savedCost <= 0) return false;
        if (costFilter === "unset" && p.savedCost > 0) return false;
        if (!searchQuery.trim()) return true;
        return (p.name || "").toLowerCase().includes(searchQuery.toLowerCase().trim());
      });

      return (
        <motion.div
          key="admin-product-costs-view"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.18 }}
          className="min-h-full flex flex-col pb-6 px-4 pt-10 w-full max-w-lg mx-auto [overflow-anchor:none]"
        >
          {/* Clean Single-Line Header */}
          <header className="mb-5 flex flex-col gap-4 shrink-0">
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-3 min-w-0">
                <button
                  type="button"
                  onClick={() => {
                    triggerHaptic("light");
                    setIsViewingProductCosts(false);
                    setSearchQuery("");
                    setCostFilter("all");
                    if (window.location.search.includes("view=costs")) {
                      navigate("/admin", { replace: true });
                    }
                  }}
                  className="m3-icon-btn flex-shrink-0 pointer-events-auto"
                >
                  <ArrowLeft size={18} />
                </button>
                <div className="min-w-0">
                  <h1 className="text-xl sm:text-2xl font-black tracking-tight text-slate-900 dark:text-white truncate">
                    Buy{" "}
                    <span className="text-indigo-600 dark:text-indigo-400">
                      Prices
                    </span>
                  </h1>
                  <p className="text-xs font-medium text-slate-500 dark:text-slate-400 truncate mt-0.5">
                    Current stock locks old price first; unset items add ₹0 profit
                  </p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => {
                  triggerHaptic("selection");
                  navigate("/analytics");
                }}
                className="min-h-[38px] px-3.5 py-2 rounded-full bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-bold flex items-center gap-1.5 shadow-sm transition-all active:scale-95 shrink-0 cursor-pointer"
              >
                <BarChart3 size={14} />
                <span>Profit</span>
              </button>
            </div>

            {/* Clean 2-Card Summary Strip */}
            <div className="grid grid-cols-2 gap-3">
              <div className="p-3.5 rounded-[22px] bg-[#f3edf7]/90 dark:bg-[#1b1f2b]/95 border border-slate-200/80 dark:border-white/[0.08] flex flex-col gap-0.5">
                <span className="text-[10px] font-extrabold uppercase tracking-widest text-slate-500 dark:text-slate-400">
                  Price Saved
                </span>
                <div className="flex items-baseline gap-1 mt-0.5">
                  <span className="text-2xl font-black font-mono tabular-nums text-slate-900 dark:text-slate-100">
                    {configuredCount}
                  </span>
                  <span className="text-xs font-semibold font-mono tabular-nums text-slate-400 dark:text-slate-500">
                    / {globalProducts.length} items
                  </span>
                </div>
              </div>
              <div className="p-3.5 rounded-[22px] bg-[#f3edf7]/90 dark:bg-[#1b1f2b]/95 border border-slate-200/80 dark:border-white/[0.08] flex flex-col gap-0.5">
                <span className="text-[10px] font-extrabold uppercase tracking-widest text-slate-500 dark:text-slate-400">
                  Needs Buy Price
                </span>
                <div className="flex items-baseline gap-1.5 mt-0.5">
                  <span
                    className={`text-2xl font-black font-mono tabular-nums ${
                      missingCount > 0
                        ? "text-amber-600 dark:text-amber-400"
                        : "text-emerald-600 dark:text-emerald-400"
                    }`}
                  >
                    {missingCount}
                  </span>
                  <span className="text-xs font-semibold text-slate-400 dark:text-slate-500">
                    {missingCount === 0 ? "all set" : "₹0 profit until set"}
                  </span>
                </div>
              </div>
            </div>
          </header>

          {/* Search Bar */}
          <div className="relative mb-3.5 shrink-0">
            <span className="absolute inset-y-0 left-0 flex items-center pl-4 pointer-events-none text-slate-400 dark:text-slate-500">
              <Search size={16} />
            </span>
            <input
              type="text"
              placeholder="Search products..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="m3-search-bar"
            />
            {searchQuery && (
              <button
                type="button"
                onClick={() => setSearchQuery("")}
                className="absolute inset-y-0 right-0 flex items-center pr-4 text-slate-400 hover:text-slate-600 dark:hover:text-slate-200"
              >
                <X size={16} />
              </button>
            )}
          </div>

          {/* Segmented Filter Bar */}
          <div
            onPointerDown={(e) => {
              segDragRef.current = { startX: e.clientX, dragged: false };
            }}
            onTouchStart={(e) => {
              const touch = e.touches[0];
              if (!touch) return;
              segDragRef.current = { startX: touch.clientX, dragged: false };
            }}
            onTouchMove={(e) => {
              const touch = e.touches[0];
              if (!touch) return;
              if (Math.abs(touch.clientX - segDragRef.current.startX) <= 6) return;
              segDragRef.current.dragged = true;
              const rect = e.currentTarget.getBoundingClientRect();
              const innerWidth = Math.max(1, rect.width - 8);
              const tabs = ["all", "set", "unset"] as const;
              const relX = Math.max(0, Math.min(innerWidth - 1, touch.clientX - (rect.left + 4)));
              const idx = Math.min(
                tabs.length - 1,
                Math.max(0, Math.floor((relX / innerWidth) * tabs.length))
              );
              const next = tabs[idx];
              if (next && next !== costFilter) {
                triggerHaptic("selection");
                setCostFilter(next);
              }
            }}
            onPointerMove={(e) => {
              if (e.buttons !== 1) return;
              if (Math.abs(e.clientX - segDragRef.current.startX) <= 6) return;
              segDragRef.current.dragged = true;
              const rect = e.currentTarget.getBoundingClientRect();
              const innerWidth = Math.max(1, rect.width - 8);
              const tabs = ["all", "set", "unset"] as const;
              const relX = Math.max(0, Math.min(innerWidth - 1, e.clientX - (rect.left + 4)));
              const idx = Math.min(
                tabs.length - 1,
                Math.max(0, Math.floor((relX / innerWidth) * tabs.length))
              );
              const next = tabs[idx];
              if (next && next !== costFilter) {
                triggerHaptic("selection");
                setCostFilter(next);
              }
            }}
            className="relative grid grid-cols-3 p-1 mb-4 bg-[#ece6f0] dark:bg-[#161922] border border-slate-200/80 dark:border-white/[0.07] rounded-full select-none touch-pan-y shrink-0 isolate"
          >
            <div
              aria-hidden="true"
              style={{
                width: "calc((100% - 8px) / 3)",
                transform: `translate3d(${
                  (["all", "set", "unset"] as const).indexOf(costFilter) * 100
                }%, 0, 0)`,
                transition: "transform 260ms cubic-bezier(0.22, 1, 0.36, 1)",
              }}
              className="absolute top-1 bottom-1 left-1 bg-[#e0e7ff] dark:bg-indigo-500/25 border border-indigo-200/70 dark:border-indigo-400/30 rounded-full shadow-2xs dark:shadow-none pointer-events-none transform-gpu will-change-transform"
            />
            {(
              [
                { id: "all", label: `All (${globalProducts.length})` },
                { id: "set", label: `Saved (${configuredCount})` },
                { id: "unset", label: `Needs Price (${missingCount})` },
              ] as const
            ).map((tab) => {
              const active = costFilter === tab.id;
              return (
                <button
                  key={tab.id}
                  type="button"
                  onClick={() => {
                    if (segDragRef.current.dragged) {
                      segDragRef.current.dragged = false;
                      return;
                    }
                    if (costFilter === tab.id) return;
                    triggerHaptic("selection");
                    setCostFilter(tab.id);
                  }}
                  className={`relative z-10 min-w-0 min-h-[36px] px-2 py-1.5 rounded-full text-xs font-bold transition-colors duration-150 flex items-center justify-center cursor-pointer whitespace-nowrap outline-none ${
                    active
                      ? "text-indigo-950 dark:text-indigo-100"
                      : "text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200"
                  }`}
                >
                  <span className="relative z-10 truncate">{tab.label}</span>
                </button>
              );
            })}
          </div>

          {/* Stable height & scroll-anchor-isolated Product Buy Price Cards container */}
          <div className="flex-1 flex flex-col min-h-[320px] [overflow-anchor:none]">
            {filteredCostProducts.length === 0 ? (
              <div
                key="cost-empty-state"
                className="bg-white dark:bg-[#1b1f2b] border border-slate-200/75 dark:border-white/[0.07] rounded-[28px] py-14 px-6 text-center flex-1 flex flex-col items-center justify-center gap-2 shadow-[0_1px_3px_rgba(15,23,42,0.04)] dark:shadow-none"
              >
                <Package size={42} className="text-slate-300 dark:text-slate-600 mb-1" />
                <p className="text-base font-bold text-slate-800 dark:text-slate-200">
                  {costFilter === "set"
                    ? "No saved buy prices yet"
                    : costFilter === "unset"
                    ? "All buy prices saved"
                    : "No matching products"}
                </p>
                <p className="text-xs text-slate-500 dark:text-slate-400 max-w-xs leading-relaxed">
                  {costFilter === "unset"
                    ? "Every product in your catalog already has a saved buy price!"
                    : costFilter === "set"
                    ? "No products have a buy price saved yet. Enter an amount on any item to save it."
                    : searchQuery
                    ? "No products match your search query."
                    : "Add products in the Stock tab to configure their store buy price."}
                </p>
                {(costFilter !== "all" || searchQuery) && (
                  <button
                    type="button"
                    onClick={() => {
                      triggerHaptic("light");
                      setCostFilter("all");
                      setSearchQuery("");
                    }}
                    className="mt-2 px-4 py-2 rounded-full bg-indigo-50 dark:bg-indigo-500/15 text-indigo-600 dark:text-indigo-300 text-xs font-bold hover:bg-indigo-100 dark:hover:bg-indigo-500/25 transition-colors cursor-pointer"
                  >
                    Show All Products
                  </button>
                )}
              </div>
            ) : (
              <div key="cost-list-state" className="space-y-3 [overflow-anchor:none]">
                {filteredCostProducts.map((p, idx) => {
                  const pid = p.id || `prod_${idx}`;
                  const imgUrl = getImageUrl(p.image);
                  const fifo = p.fifo;
                  const defaultInputCost =
                    fifo.nextUnitCost > 0 ? fifo.nextUnitCost : p.savedCost;
                  const hasDraft = Object.prototype.hasOwnProperty.call(quickCostDrafts, pid);
                  const inputVal = hasDraft
                    ? quickCostDrafts[pid]
                    : defaultInputCost > 0
                    ? String(defaultInputCost)
                    : "";

                  const numericDraft = parseFloat(inputVal);
                  const previewCost =
                    hasDraft && !isNaN(numericDraft) && numericDraft >= 0
                      ? numericDraft
                      : p.savedCost;
                  const unitProfit = Number(p.price || 0) - previewCost;
                  const isModified =
                    hasDraft &&
                    inputVal.trim() !== "" &&
                    !isNaN(numericDraft) &&
                    numericDraft !== defaultInputCost;
                  const isJustSaved = justSavedCostProductId === p.id;

                  return (
                    <div
                      key={pid}
                      className="bg-white dark:bg-[#1b1f2b] p-4 rounded-[24px] flex flex-col gap-3.5 border border-slate-200/80 dark:border-white/[0.08] shadow-[0_1px_3px_rgba(15,23,42,0.04)] dark:shadow-none"
                    >
                      {/* Top Row: Thumbnail + Full-Width Name & Single-Line MRP/Stock + Saved Status */}
                      <div className="flex items-center justify-between gap-3">
                        <div className="flex items-center gap-3 min-w-0 flex-1">
                          <div className="w-12 h-12 rounded-2xl overflow-hidden shrink-0 bg-slate-100 dark:bg-slate-800 border border-slate-200/60 dark:border-slate-700/60">
                            {imgUrl ? (
                              <img
                                src={imgUrl}
                                alt={p.name}
                                className="w-full h-full object-cover"
                              />
                            ) : (
                              <ProductImagePlaceholder
                                name={p.name}
                                category={p.category}
                                size={22}
                                rounded="rounded-2xl"
                                className="w-full h-full"
                                showBorder={false}
                                showShadow={false}
                              />
                            )}
                          </div>
                          <div className="min-w-0 flex-1">
                            <h3 className="font-bold text-[15px] text-slate-900 dark:text-slate-100 truncate leading-snug">
                              {p.name}
                            </h3>
                            <div className="flex items-center gap-2 text-xs text-slate-500 dark:text-slate-400 font-mono tabular-nums mt-0.5 whitespace-nowrap overflow-hidden">
                              <span className="font-semibold text-slate-700 dark:text-slate-300">
                                Sell: ₹{formatPrice(p.price)}
                              </span>
                              <span className="text-slate-300 dark:text-slate-600">•</span>
                              <span className="truncate">{p.stock} in stock</span>
                            </div>
                          </div>
                        </div>

                        {/* Right Status Pill: Shows Profit or Loss per Unit when Buy Price is Set */}
                        <div className="shrink-0 text-right">
                          {previewCost > 0 ? (
                            <div className="flex flex-col items-end">
                              <span
                                className={`px-2.5 py-1 rounded-xl text-[11px] font-mono tabular-nums font-extrabold border ${
                                  unitProfit > 0
                                    ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/20"
                                    : unitProfit < 0
                                    ? "bg-rose-500/10 text-rose-600 dark:text-rose-400 border-rose-500/20"
                                    : "bg-slate-500/10 text-slate-600 dark:text-slate-300 border-slate-500/20"
                                }`}
                              >
                                {unitProfit > 0
                                  ? `+₹${formatPrice(unitProfit)}/u profit`
                                  : unitProfit < 0
                                  ? `-₹${formatPrice(Math.abs(unitProfit))}/u loss`
                                  : `₹0/u profit`}
                              </span>
                            </div>
                          ) : (
                            <span className="px-2.5 py-1 rounded-xl text-[11px] font-bold bg-amber-500/10 text-amber-600 dark:text-amber-400 border border-amber-500/20">
                              No buy price (₹0 profit)
                            </span>
                          )}
                        </div>
                      </div>

                      {/* FIFO Stock-Locked Queue Banner (shown when old stock is locked at legacy buy price) */}
                      {fifo.hasLockedLegacyStock && (
                        <div className="px-3 py-2 rounded-xl bg-indigo-500/10 dark:bg-indigo-500/15 border border-indigo-500/20 flex items-center justify-between gap-2 text-[11px] font-mono tabular-nums">
                          <span className="text-indigo-700 dark:text-indigo-300 font-bold truncate">
                            First {fifo.lockedLegacyUnits} stock @ ₹{formatPrice(fifo.activeUnitCost)}/u (+₹
                            {formatPrice(Math.max(0, Number(p.price || 0) - fifo.activeUnitCost))}/u)
                          </span>
                          <span className="text-slate-500 dark:text-slate-400 font-semibold shrink-0">
                            → Next: ₹{formatPrice(fifo.nextUnitCost)}/u
                          </span>
                        </div>
                      )}

                      {/* Bottom Row: Permanent Buy Price Input + Save / Update Button */}
                      <div className="flex items-center gap-2.5 pt-2.5 border-t border-slate-200/60 dark:border-white/[0.06]">
                        <div className="relative flex-1">
                          <span className="absolute left-3.5 top-1/2 -translate-y-1/2 text-xs font-mono font-bold text-slate-400 dark:text-slate-500 pointer-events-none">
                            Buy ₹
                          </span>
                          <input
                            type="number"
                            min="0"
                            step="0.5"
                            placeholder="Enter buy cost per unit"
                            value={inputVal}
                            onChange={(e) =>
                              setQuickCostDrafts((prev) => ({
                                ...prev,
                                [pid]: e.target.value,
                              }))
                            }
                            onKeyDown={(e) => {
                              if (e.key === "Enter" && inputVal.trim() !== "") {
                                e.currentTarget.blur();
                                handleSaveProductBuyPrice(p, inputVal);
                              }
                            }}
                            className="w-full h-11 pl-14 pr-3 rounded-xl bg-slate-50 dark:bg-slate-900/90 border border-slate-200/90 dark:border-slate-800 text-sm font-mono tabular-nums font-bold text-slate-900 dark:text-white placeholder:font-sans placeholder:font-normal placeholder:text-xs placeholder:text-slate-400 focus:outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500/30 transition-all"
                          />
                        </div>

                        <button
                          type="button"
                          disabled={
                            savingCostProductId === p.id ||
                            inputVal.trim() === ""
                          }
                          onClick={() => handleSaveProductBuyPrice(p, inputVal)}
                          className={`h-11 px-4 rounded-xl text-xs font-bold flex items-center justify-center gap-1.5 shrink-0 transition-all active:scale-95 cursor-pointer disabled:cursor-default ${
                            isJustSaved
                              ? "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 border border-emerald-500/25"
                              : p.savedCost > 0 && !isModified
                              ? "bg-emerald-500/15 hover:bg-emerald-500/25 text-emerald-600 dark:text-emerald-400 border border-emerald-500/25"
                              : "bg-indigo-600 hover:bg-indigo-500 disabled:opacity-40 text-white shadow-sm shadow-indigo-600/20"
                          }`}
                        >
                          {savingCostProductId === p.id ? (
                            <M3CircularProgress size={14} strokeWidth={4} />
                          ) : isJustSaved ? (
                            <>
                              <Check size={14} />
                              <span>Updated</span>
                            </>
                          ) : p.savedCost > 0 ? (
                            <span>Update</span>
                          ) : (
                            <span>Save Price</span>
                          )}
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {renderActionFeedbackPortal()}
          <style>{"#bottom-nav-container { display: none !important; } #app-scroll-container { padding-bottom: calc(1.25rem + env(safe-area-inset-bottom)) !important; }"}</style>
        </motion.div>
      );
    }

    return (
      <motion.div
        key="admin-dashboard-view"
        initial={{ opacity: 0, scale: 0.98 }}
        animate={{ opacity: 1, scale: 1 }}
        exit={{
          opacity: 0,
          scale: 0.98,
          transition: { duration: 0.3, ease: [0.16, 1, 0.3, 1] },
        }}
        transition={{ duration: 0.45, ease: [0.16, 1, 0.3, 1] }}
        className="pb-2 px-4 pt-12 max-w-lg mx-auto"
      >
        <header className="mb-8 p-4 rounded-[2rem] bg-white/80 dark:bg-slate-900/80 backdrop-blur-xl border border-slate-200/50 dark:border-slate-800/60 shadow-lg flex items-center justify-between">
          <div className="flex items-center gap-4">
            <button
              onClick={handleExitAdmin}
              className="w-10 h-10 flex-shrink-0 flex items-center justify-center bg-slate-200/60 dark:bg-slate-800/80 rounded-full shadow-sm hover:scale-105 active:scale-95 transition-all text-slate-700 dark:text-slate-200 border border-slate-200/30 dark:border-slate-700/40 outline-none pointer-events-auto"
            >
              <ArrowLeft size={18} />
            </button>
            <div>
              <h1 className="text-xl font-black tracking-tight text-slate-900 dark:text-slate-100 leading-none">
                Admin{" "}
                <span className="text-indigo-600 dark:text-indigo-400">
                  Dashboard
                </span>
              </h1>
              <p className="text-[10px] font-bold text-slate-400 dark:text-slate-500 uppercase tracking-widest mt-1">
                Management Terminal
              </p>
            </div>
          </div>
        </header>

        <div className="grid grid-cols-1 gap-4">
          {/* Gemini AI Store Manager - Premier Featured Card */}
          <motion.button
            whileHover={{ scale: 1.02 }}
            whileTap={{ scale: 0.98 }}
            onClick={() => {
              triggerHaptic("heavy");
              setIsAIAssistantOpen(true);
            }}
            className="w-full relative overflow-hidden p-6 rounded-[2rem] bg-gradient-to-br from-indigo-500/10 via-purple-500/10 to-pink-500/10 border-2 border-indigo-500/30 dark:border-indigo-400/30 shadow-lg shadow-indigo-500/5 hover:border-indigo-500 dark:hover:border-indigo-400 transition-all flex items-center gap-5 text-left group"
          >
            <div className="absolute top-0 right-0 w-32 h-32 bg-gradient-to-bl from-indigo-500/20 via-purple-500/10 to-transparent rounded-bl-full pointer-events-none blur-xl" />
            
            <div className="relative w-16 h-16 rounded-2xl bg-indigo-600 flex items-center justify-center text-white shadow-lg shadow-indigo-500/25 group-hover:scale-105 transition-transform shrink-0 overflow-hidden">
              <div className="absolute inset-0 bg-gradient-to-tr from-amber-400 via-indigo-500 to-purple-600" />
              <Zap size={32} className="relative z-10 fill-white text-white" />
            </div>

            <div className="flex-1 min-w-0">
              <h2 className="text-xl font-black text-slate-900 dark:text-white group-hover:text-indigo-600 dark:group-hover:text-indigo-400 transition-colors flex items-center gap-2">
                <span>Buzz AI</span>
              </h2>
              <p className="text-xs font-semibold text-slate-500 dark:text-slate-400 mt-1 truncate">
                AI inventory & sales assistant
              </p>
            </div>
          </motion.button>

          <motion.button
            whileHover={{ scale: 1.02 }}
            whileTap={{ scale: 0.98 }}
            onClick={() => {
              triggerHaptic("medium");
              navigate("/analytics");
            }}
            className="w-full h-[112px] glass-card p-6 flex items-center gap-6 group hover:border-indigo-500/50"
          >
            <div className="w-16 h-16 shrink-0 rounded-2xl bg-indigo-50 dark:bg-indigo-500/10 flex items-center justify-center text-indigo-600 dark:text-indigo-400 group-hover:scale-110 transition-transform">
              <BarChart3 size={32} />
            </div>
            <div className="text-left flex-1 min-w-0">
              <h2 className="text-xl font-bold text-slate-900 dark:text-slate-100 truncate leading-tight">
                Analytics
              </h2>
              <p className="text-sm text-slate-500 dark:text-slate-400 mt-1 truncate">
                View sales, profit &amp; store insights
              </p>
            </div>
          </motion.button>

          <motion.button
            whileHover={{ scale: 1.02 }}
            whileTap={{ scale: 0.98 }}
            onClick={() => {
              triggerHaptic("medium");
              setIsViewingProductCosts(true);
            }}
            className="w-full h-[112px] glass-card p-6 flex items-center gap-6 group hover:border-emerald-500/50"
          >
            <div className="w-16 h-16 shrink-0 rounded-2xl bg-emerald-50 dark:bg-emerald-500/10 flex items-center justify-center text-emerald-600 dark:text-emerald-400 group-hover:scale-110 transition-transform">
              <TrendingUp size={32} />
            </div>
            <div className="text-left flex-1 min-w-0">
              <h2 className="text-xl font-bold text-slate-900 dark:text-slate-100 truncate leading-tight">
                Buy Prices
              </h2>
              <p className="text-sm text-slate-500 dark:text-slate-400 mt-1 truncate">
                Set permanent product purchase costs
              </p>
            </div>
          </motion.button>

          <motion.button
            whileHover={{ scale: 1.02 }}
            whileTap={{ scale: 0.98 }}
            onClick={() => {
              triggerHaptic("medium");
              navigate("/all-bills");
            }}
            className="w-full h-[112px] glass-card p-6 flex items-center gap-6 group hover:border-indigo-500/50"
          >
            <div className="w-16 h-16 shrink-0 rounded-2xl bg-indigo-50 dark:bg-indigo-500/10 flex items-center justify-center text-indigo-600 dark:text-indigo-400 group-hover:scale-110 transition-transform">
              <Receipt size={32} />
            </div>
            <div className="text-left flex-1 min-w-0">
              <h2 className="text-xl font-bold text-slate-900 dark:text-slate-100 truncate leading-tight">
                All Bills
              </h2>
              <p className="text-sm text-slate-500 dark:text-slate-400 mt-1 truncate">
                Manage and view past receipts
              </p>
            </div>
          </motion.button>

          <motion.button
            whileHover={{ scale: 1.02 }}
            whileTap={{ scale: 0.98 }}
            onClick={() => {
              triggerHaptic("medium");
              if (savePinTimerRef.current) {
                clearTimeout(savePinTimerRef.current);
                savePinTimerRef.current = null;
              }
              newPinRef.current = "";
              setNewPin("");
              setIsPinSaved(false);
              setIsChangingPin(true);
              setError(false);
            }}
            className="w-full h-[112px] glass-card p-6 flex items-center gap-6 group hover:border-indigo-500/50"
          >
            <div className="w-16 h-16 shrink-0 rounded-2xl bg-indigo-50 dark:bg-indigo-500/10 flex items-center justify-center text-indigo-600 dark:text-indigo-400 group-hover:scale-110 transition-transform">
              <KeyRound size={32} />
            </div>
            <div className="text-left flex-1 min-w-0">
              <h2 className="text-xl font-bold text-slate-900 dark:text-slate-100 truncate leading-tight">
                Reset PIN
              </h2>
              <p className="text-sm text-slate-500 dark:text-slate-400 mt-1 truncate">
                Change your admin PIN
              </p>
            </div>
          </motion.button>

          <motion.button
            whileHover={{ scale: 1.02 }}
            whileTap={{ scale: 0.98 }}
            onClick={() => {
              triggerHaptic("medium");
              navigate("/other-costs");
            }}
            className="w-full h-[112px] glass-card p-6 flex items-center gap-6 group hover:border-indigo-500/50"
          >
            <div className="w-16 h-16 shrink-0 rounded-2xl bg-rose-50 dark:bg-rose-500/10 flex items-center justify-center text-rose-600 dark:text-rose-400 group-hover:scale-110 transition-transform">
              <IndianRupee size={32} />
            </div>
            <div className="text-left flex-1 min-w-0">
              <h2 className="text-xl font-bold text-slate-900 dark:text-slate-100 truncate leading-tight">
                Other Costs
              </h2>
              <p className="text-sm text-slate-500 dark:text-slate-400 mt-1 truncate">
                Manage debts, borrows, and outlays
              </p>
            </div>
          </motion.button>

          <motion.button
            whileHover={{ scale: 1.02 }}
            whileTap={{ scale: 0.98 }}
            onClick={() => {
              triggerHaptic("medium");
              setIsViewingAccounts(true);
              if (accounts.length === 0) {
                fetchAccounts();
              }
            }}
            className="w-full h-[112px] glass-card p-6 flex items-center gap-6 group hover:border-indigo-500/50"
          >
            <div className="w-16 h-16 shrink-0 rounded-2xl bg-indigo-50 dark:bg-indigo-500/10 flex items-center justify-center text-indigo-600 dark:text-indigo-400 group-hover:scale-110 transition-transform">
              <User size={32} />
            </div>
            <div className="text-left flex-1 min-w-0">
              <h2 className="text-xl font-bold text-slate-900 dark:text-slate-100 truncate leading-tight">
                User Accounts
              </h2>
              <p className="text-sm text-slate-500 dark:text-slate-400 mt-1 truncate">
                Manage names, photos, and logins
              </p>
            </div>
          </motion.button>

          <motion.button
            whileHover={{ scale: 1.02 }}
            whileTap={{ scale: 0.98 }}
            onClick={() => {
              triggerHaptic("medium");
              setShowBroadcastModal(true);
              if (accounts.length === 0) {
                fetchAccounts();
              }
            }}
            className="w-full h-[112px] glass-card p-6 flex items-center gap-6 group hover:border-violet-500/50"
          >
            <div className="w-16 h-16 shrink-0 rounded-2xl bg-violet-50 dark:bg-violet-500/10 flex items-center justify-center text-violet-600 dark:text-violet-400 group-hover:scale-110 transition-transform">
              <Bell size={32} />
            </div>
            <div className="text-left flex-1 min-w-0">
              <h2 className="text-xl font-bold text-slate-900 dark:text-slate-100 truncate leading-tight">
                Send Notification
              </h2>
              <p className="text-sm text-slate-500 dark:text-slate-400 mt-1 truncate">
                Broadcast alert to staff or admins
              </p>
            </div>
          </motion.button>

          <motion.button
            whileHover={{ scale: 1.02 }}
            whileTap={{ scale: 0.98 }}
            onClick={() => {
              triggerHaptic("medium");
              setIsViewingSyncConflicts(true);
            }}
            className="w-full h-[112px] glass-card p-6 flex items-center gap-6 group hover:border-amber-500/50 relative"
          >
            <div className="w-16 h-16 shrink-0 rounded-2xl bg-amber-50 dark:bg-amber-500/10 flex items-center justify-center text-amber-600 dark:text-amber-400 group-hover:scale-110 transition-transform">
              <AlertTriangle size={32} />
            </div>
            <div className="text-left flex-1 min-w-0">
              <div className="flex items-center gap-2">
                <h2 className="text-xl font-bold text-slate-900 dark:text-slate-100 truncate leading-tight">
                  Sync Conflicts
                </h2>
                {syncConflicts.filter((c) => c.status === "unresolved").length >
                  0 && (
                  <span className="px-2 py-0.5 rounded-full bg-rose-500 text-white text-[10px] font-extrabold uppercase tracking-wider shadow-xs shrink-0">
                    {
                      syncConflicts.filter((c) => c.status === "unresolved")
                        .length
                    }
                  </span>
                )}
              </div>
              <p className="text-sm text-slate-500 dark:text-slate-400 mt-1 truncate">
                Resolve offline stock discrepancies
              </p>
            </div>
          </motion.button>

          <motion.button
            whileHover={{ scale: 1.02 }}
            whileTap={{ scale: 0.98 }}
            onClick={() => {
              triggerHaptic("medium");
              setIsViewingActivityLogs(true);
            }}
            className="w-full h-[112px] glass-card p-6 flex items-center gap-6 group hover:border-indigo-500/50"
          >
            <div className="w-16 h-16 shrink-0 rounded-2xl bg-indigo-50 dark:bg-indigo-500/10 flex items-center justify-center text-indigo-600 dark:text-indigo-400 group-hover:scale-110 transition-transform">
              <Shield size={32} />
            </div>
            <div className="text-left flex-1 min-w-0">
              <h2 className="text-xl font-bold text-slate-900 dark:text-slate-100 truncate leading-tight">
                Activity Log
              </h2>
              <p className="text-sm text-slate-500 dark:text-slate-400 mt-1 truncate">
                Audit security and stock changes
              </p>
            </div>
          </motion.button>

          <motion.button
            whileHover={{ scale: 1.02 }}
            whileTap={{ scale: 0.98 }}
            onClick={() => {
              triggerHaptic("medium");
              setShowBackupModal(true);
            }}
            className="w-full h-[112px] glass-card p-6 flex items-center gap-6 group hover:border-emerald-500/50"
          >
            <div className="w-16 h-16 shrink-0 rounded-2xl bg-emerald-50 dark:bg-emerald-500/10 flex items-center justify-center text-emerald-600 dark:text-emerald-400 group-hover:scale-110 transition-transform">
              <Database size={32} />
            </div>
            <div className="text-left flex-1 min-w-0">
              <h2 className="text-xl font-bold text-slate-900 dark:text-slate-100 truncate leading-tight">
                Database Backup
              </h2>
              <p className="text-sm text-slate-500 dark:text-slate-400 mt-1 truncate">
                Download JSON or sync database
              </p>
            </div>
          </motion.button>

          <motion.button
            whileHover={{ scale: 1.02 }}
            whileTap={{ scale: 0.98 }}
            onClick={() => {
              triggerHaptic("medium");
              setLogoutConfirm(true);
            }}
            className="w-full h-[112px] glass-card p-6 flex items-center gap-6 group hover:border-indigo-500/50"
          >
            <div className="w-16 h-16 shrink-0 rounded-2xl bg-amber-50 dark:bg-amber-500/10 flex items-center justify-center text-amber-600 dark:text-amber-400 group-hover:scale-110 transition-transform">
              <LogOut size={32} />
            </div>
            <div className="text-left flex-1 min-w-0">
              <h2 className="text-xl font-bold text-slate-900 dark:text-slate-100 truncate leading-tight">
                Log Out All Others
              </h2>
              <p className="text-sm text-slate-500 dark:text-slate-400 mt-1 truncate">
                Sign out non-admin instances
              </p>
            </div>
          </motion.button>

          <motion.button
            whileHover={{ scale: 1.02 }}
            whileTap={{ scale: 0.98 }}
            onClick={() => {
              triggerHaptic("medium");
              setDeleteConfMode("products");
              setDangerConfirmText("");
            }}
            className="w-full h-[112px] p-6 flex items-center gap-6 group border border-red-500/25 bg-red-500/[0.04] dark:bg-red-500/[0.06] hover:bg-red-500/[0.08] hover:border-red-500 transition-all rounded-[1.5rem] shadow-sm shadow-red-500/5 hover:shadow-red-500/10"
          >
            <div className="w-16 h-16 shrink-0 rounded-2xl bg-red-100 dark:bg-red-500/20 flex items-center justify-center text-red-600 dark:text-red-400 group-hover:scale-110 transition-transform shadow-inner">
              <Trash2 size={32} />
            </div>
            <div className="text-left flex-1 min-w-0">
              <h2 className="text-xl font-black text-red-600 dark:text-red-400 truncate leading-tight">
                Database Purges
              </h2>
              <p className="text-red-700/80 dark:text-red-300/80 text-sm font-semibold mt-1 truncate">
                Bulk clean products and bills
              </p>
            </div>
          </motion.button>
        </div>

        {/* Global Security / Purges Modals */}
        {createPortal(
          <>
            <AnimatePresence>
              {logoutConfirm && (
                <div
                  key="admin-logout-modal"
                  className="fixed inset-0 z-[100] flex items-center justify-center p-4"
                >
              <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: 1, transition: { duration: 0.22, ease: [0.22, 1, 0.36, 1] } }}
                exit={{ opacity: 0, transition: { duration: 0.16, ease: [0.4, 0, 1, 1] } }}
                onClick={() => setLogoutConfirm(false)}
                className="absolute inset-0 bg-slate-900/60 backdrop-blur-md"
              />
              <motion.div
                initial={{ scale: 0.9, opacity: 0, y: 20, filter: "blur(6px)" }}
                animate={{
                  scale: 1,
                  opacity: 1,
                  y: 0,
                  filter: "blur(0px)",
                  transition: { type: "spring", stiffness: 480, damping: 32, mass: 0.68 },
                }}
                exit={{
                  scale: 0.92,
                  opacity: 0,
                  y: 12,
                  filter: "blur(4px)",
                  transition: { duration: 0.18, ease: [0.32, 0.72, 0, 1] },
                }}
                className="glass-panel w-full max-w-sm p-6 relative z-10 text-center rounded-[2.5rem] transform-gpu"
              >
                <motion.div
                  initial={{ scale: 0.7, rotate: -10 }}
                  animate={{ scale: 1, rotate: 0 }}
                  transition={{ type: "spring", stiffness: 500, damping: 22 }}
                  className="w-16 h-16 bg-amber-50 dark:bg-amber-500/10 rounded-full flex items-center justify-center text-amber-500 mx-auto mb-4"
                >
                  <LogOut size={32} />
                </motion.div>
                <h3 className="text-xl font-black text-slate-950 dark:text-white mb-2">
                  Log Out All Others?
                </h3>
                <p className="text-xs text-slate-500 leading-relaxed max-w-xs mx-auto mb-6">
                  Are you sure you want to securely log out all other users? All
                  active app contexts except this admin terminal will be
                  disconnected immediately and instructed with a security
                  warning.
                </p>
                <div className="grid grid-cols-2 gap-3">
                  <motion.button
                    whileHover={{ scale: 1.02 }}
                    whileTap={{ scale: 0.95 }}
                    onClick={() => setLogoutConfirm(false)}
                    className="py-3 bg-slate-100 dark:bg-slate-850 hover:bg-slate-200 dark:hover:bg-slate-800 text-slate-700 dark:text-slate-300 font-bold rounded-xl text-xs cursor-pointer"
                  >
                    Cancel
                  </motion.button>
                  <motion.button
                    whileHover={{ scale: 1.02, y: -1 }}
                    whileTap={{ scale: 0.95 }}
                    onClick={handleLogoutAllOtherSessions}
                    className="py-3 bg-amber-600 hover:bg-amber-700 text-white font-bold rounded-xl text-xs shadow-md shadow-amber-600/30 cursor-pointer"
                  >
                    Confirm Logout
                  </motion.button>
                </div>
              </motion.div>
            </div>
          )}

          {showBroadcastModal && (
            <motion.div
              key="admin-broadcast-modal"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1, transition: { duration: 0.22, ease: [0.22, 1, 0.36, 1] } }}
              exit={{ opacity: 0, transition: { duration: 0.16, ease: [0.4, 0, 1, 1] } }}
              onClick={() => !sendingBroadcast && setShowBroadcastModal(false)}
              className="fixed inset-0 z-[100] flex items-center justify-center p-3.5 sm:p-6 bg-slate-950/75 backdrop-blur-md"
            >
              <motion.div
                initial={{ opacity: 0, y: 24, scale: 0.9, filter: "blur(6px)" }}
                animate={{
                  opacity: 1,
                  y: 0,
                  scale: 1,
                  filter: "blur(0px)",
                  transition: { type: "spring", stiffness: 480, damping: 32, mass: 0.68 },
                }}
                exit={{
                  opacity: 0,
                  y: 14,
                  scale: 0.92,
                  filter: "blur(4px)",
                  transition: { duration: 0.18, ease: [0.32, 0.72, 0, 1] },
                }}
                onClick={(e) => e.stopPropagation()}
                className="w-full max-w-md bg-white dark:bg-[#0c1222] border border-slate-200/80 dark:border-slate-800/90 rounded-[28px] shadow-2xl flex flex-col overflow-hidden transform-gpu"
              >
                {/* Modal Header */}
                <div className="px-4 py-3.5 border-b border-slate-100 dark:border-slate-800/80 flex items-center justify-between gap-2.5 shrink-0 bg-white/95 dark:bg-[#0c1222]/95 backdrop-blur-xl">
                  <div className="flex items-center gap-2.5 min-w-0">
                    <motion.div
                      initial={{ scale: 0.8, rotate: -12 }}
                      animate={{ scale: 1, rotate: 0 }}
                      transition={{ type: "spring", stiffness: 500, damping: 22 }}
                      className="w-9 h-9 bg-indigo-500/10 dark:bg-indigo-500/15 border border-indigo-500/25 rounded-xl flex items-center justify-center text-indigo-600 dark:text-indigo-400 shrink-0"
                    >
                      <Bell size={17} />
                    </motion.div>
                    <div className="min-w-0">
                      <h3 className="text-[15px] font-extrabold text-slate-900 dark:text-white tracking-tight leading-tight">
                        Send Notification
                      </h3>
                      <p className="text-[11px] text-slate-500 dark:text-slate-400 mt-0.5 leading-snug truncate">
                        Broadcast instant alert to other accounts
                      </p>
                    </div>
                  </div>
                  <motion.button
                    type="button"
                    whileHover={{ scale: 1.06, rotate: 90 }}
                    whileTap={{ scale: 0.9 }}
                    transition={{ type: "spring", stiffness: 500, damping: 24 }}
                    onClick={() => setShowBroadcastModal(false)}
                    disabled={sendingBroadcast}
                    className="w-8 h-8 rounded-xl bg-slate-100 dark:bg-slate-800/90 flex items-center justify-center text-slate-500 dark:text-slate-400 hover:bg-slate-200 dark:hover:bg-slate-700 hover:text-slate-900 dark:hover:text-white border border-transparent dark:border-slate-700/60 transition-colors shrink-0 cursor-pointer"
                  >
                    <X size={15} />
                  </motion.button>
                </div>

                <form
                  onSubmit={handleSendBroadcastNotification}
                  className="p-4 space-y-3.5 bg-slate-50/50 dark:bg-[#090d19]"
                >
                  {/* Target Audience Selector */}
                  <div>
                    <label className="block text-[10.5px] font-bold uppercase tracking-wider text-slate-500 dark:text-slate-400 mb-1.5">
                      Target Audience
                    </label>
                    <div className="grid grid-cols-3 gap-2">
                      {[
                        {
                          id: "all" as const,
                          label: "Send to All",
                          sub: "Every account",
                          icon: Users,
                        },
                        {
                          id: "admins" as const,
                          label: "Only Admins",
                          sub: "Admin role",
                          icon: Shield,
                        },
                        {
                          id: "users" as const,
                          label: "Normal Users",
                          sub: "Staff role",
                          icon: User,
                        },
                      ].map((opt) => {
                        const Icon = opt.icon;
                        const active = broadcastTarget === opt.id;
                        return (
                          <button
                            key={opt.id}
                            type="button"
                            onClick={() => {
                              triggerHaptic("light");
                              setBroadcastTarget(opt.id);
                            }}
                            className={`p-2.5 rounded-2xl border text-left transition-all flex flex-col justify-between gap-2 min-w-0 cursor-pointer active:scale-[0.98] ${
                              active
                                ? "bg-indigo-600/10 dark:bg-indigo-500/15 border-indigo-500 dark:border-indigo-400/70 text-indigo-950 dark:text-white shadow-xs"
                                : "bg-white dark:bg-slate-900/80 border-slate-200/80 dark:border-slate-800/90 text-slate-700 dark:text-slate-300 hover:border-slate-300 dark:hover:border-slate-700"
                            }`}
                          >
                            <div className="flex items-center justify-between w-full">
                              <div
                                className={`w-6.5 h-6.5 rounded-lg flex items-center justify-center ${
                                  active
                                    ? "bg-indigo-600 text-white shadow-xs shadow-indigo-600/30"
                                    : "bg-slate-100 dark:bg-slate-800 text-slate-500 dark:text-slate-400"
                                }`}
                              >
                                <Icon size={13} />
                              </div>
                              <span
                                className={`w-2 h-2 rounded-full transition-transform ${
                                  active
                                    ? "bg-indigo-500 dark:bg-indigo-400 scale-100"
                                    : "bg-slate-300 dark:bg-slate-700 scale-75 opacity-50"
                                }`}
                              />
                            </div>
                            <div className="min-w-0">
                              <span className="block text-[11px] font-extrabold tracking-tight leading-snug whitespace-nowrap">
                                {opt.label}
                              </span>
                              <span className="block text-[9.5px] text-slate-500 dark:text-slate-400 font-medium leading-tight mt-0.5 whitespace-nowrap">
                                {opt.sub}
                              </span>
                            </div>
                          </button>
                        );
                      })}
                    </div>
                  </div>

                  {/* Quick Templates — Full-width proportional row without truncation */}
                  <div>
                    <label className="block text-[10.5px] font-bold uppercase tracking-wider text-slate-500 dark:text-slate-400 mb-1.5">
                      Quick Templates
                    </label>
                    <div className="flex items-center gap-1.5">
                      {[
                        {
                          label: "Stock Update",
                          title: "Stock Updated",
                          msg: "New stock items have been updated. Please check inventory before billing.",
                        },
                        {
                          label: "Shift Handover",
                          title: "Shift Handover",
                          msg: "Please verify all pending bills and cash counter totals before closing shift.",
                        },
                        {
                          label: "Price Alert",
                          title: "Price Change Alert",
                          msg: "Product prices have been revised by Admin. Check updated rates in POS.",
                        },
                      ].map((preset) => {
                        const isSelected = broadcastTitle === preset.title;
                        return (
                          <button
                            key={preset.title}
                            type="button"
                            onClick={() => {
                              triggerHaptic("light");
                              if (isSelected) {
                                setBroadcastTitle("");
                                setBroadcastMessage("");
                              } else {
                                setBroadcastTitle(preset.title);
                                setBroadcastMessage(preset.msg);
                              }
                            }}
                            className={`flex-1 h-8.5 px-2 rounded-xl text-[10.5px] font-bold border transition-all whitespace-nowrap flex items-center justify-center gap-1 cursor-pointer active:scale-95 ${
                              isSelected
                                ? "bg-indigo-600/15 dark:bg-indigo-500/20 border-indigo-500/50 text-indigo-700 dark:text-indigo-200"
                                : "bg-white dark:bg-slate-900/80 border-slate-200/80 dark:border-slate-800 text-slate-600 dark:text-slate-300 hover:border-indigo-400/50 hover:text-indigo-600 dark:hover:text-indigo-300"
                            }`}
                          >
                            <span>{preset.label}</span>
                            {isSelected && (
                              <X size={11} className="shrink-0 opacity-80 hover:opacity-100" />
                            )}
                          </button>
                        );
                      })}
                    </div>
                  </div>

                  {/* Notification Title */}
                  <div>
                    <label className="block text-[10.5px] font-bold uppercase tracking-wider text-slate-500 dark:text-slate-400 mb-1.5">
                      Title <span className="text-slate-400 dark:text-slate-500 font-normal normal-case">(Optional)</span>
                    </label>
                    <input
                      type="text"
                      value={broadcastTitle}
                      onChange={(e) => setBroadcastTitle(e.target.value)}
                      placeholder="e.g. Store Announcement"
                      maxLength={60}
                      className="w-full h-10 px-3.5 rounded-xl bg-white dark:bg-slate-900/90 border border-slate-200/90 dark:border-slate-800 text-xs sm:text-sm font-semibold text-slate-900 dark:text-white placeholder:text-slate-400 dark:placeholder:text-slate-500 focus:outline-none focus:ring-2 focus:ring-indigo-500/25 focus:border-indigo-500 transition-all"
                    />
                  </div>

                  {/* Notification Message */}
                  <div>
                    <div className="flex items-center justify-between mb-1.5">
                      <label className="block text-[10.5px] font-bold uppercase tracking-wider text-slate-500 dark:text-slate-400">
                        Message
                      </label>
                      <span className="text-[10px] font-mono text-slate-400 dark:text-slate-500 tabular-nums">
                        {broadcastMessage.length}/350
                      </span>
                    </div>
                    <textarea
                      rows={2}
                      value={broadcastMessage}
                      onChange={(e) => setBroadcastMessage(e.target.value)}
                      placeholder="Write the message to send to other accounts..."
                      required
                      maxLength={350}
                      className="w-full p-3 rounded-xl bg-white dark:bg-slate-900/90 border border-slate-200/90 dark:border-slate-800 text-xs sm:text-sm font-medium text-slate-900 dark:text-white placeholder:text-slate-400 dark:placeholder:text-slate-500 focus:outline-none focus:ring-2 focus:ring-indigo-500/25 focus:border-indigo-500 transition-all resize-none leading-relaxed"
                    />
                  </div>

                  {/* Actions */}
                  <div className="grid grid-cols-2 gap-2.5 pt-0.5">
                    <button
                      type="button"
                      onClick={() => setShowBroadcastModal(false)}
                      disabled={sendingBroadcast}
                      className="h-10 rounded-xl bg-slate-100 dark:bg-slate-800/90 border border-slate-200/80 dark:border-slate-700/70 text-slate-700 dark:text-slate-200 font-bold text-xs hover:bg-slate-200/80 dark:hover:bg-slate-700 transition-all active:scale-95 cursor-pointer"
                    >
                      Cancel
                    </button>
                    <button
                      type="submit"
                      disabled={sendingBroadcast || !broadcastMessage.trim()}
                      className="h-10 rounded-xl bg-indigo-600 hover:bg-indigo-500 disabled:opacity-45 text-white font-bold text-xs shadow-md shadow-indigo-600/25 flex items-center justify-center gap-2 transition-all active:scale-95 cursor-pointer disabled:cursor-not-allowed"
                    >
                      <Send size={13} />
                      <span>
                        {sendingBroadcast
                          ? "Sending..."
                          : broadcastTarget === "admins"
                          ? "Send to Admins"
                          : broadcastTarget === "users"
                          ? "Send to Users"
                          : "Send to All"}
                      </span>
                    </button>
                  </div>
                </form>
              </motion.div>
            </motion.div>
          )}

          {showBackupModal && (
            <motion.div
              key="admin-backup-modal"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1, transition: { duration: 0.22, ease: [0.22, 1, 0.36, 1] } }}
              exit={{ opacity: 0, transition: { duration: 0.16, ease: [0.4, 0, 1, 1] } }}
              onClick={() => setShowBackupModal(false)}
              className="fixed inset-0 z-[100] flex items-center justify-center p-3.5 sm:p-6 bg-slate-950/75 backdrop-blur-md"
            >
              <motion.div
                initial={{ opacity: 0, y: 24, scale: 0.9, filter: "blur(6px)" }}
                animate={{
                  opacity: 1,
                  y: 0,
                  scale: 1,
                  filter: "blur(0px)",
                  transition: { type: "spring", stiffness: 480, damping: 32, mass: 0.68 },
                }}
                exit={{
                  opacity: 0,
                  y: 14,
                  scale: 0.92,
                  filter: "blur(4px)",
                  transition: { duration: 0.18, ease: [0.32, 0.72, 0, 1] },
                }}
                onClick={(e) => e.stopPropagation()}
                className="w-full max-w-md bg-white dark:bg-[#0c1222] border border-slate-200/80 dark:border-slate-800/90 rounded-[28px] shadow-2xl flex flex-col max-h-[90dvh] overflow-hidden transform-gpu"
              >
                {/* Header */}
                <div className="px-5 py-4 border-b border-slate-100 dark:border-slate-800/80 flex items-center justify-between gap-3 shrink-0 bg-white/95 dark:bg-[#0c1222]/95 backdrop-blur-xl">
                  <div className="flex items-center gap-3 min-w-0">
                    <motion.div
                      initial={{ scale: 0.8, rotate: -10 }}
                      animate={{ scale: 1, rotate: 0 }}
                      transition={{ type: "spring", stiffness: 500, damping: 22 }}
                      className="w-10 h-10 bg-indigo-500/10 dark:bg-indigo-500/15 border border-indigo-500/25 rounded-2xl flex items-center justify-center text-indigo-600 dark:text-indigo-400 shrink-0"
                    >
                      <Database size={18} />
                    </motion.div>
                    <div className="min-w-0">
                      <h3 className="text-base font-extrabold text-slate-900 dark:text-white tracking-tight leading-tight">
                        Data Management
                      </h3>
                      <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5 leading-snug">
                        Cloud sync, portable snapshots &amp; recovery
                      </p>
                    </div>
                  </div>
                  <motion.button
                    type="button"
                    whileHover={{ scale: 1.06, rotate: 90 }}
                    whileTap={{ scale: 0.9 }}
                    transition={{ type: "spring", stiffness: 500, damping: 24 }}
                    onClick={() => {
                      triggerHaptic("light");
                      setShowBackupModal(false);
                    }}
                    className="w-8 h-8 flex items-center justify-center rounded-xl bg-slate-100 dark:bg-slate-800/90 text-slate-500 dark:text-slate-400 hover:bg-slate-200 dark:hover:bg-slate-700 hover:text-slate-900 dark:hover:text-white border border-transparent dark:border-slate-700/60 transition-colors shrink-0 cursor-pointer"
                  >
                    <X size={15} />
                  </motion.button>
                </div>

                {/* Scrollable Body */}
                <div className="p-4 sm:p-5 overflow-y-auto space-y-3.5 custom-scrollbar flex-1 bg-slate-50/50 dark:bg-[#090d19]">
                  {/* Current Connection Status Card */}
                  <div className="p-4 rounded-2xl bg-white dark:bg-slate-900/85 border border-slate-200/80 dark:border-slate-800/90 space-y-2.5 shadow-2xs">
                    <div className="flex items-center justify-between gap-2">
                      <div className="flex items-center gap-2 min-w-0">
                        <span className="w-2 h-2 rounded-full bg-emerald-500 shrink-0" />
                        <span className="font-bold uppercase text-[10.5px] tracking-wider text-slate-600 dark:text-slate-300 whitespace-nowrap">
                          Connected Database
                        </span>
                      </div>
                      <span className="font-mono text-[10.5px] font-medium text-slate-500 dark:text-slate-400 truncate max-w-[160px]">
                        {appletConfig.projectId}
                      </span>
                    </div>
                    <div
                      onClick={handleCopyCurrentDatabaseId}
                      title="Click to copy Database ID"
                      className="h-10 px-3.5 rounded-xl bg-slate-50 dark:bg-slate-950/90 border border-slate-200/80 dark:border-slate-800 hover:border-indigo-400 dark:hover:border-indigo-500/50 flex items-center justify-between gap-2 cursor-pointer active:scale-[0.99] transition-all group"
                    >
                      <code className="font-mono font-semibold text-slate-800 dark:text-slate-200 text-xs whitespace-nowrap truncate block">
                        {(() => {
                          const rawId = String(appletConfig.firestoreDatabaseId || "");
                          const vIdx = rawId.toLowerCase().indexOf("v111");
                          if (vIdx !== -1) {
                            return `${rawId.slice(0, vIdx + 4)}...`;
                          }
                          return rawId.length > 26 ? `${rawId.slice(0, 26)}...` : rawId;
                        })()}
                      </code>
                      <span className="inline-flex items-center gap-1.5 text-[11px] font-bold shrink-0 px-2.5 py-1 rounded-lg bg-indigo-500/10 dark:bg-indigo-500/15 text-indigo-600 dark:text-indigo-300 group-hover:bg-indigo-500/20 transition-colors">
                        {copiedDbId ? (
                          <>
                            <Check size={12} className="text-emerald-500" />
                            <span className="text-emerald-600 dark:text-emerald-400">Copied</span>
                          </>
                        ) : (
                          <>
                            <Copy size={12} />
                            <span>Copy ID</span>
                          </>
                        )}
                      </span>
                    </div>
                  </div>

                  {/* Option 1: Direct Cloud Recovery */}
                  <div className="bg-white dark:bg-slate-900/85 border border-slate-200/80 dark:border-slate-800/90 rounded-2xl p-4 space-y-3 shadow-2xs">
                    <div className="flex items-start gap-2.5">
                      <div className="w-8 h-8 rounded-xl bg-indigo-500/10 dark:bg-indigo-500/15 flex items-center justify-center text-indigo-600 dark:text-indigo-400 shrink-0 mt-0.5">
                        <Cloud size={15} />
                      </div>
                      <div className="min-w-0">
                        <h4 className="text-xs sm:text-sm font-bold text-slate-900 dark:text-slate-100 leading-tight">
                          Direct Cloud Recovery
                        </h4>
                        <p className="text-[11px] text-slate-500 dark:text-slate-400 leading-relaxed mt-0.5">
                          Sync or recover store records from a source database ID.
                        </p>
                      </div>
                    </div>

                    <div className="flex items-center gap-2">
                      <div className="relative flex-1 min-w-0">
                        <input
                          type="text"
                          placeholder="Source database ID..."
                          value={oldDatabaseIdInput}
                          onChange={(e) => setOldDatabaseIdInput(e.target.value)}
                          className="w-full h-11 pl-3.5 pr-[74px] rounded-xl text-xs border border-slate-200/90 dark:border-slate-800 bg-slate-50 dark:bg-slate-950/90 focus:outline-none focus:ring-2 focus:ring-indigo-500/25 focus:border-indigo-500 text-slate-900 dark:text-white transition-all placeholder:text-slate-400 dark:placeholder:text-slate-500 font-mono truncate select-text"
                        />
                        <button
                          type="button"
                          onClick={handlePasteDatabaseId}
                          title="Paste Database ID"
                          className="absolute right-1.5 top-1/2 -translate-y-1/2 h-8 px-2.5 rounded-lg bg-slate-200/70 hover:bg-slate-200 dark:bg-slate-800 dark:hover:bg-slate-700 text-slate-700 dark:text-slate-200 text-[10.5px] font-bold flex items-center gap-1 transition-all active:scale-95 cursor-pointer"
                        >
                          <ClipboardPaste size={11} />
                          <span>Paste</span>
                        </button>
                      </div>
                      <button
                        type="button"
                        onClick={() => {
                          triggerHaptic("medium");
                          setShowBackupModal(false);
                          handleDirectDatabaseCopy(oldDatabaseIdInput);
                        }}
                        className="h-11 px-4 bg-indigo-600 hover:bg-indigo-500 text-white font-bold rounded-xl text-xs shadow-md shadow-indigo-600/20 flex items-center justify-center gap-1.5 transition-all active:scale-95 whitespace-nowrap shrink-0 cursor-pointer"
                      >
                        <RefreshCw size={13} />
                        <span>Sync</span>
                      </button>
                    </div>
                  </div>

                  {/* Option 2: Complete Snapshot (JSON) */}
                  <div className="bg-white dark:bg-slate-900/85 border border-slate-200/80 dark:border-slate-800/90 rounded-2xl p-4 space-y-3 shadow-2xs">
                    <div className="flex items-start gap-2.5">
                      <div className="w-8 h-8 rounded-xl bg-emerald-500/10 dark:bg-emerald-500/15 flex items-center justify-center text-emerald-600 dark:text-emerald-400 shrink-0 mt-0.5">
                        <Database size={15} />
                      </div>
                      <div className="min-w-0">
                        <h4 className="text-xs sm:text-sm font-bold text-slate-900 dark:text-slate-100 leading-tight">
                          Complete Snapshot (JSON)
                        </h4>
                        <p className="text-[11px] text-slate-500 dark:text-slate-400 leading-relaxed mt-0.5">
                          Download a full portable backup file or restore from an existing JSON snapshot.
                        </p>
                      </div>
                    </div>
                    <div className="grid grid-cols-2 gap-2.5">
                      <button
                        type="button"
                        onClick={() => {
                          triggerHaptic("medium");
                          setShowBackupModal(false);
                          handleExportJSONBackup();
                        }}
                        className="h-11 px-3 bg-indigo-600 hover:bg-indigo-500 text-white font-bold rounded-xl text-xs flex items-center justify-center gap-2 shadow-md shadow-indigo-600/20 transition-all active:scale-95 cursor-pointer"
                      >
                        <Download size={14} />
                        <span>Export JSON</span>
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          triggerHaptic("light");
                          jsonFileInputRef.current?.click();
                        }}
                        className="h-11 px-3 bg-slate-100 dark:bg-slate-800/90 hover:bg-slate-200/80 dark:hover:bg-slate-700/90 border border-slate-200/80 dark:border-slate-700/80 text-slate-700 dark:text-slate-200 font-bold rounded-xl text-xs flex items-center justify-center gap-2 transition-all active:scale-95 cursor-pointer"
                      >
                        <Upload size={14} />
                        <span>Import JSON</span>
                      </button>
                      <input
                        type="file"
                        ref={jsonFileInputRef}
                        accept=".json,application/json,text/plain"
                        onChange={(e) => {
                          const file = e.target.files?.[0];
                          e.target.value = "";
                          if (file) {
                            setShowBackupModal(false);
                            handleImportJSONBackup(file);
                          }
                        }}
                        style={{ display: "none" }}
                      />
                    </div>
                  </div>
                </div>
              </motion.div>
            </motion.div>
          )}

          {deleteConfMode !== "none" && (
            <div
              key="admin-delete-modal"
              className="fixed inset-0 z-[100] flex items-center justify-center p-4"
            >
              <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: 1, transition: { duration: 0.22, ease: [0.22, 1, 0.36, 1] } }}
                exit={{ opacity: 0, transition: { duration: 0.16, ease: [0.4, 0, 1, 1] } }}
                onClick={() => setDeleteConfMode("none")}
                className="absolute inset-0 bg-slate-900/60 backdrop-blur-md"
              />
              <motion.div
                initial={{ scale: 0.9, opacity: 0, y: 22, filter: "blur(6px)" }}
                animate={{
                  scale: 1,
                  opacity: 1,
                  y: 0,
                  filter: "blur(0px)",
                  transition: { type: "spring", stiffness: 480, damping: 32, mass: 0.68 },
                }}
                exit={{
                  scale: 0.92,
                  opacity: 0,
                  y: 14,
                  filter: "blur(4px)",
                  transition: { duration: 0.18, ease: [0.32, 0.72, 0, 1] },
                }}
                className="glass-panel w-full max-w-md p-6 relative z-10 rounded-[2.5rem] transform-gpu"
              >
                <motion.div
                  initial={{ scale: 0.7, rotate: -10 }}
                  animate={{ scale: 1, rotate: 0 }}
                  transition={{ type: "spring", stiffness: 500, damping: 22 }}
                  className="w-16 h-16 bg-red-100 dark:bg-red-500/10 rounded-full flex items-center justify-center text-red-500 mx-auto mb-4"
                >
                  <AlertTriangle size={32} />
                </motion.div>
                <h3 className="text-lg font-black text-slate-900 dark:text-slate-100 text-center mb-1">
                  Purge{" "}
                  {deleteConfMode === "products"
                    ? "Products Database"
                    : deleteConfMode === "bills"
                    ? "Transaction Bills"
                    : "Other Costs & Expenses"}
                  ?
                </h3>
                <p className="text-xs text-slate-500 text-center leading-relaxed max-w-xs mx-auto mb-4">
                  This action is permanent and cannot be undone! To confirm
                  deletion of all{" "}
                  {deleteConfMode === "products"
                    ? "inventory products"
                    : deleteConfMode === "bills"
                    ? "transaction bills"
                    : "other costs and expenses"}
                  , type the word{" "}
                  <strong className="text-red-500">DELETE</strong> below.
                </p>

                <input
                  type="text"
                  placeholder="Type DELETE to confirm"
                  value={dangerConfirmText}
                  onChange={(e) => setDangerConfirmText(e.target.value)}
                  className="w-full px-4 py-2.5 rounded-xl border border-red-200 dark:border-red-900 bg-red-500/5 text-center text-sm font-bold tracking-widest text-red-600 uppercase focus:outline-none focus:ring-1 focus:ring-red-500 mb-6"
                />

                <div className="m3-segmented-track mb-5">
                  {(
                    [
                      { id: "products", label: "Products" },
                      { id: "bills", label: "Bills" },
                      { id: "other_costs", label: "Other Costs" },
                    ] as const
                  ).map((tab) => {
                    const active = deleteConfMode === tab.id;
                    return (
                      <button
                        key={tab.id}
                        type="button"
                        onClick={() => {
                          triggerHaptic("selection");
                          setDeleteConfMode(tab.id);
                          setDangerConfirmText("");
                        }}
                        className={`relative flex-1 min-w-0 min-h-[38px] py-2 px-2 rounded-full text-xs font-bold text-center transition-colors duration-200 outline-none flex items-center justify-center whitespace-nowrap cursor-pointer ${
                          active
                            ? "text-white"
                            : "text-slate-600 dark:text-slate-300 hover:text-slate-900 dark:hover:text-white active:scale-95"
                        }`}
                      >
                        {active && (
                          <motion.div
                            layoutId="adminPurgeModePill"
                            className="absolute inset-0 bg-red-600 rounded-full shadow-xs"
                            transition={{
                              type: "spring",
                              stiffness: 380,
                              damping: 28,
                              mass: 0.7,
                            }}
                          />
                        )}
                        <span className="relative z-10 truncate">{tab.label}</span>
                      </button>
                    );
                  })}
                </div>

                <div className="grid grid-cols-2 gap-3 mb-4">
                  <button
                    onClick={() => {
                      triggerHaptic("light");
                      setDeleteConfMode("none");
                    }}
                    className="py-3 bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-800 hover:bg-slate-100 dark:hover:bg-slate-800 text-slate-600 dark:text-slate-400 font-bold rounded-xl text-xs text-center"
                  >
                    Cancel
                  </button>
                  <button
                    disabled={
                      dangerConfirmText.trim().toUpperCase() !== "DELETE" ||
                      isProcessing
                    }
                    onClick={async () => {
                      if (deleteConfMode === "products") {
                        await handleDeleteAllProducts();
                      } else if (deleteConfMode === "bills") {
                        await handleDeleteAllBills();
                      } else if (deleteConfMode === "other_costs") {
                        await handleDeleteAllOtherCosts();
                      }
                    }}
                    className="py-3 bg-red-600 hover:bg-red-700 disabled:bg-slate-200 dark:disabled:bg-slate-850 disabled:text-slate-400 dark:disabled:text-slate-500 text-white font-bold rounded-xl text-xs shadow-lg shadow-red-600/20 disabled:shadow-none transition-all text-center"
                  >
                    Confirm Permanent Delete
                  </button>
                </div>
              </motion.div>
            </div>
          )}

          </AnimatePresence>

          {renderActionFeedbackPortal()}

          <AdminAIAssistant
            isOpen={isAIAssistantOpen}
            onClose={() => setIsAIAssistantOpen(false)}
            accounts={accounts}
            activityLogs={activityLogs}
            onProductUpdated={() => {
              // Trigger refresh / feedback if needed
            }}
          />
          </>,
          document.body
        )}
      </motion.div>
    );
  }

  // Not authenticated
  return (
    <motion.div
      key="admin-pin-login-view"
      initial={{ opacity: 0, scale: 0.98 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={{
        opacity: 0,
        scale: 0.98,
        transition: { duration: 0.3, ease: [0.16, 1, 0.3, 1] },
      }}
      transition={{ duration: 0.45, ease: [0.16, 1, 0.3, 1] }}
      className="pb-6 px-4 pt-4 max-w-sm mx-auto min-h-[90vh] flex flex-col justify-between relative"
    >
      <header className="w-full flex items-center justify-between pt-2">
        <button
          onClick={handleExitAdmin}
          className="w-11 h-11 flex-shrink-0 flex items-center justify-center bg-slate-50 hover:bg-slate-100 dark:bg-slate-900/80 dark:hover:bg-slate-850 text-slate-800 dark:text-slate-100 border border-slate-200/80 dark:border-slate-800 rounded-2xl shadow-sm active:scale-95 transition-all outline-none"
        >
          <ArrowLeft size={18} />
        </button>
        <span className="text-[10px] font-extrabold uppercase tracking-widest text-slate-400 dark:text-slate-500">
          Security Terminal
        </span>
      </header>

      {failedAttempts >= 3 || lockedByAdmin ? (
        <div className="text-center my-auto px-4">
          <div className="w-20 h-20 rounded-3xl bg-rose-500/10 dark:bg-rose-500/20 flex items-center justify-center mx-auto mb-6 border border-rose-500/20 animate-pulse">
            {lockedByAdmin ? (
              <Lock className="text-rose-600 dark:text-rose-400" size={36} />
            ) : (
              <AlertTriangle
                className="text-rose-600 dark:text-rose-400"
                size={36}
              />
            )}
          </div>
          <h1 className="text-2xl font-black tracking-tight text-rose-600 dark:text-rose-400">
            Access Restricted
          </h1>
          <p className="text-slate-500 dark:text-slate-400 mt-3 text-sm leading-relaxed">
            {lockedByAdmin
              ? "Your access to the Admin Terminal has been locked by an Administrator."
              : "You have exceeded the maximum limit of failed admin attempts. This incident has been logged."}
          </p>
          <button
            onClick={() => navigate("/")}
            className="mt-8 px-6 py-3 w-full bg-slate-100 hover:bg-slate-200 dark:bg-slate-800 dark:hover:bg-slate-700 text-slate-700 dark:text-slate-200 rounded-2xl font-bold text-sm transition-all border border-slate-200/50 dark:border-slate-700/50"
          >
            Go Back to Home
          </button>
        </div>
      ) : (
        <div className="my-auto flex flex-col items-center w-full">
          <div className="mb-8 text-center">
            {/* The Badge - Styled with outstanding dark mode neon color scheme, completely visible (no clipping) */}
            <div className="w-24 h-24 rounded-3xl bg-gradient-to-tr from-indigo-500/10 via-purple-500/5 to-pink-500/5 dark:from-indigo-500/20 dark:via-purple-500/10 dark:to-pink-500/10 relative flex items-center justify-center mx-auto mb-6 border border-indigo-100/30 dark:border-indigo-500/30 shadow-[0_8px_30px_rgb(99,102,241,0.06)] dark:shadow-[0_8px_30px_rgb(99,102,241,0.15)] p-0.5">
              <div className="absolute inset-0 bg-indigo-500/5 dark:bg-indigo-400/5 blur-xl rounded-3xl" />
              <div className="w-full h-full bg-white dark:bg-slate-900 rounded-[1.35rem] flex items-center justify-center">
                <Shield
                  className="text-indigo-600 dark:text-indigo-400 drop-shadow-[0_2px_8px_rgba(99,102,241,0.2)]"
                  size={40}
                />
              </div>

              {/* Perfectly sized & positioned lock badge to guarantee full visibility */}
              <div className="absolute -bottom-1 -right-1 w-8 h-8 rounded-2xl bg-slate-900 dark:bg-slate-100 flex items-center justify-center shadow-md border border-indigo-100/40 dark:border-slate-800">
                <Lock className="text-white dark:text-slate-900" size={14} />
              </div>
            </div>

            <h1 className="text-3xl font-black tracking-tight text-transparent bg-clip-text bg-gradient-to-r from-slate-950 via-indigo-950 to-slate-950 dark:from-white dark:via-indigo-100 dark:to-white">
              Admin{" "}
              <span className="text-indigo-600 dark:text-indigo-400">
                Login
              </span>
            </h1>
            <p className="text-slate-400 dark:text-slate-500 text-[10px] font-extrabold uppercase tracking-widest mt-2">
              Enter 4-Digit Security PIN
            </p>
            {failedAttempts > 0 && (
              <p className="text-rose-600 dark:text-rose-400 text-xs font-bold mt-2.5 bg-rose-500/10 px-3 py-1 rounded-full border border-rose-500/20 inline-block">
                Failed attempts: {failedAttempts}/3
              </p>
            )}
          </div>

          <div className="flex gap-4 mb-10 justify-center">
            {[0, 1, 2, 3].map((i) => (
              <div
                key={i}
                className={`w-4 h-4 rounded-full transition-all duration-300 ${
                  i < pin.length
                    ? error
                      ? "bg-rose-500 shadow-[0_0_12px_rgba(244,63,94,0.6)] scale-110"
                      : success
                      ? "bg-emerald-500 shadow-[0_0_12px_rgba(16,185,129,0.6)] scale-110"
                      : "bg-indigo-600 dark:bg-indigo-400 shadow-[0_0_12px_rgba(99,102,241,0.6)] scale-110"
                    : "bg-slate-200 dark:bg-slate-800"
                }`}
              />
            ))}
          </div>

          <div className="grid grid-cols-3 gap-4 w-full px-4">
            {[1, 2, 3, 4, 5, 6, 7, 8, 9].map((num) => (
              <button
                key={num}
                onClick={() => handlePinInput(num.toString())}
                className="text-2xl font-black bg-white/60 dark:bg-slate-900/60 backdrop-blur-md rounded-2xl h-16 flex items-center justify-center text-slate-850 dark:text-slate-100 border border-slate-200/50 dark:border-slate-800/80 shadow-sm active:scale-90 active:bg-slate-100 dark:active:!bg-slate-800 transition-all outline-none"
              >
                {num}
              </button>
            ))}
            <div />
            <button
              onClick={() => handlePinInput("0")}
              className="text-2xl font-black bg-white/60 dark:bg-slate-900/60 backdrop-blur-md rounded-2xl h-16 flex items-center justify-center text-slate-850 dark:text-slate-100 border border-slate-200/50 dark:border-slate-800/80 shadow-sm active:scale-90 active:bg-slate-100 dark:active:!bg-slate-800 transition-all outline-none"
            >
              0
            </button>
            <button
              onClick={handleBackspace}
              className="text-2xl font-black bg-white/60 dark:bg-slate-900/60 backdrop-blur-md rounded-2xl h-16 flex items-center justify-center text-slate-400 dark:text-slate-500 border border-slate-200/50 dark:border-slate-800/80 shadow-sm active:scale-90 active:bg-slate-100 dark:active:!bg-slate-800 transition-all outline-none"
            >
              <Delete size={22} className="stroke-[2.5]" />
            </button>
          </div>
        </div>
      )}
      <div className="w-full text-center text-[10px] text-slate-400 dark:text-slate-600 font-medium py-2">
        Terminal Secured with 256-bit Firestore Encryption
      </div>
    </motion.div>
  );
}
