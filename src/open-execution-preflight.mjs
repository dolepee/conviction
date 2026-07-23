import { POLYGON_CHAIN_ID, POLYGON_RPC_URL } from "./constants.mjs";
import { parseDecimal } from "./decimal.mjs";
import { ConvictionError, invariant } from "./errors.mjs";

const ADDRESS_RE = /^0x[0-9a-f]{40}$/i;

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

export function verifyOpenPluginPreview(compilation, previewInput) {
  const data = pluginData(previewInput);
  const intent = compilation?.intent;
  const market = intent?.market;
  const order = intent?.order;
  invariant(intent && market && order, "invalid_compilation", "OPEN compilation is incomplete");

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

export async function verifyDepositWalletExecution(
  walletValue,
  {
    rpcUrl = POLYGON_RPC_URL,
    fetchImpl = fetch,
  } = {},
) {
  const wallet = String(walletValue || "").trim().toLowerCase();
  invariant(ADDRESS_RE.test(wallet), "invalid_wallet", "wallet must be a valid EVM address");
  const [chainHex, code] = await Promise.all([
    polygonRpc("eth_chainId", [], { rpcUrl, fetchImpl }),
    polygonRpc("eth_getCode", [wallet, "latest"], { rpcUrl, fetchImpl }),
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
      nextAction: "USE_READY_DEPOSIT_WALLET",
    },
  );
  return Object.freeze({
    ok: true,
    executionMode: "deposit-wallet",
    wallet,
    contractCodePresent: true,
  });
}

export function requirePaidOpenExecutionMode(body) {
  invariant(
    body?.executionMode === "deposit-wallet",
    "maker_not_eligible",
    "OPEN is charged only for an already-ready Polymarket deposit wallet",
    {
      paymentAllowed: false,
      nextAction: "USE_READY_DEPOSIT_WALLET",
    },
  );
}
