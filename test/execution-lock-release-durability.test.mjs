import assert from "node:assert/strict";
import {
  access,
  chmod,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { sha256 } from "../src/canonical.mjs";
import {
  assertNoStateReleaseInProgress,
  claimExecutionLock,
  releaseReconciledLocks,
  resumePendingStateRelease,
  withStateReleaseMutex,
  writeReconciliationJournal,
} from "../scripts/buyer-orchestrator.mjs";

const ADVERSARY_HELPER = new URL("./fixtures/state-mutex-adversary.py", import.meta.url).pathname;
const DEADLINE = "2099-01-01T00:00:00.000Z";

async function exists(file) {
  try {
    await access(file);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

async function waitFor(file) {
  for (let attempt = 0; attempt < 1_000; attempt += 1) {
    if (await exists(file)) return;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 5));
  }
  throw new Error(`Timed out waiting for ${file}`);
}

async function fixture(prefix = "conviction-release-durability-", {
  purpose = "OPEN_PLACE",
} = {}) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), prefix)));
  await chmod(directory, 0o700);
  const journal = join(directory, "journey.json");
  const lockFile = join(directory, "polymarket-execution.lock.json");
  const releaseFile = join(directory, "polymarket-execution.release.lock.json");
  const state = {
    journalRevision: 0,
    journalPath: journal,
    mode: "open",
    stage: "execution_lock_acquired",
    executionLockPath: null,
    executionLockGeneration: null,
    executionLockHash: null,
    executionLockPurpose: null,
    executionLockRecoveryNotBefore: null,
    reconciliationRequired: true,
  };
  await writeReconciliationJournal(state, { directory, file: journal });
  await claimExecutionLock({
    journal,
    directory,
    file: lockFile,
    state,
    purpose,
    recoveryNotBefore: DEADLINE,
    transition(next) { next.stage = "execution_lock_acquired"; },
  });
  return { directory, journal, lockFile, releaseFile, state };
}

const CANCEL_ORDER_ID = `0x${"b7".repeat(32)}`;
const CANCEL_INTENT_HASH = `0x${"c8".repeat(32)}`;
const CANCEL_PASSPORT_HASH = `0x${"d9".repeat(32)}`;
const CANCEL_ATTEMPTED_AT = "2026-07-22T08:00:00.000Z";

async function takeProfitCancelFixture(prefix, { phase }) {
  const f = await fixture(prefix, { purpose: "TP_CANCEL" });
  Object.assign(f.state, {
    mode: "take_profit",
    action: "CANCEL",
    stage: phase === "attempted" ? "cancel_execution_attempted" : "cancel_execution_lock_acquired",
    reconciliationRequired: true,
    cancelExecution: {
      version: "conviction-take-profit-cancel-execution-v2",
      phase,
      orderId: CANCEL_ORDER_ID,
      intentHash: CANCEL_INTENT_HASH,
      takeProfitPassportHash: CANCEL_PASSPORT_HASH,
      executionLockGeneration: f.state.executionLockGeneration,
      executionLockHash: f.state.executionLockHash,
      attemptedAt: phase === "attempted" ? CANCEL_ATTEMPTED_AT : null,
    },
  });
  if (phase === "attempted") {
    f.state.cancelOutcome = {
      version: "conviction-take-profit-cancel-outcome-v1",
      orderId: CANCEL_ORDER_ID,
      status: "CANCELED",
      orderTerminal: true,
      settlementProofRequired: false,
    };
  }
  await writeReconciliationJournal(f.state, { directory: f.directory, file: f.journal });
  return f;
}

async function legacyV1Fixture(prefix) {
  const f = await fixture(prefix);
  const legacyLock = {
    version: "conviction-polymarket-execution-lock-v1",
    journalPath: f.journal,
  };
  await unlink(f.lockFile);
  await writeFile(f.lockFile, `${JSON.stringify(legacyLock, null, 2)}\n`, { mode: 0o600 });
  Object.assign(f.state, {
    stage: "legacy_execution_lock_acquired",
    executionLockPath: f.lockFile,
    executionLockGeneration: null,
    executionLockHash: null,
    executionLockPurpose: null,
    executionLockRecoveryNotBefore: null,
    reconciliationRequired: true,
  });
  await writeReconciliationJournal(f.state, { directory: f.directory, file: f.journal });
  return f;
}

