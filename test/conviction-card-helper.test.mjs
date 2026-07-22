import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";

import { sha256 } from "../src/canonical.mjs";
import { compileIntent } from "../src/intent-compiler.mjs";
import { createIntentIssuer, trustedIssuerRegistry } from "../src/intent-issuer.mjs";
import { verifyPositionProof } from "../src/receipt-verifier.mjs";
import {
  buildReceiptRequest,
  parseCard,
  validateCard,
  validatePluginPreview,
  validateProof,
  validateTerminalZeroOpenResult,
} from "../skills/conviction-executor/scripts/conviction-card.mjs";
import { LIVE_EXPECTED_FILL, LIVE_MARKET_SNAPSHOT, LIVE_RECEIPT } from "./fixtures.mjs";

const SAMPLE_PATH = new URL("../assets/conviction-sample-position-card.json", import.meta.url);
const SAMPLE = JSON.parse(readFileSync(SAMPLE_PATH, "utf8"));
const SAMPLE_NOW = "2026-07-21T12:16:00.000Z";
const { privateKey: ISSUER_PRIVATE_KEY } = generateKeyPairSync("ed25519");
const SAMPLE_ISSUER = createIntentIssuer({
  keyId: "conviction-test-2026-07",
  privateKey: ISSUER_PRIVATE_KEY,
  now: () => Date.parse("2026-07-21T12:15:48.000Z"),
});
const TRUSTED_ISSUERS = [SAMPLE_ISSUER.issuer];

function clone(value) {
  return structuredClone(value);
}

function signedSample() {
  const wrapper = clone(SAMPLE);
  const response = wrapper.response;
  response.intent.version = "conviction-intent-v4";
  response.intent.order.feeEnforcement = "signed-order-bounds-plus-post-settlement-verification";
  const expiresAt = new Date(Date.parse(response.intent.snapshot.capturedAt) + 300_000).toISOString();
  response.intent.snapshot.expiresAt = expiresAt;
  response.executionCard.expiresAt = expiresAt;
  response.executionCard.argv = [
    "buy",
    "--market-id",
    response.intent.market.conditionId,
    "--token-id",
    response.intent.order.outcomeTokenId,
    "--outcome",
    response.intent.order.outcome.toLowerCase(),
    "--amount",
    response.intent.order.maximumOrderPrincipal,
    "--price",
    response.intent.order.maxPrice,
    "--order-type",
    "FAK",
  ];
  wrapper.response.intentHash = sha256(wrapper.response.intent);
  wrapper.response = SAMPLE_ISSUER(wrapper.response);
  return wrapper;
}

const SIGNED_SAMPLE = signedSample();

function reissue(wrapper) {
  wrapper.response.intentHash = sha256(wrapper.response.intent);
  wrapper.response = SAMPLE_ISSUER(wrapper.response);
  return wrapper;
}

function pluginPreview() {
  return {
    ok: true,
    dry_run: true,
    data: {
      clob_version: "V2",
      collateral_token: "0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB",
      condition_id: SIGNED_SAMPLE.response.intent.market.conditionId,
      exchange_address: "0xE111180000d2663C0091e4f400237545B87B996B",
      expires: null,
      fee_rate_bps: 1000,
      limit_price: 0.14,
      market_id: SIGNED_SAMPLE.response.intent.market.conditionId,
      neg_risk: false,
      note: "dry-run: order not submitted",
      order_type: "FAK",
      outcome: "no",
      post_only: false,
      shares: 8,
      side: "BUY",
      token_id: SIGNED_SAMPLE.response.intent.order.outcomeTokenId,
      usdc_amount: 1.12,
      usdc_requested: 1.12,
    },
  };
}

function liveResult() {
  const preview = pluginPreview();
  delete preview.dry_run;
  delete preview.data.note;
  preview.data.status = "matched";
  preview.data.order_id = `0x${"a".repeat(64)}`;
  preview.data.tx_hashes = [`0x${"b".repeat(64)}`];
  return preview;
}

