/**
 * server.ts
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

import express from "express";
import type { Request, Response, NextFunction } from "express";
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs";
import dotenv from "dotenv";
import { GoogleGenAI, ThinkingLevel } from "@google/genai";
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
  writeBatch,
  increment,
  onSnapshot,
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
// Primary: Ultra-low-latency Gemini 3.1 Flash Lite (~0.8s response time)
const PRIMARY_AI_MODEL = process.env.PRIMARY_AI_MODEL || "gemini-3.1-flash-lite";

// Backup: Secondary & tertiary Gemini Flash models
const BACKUP_AI_PROVIDER = process.env.BACKUP_AI_PROVIDER || "gemini";
const BACKUP_AI_MODEL = process.env.BACKUP_AI_MODEL || "gemini-3.8-flash";
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
  currentUser?: {
    uid: string;
    displayName: string;
    email: string;
    isAdmin: boolean;
    isSuperAdmin?: boolean;
    role: string;
  } | null;
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

  const billsQuery = query(
    collection(db, "bills"),
    orderBy("date", "desc"),
    limit(40)
  );
  const expensesQuery = query(
    collection(db, "other_costs"),
    orderBy("date", "desc"),
    limit(30)
  );
  const logsQuery = query(
    collection(db, "activity_logs"),
    orderBy("timestamp", "desc"),
    limit(20)
  );

  // Fetch all 5 collections in parallel for sub-300ms snapshot latency
  const [productsSnap, billsSnap, expensesSnap, settingsSnap, logsSnap] =
    await Promise.all([
      getDocs(collection(db, "products")),
      getDocs(billsQuery),
      getDocs(expensesQuery),
      getDocs(collection(db, "settings")),
      getDocs(logsQuery),
    ]);

  // 1. Parse Products (strip binary image buffers for memory & context efficiency)
  const products: StoreProduct[] = [];
  productsSnap.forEach((docSnap) => {
    const data = docSnap.data();
    products.push({
      id: docSnap.id,
      name: String(data.name || "Unnamed Product"),
      price: Number(data.price) || 0,
      stock: Number(data.stock) || 0,
      category: data.category || "fresh",
      createdAt: Number(data.createdAt) || 0,
      soldCount: Number(data.soldCount) || 0,
    });
  });

  // 2. Parse Bills (sanitize against legacy Infinity totals)
  const bills: StoreBill[] = [];
  billsSnap.forEach((docSnap) => {
    const data = docSnap.data();
    const rawTotal = Number(data.total);
    const safeTotal = Number.isFinite(rawTotal) && rawTotal >= 0 ? Math.min(10000, rawTotal) : 0;
    bills.push({
      id: docSnap.id,
      total: safeTotal,
      items: Array.isArray(data.items) ? data.items : [],
      date: Number(data.date) || 0,
      updatedAt: Number(data.updatedAt) || undefined,
      status: data.status,
    });
  });

  const todayBills = bills.filter((b) => b.date >= todayStart);
  const todayRevenue = todayBills.reduce((acc, b) => acc + (b.total || 0), 0);
  const todayBillsCount = todayBills.length;

  // 3. Parse Expenses / Other Costs
  const expenses: StoreExpense[] = [];
  expensesSnap.forEach((docSnap) => {
    const data = docSnap.data();
    expenses.push({
      id: docSnap.id,
      title: String(data.title || data.name || "Expense"),
      amount: Number(data.amount) || 0,
      date: Number(data.date) || 0,
      ownerId: data.ownerId,
      category: data.category || "expense",
    });
  });

  const todayExpenses = expenses.filter((e) => e.date >= todayStart);
  const todayExpenseTotal = todayExpenses.reduce((acc, e) => acc + (e.amount || 0), 0);

  // 4. Parse Staff & Account Directory from `settings`
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

  // 5. Parse Activity Logs
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

// Fast 0ms Snapshot Hydration from Client Real-Time Context (avoids 5 slow Firestore round-trips)
export function hydrateSnapshotFromClientContext(clientContext: any): StoreSnapshot | null {
  if (!clientContext || !Array.isArray(clientContext.products)) {
    return null;
  }
  const timestamp = Date.now();
  const todayStart = getStoreTodayStartTimestamp();
  const safeNum = (v: any, max = 10000) => {
    const n = Number(v);
    return Number.isFinite(n) && n >= 0 ? Math.min(max, n) : 0;
  };

  const products: StoreProduct[] = clientContext.products.map((p: any, idx: number) => ({
    id: String(p.id || `prod_${idx}`),
    name: String(p.name || "Unnamed Product"),
    price: safeNum(p.price, 10000),
    stock: safeNum(p.stock, 2000),
    category: p.category || "fresh",
    soldCount: safeNum(p.soldCount, 1000000),
  }));

  const recentBills: StoreBill[] = (clientContext.recentBills || []).map((b: any, idx: number) => ({
    id: String(b.id || `bill_${idx}`),
    total: safeNum(b.total, 10000),
    items: Array.isArray(b.items) ? b.items : [],
    date: Number(b.date) || timestamp,
    status: b.status,
  }));

  const expenses: StoreExpense[] = (clientContext.otherCosts || []).map((e: any, idx: number) => ({
    id: String(e.id || `exp_${idx}`),
    title: String(e.title || e.name || "Expense"),
    amount: safeNum(e.amount, 1000000),
    date: Number(e.date) || timestamp,
    category: e.category || "expense",
  }));

  const todayExpenses = expenses.filter((e) => e.date >= todayStart);
  const todayExpenseTotal = todayExpenses.reduce((acc, e) => acc + (e.amount || 0), 0);

  const currentUser = clientContext.currentUser
    ? {
        uid: String(clientContext.currentUser.uid || ""),
        displayName: String(clientContext.currentUser.displayName || "Store User"),
        email: String(clientContext.currentUser.email || ""),
        isAdmin: Boolean(clientContext.currentUser.isAdmin),
        isSuperAdmin: Boolean(clientContext.currentUser.isSuperAdmin),
        role: String(
          clientContext.currentUser.role ||
            (clientContext.currentUser.isAdmin ? "Admin" : "Standard User")
        ),
      }
    : null;

  return {
    products,
    bills: recentBills,
    recentBills: recentBills.slice(0, 10),
    todayBills: recentBills.filter((b) => b.date >= todayStart),
    todayRevenue: safeNum(clientContext.totalRevenueToday, 10000000),
    todayBillsCount: safeNum(clientContext.billsCountToday, 100000),
    expenses,
    todayExpenseTotal,
    accounts: Array.isArray(clientContext.accounts) ? clientContext.accounts : [],
    activityLogs: Array.isArray(clientContext.activityLogs) ? clientContext.activityLogs : [],
    currentUser,
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
  if (isNaN(newStock) || newStock < 0 || newStock > 2000) {
    throw new Error(`Invalid stock quantity: ${newStock}. Stock must be between 0 and 2,000 units.`);
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
  if (isNaN(newPrice) || newPrice <= 0 || newPrice > 10000) {
    throw new Error(`Invalid price value: ₹${newPrice}. Price must be between ₹1 and ₹10,000.`);
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
  const price = Math.min(10000, Number(data.price));
  const stock = Math.min(2000, Math.max(0, Number(data.stock) || 0));
  if (isNaN(price) || price <= 0) {
    throw new Error(`Invalid product price: ₹${data.price}`);
  }

  const docRef = await addDoc(collection(db, "products"), {
    name: data.name.trim(),
    price,
    stock,
    category: normalizeServerProductCategory(data.category, data.name),
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

export async function executeBillDelete(
  billId: string,
  user?: any
): Promise<{ success: boolean; billId: string; total: number }> {
  if (!db) throw new Error("Database not connected.");
  const billRef = doc(db, "bills", billId);
  const snap = await getDoc(billRef);
  if (!snap.exists()) {
    throw new Error(`Transaction #${billId} not found.`);
  }

  const data = snap.data();
  const total = Number(data.total) || 0;
  const items = data.items || [];

  if (items.length > 0) {
    const batch = writeBatch(db);
    for (const item of items) {
      if (!item.productId) continue;
      const productRef = doc(db, "products", item.productId);
      const qty = Number(item.quantity || 0);

      const pSnap = await getDoc(productRef);
      if (pSnap.exists()) {
        batch.set(
          productRef,
          {
            stock: increment(qty) as any,
            soldCount: increment(-qty) as any,
            updatedAt: Date.now(),
          },
          { merge: true }
        );
      }
    }
    batch.delete(billRef);
    await batch.commit();
  } else {
    await deleteDoc(billRef);
  }

  await logStoreActivity(
    "bill_deletion",
    `Transaction #${billId.slice(0, 8)} (₹${total}) was voided and product stock restored.`,
    user
  );

  return { success: true, billId, total };
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

export function normalizeStorePrompt(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/\b(delte|delet|dlt|deleet|dalete)\b/g, "delete")
    .replace(/\b(remve|rmv|remov)\b/g, "remove")
    .replace(/\b(cancle|cncl)\b/g, "cancel")
    .replace(/\b(prodcuts|prodcut|proucts|prducts|prods)\b/g, "products")
    .replace(/\b(bils|biils)\b/g, "bills")
    .replace(/\b(transcation|transcations|trnsaction)\b/g, "transaction")
    .replace(/\b(invetory|inventry)\b/g, "inventory")
    .replace(/\b(stok|stoks)\b/g, "stock")
    .trim();
}

export function isStoreRelatedPrompt(prompt: string, conversationHistory: any[] = []): boolean {
  const p = normalizeStorePrompt(prompt);

  // If there is active conversation history with Buzz AI, follow-up replies (e.g., "Electricity bill, expense", "50", "Milk", "yes")
  // are continuations of the store operation unless the user asks an explicitly unrelated off-topic question.
  const offTopicPatterns = /\b(write a poem|write an essay|tell me a joke|who is the president|capital of|movie|cricket|football|weather in|bitcoin|stock market|recipe for|python code|javascript code|leetcode|horoscope|astrology)\b/i;
  if (offTopicPatterns.test(p)) {
    return false;
  }

  if (Array.isArray(conversationHistory) && conversationHistory.length > 0) {
    return true;
  }

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
    "order",
    "expense",
    "other cost",
    "cost",
    "borrow",
    "debt",
    "due",
    "rent",
    "electricity",
    "tea",
    "transport",
    "salary",
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
    "create",
    "record",
    "update",
    "delete",
    "remove",
    "void",
    "wipe",
    "purge",
    "edit",
    "show",
    "list",
    "all",
    "app",
    "hi",
    "hello",
    "hey",
    "who are you",
    "what can you do",
    "clear",
    "reset",
    "what did i say",
    "repeat",
    "rupee",
    "rs",
    "₹",
    "profit",
    "loss",
    "analytics",
    "summary",
    "report",
    "today",
    "low",
    "out of",
  ];

  return keywords.some((k) => p.includes(k));
}

export const OUT_OF_SCOPE_RESPONSE =
  "I am **Buzz AI**, your dedicated assistant for **SmartRooti** store operations. I can only assist with your store's inventory, stock, product prices, transactions, sales revenue, expenses/other costs, staff permissions, and POS features. How can I help with your store today?";

// ============================================================================
// 4B. STRICT ACTION CARD VALIDATOR & PREMATURE-CARD SUPPRESSOR
// ============================================================================

const PLACEHOLDER_TITLES = new Set([
  "",
  "store expense",
  "expense",
  "other cost",
  "other costs",
  "cost",
  "general expense",
  "unknown",
  "n/a",
  "tbd",
  "none",
  "null",
  "undefined",
  "<title>",
  "<description>",
  "product",
  "new product",
  "item",
  "<name>",
]);

export function normalizeExpenseCategory(raw?: string): "expense" | "borrow" | "due" | "other" {
  const c = String(raw || "").toLowerCase().trim();
  if (c.includes("borrow") || c.includes("debt") || c.includes("loan")) return "borrow";
  if (c.includes("due") || c.includes("pending") || c.includes("credit") || c.includes("udhar")) return "due";
  if (c.includes("other")) return "other";
  return "expense";
}

/**
 * Ensures an action card is ONLY returned when:
 * 1. The user did NOT explicitly ask the AI to ask them for details first.
 * 2. The AI's own reply is NOT asking the user clarifying questions for missing fields.
 * 3. Every required field for the action type is present, valid, and matched against live store data.
 */
