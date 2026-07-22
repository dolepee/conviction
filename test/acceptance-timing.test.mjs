import assert from "node:assert/strict";
import test from "node:test";

import {
  evaluateTakeProfitAcceptanceTiming,
  strictlyPostdatesConfirmationSecond,
} from "../src/acceptance-timing.mjs";

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