function signedProofFixture() {
  const now = Date.parse("2026-07-21T02:00:10.000Z");
  const compilation = compileIntent({
    market: LIVE_MARKET_SNAPSHOT.slug,
    outcome: "yes",
    spend: "1.35",
    maxPrice: "0.27",
    wallet: LIVE_EXPECTED_FILL.wallet,
    rationale: "I expect this event to resolve YES and will not pay above 27 cents.",
  }, LIVE_MARKET_SNAPSHOT, {
    now,
    quoteTtlMs: 300_000,
    intentVersion: "conviction-intent-v4",
  });
  const issue = createIntentIssuer({
    keyId: "conviction-proof-test-2026-07",
    privateKey: ISSUER_PRIVATE_KEY,
    now: () => now + 1_000,
  });
  const issued = issue(compilation);
  const trustedIssuers = trustedIssuerRegistry([issue.issuer]);
  const receipt = clone(LIVE_RECEIPT);
  receipt.blockHash = `0x${"c".repeat(64)}`;
  const proof = verifyPositionProof({
    chainId: 137,
    receipt,
    settlementBlock: {
      number: receipt.blockNumber,
      hash: receipt.blockHash,
      timestamp: `0x${Math.floor((now + 2_000) / 1_000).toString(16)}`,
    },
    intent: issued.intent,
    intentHash: issued.intentHash,
    issuance: issued.issuance,
    trustedIssuers,
    conditionTokenIds: {
      YES: LIVE_MARKET_SNAPSHOT.yesTokenId,
      NO: LIVE_MARKET_SNAPSHOT.noTokenId,
    },
    orderId: LIVE_EXPECTED_FILL.orderId,
  });
  return { card: issued, proof, trustedIssuers };
}

test("parses and validates raw or wrapped canonical cards", () => {
  assert.equal(parseCard(SIGNED_SAMPLE), SIGNED_SAMPLE.response);
  assert.equal(parseCard(JSON.stringify(SIGNED_SAMPLE.response)).intentHash, SIGNED_SAMPLE.response.intentHash);

  const result = validateCard(SIGNED_SAMPLE, { now: SAMPLE_NOW, trustedIssuers: TRUSTED_ISSUERS });
  assert.equal(result.ok, true);
  assert.equal(result.outcome, "NO");
  assert.equal(result.wallet, "0x1111111111111111111111111111111111111111");
  assert.equal(result.bounds.maximumTotalDebitRaw, "1232000");
});

test("fails closed on hash, chain, venue, token, wallet, budget, depth, expiry, and argv substitution", async (t) => {
  const cases = [
    ["canonical hash", (card) => { card.response.intent.order.maxPrice = "0.15"; }, "intent_hash_mismatch", false],
    ["chain", (card) => { card.response.intent.chainId = 1; }, "wrong_chain", true],
    ["exchange", (card) => { card.response.intent.market.exchange = `0x${"2".repeat(40)}`; }, "wrong_exchange", true],
    ["token mapping", (card) => { card.response.intent.market.outcomes.NO.tokenId = "123"; }, "token_mapping_mismatch", true],
    ["wallet", (card) => { card.response.intent.buyer.wallet = "not-a-wallet"; }, "invalid_wallet", true],
    ["budget", (card) => { card.response.intent.order.maximumTotalDebitRaw = "1"; }, "card_economics_mismatch", true],
    ["depth", (card) => { card.response.intent.snapshot.boundedAskDepth = "1"; }, "insufficient_depth", true],
    ["expiry", (card) => { card.response.intent.snapshot.expiresAt = "2026-07-21T13:17:47.095Z"; card.response.executionCard.expiresAt = card.response.intent.snapshot.expiresAt; }, "invalid_expiry", true],
    ["argv injection", (card) => { card.response.executionCard.argv.push("; rm -rf /tmp/example"); }, "invalid_execution_card", false],
  ];

  for (const [name, mutate, code, mustRehash] of cases) {
    await t.test(name, () => {
      const card = clone(SIGNED_SAMPLE);
      mutate(card);
      if (mustRehash) reissue(card);
      assert.throws(
        () => validateCard(card, { now: SAMPLE_NOW, trustedIssuers: TRUSTED_ISSUERS }),
        (error) => error.code === code,
      );
    });
  }

  assert.throws(
    () => validateCard(SIGNED_SAMPLE, {
      now: SIGNED_SAMPLE.response.intent.snapshot.expiresAt,
      trustedIssuers: TRUSTED_ISSUERS,
    }),
    (error) => error.code === "expired_card",
  );
});

