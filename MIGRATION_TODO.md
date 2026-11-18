# Handover & Architecture Guide — Buzz POS (`v1.3.5`)

> [!WARNING]
> ### 🛑 CRITICAL AGENT RULES — READ FIRST
> 1. **DO NOT MODIFY THE UI UNSOLICITED**: Do not make visual adjustments, layout restructures, or cosmetic styling changes unless explicitly instructed by the user.
> 2. **NO AUTHENTICATION BYPASSES**: Never add anonymous login fallbacks (`signInAnonymously`), fake admin accounts (`Demo Admin (Bypass)`), or unauthenticated database access in `Login.tsx`, `AuthContext.tsx`, or `firestore.rules`.
> 3. **SINGLE UNIFIED DATABASE**: Always connect to the existing shared Cloud Firestore database (`ai-studio-remixbuzzv111-8ceddc6a-4499-4e60-a805-dedb47b5266b` in project `tidy-byte-g5xj8`). Never create or switch to a blank database.
> 4. **GEMINI AI TRANSPORT POLICY**: All Gemini API calls (streaming chat, standard chat, voice synthesis/TTS, audio transcription, and multimodal media analysis) run on the server (`server.ts`) using `process.env.GEMINI_API_KEY` managed in AI Studio Secrets. Browser and native APK clients call `/api/gemini/*` and the real-time Firestore RPC bridge (`settings/ai_rpc_req_*`) via `src/lib/geminiApi.ts`—never call `generativelanguage.googleapis.com` directly from the client or store API keys in git, `vite.config.ts`, `localStorage`, or Firestore `settings/ai_bridge_config`.
> 5. **CONTEXT WINDOW MONITORING**: Always notify the user when your context window is getting close to full or if a context compaction occurs so they can migrate smoothly.
> 6. **GITHUB REPO SYNC & APK RELEASE PROTOCOL**:
>    * When the user says **`apk`**:
>      1. Pull latest changes from the GitHub repo (`git pull origin main`).
>      2. Build web assets (`npm run build`) and sync Capacitor (`npx cap sync android`).
>      3. Build the Android APK (`cd android && ./gradlew assembleDebug` or release build).
>      4. Upload/publish the APK to GitHub Releases under tag `vX.Y.Z` (matching the version in `package.json` / `metadata.json`, e.g., `v1.3.5`) with only the `Buzz-vX.Y.Z.apk` asset (do not upload generic `Buzz.apk`).
>    * When the user says **`update`**:
>      1. If any local files or app fixes were made, stage all changes (`git add .`).
>      2. Commit with a clear message (`git commit -m "..."`).
>      3. Push the updates to the GitHub repository (`git push origin main`).

---

