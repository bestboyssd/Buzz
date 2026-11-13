# Handover & Architecture Guide — Buzz POS (`v1.2.6`)

> [!WARNING]
> ### 🛑 CRITICAL AGENT RULES — READ FIRST
> 1. **DO NOT MODIFY THE UI UNSOLICITED**: Do not make visual adjustments, layout restructures, or cosmetic styling changes unless explicitly instructed by the user.
> 2. **NO AUTHENTICATION BYPASSES**: Never add anonymous login fallbacks (`signInAnonymously`), fake admin accounts (`Demo Admin (Bypass)`), or unauthenticated database access in `Login.tsx`, `AuthContext.tsx`, or `firestore.rules`.
> 3. **SINGLE UNIFIED DATABASE**: Always connect to the existing shared Cloud Firestore database (`ai-studio-remixbuzzv111-8ceddc6a-4499-4e60-a805-dedb47b5266b` in project `tidy-byte-g5xj8`). Never create or switch to a blank database.
> 4. **GEMINI AI TRANSPORT & ANDROID PERFORMANCE POLICY**: On native Android APK (`Capacitor.isNativePlatform()`), Buzz AI streams directly from Google's official Gemini API endpoint (`generativelanguage.googleapis.com`) using `directGeminiChatStream()` and a dynamically resolved key (`localStorage` -> Firestore `settings/ai_bridge_config` -> build env). This delivers sub-second (<1s) responses for queries like "yo", with live token-by-token streaming, completely eliminating 16-21s Firestore bridge delays. Server endpoints (`/api/gemini/*`) and the Firestore RPC bridge (`settings/ai_rpc_req_*`) remain active as seamless web/fallback conduits. Keys are never committed to git source code.
> 5. **CONTEXT WINDOW MONITORING**: Always notify the user when your context window is getting close to full or if a context compaction occurs so they can migrate smoothly.

---

## 📱 1. Application Overview & Tech Stack
* **App Name**: Buzz (`Buzz - v1.2.6`)
* **Android Package / Namespace**: `com.smartrooti.billing`
* **Version**: `1.2.6` (`versionCode 126`, `versionName "1.2.6"`) synchronized across:
  * `metadata.json` (`"name": "Buzz - v1.2.6"`)
  * `package.json` (`"version": "1.2.6"`)
  * `index.html` (`<title>Buzz - v1.2.6</title>`)
  * `android/app/build.gradle` (`versionCode 126`, `versionName "1.2.6"`)
  * `src/pages/Settings.tsx` (`getAppVersion()` resolves via `versionCheck.ts` / `package.json` / `metadata.json`)
* **Core Tech Stack**:
  * **Frontend**: React 19 + TypeScript + Vite 6 + Tailwind CSS v4 + `motion/react` + `lucide-react` + `recharts`.
  * **Backend (Optional Local/Preview Host)**: Node.js + Express (`server.ts`, run via `tsx server.ts` on port `3000`). Serves API routes (`/api/*`) and mounts Vite middleware in development or static `dist/` in production.
  * **Database & Auth**: Google Firebase (`firebase` JS SDK v12) with Firestore multi-tab IndexedDB persistence (`persistentLocalCache` + `persistentMultipleTabManager` + `experimentalForceLongPolling` on native Android) supplemented by local Dexie/SQLite caching (`src/lib/sqliteAdapter.ts`).
  * **Mobile Wrapper & Background Engine**: Capacitor 8 (`@capacitor/core`, `@capacitor/android`, `@capacitor-firebase/authentication`, `@capacitor/local-notifications`, `@capacitor/haptics`, `@capacitor/status-bar`, `@capacitor-community/sqlite`, `@capacitor-community/keep-awake`) plus native Java classes `MainActivity.java`, `BuzzRealtimeSyncService.java` (`START_STICKY` foreground service), and `BuzzNotificationWorker.java` (WorkManager + REST polling).

---

## 🗄️ 2. Unified Firebase & Firestore Architecture