test("validates exact official V2 dry-run output without accepting a live or rewritten result", () => {
  const result = validatePluginPreview(SIGNED_SAMPLE, pluginPreview(), {
    now: SAMPLE_NOW,
    trustedIssuers: TRUSTED_ISSUERS,
  });
  assert.equal(result.ok, true);
  assert.equal(result.tokenId, SIGNED_SAMPLE.response.intent.order.outcomeTokenId);
  assert.equal(result.preview.note, "dry-run: order not submitted");

  const wrongToken = pluginPreview();
  wrongToken.data.token_id = "123";
  assert.throws(
    () => validatePluginPreview(SIGNED_SAMPLE, wrongToken, { now: SAMPLE_NOW, trustedIssuers: TRUSTED_ISSUERS }),
    (error) => error.code === "plugin_mismatch",
  );

  const rewrittenPrincipal = pluginPreview();
  rewrittenPrincipal.data.usdc_amount = 1.13;
  assert.throws(
    () => validatePluginPreview(SIGNED_SAMPLE, rewrittenPrincipal, { now: SAMPLE_NOW, trustedIssuers: TRUSTED_ISSUERS }),
    (error) => error.code === "plugin_mismatch",
  );

  const notDry = pluginPreview();
  notDry.dry_run = false;
  assert.throws(
    () => validatePluginPreview(SIGNED_SAMPLE, notDry, { now: SAMPLE_NOW, trustedIssuers: TRUSTED_ISSUERS }),
    (error) => error.code === "not_dry_run",
  );
});

test("builds only the canonical receipt request from one matched settlement", () => {
  const body = buildReceiptRequest(SIGNED_SAMPLE, liveResult(), { trustedIssuers: TRUSTED_ISSUERS });
  assert.deepEqual(Object.keys(body), ["transactionHash", "orderId", "intentHash", "intent", "issuance"]);
  assert.equal(body.transactionHash, `0x${"b".repeat(64)}`);
  assert.equal(body.orderId, `0x${"a".repeat(64)}`);
  assert.equal(body.intentHash, SIGNED_SAMPLE.response.intentHash);
  assert.equal(body.intent, SIGNED_SAMPLE.response.intent);
  assert.equal(body.issuance, SIGNED_SAMPLE.response.issuance);

  const liveWithoutRequestMarketId = liveResult();
  delete liveWithoutRequestMarketId.data.market_id;
  assert.equal(
    buildReceiptRequest(SIGNED_SAMPLE, liveWithoutRequestMarketId, { trustedIssuers: TRUSTED_ISSUERS }).orderId,
    `0x${"a".repeat(64)}`,
  );

  const wrongOptionalMarketId = liveResult();
  wrongOptionalMarketId.data.market_id = "substituted-market";
  assert.throws(
    () => buildReceiptRequest(SIGNED_SAMPLE, wrongOptionalMarketId, { trustedIssuers: TRUSTED_ISSUERS }),
    (error) => error.code === "plugin_mismatch",
  );

  for (const mutate of [
    (value) => { delete value.data.condition_id; },
    (value) => { value.data.condition_id = `0x${"1".repeat(64)}`; },
    (value) => { delete value.data.token_id; },
    (value) => { value.data.token_id = "123"; },
  ]) {
    const invalidLive = liveResult();
    mutate(invalidLive);
    assert.throws(
      () => buildReceiptRequest(SIGNED_SAMPLE, invalidLive, { trustedIssuers: TRUSTED_ISSUERS }),
      (error) => error.code === "plugin_mismatch",
    );
  }

  const previewWithoutMarketId = pluginPreview();
  delete previewWithoutMarketId.data.market_id;
  assert.throws(
    () => validatePluginPreview(SIGNED_SAMPLE, previewWithoutMarketId, {
      now: SAMPLE_NOW,
      trustedIssuers: TRUSTED_ISSUERS,
    }),
    (error) => error.code === "plugin_mismatch",
  );

  const unmatched = liveResult();
  unmatched.data.status = "unmatched";
  assert.throws(
    () => buildReceiptRequest(SIGNED_SAMPLE, unmatched, { trustedIssuers: TRUSTED_ISSUERS }),
    (error) => error.code === "unsettled_order",
  );

  const ambiguous = liveResult();
  ambiguous.data.tx_hashes.push(`0x${"c".repeat(64)}`);
  assert.throws(
    () => buildReceiptRequest(SIGNED_SAMPLE, ambiguous, { trustedIssuers: TRUSTED_ISSUERS }),
    (error) => error.code === "ambiguous_settlement",
  );

  const substitutedOutcome = liveResult();
  substitutedOutcome.data.outcome = "yes";
  assert.throws(
    () => buildReceiptRequest(SIGNED_SAMPLE, substitutedOutcome, { trustedIssuers: TRUSTED_ISSUERS }),
    (error) => error.code === "plugin_mismatch",
  );
});

