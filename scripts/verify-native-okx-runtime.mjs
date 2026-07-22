#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import { NATIVE_OKX_RUNTIME_ARTIFACTS } from "../src/executor-discovery.mjs";

const [binary, releasePlatform] = process.argv.slice(2);
if (!binary || !releasePlatform || process.argv.length !== 4) {
  throw Object.assign(new Error("Usage: verify-native-okx-runtime.mjs <binary> <darwin-arm64|linux-x64>"), {
    code: "invalid_input",
  });
}

const expected = NATIVE_OKX_RUNTIME_ARTIFACTS[releasePlatform];
if (!expected) {
  throw Object.assign(new Error("Unsupported native OKX runtime platform"), { code: "unsupported_platform" });
}

const binarySha256 = createHash("sha256").update(readFileSync(binary)).digest("hex");
if (binarySha256 !== expected.binarySha256) {
  throw Object.assign(new Error("Official Plugin Store runtime differs from its pinned release digest"), {
    code: "official_native_runtime_digest_mismatch",
  });
}

const version = execFileSync(binary, ["--version"], {
  encoding: "utf8",
  stdio: ["ignore", "pipe", "inherit"],
}).trim();
if (version !== "polymarket 0.7.0") {
  throw Object.assign(new Error("Official Plugin Store runtime version is not supported"), {
    code: "native_runtime_version_mismatch",
  });
}

process.stdout.write(`${JSON.stringify({
  ok: true,
  mode: "native-okx-agentic-wallet",
  convictionInstallRequired: false,
  releasePlatform,
  version,
  binarySha256,
})}\n`);
