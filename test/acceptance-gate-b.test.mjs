import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

test("Gate B offline mode stays network-free and fail-closed", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "conviction-gate-b-"));
  const reportPath = path.join(directory, "report.json");
  try {
    const result = spawnSync(process.execPath, [
      "scripts/acceptance-gate-b.mjs",
      "--offline",
      "--report",
      reportPath,
    ], {
      cwd: path.resolve(import.meta.dirname, ".."),
      encoding: "utf8",
      timeout: 15_000,
      env: {
        PATH: process.env.PATH,
        HOME: directory,
        // If offline mode regresses into a fetch, these invalid endpoints make
        // the test fail instead of reaching a live service or chain.
        POLYGON_RPC_URL: "http://127.0.0.1:1",
        XLAYER_RPC_URL: "http://127.0.0.1:1",
      },
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const report = JSON.parse(readFileSync(reportPath, "utf8"));
    assert.match(report.verdict, /^NO FAILURES/);
    assert.equal(report.results.filter((entry) => entry.status === "PASS").length, 7);
    assert.equal(report.results.filter((entry) => entry.status === "FAIL").length, 0);
    assert.equal(report.results.filter((entry) => entry.status === "PENDING").length, 6);
    assert.equal(JSON.stringify(report).includes("paidCard"), false);
    assert.equal(JSON.stringify(report).includes("sourcePosition"), false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("Gate B accepts the canonical retrospective public OPEN deliverable as a source", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "conviction-gate-b-source-"));
  const reportPath = path.join(directory, "report.json");
  const sourcePath = path.resolve(import.meta.dirname, "..", "assets", "conviction-review-deliverable.json");
  try {
    const result = spawnSync(process.execPath, [
      "scripts/acceptance-gate-b.mjs",
      "--offline",
      "--source-proof",
      sourcePath,
      "--report",
      reportPath,
    ], {
      cwd: path.resolve(import.meta.dirname, ".."),
      encoding: "utf8",
      timeout: 15_000,
      env: { PATH: process.env.PATH, HOME: directory },
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const report = JSON.parse(readFileSync(reportPath, "utf8"));
    assert.match(report.verdict, /^NO FAILURES/);
    assert.equal(report.results.some((entry) => entry.id === "S1" && entry.status === "PASS"), true);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("Gate B does not kill a paid checkpoint on a pre-payment wall-clock timer", () => {
  const source = readFileSync(
    path.resolve(import.meta.dirname, "..", "scripts", "acceptance-gate-b.mjs"),
    "utf8",
  );
  assert.doesNotMatch(source, /child\.kill\(["']SIGKILL["']\)/);
  assert.match(source, /paymentToProofMs = Number\(provedEvent\?\.at\) - Number\(paidEvent\?\.at\)/);
  assert.doesNotMatch(source, /journey\.wallMs < 120_000/);
});
