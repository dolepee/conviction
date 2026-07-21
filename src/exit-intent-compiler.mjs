import { sha256 } from "./canonical.mjs";
import { CONTRACTS, POLYGON_CHAIN_ID } from "./constants.mjs";
import { formatDecimal, parseDecimal } from "./decimal.mjs";
import { invariant } from "./errors.mjs";

const ADDRESS_RE = /^0x[0-9a-f]{40}$/i;
const CONDITION_ID_RE = /^0x[0-9a-f]{64}$/i;
const HASH_RE = /^0x[0-9a-f]{64}$/i;
const TOKEN_ID_RE = /^\d+$/;
const PRICE_SCALE = 1_000_000n;
const SHARE_SCALE = 1_000_000n;
const COLLATERAL_SCALE = 1_000_000n;
const BPS_SCALE = 10_000n;
const V2_COLLATERAL_STEP_RAW = 10_000n;

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

function bestBid(bids) {
  return bids.reduce((best, level) =>
    parseDecimal(level.price, 6, "bid price") > parseDecimal(best.price, 6, "bid price")
      ? level
      : best,
  );
}

function bestAsk(asks) {
  if (!Array.isArray(asks) || asks.length === 0) return null;
  return asks.reduce((best, level) =>
    parseDecimal(level.price, 6, "ask price") < parseDecimal(best.price, 6, "ask price")
      ? level
      : best,
  );
}

function assertMarketSnapshot(market, outcome, now, maxSnapshotAgeMs) {
  invariant(market?.source === "polymarket", "unsupported_market", "Only Polymarket is supported");
  invariant(market.clobVersion === "V2", "unsupported_clob_version", "Only Polymarket CLOB V2 is supported");
  invariant(CONDITION_ID_RE.test(market.conditionId), "invalid_market", "Invalid condition ID");
  invariant(TOKEN_ID_RE.test(market.outcomeTokenId), "invalid_market", "Invalid outcome token ID");
  invariant(market.selectedOutcome === outcome, "outcome_snapshot_mismatch", "Market snapshot is for a different outcome");
  invariant(market.active, "inactive_market", "Market is not active");
  invariant(!market.closed, "closed_market", "Market is closed");
  invariant(market.acceptingOrders, "orders_disabled", "Market is not accepting orders");
  invariant(!market.negRisk, "unsupported_neg_risk", "Neg-risk markets are not supported");
  invariant(Array.isArray(market.bids) && market.bids.length > 0, "empty_orderbook", `${outcome} order book has no bids`);
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
  invariant(
    String(source.wallet || "").toLowerCase() === wallet,
    "source_wallet_mismatch",
    "Source proof belongs to another wallet",
  );
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
  invariant(BigInt(source.actualSharesRaw) >= sharesRaw, "source_shares_exceeded", "CLOSE shares exceed the source verified fill");
}

function disclosuresFor({ shares, minimumGrossProceeds, feeAtPriceFloor, maximumFee, minimumNetProceeds }) {
  return [
    "The position holder's own Polygon wallet signs the sell order and receives the proceeds.",
    `FOK closes exactly ${shares} shares at or above minPrice, or places no fill at all.`,
    `The signed limit price preventively enforces at least ${minimumGrossProceeds} pUSD gross proceeds. At the currently observed venue fee, the fee verification threshold is ${feeAtPriceFloor} pUSD at the floor, the absolute verification ceiling is ${maximumFee} pUSD, and the post-settlement net verification floor is ${minimumNetProceeds} pUSD.`,
    "Polymarket V2 does not sign the operator-applied fee. Fee and net thresholds are checked after irreversible settlement and can detect an unexpected fee, but cannot prevent or reverse it.",
    "The signed card binds the market, YES/NO token, wallet, exact shares, minimum price, and FOK order type.",
    "The server verifies the wallet's on-chain outcome-token balance before signing; the buyer runtime repeats that check before execution.",
    "A successful close is accepted only after Polygon logs independently prove the selected token left the wallet and bounded pUSD proceeds returned to it.",
  ];
}

