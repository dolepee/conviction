import { APPROVAL_DISCLOSURE } from "./buyer-readiness.mjs";

export const WALLET_SETUP_SCAFFOLD_VERSION = "conviction-wallet-setup-v1";

function freeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) freeze(child);
  return Object.freeze(value);
}

// This is deliberately a static, no-secret contract. It is the Phase A boundary
// for a future browser-signer + Polymarket Builder onboarding lane, not an API
// that can create a wallet, sign a relayer request, or accept credentials.
export function walletSetupScaffold() {
  return freeze({
    ok: true,
    version: WALLET_SETUP_SCAFFOLD_VERSION,
    status: "FEASIBILITY_ONLY_NOT_CONFIGURED",
    readOnly: true,
    paymentAllowed: false,
    chainWritesAllowed: false,
    credentialsAccepted: false,
    buyerKeysAccepted: false,
    actions: {
      connect: false,
      deploy: false,
      approve: false,
      fund: false,
      bridge: false,
      pay: false,
      trade: false,
    },
    existingReadyWallet: {
      endpoint: "/api/readiness",
      route: "READY_FOR_CONVICTION",
    },
    compatibility: {
      existingPaidOpenRoute: "unchanged-ready-deposit-wallet-only",
      currentNativeOkxExecutor: "not-compatible-until-a-browser-execution-adapter-proves-the-same-readiness-and-exact-dry-run-invariants",
      xLayerPayment: "separate-buyer-controlled-integration-not-implemented-in-this-scaffold",
    },
    target: {
      walletType: "Polymarket Deposit Wallet",
      signer: "buyer-controlled browser or embedded EVM wallet",
      relayer: "official Polymarket Builder relayer",
      custody: "Conviction never receives a buyer private key or CLOB credential",
    },
    activationPrerequisites: {
      builderCredentials: "Server-only Builder API key, secret, and passphrase",
      buyerSession: "Authenticated wallet-bound browser session",
      serverRuntime: "Node 24 or newer for the current official Polymarket TypeScript SDK",
      consent: "Explicit buyer consent for wallet deployment and the official approval batch",
      securityBoundary: "Allowlisted relayer requests, anti-replay state, rate limiting, and transaction-status polling",
    },
    approvalDisclosure: APPROVAL_DISCLOSURE,
    notice: "This feasibility endpoint cannot connect, deploy, approve, fund, pay, or trade. Do not fund a new wallet from this screen.",
  });
}
