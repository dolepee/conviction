#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

import { sha256 } from "../../../src/canonical.mjs";
import { CONTRACTS, POLYGON_CHAIN_ID } from "../../../src/constants.mjs";
import { formatDecimal, parseDecimal } from "../../../src/decimal.mjs";
import {
  trustedIssuerRegistry,
  verifyIntentIssuance,
} from "../../../src/intent-issuer.mjs";

const ADDRESS_RE = /^0x[0-9a-f]{40}$/i;
const HASH_RE = /^0x[0-9a-f]{64}$/i;
const CONDITION_ID_RE = /^0x[0-9a-f]{64}$/i;
const TOKEN_ID_RE = /^\d+$/;
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const PRICE_SCALE = 1_000_000n;
const SHARE_SCALE = 1_000_000n;
const BPS_SCALE = 10_000n;
const V2_PRINCIPAL_STEP_RAW = 10_000n;
const MAX_CARD_TTL_MS = 300_000;

export class CardValidationError extends Error {
  constructor(code, message, details = undefined) {
    super(message);
    this.name = "CardValidationError";
    this.code = code;
    this.details = details;
  }
}

function fail(condition, code, message, details = undefined) {
  if (!condition) throw new CardValidationError(code, message, details);
}

function record(value, label) {
  fail(
    value !== null && typeof value === "object" && !Array.isArray(value),
    "invalid_document",
    `${label} must be a JSON object`,
  );
  return value;
}

function executorDiscoveryMatches(card, action) {
  const expectedAction = String(action || "").toUpperCase();
  const intentExecutor = card?.intent?.executor;
  const topLevelExecutor = card?.executor;
  const executionCard = card?.executionCard;
  const nextStep = card?.nextStep;
  if (!intentExecutor || !topLevelExecutor || !executionCard || !nextStep) return false;
  const releaseHash = sha256(intentExecutor);
  const entrypoint = intentExecutor?.entrypoints?.[expectedAction];
  return sha256(topLevelExecutor) === releaseHash &&
    executionCard.executorReleaseHash === releaseHash &&
    nextStep.action === expectedAction &&
    nextStep.executorReleaseHash === releaseHash &&
    nextStep.preferredMode === intentExecutor?.preferredModeByAction?.[expectedAction] &&
    nextStep.fallback?.mode === intentExecutor?.fallbackMode &&
    sha256(nextStep.fallback?.source) === sha256(intentExecutor?.source) &&
    sha256(nextStep.fallback?.entrypoint) === sha256(entrypoint) &&
    nextStep.requiresBuyerLocalExecution === true &&
    nextStep.requiresSeparateTradeConfirmation === true;
}

function parseDocument(input, label) {
  if (Buffer.isBuffer(input)) input = input.toString("utf8");
  if (typeof input !== "string") return record(input, label);
  try {
    return record(JSON.parse(input), label);
  } catch {
    throw new CardValidationError("invalid_json", `${label} must contain valid JSON`);
  }
}

function lower(value) {
  return String(value || "").toLowerCase();
}

function ceilDiv(numerator, denominator) {
  return (numerator + denominator - 1n) / denominator;
}

function rawInteger(value, label, { positive = false } = {}) {
  const text = String(value ?? "");
  fail(TOKEN_ID_RE.test(text), "invalid_card", `${label} must be an unsigned integer`);
  const parsed = BigInt(text);
  if (positive) fail(parsed > 0n, "invalid_card", `${label} must be positive`);
  return parsed;
}

function sameDecimal(actual, expectedRaw, label) {
  const actualRaw = parseDecimal(actual, 6, label);
  fail(actualRaw === expectedRaw, "card_economics_mismatch", `${label} disagrees with the card`);
}

function timestamp(value, label) {
  const parsed = Date.parse(String(value || ""));
  fail(Number.isFinite(parsed), "invalid_expiry", `${label} must be an ISO timestamp`);
  return parsed;
}

function currentTime(value) {
  if (value === undefined) return Date.now();
  if (value instanceof Date) return value.getTime();
  if (typeof value === "number") {
    fail(Number.isFinite(value), "invalid_time", "now must be a finite timestamp");
    return value;
  }
  const parsed = Date.parse(String(value));
  fail(Number.isFinite(parsed), "invalid_time", "now must be a timestamp or ISO date");
  return parsed;
}

function exactChecks(checks, names, label) {
  record(checks, label);
  for (const name of names) {
    fail(checks[name] === true, "invalid_proof", `${label}.${name} must be true`);
  }
}

function unwrapPlugin(input, label) {
  const outer = parseDocument(input, label);
  const data = outer.data === undefined ? outer : record(outer.data, `${label}.data`);
  return { outer, data };
}

function issuerRegistry(value) {
  if (value instanceof Map) return value;
  const records = Array.isArray(value) ? value : value?.issuers;
  fail(Array.isArray(records), "missing_trusted_issuer", "A pinned trusted issuer registry is required");
  return trustedIssuerRegistry(records);
}

