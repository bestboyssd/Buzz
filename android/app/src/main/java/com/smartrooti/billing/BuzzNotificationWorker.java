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
import java.util.Iterator;
import java.util.List;
import java.util.Locale;
import java.util.Set;

public class BuzzNotificationWorker extends Worker {
    public static final String CHANNEL_ID = "buzz_pos_alerts_high_v3";
    private static final String PREFS_NAME = "BuzzNativeAlertPrefs";
    private static final String DEFAULT_PROJECT_ID = "tidy-byte-g5xj8";
    private static final String DEFAULT_DATABASE_ID = "ai-studio-remixbuzzv111-8ceddc6a-4499-4e60-a805-dedb47b5266b";
    private static final String DEFAULT_API_KEY = "AIzaSyBhbO3om_V-n5RJ471DtuPNAvoUkElIjz4";
    private static final long CANONICAL_STOCK_TTL_MS = 180000L; // 3 minutes

    public BuzzNotificationWorker(@NonNull Context context, @NonNull WorkerParameters params) {
        super(context, params);
    }

    public static int deterministicId(String key) {
        if (key == null || key.isEmpty()) return 10001;
        int hash = 0;
        for (int i = 0; i < key.length(); i++) {
            hash = (hash * 31) + key.charAt(i);
        }
        int pos = (hash == Integer.MIN_VALUE) ? 0 : Math.abs(hash);
        return (pos % 800000000) + 10000;
    }

    public static synchronized void syncContext(
            Context context,
            String userUid,
            String userEmail,
            boolean isAdmin,
            boolean isRealAdmin,
            String deviceId
    ) {
        if (context == null) return;
        SharedPreferences prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
        String cleanUid = userUid != null ? userUid.trim() : "";
        String cleanEmail = userEmail != null ? userEmail.trim().toLowerCase(Locale.US) : "";
        String cleanDeviceId = deviceId != null ? deviceId.trim() : "";
        prefs.edit()
                .putBoolean("auth_context_known", true)
                .putString("current_uid", cleanUid)
                .putString("current_email", cleanEmail)
                .putBoolean("is_admin", isAdmin)
                .putBoolean("is_real_admin", isRealAdmin)
                .putString("device_id", cleanDeviceId)
                .apply();
    }

    public static synchronized void markAlertHandled(Context context, String kind, String key, long timestamp) {
        if (context == null) return;
        SharedPreferences prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
        SharedPreferences.Editor editor = prefs.edit();
        String safeKind = kind != null ? kind.trim().toLowerCase(Locale.US) : "";
        String safeKey = key != null ? key.trim() : "";
        long ts = timestamp > 0L ? timestamp : System.currentTimeMillis();

        if ("broadcast".equals(safeKind)) {
            long prevTs = prefs.getLong("last_broadcast_ts", 0L);
            if (ts > prevTs) {
                editor.putLong("last_broadcast_ts", ts);
            }
            if (!safeKey.isEmpty()) {
                Set<String> set = new HashSet<>(prefs.getStringSet("notified_broadcast_keys", new HashSet<>()));
                set.add(safeKey);
                editor.putStringSet("notified_broadcast_keys", trimStringSet(set, 200));
            }
        } else if ("security".equals(safeKind)) {
            long prevTs = prefs.getLong("last_security_ts", 0L);
            if (ts > prevTs) {
                editor.putLong("last_security_ts", ts);
            }
            if (!safeKey.isEmpty()) {
                Set<String> set = new HashSet<>(prefs.getStringSet("notified_security_keys", new HashSet<>()));
                set.add(safeKey);
                editor.putStringSet("notified_security_keys", trimStringSet(set, 200));
            }
        } else if ("conflict".equals(safeKind)) {
            if (!safeKey.isEmpty()) {
                Set<String> set = new HashSet<>(prefs.getStringSet("notified_conflict_keys", new HashSet<>()));
                set.add(safeKey);
                editor.putStringSet("notified_conflict_keys", trimStringSet(set, 200));
            }
        } else if ("stock".equals(safeKind)) {
            if (!safeKey.isEmpty()) {
                if (safeKey.startsWith("stock_canonical_")) {
                    recordCanonicalStockHandled(prefs, editor, safeKey, ts);
                } else {
                    Set<String> set = new HashSet<>(prefs.getStringSet("notified_stock_keys", new HashSet<>()));
                    set.add(safeKey);
                    editor.putStringSet("notified_stock_keys", trimStringSet(set, 250));
                }
            }
        }
        editor.apply();
    }

