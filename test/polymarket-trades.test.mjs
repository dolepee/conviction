import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";

import { fetchExactAssociatedTradeContributions } from "../src/polymarket-trades.mjs";

const SIGNER = "0x1111111111111111111111111111111111111111";
const DEPOSIT = "0x2222222222222222222222222222222222222222";
const OTHER_WALLET = "0x3333333333333333333333333333333333333333";
const ORDER_ID = `0x${"a".repeat(64)}`;
const OTHER_ORDER_ID = `0x${"b".repeat(64)}`;
const CONDITION_ID = `0x${"c".repeat(64)}`;
const OTHER_CONDITION_ID = `0x${"d".repeat(64)}`;
const TX_ONE = `0x${"e".repeat(64)}`;
const TX_TWO = `0x${"f".repeat(64)}`;
const TOKEN = "123456789";
const TRADE_ONE = "9326ea42-c5c7-457a-b6a4-9b839664f32e";
const TRADE_TWO = "trade-two";
const SECRET = Buffer.from("trade-secret").toString("base64url");
const CREDS = Object.freeze({
  signerAddress: SIGNER,
  depositWallet: DEPOSIT,
  apiKey: "api-key-id",
  secret: SECRET,
  passphrase: "passphrase",
});
const NOW_MS = 1_800_000_000_123;

function response(body, ok = true, status = 200) {
  return { ok, status, json: async () => body };
}

function snapshot(associatedTrades = [TRADE_ONE], overrides = {}) {
  const { order: orderOverrides = {}, ...snapshotOverrides } = overrides;
  return {
    version: "conviction-polymarket-order-snapshot-v1",
    verificationSource: "authenticated-polymarket-clob",
    onChain: false,
    fetchedAt: "2027-01-15T08:00:00.000Z",
    signerAddress: SIGNER,
    depositWallet: DEPOSIT,
    credentialOwnerVerified: true,
    order: {
      id: ORDER_ID,
      status: "MATCHED",
      market: CONDITION_ID,
      assetId: TOKEN,
      side: "SELL",
      originalSize: "10",
      sizeMatched: "10",
      price: "0.27",
      orderType: "GTD",
      expiration: "1800003600",
      outcome: "YES",
      createdAt: "1800000000",
      associatedTrades,
      ...orderOverrides,
    },
    ...snapshotOverrides,
  };
}

function takerTrade(id = TRADE_ONE, overrides = {}) {
  return {
    id,
    taker_order_id: ORDER_ID,
    market: CONDITION_ID,
    asset_id: TOKEN,
    side: "SELL",
    size: "5.25",
    fee_rate_bps: "0",
    price: "0.27",
    status: "TRADE_STATUS_CONFIRMED",
    match_time: "1800000000",
    last_update: "1800000001",
    outcome: "YES",
    owner: CREDS.apiKey,
    maker_address: DEPOSIT,
    transaction_hash: TX_ONE,
    trader_side: "TAKER",
    maker_orders: [{
      order_id: OTHER_ORDER_ID,
      owner: "counterparty",
      maker_address: OTHER_WALLET,
      matched_amount: "5.25",
      price: "0.27",
      fee_rate_bps: "0",
      asset_id: TOKEN,
      outcome: "YES",
      side: "BUY",
    }],
    ...overrides,
  };
}

function makerTrade(id = TRADE_ONE, makerOverrides = {}, overrides = {}) {
  return {
    id,
    taker_order_id: OTHER_ORDER_ID,
    market: CONDITION_ID,
    asset_id: TOKEN,
    // Top-level side, size, and price describe the taker. The recovered TP
    // contribution must come from the matching nested maker order instead.
    side: "BUY",
    size: "9",
    fee_rate_bps: "0",
    price: "0.30",
    status: "CONFIRMED",
    match_time: "1800000000",
    last_update: "1800000001",
    outcome: "YES",
    owner: CREDS.apiKey,
    maker_address: DEPOSIT,
    transaction_hash: TX_TWO,
    trader_side: "MAKER",
    maker_orders: [{
      order_id: ORDER_ID,
      owner: CREDS.apiKey,
      maker_address: DEPOSIT,
      matched_amount: "2.125",
      price: "0.28",
      fee_rate_bps: "0",
      asset_id: TOKEN,
      outcome: "YES",
      side: "SELL",
      ...makerOverrides,
    }],
    ...overrides,
  };
}

function argumentsFor(overrides = {}) {
  return {
    signerAddress: SIGNER,
    depositWallet: DEPOSIT,
    orderId: ORDER_ID,
    marketConditionId: CONDITION_ID,
    outcomeTokenId: TOKEN,
    exactOrderSnapshot: snapshot(),
    credentials: CREDS,
    now: () => NOW_MS,
    ...overrides,
  };
}

