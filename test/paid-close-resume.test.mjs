import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  claimCloseReplayLock,
  claimExecutionLock,
  closeReplayKey,
  resumePaidCloseJournal,
  writeReconciliationJournal,
} from "../scripts/buyer-orchestrator.mjs";
import { sha256 } from "../src/canonical.mjs";
import {
  MANAGE_SERVICE_PRICE_ATOMIC,
  SERVICE_ASSET,
  SERVICE_NETWORK,
  SERVICE_PAYEE,
} from "../src/service-payment.mjs";

const PAYER = "0x1111111111111111111111111111111111111111";
const SELLER = "0x2222222222222222222222222222222222222222";
const CONDITION = `0x${"ab".repeat(32)}`;
const TOKEN = "123456789";
const SOURCE_INTENT = `0x${"31".repeat(32)}`;
const SOURCE_PROOF = `0x${"32".repeat(32)}`;
const SOURCE_TX = `0x${"33".repeat(32)}`;
const SOURCE_ORDER = `0x${"34".repeat(32)}`;
const PAYMENT_TX = `0x${"35".repeat(32)}`;
const CLOSE_INTENT = `0x${"36".repeat(32)}`;
const CLOSE_TX = `0x${"37".repeat(32)}`;
const CLOSE_ORDER = `0x${"38".repeat(32)}`;
const CLOSE_PROOF = `0x${"39".repeat(32)}`;
const CLOSE_PASSPORT = `0x${"40".repeat(32)}`;
const NOW = 1_100_000;

const sourcePosition = {
  intentHash: SOURCE_INTENT,
  positionProofHash: SOURCE_PROOF,
  transactionHash: SOURCE_TX,
  orderId: SOURCE_ORDER,
  intent: {
    version: "conviction-intent-v4",
    market: { conditionId: CONDITION, outcomeTokenId: TOKEN },
  },
  issuance: { version: "conviction-issuance-v1", signature: "fixture" },
};

const request = {
  market: "fixture-market",
  outcome: "YES",
  shares: "5",
  minPrice: "0.26",
  rationale: "Bounded fixture close",
  sourceIntentHash: SOURCE_INTENT,
  sourcePositionProofHash: SOURCE_PROOF,
  sourcePosition,
};

const executionArgv = [
  "sell", "--market-id", CONDITION, "--token-id", TOKEN,
  "--outcome", "yes", "--shares", "5", "--price", "0.26",
  "--order-type", "FOK",
];

const verifiedSource = {
  intentHash: SOURCE_INTENT,
  positionProofHash: SOURCE_PROOF,
  transactionHash: SOURCE_TX,
  orderId: SOURCE_ORDER,
  wallet: SELLER,
  marketConditionId: CONDITION,
  outcome: "YES",
  outcomeTokenId: TOKEN,
  actualSharesRaw: "5000000",
  intentVersion: "conviction-intent-v4",
  verificationMode: "signed-intent-window",
};

const validatedCard = {
  wallet: SELLER,
  outcome: "YES",
  tokenId: TOKEN,
  intentHash: CLOSE_INTENT,
  expiresAt: "1970-01-01T00:21:40.000Z",
  intent: {
    market: { conditionId: CONDITION, question: "Fixture market?" },
    source: verifiedSource,
  },
  issuanceVerification: {
    keyId: "fixture-key",
    fingerprint: "sha256:fixture",
    issuedAt: "1970-01-01T00:17:20.000Z",
  },
  executionCard: { argv: executionArgv },
  bounds: {
    sharesRaw: "5000000",
    minPrice: "0.26",
    minimumGrossProceedsRaw: "1300000",
    maximumFeeRaw: "0",
    minimumNetProceedsRaw: "1300000",
  },
};

