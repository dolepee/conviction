import { parseDecimal } from "./decimal.mjs";
import { SERVICE_PAYEE } from "./service-constants.mjs";

export const BUYER_READINESS_VERSION = "conviction-buyer-readiness-v1";
export const BUYER_READINESS_URL = "https://conviction-bay.vercel.app/api/readiness";
export const OPEN_SERVICE_PRICE_ATOMIC = "50000";
export const DEFAULT_OPEN_BUDGET_RAW = "1250000";

const ADDRESS_RE = /^0x[0-9a-f]{40}$/i;

function address(value) {
  const normalized = String(value || "").trim().toLowerCase();
  return ADDRESS_RE.test(normalized) ? normalized : null;
}

function atomicDecimal(value, label) {
  if (value === undefined || value === null || String(value).trim() === "") return null;
  try {
    return parseDecimal(String(value), 6, label);
  } catch {
    return null;
  }
}

function result(status, nextAction, input, missing = []) {
  const requestedBudget = atomicDecimal(
    input?.requestedOpenBudget ?? "1.25",
    "requested OPEN budget",
  );
  return Object.freeze({
    ok: status === "READY_FOR_CONVICTION",
    version: BUYER_READINESS_VERSION,
    status,
    nextAction,
    service: {
      product: "OPEN",
      endpoint: "https://conviction-bay.vercel.app/api/service",
      network: "eip155:196",
      priceAtomic: OPEN_SERVICE_PRICE_ATOMIC,
      payee: SERVICE_PAYEE,
    },
    buyer: {
      xLayerPayer: address(input?.xLayer?.payer),
      polygonEoa: address(input?.polygon?.eoa),
      depositWallet: address(input?.polygon?.depositWallet),
      tradingMode: String(input?.polygon?.tradingMode || "") || null,
    },
    requirements: {
      xLayerUsdt0Atomic: OPEN_SERVICE_PRICE_ATOMIC,
      polygonPusdRaw: (requestedBudget ?? BigInt(DEFAULT_OPEN_BUDGET_RAW)).toString(),
      minimumOpenBudgetRaw: "1000000",
    },
    observed: {
      xLayerUsdt0: input?.xLayer?.usdt0 ?? null,
      polygonPusd: input?.polygon?.pUsd ?? null,
      approvalsReady: input?.polygon?.approvalsReady === true,
      regionalAccess: input?.venue?.accessible ?? null,
      clobVersion: input?.venue?.clobVersion ?? null,
    },
    missing,
    recoverable:
      status === "BUYER_SETUP_REQUIRED" ||
      status === "REGION_CHECK_REQUIRED",
  });
}

export function buyerReadinessContract() {
  return Object.freeze({
    version: BUYER_READINESS_VERSION,
    endpoint: BUYER_READINESS_URL,
    method: "POST",
    readOnly: true,
    description: "Classifies buyer-local OKX and Polymarket readiness before preview or payment.",
    statuses: [
      "READY_FOR_CONVICTION",
      "BUYER_SETUP_REQUIRED",
      "REGION_CHECK_REQUIRED",
      "REGION_RESTRICTED",
      "SELF_PAYMENT_FORBIDDEN",
      "UNSUPPORTED_EXECUTION_RUNTIME",
    ],
    requiredInput: {
      capabilities: {
        walletTools: "boolean",
        x402Payment: "boolean",
        polymarketTrading: "boolean",
      },
      xLayer: {
        payer: "0x address",
        usdt0: "decimal string",
      },
      polygon: {
        eoa: "0x address",
        depositWallet: "0x address or null",
        tradingMode: "deposit-wallet | other | null",
        pUsd: "decimal string",
        approvalsReady: "boolean",
      },
      venue: {
        accessible: "true | false | null",
        clobVersion: "V2 | other | null",
      },
      requestedOpenBudget: "decimal string; optional, default 1.25",
    },
    approvalDisclosure: {
      setupIsVenueManaged: true,
      reusable: true,
      pUsdAllowances: 2,
      ctfOperatorApprovals: 3,
      convictionCanBypassWalletPolicy: false,
    },
  });
}

