import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import test from "node:test";

import { sha256 } from "../src/canonical.mjs";
import { createIntentIssuer } from "../src/intent-issuer.mjs";
import {
  buildTakeProfitCancelOutcome,
  buildTakeProfitCancelRequest,
  buildTakeProfitLookupFailureStatus,
  buildTakeProfitStatus,
  TAKE_PROFIT_CANCEL_CONFIRMATION,
  validateArmedTakeProfitJournal,
} from "../src/take-profit-lifecycle.mjs";

const NOW = Date.parse("2026-07-21T02:00:14.000Z");
const CAPTURED_AT = "2026-07-21T02:00:10.000Z";
const INTENT_EXPIRES_AT = "2026-07-21T02:05:10.000Z";
const ARMED_FETCHED_AT = "2026-07-21T02:00:13.000Z";
const VENUE_EXPIRES_AT = "2026-07-21T03:00:00.000Z";
const VENUE_EXPIRES_UNIX = String(Date.parse(VENUE_EXPIRES_AT) / 1_000);
const SIGNER = "0x79e23e61a754901d53e55202e311f295a85fa070";
const WALLET = "0x6a355e4971d9ac2ab97d22c3cf361d42faba33fe";
const CONDITION_ID = `0x${"a".repeat(64)}`;
const ORDER_ID = `0x${"b".repeat(64)}`;
const TOKEN_ID = "55115078421062885512539156303747803058407616201213034911037320915726138659123";
const SOURCE_INTENT_HASH = `0x${"1".repeat(64)}`;
const SOURCE_POSITION_HASH = `0x${"2".repeat(64)}`;
const { privateKey } = generateKeyPairSync("ed25519");
const issuer = createIntentIssuer({
  keyId: "conviction-tp-lifecycle-test",
  privateKey,
  now: () => Date.parse("2026-07-21T02:00:11.000Z"),
});
const trustedIssuers = [issuer.issuer];

function fixtureJournal() {
  const intent = {
    version: "conviction-take-profit-intent-v1",
    chainId: 137,
    action: "TAKE_PROFIT",
    market: {
      conditionId: CONDITION_ID,
      outcome: "YES",
      outcomeTokenId: TOKEN_ID,
    },
    order: {
      action: "TAKE_PROFIT",
      side: "SELL",
      orderType: "GTD",
      postOnly: true,
      outcome: "YES",
      outcomeTokenId: TOKEN_ID,
      sharesRaw: "10000000",
      targetPrice: "0.4",
      minimumGrossProceedsRaw: "4000000",
      maximumFeeRaw: "0",
      minimumNetProceedsRaw: "4000000",
      venueExpiresAtUnix: VENUE_EXPIRES_UNIX,
    },
    seller: { wallet: WALLET },
    source: {
      intentHash: SOURCE_INTENT_HASH,
      positionProofHash: SOURCE_POSITION_HASH,
    },
    snapshot: {
      capturedAt: CAPTURED_AT,
      expiresAt: INTENT_EXPIRES_AT,
    },
  };
  const intentHash = sha256(intent);
  const issued = issuer({
    intent,
    intentHash,
    executionCard: { expiresAt: INTENT_EXPIRES_AT },
  });
  const proof = {
    version: "conviction-resting-order-proof-v1",
    status: "ARMED",
    verificationSource: "authenticated-polymarket-clob",
    onChain: false,
    intentHash,
    sourceIntentHash: SOURCE_INTENT_HASH,
    sourcePositionProofHash: SOURCE_POSITION_HASH,
    orderId: ORDER_ID,
    wallet: WALLET,
    marketConditionId: CONDITION_ID,
    outcome: "YES",
    outcomeTokenId: TOKEN_ID,
    bounds: {
      exactSharesRaw: "10000000",
      targetPrice: "0.4",
      minimumGrossProceedsRaw: "4000000",
      maximumFeeRaw: "0",
      minimumNetProceedsRaw: "4000000",
      venueExpiresAt: VENUE_EXPIRES_AT,
      venueExpiresAtUnix: VENUE_EXPIRES_UNIX,
      postOnlyRequested: true,
      partialFillAllowed: true,
    },
    observed: {
      status: "LIVE",
      side: "SELL",
      orderType: "GTD",
      originalSharesRaw: "10000000",
      matchedSharesRaw: "0",
      price: "0.4",
      expiration: VENUE_EXPIRES_UNIX,
      createdAt: String(Date.parse("2026-07-21T02:00:12.000Z") / 1_000),
      fetchedAt: ARMED_FETCHED_AT,
    },
    checks: {
      canonicalTakeProfitIntentHash: true,
      trustedIssuerSignature: true,
      verifiedSourcePositionBound: true,
      selectedOutcomeToken: true,
      exactCredentialOwner: true,
      exactDepositWallet: true,
      exactOrderId: true,
      exactGtdSell: true,
      exactSharesOffered: true,
      zeroInitiallyMatched: true,
      targetPriceBound: true,
      venueExpiryBound: true,
      orderCreatedAfterConfirmation: true,
      orderCreatedInsideSignedPlacementWindow: true,
    },
  };
  const passport = {
    version: "conviction-take-profit-passport-v1",
    status: "ARMED",
    issuance: issued.issuance,
    intent,
    restingOrderProof: proof,
  };
  return {
    version: "conviction-take-profit-journey-v1",
    action: "TAKE_PROFIT",
    stage: "armed",
    status: "ARMED",
    signerAddress: SIGNER,
    depositWallet: WALLET,
    orderId: ORDER_ID,
    intentHash,
    takeProfitPassport: passport,
    takeProfitPassportHash: sha256(passport),
    restingOrderProofHash: sha256(proof),
    locks: {
      mutableRuntimeMetadata: true,
      reservationPath: "/state/not-part-of-identity.lock",
    },
  };
}

