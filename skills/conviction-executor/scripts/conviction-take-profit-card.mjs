import { sha256 } from "../../../src/canonical.mjs";
import { CONTRACTS, POLYGON_CHAIN_ID } from "../../../src/constants.mjs";
import { parseDecimal } from "../../../src/decimal.mjs";
import { parsePolymarketShareAtoms } from "../../../src/polymarket-quantities.mjs";
import {
  trustedIssuerRegistry,
  verifyIntentIssuance,
} from "../../../src/intent-issuer.mjs";

const ADDRESS_RE = /^0x[0-9a-f]{40}$/i;
const HASH_RE = /^0x[0-9a-f]{64}$/i;
const TOKEN_ID_RE = /^(?:0|[1-9][0-9]*)$/;
const UINT_RE = /^(?:0|[1-9][0-9]*)$/;
const PRICE_SCALE = 1_000_000n;
const SHARE_SCALE = 1_000_000n;
const BPS_SCALE = 10_000n;
const PLACEMENT_TTL_MS = 300_000;
const VENUE_EXPIRY_HEADROOM_SECONDS = 90n;

export class TakeProfitCardValidationError extends Error {
  constructor(code, message, details = undefined) {
    super(message);
    this.name = "TakeProfitCardValidationError";
    this.code = code;
    this.details = details;
  }
}

function fail(condition, code, message, details = undefined) {
  if (!condition) throw new TakeProfitCardValidationError(code, message, details);
}

function record(value, label) {
  fail(value !== null && typeof value === "object" && !Array.isArray(value), "invalid_document", `${label} must be a JSON object`);
  return value;
}

function parseDocument(input, label) {
  if (Buffer.isBuffer(input)) input = input.toString("utf8");
  if (typeof input !== "string") return record(input, label);
  try {
    return record(JSON.parse(input), label);
  } catch {
    throw new TakeProfitCardValidationError("invalid_json", `${label} must contain valid JSON`);
  }
}

function lower(value) {
  return String(value || "").toLowerCase();
}

function raw(value, label, { positive = false } = {}) {
  const text = String(value ?? "");
  fail(UINT_RE.test(text), "invalid_take_profit_card", `${label} must be an unsigned integer`);
  const parsed = BigInt(text);
  if (positive) fail(parsed > 0n, "invalid_take_profit_card", `${label} must be positive`);
  return parsed;
}

function timestamp(value, label) {
  const text = String(value || "");
  const milliseconds = Date.parse(text);
  fail(
    Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === text,
    "invalid_expiry",
    `${label} must be a canonical ISO timestamp`,
  );
  return milliseconds;
}

function currentTime(value) {
  if (value === undefined) return Date.now();
  if (value instanceof Date) return value.getTime();
  if (typeof value === "number") {
    fail(Number.isFinite(value), "invalid_time", "now must be finite");
    return value;
  }
  const parsed = Date.parse(String(value));
  fail(Number.isFinite(parsed), "invalid_time", "now must be a timestamp or ISO date");
  return parsed;
}

function registry(value) {
  if (value instanceof Map) return value;
  const records = Array.isArray(value) ? value : value?.issuers;
  fail(Array.isArray(records), "missing_trusted_issuer", "A pinned trusted issuer registry is required");
  return trustedIssuerRegistry(records);
}

function sameDecimal(value, expectedRaw, label) {
  fail(
    parseDecimal(value, 6, label) === expectedRaw,
    "take_profit_economics_mismatch",
    `${label} disagrees with the take-profit card`,
  );
}

function unwrapPlugin(input, label) {
  const outer = parseDocument(input, label);
  const data = outer.data === undefined ? outer : record(outer.data, `${label}.data`);
  return { outer, data };
}

export function parseTakeProfitCard(input) {
  const outer = parseDocument(input, "take-profit card");
  const card = outer.response === undefined ? outer : record(outer.response, "take-profit card.response");
  fail(card.intent && card.intentHash && card.executionCard, "invalid_take_profit_card", "Document is not a Conviction take-profit card");
  return card;
}

