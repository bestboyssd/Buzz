import React, { useState, useEffect, useRef, useMemo } from "react";
import { motion, AnimatePresence } from "motion/react";
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
          className="font-bold text-slate-900 dark:text-white tracking-wide break-words [overflow-wrap:break-word]"
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
          className="px-1.5 py-0.5 mx-0.5 rounded-md text-[11px] font-mono font-bold bg-indigo-50 dark:bg-white/[0.06] text-indigo-700 dark:text-indigo-300 border border-indigo-200/80 dark:border-white/10 break-words [overflow-wrap:break-word]"
        >
          {codeContent}
        </code>
      );
    }

    // Italic formatting: *italic*
    if (part.startsWith("*") && part.endsWith("*") && part.length >= 2) {
      const italicContent = part.slice(1, -1);
      return (
        <em key={index} className="italic text-slate-600 dark:text-slate-300 break-words [overflow-wrap:break-word]">
          {italicContent}
        </em>
      );
    }

    // Regular plain text
    return (
      <span key={index} className="break-words [overflow-wrap:break-word]">
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

  // Pre-clean action blocks and thoughts from visible text stream
  const cleanText = text
    .replace(/<thought>[\s\S]*?<\/thought>/g, "")
    .replace(/<thought>[\s\S]*$/g, "")
    .replace(/```action[\s\S]*?```/g, "")
    .replace(/```action[\s\S]*$/g, "")
    .trim();

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
        className="text-xs sm:text-sm leading-relaxed text-slate-700 dark:text-slate-200 my-1 break-words [overflow-wrap:break-word]"
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

  return <div className="space-y-1 break-words [overflow-wrap:break-word] min-w-0 w-full">{renderedElements}</div>;
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
      // Drop any legacy preset "Store Snapshot:" fallback messages from cached history
      if (
        m?.role === "assistant" &&
        text.includes("Store Snapshot:") &&
        text.includes("How can I help with your store?")
      ) {
        continue;
      }
      filtered.push({
        ...m,
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

  // Persist non-streaming messages to localStorage (capped at last 40 turns)
  useEffect(() => {
    if (!currentAccountKey) return;
    try {
      const nonStreaming = messages.filter((m) => !m.isStreaming).slice(-40);
      if (nonStreaming.length > 0) {
        localStorage.setItem(currentAccountKey, JSON.stringify(nonStreaming));
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
  const [recordingSeconds, setRecordingSeconds] = useState(0);
  const [executingActionId, setExecutingActionId] = useState<string | null>(null);
  const [expandedThoughts, setExpandedThoughts] = useState<Record<string, boolean>>({});
  const [isKeyboardOpen, setIsKeyboardOpen] = useState(false);

  useEffect(() => {
    if (!isOpen) return;
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
      window.visualViewport?.removeEventListener("resize", handleViewportResize);
      window.removeEventListener("nativeKeyboardStateChanged", handleNativeKeyboard);
    };
  }, [isOpen]);

  const toggleThought = (id: string) => {
    triggerHaptic("light");
    setExpandedThoughts((prev) => ({
      ...prev,
      [id]: !prev[id],
    }));
  };

  const chatContainerRef = useRef<HTMLDivElement>(null);
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

  const inputRef = useRef<HTMLInputElement>(null);
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
    setInput(baseInputRef.current || "");
    stopRecording();
  };

  // Toggle voice recording using Web Speech API with MediaRecorder fallback
  const toggleListening = async () => {
    triggerHaptic("medium");
    setErrorMessage("");

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

        recognition.onerror = (event: any) => {
          console.warn("Speech recognition error:", event.error);
          stopAudioVisualizer();
          if (streamRef.current) {
            streamRef.current.getTracks().forEach((track) => track.stop());
            streamRef.current = null;
          }
          setIsRecording(false);
          if (event.error !== "no-speech" && event.error !== "aborted") {
            startMediaRecorderFallback();
          }
        };

        recognition.onend = () => {
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
          const spoken = latestSpokenTextRef.current.trim();
          latestSpokenTextRef.current = "";
          if (spoken) {
            handleSendMessage(spoken);
          } else {
            inputRef.current?.focus();
          }
        };

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
          return;
        }
        const audioBlob = new Blob(audioChunksRef.current, {
          type: recorder.mimeType || mimeType || "audio/webm",
        });

        if (audioBlob.size < 100) {
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
            handleSendMessage(combined);
          } else {
            setErrorMessage("Could not hear speech clearly. Please try speaking again.");
          }
        } catch (err: any) {
          console.warn("Transcription fallback notice:", err);
          const rawMsg = String(err?.message || "");
          const friendlyMsg =
            rawMsg.startsWith("{") || rawMsg.includes("models/") || rawMsg.includes("NOT_FOUND")
              ? "Voice transcription is temporarily unavailable. Please type your message below."
              : rawMsg || "Could not transcribe voice note. Please try again.";
          setErrorMessage(friendlyMsg);
          triggerHaptic("heavy");
        } finally {
          setIsTranscribing(false);
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

  const fallbackSpeechSynthesis = (id: string, rawText: string, reqId: number) => {
    if (speechRequestIdRef.current !== reqId) return;
    setSynthesizingId(null);
    const speechReadyText = formatTextForSpeech(rawText, 480);
    if (!speechReadyText) {
      setSpeakingId(null);
      return;
    }

    // Native Android TTS bridge (Android System WebView frequently lacks window.speechSynthesis)
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

    try {
      window.speechSynthesis.cancel();
      const utterance = new SpeechSynthesisUtterance(speechReadyText);
      const voices = window.speechSynthesis.getVoices();
      const preferredVoice =
        voices.find(
          (v) =>
            v.lang.startsWith("en") &&
            (v.name.includes("Natural") ||
              v.name.includes("Online") ||
              v.name.includes("Google UK English Female") ||
              v.name.includes("Google US English") ||
              v.name.includes("Samantha") ||
              v.name.includes("Aria") ||
              v.name.includes("Zira"))
        ) ||
        voices.find((v) => v.lang.startsWith("en-IN") || v.lang.startsWith("en-GB") || v.lang.startsWith("en-US")) ||
        voices.find((v) => v.lang.startsWith("en"));

      if (preferredVoice) {
        utterance.voice = preferredVoice;
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
    } catch (e) {
      setSpeakingId(null);
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

    setSynthesizingId(id);
    setSpeakingId(id);

    try {
      // High-definition Gemini Neural TTS (Kore 24kHz voice) with fast 4.5s timeout before native fallback
      const audioUrl = await synthesizeGeminiVoice(speechText, 4500);
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
      // Smoothly fall back to native Android TTS or Web Speech synthesis
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

  const handleSendMessage = async (textToSend?: string) => {
    const promptText = (textToSend || input).trim();
    if (!promptText || loading) return;

    // Ensure any previous speech playback is stopped when sending a new message
    stopAllSpeechPlayback();

    const lowerPrompt = promptText.toLowerCase();
    if (
      lowerPrompt.includes("delete the whole context") ||
      lowerPrompt.includes("delete whole context") ||
      lowerPrompt.includes("delete context") ||
      lowerPrompt.includes("clear context") ||
      lowerPrompt.includes("clear chat") ||
      lowerPrompt.includes("delete history") ||
      lowerPrompt.includes("clear history") ||
      lowerPrompt.includes("start a new chat") ||
      lowerPrompt.includes("start new chat") ||
      lowerPrompt.includes("reset chat")
    ) {
      handleClearHistory();
      return;
    }

    triggerHaptic("medium");
    setInput("");
    setErrorMessage("");

    const userMessage: ChatMessage = {
      id: `user-${Date.now()}`,
      role: "user",
      content: promptText,
      timestamp: Date.now(),
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
      thoughtDuration: 1,
    };

    const newHistory = [...messages, userMessage];

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
    const stopwatchTimer = window.setInterval(() => {
      if (watchdogSettled || abortController.signal.aborted) return;
      const elapsedSec = Math.max(1, Math.floor((Date.now() - sendStartTime) / 1000) + 1);
      setMessages((prev) =>
        prev.map((msg) =>
          msg.id === assistantMsgId && msg.isStreaming
            ? { ...msg, thoughtDuration: elapsedSec }
            : msg
        )
      );
    }, 1000);
    activeStopwatchRef.current = stopwatchTimer;

    const watchdogTimer = window.setTimeout(() => {
      if (watchdogSettled || abortController.signal.aborted) return;
      watchdogSettled = true;
      window.clearInterval(stopwatchTimer);
      activeStopwatchRef.current = null;
      activeWatchdogRef.current = null;
      activeAssistantMsgIdRef.current = null;
      const duration = Math.max(1, Math.round((Date.now() - sendStartTime) / 1000));
      setMessages((prev) =>
        prev
          .map((msg) =>
            msg.id === assistantMsgId
              ? {
                  ...msg,
                  isStreaming: false,
                  thoughtDuration: duration,
                }
              : msg
          )
          .filter((msg) => !(msg.id === assistantMsgId && !msg.content?.trim()))
      );
      setErrorMessage("Request timed out. Please try sending your message again.");
      setLoading(false);
      triggerHaptic("error");
      scrollToBottom(false);
    }, 28000);
    activeWatchdogRef.current = watchdogTimer;

    try {
      const historyPayload = messages
        .filter(
          (m) =>
            m.id !== "welcome-system-msg" &&
            m.id !== "welcome" &&
            m.content?.trim() &&
            !(
              m.role === "assistant" &&
              m.content.includes("Store Snapshot:") &&
              m.content.includes("How can I help with your store?")
            )
        )
        .slice(-8)
        .map((m) => ({
          role: m.role,
          content: m.content,
        }));

      await askGeminiAssistantStream(
        promptText,
        historyPayload,
        storeContext,
        (cleanChunkText) => {
          if (watchdogSettled || abortController.signal.aborted) return;
          const elapsedSec = Math.max(1, Math.round((Date.now() - sendStartTime) / 1000));
          setMessages((prev) =>
            prev.map((msg) =>
              msg.id === assistantMsgId
                ? {
                    ...msg,
                    content: cleanChunkText || msg.content,
                    isStreaming: true,
                    thoughtDuration: Math.max(msg.thoughtDuration || 1, elapsedSec),
                  }
                : msg
            )
          );
          scrollToBottom(false);
        },
        (finalPayload) => {
          if (watchdogSettled || abortController.signal.aborted) return;
          watchdogSettled = true;
          window.clearTimeout(watchdogTimer);
          window.clearInterval(stopwatchTimer);
          activeStopwatchRef.current = null;
          activeWatchdogRef.current = null;
          activeAssistantMsgIdRef.current = null;

          const effectiveReply = String(finalPayload.reply || "").trim();
          const effectiveAction = finalPayload.action || null;

          const elapsedSec = Math.max(1, Math.round((Date.now() - sendStartTime) / 1000));
          const authenticThought =
            finalPayload.thought ||
            generateDynamicThought(promptText, effectiveReply, storeContext);

          setMessages((prev) =>
            prev.map((msg) =>
              msg.id === assistantMsgId
                ? {
                    ...msg,
                    content: effectiveReply || msg.content,
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
        },
        abortController.signal
      );
    } catch (err: any) {
      if (watchdogSettled || abortController.signal.aborted) return;
      watchdogSettled = true;
      window.clearTimeout(watchdogTimer);
      window.clearInterval(stopwatchTimer);
      activeStopwatchRef.current = null;
      activeWatchdogRef.current = null;
      activeAssistantMsgIdRef.current = null;

      const elapsedSec = Math.max(1, Math.round((Date.now() - sendStartTime) / 1000));
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
          const newProdPayload = {
            name: cleanItemName,
            price: Math.min(10000, Math.max(0, Number(item.price) || 0)),
            stock: Math.min(2000, Math.max(0, Number(item.stock) || 0)),
            category: normalizeProductCategory(
              item.category || action.category,
              cleanItemName
            ),
            createdAt: Date.now(),
            soldCount: 0,
          };

          addProductOptimistic({ ...newProdPayload, id: newDocRef.id });
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
    try {
      localStorage.removeItem(currentAccountKey);
    } catch (e) {}
    setMessages([]);
    setInput("");
    setErrorMessage("");
    triggerHaptic("success");
    setClearToastMessage("New chat started");
    setTimeout(() => setClearToastMessage(""), 2400);
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
        <div className="fixed inset-0 z-[120] flex flex-col bg-slate-50/40 dark:bg-[#070a13]/40 backdrop-blur-md text-slate-900 dark:text-slate-100 select-text overflow-hidden h-[100dvh] w-screen top-0 left-0 right-0 bottom-0">
          <motion.div
            initial={{ opacity: 0, y: 24, scale: 0.985 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 20, scale: 0.985 }}
            transition={{ type: "spring", stiffness: 460, damping: 34, mass: 0.72 }}
            className="w-full h-full flex flex-col bg-slate-50 dark:bg-[#070a13] text-slate-900 dark:text-slate-100 relative overflow-hidden transition-colors duration-300"
          >
            {/* Ambient Lighting & Depth Texture */}
            <div className="pointer-events-none absolute -top-32 left-1/2 -translate-x-1/2 w-[720px] h-[400px] bg-[radial-gradient(ellipse_at_center,rgba(99,102,241,0.14)_0%,rgba(168,85,247,0.07)_45%,transparent_70%)] dark:bg-[radial-gradient(ellipse_at_center,rgba(99,102,241,0.12)_0%,rgba(168,85,247,0.06)_45%,transparent_70%)] blur-[90px]" />
            <div className="pointer-events-none absolute bottom-24 right-1/4 w-[500px] h-[300px] bg-[radial-gradient(ellipse_at_center,rgba(79,70,229,0.09)_0%,transparent_70%)] dark:bg-[radial-gradient(ellipse_at_center,rgba(79,70,229,0.08)_0%,transparent_70%)] blur-[100px]" />
            <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(rgba(15,23,42,0.05)_1px,transparent_1px)] dark:bg-[radial-gradient(rgba(255,255,255,0.035)_1px,transparent_1px)] [background-size:26px_26px] opacity-50 dark:opacity-40" />

            {/* Refined Top Bar — padded below mobile status bar (clock, Wi-Fi, battery) */}
            <header className="px-4 sm:px-6 pt-[max(calc(env(safe-area-inset-top,0px)+0.75rem),2.75rem)] sm:pt-3.5 pb-3 border-b border-slate-200/80 dark:border-white/[0.07] flex items-center justify-between shrink-0 bg-white/85 dark:bg-[#090d18]/90 backdrop-blur-xl relative z-10">
              <div className="flex items-center gap-3 min-w-0">
                <motion.div
                  initial={{ scale: 0.85, rotate: -10 }}
                  animate={{ scale: 1, rotate: 0 }}
                  transition={{ type: "spring", stiffness: 500, damping: 26 }}
                  className="relative w-9 h-9 rounded-2xl bg-indigo-600 flex items-center justify-center text-white shadow-md shadow-indigo-500/25 shrink-0 overflow-hidden"
                >
                  <div className="absolute inset-0 bg-gradient-to-tr from-amber-400 via-indigo-500 to-purple-600" />
                  <Zap size={17} className="relative z-10 fill-white text-white" />
                </motion.div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="text-sm sm:text-base font-extrabold tracking-tight text-slate-900 dark:text-white leading-none">
                      Buzz AI
                    </span>
                  </div>
                  <p className="text-[10px] sm:text-[11px] text-slate-500 dark:text-slate-400 font-medium leading-tight mt-0.5 whitespace-nowrap">
                    Store Operations & Inventory
                  </p>
                </div>
              </div>

              <div className="flex items-center gap-2 shrink-0">
                <motion.button
                  whileHover={{ scale: 1.03 }}
                  whileTap={{ scale: 0.94 }}
                  transition={{ type: "spring", stiffness: 520, damping: 28 }}
                  onClick={handleClearHistory}
                  title="Start a new chat"
                  className="h-9 px-3 rounded-xl flex items-center gap-1.5 text-xs font-semibold text-slate-700 dark:text-slate-200 hover:text-slate-950 dark:hover:text-white bg-slate-100/90 dark:bg-white/[0.05] hover:bg-slate-200/80 dark:hover:bg-white/[0.1] border border-slate-200/90 dark:border-white/[0.08] transition-colors cursor-pointer"
                >
                  <RotateCcw size={13} className="text-indigo-600 dark:text-indigo-400" />
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
                  className="w-9 h-9 rounded-xl flex items-center justify-center bg-slate-100/90 dark:bg-white/[0.05] text-slate-600 dark:text-slate-300 hover:bg-slate-200/80 dark:hover:bg-white/[0.1] hover:text-slate-950 dark:hover:text-white transition-colors border border-slate-200/90 dark:border-white/[0.08] cursor-pointer"
                >
                  <X size={16} />
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
          className="flex-1 overflow-y-auto p-4 sm:p-6 space-y-6 custom-scrollbar relative z-10 overscroll-y-none [overflow-anchor:auto] touch-pan-y"
        >
          <div className="max-w-4xl mx-auto w-full space-y-6">
            {messages.map((msg) => {
              const isUser = msg.role === "user";

              if (isUser) {
                return (
                  <motion.div
                    key={msg.id}
                    initial={{ opacity: 0, y: 12, scale: 0.96 }}
                    animate={{ opacity: 1, y: 0, scale: 1 }}
                    transition={{ type: "spring", stiffness: 480, damping: 32, mass: 0.65 }}
                    className="flex justify-end origin-bottom-right"
                  >
                    <div className="w-fit max-w-[85%] sm:max-w-[72%] rounded-2xl rounded-br-xs px-4 py-2.5 sm:px-4.5 sm:py-2.5 bg-gradient-to-r from-indigo-600 via-indigo-600 to-indigo-700 text-white shadow-md shadow-indigo-500/20 dark:shadow-lg dark:shadow-indigo-950/25 border border-indigo-400/30 break-words [overflow-wrap:break-word] min-w-0">
                      <div className="text-xs sm:text-sm leading-relaxed whitespace-pre-wrap font-medium break-words [overflow-wrap:break-word]">
                        {msg.content}
                      </div>
                      <span className="text-[9px] font-medium block mt-1 text-right text-indigo-100/80 dark:text-indigo-200/70 font-mono">
                        {new Date(msg.timestamp).toLocaleTimeString([], {
                          hour: "2-digit",
                          minute: "2-digit",
                        })}
                      </span>
                    </div>
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
                  <div className="flex items-center gap-2 mb-0.5 pl-1 text-[11px]">
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

                  <div className={`${msg.action ? "w-full sm:max-w-[430px]" : "w-fit max-w-[96%] sm:max-w-[88%]"} rounded-2xl rounded-tl-xs p-3.5 sm:p-4 bg-white/95 dark:bg-gradient-to-b dark:from-slate-900/95 dark:via-slate-900/90 dark:to-slate-950/95 border border-slate-200/90 dark:border-slate-700/70 text-slate-800 dark:text-slate-100 shadow-lg shadow-slate-900/[0.04] dark:shadow-xl dark:shadow-black/40 relative backdrop-blur-xl overflow-hidden break-words [overflow-wrap:break-word] min-w-0`}>
                    {/* While Streaming: Compact Thinking Indicator with Live Stopwatch */}
                    {msg.isStreaming && !msg.content && (
                      <div className="flex items-center gap-2.5 py-0.5 px-0.5">
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
                          <span className="ml-1 px-2 py-0.5 rounded-md bg-indigo-500/10 dark:bg-indigo-500/20 border border-indigo-500/25 text-[11px] font-mono font-bold tabular-nums text-indigo-600 dark:text-indigo-300">
                            {msg.thoughtDuration || 1}s
                          </span>
                        </div>
                      </div>
                    )}

                    {/* Formatted Markdown Content with progressive word-by-word streaming cursor */}
                    <div className="text-xs sm:text-[13px] leading-relaxed break-words [overflow-wrap:break-word] min-w-0 w-full">
                      <MarkdownContent
                        text={msg.content}
                        isStreaming={Boolean(msg.isStreaming)}
                      />
                    </div>

                    {/* Interactive Action Confirmation Card (animates and fills in once words complete) */}
                    {!msg.isStreaming && msg.action && (
                      <motion.div
                        initial={{ opacity: 0, y: 10, scale: 0.98 }}
                        animate={{ opacity: 1, y: 0, scale: 1 }}
                        transition={{ type: "spring", stiffness: 460, damping: 30, mass: 0.7 }}
                        className="mt-3.5 pt-3 border-t border-slate-200/80 dark:border-slate-800/80 w-full"
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
                                  },
                                ];
                          const isBatch = batchItems.length > 1;

                          return (
                            <div className="rounded-2xl bg-gradient-to-b from-emerald-50/90 via-white to-emerald-50/40 dark:from-emerald-950/60 dark:via-slate-900/95 dark:to-slate-950 border border-emerald-200/90 dark:border-emerald-500/30 shadow-md shadow-emerald-950/5 dark:shadow-emerald-950/40 overflow-hidden">
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
                                  {batchItems.map((item, idx) => (
                                    <div
                                      key={`${item.name}-${idx}`}
                                      className="flex items-center justify-between gap-2.5 px-3 py-2.5"
                                    >
                                      <div className="min-w-0 flex-1">
                                        <span className="text-xs sm:text-sm font-extrabold text-slate-900 dark:text-white block break-words">
                                          {item.name}
                                        </span>
                                        <span className="text-[10px] font-semibold text-slate-400 dark:text-slate-500 block mt-0.5">
                                          {item.category || "General"}
                                        </span>
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
                                  ))}
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
                      <div className="mt-3 pt-2.5 border-t border-slate-200/80 dark:border-slate-800/70 space-y-2.5">
                        <div className="flex items-center justify-between text-slate-500 dark:text-slate-400 text-[10.5px]">
                          {msg.thought ? (
                            <div className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg border bg-slate-100 dark:bg-slate-800/50 border-slate-200 dark:border-slate-700/50 text-slate-600 dark:text-slate-300 text-[10.5px] font-medium select-none">
                              <Sparkles size={11} className="text-indigo-500 dark:text-indigo-400 shrink-0" />
                              <span>Thought for {msg.thoughtDuration || 1}s</span>
                            </div>
                          ) : (
                            <div className="flex items-center gap-1.5 text-slate-500 dark:text-slate-400">
                              <Zap size={11} className="text-amber-500 dark:text-amber-400 fill-amber-500 dark:fill-amber-400" />
                              <span className="font-mono text-[10px] text-slate-500 dark:text-slate-400">Buzz AI</span>
                            </div>
                          )}
                          <div className="flex items-center gap-3">
                            <button
                              onClick={() => handleSpeakText(msg.id, msg.content)}
                              className="hover:text-indigo-600 dark:hover:text-indigo-300 transition-colors flex items-center gap-1.5 cursor-pointer"
                              title={speakingId === msg.id ? "Stop voice" : "Listen with Gemini Neural Voice"}
                            >
                              {synthesizingId === msg.id ? (
                                <>
                                  <RefreshCw size={12} className="text-indigo-500 dark:text-indigo-400 animate-spin" />
                                  <span className="text-indigo-600 dark:text-indigo-300 text-[10px] font-semibold">Synthesizing...</span>
                                </>
                              ) : speakingId === msg.id ? (
                                <>
                                  <VolumeX size={12} className="text-rose-500 dark:text-rose-400 animate-pulse" />
                                  <span className="text-rose-600 dark:text-rose-400 text-[10px] font-bold">Speaking...</span>
                                </>
                              ) : (
                                <>
                                  <Volume2 size={12} />
                                  <span className="text-[10px]">Listen</span>
                                </>
                              )}
                            </button>

                            <button
                              onClick={() => handleCopyText(msg.id, msg.content)}
                              className="hover:text-slate-900 dark:hover:text-slate-200 transition-colors flex items-center gap-1.5 cursor-pointer"
                              title="Copy text"
                            >
                              {copiedId === msg.id ? (
                                <>
                                  <Check size={12} className="text-emerald-600 dark:text-emerald-400" />
                                  <span className="text-emerald-600 dark:text-emerald-400 text-[10px] font-bold">Copied</span>
                                </>
                              ) : (
                                <>
                                  <Copy size={12} />
                                  <span className="text-[10px]">Copy</span>
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
                <div className="w-full max-w-md grid grid-cols-3 gap-2 p-2 rounded-2xl bg-white/90 dark:bg-white/[0.03] border border-slate-200/90 dark:border-white/[0.07] shadow-sm dark:shadow-none backdrop-blur-md">
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
          className={`border-t border-slate-200/80 dark:border-white/[0.07] bg-white/90 dark:bg-[#090d18]/95 backdrop-blur-xl shrink-0 relative z-10 ${
            isKeyboardOpen
              ? "pb-2"
              : "pb-[max(calc(env(safe-area-inset-bottom,0px)+0.85rem),1.5rem)] sm:pb-3"
          }`}
        >
          <div className="max-w-3xl mx-auto w-full px-3 sm:px-5 pt-2.5 pb-1">
            {errorMessage && (
              <div className="mb-2.5 px-3 py-1.5 rounded-xl bg-red-500/15 border border-red-500/30 text-red-600 dark:text-red-400 text-xs flex items-center justify-between">
                <div className="flex items-center gap-2 min-w-0">
                  <AlertTriangle size={14} className="shrink-0" />
                  <span className="truncate">{errorMessage}</span>
                </div>
                <button
                  type="button"
                  onClick={() => setErrorMessage("")}
                  className="text-red-600 dark:text-red-400 hover:text-red-800 dark:hover:text-red-200 text-[10px] font-bold underline ml-2 shrink-0"
                >
                  Dismiss
                </button>
              </div>
            )}

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
                    disabled={loading}
                    title="Speak with Buzz AI"
                    className="w-9 h-9 rounded-xl flex items-center justify-center shrink-0 transition-all cursor-pointer bg-white dark:bg-white/[0.05] text-slate-600 dark:text-slate-300 hover:bg-slate-200/80 dark:hover:bg-white/[0.1] hover:text-slate-900 dark:hover:text-white border border-slate-200/80 dark:border-transparent active:scale-95 disabled:opacity-40"
                  >
                    <Mic size={16} />
                  </button>

                  <input
                    ref={inputRef}
                    type="text"
                    value={input}
                    onChange={(e) => setInput(e.target.value)}
                    placeholder="Ask Buzz AI or speak a command..."
                    disabled={loading}
                    className="flex-1 min-w-0 px-2 py-2 text-xs sm:text-sm bg-transparent focus:outline-none text-slate-900 dark:text-white placeholder:text-slate-400 dark:placeholder:text-slate-500 font-medium"
                  />

                  {loading ? (
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
                      whileHover={input.trim() ? { scale: 1.05 } : undefined}
                      whileTap={input.trim() ? { scale: 0.92 } : undefined}
                      transition={{ type: "spring", stiffness: 520, damping: 28 }}
                      type="submit"
                      disabled={!input.trim()}
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
        </div>
      )}
    </AnimatePresence>
  );
}
