import assert from "node:assert/strict";
import test from "node:test";

import { compileIntent } from "../src/intent-compiler.mjs";
import {
  requirePaidOpenExecutionMode,
  verifyDepositWalletExecution,
  verifyDepositWalletReadiness,
  verifyOpenPluginPreview,
} from "../src/open-execution-preflight.mjs";
import { LIVE_MARKET_SNAPSHOT } from "./fixtures.mjs";

const WALLET = "0x6a355e4971d9ac2ab97d22c3cf361d42faba33fe";
const OWNER = "0x1111111111111111111111111111111111111111";
const NOW = Date.parse("2026-07-21T02:00:10.000Z");

function compilation() {
  return compileIntent({
    market: LIVE_MARKET_SNAPSHOT.slug,
    outcome: "yes",
    spend: "1.35",
    maxPrice: "0.27",
    wallet: WALLET,
    executionMode: "deposit-wallet",
  }, LIVE_MARKET_SNAPSHOT, {
    now: NOW,
    quoteTtlMs: 300_000,
    intentVersion: "conviction-intent-v4",
  });
}

function pluginPreview() {
  return {
    ok: true,
    dry_run: true,
    data: {
      clob_version: "V2",
      collateral_token: "0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB",
      condition_id: LIVE_MARKET_SNAPSHOT.conditionId,
      exchange_address: "0xE111180000d2663C0091e4f400237545B87B996B",
      expires: null,
      fee_rate_bps: 0,
      limit_price: "0.27",
      neg_risk: false,
      note: "dry-run: order not submitted",
      order_type: "FAK",
      outcome: "yes",
      post_only: false,
      shares: "5",
      side: "BUY",
      token_id: LIVE_MARKET_SNAPSHOT.yesTokenId,
      usdc_amount: "1.35",
      usdc_requested: "1.35",
    },
  };
}

function walletReadiness() {
  return {
    ok: true,
    accessible: true,
    status: "deposit_wallet_ready",
    wallet: {
      eoa: OWNER,
      deposit_wallet: WALLET,
    },
  };
}

test("paid OPEN accepts only the already-ready deposit-wallet mode", () => {
  assert.doesNotThrow(() => requirePaidOpenExecutionMode({ executionMode: "deposit-wallet" }));
  for (const executionMode of [undefined, "", "eoa", "proxy"]) {
    assert.throws(
      () => requirePaidOpenExecutionMode({ executionMode }),
      (error) =>
        error?.code === "maker_not_eligible" &&
        error?.details?.paymentAllowed === false &&
        error?.details?.nextAction === "USE_READY_DEPOSIT_WALLET_OR_STOP",
    );
  }
});

test("official plugin dry run must match every execution-critical OPEN field", () => {
  const card = compilation();
  const result = verifyOpenPluginPreview(card, pluginPreview(), { verifiedWallet: WALLET });
  assert.equal(result.ok, true);
  assert.equal(result.wallet, WALLET);
  assert.equal(result.tokenId, LIVE_MARKET_SNAPSHOT.yesTokenId);
  assert.equal(result.principalRaw, "1350000");

  const mutations = [
    ["token", (value) => { value.data.token_id = LIVE_MARKET_SNAPSHOT.noTokenId; }],
    ["principal", (value) => { value.data.usdc_amount = "1.34"; }],
    ["shares", (value) => { value.data.shares = "4"; }],
    ["price", (value) => { value.data.limit_price = "0.26"; }],
    ["type", (value) => { value.data.order_type = "GTC"; }],
    ["dry run", (value) => { value.dry_run = false; }],
  ];
  for (const [label, mutate] of mutations) {
    const value = structuredClone(pluginPreview());
    mutate(value);
    assert.throws(
      () => verifyOpenPluginPreview(card, value, { verifiedWallet: WALLET }),
      (error) => ["plugin_preview_mismatch", "invalid_plugin_preview"].includes(error?.code),
      label,
    );
  }
});

