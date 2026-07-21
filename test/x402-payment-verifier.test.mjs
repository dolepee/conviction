import assert from "node:assert/strict";
import test from "node:test";

import { ConvictionError } from "../src/errors.mjs";
import {
  ERC20_TRANSFER_TOPIC,
  fetchAndVerifyX402Payment,
  verifyX402Payment,
} from "../src/x402-payment-verifier.mjs";

const TX = `0x${"1".repeat(64)}`;
const BLOCK_HASH = `0x${"2".repeat(64)}`;
const PAYER = "0x1111111111111111111111111111111111111111";
const PAYEE = "0x2222222222222222222222222222222222222222";
const ASSET = "0x779ded0c9e1022225f8e0630b35a9b54be713736";
const AMOUNT = "50000";
const BLOCK_NUMBER = 12_345_678n;
const BLOCK_TIMESTAMP = 1_784_650_000n;

function addressTopic(address) {
  return `0x${address.slice(2).padStart(64, "0")}`;
}

function uintWord(value) {
  return `0x${BigInt(value).toString(16).padStart(64, "0")}`;
}

function transferLog({ asset = ASSET, from = PAYER, to = PAYEE, amount = AMOUNT } = {}) {
  return {
    address: asset,
    topics: [ERC20_TRANSFER_TOPIC, addressTopic(from), addressTopic(to)],
    data: uintWord(amount),
    logIndex: "0x3",
  };
}

function fixture() {
  return {
    chainId: 196,
    receipt: {
      transactionHash: TX,
      status: "0x1",
      blockNumber: `0x${BLOCK_NUMBER.toString(16)}`,
      blockHash: BLOCK_HASH,
      logs: [transferLog()],
    },
    block: {
      number: `0x${BLOCK_NUMBER.toString(16)}`,
      hash: BLOCK_HASH,
      timestamp: `0x${BLOCK_TIMESTAMP.toString(16)}`,
    },
    expected: {
      paymentTx: TX,
      payer: PAYER,
      payee: PAYEE,
      asset: ASSET,
      amountAtomic: AMOUNT,
      earliestAllowedBlock: BLOCK_NUMBER - 1n,
      earliestAllowedTimestamp: BLOCK_TIMESTAMP - 1n,
    },
  };
}

function expectCode(fn, code) {
  assert.throws(fn, (error) => error instanceof ConvictionError && error.code === code);
}

async function expectCodeAsync(fn, code) {
  await assert.rejects(fn, (error) => error instanceof ConvictionError && error.code === code);
}

test("independently verifies an exact fresh X Layer USD₮0 payment", () => {
  const result = verifyX402Payment(fixture());
  assert.deepEqual(result, {
    ok: true,
    proof: {
      version: "conviction-x402-payment-v1",
      chainId: 196,
      transactionHash: TX,
      blockNumber: BLOCK_NUMBER.toString(),
      blockHash: BLOCK_HASH,
      blockTimestamp: BLOCK_TIMESTAMP.toString(),
      asset: ASSET,
      payer: PAYER,
      payee: PAYEE,
      amountAtomic: AMOUNT,
      logIndex: "0x3",
      checks: {
        transactionSucceeded: true,
        receiptBoundToBlock: true,
        freshPayment: true,
        exactAsset: true,
        exactPayer: true,
        exactPayee: true,
        exactAmount: true,
      },
    },
  });
});

test("accepts an ISO earliest allowed time", () => {
  const input = fixture();
  delete input.expected.earliestAllowedTimestamp;
  input.expected.earliestAllowedTime = new Date(Number(BLOCK_TIMESTAMP - 1n) * 1000).toISOString();
  assert.equal(verifyX402Payment(input).ok, true);
});

test("requires a freshness boundary", () => {
  const input = fixture();
  delete input.expected.earliestAllowedBlock;
  delete input.expected.earliestAllowedTimestamp;
  expectCode(() => verifyX402Payment(input), "missing_payment_freshness");
});

test("rejects malformed numeric boundaries and receipt quantities", () => {
  const emptyBoundary = fixture();
  emptyBoundary.expected.earliestAllowedBlock = "";
  expectCode(() => verifyX402Payment(emptyBoundary), "invalid_payment_expectation");

  const unsafeBoundary = fixture();
  unsafeBoundary.expected.earliestAllowedBlock = Number.MAX_SAFE_INTEGER + 1;
  expectCode(() => verifyX402Payment(unsafeBoundary), "invalid_payment_expectation");

  const missingReceiptBlock = fixture();
  missingReceiptBlock.receipt.blockNumber = null;
  expectCode(() => verifyX402Payment(missingReceiptBlock), "invalid_payment_receipt");
});

test("rejects wrong chain, transaction, and failed receipt", () => {
  const wrongChain = fixture();
  wrongChain.chainId = 137;
  expectCode(() => verifyX402Payment(wrongChain), "wrong_payment_chain");

  const wrongTx = fixture();
  wrongTx.receipt.transactionHash = `0x${"9".repeat(64)}`;
  expectCode(() => verifyX402Payment(wrongTx), "payment_transaction_mismatch");

  const failed = fixture();
  failed.receipt.status = "0x0";
  expectCode(() => verifyX402Payment(failed), "failed_payment_transaction");
});

