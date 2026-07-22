import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import test from "node:test";

test("Gate C offline mode stays network-free and fail-closed", () => {
  const result = spawnSync(process.execPath, [
    path.resolve(import.meta.dirname, "..", "scripts", "acceptance-gate-c.mjs"),
    "--offline",
  ], {
    cwd: path.resolve(import.meta.dirname, ".."),
    encoding: "utf8",
    timeout: 20_000,
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /5\.1\s+Substituted outcome token fails before placement/);
  assert.match(result.stdout, /5\.5\s+Manager payment alone never authorizes a TAKE_PROFIT/);
  assert.match(result.stdout, /5\.7\s+An OPEN-priced x402 challenge cannot authorize TAKE_PROFIT/);
  assert.match(result.stdout, /NO FAILURES \(6 pending; Gate C undecided\)/);
  assert.doesNotMatch(result.stdout, /FAIL\s/);
});
