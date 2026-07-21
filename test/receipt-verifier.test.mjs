import assert from "node:assert/strict";
import test from "node:test";

import { sha256 } from "../src/canonical.mjs";
import { compileIntent } from "../src/intent-compiler.mjs";
import { ConvictionError } from "../src/errors.mjs";
import { verifyPositionProof, verifyReceipt } from "../src/receipt-verifier.mjs";
import { LIVE_EXPECTED_FILL, LIVE_MARKET_SNAPSHOT, LIVE_RECEIPT } from "./fixtures.mjs";

const NOW = Date.parse("2026-07-21T02:00:10.000Z");
const REQUEST = Object.freeze({
  market: LIVE_MARKET_SNAPSHOT.slug,
  outcome: "yes",
  spend: "1.35",
  maxPrice: "0.27",
  wallet: LIVE_EXPECTED_FILL.wallet,
  rationale: "I expect this event to resolve YES and will not pay above 27 cents.",
});
const YES_TOKEN_HEX = BigInt(LIVE_MARKET_SNAPSHOT.yesTokenId).toString(16).padStart(64, "0");
const NO_TOKEN_HEX = BigInt(LIVE_MARKET_SNAPSHOT.noTokenId).toString(16).padStart(64, "0");
const FEE_ORDER_ID = `0x${"f".repeat(64)}`;

function uintWord(value) {
  return BigInt(value).toString(16).padStart(64, "0");
}

function noReceipt() {
  return JSON.parse(JSON.stringify(LIVE_RECEIPT).replaceAll(YES_TOKEN_HEX, NO_TOKEN_HEX));
}

function compiled(outcome = "yes") {
  const market = outcome === "yes"
    ? LIVE_MARKET_SNAPSHOT
    : {
        ...LIVE_MARKET_SNAPSHOT,
        selectedOutcome: "NO",
        outcomeTokenId: LIVE_MARKET_SNAPSHOT.noTokenId,
        counterOutcomeTokenId: LIVE_MARKET_SNAPSHOT.yesTokenId,
      };
  return compileIntent(
    {
      ...REQUEST,
      outcome,
      rationale: `I expect this event to resolve ${outcome.toUpperCase()} and accept the stated bound.`,
    },
    market,
    { now: NOW },
  );
}

function legacyCompiled() {
  const prepared = compiled("yes");
  const intent = structuredClone(prepared.intent);
  intent.version = "conviction-intent-v2";
  intent.order = {
    side: intent.order.side,
    outcome: intent.order.outcome,
    outcomeTokenId: intent.order.outcomeTokenId,
    orderType: intent.order.orderType,
    maximumSpend: intent.order.maximumOrderPrincipal,
    maximumSpendRaw: intent.order.maximumOrderPrincipalRaw,
    maxPrice: intent.order.maxPrice,
    fullFillSharesAtCap: intent.order.fullFillSharesAtCap,
    fullFillSharesAtCapRaw: intent.order.fullFillSharesAtCapRaw,
    feeBps: 0,
  };
  intent.exposure = {
    maximumLoss: "1.35",
    fullFillPayoutAtCap: "5",
    grossProfitAtCap: "3.65",
    grossBreakEvenPrice: "0.27",
    priceCapCushion: "0",
    boundedLiquidityCoverageBps: "158498360",
    feesIncluded: false,
    assumesFullFillAtCap: true,
    secondsToResolution: 14076000,
  };
  return { intent, intentHash: sha256(intent) };
}

function feeCompiled() {
  const market = {
    ...LIVE_MARKET_SNAPSHOT,
    slug: "will-gpt-6-be-released-by-december-31-2026-834-362-194-984-527",
    question: "Will GPT-6 be released by December 31, 2026?",
    selectedOutcome: "NO",
    outcomeTokenId: LIVE_MARKET_SNAPSHOT.noTokenId,
    counterOutcomeTokenId: LIVE_MARKET_SNAPSHOT.yesTokenId,
    feeBps: 1000,
    bids: [{ price: "0.12", size: "100" }],
    asks: [{ price: "0.14", size: "100" }],
  };
  return compileIntent(
    {
      ...REQUEST,
      market: market.slug,
      outcome: "no",
      spend: "1.232",
      maxPrice: "0.14",
      rationale: "I select NO and cap my total fee-inclusive debit at 1.232 pUSD.",
    },
    market,
    { now: NOW },
  );
}

