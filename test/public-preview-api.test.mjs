import assert from "node:assert/strict";
import test from "node:test";

import { createMarketHandler } from "../api/market.js";
import { PUBLIC_INTENT_QUOTE_TTL_MS } from "../api/intent.js";
import { createPreviewHandler } from "../api/preview.js";
import { ConvictionError } from "../src/errors.mjs";
import { createPublicApiGuard } from "../src/public-api-guard.mjs";
import { createShortCache } from "../src/short-cache.mjs";
import { LIVE_MARKET_SNAPSHOT } from "./fixtures.mjs";

function responseRecorder() {
  return {
    statusCode: 200,
    headers: {},
    body: "",
    status(code) {
      this.statusCode = code;
      return this;
    },
    setHeader(name, value) {
      this.headers[name.toLowerCase()] = value;
      return this;
    },
    end(body = "") {
      this.body = body;
      return this;
    },
  };
}

function snapshot(outcome) {
  if (outcome === "yes") return LIVE_MARKET_SNAPSHOT;
  return {
    ...LIVE_MARKET_SNAPSHOT,
    selectedOutcome: "NO",
    outcomeTokenId: LIVE_MARKET_SNAPSHOT.noTokenId,
    counterOutcomeTokenId: LIVE_MARKET_SNAPSHOT.yesTokenId,
    bids: [{ price: "0.71", size: "100" }],
    asks: [{ price: "0.72", size: "100" }],
  };
}

test("public market lookup returns both sides without a wallet", async () => {
  const calls = [];
  const handler = createMarketHandler({
    async resolveMarketImpl(market, { outcome }) {
      calls.push({ market, outcome });
      return snapshot(outcome);
    },
  });
  const response = responseRecorder();
  await handler({ method: "POST", body: { market: "technology-market" } }, response);
  const body = JSON.parse(response.body);

  assert.equal(response.statusCode, 200);
  assert.equal(body.ok, true);
  assert.equal(body.readOnly, true);
  assert.equal(body.outcomes.YES.bestAsk, "0.27");
  assert.equal(body.outcomes.NO.bestAsk, "0.72");
  assert.equal(body.outcomes.YES.minimumMarketableBudget.minimumTotalBudget, "1.08");
  assert.equal(body.outcomes.YES.minimumMarketableBudget.minimumShares, "4");
  assert.deepEqual(calls.map(({ outcome }) => outcome).sort(), ["no", "yes"]);
  assert.equal(JSON.stringify(body).includes("wallet"), false);
});

test("public bounds preview compiles with no wallet or rationale", async () => {
  const handler = createPreviewHandler({
    async resolveMarketImpl(_market, { outcome }) {
      return snapshot(outcome);
    },
    compileOptions: { now: Date.parse("2026-07-21T02:00:10.000Z") },
  });
  const response = responseRecorder();
  await handler(
    {
      method: "POST",
      body: { market: "technology-market", outcome: "yes", spend: "1.35", maxPrice: "0.27" },
    },
    response,
  );
  const body = JSON.parse(response.body);

  assert.equal(response.statusCode, 200);
  assert.equal(body.preview.executable, false);
  assert.equal("buyer" in body.preview, false);
  assert.equal("intentHash" in body, false);
});

test("preview APIs preserve method and fail-closed error behavior", async () => {
  for (const handler of [createMarketHandler(), createPreviewHandler()]) {
    const response = responseRecorder();
    await handler({ method: "GET" }, response);
    assert.equal(response.statusCode, 405);
    assert.equal(response.headers.allow, "POST");
  }

  const handler = createMarketHandler({
    async resolveMarketImpl() {
      throw new ConvictionError("market_api_error", "upstream unavailable");
    },
  });
  const response = responseRecorder();
  await handler({ method: "POST", body: { market: "technology-market" } }, response);
  assert.equal(response.statusCode, 502);
  assert.equal(JSON.parse(response.body).error.code, "market_api_error");

  const missingResponse = responseRecorder();
  await createMarketHandler()({ method: "POST", body: {} }, missingResponse);
  assert.equal(missingResponse.statusCode, 422);
  assert.equal(JSON.parse(missingResponse.body).error.code, "missing_market");
});

test("the final public card has a five-minute handoff window", () => {
  assert.equal(PUBLIC_INTENT_QUOTE_TTL_MS, 300_000);
});

