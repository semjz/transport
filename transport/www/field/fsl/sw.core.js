// /field/fsl/sw.core.js

/**
 * Convert a created_at value (ISO string or number) to millis.
 */
function createdAtToMs(created_at) {
  if (!created_at) return 0;
  if (typeof created_at === "number") return created_at;
  const t = Date.parse(created_at);
  return Number.isNaN(t) ? 0 : t;
}

/**
 * Decide if an item should be dropped based on age or retry_count.
 *
 * @param {Object} item - queued request, with created_at and retry_count
 * @param {number} nowMs - current time in ms
 * @param {number} maxAgeMs - maximum allowed age in ms
 * @param {number} maxRetries - maximum allowed retry_count
 * @returns {{drop: boolean, reason: string|null, ageMs: number, retryCount: number}}
 */
function shouldDropItem(item, nowMs, maxAgeMs, maxRetries) {
  const createdMs = createdAtToMs(item.created_at);
  const retryCount = item.retry_count || 0;
  const ageMs = nowMs - createdMs;

  if (maxAgeMs && ageMs > maxAgeMs) {
    return { drop: true, reason: "age", ageMs, retryCount };
  }

  if (maxRetries != null && retryCount >= maxRetries) {
    return { drop: true, reason: "retries", ageMs, retryCount };
  }

  return { drop: false, reason: null, ageMs, retryCount };
}

/**
 * Core flush logic, independent of service worker APIs.
 *
 * Dependencies are injected:
 *  - queueService: { getAll, delete, update, trimToMax }
 *  - sendFn: async (payloadObj, item) => { ok: boolean, status: number }
 *  - logger: { logSync(metrics), logDrop(item, reason) }
 *
 * This makes it easy to unit-test with pure JS.
 */
async function flushQueueCore({
  queueService,
  sendFn,
  nowMs = Date.now(),
  maxAgeMs,
  maxRetries,
  maxItemsPerFlush,
  maxQueueItems,
  logger = { logSync() {}, logDrop() {} },
}) {
  const all = await queueService.getAll();
  const queued_before = all.length;

  if (!queued_before) {
    await logger.logSync({
      queued_before,
      queued_after: 0,
      processed: 0,
      succeeded: 0,
      failed: 0,
      dropped: 0,
      timestamp: nowMs,
    });
    return;
  }

  let dropped = 0;
  const candidates = [];

  // 1) Drop by TTL / retry limit
  for (const item of all) {
    const dropInfo = shouldDropItem(item, nowMs, maxAgeMs, maxRetries);
    if (dropInfo.drop) {
      await queueService.delete(item.id);
      logger.logDrop(item, dropInfo.reason);
      dropped++;
    } else {
      candidates.push(item);
    }
  }

  if (!candidates.length) {
    await logger.logSync({
      queued_before,
      queued_after: 0,
      processed: 0,
      succeeded: 0,
      failed: 0,
      dropped,
      timestamp: nowMs,
    });
    return;
  }

  // 2) Oldest first, limited batch
  candidates.sort(
    (a, b) => createdAtToMs(a.created_at) - createdAtToMs(b.created_at)
  );

  const toProcess =
    maxItemsPerFlush && candidates.length > maxItemsPerFlush
      ? candidates.slice(0, maxItemsPerFlush)
      : candidates;

  let processed = 0;
  let succeeded = 0;
  let failed = 0;

  // 3) Process the selected batch
  for (const item of toProcess) {
    processed++;

    let payloadObj = {};
    try {
      payloadObj = item.body ? JSON.parse(item.body) : {};
    } catch {
      // Broken JSON is unrecoverable → drop item
      await queueService.delete(item.id);
      dropped++;
      continue;
    }

    const result = await sendFn(payloadObj, item);

    if (result.ok) {
      await queueService.delete(item.id);
      succeeded++;
    } else {
      item.retry_count = (item.retry_count || 0) + 1;
      await queueService.update(item);
      failed++;
    }
  }

  // 4) Enforce global queue size cap
  if (maxQueueItems && maxQueueItems > 0) {
    await queueService.trimToMax(maxQueueItems);
  }

  const after = await queueService.getAll();

  // 5) Report metrics
  await logger.logSync({
    queued_before,
    queued_after: after.length,
    processed,
    succeeded,
    failed,
    dropped,
    timestamp: nowMs,
  });
}

// ---- Exports for Node tests ----
if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    createdAtToMs,
    shouldDropItem,
    flushQueueCore,
  };
}

// ---- Attach to service worker global (for sw.js) ----
if (typeof self !== "undefined") {
  self.FslSwCore = {
    createdAtToMs,
    shouldDropItem,
    flushQueueCore,
  };
}