### 2.1 Connection & Provisioning Details
* **Firebase Project ID**: `tidy-byte-g5xj8`
* **Firestore Database ID**: `ai-studio-remixbuzzv111-8ceddc6a-4499-4e60-a805-dedb47b5266b`
* **Web App ID**: `1:1080691680431:web:166a80b2b57812c1ca205a`
* **Auth Domain**: `tidy-byte-g5xj8.firebaseapp.com`
* **Web OAuth Client ID**: `1080691680431-aop4epc4mvhp4den0thrlv17pt3op6rt.apps.googleusercontent.com`
* **Config File**: `/firebase-applet-config.json` (imported by `/src/lib/firebase.ts` and read by `/server.ts`).
* **When Remixing into a New AI Studio Applet**:
  * Run the `set_up_firebase` tool (`platform: "web"`, `FirebaseProjectID: "tidy-byte-g5xj8"`, `databaseId: "ai-studio-remixbuzzv111-8ceddc6a-4499-4e60-a805-dedb47b5266b"`) so the new preview domain (`*.run.app`) is automatically registered in Firebase Authorized Domains and Google Sign-In works without `auth/unauthorized-domain`.
  * Deploy security rules with `deploy_firebase` if `firestore.rules` is modified.

### 2.2 Native Android Google Sign-In vs Shared Firestore (`src/lib/firebase.ts`)
* On **Web / PWA**, both Firebase Auth and Firestore use the primary `firebaseConfig` (`tidy-byte-g5xj8`).
* On **Native Android APK** (`Capacitor.isNativePlatform()`), `/android/app/google-services.json` is registered under project `buzz-8521` (Project Number `327146649300`, Web Client Type 3: `327146649300-b186rkv6aj4la2fco79adj10smbrr8b2.apps.googleusercontent.com`, Android Client SHA-1: `c8:4b:64:08:fe:88:40:a5:4f:6c:c3:20:b4:81:9f:0f:ea:06:d6:d4`).
* Therefore, `src/lib/firebase.ts` initializes a secondary Firebase App (`BuzzNativeAuthApp`) with `nativeAuthConfig` (`buzz-8521`) **solely** for `auth` when running natively on Android, while `db` (Firestore) **always** connects to `tidy-byte-g5xj8` (`ai-studio-remixbuzzv111-8ceddc6a-4499-4e60-a805-dedb47b5266b`).

### 2.3 Firestore Collections & Schemas
1. **`products/{productId}`**:
   * `id`: `string`
   * `name`: `string`
   * `price`: `number` (Selling price in ₹)
   * `costPrice`: `number` (Optional unit cost; if omitted/0, `getEffectiveProductCost()` in `src/lib/firestoreHooks.ts` estimates cost as `Math.round(price * 0.7)`)
   * `stock`: `number` (Capped at `MAX_PRODUCT_STOCK = 2000`)
   * `category`: `'fresh' | 'frozen' | 'cold drinks'` (Strictly enforced 3-category union)
   * `soldCount`: `number` (Cumulative units sold)
   * `image`: `string` (Compressed base64 data URI, resized under 400×400 via `src/lib/imageUtils.ts`)
   * `stockBatches`: `StockBatch[]` (`{ id, quantity, costPrice, sellingPrice, date }`) for FIFO/weighted batch tracking
   * `updatedAt`: `number` (UTC ms timestamp)

2. **`bills/{billId}`**:
   * `id`: `string`
   * `total`: `number` (Capped at `MAX_BILL_AMOUNT = 10000`)
   * `subtotal`: `number`, `discount`: `number`
   * `date`: `number` (UTC ms timestamp)
   * `items`: `BillItem[]` (`{ productId?, name, price, costPrice?, quantity, category? }`)
   * `customerName?`: `string`, `customerPhone?`: `string`
   * `isUdhar?`: `boolean` (Credit/borrow checkout)
   * `linkedOtherCostId?`: `string` (Links an Udhar/Due bill to `other_costs/{id}` for bidirectional sync)
   * `status?`: `'completed' | 'on_hold'`
   * `createdBy?`: `string` (Email of staff/admin who created the bill)