function feeReceipt({ feeRaw = 112000n, totalDebitRaw = 1232000n, builderRaw = 0n } = {}) {
  const receipt = structuredClone(LIVE_RECEIPT);
  receipt.transactionHash = `0x${"e".repeat(64)}`;
  receipt.logs[0].data = `0x${NO_TOKEN_HEX}${uintWord(8000000)}`;
  receipt.logs[1].data = `0x${uintWord(totalDebitRaw)}`;
  receipt.logs[2].topics[1] = FEE_ORDER_ID;
  receipt.logs[2].data = `0x${[
    0n,
    BigInt(LIVE_MARKET_SNAPSHOT.noTokenId),
    1120000n,
    8000000n,
    feeRaw,
    builderRaw,
    0n,
  ].map(uintWord).join("")}`;
  return receipt;
}

function errorCode(fn, code) {
  assert.throws(fn, (error) => error instanceof ConvictionError && error.code === code);
}

test("verifies the canonical live settlement receipt", () => {
  const result = verifyReceipt({
    chainId: 137,
    receipt: LIVE_RECEIPT,
    expected: LIVE_EXPECTED_FILL,
  });
  assert.equal(result.ok, true);
  assert.equal(result.proof.spendRaw, "1350000");
  assert.equal(result.proof.sharesRaw, "5000000");
  assert.deepEqual(result.proof.checks, {
    transactionSucceeded: true,
    standardExchangeV2: true,
    exactCollateralTransfer: true,
    exactOutcomeTransfer: true,
    exactOrderFill: true,
  });
});

test("rejects wrong chain, failed status, and wrong exchange", () => {
  errorCode(
    () => verifyReceipt({ chainId: 1, receipt: LIVE_RECEIPT, expected: LIVE_EXPECTED_FILL }),
    "wrong_chain",
  );
  errorCode(
    () =>
      verifyReceipt({
        chainId: 137,
        receipt: { ...LIVE_RECEIPT, status: "0x0" },
        expected: LIVE_EXPECTED_FILL,
      }),
    "failed_transaction",
  );
  errorCode(
    () =>
      verifyReceipt({
        chainId: 137,
        receipt: { ...LIVE_RECEIPT, to: "0x0000000000000000000000000000000000000001" },
        expected: LIVE_EXPECTED_FILL,
      }),
    "wrong_exchange",
  );
});

