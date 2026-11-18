/**
 * Buzz AI & 24/7 Edge Operations Server — Cloudflare Worker
 * Live URL: https://buzz-ai.dassusuman2009.workers.dev
 *
 * Bindings:
 *   env.AI              — Cloudflare Workers AI (Llama 3.3 70B, Gemma 4, Whisper v3 Turbo)
 *   env.BUZZ_EVENTS_KV  — Cloudflare KV (Events ring buffer, auth governance, atomic stock state, nightly backups)
 *
 * Cron Trigger:
 *   "30 19 * * *"       — 1:00 AM IST daily shift close: automated Firestore snapshot backup + Daily Store Digest push
 *
 * Endpoints:
 *   GET  /api/health
 *   POST /api/gemini/chat
 *   POST /api/gemini/chat-stream
 *   POST /api/gemini/transcribe
 *   POST /api/gemini/analyze-media
 *   POST /api/gemini/clear-chat
 *   GET  /api/avatar-proxy
 *   POST /api/events/publish          (Notification Hub: stock, broadcast, security, conflict, governance)
 *   GET  /api/events/pull             (Instant offline-to-online catch-up queue by cursor)
 *   GET  /api/events/stream           (Live SSE push stream for online devices)
 *   POST /api/pos/atomic-checkout     (Server-authoritative stock deduction & automatic threshold alert publish)
 *   GET  /api/releases/latest         (Edge-cached GitHub release check, 60s TTL)
 *   GET  /api/github/apk-download     (Resumable HTTP Range APK proxy on Cloudflare CDN)
 *   GET  /api/auth/status             (Edge account governance & lockout mirror)
 *   POST /api/auth/status             (Update edge governance mirror)
 *   GET  /api/backups/list            (List last 30 automated nightly cloud backups)
 *   GET  /api/backups/download        (Download a nightly backup JSON snapshot by ?date=YYYY-MM-DD)
 *   POST /api/backups/run-now         (Trigger an immediate cloud backup + optional digest)
 */

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, Range, x-user-uid, x-user-email",
  "Access-Control-Expose-Headers": "Content-Length, Content-Range, Accept-Ranges, Content-Disposition, Content-Type",
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

const EVENTS_KV_KEY = "events:ring_v1";
const STOCK_STATE_KV_KEY = "pos:stock_state_v1";
const GOVERNANCE_KV_KEY = "auth:governance_v1";
const BACKUP_INDEX_KV_KEY = "backups:index_v1";
const MAX_EVENTS_BUFFER = 200;
const EVENT_RETENTION_MS = 48 * 60 * 60 * 1000; // 48 hours
const DEDUPE_WINDOW_MS = 3 * 60 * 1000; // 3 minutes

const FIRESTORE_PROJECT_ID = "tidy-byte-g5xj8";
const FIRESTORE_DB_ID = "ai-studio-remixbuzzv111-8ceddc6a-4499-4e60-a805-dedb47b5266b";
const FIRESTORE_REST_BASE = `https://firestore.googleapis.com/v1/projects/${FIRESTORE_PROJECT_ID}/databases/${FIRESTORE_DB_ID}/documents`;

function jsonResponse(body, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...CORS_HEADERS,
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      ...extraHeaders,
    },
  });
}

// ============================================================================
// 1. CLOUDFLARE EVENT HUB & OFFLINE-TO-ONLINE CATCH-UP QUEUE (KV-BACKED)
// ============================================================================

async function loadEventStore(env) {
  if (!env?.BUZZ_EVENTS_KV) {
    return { lastCursor: 0, events: [] };
  }
  try {
    const raw = await env.BUZZ_EVENTS_KV.get(EVENTS_KV_KEY, "json");
    if (raw && Array.isArray(raw.events)) {
      const cutoff = Date.now() - EVENT_RETENTION_MS;
      const fresh = raw.events.filter((e) => e && Number(e.timestamp || 0) > cutoff);
      return {
        lastCursor: Number(raw.lastCursor || 0),
        events: fresh,
      };
    }
  } catch {}
  return { lastCursor: 0, events: [] };
}

