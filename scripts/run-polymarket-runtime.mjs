#!/usr/bin/env node

import { spawnSync } from "node:child_process";

import { resolvePolymarketRuntime } from "../src/polymarket-runtime.mjs";

const runtime = resolvePolymarketRuntime();
const result = spawnSync(runtime.binary, process.argv.slice(2), { stdio: "inherit" });
if (result.error) throw result.error;
process.exitCode = result.status === null ? 1 : result.status;
