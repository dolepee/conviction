import assert from "node:assert/strict";
import test from "node:test";

import { compileIntent } from "../src/intent-compiler.mjs";
import { ConvictionError } from "../src/errors.mjs";
import { LIVE_MARKET_SNAPSHOT } from "./fixtures.mjs";

const NOW = Date.parse("2026-07-21T02:00:10.000Z");
const REQUEST = Object.freeze({
  market: LIVE_MARKET_SNAPSHOT.slug,
  outcome: "yes",
  spend: "1.35",
  maxPrice: "0.27",
  wallet: "0x6a355e4971d9ac2ab97d22c3cf361d42faba33fe",
  rationale: "I expect this event to resolve YES and will not pay above 27 cents.",
});
const NO_MARKET_SNAPSHOT = Object.freeze({
  ...LIVE_MARKET_SNAPSHOT,
  selectedOutcome: "NO",
  outcomeTokenId: LIVE_MARKET_SNAPSHOT.noTokenId,
  counterOutcomeTokenId: LIVE_MARKET_SNAPSHOT.yesTokenId,
});
const FEE_MARKET_SNAPSHOT = Object.freeze({
  ...NO_MARKET_SNAPSHOT,
  slug: "will-gpt-6-be-released-by-december-31-2026-834-362-194-984-527",
  question: "Will GPT-6 be released by December 31, 2026?",
  feeBps: 1000,
  tickSize: "0.01",
  minOrderSize: "5",
  bids: [{ price: "0.12", size: "100" }],
  asks: [{ price: "0.14", size: "100" }],
});

function errorCode(fn, code) {
  assert.throws(fn, (error) => error instanceof ConvictionError && error.code === code);
}

test("compiles the canonical live order exactly", () => {
  const result = compileIntent(REQUEST, LIVE_MARKET_SNAPSHOT, { now: NOW });
  assert.equal(result.ok, true);
  assert.equal(result.intent.version, "conviction-intent-v3");
  assert.equal(result.intent.order.maximumSpendRaw, "1350000");
  assert.equal(result.intent.order.maximumOrderPrincipalRaw, "1350000");
  assert.equal(result.intent.order.maximumFeeRaw, "0");
  assert.equal(result.intent.order.maximumTotalDebitRaw, "1350000");
  assert.equal(result.intent.order.fullFillSharesAtCapRaw, "5000000");
  assert.equal(result.intent.order.maxPrice, "0.27");
  assert.equal(result.intent.order.orderType, "FAK");
  assert.equal(result.intent.market.outcomeTokenId, LIVE_MARKET_SNAPSHOT.yesTokenId);
  assert.deepEqual(result.intent.exposure, {
    maximumLoss: "1.35",
    fullFillPayoutAtCap: "5",
    grossProfitAtCap: "3.65",
    grossBreakEvenPrice: "0.27",
    priceCapCushion: "0",
    boundedLiquidityCoverageBps: "158498360",
    feesIncluded: true,
    maximumFee: "0",
    maximumTotalDebit: "1.35",
    unusedBudget: "0",
    assumesFullFillAtCap: true,
    secondsToResolution: 14076000,
  });
  assert.deepEqual(result.executionCard.argv, [
    "buy",
    "--market-id",
    "will-the-us-invade-iran-before-2027",
    "--outcome",
    "yes",
    "--amount",
    "1.35",
    "--price",
    "0.27",
    "--order-type",
    "FAK",
  ]);
  assert.equal(result.executionCard.requiresDedicatedBalanceCap, true);
  assert.equal(result.executionCard.maximumFundingBalance, "1.35");
});

test("compiles NO from the canonical NO token and selected order book", () => {
  const result = compileIntent(
    {
      ...REQUEST,
      outcome: "no",
      rationale: "I expect the event to resolve NO and will not pay above 27 cents.",
    },
    NO_MARKET_SNAPSHOT,
    { now: NOW },
  );
  assert.equal(result.intent.order.outcome, "NO");
  assert.equal(result.intent.order.outcomeTokenId, LIVE_MARKET_SNAPSHOT.noTokenId);
  assert.equal(result.intent.market.outcomes.NO.tokenId, LIVE_MARKET_SNAPSHOT.noTokenId);
  assert.equal(result.executionCard.argv[4], "no");
});