3. **`other_costs/{costId}`**:
   * `id`: `string`
   * `title`: `string`
   * `amount`: `number` (Capped at `MAX_BILL_AMOUNT = 10000`)
   * `category`: `'expense' | 'borrow' | 'due' | 'other'`
   * `date`: `number` (UTC ms timestamp)
   * `linkedBillId?`: `string` (Links back to `bills/{id}` when created from an Udhar checkout)
   * `customerName?`: `string`, `customerPhone?`: `string`

4. **`settings/{docId}`**:
   * `profile_{uid}`: Registered user profile (`uid`, `email`, `name`, `photoURL`, `role: 'admin' | 'user'`, `isAdmin: boolean`, `disabled: boolean`, `online: boolean`, `lastActive: number`, `provider: string`, `customPhoto: boolean`).
   * `blocked_accounts`: `{ uids: string[], emails: string[], updatedAt: number }` — Global blacklist checked in real time by `AuthContext.tsx`.
   * `deleted_accounts`: `{ uids: string[], emails: string[], updatedAt: number }` — Tracks deleted accounts so active sessions are immediately signed out, while allowing clean re-registration on next explicit sign-in.
   * `security` / `admin_pin`: Stores the 4-digit Admin PIN (`pin` field, default `"5566"`).
   * `admin_broadcast_notification`: Real-time admin broadcast banner/push payload (`targetAudience`: `'all' | 'admins' | 'users'`, `senderUid`, `timestamp`, `acknowledgedBy`).
   * `global_security_message`: Latest admin security alert document + `events` array (`pin_login_bypass`, `failed_pin_lockout`, `acknowledgedBy`).
   * `stock_alerts_feed`: Cross-device instant stock transition feed (`latestAlerts` with `out_of_stock`, `critical_low`, `low_stock` events and `sourceDeviceId`) so backgrounded/remote phones alert immediately without waiting for next app open.
   * `ai_rpc_req_{id}`: Transient server-side Gemini RPC documents (fallback path processed and deleted by `server.ts` when active).

5. **`activity_logs/{logId}`**:
   * `action`: `string` (e.g., `'stock_edit'`, `'bill_created'`, `'bill_deleted'`, `'failed_login'`, `'role_changed'`, `'backup_created'`, `'data_purged'`, etc.)
   * `details`: `string`
   * `timestamp`: `number`
   * `userEmail?`: `string`, `userName?`: `string`

6. **`security_alerts/{alertId}`**:
   * Created on 3 consecutive failed Admin PIN attempts (`type: 'failed_pin_lockout'`), triggering a 30-second terminal lockout and high-priority push notification across admin devices.

7. **`sync_conflicts/{conflictId}`**:
   * Created by `BillsContext.tsx` when an offline-queued bill is replayed upon reconnection and a product's current cloud stock is lower than the offline bill's sold quantity.

---

## 🗺️ 3. Complete File & Module Map

### 3.1 Core Contexts & Libraries (`src/lib/`)
* **`src/lib/firebase.ts`**: Initializes Firestore (`db` with persistent IndexedDB cache) and Firebase Auth (`auth`), plus `getSecondaryFirestore(databaseId)` for Direct Cloud Recovery in Admin Data Management.
* **`src/lib/AuthContext.tsx`**:
  * Manages Google Sign-In (Web `signInWithPopup` + Native Capacitor `FirebaseAuthentication.signInWithGoogle`).
  * Synchronizes user profile (`settings/profile_{uid}`) and online heartbeat (`online: true`, `lastActive`).
  * Enforces real-time account blocking (`settings/blocked_accounts`) and account deletion kicks (`settings/deleted_accounts`).
  * Owner email (`suman.das.199972@gmail.com`) defaults to permanent admin unless explicitly demoted (`role: 'user'` / `isAdmin: false`) by another permanent admin.
  * Distinguishes `isRealAdmin` (permanent database-backed admin) vs `isAdmin` (includes temporary session PIN unlock `sessionStorage.getItem('adminAuth') === 'true'`).
