import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";

import { createServiceApp } from "../api/service.js";
import {
  readFacilitatorCredentials,
  SERVICE_ASSET,
  SERVICE_NETWORK,
  SERVICE_PAYEE,
  SERVICE_PRICE_ATOMIC,
  SERVICE_RESOURCE,
  serviceRouteConfiguration,
} from "../src/service-payment.mjs";

const TEST_ENVIRONMENT = Object.freeze({
  OKX_API_KEY: "test-api-key",
  OKX_SECRET_KEY: "test-secret-key",
  OKX_PASSPHRASE: "test-passphrase",
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

function trackedFacilitator({ settleSuccess = true } = {}) {
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
          status: "success",
          payer: "0x1111111111111111111111111111111111111111",
          transaction: `0x${"ab".repeat(32)}`,
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
      const challenge = decodePaymentRequired(response.headers.get("payment-required"));
      assert.equal(challenge.accepts[0].amount, SERVICE_PRICE_ATOMIC);
    }
  });
});

test("a verified non-POST request is rejected without settlement", async () => {
  const facilitator = trackedFacilitator();
  const app = createServiceApp(TEST_ENVIRONMENT, {
    facilitatorClient: facilitator.client,
    logger: quietLogger(),
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
  const facilitator = trackedFacilitator();
  let compiles = 0;
  const app = createServiceApp(TEST_ENVIRONMENT, {
    facilitatorClient: facilitator.client,
    logger: quietLogger(),
    compileHandler(request, response) {
      compiles += 1;
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
});

test("a compiler error is delivered without settling the verified payment", async () => {
  const facilitator = trackedFacilitator();
  const app = createServiceApp(TEST_ENVIRONMENT, {
    facilitatorClient: facilitator.client,
    logger: quietLogger(),
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
});

test("settlement failure withholds a successful compiler response", async () => {
  const facilitator = trackedFacilitator({ settleSuccess: false });
  const app = createServiceApp(TEST_ENVIRONMENT, {
    facilitatorClient: facilitator.client,
    logger: quietLogger(),
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
});
