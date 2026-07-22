import { sha256 } from "./canonical.mjs";
import { EXECUTOR_RELEASE, EXECUTOR_RELEASE_HASH, executorNextStep } from "./executor-discovery.mjs";
import { CONTRACTS, POLYGON_CHAIN_ID } from "./constants.mjs";
import { formatDecimal, parseDecimal } from "./decimal.mjs";
import { invariant } from "./errors.mjs";

const ADDRESS_RE = /^0x[0-9a-f]{40}$/i;
const CONDITION_ID_RE = /^0x[0-9a-f]{64}$/i;
const HASH_RE = /^0x[0-9a-f]{64}$/i;
const TOKEN_ID_RE = /^\d+$/;
const UTC_SECONDS_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.000)?Z$/;
const PRICE_SCALE = 1_000_000n;
const SHARE_SCALE = 1_000_000n;
const BPS_SCALE = 10_000n;
const V2_COLLATERAL_STEP_RAW = 10_000n;
const PLACEMENT_TTL_MS = 300_000;
const VENUE_EXPIRY_HEADROOM_SECONDS = 90n;

function ceilDiv(numerator, denominator) {
  return (numerator + denominator - 1n) / denominator;
}

function normalizeOutcome(value) {
  const outcome = String(value || "").trim().toUpperCase();
  invariant(
    outcome === "YES" || outcome === "NO",
    "unsupported_outcome",
    "outcome must be YES or NO",
  );
  return outcome;
}

function parseUtcSeconds(value, label) {
  const text = String(value || "");
  invariant(UTC_SECONDS_RE.test(text), "invalid_venue_expiry", `${label} must be a UTC ISO timestamp on a whole second`);
  const milliseconds = Date.parse(text);
  invariant(
    Number.isFinite(milliseconds) && milliseconds % 1_000 === 0,
    "invalid_venue_expiry",
    `${label} is invalid`,
  );
  return {
    milliseconds,
    iso: new Date(milliseconds).toISOString(),
    unix: BigInt(milliseconds / 1_000),
  };
}

function parseOptionalMarketEnd(value) {
  if (value === null || value === undefined || value === "") return null;
  const milliseconds = Date.parse(String(value));
  invariant(Number.isFinite(milliseconds), "invalid_market", "Market end date is invalid");
  return milliseconds;
}

function priceExtreme(levels, chooseHigher, label) {
  invariant(Array.isArray(levels), "invalid_orderbook", `${label} levels are invalid`);
  if (levels.length === 0) return null;
  return levels.reduce((selected, level) => {
    const value = parseDecimal(level?.price, 6, `${label} price`);
    invariant(value > 0n && value < PRICE_SCALE, "invalid_orderbook", `${label} price is outside (0, 1)`);
    if (!selected) return { level, value };
    if ((chooseHigher && value > selected.value) || (!chooseHigher && value < selected.value)) {
      return { level, value };
    }
    return selected;
  }, null);
}

