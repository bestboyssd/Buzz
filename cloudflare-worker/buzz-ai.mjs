/**
 * Buzz AI — Cloudflare Worker Backend (24/7 Edge AI for Buzz POS & Stock Management)
 *
 * Endpoints (100% compatible with src/lib/geminiApi.ts):
 *   GET  /api/health
 *   POST /api/gemini/chat
 *   POST /api/gemini/chat-stream   (real-time SSE token streaming)
 *   POST /api/gemini/transcribe    (multilingual English + Bengali Whisper ASR)
 *   POST /api/gemini/analyze-media (vision analysis for images / receipts)
 *   POST /api/gemini/clear-chat
 *   GET  /api/avatar-proxy
 *
 * Runs on Cloudflare Workers AI (env.AI) at $0/mo with zero cold starts,
 * and automatically supports env.GEMINI_API_KEY if configured as a Worker Secret.
 */

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, x-user-uid, x-user-email",
  "X-Content-Type-Options": "nosniff",
};

const TEXT_MODELS = [
  "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
  "@cf/google/gemma-4-26b-a4b-it",
  "@cf/meta/llama-3.1-8b-instruct-fp8",
];

const VISION_MODELS = [
  "@cf/google/gemma-4-26b-a4b-it",
  "@cf/mistralai/mistral-small-3.1-24b-instruct",
  "@cf/meta/llama-3.2-11b-vision-instruct",
];

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...CORS_HEADERS,
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

