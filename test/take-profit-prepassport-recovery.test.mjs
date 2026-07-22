import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { access, chmod, mkdtemp, readFile, realpath, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { sha256 } from "../src/canonical.mjs";
import { createIntentIssuer } from "../src/intent-issuer.mjs";
import { compileTakeProfitIntent } from "../src/take-profit-intent-compiler.mjs";
import {
  claimExecutionLock,
  persistSuccessfulPaidServiceResponse,
  persistVerifiedPaidServicePayment,
  releaseReconciledLocks,
  writeReconciliationJournal,
} from "../scripts/buyer-orchestrator.mjs";
import {
  recoverPrePassportTakeProfitJournal,
  claimTakeProfitReservation,
  markTakeProfitPreSpawnFailure,
  runTakeProfitReconcileCli,
  takeProfitReplayKey,
  validatePrePassportTakeProfitJournal,
  writeTakeProfitState,
} from "../scripts/take-profit-orchestrator.mjs";
import { POSITION_MANAGER_SERVICE, SERVICE_ASSET, SERVICE_PAYEE } from "../src/service-payment.mjs";
import {
  buildTakeProfitCancelRequest,
  TAKE_PROFIT_CANCEL_CONFIRMATION,
  validateTakeProfitJournal,
} from "../src/take-profit-lifecycle.mjs";
import { fetchAndVerifyX402Payment } from "../src/x402-payment-verifier.mjs";
import { LIVE_MARKET_SNAPSHOT } from "./fixtures.mjs";

const NOW = Date.parse("2026-07-21T02:00:10.000Z");
const CONFIRMED_AT = "2026-07-21T02:00:12.000Z";
const FETCHED_AT = "2026-07-21T02:00:14.000Z";
const WALLET = "0x6a355e4971d9ac2ab97d22c3cf361d42faba33fe";
const PAYER = "0x79e23e61a754901d53e55202e311f295a85fa070";
const ORDER_ID = `0x${"b".repeat(64)}`;
const PAYMENT_TX = `0x${"c".repeat(64)}`;
const VENUE_EXPIRES_AT = "2026-07-21T03:00:00.000Z";
const VENUE_EXPIRES_UNIX = String(Date.parse(VENUE_EXPIRES_AT) / 1_000);
const { privateKey } = generateKeyPairSync("ed25519");
const issue = createIntentIssuer({
  keyId: "conviction-prepassport-recovery-test",
  privateKey,
  now: () => NOW + 1_000,
});
const trustedIssuers = [issue.issuer];
const source = Object.freeze({
  intentHash: `0x${"1".repeat(64)}`,
  positionProofHash: `0x${"2".repeat(64)}`,
  transactionHash: `0x${"3".repeat(64)}`,
  orderId: `0x${"4".repeat(64)}`,
  wallet: WALLET,
  marketConditionId: LIVE_MARKET_SNAPSHOT.conditionId,
  outcome: "YES",
  outcomeTokenId: LIVE_MARKET_SNAPSHOT.yesTokenId,
  actualSharesRaw: "10000000",
  intentVersion: "conviction-intent-v4",
  verificationMode: "signed-intent-window",
});
const sourcePosition = Object.freeze({
  intentHash: source.intentHash,
  positionProofHash: source.positionProofHash,
  transactionHash: source.transactionHash,
  orderId: source.orderId,
  intent: {
    version: "conviction-intent-v4",
    market: {
      conditionId: source.marketConditionId,
      outcomeTokenId: source.outcomeTokenId,
    },
  },
});
const position = Object.freeze({
  chainId: 137,
  wallet: WALLET,
  outcomeTokenId: LIVE_MARKET_SNAPSHOT.yesTokenId,
  balanceRaw: "10000000",
  approvedForExchange: true,
  blockNumber: "0x5666a7b",
  blockHash: `0x${"a".repeat(64)}`,
  capturedAt: "2026-07-21T02:00:09.000Z",
});

function paidCard() {
  return issue(compileTakeProfitIntent({
    action: "take_profit",
    market: LIVE_MARKET_SNAPSHOT.slug,
    outcome: "yes",
    shares: "10",
    targetPrice: "0.4",
    venueExpiresAt: VENUE_EXPIRES_AT,
    wallet: WALLET,
    rationale: "Recover only the exact persisted take-profit order.",
    source,
  }, LIVE_MARKET_SNAPSHOT, position, {
    now: NOW,
    quoteTtlMs: 300_000,
  }));
}

function liveResult(overrides = {}) {
  return {
    ok: true,
    data: {
      condition_id: LIVE_MARKET_SNAPSHOT.conditionId,
      expires: Number(VENUE_EXPIRES_UNIX),
      fee_rate_bps: 0,
      limit_price: 0.4,
      limit_price_requested: 0.4,
      market_id: LIVE_MARKET_SNAPSHOT.conditionId,
      order_type: "GTD",
      outcome: "yes",
      post_only: true,
      price_adjusted: false,
      shares: 10,
      shares_requested: 10,
      side: "SELL",
      token_id: LIVE_MARKET_SNAPSHOT.yesTokenId,
      usdc_out: 4,
      status: "live",
      order_id: ORDER_ID,
      tx_hashes: [],
      ...overrides,
    },
  };
}

function orderSnapshot(overrides = {}) {
  const orderOverrides = overrides.order || {};
  return {
    version: "conviction-polymarket-order-snapshot-v1",
    verificationSource: "authenticated-polymarket-clob",
    onChain: false,
    fetchedAt: FETCHED_AT,
    signerAddress: PAYER,
    depositWallet: WALLET,
    credentialOwnerVerified: true,
    ...overrides,
    order: {
      id: ORDER_ID,
      status: "LIVE",
      market: LIVE_MARKET_SNAPSHOT.conditionId,
      assetId: LIVE_MARKET_SNAPSHOT.yesTokenId,
      side: "SELL",
      originalSize: "10000000",
      sizeMatched: "0",
      price: "0.4",
      orderType: "GTD",
      expiration: VENUE_EXPIRES_UNIX,
      outcome: "Yes",
      createdAt: String((NOW + 3_000) / 1_000),
      associatedTrades: [],
      ...orderOverrides,
    },
  };
}

function prePassportJournal() {
  const card = paidCard();
  const request = {
    action: "take_profit",
    market: LIVE_MARKET_SNAPSHOT.slug,
    outcome: "yes",
    shares: "10",
    targetPrice: "0.4",
    venueExpiresAt: VENUE_EXPIRES_AT,
    wallet: WALLET,
    rationale: "Recover only the exact persisted take-profit order.",
    sourcePosition,
  };
  const replayKey = takeProfitReplayKey({ request: {
    outcome: request.outcome,
    shares: request.shares,
    targetPrice: request.targetPrice,
    venueExpiresAt: request.venueExpiresAt,
    sourcePosition,
  }, sellerWallet: WALLET });
  return {
    version: "conviction-take-profit-journey-v1",
    action: "TAKE_PROFIT",
    stage: "live_result_received",
    journalPath: "/private/state/example-take-profit.json",
    request,
    paymentPayer: PAYER,
    signerAddress: PAYER,
    depositWallet: WALLET,
    paymentRequestedAt: "2026-07-21T02:00:10.000Z",
    paymentAuthorization: { redacted: true },
    paymentTx: PAYMENT_TX,
    paidServiceResponse: { status: 200, paymentResponsePresent: true },
    paymentProof: {
      version: "conviction-x402-payment-v1",
      chainId: 196,
      transactionHash: PAYMENT_TX,
      blockNumber: "100",
      blockHash: `0x${"d".repeat(64)}`,
      blockTimestamp: String(NOW / 1_000),
      asset: SERVICE_ASSET,
      payer: PAYER,
      payee: SERVICE_PAYEE,
      amountAtomic: POSITION_MANAGER_SERVICE.priceAtomic,
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
    },
    paidCard: card,
    intentHash: card.intentHash,
    tradeConsent: {
      version: "conviction-take-profit-consent-v1",
      intentHash: card.intentHash,
      executionArgvHash: sha256(card.executionCard.argv),
      paymentTx: PAYMENT_TX,
      replayKey,
      confirmedAt: CONFIRMED_AT,
      placementExpiresAt: card.intent.snapshot.expiresAt,
      venueExpiresAt: VENUE_EXPIRES_AT,
    },
    replayKey,
    reservationLockPath: "/private/state/take-profit-replay.lock.json",
    executionLockPath: "/private/state/polymarket-execution.lock.json",
    executionAttempted: true,
    liveResult: liveResult(),
    orderId: ORDER_ID,
    takeProfitPassport: null,
    takeProfitPassportHash: null,
    restingOrderProofHash: null,
    reconciliationRequired: true,
  };
}

test("recovers the exact persisted order into an authenticated ARMED passport without a payment or placement path", () => {
  const original = prePassportJournal();
  const recovered = recoverPrePassportTakeProfitJournal(original, orderSnapshot(), {
    trustedIssuers,
    now: () => Date.parse(FETCHED_AT),
  });
  assert.equal(original.takeProfitPassport, null);
  assert.equal(original.stage, "live_result_received");
  assert.equal(recovered.journal.stage, "armed");
  assert.equal(recovered.journal.status, "ARMED");
  assert.equal(recovered.journal.orderId, ORDER_ID);
  assert.equal(recovered.journal.liveResult.data.order_id, ORDER_ID);
  assert.equal(recovered.journal.paymentTx, PAYMENT_TX);
  assert.equal(recovered.journal.prePassportRecovery.noPaymentOrPlacementPerformed, true);
  assert.equal(recovered.journal.reconciliationRequired, true);
  assert.equal(validateTakeProfitJournal(recovered.journal, { trustedIssuers }).orderId, ORDER_ID);
});

test("pre-passport recovery rejects missing or substituted persisted order identity before any exact fetch", () => {
  const missing = prePassportJournal();
  missing.orderId = null;
  assert.throws(
    () => validatePrePassportTakeProfitJournal(missing, { trustedIssuers, now: NOW + 4_000 }),
    (error) => error?.code === "missing_prepassport_order_id",
  );

  const substituted = prePassportJournal();
  substituted.orderId = `0x${"e".repeat(64)}`;
  assert.throws(
    () => validatePrePassportTakeProfitJournal(substituted, { trustedIssuers, now: NOW + 4_000 }),
    (error) => error?.code === "prepassport_order_mismatch",
  );

  const liveSubstitution = prePassportJournal();
  liveSubstitution.liveResult.data.token_id = LIVE_MARKET_SNAPSHOT.noTokenId;
  assert.throws(
    () => validatePrePassportTakeProfitJournal(liveSubstitution, { trustedIssuers, now: NOW + 4_000 }),
    (error) => error?.code === "plugin_mismatch",
  );
});

test("pre-passport recovery rejects consent, request, payment, and issuer substitution", () => {
  const cases = [
    [(value) => { value.tradeConsent.executionArgvHash = `0x${"e".repeat(64)}`; }, "prepassport_consent_mismatch", trustedIssuers],
    [(value) => { value.request.targetPrice = "0.41"; }, "prepassport_request_mismatch", trustedIssuers],
    [(value) => { value.paymentProof.amountAtomic = "99999"; }, "prepassport_payment_mismatch", trustedIssuers],
    [(value) => value, "untrusted_issuer", []],
  ];
  for (const [mutate, code, issuers] of cases) {
    const value = prePassportJournal();
    mutate(value);
    assert.throws(
      () => validatePrePassportTakeProfitJournal(value, { trustedIssuers: issuers, now: NOW + 4_000 }),
      (error) => error?.code === code || (code === "untrusted_issuer" && /issuer/i.test(error?.code || error?.message || "")),
    );
  }
});

test("pre-passport recovery fails closed on exact-order wallet, token, price, size, expiry, and consent-time substitution", () => {
  const cases = [
    [{ depositWallet: "0x3333333333333333333333333333333333333333" }, "order_wallet_mismatch"],
    [{ order: { id: `0x${"e".repeat(64)}` } }, "order_identity_mismatch"],
    [{ order: { assetId: LIVE_MARKET_SNAPSHOT.noTokenId } }, "order_token_mismatch"],
    [{ order: { price: "0.41" } }, "take_profit_economics_mismatch"],
    [{ order: { originalSize: "9000000" } }, "take_profit_economics_mismatch"],
    [{ order: { expiration: String(Number(VENUE_EXPIRES_UNIX) + 1) } }, "order_expiry_mismatch"],
    [{ order: { createdAt: String(Date.parse(CONFIRMED_AT) / 1_000) } }, "order_before_confirmation"],
  ];
  for (const [mutation, code] of cases) {
    assert.throws(
      () => recoverPrePassportTakeProfitJournal(prePassportJournal(), orderSnapshot(mutation), {
        trustedIssuers,
        now: () => Date.parse(FETCHED_AT),
      }),
      (error) => error?.code === code,
    );
  }
});

test("recovery accepts a post-submit expired card only for an exact order created inside its signed window", () => {
  const afterPlacementExpiry = Date.parse("2026-07-21T02:05:20.000Z");
  const recovered = recoverPrePassportTakeProfitJournal(prePassportJournal(), orderSnapshot({
    fetchedAt: "2026-07-21T02:05:15.000Z",
  }), {
    trustedIssuers,
    now: () => afterPlacementExpiry,
  });
  assert.equal(recovered.journal.status, "ARMED");

  assert.throws(
    () => recoverPrePassportTakeProfitJournal(prePassportJournal(), orderSnapshot({
      fetchedAt: "2026-07-21T02:05:15.000Z",
      order: { createdAt: String(Date.parse("2026-07-21T02:05:11.000Z") / 1_000) },
    }), {
      trustedIssuers,
      now: () => afterPlacementExpiry,
    }),
    (error) => error?.code === "order_outside_signed_window",
  );
});

async function diskFixture({
  mode = 0o600,
  journal = prePassportJournal(),
  withExecutionLock = Boolean(journal.executionLockPath),
} = {}) {
  const createdStateDirectory = await mkdtemp(join(tmpdir(), "conviction-prepassport-state-"));
  await chmod(createdStateDirectory, 0o700);
  const stateDirectory = await realpath(createdStateDirectory);
  const journalPath = join(stateDirectory, "recovery-take-profit.json");
  const issuerRegistry = join(stateDirectory, "trusted-issuers.json");
  journal.journalPath = journalPath;
  journal.executionLockPath = null;
  journal.executionLockGeneration = null;
  journal.executionLockHash = null;
  journal.executionLockPurpose = null;
  journal.executionLockRecoveryNotBefore = null;
  journal.reservationLockPath = await claimTakeProfitReservation({
    key: journal.replayKey,
    journal: journalPath,
    directory: stateDirectory,
  });
  await writeTakeProfitState(journal, { directory: stateDirectory, file: journalPath });
  const canonicalJournalPath = await realpath(journalPath);
  journal.journalPath = canonicalJournalPath;
  journal.reservationLockPath = await realpath(journal.reservationLockPath);
  if (withExecutionLock) {
    await claimExecutionLock({
        journal: canonicalJournalPath,
        directory: stateDirectory,
        file: join(stateDirectory, "polymarket-execution.lock.json"),
        state: journal,
        purpose: "TP_PLACE",
        recoveryNotBefore: journal.paidCard.intent.snapshot.expiresAt,
        now: () => NOW,
        writeState: writeTakeProfitState,
      });
  }
  await chmod(canonicalJournalPath, mode);
  await writeFile(issuerRegistry, `${JSON.stringify({ issuers: trustedIssuers }, null, 2)}\n`, { mode: 0o600 });
  return {
    stateDirectory,
    journalPath: canonicalJournalPath,
    issuerRegistry: await realpath(issuerRegistry),
    reservationLockPath: journal.reservationLockPath,
    executionLockPath: journal.executionLockPath || join(stateDirectory, "polymarket-execution.lock.json"),
  };
}

const CANCEL_CONFIRMED_AT = "2026-07-21T02:00:15.000Z";

async function cancelExecutionFixture({ attempted = false } = {}) {
  const fixture = await diskFixture();
  await runTakeProfitReconcileCli({
    journal: fixture.journalPath,
    issuerRegistry: fixture.issuerRegistry,
    json: true,
  }, {
    stateDirectory: fixture.stateDirectory,
    now: () => Date.parse(FETCHED_AT),
    fetchExactOrderImpl: async () => orderSnapshot(),
  });
  const journal = JSON.parse(await readFile(fixture.journalPath, "utf8"));
  const preCancelSnapshot = orderSnapshot();
  const request = buildTakeProfitCancelRequest({
    journal,
    snapshot: preCancelSnapshot,
    typedConfirmation: TAKE_PROFIT_CANCEL_CONFIRMATION,
    confirmedAt: CANCEL_CONFIRMED_AT,
  }, {
    trustedIssuers,
    now: Date.parse(CANCEL_CONFIRMED_AT),
  });
  await claimExecutionLock({
    journal: fixture.journalPath,
    directory: fixture.stateDirectory,
    file: fixture.executionLockPath,
    state: journal,
    purpose: "TP_CANCEL",
    recoveryNotBefore: request.launchExpiresAt,
    now: () => Date.parse(CANCEL_CONFIRMED_AT),
    writeState: writeTakeProfitState,
    transition(next, { lock, lockHash }) {
      next.cancelConsent = {
        version: "conviction-take-profit-cancel-consent-v2",
        orderId: request.orderId,
        confirmedAt: CANCEL_CONFIRMED_AT,
        launchExpiresAt: request.launchExpiresAt,
        preCancelSnapshotHash: request.preCancelSnapshotHash,
        argvHash: sha256(request.argv),
      };
      next.cancelExecution = {
        version: "conviction-take-profit-cancel-execution-v2",
        phase: "lock_acquired",
        orderId: request.orderId,
        intentHash: request.intentHash,
        takeProfitPassportHash: request.takeProfitPassportHash,
        preCancelSnapshot: structuredClone(request.preCancelSnapshot),
        preCancelSnapshotHash: request.preCancelSnapshotHash,
        argv: [...request.argv],
        argvHash: sha256(request.argv),
        confirmedAt: CANCEL_CONFIRMED_AT,
        launchExpiresAt: request.launchExpiresAt,
        lockAcquiredAt: lock.claimedAt,
        executionLockGeneration: lock.generation,
        executionLockHash: lockHash,
        attemptedAt: null,
      };
      next.reconciliationRequired = true;
    },
  });
  if (attempted) {
    const attemptedAt = new Date(Date.parse(request.launchExpiresAt) - 1).toISOString();
    journal.cancelExecution.phase = "attempted";
    journal.cancelExecution.attemptedAt = attemptedAt;
    journal.cancelAttemptedAt = attemptedAt;
    journal.cancelExecutionArgv = [...request.argv];
    await writeTakeProfitState(journal, {
      directory: fixture.stateDirectory,
      file: fixture.journalPath,
    });
  }
  return { ...fixture, journal, request, preCancelSnapshot };
}

function cancelSnapshotAt(timestamp, status = "LIVE") {
  return orderSnapshot({
    fetchedAt: new Date(timestamp).toISOString(),
    order: { status },
  });
}

async function reconcileCancelFixture(fixture, timestamp, fetchExactOrderImpl) {
  return runTakeProfitReconcileCli({
    journal: fixture.journalPath,
    issuerRegistry: fixture.issuerRegistry,
    json: true,
  }, {
    stateDirectory: fixture.stateDirectory,
    now: () => timestamp,
    fetchExactOrderImpl,
  });
}

test("TP_CANCEL A0 waits before its bounded deadline without a CLOB read or lock release", async () => {
  const fixture = await cancelExecutionFixture();
  let fetches = 0;
  try {
    const result = await reconcileCancelFixture(
      fixture,
      Date.parse(fixture.request.launchExpiresAt) - 1,
      async () => { fetches += 1; throw new Error("A0 wait must not query the venue"); },
    );
    assert.equal(result.status, "waiting_for_cancel_launch_expiry");
    assert.equal(result.executionLockReleased, false);
    assert.equal(result.reservationReleased, false);
    assert.equal(fetches, 0);
    await access(fixture.executionLockPath);
    await access(fixture.reservationLockPath);
    assert.equal(JSON.parse(await readFile(fixture.journalPath, "utf8")).cancelExecution.phase, "lock_acquired");
  } finally {
    await rm(fixture.stateDirectory, { recursive: true, force: true });
  }
});

test("TP_CANCEL expiry equality releases only the global A0 lock and replays idempotently", async () => {
  const fixture = await cancelExecutionFixture();
  let fetches = 0;
  const deadline = Date.parse(fixture.request.launchExpiresAt);
  try {
    const first = await reconcileCancelFixture(fixture, deadline, async () => {
      fetches += 1;
      throw new Error("expired A0 must not query the venue");
    });
    assert.equal(first.status, "cancel_expired_unattempted_reconciled");
    assert.equal(first.executionLockReleased, true);
    assert.equal(first.reservationReleased, false);
    assert.equal(fetches, 0);
    await assert.rejects(access(fixture.executionLockPath), (error) => error?.code === "ENOENT");
    await access(fixture.reservationLockPath);
    const durable = JSON.parse(await readFile(fixture.journalPath, "utf8"));
    assert.equal(durable.cancelExecution.phase, "expired_unattempted");
    assert.equal(durable.reconciliationRequired, false);

    const replay = await reconcileCancelFixture(fixture, deadline + 1, async () => {
      fetches += 1;
      throw new Error("terminal replay must not query the venue");
    });
    assert.equal(replay.status, "expired_unattempted");
    assert.equal(replay.reconciliationRequired, false);
    assert.equal(fetches, 0);
    await access(fixture.reservationLockPath);
  } finally {
    await rm(fixture.stateDirectory, { recursive: true, force: true });
  }
});

test("attempted TP_CANCEL never time-releases and requires authenticated terminal venue evidence", async () => {
  const fixture = await cancelExecutionFixture({ attempted: true });
  const deadline = Date.parse(fixture.request.launchExpiresAt);
  let fetches = 0;
  try {
    const unresolved = await reconcileCancelFixture(fixture, deadline + 1, async () => {
      fetches += 1;
      return cancelSnapshotAt(deadline + 1, "LIVE");
    });
    assert.equal(unresolved.reconciliationRequired, true);
    assert.equal(unresolved.executionLockReleased, false);
    assert.equal(fetches, 1);
    await access(fixture.executionLockPath);
    await access(fixture.reservationLockPath);
    assert.equal(JSON.parse(await readFile(fixture.journalPath, "utf8")).cancelExecution.phase, "attempted");

    const terminal = await reconcileCancelFixture(fixture, deadline + 2, async () => {
      fetches += 1;
      return cancelSnapshotAt(deadline + 2, "CANCELED");
    });
    assert.equal(terminal.reconciliationRequired, false);
    assert.equal(terminal.executionLockReleased, true);
    assert.equal(fetches, 2);
    await assert.rejects(access(fixture.executionLockPath), (error) => error?.code === "ENOENT");
    await access(fixture.reservationLockPath);
    const durable = JSON.parse(await readFile(fixture.journalPath, "utf8"));
    assert.equal(durable.cancelExecution.phase, "terminal");

    const replay = await reconcileCancelFixture(fixture, deadline + 3, async () => {
      fetches += 1;
      throw new Error("terminal cancel replay must not query the venue");
    });
    assert.equal(replay.status, "terminal");
    assert.equal(replay.reconciliationRequired, false);
    assert.equal(fetches, 2);
  } finally {
    await rm(fixture.stateDirectory, { recursive: true, force: true });
  }
});

test("TP_CANCEL rejects generation, snapshot, argv, and deadline substitution before any venue read", async () => {
  const cases = [
    ["generation", (journal) => { journal.cancelExecution.executionLockGeneration = "12345678-1234-4123-8123-123456789abc"; }],
    ["snapshot", (journal) => { journal.cancelExecution.preCancelSnapshot.order.price = "0.41"; }],
    ["argv", (journal) => { journal.cancelExecution.argv.push("--all"); }],
    ["deadline", (journal) => { journal.cancelExecution.launchExpiresAt = "2026-07-21T02:02:16.000Z"; }],
  ];
  for (const [label, mutate] of cases) {
    const fixture = await cancelExecutionFixture();
    let fetches = 0;
    try {
      mutate(fixture.journal);
      await writeTakeProfitState(fixture.journal, {
        directory: fixture.stateDirectory,
        file: fixture.journalPath,
      });
      await assert.rejects(
        reconcileCancelFixture(
          fixture,
          Date.parse(fixture.request.launchExpiresAt) - 1,
          async () => { fetches += 1; return fixture.preCancelSnapshot; },
        ),
        (error) => error?.code === "invalid_cancel_execution_checkpoint",
        label,
      );
      assert.equal(fetches, 0, label);
      await access(fixture.executionLockPath);
      await access(fixture.reservationLockPath);
    } finally {
      await rm(fixture.stateDirectory, { recursive: true, force: true });
    }
  }
});

test("a durable TP_CANCEL pre-spawn terminal replays without venue access and retains the reservation", async () => {
  const fixture = await cancelExecutionFixture();
  const failedAt = Date.parse(CANCEL_CONFIRMED_AT) + 1_000;
  try {
    await releaseReconciledLocks(fixture.journal, {
      stateDirectory: fixture.stateDirectory,
      journal: fixture.journalPath,
      fields: ["executionLockPath"],
      expectedLockHashes: { executionLockPath: fixture.journal.cancelExecution.executionLockHash },
      transitionId: "take-profit-cancel-known-unstarted-v2",
      writeState: writeTakeProfitState,
      now: failedAt,
      transition(next, { releasedAt }) {
        next.cancelExecution.phase = "pre_spawn_failed";
        next.cancelExecution.failedAt = releasedAt;
        next.reconciliationRequired = false;
        next.cancelError = {
          code: "simulated_pre_spawn_failure",
          at: releasedAt,
          executionAmbiguous: false,
        };
      },
    });
    let fetches = 0;
    for (const offset of [1, 2]) {
      const replay = await reconcileCancelFixture(fixture, failedAt + offset, async () => {
        fetches += 1;
        throw new Error("pre-spawn terminal replay must not query the venue");
      });
      assert.equal(replay.status, "pre_spawn_failed");
      assert.equal(replay.reconciliationRequired, false);
    }
    assert.equal(fetches, 0);
    await assert.rejects(access(fixture.executionLockPath), (error) => error?.code === "ENOENT");
    await access(fixture.reservationLockPath);
  } finally {
    await rm(fixture.stateDirectory, { recursive: true, force: true });
  }
});

test("reconcile-tp persists exact ARMED recovery before releasing only its owner-verified global lock", async () => {
  const fixture = await diskFixture();
  let exactFetches = 0;
  let writes = 0;
  const result = await runTakeProfitReconcileCli({
    journal: fixture.journalPath,
    issuerRegistry: fixture.issuerRegistry,
    json: true,
  }, {
    stateDirectory: fixture.stateDirectory,
    now: () => Date.parse(FETCHED_AT),
    fetchExactOrderImpl: async (identity) => {
      exactFetches += 1;
      assert.deepEqual(identity, {
        signerAddress: PAYER,
        depositWallet: WALLET,
        orderId: ORDER_ID,
        outcomeTokenId: LIVE_MARKET_SNAPSHOT.yesTokenId,
      });
      return orderSnapshot();
    },
    writeState: async (journal, options) => {
      writes += 1;
      if (writes === 1) {
        assert.equal(journal.stage, "armed");
        assert.equal(journal.reconciliationRequired, true);
        assert.equal(journal.executionLockPath, fixture.executionLockPath);
        await access(fixture.executionLockPath);
      }
      return writeTakeProfitState(journal, options);
    },
    releaseLocks: async (journal, options) => {
      assert.deepEqual(options.fields, ["executionLockPath"]);
      assert.equal(journal.reservationLockPath, fixture.reservationLockPath);
      return releaseReconciledLocks(journal, {
        ...options,
        beforeUnlink: async (checked) => {
          await assert.rejects(
            claimExecutionLock({
              journal: join(fixture.stateDirectory, "racing-close.json"),
              directory: fixture.stateDirectory,
              file: fixture.executionLockPath,
            }),
            (error) => error?.code === "execution_release_in_progress",
          );
          await options.beforeUnlink?.(checked);
        },
      });
    },
  });

  assert.equal(exactFetches, 1);
  assert.equal(writes, 2);
  assert.equal(result.status, "ARMED");
  assert.equal(result.reconciliationRequired, false);
  assert.equal(result.executionLockReleased, true);
  const persisted = JSON.parse(await readFile(fixture.journalPath, "utf8"));
  assert.equal(persisted.stage, "armed");
  assert.equal(persisted.takeProfitPassport.status, "ARMED");
  assert.equal(persisted.prePassportRecovery.noPaymentOrPlacementPerformed, true);
  assert.match(persisted.prePassportRecovery.executionLockReleasedAt, /^2026-07-21T02:00:14\.000Z$/);
  assert.equal(persisted.executionLockPath, null);
  assert.equal(persisted.reservationLockPath, fixture.reservationLockPath);
  assert.equal(persisted.reconciliationRequired, false);
  assert.equal(persisted.paymentTx, PAYMENT_TX);
  await assert.rejects(access(fixture.executionLockPath), (error) => error?.code === "ENOENT");
  await access(fixture.reservationLockPath);
});

test("a crash after passport persistence but before unlink retains both locks and retries without another placement", async () => {
  const fixture = await diskFixture();
  let exactFetches = 0;
  let releases = 0;
  await assert.rejects(
    runTakeProfitReconcileCli({
      journal: fixture.journalPath,
      issuerRegistry: fixture.issuerRegistry,
      json: true,
    }, {
      stateDirectory: fixture.stateDirectory,
      now: () => Date.parse(FETCHED_AT),
      fetchExactOrderImpl: async () => {
        exactFetches += 1;
        return orderSnapshot();
      },
      releaseLocks: async () => {
        releases += 1;
        const persisted = JSON.parse(await readFile(fixture.journalPath, "utf8"));
        assert.equal(persisted.stage, "armed");
        assert.equal(persisted.reconciliationRequired, true);
        await access(fixture.executionLockPath);
        await access(fixture.reservationLockPath);
        throw Object.assign(new Error("simulated crash before unlink"), { code: "simulated_pre_unlink_crash" });
      },
    }),
    (error) => error?.code === "simulated_pre_unlink_crash",
  );
  assert.equal(releases, 1);
  await access(fixture.executionLockPath);
  await access(fixture.reservationLockPath);
  const durable = JSON.parse(await readFile(fixture.journalPath, "utf8"));
  assert.equal(durable.takeProfitPassport.status, "ARMED");
  assert.equal(durable.prePassportRecovery.executionLockReleasedAt, undefined);

  const retried = await runTakeProfitReconcileCli({
    journal: fixture.journalPath,
    issuerRegistry: fixture.issuerRegistry,
    json: true,
  }, {
    stateDirectory: fixture.stateDirectory,
    now: () => Date.parse(FETCHED_AT),
    fetchExactOrderImpl: async () => {
      exactFetches += 1;
      return orderSnapshot();
    },
  });
  assert.equal(exactFetches, 2);
  assert.equal(retried.status, "ARMED");
  assert.equal(retried.reconciliationRequired, false);
  await assert.rejects(access(fixture.executionLockPath), (error) => error?.code === "ENOENT");
  await access(fixture.reservationLockPath);
});

test("a crash after unlink but before final journal write retries idempotently and retains the reservation", async () => {
  const fixture = await diskFixture();
  let writes = 0;
  await assert.rejects(
    runTakeProfitReconcileCli({
      journal: fixture.journalPath,
      issuerRegistry: fixture.issuerRegistry,
      json: true,
    }, {
      stateDirectory: fixture.stateDirectory,
      now: () => Date.parse(FETCHED_AT),
      fetchExactOrderImpl: async () => orderSnapshot(),
      writeState: async (journal, options) => {
        writes += 1;
        if (writes === 2) {
          await assert.rejects(access(fixture.executionLockPath), (error) => error?.code === "ENOENT");
          throw Object.assign(new Error("simulated crash before final journal write"), { code: "simulated_post_unlink_crash" });
        }
        return writeTakeProfitState(journal, options);
      },
    }),
    (error) => error?.code === "simulated_post_unlink_crash",
  );
  assert.equal(writes, 2);
  const durable = JSON.parse(await readFile(fixture.journalPath, "utf8"));
  assert.equal(durable.takeProfitPassport.status, "ARMED");
  assert.equal(durable.executionLockPath, fixture.executionLockPath);
  assert.equal(durable.reconciliationRequired, true);
  await assert.rejects(access(fixture.executionLockPath), (error) => error?.code === "ENOENT");
  await access(fixture.reservationLockPath);

  const retried = await runTakeProfitReconcileCli({
    journal: fixture.journalPath,
    issuerRegistry: fixture.issuerRegistry,
    json: true,
  }, {
    stateDirectory: fixture.stateDirectory,
    now: () => Date.parse(FETCHED_AT),
    fetchExactOrderImpl: async () => orderSnapshot(),
  });
  assert.equal(retried.status, "ARMED");
  assert.equal(retried.reconciliationRequired, false);
  const reconciled = JSON.parse(await readFile(fixture.journalPath, "utf8"));
  assert.equal(reconciled.executionLockPath, null);
  assert.equal(reconciled.reservationLockPath, fixture.reservationLockPath);
  await access(fixture.reservationLockPath);
});

async function leaveExactArmedReleaseGuard(fixture) {
  let writes = 0;
  await assert.rejects(
    runTakeProfitReconcileCli({
      journal: fixture.journalPath,
      issuerRegistry: fixture.issuerRegistry,
      json: true,
    }, {
      stateDirectory: fixture.stateDirectory,
      now: () => Date.parse(FETCHED_AT),
      fetchExactOrderImpl: async () => orderSnapshot(),
      writeState: async (journal, options) => {
        writes += 1;
        if (writes === 2) {
          throw Object.assign(new Error("simulated crash after guarded unlink"), {
            code: "simulated_guard_crash",
          });
        }
        return writeTakeProfitState(journal, options);
      },
    }),
    (error) => error?.code === "simulated_guard_crash",
  );
  const guardPath = join(fixture.stateDirectory, "polymarket-execution.release.lock.json");
  await assert.rejects(access(fixture.executionLockPath), (error) => error?.code === "ENOENT");
  return { guardPath, guard: JSON.parse(await readFile(guardPath, "utf8")) };
}

async function leaveCompletedArmedReleaseGuard(fixture) {
  await assert.rejects(
    runTakeProfitReconcileCli({
      journal: fixture.journalPath,
      issuerRegistry: fixture.issuerRegistry,
      json: true,
    }, {
      stateDirectory: fixture.stateDirectory,
      now: () => Date.parse(FETCHED_AT),
      fetchExactOrderImpl: async () => orderSnapshot(),
      releaseLocks: (journal, options) => releaseReconciledLocks(journal, {
        ...options,
        beforeGuardRelease: () => {
          throw Object.assign(new Error("simulated interruption after completed release"), {
            code: "simulated_completed_guard_crash",
          });
        },
      }),
    }),
    (error) => error?.code === "simulated_completed_guard_crash" && error?.releaseGuardRetained === true,
  );
  const guardPath = join(fixture.stateDirectory, "polymarket-execution.release.lock.json");
  await assert.rejects(access(fixture.executionLockPath), (error) => error?.code === "ENOENT");
  return { guardPath, guard: JSON.parse(await readFile(guardPath, "utf8")) };
}

test("reconcile resumes only an exact source, target, field set, and lock generation", async () => {
  for (const mutation of ["exact", "source", "target", "fields", "generation"]) {
    const fixture = await diskFixture();
    const { guardPath, guard } = await leaveExactArmedReleaseGuard(fixture);
    if (mutation === "source") guard.journalPath = join(fixture.stateDirectory, "foreign.json");
    if (mutation === "target") {
      guard.targetState.executionLockPath = fixture.executionLockPath;
      guard.targetJournalHash = sha256(guard.targetState);
    }
    if (mutation === "fields") guard.fields = ["executionLockPath", "reservationLockPath"];
    if (mutation === "generation") guard.lockHashes.executionLockPath = `0x${"d".repeat(64)}`;
    if (mutation !== "exact") {
      await writeFile(guardPath, `${JSON.stringify(guard, null, 2)}\n`, { mode: 0o600 });
    }

    const retry = runTakeProfitReconcileCli({
      journal: fixture.journalPath,
      issuerRegistry: fixture.issuerRegistry,
      json: true,
    }, {
      stateDirectory: fixture.stateDirectory,
      now: () => Date.parse(FETCHED_AT) + 1_000,
      fetchExactOrderImpl: async () => orderSnapshot(),
    });
    if (mutation === "exact") {
      const result = await retry;
      assert.equal(result.reconciliationRequired, false);
      await assert.rejects(access(guardPath), (error) => error?.code === "ENOENT");
      await access(fixture.reservationLockPath);
    } else {
      await assert.rejects(
        retry,
        (error) => [
          "state_release_guard_mismatch",
          "lock_generation_mismatch",
          "lock_ownership_mismatch",
        ].includes(error?.code),
      );
      await access(guardPath);
    }
  }
});

test("a completed exact release guard is cleaned before the next generation can claim", async () => {
  const fixture = await diskFixture();
  const { guardPath, guard } = await leaveCompletedArmedReleaseGuard(fixture);
  assert.equal(sha256(JSON.parse(await readFile(fixture.journalPath, "utf8"))), guard.targetJournalHash);

  const result = await runTakeProfitReconcileCli({
    journal: fixture.journalPath,
    issuerRegistry: fixture.issuerRegistry,
    json: true,
  }, {
    stateDirectory: fixture.stateDirectory,
    now: () => Date.parse(FETCHED_AT),
    fetchExactOrderImpl: async () => orderSnapshot({ order: { status: "CANCELED" } }),
  });
  assert.equal(result.reconciliationRequired, false);
  await assert.rejects(access(guardPath), (error) => error?.code === "ENOENT");
  const nextJournal = join(fixture.stateDirectory, "next-operation.json");
  const nextState = {
    journalRevision: 0,
    journalPath: nextJournal,
    stage: "trade_confirmed",
    executionLockPath: null,
    executionLockGeneration: null,
    executionLockHash: null,
    executionLockPurpose: null,
    executionLockRecoveryNotBefore: null,
    reconciliationRequired: true,
  };
  await writeReconciliationJournal(nextState, { directory: fixture.stateDirectory, file: nextJournal });
  const nextLock = await claimExecutionLock({
    journal: nextJournal,
    directory: fixture.stateDirectory,
    file: fixture.executionLockPath,
    state: nextState,
    purpose: "OPEN_PLACE",
    recoveryNotBefore: VENUE_EXPIRES_AT,
    now: () => NOW,
  });
  assert.equal(nextLock, fixture.executionLockPath);
  await unlink(nextLock);
  await access(fixture.reservationLockPath);
});

test("a missing or substituted scoped reservation blocks global-lock release", async () => {
  for (const substitution of ["missing", "foreign"]) {
    const fixture = await diskFixture();
    if (substitution === "missing") {
      await unlink(fixture.reservationLockPath);
    } else {
      const lock = JSON.parse(await readFile(fixture.reservationLockPath, "utf8"));
      lock.replayKey = `0x${"e".repeat(64)}`;
      await writeFile(fixture.reservationLockPath, `${JSON.stringify(lock, null, 2)}\n`, { mode: 0o600 });
    }
    await assert.rejects(
      runTakeProfitReconcileCli({
        journal: fixture.journalPath,
        issuerRegistry: fixture.issuerRegistry,
        json: true,
      }, {
        stateDirectory: fixture.stateDirectory,
        now: () => Date.parse(FETCHED_AT),
        fetchExactOrderImpl: async () => orderSnapshot(),
      }),
      (error) => error?.code === "reservation_ownership_mismatch",
    );
    await access(fixture.executionLockPath);
    assert.equal(JSON.parse(await readFile(fixture.journalPath, "utf8")).stage, "live_result_received");
  }
});

test("a non-owner-only execution lock is never released", async () => {
  const fixture = await diskFixture();
  await chmod(fixture.executionLockPath, 0o644);
  await assert.rejects(
    runTakeProfitReconcileCli({
      journal: fixture.journalPath,
      issuerRegistry: fixture.issuerRegistry,
      json: true,
    }, {
      stateDirectory: fixture.stateDirectory,
      now: () => Date.parse(FETCHED_AT),
      fetchExactOrderImpl: async () => orderSnapshot(),
    }),
    (error) => error?.code === "unsafe_state_permissions",
  );
  await access(fixture.executionLockPath);
  await access(fixture.reservationLockPath);
});

test("another execution-lock owner or generation is never removed", async () => {
  const foreign = await diskFixture();
  const foreignLock = JSON.parse(await readFile(foreign.executionLockPath, "utf8"));
  foreignLock.journalPath = join(foreign.stateDirectory, "another-take-profit.json");
  await writeFile(foreign.executionLockPath, `${JSON.stringify(foreignLock, null, 2)}\n`, { mode: 0o600 });
  await assert.rejects(
    runTakeProfitReconcileCli({
      journal: foreign.journalPath,
      issuerRegistry: foreign.issuerRegistry,
      json: true,
    }, {
      stateDirectory: foreign.stateDirectory,
      now: () => Date.parse(FETCHED_AT),
      fetchExactOrderImpl: async () => orderSnapshot(),
    }),
    (error) => error?.code === "lock_ownership_mismatch",
  );
  await access(foreign.executionLockPath);

  const replaced = await diskFixture();
  await assert.rejects(
    runTakeProfitReconcileCli({
      journal: replaced.journalPath,
      issuerRegistry: replaced.issuerRegistry,
      json: true,
    }, {
      stateDirectory: replaced.stateDirectory,
      now: () => Date.parse(FETCHED_AT),
      fetchExactOrderImpl: async () => orderSnapshot(),
      releaseLocks: async () => {
        throw Object.assign(new Error("pause after passport persistence"), { code: "simulated_pre_unlink_crash" });
      },
    }),
    (error) => error?.code === "simulated_pre_unlink_crash",
  );
  const replacement = JSON.parse(await readFile(replaced.executionLockPath, "utf8"));
  replacement.pid += 1;
  replacement.claimedAt = "2026-07-21T02:00:13.500Z";
  await writeFile(replaced.executionLockPath, `${JSON.stringify(replacement, null, 2)}\n`, { mode: 0o600 });
  await assert.rejects(
    runTakeProfitReconcileCli({
      journal: replaced.journalPath,
      issuerRegistry: replaced.issuerRegistry,
      json: true,
    }, {
      stateDirectory: replaced.stateDirectory,
      now: () => Date.parse(FETCHED_AT),
      fetchExactOrderImpl: async () => orderSnapshot(),
    }),
    (error) => error?.code === "lock_generation_mismatch",
  );
  assert.deepEqual(JSON.parse(await readFile(replaced.executionLockPath, "utf8")), replacement);
  await access(replaced.reservationLockPath);
});

test("a later ambiguous cancel cannot reuse recovered ARMED release authority", async () => {
  const fixture = await diskFixture();
  await runTakeProfitReconcileCli({
    journal: fixture.journalPath,
    issuerRegistry: fixture.issuerRegistry,
    json: true,
  }, {
    stateDirectory: fixture.stateDirectory,
    now: () => Date.parse(FETCHED_AT),
    fetchExactOrderImpl: async () => orderSnapshot(),
  });
  const journal = JSON.parse(await readFile(fixture.journalPath, "utf8"));
  await claimExecutionLock({
    journal: fixture.journalPath,
    directory: fixture.stateDirectory,
    file: fixture.executionLockPath,
    state: journal,
    purpose: "TP_CANCEL",
    recoveryNotBefore: VENUE_EXPIRES_AT,
    now: () => NOW,
    writeState: writeTakeProfitState,
  });
  journal.reconciliationRequired = true;
  journal.cancelConsent = { version: "conviction-take-profit-cancel-consent-v1" };
  journal.cancelAttemptedAt = "2026-07-21T02:00:15.000Z";
  await writeTakeProfitState(journal, { directory: fixture.stateDirectory, file: fixture.journalPath });

  const result = await runTakeProfitReconcileCli({
    journal: fixture.journalPath,
    issuerRegistry: fixture.issuerRegistry,
    json: true,
  }, {
    stateDirectory: fixture.stateDirectory,
    now: () => Date.parse(FETCHED_AT),
    fetchExactOrderImpl: async () => orderSnapshot(),
  });
  assert.equal(result.status, "ARMED");
  assert.equal(result.reconciliationRequired, true);
  assert.equal(result.executionLockReleased, false);
  await access(fixture.executionLockPath);
});

test("UNKNOWN and provisional matched recovery retain the global lock", async () => {
  const unknownFixture = await diskFixture();
  const unknown = await runTakeProfitReconcileCli({
    journal: unknownFixture.journalPath,
    issuerRegistry: unknownFixture.issuerRegistry,
    json: true,
  }, {
    stateDirectory: unknownFixture.stateDirectory,
    now: () => Date.parse(FETCHED_AT),
    fetchExactOrderImpl: async () => orderSnapshot({ order: { status: "MATCHED" } }),
  });
  assert.equal(unknown.status, "UNKNOWN");
  assert.equal(unknown.executionLockReleased, false);
  await access(unknownFixture.executionLockPath);

  const matchedFixture = await diskFixture();
  const matchedSnapshot = orderSnapshot({
    order: { status: "MATCHED", sizeMatched: "1000000", associatedTrades: ["maker-trade-1"] },
  });
  const provisional = await runTakeProfitReconcileCli({
    journal: matchedFixture.journalPath,
    issuerRegistry: matchedFixture.issuerRegistry,
    json: true,
  }, {
    stateDirectory: matchedFixture.stateDirectory,
    now: () => Date.parse(FETCHED_AT),
    fetchExactOrderImpl: async () => matchedSnapshot,
    fetchTradeContributions: async () => ({ version: "conviction-polymarket-associated-trades-v1" }),
    verifyAggregateFill: async () => ({
      ok: true,
      proofHash: `0x${"f".repeat(64)}`,
      proof: {
        version: "conviction-take-profit-fill-proof-v1",
        status: "PARTIALLY_FILLED_ACTIVE_PROVISIONAL",
        orderId: ORDER_ID,
        wallet: WALLET,
        outcomeTokenId: LIVE_MARKET_SNAPSHOT.yesTokenId,
        exactOrderSnapshotHash: sha256(matchedSnapshot),
        finality: { finalized: false },
        lifecycle: { orderTerminal: false },
      },
    }),
  });
  assert.equal(provisional.status, "PARTIALLY_FILLED_ACTIVE_PROVISIONAL");
  assert.equal(provisional.executionLockReleased, false);
  await access(matchedFixture.executionLockPath);
});

test("reconcile-tp continues a first-fetch fill through independent proof and releases only finalized terminal ambiguity", async () => {
  const fixture = await diskFixture();
  const matchedSnapshot = orderSnapshot({
    order: {
      status: "MATCHED",
      sizeMatched: "10000000",
      associatedTrades: ["maker-trade-1"],
    },
  });
  let exactFetches = 0;
  let tradeFetches = 0;
  let proofCalls = 0;
  let releases = 0;
  let writes = 0;
  const result = await runTakeProfitReconcileCli({
    journal: fixture.journalPath,
    issuerRegistry: fixture.issuerRegistry,
    json: true,
  }, {
    stateDirectory: fixture.stateDirectory,
    now: () => Date.parse(FETCHED_AT),
    fetchExactOrderImpl: async () => {
      exactFetches += 1;
      return matchedSnapshot;
    },
    fetchTradeContributions: async ({ orderId, exactOrderSnapshot }) => {
      tradeFetches += 1;
      assert.equal(orderId, ORDER_ID);
      assert.equal(exactOrderSnapshot, matchedSnapshot);
      return { version: "conviction-polymarket-associated-trades-v1" };
    },
    verifyAggregateFill: async ({ journal, orderSnapshot: suppliedSnapshot }) => {
      proofCalls += 1;
      assert.equal(journal.stage, "submitted");
      assert.equal(suppliedSnapshot, matchedSnapshot);
      return {
        ok: true,
        proofHash: `0x${"f".repeat(64)}`,
        proof: {
          version: "conviction-take-profit-fill-proof-v1",
          status: "FILLED_FINALIZED",
          orderId: ORDER_ID,
          wallet: WALLET,
          outcomeTokenId: LIVE_MARKET_SNAPSHOT.yesTokenId,
          exactOrderSnapshotHash: sha256(matchedSnapshot),
          finality: { finalized: true },
          lifecycle: { orderTerminal: true },
        },
      };
    },
    releaseLocks: async (journal, options) => {
      releases += 1;
      assert.equal(options.journal, await realpath(fixture.journalPath));
      await options.transition(journal, { releasedAt: FETCHED_AT });
      journal.executionLockPath = null;
      await options.writeState(journal, {
        directory: fixture.stateDirectory,
        file: fixture.journalPath,
      });
      return ["polymarket-execution.lock.json"];
    },
    writeState: async (journal, options) => {
      writes += 1;
      return writeTakeProfitState(journal, options);
    },
  });

  assert.equal(exactFetches, 1);
  assert.equal(tradeFetches, 1);
  assert.equal(proofCalls, 1);
  assert.equal(releases, 1);
  assert.equal(writes, 2);
  assert.equal(result.status, "FILLED_FINALIZED");
  assert.equal(result.reconciliationRequired, false);
  assert.equal(result.executionLockReleased, true);
  const persisted = JSON.parse(await readFile(fixture.journalPath, "utf8"));
  assert.equal(persisted.stage, "submitted");
  assert.equal(persisted.latestFillProofHash, `0x${"f".repeat(64)}`);
  assert.equal(persisted.reconciliationRequired, false);
});

test("reconcile-tp rejects non-owner-only pre-passport state before fetching an order", async () => {
  const fixture = await diskFixture({ mode: 0o644 });
  let exactFetches = 0;
  await assert.rejects(
    runTakeProfitReconcileCli({
      journal: fixture.journalPath,
      issuerRegistry: fixture.issuerRegistry,
      json: true,
    }, {
      stateDirectory: fixture.stateDirectory,
      now: () => Date.parse(FETCHED_AT),
      fetchExactOrderImpl: async () => {
        exactFetches += 1;
        return orderSnapshot();
      },
    }),
    (error) => error?.code === "unsafe_state_permissions",
  );
  assert.equal(exactFetches, 0);
  assert.equal(JSON.parse(await readFile(fixture.journalPath, "utf8")).stage, "live_result_received");
});

test("reconcile-tp leaves the pre-passport journal unchanged when exact-order authentication fails", async () => {
  const fixture = await diskFixture();
  const before = await readFile(fixture.journalPath, "utf8");
  await assert.rejects(
    runTakeProfitReconcileCli({
      journal: fixture.journalPath,
      issuerRegistry: fixture.issuerRegistry,
      json: true,
    }, {
      stateDirectory: fixture.stateDirectory,
      now: () => Date.parse(FETCHED_AT),
      fetchExactOrderImpl: async () => orderSnapshot({
        order: { assetId: LIVE_MARKET_SNAPSHOT.noTokenId },
      }),
    }),
    (error) => error?.code === "order_token_mismatch",
  );
  assert.equal(await readFile(fixture.journalPath, "utf8"), before);
});

function authorizationCheckpoint({
  stage = "payment_authorization_created",
  validBefore = String(NOW / 1_000 + 120),
} = {}) {
  const journal = prePassportJournal();
  journal.stage = stage;
  journal.paymentAuthorization = stage === "payment_authorization_starting" ? null : {
    version: "conviction-x402-authorization-v1",
    scheme: "exact-eip3009",
    network: "eip155:196",
    asset: SERVICE_ASSET,
    from: PAYER,
    to: SERVICE_PAYEE,
    value: POSITION_MANAGER_SERVICE.priceAtomic,
    validAfter: "0",
    validBefore,
    nonce: `0x${"9".repeat(64)}`,
  };
  journal.paymentTx = null;
  journal.paymentProof = null;
  journal.paidCard = null;
  journal.intentHash = null;
  journal.tradeConsent = null;
  journal.executionLockPath = null;
  journal.executionAttempted = false;
  journal.liveResult = null;
  journal.orderId = null;
  journal.reconciliationRequired = stage !== "payment_authorization_created";
  journal.paidServiceResponse = stage === "paid_request_ambiguous"
    ? { status: 502, paymentResponsePresent: false }
    : null;
  return journal;
}

function paidUnstartedCheckpoint() {
  const journal = prePassportJournal();
  journal.stage = "execution_blocked_before_launch";
  journal.executionAttempted = false;
  journal.executionLockPath = null;
  journal.liveResult = null;
  journal.orderId = null;
  journal.reconciliationRequired = true;
  journal.preSpawnError = {
    code: "position_reserved",
    at: FETCHED_AT,
  };
  return journal;
}

function verifiedUnconfirmedCheckpoint() {
  const journal = prePassportJournal();
  journal.stage = "payment_verified";
  journal.tradeConsent = null;
  journal.executionLockPath = null;
  journal.executionAttempted = false;
  journal.executionArgv = null;
  journal.executionArgvHash = null;
  journal.liveResult = null;
  journal.orderId = null;
  journal.takeProfitPassport = null;
  journal.takeProfitPassportHash = null;
  journal.restingOrderProofHash = null;
  journal.reconciliationRequired = true;
  return journal;
}

for (const headerCase of ["missing", "malformed"]) {
  test(`TAKE_PROFIT durably classifies a successful ${headerCase} PAYMENT-RESPONSE as authorization-only`, async () => {
    const validBefore = String(NOW / 1_000 + 120);
    const fixture = await diskFixture({ journal: authorizationCheckpoint({ validBefore }) });
    const state = JSON.parse(await readFile(fixture.journalPath, "utf8"));
    const raw = headerCase === "malformed" ? "not-valid-base64-json" : null;
    const response = new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: raw ? { "payment-response": raw } : {},
    });
    await assert.rejects(
      persistSuccessfulPaidServiceResponse({
        state,
        response,
        json: { ok: true, intentHash: `0x${"d".repeat(64)}` },
        paymentResponseRaw: response.headers.get("payment-response"),
        ambiguousStage: "paid_request_ambiguous",
        writeState: (next) => writeTakeProfitState(next, {
          directory: fixture.stateDirectory,
          file: fixture.journalPath,
        }),
      }),
      (error) => error?.code === "invalid_payment_header",
    );
    const ambiguous = JSON.parse(await readFile(fixture.journalPath, "utf8"));
    assert.equal(ambiguous.stage, "paid_request_ambiguous");
    assert.deepEqual(ambiguous.paidServiceResponse, {
      status: 200,
      paymentResponsePresent: headerCase === "malformed",
    });
    assert.equal(ambiguous.paymentTx, null);
    assert.equal(ambiguous.paidCard, null);
    assert.equal(ambiguous.paymentProof, null);
    assert.equal(ambiguous.executionAttempted, false);

    const result = await runTakeProfitReconcileCli({
      journal: fixture.journalPath,
      issuerRegistry: fixture.issuerRegistry,
      json: true,
    }, {
      stateDirectory: fixture.stateDirectory,
      now: () => NOW + 180_000,
      authorizationStateImpl: async () => ({
        used: false,
        blockNumber: "101",
        blockHash: `0x${"8".repeat(64)}`,
        blockTimestamp: String(Number(validBefore) + 1),
      }),
      fetchExactOrderImpl: async () => assert.fail("ambiguous payment cannot fetch or place an order"),
    });
    assert.equal(result.status, "expired_unused_payment_authorization_reconciled");
    await assert.rejects(access(fixture.reservationLockPath), (error) => error?.code === "ENOENT");
  });
}