function terminalCancelTransition(next, { releasedAt }) {
  next.cancelExecution.phase = "terminal";
  next.cancelExecution.terminalAt = releasedAt;
  next.reconciliationRequired = false;
}

function knownUnstartedCancelTransition(next, { releasedAt }) {
  next.cancelExecution.phase = "pre_spawn_failed";
  next.cancelExecution.failedAt = releasedAt;
  next.cancelError = {
    code: "take_profit_cancel_pre_spawn_failed",
    at: releasedAt,
    executionAmbiguous: false,
  };
  next.reconciliationRequired = false;
}

async function leaveGuardBeforeUnlink(f, {
  transition,
  transitionId,
  now = Date.parse("2026-07-22T08:00:01.000Z"),
} = {}) {
  await assert.rejects(
    releaseReconciledLocks(f.state, {
      stateDirectory: f.directory,
      journal: f.journal,
      fields: ["executionLockPath"],
      transition,
      transitionId,
      now: () => now,
      durableGuardPublishImpl: async (file, text) => {
        await writeFile(file, text, { mode: 0o600 });
        throw Object.assign(new Error("simulated crash after release-guard publication"), {
          code: "simulated_after_guard_publish",
          atomicPublishCompleted: true,
          atomicPublishedPath: file,
        });
      },
    }),
    (error) => error?.code === "simulated_after_guard_publish" && error?.releaseGuardRetained === true,
  );
  return JSON.parse(await readFile(f.releaseFile, "utf8"));
}

async function leaveGuardAfterUnlink(f, {
  transition,
  transitionId,
  now = Date.parse("2026-07-22T08:00:02.000Z"),
} = {}) {
  await assert.rejects(
    releaseReconciledLocks(f.state, {
      stateDirectory: f.directory,
      journal: f.journal,
      fields: ["executionLockPath"],
      transition,
      transitionId,
      now: () => now,
      writeState: async () => {
        throw Object.assign(new Error("simulated crash after guarded unlink"), {
          code: "simulated_after_guarded_unlink",
        });
      },
    }),
    (error) => error?.code === "simulated_after_guarded_unlink" && error?.releaseGuardRetained === true,
  );
  return JSON.parse(await readFile(f.releaseFile, "utf8"));
}

test("release-guard publication failure is nondestructive before publish and resumable after publish", async () => {
  for (const phase of ["before-publish", "after-publish"]) {
    const f = await fixture(`conviction-release-guard-${phase}-`);
    try {
      const sourceJournal = await readFile(f.journal, "utf8");
      const sourceLock = await readFile(f.lockFile, "utf8");
      const release = releaseReconciledLocks(f.state, {
          stateDirectory: f.directory,
          journal: f.journal,
          fields: ["executionLockPath"],
          transitionId: "test-release-guard-publication-v1",
          transition(next) { next.stage = "released"; },
          durableGuardPublishImpl: async (file, text) => {
            if (phase === "after-publish") await writeFile(file, text, { mode: 0o600 });
            throw Object.assign(new Error(`simulated ${phase}`), {
              code: `simulated_${phase.replace("-", "_")}`,
              atomicPublishCompleted: phase === "after-publish",
              atomicPublishedPath: phase === "after-publish" ? file : undefined,
            });
          },
      });
      await assert.rejects(
        release,
        (error) => error?.code === `simulated_${phase.replace("-", "_")}` &&
          (phase === "before-publish"
            ? error?.releaseGuardRetained !== true
            : error?.releaseGuardRetained === true),
      );
      assert.equal(await readFile(f.journal, "utf8"), sourceJournal);
      assert.equal(await readFile(f.lockFile, "utf8"), sourceLock);
      assert.equal(await exists(f.releaseFile), phase === "after-publish");

      const released = await releaseReconciledLocks(f.state, {
        stateDirectory: f.directory,
        journal: f.journal,
        fields: ["executionLockPath"],
        transitionId: "test-release-guard-publication-v1",
        transition(next) { next.stage = "released"; },
      });
      assert.deepEqual(released, [f.lockFile]);
      assert.equal(await exists(f.lockFile), false);
      assert.equal(await exists(f.releaseFile), false);
      assert.equal(JSON.parse(await readFile(f.journal, "utf8")).stage, "released");
    } finally {
      await rm(f.directory, { recursive: true, force: true });
    }
  }
});

