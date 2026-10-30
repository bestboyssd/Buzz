import {
  createContext,
  useContext,
  ReactNode,
  useState,
  useEffect,
  useRef,
} from "react";
import {
  onAuthStateChanged,
  signOut as firebaseSignOut,
  signInWithPopup,
  signInWithCredential,
  GoogleAuthProvider,
  updateProfile,
  User,
} from "firebase/auth";
import { auth, db, USE_PRODUCTION_DB_IN_DEV } from "./firebase";
import {
  doc,
  onSnapshot,
  setDoc,
  getDoc,
  getDocFromServer,
  deleteDoc,
  collection,
  query,
  orderBy,
  getDocs,
  getDocsFromServer,
  writeBatch,
} from "firebase/firestore";
import { Capacitor } from "@capacitor/core";
import { FirebaseAuthentication } from "@capacitor-firebase/authentication";
import {
  showLocalNotification,
  getDeviceId,
  markLocalSecurityAlertTriggered,
} from "./utils";
import { logActivity } from "./firestoreHooks";

import { updateStatusBarTheme } from "./capacitor";

const BLOCKED_LOGIN_MESSAGE =
  "Your account has been blocked by the administrator. You cannot log in to this app.";

export const getSystemDefaultTheme = (): "dark" | "light" => {
  if (typeof window !== "undefined" && window.matchMedia) {
    return window.matchMedia("(prefers-color-scheme: dark)").matches
      ? "dark"
      : "light";
  }
  return "light";
};

export const applyAppTheme = (theme: "dark" | "light", uid?: string) => {
  const isDark = theme === "dark";
  if (isDark) {
    document.documentElement.classList.add("dark");
  } else {
    document.documentElement.classList.remove("dark");
  }
  localStorage.setItem("theme", theme);
  if (uid) {
    localStorage.setItem(`theme_${uid}`, theme);
  }
  updateStatusBarTheme(isDark);
  window.dispatchEvent(new CustomEvent("themeChanged", { detail: { theme } }));
};

interface AuthContextType {
  user: User | null;
  loading: boolean;
  isAdmin: boolean;
  isRealAdmin: boolean;
  signOut: () => Promise<void>;
  signInWithGoogle: () => Promise<void>;
  failedAttempts: number;
  lockedByAdmin: boolean;
  incrementFailedAttempts: () => Promise<void>;
  resetFailedAttempts: () => Promise<void>;
}

const AuthContext = createContext<AuthContextType>({
  user: null,
  loading: true,
  isAdmin: false,
  isRealAdmin: false,
  signOut: async () => {},
  signInWithGoogle: async () => {},
  failedAttempts: 0,
  lockedByAdmin: false,
  incrementFailedAttempts: async () => {},
  resetFailedAttempts: async () => {},
});

const fetchFreshDoc = async (ref: ReturnType<typeof doc>) => {
  try {
    return await getDocFromServer(ref);
  } catch {
    return await getDoc(ref).catch(() => null);
  }
};

const wipeLocalAccountCache = (uid: string) => {
  localStorage.removeItem(`is_admin_cached_${uid}`);
  localStorage.removeItem(`is_real_admin_cached_${uid}`);
  localStorage.removeItem(`custom_user_photo_${uid}`);
  localStorage.removeItem(`is_blocked_cached_${uid}`);
  localStorage.removeItem(`theme_${uid}`);
  localStorage.removeItem(`hapticsEnabled_${uid}`);
  localStorage.removeItem(`notifications_${uid}`);
  localStorage.removeItem(`keepScreenOn_${uid}`);
  localStorage.removeItem(`tempAdminAuth_${uid}`);
};

