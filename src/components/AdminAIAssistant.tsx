import React, { useState, useEffect, useRef, useMemo } from "react";
import { createPortal } from "react-dom";
import { motion, AnimatePresence } from "motion/react";
import { computeLiveThinkingSeconds, computeFinalThoughtSeconds } from "../lib/thinkingTimer";
import {
  Send,
  X,
  Trash2,
  Package,
  TrendingUp,
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  RefreshCw,
  Mic,
  MicOff,
  Copy,
  Check,
  Tag,
  PlusCircle,
  ShieldCheck,
  Users,
  Volume2,
  VolumeX,
  Zap,
  ChevronDown,
  ChevronUp,
  Brain,
  Sparkles,
  RotateCcw,
  Receipt,
  Square,
  Film,
  Image as ImageIcon,
  Paperclip,
  Plus,
  Maximize2,
  ChevronLeft,
  ChevronRight,
  Quote,
} from "lucide-react";
import { triggerHaptic } from "../lib/haptics";
import { useAuth } from "../lib/AuthContext";
import { logActivity, deleteBillAndRestoreStock, deleteProduct } from "../lib/firestoreHooks";
import { useGlobalProducts, purgeStockAlertsForDeletedProducts } from "../lib/ProductsContext";
import { useGlobalBills } from "../lib/BillsContext";
import { db } from "../lib/firebase";
import {
  sqliteSaveBill,
  sqliteDeleteBill,
  sqliteClearProducts,
  sqliteClearBills,
} from "../lib/sqliteAdapter";
import {
  collection,
  doc,
  updateDoc,
  addDoc,
  deleteDoc,
  setDoc,
  getDocs,
  query,
  orderBy,
  limit,
  onSnapshot,
} from "firebase/firestore";
import {
  askGeminiAssistant,
  askGeminiAssistantStream,
  transcribeAudio,
  synthesizeGeminiVoice,
  formatTextForSpeech,
  generateClientStoreResponse,
  generateDynamicThought,
  validateClientAction,
  normalizeClientExpenseCategory,
  normalizeProductCategory,
  isRoleModificationPrompt,
  ROLE_MODIFICATION_REFUSAL_REPLY,
  blobToBase64Chunked,
  compressImageFileForChat,
  extractVideoKeyframesForChat,
  MAX_MEDIA_ATTACHMENTS,
  purgeChatMediaFromDatabase,
  wakeUpBuzzServer,
  sanitizeLatexAndMathFormatting,
  inferClientActionFromTurn,
  ConversationTurnInput,
  ChatAttachment,
  ChatMessage,
  AssistantAction,
  StoreContext,
} from "../lib/geminiApi";

interface AdminAIAssistantProps {
  isOpen: boolean;
  onClose: () => void;
  accounts?: any[];
  activityLogs?: any[];
  onProductUpdated?: () => void;
}

// -------------------------------------------------------------
// Markdown Renderer: Cleanly parses **, *, `, headers, bullets & emojis
// -------------------------------------------------------------