test("recovers every exact taker contribution with canonical query auth and no credentials", async () => {
  const calls = [];
  const result = await fetchExactAssociatedTradeContributions(argumentsFor({
    exactOrderSnapshot: snapshot([TRADE_ONE, TRADE_TWO]),
    fetchImpl: async (url, init) => {
      calls.push({ url: new URL(url), init });
      const tradeId = new URL(url).searchParams.get("id");
      return response({
        count: 1,
        limit: 100,
        data: [takerTrade(tradeId, {
          size: tradeId === TRADE_ONE ? "5.25" : "1",
          transaction_hash: TX_ONE,
        })],
        next_cursor: "LTE=",
      });
    },
  }));

  assert.equal(result.version, "conviction-polymarket-associated-trades-v1");
  assert.equal(result.verificationSource, "authenticated-polymarket-clob");
  assert.equal(result.onChain, false);
  assert.equal(result.orderId, ORDER_ID);
  assert.equal(result.marketConditionId, CONDITION_ID);
  assert.equal(result.outcomeTokenId, TOKEN);
  assert.deepEqual(result.associatedTradeIds, [TRADE_ONE, TRADE_TWO]);
  assert.deepEqual(result.transactionHashes, [TX_ONE]);
  assert.deepEqual(result.contributions.map(({ matchedSharesRaw }) => matchedSharesRaw), ["5250000", "1000000"]);
  assert.deepEqual(result.contributions.map(({ orderRole }) => orderRole), ["TAKER", "TAKER"]);
  assert.equal(result.contributions[0].priceRaw, "270000");
  assert.equal(result.contributions[0].status, "CONFIRMED");
  assert.equal(result.contributions[0].venueStatus, "TRADE_STATUS_CONFIRMED");
  assert.equal(calls.length, 2);
  for (const call of calls) {
    assert.equal(call.url.origin, "https://clob.polymarket.com");
    assert.equal(call.url.pathname, "/trades");
    assert.ok([TRADE_ONE, TRADE_TWO].includes(call.url.searchParams.get("id")));
    assert.equal(call.init.method, "GET");
    assert.equal(call.init.redirect, "error");
    const timestamp = String(Math.floor(NOW_MS / 1_000));
    const expected = createHmac("sha256", Buffer.from(SECRET, "base64url"))
      .update(`${timestamp}GET/trades`)
      .digest("base64")
      .replaceAll("+", "-")
      .replaceAll("/", "_");
    assert.equal(call.init.headers.POLY_SIGNATURE, expected);
    assert.equal(call.init.headers.POLY_TIMESTAMP, timestamp);
  }
  const serialized = JSON.stringify(result);
  assert.equal(serialized.includes(CREDS.apiKey), false);
  assert.equal(serialized.includes(CREDS.secret), false);
  assert.equal(serialized.includes(CREDS.passphrase), false);
});

test("extracts only the unique pinned maker contribution", async () => {
  const result = await fetchExactAssociatedTradeContributions(argumentsFor({
    fetchImpl: async () => response([makerTrade()]),
  }));
  assert.equal(result.contributions.length, 1);
  assert.deepEqual(result.contributions[0], {
    tradeId: TRADE_ONE,
    orderRole: "MAKER",
    orderId: ORDER_ID,
    marketConditionId: CONDITION_ID,
    outcomeTokenId: TOKEN,
    side: "SELL",
    depositWallet: DEPOSIT,
    matchedShares: "2.125",
    matchedSharesRaw: "2125000",
    price: "0.28",
    priceRaw: "280000",
    status: "CONFIRMED",
    venueStatus: "CONFIRMED",
    transactionHash: TX_TWO,
  });
});

test("an exact order with no associated trades returns a complete empty recovery", async () => {
  let called = false;
  const result = await fetchExactAssociatedTradeContributions(argumentsFor({
    exactOrderSnapshot: snapshot([]),
    fetchImpl: async () => {
      called = true;
      throw new Error("must not fetch");
    },
  }));
  assert.equal(called, false);
  assert.deepEqual(result.associatedTradeIds, []);
  assert.deepEqual(result.contributions, []);
  assert.deepEqual(result.transactionHashes, []);
});

test("fails closed unless the source snapshot is authenticated and exactly pinned", async () => {
  const cases = [
    [snapshot([TRADE_ONE], { verificationSource: "caller-supplied" }), "invalid_trade_order_snapshot"],
    [snapshot([TRADE_ONE], { onChain: true }), "invalid_trade_order_snapshot"],
    [snapshot([TRADE_ONE], { credentialOwnerVerified: false }), "invalid_trade_order_snapshot"],
    [snapshot([TRADE_ONE], { signerAddress: OTHER_WALLET }), "trade_wallet_mismatch"],
    [snapshot([TRADE_ONE], { depositWallet: OTHER_WALLET }), "trade_wallet_mismatch"],
    [snapshot([TRADE_ONE], { order: { id: OTHER_ORDER_ID } }), "trade_order_mismatch"],
    [snapshot([TRADE_ONE], { order: { market: OTHER_CONDITION_ID } }), "trade_market_mismatch"],
    [snapshot([TRADE_ONE], { order: { assetId: "987654321" } }), "trade_token_mismatch"],
    [snapshot([TRADE_ONE], { order: { side: "BUY" } }), "trade_side_mismatch"],
    [snapshot([TRADE_ONE, TRADE_ONE]), "duplicate_associated_trade"],
  ];
  for (const [exactOrderSnapshot, code] of cases) {
    await assert.rejects(
      fetchExactAssociatedTradeContributions(argumentsFor({
        exactOrderSnapshot,
        fetchImpl: async () => response([takerTrade()]),
      })),
      (error) => error?.code === code,
    );
  }
});