async function appendEventsToHub(env, rawInputs) {
  const inputs = Array.isArray(rawInputs) ? rawInputs : [rawInputs];
  const store = await loadEventStore(env);
  const now = Date.now();
  let cursor = Math.max(store.lastCursor, now - 1);
  const added = [];

  for (const item of inputs) {
    if (!item || typeof item !== "object") continue;
    const title = String(item.title || "").trim();
    const body = String(item.body || "").trim();
    if (!title && !body) continue;

    const kind = String(item.kind || "stock").trim().toLowerCase();
    const severity = String(item.severity || "normal").trim().toLowerCase();
    const canonicalKey = String(item.canonicalKey || "").trim();
    const id = String(item.id || `${kind}_${now}_${crypto.randomUUID().slice(0, 8)}`).trim();
    const ts = Number(item.timestamp) > 0 ? Number(item.timestamp) : now;

    // Deduplicate by exact ID or canonicalKey within 3-minute window
    const isDuplicate = store.events.some((existing) => {
      if (!existing) return false;
      if (existing.id === id) return true;
      if (
        canonicalKey &&
        existing.canonicalKey &&
        existing.canonicalKey === canonicalKey &&
        Math.abs(now - Number(existing.timestamp || 0)) < DEDUPE_WINDOW_MS
      ) {
        return true;
      }
      return false;
    });
    if (isDuplicate) continue;

    cursor = Math.max(cursor + 1, now);
    const audienceRaw = String(item.targetAudience || "all").trim().toLowerCase();
    const targetAudience =
      audienceRaw === "admins" || audienceRaw === "users" ? audienceRaw : "all";

    const ev = {
      id,
      cursor,
      kind,
      severity,
      title: title || "Buzz POS Alert",
      body,
      canonicalKey: canonicalKey || id,
      targetAudience,
      sourceUid: String(item.sourceUid || "").trim(),
      sourceDeviceId: String(item.sourceDeviceId || "").trim(),
      productId: item.productId ? String(item.productId) : undefined,
      productName: item.productName ? String(item.productName) : undefined,
      stock: item.stock !== undefined ? Number(item.stock) : undefined,
      timestamp: ts,
    };

    store.events.push(ev);
    added.push(ev);
  }

  if (added.length > 0 && env?.BUZZ_EVENTS_KV) {
    const cutoff = now - EVENT_RETENTION_MS;
    const trimmed = store.events
      .filter((e) => Number(e.timestamp || 0) > cutoff)
      .slice(-MAX_EVENTS_BUFFER);
    store.events = trimmed;
    store.lastCursor = cursor;
    await env.BUZZ_EVENTS_KV.put(EVENTS_KV_KEY, JSON.stringify(store));
  }

  return { added, latestCursor: Math.max(store.lastCursor, cursor), totalBuffered: store.events.length };
}

function filterEventsForClient(events, { since, uid, role, deviceId }) {
  const isAdmin = role === "admin" || role === "superadmin" || role === "true";
  return events.filter((ev) => {
    if (!ev) return false;
    if (Number(ev.cursor || 0) <= since) return false;
    if (deviceId && ev.sourceDeviceId && ev.sourceDeviceId === deviceId) return false;
    if (uid && ev.sourceUid && ev.sourceUid === uid && ev.kind !== "security" && ev.kind !== "digest") {
      return false;
    }
    if (ev.targetAudience === "admins" && !isAdmin) return false;
    if (ev.targetAudience === "users" && isAdmin) return false;
    return true;
  });
}

async function handleEventsPublish(request, env) {
  const body = await request.json().catch(() => null);
  if (!body) return jsonResponse({ error: "Invalid JSON body" }, 400);
  const rawList = Array.isArray(body.events) ? body.events : [body];
  const res = await appendEventsToHub(env, rawList);
  return jsonResponse({
    ok: true,
    publishedCount: res.added.length,
    latestCursor: res.latestCursor,
    totalBuffered: res.totalBuffered,
    events: res.added,
  });
}

async function handleEventsPull(url, env) {
  const since = Math.max(0, Number(url.searchParams.get("since") || 0));
  const uid = String(url.searchParams.get("uid") || "").trim();
  const role = String(url.searchParams.get("role") || "user").trim().toLowerCase();
  const deviceId = String(url.searchParams.get("deviceId") || "").trim();

  const store = await loadEventStore(env);
  const matched = filterEventsForClient(store.events, { since, uid, role, deviceId });
  const latestCursor = store.events.reduce(
    (max, e) => Math.max(max, Number(e?.cursor || 0)),
    store.lastCursor || 0
  );

  return jsonResponse({
    ok: true,
    serverTime: Date.now(),
    latestCursor,
    events: matched,
  });
}

