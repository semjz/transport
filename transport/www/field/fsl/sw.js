// /field/fsl/sw.js

/**
 * GOAL:
 * - Offline shell for /field/fsl/ (driver page)
 * - Offline trips (GET API)
 * - Offline submit via messages (queue & retry on each SYNC)
 * - Redirect navigations to /login if not logged in (when online)
 */

importScripts(
  "/field/fsl/fsl.request.js",
  "/field/fsl/fsl.queue.js",
  "/field/fsl/sw.core.js"
);

// ----- CONSTANTS -----

const STATIC_CACHE = "fsl-static-v1";
const TRIPS_CACHE = "fsl-trips-v1";
const DB_NAME = "fsl_offline_db";
const DB_STORE = "request-queue";

const TRIPS_API_PATH = "/api/method/transport.api.get_driver_trips";
const SUBMIT_API_PATH =
  "/api/method/transport.api.fsl.upsert_draft_fsl";

const CSRF_API_PATH =
  "/api/method/transport.api.fsl.get_csrf_for_fsl";

const LOGIN_STATUS_API = "/api/method/frappe.auth.get_logged_user";
const LOGIN_PAGE = "/login";

// Retry / TTL / size policy
const MAX_RETRIES = 3;
const MAX_QUEUE_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const MAX_QUEUE_ITEMS = 10;
const MAX_ITEMS_PER_FLUSH = 10;

// QueueService instance + core logic
const queueService = new FslQueueService(DB_NAME, DB_STORE);
const SwCore = self.FslSwCore;

// ---------------------------------------------------------------------------
// SMALL HELPERS
// ---------------------------------------------------------------------------

async function parseJsonSafe(res, context, errorCode) {
  let data = {};
  try {
    data = await res.json();
  } catch (e) {
    console.warn("[SW][FSL] " + context + " JSON parse error", e);
    throw new Error(errorCode || "JSON_PARSE_ERROR");
  }
  return data;
}

// Get CSRF token for this session
async function fetchCsrfForFsl() {
  const res = await fetch(CSRF_API_PATH, {
    method: "GET",
    credentials: "include",
  });

  if (res.status === 403) {
    console.warn("[SW][FSL] CSRF fetch got 403 (not logged in)");

    try {
      const clients = await self.clients.matchAll({
        type: "window",
        includeUncontrolled: true,
      });
      clients.forEach((client) => {
        client.postMessage({ type: "FSL_SESSION_EXPIRED" });
      });
    } catch (e) {
      console.warn("[SW][FSL] failed to notify clients on 403:", e);
    }

    throw new Error("CSRF_FOR_FSL_FORBIDDEN");
  }

  if (!res.ok) {
    console.warn("[SW][FSL] CSRF fetch failed with status", res.status);
    throw new Error("CSRF_FOR_FSL_FAILED");
  }

  const data = await parseJsonSafe(
    res,
    "CSRF fetch",
    "CSRF_FOR_FSL_PARSE_ERROR"
  );

  const token =
    (data.message && data.message.csrf_token) ||
    data.csrf_token ||
    data.message;

  if (!token) {
    console.warn("[SW][FSL] CSRF token empty in response", data);
    throw new Error("CSRF_FOR_FSL_EMPTY");
  }

  return token;
}

// Notify pages that the queue is fully flushed
async function notifyClientsQueueFlushed() {
  try {
    const clients = await self.clients.matchAll({ type: "window" });
    for (const client of clients) {
      client.postMessage({ type: "FSL_QUEUE_FLUSHED" });
    }
  } catch (e) {
    console.warn("[SW] failed to notify clients after flush:", e);
  }
}

// Log sync metrics to backend
async function logSyncResult(csrf, metrics) {
  try {
    await fetch(
      "/api/method/transport.api.fsl.log_sync_result",
      {
        method: "POST",
        credentials: "include",
        headers: {
          "Content-Type": "application/json",
          "X-Frappe-CSRF-Token": csrf,
        },
        body: JSON.stringify(metrics),
      }
    );
  } catch (e) {
    console.warn("[SW][FSL] failed to log sync result:", e);
  }
}

// ---------------------------------------------------------------------------
// INSTALL
// ---------------------------------------------------------------------------

self.addEventListener("install", (event) => {
  console.log("[SW] install");
  event.waitUntil(
    (async () => {
      const cache = await caches.open(STATIC_CACHE);
      await cache.addAll([
        "/field/fsl/",
        "/field/fsl/fsl.js",
        "/field/fsl/register-sw.js",
        "/field/fsl/fsl.messages.js",
        "/field/fsl/fsl.request.js",
        "/field/fsl/fsl.queue.js",
        "/field/fsl/sw.core.js",
      ]);
      self.skipWaiting();
    })()
  );
});

// ---------------------------------------------------------------------------
// ACTIVATE
// ---------------------------------------------------------------------------

self.addEventListener("activate", (event) => {
  console.log("[SW] activate");
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys
          .filter((k) => ![STATIC_CACHE, TRIPS_CACHE].includes(k))
          .map((k) => caches.delete(k))
      );
      await self.clients.claim();
      console.log("[SW] clients claimed");
    })()
  );
});

