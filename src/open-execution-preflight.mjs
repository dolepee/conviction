import { POLYGON_CHAIN_ID, POLYGON_RPC_URL } from "./constants.mjs";
import { parseDecimal } from "./decimal.mjs";
import { ConvictionError, invariant } from "./errors.mjs";
import {
  createPolygonWalletSetupVerifier,
  PolygonWalletSetupVerificationError,
} from "./polygon-wallet-setup-verifier.mjs";

const ADDRESS_RE = /^0x[0-9a-f]{40}$/i;
const DEPOSIT_WALLET_FACTORY = "0x00000000000fb5c9adea0298d729a0cb3823cc07";
const PREDICT_WALLET_SELECTOR = "1f264778";
const PREDICT_LEGACY_WALLET_SELECTOR = "8becfd88";

function paddedAddress(value) {
  return String(value || "").toLowerCase().replace(/^0x/, "").padStart(64, "0");
}

function pluginData(value) {
  const outer = value && typeof value === "object" && !Array.isArray(value)
    ? value
    : null;
  invariant(outer, "missing_plugin_preview", "A successful official plugin dry run is required before payment");
  const data = outer.data && typeof outer.data === "object" && !Array.isArray(outer.data)
    ? outer.data
    : outer;
  invariant(
    outer.ok === true && outer.dry_run === true,
    "invalid_plugin_preview",
    "pluginPreview must be a successful official dry run",
  );
  invariant(
    data.note === "dry-run: order not submitted",
    "invalid_plugin_preview",
    "pluginPreview did not prove that no order was submitted",
  );
  return data;
}

function decimalRaw(value, label) {
  return parseDecimal(String(value), 6, label);
}

export function verifyOpenPluginPreview(compilation, previewInput, { verifiedWallet } = {}) {
  const data = pluginData(previewInput);
  const intent = compilation?.intent;
  const market = intent?.market;
  const order = intent?.order;
  invariant(intent && market && order, "invalid_compilation", "OPEN compilation is incomplete");
  invariant(
    String(verifiedWallet || "").toLowerCase() === intent.buyer.wallet,
    "plugin_preview_mismatch",
    "Official plugin dry run is not bound to the verified deposit-wallet identity",
    { field: "wallet", expected: intent.buyer.wallet, actual: verifiedWallet ?? null },
  );

  const exact = [
    [String(data.clob_version), "V2", "clobVersion"],
    [String(data.collateral_token || "").toLowerCase(), market.collateral, "collateral"],
    [String(data.condition_id || "").toLowerCase(), market.conditionId, "conditionId"],
    [String(data.exchange_address || "").toLowerCase(), market.exchange, "exchange"],
    [String(data.order_type || "").toUpperCase(), "FAK", "orderType"],
    [String(data.outcome || "").toUpperCase(), order.outcome, "outcome"],
    [String(data.side || "").toUpperCase(), "BUY", "side"],
    [String(data.token_id || ""), order.outcomeTokenId, "tokenId"],
  ];
  for (const [actual, expected, field] of exact) {
    invariant(
      actual === expected,
      "plugin_preview_mismatch",
      `Official plugin dry run disagrees with Conviction on ${field}`,
      { field, expected, actual },
    );
  }
  invariant(data.neg_risk === false, "plugin_preview_mismatch", "Official plugin resolved a neg-risk market");
  invariant(data.post_only === false, "plugin_preview_mismatch", "Official plugin unexpectedly enabled post-only");
  invariant(data.expires === null, "plugin_preview_mismatch", "FAK dry run unexpectedly has an expiry");
  invariant(
    Number(data.fee_rate_bps) === Number(order.feeBps),
    "plugin_preview_mismatch",
    "Official plugin fee rate differs from Conviction",
  );

  const decimalChecks = [
    [data.limit_price, order.maxPrice, "maxPrice"],
    [data.shares, order.fullFillSharesAtCap, "shares"],
    [data.usdc_amount, order.maximumOrderPrincipal, "principal"],
    [data.usdc_requested, order.maximumOrderPrincipal, "requestedPrincipal"],
  ];
  for (const [actual, expected, field] of decimalChecks) {
    invariant(
      decimalRaw(actual, `plugin ${field}`) === decimalRaw(expected, `intent ${field}`),
      "plugin_preview_mismatch",
      `Official plugin dry run disagrees with Conviction on ${field}`,
      { field, expected: String(expected), actual: String(actual) },
    );
  }

  return Object.freeze({
    ok: true,
    version: "conviction-plugin-preview-binding-v1",
    wallet: intent.buyer.wallet,
    conditionId: market.conditionId,
    tokenId: order.outcomeTokenId,
    principalRaw: order.maximumOrderPrincipalRaw,
    maximumTotalDebitRaw: order.maximumTotalDebitRaw,
  });
}