for (const decodedPaymentResponse of [{}, { transaction: "0x1234" }]) {
  test("TAKE_PROFIT keeps a decoded PAYMENT-RESPONSE without a canonical transaction in its exact ambiguous stage", async () => {
    const fixture = await diskFixture({ journal: authorizationCheckpoint() });
    const state = JSON.parse(await readFile(fixture.journalPath, "utf8"));
    const response = new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: {
        "payment-response": Buffer.from(JSON.stringify(decodedPaymentResponse)).toString("base64"),
      },
    });
    await assert.rejects(
      persistSuccessfulPaidServiceResponse({
        state,
        response,
        json: { ok: true, intentHash: `0x${"d".repeat(64)}` },
        paymentResponseRaw: response.headers.get("payment-response"),
        ambiguousStage: "paid_request_ambiguous",
        writeState: (next) => writeTakeProfitState(next, {
          directory: fixture.stateDirectory,
          file: fixture.journalPath,
        }),
      }),
      (error) => error?.code === "missing_payment_transaction",
    );
    const durable = JSON.parse(await readFile(fixture.journalPath, "utf8"));
    assert.equal(durable.stage, "paid_request_ambiguous");
    assert.equal(durable.reconciliationRequired, true);
    assert.equal(durable.paymentTx, null);
    assert.equal(durable.paidCard, null);
    assert.equal(durable.paymentProof, null);
    await access(fixture.reservationLockPath);
  });
}

