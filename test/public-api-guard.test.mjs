import assert from "node:assert/strict";
import test from "node:test";

import {
  createPublicApiGuard,
  PublicApiError,
} from "../src/public-api-guard.mjs";
import { createShortCache } from "../src/short-cache.mjs";

function request(body = {}, headers = {}, remoteAddress = "203.0.113.1") {
  return { body, headers, socket: { remoteAddress } };
}

async function errorFrom(promise) {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  assert.fail("expected promise to reject");
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

test("public guard rejects declared, encoded, and market-reference oversize input", async () => {
  const guard = createPublicApiGuard({ maxBodyBytes: 64, maxMarketLength: 8 });

  let error = await errorFrom(
    guard.run(request({}, { "content-length": "65" }), async () => "unreachable"),
  );
  assert.ok(error instanceof PublicApiError);
  assert.equal(error.status, 413);
  assert.equal(error.code, "payload_too_large");

  error = await errorFrom(
    guard.run(request({ padding: "x".repeat(65) }), async () => "unreachable"),
  );
  assert.equal(error.status, 413);
  assert.equal(error.code, "payload_too_large");

  error = await errorFrom(
    guard.run(request({ market: "é".repeat(5) }), async () => "unreachable"),
  );
  assert.equal(error.status, 422);
  assert.equal(error.code, "invalid_market_reference");

  error = await errorFrom(
    guard.run(request({}, { "content-length": "not-a-number" }), async () => "unreachable"),
  );
  assert.equal(error.status, 400);
  assert.equal(error.code, "invalid_content_length");
});

test("public guard returns a bounded retry window and resets the client bucket", async () => {
  let currentTime = 1_000;
  const guard = createPublicApiGuard({
    limit: 2,
    windowMs: 10_000,
    now: () => currentTime,
  });
  const incoming = request({ market: "technology-market" });

  assert.equal(await guard.run(incoming, async () => "one"), "one");
  assert.equal(await guard.run(incoming, async () => "two"), "two");
  const error = await errorFrom(guard.run(incoming, async () => "unreachable"));
  assert.equal(error.status, 429);
  assert.equal(error.code, "rate_limited");
  assert.equal(error.details.retryAfterSeconds, 10);

  currentTime += 10_001;
  assert.equal(await guard.run(incoming, async () => "reset"), "reset");
});

test("public guard fails closed at concurrency capacity and releases the slot", async () => {
  const guard = createPublicApiGuard({ limit: 10, maxInFlight: 1 });
  const firstTask = deferred();
  const first = guard.run(request({}, {}, "203.0.113.1"), () => firstTask.promise);
  await Promise.resolve();

  const error = await errorFrom(
    guard.run(request({}, {}, "203.0.113.2"), async () => "unreachable"),
  );
  assert.equal(error.status, 503);
  assert.equal(error.code, "preview_capacity_reached");
  assert.equal(error.details.retryAfterSeconds, 1);

  firstTask.resolve("done");
  assert.equal(await first, "done");
  assert.equal(
    await guard.run(request({}, {}, "203.0.113.2"), async () => "next"),
    "next",
  );
});

test("public guard bounds remembered client buckets", async () => {
  const guard = createPublicApiGuard({ limit: 1, maxClients: 2 });
  for (const address of ["203.0.113.1", "203.0.113.2", "203.0.113.3"]) {
    await guard.run(request({}, {}, address), async () => address);
  }
  assert.equal(
    await guard.run(request({}, {}, "203.0.113.1"), async () => "evicted"),
    "evicted",
  );
});

test("short cache deduplicates in flight work, honors TTL, and drops failures", async () => {
  let currentTime = 1_000;
  const cache = createShortCache({ ttlMs: 3_000, now: () => currentTime });
  const load = deferred();
  let calls = 0;
  const loader = () => {
    calls += 1;
    return load.promise;
  };

  const first = cache.get("same", loader);
  const second = cache.get("same", loader);
  load.resolve({ ok: true });
  assert.deepEqual(await Promise.all([first, second]), [{ ok: true }, { ok: true }]);
  assert.equal(calls, 1);
  assert.deepEqual(await cache.get("same", () => assert.fail("cache miss")), { ok: true });

  currentTime += 3_001;
  assert.equal(await cache.get("same", async () => ++calls), 2);

  let failureCalls = 0;
  await assert.rejects(
    cache.get("failure", async () => {
      failureCalls += 1;
      throw new Error("synthetic failure");
    }),
    /synthetic failure/,
  );
  assert.equal(await cache.get("failure", async () => ++failureCalls), 2);
});

test("short cache has a bounded least-recently-used settled set", async () => {
  const cache = createShortCache({ ttlMs: 10_000, maxEntries: 2 });
  let calls = 0;
  await cache.get("a", async () => `a-${++calls}`);
  await cache.get("b", async () => `b-${++calls}`);
  assert.equal(await cache.get("a", async () => assert.fail("a should be cached")), "a-1");
  await cache.get("c", async () => `c-${++calls}`);
  assert.equal(await cache.get("b", async () => `b-${++calls}`), "b-4");
});

test("guard and cache configuration rejects unsafe limits", () => {
  assert.throws(() => createPublicApiGuard({ limit: 0 }), /positive safe integer/);
  assert.throws(() => createPublicApiGuard({ now: null }), /now must be a function/);
  assert.throws(() => createShortCache({ maxEntries: 0 }), /positive safe integer/);
  assert.throws(() => createShortCache({ ttlMs: -1 }), /positive safe integer/);
});
