import assert from "node:assert/strict";
import test from "node:test";

import {
  compileCloseIntent,
  compileClosePreview,
} from "../src/exit-intent-compiler.mjs";
import { ConvictionError } from "../src/errors.mjs";
import { LIVE_MARKET_SNAPSHOT } from "./fixtures.mjs";

const NOW = Date.parse("2026-07-21T02:00:10.000Z");
const WALLET = "0x6a355e4971d9ac2ab97d22c3cf361d42faba33fe";
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
  action: "close",
  market: LIVE_MARKET_SNAPSHOT.slug,
  outcome: "yes",
  shares: "5",
  minPrice: "0.26",
  wallet: WALLET,
  rationale: "Close the full verified YES position at no less than twenty-six cents.",
  source: SOURCE,
});

function errorCode(fn, code) {
  assert.throws(fn, (error) => error instanceof ConvictionError && error.code === code);
}

test("compiles an exact full-fill-or-kill bounded close", () => {
  const result = compileCloseIntent(REQUEST, LIVE_MARKET_SNAPSHOT, POSITION, { now: NOW });
  assert.equal(result.ok, true);
  assert.equal(result.intent.version, "conviction-exit-intent-v1");
  assert.equal(result.intent.action, "CLOSE");
  assert.equal(result.intent.order.side, "SELL");
  assert.equal(result.intent.order.orderType, "FOK");
  assert.equal(result.intent.order.sharesRaw, "5000000");
  assert.equal(result.intent.order.minimumGrossProceedsRaw, "1300000");
  assert.equal(result.intent.order.feeAtPriceFloorRaw, "0");
  assert.equal(result.intent.order.maximumFeeRaw, "0");
  assert.equal(result.intent.order.minimumNetProceedsRaw, "1300000");
  assert.equal(result.intent.position.remainingSharesAfterFullCloseRaw, "0");
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
    "0.26",
    "--order-type",
    "FOK",
  ]);
  assert.equal(result.executionCard.authorizationScope, "single-bounded-close");
  assert.equal(result.executionCard.exactAuthorizedShares, "5");
  assert.equal(result.executionCard.minimumSignedGrossProceeds, "1.3");
  assert.equal(result.executionCard.postSettlementNetVerificationFloor, "1.3");
  assert.equal(result.executionCard.feeAndNetPreventivelyEnforced, false);
});

test("previews the same close without an executable card", () => {
  const preview = compileClosePreview(REQUEST, LIVE_MARKET_SNAPSHOT, POSITION, { now: NOW });
  const intent = compileCloseIntent(REQUEST, LIVE_MARKET_SNAPSHOT, POSITION, { now: NOW });
  assert.equal(preview.preview.version, "conviction-close-preview-v1");
  assert.equal(preview.preview.executable, false);
  assert.deepEqual(preview.preview.order, intent.intent.order);
  assert.deepEqual(preview.preview.source, intent.intent.source);
  assert.equal("executionCard" in preview, false);
  assert.equal("intentHash" in preview, false);
});

test("reserves a conservative fee from minimum gross proceeds", () => {
  const result = compileCloseIntent(
    REQUEST,
    { ...LIVE_MARKET_SNAPSHOT, feeBps: 1000 },
    POSITION,
    { now: NOW },
  );
  assert.equal(result.intent.order.minimumGrossProceeds, "1.3");
  assert.equal(result.intent.order.feeAtPriceFloor, "0.13");
  assert.equal(result.intent.order.maximumFee, "0.5");
  assert.equal(result.intent.order.minimumNetProceeds, "1.17");
});

test("fails closed on source identity substitution", () => {
  const cases = [
    [{ wallet: `0x${"9".repeat(40)}` }, "source_wallet_mismatch"],
    [{ marketConditionId: `0x${"8".repeat(64)}` }, "source_market_mismatch"],
    [{ outcome: "NO" }, "source_outcome_mismatch"],
    [{ outcomeTokenId: LIVE_MARKET_SNAPSHOT.noTokenId }, "source_token_mismatch"],
    [{ actualSharesRaw: "4999999" }, "source_shares_exceeded"],
  ];
  for (const [mutation, code] of cases) {
    errorCode(
      () => compileCloseIntent(
        { ...REQUEST, source: { ...SOURCE, ...mutation } },
        LIVE_MARKET_SNAPSHOT,
        POSITION,
        { now: NOW },
      ),
      code,
    );
  }
});

test("fails before signing on insufficient holdings or bounded bid depth", () => {
  errorCode(
    () => compileCloseIntent(REQUEST, LIVE_MARKET_SNAPSHOT, { ...POSITION, approvedForExchange: false }, { now: NOW }),
    "ctf_approval_missing",
  );
  errorCode(
    () => compileCloseIntent(REQUEST, LIVE_MARKET_SNAPSHOT, { ...POSITION, balanceRaw: "4999999" }, { now: NOW }),
    "insufficient_position",
  );
  errorCode(
    () => compileCloseIntent(
      REQUEST,
      { ...LIVE_MARKET_SNAPSHOT, bids: [{ price: "0.26", size: "4.99" }] },
      POSITION,
      { now: NOW },
    ),
    "insufficient_bounded_liquidity",
  );
});

test("fails on a crossed floor, stale snapshot, non-whole shares, or sub-dollar close", () => {
  errorCode(
    () => compileCloseIntent({ ...REQUEST, minPrice: "0.27" }, LIVE_MARKET_SNAPSHOT, POSITION, { now: NOW }),
    "floor_above_best_bid",
  );
  errorCode(
    () => compileCloseIntent(REQUEST, LIVE_MARKET_SNAPSHOT, POSITION, { now: NOW + 60_000 }),
    "stale_snapshot",
  );
  errorCode(
    () => compileCloseIntent({ ...REQUEST, shares: "4.5" }, LIVE_MARKET_SNAPSHOT, POSITION, { now: NOW }),
    "non_deterministic_shares",
  );
  errorCode(
    () => compileCloseIntent(
      { ...REQUEST, shares: "3", source: { ...SOURCE, actualSharesRaw: "5000000" } },
      LIVE_MARKET_SNAPSHOT,
      POSITION,
      { now: NOW },
    ),
    "marketable_order_below_minimum",
  );
});