## 📱 1. Application Overview & Tech Stack
* **App Name**: Buzz (`Buzz - v1.3.5`)
* **Android Package / Namespace**: `com.smartrooti.billing`
* **Version**: `1.3.5` (`versionCode 135`, `versionName "1.3.5"`) synchronized across:
  * `package.json` (`"version": "1.3.5"`)
  * `android/app/build.gradle` (`versionCode 135`, `versionName "1.3.5"`)
  * `src/lib/versionCheck.ts` (`getInitialBundledVersion()` resolves the highest semver between `package.json` and `metadata.json`, returning `"1.3.5"`)
  * `src/pages/Settings.tsx` (`getAppVersion()` resolves via `versionCheck.ts` / `package.json`)
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
* **`src/lib/geminiApi.ts`, `cloudflare-worker/buzz-ai.mjs` & `server.ts`**:
  * **24/7 Production Mobile AI Backend (`cloudflare-worker/buzz-ai.mjs`)**: Deployed on Cloudflare Workers at `https://buzz-ai.dassusuman2009.workers.dev` (Account `004b1e645593363772bd49517a72bd63`, `dassusuman2009@gmail.com`, `$0/mo` free tier, zero credit card, zero cold starts, CORS `*`). Uses the Cloudflare Workers AI (`env.AI`) binding with automatic multi-model failover:
    * **Text & Store Operations (`/api/gemini/chat`, `/api/gemini/chat-stream` SSE)**: `@cf/meta/llama-3.3-70b-instruct-fp8-fast` -> `@cf/google/gemma-4-26b-a4b-it` -> `@cf/meta/llama-3.1-8b-instruct-fp8`.
    * **Vision & Media Analysis (`/api/gemini/analyze-media` + image attachments)**: `@cf/google/gemma-4-26b-a4b-it` -> `@cf/mistralai/mistral-small-3.1-24b-instruct` -> `@cf/meta/llama-3.2-11b-vision-instruct`.
    * **Voice Transcription (`/api/gemini/transcribe`)**: `@cf/openai/whisper-large-v3-turbo` -> `@cf/openai/whisper` (English, Bengali/বাংলা, Banglish).
    * **Utility Routes**: `/api/health`, `/api/gemini/clear-chat`, `/api/avatar-proxy`.
  * **Local / AI Studio Preview Server (`server.ts`)**: When running inside AI Studio Preview or locally (`npm start` via `tsx server.ts`), `server.ts` executes Gemini API requests via `@google/genai` (`process.env.GEMINI_API_KEY`) and listens to the Firestore RPC bridge (`settings/ai_rpc_req_*`).
  * **Client Routing (`src/lib/geminiApi.ts`)**: `CLOUDFLARE_EDGE_AI_URL` (`https://buzz-ai.dassusuman2009.workers.dev`) is the built-in 24/7 default for native Android APKs (and web fallback). `isCookieGatedAiStudioUrl()` prevents native Capacitor WebView from calling cookie-gated `ais-dev-*.run.app` URLs (which return an HTML `"Cookie check"` page). Custom server URLs can still override via `Settings -> Buzz AI Engine` (`localStorage.buzz_api_server_url`).
  * Supports bilingual (English + Bengali / Banglish) store intelligence, live inventory/profit context injection, vision analysis, and structured ` ```action {...}``` ` confirmation cards (`UPDATE_STOCK`, `UPDATE_PRICE`, `UPDATE_PRODUCT_IMAGE`, `ADD_PRODUCT`, `DELETE_PRODUCT`, `UPDATE_BILL`, `DELETE_BILL`, `PURGE_STORE_DATA`, `ADD_TRANSACTION`, `ADD_EXPENSE`, `DELETE_EXPENSE`). Never falls back to dummy canned text.
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
6. **Gemini AI Transport, ~1s Parallel Racing & Manual Confirmation Cards (`src/lib/geminiApi.ts`, `server.ts`, `AdminAIAssistant.tsx`)**:
   * **Server-Side Hedged Gemini Execution (`server.ts` & `src/lib/geminiApi.ts`)**: All Gemini calls execute on the server via `server.ts` using `process.env.GEMINI_API_KEY` (managed via AI Studio **Settings > Secrets**), racing `gemini-3.1-flash-lite` (`ThinkingLevel.MINIMAL`) and hedged `gemini-4-hydrogen` (`ThinkingLevel.LOW` at `150ms` delay) with `maxOutputTokens` capped for sub-second generation. No API keys are embedded in client bundles, git source, or Firestore `settings/ai_bridge_config`.
   * **Parallel Client Racing (`askGeminiAssistantStream` in `src/lib/geminiApi.ts`)**: Never wait sequentially for `/api/gemini/chat-stream` (SSE) to time out before starting `/api/gemini/chat` or `askViaFirestoreBridge`. `askGeminiAssistantStream` races `directHttpPromise` (`POST /api/gemini/chat`), `streamPromise` (`POST /api/gemini/chat-stream`), and `bridgePromise` (`askViaFirestoreBridge`) in parallel from the start so whichever completes first in **~0.8s–1.3s** on Web Preview or Native Android APK wins immediately and aborts the others.
   * **Single-Write Firestore RPC & Guarded Polling (`server.ts` & `src/lib/geminiApi.ts`)**: In `server.ts` (`handleRpcDocument`), the intermediate `{ status: "processing" }` write is delayed behind a `1500ms` timer (cleared on completion), so `<1.5s` RPC requests perform only a single Firestore write (`status: "completed"`). On the client (`askViaFirestoreBridge` & `transcribeViaFirestoreBridge`), never run a `120ms` unguarded `getDocFromServer` interval before `setDoc` completes; rely on `onSnapshot` for instant push delivery and start a guarded (`pollInFlight`) `450ms` fallback poll only after `setDoc` resolves.
   * **Manual Confirmation Cards (`AdminAIAssistant.tsx`)**: Never auto-execute `UPDATE_STOCK`, `UPDATE_PRICE`, or other catalog mutations on stream completion. Always render the interactive confirmation card (`Confirm Stock Update` / `Confirm Price Update`) and wait for the user to explicitly click the button before mutating Firestore.
   * **Strict Zero-Preset-Message Policy**: Never return preset or deterministic canned messages when the user talks to Buzz AI. Every user message or command must be answered by the live Gemini AI.
   * **Installed PWA Service Worker (`vite.config.ts`)**: `workbox` is configured with `navigateFallbackDenylist: [/^\/api\//, /^\/health/]` and `NetworkOnly` runtime caching for `/api/*` so installed phone PWAs never intercept or buffer `/api/gemini/*` responses.
