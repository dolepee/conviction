import assert from "node:assert/strict";
import test from "node:test";

import { BuyerJourneyError, runOpenJourney } from "../src/buyer-orchestrator.mjs";

const PAYMENT_PAYER = "0x1111111111111111111111111111111111111111";
const BUYER_WALLET = "0x2222222222222222222222222222222222222222";
const CONDITION = `0x${"ab".repeat(32)}`;
const TOKEN = "123456789";
const PREP_HASH = `0x${"99".repeat(32)}`;

function fixture({
  mutateValidated,
  validateCardError,
  proofSettledAt = "1970-01-01T00:00:02.000Z",
  mode = "deposit_wallet",
  eoaAllowanceRaw = "1350000",
} = {}) {
  let clock = 1_000;
  let executes = 0;
  let preparations = 0;
  const dryRunArgv = [];
  const executeArgv = [];
  const confirmations = [];
  const validated = {
    wallet: BUYER_WALLET,
    outcome: "YES",
    tokenId: TOKEN,
    intentHash: `0x${"cd".repeat(32)}`,
    issuance: { version: "conviction-issuance-v1", signature: "fixture" },
    expiresAt: "2030-01-01T00:00:00.000Z",
    intent: { market: { conditionId: CONDITION } },
    walletPreparation: {
      planHash: PREP_HASH,
      tradingMode: "eoa",
      execution: {
        appendArgv: ["--mode", "eoa"],
        forbiddenArgv: ["--approve"],
      },
    },
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
    ensureTradingMode: async () => ({ currentMode: mode }),
    checkReadiness: async () => ({
      accessible: true,
      clobVersion: "V2",
      currentMode: mode,
      paymentPayer: PAYMENT_PAYER,
      buyerWallet: BUYER_WALLET,
      tradingAddress: BUYER_WALLET,
      pUsdBalanceRaw: "9999999",
      ...(mode === "eoa" ? { pUsdAllowanceRaw: eoaAllowanceRaw } : {}),
    }),
    previewMarket: async () => ({ conditionId: CONDITION, outcomeTokenId: TOKEN }),
    prepareOpenWallet: async ({ confirm }) => {
      preparations += 1;
      const accepted = await confirm("wallet_preparation", {
        plan: { planHash: PREP_HASH },
      });
      if (!accepted) throw new BuyerJourneyError("wallet_preparation_not_confirmed", "not confirmed");
      return { ok: true, mode: "eoa", planHash: PREP_HASH };
    },
    requestPaymentChallenge: async () => ({ amount: "50000", asset: "USD₮0" }),
    payAndRequestCard: async () => ({ card: { signed: true }, paymentTx: `0x${"ef".repeat(32)}` }),
    verifyPayment: async () => ({ transactionHash: `0x${"ef".repeat(32)}` }),
    validateCard: async () => {
      if (validateCardError) throw validateCardError;
      return mutateValidated ? mutateValidated(structuredClone(validated)) : structuredClone(validated);
    },
    dryRun: async (argv) => {
      dryRunArgv.push([...argv]);
      return { ok: true, dry_run: true };
    },
    validateDryRun: async () => ({ ok: true }),
    execute: async (argv) => {
      executes += 1;
      executeArgv.push([...argv]);
      return { ok: true };
    },
    buildReceiptRequest: async () => ({ transactionHash: `0x${"12".repeat(32)}` }),
    fetchProof: async () => ({ ok: true }),
    validateProof: async () => ({
      orderId: `0x${"34".repeat(32)}`,
      transactionHash: `0x${"12".repeat(32)}`,
      positionProofHash: `0x${"56".repeat(32)}`,
      settledAt: proofSettledAt,
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
    preparations: () => preparations,
    dryRunArgv,
    executeArgv,
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
  assert.deepEqual(result.sourcePosition, {
    transactionHash: `0x${"12".repeat(32)}`,
    orderId: `0x${"34".repeat(32)}`,
    intentHash: `0x${"cd".repeat(32)}`,
    intent: { market: { conditionId: CONDITION } },
    issuance: { version: "conviction-issuance-v1", signature: "fixture" },
    positionProofHash: `0x${"56".repeat(32)}`,
  });
  assert.ok(result.timings.paidAt < result.timings.confirmedAt);
  assert.ok(result.timings.confirmedAt < result.timings.provedAt);
  assert.equal(result.timings.paymentToProofMs, result.timings.provedAt - result.timings.paidAt);
});

test("OPEN EOA mode prepares finite allowance before payment and appends the signed mode", async () => {
  const f = fixture({ mode: "eoa" });
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
  assert.deepEqual(f.confirmations, ["wallet_preparation", "payment", "trade"]);
  assert.equal(f.preparations(), 1);
  assert.deepEqual(f.dryRunArgv, [
    ["buy", "--market-id", CONDITION, "--mode", "eoa"],
    ["buy", "--market-id", CONDITION, "--mode", "eoa"],
  ]);
  assert.deepEqual(f.executeArgv, [
    ["buy", "--market-id", CONDITION, "--mode", "eoa"],
  ]);
});

test("OPEN EOA mode rejects allowance drift before order submission", async () => {
  const f = fixture({ mode: "eoa", eoaAllowanceRaw: "1350001" });
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
    (error) => error?.code === "allowance_readback_mismatch",
  );
  assert.equal(f.executes(), 0);
});

test("OPEN EOA mode rejects a paid card whose preparation differs from the approved plan", async () => {
  const f = fixture({
    mode: "eoa",
    mutateValidated: (value) => ({
      ...value,
      walletPreparation: {
        ...value.walletPreparation,
        planHash: `0x${"88".repeat(32)}`,
      },
    }),
  });
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
    (error) => error?.code === "wallet_preparation_mismatch",
  );
  assert.equal(f.executes(), 0);
});

test("OPEN preserves one structured consent timestamp when persistence crosses a second", async () => {
  const f = fixture({ proofSettledAt: "1970-01-01T00:00:02.000Z" });
  let clock = 1_000;
  const result = await runOpenJourney({
    request,
    paymentPayer: PAYMENT_PAYER,
    buyerWallet: BUYER_WALLET,
    adapters: f.adapters,
    confirm: async (kind) => {
      if (kind === "payment") return true;
      const confirmedAt = 1_999;
      clock = 2_050;
      return { accepted: true, confirmedAt };
    },
    now: () => clock,
    trustedIssuers: [],
  });
  const confirmedEvent = result.events.find((event) => event.type === "trade_confirmed");
  assert.equal(result.confirmation.confirmedAt, 1_999);
  assert.equal(confirmedEvent.at, 1_999);
  assert.equal(result.timings.confirmedAt, 1_999);
  assert.equal(result.ordersPlaced, 1);
  assert.equal(f.executes(), 1);
});

test("an OPEN proof from the confirmation second is rejected even when otherwise valid", async () => {
  const f = fixture({ proofSettledAt: "1970-01-01T00:00:01.999Z" });
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
    (error) => error?.code === "settlement_before_confirmation",
  );
  assert.equal(f.executes(), 1);
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
