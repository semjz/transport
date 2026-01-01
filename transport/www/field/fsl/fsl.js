alert("FSL.JS LOADED: CSRF");

const el = (id) => document.getElementById(id);

const setStatus = (msg) => {
  const s = el("status");
  if (s) s.innerText = msg;
  console.log("[STATUS]", msg);
};

function getTokenFromHash() {
  const hash = location.hash || "";
  const m = hash.match(/(?:^|[#&])t=([^&]+)/);
  return m ? decodeURIComponent(m[1]) : "";
}

function uuidv4() {
  return crypto.randomUUID
    ? crypto.randomUUID()
    : "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
        const r = (Math.random() * 16) | 0;
        const v = c === "x" ? r : (r & 0x3) | 0x8;
        return v.toString(16);
      });
}

let photoDataUrl = null;

function fileToDataURL(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result || ""));
    r.onerror = () => reject(r.error);
    r.readAsDataURL(file);
  });
}

function payloadFromForm() {
  const qty = el("qtyOrWeight")?.value ? Number(el("qtyOrWeight").value) : null;
  return {
    qty_or_weight: qty,
    timestamp: new Date().toISOString(),
    photo_data_url: photoDataUrl,
  };
}

function getCsrf() {
  // DO NOT CHANGE: per your request
  return window.csrf_token || "";
}

/* -------------------------
   OFFLINE OUTBOX (IndexedDB)
   ------------------------- */

const OUTBOX_DB = "fsl_offline_db";
const OUTBOX_VERSION = 1;
const OUTBOX_STORE = "outbox";

function openOutboxDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(OUTBOX_DB, OUTBOX_VERSION);

    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(OUTBOX_STORE)) {
        const store = db.createObjectStore(OUTBOX_STORE, { keyPath: "id" });
        store.createIndex("created_at", "created_at");
      }
    };

    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function outboxPut(item) {
  const db = await openOutboxDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(OUTBOX_STORE, "readwrite");
    tx.objectStore(OUTBOX_STORE).put(item);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function outboxGetAll() {
  const db = await openOutboxDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(OUTBOX_STORE, "readonly");
    const req = tx.objectStore(OUTBOX_STORE).getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
}

async function outboxDelete(id) {
  const db = await openOutboxDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(OUTBOX_STORE, "readwrite");
    tx.objectStore(OUTBOX_STORE).delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function outboxCount() {
  const db = await openOutboxDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(OUTBOX_STORE, "readonly");
    const req = tx.objectStore(OUTBOX_STORE).count();
    req.onsuccess = () => resolve(req.result || 0);
    req.onerror = () => reject(req.error);
  });
}

/* -------------------------
   SERVER CALL (unchanged CSRF)
   ------------------------- */

async function createDraftOnServer(item) {
  const csrf = getCsrf();
  if (!csrf) throw new Error("csrf_token is missing on page (window.csrf_token empty).");

  const res = await fetch("/api/method/transport.api.fsl.upsert_draft_fsl", {
    method: "POST",
    credentials: "include", // keep cookie session
    headers: {
      "Content-Type": "application/json",
      "X-Frappe-CSRF-Token": csrf,
    },
    body: JSON.stringify({
      qr_token: item.qr_token,
      driver_canonical_id: item.driver_canonical_id,
      payload_json: JSON.stringify(item.payload),
    }),
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.message || "Server error");
  return data.message;
}

/* -------------------------
   OFFLINE QUEUE + SYNC
   ------------------------- */

function toQueueItem(item) {
  return {
    id: uuidv4(),
    created_at: Date.now(),
    item, // the same structure you already use
  };
}

async function queueItem(item, reason) {
  const q = toQueueItem(item);
  await outboxPut(q);
  const n = await outboxCount();
  setStatus(`Saved offline (${reason}). Queue size: ${n}`);
  return q.id;
}

let isSyncing = false;

async function syncOutboxOnce() {
  if (isSyncing) return;
  if (!navigator.onLine) return;

  isSyncing = true;
  try {
    const all = await outboxGetAll();
    all.sort((a, b) => a.created_at - b.created_at);

    if (!all.length) return;

    setStatus(`Syncing ${all.length} queued item(s)...`);

    for (const q of all) {
      try {
        const r = await createDraftOnServer(q.item);
        await outboxDelete(q.id);
        setStatus(`Synced one item. FSL: ${r?.name || r}`);
      } catch (e) {
        // Stop on first failure to preserve order and avoid hammering server
        setStatus(`Sync paused: ${e?.message || e}`);
        console.error("Sync failed for item", q, e);
        break;
      }
    }

    const remaining = await outboxCount();
    if (remaining === 0) setStatus("All queued items synced ✅");
    else setStatus(`Remaining queued items: ${remaining}`);
  } finally {
    isSyncing = false;
  }
}

window.addEventListener("online", () => {
  // When connection comes back, try to sync
  syncOutboxOnce().catch(console.error);
});

/* -------------------------
   UI WIRES
   ------------------------- */

document.addEventListener("DOMContentLoaded", () => {
  const token = getTokenFromHash();
  el("tokenStatus").innerText = token ? "OK" : "Missing #t= token";
  el("timeStatus").innerText = new Date().toISOString();

  // Try syncing on load too (if online)
  syncOutboxOnce().catch(console.error);

  el("photoInput")?.addEventListener("change", async (e) => {
    const file = e.target.files && e.target.files[0];
    if (!file) {
      photoDataUrl = null;
      el("photoStatus").innerText = "No photo selected";
      return;
    }
    photoDataUrl = await fileToDataURL(file);
    el("photoStatus").innerText = `Selected: ${file.name}`;
  });

  el("btnSave")?.addEventListener("click", async () => {
    setStatus("Save clicked...");

    const driver_canonical_id = el("driverCanonical")?.value?.trim() || "";
    if (!token) return setStatus("Missing QR token in URL (#t=...).");
    if (!driver_canonical_id) return setStatus("Driver canonical_id required.");

    const payload = payloadFromForm();
    if (payload.qty_or_weight == null) return setStatus("qty_or_weight is required.");
    if (!payload.photo_data_url) return setStatus("Please attach a photo.");

    const item = {
      qr_token: token,
      driver_canonical_id,
      payload,
    };

    // If offline, queue immediately
    if (!navigator.onLine) {
      await queueItem(item, "offline");
      return;
    }

    try {
      const r = await createDraftOnServer(item);
      setStatus(`Saved online. FSL: ${r?.name || r}`);

      // after a successful online save, also try syncing any previous offline queue
      syncOutboxOnce().catch(console.error);
    } catch (e) {
      // If online call fails (server down/network), queue it
      await queueItem(item, "send failed");
      console.error(e);
    }
  });

  setStatus("Ready.");
});
