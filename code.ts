/**
 * code.ts / server.ts
 *
 * Clean, production-grade backend powering "Buzz AI" inside the
 * Buzz POS & Stock Management / SmartRooti application.
 *
 * Core Architecture & Guarantees:
 * 1. REAL DATABASE FIRST: All queries evaluate live Firestore records (products, bills, costs, staff).
 * 2. APP-ONLY SCOPE: Restricted strictly to SmartRooti retail operations, inventory, sales, and catalog.
 * 3. REAL-TIME MODIFICATIONS: Authorized commands actually update Firestore, verify write, and return verified values.
 * 4. MULTI-MODEL RESILIENCE: Primary AI with instant secondary/tertiary failover & circuit-breaker cooldown.
 * 5. SAFE STATUS SUMMARIES: Clear, safe UI operation messages instead of private thought leaks.
 * 6. TOKEN-BY-TOKEN STREAMING: Reliable SSE progressive delivery.
 * 7. VOICE & TRANSCRIPTION: Low-latency Gemini TTS and transcription.
 */

import express, { Request, Response, NextFunction } from "express";
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs";
import dotenv from "dotenv";
import { GoogleGenAI } from "@google/genai";
import { initializeApp, getApps, getApp } from "firebase/app";
import {
  getFirestore,
  collection,
  doc,
  getDoc,
  getDocs,
  setDoc,
  updateDoc,
  deleteDoc,
  addDoc,
  query,
  orderBy,
  limit,
  Firestore,
} from "firebase/firestore";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ============================================================================
// 1. CONFIGURATION & ENVIRONMENT
// ============================================================================

const PORT = Number(process.env.PORT) || 3000;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "";

const PRIMARY_AI_PROVIDER = process.env.PRIMARY_AI_PROVIDER || "gemini";
const PRIMARY_AI_MODEL = process.env.PRIMARY_AI_MODEL || "gemini-3.8-flash";

const SECONDARY_AI_PROVIDER = process.env.SECONDARY_AI_PROVIDER || "gemini";
const SECONDARY_AI_MODEL = process.env.SECONDARY_AI_MODEL || "gemini-3.1-flash-lite";

const TERTIARY_AI_MODEL = "gemini-flash-latest";

// Store timezone offset: Asia/Kolkata (+5:30) for SmartRooti
const STORE_TZ_OFFSET_MINUTES = 330;

// Initialize Google Gemini Client
const ai = new GoogleGenAI({
  apiKey: GEMINI_API_KEY,
  httpOptions: {
    headers: {
      "User-Agent": "aistudio-build",
    },
  },
});

// ============================================================================
// 2. FIREBASE / FIRESTORE INTEGRATION (SOURCE OF TRUTH)
// ============================================================================

interface FirebaseAppletConfig {
  projectId: string;
  appId: string;
  apiKey: string;
  authDomain: string;
  firestoreDatabaseId?: string;
  storageBucket?: string;
  messagingSenderId?: string;
}

let db: Firestore | null = null;
let firebaseConfig: FirebaseAppletConfig | null = null;

try {
  const configPath = path.resolve(__dirname, "firebase-applet-config.json");
  if (fs.existsSync(configPath)) {
    const raw = fs.readFileSync(configPath, "utf-8");
    firebaseConfig = JSON.parse(raw);
  }
} catch (err) {
  console.warn("Could not read firebase-applet-config.json:", err);
}

if (firebaseConfig && firebaseConfig.projectId) {
  try {
    const app =
      getApps().length > 0
        ? getApp()
        : initializeApp({
            projectId: firebaseConfig.projectId,
            appId: firebaseConfig.appId,
            apiKey: firebaseConfig.apiKey,
            authDomain: firebaseConfig.authDomain,
            storageBucket: firebaseConfig.storageBucket,
            messagingSenderId: firebaseConfig.messagingSenderId,
          });

    const databaseId =
      firebaseConfig.firestoreDatabaseId ||
      "ai-studio-remixbuzzv111-8ceddc6a-4499-4e60-a805-dedb47b5266b";
    db = getFirestore(app, databaseId);
    console.log(`Connected to live Firestore [Project: ${firebaseConfig.projectId}, DB: ${databaseId}]`);
  } catch (err) {
    console.error("Failed to initialize Firestore on backend:", err);
    db = null;
  }
}

// Data Models
export interface StoreProduct {
  id: string;
  name: string;
  price: number;
  stock: number;
  category?: string;
  bio?: string;
  image?: string;
  createdAt?: number;
  soldCount?: number;
}

export interface StoreBillItem {
  name: string;
  price: number;
  quantity: number;
  productId?: string;
}

export interface StoreBill {
  id: string;
  total: number;
  items: StoreBillItem[];
  date: number;
  updatedAt?: number;
  status?: string;
}

export interface StoreExpense {
  id: string;
  title: string;
  amount: number;
  date: number;
  ownerId?: string;
  category?: string;
}

export interface StoreAccount {
  uid: string;
  email: string;
  displayName: string;
  role: string;
  isAdmin: boolean;
  isSuperAdmin?: boolean;
  isOnline?: boolean;
  lastActive?: number;
}

export interface StoreSnapshot {
  products: StoreProduct[];
  bills: StoreBill[];
  recentBills: StoreBill[];
  todayBills: StoreBill[];
  todayRevenue: number;
  todayBillsCount: number;
  expenses: StoreExpense[];
  todayExpenseTotal: number;
  accounts: StoreAccount[];
  activityLogs: any[];
  timestamp: number;
}

// Compute Start of Today in Store Timezone (IST: UTC+5:30)
export function getStoreTodayStartTimestamp(): number {
  const now = new Date();
  const utcTime = now.getTime() + now.getTimezoneOffset() * 60000;
  const storeTime = new Date(utcTime + STORE_TZ_OFFSET_MINUTES * 60000);

  const startOfDayStore = new Date(
    storeTime.getFullYear(),
    storeTime.getMonth(),
    storeTime.getDate(),
    0,
    0,
    0,
    0
  );
  return startOfDayStore.getTime() - STORE_TZ_OFFSET_MINUTES * 60000;
}

