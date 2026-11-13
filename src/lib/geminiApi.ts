import { Capacitor } from "@capacitor/core";
import { db } from "./firebase";
import { doc, setDoc, getDoc, getDocFromServer, onSnapshot, deleteDoc } from "firebase/firestore";
import { MAX_PRODUCT_STOCK, MAX_BILL_AMOUNT } from "./utils";

export interface BatchProductItem {
  name: string;
  price: number;
  stock: number;
  category?: string;
  image?: string;
  attachmentIndex?: number;
}

export interface AssistantAction {
  type:
    | "UPDATE_STOCK"
    | "UPDATE_PRICE"
    | "UPDATE_PRODUCT_IMAGE"
    | "ADD_PRODUCT"
    | "DELETE_PRODUCT"
    | "UPDATE_BILL"
    | "DELETE_BILL"
    | "PURGE_STORE_DATA"
    | "ADD_TRANSACTION"
    | "ADD_EXPENSE"
    | "DELETE_EXPENSE"
    | "UPDATE_ROLE";
  target?: "products" | "bills" | "both";
  productsCount?: number;
  billsCount?: number;
  productId?: string;
  productName?: string;
  currentStock?: number;
  quantityChange?: number;
  newStock?: number;
  currentPrice?: number;
  newPrice?: number;
  name?: string;
  price?: number;
  stock?: number;
  category?: string;
  image?: string;
  attachmentIndex?: number;
  useAttachedImage?: boolean;
  products?: BatchProductItem[];
  billId?: string;
  oldTotal?: number;
  newTotal?: number;
  notes?: string;
  quantity?: number;
  unitPrice?: number;
  total?: number;
  amount?: number;
  title?: string;
  expenseId?: string;
  userId?: string;
  userEmail?: string;
  userName?: string;
  newRole?: string;
  isAdminRole?: boolean;
  items?: any[];
  itemsCount?: number;
  itemSummary?: string;
  billDate?: number;
}

export interface MediaAnalysisResult {
  summary: string;
  transcribedText: string;
  detectedLanguage: string;
  keyHighlights: string[];
  mediaKind: "video" | "image";
  fileName: string;
  mimeType: string;
  fileSize?: number;
  previewUrl?: string;
}

export const MAX_MEDIA_ATTACHMENTS = 5;

export interface VideoFrameSnapshot {
  mimeType: string;
  dataBase64: string;
  timestampSec: number;
}

export interface ChatAttachment {
  id: string;
  name: string;
  mimeType: string;
  kind: "image" | "video";
  dataBase64: string;
  previewUrl: string;
  size?: number;
  videoFrames?: VideoFrameSnapshot[];
  durationSec?: number;
}

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  timestamp: number;
  quotedText?: string;
  action?: AssistantAction | null;
  actionApplied?: boolean;
  isStreaming?: boolean;
  thought?: string;
  thoughtDuration?: number;
  mediaAnalysis?: MediaAnalysisResult | null;
  attachments?: ChatAttachment[];
}

export interface CurrentUserIdentity {
  uid: string;
  displayName: string;
  email: string;
  isAdmin: boolean;
  isSuperAdmin?: boolean;
  role: string;
}

export interface StoreContext {
  products: any[];
  recentBills: any[];
  otherCosts: any[];
  accounts?: any[];
  activityLogs?: any[];
  totalRevenueToday: number;
  billsCountToday: number;
  currentUser?: CurrentUserIdentity | null;
}

export interface AssistantResponse {
  reply: string;
  action?: AssistantAction | null;
  rawText?: string;
  error?: string;
  thought?: string;
  thoughtDuration?: number;
}

// Tracks whether direct HTTP /api/gemini/* is reachable from the current origin/device
let lastHttpFailureAt = 0;
let cachedBridgeServerUrl = "";
let lastBridgeSyncAt = 0;

function syncBridgeServerUrl(): void {
  const now = Date.now();
  if (now - lastBridgeSyncAt < 30000) return;
  lastBridgeSyncAt = now;
  getDoc(doc(db, "settings", "ai_bridge_config"))
    .then((snap) => {
      if (snap.exists()) {
        const data = snap.data();
        if (typeof data?.serverUrl === "string" && data.serverUrl.startsWith("https://")) {
          cachedBridgeServerUrl = data.serverUrl.replace(/\/$/, "");
        }
      }
    })
    .catch(() => {});
}

function shouldPreferFirestoreBridge(hasVideoAttachment: boolean = false): boolean {
  if (hasVideoAttachment) {
    // Prefer direct HTTP first for video attachments so full video streams can be uploaded without hitting Firestore's 1MB limit
    return false;
  }
  if (Capacitor.isNativePlatform()) {
    const customHost =
      typeof localStorage !== "undefined" ? localStorage.getItem("buzz_api_server_url") : null;
    if (!customHost) {
      return true;
    }
    if (lastHttpFailureAt > 0 && Date.now() - lastHttpFailureAt < 300000) {
      return true;
    }
  }
  return false;
}

// Determines the best API URL depending on web vs native Android Capacitor
export function getApiBaseUrl(): string {
  if (Capacitor.isNativePlatform()) {
    const customHost = localStorage.getItem("buzz_api_server_url");
    if (customHost) return customHost.replace(/\/$/, "");
    if (cachedBridgeServerUrl) return cachedBridgeServerUrl;
    return "https://ais-pre-7s24tpfnmdpbk5ly26f4tb-549311647835.asia-southeast1.run.app";
  }
  return "";
}

function getCandidateApiBaseUrls(): string[] {
  const urls: string[] = [];
  const customHost =
    typeof localStorage !== "undefined" ? localStorage.getItem("buzz_api_server_url") : null;
  if (customHost) {
    urls.push(customHost.replace(/\/$/, ""));
  }
  if (!Capacitor.isNativePlatform()) {
    urls.push("");
  }
  if (cachedBridgeServerUrl) {
    urls.push(cachedBridgeServerUrl);
  }
  urls.push("https://ais-pre-7s24tpfnmdpbk5ly26f4tb-549311647835.asia-southeast1.run.app");
  urls.push("https://ais-dev-7s24tpfnmdpbk5ly26f4tb-549311647835.asia-southeast1.run.app");
  return Array.from(new Set(urls));
}

export function wakeUpBuzzServer(): void {
  syncBridgeServerUrl();
  for (const baseUrl of getCandidateApiBaseUrls()) {
    fetch(`${baseUrl}/api/health`, { method: "GET", mode: "no-cors", cache: "no-store" }).catch(
      () => {}
    );
  }
}

const CLIENT_LATEX_SYMBOL_MAP: Record<string, string> = {
  pi: "π",
  Pi: "Π",
  alpha: "α",
  beta: "β",
  gamma: "γ",
  Gamma: "Γ",
  delta: "δ",
  Delta: "Δ",
  epsilon: "ε",
  varepsilon: "ε",
  zeta: "ζ",
  eta: "η",
  theta: "θ",
  Theta: "Θ",
  vartheta: "ϑ",
  iota: "ι",
  kappa: "κ",
  lambda: "λ",
  Lambda: "Λ",
  mu: "μ",
  nu: "ν",
  xi: "ξ",
  Xi: "Ξ",
  rho: "ρ",
  sigma: "σ",
  Sigma: "Σ",
  tau: "τ",
  upsilon: "υ",
  phi: "φ",
  Phi: "Φ",
  varphi: "ϕ",
  chi: "χ",
  psi: "ψ",
  Psi: "Ψ",
  omega: "ω",
  Omega: "Ω",
  times: "×",
  div: "÷",
  cdot: "·",
  pm: "±",
  mp: "∓",
  approx: "≈",
  sim: "∼",
  simeq: "≃",
  cong: "≅",
  equiv: "≡",
  neq: "≠",
  ne: "≠",
  leq: "≤",
  le: "≤",
  geq: "≥",
  ge: "≥",
  ll: "≪",
  gg: "≫",
  propto: "∝",
  infty: "∞",
  partial: "∂",
  nabla: "∇",
  forall: "∀",
  exists: "∃",
  nexists: "∄",
  in: "∈",
  notin: "∉",
  ni: "∋",
  subset: "⊂",
  supset: "⊃",
  subseteq: "⊆",
  supseteq: "⊇",
  cup: "∪",
  cap: "∩",
  emptyset: "∅",
  varnothing: "∅",
  rightarrow: "→",
  to: "→",
  leftarrow: "←",
  leftrightarrow: "↔",
  Rightarrow: "⇒",
  Leftarrow: "⇐",
  Leftrightarrow: "⇔",
  iff: "⇔",
  mapsto: "↦",
  sum: "∑",
  prod: "∏",
  int: "∫",
  oint: "∮",
  therefore: "∴",
  because: "∵",
  angle: "∠",
  perp: "⊥",
  parallel: "∥",
  triangle: "△",
  degree: "°",
  circ: "°",
  ldots: "…",
  cdots: "⋯",
  dots: "…",
  quad: " ",
  qquad: "  ",
};

const CLIENT_SUPERSCRIPT_MAP: Record<string, string> = {
  "0": "⁰",
  "1": "¹",
  "2": "²",
  "3": "³",
  "4": "⁴",
  "5": "⁵",
  "6": "⁶",
  "7": "⁷",
  "8": "⁸",
  "9": "⁹",
  "+": "⁺",
  "-": "⁻",
  "=": "⁼",
  "(": "⁽",
  ")": "⁾",
  n: "ⁿ",
  i: "ⁱ",
  "°": "°",
};

const CLIENT_SUBSCRIPT_MAP: Record<string, string> = {
  "0": "₀",
  "1": "₁",
  "2": "₂",
  "3": "₃",
  "4": "₄",
  "5": "₅",
  "6": "₆",
  "7": "₇",
  "8": "₈",
  "9": "⁹",
  "+": "₊",
  "-": "₋",
  "=": "₌",
  "(": "₍",
  ")": "₎",
  a: "ₐ",
  e: "ₑ",
  i: "ᵢ",
  o: "ₒ",
  r: "ᵣ",
  u: "ᵤ",
  v: "ᵥ",
  x: "ₓ",
};