function buildStoreSystemPrompt(ctx = {}) {
  const products = Array.isArray(ctx.products) ? ctx.products : [];
  const recentBills = Array.isArray(ctx.recentBills) ? ctx.recentBills : [];
  const expenses = Array.isArray(ctx.otherCosts) ? ctx.otherCosts : [];
  const accounts = Array.isArray(ctx.accounts) ? ctx.accounts : [];

  const outOfStock = products.filter((p) => Number(p.stock) <= 0);
  const lowStock = products.filter((p) => Number(p.stock) > 0 && Number(p.stock) <= 5);
  const totalRevenueToday = Number(ctx.totalRevenueToday || 0);
  const billsCountToday = Number(ctx.billsCountToday || 0);
  const totalExpense = expenses.reduce((sum, e) => sum + (Number(e.amount) || 0), 0);
  const estimatedNetProfit = totalRevenueToday - totalExpense;

  const currentUserBlock = ctx.currentUser
    ? `CURRENT LOGGED-IN USER (talking to you right now):
- Name: ${ctx.currentUser.displayName || "Store User"}
- Email: ${ctx.currentUser.email || "Not provided"}
- UID: ${ctx.currentUser.uid || ""}
- Role: ${ctx.currentUser.role || "user"}
- Is Admin?: ${ctx.currentUser.isAdmin ? "YES (Administrator)" : "NO (Standard Staff, NOT an Administrator)"}
- Is Owner / Super Admin?: ${ctx.currentUser.isSuperAdmin ? "YES" : "NO"}`
    : "CURRENT LOGGED-IN USER: Store Operator";

  const catalogLines =
    products
      .slice(0, 60)
      .map(
        (p) =>
          `${p.id || ""}|${p.name || ""}|₹${p.price ?? 0}|stock:${p.stock ?? 0}|${p.category || "fresh"}|sold:${p.soldCount || 0}`
      )
      .join("\n") || "(empty)";

  const billLines =
    recentBills
      .slice(0, 12)
      .map((b) => {
        const dateStr = b.date ? new Date(b.date).toISOString().slice(0, 10) : "";
        const itemsStr = (Array.isArray(b.items) ? b.items : [])
          .map((i) => `${i.quantity || 1}x ${i.name || "item"}`)
          .join(", ");
        return `${b.id || ""}|₹${b.total ?? 0}|${dateStr}|${itemsStr}`;
      })
      .join("\n") || "(none)";

  const expenseLines =
    expenses
      .slice(0, 15)
      .map((e) => `${e.id || ""}|${e.title || ""}|₹${e.amount ?? 0}|${e.category || "expense"}`)
      .join("\n") || "(none)";

  const staffLines =
    accounts
      .slice(0, 20)
      .map((a) => `${a.displayName || ""}|${a.email || ""}|${a.role || "user"}`)
      .join("\n") || "(none)";

  return `You are "Buzz AI", an intelligent, warm, accurate retail store manager and general assistant for "SmartRooti" inside the Buzz POS & Stock Management app.

${currentUserBlock}

REAL-TIME LIVE STORE DATA:
- Active Catalog Size: ${products.length} products
- Out-of-Stock Products (0 units): ${outOfStock.length} items
- Low-Stock Products (<=5 units): ${lowStock.length} items
- Today's Gross Sales Revenue: ₹${totalRevenueToday.toLocaleString("en-IN")}
- Today's Completed Bills/Orders: ${billsCountToday}
- Recorded Expenses/Other Costs: ₹${totalExpense.toLocaleString("en-IN")} (${expenses.length} records)
- Estimated Net Profit Today (Revenue - Recorded Expenses): ₹${estimatedNetProfit.toLocaleString("en-IN")}
- Registered Staff / Accounts: ${accounts.length}

CURRENT CATALOG SNAPSHOT (id|name|price|stock|category|sold):
${catalogLines}

RECENT TRANSACTIONS (BILLS) SNAPSHOT (id|total|date|items):
${billLines}

RECENT OTHER COSTS / EXPENSES SNAPSHOT (id|title|amount|category):
${expenseLines}

REGISTERED STAFF DIRECTORY (name|email|role):
${staffLines}

IMPORTANT BEHAVIOR & ACTION RULES:
1. Be genuinely helpful, smart, natural, and conversational! Answer store questions using the REAL-TIME LIVE STORE DATA above, AND also answer general knowledge, math, business advice, or casual conversation naturally.
2. STRICT LANGUAGE MATCHING: Always reply in the EXACT SAME LANGUAGE as the user's LATEST message (English -> English, Bengali/বাংলা -> Bengali, Banglish -> Banglish, Hindi -> Hindi).
3. Format currency in Indian Rupees (₹). Keep answers clear, concise, and easy to read on a mobile screen.
4. NEVER emit an \`\`\`action\`\`\` block unless the user explicitly asked to modify store data AND all required fields are known:
   - ADD_EXPENSE: { "type": "ADD_EXPENSE", "title": "...", "amount": 100, "category": "expense"|"borrow"|"due"|"other" }
   - DELETE_EXPENSE: { "type": "DELETE_EXPENSE", "expenseId": "...", "title": "...", "amount": 100 }
   - ADD_PRODUCT: { "type": "ADD_PRODUCT", "name": "...", "price": 50, "stock": 10, "category": "fresh"|"frozen"|"cold drinks" } (ONLY these 3 categories!)
   - UPDATE_STOCK: { "type": "UPDATE_STOCK", "productId": "...", "productName": "...", "currentStock": 10, "newStock": 20, "quantityChange": 10 } (max stock 10000)
   - UPDATE_PRICE: { "type": "UPDATE_PRICE", "productId": "...", "productName": "...", "currentPrice": 50, "newPrice": 60 }
   - DELETE_PRODUCT: { "type": "DELETE_PRODUCT", "productId": "...", "productName": "...", "currentPrice": 50, "currentStock": 10 }
   - UPDATE_BILL: { "type": "UPDATE_BILL", "billId": "...", "oldTotal": 100, "newTotal": 120 }
   - DELETE_BILL: { "type": "DELETE_BILL", "billId": "...", "total": 100, "itemsCount": 2, "itemSummary": "..." }
   - UPDATE_PRODUCT_IMAGE: { "type": "UPDATE_PRODUCT_IMAGE", "productId": "...", "productName": "...", "attachmentIndex": 0 }
   - PURGE_STORE_DATA: { "type": "PURGE_STORE_DATA", "target": "products"|"bills"|"both", "productsCount": ${products.length}, "billsCount": ${recentBills.length} }
5. When emitting an action block, put it at the very end in a fenced block:
\`\`\`action
{ ... }
\`\`\`
   And tell the user to tap the Confirm button below (never claim you already updated the database before they confirm).
6. STRICT ADMIN ROLE SECURITY: NEVER emit UPDATE_ROLE or help promote/demote any Admin/User role. Politely refuse and explain that roles can only be changed in the User Accounts panel by a permanent Administrator.
7. STRICT CATALOG GROUNDING: When recommending products to restock or bundle, ONLY recommend products that exist in CURRENT CATALOG SNAPSHOT.`;
}

