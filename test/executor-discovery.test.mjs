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
  assert.equal(output.body.executor.source.commit, "67ec7939b9182ac2a9f3984632881e8052f1ac0d");
  assert.deepEqual(output.body.executor.requirements.platforms, ["darwin-arm64", "linux-x64"]);
  assert.equal(output.body.executor.safety.serverHoldsKeysOrCredentials, false);
  assert.deepEqual(output.body.preferredExecution, NATIVE_OKX_EXECUTION);
  assert.equal(output.body.preferredExecutionHash, NATIVE_OKX_EXECUTION_HASH);
  assert.deepEqual(output.body.executor.preferredModeByAction, {
    OPEN: "native-okx-agentic-wallet",
    CLOSE: "native-okx-agentic-wallet",
    TAKE_PROFIT: "pinned-conviction-executor",
  });
  assert.deepEqual(output.body.nativeOkxSupportedActions, ["OPEN", "CLOSE"]);
  assert.deepEqual(output.body.fallbackRequiredActions, ["TAKE_PROFIT"]);
  assert.equal(output.body.preferredExecution.convictionInstallRequired, false);
  assert.equal(output.body.preferredExecution.repositoryCheckoutRequired, false);
  assert.equal(output.body.preferredExecution.wallet.signing, "TEE");
  assert.equal(output.body.preferredExecution.wallet.minimumCliVersion, "4.3.0");
  assert.equal(output.body.preferredExecution.tradingTool.provider, "OKX Plugin Store");
  assert.equal(output.body.preferredExecution.tradingTool.version, "0.7.0");
  assert.equal(output.body.preferredExecution.tradingTool.release.tag, "plugins/polymarket-plugin@0.7.0");
  assert.equal(
    output.body.preferredExecution.tradingTool.artifactSha256["darwin-arm64"],
    "313197d4a5eb8c17b5f471febcbb13651e468f66ff77ec9eae15e856d9957cc0",
  );
  assert.equal(
    output.body.preferredExecution.tradingTool.artifactSha256["linux-x64"],
    "5f3a89aea4995b5f43a3cfe6cced29a2b218c539ffa031ac1e4defd635040441",
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
  assert.equal(card.nextStep.nativeOkx.proof.method, "POST");
  assert.equal(card.nextStep.nativeOkx.proof.pointerFormat, "rfc6901");
  assert.equal(card.nextStep.nativeOkx.proof.pluginResultContract.pointers.status, "/data/status");
  assert.equal(card.nextStep.nativeOkx.proof.pluginResultContract.expected.status, "matched");
  assert.equal(card.nextStep.nativeOkx.proof.pluginResultContract.expected.transactionHashCount, 1);
  assert.deepEqual(card.nextStep.nativeOkx.proof.requestBodyMap, {
    transactionHash: { source: "pluginResult", pointer: "/data/tx_hashes/0" },
    orderId: { source: "pluginResult", pointer: "/data/order_id" },
    intentHash: { source: "paidCard", pointer: "/intentHash" },
    intent: { source: "paidCard", pointer: "/intent" },
    issuance: { source: "paidCard", pointer: "/issuance" },
  });
  assert.equal(card.nextStep.nativeOkx.proof.returnProofInSameConversation, true);

  const substituted = structuredClone(card);
  substituted.nextStep.nativeOkx.program = "untrusted-plugin";
  assert.equal(executorDiscoveryMatches(substituted, "OPEN"), false);

  const fallbackSubstitution = structuredClone(card);
  fallbackSubstitution.nextStep.fallback.source.commit = "0".repeat(40);
  assert.equal(executorDiscoveryMatches(fallbackSubstitution, "OPEN"), false);

  const proofMappingSubstitution = structuredClone(card);
  proofMappingSubstitution.nextStep.nativeOkx.proof.requestBodyMap.transactionHash.pointer = "/untrustedTx";
  assert.equal(executorDiscoveryMatches(proofMappingSubstitution, "OPEN"), false);
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
  assert.equal(close.nativeOkx.proof.requestBodyMap.transactionHash.pointer, "/data/tx_hashes/0");
  assert.equal(close.nativeOkx.proof.returnProofInSameConversation, true);
  assert.equal(takeProfit.preferredMode, "pinned-conviction-executor");
  assert.equal(takeProfit.nativeOkx.available, false);
  assert.equal(takeProfit.nativeOkx.reason, "official_v0.7.0_gtd_transport_not_accepted");
  assert.equal(takeProfit.nativeOkx.requiredMode, "pinned-conviction-executor");
  assert.equal(takeProfit.fallback.entrypoint.program, "node");
  assert.equal(takeProfit.fallback.entrypoint.argv[0], "scripts/take-profit-orchestrator.mjs");

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

  const takeProfitSubstitution = structuredClone(takeProfit);
  takeProfitSubstitution.nativeOkx.available = true;
  const forgedTakeProfitCard = {
    intent: { executor: EXECUTOR_RELEASE },
    executor: EXECUTOR_RELEASE,
    executionCard: { executorReleaseHash: EXECUTOR_RELEASE_HASH },
    nextStep: takeProfitSubstitution,
  };
  assert.equal(executorDiscoveryMatches(forgedTakeProfitCard, "TAKE_PROFIT"), false);

  const contradictoryTakeProfit = structuredClone(takeProfit);
  contradictoryTakeProfit.nativeOkx.program = "polymarket-plugin";
  forgedTakeProfitCard.nextStep = contradictoryTakeProfit;
  assert.equal(executorDiscoveryMatches(forgedTakeProfitCard, "TAKE_PROFIT"), false);
});