export function parseCard(input) {
  const outer = parseDocument(input, "position card");
  const candidate = outer.response === undefined
    ? outer
    : record(outer.response, "position card.response");
  fail(
    candidate.intent && candidate.intentHash && candidate.executionCard,
    "invalid_card",
    "Document is not a raw or wrapped Conviction position card",
  );
  return candidate;
}

export function validateCard(input, {
  now = undefined,
  allowExpired = false,
  allowLegacyV3 = false,
  trustedIssuers = undefined,
} = {}) {
  const card = parseCard(input);
  fail(card.ok === true, "invalid_card", "Position card must report ok=true");

  const intent = record(card.intent, "intent");
  const market = record(intent.market, "intent.market");
  const order = record(intent.order, "intent.order");
  const buyer = record(intent.buyer, "intent.buyer");
  const snapshot = record(intent.snapshot, "intent.snapshot");
  const exposure = record(intent.exposure, "intent.exposure");
  const executionCard = record(card.executionCard, "executionCard");

  const signedV4 = intent.version === "conviction-intent-v4";
  fail(
    signedV4 || (allowLegacyV3 && intent.version === "conviction-intent-v3"),
    "invalid_card",
    "A signed Conviction intent v4 card is required",
  );
  fail(
    !signedV4 || executorDiscoveryMatches(card, "OPEN"),
    "executor_discovery_mismatch",
    "Position card executor discovery is missing or substituted",
  );
  fail(HASH_RE.test(card.intentHash), "invalid_intent_hash", "Intent hash must be a 32-byte hash");
  const intentHash = lower(card.intentHash);
  fail(sha256(intent) === intentHash, "intent_hash_mismatch", "Intent hash does not match canonical intent JSON");
  fail(Number(intent.chainId) === POLYGON_CHAIN_ID, "wrong_chain", "Position card is not for Polygon chain 137");

  fail(market.source === "polymarket", "invalid_venue", "Position card venue must be Polymarket");
  fail(CONDITION_ID_RE.test(market.conditionId || ""), "invalid_market", "Condition ID is invalid");
  fail(
    market.slug === null || market.slug === undefined || SLUG_RE.test(market.slug),
    "invalid_market",
    "Market slug is invalid",
  );
  fail(lower(market.exchange) === CONTRACTS.standardExchangeV2, "wrong_exchange", "Position card is not for standard CLOB V2");
  fail(lower(market.collateral) === CONTRACTS.pUsd, "wrong_collateral", "Position card does not use V2 pUSD collateral");
  fail(market.negRisk === false, "unsupported_neg_risk", "Neg-risk markets are not supported");
  fail(order.side === "BUY" && order.orderType === "FAK", "invalid_order", "Position card must be a FAK BUY");

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
      TOKEN_ID_RE.test(counterTokenId) &&
      counterTokenId !== tokenId,
    "token_mapping_mismatch",
    "YES/NO token mapping is inconsistent",
  );

  const wallet = lower(buyer.wallet);
  fail(ADDRESS_RE.test(wallet), "invalid_wallet", "Buyer wallet is invalid");

  const requestedBudgetRaw = rawInteger(order.requestedBudgetRaw, "requestedBudgetRaw", { positive: true });
  const principalRaw = rawInteger(order.maximumOrderPrincipalRaw, "maximumOrderPrincipalRaw", { positive: true });
  const maximumFeeRaw = rawInteger(order.maximumFeeRaw, "maximumFeeRaw");
  const maximumTotalDebitRaw = rawInteger(order.maximumTotalDebitRaw, "maximumTotalDebitRaw", { positive: true });
  const maximumSpendRaw = rawInteger(order.maximumSpendRaw, "maximumSpendRaw", { positive: true });
  const fullFillSharesRaw = rawInteger(order.fullFillSharesAtCapRaw, "fullFillSharesAtCapRaw", { positive: true });
  const maxPriceRaw = parseDecimal(order.maxPrice, 6, "maxPrice");
  fail(maxPriceRaw > 0n && maxPriceRaw < PRICE_SCALE, "invalid_price", "Maximum price must be between zero and one");
  const feeBps = Number(order.feeBps);
  fail(Number.isInteger(feeBps) && feeBps >= 0 && feeBps <= 10_000, "invalid_fee", "Fee rate is invalid");

  fail(fullFillSharesRaw % SHARE_SCALE === 0n, "card_economics_mismatch", "Position card must encode whole shares");
  fail(
    principalRaw % V2_PRINCIPAL_STEP_RAW === 0n &&
      order.principalPrecision === "v2-cent-aligned-whole-shares",
    "card_economics_mismatch",
    "Principal is not standard-V2 cent aligned",
  );
  fail(
    fullFillSharesRaw * maxPriceRaw === principalRaw * SHARE_SCALE,
    "card_economics_mismatch",
    "Principal, shares, and maximum price disagree",
  );
  const recomputedFeeRaw = ceilDiv(principalRaw * BigInt(feeBps), BPS_SCALE);
  fail(
    maximumFeeRaw === recomputedFeeRaw &&
      maximumTotalDebitRaw === principalRaw + maximumFeeRaw &&
      maximumSpendRaw === maximumTotalDebitRaw &&
      requestedBudgetRaw >= maximumTotalDebitRaw,
    "card_economics_mismatch",
    "Fee-inclusive budget fields disagree",
  );
  fail(
    order.feeSource === "polymarket_clob_maker_base_fee" &&
      order.feeReserveMethod === "ceil(orderPrincipal*feeBps/10000)" &&
      order.feeEnforcement === (signedV4
        ? "signed-order-bounds-plus-post-settlement-verification"
        : "dedicated-wallet-balance-cap-plus-post-settlement-verification"),
    "card_economics_mismatch",
    "Fee policy is not the supported V2 policy",
  );

  sameDecimal(order.requestedBudget, requestedBudgetRaw, "requestedBudget");
  sameDecimal(order.maximumOrderPrincipal, principalRaw, "maximumOrderPrincipal");
  sameDecimal(order.maximumFee, maximumFeeRaw, "maximumFee");
  sameDecimal(order.maximumTotalDebit, maximumTotalDebitRaw, "maximumTotalDebit");
  sameDecimal(order.maximumSpend, maximumTotalDebitRaw, "maximumSpend");
  sameDecimal(order.unusedBudget, requestedBudgetRaw - maximumTotalDebitRaw, "unusedBudget");
  sameDecimal(order.fullFillSharesAtCap, fullFillSharesRaw, "fullFillSharesAtCap");

  const bestAskRaw = parseDecimal(snapshot.bestAsk, 6, "bestAsk");
  const boundedDepthRaw = parseDecimal(snapshot.boundedAskDepth, 6, "boundedAskDepth");
  fail(bestAskRaw > 0n && bestAskRaw <= maxPriceRaw, "invalid_price", "Maximum price is below the recorded best ask");
  fail(boundedDepthRaw >= fullFillSharesRaw, "insufficient_depth", "Recorded bounded depth cannot cover the card");
  if (snapshot.bestBid !== null && snapshot.bestBid !== undefined) {
    const bestBidRaw = parseDecimal(snapshot.bestBid, 6, "bestBid");
    fail(bestBidRaw <= bestAskRaw, "invalid_orderbook", "Recorded best bid exceeds best ask");
  }

  const capturedAtMs = timestamp(snapshot.capturedAt, "snapshot.capturedAt");
  const expiresAtMs = timestamp(snapshot.expiresAt, "snapshot.expiresAt");
  fail(
    expiresAtMs > capturedAtMs &&
      (signedV4
        ? expiresAtMs - capturedAtMs === MAX_CARD_TTL_MS
        : expiresAtMs - capturedAtMs <= MAX_CARD_TTL_MS),
    "invalid_expiry",
    signedV4
      ? "Signed v4 card must expire exactly five minutes after capture"
      : "Card expiry must be after capture and no more than five minutes later",
  );
  fail(executionCard.expiresAt === snapshot.expiresAt, "invalid_expiry", "Execution-card and snapshot expiries disagree");
  if (signedV4) {
    verifyIntentIssuance({
      intent,
      intentHash,
      issuance: card.issuance,
      trustedIssuers: issuerRegistry(trustedIssuers),
      // This verifies the signed issuance window without inventing a settlement
      // time. The receipt endpoint remains responsible for checking the mined
      // settlement timestamp against the same signed window.
      settledAt: card.issuance?.issuedAt,
    });
  }
  if (!allowExpired) {
    const nowMs = currentTime(now);
    fail(nowMs >= capturedAtMs, "invalid_expiry", "Position card snapshot is from the future");
    fail(nowMs < expiresAtMs, "expired_card", "Position card has expired");
  }

  const priceCushionRaw = maxPriceRaw - bestAskRaw;
  const coverageBps = (boundedDepthRaw * BPS_SCALE) / fullFillSharesRaw;
  const breakEvenRaw = ceilDiv(maximumTotalDebitRaw * SHARE_SCALE, fullFillSharesRaw);
  fail(
    exposure.maximumLoss === formatDecimal(maximumTotalDebitRaw, 6) &&
      exposure.fullFillPayoutAtCap === formatDecimal(fullFillSharesRaw, 6) &&
      exposure.grossProfitAtCap === formatDecimal(fullFillSharesRaw - maximumTotalDebitRaw, 6) &&
      exposure.grossBreakEvenPrice === formatDecimal(breakEvenRaw, 6) &&
      exposure.priceCapCushion === formatDecimal(priceCushionRaw, 6) &&
      exposure.boundedLiquidityCoverageBps === coverageBps.toString() &&
      exposure.feesIncluded === true &&
      exposure.maximumFee === formatDecimal(maximumFeeRaw, 6) &&
      exposure.maximumTotalDebit === formatDecimal(maximumTotalDebitRaw, 6) &&
      exposure.unusedBudget === formatDecimal(requestedBudgetRaw - maximumTotalDebitRaw, 6) &&
      exposure.assumesFullFillAtCap === true,
    "card_exposure_mismatch",
    "Exposure summary disagrees with the bounded order",
  );

  const marketId = signedV4 ? lower(market.conditionId) : market.slug || lower(market.conditionId);
  const expectedArgv = signedV4
    ? [
      "buy",
      "--market-id",
      lower(market.conditionId),
      "--token-id",
      tokenId,
      "--outcome",
      outcome.toLowerCase(),
      "--amount",
      formatDecimal(principalRaw, 6),
      "--price",
      formatDecimal(maxPriceRaw, 6),
      "--order-type",
      "FAK",
    ]
    : [
      "buy",
      "--market-id",
      marketId,
      "--outcome",
      outcome.toLowerCase(),
      "--amount",
      formatDecimal(principalRaw, 6),
      "--price",
      formatDecimal(maxPriceRaw, 6),
      "--order-type",
      "FAK",
    ];
  fail(
    executionCard.tool === "polymarket-plugin" &&
      executionCard.action === "buy" &&
      Array.isArray(executionCard.argv) &&
      JSON.stringify(executionCard.argv) === JSON.stringify(expectedArgv) &&
      executionCard.requiresUserConfirmation === true &&
      executionCard.nonCustodial === true &&
      executionCard.requiresSufficientBalance === true &&
      executionCard.authorizationScope === "single-bounded-order" &&
      executionCard.maximumAuthorizedDebit === formatDecimal(maximumTotalDebitRaw, 6),
    "invalid_execution_card",
    "Execution arguments or safety flags disagree with the canonical intent",
  );

  return {
    ok: true,
    card,
    intent,
    executionCard,
    issuance: card.issuance,
    intentHash,
    outcome,
    tokenId,
    wallet,
    marketId,
    expiresAt: snapshot.expiresAt,
    bounds: {
      requestedBudgetRaw: requestedBudgetRaw.toString(),
      maximumOrderPrincipalRaw: principalRaw.toString(),
      maximumFeeRaw: maximumFeeRaw.toString(),
      maximumTotalDebitRaw: maximumTotalDebitRaw.toString(),
      fullFillSharesRaw: fullFillSharesRaw.toString(),
      maxPrice: formatDecimal(maxPriceRaw, 6),
      feeBps,
    },
  };
}