export function classifyBuyerReadiness(input = {}) {
  const capabilities = input?.capabilities || {};
  if (
    capabilities.walletTools !== true ||
    capabilities.x402Payment !== true ||
    capabilities.polymarketTrading !== true
  ) {
    return result(
      "UNSUPPORTED_EXECUTION_RUNTIME",
      "USE_OKX_RUNTIME_WITH_WALLET_X402_AND_POLYMARKET_TRADING",
      input,
      [
        ...(capabilities.walletTools === true ? [] : ["capabilities.walletTools"]),
        ...(capabilities.x402Payment === true ? [] : ["capabilities.x402Payment"]),
        ...(capabilities.polymarketTrading === true ? [] : ["capabilities.polymarketTrading"]),
      ],
    );
  }

  const payer = address(input?.xLayer?.payer);
  if (payer && payer === SERVICE_PAYEE) {
    return result(
      "SELF_PAYMENT_FORBIDDEN",
      "SWITCH_TO_DISTINCT_BUYER_ACCOUNT",
      input,
      ["xLayer.payerDistinctFromPayee"],
    );
  }

  const polygonEoa = address(input?.polygon?.eoa);
  const depositWallet = address(input?.polygon?.depositWallet);
  const missingIdentity = [
    ...(payer ? [] : ["xLayer.payer"]),
    ...(polygonEoa ? [] : ["polygon.eoa"]),
  ];
  if (missingIdentity.length) {
    return result(
      "BUYER_SETUP_REQUIRED",
      payer ? "CONNECT_POLYGON_WALLET" : "CONNECT_X_LAYER_PAYER",
      input,
      missingIdentity,
    );
  }

  if (input?.venue?.accessible === false) {
    return result("REGION_RESTRICTED", "STOP_NO_PAYMENT_OR_TRADE", input, ["venue.accessible"]);
  }
  if (input?.venue?.accessible !== true) {
    return result("REGION_CHECK_REQUIRED", "RUN_POLYMARKET_CHECK_ACCESS", input, ["venue.accessible"]);
  }
  if (!depositWallet) {
    return result(
      "BUYER_SETUP_REQUIRED",
      "SETUP_DEPOSIT_WALLET",
      input,
      ["polygon.depositWallet", "polygon.approvalsReady"],
    );
  }
  if (input?.polygon?.tradingMode !== "deposit-wallet") {
    return result(
      "BUYER_SETUP_REQUIRED",
      "SELECT_DEPOSIT_WALLET_MODE",
      input,
      ["polygon.tradingMode"],
    );
  }
  if (input?.venue?.clobVersion !== "V2") {
    return result(
      "BUYER_SETUP_REQUIRED",
      "RESOLVE_POLYMARKET_V2",
      input,
      ["venue.clobVersion"],
    );
  }
  if (input?.polygon?.approvalsReady !== true) {
    return result(
      "BUYER_SETUP_REQUIRED",
      "COMPLETE_POLYMARKET_V2_SETUP",
      input,
      ["polygon.approvalsReady"],
    );
  }

  const xLayerBalance = atomicDecimal(input?.xLayer?.usdt0, "X Layer USD₮0 balance");
  if (xLayerBalance === null || xLayerBalance < BigInt(OPEN_SERVICE_PRICE_ATOMIC)) {
    return result(
      "BUYER_SETUP_REQUIRED",
      "FUND_X_LAYER_USDT0",
      input,
      ["xLayer.usdt0"],
    );
  }

  const requestedBudget = atomicDecimal(
    input?.requestedOpenBudget ?? "1.25",
    "requested OPEN budget",
  );
  const pUsdBalance = atomicDecimal(input?.polygon?.pUsd, "Polygon pUSD balance");
  if (requestedBudget === null || requestedBudget < 1_000_000n) {
    return result(
      "BUYER_SETUP_REQUIRED",
      "CHOOSE_OPEN_BUDGET_AT_LEAST_1_PUSD",
      input,
      ["requestedOpenBudget"],
    );
  }
  if (pUsdBalance === null || pUsdBalance < requestedBudget) {
    return result(
      "BUYER_SETUP_REQUIRED",
      "FUND_POLYGON_PUSD",
      input,
      ["polygon.pUsd"],
    );
  }

  return result("READY_FOR_CONVICTION", "RUN_FREE_PREVIEW", input);
}
