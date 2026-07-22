import assert from "node:assert/strict";
import test from "node:test";

import handler from "../api/executor.js";
import {
  EXECUTOR_DISCOVERY_LINK,
  EXECUTOR_DISCOVERY_URL,
  EXECUTOR_RELEASE,
  EXECUTOR_RELEASE_HASH,
  NATIVE_OKX_EXECUTION,
  NATIVE_OKX_EXECUTION_HASH,
  executorDiscoveryDocument,
  executorDiscoveryMatches,
  executorNextStep,
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

test("public executor discovery prefers native OKX execution without a Conviction install", () => {
  const output = response();
  handler({ method: "GET" }, output);
  assert.equal(output.statusCode, 200);
  assert.deepEqual(output.body, executorDiscoveryDocument());
  assert.equal(output.body.executorReleaseHash, EXECUTOR_RELEASE_HASH);
  assert.equal(output.body.executor.source.commit, "e41750dfd96361bdb9656eb67ab8f1ee8e23528e");
  assert.deepEqual(output.body.executor.requirements.platforms, ["darwin-arm64", "linux-x64"]);
  assert.equal(output.body.executor.safety.serverHoldsKeysOrCredentials, false);
  assert.deepEqual(output.body.preferredExecution, NATIVE_OKX_EXECUTION);
  assert.equal(output.body.preferredExecutionHash, NATIVE_OKX_EXECUTION_HASH);
  assert.equal(output.body.executor.preferredMode, "native-okx-agentic-wallet");
  assert.equal(output.body.preferredExecution.convictionInstallRequired, false);
  assert.equal(output.body.preferredExecution.repositoryCheckoutRequired, false);
  assert.equal(output.body.preferredExecution.wallet.signing, "TEE");
  assert.equal(output.body.preferredExecution.wallet.minimumCliVersion, "4.3.0");
  assert.equal(output.body.preferredExecution.tradingTool.provider, "OKX Plugin Store");
  assert.equal(output.body.preferredExecution.tradingTool.version, "0.7.0");
  assert.equal(output.body.preferredExecution.tradingTool.release.tag, "plugins/polymarket-plugin@0.7.0");
  assert.equal(
    output.body.preferredExecution.tradingTool.artifactSha256["darwin-arm64"],
    "490ba1a4698c96d2a79c4de5b94d3982b73d578488ce84e0a30167405ae8f9c1",
  );
  assert.equal(output.body.preferredExecution.invocation.humanTypesPluginCommand, false);
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
  assert.equal(card.nextStep.preferredMode, "native-okx-agentic-wallet");
  assert.equal(card.nextStep.nativeOkx.program, card.executionCard.tool);
  assert.equal(card.nextStep.nativeOkx.argvPointer, "$.executionCard.argv");
  assert.equal(card.nextStep.nativeOkx.agentInvokesTool, true);
  assert.equal(card.nextStep.nativeOkx.convictionInstallRequired, false);
  assert.equal(card.nextStep.nativeOkx.proof.endpoint, "https://conviction-bay.vercel.app/api/receipt");

  const substituted = structuredClone(card);
  substituted.nextStep.nativeOkx.program = "untrusted-plugin";
  assert.equal(executorDiscoveryMatches(substituted, "OPEN"), false);

  const fallbackSubstitution = structuredClone(card);
  fallbackSubstitution.nextStep.fallback.source.commit = "0".repeat(40);
  assert.equal(executorDiscoveryMatches(fallbackSubstitution, "OPEN"), false);
});

test("historical cards without discovery remain verifiable but cannot claim cold discovery", () => {
  const historical = { intent: {}, executionCard: {} };
  assert.equal(executorDiscoveryMatches(historical, "OPEN"), true);
  historical.executor = EXECUTOR_RELEASE;
  assert.equal(executorDiscoveryMatches(historical, "OPEN"), false);
});

test("native OKX next steps bind action-specific proof handling without local commands", () => {
  const close = executorNextStep("CLOSE");
  const takeProfit = executorNextStep("TAKE_PROFIT");
  assert.equal(close.nativeOkx.proof.endpoint, "https://conviction-bay.vercel.app/api/close-receipt");
  assert.equal(takeProfit.nativeOkx.proof.statusTool, "polymarket-plugin orders");
  assert.match(takeProfit.nativeOkx.proof.cancelTool, /--order-id/);

  const openCard = compileIntent({
    market: LIVE_MARKET_SNAPSHOT.slug,
    outcome: "yes",
    spend: "1.35",
    maxPrice: "0.27",
    wallet: "0x6a355e4971d9ac2ab97d22c3cf361d42faba33fe",
    rationale: "",
  }, LIVE_MARKET_SNAPSHOT, { now: Date.parse("2026-07-21T02:00:10.000Z") });
  assert.equal(openCard.nextStep.nativeOkx.convictionInstallRequired, false);
  assert.equal(openCard.nextStep.nativeOkx.proof.kind, "verified-position-proof");
  assert.equal(executorDiscoveryMatches(openCard, "CLOSE"), false);

  const nativeSubstitution = structuredClone(openCard);
  nativeSubstitution.intent.executor.nativeOkx.tradingTool.version = "latest";
  assert.equal(executorDiscoveryMatches(nativeSubstitution, "OPEN"), false);
});