export const AuthProvider = ({ children }: { children: ReactNode }) => {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [isAdmin, setIsAdmin] = useState(false);
  const [isRealAdmin, setIsRealAdmin] = useState(false);
  const [failedAttempts, setFailedAttempts] = useState(0);
  const [lockedByAdmin, setLockedByAdmin] = useState(false);
  const skipProfileWriteRef = useRef(false);
  const profileConfirmedInDbRef = useRef(false);
  const isExplicitGoogleSignInRef = useRef(false);
  const recreatedAtRef = useRef(0);

  const notifyAndEnforceBlockedLogout = async (message: string) => {
    skipProfileWriteRef.current = true;
    localStorage.setItem("adminLogoutMessage", message);
    window.dispatchEvent(
      new CustomEvent("adminLogoutMessage", { detail: message })
    );
    await signOut();
  };

  // Listen to device OS theme changes while user is not signed in
  useEffect(() => {
    if (user) return;
    if (typeof window === "undefined" || !window.matchMedia) return;

    const mediaQuery = window.matchMedia("(prefers-color-scheme: dark)");
    const syncUnauthenticatedTheme = () => {
      const savedGlobal = localStorage.getItem("theme");
      if (savedGlobal === "dark" || savedGlobal === "light") {
        const isDark = savedGlobal === "dark";
        document.documentElement.classList.toggle("dark", isDark);
        updateStatusBarTheme(isDark);
      } else {
        const isDark = mediaQuery.matches;
        document.documentElement.classList.toggle("dark", isDark);
        updateStatusBarTheme(isDark);
        window.dispatchEvent(
          new CustomEvent("themeChanged", {
            detail: { theme: isDark ? "dark" : "light" },
          })
        );
      }
    };

    syncUnauthenticatedTheme();

    const handleChange = () => syncUnauthenticatedTheme();
    if (typeof mediaQuery.addEventListener === "function") {
      mediaQuery.addEventListener("change", handleChange);
      return () => mediaQuery.removeEventListener("change", handleChange);
    }
  }, [user]);

  useEffect(() => {
    const unsubscribeAuth = onAuthStateChanged(auth, (currentUser) => {
      localStorage.removeItem("local_dev_bypass_user");

      if (currentUser) {
        if (currentUser.isAnonymous) {
          firebaseSignOut(auth).catch(() => {});
          setUser(null);
          setIsAdmin(false);
          setIsRealAdmin(false);
          setLoading(false);
          return;
        }
        skipProfileWriteRef.current = false;
        profileConfirmedInDbRef.current = false;
        // Clear any dev bypass if a real user logged in
        localStorage.removeItem("local_dev_bypass_user");
        // Resolve email, name, and photo from both top-level and providers list (very common on mobile/Capacitor)
        const providerInfo = currentUser.providerData || [];
        const googleProvider =
          providerInfo.find((p) => p.providerId === "google.com") ||
          providerInfo[0];
        let resolvedEmail =
          currentUser.email || providerInfo.find((p) => p.email)?.email || "";
        let resolvedName =
          currentUser.displayName ||
          providerInfo.find((p) => p.displayName)?.displayName ||
          "";
        let originalPhotoURL = currentUser.photoURL;

        Object.defineProperty(currentUser, "photoURL", {
          get() {
            const localCustom = localStorage.getItem(
              `custom_user_photo_${currentUser.uid}`
            );
            if (localCustom) return localCustom;

            const googlePhoto = providerInfo.find(
              (p) => p.providerId === "google.com"
            )?.photoURL;
            if (googlePhoto) return googlePhoto;

            return originalPhotoURL || "";
          },
          set(val) {
            originalPhotoURL = val;
          },
          configurable: true,
        });

        if (resolvedName) {
          Object.defineProperty(currentUser, "displayName", {
            get() {
              return resolvedName;
            },
            set(val) {
              resolvedName = val;
            },
            configurable: true,
          });
        }

        if (resolvedEmail) {
          Object.defineProperty(currentUser, "email", {
            get() {
              return resolvedEmail;
            },
            set(val) {
              resolvedEmail = val;
            },
            configurable: true,
          });
        }

        const isOwner =
          resolvedEmail.trim().toLowerCase() === "suman.das.199972@gmail.com";
        const profileDoc = doc(db, "settings", `profile_${currentUser.uid}`);
        const blockedListDoc = doc(db, "settings", "blocked_accounts");
        const deletedListDoc = doc(db, "settings", "deleted_accounts");

        const explicitSignInTs = Number(
          sessionStorage.getItem("explicit_google_signin_ts") || "0"
        );
        const isFreshExplicitSignIn =
          isExplicitGoogleSignInRef.current ||
          (explicitSignInTs > 0 && Date.now() - explicitSignInTs < 30000);

        // Only reject from local cache during passive background startup (never during explicit Google sign-in,
        // because an Admin may have deleted/unblocked the account since it was banned).
        if (
          !isOwner &&
          !isFreshExplicitSignIn &&
          localStorage.getItem(`is_blocked_cached_${currentUser.uid}`) === "true"
        ) {
          // Still verify with Firestore below before locking out if online, or reject immediately if offline
          if (typeof navigator !== "undefined" && !navigator.onLine) {
            setLoading(false);
            notifyAndEnforceBlockedLogout(BLOCKED_LOGIN_MESSAGE);
            return;
          }
        }

        setUser(currentUser);
        setLoading(false);

        // Load instantly from cache
        const cachedAdminRaw = localStorage.getItem(`is_admin_cached_${currentUser.uid}`);
        const cachedRealAdminRaw = localStorage.getItem(`is_real_admin_cached_${currentUser.uid}`);
        const cachedAdmin =
          cachedAdminRaw === "true" || (cachedAdminRaw === null && isOwner);
        const cachedRealAdmin =
          cachedRealAdminRaw === "true" || (cachedRealAdminRaw === null && isOwner);
        setIsAdmin(cachedAdmin);
        setIsRealAdmin(cachedRealAdmin);

        // Always query fresh server documents first when online so deleted/unblocked accounts are never stuck on stale IndexedDB cache
        Promise.all([
          fetchFreshDoc(profileDoc),
          fetchFreshDoc(blockedListDoc),
          fetchFreshDoc(deletedListDoc),
        ])
          .then(async ([docSnap, blockedSnap, deletedSnap]) => {
            const normEmail = resolvedEmail.trim().toLowerCase();

            // 1. Check deleted_accounts registry first so we know if this account was deleted after any prior ban
            const deletedData = deletedSnap?.exists() ? deletedSnap.data() : null;
            const deletedUidsMap: Record<string, number> =
              deletedData?.deletedUids && typeof deletedData.deletedUids === "object"
                ? deletedData.deletedUids
                : {};
            const deletedEmailsMap: Record<string, number> =
              deletedData?.deletedEmails && typeof deletedData.deletedEmails === "object"
                ? deletedData.deletedEmails
                : {};
            const deletedAt = Math.max(
              Number(deletedUidsMap[currentUser.uid]) || 0,
              normEmail ? Number(deletedEmailsMap[normEmail]) || 0 : 0
            );
            const docRecreatedAt = docSnap?.exists()
              ? Number(docSnap.data()?.recreatedAt || 0)
              : 0;
            if (docRecreatedAt > recreatedAtRef.current) {
              recreatedAtRef.current = docRecreatedAt;
            }
            const wasDeleted =
              !isOwner && deletedAt > 0 && docRecreatedAt <= deletedAt;

            // 2. Check blocked_accounts registry & profile isBlocked flag
            // Note: If the account was deleted at or after the block registry update, deletion supersedes the old ban!
            const blockedData = blockedSnap?.exists() ? blockedSnap.data() : null;
            const blockedUpdatedAt = Number(blockedData?.updatedAt || 0);
            const blockedUids: string[] = Array.isArray(blockedData?.blockedUids)
              ? blockedData.blockedUids
              : [];
            const blockedEmails: string[] = Array.isArray(blockedData?.blockedEmails)
              ? blockedData.blockedEmails
              : [];
            const isBlockedInRegistry =
              !isOwner &&
              !(wasDeleted && deletedAt >= blockedUpdatedAt) &&
              (blockedUids.includes(currentUser.uid) ||
                (Boolean(normEmail) && blockedEmails.includes(normEmail)));
            const isBlockedInProfile =
              !isOwner &&
              !wasDeleted &&
              Boolean(docSnap?.exists()) &&
              docSnap!.data()?.isBlocked === true;

            if (isBlockedInRegistry || isBlockedInProfile) {
              localStorage.setItem(`is_blocked_cached_${currentUser.uid}`, "true");
              notifyAndEnforceBlockedLogout(BLOCKED_LOGIN_MESSAGE);
              return;
            }
            localStorage.removeItem(`is_blocked_cached_${currentUser.uid}`);

            // 3. Handle account deletion enforcement vs. fresh account re-creation
            const currentExplicitTs = Number(
              sessionStorage.getItem("explicit_google_signin_ts") || "0"
            );
            const signedInExplicitlyNow =
              isExplicitGoogleSignInRef.current ||
              (currentExplicitTs > 0 && Date.now() - currentExplicitTs < 30000);

            if (wasDeleted && !signedInExplicitlyNow) {
              // Stale session on a device whose account was deleted by an Admin — force logout and delete any zombie doc
              skipProfileWriteRef.current = true;
              wipeLocalAccountCache(currentUser.uid);
              deleteDoc(profileDoc).catch(() => {});
              notifyAndEnforceBlockedLogout(
                "Your account was deleted by an administrator. You can sign in again to create a new account."
              );
              return;
            }

            const hasValidProfileDoc =
              Boolean(docSnap?.exists()) &&
              Boolean(docSnap?.data()?.uid || docSnap?.data()?.email || docSnap?.data()?.displayName);
            const isCreatingFreshAccount = wasDeleted || !hasValidProfileDoc;
            const freshAccountTs = Math.max(Date.now(), deletedAt + 1000);

            let customPhotoURL = "";
            let savedName = resolvedName;
            let savedEmail = resolvedEmail;
            let makeAdmin = isOwner;

            const systemDefaultTheme = getSystemDefaultTheme();
            const currentCachedUserTheme = isCreatingFreshAccount
              ? null
              : localStorage.getItem(`theme_${currentUser.uid}`);
            const currentGlobalTheme = localStorage.getItem("theme");
            const fallbackTheme: "dark" | "light" =
              currentCachedUserTheme === "dark" || currentCachedUserTheme === "light"
                ? currentCachedUserTheme
                : currentGlobalTheme === "dark" || currentGlobalTheme === "light"
                ? currentGlobalTheme
                : document.documentElement.classList.contains("dark")
                ? "dark"
                : systemDefaultTheme;

            let theme: "dark" | "light" = fallbackTheme;
            let hapticsEnabled = true;
            let notifications = true;
            let keepScreenOn = false;
            let isPrinterConnected = false;

            if (!isCreatingFreshAccount && docSnap?.exists()) {
              const data = docSnap.data();
              customPhotoURL = data.customPhotoURL || "";
              savedName = data.displayName || resolvedName || "";
              savedEmail = data.email || resolvedEmail || "";

              // Never allow temporary PIN unlock (tempAdminAuth) to turn a user into an Admin
              if (data.tempAdminAuth === true && !isOwner) {
                makeAdmin = false;
              } else if (data.isAdmin !== undefined) {
                makeAdmin = data.isAdmin === true;
              } else if (data.role !== undefined) {
                makeAdmin = data.role === "admin";
              } else {
                makeAdmin = isOwner;
              }

              // Clear any legacy tempAdminAuth flags from localStorage
              localStorage.removeItem("tempAdminAuth");
              localStorage.removeItem(`tempAdminAuth_${currentUser.uid}`);

              // Update admin state and cache immediately
              setIsAdmin(makeAdmin);
              setIsRealAdmin(makeAdmin);
              localStorage.setItem(
                `is_admin_cached_${currentUser.uid}`,
                makeAdmin ? "true" : "false"
              );
              localStorage.setItem(
                `is_real_admin_cached_${currentUser.uid}`,
                makeAdmin ? "true" : "false"
              );

              if (customPhotoURL) {
                localStorage.setItem(
                  `custom_user_photo_${currentUser.uid}`,
                  customPhotoURL
                );
              } else {
                localStorage.removeItem(`custom_user_photo_${currentUser.uid}`);
              }

              // Load saved theme from Firestore if present; otherwise keep device/cached theme
              if (data.theme === "dark" || data.theme === "light") {
                theme = data.theme;
              } else {
                theme = fallbackTheme;
              }
              hapticsEnabled =
                data.hapticsEnabled !== undefined
                  ? data.hapticsEnabled
                  : localStorage.getItem(`hapticsEnabled_${currentUser.uid}`) !== "false";
              notifications =
                data.notifications !== undefined
                  ? data.notifications
                  : localStorage.getItem(`notifications_${currentUser.uid}`) !== "false";
              if (data.keepScreenOnResetV2 === true) {
                keepScreenOn = data.keepScreenOn === true;
              } else {
                keepScreenOn = false;
              }
              isPrinterConnected = false;
            } else {
              // Brand new account OR re-creating a fresh account after Admin deletion!
              // Reset any old custom name/photo/role/cache so the account starts 100% clean from Google provider data
              wipeLocalAccountCache(currentUser.uid);

              const freshGoogleName =
                googleProvider?.displayName ||
                (resolvedEmail ? resolvedEmail.split("@")[0] : "") ||
                resolvedName ||
                "User";
              const freshGooglePhoto = googleProvider?.photoURL || "";

              savedName = freshGoogleName;
              savedEmail = resolvedEmail;
              customPhotoURL = freshGooglePhoto;
              originalPhotoURL = freshGooglePhoto;

              // Reset Firebase Auth's cached user profile if it still held an old custom displayName (e.g. from Account.tsx)
              updateProfile(currentUser, {
                displayName: freshGoogleName,
                photoURL: freshGooglePhoto,
              }).catch(() => {});

              makeAdmin = isOwner;
              setIsAdmin(makeAdmin);
              setIsRealAdmin(makeAdmin);
              localStorage.setItem(
                `is_admin_cached_${currentUser.uid}`,
                makeAdmin ? "true" : "false"
              );
              localStorage.setItem(
                `is_real_admin_cached_${currentUser.uid}`,
                makeAdmin ? "true" : "false"
              );
              theme = systemDefaultTheme;
              hapticsEnabled = true;
              notifications = true;
              keepScreenOn = false;
              isPrinterConnected = false;

              recreatedAtRef.current = freshAccountTs;

              // Remove UID & email from deleted_accounts (WITHOUT merge:true so keys are truly deleted)
              if (deletedAt > 0 || deletedUidsMap[currentUser.uid] || (normEmail && deletedEmailsMap[normEmail])) {
                const nextDeletedUids = { ...deletedUidsMap };
                const nextDeletedEmails = { ...deletedEmailsMap };
                delete nextDeletedUids[currentUser.uid];
                if (normEmail) delete nextDeletedEmails[normEmail];
                setDoc(deletedListDoc, {
                  deletedUids: nextDeletedUids,
                  deletedEmails: nextDeletedEmails,
                  updatedAt: freshAccountTs,
                }).catch(() => {});
              }

              // Also ensure UID & email are removed from blocked_accounts if they were left over before deletion
              if (
                blockedUids.includes(currentUser.uid) ||
                (Boolean(normEmail) && blockedEmails.includes(normEmail))
              ) {
                const nextBlockedUids = blockedUids.filter((id) => id !== currentUser.uid);
                const nextBlockedEmails = blockedEmails.filter(
                  (em) => String(em).trim().toLowerCase() !== normEmail
                );
                setDoc(blockedListDoc, {
                  blockedUids: nextBlockedUids,
                  blockedEmails: nextBlockedEmails,
                  updatedAt: freshAccountTs,
                }).catch(() => {});
              }

              // Reset PIN attempts for the fresh account
              setDoc(doc(db, "settings", `attempts_${currentUser.uid}`), {
                failedCount: 0,
                lockedByAdmin: false,
                reason: "reset",
              }).catch(() => {});

              // Purge any other stale profile_* or attempts_* docs in settings with the same email (e.g. old Web/Mobile duplicate UID)
              if (normEmail) {
                getDocsFromServer(collection(db, "settings"))
                  .catch(() => getDocs(collection(db, "settings")))
                  .then((settingsSnap) => {
                    settingsSnap.docs.forEach((d) => {
                      if (d.id.startsWith("profile_") && d.id !== `profile_${currentUser.uid}`) {
                        const dEmail = String(d.data()?.email || "").trim().toLowerCase();
                        if (dEmail === normEmail) {
                          const oldUid = d.id.replace("profile_", "");
                          deleteDoc(d.ref).catch(() => {});
                          deleteDoc(doc(db, "settings", `attempts_${oldUid}`)).catch(() => {});
                        }
                      }
                    });
                  })
                  .catch(() => {});
              }
            }

            // Write back synchronized values to local storage for the current session
            localStorage.setItem(`hapticsEnabled_${currentUser.uid}`, hapticsEnabled.toString());
            localStorage.setItem(`notifications_${currentUser.uid}`, notifications.toString());
            localStorage.setItem(`keepScreenOn_reset_v2_${currentUser.uid}`, "true");
            localStorage.setItem("keepScreenOn_reset_v2", "true");
            localStorage.setItem("keepScreenOn", keepScreenOn.toString());
            localStorage.setItem(`keepScreenOn_${currentUser.uid}`, keepScreenOn.toString());
            localStorage.setItem(`isPrinterConnected_${currentUser.uid}`, "false");
            window.dispatchEvent(new Event("keepScreenOnChanged"));

            // Apply theme instantly and notify listeners
            applyAppTheme(theme, currentUser.uid);

            // Ensure customPhotoURL is NOT empty if currentUser has a photoURL
            if (!customPhotoURL && currentUser.photoURL) {
              customPhotoURL = currentUser.photoURL;
            }

            if (skipProfileWriteRef.current) return;

            const writeNow = isCreatingFreshAccount
              ? Math.max(Date.now(), freshAccountTs)
              : Date.now();
            if (isCreatingFreshAccount) {
              recreatedAtRef.current = writeNow;
            }

            // Save/update profile doc in Firestore (overwrite completely when creating a fresh account so no stale fields survive)
            setDoc(
              profileDoc,
              {
                uid: currentUser.uid,
                email: savedEmail,
                displayName: savedName,
                customPhotoURL: customPhotoURL,
                isAdmin: makeAdmin,
                role: makeAdmin ? "admin" : "user",
                isBlocked: false,
                blockedAt: null,
                tempAdminAuth: false,
                theme,
                hapticsEnabled,
                notifications,
                keepScreenOn,
                keepScreenOnResetV2: true,
                isPrinterConnected,
                ...(isCreatingFreshAccount
                  ? { createdAt: writeNow, recreatedAt: writeNow }
                  : {}),
                updatedAt: writeNow,
                isOnline: true,
                lastActive: writeNow,
              },
              isCreatingFreshAccount ? undefined : { merge: true }
            )
              .then(() => {
                profileConfirmedInDbRef.current = true;
              })
              .catch((e) => {
                console.warn(
                  "Failed to auto-update profile settings doc on login",
                  e
                );
              });

            setUser((prev) => {
              if (!prev || prev.uid !== currentUser.uid) return prev;
              const updatedUser = Object.assign(
                Object.create(Object.getPrototypeOf(prev)),
                prev
              );
              Object.defineProperty(updatedUser, "photoURL", {
                get() {
                  const localCustom = localStorage.getItem(
                    `custom_user_photo_${prev.uid}`
                  );
                  if (localCustom) return localCustom;

                  const googlePhoto = prev.providerData?.find(
                    (p) => p.providerId === "google.com"
                  )?.photoURL;
                  if (googlePhoto) return googlePhoto;

                  return originalPhotoURL || "";
                },
                set(val) {
                  originalPhotoURL = val;
                },
                configurable: true,
              });
              if (savedName) {
                Object.defineProperty(updatedUser, "displayName", {
                  get() {
                    return savedName;
                  },
                  set(val) {
                    savedName = val;
                  },
                  configurable: true,
                });
              }
              if (savedEmail) {
                Object.defineProperty(updatedUser, "email", {
                  get() {
                    return savedEmail;
                  },
                  set(val) {
                    savedEmail = val;
                  },
                  configurable: true,
                });
              }
              return updatedUser as User;
            });
          })
          .catch((err) => {
            console.warn("Profile doc fetch bypassed", err);
          });

        if (!sessionStorage.getItem("sessionStartTime")) {
          sessionStorage.setItem("sessionStartTime", Date.now().toString());
        }

        // Apply user-specific cached theme if already saved locally; otherwise preserve current/device theme until Firestore responds
        const cachedUserTheme = localStorage.getItem(`theme_${currentUser.uid}`);
        if (cachedUserTheme === "dark" || cachedUserTheme === "light") {
          applyAppTheme(cachedUserTheme, currentUser.uid);
        }
      } else {
        setUser(null);
        setLoading(false);
        sessionStorage.removeItem("sessionStartTime");
        // When not signed in, follow saved theme or device default OS theme
        const savedGlobal = localStorage.getItem("theme");
        const targetTheme =
          savedGlobal === "dark" || savedGlobal === "light"
            ? savedGlobal
            : getSystemDefaultTheme();
        const isDark = targetTheme === "dark";
        document.documentElement.classList.toggle("dark", isDark);
        updateStatusBarTheme(isDark);
      }
    });

    return () => unsubscribeAuth();
  }, []);

  // 1. Subscribe to profile and blocked_accounts to update isAdmin status, theme, custom photo, and enforce block/delete in real time
  useEffect(() => {
    if (!user) {
      setIsAdmin(false);
      setIsRealAdmin(false);
      return;
    }

    const refreshUserAvatar = () => {
      setUser((prev) => {
        if (!prev) return prev;
        const updated = Object.assign(Object.create(Object.getPrototypeOf(prev)), prev);
        return updated as User;
      });
    };

    window.addEventListener("profilePhotoUpdated", refreshUserAvatar);

    const profileDoc = doc(db, "settings", `profile_${user.uid}`);
    const unsubscribe = onSnapshot(
      profileDoc,
      (docSnap) => {
        const isOwner =
          String(user.email || "").trim().toLowerCase() === "suman.das.199972@gmail.com";
        let userIsRealAdmin = isOwner;

        if (docSnap.exists()) {
          profileConfirmedInDbRef.current = true;
          const data = docSnap.data();
          if (Number(data.recreatedAt || 0) > recreatedAtRef.current) {
            recreatedAtRef.current = Number(data.recreatedAt || 0);
          }
          const savedEmail = data.email || user.email || "";
          const isAcctOwner =
            isOwner ||
            String(savedEmail).trim().toLowerCase() === "suman.das.199972@gmail.com";

          // If admin blocked this account, immediately sign them out and show the blocked message
          if (!isAcctOwner && data.isBlocked === true && !isExplicitGoogleSignInRef.current) {
            localStorage.setItem(`is_blocked_cached_${user.uid}`, "true");
            notifyAndEnforceBlockedLogout(BLOCKED_LOGIN_MESSAGE);
            return;
          }
          localStorage.removeItem(`is_blocked_cached_${user.uid}`);

          // Sync saved account theme from Firestore in real time
          if (data.theme === "dark" || data.theme === "light") {
            const currentApplied = document.documentElement.classList.contains("dark")
              ? "dark"
              : "light";
            if (
              currentApplied !== data.theme ||
              localStorage.getItem(`theme_${user.uid}`) !== data.theme
            ) {
              applyAppTheme(data.theme, user.uid);
            }
          }
          
          if (data.customPhotoURL !== undefined) {
            if (data.customPhotoURL) {
              localStorage.setItem(`custom_user_photo_${user.uid}`, data.customPhotoURL);
            } else {
              localStorage.removeItem(`custom_user_photo_${user.uid}`);
            }
            refreshUserAvatar();
          }

          // If a legacy tempAdminAuth flag is present on a non-owner profile, clean it up in Firestore
          if (data.tempAdminAuth === true && !isAcctOwner) {
            userIsRealAdmin = false;
            setDoc(
              profileDoc,
              {
                isAdmin: false,
                role: "user",
                tempAdminAuth: false,
              },
              { merge: true }
            ).catch(() => {});
          } else {
            let profileIsAdmin = false;
            if (data.isAdmin !== undefined) {
              profileIsAdmin = data.isAdmin === true;
            } else if (data.role !== undefined) {
              profileIsAdmin = data.role === "admin";
            } else {
              profileIsAdmin = isAcctOwner;
            }
            userIsRealAdmin = profileIsAdmin;
          }
        } else if (
          profileConfirmedInDbRef.current &&
          !isOwner &&
          !isExplicitGoogleSignInRef.current
        ) {
          // Profile existed during this session and was just deleted from the database by an Admin
          skipProfileWriteRef.current = true;
          wipeLocalAccountCache(user.uid);
          notifyAndEnforceBlockedLogout(
            "Your account was deleted by an administrator. You can sign in again to create a new account."
          );
          return;
        }
        localStorage.removeItem("tempAdminAuth");
        localStorage.removeItem(`tempAdminAuth_${user.uid}`);
        setIsAdmin(userIsRealAdmin);
        setIsRealAdmin(userIsRealAdmin);
        localStorage.setItem(
          `is_admin_cached_${user.uid}`,
          userIsRealAdmin ? "true" : "false"
        );
        localStorage.setItem(
          `is_real_admin_cached_${user.uid}`,
          userIsRealAdmin ? "true" : "false"
        );
      },
      (err) => {
        console.warn("Profile listener error bypassed", err);
      }
    );

    const blockedDoc = doc(db, "settings", "blocked_accounts");
    const unsubscribeBlocked = onSnapshot(
      blockedDoc,
      (snap) => {
        if (!snap.exists() || isExplicitGoogleSignInRef.current) return;
        const isOwner =
          String(user.email || "").trim().toLowerCase() === "suman.das.199972@gmail.com";
        if (isOwner) return;
        const data = snap.data();
        const blockedUids: string[] = Array.isArray(data?.blockedUids) ? data.blockedUids : [];
        const blockedEmails: string[] = Array.isArray(data?.blockedEmails)
          ? data.blockedEmails
          : [];
        const normEmail = String(user.email || "").trim().toLowerCase();
        if (
          blockedUids.includes(user.uid) ||
          (Boolean(normEmail) && blockedEmails.includes(normEmail))
        ) {
          localStorage.setItem(`is_blocked_cached_${user.uid}`, "true");
          notifyAndEnforceBlockedLogout(BLOCKED_LOGIN_MESSAGE);
        } else {
          localStorage.removeItem(`is_blocked_cached_${user.uid}`);
        }
      },
      () => {}
    );

    const deletedDoc = doc(db, "settings", "deleted_accounts");
    const unsubscribeDeleted = onSnapshot(
      deletedDoc,
      (snap) => {
        if (!snap.exists()) return;
        const isOwner =
          String(user.email || "").trim().toLowerCase() === "suman.das.199972@gmail.com";
        if (isOwner) return;
        const data = snap.data();
        const deletedUidsMap: Record<string, number> =
          data?.deletedUids && typeof data.deletedUids === "object" ? data.deletedUids : {};
        const deletedEmailsMap: Record<string, number> =
          data?.deletedEmails && typeof data.deletedEmails === "object"
            ? data.deletedEmails
            : {};
        const normEmail = String(user.email || "").trim().toLowerCase();
        const deletedAt = Math.max(
          Number(deletedUidsMap[user.uid]) || 0,
          normEmail ? Number(deletedEmailsMap[normEmail]) || 0 : 0
        );
        if (deletedAt > 0) {
          const explicitSignInTs = Number(
            sessionStorage.getItem("explicit_google_signin_ts") || "0"
          );
          const isMidExplicitSignIn =
            isExplicitGoogleSignInRef.current ||
            (explicitSignInTs > 0 && Date.now() - explicitSignInTs < 15000);
          if (!isMidExplicitSignIn && deletedAt > recreatedAtRef.current) {
            skipProfileWriteRef.current = true;
            wipeLocalAccountCache(user.uid);
            deleteDoc(doc(db, "settings", `profile_${user.uid}`)).catch(() => {});
            notifyAndEnforceBlockedLogout(
              "Your account was deleted by an administrator. You can sign in again to create a new account."
            );
          }
        }
      },
      () => {}
    );

    return () => {
      window.removeEventListener("profilePhotoUpdated", refreshUserAvatar);
      unsubscribe();
      unsubscribeBlocked();
      unsubscribeDeleted();
    };
  }, [user?.uid]);

  // 2. Subscribe to failed attempts count & lock cause in Firestore (Non-Admins only!)
  useEffect(() => {
    if (!user) {
      setFailedAttempts(0);
      setLockedByAdmin(false);
      return;
    }

    // Admins have unlimited local tries and should never have their lockout state governed by Firestore
    if (isAdmin) {
      setFailedAttempts(0);
      setLockedByAdmin(false);
      return;
    }

    const attemptsDoc = doc(db, "settings", `attempts_${user.uid}`);
    const unsubscribe = onSnapshot(
      attemptsDoc,
      (docSnap) => {
        if (docSnap.exists()) {
          const data = docSnap.data();
          const count = data.failedCount || 0;
          const isAdminLocked =
            data.lockedByAdmin === true ||
            data.reason === "admin_lock" ||
            (count >= 3 && data.reason !== "failed_attempts");
          setFailedAttempts(count);
          setLockedByAdmin(isAdminLocked);
        } else {
          setFailedAttempts(0);
          setLockedByAdmin(false);
        }
      },
      (err) => {
        console.warn("Attempts subscription error bypassed", err);
      }
    );

    return () => unsubscribe();
  }, [user?.uid, isAdmin]);

  // Online/Presence heartbeat & active status management
  useEffect(() => {
    if (!user) return;

    const profileRef = doc(db, "settings", `profile_${user.uid}`);

    const updatePresence = (online: boolean) => {
      if (skipProfileWriteRef.current || !profileConfirmedInDbRef.current) return;
      setDoc(
        profileRef,
        {
          isOnline: online,
          lastActive: Date.now(),
        },
        { merge: true }
      ).catch(() => {});
    };

    const interval = setInterval(() => {
      if (document.visibilityState === "visible") {
        updatePresence(true);
      }
    }, 20000); // every 20 seconds

    const handleVisibilityChange = () => {
      if (document.visibilityState === "hidden") {
        updatePresence(false);
      } else {
        updatePresence(true);
      }
    };

    const handlePageHide = () => {
      updatePresence(false);
    };

    window.addEventListener("pagehide", handlePageHide);
    window.addEventListener("beforeunload", handlePageHide);
    document.addEventListener("visibilitychange", handleVisibilityChange);

    return () => {
      clearInterval(interval);
      window.removeEventListener("pagehide", handlePageHide);
      window.removeEventListener("beforeunload", handlePageHide);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      updatePresence(false);
    };
  }, [user?.uid]);

  // Auto-cleanup temporary admin status on startup or when leaving admin session
  useEffect(() => {
    if (!user) return;

    const cleanupTempAdminIfNeeded = async () => {
      const hasTempFlag =
        localStorage.getItem(`tempAdminAuth_${user.uid}`) === "true" ||
        localStorage.getItem("tempAdminAuth") === "true";
      if (!hasTempFlag || sessionStorage.getItem("adminAuth") === "true") {
        return;
      }
      if (user.email === "suman.das.199972@gmail.com") {
        localStorage.removeItem("tempAdminAuth");
        localStorage.removeItem(`tempAdminAuth_${user.uid}`);
        return;
      }
      try {
        const profileRef = doc(db, "settings", `profile_${user.uid}`);
        const snap = await getDoc(profileRef);
        // Only demote if this user's Firestore profile explicitly has tempAdminAuth === true
        if (snap.exists() && snap.data()?.tempAdminAuth === true) {
          await setDoc(
            profileRef,
            {
              isAdmin: false,
              role: "user",
              tempAdminAuth: false,
            },
            { merge: true }
          );
        }
      } catch (err) {
        console.debug("Auto-cleanup temp admin status skipped:", err);
      } finally {
        localStorage.removeItem("tempAdminAuth");
        localStorage.removeItem(`tempAdminAuth_${user.uid}`);
      }
    };

    cleanupTempAdminIfNeeded();
    window.addEventListener("adminAuthChanged", cleanupTempAdminIfNeeded);
    return () => {
      window.removeEventListener("adminAuthChanged", cleanupTempAdminIfNeeded);
    };
  }, [user?.uid]);

  // 3. Subscribe to force security logout trigger
  useEffect(() => {
    if (!user) return;

    const forceLogoutDoc = doc(db, "settings", "security_status");
    const unsubscribe = onSnapshot(
      forceLogoutDoc,
      (docSnap) => {
        if (docSnap.exists()) {
          const data = docSnap.data();
          const forcedLogoutAt = data.forcedLogoutAt || 0;
          const sessionStart = parseInt(
            sessionStorage.getItem("sessionStartTime") || "0",
            10
          );

          // Log out user if they are NOT an admin
          if (forcedLogoutAt > sessionStart && !isAdmin) {
            localStorage.setItem(
              "adminLogoutMessage",
              "You have been logged out securely by the administrator."
            );
            signOut();
          }
        }
      },
      (err) => {
        console.warn("Forced logout subscription error bypassed", err);
      }
    );

    return () => unsubscribe();
  }, [user?.uid, isAdmin]);

  // Security alert notifications & banners are handled centrally in App.tsx to prevent duplicate alerts

  const incrementFailedAttempts = async () => {
    if (!user) return;

    if (isAdmin) {
      // Admin gets unlimited tries without lockout or security alerts
      const nextFailedCount = (failedAttempts + 1) % 4;
      setFailedAttempts(nextFailedCount);
      await logActivity(
        "failed_login",
        `Admin entered incorrect security PIN.`,
        user.uid,
        user.displayName || "Anonymous User",
        user.email || "No email"
      );
      return;
    }

    // Non-admin user failed: up to 3 attempts before lockout & multi-admin security broadcast
    const nextFailedCount = failedAttempts + 1;
    setFailedAttempts(nextFailedCount);

    await logActivity(
      "failed_login",
      `Failed PIN login attempt. Attempt count: ${nextFailedCount}/3`,
      user.uid,
      user.displayName || "Anonymous User",
      user.email || "No email"
    );

    try {
      // Record attempts count in Firestore (explicitly marked as PIN failure)
      await setDoc(
        doc(db, "settings", `attempts_${user.uid}`),
        {
          failedCount: nextFailedCount,
          lockedByAdmin: false,
          reason: "failed_attempts",
        },
        { merge: true }
      );

      if (nextFailedCount >= 3) {
        const now = Date.now();
        const currentDeviceId = getDeviceId();
        const alertRef = doc(collection(db, "security_alerts"));
        markLocalSecurityAlertTriggered(alertRef.id);
        const alertMessage = `Security Alert! Non-Admin account "${
          user.displayName || user.email || "Anonymous Non-Admin"
        }" (${user.email || "no-email"}) failed 3 PIN attempts and has been locked out.`;
        const alertPayload = {
          id: alertRef.id,
          alertId: alertRef.id,
          deviceId: currentDeviceId,
          userId: user.uid,
          userUid: user.uid,
          userName: user.displayName || user.email || "Anonymous Non-Admin",
          userEmail: user.email || "no-email",
          timestamp: now,
          type: "failed_pin_lockout",
          reason: "Unauthorized admin panel login: 3 failed PIN attempts",
          message: alertMessage,
          acknowledgedBy: [user.uid],
        };
        await setDoc(alertRef, alertPayload);

        // Also update global_security_message with acknowledgedBy: [user.uid] so all admins on other devices get the modal overlay
        try {
          await setDoc(doc(db, "settings", "global_security_message"), {
            alertId: alertRef.id,
            deviceId: currentDeviceId,
            timestamp: now,
            type: "failed_pin_lockout",
            message: alertMessage,
            userUid: user.uid,
            userName: alertPayload.userName,
            userEmail: alertPayload.userEmail,
            acknowledgedBy: [user.uid],
          });
        } catch (msgErr) {
          console.debug("Could not write global security message:", msgErr);
        }

        // Log out immediately to remove their session access
        setTimeout(() => {
          signOut();
        }, 1500);
      }
    } catch (e) {
      console.warn("Failed to handle intruder lockout and forward alert:", e);
    }
  };

  const resetFailedAttempts = async () => {
    if (!user) return;
    setFailedAttempts(0);
    setLockedByAdmin(false);
    try {
      await setDoc(
        doc(db, "settings", `attempts_${user.uid}`),
        { failedCount: 0, lockedByAdmin: false, reason: "reset" },
        { merge: true }
      );
    } catch (e) {
      console.error("Failed to reset attempts in AuthContext:", e);
    }
  };

  const signOut = async () => {
    sessionStorage.removeItem("adminAuth");
    if (user && !skipProfileWriteRef.current && profileConfirmedInDbRef.current) {
      const profileRef = doc(db, "settings", `profile_${user.uid}`);
      try {
        await Promise.race([
          setDoc(
            profileRef,
            {
              isOnline: false,
              lastActive: Date.now(),
              ...(localStorage.getItem("tempAdminAuth") === "true"
                ? {
                    isAdmin: false,
                    role: "user",
                    tempAdminAuth: false,
                  }
                : {}),
            },
            { merge: true }
          ),
          new Promise((resolve) => setTimeout(resolve, 800)),
        ]);
      } catch (err) {
        console.warn("Failed to set user offline during sign out:", err);
      }

      if (localStorage.getItem("tempAdminAuth") === "true") {
        localStorage.removeItem("tempAdminAuth");
      }
    }
    localStorage.removeItem("local_dev_bypass_user");
    localStorage.removeItem("theme");
    const sysTheme = getSystemDefaultTheme();
    document.documentElement.classList.toggle("dark", sysTheme === "dark");
    updateStatusBarTheme(sysTheme === "dark");
    window.dispatchEvent(new CustomEvent("themeChanged", { detail: { theme: sysTheme } }));
    setUser(null);
    setIsAdmin(false);
    setIsRealAdmin(false);

    if (Capacitor.isNativePlatform()) {
      try {
        await FirebaseAuthentication.signOut();
      } catch (e) {
        console.warn("Failed to sign out from Capacitor:", e);
      }
    }
    try {
      await firebaseSignOut(auth);
    } catch (e) {
      console.warn("Failed to sign out from Firebase Auth:", e);
    }
  };

  const signInWithGoogle = async () => {
    isExplicitGoogleSignInRef.current = true;
    try {
      sessionStorage.setItem("explicit_google_signin_ts", String(Date.now()));
      if (Capacitor.isNativePlatform()) {
        let result;
        try {
          result = await FirebaseAuthentication.signInWithGoogle();
        } catch (e: any) {
          const errorMsg = e?.message?.toLowerCase() || "";
          if (
            errorMsg.includes("credential manager") ||
            errorMsg.includes("no credentials available")
          ) {
            console.warn(
              "Credential manager issue or no credentials available, falling back to legacy Google Sign-In..."
            );
            result = await FirebaseAuthentication.signInWithGoogle({
              useCredentialManager: false,
            });
          } else {
            throw e;
          }
        }

        if (result.credential?.idToken) {
          const credential = GoogleAuthProvider.credential(
            result.credential.idToken
          );
          await signInWithCredential(auth, credential);
        }
      } else {
        const provider = new GoogleAuthProvider();
        await signInWithPopup(auth, provider);
      }

      sessionStorage.setItem("explicit_google_signin_ts", String(Date.now()));

      // Immediately verify the signed-in user is not blocked before completing signInWithGoogle
      const signedInUser = auth.currentUser;
      if (signedInUser) {
        const providerEmail =
          signedInUser.email ||
          signedInUser.providerData?.find((p) => p.email)?.email ||
          "";
        const normEmail = providerEmail.trim().toLowerCase();
        const isOwner = normEmail === "suman.das.199972@gmail.com";

        if (!isOwner) {
          const [profSnap, blockedSnap, deletedSnap] = await Promise.all([
            fetchFreshDoc(doc(db, "settings", `profile_${signedInUser.uid}`)),
            fetchFreshDoc(doc(db, "settings", "blocked_accounts")),
            fetchFreshDoc(doc(db, "settings", "deleted_accounts")),
          ]);

          const deletedData = deletedSnap?.exists() ? deletedSnap.data() : null;
          const deletedUidsMap: Record<string, number> =
            deletedData?.deletedUids && typeof deletedData.deletedUids === "object"
              ? deletedData.deletedUids
              : {};
          const deletedEmailsMap: Record<string, number> =
            deletedData?.deletedEmails && typeof deletedData.deletedEmails === "object"
              ? deletedData.deletedEmails
              : {};
          const deletedAt = Math.max(
            Number(deletedUidsMap[signedInUser.uid]) || 0,
            normEmail ? Number(deletedEmailsMap[normEmail]) || 0 : 0
          );
          const docRecreatedAt = profSnap?.exists()
            ? Number(profSnap.data()?.recreatedAt || 0)
            : 0;
          const wasDeleted = deletedAt > 0 && docRecreatedAt <= deletedAt;

          const blockedData = blockedSnap?.exists() ? blockedSnap.data() : null;
          const blockedUpdatedAt = Number(blockedData?.updatedAt || 0);
          const blockedUids: string[] = Array.isArray(blockedData?.blockedUids)
            ? blockedData.blockedUids
            : [];
          const blockedEmails: string[] = Array.isArray(blockedData?.blockedEmails)
            ? blockedData.blockedEmails
            : [];
          const isBlocked =
            (!wasDeleted && profSnap?.exists() && profSnap.data()?.isBlocked === true) ||
            (!(wasDeleted && deletedAt >= blockedUpdatedAt) &&
              (blockedUids.includes(signedInUser.uid) ||
                (Boolean(normEmail) && blockedEmails.includes(normEmail))));

          if (isBlocked) {
            isExplicitGoogleSignInRef.current = false;
            sessionStorage.removeItem("explicit_google_signin_ts");
            localStorage.setItem(`is_blocked_cached_${signedInUser.uid}`, "true");
            await notifyAndEnforceBlockedLogout(BLOCKED_LOGIN_MESSAGE);
            throw new Error(BLOCKED_LOGIN_MESSAGE);
          }

          localStorage.removeItem(`is_blocked_cached_${signedInUser.uid}`);
        }
      }
    } catch (error: any) {
      isExplicitGoogleSignInRef.current = false;
      sessionStorage.removeItem("explicit_google_signin_ts");
      console.error("Google Sign-In Error:", error);
      throw error;
    } finally {
      setTimeout(() => {
        isExplicitGoogleSignInRef.current = false;
      }, 5000);
    }
  };

  return (
    <AuthContext.Provider
      value={{
        user,
        loading,
        isAdmin,
        isRealAdmin,
        signOut,
        signInWithGoogle,
        failedAttempts,
        lockedByAdmin,
        incrementFailedAttempts,
        resetFailedAttempts,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
};

export const useAuth = () => useContext(AuthContext);
