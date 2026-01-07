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

  const csrf = getCsrf();
  if (!csrf) {
    console.warn("[FSL] Missing CSRF token (logClientError); skipping log");
    return; // don't send a POST without a token
  }

  try {
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
        "X-Frappe-CSRF-Token": csrf,
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

let photoDataUrl = null;           // main waste photo
let safetyPhotoDataUrl = null;     // safety issue photo

function fileToDataURL(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result || ""));
    r.onerror = () => reject(r.error || new Error("File read error"));
    r.readAsDataURL(file);
  });
}

function initFileInput(inputId, statusId, onDataUrlChange, logContext) {
  const input = $(inputId);
  if (!input) return;

  input.addEventListener("change", async (e) => {
    const file = e.target.files && e.target.files[0];

    if (!file) {
      onDataUrlChange(null);
      const statusEl = $(statusId);
      if (statusEl) statusEl.innerText = MSG.FILE_NONE;
      return;
    }

    try {
      const dataUrl = await fileToDataURL(file);
      onDataUrlChange(dataUrl);
      const statusEl = $(statusId);
      if (statusEl) statusEl.innerText = MSG.FILE_SELECTED(file.name);
    } catch (err) {
      onDataUrlChange(null);
      const statusEl = $(statusId);
      if (statusEl) statusEl.innerText = MSG.FILE_READ_ERROR;
      console.error("[FSL] fileToDataURL error:", err);
      await logClientError(logContext, err);
    }
  });
}

function payloadFromForm() {
  const qtyInput = $("qtyOrWeight");
  const qty = qtyInput?.value ? Number(qtyInput.value) : null;

  const packageCountInput = $("packageCount");
  const packageCount = packageCountInput?.value
    ? Number(packageCountInput.value)
    : null;

  const isWasteSafe = $("isWasteSafe")?.checked || false;
  const safetyIssueReason = $("safetyIssueReason")?.value || "";

  const isSafetyCritical = $("isSafetyCritical")?.checked || false;
  const isSafetyResolved = $("isSafetyResolved")?.checked || false;
  const isWasteCollected = $("isWasteCollected")?.checked || false;

  const performedAt = new Date().toISOString();

  const payload = {
    qty_or_weight: qty,
    package_count: packageCount,

    // photos
    photo_data_url: photoDataUrl,

    // safety + outcome
    is_waste_safe: isWasteSafe,
    is_waste_collected: isWasteCollected,

    performed_at: performedAt,
  };

  // Only add safety-issue details when waste is NOT safe
  if (!isWasteSafe) {
    payload.safety_issue_reason = safetyIssueReason;
    payload.safety_issue_photo_data_url = safetyPhotoDataUrl;
    payload.is_safety_critical = isSafetyCritical;
    payload.is_safety_resolved = isSafetyResolved;
  }

  return payload;
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
  const res = await fetch(
    "/api/method/transport.api.fsl.get_driver_profile",
    {
      method: "GET",
      credentials: "include",
    }
  );

  let data = {};
  try {
    data = await res.json();
  } catch (e) {
    await logClientError("driver_profile_json_parse", e, {
      status: res.status,
    });
  }

  if (res.status === 403) {
    const err = new Error("NOT_LOGGED_IN");
    err.code = "NOT_LOGGED_IN";
    throw err;
  }

  if (!res.ok) {
    const msg =
      data?.message || "امکان دریافت پروفایل راننده وجود ندارد.";
    throw new Error(msg);
  }

  const msg = data.message || {};
  const cid =
    msg.custom_driver_canonical_id || msg.driver_canonical_id || "";

  if (!cid) {
    throw new Error(MSG.DRIVER_MISSING);
  }

  return cid;
}

// ---------------------------------------------------------------------------
// DRIVER INIT: OFFLINE + ONLINE
// ---------------------------------------------------------------------------

function initDriverOffline(cachedId) {
  if (cachedId) {
    driverCanonicalId = cachedId;
    setDriverDisplay(`${driverCanonicalId} (ذخیره‌شده)`);
    setStatus(MSG.OFFLINE_CACHED(driverCanonicalId));
  } else {
    driverCanonicalId = "";
    setDriverDisplay("شناسه راننده ذخیره نشده است.");
    setStatus(MSG.OFFLINE_NO_CACHE);
  }
}

