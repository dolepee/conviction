import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import test from "node:test";

import { sha256 } from "../src/canonical.mjs";
import { compileCloseIntent } from "../src/exit-intent-compiler.mjs";
import { createIntentIssuer } from "../src/intent-issuer.mjs";
import { LIVE_MARKET_SNAPSHOT } from "./fixtures.mjs";
import {
  buildCloseReceiptRequest,
  validateCloseCard,
  validateCloseLiveResult,
  validateClosePluginPreview,
  validateCloseProof,
} from "../skills/conviction-executor/scripts/conviction-exit-card.mjs";

const NOW = Date.parse("2026-07-21T02:00:10.000Z");
const WALLET = "0x6a355e4971d9ac2ab97d22c3cf361d42faba33fe";
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
  actualSharesRaw: "5000000",
  intentVersion: "conviction-intent-v4",
  verificationMode: "signed-intent-window",
});
const position = Object.freeze({
  chainId: 137,
  wallet: WALLET,
  outcomeTokenId: LIVE_MARKET_SNAPSHOT.yesTokenId,
  balanceRaw: "5000000",
  approvedForExchange: true,
  blockNumber: "0x5666a7b",
  blockHash: `0x${"a".repeat(64)}`,
  capturedAt: "2026-07-21T02:00:09.000Z",
});

