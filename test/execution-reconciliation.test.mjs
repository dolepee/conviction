import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile as fsWriteFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const writeFile = (file, data, options = {}) => fsWriteFile(file, data, { ...options, mode: 0o600 });

import { sha256 } from "../src/canonical.mjs";
import {
  claimVerifiedPaymentTransaction,
  closeReplayKey,
  reconcileCloseJournal,
  reconcileOpenJournal,
} from "../scripts/buyer-orchestrator.mjs";
import {
  POSITION_CARD_SERVICE,
  POSITION_MANAGER_SERVICE,
  SERVICE_ASSET,
  SERVICE_NETWORK,
  SERVICE_PAYEE,
} from "../src/service-payment.mjs";

const NOW = Date.parse("2026-07-22T02:00:10.000Z");
const SIGNER = "0x1111111111111111111111111111111111111111";
const WALLET = "0x2222222222222222222222222222222222222222";
const CONDITION = `0x${"33".repeat(32)}`;
const INTENT = `0x${"44".repeat(32)}`;
const ORDER = `0x${"55".repeat(32)}`;
const SETTLEMENT = `0x${"66".repeat(32)}`;
const POSITION_PROOF = `0x${"77".repeat(32)}`;
const TOKEN = "123456789";
const OPEN_REPLAY = `0x${"99".repeat(32)}`;
const PAYMENT_TX = `0x${"11".repeat(32)}`;
const PAYMENT_NONCE = `0x${"12".repeat(32)}`;
const PAYMENT_BLOCK_TIMESTAMP = String(Date.parse("2026-07-22T02:00:00.000Z") / 1_000);
const PAYMENT_CLAIM_FILE = `payment-${PAYMENT_TX.slice(2)}.lock.json`;

const OPEN_ARGV = [
  "buy", "--market-id", CONDITION, "--token-id", TOKEN,
  "--outcome", "yes", "--amount", "1.12", "--price", "0.14", "--order-type", "FAK",
];
const CLOSE_ARGV = [
  "sell", "--market-id", CONDITION, "--token-id", TOKEN,
  "--outcome", "yes", "--shares", "5", "--price", "0.26", "--order-type", "FOK",
];

function validated(action = "OPEN") {
  return {
    intentHash: INTENT,
    wallet: WALLET,
    outcome: "YES",
    tokenId: TOKEN,
    expiresAt: "2026-07-22T02:05:00.000Z",
    intent: {
      version: action === "OPEN" ? "conviction-intent-v4" : "conviction-exit-intent-v1",
      market: { conditionId: CONDITION },
      snapshot: { capturedAt: "2026-07-22T02:00:00.000Z" },
    },
    issuance: { version: "fixture" },
    executionCard: { argv: action === "OPEN" ? OPEN_ARGV : CLOSE_ARGV },
    bounds: action === "OPEN"
      ? { maxPrice: "0.140000", fullFillSharesRaw: "8000000" }
      : { minPrice: "0.260000", sharesRaw: "5000000" },
  };
}

function live(validatedCard, action = "OPEN") {
  return {
    ok: true,
    validated: validatedCard,
    orderId: ORDER,
    status: "unmatched",
    reportedSharesRaw: action === "OPEN" ? "8000000" : "5000000",
    result: { order_id: ORDER, status: "unmatched", tx_hashes: [] },
  };
}

function exactSnapshot(action = "OPEN", overrides = {}) {
  return {
    version: "conviction-polymarket-order-snapshot-v1",
    verificationSource: "authenticated-polymarket-clob",
    onChain: false,
    fetchedAt: "2026-07-22T02:00:10.000Z",
    signerAddress: SIGNER,
    depositWallet: WALLET,
    credentialOwnerVerified: true,
    order: {
      id: ORDER,
      status: "CANCELED",
      market: CONDITION,
      assetId: TOKEN,
      side: action === "OPEN" ? "BUY" : "SELL",
      originalSize: action === "OPEN" ? "8000000" : "5000000",
      sizeMatched: "0",
      price: action === "OPEN" ? "0.14" : "0.26",
      orderType: action === "OPEN" ? "FAK" : "FOK",
      expiration: "0",
      outcome: "YES",
      createdAt: String(Date.parse("2026-07-22T02:00:09.000Z") / 1_000),
      associatedTrades: [],
      ...overrides,
    },
  };
}

