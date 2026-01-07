// apps/transport/tests/sw.core.test.js

const {
  createdAtToMs,
  shouldDropItem,
  flushQueueCore,
} = require("../transport/www/field/fsl/sw.core.js"); // ⬅ adjust path if different

describe("createdAtToMs", () => {
  test("parses ISO string", () => {
    const ms = createdAtToMs("2026-01-01T00:00:00Z");
    expect(ms).toBeGreaterThan(0);
  });

  test("returns 0 for invalid or empty", () => {
    expect(createdAtToMs("not-a-date")).toBe(0);
    expect(createdAtToMs(null)).toBe(0);
    expect(createdAtToMs(undefined)).toBe(0);
  });
});

describe("shouldDropItem", () => {
  test("drops by age", () => {
    const now = Date.parse("2026-01-10T00:00:00Z");
    const item = {
      created_at: "2025-12-01T00:00:00Z",
      retry_count: 0,
    };

    const res = shouldDropItem(
      item,
      now,
      7 * 24 * 60 * 60 * 1000, // max age 7 days
      5
    );

    expect(res.drop).toBe(true);
    expect(res.reason).toBe("age");
  });

  test("drops by retries", () => {
    const now = Date.now();
    const item = {
      created_at: now,
      retry_count: 5,
    };

    const res = shouldDropItem(item, now, null, 3);
    expect(res.drop).toBe(true);
    expect(res.reason).toBe("retries");
  });

  test("keeps valid item", () => {
    const now = Date.now();
    const item = {
      created_at: now - 1000,
      retry_count: 1,
    };

    const res = shouldDropItem(
      item,
      now,
      7 * 24 * 60 * 60 * 1000,
      3
    );
    expect(res.drop).toBe(false);
    expect(res.reason).toBeNull();
  });
});

describe("flushQueueCore", () => {
  test("processes and deletes successful items", async () => {
    const now = Date.now();

    const items = [
      {
        id: 1,
        created_at: now - 1000,
        retry_count: 0,
        body: JSON.stringify({ a: 1 }),
      },
      {
        id: 2,
        created_at: now - 500,
        retry_count: 0,
        body: JSON.stringify({ a: 2 }),
      },
    ];

    const queueService = {
      async getAll() {
        return items.map((i) => ({ ...i }));
      },
      async delete(id) {
        const idx = items.findIndex((i) => i.id === id);
        if (idx >= 0) items.splice(idx, 1);
      },
      async update(updated) {
        const idx = items.findIndex((i) => i.id === updated.id);
        if (idx >= 0) items[idx] = { ...updated };
      },
      async trimToMax() {},
    };

    const sendFn = jest.fn(async () => ({ ok: true, status: 200 }));
    const logSync = jest.fn();
    const logDrop = jest.fn();

    await flushQueueCore({
      queueService,
      sendFn,
      nowMs: now,
      maxAgeMs: 30 * 24 * 60 * 60 * 1000,
      maxRetries: 5,
      maxItemsPerFlush: 10,
      maxQueueItems: 100,
      logger: { logSync, logDrop },
    });

    expect(sendFn).toHaveBeenCalledTimes(2);
    expect(items.length).toBe(0); // all deleted
    expect(logDrop).not.toHaveBeenCalled();

    expect(logSync).toHaveBeenCalledTimes(1);
    const metrics = logSync.mock.calls[0][0];
    expect(metrics.succeeded).toBe(2);
    expect(metrics.failed).toBe(0);
    expect(metrics.dropped).toBe(0);
  });

  test("increments retry_count on failure and respects MAX_ITEMS_PER_FLUSH", async () => {
    const now = Date.now();

    const items = [];
    for (let i = 0; i < 5; i++) {
      items.push({
        id: i + 1,
        created_at: now - (i + 1) * 1000,
        retry_count: 0,
        body: JSON.stringify({ idx: i }),
      });
    }

    const queueService = {
      async getAll() {
        return items.map((i) => ({ ...i }));
      },
      async delete(id) {
        const idx = items.findIndex((i) => i.id === id);
        if (idx >= 0) items.splice(idx, 1);
      },
      async update(updated) {
        const idx = items.findIndex((i) => i.id === updated.id);
        if (idx >= 0) items[idx] = { ...updated };
      },
      async trimToMax() {},
    };

    const sendFn = jest.fn(async () => ({ ok: false, status: 500 }));
    const logSync = jest.fn();

    await flushQueueCore({
      queueService,
      sendFn,
      nowMs: now,
      maxAgeMs: 30 * 24 * 60 * 60 * 1000,
      maxRetries: 5,
      maxItemsPerFlush: 2,
      maxQueueItems: 100,
      logger: { logSync, logDrop() {} },
    });

    expect(sendFn).toHaveBeenCalledTimes(2); // only 2 items processed

    const retried = items.filter((i) => i.retry_count === 1);
    expect(retried.length).toBe(2);

    const metrics = logSync.mock.calls[0][0];
    expect(metrics.processed).toBe(2);
    expect(metrics.failed).toBe(2);
  });
});
