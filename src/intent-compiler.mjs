import { sha256 } from "./canonical.mjs";
import { EXECUTOR_RELEASE, EXECUTOR_RELEASE_HASH, executorNextStep } from "./executor-discovery.mjs";
import { CONTRACTS, POLYGON_CHAIN_ID } from "./constants.mjs";
import { formatDecimal, parseDecimal } from "./decimal.mjs";
import { finiteEoaOpenPreparation } from "./eoa-open-preparation.mjs";
import { invariant } from "./errors.mjs";

const ADDRESS_RE = /^0x[0-9a-f]{40}$/i;
const CONDITION_ID_RE = /^0x[0-9a-f]{64}$/i;
const TOKEN_ID_RE = /^\d+$/;
const PRICE_SCALE = 1_000_000n;
const COLLATERAL_SCALE = 1_000_000n;
const SHARE_SCALE = 1_000_000n;
const BPS_SCALE = 10_000n;
const MARKETABLE_BUY_MIN_PRINCIPAL_RAW = 1_000_000n;
const V2_PRINCIPAL_STEP_RAW = 10_000n;

function ceilDiv(numerator, denominator) {
  return (numerator + denominator - 1n) / denominator;
}

function gcd(a, b) {
  while (b !== 0n) {
    [a, b] = [b, a % b];
  }
  return a;
}

