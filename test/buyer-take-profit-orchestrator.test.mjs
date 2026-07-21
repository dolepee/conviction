import assert from "node:assert/strict";
import test from "node:test";

import { BuyerJourneyError, runTakeProfitJourney } from "../src/buyer-orchestrator.mjs";
import { sha256 } from "../src/canonical.mjs";

const PAYMENT_PAYER = "0x1111111111111111111111111111111111111111";
const SELLER_WALLET = "0x2222222222222222222222222222222222222222";
const CONDITION = `0x${"ab".repeat(32)}`;
const TOKEN = "123456789";
const OTHER_TOKEN = "987654321";
const SOURCE_INTENT = `0x${"31".repeat(32)}`;
const SOURCE_PROOF = `0x${"32".repeat(32)}`;
const SOURCE_TX = `0x${"33".repeat(32)}`;
const SOURCE_ORDER = `0x${"34".repeat(32)}`;
const INTENT_HASH = `0x${"cd".repeat(32)}`;
const PAYMENT_TX = `0x${"ef".repeat(32)}`;
const ORDER_ID = `0x${"41".repeat(32)}`;
const PROOF_HASH = `0x${"42".repeat(32)}`;
const PASSPORT_HASH = `0x${"43".repeat(32)}`;
const START = Date.parse("2026-07-21T02:00:10.250Z");
const PLACEMENT_EXPIRES_AT = "2026-07-21T02:05:00.000Z";
const VENUE_EXPIRES_AT = "2026-07-21T03:00:00.000Z";
const VENUE_EXPIRES_UNIX = String(Date.parse(VENUE_EXPIRES_AT) / 1_000);

const sourcePosition = Object.freeze({
  intentHash: SOURCE_INTENT,
  positionProofHash: SOURCE_PROOF,
  transactionHash: SOURCE_TX,
  orderId: SOURCE_ORDER,
  intent: { version: "conviction-intent-v4" },
  issuance: { signature: "fixture" },
});

const request = Object.freeze({
  action: "take_profit",
  market: "example-market",
  outcome: "YES",
  shares: "5",
  targetPrice: "0.4",
  venueExpiresAt: VENUE_EXPIRES_AT,
  rationale: "Rest this verified position at the bounded target price.",
  sourcePosition,
});

