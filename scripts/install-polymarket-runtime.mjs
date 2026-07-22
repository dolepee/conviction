#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, open, readFile, rename, rm, stat, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import {
  inspectPolymarketRuntime,
  POLYMARKET_RUNTIME_ARTIFACTS,
  POLYMARKET_RUNTIME_COMMIT,
  POLYMARKET_RUNTIME_REPOSITORY,
  POLYMARKET_RUNTIME_VERSION,
  polymarketRuntimePaths,
} from "../src/polymarket-runtime.mjs";

function run(file, args, options = {}) {
  return execFileSync(file, args, { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"], ...options }).trim();
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function syncDirectory(directory) {
  const handle = await open(directory, "r");
  try { await handle.sync(); } finally { await handle.close(); }
}

async function ensurePrivateDirectory(directory) {
  try {
    await mkdir(directory, { mode: 0o700 });
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
  }
  const info = await lstat(directory);
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw Object.assign(new Error(`Unsafe runtime directory: ${directory}`), { code: "runtime_install_unsafe_directory" });
  }
  if (typeof process.getuid === "function" && info.uid !== process.getuid()) {
    throw Object.assign(new Error(`Runtime directory has another owner: ${directory}`), { code: "runtime_install_owner_mismatch" });
  }
  if ((info.mode & 0o077) !== 0) {
    throw Object.assign(new Error(`Runtime directory is accessible to group or other users: ${directory}`), { code: "runtime_install_unsafe_mode" });
  }
}

const paths = polymarketRuntimePaths();
const artifact = POLYMARKET_RUNTIME_ARTIFACTS[`${process.platform}-${process.arch}`];
if (!artifact) {
  throw Object.assign(new Error(`No Conviction runtime release digest exists for ${process.platform}-${process.arch}`), {
    code: "runtime_platform_not_released",
  });
}

const repositoryRoot = dirname(paths.root);
const repositoryInfo = await stat(repositoryRoot);
if (!repositoryInfo.isDirectory()) throw Object.assign(new Error("Conviction repository root is unavailable"), { code: "runtime_repository_missing" });
await ensurePrivateDirectory(paths.root);
await ensurePrivateDirectory(paths.platformDirectory);

const current = inspectPolymarketRuntime(paths);
if (current.ok) {
  process.stdout.write(`${JSON.stringify({ ok: true, installed: false, binary: current.binary, binarySha256: current.binarySha256 })}\n`);
  process.exit(0);
}

try {
  await lstat(paths.directory);
  throw Object.assign(new Error(
    `An invalid runtime directory already exists at ${paths.directory}; quarantine it explicitly before reinstalling.`,
  ), { code: "runtime_install_existing_invalid_release" });
} catch (error) {
  if (error?.code !== "ENOENT") throw error;
}

const lockPath = join(paths.root, `install-${process.platform}-${process.arch}.lock`);
let lockHandle;
try {
  lockHandle = await open(lockPath, "wx", 0o600);
  await lockHandle.writeFile(`${JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() })}\n`);
  await lockHandle.sync();
  await syncDirectory(paths.root);
} catch (error) {
  if (error?.code === "EEXIST") {
    throw Object.assign(new Error(`Another runtime installation holds ${lockPath}`), { code: "runtime_install_in_progress" });
  }
  throw error;
}

let buildRoot;
let staging;
try {
  for (const command of ["git", "cargo", "rustc"]) {
    try { run(command, ["--version"]); } catch {
      throw Object.assign(new Error(`${command} is required to build the pinned Polymarket runtime`), {
        code: "missing_build_dependency",
      });
    }
  }
  const rustcVersion = run("rustc", ["--version"]);
  const cargoVersion = run("cargo", ["--version"]);
  if (rustcVersion !== artifact.rustcVersion || cargoVersion !== artifact.cargoVersion) {
    throw Object.assign(new Error("The installed Rust toolchain does not match the released runtime toolchain"), {
      code: "runtime_toolchain_mismatch",
    });
  }

  buildRoot = await mkdtemp(join(tmpdir(), "conviction-polymarket-runtime-"));
  run("git", ["init", "--quiet", buildRoot]);
  run("git", ["-C", buildRoot, "remote", "add", "origin", POLYMARKET_RUNTIME_REPOSITORY]);
  run("git", ["-C", buildRoot, "fetch", "--quiet", "--depth", "1", "origin", POLYMARKET_RUNTIME_COMMIT]);
  run("git", ["-C", buildRoot, "checkout", "--quiet", "--detach", "FETCH_HEAD"]);
  const resolvedCommit = run("git", ["-C", buildRoot, "rev-parse", "HEAD"]);
  if (resolvedCommit !== POLYMARKET_RUNTIME_COMMIT) {
    throw Object.assign(new Error("Fetched Polymarket source did not resolve to the pinned commit"), {
      code: "runtime_source_mismatch",
    });
  }

  const crate = join(buildRoot, "skills", "polymarket-plugin");
  const manifestPath = join(crate, "Cargo.toml");
  const lockBytes = await readFile(join(crate, "Cargo.lock"));
  const cargoLockSha256 = sha256(lockBytes);
  if (cargoLockSha256 !== artifact.cargoLockSha256) {
    throw Object.assign(new Error("Pinned Cargo.lock differs from the released lock digest"), { code: "runtime_lock_digest_mismatch" });
  }
  const buildEnvironment = { ...process.env, CARGO_INCREMENTAL: "0" };
  for (const name of ["RUSTFLAGS", "CARGO_ENCODED_RUSTFLAGS", "RUSTC_WRAPPER", "RUSTC_WORKSPACE_WRAPPER", "CARGO_TARGET_DIR"]) {
    delete buildEnvironment[name];
  }
  run("cargo", ["test", "--all-targets", "--locked", "--manifest-path", manifestPath], { cwd: crate, env: buildEnvironment });
  run("cargo", ["build", "--release", "--locked", "--manifest-path", manifestPath], { cwd: crate, env: buildEnvironment });

  const builtName = process.platform === "win32" ? "polymarket-plugin.exe" : "polymarket-plugin";
  const built = join(crate, "target", "release", builtName);
  const binaryBytes = await readFile(built);
  const binarySha256 = sha256(binaryBytes);
  if (binarySha256 !== artifact.binarySha256) {
    throw Object.assign(new Error("Locally built binary differs from the released artifact digest"), {
      code: "runtime_binary_digest_mismatch",
    });
  }
  const manifest = {
    version: "conviction-polymarket-runtime-v2",
    runtimeVersion: POLYMARKET_RUNTIME_VERSION,
    sourceRepository: POLYMARKET_RUNTIME_REPOSITORY,
    sourceCommit: POLYMARKET_RUNTIME_COMMIT,
    cargoLockSha256,
    rustcVersion,
    cargoVersion,
    platform: process.platform,
    arch: process.arch,
    binarySha256,
    builtAt: new Date().toISOString(),
  };

  staging = join(paths.platformDirectory, `.staging-${POLYMARKET_RUNTIME_COMMIT}-${randomUUID()}`);
  await mkdir(staging, { mode: 0o700 });
  const stagedBinary = join(staging, builtName);
  const stagedManifest = join(staging, "manifest.json");
  await writeFile(stagedBinary, binaryBytes, { flag: "wx", mode: 0o500 });
  await writeFile(stagedManifest, `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx", mode: 0o400 });
  await chmod(stagedBinary, 0o500);
  await chmod(stagedManifest, 0o400);
  await chmod(staging, 0o500);

  const staged = inspectPolymarketRuntime({
    ...paths,
    directory: staging,
    binary: stagedBinary,
    manifest: stagedManifest,
  });
  if (!staged.ok) {
    throw Object.assign(new Error(`Staged runtime failed verification: ${staged.code}`), { code: staged.code });
  }
  await rename(staging, paths.directory);
  staging = undefined;
  await syncDirectory(paths.platformDirectory);

  const verified = inspectPolymarketRuntime(paths);
  if (!verified.ok) {
    throw Object.assign(new Error(`Installed runtime failed verification: ${verified.code}`), { code: verified.code });
  }
  process.stdout.write(`${JSON.stringify({ ok: true, installed: true, binary: verified.binary, binarySha256 })}\n`);
} finally {
  if (staging) await rm(resolve(staging), { recursive: true, force: true });
  if (buildRoot) await rm(resolve(buildRoot), { recursive: true, force: true });
  await lockHandle?.close().catch(() => {});
  await unlink(lockPath).catch(() => {});
  await syncDirectory(paths.root).catch(() => {});
}
