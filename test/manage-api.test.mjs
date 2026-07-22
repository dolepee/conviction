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
  SERVICE_ASSET,
  SERVICE_NETWORK,
  SERVICE_PAYEE,
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

function managerPaymentRequirements() {
  return {
    scheme: "exact",
    network: SERVICE_NETWORK,
    amount: MANAGE_SERVICE_PRICE_ATOMIC,
    asset: SERVICE_ASSET,
    payTo: SERVICE_PAYEE,
    maxTimeoutSeconds: 300,
    extra: { name: "USD₮0", version: "1" },
  };
}

function paidManagerHeader() {
  return Buffer.from(JSON.stringify({
    x402Version: 2,
    resource: { url: MANAGE_SERVICE_RESOURCE, mimeType: "application/json" },
    accepted: managerPaymentRequirements(),
    payload: { testAuthorization: "signed-manager-test-value" },
  })).toString("base64");
}

function trackedManagerFacilitator() {
  const calls = { verify: 0, settle: 0 };
  return {
    calls,
    client: {
      async getSupported() {
        return { kinds: [{ x402Version: 2, scheme: "exact", network: SERVICE_NETWORK }], extensions: [] };
      },
      async verify(payload, requirements) {
        calls.verify += 1;
        assert.deepEqual(payload.accepted, managerPaymentRequirements());
        assert.deepEqual(requirements, managerPaymentRequirements());
        return { isValid: true, payer: "0x1111111111111111111111111111111111111111" };
      },
      async settle() {
        calls.settle += 1;
        return {
          success: true,
          status: "success",
          payer: "0x1111111111111111111111111111111111111111",
          transaction: `0x${"ab".repeat(32)}`,
          network: SERVICE_NETWORK,
        };
      },
    },
  };
}

function managerRequestBody() {
  return {
    action: "close",
    market: LIVE_MARKET_SNAPSHOT.slug,
    outcome: "yes",
    shares: "5",
    minPrice: "0.26",
    wallet: WALLET,
    sourcePosition: { supplied: true },
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
      action: "close",
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

test("paid manager dispatches both explicit CLOSE and TAKE_PROFIT actions", async () => {
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
      action: "take_profit",
      market: LIVE_MARKET_SNAPSHOT.slug,
      outcome: "yes",
      shares: "5",
      targetPrice: "0.4",
      venueExpiresAt: "2026-07-22T02:00:00.000Z",
      wallet: WALLET,
      rationale: "Rest the full verified YES position at a forty-cent take-profit target.",
      sourcePosition: { supplied: true },
    },
  }, response);

  const body = JSON.parse(response.body);
  assert.equal(response.statusCode, 200);
  assert.equal(body.intent.version, "conviction-take-profit-intent-v1");
  assert.equal(body.intent.action, "TAKE_PROFIT");
  assert.equal(body.intent.order.orderType, "GTD");
  assert.equal(body.intent.order.postOnly, true);
  assert.equal(body.executionCard.authorizationScope, "single-bounded-take-profit");
  assert.equal(body.executionCard.targetPrice, "0.4");
  assert.equal(body.executionCard.venueExpiresAtUnix, "1784685600");
  assert.equal(body.issued, true);
  assert.deepEqual(calls.map((entry) => entry[0]).sort(), ["market", "position", "source"]);
});

test("paid manager rejects missing, blank, and unknown actions before any upstream lookup", async () => {
  let upstreamCalls = 0;
  const handler = createManageHandler({
    issueIntentImpl(compilation) { return compilation; },
    trustedIssuers: new Map(),
    async resolveMarketImpl() { upstreamCalls += 1; return LIVE_MARKET_SNAPSHOT; },
    async verifySourceImpl() { upstreamCalls += 1; return source(); },
    async fetchPositionImpl() { upstreamCalls += 1; return position(); },
  });
  for (const body of [{}, { action: "" }, { action: "   " }, { action: "sell_everything" }]) {
    const response = responseRecorder();
    await handler({ method: "POST", body }, response);
    assert.equal(response.statusCode, 422);
    assert.equal(JSON.parse(response.body).error.code, "unsupported_manager_action");
  }
  assert.equal(upstreamCalls, 0);
});

