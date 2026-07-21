import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import test from "node:test";

import { sha256 } from "../src/canonical.mjs";
import { ConvictionError } from "../src/errors.mjs";
import { createIntentIssuer } from "../src/intent-issuer.mjs";
import { compileTakeProfitIntent } from "../src/take-profit-intent-compiler.mjs";
import {
  fetchAndVerifyTakeProfitAggregateFill,
  verifyTakeProfitAggregateFill,
} from "../src/take-profit-fill-verifier.mjs";
import { LIVE_MARKET_SNAPSHOT } from "./fixtures.mjs";

const COMPILE_NOW = Date.parse("2026-07-21T02:00:10.000Z");
const VERIFY_NOW = Date.parse("2026-07-21T02:10:01.000Z");
const SIGNER = "0x79e23e61a754901d53e55202e311f295a85fa070";
const WALLET = "0x6a355e4971d9ac2ab97d22c3cf361d42faba33fe";
const COUNTERPARTY = "0x35bbbad2415fe5e39b12da9a316cdc80b022009b";
const EXCHANGE = "0xe111180000d2663c0091e4f400237545b87b996b";
const CTF = "0x4d97dcd97ec945f40cf65f87097ace5ea0476045";
const PUSD = "0xc011a7e12a19f7b1f670d46f03b03f3342e82dfb";
const ORDER_ID = `0x${"b".repeat(64)}`;
const TX_1 = `0x${"c".repeat(64)}`;
const TX_2 = `0x${"d".repeat(64)}`;
const BLOCK_1 = `0x${"e".repeat(64)}`;
const BLOCK_2 = `0x${"f".repeat(64)}`;
const FINALIZED_BLOCK = `0x${"7".repeat(64)}`;
const TRADE_1 = "9326ea42-c5c7-457a-b6a4-9b839664f32e";
const TRADE_2 = "0326ea42-c5c7-457a-b6a4-9b839664f32f";
const VENUE_EXPIRES_AT = "2026-07-21T03:00:00.000Z";
const VENUE_EXPIRES_UNIX = String(Date.parse(VENUE_EXPIRES_AT) / 1_000);
const ORDER_CREATED_AT = String(Date.parse("2026-07-21T02:00:12.000Z") / 1_000);
const { privateKey } = generateKeyPairSync("ed25519");
const issuer = createIntentIssuer({
  keyId: "conviction-tp-fill-test",
  privateKey,
  now: () => Date.parse("2026-07-21T02:00:11.000Z"),
});
const trustedIssuers = [issuer.issuer];

function word(value) {
  return BigInt(value).toString(16).padStart(64, "0");
}

function topicAddress(address) {
  return `0x${address.slice(2).padStart(64, "0")}`;
}

