import { sha256 } from "./canonical.mjs";
import {
  POLYMARKET_RUNTIME_COMMIT,
} from "./polymarket-runtime.mjs";
import {
  BUYER_READINESS_URL,
  buyerReadinessContract,
} from "./buyer-readiness.mjs";
import { SERVICE_PAYEE } from "./service-constants.mjs";

export const EXECUTOR_DISCOVERY_URL = "https://conviction-bay.vercel.app/api/executor";
export const EXECUTOR_DISCOVERY_LINK = `<${EXECUTOR_DISCOVERY_URL}>; rel="service-desc"; type="application/json"`;

export const NATIVE_OKX_RUNTIME_ARTIFACTS = deepFreeze({
  "darwin-arm64": {
    binarySha256: "313197d4a5eb8c17b5f471febcbb13651e468f66ff77ec9eae15e856d9957cc0",
  },
  "linux-x64": {
    binarySha256: "5f3a89aea4995b5f43a3cfe6cced29a2b218c539ffa031ac1e4defd635040441",
  },
});

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

export const NATIVE_OKX_EXECUTION = deepFreeze({
  version: "conviction-native-okx-execution-v1",
  mode: "native-okx-agentic-wallet",
  preferred: true,
  supportedActions: ["OPEN", "CLOSE"],
  fallbackRequiredActions: ["TAKE_PROFIT"],
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
    takeProfitFallbackFixCommit: POLYMARKET_RUNTIME_COMMIT,
    tradingMode: "deposit-wallet",
    artifactSha256: {
      "darwin-arm64": NATIVE_OKX_RUNTIME_ARTIFACTS["darwin-arm64"].binarySha256,
      "linux-x64": NATIVE_OKX_RUNTIME_ARTIFACTS["linux-x64"].binarySha256,
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
  version: "conviction-executor-release-v6",
  custody: "buyer-wallet-local",
  preferredModeByAction: {
    OPEN: NATIVE_OKX_EXECUTION.mode,
    CLOSE: NATIVE_OKX_EXECUTION.mode,
    TAKE_PROFIT: "pinned-conviction-executor",
  },
  nativeOkx: NATIVE_OKX_EXECUTION,
  fallbackMode: "pinned-conviction-executor",
  source: {
    protocol: "git",
    repository: "https://github.com/dolepee/conviction.git",
    commit: "ee01aba1c249fc02cb1d2c2075eb081b825dfcd5",
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
  const common = {
    method: "POST",
    pointerFormat: "rfc6901",
    pluginResultContract: {
      pointers: {
        success: "/ok",
        dryRun: "/dry_run",
        status: "/data/status",
        orderId: "/data/order_id",
        transactionHashes: "/data/tx_hashes",
      },
      expected: {
        success: true,
        dryRun: false,
        status: "matched",
        transactionHashCount: 1,
      },
    },
    requestBodyMap: {
      transactionHash: { source: "pluginResult", pointer: "/data/tx_hashes/0" },
      orderId: { source: "pluginResult", pointer: "/data/order_id" },
      intentHash: { source: "paidCard", pointer: "/intentHash" },
      intent: { source: "paidCard", pointer: "/intent" },
      issuance: { source: "paidCard", pointer: "/issuance" },
    },
    returnProofInSameConversation: true,
  };
  if (action === "OPEN") {
    return {
      ...common,
      endpoint: "https://conviction-bay.vercel.app/api/receipt",
      kind: "verified-position-proof",
    };
  }
  if (action === "CLOSE") {
    return {
      ...common,
      endpoint: "https://conviction-bay.vercel.app/api/close-receipt",
      kind: "verified-close-proof",
    };
  }
  throw Object.assign(new Error("Native OKX proof is unavailable for this action"), {
    code: "native_okx_action_unsupported",
  });
}

function nativeNextStepFor(action) {
  if (NATIVE_OKX_EXECUTION.supportedActions.includes(action)) {
    return {
      available: true,
      executionHash: NATIVE_OKX_EXECUTION_HASH,
      program: NATIVE_OKX_EXECUTION.tradingTool.program,
      version: NATIVE_OKX_EXECUTION.tradingTool.version,
      argvPointer: NATIVE_OKX_EXECUTION.invocation.argvPointer,
      agentInvokesTool: true,
      convictionInstallRequired: false,
      proof: nativeProofFor(action),
    };
  }
  return {
    available: false,
    executionHash: NATIVE_OKX_EXECUTION_HASH,
    reason: "official_v0.7.0_gtd_transport_not_accepted",
    requiredMode: EXECUTOR_RELEASE.fallbackMode,
  };
}

export function executorNextStep(action) {
  const expectedAction = String(action || "").toUpperCase();
  const nativeSupported = NATIVE_OKX_EXECUTION.supportedActions.includes(expectedAction);
  return deepFreeze({
    version: "conviction-executor-next-step-v3",
    action: expectedAction,
    descriptorUrl: EXECUTOR_DISCOVERY_URL,
    executorReleaseHash: EXECUTOR_RELEASE_HASH,
    preferredMode: nativeSupported ? NATIVE_OKX_EXECUTION.mode : EXECUTOR_RELEASE.fallbackMode,
    nativeOkx: nativeNextStepFor(expectedAction),
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
  const nativeSupported = NATIVE_OKX_EXECUTION.supportedActions.includes(expectedAction);
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
    nextStep?.version === "conviction-executor-next-step-v3" &&
    nextStep?.action === expectedAction &&
    nextStep?.descriptorUrl === EXECUTOR_DISCOVERY_URL &&
    nextStep?.executorReleaseHash === EXECUTOR_RELEASE_HASH &&
    nextStep?.preferredMode === (nativeSupported ? NATIVE_OKX_EXECUTION.mode : EXECUTOR_RELEASE.fallbackMode) &&
    sha256(nextStep?.nativeOkx) === sha256(nativeNextStepFor(expectedAction)) &&
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
    nativeOkxSupportedActions: NATIVE_OKX_EXECUTION.supportedActions,
    fallbackRequiredActions: NATIVE_OKX_EXECUTION.fallbackRequiredActions,
    buyerReadiness: {
      url: BUYER_READINESS_URL,
      contract: buyerReadinessContract(),
      servicePayee: SERVICE_PAYEE,
      selfPaymentAllowed: false,
    },
  });
}