test("generic restart resumes the guarded TP_CANCEL terminal transition before unlink without its label", async () => {
  const f = await takeProfitCancelFixture("conviction-generic-cancel-before-unlink-", { phase: "attempted" });
  try {
    const sourceText = await readFile(f.journal, "utf8");
    const lockText = await readFile(f.lockFile, "utf8");
    const guard = await leaveGuardBeforeUnlink(f, {
      transition: terminalCancelTransition,
      transitionId: "take-profit-cancel-terminal-release-v2",
    });
    assert.equal(await readFile(f.journal, "utf8"), sourceText);
    assert.equal(await readFile(f.lockFile, "utf8"), lockText);
    assert.equal(guard.targetState.cancelExecution.phase, "terminal");
    assert.equal(guard.targetState.cancelExecution.terminalAt, guard.claimedAt);
    assert.equal(guard.targetState.reconciliationRequired, false);

    const resumed = await resumePendingStateRelease({
      journal: f.journal,
      stateDirectory: f.directory,
    });
    assert.equal(resumed.resumed, true);
    assert.equal(resumed.completed, true);
    assert.deepEqual(resumed.released, [f.lockFile]);
    assert.deepEqual(JSON.parse(await readFile(f.journal, "utf8")), guard.targetState);
    assert.equal(await exists(f.lockFile), false);
    assert.equal(await exists(f.releaseFile), false);
  } finally {
    await rm(f.directory, { recursive: true, force: true });
  }
});

test("generic restart resumes a known-unstarted TP_CANCEL target after its lock was already unlinked", async () => {
  const f = await takeProfitCancelFixture("conviction-generic-cancel-after-unlink-", { phase: "lock_acquired" });
  try {
    const sourceText = await readFile(f.journal, "utf8");
    const guard = await leaveGuardAfterUnlink(f, {
      transition: knownUnstartedCancelTransition,
      transitionId: "take-profit-cancel-known-unstarted-v2",
    });
    assert.equal(await readFile(f.journal, "utf8"), sourceText);
    assert.equal(await exists(f.lockFile), false);
    assert.equal(guard.targetState.cancelExecution.phase, "pre_spawn_failed");
    assert.equal(guard.targetState.cancelExecution.failedAt, guard.claimedAt);
    assert.equal(guard.targetState.cancelError.executionAmbiguous, false);

    const resumed = await resumePendingStateRelease({
      journal: f.journal,
      stateDirectory: f.directory,
    });
    assert.equal(resumed.resumed, true);
    assert.equal(resumed.completed, true);
    assert.deepEqual(resumed.released, [f.lockFile]);
    assert.deepEqual(JSON.parse(await readFile(f.journal, "utf8")), guard.targetState);
    assert.equal(await exists(f.releaseFile), false);
  } finally {
    await rm(f.directory, { recursive: true, force: true });
  }
});

test("generic restart resumes an exact legacy v1 release after its lock was already unlinked", async () => {
  const f = await legacyV1Fixture("conviction-generic-legacy-v1-after-unlink-");
  try {
    const sourceText = await readFile(f.journal, "utf8");
    const guard = await leaveGuardAfterUnlink(f, {
      transitionId: "legacy-v1-known-unstarted-release-v1",
      transition(next, { releasedAt }) {
        next.stage = "legacy_pre_spawn_failed";
        next.legacyExecutionFailedAt = releasedAt;
        next.reconciliationRequired = false;
      },
    });
    assert.equal(await readFile(f.journal, "utf8"), sourceText);
    assert.equal(await exists(f.lockFile), false);
    assert.equal(guard.lockHashes.executionLockPath, sha256({
      version: "conviction-polymarket-execution-lock-v1",
      journalPath: f.journal,
    }));
    assert.equal(guard.targetState.executionLockHash, null);

    const resumed = await resumePendingStateRelease({
      journal: f.journal,
      stateDirectory: f.directory,
    });
    assert.equal(resumed.resumed, true);
    assert.equal(resumed.completed, true);
    assert.deepEqual(resumed.released, [f.lockFile]);
    assert.deepEqual(JSON.parse(await readFile(f.journal, "utf8")), guard.targetState);
    assert.equal(await exists(f.releaseFile), false);
  } finally {
    await rm(f.directory, { recursive: true, force: true });
  }
});

