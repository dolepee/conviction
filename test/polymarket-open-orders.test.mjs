import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  fetchAllOpenOrders,
  fetchExactOrder,
  loadDepositWalletCredentials,
} from "../src/polymarket-open-orders.mjs";

const SIGNER = "0x1111111111111111111111111111111111111111";
const DEPOSIT = "0x2222222222222222222222222222222222222222";
const TOKEN = "123456789";
const ORDER_ID = `0x${"a".repeat(64)}`;
const CREDS = Object.freeze({
  signerAddress: SIGNER,
  depositWallet: DEPOSIT,
  apiKey: "key",
  secret: Buffer.from("secret").toString("base64url"),
  passphrase: "pass",
});

function response(body, ok = true, status = 200) {
  return { ok, status, json: async () => body };
}

function exactOrder(overrides = {}) {
  return {
    id: ORDER_ID,
    status: "ORDER_STATUS_LIVE",
    market: `0x${"b".repeat(64)}`,
    asset_id: TOKEN,
    side: "SELL",
    original_size: "10000000",
    size_matched: "0",
    price: "0.2",
    order_type: "GTD",
    expiration: "1800003600",
    outcome: "Yes",
    created_at: "1800000000",
    owner: CREDS.apiKey,
    maker_address: DEPOSIT,
    associate_trades: [],
    ...overrides,
  };
}

test("complete open-order client follows every opaque cursor and pins the selected token", async () => {
  const calls = [];
  const pages = [
    {
      count: 1,
      limit: 500,
      data: [{ id: "first", status: "ORDER_STATUS_LIVE", asset_id: TOKEN, owner: CREDS.apiKey, maker_address: DEPOSIT, original_size: "10000000", size_matched: "0" }],
      next_cursor: "MTAw",
    },
    {
      count: 1,
      limit: 500,
      data: [{ id: "second", status: "ORDER_STATUS_LIVE", asset_id: TOKEN, owner: CREDS.apiKey, maker_address: DEPOSIT, original_size: "10000000", size_matched: "4000000" }],
      next_cursor: "LTE=",
    },
  ];
  const result = await fetchAllOpenOrders({
    signerAddress: SIGNER,
    depositWallet: DEPOSIT,
    outcomeTokenId: TOKEN,
    credentials: CREDS,
    now: () => 1_800_000_000_000,
    fetchImpl: async (url, init) => {
      calls.push({ url: new URL(url), init });
      return response(pages.shift());
    },
  });

  assert.equal(result.complete, true);
  assert.equal(result.pageCount, 2);
  assert.deepEqual(result.orders.map(({ id }) => id), ["first", "second"]);
  assert.equal(calls[0].url.searchParams.get("asset_id"), TOKEN);
  assert.equal(calls[0].url.searchParams.has("status"), false);
  assert.equal(calls[0].url.searchParams.has("next_cursor"), false);
  assert.equal(calls[1].url.searchParams.get("next_cursor"), "MTAw");
  assert.equal(calls[0].init.headers.POLY_ADDRESS, SIGNER);
  assert.match(calls[0].init.headers.POLY_SIGNATURE, /^[A-Za-z0-9_-]+=*$/);
  assert.equal(calls[0].init.redirect, "error");
});

