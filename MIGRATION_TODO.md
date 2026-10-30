# Handover & Architecture Guide — Buzz POS (`v1.0.0`)

> [!WARNING]
> ### 🛑 CRITICAL AGENT RULES — READ FIRST
> 1. **DO NOT MODIFY THE UI UNSOLICITED**: Do not make visual adjustments, layout restructures, or cosmetic styling changes unless explicitly instructed by the user.
> 2. **NO AUTHENTICATION BYPASSES**: Never add anonymous login fallbacks (`signInAnonymously`), fake admin accounts (`Demo Admin (Bypass)`), or unauthenticated database access in `Login.tsx`, `AuthContext.tsx`, or `firestore.rules`.
> 3. **SINGLE UNIFIED DATABASE**: Always connect to the existing shared Cloud Firestore database (`ai-studio-remixbuzzv111-8ceddc6a-4499-4e60-a805-dedb47b5266b` in project `tidy-byte-g5xj8`). Never create or switch to a blank database.
> 4. **100% SERVER-SIDE GEMINI API**: All Gemini AI calls (`@google/genai`) MUST execute on the backend server (`server.ts`). Never import `@google/genai` or expose API keys in browser code (`src/*`).
> 5. **CONTEXT WINDOW MONITORING**: Always notify the user when your context window is getting close to full or if a context compaction occurs so they can migrate smoothly.

---

## 📱 1. Application Overview & Tech Stack
* **App Name**: Buzz (`Buzz - v1.0.0`)
* **Android Package / Namespace**: `com.smartrooti.billing`
* **Version**: `1.0.0` (`versionCode 100`, `versionName "1.0.0"`) synchronized across:
  * `metadata.json` (`"name": "Buzz - v1.0.0"`)
  * `package.json` (`"version": "1.0.0"`)
  * `index.html` (`<title>Buzz - v1.0.0</title>`)
  * `android/app/build.gradle` (`versionCode 100`, `versionName "1.0.0"`)
  * `src/pages/Settings.tsx` (`getAppVersion()` parses `metadata.json`)
* **Core Tech Stack**:
  * **Frontend**: React 19 + TypeScript + Vite 6 + Tailwind CSS v4 + `motion/react` + `lucide-react` + `recharts`.
  * **Backend**: Node.js + Express (`server.ts`, run via `tsx server.ts` on port `3000`). Serves API routes (`/api/*`) and mounts Vite middleware in development or static `dist/` in production.
  * **Database & Auth**: Google Firebase (`firebase` JS SDK v12) with Firestore multi-tab IndexedDB persistence (`persistentLocalCache` + `persistentMultipleTabManager`) supplemented by local Dexie/SQLite caching (`src/lib/sqliteAdapter.ts`).
  * **Mobile Wrapper**: Capacitor 8 (`@capacitor/core`, `@capacitor/android`, `@capacitor-firebase/authentication`, `@capacitor/local-notifications`, `@capacitor/haptics`, `@capacitor/status-bar`).

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
   * `broadcast_notifications`: Real-time admin broadcast banner/push payload.
   * `ai_rpc_req_{id}`: Transient server-side Gemini RPC documents (created by client when direct HTTP is blocked on native APK, processed and deleted by `server.ts`).

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
  * Client (`src/lib/geminiApi.ts`) communicates exclusively with `server.ts` via `/api/gemini/chat-stream` (SSE), `/api/gemini/chat`, `/api/gemini/transcribe`, `/api/gemini/tts`, or the Firestore RPC fallback (`settings/ai_rpc_req_*`).
  * Supports bilingual (English + Bengali / Banglish) store intelligence, live inventory/profit context injection, and structured `<ACTION>{...}</ACTION>` tags (`CREATE_BILL`, `DELETE_BILL`, `ADD_PRODUCT`, `UPDATE_STOCK`, `UPDATE_PRICE`, `DELETE_PRODUCT`, `ADD_OTHER_COST`, `DELETE_OTHER_COST`).
