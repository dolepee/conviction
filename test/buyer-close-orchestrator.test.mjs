import assert from "node:assert/strict";
import test from "node:test";

import { BuyerJourneyError, runCloseJourney } from "../src/buyer-orchestrator.mjs";

const PAYMENT_PAYER = "0x1111111111111111111111111111111111111111";
const SELLER_WALLET = "0x2222222222222222222222222222222222222222";
const CONDITION = `0x${"ab".repeat(32)}`;
const TOKEN = "123456789";
const SOURCE_INTENT = `0x${"31".repeat(32)}`;
const SOURCE_PROOF = `0x${"32".repeat(32)}`;
const SOURCE_TX = `0x${"33".repeat(32)}`;
const SOURCE_ORDER = `0x${"34".repeat(32)}`;

const request = {
  market: "example-market",
  outcome: "YES",
  shares: "5",
  minPrice: "0.26",
  sourcePosition: {
    intentHash: SOURCE_INTENT,
    positionProofHash: SOURCE_PROOF,
    transactionHash: SOURCE_TX,
    orderId: SOURCE_ORDER,
    intent: { version: "conviction-intent-v4" },
    issuance: { signature: "fixture" },
  },
};

function fixture({
  mutateValidated,
  mutatePreview,
  validateCardError,
  finalReadiness = {},
  driftReadiness = undefined,
  proofSettledAt = "1970-01-01T00:00:02.000Z",
  expiresAt = "2030-01-01T00:00:00.000Z",
} = {}) {
  let clock = 1_000;
  let executes = 0;
  let payments = 0;
  let closeReadinessChecks = 0;
  const confirmations = [];
  const emitted = [];
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
    intentHash: `0x${"cd".repeat(32)}`,
    expiresAt,
    intent: { market: { conditionId: CONDITION, question: "Fixture market?" }, source },
    executionCard: { argv: ["sell", "--market-id", CONDITION] },
    issuanceVerification: {
      keyId: "fixture-key",
      fingerprint: "sha256:fixture",
      issuedAt: "1970-01-01T00:00:00.000Z",
    },
    bounds: {
      sharesRaw: "5000000",
      minPrice: "0.26",
      minimumGrossProceedsRaw: "1300000",
      maximumFeeRaw: "0",
      minimumNetProceedsRaw: "1300000",
    },
  };
  const preview = {
    ok: true,
    preview: {
      action: "CLOSE",
      executable: false,
      market: { conditionId: CONDITION, outcomeTokenId: TOKEN },
      order: { sharesRaw: "5000000", minPrice: "0.26" },
      source,
    },
  };
  const readiness = {
    accessible: true,
    clobVersion: "V2",
    currentMode: "deposit_wallet",
    paymentPayer: PAYMENT_PAYER,
    buyerWallet: SELLER_WALLET,
    tradingAddress: SELLER_WALLET,
  };
  const adapters = {
    ensureTradingMode: async () => ({ currentMode: "deposit_wallet" }),
    checkReadiness: async () => readiness,
    previewClose: async () => mutatePreview ? mutatePreview(structuredClone(preview)) : structuredClone(preview),
    requestPaymentChallenge: async () => ({ amount: "100000", asset: "USD₮0" }),
    payAndRequestCard: async () => {
      payments += 1;
      return { card: { signed: true }, paymentTx: `0x${"ef".repeat(32)}` };
    },
    verifyPayment: async () => ({ transactionHash: `0x${"ef".repeat(32)}` }),
    validateCloseCard: async () => {
      if (validateCardError) throw validateCardError;
      return mutateValidated ? mutateValidated(structuredClone(validated)) : structuredClone(validated);
    },
    dryRun: async () => ({ ok: true, dry_run: true }),
    validateCloseDryRun: async () => ({ ok: true }),
    checkCloseReadiness: async () => {
      closeReadinessChecks += 1;
      return {
        ...readiness,
        outcomeTokenId: TOKEN,
        outcomeBalanceRaw: "5000000",
        approvedForExchange: true,
        reservedSharesRaw: "0",
        openSellOrderCount: 0,
        ...finalReadiness,
        ...(closeReadinessChecks > 1 && driftReadiness ? driftReadiness : {}),
      };
    },
    execute: async () => {
      executes += 1;
      return { ok: true };
    },
    buildCloseReceiptRequest: async () => ({
      transactionHash: `0x${"42".repeat(32)}`,
      orderId: `0x${"41".repeat(32)}`,
      intentHash: validated.intentHash,
      intent: validated.intent,
      issuance: { fixture: true },
    }),
    fetchCloseProof: async () => ({ ok: true }),
    validateCloseProof: async (_card, _proof, options) => {
      assert.equal(options.expectedReceiptRequest.transactionHash, `0x${"42".repeat(32)}`);
      assert.equal(options.expectedReceiptRequest.orderId, `0x${"41".repeat(32)}`);
      return {
        orderId: `0x${"41".repeat(32)}`,
        transactionHash: `0x${"42".repeat(32)}`,
        closeProofHash: `0x${"43".repeat(32)}`,
        closePassportHash: `0x${"44".repeat(32)}`,
        settledAt: proofSettledAt,
      };
    },
  };
  const confirm = async (kind) => {
    confirmations.push(kind);
    return true;
  };
  return {
    adapters,
    confirm,
    confirmations,
    emitted,
    executes: () => executes,
    payments: () => payments,
    now: () => (clock += 10),
  };
}