function fixture({
  mutateValidated,
  mutatePreview,
  mutateTakeProfitReadiness,
  validateCardError,
  validateDryRunError,
  waitReturnsEarly = false,
  proofMutation,
  exactOrderMutation,
} = {}) {
  let clock = START;
  let validationCount = 0;
  let takeProfitReadinessCount = 0;
  let paymentCalls = 0;
  let executionCalls = 0;
  let dryRunCalls = 0;
  let dryRunValidationCalls = 0;
  let waitTarget;
  const confirmations = [];
  const emitted = [];
  const calls = [];
  const source = {
    intentHash: SOURCE_INTENT,
    positionProofHash: SOURCE_PROOF,
    transactionHash: SOURCE_TX,
    orderId: SOURCE_ORDER,
    wallet: SELLER_WALLET,
    marketConditionId: CONDITION,
    outcome: "YES",
    outcomeTokenId: TOKEN,
    actualSharesRaw: "5000000",
    intentVersion: "conviction-intent-v4",
    verificationMode: "signed-intent-window",
  };
  const validated = {
    wallet: SELLER_WALLET,
    outcome: "YES",
    tokenId: TOKEN,
    intentHash: INTENT_HASH,
    expiresAt: PLACEMENT_EXPIRES_AT,
    intent: {
      market: { conditionId: CONDITION, question: "Fixture market?" },
      source,
    },
    executionCard: {
      argv: [
        "sell", "--market-id", CONDITION, "--token-id", TOKEN,
        "--outcome", "yes", "--shares", "5", "--price", "0.4",
        "--order-type", "GTD", "--post-only", "--expires", VENUE_EXPIRES_UNIX,
      ],
    },
    issuanceVerification: {
      keyId: "fixture-key",
      fingerprint: "sha256:fixture",
      issuedAt: "2026-07-21T02:00:10.000Z",
    },
    bounds: {
      sharesRaw: "5000000",
      targetPrice: "0.4",
      minimumGrossProceedsRaw: "2000000",
      maximumFeeRaw: "0",
      minimumNetProceedsRaw: "2000000",
      venueExpiresAt: VENUE_EXPIRES_AT,
      venueExpiresAtUnix: VENUE_EXPIRES_UNIX,
    },
  };
  const preview = {
    ok: true,
    preview: {
      action: "TAKE_PROFIT",
      executable: false,
      requiresPayment: false,
      market: { conditionId: CONDITION, outcomeTokenId: TOKEN },
      order: {
        side: "SELL",
        orderType: "GTD",
        postOnly: true,
        outcome: "YES",
        outcomeTokenId: TOKEN,
        sharesRaw: "5000000",
        targetPrice: "0.4",
        venueExpiresAt: VENUE_EXPIRES_AT,
        venueExpiresAtUnix: VENUE_EXPIRES_UNIX,
      },
      source,
    },
  };
  const baseReadiness = {
    accessible: true,
    clobVersion: "V2",
    currentMode: "deposit_wallet",
    paymentPayer: PAYMENT_PAYER,
    buyerWallet: SELLER_WALLET,
    tradingAddress: SELLER_WALLET,
  };
  const adapters = {
    ensureTradingMode: async () => {
      calls.push("ensure_mode");
      return { currentMode: "deposit_wallet" };
    },
    checkReadiness: async () => {
      calls.push("base_readiness");
      return baseReadiness;
    },
    previewTakeProfit: async () => {
      calls.push("preview");
      return mutatePreview ? mutatePreview(structuredClone(preview)) : structuredClone(preview);
    },
    checkTakeProfitReadiness: async () => {
      takeProfitReadinessCount += 1;
      calls.push(`take_profit_readiness_${takeProfitReadinessCount}`);
      const value = {
        ...baseReadiness,
        outcomeTokenId: TOKEN,
        outcomeBalanceRaw: "5000000",
        approvedForExchange: true,
        reservedSharesRaw: "0",
        openSellOrderCount: 0,
        openOrdersComplete: true,
      };
      return mutateTakeProfitReadiness
        ? mutateTakeProfitReadiness(value, takeProfitReadinessCount)
        : value;
    },
    requestPaymentChallenge: async () => {
      calls.push("payment_challenge");
      return {
        decoded: {
          resource: { url: "https://conviction.example/api/manage" },
          accepts: [{
            amount: "100000",
            network: "eip155:196",
            asset: "0x3333333333333333333333333333333333333333",
            payTo: "0x4444444444444444444444444444444444444444",
          }],
        },
      };
    },
    payAndRequestCard: async () => {
      paymentCalls += 1;
      calls.push("payment_replay");
      return { card: { signed: true }, paymentTx: PAYMENT_TX };
    },
    verifyPayment: async () => {
      calls.push("payment_verify");
      return { transactionHash: PAYMENT_TX };
    },
    validateTakeProfitCard: async () => {
      validationCount += 1;
      calls.push(`validate_card_${validationCount}`);
      if (validateCardError) throw validateCardError;
      const value = structuredClone(validated);
      return mutateValidated ? mutateValidated(value, validationCount) : value;
    },
    dryRun: async (argv) => {
      dryRunCalls += 1;
      calls.push(`dry_run_${dryRunCalls}`);
      assert.deepEqual(argv, validated.executionCard.argv);
      return { ok: true, dry_run: true, exact: true };
    },
    validateTakeProfitDryRun: async () => {
      dryRunValidationCalls += 1;
      calls.push(`validate_dry_run_${dryRunValidationCalls}`);
      if (validateDryRunError) throw validateDryRunError;
      return { ok: true };
    },
    waitUntil: async (target) => {
      calls.push("wait_until_next_second");
      waitTarget = target;
      if (!waitReturnsEarly) clock = Math.max(clock, target);
    },
    execute: async (argv) => {
      executionCalls += 1;
      calls.push("execute");
      assert.deepEqual(argv, validated.executionCard.argv);
      return { ok: true, data: { order_id: ORDER_ID, status: "live" } };
    },
    validateTakeProfitLiveResult: async () => {
      calls.push("validate_live_result");
      return { ok: true, orderId: ORDER_ID };
    },
    fetchExactOrder: async (input) => {
      calls.push("fetch_exact_order");
      assert.deepEqual(input, {
        signerAddress: PAYMENT_PAYER,
        depositWallet: SELLER_WALLET,
        orderId: ORDER_ID,
        outcomeTokenId: TOKEN,
      });
      const snapshot = {
        version: "conviction-polymarket-order-snapshot-v1",
        verificationSource: "authenticated-polymarket-clob",
        onChain: false,
        fetchedAt: new Date(clock).toISOString(),
        depositWallet: SELLER_WALLET,
        order: {
          id: ORDER_ID,
          status: "LIVE",
          assetId: TOKEN,
          createdAt: String(Math.floor(waitTarget / 1_000)),
        },
      };
      return exactOrderMutation ? exactOrderMutation(snapshot) : snapshot;
    },
    buildTakeProfitOrderProof: async (_card, _liveResult, snapshot, options) => {
      calls.push("build_armed_proof");
      assert.equal(BigInt(snapshot.order.createdAt) > BigInt(Math.floor(options.confirmedAt / 1_000)), true);
      const proof = {
        ok: true,
        orderId: ORDER_ID,
        status: "ARMED",
        recoverable: false,
        settlementProofRequired: false,
        restingOrderProof: { version: "conviction-resting-order-proof-v1", status: "ARMED", onChain: false },
        restingOrderProofHash: PROOF_HASH,
        takeProfitPassport: { version: "conviction-take-profit-passport-v1" },
        takeProfitPassportHash: PASSPORT_HASH,
      };
      return proofMutation ? proofMutation(proof, snapshot) : proof;
    },
  };
  const confirm = async (kind) => {
    confirmations.push(kind);
    calls.push(`confirm_${kind}`);
    return true;
  };
  return {
    adapters,
    confirm,
    confirmations,
    emitted,
    calls,
    now: () => (clock += 5),
    paymentCalls: () => paymentCalls,
    executionCalls: () => executionCalls,
    dryRunCalls: () => dryRunCalls,
    dryRunValidationCalls: () => dryRunValidationCalls,
    takeProfitReadinessCount: () => takeProfitReadinessCount,
    waitTarget: () => waitTarget,
  };
}

