import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  access,
  chmod,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { sha256 } from "../src/canonical.mjs";
import {
  claimExecutionLock,
  markExecutionAttempted,
  reconcileUnattachedExecutionLock,
  verifyJournalLockOwnership,
  writeReconciliationJournal,
} from "../scripts/buyer-orchestrator.mjs";

const CLAIMED_AT_MS = Date.parse("2026-07-22T08:00:00.000Z");
const RECOVERY_NOT_BEFORE = "2026-07-22T08:05:00.000Z";
const PAYMENT_TX = `0x${"11".repeat(32)}`;
const REPLAY_KEY = `0x${"22".repeat(32)}`;
const ORDER_ID = `0x${"33".repeat(32)}`;
const PASSPORT_HASH = `0x${"44".repeat(32)}`;
const PROOF_HASH = `0x${"55".repeat(32)}`;
const INTENT_HASH = `0x${"66".repeat(32)}`;
const WALLET = "0x7777777777777777777777777777777777777777";
const PAYER = "0x8888888888888888888888888888888888888888";
const PURPOSES = Object.freeze([
  "OPEN_PLACE",
  "CLOSE_PLACE",
  "CLOSE_RESUME",
  "TP_PLACE",
  "TP_CANCEL",
]);
const ARGV_BY_PURPOSE = Object.freeze({
  OPEN_PLACE: ["buy", "--token-id", "123", "--amount", "1", "--price", "0.2", "--order-type", "FAK"],
  CLOSE_PLACE: ["sell", "--token-id", "123", "--shares", "1", "--price", "0.2", "--order-type", "FOK"],
  CLOSE_RESUME: ["sell", "--token-id", "123", "--shares", "1", "--price", "0.2", "--order-type", "FOK"],
  TP_PLACE: ["sell", "--token-id", "123", "--shares", "1", "--price", "0.4", "--order-type", "GTD"],
  TP_CANCEL: ["cancel", "--order-id", ORDER_ID],
});

