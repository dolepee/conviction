import { createHash } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const POLYMARKET_RUNTIME_REPOSITORY = "https://github.com/dolepee/plugin-store.git";
export const POLYMARKET_RUNTIME_COMMIT = "49c952b98037f676b484625a4f389b42071213e7";
export const POLYMARKET_RUNTIME_VERSION = "0.7.0-conviction.1";

// Release digests are the trust anchor. An adjacent manifest is deliberately
// insufficient: a local attacker able to replace both files must not be able
// to bless arbitrary executable bytes by editing their claimed hash.
export const POLYMARKET_RUNTIME_ARTIFACTS = Object.freeze({
  "darwin-arm64": Object.freeze({
    binarySha256: "490ba1a4698c96d2a79c4de5b94d3982b73d578488ce84e0a30167405ae8f9c1",
    cargoLockSha256: "5edf618dc5870a868ea32c758c64831b1039a486b17e922fe9053878dd771627",
    rustcVersion: "rustc 1.96.1 (31fca3adb 2026-06-26)",
    cargoVersion: "cargo 1.96.1 (356927216 2026-06-26)",
  }),
});

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export function polymarketRuntimePaths({
  repositoryRoot = REPOSITORY_ROOT,
  platform = process.platform,
  arch = process.arch,
} = {}) {
  const root = join(resolve(repositoryRoot), ".conviction-tools");
  const platformDirectory = join(root, `${platform}-${arch}`);
  const directory = join(platformDirectory, `polymarket-plugin-${POLYMARKET_RUNTIME_COMMIT}`);
  const executable = platform === "win32" ? "polymarket-plugin.exe" : "polymarket-plugin";
  return Object.freeze({
    root,
    platformDirectory,
    directory,
    binary: join(directory, executable),
    manifest: join(directory, "manifest.json"),
  });
}