export function validateTakeProfitCard(input, {
  now = undefined,
  allowExpired = false,
  trustedIssuers = undefined,
} = {}) {
  const card = parseTakeProfitCard(input);
  fail(card.ok === true, "invalid_take_profit_card", "Take-profit card must report ok=true");
  const intent = record(card.intent, "intent");
  const market = record(intent.market, "intent.market");
  const order = record(intent.order, "intent.order");
  const seller = record(intent.seller, "intent.seller");
  const position = record(intent.position, "intent.position");
  const source = record(intent.source, "intent.source");
  const snapshot = record(intent.snapshot, "intent.snapshot");
  const proceeds = record(intent.proceeds, "intent.proceeds");
  const executionCard = record(card.executionCard, "executionCard");

  fail(intent.version === "conviction-take-profit-intent-v1", "invalid_take_profit_card", "A Conviction take-profit intent v1 is required");
  fail(intent.action === "TAKE_PROFIT", "invalid_take_profit_card", "Intent action must be TAKE_PROFIT");
  fail(Number(intent.chainId) === POLYGON_CHAIN_ID, "wrong_chain", "Take-profit card is not for Polygon chain 137");
  fail(HASH_RE.test(card.intentHash || ""), "invalid_intent_hash", "Take-profit intent hash is invalid");
  const intentHash = lower(card.intentHash);
  fail(sha256(intent) === intentHash, "intent_hash_mismatch", "Take-profit intent hash does not match canonical JSON");

  fail(market.source === "polymarket", "invalid_venue", "Take-profit venue must be Polymarket");
  fail(HASH_RE.test(market.conditionId || ""), "invalid_market", "Condition ID is invalid");
  fail(lower(market.exchange) === CONTRACTS.standardExchangeV2, "wrong_exchange", "Take-profit card is not for standard CLOB V2");
  fail(lower(market.collateral) === CONTRACTS.pUsd, "wrong_collateral", "Take-profit card does not use V2 pUSD");
  fail(lower(market.conditionalTokens) === CONTRACTS.ctf, "wrong_conditional_tokens", "Take-profit card uses another outcome-token contract");
  fail(market.negRisk === false, "unsupported_neg_risk", "Neg-risk markets are not supported");

  fail(
    order.action === "TAKE_PROFIT" && order.side === "SELL" && order.orderType === "GTD" && order.postOnly === true,
    "invalid_take_profit_order",
    "Take profit must be a post-only GTD SELL",
  );
  const outcome = String(order.outcome || "").toUpperCase();
  fail(outcome === "YES" || outcome === "NO", "invalid_outcome", "Outcome must be YES or NO");
  fail(market.outcome === outcome, "outcome_mismatch", "Market and order outcomes disagree");
  const tokenId = String(order.outcomeTokenId || "");
  const counterOutcome = outcome === "YES" ? "NO" : "YES";
  const counterTokenId = String(market.outcomes?.[counterOutcome]?.tokenId || "");
  fail(TOKEN_ID_RE.test(tokenId), "invalid_token", "Selected outcome token is invalid");
  fail(
    String(market.outcomeTokenId || "") === tokenId &&
      String(market.outcomes?.[outcome]?.tokenId || "") === tokenId &&
      String(market.counterOutcomeTokenId || "") === counterTokenId &&
      TOKEN_ID_RE.test(counterTokenId) && counterTokenId !== tokenId,
    "token_mapping_mismatch",
    "YES/NO token mapping is inconsistent",
  );

  const wallet = lower(seller.wallet);
  fail(ADDRESS_RE.test(wallet), "invalid_wallet", "Seller wallet is invalid");
  const sharesRaw = raw(order.sharesRaw, "sharesRaw", { positive: true });
  const targetPriceRaw = parseDecimal(order.targetPrice, 6, "targetPrice");
  const minimumGrossRaw = raw(order.minimumGrossProceedsRaw, "minimumGrossProceedsRaw", { positive: true });
  const feeAtTargetRaw = raw(order.feeAtTargetPriceRaw, "feeAtTargetPriceRaw");
  const maximumFeeRaw = raw(order.maximumFeeRaw, "maximumFeeRaw");
  const minimumNetRaw = raw(order.minimumNetProceedsRaw, "minimumNetProceedsRaw");
  const feeBps = Number(order.feeBps);
  fail(sharesRaw % SHARE_SCALE === 0n, "take_profit_economics_mismatch", "Take-profit shares must be whole shares");
  fail(targetPriceRaw > 0n && targetPriceRaw < PRICE_SCALE, "invalid_price", "Target price is invalid");
  fail(sharesRaw * targetPriceRaw === minimumGrossRaw * SHARE_SCALE, "take_profit_economics_mismatch", "Shares, target, and full-fill proceeds disagree");
  fail(Number.isInteger(feeBps) && feeBps >= 0 && feeBps <= Number(BPS_SCALE), "invalid_fee", "Fee rate is invalid");
  fail(order.feeRateBpsMax === feeBps, "take_profit_economics_mismatch", "Fee-rate cap is inconsistent");
  const recomputedTargetFee = (minimumGrossRaw * BigInt(feeBps) + BPS_SCALE - 1n) / BPS_SCALE;
  const recomputedMaximumFee = (sharesRaw * BigInt(feeBps) + BPS_SCALE - 1n) / BPS_SCALE;
  fail(feeAtTargetRaw === recomputedTargetFee, "take_profit_economics_mismatch", "Fee at the target price is inconsistent");
  fail(maximumFeeRaw === recomputedMaximumFee, "take_profit_economics_mismatch", "Absolute maximum fee is inconsistent");
  fail(minimumNetRaw === minimumGrossRaw - feeAtTargetRaw, "take_profit_economics_mismatch", "Minimum net proceeds are inconsistent");
  fail(
    order.feeSource === "polymarket_clob_maker_base_fee" &&
      order.feeReserveMethod === "target=ceil(minimumGrossProceeds*feeBps/10000);absolute=ceil(shares*feeBps/10000)" &&
      order.feeEnforcement === "post-settlement-verification-only" &&
      order.proceedsPrecision === "v2-cent-aligned-whole-shares",
    "take_profit_economics_mismatch",
    "Take-profit fee or precision policy is unsupported",
  );
  sameDecimal(order.shares, sharesRaw, "shares");
  sameDecimal(order.minimumGrossProceeds, minimumGrossRaw, "minimumGrossProceeds");
  sameDecimal(order.feeAtTargetPrice, feeAtTargetRaw, "feeAtTargetPrice");
  sameDecimal(order.maximumFee, maximumFeeRaw, "maximumFee");
  sameDecimal(order.minimumNetProceeds, minimumNetRaw, "minimumNetProceeds");

  const venueExpiresAtMs = timestamp(order.venueExpiresAt, "order.venueExpiresAt");
  const venueExpiresAtUnix = raw(order.venueExpiresAtUnix, "order.venueExpiresAtUnix", { positive: true });
  fail(BigInt(venueExpiresAtMs / 1_000) === venueExpiresAtUnix, "invalid_venue_expiry", "Venue expiry timestamp and Unix seconds disagree");
  fail(venueExpiresAtMs % 1_000 === 0, "invalid_venue_expiry", "Venue expiry must be on a whole second");
  if (market.endDate !== null && market.endDate !== undefined && market.endDate !== "") {
    const marketEndMs = Date.parse(String(market.endDate));
    fail(Number.isFinite(marketEndMs), "invalid_market", "Market end date is invalid");
    fail(venueExpiresAtMs <= marketEndMs, "invalid_venue_expiry", "Venue expiry is after market end");
  }

  fail(position.wallet === wallet && position.outcomeTokenId === tokenId, "position_binding_mismatch", "Position snapshot is for another wallet or token");
  fail(position.approvedForExchange === true, "ctf_approval_missing", "Signed position snapshot has no V2 exchange approval");
  const availableSharesRaw = raw(position.availableSharesRaw, "availableSharesRaw", { positive: true });
  const requestedSharesRaw = raw(position.requestedTakeProfitSharesRaw, "requestedTakeProfitSharesRaw", { positive: true });
  const remainingSharesRaw = raw(position.remainingSharesAfterFullFillRaw, "remainingSharesAfterFullFillRaw");
  fail(requestedSharesRaw === sharesRaw && availableSharesRaw >= sharesRaw && remainingSharesRaw === availableSharesRaw - sharesRaw, "position_binding_mismatch", "Position quantities disagree with the take-profit order");
  fail(HASH_RE.test(position.observedAtBlockHash || "") && /^0x[0-9a-f]+$/i.test(position.observedAtBlock || ""), "invalid_position_snapshot", "Position block binding is invalid");

  for (const field of ["intentHash", "positionProofHash", "transactionHash", "orderId"]) {
    fail(HASH_RE.test(source[field] || ""), "invalid_source_proof", `source.${field} is invalid`);
  }
  fail(
    source.wallet === wallet && source.marketConditionId === lower(market.conditionId) &&
      source.outcome === outcome && source.outcomeTokenId === tokenId,
    "source_binding_mismatch",
    "Source proof identity differs from the take-profit order",
  );
  fail(raw(source.actualSharesRaw, "source.actualSharesRaw", { positive: true }) >= sharesRaw, "source_binding_mismatch", "Take profit exceeds the source verified fill");
  fail(
    (source.verificationMode === "signed-intent-window" && source.intentVersion === "conviction-intent-v4") ||
      (source.verificationMode === "retrospective" && ["conviction-intent-v2", "conviction-intent-v3"].includes(source.intentVersion)),
    "invalid_source_proof",
    "Source proof verification mode and intent version disagree",
  );

  const capturedAtMs = timestamp(snapshot.capturedAt, "snapshot.capturedAt");
  const expiresAtMs = timestamp(snapshot.expiresAt, "snapshot.expiresAt");
  fail(expiresAtMs - capturedAtMs === PLACEMENT_TTL_MS, "invalid_expiry", "Take-profit card must have an exact five-minute placement window");
  fail(venueExpiresAtUnix >= BigInt(Math.ceil(expiresAtMs / 1_000)) + VENUE_EXPIRY_HEADROOM_SECONDS, "invalid_venue_expiry", "Venue expiry has insufficient headroom beyond placement");
  fail(snapshot.positionCapturedAt === position.observedAt, "position_binding_mismatch", "Position timestamps disagree");
  fail(snapshot.positionBlockNumber === position.observedAtBlock && snapshot.positionBlockHash === position.observedAtBlockHash, "position_binding_mismatch", "Position blocks disagree");
  const tickRaw = parseDecimal(snapshot.tickSize, 6, "tickSize");
  const minOrderSizeRaw = parseDecimal(snapshot.minOrderSize, 6, "minOrderSize");
  fail(
    parseDecimal(market.tickSize, 6, "market.tickSize") === tickRaw &&
      parseDecimal(market.minOrderSize, 6, "market.minOrderSize") === minOrderSizeRaw,
    "market_snapshot_mismatch",
    "Signed market precision differs from the signed execution snapshot",
  );
  fail(tickRaw > 0n && targetPriceRaw % tickRaw === 0n, "price_tick_mismatch", "Target price does not align to the signed tick size");
  fail(minOrderSizeRaw > 0n && sharesRaw >= minOrderSizeRaw, "resting_order_below_minimum", "Take-profit shares are below the signed venue minimum");
  const bestBidRaw = snapshot.bestBid === null ? null : parseDecimal(snapshot.bestBid, 6, "bestBid");
  const bestAskRaw = snapshot.bestAsk === null ? null : parseDecimal(snapshot.bestAsk, 6, "bestAsk");
  fail(bestBidRaw === null || targetPriceRaw > bestBidRaw, "take_profit_would_cross", "Target price would cross the signed best bid");
  fail(bestBidRaw === null || bestAskRaw === null || bestAskRaw >= bestBidRaw, "invalid_orderbook", "Signed best ask is below best bid");

  sameDecimal(proceeds.minimumGrossProceeds, minimumGrossRaw, "proceeds.minimumGrossProceeds");
  sameDecimal(proceeds.feeAtTargetPrice, feeAtTargetRaw, "proceeds.feeAtTargetPrice");
  sameDecimal(proceeds.maximumFee, maximumFeeRaw, "proceeds.maximumFee");
  sameDecimal(proceeds.minimumNetProceeds, minimumNetRaw, "proceeds.minimumNetProceeds");
  fail(
    proceeds.grossProceedsPreventivelyEnforced === true &&
      proceeds.feeAndNetPreventivelyEnforced === false &&
      proceeds.feeAndNetEnforcement === "post-settlement-verification-only" &&
      proceeds.exactSharesOffered === true && proceeds.partialFillAllowed === true &&
      proceeds.restingOrder === true && proceeds.postOnlyRequested === true,
    "take_profit_economics_mismatch",
    "Take-profit proceeds policy is inconsistent",
  );

  const expectedArgv = [
    "sell", "--market-id", lower(market.conditionId), "--token-id", tokenId,
    "--outcome", outcome.toLowerCase(), "--shares", order.shares,
    "--price", order.targetPrice, "--order-type", "GTD", "--post-only",
    "--expires", venueExpiresAtUnix.toString(),
  ];
  fail(JSON.stringify(executionCard.argv) === JSON.stringify(expectedArgv), "execution_card_mismatch", "Execution arguments differ from the signed take-profit intent");
  fail(
    executionCard.tool === "polymarket-plugin" && executionCard.action === "sell" &&
      executionCard.requiresUserConfirmation === true && executionCard.nonCustodial === true &&
      executionCard.requiresSufficientPosition === true &&
      executionCard.authorizationScope === "single-bounded-take-profit" &&
      executionCard.exactAuthorizedShares === order.shares &&
      executionCard.targetPrice === order.targetPrice &&
      executionCard.minimumSignedGrossProceeds === order.minimumGrossProceeds &&
      executionCard.postSettlementNetVerificationFloor === order.minimumNetProceeds &&
      executionCard.feeAndNetPreventivelyEnforced === false &&
      executionCard.postOnly === true && executionCard.postOnlyRequested === true &&
      executionCard.partialFillAllowed === true &&
      executionCard.venueExpiresAt === order.venueExpiresAt &&
      executionCard.venueExpiresAtUnix === order.venueExpiresAtUnix &&
      executionCard.placementExpiresAt === snapshot.expiresAt &&
      executionCard.expiresAt === snapshot.expiresAt,
    "execution_card_mismatch",
    "Execution card policy differs from the take-profit intent",
  );

  const nowMs = currentTime(now);
  fail(allowExpired || nowMs < expiresAtMs, "expired_card", "Take-profit card expired");
  fail(nowMs >= capturedAtMs, "invalid_time", "Take-profit card snapshot is in the future");
  const issuanceVerification = verifyIntentIssuance({
    intent,
    intentHash,
    issuance: card.issuance,
    trustedIssuers: registry(trustedIssuers),
    settledAt: new Date(Math.min(nowMs, expiresAtMs)).toISOString(),
  });

  return {
    ok: true,
    intentHash,
    intent,
    issuance: card.issuance,
    executionCard,
    wallet,
    outcome,
    tokenId,
    bounds: {
      sharesRaw: sharesRaw.toString(),
      targetPrice: order.targetPrice,
      minimumGrossProceedsRaw: minimumGrossRaw.toString(),
      feeAtTargetPriceRaw: feeAtTargetRaw.toString(),
      maximumFeeRaw: maximumFeeRaw.toString(),
      minimumNetProceedsRaw: minimumNetRaw.toString(),
      feeBps,
      venueExpiresAt: order.venueExpiresAt,
      venueExpiresAtUnix: venueExpiresAtUnix.toString(),
    },
    expiresAt: snapshot.expiresAt,
    issuanceVerification,
  };
}