test("rejects missing, duplicate, substituted, or incomplete exact-trade responses", async () => {
  const cases = [
    [[], "trade_not_found"],
    [[takerTrade(), takerTrade()], "ambiguous_trade_response"],
    [[takerTrade(TRADE_TWO)], "trade_identity_mismatch"],
    [{ count: 1, limit: 100, data: [takerTrade()], next_cursor: "MTAw" }, "incomplete_trade_response"],
    [{ count: 2, limit: 100, data: [takerTrade()], next_cursor: "LTE=" }, "invalid_trade_response"],
    [{ count: 1, limit: 100, data: [takerTrade(), takerTrade()], next_cursor: "LTE=" }, "invalid_trade_response"],
  ];
  for (const [body, code] of cases) {
    await assert.rejects(
      fetchExactAssociatedTradeContributions(argumentsFor({ fetchImpl: async () => response(body) })),
      (error) => error?.code === code,
    );
  }
});

test("rejects top-level trade identity, custody, confirmation, and value substitutions", async () => {
  const cases = [
    [{ market: OTHER_CONDITION_ID }, "trade_market_mismatch"],
    [{ asset_id: "987654321" }, "trade_token_mismatch"],
    [{ owner: "another-api-key" }, "trade_wallet_mismatch"],
    [{ maker_address: OTHER_WALLET }, "trade_wallet_mismatch"],
    [{ status: "MATCHED" }, "trade_not_confirmed"],
    [{ transaction_hash: "0xdead" }, "invalid_trade_identity"],
    [{ side: "BUY" }, "trade_side_mismatch"],
    [{ size: "0" }, "invalid_trade_amount"],
    [{ price: "1.01" }, "invalid_trade_price"],
    [{ trader_side: "MAKER" }, "trade_role_mismatch"],
  ];
  for (const [mutation, code] of cases) {
    await assert.rejects(
      fetchExactAssociatedTradeContributions(argumentsFor({
        fetchImpl: async () => response([takerTrade(TRADE_ONE, mutation)]),
      })),
      (error) => error?.code === code,
    );
  }
});

test("rejects missing, ambiguous, or substituted maker attribution", async () => {
  const ambiguous = makerTrade();
  ambiguous.maker_orders.push({ ...ambiguous.maker_orders[0] });
  const bothRoles = makerTrade(TRADE_ONE, {}, { taker_order_id: ORDER_ID });
  const absent = makerTrade(TRADE_ONE, { order_id: `0x${"9".repeat(64)}` });
  for (const [trade, code] of [
    [ambiguous, "ambiguous_trade_attribution"],
    [bothRoles, "ambiguous_trade_attribution"],
    [absent, "ambiguous_trade_attribution"],
  ]) {
    await assert.rejects(
      fetchExactAssociatedTradeContributions(argumentsFor({ fetchImpl: async () => response([trade]) })),
      (error) => error?.code === code,
    );
  }

  const cases = [
    [{ owner: "another-api-key" }, "trade_wallet_mismatch"],
    [{ maker_address: OTHER_WALLET }, "trade_wallet_mismatch"],
    [{ asset_id: "987654321" }, "trade_token_mismatch"],
    [{ side: "BUY" }, "trade_side_mismatch"],
    [{ matched_amount: "0" }, "invalid_trade_amount"],
    [{ price: "1.01" }, "invalid_trade_price"],
  ];
  for (const [mutation, code] of cases) {
    await assert.rejects(
      fetchExactAssociatedTradeContributions(argumentsFor({
        fetchImpl: async () => response([makerTrade(TRADE_ONE, mutation)]),
      })),
      (error) => error?.code === code,
    );
  }
});

test("rejects non-canonical origins, changed credential identity, and unavailable trades", async () => {
  await assert.rejects(
    fetchExactAssociatedTradeContributions(argumentsFor({
      origin: "https://example.com",
      fetchImpl: async () => response([takerTrade()]),
    })),
    (error) => error?.code === "invalid_trade_origin",
  );
  await assert.rejects(
    fetchExactAssociatedTradeContributions(argumentsFor({
      credentials: { ...CREDS, depositWallet: OTHER_WALLET },
      fetchImpl: async () => response([takerTrade()]),
    })),
    (error) => error?.code === "trade_wallet_mismatch",
  );
  await assert.rejects(
    fetchExactAssociatedTradeContributions(argumentsFor({
      fetchImpl: async () => response({ error: "not found" }, false, 404),
    })),
    (error) => error?.code === "trade_not_found" && error?.details?.status === 404,
  );
  await assert.rejects(
    fetchExactAssociatedTradeContributions(argumentsFor({
      fetchImpl: async () => { throw new Error("offline"); },
    })),
    (error) => error?.code === "trade_unavailable",
  );
});