function sha256File(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

function ownedByCurrentUser(info) {
  return typeof process.getuid !== "function" || info.uid === process.getuid();
}

function secureNode(path, { kind, modeMask, requiredMode }) {
  const info = lstatSync(path);
  if (info.isSymbolicLink()) return `${kind}_symlink_refused`;
  if (kind.includes("directory") ? !info.isDirectory() : !info.isFile()) return `${kind}_not_${kind.includes("directory") ? "directory" : "file"}`;
  if (!ownedByCurrentUser(info)) return `${kind}_owner_mismatch`;
  if ((info.mode & modeMask) !== requiredMode) return `${kind}_mode_mismatch`;
  return null;
}

export function inspectPolymarketRuntime({
  root,
  platformDirectory,
  directory,
  binary,
  manifest,
  platform = process.platform,
  arch = process.arch,
  artifacts = POLYMARKET_RUNTIME_ARTIFACTS,
} = polymarketRuntimePaths()) {
  try {
    const paths = root && platformDirectory && directory
      ? { root, platformDirectory, directory, binary, manifest }
      : (() => {
          const inferredDirectory = dirname(binary);
          const inferredPlatformDirectory = dirname(inferredDirectory);
          return {
            root: dirname(inferredPlatformDirectory),
            platformDirectory: inferredPlatformDirectory,
            directory: inferredDirectory,
            binary,
            manifest,
          };
        })();
    for (const [path, kind, modeMask, requiredMode] of [
      [paths.root, "runtime_root_directory", 0o777, 0o700],
      [paths.platformDirectory, "runtime_platform_directory", 0o777, 0o700],
      [paths.directory, "runtime_release_directory", 0o777, 0o500],
      [paths.binary, "runtime_binary", 0o777, 0o500],
      [paths.manifest, "runtime_manifest", 0o777, 0o400],
    ]) {
      const code = secureNode(path, { kind, modeMask, requiredMode });
      if (code) return Object.freeze({ ok: false, code });
    }
    const binaryInfo = lstatSync(paths.binary);
    if (platform !== "win32" && (binaryInfo.mode & 0o500) !== 0o500) {
      return Object.freeze({ ok: false, code: "runtime_binary_not_executable" });
    }
    const artifact = artifacts[`${platform}-${arch}`];
    if (!artifact) return Object.freeze({ ok: false, code: "runtime_platform_not_released" });
    const parsed = JSON.parse(readFileSync(paths.manifest, "utf8"));
    const actualSha256 = sha256File(paths.binary);
    const ok = parsed?.version === "conviction-polymarket-runtime-v2" &&
      parsed?.sourceRepository === POLYMARKET_RUNTIME_REPOSITORY &&
      parsed?.sourceCommit === POLYMARKET_RUNTIME_COMMIT &&
      parsed?.runtimeVersion === POLYMARKET_RUNTIME_VERSION &&
      parsed?.platform === platform && parsed?.arch === arch &&
      parsed?.cargoLockSha256 === artifact.cargoLockSha256 &&
      parsed?.rustcVersion === artifact.rustcVersion &&
      parsed?.cargoVersion === artifact.cargoVersion &&
      parsed?.binarySha256 === artifact.binarySha256 &&
      actualSha256 === artifact.binarySha256;
    return Object.freeze(ok
      ? { ok: true, binary: resolve(paths.binary), manifest: Object.freeze(parsed), binarySha256: actualSha256 }
      : { ok: false, code: "runtime_release_digest_mismatch" });
  } catch (error) {
    return Object.freeze({
      ok: false,
      code: error?.code === "ENOENT" ? "runtime_not_installed" : "runtime_verification_failed",
    });
  }
}

export function resolvePolymarketRuntime({
  env = process.env,
  repositoryRoot = REPOSITORY_ROOT,
  platform = process.platform,
  arch = process.arch,
  artifacts = POLYMARKET_RUNTIME_ARTIFACTS,
} = {}) {
  const defaultPaths = polymarketRuntimePaths({ repositoryRoot, platform, arch });
  const override = String(env.CONVICTION_POLYMARKET_PLUGIN_BIN || "").trim();
  let paths = defaultPaths;
  if (override) {
    if (!isAbsolute(override)) {
      throw Object.assign(new Error("CONVICTION_POLYMARKET_PLUGIN_BIN must be an absolute path"), {
        code: "invalid_runtime_override",
      });
    }
    const resolvedBinary = resolve(override);
    const directory = dirname(resolvedBinary);
    const platformDirectory = dirname(directory);
    paths = {
      root: dirname(platformDirectory),
      platformDirectory,
      directory,
      binary: resolvedBinary,
      manifest: `${resolvedBinary}.manifest.json`,
    };
  }
  const inspected = inspectPolymarketRuntime({ ...paths, platform, arch, artifacts });
  if (!inspected.ok) {
    throw Object.assign(new Error(
      `Pinned Polymarket runtime is unavailable (${inspected.code}). Run \`npm run runtime:install\` from this Conviction release.`,
    ), { code: inspected.code });
  }
  return inspected;
}

export function resolvePolymarketPluginCommand(options = {}) {
  return resolvePolymarketRuntime(options).binary;
}

export function polymarketRuntimeEvidenceFromInspection(runtime) {
  if (!runtime?.ok || !runtime?.manifest || !runtime?.binarySha256) {
    throw Object.assign(new Error("Verified runtime inspection is required"), { code: "runtime_evidence_unverified" });
  }
  return Object.freeze({
    version: "conviction-polymarket-runtime-evidence-v2",
    verification: "release-digest",
    runtimeVersion: POLYMARKET_RUNTIME_VERSION,
    sourceRepository: POLYMARKET_RUNTIME_REPOSITORY,
    sourceCommit: POLYMARKET_RUNTIME_COMMIT,
    platform: runtime.manifest.platform,
    arch: runtime.manifest.arch,
    binarySha256: runtime.binarySha256,
    cargoLockSha256: runtime.manifest.cargoLockSha256,
  });
}

export function polymarketRuntimeEvidence({ verified = false, ...options } = {}) {
  if (!verified) {
    return Object.freeze({
      version: "conviction-polymarket-runtime-evidence-v2",
      verification: "declared-release-pin",
      runtimeVersion: POLYMARKET_RUNTIME_VERSION,
      sourceRepository: POLYMARKET_RUNTIME_REPOSITORY,
      sourceCommit: POLYMARKET_RUNTIME_COMMIT,
      platform: options.platform || process.platform,
      arch: options.arch || process.arch,
    });
  }
  return polymarketRuntimeEvidenceFromInspection(resolvePolymarketRuntime(options));
}