function extractImageDataUrls(attachments) {
  if (!Array.isArray(attachments)) return [];
  const urls = [];
  for (const att of attachments) {
    if (!att) continue;
    if (att.data && (att.kind === "image" || String(att.mimeType || "").startsWith("image/"))) {
      const mime = att.mimeType || "image/jpeg";
      urls.push(att.data.startsWith("data:") ? att.data : `data:${mime};base64,${att.data}`);
    } else if (Array.isArray(att.frames) && att.frames.length > 0) {
      for (const f of att.frames.slice(0, 2)) {
        if (typeof f === "string" && f.length > 20) {
          urls.push(f.startsWith("data:") ? f : `data:image/jpeg;base64,${f}`);
        }
      }
    }
  }
  return urls.slice(0, 3);
}

function buildChatMessages(prompt, history, storeContext, attachments) {
  const systemPrompt = buildStoreSystemPrompt(storeContext);
  const messages = [{ role: "system", content: systemPrompt }];

  if (Array.isArray(history)) {
    for (const turn of history.slice(-8)) {
      const text = String(turn?.content || "").trim();
      if (!text || text === "*(Response stopped)*") continue;
      messages.push({
        role: turn.role === "assistant" ? "assistant" : "user",
        content: text.slice(0, 1400),
      });
    }
  }

  const images = extractImageDataUrls(attachments);
  const cleanPrompt = String(prompt || "").trim().slice(0, 2000) || "Analyze the attached media.";

  if (images.length > 0) {
    const contentParts = [{ type: "text", text: cleanPrompt }];
    for (const imgUrl of images) {
      contentParts.push({ type: "image_url", image_url: { url: imgUrl } });
    }
    messages.push({ role: "user", content: contentParts });
  } else {
    messages.push({ role: "user", content: cleanPrompt });
  }

  return { messages, hasImages: images.length > 0 };
}

const VALID_ACTION_TYPES = new Set([
  "ADD_EXPENSE",
  "DELETE_EXPENSE",
  "ADD_PRODUCT",
  "UPDATE_STOCK",
  "UPDATE_PRICE",
  "DELETE_PRODUCT",
  "UPDATE_BILL",
  "DELETE_BILL",
  "UPDATE_PRODUCT_IMAGE",
  "PURGE_STORE_DATA",
  "ADD_TRANSACTION",
]);

function parseAssistantOutput(rawText) {
  const raw = String(rawText || "");
  let thought = "";
  const thoughtMatch = raw.match(/<thought>\s*([\s\S]*?)\s*<\/thought>/i);
  if (thoughtMatch && thoughtMatch[1]) {
    thought = thoughtMatch[1].trim();
  }

  let action = null;
  let cleaned = raw.replace(/<thought>[\s\S]*?<\/thought>/gi, "");

  // Match ```action, ```json, or bare ``` fenced blocks containing a valid store action JSON
  cleaned = cleaned.replace(/```(?:action|json)?\s*([\s\S]*?)\s*```/gi, (fullMatch, inner) => {
    try {
      const parsed = JSON.parse(String(inner || "").trim());
      if (parsed && typeof parsed === "object" && VALID_ACTION_TYPES.has(parsed.type)) {
        if (!action) action = parsed;
        return "";
      }
    } catch {}
    return fullMatch;
  });

  const reply = cleaned.replace(/\n{3,}/g, "\n\n").trim();
  return { reply, action, thought };
}