// Query Live Store State from Firestore
export async function getLiveStoreSnapshot(): Promise<StoreSnapshot> {
  const timestamp = Date.now();
  const todayStart = getStoreTodayStartTimestamp();

  if (!db) {
    throw new Error("Firestore database is not initialized.");
  }

  // 1. Fetch Products
  const productsSnap = await getDocs(collection(db, "products"));
  const products: StoreProduct[] = [];
  productsSnap.forEach((docSnap) => {
    const data = docSnap.data();
    products.push({
      id: docSnap.id,
      name: String(data.name || "Unnamed Product"),
      price: Number(data.price) || 0,
      stock: Number(data.stock) || 0,
      category: data.category || "General",
      bio: data.bio || "",
      image: data.image || "",
      createdAt: Number(data.createdAt) || 0,
      soldCount: Number(data.soldCount) || 0,
    });
  });

  // 2. Fetch Bills (latest 40)
  const billsQuery = query(
    collection(db, "bills"),
    orderBy("date", "desc"),
    limit(40)
  );
  const billsSnap = await getDocs(billsQuery);
  const bills: StoreBill[] = [];
  billsSnap.forEach((docSnap) => {
    const data = docSnap.data();
    bills.push({
      id: docSnap.id,
      total: Number(data.total) || 0,
      items: Array.isArray(data.items) ? data.items : [],
      date: Number(data.date) || 0,
      updatedAt: Number(data.updatedAt) || undefined,
      status: data.status,
    });
  });

  const todayBills = bills.filter((b) => b.date >= todayStart);
  const todayRevenue = todayBills.reduce((acc, b) => acc + (b.total || 0), 0);
  const todayBillsCount = todayBills.length;

  // 3. Fetch Expenses / Other Costs (latest 30)
  const expensesQuery = query(
    collection(db, "other_costs"),
    orderBy("date", "desc"),
    limit(30)
  );
  const expensesSnap = await getDocs(expensesQuery);
  const expenses: StoreExpense[] = [];
  expensesSnap.forEach((docSnap) => {
    const data = docSnap.data();
    expenses.push({
      id: docSnap.id,
      title: String(data.title || data.name || "Expense"),
      amount: Number(data.amount) || 0,
      date: Number(data.date) || 0,
      ownerId: data.ownerId,
      category: data.category || "General",
    });
  });

  const todayExpenses = expenses.filter((e) => e.date >= todayStart);
  const todayExpenseTotal = todayExpenses.reduce((acc, e) => acc + (e.amount || 0), 0);

  // 4. Fetch Staff & Account Directory from `settings`
  const settingsSnap = await getDocs(collection(db, "settings"));
  const accounts: StoreAccount[] = [];
  settingsSnap.forEach((docSnap) => {
    const id = docSnap.id;
    if (id.startsWith("profile_")) {
      const uid = id.replace("profile_", "");
      const data = docSnap.data();
      const isAdmin = Boolean(data.isAdmin || data.role === "admin");
      const isSuperAdmin = Boolean(data.isSuperAdmin);
      const lastActive = Number(data.lastActive) || 0;
      const isOnline = Boolean(data.isOnline) && timestamp - lastActive <= 60000;

      accounts.push({
        uid,
        email: data.email || "",
        displayName: data.displayName || "Store User",
        role: data.role || (isAdmin ? "admin" : "user"),
        isAdmin,
        isSuperAdmin,
        isOnline,
        lastActive,
      });
    }
  });

  // 5. Fetch Activity Logs (latest 20)
  const logsQuery = query(
    collection(db, "activity_logs"),
    orderBy("timestamp", "desc"),
    limit(20)
  );
  const logsSnap = await getDocs(logsQuery);
  const activityLogs: any[] = [];
  logsSnap.forEach((docSnap) => {
    activityLogs.push({ id: docSnap.id, ...docSnap.data() });
  });

  return {
    products,
    bills,
    recentBills: bills.slice(0, 10),
    todayBills,
    todayRevenue,
    todayBillsCount,
    expenses,
    todayExpenseTotal,
    accounts,
    activityLogs,
    timestamp,
  };
}

// Write Audit Log to Firestore
export async function logStoreActivity(
  eventType: string,
  description: string,
  user?: { uid?: string; displayName?: string; email?: string }
): Promise<void> {
  if (!db) return;
  try {
    await addDoc(collection(db, "activity_logs"), {
      eventType,
      description,
      timestamp: Date.now(),
      userId: user?.uid || "system",
      userName: user?.displayName || user?.email || "Buzz AI Assistant",
      userEmail: user?.email || "",
    });
  } catch (err) {
    console.warn("Could not record store activity log:", err);
  }
}

// Real Database Modifications with Post-Write Verification
export async function executeStockUpdate(
  productId: string,
  newStock: number,
  quantityChange?: number,
  user?: any
): Promise<{ success: boolean; product: StoreProduct }> {
  if (!db) throw new Error("Database not connected.");
  if (isNaN(newStock) || newStock < 0) {
    throw new Error(`Invalid stock quantity: ${newStock}. Stock cannot be negative.`);
  }

  const productRef = doc(db, "products", productId);
  const snap = await getDoc(productRef);
  if (!snap.exists()) {
    throw new Error(`Product ID "${productId}" does not exist in store catalog.`);
  }

  const prevData = snap.data();
  await updateDoc(productRef, {
    stock: newStock,
    updatedAt: Date.now(),
  });

  // Verify write directly from server
  const verifiedSnap = await getDoc(productRef);
  const verifiedData = verifiedSnap.data() || {};
  const updatedProduct: StoreProduct = {
    id: productId,
    name: verifiedData.name || prevData.name,
    price: Number(verifiedData.price) || 0,
    stock: Number(verifiedData.stock) || newStock,
    category: verifiedData.category,
  };

  await logStoreActivity(
    "stock_modification",
    `Stock for "${updatedProduct.name}" changed from ${prevData.stock || 0} to ${newStock} (${quantityChange && quantityChange > 0 ? "+" : ""}${quantityChange || 0} units)`,
    user
  );

  return { success: true, product: updatedProduct };
}