test("generic restart seeing the guarded target only removes the exact completed guard", async () => {
  const f = await takeProfitCancelFixture("conviction-generic-cancel-target-guard-", { phase: "attempted" });
  try {
    await assert.rejects(
      releaseReconciledLocks(f.state, {
        stateDirectory: f.directory,
        journal: f.journal,
        fields: ["executionLockPath"],
        transition: terminalCancelTransition,
        transitionId: "take-profit-cancel-terminal-release-v2",
        now: () => Date.parse("2026-07-22T08:00:03.000Z"),
        beforeGuardRelease: () => {
          throw Object.assign(new Error("simulated crash after guarded target write"), {
            code: "simulated_after_guarded_target",
          });
        },
      }),
      (error) => error?.code === "simulated_after_guarded_target" && error?.releaseGuardRetained === true,
    );
    const targetText = await readFile(f.journal, "utf8");
    const guardText = await readFile(f.releaseFile, "utf8");
    const guard = JSON.parse(guardText);
    assert.equal(sha256(JSON.parse(targetText)), guard.targetJournalHash);
    assert.equal(await exists(f.lockFile), false);

    const resumed = await resumePendingStateRelease({
      journal: f.journal,
      stateDirectory: f.directory,
    });
    assert.equal(resumed.resumed, true);
    assert.equal(resumed.completed, true);
    assert.deepEqual(resumed.released, []);
    assert.equal(await readFile(f.journal, "utf8"), targetText);
    assert.equal(await exists(f.releaseFile), false);
  } finally {
    await rm(f.directory, { recursive: true, force: true });
  }
});

test("generic restart rejects foreign journal, target, hash, fields, and execution generation substitutions", async () => {
  const cases = [
    {
      name: "foreign journal",
      mutate(guard, f) { guard.journalPath = join(f.directory, "foreign-journey.json"); },
      code: "state_release_guard_mismatch",
    },
    {
      name: "target",
      mutate(guard, f) {
        guard.targetState.executionLockPath = f.lockFile;
        guard.targetJournalHash = sha256(guard.targetState);
      },
      code: "state_release_guard_mismatch",
    },
    {
      name: "source hash",
      mutate(guard) { guard.sourceJournalHash = `0x${"41".repeat(32)}`; },
      code: "reconciliation_journal_changed",
    },
    {
      name: "fields",
      mutate(guard) {
        guard.fields = ["executionLockPath", "reservationLockPath"];
        guard.lockHashes.reservationLockPath = null;
      },
      code: "state_release_guard_mismatch",
    },
    {
      name: "execution generation",
      mutate(guard) { guard.lockHashes.executionLockPath = `0x${"52".repeat(32)}`; },
      code: "lock_generation_mismatch",
    },
  ];

  for (const entry of cases) {
    const f = await takeProfitCancelFixture(`conviction-generic-guard-${entry.name.replaceAll(" ", "-")}-`, {
      phase: "attempted",
    });
    try {
      const sourceText = await readFile(f.journal, "utf8");
      const lockText = await readFile(f.lockFile, "utf8");
      const guard = await leaveGuardBeforeUnlink(f, {
        transition: terminalCancelTransition,
        transitionId: "take-profit-cancel-terminal-release-v2",
      });
      entry.mutate(guard, f);
      const mutatedGuardText = `${JSON.stringify(guard, null, 2)}\n`;
      await writeFile(f.releaseFile, mutatedGuardText, { mode: 0o600 });

      await assert.rejects(
        resumePendingStateRelease({
          journal: f.journal,
          stateDirectory: f.directory,
        }),
        (error) => error?.code === entry.code,
        `${entry.name} substitution must fail closed`,
      );
      assert.equal(await readFile(f.journal, "utf8"), sourceText);
      assert.equal(await readFile(f.lockFile, "utf8"), lockText);
      assert.equal(await readFile(f.releaseFile, "utf8"), mutatedGuardText);
    } finally {
      await rm(f.directory, { recursive: true, force: true });
    }
  }
});

