package com.smartrooti.billing;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import androidx.work.Constraints;
import androidx.work.ExistingPeriodicWorkPolicy;
import androidx.work.ExistingWorkPolicy;
import androidx.work.NetworkType;
import androidx.work.OneTimeWorkRequest;
import androidx.work.OutOfQuotaPolicy;
import androidx.work.PeriodicWorkRequest;
import androidx.work.WorkManager;
import java.util.concurrent.TimeUnit;

public class BootReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context context, Intent intent) {
        if (intent == null || intent.getAction() == null) return;
        String action = intent.getAction();
        if (Intent.ACTION_BOOT_COMPLETED.equals(action)
                || Intent.ACTION_MY_PACKAGE_REPLACED.equals(action)
                || "android.intent.action.QUICKBOOT_POWERON".equals(action)) {
            try {
                MainActivity.cleanupDownloadedApksStatic(context);
            } catch (Exception ignored) {
            }
            BuzzNotificationWorker.ensureChannel(context);
            BuzzNotificationWorker.ensureBaselineInitialized(context);
            BuzzRealtimeSyncService.ensureLiveSyncChannel(context);

            Constraints constraints = new Constraints.Builder()
                    .setRequiredNetworkType(NetworkType.CONNECTED)
                    .build();

            try {
                OneTimeWorkRequest bootImmediate = new OneTimeWorkRequest.Builder(BuzzNotificationWorker.class)
                        .setConstraints(constraints)
                        .setExpedited(OutOfQuotaPolicy.RUN_AS_NON_EXPEDITED_WORK_REQUEST)
                        .build();
                WorkManager.getInstance(context).enqueueUniqueWork(
                        "BuzzNotificationBootWake",
                        ExistingWorkPolicy.REPLACE,
                        bootImmediate
                );
            } catch (Exception ignored) {
            }

            PeriodicWorkRequest periodicWork = new PeriodicWorkRequest.Builder(
                    BuzzNotificationWorker.class,
                    15,
                    TimeUnit.MINUTES
            )
                    .setConstraints(constraints)
                    .build();

            WorkManager.getInstance(context).enqueueUniquePeriodicWork(
                    "BuzzNotificationPeriodicWork",
                    ExistingPeriodicWorkPolicy.KEEP,
                    periodicWork
            );
        }
    }
}
