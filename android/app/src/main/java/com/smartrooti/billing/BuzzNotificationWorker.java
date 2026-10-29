package com.smartrooti.billing;

import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.media.AudioAttributes;
import android.media.RingtoneManager;
import android.net.Uri;
import android.os.Build;
import androidx.annotation.NonNull;
import androidx.core.app.NotificationCompat;
import androidx.work.Worker;
import androidx.work.WorkerParameters;
import org.json.JSONArray;
import org.json.JSONObject;
import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Set;

public class BuzzNotificationWorker extends Worker {
    public static final String CHANNEL_ID = "buzz_pos_alerts_high_v3";
    private static final String PREFS_NAME = "BuzzNativeAlertPrefs";
    private static final String DEFAULT_PROJECT_ID = "tidy-byte-g5xj8";
    private static final String DEFAULT_DATABASE_ID = "ai-studio-remixbuzzv111-8ceddc6a-4499-4e60-a805-dedb47b5266b";
    private static final String DEFAULT_API_KEY = "AIzaSyBhbO3om_V-n5RJ471DtuPNAvoUkElIjz4";

    public BuzzNotificationWorker(@NonNull Context context, @NonNull WorkerParameters params) {
        super(context, params);
    }

    @NonNull
    @Override
    public Result doWork() {
        runAlertCheckNow(getApplicationContext());
        return Result.success();
    }

    public static void runAlertCheckNow(Context context) {
        if (context == null) return;
        ensureChannel(context);

        SharedPreferences prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
        if (!prefs.getBoolean("notifications_enabled", true)) {
            return;
        }

        String projectId = prefs.getString("project_id", DEFAULT_PROJECT_ID);
        String databaseId = prefs.getString("database_id", DEFAULT_DATABASE_ID);
        String apiKey = prefs.getString("api_key", DEFAULT_API_KEY);
        long now = System.currentTimeMillis();
        long cutoff = now - 86400000L; // 24 hours
        boolean isFirstRun = !prefs.getBoolean("worker_initialized_v1", false);

        String baseUrl = "https://firestore.googleapis.com/v1/projects/" + projectId
                + "/databases/" + databaseId + "/documents/settings/";

        try {
            checkAdminBroadcast(context, prefs, baseUrl + "admin_broadcast_notification?key=" + apiKey, cutoff, isFirstRun);
        } catch (Exception ignored) {
        }

        try {
            checkGlobalSecurity(context, prefs, baseUrl + "global_security_message?key=" + apiKey, cutoff, isFirstRun);
        } catch (Exception ignored) {
        }

        try {
            checkStockAlerts(context, prefs, baseUrl + "stock_alerts_feed?key=" + apiKey, cutoff, isFirstRun);
        } catch (Exception ignored) {
        }

        if (isFirstRun) {
            prefs.edit().putBoolean("worker_initialized_v1", true).apply();
        }
    }

    private static void checkAdminBroadcast(Context context, SharedPreferences prefs, String urlStr, long cutoff, boolean isFirstRun) throws Exception {
        JSONObject doc = fetchJson(urlStr);
        if (doc == null || !doc.has("fields")) return;
        JSONObject fields = doc.getJSONObject("fields");

        long ts = getLongField(fields, "timestamp");
        if (ts <= cutoff) return;

        long lastBroadcastTs = prefs.getLong("last_broadcast_ts", 0L);
        if (ts > lastBroadcastTs) {
            prefs.edit().putLong("last_broadcast_ts", ts).apply();
            if (!isFirstRun) {
                String title = getStringField(fields, "title", "Admin Announcement");
                String message = getStringField(fields, "message", "");
                if (!message.isEmpty()) {
                    sendNotification(
                            context,
                            (int) ((ts % 100000) + 10000),
                            "🔔 " + title,
                            message
                    );
                }
            }
        }
    }

    private static void checkGlobalSecurity(Context context, SharedPreferences prefs, String urlStr, long cutoff, boolean isFirstRun) throws Exception {
        JSONObject doc = fetchJson(urlStr);
        if (doc == null || !doc.has("fields")) return;
        JSONObject fields = doc.getJSONObject("fields");

        long ts = getLongField(fields, "timestamp");
        long lastSecurityTs = prefs.getLong("last_security_ts", 0L);
        if (ts > cutoff && ts > lastSecurityTs) {
            prefs.edit().putLong("last_security_ts", ts).apply();
            if (!isFirstRun) {
                String message = getStringField(fields, "message", "A new security alert was triggered on the Admin Panel.");
                sendNotification(
                        context,
                        (int) ((ts % 100000) + 20000),
                        "🚨 Security Alert",
                        message
                );
            }
        }
    }