function snapshot(overrides = {}) {
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
      market: CONDITION_ID,
      assetId: TOKEN_ID,
      side: "SELL",
      originalSize: "10",
      sizeMatched: "0",
      price: "0.4",
      orderType: "GTD",
      expiration: VENUE_EXPIRES_UNIX,
      outcome: "Yes",
      createdAt: String(Date.parse("2026-07-21T02:00:12.000Z") / 1_000),
      associatedTrades: [],
      ...orderOverrides,
    },
  };
}

function options(now = NOW) {
  return { now, trustedIssuers };
}

test("validates the signed ARMED passport/journal binding while ignoring mutable lock metadata", () => {
  const journal = fixtureJournal();
  const first = validateArmedTakeProfitJournal(journal, options());
  journal.locks = { completelyDifferent: "runtime-only" };
  const second = validateArmedTakeProfitJournal(journal, options());
  assert.equal(first.orderId, ORDER_ID);
  assert.equal(first.passportHash, second.passportHash);
  assert.equal(first.issuanceVerification.ok, true);
});

test("fails closed on journal, passport, proof, token, wallet, and issuer substitutions", () => {
  const cases = [
    [(value) => { value.orderId = `0x${"c".repeat(64)}`; }, "take_profit_journal_mismatch"],
    [(value) => { value.depositWallet = "0x3333333333333333333333333333333333333333"; }, "take_profit_journal_mismatch"],
    [(value) => { value.takeProfitPassport.restingOrderProof.outcomeTokenId = "42"; }, "take_profit_passport_mismatch"],
    [(value) => { value.takeProfitPassport.restingOrderProof.checks.exactOrderId = false; }, "take_profit_passport_mismatch"],
    [(value) => { value.takeProfitPassport.issuance.signature = value.takeProfitPassport.issuance.signature.replace(/^./, "A"); }, "take_profit_passport_mismatch"],
  ];
  for (const [mutate, code] of cases) {
    const journal = structuredClone(fixtureJournal());
    mutate(journal);
    assert.throws(
      () => validateArmedTakeProfitJournal(journal, options()),
      (error) => error?.code === code,
    );
  }

  const invalidIssuer = structuredClone(fixtureJournal());
  const signature = invalidIssuer.takeProfitPassport.issuance.signature;
  const invalidSignatureBytes = Buffer.from(signature, "base64url");
  invalidSignatureBytes[0] ^= 1;
  invalidIssuer.takeProfitPassport.issuance.signature = invalidSignatureBytes.toString("base64url");
  invalidIssuer.takeProfitPassportHash = sha256(invalidIssuer.takeProfitPassport);
  assert.throws(
    () => validateArmedTakeProfitJournal(invalidIssuer, options()),
    (error) => error?.code === "invalid_issuance_signature",
  );

  const forgedProof = structuredClone(fixtureJournal());
  forgedProof.takeProfitPassport.restingOrderProof.sourcePositionProofHash = `0x${"9".repeat(64)}`;
  forgedProof.restingOrderProofHash = sha256(forgedProof.takeProfitPassport.restingOrderProof);
  forgedProof.takeProfitPassportHash = sha256(forgedProof.takeProfitPassport);
  assert.throws(
    () => validateArmedTakeProfitJournal(forgedProof, options()),
    (error) => error?.code === "take_profit_passport_mismatch",
  );
});

