import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { once } from "node:events";
import test from "node:test";

import {
  createPaidIntentHandler,
  createServiceApp,
  PAID_SERVICE_QUOTE_TTL_MS,
} from "../api/service.js";
import { ConvictionError } from "../src/errors.mjs";
import { createEnvironmentIntentIssuer } from "../src/intent-issuer.mjs";
import { createPublicApiGuard } from "../src/public-api-guard.mjs";
import {
  readFacilitatorCredentials,
  MANAGE_SERVICE_PATH,
  MANAGE_SERVICE_PRICE_ATOMIC,
  MANAGE_SERVICE_RESOURCE,
  POSITION_MANAGER_SERVICE,
  pinnedServiceUrl,
  requirePinnedServiceOrigin,
  SERVICE_ASSET,
  SERVICE_NETWORK,
  SERVICE_PAYEE,
  SERVICE_PRICE_ATOMIC,
  SERVICE_PRICE_DISPLAY,
  SERVICE_RESOURCE,
  serviceRouteConfiguration,
} from "../src/service-payment.mjs";
import { LIVE_MARKET_SNAPSHOT } from "./fixtures.mjs";

const TEST_ISSUER_KEY_PAIR = generateKeyPairSync("ed25519");
const TEST_ISSUER_PRIVATE_KEY_B64 = TEST_ISSUER_KEY_PAIR.privateKey
  .export({ format: "der", type: "pkcs8" })
  .toString("base64");
const TEST_ISSUER_PUBLIC_KEY_B64 = TEST_ISSUER_KEY_PAIR.publicKey
  .export({ format: "der", type: "spki" })
  .toString("base64");
const TEST_ENVIRONMENT = Object.freeze({
  OKX_API_KEY: "test-api-key",
  OKX_SECRET_KEY: "test-secret-key",
  OKX_PASSPHRASE: "test-passphrase",
  CONVICTION_ISSUER_KEY_ID: "conviction-test-2026-07",
  CONVICTION_ISSUER_PRIVATE_KEY_B64: TEST_ISSUER_PRIVATE_KEY_B64,
  CONVICTION_ISSUER_PUBLIC_KEY_B64: TEST_ISSUER_PUBLIC_KEY_B64,
});

const FACILITATOR = Object.freeze({
  async getSupported() {
    return {
      kinds: [{ x402Version: 2, scheme: "exact", network: SERVICE_NETWORK }],
      extensions: [],
    };
  },
  async verify() {
    throw new Error("verify must not run for an unpaid request");
  },
  async settle() {
    throw new Error("settle must not run for an unpaid request");
  },
});

test("pins buyer runtimes to the canonical service origin and resource", () => {
  assert.equal(
    requirePinnedServiceOrigin("https://conviction-bay.vercel.app/", POSITION_MANAGER_SERVICE),
    "https://conviction-bay.vercel.app",
  );
  assert.equal(pinnedServiceUrl(POSITION_MANAGER_SERVICE), MANAGE_SERVICE_RESOURCE);
  assert.equal(
    pinnedServiceUrl(POSITION_MANAGER_SERVICE, "/api/manage-preview"),
    "https://conviction-bay.vercel.app/api/manage-preview",
  );
  assert.throws(
    () => pinnedServiceUrl(POSITION_MANAGER_SERVICE, "https://attacker.example/steal"),
    (error) => error?.code === "invalid_service_path",
  );
  for (const value of [
    "http://conviction-bay.vercel.app",
    "https://attacker.example",
    "https://conviction-bay.vercel.app@attacker.example",
    "https://attacker.example/?next=https://conviction-bay.vercel.app",
    "https://conviction-bay.vercel.app/api/manage",
    "https://conviction-bay.vercel.app?redirect=https://attacker.example",
    "not-a-url",
  ]) {
    assert.throws(
      () => requirePinnedServiceOrigin(value, POSITION_MANAGER_SERVICE),
      (error) => error?.code === "untrusted_service_origin" || error?.code === "invalid_service_origin",
      value,
    );
  }
});