test("TAKE_PROFIT promotes its response only after the exact x402 proof is durably verified", async () => {
  const fixture = await diskFixture({ journal: authorizationCheckpoint() });
  const state = JSON.parse(await readFile(fixture.journalPath, "utf8"));
  const response = new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: {
      "payment-response": Buffer.from(JSON.stringify({ transaction: PAYMENT_TX })).toString("base64"),
    },
  });
  const card = { ...paidCard(), ok: true };
  const writeState = (next) => writeTakeProfitState(next, {
    directory: fixture.stateDirectory,
    file: fixture.journalPath,
  });
  const paid = await persistSuccessfulPaidServiceResponse({
    state,
    response,
    json: card,
    paymentResponseRaw: response.headers.get("payment-response"),
    ambiguousStage: "paid_request_ambiguous",
    writeState,
  });
  const proof = structuredClone(prePassportJournal().paymentProof);
  await persistVerifiedPaidServicePayment({
    state,
    paid,
    paymentProof: proof,
    service: POSITION_MANAGER_SERVICE,
    ambiguousStage: "paid_request_ambiguous",
    writeState,
  });
  const durable = JSON.parse(await readFile(fixture.journalPath, "utf8"));
  assert.equal(durable.stage, "payment_verified");
  assert.equal(durable.paymentTx, PAYMENT_TX);
  assert.equal(durable.paidCard.intentHash, card.intentHash);
  assert.deepEqual(durable.paymentProof, proof);
  assert.deepEqual(durable.paidServiceResponse, { status: 200, paymentResponsePresent: true });
  assert.equal(durable.tradeConsent, null);
  assert.equal(durable.executionAttempted, false);
  await access(fixture.reservationLockPath);
});

