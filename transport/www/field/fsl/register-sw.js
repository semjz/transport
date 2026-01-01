/* Put this in the page: /field/fsl/register-sw.js (or your bundle) */

(async function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) {
    console.log("[SW] not supported");
    return;
  }

  // IMPORTANT:
  // - A SW can only control pages under its scope.
  // - If your page is /field/fsl/ then scope should be "/field/fsl/" (or "/field/").
  // Default scope is based on the SW script location. :contentReference[oaicite:5]{index=5}
  const SW_URL = "/field/fsl/sw.js";
  const SCOPE = "/field/fsl/"; // adjust if you need broader control

  try {
    const reg = await navigator.serviceWorker.register(SW_URL, { scope: SCOPE });
    console.log("[SW] registered:", { scope: reg.scope });

    // Useful debug: show current lifecycle objects
    console.log("[SW] installing:", reg.installing?.state || null);
    console.log("[SW] waiting:", reg.waiting?.state || null);
    console.log("[SW] active:", reg.active?.state || null);
    console.log("[SW] controller now:", navigator.serviceWorker.controller?.scriptURL || null);

    // If there’s already a waiting worker (an update), tell it to activate now
    if (reg.waiting) {
      console.log("[SW] update waiting -> send SKIP_WAITING");
      reg.waiting.postMessage({ type: "SKIP_WAITING" }); // common pattern :contentReference[oaicite:6]{index=6}
    }

    // If a new worker is found later
    reg.addEventListener("updatefound", () => {
      const newWorker = reg.installing;
      if (!newWorker) return;

      console.log("[SW] updatefound, state =", newWorker.state);

      newWorker.addEventListener("statechange", () => {
        console.log("[SW] new worker state =", newWorker.state);

        // When it reaches installed, it’s either waiting (if a controller exists)
        // or it will become active soon (first install).
        if (newWorker.state === "installed") {
          if (navigator.serviceWorker.controller) {
            // We already have a controller => this is an update waiting
            console.log("[SW] new version installed and waiting -> SKIP_WAITING");
            newWorker.postMessage({ type: "SKIP_WAITING" });
          } else {
            // First install: no controller yet (normal!)
            console.log("[SW] first install complete (no controller yet; reload may be needed)");
          }
        }
      });
    });

    // This fires when the SW takes control of this page (or changes)
    let reloadedOnce = false;
    navigator.serviceWorker.addEventListener("controllerchange", () => {
      console.log("[SW] controllerchange ->", navigator.serviceWorker.controller?.scriptURL || null);

      // Best practice: reload once so the controlled page uses the newest SW consistently.
      // web.dev lifecycle guidance: avoid running mixed versions. :contentReference[oaicite:7]{index=7}
      if (!reloadedOnce) {
        reloadedOnce = true;
        window.location.reload();
      }
    });

    // ready resolves when there is an active SW for this scope,
    // but controller can still be null on the first load. :contentReference[oaicite:8]{index=8}
    const readyReg = await navigator.serviceWorker.ready;
    console.log("[SW] ready. active =", readyReg.active?.scriptURL || null);
    console.log("[SW] controller after ready =", navigator.serviceWorker.controller?.scriptURL || null);

    // Optional: sanity-check that your current page is actually in scope
    // (If you’re out of scope, you will NEVER get controlled.)
    if (!location.pathname.startsWith(new URL(reg.scope).pathname)) {
      console.warn("[SW] WARNING: page is OUTSIDE scope; it will never be controlled.", {
        page: location.pathname,
        scopePath: new URL(reg.scope).pathname,
      });
    }
  } catch (err) {
    console.error("[SW] registration failed:", err);
  }
})();