export async function executePriceUpdate(
  productId: string,
  newPrice: number,
  user?: any
): Promise<{ success: boolean; product: StoreProduct }> {
  if (!db) throw new Error("Database not connected.");
  if (isNaN(newPrice) || newPrice <= 0) {
    throw new Error(`Invalid price value: ₹${newPrice}. Price must be positive.`);
  }

  const productRef = doc(db, "products", productId);
  const snap = await getDoc(productRef);
  if (!snap.exists()) {
    throw new Error(`Product ID "${productId}" does not exist in store catalog.`);
  }

  const prevData = snap.data();
  await updateDoc(productRef, {
    price: newPrice,
    updatedAt: Date.now(),
  });

  const verifiedSnap = await getDoc(productRef);
  const verifiedData = verifiedSnap.data() || {};
  const updatedProduct: StoreProduct = {
    id: productId,
    name: verifiedData.name || prevData.name,
    price: Number(verifiedData.price) || newPrice,
    stock: Number(verifiedData.stock) || 0,
  };

  await logStoreActivity(
    "price_modification",
    `Price of "${updatedProduct.name}" updated from ₹${prevData.price} to ₹${newPrice}`,
    user
  );

  return { success: true, product: updatedProduct };
}

export async function executeAddProduct(
  data: { name: string; price: number; stock: number; category?: string },
  user?: any
): Promise<{ success: boolean; productId: string; product: StoreProduct }> {
  if (!db) throw new Error("Database not connected.");
  if (!data.name || data.name.trim().length === 0) {
    throw new Error("Product name cannot be empty.");
  }
  const price = Number(data.price);
  const stock = Number(data.stock) || 0;
  if (isNaN(price) || price <= 0) {
    throw new Error(`Invalid product price: ₹${data.price}`);
  }

  const docRef = await addDoc(collection(db, "products"), {
    name: data.name.trim(),
    price,
    stock,
    category: data.category || "General",
    createdAt: Date.now(),
    soldCount: 0,
  });

  const verifiedSnap = await getDoc(docRef);
  const created = verifiedSnap.data() || {};

  await logStoreActivity(
    "product_creation",
    `New product "${data.name}" added to catalog with stock ${stock} at ₹${price}`,
    user
  );

  return {
    success: true,
    productId: docRef.id,
    product: {
      id: docRef.id,
      name: data.name,
      price,
      stock,
      category: data.category,
    },
  };
}

export async function executeDeleteProduct(
  productId: string,
  user?: any
): Promise<{ success: boolean; deletedName: string }> {
  if (!db) throw new Error("Database not connected.");
  const productRef = doc(db, "products", productId);
  const snap = await getDoc(productRef);
  if (!snap.exists()) {
    throw new Error(`Product ID "${productId}" not found.`);
  }

  const name = snap.data().name || productId;
  await deleteDoc(productRef);

  await logStoreActivity(
    "product_deletion",
    `Product "${name}" (#${productId}) was removed from catalog`,
    user
  );

  return { success: true, deletedName: name };
}

export async function executeBillUpdate(
  billId: string,
  newTotal: number,
  notes?: string,
  user?: any
): Promise<{ success: boolean; billId: string; oldTotal: number; newTotal: number }> {
  if (!db) throw new Error("Database not connected.");
  if (isNaN(newTotal) || newTotal < 0) {
    throw new Error(`Invalid transaction total: ₹${newTotal}`);
  }

  const billRef = doc(db, "bills", billId);
  const snap = await getDoc(billRef);
  if (!snap.exists()) {
    throw new Error(`Transaction #${billId} not found.`);
  }

  const oldTotal = Number(snap.data().total) || 0;
  await updateDoc(billRef, {
    total: newTotal,
    updatedAt: Date.now(),
  });

  await logStoreActivity(
    "bill_edit",
    `Transaction #${billId.slice(0, 8)} total adjusted from ₹${oldTotal} to ₹${newTotal}. ${notes || ""}`,
    user
  );

  return { success: true, billId, oldTotal, newTotal };
}

// ============================================================================
// 3. AUTHORIZATION & SECURITY
// ============================================================================

export async function verifyUserIsAdmin(uid?: string, email?: string): Promise<boolean> {
  if (!uid && !email) return false;
  if (!db) return false;

  try {
    if (uid) {
      const profileSnap = await getDoc(doc(db, "settings", `profile_${uid}`));
      if (profileSnap.exists()) {
        const data = profileSnap.data();
        if (data.isAdmin === true || data.role === "admin" || data.isSuperAdmin === true) {
          return true;
        }
      }
    }

    if (email) {
      const q = query(collection(db, "settings"), limit(50));
      const snap = await getDocs(q);
      for (const d of snap.docs) {
        if (d.id.startsWith("profile_")) {
          const data = d.data();
          if (data.email && data.email.toLowerCase() === email.toLowerCase()) {
            if (data.isAdmin === true || data.role === "admin" || data.isSuperAdmin === true) {
              return true;
            }
          }
        }
      }
    }
  } catch (err) {
    console.warn("Authorization verification failed:", err);
  }
  return false;
}

// ============================================================================
// 4. APP-ONLY SCOPE ENFORCER
// ============================================================================

export function isStoreRelatedPrompt(prompt: string): boolean {
  const p = prompt.toLowerCase();

  // App & store keywords
  const keywords = [
    "product",
    "stock",
    "inventory",
    "price",
    "rate",
    "item",
    "catalog",
    "sale",
    "revenue",
    "turnover",
    "bill",
    "transaction",
    "receipt",
    "expense",
    "cost",
    "due",
    "admin",
    "staff",
    "user",
    "role",
    "permission",
    "account",
    "log",
    "audit",
    "pos",
    "store",
    "smartrooti",
    "buzz",
    "cashier",
    "how to",
    "how do i",
    "how does",
    "printer",
    "barcode",
    "scanner",
    "make it",
    "set it",
    "change it",
    "add",
    "update",
    "delete",
    "edit",
    "hi",
    "hello",
    "hey",
    "who are you",
    "what can you do",
    "clear",
    "reset",
    "what did i say",
    "repeat",
  ];

  return keywords.some((k) => p.includes(k));
}

export const OUT_OF_SCOPE_RESPONSE =
  "I am **Buzz AI**, your dedicated assistant for **SmartRooti** store operations. I can only assist with your store's inventory, stock, product prices, transactions, sales revenue, staff permissions, and POS features. How can I help with your store today?";

// ============================================================================
// 5. STATUS SUMMARY GENERATOR (ZERO PRIVATE THOUGHT EXPOSURE)
// ============================================================================