function validatePluginFields(validated, data, { preview }) {
  const marketId = lower(validated.intent.market.conditionId);
  fail(lower(data.condition_id) === marketId, "plugin_mismatch", "Plugin condition ID differs from take-profit card");
  if (preview || data.market_id !== undefined) {
    fail(lower(data.market_id) === marketId, "plugin_mismatch", "Plugin market ID differs from take-profit card");
  }
  fail(String(data.outcome || "").toUpperCase() === validated.outcome, "plugin_mismatch", "Plugin outcome differs from take-profit card");
  fail(String(data.token_id || "") === validated.tokenId, "plugin_mismatch", "Plugin token differs from take-profit card");
  fail(data.side === "SELL" && data.order_type === "GTD", "plugin_mismatch", "Plugin order must be a GTD SELL");
  sameDecimal(data.limit_price, parseDecimal(validated.bounds.targetPrice, 6, "card target price"), "plugin target price");
  if (data.limit_price_requested !== undefined) {
    sameDecimal(data.limit_price_requested, parseDecimal(validated.bounds.targetPrice, 6, "card target price"), "plugin requested target price");
  }
  if (data.price_adjusted !== undefined) fail(data.price_adjusted === false, "plugin_mismatch", "Plugin cannot rewrite the target price");
  sameDecimal(data.shares, BigInt(validated.bounds.sharesRaw), "plugin shares");
  if (preview || data.shares_requested !== undefined) sameDecimal(data.shares_requested, BigInt(validated.bounds.sharesRaw), "plugin requested shares");
  if (preview || data.fee_rate_bps !== undefined) fail(Number(data.fee_rate_bps) === validated.bounds.feeBps, "plugin_mismatch", "Plugin fee rate differs from take-profit card");
  fail(data.post_only === true, "plugin_mismatch", "Plugin did not preserve post-only placement");
  fail(String(data.expires) === validated.bounds.venueExpiresAtUnix, "plugin_mismatch", "Plugin venue expiry differs from take-profit card");
  if (preview || data.usdc_out !== undefined) {
    sameDecimal(data.usdc_out, BigInt(validated.bounds.minimumGrossProceedsRaw), "plugin full-fill proceeds");
  }
  for (const [field, expected] of [
    ["clob_version", "V2"],
    ["collateral_token", CONTRACTS.pUsd],
    ["exchange_address", CONTRACTS.standardExchangeV2],
  ]) {
    if (data[field] === undefined) continue;
    const actual = field === "clob_version" ? data[field] : lower(data[field]);
    fail(actual === expected, "plugin_mismatch", `Plugin ${field} differs from standard V2`);
  }
  if (data.neg_risk !== undefined) fail(data.neg_risk === false, "plugin_mismatch", "Plugin resolved a neg-risk market");
}

