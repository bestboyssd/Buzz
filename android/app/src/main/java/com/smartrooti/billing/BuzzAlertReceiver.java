package com.smartrooti.billing;

import android.app.AlarmManager;
import android.app.PendingIntent;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.os.Build;
import android.os.SystemClock;

public class BuzzAlertReceiver extends BroadcastReceiver {
    private static final int ALARM_REQ_CODE = 9901;
    public static final long DEFAULT_POLL_INTERVAL_MS = 180000L; // 3 minutes

    @Override
    public void onReceive(Context context, Intent intent) {
        if (context == null) return;
        if (!BuzzNotificationWorker.areNotificationsEnabled(context)) {
            cancelAlarm(context);
            return;
        }

        // Perform alert check in background thread
        new Thread(() -> {
            try {
                BuzzNotificationWorker.runAlertCheckNow(context.getApplicationContext());
            } catch (Exception ignored) {
            }
        }).start();

        // Reschedule next repeating wake check
        scheduleNext(context, DEFAULT_POLL_INTERVAL_MS);
    }

    public static void scheduleNext(Context context, long delayMs) {
        if (context == null) return;
        if (!BuzzNotificationWorker.areNotificationsEnabled(context)) return;

        try {
            AlarmManager am = (AlarmManager) context.getSystemService(Context.ALARM_SERVICE);
            if (am == null) return;

            Intent intent = new Intent(context, BuzzAlertReceiver.class);
            int flags = PendingIntent.FLAG_UPDATE_CURRENT;
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                flags |= PendingIntent.FLAG_IMMUTABLE;
            }
            PendingIntent pi = PendingIntent.getBroadcast(context, ALARM_REQ_CODE, intent, flags);

            long triggerAt = SystemClock.elapsedRealtime() + Math.max(15000L, delayMs);
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                am.setAndAllowWhileIdle(AlarmManager.ELAPSED_REALTIME_WAKEUP, triggerAt, pi);
            } else {
                am.set(AlarmManager.ELAPSED_REALTIME_WAKEUP, triggerAt, pi);
            }
        } catch (Exception ignored) {
        }
    }

    public static void cancelAlarm(Context context) {
        if (context == null) return;
        try {
            AlarmManager am = (AlarmManager) context.getSystemService(Context.ALARM_SERVICE);
            if (am == null) return;
            Intent intent = new Intent(context, BuzzAlertReceiver.class);
            int flags = PendingIntent.FLAG_NO_CREATE;
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                flags |= PendingIntent.FLAG_IMMUTABLE;
            }
            PendingIntent pi = PendingIntent.getBroadcast(context, ALARM_REQ_CODE, intent, flags);
            if (pi != null) {
                am.cancel(pi);
            }
        } catch (Exception ignored) {
        }
    }
}