test("rejects wallet, order, token, amount, and share substitution", () => {
  const cases = [
    [{ wallet: "0x0000000000000000000000000000000000000001" }, "missing_collateral_transfer"],
    [
      { orderId: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" },
      "missing_order_fill",
    ],
    [{ outcomeTokenId: "1" }, "missing_outcome_transfer"],
    [{ spendRaw: "1350001" }, "missing_collateral_transfer"],
    [{ sharesRaw: "5000001" }, "missing_outcome_transfer"],
  ];
  for (const [mutation, code] of cases) {
    errorCode(
      () =>
        verifyReceipt({
          chainId: 137,
          receipt: LIVE_RECEIPT,
          expected: { ...LIVE_EXPECTED_FILL, ...mutation },
        }),
      code,
    );
  }
});

test("verifies a synthetic NO receipt only against the selected NO token", () => {
  const result = verifyReceipt({
    chainId: 137,
    receipt: noReceipt(),
    expected: {
      ...LIVE_EXPECTED_FILL,
      outcome: "NO",
      outcomeTokenId: LIVE_MARKET_SNAPSHOT.noTokenId,
    },
  });
  assert.equal(result.proof.outcome, "NO");
  assert.equal(result.proof.outcomeTokenId, LIVE_MARKET_SNAPSHOT.noTokenId);
});

test("binds a canonical intent to the actual receipt-derived fill", () => {
  const prepared = compiled("yes");
  const result = verifyPositionProof({
    chainId: 137,
    receipt: LIVE_RECEIPT,
    intent: prepared.intent,
    intentHash: prepared.intentHash,
    orderId: LIVE_EXPECTED_FILL.orderId,
  });
  assert.equal(result.positionProof.outcome, "YES");
  assert.equal(result.positionProof.fill.actualSpendRaw, "1350000");
  assert.equal(result.positionProof.fill.actualSharesRaw, "5000000");
  assert.equal(result.positionProof.checks.averagePriceWithinMaximum, true);
  assert.equal(result.positionProof.checks.totalDebitWithinMaximum, true);
});

test("preserves verification for the historical fee-free v2 intent", () => {
  const prepared = legacyCompiled();
  const result = verifyPositionProof({
    chainId: 137,
    receipt: LIVE_RECEIPT,
    intent: prepared.intent,
    intentHash: prepared.intentHash,
    orderId: LIVE_EXPECTED_FILL.orderId,
  });
  assert.equal(result.receiptProof.version, "conviction-receipt-v2");
  assert.equal(result.positionProof.version, "conviction-position-proof-v1");
  assert.equal(result.positionProof.fill.actualSpendRaw, "1350000");
});

test("verifies fee-bearing principal, fee, total debit, and NO token independently", () => {
  const prepared = feeCompiled();
  const result = verifyPositionProof({
    chainId: 137,
    receipt: feeReceipt(),
    intent: prepared.intent,
    intentHash: prepared.intentHash,
    orderId: FEE_ORDER_ID,
  });
  assert.equal(result.receiptProof.principalRaw, "1120000");
  assert.equal(result.receiptProof.feeRaw, "112000");
  assert.equal(result.receiptProof.totalDebitRaw, "1232000");
  assert.equal(result.positionProof.outcome, "NO");
  assert.equal(result.positionProof.fill.actualOrderPrincipalRaw, "1120000");
  assert.equal(result.positionProof.fill.actualFeeRaw, "112000");
  assert.equal(result.positionProof.fill.actualTotalDebitRaw, "1232000");
  assert.equal(result.positionProof.fill.allInAveragePriceCeiling, "0.154");
});

test("rejects excess fee, extra wallet debit, and nonzero builder attribution", () => {
  const prepared = feeCompiled();
  const base = {
    chainId: 137,
    intent: prepared.intent,
    intentHash: prepared.intentHash,
    orderId: FEE_ORDER_ID,
  };
  errorCode(
    () => verifyPositionProof({ ...base, receipt: feeReceipt({ feeRaw: 112001n, totalDebitRaw: 1232001n }) }),
    "fee_above_bound",
  );
  errorCode(
    () => verifyPositionProof({ ...base, receipt: feeReceipt({ totalDebitRaw: 1232001n }) }),
    "missing_collateral_transfer",
  );
  errorCode(
    () => verifyPositionProof({ ...base, receipt: feeReceipt({ builderRaw: 1n }) }),
    "missing_order_fill",
  );
});

test("rejects a YES receipt substituted for a canonical NO intent", () => {
  const prepared = compiled("no");
  errorCode(
    () =>
      verifyPositionProof({
        chainId: 137,
        receipt: LIVE_RECEIPT,
        intent: prepared.intent,
        intentHash: prepared.intentHash,
        orderId: LIVE_EXPECTED_FILL.orderId,
      }),
    "missing_order_fill",
  );
});

test("rejects an internally swapped outcome-token mapping even with a recomputed hash", () => {
  const prepared = compiled("yes");
  const swapped = structuredClone(prepared.intent);
  swapped.market.outcome = "NO";
  swapped.order.outcome = "NO";
  errorCode(
    () =>
      verifyPositionProof({
        chainId: 137,
        receipt: LIVE_RECEIPT,
        intent: swapped,
        intentHash: sha256(swapped),
        orderId: LIVE_EXPECTED_FILL.orderId,
      }),
    "intent_token_mapping_mismatch",
  );
});

test("rejects intent and exposure mutation and keeps the combined proof deterministic", () => {
  const prepared = compiled("yes");
  const mutated = structuredClone(prepared.intent);
  mutated.buyer.wallet = "0x0000000000000000000000000000000000000001";
  errorCode(
    () =>
      verifyPositionProof({
        chainId: 137,
        receipt: LIVE_RECEIPT,
        intent: mutated,
        intentHash: prepared.intentHash,
        orderId: LIVE_EXPECTED_FILL.orderId,
      }),
    "intent_hash_mismatch",
  );

  const badExposure = structuredClone(prepared.intent);
  badExposure.exposure.maximumLoss = "0";
  errorCode(
    () =>
      verifyPositionProof({
        chainId: 137,
        receipt: LIVE_RECEIPT,
        intent: badExposure,
        intentHash: sha256(badExposure),
        orderId: LIVE_EXPECTED_FILL.orderId,
      }),
    "intent_exposure_mismatch",
  );

  const input = {
    chainId: 137,
    receipt: LIVE_RECEIPT,
    intent: prepared.intent,
    intentHash: prepared.intentHash,
    orderId: LIVE_EXPECTED_FILL.orderId,
  };
  const first = verifyPositionProof(input);
  const second = verifyPositionProof({ ...input, receipt: structuredClone(LIVE_RECEIPT) });
  assert.equal(first.positionProofHash, second.positionProofHash);
});

test("receipt hash is deterministic", () => {
  const first = verifyReceipt({ chainId: 137, receipt: LIVE_RECEIPT, expected: LIVE_EXPECTED_FILL });
  const second = verifyReceipt({
    chainId: 137,
    receipt: structuredClone(LIVE_RECEIPT),
    expected: { ...LIVE_EXPECTED_FILL },
  });
  assert.equal(first.receiptHash, second.receiptHash);
  assert.equal(first.receiptHash, "0x1746d89ea5c08c5edc214fcca3baf5b3bc6ce7b4ea9d02427dd88035cd4373b3");
});