function validatePluginOrderFields(validated, data, { preview }) {
  const { intent, outcome, tokenId, marketId, bounds } = validated;
  const market = intent.market;
  fail(String(data.condition_id || "").toLowerCase() === lower(market.conditionId), "plugin_mismatch", "Plugin condition ID differs from card");
  // The V2 live response can omit the request-only market_id after resolving
  // the canonical condition and token. The dry run must always echo it, and a
  // live result that does include it must still match. condition_id and
  // token_id remain mandatory for both paths.
  if (preview || data.market_id !== undefined) {
    fail(String(data.market_id || "") === marketId, "plugin_mismatch", "Plugin market ID differs from card");
  }
  fail(String(data.outcome || "").toUpperCase() === outcome, "plugin_mismatch", "Plugin outcome differs from card");
  fail(String(data.token_id || "") === tokenId, "plugin_mismatch", "Plugin outcome token differs from card");
  fail(data.side === "BUY" && data.order_type === "FAK", "plugin_mismatch", "Plugin order must be a FAK BUY");
  sameDecimal(data.limit_price, BigInt(parseDecimal(bounds.maxPrice, 6, "card max price")), "plugin limit price");

  const principalRaw = parseDecimal(data.usdc_amount, 6, "plugin pUSD amount");
  const sharesRaw = parseDecimal(data.shares, 6, "plugin shares");
  const maximumPrincipalRaw = BigInt(bounds.maximumOrderPrincipalRaw);
  const maximumSharesRaw = BigInt(bounds.fullFillSharesRaw);
  if (preview) {
    fail(principalRaw === maximumPrincipalRaw, "plugin_mismatch", "Dry run rewrote the card principal");
    fail(sharesRaw === maximumSharesRaw, "plugin_mismatch", "Dry run rewrote the card shares");
    sameDecimal(data.usdc_requested, maximumPrincipalRaw, "plugin requested pUSD");
  } else {
    fail(principalRaw > 0n && principalRaw <= maximumPrincipalRaw, "plugin_mismatch", "Live principal is outside card bounds");
    fail(sharesRaw > 0n && sharesRaw <= maximumSharesRaw, "plugin_mismatch", "Live shares are outside card bounds");
  }

  for (const [field, expected] of [
    ["clob_version", "V2"],
    ["collateral_token", CONTRACTS.pUsd],
    ["exchange_address", CONTRACTS.standardExchangeV2],
  ]) {
    if (!preview && data[field] === undefined) continue;
    const actual = field.endsWith("_token") || field.endsWith("_address")
      ? lower(data[field])
      : data[field];
    fail(actual === expected, "plugin_mismatch", `Plugin ${field} differs from standard V2`);
  }
  if (preview || data.neg_risk !== undefined) {
    fail(data.neg_risk === false, "plugin_mismatch", "Plugin resolved a neg-risk market");
  }
  if (preview || data.fee_rate_bps !== undefined) {
    fail(Number(data.fee_rate_bps) === bounds.feeBps, "plugin_mismatch", "Plugin fee rate differs from card");
  }
  if (preview || data.post_only !== undefined) {
    fail(data.post_only === false, "plugin_mismatch", "Plugin unexpectedly enabled post-only mode");
  }
  if (preview || data.expires !== undefined) {
    fail(data.expires === null, "plugin_mismatch", "FAK order must not become a resting expiring order");
  }
}

