import assert from "node:assert/strict";
import test from "node:test";

import { localSourceEvidence } from "../src/source-evidence.mjs";

const COMMIT = "ab".repeat(20);

test("source evidence binds a clean exact commit", () => {
  const calls = [];
  const evidence = localSourceEvidence({
    cwd: "/repo",
    execFileSyncImpl(_command, args, options) {
      calls.push({ args, options });
      return args[0] === "rev-parse" ? `${COMMIT}\n` : "";
    },
  });
  assert.deepEqual(evidence, {
    commit: COMMIT,
    trackedTreeClean: true,
  });
  assert.deepEqual(calls.map(({ args }) => args), [
    ["rev-parse", "HEAD"],
    ["status", "--porcelain", "--untracked-files=no"],
  ]);
});

test("source evidence exposes tracked changes and rejects invalid commits", () => {
  const dirty = localSourceEvidence({
    cwd: "/repo",
    execFileSyncImpl(_command, args) {
      return args[0] === "rev-parse" ? `${COMMIT}\n` : " M src/file.mjs\n";
    },
  });
  assert.equal(dirty.trackedTreeClean, false);

  assert.throws(
    () => localSourceEvidence({
      cwd: "/repo",
      execFileSyncImpl(_command, args) {
        return args[0] === "rev-parse" ? "not-a-commit" : "";
      },
    }),
    /commit is invalid/,
  );
});
