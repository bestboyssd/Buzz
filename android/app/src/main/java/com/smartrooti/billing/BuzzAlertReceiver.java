package com.smartrooti.billing;

import android.app.AlarmManager;
import android.app.PendingIntent;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.os.Build;
import android.os.PowerManager;
import android.os.SystemClock;
import androidx.work.Constraints;
import androidx.work.ExistingWorkPolicy;
import androidx.work.NetworkType;
import androidx.work.OneTimeWorkRequest;
import androidx.work.WorkManager;

public class BuzzAlertReceiver extends BroadcastReceiver {
    private static final int ALARM_REQ_CODE = 9901;
    public static final long ACTIVE_POLL_INTERVAL_MS = 30000L; // 30s when screen is on
    public static final long IDLE_POLL_INTERVAL_MS = 60000L;   // 60s when screen is off
    public static final long DEFAULT_POLL_INTERVAL_MS = ACTIVE_POLL_INTERVAL_MS;

    @Override
    public void onReceive(Context context, Intent intent) {
        if (context == null) return;
        final Context appCtx = context.getApplicationContext();

        if (!BuzzNotificationWorker.areNotificationsEnabled(appCtx)) {
            cancelAlarm(appCtx);
            return;
        }

        // Reschedule the next silent wake check FIRST so the alarm chain never breaks
        long nextInterval = isDeviceInteractive(appCtx) ? ACTIVE_POLL_INTERVAL_MS : IDLE_POLL_INTERVAL_MS;
        scheduleNext(appCtx, nextInterval);

        // If offline right now, register a network-constrained WorkManager job so Android wakes us
        // the exact moment Wi-Fi or mobile data reconnects (even if the app is completely closed)
        if (!BuzzNotificationWorker.isNetworkConnected(appCtx)) {
            enqueueReconnectCatchupWork(appCtx);
            return;
        }

        // Hold receiver alive with goAsync() + partial WakeLock until HTTP pull completes;
        // without goAsync(), Android 11+ Cached Apps Freezer kills the thread mid-request!
        final PendingResult pendingResult = goAsync();
        PowerManager.WakeLock wakeLock = null;
        try {
            PowerManager pm = (PowerManager) appCtx.getSystemService(Context.POWER_SERVICE);
            if (pm != null) {
                wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "BuzzPOS:AlertReceiverWakeLock");
                wakeLock.setReferenceCounted(false);
                wakeLock.acquire(15000L);
            }
        } catch (Exception ignored) {
        }

        final PowerManager.WakeLock finalWakeLock = wakeLock;
        new Thread(() -> {
            try {
                BuzzNotificationWorker.runAlertCheckNow(appCtx);
            } catch (Exception ignored) {
            } finally {
                if (finalWakeLock != null) {
                    try {
                        if (finalWakeLock.isHeld()) {
                            finalWakeLock.release();
                        }
                    } catch (Exception ignored) {
                    }
                }
                if (pendingResult != null) {
                    try {
                        pendingResult.finish();
                    } catch (Exception ignored) {
                    }
                }
            }
        }, "BuzzAlertReceiverWorker").start();
    }

    public static void enqueueReconnectCatchupWork(Context context) {
        if (context == null) return;
        try {
            Constraints constraints = new Constraints.Builder()
                    .setRequiredNetworkType(NetworkType.CONNECTED)
                    .build();
            OneTimeWorkRequest reconnectWork = new OneTimeWorkRequest.Builder(BuzzNotificationWorker.class)
                    .setConstraints(constraints)
                    .build();
            WorkManager.getInstance(context).enqueueUniqueWork(
                    "BuzzReconnectCatchup",
                    ExistingWorkPolicy.KEEP,
                    reconnectWork
            );
        } catch (Exception ignored) {
        }
    }

    public static void scheduleNext(Context context, long delayMs) {
        if (context == null) return;
        Context appCtx = context.getApplicationContext();
        if (!BuzzNotificationWorker.areNotificationsEnabled(appCtx)) return;

        try {
            AlarmManager am = (AlarmManager) appCtx.getSystemService(Context.ALARM_SERVICE);
            if (am == null) return;

            Intent intent = new Intent(appCtx, BuzzAlertReceiver.class);
            int flags = PendingIntent.FLAG_UPDATE_CURRENT;
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                flags |= PendingIntent.FLAG_IMMUTABLE;
            }
            PendingIntent pi = PendingIntent.getBroadcast(appCtx, ALARM_REQ_CODE, intent, flags);

            long triggerAt = SystemClock.elapsedRealtime() + Math.max(15000L, delayMs);
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                if (am.canScheduleExactAlarms()) {
                    try {
                        am.setExactAndAllowWhileIdle(AlarmManager.ELAPSED_REALTIME_WAKEUP, triggerAt, pi);
                        return;
                    } catch (SecurityException ignored) {
                    }
                }
                am.setAndAllowWhileIdle(AlarmManager.ELAPSED_REALTIME_WAKEUP, triggerAt, pi);
            } else if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                try {
                    am.setExactAndAllowWhileIdle(AlarmManager.ELAPSED_REALTIME_WAKEUP, triggerAt, pi);
                } catch (SecurityException e) {
                    am.setAndAllowWhileIdle(AlarmManager.ELAPSED_REALTIME_WAKEUP, triggerAt, pi);
                }
            } else {
                am.set(AlarmManager.ELAPSED_REALTIME_WAKEUP, triggerAt, pi);
            }
        } catch (Exception ignored) {
        }
    }

    public static void cancelAlarm(Context context) {
        if (context == null) return;
        try {
            Context appCtx = context.getApplicationContext();
            AlarmManager am = (AlarmManager) appCtx.getSystemService(Context.ALARM_SERVICE);
            if (am == null) return;
            Intent intent = new Intent(appCtx, BuzzAlertReceiver.class);
            int flags = PendingIntent.FLAG_NO_CREATE;
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                flags |= PendingIntent.FLAG_IMMUTABLE;
            }
            PendingIntent pi = PendingIntent.getBroadcast(appCtx, ALARM_REQ_CODE, intent, flags);
            if (pi != null) {
                am.cancel(pi);
            }
        } catch (Exception ignored) {
        }
    }

    private static boolean isDeviceInteractive(Context ctx) {
        try {
            PowerManager pm = (PowerManager) ctx.getSystemService(Context.POWER_SERVICE);
            return pm != null && pm.isInteractive();
        } catch (Exception e) {
            return true;
        }
    }
}