    public static synchronized boolean wasAlertHandled(Context context, String kind, String key, long timestamp) {
        if (context == null) return false;
        SharedPreferences prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
        String safeKind = kind != null ? kind.trim().toLowerCase(Locale.US) : "";
        String safeKey = key != null ? key.trim() : "";

        if ("broadcast".equals(safeKind)) {
            if (!safeKey.isEmpty() && prefs.getStringSet("notified_broadcast_keys", new HashSet<>()).contains(safeKey)) {
                return true;
            }
            return timestamp > 0L && timestamp <= prefs.getLong("last_broadcast_ts", 0L);
        } else if ("security".equals(safeKind)) {
            return !safeKey.isEmpty() && prefs.getStringSet("notified_security_keys", new HashSet<>()).contains(safeKey);
        } else if ("conflict".equals(safeKind)) {
            return !safeKey.isEmpty() && prefs.getStringSet("notified_conflict_keys", new HashSet<>()).contains(safeKey);
        } else if ("stock".equals(safeKind)) {
            if (safeKey.isEmpty()) return false;
            if (safeKey.startsWith("stock_canonical_")) {
                return wasCanonicalStockRecentlyHandled(prefs, safeKey, System.currentTimeMillis());
            }
            return prefs.getStringSet("notified_stock_keys", new HashSet<>()).contains(safeKey);
        }
        return false;
    }

    private static Set<String> trimStringSet(Set<String> set, int maxSize) {
        if (set.size() <= maxSize) return set;
        Set<String> trimmed = new HashSet<>();
        int keepStart = set.size() - maxSize;
        int idx = 0;
        for (String s : set) {
            if (idx >= keepStart) {
                trimmed.add(s);
            }
            idx++;
        }
        return trimmed;
    }

    private static JSONObject loadCanonicalStockMap(SharedPreferences prefs) {
        try {
            String raw = prefs.getString("recent_stock_states_json", "{}");
            return new JSONObject(raw != null ? raw : "{}");
        } catch (Exception e) {
            return new JSONObject();
        }
    }

    private static boolean wasCanonicalStockRecentlyHandled(SharedPreferences prefs, String canonicalKey, long now) {
        if (canonicalKey == null || canonicalKey.isEmpty()) return false;
        JSONObject map = loadCanonicalStockMap(prefs);
        long prevTs = map.optLong(canonicalKey, 0L);
        return prevTs > 0L && (now - prevTs) < CANONICAL_STOCK_TTL_MS;
    }

    private static void recordCanonicalStockHandled(
            SharedPreferences prefs,
            SharedPreferences.Editor editor,
            String canonicalKey,
            long now
    ) {
        try {
            JSONObject map = loadCanonicalStockMap(prefs);
            long cutoff = System.currentTimeMillis() - CANONICAL_STOCK_TTL_MS;
            JSONObject pruned = new JSONObject();
            Iterator<String> it = map.keys();
            while (it.hasNext()) {
                String k = it.next();
                long v = map.optLong(k, 0L);
                if (v > cutoff) {
                    pruned.put(k, v);
                }
            }
            pruned.put(canonicalKey, now);
            editor.putString("recent_stock_states_json", pruned.toString());
        } catch (Exception ignored) {
        }
    }

    public static void ensureBaselineInitialized(Context context) {
        if (context == null) return;
        SharedPreferences prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
        if (!prefs.getBoolean("worker_initialized_v1", false)) {
            long now = System.currentTimeMillis();
            prefs.edit()
                    .putLong("last_broadcast_ts", Math.max(prefs.getLong("last_broadcast_ts", 0L), now))
                    .putLong("last_security_ts", Math.max(prefs.getLong("last_security_ts", 0L), now))
                    .putBoolean("worker_initialized_v1", true)
                    .apply();
        }
    }

    public static boolean areNotificationsEnabled(Context context) {
        if (context == null) return true;
        SharedPreferences prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
        return prefs.getBoolean("notifications_enabled", true);
    }

    public static void setNotificationsEnabled(Context context, boolean enabled) {
        if (context == null) return;
        SharedPreferences prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
        prefs.edit().putBoolean("notifications_enabled", enabled).apply();
    }