export function validatePluginPreview(cardInput, previewInput, options = {}) {
  const validated = validateCard(cardInput, options);
  const { outer, data } = unwrapPlugin(previewInput, "Polymarket dry run");
  fail(outer.ok === true && outer.dry_run === true, "not_dry_run", "Plugin output is not an official successful dry run");
  fail(data.note === "dry-run: order not submitted", "not_dry_run", "Plugin did not confirm that no order was submitted");
  validatePluginOrderFields(validated, data, { preview: true });
  return {
    ok: true,
    intentHash: validated.intentHash,
    wallet: validated.wallet,
    outcome: validated.outcome,
    tokenId: validated.tokenId,
    maximumTotalDebitRaw: validated.bounds.maximumTotalDebitRaw,
    preview: data,
  };
}

export function validateLivePluginResult(cardInput, resultInput, options = {}) {
  // A live result may arrive after the pre-trade card expires. Expiry must have
  // been checked before preview/execution; post-fill construction validates the
  // immutable card and the result without pretending it can undo a mined fill.
  const validated = validateCard(cardInput, {
    allowExpired: true,
    trustedIssuers: options.trustedIssuers,
    allowLegacyV3: options.allowLegacyV3 === true,
  });
  const { outer, data } = unwrapPlugin(resultInput, "Polymarket live result");
  fail(outer.ok === true && outer.dry_run !== true, "not_live_result", "Plugin output is not a successful live result");
  fail(!String(data.note || "").toLowerCase().includes("dry-run"), "not_live_result", "Dry-run output cannot become a receipt request");
  validatePluginOrderFields(validated, data, { preview: false });
  fail(String(data.status || "").toLowerCase() === "matched", "unsettled_order", "FAK order is not reported matched");
  const orderId = lower(data.order_id);
  fail(HASH_RE.test(orderId), "invalid_order_id", "Live result has no valid order ID");
  fail(Array.isArray(data.tx_hashes) && data.tx_hashes.length === 1, "ambiguous_settlement", "Exactly one settlement transaction is required");
  const transactionHash = lower(data.tx_hashes[0]);
  fail(HASH_RE.test(transactionHash), "invalid_transaction_hash", "Live result has no valid settlement transaction hash");
  return { ok: true, validated, orderId, transactionHash, result: data };
}

