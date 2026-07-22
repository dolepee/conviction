import { sha256 } from "./canonical.mjs";
import {
  POLYMARKET_RUNTIME_ARTIFACTS,
  POLYMARKET_RUNTIME_COMMIT,
} from "./polymarket-runtime.mjs";

export const EXECUTOR_DISCOVERY_URL = "https://conviction-bay.vercel.app/api/executor";
export const EXECUTOR_DISCOVERY_LINK = `<${EXECUTOR_DISCOVERY_URL}>; rel="service-desc"; type="application/json"`;

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

export const NATIVE_OKX_EXECUTION = deepFreeze({
  version: "conviction-native-okx-execution-v1",
  mode: "native-okx-agentic-wallet",
  preferred: true,
  convictionInstallRequired: false,
  repositoryCheckoutRequired: false,
  wallet: {
    provider: "OKX Agentic Wallet",
    minimumCliVersion: "4.3.0",
    signing: "TEE",
    privateKeyLeavesWallet: false,
    requiredChains: ["eip155:196", "eip155:137"],
  },
  tradingTool: {
    provider: "OKX Plugin Store",
    name: "polymarket-plugin",
    version: "0.7.0",
    program: "polymarket-plugin",
    release: {
      repository: "https://github.com/okx/plugin-store",
      tag: "plugins/polymarket-plugin@0.7.0",
    },
    compatibleRuntimeSourceCommit: POLYMARKET_RUNTIME_COMMIT,
    tradingMode: "deposit-wallet",
    artifactSha256: {
      "darwin-arm64": POLYMARKET_RUNTIME_ARTIFACTS["darwin-arm64"].binarySha256,
      "linux-x64": POLYMARKET_RUNTIME_ARTIFACTS["linux-x64"].binarySha256,
    },
  },
  invocation: {
    argvPointer: "$.executionCard.argv",
    exactArgumentsRequired: true,
    agentInvokesTool: true,
    humanTypesPluginCommand: false,
  },
  safety: {
    paymentAndTradeConsentSeparate: true,
    exactTradeConfirmation: "confirm live mode",
    serverHoldsKeysOrCredentials: false,
  },
});

export const NATIVE_OKX_EXECUTION_HASH = sha256(NATIVE_OKX_EXECUTION);

// This immutable commit contains the complete buyer executor plus released,
// digest-pinned darwin-arm64 and linux-x64 Polymarket runtimes. Discovery code
// lives in the later merchant release, avoiding a self-referential source pin.
export const EXECUTOR_RELEASE = deepFreeze({
  version: "conviction-executor-release-v2",
  custody: "buyer-wallet-local",
  preferredMode: NATIVE_OKX_EXECUTION.mode,
  nativeOkx: NATIVE_OKX_EXECUTION,
  fallbackMode: "pinned-conviction-executor",
  source: {
    protocol: "git",
    repository: "https://github.com/dolepee/conviction.git",
    commit: "e41750dfd96361bdb9656eb67ab8f1ee8e23528e",
    skillPath: "skills/conviction-executor/SKILL.md",
  },
  requirements: {
    node: ">=22.14.0",
    platforms: ["darwin-arm64", "linux-x64"],
    wallet: "OKX Agentic Wallet with X Layer and Polygon signing",
    tradingMode: "deposit-wallet",
  },
  install: {
    workingDirectory: "verified git checkout at source.commit",
    steps: [
      { program: "npm", argv: ["ci"] },
      { program: "npm", argv: ["run", "runtime:install"] },
    ],
    verification: {
      source: "git rev-parse HEAD must equal source.commit",
      runtime: "release-digest",
    },
  },
  entrypoints: {
    OPEN: { program: "node", argv: ["scripts/buyer-orchestrator.mjs", "open"] },
    CLOSE: { program: "node", argv: ["scripts/buyer-orchestrator.mjs", "close"] },
    TAKE_PROFIT: { program: "node", argv: ["scripts/take-profit-orchestrator.mjs", "take-profit"] },
  },
  safety: {
    paymentAndTradeConsentSeparate: true,
    exactTradeConfirmation: "confirm live mode",
    serverHoldsKeysOrCredentials: false,
  },
});

export const EXECUTOR_RELEASE_HASH = sha256(EXECUTOR_RELEASE);

