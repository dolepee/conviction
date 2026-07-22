import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access, chmod, mkdtemp, readFile, realpath, rm, stat, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { sha256 } from "../src/canonical.mjs";
import {
  claimCloseReplayLock,
  claimExecutionLock,
  claimOpenReplayLock,
  releaseReconciledLocks,
  withStateReleaseMutex,
  writeReconciliationJournal,
} from "../scripts/buyer-orchestrator.mjs";
import {
  claimTakeProfitReservation,
  writeTakeProfitState,
} from "../scripts/take-profit-orchestrator.mjs";

const CHILD = new URL("./fixtures/state-race-child.mjs", import.meta.url);
const REPLAY_KEY = `0x${"a7".repeat(32)}`;

async function pathExists(path) {
  try {
    await access(path);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

async function waitForPath(path) {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    if (await pathExists(path)) return;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 5));
  }
  throw new Error(`Timed out waiting for ${path}`);
}

function runChild(args) {
  const child = spawn(process.execPath, [CHILD.pathname, ...args], {
    cwd: new URL("..", import.meta.url).pathname,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  return new Promise((resolvePromise, rejectPromise) => {
    child.once("error", rejectPromise);
    child.once("exit", (code) => {
      const line = stdout.trim().split("\n").filter(Boolean).at(-1);
      let result;
      try { result = JSON.parse(line); } catch {
        return rejectPromise(new Error(`Race child returned invalid JSON (${code}): ${stdout}\n${stderr}`));
      }
      resolvePromise({ ...result, exitCode: code, stderr });
    });
  });
}

function startRawChild(args) {
  const child = spawn(process.execPath, [CHILD.pathname, ...args], {
    cwd: new URL("..", import.meta.url).pathname,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const completion = new Promise((resolvePromise, rejectPromise) => {
    child.once("error", rejectPromise);
    child.once("exit", (exitCode, signal) => resolvePromise({ exitCode, signal, stdout, stderr }));
  });
  return { child, completion };
}

async function fixture(prefix = "conviction-state-race-") {
  const directory = await realpath(await mkdtemp(join(tmpdir(), prefix)));
  await chmod(directory, 0o700);
  const journal = join(directory, "journey.json");
  const state = {
    journalRevision: 0,
    journalPath: journal,
    stage: "prepared",
    replayKey: null,
    replayLockPath: null,
    reservationLockPath: null,
    executionLockPath: null,
    reconciliationRequired: true,
  };
  await writeReconciliationJournal(state, { directory, file: journal });
  return { directory, journal, state };
}

test("real child processes cannot write between any lock claim and its durable attachment", async () => {
  for (const kind of ["open", "close", "execution", "reservation"]) {
    const f = await fixture(`conviction-${kind}-attach-race-`);
    try {
      const snapshot = join(f.directory, "stale-snapshot.json");
      await writeFile(snapshot, `${JSON.stringify(f.state, null, 2)}\n`, { mode: 0o600 });
      const ready = join(f.directory, "claim.ready");
      const proceed = join(f.directory, "claim.go");
      const claim = runChild(["claim", f.directory, f.journal, kind, ready, proceed]);
      await waitForPath(ready);

      const writer = await runChild(["write", f.directory, f.journal, snapshot, `${kind}-stale-writer`]);
      assert.equal(writer.ok, false);
      assert.equal(writer.error.code, "execution_release_in_progress");
      await writeFile(proceed, "go\n", { mode: 0o600 });
      const claimed = await claim;
      assert.equal(claimed.ok, true, claimed.stderr);

      const durable = JSON.parse(await readFile(f.journal, "utf8"));
      const field = kind === "open" || kind === "close"
        ? "replayLockPath"
        : kind === "reservation" ? "reservationLockPath" : "executionLockPath";
      assert.equal(durable[field], claimed.result.path);
      assert.equal(await pathExists(claimed.result.path), true);
      assert.equal(durable.writerMarker, undefined);
      assert.equal(durable.journalRevision, 2);
      if (["open", "close", "reservation"].includes(kind)) {
        assert.equal(durable.replayKey, REPLAY_KEY);
        assert.equal(durable.stage, "payment_authorization_starting");
      }
    } finally {
      await rm(f.directory, { recursive: true, force: true });
    }
  }
});

test("an ambiguous writer that persisted cannot make any claim delete its attached generation", async () => {
  for (const kind of ["open", "close", "execution", "reservation"]) {
    const f = await fixture(`conviction-${kind}-ambiguous-attach-`);
    try {
      const persistThenThrow = async (state, options) => {
        if (kind === "reservation") await writeTakeProfitState(state, options);
        else await writeReconciliationJournal(state, options);
        throw Object.assign(new Error("writer result was lost after rename"), { code: "simulated_writer_ambiguity" });
      };
      const claim = kind === "open" || kind === "close"
        ? (kind === "open" ? claimOpenReplayLock : claimCloseReplayLock)({
            key: REPLAY_KEY,
            journal: f.journal,
            directory: f.directory,
            state: f.state,
            writeState: persistThenThrow,
            transition: (next) => { next.replayKey = REPLAY_KEY; },
          })
        : kind === "reservation"
          ? claimTakeProfitReservation({
              key: REPLAY_KEY,
              journal: f.journal,
              directory: f.directory,
              state: f.state,
              writeState: persistThenThrow,
              transition: (next) => { next.replayKey = REPLAY_KEY; },
            })
          : claimExecutionLock({
              journal: f.journal,
              directory: f.directory,
              file: join(f.directory, "polymarket-execution.lock.json"),
              state: f.state,
              writeState: persistThenThrow,
            });
      await assert.rejects(claim, (error) => error?.code === "lock_attachment_ambiguous");
      const durable = JSON.parse(await readFile(f.journal, "utf8"));
      const field = kind === "open" || kind === "close"
        ? "replayLockPath"
        : kind === "reservation" ? "reservationLockPath" : "executionLockPath";
      assert.equal(typeof durable[field], "string");
      assert.equal(await pathExists(durable[field]), true);
      assert.equal(f.state[field], durable[field]);
      assert.equal(f.state.journalRevision, durable.journalRevision);
    } finally {
      await rm(f.directory, { recursive: true, force: true });
    }
  }
});

test("release, writer, and fresh claimant serialize across real OS processes and stale state cannot delete a new generation", async () => {
  const f = await fixture("conviction-release-writer-race-");
  try {
    await claimExecutionLock({
      journal: f.journal,
      directory: f.directory,
      file: join(f.directory, "polymarket-execution.lock.json"),
      state: f.state,
    });
    const firstLock = JSON.parse(await readFile(f.state.executionLockPath, "utf8"));
    const staleState = structuredClone(f.state);
    const snapshot = join(f.directory, "release-source.json");
    await writeFile(snapshot, `${JSON.stringify(staleState, null, 2)}\n`, { mode: 0o600 });
    const ready = join(f.directory, "release.ready");
    const release = runChild([
      "release",
      f.directory,
      f.journal,
      "executionLockPath",
      "pause-before-unlink",
      ready,
    ]);
    await waitForPath(ready);

    const [claimDuringRelease, writerDuringRelease] = await Promise.all([
      runChild(["claim-unattached-execution", f.directory, f.journal]),
      runChild(["write", f.directory, f.journal, snapshot, "racing-writer"]),
    ]);
    assert.equal(claimDuringRelease.ok, false);
    assert.equal(claimDuringRelease.error.code, "execution_release_in_progress");
    assert.equal(writerDuringRelease.ok, false);
    assert.equal(writerDuringRelease.error.code, "execution_release_in_progress");

    await writeFile(`${ready}.go`, "go\n", { mode: 0o600 });
    const released = await release;
    assert.equal(released.ok, true, released.stderr);
    const target = JSON.parse(await readFile(f.journal, "utf8"));
    assert.equal(target.executionLockPath, null);
    assert.equal(target.stage, "released");

    const staleWriterAfter = await runChild(["write", f.directory, f.journal, snapshot, "late-stale-writer"]);
    assert.equal(staleWriterAfter.ok, false);
    assert.equal(staleWriterAfter.error.code, "stale_journal_write");
    assert.deepEqual(JSON.parse(await readFile(f.journal, "utf8")), target);

    const fresh = await runChild(["claim-unattached-execution", f.directory, f.journal]);
    assert.equal(fresh.ok, true, fresh.stderr);
    assert.notEqual(fresh.result.lock.generation, firstLock.generation);
    const freshText = await readFile(fresh.result.path, "utf8");
    await assert.rejects(
      releaseReconciledLocks(staleState, {
        stateDirectory: f.directory,
        journal: f.journal,
        fields: ["executionLockPath"],
      }),
      (error) => error?.code === "reconciliation_journal_changed",
    );
    assert.equal(await readFile(fresh.result.path, "utf8"), freshText);
  } finally {
    await rm(f.directory, { recursive: true, force: true });
  }
});

test("a completed guarded release blocks contenders, then cleans exactly before a new generation", async () => {
  const f = await fixture("conviction-completed-guard-race-");
  try {
    await claimExecutionLock({
      journal: f.journal,
      directory: f.directory,
      file: join(f.directory, "polymarket-execution.lock.json"),
      state: f.state,
    });
    const first = JSON.parse(await readFile(f.state.executionLockPath, "utf8"));
    const ready = join(f.directory, "target.ready");
    const release = runChild([
      "release",
      f.directory,
      f.journal,
      "executionLockPath",
      "pause-crash-after-target",
      ready,
    ]);
    await waitForPath(ready);
    const contender = await runChild(["claim-unattached-execution", f.directory, f.journal]);
    assert.equal(contender.ok, false);
    assert.equal(contender.error.code, "execution_release_in_progress");
    await writeFile(`${ready}.go`, "go\n", { mode: 0o600 });
    const crashed = await release;
    assert.equal(crashed.ok, false);
    assert.equal(crashed.error.code, "simulated_after_target_crash");
    assert.equal(await pathExists(join(f.directory, "polymarket-execution.release.lock.json")), true);

    const next = await runChild(["claim-unattached-execution", f.directory, f.journal]);
    assert.equal(next.ok, true, next.stderr);
    assert.notEqual(next.result.lock.generation, first.generation);
    assert.equal(await pathExists(join(f.directory, "polymarket-execution.release.lock.json")), false);
  } finally {
    await rm(f.directory, { recursive: true, force: true });
  }
});

test("a catch-side child cleans an exact completed guard before advancing and cannot expose a fresh generation to stale release", async () => {
  const f = await fixture("conviction-completed-guard-writer-");
  try {
    await claimExecutionLock({
      journal: f.journal,
      directory: f.directory,
      file: join(f.directory, "polymarket-execution.lock.json"),
      state: f.state,
    });
    const first = JSON.parse(await readFile(f.state.executionLockPath, "utf8"));
    const staleSnapshot = join(f.directory, "stale-release-source.json");
    await writeFile(staleSnapshot, `${JSON.stringify(f.state, null, 2)}\n`, { mode: 0o600 });
    const ready = join(f.directory, "completed-target.ready");
    const release = runChild([
      "release",
      f.directory,
      f.journal,
      "executionLockPath",
      "pause-crash-after-target",
      ready,
    ]);
    await waitForPath(ready);
    const target = JSON.parse(await readFile(f.journal, "utf8"));
    const targetSnapshot = join(f.directory, "completed-target.json");
    await writeFile(targetSnapshot, `${JSON.stringify(target, null, 2)}\n`, { mode: 0o600 });
    await writeFile(`${ready}.go`, "go\n", { mode: 0o600 });
    const interrupted = await release;
    assert.equal(interrupted.ok, false);
    assert.equal(interrupted.error.code, "simulated_after_target_crash");
    const guard = join(f.directory, "polymarket-execution.release.lock.json");
    assert.equal(await pathExists(guard), true);

    const catchWriter = await runChild([
      "write",
      f.directory,
      f.journal,
      targetSnapshot,
      "catch-side-write",
    ]);
    assert.equal(catchWriter.ok, true, catchWriter.stderr);
    assert.equal(await pathExists(guard), false);
    const advanced = JSON.parse(await readFile(f.journal, "utf8"));
    assert.equal(advanced.journalRevision, target.journalRevision + 1);
    assert.equal(advanced.writerMarker, "catch-side-write");

    const fresh = await runChild(["claim", f.directory, f.journal, "execution"]);
    assert.equal(fresh.ok, true, fresh.stderr);
    const freshLockText = await readFile(fresh.result.path, "utf8");
    const freshLock = JSON.parse(freshLockText);
    assert.notEqual(freshLock.generation, first.generation);

    const staleRelease = await runChild([
      "release-snapshot",
      f.directory,
      f.journal,
      staleSnapshot,
      "executionLockPath",
    ]);
    assert.equal(staleRelease.ok, false);
    assert.equal(staleRelease.error.code, "reconciliation_journal_changed");
    assert.equal(await readFile(fresh.result.path, "utf8"), freshLockText);
  } finally {
    await rm(f.directory, { recursive: true, force: true });
  }
});

test("a source-state guard left by a hard-crashed child rejects writers unchanged and resumes exactly", async () => {
  const f = await fixture("conviction-source-guard-writer-");
  try {
    await claimExecutionLock({
      journal: f.journal,
      directory: f.directory,
      file: join(f.directory, "polymarket-execution.lock.json"),
      state: f.state,
    });
    const sourceText = await readFile(f.journal, "utf8");
    const sourceSnapshot = join(f.directory, "source-state.json");
    await writeFile(sourceSnapshot, sourceText, { mode: 0o600 });
    const ready = join(f.directory, "source-guard.ready");
    const crashing = startRawChild([
      "release",
      f.directory,
      f.journal,
      "executionLockPath",
      "pause-hard-crash-before-unlink",
      ready,
    ]);
    await waitForPath(ready);
    await writeFile(`${ready}.go`, "go\n", { mode: 0o600 });
    const crashed = await crashing.completion;
    assert.equal(crashed.signal, "SIGKILL");
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
    const guard = join(f.directory, "polymarket-execution.release.lock.json");
    assert.equal(await pathExists(guard), true);
    assert.equal(await pathExists(f.state.executionLockPath), true);

    const writer = await runChild([
      "write",
      f.directory,
      f.journal,
      sourceSnapshot,
      "must-not-persist",
    ]);
    assert.equal(writer.ok, false);
    assert.equal(writer.error.code, "execution_release_in_progress");
    assert.equal(await readFile(f.journal, "utf8"), sourceText);

    const resumed = await runChild([
      "release",
      f.directory,
      f.journal,
      "executionLockPath",
      "normal",
    ]);
    assert.equal(resumed.ok, true, resumed.stderr);
    assert.equal(await pathExists(guard), false);
    assert.equal(await pathExists(f.state.executionLockPath), false);
    const durable = JSON.parse(await readFile(f.journal, "utf8"));
    assert.equal(durable.executionLockPath, null);
    assert.equal(durable.stage, "released");
    assert.equal(durable.writerMarker, undefined);
  } finally {
    await rm(f.directory, { recursive: true, force: true });
  }
});

test("an unavailable mutex helper fails before callback or filesystem mutation", async () => {
  const parent = await mkdtemp(join(tmpdir(), "conviction-helper-unavailable-"));
  const directory = join(parent, "state-that-must-not-be-created");
  let called = false;
  try {
    await assert.rejects(
      withStateReleaseMutex(directory, async () => { called = true; }, {
        helper: join(parent, "missing-helper.py"),
      }),
      (error) => error?.code === "state_release_mutex_failed",
    );
    assert.equal(called, false);
    assert.equal(await pathExists(directory), false);
    const parentStat = await stat(parent);
    assert.equal(parentStat.isDirectory(), true);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("journal revision CAS rejects two stale copies even without a lock transition", async () => {
  const f = await fixture("conviction-journal-cas-");
  try {
    const first = structuredClone(f.state);
    const second = structuredClone(f.state);
    first.marker = "first";
    await writeReconciliationJournal(first, { directory: f.directory, file: f.journal });
    second.marker = "second";
    await assert.rejects(
      writeReconciliationJournal(second, { directory: f.directory, file: f.journal }),
      (error) => error?.code === "stale_journal_write",
    );
    const durable = JSON.parse(await readFile(f.journal, "utf8"));
    assert.equal(durable.marker, "first");
    assert.equal(durable.journalRevision, 2);
    assert.equal(sha256(durable), sha256(first));
  } finally {
    await rm(f.directory, { recursive: true, force: true });
  }
});

test("standalone journal writes reject invalid guards and forged release capabilities without mutation", async () => {
  const f = await fixture("conviction-invalid-guard-writer-");
  try {
    const sourceText = await readFile(f.journal, "utf8");
    const snapshot = join(f.directory, "source-state.json");
    await writeFile(snapshot, sourceText, { mode: 0o600 });
    const guard = join(f.directory, "polymarket-execution.release.lock.json");
    await writeFile(guard, "{\"version\":\"invalid-guard\"}\n", { mode: 0o600 });
    const invalidGuardWriter = await runChild([
      "write",
      f.directory,
      f.journal,
      snapshot,
      "must-not-persist",
    ]);
    assert.equal(invalidGuardWriter.ok, false);
    assert.equal(invalidGuardWriter.error.code, "execution_release_in_progress");
    assert.equal(await readFile(f.journal, "utf8"), sourceText);
    await unlink(guard);

    const source = JSON.parse(sourceText);
    const unrelatedTarget = {
      ...source,
      journalRevision: source.journalRevision + 1,
      writerMarker: "unrelated-release-target",
    };
    const mismatchedGuardText = `${JSON.stringify({
      version: "conviction-state-release-guard-v1",
      journalPath: f.journal,
      sourceJournalHash: `0x${"1".repeat(64)}`,
      targetJournalHash: sha256(unrelatedTarget),
      targetState: unrelatedTarget,
      transitionId: `0x${"2".repeat(64)}`,
      fields: ["executionLockPath"],
      lockHashes: { executionLockPath: null },
      pid: process.pid,
      claimedAt: new Date().toISOString(),
    }, null, 2)}\n`;
    await writeFile(guard, mismatchedGuardText, { mode: 0o600 });
    const mismatchedGuardWriter = await runChild([
      "write",
      f.directory,
      f.journal,
      snapshot,
      "must-not-persist-either",
    ]);
    assert.equal(mismatchedGuardWriter.ok, false);
    assert.equal(mismatchedGuardWriter.error.code, "execution_release_in_progress");
    assert.equal(await readFile(f.journal, "utf8"), sourceText);
    assert.equal(await readFile(guard, "utf8"), mismatchedGuardText);
    await unlink(guard);

    const forged = JSON.parse(sourceText);
    forged.writerMarker = "forged-capability";
    await assert.rejects(
      writeReconciliationJournal(forged, {
        directory: f.directory,
        file: f.journal,
        releaseCapability: Object.freeze({}),
      }),
      (error) => error?.code === "state_release_guard_mismatch",
    );
    assert.equal(await readFile(f.journal, "utf8"), sourceText);
  } finally {
    await rm(f.directory, { recursive: true, force: true });
  }
});

test("a missing lock is recoverable only with its exact pre-existing release guard", async () => {
  const f = await fixture("conviction-unexplained-missing-lock-");
  try {
    await claimExecutionLock({
      journal: f.journal,
      directory: f.directory,
      file: join(f.directory, "polymarket-execution.lock.json"),
      state: f.state,
    });
    const before = await readFile(f.journal, "utf8");
    await unlink(f.state.executionLockPath);
    await assert.rejects(
      releaseReconciledLocks(f.state, {
        stateDirectory: f.directory,
        journal: f.journal,
        fields: ["executionLockPath"],
      }),
      (error) => error?.code === "lock_ownership_mismatch",
    );
    assert.equal(await readFile(f.journal, "utf8"), before);
    assert.equal(await pathExists(join(f.directory, "polymarket-execution.release.lock.json")), false);
  } finally {
    await rm(f.directory, { recursive: true, force: true });
  }
});

test("a lock disappearing after ownership verification is never treated as a crash resume", async () => {
  const f = await fixture("conviction-mid-release-missing-lock-");
  try {
    await claimExecutionLock({
      journal: f.journal,
      directory: f.directory,
      file: join(f.directory, "polymarket-execution.lock.json"),
      state: f.state,
    });
    const before = await readFile(f.journal, "utf8");
    await assert.rejects(
      releaseReconciledLocks(f.state, {
        stateDirectory: f.directory,
        journal: f.journal,
        fields: ["executionLockPath"],
        beforeUnlink: () => unlink(f.state.executionLockPath),
      }),
      (error) => error?.code === "lock_generation_mismatch",
    );
    assert.equal(await readFile(f.journal, "utf8"), before);
    assert.equal(await pathExists(join(f.directory, "polymarket-execution.release.lock.json")), false);
  } finally {
    await rm(f.directory, { recursive: true, force: true });
  }
});

test("a resolved TP fill crash resumes its guarded evidence even when a later refetch differs", async () => {
  const f = await fixture("conviction-dynamic-fill-resume-");
  try {
    await claimExecutionLock({
      journal: f.journal,
      directory: f.directory,
      file: join(f.directory, "polymarket-execution.lock.json"),
      state: f.state,
    });
    const firstEvidence = {
      proofHash: `0x${"31".repeat(32)}`,
      fetchedAt: "2026-07-22T12:00:00.000Z",
    };
    await assert.rejects(
      releaseReconciledLocks(f.state, {
        stateDirectory: f.directory,
        journal: f.journal,
        fields: ["executionLockPath"],
        transitionId: "take-profit-lifecycle-reconciliation-v1",
        now: () => Date.parse(firstEvidence.fetchedAt),
        transition: (next) => {
          next.latestFillProof = firstEvidence;
          next.latestFillProofHash = firstEvidence.proofHash;
          next.reconciliationRequired = false;
        },
        writeState: async () => {
          throw Object.assign(new Error("simulated crash after unlink"), {
            code: "simulated_fill_release_crash",
          });
        },
      }),
      (error) => error?.code === "simulated_fill_release_crash",
    );
    assert.equal(await pathExists(f.state.executionLockPath), false);

    const laterEvidence = {
      proofHash: `0x${"32".repeat(32)}`,
      fetchedAt: "2026-07-22T12:00:01.000Z",
    };
    await releaseReconciledLocks(f.state, {
      stateDirectory: f.directory,
      journal: f.journal,
      fields: ["executionLockPath"],
      transitionId: "take-profit-lifecycle-reconciliation-v1",
      now: () => Date.parse(laterEvidence.fetchedAt),
      transition: (next) => {
        next.latestFillProof = laterEvidence;
        next.latestFillProofHash = laterEvidence.proofHash;
        next.reconciliationRequired = false;
      },
    });
    const durable = JSON.parse(await readFile(f.journal, "utf8"));
    assert.deepEqual(durable.latestFillProof, firstEvidence);
    assert.equal(durable.latestFillProofHash, firstEvidence.proofHash);
    assert.equal(durable.executionLockPath, null);
    assert.equal(durable.reconciliationRequired, false);
  } finally {
    await rm(f.directory, { recursive: true, force: true });
  }
});