export function minimumMarketableBudget(maxPrice, feeBpsValue) {
  const priceRaw = parseDecimal(maxPrice, 6, "maxPrice");
  invariant(priceRaw > 0n && priceRaw < PRICE_SCALE, "invalid_price", "maxPrice must be between 0 and 1");
  const feeBps = Number(feeBpsValue);
  invariant(
    Number.isInteger(feeBps) && feeBps >= 0 && feeBps <= Number(BPS_SCALE),
    "invalid_market_fee",
    "Market fee rate is invalid",
  );
  const shareQuantum = V2_PRINCIPAL_STEP_RAW / gcd(priceRaw, V2_PRINCIPAL_STEP_RAW);
  const minimumUnalignedWholeShares = ceilDiv(MARKETABLE_BUY_MIN_PRINCIPAL_RAW, priceRaw);
  const minimumWholeShares = ceilDiv(minimumUnalignedWholeShares, shareQuantum) * shareQuantum;
  const minimumPrincipalRaw = minimumWholeShares * priceRaw;
  const minimumFeeRaw = ceilDiv(minimumPrincipalRaw * BigInt(feeBps), BPS_SCALE);
  const minimumTotalDebitRaw = minimumPrincipalRaw + minimumFeeRaw;
  return {
    minimumOrderPrincipal: formatDecimal(minimumPrincipalRaw, 6),
    maximumFeeAtMinimum: formatDecimal(minimumFeeRaw, 6),
    minimumTotalBudget: formatDecimal(minimumTotalDebitRaw, 6),
    minimumShares: minimumWholeShares.toString(),
    principalPrecision: "v2-cent-aligned-whole-shares",
  };
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

function assertSnapshot(market, outcome, now, maxSnapshotAgeMs) {
  invariant(market?.source === "polymarket", "unsupported_market", "Only Polymarket is supported");
  invariant(market.clobVersion === "V2", "unsupported_clob_version", "Only Polymarket CLOB V2 is supported");
  invariant(CONDITION_ID_RE.test(market.conditionId), "invalid_market", "Invalid condition ID");
  invariant(TOKEN_ID_RE.test(market.outcomeTokenId), "invalid_market", "Invalid outcome token ID");
  invariant(market.selectedOutcome === outcome, "outcome_snapshot_mismatch", "Market snapshot is for a different outcome");
  invariant(market.active, "inactive_market", "Market is not active");
  invariant(!market.closed, "closed_market", "Market is closed");
  invariant(market.acceptingOrders, "orders_disabled", "Market is not accepting orders");
  invariant(!market.negRisk, "unsupported_neg_risk", "Neg-risk markets are not supported in v1");
  invariant(Array.isArray(market.asks) && market.asks.length > 0, "empty_orderbook", `${outcome} order book has no asks`);
  const capturedAt = Date.parse(market.capturedAt);
  invariant(Number.isFinite(capturedAt), "invalid_snapshot", "Market snapshot timestamp is invalid");
  const ageMs = now - capturedAt;
  invariant(ageMs >= 0 && ageMs <= maxSnapshotAgeMs, "stale_snapshot", "Market snapshot is stale", {
    ageMs,
    maxSnapshotAgeMs,
  });
}

function bestAsk(asks) {
  return asks.reduce((best, level) =>
    parseDecimal(level.price, 6, "ask price") < parseDecimal(best.price, 6, "ask price")
      ? level
      : best,
  );
}

function bestBid(bids) {
  if (!Array.isArray(bids) || !bids.length) return null;
  return bids.reduce((best, level) =>
    parseDecimal(level.price, 6, "bid price") > parseDecimal(best.price, 6, "bid price")
      ? level
      : best,
  );
}

function compileBoundedOrder(
  request,
  market,
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
  const outcome = normalizeOutcome(request.outcome);
  assertSnapshot(market, outcome, now, maxSnapshotAgeMs);
  const requestedBudgetRaw = parseDecimal(request.spend, 6, "spend");
  const priceRaw = parseDecimal(request.maxPrice, 6, "maxPrice");
  const tickRaw = parseDecimal(market.tickSize, 6, "tickSize");
  invariant(requestedBudgetRaw >= COLLATERAL_SCALE, "amount_below_floor", "total spend budget must be at least 1 pUSD");
  invariant(priceRaw > 0n && priceRaw < PRICE_SCALE, "invalid_price", "maxPrice must be between 0 and 1");
  invariant(tickRaw > 0n && priceRaw % tickRaw === 0n, "price_tick_mismatch", "maxPrice does not align with the market tick size");

  const feeBps = Number(market.feeBps);
  invariant(
    Number.isInteger(feeBps) && feeBps >= 0 && feeBps <= Number(BPS_SCALE),
    "invalid_market_fee",
    "Market fee rate is invalid",
  );
  const feeBpsRaw = BigInt(feeBps);
  const maximumPrincipalBudgetRaw =
    (requestedBudgetRaw * BPS_SCALE) / (BPS_SCALE + feeBpsRaw);
  // The official V2 plugin requires signed BUY principal to have at most two
  // decimals. Its dry run omits the live-only cent adjustment, so compile only
  // whole-share quantities whose principal is already cent-aligned. This keeps
  // the signed live order identical to the reviewed execution card.
  const shareQuantum = V2_PRINCIPAL_STEP_RAW / gcd(priceRaw, V2_PRINCIPAL_STEP_RAW);
  const maximumWholeShares = maximumPrincipalBudgetRaw / priceRaw;
  const wholeShares = (maximumWholeShares / shareQuantum) * shareQuantum;
  const sharesRaw = wholeShares * SHARE_SCALE;
  const orderPrincipalRaw = wholeShares * priceRaw;
  const maximumFeeRaw = ceilDiv(orderPrincipalRaw * feeBpsRaw, BPS_SCALE);
  const maximumTotalDebitRaw = orderPrincipalRaw + maximumFeeRaw;
  invariant(
    maximumTotalDebitRaw <= requestedBudgetRaw,
    "budget_calculation_error",
    "Compiled order exceeds the requested total spend budget",
  );
  const minimum = minimumMarketableBudget(formatDecimal(priceRaw, 6), feeBps);
  const minimumPrincipalRaw = parseDecimal(
    minimum.minimumOrderPrincipal,
    6,
    "minimumOrderPrincipal",
  );
  invariant(
    orderPrincipalRaw >= minimumPrincipalRaw,
    "marketable_order_below_minimum",
    "Total spend budget cannot fund Conviction's cent-aligned whole-share marketable BUY after fees",
    {
      requestedBudget: formatDecimal(requestedBudgetRaw, 6),
      ...minimum,
    },
  );
  invariant(
    orderPrincipalRaw % V2_PRINCIPAL_STEP_RAW === 0n,
    "budget_calculation_error",
    "Compiled V2 principal is not cent-aligned",
  );

  const ask = bestAsk(market.asks);
  const bestAskRaw = parseDecimal(ask.price, 6, "bestAsk");
  invariant(bestAskRaw <= priceRaw, "limit_below_best_ask", "maxPrice is below the current best ask", {
    bestAsk: formatDecimal(bestAskRaw, 6),
  });

  const depthRaw = market.asks.reduce((total, level) => {
    const levelPrice = parseDecimal(level.price, 6, "ask price");
    if (levelPrice > priceRaw) return total;
    return total + parseDecimal(level.size, 6, "ask size");
  }, 0n);
  invariant(depthRaw >= sharesRaw, "insufficient_bounded_liquidity", "Current asks within maxPrice cannot fill the requested order", {
    requestedShares: formatDecimal(sharesRaw, 6),
    availableShares: formatDecimal(depthRaw, 6),
  });

  const requestedBudget = formatDecimal(requestedBudgetRaw, 6);
  const orderPrincipal = formatDecimal(orderPrincipalRaw, 6);
  const maximumFee = formatDecimal(maximumFeeRaw, 6);
  const maximumTotalDebit = formatDecimal(maximumTotalDebitRaw, 6);
  const unusedBudget = formatDecimal(requestedBudgetRaw - maximumTotalDebitRaw, 6);
  const maxPrice = formatDecimal(priceRaw, 6);
  const fullFillSharesAtCap = formatDecimal(sharesRaw, 6);
  const grossProfitAtCapRaw = sharesRaw - maximumTotalDebitRaw;
  const allInBreakEvenPriceRaw = ceilDiv(maximumTotalDebitRaw * SHARE_SCALE, sharesRaw);
  const priceCapCushionRaw = priceRaw - bestAskRaw;
  const boundedLiquidityCoverageBps = (depthRaw * 10_000n) / sharesRaw;
  const bid = bestBid(market.bids);
  const bestBidRaw = bid ? parseDecimal(bid.price, 6, "bestBid") : null;
  const spreadRaw = bestBidRaw === null ? null : bestAskRaw - bestBidRaw;
  invariant(spreadRaw === null || spreadRaw >= 0n, "invalid_orderbook", "Best bid exceeds best ask");
  const endTimestamp = Date.parse(market.endDate || "");
  const capturedTimestamp = Date.parse(market.capturedAt);
  const secondsToResolution = Number.isFinite(endTimestamp)
    ? Math.max(0, Math.floor((endTimestamp - capturedTimestamp) / 1_000))
    : null;
  const expiresAt = new Date(Date.parse(market.capturedAt) + quoteTtlMs).toISOString();
  return {
    outcome,
    requestedBudget,
    orderPrincipal,
    maximumFee,
    maxPrice,
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
      outcomeTokenId: market.outcomeTokenId,
      counterOutcomeTokenId: market.counterOutcomeTokenId,
      outcomes: {
        YES: { tokenId: market.yesTokenId },
        NO: { tokenId: market.noTokenId },
      },
      negRisk: false,
      exchange: CONTRACTS.standardExchangeV2,
      collateral: CONTRACTS.pUsd,
    },
    order: {
      side: "BUY",
      outcome,
      outcomeTokenId: market.outcomeTokenId,
      orderType: "FAK",
      requestedBudget,
      requestedBudgetRaw: requestedBudgetRaw.toString(),
      maximumSpend: maximumTotalDebit,
      maximumSpendRaw: maximumTotalDebitRaw.toString(),
      maximumOrderPrincipal: orderPrincipal,
      maximumOrderPrincipalRaw: orderPrincipalRaw.toString(),
      maximumFee,
      maximumFeeRaw: maximumFeeRaw.toString(),
      maximumTotalDebit,
      maximumTotalDebitRaw: maximumTotalDebitRaw.toString(),
      unusedBudget,
      maxPrice,
      fullFillSharesAtCap,
      fullFillSharesAtCapRaw: sharesRaw.toString(),
      feeBps,
      feeSource: "polymarket_clob_maker_base_fee",
      feeReserveMethod: "ceil(orderPrincipal*feeBps/10000)",
      feeEnforcement: "dedicated-wallet-balance-cap-plus-post-settlement-verification",
      principalPrecision: "v2-cent-aligned-whole-shares",
    },
    snapshot: {
      capturedAt: market.capturedAt,
      expiresAt,
      bestAsk: formatDecimal(bestAskRaw, 6),
      bestBid: bestBidRaw === null ? null : formatDecimal(bestBidRaw, 6),
      spread: spreadRaw === null ? null : formatDecimal(spreadRaw, 6),
      boundedAskDepth: formatDecimal(depthRaw, 6),
    },
    exposure: {
      maximumLoss: maximumTotalDebit,
      fullFillPayoutAtCap: fullFillSharesAtCap,
      grossProfitAtCap: formatDecimal(grossProfitAtCapRaw, 6),
      grossBreakEvenPrice: formatDecimal(allInBreakEvenPriceRaw, 6),
      priceCapCushion: formatDecimal(priceCapCushionRaw, 6),
      boundedLiquidityCoverageBps: boundedLiquidityCoverageBps.toString(),
      feesIncluded: true,
      maximumFee,
      maximumTotalDebit,
      unusedBudget,
      assumesFullFillAtCap: true,
      secondsToResolution,
    },
  };
}

