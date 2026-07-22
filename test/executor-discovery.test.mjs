import assert from "node:assert/strict";
import test from "node:test";

import handler from "../api/executor.js";
import {
  EXECUTOR_DISCOVERY_LINK,
  EXECUTOR_DISCOVERY_URL,
  EXECUTOR_RELEASE,
  EXECUTOR_RELEASE_HASH,
  executorDiscoveryDocument,
  executorDiscoveryMatches,
} from "../src/executor-discovery.mjs";
import { compileIntent } from "../src/intent-compiler.mjs";
import { LIVE_MARKET_SNAPSHOT } from "./fixtures.mjs";

function response() {
  return {
    headers: {},
    statusCode: null,
    body: null,
    setHeader(name, value) { this.headers[name.toLowerCase()] = value; },
    status(value) { this.statusCode = value; return this; },
    json(value) { this.body = value; return this; },
  };
}

test("public executor discovery pins one immutable cross-platform release", () => {
  const output = response();
  handler({ method: "GET" }, output);
  assert.equal(output.statusCode, 200);
  assert.deepEqual(output.body, executorDiscoveryDocument());
  assert.equal(output.body.executorReleaseHash, EXECUTOR_RELEASE_HASH);
  assert.equal(output.body.executor.source.commit, "e41750dfd96361bdb9656eb67ab8f1ee8e23528e");
  assert.deepEqual(output.body.executor.requirements.platforms, ["darwin-arm64", "linux-x64"]);
  assert.equal(output.body.executor.safety.serverHoldsKeysOrCredentials, false);
  assert.equal(EXECUTOR_DISCOVERY_LINK, `<${EXECUTOR_DISCOVERY_URL}>; rel="service-desc"; type="application/json"`);
});

test("executor discovery endpoint remains read-only", () => {
  const output = response();
  handler({ method: "POST" }, output);
  assert.equal(output.statusCode, 405);
  assert.equal(output.headers.allow, "GET, HEAD");
});

test("new cards bind discovery into the signed intent and fail on substitution", () => {
  const card = compileIntent({
    market: LIVE_MARKET_SNAPSHOT.slug,
    outcome: "yes",
    spend: "1.35",
    maxPrice: "0.27",
    wallet: "0x6a355e4971d9ac2ab97d22c3cf361d42faba33fe",
    rationale: "",
  }, LIVE_MARKET_SNAPSHOT, { now: Date.parse("2026-07-21T02:00:10.000Z") });
  assert.equal(executorDiscoveryMatches(card, "OPEN"), true);
  assert.deepEqual(card.intent.executor, EXECUTOR_RELEASE);
  assert.equal(card.executionCard.executorReleaseHash, EXECUTOR_RELEASE_HASH);
  assert.equal(card.nextStep.action, "OPEN");

  const substituted = structuredClone(card);
  substituted.nextStep.source.commit = "0".repeat(40);
  assert.equal(executorDiscoveryMatches(substituted, "OPEN"), false);
});

test("historical cards without discovery remain verifiable but cannot claim cold discovery", () => {
  const historical = { intent: {}, executionCard: {} };
  assert.equal(executorDiscoveryMatches(historical, "OPEN"), true);
  historical.executor = EXECUTOR_RELEASE;
  assert.equal(executorDiscoveryMatches(historical, "OPEN"), false);
});