test("authenticates only an exact terminal zero-fill OPEN identity for independent reconciliation", () => {
  const terminal = liveResult();
  terminal.data.status = "unmatched";
  terminal.data.tx_hashes = [];
  const verified = validateTerminalZeroOpenResult(SIGNED_SAMPLE, terminal, {
    trustedIssuers: TRUSTED_ISSUERS,
  });
  assert.equal(verified.orderId, terminal.data.order_id);
  assert.equal(verified.status, "unmatched");
  assert.equal(verified.reportedSharesRaw, "8000000");

  for (const mutate of [
    (value) => { value.data.status = "live"; },
    (value) => { value.data.tx_hashes = [`0x${"c".repeat(64)}`]; },
    (value) => { value.data.token_id = "123"; },
    (value) => { value.data.order_type = "GTC"; },
    (value) => { value.data.order_id = "0x1234"; },
  ]) {
    const invalid = clone(terminal);
    mutate(invalid);
    assert.throws(
      () => validateTerminalZeroOpenResult(SIGNED_SAMPLE, invalid, {
        trustedIssuers: TRUSTED_ISSUERS,
      }),
    );
  }
});

test("validates the canonical post-fill proof against its original card", () => {
  const { card, proof, trustedIssuers } = signedProofFixture();
  const result = validateProof(card, proof, { trustedIssuers });
  assert.equal(result.ok, true);
  assert.equal(result.transactionHash, proof.positionProof.transactionHash);
  assert.equal(result.positionProofHash, proof.positionProofHash);
  assert.equal(result.positionPassportHash, proof.positionPassportHash);

  const mutated = clone(proof);
  mutated.positionProof.wallet = `0x${"3".repeat(40)}`;
  mutated.positionProofHash = sha256(mutated.positionProof);
  assert.throws(
    () => validateProof(card, mutated, { trustedIssuers }),
    (error) => error.code === "proof_card_mismatch",
  );
});

test("rejects a signed proof that omits issuer assurance or CTF token binding", () => {
  const { card, proof, trustedIssuers } = signedProofFixture();
  const missingAssurance = clone(proof);
  delete missingAssurance.assurance;
  assert.throws(
    () => validateProof(card, missingAssurance, { trustedIssuers }),
    (error) => error.code === "proof_assurance_mismatch",
  );
  const missingMarketBinding = clone(proof);
  delete missingMarketBinding.positionProof.checks.marketConditionTokensMatched;
  missingMarketBinding.positionProofHash = sha256(missingMarketBinding.positionProof);
  assert.throws(
    () => validateProof(card, missingMarketBinding, { trustedIssuers }),
    (error) => error.code === "proof_assurance_mismatch",
  );
});
