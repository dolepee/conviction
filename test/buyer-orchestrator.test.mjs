import assert from "node:assert/strict";
import test from "node:test";

import { BuyerJourneyError, runOpenJourney } from "../src/buyer-orchestrator.mjs";

const PAYMENT_PAYER = "0x1111111111111111111111111111111111111111";
const BUYER_WALLET = "0x2222222222222222222222222222222222222222";
const CONDITION = `0x${"ab".repeat(32)}`;
const TOKEN = "123456789";

function fixture({ mutateValidated, validateCardError } = {}) {
  let clock = 1_000;
  let executes = 0;
  const confirmations = [];
  const validated = {
    wallet: BUYER_WALLET,
    outcome: "YES",
    tokenId: TOKEN,
    intentHash: `0x${"cd".repeat(32)}`,
    expiresAt: "2030-01-01T00:00:00.000Z",
    intent: { market: { conditionId: CONDITION } },
    executionCard: { argv: ["buy", "--market-id", CONDITION] },
    bounds: {
      requestedBudgetRaw: "1350000",
      maximumOrderPrincipalRaw: "1350000",
      maximumFeeRaw: "0",
      maximumTotalDebitRaw: "1350000",
      maxPrice: "0.27",
    },
  };
  const adapters = {
    ensureTradingMode: async () => ({ currentMode: "deposit_wallet" }),
    checkReadiness: async () => ({
      accessible: true,
      clobVersion: "V2",
      currentMode: "deposit_wallet",
      paymentPayer: PAYMENT_PAYER,
      buyerWallet: BUYER_WALLET,
      tradingAddress: BUYER_WALLET,
      pUsdBalanceRaw: "9999999",
    }),
    previewMarket: async () => ({ conditionId: CONDITION, outcomeTokenId: TOKEN }),
    requestPaymentChallenge: async () => ({ amount: "50000", asset: "USD₮0" }),
    payAndRequestCard: async () => ({ card: { signed: true }, paymentTx: `0x${"ef".repeat(32)}` }),
    verifyPayment: async () => ({ transactionHash: `0x${"ef".repeat(32)}` }),
    validateCard: async () => {
      if (validateCardError) throw validateCardError;
      return mutateValidated ? mutateValidated(structuredClone(validated)) : structuredClone(validated);
    },
    dryRun: async () => ({ ok: true, dry_run: true }),
    validateDryRun: async () => ({ ok: true }),
    execute: async () => {
      executes += 1;
      return { ok: true };
    },
    buildReceiptRequest: async () => ({ transactionHash: `0x${"12".repeat(32)}` }),
    fetchProof: async () => ({ ok: true }),
    validateProof: async () => ({
      orderId: `0x${"34".repeat(32)}`,
      transactionHash: `0x${"12".repeat(32)}`,
      positionProofHash: `0x${"56".repeat(32)}`,
    }),
  };
  const confirm = async (kind) => {
    confirmations.push(kind);
    return true;
  };
  return {
    adapters,
    confirm,
    confirmations,
    executes: () => executes,
    now: () => (clock += 10),
  };
}

const request = { market: "example-market", side: "YES", budget: "1.35", maxPrice: "0.27" };

test("open journey keeps payment and trade consent distinct and executes exactly once", async () => {
  const f = fixture();
  const result = await runOpenJourney({
    request,
    paymentPayer: PAYMENT_PAYER,
    buyerWallet: BUYER_WALLET,
    adapters: f.adapters,
    confirm: f.confirm,
    now: f.now,
    trustedIssuers: [],
  });
  assert.equal(result.ok, true);
  assert.deepEqual(f.confirmations, ["payment", "trade"]);
  assert.equal(result.confirmation.count, 1);
  assert.equal(result.ordersPlaced, 1);
  assert.equal(f.executes(), 1);
  assert.ok(result.timings.paidAt < result.timings.confirmedAt);
  assert.ok(result.timings.confirmedAt < result.timings.provedAt);
});

for (const [name, mutate, code] of [
  ["substituted token", (value) => ({ ...value, tokenId: "987654321" }), "token_substitution"],
  ["substituted wallet", (value) => ({ ...value, wallet: "0x3333333333333333333333333333333333333333" }), "wallet_substitution"],
  ["crossed cap", (value) => ({ ...value, bounds: { ...value.bounds, maxPrice: "0.28" } }), "price_substitution"],
]) {
  test(`${name} fails before any order`, async () => {
    const f = fixture({ mutateValidated: mutate });
    await assert.rejects(
      runOpenJourney({
        request,
        paymentPayer: PAYMENT_PAYER,
        buyerWallet: BUYER_WALLET,
        adapters: f.adapters,
        confirm: f.confirm,
        now: f.now,
        trustedIssuers: [],
      }),
      (error) => error instanceof BuyerJourneyError && error.code === code,
    );
    assert.equal(f.executes(), 0);
  });
}

test("expired signed card fails before any order", async () => {
  const expired = new BuyerJourneyError("expired_card", "Position card expired");
  const f = fixture({ validateCardError: expired });
  await assert.rejects(
    runOpenJourney({
      request,
      paymentPayer: PAYMENT_PAYER,
      buyerWallet: BUYER_WALLET,
      adapters: f.adapters,
      confirm: f.confirm,
      now: f.now,
      trustedIssuers: [],
    }),
    (error) => error === expired,
  );
  assert.equal(f.executes(), 0);
});

test("payment alone never authorizes a trade", async () => {
  const f = fixture();
  await assert.rejects(
    runOpenJourney({
      request,
      paymentPayer: PAYMENT_PAYER,
      buyerWallet: BUYER_WALLET,
      adapters: f.adapters,
      confirm: async (kind) => kind === "payment",
      now: f.now,
      trustedIssuers: [],
    }),
    (error) => error instanceof BuyerJourneyError && error.code === "trade_not_confirmed",
  );
  assert.equal(f.executes(), 0);
});