function quietLogger() {
  return { error() {} };
}

async function withServer(app, callback) {
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address();
  try {
    return await callback(`http://127.0.0.1:${port}`);
  } finally {
    server.close();
    await once(server, "close");
  }
}

function decodePaymentRequired(value) {
  assert.ok(value, "PAYMENT-REQUIRED header must be present");
  return JSON.parse(Buffer.from(value, "base64").toString("utf8"));
}

function acceptedRequirements() {
  return {
    scheme: "exact",
    network: SERVICE_NETWORK,
    amount: SERVICE_PRICE_ATOMIC,
    asset: SERVICE_ASSET,
    payTo: SERVICE_PAYEE,
    maxTimeoutSeconds: 300,
    extra: { name: "USD₮0", version: "1" },
  };
}

function paidHeader() {
  const payload = {
    x402Version: 2,
    resource: { url: SERVICE_RESOURCE, mimeType: "application/json" },
    accepted: acceptedRequirements(),
    payload: { testAuthorization: "signed-test-value" },
  };
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64");
}

function trackedFacilitator({
  settleSuccess = true,
  settleStatus = "success",
  transaction = `0x${"ab".repeat(32)}`,
} = {}) {
  const calls = { supported: 0, verify: 0, settle: 0 };
  return {
    calls,
    client: {
      async getSupported() {
        calls.supported += 1;
        return {
          kinds: [{ x402Version: 2, scheme: "exact", network: SERVICE_NETWORK }],
          extensions: [],
        };
      },
      async verify(payload, requirements) {
        calls.verify += 1;
        assert.deepEqual(payload.accepted, acceptedRequirements());
        assert.deepEqual(requirements, acceptedRequirements());
        return { isValid: true, payer: "0x1111111111111111111111111111111111111111" };
      },
      async settle() {
        calls.settle += 1;
        if (!settleSuccess) {
          return {
            success: false,
            errorReason: "test_settlement_failure",
            errorMessage: "Synthetic failure",
            transaction: "",
            network: SERVICE_NETWORK,
          };
        }
        return {
          success: true,
          status: settleStatus,
          payer: "0x1111111111111111111111111111111111111111",
          transaction,
          network: SERVICE_NETWORK,
        };
      },
    },
  };
}

test("pins the listing payment to one exact X Layer amount and payee", () => {
  const config = serviceRouteConfiguration()["* /api/service"];
  assert.equal(config.resource, SERVICE_RESOURCE);
  assert.equal(config.accepts.scheme, "exact");
  assert.equal(config.accepts.network, SERVICE_NETWORK);
  assert.equal(config.accepts.payTo, SERVICE_PAYEE);
  assert.deepEqual(config.accepts.price, {
    amount: SERVICE_PRICE_ATOMIC,
    asset: SERVICE_ASSET,
    extra: { name: "USD₮0", version: "1" },
  });
  assert.match(config.customPaywallHtml, /free interactive OPEN preview/);
  assert.match(config.customPaywallHtml, /href="\/#try"/);
  assert.doesNotMatch(config.customPaywallHtml, /manage-preview/);
  assert.match(config.settlementFailedResponseBody().body.error.message, /position card was not delivered$/);
  assert.equal(PAID_SERVICE_QUOTE_TTL_MS, 300_000);
});

test("pins the position manager to a distinct paid resource and price", () => {
  const config = serviceRouteConfiguration(POSITION_MANAGER_SERVICE)[`* ${MANAGE_SERVICE_PATH}`];
  assert.equal(config.resource, MANAGE_SERVICE_RESOURCE);
  assert.equal(config.accepts.network, SERVICE_NETWORK);
  assert.equal(config.accepts.payTo, SERVICE_PAYEE);
  assert.equal(config.accepts.price.amount, MANAGE_SERVICE_PRICE_ATOMIC);
  assert.match(config.description, /CLOSE/);
  assert.match(config.customPaywallHtml, /repository-backed buyer agent\/CLI/);
  assert.match(config.customPaywallHtml, /<code>\/api\/manage-preview<\/code>/);
  assert.match(config.customPaywallHtml, /href="\/#manage"/);
  assert.doesNotMatch(config.customPaywallHtml, /interactive OPEN preview/);
  assert.match(config.settlementFailedResponseBody().body.error.message, /bounded position-manager card was not delivered$/);
});

