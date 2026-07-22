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
