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

async function fixture(prefix = "conviction-release-durability-") {
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
    purpose: "OPEN_PLACE",
    recoveryNotBefore: DEADLINE,
    transition(next) { next.stage = "execution_lock_acquired"; },
  });
  return { directory, journal, lockFile, releaseFile, state };
}

test("release-guard publication failure is nondestructive before publish and resumable after publish", async () => {
  for (const phase of ["before-publish", "after-publish"]) {
    const f = await fixture(`conviction-release-guard-${phase}-`);
    try {
      const sourceJournal = await readFile(f.journal, "utf8");
      const sourceLock = await readFile(f.lockFile, "utf8");
      await assert.rejects(
        releaseReconciledLocks(f.state, {
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
        }),
        (error) => error?.code === `simulated_${phase.replace("-", "_")}`,
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
  const lockFile = join(directory, "generation.lock.json");
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
  const lockFile = join(directory, "generation.lock.json");
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
    await assert.rejects(delayed, (error) => error?.code === "exact_unlink_mismatch");
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
