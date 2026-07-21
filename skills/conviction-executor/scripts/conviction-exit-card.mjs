import { sha256 } from "../../../src/canonical.mjs";
import { CONTRACTS, POLYGON_CHAIN_ID } from "../../../src/constants.mjs";
import { formatDecimal, parseDecimal } from "../../../src/decimal.mjs";
import {
  trustedIssuerRegistry,
  verifyIntentIssuance,
} from "../../../src/intent-issuer.mjs";

const ADDRESS_RE = /^0x[0-9a-f]{40}$/i;
const HASH_RE = /^0x[0-9a-f]{64}$/i;
const TOKEN_ID_RE = /^\d+$/;
const PRICE_SCALE = 1_000_000n;
const SHARE_SCALE = 1_000_000n;
const BPS_SCALE = 10_000n;
const MAX_CARD_TTL_MS = 300_000;

export class ExitCardValidationError extends Error {
  constructor(code, message, details = undefined) {
    super(message);
    this.name = "ExitCardValidationError";
    this.code = code;
    this.details = details;
  }
}

function fail(condition, code, message, details = undefined) {
  if (!condition) throw new ExitCardValidationError(code, message, details);
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
    throw new ExitCardValidationError("invalid_json", `${label} must contain valid JSON`);
  }
}

function lower(value) {
  return String(value || "").toLowerCase();
}

function raw(value, label, { positive = false } = {}) {
  const text = String(value ?? "");
  fail(TOKEN_ID_RE.test(text), "invalid_close_card", `${label} must be an unsigned integer`);
  const parsed = BigInt(text);
  if (positive) fail(parsed > 0n, "invalid_close_card", `${label} must be positive`);
  return parsed;
}

