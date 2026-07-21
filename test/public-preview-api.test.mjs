import assert from "node:assert/strict";
import test from "node:test";

import { createMarketHandler } from "../api/market.js";
import { PUBLIC_INTENT_QUOTE_TTL_MS } from "../api/intent.js";
import { createPreviewHandler } from "../api/preview.js";
import { ConvictionError } from "../src/errors.mjs";
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
});

test("the final public card has a five-minute handoff window", () => {
  assert.equal(PUBLIC_INTENT_QUOTE_TTL_MS, 300_000);
});