7. **Multilingual Voice Transcription (Bengali + Mixed Bengali/English "Banglish" + Paused Speech), Consistent Kore TTS, SmartRooti Thermal Printing & UI Polish (`AdminAIAssistant.tsx`, `server.ts`, `Checkout.tsx`, `Analytics.tsx`)**:
   * **Continuous MediaRecorder + Gemini Multimodal Transcription (`AdminAIAssistant.tsx` & `server.ts`)**: On all platforms (Web and Native Android), `toggleListening` uses `startMediaRecorderFallback()` (continuous `MediaRecorder` + parallel HTTP/Firestore `/api/gemini/transcribe`) instead of browser `webkitSpeechRecognition` (`lang="en-US"`, `continuous=false`). This ensures pure Bengali (`বাংলা`), pure English, and mixed Bengali + English ("Banglish" code-switching) are recognized accurately, and paused/hesitant/unpatchy speech is recorded continuously until the user taps Stop/Send and stitched into a clean command with normalized `0-9` digits.
   * **Consistent Single Assistant Voice (`Kore`) & Non-Selectable UI Chrome**: Server TTS (`/api/gemini/tts`) uses `gemini-3.8-flash-lite-tts` with fixed prebuilt voice `"Kore"`, and browser fallback caches a single preferred voice (`cachedPreferredBrowserVoiceRef`). Action buttons (`Listen`, `Copy`) and thinking accordions (`Thought for Xs`) use `select-none` (`userSelect: "none"`) so copying message text never copies UI chrome, and clipboard image paste (`onPaste`) is supported directly in the chat input.
   * **Cart Dark-Mode Stepper & Z-Report Date Navigation (`Checkout.tsx` & `Analytics.tsx`)**: Cart `+` and `-` buttons maintain dark-mode active styling (`dark:active:bg-[#252b3b]`) without flashing white, and Z-Report date navigation arrows (`‹` next day, `›` previous day) follow the user's requested direction.
   * **Native Android Print Bridge & Instant Deduplicated Notifications**: `MainActivity.java` exposes `window.AndroidExporter.printHtml(jobName, htmlContent)` for SmartRooti 80mm thermal receipts/Z-Reports, and `BuzzRealtimeSyncService` + `BuzzNotificationWorker` coordinate with JS via `AndroidExporter.markAlertHandled` for single-delivery background notifications.
8. **Edge-to-Edge Android Layout, Hardware Back Navigation & Spring Choreography**:
   * `MainActivity.java` sets `setDecorFitsSystemWindows(false)` and transparent status/navigation bars.
   * `App.tsx` applies `env(safe-area-inset-top)` padding, and `BottomNav.tsx` uses `bottom: calc(1.1rem + env(safe-area-inset-bottom))`.
   * Hardware Back (`capacitor.ts` -> `androidBackPress`) is intercepted by open drawers/modals/Admin sub-views (Buzz AI, Buy Prices, Accounts, Activity Logs, Sync Conflicts, Z-Report, Receipt & Stock modals) before tab/history navigation.
   * Cohesive 60/120fps spring physics (respecting `performanceMode` when enabled, with clean non-jumping Activity Logs refresh and Buy Prices multi-line layout) are implemented across the app's pages and modals.