    @NonNull
    @Override
    public Result doWork() {
        runAlertCheckNow(getApplicationContext());
        return Result.success();
    }

    public static synchronized void runAlertCheckNow(Context context) {
        if (context == null) return;
        ensureChannel(context);

        SharedPreferences prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
        if (!prefs.getBoolean("notifications_enabled", true)) {
            return;
        }
        // When JS auth state has synced and user is explicitly signed out, suppress alerts
        boolean authContextKnown = prefs.getBoolean("auth_context_known", false);
        String currentUid = prefs.getString("current_uid", "");
        if (authContextKnown && currentUid.isEmpty()) {
            return;
        }

        String projectId = prefs.getString("project_id", DEFAULT_PROJECT_ID);
        String databaseId = prefs.getString("database_id", DEFAULT_DATABASE_ID);
        String apiKey = prefs.getString("api_key", DEFAULT_API_KEY);
        long now = System.currentTimeMillis();
        long cutoff = now - 86400000L; // 24 hours
        boolean isFirstRun = !prefs.getBoolean("worker_initialized_v1", false);

        String docsRoot = "https://firestore.googleapis.com/v1/projects/" + projectId
                + "/databases/" + databaseId + "/documents/";
        String baseUrl = docsRoot + "settings/";

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

        try {
            checkSyncConflicts(context, prefs, docsRoot + "sync_conflicts?pageSize=25&key=" + apiKey, cutoff, isFirstRun);
        } catch (Exception ignored) {
        }

        if (isFirstRun) {
            prefs.edit().putBoolean("worker_initialized_v1", true).apply();
        }
    }

    private static void checkSyncConflicts(Context context, SharedPreferences prefs, String urlStr, long cutoff, boolean isFirstRun) throws Exception {
        JSONObject listJson = fetchJson(urlStr);
        if (listJson == null || !listJson.has("documents")) return;
        JSONArray documents = listJson.optJSONArray("documents");
        if (documents == null || documents.length() == 0) return;

        Set<String> notifiedConflicts = new HashSet<>(prefs.getStringSet("notified_conflict_keys", new HashSet<>()));
        boolean authContextKnown = prefs.getBoolean("auth_context_known", false);
        String currentUid = prefs.getString("current_uid", "");
        boolean userCanSeeAll = !authContextKnown
                || prefs.getBoolean("is_real_admin", false)
                || prefs.getBoolean("is_admin", false);
        boolean modified = false;

        for (int i = 0; i < documents.length(); i++) {
            JSONObject docObj = documents.optJSONObject(i);
            if (docObj == null || !docObj.has("fields")) continue;
            JSONObject fields = docObj.getJSONObject("fields");
            String status = getStringField(fields, "status", "");
            if (!"unresolved".equals(status)) continue;

            String recUserId = getStringField(fields, "userId", "");
            if (!userCanSeeAll && !currentUid.isEmpty() && !recUserId.equals(currentUid)) {
                continue;
            }

            long failedAt = getLongField(fields, "failedAt");
            if (failedAt <= 0L) failedAt = getLongField(fields, "conflictDetectedAt");
            if (failedAt <= cutoff) continue;

            String docPath = docObj.optString("name", "");
            String conflictId = getStringField(fields, "id", "");
            if (conflictId.isEmpty() && !docPath.isEmpty()) {
                int slashIdx = docPath.lastIndexOf('/');
                conflictId = slashIdx >= 0 ? docPath.substring(slashIdx + 1) : docPath;
            }
            if (conflictId.isEmpty()) continue;

            if (!notifiedConflicts.contains(conflictId)) {
                notifiedConflicts.add(conflictId);
                modified = true;

                if (!isFirstRun) {
                    String billId = getStringField(fields, "billId", conflictId);
                    String shortBill = billId.length() > 5 ? billId.substring(billId.length() - 5) : billId;
                    String userName = getStringField(fields, "userName", "Staff");
                    long total = getLongField(fields, "total");
                    sendNotification(
                            context,
                            deterministicId("offline_conflict_" + conflictId),
                            "⚠️ Offline Bill Conflict",
                            "Bill #" + shortBill + " (₹" + total + ") by " + userName + " failed stock validation. Tap to review."
                    );
                }
            }
        }

        if (modified) {
            prefs.edit().putStringSet("notified_conflict_keys", trimStringSet(notifiedConflicts, 200)).apply();
        }
    }