test("produces a deterministic intent hash", () => {
  const first = compileIntent(REQUEST, LIVE_MARKET_SNAPSHOT, { now: NOW });
  const second = compileIntent({ ...REQUEST }, { ...LIVE_MARKET_SNAPSHOT }, { now: NOW });
  assert.equal(first.intentHash, second.intentHash);
});

test("fails closed on a stale snapshot", () => {
  errorCode(
    () => compileIntent(REQUEST, LIVE_MARKET_SNAPSHOT, { now: NOW + 60_000 }),
    "stale_snapshot",
  );
});

test("can keep a fresh paid card usable beyond synchronous settlement", () => {
  const result = compileIntent(REQUEST, LIVE_MARKET_SNAPSHOT, {
    now: NOW,
    maxSnapshotAgeMs: 30_000,
    quoteTtlMs: 120_000,
  });
  assert.equal(
    result.executionCard.expiresAt,
    new Date(Date.parse(LIVE_MARKET_SNAPSHOT.capturedAt) + 120_000).toISOString(),
  );
  errorCode(
    () =>
      compileIntent(REQUEST, LIVE_MARKET_SNAPSHOT, {
        now: NOW,
        maxSnapshotAgeMs: 30_000,
        quoteTtlMs: 29_999,
      }),
    "invalid_quote_ttl",
  );
});

test("fails closed when the price cap is below the best ask", () => {
  errorCode(
    () =>
      compileIntent(
        { ...REQUEST, spend: "1.30", maxPrice: "0.26" },
        LIVE_MARKET_SNAPSHOT,
        { now: NOW },
      ),
    "limit_below_best_ask",
  );
});

test("rounds a total budget down transparently to whole shares", () => {
  const result = compileIntent(
    { ...REQUEST, spend: "1.34" },
    LIVE_MARKET_SNAPSHOT,
    { now: NOW },
  );
  assert.equal(result.intent.order.requestedBudget, "1.34");
  assert.equal(result.intent.order.maximumOrderPrincipal, "1.08");
  assert.equal(result.intent.order.maximumTotalDebit, "1.08");
  assert.equal(result.intent.order.unusedBudget, "0.26");
  assert.equal(result.intent.order.fullFillSharesAtCap, "4");
  assert.equal(result.executionCard.argv[6], "1.08");
});

test("cent-aligns the principal so the live V2 plugin cannot rewrite the reviewed order", () => {
  const market = {
    ...NO_MARKET_SNAPSHOT,
    feeBps: 0,
    tickSize: "0.001",
    bids: [{ price: "0.093", size: "100" }],
    asks: [{ price: "0.132", size: "100" }],
  };
  assert.throws(
    () =>
      compileIntent(
        {
          ...REQUEST,
          outcome: "no",
          spend: "1.12",
          maxPrice: "0.132",
          rationale: "I select NO and cap my total fee-inclusive debit at 1.12 pUSD.",
        },
        market,
        { now: NOW },
      ),
    (error) =>
      error instanceof ConvictionError &&
      error.code === "marketable_order_below_minimum" &&
      error.details.minimumShares === "10" &&
      error.details.minimumTotalBudget === "1.32",
  );

  const result = compileIntent(
    {
      ...REQUEST,
      outcome: "no",
      spend: "1.12",
      maxPrice: "0.14",
      rationale: "I select NO and cap my total fee-inclusive debit at 1.12 pUSD.",
    },
    market,
    { now: NOW },
  );
  assert.equal(result.intent.order.maximumOrderPrincipal, "1.12");
  assert.equal(result.intent.order.fullFillSharesAtCap, "8");
  assert.equal(result.intent.order.principalPrecision, "v2-cent-aligned-whole-shares");
  assert.equal(result.executionCard.argv[6], "1.12");
});