9. **24/7 Cloudflare Workers AI Edge Backend (`cloudflare-worker/buzz-ai.mjs`)**:
   * **Why It Exists**: AI Studio preview URLs (`https://ais-dev-*.run.app`) hibernate when AI Studio is closed and sit behind an interactive Google `"Cookie check"` HTML login wall that blocks Android Capacitor `fetch()` calls. `buzz-ai` on Cloudflare Workers runs 24/7 globally at **$0/month** (free tier: 100,000 requests/day + 10,000 Workers AI neurons/day, no credit card, zero cold starts) with full CORS headers (`Access-Control-Allow-Origin: *`).
   * **Deployment Coordinates**:
     * **Live URL**: `https://buzz-ai.dassusuman2009.workers.dev`
     * **Worker Script Name**: `buzz-ai` (source tracked in `cloudflare-worker/buzz-ai.mjs`)
     * **Cloudflare Account**: `Dassusuman2009@gmail.com's Account` (Account ID: `004b1e645593363772bd49517a72bd63`, subdomain `dassusuman2009.workers.dev`)
     * **Binding**: `{ "type": "ai", "name": "AI" }` (Cloudflare Workers AI), `compatibility_date: "2026-11-17"`, `observability: { enabled: true, traces: { enabled: true } }`
   * **How Requests Flow on Phone (`src/lib/geminiApi.ts`)**:
     1. `getApiBaseUrl()` resolves custom override (`localStorage.buzz_api_server_url`) -> non-cookie-gated `cachedBridgeServerUrl` -> default `CLOUDFLARE_EDGE_AI_URL` (`https://buzz-ai.dassusuman2009.workers.dev`).
     2. `isCookieGatedAiStudioUrl()` filters out `ais-dev-*.run.app` from native direct HTTP calls so mobile never parses an HTML cookie page as JSON.
     3. `askGeminiAssistantStream()` opens SSE streaming against `/api/gemini/chat-stream` (racing `/api/gemini/chat` and Firestore RPC bridge), receives live token chunks (`data: {"chunk":"..."}`) and final structured `action` payload (`data: {"done":true,"fullText":"...","action":{...}}`).
     4. `parseAssistantOutput()` in `buzz-ai.mjs` extracts valid POS action JSON from ` ```action `, ` ```json `, or bare ` ``` ` blocks and strips raw JSON out of the visible `reply`. `geminiApi.ts` also strips fenced action JSON mid-stream so raw JSON never flashes on screen.
     5. Voice clips (`POST /api/gemini/transcribe`) run `@cf/openai/whisper-large-v3-turbo` (fallback `@cf/openai/whisper`) with a `15s` timeout; image attachments run Gemma 4 / Mistral Small 3.1 / Llama 3.2 Vision; TTS on Android uses zero-latency native `AndroidExporter.speakText`.
     6. `Settings.tsx` (`testAiConnection`) checks JSON `/api/health` against `CLOUDFLARE_EDGE_AI_URL` and confirms `"Connected! 24/7 Cloudflare Edge AI is online."`.
   * **How to Update / Redeploy the Worker**: Edit `cloudflare-worker/buzz-ai.mjs` and upload via the Cloudflare MCP plugin (`PUT /accounts/004b1e645593363772bd49517a72bd63/workers/scripts/buzz-ai` with multipart `metadata` + `worker.js` and `bindings: [{ type: "ai", name: "AI" }]`), then verify with `GET https://buzz-ai.dassusuman2009.workers.dev/api/health`.