export function validateTakeProfitPluginPreview(cardInput, previewInput, options = {}) {
  const validated = validateTakeProfitCard(cardInput, options);
  const { outer, data } = unwrapPlugin(previewInput, "Polymarket take-profit dry run");
  fail(outer.ok === true && outer.dry_run === true, "not_dry_run", "Plugin output is not a successful dry run");
  fail(data.note === "dry-run: order not submitted", "not_dry_run", "Plugin did not confirm that no order was submitted");
  validatePluginFields(validated, data, { preview: true });
  return { ok: true, validated, preview: data };
}

export function validateTakeProfitLiveResult(cardInput, resultInput, options = {}) {
  const validated = validateTakeProfitCard(cardInput, options);
  const { outer, data } = unwrapPlugin(resultInput, "Polymarket take-profit live result");
  fail(outer.ok === true && outer.dry_run !== true, "not_live_result", "Plugin output is not a successful live result");
  fail(!String(data.note || "").toLowerCase().includes("dry-run"), "not_live_result", "Dry-run output cannot become a take-profit result");
  validatePluginFields(validated, data, { preview: false });
  const reportedStatus = String(data.status || "").toLowerCase();
  fail(
    ["live", "open", "unmatched", "matched", "filled", "partially_filled", "canceled", "cancelled", "expired"].includes(reportedStatus),
    "invalid_order_status",
    "Take-profit submission returned an unsupported order status",
  );
  const orderId = lower(data.order_id);
  fail(HASH_RE.test(orderId), "invalid_order_id", "Live take-profit result has no valid order ID");
  const reportedTransactions = data.tx_hashes === undefined ? [] : data.tx_hashes;
  fail(
    Array.isArray(reportedTransactions) && reportedTransactions.length <= 100 &&
      reportedTransactions.every((value) => HASH_RE.test(lower(value))) &&
      new Set(reportedTransactions.map(lower)).size === reportedTransactions.length,
    "invalid_live_result",
    "Take-profit submission returned invalid transaction metadata",
  );
  return {
    ok: true,
    validated,
    orderId,
    reportedStatus,
    // Informational only. Exact authenticated CLOB state and independent
    // Polygon receipts remain the sole sources of lifecycle/fill truth.
    reportedTransactions: Object.freeze(reportedTransactions.map(lower)),
    result: data,
  };
}