function paymentService(mode) {
  return mode === "open" ? POSITION_CARD_SERVICE : POSITION_MANAGER_SERVICE;
}

function exactPaymentProof(mode) {
  const service = paymentService(mode);
  return {
    version: "conviction-x402-payment-v1",
    chainId: 196,
    transactionHash: PAYMENT_TX,
    blockNumber: "65800000",
    blockHash: `0x${"13".repeat(32)}`,
    blockTimestamp: PAYMENT_BLOCK_TIMESTAMP,
    asset: SERVICE_ASSET,
    payer: SIGNER,
    payee: SERVICE_PAYEE,
    amountAtomic: service.priceAtomic,
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
}

function exactPaymentAuthorization(mode) {
  const service = paymentService(mode);
  return {
    version: "conviction-x402-authorization-v1",
    scheme: "exact-eip3009",
    network: SERVICE_NETWORK,
    asset: SERVICE_ASSET,
    from: SIGNER,
    to: SERVICE_PAYEE,
    value: service.priceAtomic,
    validAfter: String(BigInt(PAYMENT_BLOCK_TIMESTAMP) - 1n),
    validBefore: String(BigInt(PAYMENT_BLOCK_TIMESTAMP) + 299n),
    nonce: PAYMENT_NONCE,
  };
}

function baseLiveState({ mode, journal, executionLock, executionArgv }) {
  return {
    mode,
    stage: "live_result_received",
    journalPath: journal,
    reconciliationRequired: true,
    paymentPayer: SIGNER,
    buyerWallet: WALLET,
    paymentTx: PAYMENT_TX,
    paymentProof: exactPaymentProof(mode),
    paymentAuthorization: exactPaymentAuthorization(mode),
    paidServiceResponse: { status: 200, paymentResponsePresent: true },
    paymentClaimPath: null,
    paymentClaimHash: null,
    paidCard: { fixture: mode },
    intentHash: INTENT,
    tradeConfirmedAt: "2026-07-22T02:00:08.000Z",
    executionArgv,
    executionArgvHash: sha256(executionArgv),
    executionLockPath: executionLock,
    ...(mode === "open" ? {
      replayKey: OPEN_REPLAY,
      replayLockPath: join(join(journal, ".."), `open-${OPEN_REPLAY.slice(2)}.lock.json`),
    } : {}),
    liveResult: { fixture: "live" },
    orderId: ORDER,
    settlementTx: null,
  };
}

async function writeExecutionLock(executionLock, journal) {
  await writeFile(executionLock, JSON.stringify({
    version: "conviction-polymarket-execution-lock-v1",
    journalPath: journal,
  }));
}

async function writePaidJournalWithClaim(state, directory) {
  await writeFile(state.journalPath, JSON.stringify(state));
  const claimed = await claimVerifiedPaymentTransaction({
    state,
    paymentProof: state.paymentProof,
    service: paymentService(state.mode),
    directory,
  });
  state.paymentClaimPath = claimed.file;
  state.paymentClaimHash = claimed.claimHash;
  await writeFile(state.journalPath, JSON.stringify(state));
  return claimed;
}

async function writeOpenReplayLock(state) {
  await writeFile(state.replayLockPath, JSON.stringify({
    version: "conviction-open-replay-lock-v1",
    replayKey: state.replayKey,
    journalPath: state.journalPath,
  }));
}

test("OPEN reconciliation independently verifies a persisted settlement and releases only its execution lock", async () => {
  const directory = await mkdtemp(join(tmpdir(), "conviction-open-settlement-reconcile-"));
  const journal = join(directory, "journey.json");
  const executionLock = join(directory, "polymarket-execution.lock.json");
  const card = validated("OPEN");
  const state = {
    ...baseLiveState({ mode: "open", journal, executionLock, executionArgv: OPEN_ARGV }),
    settlementTx: SETTLEMENT,
  };
  try {
    await writePaidJournalWithClaim(state, directory);
    await Promise.all([
      writeExecutionLock(executionLock, journal),
      writeOpenReplayLock(state),
    ]);
    let proofReads = 0;
    const result = await reconcileOpenJournal({
      file: journal,
      trustedIssuers: new Map(),
      now: NOW,
      stateDirectory: directory,
      validateCardImpl: () => card,
      buildReceiptRequestImpl: () => ({
        orderId: ORDER,
        transactionHash: SETTLEMENT,
        intentHash: INTENT,
        intent: card.intent,
        issuance: card.issuance,
      }),
      async verifyPosition(transactionHash, expected) {
        proofReads += 1;
        assert.equal(transactionHash, SETTLEMENT);
        assert.equal(expected.orderId, ORDER);
        return {
          independent: true,
          positionProof: { settledAt: "2026-07-22T02:00:09.000Z" },
        };
      },
      validateProofImpl: () => ({
        orderId: ORDER,
        transactionHash: SETTLEMENT,
        positionProofHash: POSITION_PROOF,
        positionPassportHash: `0x${"88".repeat(32)}`,
      }),
    });
    assert.equal(proofReads, 1);
    assert.equal(result.status, "complete_reconciled");
    assert.equal(result.positionProofHash, POSITION_PROOF);
    assert.deepEqual((await readdir(directory)).sort(), ["journey.json", PAYMENT_CLAIM_FILE].sort());
    const persisted = JSON.parse(await readFile(journal, "utf8"));
    assert.equal(persisted.executionLockPath, null);
    assert.equal(persisted.reconciliationRequired, false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("OPEN reconciliation rejects a valid signed settlement that predates live-trade confirmation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "conviction-open-preconfirm-reconcile-"));
  const journal = join(directory, "journey.json");
  const executionLock = join(directory, "polymarket-execution.lock.json");
  const card = validated("OPEN");
  const state = {
    ...baseLiveState({ mode: "open", journal, executionLock, executionArgv: OPEN_ARGV }),
    settlementTx: SETTLEMENT,
  };
  try {
    await writePaidJournalWithClaim(state, directory);
    await Promise.all([
      writeExecutionLock(executionLock, journal),
      writeOpenReplayLock(state),
    ]);
    await assert.rejects(reconcileOpenJournal({
      file: journal,
      trustedIssuers: new Map(),
      now: NOW,
      stateDirectory: directory,
      validateCardImpl: () => card,
      buildReceiptRequestImpl: () => ({
        orderId: ORDER,
        transactionHash: SETTLEMENT,
        intentHash: INTENT,
        intent: card.intent,
        issuance: card.issuance,
      }),
      verifyPosition: async () => ({
        positionProof: { settledAt: "2026-07-22T02:00:07.000Z" },
      }),
      validateProofImpl: () => {
        throw new Error("must not validate a pre-confirmation settlement");
      },
    }), (error) => error?.code === "settlement_before_confirmation");
    assert.deepEqual((await readdir(directory)).sort(), [
      `open-${OPEN_REPLAY.slice(2)}.lock.json`,
      "journey.json",
      PAYMENT_CLAIM_FILE,
      "polymarket-execution.lock.json",
    ].sort());
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("CLOSE settlement reconciliation requires a strictly later settlement second", async () => {
  for (const { settledAt, succeeds } of [
    { settledAt: "2026-07-22T02:00:08.999Z", succeeds: false },
    { settledAt: "2026-07-22T02:00:09.000Z", succeeds: true },
  ]) {
    const directory = await mkdtemp(join(tmpdir(), "conviction-close-settlement-reconcile-"));
    const journal = join(directory, "journey.json");
    const executionLock = join(directory, "polymarket-execution.lock.json");
    const replayKey = `0x${"aa".repeat(32)}`;
    const replayLock = join(directory, `close-${replayKey.slice(2)}.lock.json`);
    const state = {
      ...baseLiveState({ mode: "close", journal, executionLock, executionArgv: CLOSE_ARGV }),
      paidCard: {
        intent: { version: "conviction-exit-intent-v1" },
        intentHash: INTENT,
        issuance: { version: "fixture" },
      },
      settlementTx: SETTLEMENT,
      replayKey,
      replayLockPath: replayLock,
    };
    try {
      await writePaidJournalWithClaim(state, directory);
      await Promise.all([
        writeExecutionLock(executionLock, journal),
        writeFile(replayLock, JSON.stringify({
          version: "conviction-close-replay-lock-v1",
          replayKey,
          journalPath: journal,
        })),
      ]);
      const reconcile = reconcileCloseJournal({
        file: journal,
        trustedIssuers: new Map(),
        now: NOW,
        stateDirectory: directory,
        verifyClose: async () => ({
          closeProof: { transactionHash: SETTLEMENT, settledAt },
          closeProofHash: `0x${"bb".repeat(32)}`,
          closePassportHash: `0x${"cc".repeat(32)}`,
        }),
      });
      if (!succeeds) {
        await assert.rejects(reconcile, (error) => error?.code === "settlement_before_confirmation");
        assert.deepEqual((await readdir(directory)).sort(), [
          `close-${replayKey.slice(2)}.lock.json`,
          "journey.json",
          PAYMENT_CLAIM_FILE,
          "polymarket-execution.lock.json",
        ].sort());
        continue;
      }
      const result = await reconcile;
      assert.equal(result.status, "complete_reconciled");
      assert.equal(result.transactionHash, SETTLEMENT);
      assert.deepEqual((await readdir(directory)).sort(), ["journey.json", PAYMENT_CLAIM_FILE].sort());
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
});

test("OPEN terminal zero-fill reconciliation requires exact owner-bound CLOB proof and never retries", async () => {
  const directory = await mkdtemp(join(tmpdir(), "conviction-open-zero-reconcile-"));
  const journal = join(directory, "journey.json");
  const executionLock = join(directory, "polymarket-execution.lock.json");
  const card = validated("OPEN");
  const state = baseLiveState({ mode: "open", journal, executionLock, executionArgv: OPEN_ARGV });
  try {
    await writePaidJournalWithClaim(state, directory);
    await Promise.all([
      writeExecutionLock(executionLock, journal),
      writeOpenReplayLock(state),
    ]);
    let exactReads = 0;
    const result = await reconcileOpenJournal({
      file: journal,
      trustedIssuers: new Map(),
      now: NOW,
      stateDirectory: directory,
      validateCardImpl: () => card,
      validateTerminalResultImpl: () => live(card, "OPEN"),
      async fetchExactOrderImpl(input) {
        exactReads += 1;
        assert.deepEqual(input, {
          signerAddress: SIGNER,
          depositWallet: WALLET,
          orderId: ORDER,
          outcomeTokenId: TOKEN,
        });
        return exactSnapshot("OPEN");
      },
    });
    assert.equal(exactReads, 1);
    assert.equal(result.status, "terminal_zero_fill_reconciled");
    assert.equal(result.matchedSharesRaw, "0");
    assert.deepEqual((await readdir(directory)).sort(), ["journey.json", PAYMENT_CLAIM_FILE].sort());
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("OPEN reconciliation retains its lock when terminal evidence is active or temporally substituted", async () => {
  for (const orderMutation of [
    { status: "LIVE" },
    { createdAt: String(Date.parse("2026-07-22T02:00:08.000Z") / 1_000) },
  ]) {
    const directory = await mkdtemp(join(tmpdir(), "conviction-open-zero-adversarial-"));
    const journal = join(directory, "journey.json");
    const executionLock = join(directory, "polymarket-execution.lock.json");
    const card = validated("OPEN");
    const state = baseLiveState({ mode: "open", journal, executionLock, executionArgv: OPEN_ARGV });
    try {
      await writePaidJournalWithClaim(state, directory);
      await Promise.all([
        writeExecutionLock(executionLock, journal),
        writeOpenReplayLock(state),
      ]);
      await assert.rejects(reconcileOpenJournal({
        file: journal,
        trustedIssuers: new Map(),
        now: NOW,
        stateDirectory: directory,
        validateCardImpl: () => card,
        validateTerminalResultImpl: () => live(card, "OPEN"),
        fetchExactOrderImpl: async () => exactSnapshot("OPEN", orderMutation),
      }));
      assert.deepEqual(
        (await readdir(directory)).sort(),
        [
          "journey.json",
          `open-${OPEN_REPLAY.slice(2)}.lock.json`,
          PAYMENT_CLAIM_FILE,
          "polymarket-execution.lock.json",
        ].sort(),
      );
      const preserved = JSON.parse(await readFile(journal, "utf8"));
      assert.equal(preserved.reconciliationRequired, true);
      assert.equal(preserved.executionLockPath, executionLock);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
});

test("CLOSE terminal zero-fill reconciliation releases only its owner-bound replay and execution locks", async () => {
  const directory = await mkdtemp(join(tmpdir(), "conviction-close-zero-reconcile-"));
  const journal = join(directory, "journey.json");
  const executionLock = join(directory, "polymarket-execution.lock.json");
  const sourcePosition = {
    intentHash: `0x${"91".repeat(32)}`,
    positionProofHash: `0x${"92".repeat(32)}`,
    transactionHash: `0x${"93".repeat(32)}`,
    orderId: `0x${"94".repeat(32)}`,
    intent: { market: { conditionId: CONDITION, outcomeTokenId: TOKEN } },
  };
  const request = {
    market: "fixture-market",
    outcome: "YES",
    shares: "5",
    minPrice: "0.26",
    rationale: "fixture",
    sourceIntentHash: sourcePosition.intentHash,
    sourcePositionProofHash: sourcePosition.positionProofHash,
    sourcePosition,
  };
  const replayKey = closeReplayKey({ request: { ...request, sourcePosition }, sellerWallet: WALLET });
  const replayLock = join(directory, `close-${replayKey.slice(2)}.lock.json`);
  const card = validated("CLOSE");
  card.intent.source = {
    intentHash: sourcePosition.intentHash,
    positionProofHash: sourcePosition.positionProofHash,
    transactionHash: sourcePosition.transactionHash,
    orderId: sourcePosition.orderId,
  };
  const state = {
    ...baseLiveState({ mode: "close", journal, executionLock, executionArgv: CLOSE_ARGV }),
    request,
    sourcePosition,
    sourceIntentHash: sourcePosition.intentHash,
    sourcePositionProofHash: sourcePosition.positionProofHash,
    replayKey,
    replayLockPath: replayLock,
  };
  try {
    await writePaidJournalWithClaim(state, directory);
    await Promise.all([
      writeExecutionLock(executionLock, journal),
      writeFile(replayLock, JSON.stringify({
        version: "conviction-close-replay-lock-v1",
        replayKey,
        journalPath: journal,
      })),
    ]);
    const result = await reconcileCloseJournal({
      file: journal,
      trustedIssuers: new Map(),
      now: NOW,
      stateDirectory: directory,
      validateCardImpl: () => card,
      validateTerminalResultImpl: () => live(card, "CLOSE"),
      fetchExactOrderImpl: async () => exactSnapshot("CLOSE"),
    });
    assert.equal(result.status, "terminal_zero_fill_reconciled");
    assert.equal(result.matchedSharesRaw, "0");
    assert.deepEqual((await readdir(directory)).sort(), ["journey.json", PAYMENT_CLAIM_FILE].sort());
    const persisted = JSON.parse(await readFile(journal, "utf8"));
    assert.equal(persisted.replayLockPath, null);
    assert.equal(persisted.executionLockPath, null);
    assert.equal(persisted.reconciliationRequired, false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