function run(f, overrides = {}) {
  return runTakeProfitJourney({
    request,
    paymentPayer: PAYMENT_PAYER,
    sellerWallet: SELLER_WALLET,
    adapters: f.adapters,
    confirm: f.confirm,
    emit: (event) => f.emitted.push(event),
    now: f.now,
    trustedIssuers: [],
    ...overrides,
  });
}

test("take-profit journey pays, confirms, waits, places once, and returns an authenticated ARMED proof", async () => {
  const f = fixture();
  const result = await run(f);

  assert.equal(result.ok, true);
  assert.equal(result.mode, "take_profit");
  assert.equal(result.status, "ARMED");
  assert.deepEqual(f.confirmations, ["payment", "trade"]);
  assert.equal(result.confirmation.count, 1);
  assert.equal(result.ordersPlaced, 1);
  assert.equal(f.executionCalls(), 1);
  assert.equal(f.paymentCalls(), 1);
  assert.equal(f.takeProfitReadinessCount(), 2);
  assert.equal(f.dryRunCalls(), 2);
  assert.equal(f.dryRunValidationCalls(), 2);
  assert.equal(f.waitTarget(), (Math.floor(result.confirmation.confirmedAt / 1_000) + 1) * 1_000);
  assert.equal(result.timings.notBeforeExecutionAt, f.waitTarget());
  assert.ok(result.timings.paidAt < result.timings.confirmedAt);
  assert.ok(result.timings.confirmedAt < result.timings.provedAt);
  assert.equal(result.timings.paymentToProofMs, result.timings.provedAt - result.timings.paidAt);
  assert.equal(result.orderId, ORDER_ID);
  assert.equal(result.restingOrderProofHash, PROOF_HASH);
  assert.equal(result.takeProfitPassportHash, PASSPORT_HASH);
  assert.ok(f.calls.indexOf("confirm_trade") < f.calls.indexOf("wait_until_next_second"));
  assert.ok(f.calls.indexOf("wait_until_next_second") < f.calls.indexOf("take_profit_readiness_2"));
  assert.equal(f.calls[f.calls.indexOf("execute") - 1], "take_profit_readiness_2");

  const payment = f.emitted.find((event) => event.type === "payment_confirmation");
  const trade = f.emitted.find((event) => event.type === "trade_confirmation");
  assert.equal(payment.request.action, "take_profit");
  assert.equal(trade.bounds.action, "TAKE_PROFIT");
  assert.equal(trade.bounds.conditionId, CONDITION);
  assert.equal(trade.bounds.outcomeTokenId, TOKEN);
  assert.equal(trade.bounds.orderType, "GTD");
  assert.equal(trade.bounds.postOnly, true);
  assert.equal(trade.bounds.completedPayment.transactionHash, PAYMENT_TX);
});

