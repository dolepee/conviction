import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

test("Gate A measures payment-to-proof rather than pre-payment wall time", () => {
  const source = readFileSync(
    path.resolve(import.meta.dirname, "..", "scripts", "acceptance-gate.mjs"),
    "utf8",
  );
  assert.match(source, /evaluateFilledOrderAcceptanceTiming/);
  assert.match(source, /const gateStartedAt = Date\.now\(\)/);
  assert.match(source, /earliestAllowedTime: new Date\(gateStartedAt\)\.toISOString\(\)/);
  assert.doesNotMatch(source, /child\.kill\(["']SIGKILL["']\)/);
  assert.doesNotMatch(source, /journey\.wallMs < 120_000/);
  assert.doesNotMatch(source, /s wall \/ /);
});