function fixtureJournal() {
  const market = { ...LIVE_MARKET_SNAPSHOT, feeBps: 1_000 };
  const source = {
    intentHash: `0x${"1".repeat(64)}`,
    positionProofHash: `0x${"2".repeat(64)}`,
    transactionHash: `0x${"3".repeat(64)}`,
    orderId: `0x${"4".repeat(64)}`,
    wallet: WALLET,
    marketConditionId: market.conditionId,
    outcome: "YES",
    outcomeTokenId: market.yesTokenId,
    actualSharesRaw: "10000000",
    intentVersion: "conviction-intent-v4",
    verificationMode: "signed-intent-window",
  };
  const position = {
    chainId: 137,
    wallet: WALLET,
    outcomeTokenId: market.yesTokenId,
    balanceRaw: "10000000",
    approvedForExchange: true,
    blockNumber: "0x5666a7b",
    blockHash: `0x${"a".repeat(64)}`,
    capturedAt: "2026-07-21T02:00:09.000Z",
  };
  const issued = issuer(compileTakeProfitIntent({
    action: "take_profit",
    market: market.slug,
    outcome: "yes",
    shares: "10",
    targetPrice: "0.4",
    venueExpiresAt: VENUE_EXPIRES_AT,
    wallet: WALLET,
    rationale: "Rest the verified YES position at a bounded forty-cent target.",
    source,
  }, market, position, { now: COMPILE_NOW }));
  const proof = {
    version: "conviction-resting-order-proof-v1",
    status: "ARMED",
    verificationSource: "authenticated-polymarket-clob",
    onChain: false,
    intentHash: issued.intentHash,
    sourceIntentHash: source.intentHash,
    sourcePositionProofHash: source.positionProofHash,
    orderId: ORDER_ID,
    wallet: WALLET,
    marketConditionId: market.conditionId,
    outcome: "YES",
    outcomeTokenId: market.yesTokenId,
    bounds: {
      exactSharesRaw: "10000000",
      targetPrice: "0.4",
      minimumGrossProceedsRaw: "4000000",
      maximumFeeRaw: "1000000",
      minimumNetProceedsRaw: "3600000",
      venueExpiresAt: VENUE_EXPIRES_AT,
      venueExpiresAtUnix: VENUE_EXPIRES_UNIX,
      postOnlyRequested: true,
      partialFillAllowed: true,
    },
    observed: {
      status: "LIVE",
      side: "SELL",
      orderType: "GTD",
      originalSharesRaw: "10000000",
      matchedSharesRaw: "0",
      price: "0.4",
      expiration: VENUE_EXPIRES_UNIX,
      createdAt: ORDER_CREATED_AT,
      fetchedAt: "2026-07-21T02:00:13.000Z",
    },
    checks: {
      canonicalTakeProfitIntentHash: true,
      trustedIssuerSignature: true,
      verifiedSourcePositionBound: true,
      selectedOutcomeToken: true,
      exactCredentialOwner: true,
      exactDepositWallet: true,
      exactOrderId: true,
      exactGtdSell: true,
      exactSharesOffered: true,
      zeroInitiallyMatched: true,
      targetPriceBound: true,
      venueExpiryBound: true,
      orderCreatedAfterConfirmation: true,
      orderCreatedInsideSignedPlacementWindow: true,
    },
  };
  const passport = {
    version: "conviction-take-profit-passport-v1",
    status: "ARMED",
    issuance: issued.issuance,
    intent: issued.intent,
    restingOrderProof: proof,
  };
  return {
    version: "conviction-take-profit-journey-v1",
    action: "TAKE_PROFIT",
    stage: "armed",
    status: "ARMED",
    signerAddress: SIGNER,
    depositWallet: WALLET,
    orderId: ORDER_ID,
    intentHash: issued.intentHash,
    takeProfitPassport: passport,
    takeProfitPassportHash: sha256(passport),
    restingOrderProofHash: sha256(proof),
  };
}

function orderSnapshot({ matched = "10", status = "MATCHED", trades = [TRADE_1, TRADE_2] } = {}) {
  return {
    version: "conviction-polymarket-order-snapshot-v1",
    verificationSource: "authenticated-polymarket-clob",
    onChain: false,
    fetchedAt: "2026-07-21T02:10:00.000Z",
    signerAddress: SIGNER,
    depositWallet: WALLET,
    credentialOwnerVerified: true,
    order: {
      id: ORDER_ID,
      status,
      market: LIVE_MARKET_SNAPSHOT.conditionId,
      assetId: LIVE_MARKET_SNAPSHOT.yesTokenId,
      side: "SELL",
      originalSize: "10",
      sizeMatched: matched,
      price: "0.4",
      orderType: "GTD",
      expiration: VENUE_EXPIRES_UNIX,
      outcome: "YES",
      createdAt: ORDER_CREATED_AT,
      associatedTrades: trades,
    },
  };
}