function closeCard() {
  return issuer(compileCloseIntent({
    action: "close",
    market: LIVE_MARKET_SNAPSHOT.slug,
    outcome: "yes",
    shares: "5",
    minPrice: "0.26",
    wallet: WALLET,
    rationale: "Close the full verified YES position at no less than twenty-six cents.",
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
      expires: null,
      fee_rate_bps: 0,
      limit_price: 0.26,
      limit_price_requested: 0.26,
      market_id: LIVE_MARKET_SNAPSHOT.conditionId,
      note: "dry-run: order not submitted",
      order_type: "FOK",
      outcome: "yes",
      post_only: false,
      price_adjusted: false,
      shares: 5,
      shares_requested: 5,
      side: "SELL",
      token_id: LIVE_MARKET_SNAPSHOT.yesTokenId,
      usdc_out: 1.3,
    },
  };
}

function liveResult() {
  const result = preview();
  delete result.dry_run;
  delete result.data.note;
  result.data.status = "matched";
  result.data.order_id = `0x${"b".repeat(64)}`;
  result.data.tx_hashes = [`0x${"c".repeat(64)}`];
  return result;
}

function clone(value) {
  return structuredClone(value);
}

function proofDocument(card = closeCard()) {
  const transactionHash = `0x${"c".repeat(64)}`;
  const orderId = `0x${"b".repeat(64)}`;
  const settledAt = "2026-07-21T02:00:12.000Z";
  const receiptProof = {
    version: "conviction-close-receipt-v1",
    chainId: 137,
    transactionHash,
    blockNumber: 90_000_000,
    exchange: "0xe111180000d2663c0091e4f400237545b87b996b",
    wallet: WALLET,
    orderId,
    outcome: "YES",
    outcomeTokenId: LIVE_MARKET_SNAPSHOT.yesTokenId,
    sharesRaw: "5000000",
    grossProceedsRaw: "1300000",
    feeRaw: "0",
    netProceedsRaw: "1300000",
    checks: {
      transactionSucceeded: true,
      standardExchangeV2: true,
      exactOutcomeDebit: true,
      exactCollateralCredit: true,
      exactVenueFee: true,
      exactSellOrderFill: true,
    },
  };
  const closeProof = {
    version: "conviction-close-proof-v1",
    intentHash: card.intentHash,
    sourceIntentHash: card.intent.source.intentHash,
    sourcePositionProofHash: card.intent.source.positionProofHash,
    receiptHash: sha256(receiptProof),
    transactionHash,
    blockNumber: 90_000_000,
    blockHash: `0x${"d".repeat(64)}`,
    settledAt,
    orderId,
    marketConditionId: LIVE_MARKET_SNAPSHOT.conditionId,
    outcome: "YES",
    outcomeTokenId: LIVE_MARKET_SNAPSHOT.yesTokenId,
    wallet: WALLET,
    bounds: {
      exactSharesRaw: "5000000",
      minPrice: "0.26",
      minimumGrossProceedsRaw: "1300000",
      feeRateBpsMax: 0,
      maximumFeeRaw: "0",
      minimumNetProceedsRaw: "1300000",
    },
    fill: {
      actualSharesRaw: "5000000",
      actualGrossProceedsRaw: "1300000",
      actualFeeRaw: "0",
      actualNetProceedsRaw: "1300000",
      actualAveragePriceFloor: "0.26",
    },
    issuanceKeyId: card.issuance.keyId,
    issuanceFingerprint: card.issuance.publicKeyFingerprint,
    checks: {
      canonicalExitIntentHash: true,
      verifiedSourcePositionBound: true,
      selectedOutcomeToken: true,
      exactSharesClosed: true,
      grossProceedsAboveMinimum: true,
      sellPriceAboveMinimum: true,
      venueFeeWithinMaximum: true,
      netProceedsAboveMinimum: true,
      receiptSettlementMatched: true,
      trustedIssuerSignature: true,
      settlementInsideSignedWindow: true,
      settlementBlockMatched: true,
    },
  };
  const closePassport = {
    version: "conviction-close-passport-v1",
    status: "CLOSED",
    issuance: card.issuance,
    intent: card.intent,
    receiptProof,
    closeProof,
  };
  return {
    ok: true,
    intent: card.intent,
    issuance: card.issuance,
    receiptProof,
    closeProof,
    closeProofHash: sha256(closeProof),
    closePassport,
    closePassportHash: sha256(closePassport),
  };
}

test("validates a signed CLOSE card and exact official dry run", () => {
  const card = closeCard();
  const validated = validateCloseCard(card, { now: NOW + 2_000, trustedIssuers });
  assert.equal(validated.intent.action, "CLOSE");
  assert.equal(validated.bounds.sharesRaw, "5000000");
  assert.equal(validated.bounds.minimumNetProceedsRaw, "1300000");
  assert.equal(validateClosePluginPreview(card, preview(), { now: NOW + 2_000, trustedIssuers }).ok, true);
});

test("builds one canonical CLOSE receipt request", () => {
  const card = closeCard();
  const body = buildCloseReceiptRequest(card, liveResult(), { trustedIssuers });
  assert.deepEqual(Object.keys(body), ["transactionHash", "orderId", "intentHash", "intent", "issuance"]);
  assert.equal(body.transactionHash, `0x${"c".repeat(64)}`);
  assert.equal(body.orderId, `0x${"b".repeat(64)}`);
});

test("independently validates the returned CLOSE passport", () => {
  const card = closeCard();
  const proof = proofDocument(card);
  const expectedReceiptRequest = {
    transactionHash: proof.closeProof.transactionHash,
    orderId: proof.closeProof.orderId,
    intentHash: card.intentHash,
    intent: card.intent,
    issuance: card.issuance,
  };
  const validated = validateCloseProof(card, proof, { trustedIssuers, expectedReceiptRequest });
  assert.equal(validated.transactionHash, `0x${"c".repeat(64)}`);
  assert.equal(validated.closeProofHash, proof.closeProofHash);

  const substituted = clone(proof);
  substituted.closeProof.sourcePositionProofHash = `0x${"9".repeat(64)}`;
  substituted.closeProofHash = sha256(substituted.closeProof);
  substituted.closePassport.closeProof = substituted.closeProof;
  substituted.closePassportHash = sha256(substituted.closePassport);
  assert.throws(
    () => validateCloseProof(card, substituted, { trustedIssuers, expectedReceiptRequest }),
    (error) => error.code === "proof_card_mismatch",
  );

  assert.throws(
    () => validateCloseProof(card, proof, {
      trustedIssuers,
      expectedReceiptRequest: { ...expectedReceiptRequest, transactionHash: `0x${"8".repeat(64)}` },
    }),
    (error) => error.code === "live_result_mismatch",
  );

  const falseDisplay = clone(proof);
  falseDisplay.closeProof.fill.actualAveragePriceFloor = "0.99";
  falseDisplay.closeProofHash = sha256(falseDisplay.closeProof);
  falseDisplay.closePassport.closeProof = falseDisplay.closeProof;
  falseDisplay.closePassportHash = sha256(falseDisplay.closePassport);
  assert.throws(
    () => validateCloseProof(card, falseDisplay, { trustedIssuers, expectedReceiptRequest }),
    (error) => error.code === "proof_bounds_mismatch",
  );
});

test("rejects BUY substitution, token substitution, share rewrite, and crossed floor", () => {
  const card = closeCard();
  const mutations = [
    (value) => { value.data.side = "BUY"; },
    (value) => { value.data.token_id = LIVE_MARKET_SNAPSHOT.noTokenId; },
    (value) => { value.data.shares = 4; },
    (value) => { value.data.limit_price = 0.25; },
    (value) => { value.data.order_type = "FAK"; },
    (value) => { value.data.price_adjusted = true; },
  ];
  for (const mutate of mutations) {
    const value = preview();
    mutate(value);
    assert.throws(
      () => validateClosePluginPreview(card, value, { now: NOW + 2_000, trustedIssuers }),
      (error) => error.code === "plugin_mismatch" || error.code === "close_economics_mismatch",
    );
  }
});

test("rejects resting or ambiguous live results", () => {
  const card = closeCard();
  const resting = liveResult();
  resting.data.status = "live";
  resting.data.tx_hashes = [];
  assert.throws(
    () => validateCloseLiveResult(card, resting, { trustedIssuers }),
    (error) => error.code === "unsettled_close",
  );
  const ambiguous = liveResult();
  ambiguous.data.tx_hashes.push(`0x${"d".repeat(64)}`);
  assert.throws(
    () => validateCloseLiveResult(card, ambiguous, { trustedIssuers }),
    (error) => error.code === "ambiguous_settlement",
  );
});

test("rejects mutation of the source proof even after recomputing no signature", () => {
  const card = clone(closeCard());
  card.intent.source.outcomeTokenId = LIVE_MARKET_SNAPSHOT.noTokenId;
  assert.throws(
    () => validateCloseCard(card, { now: NOW + 2_000, trustedIssuers }),
    (error) => error.code === "intent_hash_mismatch",
  );
});