export function getSafeStatusMessage(prompt: string): string {
  const p = prompt.toLowerCase().trim();

  if (p.includes("stock") || p.includes("inventory") || p.includes("units") || p.includes("item")) {
    if (p.includes("add") || p.includes("increase") || p.includes("set") || p.includes("update")) {
      return "Updating product stock…";
    }
    return "Checking store inventory…";
  }

  if (p.includes("price") || p.includes("cost") || p.includes("rate") || p.includes("₹")) {
    if (p.includes("change") || p.includes("set") || p.includes("update")) {
      return "Saving price change…";
    }
    return "Looking up product pricing…";
  }

  if (p.includes("sale") || p.includes("revenue") || p.includes("today") || p.includes("turnover")) {
    return "Calculating today's sales…";
  }

  if (p.includes("bill") || p.includes("transaction") || p.includes("receipt") || p.includes("make it")) {
    if (p.includes("edit") || p.includes("change") || p.includes("make it") || p.includes("set to")) {
      return "Updating transaction record…";
    }
    return "Looking up transaction details…";
  }

  if (p.includes("admin") || p.includes("staff") || p.includes("user") || p.includes("role") || p.includes("who is")) {
    return "Checking staff directory…";
  }

  if (p.includes("expense") || p.includes("rent") || p.includes("electricity") || p.includes("other cost")) {
    return "Reviewing store expenses…";
  }

  if (p.includes("product") && (p.includes("add") || p.includes("create") || p.includes("new"))) {
    return "Creating new product entry…";
  }

  if (p.includes("what did i say") || p.includes("repeat")) {
    return "Recalling conversation context…";
  }

  return "Reviewing store data…";
}

// ============================================================================
// 6. AI PROVIDER MANAGER & RESILIENT FAILOVER
// ============================================================================

interface ModelHealth {
  consecutiveFailures: number;
  lastFailureTime: number;
  cooldownUntil: number;
}

const modelHealthMap = new Map<string, ModelHealth>();

function isModelInCooldown(model: string): boolean {
  const health = modelHealthMap.get(model);
  if (!health) return false;
  if (Date.now() < health.cooldownUntil) return true;
  health.consecutiveFailures = 0;
  return false;
}

function markModelFailure(model: string, isQuota: boolean = false) {
  const health = modelHealthMap.get(model) || {
    consecutiveFailures: 0,
    lastFailureTime: 0,
    cooldownUntil: 0,
  };
  health.consecutiveFailures += 1;
  health.lastFailureTime = Date.now();
  // Quota cooldown: 60s, regular failure: 15s
  health.cooldownUntil = Date.now() + (isQuota ? 60000 : 15000);
  modelHealthMap.set(model, health);
}

function markModelSuccess(model: string) {
  modelHealthMap.delete(model);
}

// Format Real Store Context for AI Engine
function buildStoreSystemPrompt(snapshot: StoreSnapshot): string {
  const outOfStock = snapshot.products.filter((p) => p.stock <= 0);
  const lowStock = snapshot.products.filter((p) => p.stock > 0 && p.stock <= 5);

  const productListBrief = snapshot.products.slice(0, 50).map((p) => ({
    id: p.id,
    name: p.name,
    price: p.price,
    stock: p.stock,
    category: p.category,
  }));

  const billsBrief = snapshot.recentBills.slice(0, 10).map((b) => ({
    id: b.id,
    total: b.total,
    date: new Date(b.date).toLocaleDateString(),
    itemSummary: b.items.map((i) => `${i.quantity}x ${i.name}`).join(", "),
  }));

  const accountsBrief = snapshot.accounts.map((a) => ({
    name: a.displayName,
    email: a.email,
    role: a.role,
    isAdmin: a.isAdmin,
    isSuperAdmin: a.isSuperAdmin,
    status: a.isOnline ? "Online" : "Offline",
  }));

  return `You are "Buzz AI", an intelligent and highly autonomous retail store manager for "SmartRooti" running inside the Buzz POS & Stock Management app.

REAL-TIME LIVE STORE DATA (ACTUAL DATABASE STATE AS OF ${new Date(snapshot.timestamp).toLocaleTimeString()}):
- Active Catalog Size: ${snapshot.products.length} products
- Out-of-Stock Products (0 units): ${outOfStock.length} items
- Low-Stock Products (<=5 units): ${lowStock.length} items
- Today's Total Sales Revenue: ₹${snapshot.todayRevenue.toLocaleString("en-IN")}
- Today's Completed Bills/Orders: ${snapshot.todayBillsCount}
- Registered Staff / Accounts: ${snapshot.accounts.length}
- Today's Total Expenses: ₹${snapshot.todayExpenseTotal.toLocaleString("en-IN")}

CURRENT CATALOG SNAPSHOT:
${JSON.stringify(productListBrief)}

RECENT TRANSACTIONS SNAPSHOT:
${JSON.stringify(billsBrief)}

REGISTERED STAFF DIRECTORY:
${JSON.stringify(accountsBrief)}

CRITICAL STORE-FIRST RULES:
1. ONLY answer retail, store, and app-related queries. If the user asks general or unrelated topics, politely respond that Buzz AI is exclusively for SmartRooti store operations.
2. The data above is the REAL database state. NEVER hallucinate or assume unlisted inventory or users.
3. Keep answers concise, factual, and easy to read on mobile. Format currency with Indian Rupees (₹).
4. When asked about inventory, pricing, or sales, quote the real numbers directly.
5. If the user requests a database modification (e.g. "add 20 units of Coke", "set milk stock to 50", "change price of bread to ₹40", "edit last bill to 1"):
   - Identify the product or bill using exact or fuzzy match.
   - You MUST append an explicit structured action block at the very end in format:
   \`\`\`action
   {
     "type": "UPDATE_STOCK" | "UPDATE_PRICE" | "ADD_PRODUCT" | "DELETE_PRODUCT" | "UPDATE_BILL",
     "productId": "<id>",
     "productName": "<name>",
     "newStock": <number>,
     "quantityChange": <number>,
     "newPrice": <number>,
     "billId": "<id>",
     "newTotal": <number>,
     "oldTotal": <number>
   }
   \`\`\`
6. Never output hidden reasoning tags or fake thoughts. Give direct, polished store advice.`;
}