test("builds one exact, credential-bound ARMED status without exposing credentials", () => {
  const status = buildTakeProfitStatus(fixtureJournal(), snapshot(), options());
  assert.equal(status.status, "ARMED");
  assert.equal(status.order.id, ORDER_ID);
  assert.equal(status.order.matchedSharesRaw, "0");
  assert.equal(status.order.remainingSharesRaw, "10000000");
  assert.equal(status.cancelEligible, true);
  assert.equal(status.settlementProofRequired, false);
  assert.equal(JSON.stringify(status).includes("api_key"), false);
  assert.equal(JSON.stringify(status).includes("passphrase"), false);
});

test("classifies quantity before venue status so partial and full fills are never hidden", () => {
  const partial = buildTakeProfitStatus(fixtureJournal(), snapshot({
    order: { sizeMatched: "4", associatedTrades: ["trade-partial"] },
  }), options());
  assert.equal(partial.status, "PARTIAL_PENDING_CHAIN_PROOF");
  assert.equal(partial.order.matchedSharesRaw, "4000000");
  assert.equal(partial.settlementProofRequired, true);
  assert.equal(partial.cancelEligible, true);

  const partialCanceled = buildTakeProfitStatus(fixtureJournal(), snapshot({
    order: { status: "CANCELED", sizeMatched: "4", associatedTrades: ["trade-partial"] },
  }), options());
  assert.equal(partialCanceled.status, "PARTIAL_CANCELED_PENDING_CHAIN_PROOF");
  assert.equal(partialCanceled.cancellationObserved, true);

  const partialExpired = buildTakeProfitStatus(fixtureJournal(), snapshot({
    order: { status: "EXPIRED", sizeMatched: "4", associatedTrades: ["trade-partial"] },
  }), options());
  assert.equal(partialExpired.status, "PARTIAL_EXPIRED_PENDING_CHAIN_PROOF");

  const filled = buildTakeProfitStatus(fixtureJournal(), snapshot({
    order: { status: "CANCELED", sizeMatched: "10", associatedTrades: ["trade-full"] },
  }), options());
  assert.equal(filled.status, "FILLED_PENDING_CHAIN_PROOF");
  assert.equal(filled.order.remainingSharesRaw, "0");
  assert.equal(filled.cancellationObserved, true);
});

test("rejects stale, unauthenticated, substituted, or regressed exact-order snapshots", () => {
  const cases = [
    [snapshot({ credentialOwnerVerified: false }), "invalid_order_snapshot", NOW],
    [snapshot({ signerAddress: "0x3333333333333333333333333333333333333333" }), "order_wallet_mismatch", NOW],
    [snapshot({ order: { id: `0x${"c".repeat(64)}` } }), "order_identity_mismatch", NOW],
    [snapshot({ order: { assetId: "42" } }), "order_token_mismatch", NOW],
    [snapshot({ order: { sizeMatched: "11" } }), "invalid_order_response", NOW],
    [snapshot({ fetchedAt: "2026-07-21T02:00:12.000Z" }), "order_snapshot_regression", NOW],
    [snapshot(), "stale_order_snapshot", NOW + 20_000],
  ];
  for (const [value, code, now] of cases) {
    assert.throws(
      () => buildTakeProfitStatus(fixtureJournal(), value, options(now)),
      (error) => error?.code === code,
    );
  }
});