const TERMINAL_ZERO_FILL_STATUSES = new Set([
  "canceled",
  "cancelled",
  "expired",
  "failed",
  "rejected",
  "unmatched",
]);

/**
 * Authenticate the local plugin's identity for a terminal zero-fill FAK BUY.
 * This is deliberately not sufficient by itself to release an execution lock:
 * reconciliation must also bind the order ID to a fresh authenticated CLOB
 * snapshot proving zero matched shares and a terminal FAK state.
 */
export function validateTerminalZeroOpenResult(cardInput, resultInput, options = {}) {
  const validated = validateCard(cardInput, {
    allowExpired: true,
    trustedIssuers: options.trustedIssuers,
    allowLegacyV3: options.allowLegacyV3 === true,
  });
  const { outer, data } = unwrapPlugin(resultInput, "Polymarket terminal OPEN result");
  fail(typeof outer.ok === "boolean" && outer.dry_run !== true, "not_live_result", "Terminal OPEN result is not a live plugin result");
  fail(!String(data.note || "").toLowerCase().includes("dry-run"), "not_live_result", "Dry-run output cannot become terminal OPEN evidence");
  validatePluginOrderFields(validated, data, { preview: false });
  const status = String(data.status || "").toLowerCase();
  fail(TERMINAL_ZERO_FILL_STATUSES.has(status), "nonterminal_open", "OPEN result is not a supported terminal zero-fill status");
  const orderId = lower(data.order_id);
  fail(HASH_RE.test(orderId), "invalid_order_id", "Terminal OPEN result has no valid order ID");
  const transactionHashes = data.tx_hashes === undefined ? [] : data.tx_hashes;
  fail(Array.isArray(transactionHashes) && transactionHashes.length === 0, "ambiguous_settlement", "Terminal zero-fill OPEN cannot report a settlement transaction");
  return {
    ok: true,
    validated,
    orderId,
    status,
    reportedSharesRaw: parseDecimal(data.shares, 6, "plugin shares").toString(),
    result: data,
  };
}