test("market lookup deduplicates concurrent and short-lived identical requests", async () => {
  let release;
  const pending = new Promise((resolve) => {
    release = resolve;
  });
  const calls = [];
  const handler = createMarketHandler({
    publicGuard: createPublicApiGuard({ limit: 10 }),
    cache: createShortCache({ ttlMs: 3_000 }),
    async resolveMarketImpl(_market, { outcome }) {
      calls.push(outcome);
      await pending;
      return snapshot(outcome);
    },
  });
  const firstResponse = responseRecorder();
  const secondResponse = responseRecorder();
  const first = handler(
    { method: "POST", body: { market: "technology-market" }, socket: { remoteAddress: "203.0.113.1" } },
    firstResponse,
  );
  const second = handler(
    { method: "POST", body: { market: " technology-market " }, socket: { remoteAddress: "203.0.113.2" } },
    secondResponse,
  );
  await Promise.resolve();
  release();
  await Promise.all([first, second]);

  assert.deepEqual(calls.sort(), ["no", "yes"]);
  assert.equal(firstResponse.statusCode, 200);
  assert.equal(secondResponse.statusCode, 200);

  const cachedResponse = responseRecorder();
  await handler(
    { method: "POST", body: { market: "technology-market" }, socket: { remoteAddress: "203.0.113.3" } },
    cachedResponse,
  );
  assert.deepEqual(calls.sort(), ["no", "yes"]);
  assert.equal(cachedResponse.statusCode, 200);

  const caseChangedResponse = responseRecorder();
  await handler(
    { method: "POST", body: { market: "TECHNOLOGY-MARKET" }, socket: { remoteAddress: "203.0.113.4" } },
    caseChangedResponse,
  );
  assert.deepEqual(calls.sort(), ["no", "no", "yes", "yes"]);
});

test("public handlers translate rate and capacity errors with Retry-After", async () => {
  const rateGuard = createPublicApiGuard({ limit: 1 });
  const handler = createPreviewHandler({
    publicGuard: rateGuard,
    async resolveMarketImpl(_market, { outcome }) {
      return snapshot(outcome);
    },
    compileOptions: { now: Date.parse("2026-07-21T02:00:10.000Z") },
  });
  const incoming = {
    method: "POST",
    body: { market: "technology-market", outcome: "yes", spend: "1.35", maxPrice: "0.27" },
    socket: { remoteAddress: "203.0.113.1" },
  };
  await handler(incoming, responseRecorder());
  const response = responseRecorder();
  await handler(incoming, response);
  const body = JSON.parse(response.body);
  assert.equal(response.statusCode, 429);
  assert.equal(response.headers["retry-after"], "60");
  assert.equal(body.error.code, "rate_limited");
});

test("public handlers expose body, reference, and concurrency limits without upstream work", async () => {
  let upstreamCalls = 0;
  const oversizeHandler = createPreviewHandler({
    publicGuard: createPublicApiGuard({ maxBodyBytes: 64, maxMarketLength: 8 }),
    async resolveMarketImpl() {
      upstreamCalls += 1;
      return snapshot("yes");
    },
  });

  let response = responseRecorder();
  await oversizeHandler(
    { method: "POST", body: { market: "technology-market" }, socket: { remoteAddress: "203.0.113.1" } },
    response,
  );
  assert.equal(response.statusCode, 422);
  assert.equal(JSON.parse(response.body).error.code, "invalid_market_reference");

  response = responseRecorder();
  await oversizeHandler(
    {
      method: "POST",
      body: { market: "market", padding: "x".repeat(80) },
      socket: { remoteAddress: "203.0.113.2" },
    },
    response,
  );
  assert.equal(response.statusCode, 413);
  assert.equal(JSON.parse(response.body).error.code, "payload_too_large");
  assert.equal(upstreamCalls, 0);

  let release;
  const pending = new Promise((resolve) => {
    release = resolve;
  });
  const capacityHandler = createPreviewHandler({
    publicGuard: createPublicApiGuard({ limit: 10, maxInFlight: 1 }),
    async resolveMarketImpl(_market, { outcome }) {
      await pending;
      return snapshot(outcome);
    },
    compileOptions: { now: Date.parse("2026-07-21T02:00:10.000Z") },
  });
  const incoming = {
    method: "POST",
    body: { market: "technology-market", outcome: "yes", spend: "1.35", maxPrice: "0.27" },
  };
  const firstResponse = responseRecorder();
  const first = capacityHandler(
    { ...incoming, socket: { remoteAddress: "203.0.113.3" } },
    firstResponse,
  );
  await Promise.resolve();
  const capacityResponse = responseRecorder();
  await capacityHandler(
    { ...incoming, socket: { remoteAddress: "203.0.113.4" } },
    capacityResponse,
  );
  assert.equal(capacityResponse.statusCode, 503);
  assert.equal(capacityResponse.headers["retry-after"], "1");
  assert.equal(JSON.parse(capacityResponse.body).error.code, "preview_capacity_reached");
  release();
  await first;
  assert.equal(firstResponse.statusCode, 200);
});
