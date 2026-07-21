import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import test from "node:test";

import { compileCloseIntent } from "../src/exit-intent-compiler.mjs";
import { ConvictionError } from "../src/errors.mjs";
import {
  fetchAndVerifyClose,
  verifyCloseProof,
  verifyCloseReceipt,
} from "../src/exit-receipt-verifier.mjs";
import { createIntentIssuer, trustedIssuerRegistry } from "../src/intent-issuer.mjs";
import { LIVE_MARKET_SNAPSHOT } from "./fixtures.mjs";

const NOW = Date.parse("2026-07-21T02:00:10.000Z");
const WALLET = "0x6a355e4971d9ac2ab97d22c3cf361d42faba33fe";
const COUNTERPARTY = "0x35bbbad2415fe5e39b12da9a316cdc80b022009b";
const EXCHANGE = "0xe111180000d2663c0091e4f400237545b87b996b";
const CTF = "0x4d97dcd97ec945f40cf65f87097ace5ea0476045";
const PUSD = "0xc011a7e12a19f7b1f670d46f03b03f3342e82dfb";
const ORDER_ID = `0x${"b".repeat(64)}`;
const TX_HASH = `0x${"c".repeat(64)}`;
const BLOCK_HASH = `0x${"d".repeat(64)}`;
const { privateKey } = generateKeyPairSync("ed25519");
const issue = createIntentIssuer({
  keyId: "conviction-test-2026-07",
  privateKey,
  now: () => NOW + 1_000,
});
const trustedIssuers = trustedIssuerRegistry([issue.issuer]);

function word(value) {
  return BigInt(value).toString(16).padStart(64, "0");
}

function topicAddress(address) {
  return `0x${address.slice(2).padStart(64, "0")}`;
}

function prepared({ feeBps = 0 } = {}) {
  const source = {
    intentHash: `0x${"1".repeat(64)}`,
    positionProofHash: `0x${"2".repeat(64)}`,
    transactionHash: `0x${"3".repeat(64)}`,
    orderId: `0x${"4".repeat(64)}`,
    wallet: WALLET,
    marketConditionId: LIVE_MARKET_SNAPSHOT.conditionId,
    outcome: "YES",
    outcomeTokenId: LIVE_MARKET_SNAPSHOT.yesTokenId,
    actualSharesRaw: "5000000",
    intentVersion: "conviction-intent-v4",
    verificationMode: "signed-intent-window",
  };
  const position = {
    chainId: 137,
    wallet: WALLET,
    outcomeTokenId: LIVE_MARKET_SNAPSHOT.yesTokenId,
    balanceRaw: "5000000",
    approvedForExchange: true,
    blockNumber: "0x5666a7b",
    blockHash: `0x${"a".repeat(64)}`,
    capturedAt: "2026-07-21T02:00:09.000Z",
  };
  return issue(compileCloseIntent({
    action: "close",
    market: LIVE_MARKET_SNAPSHOT.slug,
    outcome: "yes",
    shares: "5",
    minPrice: "0.26",
    wallet: WALLET,
    rationale: "Close the full verified YES position at no less than twenty-six cents.",
    source,
  }, { ...LIVE_MARKET_SNAPSHOT, feeBps }, position, {
    now: NOW,
    quoteTtlMs: 300_000,
  }));
}

function closeReceipt({
  sharesRaw = 5_000_000n,
  grossRaw = 1_300_000n,
  feeRaw = 0n,
  side = 1n,
  tokenId = BigInt(LIVE_MARKET_SNAPSHOT.yesTokenId),
  builder = 0n,
  creditTo = WALLET,
  creditFrom = COUNTERPARTY,
  debitFrom = WALLET,
  taker = EXCHANGE,
  offsetCollateral = false,
  offsetOutcome = false,
} = {}) {
  const netRaw = grossRaw - feeRaw;
  const receipt = {
    transactionHash: TX_HASH,
    blockNumber: "0x5666a7c",
    blockHash: BLOCK_HASH,
    status: "0x1",
    to: EXCHANGE,
    logs: [
      {
        address: CTF,
        topics: [
          "0xc3d58168c5ae7397731d063d5bbf3d657854427343f4c083240f7aacaa2d0f62",
          topicAddress(EXCHANGE),
          topicAddress(debitFrom),
          topicAddress(COUNTERPARTY),
        ],
        data: `0x${word(tokenId)}${word(sharesRaw)}`,
      },
      {
        address: PUSD,
        topics: [
          "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef",
          topicAddress(creditFrom),
          topicAddress(creditTo),
        ],
        data: `0x${word(netRaw)}`,
      },
      {
        address: EXCHANGE,
        topics: [
          "0xd543adfd945773f1a62f74f0ee55a5e3b9b1a28262980ba90b1a89f2ea84d8ee",
          ORDER_ID,
          topicAddress(WALLET),
          topicAddress(taker),
        ],
        data: `0x${[
          side,
          tokenId,
          sharesRaw,
          grossRaw,
          feeRaw,
          builder,
          0n,
        ].map(word).join("")}`,
      },
    ],
  };
  if (offsetCollateral) {
    receipt.logs.push({
      address: PUSD,
      topics: [
        "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef",
        topicAddress(WALLET),
        topicAddress(COUNTERPARTY),
      ],
      data: `0x${word(netRaw)}`,
    });
  }
  if (offsetOutcome) {
    receipt.logs.push({
      address: CTF,
      topics: [
        "0xc3d58168c5ae7397731d063d5bbf3d657854427343f4c083240f7aacaa2d0f62",
        topicAddress(EXCHANGE),
        topicAddress(COUNTERPARTY),
        topicAddress(WALLET),
      ],
      data: `0x${word(tokenId)}${word(sharesRaw)}`,
    });
  }
  return receipt;
}

