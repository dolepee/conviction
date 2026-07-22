import assert from "node:assert/strict";
import test from "node:test";

import {
  evaluateOpenConsentAcceptance,
  evaluateOpenDisplayBinding,
  OPEN_ACCEPTANCE_EVENT_SEQUENCE,
} from "../src/open-acceptance.mjs";
import {
  SERVICE_ASSET,
  SERVICE_NETWORK,
  SERVICE_PAYEE,
  SERVICE_PRICE_ATOMIC,
  SERVICE_RESOURCE,
} from "../src/service-payment.mjs";

const CONDITION = `0x${"11".repeat(32)}`;
const INTENT = `0x${"22".repeat(32)}`;
const PAYMENT = `0x${"33".repeat(32)}`;
const PAYER = "0x1111111111111111111111111111111111111111";
const WALLET = "0x2222222222222222222222222222222222222222";

function fixture() {
  const required = {
    market: "fixture-market",
    side: "YES",
    budget: "1.35",
    maxPrice: "0.27",
    paymentPayer: PAYER,
    buyerWallet: WALLET,
  };
  const validatedCard = {
    wallet: WALLET,
    tokenId: "123456789",
    intentHash: INTENT,
    expiresAt: "2026-07-22T02:05:00.000Z",
    intent: { market: { question: "Fixture market?", conditionId: CONDITION } },
    issuance: { keyId: "conviction-prod", issuedAt: "2026-07-22T02:00:00.000Z" },
    bounds: {
      requestedBudgetRaw: "1350000",
      maximumOrderPrincipalRaw: "1250000",
      maximumFeeRaw: "100000",
      maximumTotalDebitRaw: "1350000",
      fullFillSharesRaw: "5000000",
      maxPrice: "0.27",
    },
  };
  const displayed = {
    action: "OPEN",
    market: required.market,
    marketQuestion: validatedCard.intent.market.question,
    conditionId: CONDITION,
    side: required.side,
    outcomeTokenId: validatedCard.tokenId,
    requestedBudgetRaw: validatedCard.bounds.requestedBudgetRaw,
    maxPrice: validatedCard.bounds.maxPrice,
    maximumOrderPrincipalRaw: validatedCard.bounds.maximumOrderPrincipalRaw,
    maximumFeeRaw: validatedCard.bounds.maximumFeeRaw,
    maximumTotalDebitRaw: validatedCard.bounds.maximumTotalDebitRaw,
    fullFillSharesRaw: validatedCard.bounds.fullFillSharesRaw,
    expiresAt: validatedCard.expiresAt,
    wallet: validatedCard.wallet,
    intentHash: validatedCard.intentHash,
    issuerKeyId: validatedCard.issuance.keyId,
    issuedAt: validatedCard.issuance.issuedAt,
    completedPayment: {
      transactionHash: PAYMENT,
      amountAtomic: SERVICE_PRICE_ATOMIC,
      resource: SERVICE_RESOURCE,
      network: SERVICE_NETWORK,
      asset: SERVICE_ASSET,
      payer: PAYER,
      payee: SERVICE_PAYEE,
    },
  };
  return {
    displayed,
    validatedCard,
    required,
    reportPaymentProof: { transactionHash: PAYMENT },
  };
}

test("Gate A binds the displayed OPEN card to request, issuer, payment, and exact signed bounds", () => {
  assert.equal(evaluateOpenDisplayBinding(fixture()), true);
});

function acceptanceReport() {
  const times = {
    payment_verified: 1_000,
    trade_confirmed: 2_000,
    pre_execution_verified: 2_100,
    execution_started: 2_200,
    order_submitted: 3_000,
    position_proof_verified: 4_000,
  };
  const events = OPEN_ACCEPTANCE_EVENT_SEQUENCE.map((type, index) => ({
    sequence: index + 1,
    type,
    at: times[type] ?? 600 + index * 100,
  }));
  return {
    mode: "open",
    ordersPlaced: 1,
    confirmation: { count: 1, confirmedAt: 2_000 },
    events,
  };
}

test("Gate A requires one displayed, confirmed, and submitted OPEN in strict chronology", () => {
  assert.equal(evaluateOpenConsentAcceptance({
    cardBindingOk: true,
    displayOk: true,
    report: acceptanceReport(),
  }), true);
});

for (const [name, mutate] of [
  ["missing displayed bounds", (report) => ({ displayOk: false, report })],
  ["a second order", (report) => ({ displayOk: true, report: { ...report, ordersPlaced: 2 } })],
  ["a second confirmation", (report) => ({ displayOk: true, report: { ...report, confirmation: { ...report.confirmation, count: 2 } } })],
  ["a confirmation-time rewrite", (report) => ({ displayOk: true, report: { ...report, confirmation: { ...report.confirmation, confirmedAt: 2_001 } } })],
  ["execution before confirmation", (report) => ({
    displayOk: true,
    report: {
      ...report,
      events: report.events.map((event) => event.type === "order_submitted" ? { ...event, at: 1_999 } : event),
    },
  })],
]) {
  test(`Gate A rejects ${name}`, () => {
    const { displayOk, report } = mutate(acceptanceReport());
    assert.equal(evaluateOpenConsentAcceptance({ cardBindingOk: true, displayOk, report }), false);
  });
}

for (const [name, mutate] of [
  ["missing display", (value) => ({ ...value, displayed: null })],
  ["action", (value) => ({ ...value, displayed: { ...value.displayed, action: "CLOSE" } })],
  ["market", (value) => ({ ...value, displayed: { ...value.displayed, market: "another-market" } })],
  ["token", (value) => ({ ...value, displayed: { ...value.displayed, outcomeTokenId: "987654321" } })],
  ["budget", (value) => ({ ...value, displayed: { ...value.displayed, requestedBudgetRaw: "1350001" } })],
  ["price", (value) => ({ ...value, displayed: { ...value.displayed, maxPrice: "0.28" } })],
  ["intent", (value) => ({ ...value, displayed: { ...value.displayed, intentHash: `0x${"44".repeat(32)}` } })],
  ["payment", (value) => ({
    ...value,
    displayed: {
      ...value.displayed,
      completedPayment: { ...value.displayed.completedPayment, amountAtomic: "100000" },
    },
  })],
]) {
  test(`Gate A rejects displayed OPEN ${name} substitution`, () => {
    const value = fixture();
    assert.equal(evaluateOpenDisplayBinding(mutate(value)), false);
  });
}
