import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  inspectPolymarketRuntime,
  POLYMARKET_RUNTIME_ARTIFACTS,
  POLYMARKET_RUNTIME_COMMIT,
  POLYMARKET_RUNTIME_REPOSITORY,
  POLYMARKET_RUNTIME_VERSION,
  polymarketRuntimeEvidence,
  polymarketRuntimeEvidenceFromInspection,
  polymarketRuntimePaths,
  resolvePolymarketRuntime,
  resolvePolymarketPluginCommand,
} from "../src/polymarket-runtime.mjs";

const sha256 = (value) => createHash("sha256").update(value).digest("hex");

async function fixture({ platform = "darwin", arch = "arm64", mutate = (value) => value } = {}) {
  const repositoryRoot = await mkdtemp(join(tmpdir(), "conviction-runtime-test-"));
  const paths = polymarketRuntimePaths({ repositoryRoot, platform, arch });
  await mkdir(paths.directory, { recursive: true, mode: 0o700 });
  await chmod(paths.root, 0o700);
  await chmod(paths.platformDirectory, 0o700);
  const bytes = Buffer.from("fixture-runtime");
  const artifact = {
    binarySha256: sha256(bytes),
    cargoLockSha256: "1".repeat(64),
    rustcVersion: "rustc fixture",
    cargoVersion: "cargo fixture",
  };
  await writeFile(paths.binary, bytes, { mode: 0o500 });
  await chmod(paths.binary, 0o500);
  const manifest = mutate({
    version: "conviction-polymarket-runtime-v2",
    runtimeVersion: POLYMARKET_RUNTIME_VERSION,
    sourceRepository: POLYMARKET_RUNTIME_REPOSITORY,
    sourceCommit: POLYMARKET_RUNTIME_COMMIT,
    cargoLockSha256: artifact.cargoLockSha256,
    rustcVersion: artifact.rustcVersion,
    cargoVersion: artifact.cargoVersion,
    platform,
    arch,
    binarySha256: artifact.binarySha256,
  });
  await writeFile(paths.manifest, JSON.stringify(manifest), { mode: 0o400 });
  await chmod(paths.manifest, 0o400);
  await chmod(paths.directory, 0o500);
  return { repositoryRoot, paths, artifacts: { [`${platform}-${arch}`]: artifact } };
}

function assertTokensInOrder(source, tokens, label) {
  let cursor = -1;
  for (const token of tokens) {
    const index = source.indexOf(token, cursor + 1);
    assert.ok(index >= 0, `${label}: missing ${token}`);
    assert.ok(index > cursor, `${label}: ${token} is out of order`);
    cursor = index;
  }
}

test("runtime paths bind platform, architecture, commit, and Windows suffix", () => {
  const unix = polymarketRuntimePaths({ repositoryRoot: "/repo", platform: "linux", arch: "x64" });
  assert.match(unix.binary, /linux-x64.*49c952b98037f676b484625a4f389b42071213e7.*polymarket-plugin$/);
  const windows = polymarketRuntimePaths({ repositoryRoot: "C:\\repo", platform: "win32", arch: "x64" });
  assert.match(windows.binary, /polymarket-plugin\.exe$/);
});

test("release artifacts include the clean hosted Linux x64 runtime", () => {
  assert.deepEqual(POLYMARKET_RUNTIME_ARTIFACTS["linux-x64"], {
    binarySha256: "fe198147c99311c8ff52fa198da9437068543b937d6eca12256d1d41349f6d18",
    cargoLockSha256: "5edf618dc5870a868ea32c758c64831b1039a486b17e922fe9053878dd771627",
    rustcVersion: "rustc 1.96.1 (31fca3adb 2026-06-26)",
    cargoVersion: "cargo 1.96.1 (356927216 2026-06-26)",
  });
});

test("resolver returns only a release-digest verified absolute binary and ignores PATH", async () => {
  const { repositoryRoot, paths, artifacts } = await fixture();
  assert.equal(resolvePolymarketPluginCommand({
    repositoryRoot,
    platform: "darwin",
    arch: "arm64",
    artifacts,
    env: { PATH: "/attacker/first" },
  }), paths.binary);
});

test("resolver rejects relative overrides", () => {
  assert.throws(
    () => resolvePolymarketPluginCommand({ env: { CONVICTION_POLYMARKET_PLUGIN_BIN: "./plugin" } }),
    (error) => error?.code === "invalid_runtime_override",
  );
});

test("a later resolution rejects runtime bytes substituted after an initial verified inspection", async () => {
  const value = await fixture();
  try {
    const initial = inspectPolymarketRuntime({
      ...value.paths,
      platform: "darwin",
      arch: "arm64",
      artifacts: value.artifacts,
    });
    assert.equal(initial.ok, true);

    await chmod(value.paths.directory, 0o700);
    await chmod(value.paths.binary, 0o700);
    await writeFile(value.paths.binary, "substituted-after-inspection");
    await chmod(value.paths.binary, 0o500);
    await chmod(value.paths.directory, 0o500);

    assert.throws(
      () => resolvePolymarketRuntime({
        repositoryRoot: value.repositoryRoot,
        platform: "darwin",
        arch: "arm64",
        artifacts: value.artifacts,
        env: {},
      }),
      (error) => error?.code === "runtime_release_digest_mismatch",
    );
  } finally {
    await chmod(value.paths.directory, 0o700).catch(() => {});
    await rm(value.repositoryRoot, { recursive: true, force: true });
  }
});