* **`src/lib/ProductsContext.tsx` & `src/lib/firestoreHooks.ts`**:
  * Real-time `onSnapshot` listener on `products`, mirrored to local SQLite/Dexie (`sqliteAdapter.ts`) and `localStorage` (`local_products_fallback`).
  * Non-blocking ("fire-and-forget") CRUD operations (`addProduct`, `updateProduct`, `deleteProduct`, `addBill`, `updateBill`, `deleteBill`, `logActivity`).
  * Enforces `MAX_PRODUCT_STOCK = 2000` and `MAX_BILL_AMOUNT = 10000`.
* **`src/lib/BillsContext.tsx`**:
  * Real-time `onSnapshot` listener on `bills`, merged with offline pending bills queue (`offline_pending_bills_v1`).
  * Automatically flushes queued offline bills when `navigator.onLine` returns, decrementing product stock and logging `sync_conflicts` if stock went negative during offline divergence.
  * Handles bidirectional Udhar/Borrow/Due synchronization: deleting or editing a bill updates or removes its linked `other_costs` record (`linkedOtherCostId`), and settling/deleting a Due/Borrow in `other_costs` updates the linked bill.
* **`src/lib/CartContext.tsx`**:
  * Manages active POS cart items, custom unit price overrides, discounts, hold-bill slots (`held_bills_v1`), and `MAX_BILL_AMOUNT = 10000` enforcement.
* **`src/lib/geminiApi.ts` & `server.ts`**:
  * `server.ts` executes all Gemini API requests server-side via `@google/genai` (`process.env.GEMINI_API_KEY` configured in AI Studio Secrets) with multi-model failover across `gemini-3.1-flash-lite`, `gemini-3.8-flash`, `gemini-flash-latest`, `gemini-3.5-transcribe`, `gemini-3.8-flash-lite-tts`, and `gemini-3.8-flash-tts`. `src/lib/geminiApi.ts` connects to `/api/gemini/*` (relative URL on web, dynamically synced `serverUrl` from `settings/ai_bridge_config` on native APK) and races with the URL-independent Firestore RPC bridge (`settings/ai_rpc_req_*`).
  * Supports bilingual (English + Bengali / Banglish) store intelligence, live inventory/profit context injection, vision analysis, and structured `<ACTION>{...}</ACTION>` tags (`UPDATE_STOCK`, `UPDATE_PRICE`, `UPDATE_PRODUCT_IMAGE`, `ADD_PRODUCT`, `DELETE_PRODUCT`, `UPDATE_BILL`, `DELETE_BILL`, `PURGE_STORE_DATA`, `ADD_TRANSACTION`, `ADD_EXPENSE`, `DELETE_EXPENSE`, `UPDATE_ROLE`).
* **`src/lib/stockAlerts.ts`**:
  * Instant threshold transition detection (`classifyStockTransition` -> `out_of_stock`, `critical_low`, `low_stock`), local deduplication (`wasStockTransitionRecentlyHandled`), and Firestore `settings/stock_alerts_feed` publishing.
* **`src/lib/versionCheck.ts`**:
  * GitHub Releases version check & in-app APK updater (`bestboyssd/Buzz`) with anchored `buzz_outdated_active_first_seen` grace enforcement (prevents bypassing the mandatory lock across release bumps or long-lived background sessions), `"Pass This Time"` UI without countdown text, and native `AndroidExporter` resumable APK downloader (`HTTP Range`, 180ms byte progress emission, and `cancelApkDownload` socket disconnect).
* **`src/lib/capacitor.ts`**:
  * Native Capacitor lifecycle hooks, `appResumed` dispatch, and 4-layer Android hardware back-button handler (`androidBackPress` cancelable event for modals/drawers/subviews, secondary tab return to `/`, and double-press exit on Home).
