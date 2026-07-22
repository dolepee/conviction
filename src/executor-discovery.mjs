import { sha256 } from "./canonical.mjs";

export const EXECUTOR_DISCOVERY_URL = "https://conviction-bay.vercel.app/api/executor";
export const EXECUTOR_DISCOVERY_LINK = `<${EXECUTOR_DISCOVERY_URL}>; rel="service-desc"; type="application/json"`;

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

// This immutable commit contains the complete buyer executor plus released,
// digest-pinned darwin-arm64 and linux-x64 Polymarket runtimes. Discovery code
// lives in the later merchant release, avoiding a self-referential source pin.
export const EXECUTOR_RELEASE = deepFreeze({
  version: "conviction-executor-release-v1",
  custody: "buyer-wallet-local",
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

export function executorNextStep(action) {
  return deepFreeze({
    version: "conviction-executor-next-step-v1",
    action: String(action || "").toUpperCase(),
    descriptorUrl: EXECUTOR_DISCOVERY_URL,
    executorReleaseHash: EXECUTOR_RELEASE_HASH,
    source: EXECUTOR_RELEASE.source,
    entrypoint: EXECUTOR_RELEASE.entrypoints[String(action || "").toUpperCase()],
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
  if (!nextStep.source || !nextStep.entrypoint || !EXECUTOR_RELEASE.entrypoints[expectedAction]) return false;
  return sha256(intentExecutor) === EXECUTOR_RELEASE_HASH &&
    sha256(topLevelExecutor) === EXECUTOR_RELEASE_HASH &&
    executionCard?.executorReleaseHash === EXECUTOR_RELEASE_HASH &&
    nextStep?.version === "conviction-executor-next-step-v1" &&
    nextStep?.action === expectedAction &&
    nextStep?.descriptorUrl === EXECUTOR_DISCOVERY_URL &&
    nextStep?.executorReleaseHash === EXECUTOR_RELEASE_HASH &&
    sha256(nextStep?.source) === sha256(EXECUTOR_RELEASE.source) &&
    sha256(nextStep?.entrypoint) === sha256(EXECUTOR_RELEASE.entrypoints[expectedAction]) &&
    nextStep?.requiresBuyerLocalExecution === true &&
    nextStep?.requiresSeparateTradeConfirmation === true;
}

export function executorDiscoveryDocument() {
  return deepFreeze({
    ok: true,
    product: "Conviction",
    executor: EXECUTOR_RELEASE,
    executorReleaseHash: EXECUTOR_RELEASE_HASH,
    supportedActions: ["OPEN", "CLOSE", "TAKE_PROFIT"],
  });
}
