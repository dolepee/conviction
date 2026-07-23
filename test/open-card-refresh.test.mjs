import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import test from "node:test";

import { createIntentIssuer } from "../src/intent-issuer.mjs";
import { compileIntent } from "../src/intent-compiler.mjs";
import {
  OPEN_CARD_REFRESH_WINDOW_MS,
  attachOpenRefreshContract,
  refreshOpenCard,
} from "../src/open-card-refresh.mjs";
import { createRefreshHandler } from "../api/refresh.js";
import { SERVICE_ASSET, SERVICE_PAYEE, SERVICE_PRICE_ATOMIC } from "../src/service-constants.mjs";
import { LIVE_MARKET_SNAPSHOT } from "./fixtures.mjs";

const WALLET = "0x6a355e4971d9ac2ab97d22c3cf361d42faba33fe";
const PAYER = "0x1111111111111111111111111111111111111111";
const PAYMENT_TX = `0x${"9".repeat(64)}`;
const ORIGINAL_NOW = Date.parse("2026-07-21T02:00:10.000Z");
const REFRESH_NOW = Date.parse("2026-07-21T02:02:00.000Z");
const PAYMENT_SECONDS = Math.floor(Date.parse("2026-07-21T02:00:12.000Z") / 1_000);
const KEY_PAIR = generateKeyPairSync("ed25519");
const KEY_ID = "conviction-refresh-test";
const ENVIRONMENT = Object.freeze({
  CONVICTION_ISSUER_KEY_ID: KEY_ID,
  CONVICTION_ISSUER_PRIVATE_KEY_B64: KEY_PAIR.privateKey
    .export({ format: "der", type: "pkcs8" })
    .toString("base64"),
  CONVICTION_ISSUER_PUBLIC_KEY_B64: KEY_PAIR.publicKey
    .export({ format: "der", type: "spki" })
    .toString("base64"),
});

function originalCard() {
  const compiled = compileIntent({
    market: LIVE_MARKET_SNAPSHOT.slug,
    outcome: "yes",
    spend: "1.35",
    maxPrice: "0.27",
    wallet: WALLET,
    executionMode: "deposit-wallet",
    rationale: "",
  }, LIVE_MARKET_SNAPSHOT, {
    now: ORIGINAL_NOW,
    quoteTtlMs: 300_000,
    intentVersion: "conviction-intent-v4",
  });
  return createIntentIssuer({
    keyId: KEY_ID,
    privateKey: KEY_PAIR.privateKey,
    now: () => ORIGINAL_NOW + 1_000,
  })(compiled);
}

function preview() {
  return {
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
  };
}

function walletReadiness() {
  return {
    ok: true,
    accessible: true,
    status: "deposit_wallet_ready",
    wallet: { deposit_wallet: WALLET },
  };
}

function body() {
  return {
    card: originalCard(),
    paymentTx: PAYMENT_TX,
    payer: PAYER,
    walletReadiness: walletReadiness(),
    pluginPreview: preview(),
  };
}

function options(overrides = {}) {
  return {
    environment: ENVIRONMENT,
    now: () => REFRESH_NOW,
    async resolveMarketImpl(reference, { outcome }) {
      assert.equal(reference, LIVE_MARKET_SNAPSHOT.conditionId);
      assert.equal(outcome, "YES");
      return {
        ...LIVE_MARKET_SNAPSHOT,
        capturedAt: new Date(REFRESH_NOW).toISOString(),
      };
    },
    async verifyWalletImpl(wallet) {
      assert.equal(wallet, WALLET);
      return { ok: true, executionMode: "deposit-wallet" };
    },
    async verifyPaymentImpl(expected) {
      assert.deepEqual(
        {
          paymentTx: expected.paymentTx,
          payer: expected.payer,
          payee: expected.payee,
          asset: expected.asset,
          amountAtomic: expected.amountAtomic,
        },
        {
          paymentTx: PAYMENT_TX,
          payer: PAYER,
          payee: SERVICE_PAYEE,
          asset: SERVICE_ASSET,
          amountAtomic: SERVICE_PRICE_ATOMIC,
        },
      );
      return {
        ok: true,
        proof: {
          transactionHash: PAYMENT_TX,
          payer: PAYER,
          blockTimestamp: String(PAYMENT_SECONDS),
        },
      };
    },
    ...overrides,
  };
}

