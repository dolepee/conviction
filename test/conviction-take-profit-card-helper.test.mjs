import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import test from "node:test";

import { compileTakeProfitIntent } from "../src/take-profit-intent-compiler.mjs";
import { createIntentIssuer } from "../src/intent-issuer.mjs";
import { sha256 } from "../src/canonical.mjs";
import { LIVE_MARKET_SNAPSHOT } from "./fixtures.mjs";
import {
  buildTakeProfitOrderProof,
  classifyTakeProfitOrderSnapshot,
  validateTakeProfitCard,
  validateTakeProfitLiveResult,
  validateTakeProfitPluginPreview,
} from "../skills/conviction-executor/scripts/conviction-take-profit-card.mjs";

const NOW = Date.parse("2026-07-21T02:00:10.000Z");
const WALLET = "0x6a355e4971d9ac2ab97d22c3cf361d42faba33fe";
const SIGNER = "0x79e23e61a754901d53e55202e311f295a85fa070";
const ORDER_ID = `0x${"b".repeat(64)}`;
const VENUE_EXPIRES_AT = "2026-07-21T03:00:00.000Z";
const VENUE_EXPIRES_UNIX = String(Date.parse(VENUE_EXPIRES_AT) / 1_000);
const { privateKey } = generateKeyPairSync("ed25519");
const issuer = createIntentIssuer({
  keyId: "conviction-test-2026-07",
  privateKey,
  now: () => NOW + 1_000,
});
const trustedIssuers = [issuer.issuer];
const source = Object.freeze({
  intentHash: `0x${"1".repeat(64)}`,
  positionProofHash: `0x${"2".repeat(64)}`,
  transactionHash: `0x${"3".repeat(64)}`,
  orderId: `0x${"4".repeat(64)}`,
  wallet: WALLET,
  marketConditionId: LIVE_MARKET_SNAPSHOT.conditionId,
  outcome: "YES",
  outcomeTokenId: LIVE_MARKET_SNAPSHOT.yesTokenId,
  actualSharesRaw: "10000000",
  intentVersion: "conviction-intent-v4",
  verificationMode: "signed-intent-window",
});
const position = Object.freeze({
  chainId: 137,
  wallet: WALLET,
  outcomeTokenId: LIVE_MARKET_SNAPSHOT.yesTokenId,
  balanceRaw: "10000000",
  approvedForExchange: true,
  blockNumber: "0x5666a7b",
  blockHash: `0x${"a".repeat(64)}`,
  capturedAt: "2026-07-21T02:00:09.000Z",
});

function takeProfitCard() {
  return issuer(compileTakeProfitIntent({
    action: "take_profit",
    market: LIVE_MARKET_SNAPSHOT.slug,
    outcome: "yes",
    shares: "10",
    targetPrice: "0.4",
    venueExpiresAt: VENUE_EXPIRES_AT,
    wallet: WALLET,
    rationale: "Take profit on the full verified YES position at forty cents.",
    source,
  }, LIVE_MARKET_SNAPSHOT, position, {
    now: NOW,
    quoteTtlMs: 300_000,
  }));
}

function preview() {
  return {
    ok: true,
    dry_run: true,
    data: {
      condition_id: LIVE_MARKET_SNAPSHOT.conditionId,
      expires: Number(VENUE_EXPIRES_UNIX),
      fee_rate_bps: 0,
      limit_price: 0.4,
      limit_price_requested: 0.4,
      market_id: LIVE_MARKET_SNAPSHOT.conditionId,
      note: "dry-run: order not submitted",
      order_type: "GTD",
      outcome: "yes",
      post_only: true,
      price_adjusted: false,
      shares: 10,
      shares_requested: 10,
      side: "SELL",
      token_id: LIVE_MARKET_SNAPSHOT.yesTokenId,
      usdc_out: 4,
    },
  };
}

function liveResult() {
  const value = preview();
  delete value.dry_run;
  delete value.data.note;
  value.data.status = "live";
  value.data.order_id = ORDER_ID;
  value.data.tx_hashes = [];
  return value;
}

