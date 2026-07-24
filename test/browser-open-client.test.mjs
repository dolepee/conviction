import assert from "node:assert/strict";
import test from "node:test";

import {
  browserOpenRequest,
  createBrowserX402Client,
  marketOrderFromCard,
  settlementFromOrder,
  verifyBrowserCard,
} from "../src/browser-open-client.mjs";

const OWNER = "0x1111111111111111111111111111111111111111";
const WALLET = "0x2222222222222222222222222222222222222222";
const TOKEN = "123456789";
const CONDITION = `0x${"3".repeat(64)}`;

function request() {
  return browserOpenRequest({
    market: "example-market",
    outcome: "yes",
    spend: "1.25",
    maxPrice: "0.35",
    owner: OWNER,
    depositWallet: WALLET,
  });
}

function card() {
  return {
    ok: true,
    intentHash: `0x${"4".repeat(64)}`,
    intent: {
      version: "conviction-intent-v4",
      buyer: { wallet: WALLET, executionMode: "browser-deposit-wallet" },
      market: {
        conditionId: CONDITION,
        outcomeTokenId: TOKEN,
      },
      order: {
        side: "BUY",
        orderType: "FAK",
        outcome: "YES",
        maxPrice: "0.35",
        requestedBudget: "1.25",
        maximumOrderPrincipal: "1.05",
        maximumTotalDebit: "1.155",
      },
    },
    issuance: {
      version: "conviction-issuance-v1",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    },
  };
}

test("browser OPEN request binds the owner and exact Deposit Wallet", () => {
  const value = request();
  assert.equal(value.executionMode, "browser-deposit-wallet");
  assert.equal(value.wallet, WALLET);
  assert.equal(value.browserWalletReadiness.owner, OWNER);
  assert.equal(value.browserWalletReadiness.depositWallet, WALLET);
});

test("browser OPEN canonicalizes equivalent decimals before payment", () => {
  const value = browserOpenRequest({
    market: "example-market",
    outcome: "yes",
    spend: "1.250000",
    maxPrice: "0.3500",
    owner: OWNER,
    depositWallet: WALLET,
  });
  assert.equal(value.spend, "1.25");
  assert.equal(value.maxPrice, "0.35");
});

test("browser card validation fails closed on every economic substitution", () => {
  assert.equal(verifyBrowserCard(card(), request()).tokenId, TOKEN);
  for (const mutate of [
    (value) => { value.intent.buyer.wallet = OWNER; },
    (value) => { value.intent.order.outcome = "NO"; },
    (value) => { value.intent.order.maxPrice = "0.36"; },
    (value) => { value.intent.order.requestedBudget = "1.26"; },
    (value) => { value.intent.order.orderType = "GTC"; },
    (value) => { value.issuance.expiresAt = new Date(Date.now() - 1_000).toISOString(); },
  ]) {
    const value = structuredClone(card());
    mutate(value);
    assert.throws(() => verifyBrowserCard(value, request()));
  }
});

test("browser order uses only the signed principal, debit cap, token, and price", () => {
  assert.deepEqual(marketOrderFromCard(card(), request()), {
    tokenId: TOKEN,
    side: "BUY",
    amount: "1.05",
    maxSpend: "1.155",
    maxPrice: "0.35",
    orderType: "FAK",
  });
});

test("browser x402 client creates one exact EIP-3009 authorization", async () => {
  let signed;
  const client = createBrowserX402Client({
    signer: {
      address: OWNER,
      async signTypedData(value) {
        signed = value;
        return `0x${"5".repeat(130)}`;
      },
    },
    now: () => 1_000,
  });
  const paymentRequired = {
    x402Version: 2,
    resource: { url: "https://conviction-bay.vercel.app/api/service" },
    accepts: [{
      scheme: "exact",
      network: "eip155:196",
      amount: "50000",
      asset: "0x779ded0c9e1022225f8e0630b35a9b54be713736",
      payTo: "0x4abbae03afff90f50d4f6b42b3e362f5228ad4c7",
      maxTimeoutSeconds: 300,
      extra: {
        name: "USD₮0",
        version: "2",
        assetTransferMethod: "eip3009",
      },
    }],
  };
  const payload = await client.createPaymentPayload(paymentRequired);
  assert.equal(payload.payload.authorization.value, "50000");
  assert.equal(payload.payload.authorization.validAfter, "995");
  assert.equal(payload.payload.authorization.validBefore, "1300");
  assert.match(payload.payload.authorization.nonce, /^0x[0-9a-f]{64}$/);
  assert.equal(signed.primaryType, "TransferWithAuthorization");
  assert.equal(signed.domain.chainId, 196);
  assert.equal(signed.message.value, 50000n);

  const wrong = structuredClone(paymentRequired);
  wrong.accepts[0].amount = "50001";
  await assert.rejects(client.createPaymentPayload(wrong), /0.05/);
});

test("browser settlement requires an accepted order and Polygon transaction hash", () => {
  const result = settlementFromOrder({
    ok: true,
    orderId: "order-1",
    status: "matched",
    transactionsHashes: [`0x${"6".repeat(64)}`],
  });
  assert.equal(result.orderId, "order-1");
  assert.match(result.transactionHash, /^0x6{64}$/);
  assert.throws(() => settlementFromOrder({ ok: false, message: "rejected" }), /rejected/);
  assert.throws(
    () => settlementFromOrder({ ok: true, orderId: "order-2", transactionsHashes: [] }),
    /transaction hash/,
  );
});