function contribution({ tradeId, transactionHash, shares, price }) {
  const sharesRaw = BigInt(Math.round(Number(shares) * 1_000_000)).toString();
  const priceRaw = BigInt(Math.round(Number(price) * 1_000_000)).toString();
  return {
    tradeId,
    orderRole: "MAKER",
    orderId: ORDER_ID,
    marketConditionId: LIVE_MARKET_SNAPSHOT.conditionId,
    outcomeTokenId: LIVE_MARKET_SNAPSHOT.yesTokenId,
    side: "SELL",
    depositWallet: WALLET,
    matchedShares: String(shares),
    matchedSharesRaw: sharesRaw,
    price: String(price),
    priceRaw,
    status: "CONFIRMED",
    venueStatus: "CONFIRMED",
    transactionHash,
  };
}

function tradeContributions(overrides = {}) {
  const contributions = overrides.contributions || [
    contribution({ tradeId: TRADE_1, transactionHash: TX_1, shares: "4", price: "0.45" }),
    contribution({ tradeId: TRADE_2, transactionHash: TX_2, shares: "6", price: "0.5" }),
  ];
  return {
    version: "conviction-polymarket-associated-trades-v1",
    verificationSource: "authenticated-polymarket-clob",
    onChain: false,
    fetchedAt: "2026-07-21T02:10:00.500Z",
    signerAddress: SIGNER,
    depositWallet: WALLET,
    orderId: ORDER_ID,
    marketConditionId: LIVE_MARKET_SNAPSHOT.conditionId,
    outcomeTokenId: LIVE_MARKET_SNAPSHOT.yesTokenId,
    associatedTradeIds: overrides.associatedTradeIds || contributions.map(({ tradeId }) => tradeId),
    transactionHashes: overrides.transactionHashes || [...new Set(contributions.map(({ transactionHash }) => transactionHash))],
    contributions,
    ...overrides,
  };
}

function receipt({
  transactionHash,
  blockHash,
  blockNumber,
  sharesRaw,
  grossRaw,
  feeRaw,
  orderId = ORDER_ID,
  wallet = WALLET,
  tokenId = LIVE_MARKET_SNAPSHOT.yesTokenId,
  exchange = EXCHANGE,
  side = 1n,
  status = "0x1",
  includeOutcome = true,
  includeCollateral = true,
  duplicateFill = false,
  builder = 0n,
  metadata = 0n,
} = {}) {
  const netRaw = BigInt(grossRaw) - BigInt(feeRaw);
  const logs = [];
  let logIndex = 1;
  if (includeOutcome) {
    logs.push({
      address: CTF,
      topics: [
        "0xc3d58168c5ae7397731d063d5bbf3d657854427343f4c083240f7aacaa2d0f62",
        topicAddress(EXCHANGE),
        topicAddress(wallet),
        topicAddress(COUNTERPARTY),
      ],
      data: `0x${word(tokenId)}${word(sharesRaw)}`,
      logIndex: `0x${(logIndex++).toString(16)}`,
    });
  }
  if (includeCollateral) {
    logs.push({
      address: PUSD,
      topics: [
        "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef",
        topicAddress(COUNTERPARTY),
        topicAddress(wallet),
      ],
      data: `0x${word(netRaw)}`,
      logIndex: `0x${(logIndex++).toString(16)}`,
    });
  }
  const fillLog = {
    address: exchange,
    topics: [
      "0xd543adfd945773f1a62f74f0ee55a5e3b9b1a28262980ba90b1a89f2ea84d8ee",
      orderId,
      topicAddress(wallet),
      topicAddress(COUNTERPARTY),
    ],
    data: `0x${[
      side,
      BigInt(tokenId),
      BigInt(sharesRaw),
      BigInt(grossRaw),
      BigInt(feeRaw),
      BigInt(builder),
      BigInt(metadata),
    ].map(word).join("")}`,
    logIndex: `0x${(logIndex++).toString(16)}`,
  };
  logs.push(fillLog);
  if (duplicateFill) logs.push({ ...fillLog });
  return {
    transactionHash,
    blockNumber,
    blockHash,
    status,
    to: exchange,
    logs,
  };
}

function block({ number, hash, timestamp }) {
  return { number, hash, timestamp: `0x${BigInt(timestamp).toString(16)}` };
}