function timestamp(value, label) {
  const milliseconds = Date.parse(String(value || ""));
  fail(Number.isFinite(milliseconds), "invalid_expiry", `${label} must be an ISO timestamp`);
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

function sameDecimal(value, expectedRaw, label) {
  fail(parseDecimal(value, 6, label) === expectedRaw, "close_economics_mismatch", `${label} disagrees with the close card`);
}

function registry(value) {
  if (value instanceof Map) return value;
  const records = Array.isArray(value) ? value : value?.issuers;
  fail(Array.isArray(records), "missing_trusted_issuer", "A pinned trusted issuer registry is required");
  return trustedIssuerRegistry(records);
}

function unwrapPlugin(input, label) {
  const outer = parseDocument(input, label);
  const data = outer.data === undefined ? outer : record(outer.data, `${label}.data`);
  return { outer, data };
}

export function parseCloseCard(input) {
  const outer = parseDocument(input, "close card");
  const card = outer.response === undefined ? outer : record(outer.response, "close card.response");
  fail(card.intent && card.intentHash && card.executionCard, "invalid_close_card", "Document is not a Conviction close card");
  return card;
}

export function validateCloseCard(input, {
  now = undefined,
  allowExpired = false,
  trustedIssuers = undefined,
} = {}) {
  const card = parseCloseCard(input);
  fail(card.ok === true, "invalid_close_card", "Close card must report ok=true");
  const intent = record(card.intent, "intent");
  const market = record(intent.market, "intent.market");
  const order = record(intent.order, "intent.order");
  const seller = record(intent.seller, "intent.seller");
  const position = record(intent.position, "intent.position");
  const source = record(intent.source, "intent.source");
  const snapshot = record(intent.snapshot, "intent.snapshot");
  const proceeds = record(intent.proceeds, "intent.proceeds");
  const executionCard = record(card.executionCard, "executionCard");

  fail(intent.version === "conviction-exit-intent-v1", "invalid_close_card", "A Conviction exit intent v1 is required");
  fail(intent.action === "CLOSE", "invalid_close_card", "Exit intent action must be CLOSE");
  fail(Number(intent.chainId) === POLYGON_CHAIN_ID, "wrong_chain", "Close card is not for Polygon chain 137");
  fail(HASH_RE.test(card.intentHash || ""), "invalid_intent_hash", "Close intent hash is invalid");
  const intentHash = lower(card.intentHash);
  fail(sha256(intent) === intentHash, "intent_hash_mismatch", "Close intent hash does not match canonical JSON");

  fail(market.source === "polymarket", "invalid_venue", "Close venue must be Polymarket");
  fail(HASH_RE.test(market.conditionId || ""), "invalid_market", "Condition ID is invalid");
  fail(lower(market.exchange) === CONTRACTS.standardExchangeV2, "wrong_exchange", "Close card is not for standard CLOB V2");
  fail(lower(market.collateral) === CONTRACTS.pUsd, "wrong_collateral", "Close card does not use V2 pUSD");
  fail(lower(market.conditionalTokens) === CONTRACTS.ctf, "wrong_conditional_tokens", "Close card uses another outcome-token contract");
  fail(market.negRisk === false, "unsupported_neg_risk", "Neg-risk markets are not supported");

  fail(order.action === "CLOSE" && order.side === "SELL" && order.orderType === "FOK", "invalid_close_order", "Close must be an exact FOK SELL");
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
  const minimumGrossRaw = raw(order.minimumGrossProceedsRaw, "minimumGrossProceedsRaw", { positive: true });
  const feeAtPriceFloorRaw = raw(order.feeAtPriceFloorRaw, "feeAtPriceFloorRaw");
  const maximumFeeRaw = raw(order.maximumFeeRaw, "maximumFeeRaw");
  const minimumNetRaw = raw(order.minimumNetProceedsRaw, "minimumNetProceedsRaw");
  const minPriceRaw = parseDecimal(order.minPrice, 6, "minPrice");
  const feeBps = Number(order.feeBps);
  fail(sharesRaw % SHARE_SCALE === 0n, "close_economics_mismatch", "Close shares must be whole shares");
  fail(minPriceRaw > 0n && minPriceRaw < PRICE_SCALE, "invalid_price", "Minimum price is invalid");
  fail(sharesRaw * minPriceRaw === minimumGrossRaw * SHARE_SCALE, "close_economics_mismatch", "Shares, price, and gross proceeds disagree");
  fail(Number.isInteger(feeBps) && feeBps >= 0 && feeBps <= 10_000, "invalid_fee", "Fee rate is invalid");
  fail(order.feeRateBpsMax === feeBps, "close_economics_mismatch", "Fee-rate cap is inconsistent");
  const recomputedFloorFee = (minimumGrossRaw * BigInt(feeBps) + BPS_SCALE - 1n) / BPS_SCALE;
  const recomputedMaximumFee = (sharesRaw * BigInt(feeBps) + BPS_SCALE - 1n) / BPS_SCALE;
  fail(feeAtPriceFloorRaw === recomputedFloorFee, "close_economics_mismatch", "Fee at the price floor is inconsistent");
  fail(maximumFeeRaw === recomputedMaximumFee, "close_economics_mismatch", "Absolute maximum fee is inconsistent");
  fail(minimumNetRaw === minimumGrossRaw - feeAtPriceFloorRaw, "close_economics_mismatch", "Minimum net proceeds are inconsistent");
  fail(
      order.feeSource === "polymarket_clob_maker_base_fee" &&
      order.feeReserveMethod === "floor=ceil(minimumGrossProceeds*feeBps/10000);absolute=ceil(shares*feeBps/10000)" &&
      order.feeEnforcement === "post-settlement-verification-only" &&
      order.proceedsPrecision === "v2-cent-aligned-whole-shares",
    "close_economics_mismatch",
    "Close fee or precision policy is unsupported",
  );
  sameDecimal(order.shares, sharesRaw, "shares");
  sameDecimal(order.minimumGrossProceeds, minimumGrossRaw, "minimumGrossProceeds");
  sameDecimal(order.feeAtPriceFloor, feeAtPriceFloorRaw, "feeAtPriceFloor");
  sameDecimal(order.maximumFee, maximumFeeRaw, "maximumFee");
  sameDecimal(order.minimumNetProceeds, minimumNetRaw, "minimumNetProceeds");

  fail(position.wallet === wallet && position.outcomeTokenId === tokenId, "position_binding_mismatch", "Position snapshot is for another wallet or token");
  fail(position.approvedForExchange === true, "ctf_approval_missing", "Signed position snapshot has no V2 exchange approval");
  const availableSharesRaw = raw(position.availableSharesRaw, "availableSharesRaw", { positive: true });
  const requestedCloseSharesRaw = raw(position.requestedCloseSharesRaw, "requestedCloseSharesRaw", { positive: true });
  const remainingSharesRaw = raw(position.remainingSharesAfterFullCloseRaw, "remainingSharesAfterFullCloseRaw");
  fail(requestedCloseSharesRaw === sharesRaw && availableSharesRaw >= sharesRaw && remainingSharesRaw === availableSharesRaw - sharesRaw, "position_binding_mismatch", "Position quantities disagree with the close order");
  fail(HASH_RE.test(position.observedAtBlockHash || "") && /^0x[0-9a-f]+$/i.test(position.observedAtBlock || ""), "invalid_position_snapshot", "Position block binding is invalid");

  for (const field of ["intentHash", "positionProofHash", "transactionHash", "orderId"]) {
    fail(HASH_RE.test(source[field] || ""), "invalid_source_proof", `source.${field} is invalid`);
  }
  fail(
    source.wallet === wallet && source.marketConditionId === lower(market.conditionId) &&
      source.outcome === outcome && source.outcomeTokenId === tokenId,
    "source_binding_mismatch",
    "Source proof identity differs from the close order",
  );
  fail(raw(source.actualSharesRaw, "source.actualSharesRaw", { positive: true }) >= sharesRaw, "source_binding_mismatch", "Close exceeds the source verified fill");
  fail(
    (source.verificationMode === "signed-intent-window" && source.intentVersion === "conviction-intent-v4") ||
      (source.verificationMode === "retrospective" && ["conviction-intent-v2", "conviction-intent-v3"].includes(source.intentVersion)),
    "invalid_source_proof",
    "Source proof verification mode and intent version disagree",
  );

  const capturedAtMs = timestamp(snapshot.capturedAt, "snapshot.capturedAt");
  const expiresAtMs = timestamp(snapshot.expiresAt, "snapshot.expiresAt");
  fail(expiresAtMs - capturedAtMs === MAX_CARD_TTL_MS, "invalid_expiry", "Close card must have an exact five-minute placement window");
  fail(snapshot.positionCapturedAt === position.observedAt, "position_binding_mismatch", "Position timestamps disagree");
  fail(snapshot.positionBlockNumber === position.observedAtBlock && snapshot.positionBlockHash === position.observedAtBlockHash, "position_binding_mismatch", "Position blocks disagree");
  const bestBidRaw = parseDecimal(snapshot.bestBid, 6, "bestBid");
  const boundedBidDepthRaw = parseDecimal(snapshot.boundedBidDepth, 6, "boundedBidDepth");
  fail(bestBidRaw >= minPriceRaw, "invalid_price", "Minimum price is above the recorded best bid");
  fail(boundedBidDepthRaw >= sharesRaw, "insufficient_depth", "Recorded bid depth cannot fill the close");
  if (snapshot.bestAsk !== null && snapshot.bestAsk !== undefined) {
    fail(parseDecimal(snapshot.bestAsk, 6, "bestAsk") >= bestBidRaw, "invalid_orderbook", "Recorded best ask is below best bid");
  }
  sameDecimal(proceeds.minimumGrossProceeds, minimumGrossRaw, "proceeds.minimumGrossProceeds");
  sameDecimal(proceeds.feeAtPriceFloor, feeAtPriceFloorRaw, "proceeds.feeAtPriceFloor");
  sameDecimal(proceeds.maximumFee, maximumFeeRaw, "proceeds.maximumFee");
  sameDecimal(proceeds.minimumNetProceeds, minimumNetRaw, "proceeds.minimumNetProceeds");
  fail(
    proceeds.grossProceedsPreventivelyEnforced === true &&
      proceeds.feeAndNetPreventivelyEnforced === false &&
      proceeds.feeAndNetEnforcement === "post-settlement-verification-only" &&
      proceeds.exactSharesRequired === true && proceeds.partialFillAllowed === false,
    "close_economics_mismatch",
    "Close proceeds policy is inconsistent",
  );

  const expectedArgv = [
    "sell", "--market-id", lower(market.conditionId), "--token-id", tokenId,
    "--outcome", outcome.toLowerCase(), "--shares", order.shares,
    "--price", order.minPrice, "--order-type", "FOK",
  ];
  fail(JSON.stringify(executionCard.argv) === JSON.stringify(expectedArgv), "execution_card_mismatch", "Execution arguments differ from the signed close intent");
  fail(
    executionCard.tool === "polymarket-plugin" && executionCard.action === "sell" &&
      executionCard.requiresUserConfirmation === true && executionCard.nonCustodial === true &&
      executionCard.requiresSufficientPosition === true &&
      executionCard.authorizationScope === "single-bounded-close" &&
      executionCard.exactAuthorizedShares === order.shares &&
      executionCard.minimumSignedGrossProceeds === order.minimumGrossProceeds &&
      executionCard.postSettlementNetVerificationFloor === order.minimumNetProceeds &&
      executionCard.feeAndNetPreventivelyEnforced === false &&
      executionCard.expiresAt === snapshot.expiresAt,
    "execution_card_mismatch",
    "Execution card policy differs from the close intent",
  );

  const nowMs = currentTime(now);
  fail(allowExpired || nowMs < expiresAtMs, "expired_card", "Close card expired");
  fail(nowMs >= capturedAtMs, "invalid_time", "Close card snapshot is in the future");
  const trusted = registry(trustedIssuers);
  const issuance = verifyIntentIssuance({
    intent,
    intentHash,
    issuance: card.issuance,
    trustedIssuers: trusted,
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
      minPrice: order.minPrice,
      minimumGrossProceedsRaw: minimumGrossRaw.toString(),
      feeAtPriceFloorRaw: feeAtPriceFloorRaw.toString(),
      maximumFeeRaw: maximumFeeRaw.toString(),
      minimumNetProceedsRaw: minimumNetRaw.toString(),
      feeBps,
    },
    expiresAt: snapshot.expiresAt,
    issuanceVerification: issuance,
  };
}

function validatePluginFields(validated, data, { preview }) {
  const marketId = lower(validated.intent.market.conditionId);
  fail(lower(data.condition_id) === marketId, "plugin_mismatch", "Plugin condition ID differs from close card");
  if (preview) {
    fail(String(data.market_id || "") === marketId, "plugin_mismatch", "Dry-run market ID differs from close card");
  } else if (data.market_id !== undefined) {
    fail(String(data.market_id || "") === marketId, "plugin_mismatch", "Plugin market ID differs from close card");
  }
  fail(String(data.outcome || "").toUpperCase() === validated.outcome, "plugin_mismatch", "Plugin outcome differs from close card");
  fail(String(data.token_id || "") === validated.tokenId, "plugin_mismatch", "Plugin token differs from close card");
  fail(data.side === "SELL" && data.order_type === "FOK", "plugin_mismatch", "Plugin order must be a FOK SELL");
  sameDecimal(data.limit_price, parseDecimal(validated.bounds.minPrice, 6, "card min price"), "plugin limit price");
  if (data.limit_price_requested !== undefined) {
    sameDecimal(data.limit_price_requested, parseDecimal(validated.bounds.minPrice, 6, "card min price"), "plugin requested limit price");
  }
  if (data.price_adjusted !== undefined) {
    fail(data.price_adjusted === false, "plugin_mismatch", "Plugin cannot rewrite the signed CLOSE price");
  }
  sameDecimal(data.shares, BigInt(validated.bounds.sharesRaw), "plugin shares");
  if (preview || data.shares_requested !== undefined) {
    sameDecimal(data.shares_requested, BigInt(validated.bounds.sharesRaw), "plugin requested shares");
  }
  if (preview || data.fee_rate_bps !== undefined) {
    fail(Number(data.fee_rate_bps) === validated.bounds.feeBps, "plugin_mismatch", "Plugin fee rate differs from close card");
  }
  if (preview || data.post_only !== undefined) {
    fail(data.post_only === false, "plugin_mismatch", "CLOSE cannot become post-only");
  }
  if (preview || data.expires !== undefined) {
    fail(data.expires === null, "plugin_mismatch", "FOK CLOSE cannot become a resting expiring order");
  }
  if (preview || data.usdc_out !== undefined) {
    const outputRaw = parseDecimal(data.usdc_out, 6, "plugin pUSD proceeds");
    fail(outputRaw >= BigInt(validated.bounds.minimumGrossProceedsRaw), "plugin_mismatch", "Plugin proceeds are below the signed gross floor");
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
  if (data.neg_risk !== undefined) {
    fail(data.neg_risk === false, "plugin_mismatch", "Plugin resolved a neg-risk market");
  }
}

export function validateClosePluginPreview(cardInput, previewInput, options = {}) {
  const validated = validateCloseCard(cardInput, options);
  const { outer, data } = unwrapPlugin(previewInput, "Polymarket close dry run");
  fail(outer.ok === true && outer.dry_run === true, "not_dry_run", "Plugin output is not a successful dry run");
  fail(data.note === "dry-run: order not submitted", "not_dry_run", "Plugin did not confirm that no order was submitted");
  validatePluginFields(validated, data, { preview: true });
  return { ok: true, validated, preview: data };
}

export function validateCloseLiveResult(cardInput, resultInput, options = {}) {
  const validated = validateCloseCard(cardInput, {
    allowExpired: true,
    trustedIssuers: options.trustedIssuers,
  });
  const { outer, data } = unwrapPlugin(resultInput, "Polymarket close live result");
  fail(outer.ok === true && outer.dry_run !== true, "not_live_result", "Plugin output is not a successful live result");
  fail(!String(data.note || "").toLowerCase().includes("dry-run"), "not_live_result", "Dry-run output cannot become a close receipt request");
  validatePluginFields(validated, data, { preview: false });
  fail(String(data.status || "").toLowerCase() === "matched", "unsettled_close", "FOK CLOSE is not reported matched");
  const orderId = lower(data.order_id);
  fail(HASH_RE.test(orderId), "invalid_order_id", "Live CLOSE has no valid order ID");
  fail(Array.isArray(data.tx_hashes) && data.tx_hashes.length === 1, "ambiguous_settlement", "Exactly one CLOSE settlement transaction is required");
  const transactionHash = lower(data.tx_hashes[0]);
  fail(HASH_RE.test(transactionHash), "invalid_transaction_hash", "Live CLOSE has no valid settlement transaction");
  return { ok: true, validated, orderId, transactionHash, result: data };
}

export function buildCloseReceiptRequest(cardInput, resultInput, options = {}) {
  const live = validateCloseLiveResult(cardInput, resultInput, options);
  return {
    transactionHash: live.transactionHash,
    orderId: live.orderId,
    intentHash: live.validated.intentHash,
    intent: live.validated.intent,
    issuance: live.validated.issuance,
  };
}

function exactChecks(value, names, label) {
  const checks = record(value, label);
  fail(
    Object.keys(checks).length === names.length && names.every((name) => checks[name] === true),
    "invalid_close_proof",
    `${label} must contain exactly the required passing checks`,
  );
}

function normalizeCloseProof(input) {
  const outer = parseDocument(input, "Conviction close proof");
  const candidate = outer.response && typeof outer.response === "object" ? outer.response : outer;
  return {
    outer: candidate,
    intent: candidate.intent,
    issuance: candidate.issuance,
    receiptProof: candidate.receiptProof,
    closeProof: candidate.closeProof,
    closeProofHash: candidate.closeProofHash,
    closePassport: candidate.closePassport,
    closePassportHash: candidate.closePassportHash,
  };
}

export function validateCloseProof(cardInput, proofInput, options = {}) {
  const validated = validateCloseCard(cardInput, {
    allowExpired: true,
    trustedIssuers: options.trustedIssuers,
  });
  const normalized = normalizeCloseProof(proofInput);
  if (normalized.outer.ok !== undefined) {
    fail(normalized.outer.ok === true, "invalid_close_proof", "Close proof response must report ok=true");
  }
  const intent = record(normalized.intent, "proof.intent");
  const issuance = record(normalized.issuance, "proof.issuance");
  const receipt = record(normalized.receiptProof, "proof.receiptProof");
  const proof = record(normalized.closeProof, "proof.closeProof");
  const passport = record(normalized.closePassport, "proof.closePassport");
  const proofHash = lower(normalized.closeProofHash);
  const passportHash = lower(normalized.closePassportHash);
  const expectedReceipt = options.expectedReceiptRequest;
  fail(expectedReceipt && typeof expectedReceipt === "object", "missing_receipt_binding", "Exact live CLOSE receipt request is required");
  fail(
    lower(expectedReceipt.transactionHash) === lower(proof.transactionHash) &&
      lower(expectedReceipt.orderId) === lower(proof.orderId) &&
      lower(expectedReceipt.intentHash) === validated.intentHash &&
      sha256(expectedReceipt.intent) === validated.intentHash &&
      sha256(expectedReceipt.issuance) === sha256(validated.issuance),
    "live_result_mismatch",
    "Close proof differs from the exact live result and receipt request",
  );

  fail(sha256(intent) === validated.intentHash, "proof_intent_mismatch", "Close proof intent differs from the signed card");
  fail(sha256(issuance) === sha256(validated.issuance), "proof_issuance_mismatch", "Close proof issuance differs from the signed card");
  fail(receipt.version === "conviction-close-receipt-v1", "invalid_close_proof", "Unsupported close receipt version");
  fail(proof.version === "conviction-close-proof-v1", "invalid_close_proof", "Unsupported close proof version");
  fail(HASH_RE.test(proofHash) && sha256(proof) === proofHash, "proof_hash_mismatch", "Close proof hash is invalid");
  fail(proof.receiptHash === sha256(receipt), "proof_hash_mismatch", "Close receipt hash is invalid");

  const transactionHash = lower(proof.transactionHash);
  const orderId = lower(proof.orderId);
  fail(HASH_RE.test(transactionHash) && HASH_RE.test(orderId), "invalid_close_proof", "Close transaction or order ID is invalid");
  fail(
    proof.intentHash === validated.intentHash &&
      proof.sourceIntentHash === lower(validated.intent.source.intentHash) &&
      proof.sourcePositionProofHash === lower(validated.intent.source.positionProofHash) &&
      lower(proof.marketConditionId) === lower(validated.intent.market.conditionId) &&
      proof.outcome === validated.outcome &&
      String(proof.outcomeTokenId) === validated.tokenId &&
      lower(proof.wallet) === validated.wallet,
    "proof_card_mismatch",
    "Close proof does not identify the signed card and source position",
  );
  fail(
    Number(receipt.chainId) === POLYGON_CHAIN_ID &&
      lower(receipt.exchange) === CONTRACTS.standardExchangeV2 &&
      lower(receipt.transactionHash) === transactionHash &&
      lower(receipt.orderId) === orderId &&
      receipt.outcome === validated.outcome &&
      String(receipt.outcomeTokenId) === validated.tokenId &&
      lower(receipt.wallet) === validated.wallet &&
      receipt.blockNumber === proof.blockNumber,
    "proof_receipt_mismatch",
    "Close receipt does not match the close proof",
  );
  fail(HASH_RE.test(proof.blockHash || "") && Number.isInteger(proof.blockNumber), "invalid_close_proof", "Close settlement block binding is invalid");
  timestamp(proof.settledAt, "proof.settledAt");

  const proofBounds = record(proof.bounds, "closeProof.bounds");
  fail(
    proofBounds.exactSharesRaw === validated.bounds.sharesRaw &&
      proofBounds.minPrice === validated.bounds.minPrice &&
      proofBounds.minimumGrossProceedsRaw === validated.bounds.minimumGrossProceedsRaw &&
      proofBounds.feeRateBpsMax === validated.bounds.feeBps &&
      proofBounds.maximumFeeRaw === validated.bounds.maximumFeeRaw &&
      proofBounds.minimumNetProceedsRaw === validated.bounds.minimumNetProceedsRaw,
    "proof_bounds_mismatch",
    "Close proof bounds differ from the signed card",
  );

  const sharesRaw = raw(proof.fill?.actualSharesRaw, "actualSharesRaw", { positive: true });
  const grossRaw = raw(proof.fill?.actualGrossProceedsRaw, "actualGrossProceedsRaw", { positive: true });
  const feeRaw = raw(proof.fill?.actualFeeRaw, "actualFeeRaw");
  const netRaw = raw(proof.fill?.actualNetProceedsRaw, "actualNetProceedsRaw", { positive: true });
  const minimumGrossRaw = BigInt(validated.bounds.minimumGrossProceedsRaw);
  const maximumFeeRaw = BigInt(validated.bounds.maximumFeeRaw);
  const minimumNetRaw = BigInt(validated.bounds.minimumNetProceedsRaw);
  const minPriceRaw = parseDecimal(validated.bounds.minPrice, 6, "minimum price");
  const actualFeeCeilingRaw = (grossRaw * BigInt(validated.bounds.feeBps) + BPS_SCALE - 1n) / BPS_SCALE;
  const actualAveragePriceFloorRaw = (grossRaw * PRICE_SCALE) / sharesRaw;
  fail(
    sharesRaw === BigInt(validated.bounds.sharesRaw) &&
      grossRaw >= minimumGrossRaw &&
      grossRaw * SHARE_SCALE >= sharesRaw * minPriceRaw &&
      feeRaw <= maximumFeeRaw && feeRaw <= actualFeeCeilingRaw &&
      netRaw === grossRaw - feeRaw && netRaw >= minimumNetRaw,
    "proof_bounds_mismatch",
    "Verified close fill violates the signed shares, price, fee, or proceeds bounds",
  );
  fail(
    proof.fill.actualAveragePriceFloor === formatDecimal(actualAveragePriceFloorRaw, 6),
    "proof_bounds_mismatch",
    "Close proof average price display differs from the verified fill",
  );
  fail(
    String(receipt.sharesRaw) === sharesRaw.toString() &&
      String(receipt.grossProceedsRaw) === grossRaw.toString() &&
      String(receipt.feeRaw) === feeRaw.toString() &&
      String(receipt.netProceedsRaw) === netRaw.toString(),
    "proof_receipt_mismatch",
    "Close receipt amounts differ from the verified fill",
  );

  const issuanceResult = verifyIntentIssuance({
    intent: validated.intent,
    intentHash: validated.intentHash,
    issuance,
    trustedIssuers: registry(options.trustedIssuers),
    settledAt: proof.settledAt,
  });
  fail(
    proof.issuanceKeyId === issuanceResult.keyId && proof.issuanceFingerprint === issuanceResult.fingerprint,
    "proof_issuance_mismatch",
    "Close proof issuer binding differs from the signed card",
  );
  exactChecks(receipt.checks, [
    "transactionSucceeded", "standardExchangeV2", "exactOutcomeDebit",
    "exactCollateralCredit", "exactVenueFee", "exactSellOrderFill",
  ], "receiptProof.checks");
  exactChecks(proof.checks, [
    "canonicalExitIntentHash", "verifiedSourcePositionBound", "selectedOutcomeToken",
    "exactSharesClosed", "grossProceedsAboveMinimum", "sellPriceAboveMinimum",
    "venueFeeWithinMaximum", "netProceedsAboveMinimum", "receiptSettlementMatched",
    "trustedIssuerSignature", "settlementInsideSignedWindow", "settlementBlockMatched",
  ], "closeProof.checks");
  fail(
    passport.version === "conviction-close-passport-v1" && passport.status === "CLOSED" &&
      HASH_RE.test(passportHash) && sha256(passport) === passportHash &&
      sha256(passport.issuance) === sha256(issuance) &&
      sha256(passport.intent) === validated.intentHash &&
      sha256(passport.receiptProof) === sha256(receipt) &&
      sha256(passport.closeProof) === proofHash,
    "passport_mismatch",
    "Close passport does not bind the signed card and verified close proof",
  );

  return {
    ok: true,
    intentHash: validated.intentHash,
    transactionHash,
    orderId,
    closeProofHash: proofHash,
    closePassportHash: passportHash,
    blockNumber: proof.blockNumber,
    blockHash: lower(proof.blockHash),
    settledAt: proof.settledAt,
  };
}