function orderSnapshot(overrides = {}) {
  const orderOverrides = overrides.order || {};
  return {
    version: "conviction-polymarket-order-snapshot-v1",
    verificationSource: "authenticated-polymarket-clob",
    onChain: false,
    fetchedAt: "2026-07-21T02:00:14.000Z",
    signerAddress: SIGNER,
    depositWallet: WALLET,
    credentialOwnerVerified: true,
    ...overrides,
    order: {
      id: ORDER_ID,
      status: "LIVE",
      market: LIVE_MARKET_SNAPSHOT.conditionId,
      assetId: LIVE_MARKET_SNAPSHOT.yesTokenId,
      side: "SELL",
      originalSize: "10",
      sizeMatched: "0",
      price: "0.4",
      orderType: "GTD",
      expiration: VENUE_EXPIRES_UNIX,
      outcome: "Yes",
      createdAt: String((NOW + 3_000) / 1_000),
      associatedTrades: [],
      ...orderOverrides,
    },
  };
}

test("validates a signed post-only GTD take-profit card and exact plugin dry run", () => {
  const card = takeProfitCard();
  const validated = validateTakeProfitCard(card, { now: NOW + 2_000, trustedIssuers });
  assert.equal(validated.intent.action, "TAKE_PROFIT");
  assert.equal(validated.bounds.sharesRaw, "10000000");
  assert.equal(validated.bounds.targetPrice, "0.4");
  assert.equal(validated.bounds.venueExpiresAtUnix, VENUE_EXPIRES_UNIX);
  assert.equal(validateTakeProfitPluginPreview(card, preview(), {
    now: NOW + 2_000,
    trustedIssuers,
  }).ok, true);
});

test("builds an authenticated ARMED proof without claiming an on-chain fill", () => {
  const card = takeProfitCard();
  const proof = buildTakeProfitOrderProof(card, liveResult(), orderSnapshot(), {
    trustedIssuers,
    confirmedAt: NOW + 2_000,
  });
  assert.equal(proof.ok, true);
  assert.equal(proof.orderId, ORDER_ID);
  assert.equal(proof.restingOrderProof.status, "ARMED");
  assert.equal(proof.restingOrderProof.onChain, false);
  assert.equal(proof.restingOrderProof.bounds.postOnlyRequested, true);
  assert.match(proof.restingOrderProofHash, /^0x[0-9a-f]{64}$/);
  assert.match(proof.takeProfitPassportHash, /^0x[0-9a-f]{64}$/);
});

test("rejects plugin substitution before take-profit placement", () => {
  const card = takeProfitCard();
  const mutations = [
    (value) => { value.data.side = "BUY"; },
    (value) => { value.data.token_id = LIVE_MARKET_SNAPSHOT.noTokenId; },
    (value) => { value.data.shares = 9; },
    (value) => { value.data.limit_price = 0.39; },
    (value) => { value.data.order_type = "GTC"; },
    (value) => { value.data.post_only = false; },
    (value) => { value.data.expires += 1; },
    (value) => { value.data.price_adjusted = true; },
  ];
  for (const mutate of mutations) {
    const value = preview();
    mutate(value);
    assert.throws(
      () => validateTakeProfitPluginPreview(card, value, { now: NOW + 2_000, trustedIssuers }),
      (error) => error?.code === "plugin_mismatch" || error?.code === "take_profit_economics_mismatch",
    );
  }
});

test("requires a fresh exact LIVE zero-match order after submission", () => {
  const card = takeProfitCard();
  const cases = [
    [{ order: { id: `0x${"c".repeat(64)}` } }, "order_identity_mismatch"],
    [{ depositWallet: "0x3333333333333333333333333333333333333333" }, "order_wallet_mismatch"],
    [{ order: { assetId: LIVE_MARKET_SNAPSHOT.noTokenId } }, "order_token_mismatch"],
    [{ order: { status: "MATCHED", sizeMatched: "10", associatedTrades: ["trade"] } }, "take_profit_not_resting"],
    [{ order: { sizeMatched: "1" } }, "take_profit_economics_mismatch"],
    [{ order: { price: "0.39" } }, "take_profit_economics_mismatch"],
    [{ order: { expiration: String(Number(VENUE_EXPIRES_UNIX) + 1) } }, "order_expiry_mismatch"],
    [{ order: { createdAt: String((NOW + 1_000) / 1_000) } }, "order_before_confirmation"],
    [{ order: { createdAt: String((NOW + 2_000) / 1_000) } }, "order_before_confirmation"],
    [{ fetchedAt: VENUE_EXPIRES_AT }, "order_proof_after_expiry"],
  ];
  for (const [mutation, code] of cases) {
    assert.throws(
      () => buildTakeProfitOrderProof(card, liveResult(), orderSnapshot(mutation), {
        trustedIssuers,
        confirmedAt: NOW + 2_000,
      }),
      (error) => error?.code === code,
    );
  }
});