test("rejects asset, payer, recipient, and amount substitution", () => {
  const mutations = [
    ["asset", "0x3333333333333333333333333333333333333333", "payment_transfer_mismatch"],
    ["payer", "0x3333333333333333333333333333333333333333", "payment_transfer_mismatch"],
    ["payee", "0x3333333333333333333333333333333333333333", "payment_recipient_mismatch"],
    ["amountAtomic", "50001", "payment_amount_mismatch"],
  ];
  for (const [field, value, code] of mutations) {
    const input = fixture();
    input.expected[field] = value;
    expectCode(() => verifyX402Payment(input), code);
  }
});

test("rejects a payment receipt with an additional asset debit from the payer", () => {
  const input = fixture();
  input.receipt.logs.push(transferLog({ to: "0x4444444444444444444444444444444444444444", amount: "1" }));
  expectCode(() => verifyX402Payment(input), "payment_transfer_mismatch");
});

test("rejects a non-canonically padded indexed payer", () => {
  const input = fixture();
  input.receipt.logs[0].topics[1] = `0x01${PAYER.slice(2).padStart(62, "0")}`;
  expectCode(() => verifyX402Payment(input), "invalid_payment_receipt");
});

test("ignores unrelated transfers while preserving the exact payment", () => {
  const input = fixture();
  input.receipt.logs.unshift(
    transferLog({ asset: "0x3333333333333333333333333333333333333333" }),
    transferLog({ from: "0x3333333333333333333333333333333333333333" }),
  );
  assert.equal(verifyX402Payment(input).ok, true);
});

test("rejects stale block height and stale block time", () => {
  const staleBlock = fixture();
  staleBlock.expected.earliestAllowedBlock = BLOCK_NUMBER + 1n;
  expectCode(() => verifyX402Payment(staleBlock), "stale_payment");

  const staleTime = fixture();
  staleTime.expected.earliestAllowedTimestamp = BLOCK_TIMESTAMP + 1n;
  expectCode(() => verifyX402Payment(staleTime), "stale_payment");
});

test("rejects receipt-to-block hash and number mismatch", () => {
  const wrongHash = fixture();
  wrongHash.block.hash = `0x${"8".repeat(64)}`;
  expectCode(() => verifyX402Payment(wrongHash), "payment_block_mismatch");

  const wrongNumber = fixture();
  wrongNumber.block.number = `0x${(BLOCK_NUMBER + 1n).toString(16)}`;
  expectCode(() => verifyX402Payment(wrongNumber), "payment_block_mismatch");
});

test("fetches chain, receipt, and block through an injected RPC", async () => {
  const input = fixture();
  const calls = [];
  const values = {
    eth_chainId: "0xc4",
    eth_getTransactionReceipt: input.receipt,
    eth_getBlockByNumber: input.block,
  };
  const result = await fetchAndVerifyX402Payment(input.expected, {
    async rpcCall(method, params) {
      calls.push([method, params]);
      return values[method];
    },
  });
  assert.equal(result.ok, true);
  assert.deepEqual(calls, [
    ["eth_chainId", []],
    ["eth_getTransactionReceipt", [TX]],
    ["eth_getBlockByNumber", [input.receipt.blockNumber, false]],
  ]);
});

test("fetches through an injected fetch implementation", async () => {
  const input = fixture();
  const calls = [];
  const values = {
    eth_chainId: "0xc4",
    eth_getTransactionReceipt: input.receipt,
    eth_getBlockByNumber: input.block,
  };
  const result = await fetchAndVerifyX402Payment(input.expected, {
    rpcUrl: "https://rpc.invalid",
    async fetchImpl(url, options) {
      const request = JSON.parse(options.body);
      calls.push({ url, method: request.method, params: request.params });
      return {
        ok: true,
        async json() {
          return { jsonrpc: "2.0", id: 1, result: values[request.method] };
        },
      };
    },
  });
  assert.equal(result.ok, true);
  assert.deepEqual(calls.map(({ method }) => method), [
    "eth_chainId",
    "eth_getTransactionReceipt",
    "eth_getBlockByNumber",
  ]);
});

test("fails closed on missing receipts and RPC errors", async () => {
  const expected = fixture().expected;
  await expectCodeAsync(
    () => fetchAndVerifyX402Payment(expected, {
      rpcCall: async () => {
        throw new Error("offline");
      },
    }),
    "payment_rpc_error",
  );

  await expectCodeAsync(
    () => fetchAndVerifyX402Payment(expected, {
      async rpcCall(method) {
        if (method === "eth_chainId") return "0xc4";
        if (method === "eth_getTransactionReceipt") return null;
        return null;
      },
    }),
    "missing_payment_receipt",
  );
});