async function polygonRpc(method, params, { rpcUrl, fetchImpl }) {
  const response = await fetchImpl(rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: AbortSignal.timeout(10_000),
  });
  const body = await response.json().catch(() => null);
  if (!response.ok || body?.error || body?.result === undefined || body?.result === null) {
    throw new ConvictionError("rpc_error", "Polygon maker-eligibility check failed", {
      method,
      status: response.status,
      rpcCode: body?.error?.code,
    });
  }
  return body.result;
}

function setupPreflightError(error) {
  if (!(error instanceof PolygonWalletSetupVerificationError)) return error;
  const upstream = Number(error.status) >= 500;
  return new ConvictionError(
    upstream ? "rpc_error" : error.code,
    error.message,
    {
      paymentAllowed: false,
      nextAction: upstream ? "RETRY_READINESS_LATER" : "COMPLETE_BROWSER_WALLET_SETUP",
      ...(upstream ? { upstreamCode: error.code } : {}),
    },
  );
}

export async function verifyDepositWalletExecution(
  walletValue,
  {
    owner,
    rpcUrl = POLYGON_RPC_URL,
    fetchImpl = fetch,
    verifyApprovalStateImpl = undefined,
    verifyBalanceImpl = undefined,
    minimumBalanceRaw = "0",
  } = {},
) {
  const wallet = String(walletValue || "").trim().toLowerCase();
  const ownerAddress = String(owner || "").trim().toLowerCase();
  invariant(ADDRESS_RE.test(wallet), "invalid_wallet", "wallet must be a valid EVM address");
  invariant(ADDRESS_RE.test(ownerAddress), "invalid_wallet_owner", "deposit-wallet owner must be a valid EVM address");
  const predictionArgs = `${paddedAddress(ownerAddress)}${paddedAddress(ownerAddress)}`;
  const predictionData = `0x${PREDICT_WALLET_SELECTOR}${predictionArgs}`;
  const legacyPredictionData = `0x${PREDICT_LEGACY_WALLET_SELECTOR}${paddedAddress(ownerAddress)}`;
  const [chainHex, code, predictedWord, legacyPredictedWord] = await Promise.all([
    polygonRpc("eth_chainId", [], { rpcUrl, fetchImpl }),
    polygonRpc("eth_getCode", [wallet, "latest"], { rpcUrl, fetchImpl }),
    polygonRpc("eth_call", [{
      to: DEPOSIT_WALLET_FACTORY,
      data: predictionData,
    }, "latest"], { rpcUrl, fetchImpl }),
    polygonRpc("eth_call", [{
      to: DEPOSIT_WALLET_FACTORY,
      data: legacyPredictionData,
    }, "latest"], { rpcUrl, fetchImpl }),
  ]);
  invariant(
    Number(BigInt(chainHex)) === POLYGON_CHAIN_ID,
    "wrong_chain",
    "Maker-eligibility RPC is not Polygon chain 137",
  );
  invariant(
    /^0x[0-9a-f]+$/i.test(String(code || "")) && !/^0x0*$/i.test(String(code)),
    "maker_not_eligible",
    "OPEN requires an already-deployed, buyer-controlled Polymarket deposit wallet; EOAs are not charged",
    {
      wallet,
      paymentAllowed: false,
      nextAction: "USE_READY_DEPOSIT_WALLET_OR_STOP",
    },
  );
  const predictedHex = String(predictedWord || "").replace(/^0x/, "");
  const predictedWallet =
    predictedHex.length >= 40
      ? `0x${predictedHex.slice(-40).toLowerCase()}`
      : "";
  const legacyPredictedHex = String(legacyPredictedWord || "").replace(/^0x/, "");
  const legacyPredictedWallet =
    legacyPredictedHex.length >= 40
      ? `0x${legacyPredictedHex.slice(-40).toLowerCase()}`
      : "";
  const predictionKind =
    predictedWallet === wallet
      ? "beacon"
      : legacyPredictedWallet === wallet
        ? "legacy-uups"
        : null;
  invariant(
    predictionKind !== null,
    "maker_not_eligible",
    "Polygon factory does not bind this wallet to the buyer's Polymarket owner",
    {
      wallet,
      owner: ownerAddress,
      predictedWallet: ADDRESS_RE.test(predictedWallet) ? predictedWallet : null,
      legacyPredictedWallet: ADDRESS_RE.test(legacyPredictedWallet)
        ? legacyPredictedWallet
        : null,
      paymentAllowed: false,
      nextAction: "USE_READY_DEPOSIT_WALLET_OR_STOP",
    },
  );
  const requiresBalanceCheck = BigInt(minimumBalanceRaw) > 0n;
  const setupVerifier =
    verifyApprovalStateImpl && (!requiresBalanceCheck || verifyBalanceImpl)
      ? null
      : createPolygonWalletSetupVerifier({ rpcUrl, fetchImpl });
  let approvalState;
  let balanceState;
  try {
    approvalState = verifyApprovalStateImpl
      ? await verifyApprovalStateImpl({ wallet })
      : await setupVerifier.verifyApprovalState({ wallet });
    balanceState = !requiresBalanceCheck
      ? { balanceRaw: null }
      : verifyBalanceImpl
        ? await verifyBalanceImpl({ wallet, minimumRaw: minimumBalanceRaw })
        : await setupVerifier.verifyPusdBalance({ wallet, minimumRaw: minimumBalanceRaw });
  } catch (error) {
    throw setupPreflightError(error);
  }
  return Object.freeze({
    ok: true,
    executionMode: "deposit-wallet",
    wallet,
    owner: ownerAddress,
    contractCodePresent: true,
    factoryPredictionMatched: true,
    factoryPredictionKind: predictionKind,
    venueApprovalsVerified: approvalState?.approvalCalls === 5,
    pUsdBalanceRaw: balanceState?.balanceRaw,
    minimumPusdBalanceRaw: String(minimumBalanceRaw),
  });
}