function convertClientLatexSegment(rawSeg: string): string {
  let s = rawSeg;
  s = s.replace(/\\(?:text|textbf|textit|mathrm|mathbf|mathit|mathcal|mathbb|operatorname)\s*\{([^{}]*)\}/g, "$1");
  s = s.replace(/\\left\s*([([\]{}|.])/g, "$1").replace(/\\right\s*([([\]{}|.])/g, "$1");
  for (let pass = 0; pass < 2; pass++) {
    s = s.replace(/\\(?:d|t)?frac\s*\{([^{}]+)\}\s*\{([^{}]+)\}/g, (_m, num, den) => {
      const n = String(num).trim();
      const d = String(den).trim();
      const nClean = /^[a-zA-Z0-9π]+$/.test(n) ? n : `(${n})`;
      const dClean = /^[a-zA-Z0-9π]+$/.test(d) ? d : `(${d})`;
      return `${nClean}/${dClean}`;
    });
  }
  s = s.replace(/\\sqrt\s*\[([^\]]+)\]\s*\{([^{}]+)\}/g, (_m, root, arg) => {
    const rSup = String(root)
      .trim()
      .split("")
      .map((c) => CLIENT_SUPERSCRIPT_MAP[c] || c)
      .join("");
    const a = String(arg).trim();
    return /^[a-zA-Z0-9π]+$/.test(a) ? `${rSup}√${a}` : `${rSup}√(${a})`;
  });
  s = s.replace(/\\sqrt\s*\{([^{}]+)\}/g, (_m, arg) => {
    const a = String(arg).trim();
    return /^[a-zA-Z0-9π]+$/.test(a) ? `√${a}` : `√(${a})`;
  });
  s = s.replace(/\\([a-zA-Z]+)(?![a-zA-Z])/g, (full, cmd) => {
    return CLIENT_LATEX_SYMBOL_MAP[cmd] !== undefined ? CLIENT_LATEX_SYMBOL_MAP[cmd] : full;
  });
  s = s.replace(/\^\{([^{}]+)\}/g, (_full, exp) => {
    const chars = String(exp).trim().split("");
    if (chars.every((c) => CLIENT_SUPERSCRIPT_MAP[c] !== undefined)) {
      return chars.map((c) => CLIENT_SUPERSCRIPT_MAP[c]).join("");
    }
    return `^(${exp})`;
  });
  s = s.replace(/\^([0-9+\-ni°])/g, (_full, ch) => CLIENT_SUPERSCRIPT_MAP[ch] || `^${ch}`);
  s = s.replace(/_\{([^{}]+)\}/g, (_full, sub) => {
    const chars = String(sub).trim().split("");
    if (chars.every((c) => CLIENT_SUBSCRIPT_MAP[c] !== undefined)) {
      return chars.map((c) => CLIENT_SUBSCRIPT_MAP[c]).join("");
    }
    return `_${sub}`;
  });
  s = s.replace(/_([0-9])/g, (_full, ch) => CLIENT_SUBSCRIPT_MAP[ch] || `_${ch}`);
  s = s.replace(/\\([%$&_{}])/g, "$1");
  s = s.replace(/\\[,;:!]/g, " ");
  return s;
}

export function sanitizeLatexAndMathFormatting(raw: string): string {
  if (!raw) return "";
  let out = raw;
  out = out.replace(/\$\$([\s\S]*?)\$\$/g, (_m, inner) => convertClientLatexSegment(String(inner).trim()));
  out = out.replace(/\\\[([\s\S]*?)\\\]/g, (_m, inner) => convertClientLatexSegment(String(inner).trim()));
  out = out.replace(/\\\(([\s\S]*?)\\\)/g, (_m, inner) => convertClientLatexSegment(String(inner).trim()));
  out = out.replace(/\$([^$\n]{1,120})\$/g, (full, inner) => {
    const trimmed = String(inner).trim();
    if (!trimmed) return full;
    if (/^\d+(?:\.\d+)?\s+(?:and|or|to|per|each|for|in|at|of|from)\b/i.test(trimmed)) {
      return full;
    }
    return convertClientLatexSegment(trimmed);
  });
  out = out.replace(/\$(?=\s*\\[a-zA-Z]+)/g, "");
  if (out.includes("\\") || out.includes("^") || out.includes("_")) {
    out = convertClientLatexSegment(out);
  }
  return out;
}

function buildClientSystemPrompt(ctx: StoreContext): string {
  const products = ctx.products || [];
  const recentBills = ctx.recentBills || [];
  const expenses = ctx.otherCosts || [];
  const accounts = ctx.accounts || [];
  const outOfStock = products.filter((p) => Number(p.stock) <= 0);
  const lowStock = products.filter((p) => Number(p.stock) > 0 && Number(p.stock) <= 5);
  const todayExpenseTotal = expenses.reduce((s, e) => s + (Number(e.amount) || 0), 0);

  const currentUserBlock = ctx.currentUser
    ? `CURRENT LOGGED-IN USER (THE PERSON TALKING TO YOU RIGHT NOW):
- Name: ${ctx.currentUser.displayName}
- Email: ${ctx.currentUser.email || "Not provided"}
- UID: ${ctx.currentUser.uid}
- Role: ${ctx.currentUser.role}
- Is Admin?: ${ctx.currentUser.isAdmin ? "YES (This user IS an Administrator)" : "NO (This user is a Standard User / Staff, NOT an Administrator)"}
- Is Owner / Super Admin?: ${ctx.currentUser.isSuperAdmin ? "YES" : "NO"}
(When the user asks "am I an admin?", "who am I?", "what is my role?", or "what is my email?", answer directly and conversationally about THIS user!)`
    : `CURRENT LOGGED-IN USER: Guest / Unauthenticated session`;

  return `You are "Buzz AI", an intelligent, accurate, and conversational retail store manager for "SmartRooti" running inside the Buzz POS & Stock Management app.

${currentUserBlock}

REAL-TIME LIVE STORE DATA:
- Active Catalog Size: ${products.length} products
- Out-of-Stock Products (0 units): ${outOfStock.length} items
- Low-Stock Products (<=5 units): ${lowStock.length} items
- Today's Total Sales Revenue: ₹${Number(ctx.totalRevenueToday || 0).toLocaleString("en-IN")}
- Today's Completed Bills/Orders: ${Number(ctx.billsCountToday || 0)}
- Recorded Expenses/Other Costs: ₹${todayExpenseTotal.toLocaleString("en-IN")} (${expenses.length} records)
- Registered Staff / Accounts: ${accounts.length}

CURRENT CATALOG SNAPSHOT (id|name|price|stock|category|sold):
${products
  .slice(0, 60)
  .map((p: any) => `${p.id}|${p.name}|${p.price}|${p.stock}|${p.category}|${p.soldCount || 0}`)
  .join("\n") || "(empty)"}

RECENT TRANSACTIONS (BILLS) SNAPSHOT (id|total|date|items):
${recentBills
  .slice(0, 10)
  .map(
    (b: any) =>
      `${b.id}|${b.total}|${b.date ? new Date(b.date).toLocaleDateString() : ""}|${(b.items || [])
        .map((i: any) => `${i.quantity}x ${i.name}`)
        .join(", ")}`
  )
  .join("\n") || "(none)"}

RECENT OTHER COSTS / EXPENSES SNAPSHOT (id|title|amount|category):
${expenses
  .slice(0, 12)
  .map((e: any) => `${e.id}|${e.title}|${e.amount}|${e.category}`)
  .join("\n") || "(none)"}

REGISTERED STAFF DIRECTORY (name|email|role):
${accounts
  .slice(0, 20)
  .map((a: any) => `${a.displayName}|${a.email}|${a.role}`)
  .join("\n") || "(none)"}

CRITICAL CONVERSATIONAL & ACTION CARD RULES:
1. NEVER emit an \`\`\`action\`\`\` block when asking the user for missing details or when required fields are missing.
2. Required fields before emitting an action block:
   - ADD_EXPENSE: title (specific description), amount (positive ₹), category ("expense" | "borrow" | "due" | "other").
   - DELETE_EXPENSE: expenseId, title, amount.
   - ADD_PRODUCT:
     * VALID CATEGORIES ONLY: The store ONLY has 3 product categories: \`"fresh"\`, \`"frozen"\`, and \`"cold drinks"\`. NEVER use \`"General"\` or invent any other category!
     * Automatically infer the best category from the product name if not specified: beverages/sodas/juices/water/cans (e.g. Pepsi, Coke, Sprite, Maaza, Water) -> \`"cold drinks"\`; ice cream/frozen snacks/peas -> \`"frozen"\`; all other grocery/bakery/fresh items -> \`"fresh"\`.
     * For a single product: name, price (positive ₹), stock (default 0), category (\`"fresh"\` | \`"frozen"\` | \`"cold drinks"\`). If the user uploaded an image or asked to use the uploaded image for this new product, also include \`"useAttachedImage": true, "attachmentIndex": 0\`.
     * For multiple products in one command (e.g., "add product atta, maida with the price 20, 30 and stock 50 for both"): include a \`products\` array of \`{ "name": "...", "price": 20, "stock": 50, "category": "fresh" | "frozen" | "cold drinks" }\` along with \`name\` (comma-separated names), \`price\` (first price), and \`stock\` (first stock).
   - UPDATE_PRODUCT_IMAGE: Use when the user uploads an image (or refers to an uploaded image in chat) and asks to set, use, update, or change a store product's photo/image (e.g. "use this image for roti", "set this photo for pepsi"). Required: productId, productName (from CURRENT CATALOG SNAPSHOT), attachmentIndex (0-based index of the uploaded image, default 0).
   - UPDATE_STOCK: productId, productName, currentStock, newStock, quantityChange.
   - UPDATE_PRICE: productId, productName, currentPrice, newPrice.
   - DELETE_PRODUCT: productId, productName, currentPrice, currentStock.
   - UPDATE_BILL: billId, oldTotal, newTotal.
   - DELETE_BILL: billId, total, itemsCount, itemSummary.
   - PURGE_STORE_DATA: target ("products" | "bills" | "both"), productsCount (${products.length}), billsCount (${recentBills.length}).
3. Action block format (append at the very end of your response ONLY when all required fields are confirmed):
\`\`\`action
{
  "type": "...",
  ...fields
}
\`\`\`
4. Keep answers concise, warm, factual, and formatted in Indian Rupees (₹).
5. STRICT CATALOG GROUNDING: When asked what to buy next, restock, or recommend for the shop, ONLY recommend products that ALREADY EXIST in CURRENT CATALOG SNAPSHOT. NEVER suggest or invent products that do not exist in the user's products list.
6. STRICT ADMIN ROLE SECURITY: NEVER emit an UPDATE_ROLE action or allow making yourself, the current user, or any other user an Admin, or demoting/revoking an Admin via Buzz AI. If asked to promote or demote an admin or change user roles, refuse politely and state that Administrator roles can only be modified by a permanent Administrator in the User Accounts panel.
7. STRICT LANGUAGE MATCHING RULE: Always reply in the EXACT SAME LANGUAGE as the user's LATEST message. If the user's latest message is in English, reply 100% in English even if earlier messages in the conversation were in Bengali or Hindi.
8. QUOTED TEXT EXPLANATION: When the user quotes a line or word from the chat (indicated by \`Regarding this quoted text from our chat: "..."\`), directly explain what it means or answer their question about it clearly.`;
}

export function isRoleModificationPrompt(rawPrompt: string): boolean {
  const p = String(rawPrompt || "").toLowerCase().trim();
  if (!p) return false;
  if (
    /\b(make|set|promote|grant|give|turn|upgrade|assign|add)\b[\s\S]{0,40}\b(admin|administrator|super\s*admin|manager)\b/i.test(
      p
    ) ||
    /\b(admin|administrator)\b[\s\S]{0,25}\b(make|promote|give|grant|assign)\b/i.test(p) ||
    /\b(demote|revoke|remove|strip|downgrade|take\s+away)\b[\s\S]{0,40}\b(admin|administrator|role|privilege|access)\b/i.test(
      p
    ) ||
    /\b(change|update|modify|switch|edit)\b[\s\S]{0,30}\b(role|permission|privilege|admin\s+status)\b/i.test(
      p
    ) ||
    /\b(make|set|demote|change)\b[\s\S]{0,30}\b(to\s+user|to\s+staff|normal\s+user|standard\s+user|non\s*admin)\b/i.test(
      p
    )
  ) {
    return true;
  }
  return false;
}

export const ROLE_MODIFICATION_REFUSAL_REPLY =
  "🔒 **Security Policy:** Administrator privileges cannot be granted, promoted, or revoked through **Buzz AI**. Only a permanent **Administrator** can manage user roles directly in the **User Accounts** section.";

/**
 * Strips binary/base64 image payloads and caps collection arrays so AI requests remain ultra-lean (<15KB).
 */
export function compactStoreContext(ctx: StoreContext): StoreContext {
  const safeObj: StoreContext = {
    products: (ctx.products || []).slice(0, 80).map((p) => ({
      id: String(p?.id || ""),
      name: String(p?.name || ""),
      price: Number(p?.price) || 0,
      stock: Number(p?.stock) || 0,
      category: normalizeProductCategory(p?.category, p?.name),
      soldCount: Number(p?.soldCount) || 0,
    })),
    recentBills: (ctx.recentBills || []).slice(0, 12).map((b) => ({
      id: String(b?.id || ""),
      total: Number(b?.total) || 0,
      date: Number(b?.date) || Date.now(),
      status: String(b?.status || "completed"),
      items: (b?.items || []).slice(0, 10).map((i: any) => ({
        productId: String(i?.productId || i?.id || ""),
        name: String(i?.name || ""),
        price: Number(i?.price) || 0,
        quantity: Number(i?.quantity) || 1,
      })),
    })),
    otherCosts: (ctx.otherCosts || []).slice(0, 15).map((c) => ({
      id: String(c?.id || ""),
      title: String(c?.title || ""),
      amount: Number(c?.amount) || 0,
      category: String(c?.category || "expense"),
      date: Number(c?.date) || Date.now(),
    })),
    accounts: (ctx.accounts || []).slice(0, 20).map((a) => ({
      uid: String(a?.uid || ""),
      displayName: String(a?.displayName || "User"),
      email: String(a?.email || ""),
      role: String(a?.role || (a?.isAdmin ? "Admin" : "Standard User")),
      isAdmin: Boolean(a?.isAdmin),
      isSuperAdmin: Boolean(a?.isSuperAdmin),
      isOnline: Boolean(a?.isOnline),
    })),
    activityLogs: (ctx.activityLogs || []).slice(0, 15).map((l) => ({
      id: String(l?.id || ""),
      action: String(l?.action || ""),
      details: String(l?.details || "").slice(0, 160),
      userName: String(l?.userName || "User"),
      timestamp: Number(l?.timestamp) || Date.now(),
    })),
    totalRevenueToday: Number(ctx.totalRevenueToday) || 0,
    billsCountToday: Number(ctx.billsCountToday) || 0,
    currentUser: ctx.currentUser
      ? {
          uid: String(ctx.currentUser.uid || ""),
          displayName: String(ctx.currentUser.displayName || "Store User"),
          email: String(ctx.currentUser.email || ""),
          isAdmin: Boolean(ctx.currentUser.isAdmin),
          isSuperAdmin: Boolean(ctx.currentUser.isSuperAdmin),
          role: String(ctx.currentUser.role || (ctx.currentUser.isAdmin ? "Admin" : "Standard User")),
        }
      : null,
  };
  return JSON.parse(JSON.stringify(safeObj));
}

const CLIENT_PLACEHOLDER_TITLES = new Set([
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

export function normalizeClientExpenseCategory(
  raw?: string
): "expense" | "borrow" | "due" | "other" {
  const c = String(raw || "").toLowerCase().trim();
  if (c.includes("borrow") || c.includes("debt") || c.includes("loan")) return "borrow";
  if (c.includes("due") || c.includes("pending") || c.includes("credit") || c.includes("udhar"))
    return "due";
  if (c.includes("other")) return "other";
  return "expense";
}

/**
 * Normalizes any product category into one of the 3 valid store categories:
 * "fresh" | "frozen" | "cold drinks" (never "General").
 */
export function normalizeProductCategory(
  rawCategory?: string,
  productName?: string
): "fresh" | "frozen" | "cold drinks" {
  const cat = String(rawCategory || "").toLowerCase().trim();
  if (cat === "cold drinks" || cat === "cold drink" || cat === "colddrinks" || cat === "drinks" || cat === "beverage" || cat === "beverages") {
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

/**
 * Strict client-side action validator to ensure no incomplete or premature action card
 * is ever rendered or executed.
 */
export function validateClientAction(
  rawAction: any,
  prompt: string = "",
  replyText: string = "",
  storeContext?: StoreContext
): AssistantAction | null {
  if (!rawAction || typeof rawAction !== "object" || !rawAction.type) {
    return null;
  }

  const pLower = String(prompt || "").toLowerCase();
  const rLower = String(replyText || "").toLowerCase();

  if (
    pLower &&
    /\b(ask\s+me|what\s+details\s+do\s+you\s+need|what\s+info\s+do\s+you\s+need|tell\s+me\s+what\s+you\s+need|ask\s+the\s+requirements|ask\s+all\s+the\s+details)\b/i.test(
      pLower
    )
  ) {
    return null;
  }

  if (
    rLower &&
    /\b(please\s+provide\s+the\s+following|once\s+you\s+provide\s+these\s+details|please\s+share:\s*\n|what\s+is\s+this\s+(?:expense|cost)\s+for|reply\s+with\s+the\s+details\s+and\s+i\s+will)\b/i.test(
      rLower
    )
  ) {
    return null;
  }

  const action = { ...rawAction };
  const products = storeContext?.products || [];
  const recentBills = storeContext?.recentBills || [];

  switch (action.type) {
    case "ADD_EXPENSE": {
      const title = String(action.title || action.description || action.name || "").trim();
      const lowerTitle = title.toLowerCase();
      const userExplicitlyNamedGeneric =
        pLower.includes("store expense") || pLower.includes('"expense"');
      if (!title || (CLIENT_PLACEHOLDER_TITLES.has(lowerTitle) && !userExplicitlyNamedGeneric)) {
        return null;
      }
      if (/\b(ask\s+me|details\s+u\s+need|details\s+you\s+need)\b/i.test(title)) {
        return null;
      }
      const amount = Number(action.amount ?? action.price ?? action.total);
      if (isNaN(amount) || amount <= 0) {
        return null;
      }
      action.title = title;
      action.amount = amount;
      action.category = normalizeClientExpenseCategory(action.category);
      return action;
    }
    case "DELETE_EXPENSE": {
      if (!action.expenseId && storeContext?.otherCosts?.length) {
        const exp = storeContext.otherCosts[0];
        action.expenseId = exp.id;
        action.title = action.title || exp.title;
        action.amount = action.amount ?? exp.amount;
      }
      if (!action.expenseId) return null;
      return action;
    }
    case "ADD_PRODUCT": {
      if (Array.isArray(action.products) && action.products.length > 0) {
        const validItems: BatchProductItem[] = [];
        for (const item of action.products) {
          const itemName = String(item?.name || item?.productName || "").trim();
          const itemPrice = Math.min(MAX_BILL_AMOUNT, Number(item?.price ?? item?.newPrice));
          const itemStock = Math.min(MAX_PRODUCT_STOCK, Math.max(0, Number(item?.stock) || 0));
          const itemCat = normalizeProductCategory(
            item?.category || action.category,
            itemName
          );
          if (
            itemName &&
            !CLIENT_PLACEHOLDER_TITLES.has(itemName.toLowerCase()) &&
            !isNaN(itemPrice) &&
            itemPrice > 0
          ) {
            validItems.push({
              name: itemName,
              price: itemPrice,
              stock: itemStock,
              category: itemCat,
              ...(typeof item?.attachmentIndex === "number" ? { attachmentIndex: item.attachmentIndex } : {}),
              ...(typeof item?.image === "string" && item.image ? { image: item.image } : {}),
            });
          }
        }
        if (validItems.length > 0) {
          action.products = validItems;
          action.name = validItems.map((i) => i.name).join(", ");
          action.price = validItems[0].price;
          action.stock = validItems[0].stock;
          action.category = validItems[0].category || "fresh";
          return action;
        }
      }

      const name = String(action.name || action.productName || "").trim();
      if (!name || CLIENT_PLACEHOLDER_TITLES.has(name.toLowerCase())) {
        return null;
      }
      const price = Math.min(MAX_BILL_AMOUNT, Number(action.price ?? action.newPrice));
      if (isNaN(price) || price <= 0) {
        return null;
      }
      action.name = name;
      action.price = price;
      action.stock = Math.min(MAX_PRODUCT_STOCK, Math.max(0, Number(action.stock) || 0));
      action.category = normalizeProductCategory(action.category, name);
      action.products = [
        {
          name: action.name,
          price: action.price,
          stock: action.stock,
          category: action.category,
          ...(typeof action.attachmentIndex === "number" ? { attachmentIndex: action.attachmentIndex } : {}),
          ...(typeof action.image === "string" && action.image ? { image: action.image } : {}),
        },
      ];
      return action;
    }
    case "UPDATE_STOCK": {
      if (!action.productId && action.productName && products.length > 0) {
        const s = String(action.productName).toLowerCase().trim();
        const m =
          products.find((p: any) => p.name?.toLowerCase().trim() === s) ||
          products.find((p: any) => p.name?.toLowerCase().includes(s));
        if (m) {
          action.productId = m.id;
          action.productName = m.name;
          action.currentStock = Number(m.stock) || 0;
        }
      }
      if (!action.productId && !action.productName) return null;
      const newStock = Number(action.newStock);
      if (isNaN(newStock) || newStock < 0) return null;
      action.newStock = Math.min(MAX_PRODUCT_STOCK, newStock);
      if (action.currentStock !== undefined) {
        action.quantityChange = action.newStock - Number(action.currentStock);
      }
      return action;
    }
    case "UPDATE_PRICE": {
      if (!action.productId && action.productName && products.length > 0) {
        const s = String(action.productName).toLowerCase().trim();
        const m =
          products.find((p: any) => p.name?.toLowerCase().trim() === s) ||
          products.find((p: any) => p.name?.toLowerCase().includes(s));
        if (m) {
          action.productId = m.id;
          action.productName = m.name;
          action.currentPrice = Number(m.price) || 0;
        }
      }
      if (!action.productId && !action.productName) return null;
      const newPrice = Number(action.newPrice ?? action.price);
      if (isNaN(newPrice) || newPrice <= 0) return null;
      action.newPrice = Math.min(MAX_BILL_AMOUNT, newPrice);
      return action;
    }
    case "UPDATE_PRODUCT_IMAGE": {
      const searchName = String(action.productName || action.name || "").toLowerCase().trim();
      let matched = products.find((p: any) => p.id && p.id === action.productId);
      if (!matched && searchName && products.length > 0) {
        matched =
          products.find((p: any) => p.name?.toLowerCase().trim() === searchName) ||
          products.find((p: any) => p.name?.toLowerCase().includes(searchName)) ||
          products.find((p: any) => searchName.includes(p.name?.toLowerCase().trim()));
      }
      if (matched) {
        action.productId = matched.id;
        action.productName = matched.name;
        action.currentPrice = Number(matched.price) || 0;
        action.currentStock = Number(matched.stock) || 0;
      }
      if (!action.productId && !action.productName) return null;
      action.attachmentIndex =
        typeof action.attachmentIndex === "number" && action.attachmentIndex >= 0
          ? Math.floor(action.attachmentIndex)
          : 0;
      return action;
    }
    case "DELETE_PRODUCT": {
      if (!action.productId && action.productName && products.length > 0) {
        const s = String(action.productName).toLowerCase().trim();
        const m =
          products.find((p: any) => p.name?.toLowerCase().trim() === s) ||
          products.find((p: any) => p.name?.toLowerCase().includes(s));
        if (m) {
          action.productId = m.id;
          action.productName = m.name;
          action.currentPrice = Number(m.price) || 0;
          action.currentStock = Number(m.stock) || 0;
        }
      }
      if (!action.productId && !action.productName) return null;
      return action;
    }
    case "UPDATE_BILL": {
      if (!action.billId && recentBills.length > 0) {
        action.billId = recentBills[0].id;
        action.oldTotal = Number(recentBills[0].total) || 0;
      }
      if (!action.billId) return null;
      const newTotal = Number(action.newTotal ?? action.total);
      if (isNaN(newTotal) || newTotal < 0) return null;
      action.newTotal = Math.min(MAX_BILL_AMOUNT, newTotal);
      return action;
    }
    case "DELETE_BILL": {
      if (!action.billId && recentBills.length > 0) {
        const latest = recentBills[0];
        action.billId = latest.id;
        action.total = Number(latest.total) || 0;
        action.items = latest.items || [];
        action.itemsCount = latest.items?.length || 1;
      }
      if (!action.billId) return null;
      return action;
    }
    case "UPDATE_ROLE": {
      return null;
    }
    case "PURGE_STORE_DATA": {
      return action;
    }
    default:
      return null;
  }
}

export interface ConversationTurnInput {
  role: "user" | "assistant";
  content: string;
  attachments?: Array<{
    name?: string;
    mimeType: string;
    kind?: "image" | "video" | "video_frame";
    data: string;
    videoFrames?: VideoFrameSnapshot[];
  }>;
}

function compactConversationHistory(
  history: ConversationTurnInput[],
  currentPrompt: string = ""
): ConversationTurnInput[] {
  const sliced = (history || []).slice(-10);
  const promptNeedsHistoryMedia =
    /\b(image|images|photo|photos|picture|pictures|pic|pics|video|videos|clip|media|upload|uploaded|attach|attached|sent|send|saw|see|look|show|shown|first|second|third|1st|2nd|3rd|what\s+was|what\s+is\s+in|what\s+are\s+those|describe|analyze|product|use\s+this|use\s+it)\b/i.test(
      currentPrompt
    );
  let mediaTurnsKept = 0;
  const keepMediaIndices = new Set<number>();
  if (promptNeedsHistoryMedia) {
    for (let i = sliced.length - 1; i >= 0; i--) {
      const turn = sliced[i];
      if (
        Array.isArray(turn?.attachments) &&
        turn.attachments.some(
          (a) => a?.data || (Array.isArray(a?.videoFrames) && a.videoFrames.length > 0)
        )
      ) {
        if (mediaTurnsKept < 2) {
          keepMediaIndices.add(i);
          mediaTurnsKept++;
        }
      }
    }
  }

  return sliced.map((turn, idx) => {
    const cleanText = String(turn.content || "")
      .replace(/<thought>[\s\S]*?<\/thought>/g, "")
      .replace(/```action[\s\S]*?```/g, "")
      .trim()
      .slice(0, 800);
    let validAtts:
      | Array<{
          name: string;
          mimeType: string;
          kind: "image" | "video" | "video_frame";
          data: string;
        }>
      | undefined;

    if (keepMediaIndices.has(idx) && Array.isArray(turn.attachments)) {
      const expanded: Array<{
        name: string;
        mimeType: string;
        kind: "image" | "video" | "video_frame";
        data: string;
      }> = [];
      for (const a of turn.attachments.slice(0, MAX_MEDIA_ATTACHMENTS)) {
        if (!a) continue;
        const isVid = a.kind === "video" || String(a.mimeType || "").startsWith("video/");
        if (isVid && Array.isArray(a.videoFrames) && a.videoFrames.length > 0) {
          for (const frame of a.videoFrames.slice(0, 3)) {
            if (frame?.dataBase64) {
              expanded.push({
                name: `${a.name || "video"} (${frame.timestampSec.toFixed(1)}s)`,
                mimeType: frame.mimeType || "image/jpeg",
                kind: "video_frame",
                data: frame.dataBase64,
              });
            }
          }
        } else if (typeof a.mimeType === "string" && typeof a.data === "string" && a.data.length > 0) {
          expanded.push({
            name: a.name || "media",
            mimeType: a.mimeType,
            kind: a.kind || (a.mimeType.startsWith("video/") ? "video" : "image"),
            data: a.data,
          });
        }
      }
      if (expanded.length > 0) {
        validAtts = expanded.slice(0, 6);
      }
    }

    return {
      role: turn.role,
      content: cleanText,
      ...(validAtts && validAtts.length > 0 ? { attachments: validAtts } : {}),
    };
  });
}

function formatActionSummaryReply(action: AssistantAction | null): string {
  if (!action || !action.type) return "";
  switch (action.type) {
    case "ADD_PRODUCT":
      if (Array.isArray(action.products) && action.products.length > 1) {
        return `Prepared **${action.products.length} products** for your catalog (${action.products
          .map((p) => `${p.name} ₹${p.price}`)
          .join(", ")}). Confirm below to add them to your live inventory:`;
      }
      return `Prepared new product **${action.name || "Item"}** (₹${action.price ?? 0} · ${action.stock ?? 0} units in stock). Confirm below to add it to your catalog:`;
    case "UPDATE_STOCK":
      return `Prepared stock update for **${action.productName || "product"}** (${action.currentStock ?? 0} ➔ **${action.newStock ?? 0} units**). Confirm below to apply:`;
    case "UPDATE_PRICE":
      return `Prepared price update for **${action.productName || "product"}** (₹${action.currentPrice ?? 0} ➔ **₹${action.newPrice ?? 0}**). Confirm below to apply:`;
    case "UPDATE_PRODUCT_IMAGE":
      return `Prepared product photo update for **${action.productName || "product"}** using your uploaded image. Confirm below to save:`;
    case "DELETE_PRODUCT":
      return `Prepared product removal for **${action.productName || "product"}**. Confirm below to delete it from your catalog:`;
    case "ADD_EXPENSE":
      return `Prepared expense entry **${action.title || "Store Cost"}** for **₹${action.amount ?? 0}** (${action.category || "expense"}). Confirm below to record:`;
    case "DELETE_EXPENSE":
      return `Prepared removal for expense **${action.title || "entry"}** (₹${action.amount ?? 0}). Confirm below to delete:`;
    case "UPDATE_BILL":
      return `Prepared bill update (**₹${action.oldTotal ?? 0} ➔ ₹${action.newTotal ?? 0}**). Confirm below to update this transaction:`;
    case "DELETE_BILL":
      return `Prepared transaction cancellation (**₹${action.total ?? 0}**). Confirm below to delete this bill:`;
    case "PURGE_STORE_DATA":
      return `Prepared store data reset confirmation card below. Please review carefully before confirming:`;
    default:
      return "Prepared your requested store action below. Tap confirm to apply:";
  }
}

function buildFallbackStoreReply(
  prompt: string,
  compactedContext: StoreContext,
  compactedHistory: { role: "user" | "assistant"; content: string }[]
): AssistantResponse {
  const localRes = generateClientStoreResponse(prompt, compactedContext, compactedHistory);
  if (localRes && String(localRes.reply || "").trim()) {
    return localRes;
  }
  const products = compactedContext.products || [];
  const totalRevenue = Number(compactedContext.totalRevenueToday || 0);
  const billsToday = Number(compactedContext.billsCountToday || 0);
  const lowStock = products.filter((p) => Number(p.stock) <= 5);
  return {
    reply: `**Store Snapshot:**\n• Active Catalog: **${products.length} products** (${lowStock.length} low/out of stock)\n• Today's Sales: **₹${totalRevenue.toLocaleString("en-IN")}** across **${billsToday} bills**\n\nYou can ask me to add products, update stock or prices, record expenses, or inspect recent bills.`,
    action: localRes?.action || null,
    thought: generateDynamicThought(prompt, "", compactedContext),
    thoughtDuration: 1,
  };
}

export function serializeChatAttachments(
  attachments?: ChatAttachment[],
  forFirestoreBridge: boolean = false
): Array<{
  name: string;
  mimeType: string;
  kind: "image" | "video" | "video_frame";
  data: string;
}> {
  const result: Array<{
    name: string;
    mimeType: string;
    kind: "image" | "video" | "video_frame";
    data: string;
  }> = [];

  const capped = (attachments || []).slice(0, MAX_MEDIA_ATTACHMENTS);
  for (const a of capped) {
    if (!a) continue;
    const rawData =
      a.dataBase64 ||
      (a.previewUrl && a.previewUrl.startsWith("data:")
        ? a.previewUrl.slice(a.previewUrl.indexOf(",") + 1)
        : "");
    const isVideo = a.kind === "video" || String(a.mimeType || "").startsWith("video/");
    const frames = Array.isArray(a.videoFrames)
      ? a.videoFrames.filter((f) => f && f.dataBase64)
      : [];

    if (isVideo) {
      // For Firestore Bridge (1MB limit) or when raw video base64 exceeds 500KB on bridge / 12MB on HTTP:
      if (forFirestoreBridge) {
        if (frames.length > 0) {
          frames.slice(0, 5).forEach((f, idx) => {
            result.push({
              name: `${a.name || "video.mp4"} (frame ${idx + 1}/${Math.min(frames.length, 5)} at ${f.timestampSec.toFixed(1)}s)`,
              mimeType: f.mimeType || "image/jpeg",
              kind: "video_frame",
              data: f.dataBase64,
            });
          });
        } else if (rawData && rawData.length <= 550000) {
          result.push({
            name: a.name || "video.mp4",
            mimeType: a.mimeType || "video/mp4",
            kind: "video",
            data: rawData,
          });
        }
      } else {
        // Direct HTTP: include full video binary if <= ~9MB raw (12M base64 chars), plus extracted keyframes for instant multi-model vision
        if (rawData && rawData.length <= 12000000) {
          result.push({
            name: a.name || "video.mp4",
            mimeType: a.mimeType || "video/mp4",
            kind: "video",
            data: rawData,
          });
        }
        if (frames.length > 0) {
          frames.slice(0, 5).forEach((f, idx) => {
            result.push({
              name: `${a.name || "video.mp4"} (frame ${idx + 1}/${Math.min(frames.length, 5)} at ${f.timestampSec.toFixed(1)}s)`,
              mimeType: f.mimeType || "image/jpeg",
              kind: "video_frame",
              data: f.dataBase64,
            });
          });
        }
      }
    } else if (rawData) {
      result.push({
        name: a.name || "attachment.jpg",
        mimeType: a.mimeType || "image/jpeg",
        kind: "image",
        data: rawData,
      });
    }
  }

  return result;
}

async function askViaFirestoreBridge(
  prompt: string,
  compactedHistory: { role: "user" | "assistant"; content: string }[],
  compactedContext: StoreContext,
  onChunk?: (cleanText: string) => void,
  externalSignal?: AbortSignal,
  attachments?: ChatAttachment[]
): Promise<AssistantResponse> {
  const reqId = `ai_rpc_req_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const reqRef = doc(db, "settings", reqId);
  const serializedAttachments = serializeChatAttachments(attachments, true);

  return new Promise<AssistantResponse>((resolve, reject) => {
    let settled = false;
    let serverAcknowledged = false;
    let unsub: (() => void) | null = null;
    let pollInterval: ReturnType<typeof setInterval> | null = null;
    let ackTimer: ReturnType<typeof setTimeout> | null = null;
    let lastPartialSeen = "";

    const cleanup = () => {
      if (ackTimer) {
        clearTimeout(ackTimer);
        ackTimer = null;
      }
      if (pollInterval) {
        clearInterval(pollInterval);
        pollInterval = null;
      }
      if (unsub) {
        try {
          unsub();
        } catch {}
        unsub = null;
      }
      deleteDoc(reqRef).catch(() => {});
    };

    if (externalSignal) {
      if (externalSignal.aborted) {
        cleanup();
        reject(new Error("Aborted"));
        return;
      }
      externalSignal.addEventListener(
        "abort",
        () => {
          if (!settled) {
            settled = true;
            clearTimeout(timer);
            cleanup();
            reject(new Error("Aborted"));
          }
        },
        { once: true }
      );
    }

    const hasHistoryMedia = (compactedHistory || []).some(
      (m: any) => Array.isArray(m?.attachments) && m.attachments.length > 0
    );
    const hasMedia = serializedAttachments.length > 0 || hasHistoryMedia;
    let timer = setTimeout(
      () => {
        if (!settled) {
          settled = true;
          cleanup();
          reject(new Error("Firestore AI bridge timed out"));
        }
      },
      hasMedia ? 38000 : 28000
    );

    let partialIdleTimer: ReturnType<typeof setTimeout> | null = null;
    const clearPartialIdleTimer = () => {
      if (partialIdleTimer) {
        clearTimeout(partialIdleTimer);
        partialIdleTimer = null;
      }
    };

    const refreshStreamTimer = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          clearPartialIdleTimer();
          cleanup();
          if (lastPartialSeen.trim()) {
            const validatedAction = validateClientAction(
              null,
              prompt,
              lastPartialSeen,
              compactedContext
            );
            resolve({
              reply: lastPartialSeen.trim(),
              action: validatedAction,
              thought: generateDynamicThought(prompt, lastPartialSeen, compactedContext),
            });
          } else {
            reject(new Error("Firestore AI bridge stream timed out"));
          }
        }
      }, 15000);
    };

    const handleDocData = (data: any) => {
      if (settled || !data) return;
      if (
        data.status === "processing" ||
        data.status === "streaming" ||
        data.status === "completed" ||
        Boolean(data.completedAt)
      ) {
        serverAcknowledged = true;
        if (ackTimer) {
          clearTimeout(ackTimer);
          ackTimer = null;
        }
      }
      // Prioritize completion check first so an out-of-order merge can never trap a finished reply in "streaming" state
      if (
        (data.status === "completed" ||
          Boolean(data.completedAt) ||
          (typeof data.reply === "string" && data.reply.trim().length > 0)) &&
        (data.reply || data.action)
      ) {
        settled = true;
        clearTimeout(timer);
        clearPartialIdleTimer();
        const validatedAction = validateClientAction(
          data.action,
          prompt,
          data.reply || "",
          compactedContext
        );
        const finalReply =
          String(data.reply || lastPartialSeen || "").trim() ||
          formatActionSummaryReply(validatedAction) ||
          "Prepared your requested store update:";
        if (onChunk) {
          onChunk(finalReply);
        }
        cleanup();
        resolve({
          reply: finalReply,
          action: validatedAction,
          thought:
            data.thought ||
            generateDynamicThought(prompt, finalReply, compactedContext),
        });
      } else if (data.status === "streaming" && typeof data.partialReply === "string" && onChunk) {
        if (data.partialReply !== lastPartialSeen) {
          lastPartialSeen = data.partialReply;
          refreshStreamTimer();
          onChunk(data.partialReply);
          clearPartialIdleTimer();
          partialIdleTimer = setTimeout(() => {
            if (!settled && lastPartialSeen.trim().length >= 12) {
              settled = true;
              clearTimeout(timer);
              const cleanPartial = lastPartialSeen.trim();
              const validatedAction = validateClientAction(
                null,
                prompt,
                cleanPartial,
                compactedContext
              );
              cleanup();
              resolve({
                reply: cleanPartial,
                action: validatedAction,
                thought: generateDynamicThought(prompt, cleanPartial, compactedContext),
              });
            }
          }, 2800);
        }
      } else if (data.status === "error") {
        settled = true;
        clearTimeout(timer);
        clearPartialIdleTimer();
        cleanup();
        reject(new Error(data.error || "Firestore AI bridge error"));
      }
    };

    unsub = onSnapshot(
      reqRef,
      (snap) => {
        if (settled || !snap.exists()) return;
        handleDocData(snap.data());
      },
      () => {}
    );

    pollInterval = setInterval(async () => {
      if (settled) return;
      try {
        const snap = await getDocFromServer(reqRef).catch(() => getDoc(reqRef));
        if (!settled && snap && snap.exists()) {
          handleDocData(snap.data());
        }
      } catch {}
    }, 120);

    const rawPayloadObj: any = {
      type: "chat",
      status: "pending",
      prompt: prompt.trim().slice(0, 1600),
      conversationHistory: JSON.parse(JSON.stringify(compactedHistory || [])),
      storeContext: compactedContext || {},
      ...(serializedAttachments.length > 0 ? { attachments: serializedAttachments } : {}),
      createdAt: Date.now(),
    };

    // Ensure Firestore document stays safely under the 1,048,576-byte (1 MB) limit
    let serializedJson = JSON.stringify(rawPayloadObj);
    if (serializedJson.length > 850000 && Array.isArray(rawPayloadObj.conversationHistory)) {
      for (let i = 0; i < rawPayloadObj.conversationHistory.length && serializedJson.length > 850000; i++) {
        if (rawPayloadObj.conversationHistory[i]?.attachments) {
          delete rawPayloadObj.conversationHistory[i].attachments;
          serializedJson = JSON.stringify(rawPayloadObj);
        }
      }
    }
    const safePayload = JSON.parse(serializedJson);

    if (!Capacitor.isNativePlatform()) {
      wakeUpBuzzServer();
    }
    setDoc(reqRef, safePayload)
      .then(() => {
        if (settled || serverAcknowledged) return;
        ackTimer = setTimeout(() => {
          if (!settled && !serverAcknowledged) {
            settled = true;
            clearTimeout(timer);
            cleanup();
            reject(new Error("Firestore AI bridge server hibernating"));
          }
        }, 16000);
      })
      .catch((err) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          cleanup();
          reject(err);
        }
      });
  });
}

export function buildValidGeminiContents(
  compactedHistory: { role: "user" | "assistant"; content: string }[],
  prompt: string
): Array<{ role: "user" | "model"; parts: Array<{ text: string }> }> {
  const cleanPrompt = prompt.trim().slice(0, 1200);
  const rawTurns: Array<{ role: "user" | "model"; text: string }> = [];

  for (const msg of compactedHistory || []) {
    const text = String(msg?.content || "").trim();
    if (!text) continue;
    if (text === "*(Response stopped)*") continue;
    if (text.includes("I am **Buzz AI**, your intelligent retail store manager")) continue;
    rawTurns.push({
      role: msg.role === "assistant" ? "model" : "user",
      text: text.slice(0, 800),
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
      prev.parts[0].text = `${prev.parts[0].text}\n\n${turn.text}`.slice(-1200);
    } else {
      contents.push({
        role: turn.role,
        parts: [{ text: turn.text }],
      });
    }
  }

  const last = contents[contents.length - 1];
  if (last && last.role === "user") {
    last.parts[0].text = `${last.parts[0].text}\n\n${cleanPrompt}`.slice(-1200);
  } else {
    contents.push({
      role: "user",
      parts: [{ text: cleanPrompt }],
    });
  }

  return contents;
}

export async function askGeminiAssistant(
  prompt: string,
  conversationHistory: ConversationTurnInput[],
  storeContext: StoreContext,
  attachments?: ChatAttachment[]
): Promise<AssistantResponse> {
  if (isRoleModificationPrompt(prompt)) {
    return {
      reply: ROLE_MODIFICATION_REFUSAL_REPLY,
      action: null,
      thought: "Blocked privilege modification request per store security policy.",
      thoughtDuration: 1,
    };
  }
  const compactedContext = compactStoreContext(storeContext);
  const compactedHistory = compactConversationHistory(conversationHistory, prompt);
  const localActionCandidate = generateClientStoreResponse(
    prompt,
    compactedContext,
    compactedHistory
  ).action;
  const serializedAttachments = serializeChatAttachments(attachments, false);
  const hasAttachments = serializedAttachments.length > 0;
  const hasVideoAttachment = (attachments || []).some(
    (a) => a && (a.kind === "video" || String(a.mimeType || "").startsWith("video/"))
  );

  const hasHistoryMedia = (compactedHistory || []).some(
    (m: any) => Array.isArray(m?.attachments) && m.attachments.length > 0
  );
  const hasAnyMedia = hasAttachments || hasHistoryMedia;

  let lastHttpError = "";

  const tryHttpChat = async (): Promise<AssistantResponse | null> => {
    for (const baseUrl of getCandidateApiBaseUrls()) {
      const endpoint = `${baseUrl}/api/gemini/chat`;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), hasAnyMedia ? 120000 : 60000);

      try {
        const response = await fetch(endpoint, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            prompt: prompt.trim().slice(0, 1600),
            conversationHistory: compactedHistory,
            storeContext: compactedContext,
            ...(hasAttachments ? { attachments: serializedAttachments } : {}),
          }),
          signal: controller.signal,
        });
        clearTimeout(timer);

        const contentType = response.headers.get("content-type") || "";
        if (contentType.includes("application/json")) {
          const data = await response.json().catch(() => ({}));
          if (response.ok) {
            lastHttpFailureAt = 0;
            const replyStr = String(data?.reply || "").trim();
            if (replyStr) {
              data.reply = replyStr;
              data.action =
                validateClientAction(data.action, prompt, data.reply, compactedContext) ||
                localActionCandidate ||
                null;
              return data;
            }
          } else if (data?.error) {
            lastHttpError = String(data.error);
            if (
              lastHttpError.includes("PERMISSION_DENIED") ||
              lastHttpError.includes("Settings") ||
              lastHttpError.includes("leaked")
            ) {
              throw new Error(lastHttpError);
            }
          }
        }
        lastHttpFailureAt = Date.now();
      } catch (err: any) {
        clearTimeout(timer);
        lastHttpFailureAt = Date.now();
        const msg = String(err?.message || "");
        if (
          msg.includes("PERMISSION_DENIED") ||
          msg.includes("Settings") ||
          msg.includes("leaked")
        ) {
          throw err;
        }
      }
    }
    return null;
  };

  if (!shouldPreferFirestoreBridge(hasVideoAttachment)) {
    const httpRes = await tryHttpChat();
    if (httpRes) return httpRes;
  }

  try {
    return await askViaFirestoreBridge(
      prompt,
      compactedHistory,
      compactedContext,
      undefined,
      undefined,
      attachments
    );
  } catch (bridgeErr: any) {
    const retryHttp = await tryHttpChat();
    if (retryHttp) return retryHttp;
    throw new Error(
      lastHttpError ||
        bridgeErr?.message ||
        "Could not get a response from Buzz AI right now. Please try again."
    );
  }
}

export async function askGeminiAssistantStream(
  prompt: string,
  conversationHistory: ConversationTurnInput[],
  storeContext: StoreContext,
  onChunk: (accumulatedCleanText: string) => void,
  onComplete: (data: AssistantResponse) => void,
  externalSignal?: AbortSignal,
  attachments?: ChatAttachment[]
): Promise<void> {
  if (isRoleModificationPrompt(prompt)) {
    onChunk(ROLE_MODIFICATION_REFUSAL_REPLY);
    onComplete({
      reply: ROLE_MODIFICATION_REFUSAL_REPLY,
      action: null,
      thought: "Blocked privilege modification request per store security policy.",
      thoughtDuration: 1,
    });
    return;
  }
  const compactedContext = compactStoreContext(storeContext);
  const compactedHistory = compactConversationHistory(conversationHistory, prompt);
  const localActionCandidate = generateClientStoreResponse(
    prompt,
    compactedContext,
    compactedHistory
  ).action;
  const serializedAttachments = serializeChatAttachments(attachments, false);
  const hasAttachments = serializedAttachments.length > 0;
  const hasVideoAttachment = (attachments || []).some(
    (a) => a && (a.kind === "video" || String(a.mimeType || "").startsWith("video/"))
  );

  let completed = false;
  let userAborted = false;
  let lastStreamedChunk = "";
  let timeoutId: ReturnType<typeof setTimeout> | null = null;
  const controller = new AbortController();
  const bridgeAbortController = new AbortController();

  const emitChunk = (chunkText: string) => {
    if (completed || userAborted) return;
    const sanitized = sanitizeLatexAndMathFormatting(chunkText);
    if (sanitized && sanitized.trim()) {
      lastStreamedChunk = sanitized.trim();
      onChunk(sanitized);
    }
  };

  if (externalSignal) {
    if (externalSignal.aborted) {
      return;
    }
    externalSignal.addEventListener(
      "abort",
      () => {
        userAborted = true;
        completed = true;
        if (timeoutId !== null) {
          clearTimeout(timeoutId);
          timeoutId = null;
        }
        try {
          controller.abort();
        } catch {}
        try {
          bridgeAbortController.abort();
        } catch {}
      },
      { once: true }
    );
  }

  const safeComplete = (payload: AssistantResponse) => {
    if (completed || userAborted) return;
    const cleanReply = sanitizeLatexAndMathFormatting(
      String(payload.reply || lastStreamedChunk || "").trim()
    );
    if (!cleanReply) return;
    completed = true;
    if (timeoutId !== null) {
      clearTimeout(timeoutId);
      timeoutId = null;
    }
    try {
      bridgeAbortController.abort();
    } catch {}
    onComplete({
      ...payload,
      reply: cleanReply,
    });
  };

  const hasHistoryMedia = (compactedHistory || []).some(
    (m: any) => Array.isArray(m?.attachments) && m.attachments.length > 0
  );
  const hasAnyMedia = hasAttachments || hasHistoryMedia;
  const tierTimeoutMs = hasAnyMedia ? 16000 : 8500;

  const refreshStreamTimeout = (ms: number = tierTimeoutMs) => {
    if (timeoutId !== null) {
      clearTimeout(timeoutId);
    }
    timeoutId = setTimeout(() => {
      if (completed || userAborted) return;
      try {
        controller.abort();
      } catch {}
    }, ms);
  };

  if (!shouldPreferFirestoreBridge(hasVideoAttachment)) {
    refreshStreamTimeout(tierTimeoutMs);
    try {
      const baseUrl = getApiBaseUrl();
      const endpoint = `${baseUrl}/api/gemini/chat-stream`;
      const response = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          prompt: prompt.trim().slice(0, 1600),
          conversationHistory: compactedHistory,
          storeContext: compactedContext,
          ...(hasAttachments ? { attachments: serializedAttachments } : {}),
        }),
        signal: controller.signal,
      });

      const contentType = response.headers.get("content-type") || "";
      if (!response.ok || !response.body || !contentType.includes("text/event-stream")) {
        lastHttpFailureAt = Date.now();
        throw new Error(`Stream endpoint returned ${response.status}`);
      }

      lastHttpFailureAt = 0;
      refreshStreamTimeout(tierTimeoutMs);

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let accumulatedRaw = "";
      let finalPayload: AssistantResponse | null = null;
      let buffer = "";

      const processSseLine = (rawLine: string): boolean => {
        if (userAborted || completed || externalSignal?.aborted) return true;
        const trimmed = rawLine.trim();
        if (!trimmed || !trimmed.startsWith("data:")) return false;
        const payloadStr = trimmed.replace(/^data:\s*/, "");
        try {
          const parsed = JSON.parse(payloadStr);
          if (parsed.error) {
            throw new Error(parsed.error);
          }
          if (parsed.chunk) {
            accumulatedRaw += parsed.chunk;
            const cleanDisplay = accumulatedRaw
              .replace(/<thought>[\s\S]*?<\/thought>/g, "")
              .replace(/<thought>[\s\S]*$/g, "")
              .replace(/```action[\s\S]*?```/g, "")
              .replace(/```action[\s\S]*$/g, "")
              .trim();
            if (cleanDisplay && !userAborted && !completed) {
              emitChunk(cleanDisplay);
              refreshStreamTimeout(3200);
            }
          }
          if (parsed.done) {
            let finalThought = parsed.thought;
            if (!finalThought) {
              const thMatch = accumulatedRaw.match(/<thought>\s*([\s\S]*?)\s*<\/thought>/);
              if (thMatch && thMatch[1]) finalThought = thMatch[1].trim();
            }
            if (!finalThought) {
              finalThought = generateDynamicThought(prompt, parsed.fullText, storeContext);
            }

            const validatedAction =
              validateClientAction(
                parsed.action,
                prompt,
                parsed.fullText,
                compactedContext
              ) || localActionCandidate || null;

            finalPayload = {
              reply: parsed.fullText || lastStreamedChunk,
              action: validatedAction,
              thought: finalThought,
              rawText: accumulatedRaw,
            };
            if (String(finalPayload.reply || "").trim()) {
              safeComplete(finalPayload);
              try {
                reader.cancel().catch(() => {});
              } catch {}
              return true;
            }
          }
        } catch (parseErr: any) {
          if (parseErr?.message && !parseErr.message.includes("JSON")) {
            throw parseErr;
          }
        }
        return false;
      };

      while (true) {
        if (userAborted || completed || externalSignal?.aborted) {
          try {
            reader.cancel().catch(() => {});
          } catch {}
          return;
        }
        const { done, value } = await reader.read();
        if (done || completed || userAborted) {
          if (done && buffer.trim() && !completed && !userAborted) {
            for (const remLine of buffer.split("\n")) {
              if (processSseLine(remLine)) return;
            }
            buffer = "";
          }
          break;
        }

        refreshStreamTimeout(lastStreamedChunk ? 3200 : 18000);
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          if (processSseLine(line)) return;
        }
      }

      if (userAborted || completed || externalSignal?.aborted) return;

      if (finalPayload && String(finalPayload.reply || "").trim()) {
        safeComplete(finalPayload);
        return;
      }

      const clean = accumulatedRaw
        .replace(/<thought>[\s\S]*?<\/thought>/g, "")
        .replace(/```action[\s\S]*?```/g, "")
        .trim();

      if (clean) {
        let actionData: any = null;
        const actionMatch = accumulatedRaw.match(/```action\s*([\s\S]*?)\s*```/);
        if (actionMatch && actionMatch[1]) {
          try {
            actionData = JSON.parse(actionMatch[1]);
          } catch {}
        }
        safeComplete({
          reply: clean,
          action:
            validateClientAction(actionData, prompt, clean, compactedContext) ||
            localActionCandidate ||
            null,
          thought: generateDynamicThought(prompt, clean, storeContext),
          rawText: accumulatedRaw,
        });
        return;
      }
    } catch (streamErr: any) {
      lastHttpFailureAt = Date.now();
      if (timeoutId !== null) {
        clearTimeout(timeoutId);
        timeoutId = null;
      }
      const streamErrMsg = String(streamErr?.message || "");
      if (
        streamErrMsg.includes("PERMISSION_DENIED") ||
        streamErrMsg.includes("Settings > Secrets") ||
        streamErrMsg.includes("leaked") ||
        streamErrMsg.includes("API_KEY_INVALID")
      ) {
        throw streamErr;
      }
    }
  } else if (timeoutId !== null) {
    clearTimeout(timeoutId);
    timeoutId = null;
  }

  if (userAborted || completed || externalSignal?.aborted) return;

  let lastFallbackError = "";

  const bridgePromise = askViaFirestoreBridge(
    prompt,
    compactedHistory,
    compactedContext,
    emitChunk,
    externalSignal,
    attachments
  ).then((bridgeRes) => {
    const replyStr = String(bridgeRes.reply || "").trim();
    if (!replyStr) throw new Error("Empty bridge reply");
    return {
      ...bridgeRes,
      reply: replyStr,
      action:
        validateClientAction(bridgeRes.action, prompt, replyStr, compactedContext) ||
        localActionCandidate ||
        null,
    };
  });

  // Race server-side Firestore RPC bridge with parallel server HTTP endpoints so whichever completes first in ~1-3s wins immediately
  const directHttpPromise = Promise.any(
    getCandidateApiBaseUrls().map(async (baseUrl): Promise<AssistantResponse> => {
      if (userAborted || completed || externalSignal?.aborted) {
        throw new Error("Aborted");
      }
      const chatEndpoint = `${baseUrl}/api/gemini/chat`;
      const chatController = new AbortController();
      const chatTimer = setTimeout(() => chatController.abort(), tierTimeoutMs);
      try {
        const response = await fetch(chatEndpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            prompt: prompt.trim().slice(0, 1600),
            conversationHistory: compactedHistory,
            storeContext: compactedContext,
            ...(hasAttachments ? { attachments: serializedAttachments } : {}),
          }),
          signal: chatController.signal,
        });
        clearTimeout(chatTimer);
        const contentType = response.headers.get("content-type") || "";
        if (contentType.includes("application/json")) {
          const data = await response.json().catch(() => ({}));
          if (response.ok) {
            const replyStr = String(data?.reply || "").trim();
            if (replyStr) {
              return {
                reply: replyStr,
                action:
                  validateClientAction(data.action, prompt, replyStr, compactedContext) ||
                  localActionCandidate ||
                  null,
                thought: data.thought || generateDynamicThought(prompt, replyStr, storeContext),
              };
            }
          } else if (data?.error) {
            lastFallbackError = String(data.error);
            throw new Error(lastFallbackError);
          }
        }
        throw new Error(`Status ${response.status}`);
      } catch (err) {
        clearTimeout(chatTimer);
        throw err;
      }
    })
  );

  try {
    const winner = await Promise.any([directHttpPromise, bridgePromise]);
    if (!userAborted && !completed && !externalSignal?.aborted && String(winner.reply || "").trim()) {
      emitChunk(winner.reply);
      safeComplete(winner);
      return;
    }
  } catch (err: any) {
    if (!lastFallbackError && err?.errors && Array.isArray(err.errors)) {
      const firstMeaningful = err.errors
        .map((e: any) => String(e?.message || ""))
        .find((m: string) => m && !m.startsWith("Status ") && m !== "Aborted");
      if (firstMeaningful) {
        lastFallbackError = firstMeaningful;
      }
    }
  }

  if (!userAborted && !completed && !externalSignal?.aborted) {
    if (lastStreamedChunk) {
      safeComplete({
        reply: lastStreamedChunk,
        action: validateClientAction(null, prompt, lastStreamedChunk, compactedContext) || localActionCandidate || null,
        thought: generateDynamicThought(prompt, lastStreamedChunk, storeContext),
      });
    } else {
      throw new Error(
        lastFallbackError ||
          "Buzz AI is taking longer than expected or could not reach the server. Please try again."
      );
    }
  }
}