function settlementFixtures() {
  return [
    {
      transactionHash: TX_1,
      receipt: receipt({
        transactionHash: TX_1,
        blockHash: BLOCK_1,
        blockNumber: "0x101",
        sharesRaw: 4_000_000n,
        grossRaw: 1_800_000n,
        feeRaw: 180_000n,
      }),
      block: block({ number: "0x101", hash: BLOCK_1, timestamp: "1784599560" }),
    },
    {
      transactionHash: TX_2,
      receipt: receipt({
        transactionHash: TX_2,
        blockHash: BLOCK_2,
        blockNumber: "0x102",
        sharesRaw: 6_000_000n,
        grossRaw: 3_000_000n,
        feeRaw: 300_000n,
      }),
      block: block({ number: "0x102", hash: BLOCK_2, timestamp: "1784599620" }),
    },
  ];
}

function input(overrides = {}) {
  return {
    chainId: 137,
    journal: fixtureJournal(),
    orderSnapshot: orderSnapshot(),
    tradeContributions: tradeContributions(),
    settlements: settlementFixtures(),
    finalizedBlock: { number: "0x200", hash: FINALIZED_BLOCK },
    ...overrides,
  };
}

function options(now = VERIFY_NOW) {
  return { now, trustedIssuers };
}

function errorCode(fn, code) {
  assert.throws(fn, (error) => error instanceof ConvictionError && error.code === code);
}

test("verifies and aggregates a full take-profit fill across independent Polygon settlements", () => {
  const result = verifyTakeProfitAggregateFill(input(), options());
  assert.equal(result.ok, true);
  assert.equal(result.proof.version, "conviction-take-profit-fill-proof-v1");
  assert.equal(result.proof.status, "FILLED");
  assert.equal(result.proof.onChain, true);
  assert.equal(result.proof.fill.actualSharesRaw, "10000000");
  assert.equal(result.proof.fill.actualGrossProceedsRaw, "4800000");
  assert.equal(result.proof.fill.actualFeeRaw, "480000");
  assert.equal(result.proof.fill.actualNetProceedsRaw, "4320000");
  assert.equal(result.proof.fill.actualAveragePriceFloor, "0.48");
  assert.equal(result.proof.fill.remainingSharesRaw, "0");
  assert.equal(result.proof.transactionCount, 2);
  assert.equal(result.proof.tradeCount, 2);
  assert.equal(result.proof.settlements[0].checks.exactOutcomeDebit, true);
  assert.match(result.proofHash, /^0x[0-9a-f]{64}$/);
  assert.equal(result.proof.finality.status, "FINALIZED");
});

test("proves a partial fill against proportional gross, fee, and net bounds", () => {
  const contributions = tradeContributions({
    contributions: [contribution({ tradeId: TRADE_1, transactionHash: TX_1, shares: "4", price: "0.45" })],
  });
  const result = verifyTakeProfitAggregateFill(input({
    orderSnapshot: orderSnapshot({ matched: "4", status: "LIVE", trades: [TRADE_1] }),
    tradeContributions: contributions,
    settlements: [settlementFixtures()[0]],
  }), options());
  assert.equal(result.proof.status, "PARTIALLY_FILLED_ACTIVE");
  assert.equal(result.proof.lifecycle.cancelEligible, true);
  assert.equal(result.proof.lifecycle.orderTerminal, false);
  assert.equal(result.proof.fill.actualSharesRaw, "4000000");
  assert.equal(result.proof.fill.proportionalGrossFloorRaw, "1600000");
  assert.equal(result.proof.fill.proportionalNetFloorRaw, "1440000");
  assert.equal(result.proof.fill.remainingSharesRaw, "6000000");
});

