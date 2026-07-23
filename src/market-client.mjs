import {
  CLOB_API_URL,
  GAMMA_API_URL,
} from "./constants.mjs";
import { ConvictionError, invariant } from "./errors.mjs";

const CONDITION_ID_RE = /^0x[0-9a-f]{64}$/i;
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MARKET_NOT_FOUND_MESSAGE =
  "Polymarket market not found. Check the market URL or use a current Polymarket market slug.";

function normalizeOutcome(value) {
  const outcome = String(value || "").trim().toLowerCase();
  invariant(
    outcome === "yes" || outcome === "no",
    "unsupported_outcome",
    "outcome must be YES or NO",
  );
  return outcome;
}

async function fetchJson(url, fetchImpl, { notFound } = {}) {
  const response = await fetchImpl(url, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) {
    if (response.status === 404 && notFound) {
      throw new ConvictionError(
        notFound.code || "market_not_found",
        notFound.message || MARKET_NOT_FOUND_MESSAGE,
        notFound.details,
      );
    }
    throw new ConvictionError(
      "market_api_error",
      `Market API returned HTTP ${response.status}`,
      { url, status: response.status },
    );
  }
  return response.json();
}

export function normalizeMarketReference(value) {
  const raw = String(value || "").trim();
  invariant(raw, "missing_market", "market is required");
  if (CONDITION_ID_RE.test(raw)) {
    return { type: "conditionId", value: raw.toLowerCase() };
  }
  let slug = raw;
  if (/^https?:\/\//i.test(raw)) {
    const url = new URL(raw);
    invariant(
      /(^|\.)polymarket\.com$/i.test(url.hostname),
      "unsupported_market_host",
      "Only polymarket.com market URLs are supported",
      { host: url.hostname },
    );
    const parts = url.pathname.split("/").filter(Boolean);
    slug = parts.at(-1) || "";
  }
  invariant(
    SLUG_RE.test(slug),
    "invalid_market_reference",
    "market must be a Polymarket URL, slug, or condition ID",
    { market: raw },
  );
  return { type: "slug", value: slug };
}

function parseJsonArray(value, label) {
  if (Array.isArray(value)) return value;
  try {
    const parsed = JSON.parse(value || "[]");
    invariant(Array.isArray(parsed), "invalid_market_data", `${label} is invalid`);
    return parsed;
  } catch (error) {
    if (error instanceof ConvictionError) throw error;
    throw new ConvictionError("invalid_market_data", `${label} is invalid`);
  }
}

export async function resolveMarket(
  marketReference,
  { fetchImpl = fetch, now = Date.now(), outcome = "yes" } = {},
) {
  const selectedOutcome = normalizeOutcome(outcome);
  const reference = normalizeMarketReference(marketReference);
  let gamma = null;
  let conditionId = reference.value;

  if (reference.type === "slug") {
    gamma = await fetchJson(
      `${GAMMA_API_URL}/markets/slug/${encodeURIComponent(reference.value)}`,
      fetchImpl,
      {
        notFound: {
          message: MARKET_NOT_FOUND_MESSAGE,
          details: { market: reference.value },
        },
      },
    );
    if (Array.isArray(gamma)) gamma = gamma[0];
    invariant(
      gamma && typeof gamma === "object",
      "market_not_found",
      MARKET_NOT_FOUND_MESSAGE,
      { market: reference.value },
    );
    conditionId = String(gamma.conditionId || "").toLowerCase();
    invariant(CONDITION_ID_RE.test(conditionId), "invalid_market_data", "Market has no valid condition ID");
  }

  const clob = await fetchJson(
    `${CLOB_API_URL}/markets/${conditionId}`,
    fetchImpl,
    {
      notFound: {
        message: MARKET_NOT_FOUND_MESSAGE,
        details: { market: reference.value },
      },
    },
  );
  const rawFeeBps = clob.maker_base_fee;
  const feeBps = Number(rawFeeBps);
  invariant(
    rawFeeBps !== undefined &&
      rawFeeBps !== null &&
      String(rawFeeBps).trim() !== "" &&
      Number.isInteger(feeBps) &&
      feeBps >= 0 &&
      feeBps <= 10_000,
    "invalid_market_data",
    "CLOB market has no valid maker fee rate",
  );
  const yesToken = (clob.tokens || []).find(
    (token) => String(token.outcome).toLowerCase() === "yes",
  );
  const noToken = (clob.tokens || []).find(
    (token) => String(token.outcome).toLowerCase() === "no",
  );
  invariant(yesToken && noToken, "unsupported_outcomes", "Only binary Yes/No markets are supported");
  const tokens = { yes: yesToken, no: noToken };
  const selectedToken = tokens[selectedOutcome];
  const counterToken = tokens[selectedOutcome === "yes" ? "no" : "yes"];

  if (gamma) {
    const gammaOutcomes = parseJsonArray(gamma.outcomes, "Gamma outcomes");
    const gammaTokenIds = parseJsonArray(gamma.clobTokenIds, "Gamma token IDs");
    for (const name of ["yes", "no"]) {
      const index = gammaOutcomes.findIndex(
        (candidate) => String(candidate).toLowerCase() === name,
      );
      invariant(index >= 0, "invalid_market_data", `Gamma market has no ${name.toUpperCase()} outcome`);
      invariant(
        String(gammaTokenIds[index]) === String(tokens[name].token_id),
        "market_source_mismatch",
        `Gamma and CLOB disagree on the ${name.toUpperCase()} token`,
      );
    }
  }

  const book = await fetchJson(
    `${CLOB_API_URL}/book?token_id=${encodeURIComponent(selectedToken.token_id)}`,
    fetchImpl,
  );
  invariant(
    String(book.market || "").toLowerCase() === conditionId,
    "market_source_mismatch",
    "Order book condition ID does not match the market",
  );
  invariant(
    String(book.asset_id || "") === String(selectedToken.token_id),
    "market_source_mismatch",
    `Order book asset does not match the ${selectedOutcome.toUpperCase()} token`,
  );

  return {
    source: "polymarket",
    clobVersion: "V2",
    conditionId,
    slug: gamma?.slug || null,
    question: gamma?.question || clob.question || null,
    description: gamma?.description || null,
    resolutionSource: gamma?.resolutionSource || null,
    endDate: gamma?.endDate || clob.end_date_iso || null,
    active: Boolean(gamma ? gamma.active : clob.active) && Boolean(clob.active),
    closed: Boolean(gamma?.closed) || Boolean(clob.closed),
    acceptingOrders:
      Boolean(gamma ? gamma.acceptingOrders : clob.accepting_orders) &&
      Boolean(clob.accepting_orders),
    negRisk: Boolean(gamma?.negRisk) || Boolean(clob.neg_risk),
    feeBps,
    yesTokenId: String(yesToken.token_id),
    noTokenId: String(noToken.token_id),
    selectedOutcome: selectedOutcome.toUpperCase(),
    outcomeTokenId: String(selectedToken.token_id),
    counterOutcomeTokenId: String(counterToken.token_id),
    tickSize: String(book.tick_size || gamma?.orderPriceMinTickSize || "0.01"),
    minOrderSize: String(book.min_order_size || gamma?.orderMinSize || "5"),
    bids: Array.isArray(book.bids) ? book.bids : [],
    asks: Array.isArray(book.asks) ? book.asks : [],
    capturedAt: new Date(now).toISOString(),
  };
}