test("official quickstart binds the exact ready deposit wallet before payment", () => {
  const result = verifyDepositWalletReadiness(WALLET, walletReadiness());
  assert.equal(result.wallet, WALLET);
  assert.equal(result.status, "deposit_wallet_ready");

  for (const mutate of [
    (value) => { value.wallet.deposit_wallet = "0x2222222222222222222222222222222222222222"; },
    (value) => { value.status = "needs_deposit_wallet_setup"; },
    (value) => { value.accessible = false; },
    (value) => { value.ok = false; },
  ]) {
    const value = structuredClone(walletReadiness());
    mutate(value);
    assert.throws(
      () => verifyDepositWalletReadiness(WALLET, value),
      (error) => ["maker_not_eligible", "missing_wallet_readiness"].includes(error?.code),
    );
  }
});

test("maker check rejects EOAs and accepts a Polygon contract wallet", async () => {
  const calls = [];
  const fetchImpl = async (_url, options) => {
    const request = JSON.parse(options.body);
    calls.push(request.method);
    return {
      ok: true,
      async json() {
        return {
          jsonrpc: "2.0",
          id: 1,
          result:
            request.method === "eth_chainId"
              ? "0x89"
              : request.method === "eth_getCode"
                ? "0x6001600055"
                : request.params[0].data.startsWith("0x1f264778")
                  ? `0x${WALLET.slice(2).padStart(64, "0")}`
                  : `0x${"2".repeat(40).padStart(64, "0")}`,
        };
      },
    };
  };
  const ready = await verifyDepositWalletExecution(WALLET, {
    owner: OWNER,
    rpcUrl: "https://polygon.test",
    fetchImpl,
  });
  assert.equal(ready.contractCodePresent, true);
  assert.equal(ready.factoryPredictionMatched, true);
  assert.equal(ready.factoryPredictionKind, "beacon");
  assert.deepEqual(calls.sort(), ["eth_call", "eth_call", "eth_chainId", "eth_getCode"]);

  const legacyReady = await verifyDepositWalletExecution(WALLET, {
    owner: OWNER,
    rpcUrl: "https://polygon.test",
    fetchImpl: async (_url, options) => {
      const request = JSON.parse(options.body);
      return {
        ok: true,
        async json() {
          return {
            jsonrpc: "2.0",
            id: 1,
            result:
              request.method === "eth_chainId"
                ? "0x89"
                : request.method === "eth_getCode"
                  ? "0x6001600055"
                  : request.params[0].data.startsWith("0x8becfd88")
                    ? `0x${WALLET.slice(2).padStart(64, "0")}`
                    : `0x${"2".repeat(40).padStart(64, "0")}`,
          };
        },
      };
    },
  });
  assert.equal(legacyReady.factoryPredictionKind, "legacy-uups");

  await assert.rejects(
    verifyDepositWalletExecution(WALLET, {
      owner: OWNER,
      rpcUrl: "https://polygon.test",
      fetchImpl: async (_url, options) => {
        const request = JSON.parse(options.body);
        return {
          ok: true,
          async json() {
            return {
              jsonrpc: "2.0",
              id: 1,
              result:
                request.method === "eth_chainId"
                  ? "0x89"
                  : request.method === "eth_getCode"
                    ? "0x"
                    : `0x${WALLET.slice(2).padStart(64, "0")}`,
            };
          },
        };
      },
    }),
    (error) =>
      error?.code === "maker_not_eligible" &&
      error?.details?.paymentAllowed === false,
  );

  await assert.rejects(
    verifyDepositWalletExecution(WALLET, {
      owner: OWNER,
      rpcUrl: "https://polygon.test",
      fetchImpl: async (_url, options) => {
        const request = JSON.parse(options.body);
        return {
          ok: true,
          async json() {
            return {
              jsonrpc: "2.0",
              id: 1,
              result:
                request.method === "eth_chainId"
                  ? "0x89"
                  : request.method === "eth_getCode"
                    ? "0x6001600055"
                    : `0x${"2".repeat(40).padStart(64, "0")}`,
            };
          },
        };
      },
    }),
    (error) => error?.code === "maker_not_eligible",
  );
});