test("TAKE_PROFIT keeps a valid-looking wrong payment transaction authorization-only after real RPC verification fails", async () => {
  const validBefore = String(NOW / 1_000 + 120);
  const fixture = await diskFixture({ journal: authorizationCheckpoint({ validBefore }) });
  const state = JSON.parse(await readFile(fixture.journalPath, "utf8"));
  const claimedTx = `0x${"9".repeat(64)}`;
  const response = new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: {
      "payment-response": Buffer.from(JSON.stringify({ transaction: claimedTx })).toString("base64"),
    },
  });
  const card = { ...paidCard(), ok: true };
  const paid = await persistSuccessfulPaidServiceResponse({
    state,
    response,
    json: card,
    paymentResponseRaw: response.headers.get("payment-response"),
    ambiguousStage: "paid_request_ambiguous",
    writeState: (next) => writeTakeProfitState(next, {
      directory: fixture.stateDirectory,
      file: fixture.journalPath,
    }),
  });
  await assert.rejects(
    fetchAndVerifyX402Payment({
      paymentTx: paid.paymentTx,
      payer: PAYER,
      payee: SERVICE_PAYEE,
      asset: SERVICE_ASSET,
      amountAtomic: POSITION_MANAGER_SERVICE.priceAtomic,
      earliestAllowedTime: new Date(NOW).toISOString(),
    }, {
      rpcCall: async () => { throw new Error("simulated unavailable RPC"); },
    }),
    (error) => error?.code === "payment_rpc_error",
  );
  const ambiguous = JSON.parse(await readFile(fixture.journalPath, "utf8"));
  assert.equal(ambiguous.stage, "paid_request_ambiguous");
  assert.equal(ambiguous.paymentTx, null);
  assert.equal(ambiguous.paidCard, null);
  assert.equal(ambiguous.paymentProof, null);

  const result = await runTakeProfitReconcileCli({
    journal: fixture.journalPath,
    issuerRegistry: fixture.issuerRegistry,
    json: true,
  }, {
    stateDirectory: fixture.stateDirectory,
    now: () => NOW + 180_000,
    authorizationStateImpl: async () => ({
      used: true,
      blockTimestamp: String(Number(validBefore) + 1),
    }),
    fetchExactOrderImpl: async () => assert.fail("unverified payment cannot fetch or place an order"),
  });
  assert.equal(result.status, "manual_reconciliation_required");
  assert.equal(result.reason, "payment_authorization_consumed_or_ambiguous");
  await access(fixture.reservationLockPath);
});