    private static void checkAdminBroadcast(Context context, SharedPreferences prefs, String urlStr, long cutoff, boolean isFirstRun) throws Exception {
        JSONObject doc = fetchJson(urlStr);
        if (doc == null || !doc.has("fields")) return;
        JSONObject fields = doc.getJSONObject("fields");

        long ts = getLongField(fields, "timestamp");
        if (ts <= cutoff) return;

        boolean authContextKnown = prefs.getBoolean("auth_context_known", false);
        String currentUid = prefs.getString("current_uid", "");
        boolean userIsAdmin = prefs.getBoolean("is_real_admin", false) || prefs.getBoolean("is_admin", false);

        String senderUid = getStringField(fields, "senderUid", "");
        if (!currentUid.isEmpty() && senderUid.equals(currentUid)) {
            return;
        }
        if (!currentUid.isEmpty() && hasStringInArrayField(fields, "acknowledgedBy", currentUid)) {
            return;
        }
        String targetAudience = getStringField(fields, "targetAudience", "all");
        if (authContextKnown) {
            if ("admins".equals(targetAudience) && !userIsAdmin) return;
            if ("users".equals(targetAudience) && userIsAdmin) return;
        }

        String broadcastKey = "admin_broadcast_" + ts;
        Set<String> notifiedBroadcastKeys = new HashSet<>(prefs.getStringSet("notified_broadcast_keys", new HashSet<>()));
        long lastBroadcastTs = prefs.getLong("last_broadcast_ts", 0L);

        if (ts > lastBroadcastTs && !notifiedBroadcastKeys.contains(broadcastKey)) {
            notifiedBroadcastKeys.add(broadcastKey);
            prefs.edit()
                    .putLong("last_broadcast_ts", ts)
                    .putStringSet("notified_broadcast_keys", trimStringSet(notifiedBroadcastKeys, 200))
                    .apply();
            if (!isFirstRun) {
                String title = getStringField(fields, "title", "Admin Announcement");
                String message = getStringField(fields, "message", "");
                if (!message.isEmpty()) {
                    sendNotification(
                            context,
                            deterministicId(broadcastKey),
                            "🔔 " + title,
                            message
                    );
                }
            }
        }
    }

