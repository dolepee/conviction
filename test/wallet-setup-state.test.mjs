import assert from "node:assert/strict";
import test from "node:test";

import {
  createInMemoryWalletSetupState,
  createRedisWalletSetupState,
  WalletSetupStateError,
} from "../src/wallet-setup-state.mjs";

test("in-memory wallet state makes one-time claims atomic and expires state", async () => {
  let now = 1_000;
  const state = createInMemoryWalletSetupState({ now: () => now });
  assert.equal(await state.claimOnce("challenge", "abc", 10), true);
  assert.equal(await state.claimOnce("challenge", "abc", 10), false);
  await state.put("wallet", "session-1", { wallet: "0xabc" }, 10);
  assert.deepEqual(await state.get("wallet", "session-1"), { wallet: "0xabc" });
  now += 10_001;
  assert.equal(await state.get("wallet", "session-1"), null);
  assert.equal(await state.claimOnce("challenge", "abc", 10), true);
});

test("Redis-compatible wallet state uses SET NX EX for one-time consent claims", async () => {
  const calls = [];
  const state = createRedisWalletSetupState({
    url: "https://state.example.com",
    token: "token-that-is-at-least-sixteen-bytes",
    fetchImpl: async (_url, options) => {
      calls.push(JSON.parse(options.body));
      return {
        ok: true,
        headers: { get: () => null },
        json: async () => ({ result: "OK" }),
      };
    },
  });
  assert.equal(await state.claimOnce("deployment-consent", "abc", 60), true);
  await state.put("wallet", "session-1", { wallet: "0xabc" }, 60);
  assert.deepEqual(calls[0].slice(-3), ["NX", "EX", "60"]);
  assert.deepEqual(calls[1].slice(-2), ["EX", "60"]);
});

test("wallet state rejects non-HTTPS configuration and malformed state keys", async () => {
  assert.throws(
    () => createRedisWalletSetupState({ url: "http://state.example.com", token: "token-that-is-at-least-sixteen-bytes" }),
    (error) => error instanceof WalletSetupStateError && error.code === "wallet_setup_state_unavailable",
  );
  const state = createInMemoryWalletSetupState();
  await assert.rejects(
    state.claimOnce("bad/name", "abc", 60),
    (error) => error instanceof WalletSetupStateError && error.code === "invalid_wallet_setup_state",
  );
});
