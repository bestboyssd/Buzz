package com.smartrooti.billing;

import android.os.Bundle;
import android.os.Build;
import android.os.Environment;
import android.os.PowerManager;
import android.provider.Settings;
import android.view.View;
import android.view.WindowManager;
import android.graphics.Color;
import android.webkit.JavascriptInterface;
import android.webkit.PermissionRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.widget.Toast;
import android.Manifest;
import android.content.Context;
import android.content.ContentResolver;
import android.content.ContentValues;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.print.PrintAttributes;
import android.print.PrintDocumentAdapter;
import android.print.PrintManager;
import android.provider.MediaStore;
import android.webkit.WebViewClient;
import com.getcapacitor.BridgeActivity;
import com.getcapacitor.BridgeWebChromeClient;
import androidx.work.Constraints;
import androidx.work.ExistingPeriodicWorkPolicy;
import androidx.work.ExistingWorkPolicy;
import androidx.work.NetworkType;
import androidx.work.OneTimeWorkRequest;
import androidx.work.PeriodicWorkRequest;
import androidx.work.WorkManager;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.Locale;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;
import android.speech.tts.TextToSpeech;
import androidx.core.content.FileProvider;

public class MainActivity extends BridgeActivity {
    private static final int AUDIO_PERMISSION_REQUEST_CODE = 1002;
    private static final int NOTIFICATION_PERMISSION_REQUEST_CODE = 1003;
    private boolean exporterAttached = false;
    private ScheduledExecutorService bgPollExecutor = null;
    private TextToSpeech nativeTts = null;
    private boolean ttsReady = false;
    private WebView printWebView = null;
    private volatile boolean isDownloadingUpdate = false;
    private volatile boolean cancelCurrentDownload = false;
    private File pendingInstallApkFile = null;

    private static boolean isValidApkFile(File f) {
        if (f == null || !f.exists() || !f.isFile() || f.length() < 100 * 1024) {
            return false;
        }
        try ( java.io.FileInputStream fis = new java.io.FileInputStream(f) ) {
            byte[] magic = new byte[4];
            if (fis.read(magic) != 4) return false;
            // Standard ZIP / APK header: PK\x03\x04 (0x50, 0x4B, 0x03, 0x04)
            return magic[0] == 0x50 && magic[1] == 0x4B && magic[2] == 0x03 && magic[3] == 0x04;
        } catch (Exception e) {
            return false;
        }
    }

    public static int cleanupDownloadedApksStatic(Context context) {
        if (context == null) return 0;
        int deletedCount = 0;
        try {
            File[] dirs = new File[]{
                context.getCacheDir(),
                context.getExternalCacheDir(),
                context.getFilesDir(),
                context.getExternalFilesDir(null),
                new File(context.getCacheDir(), "updates"),
                context.getExternalCacheDir() != null ? new File(context.getExternalCacheDir(), "updates") : null
            };
            for (File dir : dirs) {
                if (dir != null && dir.exists() && dir.isDirectory()) {
                    File[] files = dir.listFiles();
                    if (files != null) {
                        for (File f : files) {
                            if (f != null && f.isFile()) {
                                String name = f.getName().toLowerCase(Locale.US);
                                if ((name.endsWith(".apk") || name.endsWith(".apk.part"))
                                        && (name.startsWith("buzz") || name.contains("update"))) {
                                    if (f.delete()) {
                                        deletedCount++;
                                    }
                                }
                            }
                        }
                    }
                }
            }
        } catch (Exception ignored) {
        }
        return deletedCount;
    }