function validateExactOrderSnapshot(validated, live, snapshotInput) {
  const snapshot = record(snapshotInput, "authenticated exact-order snapshot");
  const order = record(snapshot.order, "authenticated exact-order snapshot.order");
  fail(snapshot.version === "conviction-polymarket-order-snapshot-v1", "invalid_order_proof", "Exact-order snapshot version is unsupported");
  fail(snapshot.verificationSource === "authenticated-polymarket-clob" && snapshot.onChain === false, "invalid_order_proof", "Resting-order proof source is invalid");
  fail(snapshot.credentialOwnerVerified === true, "invalid_order_proof", "Credential ownership was not verified");
  fail(lower(snapshot.depositWallet) === validated.wallet, "order_wallet_mismatch", "Exact order belongs to another deposit wallet");
  fail(lower(order.id) === live.orderId, "order_identity_mismatch", "Authenticated CLOB order differs from the submitted order");
  const venueStatus = String(order.status || "").toUpperCase();
  fail(
    venueStatus.length > 0 && venueStatus.length <= 64 && /^[A-Z0-9_]+$/.test(venueStatus),
    "invalid_order_response",
    "Authenticated CLOB order status is invalid",
  );
  fail(lower(order.market) === lower(validated.intent.market.conditionId), "order_market_mismatch", "Authenticated CLOB order belongs to another market");
  fail(String(order.assetId) === validated.tokenId, "order_token_mismatch", "Authenticated CLOB order belongs to another outcome token");
  fail(order.side === "SELL" && order.orderType === "GTD", "order_type_mismatch", "Authenticated order is not a GTD SELL");
  const originalSharesRaw = parsePolymarketShareAtoms(order.originalSize, "authenticated original size", {
    code: "take_profit_economics_mismatch",
    positive: true,
  });
  const matchedSharesRaw = parsePolymarketShareAtoms(order.sizeMatched, "authenticated matched size", {
    code: "take_profit_economics_mismatch",
  });
  fail(originalSharesRaw === BigInt(validated.bounds.sharesRaw), "take_profit_economics_mismatch", "Authenticated original size disagrees with the take-profit card");
  fail(matchedSharesRaw >= 0n && matchedSharesRaw <= originalSharesRaw, "invalid_order_response", "Authenticated matched size is invalid");
  sameDecimal(order.price, parseDecimal(validated.bounds.targetPrice, 6, "card target price"), "authenticated target price");
  fail(String(order.expiration) === validated.bounds.venueExpiresAtUnix, "order_expiry_mismatch", "Authenticated order expiry differs from the signed venue expiry");
  if (order.outcome) fail(String(order.outcome).toUpperCase() === validated.outcome, "outcome_mismatch", "Authenticated order outcome differs from the card");
  fail(Array.isArray(order.associatedTrades), "invalid_order_response", "Authenticated order has no associated-trade set");
  fail(new Set(order.associatedTrades.map(String)).size === order.associatedTrades.length, "invalid_order_response", "Authenticated order has duplicate associated trades");
  const createdAtSeconds = raw(order.createdAt, "order.createdAt", { positive: true });
  const placementStartSeconds = BigInt(Math.floor(timestamp(validated.intent.snapshot.capturedAt, "snapshot.capturedAt") / 1_000));
  const placementEndSeconds = BigInt(Math.floor(timestamp(validated.expiresAt, "snapshot.expiresAt") / 1_000));
  fail(createdAtSeconds >= placementStartSeconds && createdAtSeconds <= placementEndSeconds, "order_outside_signed_window", "Authenticated order was created outside the signed placement window");
  const fetchedAtMs = timestamp(snapshot.fetchedAt, "snapshot.fetchedAt");
  fail(BigInt(Math.floor(fetchedAtMs / 1_000)) >= createdAtSeconds, "invalid_order_proof", "Order snapshot predates order creation");
  const status = classifyTakeProfitOrderSnapshot(snapshot);
  if (status === "ARMED") {
    fail(fetchedAtMs < timestamp(validated.bounds.venueExpiresAt, "order.venueExpiresAt"), "order_proof_after_expiry", "An expired GTD order cannot be proved ARMED");
    fail(order.associatedTrades.length === 0, "unexpected_settlement", "A zero-match ARMED order cannot already have associated trades");
  }
  return { snapshot, order, createdAtSeconds, originalSharesRaw, matchedSharesRaw, status };
}

