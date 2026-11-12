package com.smartrooti.billing;

import android.app.AlarmManager;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
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
import androidx.core.app.NotificationCompat;
import androidx.core.content.ContextCompat;
import androidx.work.Constraints;
import androidx.work.ExistingWorkPolicy;
import androidx.work.NetworkType;
import androidx.work.OneTimeWorkRequest;
import androidx.work.OutOfQuotaPolicy;
import androidx.work.WorkManager;

public class BuzzRealtimeSyncService extends Service {
    public static final String LIVE_SYNC_CHANNEL_ID = "buzz_live_sync_bg_v1";
    private static final int SYNC_NOTIF_ID = 8801;
    private static final long ACTIVE_POLL_INTERVAL_MS = 6000L;
    private static final long IDLE_POLL_INTERVAL_MS = 15000L;

    private HandlerThread workerThread;
    private Handler workerHandler;
    private volatile boolean isRunning = false;

    private final Runnable pollTask = new Runnable() {
        @Override
        public void run() {
            if (!isRunning) return;
            Context ctx = getApplicationContext();
            if (!BuzzNotificationWorker.areNotificationsEnabled(ctx)) {
                stopSelf();
                return;
            }

            try {
                if (isNetworkConnected(ctx)) {
                    BuzzNotificationWorker.runAlertCheckNow(ctx);
                }
            } catch (Exception ignored) {
            }

            if (isRunning && workerHandler != null) {
                long nextDelay = isDeviceInteractive(ctx) ? ACTIVE_POLL_INTERVAL_MS : IDLE_POLL_INTERVAL_MS;
                workerHandler.postDelayed(this, nextDelay);
            }
        }
    };

    public static void startIfPermitted(Context context) {
        if (context == null) return;
        if (!BuzzNotificationWorker.areNotificationsEnabled(context)) {
            stopService(context);
            return;
        }
        try {
            Intent intent = new Intent(context, BuzzRealtimeSyncService.class);
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                ContextCompat.startForegroundService(context, intent);
            } else {
                context.startService(intent);
            }
        } catch (Exception ignored) {
        }
    }

    public static void stopService(Context context) {
        if (context == null) return;
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
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (!BuzzNotificationWorker.areNotificationsEnabled(getApplicationContext())) {
            stopSelf();
            return START_NOT_STICKY;
        }

        Notification notif = buildForegroundNotification();
        try {
            if (Build.VERSION.SDK_INT >= 34) {
                startForeground(SYNC_NOTIF_ID, notif, ServiceInfo.FOREGROUND_SERVICE_TYPE_REMOTE_MESSAGING);
            } else {
                startForeground(SYNC_NOTIF_ID, notif);
            }
        } catch (Exception e) {
            stopSelf();
            return START_NOT_STICKY;
        }

        if (!isRunning) {
            isRunning = true;
            if (workerHandler != null) {
                workerHandler.removeCallbacks(pollTask);
                workerHandler.post(pollTask);
            }
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

        try {
            Intent restartIntent = new Intent(ctx, BuzzRealtimeSyncService.class);
            int pendingFlags = PendingIntent.FLAG_ONE_SHOT;
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                pendingFlags |= PendingIntent.FLAG_IMMUTABLE;
            }
            PendingIntent pi;
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                pi = PendingIntent.getForegroundService(ctx, 8802, restartIntent, pendingFlags);
            } else {
                pi = PendingIntent.getService(ctx, 8802, restartIntent, pendingFlags);
            }
            AlarmManager am = (AlarmManager) ctx.getSystemService(Context.ALARM_SERVICE);
            if (am != null && pi != null) {
                am.set(AlarmManager.ELAPSED_REALTIME_WAKEUP, SystemClock.elapsedRealtime() + 2500L, pi);
            }
        } catch (Exception ignored) {
        }
    }

    @Override
    public void onDestroy() {
        isRunning = false;
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

    private Notification buildForegroundNotification() {
        Intent openAppIntent = new Intent(this, MainActivity.class);
        openAppIntent.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        int flags = PendingIntent.FLAG_UPDATE_CURRENT;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            flags |= PendingIntent.FLAG_IMMUTABLE;
        }
        PendingIntent pendingIntent = PendingIntent.getActivity(this, 8803, openAppIntent, flags);

        return new NotificationCompat.Builder(this, LIVE_SYNC_CHANNEL_ID)
                .setSmallIcon(R.mipmap.ic_launcher)
                .setContentTitle("Buzz Instant Alerts Active")
                .setContentText("Monitoring stock, conflicts, and security in real time")
                .setPriority(NotificationCompat.PRIORITY_MIN)
                .setCategory(NotificationCompat.CATEGORY_SERVICE)
                .setOngoing(true)
                .setSilent(true)
                .setShowWhen(false)
                .setContentIntent(pendingIntent)
                .build();
    }

    public static void ensureLiveSyncChannel(Context context) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationManager manager = (NotificationManager) context.getSystemService(Context.NOTIFICATION_SERVICE);
            if (manager == null) return;
            NotificationChannel existing = manager.getNotificationChannel(LIVE_SYNC_CHANNEL_ID);
            if (existing != null) return;
            NotificationChannel channel = new NotificationChannel(
                    LIVE_SYNC_CHANNEL_ID,
                    "Buzz Live Sync Status",
                    NotificationManager.IMPORTANCE_MIN
            );
            channel.setDescription("Keeps instant out-of-stock and bill conflict alerts active in the background");
            channel.setShowBadge(false);
            channel.setSound(null, null);
            channel.enableVibration(false);
            manager.createNotificationChannel(channel);
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