async function exists(file) {
  try {
    await access(file);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

function paymentProof() {
  return {
    version: "conviction-x402-payment-v1",
    chainId: 196,
    transactionHash: PAYMENT_TX,
    blockNumber: "100",
    blockHash: `0x${"99".repeat(32)}`,
    blockTimestamp: String(CLAIMED_AT_MS / 1_000 - 10),
    asset: "0x1e4a5963abfd975d8c9021ce480b42188849d41d",
    payer: PAYER,
    payee: "0x4abb90f1cf9ea0ddc3c4b8823dc6b22b7b1ed4c7",
    amountAtomic: "50000",
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

function unboundExecutionFields() {
  return {
    executionLockPath: null,
    executionLockGeneration: null,
    executionLockHash: null,
    executionLockPurpose: null,
    executionLockRecoveryNotBefore: null,
    executionArgv: null,
    executionArgvHash: null,
    executionAttempted: false,
    executionAttemptedAt: null,
    liveResult: null,
    orderId: null,
    settlementTx: null,
  };
}

function sourceState(purpose, journal, directory) {
  const common = {
    journalRevision: 0,
    journalPath: journal,
    reconciliationRequired: true,
    replayKey: REPLAY_KEY,
    paymentPayer: PAYER,
    buyerWallet: WALLET,
    paymentTx: PAYMENT_TX,
    paymentProof: paymentProof(),
    paidCard: { intentHash: INTENT_HASH },
    intentHash: INTENT_HASH,
    tradeConfirmedAt: "2026-07-22T07:59:55.000Z",
    ...unboundExecutionFields(),
  };
  if (purpose === "OPEN_PLACE" || purpose === "CLOSE_PLACE" || purpose === "CLOSE_RESUME") {
    const mode = purpose === "OPEN_PLACE" ? "open" : "close";
    return {
      ...common,
      mode,
      stage: "trade_confirmed",
      replayLockPath: join(directory, `${mode}-${REPLAY_KEY.slice(2)}.lock.json`),
      tradeConsent: {
        version: mode === "open" ? "conviction-open-trade-consent-v1" : "conviction-close-trade-consent-v1",
        intentHash: INTENT_HASH,
        executionArgvHash: sha256(ARGV_BY_PURPOSE[purpose]),
        paymentTx: PAYMENT_TX,
        replayKey: REPLAY_KEY,
        confirmedAt: "2026-07-22T07:59:55.000Z",
        expiresAt: RECOVERY_NOT_BEFORE,
      },
    };
  }
  if (purpose === "TP_PLACE") {
    return {
      ...common,
      version: "conviction-take-profit-journey-v1",
      action: "TAKE_PROFIT",
      stage: "trade_confirmed",
      reservationLockPath: join(directory, `take-profit-${REPLAY_KEY.slice(2)}.lock.json`),
      takeProfitPassport: null,
      takeProfitPassportHash: null,
      restingOrderProofHash: null,
      tradeConsent: {
        version: "conviction-take-profit-consent-v1",
        intentHash: INTENT_HASH,
        executionArgvHash: sha256(ARGV_BY_PURPOSE[purpose]),
        paymentTx: PAYMENT_TX,
        replayKey: REPLAY_KEY,
        confirmedAt: "2026-07-22T07:59:55.000Z",
        placementExpiresAt: RECOVERY_NOT_BEFORE,
      },
    };
  }
  return {
    ...common,
    version: "conviction-take-profit-journey-v1",
    action: "TAKE_PROFIT",
    stage: "armed",
    reservationLockPath: join(directory, `take-profit-${REPLAY_KEY.slice(2)}.lock.json`),
    orderId: ORDER_ID,
    takeProfitPassport: { status: "ARMED" },
    takeProfitPassportHash: PASSPORT_HASH,
    restingOrderProofHash: PROOF_HASH,
    cancelConsent: null,
    cancelExecution: null,
    cancelAttemptedAt: null,
    cancelResult: null,
    cancelOutcome: null,
  };
}

async function fixture(purpose = "OPEN_PLACE", prefix = "conviction-execution-lock-v2-") {
  const directory = await realpath(await mkdtemp(join(tmpdir(), prefix)));
  await chmod(directory, 0o700);
  const journal = join(directory, "journey.json");
  const lockFile = join(directory, "polymarket-execution.lock.json");
  const state = sourceState(purpose, journal, directory);
  await writeReconciliationJournal(state, { directory, file: journal });
  return { directory, journal, lockFile, state, purpose };
}

function unattachedLock(f, overrides = {}) {
  return {
    version: "conviction-polymarket-execution-lock-v2",
    generation: "12345678-1234-4123-8123-123456789abc",
    pid: 12345,
    journalPath: f.journal,
    sourceJournalHash: sha256(f.state),
    sourceJournalRevision: f.state.journalRevision,
    purpose: f.purpose,
    attachmentRequired: true,
    claimedAt: new Date(CLAIMED_AT_MS).toISOString(),
    recoveryNotBefore: RECOVERY_NOT_BEFORE,
    ...overrides,
  };
}

async function writeLock(file, lock) {
  await writeFile(file, `${JSON.stringify(lock, null, 2)}\n`, { mode: 0o600 });
}

async function claimAttached(f, {
  now = CLAIMED_AT_MS,
  durablePublishImpl,
  writeState,
} = {}) {
  const stage = f.purpose === "CLOSE_RESUME"
    ? "resume_execution_lock_acquired"
    : "execution_lock_acquired";
  return claimExecutionLock({
    journal: f.journal,
    directory: f.directory,
    file: f.lockFile,
    state: f.state,
    purpose: f.purpose,
    recoveryNotBefore: RECOVERY_NOT_BEFORE,
    now: () => now,
    durablePublishImpl,
    writeState,
    transition(next, { lock, lockHash }) {
      next.stage = stage;
      if (f.purpose === "TP_CANCEL") {
        next.cancelConsent = {
          version: "conviction-take-profit-cancel-consent-v2",
          orderId: ORDER_ID,
          confirmedAt: new Date(CLAIMED_AT_MS).toISOString(),
          launchExpiresAt: RECOVERY_NOT_BEFORE,
          preCancelSnapshotHash: PROOF_HASH,
          argvHash: sha256(ARGV_BY_PURPOSE.TP_CANCEL),
        };
        next.cancelExecution = {
          version: "conviction-take-profit-cancel-execution-v2",
          phase: "lock_acquired",
          orderId: ORDER_ID,
          intentHash: INTENT_HASH,
          takeProfitPassportHash: PASSPORT_HASH,
          preCancelSnapshotHash: PROOF_HASH,
          argv: [...ARGV_BY_PURPOSE.TP_CANCEL],
          argvHash: sha256(ARGV_BY_PURPOSE.TP_CANCEL),
          confirmedAt: new Date(CLAIMED_AT_MS).toISOString(),
          launchExpiresAt: RECOVERY_NOT_BEFORE,
          lockAcquiredAt: lock.claimedAt,
          executionLockGeneration: lock.generation,
          executionLockHash: lockHash,
          attemptedAt: null,
        };
      }
    },
  });
}

test("v2 claims atomically bind exact source, generation, purpose, and recovery boundary for every execution verb", async () => {
  for (const purpose of PURPOSES) {
    const f = await fixture(purpose, `conviction-v2-${purpose.toLowerCase()}-`);
    try {
      const source = structuredClone(f.state);
      await claimAttached(f);
      const lock = JSON.parse(await readFile(f.lockFile, "utf8"));
      const durable = JSON.parse(await readFile(f.journal, "utf8"));
      assert.equal(lock.version, "conviction-polymarket-execution-lock-v2");
      assert.equal(lock.attachmentRequired, true);
      assert.equal(lock.journalPath, f.journal);
      assert.equal(lock.sourceJournalHash, sha256(source));
      assert.equal(lock.sourceJournalRevision, source.journalRevision);
      assert.equal(lock.purpose, purpose);
      assert.equal(lock.recoveryNotBefore, RECOVERY_NOT_BEFORE);
      assert.equal(durable.executionLockPath, f.lockFile);
      assert.equal(durable.executionLockGeneration, lock.generation);
      assert.equal(durable.executionLockHash, sha256(lock));
      assert.equal(durable.executionLockPurpose, purpose);
      assert.equal(durable.executionLockRecoveryNotBefore, RECOVERY_NOT_BEFORE);
      assert.equal(durable.journalRevision, source.journalRevision + 1);
      const checked = await verifyJournalLockOwnership(durable, {
        stateDirectory: f.directory,
        journal: f.journal,
        fields: ["executionLockPath"],
        requirePresent: true,
      });
      assert.deepEqual(checked.map(({ lockText: _lockText, ...item }) => item), [{
        field: "executionLockPath",
        file: f.lockFile,
        missing: false,
        lockHash: sha256(lock),
      }]);
      if (checked[0].lockText !== undefined) {
        assert.equal(checked[0].lockText, await readFile(f.lockFile, "utf8"));
      }
    } finally {
      await rm(f.directory, { recursive: true, force: true });
    }
  }
});

test("claim refuses expiry equality without publishing a byte or advancing the journal", async () => {
  for (const purpose of PURPOSES) {
    const f = await fixture(purpose, `conviction-v2-expiry-equality-${purpose.toLowerCase()}-`);
    try {
      const before = await readFile(f.journal, "utf8");
      await assert.rejects(
        claimAttached(f, { now: Date.parse(RECOVERY_NOT_BEFORE) }),
        (error) => error?.code === "execution_lock_boundary_elapsed",
      );
      assert.equal(await exists(f.lockFile), false);
      assert.equal(await readFile(f.journal, "utf8"), before);
    } finally {
      await rm(f.directory, { recursive: true, force: true });
    }
  }
});

test("atomic publication faults leave either no lock or one complete owner-recoverable generation", async () => {
  for (const mode of ["pre-publish", "post-publish-sync", "post-publish-unlink"]) {
    const f = await fixture("OPEN_PLACE", `conviction-v2-atomic-${mode}-`);
    const before = await readFile(f.journal, "utf8");
    try {
      const durablePublishImpl = async (file, text) => {
        if (mode === "pre-publish") {
          throw Object.assign(new Error("simulated pre-link failure"), { code: "EIO" });
        }
        await writeFile(file, text, { mode: 0o600 });
        if (mode === "post-publish-unlink") await chmod(f.directory, 0o500);
        throw Object.assign(new Error("simulated failure after link"), {
          code: mode === "post-publish-sync" ? "simulated_directory_sync_failure" : "simulated_cleanup_unlink_failure",
          atomicPublishCompleted: true,
          atomicPublishedPath: file,
        });
      };
      await assert.rejects(
        claimAttached(f, { durablePublishImpl }),
        (error) => mode === "pre-publish"
          ? error?.code === "EIO"
          : mode === "post-publish-sync"
            ? error?.code === "execution_lock_publish_failed"
            : error?.code === "lock_attachment_ambiguous" && error?.preserveSourceJournal === true,
      );
      if (mode === "post-publish-unlink") await chmod(f.directory, 0o700);
      assert.equal(await readFile(f.journal, "utf8"), before);
      assert.equal(await exists(f.lockFile), mode === "post-publish-unlink");
      if (mode === "post-publish-unlink") {
        const lock = JSON.parse(await readFile(f.lockFile, "utf8"));
        assert.equal(lock.version, "conviction-polymarket-execution-lock-v2");
        assert.equal(lock.sourceJournalHash, sha256(JSON.parse(before)));
      }
    } finally {
      await chmod(f.directory, 0o700).catch(() => {});
      await rm(f.directory, { recursive: true, force: true });
    }
  }
});

test("a post-rename journal error retains the exactly attached generation and reloads durable state", async () => {
  const f = await fixture("CLOSE_PLACE", "conviction-v2-post-rename-attachment-");
  try {
    const writeState = (state, options) => writeReconciliationJournal(state, {
      ...options,
      durableWriteImpl: async (file, text) => {
        const temporary = `${file}.${randomUUID()}.post-rename`;
        await writeFile(temporary, text, { mode: 0o600 });
        await rename(temporary, file);
        throw Object.assign(new Error("writer lost its result after rename"), {
          code: "simulated_post_rename_ambiguity",
          atomicPublishCompleted: true,
          atomicPublishedPath: file,
        });
      },
    });
    await assert.rejects(
      claimAttached(f, { writeState }),
      (error) => error?.code === "lock_attachment_ambiguous" && error?.preserveSourceJournal === true,
    );
    const durable = JSON.parse(await readFile(f.journal, "utf8"));
    const lock = JSON.parse(await readFile(f.lockFile, "utf8"));
    assert.equal(f.state.executionLockPath, f.lockFile);
    assert.equal(f.state.journalRevision, durable.journalRevision);
    assert.equal(durable.executionLockHash, sha256(lock));
    assert.equal(durable.executionLockGeneration, lock.generation);
    assert.equal(durable.executionLockPurpose, "CLOSE_PLACE");
  } finally {
    await rm(f.directory, { recursive: true, force: true });
  }
});

test("unattached v2 recovery removes only an exact, unchanged purpose-bound A0 source", async () => {
  for (const purpose of PURPOSES) {
    const f = await fixture(purpose, `conviction-v2-unattached-${purpose.toLowerCase()}-`);
    try {
      const lock = unattachedLock(f);
      await writeLock(f.lockFile, lock);
      const result = await reconcileUnattachedExecutionLock({
        file: f.lockFile,
        journal: f.journal,
        directory: f.directory,
        expectedJournalHash: sha256(f.state),
        expectedPurposes: [purpose],
      });
      assert.deepEqual(result, {
        released: true,
        path: f.lockFile,
        generationHash: sha256(lock),
      });
      assert.equal(await exists(f.lockFile), false);
      assert.deepEqual(JSON.parse(await readFile(f.journal, "utf8")), f.state);
    } finally {
      await rm(f.directory, { recursive: true, force: true });
    }
  }
});

test("an unrelated but valid global v2 lock is reported nonfatally and never removed", async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "conviction-v2-unrelated-owner-")));
  await chmod(directory, 0o700);
  const journalA = join(directory, "journey-a.json");
  const journalB = join(directory, "journey-b.json");
  const lockFile = join(directory, "polymarket-execution.lock.json");
  const stateA = sourceState("OPEN_PLACE", journalA, directory);
  const stateB = sourceState("CLOSE_PLACE", journalB, directory);
  try {
    await writeReconciliationJournal(stateA, { directory, file: journalA });
    await writeReconciliationJournal(stateB, { directory, file: journalB });
    const lock = {
      ...unattachedLock({ journal: journalB, state: stateB, purpose: "CLOSE_PLACE" }),
      journalPath: journalB,
      purpose: "CLOSE_PLACE",
    };
    await writeLock(lockFile, lock);
    const result = await reconcileUnattachedExecutionLock({
      file: lockFile,
      journal: journalA,
      directory,
      expectedJournalHash: sha256(stateA),
      expectedPurposes: ["OPEN_PLACE"],
    });
    assert.equal(result.released, false);
    assert.equal(result.ownedByOtherJourney, true);
    assert.equal(result.ownerJournalPath, journalB);
    assert.equal(result.generationHash, sha256(lock));
    assert.equal(await readFile(lockFile, "utf8"), `${JSON.stringify(lock, null, 2)}\n`);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("unattached cleanup rejects source, revision, purpose, deadline, timestamp, generation, and attachment substitutions", async () => {
  const cases = [
    ["source hash", (lock) => { lock.sourceJournalHash = `0x${"ab".repeat(32)}`; }],
    ["source revision", (lock) => { lock.sourceJournalRevision += 1; }],
    ["purpose", (lock) => { lock.purpose = "CLOSE_PLACE"; }],
    ["deadline", (lock) => { lock.recoveryNotBefore = "2026-07-22T08:04:59.999Z"; }],
    ["noncanonical deadline", (lock) => { lock.recoveryNotBefore = "2026-07-22T08:05:00Z"; }],
    ["noncanonical claim timestamp", (lock) => { lock.claimedAt = "2026-07-22T08:00:00Z"; }],
    ["claim at recovery boundary", (lock) => { lock.claimedAt = lock.recoveryNotBefore; }],
    ["generation", (lock) => { lock.generation = "not-a-uuid"; }],
    ["attachment flag", (lock) => { lock.attachmentRequired = false; }],
  ];
  for (const [label, mutate] of cases) {
    const f = await fixture("OPEN_PLACE", `conviction-v2-unattached-substitution-${label.replaceAll(" ", "-")}-`);
    try {
      const lock = unattachedLock(f);
      mutate(lock);
      await writeLock(f.lockFile, lock);
      await assert.rejects(
        reconcileUnattachedExecutionLock({
          file: f.lockFile,
          journal: f.journal,
          directory: f.directory,
          expectedJournalHash: sha256(f.state),
          expectedPurposes: ["OPEN_PLACE"],
        }),
        (error) => ["lock_ownership_mismatch", "unsafe_unattached_lock_recovery"].includes(error?.code),
        label,
      );
      assert.equal(await exists(f.lockFile), true, label);
    } finally {
      await rm(f.directory, { recursive: true, force: true });
    }
  }
});

test("unattached cleanup re-reads exact raw lock and journal generations immediately before unlink", async () => {
  for (const mutation of ["lock", "journal"]) {
    const f = await fixture("OPEN_PLACE", `conviction-v2-final-reread-${mutation}-`);
    try {
      await writeLock(f.lockFile, unattachedLock(f));
      await assert.rejects(
        reconcileUnattachedExecutionLock({
          file: f.lockFile,
          journal: f.journal,
          directory: f.directory,
          expectedJournalHash: sha256(f.state),
          expectedPurposes: ["OPEN_PLACE"],
          beforeUnlink: async () => {
            if (mutation === "lock") {
              const replacement = unattachedLock(f, { generation: randomUUID() });
              await writeLock(f.lockFile, replacement);
            } else {
              const changed = { ...f.state, unrelatedWriter: true };
              await writeFile(f.journal, `${JSON.stringify(changed, null, 2)}\n`, { mode: 0o600 });
            }
          },
        }),
        (error) => error?.code === (mutation === "lock" ? "lock_generation_mismatch" : "reconciliation_journal_changed"),
      );
      assert.equal(await exists(f.lockFile), true);
    } finally {
      await rm(f.directory, { recursive: true, force: true });
    }
  }
});

test("lock and journal symlinks are never accepted as owner state", async () => {
  {
    const f = await fixture("OPEN_PLACE", "conviction-v2-lock-symlink-");
    try {
      const target = join(f.directory, "actual-lock.json");
      await writeLock(target, unattachedLock(f));
      await symlink(target, f.lockFile);
      await assert.rejects(
        reconcileUnattachedExecutionLock({
          file: f.lockFile,
          journal: f.journal,
          directory: f.directory,
          expectedJournalHash: sha256(f.state),
          expectedPurposes: ["OPEN_PLACE"],
        }),
        (error) => error?.code === "unsafe_state_symlink",
      );
      assert.equal(await exists(target), true);
    } finally {
      await rm(f.directory, { recursive: true, force: true });
    }
  }
  {
    const f = await fixture("OPEN_PLACE", "conviction-v2-journal-symlink-");
    try {
      const target = join(f.directory, "actual-journal.json");
      await rename(f.journal, target);
      await symlink(target, f.journal);
      await writeLock(f.lockFile, unattachedLock(f));
      await assert.rejects(
        reconcileUnattachedExecutionLock({
          file: f.lockFile,
          journal: f.journal,
          directory: f.directory,
          expectedJournalHash: sha256(f.state),
          expectedPurposes: ["OPEN_PLACE"],
        }),
        (error) => error?.code === "unsafe_state_symlink",
      );
      assert.equal(await exists(f.lockFile), true);
    } finally {
      await rm(f.directory, { recursive: true, force: true });
    }
  }
});

test("attached ownership pins every v2 field, including claimed timestamp through the generation hash", async () => {
  const mutations = [
    ["generation", (lock) => { lock.generation = randomUUID(); }],
    ["source hash", (lock) => { lock.sourceJournalHash = `0x${"ab".repeat(32)}`; }],
    ["source revision", (lock) => { lock.sourceJournalRevision += 1; }],
    ["purpose", (lock) => { lock.purpose = "CLOSE_PLACE"; }],
    ["deadline", (lock) => { lock.recoveryNotBefore = "2026-07-22T08:05:00.001Z"; }],
    ["claimed timestamp", (lock) => { lock.claimedAt = "2026-07-22T08:00:00.001Z"; }],
  ];
  for (const [label, mutate] of mutations) {
    const f = await fixture("OPEN_PLACE", `conviction-v2-attached-substitution-${label.replaceAll(" ", "-")}-`);
    try {
      await claimAttached(f);
      const lock = JSON.parse(await readFile(f.lockFile, "utf8"));
      mutate(lock);
      await writeLock(f.lockFile, lock);
      await assert.rejects(
        verifyJournalLockOwnership(f.state, {
          stateDirectory: f.directory,
          journal: f.journal,
          fields: ["executionLockPath"],
          requirePresent: true,
        }),
        (error) => error?.code === "lock_ownership_mismatch",
        label,
      );
      assert.equal(await exists(f.lockFile), true);
    } finally {
      await rm(f.directory, { recursive: true, force: true });
    }
  }
});

test("A0 to A1 is a durable, deadline-strict transition for every execution purpose", async () => {
  for (const purpose of PURPOSES) {
    const f = await fixture(purpose, `conviction-v2-a0-a1-${purpose.toLowerCase()}-`);
    try {
      await claimAttached(f);
      const a0 = JSON.parse(await readFile(f.journal, "utf8"));
      assert.equal(a0.executionArgv, null);
      assert.equal(a0.executionArgvHash, null);
      assert.equal(a0.executionAttemptedAt, null);
      assert.equal(a0.executionLockPurpose, purpose);
      assert.equal(await exists(f.lockFile), true);

      const argv = ARGV_BY_PURPOSE[purpose];
      await markExecutionAttempted(f.state, {
        journal: f.journal,
        stateDirectory: f.directory,
        purpose,
        recoveryNotBefore: RECOVERY_NOT_BEFORE,
        argv,
        stage: purpose === "TP_CANCEL" ? "cancel_execution_attempted" : "execution_attempted",
        now: () => Date.parse(RECOVERY_NOT_BEFORE) - 1,
      });
      const a1 = JSON.parse(await readFile(f.journal, "utf8"));
      assert.deepEqual(a1.executionArgv, argv);
      assert.equal(a1.executionArgvHash, sha256(argv));
      assert.equal(a1.executionAttemptedAt, "2026-07-22T08:04:59.999Z");
      assert.equal(a1.executionLockPath, f.lockFile);
      assert.equal(a1.executionLockPurpose, purpose);
      assert.equal(a1.reconciliationRequired, true);
      assert.equal(await exists(f.lockFile), true);
    } finally {
      await rm(f.directory, { recursive: true, force: true });
    }
  }
});

test("A1 marking rejects expiry equality and every lock-binding substitution without journal mutation", async () => {
  const cases = [
    ["expiry equality", null, Date.parse(RECOVERY_NOT_BEFORE), "execution_lock_boundary_elapsed"],
    ["purpose", (state) => { state.executionLockPurpose = "CLOSE_PLACE"; }, CLAIMED_AT_MS + 1, "lock_ownership_mismatch"],
    ["deadline", (state) => { state.executionLockRecoveryNotBefore = "2026-07-22T08:05:00.001Z"; }, CLAIMED_AT_MS + 1, "lock_ownership_mismatch"],
    ["generation", (state) => { state.executionLockGeneration = randomUUID(); }, CLAIMED_AT_MS + 1, "lock_ownership_mismatch"],
    ["hash", (state) => { state.executionLockHash = `0x${"cd".repeat(32)}`; }, CLAIMED_AT_MS + 1, "lock_ownership_mismatch"],
  ];
  for (const [label, mutate, now, code] of cases) {
    const f = await fixture("OPEN_PLACE", `conviction-v2-a1-substitution-${label.replaceAll(" ", "-")}-`);
    try {
      await claimAttached(f);
      if (mutate) {
        mutate(f.state);
        await writeFile(f.journal, `${JSON.stringify(f.state, null, 2)}\n`, { mode: 0o600 });
      }
      const before = await readFile(f.journal, "utf8");
      await assert.rejects(
        markExecutionAttempted(f.state, {
          journal: f.journal,
          stateDirectory: f.directory,
          purpose: "OPEN_PLACE",
          recoveryNotBefore: RECOVERY_NOT_BEFORE,
          argv: ARGV_BY_PURPOSE.OPEN_PLACE,
          now: () => now,
        }),
        (error) => error?.code === code,
        label,
      );
      assert.equal(await readFile(f.journal, "utf8"), before, label);
      assert.equal(await exists(f.lockFile), true, label);
    } finally {
      await rm(f.directory, { recursive: true, force: true });
    }
  }
});

test("legacy v1 is accepted only as an already-attached compatibility lock and is never unattached-recoverable", async () => {
  {
    const f = await fixture("OPEN_PLACE", "conviction-v1-attached-compatibility-");
    try {
      const v1 = {
        version: "conviction-polymarket-execution-lock-v1",
        journalPath: f.journal,
      };
      await writeLock(f.lockFile, v1);
      f.state.executionLockPath = f.lockFile;
      await writeReconciliationJournal(f.state, { directory: f.directory, file: f.journal });
      const checked = await verifyJournalLockOwnership(f.state, {
        stateDirectory: f.directory,
        journal: f.journal,
        fields: ["executionLockPath"],
        requirePresent: true,
      });
      assert.equal(checked[0].lockHash, sha256(v1));

      f.state.executionLockPurpose = "OPEN_PLACE";
      await writeReconciliationJournal(f.state, { directory: f.directory, file: f.journal });
      await assert.rejects(
        verifyJournalLockOwnership(f.state, {
          stateDirectory: f.directory,
          journal: f.journal,
          fields: ["executionLockPath"],
          requirePresent: true,
        }),
        (error) => error?.code === "lock_ownership_mismatch",
      );
    } finally {
      await rm(f.directory, { recursive: true, force: true });
    }
  }
  {
    const f = await fixture("OPEN_PLACE", "conviction-v1-unattached-denied-");
    try {
      await writeLock(f.lockFile, {
        version: "conviction-polymarket-execution-lock-v1",
        journalPath: f.journal,
      });
      await assert.rejects(
        reconcileUnattachedExecutionLock({
          file: f.lockFile,
          journal: f.journal,
          directory: f.directory,
          expectedJournalHash: sha256(f.state),
          expectedPurposes: ["OPEN_PLACE"],
        }),
        (error) => error?.code === "lock_ownership_mismatch",
      );
      assert.equal(await exists(f.lockFile), true);
    } finally {
      await rm(f.directory, { recursive: true, force: true });
    }
  }
});