const paymentProof = {
  version: "conviction-x402-payment-v1",
  chainId: 196,
  transactionHash: PAYMENT_TX,
  blockNumber: "100",
  blockHash: `0x${"41".repeat(32)}`,
  blockTimestamp: "1000",
  asset: SERVICE_ASSET,
  payer: PAYER,
  payee: SERVICE_PAYEE,
  amountAtomic: MANAGE_SERVICE_PRICE_ATOMIC,
  logIndex: "0x1",
  checks: {
    transactionSucceeded: true,
    receiptBoundToBlock: true,
    freshPayment: true,
    exactAsset: true,
    exactPayer: true,
    exactPayee: true,
    exactAmount: true,
  },
};

function adapters(overrides = {}) {
  const calls = {
    paymentVerifications: 0,
    sourceVerifications: 0,
    executions: 0,
    dryRuns: 0,
  };
  return {
    calls,
    value: {
      verifyPayment: async () => {
        calls.paymentVerifications += 1;
        return { ok: true, proof: structuredClone(paymentProof) };
      },
      verifySourcePosition: async () => {
        calls.sourceVerifications += 1;
        return structuredClone(verifiedSource);
      },
      validateCloseCard: async () => structuredClone(validatedCard),
      ensureTradingMode: async () => ({ mode: "deposit-wallet" }),
      checkCloseReadiness: async () => ({
        accessible: true,
        clobVersion: "V2",
        currentMode: "deposit_wallet",
        paymentPayer: PAYER,
        buyerWallet: SELLER,
        tradingAddress: SELLER,
        outcomeTokenId: TOKEN,
        outcomeBalanceRaw: "5000000",
        approvedForExchange: true,
        reservedSharesRaw: "0",
        openSellOrderCount: 0,
      }),
      dryRun: async () => {
        calls.dryRuns += 1;
        return { ok: true, dry_run: true };
      },
      validateCloseDryRun: async () => ({ ok: true }),
      execute: async (_argv, executionOptions = {}) => {
        executionOptions.onStart?.();
        calls.executions += 1;
        return { ok: true, data: { order_id: CLOSE_ORDER, tx_hashes: [CLOSE_TX] } };
      },
      buildCloseReceiptRequest: async () => ({
        transactionHash: CLOSE_TX,
        orderId: CLOSE_ORDER,
        intentHash: CLOSE_INTENT,
        intent: { fixture: true },
        issuance: { fixture: true },
      }),
      fetchCloseProof: async () => ({ ok: true }),
      validateCloseProof: async () => ({
        orderId: CLOSE_ORDER,
        transactionHash: CLOSE_TX,
        closeProofHash: CLOSE_PROOF,
        closePassportHash: CLOSE_PASSPORT,
        settledAt: "1970-01-01T00:18:30.000Z",
      }),
      ...overrides,
    },
  };
}

async function fixture({ mutateState, adapterOverrides } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "conviction-paid-close-resume-"));
  const journal = join(directory, "journey.json");
  const replayKey = closeReplayKey({ request, sellerWallet: SELLER });
  const replayLockPath = await claimCloseReplayLock({ key: replayKey, journal, directory });
  const confirmedAt = "1970-01-01T00:17:30.000Z";
  const state = {
    mode: "close",
    stage: "trade_confirmed",
    paymentTx: PAYMENT_TX,
    intentHash: CLOSE_INTENT,
    orderId: null,
    settlementTx: null,
    closeProofHash: null,
    closePassportHash: null,
    sourceIntentHash: SOURCE_INTENT,
    sourcePositionProofHash: SOURCE_PROOF,
    sourcePosition,
    paidCard: { ok: true, fixture: "signed-close-card" },
    liveResult: null,
    paymentProof,
    paymentRequestedAt: "1970-01-01T00:16:30.000Z",
    paymentAuthorization: {
      version: "conviction-x402-authorization-v1",
      scheme: "exact-eip3009",
      network: SERVICE_NETWORK,
      asset: SERVICE_ASSET,
      from: PAYER,
      to: SERVICE_PAYEE,
      value: MANAGE_SERVICE_PRICE_ATOMIC,
      validAfter: "900",
      validBefore: "1200",
      nonce: `0x${"42".repeat(32)}`,
    },
    paidServiceResponse: { status: 200, paymentResponsePresent: true },
    request,
    paymentPayer: PAYER,
    buyerWallet: SELLER,
    tradeConfirmedAt: confirmedAt,
    tradeConsent: {
      version: "conviction-close-trade-consent-v1",
      intentHash: CLOSE_INTENT,
      executionArgvHash: sha256(executionArgv),
      paymentTx: PAYMENT_TX,
      replayKey,
      confirmedAt,
      expiresAt: validatedCard.expiresAt,
    },
    executionArgv: null,
    executionArgvHash: null,
    replayKey,
    replayLockPath,
    executionLockPath: null,
    reconciliationRequired: true,
    journalPath: journal,
  };
  if (mutateState) mutateState(state);
  await writeReconciliationJournal(state, { directory, file: journal });
  const configured = adapters(adapterOverrides);
  return { directory, journal, replayLockPath, state, ...configured };
}

