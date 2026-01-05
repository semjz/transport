// /field/fsl/fsl.js

// ---------------------------------------------------------------------------
// CONSTANTS
// ---------------------------------------------------------------------------

const LOGIN_PAGE = "/login";
const $ = (id) => document.getElementById(id);

// ---------------------------------------------------------------------------
// STATUS + TOKEN
// ---------------------------------------------------------------------------

function setStatus(msg) {
  const s = $("status");
  if (s) s.innerText = msg;
  console.log("[FSL][STATUS]", msg);
}

function getTokenFromHash() {
  const hash = location.hash || "";
  const m = hash.match(/(?:^|[#&])t=([^&]+)/);
  return m ? decodeURIComponent(m[1]) : "";
}

// ---------------------------------------------------------------------------
// CSRF
// ---------------------------------------------------------------------------

function getCsrf() {
  return window.csrf_token || "";
}

// ---------------------------------------------------------------------------
// BACKEND LOGGING (optional, NEVER breaks UI)
// ---------------------------------------------------------------------------

async function logClientError(context, error, extra = {}) {
  console.error("[FSL][ClientError]", context, error, extra);

  try {
    const csrf = getCsrf();
    const payload = {
      context,
      message: String(error?.message || error),
      extra,
      url: location.href,
      user_agent: navigator.userAgent,
    };

    await fetch("/api/method/transport.api.fsl.log_client_error", {
      method: "POST",
      credentials: "include",
      headers: {
        "Content-Type": "application/json",
        ...(csrf ? { "X-Frappe-CSRF-Token": csrf } : {}),
      },
      body: JSON.stringify(payload),
    });
  } catch {
    // ignore
  }
}

// ---------------------------------------------------------------------------
// FILE + PAYLOAD
// ---------------------------------------------------------------------------

let photoDataUrl = null;

function fileToDataURL(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result || ""));
    r.onerror = () => reject(r.error || new Error("File read error"));
    r.readAsDataURL(file);
  });
}

function payloadFromForm() {
  const qtyInput = $("qtyOrWeight");
  const qty = qtyInput?.value ? Number(qtyInput.value) : null;

  return {
    qty_or_weight: qty,
    timestamp: new Date().toISOString(),
    photo_data_url: photoDataUrl,
  };
}

// ---------------------------------------------------------------------------
// DRIVER ID: CACHE + DISPLAY
// ---------------------------------------------------------------------------

let driverCanonicalId = "";
const DRIVER_STORAGE_KEY = "fsl_driver_canonical_id";

function setDriverDisplay(text) {
  const el = $("driverDisplay");
  if (el) el.innerText = text;
}

function getCachedDriverId() {
  try {
    return localStorage.getItem(DRIVER_STORAGE_KEY) || "";
  } catch {
    return "";
  }
}

function cacheDriverId(id) {
  try {
    localStorage.setItem(DRIVER_STORAGE_KEY, id || "");
  } catch {
    // ignore
  }
}

function clearCachedDriverId() {
  try {
    localStorage.removeItem(DRIVER_STORAGE_KEY);
  } catch {
    // ignore
  }
}

function isNotLoggedInError(e) {
  return e?.code === "NOT_LOGGED_IN" || e?.message === "NOT_LOGGED_IN";
}

function redirectToLogin() {
  const redirectTo =
    location.pathname + location.search + location.hash;
  window.location.href =
    LOGIN_PAGE + "?redirect-to=" + encodeURIComponent(redirectTo);
}

// ---------------------------------------------------------------------------
// DRIVER PROFILE API (login check happens here)
// ---------------------------------------------------------------------------

async function fetchDriverProfileFromServer() {
  const res = await fetch("/api/method/transport.api.fsl.get_driver_profile", {
    method: "GET",
    credentials: "include",
  });

  let data = {};
  try {
    data = await res.json();
  } catch (e) {
    await logClientError("driver_profile_json_parse", e, { status: res.status });
  }

  if (res.status === 403) {
    const err = new Error("NOT_LOGGED_IN");
    err.code = "NOT_LOGGED_IN";
    throw err;
  }

  if (!res.ok) {
    const msg = data?.message || "Could not load driver profile";
    throw new Error(msg);
  }

  const msg = data.message || {};
  const cid =
    msg.custom_driver_canonical_id || msg.driver_canonical_id || "";

  if (!cid) {
    throw new Error("Driver canonical_id missing in profile");
  }

  return cid;
}