function settlementBlock(timestamp = Math.floor((NOW + 2_000) / 1_000)) {
  return {
    number: "0x5666a7c",
    hash: BLOCK_HASH,
    timestamp: `0x${timestamp.toString(16)}`,
  };
}

function errorCode(fn, code) {
  assert.throws(fn, (error) => error instanceof ConvictionError && error.code === code);
}

test("verifies exact SELL transfer directions and fill fields", () => {
  const receipt = closeReceipt();
  const result = verifyCloseReceipt({
    chainId: 137,
    receipt,
    expected: {
      wallet: WALLET,
      orderId: ORDER_ID,
      outcome: "YES",
      outcomeTokenId: LIVE_MARKET_SNAPSHOT.yesTokenId,
      sharesRaw: "5000000",
      grossProceedsRaw: "1300000",
      feeRaw: "0",
      netProceedsRaw: "1300000",
    },
  });
  assert.equal(result.proof.version, "conviction-close-receipt-v1");
  assert.equal(result.proof.netProceedsRaw, "1300000");
  assert.deepEqual(result.proof.checks, {
    transactionSucceeded: true,
    standardExchangeV2: true,
    exactOutcomeDebit: true,
    exactCollateralCredit: true,
    exactVenueFee: true,
    exactSellOrderFill: true,
  });
});

test("creates a signed, block-time-bound CLOSE passport", () => {
  const card = prepared();
  const result = verifyCloseProof({
    chainId: 137,
    receipt: closeReceipt(),
    settlementBlock: settlementBlock(),
    intent: card.intent,
    intentHash: card.intentHash,
    orderId: ORDER_ID,
    issuance: card.issuance,
    trustedIssuers,
  });
  assert.equal(result.closePassport.status, "CLOSED");
  assert.equal(result.closeProof.fill.actualSharesRaw, "5000000");
  assert.equal(result.closeProof.fill.actualGrossProceedsRaw, "1300000");
  assert.equal(result.closeProof.fill.actualNetProceedsRaw, "1300000");
  assert.equal(result.closeProof.checks.exactSharesClosed, true);
  assert.match(result.closeProofHash, /^0x[0-9a-f]{64}$/);
});

test("accepts price improvement while enforcing the fee-rate and net floors", () => {
  const card = prepared({ feeBps: 1000 });
  const result = verifyCloseProof({
    chainId: 137,
    receipt: closeReceipt({ grossRaw: 1_350_000n, feeRaw: 135_000n }),
    settlementBlock: settlementBlock(),
    intent: card.intent,
    intentHash: card.intentHash,
    orderId: ORDER_ID,
    issuance: card.issuance,
    trustedIssuers,
  });
  assert.equal(result.closeProof.fill.actualNetProceedsRaw, "1215000");
  assert.equal(result.closeProof.fill.actualAveragePriceFloor, "0.27");
});

test("rejects reversed CTF and pUSD directions", () => {
  const expected = {
    wallet: WALLET,
    orderId: ORDER_ID,
    outcome: "YES",
    outcomeTokenId: LIVE_MARKET_SNAPSHOT.yesTokenId,
    sharesRaw: "5000000",
    grossProceedsRaw: "1300000",
    feeRaw: "0",
    netProceedsRaw: "1300000",
  };
  errorCode(
    () => verifyCloseReceipt({ chainId: 137, receipt: closeReceipt({ debitFrom: COUNTERPARTY }), expected }),
    "missing_outcome_debit",
  );
  errorCode(
    () => verifyCloseReceipt({ chainId: 137, receipt: closeReceipt({ creditTo: COUNTERPARTY }), expected }),
    "missing_collateral_credit",
  );
});