test("a post-rename journal result remains guarded until the exact durable target is acknowledged", async () => {
  const f = await fixture("conviction-release-post-rename-journal-");
  try {
    const oldLockText = await readFile(f.lockFile, "utf8");
    const sourceState = structuredClone(f.state);
    await assert.rejects(
      releaseReconciledLocks(f.state, {
        stateDirectory: f.directory,
        journal: f.journal,
        fields: ["executionLockPath"],
        transitionId: "test-post-rename-journal-v1",
        transition(next) { next.stage = "released"; },
        writeState: (next, options) => writeReconciliationJournal(next, {
          ...options,
          durableWriteImpl: async (file, text) => {
            const temporary = `${file}.post-rename`;
            await writeFile(temporary, text, { mode: 0o600 });
            await rename(temporary, file);
            throw Object.assign(new Error("journal writer lost result after rename"), {
              code: "simulated_post_rename_journal",
              atomicPublishCompleted: true,
              atomicPublishedPath: file,
            });
          },
        }),
      }),
      (error) => error?.code === "simulated_post_rename_journal" && error?.releaseGuardRetained === true,
    );
    assert.equal(await exists(f.lockFile), false);
    assert.equal(await exists(f.releaseFile), true);
    const durableTarget = JSON.parse(await readFile(f.journal, "utf8"));
    assert.equal(durableTarget.executionLockPath, null);
    assert.equal(durableTarget.stage, "released");
    assert.equal(sourceState.executionLockPath, f.lockFile);
    assert.equal(sha256(JSON.parse(oldLockText)), sourceState.executionLockHash);

    await assertNoStateReleaseInProgress({ directory: f.directory });
    assert.equal(await exists(f.releaseFile), false);
    assert.equal(JSON.parse(await readFile(f.journal, "utf8")).executionLockPath, null);
  } finally {
    await rm(f.directory, { recursive: true, force: true });
  }
});

test("mutex helper death before exact unlink leaves the generation intact and releases the kernel mutex", async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "conviction-mutex-helper-death-")));
  await chmod(directory, 0o700);
  const lockFile = join(directory, "polymarket-execution.lock.json");
  const lockText = "{\"generation\":\"one\"}\n";
  try {
    await writeFile(lockFile, lockText, { mode: 0o600 });
    await writeFile(join(directory, "mutex-helper-mode.txt"), "die-before-unlink\n", { mode: 0o600 });
    await assert.rejects(
      withStateReleaseMutex(directory, (lease) => lease.unlinkExact(lockFile, lockText), {
        helper: ADVERSARY_HELPER,
      }),
      (error) => error?.code === "state_release_mutex_lost",
    );
    assert.equal(await readFile(lockFile, "utf8"), lockText);

    await unlink(join(directory, "mutex-helper-mode.txt"));
    await withStateReleaseMutex(directory, (lease) => lease.unlinkExact(lockFile, lockText), {
      helper: ADVERSARY_HELPER,
    });
    assert.equal(await exists(lockFile), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a delayed helper keeps contenders out and refuses to unlink a fresh generation", async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "conviction-mutex-delayed-fence-")));
  await chmod(directory, 0o700);
  const lockFile = join(directory, "polymarket-execution.lock.json");
  const oldText = "{\"generation\":\"old\"}\n";
  const freshText = "{\"generation\":\"fresh\"}\n";
  const ready = join(directory, "mutex-helper.ready");
  const proceed = join(directory, "mutex-helper.go");
  try {
    await writeFile(lockFile, oldText, { mode: 0o600 });
    await writeFile(join(directory, "mutex-helper-mode.txt"), "delay-unlink\n", { mode: 0o600 });
    const delayed = withStateReleaseMutex(directory, (lease) => lease.unlinkExact(lockFile, oldText), {
      helper: ADVERSARY_HELPER,
    });
    const delayedRejection = assert.rejects(
      delayed,
      (error) => error?.code === "exact_unlink_mismatch",
    );
    await waitFor(ready);

    await assert.rejects(
      withStateReleaseMutex(directory, async () => {
        throw new Error("contender must never enter");
      }),
      (error) => error?.code === "execution_release_in_progress",
    );

    await unlink(lockFile);
    await writeFile(lockFile, freshText, { mode: 0o600 });
    await writeFile(proceed, "go\n", { mode: 0o600 });
    await delayedRejection;
    assert.equal(await readFile(lockFile, "utf8"), freshText);

    await unlink(join(directory, "mutex-helper-mode.txt"));
    await withStateReleaseMutex(directory, (lease) => lease.unlinkExact(lockFile, freshText), {
      helper: ADVERSARY_HELPER,
    });
    assert.equal(await exists(lockFile), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