export function buildReceiptRequest(cardInput, resultInput, options = {}) {
  const live = validateLivePluginResult(cardInput, resultInput, options);
  return {
    transactionHash: live.transactionHash,
    orderId: live.orderId,
    intentHash: live.validated.intentHash,
    intent: live.validated.intent,
    issuance: live.validated.issuance,
  };
}

function normalizeProof(input) {
  const outer = parseDocument(input, "Conviction proof");
  const candidate = outer.response && typeof outer.response === "object" ? outer.response : outer;
  return {
    outer: candidate,
    assurance: candidate.assurance,
    intent: candidate.intent || candidate.canonicalIntent,
    receiptProof: candidate.receiptProof,
    positionProof: candidate.positionProof,
    positionProofHash:
      candidate.positionProofHash ||
      candidate.hashes?.positionProofHash ||
      candidate.verifiedPositionProof?.positionProofHash,
    issuance: candidate.issuance,
    positionPassport: candidate.positionPassport,
    positionPassportHash: candidate.positionPassportHash,
  };
}

export function validateProof(cardInput, proofInput, options = {}) {
  const validated = validateCard(cardInput, {
    allowExpired: true,
    trustedIssuers: options.trustedIssuers,
    allowLegacyV3: options.allowLegacyV3 === true,
  });
  const normalized = normalizeProof(proofInput);
  if (normalized.outer.ok !== undefined) {
    fail(normalized.outer.ok === true, "invalid_proof", "Proof response must report ok=true");
  }
  const intent = record(normalized.intent, "proof.intent");
  const receipt = record(normalized.receiptProof, "proof.receiptProof");
  const position = record(normalized.positionProof, "proof.positionProof");
  const positionHash = lower(normalized.positionProofHash);
  const signedV4 = validated.intent.version === "conviction-intent-v4";
  fail(sha256(intent) === validated.intentHash, "proof_intent_mismatch", "Proof intent differs from the position card");
  fail(
    position.version === (signedV4 ? "conviction-position-proof-v3" : "conviction-position-proof-v2"),
    "invalid_proof",
    "Unsupported position-proof version",
  );
  fail(
    receipt.version === (signedV4 ? "conviction-receipt-v4" : "conviction-receipt-v3"),
    "invalid_proof",
    "Unsupported receipt-proof version",
  );
  fail(HASH_RE.test(positionHash) && sha256(position) === positionHash, "proof_hash_mismatch", "Position-proof hash is invalid");
  fail(position.receiptHash === sha256(receipt), "proof_hash_mismatch", "Receipt-proof hash is invalid");

  const transactionHash = lower(position.transactionHash);
  const orderId = lower(position.orderId);
  fail(HASH_RE.test(transactionHash) && HASH_RE.test(orderId), "invalid_proof", "Proof transaction or order ID is invalid");
  fail(
    position.intentHash === validated.intentHash &&
      lower(position.marketConditionId) === lower(validated.intent.market.conditionId) &&
      position.outcome === validated.outcome &&
      String(position.outcomeTokenId) === validated.tokenId &&
      lower(position.wallet) === validated.wallet,
    "proof_card_mismatch",
    "Position proof does not identify the card's market, outcome, token, and wallet",
  );
  fail(
    Number(receipt.chainId) === POLYGON_CHAIN_ID &&
      lower(receipt.exchange) === CONTRACTS.standardExchangeV2 &&
      lower(receipt.transactionHash) === transactionHash &&
      lower(receipt.orderId) === orderId &&
      receipt.outcome === validated.outcome &&
      String(receipt.outcomeTokenId) === validated.tokenId &&
      lower(receipt.wallet) === validated.wallet &&
      receipt.blockNumber === position.blockNumber,
    "proof_receipt_mismatch",
    "Receipt proof does not match the position proof",
  );
  if (signedV4) {
    fail(
      normalized.assurance === "issuer-signed" && position.checks?.marketConditionTokensMatched === true,
      "proof_assurance_mismatch",
      "Signed proof lacks issuer assurance or CTF market-token binding",
    );
    fail(
      HASH_RE.test(receipt.blockHash || "") &&
        lower(receipt.blockHash) === lower(position.blockHash) &&
        receipt.settledAt === position.settledAt,
      "proof_receipt_mismatch",
      "Signed proof settlement block or timestamp disagrees",
    );
    const issuanceResult = verifyIntentIssuance({
      intent: validated.intent,
      intentHash: validated.intentHash,
      issuance: normalized.issuance,
      trustedIssuers: issuerRegistry(options.trustedIssuers),
      settledAt: receipt.settledAt,
    });
    fail(
      sha256(normalized.issuance) === sha256(validated.issuance) &&
        position.issuanceKeyId === issuanceResult.keyId &&
        position.issuanceFingerprint === issuanceResult.fingerprint &&
        position.verificationMode === "signed-intent-window" &&
        position.temporalBinding === true,
      "proof_issuance_mismatch",
      "Proof issuance or temporal binding differs from the signed card",
    );
  } else {
    fail(
      position.verificationMode === undefined || position.verificationMode === "retrospective",
      "invalid_proof",
      "Legacy proof verification mode is invalid",
    );
  }

  const proofBounds = record(position.bounds, "positionProof.bounds");
  fail(
    proofBounds.requestedBudgetRaw === validated.bounds.requestedBudgetRaw &&
      proofBounds.maximumOrderPrincipalRaw === validated.bounds.maximumOrderPrincipalRaw &&
      proofBounds.maximumFeeRaw === validated.bounds.maximumFeeRaw &&
      proofBounds.maximumTotalDebitRaw === validated.bounds.maximumTotalDebitRaw &&
      proofBounds.maxPrice === validated.bounds.maxPrice,
    "proof_bounds_mismatch",
    "Proof bounds differ from the position card",
  );

  const principalRaw = rawInteger(position.fill?.actualOrderPrincipalRaw, "actualOrderPrincipalRaw", { positive: true });
  const feeRaw = rawInteger(position.fill?.actualFeeRaw, "actualFeeRaw");
  const totalDebitRaw = rawInteger(position.fill?.actualTotalDebitRaw, "actualTotalDebitRaw", { positive: true });
  const sharesRaw = rawInteger(position.fill?.actualSharesRaw, "actualSharesRaw", { positive: true });
  const maximumPrincipalRaw = BigInt(validated.bounds.maximumOrderPrincipalRaw);
  const maximumFeeRaw = BigInt(validated.bounds.maximumFeeRaw);
  const maximumTotalDebitRaw = BigInt(validated.bounds.maximumTotalDebitRaw);
  const maxPriceRaw = parseDecimal(validated.bounds.maxPrice, 6, "maxPrice");
  const actualFeeCeilingRaw = ceilDiv(principalRaw * BigInt(validated.bounds.feeBps), BPS_SCALE);
  const averagePriceRaw = ceilDiv(principalRaw * PRICE_SCALE, sharesRaw);
  const allInAveragePriceRaw = ceilDiv(totalDebitRaw * PRICE_SCALE, sharesRaw);
  fail(
    totalDebitRaw === principalRaw + feeRaw &&
      principalRaw <= maximumPrincipalRaw &&
      feeRaw <= maximumFeeRaw &&
      feeRaw <= actualFeeCeilingRaw &&
      totalDebitRaw <= maximumTotalDebitRaw &&
      averagePriceRaw <= maxPriceRaw,
    "proof_bounds_mismatch",
    "Verified fill exceeds the card bounds",
  );
  fail(
    position.fill.actualSpendRaw === principalRaw.toString() &&
      position.fill.averagePriceCeiling === formatDecimal(averagePriceRaw, 6) &&
      position.fill.allInAveragePriceCeiling === formatDecimal(allInAveragePriceRaw, 6),
    "invalid_proof",
    "Position-proof formatted fill values disagree",
  );
  fail(
    String(receipt.principalRaw) === principalRaw.toString() &&
      String(receipt.feeRaw) === feeRaw.toString() &&
      String(receipt.totalDebitRaw) === totalDebitRaw.toString() &&
      String(receipt.sharesRaw) === sharesRaw.toString(),
    "proof_receipt_mismatch",
    "Receipt and position fill amounts disagree",
  );
  exactChecks(receipt.checks, [
    "transactionSucceeded",
    "standardExchangeV2",
    "exactCollateralTransfer",
    "exactOutcomeTransfer",
    "exactVenueFee",
    "exactOrderFill",
    ...(signedV4 ? ["settlementBlockMatched"] : []),
  ], "receiptProof.checks");
  exactChecks(position.checks, [
    "canonicalIntentHash",
    "selectedOutcomeToken",
    "orderPrincipalWithinMaximum",
    "venueFeeWithinMaximum",
    "totalDebitWithinMaximum",
    "averagePriceWithinMaximum",
    "receiptSettlementMatched",
    ...(signedV4
      ? [
          "trustedIssuerSignature",
          "settlementInsideSignedWindow",
          "settlementBlockMatched",
          "marketConditionTokensMatched",
        ]
      : []),
  ], "positionProof.checks");

  let positionPassportHash;
  if (signedV4) {
    const passport = record(normalized.positionPassport, "proof.positionPassport");
    positionPassportHash = lower(normalized.positionPassportHash);
    fail(
      passport.version === "conviction-position-passport-v1" &&
        passport.status === "VERIFIED" &&
        HASH_RE.test(positionPassportHash) &&
        sha256(passport) === positionPassportHash &&
        sha256(passport.issuance) === sha256(normalized.issuance) &&
        sha256(passport.intent) === validated.intentHash &&
        sha256(passport.receiptProof) === sha256(receipt) &&
        sha256(passport.positionProof) === positionHash,
      "passport_mismatch",
      "Position passport does not bind the signed card and verified proof",
    );
  }

  return {
    ok: true,
    intentHash: validated.intentHash,
    transactionHash,
    orderId,
    positionProofHash: positionHash,
    settledAt: position.settledAt,
    ...(signedV4 ? { positionPassportHash } : {}),
  };
}