function compileBoundedClose(
  request,
  market,
  position,
  {
    now = Date.now(),
    maxSnapshotAgeMs = 30_000,
    quoteTtlMs = maxSnapshotAgeMs,
  } = {},
) {
  invariant(
    Number.isInteger(quoteTtlMs) && quoteTtlMs >= maxSnapshotAgeMs,
    "invalid_quote_ttl",
    "Quote TTL must be an integer at least as long as the maximum snapshot age",
  );
  const action = String(request.action || "close").trim().toUpperCase();
  invariant(action === "CLOSE", "unsupported_exit_action", "action must be CLOSE");
  const outcome = normalizeOutcome(request.outcome);
  const wallet = String(request.wallet || "").toLowerCase();
  invariant(ADDRESS_RE.test(wallet), "invalid_wallet", "wallet must be a valid EVM address");
  assertMarketSnapshot(market, outcome, now, maxSnapshotAgeMs);
  const tokenId = String(market.outcomeTokenId);
  assertPositionSnapshot(position, { wallet, tokenId, now, maxSnapshotAgeMs });

  const sharesRaw = parseDecimal(request.shares, 6, "shares");
  const minPriceRaw = parseDecimal(request.minPrice, 6, "minPrice");
  const tickRaw = parseDecimal(market.tickSize, 6, "tickSize");
  invariant(sharesRaw > 0n, "invalid_shares", "shares must be positive");
  invariant(sharesRaw % SHARE_SCALE === 0n, "non_deterministic_shares", "CLOSE currently requires a whole-share amount");
  invariant(minPriceRaw > 0n && minPriceRaw < PRICE_SCALE, "invalid_price", "minPrice must be between 0 and 1");
  invariant(tickRaw > 0n && minPriceRaw % tickRaw === 0n, "price_tick_mismatch", "minPrice does not align with the market tick size");
  const availableSharesRaw = BigInt(position.balanceRaw);
  invariant(availableSharesRaw >= sharesRaw, "insufficient_position", "Wallet does not hold the requested outcome shares", {
    requestedShares: formatDecimal(sharesRaw, 6),
    availableShares: formatDecimal(availableSharesRaw, 6),
  });
  assertVerifiedSource(request.source, { wallet, market, outcome, tokenId, sharesRaw });

  const grossNumerator = sharesRaw * minPriceRaw;
  invariant(grossNumerator % SHARE_SCALE === 0n, "non_deterministic_proceeds", "shares and minPrice do not encode an exact pUSD amount");
  const minimumGrossRaw = grossNumerator / SHARE_SCALE;
  invariant(minimumGrossRaw >= COLLATERAL_SCALE, "marketable_order_below_minimum", "CLOSE gross proceeds at the price floor must be at least 1 pUSD");
  invariant(
    minimumGrossRaw % V2_COLLATERAL_STEP_RAW === 0n,
    "non_deterministic_proceeds",
    "CLOSE minimum proceeds must be cent-aligned for Polymarket V2",
  );

  const feeBps = Number(market.feeBps);
  invariant(
    Number.isInteger(feeBps) && feeBps >= 0 && feeBps <= Number(BPS_SCALE),
    "invalid_market_fee",
    "Market fee rate is invalid",
  );
  const feeAtPriceFloorRaw = ceilDiv(minimumGrossRaw * BigInt(feeBps), BPS_SCALE);
  const maximumFeeRaw = ceilDiv(sharesRaw * BigInt(feeBps), BPS_SCALE);
  invariant(feeAtPriceFloorRaw <= minimumGrossRaw, "invalid_market_fee", "Market fee can exceed close proceeds");
  const minimumNetRaw = minimumGrossRaw - feeAtPriceFloorRaw;

  const bid = bestBid(market.bids);
  const bestBidRaw = parseDecimal(bid.price, 6, "bestBid");
  invariant(bestBidRaw >= minPriceRaw, "floor_above_best_bid", "minPrice is above the current best bid", {
    bestBid: formatDecimal(bestBidRaw, 6),
  });
  const depthRaw = market.bids.reduce((total, level) => {
    const priceRaw = parseDecimal(level.price, 6, "bid price");
    if (priceRaw < minPriceRaw) return total;
    return total + parseDecimal(level.size, 6, "bid size");
  }, 0n);
  invariant(depthRaw >= sharesRaw, "insufficient_bounded_liquidity", "Current bids at or above minPrice cannot fill the requested close", {
    requestedShares: formatDecimal(sharesRaw, 6),
    availableShares: formatDecimal(depthRaw, 6),
  });

  const ask = bestAsk(market.asks);
  const bestAskRaw = ask ? parseDecimal(ask.price, 6, "bestAsk") : null;
  invariant(bestAskRaw === null || bestAskRaw >= bestBidRaw, "invalid_orderbook", "Best ask is below best bid");
  const expiresAt = new Date(Date.parse(market.capturedAt) + quoteTtlMs).toISOString();
  const shares = formatDecimal(sharesRaw, 6);
  const minPrice = formatDecimal(minPriceRaw, 6);
  const minimumGrossProceeds = formatDecimal(minimumGrossRaw, 6);
  const feeAtPriceFloor = formatDecimal(feeAtPriceFloorRaw, 6);
  const maximumFee = formatDecimal(maximumFeeRaw, 6);
  const minimumNetProceeds = formatDecimal(minimumNetRaw, 6);
  const remainingSharesRaw = availableSharesRaw - sharesRaw;

  return {
    action,
    outcome,
    wallet,
    shares,
    sharesRaw,
    minPrice,
    minimumGrossProceeds,
    minimumGrossRaw,
    feeAtPriceFloor,
    feeAtPriceFloorRaw,
    maximumFee,
    maximumFeeRaw,
    minimumNetProceeds,
    minimumNetRaw,
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
      orderType: "FOK",
      shares,
      sharesRaw: sharesRaw.toString(),
      minPrice,
      minimumGrossProceeds,
      minimumGrossProceedsRaw: minimumGrossRaw.toString(),
      feeBps,
      feeRateBpsMax: feeBps,
      feeAtPriceFloor,
      feeAtPriceFloorRaw: feeAtPriceFloorRaw.toString(),
      maximumFee,
      maximumFeeRaw: maximumFeeRaw.toString(),
      minimumNetProceeds,
      minimumNetProceedsRaw: minimumNetRaw.toString(),
      feeSource: "polymarket_clob_maker_base_fee",
      feeReserveMethod: "floor=ceil(minimumGrossProceeds*feeBps/10000);absolute=ceil(shares*feeBps/10000)",
      feeEnforcement: "post-settlement-verification-only",
      proceedsPrecision: "v2-cent-aligned-whole-shares",
    },
    position: {
      wallet,
      outcomeTokenId: tokenId,
      availableShares: formatDecimal(availableSharesRaw, 6),
      availableSharesRaw: availableSharesRaw.toString(),
      approvedForExchange: true,
      requestedCloseShares: shares,
      requestedCloseSharesRaw: sharesRaw.toString(),
      remainingSharesAfterFullClose: formatDecimal(remainingSharesRaw, 6),
      remainingSharesAfterFullCloseRaw: remainingSharesRaw.toString(),
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
      bestBid: formatDecimal(bestBidRaw, 6),
      bestAsk: bestAskRaw === null ? null : formatDecimal(bestAskRaw, 6),
      boundedBidDepth: formatDecimal(depthRaw, 6),
      positionCapturedAt: position.capturedAt,
      positionBlockNumber: String(position.blockNumber).toLowerCase(),
      positionBlockHash: String(position.blockHash).toLowerCase(),
    },
    proceeds: {
      minimumGrossProceeds,
      feeAtPriceFloor,
      maximumFee,
      minimumNetProceeds,
      grossProceedsPreventivelyEnforced: true,
      feeAndNetPreventivelyEnforced: false,
      feeAndNetEnforcement: "post-settlement-verification-only",
      exactSharesRequired: true,
      partialFillAllowed: false,
    },
  };
}