10. **Profile Image Stability, Zero-Flash Instant Login Avatar & Cross-UID Synchronization (`AuthContext.tsx`, `ProfileMenu.tsx`, `Account.tsx`, `Admin.tsx`, `server.ts`)**:
    * **Why the 3-Second Old Photo Flash Happened Previously & How It Is Fixed**:
      * Because custom profile photos are compressed base64 `data:image/jpeg;base64,...` strings (~15 KB), Firebase Auth's `updateProfile()` rejects them (`isPhotoTooLong > 1500`), leaving `currentUser.photoURL` and `providerData[0].photoURL` permanently stuck on the user's old Google OAuth URL (`https://lh3.googleusercontent.com/...`).
      * Previously, `onAuthStateChanged` called `setUser(patchedCurrentUser)` and `setLoading(false)` at `t = 0ms` before `settings/profile_${uid}` finished fetching from Firestore (~2–3s), causing `ProfileMenu.tsx` to fall back to `currentUser.photoURL` (the old Google photo) for 3 seconds before switching to `customPhotoURL`.
      * **Current Fix (`AuthContext.tsx`, `ProfileMenu.tsx`, `Account.tsx`)**:
        1. `getResolvedUserPhoto()` never falls back to Firebase Auth's stale `googleProvider.photoURL` until Firestore profile sync has verified (`profile_photo_synced_${uid}` / `custom_user_photo_verified_${uid}`) that no custom photo exists in `settings/profile_*`.
        2. On login (`onAuthStateChanged`), `AuthContext.tsx` queries `settings/profile_${uid}` **and** any sibling `settings/profile_*` document sharing the same normalized email (`fetchBestSiblingPhoto`), resolves the newest `customPhotoURL` (by `photoUpdatedAt` / `data:image/` preference), caches it under both UID (`custom_user_photo_${uid}`) and email (`custom_user_photo_email_${normEmail}`), and **pre-decodes the image bitmap (`preloadProfileImage` via `img.decode()`) BEFORE calling `setUser` / `setLoading(false)`** (bounded by a 1.8s safety timer).
        3. As a result, when login completes and `<Home />` mounts, **only the new profile picture is ever rendered on Frame 1** with zero 3-second flash.
    * **Dedicated `photoUpdatedAt` Field**: Profile photo conflict resolution uses `photoUpdatedAt` instead of generic `updatedAt` (which `Settings.tsx` bumps on every theme/haptics/notification toggle and login bumps on every startup).
    * **No Stale Login Overwrites**: `AuthContext.tsx` no longer writes `customPhotoURL` on routine login for existing accounts unless pushing a strictly newer local photo (`localPhotoTs > docPhotoTs`) or backfilling an empty photo.
    * **Cross-UID Sibling Sync**: Because Web Auth (`tidy-byte-g5xj8`) and Native Android Auth (`buzz-8521`) produce different UIDs for the same Google email, `Account.tsx` (`handleUpdate`) writes `customPhotoURL`, `photoUpdatedAt`, and `displayName` to ALL `settings/profile_*` documents sharing that normalized email (and awaits up to `2500ms`). `Admin.tsx` deduplication also compares `photoUpdatedAt` first when merging sibling accounts.
    * **Unsaved Edit Protection & Server Guard**: `Account.tsx` (`handleExternalProfileUpdate`) never wipes unsaved `photoURL`/`displayName` edits or an open `ImageCropperModal`. `server.ts` (`syncProfileAvatarToDataUrl`) re-reads the Firestore doc right before writing so background HTTP-to-base64 caching never overwrites a newly uploaded custom photo.
11. **Android Gboard Native Word Suggestions & Voice Typing (`AdminAIAssistant.tsx`, `MainActivity.java`, `scripts/patch-capacitor-android.mjs`)**:
    * `AdminAIAssistant.tsx` `<textarea>` uses `name="message"`, `id="buzz-ai-chat-input"`, `autoComplete="on"`, `autoCorrect="on"`, `autoCapitalize="sentences"`, `spellCheck={true}`, `whitespace-pre-wrap break-words`, and intentionally omits `inputMode="text"` and `whitespace-nowrap` so Chromium Blink never suppresses IME word predictions.
    * `MainActivity.java` requests `Manifest.permission.RECORD_AUDIO` alongside `POST_NOTIFICATIONS` on startup so Xiaomi MIUI/HyperOS does not cross out Gboard's voice typing microphone.
    * `scripts/patch-capacitor-android.mjs` persists the `CapacitorWebView.onCreateInputConnection(EditorInfo outAttrs)` patch that clears `TYPE_TEXT_FLAG_NO_SUGGESTIONS` & `nm`/`noMicrophoneKey` private IME options and enables `TYPE_TEXT_FLAG_AUTO_CORRECT | TYPE_TEXT_FLAG_AUTO_COMPLETE | TYPE_TEXT_FLAG_CAP_SENTENCES`.

---

## 🚀 5. Cloudflare 24/7 Edge Server Expansion — Implemented & Live (`v1.3.5`)