// ---------------------------------------------------------------------------
// DRIVER INIT: OFFLINE + ONLINE
// ---------------------------------------------------------------------------

function initDriverOffline(cachedId) {
  if (cachedId) {
    driverCanonicalId = cachedId;
    setDriverDisplay(`${driverCanonicalId} (cached)`);
    setStatus(`Offline; using cached driver ${driverCanonicalId}`);
  } else {
    driverCanonicalId = "";
    setDriverDisplay("No cached driver ID");
    setStatus(
      "No cached driver ID and offline. Please log in once while online."
    );
  }
}

async function initDriverOnline(cachedId) {
  setDriverDisplay("Loading…");

  try {
    const cid = await fetchDriverProfileFromServer();
    driverCanonicalId = cid;
    cacheDriverId(cid);
    setDriverDisplay(driverCanonicalId);
    setStatus(`Driver loaded from server: ${driverCanonicalId}`);
  } catch (error) {
    // 🔹 1) Login-related error → redirect
    if (isNotLoggedInError(error)) {
      driverCanonicalId = "";
      clearCachedDriverId();
      setDriverDisplay("Not logged in");
      setStatus("Please log in again to access driver page.");
      await logClientError("driver_profile_not_logged_in", error);

      redirectToLogin();
      return;
    }

    // 🔹 2) Any other error → log + maybe fallback to cache
    console.error("[FSL] driver profile error:", error);
    await logClientError("driver_profile_error", error);

    if (cachedId) {
      driverCanonicalId = cachedId;
      setDriverDisplay(`${driverCanonicalId} (cached)`);
      setStatus(
        `Failed to load driver from server; using cached ${driverCanonicalId}`
      );
    } else {
      driverCanonicalId = "";
      setDriverDisplay("Could not load driver");
      setStatus(error.message || "Failed to load driver profile.");
    }
  }
}

async function initDriverCanonicalId() {
  const cached = getCachedDriverId();

  if (!navigator.onLine) {
    initDriverOffline(cached);
    return;
  }

  await initDriverOnline(cached);
}

// ---------------------------------------------------------------------------
// SERVICE WORKER MESSAGES (no auth here)
// ---------------------------------------------------------------------------

function requestSwSyncQueue() {
  if (!("serviceWorker" in navigator)) return;

  navigator.serviceWorker.ready
    .then((reg) => {
      if (!reg.active) return;
      reg.active.postMessage({ type: "SYNC_QUEUE" });
      console.log("[FSL] Sent SYNC_QUEUE to SW");
    })
    .catch((e) => {
      console.warn("[FSL] SYNC_QUEUE failed:", e);
    });
}

function sendToSwQueue(bodyObj) {
  if (!("serviceWorker" in navigator)) {
    console.warn("[FSL] serviceWorker not supported; cannot queue offline");
    return false;
  }

  const csrf = getCsrf();
  if (!csrf) {
    console.warn("[FSL] Missing CSRF token (sendToSwQueue)");
    return false;
  }

  navigator.serviceWorker.ready
    .then((reg) => {
      if (!reg.active) return;
      reg.active.postMessage({
        type: "QUEUE_FSL",
        headers: {
          "Content-Type": "application/json",
          "X-Frappe-CSRF-Token": csrf,
        },
        payload: bodyObj,
      });
      console.log("[FSL] Sent QUEUE_FSL to SW");
    })
    .catch((e) => {
      console.warn("[FSL] QUEUE_FSL failed:", e);
    });

  return true;
}

// ---------------------------------------------------------------------------
// NEW: listen for SW telling us it has flushed queued drafts
// ---------------------------------------------------------------------------

function handleSwMessage(event) {
  const data = event.data;
  if (!data || !data.type) return;

  if (data.type === "FSL_QUEUE_FLUSHED") {
    // SW finished flushing whatever it could.
    // No new network calls here → no CSRF risk.
    setStatus("Offline drafts synced to server (where possible).");
  }
}

function initSwMessageListener() {
  if (!("serviceWorker" in navigator)) return;
  navigator.serviceWorker.addEventListener("message", handleSwMessage);
}

// ---------------------------------------------------------------------------
// SUBMIT FLOW
// ---------------------------------------------------------------------------