async function run(f) {
  return resumePaidCloseJournal({
    file: f.journal,
    trustedIssuers: new Map(),
    adapters: f.value,
    now: () => NOW,
    stateDirectory: f.directory,
  });
}

test("paid CLOSE resume reverifies everything, never pays again, and executes exactly once", async () => {
  const f = await fixture();
  try {
    const result = await run(f);
    assert.equal(result.status, "complete_resumed");
    assert.equal(result.ordersPlaced, 1);
    assert.equal(result.timings.paymentToProofMs, 110_000);
    assert.equal(f.calls.paymentVerifications, 1);
    assert.equal(f.calls.sourceVerifications, 1);
    assert.equal(f.calls.dryRuns, 1);
    assert.equal(f.calls.executions, 1);
    assert.equal("payAndRequestCard" in f.value, false);
    assert.deepEqual(await readdir(f.directory), ["journey.json"]);
    const completed = JSON.parse(await readFile(f.journal, "utf8"));
    assert.equal(completed.stage, "complete_resumed");
    assert.equal(completed.reconciliationRequired, false);
    assert.equal(completed.replayLockPath, null);
    assert.equal(completed.executionLockPath, null);
    assert.equal(completed.executionArgvHash, sha256(executionArgv));
    assert.equal(completed.settlementTx, CLOSE_TX);
  } finally {
    await rm(f.directory, { recursive: true, force: true });
  }
});

test("paid CLOSE resume retains both locks when settlement shares the confirmation second", async () => {
  const f = await fixture({
    adapterOverrides: {
      validateCloseProof: async () => ({
        orderId: CLOSE_ORDER,
        transactionHash: CLOSE_TX,
        closeProofHash: CLOSE_PROOF,
        closePassportHash: CLOSE_PASSPORT,
        settledAt: "1970-01-01T00:17:30.999Z",
      }),
    },
  });
  try {
    await assert.rejects(run(f), (error) => error?.code === "settlement_before_confirmation");
    assert.equal(f.calls.executions, 1);
    const ambiguous = JSON.parse(await readFile(f.journal, "utf8"));
    assert.equal(ambiguous.stage, "live_result_received");
    assert.equal(ambiguous.reconciliationRequired, true);
    assert.equal(ambiguous.resumeError.code, "settlement_before_confirmation");
    assert.equal(ambiguous.resumeError.executionAmbiguous, true);
    assert.equal(ambiguous.replayLockPath, f.replayLockPath);
    assert.match(ambiguous.executionLockPath, /polymarket-execution\.lock\.json$/);
    assert.deepEqual((await readdir(f.directory)).sort(), [
      `close-${ambiguous.replayKey.slice(2)}.lock.json`,
      "journey.json",
      "polymarket-execution.lock.json",
    ]);
  } finally {
    await rm(f.directory, { recursive: true, force: true });
  }
});

