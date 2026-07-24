import assert from "node:assert/strict";
import test from "node:test";

import {
  DEPOSIT_WALLET_FACTORY,
} from "../src/polymarket-builder-guard.mjs";
import {
  createPolymarketRelayerProxy,
  POLYMARKET_RELAYER_ORIGIN,
} from "../src/polymarket-relayer-proxy.mjs";

const WALLET = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const CREDENTIALS = {
  key: "builder-key",
  secret: Buffer.from("builder-secret").toString("base64"),
  passphrase: "builder-passphrase",
};

function jsonResponse(body, { status = 200 } = {}) {
  const bytes = new TextEncoder().encode(JSON.stringify(body));
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name) => name === "content-length" ? String(bytes.length) : null },
    arrayBuffer: async () => bytes.buffer,
  };
}

test("relayer proxy fixes the origin and scopes nonce to the session wallet", async () => {
  const calls = [];
  const proxy = createPolymarketRelayerProxy({
    credentials: CREDENTIALS,
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return jsonResponse({ nonce: "7" });
    },
    nowSeconds: () => 1_000,
  });
  const result = await proxy.run({
    operation: "nonce",
    session: { wallet: WALLET },
    body: {},
  });
  assert.equal(result.relayer.nonce, "7");
  assert.equal(
    calls[0].url,
    `${POLYMARKET_RELAYER_ORIGIN}/nonce?address=${WALLET}&type=WALLET`,
  );
  assert.equal(calls[0].options.redirect, "error");
  assert.throws(
    () => createPolymarketRelayerProxy({
      credentials: CREDENTIALS,
      origin: "https://attacker.invalid",
    }),
    /origin is immutable/,
  );
});

test("relayer proxy forwards only a validated wallet-create body with body-bound headers", async () => {
  const calls = [];
  const proxy = createPolymarketRelayerProxy({
    credentials: CREDENTIALS,
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return jsonResponse({ transactionID: "tx-1", state: "STATE_NEW" });
    },
    nowSeconds: () => 1_000,
  });
  const request = JSON.stringify({
    type: "WALLET-CREATE",
    from: WALLET,
    to: DEPOSIT_WALLET_FACTORY,
  });
  const result = await proxy.run({
    operation: "submit",
    session: { wallet: WALLET },
    body: { request },
  });
  assert.equal(result.action, "DEPLOY_DEPOSIT_WALLET");
  assert.equal(calls[0].url, `${POLYMARKET_RELAYER_ORIGIN}/submit`);
  assert.equal(calls[0].options.body, request);
  assert.equal(calls[0].options.headers.POLY_BUILDER_API_KEY, CREDENTIALS.key);
  assert.equal(calls[0].options.headers.POLY_BUILDER_TIMESTAMP, "1000");
  assert.match(calls[0].options.headers.POLY_BUILDER_SIGNATURE, /^[A-Za-z0-9_-]+=*$/);
});

test("relayer proxy polls only the exact transaction record from the fixed origin", async () => {
  const calls = [];
  const proxy = createPolymarketRelayerProxy({
    credentials: CREDENTIALS,
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return jsonResponse([
        { transactionID: "another-transaction", state: "STATE_CONFIRMED" },
        {
          transactionID: "tx-1",
          state: "STATE_CONFIRMED",
          transactionHash: `0x${"1".repeat(64)}`,
          from: WALLET,
          to: DEPOSIT_WALLET_FACTORY,
          proxyAddress: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
          type: "WALLET-CREATE",
        },
      ]);
    },
  });
  const result = await proxy.run({
    operation: "transaction",
    session: { wallet: WALLET },
    body: { transactionId: "tx-1" },
  });
  assert.equal(result.relayer.transactionId, "tx-1");
  assert.equal(result.relayer.state, "STATE_CONFIRMED");
  assert.equal(result.relayer.transactionHash, `0x${"1".repeat(64)}`);
  assert.equal(calls[0].url, `${POLYMARKET_RELAYER_ORIGIN}/transaction?id=tx-1`);
  assert.equal(calls[0].options.method, undefined);
});

test("relayer proxy rejects arbitrary operations and noncanonical bodies before fetch", async () => {
  let fetched = false;
  const proxy = createPolymarketRelayerProxy({
    credentials: CREDENTIALS,
    fetchImpl: async () => {
      fetched = true;
      return jsonResponse({});
    },
  });
  await assert.rejects(
    proxy.run({ operation: "url", session: { wallet: WALLET }, body: { url: "https://attacker.invalid" } }),
    (error) => error.code === "unsupported_relayer_operation",
  );
  await assert.rejects(
    proxy.run({ operation: "transaction", session: { wallet: WALLET }, body: { transactionId: "../other" } }),
    (error) => error.code === "invalid_relayer_response",
  );
  await assert.rejects(
    proxy.run({
      operation: "submit",
      session: { wallet: WALLET },
      body: {
        request: JSON.stringify({
          type: "WALLET-CREATE",
          from: WALLET,
          to: DEPOSIT_WALLET_FACTORY,
        }, null, 2),
      },
    }),
    (error) => error.code === "noncanonical_builder_body",
  );
  assert.equal(fetched, false);
});