test("preserves active, canceled, and expired partial-order lifecycle state", () => {
  const contributions = tradeContributions({
    contributions: [contribution({ tradeId: TRADE_1, transactionHash: TX_1, shares: "4", price: "0.45" })],
  });
  const base = {
    tradeContributions: contributions,
    settlements: [settlementFixtures()[0]],
  };
  const active = verifyTakeProfitAggregateFill(input({
    ...base,
    orderSnapshot: orderSnapshot({ matched: "4", status: "LIVE", trades: [TRADE_1] }),
  }), options());
  const canceled = verifyTakeProfitAggregateFill(input({
    ...base,
    orderSnapshot: orderSnapshot({ matched: "4", status: "CANCELED", trades: [TRADE_1] }),
  }), options());
  const expired = verifyTakeProfitAggregateFill(input({
    ...base,
    orderSnapshot: orderSnapshot({ matched: "4", status: "EXPIRED", trades: [TRADE_1] }),
  }), options());
  assert.equal(active.proof.status, "PARTIALLY_FILLED_ACTIVE");
  assert.equal(active.proof.lifecycle.cancelEligible, true);
  assert.equal(canceled.proof.status, "PARTIALLY_FILLED_CANCELED");
  assert.equal(canceled.proof.lifecycle.orderTerminal, true);
  assert.equal(canceled.proof.lifecycle.cancellationObserved, true);
  assert.equal(expired.proof.status, "PARTIALLY_FILLED_EXPIRED");
  assert.equal(expired.proof.lifecycle.orderTerminal, true);
  assert.equal(expired.proof.lifecycle.cancellationObserved, false);
});

test("labels included but unfinalized Polygon receipts as provisional", () => {
  const result = verifyTakeProfitAggregateFill(input({
    finalizedBlock: { number: "0x100", hash: FINALIZED_BLOCK },
  }), options());
  assert.equal(result.proof.status, "FILLED_PROVISIONAL");
  assert.equal(result.proof.fillState, "FILLED");
  assert.equal(result.proof.finality.status, "PROVISIONAL");
  assert.equal(result.proof.finality.finalized, false);
  assert.equal(result.proof.settlements.every(({ finalized }) => finalized === false), true);
});

test("groups multiple authenticated trade contributions into one Polygon settlement", () => {
  const contributions = tradeContributions({
    contributions: [
      contribution({ tradeId: TRADE_1, transactionHash: TX_1, shares: "4", price: "0.45" }),
      contribution({ tradeId: TRADE_2, transactionHash: TX_1, shares: "6", price: "0.5" }),
    ],
  });
  const combined = {
    transactionHash: TX_1,
    receipt: receipt({
      transactionHash: TX_1,
      blockHash: BLOCK_1,
      blockNumber: "0x101",
      sharesRaw: 10_000_000n,
      grossRaw: 4_800_000n,
      feeRaw: 480_000n,
    }),
    block: block({ number: "0x101", hash: BLOCK_1, timestamp: "1784599560" }),
  };
  const result = verifyTakeProfitAggregateFill(input({
    tradeContributions: contributions,
    settlements: [combined],
  }), options());
  assert.equal(result.proof.transactionCount, 1);
  assert.equal(result.proof.tradeCount, 2);
  assert.deepEqual(result.proof.settlements[0].tradeIds, [TRADE_2, TRADE_1].sort());
  assert.equal(result.proof.fill.actualGrossProceedsRaw, "4800000");
});

test("reconciles valid per-trade integer flooring and records nonzero V2 metadata", () => {
  const contributions = tradeContributions({
    contributions: [contribution({
      tradeId: TRADE_1,
      transactionHash: TX_1,
      shares: "0.000003",
      price: "0.5",
    })],
  });
  const settlement = {
    transactionHash: TX_1,
    receipt: receipt({
      transactionHash: TX_1,
      blockHash: BLOCK_1,
      blockNumber: "0x101",
      sharesRaw: 3n,
      grossRaw: 1n,
      feeRaw: 0n,
      builder: 7n,
      metadata: 9n,
    }),
    block: block({ number: "0x101", hash: BLOCK_1, timestamp: "1784599560" }),
  };
  const result = verifyTakeProfitAggregateFill(input({
    orderSnapshot: orderSnapshot({ matched: "0.000003", status: "LIVE", trades: [TRADE_1] }),
    tradeContributions: contributions,
    settlements: [settlement],
  }), options());
  assert.equal(result.proof.status, "PARTIALLY_FILLED_ACTIVE");
  assert.equal(result.proof.fill.actualGrossProceedsRaw, "1");
  assert.deepEqual(result.proof.settlements[0].builders, [`0x${word(7n)}`]);
  assert.deepEqual(result.proof.settlements[0].metadata, [`0x${word(9n)}`]);
});