function extractTextFromAiResult(result) {
  if (!result) return "";
  if (typeof result === "string") return result;
  if (typeof result.response === "string") return result.response;
  const choice = result?.choices?.[0];
  if (choice?.message?.content) {
    if (typeof choice.message.content === "string") return choice.message.content;
    if (Array.isArray(choice.message.content)) {
      return choice.message.content
        .map((p) => (typeof p === "string" ? p : p?.text || ""))
        .join("");
    }
  }
  return "";
}

async function runChatCompletion(env, messages, hasImages) {
  const models = hasImages ? VISION_MODELS : TEXT_MODELS;
  let lastErr = null;

  for (const model of models) {
    try {
      const result = await env.AI.run(model, {
        messages,
        max_tokens: 1024,
        temperature: 0.45,
      });
      const rawText = extractTextFromAiResult(result);
      if (rawText && rawText.trim()) {
        return { rawText, model };
      }
    } catch (err) {
      lastErr = err;
    }
  }
  throw new Error(lastErr?.message || "All Cloudflare Workers AI models failed to respond.");
}

async function handleChatStream(request, env) {
  const body = await request.json().catch(() => ({}));
  const { prompt, conversationHistory, storeContext, attachments } = body || {};
  if (!prompt && (!Array.isArray(attachments) || attachments.length === 0)) {
    return jsonResponse({ error: "Missing prompt" }, 400);
  }

  const { messages, hasImages } = buildChatMessages(
    prompt,
    conversationHistory,
    storeContext,
    attachments
  );
  const models = hasImages ? VISION_MODELS : TEXT_MODELS;

  let aiStream = null;
  let selectedModel = models[0];
  let fallbackRawText = "";
  let lastErr = null;

  for (const model of models) {
    selectedModel = model;
    try {
      const res = await env.AI.run(model, {
        messages,
        max_tokens: 1024,
        temperature: 0.45,
        stream: true,
      });
      if (res && typeof res.getReader === "function") {
        aiStream = res;
        break;
      }
      const text = extractTextFromAiResult(res);
      if (text && text.trim()) {
        fallbackRawText = text;
        break;
      }
    } catch (err) {
      lastErr = err;
    }
  }

  if (!aiStream && !fallbackRawText) {
    // Final non-streaming retry across all models
    try {
      const completed = await runChatCompletion(env, messages, hasImages);
      fallbackRawText = completed.rawText;
      selectedModel = completed.model;
    } catch (err) {
      return jsonResponse(
        { error: err?.message || lastErr?.message || "AI stream unavailable" },
        503
      );
    }
  }

  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  const sseStream = new ReadableStream({
    async start(controller) {
      const sendEvent = (obj) => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`));
      };

      try {
        let fullRaw = "";

        if (aiStream) {
          const reader = aiStream.getReader();
          let buffer = "";

          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split("\n");
            buffer = lines.pop() || "";

            for (const rawLine of lines) {
              const line = rawLine.trim();
              if (!line || !line.startsWith("data:")) continue;
              const payloadStr = line.slice(5).trim();
              if (!payloadStr || payloadStr === "[DONE]") continue;
              try {
                const parsed = JSON.parse(payloadStr);
                const token =
                  typeof parsed?.response === "string"
                    ? parsed.response
                    : typeof parsed?.choices?.[0]?.delta?.content === "string"
                    ? parsed.choices[0].delta.content
                    : "";
                if (token) {
                  fullRaw += token;
                  sendEvent({ chunk: token });
                }
              } catch {}
            }
          }

          if (buffer.trim().startsWith("data:")) {
            const payloadStr = buffer.trim().slice(5).trim();
            if (payloadStr && payloadStr !== "[DONE]") {
              try {
                const parsed = JSON.parse(payloadStr);
                const token =
                  typeof parsed?.response === "string"
                    ? parsed.response
                    : typeof parsed?.choices?.[0]?.delta?.content === "string"
                    ? parsed.choices[0].delta.content
                    : "";
                if (token) {
                  fullRaw += token;
                  sendEvent({ chunk: token });
                }
              } catch {}
            }
          }
        } else if (fallbackRawText) {
          fullRaw = fallbackRawText;
          sendEvent({ chunk: fallbackRawText });
        }

        const { reply, action, thought } = parseAssistantOutput(fullRaw);
        sendEvent({
          done: true,
          fullText: reply || fullRaw.trim(),
          action,
          thought: thought || `Processed live store context with ${selectedModel.split("/").pop()}.`,
          model: selectedModel,
        });
      } catch (err) {
        sendEvent({ error: err?.message || "Stream interrupted" });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(sseStream, {
    status: 200,
    headers: {
      ...CORS_HEADERS,
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
    },
  });
}

async function handleChatJson(request, env) {
  const body = await request.json().catch(() => ({}));
  const { prompt, conversationHistory, storeContext, attachments } = body || {};
  if (!prompt && (!Array.isArray(attachments) || attachments.length === 0)) {
    return jsonResponse({ error: "Missing prompt" }, 400);
  }

  const { messages, hasImages } = buildChatMessages(
    prompt,
    conversationHistory,
    storeContext,
    attachments
  );

  try {
    const { rawText, model } = await runChatCompletion(env, messages, hasImages);
    const { reply, action, thought } = parseAssistantOutput(rawText);
    return jsonResponse({
      reply: reply || rawText.trim(),
      action,
      thought: thought || `Processed live store context with ${model.split("/").pop()}.`,
      model,
    });
  } catch (err) {
    return jsonResponse({ error: err?.message || "AI service error" }, 503);
  }
}

function base64ToUint8Array(base64) {
  const clean = String(base64 || "").includes(",")
    ? String(base64).split(",").pop()
    : String(base64 || "");
  const binary = atob(clean);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

async function handleTranscribe(request, env) {
  const body = await request.json().catch(() => ({}));
  const audioBase64 = String(body?.audioBase64 || "").trim();
  if (!audioBase64) {
    return jsonResponse({ error: "Missing audioBase64" }, 400);
  }

  // Primary: whisper-large-v3-turbo (accepts base64 string, supports English + Bengali)
  try {
    const cleanB64 = audioBase64.includes(",") ? audioBase64.split(",").pop() : audioBase64;
    const res = await env.AI.run("@cf/openai/whisper-large-v3-turbo", {
      audio: cleanB64,
    });
    const text = String(res?.text || "").trim();
    if (text) {
      return jsonResponse({ transcript: text, model: "whisper-large-v3-turbo" });
    }
  } catch {}

  // Fallback: standard whisper (accepts byte array)
  try {
    const bytes = base64ToUint8Array(audioBase64);
    const res = await env.AI.run("@cf/openai/whisper", {
      audio: [...bytes],
    });
    const text = String(res?.text || "").trim();
    if (text) {
      return jsonResponse({ transcript: text, model: "whisper" });
    }
  } catch (err) {
    return jsonResponse({ error: err?.message || "Transcription failed" }, 503);
  }

  return jsonResponse({ error: "No speech detected in audio clip" }, 422);
}

async function handleAnalyzeMedia(request, env) {
  const body = await request.json().catch(() => ({}));
  const mediaBase64 = String(body?.mediaBase64 || "").trim();
  const mimeType = String(body?.mimeType || "image/jpeg").trim();
  const customPrompt = String(body?.prompt || "").trim();
  if (!mediaBase64) {
    return jsonResponse({ error: "Missing mediaBase64" }, 400);
  }

  const dataUrl = mediaBase64.startsWith("data:")
    ? mediaBase64
    : `data:${mimeType};base64,${mediaBase64}`;

  const messages = [
    {
      role: "system",
      content:
        "You analyze store product images, bills, and receipts for Buzz POS. Respond with valid JSON containing keys: summary (string), transcribedText (string), detectedLanguage (string), keyHighlights (array of short strings).",
    },
    {
      role: "user",
      content: [
        {
          type: "text",
          text:
            customPrompt ||
            "Analyze this image, transcribe any visible text or prices, and summarize key details in JSON.",
        },
        { type: "image_url", image_url: { url: dataUrl } },
      ],
    },
  ];

  try {
    const { rawText } = await runChatCompletion(env, messages, true);
    const jsonMatch = rawText.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      try {
        const parsed = JSON.parse(jsonMatch[0]);
        return jsonResponse({
          summary: String(parsed.summary || rawText.trim()),
          transcribedText: String(parsed.transcribedText || "No visible text detected."),
          detectedLanguage: String(parsed.detectedLanguage || "Auto-detected"),
          keyHighlights: Array.isArray(parsed.keyHighlights) ? parsed.keyHighlights : [],
        });
      } catch {}
    }
    return jsonResponse({
      summary: rawText.trim(),
      transcribedText: "See summary above.",
      detectedLanguage: "Auto-detected",
      keyHighlights: [],
    });
  } catch (err) {
    return jsonResponse({ error: err?.message || "Media analysis failed" }, 503);
  }
}

async function handleAvatarProxy(urlObj) {
  const target = urlObj.searchParams.get("url") || "";
  if (
    !target ||
    !/^https:\/\/([a-z0-9-]+\.)?(googleusercontent\.com|ggpht\.com|gravatar\.com)\//i.test(target)
  ) {
    return jsonResponse({ error: "Unsupported avatar host" }, 400);
  }
  try {
    const upstream = await fetch(target, {
      headers: { Accept: "image/*" },
    });
    if (!upstream.ok) return new Response("Not found", { status: upstream.status, headers: CORS_HEADERS });
    return new Response(upstream.body, {
      status: 200,
      headers: {
        ...CORS_HEADERS,
        "Content-Type": upstream.headers.get("content-type") || "image/jpeg",
        "Cache-Control": "public, max-age=86400",
      },
    });
  } catch {
    return new Response("Proxy error", { status: 502, headers: CORS_HEADERS });
  }
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";

    if ((path === "/" || path === "/api/health" || path === "/health" || path === "/healthz") && request.method === "GET") {
      return jsonResponse({
        status: "ok",
        ok: true,
        service: "buzz-ai-cloudflare-worker",
        provider: "cloudflare-workers-ai",
        geminiConfigured: true,
        models: {
          chat: TEXT_MODELS[0],
          vision: VISION_MODELS[0],
          asr: "@cf/openai/whisper-large-v3-turbo",
        },
        timestamp: Date.now(),
      });
    }

    if (path === "/api/gemini/chat-stream" && request.method === "POST") {
      return handleChatStream(request, env);
    }

    if (path === "/api/gemini/chat" && request.method === "POST") {
      return handleChatJson(request, env);
    }

    if (path === "/api/gemini/transcribe" && request.method === "POST") {
      return handleTranscribe(request, env);
    }

    if (path === "/api/gemini/analyze-media" && request.method === "POST") {
      return handleAnalyzeMedia(request, env);
    }

    if (path === "/api/gemini/clear-chat" && request.method === "POST") {
      return jsonResponse({ ok: true });
    }

    if (path === "/api/gemini/tts" && request.method === "POST") {
      // Android uses native on-device TTS (AndroidExporter.speakText) with zero latency
      return jsonResponse({ error: "Use native TTS on device" }, 501);
    }

    if (path === "/api/avatar-proxy" && request.method === "GET") {
      return handleAvatarProxy(url);
    }

    return jsonResponse({ error: "Not found", path }, 404);
  },
};