function assertMarketSnapshot(market, outcome, now, maxSnapshotAgeMs) {
  invariant(market?.source === "polymarket", "unsupported_market", "Only Polymarket is supported");
  invariant(market.clobVersion === "V2", "unsupported_clob_version", "Only Polymarket CLOB V2 is supported");
  invariant(CONDITION_ID_RE.test(market.conditionId), "invalid_market", "Invalid condition ID");
  invariant(TOKEN_ID_RE.test(market.outcomeTokenId), "invalid_market", "Invalid outcome token ID");
  invariant(
    TOKEN_ID_RE.test(String(market.yesTokenId || "")) && TOKEN_ID_RE.test(String(market.noTokenId || "")),
    "invalid_market",
    "Invalid binary outcome token mapping",
  );
  invariant(String(market.yesTokenId) !== String(market.noTokenId), "invalid_market", "Binary outcome tokens must be distinct");
  invariant(market.selectedOutcome === outcome, "outcome_snapshot_mismatch", "Market snapshot is for a different outcome");
  const selectedTokenId = outcome === "YES" ? String(market.yesTokenId) : String(market.noTokenId);
  const counterTokenId = outcome === "YES" ? String(market.noTokenId) : String(market.yesTokenId);
  invariant(
    String(market.outcomeTokenId) === selectedTokenId && String(market.counterOutcomeTokenId) === counterTokenId,
    "outcome_token_mapping_mismatch",
    "Market snapshot token mapping does not match the selected outcome",
  );
  invariant(market.active, "inactive_market", "Market is not active");
  invariant(!market.closed, "closed_market", "Market is closed");
  invariant(market.acceptingOrders, "orders_disabled", "Market is not accepting orders");
  invariant(!market.negRisk, "unsupported_neg_risk", "Neg-risk markets are not supported");
  const capturedAt = Date.parse(market.capturedAt);
  invariant(Number.isFinite(capturedAt), "invalid_snapshot", "Market snapshot timestamp is invalid");
  const ageMs = now - capturedAt;
  invariant(ageMs >= 0 && ageMs <= maxSnapshotAgeMs, "stale_snapshot", "Market snapshot is stale", {
    ageMs,
    maxSnapshotAgeMs,
  });
}

function assertPositionSnapshot(position, { wallet, tokenId, now, maxSnapshotAgeMs }) {
  invariant(position?.chainId === POLYGON_CHAIN_ID, "wrong_position_chain", "Position snapshot is not from Polygon");
  invariant(String(position.wallet || "").toLowerCase() === wallet, "position_wallet_mismatch", "Position snapshot is for another wallet");
  invariant(String(position.outcomeTokenId || "") === tokenId, "position_token_mismatch", "Position snapshot is for another outcome token");
  invariant(TOKEN_ID_RE.test(String(position.balanceRaw || "")), "invalid_position_snapshot", "Position balance is invalid");
  invariant(position.approvedForExchange === true, "ctf_approval_missing", "Wallet has not approved the standard V2 exchange to transfer outcome shares");
  invariant(/^0x[0-9a-f]+$/i.test(String(position.blockNumber || "")), "invalid_position_snapshot", "Position block number is invalid");
  invariant(HASH_RE.test(String(position.blockHash || "")), "invalid_position_snapshot", "Position block hash is invalid");
  const capturedAt = Date.parse(position.capturedAt);
  invariant(Number.isFinite(capturedAt), "invalid_position_snapshot", "Position timestamp is invalid");
  const ageMs = now - capturedAt;
  invariant(ageMs >= 0 && ageMs <= maxSnapshotAgeMs, "stale_position_snapshot", "Position snapshot is stale", {
    ageMs,
    maxSnapshotAgeMs,
  });
}

function assertVerifiedSource(source, { wallet, market, outcome, tokenId, sharesRaw }) {
  invariant(source && typeof source === "object", "missing_source_proof", "A verified OPEN position proof is required");
  invariant(HASH_RE.test(String(source.intentHash || "")), "invalid_source_proof", "Source intent hash is invalid");
  invariant(HASH_RE.test(String(source.positionProofHash || "")), "invalid_source_proof", "Source position-proof hash is invalid");
  invariant(HASH_RE.test(String(source.transactionHash || "")), "invalid_source_proof", "Source settlement transaction is invalid");
  invariant(HASH_RE.test(String(source.orderId || "")), "invalid_source_proof", "Source order ID is invalid");
  invariant(String(source.wallet || "").toLowerCase() === wallet, "source_wallet_mismatch", "Source proof belongs to another wallet");
  invariant(
    String(source.marketConditionId || "").toLowerCase() === String(market.conditionId).toLowerCase(),
    "source_market_mismatch",
    "Source proof belongs to another market",
  );
  invariant(String(source.outcome || "").toUpperCase() === outcome, "source_outcome_mismatch", "Source proof is for another outcome");
  invariant(String(source.outcomeTokenId || "") === tokenId, "source_token_mismatch", "Source proof is for another outcome token");
  invariant(TOKEN_ID_RE.test(String(source.actualSharesRaw || "")), "invalid_source_proof", "Source filled shares are invalid");
  invariant(
    (source.verificationMode === "signed-intent-window" && source.intentVersion === "conviction-intent-v4") ||
      (source.verificationMode === "retrospective" && ["conviction-intent-v2", "conviction-intent-v3"].includes(source.intentVersion)),
    "invalid_source_proof",
    "Source proof verification mode and intent version disagree",
  );
  invariant(BigInt(source.actualSharesRaw) >= sharesRaw, "source_shares_exceeded", "TAKE_PROFIT shares exceed the source verified fill");
}