test("fails closed when any facilitator credential is absent", () => {
  assert.throws(
    () => readFacilitatorCredentials({ OKX_API_KEY: "present" }),
    (error) =>
      error.code === "payment_configuration_error" &&
      error.missing.includes("OKX_SECRET_KEY") &&
      error.missing.includes("OKX_PASSPHRASE"),
  );
  assert.throws(
    () => readFacilitatorCredentials({ ...TEST_ENVIRONMENT, OKX_PASSPHRASE: " padded " }),
    (error) =>
      error.code === "payment_configuration_error" &&
      error.padded.includes("OKX_PASSPHRASE"),
  );
});

test("returns a standards-compliant unpaid challenge before compiling", async () => {
  const app = createServiceApp(TEST_ENVIRONMENT, {
    facilitatorClient: FACILITATOR,
    logger: quietLogger(),
  });

  await withServer(app, async (origin) => {
    const response = await fetch(`${origin}/api/service`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({}),
    });
    const body = await response.json();
    const challenge = decodePaymentRequired(response.headers.get("payment-required"));

    assert.equal(response.status, 402);
    assert.equal(body.error.code, "payment_required");
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.match(response.headers.get("vary"), /Accept/);
    assert.match(response.headers.get("vary"), /PAYMENT-SIGNATURE/);
    assert.equal(challenge.x402Version, 2);
    assert.equal(challenge.resource.url, SERVICE_RESOURCE);
    assert.equal(challenge.accepts.length, 1);
    assert.equal(challenge.accepts[0].scheme, "exact");
    assert.equal(challenge.accepts[0].network, SERVICE_NETWORK);
    assert.equal(challenge.accepts[0].amount, SERVICE_PRICE_ATOMIC);
    assert.equal(challenge.accepts[0].asset, SERVICE_ASSET);
    assert.equal(challenge.accepts[0].payTo, SERVICE_PAYEE);
    assert.equal(challenge.outputSchema.input.type, "http");
  assert.equal(challenge.outputSchema.input.method, "POST");
  assert.deepEqual(
      challenge.outputSchema.input.body.required,
      ["market", "outcome", "spend", "maxPrice", "wallet", "executionMode", "walletReadiness", "pluginPreview"],
  );
  const input = challenge.outputSchema.input.body;
  assert.equal(input.additionalProperties, true);
  assert.equal(input.properties.walletReadiness.anyOf.length, 2);
  assert.equal(input.properties.pluginPreview.properties.ok.const, true);
  assert.equal(input.properties.pluginPreview.properties.dry_run.const, true);
  });
});

test("the browser paywall names the actual X Layer asset", async () => {
  const app = createServiceApp(TEST_ENVIRONMENT, {
    facilitatorClient: FACILITATOR,
    logger: quietLogger(),
  });

  await withServer(app, async (origin) => {
    const response = await fetch(`${origin}/api/service`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "text/html",
        "user-agent": "Mozilla/5.0 Conviction test",
      },
      body: "{}",
    });
    const body = await response.text();
    assert.equal(response.status, 402);
    assert.match(response.headers.get("content-type"), /^text\/html/);
    assert.match(body, /0\.05 USD₮0/);
    assert.equal(body.includes("USDC"), false);
  });
});