export function buildTakeProfitOrderProof(cardInput, liveResultInput, snapshotInput, {
  trustedIssuers,
  confirmedAt,
} = {}) {
  const live = validateTakeProfitLiveResult(cardInput, liveResultInput, {
    trustedIssuers,
    allowExpired: true,
  });
  const exact = validateExactOrderSnapshot(live.validated, live, snapshotInput);
  const confirmedAtMs = currentTime(confirmedAt);
  fail(
    exact.createdAtSeconds > BigInt(Math.floor(confirmedAtMs / 1_000)),
    "order_before_confirmation",
    "Authenticated order does not strictly postdate the buyer's take-profit confirmation",
  );
  const armed = exact.status === "ARMED";
  const proof = {
    version: armed ? "conviction-resting-order-proof-v1" : "conviction-submitted-order-proof-v1",
    status: exact.status,
    verificationSource: "authenticated-polymarket-clob",
    onChain: false,
    intentHash: live.validated.intentHash,
    sourceIntentHash: live.validated.intent.source.intentHash,
    sourcePositionProofHash: live.validated.intent.source.positionProofHash,
    orderId: live.orderId,
    wallet: live.validated.wallet,
    marketConditionId: lower(live.validated.intent.market.conditionId),
    outcome: live.validated.outcome,
    outcomeTokenId: live.validated.tokenId,
    bounds: {
      exactSharesRaw: live.validated.bounds.sharesRaw,
      targetPrice: live.validated.bounds.targetPrice,
      minimumGrossProceedsRaw: live.validated.bounds.minimumGrossProceedsRaw,
      maximumFeeRaw: live.validated.bounds.maximumFeeRaw,
      minimumNetProceedsRaw: live.validated.bounds.minimumNetProceedsRaw,
      venueExpiresAt: live.validated.bounds.venueExpiresAt,
      venueExpiresAtUnix: live.validated.bounds.venueExpiresAtUnix,
      postOnlyRequested: true,
      partialFillAllowed: true,
    },
    observed: {
      status: exact.order.status,
      side: exact.order.side,
      orderType: exact.order.orderType,
      originalSharesRaw: exact.originalSharesRaw.toString(),
      matchedSharesRaw: exact.matchedSharesRaw.toString(),
      price: exact.order.price,
      expiration: exact.order.expiration,
      createdAt: exact.order.createdAt,
      fetchedAt: exact.snapshot.fetchedAt,
    },
    checks: {
      canonicalTakeProfitIntentHash: true,
      trustedIssuerSignature: true,
      verifiedSourcePositionBound: true,
      selectedOutcomeToken: true,
      exactCredentialOwner: true,
      exactDepositWallet: true,
      exactOrderId: true,
      exactGtdSell: true,
      exactSharesOffered: true,
      zeroInitiallyMatched: exact.matchedSharesRaw === 0n,
      initialMatchedSharesBounded: exact.matchedSharesRaw >= 0n && exact.matchedSharesRaw <= exact.originalSharesRaw,
      authenticatedInitialExactOrder: true,
      targetPriceBound: true,
      venueExpiryBound: true,
      orderCreatedAfterConfirmation: true,
      orderCreatedInsideSignedPlacementWindow: true,
    },
  };
  const passport = {
    version: "conviction-take-profit-passport-v1",
    status: exact.status,
    issuance: live.validated.issuance,
    intent: live.validated.intent,
    restingOrderProof: proof,
  };
  return {
    ok: true,
    status: exact.status,
    recoverable: !armed,
    settlementProofRequired: exact.matchedSharesRaw > 0n,
    initialOrderSnapshot: exact.snapshot,
    initialOrderSnapshotHash: sha256(exact.snapshot),
    orderId: live.orderId,
    restingOrderProof: proof,
    restingOrderProofHash: sha256(proof),
    takeProfitPassport: passport,
    takeProfitPassportHash: sha256(passport),
  };
}

