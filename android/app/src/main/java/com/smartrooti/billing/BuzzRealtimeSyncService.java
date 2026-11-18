package com.smartrooti.billing;

import android.app.AlarmManager;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.net.ConnectivityManager;
import android.net.Network;
import android.net.NetworkCapabilities;
import android.os.Build;
import android.os.Handler;
import android.os.HandlerThread;
import android.os.IBinder;
import android.os.PowerManager;
import android.os.SystemClock;
import androidx.annotation.Nullable;
import androidx.work.Constraints;
import androidx.work.ExistingWorkPolicy;
import androidx.work.NetworkType;
import androidx.work.OneTimeWorkRequest;
import androidx.work.OutOfQuotaPolicy;
import androidx.work.WorkManager;

public class BuzzRealtimeSyncService extends Service {
    public static final String LIVE_SYNC_CHANNEL_ID = "buzz_live_sync_bg_v1";
    private static final int SYNC_NOTIF_ID = 8801;
    private static final int WAKE_ALARM_REQ_CODE = 8803;
    private static final long ACTIVE_POLL_INTERVAL_MS = 4000L;
    private static final long IDLE_POLL_INTERVAL_MS = 8000L;

    private HandlerThread workerThread;
    private Handler workerHandler;
    private volatile boolean isRunning = false;
    private ConnectivityManager.NetworkCallback networkCallback;

    private final Runnable pollTask = new Runnable() {
        @Override
        public void run() {
            if (!isRunning) return;
            Context ctx = getApplicationContext();
            if (!BuzzNotificationWorker.areNotificationsEnabled(ctx)) {
                cancelWakeAlarm(ctx);
                stopSelf();
                return;
            }

            try {
                if (!MainActivity.isAppInForeground && isNetworkConnected(ctx)) {
                    BuzzNotificationWorker.runAlertCheckNow(ctx);
                }
            } catch (Exception ignored) {
            }

            long nextDelay = isDeviceInteractive(ctx) ? ACTIVE_POLL_INTERVAL_MS : IDLE_POLL_INTERVAL_MS;
            if (!MainActivity.isAppInForeground) {
                scheduleDozeSafeWakeAlarm(ctx, nextDelay);
            }
            if (isRunning && workerHandler != null) {
                workerHandler.postDelayed(this, nextDelay);
            }
        }
    };

    public static void scheduleDozeSafeWakeAlarm(Context context, long delayMs) {
        if (context == null) return;
        // Route through BuzzAlertReceiver (PendingIntent.getBroadcast) instead of PendingIntent.getService,
        // because Android 8+ (API 26+) silently blocks background service starts from AlarmManager.
        BuzzAlertReceiver.scheduleNext(context.getApplicationContext(), Math.max(15000L, delayMs));
    }

