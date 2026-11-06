package com.smartrooti.billing;

import android.os.Bundle;
import android.os.Build;
import android.os.Environment;
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
                                if (name.endsWith(".apk") && (name.startsWith("buzz") || name.contains("update"))) {
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
            return cleanupDownloadedApksStatic(MainActivity.this);
        }

        @JavascriptInterface
        public boolean downloadAndInstallApk(String url, String version) {
            if (url == null || url.trim().isEmpty()) return false;
            if (isDownloadingUpdate) return true;
            isDownloadingUpdate = true;
            final String targetUrl = url.trim();
            final String safeVer = (version != null && !version.trim().isEmpty())
                ? version.trim().replaceAll("[^0-9a-zA-Z._-]", "")
                : "latest";

            Executors.newSingleThreadExecutor().execute(() -> {
                HttpURLConnection conn = null;
                try {
                    emitApkProgressToWebView(1, 0, 0, "downloading", "");
                    String currentUrl = targetUrl;
                    for (int redirects = 0; redirects < 10; redirects++) {
                        URL u = new URL(currentUrl);
                        conn = (HttpURLConnection) u.openConnection();
                        conn.setInstanceFollowRedirects(false);
                        conn.setConnectTimeout(15000);
                        conn.setReadTimeout(30000);
                        conn.setRequestProperty("User-Agent", "Buzz-Android-Updater");
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
                            currentUrl = loc;
                            continue;
                        }
                        break;
                    }

                    if (conn == null || conn.getResponseCode() >= 400) {
                        throw new Exception("Download failed with HTTP " + (conn != null ? conn.getResponseCode() : 0));
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
                            if (f != null && f.isFile() && f.getName().endsWith(".apk")) {
                                f.delete();
                            }
                        }
                    }

                    File outFile = new File(updatesDir, "buzz_update_" + safeVer + ".apk");
                    long downloadedBytes = 0;
                    int lastProgress = 1;
                    long lastEmitTime = 0;

                    try (InputStream in = conn.getInputStream();
                         FileOutputStream out = new FileOutputStream(outFile)) {
                        byte[] buffer = new byte[16384];
                        int read;
                        while ((read = in.read(buffer)) != -1) {
                            out.write(buffer, 0, read);
                            downloadedBytes += read;
                            int pct;
                            if (totalBytes > 0) {
                                pct = (int) Math.min(99, Math.max(1, (downloadedBytes * 100L) / totalBytes));
                            } else {
                                // Estimate based on ~10MB typical APK size if Content-Length is omitted
                                pct = (int) Math.min(95, Math.max(1, (downloadedBytes * 100L) / (10L * 1024L * 1024L)));
                            }
                            long now = System.currentTimeMillis();
                            if (pct != lastProgress && (now - lastEmitTime >= 80 || pct >= 99)) {
                                lastProgress = pct;
                                lastEmitTime = now;
                                emitApkProgressToWebView(pct, downloadedBytes, totalBytes > 0 ? totalBytes : downloadedBytes, "downloading", "");
                            }
                        }
                        out.flush();
                    }

                    emitApkProgressToWebView(100, downloadedBytes, downloadedBytes, "installing", "");
                    launchApkInstaller(outFile);
                } catch (Exception e) {
                    e.printStackTrace();
                    emitApkProgressToWebView(0, 0, 0, "error", e.getMessage() != null ? e.getMessage() : "Download failed");
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
                    nativeTts.speak(text.trim(), TextToSpeech.QUEUE_FLUSH, null, "buzz_tts_" + System.currentTimeMillis());
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

        // Ensure high-priority notification channel exists on Android 8+
        BuzzNotificationWorker.ensureChannel(this);

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

            if (!exporterAttached) {
                try {
                    webView.addJavascriptInterface(new AndroidExporter(), "AndroidExporter");
                    exporterAttached = true;
                } catch (Exception ignored) {
                }
            }

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
