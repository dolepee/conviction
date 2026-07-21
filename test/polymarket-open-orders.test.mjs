import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  fetchAllOpenOrders,
  loadDepositWalletCredentials,
} from "../src/polymarket-open-orders.mjs";

const SIGNER = "0x1111111111111111111111111111111111111111";
const DEPOSIT = "0x2222222222222222222222222222222222222222";
const TOKEN = "123456789";
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

test("complete open-order client follows every opaque cursor and pins the selected token", async () => {
  const calls = [];
  const pages = [
    {
      count: 1,
      limit: 500,
      data: [{ id: "first", status: "ORDER_STATUS_LIVE", asset_id: TOKEN, owner: CREDS.apiKey, maker_address: DEPOSIT }],
      next_cursor: "MTAw",
    },
    {
      count: 1,
      limit: 500,
      data: [{ id: "second", status: "ORDER_STATUS_LIVE", asset_id: TOKEN, owner: CREDS.apiKey, maker_address: DEPOSIT }],
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