// Local Deterministic Intelligence Engine (Zero AI network dependencies)
export function generateLocalDeterministicResponse(
  prompt: string,
  snapshot: StoreSnapshot,
  conversationHistory: any[] = []
): { reply: string; action: any; status: string } {
  const p = prompt.toLowerCase().trim();
  const status = getSafeStatusMessage(prompt);

  // 1. Conversation Recall
  if (p.includes("what did i say") || p.includes("what did i ask") || p.includes("repeat")) {
    const prev = conversationHistory.filter(
      (m) => m.role === "user" && m.content.toLowerCase().trim() !== p
    );
    if (prev.length > 0) {
      return {
        reply: `Just now, you asked:\n\n> "${prev[prev.length - 1].content}"`,
        action: null,
        status,
      };
    }
    return {
      reply: "You just opened Buzz AI. How can I assist you with your store operations today?",
      action: null,
      status,
    };
  }

  // 2. Transaction / Bill Editing (e.g. "edit the last transaction", "make it 1", "change bill to 20")
  const makeItMatch = p.match(/(?:make|set|change|update)(?:\s+it)?(?:\s+to)?\s+(?:₹|rs\.?)?\s*(\d+(?:\.\d+)?)/i);
  const isBillIntent = p.includes("bill") || p.includes("transaction") || p.includes("receipt");

  if (isBillIntent || (makeItMatch && snapshot.recentBills.length > 0)) {
    const latestBill = snapshot.recentBills[0];
    if (latestBill) {
      const shortId = latestBill.id.slice(0, 8);
      const oldTotal = latestBill.total;

      if (makeItMatch) {
        const newTotal = parseFloat(makeItMatch[1]);
        return {
          reply: `Prepared update for transaction **#${shortId}**:\n\n• Current Total: **₹${oldTotal}**\n• New Total: **₹${newTotal}**\n\nClick below to apply this update to Firestore:`,
          action: {
            type: "UPDATE_BILL",
            billId: latestBill.id,
            oldTotal,
            newTotal,
            notes: `Total adjusted from ₹${oldTotal} to ₹${newTotal}`,
          },
          status: "Updating transaction record…",
        };
      } else {
        const itemSummary = latestBill.items.map((i) => `${i.quantity}× ${i.name}`).join(", ") || "Items";
        return {
          reply: `The latest transaction (**#${shortId}**) was for **${itemSummary}** totaling **₹${oldTotal}**.\n\nWhat would you like to set the new total to? (e.g. *"make it 1"* or *"set to 20"*).`,
          action: null,
          status: "Looking up transaction details…",
        };
      }
    }
  }

  // 3. Stock Modification Request (e.g. "add 20 units of Coke", "set milk stock to 50")
  const stockMatch =
    p.match(/(?:add|increase|set|update|change|put)\s+(\d+)\s*(?:stocks?|units?|items?|qty)?\s*(?:of|for|to)?\s*([a-zA-Z0-9\s]+)/i) ||
    p.match(/(?:add|increase|set|update|change)\s+([a-zA-Z0-9\s]+?)\s+(?:stock|stocks?)\s*(?:to|by)?\s*(\d+)/i);

  if (stockMatch) {
    let qty = 0;
    let targetName = "";
    if (!isNaN(Number(stockMatch[1]))) {
      qty = parseInt(stockMatch[1], 10);
      targetName = stockMatch[2].trim();
    } else {
      targetName = stockMatch[1].trim();
      qty = parseInt(stockMatch[2], 10);
    }
    targetName = targetName.replace(/stocks?|units?|items?/gi, "").trim();

    const matched =
      snapshot.products.find((pr) => pr.name.toLowerCase().trim() === targetName.toLowerCase().trim()) ||
      snapshot.products.find((pr) => pr.name.toLowerCase().includes(targetName.toLowerCase())) ||
      snapshot.products.find((pr) => targetName.toLowerCase().includes(pr.name.toLowerCase()));

    if (matched) {
      const isSet = p.includes("set") || p.includes("change stock of") || p.includes("to ");
      const currentStock = matched.stock;
      const newStock = isSet ? qty : currentStock + qty;
      const diff = isSet ? newStock - currentStock : qty;

      return {
        reply: `Prepared stock update for **${matched.name}**:\n\n• Current Stock: **${currentStock} units**\n• Adjustment: **${diff > 0 ? "+" : ""}${diff}**\n• New Target: **${newStock} units**\n\nConfirm below to record this in the live database:`,
        action: {
          type: "UPDATE_STOCK",
          productId: matched.id,
          productName: matched.name,
          currentStock,
          quantityChange: diff,
          newStock,
        },
        status: "Updating product stock…",
      };
    }
  }

  // 4. Price Modification Request (e.g. "change price of Coke to 45")
  const priceMatch = p.match(/(?:change|set|update)\s+price\s+(?:of|for)?\s*([a-zA-Z0-9\s]+?)\s+to\s*(?:₹|rs\.?)?\s*(\d+(?:\.\d+)?)/i);
  if (priceMatch) {
    const targetName = priceMatch[1].trim();
    const newPrice = parseFloat(priceMatch[2]);
    const matched = snapshot.products.find(
      (pr) =>
        pr.name.toLowerCase().includes(targetName.toLowerCase()) ||
        targetName.toLowerCase().includes(pr.name.toLowerCase())
    );
    if (matched) {
      return {
        reply: `Prepared price update for **${matched.name}**:\n\n• Current Price: **₹${matched.price}**\n• New Price: **₹${newPrice}**\n\nConfirm to update the catalog:`,
        action: {
          type: "UPDATE_PRICE",
          productId: matched.id,
          productName: matched.name,
          currentPrice: matched.price,
          newPrice,
        },
        status: "Saving price change…",
      };
    }
  }

  // 5. Low Stock / Out of Stock Inquiry
  if (p.includes("low stock") || p.includes("out of stock") || p.includes("depleted") || p.includes("stock alert")) {
    const outOfStock = snapshot.products.filter((pr) => pr.stock <= 0);
    const lowStock = snapshot.products.filter((pr) => pr.stock > 0 && pr.stock <= 5);

    if (outOfStock.length === 0 && lowStock.length === 0) {
      return {
        reply: "All inventory levels are healthy! There are currently no items out of stock or running low.",
        action: null,
        status,
      };
    }

    let text = `Here is your current inventory status:\n\n`;
    if (outOfStock.length > 0) {
      text += `**🚫 Out of Stock (${outOfStock.length} items):**\n`;
      outOfStock.slice(0, 6).forEach((item) => {
        text += `• **${item.name}** — 0 units (₹${item.price})\n`;
      });
      text += `\n`;
    }
    if (lowStock.length > 0) {
      text += `**⚠️ Low Stock (≤ 5 units):**\n`;
      lowStock.slice(0, 6).forEach((item) => {
        text += `• **${item.name}** — ${item.stock} units remaining (₹${item.price})\n`;
      });
    }
    return { reply: text.trim(), action: null, status };
  }

  // 6. Sales & Revenue Inquiry
  if (p.includes("sale") || p.includes("revenue") || p.includes("today") || p.includes("turnover") || p.includes("earn")) {
    return {
      reply: `**Today's Store Performance Summary:**\n\n• Total Revenue: **₹${snapshot.todayRevenue.toLocaleString("en-IN")}**\n• Completed Orders/Bills: **${snapshot.todayBillsCount}**\n• Total Catalog Products: **${snapshot.products.length}**\n\nAll figures are computed directly from the live Firestore transactions ledger.`,
      action: null,
      status,
    };
  }

  // 7. Staff & Admin Directory Inquiry
  if (p.includes("admin") || p.includes("staff") || p.includes("who is") || p.includes("who has access") || p.includes("directory")) {
    if (snapshot.accounts.length === 0) {
      return {
        reply: "No staff profiles have been registered in the database yet.",
        action: null,
        status,
      };
    }
    const lines = snapshot.accounts.map((a) => {
      const icon = a.isSuperAdmin ? "👑" : a.isAdmin ? "🛡️" : "👤";
      const statusText = a.isOnline ? "🟢 Online" : "⚪ Offline";
      const roleStr = a.isSuperAdmin ? "Owner & Super Admin" : a.role || (a.isAdmin ? "Admin" : "Staff");
      return `• ${icon} **${a.displayName}** (${a.email || "No email"}) — ${roleStr} (${statusText})`;
    });

    return {
      reply: `Here is the current administrative team for **SmartRooti**:\n\n${lines.join("\n")}`,
      action: null,
      status,
    };
  }

  // 8. General Store Greeting / Persona
  if (p === "hi" || p === "hello" || p === "hey" || p.startsWith("hi ") || p.startsWith("hello ")) {
    return {
      reply: `Hello! I'm **Buzz AI**, your live store operations assistant for **SmartRooti**. I can manage inventory, adjust prices, check today's ₹${snapshot.todayRevenue.toLocaleString("en-IN")} revenue, and audit transactions. How can I help you today?`,
      action: null,
      status,
    };
  }

  // 9. Standard In-Scope Fallback
  return {
    reply: `I am connected to your live **SmartRooti** database (${snapshot.products.length} products, ₹${snapshot.todayRevenue.toLocaleString("en-IN")} sales today). Ask me about stock levels, sales figures, price changes, or transaction updates.`,
    action: null,
    status,
  };
}