function disclosuresFor({ shares, targetPrice, venueExpiresAt, minimumGrossProceeds, feeAtTargetPrice, maximumFee, minimumNetProceeds }) {
  return [
    "The position holder's own Polygon wallet signs the resting sell order and receives any proceeds.",
    `GTD requests a post-only sale of exactly ${shares} shares at ${targetPrice} or better until ${venueExpiresAt}; partial fills are possible while the remainder rests.`,
    `At the target price the minimum gross proceeds are ${minimumGrossProceeds} pUSD. At the currently observed venue fee, the target-price fee threshold is ${feeAtTargetPrice} pUSD, the absolute verification ceiling is ${maximumFee} pUSD, and the corresponding net threshold is ${minimumNetProceeds} pUSD.`,
    "Polymarket V2 signs the token, side, shares, and price. GTD expiry and post-only are CLOB request controls, not fields in the V2 EIP-712 order struct.",
    "The authenticated resting-order record must be checked after placement. It is not an on-chain fill proof; any later fills require separate Polygon settlement verification.",
    "The server verifies the wallet's outcome-token balance and approval before signing; the buyer runtime must repeat balance, approval, and open-order reservation checks before placement.",
  ];
}

function compileBoundedTakeProfit(
  request,
  market,
  position,
  {
    now = Date.now(),
    maxSnapshotAgeMs = 30_000,
    quoteTtlMs = PLACEMENT_TTL_MS,
  } = {},
) {
  invariant(quoteTtlMs === PLACEMENT_TTL_MS, "invalid_quote_ttl", "TAKE_PROFIT placement cards require an exact five-minute TTL");
  const action = String(request.action || "take_profit").trim().toUpperCase();
  invariant(action === "TAKE_PROFIT", "unsupported_exit_action", "action must be TAKE_PROFIT");
  const outcome = normalizeOutcome(request.outcome);
  const wallet = String(request.wallet || "").toLowerCase();
  invariant(ADDRESS_RE.test(wallet), "invalid_wallet", "wallet must be a valid EVM address");
  assertMarketSnapshot(market, outcome, now, maxSnapshotAgeMs);
  const tokenId = String(market.outcomeTokenId);
  assertPositionSnapshot(position, { wallet, tokenId, now, maxSnapshotAgeMs });

  const sharesRaw = parseDecimal(request.shares, 6, "shares");
  const targetPriceRaw = parseDecimal(request.targetPrice, 6, "targetPrice");
  const tickRaw = parseDecimal(market.tickSize, 6, "tickSize");
  const minOrderSizeRaw = parseDecimal(market.minOrderSize, 6, "minOrderSize");
  invariant(sharesRaw > 0n, "invalid_shares", "shares must be positive");
  invariant(sharesRaw % SHARE_SCALE === 0n, "non_deterministic_shares", "TAKE_PROFIT currently requires a whole-share amount");
  invariant(minOrderSizeRaw > 0n && sharesRaw >= minOrderSizeRaw, "resting_order_below_minimum", "TAKE_PROFIT shares are below the market's resting-order minimum", {
    requestedShares: formatDecimal(sharesRaw, 6),
    minimumShares: formatDecimal(minOrderSizeRaw, 6),
  });
  invariant(targetPriceRaw > 0n && targetPriceRaw < PRICE_SCALE, "invalid_price", "targetPrice must be between 0 and 1");
  invariant(tickRaw > 0n && targetPriceRaw % tickRaw === 0n, "price_tick_mismatch", "targetPrice does not align with the market tick size");
  const availableSharesRaw = BigInt(position.balanceRaw);
  invariant(availableSharesRaw >= sharesRaw, "insufficient_position", "Wallet does not hold the requested TAKE_PROFIT shares", {
    requestedShares: formatDecimal(sharesRaw, 6),
    availableShares: formatDecimal(availableSharesRaw, 6),
  });
  assertVerifiedSource(request.source, { wallet, market, outcome, tokenId, sharesRaw });

  const bestBid = priceExtreme(market.bids, true, "bid");
  const bestAsk = priceExtreme(market.asks, false, "ask");
  if (bestBid && bestAsk) {
    invariant(bestAsk.value >= bestBid.value, "invalid_orderbook", "Best ask is below best bid");
  }
  invariant(
    bestBid === null || targetPriceRaw > bestBid.value,
    "take_profit_would_cross",
    "targetPrice must be above the current best bid so the post-only order rests",
    bestBid ? { bestBid: formatDecimal(bestBid.value, 6) } : undefined,
  );

  const grossNumerator = sharesRaw * targetPriceRaw;
  invariant(grossNumerator % SHARE_SCALE === 0n, "non_deterministic_proceeds", "shares and targetPrice do not encode an exact pUSD amount");
  const minimumGrossRaw = grossNumerator / SHARE_SCALE;
  invariant(
    minimumGrossRaw % V2_COLLATERAL_STEP_RAW === 0n,
    "non_deterministic_proceeds",
    "TAKE_PROFIT minimum proceeds must be cent-aligned for Polymarket V2",
  );

  const capturedAtMs = Date.parse(market.capturedAt);
  const placementExpiresAtMs = capturedAtMs + quoteTtlMs;
  const placementExpiresAtUnixCeil = (BigInt(placementExpiresAtMs) + 999n) / 1_000n;
  const venueExpiry = parseUtcSeconds(request.venueExpiresAt, "venueExpiresAt");
  invariant(
    venueExpiry.unix >= placementExpiresAtUnixCeil + VENUE_EXPIRY_HEADROOM_SECONDS,
    "venue_expiry_too_soon",
    "venueExpiresAt must remain at least 90 seconds beyond the full placement-card window",
  );
  const marketEndMs = parseOptionalMarketEnd(market.endDate);
  invariant(
    marketEndMs === null || venueExpiry.milliseconds <= marketEndMs,
    "venue_expiry_after_market",
    "venueExpiresAt cannot be later than the market end date",
  );

  const feeBps = Number(market.feeBps);
  invariant(
    Number.isInteger(feeBps) && feeBps >= 0 && feeBps <= Number(BPS_SCALE),
    "invalid_market_fee",
    "Market fee rate is invalid",
  );
  const feeAtTargetPriceRaw = ceilDiv(minimumGrossRaw * BigInt(feeBps), BPS_SCALE);
  const maximumFeeRaw = ceilDiv(sharesRaw * BigInt(feeBps), BPS_SCALE);
  invariant(feeAtTargetPriceRaw <= minimumGrossRaw, "invalid_market_fee", "Market fee can exceed take-profit proceeds");
  const minimumNetRaw = minimumGrossRaw - feeAtTargetPriceRaw;

  const shares = formatDecimal(sharesRaw, 6);
  const targetPrice = formatDecimal(targetPriceRaw, 6);
  const minimumGrossProceeds = formatDecimal(minimumGrossRaw, 6);
  const feeAtTargetPrice = formatDecimal(feeAtTargetPriceRaw, 6);
  const maximumFee = formatDecimal(maximumFeeRaw, 6);
  const minimumNetProceeds = formatDecimal(minimumNetRaw, 6);
  const remainingSharesRaw = availableSharesRaw - sharesRaw;
  const expiresAt = new Date(placementExpiresAtMs).toISOString();

  return {
    action,
    outcome,
    wallet,
    shares,
    sharesRaw,
    targetPrice,
    targetPriceRaw,
    minimumGrossProceeds,
    minimumGrossRaw,
    feeAtTargetPrice,
    feeAtTargetPriceRaw,
    maximumFee,
    maximumFeeRaw,
    minimumNetProceeds,
    minimumNetRaw,
    venueExpiresAt: venueExpiry.iso,
    venueExpiresAtUnix: venueExpiry.unix.toString(),
    expiresAt,
    market: {
      source: "polymarket",
      conditionId: market.conditionId.toLowerCase(),
      slug: market.slug,
      question: market.question,
      description: market.description,
      resolutionSource: market.resolutionSource,
      endDate: market.endDate,
      outcome,
      outcomeTokenId: tokenId,
      counterOutcomeTokenId: market.counterOutcomeTokenId,
      outcomes: {
        YES: { tokenId: market.yesTokenId },
        NO: { tokenId: market.noTokenId },
      },
      tickSize: formatDecimal(tickRaw, 6),
      minOrderSize: formatDecimal(minOrderSizeRaw, 6),
      negRisk: false,
      exchange: CONTRACTS.standardExchangeV2,
      collateral: CONTRACTS.pUsd,
      conditionalTokens: CONTRACTS.ctf,
    },
    order: {
      action,
      side: "SELL",
      outcome,
      outcomeTokenId: tokenId,
      orderType: "GTD",
      postOnly: true,
      shares,
      sharesRaw: sharesRaw.toString(),
      targetPrice,
      minimumGrossProceeds,
      minimumGrossProceedsRaw: minimumGrossRaw.toString(),
      feeBps,
      feeRateBpsMax: feeBps,
      feeAtTargetPrice,
      feeAtTargetPriceRaw: feeAtTargetPriceRaw.toString(),
      maximumFee,
      maximumFeeRaw: maximumFeeRaw.toString(),
      minimumNetProceeds,
      minimumNetProceedsRaw: minimumNetRaw.toString(),
      feeSource: "polymarket_clob_maker_base_fee",
      feeReserveMethod: "target=ceil(minimumGrossProceeds*feeBps/10000);absolute=ceil(shares*feeBps/10000)",
      feeEnforcement: "post-settlement-verification-only",
      proceedsPrecision: "v2-cent-aligned-whole-shares",
      venueExpiresAt: venueExpiry.iso,
      venueExpiresAtUnix: venueExpiry.unix.toString(),
    },
    position: {
      wallet,
      outcomeTokenId: tokenId,
      availableShares: formatDecimal(availableSharesRaw, 6),
      availableSharesRaw: availableSharesRaw.toString(),
      approvedForExchange: true,
      requestedTakeProfitShares: shares,
      requestedTakeProfitSharesRaw: sharesRaw.toString(),
      remainingSharesAfterFullFill: formatDecimal(remainingSharesRaw, 6),
      remainingSharesAfterFullFillRaw: remainingSharesRaw.toString(),
      observedAtBlock: String(position.blockNumber).toLowerCase(),
      observedAtBlockHash: String(position.blockHash).toLowerCase(),
      observedAt: position.capturedAt,
    },
    source: {
      intentHash: String(request.source.intentHash).toLowerCase(),
      positionProofHash: String(request.source.positionProofHash).toLowerCase(),
      transactionHash: String(request.source.transactionHash).toLowerCase(),
      orderId: String(request.source.orderId).toLowerCase(),
      wallet,
      marketConditionId: market.conditionId.toLowerCase(),
      outcome,
      outcomeTokenId: tokenId,
      actualSharesRaw: String(request.source.actualSharesRaw),
      intentVersion: request.source.intentVersion,
      verificationMode: request.source.verificationMode,
    },
    snapshot: {
      capturedAt: market.capturedAt,
      expiresAt,
      bestBid: bestBid === null ? null : formatDecimal(bestBid.value, 6),
      bestAsk: bestAsk === null ? null : formatDecimal(bestAsk.value, 6),
      tickSize: formatDecimal(tickRaw, 6),
      minOrderSize: formatDecimal(minOrderSizeRaw, 6),
      positionCapturedAt: position.capturedAt,
      positionBlockNumber: String(position.blockNumber).toLowerCase(),
      positionBlockHash: String(position.blockHash).toLowerCase(),
    },
    proceeds: {
      minimumGrossProceeds,
      feeAtTargetPrice,
      maximumFee,
      minimumNetProceeds,
      grossProceedsPreventivelyEnforced: true,
      feeAndNetPreventivelyEnforced: false,
      feeAndNetEnforcement: "post-settlement-verification-only",
      exactSharesOffered: true,
      partialFillAllowed: true,
      restingOrder: true,
      postOnlyRequested: true,
    },
  };
}