async function handleEventsStream(request, url, env) {
  const lastEventId = Number(request.headers.get("Last-Event-ID") || 0);
  let since = Math.max(lastEventId, Number(url.searchParams.get("since") || 0));
  const uid = String(url.searchParams.get("uid") || "").trim();
  const role = String(url.searchParams.get("role") || "user").trim().toLowerCase();
  const deviceId = String(url.searchParams.get("deviceId") || "").trim();

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (payload, eventId) => {
        const idLine = eventId ? `id: ${eventId}\n` : "";
        controller.enqueue(encoder.encode(`${idLine}data: ${JSON.stringify(payload)}\n\n`));
      };

      try {
        // Send initial batch + keep-alive polling window (up to ~20s, EventSource auto-reconnects cleanly)
        const deadline = Date.now() + 20000;
        let firstTick = true;
        while (Date.now() < deadline) {
          const store = await loadEventStore(env);
          const matched = filterEventsForClient(store.events, { since, uid, role, deviceId });
          if (matched.length > 0) {
            for (const ev of matched) {
              if (ev.cursor > since) since = ev.cursor;
              send({ type: "event", event: ev, latestCursor: store.lastCursor }, ev.cursor);
            }
          } else if (firstTick) {
            send({ type: "connected", serverTime: Date.now(), latestCursor: store.lastCursor });
          }
          firstTick = false;
          if (Date.now() + 2500 >= deadline) break;
          await new Promise((r) => setTimeout(r, 2500));
        }
      } catch {
      } finally {
        try {
          controller.close();
        } catch {}
      }
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      ...CORS_HEADERS,
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
    },
  });
}

// ============================================================================
// 2. SERVER-AUTHORITATIVE STOCK DEDUCTION & THRESHOLD DETECTOR
// ============================================================================

function classifyStockDrop(prevStock, nextStock) {
  const prev = Math.max(0, Number(prevStock) || 0);
  const next = Math.max(0, Number(nextStock) || 0);
  if (next >= prev) return null;
  if (next === 0 && prev > 0) return "out_of_stock";
  if (next > 0 && next <= 3 && prev > 3) return "critical_low";
  if (next > 3 && next <= 10 && prev > 10) return "low_stock";
  return null;
}

async function handleAtomicCheckout(request, env) {
  const body = await request.json().catch(() => null);
  const items = Array.isArray(body?.items) ? body.items : [];
  if (items.length === 0) return jsonResponse({ error: "No items provided" }, 400);

  const sourceUid = String(body?.sourceUid || "").trim();
  const sourceDeviceId = String(body?.sourceDeviceId || "").trim();
  const billId = String(body?.billId || `bill_${Date.now()}`).trim();
  const now = Date.now();

  let stockMap = {};
  if (env?.BUZZ_EVENTS_KV) {
    try {
      const saved = await env.BUZZ_EVENTS_KV.get(STOCK_STATE_KV_KEY, "json");
      if (saved && typeof saved === "object") stockMap = saved;
    } catch {}
  }

  const results = [];
  const alertEvents = [];

  for (const item of items) {
    const productId = String(item?.productId || "").trim();
    const productName = String(item?.productName || item?.name || "Product").trim();
    const qty = Math.max(0, Number(item?.quantity) || 0);
    if (!productId || qty <= 0) continue;

    const reportedPrev = item?.prevStock !== undefined ? Number(item.prevStock) : undefined;
    const cachedEntry = stockMap[productId];
    // If another phone billed this same product within the last 10 seconds, use the lower authoritative count
    const useCached =
      cachedEntry &&
      now - Number(cachedEntry.updatedAt || 0) < 15000 &&
      (reportedPrev === undefined || Number(cachedEntry.stock) < reportedPrev);

    const prevStock = useCached
      ? Math.max(0, Number(cachedEntry.stock) || 0)
      : Math.max(0, Number(reportedPrev ?? cachedEntry?.stock ?? qty));
    const nextStock = Math.max(0, prevStock - qty);

    stockMap[productId] = { stock: nextStock, name: productName, updatedAt: now };
    results.push({ productId, productName, prevStock, nextStock, deducted: qty });

    const severity = classifyStockDrop(prevStock, nextStock);
    if (severity) {
      const title =
        severity === "out_of_stock"
          ? "🚫 Out of Stock Alert"
          : severity === "critical_low"
          ? "⚠️ Critical Low Stock"
          : "📉 Low Stock Alert";
      const alertBody =
        severity === "out_of_stock"
          ? `"${productName}" just ran out of stock (0 left)!`
          : severity === "critical_low"
          ? `"${productName}" has only ${nextStock} unit${nextStock === 1 ? "" : "s"} left!`
          : `"${productName}" is running low (${nextStock} left).`;

      alertEvents.push({
        id: `stock_${severity}_${productId}_${nextStock}_${now}`,
        kind: "stock",
        severity,
        title,
        body: alertBody,
        canonicalKey: `stock_canonical_${severity}_${productId}_${nextStock}`,
        targetAudience: "all",
        sourceUid,
        sourceDeviceId,
        productId,
        productName,
        stock: nextStock,
        timestamp: now,
      });
    }
  }

  if (env?.BUZZ_EVENTS_KV) {
    await env.BUZZ_EVENTS_KV.put(STOCK_STATE_KV_KEY, JSON.stringify(stockMap));
  }

  let published = { added: [], latestCursor: 0 };
  if (alertEvents.length > 0) {
    published = await appendEventsToHub(env, alertEvents);
  }

  return jsonResponse({
    ok: true,
    billId,
    deductions: results,
    alertsPublished: published.added.length,
    latestCursor: published.latestCursor,
  });
}