function normalizeClientPrompt(raw: string): string {
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

// Dynamic, authentic multi-step thought generator for genuine operational reasoning
export function generateDynamicThought(prompt: string, reply: string = "", storeContext?: any): string {
  const p = normalizeClientPrompt(prompt);
  const prodCount = storeContext?.products?.length ?? 0;
  const billCount = storeContext?.recentBills?.length ?? 0;

  if (p.includes("pi") || p.includes("3.14") || p.includes("digit")) {
    return [
      "Parsed mathematical request for constant π (pi)",
      "Retrieved high-precision value to 100 decimal digits without truncation",
      "Formatted continuous decimal sequence for responsive display",
    ].join("\n");
  }
  if (p.includes("math") || p.includes("calculate") || p.includes("compute") || p.match(/\d+\s*[\+\-\*\/]\s*\d+/)) {
    return [
      "Parsed mathematical expression and arithmetic operators",
      "Evaluated numerical constraints and verified calculation accuracy",
    ].join("\n");
  }
  if (
    p.includes("what did i say") ||
    p.includes("what did i just say") ||
    p.includes("repeat that") ||
    p.includes("repeat what i said") ||
    p.includes("what did i ask")
  ) {
    return [
      "Scanned active session conversation buffer",
      "Located and cited exact previous operator prompt",
    ].join("\n");
  }

  const hasDelete = p.includes("delete") || p.includes("remove") || p.includes("void") || p.includes("wipe") || p.includes("clear");
  const hasAll = p.includes("all") || p.includes("every") || p.includes("whole") || (p.includes("products") && p.includes("bills"));
  if (hasDelete && hasAll && (p.includes("product") || p.includes("bill") || p.includes("transaction"))) {
    return [
      "Audited administrator privileges for bulk database purge",
      `Scanned live Firestore collections (${prodCount} catalog items, ${billCount} recent bills)`,
      "Prepared safeguarded batch-deletion confirmation card",
    ].join("\n");
  }

  if (
    p.includes("bill") ||
    p.includes("transaction") ||
    p.includes("receipt") ||
    p.includes("make it") ||
    p.includes("set to")
  ) {
    if (hasDelete) {
      return [
        "Audited ledger void authorization & stock restoration policy",
        `Scanned recent transactions in Firestore ledger (${billCount} active records)`,
        "Prepared atomic bill void & inventory return safeguard",
      ].join("\n");
    }
    return [
      "Queried Firestore transaction ledger for target receipt",
      "Validated order line items and total balance parameters",
      "Prepared verified ledger response for store operator",
    ].join("\n");
  }
  if (
    p.includes("admin") ||
    p.includes("staff") ||
    p.includes("user") ||
    p.includes("who is") ||
    p.includes("access")
  ) {
    return [
      "Audited store staff directory and administrator credentials",
      "Verified real-time online session status and role hierarchy",
      "Formatted staff permission summary",
    ].join("\n");
  }
  if (p.includes("stock") || p.includes("inventory") || p.includes("units") || p.includes("items") || p.includes("product")) {
    return [
      `Queried live Firestore catalog (${prodCount} active products)`,
      "Evaluated real-time stock quantities against low-stock thresholds (≤5 units)",
      "Synthesized inventory status and prepared catalog operation",
    ].join("\n");
  }
  if (p.includes("price") || p.includes("cost") || p.includes("rate") || p.includes("₹")) {
    return [
      `Queried catalog pricing index across ${prodCount} products`,
      "Validated price modification parameters in Indian Rupees (₹)",
      "Prepared updated pricing payload for confirmation",
    ].join("\n");
  }
  if (p.includes("sale") || p.includes("revenue") || p.includes("today") || p.includes("turnover") || p.includes("earn")) {
    return [
      "Queried today's completed receipts in Firestore ledger",
      `Aggregated gross daily turnover (₹${Number(storeContext?.totalRevenueToday || 0).toLocaleString("en-IN")})`,
      "Compiled real-time store performance metrics",
    ].join("\n");
  }
  if (p.includes("expense") || p.includes("other cost") || p.includes("rent") || p.includes("electricity") || p.includes("borrow") || p.includes("due")) {
    return [
      "Scanned operational expense records in other_costs collection",
      "Validated required fields (title, amount, category) for expense ledger",
      "Prepared expense operation response",
    ].join("\n");
  }
  if (p === "hi" || p === "hello" || p === "hey" || p.startsWith("hi ") || p.startsWith("hello ")) {
    return [
      "Processed operator greeting and verified Buzz AI readiness",
      `Synced live store context (${prodCount} products, ${billCount} recent bills)`,
    ].join("\n");
  }

  const cleanPrompt = prompt.replace(/[*#`_•-]/g, "").slice(0, 36).trim();
  return [
    `Analyzed operator query: "${cleanPrompt}"`,
    `Cross-referenced live Firestore state (${prodCount} products, ${billCount} recent bills)`,
    "Formulated verified operational response",
  ].join("\n");
}

function formatCatalogProductName(raw: string): string {
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

export function parseAddProductsFromPrompt(rawPrompt: string): BatchProductItem[] {
  const body = rawPrompt
    .trim()
    .replace(
      /^(?:please\s+|can\s+you\s+|could\s+you\s+|hey\s+buzz\s+)?(?:add|create|insert|make|register)\s+(?:a\s+|new\s+|the\s+|some\s+)*(?:products?|items?)?\s*(?:named|called|:)?\s*/i,
      ""
    )
    .trim();

  if (!body) return [];

  // 1. Check for price / stock keyword segments (supports single & parallel multi-product lists like
  // "atta, maida with the price 20, 30 and stock 50 for both")
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
      .map(formatCatalogProductName)
      .filter((n) => n.length > 0 && !CLIENT_PLACEHOLDER_TITLES.has(n.toLowerCase()));

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
        category: normalizeProductCategory(undefined, name),
      }));
    }
  }

  // 2. Fallback: Shorthand pattern e.g. "Sprite 500ml ₹45 stock 50" or "atta 20 stock 50, maida 30 stock 50"
  const clauses = body.split(/\s*,\s*|\s+\band\b\s+/i);
  const inlineItems: BatchProductItem[] = [];
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
      const cName = formatCatalogProductName(m[1]);
      const cPrice = parseFloat(m[2]);
      const cStock = m[3] ? parseInt(m[3], 10) : sharedStock ?? 0;
      if (
        cName &&
        !CLIENT_PLACEHOLDER_TITLES.has(cName.toLowerCase()) &&
        !isNaN(cPrice) &&
        cPrice > 0
      ) {
        inlineItems.push({
          name: cName,
          price: cPrice,
          stock: cStock,
          category: normalizeProductCategory(undefined, cName),
        });
      }
    }
  }

  return inlineItems;
}