test("a verified manager authorization with no action is not settled", async () => {
  const facilitator = trackedManagerFacilitator();
  let upstreamCalls = 0;
  const manageHandler = createManageHandler({
    issueIntentImpl(compilation) { return compilation; },
    trustedIssuers: new Map(),
    async resolveMarketImpl() { upstreamCalls += 1; return LIVE_MARKET_SNAPSHOT; },
    async verifySourceImpl() { upstreamCalls += 1; return source(); },
    async fetchPositionImpl() { upstreamCalls += 1; return position(); },
  });
  const app = createManageApp({
    OKX_API_KEY: "test-api-key",
    OKX_SECRET_KEY: "test-secret-key",
    OKX_PASSPHRASE: "test-passphrase",
  }, {
    facilitatorClient: facilitator.client,
    logger: { error() {} },
    manageHandler,
  });

  await withServer(app, async (origin) => {
    const response = await fetch(`${origin}/api/manage`, {
      method: "POST",
      headers: { "content-type": "application/json", "payment-signature": paidManagerHeader() },
      body: JSON.stringify({}),
    });
    assert.equal(response.status, 422);
    assert.equal((await response.json()).error.code, "unsupported_manager_action");
    assert.equal(response.headers.get("payment-response"), null);
  });
  assert.equal(upstreamCalls, 0);
  assert.equal(facilitator.calls.verify, 1);
  assert.equal(facilitator.calls.settle, 0);
});

test("paid manager refetches one transiently stale Polygon position without weakening the freshness bound", async () => {
  let positionReads = 0;
  let issuances = 0;
  const handler = createManageHandler({
    issueIntentImpl(compilation) {
      issuances += 1;
      return { ...compilation, issued: true };
    },
    trustedIssuers: new Map(),
    async resolveMarketImpl() { return LIVE_MARKET_SNAPSHOT; },
    async verifySourceImpl() { return source(); },
    async fetchPositionImpl() {
      positionReads += 1;
      return {
        ...position(),
        capturedAt: positionReads === 1
          ? "2026-07-21T01:59:00.000Z"
          : "2026-07-21T02:00:09.000Z",
      };
    },
    compileOptions: { now: Date.parse("2026-07-21T02:00:10.000Z"), quoteTtlMs: 300_000 },
  });
  const response = responseRecorder();
  await handler({
    method: "POST",
    body: {
      action: "close",
      market: LIVE_MARKET_SNAPSHOT.slug,
      outcome: "yes",
      shares: "5",
      minPrice: "0.26",
      wallet: WALLET,
      sourcePosition: { supplied: true },
    },
  }, response);

  assert.equal(response.statusCode, 200);
  assert.equal(JSON.parse(response.body).ok, true);
  assert.equal(positionReads, 2);
  assert.equal(issuances, 1);
});

test("paid manager remains fail-closed when the refetched Polygon position is still stale", async () => {
  let positionReads = 0;
  let issuances = 0;
  const handler = createManageHandler({
    issueIntentImpl(compilation) {
      issuances += 1;
      return compilation;
    },
    trustedIssuers: new Map(),
    async resolveMarketImpl() { return LIVE_MARKET_SNAPSHOT; },
    async verifySourceImpl() { return source(); },
    async fetchPositionImpl() {
      positionReads += 1;
      return { ...position(), capturedAt: "2026-07-21T01:59:00.000Z" };
    },
    compileOptions: { now: Date.parse("2026-07-21T02:00:10.000Z"), quoteTtlMs: 300_000 },
  });
  const response = responseRecorder();
  await handler({
    method: "POST",
    body: {
      action: "close",
      market: LIVE_MARKET_SNAPSHOT.slug,
      outcome: "yes",
      shares: "5",
      minPrice: "0.26",
      wallet: WALLET,
      sourcePosition: { supplied: true },
    },
  }, response);

  assert.equal(response.statusCode, 422);
  assert.equal(JSON.parse(response.body).error.code, "stale_position_snapshot");
  assert.equal(positionReads, 2);
  assert.equal(issuances, 0);
});