// ============================================================================
// 3. EDGE-CACHED GITHUB RELEASE CHECK & RESUMABLE APK ACCELERATOR
// ============================================================================

async function handleLatestRelease(request, env) {
  const cache = caches.default;
  const cacheKey = new Request("https://buzz-ai.dassusuman2009.workers.dev/__cache/releases-latest");
  const cached = await cache.match(cacheKey);
  if (cached) {
    const body = await cached.text();
    return new Response(body, {
      status: 200,
      headers: {
        ...CORS_HEADERS,
        "Content-Type": "application/json; charset=utf-8",
        "X-Edge-Cache": "HIT",
      },
    });
  }

  // Check KV edge cache (60s freshness across POPs)
  if (env?.BUZZ_EVENTS_KV) {
    try {
      const kvCached = await env.BUZZ_EVENTS_KV.get("releases:latest_v1", "json");
      if (kvCached && Date.now() - Number(kvCached.cachedAt || 0) < 60000) {
        return jsonResponse(kvCached, 200, { "X-Edge-Cache": "KV-HIT" });
      }
    } catch {}
  }

  const ghHeaders = {
    Accept: "application/vnd.github+json",
    "User-Agent": "Buzz-POS-Cloudflare-Edge/1.3.5",
  };

  let payload = null;
  try {
    const res = await fetch("https://api.github.com/repos/bestboyssd/Buzz/releases/latest", {
      headers: ghHeaders,
    });
    if (res.ok) {
      const release = await res.json();
      const apkAsset = Array.isArray(release.assets)
        ? release.assets.find((a) => String(a?.name || "").toLowerCase().endsWith(".apk"))
        : null;
      payload = {
        ok: true,
        tag_name: release.tag_name,
        name: release.name,
        body: release.body || "",
        html_url: release.html_url,
        published_at: release.published_at,
        assets: apkAsset ? [apkAsset] : release.assets || [],
        downloadUrl: apkAsset?.browser_download_url || "",
        sizeBytes: apkAsset?.size || 0,
        cachedAt: Date.now(),
      };
    }
  } catch {}

  // Fallback: github.com/bestboyssd/Buzz/releases/latest HTML redirect NEVER hits API rate limits!
  if (!payload) {
    try {
      const redir = await fetch("https://github.com/bestboyssd/Buzz/releases/latest", {
        method: "GET",
        redirect: "manual",
        headers: { "User-Agent": "Buzz-POS-Cloudflare-Edge/1.3.5" },
      });
      const loc = redir.headers.get("location") || "";
      const tagMatch = loc.match(/\/releases\/tag\/([^/?#]+)/i);
      if (tagMatch && tagMatch[1]) {
        const tag = decodeURIComponent(tagMatch[1]);
        const cleanVer = tag.replace(/^v/i, "");
        const apkName = `Buzz-v${cleanVer}.apk`;
        const dlUrl = `https://github.com/bestboyssd/Buzz/releases/download/${tag}/${apkName}`;
        payload = {
          ok: true,
          tag_name: tag,
          name: `Buzz ${tag}`,
          body: "",
          html_url: `https://github.com/bestboyssd/Buzz/releases/tag/${tag}`,
          published_at: new Date().toISOString(),
          assets: [{ name: apkName, browser_download_url: dlUrl }],
          downloadUrl: dlUrl,
          sizeBytes: 0,
          cachedAt: Date.now(),
        };
      }
    } catch {}
  }

  if (!payload) {
    return jsonResponse({ error: "Could not fetch GitHub release metadata" }, 502);
  }

  const cacheResp = new Response(JSON.stringify(payload), {
    status: 200,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "public, max-age=60",
    },
  });
  await cache.put(cacheKey, cacheResp.clone());
  if (env?.BUZZ_EVENTS_KV) {
    await env.BUZZ_EVENTS_KV.put("releases:latest_v1", JSON.stringify(payload));
  }

  return jsonResponse(payload, 200, { "X-Edge-Cache": "MISS" });
}

async function handleApkDownloadProxy(request, url, env) {
  let targetUrl = String(url.searchParams.get("url") || "").trim();
  if (!targetUrl) {
    // Auto-resolve latest APK URL from cached release metadata
    const relResp = await handleLatestRelease(request, env);
    if (relResp.ok) {
      const relData = await relResp.json().catch(() => null);
      targetUrl = String(relData?.downloadUrl || "");
    }
  }

  if (
    !targetUrl ||
    !/^https:\/\/(github\.com\/bestboyssd\/Buzz\/|api\.github\.com\/repos\/bestboyssd\/Buzz\/|objects\.githubusercontent\.com\/|release-assets\.githubusercontent\.com\/)/i.test(
      targetUrl
    )
  ) {
    return jsonResponse({ error: "Unsupported APK download URL" }, 400);
  }

  const upstreamHeaders = new Headers({
    "User-Agent": "Buzz-POS-Cloudflare-Edge/1.3.5",
    Accept: "application/octet-stream, application/vnd.android.package-archive, */*",
  });
  const rangeHeader = request.headers.get("Range");
  if (rangeHeader) {
    upstreamHeaders.set("Range", rangeHeader);
  }

  try {
    const upstream = await fetch(targetUrl, {
      method: "GET",
      headers: upstreamHeaders,
      redirect: "follow",
    });

    const outHeaders = new Headers(CORS_HEADERS);
    outHeaders.set(
      "Content-Type",
      upstream.headers.get("content-type") || "application/vnd.android.package-archive"
    );
    outHeaders.set("Accept-Ranges", "bytes");
    const cl = upstream.headers.get("content-length");
    if (cl) outHeaders.set("Content-Length", cl);
    const cr = upstream.headers.get("content-range");
    if (cr) outHeaders.set("Content-Range", cr);
    const cd = upstream.headers.get("content-disposition");
    if (cd) outHeaders.set("Content-Disposition", cd);

    return new Response(upstream.body, {
      status: upstream.status,
      headers: outHeaders,
    });
  } catch (err) {
    return jsonResponse({ error: err?.message || "APK proxy failed" }, 502);
  }
}

// ============================================================================
// 4. EDGE ACCOUNT GOVERNANCE & SECURITY LOCKOUT MIRROR
// ============================================================================

async function handleAuthStatusGet(url, env) {
  const uid = String(url.searchParams.get("uid") || "").trim();
  const email = String(url.searchParams.get("email") || "").trim().toLowerCase();

  let state = {
    blockedUids: [],
    blockedEmails: [],
    deletedUids: {},
    deletedEmails: {},
    forcedLogoutAt: 0,
    photoVersions: {},
    updatedAt: 0,
  };
  if (env?.BUZZ_EVENTS_KV) {
    try {
      const saved = await env.BUZZ_EVENTS_KV.get(GOVERNANCE_KV_KEY, "json");
      if (saved && typeof saved === "object") state = { ...state, ...saved };
    } catch {}
  }

  const isOwner = email === "suman.das.199972@gmail.com";
  const isBlocked =
    !isOwner &&
    ((uid && Array.isArray(state.blockedUids) && state.blockedUids.includes(uid)) ||
      (email && Array.isArray(state.blockedEmails) && state.blockedEmails.includes(email)));
  const deletedAt = !isOwner
    ? Math.max(
        Number(state.deletedUids?.[uid] || 0),
        email ? Number(state.deletedEmails?.[email] || 0) : 0
      )
    : 0;
  const photoUpdatedAt = Math.max(
    Number(state.photoVersions?.[uid] || 0),
    email ? Number(state.photoVersions?.[email] || 0) : 0
  );

  return jsonResponse({
    ok: true,
    isBlocked,
    deletedAt,
    forcedLogoutAt: Number(state.forcedLogoutAt || 0),
    photoUpdatedAt,
    updatedAt: Number(state.updatedAt || 0),
  });
}

async function handleAuthStatusPost(request, env) {
  if (!env?.BUZZ_EVENTS_KV) return jsonResponse({ error: "KV not configured" }, 503);
  const body = await request.json().catch(() => null);
  if (!body || typeof body !== "object") return jsonResponse({ error: "Invalid JSON" }, 400);

  let state = {
    blockedUids: [],
    blockedEmails: [],
    deletedUids: {},
    deletedEmails: {},
    forcedLogoutAt: 0,
    photoVersions: {},
    updatedAt: 0,
  };
  try {
    const saved = await env.BUZZ_EVENTS_KV.get(GOVERNANCE_KV_KEY, "json");
    if (saved && typeof saved === "object") state = { ...state, ...saved };
  } catch {}

  if (Array.isArray(body.blockedUids)) state.blockedUids = body.blockedUids;
  if (Array.isArray(body.blockedEmails)) {
    state.blockedEmails = body.blockedEmails.map((e) => String(e).trim().toLowerCase());
  }
  if (body.deletedUids && typeof body.deletedUids === "object") state.deletedUids = body.deletedUids;
  if (body.deletedEmails && typeof body.deletedEmails === "object") state.deletedEmails = body.deletedEmails;
  if (typeof body.forcedLogoutAt === "number") state.forcedLogoutAt = body.forcedLogoutAt;
  if (body.photoVersion && body.photoVersion.key && body.photoVersion.ts) {
    state.photoVersions = state.photoVersions || {};
    state.photoVersions[String(body.photoVersion.key).trim().toLowerCase()] = Number(body.photoVersion.ts);
  }
  state.updatedAt = Date.now();

  await env.BUZZ_EVENTS_KV.put(GOVERNANCE_KV_KEY, JSON.stringify(state));
  return jsonResponse({ ok: true, updatedAt: state.updatedAt });
}

// ============================================================================
// 5. AUTOMATED NIGHTLY CLOUD BACKUPS & DAILY SHIFT-CLOSE Z-REPORT DIGEST
// ============================================================================

function decodeFirestoreValue(val) {
  if (!val || typeof val !== "object") return null;
  if ("stringValue" in val) return val.stringValue;
  if ("integerValue" in val) return Number(val.integerValue);
  if ("doubleValue" in val) return Number(val.doubleValue);
  if ("booleanValue" in val) return Boolean(val.booleanValue);
  if ("nullValue" in val) return null;
  if ("timestampValue" in val) return val.timestampValue;
  if ("arrayValue" in val) {
    return Array.isArray(val.arrayValue?.values)
      ? val.arrayValue.values.map(decodeFirestoreValue)
      : [];
  }
  if ("mapValue" in val) {
    const out = {};
    const fields = val.mapValue?.fields || {};
    for (const [k, v] of Object.entries(fields)) {
      out[k] = decodeFirestoreValue(v);
    }
    return out;
  }
  return null;
}

function decodeFirestoreDoc(docObj) {
  const name = String(docObj?.name || "");
  const id = name.split("/").pop() || "";
  const out = { id };
  const fields = docObj?.fields || {};
  for (const [k, v] of Object.entries(fields)) {
    out[k] = decodeFirestoreValue(v);
  }
  return out;
}

async function fetchFirestoreCollection(collectionName) {
  const res = await fetch(`${FIRESTORE_REST_BASE}/${collectionName}?pageSize=300`);
  if (!res.ok) return [];
  const data = await res.json().catch(() => ({}));
  const docs = Array.isArray(data?.documents) ? data.documents : [];
  return docs.map(decodeFirestoreDoc);
}

function getIstDateIso(ms = Date.now()) {
  const istMs = ms + 5.5 * 60 * 60 * 1000;
  return new Date(istMs).toISOString().slice(0, 10);
}

async function runNightlyBackupAndDigest(env, publishDigest = true) {
  const now = Date.now();
  // Shift close runs at 1:00 AM IST; summarize the business day that just closed (2h earlier is still that IST date)
  const businessDate = getIstDateIso(now - 2 * 60 * 60 * 1000);
  const [products, bills, otherCosts] = await Promise.all([
    fetchFirestoreCollection("products"),
    fetchFirestoreCollection("bills"),
    fetchFirestoreCollection("other_costs"),
  ]);

  // Strip heavy base64 images from nightly KV snapshot to stay well under KV value limits while preserving all data
  const compactProducts = products.map((p) => {
    const copy = { ...p };
    if (typeof copy.image === "string" && copy.image.length > 2000) {
      copy.image = "[omitted-in-auto-backup]";
    }
    return copy;
  });

  const dayBills = bills.filter((b) => {
    const ts = Number(b.date || 0);
    if (!ts) return false;
    return getIstDateIso(ts) === businessDate;
  });
  const dayExpenses = otherCosts.filter((c) => {
    const ts = Number(c.date || 0);
    if (!ts) return false;
    return getIstDateIso(ts) === businessDate;
  });

  const totalRevenue = dayBills.reduce((s, b) => s + (Number(b.total) || 0), 0);
  const totalExpenses = dayExpenses.reduce((s, c) => s + (Number(c.amount) || 0), 0);
  const netProfit = totalRevenue - totalExpenses;
  const outOfStock = products.filter((p) => Number(p.stock) <= 0);
  const criticalLow = products.filter((p) => Number(p.stock) > 0 && Number(p.stock) <= 3);

  const snapshot = {
    backupDate: businessDate,
    createdAt: now,
    source: "cloudflare-nightly-cron",
    summary: {
      productsCount: products.length,
      billsTotalCount: bills.length,
      dayBillsCount: dayBills.length,
      dayRevenue: totalRevenue,
      dayExpenses: totalExpenses,
      dayNetProfit: netProfit,
      outOfStockCount: outOfStock.length,
      criticalLowCount: criticalLow.length,
    },
    products: compactProducts,
    bills,
    other_costs: otherCosts,
  };

  if (env?.BUZZ_EVENTS_KV) {
    const backupKey = `backup:${businessDate}`;
    await env.BUZZ_EVENTS_KV.put(backupKey, JSON.stringify(snapshot), {
      expirationTtl: 31 * 24 * 60 * 60, // 31 days
    });

    let index = [];
    try {
      const savedIdx = await env.BUZZ_EVENTS_KV.get(BACKUP_INDEX_KV_KEY, "json");
      if (Array.isArray(savedIdx)) index = savedIdx;
    } catch {}
    index = [
      { date: businessDate, createdAt: now, summary: snapshot.summary },
      ...index.filter((entry) => entry && entry.date !== businessDate),
    ].slice(0, 30);
    await env.BUZZ_EVENTS_KV.put(BACKUP_INDEX_KV_KEY, JSON.stringify(index));
  }

  if (publishDigest) {
    const oosNames = outOfStock
      .slice(0, 4)
      .map((p) => p.name)
      .filter(Boolean)
      .join(", ");
    const restockNote =
      outOfStock.length > 0
        ? ` | Out of Stock (${outOfStock.length}): ${oosNames}${outOfStock.length > 4 ? "…" : ""}`
        : criticalLow.length > 0
        ? ` | Critical Low: ${criticalLow.length} item(s)`
        : " | Stock healthy";

    await appendEventsToHub(env, {
      id: `digest_${businessDate}_${now}`,
      kind: "digest",
      severity: "normal",
      title: `📊 Daily Store Digest (${businessDate})`,
      body: `Sales: ₹${totalRevenue.toLocaleString("en-IN")} (${dayBills.length} bills) · Expenses: ₹${totalExpenses.toLocaleString("en-IN")} · Net: ₹${netProfit.toLocaleString("en-IN")}${restockNote}`,
      canonicalKey: `daily_digest_${businessDate}`,
      targetAudience: "admins",
      sourceUid: "cloudflare_cron",
      sourceDeviceId: "cloudflare_cron",
      timestamp: now,
    });
  }

  return snapshot.summary;
}

async function handleBackupsList(env) {
  let backups = [];
  if (env?.BUZZ_EVENTS_KV) {
    try {
      const savedIdx = await env.BUZZ_EVENTS_KV.get(BACKUP_INDEX_KV_KEY, "json");
      if (Array.isArray(savedIdx)) backups = savedIdx;
    } catch {}
  }
  return jsonResponse({ ok: true, count: backups.length, backups });
}

async function handleBackupsDownload(url, env) {
  const date = String(url.searchParams.get("date") || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return jsonResponse({ error: "Provide valid ?date=YYYY-MM-DD" }, 400);
  }
  if (!env?.BUZZ_EVENTS_KV) return jsonResponse({ error: "KV not configured" }, 503);
  const raw = await env.BUZZ_EVENTS_KV.get(`backup:${date}`);
  if (!raw) return jsonResponse({ error: `Backup not found for ${date}` }, 404);
  return new Response(raw, {
    status: 200,
    headers: {
      ...CORS_HEADERS,
      "Content-Type": "application/json; charset=utf-8",
      "Content-Disposition": `attachment; filename="buzz-backup-${date}.json"`,
    },
  });
}

// ============================================================================
// 6. BUZZ AI — WORKERS AI CHAT, STREAMING, WHISPER ASR & VISION
// ============================================================================

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
5. When emitting an action block, put it at the very end wrapped in \`\`\`action ... \`\`\` and tell the user to tap Confirm below (never claim you already updated the database before they confirm).
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

function parseAssistantOutput(rawText) {
  const raw = String(rawText || "");
  let thought = "";
  const thoughtMatch = raw.match(/<thought>\s*([\s\S]*?)\s*<\/thought>/i);
  if (thoughtMatch && thoughtMatch[1]) {
    thought = thoughtMatch[1].trim();
  }

  let action = null;
  let cleaned = raw.replace(/<thought>[\s\S]*?<\/thought>/gi, "");

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
    const upstream = await fetch(target, { headers: { Accept: "image/*" } });
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
        version: "1.3.5",
        provider: "cloudflare-workers-ai",
        geminiConfigured: true,
        eventHubEnabled: Boolean(env?.BUZZ_EVENTS_KV),
        features: [
          "ai-chat-stream",
          "whisper-asr",
          "vision-analysis",
          "event-notification-hub",
          "offline-catchup-queue",
          "atomic-stock-alerts",
          "edge-release-cache",
          "resumable-apk-proxy",
          "nightly-backups",
          "daily-digest",
          "edge-auth-governance",
        ],
        models: {
          chat: TEXT_MODELS[0],
          vision: VISION_MODELS[0],
          asr: "@cf/openai/whisper-large-v3-turbo",
        },
        timestamp: Date.now(),
      });
    }

    // Buzz AI endpoints
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
      return jsonResponse({ error: "Use native TTS on device" }, 501);
    }
    if (path === "/api/avatar-proxy" && request.method === "GET") {
      return handleAvatarProxy(url);
    }

    // Priority 1: Server-Side Notification Hub & Offline Catch-Up Queue
    if (path === "/api/events/publish" && request.method === "POST") {
      return handleEventsPublish(request, env);
    }
    if (path === "/api/events/pull" && request.method === "GET") {
      return handleEventsPull(url, env);
    }
    if (path === "/api/events/stream" && request.method === "GET") {
      return handleEventsStream(request, url, env);
    }

    // Priority 2: Atomic Checkout, Release Cache & APK Accelerator, Auth Governance, Nightly Backups
    if (path === "/api/pos/atomic-checkout" && request.method === "POST") {
      return handleAtomicCheckout(request, env);
    }
    if (path === "/api/releases/latest" && request.method === "GET") {
      return handleLatestRelease(request, env);
    }
    if (path === "/api/github/apk-download" && request.method === "GET") {
      return handleApkDownloadProxy(request, url, env);
    }
    if (path === "/api/auth/status" && request.method === "GET") {
      return handleAuthStatusGet(url, env);
    }
    if (path === "/api/auth/status" && request.method === "POST") {
      return handleAuthStatusPost(request, env);
    }
    if (path === "/api/backups/list" && request.method === "GET") {
      return handleBackupsList(env);
    }
    if (path === "/api/backups/download" && request.method === "GET") {
      return handleBackupsDownload(url, env);
    }
    if (path === "/api/backups/run-now" && request.method === "POST") {
      const body = await request.json().catch(() => ({}));
      const summary = await runNightlyBackupAndDigest(env, Boolean(body?.publishDigest));
      return jsonResponse({ ok: true, summary });
    }

    return jsonResponse({ error: "Not found", path }, 404);
  },

  async scheduled(_event, env, ctx) {
    ctx.waitUntil(runNightlyBackupAndDigest(env, true));
  },
};