test("TAKE_PROFIT verified payment before consent waits for signed-card expiry then releases exactly its reservation", async () => {
  const waiting = await diskFixture({ journal: verifiedUnconfirmedCheckpoint() });
  const waitingResult = await runTakeProfitReconcileCli({
    journal: waiting.journalPath,
    issuerRegistry: waiting.issuerRegistry,
    json: true,
  }, {
    stateDirectory: waiting.stateDirectory,
    now: () => Date.parse("2026-07-21T02:04:00.000Z"),
    fetchExactOrderImpl: async () => assert.fail("unconfirmed payment cannot fetch or place an order"),
  });
  assert.equal(waitingResult.status, "waiting_for_card_expiry");
  assert.equal(waitingResult.reservationReleased, false);
  await access(waiting.reservationLockPath);

  const expired = await diskFixture({ journal: verifiedUnconfirmedCheckpoint() });
  const expiredResult = await runTakeProfitReconcileCli({
    journal: expired.journalPath,
    issuerRegistry: expired.issuerRegistry,
    json: true,
  }, {
    stateDirectory: expired.stateDirectory,
    now: () => Date.parse("2026-07-21T02:05:20.000Z"),
    fetchExactOrderImpl: async () => assert.fail("unconfirmed payment cannot fetch or place an order"),
  });
  assert.equal(expiredResult.status, "expired_paid_unstarted_reconciled");
  assert.equal(expiredResult.reservationReleased, true);
  assert.equal(expiredResult.reconciliationRequired, false);
  await assert.rejects(access(expired.reservationLockPath), (error) => error?.code === "ENOENT");
  const persisted = JSON.parse(await readFile(expired.journalPath, "utf8"));
  assert.equal(persisted.stage, "expired_paid_unstarted_reconciled");
  assert.equal(persisted.tradeConsent, null);
  assert.equal(persisted.orderId, null);
});