test("paid manager does not retry a non-staleness compiler rejection", async () => {
  let positionReads = 0;
  const handler = createManageHandler({
    issueIntentImpl(compilation) { return compilation; },
    trustedIssuers: new Map(),
    async resolveMarketImpl() { return LIVE_MARKET_SNAPSHOT; },
    async verifySourceImpl() { return source(); },
    async fetchPositionImpl() {
      positionReads += 1;
      return { ...position(), approvedForExchange: false };
    },
    compileOptions: { now: Date.parse("2026-07-21T02:00:10.000Z"), quoteTtlMs: 300_000 },
  });
  const response = responseRecorder();
  await handler({
    method: "POST",
    body: {
      action: "close",
      market: LIVE_MARKET_SNAPSHOT.slug,
      outcome: "yes",
      shares: "5",
      minPrice: "0.26",
      wallet: WALLET,
      sourcePosition: { supplied: true },
    },
  }, response);

  assert.equal(response.statusCode, 422);
  assert.equal(JSON.parse(response.body).error.code, "ctf_approval_missing");
  assert.equal(positionReads, 1);
});

test("verified manager payment settles exactly once after one fresh position refetch", async () => {
  const facilitator = trackedManagerFacilitator();
  let positionReads = 0;
  const manageHandler = createManageHandler({
    issueIntentImpl(compilation) { return compilation; },
    trustedIssuers: new Map(),
    async resolveMarketImpl() { return LIVE_MARKET_SNAPSHOT; },
    async verifySourceImpl() { return source(); },
    async fetchPositionImpl() {
      positionReads += 1;
      return {
        ...position(),
        capturedAt: positionReads === 1
          ? "2026-07-21T01:59:00.000Z"
          : "2026-07-21T02:00:09.000Z",
      };
    },
    compileOptions: { now: Date.parse("2026-07-21T02:00:10.000Z"), quoteTtlMs: 300_000 },
  });
  const app = createManageApp({
    OKX_API_KEY: "test-api-key",
    OKX_SECRET_KEY: "test-secret-key",
    OKX_PASSPHRASE: "test-passphrase",
  }, {
    facilitatorClient: facilitator.client,
    logger: { error() {} },
    manageHandler,
    async notifyPaidCall() {},
  });

  await withServer(app, async (origin) => {
    const response = await fetch(`${origin}/api/manage`, {
      method: "POST",
      headers: { "content-type": "application/json", "payment-signature": paidManagerHeader() },
      body: JSON.stringify(managerRequestBody()),
    });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).ok, true);
    assert.ok(response.headers.get("payment-response"));
  });
  assert.equal(positionReads, 2);
  assert.equal(facilitator.calls.verify, 1);
  assert.equal(facilitator.calls.settle, 1);
});

test("persistently stale verified manager request returns 422 without settling", async () => {
  const facilitator = trackedManagerFacilitator();
  let positionReads = 0;
  const manageHandler = createManageHandler({
    issueIntentImpl(compilation) { return compilation; },
    trustedIssuers: new Map(),
    async resolveMarketImpl() { return LIVE_MARKET_SNAPSHOT; },
    async verifySourceImpl() { return source(); },
    async fetchPositionImpl() {
      positionReads += 1;
      return { ...position(), capturedAt: "2026-07-21T01:59:00.000Z" };
    },
    compileOptions: { now: Date.parse("2026-07-21T02:00:10.000Z"), quoteTtlMs: 300_000 },
  });
  const app = createManageApp({
    OKX_API_KEY: "test-api-key",
    OKX_SECRET_KEY: "test-secret-key",
    OKX_PASSPHRASE: "test-passphrase",
  }, {
    facilitatorClient: facilitator.client,
    logger: { error() {} },
    manageHandler,
  });

  await withServer(app, async (origin) => {
    const response = await fetch(`${origin}/api/manage`, {
      method: "POST",
      headers: { "content-type": "application/json", "payment-signature": paidManagerHeader() },
      body: JSON.stringify(managerRequestBody()),
    });
    assert.equal(response.status, 422);
    assert.equal((await response.json()).error.code, "stale_position_snapshot");
    assert.equal(response.headers.get("payment-response"), null);
  });
  assert.equal(positionReads, 2);
  assert.equal(facilitator.calls.verify, 1);
  assert.equal(facilitator.calls.settle, 0);
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
    assert.equal(response.headers.get("link"), '<https://conviction-bay.vercel.app/api/executor>; rel="service-desc"; type="application/json"');
    assert.equal(challenge.resource.url, MANAGE_SERVICE_RESOURCE);
    assert.equal(challenge.accepts[0].amount, MANAGE_SERVICE_PRICE_ATOMIC);
  });
});
