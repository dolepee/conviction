import assert from "node:assert/strict";
import test from "node:test";

import { encodeFunctionResult } from "viem";

import {
  DEPOSIT_WALLET_FACTORY,
  MAX_UINT256,
} from "../src/polymarket-builder-guard.mjs";
import {
  createPolygonWalletSetupVerifier,
  WALLET_DEPLOYED_TOPIC,
  walletFromDeploymentReceipt,
  PolygonWalletSetupVerificationError,
} from "../src/polygon-wallet-setup-verifier.mjs";

const OWNER = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const WALLET = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const TX = `0x${"1".repeat(64)}`;

const ERC20_ALLOWANCE_ABI = [{
  type: "function",
  name: "allowance",
  inputs: [{ type: "address" }, { type: "address" }],
  outputs: [{ type: "uint256" }],
  stateMutability: "view",
}];
const ERC1155_APPROVAL_ABI = [{
  type: "function",
  name: "isApprovedForAll",
  inputs: [{ type: "address" }, { type: "address" }],
  outputs: [{ type: "bool" }],
  stateMutability: "view",
}];
const ERC20_BALANCE_ABI = [{
  type: "function",
  name: "balanceOf",
  inputs: [{ type: "address" }],
  outputs: [{ type: "uint256" }],
  stateMutability: "view",
}];

function indexed(address) {
  return `0x${address.slice(2).padStart(64, "0")}`;
}

function receipt({ owner = OWNER, wallet = WALLET } = {}) {
  return {
    transactionHash: TX,
    status: "0x1",
    blockNumber: "0x123",
    logs: [{
      address: DEPOSIT_WALLET_FACTORY,
      topics: [WALLET_DEPLOYED_TOPIC, indexed(wallet), indexed(owner), `0x${"0".repeat(64)}`],
      data: indexed("0xcccccccccccccccccccccccccccccccccccccccc"),
    }],
  };
}

function jsonRpc(result) {
  const bytes = new TextEncoder().encode(JSON.stringify({ jsonrpc: "2.0", id: 1, result }));
  return {
    ok: true,
    headers: { get: (name) => name === "content-length" ? String(bytes.length) : null },
    arrayBuffer: async () => bytes.buffer,
  };
}

test("deployment verifier binds the factory event, owner, code, and exact transaction receipt", async () => {
  const calls = [];
  const verifier = createPolygonWalletSetupVerifier({
    rpcUrl: "https://polygon.example.com",
    fetchImpl: async (_url, options) => {
      const request = JSON.parse(options.body);
      calls.push(request);
      if (request.method === "eth_getTransactionReceipt") return jsonRpc(receipt());
      if (request.method === "eth_getCode") return jsonRpc("0x60006000");
      throw new Error(`unexpected ${request.method}`);
    },
  });
  const verified = await verifier.verifyDeployment({ transactionHash: TX, owner: OWNER, expectedWallet: WALLET });
  assert.equal(verified.wallet.toLowerCase(), WALLET);
  assert.equal(verified.transactionHash, TX);
  assert.deepEqual(calls.map((call) => call.method), ["eth_getTransactionReceipt", "eth_getCode"]);
});

test("deployment receipt verification rejects a substituted owner or wallet event", () => {
  assert.throws(
    () => walletFromDeploymentReceipt({ receipt: receipt({ owner: "0xdddddddddddddddddddddddddddddddddddddddd" }), transactionHash: TX, owner: OWNER }),
    (error) => error instanceof PolygonWalletSetupVerificationError && error.code === "deposit_wallet_event_missing",
  );
});

test("approval verifier checks both allowances and all three ERC-1155 permissions at the confirmation block", async () => {
  let calls = 0;
  const verifier = createPolygonWalletSetupVerifier({
    rpcUrl: "https://polygon.example.com",
    fetchImpl: async (_url, options) => {
      const request = JSON.parse(options.body);
      if (request.method === "eth_getTransactionReceipt") return jsonRpc({ ...receipt(), logs: [] });
      if (request.method !== "eth_call") throw new Error(`unexpected ${request.method}`);
      calls += 1;
      if (calls <= 2) {
        return jsonRpc(encodeFunctionResult({ abi: ERC20_ALLOWANCE_ABI, functionName: "allowance", result: MAX_UINT256 }));
      }
      return jsonRpc(encodeFunctionResult({ abi: ERC1155_APPROVAL_ABI, functionName: "isApprovedForAll", result: true }));
    },
  });
  const verified = await verifier.verifyApprovals({ transactionHash: TX, wallet: WALLET });
  assert.equal(verified.wallet.toLowerCase(), WALLET);
  assert.equal(verified.approvalCalls, 5);
  assert.equal(calls, 5);
});

test("approval verifier fails closed when a required venue permission is absent", async () => {
  let calls = 0;
  const verifier = createPolygonWalletSetupVerifier({
    rpcUrl: "https://polygon.example.com",
    fetchImpl: async (_url, options) => {
      const request = JSON.parse(options.body);
      if (request.method === "eth_getTransactionReceipt") return jsonRpc({ ...receipt(), logs: [] });
      calls += 1;
      if (calls <= 2) {
        return jsonRpc(encodeFunctionResult({ abi: ERC20_ALLOWANCE_ABI, functionName: "allowance", result: MAX_UINT256 }));
      }
      return jsonRpc(encodeFunctionResult({ abi: ERC1155_APPROVAL_ABI, functionName: "isApprovedForAll", result: calls !== 5 }));
    },
  });
  await assert.rejects(
    verifier.verifyApprovals({ transactionHash: TX, wallet: WALLET }),
    (error) => error instanceof PolygonWalletSetupVerificationError && error.code === "deposit_wallet_approval_incomplete",
  );
});

test("current balance verifier refuses an unfunded Deposit Wallet before payment", async () => {
  const verifier = createPolygonWalletSetupVerifier({
    rpcUrl: "https://polygon.example.com",
    fetchImpl: async (_url, options) => {
      const request = JSON.parse(options.body);
      assert.equal(request.method, "eth_call");
      return jsonRpc(encodeFunctionResult({
        abi: ERC20_BALANCE_ABI,
        functionName: "balanceOf",
        result: 1_250_000n,
      }));
    },
  });
  const ready = await verifier.verifyPusdBalance({
    wallet: WALLET,
    minimumRaw: "1250000",
  });
  assert.equal(ready.balanceRaw, "1250000");
  await assert.rejects(
    verifier.verifyPusdBalance({
      wallet: WALLET,
      minimumRaw: "1250001",
    }),
    (error) =>
      error instanceof PolygonWalletSetupVerificationError &&
      error.code === "insufficient_trading_balance",
  );
});