export function classifyTakeProfitOrderSnapshot(snapshotInput) {
  const snapshot = record(snapshotInput, "take-profit order snapshot");
  const order = record(snapshot.order, "take-profit order snapshot.order");
  const originalRaw = parsePolymarketShareAtoms(order.originalSize, "order original size", {
    code: "invalid_order_response",
    positive: true,
  });
  const matchedRaw = parsePolymarketShareAtoms(order.sizeMatched, "order matched size", {
    code: "invalid_order_response",
  });
  fail(originalRaw > 0n && matchedRaw >= 0n && matchedRaw <= originalRaw, "invalid_order_response", "Take-profit order quantities are invalid");
  const status = String(order.status || "").toUpperCase();
  if (matchedRaw === originalRaw) return "FILLED_PENDING_CHAIN_PROOF";
  if (matchedRaw > 0n) {
    if (["CANCELED", "CANCELLED", "ORDER_STATUS_CANCELED", "ORDER_STATUS_CANCELLED"].includes(status)) {
      return "PARTIAL_CANCELED_PENDING_CHAIN_PROOF";
    }
    if (["EXPIRED", "ORDER_STATUS_EXPIRED"].includes(status)) {
      return "PARTIAL_EXPIRED_PENDING_CHAIN_PROOF";
    }
    return "PARTIAL_PENDING_CHAIN_PROOF";
  }
  if (["LIVE", "OPEN", "UNMATCHED", "ORDER_STATUS_LIVE", "ORDER_STATUS_OPEN", "ORDER_STATUS_UNMATCHED"].includes(status)) {
    const fetchedAtMs = timestamp(snapshot.fetchedAt, "snapshot.fetchedAt");
    const expiration = raw(order.expiration, "order.expiration", { positive: true });
    if (BigInt(Math.floor(fetchedAtMs / 1_000)) >= expiration) return "UNKNOWN";
    return "ARMED";
  }
  if (["MATCHED", "ORDER_STATUS_MATCHED"].includes(status)) {
    return "UNKNOWN";
  }
  if (["CANCELED", "CANCELLED", "ORDER_STATUS_CANCELED", "ORDER_STATUS_CANCELLED"].includes(status)) return "CANCELED";
  if (["EXPIRED", "ORDER_STATUS_EXPIRED"].includes(status)) return "EXPIRED";
  return "UNKNOWN";
}