test("missing server configuration is a 503 and never a free compile", async () => {
  const app = createServiceApp({}, { logger: quietLogger() });
  await withServer(app, async (origin) => {
    const response = await fetch(`${origin}/api/service`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    const body = await response.json();
    assert.equal(response.status, 503);
    assert.equal(body.error.code, "payment_service_unavailable");
    assert.equal(response.headers.get("payment-required"), null);
  });
});

test("missing or mismatched issuer trust fails before presenting a payment challenge", async () => {
  const configurations = [
    { ...TEST_ENVIRONMENT, CONVICTION_ISSUER_PUBLIC_KEY_B64: "" },
    {
      ...TEST_ENVIRONMENT,
      CONVICTION_ISSUER_PUBLIC_KEY_B64: generateKeyPairSync("ed25519").publicKey
        .export({ format: "der", type: "spki" })
        .toString("base64"),
    },
  ];
  for (const environment of configurations) {
    const app = createServiceApp(environment, {
      facilitatorClient: FACILITATOR,
      logger: quietLogger(),
    });
    await withServer(app, async (origin) => {
      const response = await fetch(`${origin}/api/service`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      assert.equal(response.status, 503);
      assert.equal(response.headers.get("payment-required"), null);
    });
  }
});

test("unpaid malformed and oversized JSON receive a challenge before parsing", async () => {
  const app = createServiceApp(TEST_ENVIRONMENT, {
    facilitatorClient: FACILITATOR,
    logger: quietLogger(),
  });
  await withServer(app, async (origin) => {
    for (const body of ["{", JSON.stringify({ rationale: "x".repeat(33 * 1024) })]) {
      const response = await fetch(`${origin}/api/service`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
      });
      assert.equal(response.status, 402);
      assert.ok(response.headers.get("payment-required"));
    }
  });
});

test("verified malformed and oversized JSON fail business validation without settlement", async () => {
  const facilitator = trackedFacilitator();
  const app = createServiceApp(TEST_ENVIRONMENT, {
    facilitatorClient: facilitator.client,
    logger: quietLogger(),
  });
  await withServer(app, async (origin) => {
    const malformed = await fetch(`${origin}/api/service`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "payment-signature": paidHeader(),
      },
      body: "{",
    });
    assert.equal(malformed.status, 400);
    assert.equal((await malformed.json()).error.code, "invalid_json");
    assert.equal(malformed.headers.get("payment-response"), null);

    const oversized = await fetch(`${origin}/api/service`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "payment-signature": paidHeader(),
      },
      body: JSON.stringify({ rationale: "x".repeat(33 * 1024) }),
    });
    assert.equal(oversized.status, 413);
    assert.equal((await oversized.json()).error.code, "payload_too_large");
    assert.equal(oversized.headers.get("payment-response"), null);
  });

  assert.equal(facilitator.calls.verify, 2);
  assert.equal(facilitator.calls.settle, 0);
});

test("bare marketplace probes receive a challenge before method validation", async () => {
  const app = createServiceApp(TEST_ENVIRONMENT, {
    facilitatorClient: FACILITATOR,
    logger: quietLogger(),
  });
  await withServer(app, async (origin) => {
    for (const method of ["GET", "HEAD", "PUT", "PATCH", "DELETE", "OPTIONS"]) {
      const response = await fetch(`${origin}/api/service`, { method });
      assert.equal(response.status, 402);
      assert.equal(response.headers.get("link"), '<https://conviction-bay.vercel.app/api/executor>; rel="service-desc"; type="application/json"');
      const challenge = decodePaymentRequired(response.headers.get("payment-required"));
      assert.equal(challenge.accepts[0].amount, SERVICE_PRICE_ATOMIC);
    }
  });
});

test("a verified non-POST request is rejected without settlement", async () => {
  const facilitator = trackedFacilitator();
  const notifications = [];
  const app = createServiceApp(TEST_ENVIRONMENT, {
    facilitatorClient: facilitator.client,
    logger: quietLogger(),
    notifyPaidCall(event) {
      notifications.push(event);
    },
  });
  await withServer(app, async (origin) => {
    const response = await fetch(`${origin}/api/service`, {
      headers: { "payment-signature": paidHeader() },
    });
    assert.equal(response.status, 405);
    assert.equal(response.headers.get("allow"), "POST");
    assert.equal(response.headers.get("payment-response"), null);
  });

  assert.equal(facilitator.calls.verify, 1);
  assert.equal(facilitator.calls.settle, 0);
  assert.equal(notifications.length, 0);
});