function renderInlineTokens(text: string): React.ReactNode[] {
  if (!text) return [];

  // Regex matches:
  // 1. **bold** or __bold__
  // 2. `code`
  // 3. *italic*
  const tokenRegex = /(\*\*[\s\S]*?\*\*|__[\s\S]*?__|\`[^\`]+?\`|\*[^*]+?\*)/g;
  const parts = text.split(tokenRegex);

  return parts.map((part, index) => {
    if (!part) return null;

    // Bold formatting: **bold** or __bold__
    if (
      (part.startsWith("**") && part.endsWith("**") && part.length >= 4) ||
      (part.startsWith("__") && part.endsWith("__") && part.length >= 4)
    ) {
      const boldContent = part.slice(2, -2);
      return (
        <strong
          key={index}
          className="font-bold text-slate-900 dark:text-white tracking-wide break-words [overflow-wrap:anywhere] [word-break:break-word]"
        >
          {boldContent}
        </strong>
      );
    }

    // Inline code: `code`
    if (part.startsWith("`") && part.endsWith("`") && part.length >= 2) {
      const codeContent = part.slice(1, -1);
      return (
        <code
          key={index}
          className="px-1.5 py-0.5 mx-0.5 rounded-md text-[11px] font-mono font-bold bg-indigo-50 dark:bg-white/[0.06] text-indigo-700 dark:text-indigo-300 border border-indigo-200/80 dark:border-white/10 break-words [overflow-wrap:anywhere] [word-break:break-word]"
        >
          {codeContent}
        </code>
      );
    }

    // Italic formatting: *italic*
    if (part.startsWith("*") && part.endsWith("*") && part.length >= 2) {
      const italicContent = part.slice(1, -1);
      return (
        <em key={index} className="italic text-slate-600 dark:text-slate-300 break-words [overflow-wrap:anywhere] [word-break:break-word]">
          {italicContent}
        </em>
      );
    }

    // Regular plain text
    return (
      <span key={index} className="break-words [overflow-wrap:anywhere] [word-break:break-word]">
        {part}
      </span>
    );
  });
}

function MarkdownContent({
  text,
  isStreaming = false,
}: {
  text: string;
  isStreaming?: boolean;
}) {
  if (!text) {
    return null;
  }

  // Pre-clean action blocks, thoughts, and any raw LaTeX ($...$, \pi, etc.) from visible text stream
  const cleanText = sanitizeLatexAndMathFormatting(
    text
      .replace(/<thought>[\s\S]*?<\/thought>/g, "")
      .replace(/<thought>[\s\S]*$/g, "")
      .replace(/```action[\s\S]*?```/g, "")
      .replace(/```action[\s\S]*$/g, "")
      .trim()
  );

  if (!cleanText) {
    return null;
  }

  const lines = cleanText.split("\n");
  const renderedElements: React.ReactNode[] = [];

  let currentListItems: React.ReactNode[] = [];
  let currentTableLines: string[] = [];

  const flushList = (keySuffix: number) => {
    if (currentListItems.length > 0) {
      renderedElements.push(
        <ul key={`list-${keySuffix}`} className="my-2.5 space-y-1.5">
          {currentListItems}
        </ul>
      );
      currentListItems = [];
    }
  };

  const flushTable = (keySuffix: number) => {
    if (currentTableLines.length > 0) {
      const rawRows = currentTableLines.map((l) =>
        l
          .trim()
          .replace(/^\||\|$/g, "")
          .split("|")
          .map((c) => c.trim())
      );
      if (rawRows.length > 0) {
        const header = rawRows[0];
        const isSeparator =
          rawRows.length > 1 &&
          rawRows[1].every((cell) => /^:?-+:?$/.test(cell.trim()));
        const body = isSeparator ? rawRows.slice(2) : rawRows.slice(1);

        renderedElements.push(
          <div
            key={`table-wrapper-${keySuffix}`}
            className="my-3 overflow-x-auto rounded-xl border border-slate-200 dark:border-slate-700/60 bg-white dark:bg-slate-900/90 shadow-sm dark:shadow-lg"
          >
            <table className="w-full text-left text-xs border-collapse">
              {header && (
                <thead>
                  <tr className="bg-slate-100/90 dark:bg-slate-800/90 text-indigo-700 dark:text-indigo-300 border-b border-slate-200 dark:border-slate-700/70 font-bold uppercase tracking-wider text-[10px]">
                    {header.map((col, cIdx) => (
                      <th
                        key={cIdx}
                        className="px-3.5 py-2.5 border-r last:border-r-0 border-slate-200 dark:border-slate-700/60 font-black"
                      >
                        {renderInlineTokens(col)}
                      </th>
                    ))}
                  </tr>
                </thead>
              )}
              <tbody className="divide-y divide-slate-200/80 dark:divide-slate-800/80">
                {body.map((row, rIdx) => (
                  <tr
                    key={rIdx}
                    className={`transition-colors hover:bg-indigo-50/50 dark:hover:bg-slate-800/50 ${
                      rIdx % 2 === 0
                        ? "bg-white dark:bg-slate-900/40"
                        : "bg-slate-50/70 dark:bg-slate-800/25"
                    }`}
                  >
                    {row.map((cell, cIdx) => (
                      <td
                        key={cIdx}
                        className="px-3.5 py-2 text-slate-700 dark:text-slate-200 border-r last:border-r-0 border-slate-200/70 dark:border-slate-800/60 font-medium"
                      >
                        {renderInlineTokens(cell)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        );
      }
      currentTableLines = [];
    }
  };

  lines.forEach((line, idx) => {
    const trimmed = line.trim();
    const isLastLine = idx === lines.length - 1;

    // Check if table row: starts with '|' and ends with '|'
    if (trimmed.startsWith("|") && trimmed.endsWith("|")) {
      flushList(idx);
      currentTableLines.push(trimmed);
      return;
    } else {
      flushTable(idx);
    }

    // Empty lines act as separators
    if (!trimmed) {
      flushList(idx);
      renderedElements.push(<div key={`spacer-${idx}`} className="h-1.5" />);
      return;
    }

    // Horizontal Divider: --- or ***
    if (trimmed === "---" || trimmed === "***") {
      flushList(idx);
      renderedElements.push(
        <hr
          key={`hr-${idx}`}
          className="my-3 border-slate-200 dark:border-slate-700/60"
        />
      );
      return;
    }

    // Headings: #, ##, ###, ####
    if (trimmed.startsWith("#")) {
      flushList(idx);
      const level = (trimmed.match(/^#+/) || ["#"])[0].length;
      const content = trimmed.replace(/^#+\s*/, "");

      if (level <= 2) {
        renderedElements.push(
          <h3
            key={`h-${idx}`}
            className="text-sm sm:text-base font-black text-indigo-700 dark:text-indigo-300 mt-3 mb-1.5 flex items-center gap-2"
          >
            <span className="w-1.5 h-4 rounded-full bg-gradient-to-b from-indigo-500 to-purple-500" />
            {renderInlineTokens(content)}
            {isLastLine && isStreaming && (
              <span className="inline-block w-1.5 h-3.5 ml-1 bg-indigo-500 dark:bg-indigo-400 animate-pulse rounded-sm align-middle" />
            )}
          </h3>
        );
      } else {
        renderedElements.push(
          <h4
            key={`h-${idx}`}
            className="text-xs sm:text-sm font-extrabold text-indigo-600 dark:text-indigo-400 mt-2.5 mb-1 flex items-center gap-1.5"
          >
            <span className="w-1.5 h-1.5 rounded-full bg-indigo-500 dark:bg-indigo-400" />
            {renderInlineTokens(content)}
            {isLastLine && isStreaming && (
              <span className="inline-block w-1.5 h-3.5 ml-1 bg-indigo-500 dark:bg-indigo-400 animate-pulse rounded-sm align-middle" />
            )}
          </h4>
        );
      }
      return;
    }

    // Bullet points: - , * , •
    const bulletMatch = trimmed.match(/^([-*•])\s+(.*)/);
    if (bulletMatch) {
      const bulletContent = bulletMatch[2];
      currentListItems.push(
        <li
          key={`li-${idx}`}
          className="flex items-start gap-2.5 text-xs sm:text-sm leading-relaxed text-slate-700 dark:text-slate-200"
        >
          <span className="w-1.5 h-1.5 rounded-full bg-indigo-500 dark:bg-indigo-400 mt-2 shrink-0 shadow-sm shadow-indigo-400/50" />
          <div className="flex-1 min-w-0">
            {renderInlineTokens(bulletContent)}
            {isLastLine && isStreaming && (
              <span className="inline-block w-1.5 h-3.5 ml-1 bg-indigo-500 dark:bg-indigo-400 animate-pulse rounded-sm align-middle" />
            )}
          </div>
        </li>
      );
      return;
    }

    // Numbered lists: 1. , 2.
    const numberMatch = trimmed.match(/^(\d+)\.\s+(.*)/);
    if (numberMatch) {
      const num = numberMatch[1];
      const numContent = numberMatch[2];
      currentListItems.push(
        <li
          key={`num-li-${idx}`}
          className="flex items-start gap-2.5 text-xs sm:text-sm leading-relaxed text-slate-700 dark:text-slate-200"
        >
          <span className="text-[11px] font-mono font-extrabold text-indigo-600 dark:text-indigo-400 mt-0.5 w-4 shrink-0">
            {num}.
          </span>
          <div className="flex-1 min-w-0">
            {renderInlineTokens(numContent)}
            {isLastLine && isStreaming && (
              <span className="inline-block w-1.5 h-3.5 ml-1 bg-indigo-500 dark:bg-indigo-400 animate-pulse rounded-sm align-middle" />
            )}
          </div>
        </li>
      );
      return;
    }

    // Regular paragraph
    flushList(idx);
    renderedElements.push(
      <p
        key={`p-${idx}`}
        className="text-xs sm:text-sm leading-relaxed text-slate-700 dark:text-slate-200 my-1 break-words [overflow-wrap:anywhere] [word-break:break-word]"
      >
        {renderInlineTokens(line)}
        {isLastLine && isStreaming && (
          <span className="inline-block w-1.5 h-3.5 ml-1 bg-indigo-500 dark:bg-indigo-400 animate-pulse rounded-sm align-middle" />
        )}
      </p>
    );
  });

  flushList(lines.length);
  flushTable(lines.length);

  return <div className="space-y-1 break-words [overflow-wrap:anywhere] [word-break:break-word] min-w-0 max-w-full w-full">{renderedElements}</div>;
}

// -------------------------------------------------------------
// Default Welcome Briefing Message
// -------------------------------------------------------------

export const DEFAULT_WELCOME_MESSAGE: ChatMessage = {
  id: "welcome-system-msg",
  role: "assistant",
  content: `I am **Buzz AI**, your intelligent retail store manager and assistant inside the **Buzz POS & Stock Management** app for SmartRooti! 🐝

Here is what I can help you with:
- 📦 **Stock Management:** Check stock levels, identify low-stock items, and update inventory counts.
- 🏷️ **Product & Pricing:** Create new products or update prices.
- 📊 **Sales & Analytics:** Track today's revenue, review recent bills, and monitor top-selling items.
- 📋 **Expenses:** Keep track of store costs and operational records.

How can I assist you with your store today?`,
  timestamp: Date.now(),
};

// Isolated storage key per user account so chats never bleed into other accounts
function getAccountChatStorageKey(uid?: string, email?: string): string {
  if (uid) return `buzz_ai_chat_v2_${uid}`;
  if (email) return `buzz_ai_chat_v2_${email.replace(/[^a-zA-Z0-9]/g, "_")}`;
  return "buzz_ai_chat_v2_guest";
}

// -------------------------------------------------------------
// Main AI Commander Component
// -------------------------------------------------------------

export function AdminAIAssistant({
  isOpen,
  onClose,
  accounts: propAccounts = [],
  activityLogs: propActivityLogs = [],
  onProductUpdated,
}: AdminAIAssistantProps) {
  const { user, isAdmin, isRealAdmin } = useAuth();
  const {
    products,
    addProductOptimistic,
    updateProductOptimistic,
    removeProductOptimistic,
    clearProductsOptimistic,
  } = useGlobalProducts();
  const { bills, removeBillOptimistic, clearBillsOptimistic } = useGlobalBills();
  const [otherCosts, setOtherCosts] = useState<any[]>([]);
  const [internalAccounts, setInternalAccounts] = useState<any[]>([]);
  const [internalLogs, setInternalLogs] = useState<any[]>([]);

  // Unique key for the currently logged-in account
  const currentAccountKey = useMemo(() => {
    return getAccountChatStorageKey(user?.uid, user?.email);
  }, [user?.uid, user?.email]);

  const [clearToastMessage, setClearToastMessage] = useState("");

  const sanitizeCachedMessages = (rawList: any[]): ChatMessage[] => {
    const filtered: ChatMessage[] = [];
    for (let i = 0; i < rawList.length; i++) {
      const m = rawList[i];
      const text = String(m?.content || "").trim();
      // Drop any legacy preset "Store Snapshot:" or timeout fallback messages from cached history
      if (
        m?.role === "assistant" &&
        ((text.includes("Store Snapshot:") && text.includes("How can I help with your store?")) ||
          (text.includes("I checked your store catalog (") &&
            text.includes("Please rephrase or try your command again.")))
      ) {
        continue;
      }
      const rawAtts = Array.isArray(m?.attachments) ? m.attachments : undefined;
      const validAtts = rawAtts
        ? rawAtts
            .map((a: any) => {
              let b64 = String(a?.dataBase64 || "");
              const mime = String(a?.mimeType || "image/jpeg");
              let previewUrl = String(a?.previewUrl || "");
              if (!b64 && previewUrl.startsWith("data:") && previewUrl.includes(",")) {
                b64 = previewUrl.slice(previewUrl.indexOf(",") + 1);
              }
              // Reconstruct persistent data: URL if cached previewUrl was a session-only blob: URL
              if ((!previewUrl || previewUrl.startsWith("blob:")) && b64 && a?.kind !== "video") {
                previewUrl = `data:${mime};base64,${b64}`;
              }
              if (
                (!previewUrl || previewUrl.startsWith("blob:")) &&
                Array.isArray(a?.videoFrames) &&
                a.videoFrames.length > 0 &&
                a.videoFrames[0]?.dataBase64
              ) {
                previewUrl = `data:${a.videoFrames[0].mimeType || "image/jpeg"};base64,${a.videoFrames[0].dataBase64}`;
              }
              return {
                ...a,
                mimeType: mime,
                dataBase64: b64,
                previewUrl,
              };
            })
            .filter((a: any) => a.previewUrl && !a.previewUrl.startsWith("blob:"))
        : undefined;

      if (!text && (!validAtts || validAtts.length === 0)) {
        continue;
      }

      filtered.push({
        ...m,
        ...(validAtts && validAtts.length > 0 ? { attachments: validAtts } : { attachments: undefined }),
        action: m.action ? validateClientAction(m.action, "", text) : null,
      });
    }
    return filtered;
  };

  const [messages, setMessages] = useState<ChatMessage[]>(() => {
    try {
      const initialKey = getAccountChatStorageKey(user?.uid, user?.email);
      const cached = localStorage.getItem(initialKey);
      if (cached) {
        const parsed = JSON.parse(cached);
        if (Array.isArray(parsed) && parsed.length > 0) {
          return sanitizeCachedMessages(parsed);
        }
      }
    } catch (e) {}
    return [];
  });

  // Switch chat conversation when logged-in account changes
  useEffect(() => {
    try {
      const cached = localStorage.getItem(currentAccountKey);
      if (cached) {
        const parsed = JSON.parse(cached);
        if (Array.isArray(parsed) && parsed.length > 0) {
          setMessages(sanitizeCachedMessages(parsed));
          return;
        }
      }
    } catch (e) {}
    setMessages([]);
  }, [currentAccountKey]);

  // Persist non-streaming messages to localStorage (keeping compressed media on recent turns so images stay clickable & in AI memory)
  useEffect(() => {
    if (!currentAccountKey) return;
    try {
      const nonStreaming = messages.filter((m) => !m.isStreaming).slice(-30);
      if (nonStreaming.length > 0) {
        // Keep base64/dataUrl on the most recent 4 messages with attachments; strip heavy buffers on older ones
        let mediaMsgsKept = 0;
        const keepIds = new Set<string>();
        for (let i = nonStreaming.length - 1; i >= 0; i--) {
          if (nonStreaming[i].attachments && nonStreaming[i].attachments!.length > 0) {
            if (mediaMsgsKept < 4) {
              keepIds.add(nonStreaming[i].id);
              mediaMsgsKept++;
            }
          }
        }
        const forStorage = nonStreaming.map((m) => {
          if (!m.attachments || m.attachments.length === 0) return m;
          if (keepIds.has(m.id)) {
            return {
              ...m,
              attachments: m.attachments.map((a) => ({
                ...a,
                // Avoid storing duplicate base64 or large raw video buffers in localStorage
                dataBase64:
                  a.kind === "video" || a.previewUrl?.startsWith("data:") ? "" : a.dataBase64,
              })),
            };
          }
          return {
            ...m,
            attachments: m.attachments.map((a) => ({
              ...a,
              dataBase64: "",
              videoFrames: undefined,
            })),
          };
        });
        try {
          localStorage.setItem(currentAccountKey, JSON.stringify(forStorage));
        } catch {
          // Quota fallback: strip base64 from storage copy if browser storage is nearly full
          const lightCopy = nonStreaming.map((m) =>
            m.attachments
              ? {
                  ...m,
                  attachments: m.attachments.map((a) => ({ ...a, dataBase64: "" })),
                }
              : m
          );
          localStorage.setItem(currentAccountKey, JSON.stringify(lightCopy));
        }
      } else {
        localStorage.removeItem(currentAccountKey);
      }
    } catch (e) {}
  }, [messages, currentAccountKey]);

  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState("");
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [speakingId, setSpeakingId] = useState<string | null>(null);
  const [synthesizingId, setSynthesizingId] = useState<string | null>(null);
  const [isRecording, setIsRecording] = useState(false);
  const [isTranscribing, setIsTranscribing] = useState(false);
  const [previewLightbox, setPreviewLightbox] = useState<{
    attachments: ChatAttachment[];
    index: number;
  } | null>(null);
  const [recordingSeconds, setRecordingSeconds] = useState(0);
  const [executingActionId, setExecutingActionId] = useState<string | null>(null);
  const [expandedThoughts, setExpandedThoughts] = useState<Record<string, boolean>>({});
  const [isKeyboardOpen, setIsKeyboardOpen] = useState(false);

  // Multi-image & multi-video inline composer attachments
  const [pendingAttachments, setPendingAttachments] = useState<ChatAttachment[]>([]);
  const pendingAttachmentsRef = useRef<ChatAttachment[]>([]);
  pendingAttachmentsRef.current = pendingAttachments;
  const [isPreparingAttachments, setIsPreparingAttachments] = useState(false);
  const mediaFileInputRef = useRef<HTMLInputElement>(null);
  const messagesRef = useRef<ChatMessage[]>(messages);
  messagesRef.current = messages;

  const isAiBusy = useMemo(
    () =>
      loading ||
      isTranscribing ||
      isPreparingAttachments ||
      messages.some((m) => Boolean(m.isStreaming)),
    [loading, isTranscribing, isPreparingAttachments, messages]
  );

  useEffect(() => {
    if (!isOpen) {
      setPreviewLightbox(null);
      return;
    }
    wakeUpBuzzServer();
    const keepWarmInterval = window.setInterval(() => {
      wakeUpBuzzServer();
    }, 25000);

    const baselineHeight = window.screen?.height
      ? Math.min(window.innerHeight, window.screen.height)
      : window.innerHeight;

    const handleViewportResize = () => {
      if (window.visualViewport) {
        const kbOpen = window.visualViewport.height < baselineHeight * 0.78;
        setIsKeyboardOpen(kbOpen);
      }
    };

    const handleNativeKeyboard = (e: Event) => {
      const custom = e as CustomEvent<{ isOpen: boolean; height: number }>;
      if (custom.detail) {
        setIsKeyboardOpen(Boolean(custom.detail.isOpen));
      }
    };

    window.visualViewport?.addEventListener("resize", handleViewportResize);
    window.addEventListener("nativeKeyboardStateChanged", handleNativeKeyboard);
    return () => {
      window.clearInterval(keepWarmInterval);
      window.visualViewport?.removeEventListener("resize", handleViewportResize);
      window.removeEventListener("nativeKeyboardStateChanged", handleNativeKeyboard);
    };
  }, [isOpen]);

  useEffect(() => {
    if (!previewLightbox) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        setPreviewLightbox(null);
      } else if (e.key === "ArrowLeft" && previewLightbox.attachments.length > 1) {
        e.preventDefault();
        setPreviewLightbox((prev) =>
          prev
            ? {
                ...prev,
                index: (prev.index - 1 + prev.attachments.length) % prev.attachments.length,
              }
            : null
        );
      } else if (e.key === "ArrowRight" && previewLightbox.attachments.length > 1) {
        e.preventDefault();
        setPreviewLightbox((prev) =>
          prev
            ? {
                ...prev,
                index: (prev.index + 1) % prev.attachments.length,
              }
            : null
        );
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [previewLightbox]);

  const toggleThought = (id: string) => {
    triggerHaptic("light");
    setExpandedThoughts((prev) => ({
      ...prev,
      [id]: !prev[id],
    }));
  };

  const [expandedMessages, setExpandedMessages] = useState<Record<string, boolean>>({});
  const toggleExpandMessage = (id: string) => {
    triggerHaptic("light");
    setExpandedMessages((prev) => ({
      ...prev,
      [id]: !prev[id],
    }));
  };

  const [quotedText, setQuotedText] = useState<string>("");
  const quotedTextRef = useRef<string>("");
  quotedTextRef.current = quotedText;
  const [selectionPopup, setSelectionPopup] = useState<{
    text: string;
    x: number;
    y: number;
    placement: "top" | "bottom";
    copied?: boolean;
  } | null>(null);
  const selectionToolbarRef = useRef<HTMLDivElement | null>(null);

  const chatContainerRef = useRef<HTMLDivElement>(null);

  // Detect text selection inside chat messages to offer "Quote" and "Copy" options
  useEffect(() => {
    if (!isOpen) {
      setSelectionPopup(null);
      return;
    }

    let isPointerDown = false;
    let settleTimer: number | null = null;

    const clearSettleTimer = () => {
      if (settleTimer !== null) {
        window.clearTimeout(settleTimer);
        settleTimer = null;
      }
    };

    const getElementFromNode = (node: Node | null): HTMLElement | null => {
      if (!node) return null;
      return node instanceof HTMLElement ? node : node.parentElement;
    };

    const extractSelectableRangeText = (range: Range): string => {
      try {
        const frag = range.cloneContents();
        frag
          .querySelectorAll("[data-no-chat-select='true']")
          .forEach((el) => el.remove());
        return (frag.textContent || "").trim();
      } catch {
        return "";
      }
    };

    const evaluateSelection = () => {
      if (typeof window === "undefined" || isPointerDown) return;
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed || sel.rangeCount === 0) {
        setSelectionPopup((prev) => (prev?.copied ? prev : null));
        return;
      }

      const container = chatContainerRef.current;
      if (!container) return;

      const anchorNode = sel.anchorNode;
      const focusNode = sel.focusNode;
      if (
        !anchorNode ||
        !focusNode ||
        !container.contains(anchorNode) ||
        !container.contains(focusNode)
      ) {
        setSelectionPopup(null);
        return;
      }

      const anchorEl = getElementFromNode(anchorNode);
      const focusEl = getElementFromNode(focusNode);
      const anchorInBlocked = Boolean(anchorEl?.closest("[data-no-chat-select='true']"));
      const focusInBlocked = Boolean(focusEl?.closest("[data-no-chat-select='true']"));
      const anchorInSelectable = Boolean(
        anchorEl?.closest("[data-selectable-message-body='true']")
      );
      const focusInSelectable = Boolean(
        focusEl?.closest("[data-selectable-message-body='true']")
      );

      // If the user tried to select "Listen", "Copy", "Thought for Xs", "Thinking", or any non-message UI chrome,
      // immediately clear the selection so those labels can never be highlighted or copied!
      if ((anchorInBlocked && focusInBlocked) || (!anchorInSelectable && !focusInSelectable)) {
        try {
          sel.removeAllRanges();
        } catch {}
        setSelectionPopup(null);
        return;
      }

      try {
        const range = sel.getRangeAt(0);
        const cleanText = extractSelectableRangeText(range);
        if (!cleanText) {
          setSelectionPopup((prev) => (prev?.copied ? prev : null));
          return;
        }

        const rect = range.getBoundingClientRect();
        if (rect.width === 0 && rect.height === 0) return;

        const containerRect = container.getBoundingClientRect();
        const vw = window.innerWidth || 360;
        const toolbarHalfWidth = 88;
        const minX = Math.max(toolbarHalfWidth + 8, containerRect.left + toolbarHalfWidth + 6);
        const maxX = Math.min(vw - toolbarHalfWidth - 8, containerRect.right - toolbarHalfWidth - 6);
        const rawCenterX = rect.left + rect.width / 2;
        const clampedX = minX <= maxX ? Math.max(minX, Math.min(maxX, rawCenterX)) : vw / 2;

        const showAbove = rect.top - containerRect.top > 52 && rect.top > 68;
        const posY = showAbove ? rect.top - 10 : rect.bottom + 10;

        setSelectionPopup({
          text: cleanText.slice(0, 800),
          x: clampedX,
          y: posY,
          placement: showAbove ? "top" : "bottom",
          copied: false,
        });
      } catch {
        // Ignore transient selection range errors
      }
    };

    const isInsideToolbar = (target: EventTarget | null) =>
      Boolean(
        selectionToolbarRef.current &&
          target instanceof Node &&
          selectionToolbarRef.current.contains(target)
      );

    const handlePointerDown = (e: Event) => {
      if (isInsideToolbar(e.target)) return;
      isPointerDown = true;
      clearSettleTimer();
      setSelectionPopup(null);
    };

    const handlePointerUp = (e: Event) => {
      if (isInsideToolbar(e.target)) return;
      isPointerDown = false;
      clearSettleTimer();
      settleTimer = window.setTimeout(() => {
        evaluateSelection();
      }, 90);
    };

    const handleSelectionChange = () => {
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed || !sel.toString().trim()) {
        clearSettleTimer();
        setSelectionPopup((prev) => (prev?.copied ? prev : null));
        return;
      }
      const anchorEl = getElementFromNode(sel.anchorNode);
      const focusEl = getElementFromNode(sel.focusNode);
      if (
        anchorEl?.closest("[data-no-chat-select='true']") &&
        focusEl?.closest("[data-no-chat-select='true']")
      ) {
        try {
          sel.removeAllRanges();
        } catch {}
        setSelectionPopup(null);
        return;
      }
      // Never show or move the popup while the user is actively dragging/selecting
      if (isPointerDown) {
        setSelectionPopup(null);
        return;
      }
      // If selection handles are adjusted on touch after finger release, wait until stationary
      clearSettleTimer();
      settleTimer = window.setTimeout(() => {
        if (!isPointerDown) {
          evaluateSelection();
        }
      }, 360);
    };

    const handleCopyClean = (e: ClipboardEvent) => {
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed || sel.rangeCount === 0) return;
      const container = chatContainerRef.current;
      if (!container || !sel.anchorNode || !container.contains(sel.anchorNode)) return;
      const range = sel.getRangeAt(0);
      const cleanText = extractSelectableRangeText(range);
      if (cleanText && e.clipboardData) {
        e.clipboardData.setData("text/plain", cleanText);
        e.preventDefault();
      } else if (!cleanText) {
        e.preventDefault();
      }
    };

    const handleScrollOrResize = () => {
      clearSettleTimer();
      setSelectionPopup(null);
    };

    document.addEventListener("pointerdown", handlePointerDown, true);
    document.addEventListener("mousedown", handlePointerDown, true);
    document.addEventListener("touchstart", handlePointerDown, { passive: true, capture: true });
    document.addEventListener("pointerup", handlePointerUp, true);
    document.addEventListener("mouseup", handlePointerUp, true);
    document.addEventListener("touchend", handlePointerUp, { passive: true, capture: true });
    document.addEventListener("touchcancel", handlePointerUp, { passive: true, capture: true });
    document.addEventListener("selectionchange", handleSelectionChange);
    const scrollEl = chatContainerRef.current;
    scrollEl?.addEventListener("scroll", handleScrollOrResize, { passive: true });
    scrollEl?.addEventListener("copy", handleCopyClean);
    window.addEventListener("resize", handleScrollOrResize);

    return () => {
      clearSettleTimer();
      document.removeEventListener("pointerdown", handlePointerDown, true);
      document.removeEventListener("mousedown", handlePointerDown, true);
      document.removeEventListener("touchstart", handlePointerDown, true);
      document.removeEventListener("pointerup", handlePointerUp, true);
      document.removeEventListener("mouseup", handlePointerUp, true);
      document.removeEventListener("touchend", handlePointerUp, true);
      document.removeEventListener("touchcancel", handlePointerUp, true);
      document.removeEventListener("selectionchange", handleSelectionChange);
      scrollEl?.removeEventListener("scroll", handleScrollOrResize);
      scrollEl?.removeEventListener("copy", handleCopyClean);
      window.removeEventListener("resize", handleScrollOrResize);
    };
  }, [isOpen]);

  const handleQuoteSelection = () => {
    if (!selectionPopup?.text) return;
    triggerHaptic("light");
    const picked = selectionPopup.text.trim();
    setQuotedText(picked);
    setSelectionPopup(null);
    try {
      window.getSelection()?.removeAllRanges();
    } catch {}
    setTimeout(() => {
      inputRef.current?.focus();
    }, 30);
  };

  const handleCopySelection = async () => {
    if (!selectionPopup?.text) return;
    triggerHaptic("light");
    const textToCopy = selectionPopup.text;
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(textToCopy);
      } else {
        const ta = document.createElement("textarea");
        ta.value = textToCopy;
        ta.style.position = "fixed";
        ta.style.opacity = "0";
        document.body.appendChild(ta);
        ta.select();
        document.execCommand("copy");
        document.body.removeChild(ta);
      }
    } catch {}
    setSelectionPopup((prev) => (prev ? { ...prev, copied: true } : null));
    setTimeout(() => {
      setSelectionPopup(null);
      try {
        window.getSelection()?.removeAllRanges();
      } catch {}
    }, 550);
  };
  const isNearBottomRef = useRef<boolean>(true);
  const isUserScrollingRef = useRef<boolean>(false);
  const scrollTimeoutRef = useRef<any>(null);
  const lastScrollTopRef = useRef<number>(0);

  const handleContainerScroll = () => {
    if (!chatContainerRef.current) return;
    const { scrollTop, scrollHeight, clientHeight } = chatContainerRef.current;
    
    // User is near bottom if within 70px of the very bottom
    const distanceFromBottom = scrollHeight - scrollTop - clientHeight;
    const nearBottom = distanceFromBottom < 70;
    
    // If user is scrolling upwards, immediately stop auto-scrolling
    if (scrollTop < lastScrollTopRef.current) {
      isNearBottomRef.current = false;
    } else if (nearBottom) {
      isNearBottomRef.current = true;
    }
    lastScrollTopRef.current = scrollTop;

    isUserScrollingRef.current = true;
    if (scrollTimeoutRef.current) clearTimeout(scrollTimeoutRef.current);
    scrollTimeoutRef.current = setTimeout(() => {
      isUserScrollingRef.current = false;
      // Re-evaluate if user ended scroll near bottom
      if (chatContainerRef.current) {
        const d = chatContainerRef.current.scrollHeight - chatContainerRef.current.scrollTop - chatContainerRef.current.clientHeight;
        isNearBottomRef.current = d < 70;
      }
    }, 200);
  };

  const scrollToBottom = (force = false) => {
    if (!chatContainerRef.current) return;
    if (force) {
      isNearBottomRef.current = true;
      chatContainerRef.current.scrollTop = chatContainerRef.current.scrollHeight;
    } else if (isNearBottomRef.current && !isUserScrollingRef.current) {
      chatContainerRef.current.scrollTop = chatContainerRef.current.scrollHeight;
    }
  };

  const inputRef = useRef<HTMLTextAreaElement>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const recognitionRef = useRef<any>(null);
  const baseInputRef = useRef("");
  const latestSpokenTextRef = useRef("");
  const audioChunksRef = useRef<Blob[]>([]);
  const streamRef = useRef<MediaStream | null>(null);
  const recordingTimerRef = useRef<any>(null);
  const currentAudioRef = useRef<HTMLAudioElement | null>(null);
  const speechRequestIdRef = useRef<number>(0);
  const abortControllerRef = useRef<AbortController | null>(null);
  const activeStopwatchRef = useRef<number | null>(null);
  const activeWatchdogRef = useRef<number | null>(null);
  const activeAssistantMsgIdRef = useRef<string | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const rafWaveformRef = useRef<number | null>(null);
  const recordingCancelledRef = useRef<boolean>(false);
  const waveformCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const barLevelsRef = useRef<Float32Array>(new Float32Array(36));
  const voiceActiveRef = useRef<boolean>(false);
  const [isVoiceActive, setIsVoiceActive] = useState<boolean>(false);

  const stopAllSpeechPlayback = () => {
    speechRequestIdRef.current += 1;
    if (currentAudioRef.current) {
      try {
        currentAudioRef.current.pause();
        currentAudioRef.current.currentTime = 0;
      } catch {}
      currentAudioRef.current = null;
    }
    if (typeof window !== "undefined" && "speechSynthesis" in window) {
      try {
        window.speechSynthesis.cancel();
      } catch {}
    }
    try {
      (window as any).AndroidExporter?.stopSpeaking?.();
    } catch {}
    setSpeakingId(null);
    setSynthesizingId(null);
  };

  // Close on Escape key press
  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        triggerHaptic("light");
        stopAllSpeechPlayback();
        onClose();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isOpen, onClose]);

  // Sync Accounts Directory
  useEffect(() => {
    if (!isOpen) return;

    if (propAccounts && propAccounts.length > 0) {
      setInternalAccounts(propAccounts);
      return;
    }

    const unsubSettings = onSnapshot(
      collection(db, "settings"),
      (snap) => {
        const list: any[] = [];
        snap.forEach((d) => {
          const id = d.id;
          const data = d.data();
          if (id.startsWith("profile_")) {
            const uid = id.replace("profile_", "");
            list.push({
              uid,
              displayName: data.displayName || "Store User",
              email: data.email || "",
              role: data.role || (data.isAdmin ? "admin" : "user"),
              isAdmin: Boolean(
                data.isAdmin ||
                  data.role === "admin" ||
                  data.email === "suman.das.199972@gmail.com"
              ),
              isOnline:
                uid === user?.uid ||
                (Boolean(data.isOnline) &&
                  Date.now() - (Number(data.lastActive) || 0) <= 60000),
              lastActive: data.lastActive || 0,
            });
          }
        });
        setInternalAccounts(list);
      },
      (err) => console.warn("Could not listen to settings for AI context:", err)
    );

    return () => unsubSettings();
  }, [isOpen, propAccounts]);

  // Sync Activity Logs
  useEffect(() => {
    if (!isOpen) return;

    if (propActivityLogs && propActivityLogs.length > 0) {
      setInternalLogs(propActivityLogs);
      return;
    }

    const q = query(
      collection(db, "activity_logs"),
      orderBy("timestamp", "desc"),
      limit(25)
    );
    const unsubLogs = onSnapshot(
      q,
      (snap) => {
        const logs: any[] = [];
        snap.forEach((d) => logs.push({ id: d.id, ...d.data() }));
        setInternalLogs(logs);
      },
      (err) => console.warn("Could not listen to activity logs for AI:", err)
    );

    return () => unsubLogs();
  }, [isOpen, propActivityLogs]);

  // Intercept Android hardware back button when AI Assistant drawer is open
  useEffect(() => {
    if (!isOpen) return;
    const handleAndroidBack = (e: Event) => {
      e.preventDefault();
      onClose();
    };
    window.addEventListener("androidBackPress", handleAndroidBack);
    return () => window.removeEventListener("androidBackPress", handleAndroidBack);
  }, [isOpen, onClose]);

  // Sync Other Expenses in real-time for financial context
  useEffect(() => {
    if (!isOpen) return;
    const q = query(
      collection(db, "other_costs"),
      orderBy("date", "desc"),
      limit(25)
    );
    const unsubCosts = onSnapshot(
      q,
      (snap) => {
        const list: any[] = [];
        snap.forEach((d) => list.push({ id: d.id, ...d.data() }));
        setOtherCosts(list);
      },
      (e) => {
        console.warn("Could not listen to other costs for AI context", e);
      }
    );
    return () => unsubCosts();
  }, [isOpen]);

  // Scroll to bottom of chat container only if user is near the bottom and not actively scrolling
  useEffect(() => {
    if (isOpen && chatContainerRef.current && !isUserScrollingRef.current && isNearBottomRef.current) {
      chatContainerRef.current.scrollTop = chatContainerRef.current.scrollHeight;
    }
  }, [messages, isOpen, loading]);

  // Lock window scroll to top when modal is opened to prevent layout glitch
  useEffect(() => {
    if (isOpen) {
      window.scrollTo(0, 0);
      document.body.scrollTop = 0;
      document.documentElement.scrollTop = 0;
      document.body.style.overflow = "hidden";
    }
    return () => {
      document.body.style.overflow = "";
    };
  }, [isOpen]);

  // Clean up recording on unmount or modal close
  useEffect(() => {
    return () => {
      if (recordingTimerRef.current) {
        clearInterval(recordingTimerRef.current);
      }
      if (streamRef.current) {
        streamRef.current.getTracks().forEach((track) => track.stop());
      }
    };
  }, []);

  // Compute Store Analytics & Administration Context for Gemini
  const effectiveAccounts = useMemo(() => {
    const base = propAccounts.length > 0 ? propAccounts : internalAccounts;
    const list = base.map((a) => ({
      ...a,
      isOnline:
        a.uid === user?.uid ||
        (Boolean(a.isOnline) &&
          Date.now() - (Number(a.lastActive) || 0) <= 60000),
    }));

    // Guarantee logged-in user is present in context with their actual role
    if (user && !list.some((a) => a.email === user.email || a.uid === user.uid)) {
      const isPrimaryOwner =
        user.email?.toLowerCase().trim() === "suman.das.199972@gmail.com";
      const actualIsAdmin = isPrimaryOwner || Boolean((user as any).isAdmin);
      list.unshift({
        uid: user.uid,
        displayName: user.displayName || "User",
        email: user.email || "",
        role: actualIsAdmin ? "admin" : "user",
        isAdmin: actualIsAdmin,
        isSuperAdmin: isPrimaryOwner,
        isOnline: true,
        lastActive: Date.now(),
      });
    }

    return list;
  }, [propAccounts, internalAccounts, user]);

  const effectiveLogs = propActivityLogs.length > 0 ? propActivityLogs : internalLogs;

  const storeContext: StoreContext = useMemo(() => {
    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);
    const todayTimestamp = startOfToday.getTime();

    const safeBillTotal = (val: any) => {
      const n = Number(val);
      return Number.isFinite(n) && n >= 0 ? Math.min(10000, n) : 0;
    };

    const todayBills = bills.filter((b) => (b.date || 0) >= todayTimestamp);
    const totalRevenueToday = todayBills.reduce(
      (sum, b) => sum + safeBillTotal(b.total),
      0
    );

    // Strip binary/base64 image buffers from products to keep context ultra-compact
    const compactProducts = products.map((p) => ({
      id: p.id,
      name: p.name,
      price: Number.isFinite(Number(p.price)) ? Math.max(0, Number(p.price)) : 0,
      stock: Number.isFinite(Number(p.stock)) ? Math.max(0, Number(p.stock)) : 0,
      category: normalizeProductCategory(p.category, p.name),
      soldCount: Number(p.soldCount) || 0,
    }));

    const sanitizedRecentBills = bills.slice(0, 12).map((b) => ({
      ...b,
      total: safeBillTotal(b.total),
    }));

    // Identify the currently logged-in operator so Buzz AI knows who is asking ("am i a admin?", "who am i?", etc.)
    const matchedSelf = effectiveAccounts.find(
      (a) =>
        (user?.uid && a.uid === user.uid) ||
        (user?.email && a.email?.toLowerCase().trim() === user.email.toLowerCase().trim())
    );
    const isPrimaryOwner =
      user?.email?.toLowerCase().trim() === "suman.das.199972@gmail.com" ||
      Boolean(matchedSelf?.isSuperAdmin);
    const effectiveUserIsAdmin = Boolean(
      isPrimaryOwner || isRealAdmin || isAdmin || matchedSelf?.isAdmin || matchedSelf?.role === "admin"
    );

    const currentUser = user
      ? {
          uid: user.uid,
          displayName: matchedSelf?.displayName || user.displayName || "Store User",
          email: user.email || matchedSelf?.email || "",
          isAdmin: effectiveUserIsAdmin,
          isSuperAdmin: isPrimaryOwner,
          role: isPrimaryOwner
            ? "Owner & Super Admin"
            : effectiveUserIsAdmin
            ? "Admin"
            : "Standard User (Staff)",
        }
      : null;

    return {
      products: compactProducts,
      recentBills: sanitizedRecentBills,
      otherCosts: otherCosts.slice(0, 10),
      accounts: effectiveAccounts,
      activityLogs: effectiveLogs.slice(0, 15),
      totalRevenueToday,
      billsCountToday: todayBills.length,
      currentUser,
    };
  }, [products, bills, otherCosts, effectiveAccounts, effectiveLogs, user, isAdmin, isRealAdmin]);

  const drawWaveformFrame = (levels: Float32Array) => {
    const canvas = waveformCanvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const dpr = typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1;
    const rect = canvas.getBoundingClientRect();
    const cssWidth = rect.width || 220;
    const cssHeight = rect.height || 32;
    const targetW = Math.round(cssWidth * dpr);
    const targetH = Math.round(cssHeight * dpr);

    if (canvas.width !== targetW || canvas.height !== targetH) {
      canvas.width = targetW;
      canvas.height = targetH;
    }

    ctx.save();
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, cssWidth, cssHeight);

    const barCount = levels.length;
    const gap = cssWidth < 180 ? 2.5 : 3.5;
    const totalGaps = (barCount - 1) * gap;
    const barWidth = Math.max(2, Math.min(3.5, (cssWidth - totalGaps) / barCount));
    const totalContentWidth = barCount * barWidth + totalGaps;
    const startX = Math.max(0, (cssWidth - totalContentWidth) / 2);
    const minBarHeight = 3;
    const maxBarHeight = Math.max(12, cssHeight - 4);

    for (let i = 0; i < barCount; i++) {
      const lvl = Math.max(0, Math.min(1, levels[i]));
      const h = minBarHeight + lvl * (maxBarHeight - minBarHeight);
      const x = startX + i * (barWidth + gap);
      const y = (cssHeight - h) / 2;
      const radius = barWidth / 2;

      if (lvl < 0.04) {
        ctx.fillStyle = "rgba(148, 163, 184, 0.35)";
      } else if (lvl < 0.45) {
        const alpha = 0.65 + lvl * 0.6;
        ctx.fillStyle = `rgba(99, 102, 241, ${Math.min(1, alpha).toFixed(2)})`;
      } else {
        ctx.fillStyle = "rgba(165, 180, 252, 0.98)";
      }

      ctx.beginPath();
      if (typeof ctx.roundRect === "function") {
        ctx.roundRect(x, y, barWidth, h, radius);
      } else {
        ctx.rect(x, y, barWidth, h);
      }
      ctx.fill();
    }

    ctx.restore();
  };

  const stopAudioVisualizer = () => {
    if (rafWaveformRef.current !== null) {
      cancelAnimationFrame(rafWaveformRef.current);
      rafWaveformRef.current = null;
    }
    analyserRef.current = null;
    if (audioContextRef.current) {
      try {
        audioContextRef.current.close().catch(() => {});
      } catch {}
      audioContextRef.current = null;
    }
    barLevelsRef.current.fill(0);
    voiceActiveRef.current = false;
    setIsVoiceActive(false);
  };

  const startAudioVisualizer = async (existingStream?: MediaStream) => {
    stopAudioVisualizer();
    let activeStream = existingStream || streamRef.current;

    if (!activeStream && navigator.mediaDevices?.getUserMedia) {
      try {
        activeStream = await navigator.mediaDevices.getUserMedia({
          audio: {
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
          },
        });
        streamRef.current = activeStream;
      } catch {
        // Microphone stream could not be opened concurrently
      }
    }

    const AudioCtx =
      typeof window !== "undefined"
        ? window.AudioContext || (window as any).webkitAudioContext
        : null;

    if (activeStream && AudioCtx) {
      try {
        const audioCtx: AudioContext = new AudioCtx();
        audioContextRef.current = audioCtx;
        if (audioCtx.state === "suspended") {
          audioCtx.resume().catch(() => {});
        }
        const source = audioCtx.createMediaStreamSource(activeStream);
        const analyser = audioCtx.createAnalyser();
        analyser.fftSize = 256;
        analyser.smoothingTimeConstant = 0.5;
        source.connect(analyser);
        analyserRef.current = analyser;

        const freqData = new Uint8Array(analyser.frequencyBinCount);
        const timeData = new Uint8Array(analyser.fftSize);
        const levels = barLevelsRef.current;
        const barCount = levels.length;
        const centerIdx = (barCount - 1) / 2;

        const updateLoop = () => {
          if (!analyserRef.current) return;
          analyser.getByteFrequencyData(freqData);
          analyser.getByteTimeDomainData(timeData);

          // Compute true time-domain RMS amplitude with a noise floor gate
          let sumSquares = 0;
          for (let i = 0; i < timeData.length; i++) {
            const centered = (timeData[i] - 128) / 128;
            sumSquares += centered * centered;
          }
          const rawRms = Math.sqrt(sumSquares / timeData.length);
          const gatedRms = Math.max(0, rawRms - 0.011);
          const vocalEnvelope =
            gatedRms > 0 ? Math.min(1, Math.pow(gatedRms * 6.5, 0.78)) : 0;

          // Update React voice-active state only when crossing hysteresis thresholds
          if (!voiceActiveRef.current && vocalEnvelope > 0.1) {
            voiceActiveRef.current = true;
            setIsVoiceActive(true);
          } else if (voiceActiveRef.current && vocalEnvelope < 0.04) {
            voiceActiveRef.current = false;
            setIsVoiceActive(false);
          }

          for (let i = 0; i < barCount; i++) {
            const distFromCenter = Math.abs(i - centerIdx) / centerIdx;
            const spatialWindow = Math.cos(distFromCenter * Math.PI * 0.44);

            let target = 0;
            if (vocalEnvelope > 0.015) {
              // Map human voice formants (bins 1..28, ~170Hz-4.8kHz) across the bars
              const binIdx = Math.min(
                freqData.length - 1,
                1 + Math.floor(distFromCenter * 22) + (i % 3)
              );
              const rawFreq = freqData[binIdx] / 255;
              const gatedFreq = Math.max(0, (rawFreq - 0.14) / 0.86);
              target = Math.min(
                1,
                (gatedFreq * 0.68 + vocalEnvelope * 0.52) * spatialWindow
              );
            }

            const prev = levels[i];
            // Fast attack for crisp syllables, natural decay for silence
            const smoothing = target > prev ? 0.52 : 0.25;
            const next = prev + (target - prev) * smoothing;
            levels[i] = next < 0.004 ? 0 : next;
          }

          drawWaveformFrame(levels);
          rafWaveformRef.current = requestAnimationFrame(updateLoop);
        };

        rafWaveformRef.current = requestAnimationFrame(updateLoop);
        return;
      } catch (e) {
        console.warn("Web Audio Analyser fallback:", e);
      }
    }

    // When SpeechRecognition is active on mobile (where getUserMedia cannot be opened concurrently
    // without locking the Android hardware mic), animate a responsive voice-activity waveform.
    const levels = barLevelsRef.current;
    const barCount = levels.length;
    const centerIdx = (barCount - 1) / 2;
    let tick = 0;

    const syntheticLoop = () => {
      tick += 0.14;
      const speakingPulse = latestSpokenTextRef.current ? 0.55 : 0.28;
      for (let i = 0; i < barCount; i++) {
        const distFromCenter = Math.abs(i - centerIdx) / centerIdx;
        const spatialWindow = Math.cos(distFromCenter * Math.PI * 0.44);
        const wave =
          (Math.sin(tick * 2.1 + i * 0.55) * 0.5 + 0.5) * 0.6 +
          (Math.cos(tick * 3.4 - i * 0.35) * 0.5 + 0.5) * 0.4;
        const target = Math.min(1, wave * speakingPulse * spatialWindow);
        levels[i] = levels[i] + (target - levels[i]) * 0.35;
      }
      drawWaveformFrame(levels);
      rafWaveformRef.current = requestAnimationFrame(syntheticLoop);
    };

    rafWaveformRef.current = requestAnimationFrame(syntheticLoop);
  };

  // Stop recording helper (handles both Web Speech API and MediaRecorder)
  const stopRecording = () => {
    stopAudioVisualizer();
    if (recognitionRef.current) {
      try {
        recognitionRef.current.stop();
      } catch (e) {}
      recognitionRef.current = null;
    }
    if (recordingTimerRef.current) {
      clearInterval(recordingTimerRef.current);
      recordingTimerRef.current = null;
    }
    const hadActiveMediaRecorder =
      Boolean(mediaRecorderRef.current) &&
      mediaRecorderRef.current?.state !== "inactive";
    if (hadActiveMediaRecorder && !recordingCancelledRef.current) {
      // Lock composer into transcribing state BEFORE setting isRecording=false so there is zero frame gap
      setIsTranscribing(true);
    }
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== "inactive") {
      try {
        if (mediaRecorderRef.current.state === "recording") {
          mediaRecorderRef.current.requestData();
        }
        mediaRecorderRef.current.stop();
      } catch (e) {}
    }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
    }
    setIsRecording(false);
    setRecordingSeconds(0);
  };

  // Cancel recording without sending
  const cancelRecording = () => {
    triggerHaptic("light");
    recordingCancelledRef.current = true;
    latestSpokenTextRef.current = "";
    audioChunksRef.current = [];
    setIsTranscribing(false);
    setInput(baseInputRef.current || "");
    stopRecording();
  };

  // Toggle voice recording using Web Speech API with MediaRecorder fallback
  const toggleListening = async () => {
    if (isAiBusy && !isRecording) return;
    triggerHaptic("medium");
    setErrorMessage("");
    inputRef.current?.blur();

    // If currently recording, stop it immediately
    if (isRecording) {
      stopRecording();
      return;
    }

    // Stop any playing TTS before opening microphone
    stopAllSpeechPlayback();
    recordingCancelledRef.current = false;

    // On native Android WebView, webkitSpeechRecognition is stubbed/unsupported by System WebView;
    // go straight to MediaRecorder + Gemini audio transcription.
    const isNativeMobile =
      typeof window !== "undefined" &&
      Boolean((window as any).Capacitor?.isNativePlatform?.());

    const isMobileDevice =
      isNativeMobile ||
      (typeof navigator !== "undefined" &&
        /Android|iPhone|iPad|iPod/i.test(navigator.userAgent || ""));

    const SpeechRecognition =
      !isNativeMobile &&
      ((window as any).SpeechRecognition ||
        (window as any).webkitSpeechRecognition);

    if (SpeechRecognition) {
      try {
        // On desktop browsers, acquire live microphone stream so Web Audio API waveform is 100% accurate.
        // CRITICAL: On Android mobile phones, opening getUserMedia concurrently with SpeechRecognition
        // locks the hardware microphone and causes SpeechRecognition to immediately fail!
        let micStream: MediaStream | undefined;
        if (!isMobileDevice && navigator.mediaDevices?.getUserMedia) {
          try {
            micStream = await navigator.mediaDevices.getUserMedia({
              audio: {
                echoCancellation: true,
                noiseSuppression: true,
                autoGainControl: true,
              },
            });
            streamRef.current = micStream;
          } catch {}
        }

        const recognition = new SpeechRecognition();
        recognitionRef.current = recognition;
        recognition.continuous = false;
        recognition.interimResults = true;
        recognition.lang = "en-US";

        baseInputRef.current = input;
        latestSpokenTextRef.current = "";

        recognition.onstart = () => {
          setIsRecording(true);
          setRecordingSeconds(0);
          triggerHaptic("medium");
          startAudioVisualizer(micStream);
          if (recordingTimerRef.current) clearInterval(recordingTimerRef.current);
          recordingTimerRef.current = setInterval(() => {
            setRecordingSeconds((prev) => prev + 1);
          }, 1000);
        };

        recognition.onresult = (event: any) => {
          let interimTranscript = "";
          let finalTranscript = "";

          for (let i = event.resultIndex; i < event.results.length; ++i) {
            const transcript = event.results[i][0].transcript;
            if (event.results[i].isFinal) {
              finalTranscript += transcript;
            } else {
              interimTranscript += transcript;
            }
          }

          const currentSpeech = finalTranscript || interimTranscript;
          if (currentSpeech) {
            const prefix = baseInputRef.current ? `${baseInputRef.current.trim()} ` : "";
            const combined = `${prefix}${currentSpeech.trim()}`;
            latestSpokenTextRef.current = combined;
            setInput(combined);
          }
        };

        let switchedToFallback = false;

        recognition.onerror = (event: any) => {
          console.warn("Speech recognition error:", event.error);
          stopAudioVisualizer();
          if (streamRef.current) {
            streamRef.current.getTracks().forEach((track) => track.stop());
            streamRef.current = null;
          }
          if (event.error !== "no-speech" && event.error !== "aborted") {
            // Keep isRecording true while transitioning to MediaRecorder fallback
            switchedToFallback = true;
            startMediaRecorderFallback();
          } else {
            setIsRecording(false);
          }
        };

        recognition.onend = () => {
          if (switchedToFallback) return;
          stopAudioVisualizer();
          if (streamRef.current) {
            streamRef.current.getTracks().forEach((track) => track.stop());
            streamRef.current = null;
          }
          if (recordingTimerRef.current) {
            clearInterval(recordingTimerRef.current);
            recordingTimerRef.current = null;
          }
          setIsRecording(false);
          setRecordingSeconds(0);
          triggerHaptic("light");
          if (recordingCancelledRef.current) {
            recordingCancelledRef.current = false;
            return;
          }
          const spoken = (latestSpokenTextRef.current || baseInputRef.current || "").trim();
          latestSpokenTextRef.current = "";
          baseInputRef.current = "";
          if (spoken) {
            inputRef.current?.blur();
            handleSendMessage(spoken);
          }
        };

        setIsRecording(true);
        recognition.start();
        return;
      } catch (err: any) {
        console.warn("Native Web Speech API failed, falling back to MediaRecorder:", err);
      }
    }

    // Fallback: MediaRecorder + Gemini Transcribe
    startMediaRecorderFallback();
  };

  const startMediaRecorderFallback = async () => {
    try {
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        setErrorMessage("Microphone access is not supported on this device. Please type your query.");
        return;
      }

      recordingCancelledRef.current = false;
      baseInputRef.current = input;
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
      streamRef.current = stream;

      let mimeType = "";
      if (typeof MediaRecorder.isTypeSupported === "function") {
        if (MediaRecorder.isTypeSupported("audio/webm;codecs=opus")) {
          mimeType = "audio/webm;codecs=opus";
        } else if (MediaRecorder.isTypeSupported("audio/webm")) {
          mimeType = "audio/webm";
        } else if (MediaRecorder.isTypeSupported("audio/mp4")) {
          mimeType = "audio/mp4";
        } else if (MediaRecorder.isTypeSupported("audio/ogg")) {
          mimeType = "audio/ogg";
        }
      }

      const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      mediaRecorderRef.current = recorder;
      audioChunksRef.current = [];

      recorder.ondataavailable = (event) => {
        if (event.data && event.data.size > 0) {
          audioChunksRef.current.push(event.data);
        }
      };

      recorder.onstop = async () => {
        if (recordingCancelledRef.current) {
          recordingCancelledRef.current = false;
          audioChunksRef.current = [];
          setIsTranscribing(false);
          return;
        }
        const audioBlob = new Blob(audioChunksRef.current, {
          type: recorder.mimeType || mimeType || "audio/webm",
        });

        if (audioBlob.size < 100) {
          setIsTranscribing(false);
          setErrorMessage("Voice note was too short. Please hold or tap the mic and speak clearly.");
          return;
        }

        setIsTranscribing(true);
        triggerHaptic("light");

        try {
          const transcript = await transcribeAudio(audioBlob);
          if (transcript && transcript.trim()) {
            triggerHaptic("success");
            const prefix = baseInputRef.current ? baseInputRef.current.trim() : "";
            const combined = prefix
              ? `${prefix} ${transcript.trim()}`
              : transcript.trim();
            baseInputRef.current = "";
            setInput("");
            setIsTranscribing(false);
            await handleSendMessage(combined);
          } else {
            setIsTranscribing(false);
            setErrorMessage("Could not hear speech clearly. Please try speaking again.");
          }
        } catch (err: any) {
          setIsTranscribing(false);
          console.warn("Transcription fallback notice:", err);
          const rawMsg = String(err?.message || "");
          const friendlyMsg =
            rawMsg.startsWith("{") || rawMsg.includes("models/") || rawMsg.includes("NOT_FOUND")
              ? "Voice transcription is temporarily unavailable. Please type your message below."
              : rawMsg || "Could not transcribe voice note. Please try again.";
          setErrorMessage(friendlyMsg);
          triggerHaptic("heavy");
        }
      };

      recorder.start(200);
      setIsRecording(true);
      setRecordingSeconds(0);
      startAudioVisualizer(stream);

      recordingTimerRef.current = setInterval(() => {
        setRecordingSeconds((prev) => {
          if (prev >= 60) {
            stopRecording();
            return 0;
          }
          return prev + 1;
        });
      }, 1000);
    } catch (err: any) {
      if (err.name === "NotAllowedError" || err.name === "PermissionDeniedError" || String(err.message || "").includes("Permission denied")) {
        setErrorMessage("Microphone permission was denied. Please enable Microphone access to send voice notes.");
      } else {
        console.warn("Microphone access notice:", err?.message || err);
        setErrorMessage(`Microphone notice: ${err?.message || "Could not start audio recording"}`);
      }
      stopRecording();
    }
  };

  const lockedVoiceByLangRef = useRef<Record<string, SpeechSynthesisVoice>>({});

  const resolveSingleConsistentBrowserVoice = (
    langKey: "en" | "bn" | "hi"
  ): SpeechSynthesisVoice | undefined => {
    if (typeof window === "undefined" || !("speechSynthesis" in window)) return undefined;
    if (lockedVoiceByLangRef.current[langKey]) {
      return lockedVoiceByLangRef.current[langKey];
    }
    const voices = window.speechSynthesis.getVoices();
    if (!voices || voices.length === 0) return undefined;

    let picked: SpeechSynthesisVoice | undefined;
    if (langKey === "bn") {
      picked =
        voices.find(
          (v) =>
            v.lang.toLowerCase().startsWith("bn") &&
            (v.name.includes("Natural") || v.name.includes("Google"))
        ) || voices.find((v) => v.lang.toLowerCase().startsWith("bn"));
    } else if (langKey === "hi") {
      picked =
        voices.find(
          (v) =>
            v.lang.toLowerCase().startsWith("hi") &&
            (v.name.includes("Natural") || v.name.includes("Google"))
        ) || voices.find((v) => v.lang.toLowerCase().startsWith("hi"));
    } else {
      const preferredNames = [
        "Google US English",
        "Google UK English Female",
        "Microsoft Aria Online (Natural)",
        "Microsoft Jenny Online (Natural)",
        "Samantha",
        "Google हिन्दी",
      ];
      for (const targetName of preferredNames) {
        const match = voices.find((v) => v.name.includes(targetName) && v.lang.startsWith("en"));
        if (match) {
          picked = match;
          break;
        }
      }
      if (!picked) {
        picked =
          voices.find(
            (v) =>
              v.lang.startsWith("en") &&
              (v.name.includes("Natural") || v.name.includes("Google"))
          ) ||
          voices.find(
            (v) =>
              v.lang.startsWith("en-US") ||
              v.lang.startsWith("en-GB") ||
              v.lang.startsWith("en-IN")
          ) ||
          voices.find((v) => v.lang.startsWith("en"));
      }
    }

    if (picked) {
      lockedVoiceByLangRef.current[langKey] = picked;
    }
    return picked;
  };

  const fallbackSpeechSynthesis = (id: string, rawText: string, reqId: number) => {
    if (speechRequestIdRef.current !== reqId) return;
    setSynthesizingId(null);
    const speechReadyText = formatTextForSpeech(rawText, 480);
    if (!speechReadyText) {
      setSpeakingId(null);
      return;
    }

    // Native Android TTS bridge
    const androidBridge = (window as any).AndroidExporter;
    if (androidBridge && typeof androidBridge.speakText === "function") {
      try {
        setSpeakingId(id);
        androidBridge.speakText(speechReadyText);
        const estimatedDurationMs = Math.min(
          25000,
          Math.max(2200, speechReadyText.split(/\s+/).length * 380)
        );
        window.setTimeout(() => {
          if (speechRequestIdRef.current === reqId) {
            setSpeakingId((prev) => (prev === id ? null : prev));
          }
        }, estimatedDurationMs);
        return;
      } catch (e) {
        console.warn("Android native TTS bridge failed:", e);
      }
    }

    if (!("speechSynthesis" in window)) {
      setSpeakingId(null);
      return;
    }

    const speakWithLockedVoice = () => {
      if (speechRequestIdRef.current !== reqId) return;
      try {
        window.speechSynthesis.cancel();
        const utterance = new SpeechSynthesisUtterance(speechReadyText);
        const hasBengali = /[\u0980-\u09FF]/.test(speechReadyText);
        const hasHindi = /[\u0900-\u097F]/.test(speechReadyText);
        const langKey: "en" | "bn" | "hi" = hasBengali ? "bn" : hasHindi ? "hi" : "en";
        utterance.lang = hasBengali ? "bn-IN" : hasHindi ? "hi-IN" : "en-US";

        const lockedVoice = resolveSingleConsistentBrowserVoice(langKey);
        if (lockedVoice) {
          utterance.voice = lockedVoice;
          utterance.lang = lockedVoice.lang || utterance.lang;
        }
        utterance.rate = 0.98;
        utterance.pitch = 1.0;
        utterance.onend = () => {
          if (speechRequestIdRef.current === reqId) setSpeakingId(null);
        };
        utterance.onerror = () => {
          if (speechRequestIdRef.current === reqId) setSpeakingId(null);
        };

        setSpeakingId(id);
        window.speechSynthesis.speak(utterance);
      } catch {
        setSpeakingId(null);
      }
    };

    const existingVoices = window.speechSynthesis.getVoices();
    if (!existingVoices || existingVoices.length === 0) {
      let fired = false;
      const onVoicesReady = () => {
        if (fired) return;
        fired = true;
        window.speechSynthesis.removeEventListener("voiceschanged", onVoicesReady);
        speakWithLockedVoice();
      };
      window.speechSynthesis.addEventListener("voiceschanged", onVoicesReady);
      window.setTimeout(onVoicesReady, 220);
    } else {
      speakWithLockedVoice();
    }
  };

  const handleSpeakText = async (id: string, text: string) => {
    triggerHaptic("light");

    // If currently speaking or synthesizing this message, toggle stop immediately
    if (speakingId === id || synthesizingId === id) {
      stopAllSpeechPlayback();
      return;
    }

    // Stop any other active voice and issue a fresh request ID
    stopAllSpeechPlayback();
    const currentReqId = speechRequestIdRef.current;

    const speechText = formatTextForSpeech(text, 520);
    if (!speechText) {
      setSpeakingId(null);
      setSynthesizingId(null);
      return;
    }

    // On Android native APK where AndroidExporter.speakText is available, use the locked native device TTS engine
    // so every single message is spoken immediately by the exact same voice without switching between engines
    const androidBridge = (window as any).AndroidExporter;
    if (androidBridge && typeof androidBridge.speakText === "function") {
      fallbackSpeechSynthesis(id, text, currentReqId);
      return;
    }

    setSynthesizingId(id);
    setSpeakingId(id);

    try {
      // Single consistent Gemini Neural TTS ("Kore" 24kHz voice via v1beta) with 8s timeout
      const audioUrl = await synthesizeGeminiVoice(speechText, 8000);
      if (speechRequestIdRef.current !== currentReqId) return;
      setSynthesizingId(null);

      const audio = new Audio(audioUrl);
      currentAudioRef.current = audio;

      audio.onended = () => {
        if (speechRequestIdRef.current === currentReqId) {
          setSpeakingId(null);
          setSynthesizingId(null);
          currentAudioRef.current = null;
        }
      };

      audio.onerror = () => {
        if (speechRequestIdRef.current !== currentReqId) return;
        currentAudioRef.current = null;
        fallbackSpeechSynthesis(id, text, currentReqId);
      };

      await audio.play();
    } catch (err) {
      if (speechRequestIdRef.current !== currentReqId) return;
      fallbackSpeechSynthesis(id, text, currentReqId);
    }
  };

  const handleStopGeneration = () => {
    triggerHaptic("medium");
    if (abortControllerRef.current) {
      try {
        abortControllerRef.current.abort();
      } catch {}
      abortControllerRef.current = null;
    }
    if (activeStopwatchRef.current !== null) {
      window.clearInterval(activeStopwatchRef.current);
      activeStopwatchRef.current = null;
    }
    if (activeWatchdogRef.current !== null) {
      window.clearTimeout(activeWatchdogRef.current);
      activeWatchdogRef.current = null;
    }
    const targetMsgId = activeAssistantMsgIdRef.current;
    activeAssistantMsgIdRef.current = null;
    setMessages((prev) =>
      prev.map((msg) => {
        if ((targetMsgId && msg.id === targetMsgId) || msg.isStreaming) {
          const existingContent = (msg.content || "").trim();
          return {
            ...msg,
            content: existingContent || "*(Response stopped)*",
            isStreaming: false,
          };
        }
        return msg;
      })
    );
    setLoading(false);
  };

  const processIncomingMediaFiles = async (allSelectedFiles: File[]) => {
    if (!allSelectedFiles || allSelectedFiles.length === 0) return;

    const currentCount = pendingAttachmentsRef.current.length;
    if (currentCount >= MAX_MEDIA_ATTACHMENTS) {
      setErrorMessage(`Maximum ${MAX_MEDIA_ATTACHMENTS} images or videos allowed per message.`);
      triggerHaptic("error");
      return;
    }

    const remainingSlots = MAX_MEDIA_ATTACHMENTS - currentCount;
    const files = allSelectedFiles.slice(0, remainingSlots);
    const exceededLimit = allSelectedFiles.length > remainingSlots;

    setErrorMessage(
      exceededLimit
        ? `Maximum ${MAX_MEDIA_ATTACHMENTS} images or videos allowed per message. Attached the first ${MAX_MEDIA_ATTACHMENTS}.`
        : ""
    );
    setIsPreparingAttachments(true);
    triggerHaptic("light");

    try {
      const added: ChatAttachment[] = [];
      for (const file of files) {
        const rawMime = (file.type || "").trim().toLowerCase();
        const ext = ((file.name || "").split(".").pop() || "").toLowerCase();
        let mimeType = rawMime;
        if (!mimeType) {
          if (["mp4", "m4v"].includes(ext)) mimeType = "video/mp4";
          else if (ext === "webm") mimeType = "video/webm";
          else if (ext === "mov") mimeType = "video/quicktime";
          else if (ext === "png") mimeType = "image/png";
          else if (ext === "webp") mimeType = "image/webp";
          else if (["jpg", "jpeg"].includes(ext)) mimeType = "image/jpeg";
        }

        const isVideo = mimeType.startsWith("video/");
        const isImage = mimeType.startsWith("image/");
        if (!isVideo && !isImage) {
          setErrorMessage(`Unsupported file "${file.name}". Please select images or videos.`);
          continue;
        }

        if (file.size > 32 * 1024 * 1024) {
          setErrorMessage(`"${file.name}" exceeds the 32 MB limit.`);
          continue;
        }

        if (isImage) {
          let compressed = await compressImageFileForChat(
            file,
            files.length > 1 ? 560 : 640,
            0.68
          );
          if (compressed.dataBase64.length > 100000) {
            compressed = await compressImageFileForChat(file, 480, 0.6);
          }
          added.push({
            id: `att-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
            name: file.name || `pasted-image-${Date.now()}.jpg`,
            mimeType: compressed.mimeType,
            kind: "image",
            dataBase64: compressed.dataBase64,
            previewUrl: compressed.previewUrl,
            size: file.size,
          });
        } else {
          const extracted = await extractVideoKeyframesForChat(
            file,
            files.length > 1 ? 4 : 5,
            560,
            0.68
          );
          const dataBase64 =
            file.size <= 9 * 1024 * 1024 ? await blobToBase64Chunked(file) : "";
          const previewUrl = URL.createObjectURL(file) || extracted.posterDataUrl;
          added.push({
            id: `att-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
            name: file.name || `pasted-video-${Date.now()}.mp4`,
            mimeType,
            kind: "video",
            dataBase64,
            previewUrl,
            size: file.size,
            videoFrames: extracted.frames,
            durationSec: extracted.durationSec,
          });
        }
      }

      if (added.length > 0) {
        setPendingAttachments((prev) => {
          const next = [...prev, ...added].slice(0, MAX_MEDIA_ATTACHMENTS);
          pendingAttachmentsRef.current = next;
          return next;
        });
        triggerHaptic("success");
      }
    } catch (err: any) {
      setErrorMessage(err?.message || "Could not attach selected file(s).");
    } finally {
      setIsPreparingAttachments(false);
    }
  };

  const handleMediaFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const fileList = e.target.files;
    if (!fileList || fileList.length === 0) return;
    const allSelectedFiles: File[] = Array.from(fileList);
    e.target.value = "";
    await processIncomingMediaFiles(allSelectedFiles);
  };

  const extractClipboardMediaFiles = (clipboardData: DataTransfer | null): File[] => {
    if (!clipboardData) return [];
    const mediaFiles: File[] = [];
    const seenSizes = new Set<string>();

    if (clipboardData.items && clipboardData.items.length > 0) {
      for (let i = 0; i < clipboardData.items.length; i++) {
        const item = clipboardData.items[i];
        if (item.kind === "file") {
          const blob = item.getAsFile();
          if (blob) {
            const type = (blob.type || item.type || "").toLowerCase();
            if (type.startsWith("image/") || type.startsWith("video/")) {
              const ext = type.split("/")[1]?.split(";")[0] || "png";
              const namedFile =
                blob.name && blob.name !== "image.png"
                  ? blob
                  : new File(
                      [blob],
                      `clipboard-${Date.now()}-${i}.${ext}`,
                      { type: type || "image/png" }
                    );
              const sig = `${namedFile.size}-${type}`;
              if (!seenSizes.has(sig)) {
                seenSizes.add(sig);
                mediaFiles.push(namedFile);
              }
            }
          }
        }
      }
    }

    if (mediaFiles.length === 0 && clipboardData.files && clipboardData.files.length > 0) {
      for (let i = 0; i < clipboardData.files.length; i++) {
        const f = clipboardData.files[i];
        const type = (f.type || "").toLowerCase();
        if (type.startsWith("image/") || type.startsWith("video/")) {
          mediaFiles.push(f);
        }
      }
    }

    return mediaFiles;
  };

  const handlePasteMedia = (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    if (isAiBusy || isRecording) return;
    const mediaFiles = extractClipboardMediaFiles(e.clipboardData);
    if (mediaFiles.length > 0) {
      e.preventDefault();
      processIncomingMediaFiles(mediaFiles);
    }
  };

  // Also listen for window-level paste events while Buzz AI drawer is open (in case textarea isn't focused when pressing Ctrl+V)
  useEffect(() => {
    if (!isOpen) return;
    const onWindowPaste = (e: ClipboardEvent) => {
      if (isAiBusy || isRecording) return;
      if (e.defaultPrevented) return;
      const mediaFiles = extractClipboardMediaFiles(e.clipboardData);
      if (mediaFiles.length > 0) {
        e.preventDefault();
        processIncomingMediaFiles(mediaFiles);
      }
    };
    window.addEventListener("paste", onWindowPaste);
    return () => {
      window.removeEventListener("paste", onWindowPaste);
    };
  }, [isOpen, isAiBusy, isRecording]);

  const handleRemovePendingAttachment = (attId: string) => {
    triggerHaptic("light");
    setPendingAttachments((prev) => {
      const next = prev.filter((a) => a.id !== attId);
      pendingAttachmentsRef.current = next;
      return next;
    });
  };

  const resolveUploadedImageForAction = (
    rawAction: AssistantAction | null | undefined,
    currentTurnAttachments: ChatAttachment[],
    historyMessages: ChatMessage[],
    rawUserPrompt: string
  ): AssistantAction | null => {
    if (!rawAction) return null;
    const action: AssistantAction = { ...rawAction };

    const toDataUrl = (att: ChatAttachment): string => {
      if (att.previewUrl && att.previewUrl.startsWith("data:image/")) {
        return att.previewUrl;
      }
      if (att.dataBase64) {
        return `data:${att.mimeType || "image/jpeg"};base64,${att.dataBase64}`;
      }
      return att.previewUrl || "";
    };

    const currentImages = (currentTurnAttachments || [])
      .filter((a) => a && a.kind === "image")
      .map(toDataUrl)
      .filter(Boolean);

    const historyImages: string[] = [];
    for (let i = historyMessages.length - 1; i >= 0; i--) {
      const m = historyMessages[i];
      if (m.role === "user" && Array.isArray(m.attachments) && m.attachments.length > 0) {
        const imgs = m.attachments
          .filter((a) => a && a.kind === "image")
          .map(toDataUrl)
          .filter(Boolean);
        if (imgs.length > 0) {
          historyImages.push(...imgs);
          break;
        }
      }
    }

    const availableImages = currentImages.length > 0 ? currentImages : historyImages;
    if (availableImages.length === 0) return action;

    const requestedIdx =
      typeof action.attachmentIndex === "number" && action.attachmentIndex >= 0
        ? Math.min(action.attachmentIndex, availableImages.length - 1)
        : 0;
    const primaryImage = availableImages[requestedIdx] || availableImages[0];

    if (action.type === "UPDATE_PRODUCT_IMAGE") {
      action.image = action.image || primaryImage;
      return action;
    }

    if (action.type === "ADD_PRODUCT") {
      const shouldAttach =
        Boolean(action.useAttachedImage) ||
        currentImages.length > 0 ||
        /\b(image|photo|picture|pic|uploaded|attached|use\s+this|use\s+it)\b/i.test(rawUserPrompt);

      if (shouldAttach && primaryImage) {
        action.useAttachedImage = true;
        action.image = action.image || primaryImage;
        if (Array.isArray(action.products) && action.products.length > 0) {
          action.products = action.products.map((item, idx) => {
            const itemImgIdx =
              typeof item.attachmentIndex === "number" && item.attachmentIndex >= 0
                ? Math.min(item.attachmentIndex, availableImages.length - 1)
                : Math.min(idx, availableImages.length - 1);
            return {
              ...item,
              image: item.image || availableImages[itemImgIdx] || primaryImage,
            };
          });
        }
      }
    }

    return action;
  };

  const handleSendMessage = async (textToSend?: string) => {
    const rawPrompt = (textToSend !== undefined ? textToSend : input).trim();
    const attachmentsToSend = [...pendingAttachmentsRef.current];
    const activeQuote = quotedTextRef.current.trim();
    if (!rawPrompt && attachmentsToSend.length === 0 && !activeQuote) return;

    const baseQuestion =
      rawPrompt ||
      (activeQuote
        ? "What does this mean? Please explain clearly."
        : `Analyze the attached ${
            attachmentsToSend.length === 1
              ? attachmentsToSend[0].kind
              : `${attachmentsToSend.length} media files`
          } and extract any text or details.`);

    const promptText = activeQuote
      ? `Regarding this quoted text from our chat: "${activeQuote}"\n\n${baseQuestion}`
      : baseQuestion;

    // If a previous request was still winding down when the user sends a new message,
    // cleanly abort it instead of silently dropping the user's new message!
    if (loading) {
      if (abortControllerRef.current) {
        try {
          abortControllerRef.current.abort();
        } catch {}
        abortControllerRef.current = null;
      }
      if (activeStopwatchRef.current !== null) {
        window.clearInterval(activeStopwatchRef.current);
        activeStopwatchRef.current = null;
      }
      if (activeWatchdogRef.current !== null) {
        window.clearTimeout(activeWatchdogRef.current);
        activeWatchdogRef.current = null;
      }
      activeAssistantMsgIdRef.current = null;
    }

    // Ensure any previous speech playback is stopped when sending a new message
    stopAllSpeechPlayback();

    const lowerPrompt = rawPrompt.toLowerCase();
    if (
      attachmentsToSend.length === 0 &&
      !activeQuote &&
      (lowerPrompt.includes("delete the whole context") ||
        lowerPrompt.includes("delete whole context") ||
        lowerPrompt.includes("delete context") ||
        lowerPrompt.includes("clear context") ||
        lowerPrompt.includes("clear chat") ||
        lowerPrompt.includes("delete history") ||
        lowerPrompt.includes("clear history") ||
        lowerPrompt.includes("start a new chat") ||
        lowerPrompt.includes("start new chat") ||
        lowerPrompt.includes("reset chat"))
    ) {
      handleClearHistory();
      return;
    }

    triggerHaptic("medium");
    inputRef.current?.blur();
    if (inputRef.current) {
      inputRef.current.style.height = "auto";
    }
    setInput("");
    if (activeQuote) {
      quotedTextRef.current = "";
      setQuotedText("");
    }
    if (attachmentsToSend.length > 0) {
      pendingAttachmentsRef.current = [];
      setPendingAttachments([]);
    }
    setErrorMessage("");

    // Preserve compressed base64 & persistent data URL on chat attachments so:
    // 1. Clicking any uploaded image always opens the full-screen lightbox viewer
    // 2. Follow-up questions ("what was in the image?") include the image in conversationHistory
    const uiAttachments =
      attachmentsToSend.length > 0
        ? attachmentsToSend.map((a) => ({
            ...a,
            previewUrl:
              a.previewUrl && !a.previewUrl.startsWith("blob:")
                ? a.previewUrl
                : a.dataBase64 && a.kind === "image"
                ? `data:${a.mimeType || "image/jpeg"};base64,${a.dataBase64}`
                : a.previewUrl,
          }))
        : undefined;

    const userMessage: ChatMessage = {
      id: `user-${Date.now()}`,
      role: "user",
      content: rawPrompt || (activeQuote ? "What does this mean?" : ""),
      timestamp: Date.now(),
      ...(activeQuote ? { quotedText: activeQuote } : {}),
      ...(uiAttachments ? { attachments: uiAttachments } : {}),
    };

    const sendStartTime = Date.now();
    const assistantMsgId = `assistant-${Date.now()}`;
    const initialAssistantMessage: ChatMessage = {
      id: assistantMsgId,
      role: "assistant",
      content: "",
      timestamp: Date.now(),
      isStreaming: true,
      thought: generateDynamicThought(promptText, "", storeContext),
      thoughtDuration: 0,
    };

    const cleanedPrevMessages = messagesRef.current
      .map((m) => (m.isStreaming ? { ...m, isStreaming: false } : m))
      .filter((m) => !(m.role === "assistant" && !m.content?.trim()));
    const newHistory = [...cleanedPrevMessages, userMessage];

    if (isRoleModificationPrompt(promptText)) {
      const refusalMessage: ChatMessage = {
        id: assistantMsgId,
        role: "assistant",
        content: ROLE_MODIFICATION_REFUSAL_REPLY,
        timestamp: Date.now(),
        action: null,
        isStreaming: false,
        thought: "Verified security policy: account role promotions and demotions are restricted from AI execution.",
        thoughtDuration: 1,
      };
      setMessages([...newHistory, refusalMessage]);
      triggerHaptic("light");
      setTimeout(() => scrollToBottom(true), 10);
      return;
    }

    setMessages([...newHistory, initialAssistantMessage]);
    setLoading(true);
    activeAssistantMsgIdRef.current = assistantMsgId;
    const abortController = new AbortController();
    abortControllerRef.current = abortController;
    isNearBottomRef.current = true;
    setTimeout(() => scrollToBottom(true), 10);

    let watchdogSettled = false;
    let firstTokenTime = 0;
    let lastReportedSec = 0;
    const stopwatchTimer = window.setInterval(() => {
      if (watchdogSettled || firstTokenTime > 0 || abortController.signal.aborted) return;
      const elapsedSec = computeLiveThinkingSeconds(sendStartTime, Date.now());
      if (elapsedSec === lastReportedSec) return;
      lastReportedSec = elapsedSec;
      setMessages((prev) =>
        prev.map((msg) =>
          msg.id === assistantMsgId && msg.isStreaming
            ? { ...msg, thoughtDuration: elapsedSec }
            : msg
        )
      );
    }, 100);
    activeStopwatchRef.current = stopwatchTimer;

    const watchdogMs = 60000;
    const handleWatchdogExpire = () => {
      if (watchdogSettled || abortController.signal.aborted) return;
      watchdogSettled = true;
      window.clearInterval(stopwatchTimer);
      activeStopwatchRef.current = null;
      activeWatchdogRef.current = null;
      activeAssistantMsgIdRef.current = null;
      const duration = computeFinalThoughtSeconds(
        sendStartTime,
        firstTokenTime || Date.now()
      );
      let hadPartialContent = false;
      setMessages((prev) => {
        const target = prev.find((msg) => msg.id === assistantMsgId);
        if (target?.content?.trim()) {
          hadPartialContent = true;
          return prev.map((msg) =>
            msg.id === assistantMsgId
              ? {
                  ...msg,
                  isStreaming: false,
                  thoughtDuration: duration,
                }
              : msg
          );
        }
        return prev.filter((msg) => msg.id !== assistantMsgId);
      });
      if (!hadPartialContent) {
        setErrorMessage(
          "Buzz AI is taking longer than expected to process this request. Please try again."
        );
        triggerHaptic("error");
      }
      setLoading(false);
      scrollToBottom(false);
    };
    let watchdogTimer = window.setTimeout(handleWatchdogExpire, watchdogMs);
    activeWatchdogRef.current = watchdogTimer;

    try {
      const historyPayload: ConversationTurnInput[] = cleanedPrevMessages
        .filter(
          (m) =>
            m.id !== "welcome-system-msg" &&
            m.id !== "welcome" &&
            (Boolean(m.content?.trim()) ||
              (Array.isArray(m.attachments) && m.attachments.length > 0)) &&
            m.content !== "*(Response stopped)*" &&
            !(
              m.role === "assistant" &&
              m.content.includes("Store Snapshot:") &&
              m.content.includes("How can I help with your store?")
            ) &&
            !(
              m.role === "assistant" &&
              m.content.includes("I checked your store catalog (") &&
              m.content.includes("Please rephrase or try your command again.")
            )
        )
        .slice(-6)
        .map((m, idx, arr) => {
          const promptAsksAboutMedia =
            attachmentsToSend.length === 0 &&
            /\b(image|images|photo|photos|picture|pictures|pic|pics|video|videos|media|upload|uploaded|attach|attached|sent|send|saw|see|look|show|shown|first|second|third|1st|2nd|3rd|what\s+was|what\s+is\s+in|what\s+are\s+those|describe|analyze|product|use\s+this|use\s+it)\b/i.test(
              promptText
            );
          const isRecentWithMedia =
            promptAsksAboutMedia &&
            m.role === "user" &&
            Array.isArray(m.attachments) &&
            m.attachments.length > 0 &&
            arr.length - idx <= 3;
          const turnAttachments = isRecentWithMedia
            ? m.attachments!
                .map((a) => {
                  const b64 =
                    a.dataBase64 ||
                    (a.previewUrl?.startsWith("data:")
                      ? a.previewUrl.slice(a.previewUrl.indexOf(",") + 1)
                      : "");
                  const frames =
                    a.kind === "video" && Array.isArray(a.videoFrames) && a.videoFrames.length > 0
                      ? a.videoFrames.slice(0, 5)
                      : undefined;
                  return {
                    name: a.name,
                    mimeType: a.mimeType || (a.kind === "video" ? "video/mp4" : "image/jpeg"),
                    kind: a.kind,
                    data: b64,
                    ...(frames ? { frames } : {}),
                  };
                })
                .filter((a) => Boolean(a.data) || (Array.isArray(a.frames) && a.frames.length > 0))
            : undefined;

          return {
            role: m.role,
            content:
              m.content?.trim() ||
              (m.attachments?.length
                ? `[User attached ${m.attachments.length} ${m.attachments.map((a) => a.kind).join(", ")}]`
                : ""),
            ...(turnAttachments && turnAttachments.length > 0
              ? { attachments: turnAttachments }
              : {}),
          };
        });

      await askGeminiAssistantStream(
        promptText,
        historyPayload,
        storeContext,
        (cleanChunkText) => {
          if (watchdogSettled || abortController.signal.aborted) return;
          window.clearTimeout(watchdogTimer);
          watchdogTimer = window.setTimeout(handleWatchdogExpire, watchdogMs);
          activeWatchdogRef.current = watchdogTimer;
          if (!firstTokenTime && cleanChunkText) {
            firstTokenTime = Date.now();
            window.clearInterval(stopwatchTimer);
          }
          const elapsedSec = firstTokenTime
            ? computeFinalThoughtSeconds(sendStartTime, firstTokenTime)
            : computeLiveThinkingSeconds(sendStartTime, Date.now());
          setMessages((prev) =>
            prev.map((msg) =>
              msg.id === assistantMsgId
                ? {
                    ...msg,
                    content: cleanChunkText || msg.content,
                    isStreaming: true,
                    thoughtDuration: elapsedSec,
                  }
                : msg
            )
          );
          scrollToBottom(false);
        },
        (finalPayload) => {
          if (watchdogSettled || abortController.signal.aborted) return;
          watchdogSettled = true;
          if (!firstTokenTime) {
            firstTokenTime = Date.now();
          }
          window.clearTimeout(watchdogTimer);
          window.clearInterval(stopwatchTimer);
          activeStopwatchRef.current = null;
          activeWatchdogRef.current = null;
          activeAssistantMsgIdRef.current = null;

          const effectiveReply = String(finalPayload.reply || "").trim();
          const rawCandidateAction =
            finalPayload.action ||
            inferClientActionFromTurn(
              rawPrompt,
              effectiveReply,
              storeContext,
              historyPayload
            );
          const effectiveAction = resolveUploadedImageForAction(
            rawCandidateAction,
            attachmentsToSend,
            newHistory,
            rawPrompt
          );

          const elapsedSec = computeFinalThoughtSeconds(
            sendStartTime,
            firstTokenTime || Date.now()
          );
          const authenticThought =
            finalPayload.thought ||
            generateDynamicThought(promptText, effectiveReply, storeContext);

          setMessages((prev) =>
            prev.map((msg) =>
              msg.id === assistantMsgId
                ? {
                    ...msg,
                    content:
                      effectiveReply ||
                      msg.content?.trim() ||
                      (effectiveAction ? "Prepared your requested store update:" : ""),
                    action: effectiveAction,
                    isStreaming: false,
                    thought: authenticThought,
                    thoughtDuration: Math.max(msg.thoughtDuration || 1, elapsedSec),
                  }
                : msg
            )
          );
          setLoading(false);
          triggerHaptic("light");
          scrollToBottom(false);

          // If the AI's reply claims the stock or price has already been updated (or user directly commanded a stock/price update),
          // auto-execute the Firestore update immediately so the AI never claims it updated stock without actually updating the database!
          if (
            effectiveAction &&
            (effectiveAction.type === "UPDATE_STOCK" || effectiveAction.type === "UPDATE_PRICE") &&
            /\b(has\s+been\s+(?:successfully\s+)?(?:increased|decreased|reduced|updated|changed|set|added)|inventory\s+is\s+now\s+updated|have\s+now\s+(?:manually\s+)?updated|updated\s+the\s+(?:inventory|stock|price))\b/i.test(
              effectiveReply
            )
          ) {
            window.setTimeout(() => {
              handleExecuteAction(assistantMsgId, effectiveAction);
            }, 60);
          }
        },
        abortController.signal,
        attachmentsToSend
      );

      // Safeguard: if askGeminiAssistantStream resolved without triggering onComplete, finalize any streamed content
      if (!watchdogSettled && !abortController.signal.aborted) {
        watchdogSettled = true;
        window.clearTimeout(watchdogTimer);
        window.clearInterval(stopwatchTimer);
        activeStopwatchRef.current = null;
        activeWatchdogRef.current = null;
        activeAssistantMsgIdRef.current = null;
        const elapsedSec = computeFinalThoughtSeconds(sendStartTime, Date.now());
        setMessages((prev) => {
          const target = prev.find((msg) => msg.id === assistantMsgId);
          if (target?.content?.trim()) {
            return prev.map((msg) =>
              msg.id === assistantMsgId
                ? {
                    ...msg,
                    isStreaming: false,
                    thoughtDuration: Math.max(msg.thoughtDuration || 1, elapsedSec),
                  }
                : msg
            );
          }
          return prev.filter((msg) => msg.id !== assistantMsgId);
        });
        setLoading(false);
        scrollToBottom(false);
      }
    } catch (err: any) {
      if (watchdogSettled || abortController.signal.aborted) return;
      watchdogSettled = true;
      window.clearTimeout(watchdogTimer);
      window.clearInterval(stopwatchTimer);
      activeStopwatchRef.current = null;
      activeWatchdogRef.current = null;
      activeAssistantMsgIdRef.current = null;

      const elapsedSec = computeFinalThoughtSeconds(sendStartTime, Date.now());
      setMessages((prev) =>
        prev
          .map((msg) =>
            msg.id === assistantMsgId
              ? {
                  ...msg,
                  isStreaming: false,
                  thoughtDuration: Math.max(msg.thoughtDuration || 1, elapsedSec),
                }
              : msg
          )
          .filter((msg) => !(msg.id === assistantMsgId && !msg.content?.trim()))
      );
      setErrorMessage(
        err?.message || "Could not connect to Buzz AI server. Please check your connection and try again."
      );
      setLoading(false);
      triggerHaptic("error");
      scrollToBottom(false);
    }
  };

  // Helper so mobile WebView / offline writes settle immediately after local IndexedDB commit
  const settleWriteFast = <T,>(promise: Promise<T>, ms: number = 1400): Promise<T | undefined> =>
    Promise.race([
      promise,
      new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), ms)),
    ]);

  // Execute interactive action (e.g. Apply Stock Update to Firestore)
  const handleExecuteAction = async (
    messageId: string,
    action: AssistantAction
  ) => {
    if (!action) return;
    triggerHaptic("heavy");
    setExecutingActionId(messageId);

    try {
      if (action.type === "UPDATE_STOCK") {
        let targetId = action.productId;

        if (!targetId && action.productName) {
          const matched = products.find(
            (p) =>
              p.name.toLowerCase().trim() ===
              action.productName!.toLowerCase().trim()
          );
          if (matched) targetId = matched.id;
        }

        if (!targetId) {
          throw new Error(
            `Could not locate product "${action.productName || "Unknown"}" in catalog.`
          );
        }

        const rawStockVal = Number(action.newStock);
        if (isNaN(rawStockVal) || rawStockVal < 0) {
          throw new Error("Invalid target stock value specified.");
        }
        if (rawStockVal > 2000) {
          throw new Error("Cannot stock a product above the maximum limit of 2,000 units.");
        }
        const newStockVal = Math.min(2000, rawStockVal);

        updateProductOptimistic(targetId, { stock: newStockVal });
        await settleWriteFast(
          updateDoc(doc(db, "products", targetId), {
            stock: newStockVal,
          })
        );

        if (user) {
          logActivity(
            "stock_modification",
            `AI Assistant adjusted stock of ${action.productName || targetId} to ${newStockVal} (${action.quantityChange && action.quantityChange > 0 ? "+" : ""}${action.quantityChange || 0} units)`,
            user.uid,
            user.displayName || "Admin",
            user.email || ""
          ).catch(() => {});
        }

        setMessages((prev) =>
          prev.map((msg) =>
            msg.id === messageId ? { ...msg, actionApplied: true } : msg
          )
        );

        triggerHaptic("success");
        if (onProductUpdated) onProductUpdated();
      } else if (action.type === "UPDATE_PRICE") {
        let targetId = action.productId;
        if (!targetId && action.productName) {
          const matched = products.find(
            (p) =>
              p.name.toLowerCase().trim() ===
              action.productName!.toLowerCase().trim()
          );
          if (matched) targetId = matched.id;
        }

        if (!targetId) {
          throw new Error(
            `Could not locate product "${action.productName || "Unknown"}" in catalog.`
          );
        }

        const rawPriceVal = Number(action.newPrice);
        if (isNaN(rawPriceVal) || rawPriceVal <= 0) {
          throw new Error("Invalid price specified.");
        }
        if (rawPriceVal > 10000) {
          throw new Error("Product price cannot exceed ₹10,000 (maximum bill limit).");
        }
        const newPriceVal = Math.min(10000, rawPriceVal);

        updateProductOptimistic(targetId, { price: newPriceVal });
        await settleWriteFast(
          updateDoc(doc(db, "products", targetId), {
            price: newPriceVal,
          })
        );

        if (user) {
          logActivity(
            "stock_modification",
            `AI Assistant updated price of ${action.productName || targetId} to ₹${newPriceVal}`,
            user.uid,
            user.displayName || "Admin",
            user.email || ""
          ).catch(() => {});
        }

        setMessages((prev) =>
          prev.map((msg) =>
            msg.id === messageId ? { ...msg, actionApplied: true } : msg
          )
        );

        triggerHaptic("success");
        if (onProductUpdated) onProductUpdated();
      } else if (action.type === "UPDATE_PRODUCT_IMAGE") {
        let targetId = action.productId;
        if (!targetId && action.productName) {
          const s = action.productName.toLowerCase().trim();
          const matched =
            products.find((p) => p.name.toLowerCase().trim() === s) ||
            products.find((p) => p.name.toLowerCase().includes(s));
          if (matched) targetId = matched.id;
        }

        if (!targetId) {
          throw new Error(
            `Could not locate product "${action.productName || "Unknown"}" in catalog.`
          );
        }

        let imageToSave = action.image;
        if (!imageToSave) {
          const resolved = resolveUploadedImageForAction(action, [], messages, "");
          imageToSave = resolved?.image;
        }
        if (!imageToSave) {
          throw new Error(
            "No uploaded image found in this chat. Please attach an image first and try again."
          );
        }

        updateProductOptimistic(targetId, { image: imageToSave });
        await settleWriteFast(
          updateDoc(doc(db, "products", targetId), {
            image: imageToSave,
            updatedAt: Date.now(),
          })
        );

        if (user) {
          logActivity(
            "stock_modification",
            `AI Assistant updated product photo for "${action.productName || targetId}" using uploaded image`,
            user.uid,
            user.displayName || "Admin",
            user.email || ""
          ).catch(() => {});
        }

        setMessages((prev) =>
          prev.map((msg) =>
            msg.id === messageId ? { ...msg, actionApplied: true } : msg
          )
        );

        triggerHaptic("success");
        if (onProductUpdated) onProductUpdated();
      } else if (action.type === "ADD_PRODUCT") {
        const itemsToCreate =
          Array.isArray(action.products) && action.products.length > 0
            ? action.products
            : action.name && action.price
            ? [
                {
                  name: action.name,
                  price: Number(action.price) || 0,
                  stock: Number(action.stock) || 0,
                  category: normalizeProductCategory(action.category, action.name),
                  ...(action.image ? { image: action.image } : {}),
                },
              ]
            : [];

        if (itemsToCreate.length === 0) {
          throw new Error("Product name and price are required.");
        }

        for (const item of itemsToCreate) {
          if ((Number(item.stock) || 0) > 2000) {
            throw new Error(`Cannot stock "${item.name}" above the maximum limit of 2,000 units.`);
          }
          if ((Number(item.price) || 0) > 10000) {
            throw new Error(`Price for "${item.name}" cannot exceed ₹10,000.`);
          }
        }

        const writePromises: Promise<any>[] = [];
        for (const item of itemsToCreate) {
          const newDocRef = doc(collection(db, "products"));
          const cleanItemName = String(item.name).trim();
          const itemImage = item.image || action.image;
          const newProdPayload: Record<string, any> = {
            name: cleanItemName,
            price: Math.min(10000, Math.max(0, Number(item.price) || 0)),
            stock: Math.min(2000, Math.max(0, Number(item.stock) || 0)),
            category: normalizeProductCategory(
              item.category || action.category,
              cleanItemName
            ),
            createdAt: Date.now(),
            soldCount: 0,
            ...(itemImage ? { image: itemImage } : {}),
          };

          addProductOptimistic({ ...(newProdPayload as any), id: newDocRef.id });
          writePromises.push(setDoc(newDocRef, newProdPayload));
        }

        await settleWriteFast(Promise.all(writePromises));

        if (user) {
          const summaryStr =
            itemsToCreate.length === 1
              ? `AI Assistant created new product "${itemsToCreate[0].name}" (Price: ₹${itemsToCreate[0].price}, Stock: ${itemsToCreate[0].stock || 0})`
              : `AI Assistant created ${itemsToCreate.length} products: ${itemsToCreate
                  .map((i) => `${i.name} (₹${i.price}, Stock: ${i.stock || 0})`)
                  .join(", ")}`;
          logActivity(
            "stock_modification",
            summaryStr,
            user.uid,
            user.displayName || "Admin",
            user.email || ""
          ).catch(() => {});
        }

        setMessages((prev) =>
          prev.map((msg) =>
            msg.id === messageId ? { ...msg, actionApplied: true } : msg
          )
        );

        triggerHaptic("success");
        if (onProductUpdated) onProductUpdated();
      } else if (action.type === "UPDATE_BILL") {
        const targetBillId = action.billId;
        if (!targetBillId) {
          throw new Error("Missing transaction ID for bill update.");
        }

        const rawTotalVal = Number(action.newTotal);
        if (isNaN(rawTotalVal) || rawTotalVal < 0) {
          throw new Error("Invalid bill total specified.");
        }
        if (rawTotalVal > 10000) {
          throw new Error("Maximum bill total is ₹10,000.");
        }
        const newTotalVal = Math.min(10000, rawTotalVal);

        await settleWriteFast(
          updateDoc(doc(db, "bills", targetBillId), {
            total: newTotalVal,
            updatedAt: Date.now(),
          })
        );

        try {
          const existingBill = bills.find((b) => b.id === targetBillId);
          if (existingBill) {
            const updatedBill = { ...existingBill, total: newTotalVal, updatedAt: Date.now() };
            sqliteSaveBill(updatedBill).catch(() => {});
            window.dispatchEvent(
              new CustomEvent("offlineBillQueued", { detail: updatedBill })
            );
          }
        } catch (sqliteErr) {}

        if (user) {
          logActivity(
            "bill_edit",
            `AI Assistant adjusted transaction #${targetBillId.slice(0, 8)} total to ₹${newTotalVal} (was ₹${action.oldTotal ?? "—"})`,
            user.uid,
            user.displayName || "Admin",
            user.email || ""
          ).catch(() => {});
        }

        setMessages((prev) =>
          prev.map((msg) =>
            msg.id === messageId ? { ...msg, actionApplied: true } : msg
          )
        );

        triggerHaptic("success");
      } else if (action.type === "DELETE_BILL") {
        const targetBillId = action.billId;
        if (!targetBillId) {
          throw new Error("Missing transaction ID for bill deletion.");
        }

        const existingBill = bills.find((b) => b.id === targetBillId);
        const itemsToRestore = action.items || existingBill?.items || [];

        removeBillOptimistic(targetBillId);
        await settleWriteFast(deleteBillAndRestoreStock(targetBillId, itemsToRestore));

        try {
          sqliteDeleteBill(targetBillId).catch(() => {});
        } catch (sqliteErr) {}

        if (user) {
          logActivity(
            "delete_bill",
            `AI Assistant voided transaction #${targetBillId.slice(0, 8)} totaling ₹${action.total || existingBill?.total || 0} and restored product inventory.`,
            user.uid,
            user.displayName || "Admin",
            user.email || ""
          ).catch(() => {});
        }

        setMessages((prev) =>
          prev.map((msg) =>
            msg.id === messageId ? { ...msg, actionApplied: true } : msg
          )
        );

        triggerHaptic("success");
        if (onProductUpdated) onProductUpdated();
      } else if (action.type === "DELETE_PRODUCT") {
        let targetId = action.productId;
        const matched = products.find(
          (p) =>
            (targetId && p.id === targetId) ||
            (action.productName &&
              p.name.toLowerCase().trim() === action.productName.toLowerCase().trim())
        );
        if (!targetId && matched) {
          targetId = matched.id;
        }

        if (!targetId) {
          throw new Error(
            `Could not locate product "${action.productName || "Unknown"}" in catalog.`
          );
        }

        const resolvedName = matched?.name || action.productName;
        removeProductOptimistic(targetId, resolvedName);
        await deleteProduct(targetId, resolvedName);

        if (user) {
          logActivity(
            "product_deletion",
            `AI Assistant removed product "${action.productName || targetId}" from store catalog`,
            user.uid,
            user.displayName || "Admin",
            user.email || ""
          ).catch(() => {});
        }

        setMessages((prev) =>
          prev.map((msg) =>
            msg.id === messageId ? { ...msg, actionApplied: true } : msg
          )
        );

        triggerHaptic("success");
        if (onProductUpdated) onProductUpdated();
      } else if (action.type === "ADD_EXPENSE") {
        const cleanTitle = String(action.title || "").trim();
        if (!cleanTitle || action.amount === undefined) {
          throw new Error("Please specify both the expense title/description and amount.");
        }

        const costAmount = Number(action.amount);
        if (isNaN(costAmount) || costAmount <= 0) {
          throw new Error("Invalid expense amount specified.");
        }

        const normalizedCategory = normalizeClientExpenseCategory(action.category);
        const expRef = doc(collection(db, "other_costs"));
        const newCostRecord = {
          id: expRef.id,
          title: cleanTitle,
          amount: costAmount,
          category: normalizedCategory,
          date: Date.now(),
          ownerId: user?.uid || "system",
        };
        await settleWriteFast(
          setDoc(expRef, {
            title: newCostRecord.title,
            amount: newCostRecord.amount,
            category: newCostRecord.category,
            date: newCostRecord.date,
            ownerId: newCostRecord.ownerId,
          })
        );

        try {
          const raw = localStorage.getItem("local_other_costs_fallback");
          const current = raw ? JSON.parse(raw) : [];
          const next = [
            newCostRecord,
            ...(Array.isArray(current) ? current.filter((c: any) => c.id !== expRef.id) : []),
          ];
          localStorage.setItem("local_other_costs_fallback", JSON.stringify(next));
          window.dispatchEvent(new CustomEvent("otherCostsUpdated", { detail: next }));
        } catch {}

        if (user) {
          logActivity(
            "expense_entry",
            `AI Assistant recorded ${normalizedCategory} "${cleanTitle}" for ₹${costAmount}`,
            user.uid,
            user.displayName || "Admin",
            user.email || ""
          ).catch(() => {});
        }

        setMessages((prev) =>
          prev.map((msg) =>
            msg.id === messageId ? { ...msg, actionApplied: true } : msg
          )
        );

        triggerHaptic("success");
      } else if (action.type === "DELETE_EXPENSE") {
        if (!action.expenseId) {
          throw new Error("Missing expense ID for deletion.");
        }

        await settleWriteFast(deleteDoc(doc(db, "other_costs", action.expenseId)));

        try {
          const raw = localStorage.getItem("local_other_costs_fallback");
          const current = raw ? JSON.parse(raw) : [];
          if (Array.isArray(current)) {
            const next = current.filter((c: any) => c.id !== action.expenseId);
            localStorage.setItem("local_other_costs_fallback", JSON.stringify(next));
            window.dispatchEvent(new CustomEvent("otherCostsUpdated", { detail: next }));
          }
        } catch {}

        if (user) {
          logActivity(
            "expense_deletion",
            `AI Assistant deleted expense record #${action.expenseId.slice(0, 8)}`,
            user.uid,
            user.displayName || "Admin",
            user.email || ""
          ).catch(() => {});
        }

        setMessages((prev) =>
          prev.map((msg) =>
            msg.id === messageId ? { ...msg, actionApplied: true } : msg
          )
        );

        triggerHaptic("success");
      } else if (action.type === "UPDATE_ROLE") {
        throw new Error(
          "Account role changes (promoting or demoting admins) cannot be performed via Buzz AI."
        );
      } else if (action.type === "PURGE_STORE_DATA") {
        const targetScope = action.target || "both";
        let deletedProductsCount = 0;
        let deletedBillsCount = 0;

        if (targetScope === "products" || targetScope === "both") {
          const knownIds = new Set<string>();
          for (const prod of products) {
            if (prod.id) {
              knownIds.add(prod.id);
              removeProductOptimistic(prod.id, prod.name);
              deleteDoc(doc(db, "products", prod.id)).catch(() => {});
              deletedProductsCount++;
            }
          }
          clearProductsOptimistic();
          sqliteClearProducts().catch(() => {});
          purgeStockAlertsForDeletedProducts(undefined, undefined, true).catch(() => {});
          getDocs(collection(db, "products"))
            .then((snap) => {
              snap.forEach((docSnap) => {
                if (!knownIds.has(docSnap.id)) {
                  deleteDoc(doc(db, "products", docSnap.id)).catch(() => {});
                }
              });
            })
            .catch(() => {});
        }

        if (targetScope === "bills" || targetScope === "both") {
          const knownBillIds = new Set<string>();
          for (const b of bills) {
            if (b.id) {
              knownBillIds.add(b.id);
              removeBillOptimistic(b.id);
              deleteDoc(doc(db, "bills", b.id)).catch(() => {});
              deleteDoc(doc(db, "other_costs", `udhaar_bill_${b.id}`)).catch(() => {});
              sqliteDeleteBill(b.id).catch(() => {});
              deletedBillsCount++;
            }
          }
          clearBillsOptimistic();
          sqliteClearBills().catch(() => {});
          getDocs(collection(db, "bills"))
            .then((snap) => {
              snap.forEach((docSnap) => {
                if (!knownBillIds.has(docSnap.id)) {
                  deleteDoc(doc(db, "bills", docSnap.id)).catch(() => {});
                  deleteDoc(doc(db, "other_costs", `udhaar_bill_${docSnap.id}`)).catch(() => {});
                }
              });
            })
            .catch(() => {});
        }

        if (user) {
          logActivity(
            "bulk_purge",
            `AI Assistant executed bulk store purge (${
              targetScope === "both"
                ? `${deletedProductsCount} products & ${deletedBillsCount} bills`
                : targetScope === "products"
                ? `${deletedProductsCount} products`
                : `${deletedBillsCount} bills`
            })`,
            user.uid,
            user.displayName || "Admin",
            user.email || ""
          ).catch(() => {});
        }

        setMessages((prev) =>
          prev.map((msg) =>
            msg.id === messageId ? { ...msg, actionApplied: true } : msg
          )
        );

        triggerHaptic("success");
        if (onProductUpdated) onProductUpdated();
      }
    } catch (e: any) {
      console.error("Action execution failed:", e);
      setErrorMessage(`Action failed: ${e.message || e}`);
      triggerHaptic("heavy");
    } finally {
      setExecutingActionId(null);
    }
  };

  const handleClearHistory = () => {
    triggerHaptic("medium");
    stopAllSpeechPlayback();

    if (abortControllerRef.current) {
      try {
        abortControllerRef.current.abort();
      } catch {}
      abortControllerRef.current = null;
    }
    if (activeStopwatchRef.current !== null) {
      window.clearInterval(activeStopwatchRef.current);
      activeStopwatchRef.current = null;
    }
    if (activeWatchdogRef.current !== null) {
      window.clearTimeout(activeWatchdogRef.current);
      activeWatchdogRef.current = null;
    }
    activeAssistantMsgIdRef.current = null;
    setLoading(false);

    // Revoke any in-memory blob URLs from messages and pending attachments
    try {
      for (const m of messages) {
        for (const a of m.attachments || []) {
          if (a.previewUrl && a.previewUrl.startsWith("blob:")) {
            URL.revokeObjectURL(a.previewUrl);
          }
        }
      }
      for (const a of pendingAttachments) {
        if (a.previewUrl && a.previewUrl.startsWith("blob:")) {
          URL.revokeObjectURL(a.previewUrl);
        }
      }
    } catch {}

    // Clear all localStorage keys for this chat & any cached media
    try {
      localStorage.removeItem(currentAccountKey);
      const keysToRemove: string[] = [];
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && (k.startsWith("buzz_ai_chat_") || k.startsWith("buzz_chat_media_"))) {
          keysToRemove.push(k);
        }
      }
      keysToRemove.forEach((k) => localStorage.removeItem(k));
    } catch (e) {}

    // Delete any temporary AI RPC or media documents from Firestore settings collection & backend
    getDocs(collection(db, "settings"))
      .then((snap) => {
        snap.forEach((docSnap) => {
          const id = docSnap.id;
          if (
            id.startsWith("ai_rpc_req_") ||
            id.startsWith("chat_media_") ||
            id.startsWith("buzz_chat_")
          ) {
            deleteDoc(doc(db, "settings", id)).catch(() => {});
          }
        });
      })
      .catch(() => {});
    purgeChatMediaFromDatabase().catch(() => {});

    setPendingAttachments([]);
    setPreviewLightbox(null);
    setMessages([]);
    setInput("");
    setErrorMessage("");
    triggerHaptic("success");
    setClearToastMessage("New chat started · Uploaded media deleted");
    setTimeout(() => setClearToastMessage(""), 2600);
  };

  const handleCopyText = (id: string, text: string) => {
    navigator.clipboard?.writeText(text);
    setCopiedId(id);
    triggerHaptic("light");
    setTimeout(() => setCopiedId(null), 2000);
  };

  return (
    <AnimatePresence>
      {isOpen && (
        <div className="fixed inset-0 z-[120] flex flex-col bg-slate-50 dark:bg-[#070a13] text-slate-900 dark:text-slate-100 select-text overflow-hidden h-[100dvh] w-screen top-0 left-0 right-0 bottom-0">
          <motion.div
            initial={{ opacity: 0, y: 16, scale: 0.99 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{
              opacity: 0,
              y: 12,
              scale: 0.99,
              transition: { duration: 0.15, ease: [0.32, 0, 0.67, 0] },
            }}
            transition={{ type: "spring", stiffness: 520, damping: 36, mass: 0.62 }}
            className="w-full h-full flex flex-col bg-slate-50 dark:bg-[#070a13] text-slate-900 dark:text-slate-100 relative overflow-hidden transition-colors duration-300 transform-gpu"
          >
            {/* Ambient Lighting & Depth Texture (feather via radial gradient — no GPU blur pass) */}
            <div className="pointer-events-none absolute -top-32 left-1/2 -translate-x-1/2 w-[720px] h-[400px] bg-[radial-gradient(ellipse_at_center,rgba(99,102,241,0.14)_0%,rgba(168,85,247,0.06)_45%,transparent_72%)] dark:bg-[radial-gradient(ellipse_at_center,rgba(99,102,241,0.11)_0%,rgba(168,85,247,0.05)_45%,transparent_72%)] transform-gpu" />
            <div className="pointer-events-none absolute bottom-24 right-1/4 w-[500px] h-[300px] bg-[radial-gradient(ellipse_at_center,rgba(79,70,229,0.08)_0%,transparent_72%)] dark:bg-[radial-gradient(ellipse_at_center,rgba(79,70,229,0.07)_0%,transparent_72%)] transform-gpu" />
            <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(rgba(15,23,42,0.05)_1px,transparent_1px)] dark:bg-[radial-gradient(rgba(255,255,255,0.035)_1px,transparent_1px)] [background-size:26px_26px] opacity-50 dark:opacity-40" />

            {/* Refined Top Bar — padded below mobile status bar (clock, Wi-Fi, battery) */}
            <header className="px-3.5 sm:px-6 pt-[max(calc(env(safe-area-inset-top,0px)+0.75rem),2.75rem)] sm:pt-3.5 pb-3 border-b border-slate-200/80 dark:border-white/[0.07] flex items-center justify-between gap-3 sm:gap-4 shrink-0 bg-white dark:bg-[#090d18] relative z-20 [transform:translateZ(0)]">
              <div className="flex items-center gap-2.5 sm:gap-3 min-w-0 flex-1 overflow-hidden pr-1">
                <motion.div
                  initial={{ scale: 0.85, rotate: -10 }}
                  animate={{ scale: 1, rotate: 0 }}
                  transition={{ type: "spring", stiffness: 500, damping: 26 }}
                  className="relative w-8 h-8 sm:w-9 sm:h-9 rounded-xl sm:rounded-2xl bg-indigo-600 flex items-center justify-center text-white shadow-md shadow-indigo-500/25 shrink-0 overflow-hidden"
                >
                  <div className="absolute inset-0 bg-gradient-to-tr from-amber-400 via-indigo-500 to-purple-600" />
                  <Zap size={16} className="relative z-10 fill-white text-white" />
                </motion.div>
                <div className="min-w-0 flex-1 overflow-hidden">
                  <div className="flex items-center gap-2 min-w-0">
                    <span className="text-sm sm:text-base font-extrabold tracking-tight text-slate-900 dark:text-white leading-none truncate">
                      Buzz AI
                    </span>
                  </div>
                  <p className="text-[9.5px] sm:text-[11px] text-slate-500 dark:text-slate-400 font-medium tracking-tight leading-tight mt-0.5 truncate">
                    Store Operations & Inventory
                  </p>
                </div>
              </div>

              <div className="flex items-center gap-1.5 sm:gap-2 shrink-0">
                <input
                  ref={mediaFileInputRef}
                  type="file"
                  accept="image/*,video/*"
                  multiple
                  onChange={handleMediaFileSelect}
                  className="hidden"
                />
                <motion.button
                  whileHover={{ scale: 1.03 }}
                  whileTap={{ scale: 0.94 }}
                  transition={{ type: "spring", stiffness: 520, damping: 28 }}
                  onClick={handleClearHistory}
                  title="Start a new chat"
                  className="h-8 sm:h-9 px-2.5 sm:px-3 rounded-xl flex items-center gap-1.5 text-[11px] sm:text-xs font-semibold text-slate-700 dark:text-slate-200 hover:text-slate-950 dark:hover:text-white bg-slate-100/90 dark:bg-white/[0.05] hover:bg-slate-200/80 dark:hover:bg-white/[0.1] border border-slate-200/90 dark:border-white/[0.08] transition-colors cursor-pointer whitespace-nowrap shrink-0"
                >
                  <RotateCcw size={12} className="text-indigo-600 dark:text-indigo-400 shrink-0" />
                  <span>New Chat</span>
                </motion.button>
                <motion.button
                  whileHover={{ scale: 1.06, rotate: 90 }}
                  whileTap={{ scale: 0.9 }}
                  transition={{ type: "spring", stiffness: 520, damping: 28 }}
                  onClick={() => {
                    triggerHaptic("light");
                    stopAllSpeechPlayback();
                    onClose();
                  }}
                  title="Close"
                  className="w-8 h-8 sm:w-9 sm:h-9 rounded-xl flex items-center justify-center bg-slate-100/90 dark:bg-white/[0.05] text-slate-600 dark:text-slate-300 hover:bg-slate-200/80 dark:hover:bg-white/[0.1] hover:text-slate-950 dark:hover:text-white transition-colors border border-slate-200/90 dark:border-white/[0.08] cursor-pointer shrink-0"
                >
                  <X size={15} />
                </motion.button>
              </div>
            </header>

        {/* Floating Clear Confirmation Toast */}
        <AnimatePresence>
          {clearToastMessage && (
            <motion.div
              initial={{ opacity: 0, y: -12, scale: 0.96 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: -10, scale: 0.96 }}
              transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }}
              className="pointer-events-none absolute top-[104px] sm:top-[68px] left-1/2 -translate-x-1/2 z-30 max-w-[92vw]"
            >
              <div className="flex items-center gap-2.5 px-3.5 py-2 rounded-xl bg-white/95 dark:bg-[#0d1322]/95 backdrop-blur-xl border border-emerald-500/35 dark:border-emerald-500/25 shadow-lg dark:shadow-[0_12px_32px_-8px_rgba(0,0,0,0.7),0_0_24px_-6px_rgba(16,185,129,0.22)] whitespace-nowrap">
                <div className="w-5 h-5 rounded-lg bg-emerald-500/15 border border-emerald-500/30 flex items-center justify-center text-emerald-600 dark:text-emerald-400 shrink-0">
                  <Check size={12} strokeWidth={2.75} />
                </div>
                <div className="flex items-center gap-1.5 text-xs">
                  <span className="font-semibold text-slate-900 dark:text-white tracking-tight">
                    New chat started
                  </span>
                  <span className="text-slate-400 dark:text-slate-600" aria-hidden="true">
                    ·
                  </span>
                  <span className="text-[11px] font-medium text-emerald-600 dark:text-emerald-400/90">
                    Context cleared
                  </span>
                </div>
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        {/* Messages Stream */}
        <div
          ref={chatContainerRef}
          onScroll={handleContainerScroll}
          onContextMenu={(e) => {
            e.preventDefault();
          }}
          className="flex-1 overflow-y-auto p-4 sm:p-6 space-y-6 custom-scrollbar relative z-10 isolate overscroll-y-contain [overflow-anchor:auto] touch-pan-y [-webkit-overflow-scrolling:touch]"
        >
          <div className="max-w-4xl mx-auto w-full space-y-6">
            {messages.map((msg) => {
              const isUser = msg.role === "user";

              if (isUser) {
                const hasMedia = Boolean(msg.attachments && msg.attachments.length > 0);
                const hasText = Boolean(msg.content && msg.content.trim().length > 0);
                const attCount = msg.attachments?.length || 0;
                const formattedTime = new Date(msg.timestamp).toLocaleTimeString([], {
                  hour: "2-digit",
                  minute: "2-digit",
                });

                return (
                  <motion.div
                    key={msg.id}
                    initial={{ opacity: 0, y: 14, scale: 0.96 }}
                    animate={{ opacity: 1, y: 0, scale: 1 }}
                    transition={{ type: "spring", stiffness: 480, damping: 32, mass: 0.65 }}
                    className="flex flex-col items-end gap-1.5 origin-bottom-right"
                  >
                    {hasMedia && msg.attachments && (
                      <div
                        className={`relative group/collage overflow-hidden transition-all ${
                          attCount === 1
                            ? "max-w-[235px] sm:max-w-[275px] rounded-[22px] p-1 bg-white/90 dark:bg-slate-900/90 border border-slate-200/80 dark:border-white/12 shadow-lg shadow-indigo-950/15"
                            : "w-[252px] sm:w-[292px] rounded-[22px] p-1.5 bg-white/90 dark:bg-slate-900/90 border border-slate-200/80 dark:border-white/12 shadow-lg shadow-indigo-950/15"
                        }`}
                      >
                        <div
                          className={`grid gap-1.5 ${
                            attCount === 1 ? "grid-cols-1" : "grid-cols-2"
                          }`}
                        >
                          {msg.attachments.map((att, attIdx) => {
                            const isThreeHero = attCount === 3 && attIdx === 0;
                            const resolvedSrc =
                              att.previewUrl ||
                              (att.dataBase64
                                ? `data:${att.mimeType || "image/jpeg"};base64,${att.dataBase64}`
                                : "");
                            return (
                              <motion.div
                                key={att.id}
                                role="button"
                                tabIndex={0}
                                whileHover={{ scale: 0.985 }}
                                whileTap={{ scale: 0.95 }}
                                transition={{ type: "spring", stiffness: 520, damping: 30 }}
                                onClick={(e) => {
                                  e.stopPropagation();
                                  triggerHaptic("light");
                                  setPreviewLightbox({
                                    attachments: (msg.attachments || []).map((item) => ({
                                      ...item,
                                      previewUrl:
                                        item.previewUrl ||
                                        (item.dataBase64
                                          ? `data:${item.mimeType || "image/jpeg"};base64,${item.dataBase64}`
                                          : ""),
                                    })),
                                    index: attIdx,
                                  });
                                }}
                                onKeyDown={(e) => {
                                  if (e.key === "Enter" || e.key === " ") {
                                    e.preventDefault();
                                    setPreviewLightbox({
                                      attachments: (msg.attachments || []).map((item) => ({
                                        ...item,
                                        previewUrl:
                                          item.previewUrl ||
                                          (item.dataBase64
                                            ? `data:${item.mimeType || "image/jpeg"};base64,${item.dataBase64}`
                                            : ""),
                                      })),
                                      index: attIdx,
                                    });
                                  }
                                }}
                                className={`relative overflow-hidden rounded-[17px] bg-slate-900/95 ring-1 ring-black/5 dark:ring-white/10 cursor-pointer group/tile ${
                                  attCount === 1
                                    ? "max-h-[250px] min-h-[110px] w-full flex items-center justify-center"
                                    : isThreeHero
                                    ? "col-span-2 aspect-[16/9] w-full"
                                    : "aspect-square w-full"
                                }`}
                              >
                                {att.kind === "video" ? (
                                  <div
                                    className="relative w-full h-full flex items-center justify-center"
                                    onClick={(e) => {
                                      if (!resolvedSrc.startsWith("data:image/")) {
                                        e.stopPropagation();
                                      }
                                    }}
                                  >
                                    {resolvedSrc.startsWith("data:image/") ? (
                                      <img
                                        src={resolvedSrc}
                                        alt={att.name}
                                        loading="lazy"
                                        className={
                                          attCount === 1
                                            ? "max-h-[250px] w-full object-cover rounded-[17px]"
                                            : "w-full h-full object-cover"
                                        }
                                      />
                                    ) : (
                                      <video
                                        src={resolvedSrc}
                                        controls
                                        playsInline
                                        className={
                                          attCount === 1
                                            ? "max-h-[250px] w-full object-cover rounded-[17px]"
                                            : "w-full h-full object-cover"
                                        }
                                      />
                                    )}
                                    <div className="pointer-events-none absolute top-2 left-2 px-1.5 py-0.5 rounded-md bg-black/65 backdrop-blur-md text-[9px] font-bold text-white flex items-center gap-1 border border-white/15">
                                      <Film size={9} />
                                      <span>VIDEO</span>
                                    </div>
                                  </div>
                                ) : (
                                  <>
                                    <img
                                      src={resolvedSrc}
                                      alt={att.name}
                                      loading="lazy"
                                      className={
                                        attCount === 1
                                          ? "max-h-[250px] w-full object-cover transition-transform duration-300 group-hover/tile:scale-105"
                                          : "w-full h-full object-cover transition-transform duration-300 group-hover/tile:scale-105"
                                      }
                                    />
                                    <div className="pointer-events-none absolute inset-0 bg-gradient-to-t from-black/40 via-transparent to-black/10 opacity-85 group-hover/tile:opacity-100 transition-opacity duration-200 flex items-end justify-end p-2">
                                      <div className="w-6 h-6 rounded-full bg-black/60 backdrop-blur-md text-white flex items-center justify-center border border-white/20 shadow-sm">
                                        <Maximize2 size={11} />
                                      </div>
                                    </div>
                                  </>
                                )}
                              </motion.div>
                            );
                          })}
                        </div>

                        {!hasText && (
                          <div className="pointer-events-none absolute bottom-2.5 right-2.5 px-2 py-0.5 rounded-full bg-black/60 backdrop-blur-md border border-white/15 shadow-sm">
                            <span className="text-[9px] font-semibold text-white/95 font-mono">
                              {formattedTime}
                            </span>
                          </div>
                        )}
                      </div>
                    )}

                    {msg.quotedText && !hasText && (
                      <div className="w-fit max-w-[86%] sm:max-w-[74%] rounded-[22px] rounded-br-xs p-1.5 bg-gradient-to-br from-indigo-600 via-indigo-600 to-violet-700 text-white shadow-lg shadow-indigo-600/25 dark:shadow-indigo-950/40 border border-indigo-400/35 break-words [overflow-wrap:anywhere] [word-break:break-word] overflow-hidden min-w-[150px]">
                        <div className="relative overflow-hidden rounded-[16px] bg-slate-950/65 dark:bg-[#080c18]/90 border border-white/15 px-3 py-2 shadow-inner">
                          <div className="absolute left-0 top-0 bottom-0 w-1 bg-gradient-to-b from-amber-300 via-indigo-300 to-purple-400" />
                          <div className="flex items-center justify-between gap-2 mb-1 pl-1.5">
                            <div className="flex items-center gap-1.5 min-w-0">
                              <span className="w-4 h-4 rounded-md bg-indigo-400/20 border border-indigo-300/30 flex items-center justify-center shrink-0">
                                <Quote size={9} className="text-indigo-200 rotate-180" />
                              </span>
                              <span className="text-[10px] font-extrabold uppercase tracking-wider text-indigo-200/95">
                                Buzz AI
                              </span>
                              <span className="text-[9px] font-medium text-white/45">• Quoted</span>
                            </div>
                            <span className="text-[9px] font-medium text-indigo-100/75 font-mono shrink-0">
                              {formattedTime}
                            </span>
                          </div>
                          <p className="pl-1.5 text-[11px] sm:text-xs leading-relaxed text-indigo-50/95 line-clamp-3 font-normal italic break-words [overflow-wrap:anywhere] [word-break:break-word] text-left">
                            "{msg.quotedText}"
                          </p>
                        </div>
                      </div>
                    )}

                    {hasText && (() => {
                      const isLongUserMsg =
                        msg.content.length > 140 ||
                        msg.content.split("\n").length > 4 ||
                        (/\S{28,}/.test(msg.content) && msg.content.length > 55);
                      const isUserExpanded = Boolean(expandedMessages[msg.id]);
                      const displayedUserText =
                        isLongUserMsg && !isUserExpanded
                          ? `${msg.content.slice(0, 110).trimEnd()}…`
                          : msg.content;

                      return (
                        <div
                          className={`w-fit max-w-[86%] sm:max-w-[74%] ${
                            msg.quotedText
                              ? "rounded-[22px] rounded-br-xs p-1.5 min-w-[165px]"
                              : `${
                                  hasMedia ? "rounded-2xl rounded-tr-md rounded-br-xs" : "rounded-2xl rounded-br-xs"
                                } px-3.5 py-2 sm:px-4 sm:py-2.5`
                          } bg-gradient-to-br from-indigo-600 via-indigo-600 to-violet-700 text-white shadow-lg shadow-indigo-600/20 dark:shadow-indigo-950/35 border border-indigo-400/35 break-words [overflow-wrap:anywhere] [word-break:break-word] overflow-hidden min-w-0`}
                        >
                          {msg.quotedText && (
                            <div className="relative overflow-hidden rounded-[15px] bg-slate-950/65 dark:bg-[#080c18]/90 border border-white/15 px-3 py-2 mb-1 shadow-inner">
                              <div className="absolute left-0 top-0 bottom-0 w-1 bg-gradient-to-b from-amber-300 via-indigo-300 to-purple-400" />
                              <div className="flex items-center gap-1.5 mb-0.5 pl-1.5">
                                <span className="w-4 h-4 rounded-md bg-indigo-400/20 border border-indigo-300/30 flex items-center justify-center shrink-0">
                                  <Quote size={9} className="text-indigo-200 rotate-180" />
                                </span>
                                <span className="text-[10px] font-extrabold uppercase tracking-wider text-indigo-200/95">
                                  Buzz AI
                                </span>
                                <span className="text-[9px] font-medium text-white/45">• Quoted</span>
                              </div>
                              <p className="pl-1.5 text-[11px] sm:text-xs leading-snug text-indigo-50/90 line-clamp-3 font-normal italic break-words [overflow-wrap:anywhere] [word-break:break-word] text-left">
                                "{msg.quotedText}"
                              </p>
                            </div>
                          )}
                          <div
                            className={`flex flex-col min-w-0 max-w-full ${
                              msg.quotedText ? "px-2.5 pt-1 pb-1" : ""
                            }`}
                          >
                            <div className="flex items-end gap-2.5 flex-wrap justify-between min-w-0 max-w-full">
                              <div
                                data-selectable-message-body="true"
                                className="text-xs sm:text-sm leading-relaxed whitespace-pre-wrap font-semibold break-words [overflow-wrap:anywhere] [word-break:break-word] text-left min-w-0 max-w-full"
                              >
                                {displayedUserText}
                              </div>
                              {!isLongUserMsg && (
                                <span
                                  data-no-chat-select="true"
                                  className="text-[9px] font-medium text-indigo-100/80 dark:text-indigo-200/75 font-mono shrink-0 translate-y-0.5 select-none [-webkit-user-select:none] ml-auto"
                                >
                                  {formattedTime}
                                </span>
                              )}
                            </div>
                            {isLongUserMsg && (
                              <div
                                data-no-chat-select="true"
                                className="flex items-center justify-between gap-3 mt-1.5 pt-1 border-t border-white/15 select-none [-webkit-user-select:none]"
                              >
                                <button
                                  type="button"
                                  onClick={() => toggleExpandMessage(msg.id)}
                                  className="inline-flex items-center gap-1 text-[10px] font-bold text-indigo-100 hover:text-white bg-white/10 hover:bg-white/20 px-2 py-0.5 rounded-full transition-colors cursor-pointer select-none [-webkit-user-select:none]"
                                >
                                  {isUserExpanded ? (
                                    <>
                                      <ChevronUp size={11} />
                                      <span>See less</span>
                                    </>
                                  ) : (
                                    <>
                                      <ChevronDown size={11} />
                                      <span>See more</span>
                                    </>
                                  )}
                                </button>
                                <span className="text-[9px] font-medium text-indigo-100/80 dark:text-indigo-200/75 font-mono shrink-0 select-none [-webkit-user-select:none]">
                                  {formattedTime}
                                </span>
                              </div>
                            )}
                          </div>
                        </div>
                      );
                    })()}
                  </motion.div>
                );
              }

              return (
                <motion.div
                  key={msg.id}
                  initial={{ opacity: 0, y: 14, scale: 0.97 }}
                  animate={{ opacity: 1, y: 0, scale: 1 }}
                  transition={{ type: "spring", stiffness: 460, damping: 32, mass: 0.68 }}
                  className="flex flex-col items-start gap-1.5 w-full max-w-full min-w-0 origin-top-left"
                >
                  <div
                    data-no-chat-select="true"
                    className="flex items-center gap-2 mb-0.5 pl-1 text-[11px] select-none [-webkit-user-select:none] [-webkit-touch-callout:none]"
                  >
                    <div className="relative w-5 h-5 rounded-lg bg-indigo-600 flex items-center justify-center text-white shadow-xs overflow-hidden">
                      <div className="absolute inset-0 bg-gradient-to-tr from-amber-400 via-indigo-500 to-purple-600" />
                      <Zap size={11} className="relative z-10 fill-white text-white" />
                    </div>
                    <span className="font-extrabold text-indigo-600 dark:text-indigo-300">
                      Buzz AI
                    </span>
                    <span className="text-[10px] text-slate-400 dark:text-slate-500 font-mono">
                      {new Date(msg.timestamp).toLocaleTimeString([], {
                        hour: "2-digit",
                        minute: "2-digit",
                      })}
                    </span>
                  </div>

                  <div className={`${msg.action ? "w-full sm:max-w-[430px]" : "w-fit max-w-[96%] sm:max-w-[88%]"} rounded-2xl rounded-tl-xs p-3.5 sm:p-4 bg-white dark:bg-[#0f172a] dark:bg-gradient-to-b dark:from-slate-900 dark:via-slate-900 dark:to-slate-950 border border-slate-200/90 dark:border-slate-700/70 text-slate-800 dark:text-slate-100 shadow-lg shadow-slate-900/[0.04] dark:shadow-xl dark:shadow-black/40 relative overflow-hidden break-words [overflow-wrap:anywhere] [word-break:break-word] min-w-0 [backface-visibility:hidden]`}>
                    {/* While Streaming: Compact Thinking Indicator with Live Stopwatch */}
                    {msg.isStreaming && !msg.content && (
                      <div
                        data-no-chat-select="true"
                        className="flex items-center gap-2.5 py-0.5 px-0.5 select-none [-webkit-user-select:none] [-webkit-touch-callout:none]"
                      >
                        <div className="relative w-7 h-7 rounded-xl bg-indigo-500/15 border border-indigo-400/30 flex items-center justify-center shrink-0 overflow-hidden">
                          <Sparkles size={13} className="text-indigo-500 dark:text-indigo-300 animate-pulse" />
                        </div>

                        <div className="flex items-center gap-2 min-w-0">
                          <span className="text-xs font-bold text-slate-700 dark:text-slate-200 tracking-tight">
                            Thinking
                          </span>
                          <span className="inline-flex items-center gap-1">
                            {[0, 1, 2].map((dotIdx) => (
                              <motion.span
                                key={dotIdx}
                                animate={{
                                  y: [0, -3, 0],
                                  opacity: [0.35, 1, 0.35],
                                }}
                                transition={{
                                  duration: 0.85,
                                  repeat: Infinity,
                                  delay: dotIdx * 0.16,
                                  ease: "easeInOut",
                                }}
                                className="w-1 h-1 rounded-full bg-indigo-500 dark:bg-indigo-400"
                              />
                            ))}
                          </span>
                          <span className="ml-1 px-2 py-0.5 rounded-md bg-indigo-500/10 dark:bg-indigo-500/20 border border-indigo-500/25 text-[11px] font-mono font-bold tabular-nums text-indigo-600 dark:text-indigo-300 inline-flex items-center justify-center min-w-[30px] overflow-hidden">
                            <AnimatePresence mode="popLayout" initial={false}>
                              <motion.span
                                key={msg.thoughtDuration ?? 0}
                                initial={{ opacity: 0, y: 5 }}
                                animate={{ opacity: 1, y: 0 }}
                                exit={{ opacity: 0, y: -5 }}
                                transition={{ duration: 0.14, ease: [0.22, 1, 0.36, 1] }}
                                className="inline-block"
                              >
                                {msg.thoughtDuration ?? 0}s
                              </motion.span>
                            </AnimatePresence>
                          </span>
                        </div>
                      </div>
                    )}

                    {/* Formatted Markdown Content with progressive word-by-word streaming cursor */}
                    <div
                      data-selectable-message-body="true"
                      className="text-xs sm:text-[13px] leading-relaxed break-words [overflow-wrap:anywhere] [word-break:break-word] min-w-0 max-w-full w-full"
                    >
                      <MarkdownContent
                        text={msg.content}
                        isStreaming={Boolean(msg.isStreaming)}
                      />
                    </div>

                    {/* Interactive Action Confirmation Card (animates and fills in once words complete) */}
                    {!msg.isStreaming && msg.action && (
                      <motion.div
                        data-no-chat-select="true"
                        initial={{ opacity: 0, y: 10, scale: 0.98 }}
                        animate={{ opacity: 1, y: 0, scale: 1 }}
                        transition={{ type: "spring", stiffness: 460, damping: 30, mass: 0.7 }}
                        className="mt-3.5 pt-3 border-t border-slate-200/80 dark:border-slate-800/80 w-full select-none [-webkit-user-select:none] [-webkit-touch-callout:none]"
                      >
                        {/* 1. UPDATE_STOCK */}
                        {msg.action.type === "UPDATE_STOCK" && (() => {
                          const qtyDelta =
                            msg.action.quantityChange !== undefined
                              ? Number(msg.action.quantityChange)
                              : msg.action.currentStock !== undefined && msg.action.newStock !== undefined
                              ? Number(msg.action.newStock) - Number(msg.action.currentStock)
                              : undefined;
                          return (
                            <div className="rounded-2xl bg-gradient-to-b from-indigo-50/90 via-white to-indigo-50/40 dark:from-indigo-950/60 dark:via-slate-900/95 dark:to-slate-950 border border-indigo-200/90 dark:border-indigo-500/30 shadow-md shadow-indigo-950/5 dark:shadow-indigo-950/40 overflow-hidden">
                              {/* Header */}
                              <div className="flex items-center justify-between gap-2 px-3.5 py-2.5 bg-indigo-500/[0.06] dark:bg-indigo-500/[0.08] border-b border-indigo-200/70 dark:border-indigo-500/20">
                                <div className="flex items-center gap-2.5 min-w-0">
                                  <div className="w-7 h-7 rounded-xl bg-indigo-500/15 dark:bg-indigo-500/25 flex items-center justify-center text-indigo-600 dark:text-indigo-300 shrink-0 border border-indigo-400/30 shadow-2xs">
                                    <Package size={14} />
                                  </div>
                                  <div className="min-w-0">
                                    <span className="text-xs font-extrabold tracking-tight text-slate-900 dark:text-white block leading-tight">
                                      Stock Adjustment
                                    </span>
                                    <span className="text-[10px] font-medium text-indigo-600/80 dark:text-indigo-300/70 block leading-tight mt-0.5">
                                      Inventory Ledger
                                    </span>
                                  </div>
                                </div>
                                {msg.actionApplied ? (
                                  <span className="inline-flex items-center gap-1 text-[10px] font-bold text-emerald-700 dark:text-emerald-300 bg-emerald-500/15 px-2 py-0.5 rounded-md border border-emerald-500/30 shrink-0">
                                    <CheckCircle2 size={10} />
                                    Applied
                                  </span>
                                ) : (
                                  <span className="inline-flex items-center gap-1.5 text-[10px] font-bold text-indigo-700 dark:text-indigo-300 bg-indigo-500/15 px-2 py-0.5 rounded-md border border-indigo-500/30 shrink-0">
                                    <span className="w-1.5 h-1.5 rounded-full bg-indigo-500 dark:bg-indigo-400 animate-pulse" />
                                    Ready
                                  </span>
                                )}
                              </div>

                              {/* Structured Data Rows */}
                              <div className="p-3 space-y-2.5">
                                <div className="rounded-xl bg-white/95 dark:bg-slate-950/85 border border-slate-200/80 dark:border-slate-800/90 divide-y divide-slate-200/70 dark:divide-slate-800/80 overflow-hidden">
                                  <div className="flex items-center justify-between gap-3 px-3 py-2.5">
                                    <span className="text-[11px] font-semibold text-slate-500 dark:text-slate-400 shrink-0">
                                      Catalog Item
                                    </span>
                                    <span className="text-xs sm:text-sm font-extrabold text-slate-900 dark:text-white text-right break-words min-w-0">
                                      {msg.action.productName || "Product"}
                                    </span>
                                  </div>

                                  <div className="flex items-center justify-between gap-2 px-3 py-2.5 bg-slate-50/60 dark:bg-slate-900/50">
                                    <div className="flex items-center gap-1.5 shrink-0">
                                      <span className="text-[11px] font-semibold text-slate-500 dark:text-slate-400">
                                        New Stock
                                      </span>
                                      {qtyDelta !== undefined && !Number.isNaN(qtyDelta) && (
                                        <span
                                          className={`text-[10px] font-mono font-extrabold px-1.5 py-0.5 rounded ${
                                            qtyDelta >= 0
                                              ? "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 border border-emerald-500/25"
                                              : "bg-amber-500/15 text-amber-600 dark:text-amber-400 border border-amber-500/25"
                                          }`}
                                        >
                                          {qtyDelta > 0 ? `+${qtyDelta}` : qtyDelta}
                                        </span>
                                      )}
                                    </div>

                                    <div className="flex items-center gap-1.5 font-mono tabular-nums flex-wrap justify-end">
                                      <span className="text-xs font-semibold text-slate-400 dark:text-slate-500 px-1.5 py-0.5 rounded bg-slate-200/60 dark:bg-slate-800/70">
                                        {msg.action.currentStock ?? "—"}
                                      </span>
                                      <span className="text-indigo-500 dark:text-indigo-400 text-xs font-black">
                                        →
                                      </span>
                                      <span className="text-xs sm:text-sm font-black text-indigo-700 dark:text-indigo-300 bg-indigo-500/10 dark:bg-indigo-500/20 border border-indigo-500/25 px-2 py-0.5 rounded-md">
                                        {msg.action.newStock}{" "}
                                        <span className="text-[10px] font-sans font-semibold opacity-80">
                                          units
                                        </span>
                                      </span>
                                    </div>
                                  </div>
                                </div>

                                {!msg.actionApplied ? (
                                  <button
                                    disabled={executingActionId === msg.id}
                                    onClick={() => handleExecuteAction(msg.id, msg.action!)}
                                    className="w-full py-2.5 px-3.5 bg-gradient-to-r from-indigo-600 via-indigo-500 to-violet-600 hover:from-indigo-500 hover:to-violet-500 active:scale-[0.98] text-white font-bold rounded-xl text-xs flex items-center justify-center gap-2 shadow-md shadow-indigo-600/25 transition-all cursor-pointer border border-indigo-400/25"
                                  >
                                    {executingActionId === msg.id ? (
                                      <>
                                        <RefreshCw size={13} className="animate-spin shrink-0" />
                                        <span>Applying Stock Update...</span>
                                      </>
                                    ) : (
                                      <>
                                        <CheckCircle2 size={14} className="shrink-0" />
                                        <span>Confirm Stock Update</span>
                                      </>
                                    )}
                                  </button>
                                ) : (
                                  <div className="flex items-center justify-center gap-2 py-2 px-3 rounded-xl bg-emerald-500/10 border border-emerald-500/25 text-emerald-700 dark:text-emerald-300 text-xs font-semibold">
                                    <CheckCircle2 size={13} className="text-emerald-600 dark:text-emerald-400 shrink-0" />
                                    <span>Stock updated in live catalog</span>
                                  </div>
                                )}
                              </div>
                            </div>
                          );
                        })()}

                        {/* 2. UPDATE_PRICE */}
                        {msg.action.type === "UPDATE_PRICE" && (() => {
                          const priceDelta =
                            msg.action.currentPrice !== undefined && msg.action.newPrice !== undefined
                              ? Number(msg.action.newPrice) - Number(msg.action.currentPrice)
                              : undefined;
                          return (
                            <div className="rounded-2xl bg-gradient-to-b from-blue-50/90 via-white to-blue-50/40 dark:from-blue-950/60 dark:via-slate-900/95 dark:to-slate-950 border border-blue-200/90 dark:border-blue-500/30 shadow-md shadow-blue-950/5 dark:shadow-blue-950/40 overflow-hidden">
                              {/* Header */}
                              <div className="flex items-center justify-between gap-2 px-3.5 py-2.5 bg-blue-500/[0.06] dark:bg-blue-500/[0.08] border-b border-blue-200/70 dark:border-blue-500/20">
                                <div className="flex items-center gap-2.5 min-w-0">
                                  <div className="w-7 h-7 rounded-xl bg-blue-500/15 dark:bg-blue-500/25 flex items-center justify-center text-blue-600 dark:text-blue-300 shrink-0 border border-blue-400/30 shadow-2xs">
                                    <Tag size={14} />
                                  </div>
                                  <div className="min-w-0">
                                    <span className="text-xs font-extrabold tracking-tight text-slate-900 dark:text-white block leading-tight">
                                      Price Update
                                    </span>
                                    <span className="text-[10px] font-medium text-blue-600/80 dark:text-blue-300/70 block leading-tight mt-0.5">
                                      Catalog Pricing
                                    </span>
                                  </div>
                                </div>
                                {msg.actionApplied ? (
                                  <span className="inline-flex items-center gap-1 text-[10px] font-bold text-emerald-700 dark:text-emerald-300 bg-emerald-500/15 px-2 py-0.5 rounded-md border border-emerald-500/30 shrink-0">
                                    <CheckCircle2 size={10} />
                                    Applied
                                  </span>
                                ) : (
                                  <span className="inline-flex items-center gap-1.5 text-[10px] font-bold text-blue-700 dark:text-blue-300 bg-blue-500/15 px-2 py-0.5 rounded-md border border-blue-500/30 shrink-0">
                                    <span className="w-1.5 h-1.5 rounded-full bg-blue-500 dark:bg-blue-400 animate-pulse" />
                                    Ready
                                  </span>
                                )}
                              </div>

                              {/* Structured Data Rows */}
                              <div className="p-3 space-y-2.5">
                                <div className="rounded-xl bg-white/95 dark:bg-slate-950/85 border border-slate-200/80 dark:border-slate-800/90 divide-y divide-slate-200/70 dark:divide-slate-800/80 overflow-hidden">
                                  <div className="flex items-center justify-between gap-3 px-3 py-2.5">
                                    <span className="text-[11px] font-semibold text-slate-500 dark:text-slate-400 shrink-0">
                                      Catalog Item
                                    </span>
                                    <span className="text-xs sm:text-sm font-extrabold text-slate-900 dark:text-white text-right break-words min-w-0">
                                      {msg.action.productName || "Product"}
                                    </span>
                                  </div>

                                  <div className="flex items-center justify-between gap-2 px-3 py-2.5 bg-slate-50/60 dark:bg-slate-900/50">
                                    <div className="flex items-center gap-1.5 shrink-0">
                                      <span className="text-[11px] font-semibold text-slate-500 dark:text-slate-400">
                                        Unit Price
                                      </span>
                                      {priceDelta !== undefined && !Number.isNaN(priceDelta) && priceDelta !== 0 && (
                                        <span
                                          className={`text-[10px] font-mono font-extrabold px-1.5 py-0.5 rounded ${
                                            priceDelta > 0
                                              ? "bg-blue-500/15 text-blue-600 dark:text-blue-400 border border-blue-500/25"
                                              : "bg-amber-500/15 text-amber-600 dark:text-amber-400 border border-amber-500/25"
                                          }`}
                                        >
                                          {priceDelta > 0 ? `+₹${priceDelta}` : `-₹${Math.abs(priceDelta)}`}
                                        </span>
                                      )}
                                    </div>

                                    <div className="flex items-center gap-1.5 font-mono tabular-nums flex-wrap justify-end">
                                      <span className="text-xs font-semibold text-slate-400 dark:text-slate-500 line-through px-1.5 py-0.5 rounded bg-slate-200/60 dark:bg-slate-800/70">
                                        ₹{msg.action.currentPrice ?? "—"}
                                      </span>
                                      <span className="text-blue-500 dark:text-blue-400 text-xs font-black">
                                        →
                                      </span>
                                      <span className="text-xs sm:text-sm font-black text-blue-700 dark:text-blue-300 bg-blue-500/10 dark:bg-blue-500/20 border border-blue-500/25 px-2 py-0.5 rounded-md">
                                        ₹{msg.action.newPrice}
                                      </span>
                                    </div>
                                  </div>
                                </div>

                                {!msg.actionApplied ? (
                                  <button
                                    disabled={executingActionId === msg.id}
                                    onClick={() => handleExecuteAction(msg.id, msg.action!)}
                                    className="w-full py-2.5 px-3.5 bg-gradient-to-r from-blue-600 via-blue-500 to-indigo-600 hover:from-blue-500 hover:to-indigo-500 active:scale-[0.98] text-white font-bold rounded-xl text-xs flex items-center justify-center gap-2 shadow-md shadow-blue-600/25 transition-all cursor-pointer border border-blue-400/25"
                                  >
                                    {executingActionId === msg.id ? (
                                      <>
                                        <RefreshCw size={13} className="animate-spin shrink-0" />
                                        <span>Updating Price...</span>
                                      </>
                                    ) : (
                                      <>
                                        <CheckCircle2 size={14} className="shrink-0" />
                                        <span>Confirm Price Change</span>
                                      </>
                                    )}
                                  </button>
                                ) : (
                                  <div className="flex items-center justify-center gap-2 py-2 px-3 rounded-xl bg-emerald-500/10 border border-emerald-500/25 text-emerald-700 dark:text-emerald-300 text-xs font-semibold">
                                    <CheckCircle2 size={13} className="text-emerald-600 dark:text-emerald-400 shrink-0" />
                                    <span>Price saved to store catalog</span>
                                  </div>
                                )}
                              </div>
                            </div>
                          );
                        })()}

                        {/* 2B. UPDATE_PRODUCT_IMAGE */}
                        {msg.action.type === "UPDATE_PRODUCT_IMAGE" && (() => {
                          const previewImg =
                            msg.action.image ||
                            resolveUploadedImageForAction(msg.action, [], messages, "")?.image ||
                            "";
                          return (
                            <div className="rounded-2xl bg-gradient-to-b from-violet-50/90 via-white to-violet-50/40 dark:from-violet-950/60 dark:via-slate-900/95 dark:to-slate-950 border border-violet-200/90 dark:border-violet-500/30 shadow-md shadow-violet-950/5 dark:shadow-violet-950/40 overflow-hidden">
                              <div className="flex items-center justify-between gap-2 px-3.5 py-2.5 bg-violet-500/[0.06] dark:bg-violet-500/[0.08] border-b border-violet-200/70 dark:border-violet-500/20">
                                <div className="flex items-center gap-2.5 min-w-0">
                                  <div className="w-7 h-7 rounded-xl bg-violet-500/15 dark:bg-violet-500/25 flex items-center justify-center text-violet-600 dark:text-violet-300 shrink-0 border border-violet-400/30 shadow-2xs">
                                    <ImageIcon size={14} />
                                  </div>
                                  <div className="min-w-0">
                                    <span className="text-xs font-extrabold tracking-tight text-slate-900 dark:text-white block leading-tight">
                                      Product Photo Update
                                    </span>
                                    <span className="text-[10px] font-medium text-violet-600/80 dark:text-violet-300/70 block leading-tight mt-0.5">
                                      Catalog Media
                                    </span>
                                  </div>
                                </div>
                                {msg.actionApplied ? (
                                  <span className="inline-flex items-center gap-1 text-[10px] font-bold text-emerald-700 dark:text-emerald-300 bg-emerald-500/15 px-2 py-0.5 rounded-md border border-emerald-500/30 shrink-0">
                                    <CheckCircle2 size={10} />
                                    Saved
                                  </span>
                                ) : (
                                  <span className="inline-flex items-center gap-1.5 text-[10px] font-bold text-violet-700 dark:text-violet-300 bg-violet-500/15 px-2 py-0.5 rounded-md border border-violet-500/30 shrink-0">
                                    <span className="w-1.5 h-1.5 rounded-full bg-violet-500 dark:bg-violet-400 animate-pulse" />
                                    Ready
                                  </span>
                                )}
                              </div>

                              <div className="p-3 space-y-2.5">
                                <div className="rounded-xl bg-white/95 dark:bg-slate-950/85 border border-slate-200/80 dark:border-slate-800/90 p-3 flex items-center justify-between gap-3">
                                  <div className="min-w-0 flex-1">
                                    <span className="text-[10px] font-semibold uppercase tracking-wider text-slate-400 dark:text-slate-500 block">
                                      Target Product
                                    </span>
                                    <span className="text-xs sm:text-sm font-extrabold text-slate-900 dark:text-white block break-words mt-0.5">
                                      {msg.action.productName || "Product"}
                                    </span>
                                    {msg.action.currentPrice !== undefined && (
                                      <span className="text-[11px] font-mono text-slate-500 dark:text-slate-400 block mt-0.5">
                                        ₹{msg.action.currentPrice} · {msg.action.currentStock ?? 0} units
                                      </span>
                                    )}
                                  </div>
                                  {previewImg && (
                                    <div className="w-14 h-14 rounded-xl overflow-hidden border border-violet-400/35 bg-slate-900 shrink-0 shadow-sm">
                                      <img
                                        src={previewImg}
                                        alt={msg.action.productName || "Product"}
                                        className="w-full h-full object-cover"
                                      />
                                    </div>
                                  )}
                                </div>

                                {!msg.actionApplied ? (
                                  <button
                                    disabled={executingActionId === msg.id}
                                    onClick={() => handleExecuteAction(msg.id, msg.action!)}
                                    className="w-full py-2.5 px-3.5 bg-gradient-to-r from-violet-600 via-indigo-600 to-purple-600 hover:from-violet-500 hover:to-purple-500 active:scale-[0.98] text-white font-bold rounded-xl text-xs flex items-center justify-center gap-2 shadow-md shadow-violet-600/25 transition-all cursor-pointer border border-violet-400/25"
                                  >
                                    {executingActionId === msg.id ? (
                                      <>
                                        <RefreshCw size={13} className="animate-spin shrink-0" />
                                        <span>Saving Product Photo...</span>
                                      </>
                                    ) : (
                                      <>
                                        <CheckCircle2 size={14} className="shrink-0" />
                                        <span>Confirm Product Photo</span>
                                      </>
                                    )}
                                  </button>
                                ) : (
                                  <div className="flex items-center justify-center gap-2 py-2 px-3 rounded-xl bg-emerald-500/10 border border-emerald-500/25 text-emerald-700 dark:text-emerald-300 text-xs font-semibold">
                                    <CheckCircle2 size={13} className="text-emerald-600 dark:text-emerald-400 shrink-0" />
                                    <span>Product photo updated in store catalog</span>
                                  </div>
                                )}
                              </div>
                            </div>
                          );
                        })()}

                        {/* 3. ADD_PRODUCT */}
                        {msg.action.type === "ADD_PRODUCT" && (() => {
                          const batchItems =
                            Array.isArray(msg.action.products) && msg.action.products.length > 0
                              ? msg.action.products
                              : [
                                  {
                                    name: msg.action.name || "Product",
                                    price: Number(msg.action.price) || 0,
                                    stock: Number(msg.action.stock) || 0,
                                    category: normalizeProductCategory(
                                      msg.action.category,
                                      msg.action.name
                                    ),
                                    image: msg.action.image,
                                  },
                                ];
                          const isBatch = batchItems.length > 1;

                          return (
                            <div className="rounded-2xl bg-white dark:bg-slate-900 bg-gradient-to-b from-emerald-50/90 via-white to-emerald-50/40 dark:from-emerald-950/60 dark:via-slate-900/95 dark:to-slate-950 border border-emerald-200/90 dark:border-emerald-500/30 shadow-md shadow-emerald-950/5 dark:shadow-emerald-950/40 overflow-hidden">
                              {/* Header */}
                              <div className="flex items-center justify-between gap-2 px-3.5 py-2.5 bg-emerald-500/[0.06] dark:bg-emerald-500/[0.08] border-b border-emerald-200/70 dark:border-emerald-500/20">
                                <div className="flex items-center gap-2.5 min-w-0">
                                  <div className="w-7 h-7 rounded-xl bg-emerald-500/15 dark:bg-emerald-500/25 flex items-center justify-center text-emerald-600 dark:text-emerald-300 shrink-0 border border-emerald-400/30 shadow-2xs">
                                    <PlusCircle size={14} />
                                  </div>
                                  <div className="min-w-0">
                                    <span className="text-xs font-extrabold tracking-tight text-slate-900 dark:text-white block leading-tight">
                                      {isBatch ? `Add ${batchItems.length} Products` : "New Catalog Product"}
                                    </span>
                                    <span className="text-[10px] font-medium text-emerald-600/80 dark:text-emerald-300/70 block leading-tight mt-0.5">
                                      Store Catalog Addition
                                    </span>
                                  </div>
                                </div>
                                {msg.actionApplied ? (
                                  <span className="inline-flex items-center gap-1 text-[10px] font-bold text-emerald-700 dark:text-emerald-300 bg-emerald-500/15 px-2 py-0.5 rounded-md border border-emerald-500/30 shrink-0">
                                    <CheckCircle2 size={10} />
                                    {isBatch ? `Added (${batchItems.length})` : "Created"}
                                  </span>
                                ) : (
                                  <span className="inline-flex items-center gap-1.5 text-[10px] font-bold text-emerald-700 dark:text-emerald-300 bg-emerald-500/15 px-2 py-0.5 rounded-md border border-emerald-500/30 shrink-0">
                                    <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 dark:bg-emerald-400 animate-pulse" />
                                    Ready
                                  </span>
                                )}
                              </div>

                              {/* Structured Data Rows */}
                              <div className="p-3 space-y-2.5">
                                <div className="rounded-xl bg-white/95 dark:bg-slate-950/85 border border-slate-200/80 dark:border-slate-800/90 divide-y divide-slate-200/70 dark:divide-slate-800/80 overflow-hidden">
                                  {batchItems.map((item, idx) => {
                                    const itemPreviewImg = item.image || msg.action?.image;
                                    return (
                                      <div
                                        key={`${item.name}-${idx}`}
                                        className="flex items-center justify-between gap-2.5 px-3 py-2.5"
                                      >
                                        <div className="flex items-center gap-2.5 min-w-0 flex-1">
                                          {itemPreviewImg && (
                                            <div className="w-10 h-10 rounded-lg overflow-hidden border border-emerald-500/30 bg-slate-900 shrink-0">
                                              <img
                                                src={itemPreviewImg}
                                                alt={item.name}
                                                className="w-full h-full object-cover"
                                              />
                                            </div>
                                          )}
                                          <div className="min-w-0 flex-1">
                                            <span className="text-xs sm:text-sm font-extrabold text-slate-900 dark:text-white block break-words">
                                              {item.name}
                                            </span>
                                            <span className="text-[10px] font-semibold text-slate-400 dark:text-slate-500 block mt-0.5">
                                              {item.category || "fresh"}
                                            </span>
                                          </div>
                                        </div>
                                        <div className="flex items-center gap-1.5 shrink-0 font-mono tabular-nums text-xs">
                                          <span className="px-2 py-0.5 rounded-md bg-emerald-500/10 dark:bg-emerald-500/20 border border-emerald-500/25 font-black text-emerald-700 dark:text-emerald-300">
                                            ₹{item.price}
                                          </span>
                                          <span className="px-2 py-0.5 rounded-md bg-slate-100 dark:bg-slate-900 border border-slate-200/80 dark:border-slate-800 font-semibold text-slate-600 dark:text-slate-300">
                                            {item.stock ?? 0}{" "}
                                            <span className="text-[10px] font-sans opacity-80">units</span>
                                          </span>
                                        </div>
                                      </div>
                                    );
                                  })}
                                </div>

                                {!msg.actionApplied ? (
                                  <button
                                    disabled={executingActionId === msg.id}
                                    onClick={() => handleExecuteAction(msg.id, msg.action!)}
                                    className="w-full py-2.5 px-3.5 bg-gradient-to-r from-emerald-600 via-emerald-500 to-teal-600 hover:from-emerald-500 hover:to-teal-500 active:scale-[0.98] text-white font-bold rounded-xl text-xs flex items-center justify-center gap-2 shadow-md shadow-emerald-600/25 transition-all cursor-pointer border border-emerald-400/25"
                                  >
                                    {executingActionId === msg.id ? (
                                      <>
                                        <RefreshCw size={13} className="animate-spin shrink-0" />
                                        <span>
                                          {isBatch
                                            ? `Adding ${batchItems.length} Products...`
                                            : "Adding Product..."}
                                        </span>
                                      </>
                                    ) : (
                                      <>
                                        <PlusCircle size={14} className="shrink-0" />
                                        <span>
                                          {isBatch
                                            ? `Create ${batchItems.length} Products in Store`
                                            : "Create Product in Store"}
                                        </span>
                                      </>
                                    )}
                                  </button>
                                ) : (
                                  <div className="flex items-center justify-center gap-2 py-2 px-3 rounded-xl bg-emerald-500/10 border border-emerald-500/25 text-emerald-700 dark:text-emerald-300 text-xs font-semibold">
                                    <CheckCircle2 size={13} className="text-emerald-600 dark:text-emerald-400 shrink-0" />
                                    <span>
                                      {isBatch
                                        ? `All ${batchItems.length} products added to catalog`
                                        : "Product added to live catalog"}
                                    </span>
                                  </div>
                                )}
                              </div>
                            </div>
                          );
                        })()}

                        {/* 4. UPDATE_BILL */}
                        {msg.action.type === "UPDATE_BILL" && (() => {
                          const oldTot = msg.action.oldTotal ?? 0;
                          const newTot = msg.action.newTotal ?? 0;
                          const diff = newTot - oldTot;
                          const billItems = msg.action.items || [];
                          const totalQty = billItems.length > 0
                            ? billItems.reduce((acc: number, item: any) => acc + (Number(item.quantity) || 1), 0)
                            : (msg.action.itemsCount || 1);
                          return (
                            <div className="rounded-2xl bg-gradient-to-b from-cyan-50/90 via-white to-cyan-50/40 dark:from-cyan-950/60 dark:via-slate-900/95 dark:to-slate-950 border border-cyan-200/90 dark:border-cyan-500/30 shadow-md shadow-cyan-950/5 dark:shadow-cyan-950/40 overflow-hidden">
                              {/* Header */}
                              <div className="flex items-center justify-between gap-2 px-3.5 py-2.5 bg-cyan-500/[0.06] dark:bg-cyan-500/[0.08] border-b border-cyan-200/70 dark:border-cyan-500/20">
                                <div className="flex items-center gap-2.5 min-w-0">
                                  <div className="w-7 h-7 rounded-xl bg-cyan-500/15 dark:bg-cyan-500/25 flex items-center justify-center text-cyan-600 dark:text-cyan-300 shrink-0 border border-cyan-400/30 shadow-2xs">
                                    <Receipt size={14} />
                                  </div>
                                  <div className="min-w-0">
                                    <span className="text-xs font-extrabold tracking-tight text-slate-900 dark:text-white block leading-tight">
                                      Bill Total Adjustment
                                    </span>
                                    <span className="text-[10px] font-mono font-medium text-cyan-600/80 dark:text-cyan-300/70 block leading-tight mt-0.5">
                                      Receipt #{msg.action.billId?.slice(0, 8)}
                                    </span>
                                  </div>
                                </div>
                                {msg.actionApplied ? (
                                  <span className="inline-flex items-center gap-1 text-[10px] font-bold text-emerald-700 dark:text-emerald-300 bg-emerald-500/15 px-2 py-0.5 rounded-md border border-emerald-500/30 shrink-0">
                                    <CheckCircle2 size={10} />
                                    Updated
                                  </span>
                                ) : (
                                  <span className="inline-flex items-center gap-1.5 text-[10px] font-bold text-cyan-700 dark:text-cyan-300 bg-cyan-500/15 px-2 py-0.5 rounded-md border border-cyan-500/30 shrink-0">
                                    <span className="w-1.5 h-1.5 rounded-full bg-cyan-500 dark:bg-cyan-400 animate-pulse" />
                                    Ready
                                  </span>
                                )}
                              </div>

                              {/* Structured Data Rows */}
                              <div className="p-3 space-y-2.5">
                                <div className="rounded-xl bg-white/95 dark:bg-slate-950/85 border border-slate-200/80 dark:border-slate-800/90 divide-y divide-slate-200/70 dark:divide-slate-800/80 overflow-hidden">
                                  <div className="flex items-center justify-between gap-2 px-3 py-2.5">
                                    <div className="flex items-center gap-1.5 shrink-0">
                                      <span className="text-[11px] font-semibold text-slate-500 dark:text-slate-400">
                                        Bill Total
                                      </span>
                                      {diff !== 0 && (
                                        <span className="text-[10px] font-mono font-extrabold px-1.5 py-0.5 rounded bg-cyan-500/15 text-cyan-700 dark:text-cyan-300 border border-cyan-500/25">
                                          {diff > 0 ? `+₹${diff}` : `-₹${Math.abs(diff)}`}
                                        </span>
                                      )}
                                    </div>
                                    <div className="flex items-center gap-1.5 font-mono tabular-nums flex-wrap justify-end">
                                      <span className="text-xs font-semibold text-slate-400 line-through px-1.5 py-0.5 rounded bg-slate-200/60 dark:bg-slate-800/70">
                                        ₹{oldTot}
                                      </span>
                                      <span className="text-cyan-600 dark:text-cyan-400 text-xs font-black">
                                        →
                                      </span>
                                      <span className="text-xs sm:text-sm font-black text-emerald-600 dark:text-emerald-300 bg-emerald-500/10 dark:bg-emerald-500/20 border border-emerald-500/25 px-2 py-0.5 rounded-md">
                                        ₹{newTot}
                                      </span>
                                    </div>
                                  </div>

                                  <div className="flex items-center justify-between gap-3 px-3 py-2 bg-slate-50/60 dark:bg-slate-900/50">
                                    <span className="text-[11px] font-semibold text-slate-500 dark:text-slate-400">
                                      Total Quantity
                                    </span>
                                    <span className="text-xs font-mono font-bold text-slate-700 dark:text-slate-200">
                                      {totalQty} <span className="font-sans font-normal text-slate-500">units</span>
                                    </span>
                                  </div>
                                </div>

                                {!msg.actionApplied ? (
                                  <button
                                    disabled={executingActionId === msg.id}
                                    onClick={() => handleExecuteAction(msg.id, msg.action!)}
                                    className="w-full py-2.5 px-3.5 bg-gradient-to-r from-cyan-600 via-cyan-500 to-blue-600 hover:from-cyan-500 hover:to-blue-500 active:scale-[0.98] text-white font-bold rounded-xl text-xs flex items-center justify-center gap-2 shadow-md shadow-cyan-600/25 transition-all cursor-pointer border border-cyan-400/30"
                                  >
                                    {executingActionId === msg.id ? (
                                      <>
                                        <RefreshCw size={13} className="animate-spin shrink-0" />
                                        <span>Updating Bill Total...</span>
                                      </>
                                    ) : (
                                      <>
                                        <CheckCircle2 size={14} className="shrink-0" />
                                        <span>Confirm Total (₹{newTot})</span>
                                      </>
                                    )}
                                  </button>
                                ) : (
                                  <div className="flex items-center justify-center gap-2 py-2 px-3 rounded-xl bg-emerald-500/10 border border-emerald-500/25 text-emerald-700 dark:text-emerald-300 text-xs font-semibold">
                                    <CheckCircle2 size={13} className="text-emerald-600 dark:text-emerald-400 shrink-0" />
                                    <span>Transaction total updated</span>
                                  </div>
                                )}
                              </div>
                            </div>
                          );
                        })()}

                        {/* 5. DELETE_BILL */}
                        {msg.action.type === "DELETE_BILL" && (() => {
                          const billItems = msg.action.items || [];
                          const totalQty = billItems.length > 0 
                            ? billItems.reduce((acc: number, item: any) => acc + (Number(item.quantity) || 1), 0)
                            : (msg.action.itemsCount || 1);
                          const totalAmount = Number(msg.action.total ?? (msg.action as any).billTotal ?? 0);
                          const itemCount = billItems.length > 0 ? billItems.length : (msg.action.itemsCount || 1);

                          return (
                            <div className="rounded-2xl bg-gradient-to-b from-rose-50/90 via-white to-rose-50/40 dark:from-rose-950/65 dark:via-slate-900/95 dark:to-slate-950 border border-rose-200/90 dark:border-rose-500/35 shadow-md shadow-rose-950/5 dark:shadow-rose-950/40 overflow-hidden">
                              {/* Header */}
                              <div className="flex items-center justify-between gap-2 px-3.5 py-2.5 bg-rose-500/[0.06] dark:bg-rose-500/[0.08] border-b border-rose-200/70 dark:border-rose-500/20">
                                <div className="flex items-center gap-2.5 min-w-0">
                                  <div className="w-7 h-7 rounded-xl bg-rose-500/15 dark:bg-rose-500/25 flex items-center justify-center text-rose-600 dark:text-rose-300 shrink-0 border border-rose-400/30 shadow-2xs">
                                    <Receipt size={14} />
                                  </div>
                                  <div className="min-w-0">
                                    <span className="text-xs font-extrabold tracking-tight text-slate-900 dark:text-white block leading-tight">
                                      Void Transaction
                                    </span>
                                    <span className="text-[10px] font-mono font-medium text-rose-600/80 dark:text-rose-300/70 block leading-tight mt-0.5">
                                      Receipt #{msg.action.billId?.slice(0, 8)}
                                    </span>
                                  </div>
                                </div>
                                {msg.actionApplied ? (
                                  <span className="inline-flex items-center gap-1 text-[10px] font-bold text-rose-700 dark:text-rose-300 bg-rose-500/15 px-2 py-0.5 rounded-md border border-rose-500/35 shrink-0">
                                    <CheckCircle2 size={10} />
                                    Voided
                                  </span>
                                ) : (
                                  <span className="inline-flex items-center gap-1.5 text-[10px] font-bold text-rose-600 dark:text-rose-300 bg-rose-500/15 px-2 py-0.5 rounded-md border border-rose-500/30 shrink-0">
                                    <span className="w-1.5 h-1.5 rounded-full bg-rose-500 dark:bg-rose-400 animate-pulse" />
                                    Ready
                                  </span>
                                )}
                              </div>

                              {/* Structured Data Rows */}
                              <div className="p-3 space-y-2.5">
                                <div className="rounded-xl bg-white/95 dark:bg-slate-950/85 border border-slate-200/80 dark:border-slate-800/90 divide-y divide-slate-200/70 dark:divide-slate-800/80 overflow-hidden">
                                  <div className="flex items-center justify-between gap-3 px-3 py-2.5">
                                    <span className="text-[11px] font-semibold text-slate-500 dark:text-slate-400">
                                      Bill Amount
                                    </span>
                                    <span className="text-xs sm:text-sm font-black font-mono tabular-nums text-rose-600 dark:text-rose-300 bg-rose-500/10 dark:bg-rose-500/20 border border-rose-500/25 px-2 py-0.5 rounded-md">
                                      ₹{totalAmount}
                                    </span>
                                  </div>

                                  <div className="flex items-center justify-between gap-3 px-3 py-2 bg-slate-50/60 dark:bg-slate-900/50">
                                    <span className="text-[11px] font-semibold text-slate-500 dark:text-slate-400">
                                      Restored Stock
                                    </span>
                                    <div className="flex items-center gap-1.5 font-mono text-xs">
                                      <span className="font-bold text-slate-800 dark:text-slate-200">
                                        {totalQty} units
                                      </span>
                                      <span className="text-[10px] px-1.5 py-0.5 rounded bg-indigo-500/10 text-indigo-600 dark:text-indigo-300 border border-indigo-500/20">
                                        {itemCount} {itemCount === 1 ? "item" : "items"}
                                      </span>
                                    </div>
                                  </div>

                                  {msg.action.itemSummary && (
                                    <div className="flex items-center justify-between gap-3 px-3 py-2">
                                      <span className="text-[11px] font-semibold text-slate-500 dark:text-slate-400 shrink-0">
                                        Summary
                                      </span>
                                      <span className="text-[11px] text-slate-700 dark:text-slate-300 font-medium text-right break-words min-w-0">
                                        {msg.action.itemSummary}
                                      </span>
                                    </div>
                                  )}
                                </div>

                                {!msg.actionApplied ? (
                                  <button
                                    disabled={executingActionId === msg.id}
                                    onClick={() => handleExecuteAction(msg.id, msg.action!)}
                                    className="w-full py-2.5 px-3.5 bg-gradient-to-r from-rose-600 via-rose-500 to-red-600 hover:from-rose-500 hover:to-red-500 active:scale-[0.98] text-white font-bold rounded-xl text-xs flex items-center justify-center gap-2 shadow-md shadow-rose-600/25 transition-all cursor-pointer border border-rose-400/30"
                                  >
                                    {executingActionId === msg.id ? (
                                      <>
                                        <RefreshCw size={13} className="animate-spin shrink-0" />
                                        <span>Voiding Bill & Restoring Stock...</span>
                                      </>
                                    ) : (
                                      <>
                                        <Trash2 size={14} className="shrink-0" />
                                        <span>Confirm & Void Bill (₹{totalAmount})</span>
                                      </>
                                    )}
                                  </button>
                                ) : (
                                  <div className="flex items-center justify-center gap-2 py-2 px-3 rounded-xl bg-rose-500/10 border border-rose-500/25 text-rose-700 dark:text-rose-300 text-xs font-semibold">
                                    <CheckCircle2 size={13} className="text-rose-600 dark:text-rose-400 shrink-0" />
                                    <span>Bill #{msg.action.billId?.slice(0, 8)} voided & stock restored</span>
                                  </div>
                                )}
                              </div>
                            </div>
                          );
                        })()}

                        {/* 6. DELETE_PRODUCT */}
                        {msg.action.type === "DELETE_PRODUCT" && (
                          <div className="rounded-2xl bg-gradient-to-b from-rose-50/90 via-white to-rose-50/40 dark:from-rose-950/65 dark:via-slate-900/95 dark:to-slate-950 border border-rose-200/90 dark:border-rose-500/35 shadow-md shadow-rose-950/5 dark:shadow-rose-950/40 overflow-hidden">
                            {/* Header */}
                            <div className="flex items-center justify-between gap-2 px-3.5 py-2.5 bg-rose-500/[0.06] dark:bg-rose-500/[0.08] border-b border-rose-200/70 dark:border-rose-500/20">
                              <div className="flex items-center gap-2.5 min-w-0">
                                <div className="w-7 h-7 rounded-xl bg-rose-500/15 dark:bg-rose-500/25 flex items-center justify-center text-rose-600 dark:text-rose-300 shrink-0 border border-rose-400/30 shadow-2xs">
                                  <Trash2 size={14} />
                                </div>
                                <div className="min-w-0">
                                  <span className="text-xs font-extrabold tracking-tight text-slate-900 dark:text-white block leading-tight">
                                    Remove Product
                                  </span>
                                  <span className="text-[10px] font-medium text-rose-600/80 dark:text-rose-300/70 block leading-tight mt-0.5">
                                    Catalog Deletion
                                  </span>
                                </div>
                              </div>
                              {msg.actionApplied ? (
                                <span className="inline-flex items-center gap-1 text-[10px] font-bold text-rose-700 dark:text-rose-300 bg-rose-500/15 px-2 py-0.5 rounded-md border border-rose-500/35 shrink-0">
                                  <CheckCircle2 size={10} />
                                  Removed
                                </span>
                              ) : (
                                <span className="inline-flex items-center gap-1.5 text-[10px] font-bold text-rose-600 dark:text-rose-300 bg-rose-500/15 px-2 py-0.5 rounded-md border border-rose-500/30 shrink-0">
                                  <span className="w-1.5 h-1.5 rounded-full bg-rose-500 dark:bg-rose-400 animate-pulse" />
                                  Ready
                                </span>
                              )}
                            </div>

                            {/* Structured Data Rows */}
                            <div className="p-3 space-y-2.5">
                              <div className="rounded-xl bg-white/95 dark:bg-slate-950/85 border border-slate-200/80 dark:border-slate-800/90 divide-y divide-slate-200/70 dark:divide-slate-800/80 overflow-hidden">
                                <div className="flex items-center justify-between gap-3 px-3 py-2.5">
                                  <span className="text-[11px] font-semibold text-slate-500 dark:text-slate-400 shrink-0">
                                    Catalog Item
                                  </span>
                                  <span className="text-xs sm:text-sm font-extrabold text-slate-900 dark:text-white text-right break-words min-w-0">
                                    {msg.action.productName || "Product"}
                                  </span>
                                </div>

                                <div className="flex items-center justify-between gap-2 px-3 py-2.5 bg-slate-50/60 dark:bg-slate-900/50">
                                  <span className="text-[11px] font-semibold text-slate-500 dark:text-slate-400 shrink-0">
                                    Price & Stock
                                  </span>
                                  <div className="flex items-center gap-1.5 font-mono tabular-nums flex-wrap justify-end text-xs">
                                    <span className="px-2 py-0.5 rounded-md bg-rose-500/10 dark:bg-rose-500/20 border border-rose-500/25 font-black text-rose-600 dark:text-rose-300">
                                      ₹{msg.action.currentPrice ?? "—"}
                                    </span>
                                    <span className="px-2 py-0.5 rounded-md bg-amber-500/10 dark:bg-amber-500/20 border border-amber-500/25 font-bold text-amber-700 dark:text-amber-300">
                                      {msg.action.currentStock ?? 0}{" "}
                                      <span className="text-[10px] font-sans opacity-80">units</span>
                                    </span>
                                  </div>
                                </div>
                              </div>

                              {!msg.actionApplied ? (
                                <button
                                  disabled={executingActionId === msg.id}
                                  onClick={() => handleExecuteAction(msg.id, msg.action!)}
                                  className="w-full py-2.5 px-3.5 bg-gradient-to-r from-rose-600 via-rose-500 to-red-600 hover:from-rose-500 hover:to-red-500 active:scale-[0.98] text-white font-bold rounded-xl text-xs flex items-center justify-center gap-2 shadow-md shadow-rose-600/25 transition-all cursor-pointer border border-rose-400/30"
                                >
                                  {executingActionId === msg.id ? (
                                    <>
                                      <RefreshCw size={13} className="animate-spin shrink-0" />
                                      <span>Removing from Store...</span>
                                    </>
                                  ) : (
                                    <>
                                      <Trash2 size={14} className="shrink-0" />
                                      <span>Confirm & Delete Product</span>
                                    </>
                                  )}
                                </button>
                              ) : (
                                <div className="flex items-center justify-center gap-2 py-2 px-3 rounded-xl bg-rose-500/10 border border-rose-500/25 text-rose-700 dark:text-rose-300 text-xs font-semibold">
                                  <CheckCircle2 size={13} className="text-rose-600 dark:text-rose-400 shrink-0" />
                                  <span>Product removed from store catalog</span>
                                </div>
                              )}
                            </div>
                          </div>
                        )}

                        {/* 7. ADD_EXPENSE */}
                        {msg.action.type === "ADD_EXPENSE" &&
                          Boolean(msg.action.title?.trim()) &&
                          Number(msg.action.amount) > 0 && (() => {
                            const catKey = normalizeClientExpenseCategory(msg.action.category);
                            const catLabelMap: Record<string, string> = {
                              expense: "Expense",
                              borrow: "Borrowed",
                              due: "Due",
                              other: "Other Cost",
                            };
                            return (
                              <div className="rounded-2xl bg-gradient-to-b from-amber-50/90 via-white to-amber-50/40 dark:from-amber-950/60 dark:via-slate-900/95 dark:to-slate-950 border border-amber-200/90 dark:border-amber-500/30 shadow-md shadow-amber-950/5 dark:shadow-amber-950/40 overflow-hidden">
                                {/* Header */}
                                <div className="flex items-center justify-between gap-2 px-3.5 py-2.5 bg-amber-500/[0.06] dark:bg-amber-500/[0.08] border-b border-amber-200/70 dark:border-amber-500/20">
                                  <div className="flex items-center gap-2.5 min-w-0">
                                    <div className="w-7 h-7 rounded-xl bg-amber-500/15 dark:bg-amber-500/25 flex items-center justify-center text-amber-600 dark:text-amber-300 shrink-0 border border-amber-400/30 shadow-2xs">
                                      <Receipt size={14} />
                                    </div>
                                    <div className="min-w-0">
                                      <span className="text-xs font-extrabold tracking-tight text-slate-900 dark:text-white block leading-tight">
                                        Record Store Cost
                                      </span>
                                      <span className="text-[10px] font-medium text-amber-600/80 dark:text-amber-300/70 block leading-tight mt-0.5">
                                        {catLabelMap[catKey] || "Expense"} Ledger
                                      </span>
                                    </div>
                                  </div>
                                  {msg.actionApplied ? (
                                    <span className="inline-flex items-center gap-1 text-[10px] font-bold text-emerald-700 dark:text-emerald-300 bg-emerald-500/15 px-2 py-0.5 rounded-md border border-emerald-500/30 shrink-0">
                                      <CheckCircle2 size={10} />
                                      Recorded
                                    </span>
                                  ) : (
                                    <span className="inline-flex items-center gap-1.5 text-[10px] font-bold text-amber-700 dark:text-amber-300 bg-amber-500/15 px-2 py-0.5 rounded-md border border-amber-500/30 shrink-0">
                                      <span className="w-1.5 h-1.5 rounded-full bg-amber-500 dark:bg-amber-400 animate-pulse" />
                                      Ready
                                    </span>
                                  )}
                                </div>

                                {/* Structured Data Rows */}
                                <div className="p-3 space-y-2.5">
                                  <div className="rounded-xl bg-white/95 dark:bg-slate-950/85 border border-slate-200/80 dark:border-slate-800/90 divide-y divide-slate-200/70 dark:divide-slate-800/80 overflow-hidden">
                                    <div className="flex items-center justify-between gap-3 px-3 py-2.5">
                                      <span className="text-[11px] font-semibold text-slate-500 dark:text-slate-400 shrink-0">
                                        Description
                                      </span>
                                      <span className="text-xs sm:text-sm font-extrabold text-slate-900 dark:text-white text-right break-words min-w-0">
                                        {msg.action.title}
                                      </span>
                                    </div>

                                    <div className="flex items-center justify-between gap-3 px-3 py-2.5 bg-slate-50/60 dark:bg-slate-900/50">
                                      <span className="text-[11px] font-semibold text-slate-500 dark:text-slate-400 shrink-0">
                                        Amount
                                      </span>
                                      <span className="text-xs sm:text-sm font-black font-mono tabular-nums text-amber-700 dark:text-amber-300 bg-amber-500/15 dark:bg-amber-500/20 border border-amber-500/30 px-2 py-0.5 rounded-md">
                                        ₹{msg.action.amount}
                                      </span>
                                    </div>
                                  </div>

                                  {!msg.actionApplied ? (
                                    <button
                                      disabled={executingActionId === msg.id}
                                      onClick={() => handleExecuteAction(msg.id, msg.action!)}
                                      className="w-full py-2.5 px-3.5 bg-gradient-to-r from-amber-600 via-amber-500 to-orange-500 hover:from-amber-500 hover:to-orange-400 active:scale-[0.98] text-white font-bold rounded-xl text-xs flex items-center justify-center gap-2 shadow-md shadow-amber-600/25 transition-all cursor-pointer border border-amber-400/25"
                                    >
                                      {executingActionId === msg.id ? (
                                        <>
                                          <RefreshCw size={13} className="animate-spin shrink-0" />
                                          <span>Recording Cost...</span>
                                        </>
                                      ) : (
                                        <>
                                          <CheckCircle2 size={14} className="shrink-0" />
                                          <span>Confirm Expense (₹{msg.action.amount})</span>
                                        </>
                                      )}
                                    </button>
                                  ) : (
                                    <div className="flex items-center justify-center gap-2 py-2 px-3 rounded-xl bg-emerald-500/10 border border-emerald-500/25 text-emerald-700 dark:text-emerald-300 text-xs font-semibold">
                                      <CheckCircle2 size={13} className="text-emerald-600 dark:text-emerald-400 shrink-0" />
                                      <span>Recorded in Other Costs ledger</span>
                                    </div>
                                  )}
                                </div>
                              </div>
                            );
                          })()}

                        {/* 7B. DELETE_EXPENSE */}
                        {msg.action.type === "DELETE_EXPENSE" && Boolean(msg.action.expenseId) && (
                          <div className="rounded-2xl bg-gradient-to-b from-rose-50/90 via-white to-rose-50/40 dark:from-rose-950/65 dark:via-slate-900/95 dark:to-slate-950 border border-rose-200/90 dark:border-rose-500/35 shadow-md shadow-rose-950/5 dark:shadow-rose-950/40 overflow-hidden">
                            {/* Header */}
                            <div className="flex items-center justify-between gap-2 px-3.5 py-2.5 bg-rose-500/[0.06] dark:bg-rose-500/[0.08] border-b border-rose-200/70 dark:border-rose-500/20">
                              <div className="flex items-center gap-2.5 min-w-0">
                                <div className="w-7 h-7 rounded-xl bg-rose-500/15 dark:bg-rose-500/25 flex items-center justify-center text-rose-600 dark:text-rose-300 shrink-0 border border-rose-400/30 shadow-2xs">
                                  <Trash2 size={14} />
                                </div>
                                <div className="min-w-0">
                                  <span className="text-xs font-extrabold tracking-tight text-slate-900 dark:text-white block leading-tight">
                                    Remove Expense
                                  </span>
                                  <span className="text-[10px] font-medium text-rose-600/80 dark:text-rose-300/70 block leading-tight mt-0.5">
                                    Cost Ledger Removal
                                  </span>
                                </div>
                              </div>
                              {msg.actionApplied ? (
                                <span className="inline-flex items-center gap-1 text-[10px] font-bold text-rose-700 dark:text-rose-300 bg-rose-500/15 px-2 py-0.5 rounded-md border border-rose-500/35 shrink-0">
                                  <CheckCircle2 size={10} />
                                  Deleted
                                </span>
                              ) : (
                                <span className="inline-flex items-center gap-1.5 text-[10px] font-bold text-rose-600 dark:text-rose-300 bg-rose-500/15 px-2 py-0.5 rounded-md border border-rose-500/30 shrink-0">
                                  <span className="w-1.5 h-1.5 rounded-full bg-rose-500 dark:bg-rose-400 animate-pulse" />
                                  Ready
                                </span>
                              )}
                            </div>

                            {/* Structured Data Rows */}
                            <div className="p-3 space-y-2.5">
                              <div className="rounded-xl bg-white/95 dark:bg-slate-950/85 border border-slate-200/80 dark:border-slate-800/90 divide-y divide-slate-200/70 dark:divide-slate-800/80 overflow-hidden">
                                <div className="flex items-center justify-between gap-3 px-3 py-2.5">
                                  <span className="text-[11px] font-semibold text-slate-500 dark:text-slate-400 shrink-0">
                                    Expense Entry
                                  </span>
                                  <span className="text-xs sm:text-sm font-extrabold text-slate-900 dark:text-white text-right break-words min-w-0">
                                    {msg.action.title || "Expense Record"}
                                  </span>
                                </div>

                                {msg.action.amount !== undefined && (
                                  <div className="flex items-center justify-between gap-3 px-3 py-2.5 bg-slate-50/60 dark:bg-slate-900/50">
                                    <span className="text-[11px] font-semibold text-slate-500 dark:text-slate-400 shrink-0">
                                      Amount
                                    </span>
                                    <span className="text-xs sm:text-sm font-black font-mono tabular-nums text-rose-600 dark:text-rose-300 bg-rose-500/10 dark:bg-rose-500/20 border border-rose-500/25 px-2 py-0.5 rounded-md">
                                      ₹{msg.action.amount}
                                    </span>
                                  </div>
                                )}
                              </div>

                              {!msg.actionApplied ? (
                                <button
                                  disabled={executingActionId === msg.id}
                                  onClick={() => handleExecuteAction(msg.id, msg.action!)}
                                  className="w-full py-2.5 px-3.5 bg-gradient-to-r from-rose-600 via-rose-500 to-red-600 hover:from-rose-500 hover:to-red-500 active:scale-[0.98] text-white font-bold rounded-xl text-xs flex items-center justify-center gap-2 shadow-md shadow-rose-600/25 transition-all cursor-pointer border border-rose-400/30"
                                >
                                  {executingActionId === msg.id ? (
                                    <>
                                      <RefreshCw size={13} className="animate-spin shrink-0" />
                                      <span>Deleting Expense...</span>
                                    </>
                                  ) : (
                                    <>
                                      <Trash2 size={14} className="shrink-0" />
                                      <span>Confirm & Delete Expense</span>
                                    </>
                                  )}
                                </button>
                              ) : (
                                <div className="flex items-center justify-center gap-2 py-2 px-3 rounded-xl bg-rose-500/10 border border-rose-500/25 text-rose-700 dark:text-rose-300 text-xs font-semibold">
                                  <CheckCircle2 size={13} className="text-rose-600 dark:text-rose-400 shrink-0" />
                                  <span>Expense removed from store ledger</span>
                                </div>
                              )}
                            </div>
                          </div>
                        )}

                        {/* 8. UPDATE_ROLE */}
                        {msg.action.type === "UPDATE_ROLE" && (
                          <div className="rounded-2xl bg-gradient-to-b from-purple-50/90 via-white to-purple-50/40 dark:from-purple-950/60 dark:via-slate-900/95 dark:to-slate-950 border border-purple-200/90 dark:border-purple-500/30 shadow-md shadow-purple-950/5 dark:shadow-purple-950/40 overflow-hidden">
                            {/* Header */}
                            <div className="flex items-center justify-between gap-2 px-3.5 py-2.5 bg-purple-500/[0.06] dark:bg-purple-500/[0.08] border-b border-purple-200/70 dark:border-purple-500/20">
                              <div className="flex items-center gap-2.5 min-w-0">
                                <div className="w-7 h-7 rounded-xl bg-purple-500/15 dark:bg-purple-500/25 flex items-center justify-center text-purple-600 dark:text-purple-300 shrink-0 border border-purple-400/30 shadow-2xs">
                                  <ShieldCheck size={14} />
                                </div>
                                <div className="min-w-0">
                                  <span className="text-xs font-extrabold tracking-tight text-slate-900 dark:text-white block leading-tight">
                                    Role Assignment
                                  </span>
                                  <span className="text-[10px] font-medium text-purple-600/80 dark:text-purple-300/70 block leading-tight mt-0.5">
                                    Staff Permissions
                                  </span>
                                </div>
                              </div>
                              {msg.actionApplied ? (
                                <span className="inline-flex items-center gap-1 text-[10px] font-bold text-emerald-700 dark:text-emerald-300 bg-emerald-500/15 px-2 py-0.5 rounded-md border border-emerald-500/30 shrink-0">
                                  <CheckCircle2 size={10} />
                                  Updated
                                </span>
                              ) : (
                                <span className="inline-flex items-center gap-1.5 text-[10px] font-bold text-purple-700 dark:text-purple-300 bg-purple-500/15 px-2 py-0.5 rounded-md border border-purple-500/30 shrink-0">
                                  <span className="w-1.5 h-1.5 rounded-full bg-purple-500 dark:bg-purple-400 animate-pulse" />
                                  Ready
                                </span>
                              )}
                            </div>

                            {/* Structured Data Rows */}
                            <div className="p-3 space-y-2.5">
                              <div className="rounded-xl bg-white/95 dark:bg-slate-950/85 border border-slate-200/80 dark:border-slate-800/90 divide-y divide-slate-200/70 dark:divide-slate-800/80 overflow-hidden">
                                <div className="flex items-center justify-between gap-3 px-3 py-2.5">
                                  <div className="min-w-0">
                                    <span className="text-xs sm:text-sm font-extrabold text-slate-900 dark:text-white block truncate">
                                      {msg.action.userName || msg.action.userEmail || "Staff Member"}
                                    </span>
                                    {msg.action.userEmail && (
                                      <span className="text-[10px] text-slate-500 dark:text-slate-400 font-mono block truncate mt-0.5">
                                        {msg.action.userEmail}
                                      </span>
                                    )}
                                  </div>
                                  <span className="px-2.5 py-1 rounded-md bg-purple-500/15 dark:bg-purple-500/20 text-purple-800 dark:text-purple-200 font-mono text-xs font-extrabold border border-purple-400/40 dark:border-purple-500/35 shrink-0">
                                    {msg.action.isAdminRole ? "Admin" : "Staff"}
                                  </span>
                                </div>
                              </div>

                              {!msg.actionApplied ? (
                                <button
                                  disabled={executingActionId === msg.id}
                                  onClick={() => handleExecuteAction(msg.id, msg.action!)}
                                  className="w-full py-2.5 px-3.5 bg-gradient-to-r from-purple-600 via-purple-500 to-indigo-600 hover:from-purple-500 hover:to-indigo-500 active:scale-[0.98] text-white font-bold rounded-xl text-xs flex items-center justify-center gap-2 shadow-md shadow-purple-600/25 transition-all cursor-pointer border border-purple-400/25"
                                >
                                  {executingActionId === msg.id ? (
                                    <>
                                      <RefreshCw size={13} className="animate-spin shrink-0" />
                                      <span>Applying Permission Update...</span>
                                    </>
                                  ) : (
                                    <>
                                      <CheckCircle2 size={14} className="shrink-0" />
                                      <span>Confirm Role Update</span>
                                    </>
                                  )}
                                </button>
                              ) : (
                                <div className="flex items-center justify-center gap-2 py-2 px-3 rounded-xl bg-emerald-500/10 border border-emerald-500/25 text-emerald-700 dark:text-emerald-300 text-xs font-semibold">
                                  <CheckCircle2 size={13} className="text-emerald-600 dark:text-emerald-400 shrink-0" />
                                  <span>Staff role updated in settings</span>
                                </div>
                              )}
                            </div>
                          </div>
                        )}

                        {/* 9. PURGE_STORE_DATA */}
                        {msg.action.type === "PURGE_STORE_DATA" && (() => {
                          const targetScope = msg.action.target || "both";
                          const prodCount = msg.action.productsCount ?? products.length;
                          const billCount = msg.action.billsCount ?? bills.length;
                          return (
                            <div className="rounded-2xl bg-gradient-to-b from-rose-50/90 via-white to-rose-50/40 dark:from-rose-950/70 dark:via-slate-900/95 dark:to-slate-950 border border-rose-200/90 dark:border-rose-500/40 shadow-md shadow-rose-950/5 dark:shadow-rose-950/40 overflow-hidden">
                              {/* Header */}
                              <div className="flex items-center justify-between gap-2 px-3.5 py-2.5 bg-rose-500/[0.06] dark:bg-rose-500/[0.08] border-b border-rose-200/70 dark:border-rose-500/20">
                                <div className="flex items-center gap-2.5 min-w-0">
                                  <div className="w-7 h-7 rounded-xl bg-rose-500/15 dark:bg-rose-500/25 flex items-center justify-center text-rose-600 dark:text-rose-300 shrink-0 border border-rose-400/30 shadow-2xs">
                                    <Trash2 size={14} />
                                  </div>
                                  <div className="min-w-0">
                                    <span className="text-xs font-extrabold tracking-tight text-slate-900 dark:text-white block leading-tight">
                                      Bulk Data Purge
                                    </span>
                                    <span className="text-[10px] font-medium text-rose-600/80 dark:text-rose-300/70 block leading-tight mt-0.5">
                                      {targetScope === "both"
                                        ? "All Products & Bills"
                                        : targetScope === "products"
                                        ? "Entire Product Catalog"
                                        : "All Transaction Bills"}
                                    </span>
                                  </div>
                                </div>
                                {msg.actionApplied ? (
                                  <span className="inline-flex items-center gap-1 text-[10px] font-bold text-rose-700 dark:text-rose-300 bg-rose-500/15 px-2 py-0.5 rounded-md border border-rose-500/35 shrink-0">
                                    <CheckCircle2 size={10} />
                                    Purged
                                  </span>
                                ) : (
                                  <span className="inline-flex items-center gap-1.5 text-[10px] font-bold text-rose-600 dark:text-rose-300 bg-rose-500/15 px-2 py-0.5 rounded-md border border-rose-500/30 shrink-0">
                                    <span className="w-1.5 h-1.5 rounded-full bg-rose-500 dark:bg-rose-400 animate-pulse" />
                                    Ready
                                  </span>
                                )}
                              </div>

                              {/* Structured Data Rows */}
                              <div className="p-3 space-y-2.5">
                                <div className="rounded-xl bg-white/95 dark:bg-slate-950/85 border border-slate-200/80 dark:border-slate-800/90 divide-y divide-slate-200/70 dark:divide-slate-800/80 overflow-hidden">
                                  {(targetScope === "products" || targetScope === "both") && (
                                    <div className="flex items-center justify-between gap-3 px-3 py-2.5">
                                      <span className="text-[11px] font-semibold text-slate-500 dark:text-slate-400">
                                        Catalog Products
                                      </span>
                                      <span className="text-xs sm:text-sm font-black font-mono tabular-nums text-rose-600 dark:text-rose-300 bg-rose-500/10 dark:bg-rose-500/20 border border-rose-500/25 px-2 py-0.5 rounded-md">
                                        {prodCount} items
                                      </span>
                                    </div>
                                  )}
                                  {(targetScope === "bills" || targetScope === "both") && (
                                    <div className="flex items-center justify-between gap-3 px-3 py-2.5 bg-slate-50/60 dark:bg-slate-900/50">
                                      <span className="text-[11px] font-semibold text-slate-500 dark:text-slate-400">
                                        Recorded Bills
                                      </span>
                                      <span className="text-xs sm:text-sm font-black font-mono tabular-nums text-rose-600 dark:text-rose-300 bg-rose-500/10 dark:bg-rose-500/20 border border-rose-500/25 px-2 py-0.5 rounded-md">
                                        {billCount} bills
                                      </span>
                                    </div>
                                  )}
                                </div>

                                {!msg.actionApplied ? (
                                  <button
                                    disabled={executingActionId === msg.id}
                                    onClick={() => handleExecuteAction(msg.id, msg.action!)}
                                    className="w-full py-2.5 px-3.5 bg-gradient-to-r from-rose-600 via-rose-500 to-red-600 hover:from-rose-500 hover:to-red-500 active:scale-[0.98] text-white font-bold rounded-xl text-xs flex items-center justify-center gap-2 shadow-md shadow-rose-600/25 transition-all cursor-pointer border border-rose-400/30"
                                  >
                                    {executingActionId === msg.id ? (
                                      <>
                                        <RefreshCw size={13} className="animate-spin shrink-0" />
                                        <span>Purging Store Records...</span>
                                      </>
                                    ) : (
                                      <>
                                        <Trash2 size={14} className="shrink-0" />
                                        <span>
                                          Confirm & Purge{" "}
                                          {targetScope === "both"
                                            ? "All Products & Bills"
                                            : targetScope === "products"
                                            ? "All Products"
                                            : "All Bills"}
                                        </span>
                                      </>
                                    )}
                                  </button>
                                ) : (
                                  <div className="flex items-center justify-center gap-2 py-2 px-3 rounded-xl bg-rose-500/10 border border-rose-500/25 text-rose-700 dark:text-rose-300 text-xs font-semibold">
                                    <CheckCircle2 size={13} className="text-rose-600 dark:text-rose-400 shrink-0" />
                                    <span>Selected store records permanently purged</span>
                                  </div>
                                )}
                              </div>
                            </div>
                          );
                        })()}
                      </motion.div>
                    )}

                    {/* Toolbar under message (fills in once message is complete) */}
                    {!msg.isStreaming && msg.content && (
                      <div
                        data-no-chat-select="true"
                        className="mt-3 pt-2.5 border-t border-slate-200/80 dark:border-slate-800/70 space-y-2.5 select-none [-webkit-user-select:none] [-webkit-touch-callout:none]"
                      >
                        <div className="flex items-center justify-between text-slate-500 dark:text-slate-400 text-[10.5px] select-none [-webkit-user-select:none]">
                          {msg.thought ? (
                            <div
                              data-no-chat-select="true"
                              className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg border bg-slate-100 dark:bg-slate-800/50 border-slate-200 dark:border-slate-700/50 text-slate-600 dark:text-slate-300 text-[10.5px] font-medium select-none [-webkit-user-select:none]"
                            >
                              <Sparkles size={11} className="text-indigo-500 dark:text-indigo-400 shrink-0" />
                              <span className="select-none [-webkit-user-select:none]">
                                Thought for {msg.thoughtDuration || 1}s
                              </span>
                            </div>
                          ) : (
                            <div
                              data-no-chat-select="true"
                              className="flex items-center gap-1.5 text-slate-500 dark:text-slate-400 select-none [-webkit-user-select:none]"
                            >
                              <Zap size={11} className="text-amber-500 dark:text-amber-400 fill-amber-500 dark:fill-amber-400" />
                              <span className="font-mono text-[10px] text-slate-500 dark:text-slate-400 select-none [-webkit-user-select:none]">
                                Buzz AI
                              </span>
                            </div>
                          )}
                          <div
                            data-no-chat-select="true"
                            className="flex items-center gap-3 select-none [-webkit-user-select:none]"
                          >
                            <button
                              type="button"
                              data-no-chat-select="true"
                              onClick={() => handleSpeakText(msg.id, msg.content)}
                              className="hover:text-indigo-600 dark:hover:text-indigo-300 transition-colors flex items-center gap-1.5 cursor-pointer select-none [-webkit-user-select:none]"
                              title={speakingId === msg.id ? "Stop voice" : "Listen with Gemini Neural Voice"}
                            >
                              {synthesizingId === msg.id ? (
                                <>
                                  <RefreshCw size={12} className="text-indigo-500 dark:text-indigo-400 animate-spin" />
                                  <span className="text-indigo-600 dark:text-indigo-300 text-[10px] font-semibold select-none [-webkit-user-select:none]">
                                    Synthesizing...
                                  </span>
                                </>
                              ) : speakingId === msg.id ? (
                                <>
                                  <VolumeX size={12} className="text-rose-500 dark:text-rose-400 animate-pulse" />
                                  <span className="text-rose-600 dark:text-rose-400 text-[10px] font-bold select-none [-webkit-user-select:none]">
                                    Speaking...
                                  </span>
                                </>
                              ) : (
                                <>
                                  <Volume2 size={12} />
                                  <span className="text-[10px] select-none [-webkit-user-select:none]">
                                    Listen
                                  </span>
                                </>
                              )}
                            </button>

                            <button
                              type="button"
                              data-no-chat-select="true"
                              onClick={() => handleCopyText(msg.id, msg.content)}
                              className="hover:text-slate-900 dark:hover:text-slate-200 transition-colors flex items-center gap-1.5 cursor-pointer select-none [-webkit-user-select:none]"
                              title="Copy text"
                            >
                              {copiedId === msg.id ? (
                                <>
                                  <Check size={12} className="text-emerald-600 dark:text-emerald-400" />
                                  <span className="text-emerald-600 dark:text-emerald-400 text-[10px] font-bold select-none [-webkit-user-select:none]">
                                    Copied
                                  </span>
                                </>
                              ) : (
                                <>
                                  <Copy size={12} />
                                  <span className="text-[10px] select-none [-webkit-user-select:none]">
                                    Copy
                                  </span>
                                </>
                              )}
                            </button>
                          </div>
                        </div>
                      </div>
                    )}
                  </div>
                </motion.div>
              );
            })}

            {/* Balanced AI Chat Workspace Welcome */}
            {messages.length === 0 && (
              <div className="min-h-[calc(100dvh-210px)] max-w-xl mx-auto w-full flex flex-col items-center justify-center text-center animate-fadeIn px-2 py-6">
                {/* Ambient Radial Bloom behind Brand Emblem */}
                <div className="relative mb-6 flex items-center justify-center">
                  <div className="absolute -inset-6 bg-gradient-to-tr from-amber-400/20 via-indigo-500/25 to-purple-600/25 rounded-full blur-2xl opacity-80 pointer-events-none" />
                  <div className="relative w-16 h-16 rounded-[20px] bg-indigo-600 flex items-center justify-center text-white shadow-2xl shadow-indigo-500/30 overflow-hidden">
                    <div className="absolute inset-0 bg-gradient-to-tr from-amber-400 via-indigo-500 to-purple-600" />
                    <Zap size={30} className="relative z-10 fill-white text-white drop-shadow-[0_0_12px_rgba(255,255,255,0.6)]" />
                  </div>
                </div>

                {/* Clean Typographic Eyebrow */}
                <div className="flex items-center gap-2 text-[10px] font-bold uppercase tracking-[0.2em] text-indigo-600 dark:text-indigo-300/90 mb-2.5">
                  <span>Connected Store Intelligence</span>
                </div>

                {/* Primary Headline */}
                <h1 className="text-2xl sm:text-3xl font-extrabold text-slate-900 dark:text-white tracking-tight leading-tight mb-3">
                  How can I assist your store today?
                </h1>
                <p className="text-xs sm:text-sm text-slate-600 dark:text-slate-400 max-w-sm leading-relaxed mb-7">
                  Synced with your live catalog and billing ledger for inventory updates, price changes, revenue insights, and voice commands.
                </p>

                {/* Non-interactive Live Store Telemetry Strip */}
                <div className="w-full max-w-md grid grid-cols-3 gap-2 p-2 rounded-2xl bg-white dark:bg-[#0f172a]/90 border border-slate-200/90 dark:border-white/[0.07] shadow-sm dark:shadow-none">
                  <div className="py-2.5 px-2 rounded-xl bg-slate-50/80 dark:bg-white/[0.02] flex flex-col items-center justify-center">
                    <span className="text-sm font-black font-mono text-slate-900 dark:text-white tabular-nums">
                      {products.length}
                    </span>
                    <span className="text-[10px] font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wider mt-0.5">
                      Catalog Items
                    </span>
                  </div>
                  <div className="py-2.5 px-2 rounded-xl bg-slate-50/80 dark:bg-white/[0.02] flex flex-col items-center justify-center border-x border-slate-200/70 dark:border-white/[0.05]">
                    <span className="text-sm font-black font-mono text-indigo-600 dark:text-indigo-300 tabular-nums">
                      {bills.length}
                    </span>
                    <span className="text-[10px] font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wider mt-0.5">
                      Recorded Bills
                    </span>
                  </div>
                  <div className="py-2.5 px-2 rounded-xl bg-slate-50/80 dark:bg-white/[0.02] flex flex-col items-center justify-center">
                    <span className="text-sm font-black text-emerald-600 dark:text-emerald-400">
                      Voice + Text
                    </span>
                    <span className="text-[10px] font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wider mt-0.5">
                      Input Mode
                    </span>
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Unified Input Composer Dock — padded above mobile bottom gesture/navigation bar */}
        <footer
          className={`border-t border-slate-200/80 dark:border-white/[0.07] bg-white dark:bg-[#090d18] shrink-0 relative z-20 [transform:translateZ(0)] ${
            isKeyboardOpen
              ? "pb-2"
              : "pb-[max(calc(env(safe-area-inset-bottom,0px)+0.85rem),1.5rem)] sm:pb-3"
          }`}
        >
          <div className="max-w-3xl mx-auto w-full px-3 sm:px-5 pt-2.5 pb-1">
            {errorMessage && (
              <div className="mb-2.5 px-3 py-1.5 rounded-xl bg-red-500/15 border border-red-500/30 text-red-600 dark:text-red-400 text-xs flex items-center justify-between gap-2">
                <div className="flex items-center gap-2 min-w-0">
                  <AlertTriangle size={14} className="shrink-0" />
                  <span className="truncate">{errorMessage}</span>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <button
                    type="button"
                    onClick={() => setErrorMessage("")}
                    className="text-red-600 dark:text-red-400 hover:text-red-800 dark:hover:text-red-200 text-[10px] font-bold underline"
                  >
                    Dismiss
                  </button>
                </div>
              </div>
            )}

            {/* Quoted Text Banner above Composer */}
            <AnimatePresence initial={false}>
              {quotedText && (
                <motion.div
                  initial={{ opacity: 0, height: 0, y: 8, scale: 0.98 }}
                  animate={{ opacity: 1, height: "auto", y: 0, scale: 1 }}
                  exit={{ opacity: 0, height: 0, y: 6, scale: 0.98 }}
                  transition={{ type: "spring", stiffness: 500, damping: 34, mass: 0.55 }}
                  className="mb-2.5 overflow-hidden"
                >
                  <div className="relative overflow-hidden pl-3.5 pr-2.5 py-2.5 rounded-2xl bg-slate-100 dark:bg-[#0f1629] bg-gradient-to-r from-indigo-500/[0.1] via-slate-100/95 to-purple-500/[0.08] dark:from-indigo-500/[0.14] dark:via-[#0f1629]/95 dark:to-purple-500/[0.12] border border-indigo-500/30 dark:border-indigo-400/25 flex items-start justify-between gap-2.5 shadow-md">
                    <div className="absolute left-0 top-0 bottom-0 w-1 bg-gradient-to-b from-amber-400 via-indigo-500 to-purple-500" />
                    <div className="min-w-0 flex-1 pl-1">
                      <div className="flex items-center gap-1.5 mb-0.5">
                        <span className="w-4 h-4 rounded-md bg-indigo-500/15 dark:bg-indigo-500/25 border border-indigo-500/30 text-indigo-600 dark:text-indigo-300 flex items-center justify-center shrink-0">
                          <Quote size={9} className="rotate-180" />
                        </span>
                        <span className="text-[10px] font-extrabold uppercase tracking-wider text-indigo-600 dark:text-indigo-300">
                          Replying to Buzz AI
                        </span>
                      </div>
                      <p className="text-xs text-slate-700 dark:text-slate-200 line-clamp-2 italic font-medium leading-snug break-words min-w-0">
                        "{quotedText}"
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={() => {
                        triggerHaptic("light");
                        setQuotedText("");
                      }}
                      title="Remove quote"
                      aria-label="Remove quote"
                      className="w-6 h-6 rounded-full bg-slate-200/80 dark:bg-white/[0.08] hover:bg-rose-500/20 text-slate-500 dark:text-slate-300 hover:text-rose-500 dark:hover:text-rose-400 flex items-center justify-center shrink-0 transition-colors cursor-pointer border border-black/5 dark:border-white/10"
                    >
                      <X size={12} />
                    </button>
                  </div>
                </motion.div>
              )}
            </AnimatePresence>

            {/* Pending Multi-Image / Multi-Video Attachments Preview Bar */}
            <AnimatePresence initial={false}>
              {pendingAttachments.length > 0 && (
                <motion.div
                  initial={{ opacity: 0, height: 0, y: 8 }}
                  animate={{ opacity: 1, height: "auto", y: 0 }}
                  exit={{ opacity: 0, height: 0, y: 8 }}
                  transition={{ type: "spring", stiffness: 460, damping: 32, mass: 0.65 }}
                  className="mb-2.5 overflow-hidden"
                >
                  <div className="p-2 rounded-2xl bg-slate-100/90 dark:bg-white/[0.04] border border-slate-200/80 dark:border-white/10 shadow-inner">
                    <div className="flex items-center justify-between px-1 mb-1.5">
                      <span className="text-[10px] font-extrabold uppercase tracking-wider text-indigo-600 dark:text-indigo-400 flex items-center gap-1.5">
                        <ImageIcon size={11} />
                        {pendingAttachments.length}/{MAX_MEDIA_ATTACHMENTS}{" "}
                        {pendingAttachments.length === 1 ? "media file ready" : "media files ready"}
                      </span>
                      {pendingAttachments.length > 1 && (
                        <button
                          type="button"
                          onClick={() => {
                            triggerHaptic("light");
                            pendingAttachmentsRef.current = [];
                            setPendingAttachments([]);
                          }}
                          className="text-[10px] font-bold text-slate-500 hover:text-rose-500 dark:text-slate-400 dark:hover:text-rose-400 transition-colors cursor-pointer"
                        >
                          Clear all
                        </button>
                      )}
                    </div>
                    <div className="flex items-center gap-2 overflow-x-auto pb-0.5 pt-0.5 custom-scrollbar">
                      <AnimatePresence mode="popLayout" initial={false}>
                        {pendingAttachments.map((att, idx) => (
                          <motion.div
                            layout
                            key={att.id}
                            initial={{ opacity: 0, scale: 0.8, y: 6 }}
                            animate={{ opacity: 1, scale: 1, y: 0 }}
                            exit={{ opacity: 0, scale: 0.75, y: 4 }}
                            transition={{
                              type: "spring",
                              stiffness: 500,
                              damping: 30,
                              mass: 0.6,
                              delay: idx * 0.025,
                            }}
                            onClick={() => {
                              triggerHaptic("light");
                              setPreviewLightbox({
                                attachments: pendingAttachments,
                                index: idx,
                              });
                            }}
                            className="relative group w-16 h-16 sm:w-[70px] sm:h-[70px] rounded-[16px] overflow-hidden bg-slate-900 border border-indigo-500/35 shrink-0 shadow-md cursor-pointer"
                          >
                            {att.kind === "video" ? (
                              <video
                                src={att.previewUrl}
                                muted
                                playsInline
                                className="w-full h-full object-cover transition-transform duration-300 group-hover:scale-105"
                              />
                            ) : (
                              <img
                                src={att.previewUrl}
                                alt={att.name}
                                className="w-full h-full object-cover transition-transform duration-300 group-hover:scale-105"
                              />
                            )}
                            <div className="pointer-events-none absolute inset-x-0 bottom-0 h-6 bg-gradient-to-t from-black/80 to-transparent" />
                            <div className="pointer-events-none absolute bottom-1 left-1.5 flex items-center gap-1 text-[8px] font-extrabold text-white/95 tracking-wide">
                              {att.kind === "video" ? <Film size={8} /> : <ImageIcon size={8} />}
                              <span className="uppercase">{att.kind}</span>
                            </div>
                            <motion.button
                              whileHover={{ scale: 1.12 }}
                              whileTap={{ scale: 0.88 }}
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation();
                                handleRemovePendingAttachment(att.id);
                              }}
                              title="Remove attachment"
                              className="absolute top-1 right-1 w-5 h-5 rounded-full bg-slate-950/85 hover:bg-rose-600 text-white flex items-center justify-center border border-white/20 shadow-sm transition-colors cursor-pointer"
                            >
                              <X size={10} />
                            </motion.button>
                          </motion.div>
                        ))}
                      </AnimatePresence>
                      {pendingAttachments.length < MAX_MEDIA_ATTACHMENTS && (
                        <motion.button
                          layout
                          whileHover={{ scale: 1.03 }}
                          whileTap={{ scale: 0.94 }}
                          type="button"
                          disabled={isAiBusy}
                          onClick={() => mediaFileInputRef.current?.click()}
                          title="Add more images or videos"
                          className="w-16 h-16 sm:w-[70px] sm:h-[70px] rounded-[16px] border border-dashed border-indigo-400/45 dark:border-indigo-400/30 hover:border-indigo-500 bg-white/75 dark:bg-white/[0.03] text-indigo-600 dark:text-indigo-300 hover:bg-indigo-50/60 dark:hover:bg-indigo-500/10 flex flex-col items-center justify-center gap-1 shrink-0 transition-colors cursor-pointer"
                        >
                          <Plus size={16} />
                          <span className="text-[9px] font-bold">Add</span>
                        </motion.button>
                      )}
                    </div>
                  </div>
                </motion.div>
              )}
            </AnimatePresence>

            <form
              onSubmit={(e) => {
                e.preventDefault();
                if (isRecording) {
                  stopRecording();
                  return;
                }
                handleSendMessage();
              }}
              className={`flex items-center gap-2 p-1.5 rounded-2xl transition-colors shadow-sm dark:shadow-lg ${
                isRecording
                  ? "bg-slate-900 dark:bg-[#0f1526] border border-indigo-500/45 ring-2 ring-indigo-500/15"
                  : "bg-slate-100/90 dark:bg-slate-900/95 border border-slate-200/90 dark:border-white/[0.1] focus-within:border-indigo-500/60 focus-within:ring-2 focus-within:ring-indigo-500/15"
              }`}
            >
              {isRecording ? (
                <div
                  data-testid="buzz-ai-waveform-panel"
                  className="flex-1 flex items-center gap-2.5 min-w-0 pl-1"
                >
                  {/* Cancel Recording Button */}
                  <button
                    type="button"
                    onClick={cancelRecording}
                    title="Cancel voice input"
                    aria-label="Cancel voice input"
                    className="w-8 h-8 rounded-xl bg-white/[0.07] hover:bg-white/[0.14] text-slate-300 hover:text-white flex items-center justify-center shrink-0 transition-colors active:scale-95 cursor-pointer"
                  >
                    <X size={15} />
                  </button>

                  {/* Live Mic Status & Timer Pill */}
                  <button
                    id="buzz-ai-mic-btn"
                    data-testid="buzz-ai-mic-btn"
                    type="button"
                    onClick={toggleListening}
                    title="Stop listening"
                    className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-xl bg-rose-500/15 border border-rose-500/30 shrink-0 cursor-pointer"
                  >
                    <span className="relative flex h-2 w-2">
                      {isVoiceActive && (
                        <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-rose-400 opacity-80" />
                      )}
                      <span className="relative inline-flex rounded-full h-2 w-2 bg-rose-500" />
                    </span>
                    <span className="font-mono text-[11px] font-bold text-rose-200 tabular-nums">
                      {Math.floor(recordingSeconds / 60)}:
                      {String(recordingSeconds % 60).padStart(2, "0")}
                    </span>
                  </button>

                  {/* High-DPI 60fps Real-Time Web Audio Canvas Waveform */}
                  <div className="flex-1 min-w-0 flex flex-col justify-center px-1">
                    <canvas
                      ref={waveformCanvasRef}
                      aria-label="Live microphone audio waveform"
                      className="w-full h-7 block"
                    />
                    {input.trim() && (
                      <span className="text-[10px] text-indigo-200/90 font-medium truncate leading-tight mt-0.5">
                        {input}
                      </span>
                    )}
                  </div>

                  {/* Finish & Send Voice Command */}
                  <button
                    type="submit"
                    title="Send voice note"
                    aria-label="Send voice note"
                    className="w-9 h-9 rounded-xl bg-gradient-to-tr from-indigo-600 to-purple-600 hover:from-indigo-500 hover:to-purple-500 text-white flex items-center justify-center shadow-md shadow-indigo-600/30 transition-all active:scale-95 shrink-0 cursor-pointer"
                  >
                    <Send size={15} />
                  </button>
                </div>
              ) : isTranscribing ? (
                <div
                  data-testid="buzz-ai-waveform-panel"
                  className="flex-1 flex items-center justify-between gap-3 px-2.5 py-1.5 min-w-0"
                >
                  <div className="flex items-center gap-2.5 min-w-0">
                    <RefreshCw size={15} className="animate-spin text-indigo-500 dark:text-indigo-400 shrink-0" />
                    <span className="text-xs sm:text-sm font-semibold text-slate-700 dark:text-indigo-200 truncate">
                      Transcribing audio...
                    </span>
                  </div>
                </div>
              ) : (
                <>
                  <button
                    id="buzz-ai-mic-btn"
                    data-testid="buzz-ai-mic-btn"
                    type="button"
                    onClick={toggleListening}
                    disabled={isAiBusy}
                    title="Speak with Buzz AI"
                    className="w-9 h-9 rounded-xl flex items-center justify-center shrink-0 transition-all cursor-pointer bg-white dark:bg-white/[0.05] text-slate-600 dark:text-slate-300 hover:bg-slate-200/80 dark:hover:bg-white/[0.1] hover:text-slate-900 dark:hover:text-white border border-slate-200/80 dark:border-transparent active:scale-95 disabled:opacity-40 disabled:cursor-not-allowed"
                  >
                    <Mic size={16} />
                  </button>

                  <button
                    id="buzz-ai-media-btn"
                    data-testid="buzz-ai-media-btn"
                    type="button"
                    onClick={() => {
                      if (isAiBusy || isRecording) return;
                      triggerHaptic("light");
                      mediaFileInputRef.current?.click();
                    }}
                    disabled={isAiBusy}
                    title="Attach images or videos"
                    aria-label="Attach images or videos"
                    className="w-9 h-9 rounded-xl flex items-center justify-center shrink-0 transition-all cursor-pointer bg-white dark:bg-white/[0.05] text-slate-600 dark:text-slate-300 hover:bg-slate-200/80 dark:hover:bg-white/[0.1] hover:text-slate-900 dark:hover:text-white border border-slate-200/80 dark:border-transparent active:scale-95 disabled:opacity-40 disabled:cursor-not-allowed"
                  >
                    <Paperclip size={16} />
                  </button>

                  <textarea
                    ref={inputRef}
                    rows={1}
                    value={input}
                    onPaste={handlePasteMedia}
                    onChange={(e) => {
                      if (isAiBusy || isRecording) return;
                      const val = e.target.value;
                      setInput(val);
                      if (!val) {
                        e.target.style.height = "36px";
                      } else {
                        e.target.style.height = "auto";
                        e.target.style.height = `${Math.min(Math.max(e.target.scrollHeight, 36), 96)}px`;
                      }
                    }}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && !e.shiftKey) {
                        e.preventDefault();
                        if (
                          isAiBusy ||
                          isRecording ||
                          (!input.trim() && pendingAttachments.length === 0 && !quotedText.trim())
                        )
                          return;
                        handleSendMessage();
                      }
                    }}
                    autoComplete="on"
                    autoCorrect="on"
                    autoCapitalize="sentences"
                    spellCheck={true}
                    inputMode="text"
                    enterKeyHint="send"
                    placeholder={
                      isAiBusy
                        ? "Buzz AI is replying..."
                        : quotedText
                        ? "Ask what this quote means or anything else..."
                        : pendingAttachments.length > 0
                        ? "Add a caption..."
                        : "Ask Buzz AI..."
                    }
                    disabled={isAiBusy}
                    readOnly={isAiBusy}
                    className={`flex-1 min-w-0 max-h-24 px-2 py-2 text-xs sm:text-sm bg-transparent focus:outline-none text-slate-900 dark:text-white placeholder:text-slate-400 dark:placeholder:text-slate-500 font-medium resize-none leading-5 disabled:opacity-50 disabled:cursor-not-allowed ${
                      !input
                        ? "h-9 overflow-hidden text-ellipsis whitespace-nowrap"
                        : "min-h-9 overflow-y-auto"
                    }`}
                  />

                  {isAiBusy ? (
                    <motion.button
                      whileHover={{ scale: 1.05 }}
                      whileTap={{ scale: 0.9 }}
                      transition={{ type: "spring", stiffness: 520, damping: 28 }}
                      type="button"
                      onClick={handleStopGeneration}
                      title="Stop generating"
                      aria-label="Stop generating"
                      className="w-9 h-9 rounded-xl bg-gradient-to-tr from-rose-600 to-red-500 hover:from-rose-500 hover:to-red-400 text-white flex items-center justify-center shadow-md shadow-rose-600/30 border border-rose-400/30 transition-colors shrink-0 cursor-pointer"
                    >
                      <Square size={13} className="fill-white text-white" />
                    </motion.button>
                  ) : (
                    <motion.button
                      whileHover={
                        input.trim() || pendingAttachments.length > 0 || quotedText.trim()
                          ? { scale: 1.05 }
                          : undefined
                      }
                      whileTap={
                        input.trim() || pendingAttachments.length > 0 || quotedText.trim()
                          ? { scale: 0.92 }
                          : undefined
                      }
                      transition={{ type: "spring", stiffness: 520, damping: 28 }}
                      type="submit"
                      disabled={!input.trim() && pendingAttachments.length === 0 && !quotedText.trim()}
                      title="Send message"
                      aria-label="Send message"
                      className="w-9 h-9 rounded-xl bg-gradient-to-tr from-indigo-600 to-purple-600 hover:from-indigo-500 hover:to-purple-500 disabled:opacity-30 text-white flex items-center justify-center shadow-md shadow-indigo-600/25 transition-colors shrink-0 cursor-pointer disabled:cursor-not-allowed"
                    >
                      <Send size={15} />
                    </motion.button>
                  )}
                </>
              )}
            </form>
          </div>
        </footer>
          </motion.div>

          {/* Floating Text Selection Toolbar ("Quote" & "Copy") Portaled to document.body */}
          {typeof document !== "undefined" &&
            createPortal(
              <AnimatePresence>
                {selectionPopup && selectionPopup.text && (
                  <div
                    ref={selectionToolbarRef}
                    style={{
                      position: "fixed",
                      left: `${selectionPopup.x}px`,
                      top: `${selectionPopup.y}px`,
                      transform:
                        selectionPopup.placement === "top"
                          ? "translate(-50%, -100%)"
                          : "translate(-50%, 0%)",
                      zIndex: 10000,
                    }}
                    onMouseDown={(e) => {
                      // Prevent clearing selection before button click fires
                      e.preventDefault();
                      e.stopPropagation();
                    }}
                  >
                    <motion.div
                      initial={{
                        opacity: 0,
                        scale: 0.9,
                        y: selectionPopup.placement === "top" ? 5 : -5,
                      }}
                      animate={{ opacity: 1, scale: 1, y: 0 }}
                      exit={{ opacity: 0, scale: 0.9 }}
                      transition={{ type: "spring", stiffness: 540, damping: 32, mass: 0.5 }}
                      className="relative flex items-center gap-1 p-1 rounded-2xl bg-[#0b1020]/95 text-white border border-indigo-400/30 shadow-[0_14px_34px_-6px_rgba(0,0,0,0.75)] ring-1 ring-white/10 backdrop-blur-xl select-none whitespace-nowrap"
                    >
                      <button
                        type="button"
                        onClick={handleQuoteSelection}
                        className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-bold text-white bg-indigo-500/20 hover:bg-indigo-600 border border-indigo-400/30 active:scale-95 transition-all cursor-pointer shadow-2xs"
                      >
                        <Quote size={11} className="text-indigo-300 rotate-180" />
                        <span>Quote</span>
                      </button>
                      <button
                        type="button"
                        onClick={handleCopySelection}
                        className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-semibold text-slate-200 hover:text-white hover:bg-white/12 active:scale-95 transition-all cursor-pointer"
                      >
                        {selectionPopup.copied ? (
                          <>
                            <Check size={12} className="text-emerald-400" />
                            <span className="text-emerald-400 font-bold">Copied</span>
                          </>
                        ) : (
                          <>
                            <Copy size={12} className="text-slate-300" />
                            <span>Copy</span>
                          </>
                        )}
                      </button>
                    </motion.div>
                  </div>
                )}
              </AnimatePresence>,
              document.body
            )}

          {/* Full-screen Lightbox Preview for Chat & Composer Media (Portaled to document.body) */}
          {typeof document !== "undefined" &&
            createPortal(
              <AnimatePresence>
                {previewLightbox && previewLightbox.attachments[previewLightbox.index] && (
                  <motion.div
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0 }}
                    transition={{ duration: 0.18 }}
                    onClick={() => setPreviewLightbox(null)}
                    className="fixed inset-0 z-[9999] bg-black/92 backdrop-blur-xl flex flex-col items-center justify-center p-4 select-none"
                  >
                    <div
                      className="w-full max-w-3xl flex items-center justify-between mb-3 px-2"
                      onClick={(e) => e.stopPropagation()}
                    >
                      <div className="flex items-center gap-2 min-w-0">
                        <span className="px-2.5 py-1 rounded-full bg-white/10 border border-white/15 text-[11px] font-bold text-white shrink-0">
                          {previewLightbox.index + 1} / {previewLightbox.attachments.length}
                        </span>
                      </div>
                      <motion.button
                        whileHover={{ scale: 1.08 }}
                        whileTap={{ scale: 0.9 }}
                        type="button"
                        aria-label="Close image preview"
                        onClick={() => setPreviewLightbox(null)}
                        className="w-9 h-9 rounded-full bg-white/12 hover:bg-white/25 text-white flex items-center justify-center border border-white/20 cursor-pointer"
                      >
                        <X size={18} />
                      </motion.button>
                    </div>

                    <div
                      onClick={(e) => e.stopPropagation()}
                      className="relative max-w-3xl w-full max-h-[78vh] flex items-center justify-center rounded-3xl overflow-hidden bg-slate-950/90 border border-white/15 shadow-2xl"
                    >
                      <motion.div
                        key={
                          previewLightbox.attachments[previewLightbox.index].id ||
                          `lightbox-item-${previewLightbox.index}`
                        }
                        initial={{ opacity: 0, scale: 0.96 }}
                        animate={{ opacity: 1, scale: 1 }}
                        transition={{ type: "spring", stiffness: 460, damping: 32, mass: 0.65 }}
                        className="w-full h-full flex items-center justify-center"
                      >
                        {previewLightbox.attachments[previewLightbox.index].kind === "video" ? (
                          <video
                            src={
                              previewLightbox.attachments[previewLightbox.index].previewUrl ||
                              (previewLightbox.attachments[previewLightbox.index].dataBase64
                                ? `data:${
                                    previewLightbox.attachments[previewLightbox.index].mimeType ||
                                    "video/mp4"
                                  };base64,${
                                    previewLightbox.attachments[previewLightbox.index].dataBase64
                                  }`
                                : "")
                            }
                            controls
                            autoPlay
                            playsInline
                            className="max-h-[76vh] w-auto max-w-full object-contain"
                          />
                        ) : (
                          <img
                            src={
                              previewLightbox.attachments[previewLightbox.index].previewUrl ||
                              (previewLightbox.attachments[previewLightbox.index].dataBase64
                                ? `data:${
                                    previewLightbox.attachments[previewLightbox.index].mimeType ||
                                    "image/jpeg"
                                  };base64,${
                                    previewLightbox.attachments[previewLightbox.index].dataBase64
                                  }`
                                : "")
                            }
                            alt="Attachment preview"
                            className="max-h-[76vh] w-auto max-w-full object-contain select-none"
                          />
                        )}
                      </motion.div>

                      {previewLightbox.attachments.length > 1 && (
                        <>
                          <motion.button
                            whileHover={{ scale: 1.08 }}
                            whileTap={{ scale: 0.9 }}
                            type="button"
                            aria-label="Previous image"
                            onClick={() =>
                              setPreviewLightbox((prev) =>
                                prev
                                  ? {
                                      ...prev,
                                      index:
                                        (prev.index - 1 + prev.attachments.length) %
                                        prev.attachments.length,
                                    }
                                  : null
                              )
                            }
                            className="absolute left-3 top-1/2 -translate-y-1/2 z-10 w-10 h-10 rounded-full bg-black/65 hover:bg-black/85 text-white flex items-center justify-center border border-white/20 shadow-lg cursor-pointer"
                          >
                            <ChevronLeft size={20} />
                          </motion.button>
                          <motion.button
                            whileHover={{ scale: 1.08 }}
                            whileTap={{ scale: 0.9 }}
                            type="button"
                            aria-label="Next image"
                            onClick={() =>
                              setPreviewLightbox((prev) =>
                                prev
                                  ? {
                                      ...prev,
                                      index: (prev.index + 1) % prev.attachments.length,
                                    }
                                  : null
                              )
                            }
                            className="absolute right-3 top-1/2 -translate-y-1/2 z-10 w-10 h-10 rounded-full bg-black/65 hover:bg-black/85 text-white flex items-center justify-center border border-white/20 shadow-lg cursor-pointer"
                          >
                            <ChevronRight size={20} />
                          </motion.button>
                        </>
                      )}
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>,
              document.body
            )}
        </div>
      )}
    </AnimatePresence>
  );
}