test("runtime verification rejects wrong provenance, byte substitution, and symlinks", async () => {
  const wrong = await fixture({ mutate: (value) => ({ ...value, sourceCommit: "0".repeat(40) }) });
  assert.equal(inspectPolymarketRuntime({ ...wrong.paths, platform: "darwin", arch: "arm64", artifacts: wrong.artifacts }).code, "runtime_release_digest_mismatch");

  const mismatch = await fixture();
  await chmod(mismatch.paths.directory, 0o700);
  await chmod(mismatch.paths.binary, 0o700);
  await writeFile(mismatch.paths.binary, "changed");
  await chmod(mismatch.paths.binary, 0o500);
  await chmod(mismatch.paths.directory, 0o500);
  assert.equal(inspectPolymarketRuntime({ ...mismatch.paths, platform: "darwin", arch: "arm64", artifacts: mismatch.artifacts }).code, "runtime_release_digest_mismatch");

  const linked = await fixture();
  await chmod(linked.paths.directory, 0o700);
  const target = `${linked.paths.binary}.real`;
  await writeFile(target, "fixture-runtime", { mode: 0o500 });
  await unlink(linked.paths.binary);
  await symlink(target, linked.paths.binary);
  await chmod(linked.paths.directory, 0o500);
  assert.equal(inspectPolymarketRuntime({ ...linked.paths, platform: "darwin", arch: "arm64", artifacts: linked.artifacts }).code, "runtime_binary_symlink_refused");
});

test("runtime verification rejects unsafe ancestor permissions", async () => {
  const value = await fixture();
  await chmod(value.paths.platformDirectory, 0o755);
  assert.equal(inspectPolymarketRuntime({ ...value.paths, platform: "darwin", arch: "arm64", artifacts: value.artifacts }).code, "runtime_platform_directory_mode_mismatch");
});

test("every executable orchestrator resolves immediately instead of caching PATH or a pathname", async () => {
  for (const file of ["buyer-orchestrator.mjs", "take-profit-orchestrator.mjs"]) {
    const source = await readFile(new URL(`../scripts/${file}`, import.meta.url), "utf8");
    assert.match(source, /resolvePolymarketRuntime\(\)/);
    assert.doesNotMatch(source, /resolvedPolymarketPluginCommand/);
    assert.doesNotMatch(source, /commandJson(?:Impl)?\(\s*["']polymarket-plugin["']/);
  }
});

test("buyer and TAKE_PROFIT success surfaces return the runtime evidence persisted before spawn", async () => {
  const buyerSource = await readFile(new URL("../scripts/buyer-orchestrator.mjs", import.meta.url), "utf8");
  assertTokensInOrder(buyerSource, [
    "const persistedRuntime = resolvePolymarketRuntime();",
    "checkpoint.executionRuntime = polymarketRuntimeEvidenceFromInspection(persistedRuntime);",
    "await writeReconciliationJournal(checkpoint);",
    "const launchRuntime = resolvePolymarketRuntime();",
    "result = await commandJson(launchRuntime.binary",
    "checkpoint.liveResult = result;",
    "executionRuntime: checkpoint.executionRuntime",
  ], "buyer live runtime binding");

  const takeProfitSource = await readFile(new URL("../scripts/take-profit-orchestrator.mjs", import.meta.url), "utf8");
  const placementStart = takeProfitSource.indexOf("const persistedRuntime = resolvePolymarketRuntime();");
  assert.ok(placementStart >= 0, "TAKE_PROFIT live runtime binding: missing placement runtime resolution");
  assertTokensInOrder(takeProfitSource.slice(placementStart), [
    "const persistedRuntime = resolvePolymarketRuntime();",
    "state.executionRuntime = polymarketRuntimeEvidenceFromInspection(persistedRuntime);",
    "await persist();",
    "const launchRuntime = resolvePolymarketRuntime();",
    "const result = await commandJson(launchRuntime.binary",
    "state.liveResult = result;",
    "executionRuntime: state.executionRuntime",
  ], "TAKE_PROFIT live runtime binding");
});

test("TAKE_PROFIT cancellation persists verified runtime evidence before the production spawn", async () => {
  const source = await readFile(new URL("../scripts/take-profit-orchestrator.mjs", import.meta.url), "utf8");
  const cancelStart = source.indexOf("const persistedRuntime = pluginCommand ? null : resolvePolymarketRuntime();");
  assert.ok(cancelStart >= 0, "TAKE_PROFIT cancel runtime binding: missing runtime resolution");
  assertTokensInOrder(source.slice(cancelStart), [
    "const persistedRuntime = pluginCommand ? null : resolvePolymarketRuntime();",
    "context.journal.cancelExecution.executionRuntime = polymarketRuntimeEvidenceFromInspection(persistedRuntime);",
    "await writeTakeProfitState(context.journal",
    "const launchRuntime = pluginCommand ? null : resolvePolymarketRuntime();",
    "const cancelResult = await commandJsonImpl(pluginCommand || launchRuntime.binary",
  ], "TAKE_PROFIT cancel runtime binding");
});

test("acceptance evidence distinguishes a declared pin from release-digest verification", async () => {
  const declared = polymarketRuntimeEvidence({ verified: false, platform: "linux", arch: "x64" });
  assert.equal(declared.verification, "declared-release-pin");
  assert.equal(declared.sourceCommit, POLYMARKET_RUNTIME_COMMIT);
  assert.equal("binarySha256" in declared, false);

  const { repositoryRoot, artifacts } = await fixture();
  const runtime = (await import("../src/polymarket-runtime.mjs")).resolvePolymarketRuntime({
    repositoryRoot,
    platform: "darwin",
    arch: "arm64",
    artifacts,
    env: {},
  });
  const verified = polymarketRuntimeEvidenceFromInspection(runtime);
  assert.equal(verified.verification, "release-digest");
  assert.match(verified.binarySha256, /^[0-9a-f]{64}$/);
});
