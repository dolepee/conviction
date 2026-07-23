import assert from "node:assert/strict";
import test from "node:test";

import { createIntentHandler, PUBLIC_INTENT_QUOTE_TTL_MS } from "../api/intent.js";
import { createMarketHandler } from "../api/market.js";
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

async function lookupWithYesSnapshot(yesSnapshot) {
  const handler = createMarketHandler({
    async resolveMarketImpl(_market, { outcome }) {
      return outcome === "yes" ? yesSnapshot : snapshot("no");
    },
  });
  const response = responseRecorder();
  await handler({ method: "POST", body: { market: "technology-market" } }, response);
  return { response, body: JSON.parse(response.body) };
}

async function previewSuggestedMinimum(yesSnapshot, quote) {
  const handler = createPreviewHandler({
    async resolveMarketImpl(_market, { outcome }) {
      return outcome === "yes" ? yesSnapshot : snapshot("no");
    },
    compileOptions: { now: Date.parse("2026-07-21T02:00:10.000Z") },
  });
  const response = responseRecorder();
  await handler(
    {
      method: "POST",
      body: {
        market: "technology-market",
        outcome: "yes",
        spend: quote.minimumMarketableBudget.minimumTotalBudget,
        maxPrice: quote.suggestedMaxPrice,
      },
    },
    response,
  );
  return { response, body: JSON.parse(response.body) };
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
  assert.equal(body.outcomes.YES.suggestedMaxPrice, "0.27");
  assert.equal(body.outcomes.NO.bestAsk, "0.72");
  assert.equal(body.outcomes.YES.minimumMarketableBudget.minimumTotalBudget, "1.08");
  assert.equal(body.outcomes.YES.minimumMarketableBudget.minimumShares, "4");
  assert.deepEqual(calls.map(({ outcome }) => outcome).sort(), ["no", "yes"]);
  assert.equal(JSON.stringify(body).includes("wallet"), false);
});

test("depth-aware minimum advances past a shallow best ask and compiles", async () => {
  const shallowTop = {
    ...LIVE_MARKET_SNAPSHOT,
    asks: [
      { price: "0.28", size: "100" },
      { price: "0.27", size: "3.99" },
    ],
  };
  const lookup = await lookupWithYesSnapshot(shallowTop);
  const quote = lookup.body.outcomes.YES;

  assert.equal(lookup.response.statusCode, 200);
  assert.equal(quote.bestAsk, "0.27");
  assert.equal(quote.suggestedMaxPrice, "0.28");
  assert.equal(quote.minimumMarketableBudget.minimumTotalBudget, "1.12");
  assert.equal(quote.minimumMarketableBudget.minimumShares, "4");

  const preview = await previewSuggestedMinimum(shallowTop, quote);
  assert.equal(preview.response.statusCode, 200);
  assert.equal(preview.body.preview.order.maxPrice, "0.28");
  assert.equal(preview.body.preview.order.maximumTotalDebit, "1.12");
  assert.equal(preview.body.preview.order.fullFillSharesAtCap, "4");
});

test("depth-aware minimum aggregates unsorted duplicate ask levels", async () => {
  const splitDepth = {
    ...LIVE_MARKET_SNAPSHOT,
    asks: [
      { price: "0.28", size: "0.75" },
      { price: "0.27", size: "1.5" },
      { price: "0.29", size: "100" },
      { price: "0.28", size: "0.75" },
      { price: "0.27", size: "1" },
    ],
  };
  const { response, body } = await lookupWithYesSnapshot(splitDepth);

  assert.equal(response.statusCode, 200);
  assert.equal(body.outcomes.YES.bestAsk, "0.27");
  assert.equal(body.outcomes.YES.suggestedMaxPrice, "0.28");
  assert.equal(body.outcomes.YES.minimumMarketableBudget.minimumShares, "4");
});

test("depth-aware minimum makes no viable claim when quoted depth cannot qualify", async () => {
  const insufficientDepth = {
    ...LIVE_MARKET_SNAPSHOT,
    asks: [
      { price: "0.28", size: "1" },
      { price: "0.27", size: "1" },
    ],
  };
  const { response, body } = await lookupWithYesSnapshot(insufficientDepth);

  assert.equal(response.statusCode, 200);
  assert.equal(body.outcomes.YES.available, true);
  assert.equal(body.outcomes.YES.bestAsk, "0.27");
  assert.equal(body.outcomes.YES.suggestedMaxPrice, null);
  assert.equal(body.outcomes.YES.minimumMarketableBudget, null);
});

test("fee-bearing depth-aware minimum round-trips through preview", async () => {
  const feeBearing = {
    ...LIVE_MARKET_SNAPSHOT,
    feeBps: 1000,
    asks: [
      { price: "0.89", size: "2" },
      { price: "0.88", size: "1" },
    ],
  };
  const lookup = await lookupWithYesSnapshot(feeBearing);
  const quote = lookup.body.outcomes.YES;

  assert.equal(lookup.response.statusCode, 200);
  assert.equal(quote.bestAsk, "0.88");
  assert.equal(quote.suggestedMaxPrice, "0.89");
  assert.equal(quote.minimumMarketableBudget.minimumOrderPrincipal, "1.78");
  assert.equal(quote.minimumMarketableBudget.maximumFeeAtMinimum, "0.178");
  assert.equal(quote.minimumMarketableBudget.minimumTotalBudget, "1.958");

  const preview = await previewSuggestedMinimum(feeBearing, quote);
  assert.equal(preview.response.statusCode, 200);
  assert.equal(preview.body.preview.order.maximumOrderPrincipal, "1.78");
  assert.equal(preview.body.preview.order.maximumFee, "0.178");
  assert.equal(preview.body.preview.order.maximumTotalDebit, "1.958");
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

test("public market and intent APIs return clean 404s for unknown slugs", async () => {
  const missing = new ConvictionError(
    "market_not_found",
    "Polymarket market not found. Check the market URL or use a current Polymarket market slug.",
    { market: "unknown-market" },
  );
  const handlers = [
    createMarketHandler({ async resolveMarketImpl() { throw missing; } }),
    createPreviewHandler({ async resolveMarketImpl() { throw missing; } }),
    createIntentHandler({ async resolveMarketImpl() { throw missing; } }),
  ];
  const payload = {
    market: "unknown-market",
    outcome: "yes",
    spend: "1.35",
    maxPrice: "0.27",
    wallet: "0x6a355e4971d9ac2ab97d22c3cf361d42faba33fe",
  };

  for (const handler of handlers) {
    const response = responseRecorder();
    await handler({ method: "POST", body: payload }, response);
    const body = JSON.parse(response.body);
    assert.equal(response.statusCode, 404);
    assert.equal(body.error.code, "market_not_found");
    assert.match(body.error.message, /current Polymarket market slug/);
    assert.deepEqual(body.error.details, { market: "unknown-market" });
    assert.equal(JSON.stringify(body).includes("gamma-api.polymarket.com"), false);
    assert.equal(JSON.stringify(body).includes('"url"'), false);
  }
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
