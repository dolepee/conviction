import { APPROVAL_DISCLOSURE } from "./buyer-readiness.mjs";
import {
  DEPOSIT_WALLET_FACTORY,
  OFFICIAL_APPROVAL_CALLS,
  POLYGON_CHAIN_ID,
} from "./polymarket-builder-guard.mjs";

export const WALLET_SETUP_SCAFFOLD_VERSION = "conviction-wallet-setup-v1";

function freeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) freeze(child);
  return Object.freeze(value);
}

// This contract never exposes credentials. `configured` only reports whether
// the server has the Builder values, an independent session secret, durable
// one-time state, and a fixed Polygon verification RPC.
export function walletSetupScaffold({ configured = false } = {}) {
  return freeze({
    ok: true,
    version: WALLET_SETUP_SCAFFOLD_VERSION,
    status: configured ? "BROWSER_SETUP_BETA_READY" : "BROWSER_SETUP_REQUIRES_ACTIVATION",
    readOnly: !configured,
    paymentAllowed: configured,
    chainWritesAllowed: configured,
    credentialsAccepted: false,
    buyerKeysAccepted: false,
    actions: {
      connect: configured,
      deploy: configured,
      approve: configured,
      fund: false,
      bridge: false,
      pay: configured,
      trade: configured,
    },
    existingReadyWallet: {
      endpoint: "/api/readiness",
      route: "READY_FOR_CONVICTION",
    },
    compatibility: {
      existingPaidOpenRoute: "unchanged-ready-deposit-wallet-only",
      currentNativeOkxExecutor: "existing agent/plugin route remains supported; browser Deposit Wallet OPEN is an additional buyer-local route",
      xLayerPayment: configured
        ? "buyer-local EIP-3009 x402 signature with a separate later trade confirmation"
        : "inactive",
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
      durableState: "Server-only Redis-compatible REST URL and token for one-time consent and relayer-state binding",
      polygonVerifier: "Server-only fixed Polygon RPC URL for receipt and approval-state verification",
      serverRuntime: "Node 22 runtime with the pinned official Builder signing SDK",
      browserRuntime: "Digest-pinned browser bundle with Polymarket TypeScript SDK 0.1.0",
      consent: "Explicit buyer consent for wallet deployment and the official approval batch",
      securityBoundary: "Allowlisted relayer requests, durable one-time state, fixed-RPC Polygon receipt and post-state verification",
    },
    browserSetup: {
      page: "/wallet-setup",
      chainId: POLYGON_CHAIN_ID,
      walletFactory: DEPOSIT_WALLET_FACTORY,
      approvalCalls: OFFICIAL_APPROVAL_CALLS,
      consents: [
        "Deploy the buyer-controlled Polymarket Deposit Wallet",
        "Grant the official reusable five-call venue approval batch",
      ],
      fundingAfterSetupOnly: true,
      existingPaidRouteUnchanged: true,
    },
    approvalDisclosure: APPROVAL_DISCLOSURE,
    notice: configured
      ? "Setup first verifies Builder authorization through a read-only relayer check. Only then can it deploy and approve after two explicit browser-wallet consents, then run one buyer-local paid OPEN with a separate trade confirmation. It cannot fund or bridge."
      : "Browser setup is not activated. Do not fund a new wallet from this screen.",
  });
}