    private static void checkStockAlerts(Context context, SharedPreferences prefs, String urlStr, long cutoff, boolean isFirstRun) throws Exception {
        JSONObject doc = fetchJson(urlStr);
        if (doc == null || !doc.has("fields")) return;
        JSONObject fields = doc.getJSONObject("fields");

        List<JSONObject> allValues = new ArrayList<>();
        collectArrayFieldValues(fields, "latestAlerts", allValues);
        collectArrayFieldValues(fields, "items", allValues);
        if (allValues.isEmpty()) return;

        Set<String> notifiedIds = new HashSet<>(prefs.getStringSet("notified_stock_keys", new HashSet<>()));
        boolean modified = false;

        for (JSONObject itemFields : allValues) {
            long ts = getLongField(itemFields, "timestamp");
            if (ts <= cutoff) continue;

            String id = getStringField(itemFields, "id", "");
            String productId = getStringField(itemFields, "productId", "");
            String productName = getStringField(itemFields, "productName", "Product");
            String type = getStringField(itemFields, "type", "low_stock");
            long stock = getLongField(itemFields, "stock");
            String uniqueKey = !id.isEmpty() ? id : ("stock_" + type + "_" + productId + "_" + stock + "_" + ts);

            if (!notifiedIds.contains(uniqueKey)) {
                notifiedIds.add(uniqueKey);
                modified = true;

                if (!isFirstRun) {
                    String title = "out_of_stock".equals(type)
                            ? "🚫 Out of Stock Alert"
                            : "critical_low".equals(type)
                            ? "⚠️ Critical Low Stock"
                            : "📉 Low Stock Alert";
                    String body = "out_of_stock".equals(type)
                            ? "\"" + productName + "\" is now completely out of stock!"
                            : "critical_low".equals(type)
                            ? "\"" + productName + "\" has only " + stock + " items left!"
                            : "\"" + productName + "\" is running low with " + stock + " items.";
                    sendNotification(
                            context,
                            Math.abs(uniqueKey.hashCode()),
                            title,
                            body
                    );
                }
            }
        }

        if (modified) {
            prefs.edit().putStringSet("notified_stock_keys", notifiedIds).apply();
        }
    }

    private static void collectArrayFieldValues(JSONObject fields, String fieldName, List<JSONObject> outList) {
        if (!fields.has(fieldName)) return;
        JSONObject arrField = fields.optJSONObject(fieldName);
        if (arrField == null) return;
        JSONObject arrayValue = arrField.optJSONObject("arrayValue");
        if (arrayValue == null) return;
        JSONArray values = arrayValue.optJSONArray("values");
        if (values == null) return;
        for (int i = 0; i < values.length(); i++) {
            JSONObject itemVal = values.optJSONObject(i);
            if (itemVal == null) continue;
            JSONObject mapVal = itemVal.optJSONObject("mapValue");
            if (mapVal == null) continue;
            JSONObject itemFields = mapVal.optJSONObject("fields");
            if (itemFields != null) {
                outList.add(itemFields);
            }
        }
    }

    private static JSONObject fetchJson(String urlStr) {
        HttpURLConnection conn = null;
        try {
            URL url = new URL(urlStr);
            conn = (HttpURLConnection) url.openConnection();
            conn.setRequestMethod("GET");
            conn.setConnectTimeout(6000);
            conn.setReadTimeout(6000);
            int code = conn.getResponseCode();
            if (code != 200) return null;

            StringBuilder sb = new StringBuilder();
            try (BufferedReader reader = new BufferedReader(new InputStreamReader(conn.getInputStream()))) {
                String line;
                while ((line = reader.readLine()) != null) {
                    sb.append(line);
                }
            }
            return new JSONObject(sb.toString());
        } catch (Exception e) {
            return null;
        } finally {
            if (conn != null) conn.disconnect();
        }
    }

    private static String getStringField(JSONObject fields, String name, String fallback) {
        if (!fields.has(name)) return fallback;
        JSONObject f = fields.optJSONObject(name);
        if (f == null) return fallback;
        return f.optString("stringValue", fallback);
    }

    private static long getLongField(JSONObject fields, String name) {
        if (!fields.has(name)) return 0L;
        JSONObject f = fields.optJSONObject(name);
        if (f == null) return 0L;
        if (f.has("integerValue")) {
            try {
                return Long.parseLong(f.optString("integerValue", "0"));
            } catch (Exception ignored) {
            }
        }
        if (f.has("doubleValue")) {
            return (long) f.optDouble("doubleValue", 0.0);
        }
        return 0L;
    }

    public static void ensureChannel(Context context) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationManager nm = (NotificationManager) context.getSystemService(Context.NOTIFICATION_SERVICE);
            if (nm == null) return;
            NotificationChannel existing = nm.getNotificationChannel(CHANNEL_ID);
            if (existing != null) return;

            NotificationChannel channel = new NotificationChannel(
                    CHANNEL_ID,
                    "Buzz POS Critical Alerts",
                    NotificationManager.IMPORTANCE_HIGH
            );
            channel.setDescription("Real-time stock, admin broadcast, and security alerts");
            channel.enableVibration(true);
            Uri soundUri = RingtoneManager.getDefaultUri(RingtoneManager.TYPE_NOTIFICATION);
            AudioAttributes attrs = new AudioAttributes.Builder()
                    .setUsage(AudioAttributes.USAGE_NOTIFICATION)
                    .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                    .build();
            channel.setSound(soundUri, attrs);
            nm.createNotificationChannel(channel);
        }
    }

    private static void sendNotification(Context context, int id, String title, String body) {
        NotificationManager nm = (NotificationManager) context.getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm == null) return;

        Intent launchIntent = new Intent(context, MainActivity.class);
        launchIntent.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        int flags = Build.VERSION.SDK_INT >= Build.VERSION_CODES.M
                ? PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
                : PendingIntent.FLAG_UPDATE_CURRENT;
        PendingIntent pi = PendingIntent.getActivity(context, id, launchIntent, flags);

        NotificationCompat.Builder builder = new NotificationCompat.Builder(context, CHANNEL_ID)
                .setSmallIcon(android.R.drawable.ic_dialog_info)
                .setContentTitle(title)
                .setContentText(body)
                .setStyle(new NotificationCompat.BigTextStyle().bigText(body))
                .setPriority(NotificationCompat.PRIORITY_HIGH)
                .setAutoCancel(true)
                .setContentIntent(pi);

        nm.notify(id, builder.build());
    }
}
