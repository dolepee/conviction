import assert from "node:assert/strict";
import test from "node:test";

import { ConvictionError } from "../src/errors.mjs";
import {
  compileTakeProfitIntent,
  compileTakeProfitPreview,
} from "../src/take-profit-intent-compiler.mjs";
import { LIVE_MARKET_SNAPSHOT } from "./fixtures.mjs";

const NOW = Date.parse("2026-07-21T02:00:10.000Z");
const WALLET = "0x6a355e4971d9ac2ab97d22c3cf361d42faba33fe";
const VENUE_EXPIRES_AT = "2026-07-22T02:00:00.000Z";
const SOURCE = Object.freeze({
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
const POSITION = Object.freeze({
  chainId: 137,
  wallet: WALLET,
  outcomeTokenId: LIVE_MARKET_SNAPSHOT.yesTokenId,
  balanceRaw: "5000000",
  approvedForExchange: true,
  blockNumber: "0x5666a7b",
  blockHash: `0x${"a".repeat(64)}`,
  capturedAt: "2026-07-21T02:00:09.000Z",
});
const REQUEST = Object.freeze({
  action: "take_profit",
  market: LIVE_MARKET_SNAPSHOT.slug,
  outcome: "yes",
  shares: "5",
  targetPrice: "0.4",
  venueExpiresAt: VENUE_EXPIRES_AT,
  wallet: WALLET,
  rationale: "Rest the full verified YES position at a forty-cent take-profit target.",
  source: SOURCE,
});

function errorCode(fn, code) {
  assert.throws(fn, (error) => error instanceof ConvictionError && error.code === code);
}

test("compiles a bounded post-only GTD take-profit placement", () => {
  const result = compileTakeProfitIntent(REQUEST, LIVE_MARKET_SNAPSHOT, POSITION, { now: NOW });

  assert.equal(result.ok, true);
  assert.equal(result.intent.version, "conviction-take-profit-intent-v1");
  assert.equal(result.intent.action, "TAKE_PROFIT");
  assert.equal(result.intent.order.side, "SELL");
  assert.equal(result.intent.order.orderType, "GTD");
  assert.equal(result.intent.order.postOnly, true);
  assert.equal(result.intent.order.sharesRaw, "5000000");
  assert.equal(result.intent.order.targetPrice, "0.4");
  assert.equal(result.intent.order.minimumGrossProceedsRaw, "2000000");
  assert.equal(result.intent.order.minimumNetProceedsRaw, "2000000");
  assert.equal(result.intent.order.venueExpiresAt, VENUE_EXPIRES_AT);
  assert.equal(result.intent.order.venueExpiresAtUnix, "1784685600");
  assert.equal(result.intent.position.remainingSharesAfterFullFillRaw, "0");
  assert.equal(result.intent.market.tickSize, "0.01");
  assert.equal(result.intent.market.minOrderSize, "5");
  assert.equal(result.intent.snapshot.tickSize, "0.01");
  assert.equal(result.intent.snapshot.minOrderSize, "5");
  assert.equal(result.intent.source.positionProofHash, SOURCE.positionProofHash);
  assert.deepEqual(result.executionCard.argv, [
    "sell",
    "--market-id",
    LIVE_MARKET_SNAPSHOT.conditionId,
    "--token-id",
    LIVE_MARKET_SNAPSHOT.yesTokenId,
    "--outcome",
    "yes",
    "--shares",
    "5",
    "--price",
    "0.4",
    "--order-type",
    "GTD",
    "--post-only",
    "--expires",
    "1784685600",
  ]);
  assert.equal(result.executionCard.authorizationScope, "single-bounded-take-profit");
  assert.equal(result.executionCard.exactAuthorizedShares, "5");
  assert.equal(result.executionCard.targetPrice, "0.4");
  assert.equal(result.executionCard.minimumSignedGrossProceeds, "2");
  assert.equal(result.executionCard.postSettlementNetVerificationFloor, "2");
  assert.equal(result.executionCard.postOnly, true);
  assert.equal(result.executionCard.venueExpiresAt, VENUE_EXPIRES_AT);
  assert.equal(result.executionCard.venueExpiresAtUnix, "1784685600");
  assert.equal(result.executionCard.placementExpiresAt, "2026-07-21T02:05:00.000Z");
  assert.equal(result.executionCard.expiresAt, result.executionCard.placementExpiresAt);
  assert.equal(result.executionCard.requiresUserConfirmation, true);
  assert.equal(result.executionCard.nonCustodial, true);
  assert.equal(result.executionCard.requiresSufficientPosition, true);
});

test("previews the exact placement bounds without an executable card or intent hash", () => {
  const preview = compileTakeProfitPreview(REQUEST, LIVE_MARKET_SNAPSHOT, POSITION, { now: NOW });
  const intent = compileTakeProfitIntent(REQUEST, LIVE_MARKET_SNAPSHOT, POSITION, { now: NOW });

  assert.equal(preview.preview.version, "conviction-take-profit-preview-v1");
  assert.equal(preview.preview.action, "TAKE_PROFIT");
  assert.equal(preview.preview.executable, false);
  assert.equal(preview.preview.requiresPayment, false);
  assert.deepEqual(preview.preview.order, intent.intent.order);
  assert.deepEqual(preview.preview.source, intent.intent.source);
  assert.deepEqual(preview.preview.snapshot, intent.intent.snapshot);
  assert.equal("executionCard" in preview, false);
  assert.equal("intentHash" in preview, false);
});

test("binds a NO take-profit to the selected NO token through the execution argv", () => {
  const market = {
    ...LIVE_MARKET_SNAPSHOT,
    selectedOutcome: "NO",
    outcomeTokenId: LIVE_MARKET_SNAPSHOT.noTokenId,
    counterOutcomeTokenId: LIVE_MARKET_SNAPSHOT.yesTokenId,
    bids: [{ price: "0.20", size: "100" }],
    asks: [{ price: "0.22", size: "100" }],
  };
  const source = {
    ...SOURCE,
    outcome: "NO",
    outcomeTokenId: LIVE_MARKET_SNAPSHOT.noTokenId,
  };
  const position = {
    ...POSITION,
    outcomeTokenId: LIVE_MARKET_SNAPSHOT.noTokenId,
  };
  const result = compileTakeProfitIntent(
    { ...REQUEST, outcome: "no", targetPrice: "0.4", source },
    market,
    position,
    { now: NOW },
  );

  assert.equal(result.intent.market.outcome, "NO");
  assert.equal(result.intent.order.outcomeTokenId, LIVE_MARKET_SNAPSHOT.noTokenId);
  assert.equal(result.executionCard.argv[4], LIVE_MARKET_SNAPSHOT.noTokenId);
  assert.equal(result.executionCard.argv[6], "no");
});

test("reserves a conservative fee at the target while preserving the absolute fee ceiling", () => {
  const result = compileTakeProfitIntent(
    REQUEST,
    { ...LIVE_MARKET_SNAPSHOT, feeBps: 1000 },
    POSITION,
    { now: NOW },
  );

  assert.equal(result.intent.order.minimumGrossProceeds, "2");
  assert.equal(result.intent.order.feeAtTargetPrice, "0.2");
  assert.equal(result.intent.order.maximumFee, "0.5");
  assert.equal(result.intent.order.minimumNetProceeds, "1.8");
  assert.equal(result.intent.proceeds.feeAndNetPreventivelyEnforced, false);
});

test("fails closed when a post-only target would cross or violates venue precision", () => {
  errorCode(
    () => compileTakeProfitIntent({ ...REQUEST, targetPrice: "0.26" }, LIVE_MARKET_SNAPSHOT, POSITION, { now: NOW }),
    "take_profit_would_cross",
  );
  errorCode(
    () => compileTakeProfitIntent({ ...REQUEST, targetPrice: "0.265" }, LIVE_MARKET_SNAPSHOT, POSITION, { now: NOW }),
    "price_tick_mismatch",
  );
  errorCode(
    () => compileTakeProfitIntent({ ...REQUEST, shares: "4" }, LIVE_MARKET_SNAPSHOT, POSITION, { now: NOW }),
    "resting_order_below_minimum",
  );
  errorCode(
    () => compileTakeProfitIntent(
      { ...REQUEST, targetPrice: "0.265" },
      { ...LIVE_MARKET_SNAPSHOT, tickSize: "0.001" },
      POSITION,
      { now: NOW },
    ),
    "non_deterministic_proceeds",
  );
});

test("fails closed on venue expiry that cannot outlive placement or exceeds market end", () => {
  errorCode(
    () => compileTakeProfitIntent(
      { ...REQUEST, venueExpiresAt: "2026-07-21T02:06:29.000Z" },
      LIVE_MARKET_SNAPSHOT,
      POSITION,
      { now: NOW },
    ),
    "venue_expiry_too_soon",
  );
  errorCode(
    () => compileTakeProfitIntent(
      { ...REQUEST, venueExpiresAt: "2027-01-01T00:00:00.000Z" },
      LIVE_MARKET_SNAPSHOT,
      POSITION,
      { now: NOW },
    ),
    "venue_expiry_after_market",
  );
  errorCode(
    () => compileTakeProfitIntent(
      { ...REQUEST, venueExpiresAt: "2026-07-22T02:00:00.125Z" },
      LIVE_MARKET_SNAPSHOT,
      POSITION,
      { now: NOW },
    ),
    "invalid_venue_expiry",
  );

  const millisecondSnapshot = {
    ...LIVE_MARKET_SNAPSHOT,
    capturedAt: "2026-07-21T02:00:00.999Z",
  };
  errorCode(
    () => compileTakeProfitIntent(
      { ...REQUEST, venueExpiresAt: "2026-07-21T02:06:30.000Z" },
      millisecondSnapshot,
      POSITION,
      { now: NOW },
    ),
    "venue_expiry_too_soon",
  );
  assert.doesNotThrow(() => compileTakeProfitIntent(
    { ...REQUEST, venueExpiresAt: "2026-07-21T02:06:31.000Z" },
    millisecondSnapshot,
    POSITION,
    { now: NOW },
  ));
});

test("fails closed on stale state, missing approval, or source identity substitution", () => {
  errorCode(
    () => compileTakeProfitIntent(REQUEST, LIVE_MARKET_SNAPSHOT, POSITION, { now: NOW + 60_000 }),
    "stale_snapshot",
  );
  errorCode(
    () => compileTakeProfitIntent(REQUEST, LIVE_MARKET_SNAPSHOT, { ...POSITION, approvedForExchange: false }, { now: NOW }),
    "ctf_approval_missing",
  );
  errorCode(
    () => compileTakeProfitIntent(
      REQUEST,
      { ...LIVE_MARKET_SNAPSHOT, outcomeTokenId: LIVE_MARKET_SNAPSHOT.noTokenId },
      POSITION,
      { now: NOW },
    ),
    "outcome_token_mapping_mismatch",
  );

  const cases = [
    [{ wallet: `0x${"9".repeat(40)}` }, "source_wallet_mismatch"],
    [{ marketConditionId: `0x${"8".repeat(64)}` }, "source_market_mismatch"],
    [{ outcome: "NO" }, "source_outcome_mismatch"],
    [{ outcomeTokenId: LIVE_MARKET_SNAPSHOT.noTokenId }, "source_token_mismatch"],
    [{ actualSharesRaw: "4999999" }, "source_shares_exceeded"],
  ];
  for (const [mutation, code] of cases) {
    errorCode(
      () => compileTakeProfitIntent(
        { ...REQUEST, source: { ...SOURCE, ...mutation } },
        LIVE_MARKET_SNAPSHOT,
        POSITION,
        { now: NOW },
      ),
      code,
    );
  }
});