test("404 and indeterminate lookup failures remain UNKNOWN, never canceled", () => {
  for (const errorCode of ["order_not_found", "order_unavailable", "unknown"]) {
    const status = buildTakeProfitLookupFailureStatus(fixtureJournal(), {
      errorCode,
      observedAt: "2026-07-21T02:00:14.000Z",
    }, options());
    assert.equal(status.status, "UNKNOWN");
    assert.equal(status.orderTerminal, false);
    assert.equal(status.cancellationObserved, false);
    assert.equal(status.cancelEligible, false);
  }
});

test("builds only the official exact-order cancel argv after distinct exact typed consent", () => {
  const request = buildTakeProfitCancelRequest({
    journal: fixtureJournal(),
    snapshot: snapshot(),
    typedConfirmation: TAKE_PROFIT_CANCEL_CONFIRMATION,
    confirmedAt: "2026-07-21T02:00:14.000Z",
  }, options());
  assert.deepEqual(request.argv, ["cancel", "--order-id", ORDER_ID]);
  assert.equal(request.authorizationScope, "single-pinned-order");
  assert.equal(request.requiresPostCancelExactOrderRecheck, true);
  assert.equal(request.argv.includes("--market"), false);
  assert.equal(request.argv.includes("--all"), false);
});

test("cancel request rejects reused/near-match consent and every non-cancelable order state", () => {
  for (const typedConfirmation of ["confirm live mode", "Confirm cancel take profit", "confirm cancel take profit "]) {
    assert.throws(
      () => buildTakeProfitCancelRequest({
        journal: fixtureJournal(),
        snapshot: snapshot(),
        typedConfirmation,
        confirmedAt: "2026-07-21T02:00:14.000Z",
      }, options()),
      (error) => error?.code === "cancel_confirmation_required",
    );
  }
  for (const order of [
    { status: "CANCELED" },
    { status: "EXPIRED" },
    { status: "MYSTERY" },
    { status: "MATCHED", sizeMatched: "10", associatedTrades: ["trade-full"] },
  ]) {
    assert.throws(
      () => buildTakeProfitCancelRequest({
        journal: fixtureJournal(),
        snapshot: snapshot({ order }),
        typedConfirmation: TAKE_PROFIT_CANCEL_CONFIRMATION,
        confirmedAt: "2026-07-21T02:00:14.000Z",
      }, options()),
      (error) => error?.code === "take_profit_not_cancelable",
    );
  }
});

test("post-cancel exact recheck reports partial/full fill races instead of declaring success", () => {
  const cancelResult = { ok: true, data: { canceled: [ORDER_ID], not_canceled: {} } };
  const partial = buildTakeProfitCancelOutcome({
    journal: fixtureJournal(),
    beforeSnapshot: snapshot(),
    cancelResult,
    afterSnapshot: snapshot({
      fetchedAt: "2026-07-21T02:00:15.000Z",
      order: { status: "CANCELED", sizeMatched: "3", associatedTrades: ["trade-race"] },
    }),
  }, options(NOW + 1_000));
  assert.equal(partial.status, "PARTIAL_CANCELED_PENDING_CHAIN_PROOF");
  assert.equal(partial.cancelConfirmedFromFreshOrder, true);
  assert.equal(partial.fillCancelRaceOccurred, true);
  assert.equal(partial.matchedSharesAfterRaw, "3000000");

  const filled = buildTakeProfitCancelOutcome({
    journal: fixtureJournal(),
    beforeSnapshot: snapshot(),
    cancelResult,
    afterSnapshot: snapshot({
      fetchedAt: "2026-07-21T02:00:15.000Z",
      order: { status: "MATCHED", sizeMatched: "10", associatedTrades: ["trade-race-full"] },
    }),
  }, options(NOW + 1_000));
  assert.equal(filled.status, "FILLED_PENDING_CHAIN_PROOF");
  assert.equal(filled.cancelConfirmedFromFreshOrder, false);
  assert.equal(filled.fillCancelRaceOccurred, true);
});