for (const mutation of ["proof", "card", "request", "reservation"]) {
  test(`TAKE_PROFIT verified-but-unconfirmed cleanup refuses ${mutation} substitution`, async () => {
    const journal = verifiedUnconfirmedCheckpoint();
    if (mutation === "proof") journal.paymentProof.amountAtomic = String(BigInt(journal.paymentProof.amountAtomic) + 1n);
    if (mutation === "card") {
      journal.paidCard = structuredClone(journal.paidCard);
      journal.paidCard.intentHash = `0x${"7".repeat(64)}`;
    }
    if (mutation === "request") journal.request.shares = "9";
    const fixture = await diskFixture({ journal });
    if (mutation === "reservation") {
      const reservation = JSON.parse(await readFile(fixture.reservationLockPath, "utf8"));
      reservation.replayKey = `0x${"7".repeat(64)}`;
      await writeFile(fixture.reservationLockPath, `${JSON.stringify(reservation, null, 2)}\n`, { mode: 0o600 });
    }
    await assert.rejects(
      runTakeProfitReconcileCli({
        journal: fixture.journalPath,
        issuerRegistry: fixture.issuerRegistry,
        json: true,
      }, {
        stateDirectory: fixture.stateDirectory,
        now: () => Date.parse("2026-07-21T02:05:20.000Z"),
        fetchExactOrderImpl: async () => assert.fail("substituted checkpoint cannot fetch or place an order"),
      }),
    );
    await access(fixture.reservationLockPath);
    assert.equal(JSON.parse(await readFile(fixture.journalPath, "utf8")).stage, "payment_verified");
  });
}