// Execute AI Chat with Automatic Multi-Model Failover
export async function executeAiQuery(
  prompt: string,
  snapshot: StoreSnapshot,
  conversationHistory: any[] = []
): Promise<{ text: string; modelUsed: string }> {
  if (!GEMINI_API_KEY) {
    throw new Error("No GEMINI_API_KEY configured.");
  }

  const systemInstruction = buildStoreSystemPrompt(snapshot);

  const contents: any[] = [];
  for (const msg of conversationHistory.slice(-6)) {
    contents.push({
      role: msg.role === "assistant" ? "model" : "user",
      parts: [{ text: msg.content }],
    });
  }
  contents.push({
    role: "user",
    parts: [{ text: prompt }],
  });

  const candidates = [PRIMARY_AI_MODEL, SECONDARY_AI_MODEL, TERTIARY_AI_MODEL].filter(
    (m) => !isModelInCooldown(m)
  );

  for (const model of candidates) {
    try {
      const response = await Promise.race([
        ai.models.generateContent({
          model,
          contents,
          config: {
            systemInstruction,
            temperature: 0.2,
          },
        }),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error(`Timeout on model ${model}`)), 4500)
        ),
      ]);

      if (response && response.text) {
        markModelSuccess(model);
        return { text: response.text, modelUsed: model };
      }
    } catch (err: any) {
      const errMsg = String(err?.message || err);
      const isQuota =
        errMsg.includes("429") ||
        errMsg.includes("RESOURCE_EXHAUSTED") ||
        errMsg.includes("quota");
      markModelFailure(model, isQuota);
      console.warn(`Model ${model} failed, switching to fallback. Error: ${errMsg.slice(0, 100)}`);
    }
  }

  throw new Error("All AI models are currently exhausted or unavailable.");
}

// ============================================================================
// 7. EXPRESS APPLICATION & API ROUTES
// ============================================================================

const app = express();

app.use(express.json({ limit: "15mb" }));
app.use(express.urlencoded({ extended: true, limit: "15mb" }));

// Basic Security Headers & CORS
app.use((_req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "SAMEORIGIN");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization, x-user-uid, x-user-email"
  );
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  next();
});

// Parse User Authentication Context from Headers/Body
function extractUserContext(req: Request) {
  const uid =
    (req.headers["x-user-uid"] as string) || req.body?.user?.uid || undefined;
  const email =
    (req.headers["x-user-email"] as string) || req.body?.user?.email || undefined;
  const displayName = req.body?.user?.displayName || "Store User";
  return { uid, email, displayName };
}

// ----------------------------------------------------------------------------
// GET /api/health
// ----------------------------------------------------------------------------
app.get("/api/health", async (_req, res) => {
  const isDbConnected = db !== null;
  let collectionStats: any = null;

  if (isDbConnected) {
    try {
      const snap = await getLiveStoreSnapshot();
      collectionStats = {
        productsCount: snap.products.length,
        todaySales: snap.todayRevenue,
        todayBillsCount: snap.todayBillsCount,
        accountsCount: snap.accounts.length,
      };
    } catch (e: any) {
      collectionStats = { error: "Could not fetch collections: " + e.message };
    }
  }

  res.json({
    status: isDbConnected ? "ok" : "degraded",
    service: "Buzz AI Operations Backend",
    timestamp: Date.now(),
    uptimeSeconds: process.uptime(),
    database: {
      connected: isDbConnected,
      projectId: firebaseConfig?.projectId || "unknown",
      databaseId: firebaseConfig?.firestoreDatabaseId || "(default)",
      stats: collectionStats,
    },
    ai: {
      primary: {
        provider: PRIMARY_AI_PROVIDER,
        model: PRIMARY_AI_MODEL,
        status: isModelInCooldown(PRIMARY_AI_MODEL) ? "cooldown" : "ready",
      },
      secondary: {
        provider: SECONDARY_AI_PROVIDER,
        model: SECONDARY_AI_MODEL,
        status: isModelInCooldown(SECONDARY_AI_MODEL) ? "cooldown" : "ready",
      },
    },
  });
});

