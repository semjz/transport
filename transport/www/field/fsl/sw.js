// /field/fsl/sw.js

/**
 * GOAL:
 * - Offline shell for /field/fsl/ (driver page)
 * - Offline trips (GET API)
 * - Offline submit via messages (queue & retry)
 * - Redirect navigations to /login if not logged in (when online)
 */

const STATIC_CACHE = "fsl-static-v1";
const TRIPS_CACHE = "fsl-trips-v1";
const DB_NAME = "fsl_offline_db";
const DB_STORE = "request-queue";

const TRIPS_API_PATH = "/api/method/transport.api.get_driver_trips";
const SUBMIT_API_PATH =
  "/api/method/transport.api.fsl.upsert_draft_fsl";

const LOGIN_STATUS_API = "/api/method/frappe.auth.get_logged_user";
const LOGIN_PAGE = "/login";

/* ---------------- IndexedDB helpers ---------------- */

function openDB() {
  return new Promise((resolve, reject) => {
    try {
      const req = indexedDB.open(DB_NAME, 1);

      req.onupgradeneeded = (event) => {
        const db = event.target.result;
        if (!db.objectStoreNames.contains(DB_STORE)) {
          db.createObjectStore(DB_STORE, {
            keyPath: "id",
            autoIncrement: true,
          });
        }
      };

      req.onsuccess = () => {
        console.log("[SW][IDB] open success");
        resolve(req.result);
      };

      req.onerror = () => {
        console.error("[SW][IDB] open error:", req.error);
        reject(req.error || new Error("IDB open error"));
      };
    } catch (e) {
      console.error("[SW][IDB] open exception:", e);
      reject(e);
    }
  });
}

async function queueRequest(record) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    try {
      const tx = db.transaction(DB_STORE, "readwrite");
      const store = tx.objectStore(DB_STORE);
      store.add(record);

      tx.oncomplete = () => {
        console.log("[SW][IDB] queued record", record);
        resolve(true);
      };
      tx.onerror = () => {
        console.error("[SW][IDB] tx error:", tx.error);
        reject(tx.error || new Error("IDB tx error"));
      };
      tx.onabort = () => {
        console.error("[SW][IDB] tx abort:", tx.error);
        reject(tx.error || new Error("IDB tx abort"));
      };
    } catch (e) {
      console.error("[SW][IDB] queue exception:", e);
      reject(e);
    }
  });
}

async function getQueuedRequests() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    try {
      const tx = db.transaction(DB_STORE, "readonly");
      const store = tx.objectStore(DB_STORE);

      const all = [];
      const req = store.openCursor();

      req.onsuccess = (event) => {
        const cursor = event.target.result;
        if (cursor) {
          all.push({ id: cursor.key, ...cursor.value });
          cursor.continue();
        } else {
          console.log("[SW][IDB] loaded queued records:", all.length);
          resolve(all);
        }
      };
      req.onerror = () => {
        console.error("[SW][IDB] cursor error:", req.error);
        reject(req.error || new Error("IDB cursor error"));
      };
    } catch (e) {
      console.error("[SW][IDB] getQueuedRequests exception:", e);
      reject(e);
    }
  });
}

async function deleteQueuedRequest(id) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    try {
      const tx = db.transaction(DB_STORE, "readwrite");
      const store = tx.objectStore(DB_STORE);
      store.delete(id);

      tx.oncomplete = () => {
        console.log("[SW][IDB] deleted record", id);
        resolve(true);
      };
      tx.onerror = () => {
        console.error("[SW][IDB] delete tx error:", tx.error);
        reject(tx.error || new Error("IDB delete tx error"));
      };
      tx.onabort = () => {
        console.error("[SW][IDB] delete tx abort:", tx.error);
        reject(tx.error || new Error("IDB delete tx abort"));
      };
    } catch (e) {
      console.error("[SW][IDB] delete exception:", e);
      reject(e);
    }
  });
}

/* ---------------- INSTALL ---------------- */

self.addEventListener("install", (event) => {
  console.log("[SW] install");
  event.waitUntil(
    (async () => {
      const cache = await caches.open(STATIC_CACHE);
      await cache.addAll([
        "/field/fsl/",
        "/field/fsl/fsl.js",
        "/field/fsl/register-sw.js",
        // add CSS, logos, etc if needed
      ]);
      self.skipWaiting();
    })()
  );
});

/* ---------------- ACTIVATE ---------------- */

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

/* ---------------- FETCH ---------------- */

self.addEventListener("fetch", (event) => {
  const req = event.request;
  const url = new URL(req.url);

  // Trips API cache
  if (req.method === "GET" && url.pathname === TRIPS_API_PATH) {
    event.respondWith(handleTripsRequest(req));
    return;
  }

  // Static stuff under /field/fsl/
  if (req.method === "GET" && url.pathname.startsWith("/field/fsl/")) {
    event.respondWith(handleStaticRequest(req));
    return;
  }

  // All other requests (including /api POSTs) go straight to network.
});

/* ---------------- STATIC (HTML / JS / etc) ---------------- */

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
    } catch (e) {
      // probably offline
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

/* ---------------- TRIPS API ---------------- */

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
        message: "No cached trips available",
      }),
      {
        status: 503,
        headers: { "Content-Type": "application/json" },
      }
    );
  }
}

/* ---------------- FLUSH QUEUE ---------------- */

async function flushQueue() {
  console.log("[SW] flushQueue called");
  const queued = await getQueuedRequests();

  for (const item of queued) {
    const { id, headers, body } = item;
    try {
      const res = await fetch(SUBMIT_API_PATH, {
        method: "POST",
        headers,
        body,
        // NOTE: this is exactly the same semantics as before +
        // credentials: "include" if you want it; if you *know* your
        // endpoint is csrf_exempt, you can drop CSRF entirely.
        credentials: "include",
      });

      if (res && res.ok) {
        console.log("[SW] flushed record", id);
        await deleteQueuedRequest(id);
      } else {
        console.warn(
          "[SW] queued request failed with status:",
          res && res.status
        );
      }
    } catch (err) {
      console.warn("[SW] queued request failed (network)", err);
      // still offline; keep in DB
    }
  }

  // NEW: tell any open /field/fsl/ page that flush is done
  try {
    const clients = await self.clients.matchAll({ type: "window" });
    for (const client of clients) {
      client.postMessage({ type: "FSL_QUEUE_FLUSHED" });
    }
  } catch (e) {
    console.warn("[SW] failed to notify clients after flush:", e);
  }
}

/* ---------------- MESSAGES FROM PAGE ---------------- */

self.addEventListener("message", (event) => {
  const data = event.data;
  if (!data || !data.type) return;

  console.log("[SW] message received:", data.type);

  if (data.type === "QUEUE_FSL") {
    const headers = data.headers || {};
    const payloadObj = data.payload || {};

    const record = {
      headers,
      body: JSON.stringify(payloadObj),
      timestamp: Date.now(),
    };

    event.waitUntil(queueRequest(record));
  }

  if (data.type === "SYNC_QUEUE") {
    event.waitUntil(flushQueue());
  }
});