test("a maker fill between POST acknowledgement and the first exact fetch returns a recoverable binding without retrying", async () => {
  const f = fixture({
    exactOrderMutation: (snapshot) => ({
      ...snapshot,
      order: {
        ...snapshot.order,
        status: "MATCHED",
        sizeMatched: "5000000",
        associatedTrades: ["trade-1"],
      },
    }),
    proofMutation: (proof, snapshot) => ({
      ...proof,
      status: "FILLED_PENDING_CHAIN_PROOF",
      recoverable: true,
      settlementProofRequired: true,
      initialOrderSnapshot: snapshot,
      initialOrderSnapshotHash: sha256(snapshot),
      restingOrderProof: {
        version: "conviction-submitted-order-proof-v1",
        status: "FILLED_PENDING_CHAIN_PROOF",
        onChain: false,
      },
    }),
  });

  const result = await run(f);

  assert.equal(result.status, "FILLED_PENDING_CHAIN_PROOF");
  assert.equal(result.recoverable, true);
  assert.equal(result.reconciliationRequired, true);
  assert.equal(result.settlementProofRequired, true);
  assert.equal(result.ordersPlaced, 1);
  assert.equal(f.executionCalls(), 1);
  assert.equal(f.calls.filter((value) => value === "execute").length, 1);
  assert.equal(result.events.at(-1).type, "take_profit_recovery_binding_verified");
});

for (const [name, mutate, code] of [
  ["substituted token", (value) => ({ ...value, tokenId: OTHER_TOKEN }), "token_substitution"],
  ["substituted wallet", (value) => ({ ...value, wallet: "0x3333333333333333333333333333333333333333" }), "wallet_substitution"],
  ["substituted outcome", (value) => ({ ...value, outcome: "NO" }), "outcome_substitution"],
  ["rewritten shares", (value) => ({ ...value, bounds: { ...value.bounds, sharesRaw: "4000000" } }), "shares_substitution"],
  ["rewritten target", (value) => ({ ...value, bounds: { ...value.bounds, targetPrice: "0.41" } }), "price_substitution"],
  ["rewritten venue expiry", (value) => ({ ...value, bounds: { ...value.bounds, venueExpiresAtUnix: String(Number(VENUE_EXPIRES_UNIX) + 1) } }), "expiry_substitution"],
  ["substituted source", (value) => ({ ...value, intent: { ...value.intent, source: { ...value.intent.source, positionProofHash: `0x${"99".repeat(32)}` } } }), "source_substitution"],
]) {
  test(`${name} fails before any TAKE_PROFIT order`, async () => {
    const f = fixture({ mutateValidated: mutate });
    await assert.rejects(run(f), (error) => error instanceof BuyerJourneyError && error.code === code);
    assert.equal(f.executionCalls(), 0);
  });
}

