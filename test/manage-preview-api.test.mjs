import assert from "node:assert/strict";
import test from "node:test";

import { createManagePreviewHandler } from "../api/manage-preview.js";
import { LIVE_MARKET_SNAPSHOT } from "./fixtures.mjs";

const WALLET = "0x6a355e4971d9ac2ab97d22c3cf361d42faba33fe";

function responseRecorder() {
  return {
    statusCode: 200,
    headers: {},
    body: "",
    status(code) { this.statusCode = code; return this; },
    setHeader(name, value) { this.headers[name.toLowerCase()] = value; return this; },
    end(body = "") { this.body = body; return this; },
  };
}

function source() {
  return {
    intentHash: `0x${"1".repeat(64)}`,
    positionProofHash: `0x${"2".repeat(64)}`,
    transactionHash: `0x${"3".repeat(64)}`,
    orderId: `0x${"4".repeat(64)}`,
    wallet: WALLET,
    marketConditionId: LIVE_MARKET_SNAPSHOT.conditionId,
    outcome: "YES",
    outcomeTokenId: LIVE_MARKET_SNAPSHOT.yesTokenId,
    actualSharesRaw: "5000000",
    intentVersion: "conviction-intent-v4",
    verificationMode: "signed-intent-window",
  };
}

test("free manager preview re-verifies the OPEN source and returns no executable card", async () => {
  const calls = [];
  const handler = createManagePreviewHandler({
    trustedIssuers: new Map(),
    async resolveMarketImpl(market, options) {
      calls.push(["market", market, options.outcome]);
      return LIVE_MARKET_SNAPSHOT;
    },
    async verifySourceImpl(input) {
      calls.push(["source", input]);
      return source();
    },
    async fetchPositionImpl(wallet, tokenId) {
      calls.push(["position", wallet, tokenId]);
      return {
        chainId: 137,
        wallet: WALLET,
        outcomeTokenId: LIVE_MARKET_SNAPSHOT.yesTokenId,
        balanceRaw: "5000000",
        approvedForExchange: true,
        blockNumber: "0x5666a7b",
        blockHash: `0x${"a".repeat(64)}`,
        capturedAt: "2026-07-21T02:00:09.000Z",
      };
    },
    compileOptions: { now: Date.parse("2026-07-21T02:00:10.000Z"), quoteTtlMs: 300_000 },
  });
  const response = responseRecorder();
  await handler({
    method: "POST",
    headers: { "x-forwarded-for": "192.0.2.8" },
    body: {
      market: LIVE_MARKET_SNAPSHOT.slug,
      outcome: "yes",
      shares: "5",
      minPrice: "0.26",
      wallet: WALLET,
      sourcePosition: { supplied: true },
    },
  }, response);
  const body = JSON.parse(response.body);
  assert.equal(response.statusCode, 200);
  assert.equal(body.preview.version, "conviction-close-preview-v1");
  assert.equal(body.preview.executable, false);
  assert.equal("executionCard" in body, false);
  assert.equal("intentHash" in body, false);
  assert.deepEqual(calls.map((entry) => entry[0]).sort(), ["market", "position", "source"]);
});

test("free manager preview preserves method handling", async () => {
  const response = responseRecorder();
  await createManagePreviewHandler({ trustedIssuers: new Map() })({ method: "GET" }, response);
  assert.equal(response.statusCode, 405);
  assert.equal(response.headers.allow, "POST");
});
