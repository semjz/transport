/* /field/fsl/sw.js */

const CACHE = "fsl-field-v4";

// ⚠️ These MUST be real, fetchable URLs
const PRECACHE = [
  "/field/fsl/",
  "/field/fsl/register-sw.js",
  "/field/fsl/fsl.js",
];

/* ---------------- INSTALL ---------------- */
self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE);
      await cache.addAll(PRECACHE);

      // 👉 Move to waiting immediately
      self.skipWaiting();
    })()
  );
});

/* ---------------- ACTIVATE ---------------- */
self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      // ✅ Clean up old caches
      const keys = await caches.keys();
      await Promise.all(
        keys.map((k) => (k !== CACHE ? caches.delete(k) : null))
      );

      // ✅ VERY IMPORTANT:
      // This makes the SW control *already-open* pages
      await self.clients.claim();
    })()
  );
});

/* ---------------- MESSAGES ---------------- */
self.addEventListener("message", (event) => {
  // Allow page to force activation of a waiting SW
  if (event.data?.type === "SKIP_WAITING") {
    self.skipWaiting();
  }
});

/* ---------------- FETCH ---------------- */
self.addEventListener("fetch", (event) => {
  const req = event.request;

  // ❗ Never touch non-GET requests
  if (req.method !== "GET") return;

  event.respondWith(
    (async () => {
      /* ---------- HTML navigation ---------- */
      if (req.mode === "navigate") {
        try {
          // Network-first for HTML (always freshest when online)
          const res = await fetch(req);

          if (res && res.ok) {
            const cache = await caches.open(CACHE);
            cache.put(req, res.clone());
          }

          return res;
        } catch (err) {
          // Offline fallback → app shell
          const cached = await caches.match("/field/fsl/");
          if (cached) return cached;
          throw err;
        }
      }

      /* ---------- Static assets ---------- */
      // Cache-first (fast + offline-safe)
      const cached = await caches.match(req);
      if (cached) return cached;

      try {
        const res = await fetch(req);

        if (res && res.ok) {
          const cache = await caches.open(CACHE);
          cache.put(req, res.clone());
        }

        return res;
      } catch (err) {
        // Offline + uncached → real error
        throw err;
      }
    })()
  );
});