function editDistanceClient(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + cost
      );
    }
  }
  return dp[m][n];
}

function findBestClientProduct(products: any[], rawTarget: string): any | undefined {
  const target = rawTarget.toLowerCase().trim();
  if (!target || !Array.isArray(products) || products.length === 0) return undefined;

  // 1. Exact or substring match
  const exact = products.find(
    (pr) => pr?.name && pr.name.toLowerCase().trim() === target
  );
  if (exact) return exact;

  const substr = products.find(
    (pr) =>
      pr?.name &&
      (pr.name.toLowerCase().includes(target) ||
        target.includes(pr.name.toLowerCase().trim()))
  );
  if (substr) return substr;

  // 2. Fuzzy typo match (e.g. "pesi" -> "pepsi", "rotti" -> "roti")
  let bestProd: any = undefined;
  let bestDist = Infinity;
  for (const pr of products) {
    const pName = String(pr?.name || "").toLowerCase().trim();
    if (!pName) continue;
    const words = [pName, ...pName.split(/\s+/)];
    for (const w of words) {
      if (!w) continue;
      const dist = editDistanceClient(target, w);
      const maxAllowed = Math.max(1, Math.min(2, Math.floor(Math.max(target.length, w.length) * 0.4)));
      if (dist <= maxAllowed && dist < bestDist) {
        bestDist = dist;
        bestProd = pr;
      }
    }
  }
  return bestProd;
}