function disclosuresFor({ requestedBudget, orderPrincipal, maximumFee }) {
  return [
    "The buyer's own wallet signs and pays for the order.",
    "FAK fills immediately at or below maxPrice and cancels any unfilled remainder.",
    `The ${requestedBudget} pUSD input is the accepted total-debit ceiling for verification; the compiled principal is ${orderPrincipal} pUSD and the current venue-fee reserve is ${maximumFee} pUSD.`,
    "The order principal is cent-aligned with a whole-share quantity so the official V2 plugin's live precision pass cannot rewrite the reviewed order.",
    "Displayed maximum loss includes the current venue-fee reserve; actual FAK debit may be lower on a partial fill.",
    "Polymarket V2 signs the order principal, token, shares, and price, while the operator applies fees at match time. Conviction rechecks that fee immediately before execution and verifies the actual fee and total debit after settlement; the fee itself is not part of the V2 signature.",
    "New deposit-wallet users must review Polymarket's five-approval setup before trading.",
  ];
}

export function compilePreview(request, market, options = {}) {
  const bounded = compileBoundedOrder(request, market, options);
  return {
    ok: true,
    preview: {
      version: "conviction-preview-v1",
      chainId: POLYGON_CHAIN_ID,
      market: bounded.market,
      order: bounded.order,
      snapshot: bounded.snapshot,
      exposure: bounded.exposure,
      executable: false,
      requiresWallet: false,
      requiresPayment: false,
    },
    disclosures: disclosuresFor(bounded),
  };
}

