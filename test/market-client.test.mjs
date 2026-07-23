import assert from "node:assert/strict";
import test from "node:test";

import { ConvictionError } from "../src/errors.mjs";
import { resolveMarket } from "../src/market-client.mjs";
import { LIVE_MARKET_SNAPSHOT } from "./fixtures.mjs";

const GAMMA = {
  slug: LIVE_MARKET_SNAPSHOT.slug,
  question: LIVE_MARKET_SNAPSHOT.question,
  description: "Canonical resolution rules.",
  resolutionSource: "Official source",
  conditionId: LIVE_MARKET_SNAPSHOT.conditionId,
  outcomes: JSON.stringify(["Yes", "No"]),
  clobTokenIds: JSON.stringify([
    LIVE_MARKET_SNAPSHOT.yesTokenId,
    LIVE_MARKET_SNAPSHOT.noTokenId,
  ]),
  active: true,
  closed: false,
  acceptingOrders: true,
  negRisk: false,
  endDate: LIVE_MARKET_SNAPSHOT.endDate,
};

const CLOB = {
  question: LIVE_MARKET_SNAPSHOT.question,
  active: true,
  closed: false,
  accepting_orders: true,
  neg_risk: false,
  tokens: [
    { outcome: "Yes", token_id: LIVE_MARKET_SNAPSHOT.yesTokenId },
    { outcome: "No", token_id: LIVE_MARKET_SNAPSHOT.noTokenId },
  ],
  maker_base_fee: 0,
};

function response(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function fakeMarketApi({ gamma = GAMMA, clob = CLOB } = {}) {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(String(url));
    if (String(url).includes("gamma-api.polymarket.com")) return response(gamma);
    if (String(url).includes("/markets/")) return response(clob);
    if (String(url).includes("/book?")) {
      const tokenId = new URL(url).searchParams.get("token_id");
      return response({
        market: LIVE_MARKET_SNAPSHOT.conditionId,
        asset_id: tokenId,
        tick_size: "0.01",
        min_order_size: "5",
        bids: [{ price: "0.72", size: "100" }],
        asks: [{ price: "0.74", size: "100" }],
      });
    }
    return response({}, 404);
  };
  return { calls, fetchImpl };
}

test("resolves and fetches the selected NO token book", async () => {
  const api = fakeMarketApi();
  const market = await resolveMarket(LIVE_MARKET_SNAPSHOT.slug, {
    outcome: "no",
    fetchImpl: api.fetchImpl,
    now: Date.parse("2026-07-21T02:00:00Z"),
  });
  assert.equal(market.selectedOutcome, "NO");
  assert.equal(market.outcomeTokenId, LIVE_MARKET_SNAPSHOT.noTokenId);
  assert.equal(market.counterOutcomeTokenId, LIVE_MARKET_SNAPSHOT.yesTokenId);
  assert.ok(api.calls.some((url) => url.includes(`token_id=${LIVE_MARKET_SNAPSHOT.noTokenId}`)));
  assert.ok(!api.calls.some((url) => url.includes(`token_id=${LIVE_MARKET_SNAPSHOT.yesTokenId}`)));
});

test("returns a clean market_not_found error for unknown Gamma slugs", async () => {
  const calls = [];
  await assert.rejects(
    () =>
      resolveMarket("definitely-not-a-real-market", {
        outcome: "yes",
        fetchImpl: async (url) => {
          calls.push(String(url));
          return response({ error: "not found" }, 404);
        },
      }),
    (error) => {
      assert.equal(error instanceof ConvictionError, true);
      assert.equal(error.code, "market_not_found");
      assert.match(error.message, /Polymarket market not found/);
      assert.deepEqual(error.details, { market: "definitely-not-a-real-market" });
      return true;
    },
  );
  assert.equal(calls.length, 1);
  assert.match(calls[0], /gamma-api\.polymarket\.com/);
});

test("returns a clean market_not_found error for unknown CLOB condition IDs", async () => {
  const missingCondition = `0x${"9".repeat(64)}`;
  const calls = [];
  await assert.rejects(
    () =>
      resolveMarket(missingCondition, {
        outcome: "yes",
        fetchImpl: async (url) => {
          calls.push(String(url));
          return response({ error: "not found" }, 404);
        },
      }),
    (error) => {
      assert.equal(error instanceof ConvictionError, true);
      assert.equal(error.code, "market_not_found");
      assert.match(error.message, /Polymarket market not found/);
      assert.deepEqual(error.details, { market: missingCondition });
      return true;
    },
  );
  assert.equal(calls.length, 1);
  assert.match(calls[0], /clob\.polymarket\.com\/markets\//);
});

test("cross-checks both Gamma outcome tokens against CLOB", async () => {
  const api = fakeMarketApi({
    gamma: {
      ...GAMMA,
      clobTokenIds: JSON.stringify([LIVE_MARKET_SNAPSHOT.yesTokenId, "123"]),
    },
  });
  await assert.rejects(
    () => resolveMarket(LIVE_MARKET_SNAPSHOT.slug, { outcome: "no", fetchImpl: api.fetchImpl }),
    (error) => error instanceof ConvictionError && error.code === "market_source_mismatch",
  );
});

test("rejects an invalid outcome before touching market APIs", async () => {
  let calls = 0;
  await assert.rejects(
    () =>
      resolveMarket(LIVE_MARKET_SNAPSHOT.slug, {
        outcome: "draw",
        fetchImpl: async () => {
          calls += 1;
          return response({});
        },
      }),
    (error) => error instanceof ConvictionError && error.code === "unsupported_outcome",
  );
  assert.equal(calls, 0);
});

test("fails closed when the CLOB fee rate is missing or malformed", async () => {
  for (const makerBaseFee of [undefined, null, "", "unknown", -1, 10_001]) {
    const clob = { ...CLOB };
    if (makerBaseFee === undefined) delete clob.maker_base_fee;
    else clob.maker_base_fee = makerBaseFee;
    const api = fakeMarketApi({ clob });
    await assert.rejects(
      () => resolveMarket(LIVE_MARKET_SNAPSHOT.slug, { outcome: "no", fetchImpl: api.fetchImpl }),
      (error) => error instanceof ConvictionError && error.code === "invalid_market_data",
    );
  }
});
