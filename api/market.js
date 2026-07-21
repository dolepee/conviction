import { ConvictionError, invariant } from "../src/errors.mjs";
import { formatDecimal, parseDecimal } from "../src/decimal.mjs";
import { resolveMarket } from "../src/market-client.mjs";

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

function outcomeSummary(market) {
  const ask = bestLevel(market.asks, "ask");
  const bid = bestLevel(market.bids, "bid");
  return {
    available: Boolean(ask),
    bestAsk: ask ? formatDecimal(parseDecimal(ask.price, 6, "ask price"), 6) : null,
    bestBid: bid ? formatDecimal(parseDecimal(bid.price, 6, "bid price"), 6) : null,
    tickSize: market.tickSize,
    minimumOrderSize: market.minOrderSize,
    feeBps: market.feeBps,
  };
}

export function createMarketHandler({ resolveMarketImpl = resolveMarket } = {}) {
  return async function handler(request, response) {
    if (request.method !== "POST") {
      response.setHeader("allow", "POST");
      return send(response, 405, { ok: false, error: { code: "method_not_allowed" } });
    }
    try {
      const body = request.body && typeof request.body === "object" ? request.body : {};
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
      return send(response, 200, {
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
      });
    } catch (error) {
      if (error instanceof ConvictionError) {
        const upstream = error.code === "market_api_error";
        return send(response, upstream ? 502 : 422, {
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