test("complete open-order client fails closed on missing, repeated, or invalid pagination", async () => {
  for (const body of [
    { count: 0, limit: 500, data: [] },
    { count: 0, limit: 500, data: null, next_cursor: "" },
    { count: 1, limit: 500, data: [], next_cursor: "" },
  ]) {
    await assert.rejects(
      fetchAllOpenOrders({
        signerAddress: SIGNER,
        depositWallet: DEPOSIT,
        outcomeTokenId: TOKEN,
        credentials: CREDS,
        fetchImpl: async () => response(body),
      }),
      (error) => ["incomplete_open_orders", "open_orders_unavailable"].includes(error?.code),
    );
  }

  let calls = 0;
  await assert.rejects(
    fetchAllOpenOrders({
      signerAddress: SIGNER,
      depositWallet: DEPOSIT,
      outcomeTokenId: TOKEN,
      credentials: CREDS,
      fetchImpl: async () => {
        calls += 1;
        return response({ count: 0, limit: 500, data: [], next_cursor: "same" });
      },
    }),
    (error) => error?.code === "incomplete_open_orders" && calls === 2,
  );

  await assert.rejects(
    fetchAllOpenOrders({
      signerAddress: SIGNER,
      depositWallet: DEPOSIT,
      outcomeTokenId: TOKEN,
      credentials: CREDS,
      fetchImpl: async () => response({
        count: 1,
        limit: 500,
        data: [{ id: "wrong-token", asset_id: "987654321", owner: CREDS.apiKey, maker_address: DEPOSIT }],
        next_cursor: "",
      }),
    }),
    (error) => error?.code === "open_orders_token_mismatch",
  );

  for (const order of [
    { id: "wrong-owner", asset_id: TOKEN, owner: "another-key", maker_address: DEPOSIT },
    { id: "wrong-maker", asset_id: TOKEN, owner: CREDS.apiKey, maker_address: "0x3333333333333333333333333333333333333333" },
  ]) {
    await assert.rejects(
      fetchAllOpenOrders({
        signerAddress: SIGNER,
        depositWallet: DEPOSIT,
        outcomeTokenId: TOKEN,
        credentials: CREDS,
        fetchImpl: async () => response({ count: 1, limit: 500, data: [order], next_cursor: "" }),
      }),
      (error) => error?.code === "open_orders_wallet_mismatch",
    );
  }

  let duplicatePage = 0;
  await assert.rejects(
    fetchAllOpenOrders({
      signerAddress: SIGNER,
      depositWallet: DEPOSIT,
      outcomeTokenId: TOKEN,
      credentials: CREDS,
      fetchImpl: async () => {
        duplicatePage += 1;
        return response({
          count: 1,
          limit: 500,
          data: [{ id: "duplicate", status: "ORDER_STATUS_LIVE", asset_id: TOKEN, owner: CREDS.apiKey, maker_address: DEPOSIT, original_size: "10000000", size_matched: "0" }],
          next_cursor: duplicatePage === 1 ? "MTAw" : "",
        });
      },
    }),
    (error) => error?.code === "incomplete_open_orders" && duplicatePage === 2,
  );
});

test("exact-order client authenticates one canonical order without returning credentials", async () => {
  let request;
  const result = await fetchExactOrder({
    signerAddress: SIGNER,
    depositWallet: DEPOSIT,
    orderId: ORDER_ID,
    outcomeTokenId: TOKEN,
    credentials: CREDS,
    now: () => 1_800_000_000_000,
    fetchImpl: async (url, init) => {
      request = { url, init };
      return response(exactOrder());
    },
  });
  assert.equal(request.url, `https://clob.polymarket.com/data/order/${ORDER_ID}`);
  assert.equal(request.init.method, "GET");
  assert.equal(request.init.redirect, "error");
  assert.equal(request.init.headers.POLY_ADDRESS, SIGNER);
  assert.match(request.init.headers.POLY_SIGNATURE, /^[A-Za-z0-9_-]+=*$/);
  assert.equal(result.verificationSource, "authenticated-polymarket-clob");
  assert.equal(result.onChain, false);
  assert.equal(result.credentialOwnerVerified, true);
  assert.equal(result.order.id, ORDER_ID);
  assert.equal(result.order.orderType, "GTD");
  assert.equal(result.order.status, "LIVE");
  assert.equal(result.order.originalSize, "10000000");
  assert.equal(result.order.sizeMatched, "0");
  assert.equal(JSON.stringify(result).includes(CREDS.apiKey), false);
  assert.equal(JSON.stringify(result).includes(CREDS.secret), false);
  assert.equal(JSON.stringify(result).includes(CREDS.passphrase), false);
});

test("exact-order client canonicalizes a market-resolved cancellation", async () => {
  const result = await fetchExactOrder({
    signerAddress: SIGNER,
    depositWallet: DEPOSIT,
    orderId: ORDER_ID,
    outcomeTokenId: TOKEN,
    credentials: CREDS,
    now: () => 1_800_000_000_000,
    fetchImpl: async () => response(exactOrder({
      status: "ORDER_STATUS_CANCELED_MARKET_RESOLVED",
    })),
  });

  assert.equal(result.order.status, "CANCELED");
  assert.equal(result.order.sizeMatched, "0");
});