    public static void cancelWakeAlarm(Context context) {
        if (context == null) return;
        try {
            Intent wakeIntent = new Intent(context, BuzzRealtimeSyncService.class);
            int flags = PendingIntent.FLAG_NO_CREATE;
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                flags |= PendingIntent.FLAG_IMMUTABLE;
            }
            PendingIntent pi = PendingIntent.getService(context, WAKE_ALARM_REQ_CODE, wakeIntent, flags);
            AlarmManager am = (AlarmManager) context.getSystemService(Context.ALARM_SERVICE);
            if (am != null && pi != null) {
                am.cancel(pi);
            }
        } catch (Exception ignored) {
        }
    }

    public static void startIfPermitted(Context context) {
        if (context == null) return;
        ensureLiveSyncChannel(context);
        if (!BuzzNotificationWorker.areNotificationsEnabled(context)) {
            cancelWakeAlarm(context);
            stopService(context);
            return;
        }
        try {
            Intent intent = new Intent(context, BuzzRealtimeSyncService.class);
            context.startService(intent);
        } catch (Exception ignored) {
            scheduleDozeSafeWakeAlarm(context, 4000L);
        }
    }

    public static void stopService(Context context) {
        if (context == null) return;
        ensureLiveSyncChannel(context);
        cancelWakeAlarm(context);
        try {
            context.stopService(new Intent(context, BuzzRealtimeSyncService.class));
        } catch (Exception ignored) {
        }
    }

    @Override
    public void onCreate() {
        super.onCreate();
        ensureLiveSyncChannel(this);
        workerThread = new HandlerThread("BuzzRealtimeSyncThread");
        workerThread.start();
        workerHandler = new Handler(workerThread.getLooper());

        // Instant offline-to-online reconnect catch-up via ConnectivityManager.NetworkCallback
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
            try {
                ConnectivityManager cm = (ConnectivityManager) getSystemService(Context.CONNECTIVITY_SERVICE);
                if (cm != null) {
                    networkCallback = new ConnectivityManager.NetworkCallback() {
                        @Override
                        public void onAvailable(Network network) {
                            if (workerHandler != null) {
                                workerHandler.post(() -> {
                                    try {
                                        Context ctx = getApplicationContext();
                                        if (BuzzNotificationWorker.areNotificationsEnabled(ctx)) {
                                            BuzzNotificationWorker.runAlertCheckNow(ctx);
                                        }
                                    } catch (Exception ignored) {
                                    }
                                });
                            }
                        }
                    };
                    cm.registerDefaultNetworkCallback(networkCallback);
                }
            } catch (Exception ignored) {
            }
        }
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        ensureLiveSyncChannel(this);
        Context ctx = getApplicationContext();
        if (!BuzzNotificationWorker.areNotificationsEnabled(ctx)) {
            cancelWakeAlarm(ctx);
            stopSelf();
            return START_NOT_STICKY;
        }

        isRunning = true;
        if (workerHandler != null) {
            workerHandler.removeCallbacks(pollTask);
            workerHandler.post(pollTask);
        }

        return START_STICKY;
    }

    @Override
    public void onTaskRemoved(Intent rootIntent) {
        super.onTaskRemoved(rootIntent);
        Context ctx = getApplicationContext();
        if (!BuzzNotificationWorker.areNotificationsEnabled(ctx)) return;

        // Schedule immediate WorkManager check + brief restart alarm if swiped from Recents
        try {
            Constraints constraints = new Constraints.Builder()
                    .setRequiredNetworkType(NetworkType.CONNECTED)
                    .build();
            OneTimeWorkRequest immediateWork = new OneTimeWorkRequest.Builder(BuzzNotificationWorker.class)
                    .setConstraints(constraints)
                    .setExpedited(OutOfQuotaPolicy.RUN_AS_NON_EXPEDITED_WORK_REQUEST)
                    .build();
            WorkManager.getInstance(ctx).enqueueUniqueWork(
                    "BuzzNotificationImmediateWake",
                    ExistingWorkPolicy.REPLACE,
                    immediateWork
            );
        } catch (Exception ignored) {
        }

        // Schedule silent BroadcastReceiver wake alarm (PendingIntent.getBroadcast works on Android 8-15
        // even after the app is swiped from Recents, with ZERO persistent notification)
        BuzzAlertReceiver.scheduleNext(ctx, 15000L);
        BuzzAlertReceiver.enqueueReconnectCatchupWork(ctx);
    }

    @Override
    public void onDestroy() {
        isRunning = false;
        if (networkCallback != null && Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
            try {
                ConnectivityManager cm = (ConnectivityManager) getSystemService(Context.CONNECTIVITY_SERVICE);
                if (cm != null) {
                    cm.unregisterNetworkCallback(networkCallback);
                }
            } catch (Exception ignored) {
            }
            networkCallback = null;
        }
        if (workerHandler != null) {
            workerHandler.removeCallbacksAndMessages(null);
            workerHandler = null;
        }
        if (workerThread != null) {
            try {
                workerThread.quitSafely();
            } catch (Exception ignored) {
            }
            workerThread = null;
        }
        super.onDestroy();
    }

    @Nullable
    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    public static void ensureLiveSyncChannel(Context context) {
        if (context == null) return;
        try {
            NotificationManager manager = (NotificationManager) context.getSystemService(Context.NOTIFICATION_SERVICE);
            if (manager == null) return;
            manager.cancel(SYNC_NOTIF_ID);
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                manager.deleteNotificationChannel(LIVE_SYNC_CHANNEL_ID);
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

    private static boolean isNetworkConnected(Context ctx) {
        try {
            ConnectivityManager cm = (ConnectivityManager) ctx.getSystemService(Context.CONNECTIVITY_SERVICE);
            if (cm == null) return true;
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                Network nw = cm.getActiveNetwork();
                if (nw == null) return false;
                NetworkCapabilities caps = cm.getNetworkCapabilities(nw);
                return caps != null && caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET);
            }
            return cm.getActiveNetworkInfo() != null && cm.getActiveNetworkInfo().isConnected();
        } catch (Exception e) {
            return true;
        }
    }
}
