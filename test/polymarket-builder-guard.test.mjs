import assert from "node:assert/strict";
import test from "node:test";

import { privateKeyToAccount } from "viem/accounts";

import {
  CTF_EXCHANGE_V2,
  DEPOSIT_WALLET_FACTORY,
  OFFICIAL_APPROVAL_CALLS,
  POLYGON_CHAIN_ID,
  validateBuilderRequest,
} from "../src/polymarket-builder-guard.mjs";

const KEY = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const account = privateKeyToAccount(KEY);
const depositWallet = "0x1111111111111111111111111111111111111111";

async function batchBody({ calls = OFFICIAL_APPROVAL_CALLS, deadline = "1300" } = {}) {
  const nonce = "4";
  const signature = await account.signTypedData({
    domain: {
      name: "DepositWallet",
      version: "1",
      chainId: POLYGON_CHAIN_ID,
      verifyingContract: depositWallet,
    },
    types: {
      Call: [
        { name: "target", type: "address" },
        { name: "value", type: "uint256" },
        { name: "data", type: "bytes" },
      ],
      Batch: [
        { name: "wallet", type: "address" },
        { name: "nonce", type: "uint256" },
        { name: "deadline", type: "uint256" },
        { name: "calls", type: "Call[]" },
      ],
    },
    primaryType: "Batch",
    message: {
      wallet: depositWallet,
      nonce: 4n,
      deadline: BigInt(deadline),
      calls: calls.map((call) => ({
        target: call.target,
        value: BigInt(call.value),
        data: call.data,
      })),
    },
  });
  return {
    type: "WALLET",
    from: account.address,
    to: DEPOSIT_WALLET_FACTORY,
    nonce,
    signature,
    depositWalletParams: { depositWallet, deadline, calls },
  };
}

test("allows only the authenticated buyer's official wallet-create request", async () => {
  const result = await validateBuilderRequest({
    method: "POST",
    path: "/submit",
    session: { wallet: account.address },
    body: {
      type: "WALLET-CREATE",
      from: account.address,
      to: DEPOSIT_WALLET_FACTORY,
    },
    nowSeconds: 1_000,
  });
  assert.equal(result.action, "DEPLOY_DEPOSIT_WALLET");

  await assert.rejects(
    validateBuilderRequest({
      method: "POST",
      path: "/submit",
      session: { wallet: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" },
      body: {
        type: "WALLET-CREATE",
        from: account.address,
        to: DEPOSIT_WALLET_FACTORY,
      },
      nowSeconds: 1_000,
    }),
    (error) => error.code === "wallet_session_mismatch",
  );
});

test("allows a buyer-signed exact five-call setup batch", async () => {
  const result = await validateBuilderRequest({
    method: "POST",
    path: "/submit",
    session: { wallet: account.address },
    body: await batchBody(),
    nowSeconds: 1_000,
  });
  assert.equal(result.action, "APPROVE_DEPOSIT_WALLET");
  assert.equal(result.depositWallet.toLowerCase(), depositWallet);
});

test("rejects substituted approval calls, stale deadlines, signatures, paths, and extra fields", async () => {
  const substituted = OFFICIAL_APPROVAL_CALLS.map((call) => ({ ...call }));
  substituted[0] = {
    ...substituted[0],
    data: substituted[0].data.replace(CTF_EXCHANGE_V2.slice(2).toLowerCase(), "22".repeat(20)),
  };
  await assert.rejects(
    validateBuilderRequest({
      method: "POST",
      path: "/submit",
      session: { wallet: account.address },
      body: await batchBody({ calls: substituted }),
      nowSeconds: 1_000,
    }),
    (error) => error.code === "invalid_approval_batch",
  );

  await assert.rejects(
    validateBuilderRequest({
      method: "POST",
      path: "/submit",
      session: { wallet: account.address },
      body: await batchBody({ deadline: "999" }),
      nowSeconds: 1_000,
    }),
    (error) => error.code === "invalid_wallet_deadline",
  );

  const wrongSignature = await batchBody();
  wrongSignature.from = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
  await assert.rejects(
    validateBuilderRequest({
      method: "POST",
      path: "/submit",
      session: { wallet: wrongSignature.from },
      body: wrongSignature,
      nowSeconds: 1_000,
    }),
    (error) => error.code === "batch_signature_mismatch",
  );

  await assert.rejects(
    validateBuilderRequest({
      method: "GET",
      path: "/submit",
      session: { wallet: account.address },
      body: await batchBody(),
      nowSeconds: 1_000,
    }),
    (error) => error.code === "unsupported_builder_request",
  );

  const extra = await batchBody();
  extra.metadata = "no";
  await assert.rejects(
    validateBuilderRequest({
      method: "POST",
      path: "/submit",
      session: { wallet: account.address },
      body: extra,
      nowSeconds: 1_000,
    }),
    (error) => error.code === "invalid_wallet_batch_request",
  );
});