test("includes the conservative V2 fee reserve in total loss", () => {
  const result = compileIntent(
    {
      ...REQUEST,
      market: FEE_MARKET_SNAPSHOT.slug,
      outcome: "no",
      spend: "1.232",
      maxPrice: "0.14",
      rationale: "I select NO and cap my total fee-inclusive debit at 1.232 pUSD.",
    },
    FEE_MARKET_SNAPSHOT,
    { now: NOW },
  );
  assert.equal(result.intent.order.requestedBudget, "1.232");
  assert.equal(result.intent.order.maximumOrderPrincipal, "1.12");
  assert.equal(result.intent.order.maximumFee, "0.112");
  assert.equal(result.intent.order.maximumTotalDebit, "1.232");
  assert.equal(result.intent.order.fullFillSharesAtCap, "8");
  assert.equal(result.intent.exposure.maximumLoss, "1.232");
  assert.equal(result.intent.exposure.grossProfitAtCap, "6.768");
  assert.equal(result.intent.exposure.grossBreakEvenPrice, "0.154");
  assert.equal(result.executionCard.argv[6], "1.12");
});

test("fails before signing when fees leave principal below the marketable BUY floor", () => {
  assert.throws(
    () =>
      compileIntent(
        {
          ...REQUEST,
          market: FEE_MARKET_SNAPSHOT.slug,
          outcome: "no",
          spend: "1.12",
          maxPrice: "0.14",
          rationale: "I select NO and cap my total fee-inclusive debit at 1.12 pUSD.",
        },
        FEE_MARKET_SNAPSHOT,
        { now: NOW },
      ),
    (error) =>
      error instanceof ConvictionError &&
      error.code === "marketable_order_below_minimum" &&
      error.details.minimumTotalBudget === "1.232",
  );
});

test("allows fewer than five shares when a marketable order clears the dollar floor", () => {
  const market = {
    ...NO_MARKET_SNAPSHOT,
    feeBps: 0,
    tickSize: "0.01",
    minOrderSize: "5",
    bids: [{ price: "0.51", size: "100" }],
    asks: [{ price: "0.53", size: "100" }],
  };
  const result = compileIntent(
    {
      ...REQUEST,
      outcome: "no",
      spend: "1.06",
      maxPrice: "0.53",
      rationale: "I select NO and cap my total fee-inclusive debit at 1.06 pUSD.",
    },
    market,
    { now: NOW },
  );
  assert.equal(result.intent.order.fullFillSharesAtCap, "2");
  assert.equal(result.intent.order.maximumOrderPrincipal, "1.06");
});

test("fails closed on invalid outcomes, outcome-book mismatch, and neg-risk requests", () => {
  errorCode(
    () => compileIntent({ ...REQUEST, outcome: "maybe" }, LIVE_MARKET_SNAPSHOT, { now: NOW }),
    "unsupported_outcome",
  );
  errorCode(
    () => compileIntent({ ...REQUEST, outcome: "no" }, LIVE_MARKET_SNAPSHOT, { now: NOW }),
    "outcome_snapshot_mismatch",
  );
  errorCode(
    () => compileIntent(REQUEST, { ...LIVE_MARKET_SNAPSHOT, negRisk: true }, { now: NOW }),
    "unsupported_neg_risk",
  );
});

test("finds the true best ask regardless of API ordering", () => {
  const shuffled = {
    ...LIVE_MARKET_SNAPSHOT,
    asks: [
      { price: "0.27", size: "79249.18" },
      { price: "0.29", size: "46122.52" },
      { price: "0.28", size: "76160.83" },
    ],
  };
  const result = compileIntent(REQUEST, shuffled, { now: NOW });
  assert.equal(result.intent.snapshot.bestAsk, "0.27");
});

test("client cannot override server-computed exposure", () => {
  const result = compileIntent(
    { ...REQUEST, exposure: { maximumLoss: "0", grossProfitAtCap: "999999" } },
    LIVE_MARKET_SNAPSHOT,
    { now: NOW },
  );
  assert.equal(result.intent.exposure.maximumLoss, "1.35");
  assert.equal(result.intent.exposure.grossProfitAtCap, "3.65");
});

test("fails closed when bounded liquidity cannot cover the order", () => {
  const shallow = {
    ...LIVE_MARKET_SNAPSHOT,
    asks: [
      { price: "0.29", size: "1" },
      { price: "0.27", size: "4.99" },
    ],
  };
  errorCode(
    () => compileIntent(REQUEST, shallow, { now: NOW }),
    "insufficient_bounded_liquidity",
  );
});