    private void emitApkProgressToWebView(int progress, long downloadedBytes, long totalBytes, String status, String errorMsg) {
        runOnUiThread(() -> {
            try {
                if (getBridge() == null || getBridge().getWebView() == null) return;
                String safeStatus = status != null ? status.replace("'", "\\'") : "downloading";
                String safeErr = errorMsg != null ? errorMsg.replace("'", "\\'").replace("\n", " ") : "";
                String js = "window.dispatchEvent(new CustomEvent('apkDownloadProgress', { detail: {"
                    + "progress: " + progress + ","
                    + "downloadedBytes: " + downloadedBytes + ","
                    + "totalBytes: " + totalBytes + ","
                    + "status: '" + safeStatus + "',"
                    + "error: '" + safeErr + "'"
                    + "} }));";
                getBridge().getWebView().evaluateJavascript(js, null);
            } catch (Exception ignored) {
            }
        });
    }

    private void launchApkInstaller(File apkFile) {
        runOnUiThread(() -> {
            try {
                if (!isValidApkFile(apkFile)) {
                    emitApkProgressToWebView(0, 0, 0, "error", "Downloaded APK file is incomplete or corrupted. Please tap Retry.");
                    return;
                }
                pendingInstallApkFile = apkFile;

                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                    if (!getPackageManager().canRequestPackageInstalls()) {
                        Toast.makeText(
                            MainActivity.this,
                            "Please allow 'Install unknown apps' to finish updating Buzz POS",
                            Toast.LENGTH_LONG
                        ).show();
                        emitApkProgressToWebView(100, apkFile.length(), apkFile.length(), "completed", "");
                        try {
                            android.content.Intent permIntent = new android.content.Intent(
                                android.provider.Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                                Uri.parse("package:" + getPackageName())
                            );
                            permIntent.addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK);
                            startActivity(permIntent);
                            return;
                        } catch (Exception ignored) {
                            // Fall through to standard install intent if settings screen fails
                        }
                    }
                }

                Uri apkUri = FileProvider.getUriForFile(
                    MainActivity.this,
                    getPackageName() + ".fileprovider",
                    apkFile
                );
                android.content.Intent installIntent = new android.content.Intent(android.content.Intent.ACTION_VIEW);
                installIntent.setDataAndType(apkUri, "application/vnd.android.package-archive");
                installIntent.addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK);
                installIntent.addFlags(android.content.Intent.FLAG_GRANT_READ_URI_PERMISSION);
                startActivity(installIntent);
                emitApkProgressToWebView(100, apkFile.length(), apkFile.length(), "completed", "");
            } catch (Exception e) {
                e.printStackTrace();
                emitApkProgressToWebView(0, 0, 0, "error", "Could not launch installer: " + e.getMessage());
            }
        });
    }

    public class AndroidExporter {
        @JavascriptInterface
        public boolean postNotification(int id, String title, String body) {
            try {
                BuzzNotificationWorker.showNativeNotification(
                    MainActivity.this,
                    id,
                    title != null ? title : "Buzz POS Alert",
                    body != null ? body : ""
                );
                return true;
            } catch (Exception e) {
                return false;
            }
        }

        @JavascriptInterface
        public boolean isNativePrintAvailable() {
            return true;
        }

        @JavascriptInterface
        public boolean isInAppUpdateSupported() {
            return true;
        }

        @JavascriptInterface
        public int cleanupDownloadedApks() {
            pendingInstallApkFile = null;
            return cleanupDownloadedApksStatic(MainActivity.this);
        }

        @JavascriptInterface
        public boolean cancelApkDownload() {
            cancelCurrentDownload = true;
            return true;
        }

        @JavascriptInterface
        public boolean installDownloadedApk(String version) {
            try {
                String safeVer = (version != null && !version.trim().isEmpty())
                    ? version.trim().replaceAll("[^0-9a-zA-Z._-]", "")
                    : "latest";
                File baseDir = getExternalCacheDir() != null ? getExternalCacheDir() : getCacheDir();
                File updatesDir = new File(baseDir, "updates");
                File targetFile = new File(updatesDir, "buzz_update_" + safeVer + ".apk");
                if (isValidApkFile(targetFile)) {
                    launchApkInstaller(targetFile);
                    return true;
                }
                if (isValidApkFile(pendingInstallApkFile)) {
                    launchApkInstaller(pendingInstallApkFile);
                    return true;
                }
            } catch (Exception ignored) {
            }
            return false;
        }

        @JavascriptInterface
        public boolean downloadAndInstallApk(String url, String version) {
            if (url == null || url.trim().isEmpty()) return false;
            final String safeVer = (version != null && !version.trim().isEmpty())
                ? version.trim().replaceAll("[^0-9a-zA-Z._-]", "")
                : "latest";

            // If this exact version is already downloaded and verified on disk, launch installer immediately
            try {
                File baseDir = getExternalCacheDir() != null ? getExternalCacheDir() : getCacheDir();
                File updatesDir = new File(baseDir, "updates");
                File existingApk = new File(updatesDir, "buzz_update_" + safeVer + ".apk");
                if (!isDownloadingUpdate && isValidApkFile(existingApk)) {
                    emitApkProgressToWebView(100, existingApk.length(), existingApk.length(), "installing", "");
                    launchApkInstaller(existingApk);
                    return true;
                }
            } catch (Exception ignored) {
            }

            if (isDownloadingUpdate) return true;
            isDownloadingUpdate = true;
            cancelCurrentDownload = false;
            final String targetUrl = url.trim();

            Executors.newSingleThreadExecutor().execute(() -> {
                HttpURLConnection conn = null;
                File partFile = null;
                try {
                    emitApkProgressToWebView(1, 0, 0, "downloading", "");
                    String currentUrl = targetUrl;
                    if (currentUrl.endsWith("/releases/latest") || currentUrl.contains("/releases/tag/")) {
                        currentUrl = !safeVer.equals("latest")
                            ? "https://github.com/bestboyssd/Buzz/releases/download/v" + safeVer.replaceFirst("^v", "") + "/Buzz-v" + safeVer.replaceFirst("^v", "") + ".apk"
                            : "https://github.com/bestboyssd/Buzz/releases/latest/download/Buzz.apk";
                    }

                    for (int redirects = 0; redirects < 10; redirects++) {
                        URL u = new URL(currentUrl);
                        conn = (HttpURLConnection) u.openConnection();
                        conn.setInstanceFollowRedirects(false);
                        conn.setConnectTimeout(15000);
                        conn.setReadTimeout(30000);
                        conn.setRequestProperty("User-Agent", "Buzz-Android-Updater/1.1");
                        conn.setRequestProperty("Accept", "application/octet-stream, application/vnd.android.package-archive, */*");
                        int code = conn.getResponseCode();
                        if (code == HttpURLConnection.HTTP_MOVED_PERM
                                || code == HttpURLConnection.HTTP_MOVED_TEMP
                                || code == HttpURLConnection.HTTP_SEE_OTHER
                                || code == 307
                                || code == 308) {
                            String loc = conn.getHeaderField("Location");
                            conn.disconnect();
                            if (loc == null || loc.isEmpty()) break;
                            currentUrl = new URL(u, loc).toString();
                            continue;
                        }
                        break;
                    }

                    if (conn == null || conn.getResponseCode() >= 400) {
                        throw new Exception("Download failed with HTTP " + (conn != null ? conn.getResponseCode() : 0));
                    }

                    String contentType = conn.getContentType();
                    if (contentType != null && contentType.toLowerCase(Locale.US).contains("text/html")) {
                        throw new Exception("Server returned HTML page instead of APK binary");
                    }

                    long totalBytes = conn.getContentLengthLong();
                    File baseDir = getExternalCacheDir() != null ? getExternalCacheDir() : getCacheDir();
                    File updatesDir = new File(baseDir, "updates");
                    if (!updatesDir.exists()) {
                        updatesDir.mkdirs();
                    }

                    // Delete any older partial/previous APKs first
                    File[] oldFiles = updatesDir.listFiles();
                    if (oldFiles != null) {
                        for (File f : oldFiles) {
                            if (f != null && f.isFile() && (f.getName().endsWith(".apk") || f.getName().endsWith(".part"))) {
                                f.delete();
                            }
                        }
                    }

                    partFile = new File(updatesDir, "buzz_update_" + safeVer + ".apk.part");
                    File outFile = new File(updatesDir, "buzz_update_" + safeVer + ".apk");
                    long downloadedBytes = 0;
                    int lastProgress = 1;
                    long lastEmitTime = 0;

                    try (InputStream in = conn.getInputStream();
                         FileOutputStream out = new FileOutputStream(partFile)) {
                        byte[] buffer = new byte[32768];
                        int read;
                        while ((read = in.read(buffer)) != -1) {
                            if (cancelCurrentDownload) {
                                throw new Exception("Download cancelled");
                            }
                            out.write(buffer, 0, read);
                            downloadedBytes += read;
                            int pct;
                            if (totalBytes > 0) {
                                pct = (int) Math.min(99, Math.max(1, (downloadedBytes * 100L) / totalBytes));
                            } else {
                                // Estimate based on ~36.5MB APK size if Content-Length is omitted
                                pct = (int) Math.min(95, Math.max(1, (downloadedBytes * 100L) / (36L * 1024L * 1024L)));
                            }
                            long now = System.currentTimeMillis();
                            if (pct != lastProgress && (now - lastEmitTime >= 75 || pct >= 99)) {
                                lastProgress = pct;
                                lastEmitTime = now;
                                emitApkProgressToWebView(pct, downloadedBytes, totalBytes > 0 ? totalBytes : downloadedBytes, "downloading", "");
                            }
                        }
                        out.flush();
                    }

                    if (totalBytes > 0 && downloadedBytes < totalBytes) {
                        throw new Exception("Connection closed early (" + (downloadedBytes / (1024 * 1024)) + "MB / " + (totalBytes / (1024 * 1024)) + "MB). Tap Retry.");
                    }

                    if (!isValidApkFile(partFile)) {
                        throw new Exception("Downloaded file is not a valid Android APK package.");
                    }

                    if (outFile.exists()) {
                        outFile.delete();
                    }
                    if (!partFile.renameTo(outFile)) {
                        outFile = partFile;
                    }

                    emitApkProgressToWebView(100, downloadedBytes, downloadedBytes, "installing", "");
                    launchApkInstaller(outFile);
                } catch (Exception e) {
                    e.printStackTrace();
                    if (partFile != null && partFile.exists()) {
                        try {
                            partFile.delete();
                        } catch (Exception ignored) {
                        }
                    }
                    String msg = e.getMessage() != null ? e.getMessage() : "Download failed";
                    if ("Download cancelled".equals(msg)) {
                        emitApkProgressToWebView(0, 0, 0, "idle", "");
                    } else {
                        emitApkProgressToWebView(0, 0, 0, "error", msg);
                    }
                } finally {
                    isDownloadingUpdate = false;
                    if (conn != null) {
                        try {
                            conn.disconnect();
                        } catch (Exception ignored) {
                        }
                    }
                }
            });
            return true;
        }

        @JavascriptInterface
        public boolean printHtml(String jobName, String htmlContent) {
            if (htmlContent == null || htmlContent.trim().isEmpty()) return false;
            final String safeJobName = (jobName == null || jobName.trim().isEmpty())
                ? "SmartPOS_Receipt_" + System.currentTimeMillis()
                : jobName.trim();
            runOnUiThread(() -> {
                try {
                    WebView webView = new WebView(MainActivity.this);
                    printWebView = webView;
                    webView.getSettings().setJavaScriptEnabled(false);
                    webView.setWebViewClient(new WebViewClient() {
                        @Override
                        public void onPageFinished(WebView view, String url) {
                            try {
                                PrintManager printManager = (PrintManager) getSystemService(Context.PRINT_SERVICE);
                                if (printManager != null) {
                                    PrintDocumentAdapter adapter = view.createPrintDocumentAdapter(safeJobName);
                                    PrintAttributes.Builder builder = new PrintAttributes.Builder();
                                    builder.setMediaSize(PrintAttributes.MediaSize.ISO_A4);
                                    printManager.print(safeJobName, adapter, builder.build());
                                }
                            } catch (Exception e) {
                                e.printStackTrace();
                            }
                        }
                    });
                    webView.loadDataWithBaseURL(null, htmlContent, "text/html", "UTF-8", null);
                } catch (Exception e) {
                    e.printStackTrace();
                }
            });
            return true;
        }

        @JavascriptInterface
        public boolean speakText(String text) {
            try {
                if (text == null || text.trim().isEmpty()) return false;
                if (nativeTts != null && ttsReady) {
                    String trimmed = text.trim();
                    boolean hasBengali = false;
                    boolean hasHindi = false;
                    for (int i = 0; i < trimmed.length(); i++) {
                        char c = trimmed.charAt(i);
                        if (c >= '\u0980' && c <= '\u09FF') {
                            hasBengali = true;
                            break;
                        } else if (c >= '\u0900' && c <= '\u097F') {
                            hasHindi = true;
                        }
                    }
                    Locale targetLocale = hasBengali
                        ? new Locale("bn", "IN")
                        : (hasHindi ? new Locale("hi", "IN") : new Locale("en", "IN"));
                    int res = nativeTts.setLanguage(targetLocale);
                    if (res == TextToSpeech.LANG_MISSING_DATA || res == TextToSpeech.LANG_NOT_SUPPORTED) {
                        if (hasBengali) {
                            res = nativeTts.setLanguage(new Locale("bn", "BD"));
                        }
                        if (res == TextToSpeech.LANG_MISSING_DATA || res == TextToSpeech.LANG_NOT_SUPPORTED) {
                            nativeTts.setLanguage(new Locale("en", "IN"));
                        }
                    }
                    nativeTts.speak(trimmed, TextToSpeech.QUEUE_FLUSH, null, "buzz_tts_" + System.currentTimeMillis());
                    return true;
                }
                return false;
            } catch (Exception e) {
                return false;
            }
        }

        @JavascriptInterface
        public void stopSpeaking() {
            try {
                if (nativeTts != null) {
                    nativeTts.stop();
                }
            } catch (Exception ignored) {
            }
        }

        @JavascriptInterface
        public boolean saveJsonToDownloads(String fileName, String jsonContent) {
            try {
                String safeName = (fileName == null || fileName.trim().isEmpty())
                    ? "buzz_backup_" + System.currentTimeMillis() + ".json"
                    : fileName.trim();
                if (!safeName.endsWith(".json")) {
                    safeName = safeName + ".json";
                }
                byte[] bytes = (jsonContent != null ? jsonContent : "{}").getBytes(StandardCharsets.UTF_8);

                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                    ContentValues values = new ContentValues();
                    values.put(MediaStore.Downloads.DISPLAY_NAME, safeName);
                    values.put(MediaStore.Downloads.MIME_TYPE, "application/json");
                    values.put(MediaStore.Downloads.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS);

                    ContentResolver resolver = getContentResolver();
                    Uri uri = resolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values);
                    if (uri == null) return false;
                    try (OutputStream os = resolver.openOutputStream(uri)) {
                        if (os == null) return false;
                        os.write(bytes);
                        os.flush();
                    }
                } else {
                    File downloadsDir = Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS);
                    if (!downloadsDir.exists()) {
                        downloadsDir.mkdirs();
                    }
                    File outFile = new File(downloadsDir, safeName);
                    try (FileOutputStream fos = new FileOutputStream(outFile)) {
                        fos.write(bytes);
                        fos.flush();
                    }
                }

                final String finalName = safeName;
                runOnUiThread(() -> Toast.makeText(
                    MainActivity.this,
                    "Saved to Downloads: " + finalName,
                    Toast.LENGTH_LONG
                ).show());
                return true;
            } catch (Exception e) {
                e.printStackTrace();
                return false;
            }
        }

        @JavascriptInterface
        public boolean openExternalDownload(String url) {
            try {
                if (url == null || url.trim().isEmpty()) return false;
                android.content.Intent intent = new android.content.Intent(
                    android.content.Intent.ACTION_VIEW,
                    Uri.parse(url.trim())
                );
                intent.addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK);
                startActivity(intent);
                return true;
            } catch (Exception e) {
                e.printStackTrace();
                return false;
            }
        }

        @JavascriptInterface
        public boolean setNotificationsEnabled(boolean enabled) {
            try {
                BuzzNotificationWorker.setNotificationsEnabled(getApplicationContext(), enabled);
                if (enabled) {
                    BuzzRealtimeSyncService.startIfPermitted(MainActivity.this);
                } else {
                    BuzzRealtimeSyncService.stopService(MainActivity.this);
                }
                return true;
            } catch (Exception e) {
                return false;
            }
        }

        @JavascriptInterface
        public boolean syncNotificationContext(
            String userUid,
            String userEmail,
            boolean isAdmin,
            boolean isRealAdmin,
            String deviceId
        ) {
            try {
                BuzzNotificationWorker.syncContext(
                    getApplicationContext(),
                    userUid,
                    userEmail,
                    isAdmin,
                    isRealAdmin,
                    deviceId
                );
                return true;
            } catch (Exception e) {
                return false;
            }
        }

        @JavascriptInterface
        public boolean markAlertHandled(String kind, String key, long timestamp) {
            try {
                BuzzNotificationWorker.markAlertHandled(
                    getApplicationContext(),
                    kind,
                    key,
                    timestamp
                );
                return true;
            } catch (Exception e) {
                return false;
            }
        }

        @JavascriptInterface
        public boolean wasAlertHandled(String kind, String key, long timestamp) {
            try {
                return BuzzNotificationWorker.wasAlertHandled(
                    getApplicationContext(),
                    kind,
                    key,
                    timestamp
                );
            } catch (Exception e) {
                return false;
            }
        }

        @JavascriptInterface
        public boolean isIgnoringBatteryOptimizations() {
            try {
                if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M) return true;
                PowerManager pm = (PowerManager) getSystemService(Context.POWER_SERVICE);
                return pm == null || pm.isIgnoringBatteryOptimizations(getPackageName());
            } catch (Exception e) {
                return false;
            }
        }

        @JavascriptInterface
        public boolean requestIgnoreBatteryOptimizations() {
            try {
                if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M) return true;
                PowerManager pm = (PowerManager) getSystemService(Context.POWER_SERVICE);
                if (pm != null && pm.isIgnoringBatteryOptimizations(getPackageName())) {
                    return true;
                }
                android.content.Intent intent = new android.content.Intent(
                    Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS,
                    Uri.parse("package:" + getPackageName())
                );
                intent.addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK);
                startActivity(intent);
                return true;
            } catch (Exception e) {
                try {
                    android.content.Intent fallbackIntent = new android.content.Intent(
                        Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS
                    );
                    fallbackIntent.addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK);
                    startActivity(fallbackIntent);
                    return true;
                } catch (Exception ignored) {
                    return false;
                }
            }
        }
    }

    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        // Automatically delete any previously downloaded update APK files once the app launches
        try {
            cleanupDownloadedApksStatic(getApplicationContext());
        } catch (Exception ignored) {
        }

        // Initialize native Android Text-to-Speech engine for Buzz AI "Listen" button
        try {
            nativeTts = new TextToSpeech(getApplicationContext(), status -> {
                if (status == TextToSpeech.SUCCESS && nativeTts != null) {
                    int res = nativeTts.setLanguage(new Locale("en", "IN"));
                    if (res == TextToSpeech.LANG_MISSING_DATA || res == TextToSpeech.LANG_NOT_SUPPORTED) {
                        nativeTts.setLanguage(Locale.US);
                    }
                    nativeTts.setSpeechRate(0.98f);
                    ttsReady = true;
                }
            });
        } catch (Exception ignored) {
        }

        // Ensure high-priority notification channel & baseline timestamp exist on Android 8+
        BuzzNotificationWorker.ensureChannel(this);
        BuzzNotificationWorker.ensureBaselineInitialized(this);
        BuzzRealtimeSyncService.ensureLiveSyncChannel(this);
        BuzzRealtimeSyncService.startIfPermitted(this);

        // Request POST_NOTIFICATIONS runtime permission on Android 13+ (API 33+)
        if (Build.VERSION.SDK_INT >= 33) {
            if (checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
                requestPermissions(
                    new String[]{Manifest.permission.POST_NOTIFICATIONS},
                    NOTIFICATION_PERMISSION_REQUEST_CODE
                );
            }
        }

        // Enqueue 15-minute periodic background alert check via WorkManager
        try {
            Constraints constraints = new Constraints.Builder()
                .setRequiredNetworkType(NetworkType.CONNECTED)
                .build();

            PeriodicWorkRequest periodicWork = new PeriodicWorkRequest.Builder(
                BuzzNotificationWorker.class,
                15,
                TimeUnit.MINUTES
            )
                .setConstraints(constraints)
                .build();

            WorkManager.getInstance(this).enqueueUniquePeriodicWork(
                "BuzzNotificationPeriodicWork",
                ExistingPeriodicWorkPolicy.KEEP,
                periodicWork
            );
        } catch (Exception ignored) {
        }

        // Support camera cutouts / punch-hole displays edge-to-edge
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            WindowManager.LayoutParams lp = getWindow().getAttributes();
            lp.layoutInDisplayCutoutMode = Build.VERSION.SDK_INT >= Build.VERSION_CODES.R
                ? WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_ALWAYS
                : WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES;
            getWindow().setAttributes(lp);
        }

        // Enable true edge-to-edge fullscreen drawing behind status bar and gesture navigation bar
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            getWindow().setDecorFitsSystemWindows(false);
        } else {
            getWindow().getDecorView().setSystemUiVisibility(
                View.SYSTEM_UI_FLAG_LAYOUT_STABLE |
                View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN |
                View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
            );
        }

        // Transparent system bars for seamless glassmorphism bleed
        getWindow().setStatusBarColor(Color.TRANSPARENT);
        getWindow().setNavigationBarColor(Color.TRANSPARENT);

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            getWindow().setNavigationBarContrastEnforced(false);
            getWindow().setStatusBarContrastEnforced(false);
        }
    }

    @Override
    public void onResume() {
        super.onResume();
        if (bgPollExecutor != null) {
            try {
                bgPollExecutor.shutdownNow();
            } catch (Exception ignored) {
            }
            bgPollExecutor = null;
        }
        BuzzRealtimeSyncService.startIfPermitted(this);

        // If user just granted "Install unknown apps" permission and returned to Buzz POS, automatically launch installer
        try {
            if (pendingInstallApkFile != null && isValidApkFile(pendingInstallApkFile)) {
                if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O || getPackageManager().canRequestPackageInstalls()) {
                    File toInstall = pendingInstallApkFile;
                    pendingInstallApkFile = null;
                    launchApkInstaller(toInstall);
                }
            }
        } catch (Exception ignored) {
        }
    }

    @Override
    public void onPause() {
        super.onPause();
        // Start fast 3-second native background polling while minimized so stock/broadcast/security alerts arrive instantly
        try {
            if (bgPollExecutor != null) {
                bgPollExecutor.shutdownNow();
            }
            bgPollExecutor = Executors.newSingleThreadScheduledExecutor();
            bgPollExecutor.scheduleAtFixedRate(
                () -> BuzzNotificationWorker.runAlertCheckNow(getApplicationContext()),
                1,
                3,
                TimeUnit.SECONDS
            );
        } catch (Exception ignored) {
        }

        try {
            Constraints constraints = new Constraints.Builder()
                .setRequiredNetworkType(NetworkType.CONNECTED)
                .build();

            OneTimeWorkRequest oneShotWork = new OneTimeWorkRequest.Builder(BuzzNotificationWorker.class)
                .setInitialDelay(2, TimeUnit.SECONDS)
                .setConstraints(constraints)
                .build();

            WorkManager.getInstance(this).enqueueUniqueWork(
                "BuzzNotificationOneShotOnPause",
                ExistingWorkPolicy.REPLACE,
                oneShotWork
            );
        } catch (Exception ignored) {
        }
    }

    @Override
    public void onStart() {
        super.onStart();
        if (getBridge() == null) return;

        WebView webView = getBridge().getWebView();
        if (webView != null) {
            webView.setBackgroundColor(Color.TRANSPARENT);
            webView.setVerticalScrollBarEnabled(false);
            webView.setHorizontalScrollBarEnabled(false);
            webView.setOverScrollMode(WebView.OVER_SCROLL_NEVER);
            webView.setHapticFeedbackEnabled(true);
            webView.setFocusable(true);
            webView.setFocusableInTouchMode(true);
            getWindow().setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE);

            if (!exporterAttached) {
                try {
                    webView.addJavascriptInterface(new AndroidExporter(), "AndroidExporter");
                    exporterAttached = true;
                } catch (Exception ignored) {
                }
            }

            webView.setDownloadListener((url, userAgent, contentDisposition, mimeType, contentLength) -> {
                if (url != null && (url.toLowerCase(Locale.US).contains(".apk")
                        || "application/vnd.android.package-archive".equalsIgnoreCase(mimeType))) {
                    new AndroidExporter().downloadAndInstallApk(url, "latest");
                }
            });

            // Keep WebView renderer alive when backgrounded at checkout counter
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                webView.setRendererPriorityPolicy(WebView.RENDERER_PRIORITY_IMPORTANT, false);
            }

            WebSettings settings = webView.getSettings();
            settings.setDomStorageEnabled(true);
            settings.setDatabaseEnabled(true);
            settings.setLoadsImagesAutomatically(true);
            settings.setAllowFileAccess(true);
            settings.setAllowContentAccess(true);
            settings.setCacheMode(WebSettings.LOAD_DEFAULT);
            settings.setOffscreenPreRaster(true);
            settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
            settings.setMediaPlaybackRequiresUserGesture(false);

            // Lock text zoom to 100% so Android OS font scaling does not break compact POS grids
            settings.setTextZoom(100);
            settings.setSupportZoom(false);
            settings.setBuiltInZoomControls(false);
            settings.setDisplayZoomControls(false);

            // Force hardware acceleration for smooth 60/120fps animations
            webView.setLayerType(WebView.LAYER_TYPE_HARDWARE, null);

            // Seamless WebRTC / Microphone permission bridging for Buzz AI voice input
            webView.setWebChromeClient(new BridgeWebChromeClient(getBridge()) {
                @Override
                public void onPermissionRequest(final PermissionRequest request) {
                    runOnUiThread(() -> {
                        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                            boolean needsAudio = false;
                            for (String res : request.getResources()) {
                                if (PermissionRequest.RESOURCE_AUDIO_CAPTURE.equals(res)) {
                                    needsAudio = true;
                                    break;
                                }
                            }
                            if (needsAudio && checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
                                requestPermissions(
                                    new String[]{Manifest.permission.RECORD_AUDIO, Manifest.permission.MODIFY_AUDIO_SETTINGS},
                                    AUDIO_PERMISSION_REQUEST_CODE
                                );
                            }
                        }
                        try {
                            request.grant(request.getResources());
                        } catch (Exception ignored) {
                        }
                    });
                }
            });
        }
    }
}