* **`src/lib/utils.ts`**:
  * `MAX_BILL_AMOUNT = 10000`, `MAX_PRODUCT_STOCK = 2000`, `formatPrice()`.
  * `getBillCalendarIsoDate()`: Standard `00:00:00` midnight calendar boundary for bills (`YYYY-MM-DD`).
  * `getAppBusinessDate()` / `getAppBusinessIsoDate()`: 1:00 AM shift cutoff helper used in Analytics.
  * `showLocalNotification()`: Sequential, deterministically keyed & deduplicated notification dispatcher supporting native `AndroidExporter` (with shared `BuzzNativeAlertPrefs` sync), Capacitor `LocalNotifications`, and Web Service Worker notifications (`public/sw-notifications.js` on non-native web/PWA).
* **`src/lib/printerManager.ts`**:
  * Manages Bluetooth / WebSerial / USB / Network ESC/POS thermal printers and isolated iframe thermal receipt/Z-Report printing.

### 3.2 Pages (`src/pages/`)
* **`src/pages/Home.tsx` (`/`)**: Main POS terminal with category rail (`All`, `Fresh`, `Cold Drinks`, `Frozen`), instant search, product cards with stock badges, and floating checkout bar.
* **`src/pages/Checkout.tsx` (`/checkout`)**: Cart review, quantity steppers, custom item price override, discount, Udhar (Credit/Due) toggle with customer name/phone, Hold/Recall bills, and thermal receipt modal.
* **`src/pages/History.tsx` (`/history` — "Business Activity")**:
  * **Strictly Today's Bills Only**: Displays "Today's Flow" (`todayRevenue`), "Today's Receipts" (`todaySalesCount`), and lists **only today's bills** (`todayBills` filtered by `getBillCalendarIsoDate(bill.date) === todayIso`).
  * Automatically rolls over across midnight via a 15-second / focus / visibility sync check on `todayIso`.
  * **Important**: Do NOT re-introduce `isShowingRecentFallback` here — when today has 0 bills, it must show `0 receipts` and the empty state card, never yesterday's bills.
* **`src/pages/AllBills.tsx` (`/all-bills` — Admin "All Bills")**:
  * Dedicated historical ledger accessible from the Admin Panel. Groups all bills across all dates into `Today`, `Yesterday`, and `DD/MM/YYYY` sections with full search and receipt editing/deletion.
* **`src/pages/Products.tsx` (`/products` — "Stock")**:
  * Inventory catalog, category filters, stock batch restocking (`AddStockModal`), product creation/editing (`AddProductModal` with camera/gallery base64 compression), and automatic category self-healing (`fresh` | `frozen` | `cold drinks`).
* **`src/pages/Admin.tsx` (`/admin`)**:
  * Protected by 4-digit Security PIN pad (default `5566`, 3-attempt lockout triggers `security_alerts` and 30s cooldown).
  * Houses quick links to Analytics (`/analytics`), All Bills (`/all-bills`), Other Costs (`expense` / `borrow` / `due` / `other`), Registered User Accounts governance (Lock/Unlock, Promote/Revoke Admin, Delete Account), Activity Logs (`All`, `Stock Edit`, `Failed Login`, `Role Changed`, `Backup`), Security Alerts, Sync Conflicts, and Data Management (Export/Import JSON Snapshot, Direct Cloud Recovery from `buzz-8521`, and Database Purge with `DELETE` confirmation).
* **`src/pages/Analytics.tsx` (`/analytics`)**:
  * Comprehensive financial analytics, net profit & margin breakdowns, FIFO/effective cost calculations, top-selling products, hourly/daily/monthly charts, Z-Report thermal printing, and embedded AI insights.
* **`src/pages/Settings.tsx` (`/settings`)** & **`src/pages/PrivacyPolicy.tsx` (`/privacy`)**:
  * Profile customization, theme toggle (Dark/Light/System), notification toggle, performance mode toggle, battery optimization prompt, thermal printer connection manager, in-app update trigger, and Privacy Policy.

---

## 🛠️ 4. Key Architectural Invariants & Guardrails