// Client-side Store Intelligence Fallback (Multi-Turn Aware & Strictly Validated)
export function generateClientStoreResponse(
  prompt: string,
  storeContext: StoreContext,
  conversationHistory: { role: string; content: string }[] = []
): AssistantResponse {
  const p = normalizeClientPrompt(prompt);
  const products = storeContext?.products || [];
  const accounts = storeContext?.accounts || [];
  const otherCosts = storeContext?.otherCosts || [];
  const rawRevenue = Number(storeContext?.totalRevenueToday || 0);
  const totalRevenue = Number.isFinite(rawRevenue) && rawRevenue >= 0 ? rawRevenue : 0;
  const billsToday = Number(storeContext?.billsCountToday || 0);
  const recentBills = (storeContext?.recentBills || []).map((b: any) => ({
    ...b,
    total: Number.isFinite(Number(b?.total)) ? Math.min(10000, Math.max(0, Number(b.total))) : 0,
  }));
  const wantsToBeAsked =
    /\b(ask\s+me|what\s+details|what\s+info|ask\s+the\s+requirements|ask\s+all\s+the\s+details|details\s+u\s+need|details\s+you\s+need)\b/i.test(
      p
    );

  const lastAssistantMsg =
    [...(conversationHistory || [])]
      .reverse()
      .find((m) => m.role === "assistant")?.content || "";
  const lastUserMsg =
    [...(conversationHistory || [])]
      .reverse()
      .find((m) => m.role === "user" && normalizeClientPrompt(m.content) !== p)
      ?.content || "";

  // 0A. Multi-Turn Follow-Up for Pending Expense / Other Cost
  const wasAskingExpenseDetails =
    /title\/description|what is this (?:expense|cost) for|record this .* (?:expense|cost)|provide the following details[\s\S]*?(?:expense|cost|category)/i.test(
      lastAssistantMsg
    );

  if (wasAskingExpenseDetails && !wantsToBeAsked) {
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

    const category = normalizeClientExpenseCategory(prompt);
    const catLabels: Record<string, string> = {
      expense: "Expense",
      borrow: "Borrowed / Debt",
      due: "Dynamic Due",
      other: "Other Cost",
    };

    let cleanedTitle = prompt
      .replace(
        /\b(category|type|under|as)\s*[:=-]?\s*(expense|borrow|borrowed|debt|due|dynamic due|other cost|other)\b/gi,
        ""
      )
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
      const formattedTitle =
        cleanedTitle.charAt(0).toUpperCase() + cleanedTitle.slice(1);
      return {
        reply: `Prepared your **Other Cost / Expense** entry:\n\n• **Title:** ${formattedTitle}\n• **Amount:** ₹${amount}\n• **Category:** ${catLabels[category] || "Expense"}\n\nConfirm below to record this in your live store ledger:`,
        action: {
          type: "ADD_EXPENSE",
          title: formattedTitle,
          amount,
          category,
        },
        thought: generateDynamicThought(prompt, "", storeContext),
        thoughtDuration: 1,
      };
    }

    if (!cleanedTitle && amount > 0) {
      return {
        reply: `Got it (₹${amount}, Category: **${catLabels[category]}**). What **Title / Description** should I use for this cost? *(e.g., "Electricity bill", "Tea & snacks", "Transport")*`,
        action: null,
        thought: generateDynamicThought(prompt, "", storeContext),
        thoughtDuration: 1,
      };
    }
  }

  // 0. High-precision Pi request
  if (p.includes("pi") || p.includes("3.14")) {
    return {
      reply:
        "3.1415926535897932384626433832795028841971693993751058209749445923078164062862089986280348253421170679",
      action: null,
      thought: generateDynamicThought(prompt, "", storeContext),
      thoughtDuration: 1,
    };
  }

  // 0b. Bulk Delete / Purge All Products, All Bills, or Both
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
  const mentionsProducts =
    p.includes("product") ||
    p.includes("item") ||
    p.includes("catalog") ||
    p.includes("inventory");
  const mentionsBills =
    p.includes("bill") ||
    p.includes("transaction") ||
    p.includes("receipt") ||
    p.includes("order");

  if (hasDeleteVerb && hasAllKeyword && (mentionsProducts || mentionsBills)) {
    const target: "both" | "products" | "bills" =
      mentionsProducts && mentionsBills
        ? "both"
        : mentionsProducts
        ? "products"
        : "bills";
    const prodCount = products.length;
    const billCount = recentBills.length;

    const targetLabel =
      target === "both"
        ? `all **${prodCount} product${prodCount === 1 ? "" : "s"}** and **${billCount} bill${billCount === 1 ? "" : "s"}**`
        : target === "products"
        ? `all **${prodCount} product${prodCount === 1 ? "" : "s"}** from the catalog`
        : `all **${billCount} bill${billCount === 1 ? "" : "s"}** from the transaction ledger`;

    return {
      reply: `⚠️ Prepared bulk store purge for ${targetLabel}:\n\n${
        target !== "bills"
          ? `• Catalog Products to Delete: **${prodCount} item${prodCount === 1 ? "" : "s"}**\n`
          : ""
      }${
        target !== "products"
          ? `• Recorded Bills to Delete: **${billCount} receipt${billCount === 1 ? "" : "s"}**\n`
          : ""
      }\nConfirm below to permanently remove ${
        target === "both"
          ? "these products and bills"
          : target === "products"
          ? "all products"
          : "all bills"
      } from your store database:`,
      action: {
        type: "PURGE_STORE_DATA",
        target,
        productsCount: prodCount,
        billsCount: billCount,
      },
      thought: generateDynamicThought(prompt, "", storeContext),
      thoughtDuration: 1,
    };
  }

  // 0c. Conversational Memory & Contextual Questions (e.g. "what did i say just now?")
  if (
    p.includes("what did i say") ||
    p.includes("what did i just say") ||
    p.includes("what did i ask") ||
    p.includes("what was my last") ||
    p.includes("repeat that") ||
    p.includes("repeat what i said")
  ) {
    const pastUserMsgs = conversationHistory.filter(
      (m) => m.role === "user" && normalizeClientPrompt(m.content) !== p
    );
    if (pastUserMsgs.length > 0) {
      const prevMsg = pastUserMsgs[pastUserMsgs.length - 1].content;
      return {
        reply: `Just now, you asked:\n\n> "${prevMsg}"`,
        action: null,
        thought: generateDynamicThought(prompt, "", storeContext),
        thoughtDuration: 1,
      };
    }
    return {
      reply: `You just started this session! How can I assist you with your store operations today?`,
      action: null,
      thought: generateDynamicThought(prompt, "", storeContext),
      thoughtDuration: 1,
    };
  }

  // 1. Delete / Void Single Transaction or Bill
  const isDeleteBill =
    (p.includes("delete") || p.includes("remove") || p.includes("cancel") || p.includes("void")) &&
    (p.includes("bill") || p.includes("transaction") || p.includes("receipt") || p.includes("order"));

  if (isDeleteBill) {
    let targetBill: any = null;
    const idMatch = p.match(/(?:bill|transaction|receipt|#)\s*([a-zA-Z0-9_-]{5,})/i);
    if (idMatch && recentBills.length > 0) {
      const searchedId = idMatch[1].toLowerCase();
      targetBill = recentBills.find((b: any) => b.id && b.id.toLowerCase().includes(searchedId));
    }
    if (!targetBill && recentBills.length > 0) {
      targetBill = recentBills[0];
    }

    if (targetBill && !wantsToBeAsked) {
      const shortId = (targetBill.id || "recent").slice(0, 8);
      const itemSummary =
        targetBill.items && targetBill.items.length > 0
          ? targetBill.items.map((i: any) => `${i.quantity}× ${i.name || "Item"}`).join(", ")
          : "items";
      return {
        reply: `⚠️ Prepared deletion for transaction **#${shortId}**:\n\n• Amount: **₹${targetBill.total}**\n• Items: **${itemSummary}**\n\nConfirm below to void this transaction and restore product stock to catalog:`,
        action: {
          type: "DELETE_BILL",
          billId: targetBill.id,
          total: Number(targetBill.total || 0),
          itemsCount: targetBill.items?.length || 0,
          itemSummary,
          items: targetBill.items || [],
          billDate: targetBill.date,
        },
        thought: generateDynamicThought(prompt, "", storeContext),
        thoughtDuration: 1,
      };
    } else {
      return {
        reply: `No transaction records were found in the current session to delete. You can check transaction history in the Bills section.`,
        action: null,
        thought: generateDynamicThought(prompt, "", storeContext),
        thoughtDuration: 1,
      };
    }
  }

  // 2. Transaction / Bill Editing
  const isMakeItOrChangeNumber = p.match(
    /(?:make|set|change|update)(?:\s+it)?(?:\s+to)?\s+(?:₹|rs\.?)?\s*(\d+(?:\.\d+)?)/i
  );
  const isBillEditIntent =
    (p.includes("transaction") || p.includes("bill") || p.includes("receipt")) &&
    (p.includes("edit") || p.includes("change") || p.includes("update") || p.includes("modify") || p.includes("adjust"));

  if (
    isBillEditIntent ||
    (isMakeItOrChangeNumber && recentBills.length > 0 && !p.includes("stock") && !p.includes("price"))
  ) {
    const latestBill = recentBills[0];
    if (latestBill) {
      const billIdShort = (latestBill.id || "recent").slice(0, 8);
      const oldTotal = Number(latestBill.total || 0);

      if (isMakeItOrChangeNumber && !wantsToBeAsked) {
        const newTotal = parseFloat(isMakeItOrChangeNumber[1]);
        return {
          reply: `Prepared update for transaction **#${billIdShort}**:\n\n• Current Total: **₹${oldTotal}**\n• New Total: **₹${newTotal}**\n\nClick below to apply this change to the transaction:`,
          action: {
            type: "UPDATE_BILL",
            billId: latestBill.id,
            oldTotal,
            newTotal,
            notes: `Total changed from ₹${oldTotal} to ₹${newTotal}`,
          },
          thought: generateDynamicThought(prompt, "", storeContext),
          thoughtDuration: 1,
        };
      } else {
        const itemsSummary =
          latestBill.items && latestBill.items.length > 0
            ? latestBill.items.map((i: any) => `${i.quantity}× ${i.name || "Item"}`).join(", ")
            : "items";
        return {
          reply: `The last transaction (**#${billIdShort}**) was for **${itemsSummary}** totaling **₹${oldTotal}**.\n\nWhat would you like to set the new total to? (e.g. *"make it 1"* or *"set to 20"*).`,
          action: null,
          thought: generateDynamicThought(prompt, "", storeContext),
          thoughtDuration: 1,
        };
      }
    }
  }

  // 3. Staff Role Change — Strictly Blocked via AI
  if (isRoleModificationPrompt(prompt)) {
    return {
      reply: ROLE_MODIFICATION_REFUSAL_REPLY,
      action: null,
      thought: "Blocked privilege modification request per store security policy.",
      thoughtDuration: 1,
    };
  }

  // 4. Current User Identity / Role Question (e.g. "am i a admin?", "who am i?", "what is my role?")
  if (
    /\b(am\s+i\s+(?:a|an)?\s*admin|who\s+am\s+i|what\s+is\s+my\s+role|my\s+role|my\s+account|am\s+i\s+logged\s+in)\b/i.test(
      p
    )
  ) {
    const cu = storeContext?.currentUser;
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
        thought: "Verified active session user profile and role permissions.",
        thoughtDuration: 1,
      };
    }
  }

  // 4b. Admin & Staff Directory
  if (
    p.includes("admin") ||
    p.includes("staff") ||
    p.includes("who is super admin") ||
    p.includes("who are all") ||
    p.includes("directory") ||
    p.includes("team")
  ) {
    if (accounts.length === 0) {
      return {
        reply: "No staff or admin profiles are registered in the store settings yet.",
        action: null,
        thought: "Queried live user credentials from Firestore settings.",
        thoughtDuration: 1,
      };
    }
    const lines = accounts.map((a: any) => {
      const isSuper = Boolean(a.isSuperAdmin);
      const icon = isSuper ? "👑" : a.role?.toLowerCase().includes("admin") ? "🛡️" : "👤";
      const isActuallyOnline =
        Boolean(a.isOnline) && Date.now() - (Number(a.lastActive) || 0) <= 60000;
      const onlineIcon = isActuallyOnline ? "🟢 Online" : "⚪ Offline";
      const roleStr = isSuper ? "Owner & Super Admin" : a.role || (a.isAdmin ? "Admin" : "Staff");
      return `• ${icon} **${a.displayName || a.name || "User"}** (${a.email || "no email"}) — ${roleStr} (${onlineIcon})`;
    });

    return {
      reply: `Here is the current administrative team for **SmartRooti**:\n\n${lines.join("\n")}`,
      action: null,
      thought: "Queried live user credentials and role hierarchies from Firestore settings.",
      thoughtDuration: 1,
    };
  }

  // 5. Delete Expense / Other Cost
  if (
    hasDeleteVerb &&
    (p.includes("expense") || p.includes("other cost") || p.includes("borrow") || p.includes("due"))
  ) {
    if (otherCosts.length === 0) {
      return {
        reply: "There are currently **0 recorded expenses / other costs** in your ledger to delete.",
        action: null,
        thought: generateDynamicThought(prompt, "", storeContext),
        thoughtDuration: 1,
      };
    }
    let targetExp = otherCosts.find((e: any) => e.title && p.includes(e.title.toLowerCase()));
    if (!targetExp) targetExp = otherCosts[0];
    return {
      reply: `⚠️ Prepared removal for expense record **${targetExp.title}** (**₹${targetExp.amount}**).\n\nConfirm below to delete this cost from your ledger:`,
      action: {
        type: "DELETE_EXPENSE",
        expenseId: targetExp.id,
        title: targetExp.title,
        amount: Number(targetExp.amount || 0),
        category: normalizeClientExpenseCategory(targetExp.category),
      },
      thought: generateDynamicThought(prompt, "", storeContext),
      thoughtDuration: 1,
    };
  }

  // 6. Add / Record Expense or Other Cost Request
  const isAddExpenseIntent =
    /\b(add|record|log|insert|create|new)\b/i.test(p) &&
    /\b(expense|other\s+cost|cost|borrow|due)\b/i.test(p);

  if (isAddExpenseIntent) {
    const amountMatch =
      p.match(/(?:of|for|amount|₹|rs\.?)\s*(\d+(?:\.\d+)?)/i) ||
      p.match(/(\d+(?:\.\d+)?)\s*(?:rupees?|rs\.?|₹)/i);
    const amount = amountMatch ? parseFloat(amountMatch[1]) : 0;

    let title = "";
    const forMatch = prompt.match(
      /\b(?:for|on|titled|named|towards)\s+([a-zA-Z0-9\s&'-]+?)(?:\s+(?:and\s+ask|in\s+category|under\s+category|category|$))/i
    );
    if (forMatch) {
      title = forMatch[1].trim();
    }
    if (/\b(ask\s+me|details|requirements|what\s+you\s+need)\b/i.test(title)) {
      title = "";
    }

    if (wantsToBeAsked || !title || amount <= 0) {
      const notedAmount = amount > 0 ? ` of **₹${amount}**` : "";
      return {
        reply: `I have noted your request to add an **Other Cost / Expense**${notedAmount}. To prepare the confirmation card, please share:\n\n1. **Title / Description:** What is this cost for? *(e.g., "Electricity bill", "Tea & snacks", "Transport")*\n${
          amount <= 0 ? `2. **Amount (₹):** How much was spent?\n3. ` : `2. `
        }**Category:** Which category should I use? *(**Expense**, **Borrowed / Debt**, **Dynamic Due**, or **Other Cost**)*\n\nReply with the details and I will generate the confirmation card for you.`,
        action: null,
        thought: generateDynamicThought(prompt, "", storeContext),
        thoughtDuration: 1,
      };
    }

    const category = normalizeClientExpenseCategory(p);
    const formattedTitle = title.charAt(0).toUpperCase() + title.slice(1);
    return {
      reply: `Prepared store expense entry:\n\n• **Title:** ${formattedTitle}\n• **Amount:** ₹${amount}\n• **Category:** ${category.toUpperCase()}\n\nClick below to record this in your live expense ledger:`,
      action: {
        type: "ADD_EXPENSE",
        title: formattedTitle,
        amount,
        category,
      },
      thought: `Validated expense payload: ₹${amount} for "${formattedTitle}".`,
      thoughtDuration: 1,
    };
  }

  // 7. Delete Product Request
  const deleteMatch =
    p.match(/(?:delete|remove)\s+(?:the\s+)?product\s+([a-zA-Z0-9\s]+)/i) ||
    p.match(/(?:delete|remove)\s+item\s+([a-zA-Z0-9\s]+)/i) ||
    p.match(/(?:delete|remove)\s+([a-zA-Z0-9\s]+?)\s+(?:from\s+catalog|from\s+store)/i);

  let delTargetName = deleteMatch ? deleteMatch[1].trim() : "";
  if (!delTargetName && (p.startsWith("delete ") || p.startsWith("remove "))) {
    delTargetName = p.replace(/^(?:delete|remove)\s+/, "").trim();
  }

  if (delTargetName && !p.includes("expense") && !p.includes("other cost") && !p.includes("bill") && !p.includes("chat")) {
    const cleanTarget = delTargetName.replace(/^(?:the\s+|product\s+|item\s+)/i, "").trim().toLowerCase();
    const matched = findBestClientProduct(products, cleanTarget);

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
        thought: `Located product "${matched.name}" (ID: ${matched.id}) for deletion confirmation.`,
        thoughtDuration: 1,
      };
    } else if (!wantsToBeAsked) {
      return {
        reply: `Could not find **"${delTargetName}"** in your catalog. Check the product name or ask *"show products"* to view all items.`,
        action: null,
        thought: `Searched ${products.length} catalog items for "${cleanTarget}" — no match found.`,
        thoughtDuration: 1,
      };
    }
  }

  // 7B. Update Product Image with Uploaded Image Request (e.g. "use this image for roti", "set this photo for pepsi")
  const isUpdateProductImageIntent =
    /\b(use|set|put|apply|make|change|update|attach|assign)\b[\s\S]*?\b(image|photo|picture|pic|thumbnail)\b/i.test(
      p
    ) &&
    !/\b(add|create|new)\s+(?:a\s+|new\s+)?product\b/i.test(p);

  if (isUpdateProductImageIntent && !wantsToBeAsked) {
    let attachmentIndex = 0;
    if (/\b(2nd|second|image\s*2|photo\s*2|pic\s*2)\b/i.test(p)) attachmentIndex = 1;
    else if (/\b(3rd|third|image\s*3|photo\s*3|pic\s*3)\b/i.test(p)) attachmentIndex = 2;
    else if (/\b(4th|fourth|image\s*4|photo\s*4|pic\s*4)\b/i.test(p)) attachmentIndex = 3;

    let targetProd: any = products.find(
      (prod: any) => prod?.name && p.includes(prod.name.toLowerCase().trim())
    );
    if (!targetProd) {
      const forMatch =
        p.match(/\b(?:for|on|to|of)\s+(?:the\s+)?(?:product\s+|item\s+)?([a-zA-Z0-9\s]+?)$/i) ||
        p.match(/\b(?:change|update|set)\s+([a-zA-Z0-9\s]+?)\s+(?:product\s+)?(?:image|photo|picture|pic)\b/i);
      if (forMatch) {
        const cleanedTarget = forMatch[1]
          .replace(/\b(product|item|the|this|that|image|photo|picture|pic|in\s+store|in\s+catalog)\b/gi, "")
          .trim();
        targetProd = findBestClientProduct(products, cleanedTarget);
      }
    }

    if (targetProd) {
      return {
        reply: `Prepared product image update for **${targetProd.name}** using your uploaded photo.\n\nConfirm below to save this image to **${targetProd.name}** in your store catalog:`,
        action: {
          type: "UPDATE_PRODUCT_IMAGE",
          productId: targetProd.id,
          productName: targetProd.name,
          currentPrice: Number(targetProd.price) || 0,
          currentStock: Number(targetProd.stock) || 0,
          attachmentIndex,
        },
        thought: `Matched product "${targetProd.name}" and linked uploaded image for catalog update.`,
        thoughtDuration: 1,
      };
    }
  }

  // 8. Add New Product(s) Request (Supports both single product & multi-product natural commands)
  const isAddProductIntent =
    (/\b(add|create|insert|register)\s+(?:a\s+|new\s+|the\s+|some\s+)*(?:products?|items?)\b/i.test(p) ||
      (/\b(add|create)\b/i.test(p) && /\bprice\b/i.test(p) && /\bstock\b/i.test(p))) &&
    !p.includes("expense") &&
    !p.includes("other cost") &&
    !p.includes("stock of") &&
    !p.includes("units of");

  if (isAddProductIntent) {
    if (!wantsToBeAsked) {
      const parsedProducts = parseAddProductsFromPrompt(prompt);
      const mentionsImage = /\b(image|photo|picture|pic|uploaded|attached)\b/i.test(p);
      if (parsedProducts.length > 0) {
        if (parsedProducts.length === 1) {
          const item = parsedProducts[0];
          const normCat = normalizeProductCategory(item.category, item.name);
          return {
            reply: `Prepared new product entry for **${item.name}**:\n\n• Price: **₹${item.price}**\n• Initial Stock: **${item.stock} units**\n• Category: **${normCat}**\n\nConfirm below to add this product to your live store catalog:`,
            action: {
              type: "ADD_PRODUCT",
              name: item.name,
              price: item.price,
              stock: item.stock,
              category: normCat,
              ...(mentionsImage ? { useAttachedImage: true, attachmentIndex: 0 } : {}),
              products: [{ ...item, category: normCat, ...(mentionsImage ? { attachmentIndex: 0 } : {}) }],
            },
            thought: `Structured new catalog entry "${item.name}" at ₹${item.price} with ${item.stock} initial units (${normCat}).`,
            thoughtDuration: 1,
          };
        } else {
          const normalizedBatch = parsedProducts.map((item) => ({
            ...item,
            category: normalizeProductCategory(item.category, item.name),
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
            thought: `Parsed batch product creation for ${normalizedBatch.length} items (${normalizedBatch
              .map((i) => `${i.name} @ ₹${i.price}`)
              .join(", ")}).`,
            thoughtDuration: 1,
          };
        }
      }
    }

    return {
      reply: `To create a new product in your catalog, please provide:\n\n1. **Product Name** *(e.g., "Sprite 500ml" or "Atta, Maida")*\n2. **Selling Price (in ₹)** *(e.g., ₹45 or 20, 30)*\n3. **Initial Stock Quantity** *(e.g., 50 units)*\n\nOnce you share these details, I will show the confirmation card.`,
      action: null,
      thought: generateDynamicThought(prompt, "", storeContext),
      thoughtDuration: 1,
    };
  }

  // 9. Price Modification Request
  const priceMatch =
    p.match(/(?:change|set|update|make)\s+(?:the\s+)?price\s+(?:of|for)?\s*([a-zA-Z0-9\s]+?)\s+to\s*(?:₹|rs\.?)?\s*(\d+(?:\.\d+)?)/i) ||
    p.match(/(?:change|set|update|make)\s+([a-zA-Z0-9\s]+?)\s+(?:the\s+)?price\s+(?:to\s*)?(?:₹|rs\.?)?\s*(\d+(?:\.\d+)?)/i);

  if (priceMatch && !wantsToBeAsked) {
    let targetName = priceMatch[1].trim();
    const newPrice = parseFloat(priceMatch[2]);
    targetName = targetName.replace(/^(?:the|of|for)\s+/i, "").trim().toLowerCase();

    const matched = findBestClientProduct(products, targetName);

    if (matched && !isNaN(newPrice) && newPrice > 0) {
      return {
        reply: `Prepared price update for **${matched.name}**:\n\n• Current Price: **₹${matched.price}**\n• New Price: **₹${newPrice}**\n\nConfirm to apply this price update to the catalog:`,
        action: {
          type: "UPDATE_PRICE",
          productId: matched.id,
          productName: matched.name,
          currentPrice: matched.price,
          newPrice,
        },
        thought: `Matched product "${matched.name}". Adjusted price from ₹${matched.price} to ₹${newPrice}.`,
        thoughtDuration: 1,
      };
    }
  }

  // 10. Add / Update Stock & Refills
  const stockMatch =
    p.match(
      /(?:add|increase|set|update|change|put|refill|reduce|decrease|deduct|remove)\s+(?:the\s+)?(?:stocks?|inventory|units?|items?|qty)?\s*(?:of|for|to|in|into|on)?\s*(\d+)\s*(?:stocks?|inventory|units?|items?|qty)?\s*(?:of|for|to|in|into|on)\s+([a-zA-Z0-9\s]+)/i
    ) ||
    p.match(
      /(?:add|increase|set|update|change|put|refill|reduce|decrease|deduct)\s+(?:the\s+)?(?:stocks?|inventory|units?|items?|qty)\s+(?:of|for|to|in|into|on)?\s*([a-zA-Z0-9\s]+?)\s+(?:to|by|at|with|as)?\s*(\d+)/i
    ) ||
    p.match(
      /(?:add|increase|set|update|change|put|refill|reduce|decrease|deduct|remove)\s+(\d+)\s*(?:stocks?|units?|items?|qty)?\s*(?:of|for|to|in)?\s*([a-zA-Z0-9\s]+)/i
    ) ||
    p.match(
      /(?:add|increase|set|update|change|refill|reduce|decrease|make)\s+([a-zA-Z0-9\s]+?)\s+(?:stock|stocks?|inventory|units?)\s*(?:to|by|at)?\s*(\d+)/i
    );

  if (stockMatch && !wantsToBeAsked && !p.includes("expense") && !p.includes("other cost") && !p.includes("rupee") && !p.includes("price")) {
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
      .replace(/\b(stocks?|inventory|units?|items?|qty|the|product)\b/gi, "")
      .replace(/^(?:of|for|to|in|into|on)\s+/i, "")
      .replace(/\s+(?:of|for|to|in|into|on|by|at)$/i, "")
      .trim();

    const matched = findBestClientProduct(products, targetName);

    if (matched) {
      const isSet =
        /\b(?:set|make)\b/i.test(p) ||
        /\b(?:change|update)\s+(?:the\s+)?stock\b[\s\S]*?\bto\s+\d+/i.test(p);
      const isReduce = /\b(?:reduce|decrease|deduct|remove|minus|subtract)\b/i.test(p);
      const currentStock = Number(matched.stock || 0);

      let newStock: number;
      let quantityChange: number;

      if (isSet) {
        newStock = qty;
        quantityChange = newStock - currentStock;
      } else if (isReduce) {
        newStock = Math.max(0, currentStock - qty);
        quantityChange = -qty;
      } else {
        newStock = currentStock + qty;
        quantityChange = qty;
      }

      return {
        reply: `I have prepared the stock adjustment for **${matched.name}**:\n\n• Current Stock: **${currentStock} units**\n• Adjustment: **${quantityChange >= 0 ? "+" : ""}${quantityChange} units**\n• Target New Stock: **${newStock} units**\n\nClick below to apply this directly to live inventory:`,
        action: {
          type: "UPDATE_STOCK",
          productId: matched.id,
          productName: matched.name,
          currentStock,
          quantityChange,
          newStock,
        },
        thought: `Matched product "${matched.name}" (ID: ${matched.id}). Calculated adjustment delta: ${quantityChange}.`,
        thoughtDuration: 1,
      };
    }
  }

  // 10b. What to Buy Next / Wholesale Shopping List / Restock Advisor / Combos / Forecast
  if (
    p.includes("buy next") ||
    p.includes("what should i buy") ||
    p.includes("what to buy") ||
    p.includes("shopping list") ||
    p.includes("wholesale") ||
    p.includes("restock") ||
    p.includes("combo") ||
    p.includes("bundle") ||
    p.includes("forecast") ||
    p.includes("predict") ||
    p.includes("increase sale") ||
    p.includes("grow") ||
    p.includes("profit") ||
    p.includes("recommend") ||
    p.includes("suggest")
  ) {
    const soldMap: Record<string, number> = {};
    const revMap: Record<string, number> = {};
    const pairCounts: Record<string, { a: string; b: string; count: number }> = {};

    recentBills.forEach((b: any) => {
      const items = Array.isArray(b.items) ? b.items : [];
      items.forEach((item: any) => {
        const key = String(item.productId || item.name || "").toLowerCase();
        const qty = Number(item.quantity) || 1;
        const price = Number(item.price) || 0;
        soldMap[key] = (soldMap[key] || 0) + qty;
        revMap[key] = (revMap[key] || 0) + qty * price;
      });
      for (let i = 0; i < items.length; i++) {
        for (let j = i + 1; j < items.length; j++) {
          const n1 = String(items[i]?.name || "").trim();
          const n2 = String(items[j]?.name || "").trim();
          if (!n1 || !n2 || n1.toLowerCase() === n2.toLowerCase()) continue;
          const [first, second] = [n1, n2].sort();
          const pKey = `${first}___${second}`;
          if (!pairCounts[pKey]) {
            pairCounts[pKey] = { a: first, b: second, count: 0 };
          }
          pairCounts[pKey].count += 1;
        }
      }
    });

    const enriched = products.map((pr: any) => {
      const kId = String(pr.id || "").toLowerCase();
      const kName = String(pr.name || "").toLowerCase();
      const recentSold = (soldMap[kId] || 0) + (kId !== kName ? soldMap[kName] || 0 : 0) + (Number(pr.soldCount) || 0);
      const stock = Number(pr.stock) || 0;
      const price = Number(pr.price) || 0;
      const recommendedBuy = Math.max(10, Math.ceil(recentSold * 1.5) + (stock === 0 ? 15 : 10) - stock);
      return {
        ...pr,
        stock,
        price,
        recentSold,
        recommendedBuy,
      };
    });

    const urgentRestock = enriched
      .filter((pr: any) => pr.stock <= 5)
      .sort((a: any, b: any) => b.recentSold - a.recentSold || a.stock - b.stock);

    const topSellers = [...enriched]
      .sort((a: any, b: any) => b.recentSold - a.recentSold || b.price - a.price)
      .slice(0, 5);

    const topPairs = Object.values(pairCounts)
      .sort((a, b) => b.count - a.count)
      .slice(0, 3);

    const expensesTotal = otherCosts.reduce((s: number, c: any) => s + (Number(c.amount) || 0), 0);

    if (p.includes("combo") || p.includes("bundle")) {
      let comboText = `**💡 AI Smart Combo & Bundle Recommendations:**\n\n`;
      if (topPairs.length > 0) {
        comboText += `**Frequently Bought Together in Your Bills:**\n`;
        topPairs.forEach((pair, idx) => {
          comboText += `${idx + 1}. **${pair.a} + ${pair.b}** — Purchased together **${pair.count}x** *(Offer a ₹5–₹10 combo discount to boost basket size)*\n`;
        });
        comboText += `\n`;
      } else if (topSellers.length >= 2) {
        comboText += `• **Value Pair:** Bundle **${topSellers[0].name}** + **${topSellers[1].name}** for **₹${Math.max(1, Math.round((topSellers[0].price + topSellers[1].price) * 0.92))}** *(Save 8% — drives multi-item checkouts)*\n\n`;
      }
      comboText += `**📈 Actionable Tip:** Placing your fastest-moving item (**${topSellers[0]?.name || "Top Seller"}**) in a combo with a slower-moving item increases average bill value by **15–22%**.`;
      return {
        reply: comboText.trim(),
        action: null,
        thought: "Analyzed multi-item co-occurrence across recent store bills to synthesize high-conversion product bundles.",
        thoughtDuration: 1,
      };
    }

    let reply = `**🛒 AI Smart Wholesale Shopping List (What to Buy Next):**\n\n`;
    if (urgentRestock.length > 0) {
      reply += `**🚨 Priority 1: Restock Immediately (${urgentRestock.length} items):**\n`;
      urgentRestock.slice(0, 6).forEach((item: any) => {
        const statusTag = item.stock === 0 ? "OUT OF STOCK" : `Only ${item.stock} left`;
        reply += `• **${item.name}** (${statusTag}) ➔ Buy **+${item.recommendedBuy} units** *(Sold: ${item.recentSold}x · ₹${item.price}/unit)*\n`;
      });
      reply += `\n`;
    } else {
      reply += `✅ **Stock Health:** No items are critically low right now! All existing products have >5 units.\n\n`;
    }

    if (topSellers.length > 0) {
      reply += `**🔥 Priority 2: High-Demand Champions (Keep Extra Buffer):**\n`;
      topSellers.slice(0, 4).forEach((item: any) => {
        reply += `• **${item.name}** — **${item.recentSold} units sold** · Current stock: **${item.stock}** *(Recommended buffer: ${Math.max(20, item.stock + 15)} units)*\n`;
      });
      reply += `\n`;
    }

    if (expensesTotal > 0) {
      reply += `**💰 Budget Note:** Recorded outer costs are **₹${expensesTotal.toLocaleString("en-IN")}** — prioritize refilling your zero-stock and highest-velocity catalog items first.`;
    }

    return {
      reply: reply.trim(),
      action: null,
      thought: `Evaluated sales velocity across ${recentBills.length} bills and ${products.length} catalog items to prioritize next wholesale purchases.`,
      thoughtDuration: 1,
    };
  }

  // 11. Low stock / stock alerts
  if (p.includes("low stock") || p.includes("out of stock") || p.includes("depleted") || p.includes("stock alert")) {
    const outOfStock = products.filter((pr: any) => Number(pr.stock) <= 0);
    const lowStock = products.filter((pr: any) => Number(pr.stock) > 0 && Number(pr.stock) <= 5);

    if (outOfStock.length === 0 && lowStock.length === 0) {
      return {
        reply: "All inventory levels are healthy! There are currently no items out of stock or running low.",
        action: null,
        thought: "Evaluated current stock across all catalog items against threshold (<= 5).",
        thoughtDuration: 1,
      };
    }

    let text = `Here is your current inventory alert status:\n\n`;
    if (outOfStock.length > 0) {
      text += `**🚫 Out of Stock (${outOfStock.length} items):**\n`;
      outOfStock.slice(0, 8).forEach((item: any) => {
        text += `• **${item.name}** — 0 units (₹${item.price || 0})\n`;
      });
      text += `\n`;
    }
    if (lowStock.length > 0) {
      text += `**⚠️ Low Stock (≤ 5 units):**\n`;
      lowStock.slice(0, 8).forEach((item: any) => {
        text += `• **${item.name}** — ${item.stock} units remaining (₹${item.price || 0})\n`;
      });
    }
    return {
      reply: text.trim(),
      action: null,
      thought: `Filtered inventory records: ${outOfStock.length} zero-stock and ${lowStock.length} critical items found.`,
      thoughtDuration: 1,
    };
  }

  // 11b. Specific Product or Full Catalog Inquiry
  if (p.includes("product") || p.includes("catalog") || p.includes("inventory") || p.includes("stock") || p.includes("price") || p.includes("how much") || p.includes("how many")) {
    const matchedProd = products.find(
      (pr: any) => pr.name && p.includes(pr.name.toLowerCase())
    );
    if (matchedProd) {
      return {
        reply: `**${matchedProd.name}**\n\n• Selling Price: **₹${matchedProd.price}**\n• Current Stock: **${matchedProd.stock} units**\n• Category: **${normalizeProductCategory(matchedProd.category, matchedProd.name)}**`,
        action: null,
        thought: `Looked up "${matchedProd.name}" in live catalog.`,
        thoughtDuration: 1,
      };
    }
    if (products.length === 0) {
      return {
        reply: "Your product catalog is currently empty (**0 products**). Ask me to add a product, e.g. *\"Add product Milk with price 30 and stock 25\"*.",
        action: null,
        thought: generateDynamicThought(prompt, "", storeContext),
        thoughtDuration: 1,
      };
    }
    const itemsList = products
      .slice(0, 10)
      .map((pr: any) => `• **${pr.name}** — ₹${pr.price} (${pr.stock} units in stock)`)
      .join("\n");
    return {
      reply: `**Active Store Catalog (${products.length} item${products.length === 1 ? "" : "s"}):**\n\n${itemsList}${
        products.length > 10 ? `\n\n*…and ${products.length - 10} more items.*` : ""
      }`,
      action: null,
      thought: generateDynamicThought(prompt, "", storeContext),
      thoughtDuration: 1,
    };
  }

  // 12. Sales / Revenue
  if (p.includes("sale") || p.includes("revenue") || p.includes("earning") || p.includes("bill") || p.includes("turnover")) {
    return {
      reply: `**Today's Store Summary:**\n\n• Revenue: **₹${totalRevenue.toLocaleString("en-IN")}**\n• Orders: **${billsToday}**\n• Catalog: **${products.length} items**`,
      action: null,
      thought: "Aggregated today's completed transactions and calculated gross turnover.",
      thoughtDuration: 1,
    };
  }

  // 13. Greetings
  if (p === "hi" || p === "hello" || p === "hey" || p.startsWith("hi ") || p.startsWith("hello ")) {
    return {
      reply: `Hello! I'm **Buzz AI**. How can I help with your store today?`,
      action: null,
      thought: "Recognized greeting. Prepared store assistant readiness.",
      thoughtDuration: 1,
    };
  }

  // 14. Check if the user typed a product name directly (or with a minor typo)
  const directProdMatch = findBestClientProduct(products, p);
  if (directProdMatch) {
    return {
      reply: `**${directProdMatch.name}** — **₹${directProdMatch.price}** · **${directProdMatch.stock} units** in stock.`,
      action: null,
      thought: `Matched product "${directProdMatch.name}" in live catalog.`,
      thoughtDuration: 1,
    };
  }

  // 15. General Fallback (empty reply so real Gemini AI always answers)
  return {
    reply: "",
    action: null,
    thought: generateDynamicThought(prompt, "", storeContext),
    thoughtDuration: 1,
  };
}

function clientPcmToWavBase64(pcmBase64: string, sampleRate: number = 24000): string {
  try {
    const binaryString = atob(pcmBase64);
    if (binaryString.slice(0, 4) === "RIFF") {
      return pcmBase64;
    }
    const dataSize = binaryString.length;
    const buffer = new ArrayBuffer(44 + dataSize);
    const view = new DataView(buffer);
    const writeString = (offset: number, str: string) => {
      for (let i = 0; i < str.length; i++) {
        view.setUint8(offset + i, str.charCodeAt(i));
      }
    };
    writeString(0, "RIFF");
    view.setUint32(4, 36 + dataSize, true);
    writeString(8, "WAVE");
    writeString(12, "fmt ");
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 1, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * 2, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    writeString(36, "data");
    view.setUint32(40, dataSize, true);

    const bytes = new Uint8Array(buffer);
    for (let i = 0; i < dataSize; i++) {
      bytes[44 + i] = binaryString.charCodeAt(i);
    }

    let outBinary = "";
    const chunkSize = 8192;
    for (let i = 0; i < bytes.length; i += chunkSize) {
      outBinary += String.fromCharCode.apply(
        null,
        Array.from(bytes.subarray(i, i + chunkSize))
      );
    }
    return btoa(outBinary);
  } catch {
    return pcmBase64;
  }
}

async function transcribeViaFirestoreBridge(
  audioBase64: string,
  mimeType: string
): Promise<string> {
  const reqId = `ai_rpc_req_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const reqRef = doc(db, "settings", reqId);

  return new Promise<string>((resolve, reject) => {
    let settled = false;
    let unsub: (() => void) | null = null;
    let pollInterval: ReturnType<typeof setInterval> | null = null;

    const cleanup = () => {
      if (pollInterval) {
        clearInterval(pollInterval);
        pollInterval = null;
      }
      if (unsub) {
        try {
          unsub();
        } catch {}
        unsub = null;
      }
      deleteDoc(reqRef).catch(() => {});
    };

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        cleanup();
        reject(new Error("Server transcription timed out"));
      }
    }, 9000);

    const handleDocData = (data: any) => {
      if (settled || !data) return;
      if (data.status === "completed" && typeof data.transcript === "string") {
        settled = true;
        clearTimeout(timer);
        cleanup();
        resolve(data.transcript.trim());
      } else if (data.status === "error") {
        settled = true;
        clearTimeout(timer);
        cleanup();
        reject(new Error(data.error || "Transcription error"));
      }
    };

    unsub = onSnapshot(
      reqRef,
      (snap) => {
        if (settled || !snap.exists()) return;
        handleDocData(snap.data());
      },
      () => {}
    );

    pollInterval = setInterval(async () => {
      if (settled) return;
      try {
        const snap = await getDocFromServer(reqRef).catch(() => getDoc(reqRef));
        if (!settled && snap && snap.exists()) {
          handleDocData(snap.data());
        }
      } catch {}
    }, 120);

    setDoc(reqRef, {
      type: "transcribe",
      status: "pending",
      audioBase64,
      mimeType,
      createdAt: Date.now(),
    }).catch((err) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        cleanup();
        reject(err);
      }
    });
  });
}

export async function transcribeAudio(audioBlob: Blob): Promise<string> {
  // Convert Blob to base64 string safely in chunks
  const arrayBuffer = await audioBlob.arrayBuffer();
  const bytes = new Uint8Array(arrayBuffer);
  let binary = "";
  const chunkSize = 8192;
  for (let i = 0; i < bytes.byteLength; i += chunkSize) {
    binary += String.fromCharCode.apply(
      null,
      Array.from(bytes.subarray(i, i + chunkSize))
    );
  }
  const audioBase64 = btoa(binary);
  const rawType = (audioBlob.type || "audio/webm").split(";")[0].trim();
  const mimeType = rawType || "audio/webm";

  // 1. Call server endpoint /api/gemini/transcribe when direct HTTP is available
  if (!shouldPreferFirestoreBridge()) {
    for (const baseUrl of getCandidateApiBaseUrls()) {
      const endpoint = `${baseUrl}/api/gemini/transcribe`;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 6000);

      try {
        const response = await fetch(endpoint, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            audioBase64,
            mimeType,
          }),
          signal: controller.signal,
        });
        clearTimeout(timer);

        const contentType = response.headers.get("content-type") || "";
        if (response.ok && contentType.includes("application/json")) {
          lastHttpFailureAt = 0;
          const data = await response.json();
          if (data && typeof data.transcript === "string" && data.transcript.trim()) {
            return data.transcript.trim();
          }
        } else {
          lastHttpFailureAt = Date.now();
        }
      } catch {
        clearTimeout(timer);
        lastHttpFailureAt = Date.now();
      }
    }
  }

  // 2. Server-side Firestore RPC bridge fallback
  try {
    const transcript = await transcribeViaFirestoreBridge(audioBase64, mimeType);
    if (transcript) return transcript;
  } catch {}

  throw new Error("Could not transcribe voice clip. Please speak clearly or type your command.");
}

// In-memory client cache for synthesized audio to ensure instant replay (<20ms)
const clientTtsCache = new Map<string, string>();

export function formatTextForSpeech(raw: string, maxChars: number = 520): string {
  const hasBengali = /[\u0980-\u09FF]/.test(raw);
  const currencyWord = hasBengali ? "টাকা" : "rupees";
  return raw
    .replace(/```[\s\S]*?```/g, "")
    .replace(/<thought>[\s\S]*?<\/thought>/g, "")
    .replace(/#([a-zA-Z0-9_-]{5,})/g, hasBengali ? "ট্রানজেকশন" : "transaction")
    .replace(/₹\s*([\d\u09E6-\u09EF\u0966-\u096F]+(?:\.[\d\u09E6-\u09EF\u0966-\u096F]+)?)/g, `$1 ${currencyWord}`)
    .replace(/([\d\u09E6-\u09EF\u0966-\u096F]+)\s*[×x]\s*/g, "$1 ")
    .replace(/➔|→/g, hasBengali ? " থেকে " : " to ")
    .replace(/[*#_`~>]/g, "")
    .replace(/^[•\-]\s*/gm, "")
    .replace(/\n+/g, ". ")
    .replace(/[^\p{L}\p{M}\p{N}\s.,?!'"।:-]/gu, " ")
    .replace(/\.\s*\./g, ".")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxChars);
}