test("exact-order client fails closed on missing or substituted identity", async () => {
  await assert.rejects(
    fetchExactOrder({
      signerAddress: SIGNER,
      depositWallet: DEPOSIT,
      orderId: ORDER_ID,
      outcomeTokenId: TOKEN,
      credentials: CREDS,
      fetchImpl: async () => response({ error: "not found" }, false, 404),
    }),
    (error) => error?.code === "order_not_found",
  );
  for (const [mutation, code] of [
    [{ id: `0x${"c".repeat(64)}` }, "order_identity_mismatch"],
    [{ asset_id: "987654321" }, "order_token_mismatch"],
    [{ owner: "another-key" }, "order_wallet_mismatch"],
    [{ maker_address: "0x3333333333333333333333333333333333333333" }, "order_wallet_mismatch"],
    [{ associate_trades: null }, "invalid_order_response"],
  ]) {
    await assert.rejects(
      fetchExactOrder({
        signerAddress: SIGNER,
        depositWallet: DEPOSIT,
        orderId: ORDER_ID,
        outcomeTokenId: TOKEN,
        credentials: CREDS,
        fetchImpl: async () => response(exactOrder(mutation)),
      }),
      (error) => error?.code === code,
    );
  }
});

test("order clients accept only canonical atomic share quantities", async () => {
  for (const mutation of [
    { original_size: 10_000_000 },
    { original_size: "10.0" },
    { original_size: "010000000" },
    { original_size: " 10000000" },
    { original_size: "1e7" },
    { original_size: "0" },
    { size_matched: "10000001" },
    { size_matched: "0.0" },
  ]) {
    await assert.rejects(
      fetchExactOrder({
        signerAddress: SIGNER,
        depositWallet: DEPOSIT,
        orderId: ORDER_ID,
        outcomeTokenId: TOKEN,
        credentials: CREDS,
        fetchImpl: async () => response(exactOrder(mutation)),
      }),
      (error) => error?.code === "invalid_order_response",
    );
  }

  await assert.rejects(
    fetchAllOpenOrders({
      signerAddress: SIGNER,
      depositWallet: DEPOSIT,
      outcomeTokenId: TOKEN,
      credentials: CREDS,
      fetchImpl: async () => response({
        count: 1,
        limit: 500,
        data: [{
          id: "ambiguous-size",
          status: "ORDER_STATUS_LIVE",
          asset_id: TOKEN,
          owner: CREDS.apiKey,
          maker_address: DEPOSIT,
          original_size: "10.0",
          size_matched: "0",
        }],
        next_cursor: "",
      }),
    }),
    (error) => error?.code === "invalid_open_orders_quantity",
  );
});

test("credential loader binds an owner-only v2 entry to the selected deposit wallet", async () => {
  const directory = await mkdtemp(join(tmpdir(), "conviction-poly-creds-"));
  const credentialsPath = join(directory, "creds.json");
  try {
    await writeFile(credentialsPath, JSON.stringify({
      _version: 2,
      [SIGNER]: {
        api_key: CREDS.apiKey,
        secret: CREDS.secret,
        passphrase: CREDS.passphrase,
        mode: "deposit_wallet",
        deposit_wallet: DEPOSIT,
      },
    }));
    await chmod(credentialsPath, 0o600);
    const loaded = await loadDepositWalletCredentials({
      signerAddress: SIGNER,
      depositWallet: DEPOSIT,
      credentialsPath,
    });
    assert.equal(loaded.signerAddress, SIGNER);
    assert.equal(loaded.depositWallet, DEPOSIT);

    await assert.rejects(
      loadDepositWalletCredentials({
        signerAddress: SIGNER,
        depositWallet: "0x3333333333333333333333333333333333333333",
        credentialsPath,
      }),
      (error) => error?.code === "open_orders_wallet_mismatch",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