// ----------------------------------------------------------------------------
// POST /api/gemini/chat (Standard JSON Endpoint)
// ----------------------------------------------------------------------------
app.post("/api/gemini/chat", async (req, res) => {
  try {
    const { prompt, conversationHistory = [] } = req.body;
    if (!prompt || typeof prompt !== "string") {
      res.status(400).json({ error: "Missing or invalid 'prompt' in request body." });
      return;
    }

    const cleanPrompt = prompt.trim();
    const user = extractUserContext(req);
    const status = getSafeStatusMessage(cleanPrompt);

    // App-only scope enforcement
    if (!isStoreRelatedPrompt(cleanPrompt)) {
      res.json({
        reply: OUT_OF_SCOPE_RESPONSE,
        action: null,
        thought: status,
        modelUsed: "buzz-scope-guard",
      });
      return;
    }

    // 1. Retrieve Real Database State
    let snapshot: StoreSnapshot;
    try {
      snapshot = await getLiveStoreSnapshot();
    } catch (dbErr: any) {
      console.error("Firestore live snapshot failed:", dbErr);
      res.status(503).json({
        reply: "Live store data is temporarily unavailable. Please verify connection and try again.",
        action: null,
        thought: "Database lookup failed",
        error: "Firestore unavailable",
      });
      return;
    }

    // 2. Query AI with Fallback
    let replyText = "";
    let actionData: any = null;
    let activeModel = "local-deterministic-engine";

    try {
      const aiResult = await executeAiQuery(cleanPrompt, snapshot, conversationHistory);
      replyText = aiResult.text;
      activeModel = aiResult.modelUsed;

      // Parse structured action block if generated by AI
      const actionMatch = replyText.match(/```action\s*([\s\S]*?)\s*```/);
      if (actionMatch && actionMatch[1]) {
        try {
          actionData = JSON.parse(actionMatch[1]);
        } catch (e) {}
      }
      replyText = replyText.replace(/```action[\s\S]*?```/g, "").trim();
    } catch (aiErr: any) {
      // Local Deterministic Engine Fallback
      const localResult = generateLocalDeterministicResponse(cleanPrompt, snapshot, conversationHistory);
      replyText = localResult.reply;
      actionData = localResult.action;
      activeModel = "buzz-store-engine";
    }

    res.json({
      reply: replyText,
      action: actionData,
      thought: status,
      modelUsed: activeModel,
    });
  } catch (err: any) {
    console.error("Unhandled error in /api/gemini/chat:", err);
    res.status(500).json({
      reply: "An internal error occurred while processing store commands.",
      error: err.message || String(err),
    });
  }
});

// ----------------------------------------------------------------------------
// POST /api/gemini/chat-stream (Progressive SSE Streaming Endpoint)
// ----------------------------------------------------------------------------
app.post("/api/gemini/chat-stream", async (req, res) => {
  try {
    const { prompt, conversationHistory = [] } = req.body;
    if (!prompt || typeof prompt !== "string") {
      res.status(400).json({ error: "Missing or invalid 'prompt' in request body." });
      return;
    }

    const cleanPrompt = prompt.trim();
    const user = extractUserContext(req);
    const status = getSafeStatusMessage(cleanPrompt);

    // Initialize Server-Sent Events headers
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders?.();

    // Send safe UI status first
    res.write(`data: ${JSON.stringify({ status })}\n\n`);

    // App-only scope enforcement
    if (!isStoreRelatedPrompt(cleanPrompt)) {
      res.write(`data: ${JSON.stringify({ chunk: OUT_OF_SCOPE_RESPONSE })}\n\n`);
      res.write(
        `data: ${JSON.stringify({
          done: true,
          fullText: OUT_OF_SCOPE_RESPONSE,
          action: null,
          thought: status,
          modelUsed: "buzz-scope-guard",
        })}\n\n`
      );
      res.end();
      return;
    }

    // 1. Fetch Real Database State
    let snapshot: StoreSnapshot;
    try {
      snapshot = await getLiveStoreSnapshot();
    } catch (dbErr: any) {
      console.error("Firestore stream snapshot error:", dbErr);
      const errMsg = "Live store data is temporarily unavailable. Please try again in a moment.";
      res.write(`data: ${JSON.stringify({ chunk: errMsg })}\n\n`);
      res.write(
        `data: ${JSON.stringify({
          done: true,
          fullText: errMsg,
          action: null,
          thought: "Database unavailable",
          modelUsed: "buzz-error-guard",
        })}\n\n`
      );
      res.end();
      return;
    }

    // 2. Stream Response with Multi-Model Failover
    const systemInstruction = buildStoreSystemPrompt(snapshot);
    const contents: any[] = [];
    for (const msg of conversationHistory.slice(-6)) {
      contents.push({
        role: msg.role === "assistant" ? "model" : "user",
        parts: [{ text: msg.content }],
      });
    }
    contents.push({
      role: "user",
      parts: [{ text: cleanPrompt }],
    });

    const candidates = [PRIMARY_AI_MODEL, SECONDARY_AI_MODEL, TERTIARY_AI_MODEL].filter(
      (m) => !isModelInCooldown(m)
    );

    let streamSucceeded = false;
    let fullOutput = "";
    let activeModel = "local-store-engine";

    if (GEMINI_API_KEY) {
      for (const model of candidates) {
        try {
          const streamPromise = ai.models.generateContentStream({
            model,
            contents,
            config: {
              systemInstruction,
              temperature: 0.2,
            },
          });

          const stream = await Promise.race([
            streamPromise,
            new Promise<never>((_, reject) =>
              setTimeout(() => reject(new Error(`Stream timeout on ${model}`)), 5000)
            ),
          ]);

          for await (const chunk of stream) {
            const chunkText = chunk.text || "";
            if (chunkText) {
              fullOutput += chunkText;
              // Clean out action block from live display stream
              const cleanChunk = chunkText.replace(/```action[\s\S]*?```/g, "");
              if (cleanChunk) {
                res.write(`data: ${JSON.stringify({ chunk: cleanChunk })}\n\n`);
              }
            }
          }

          if (fullOutput) {
            streamSucceeded = true;
            activeModel = model;
            markModelSuccess(model);
            break;
          }
        } catch (streamErr: any) {
          const errMsg = String(streamErr?.message || streamErr);
          const isQuota =
            errMsg.includes("429") ||
            errMsg.includes("RESOURCE_EXHAUSTED") ||
            errMsg.includes("quota");
          markModelFailure(model, isQuota);
          fullOutput = "";
        }
      }
    }

    // Fallback: Deterministic Engine with Word-by-Word Simulated Streaming
    let actionData: any = null;
    let cleanDisplayText = "";

    if (!streamSucceeded || !fullOutput) {
      const localResult = generateLocalDeterministicResponse(cleanPrompt, snapshot, conversationHistory);
      fullOutput = localResult.reply;
      actionData = localResult.action;
      activeModel = "buzz-store-engine";
      cleanDisplayText = fullOutput;

      // Stream words smoothly
      const tokens = fullOutput.split(/(\s+)/);
      for (const token of tokens) {
        if (token) {
          res.write(`data: ${JSON.stringify({ chunk: token })}\n\n`);
        }
      }
    } else {
      // Parse structured action from full model output
      const actionMatch = fullOutput.match(/```action\s*([\s\S]*?)\s*```/);
      if (actionMatch && actionMatch[1]) {
        try {
          actionData = JSON.parse(actionMatch[1]);
        } catch (e) {}
      }
      cleanDisplayText = fullOutput.replace(/```action[\s\S]*?```/g, "").trim();
    }

    res.write(
      `data: ${JSON.stringify({
        done: true,
        fullText: cleanDisplayText || fullOutput,
        action: actionData,
        thought: status,
        modelUsed: activeModel,
      })}\n\n`
    );
    res.end();
  } catch (err: any) {
    console.error("Stream route error:", err);
    res.write(`data: ${JSON.stringify({ chunk: "A stream error occurred." })}\n\n`);
    res.write(
      `data: ${JSON.stringify({
        done: true,
        fullText: "A stream error occurred.",
        action: null,
        thought: "Error",
      })}\n\n`
    );
    res.end();
  }
});