test("rejects offsetting transfers and a substituted aggregate taker", () => {
  const card = prepared();
  const base = {
    chainId: 137,
    settlementBlock: settlementBlock(),
    intent: card.intent,
    intentHash: card.intentHash,
    orderId: ORDER_ID,
    issuance: card.issuance,
    trustedIssuers,
  };
  errorCode(() => verifyCloseProof({ ...base, receipt: closeReceipt({ offsetCollateral: true }) }), "missing_collateral_credit");
  errorCode(() => verifyCloseProof({ ...base, receipt: closeReceipt({ offsetOutcome: true }) }), "missing_outcome_debit");
  errorCode(() => verifyCloseProof({ ...base, receipt: closeReceipt({ taker: COUNTERPARTY }) }), "missing_close_fill");
});

test("rejects BUY-side, token, builder, partial-share, gross, and fee substitutions", () => {
  const card = prepared({ feeBps: 1000 });
  const base = {
    chainId: 137,
    settlementBlock: settlementBlock(),
    intent: card.intent,
    intentHash: card.intentHash,
    orderId: ORDER_ID,
    issuance: card.issuance,
    trustedIssuers,
  };
  for (const receipt of [
    closeReceipt({ side: 0n }),
    closeReceipt({ tokenId: BigInt(LIVE_MARKET_SNAPSHOT.noTokenId) }),
    closeReceipt({ builder: 1n }),
  ]) errorCode(() => verifyCloseProof({ ...base, receipt }), "missing_close_fill");
  errorCode(
    () => verifyCloseProof({ ...base, receipt: closeReceipt({ sharesRaw: 4_000_000n, grossRaw: 1_040_000n }) }),
    "partial_or_excess_close",
  );
  errorCode(
    () => verifyCloseProof({ ...base, receipt: closeReceipt({ grossRaw: 1_250_000n, feeRaw: 125_000n }) }),
    "gross_below_bound",
  );
  errorCode(
    () => verifyCloseProof({ ...base, receipt: closeReceipt({ feeRaw: 130_001n }) }),
    "fee_above_bound",
  );
});

test("rejects settlement outside the signed placement window", () => {
  const card = prepared();
  errorCode(
    () => verifyCloseProof({
      chainId: 137,
      receipt: closeReceipt(),
      settlementBlock: settlementBlock(Math.floor((NOW + 301_000) / 1_000)),
      intent: card.intent,
      intentHash: card.intentHash,
      orderId: ORDER_ID,
      issuance: card.issuance,
      trustedIssuers,
    }),
    "settlement_outside_intent_window",
  );
});

test("fetches receipt and settlement block before verifying CLOSE", async () => {
  const card = prepared();
  const methods = [];
  const values = {
    eth_chainId: "0x89",
    eth_getTransactionReceipt: closeReceipt(),
    eth_getBlockByNumber: settlementBlock(),
  };
  const result = await fetchAndVerifyClose(TX_HASH, {
    intent: card.intent,
    intentHash: card.intentHash,
    orderId: ORDER_ID,
    issuance: card.issuance,
    trustedIssuers,
  }, {
    rpcUrl: "https://polygon.example.invalid",
    async fetchImpl(_url, options) {
      const request = JSON.parse(options.body);
      methods.push(request.method);
      return {
        ok: true,
        async json() {
          return { jsonrpc: "2.0", id: request.id, result: values[request.method] };
        },
      };
    },
  });
  assert.equal(result.closePassport.status, "CLOSED");
  assert.deepEqual(methods.sort(), [
    "eth_chainId",
    "eth_getBlockByNumber",
    "eth_getTransactionReceipt",
  ]);
});

test("rejects an RPC receipt for a different transaction hash", async () => {
  const card = prepared();
  await assert.rejects(
    fetchAndVerifyClose(`0x${"e".repeat(64)}`, {
      intent: card.intent,
      intentHash: card.intentHash,
      orderId: ORDER_ID,
      issuance: card.issuance,
      trustedIssuers,
    }, {
      rpcUrl: "https://polygon.example.invalid",
      async fetchImpl(_url, options) {
        const request = JSON.parse(options.body);
        const result = request.method === "eth_chainId" ? "0x89" : closeReceipt();
        return { ok: true, async json() { return { jsonrpc: "2.0", id: request.id, result }; } };
      },
    }),
    (error) => error instanceof ConvictionError && error.code === "settlement_transaction_mismatch",
  );
});