test("pre-spawn refusal is durably classified without claiming an order attempt", () => {
  const state = { stage: "execution_attempted", executionAttempted: true, reconciliationRequired: false };
  assert.equal(markTakeProfitPreSpawnFailure(state, { code: "position_reserved" }, {
    liveSpawnStarted: false,
    now: () => Date.parse(FETCHED_AT),
  }), true);
  assert.equal(state.stage, "execution_blocked_before_launch");
  assert.equal(state.executionAttempted, false);
  assert.equal(state.reconciliationRequired, true);
  assert.equal(state.preSpawnError.code, "position_reserved");

  const ambiguous = { stage: "execution_attempted", executionAttempted: true };
  assert.equal(markTakeProfitPreSpawnFailure(ambiguous, new Error("ambiguous"), {
    liveSpawnStarted: true,
    now: () => Date.parse(FETCHED_AT),
  }), false);
  assert.deepEqual(ambiguous, { stage: "execution_attempted", executionAttempted: true });
});

test("reconcile-tp waits through the payment authorization window without reading or releasing state", async () => {
  const validBefore = String(NOW / 1_000 + 120);
  const fixture = await diskFixture({ journal: authorizationCheckpoint({ validBefore }) });
  let stateReads = 0;
  const result = await runTakeProfitReconcileCli({
    journal: fixture.journalPath,
    issuerRegistry: fixture.issuerRegistry,
    json: true,
  }, {
    stateDirectory: fixture.stateDirectory,
    now: () => NOW + 60_000,
    authorizationStateImpl: async () => {
      stateReads += 1;
      return { used: false, blockTimestamp: String(Number(validBefore) + 1) };
    },
    fetchExactOrderImpl: async () => assert.fail("payment reconciliation cannot fetch or place an order"),
  });
  assert.equal(stateReads, 0);
  assert.equal(result.status, "waiting_for_authorization_expiry");
  assert.equal(result.reservationReleased, false);
  await access(fixture.reservationLockPath);
});