test("paid CLOSE resume rejects any non-exact or already-attempted checkpoint before execution", async () => {
  for (const mutateState of [
    (state) => { state.stage = "payment_verified"; },
    (state) => { state.executionArgvHash = sha256(executionArgv); },
    (state) => { state.tradeConsent.executionArgvHash = `0x${"99".repeat(32)}`; },
    (state) => { state.paymentRequestedAt = null; },
  ]) {
    const f = await fixture({ mutateState });
    try {
      await assert.rejects(run(f));
      assert.equal(f.calls.executions, 0);
      assert.equal(f.calls.paymentVerifications <= 1, true);
    } finally {
      await rm(f.directory, { recursive: true, force: true });
    }
  }
});

test("paid CLOSE resume retains both locks and fails closed after an ambiguous live call", async () => {
  const f = await fixture({
    adapterOverrides: {
      execute: async (_argv, executionOptions = {}) => {
        executionOptions.onStart?.();
        f.calls.executions += 1;
        throw Object.assign(new Error("connection closed after submission"), { code: "tool_failed" });
      },
    },
  });
  try {
    await assert.rejects(run(f), (error) => error?.code === "tool_failed");
    assert.equal(f.calls.executions, 1);
    const ambiguous = JSON.parse(await readFile(f.journal, "utf8"));
    assert.equal(ambiguous.stage, "execution_attempted");
    assert.equal(ambiguous.reconciliationRequired, true);
    assert.equal(ambiguous.resumeError.executionAmbiguous, true);
    assert.equal(ambiguous.executionArgvHash, sha256(executionArgv));
    assert.equal((await readdir(f.directory)).length, 3);
    await assert.rejects(run(f), (error) => error?.code === "invalid_resume_checkpoint" || error?.code === "ambiguous_execution");
    assert.equal(f.calls.executions, 1);
  } finally {
    await rm(f.directory, { recursive: true, force: true });
  }
});

test("paid CLOSE resume releases only its execution lock when a locked dry run fails", async () => {
  const f = await fixture({
    adapterOverrides: {
      validateCloseDryRun: async () => {
        throw Object.assign(new Error("dry-run crossed bound"), { code: "plugin_mismatch" });
      },
    },
  });
  try {
    await assert.rejects(run(f), (error) => error?.code === "plugin_mismatch");
    const retryable = JSON.parse(await readFile(f.journal, "utf8"));
    assert.equal(retryable.stage, "trade_confirmed");
    assert.equal(retryable.executionLockPath, null);
    assert.equal(retryable.replayLockPath, f.replayLockPath);
    assert.equal(f.calls.executions, 0);
    assert.deepEqual((await readdir(f.directory)).sort(), [
      `close-${retryable.replayKey.slice(2)}.lock.json`,
      "journey.json",
    ]);
  } finally {
    await rm(f.directory, { recursive: true, force: true });
  }
});

test("paid CLOSE resume rechecks expiry after its durable marker and releases an unstarted execution lock", async () => {
  let current = NOW;
  let validations = 0;
  const f = await fixture({
    adapterOverrides: {
      validateCloseCard: async () => {
        validations += 1;
        if (validations === 4) current = Date.parse(validatedCard.expiresAt) - 9_999;
        return structuredClone(validatedCard);
      },
    },
  });
  try {
    await assert.rejects(
      resumePaidCloseJournal({
        file: f.journal,
        trustedIssuers: new Map(),
        adapters: f.value,
        now: () => current,
        stateDirectory: f.directory,
      }),
      (error) => error?.code === "insufficient_execution_window",
    );
    assert.equal(f.calls.executions, 0);
    const retryable = JSON.parse(await readFile(f.journal, "utf8"));
    assert.equal(retryable.stage, "trade_confirmed");
    assert.equal(retryable.executionArgv, null);
    assert.equal(retryable.executionArgvHash, null);
    assert.equal(retryable.executionAttemptedAt, null);
    assert.equal(retryable.executionLockPath, null);
    assert.equal(retryable.replayLockPath, f.replayLockPath);
  } finally {
    await rm(f.directory, { recursive: true, force: true });
  }
});