function usage() {
  return [
    "Usage:",
    "  conviction-card.mjs validate-card <card.json> --issuer-registry <issuers.json> [--now <ISO-or-ms>]",
    "  conviction-card.mjs validate-preview <card.json> <dry-run.json> --issuer-registry <issuers.json> [--now <ISO-or-ms>]",
    "  conviction-card.mjs receipt-body <card.json> <live-result.json> --issuer-registry <issuers.json>",
    "  conviction-card.mjs validate-proof <card.json> <proof.json> --issuer-registry <issuers.json>",
    "Use '-' for one JSON input read from stdin.",
  ].join("\n");
}

function readJsonArgument(path, stdinState) {
  fail(path, "missing_argument", "JSON file path is required");
  if (path !== "-") return readFileSync(path, "utf8");
  fail(!stdinState.used, "invalid_argument", "Only one input may be read from stdin");
  stdinState.used = true;
  return readFileSync(0, "utf8");
}

function cliOptions(args) {
  const remaining = [...args];
  const take = (name) => {
    const index = remaining.indexOf(name);
    if (index === -1) return undefined;
    fail(index + 1 < remaining.length, "missing_argument", `${name} requires a value`);
    const [value] = remaining.splice(index + 1, 1);
    remaining.splice(index, 1);
    return value;
  };
  return {
    args: remaining,
    now: take("--now"),
    issuerRegistryPath: take("--issuer-registry"),
  };
}