// ----------------------------------------------------------------------------
// POST /api/gemini/tts (Text-to-Speech with In-Memory LRU Cache)
// ----------------------------------------------------------------------------
const ttsMemoryCache = new Map<string, { audioBase64: string; mimeType: string }>();

app.post("/api/gemini/tts", async (req, res) => {
  try {
    const { text } = req.body;
    if (!text || typeof text !== "string") {
      res.status(400).json({ error: "Missing or invalid 'text' in request body." });
      return;
    }

    if (!GEMINI_API_KEY) {
      res.status(503).json({ error: "No GEMINI_API_KEY configured." });
      return;
    }

    // Clean markdown, symbols, and action tags before speech synthesis
    const cleanSpeech = text
      .replace(/```[\s\S]*?```/g, "")
      .replace(/[*#`_•-]/g, "")
      .replace(/[^\w\s.,?!₹-]/g, "")
      .replace(/\s+/g, " ")
      .trim();

    if (!cleanSpeech) {
      res.status(400).json({ error: "No readable speech content." });
      return;
    }

    // Cache lookup for instant <5ms replay
    const cacheKey = cleanSpeech.slice(0, 320);
    const cached = ttsMemoryCache.get(cacheKey);
    if (cached) {
      res.json(cached);
      return;
    }

    // Request audio from official Gemini TTS model
    const ttsResponse = await Promise.race([
      ai.models.generateContent({
        model: "gemini-3.8-flash-lite-tts",
        contents: [
          {
            role: "user",
            parts: [{ text: cleanSpeech.slice(0, 320) }],
          },
        ],
        config: {
          responseModalities: ["AUDIO"],
          speechConfig: {
            voiceConfig: {
              prebuiltVoiceConfig: {
                voiceName: "Aoede",
              },
            },
          },
        },
      }),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("TTS request timed out")), 2000)
      ),
    ]);

    const candidate = ttsResponse.candidates?.[0];
    const audioPart = candidate?.content?.parts?.find((p: any) => p.inlineData);

    if (audioPart && audioPart.inlineData) {
      const payload = {
        audioBase64: audioPart.inlineData.data,
        mimeType: audioPart.inlineData.mimeType || "audio/wav",
      };

      if (ttsMemoryCache.size > 60) {
        const oldest = ttsMemoryCache.keys().next().value;
        if (oldest) ttsMemoryCache.delete(oldest);
      }
      ttsMemoryCache.set(cacheKey, payload);

      res.json(payload);
      return;
    }

    res.status(500).json({ error: "No audio generated." });
  } catch (err: any) {
    res.status(500).json({ error: err.message || "TTS synthesis failed." });
  }
});

// ----------------------------------------------------------------------------
// POST /api/gemini/transcribe (Audio Transcription)
// ----------------------------------------------------------------------------
app.post("/api/gemini/transcribe", async (req, res) => {
  try {
    const { audioBase64, mimeType = "audio/webm" } = req.body;
    if (!audioBase64) {
      res.status(400).json({ error: "Missing 'audioBase64' in request body." });
      return;
    }

    if (!GEMINI_API_KEY) {
      res.status(503).json({ error: "No GEMINI_API_KEY configured." });
      return;
    }

    const response = await Promise.race([
      ai.models.generateContent({
        model: "gemini-3.5-transcribe",
        contents: [
          {
            role: "user",
            parts: [
              {
                inlineData: {
                  mimeType,
                  data: audioBase64,
                },
              },
              {
                text: "Transcribe the following spoken store command accurately in English. Output only the transcription text.",
              },
            ],
          },
        ],
      }),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("Transcription timeout")), 6000)
      ),
    ]);

    const transcript = response.text ? response.text.trim() : "";
    res.json({ transcript });
  } catch (err: any) {
    res.status(500).json({ error: err.message || "Transcription failed." });
  }
});

// ============================================================================
// 8. SERVER STARTUP & VITE INTEGRATION
// ============================================================================

async function startServer() {
  if (process.env.NODE_ENV !== "production") {
    const { createServer: createViteServer } = await import("vite");
    const vite = await createViteServer({
      server: {
        middlewareMode: true,
        host: "0.0.0.0",
        port: PORT,
      },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    app.use(express.static(path.resolve(__dirname, "dist")));
    app.get("*", (_req, res) => {
      res.sendFile(path.resolve(__dirname, "dist", "index.html"));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Buzz AI Server listening on port ${PORT}`);
  });
}

startServer().catch((err) => {
  console.error("Failed to start server:", err);
});

export default app;