test("one paid OPEN can refresh the same bounds for thirty minutes without another payment", async () => {
  const refreshed = await refreshOpenCard(body(), options());
  assert.equal(refreshed.ok, true);
  assert.equal(refreshed.intent.version, "conviction-intent-v4");
  assert.equal(refreshed.intent.market.conditionId, LIVE_MARKET_SNAPSHOT.conditionId);
  assert.equal(refreshed.intent.order.outcome, "YES");
  assert.equal(refreshed.intent.order.requestedBudget, "1.35");
  assert.equal(refreshed.intent.order.maxPrice, "0.27");
  assert.equal(refreshed.intent.buyer.wallet, WALLET);
  assert.equal(refreshed.refreshedFromIntentHash, body().card.intentHash);
  assert.equal(refreshed.refresh.additionalPaymentRequired, false);
  assert.equal(refreshed.refresh.paymentTx, PAYMENT_TX);
  assert.equal(
    Date.parse(refreshed.refresh.reusableUntil),
    PAYMENT_SECONDS * 1_000 + OPEN_CARD_REFRESH_WINDOW_MS,
  );
});

test("refresh fails closed on expiry, EOA cards, plugin drift, or issuer substitution", async () => {
  await assert.rejects(
    refreshOpenCard(body(), options({
      now: () => PAYMENT_SECONDS * 1_000 + OPEN_CARD_REFRESH_WINDOW_MS + 1,
    })),
    (error) => error?.code === "refresh_window_expired",
  );

  const eoa = body();
  eoa.card = compileIntent({
    market: LIVE_MARKET_SNAPSHOT.slug,
    outcome: "yes",
    spend: "1.35",
    maxPrice: "0.27",
    wallet: WALLET,
    executionMode: "eoa",
  }, LIVE_MARKET_SNAPSHOT, {
    now: ORIGINAL_NOW,
    quoteTtlMs: 300_000,
    intentVersion: "conviction-intent-v4",
  });
  eoa.card = createIntentIssuer({
    keyId: KEY_ID,
    privateKey: KEY_PAIR.privateKey,
    now: () => ORIGINAL_NOW + 1_000,
  })(eoa.card);
  await assert.rejects(
    refreshOpenCard(eoa, options()),
    (error) => error?.code === "maker_not_eligible",
  );

  const drift = body();
  drift.pluginPreview.data.token_id = LIVE_MARKET_SNAPSHOT.noTokenId;
  await assert.rejects(
    refreshOpenCard(drift, options()),
    (error) => error?.code === "plugin_preview_mismatch",
  );

  const tampered = body();
  tampered.card.intent.order.maxPrice = "0.28";
  await assert.rejects(
    refreshOpenCard(tampered, options()),
    (error) => error?.code === "intent_hash_mismatch",
  );
});

test("paid card advertises the bounded refresh contract without claiming settlement", () => {
  const card = attachOpenRefreshContract(originalCard());
  assert.equal(card.refresh.endpoint, "https://conviction-bay.vercel.app/api/refresh");
  assert.equal(card.refresh.windowSeconds, 1800);
  assert.equal(card.refresh.additionalPaymentRequired, false);
  assert.equal(card.refresh.paymentTx, undefined);
});

test("refresh route accepts a normal signed-card payload above the generic 8 KiB limit", async () => {
  const requestBody = {
    ...body(),
    paddingRepresentativeOfSignedCardAndDiscovery: "x".repeat(12_000),
  };
  let delivered;
  const response = {
    statusCode: 0,
    headers: new Map(),
    status(value) { this.statusCode = value; return this; },
    setHeader(name, value) { this.headers.set(name.toLowerCase(), value); return this; },
    end(value) { delivered = JSON.parse(value); },
  };
  const handler = createRefreshHandler({
    async refreshImpl(value) {
      assert.equal(value.paddingRepresentativeOfSignedCardAndDiscovery.length, 12_000);
      return { ok: true };
    },
  });
  await handler({
    method: "POST",
    headers: { "x-vercel-forwarded-for": "203.0.113.1" },
    body: requestBody,
  }, response);
  assert.equal(response.statusCode, 200);
  assert.deepEqual(delivered, { ok: true });
});