> [!NOTE]
> **Status — ALL Priority 1 & Priority 2 Features Implemented & Deployed Live (`v1.3.5`, $0/mo Free Tier, Zero Credit Card)**:
> * **Worker URL**: `https://buzz-ai.dassusuman2009.workers.dev` (Script: `buzz-ai`, source in `cloudflare-worker/buzz-ai.mjs`)
> * **Cloudflare Bindings**:
>   * `AI` — Cloudflare Workers AI (`@cf/meta/llama-3.3-70b-instruct-fp8-fast`, Gemma 4, Whisper v3 Turbo)
>   * `BUZZ_EVENTS_KV` — Free Cloudflare KV Namespace (ID: `926ae8a03ab349449b1970d2e05f54d1`) used for the 48-hour event ring buffer, atomic stock ledger, account governance mirror, GitHub release cache, and 30-day nightly cloud backups (zero R2/card required)
> * **Cloudflare Cron Trigger**: `30 19 * * *` (1:00 AM IST daily shift close) — snapshots `products`, `bills`, `other_costs`, and `settings` into `BUZZ_EVENTS_KV` (`backup:YYYY-MM-DD`, 30-day retention) and publishes a `"📊 Daily Store Digest"` alert (`targetAudience: "admins"`) into the Event Hub
> * **Live Endpoints on `buzz-ai`**:
>   * `POST /api/events/publish`, `GET /api/events/pull`, `GET /api/events/stream` (SSE live push + 48h offline-to-online catch-up queue)
>   * `POST /api/pos/atomic-checkout` (server-authoritative stock tracker & threshold alerting)
>   * `GET /api/releases/latest` (edge-cached 60s TTL + rate-limit-proof `github.com/.../releases/latest` fallback) & `GET /api/github/apk-download` (HTTP `Range` resumable APK proxy)
>   * `GET/POST /api/auth/status` (edge account governance mirror for `blockedUids`, `blockedEmails`, `deletedUids`, `deletedEmails`, `forcedLogoutAt`, `photoVersions`)
>   * `GET /api/backups/list`, `GET /api/backups/download?date=YYYY-MM-DD`, `POST /api/backups/run-now`
> * **Client & Native Android Integration**:
>   * `src/lib/cloudflareEvents.ts` — Event Hub publisher (with offline pending queue `buzz_cf_pending_events_v1`), foreground SSE subscriber, instant reconnect `pullCloudflareEvents`, `publishAtomicCheckoutToEdge`, `syncCloudflareAuthGovernance`
>   * `src/lib/stockAlerts.ts`, `src/pages/Admin.tsx`, `src/lib/AuthContext.tsx`, `src/lib/firestoreHooks.ts` — Publish stock alerts, Admin broadcasts, 3-attempt PIN lockouts, offline sync conflicts, atomic checkout stock deductions, and account governance updates to Cloudflare Edge
>   * `src/App.tsx` — Runs live foreground SSE stream + instant `online`/`appResumed`/`visibilitychange` catch-up pulls
>   * `src/lib/versionCheck.ts` — Uses edge-cached `/api/releases/latest` first before direct GitHub API fallback
>   * `android/app/src/main/java/com/smartrooti/billing/BuzzRealtimeSyncService.java` — Registers `ConnectivityManager.NetworkCallback` (`onAvailable`) to immediately invoke `BuzzNotificationWorker.runAlertCheckNow(ctx)` the exact millisecond an offline phone reconnects to Wi-Fi/mobile data
>   * `android/app/src/main/java/com/smartrooti/billing/BuzzNotificationWorker.java` — Pulls Cloudflare `/api/events/pull` FIRST in 1 lightweight request (with first-run `last_cf_cursor` seeding & shared `BuzzNativeAlertPrefs` deduplication) and throttles the 4 Firestore REST fallback calls to 60s intervals when Cloudflare is healthy (>95% reduction in background Firestore reads)

### 🔔 Priority 1 (User's Core Request): Server-Side Notification Hub & Instant Offline-to-Online Catch-Up Queue
* **Problem Solved**:
  1. Currently, when Phone A creates a bill and a product hits `out_of_stock` (`0` left), `critical_low` (`<=3`), or `low_stock` (`<=10`), Phone A writes to Firestore `settings/stock_alerts_feed`. Meanwhile, backgrounded Android phones (`BuzzRealtimeSyncService.java` + `BuzzNotificationWorker.java`) poll **4 separate Firestore REST endpoints every 4–8 seconds** (`admin_broadcast_notification`, `global_security_message`, `stock_alerts_feed`, `sync_conflicts`), burning **43,000–86,000 Firestore reads/day per phone** and risking 4–8s delays or missed alerts when multiple items go out of stock while a phone is offline.
  2. With the Cloudflare Worker acting as the **Central Notification & Event Hub**, the billing phone pushes the event to Cloudflare (`POST /api/events/publish`). Online phones receive it **instantly (`<50ms`)**, and any phone that is **offline** receives all missed notifications **the exact millisecond it reconnects to the internet** (`GET /api/events/pull?since=<cursor>`).
