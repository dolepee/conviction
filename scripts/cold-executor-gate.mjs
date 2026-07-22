#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { EXECUTOR_RELEASE, EXECUTOR_RELEASE_HASH } from "../src/executor-discovery.mjs";

const install = process.argv.slice(2).includes("--install");
const unexpected = process.argv.slice(2).filter((value) => value !== "--install");
if (unexpected.length) throw Object.assign(new Error(`Unknown argument: ${unexpected[0]}`), { code: "invalid_input" });

function run(program, argv, options = {}) {
  return execFileSync(program, argv, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
    ...options,
  }).trim();
}

const root = await mkdtemp(join(tmpdir(), "conviction-cold-executor-"));
try {
  run("git", ["init", "--quiet", root]);
  run("git", ["-C", root, "remote", "add", "origin", EXECUTOR_RELEASE.source.repository]);
  run("git", ["-C", root, "fetch", "--quiet", "--depth", "1", "origin", EXECUTOR_RELEASE.source.commit]);
  run("git", ["-C", root, "checkout", "--quiet", "--detach", "FETCH_HEAD"]);
  const commit = run("git", ["-C", root, "rev-parse", "HEAD"]);
  if (commit !== EXECUTOR_RELEASE.source.commit) {
    throw Object.assign(new Error("Cold fetch resolved to a different executor commit"), { code: "executor_source_mismatch" });
  }

  const skill = await readFile(join(root, EXECUTOR_RELEASE.source.skillPath), "utf8");
  if (!skill.includes("# Conviction Executor") || !skill.includes("confirm live mode")) {
    throw Object.assign(new Error("Pinned checkout does not contain the expected executor skill"), { code: "executor_skill_mismatch" });
  }

  let runtime = null;
  if (install) {
    run("npm", ["ci"], { cwd: root });
    runtime = JSON.parse(run("npm", ["run", "--silent", "runtime:install"], { cwd: root }));
    if (runtime?.ok !== true || !/^[0-9a-f]{64}$/.test(String(runtime?.binarySha256 || ""))) {
      throw Object.assign(new Error("Cold executor runtime did not install with a released digest"), { code: "executor_runtime_unverified" });
    }
  }

  process.stdout.write(`${JSON.stringify({
    ok: true,
    mode: install ? "install" : "fetch",
    checkoutWasPreexisting: false,
    commit,
    skillPath: EXECUTOR_RELEASE.source.skillPath,
    executorReleaseHash: EXECUTOR_RELEASE_HASH,
    runtimeBinarySha256: runtime?.binarySha256 || null,
  })}\n`);
} finally {
  // The pinned runtime installer deliberately makes its release directory and
  // binary read-only. Restore owner write permission only inside this isolated
  // temporary checkout so cleanup works consistently on Linux and macOS.
  try {
    run("chmod", ["-R", "u+w", root]);
  } catch {
    // Preserve the original gate result; rm below remains the cleanup authority.
  }
  await rm(root, { recursive: true, force: true });
}