test("alternate path spellings cannot bypass the payment route", async () => {
  const app = createServiceApp(TEST_ENVIRONMENT, {
    facilitatorClient: FACILITATOR,
    logger: quietLogger(),
  });
  await withServer(app, async (origin) => {
    for (const path of ["/api/service/", "/API/SERVICE"]) {
      const response = await fetch(`${origin}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      assert.equal(response.status, 404);
      assert.equal(response.headers.get("payment-required"), null);
    }
  });
});

test("a verified request compiles once, settles once, and returns settlement proof", async () => {
  const transaction = `0x${"ab".repeat(32)}`;
  const facilitator = trackedFacilitator({ transaction });
  const notifications = [];
  let compiles = 0;
  const app = createServiceApp(TEST_ENVIRONMENT, {
    facilitatorClient: facilitator.client,
    logger: quietLogger(),
    compileHandler(request, response) {
      compiles += 1;
      return response.status(200).json({ ok: true, card: "bounded" });
    },
    notifyPaidCall(event) {
      notifications.push(event);
    },
  });

  await withServer(app, async (origin) => {
    const response = await fetch(`${origin}/api/service`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "payment-signature": paidHeader(),
      },
      body: "{}",
    });
    const body = await response.json();
    const paymentResponse = JSON.parse(
      Buffer.from(response.headers.get("payment-response"), "base64").toString("utf8"),
    );
    assert.equal(response.status, 200);
    assert.deepEqual(body, { ok: true, card: "bounded" });
    assert.equal(paymentResponse.success, true);
    assert.equal(paymentResponse.network, SERVICE_NETWORK);
  });

  assert.equal(facilitator.calls.supported, 1);
  assert.equal(facilitator.calls.verify, 1);
  assert.equal(facilitator.calls.settle, 1);
  assert.equal(compiles, 1);
  assert.equal(notifications.length, 1);
  assert.deepEqual(Object.keys(notifications[0]).sort(), [
    "amount",
    "network",
    "serviceName",
    "settledAt",
    "transaction",
  ]);
  assert.equal(notifications[0].serviceName, "Bounded YES/NO Position Card");
  assert.equal(notifications[0].amount, SERVICE_PRICE_DISPLAY);
  assert.equal(notifications[0].network, SERVICE_NETWORK);
  assert.equal(notifications[0].transaction, transaction);
  assert.equal(
    new Date(notifications[0].settledAt).toISOString(),
    notifications[0].settledAt,
  );
});

test("a compiler error is delivered without settling the verified payment", async () => {
  const facilitator = trackedFacilitator();
  const notifications = [];
  const app = createServiceApp(TEST_ENVIRONMENT, {
    facilitatorClient: facilitator.client,
    logger: quietLogger(),
    notifyPaidCall(event) {
      notifications.push(event);
    },
    compileHandler(request, response) {
      return response.status(422).json({
        ok: false,
        error: { code: "invalid_wallet", message: "Invalid wallet" },
      });
    },
  });

  await withServer(app, async (origin) => {
    const response = await fetch(`${origin}/api/service`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "payment-signature": paidHeader(),
      },
      body: "{}",
    });
    const body = await response.json();
    assert.equal(response.status, 422);
    assert.equal(body.error.code, "invalid_wallet");
    assert.equal(response.headers.get("payment-response"), null);
  });

  assert.equal(facilitator.calls.verify, 1);
  assert.equal(facilitator.calls.settle, 0);
  assert.equal(notifications.length, 0);
});

test("settlement failure withholds a successful compiler response", async () => {
  const facilitator = trackedFacilitator({ settleSuccess: false });
  const notifications = [];
  const app = createServiceApp(TEST_ENVIRONMENT, {
    facilitatorClient: facilitator.client,
    logger: quietLogger(),
    notifyPaidCall(event) {
      notifications.push(event);
    },
    compileHandler(request, response) {
      return response.status(200).json({ ok: true, secretCard: "must-not-leak" });
    },
  });

  await withServer(app, async (origin) => {
    const response = await fetch(`${origin}/api/service`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "payment-signature": paidHeader(),
      },
      body: "{}",
    });
    const body = await response.json();
    assert.equal(response.status, 402);
    assert.equal(body.error.code, "payment_settlement_failed");
    assert.equal(JSON.stringify(body).includes("must-not-leak"), false);
  });

  assert.equal(facilitator.calls.verify, 1);
  assert.equal(facilitator.calls.settle, 1);
  assert.equal(notifications.length, 0);
});

test("a pending settlement never produces a paid-call notification", async () => {
  const facilitator = trackedFacilitator({ settleStatus: "pending" });
  const notifications = [];
  const app = createServiceApp(TEST_ENVIRONMENT, {
    facilitatorClient: facilitator.client,
    logger: quietLogger(),
    notifyPaidCall(event) {
      notifications.push(event);
    },
    compileHandler(request, response) {
      return response.status(200).json({ ok: true, card: "bounded" });
    },
  });

  await withServer(app, async (origin) => {
    const response = await fetch(`${origin}/api/service`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "payment-signature": paidHeader(),
      },
      body: "{}",
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true, card: "bounded" });
  });

  assert.equal(facilitator.calls.settle, 1);
  assert.equal(notifications.length, 0);
});

test("notification failure cannot change a successful paid response or leak its error", async () => {
  const facilitator = trackedFacilitator();
  const logs = [];
  const logger = {
    error(message, details) {
      logs.push({ message, details });
    },
  };
  const app = createServiceApp(TEST_ENVIRONMENT, {
    facilitatorClient: facilitator.client,
    logger,
    async notifyPaidCall() {
      const error = new Error("buyer-secret and bot-token must not be logged");
      error.code = "telegram_notification_failed";
      error.status = 502;
      throw error;
    },
    compileHandler(request, response) {
      return response.status(200).json({ ok: true, card: "bounded" });
    },
  });

  await withServer(app, async (origin) => {
    const response = await fetch(`${origin}/api/service`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "payment-signature": paidHeader(),
      },
      body: JSON.stringify({ buyer: "buyer-secret" }),
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true, card: "bounded" });
    const paymentResponse = JSON.parse(
      Buffer.from(response.headers.get("payment-response"), "base64").toString("utf8"),
    );
    assert.equal(paymentResponse.success, true);
  });

  assert.equal(logs.length, 1);
  assert.equal(logs[0].message, "paid call notification failed");
  assert.deepEqual(logs[0].details, {
    name: "Error",
    code: "telegram_notification_failed",
    status: 502,
  });
  assert.equal(JSON.stringify(logs).includes("buyer-secret"), false);
  assert.equal(JSON.stringify(logs).includes("bot-token"), false);
});

test("even a throwing logger cannot break a paid response after settlement", async () => {
  const facilitator = trackedFacilitator();
  const app = createServiceApp(TEST_ENVIRONMENT, {
    facilitatorClient: facilitator.client,
    logger: {
      error() {
        throw new Error("logger unavailable");
      },
    },
    async notifyPaidCall() {
      throw new Error("notifier unavailable");
    },
    compileHandler(request, response) {
      return response.status(200).json({ ok: true });
    },
  });

  await withServer(app, async (origin) => {
    const response = await fetch(`${origin}/api/service`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "payment-signature": paidHeader(),
      },
      body: "{}",
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true });
  });
});

test("the paid route bypasses public preview limits only after payment verification", async () => {
  const facilitator = trackedFacilitator();
  const compileHandler = createPaidIntentHandler({
    issueIntentImpl: createEnvironmentIntentIssuer(TEST_ENVIRONMENT, {
      now: () => Date.parse("2026-07-21T02:00:11.000Z"),
    }),
    compileOptions: {
      now: Date.parse("2026-07-21T02:00:10.000Z"),
      maxSnapshotAgeMs: 30_000,
      quoteTtlMs: 120_000,
    },
    publicGuard: {
      run() {
        throw new Error("public guard must not run on the paid route");
      },
    },
    async resolveMarketImpl() {
      return LIVE_MARKET_SNAPSHOT;
    },
    async verifyExecutionWalletImpl() {
      return { ok: true, executionMode: "deposit-wallet" };
    },
  });
  const app = createServiceApp(TEST_ENVIRONMENT, {
    facilitatorClient: facilitator.client,
    logger: quietLogger(),
    compileHandler,
  });

  await withServer(app, async (origin) => {
    const response = await fetch(`${origin}/api/service`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "payment-signature": paidHeader(),
      },
      body: JSON.stringify({
        market: LIVE_MARKET_SNAPSHOT.slug,
        outcome: "yes",
        spend: "1.35",
        maxPrice: "0.27",
        wallet: "0x6a355e4971d9ac2ab97d22c3cf361d42faba33fe",
        executionMode: "deposit-wallet",
        walletReadiness: {
          ok: true,
          accessible: true,
          status: "deposit_wallet_ready",
          wallet: {
            eoa: "0x1111111111111111111111111111111111111111",
            deposit_wallet: "0x6a355e4971d9ac2ab97d22c3cf361d42faba33fe",
          },
        },
        pluginPreview: {
          ok: true,
          dry_run: true,
          data: {
            clob_version: "V2",
            collateral_token: "0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB",
            condition_id: LIVE_MARKET_SNAPSHOT.conditionId,
            exchange_address: "0xE111180000d2663C0091e4f400237545B87B996B",
            expires: null,
            fee_rate_bps: 0,
            limit_price: "0.27",
            neg_risk: false,
            note: "dry-run: order not submitted",
            order_type: "FAK",
            outcome: "yes",
            post_only: false,
            shares: "5",
            side: "BUY",
            token_id: LIVE_MARKET_SNAPSHOT.yesTokenId,
            usdc_amount: "1.35",
            usdc_requested: "1.35",
          },
        },
        rationale: "",
        ignoredPadding: "x".repeat(9_000),
      }),
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.ok, true);
    assert.equal(body.intent.version, "conviction-intent-v4");
    assert.equal(body.issuance.version, "conviction-issuance-v1");
  });

  assert.equal(facilitator.calls.verify, 1);
  assert.equal(facilitator.calls.settle, 1);
});

test("an EOA-mode request is refused before x402 verification, settlement, or market resolution", async () => {
  const facilitator = trackedFacilitator();
  let upstreamCalls = 0;
  const compileHandler = createPaidIntentHandler({
    issueIntentImpl(compilation) { return compilation; },
    async resolveMarketImpl() {
      upstreamCalls += 1;
      return LIVE_MARKET_SNAPSHOT;
    },
    async verifyExecutionWalletImpl() {
      upstreamCalls += 1;
      throw new Error("EOA mode must fail before RPC");
    },
  });
  const app = createServiceApp(TEST_ENVIRONMENT, {
    facilitatorClient: facilitator.client,
    logger: quietLogger(),
    compileHandler,
  });

  await withServer(app, async (origin) => {
    const response = await fetch(`${origin}/api/service`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "payment-signature": paidHeader(),
      },
      body: JSON.stringify({
        market: LIVE_MARKET_SNAPSHOT.slug,
        outcome: "YES",
        spend: "1.35",
        maxPrice: "0.27",
        wallet: "0x1111111111111111111111111111111111111111",
        executionMode: "eoa",
        pluginPreview: {},
      }),
    });
    assert.equal(response.status, 422);
    const body = await response.json();
    assert.equal(body.error.code, "maker_not_eligible");
    assert.equal(body.error.details.paymentAllowed, false);
    assert.equal(response.headers.get("payment-required"), null);
    assert.equal(response.headers.get("payment-response"), null);
  });
  assert.equal(upstreamCalls, 0);
  assert.equal(facilitator.calls.verify, 0);
  assert.equal(facilitator.calls.settle, 0);
});

test("an incomplete nonempty OPEN replay is refused before x402", async () => {
  const facilitator = trackedFacilitator();
  let upstreamCalls = 0;
  const compileHandler = createPaidIntentHandler({
    issueIntentImpl(compilation) { return compilation; },
    async resolveMarketImpl() {
      upstreamCalls += 1;
      return LIVE_MARKET_SNAPSHOT;
    },
  });
  const app = createServiceApp(TEST_ENVIRONMENT, {
    facilitatorClient: facilitator.client,
    logger: quietLogger(),
    compileHandler,
  });

  await withServer(app, async (origin) => {
    const response = await fetch(`${origin}/api/service`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        market: LIVE_MARKET_SNAPSHOT.slug,
        outcome: "YES",
        spend: "1.35",
        maxPrice: "0.27",
      }),
    });
    assert.equal(response.status, 422);
    const body = await response.json();
    assert.equal(body.error.code, "maker_not_eligible");
    assert.equal(body.error.details.paymentAllowed, false);
    assert.equal(response.headers.get("payment-required"), null);
    assert.equal(response.headers.get("payment-response"), null);
  });
  assert.equal(upstreamCalls, 0);
  assert.equal(facilitator.calls.verify, 0);
  assert.equal(facilitator.calls.settle, 0);
});

test("structured maker preflight is rate-limited and refuses an unsupported deposit wallet before x402", async () => {
  const facilitator = trackedFacilitator();
  let marketCalls = 0;
  let walletChecks = 0;
  const compileHandler = createPaidIntentHandler({
    issueIntentImpl(compilation) { return compilation; },
    async resolveMarketImpl() {
      marketCalls += 1;
      return LIVE_MARKET_SNAPSHOT;
    },
    async verifyExecutionWalletImpl(wallet) {
      walletChecks += 1;
      throw new ConvictionError(
        "maker_not_eligible",
        "Polygon factory does not bind this wallet to the buyer's Polymarket owner",
        { wallet, paymentAllowed: false, nextAction: "USE_READY_DEPOSIT_WALLET_OR_STOP" },
      );
    },
  });
  const app = createServiceApp(TEST_ENVIRONMENT, {
    facilitatorClient: facilitator.client,
    logger: quietLogger(),
    compileHandler,
    prePaymentOpenGuard: createPublicApiGuard({
      limit: 1,
      windowMs: 60_000,
      maxBodyBytes: 32 * 1024,
      maxMarketLength: 512,
      maxInFlight: 1,
    }),
  });
  const body = {
    market: LIVE_MARKET_SNAPSHOT.slug,
    outcome: "YES",
    spend: "1.35",
    maxPrice: "0.27",
    wallet: "0x6a355e4971d9ac2ab97d22c3cf361d42faba33fe",
    executionMode: "deposit-wallet",
    walletReadiness: {
      ok: true,
      accessible: true,
      status: "deposit_wallet_ready",
      wallet: {
        eoa: "0x1111111111111111111111111111111111111111",
        deposit_wallet: "0x6a355e4971d9ac2ab97d22c3cf361d42faba33fe",
      },
    },
    pluginPreview: {},
  };

  await withServer(app, async (origin) => {
    const headers = {
      "content-type": "application/json",
      "x-vercel-forwarded-for": "203.0.113.71",
    };
    const first = await fetch(`${origin}/api/service`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
    assert.equal(first.status, 422);
    assert.equal((await first.json()).error.code, "maker_not_eligible");
    assert.equal(first.headers.get("payment-required"), null);

    const second = await fetch(`${origin}/api/service`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
    assert.equal(second.status, 429);
    assert.equal((await second.json()).error.code, "rate_limited");
    assert.equal(second.headers.get("payment-required"), null);

    const bare = await fetch(`${origin}/api/service`, {
      method: "POST",
      headers,
      body: "{}",
    });
    assert.equal(bare.status, 402);
    assert.ok(bare.headers.get("payment-required"));
  });

  assert.equal(walletChecks, 1);
  assert.equal(marketCalls, 0);
  assert.equal(facilitator.calls.verify, 0);
  assert.equal(facilitator.calls.settle, 0);
});