export function verifyBrowserWalletReadiness(walletValue, readinessInput) {
  const wallet = String(walletValue || "").trim().toLowerCase();
  const input =
    readinessInput &&
    typeof readinessInput === "object" &&
    !Array.isArray(readinessInput)
      ? readinessInput
      : null;
  const owner = String(input?.owner || "").trim().toLowerCase();
  const depositWallet = String(input?.depositWallet || "").trim().toLowerCase();
  invariant(
    input?.ok === true &&
      input?.version === "conviction-browser-wallet-readiness-v1" &&
      input?.status === "ready" &&
      ADDRESS_RE.test(owner) &&
      depositWallet === wallet,
    "missing_browser_wallet_readiness",
    "Browser OPEN requires the exact buyer owner and ready Deposit Wallet",
    {
      wallet,
      observedDepositWallet: ADDRESS_RE.test(depositWallet) ? depositWallet : null,
      paymentAllowed: false,
      nextAction: "COMPLETE_BROWSER_WALLET_SETUP",
    },
  );
  return Object.freeze({
    ok: true,
    source: "conviction-browser-wallet-setup",
    status: "ready",
    wallet,
    owner,
  });
}

export function verifyDepositWalletReadiness(walletValue, readinessInput) {
  const wallet = String(walletValue || "").trim().toLowerCase();
  const outer =
    readinessInput &&
    typeof readinessInput === "object" &&
    !Array.isArray(readinessInput)
      ? readinessInput
      : null;
  const data =
    outer?.data &&
    typeof outer.data === "object" &&
    !Array.isArray(outer.data)
      ? outer.data
      : outer;
  invariant(
    outer?.ok === true && data,
    "missing_wallet_readiness",
    "A successful official Polymarket quickstart result is required before payment",
  );
  const depositWallet = String(data?.wallet?.deposit_wallet || "").toLowerCase();
  const owner = String(data?.wallet?.eoa || "").toLowerCase();
  invariant(
    ADDRESS_RE.test(wallet) &&
      ADDRESS_RE.test(owner) &&
      depositWallet === wallet &&
      data.accessible === true &&
      ["deposit_wallet_ready", "active"].includes(String(data.status || "")),
    "maker_not_eligible",
    "Official Polymarket quickstart does not prove this wallet is the buyer's ready deposit wallet",
    {
      wallet,
      observedDepositWallet: ADDRESS_RE.test(depositWallet) ? depositWallet : null,
      observedStatus: data?.status ?? null,
      paymentAllowed: false,
      nextAction: "USE_READY_DEPOSIT_WALLET_OR_STOP",
    },
  );
  return Object.freeze({
    ok: true,
    wallet,
    owner,
    status: data.status,
    accessible: true,
    source: "official-polymarket-quickstart",
  });
}

export function requirePaidOpenExecutionMode(body) {
  invariant(
    body?.executionMode === "deposit-wallet" ||
      body?.executionMode === "browser-deposit-wallet",
    "maker_not_eligible",
    "OPEN is charged only for a verified ready Polymarket Deposit Wallet",
    {
      paymentAllowed: false,
      nextAction: "USE_READY_DEPOSIT_WALLET_OR_STOP",
    },
  );
}