1. **Today's Bills vs All Bills Separation**:
   * `/history` (`src/pages/History.tsx`) is strictly for **Today's Bills** (`getBillCalendarIsoDate(bill.date) === todayIso`). Never fall back to showing previous days' bills on `/history`.
   * `/all-bills` (`src/pages/AllBills.tsx`) is the full historical bill archive for Admins.
2. **Strict 3-Category Product Enforcement (`fresh`, `frozen`, `cold drinks`)**:
   * Every product category is normalized via `normalizeProductCategory()` to `'fresh' | 'frozen' | 'cold drinks'`.
   * Missing product images render `src/components/ProductImagePlaceholder.tsx` (`ShoppingBag` icon with sky gradient for `frozen`, indigo/purple gradient for `cold drinks`, emerald/teal for `fresh`).
3. **Hard Caps (`MAX_BILL_AMOUNT = 10000`, `MAX_PRODUCT_STOCK = 2000`)**:
   * Enforced across all UI modals, Cart context, Firestore hooks, and AI assistant actions.
4. **Equalized Permanent Admin Governance**:
   * Any permanent admin (`isRealAdmin`) can promote/demote other users (including `suman.das.199972@gmail.com`) and edit profiles, except an admin cannot demote or delete their own currently active account.
5. **Account Ban, Delete & Fresh Re-Creation Lifecycle (`AuthContext.tsx` & `Admin.tsx`)**:
   * **Never use `{ merge: true }` on `settings/deleted_accounts` or `settings/blocked_accounts`**: In Firestore, `setDoc(..., { merge: true })` deep-merges nested map objects (`deletedUids`, `deletedEmails`), which prevents `delete obj[key]` from ever removing entries. Always write `deleted_accounts` and `blocked_accounts` without `{ merge: true }`.
   * **Ban -> Delete -> Re-Create Flow**: When an Admin deletes a user account (`handleDeleteUserAccount` in `Admin.tsx`), all matching `profile_*` and `attempts_*` docs across all UIDs for that email are deleted, the user's UIDs and email are removed from `settings/blocked_accounts`, and a monotonic deletion timestamp (`now = Math.max(Date.now(), maxExistingTs + 1000)`) is recorded in `settings/deleted_accounts`.
   * **Fresh Account Re-Creation**: When a deleted user explicitly clicks "Continue with Google" (`signInWithGoogle()`), `AuthContext.tsx` queries fresh server documents (`getDocFromServer`), sees `wasDeleted = deletedAt > 0 && docRecreatedAt <= deletedAt`, ignores any stale local `is_blocked_cached_${uid}` flag, wipes all local cache keys (`wipeLocalAccountCache`), restores their original Google provider `displayName` and `photoURL` via `updateProfile()` (clearing any old custom name/photo from `Account.tsx`), deletes any stale duplicate `profile_*` docs for that email, removes the user from `deleted_accounts` and `blocked_accounts`, and writes a brand-new `profile_${uid}` document with `recreatedAt: Math.max(Date.now(), deletedAt + 1000)`.
   * **Preventing Zombie Resurrection**: `Admin.tsx` (`buildUnifiedAccountsList`) and `AuthContext.tsx` compare `docRecreatedAt <= deletedAt` (rather than `updatedAt <= deletedAt`) so background presence heartbeats or cross-device clock skew can never resurrect a deleted profile document.