export function compileIntent(request, market, options = {}) {
  const intentVersion = options.intentVersion ?? "conviction-intent-v3";
  invariant(
    intentVersion === "conviction-intent-v3" || intentVersion === "conviction-intent-v4",
    "invalid_intent_version",
    "Unsupported intent version",
  );
  const wallet = String(request.wallet || "").toLowerCase();
  invariant(ADDRESS_RE.test(wallet), "invalid_wallet", "wallet must be a valid EVM address");
  const rationale = String(request.rationale || "").trim();
  invariant(
    rationale.length === 0 || (rationale.length >= 20 && rationale.length <= 500),
    "invalid_rationale",
    "rationale must be empty or 20 to 500 characters",
  );
  const bounded = compileBoundedOrder(request, market, options);
  const order = intentVersion === "conviction-intent-v4"
    ? {
        ...bounded.order,
        feeEnforcement: "signed-order-bounds-plus-post-settlement-verification",
      }
    : bounded.order;
  const intent = {
    version: intentVersion,
    chainId: POLYGON_CHAIN_ID,
    market: bounded.market,
    order,
    buyer: { wallet },
    rationale,
    snapshot: bounded.snapshot,
    exposure: bounded.exposure,
    ...(intentVersion === "conviction-intent-v4"
      ? {
          walletPreparation: finiteEoaOpenPreparation({
            wallet,
            market: bounded.market,
            order,
          }),
        }
      : {}),
    executor: EXECUTOR_RELEASE,
  };
  const intentHash = sha256(intent);
  return {
    ok: true,
    intentHash,
    intent,
    executor: EXECUTOR_RELEASE,
    nextStep: executorNextStep("OPEN"),
    executionCard: {
      tool: "polymarket-plugin",
      action: "buy",
      argv: [
        "buy",
        "--market-id",
        bounded.market.conditionId,
        "--token-id",
        bounded.market.outcomeTokenId,
        "--outcome",
        bounded.outcome.toLowerCase(),
        "--amount",
        bounded.orderPrincipal,
        "--price",
        bounded.maxPrice,
        "--order-type",
        "FAK",
      ],
      requiresUserConfirmation: true,
      nonCustodial: true,
      requiresSufficientBalance: true,
      authorizationScope: "single-bounded-order",
      executorReleaseHash: EXECUTOR_RELEASE_HASH,
      maximumAuthorizedDebit: bounded.order.maximumTotalDebit,
      expiresAt: bounded.expiresAt,
    },
    disclosures: disclosuresFor(bounded),
  };
}