test("paid CLOSE resume fails before execution on fresh payment, source, card, or position drift", async () => {
  const cases = [
    {
      code: "payment_proof_mismatch",
      overrides: {
        verifyPayment: async () => ({
          ok: true,
          proof: { ...structuredClone(paymentProof), amountAtomic: "100001" },
        }),
      },
    },
    {
      code: "source_substitution",
      overrides: {
        verifySourcePosition: async () => ({ ...structuredClone(verifiedSource), outcome: "NO" }),
      },
    },
    {
      code: "token_substitution",
      overrides: {
        validateCloseCard: async () => ({ ...structuredClone(validatedCard), tokenId: "987654321" }),
      },
    },
    {
      code: "position_reserved",
      overrides: {
        checkCloseReadiness: async () => ({
          accessible: true,
          clobVersion: "V2",
          currentMode: "deposit_wallet",
          paymentPayer: PAYER,
          buyerWallet: SELLER,
          tradingAddress: SELLER,
          outcomeTokenId: TOKEN,
          outcomeBalanceRaw: "5000000",
          approvedForExchange: true,
          reservedSharesRaw: "1000000",
          openSellOrderCount: 1,
        }),
      },
    },
  ];
  for (const entry of cases) {
    const f = await fixture({ adapterOverrides: entry.overrides });
    try {
      await assert.rejects(run(f), (error) => error?.code === entry.code);
      assert.equal(f.calls.executions, 0);
    } finally {
      await rm(f.directory, { recursive: true, force: true });
    }
  }
});

test("paid CLOSE resume refuses a replay lock owned by another journal", async () => {
  const f = await fixture();
  try {
    await writeFile(f.replayLockPath, JSON.stringify({
      version: "conviction-close-replay-lock-v1",
      replayKey: f.state.replayKey,
      journalPath: join(f.directory, "someone-else.json"),
    }));
    await assert.rejects(run(f), (error) => error?.code === "lock_ownership_mismatch");
    assert.equal(f.calls.paymentVerifications, 0);
    assert.equal(f.calls.executions, 0);
  } finally {
    await rm(f.directory, { recursive: true, force: true });
  }
});

test("paid CLOSE resume never overwrites a checkpoint that changed while taking the execution lock", async () => {
  const f = await fixture();
  try {
    const completedByOtherProcess = {
      ...f.state,
      stage: "complete_resumed",
      reconciliationRequired: false,
      replayLockPath: null,
    };
    await assert.rejects(
      resumePaidCloseJournal({
        file: f.journal,
        trustedIssuers: new Map(),
        adapters: f.value,
        now: () => NOW,
        stateDirectory: f.directory,
        claimExecutionLockImpl: async (options) => {
          const executionLock = await claimExecutionLock(options);
          await writeReconciliationJournal(completedByOtherProcess, {
            directory: f.directory,
            file: f.journal,
          });
          return executionLock;
        },
      }),
      (error) => error?.code === "resume_checkpoint_changed",
    );
    assert.equal(f.calls.executions, 0);
    const preserved = JSON.parse(await readFile(f.journal, "utf8"));
    assert.equal(preserved.stage, "complete_resumed");
    assert.equal(preserved.reconciliationRequired, false);
    assert.equal((await readdir(f.directory)).includes("polymarket-execution.lock.json"), false);
  } finally {
    await rm(f.directory, { recursive: true, force: true });
  }
});

test("paid CLOSE resume does not mutate its journal when another execution owns the global lock", async () => {
  const f = await fixture();
  const executionFile = join(f.directory, "polymarket-execution.lock.json");
  try {
    await claimExecutionLock({
      journal: join(f.directory, "other-journey.json"),
      directory: f.directory,
      file: executionFile,
    });
    const before = await readFile(f.journal, "utf8");
    await assert.rejects(run(f), (error) => error?.code === "execution_reconciliation_required");
    assert.equal(await readFile(f.journal, "utf8"), before);
    assert.equal(f.calls.executions, 0);
  } finally {
    await rm(f.directory, { recursive: true, force: true });
  }
});