    private static void checkGlobalSecurity(Context context, SharedPreferences prefs, String urlStr, long cutoff, boolean isFirstRun) throws Exception {
        boolean authContextKnown = prefs.getBoolean("auth_context_known", false);
        boolean isRealAdmin = prefs.getBoolean("is_real_admin", false);
        if (authContextKnown && !isRealAdmin) {
            return;
        }

        JSONObject doc = fetchJson(urlStr);
        if (doc == null || !doc.has("fields")) return;
        JSONObject fields = doc.getJSONObject("fields");

        String currentUid = prefs.getString("current_uid", "");
        String currentEmail = prefs.getString("current_email", "");
        String currentDeviceId = prefs.getString("device_id", "");
        String docDeviceId = getStringField(fields, "deviceId", "");
        boolean globalAcked = !currentUid.isEmpty() && hasStringInArrayField(fields, "acknowledgedBy", currentUid);

        List<JSONObject> events = new ArrayList<>();
        collectArrayFieldValues(fields, "events", events);
        if (events.isEmpty() && fields.has("timestamp")) {
            events.add(fields);
        }
        if (events.isEmpty()) return;

        Set<String> notifiedSecurityKeys = new HashSet<>(prefs.getStringSet("notified_security_keys", new HashSet<>()));
        long lastSecurityTs = prefs.getLong("last_security_ts", 0L);
        long maxSeenTs = lastSecurityTs;
        boolean modified = false;

        for (JSONObject ev : events) {
            long ts = getLongField(ev, "timestamp");
            if (ts <= cutoff) continue;

            String evId = getStringField(ev, "alertId", "");
            if (evId.isEmpty()) evId = getStringField(ev, "id", "");
            if (evId.isEmpty()) evId = "ev_" + ts;

            String evUid = getStringField(ev, "userUid", "");
            String evUserId = getStringField(ev, "userId", "");
            String evEmail = getStringField(ev, "userEmail", "").trim().toLowerCase(Locale.US);
            String evDeviceId = getStringField(ev, "deviceId", docDeviceId);
            boolean evAcked = globalAcked || (!currentUid.isEmpty() && hasStringInArrayField(ev, "acknowledgedBy", currentUid));

            boolean sameUser = !currentUid.isEmpty() && (
                    currentUid.equals(evUid)
                    || currentUid.equals(evUserId)
                    || (!currentEmail.isEmpty() && currentEmail.equals(evEmail))
            );
            boolean sameDevice = !currentDeviceId.isEmpty() && currentDeviceId.equals(evDeviceId);

            if (sameUser || sameDevice || evAcked) {
                if (!notifiedSecurityKeys.contains(evId)) {
                    notifiedSecurityKeys.add(evId);
                    modified = true;
                }
                if (ts > maxSeenTs) maxSeenTs = ts;
                continue;
            }

            if (!notifiedSecurityKeys.contains(evId) && ts > lastSecurityTs) {
                notifiedSecurityKeys.add(evId);
                modified = true;
                if (ts > maxSeenTs) maxSeenTs = ts;
                if (!isFirstRun) {
                    String message = getStringField(ev, "message", "A new security alert was triggered on the Admin Panel.");
                    sendNotification(
                            context,
                            deterministicId("security_alert_" + evId),
                            "🚨 Security Alert",
                            message
                    );
                }
            }
        }

        if (modified || maxSeenTs > lastSecurityTs) {
            prefs.edit()
                    .putLong("last_security_ts", maxSeenTs)
                    .putStringSet("notified_security_keys", trimStringSet(notifiedSecurityKeys, 200))
                    .apply();
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

        String currentDeviceId = prefs.getString("device_id", "");
        Set<String> notifiedIds = new HashSet<>(prefs.getStringSet("notified_stock_keys", new HashSet<>()));
        SharedPreferences.Editor editor = prefs.edit();
        boolean modified = false;
        long now = System.currentTimeMillis();

        for (JSONObject itemFields : allValues) {
            long ts = getLongField(itemFields, "timestamp");
            if (ts <= cutoff) continue;

            String id = getStringField(itemFields, "id", "");
            String productId = getStringField(itemFields, "productId", "");
            String productName = getStringField(itemFields, "productName", "Product");
            String type = getStringField(itemFields, "type", "low_stock");
            String sourceDeviceId = getStringField(itemFields, "sourceDeviceId", "");
            long stock = getLongField(itemFields, "stock");
            String uniqueKey = !id.isEmpty() ? id : ("stock_" + type + "_" + productId + "_" + stock + "_" + ts);
            String canonicalKey = "stock_canonical_" + type + "_" + productId + "_" + stock;

            if (!currentDeviceId.isEmpty() && currentDeviceId.equals(sourceDeviceId)) {
                if (!notifiedIds.contains(uniqueKey)) {
                    notifiedIds.add(uniqueKey);
                    modified = true;
                }
                continue;
            }

            if (!notifiedIds.contains(uniqueKey)) {
                notifiedIds.add(uniqueKey);
                modified = true;

                if (!isFirstRun && !wasCanonicalStockRecentlyHandled(prefs, canonicalKey, now)) {
                    recordCanonicalStockHandled(prefs, editor, canonicalKey, now);
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
                            deterministicId(uniqueKey),
                            title,
                            body
                    );
                }
            }
        }

        if (modified) {
            editor.putStringSet("notified_stock_keys", trimStringSet(notifiedIds, 250));
            editor.apply();
        }
    }

    private static boolean hasStringInArrayField(JSONObject fields, String fieldName, String targetValue) {
        if (targetValue == null || targetValue.isEmpty() || !fields.has(fieldName)) return false;
        JSONObject arrField = fields.optJSONObject(fieldName);
        if (arrField == null) return false;
        JSONObject arrayValue = arrField.optJSONObject("arrayValue");
        if (arrayValue == null) return false;
        JSONArray values = arrayValue.optJSONArray("values");
        if (values == null) return false;
        for (int i = 0; i < values.length(); i++) {
            JSONObject itemVal = values.optJSONObject(i);
            if (itemVal != null && targetValue.equals(itemVal.optString("stringValue", ""))) {
                return true;
            }
        }
        return false;
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
            channel.setDescription("Real-time stock, conflict, admin broadcast, and security alerts");
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

    public static void showNativeNotification(Context context, int id, String title, String body) {
        sendNotification(context, id, title, body);
    }

    public static void sendNotification(Context context, int id, String title, String body) {
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