test("reconcile-tp keeps a pre-signing crash reservation manual when no authorization nonce was persisted", async () => {
  const fixture = await diskFixture({ journal: authorizationCheckpoint({
    stage: "payment_authorization_starting",
  }) });
  let stateReads = 0;
  const result = await runTakeProfitReconcileCli({
    journal: fixture.journalPath,
    issuerRegistry: fixture.issuerRegistry,
    json: true,
  }, {
    stateDirectory: fixture.stateDirectory,
    now: () => NOW + 600_000,
    authorizationStateImpl: async () => {
      stateReads += 1;
      return { used: false };
    },
  });
  assert.equal(stateReads, 0);
  assert.equal(result.status, "manual_reconciliation_required");
  assert.equal(result.reason, "payment_authorization_metadata_missing");
  assert.equal(result.reservationReleased, false);
  await access(fixture.reservationLockPath);
});

test("reconcile-tp releases an expired payment reservation only after finalized unused authorization state", async () => {
  const validBefore = String(NOW / 1_000 + 120);
  const fixture = await diskFixture({ journal: authorizationCheckpoint({
    stage: "paid_request_ambiguous",
    validBefore,
  }) });
  const result = await runTakeProfitReconcileCli({
    journal: fixture.journalPath,
    issuerRegistry: fixture.issuerRegistry,
    json: true,
  }, {
    stateDirectory: fixture.stateDirectory,
    now: () => NOW + 180_000,
    authorizationStateImpl: async (authorization) => {
      assert.equal(authorization.nonce, `0x${"9".repeat(64)}`);
      return {
        used: false,
        blockNumber: "101",
        blockHash: `0x${"8".repeat(64)}`,
        blockTimestamp: String(Number(validBefore) + 1),
      };
    },
    fetchExactOrderImpl: async () => assert.fail("payment cleanup cannot fetch or place an order"),
  });
  assert.equal(result.status, "expired_unused_payment_authorization_reconciled");
  assert.equal(result.reconciliationRequired, false);
  assert.equal(result.reservationReleased, true);
  await assert.rejects(access(fixture.reservationLockPath), (error) => error?.code === "ENOENT");
  const persisted = JSON.parse(await readFile(fixture.journalPath, "utf8"));
  assert.equal(persisted.reservationLockPath, null);
  assert.equal(persisted.reconciliationAuthorizationState.used, false);
});

test("reconcile-tp retains payment reservations for consumed, ambiguous, or not-yet-finalized authorization state", async () => {
  const validBefore = String(NOW / 1_000 + 120);
  for (const [state, expectedStatus] of [
    [{ used: true, blockTimestamp: String(Number(validBefore) + 1) }, "manual_reconciliation_required"],
    [{ used: undefined, blockTimestamp: String(Number(validBefore) + 1) }, "manual_reconciliation_required"],
    [{ used: false, blockTimestamp: validBefore }, "waiting_for_finalized_authorization_expiry"],
  ]) {
    const fixture = await diskFixture({ journal: authorizationCheckpoint({
      stage: "payment_header_rejected_after_authorization",
      validBefore,
    }) });
    const result = await runTakeProfitReconcileCli({
      journal: fixture.journalPath,
      issuerRegistry: fixture.issuerRegistry,
      json: true,
    }, {
      stateDirectory: fixture.stateDirectory,
      now: () => NOW + 180_000,
      authorizationStateImpl: async () => state,
      fetchExactOrderImpl: async () => assert.fail("authorization reconciliation cannot fetch an order"),
    });
    assert.equal(result.status, expectedStatus);
    assert.equal(result.reservationReleased, false);
    assert.equal(result.reconciliationRequired, true);
    await access(fixture.reservationLockPath);
  }
});

test("payment reconciliation rejects a substituted TAKE_PROFIT reservation before authorization-state lookup", async () => {
  const validBefore = String(NOW / 1_000 + 120);
  const fixture = await diskFixture({ journal: authorizationCheckpoint({ validBefore }) });
  const lock = JSON.parse(await readFile(fixture.reservationLockPath, "utf8"));
  lock.replayKey = `0x${"7".repeat(64)}`;
  await writeFile(fixture.reservationLockPath, `${JSON.stringify(lock, null, 2)}\n`, { mode: 0o600 });
  let stateReads = 0;
  await assert.rejects(
    runTakeProfitReconcileCli({
      journal: fixture.journalPath,
      issuerRegistry: fixture.issuerRegistry,
      json: true,
    }, {
      stateDirectory: fixture.stateDirectory,
      now: () => NOW + 180_000,
      authorizationStateImpl: async () => {
        stateReads += 1;
        return { used: false, blockTimestamp: String(Number(validBefore) + 1) };
      },
    }),
    (error) => error?.code === "reservation_ownership_mismatch",
  );
  assert.equal(stateReads, 0);
  await access(fixture.reservationLockPath);
});

test("payment reconciliation rejects authorization substitution without querying or releasing", async () => {
  const validBefore = String(NOW / 1_000 + 120);
  const journal = authorizationCheckpoint({ validBefore });
  journal.paymentAuthorization.asset = "0x1111111111111111111111111111111111111111";
  const fixture = await diskFixture({ journal });
  let stateReads = 0;
  await assert.rejects(
    runTakeProfitReconcileCli({
      journal: fixture.journalPath,
      issuerRegistry: fixture.issuerRegistry,
      json: true,
    }, {
      stateDirectory: fixture.stateDirectory,
      now: () => NOW + 180_000,
      authorizationStateImpl: async () => {
        stateReads += 1;
        return { used: false };
      },
    }),
    (error) => error?.code === "invalid_payment_authorization",
  );
  assert.equal(stateReads, 0);
  await access(fixture.reservationLockPath);
});

test("reconcile-tp retains a paid proven-unstarted reservation until card expiry, then cleans it without an order", async () => {
  const waiting = await diskFixture({ journal: paidUnstartedCheckpoint() });
  let exactFetches = 0;
  const waitingResult = await runTakeProfitReconcileCli({
    journal: waiting.journalPath,
    issuerRegistry: waiting.issuerRegistry,
    json: true,
  }, {
    stateDirectory: waiting.stateDirectory,
    now: () => Date.parse("2026-07-21T02:04:00.000Z"),
    fetchExactOrderImpl: async () => { exactFetches += 1; },
  });
  assert.equal(waitingResult.status, "waiting_for_card_expiry");
  assert.equal(waitingResult.reservationReleased, false);
  assert.equal(exactFetches, 0);
  await access(waiting.reservationLockPath);

  const expired = await diskFixture({ journal: paidUnstartedCheckpoint() });
  const expiredResult = await runTakeProfitReconcileCli({
    journal: expired.journalPath,
    issuerRegistry: expired.issuerRegistry,
    json: true,
  }, {
    stateDirectory: expired.stateDirectory,
    now: () => Date.parse("2026-07-21T02:05:20.000Z"),
    fetchExactOrderImpl: async () => { exactFetches += 1; },
  });
  assert.equal(expiredResult.status, "expired_paid_unstarted_reconciled");
  assert.equal(expiredResult.reservationReleased, true);
  assert.equal(expiredResult.reconciliationRequired, false);
  assert.equal(exactFetches, 0);
  await assert.rejects(access(expired.reservationLockPath), (error) => error?.code === "ENOENT");
  const persisted = JSON.parse(await readFile(expired.journalPath, "utf8"));
  assert.equal(persisted.paidCard.intentHash, prePassportJournal().paidCard.intentHash);
  assert.equal(persisted.tradeConsent.intentHash, persisted.paidCard.intentHash);
  assert.equal(persisted.orderId, null);
});

test("expired paid-card cleanup refuses substituted consent and keeps its reservation", async () => {
  const journal = paidUnstartedCheckpoint();
  journal.tradeConsent.executionArgvHash = `0x${"7".repeat(64)}`;
  const fixture = await diskFixture({ journal });
  await assert.rejects(
    runTakeProfitReconcileCli({
      journal: fixture.journalPath,
      issuerRegistry: fixture.issuerRegistry,
      json: true,
    }, {
      stateDirectory: fixture.stateDirectory,
      now: () => Date.parse("2026-07-21T02:05:20.000Z"),
    }),
    (error) => error?.code === "prepassport_consent_mismatch",
  );
  await access(fixture.reservationLockPath);
});
