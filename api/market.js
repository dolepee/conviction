import { ConvictionError, invariant } from "../src/errors.mjs";
import { formatDecimal, parseDecimal } from "../src/decimal.mjs";
import { minimumMarketableBudget } from "../src/intent-compiler.mjs";
import { resolveMarket } from "../src/market-client.mjs";
import { createPublicApiGuard, PublicApiError } from "../src/public-api-guard.mjs";
import { createShortCache } from "../src/short-cache.mjs";

function send(response, status, body) {
  response.status(status).setHeader("content-type", "application/json; charset=utf-8");
  response.setHeader("cache-control", "no-store");
  response.end(JSON.stringify(body));
}

function bestLevel(levels, direction) {
  if (!Array.isArray(levels) || levels.length === 0) return null;
  return levels.reduce((best, level) => {
    const candidateRaw = parseDecimal(level.price, 6, `${direction} price`);
    const bestRaw = parseDecimal(best.price, 6, `${direction} price`);
    if (direction === "ask") return candidateRaw < bestRaw ? level : best;
    return candidateRaw > bestRaw ? level : best;
  });
}

function marketableSuggestion(levels, feeBps) {
  if (!Array.isArray(levels) || levels.length === 0) return null;
  const asks = levels
    .map((level) => {
      const priceRaw = parseDecimal(level.price, 6, "ask price");
      const sizeRaw = parseDecimal(level.size, 6, "ask size");
      invariant(sizeRaw > 0n, "invalid_market_data", "Ask size must be positive");
      return { priceRaw, sizeRaw };
    })
    .sort((left, right) => {
      if (left.priceRaw === right.priceRaw) return 0;
      return left.priceRaw < right.priceRaw ? -1 : 1;
    });

  let cumulativeDepthRaw = 0n;
  for (let index = 0; index < asks.length;) {
    const candidatePriceRaw = asks[index].priceRaw;
    while (index < asks.length && asks[index].priceRaw === candidatePriceRaw) {
      cumulativeDepthRaw += asks[index].sizeRaw;
      index += 1;
    }
    const suggestedMaxPrice = formatDecimal(candidatePriceRaw, 6);
    const minimum = minimumMarketableBudget(suggestedMaxPrice, feeBps);
    const requiredSharesRaw = parseDecimal(
      minimum.minimumShares,
      6,
      "minimum marketable shares",
    );
    if (cumulativeDepthRaw >= requiredSharesRaw) {
      return { suggestedMaxPrice, minimum };
    }
  }
  return null;
}

function outcomeSummary(market) {
  const ask = bestLevel(market.asks, "ask");
  const bid = bestLevel(market.bids, "bid");
  const suggestion = marketableSuggestion(market.asks, market.feeBps);
  return {
    available: Boolean(ask),
    bestAsk: ask ? formatDecimal(parseDecimal(ask.price, 6, "ask price"), 6) : null,
    bestBid: bid ? formatDecimal(parseDecimal(bid.price, 6, "bid price"), 6) : null,
    suggestedMaxPrice: suggestion?.suggestedMaxPrice || null,
    tickSize: market.tickSize,
    minimumOrderSize: market.minOrderSize,
    minimumOrderSizeScope: "venue_resting_order_shares",
    feeBps: market.feeBps,
    minimumMarketableBudget: suggestion?.minimum || null,
    minimumMarketableBudgetScope: "immediately_marketable_order_budget",
  };
}

export function createMarketHandler({
  resolveMarketImpl = resolveMarket,
  publicGuard = createPublicApiGuard(),
  cache = createShortCache(),
} = {}) {
  return async function handler(request, response) {
    if (request.method !== "POST") {
      response.setHeader("allow", "POST");
      return send(response, 405, { ok: false, error: { code: "method_not_allowed" } });
    }
    try {
      const body = request.body && typeof request.body === "object" ? request.body : {};
      // Preserve case so caching can never make an otherwise-invalid market
      // reference inherit the result of a different accepted input.
      const key = JSON.stringify([String(body.market || "").trim()]);
      const result = await publicGuard.run(request, () => cache.get(key, async () => {
        const [yes, no] = await Promise.all([
          resolveMarketImpl(body.market, { outcome: "yes" }),
          resolveMarketImpl(body.market, { outcome: "no" }),
        ]);
        invariant(
          yes.conditionId === no.conditionId &&
            yes.yesTokenId === no.yesTokenId &&
            yes.noTokenId === no.noTokenId,
          "market_source_mismatch",
          "YES and NO market snapshots disagree",
        );
        return {
          ok: true,
          market: {
            source: "polymarket",
            conditionId: yes.conditionId,
            slug: yes.slug,
            question: yes.question,
            endDate: yes.endDate,
            active: yes.active,
            closed: yes.closed,
            acceptingOrders: yes.acceptingOrders,
          },
          outcomes: {
            YES: outcomeSummary(yes),
            NO: outcomeSummary(no),
          },
          readOnly: true,
        };
      }));
      return send(response, 200, result);
    } catch (error) {
      if (error instanceof PublicApiError) {
        if (error.details?.retryAfterSeconds) {
          response.setHeader("retry-after", String(error.details.retryAfterSeconds));
        }
        return send(response, error.status, {
          ok: false,
          error: { code: error.code, message: error.message, details: error.details },
        });
      }
      if (error instanceof ConvictionError) {
        const upstream = error.code === "market_api_error";
        const status = error.code === "market_not_found" ? 404 : upstream ? 502 : 422;
        return send(response, status, {
          ok: false,
          error: { code: error.code, message: error.message, details: error.details },
        });
      }
      console.error("market handler failed", error);
      return send(response, 500, {
        ok: false,
        error: { code: "internal_error", message: "Market lookup failed" },
      });
    }
  };
}

export default createMarketHandler();