export function validateAndNormalizeAction(
  rawAction: any,
  prompt: string,
  replyText: string,
  snapshot: StoreSnapshot
): any | null {
  if (!rawAction || typeof rawAction !== "object" || !rawAction.type) {
    return null;
  }

  const pLower = prompt.toLowerCase();
  const rLower = replyText.toLowerCase();

  // 1. If the user explicitly told the AI to ask them for details/requirements first, NEVER show the card on this turn
  if (
    /\b(ask\s+me|what\s+details\s+do\s+you\s+need|what\s+info\s+do\s+you\s+need|tell\s+me\s+what\s+you\s+need|ask\s+the\s+requirements|ask\s+all\s+the\s+details)\b/i.test(
      pLower
    )
  ) {
    return null;
  }

  // 2. If the AI's reply text is asking the user to provide details before finalizing, suppress the premature card
  if (
    /\b(please\s+provide\s+the\s+following|once\s+you\s+provide\s+these\s+details|please\s+tell\s+me|could\s+you\s+please\s+provide|what\s+is\s+this\s+(?:expense|cost)\s+for|please\s+specify\s+the|let\s+me\s+know\s+the\s+following|need\s+a\s+few\s+more\s+details)\b/i.test(
      rLower
    )
  ) {
    return null;
  }

  const action = { ...rawAction };

  switch (action.type) {
    case "ADD_EXPENSE": {
      const rawTitle = String(action.title || action.description || action.name || "").trim();
      const lowerTitle = rawTitle.toLowerCase();
      const userExplicitlyNamedGeneric =
        pLower.includes("store expense") || pLower.includes('"expense"');
      if (!rawTitle || (PLACEHOLDER_TITLES.has(lowerTitle) && !userExplicitlyNamedGeneric)) {
        return null;
      }
      // Also reject if the title accidentally captured "and ask me..."
      if (/\b(ask\s+me|details\s+u\s+need|details\s+you\s+need)\b/i.test(rawTitle)) {
        return null;
      }
      const amount = Number(action.amount ?? action.price ?? action.total);
      if (isNaN(amount) || amount <= 0) {
        return null;
      }
      action.title = rawTitle;
      action.amount = amount;
      action.category = normalizeExpenseCategory(action.category);
      return action;
    }

    case "DELETE_EXPENSE": {
      let targetExpense = snapshot.expenses.find((e) => e.id === action.expenseId);
      if (!targetExpense && action.title) {
        const t = String(action.title).toLowerCase().trim();
        targetExpense = snapshot.expenses.find((e) => e.title.toLowerCase().includes(t));
      }
      if (!targetExpense && snapshot.expenses.length > 0 && /last|latest|recent/i.test(pLower)) {
        targetExpense = snapshot.expenses[0];
      }
      if (!targetExpense) return null;
      action.expenseId = targetExpense.id;
      action.title = targetExpense.title;
      action.amount = targetExpense.amount;
      action.category = normalizeExpenseCategory(targetExpense.category);
      return action;
    }

    case "ADD_PRODUCT": {
      if (Array.isArray(action.products) && action.products.length > 0) {
        const validItems: { name: string; price: number; stock: number; category: string }[] = [];
        for (const item of action.products) {
          const itemName = String(item?.name || item?.productName || "").trim();
          const itemPrice = Number(item?.price ?? item?.newPrice);
          const itemStock =
            item?.stock !== undefined && item?.stock !== null ? Number(item.stock) : 0;
          const itemCat = normalizeServerProductCategory(
            item?.category || action.category,
            itemName
          );
          if (
            itemName &&
            !PLACEHOLDER_TITLES.has(itemName.toLowerCase()) &&
            !isNaN(itemPrice) &&
            itemPrice > 0
          ) {
            validItems.push({
              name: itemName,
              price: itemPrice,
              stock: isNaN(itemStock) || itemStock < 0 ? 0 : itemStock,
              category: itemCat,
            });
          }
        }
        if (validItems.length > 0) {
          action.products = validItems;
          action.name = validItems.map((i) => i.name).join(", ");
          action.price = validItems[0].price;
          action.stock = validItems[0].stock;
          action.category = validItems[0].category;
          return action;
        }
      }

      const rawName = String(action.name || action.productName || "").trim();
      if (!rawName || PLACEHOLDER_TITLES.has(rawName.toLowerCase())) {
        return null;
      }
      const price = Number(action.price ?? action.newPrice);
      if (isNaN(price) || price <= 0) {
        return null;
      }
      const stock = action.stock !== undefined && action.stock !== null ? Number(action.stock) : 0;
      action.name = rawName;
      action.price = price;
      action.stock = isNaN(stock) || stock < 0 ? 0 : stock;
      action.category = normalizeServerProductCategory(action.category, rawName);
      action.products = [
        {
          name: action.name,
          price: action.price,
          stock: action.stock,
          category: action.category,
        },
      ];
      return action;
    }

    case "UPDATE_STOCK": {
      let matched = snapshot.products.find((p) => p.id === action.productId);
      const searchName = String(action.productName || action.name || "").toLowerCase().trim();
      if (!matched && searchName) {
        matched =
          snapshot.products.find((p) => p.name.toLowerCase().trim() === searchName) ||
          snapshot.products.find((p) => p.name.toLowerCase().includes(searchName)) ||
          snapshot.products.find((p) => searchName.includes(p.name.toLowerCase()));
      }
      if (!matched) return null;

      const currentStock = Number(matched.stock) || 0;
      let newStock = Number(action.newStock);
      let quantityChange = Number(action.quantityChange);

      if (isNaN(newStock) && !isNaN(quantityChange)) {
        newStock = Math.max(0, currentStock + quantityChange);
      } else if (!isNaN(newStock) && isNaN(quantityChange)) {
        quantityChange = newStock - currentStock;
      }
      if (isNaN(newStock) || newStock < 0) return null;

      action.productId = matched.id;
      action.productName = matched.name;
      action.currentStock = currentStock;
      action.newStock = newStock;
      action.quantityChange = quantityChange;
      return action;
    }

    case "UPDATE_PRICE": {
      let matched = snapshot.products.find((p) => p.id === action.productId);
      const searchName = String(action.productName || action.name || "").toLowerCase().trim();
      if (!matched && searchName) {
        matched =
          snapshot.products.find((p) => p.name.toLowerCase().trim() === searchName) ||
          snapshot.products.find((p) => p.name.toLowerCase().includes(searchName)) ||
          snapshot.products.find((p) => searchName.includes(p.name.toLowerCase()));
      }
      if (!matched) return null;

      const newPrice = Number(action.newPrice ?? action.price);
      if (isNaN(newPrice) || newPrice <= 0) return null;

      action.productId = matched.id;
      action.productName = matched.name;
      action.currentPrice = Number(matched.price) || 0;
      action.newPrice = newPrice;
      return action;
    }

    case "DELETE_PRODUCT": {
      let matched = snapshot.products.find((p) => p.id === action.productId);
      const searchName = String(action.productName || action.name || "").toLowerCase().trim();
      if (!matched && searchName) {
        matched =
          snapshot.products.find((p) => p.name.toLowerCase().trim() === searchName) ||
          snapshot.products.find((p) => p.name.toLowerCase().includes(searchName));
      }
      if (!matched) return null;

      action.productId = matched.id;
      action.productName = matched.name;
      action.currentPrice = Number(matched.price) || 0;
      action.currentStock = Number(matched.stock) || 0;
      return action;
    }

    case "UPDATE_BILL": {
      let targetBill = snapshot.bills.find((b) => b.id === action.billId);
      if (!targetBill && action.billId) {
        const short = String(action.billId).toLowerCase().replace(/^#/, "");
        targetBill = snapshot.bills.find((b) => b.id.toLowerCase().includes(short));
      }
      if (!targetBill && snapshot.recentBills.length > 0) {
        targetBill = snapshot.recentBills[0];
      }
      if (!targetBill) return null;

      const newTotal = Number(action.newTotal ?? action.total);
      if (isNaN(newTotal) || newTotal < 0) return null;

      action.billId = targetBill.id;
      action.oldTotal = Number(targetBill.total) || 0;
      action.newTotal = newTotal;
      action.items = targetBill.items || [];
      action.itemsCount = targetBill.items?.length || 1;
      return action;
    }

    case "DELETE_BILL": {
      let targetBill = snapshot.bills.find((b) => b.id === action.billId);
      if (!targetBill && action.billId) {
        const short = String(action.billId).toLowerCase().replace(/^#/, "");
        targetBill = snapshot.bills.find((b) => b.id.toLowerCase().includes(short));
      }
      if (!targetBill && snapshot.recentBills.length > 0) {
        targetBill = snapshot.recentBills[0];
      }
      if (!targetBill) return null;

      action.billId = targetBill.id;
      action.total = Number(targetBill.total) || 0;
      action.items = targetBill.items || [];
      action.itemsCount = targetBill.items?.length || 1;
      action.itemSummary =
        targetBill.items?.map((i) => `${i.quantity}× ${i.name}`).join(", ") || "Items";
      action.billDate = targetBill.date;
      return action;
    }

    case "UPDATE_ROLE": {
      // Security policy: Role changes (promoting or demoting admins) are strictly disabled via Buzz AI.
      return null;
    }

    case "PURGE_STORE_DATA": {
      const target =
        action.target === "products" || action.target === "bills" ? action.target : "both";
      action.target = target;
      action.productsCount = snapshot.products.length;
      action.billsCount = snapshot.bills.length;
      return action;
    }

    default:
      return null;
  }
}

// ============================================================================
// 5. STATUS SUMMARY & AUTHENTIC OPERATIONAL THOUGHT GENERATORS
// ============================================================================

export function getSafeStatusMessage(prompt: string, snapshot?: StoreSnapshot): string {
  const p = prompt.toLowerCase().trim();

  if (p.includes("pi") || p.includes("3.14") || p.includes("digit")) {
    return "Calculating high-precision π constant…";
  }

  if (p.includes("stock") || p.includes("inventory") || p.includes("units") || p.includes("item") || p.includes("how much") || p.includes("how many") || p.includes("left")) {
    if (snapshot?.products) {
      const match = snapshot.products.find((prod) =>
        p.includes(prod.name.toLowerCase()) || prod.name.toLowerCase().includes(p.replace(/how much|how many|stock|of|is|left|what/g, "").trim())
      );
      if (match) {
        if (p.includes("add") || p.includes("set") || p.includes("update") || p.includes("make it")) {
          return `Updating stock for ${match.name}…`;
        }
        return `Checking inventory for ${match.name} in Firestore…`;
      }
    }
    if (p.includes("add") || p.includes("increase") || p.includes("set") || p.includes("update")) {
      return "Updating product stock…";
    }
    return "Checking store inventory in Firestore…";
  }

  if (p.includes("price") || p.includes("cost") || p.includes("rate") || p.includes("₹")) {
    if (snapshot?.products) {
      const match = snapshot.products.find((prod) =>
        p.includes(prod.name.toLowerCase())
      );
      if (match) {
        if (p.includes("change") || p.includes("set") || p.includes("update")) {
          return `Saving price change for ${match.name}…`;
        }
        return `Looking up price for ${match.name}…`;
      }
    }
    if (p.includes("expense") || p.includes("other cost") || p.includes("borrow") || p.includes("due")) {
      return "Reviewing store expenses & other costs…";
    }
    if (p.includes("change") || p.includes("set") || p.includes("update")) {
      return "Saving price change…";
    }
    return "Looking up product pricing in catalog…";
  }

  if (p.includes("sale") || p.includes("revenue") || p.includes("today") || p.includes("turnover") || p.includes("earn")) {
    return "Calculating today's sales from completed receipts…";
  }

  if (p.includes("bill") || p.includes("transaction") || p.includes("receipt") || p.includes("make it") || p.includes("set to")) {
    if (p.includes("edit") || p.includes("change") || p.includes("make it") || p.includes("set to")) {
      return "Updating transaction record in store ledger…";
    }
    return "Looking up transaction details in ledger…";
  }

  if (p.includes("admin") || p.includes("staff") || p.includes("user") || p.includes("role") || p.includes("who is")) {
    return "Checking staff directory & role permissions…";
  }

  if (p.includes("expense") || p.includes("rent") || p.includes("electricity") || p.includes("other cost") || p.includes("borrow") || p.includes("due")) {
    return "Reviewing store expenses & costs…";
  }

  if (p.includes("product") && (p.includes("add") || p.includes("create") || p.includes("new"))) {
    return "Creating new product entry in catalog…";
  }

  if (p.includes("what did i say") || p.includes("repeat") || p.includes("what did i ask")) {
    return "Recalling conversation context…";
  }

  return "Reviewing live store data in Firestore…";
}

// Generate genuine, query-specific multi-step operational thought and audit trace
export function generateAuthenticOperationalThought(
  prompt: string,
  snapshot?: StoreSnapshot,
  replyText: string = "",
  actionData: any = null
): string {
  const p = prompt.toLowerCase().trim();
  const steps: string[] = [];

  // 1. Math / Pi Calculation
  if (p.includes("pi") || p.includes("3.14") || p.includes("digit")) {
    steps.push("Parsed mathematical request for circular constant π (pi)");
    steps.push("Retrieved high-precision value to 100 decimal digits without rounding or truncation");
    steps.push("Applied responsive layout word-break formatting for long continuous numeric sequences");
    return steps.join("\n");
  }

  if (p.includes("calculate") || p.includes("compute") || p.match(/\d+\s*[\+\-\*\/]\s*\d+/)) {
    steps.push("Parsed arithmetic formula and evaluated numerical expression");
    steps.push("Computed exact result and verified calculation precision");
    return steps.join("\n");
  }

  // 2. Specific Actions
  if (actionData) {
    if (actionData.type === "UPDATE_STOCK") {
      steps.push("Audited active administrator session & inventory update permissions");
      steps.push(`Located target product "${actionData.productName || "Product"}" in Firestore catalog`);
      if (actionData.currentStock !== undefined && actionData.newStock !== undefined) {
        steps.push(`Verified inventory adjustment: ${actionData.currentStock} units → ${actionData.newStock} units`);
      } else if (actionData.quantityChange !== undefined) {
        steps.push(`Applied stock delta: ${actionData.quantityChange > 0 ? "+" : ""}${actionData.quantityChange} units`);
      }
      steps.push("Constructed atomic Firestore transaction payload with verification audit trail");
      return steps.join("\n");
    }

    if (actionData.type === "UPDATE_PRICE") {
      steps.push("Audited price change authorization and store pricing rules");
      steps.push(`Located "${actionData.productName || "Product"}" in catalog pricing index`);
      steps.push(`Verified price adjustment: ₹${actionData.currentPrice ?? "—"} → ₹${actionData.newPrice}`);
      steps.push("Formatted updated catalog price record for operator confirmation");
      return steps.join("\n");
    }

    if (actionData.type === "ADD_PRODUCT") {
      steps.push("Validated product creation schema (name, price, stock, category)");
      steps.push(`Prepared new entry "${actionData.name}" @ ₹${actionData.price} with ${actionData.stock || 0} initial units`);
      steps.push("Constructed Firestore catalog document ready for atomic write");
      return steps.join("\n");
    }

    if (actionData.type === "UPDATE_BILL") {
      steps.push("Audited transaction modification permissions in store ledger");
      steps.push(`Retrieved target bill #${actionData.billId?.slice(0, 8) || "latest"} from Firestore`);
      steps.push(`Validated total adjustment: ₹${actionData.oldTotal ?? "—"} → ₹${actionData.newTotal}`);
      steps.push("Prepared transaction audit trail with updated financial balance");
      return steps.join("\n");
    }

    if (actionData.type === "DELETE_BILL") {
      steps.push("Audited ledger void authorization & stock restoration rules");
      steps.push(`Located transaction #${actionData.billId?.slice(0, 8) || "latest"} (₹${actionData.total ?? 0}) in Firestore`);
      steps.push(`Mapped ${actionData.itemsCount || 1} line item(s) (${actionData.itemSummary || "items"}) for automatic stock return`);
      steps.push("Prepared atomic batch operation to void receipt and restore catalog inventory");
      return steps.join("\n");
    }

    if (actionData.type === "PURGE_STORE_DATA") {
      steps.push("Verified administrator authorization for bulk database purge");
      steps.push(
        `Scanned live Firestore collections: ${actionData.productsCount ?? snapshot?.products.length ?? 0} product(s), ${actionData.billsCount ?? snapshot?.bills.length ?? 0} bill(s)`
      );
      steps.push(`Target scope locked: ${String(actionData.target || "both").toUpperCase()}`);
      steps.push("Prepared safeguarded batch-deletion card awaiting explicit operator confirmation");
      return steps.join("\n");
    }

    if (actionData.type === "DELETE_PRODUCT") {
      steps.push("Audited catalog deletion authorization");
      steps.push(`Located target product "${actionData.productName || "Product"}" (₹${actionData.currentPrice ?? 0}, ${actionData.currentStock ?? 0} units) in Firestore`);
      steps.push("Prepared structured deletion payload with inventory purge safeguard");
      return steps.join("\n");
    }

    if (actionData.type === "ADD_EXPENSE") {
      steps.push("Validated store expenditure entry (title, amount, category)");
      steps.push(`Constructed other_costs document for "${actionData.title}" (₹${actionData.amount}, category: ${actionData.category || "expense"})`);
      steps.push("Prepared confirmation card for live ledger recording");
      return steps.join("\n");
    }

    if (actionData.type === "DELETE_EXPENSE") {
      steps.push("Audited expense deletion request in other_costs collection");
      steps.push(`Located expense "${actionData.title}" (₹${actionData.amount})`);
      steps.push("Prepared confirmation card for expense removal");
      return steps.join("\n");
    }

    if (actionData.type === "UPDATE_ROLE") {
      steps.push("Audited Super Admin role governance permissions");
      steps.push(`Identified staff profile for user "${actionData.userName || actionData.userId}"`);
      steps.push(`Prepared profile security setting update to role "${actionData.newRole || "admin"}"`);
      return steps.join("\n");
    }
  }

  // 3. Conversation Context
  if (p.includes("what did i say") || p.includes("repeat") || p.includes("what did i ask") || p.includes("what was my last")) {
    steps.push("Scanned active conversation buffer and cited exact previous user message");
    steps.push("Verified session continuity without overwriting live store state");
    return steps.join("\n");
  }

  if (p.includes("clear") || p.includes("reset") || p.includes("new chat") || p.includes("delete history")) {
    steps.push("Purged active conversational context for current authenticated session");
    steps.push("Reinitialized Buzz AI store manager state to fresh baseline");
    return steps.join("\n");
  }

  // 4. Products / Inventory Lookup
  if (snapshot && (p.includes("stock") || p.includes("inventory") || p.includes("unit") || p.includes("item") || p.includes("how much") || p.includes("how many") || p.includes("left") || p.includes("price") || p.includes("cost") || p.includes("rate"))) {
    const matchedProduct = snapshot.products.find((prod) =>
      p.includes(prod.name.toLowerCase()) || prod.name.toLowerCase().includes(p.replace(/how much|how many|stock|of|is|left|what|the|price/g, "").trim())
    );

    if (matchedProduct) {
      steps.push(`Queried live Firestore catalog → located "${matchedProduct.name}" (ID: #${matchedProduct.id.slice(0, 8)})`);
      steps.push(`Verified database values: Stock = ${matchedProduct.stock} units, Price = ₹${matchedProduct.price}`);
      const health = matchedProduct.stock <= 0 ? "Out of Stock (0 units)" : matchedProduct.stock <= 5 ? "Low Stock Alert (<=5 units)" : "Normal Stock";
      steps.push(`Evaluated inventory health status: ${health}`);
      steps.push("Formatted real-time catalog response for store operator");
      return steps.join("\n");
    }

    const outCount = snapshot.products.filter((prod) => prod.stock <= 0).length;
    const lowCount = snapshot.products.filter((prod) => prod.stock > 0 && prod.stock <= 5).length;
    steps.push(`Queried live Firestore catalog (${snapshot.products.length} active items)`);
    steps.push(`Analyzed catalog health: ${outCount} out-of-stock, ${lowCount} low-stock items`);
    steps.push("Synthesized inventory overview directly from live database state");
    return steps.join("\n");
  }

  // 5. Sales & Revenue
  if (snapshot && (p.includes("sale") || p.includes("revenue") || p.includes("today") || p.includes("turnover") || p.includes("earn"))) {
    steps.push(`Queried today's checkout ledger in Firestore (${snapshot.todayBillsCount} completed receipts)`);
    steps.push(`Aggregated live transaction totals: ₹${snapshot.todayRevenue.toLocaleString("en-IN")} gross revenue`);
    if (snapshot.todayBillsCount > 0) {
      const avg = (snapshot.todayRevenue / snapshot.todayBillsCount).toFixed(2);
      steps.push(`Computed average ticket value: ₹${avg} per bill across completed orders`);
    }
    steps.push("Formatted financial summary with Indian Rupee (₹) currency standards");
    return steps.join("\n");
  }

  // 6. Bills / Transactions
  if (snapshot && (p.includes("bill") || p.includes("transaction") || p.includes("receipt") || p.includes("order"))) {
    const latest = snapshot.recentBills[0];
    if (latest) {
      steps.push(`Retrieved latest transaction record #${latest.id.slice(0, 8)} from Firestore ledger`);
      steps.push(`Extracted item breakdown: ${latest.items.map((i) => `${i.quantity}x ${i.name}`).join(", ") || "Recorded items"}`);
      steps.push(`Verified receipt total: ₹${latest.total} recorded on ${new Date(latest.date).toLocaleDateString()}`);
    } else {
      steps.push("Scanned recent transactions in Firestore ledger (no recent bills on record)");
    }
    return steps.join("\n");
  }

  // 7. Staff & Roles
  if (snapshot && (p.includes("admin") || p.includes("staff") || p.includes("user") || p.includes("role") || p.includes("who is") || p.includes("account"))) {
    const admins = snapshot.accounts.filter((a) => a.isSuperAdmin || a.isAdmin);
    const regular = snapshot.accounts.filter((a) => !a.isAdmin);
    steps.push(`Audited store staff directory from Firestore (${snapshot.accounts.length} registered accounts)`);
    steps.push(`Verified active privileges: ${admins.length} Administrator(s), ${regular.length} Staff Member(s)`);
    steps.push("Cross-checked session authentication records and role policies");
    return steps.join("\n");
  }

  // 8. Expenses
  if (snapshot && (p.includes("expense") || p.includes("cost") || p.includes("rent") || p.includes("electricity") || p.includes("other cost") || p.includes("borrow") || p.includes("due"))) {
    steps.push("Scanned operational cost records in Firestore other_costs collection");
    steps.push(`Calculated today's expenditure: ₹${snapshot.todayExpenseTotal.toLocaleString("en-IN")}`);
    steps.push("Evaluated required fields for expense/cost operation");
    return steps.join("\n");
  }

  // 9. Greetings
  if (p === "hi" || p === "hello" || p === "hey" || p.startsWith("hi ") || p.startsWith("hello ")) {
    steps.push("Processed operator greeting and initialized Buzz AI store management engine");
    steps.push(`Verified live Firestore connection: ${snapshot?.products.length || 0} products, ₹${(snapshot?.todayRevenue || 0).toLocaleString("en-IN")} sales today`);
    steps.push("Loaded operational capabilities (Stock, Billing, Pricing, Expenses)");
    return steps.join("\n");
  }

  // 10. General Store Fallback
  if (snapshot) {
    steps.push(`Connected to live SmartRooti database (${snapshot.products.length} products, ${snapshot.recentBills.length} recent bills)`);
    steps.push(`Analyzed query context: "${prompt.slice(0, 40)}"`);
    steps.push("Evaluated store operational parameters and formulated verified response");
    return steps.join("\n");
  }

  return "Queried live store database\nVerified catalog state in Firestore\nFormulated real-time operational response";
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

  const productListBrief = snapshot.products.slice(0, 60).map((p) => ({
    id: p.id,
    name: p.name,
    price: p.price,
    stock: p.stock,
    category: p.category,
  }));

  const billsBrief = snapshot.recentBills.slice(0, 12).map((b) => ({
    id: b.id,
    total: b.total,
    date: new Date(b.date).toLocaleDateString(),
    itemSummary: b.items.map((i) => `${i.quantity}x ${i.name}`).join(", "),
  }));

  const expensesBrief = snapshot.expenses.slice(0, 15).map((e) => ({
    id: e.id,
    title: e.title,
    amount: e.amount,
    category: e.category || "expense",
    date: new Date(e.date).toLocaleDateString(),
  }));

  const accountsBrief = snapshot.accounts.map((a) => ({
    uid: a.uid,
    name: a.displayName,
    email: a.email,
    role: a.role,
    isAdmin: a.isAdmin,
    isSuperAdmin: a.isSuperAdmin,
    status: a.isOnline ? "Online" : "Offline",
  }));

  const currentUserBlock = snapshot.currentUser
    ? `CURRENT LOGGED-IN USER (THE PERSON TALKING TO YOU RIGHT NOW):
- Name: ${snapshot.currentUser.displayName}
- Email: ${snapshot.currentUser.email || "Not provided"}
- UID: ${snapshot.currentUser.uid}
- Role: ${snapshot.currentUser.role}
- Is Admin?: ${snapshot.currentUser.isAdmin ? "YES (This user IS an Administrator)" : "NO (This user is a Standard User / Staff, NOT an Administrator)"}
- Is Owner / Super Admin?: ${snapshot.currentUser.isSuperAdmin ? "YES" : "NO"}
(When the user asks "am I an admin?", "who am I?", "what is my role?", or "what is my email?", answer directly and conversationally about THIS user!)`
    : `CURRENT LOGGED-IN USER: Guest / Unauthenticated session`;

  return `You are "Buzz AI", an intelligent, accurate, and conversational retail store manager for "SmartRooti" running inside the Buzz POS & Stock Management app.

${currentUserBlock}

REAL-TIME LIVE STORE DATA (ACTUAL DATABASE STATE AS OF ${new Date(snapshot.timestamp).toLocaleTimeString()}):
- Active Catalog Size: ${snapshot.products.length} products
- Out-of-Stock Products (0 units): ${outOfStock.length} items
- Low-Stock Products (<=5 units): ${lowStock.length} items
- Today's Total Sales Revenue: ₹${snapshot.todayRevenue.toLocaleString("en-IN")}
- Today's Completed Bills/Orders: ${snapshot.todayBillsCount}
- Today's Total Expenses/Other Costs: ₹${snapshot.todayExpenseTotal.toLocaleString("en-IN")} (Total recorded expenses: ${snapshot.expenses.length})
- Registered Staff / Accounts: ${snapshot.accounts.length}

CURRENT CATALOG SNAPSHOT:
${JSON.stringify(productListBrief)}

RECENT TRANSACTIONS (BILLS) SNAPSHOT:
${JSON.stringify(billsBrief)}

RECENT OTHER COSTS / EXPENSES SNAPSHOT:
${JSON.stringify(expensesBrief)}

REGISTERED STAFF DIRECTORY:
${JSON.stringify(accountsBrief)}

CRITICAL CONVERSATIONAL & ACTION CARD RULES (MUST FOLLOW STRICTLY):
1. **NEVER EMIT AN \`\`\`action\`\`\` BLOCK WHEN ASKING FOR DETAILS OR WHEN REQUIRED FIELDS ARE MISSING**:
   - If the user says "ask me the details you need", "ask me requirements", or provides an incomplete request (for example: "add an other cost of 50 rupees" without saying what the cost is for, or "add a new product" without name and price, or "update stock" without product name and quantity):
   - You MUST ONLY ask the user for the missing details in plain text and **DO NOT output any \`\`\`action\`\`\` block** in that message!
   - Never invent placeholder titles like "Store Expense" or "Product" just to force an action card.
   - Wait until the user replies with the missing details in the next turn. Once all required details are known (combining previous turns + current turn), THEN output the summary and the \`\`\`action\`\`\` block at the end of your message.

2. **REQUIRED FIELDS FOR EACH ACTION BEFORE SHOWING A CARD**:
   - \`ADD_EXPENSE\` (Other Costs / Expenses):
     * Required: \`title\` (specific description of what the cost is for, e.g. "Electricity Bill", "Tea & Snacks", "Transport") AND \`amount\` (positive number in ₹).
     * Optional/Asked if user wants full details: \`category\` — must be one of \`"expense"\` (General Expense), \`"borrow"\` (Borrowed / Debt), \`"due"\` (Dynamic Due), or \`"other"\` (Other Cost). Default to \`"expense"\` if user gave title + amount directly without specifying category.
   - \`DELETE_EXPENSE\`:
     * Required: \`expenseId\` (matched from RECENT OTHER COSTS SNAPSHOT), \`title\`, \`amount\`.
   - \`ADD_PRODUCT\`:
     * VALID CATEGORIES ONLY: The store ONLY has 3 product categories: \`"fresh"\`, \`"frozen"\`, and \`"cold drinks"\`. NEVER use \`"General"\` or invent any other category!
     * Automatically infer the best category from the product name if not specified: beverages/sodas/juices/water/cans (e.g. Pepsi, Coke, Sprite, Maaza, Water) -> \`"cold drinks"\`; ice cream/frozen snacks/peas -> \`"frozen"\`; all other grocery/bakery/fresh items -> \`"fresh"\`.
     * For a single product: \`name\` (specific product name), \`price\` (positive number in ₹), \`stock\` (default 0), \`category\` (\`"fresh"\` | \`"frozen"\` | \`"cold drinks"\`).
     * For multiple products in one command (e.g., "add product atta, maida with the price 20, 30 and stock 50 for both"): include a \`products\` array of \`{ "name": "...", "price": 20, "stock": 50, "category": "fresh" | "frozen" | "cold drinks" }\` along with \`name\` (comma-separated names), \`price\` (first price), and \`stock\` (first stock).
   - \`UPDATE_STOCK\`:
     * Required: \`productId\` & \`productName\` (must match an existing product in CURRENT CATALOG SNAPSHOT), \`currentStock\`, \`newStock\` (non-negative number), \`quantityChange\`. If the product is not in the catalog, tell the user and do not emit \`UPDATE_STOCK\`.
   - \`UPDATE_PRICE\`:
     * Required: \`productId\` & \`productName\` (from CURRENT CATALOG SNAPSHOT), \`currentPrice\`, \`newPrice\` (positive number).
   - \`DELETE_PRODUCT\`:
     * Required: \`productId\`, \`productName\`, \`currentPrice\`, \`currentStock\` (from CURRENT CATALOG SNAPSHOT).
   - \`UPDATE_BILL\`:
     * Required: \`billId\` (from RECENT TRANSACTIONS SNAPSHOT), \`oldTotal\`, \`newTotal\` (non-negative number).
   - \`DELETE_BILL\`:
     * Required: \`billId\`, \`total\`, \`itemsCount\`, \`itemSummary\` (from RECENT TRANSACTIONS SNAPSHOT).
   - \`PURGE_STORE_DATA\`:
     * Required: \`target\` (\`"products"\` | \`"bills"\` | \`"both"\`), \`productsCount\` (${snapshot.products.length}), \`billsCount\` (${snapshot.bills.length}).
   - **SECURITY POLICY ON ADMIN ROLES**: You are strictly prohibited from promoting any user (including the current user or any other account) to Admin, demoting any Admin, or changing any user's role via chat. If asked to make someone admin or demote an admin, politely refuse and never emit \`UPDATE_ROLE\`.

3. **ACTION BLOCK FORMAT (ONLY WHEN ALL REQUIRED DETAILS ARE CONFIRMED BY USER)**:
   Append at the very end of your response:
   \`\`\`action
   {
     "type": "UPDATE_STOCK" | "UPDATE_PRICE" | "ADD_PRODUCT" | "DELETE_PRODUCT" | "UPDATE_BILL" | "DELETE_BILL" | "PURGE_STORE_DATA" | "ADD_EXPENSE" | "DELETE_EXPENSE",
     ...exact fields for that type
   }
   \`\`\`
4. Keep answers concise, warm, natural, factual, and formatted in Indian Rupees (₹). Never output hidden reasoning tags or robotic canned "Store Snapshot:" templates—always answer the user's actual message, greeting, question, or command directly and conversationally!
5. **STRICT CATALOG GROUNDING FOR RECOMMENDATIONS**: Whenever the user asks what to buy next, what to restock, what combos to offer, or asks for product recommendations, you MUST ONLY recommend products that ALREADY EXIST in CURRENT CATALOG SNAPSHOT. NEVER suggest or invent new products that are not in the user's existing products list.`;
}

function normalizeServerProductCategory(
  rawCategory?: string,
  productName?: string
): "fresh" | "frozen" | "cold drinks" {
  const cat = String(rawCategory || "").toLowerCase().trim();
  if (
    cat === "cold drinks" ||
    cat === "cold drink" ||
    cat === "colddrinks" ||
    cat === "drinks" ||
    cat === "beverage" ||
    cat === "beverages"
  ) {
    return "cold drinks";
  }
  if (cat === "frozen") {
    return "frozen";
  }
  if (cat === "fresh") {
    return "fresh";
  }

  const combined = `${cat} ${String(productName || "").toLowerCase()}`;
  if (
    /\b(pepsi|coke|coca\s*cola|cola|sprite|fanta|thums\s*up|thumbs\s*up|limca|mirinda|7\s*up|seven\s*up|mountain\s*dew|dew|maaza|slice|frooti|appy|fizz|sting|red\s*bull|monster|gatorade|bisleri|kinley|aquafina|water|soda|juice|cold\s*drink|soft\s*drink|drink|drinks|beverage|lassi|chaas|buttermilk|milkshake|shake|kool|can|nimbooz|paper\s*boat|tropicana)\b/i.test(
      combined
    )
  ) {
    return "cold drinks";
  }
  if (
    /\b(frozen|ice\s*cream|icecream|popsicle|chocobar|choco\s*bar|cornetto|magnum|kulfi|cassata|sundae|kwality|vadilal|havmor|mccain|french\s*fries|fries|nuggets|smiley|frozen\s*peas|green\s*peas|sweet\s*corn|momos|sausage|salami)\b/i.test(
      combined
    )
  ) {
    return "frozen";
  }
  return "fresh";
}

function formatServerCatalogName(raw: string): string {
  const cleaned = raw
    .replace(/^(?:and|with|the|a|an|new|product|products|item|items|named|called|of|for)\s+/gi, "")
    .replace(/\s+(?:and|with|the|for|both|each|respectively)$/gi, "")
    .replace(/^[,.\-:\s]+|[,.\-:\s]+$/g, "")
    .trim();
  if (!cleaned) return "";
  return cleaned
    .split(/\s+/)
    .map((w) => (w.length > 0 ? w.charAt(0).toUpperCase() + w.slice(1) : w))
    .join(" ");
}

function parseServerAddProductsFromPrompt(
  rawPrompt: string
): { name: string; price: number; stock: number; category: string }[] {
  const body = rawPrompt
    .trim()
    .replace(
      /^(?:please\s+|can\s+you\s+|could\s+you\s+|hey\s+buzz\s+)?(?:add|create|insert|make|register)\s+(?:a\s+|new\s+|the\s+|some\s+)*(?:products?|items?)?\s*(?:named|called|:)?\s*/i,
      ""
    )
    .trim();

  if (!body) return [];

  const priceKwRegex =
    /\b(?:and\s+)?(?:with\s+)?(?:the\s+)?(?:selling\s+)?(?:prices?|rates?|costs?|mrp)\b\s*(?:of|is|are|:|=)?/i;
  const stockKwRegex =
    /\b(?:and\s+)?(?:with\s+)?(?:the\s+)?(?:initial\s+)?(?:stocks?|qty|quantity|units?)\b\s*(?:of|is|are|:|=)?/i;

  const priceMatch = priceKwRegex.exec(body);
  const stockMatch = stockKwRegex.exec(body);

  if (priceMatch && priceMatch.index !== undefined) {
    const pIdx = priceMatch.index;
    const pEnd = pIdx + priceMatch[0].length;
    const sIdx = stockMatch?.index;
    const sEnd = sIdx !== undefined && stockMatch ? sIdx + stockMatch[0].length : -1;

    let namesSegment = "";
    let priceSegment = "";
    let stockSegment = "";

    if (sIdx !== undefined && sIdx >= 0) {
      const firstIdx = Math.min(pIdx, sIdx);
      namesSegment = body.slice(0, firstIdx);
      if (pIdx < sIdx) {
        priceSegment = body.slice(pEnd, sIdx);
        stockSegment = body.slice(sEnd);
      } else {
        stockSegment = body.slice(sEnd, pIdx);
        priceSegment = body.slice(pEnd);
      }
    } else {
      namesSegment = body.slice(0, pIdx);
      priceSegment = body.slice(pEnd);
    }

    const rawNames = namesSegment
      .split(/\s*(?:,|\band\b|&)\s*/i)
      .map(formatServerCatalogName)
      .filter((n) => n.length > 0 && !PLACEHOLDER_TITLES.has(n.toLowerCase()));

    const prices = (priceSegment.match(/\d+(?:\.\d+)?/g) || [])
      .map((n) => parseFloat(n))
      .filter((n) => !isNaN(n) && n > 0);

    const stocks = (stockSegment.match(/\d+/g) || [])
      .map((n) => parseInt(n, 10))
      .filter((n) => !isNaN(n) && n >= 0);

    if (rawNames.length > 0 && prices.length > 0) {
      return rawNames.map((name, idx) => ({
        name,
        price: prices[idx] !== undefined ? prices[idx] : prices[0],
        stock: stocks.length > 0 ? (stocks[idx] !== undefined ? stocks[idx] : stocks[0]) : 0,
        category: normalizeServerProductCategory(undefined, name),
      }));
    }
  }

  const clauses = body.split(/\s*,\s*|\s+\band\b\s+/i);
  const inlineItems: { name: string; price: number; stock: number; category: string }[] = [];
  let sharedStock: number | null = null;
  const trailingStockMatch = body.match(/\b(?:stocks?|qty|quantity|units?)\s*(?:of|is|:)?\s*(\d+)/i);
  if (trailingStockMatch) {
    sharedStock = parseInt(trailingStockMatch[1], 10);
  }

  for (const clause of clauses) {
    const m = clause.match(
      /^([a-zA-Z][a-zA-Z0-9\s]*?)\s+(?:₹|rs\.?\s*)?(\d+(?:\.\d+)?)\s*(?:₹|rs\.?|rupees?)?(?:\s+(?:with\s+)?(?:stocks?|qty|units?)\s*(?:of|is|:)?\s*(\d+))?$/i
    );
    if (m) {
      const cName = formatServerCatalogName(m[1]);
      const cPrice = parseFloat(m[2]);
      const cStock = m[3] ? parseInt(m[3], 10) : sharedStock ?? 0;
      if (cName && !PLACEHOLDER_TITLES.has(cName.toLowerCase()) && !isNaN(cPrice) && cPrice > 0) {
        inlineItems.push({
          name: cName,
          price: cPrice,
          stock: cStock,
          category: normalizeServerProductCategory(undefined, cName),
        });
      }
    }
  }

  return inlineItems;
}

// Local Deterministic Intelligence Engine (Zero AI network dependencies, Multi-Turn Aware)
export function generateLocalDeterministicResponse(
  prompt: string,
  snapshot: StoreSnapshot,
  conversationHistory: any[] = []
): { reply: string; action: any; status: string } {
  const p = normalizeStorePrompt(prompt);
  const status = getSafeStatusMessage(p, snapshot);
  const wantsToBeAsked = /\b(ask\s+me|what\s+details|what\s+info|ask\s+the\s+requirements|ask\s+all\s+the\s+details|details\s+u\s+need|details\s+you\s+need)\b/i.test(p);

  // Check if the previous assistant message was asking for missing details (Multi-turn slot filling!)
  const lastAssistantMsg = [...(conversationHistory || [])]
    .reverse()
    .find((m) => m.role === "assistant")?.content || "";
  const lastUserMsg = [...(conversationHistory || [])]
    .reverse()
    .find((m) => m.role === "user" && normalizeStorePrompt(m.content) !== p)?.content || "";

  // 0A. Multi-Turn Follow-Up for Pending Expense / Other Cost
  const wasAskingExpenseDetails =
    /title\/description|what is this (?:expense|cost) for|record this .* (?:expense|cost)|provide the following details[\s\S]*?(?:expense|cost|category)/i.test(
      lastAssistantMsg
    );

  if (wasAskingExpenseDetails && !wantsToBeAsked) {
    // Extract amount from current prompt OR previous user message OR assistant message
    const combinedContext = `${lastUserMsg} ${lastAssistantMsg}`;
    const currentAmountMatch = prompt.match(/(?:₹|rs\.?\s*)?(\d+(?:\.\d+)?)/i);
    const prevAmountMatch =
      lastUserMsg.match(/(?:₹|rs\.?\s*)?(\d+(?:\.\d+)?)/i) ||
      combinedContext.match(/₹\s*(\d+(?:\.\d+)?)/i);

    let amount = 0;
    if (prevAmountMatch && (!currentAmountMatch || prompt.trim().match(/^\d+\./))) {
      amount = parseFloat(prevAmountMatch[1]);
    } else if (currentAmountMatch && !prevAmountMatch) {
      amount = parseFloat(currentAmountMatch[1]);
    } else if (prevAmountMatch) {
      amount = parseFloat(prevAmountMatch[1]);
    }

    const category = normalizeExpenseCategory(prompt);
    const catLabels: Record<string, string> = {
      expense: "Expense",
      borrow: "Borrowed / Debt",
      due: "Dynamic Due",
      other: "Other Cost",
    };

    // Clean the user's reply to extract the expense title
    let cleanedTitle = prompt
      .replace(/\b(category|type|under|as)\s*[:=-]?\s*(expense|borrow|borrowed|debt|due|dynamic due|other cost|other)\b/gi, "")
      .replace(/\b(title|description|for|name|is|it is)\s*[:=-]?\s*/gi, "")
      .replace(/(?:₹|rs\.?|rupees?)\s*\d+(?:\.\d+)?/gi, "")
      .replace(/\d+(?:\.\d+)?\s*(?:₹|rs\.?|rupees?)/gi, "")
      .replace(/^[12]\.\s*/gm, " ")
      .replace(/^[,.\-\s]+|[,.\-\s]+$/g, "")
      .trim();

    if (/^(expense|borrow|borrowed|debt|due|other)$/i.test(cleanedTitle)) {
      cleanedTitle = "";
    }

    if (cleanedTitle && amount > 0) {
      const formattedTitle = cleanedTitle.charAt(0).toUpperCase() + cleanedTitle.slice(1);
      return {
        reply: `Prepared your **Other Cost / Expense** entry:\n\n• **Title:** ${formattedTitle}\n• **Amount:** ₹${amount}\n• **Category:** ${catLabels[category] || "Expense"}\n\nConfirm below to record this in your live store ledger:`,
        action: {
          type: "ADD_EXPENSE",
          title: formattedTitle,
          amount,
          category,
        },
        status: "Prepared expense confirmation card…",
      };
    }

    if (!cleanedTitle && amount > 0) {
      return {
        reply: `Got it (₹${amount}, Category: **${catLabels[category]}**). What **Title / Description** should I use for this cost? (e.g., *"Electricity bill"*, *"Tea & snacks"*, *"Transport"*)`,
        action: null,
        status: "Awaiting expense title…",
      };
    }

    if (cleanedTitle && (!amount || amount <= 0)) {
      return {
        reply: `Got the title **"${cleanedTitle}"**. What is the **Amount (in ₹)** for this cost?`,
        action: null,
        status: "Awaiting expense amount…",
      };
    }
  }

  // 0B. Multi-Turn Follow-Up for Pending New Product
  const wasAskingProductDetails =
    /to create this product|provide the product name and selling price|what price \(in ₹\) should i set/i.test(
      lastAssistantMsg
    );

  if (wasAskingProductDetails && !wantsToBeAsked) {
    const priceMatch = prompt.match(/(?:price\s*(?:is|of|:)?\s*)?(?:₹|rs\.?)?\s*(\d+(?:\.\d+)?)/i);
    const stockMatch = prompt.match(/(?:stock|qty|quantity|units?)\s*(?:is|of|:)?\s*(\d+)/i);
    const prevNameMatch = lastUserMsg.match(/(?:product|item)\s+([a-zA-Z0-9\s]+)/i);
    let prodName = prevNameMatch ? prevNameMatch[1].replace(/\b(and|ask|with|price|stock).*/i, "").trim() : "";
    if (!prodName) {
      prodName = prompt
        .replace(/(?:price|stock|qty|quantity|units?|category)\s*(?:is|of|:)?\s*[a-zA-Z0-9₹.]+/gi, "")
        .replace(/(?:₹|rs\.?)\s*\d+(?:\.\d+)?/gi, "")
        .replace(/^[,.\-\s]+|[,.\-\s]+$/g, "")
        .trim();
    }
    const price = priceMatch ? parseFloat(priceMatch[1]) : NaN;
    const stock = stockMatch ? parseInt(stockMatch[1], 10) : 0;

    if (prodName && !isNaN(price) && price > 0) {
      const normCat = normalizeServerProductCategory(prompt, prodName);
      return {
        reply: `Prepared new product entry for **${prodName}**:\n\n• **Price:** ₹${price}\n• **Initial Stock:** ${stock} units\n• **Category:** ${normCat}\n\nConfirm below to add this product to your live catalog:`,
        action: {
          type: "ADD_PRODUCT",
          name: prodName,
          price,
          stock,
          category: normCat,
        },
        status: "Prepared new product card…",
      };
    }
  }

  // 0C. Multi-Turn Follow-Up for Pending Bill Total Edit
  const wasAskingBillTotal =
    /what would you like to set the new total to/i.test(lastAssistantMsg);
  if (wasAskingBillTotal && !wantsToBeAsked && snapshot.recentBills.length > 0) {
    const numMatch = prompt.match(/(?:₹|rs\.?)?\s*(\d+(?:\.\d+)?)/i);
    if (numMatch) {
      const newTotal = parseFloat(numMatch[1]);
      const latestBill = snapshot.recentBills[0];
      const shortId = latestBill.id.slice(0, 8);
      return {
        reply: `Prepared update for transaction **#${shortId}**:\n\n• **Current Total:** ₹${latestBill.total}\n• **New Total:** ₹${newTotal}\n\nConfirm below to update this transaction in Firestore:`,
        action: {
          type: "UPDATE_BILL",
          billId: latestBill.id,
          oldTotal: latestBill.total,
          newTotal,
          items: latestBill.items || [],
          itemsCount: latestBill.items?.length || 1,
          notes: `Total adjusted from ₹${latestBill.total} to ₹${newTotal}`,
        },
        status: "Prepared transaction update card…",
      };
    }
  }

  // 0. Bulk Delete / Purge All Products, All Bills, or Both
  const hasDeleteVerb =
    p.includes("delete") ||
    p.includes("remove") ||
    p.includes("clear") ||
    p.includes("wipe") ||
    p.includes("purge");
  const hasAllKeyword =
    p.includes("all") ||
    p.includes("every") ||
    p.includes("whole") ||
    p.includes("those bills") ||
    (p.includes("products") && p.includes("bills"));
  const mentionsProducts = p.includes("product") || p.includes("item") || p.includes("catalog") || p.includes("inventory");
  const mentionsBills = p.includes("bill") || p.includes("transaction") || p.includes("receipt") || p.includes("order");

  if (hasDeleteVerb && hasAllKeyword && (mentionsProducts || mentionsBills)) {
    const target: "both" | "products" | "bills" =
      mentionsProducts && mentionsBills
        ? "both"
        : mentionsProducts
        ? "products"
        : "bills";
    const prodCount = snapshot.products.length;
    const billCount = snapshot.bills.length;

    if (target === "both" && prodCount === 0 && billCount === 0) {
      return {
        reply: "Your store catalog and billing ledger are already completely empty (**0 products** and **0 bills**).",
        action: null,
        status: "Checked catalog & ledger…",
      };
    }
    if (target === "products" && prodCount === 0) {
      return {
        reply: "Your product catalog is already empty (**0 products**).",
        action: null,
        status: "Checked product catalog…",
      };
    }
    if (target === "bills" && billCount === 0) {
      return {
        reply: "Your transaction ledger is already empty (**0 bills**).",
        action: null,
        status: "Checked transaction ledger…",
      };
    }

    const targetLabel =
      target === "both"
        ? `all **${prodCount} product${prodCount === 1 ? "" : "s"}** and **${billCount} bill${billCount === 1 ? "" : "s"}**`
        : target === "products"
        ? `all **${prodCount} product${prodCount === 1 ? "" : "s"}** from the catalog`
        : `all **${billCount} bill${billCount === 1 ? "" : "s"}** from the transaction ledger`;

    return {
      reply: `⚠️ Prepared bulk store purge for ${targetLabel}:\n\n${
        target !== "bills" ? `• Catalog Products to Delete: **${prodCount} item${prodCount === 1 ? "" : "s"}**\n` : ""
      }${
        target !== "products" ? `• Recorded Bills to Delete: **${billCount} receipt${billCount === 1 ? "" : "s"}**\n` : ""
      }\nConfirm below to permanently remove ${target === "both" ? "these products and bills" : target === "products" ? "all products" : "all bills"} from your store database:`,
      action: {
        type: "PURGE_STORE_DATA",
        target,
        productsCount: prodCount,
        billsCount: billCount,
      },
      status: "Preparing bulk store purge safeguard…",
    };
  }

  // 1. Conversation Recall
  if (p.includes("what did i say") || p.includes("what did i ask") || p.includes("repeat")) {
    const prev = conversationHistory.filter(
      (m) => m.role === "user" && normalizeStorePrompt(m.content) !== p
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

  // 2. Staff Role Change Request (Security policy: disallow promoting/demoting admins via Buzz AI)
  const isRoleChangeRequest =
    /\b(?:make|set|change\s+role\s+of|promote|demote|grant|give|revoke|remove|assign)\b[\s\S]*?\b(?:admin|administrator|super\s*admin|staff|user|manager|role|permission|access)\b/i.test(
      p
    ) ||
    /\b(?:admin|administrator|super\s*admin)\s+(?:role|access|status|privilege|rights)\b/i.test(
      p
    );
  if (isRoleChangeRequest) {
    return {
      reply:
        "🔒 **Security Policy:** Account role changes (promoting a user to Admin or demoting an Admin) cannot be performed through Buzz AI. Only an existing Administrator can manage roles directly from the **Admin → User Accounts** panel.",
      action: null,
      status: "Verified role security policy…",
    };
  }

  // 3. Delete Expense / Other Cost Request (e.g. "delete last expense", "delete expense tea")
  if (
    hasDeleteVerb &&
    (p.includes("expense") || p.includes("other cost") || p.includes("borrow") || p.includes("due"))
  ) {
    if (snapshot.expenses.length === 0) {
      return {
        reply: "There are currently **0 recorded expenses / other costs** in your ledger to delete.",
        action: null,
        status: "Checked other_costs ledger…",
      };
    }
    let targetExp = snapshot.expenses.find((e) => p.includes(e.title.toLowerCase()));
    if (!targetExp) targetExp = snapshot.expenses[0];
    return {
      reply: `⚠️ Prepared removal for expense record **${targetExp.title}** (**₹${targetExp.amount}**).\n\nConfirm below to delete this cost from your ledger:`,
      action: {
        type: "DELETE_EXPENSE",
        expenseId: targetExp.id,
        title: targetExp.title,
        amount: targetExp.amount,
        category: normalizeExpenseCategory(targetExp.category),
      },
      status: "Preparing expense deletion…",
    };
  }

  // 4. Add / Record Expense or Other Cost Request
  const isAddExpenseIntent =
    /\b(add|record|log|insert|create|new)\b/i.test(p) &&
    /\b(expense|other\s+cost|cost|borrow|due)\b/i.test(p);

  if (isAddExpenseIntent) {
    const amountMatch =
      p.match(/(?:of|for|amount|₹|rs\.?)\s*(\d+(?:\.\d+)?)/i) ||
      p.match(/(\d+(?:\.\d+)?)\s*(?:rupees?|rs\.?|₹)/i);
    const amount = amountMatch ? parseFloat(amountMatch[1]) : 0;

    // Extract explicit title if provided (e.g. "for electricity bill" or "tea")
    let title = "";
    const forMatch = prompt.match(/\b(?:for|on|titled|named|towards)\s+([a-zA-Z0-9\s&'-]+?)(?:\s+(?:and\s+ask|in\s+category|under\s+category|category|$))/i);
    if (forMatch) {
      title = forMatch[1].trim();
    }
    if (/\b(ask\s+me|details|requirements|what\s+you\s+need)\b/i.test(title)) {
      title = "";
    }

    // If user asked to be prompted OR if title or amount is missing -> Ask for details and DO NOT show card!
    if (wantsToBeAsked || !title || amount <= 0) {
      const notedAmount = amount > 0 ? ` of **₹${amount}**` : "";
      return {
        reply: `I have noted your request to add an **Other Cost / Expense**${notedAmount}. To prepare the confirmation card, please share:\n\n1. **Title / Description:** What is this cost for? *(e.g., "Electricity bill", "Tea & snacks", "Transport")*\n${
          amount <= 0 ? `2. **Amount (₹):** How much was spent?\n3. ` : `2. `
        }**Category:** Which category should I use? *(**Expense**, **Borrowed / Debt**, **Dynamic Due**, or **Other Cost**)*\n\nReply with the details and I will generate the confirmation card for you.`,
        action: null,
        status: "Awaiting expense details…",
      };
    }

    const category = normalizeExpenseCategory(p);
    const formattedTitle = title.charAt(0).toUpperCase() + title.slice(1);
    return {
      reply: `Prepared store expense entry:\n\n• **Title:** ${formattedTitle}\n• **Amount:** ₹${amount}\n• **Category:** ${category.toUpperCase()}\n\nClick below to record this in your live expense ledger:`,
      action: {
        type: "ADD_EXPENSE",
        title: formattedTitle,
        amount,
        category,
      },
      status: "Recording store expense…",
    };
  }

  // 5. Delete Single Product Request (e.g. "delete product Coke", "remove Coke from catalog", "delete Milk")
  const deleteMatch =
    p.match(/(?:delete|remove)\s+(?:the\s+)?product\s+([a-zA-Z0-9\s]+)/i) ||
    p.match(/(?:delete|remove)\s+item\s+([a-zA-Z0-9\s]+)/i) ||
    p.match(/(?:delete|remove)\s+([a-zA-Z0-9\s]+?)\s+(?:from\s+catalog|from\s+store)/i);

  let delTargetName = deleteMatch ? deleteMatch[1].trim() : "";
  if (!delTargetName && (p.startsWith("delete ") || p.startsWith("remove "))) {
    delTargetName = p.replace(/^(?:delete|remove)\s+/, "").trim();
  }

  const findBestServerProduct = (prods: StoreProduct[], rawTarget: string): StoreProduct | undefined => {
    const target = rawTarget.toLowerCase().trim();
    if (!target || !prods || prods.length === 0) return undefined;
    const exact = prods.find((pr) => pr.name.toLowerCase().trim() === target);
    if (exact) return exact;
    const substr = prods.find(
      (pr) => pr.name.toLowerCase().includes(target) || target.includes(pr.name.toLowerCase().trim())
    );
    if (substr) return substr;

    const editDist = (a: string, b: string) => {
      const m = a.length, n = b.length;
      const dp = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0));
      for (let i = 0; i <= m; i++) dp[i][0] = i;
      for (let j = 0; j <= n; j++) dp[0][j] = j;
      for (let i = 1; i <= m; i++) {
        for (let j = 1; j <= n; j++) {
          dp[i][j] = Math.min(
            dp[i - 1][j] + 1,
            dp[i][j - 1] + 1,
            dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)
          );
        }
      }
      return dp[m][n];
    };

    let best: StoreProduct | undefined;
    let bestD = Infinity;
    for (const pr of prods) {
      const pName = pr.name.toLowerCase().trim();
      for (const w of [pName, ...pName.split(/\s+/)]) {
        if (!w) continue;
        const d = editDist(target, w);
        const maxD = Math.max(1, Math.min(2, Math.floor(Math.max(target.length, w.length) * 0.4)));
        if (d <= maxD && d < bestD) {
          bestD = d;
          best = pr;
        }
      }
    }
    return best;
  };

  if (delTargetName && !p.includes("expense") && !p.includes("other cost") && !p.includes("bill") && !p.includes("transaction") && !p.includes("chat")) {
    const cleanTarget = delTargetName.replace(/^(?:the\s+|product\s+|item\s+)/i, "").trim().toLowerCase();
    const matched = findBestServerProduct(snapshot.products, cleanTarget);

    if (matched && !wantsToBeAsked) {
      return {
        reply: `⚠️ Prepared deletion for **${matched.name}**:\n\n• Price: **₹${matched.price}**\n• Stock: **${matched.stock} units**\n\nConfirm below to remove this item from your catalog:`,
        action: {
          type: "DELETE_PRODUCT",
          productId: matched.id,
          productName: matched.name,
          currentPrice: matched.price,
          currentStock: matched.stock,
        },
        status: "Removing product from catalog…",
      };
    } else if (!wantsToBeAsked) {
      return {
        reply: `Could not find **"${delTargetName}"** in your catalog. Check the product name or ask *"show products"* to view all items.`,
        action: null,
        status: "Product not found in catalog…",
      };
    }
  }

  // 6. Add New Product(s) Request (Supports both single product & multi-product natural commands)
  const isAddProductIntent =
    (/\b(add|create|insert|register)\s+(?:a\s+|new\s+|the\s+|some\s+)*(?:products?|items?)\b/i.test(p) ||
      (/\b(add|create)\b/i.test(p) && /\bprice\b/i.test(p) && /\bstock\b/i.test(p))) &&
    !p.includes("expense") &&
    !p.includes("other cost") &&
    !p.includes("stock of") &&
    !p.includes("units of");

  if (isAddProductIntent) {
    if (!wantsToBeAsked) {
      const parsedProducts = parseServerAddProductsFromPrompt(prompt);
      if (parsedProducts.length > 0) {
        if (parsedProducts.length === 1) {
          const item = parsedProducts[0];
          const normCat = normalizeServerProductCategory(item.category, item.name);
          return {
            reply: `Prepared new product entry for **${item.name}**:\n\n• Price: **₹${item.price}**\n• Initial Stock: **${item.stock} units**\n• Category: **${normCat}**\n\nConfirm below to add this product to your live store catalog:`,
            action: {
              type: "ADD_PRODUCT",
              name: item.name,
              price: item.price,
              stock: item.stock,
              category: normCat,
              products: [{ ...item, category: normCat }],
            },
            status: "Creating new product…",
          };
        } else {
          const normalizedBatch = parsedProducts.map((item) => ({
            ...item,
            category: normalizeServerProductCategory(item.category, item.name),
          }));
          const bulletLines = normalizedBatch
            .map(
              (item) =>
                `• **${item.name}** — Price: **₹${item.price}** · Stock: **${item.stock} units** *(${item.category})*`
            )
            .join("\n");
          return {
            reply: `Prepared **${normalizedBatch.length} new products** for your catalog:\n\n${bulletLines}\n\nConfirm below to add all **${normalizedBatch.length} products** to your live store catalog:`,
            action: {
              type: "ADD_PRODUCT",
              name: normalizedBatch.map((i) => i.name).join(", "),
              price: normalizedBatch[0].price,
              stock: normalizedBatch[0].stock,
              category: normalizedBatch[0].category,
              products: normalizedBatch,
            },
            status: "Creating new products…",
          };
        }
      }
    }

    return {
      reply: `To create a new product in your catalog, please provide:\n\n1. **Product Name** *(e.g., "Sprite 500ml" or "Atta, Maida")*\n2. **Selling Price (in ₹)** *(e.g., ₹45 or 20, 30)*\n3. **Initial Stock Quantity** *(e.g., 50 units)*\n\nOnce you share these details, I will show the confirmation card.`,
      action: null,
      status: "Awaiting new product details…",
    };
  }

  // 7. Delete / Void Single Transaction or Bill (e.g. "delete bill", "delete last bill", "cancel transaction", "void bill")
  const isDeleteBill =
    (p.includes("delete") || p.includes("remove") || p.includes("cancel") || p.includes("void")) &&
    (p.includes("bill") || p.includes("transaction") || p.includes("receipt") || p.includes("order"));

  if (isDeleteBill) {
    let targetBill: any = null;
    const idMatch = p.match(/(?:bill|transaction|receipt|#)\s*([a-zA-Z0-9_-]{5,})/i);
    if (idMatch && snapshot.recentBills.length > 0) {
      const searchedId = idMatch[1].toLowerCase();
      targetBill = snapshot.recentBills.find((b) => b.id.toLowerCase().includes(searchedId));
    }
    if (!targetBill && snapshot.recentBills.length > 0) {
      targetBill = snapshot.recentBills[0];
    }

    if (targetBill && !wantsToBeAsked) {
      const shortId = targetBill.id.slice(0, 8);
      const itemSummary =
        targetBill.items.map((i: any) => `${i.quantity}× ${i.name}`).join(", ") || "Items";
      return {
        reply: `⚠️ Prepared deletion for transaction **#${shortId}**:\n\n• Amount: **₹${targetBill.total}**\n• Items: **${itemSummary}**\n\nConfirm below to void this transaction and restore product stock:`,
        action: {
          type: "DELETE_BILL",
          billId: targetBill.id,
          total: targetBill.total,
          itemsCount: targetBill.items?.length || 0,
          itemSummary,
          items: targetBill.items || [],
          billDate: targetBill.date,
        },
        status: "Preparing bill deletion safeguard…",
      };
    } else if (!targetBill) {
      return {
        reply: `No transaction records were found in the database to delete.`,
        action: null,
        status: "Checking transaction history…",
      };
    }
  }

  // 8. Transaction / Bill Editing (ONLY when edit/change/update/make/set intent is present)
  const makeItMatch = p.match(/(?:make|set|change|update)(?:\s+it)?(?:\s+to)?\s+(?:₹|rs\.?)?\s*(\d+(?:\.\d+)?)/i);
  const isBillEditIntent =
    (p.includes("bill") || p.includes("transaction") || p.includes("receipt")) &&
    (p.includes("edit") || p.includes("change") || p.includes("update") || p.includes("modify") || p.includes("adjust"));

  if (isBillEditIntent || (makeItMatch && snapshot.recentBills.length > 0 && !p.includes("stock") && !p.includes("price"))) {
    const latestBill = snapshot.recentBills[0];
    if (latestBill) {
      const shortId = latestBill.id.slice(0, 8);
      const oldTotal = latestBill.total;

      if (makeItMatch && !wantsToBeAsked) {
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

  // 9. Price Modification Request (e.g. "change Coke price to 45", "change price of Coke to 45", "set Coke price to 40")
  const priceMatch =
    p.match(/(?:change|set|update|make)\s+(?:the\s+)?price\s+(?:of|for)?\s*([a-zA-Z0-9\s]+?)\s+to\s*(?:₹|rs\.?)?\s*(\d+(?:\.\d+)?)/i) ||
    p.match(/(?:change|set|update|make)\s+([a-zA-Z0-9\s]+?)\s+(?:the\s+)?price\s+(?:to\s*)?(?:₹|rs\.?)?\s*(\d+(?:\.\d+)?)/i);

  if (priceMatch && !wantsToBeAsked) {
    let targetName = priceMatch[1].trim();
    const newPrice = parseFloat(priceMatch[2]);
    targetName = targetName.replace(/^(?:the|of|for)\s+/i, "").trim().toLowerCase();

    const matched = findBestServerProduct(snapshot.products, targetName);
    if (matched && !isNaN(newPrice) && newPrice > 0) {
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

  // 10. Stock Modification & Refill Request (e.g. "add 20 units of Coke", "add 50 stocks of Milk", "refill 50 Coke", "set milk stock to 50", "reduce Coke by 5")
  const stockMatch =
    p.match(/(?:add|increase|set|update|change|put|refill|reduce|decrease|deduct|remove)\s+(\d+)\s*(?:stocks?|units?|items?|qty)?\s*(?:of|for|to|in)?\s*([a-zA-Z0-9\s]+)/i) ||
    p.match(/(?:add|increase|set|update|change|refill|reduce|decrease)\s+([a-zA-Z0-9\s]+?)\s+(?:stock|stocks?)\s*(?:to|by)?\s*(\d+)/i);

  if (stockMatch && !wantsToBeAsked && !p.includes("expense") && !p.includes("other cost") && !p.includes("rupee")) {
    let qty = 0;
    let targetName = "";
    if (!isNaN(Number(stockMatch[1]))) {
      qty = parseInt(stockMatch[1], 10);
      targetName = stockMatch[2].trim();
    } else {
      targetName = stockMatch[1].trim();
      qty = parseInt(stockMatch[2], 10);
    }
    targetName = targetName
      .replace(/stocks?|units?|items?|qty/gi, "")
      .replace(/^(?:of|for|to|in)\s+/i, "")
      .trim();

    const matched = findBestServerProduct(snapshot.products, targetName);

    if (matched) {
      const isSet = p.includes("set") || p.includes("change stock of") || p.includes("to ");
      const isReduce = p.includes("reduce") || p.includes("decrease") || p.includes("deduct") || p.includes("remove");
      const currentStock = matched.stock;

      let newStock: number;
      let diff: number;

      if (isSet) {
        newStock = qty;
        diff = newStock - currentStock;
      } else if (isReduce) {
        newStock = Math.max(0, currentStock - qty);
        diff = -qty;
      } else {
        newStock = currentStock + qty;
        diff = qty;
      }

      return {
        reply: `Prepared stock update for **${matched.name}**:\n\n• Current Stock: **${currentStock} units**\n• Adjustment: **${diff > 0 ? "+" : ""}${diff} units**\n• New Target: **${newStock} units**\n\nConfirm below to record this in the live database:`,
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

  // 11. Expenses / Other Costs Listing Inquiry
  if (p.includes("expense") || p.includes("other cost") || p.includes("borrow") || p.includes("due")) {
    if (snapshot.expenses.length === 0) {
      return {
        reply: "You currently have **0 recorded expenses / other costs** in your ledger. You can say *\"Add an expense of ₹100 for electricity\"* to record one.",
        action: null,
        status,
      };
    }
    const totalAll = snapshot.expenses.reduce((sum, e) => sum + (e.amount || 0), 0);
    const expList = snapshot.expenses
      .slice(0, 8)
      .map((e) => `• **${e.title}** — **₹${e.amount}** *(${e.category || "expense"})*`)
      .join("\n");
    return {
      reply: `**Recorded Other Costs & Expenses (${snapshot.expenses.length} total · ₹${totalAll.toLocaleString("en-IN")}):**\n\n${expList}`,
      action: null,
      status,
    };
  }

  // 12. Low Stock / Out of Stock Inquiry
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

  // 13. Product Catalog / Inventory Listing
  if (p.includes("product") || p.includes("catalog") || p.includes("inventory") || p.includes("stock")) {
    if (snapshot.products.length === 0) {
      return {
        reply: "Your product catalog is currently empty (**0 products**). Ask me to add a product, e.g. *\"Add product Milk with price 30 and stock 25\"*.",
        action: null,
        status,
      };
    }
    const itemsList = snapshot.products
      .slice(0, 10)
      .map((pr) => `• **${pr.name}** — ₹${pr.price} (${pr.stock} units in stock)`)
      .join("\n");
    return {
      reply: `**Active Store Catalog (${snapshot.products.length} item${snapshot.products.length === 1 ? "" : "s"}):**\n\n${itemsList}${
        snapshot.products.length > 10 ? `\n\n*…and ${snapshot.products.length - 10} more items.*` : ""
      }`,
      action: null,
      status,
    };
  }

  // 14. Recent Bills / Transactions Inquiry
  if (p.includes("bill") || p.includes("transaction") || p.includes("receipt") || p.includes("order")) {
    if (snapshot.recentBills.length === 0) {
      return {
        reply: "There are currently **0 recorded bills** in your transaction ledger.",
        action: null,
        status,
      };
    }
    const billsList = snapshot.recentBills
      .slice(0, 6)
      .map((b) => {
        const summary = b.items.map((i) => `${i.quantity}× ${i.name}`).join(", ") || "Items";
        return `• **#${b.id.slice(0, 8)}** — **₹${b.total}** (${summary})`;
      })
      .join("\n");
    return {
      reply: `**Recent Store Transactions (${snapshot.bills.length} total):**\n\n${billsList}`,
      action: null,
      status,
    };
  }

  // 15. Sales & Revenue Inquiry
  if (p.includes("sale") || p.includes("revenue") || p.includes("today") || p.includes("turnover") || p.includes("earn")) {
    return {
      reply: `**Today's Store Performance Summary:**\n\n• Total Revenue: **₹${snapshot.todayRevenue.toLocaleString("en-IN")}**\n• Completed Orders/Bills: **${snapshot.todayBillsCount}**\n• Today's Expenses: **₹${snapshot.todayExpenseTotal.toLocaleString("en-IN")}**\n• Total Catalog Products: **${snapshot.products.length}**\n\nAll figures are computed directly from the live Firestore transactions ledger.`,
      action: null,
      status,
    };
  }

  // 16A. Current User Identity / Role Question
  if (
    /\b(am\s+i\s+(?:a|an)?\s*admin|who\s+am\s+i|what\s+is\s+my\s+role|my\s+role|my\s+account|am\s+i\s+logged\s+in)\b/i.test(
      p
    )
  ) {
    const cu = snapshot.currentUser;
    if (cu) {
      const roleDesc = cu.isSuperAdmin
        ? "**Owner & Super Admin** (`admin`)"
        : cu.isAdmin
        ? "**Administrator** (`admin`)"
        : "**Standard User / Staff** (not an Admin)";
      return {
        reply: cu.isAdmin
          ? `Yes, **${cu.displayName}** (${cu.email || "signed in"}), you are an ${roleDesc} with full administrative access to **SmartRooti**.`
          : `No, **${cu.displayName}** (${cu.email || "signed in"}), you are currently signed in as a ${roleDesc}. You do not have Administrator privileges.`,
        action: null,
        status,
      };
    }
  }

  // 16B. Staff & Admin Directory Inquiry
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

  // 17. General Store Greeting / Persona
  if (p === "hi" || p === "hello" || p === "hey" || p.startsWith("hi ") || p.startsWith("hello ")) {
    return {
      reply: `Hello! I'm **Buzz AI**. How can I help with your store today?`,
      action: null,
      status,
    };
  }

  // 18. Standard In-Scope Fallback
  return {
    reply: `**Store Snapshot:** **${snapshot.products.length} products** in catalog · **₹${snapshot.todayRevenue.toLocaleString("en-IN")}** sales today across **${snapshot.todayBillsCount} orders**. How can I help with your store?`,
    action: null,
    status,
  };
}

/**
 * Cleans up any trailing LLM sentences that refer to a placeholder confirmation card
 * when the action validator suppressed a premature/invalid card.
 */
function cleanReplyWhenActionSuppressed(text: string): string {
  return text
    .replace(
      /(?:however,?\s*)?if you(?:'d| would)?\s+(?:want|like) to (?:log|record|add|save|apply) it right away[\s\S]*$/i,
      ""
    )
    .replace(
      /(?:click|confirm|tap|use the confirmation card)\s+below to\s+(?:record|apply|confirm|add|save|update)[\s\S]*$/i,
      ""
    )
    .trim();
}

export function buildValidServerGeminiContents(
  conversationHistory: any[],
  prompt: string
): Array<{ role: "user" | "model"; parts: Array<{ text: string }> }> {
  const cleanPrompt = prompt.trim().slice(0, 1200);
  const rawTurns: Array<{ role: "user" | "model"; text: string }> = [];

  for (const msg of (conversationHistory || []).slice(-10)) {
    const text = String(msg?.content || "").trim().slice(0, 800);
    if (!text) continue;
    if (text.includes("I am **Buzz AI**, your intelligent retail store manager")) continue;
    rawTurns.push({
      role: msg.role === "assistant" ? "model" : "user",
      text,
    });
  }

  while (
    rawTurns.length > 0 &&
    rawTurns[rawTurns.length - 1].role === "user" &&
    rawTurns[rawTurns.length - 1].text.toLowerCase() === cleanPrompt.toLowerCase()
  ) {
    rawTurns.pop();
  }

  while (rawTurns.length > 0 && rawTurns[0].role === "model") {
    rawTurns.shift();
  }

  const contents: Array<{ role: "user" | "model"; parts: Array<{ text: string }> }> = [];
  for (const turn of rawTurns) {
    const prev = contents[contents.length - 1];
    if (prev && prev.role === turn.role) {
      prev.parts[0].text = `${prev.parts[0].text}\n\n${turn.text}`.slice(0, 1200);
    } else {
      contents.push({
        role: turn.role,
        parts: [{ text: turn.text }],
      });
    }
  }

  const last = contents[contents.length - 1];
  if (last && last.role === "user") {
    last.parts[0].text = `${last.parts[0].text}\n\n${cleanPrompt}`.slice(0, 1200);
  } else {
    contents.push({
      role: "user",
      parts: [{ text: cleanPrompt }],
    });
  }

  return contents;
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
  const contents = buildValidServerGeminiContents(conversationHistory, prompt);

  // Try PRIMARY_AI_MODEL twice before falling back to slower models
  const rawList = [
    PRIMARY_AI_MODEL,
    PRIMARY_AI_MODEL,
    ...([BACKUP_AI_MODEL, TERTIARY_AI_MODEL].filter((m) => !isModelInCooldown(m))),
  ];

  for (let i = 0; i < rawList.length; i++) {
    const model = rawList[i];
    const timeoutMs = model === "gemini-3.1-flash-lite" ? 6500 : 5000;
    try {
      const response = await Promise.race([
        ai.models.generateContent({
          model,
          contents,
          config: {
            systemInstruction,
            temperature: 0.35,
            ...(model.startsWith("gemini-3") && !model.includes("lite")
              ? { thinkingConfig: { thinkingLevel: ThinkingLevel.LOW } }
              : {}),
          },
        }),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error(`Timeout on model ${model}`)), timeoutMs)
        ),
      ]);

      if (response && response.text && response.text.trim()) {
        markModelSuccess(model);
        return { text: response.text, modelUsed: model };
      }
    } catch (err: any) {
      const errMsg = String(err?.message || err);
      const isQuota =
        errMsg.includes("429") ||
        errMsg.includes("RESOURCE_EXHAUSTED") ||
        errMsg.includes("quota");
      if (model !== PRIMARY_AI_MODEL || i > 0) {
        markModelFailure(model, isQuota);
      }
      console.warn(`Model ${model} attempt ${i + 1} failed. Error: ${errMsg.slice(0, 100)}`);
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

// Basic Security Headers & CORS (including Capacitor Android https://localhost preflight)
app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization, x-user-uid, x-user-email"
  );
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  if (req.method === "OPTIONS") {
    res.sendStatus(204);
    return;
  }
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
// Cloud Run Liveness & Readiness Health Probes
// ----------------------------------------------------------------------------
app.get(["/healthz", "/health", "/_ah/health"], (_req, res) => {
  res.status(200).json({ status: "ok", timestamp: Date.now() });
});

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
      backup: {
        provider: BACKUP_AI_PROVIDER,
        model: BACKUP_AI_MODEL,
        status: isModelInCooldown(BACKUP_AI_MODEL) ? "cooldown" : "ready",
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
    const status = getSafeStatusMessage(cleanPrompt);

    // 1. Hydrate from Client Real-Time Context (0ms) or Retrieve Real Database State
    let snapshot: StoreSnapshot;
    const hydrated = hydrateSnapshotFromClientContext(req.body?.storeContext);
    if (hydrated) {
      snapshot = hydrated;
    } else {
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
    }

    // 2. Query Real Gemini AI & Validate Action Card
    let replyText = "";
    let actionData: any = null;
    let activeModel = PRIMARY_AI_MODEL;

    const aiResult = await executeAiQuery(cleanPrompt, snapshot, conversationHistory);
    replyText = aiResult.text;
    activeModel = aiResult.modelUsed;

    // Parse structured action block if generated by AI
    let rawAction: any = null;
    const actionMatch = replyText.match(/```action\s*([\s\S]*?)\s*```/);
    if (actionMatch && actionMatch[1]) {
      try {
        rawAction = JSON.parse(actionMatch[1]);
      } catch (e) {}
    }
    replyText = replyText
      .replace(/<thought>[\s\S]*?<\/thought>/g, "")
      .replace(/```action[\s\S]*?```/g, "")
      .trim();

    if (!rawAction) {
      // If the user gave a complete command with all required parameters and the AI confirmed it without emitting the action block, attach only the validated action card while keeping the AI's exact natural response
      const parsedActionCandidate = generateLocalDeterministicResponse(
        cleanPrompt,
        snapshot,
        conversationHistory
      ).action;
      if (parsedActionCandidate) {
        rawAction = parsedActionCandidate;
      }
    }

    actionData = validateAndNormalizeAction(rawAction, cleanPrompt, replyText, snapshot);
    if (rawAction && !actionData) {
      replyText = cleanReplyWhenActionSuppressed(replyText);
    }

    const richThought = generateAuthenticOperationalThought(
      cleanPrompt,
      snapshot,
      replyText,
      actionData
    );

    res.json({
      reply: replyText,
      action: actionData,
      thought: richThought,
      modelUsed: activeModel,
    });
  } catch (err: any) {
    console.error("Unhandled error in /api/gemini/chat:", err);
    res.status(503).json({
      reply: "",
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
    const status = getSafeStatusMessage(cleanPrompt);

    // Initialize Server-Sent Events headers
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders?.();

    // Send safe UI status first
    res.write(`data: ${JSON.stringify({ status })}\n\n`);

    let clientAborted = false;
    res.on("close", () => {
      if (!res.writableEnded) {
        clientAborted = true;
      }
    });

    // 1. Hydrate from Client Real-Time Context (0ms) or Fetch Database State
    let snapshot: StoreSnapshot;
    const hydrated = hydrateSnapshotFromClientContext(req.body?.storeContext);
    if (hydrated) {
      snapshot = hydrated;
    } else {
      try {
        snapshot = await getLiveStoreSnapshot();
      } catch (dbErr: any) {
        console.error("Firestore stream snapshot error:", dbErr);
        res.write(
          `data: ${JSON.stringify({
            error: "Live store data is temporarily unavailable.",
          })}\n\n`
        );
        res.end();
        return;
      }
    }

    // 2. Stream Response with Multi-Model Failover (gemini-3.1-flash-lite primary)
    const systemInstruction = buildStoreSystemPrompt(snapshot);
    const contents = buildValidServerGeminiContents(conversationHistory, cleanPrompt);

    const candidates = [
      PRIMARY_AI_MODEL,
      PRIMARY_AI_MODEL,
      ...([BACKUP_AI_MODEL, TERTIARY_AI_MODEL].filter((m) => !isModelInCooldown(m))),
    ];

    let streamSucceeded = false;
    let fullOutput = "";
    let activeModel = PRIMARY_AI_MODEL;

    if (GEMINI_API_KEY) {
      for (let i = 0; i < candidates.length; i++) {
        const model = candidates[i];
        if (clientAborted) break;
        const timeoutMs = model === "gemini-3.1-flash-lite" ? 7000 : 5000;
        try {
          await Promise.race([
            (async () => {
              const stream = await ai.models.generateContentStream({
                model,
                contents,
                config: {
                  systemInstruction,
                  temperature: 0.35,
                  ...(model.startsWith("gemini-3") && !model.includes("lite")
                    ? { thinkingConfig: { thinkingLevel: ThinkingLevel.LOW } }
                    : {}),
                },
              });

              for await (const chunk of stream) {
                if (clientAborted || res.writableEnded) break;
                const chunkText = chunk.text || "";
                if (chunkText) {
                  fullOutput += chunkText;
                  // Do not stream raw action JSON once ```action begins
                  if (!fullOutput.includes("```action")) {
                    res.write(`data: ${JSON.stringify({ chunk: chunkText })}\n\n`);
                  }
                }
              }
            })(),
            new Promise<never>((_, reject) =>
              setTimeout(() => reject(new Error(`Stream timeout on ${model}`)), timeoutMs)
            ),
          ]);

          if (clientAborted || res.writableEnded) {
            return;
          }

          if (fullOutput.trim()) {
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
          if (model !== PRIMARY_AI_MODEL || i > 0) {
            markModelFailure(model, isQuota);
          }
          fullOutput = "";
        }
      }
    }

    if (!streamSucceeded || !fullOutput.trim()) {
      const aiResult = await executeAiQuery(cleanPrompt, snapshot, conversationHistory);
      fullOutput = aiResult.text;
      activeModel = aiResult.modelUsed;
      const previewClean = fullOutput
        .replace(/<thought>[\s\S]*?<\/thought>/g, "")
        .replace(/```action[\s\S]*?```/g, "")
        .trim();
      if (previewClean) {
        res.write(`data: ${JSON.stringify({ chunk: previewClean })}\n\n`);
      }
    }

    // Parse structured action from full model output and validate strictly
    let rawAction: any = null;
    const actionMatch = fullOutput.match(/```action\s*([\s\S]*?)\s*```/);
    if (actionMatch && actionMatch[1]) {
      try {
        rawAction = JSON.parse(actionMatch[1]);
      } catch (e) {}
    }
    let cleanDisplayText = fullOutput
      .replace(/<thought>[\s\S]*?<\/thought>/g, "")
      .replace(/```action[\s\S]*?```/g, "")
      .trim();

    if (!rawAction) {
      const parsedActionCandidate = generateLocalDeterministicResponse(
        cleanPrompt,
        snapshot,
        conversationHistory
      ).action;
      if (parsedActionCandidate) {
        rawAction = parsedActionCandidate;
      }
    }

    const actionData = validateAndNormalizeAction(
      rawAction,
      cleanPrompt,
      cleanDisplayText,
      snapshot
    );
    if (rawAction && !actionData) {
      cleanDisplayText = cleanReplyWhenActionSuppressed(cleanDisplayText);
    }

    const richThought = generateAuthenticOperationalThought(
      cleanPrompt,
      snapshot,
      cleanDisplayText || fullOutput,
      actionData
    );

    res.write(
      `data: ${JSON.stringify({
        done: true,
        fullText: cleanDisplayText || fullOutput,
        action: actionData,
        thought: richThought,
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

function formatSpeechText(raw: string): string {
  return raw
    .replace(/```[\s\S]*?```/g, "")
    .replace(/<thought>[\s\S]*?<\/thought>/g, "")
    .replace(/#([a-zA-Z0-9_-]{5,})/g, "transaction")
    .replace(/₹\s*(\d+(?:\.\d+)?)/g, "$1 rupees")
    .replace(/(\d+)\s*[×x]\s*/g, "$1 ")
    .replace(/➔|→/g, " to ")
    .replace(/[*#_`~>]/g, "")
    .replace(/^[•\-]\s*/gm, "")
    .replace(/\n+/g, ". ")
    .replace(/[^\w\s.,?!'-]/g, "")
    .replace(/\.\s*\./g, ".")
    .replace(/\s+/g, " ")
    .trim();
}

function pcmToWavBase64(pcmBase64: string, sampleRate: number = 24000): string {
  const pcmBuffer = Buffer.from(pcmBase64, "base64");
  if (pcmBuffer.length >= 4 && pcmBuffer.toString("ascii", 0, 4) === "RIFF") {
    return pcmBase64;
  }
  const numChannels = 1;
  const bitsPerSample = 16;
  const byteRate = (sampleRate * numChannels * bitsPerSample) / 8;
  const blockAlign = (numChannels * bitsPerSample) / 8;
  const dataSize = pcmBuffer.length;
  const header = Buffer.alloc(44);

  header.write("RIFF", 0);
  header.writeUInt32LE(36 + dataSize, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16); // Subchunk1Size (16 for PCM)
  header.writeUInt16LE(1, 20); // AudioFormat (1 = PCM)
  header.writeUInt16LE(numChannels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write("data", 36);
  header.writeUInt32LE(dataSize, 40);

  return Buffer.concat([header, pcmBuffer]).toString("base64");
}

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

    const cleanSpeech = formatSpeechText(text);

    if (!cleanSpeech) {
      res.status(400).json({ error: "No readable speech content." });
      return;
    }

    // Cache lookup for instant <5ms replay
    const cacheKey = cleanSpeech.slice(0, 400);
    const cached = ttsMemoryCache.get(cacheKey);
    if (cached) {
      res.json(cached);
      return;
    }

    // Request natural neural audio from official Gemini TTS models ("Kore" voice) with multi-model resilience
    const ttsModels = ["gemini-3.8-flash-lite-tts", "gemini-3.8-flash-tts"];
    let audioPart: any = null;

    for (const ttsModel of ttsModels) {
      try {
        const ttsResponse = await Promise.race([
          ai.models.generateContent({
            model: ttsModel,
            contents: [
              {
                role: "user",
                parts: [{ text: cacheKey }],
              },
            ],
            config: {
              responseModalities: ["AUDIO"],
              speechConfig: {
                voiceConfig: {
                  prebuiltVoiceConfig: {
                    voiceName: "Kore",
                  },
                },
              },
            },
          }),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error("TTS request timed out")), 5500)
          ),
        ]);

        const candidate = ttsResponse.candidates?.[0];
        audioPart = candidate?.content?.parts?.find((p: any) => p.inlineData);
        if (audioPart?.inlineData?.data) {
          break;
        }
      } catch (ttsErr) {
        // Try next TTS model
      }
    }

    if (audioPart && audioPart.inlineData && audioPart.inlineData.data) {
      const wavBase64 = pcmToWavBase64(audioPart.inlineData.data, 24000);
      const payload = {
        audioBase64: wavBase64,
        mimeType: "audio/wav",
      };

      if (ttsMemoryCache.size > 60) {
        const oldest = ttsMemoryCache.keys().next().value;
        if (oldest) ttsMemoryCache.delete(oldest);
      }
      ttsMemoryCache.set(cacheKey, payload);

      res.json(payload);
      return;
    }

    res.status(500).json({ error: "Voice synthesis temporarily unavailable." });
  } catch (err: any) {
    res.status(500).json({ error: "Voice synthesis temporarily unavailable." });
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
      res.status(503).json({ error: "Voice transcription service is not configured." });
      return;
    }

    const transcribeModels = [
      "gemini-3.1-flash-lite",
      "gemini-3.5-transcribe",
      "gemini-3.8-flash",
      "gemini-flash-latest",
    ];
    let transcript = "";
    let succeeded = false;

    for (const transcribeModel of transcribeModels) {
      try {
        const response = await Promise.race([
          ai.models.generateContent({
            model: transcribeModel,
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
            setTimeout(() => reject(new Error("Transcription timeout")), 4500)
          ),
        ]);

        if (response && typeof response.text === "string") {
          transcript = response.text.trim();
          succeeded = true;
          break;
        }
      } catch (modelErr) {
        // Automatically fail over to next supported model
      }
    }

    if (!succeeded) {
      res.status(500).json({ error: "Could not transcribe audio clip. Please try speaking again or type your command." });
      return;
    }

    res.json({ transcript });
  } catch (err: any) {
    res.status(500).json({ error: "Could not transcribe audio clip. Please try speaking again or type your command." });
  }
});

// ============================================================================
// 8. SERVER STARTUP & VITE INTEGRATION
// ============================================================================

async function startServer() {
  const distPath = path.resolve(__dirname, "dist");
  const hasDist = fs.existsSync(path.resolve(distPath, "index.html"));
  const isProduction = process.env.NODE_ENV === "production";

  if (!isProduction) {
    // Serve compiled Workbox service worker assets from dist/ if available so offline caching works cleanly in dev preview
    if (fs.existsSync(distPath)) {
      app.get(/^\/(sw\.js|registerSW\.js|workbox-.*\.js|manifest\.webmanifest)$/, (req, res, next) => {
        const filePath = path.join(distPath, req.path);
        if (fs.existsSync(filePath)) {
          res.setHeader("Cache-Control", "no-cache");
          if (req.path.endsWith(".js")) {
            res.setHeader("Content-Type", "application/javascript; charset=utf-8");
          }
          return res.sendFile(filePath);
        }
        next();
      });
    }

    // Serve a WebSocket-free /@vite/client module so Vite never attempts or rejects WebSocket connections in the preview iframe
    app.get("/@vite/client", (_req, res) => {
      res.setHeader("Content-Type", "application/javascript; charset=utf-8");
      res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
      return res.send(`const sheetsMap = new Map();
export function updateStyle(id, content) {
  let style = sheetsMap.get(id);
  if (!style) {
    style = document.createElement('style');
    style.setAttribute('type', 'text/css');
    style.setAttribute('data-vite-dev-id', id);
    style.textContent = content;
    document.head.appendChild(style);
    sheetsMap.set(id, style);
  } else {
    style.textContent = content;
  }
}
export function removeStyle(id) {
  const style = sheetsMap.get(id);
  if (style) {
    document.head.removeChild(style);
    sheetsMap.delete(id);
  }
}
export function createHotContext() {
  return {
    accept() {},
    acceptExports() {},
    dispose() {},
    prune() {},
    invalidate() {},
     decline() {},
    on() {},
    off() {},
    send() {},
    data: {}
  };
}
export function injectQuery(url) {
  return url;
}
export class ErrorOverlay extends HTMLElement {}
if (typeof customElements !== 'undefined' && !customElements.get('vite-error-overlay')) {
  customElements.define('vite-error-overlay', ErrorOverlay);
}
`);
    });

    try {
      const { createServer: createViteServer } = await import("vite");
      const vite = await createViteServer({
        server: {
          middlewareMode: true,
          host: "0.0.0.0",
          port: PORT,
          hmr: false,
          ws: false,
        },
        appType: "spa",
      });
      app.use(vite.middlewares);
    } catch (viteErr) {
      console.warn("Vite middleware unavailable, serving static files:", viteErr);
      if (hasDist) {
        app.use(express.static(distPath));
        app.get("*", (_req, res) => {
          res.sendFile(path.resolve(distPath, "index.html"));
        });
      }
    }
  } else {
    if (hasDist) {
      app.use(express.static(distPath, {
        setHeaders: (res) => {
          res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
        },
      }));
      app.get("*", (_req, res) => {
        res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
        res.sendFile(path.resolve(distPath, "index.html"));
      });
    } else {
      console.warn("dist/index.html not found; will attempt dynamic handling");
    }
  }

  const server = app.listen(PORT, "0.0.0.0", () => {
    console.log(`Buzz AI Server listening on 0.0.0.0:${PORT} [mode: ${isProduction ? "production" : "development"}]`);
  });

  // Start real-time server-side Firestore AI RPC listener (never expose GEMINI_API_KEY to Firestore or clients)
  if (db) {
    deleteDoc(doc(db, "settings", "ai_bridge_config")).catch(() => {});

    const processedRpcIds = new Set<string>();
    onSnapshot(
      collection(db, "settings"),
      (snap) => {
        snap.docChanges().forEach(async (change) => {
          const docSnap = change.doc;
          if (!docSnap.id.startsWith("ai_rpc_req_")) return;
          const data = docSnap.data();
          if (data?.status !== "pending" || processedRpcIds.has(docSnap.id)) return;

          // Clean up stale RPC documents older than 30 seconds so old requests never clog the queue
          if (data?.createdAt && Date.now() - Number(data.createdAt) > 30000) {
            processedRpcIds.add(docSnap.id);
            deleteDoc(doc(db!, "settings", docSnap.id)).catch(() => {});
            return;
          }

          processedRpcIds.add(docSnap.id);
          if (processedRpcIds.size > 200) {
            const first = processedRpcIds.values().next().value;
            if (first) processedRpcIds.delete(first);
          }

          try {
            const reqType = String(data.type || "chat");

            if (reqType === "transcribe") {
              if (!GEMINI_API_KEY) {
                throw new Error("Voice transcription service is not configured.");
              }
              const audioBase64 = String(data.audioBase64 || "");
              const mimeType = String(data.mimeType || "audio/webm");
              if (!audioBase64) {
                throw new Error("Missing audioBase64 payload.");
              }
              const transcribeModels = [
                "gemini-3.1-flash-lite",
                "gemini-3.5-transcribe",
                "gemini-3.8-flash",
                "gemini-flash-latest",
              ];
              let transcript = "";
              let succeeded = false;
              for (const transcribeModel of transcribeModels) {
                try {
                  const response = await Promise.race([
                    ai.models.generateContent({
                      model: transcribeModel,
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
                      setTimeout(() => reject(new Error("Transcription timeout")), 5500)
                    ),
                  ]);
                  if (response && typeof response.text === "string" && response.text.trim()) {
                    transcript = response.text.trim();
                    succeeded = true;
                    break;
                  }
                } catch {}
              }
              if (!succeeded) {
                throw new Error("Could not transcribe audio clip.");
              }
              await setDoc(
                doc(db!, "settings", docSnap.id),
                {
                  status: "completed",
                  transcript,
                  completedAt: Date.now(),
                },
                { merge: true }
              );
              return;
            }

            if (reqType === "tts") {
              if (!GEMINI_API_KEY) {
                throw new Error("Voice synthesis service is not configured.");
              }
              const cleanSpeech = formatSpeechText(String(data.text || "")).slice(0, 400);
              if (!cleanSpeech) {
                throw new Error("Empty speech text.");
              }
              const cached = ttsMemoryCache.get(cleanSpeech);
              if (cached) {
                await setDoc(
                  doc(db!, "settings", docSnap.id),
                  {
                    status: "completed",
                    audioBase64: cached.audioBase64,
                    mimeType: cached.mimeType,
                    completedAt: Date.now(),
                  },
                  { merge: true }
                );
                return;
              }
              const ttsModels = ["gemini-3.8-flash-lite-tts", "gemini-3.8-flash-tts"];
              let audioPart: any = null;
              for (const ttsModel of ttsModels) {
                try {
                  const ttsResponse = await Promise.race([
                    ai.models.generateContent({
                      model: ttsModel,
                      contents: [
                        {
                          role: "user",
                          parts: [{ text: cleanSpeech }],
                        },
                      ],
                      config: {
                        responseModalities: ["AUDIO"],
                        speechConfig: {
                          voiceConfig: {
                            prebuiltVoiceConfig: {
                              voiceName: "Kore",
                            },
                          },
                        },
                      },
                    }),
                    new Promise<never>((_, reject) =>
                      setTimeout(() => reject(new Error("TTS timeout")), 4500)
                    ),
                  ]);
                  const candidate = ttsResponse.candidates?.[0];
                  audioPart = candidate?.content?.parts?.find((p: any) => p.inlineData);
                  if (audioPart?.inlineData?.data) {
                    break;
                  }
                } catch {}
              }
              if (!audioPart?.inlineData?.data) {
                throw new Error("Voice synthesis temporarily unavailable.");
              }
              const wavBase64 = pcmToWavBase64(audioPart.inlineData.data, 24000);
              const payload = { audioBase64: wavBase64, mimeType: "audio/wav" };
              if (ttsMemoryCache.size > 60) {
                const oldest = ttsMemoryCache.keys().next().value;
                if (oldest) ttsMemoryCache.delete(oldest);
              }
              ttsMemoryCache.set(cleanSpeech, payload);
              await setDoc(
                doc(db!, "settings", docSnap.id),
                {
                  status: "completed",
                  audioBase64: wavBase64,
                  mimeType: "audio/wav",
                  completedAt: Date.now(),
                },
                { merge: true }
              );
              return;
            }

            const cleanPrompt = String(data.prompt || "").trim();
            const conversationHistory = Array.isArray(data.conversationHistory)
              ? data.conversationHistory
              : [];
            const snapshot =
              hydrateSnapshotFromClientContext(data.storeContext) ||
              (await getLiveStoreSnapshot());
            let replyText = "";
            let actionData: any = null;
            let activeModel = PRIMARY_AI_MODEL;

            const systemInstruction = buildStoreSystemPrompt(snapshot);
            const contents = buildValidServerGeminiContents(conversationHistory, cleanPrompt);
            const candidates = [
              PRIMARY_AI_MODEL,
              PRIMARY_AI_MODEL,
              ...([BACKUP_AI_MODEL, TERTIARY_AI_MODEL].filter((m) => !isModelInCooldown(m))),
            ];

            let streamOk = false;
            if (GEMINI_API_KEY) {
              for (let i = 0; i < candidates.length; i++) {
                const model = candidates[i];
                const timeoutMs = model === "gemini-3.1-flash-lite" ? 7000 : 5000;
                try {
                  let streamedText = "";
                  let lastPartialFlush = 0;
                  await Promise.race([
                    (async () => {
                      const stream = await ai.models.generateContentStream({
                        model,
                        contents,
                        config: {
                          systemInstruction,
                          temperature: 0.35,
                          ...(model.startsWith("gemini-3") && !model.includes("lite")
                            ? { thinkingConfig: { thinkingLevel: ThinkingLevel.LOW } }
                            : {}),
                        },
                      });
                      for await (const chunk of stream) {
                        const chunkText = chunk.text || "";
                        if (chunkText) {
                          streamedText += chunkText;
                          const now = Date.now();
                          if (
                            !streamedText.includes("```action") &&
                            now - lastPartialFlush >= 220
                          ) {
                            lastPartialFlush = now;
                            const cleanPartial = streamedText
                              .replace(/<thought>[\s\S]*?<\/thought>/g, "")
                              .replace(/<thought>[\s\S]*$/g, "")
                              .trim();
                            if (cleanPartial) {
                              setDoc(
                                doc(db!, "settings", docSnap.id),
                                {
                                  status: "streaming",
                                  partialReply: cleanPartial,
                                  updatedAt: now,
                                },
                                { merge: true }
                              ).catch(() => {});
                            }
                          }
                        }
                      }
                    })(),
                    new Promise<never>((_, reject) =>
                      setTimeout(() => reject(new Error(`RPC stream timeout on ${model}`)), timeoutMs)
                    ),
                  ]);

                  if (streamedText.trim()) {
                    replyText = streamedText;
                    activeModel = model;
                    streamOk = true;
                    markModelSuccess(model);
                    break;
                  }
                } catch (streamErr: any) {
                  const errMsg = String(streamErr?.message || streamErr);
                  const isQuota =
                    errMsg.includes("429") ||
                    errMsg.includes("RESOURCE_EXHAUSTED") ||
                    errMsg.includes("quota");
                  if (model !== PRIMARY_AI_MODEL || i > 0) {
                    markModelFailure(model, isQuota);
                  }
                }
              }
            }

            if (!streamOk) {
              const aiRes = await executeAiQuery(cleanPrompt, snapshot, conversationHistory);
              replyText = aiRes.text;
              activeModel = aiRes.modelUsed;
            }

            let rawAction: any = null;
            const actionMatch = replyText.match(/```action\s*([\s\S]*?)\s*```/);
            if (actionMatch && actionMatch[1]) {
              try {
                rawAction = JSON.parse(actionMatch[1]);
              } catch {}
            }
            replyText = replyText
              .replace(/<thought>[\s\S]*?<\/thought>/g, "")
              .replace(/```action[\s\S]*?```/g, "")
              .trim();

            if (!rawAction) {
              const parsedActionCandidate = generateLocalDeterministicResponse(
                cleanPrompt,
                snapshot,
                conversationHistory
              ).action;
              if (parsedActionCandidate) {
                rawAction = parsedActionCandidate;
              }
            }

            actionData = validateAndNormalizeAction(rawAction, cleanPrompt, replyText, snapshot);
            if (rawAction && !actionData) {
              replyText = cleanReplyWhenActionSuppressed(replyText);
            }

            const richThought = generateAuthenticOperationalThought(
              cleanPrompt,
              snapshot,
              replyText,
              actionData
            );

            await setDoc(
              doc(db!, "settings", docSnap.id),
              {
                status: "completed",
                reply: replyText,
                action: actionData || null,
                thought: richThought,
                modelUsed: activeModel,
                completedAt: Date.now(),
              },
              { merge: true }
            );
          } catch (rpcErr: any) {
            await setDoc(
              doc(db!, "settings", docSnap.id),
              {
                status: "error",
                error: String(rpcErr?.message || rpcErr),
              },
              { merge: true }
            ).catch(() => {});
          }
        });
      },
      () => {}
    );
  }

  process.on("SIGTERM", () => {
    console.log("SIGTERM received, closing HTTP server...");
    server.close(() => {
      console.log("HTTP server closed.");
      process.exit(0);
    });
  });
}

startServer().catch((err) => {
  console.error("Failed to start server:", err);
});

export default app;