6. **Gemini AI Transport & Native APK Speed (`src/lib/geminiApi.ts`, `server.ts`, `AdminAIAssistant.tsx`)**:
   * **Native Android Direct Streaming (`directGeminiChatStream`)**: On native Android APK (`Capacitor.isNativePlatform()`), Buzz AI connects directly to Google's official Gemini API endpoint (`generativelanguage.googleapis.com`) using `directGeminiChatStream()` and a dynamically resolved key (`localStorage` -> Firestore `settings/ai_bridge_config` -> build env). This delivers sub-second (<1s) responses for queries like "yo", with live token-by-token streaming, completely eliminating 16-21s Firestore bridge delays.
   * **In-App "Set AI Key" Setup**: If a key is missing or revoked, an intuitive inline modal in the Buzz AI header and error banner allows administrators to paste a Google AI Studio key (`AIzaSy...`), verifying it instantly and saving it to Firestore `settings/ai_bridge_config` so all store devices share it without requiring an APK update.
   * **Server-Side Gemini Execution & Failover (`server.ts`)**: When `server.ts` is running, `/api/gemini/chat-stream`, `/api/gemini/chat`, `/api/gemini/transcribe`, `/api/gemini/tts`, `/api/gemini/analyze-media`, and the real-time `settings/ai_rpc_req_*` Firestore listener process web and fallback requests with `{ merge: true }` remote config preservation. No API keys are embedded in git source code.
   * **Strict Zero-Preset-Message Policy**: Never return preset or deterministic canned messages (such as `"Store Snapshot: X products in catalog..."`) when the user talks to Buzz AI. Every user message or command must be answered by the live Gemini AI.
   * **Installed PWA Service Worker (`vite.config.ts`)**: `workbox` is configured with `navigateFallbackDenylist: [/^\/api\//, /^\/health/]` and `NetworkOnly` runtime caching for `/api/*` so installed phone PWAs never intercept or buffer `/api/gemini/chat-stream` SSE responses.
7. **Mobile Microphone, Native TTS, SmartRooti Thermal Printing & Instant Deduplicated Notifications (`AdminAIAssistant.tsx`, `MainActivity.java`, `BillReceiptModal.tsx`, `Analytics.tsx`, `BuzzRealtimeSyncService.java`, `BuzzNotificationWorker.java`, `printerManager.ts`)**:
   * **Android Microphone Hardware Lock**: On Android phones (`isMobileDevice`), never call `navigator.mediaDevices.getUserMedia()` concurrently with `SpeechRecognition` (`webkitSpeechRecognition`), because Android's audio HAL only allows one active audio capture client per app (`getUserMedia` locks the mic and causes `SpeechRecognition` to immediately fail). Use `getUserMedia` only on desktop or when recording via `MediaRecorder` fallback.
   * **Native Android Print Bridge & SmartRooti Branding**: `MainActivity.java` exposes `window.AndroidExporter.printHtml(jobName, htmlContent)` backed by Android's `PrintManager`, wired into `BillReceiptModal.tsx`, `Analytics.tsx`, and `printerManager.ts` for SmartRooti-branded 80mm thermal receipts and Z-Reports.
   * **Instant Background & Cross-Device Alerts (Single Delivery Guarantee)**: `BuzzRealtimeSyncService` (`foregroundServiceType="remoteMessaging"`) + `BuzzNotificationWorker` poll Firestore REST (`admin_broadcast_notification`, `global_security_message`, `stock_alerts_feed`, `sync_conflicts`) in the background (every 6s active / 15s idle), sharing user context and notified keys/timestamps with JS via `AndroidExporter.syncNotificationContext` and `AndroidExporter.markAlertHandled` so JS listeners and native background workers never emit duplicate phone notifications.
8. **Edge-to-Edge Android Layout, Hardware Back Navigation & Spring Choreography**:
   * `MainActivity.java` sets `setDecorFitsSystemWindows(false)` and transparent status/navigation bars.
   * `App.tsx` applies `env(safe-area-inset-top)` padding, and `BottomNav.tsx` uses `bottom: calc(1.1rem + env(safe-area-inset-bottom))`.
   * Hardware Back (`capacitor.ts` -> `androidBackPress`) is intercepted by open drawers/modals/Admin sub-views (Buzz AI, Buy Prices, Accounts, Activity Logs, Sync Conflicts, Z-Report, Receipt & Stock modals) before tab/history navigation.
   * Cohesive 60/120fps spring physics (respecting `performanceMode` when enabled, with clean non-jumping Activity Logs refresh and Buy Prices multi-line layout) are implemented across the app's pages and modals.


