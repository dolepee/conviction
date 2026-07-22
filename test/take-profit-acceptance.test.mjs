import assert from "node:assert/strict";
import test from "node:test";

import { sha256 } from "../src/canonical.mjs";
import { evaluateTakeProfitConsentBinding } from "../src/take-profit-acceptance.mjs";

const TX = `0x${"a".repeat(64)}`;
const INTENT = `0x${"b".repeat(64)}`;
const REPLAY = `0x${"c".repeat(64)}`;
const PAYER = "0x1111111111111111111111111111111111111111";
const PAYEE = "0x2222222222222222222222222222222222222222";
const ASSET = "0x3333333333333333333333333333333333333333";
const CONFIRMED_AT = Date.parse("2030-01-01T00:00:10.250Z");

function fixture() {
  const reportCard = { ok: true, executionCard: { fixture: true } };
  const validatedCard = {
    intentHash: INTENT,
    executionCard: { argv: ["sell", "--token-id", "123", "--shares", "5"] },
    expiresAt: "2030-01-01T00:05:00.000Z",
    bounds: { venueExpiresAt: "2030-01-01T01:00:00.000Z" },
    issuanceVerification: { issuedAt: "2030-01-01T00:00:01.000Z" },
  };
  const paymentProof = {
    transactionHash: TX,
    blockTimestamp: "1893456009",
    payer: PAYER,
    payee: PAYEE,
    asset: ASSET,
    amountAtomic: "100000",
  };
  const journal = {
    version: "conviction-take-profit-journey-v1",
    action: "TAKE_PROFIT",
    paidCard: structuredClone(reportCard),
    intentHash: INTENT,
    replayKey: REPLAY,
    paymentTx: TX,
    paymentProof: structuredClone(paymentProof),
    tradeConsent: {
      version: "conviction-take-profit-consent-v1",
      intentHash: INTENT,
      executionArgvHash: sha256(validatedCard.executionCard.argv),
      paymentTx: TX,
      replayKey: REPLAY,
      confirmedAt: new Date(CONFIRMED_AT).toISOString(),
      placementExpiresAt: validatedCard.expiresAt,
      venueExpiresAt: validatedCard.bounds.venueExpiresAt,
    },
  };
  return {
    journal,
    reportCard,
    validatedCard,
    independentPaymentProof: paymentProof,
    reportPaymentTx: TX,
    reportConfirmationCount: 1,
    reportConfirmedAt: CONFIRMED_AT,
    confirmedEventCount: 1,
    confirmedEventAt: CONFIRMED_AT,
    expectedPayer: PAYER,
    expectedPayee: PAYEE,
    expectedAsset: ASSET,
    expectedAmountAtomic: "100000",
  };
}

test("Gate C consent binding ties one exact event to the journal, signed card, and X Layer payment", () => {
  const result = evaluateTakeProfitConsentBinding(fixture());
  assert.deepEqual(result, {
    ok: true,
    exactConfirmation: true,
    confirmationInsidePaidCard: true,
    cardBound: true,
    paymentBound: true,
  });
});

test("Gate C consent binding rejects a one-millisecond journal or event substitution", () => {
  const journalMismatch = fixture();
  journalMismatch.journal.tradeConsent.confirmedAt = "2030-01-01T00:00:10.251Z";
  assert.equal(evaluateTakeProfitConsentBinding(journalMismatch).exactConfirmation, false);

  const eventMismatch = fixture();
  eventMismatch.confirmedEventAt += 1;
  assert.equal(evaluateTakeProfitConsentBinding(eventMismatch).exactConfirmation, false);
});

test("Gate C consent binding rejects card, execution-vector, and payment substitution", () => {
  const cardMismatch = fixture();
  cardMismatch.journal.paidCard.executionCard.fixture = false;
  assert.equal(evaluateTakeProfitConsentBinding(cardMismatch).cardBound, false);

  const vectorMismatch = fixture();
  vectorMismatch.journal.tradeConsent.executionArgvHash = sha256(["sell", "--token-id", "999"]);
  assert.equal(evaluateTakeProfitConsentBinding(vectorMismatch).cardBound, false);

  const paymentMismatch = fixture();
  paymentMismatch.journal.paymentProof.transactionHash = `0x${"d".repeat(64)}`;
  assert.equal(evaluateTakeProfitConsentBinding(paymentMismatch).paymentBound, false);
});

test("Gate C consent binding rejects confirmation before payment or outside the signed card", () => {
  const afterConsentPayment = fixture();
  afterConsentPayment.independentPaymentProof.blockTimestamp = "1893456011";
  afterConsentPayment.journal.paymentProof.blockTimestamp = "1893456011";
  assert.equal(evaluateTakeProfitConsentBinding(afterConsentPayment).confirmationInsidePaidCard, false);

  const expired = fixture();
  expired.validatedCard.expiresAt = new Date(CONFIRMED_AT).toISOString();
  expired.journal.tradeConsent.placementExpiresAt = expired.validatedCard.expiresAt;
  assert.equal(evaluateTakeProfitConsentBinding(expired).confirmationInsidePaidCard, false);
});