export function compileTakeProfitPreview(request, market, position, options = {}) {
  const bounded = compileBoundedTakeProfit(request, market, position, options);
  return {
    ok: true,
    preview: {
      version: "conviction-take-profit-preview-v1",
      chainId: POLYGON_CHAIN_ID,
      action: bounded.action,
      market: bounded.market,
      order: bounded.order,
      position: bounded.position,
      source: bounded.source,
      snapshot: bounded.snapshot,
      proceeds: bounded.proceeds,
      executable: false,
      requiresPayment: false,
    },
    disclosures: disclosuresFor(bounded),
  };
}

export function compileTakeProfitIntent(request, market, position, options = {}) {
  const rationale = String(request.rationale || "").trim();
  invariant(
    rationale.length === 0 || (rationale.length >= 20 && rationale.length <= 500),
    "invalid_rationale",
    "rationale must be empty or 20 to 500 characters",
  );
  const bounded = compileBoundedTakeProfit(request, market, position, options);
  const intent = {
    version: "conviction-take-profit-intent-v1",
    chainId: POLYGON_CHAIN_ID,
    action: bounded.action,
    market: bounded.market,
    order: bounded.order,
    seller: { wallet: bounded.wallet },
    rationale,
    position: bounded.position,
    source: bounded.source,
    snapshot: bounded.snapshot,
    proceeds: bounded.proceeds,
    executor: EXECUTOR_RELEASE,
  };
  const intentHash = sha256(intent);
  return {
    ok: true,
    intentHash,
    intent,
    executor: EXECUTOR_RELEASE,
    nextStep: executorNextStep("TAKE_PROFIT"),
    executionCard: {
      tool: "polymarket-plugin",
      action: "sell",
      argv: [
        "sell",
        "--market-id",
        bounded.market.conditionId,
        "--token-id",
        bounded.market.outcomeTokenId,
        "--outcome",
        bounded.outcome.toLowerCase(),
        "--shares",
        bounded.shares,
        "--price",
        bounded.targetPrice,
        "--order-type",
        "GTD",
        "--post-only",
        "--expires",
        bounded.venueExpiresAtUnix,
      ],
      requiresUserConfirmation: true,
      nonCustodial: true,
      requiresSufficientPosition: true,
      authorizationScope: "single-bounded-take-profit",
      executorReleaseHash: EXECUTOR_RELEASE_HASH,
      exactAuthorizedShares: bounded.shares,
      targetPrice: bounded.targetPrice,
      minimumSignedGrossProceeds: bounded.minimumGrossProceeds,
      postSettlementNetVerificationFloor: bounded.minimumNetProceeds,
      feeAndNetPreventivelyEnforced: false,
      postOnly: true,
      postOnlyRequested: true,
      partialFillAllowed: true,
      venueExpiresAt: bounded.venueExpiresAt,
      venueExpiresAtUnix: bounded.venueExpiresAtUnix,
      placementExpiresAt: bounded.expiresAt,
      expiresAt: bounded.expiresAt,
    },
    disclosures: disclosuresFor(bounded),
  };
}