function buildFslBody(item) {
  return {
    qr_token: item.qr_token,
    driver_canonical_id: item.driver_canonical_id,
    payload_json: JSON.stringify(item.payload),
  };
}

async function submitFslOnline(bodyObj, csrf) {
  const res = await fetch(
    "/api/method/transport.api.fsl.upsert_draft_fsl",
    {
      method: "POST",
      credentials: "include",
      headers: {
        "Content-Type": "application/json",
        "X-Frappe-CSRF-Token": csrf,
      },
      body: JSON.stringify(bodyObj),
    }
  );

  let data = {};
  try {
    data = await res.json();
  } catch (e) {
    await logClientError("fsl_submit_json_parse", e, { status: res.status });
  }

  if (!res.ok) {
    const msg = data?.message || "Server error while saving FSL.";
    throw new Error(msg);
  }

  return data.message || {};
}

function submitFslOffline(bodyObj) {
  const ok = sendToSwQueue(bodyObj);
  if (!ok) {
    throw new Error("Could not queue request offline (SW not ready).");
  }
  return { offline: true, queued: true };
}

async function createDraftOnServer(item) {
  const csrf = getCsrf();
  if (!csrf) {
    throw new Error(
      "Missing CSRF token (createDraftOnServer). Please reload and log in again."
    );
  }

  const body = buildFslBody(item);

  if (!navigator.onLine) {
    return submitFslOffline(body);
  }

  try {
    return await submitFslOnline(body, csrf);
  } catch (e) {
    console.warn("[FSL] submit failed, queueing offline:", e);
    await logClientError("fsl_submit_error", e);
    return submitFslOffline(body);
  }
}

// ---------------------------------------------------------------------------
// BOOTSTRAP PAGE
// ---------------------------------------------------------------------------

function initPhotoInput() {
  const input = $("photoInput");
  if (!input) return;

  input.addEventListener("change", async (e) => {
    const file = e.target.files && e.target.files[0];
    if (!file) {
      photoDataUrl = null;
      $("photoStatus").innerText = "No photo selected";
      return;
    }
    try {
      photoDataUrl = await fileToDataURL(file);
      $("photoStatus").innerText = `Selected: ${file.name}`;
    } catch (err) {
      photoDataUrl = null;
      $("photoStatus").innerText = "Failed to read photo";
      console.error("[FSL] fileToDataURL error:", err);
      await logClientError("photo_read_error", err);
    }
  });
}

function initSaveButton() {
  const btn = $("btnSave");
  if (!btn) return;

  btn.addEventListener("click", async () => {
    setStatus("Save clicked...");

    const token = getTokenFromHash();
    if (!token) {
      setStatus("Missing QR token in URL (#t=...).");
      return;
    }

    if (!driverCanonicalId) {
      setStatus(
        "Driver canonical_id not available. Please log in online at least once."
      );
      return;
    }

    const payload = payloadFromForm();
    if (payload.qty_or_weight == null) {
      setStatus("qty_or_weight is required.");
      return;
    }
    if (!payload.photo_data_url) {
      setStatus("Please attach a photo.");
      return;
    }

    const item = {
      qr_token: token,
      driver_canonical_id: driverCanonicalId,
      payload,
    };

    try {
      const r = await createDraftOnServer(item);
      if (r && r.offline && r.queued) {
        setStatus("Saved offline. Will sync automatically when online.");
      } else {
        setStatus(`Saved online. FSL: ${r?.name || r}`);
        requestSwSyncQueue();
      }
    } catch (e) {
      console.error("[FSL] final submit error:", e);
      await logClientError("fsl_submit_final_error", e);
      setStatus(e?.message || "Error while saving.");
    }
  });
}

document.addEventListener("DOMContentLoaded", () => {
  const token = getTokenFromHash();
  $("tokenStatus").innerText = token ? "OK" : "Missing #t= token";
  $("timeStatus").innerText = new Date().toISOString();

  initDriverCanonicalId().catch(async (e) => {
    console.error("[FSL] initDriverCanonicalId failed:", e);
    await logClientError("init_driver_canonical_id", e);
    setStatus(e.message || "Failed to initialise driver profile.");
  });

  if (navigator.onLine) {
    requestSwSyncQueue();
  }
  window.addEventListener("online", requestSwSyncQueue);

  // NEW: start listening for SW messages (incl. flush done)
  initSwMessageListener();

  initPhotoInput();
  initSaveButton();

  setStatus("Ready.");
});