* **`src/lib/utils.ts`**:
  * `MAX_BILL_AMOUNT = 10000`, `MAX_PRODUCT_STOCK = 2000`, `formatPrice()`.
  * `getBillCalendarIsoDate()`: Standard `00:00:00` midnight calendar boundary for bills (`YYYY-MM-DD`).
  * `getAppBusinessDate()` / `getAppBusinessIsoDate()`: 1:00 AM shift cutoff helper used in Analytics.
  * `showLocalNotification()`: Sequential, deduplicated notification queue supporting Capacitor `LocalNotifications`, native `AndroidExporter`, and Web Service Worker notifications.
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
* **`src/pages/Settings.tsx` (`/settings`)** & **`src/pages/PrivacyPolicy.tsx` (`/privacy-policy`)**:
  * Profile customization, theme toggle (Dark/Light/System), notification toggle, thermal printer connection manager, and Privacy Policy (with "Last Updated" date hardcoded to **`1/7/2026`**).

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
6. **100% Server-Side Gemini AI & Sub-2-Second Mobile Transport (`server.ts`, `src/lib/geminiApi.ts`, `AdminAIAssistant.tsx`)**:
   * `server.ts` uses `process.env.GEMINI_API_KEY` with `httpOptions: { headers: { "User-Agent": "aistudio-build" } }`.
   * **Active Models**: `PRIMARY_AI_MODEL = "gemini-3.1-flash-lite"` (~0.8s latency), `BACKUP_AI_MODEL = "gemini-3.8-flash"`, `TERTIARY_AI_MODEL = "gemini-flash-latest"`, with fast per-model failover so requests complete in ~1.1s.
   * **Strict Zero-Preset-Message Policy**: Never return preset or deterministic canned messages (such as `"Store Snapshot: X products in catalog..."`) when the user talks to Buzz AI. Every user message or command must be answered by the live Gemini AI (`server.ts` -> `/api/gemini/chat-stream`, `/api/gemini/chat`, or the server-side Firestore RPC listener `settings/ai_rpc_req_*`).
   * **Native Android / Installed Phone Transport (`shouldPreferFirestoreBridge()`)**: When installed as a native Android APK (`Capacitor.isNativePlatform()`), `https://localhost` cannot pass AI Studio Cloud Run session cookies to `*.run.app`. `src/lib/geminiApi.ts` immediately routes chat, streaming, voice transcription, and TTS requests through the real-time server-side Firestore RPC bridge (`settings/ai_rpc_req_*`) where `server.ts` streams live partial chunks (`status: "streaming", partialReply`) in ~1 second without waiting for cross-origin HTTP timeouts.
   * **Installed PWA Service Worker (`vite.config.ts`)**: `workbox` is configured with `navigateFallbackDenylist: [/^\/api\//, /^\/health/]` and `NetworkOnly` runtime caching for `/api/*` so installed phone PWAs never intercept or buffer `/api/gemini/chat-stream` SSE responses.
   * Note on Express SSE streaming in Node 20+: Always attach client-disconnect cleanup to `res.on("close", ...)` (checking `if (!res.writableEnded)`), **never** `req.on("close", ...)`, because `req` emits `"close"` as soon as `express.json()` finishes parsing the request body.
7. **Mobile Microphone, Native TTS & Native Printing (`AdminAIAssistant.tsx`, `MainActivity.java`, `printerManager.ts`)**:
   * **Android Microphone Hardware Lock**: On Android phones (`isMobileDevice`), never call `navigator.mediaDevices.getUserMedia()` concurrently with `SpeechRecognition` (`webkitSpeechRecognition`), because Android's audio HAL only allows one active audio capture client per app (`getUserMedia` locks the mic and causes `SpeechRecognition` to immediately fail). Use `getUserMedia` only on desktop or when recording via `MediaRecorder` fallback.
   * **Native Android Print Bridge**: `MainActivity.java` exposes `window.AndroidExporter.printHtml(jobName, htmlContent)` backed by Android's `PrintManager`, wired into `BillReceiptModal.tsx`, `Analytics.tsx`, and `printerManager.ts` so receipt and Z-Report printing work natively inside the installed Android APK.
8. **Edge-to-Edge Android Layout & App-Wide Spring Choreography**:
   * `MainActivity.java` sets `setDecorFitsSystemWindows(false)` and transparent status/navigation bars.
   * `App.tsx` applies `env(safe-area-inset-top)` padding, and `BottomNav.tsx` uses `bottom: calc(1.1rem + env(safe-area-inset-bottom))`.
   * Cohesive 60/120fps spring physics (`stiffness: 460–500, damping: 28–32, mass: 0.65–0.72`), blur-morphing sheet transitions, staggered list/field entrances, and tactile button micro-interactions (`whileHover`, `whileTap`, icon rotations) are implemented across `ProfileMenu.tsx`, `Products.tsx`, `AdminAIAssistant.tsx`, `BillReceiptModal.tsx`, `BottomNav.tsx`, `Home.tsx`, `Checkout.tsx`, `History.tsx`, `AllBills.tsx`, `OtherCosts.tsx`, `Account.tsx`, `Settings.tsx`, and `Admin.tsx`.


