#!/usr/bin/env node

import { access, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import {
  claimExecutionLock,
  claimCloseReplayLock,
  claimOpenReplayLock,
  releaseReconciledLocks,
  writeReconciliationJournal,
} from "../../scripts/buyer-orchestrator.mjs";
import {
  claimTakeProfitReservation,
  writeTakeProfitState,
} from "../../scripts/take-profit-orchestrator.mjs";

const [command, directory, journal, first, second, third] = process.argv.slice(2);
const RACE_REPLAY_KEY = `0x${"a7".repeat(32)}`;

async function waitFor(file) {
  for (;;) {
    try {
      await access(file);
      return;
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 5));
    }
  }
}

async function pause(ready, proceed) {
  await writeFile(ready, "ready\n", { mode: 0o600 });
  await waitFor(proceed);
}

async function main() {
  if (!command) return { fixture: true };
  if (command === "write") {
    const state = JSON.parse(await readFile(first, "utf8"));
    state.writerMarker = second || "writer";
    await writeReconciliationJournal(state, { directory, file: journal });
    return { revision: state.journalRevision, marker: state.writerMarker };
  }

  if (command === "claim") {
    const [kind, ready, proceed] = [first, second, third];
    const state = JSON.parse(await readFile(journal, "utf8"));
    const beforePersist = ready && proceed ? () => pause(ready, proceed) : undefined;
    let path;
    if (kind === "execution") {
      path = await claimExecutionLock({
        journal,
        directory,
        file: join(directory, "polymarket-execution.lock.json"),
        state,
        beforePersist,
        transition: (next) => { next.stage = "execution_claimed"; },
      });
    } else if (kind === "open") {
      path = await claimOpenReplayLock({
        key: RACE_REPLAY_KEY,
        journal,
        directory,
        state,
        beforePersist,
        transition: (next) => {
          next.replayKey = RACE_REPLAY_KEY;
          next.stage = "payment_authorization_starting";
        },
      });
    } else if (kind === "close") {
      path = await claimCloseReplayLock({
        key: RACE_REPLAY_KEY,
        journal,
        directory,
        state,
        beforePersist,
        transition: (next) => {
          next.replayKey = RACE_REPLAY_KEY;
          next.stage = "payment_authorization_starting";
        },
      });
    } else if (kind === "reservation") {
      path = await claimTakeProfitReservation({
        key: RACE_REPLAY_KEY,
        journal,
        directory,
        state,
        writeState: writeTakeProfitState,
        beforePersist,
        transition: (next) => {
          next.replayKey = RACE_REPLAY_KEY;
          next.stage = "payment_authorization_starting";
        },
      });
    } else {
      throw Object.assign(new Error("Unknown claim kind"), { code: "invalid_test_command" });
    }
    return { path, revision: state.journalRevision, stage: state.stage };
  }

  if (command === "claim-unattached-execution") {
    const path = await claimExecutionLock({
      journal,
      directory,
      file: join(directory, "polymarket-execution.lock.json"),
    });
    return { path, lock: JSON.parse(await readFile(path, "utf8")) };
  }

  if (command === "release") {
    const [fieldsText, mode, ready] = [first, second, third];
    const state = JSON.parse(await readFile(journal, "utf8"));
    const fields = fieldsText.split(",").filter(Boolean);
    const proceed = ready ? `${ready}.go` : null;
    const options = {
      stateDirectory: directory,
      journal,
      fields,
      now: () => Date.parse("2026-07-22T12:00:00.000Z"),
      transition: (next) => {
        next.stage = "released";
        next.reconciliationRequired = false;
      },
    };
    if (mode === "pause-before-unlink") {
      options.beforeUnlink = () => pause(ready, proceed);
    }
    if (mode === "crash-after-target" || mode === "pause-crash-after-target") {
      options.beforeGuardRelease = async () => {
        if (ready) await writeFile(ready, "target-durable\n", { mode: 0o600 });
        if (mode === "pause-crash-after-target") await waitFor(proceed);
        throw Object.assign(new Error("simulated crash after durable target"), {
          code: "simulated_after_target_crash",
        });
      };
    }
    const released = await releaseReconciledLocks(state, options);
    return { released, revision: state.journalRevision, stage: state.stage };
  }

  throw Object.assign(new Error("Unknown child command"), { code: "invalid_test_command" });
}

try {
  const result = await main();
  process.stdout.write(`${JSON.stringify({ ok: true, result })}\n`);
} catch (error) {
  process.stdout.write(`${JSON.stringify({
    ok: false,
    error: { code: error?.code || "child_failed", message: error?.message || String(error) },
  })}\n`);
  process.exitCode = 1;
}