export function runCli(argv = process.argv.slice(2)) {
  const [command, ...rawArgs] = argv;
  fail(command, "missing_command", usage());
  const { args, now, issuerRegistryPath } = cliOptions(rawArgs);
  const stdinState = { used: false };
  fail(issuerRegistryPath, "missing_trusted_issuer", "--issuer-registry is required");
  const trustedIssuers = parseDocument(
    readJsonArgument(issuerRegistryPath, stdinState),
    "trusted issuer registry",
  );
  let output;
  if (command === "validate-card") {
    fail(args.length === 1, "invalid_argument", usage());
    const result = validateCard(readJsonArgument(args[0], stdinState), { now, trustedIssuers });
    output = {
      ok: true,
      intentHash: result.intentHash,
      wallet: result.wallet,
      outcome: result.outcome,
      tokenId: result.tokenId,
      expiresAt: result.expiresAt,
      bounds: result.bounds,
    };
  } else if (command === "validate-preview") {
    fail(args.length === 2, "invalid_argument", usage());
    output = validatePluginPreview(
      readJsonArgument(args[0], stdinState),
      readJsonArgument(args[1], stdinState),
      { now, trustedIssuers },
    );
  } else if (command === "receipt-body") {
    fail(args.length === 2 && now === undefined, "invalid_argument", usage());
    output = buildReceiptRequest(
      readJsonArgument(args[0], stdinState),
      readJsonArgument(args[1], stdinState),
      { trustedIssuers },
    );
  } else if (command === "validate-proof") {
    fail(args.length === 2 && now === undefined, "invalid_argument", usage());
    output = validateProof(
      readJsonArgument(args[0], stdinState),
      readJsonArgument(args[1], stdinState),
      { trustedIssuers },
    );
  } else {
    throw new CardValidationError("unknown_command", usage());
  }
  return output;
}

function isMain() {
  return process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
}

if (isMain()) {
  try {
    process.stdout.write(`${JSON.stringify(runCli(), null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${JSON.stringify({
      ok: false,
      error: {
        code: error?.code || "validation_failed",
        message: error?.message || "Validation failed",
      },
    })}\n`);
    process.exitCode = 1;
  }
}