* **Architecture & Endpoints to Add to `cloudflare-worker/buzz-ai.mjs`**:
  1. **Cloudflare Storage Binding (`env.BUZZ_EVENTS_KV` or Durable Object `BuzzEventHub`)**:
     * Create a free Cloudflare KV namespace `BUZZ_EVENTS_KV` (or a free SQLite-backed Durable Object `BuzzEventHub` for WebSockets + zero-latency storage) on Account `004b1e645593363772bd49517a72bd63` and bind it to `buzz-ai`.
     * Maintain a bounded ring buffer of the last `200` store events (48-hour TTL), each stamped with a strictly monotonic `cursor` (`timestampMs` + sequence counter):
       ```json
       {
         "id": "stock_out_of_stock_prod123_0_1763410000000",
         "cursor": 1763410000000,
         "kind": "stock" | "broadcast" | "security" | "conflict" | "account_governance",
         "severity": "out_of_stock" | "critical_low" | "low_stock" | "high" | "normal",
         "title": "🚫 Out of Stock Alert",
         "body": "\"SmartRooti Fresh\" just ran out of stock (0 left)!",
         "canonicalKey": "stock_canonical_out_of_stock_prod123_0",
         "targetAudience": "all" | "admins" | "users",
         "sourceUid": "...",
         "sourceDeviceId": "dev_abc123",
         "timestamp": 1763410000000
       }
       ```
  2. **`POST /api/events/publish`**:
     * Called by:
       * `src/lib/stockAlerts.ts` (`publishStockTransitionAlerts`) whenever a checkout/stock edit causes a product to cross into `out_of_stock`, `critical_low`, or `low_stock`.
       * `src/pages/Admin.tsx` when sending an Admin Broadcast Announcement (`admin_broadcast_notification`) or locking/blocking/deleting a user account.
       * `src/lib/AuthContext.tsx` when a non-admin triggers a 3-attempt PIN lockout (`failed_pin_lockout`).
       * `src/lib/BillsContext.tsx` when an offline bill replay detects an unresolved stock conflict (`sync_conflicts`).
     * Appends the event(s) to the Cloudflare event log, deduplicating by `id` / `canonicalKey` within a 3-minute window, and immediately broadcasts to any active SSE/WebSocket listeners.
  3. **`GET /api/events/pull?since=<lastCursor>&uid=<uid>&role=<admin|user>&deviceId=<deviceId>`**:
     * Returns `{ ok: true, serverTime: Date.now(), latestCursor: <number>, events: [...] }` containing all events with `cursor > since` where `sourceDeviceId !== deviceId`, `sourceUid !== uid`, and `targetAudience` matches the caller's role (`all`, `admins`, or `users`).
     * **Instant Reconnect Trigger (Web + Capacitor JS + Native Android)**:
       * **In JS (`src/App.tsx` / `src/lib/stockAlerts.ts`)**: Listen to `window.addEventListener("online", ...)` and `window.addEventListener("appResumed", ...)`. The instant the phone reconnects to Wi-Fi or mobile data, call `GET https://buzz-ai.dassusuman2009.workers.dev/api/events/pull?since=...`, advance `localStorage.getItem("buzz_last_event_cursor_${uid}")`, and fire `showLocalNotification()` for every missed event!
       * **In Native Android (`BuzzRealtimeSyncService.java` & `BuzzNotificationWorker.java`)**:
         * Register a `ConnectivityManager.NetworkCallback` inside `BuzzRealtimeSyncService.onCreate()`. In `onAvailable(Network network)` (fired by Android OS the exact millisecond mobile data or Wi-Fi comes back online, even if the app is closed/backgrounded!), immediately invoke `BuzzNotificationWorker.runAlertCheckNow(ctx)`.
         * In `BuzzNotificationWorker.java`, query `https://buzz-ai.dassusuman2009.workers.dev/api/events/pull?since=<last_cf_cursor>&uid=...&role=...&deviceId=...` FIRST in a single fast request (falling back to the 4 Firestore REST URLs only if Cloudflare is unreachable). This cuts background Firestore read usage by **>95%** and delivers missed offline notifications in **<200ms** upon reconnection!
  4. **`GET /api/events/stream?uid=<uid>&role=<admin|user>&deviceId=<deviceId>` (SSE / WebSocket Live Push)**:
     * Streams real-time server-sent events (`data: {...}\n\n`) to connected phones so foreground and active background services receive `out_of_stock` and security alerts in `<50ms` with zero polling.

---

### ⚡ Priority 2: Additional High-Value Features to Add to the Cloudflare Server