function nativeProofFor(action) {
  if (action === "OPEN") {
    return { endpoint: "https://conviction-bay.vercel.app/api/receipt", kind: "verified-position-proof" };
  }
  if (action === "CLOSE") {
    return { endpoint: "https://conviction-bay.vercel.app/api/close-receipt", kind: "verified-close-proof" };
  }
  return {
    kind: "authenticated-resting-order-proof",
    statusTool: "polymarket-plugin orders",
    cancelTool: "polymarket-plugin cancel --order-id <exact-order-id>",
  };
}

export function executorNextStep(action) {
  const expectedAction = String(action || "").toUpperCase();
  return deepFreeze({
    version: "conviction-executor-next-step-v2",
    action: expectedAction,
    descriptorUrl: EXECUTOR_DISCOVERY_URL,
    executorReleaseHash: EXECUTOR_RELEASE_HASH,
    preferredMode: NATIVE_OKX_EXECUTION.mode,
    nativeOkx: {
      executionHash: NATIVE_OKX_EXECUTION_HASH,
      program: NATIVE_OKX_EXECUTION.tradingTool.program,
      version: NATIVE_OKX_EXECUTION.tradingTool.version,
      argvPointer: NATIVE_OKX_EXECUTION.invocation.argvPointer,
      agentInvokesTool: true,
      convictionInstallRequired: false,
      proof: nativeProofFor(expectedAction),
    },
    fallback: {
      mode: EXECUTOR_RELEASE.fallbackMode,
      source: EXECUTOR_RELEASE.source,
      entrypoint: EXECUTOR_RELEASE.entrypoints[expectedAction],
    },
    requiresBuyerLocalExecution: true,
    requiresSeparateTradeConfirmation: true,
  });
}

export function executorDiscoveryMatches(card, action) {
  const expectedAction = String(action || "").toUpperCase();
  const intentExecutor = card?.intent?.executor;
  const topLevelExecutor = card?.executor;
  const nextStep = card?.nextStep;
  const executionCard = card?.executionCard;
  if (intentExecutor === undefined && topLevelExecutor === undefined && nextStep === undefined) {
    return true;
  }
  if (!intentExecutor || !topLevelExecutor || !nextStep || !executionCard) return false;
  if (!nextStep.nativeOkx || !nextStep.fallback || !EXECUTOR_RELEASE.entrypoints[expectedAction]) return false;
  return sha256(intentExecutor) === EXECUTOR_RELEASE_HASH &&
    sha256(topLevelExecutor) === EXECUTOR_RELEASE_HASH &&
    executionCard?.executorReleaseHash === EXECUTOR_RELEASE_HASH &&
    nextStep?.version === "conviction-executor-next-step-v2" &&
    nextStep?.action === expectedAction &&
    nextStep?.descriptorUrl === EXECUTOR_DISCOVERY_URL &&
    nextStep?.executorReleaseHash === EXECUTOR_RELEASE_HASH &&
    nextStep?.preferredMode === NATIVE_OKX_EXECUTION.mode &&
    nextStep?.nativeOkx?.executionHash === NATIVE_OKX_EXECUTION_HASH &&
    nextStep?.nativeOkx?.program === NATIVE_OKX_EXECUTION.tradingTool.program &&
    nextStep?.nativeOkx?.version === NATIVE_OKX_EXECUTION.tradingTool.version &&
    nextStep?.nativeOkx?.argvPointer === NATIVE_OKX_EXECUTION.invocation.argvPointer &&
    nextStep?.nativeOkx?.agentInvokesTool === true &&
    nextStep?.nativeOkx?.convictionInstallRequired === false &&
    sha256(nextStep?.nativeOkx?.proof) === sha256(nativeProofFor(expectedAction)) &&
    nextStep?.fallback?.mode === EXECUTOR_RELEASE.fallbackMode &&
    sha256(nextStep?.fallback?.source) === sha256(EXECUTOR_RELEASE.source) &&
    sha256(nextStep?.fallback?.entrypoint) === sha256(EXECUTOR_RELEASE.entrypoints[expectedAction]) &&
    nextStep?.requiresBuyerLocalExecution === true &&
    nextStep?.requiresSeparateTradeConfirmation === true;
}

export function executorDiscoveryDocument() {
  return deepFreeze({
    ok: true,
    product: "Conviction",
    executor: EXECUTOR_RELEASE,
    executorReleaseHash: EXECUTOR_RELEASE_HASH,
    preferredExecution: NATIVE_OKX_EXECUTION,
    preferredExecutionHash: NATIVE_OKX_EXECUTION_HASH,
    supportedActions: ["OPEN", "CLOSE", "TAKE_PROFIT"],
  });
}