test("payment alone never authorizes a TAKE_PROFIT order", async () => {
  const f = fixture();
  await assert.rejects(
    run(f, { confirm: async (kind) => kind === "payment" }),
    (error) => error instanceof BuyerJourneyError && error.code === "trade_not_confirmed",
  );
  assert.equal(f.paymentCalls(), 1);
  assert.equal(f.executionCalls(), 0);
  assert.equal(f.waitTarget(), undefined);
});

test("an expired signed card fails before any TAKE_PROFIT order", async () => {
  const expired = new BuyerJourneyError("expired_card", "Take-profit card expired");
  const f = fixture({ validateCardError: expired });
  await assert.rejects(run(f), (error) => error === expired);
  assert.equal(f.executionCalls(), 0);
});

test("an exact dry-run mismatch fails before any TAKE_PROFIT order", async () => {
  const mismatch = new BuyerJourneyError("plugin_mismatch", "Official dry run changed the token");
  const f = fixture({ validateDryRunError: mismatch });
  await assert.rejects(run(f), (error) => error === mismatch);
  assert.equal(f.executionCalls(), 0);
});

for (const [name, mutation, code] of [
  ["selected-token reservation", { reservedSharesRaw: "1000000", openSellOrderCount: 1 }, "position_reserved"],
  ["selected-token open SELL", { openSellOrderCount: 1 }, "position_reserved"],
  ["revoked approval", { approvedForExchange: false }, "ctf_approval_missing"],
  ["insufficient balance", { outcomeBalanceRaw: "4999999" }, "insufficient_position"],
  ["incomplete reservation snapshot", { openOrdersComplete: false }, "incomplete_open_orders"],
  ["readiness token substitution", { outcomeTokenId: OTHER_TOKEN }, "token_substitution"],
]) {
  test(`${name} appearing after consent fails the final gate with zero orders`, async () => {
    const f = fixture({
      mutateTakeProfitReadiness: (value, count) => count === 2 ? { ...value, ...mutation } : value,
    });
    await assert.rejects(run(f), (error) => error instanceof BuyerJourneyError && error.code === code);
    assert.equal(f.paymentCalls(), 1);
    assert.equal(f.executionCalls(), 0);
  });
}

test("a card substitution introduced after confirmation still fails before execution", async () => {
  const f = fixture({
    mutateValidated: (value, count) => count === 2
      ? { ...value, tokenId: OTHER_TOKEN }
      : value,
  });
  await assert.rejects(run(f), (error) => error instanceof BuyerJourneyError && error.code === "token_substitution");
  assert.equal(f.executionCalls(), 0);
});

test("execution is blocked if the wait adapter returns inside the confirmation second", async () => {
  const f = fixture({ waitReturnsEarly: true });
  await assert.rejects(
    run(f),
    (error) => error instanceof BuyerJourneyError && error.code === "confirmation_clock_not_advanced",
  );
  assert.equal(f.executionCalls(), 0);
});

test("a non-ARMED exact-order proof is rejected after the sole placement attempt", async () => {
  const f = fixture({
    proofMutation: (proof) => ({
      ...proof,
      restingOrderProof: { ...proof.restingOrderProof, status: "UNKNOWN" },
    }),
  });
  await assert.rejects(
    run(f),
    (error) => error instanceof BuyerJourneyError && error.code === "invalid_take_profit_proof",
  );
  assert.equal(f.executionCalls(), 1);
});
