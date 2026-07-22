import assert from "node:assert/strict";
import test from "node:test";

import {
  evaluateFilledOrderAcceptanceTiming,
  evaluateTakeProfitAcceptanceTiming,
  strictlyPostdatesConfirmationSecond,
} from "../src/acceptance-timing.mjs";

test("OPEN acceptance excludes pre-payment consent delay and binds both observed intervals", () => {
  const result = evaluateFilledOrderAcceptanceTiming({
    paymentBlockTimestamp: "1893456000",
    settledAt: "2030-01-01T00:01:09.000Z",
    proofObservedAt: "2030-01-01T00:01:10.000Z",
    localPaidAt: Date.parse("2030-01-01T00:00:05.000Z"),
    localProvedAt: Date.parse("2030-01-01T00:01:11.257Z"),
    recordedLocalPaymentToProofMs: 66_257,
  });
  assert.equal(result.ok, true);
  assert.equal(result.chainPaymentToProofMs, 70_000);
  assert.equal(result.localPaymentToProofMs, 66_257);
});

test("OPEN acceptance rejects either interval at 120 seconds and false local duration claims", () => {
  const baseOpen = {
    paymentBlockTimestamp: "1893456000",
    settledAt: "2030-01-01T00:01:00.000Z",
    proofObservedAt: "2030-01-01T00:01:01.000Z",
    localPaidAt: Date.parse("2030-01-01T00:00:00.000Z"),
    localProvedAt: Date.parse("2030-01-01T00:01:00.000Z"),
    recordedLocalPaymentToProofMs: 60_000,
  };
  assert.equal(evaluateFilledOrderAcceptanceTiming({
    ...baseOpen,
    proofObservedAt: "2030-01-01T00:02:00.000Z",
  }).ok, false);
  assert.equal(evaluateFilledOrderAcceptanceTiming({
    ...baseOpen,
    localProvedAt: Date.parse("2030-01-01T00:02:00.000Z"),
    recordedLocalPaymentToProofMs: 120_000,
  }).ok, false);
  assert.equal(evaluateFilledOrderAcceptanceTiming({
    ...baseOpen,
    recordedLocalPaymentToProofMs: 59_999,
  }).ok, false);
});

test("OPEN acceptance rejects composed intervals that hide a greater-than-two-minute payment-to-proof path", () => {
  const result = evaluateFilledOrderAcceptanceTiming({
    paymentBlockTimestamp: "1893456000",
    settledAt: "2030-01-01T00:01:59.000Z",
    proofObservedAt: "2030-01-01T00:03:57.000Z",
    localPaidAt: Date.parse("2030-01-01T00:01:58.000Z"),
    localProvedAt: Date.parse("2030-01-01T00:03:57.000Z"),
    recordedLocalPaymentToProofMs: 119_000,
  });
  assert.equal(result.localTimingBound, true);
  assert.equal(result.chainTimingBound, false);
  assert.equal(result.chainPaymentToProofMs, 237_000);
  assert.equal(result.ok, false);
});

const base = Object.freeze({
  paymentBlockTimestamp: "1893456009",
  orderCreatedAt: "1893456011",
  orderFetchedAt: "2030-01-01T00:00:11.750Z",
  reportConfirmedAt: Date.parse("2030-01-01T00:00:10.250Z"),
  journalConfirmedAt: "2030-01-01T00:00:10.250Z",
  cardCapturedAt: "2030-01-01T00:00:00.000Z",
  cardExpiresAt: "2030-01-01T00:05:00.000Z",
  localPaidAt: Date.parse("2030-01-01T00:00:10.000Z"),
  localProvedAt: Date.parse("2030-01-01T00:00:11.800Z"),
  recordedLocalPaymentToProofMs: 1_800,
});

test("settlement acceptance requires a strictly later whole second", () => {
  const confirmation = Date.parse("2030-01-01T00:00:10.250Z");
  assert.equal(strictlyPostdatesConfirmationSecond("2030-01-01T00:00:10.999Z", confirmation), false);
  assert.equal(strictlyPostdatesConfirmationSecond("2030-01-01T00:00:11.000Z", confirmation), true);
  assert.equal(strictlyPostdatesConfirmationSecond("not-a-time", confirmation), false);
});

test("TAKE_PROFIT acceptance binds consent, card window, X Layer payment, CLOB order, fetch, and local timing", () => {
  const result = evaluateTakeProfitAcceptanceTiming(base);
  assert.equal(result.ok, true);
  assert.equal(result.chainPaymentToArmedMs, 2_750);
  assert.equal(result.localPaymentToProofMs, 1_800);
});

test("TAKE_PROFIT acceptance rejects a same-second order and any report/journal confirmation mismatch", () => {
  const sameSecond = evaluateTakeProfitAcceptanceTiming({ ...base, orderCreatedAt: "1893456010" });
  assert.equal(sameSecond.orderAfterConfirmation, false);
  assert.equal(sameSecond.ok, false);

  const mismatchedConsent = evaluateTakeProfitAcceptanceTiming({
    ...base,
    journalConfirmedAt: "2030-01-01T00:00:10.251Z",
  });
  assert.equal(mismatchedConsent.confirmationBound, false);
  assert.equal(mismatchedConsent.ok, false);
});

test("TAKE_PROFIT acceptance rejects orders outside the signed card window", () => {
  for (const orderCreatedAt of ["1893455999", "1893456301"]) {
    const result = evaluateTakeProfitAcceptanceTiming({ ...base, orderCreatedAt });
    assert.equal(result.insideCardWindow, false);
    assert.equal(result.ok, false);
  }
});

test("TAKE_PROFIT acceptance rejects negative or incomplete authenticated order chronology", () => {
  const beforePayment = evaluateTakeProfitAcceptanceTiming({
    ...base,
    paymentBlockTimestamp: "1893456012",
  });
  assert.equal(beforePayment.orderAfterPayment, false);
  assert.equal(beforePayment.ok, false);

  const fetchedBeforeCreation = evaluateTakeProfitAcceptanceTiming({
    ...base,
    orderFetchedAt: "2030-01-01T00:00:10.999Z",
  });
  assert.equal(fetchedBeforeCreation.fetchAfterOrder, false);
  assert.equal(fetchedBeforeCreation.ok, false);
});

test("TAKE_PROFIT acceptance enforces the independent and local sub-120-second bounds", () => {
  const exactlyTwoMinutes = evaluateTakeProfitAcceptanceTiming({
    ...base,
    orderCreatedAt: "1893456128",
    orderFetchedAt: "2030-01-01T00:02:09.000Z",
    cardExpiresAt: "2030-01-01T00:05:00.000Z",
  });
  assert.equal(exactlyTwoMinutes.chainPaymentToArmedMs, 120_000);
  assert.equal(exactlyTwoMinutes.chainTimingBound, false);
  assert.equal(exactlyTwoMinutes.ok, false);

  const falseLocalClaim = evaluateTakeProfitAcceptanceTiming({
    ...base,
    recordedLocalPaymentToProofMs: 1_799,
  });
  assert.equal(falseLocalClaim.localTimingBound, false);
  assert.equal(falseLocalClaim.ok, false);
});
