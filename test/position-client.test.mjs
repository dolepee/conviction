import assert from "node:assert/strict";
import test from "node:test";

import { CONTRACTS } from "../src/constants.mjs";
import { ConvictionError } from "../src/errors.mjs";
import { fetchPositionSnapshot } from "../src/position-client.mjs";

const WALLET = "0x6a355e4971d9ac2ab97d22c3cf361d42faba33fe";
const TOKEN_ID = "55115078421062885512539156303747803058407616201213034911037320915726138659123";

function rpcFetch(values, calls) {
  return async (_url, options) => {
    const request = JSON.parse(options.body);
    calls.push(request);
    return {
      ok: true,
      status: 200,
      async json() {
        const configured = values[request.method];
        const result = typeof configured === "function" ? configured(request) : configured;
        return { jsonrpc: "2.0", id: request.id, result };
      },
    };
  };
}

test("reads the ERC-1155 balance at one pinned Polygon block", async () => {
  const calls = [];
  const result = await fetchPositionSnapshot(WALLET, TOKEN_ID, {
    rpcUrl: "https://polygon.example.invalid",
    fetchImpl: rpcFetch({
      eth_chainId: "0x89",
      eth_getBlockByNumber: {
        number: "0x5666a7b",
        hash: `0x${"a".repeat(64)}`,
        timestamp: "0x669f1409",
      },
      eth_call(request) {
        return request.params[0].data.startsWith("0x00fdd58e") ? "0x4c4b40" : "0x1";
      },
    }, calls),
  });
  assert.equal(result.balanceRaw, "5000000");
  assert.equal(result.wallet, WALLET);
  assert.equal(result.outcomeTokenId, TOKEN_ID);
  assert.equal(result.approvedForExchange, true);
  assert.deepEqual(calls.map((call) => call.method), [
    "eth_chainId",
    "eth_getBlockByNumber",
    "eth_call",
    "eth_call",
  ]);
  const balanceCall = calls.find((call) => call.params?.[0]?.data?.startsWith("0x00fdd58e")).params;
  assert.equal(balanceCall[0].to, CONTRACTS.ctf);
  assert.equal(balanceCall[0].data.slice(0, 10), "0x00fdd58e");
  assert.equal(balanceCall[1], "0x5666a7b");
  const approvalCall = calls.find((call) => call.params?.[0]?.data?.startsWith("0xe985e9c5")).params;
  assert.equal(approvalCall[0].to, CONTRACTS.ctf);
  assert.equal(approvalCall[1], "0x5666a7b");
});

test("reports a revoked standard-exchange approval", async () => {
  const result = await fetchPositionSnapshot(WALLET, TOKEN_ID, {
    rpcUrl: "https://polygon.example.invalid",
    fetchImpl: rpcFetch({
      eth_chainId: "0x89",
      eth_getBlockByNumber: {
        number: "0x5666a7b",
        hash: `0x${"a".repeat(64)}`,
        timestamp: "0x669f1409",
      },
      eth_call(request) {
        return request.params[0].data.startsWith("0x00fdd58e") ? "0x4c4b40" : "0x0";
      },
    }, []),
  });
  assert.equal(result.approvedForExchange, false);
});

test("rejects a non-Polygon RPC", async () => {
  await assert.rejects(
    () => fetchPositionSnapshot(WALLET, TOKEN_ID, {
      rpcUrl: "https://wrong.example.invalid",
      fetchImpl: rpcFetch({ eth_chainId: "0x1" }, []),
    }),
    (error) => error instanceof ConvictionError && error.code === "wrong_chain",
  );
});