async function initDriverOnline(cachedId) {
  setDriverDisplay("در حال بارگذاری…");
  setStatus(MSG.DRIVER_LOADING);

  try {
    const cid = await fetchDriverProfileFromServer();
    driverCanonicalId = cid;
    cacheDriverId(cid);
    setDriverDisplay(driverCanonicalId);
    setStatus(MSG.DRIVER_FROM_SERVER(driverCanonicalId));
  } catch (error) {
    // 🔹 1) Login-related error → redirect
    if (isNotLoggedInError(error)) {
      driverCanonicalId = "";
      clearCachedDriverId();
      setDriverDisplay("وارد نشده‌اید");
      setStatus(MSG.NOT_LOGGED_IN);
      await logClientError("driver_profile_not_logged_in", error);

      redirectToLogin();
      return;
    }

    // 🔹 2) Any other error → log + maybe fallback to cache
    console.error("[FSL] driver profile error:", error);
    await logClientError("driver_profile_error", error);

    if (cachedId) {
      driverCanonicalId = cachedId;
      setDriverDisplay(`${driverCanonicalId} (ذخیره‌شده)`);
      setStatus(MSG.DRIVER_FAILED_CACHE(driverCanonicalId));
    } else {
      driverCanonicalId = "";
      setDriverDisplay("امکان دریافت شناسه راننده نیست.");
      setStatus(error.message || MSG.DRIVER_LOAD_FAILED);
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
// SERVICE WORKER MESSAGES
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

// CHANGED: no CSRF here anymore, just payload
function sendToSwQueue(bodyObj) {
  if (!("serviceWorker" in navigator)) {
    console.warn(
      "[FSL] serviceWorker not supported; cannot queue offline"
    );
    return false;
  }

  navigator.serviceWorker.ready
    .then((reg) => {
      if (!reg.active) return;
      reg.active.postMessage({
        type: "QUEUE_FSL",
        payload: bodyObj, // only payload, no headers/CSRF
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
    setStatus(MSG.OFFLINE_SYNCED);
  }

  // NEW: session expired while SW was trying to fetch CSRF
  if (data.type === "FSL_SESSION_EXPIRED") {
    // You can define MSG.SESSION_EXPIRED in fsl.messages.js
    setStatus(MSG.SESSION_EXPIRED || "نشست شما منقضی شده است. لطفاً دوباره وارد شوید.");
  }
}

function initSwMessageListener() {
  if (!("serviceWorker" in navigator)) return;
  navigator.serviceWorker.addEventListener("message", handleSwMessage);
}

// ---------------------------------------------------------------------------
// SUBMIT FLOW
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// SUBMIT FLOW
// ---------------------------------------------------------------------------

const FSL_LOGIC = self.FslLogic || {
  buildFslBody: (item) => ({
    qr_token: item.qr_token,
    driver_canonical_id: item.driver_canonical_id,
    payload_json: JSON.stringify(item.payload),
  }),
  validatePayload: () => [],
};

function buildFslBody(item) {
  return FSL_LOGIC.buildFslBody(item);
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
    await logClientError("fsl_submit_json_parse", e, {
      status: res.status,
    });
  }

  if (!res.ok) {
    const msg = data?.message || "خطای سرور در ذخیره FSL.";
    throw new Error(msg);
  }

  return data.message || {};
}

function submitFslOffline(bodyObj) {
  const ok = sendToSwQueue(bodyObj);
  if (!ok) {
    throw new Error(MSG.OFFLINE_QUEUE_FAIL);
  }
  return { offline: true, queued: true };
}

// CHANGED: offline path does NOT require CSRF now;
// CSRF only required for online submit.
async function createDraftOnServer(item) {
  const body = buildFslBody(item);

  if (!navigator.onLine) {
    return submitFslOffline(body);
  }

  const csrf = getCsrf();
  if (!csrf) {
    throw new Error(MSG.CSRF_MISSING);
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

function initPhotoInputs() {
  // main waste photo
  initFileInput(
    "photoInput",
    "photoStatus",
    (value) => {
      photoDataUrl = value;
    },
    "photo_read_error"
  );

  // safety issue photo
  initFileInput(
    "safetyPhotoInput",
    "safetyPhotoStatus",
    (value) => {
      safetyPhotoDataUrl = value;
    },
    "safety_photo_read_error"
  );
}

function initSafetyToggle() {
  const chk = $("isWasteSafe");
  const section = $("safetySection");
  if (!chk || !section) return;

  function updateVisibility() {
    // if safe → hide safety section; if not safe → show
    section.style.display = chk.checked ? "none" : "block";
  }

  chk.addEventListener("change", updateVisibility);
  updateVisibility();
}

function initSaveButton() {
  const btn = $("btnSave");
  if (!btn) return;

  btn.addEventListener("click", async () => {
    setStatus(MSG.SAVE_CLICK);

    const token = getTokenFromHash();
    if (!token) {
      setStatus(MSG.TOKEN_STATUS_MISSING);
      return;
    }

    if (!driverCanonicalId) {
      setStatus(MSG.DRIVER_REQUIRED);
      return;
    }

    const payload = payloadFromForm();
    const validationErrors = FSL_LOGIC.validatePayload(payload);

    if (validationErrors.includes("qty_required")) {
      setStatus(MSG.QTY_REQUIRED);
      return;
    }
    if (validationErrors.includes("photo_required")) {
      setStatus(MSG.PHOTO_REQUIRED);
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
        setStatus(MSG.SAVED_OFFLINE);
      } else {
        setStatus(MSG.SAVED_ONLINE(r?.name || r));
        requestSwSyncQueue();
      }
    } catch (e) {
      console.error("[FSL] final submit error:", e);
      await logClientError("fsl_submit_final_error", e);
      setStatus(e?.message || MSG.FINAL_ERROR);
    }
  });
}


document.addEventListener("DOMContentLoaded", () => {
  const token = getTokenFromHash();
  $("tokenStatus").innerText = token
    ? MSG.TOKEN_STATUS_OK
    : MSG.TOKEN_STATUS_MISSING;
  $("timeStatus").innerText = new Date().toISOString();

    // NEW: show/hide form based on token
  const formEl = $("fslForm");
  const instrEl = $("qrInstruction");
  if (formEl && instrEl) {
    if (hasToken) {
      formEl.style.display = "block";
      instrEl.style.display = "none";
    } else {
      formEl.style.display = "none";
      instrEl.style.display = "block";
    }
  }

  initDriverCanonicalId().catch(async (e) => {
    console.error("[FSL] initDriverCanonicalId failed:", e);
    await logClientError("init_driver_canonical_id", e);
    setStatus(e.message || MSG.INIT_FAILED);
  });

  if (navigator.onLine) {
    requestSwSyncQueue();
  }
  window.addEventListener("online", requestSwSyncQueue);

  // NEW: start listening for SW messages (incl. flush done / session expired)
  initSwMessageListener();

  initPhotoInputs();
  initSafetyToggle();
  initSaveButton();

  setStatus(MSG.READY);
});