// ---------------------------------------------------------------------------
// FETCH
// ---------------------------------------------------------------------------

self.addEventListener("fetch", (event) => {
  const req = event.request;
  const url = new URL(req.url);

  if (req.method === "GET" && url.pathname === TRIPS_API_PATH) {
    event.respondWith(handleTripsRequest(req));
    return;
  }

  if (req.method === "GET" && url.pathname.startsWith("/field/fsl/")) {
    event.respondWith(handleStaticRequest(req));
    return;
  }

  // All other requests → default network handling
});

// ---------------------------------------------------------------------------
// STATIC (HTML / JS / etc)
// ---------------------------------------------------------------------------

async function handleStaticRequest(req) {
  const url = new URL(req.url);

  if (req.mode === "navigate" && url.pathname.startsWith("/field/fsl/")) {
    try {
      const authRes = await fetch(LOGIN_STATUS_API, { method: "GET" });
      if (authRes.ok) {
        const data = await authRes.json();
        const user = data && data.message;
        if (!user || user === "Guest") {
          const redirectTo = url.pathname + url.search;
          return Response.redirect(
            `${LOGIN_PAGE}?redirect-to=${encodeURIComponent(redirectTo)}`,
            302
          );
        }
      }
    } catch {
      // offline → fall through to cached shell
    }
  }

  const cached = await caches.match(req);
  if (cached) return cached;

  try {
    const res = await fetch(req);
    if (res && res.ok) {
      const cache = await caches.open(STATIC_CACHE);
      cache.put(req, res.clone());
    }
    return res;
  } catch (err) {
    if (req.mode === "navigate") {
      const shell = await caches.match("/field/fsl/");
      if (shell) return shell;
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// TRIPS API
// ---------------------------------------------------------------------------

async function handleTripsRequest(req) {
  try {
    const res = await fetch(req);
    if (res && res.ok) {
      const cache = await caches.open(TRIPS_CACHE);
      cache.put(req, res.clone());
    }
    return res;
  } catch (err) {
    const cached = await caches.match(req);
    if (cached) return cached;

    return new Response(
      JSON.stringify({
        error: "offline",
        message: "هیچ سفر ذخیره‌شده‌ای در دسترس نیست.",
      }),
      {
        status: 503,
        headers: { "Content-Type": "application/json" },
      }
    );
  }
}

// ---------------------------------------------------------------------------
// FLUSH QUEUE – use SwCore.flushQueueCore
// ---------------------------------------------------------------------------

async function flushQueue() {
  console.log("[SW] flushQueue called");

  const all = await queueService.getAll();
  if (!all.length) {
    await notifyClientsQueueFlushed();
    return;
  }

  let csrf;
  try {
    csrf = await fetchCsrfForFsl();
  } catch (e) {
    if (e && e.message === "CSRF_FOR_FSL_FORBIDDEN") {
      console.warn("[SW][FSL] Stopping flush: session not logged in");
      return;
    }
    console.warn("[SW][FSL] Cannot get CSRF, keeping items queued:", e);
    return;
  }

  await SwCore.flushQueueCore({
    queueService,
    sendFn: async (payloadObj) => {
      const res = await fetch(SUBMIT_API_PATH, {
        method: "POST",
        credentials: "include",
        headers: {
          "Content-Type": "application/json",
          "X-Frappe-CSRF-Token": csrf,
        },
        body: JSON.stringify(payloadObj),
      });
      return { ok: !!(res && res.ok), status: res ? res.status : 0 };
    },
    nowMs: Date.now(),
    maxAgeMs: MAX_QUEUE_AGE_MS,
    maxRetries: MAX_RETRIES,
    maxItemsPerFlush: MAX_ITEMS_PER_FLUSH,
    maxQueueItems: MAX_QUEUE_ITEMS,
    logger: {
      async logSync(metrics) {
        await logSyncResult(csrf, metrics);
        if (metrics.queued_after === 0) {
          await notifyClientsQueueFlushed();
        }
      },
      logDrop(item, reason) {
        console.warn("[SW] dropping item", item.id, "reason:", reason);
      },
    },
  });
}

// ---------------------------------------------------------------------------
// MESSAGES FROM PAGE
// ---------------------------------------------------------------------------

self.addEventListener("message", (event) => {
  const data = event.data;
  if (!data || !data.type) return;

  console.log("[SW] message received:", data.type);

  if (data.type === "QUEUE_FSL") {
    const payloadObj = data.payload || {};
    const body = JSON.stringify(payloadObj);
    const now = Date.now();

    const request = new FslRequest({
      url: SUBMIT_API_PATH,
      method: "POST",
      body,
      created_at: now,
      retry_count: 0,
    });

    event.waitUntil(
      (async () => {
        await queueService.enqueue(request);
        await queueService.trimToMax(MAX_QUEUE_ITEMS);
      })()
    );
  }

  if (data.type === "SYNC_QUEUE") {
    event.waitUntil(flushQueue());
  }
});
