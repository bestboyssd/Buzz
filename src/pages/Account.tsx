import React, { useState, useEffect } from "react";
import { motion, AnimatePresence } from "motion/react";
import {
  ArrowLeft,
  User,
  Camera,
  LogOut,
  CheckCircle,
  AlertTriangle,
  Save,
} from "lucide-react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "../lib/AuthContext";
import { triggerHaptic } from "../lib/haptics";
import { updateProfile } from "firebase/auth";
import { compressProfileImage } from "../lib/imageUtils";
import { db } from "../lib/firebase";
import { doc, setDoc } from "firebase/firestore";
import { Capacitor } from "@capacitor/core";
import { Camera as CapCamera, CameraResultType, CameraSource } from "@capacitor/camera";

export function Account() {
  const navigate = useNavigate();
  const { user, signOut } = useAuth();

  const [displayName, setDisplayName] = useState(() => user?.displayName || "");
  const [photoURL, setPhotoURL] = useState(() => user?.photoURL || "");
  const [imageLoadError, setImageLoadError] = useState(false);
  const [loading, setLoading] = useState(false);
  const [success, setSuccess] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    if (user) {
      setDisplayName(user.displayName || "");
      setPhotoURL(user.photoURL || "");
      setImageLoadError(false);
    }
  }, [user?.uid, user?.displayName, user?.photoURL]);

  const handlePickImage = async () => {
    if (Capacitor.isNativePlatform()) {
      try {
        const photo = await CapCamera.getPhoto({
          quality: 85,
          allowEditing: false,
          resultType: CameraResultType.DataUrl,
          source: CameraSource.Photos,
          width: 360,
          height: 360,
          correctOrientation: true,
        });

        if (photo?.dataUrl) {
          setLoading(true);
          setError("");
          setSuccess("");
          try {
            const compressedUrl = await compressProfileImage(photo.dataUrl);
            setPhotoURL(compressedUrl);
            setImageLoadError(false);
            triggerHaptic("light");
          } catch (compErr) {
            setPhotoURL(photo.dataUrl);
            setImageLoadError(false);
            triggerHaptic("light");
          } finally {
            setLoading(false);
          }
        }
        return;
      } catch (nativeErr: any) {
        const msg = (nativeErr?.message || "").toLowerCase();
        // If the user cancelled or dismissed the picker, don't show an error
        if (
          msg.includes("cancelled") ||
          msg.includes("canceled") ||
          msg.includes("no image picked") ||
          msg.includes("user cancelled")
        ) {
          return;
        }
        console.warn("Native camera failed, falling back to file picker:", nativeErr);
      }
    }

    // Web or fallback
    document.getElementById("imageUpload")?.click();
  };

  const handleUpdate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!user) return;

    setLoading(true);
    setError("");
    setSuccess("");

    const trimmedPhoto = photoURL.trim();
    const trimmedName = displayName.trim();

    try {
      const isPhotoTooLong =
        trimmedPhoto.length > 1500 || trimmedPhoto.startsWith("data:");

      if (trimmedPhoto) {
        try {
          localStorage.setItem(`custom_user_photo_${user.uid}`, trimmedPhoto);
        } catch (storageErr) {
          console.warn("Local storage cache photo non-fatal error:", storageErr);
        }
      } else {
        try {
          localStorage.removeItem(`custom_user_photo_${user.uid}`);
        } catch (_) {}
      }

      const authPromise = updateProfile(user, {
        displayName: trimmedName,
        photoURL: isPhotoTooLong || !trimmedPhoto ? null : trimmedPhoto,
      }).catch((authErr) => {
        console.warn("Firebase Auth updateProfile non-fatal error:", authErr);
      });

      const dbPromise = setDoc(
        doc(db, "settings", `profile_${user.uid}`),
        {
          customPhotoURL: trimmedPhoto || "",
          displayName: trimmedName,
          updatedAt: Date.now(),
        },
        { merge: true }
      ).catch((dbErr) => {
        console.warn("Non-fatal: could not sync profile to Firestore immediately:", dbErr);
      });

      // Wait briefly for local cache queue, never block UI on mobile network stream
      await Promise.race([
        Promise.all([authPromise, dbPromise]),
        new Promise((resolve) => setTimeout(resolve, 120)),
      ]);

      // Update in-memory user properties immediately
      try {
        (user as any).displayName = trimmedName;
        (user as any).photoURL = trimmedPhoto;
      } catch (_) {}

      // Notify other views that profile photo was updated
      window.dispatchEvent(new Event("profilePhotoUpdated"));

      setSuccess("Profile updated successfully!");
      triggerHaptic("success");
    } catch (err: any) {
      console.error("Profile update error:", err);
      if (trimmedPhoto && localStorage.getItem(`custom_user_photo_${user?.uid}`) === trimmedPhoto) {
        setSuccess("Profile updated locally!");
        triggerHaptic("success");
      } else {
        setError(err.message || "Failed to update profile");
        triggerHaptic("error");
      }
    } finally {
      setLoading(false);
    }
  };

  const handleSignOut = async () => {
    triggerHaptic("heavy");
    await signOut();
    navigate("/");
  };

  const hasChanges =
    displayName !== (user?.displayName || "") ||
    photoURL !== (user?.photoURL || "");

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{
        opacity: 0,
        y: -8,
        transition: { duration: 0.18, ease: [0.16, 1, 0.3, 1] },
      }}
      transition={{ duration: 0.25, ease: [0.16, 1, 0.3, 1] }}
      className="p-4 sm:p-6 max-w-lg mx-auto w-full pt-6 transform-gpu will-change-transform"
    >
      <div className="flex items-center justify-between mb-8">
        <div className="flex items-center gap-4">
          <button
            onClick={() => {
              triggerHaptic("light");
              navigate(-1);
            }}
            className="w-10 h-10 flex-shrink-0 flex items-center justify-center bg-slate-200 dark:bg-slate-700 rounded-full shadow-sm hover:scale-105 active:scale-95 transition-all text-slate-700 dark:text-slate-200 border border-transparent outline-none pointer-events-auto"
          >
            <ArrowLeft size={20} />
          </button>
          <div>
            <h1 className="text-2xl font-black text-slate-800 dark:text-slate-100 tracking-tight">
              Profile
            </h1>
            <p className="text-sm font-medium text-slate-500 dark:text-slate-400">
              Settings & preferences
            </p>
          </div>
        </div>
        <button
          onClick={handleSignOut}
          className="w-12 h-12 flex items-center justify-center bg-red-50 dark:bg-red-500/10 hover:bg-red-100 dark:hover:bg-red-500/20 text-red-600 dark:text-red-400 rounded-2xl shadow-sm border border-red-100 dark:border-red-900/30 hover:scale-105 active:scale-95 transition-all"
        >
          <LogOut size={22} className="ml-1" />
        </button>
      </div>

      <div className="glass-panel p-6 sm:p-8 rounded-[2.5rem] shadow-2xl relative overflow-hidden">
        <AnimatePresence mode="wait">
          {error && (
            <motion.div
              key="account-error-banner"
              initial={{ opacity: 0, height: 0, scale: 0.95 }}
              animate={{ opacity: 1, height: "auto", scale: 1 }}
              exit={{ opacity: 0, height: 0, scale: 0.95 }}
              className="bg-red-50 dark:bg-red-500/10 text-red-600 dark:text-red-400 p-4 rounded-2xl mb-6 flex items-start gap-3 border border-red-200 dark:border-red-500/20 shadow-sm"
            >
              <AlertTriangle size={20} className="shrink-0 mt-0.5" />
              <p className="text-sm font-medium">{error}</p>
            </motion.div>
          )}
          {success && (
            <motion.div
              key="account-success-banner"
              initial={{ opacity: 0, height: 0, scale: 0.95 }}
              animate={{ opacity: 1, height: "auto", scale: 1 }}
              exit={{ opacity: 0, height: 0, scale: 0.95 }}
              className="bg-emerald-50 dark:bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 p-4 rounded-2xl mb-6 flex items-start gap-3 border border-emerald-200 dark:border-emerald-500/20 shadow-sm"
            >
              <CheckCircle size={20} className="shrink-0 mt-0.5" />
              <p className="text-sm font-medium">{success}</p>
            </motion.div>
          )}
        </AnimatePresence>

        <form onSubmit={handleUpdate} className="flex flex-col items-center">
          <div
            className="relative group cursor-pointer mb-6"
            onClick={handlePickImage}
          >
            <div className="w-32 h-32 rounded-full bg-indigo-50 dark:bg-indigo-900/20 flex items-center justify-center overflow-hidden border-4 border-white dark:border-slate-800 shadow-xl shadow-indigo-200/50 dark:shadow-none relative z-10 mx-auto active:scale-95 transition-transform duration-150">
              {photoURL && !imageLoadError ? (
                <img
                  src={photoURL}
                  alt="Profile"
                  className="w-full h-full object-cover shrink-0 min-h-full min-w-full"
                  referrerPolicy="no-referrer"
                  onError={() => setImageLoadError(true)}
                />
              ) : (
                <User
                  size={48}
                  className="text-indigo-300 dark:text-indigo-700"
                />
              )}
              <div className="absolute inset-0 bg-black/40 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity">
                <Camera className="text-white" size={32} />
              </div>
            </div>
            <input
              id="imageUpload"
              type="file"
              accept="image/*"
              className="hidden"
              onChange={async (e) => {
                const file = e.target.files?.[0];
                e.target.value = ""; // Reset input so user can reselect the same file
                if (file) {
                  if (file.size > 25000000) {
                    setError("Image must be less than 25MB");
                    triggerHaptic("error");
                    return;
                  }
                  setLoading(true);
                  setError("");
                  setSuccess("");
                  try {
                    const compressedUrl = await compressProfileImage(file);
                    setPhotoURL(compressedUrl);
                    setImageLoadError(false);
                    triggerHaptic("light");
                  } catch (err: any) {
                    console.error("Failed to compress profile image:", err);
                    setError("Could not process this image. Please choose another image file.");
                    triggerHaptic("error");
                  } finally {
                    setLoading(false);
                  }
                }
              }}
            />
          </div>

          <div className="w-full space-y-1 text-center mb-8">
            <h2 className="text-xl font-bold text-slate-800 dark:text-slate-100">
              {user?.displayName || "Anonymous"}
            </h2>
            <p className="text-slate-500 text-sm font-medium">
              Tap image to update
            </p>
          </div>

          <div className="w-full space-y-6">
            <div>
              <label className="block text-xs font-bold text-slate-400 uppercase tracking-widest mb-2 pl-1">
                Display Name
              </label>
              <div className="relative">
                <input
                  type="text"
                  value={displayName}
                  onChange={(e) => {
                    setDisplayName(e.target.value);
                    setSuccess("");
                  }}
                  className="glass-input w-full !pl-12 py-4 text-base font-bold text-slate-800 dark:text-slate-100 shadow-sm transition-all focus:shadow-md"
                  placeholder="Enter your name"
                />
                <User
                  className="absolute left-4 top-1/2 -translate-y-1/2 text-indigo-400"
                  size={20}
                />
              </div>
            </div>

            <motion.button
              whileHover={hasChanges ? { scale: 1.02 } : {}}
              whileTap={hasChanges ? { scale: 0.98 } : {}}
              disabled={loading || !hasChanges}
              type="submit"
              className={`w-full font-bold tracking-wide rounded-2xl py-4 transition-all flex items-center justify-center gap-2 mt-4 
                ${
                  hasChanges
                    ? "bg-slate-900 dark:bg-indigo-600 hover:bg-slate-800 dark:hover:bg-indigo-700 text-white shadow-xl shadow-slate-900/20 dark:shadow-indigo-600/30"
                    : "bg-slate-100 dark:bg-slate-800/50 text-slate-400 cursor-not-allowed shadow-none"
                }`}
            >
              {loading ? (
                <span className="w-6 h-6 border-2 border-current border-t-transparent rounded-full animate-spin" />
              ) : (
                <>
                  <Save size={20} />
                  <span>{hasChanges ? "Save Changes" : "Saved"}</span>
                </>
              )}
            </motion.button>
          </div>
        </form>
      </div>
    </motion.div>
  );
}
