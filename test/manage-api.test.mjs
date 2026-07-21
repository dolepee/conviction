import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";

import {
  createManageApp,
  createManageHandler,
  MANAGE_QUOTE_TTL_MS,
} from "../api/manage.js";
import {
  MANAGE_SERVICE_PRICE_ATOMIC,
  MANAGE_SERVICE_RESOURCE,
  SERVICE_NETWORK,
} from "../src/service-payment.mjs";
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

async function withServer(app, callback) {
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    return await callback(`http://127.0.0.1:${server.address().port}`);
  } finally {
    server.close();
    await once(server, "close");
  }
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

function position() {
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
}

test("paid manager re-verifies source and holdings before compiling CLOSE", async () => {
  const calls = [];
  const handler = createManageHandler({
    issueIntentImpl(compilation) { return { ...compilation, issued: true }; },
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
      return position();
    },
    compileOptions: { now: Date.parse("2026-07-21T02:00:10.000Z"), quoteTtlMs: 300_000 },
  });
  const response = responseRecorder();
  await handler({
    method: "POST",
    body: {
      market: LIVE_MARKET_SNAPSHOT.slug,
      outcome: "yes",
      shares: "5",
      minPrice: "0.26",
      wallet: WALLET,
      rationale: "Close the full verified YES position at no less than twenty-six cents.",
      sourcePosition: { supplied: true },
    },
  }, response);
  const body = JSON.parse(response.body);
  assert.equal(response.statusCode, 200);
  assert.equal(body.intent.action, "CLOSE");
  assert.equal(body.intent.source.positionProofHash, source().positionProofHash);
  assert.equal(body.executionCard.action, "sell");
  assert.equal(body.issued, true);
  assert.deepEqual(calls.map((entry) => entry[0]).sort(), ["market", "position", "source"]);
  assert.equal(MANAGE_QUOTE_TTL_MS, 300_000);
});

test("bare manager probes receive the distinct 0.10 challenge", async () => {
  const app = createManageApp({
    OKX_API_KEY: "test-api-key",
    OKX_SECRET_KEY: "test-secret-key",
    OKX_PASSPHRASE: "test-passphrase",
  }, {
    facilitatorClient: {
      async getSupported() {
        return { kinds: [{ x402Version: 2, scheme: "exact", network: SERVICE_NETWORK }], extensions: [] };
      },
      async verify() { throw new Error("must not verify unpaid probe"); },
      async settle() { throw new Error("must not settle unpaid probe"); },
    },
    logger: { error() {} },
    manageHandler(request, response) { return response.status(200).json({ ok: true }); },
  });
  await withServer(app, async (origin) => {
    const response = await fetch(`${origin}/api/manage`);
    const challenge = JSON.parse(Buffer.from(response.headers.get("payment-required"), "base64").toString("utf8"));
    assert.equal(response.status, 402);
    assert.equal(challenge.resource.url, MANAGE_SERVICE_RESOURCE);
    assert.equal(challenge.accepts[0].amount, MANAGE_SERVICE_PRICE_ATOMIC);
  });
});