test("fetches every unique receipt and block through the injected Polygon RPC seam", async () => {
  const values = new Map([
    [TX_1, settlementFixtures()[0]],
    [TX_2, settlementFixtures()[1]],
  ]);
  const calls = [];
  const result = await fetchAndVerifyTakeProfitAggregateFill({
    journal: fixtureJournal(),
    orderSnapshot: orderSnapshot(),
    tradeContributions: tradeContributions(),
  }, {
    ...options(),
    rpcCall: async (method, params) => {
      calls.push([method, params]);
      if (method === "eth_chainId") return "0x89";
      if (method === "eth_getTransactionReceipt") return values.get(params[0]).receipt;
      if (method === "eth_getBlockByNumber") {
        if (params[0] === "finalized") return { number: "0x200", hash: FINALIZED_BLOCK };
        return [...values.values()].find((value) => value.receipt.blockNumber === params[0]).block;
      }
      throw new Error(`unexpected method ${method}`);
    },
  });
  assert.equal(result.proof.transactionCount, 2);
  assert.equal(calls.filter(([method]) => method === "eth_getTransactionReceipt").length, 2);
  assert.equal(calls.filter(([method]) => method === "eth_getBlockByNumber").length, 3);
});

test("fails closed on duplicate trade, transaction, settlement, or receipt-log evidence", () => {
  const duplicateTrade = tradeContributions();
  duplicateTrade.contributions = [duplicateTrade.contributions[0], duplicateTrade.contributions[0]];
  duplicateTrade.associatedTradeIds = [TRADE_1];
  duplicateTrade.transactionHashes = [TX_1];
  errorCode(
    () => verifyTakeProfitAggregateFill(input({
      orderSnapshot: orderSnapshot({ matched: "4", trades: [TRADE_1] }),
      tradeContributions: duplicateTrade,
      settlements: [settlementFixtures()[0]],
    }), options()),
    "trade_contribution_mismatch",
  );

  const duplicateTransactions = tradeContributions();
  duplicateTransactions.transactionHashes = [TX_1, TX_1, TX_2];
  errorCode(
    () => verifyTakeProfitAggregateFill(input({ tradeContributions: duplicateTransactions }), options()),
    "duplicate_settlement_transaction",
  );

  errorCode(
    () => verifyTakeProfitAggregateFill(input({ settlements: [settlementFixtures()[0], settlementFixtures()[0]] }), options()),
    "duplicate_settlement_transaction",
  );

  const duplicatedLog = settlementFixtures();
  duplicatedLog[0].receipt = receipt({
    transactionHash: TX_1,
    blockHash: BLOCK_1,
    blockNumber: "0x101",
    sharesRaw: 4_000_000n,
    grossRaw: 1_800_000n,
    feeRaw: 180_000n,
    duplicateFill: true,
  });
  errorCode(
    () => verifyTakeProfitAggregateFill(input({ settlements: duplicatedLog }), options()),
    "duplicate_receipt_log",
  );
});