test("classifies resting, partial, filled, canceled, expired, and unknown TP states", () => {
  assert.equal(classifyTakeProfitOrderSnapshot(orderSnapshot()), "ARMED");
  assert.equal(classifyTakeProfitOrderSnapshot(orderSnapshot({ order: { sizeMatched: "4" } })), "PARTIAL_PENDING_CHAIN_PROOF");
  assert.equal(classifyTakeProfitOrderSnapshot(orderSnapshot({ order: { status: "MATCHED", sizeMatched: "10" } })), "FILLED_PENDING_CHAIN_PROOF");
  assert.equal(classifyTakeProfitOrderSnapshot(orderSnapshot({ order: { status: "CANCELED" } })), "CANCELED");
  assert.equal(classifyTakeProfitOrderSnapshot(orderSnapshot({ order: { status: "EXPIRED" } })), "EXPIRED");
  assert.equal(classifyTakeProfitOrderSnapshot(orderSnapshot({ order: { status: "CANCELED", sizeMatched: "4" } })), "PARTIAL_CANCELED_PENDING_CHAIN_PROOF");
  assert.equal(classifyTakeProfitOrderSnapshot(orderSnapshot({ order: { status: "EXPIRED", sizeMatched: "4" } })), "PARTIAL_EXPIRED_PENDING_CHAIN_PROOF");
  assert.equal(classifyTakeProfitOrderSnapshot(orderSnapshot({
    fetchedAt: VENUE_EXPIRES_AT,
  })), "UNKNOWN");
  assert.equal(classifyTakeProfitOrderSnapshot(orderSnapshot({ order: { status: "MYSTERY" } })), "UNKNOWN");
});

test("rejects live plugin results that settle, rest with another order ID, or do not rest", () => {
  const card = takeProfitCard();
  const settled = liveResult();
  settled.data.tx_hashes = [`0x${"d".repeat(64)}`];
  assert.throws(
    () => validateTakeProfitLiveResult(card, settled, { now: NOW + 2_000, trustedIssuers }),
    (error) => error?.code === "unexpected_settlement",
  );
  const matched = liveResult();
  matched.data.status = "matched";
  assert.throws(
    () => validateTakeProfitLiveResult(card, matched, { now: NOW + 2_000, trustedIssuers }),
    (error) => error?.code === "take_profit_not_resting",
  );
  const invalidId = liveResult();
  invalidId.data.order_id = "not-an-order";
  assert.throws(
    () => validateTakeProfitLiveResult(card, invalidId, { now: NOW + 2_000, trustedIssuers }),
    (error) => error?.code === "invalid_order_id",
  );
});

test("rejects issuer-signed precision fields that disagree with the execution snapshot", () => {
  for (const field of ["tickSize", "minOrderSize"]) {
    const compilation = compileTakeProfitIntent({
      action: "take_profit",
      market: LIVE_MARKET_SNAPSHOT.slug,
      outcome: "yes",
      shares: "10",
      targetPrice: "0.4",
      venueExpiresAt: VENUE_EXPIRES_AT,
      wallet: WALLET,
      source,
    }, LIVE_MARKET_SNAPSHOT, position, { now: NOW });
    compilation.intent.market[field] = field === "tickSize" ? "0.02" : "6";
    compilation.intentHash = sha256(compilation.intent);
    const signed = issuer(compilation);
    assert.throws(
      () => validateTakeProfitCard(signed, { now: NOW + 2_000, trustedIssuers }),
      (error) => error?.code === "market_snapshot_mismatch",
    );
  }
});