export function compileClosePreview(request, market, position, options = {}) {
  const bounded = compileBoundedClose(request, market, position, options);
  return {
    ok: true,
    preview: {
      version: "conviction-close-preview-v1",
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

export function compileCloseIntent(request, market, position, options = {}) {
  const rationale = String(request.rationale || "").trim();
  invariant(
    rationale.length === 0 || (rationale.length >= 20 && rationale.length <= 500),
    "invalid_rationale",
    "rationale must be empty or 20 to 500 characters",
  );
  const bounded = compileBoundedClose(request, market, position, options);
  const intent = {
    version: "conviction-exit-intent-v1",
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
  };
  const intentHash = sha256(intent);
  return {
    ok: true,
    intentHash,
    intent,
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
        bounded.minPrice,
        "--order-type",
        "FOK",
      ],
      requiresUserConfirmation: true,
      nonCustodial: true,
      requiresSufficientPosition: true,
      authorizationScope: "single-bounded-close",
      exactAuthorizedShares: bounded.shares,
      minimumSignedGrossProceeds: bounded.minimumGrossProceeds,
      postSettlementNetVerificationFloor: bounded.minimumNetProceeds,
      feeAndNetPreventivelyEnforced: false,
      expiresAt: bounded.expiresAt,
    },
    disclosures: disclosuresFor(bounded),
  };
}
