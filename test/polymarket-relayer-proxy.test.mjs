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
const OTHER_WALLET = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const CREDENTIALS = {
  key: "builder-key",
  secret: Buffer.from("builder-secret").toString("base64"),
  passphrase: "builder-passphrase",
};
const RELAYER_CREDENTIALS = {
  key: "relayer-key",
  address: WALLET,
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
  assert.equal(calls[0].options.headers, undefined);
  assert.throws(
    () => createPolymarketRelayerProxy({
      credentials: CREDENTIALS,
      origin: "https://attacker.invalid",
    }),
    /origin is immutable/,
  );
});

test("matching-account nonce fetch uses the dedicated Relayer API key", async () => {
  const calls = [];
  const proxy = createPolymarketRelayerProxy({
    credentials: CREDENTIALS,
    relayerCredentials: RELAYER_CREDENTIALS,
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return jsonResponse({ nonce: "9" });
    },
  });
  await proxy.run({
    operation: "nonce",
    session: { wallet: WALLET },
    body: {},
  });
  assert.equal(calls[0].options.headers.RELAYER_API_KEY, RELAYER_CREDENTIALS.key);
  assert.equal(calls[0].options.headers.RELAYER_API_KEY_ADDRESS, RELAYER_CREDENTIALS.address);
});

test("builder authentication is a read-only signed probe with no relayer payload returned", async () => {
  const calls = [];
  const proxy = createPolymarketRelayerProxy({
    credentials: CREDENTIALS,
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return jsonResponse([]);
    },
    nowSeconds: () => 1_000,
  });
  const result = await proxy.run({ operation: "builder-auth", session: { wallet: WALLET }, body: {} });
  assert.deepEqual(result, { ok: true, operation: "builder-auth", authentication: "builder" });
  assert.equal(calls[0].url, `${POLYMARKET_RELAYER_ORIGIN}/transactions`);
  assert.equal(calls[0].options.headers.POLY_BUILDER_API_KEY, CREDENTIALS.key);
  assert.equal(calls[0].options.headers.POLY_BUILDER_TIMESTAMP, "1000");
  assert.equal(calls[0].options.headers.RELAYER_API_KEY, undefined);
});

test("builder authentication fails closed before new-buyer setup when credentials are rejected", async () => {
  const proxy = createPolymarketRelayerProxy({
    credentials: CREDENTIALS,
    fetchImpl: async () => jsonResponse({ error: "invalid authorization" }, { status: 401 }),
  });
  await assert.rejects(
    proxy.run({ operation: "builder-auth", session: { wallet: WALLET }, body: {} }),
    (error) => error.code === "builder_auth_unavailable" && error.status === 503,
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

test("wallet creation remains Builder-authenticated when a Relayer API key is configured", async () => {
  const calls = [];
  const proxy = createPolymarketRelayerProxy({
    credentials: CREDENTIALS,
    relayerCredentials: RELAYER_CREDENTIALS,
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return jsonResponse({ transactionID: "tx-relayer", state: "STATE_NEW" });
    },
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
  assert.equal(calls[0].options.headers.POLY_BUILDER_API_KEY, CREDENTIALS.key);
  assert.equal(calls[0].options.headers.RELAYER_API_KEY, undefined);
});

test("matching-account wallet operations may use the dedicated Relayer API key", async () => {
  const calls = [];
  const proxy = createPolymarketRelayerProxy({
    credentials: CREDENTIALS,
    relayerCredentials: RELAYER_CREDENTIALS,
    validate: async () => ({ action: "APPROVE_DEPOSIT_WALLET" }),
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return jsonResponse({ transactionID: "tx-relayer", state: "STATE_NEW" });
    },
  });
  const request = JSON.stringify({ type: "WALLET" });
  await proxy.run({
    operation: "submit",
    session: { wallet: WALLET },
    body: { request },
  });
  assert.equal(calls[0].options.headers.RELAYER_API_KEY, RELAYER_CREDENTIALS.key);
  assert.equal(calls[0].options.headers.RELAYER_API_KEY_ADDRESS, RELAYER_CREDENTIALS.address);
  assert.equal(calls[0].options.headers.POLY_BUILDER_API_KEY, undefined);
});

test("a foreign buyer operation never uses another account's Relayer API key", async () => {
  const calls = [];
  const proxy = createPolymarketRelayerProxy({
    credentials: CREDENTIALS,
    relayerCredentials: RELAYER_CREDENTIALS,
    validate: async () => ({ action: "APPROVE_DEPOSIT_WALLET" }),
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return jsonResponse({ transactionID: "tx-builder", state: "STATE_NEW" });
    },
  });
  await proxy.run({
    operation: "submit",
    session: { wallet: OTHER_WALLET },
    body: { request: JSON.stringify({ type: "WALLET" }) },
  });
  assert.equal(calls[0].options.headers.POLY_BUILDER_API_KEY, CREDENTIALS.key);
  assert.equal(calls[0].options.headers.RELAYER_API_KEY, undefined);
});

test("a Relayer key alone cannot create a wallet for a new buyer", async () => {
  let fetched = false;
  const proxy = createPolymarketRelayerProxy({
    relayerCredentials: RELAYER_CREDENTIALS,
    fetchImpl: async () => {
      fetched = true;
      return jsonResponse({});
    },
  });
  const request = JSON.stringify({
    type: "WALLET-CREATE",
    from: WALLET,
    to: DEPOSIT_WALLET_FACTORY,
  });
  await assert.rejects(
    proxy.run({
      operation: "submit",
      session: { wallet: WALLET },
      body: { request },
    }),
    (error) => error.code === "builder_auth_required",
  );
  assert.equal(fetched, false);
});

test("relayer proxy rejects malformed or missing authentication", () => {
  assert.throws(
    () => createPolymarketRelayerProxy({ relayerCredentials: { key: "", address: WALLET } }),
    /invalid relayer credentials/,
  );
  assert.throws(
    () => createPolymarketRelayerProxy({ relayerCredentials: { key: "key", address: "0x1234" } }),
    /invalid relayer credentials/,
  );
  assert.throws(
    () => createPolymarketRelayerProxy(),
    /relayer authentication is required/,
  );
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