1. **Server-Authoritative Atomic Stock Deduction & Multi-Phone Checkout Arbitrator (`POST /api/pos/atomic-checkout`)**:
   * **Why**: If two staff members on two phones bill the same product at the same second, client-side Firestore `setDoc(..., { stock: prevStock - qty })` can suffer a "lost update" race condition, or miss an `out_of_stock` transition if one phone was slightly behind.
   * **How Antigravity Should Build It**:
     * Use a Cloudflare Durable Object or KV atomic state per product (`stock:${productId}`).
     * When a phone completes a bill, it posts `{ billId, items: [{ productId, productName, quantity }], sourceUid, sourceDeviceId }` to `/api/pos/atomic-checkout`.
     * The Cloudflare server atomically decrements the stock count, detects if the combined multi-phone deductions crossed `10 -> <=10`, `3 -> <=3`, or `>0 -> 0`, and **automatically publishes the Out-of-Stock notification** into the `/api/events` queue for all other phones—even if the billing phone loses internet right after submitting the bill!

2. **Edge-Cached GitHub Release Check & Resumable APK Accelerator (`GET /api/releases/latest` & `GET /api/github/apk-download`)**:
   * **Why**:
     * Direct calls from phones to `https://api.github.com/repos/bestboyssd/Buzz/releases` hit GitHub's 60 requests/hour per-IP rate limit when multiple phones share store Wi-Fi.
     * Currently `src/lib/versionCheck.ts` already tries `${baseApiUrl}/api/github/apk-download`, which exists in local `server.ts` but **not yet in `cloudflare-worker/buzz-ai.mjs`**!
   * **How Antigravity Should Build It**:
     * Add `GET /api/releases/latest` to `cloudflare-worker/buzz-ai.mjs` using Cloudflare `caches.default` (60-second TTL) so version checks never hit GitHub rate limits and respond in `<20ms`.
     * Add `GET /api/github/apk-download` to `cloudflare-worker/buzz-ai.mjs` that proxies the GitHub Release `.apk` binary while forwarding `Range` and `Content-Range` headers across Cloudflare's edge CDN so `MainActivity.java` (`AndroidExporter.downloadAndInstallApk`) and `versionCheck.ts` get fast, resumable APK downloads 24/7.

3. **Automated Nightly Cloud Backups at 1:00 AM Shift Cutoff (Cloudflare Cron Trigger + R2 / KV Storage)**:
   * **Why**: Currently, database backups in `Admin.tsx -> Data Management` require an Admin to manually tap "Export Backup". If someone accidentally purges data or corrupts prices and no manual backup was taken recently, data since the last manual export could be lost.
   * **How Antigravity Should Build It**:
     * Add a free Cloudflare **Cron Trigger** (`crons = ["30 19 * * *"]` = 1:00 AM IST daily shift close) and a free **Cloudflare R2 bucket** (`BUZZ_BACKUPS_R2`, 10 GB/month free) or KV namespace to `buzz-ai`.
     * Every night at 1:00 AM IST, the worker fetches `products`, `bills`, `other_costs`, and `settings` from Firestore REST API and saves a timestamped snapshot `backup-YYYY-MM-DD.json` (retaining the last 30 days).
     * Expose `GET /api/backups/list` and `GET /api/backups/download?date=YYYY-MM-DD` so Admins can restore any of the last 30 nights' automatic backups with 1 tap in `Admin.tsx`!

4. **Automated Daily Shift Close Z-Report & Morning Low-Stock Digest Push (`Cron Trigger -> /api/events/publish`)**:
   * **Why**: Store owners/admins want to know each night's total revenue, total bills, net profit, and which items are out of stock for morning restocking without opening the app and manually filtering Analytics.
   * **How Antigravity Should Build It**:
     * In the same 1:00 AM IST Cron Trigger (or an 8:00 AM IST morning Cron Trigger), compute:
       * Today's total revenue (`₹...`), completed bills count, total expenses, and net profit.
       * List of currently Out-of-Stock (`0` left) and Critical Low (`<=3` left) products.
     * Automatically publish a `"📊 Daily Store Digest"` notification into the Cloudflare Event Queue (`targetAudience: "admins"`) so every Admin phone receives the daily sales & restock summary automatically.

5. **Instant Cross-Device Account Governance & Security Lockout Enforcement (`GET/POST /api/auth/status`)**:
   * **Why**: When an Admin blocks, locks, or deletes a user account in `Admin.tsx`, or triggers "Force Logout All Staff", mirroring `{ blockedUids, blockedEmails, deletedUids, deletedEmails, forcedLogoutAt }` in Cloudflare KV allows any phone or web client to verify account standing and latest `photoUpdatedAt` hash in `<25ms` at the edge.