test("cancel acknowledgement alone never turns 404, UNKNOWN, or still-LIVE into canceled", () => {
  const cancelResult = { ok: true, data: { canceled: [ORDER_ID], not_canceled: {} } };
  const missing = buildTakeProfitCancelOutcome({
    journal: fixtureJournal(),
    beforeSnapshot: snapshot(),
    cancelResult,
    afterLookupErrorCode: "order_not_found",
    observedAt: "2026-07-21T02:00:15.000Z",
  }, options(NOW + 1_000));
  assert.equal(missing.status, "UNKNOWN");
  assert.equal(missing.cancelAcknowledgedByPlugin, true);
  assert.equal(missing.cancelConfirmedFromFreshOrder, false);

  const missingAfterKnownPartial = buildTakeProfitCancelOutcome({
    journal: fixtureJournal(),
    beforeSnapshot: snapshot({ order: { sizeMatched: "2", associatedTrades: ["trade-before"] } }),
    cancelResult,
    afterLookupErrorCode: "order_not_found",
    observedAt: "2026-07-21T02:00:15.000Z",
  }, options(NOW + 1_000));
  assert.equal(missingAfterKnownPartial.status, "UNKNOWN");
  assert.equal(missingAfterKnownPartial.settlementProofRequired, true);
  assert.equal(missingAfterKnownPartial.matchedSharesBeforeRaw, "2000000");

  const stillLive = buildTakeProfitCancelOutcome({
    journal: fixtureJournal(),
    beforeSnapshot: snapshot(),
    cancelResult,
    afterSnapshot: snapshot({ fetchedAt: "2026-07-21T02:00:15.000Z" }),
  }, options(NOW + 1_000));
  assert.equal(stillLive.status, "ARMED");
  assert.equal(stillLive.cancelAcknowledgedByPlugin, true);
  assert.equal(stillLive.cancelConfirmedFromFreshOrder, false);

  const unknown = buildTakeProfitCancelOutcome({
    journal: fixtureJournal(),
    beforeSnapshot: snapshot(),
    cancelResult,
    afterSnapshot: snapshot({
      fetchedAt: "2026-07-21T02:00:15.000Z",
      order: { status: "MYSTERY" },
    }),
  }, options(NOW + 1_000));
  assert.equal(unknown.status, "UNKNOWN");
  assert.equal(unknown.cancelConfirmedFromFreshOrder, false);
});

test("cancel outcome rejects cross-order responses and matched-quantity regression", () => {
  assert.throws(
    () => buildTakeProfitCancelOutcome({
      journal: fixtureJournal(),
      beforeSnapshot: snapshot(),
      cancelResult: { ok: true, data: { canceled: [`0x${"c".repeat(64)}`], not_canceled: {} } },
      afterSnapshot: snapshot({ fetchedAt: "2026-07-21T02:00:15.000Z", order: { status: "CANCELED" } }),
    }, options(NOW + 1_000)),
    (error) => error?.code === "unsafe_cancel_response",
  );

  assert.throws(
    () => buildTakeProfitCancelOutcome({
      journal: fixtureJournal(),
      beforeSnapshot: snapshot({ order: { sizeMatched: "4", associatedTrades: ["trade-before"] } }),
      cancelResult: { ok: true, data: { canceled: [ORDER_ID], not_canceled: {} } },
      afterSnapshot: snapshot({ fetchedAt: "2026-07-21T02:00:15.000Z", order: { status: "CANCELED", sizeMatched: "3", associatedTrades: ["trade-before"] } }),
    }, options(NOW + 1_000)),
    (error) => error?.code === "order_fill_regression",
  );
});