test("fails closed on order, wallet, market, token, side, and status substitutions", () => {
  const mutations = [
    ["orderId", `0x${"9".repeat(64)}`, "trade_identity_mismatch"],
    ["depositWallet", "0x3333333333333333333333333333333333333333", "trade_identity_mismatch"],
    ["marketConditionId", `0x${"8".repeat(64)}`, "trade_identity_mismatch"],
    ["outcomeTokenId", LIVE_MARKET_SNAPSHOT.noTokenId, "trade_identity_mismatch"],
    ["side", "BUY", "trade_identity_mismatch"],
    ["status", "PENDING", "trade_identity_mismatch"],
    ["orderRole", "TAKER", "trade_role_mismatch"],
  ];
  for (const [field, value, code] of mutations) {
    const trades = tradeContributions();
    trades.contributions[0] = { ...trades.contributions[0], [field]: value };
    errorCode(() => verifyTakeProfitAggregateFill(input({ tradeContributions: trades }), options()), code);
  }
});

test("fails closed on failed, missing, substituted, or expired Polygon settlement evidence", () => {
  const cases = [
    [(values) => { values[0].receipt.status = "0x0"; }, "failed_transaction"],
    [(values) => { values[0].receipt.to = "0x3333333333333333333333333333333333333333"; }, "wrong_exchange"],
    [(values) => { values[0].receipt.logs.at(-1).topics[2] = topicAddress("0x3333333333333333333333333333333333333333"); }, "take_profit_fill_substitution"],
    [(values) => { values[0].receipt.logs.at(-1).topics[3] = topicAddress(EXCHANGE); }, "trade_role_mismatch"],
    [(values) => { values[0].receipt.logs.at(-1).data = `0x${[1n, BigInt(LIVE_MARKET_SNAPSHOT.noTokenId), 4_000_000n, 1_800_000n, 180_000n, 0n, 0n].map(word).join("")}`; }, "take_profit_fill_substitution"],
    [(values) => { values[0].receipt.logs = values[0].receipt.logs.filter((log) => lowerAddress(log.address) !== CTF); }, "missing_outcome_debit"],
    [(values) => { values[0].receipt.logs = values[0].receipt.logs.filter((log) => lowerAddress(log.address) !== PUSD); }, "missing_collateral_credit"],
    [(values) => { values[0].receipt.logs[0].removed = true; }, "removed_receipt_log"],
    [(values) => { values[0].block.timestamp = `0x${BigInt(VENUE_EXPIRES_UNIX) + 1n}`; }, "settlement_after_expiry"],
  ];
  for (const [mutate, code] of cases) {
    const values = settlementFixtures();
    mutate(values);
    errorCode(() => verifyTakeProfitAggregateFill(input({ settlements: values }), options()), code);
  }
});

function lowerAddress(value) {
  return String(value || "").toLowerCase();
}