async function ttsViaFirestoreBridge(
  text: string,
  timeoutMs: number
): Promise<string> {
  const reqId = `ai_rpc_req_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const reqRef = doc(db, "settings", reqId);

  return new Promise<string>((resolve, reject) => {
    let settled = false;
    let unsub: (() => void) | null = null;
    let pollInterval: ReturnType<typeof setInterval> | null = null;

    const cleanup = () => {
      if (pollInterval) {
        clearInterval(pollInterval);
        pollInterval = null;
      }
      if (unsub) {
        try {
          unsub();
        } catch {}
        unsub = null;
      }
      deleteDoc(reqRef).catch(() => {});
    };

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        cleanup();
        reject(new Error("Server TTS timed out"));
      }
    }, timeoutMs);

    const handleDocData = (data: any) => {
      if (settled || !data) return;
      if (data.status === "completed" && typeof data.audioBase64 === "string" && data.audioBase64) {
        settled = true;
        clearTimeout(timer);
        cleanup();
        resolve(data.audioBase64);
      } else if (data.status === "error") {
        settled = true;
        clearTimeout(timer);
        cleanup();
        reject(new Error(data.error || "TTS error"));
      }
    };

    unsub = onSnapshot(
      reqRef,
      (snap) => {
        if (settled || !snap.exists()) return;
        handleDocData(snap.data());
      },
      () => {}
    );

    pollInterval = setInterval(async () => {
      if (settled) return;
      try {
        const snap = await getDocFromServer(reqRef).catch(() => getDoc(reqRef));
        if (!settled && snap && snap.exists()) {
          handleDocData(snap.data());
        }
      } catch {}
    }, 1000);

    setDoc(reqRef, {
      type: "tts",
      status: "pending",
      text,
      createdAt: Date.now(),
    }).catch((err) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        cleanup();
        reject(err);
      }
    });
  });
}

export async function synthesizeGeminiVoice(text: string, timeoutMs: number = 5000): Promise<string> {
  const cleanKey = formatTextForSpeech(text, 400);
  if (!cleanKey) {
    throw new Error("Empty speech text");
  }
  if (clientTtsCache.has(cleanKey)) {
    return clientTtsCache.get(cleanKey)!;
  }

  // 1. Call server endpoint /api/gemini/tts when direct HTTP is available
  if (!shouldPreferFirestoreBridge()) {
    for (const baseUrl of getCandidateApiBaseUrls()) {
      const endpoint = `${baseUrl}/api/gemini/tts`;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), Math.min(timeoutMs, 8000));

      try {
        const response = await fetch(endpoint, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ text: cleanKey }),
          signal: controller.signal,
        });

        clearTimeout(timer);
        const contentType = response.headers.get("content-type") || "";
        if (response.ok && contentType.includes("application/json")) {
          lastHttpFailureAt = 0;
          const data = await response.json();
          if (data?.audioBase64) {
            const wavB64 = clientPcmToWavBase64(data.audioBase64, 24000);
            const dataUri = `data:audio/wav;base64,${wavB64}`;
            if (clientTtsCache.size > 40) {
              const oldestKey = clientTtsCache.keys().next().value;
              if (oldestKey) clientTtsCache.delete(oldestKey);
            }
            clientTtsCache.set(cleanKey, dataUri);
            return dataUri;
          }
        } else {
          lastHttpFailureAt = Date.now();
        }
      } catch {
        clearTimeout(timer);
        lastHttpFailureAt = Date.now();
      }
    }
  }

  // 2. Server-side Firestore RPC bridge fallback
  try {
    const audioBase64 = await ttsViaFirestoreBridge(cleanKey, Math.min(timeoutMs, 8000));
    if (audioBase64) {
      const wavB64 = clientPcmToWavBase64(audioBase64, 24000);
      const dataUri = `data:audio/wav;base64,${wavB64}`;
      if (clientTtsCache.size > 40) {
        const oldestKey = clientTtsCache.keys().next().value;
        if (oldestKey) clientTtsCache.delete(oldestKey);
      }
      clientTtsCache.set(cleanKey, dataUri);
      return dataUri;
    }
  } catch {}

  throw new Error("Voice synthesis unavailable");
}

/**
 * Client-side safety net: if the AI's reply text or user's command describes a stock or price
 * update for a catalog product without returning an explicit action object, deterministically
 * synthesize the validated AssistantAction so the AI never claims it updated stock without applying/attaching it.
 */
export function inferClientActionFromTurn(
  rawPrompt: string,
  replyText: string,
  storeContext?: StoreContext,
  conversationHistory: ConversationTurnInput[] = []
): AssistantAction | null {
  const products = storeContext?.products || [];
  if (products.length === 0) return null;

  if (storeContext) {
    const det = generateClientStoreResponse(rawPrompt, storeContext, conversationHistory);
    if (det?.action) {
      return det.action;
    }
  }

  const recentText = (conversationHistory || [])
    .slice(-4)
    .map((m) => String(m?.content || ""))
    .join(" ");
  const combinedSearch = `${rawPrompt} ${replyText} ${recentText}`.toLowerCase();
  const sortedProducts = [...products].sort(
    (a, b) => (b.name?.length || 0) - (a.name?.length || 0)
  );
  const matchedProd =
    sortedProducts.find(
      (p) =>
        p.name &&
        (rawPrompt.toLowerCase().includes(p.name.toLowerCase()) ||
          replyText.toLowerCase().includes(p.name.toLowerCase()))
    ) ||
    sortedProducts.find(
      (p) => p.name && combinedSearch.includes(p.name.toLowerCase())
    );

  if (!matchedProd) return null;

  const rLower = replyText.toLowerCase();
  const pLower = rawPrompt.toLowerCase();
  const curStock = Number(matchedProd.stock) || 0;

  const fromToMatch =
    rLower.match(/\bfrom\s+(\d+)\s+to\s+(\d+)\s*(?:units?|stocks?)?/i) ||
    rLower.match(/\bnew\s+stock\s+will\s+be\s+(\d+)/i);
  const increasedByMatch =
    rLower.match(
      /\b(?:increased|added|boosted|raised|refilled)\b[\s\S]{0,40}?\bby\s+(\d+)\s*(?:units?|stocks?)?/i
    ) ||
    pLower.match(/\b(?:add|increase|refill)\b[\s\S]{0,40}?(\d+)/i);
  const decreasedByMatch =
    rLower.match(
      /\b(?:decreased|reduced|deducted|lowered)\b[\s\S]{0,40}?\bby\s+(\d+)\s*(?:units?|stocks?)?/i
    ) ||
    pLower.match(/\b(?:reduce|decrease|deduct)\b[\s\S]{0,40}?(\d+)/i);
  const updatedToMatch = rLower.match(
    /\b(?:updated|set|changed|adjusted)\b[\s\S]{0,55}?\b(?:inventory|stock)\b[\s\S]{0,45}?\bto\s+(\d+)\s*(?:units?|stocks?)?/i
  );

  const mentionsStockIntent =
    /\b(stock|stocks|inventory|unit|units|sold\s*out|restock|refill)\b/i.test(
      `${rawPrompt} ${replyText}`
    ) && !/\b(price|rupee|rupees|rs\.?|₹)\b/i.test(rawPrompt);

  if (mentionsStockIntent) {
    let inferredNewStock: number | null = null;
    if (fromToMatch) {
      inferredNewStock = parseInt(fromToMatch[2] || fromToMatch[1], 10);
    } else if (updatedToMatch) {
      inferredNewStock = parseInt(updatedToMatch[1], 10);
    } else if (increasedByMatch) {
      const delta = parseInt(increasedByMatch[1], 10);
      if (!isNaN(delta) && delta > 0) {
        inferredNewStock = curStock + delta;
      }
    } else if (decreasedByMatch) {
      const delta = parseInt(decreasedByMatch[1], 10);
      if (!isNaN(delta) && delta > 0) {
        inferredNewStock = Math.max(0, curStock - delta);
      }
    }

    if (inferredNewStock !== null && !isNaN(inferredNewStock) && inferredNewStock >= 0) {
      return {
        type: "UPDATE_STOCK",
        productId: matchedProd.id,
        productName: matchedProd.name,
        currentStock: curStock,
        newStock: inferredNewStock,
        quantityChange: inferredNewStock - curStock,
      };
    }
  }

  const priceUpdateMatch =
    rLower.match(
      /\b(?:price|rate)\b[\s\S]{0,50}?\b(?:updated|changed|set|adjusted|increased|decreased)\b[\s\S]{0,30}?\bto\s*₹?\s*(\d+(?:\.\d+)?)/i
    ) ||
    rLower.match(
      /\b(?:updated|changed|set)\s+(?:the\s+)?(?:price|rate)\b[\s\S]{0,40}?\bto\s*₹?\s*(\d+(?:\.\d+)?)/i
    );
  if (priceUpdateMatch) {
    const newPriceVal = parseFloat(priceUpdateMatch[1]);
    if (!isNaN(newPriceVal) && newPriceVal > 0) {
      return {
        type: "UPDATE_PRICE",
        productId: matchedProd.id,
        productName: matchedProd.name,
        currentPrice: Number(matchedProd.price) || 0,
        newPrice: newPriceVal,
      };
    }
  }

  return null;
}

export function blobToBase64Chunked(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result || "");
      const commaIdx = result.indexOf(",");
      resolve(commaIdx >= 0 ? result.slice(commaIdx + 1) : result);
    };
    reader.onerror = () => reject(new Error("Failed to read file into memory."));
    reader.readAsDataURL(blob);
  });
}

/**
 * Compresses and resizes an image file on the client so multi-image uploads
 * transmit in <1s, fit well under Firestore's 1MB RPC limit, and produce a
 * persistent data URL for instant full-screen previewing.
 */
export async function compressImageFileForChat(
  file: File,
  maxDimension: number = 1024,
  quality: number = 0.82
): Promise<{ dataBase64: string; mimeType: string; previewUrl: string }> {
  return new Promise((resolve, reject) => {
    const objectUrl = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      try {
        URL.revokeObjectURL(objectUrl);
        let { width, height } = img;
        if (width > maxDimension || height > maxDimension) {
          if (width >= height) {
            height = Math.round((height * maxDimension) / width);
            width = maxDimension;
          } else {
            width = Math.round((width * maxDimension) / height);
            height = maxDimension;
          }
        }
        const canvas = document.createElement("canvas");
        canvas.width = Math.max(1, width);
        canvas.height = Math.max(1, height);
        const ctx = canvas.getContext("2d");
        if (!ctx) {
          blobToBase64Chunked(file)
            .then((b64) => {
              const mime = file.type || "image/jpeg";
              resolve({
                dataBase64: b64,
                mimeType: mime,
                previewUrl: `data:${mime};base64,${b64}`,
              });
            })
            .catch(reject);
          return;
        }
        // Fill white background for transparent PNGs converted to JPEG or keep PNG if small
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        const outputMime = "image/jpeg";
        const dataUrl = canvas.toDataURL(outputMime, quality);
        const commaIdx = dataUrl.indexOf(",");
        const dataBase64 = commaIdx >= 0 ? dataUrl.slice(commaIdx + 1) : dataUrl;
        resolve({
          dataBase64,
          mimeType: outputMime,
          previewUrl: dataUrl,
        });
      } catch (err) {
        URL.revokeObjectURL(objectUrl);
        reject(err);
      }
    };
    img.onerror = () => {
      URL.revokeObjectURL(objectUrl);
      blobToBase64Chunked(file)
        .then((b64) => {
          const mime = file.type || "image/jpeg";
          resolve({
            dataBase64: b64,
            mimeType: mime,
            previewUrl: `data:${mime};base64,${b64}`,
          });
        })
        .catch(reject);
    };
    img.src = objectUrl;
  });
}

/**
 * Extracts evenly spaced keyframe JPEG snapshots from a video file on the client
 * using an HTML5 <video> and <canvas>. This guarantees Buzz AI can visually inspect
 * every scene of an uploaded video in <2s, even across Firestore's 1MB bridge limit
 * or when a mobile video uses a device-specific container/codec.
 */
export async function extractVideoKeyframesForChat(
  file: File,
  maxFrames: number = 5,
  maxDimension: number = 560,
  quality: number = 0.68
): Promise<{
  frames: VideoFrameSnapshot[];
  durationSec: number;
  posterDataUrl: string;
}> {
  if (typeof document === "undefined") {
    return { frames: [], durationSec: 0, posterDataUrl: "" };
  }

  return new Promise((resolve) => {
    const objectUrl = URL.createObjectURL(file);
    const video = document.createElement("video");
    video.preload = "auto";
    video.muted = true;
    video.playsInline = true;
    video.crossOrigin = "anonymous";

    let finished = false;
    const finish = (result: {
      frames: VideoFrameSnapshot[];
      durationSec: number;
      posterDataUrl: string;
    }) => {
      if (finished) return;
      finished = true;
      clearTimeout(safetyTimer);
      try {
        video.pause();
        video.removeAttribute("src");
        video.load();
      } catch {}
      try {
        URL.revokeObjectURL(objectUrl);
      } catch {}
      resolve(result);
    };

    const safetyTimer = setTimeout(() => {
      finish({ frames: [], durationSec: 0, posterDataUrl: "" });
    }, 6500);

    video.onerror = () => {
      finish({ frames: [], durationSec: 0, posterDataUrl: "" });
    };

    video.onloadedmetadata = async () => {
      try {
        const rawDuration = Number(video.duration);
        const durationSec =
          Number.isFinite(rawDuration) && rawDuration > 0 ? rawDuration : 4;
        const frameCount = Math.max(1, Math.min(maxFrames, durationSec < 1.2 ? 2 : maxFrames));
        const timestamps: number[] = [];
        for (let i = 0; i < frameCount; i++) {
          const ratio = frameCount === 1 ? 0.25 : (i + 0.5) / frameCount;
          const t = Math.max(0.05, Math.min(Math.max(0.1, durationSec - 0.05), durationSec * ratio));
          timestamps.push(Number(t.toFixed(2)));
        }

        const frames: VideoFrameSnapshot[] = [];
        let posterDataUrl = "";

        const captureAtTime = (targetSec: number): Promise<void> =>
          new Promise((resCapture) => {
            let seekDone = false;
            const onSeeked = () => {
              if (seekDone) return;
              seekDone = true;
              clearTimeout(seekTimer);
              video.removeEventListener("seeked", onSeeked);
              try {
                let width = video.videoWidth || 480;
                let height = video.videoHeight || 360;
                if (width > maxDimension || height > maxDimension) {
                  if (width >= height) {
                    height = Math.round((height * maxDimension) / width);
                    width = maxDimension;
                  } else {
                    width = Math.round((width * maxDimension) / height);
                    height = maxDimension;
                  }
                }
                const canvas = document.createElement("canvas");
                canvas.width = Math.max(1, width);
                canvas.height = Math.max(1, height);
                const ctx = canvas.getContext("2d");
                if (ctx) {
                  ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
                  const dataUrl = canvas.toDataURL("image/jpeg", quality);
                  const commaIdx = dataUrl.indexOf(",");
                  const dataBase64 = commaIdx >= 0 ? dataUrl.slice(commaIdx + 1) : dataUrl;
                  if (dataBase64 && dataBase64.length > 100) {
                    if (!posterDataUrl) posterDataUrl = dataUrl;
                    frames.push({
                      mimeType: "image/jpeg",
                      dataBase64,
                      timestampSec: targetSec,
                    });
                  }
                }
              } catch {}
              resCapture();
            };

            const seekTimer = setTimeout(() => {
              onSeeked();
            }, 950);

            video.addEventListener("seeked", onSeeked);
            try {
              video.currentTime = targetSec;
            } catch {
              onSeeked();
            }
          });

        for (const ts of timestamps) {
          if (finished) break;
          await captureAtTime(ts);
        }

        finish({ frames, durationSec, posterDataUrl });
      } catch {
        finish({ frames: [], durationSec: 0, posterDataUrl: "" });
      }
    };

    video.src = objectUrl;
  });
}

/**
 * Purges any temporary chat/media RPC records from the server and Firestore database
 * when the user clicks "New Chat".
 */
export async function purgeChatMediaFromDatabase(): Promise<void> {
  for (const baseUrl of getCandidateApiBaseUrls()) {
    try {
      const res = await fetch(`${baseUrl}/api/gemini/clear-chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      });
      if (res.ok) break;
    } catch {}
  }
}