test("a reservation appearing after payment fails the repeated pre-submit gate", async () => {
  const f = fixture({ driftReadiness: { reservedSharesRaw: "1000000", openSellOrderCount: 1 } });
  await assert.rejects(run(f), (error) => error instanceof BuyerJourneyError && error.code === "position_reserved");
  assert.equal(f.payments(), 1);
  assert.equal(f.executes(), 0);
});

test("a proof settling before live-trade confirmation is rejected", async () => {
  const f = fixture({ proofSettledAt: "1970-01-01T00:00:00.000Z" });
  await assert.rejects(run(f), (error) => error instanceof BuyerJourneyError && error.code === "settlement_before_confirmation");
  assert.equal(f.executes(), 1);
});

test("a CLOSE proof from the confirmation second is rejected", async () => {
  const f = fixture({ proofSettledAt: "1970-01-01T00:00:01.999Z" });
  await assert.rejects(run(f), (error) => error instanceof BuyerJourneyError && error.code === "settlement_before_confirmation");
  assert.equal(f.executes(), 1);
});

function run(f, overrides = {}) {
  return runCloseJourney({
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

test("close journey keeps x402 and trade consent distinct and executes exactly once", async () => {
  const f = fixture();
  const result = await run(f);
  assert.equal(result.ok, true);
  assert.equal(result.mode, "close");
  assert.deepEqual(f.confirmations, ["payment", "trade"]);
  assert.equal(result.confirmation.count, 1);
  assert.equal(result.ordersPlaced, 1);
  assert.equal(f.executes(), 1);
  assert.ok(result.timings.paidAt < result.timings.confirmedAt);
  assert.ok(result.timings.confirmedAt < result.timings.provedAt);
  assert.equal(result.timings.paymentToProofMs, result.timings.provedAt - result.timings.paidAt);
  const confirmation = f.emitted.find((event) => event.type === "trade_confirmation");
  assert.equal(confirmation.bounds.marketQuestion, "Fixture market?");
  assert.equal(confirmation.bounds.conditionId, CONDITION);
  assert.equal(confirmation.bounds.outcomeTokenId, TOKEN);
  assert.equal(confirmation.bounds.issuerKeyId, "fixture-key");
  assert.equal(confirmation.bounds.completedPayment.transactionHash, `0x${"ef".repeat(32)}`);
  assert.equal(confirmation.bounds.feeAndNetEnforcement, "post-settlement-verification-only");
});

for (const [name, mutate, code] of [
  ["substituted token", (value) => ({ ...value, tokenId: "987654321" }), "token_substitution"],
  ["substituted wallet", (value) => ({ ...value, wallet: "0x3333333333333333333333333333333333333333" }), "wallet_substitution"],
  ["substituted outcome", (value) => ({ ...value, outcome: "NO" }), "outcome_substitution"],
  ["rewritten shares", (value) => ({ ...value, bounds: { ...value.bounds, sharesRaw: "4000000" } }), "shares_substitution"],
  ["crossed minimum", (value) => ({ ...value, bounds: { ...value.bounds, minPrice: "0.25" } }), "price_substitution"],
  ["substituted source", (value) => ({ ...value, intent: { ...value.intent, source: { ...value.intent.source, positionProofHash: `0x${"99".repeat(32)}` } } }), "source_substitution"],
]) {
  test(`${name} fails before any CLOSE order`, async () => {
    const f = fixture({ mutateValidated: mutate });
    await assert.rejects(run(f), (error) => error instanceof BuyerJourneyError && error.code === code);
    assert.equal(f.executes(), 0);
  });
}

test("payment alone never authorizes a CLOSE", async () => {
  const f = fixture();
  await assert.rejects(
    run(f, { confirm: async (kind) => kind === "payment" }),
    (error) => error instanceof BuyerJourneyError && error.code === "trade_not_confirmed",
  );
  assert.equal(f.executes(), 0);
});

test("a CLOSE card with insufficient submission headroom fails before trade confirmation", async () => {
  const f = fixture({ expiresAt: "1970-01-01T00:00:20.000Z" });
  await assert.rejects(
    run(f),
    (error) => error instanceof BuyerJourneyError && error.code === "insufficient_execution_window",
  );
  assert.deepEqual(f.confirmations, ["payment"]);
  assert.equal(f.executes(), 0);
});

test("expired card fails before any CLOSE order", async () => {
  const expired = new BuyerJourneyError("expired_card", "Close card expired");
  const f = fixture({ validateCardError: expired });
  await assert.rejects(run(f), (error) => error === expired);
  assert.equal(f.executes(), 0);
});

for (const [name, finalReadiness, code] of [
  ["insufficient fresh position", { outcomeBalanceRaw: "4999999" }, "insufficient_position"],
  ["reserved shares", { reservedSharesRaw: "1000000" }, "position_reserved"],
  ["open sell order", { openSellOrderCount: 1 }, "position_reserved"],
  ["readiness token substitution", { outcomeTokenId: "987654321" }, "token_substitution"],
  ["revoked CTF approval", { approvedForExchange: false }, "ctf_approval_missing"],
]) {
  test(`${name} fails in the final pre-execution gate`, async () => {
    const f = fixture({ finalReadiness });
    await assert.rejects(run(f), (error) => error instanceof BuyerJourneyError && error.code === code);
    assert.equal(f.executes(), 0);
    assert.equal(f.payments(), 0);
  });
}