test("fails closed on overfill, crossed target, trade-proceeds mismatch, and excess fee", () => {
  const overfill = settlementFixtures();
  overfill[1].receipt = receipt({
    transactionHash: TX_2,
    blockHash: BLOCK_2,
    blockNumber: "0x102",
    sharesRaw: 11_000_000n,
    grossRaw: 5_500_000n,
    feeRaw: 550_000n,
  });
  errorCode(() => verifyTakeProfitAggregateFill(input({ settlements: overfill }), options()), "take_profit_overfill");

  const crossedContributions = tradeContributions();
  crossedContributions.contributions[0] = contribution({
    tradeId: TRADE_1,
    transactionHash: TX_1,
    shares: "4",
    price: "0.39",
  });
  const crossedSettlements = settlementFixtures();
  crossedSettlements[0].receipt = receipt({
    transactionHash: TX_1,
    blockHash: BLOCK_1,
    blockNumber: "0x101",
    sharesRaw: 4_000_000n,
    grossRaw: 1_560_000n,
    feeRaw: 156_000n,
  });
  errorCode(
    () => verifyTakeProfitAggregateFill(input({
      tradeContributions: crossedContributions,
      settlements: crossedSettlements,
    }), options()),
    "price_below_bound",
  );

  const wrongReportedPrice = tradeContributions();
  wrongReportedPrice.contributions[0] = contribution({
    tradeId: TRADE_1,
    transactionHash: TX_1,
    shares: "4",
    price: "0.46",
  });
  errorCode(
    () => verifyTakeProfitAggregateFill(input({ tradeContributions: wrongReportedPrice }), options()),
    "trade_proceeds_mismatch",
  );

  const excessFee = settlementFixtures();
  excessFee[0].receipt = receipt({
    transactionHash: TX_1,
    blockHash: BLOCK_1,
    blockNumber: "0x101",
    sharesRaw: 4_000_000n,
    grossRaw: 1_800_000n,
    feeRaw: 500_000n,
  });
  errorCode(() => verifyTakeProfitAggregateFill(input({ settlements: excessFee }), options()), "fee_above_bound");

  const roundingTrades = tradeContributions({
    contributions: [
      contribution({ tradeId: TRADE_1, transactionHash: TX_1, shares: "0.000001", price: "1" }),
      contribution({ tradeId: TRADE_2, transactionHash: TX_2, shares: "0.000001", price: "1" }),
    ],
  });
  const roundingSettlements = [
    {
      transactionHash: TX_1,
      receipt: receipt({
        transactionHash: TX_1,
        blockHash: BLOCK_1,
        blockNumber: "0x101",
        sharesRaw: 1n,
        grossRaw: 1n,
        feeRaw: 1n,
      }),
      block: block({ number: "0x101", hash: BLOCK_1, timestamp: "1784599560" }),
    },
    {
      transactionHash: TX_2,
      receipt: receipt({
        transactionHash: TX_2,
        blockHash: BLOCK_2,
        blockNumber: "0x102",
        sharesRaw: 1n,
        grossRaw: 1n,
        feeRaw: 1n,
      }),
      block: block({ number: "0x102", hash: BLOCK_2, timestamp: "1784599620" }),
    },
  ];
  errorCode(
    () => verifyTakeProfitAggregateFill(input({
      orderSnapshot: orderSnapshot({ matched: "0.000002", status: "LIVE" }),
      tradeContributions: roundingTrades,
      settlements: roundingSettlements,
    }), options()),
    "fee_above_bound",
  );
});

test("fails closed when exact-order matched shares or associated trades do not reconcile", () => {
  errorCode(
    () => verifyTakeProfitAggregateFill(input({
      orderSnapshot: orderSnapshot({ matched: "9" }),
    }), options()),
    "order_matched_shares_mismatch",
  );
  errorCode(
    () => verifyTakeProfitAggregateFill(input({
      orderSnapshot: orderSnapshot({ trades: [TRADE_1] }),
    }), options()),
    "associated_trade_mismatch",
  );
  errorCode(
    () => verifyTakeProfitAggregateFill(input({
      orderSnapshot: orderSnapshot({ matched: "0", status: "LIVE", trades: [] }),
      tradeContributions: tradeContributions({ contributions: [] }),
      settlements: [],
    }), options()),
    "take_profit_not_filled",
  );
});

test("fails closed when the injected RPC omits a receipt or returns another chain", async () => {
  await assert.rejects(
    fetchAndVerifyTakeProfitAggregateFill({
      journal: fixtureJournal(),
      orderSnapshot: orderSnapshot(),
      tradeContributions: tradeContributions(),
    }, {
      ...options(),
      rpcCall: async (method) => method === "eth_chainId" ? "0x89" : null,
    }),
    (error) => error instanceof ConvictionError && error.code === "missing_receipt",
  );
  await assert.rejects(
    fetchAndVerifyTakeProfitAggregateFill({
      journal: fixtureJournal(),
      orderSnapshot: orderSnapshot(),
      tradeContributions: tradeContributions(),
    }, {
      ...options(),
      rpcCall: async (method, params) => {
        if (method === "eth_chainId") return "0x1";
        if (method === "eth_getTransactionReceipt") {
          return settlementFixtures().find((value) => value.transactionHash === params[0]).receipt;
        }
        return settlementFixtures().find((value) => value.receipt.blockNumber === params[0]).block;
      },
    }),
    (error) => error instanceof ConvictionError && error.code === "wrong_chain",
  );
});