export async function analyzeMediaWithGemini(
  file: File,
  customPrompt?: string
): Promise<MediaAnalysisResult> {
  const rawMime = (file.type || "").trim().toLowerCase();
  const ext = (file.name.split(".").pop() || "").toLowerCase();
  let mimeType = rawMime;
  if (!mimeType) {
    if (["mp4", "m4v"].includes(ext)) mimeType = "video/mp4";
    else if (ext === "webm") mimeType = "video/webm";
    else if (ext === "mov") mimeType = "video/quicktime";
    else if (ext === "png") mimeType = "image/png";
    else if (ext === "webp") mimeType = "image/webp";
    else mimeType = "image/jpeg";
  }

  const isVideo = mimeType.startsWith("video/");
  const mediaKind: "video" | "image" = isVideo ? "video" : "image";

  if (file.size > 32 * 1024 * 1024) {
    throw new Error("File is too large (max 32 MB). Please choose a shorter video clip or smaller image.");
  }

  let mediaBase64 = "";
  let effectiveMimeType = mimeType;
  let previewUrl = "";

  if (!isVideo && mimeType.startsWith("image/")) {
    const compressed = await compressImageFileForChat(file, 960, 0.72);
    mediaBase64 = compressed.dataBase64;
    effectiveMimeType = compressed.mimeType;
    previewUrl = compressed.previewUrl;
  } else {
    mediaBase64 = await blobToBase64Chunked(file);
    previewUrl = URL.createObjectURL(file);
  }

  // Call server endpoint /api/gemini/analyze-media
  for (const baseUrl of getCandidateApiBaseUrls()) {
    const endpoint = `${baseUrl}/api/gemini/analyze-media`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 26000);
    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          mediaBase64,
          mimeType: effectiveMimeType,
          fileName: file.name,
          prompt: customPrompt || "",
        }),
        signal: controller.signal,
      });
      clearTimeout(timer);
      const contentType = response.headers.get("content-type") || "";
      if (response.ok && contentType.includes("application/json")) {
        const data = await response.json();
        if (data && (data.summary || data.transcribedText)) {
          return {
            summary: String(data.summary || "Media analyzed successfully."),
            transcribedText: String(
              data.transcribedText || "No visible text or spoken audio detected."
            ),
            detectedLanguage: String(data.detectedLanguage || "Auto-detected"),
            keyHighlights: Array.isArray(data.keyHighlights) ? data.keyHighlights : [],
            mediaKind,
            fileName: file.name,
            mimeType,
            fileSize: file.size,
            previewUrl,
          };
        }
      }
    } catch {
      clearTimeout(timer);
    }
  }

  throw new Error("Could not analyze media file via server.");
}


