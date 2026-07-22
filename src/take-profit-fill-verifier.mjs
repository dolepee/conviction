import { sha256 } from "./canonical.mjs";
import {
  CONTRACTS,
  POLYGON_CHAIN_ID,
  POLYGON_RPC_URL,
  TOPICS,
} from "./constants.mjs";
import { formatDecimal, parseDecimal, parseHexUint } from "./decimal.mjs";
import { ConvictionError, invariant } from "./errors.mjs";
import {
  buildTakeProfitStatus,
  validateTakeProfitJournal,
} from "./take-profit-lifecycle.mjs";

const ADDRESS_RE = /^0x[0-9a-f]{40}$/;
const HASH_RE = /^0x[0-9a-f]{64}$/;
const UINT_RE = /^(?:0|[1-9][0-9]*)$/;
const SHARE_DECIMALS = 6;
const PRICE_SCALE = 1_000_000n;
const BPS_SCALE = 10_000n;
const MAX_FUTURE_SKEW_MS = 1_000;
const DEFAULT_MAX_TRADE_SNAPSHOT_AGE_MS = 30_000;
const MAX_ASSOCIATED_TRADES = 100;
const ERC1155_TRANSFER_BATCH_TOPIC =
  "0x4a39dc06d4c0dbc64b70af90fd698a233a518aa5d07e595d983b8c0526c8f7fb";

function ceilDiv(numerator, denominator) {
  return (numerator + denominator - 1n) / denominator;
}

function lower(value) {
  return String(value || "").toLowerCase();
}

function record(value, code, message) {
  invariant(value !== null && typeof value === "object" && !Array.isArray(value), code, message);
  return value;
}

function canonicalHash(value, code, label) {
  const hash = lower(value);
  invariant(HASH_RE.test(hash), code, `${label} is invalid`);
  invariant(String(value) === hash, code, `${label} must be lowercase`);
  return hash;
}

function canonicalAddress(value, code, label) {
  const address = lower(value);
  invariant(ADDRESS_RE.test(address), code, `${label} is invalid`);
  invariant(String(value) === address, code, `${label} must be lowercase`);
  return address;
}

function uint(value, code, label, { positive = false } = {}) {
  const text = String(value ?? "");
  invariant(UINT_RE.test(text), code, `${label} must be an unsigned integer`);
  const parsed = BigInt(text);
  invariant(!positive || parsed > 0n, code, `${label} must be positive`);
  return parsed;
}

function canonicalIso(value, code, label) {
  const text = String(value || "");
  const milliseconds = Date.parse(text);
  invariant(
    Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === text,
    code,
    `${label} must be a canonical ISO timestamp`,
  );
  return { text, milliseconds };
}

function nowMilliseconds(value) {
  const milliseconds = value === undefined
    ? Date.now()
    : value instanceof Date
      ? value.getTime()
      : typeof value === "number"
        ? value
        : Date.parse(String(value));
  invariant(Number.isFinite(milliseconds), "invalid_fill_clock", "Take-profit fill verifier clock is invalid");
  return milliseconds;
}

function topicAddress(topic) {
  invariant(/^0x[0-9a-f]{64}$/i.test(topic || ""), "invalid_receipt", "Receipt has an invalid address topic");
  return `0x${topic.slice(-40)}`.toLowerCase();
}

function words(data) {
  invariant(/^0x(?:[0-9a-f]{64})+$/i.test(data || ""), "invalid_receipt", "Receipt has invalid event data");
  return data.slice(2).match(/.{64}/g).map((word) => BigInt(`0x${word}`));
}

function assertUnique(values, code, message) {
  invariant(new Set(values).size === values.length, code, message);
}

function safeTradeId(value, code = "invalid_trade_contributions") {
  const id = String(value ?? "");
  invariant(
    id === id.trim() && id.length > 0 && id.length <= 256 &&
      !/[\u0000-\u001f\u007f]/.test(id),
    code,
    "Associated trade ID is invalid",
  );
  return id;
}

function assertExactSet(actual, expected, code, message) {
  assertUnique(actual, code, message);
  assertUnique(expected, code, message);
  invariant(
    actual.length === expected.length && actual.every((value) => expected.includes(value)),
    code,
    message,
  );
}

function signedBounds(binding) {
  const { intent, restingOrderProof: armedProof } = binding.passport;
  const market = record(intent.market, "invalid_take_profit_intent", "Take-profit market is missing");
  const order = record(intent.order, "invalid_take_profit_intent", "Take-profit order is missing");
  const position = record(intent.position, "invalid_take_profit_intent", "Take-profit position is missing");
  const proceeds = record(intent.proceeds, "invalid_take_profit_intent", "Take-profit proceeds policy is missing");
  invariant(
    market.source === "polymarket" && market.negRisk === false &&
      lower(market.exchange) === CONTRACTS.standardExchangeV2 &&
      lower(market.collateral) === CONTRACTS.pUsd &&
      lower(market.conditionalTokens) === CONTRACTS.ctf,
    "venue_contract_mismatch",
    "Take-profit intent is not pinned to the supported Polymarket V2 contracts",
  );
  invariant(
    lower(market.conditionId) === binding.marketConditionId &&
      String(market.outcomeTokenId || "") === binding.outcomeTokenId &&
      market.outcome === binding.outcome,
    "take_profit_identity_mismatch",
    "Take-profit market identity differs from the ARMED passport",
  );
  const counterOutcome = binding.outcome === "YES" ? "NO" : "YES";
  const selectedToken = String(market.outcomes?.[binding.outcome]?.tokenId || "");
  const counterToken = String(market.outcomes?.[counterOutcome]?.tokenId || "");
  invariant(
    selectedToken === binding.outcomeTokenId && UINT_RE.test(counterToken) &&
      counterToken !== binding.outcomeTokenId && String(market.counterOutcomeTokenId || "") === counterToken,
    "take_profit_token_mapping_mismatch",
    "Take-profit binary outcome-token mapping is inconsistent",
  );
  invariant(
    order.action === "TAKE_PROFIT" && order.side === "SELL" && order.orderType === "GTD" &&
      order.postOnly === true && order.outcome === binding.outcome &&
      String(order.outcomeTokenId || "") === binding.outcomeTokenId,
    "invalid_take_profit_intent",
    "Take-profit intent is not the pinned post-only GTD SELL",
  );

  const shareCapRaw = uint(order.sharesRaw, "invalid_take_profit_economics", "Signed share cap", { positive: true });
  const targetPriceRaw = parseDecimal(order.targetPrice, SHARE_DECIMALS, "Take-profit target price");
  const minimumGrossProceedsRaw = uint(
    order.minimumGrossProceedsRaw,
    "invalid_take_profit_economics",
    "Signed minimum gross proceeds",
    { positive: true },
  );
  const feeAtTargetPriceRaw = uint(
    order.feeAtTargetPriceRaw,
    "invalid_take_profit_economics",
    "Signed target-price fee threshold",
  );
  const maximumFeeRaw = uint(order.maximumFeeRaw, "invalid_take_profit_economics", "Signed maximum fee");
  const minimumNetProceedsRaw = uint(
    order.minimumNetProceedsRaw,
    "invalid_take_profit_economics",
    "Signed minimum net proceeds",
  );
  const feeBps = Number(order.feeRateBpsMax);
  invariant(
    Number.isInteger(feeBps) && feeBps >= 0 && feeBps <= Number(BPS_SCALE) && order.feeBps === feeBps,
    "invalid_take_profit_economics",
    "Signed take-profit fee-rate cap is invalid",
  );
  invariant(
    targetPriceRaw > 0n && targetPriceRaw < PRICE_SCALE &&
      shareCapRaw * targetPriceRaw === minimumGrossProceedsRaw * PRICE_SCALE,
    "invalid_take_profit_economics",
    "Signed take-profit shares, target, and gross minimum disagree",
  );
  invariant(
    feeAtTargetPriceRaw === ceilDiv(minimumGrossProceedsRaw * BigInt(feeBps), BPS_SCALE) &&
      maximumFeeRaw === ceilDiv(shareCapRaw * BigInt(feeBps), BPS_SCALE) &&
      minimumNetProceedsRaw === minimumGrossProceedsRaw - feeAtTargetPriceRaw,
    "invalid_take_profit_economics",
    "Signed take-profit fee and net bounds disagree",
  );
  invariant(
    order.shares === formatDecimal(shareCapRaw, SHARE_DECIMALS) &&
      order.minimumGrossProceeds === formatDecimal(minimumGrossProceedsRaw, SHARE_DECIMALS) &&
      order.feeAtTargetPrice === formatDecimal(feeAtTargetPriceRaw, SHARE_DECIMALS) &&
      order.maximumFee === formatDecimal(maximumFeeRaw, SHARE_DECIMALS) &&
      order.minimumNetProceeds === formatDecimal(minimumNetProceedsRaw, SHARE_DECIMALS),
    "invalid_take_profit_economics",
    "Signed formatted take-profit economics disagree",
  );
  invariant(
    order.feeSource === "polymarket_clob_maker_base_fee" &&
      order.feeReserveMethod === "target=ceil(minimumGrossProceeds*feeBps/10000);absolute=ceil(shares*feeBps/10000)" &&
      order.feeEnforcement === "post-settlement-verification-only" &&
      order.proceedsPrecision === "v2-cent-aligned-whole-shares",
    "invalid_take_profit_economics",
    "Take-profit fee or precision policy is unsupported",
  );
  invariant(
    proceeds.minimumGrossProceeds === order.minimumGrossProceeds &&
      proceeds.feeAtTargetPrice === order.feeAtTargetPrice &&
      proceeds.maximumFee === order.maximumFee &&
      proceeds.minimumNetProceeds === order.minimumNetProceeds &&
      proceeds.grossProceedsPreventivelyEnforced === true &&
      proceeds.feeAndNetPreventivelyEnforced === false &&
      proceeds.feeAndNetEnforcement === "post-settlement-verification-only" &&
      proceeds.exactSharesOffered === true && proceeds.partialFillAllowed === true &&
      proceeds.restingOrder === true && proceeds.postOnlyRequested === true,
    "invalid_take_profit_economics",
    "Take-profit proceeds policy differs from the signed order",
  );
  invariant(
    position.wallet === binding.depositWallet &&
      String(position.outcomeTokenId || "") === binding.outcomeTokenId &&
      position.approvedForExchange === true &&
      uint(position.requestedTakeProfitSharesRaw, "invalid_take_profit_position", "Requested take-profit shares") === shareCapRaw &&
      uint(position.availableSharesRaw, "invalid_take_profit_position", "Available take-profit shares") >= shareCapRaw,
    "invalid_take_profit_position",
    "Take-profit position snapshot differs from the signed order",
  );
  invariant(
    armedProof.bounds.minimumGrossProceedsRaw === minimumGrossProceedsRaw.toString() &&
      armedProof.bounds.maximumFeeRaw === maximumFeeRaw.toString() &&
      armedProof.bounds.minimumNetProceedsRaw === minimumNetProceedsRaw.toString(),
    "take_profit_passport_mismatch",
    "ARMED proof economic bounds differ from the signed take-profit order",
  );
  return Object.freeze({
    shareCapRaw,
    targetPriceRaw,
    minimumGrossProceedsRaw,
    feeAtTargetPriceRaw,
    maximumFeeRaw,
    minimumNetProceedsRaw,
    feeBps,
  });
}

function normalizeTradeContributions(binding, status, input, {
  now,
  maxTradeSnapshotAgeMs = DEFAULT_MAX_TRADE_SNAPSHOT_AGE_MS,
} = {}) {
  const snapshot = record(input, "invalid_trade_contributions", "Authenticated trade contributions are missing");
  invariant(
    snapshot.version === "conviction-polymarket-associated-trades-v1" &&
      snapshot.verificationSource === "authenticated-polymarket-clob" && snapshot.onChain === false,
    "invalid_trade_contributions",
    "Trade contributions must come from authenticated exact Polymarket trade lookups",
  );
  invariant(
    canonicalAddress(snapshot.signerAddress, "trade_identity_mismatch", "Trade signer") === binding.signerAddress &&
      canonicalAddress(snapshot.depositWallet, "trade_identity_mismatch", "Trade deposit wallet") === binding.depositWallet &&
      canonicalHash(snapshot.orderId, "trade_identity_mismatch", "Trade order ID") === binding.orderId &&
      canonicalHash(snapshot.marketConditionId, "trade_identity_mismatch", "Trade market condition ID") === binding.marketConditionId &&
      String(snapshot.outcomeTokenId || "") === binding.outcomeTokenId,
    "trade_identity_mismatch",
    "Authenticated trade contribution identity differs from the ARMED order",
  );
  invariant(Number.isSafeInteger(maxTradeSnapshotAgeMs) && maxTradeSnapshotAgeMs > 0, "invalid_trade_snapshot_age", "Maximum trade snapshot age is invalid");
  const observed = canonicalIso(snapshot.fetchedAt, "invalid_trade_contributions", "Trade contribution fetch time");
  const nowMs = nowMilliseconds(now);
  invariant(observed.milliseconds <= nowMs + MAX_FUTURE_SKEW_MS, "future_trade_snapshot", "Trade contribution snapshot is in the future");
  invariant(nowMs - observed.milliseconds <= maxTradeSnapshotAgeMs, "stale_trade_snapshot", "Trade contribution snapshot is stale");
  const orderObserved = canonicalIso(status.observedAt, "invalid_trade_contributions", "Exact-order snapshot time");
  invariant(observed.milliseconds >= orderObserved.milliseconds, "trade_snapshot_regression", "Trade contribution snapshot predates the exact-order snapshot");

  invariant(Array.isArray(snapshot.associatedTradeIds), "invalid_trade_contributions", "Associated trade IDs are missing");
  invariant(Array.isArray(snapshot.transactionHashes), "invalid_trade_contributions", "Settlement transaction hashes are missing");
  invariant(Array.isArray(snapshot.contributions) && snapshot.contributions.length > 0, "missing_trade_contributions", "No authenticated order contribution was found");
  invariant(
    snapshot.associatedTradeIds.length <= MAX_ASSOCIATED_TRADES &&
      snapshot.contributions.length <= MAX_ASSOCIATED_TRADES,
    "associated_trade_limit",
    "Take-profit fill proof has too many associated trades",
  );
  const associatedTradeIds = snapshot.associatedTradeIds.map((value) => safeTradeId(value));
  const orderTradeIds = status.order.associatedTrades.map(String);
  assertExactSet(
    associatedTradeIds,
    orderTradeIds,
    "associated_trade_mismatch",
    "Authenticated trade IDs differ from the pinned exact-order snapshot",
  );

  const contributions = snapshot.contributions.map((value, index) => {
    const contribution = record(value, "invalid_trade_contribution", `Trade contribution ${index + 1} is invalid`);
    const tradeId = safeTradeId(contribution.tradeId, "invalid_trade_contribution");
    const transactionHash = canonicalHash(
      contribution.transactionHash,
      "trade_transaction_mismatch",
      "Trade settlement transaction hash",
    );
    invariant(
      contribution.orderRole === "MAKER",
      "trade_role_mismatch",
      "A post-only ARMED take-profit must be attributed as the maker order",
    );
    invariant(
      canonicalHash(contribution.orderId, "trade_order_mismatch", "Trade order ID") === binding.orderId &&
        canonicalHash(contribution.marketConditionId, "trade_market_mismatch", "Trade market condition ID") === binding.marketConditionId &&
        String(contribution.outcomeTokenId || "") === binding.outcomeTokenId &&
        canonicalAddress(contribution.depositWallet, "trade_wallet_mismatch", "Trade deposit wallet") === binding.depositWallet &&
        contribution.side === "SELL" && contribution.status === "CONFIRMED",
      "trade_identity_mismatch",
      "Trade contribution is for another order, market, token, wallet, side, or status",
    );
    const matchedSharesRaw = uint(
      contribution.matchedSharesRaw,
      "invalid_trade_contribution",
      "Trade matched shares",
      { positive: true },
    );
    const priceRaw = uint(contribution.priceRaw, "invalid_trade_contribution", "Trade price", { positive: true });
    invariant(priceRaw <= PRICE_SCALE, "invalid_trade_contribution", "Trade price cannot exceed one pUSD");
    invariant(
      contribution.matchedShares === formatDecimal(matchedSharesRaw, SHARE_DECIMALS) &&
        contribution.price === formatDecimal(priceRaw, SHARE_DECIMALS),
      "invalid_trade_contribution",
      "Formatted trade contribution amounts differ from their raw values",
    );
    const venueStatus = String(contribution.venueStatus || "");
    invariant(
      venueStatus.length > 0 && venueStatus.length <= 64 && /^[A-Z0-9_]+$/.test(venueStatus),
      "invalid_trade_contribution",
      "Trade venue status is invalid",
    );
    return Object.freeze({
      tradeId,
      orderRole: contribution.orderRole,
      transactionHash,
      matchedSharesRaw,
      priceRaw,
      venueStatus,
    });
  });
  const contributionIds = contributions.map(({ tradeId }) => tradeId);
  assertExactSet(
    contributionIds,
    associatedTradeIds,
    "trade_contribution_mismatch",
    "Each associated trade must contribute exactly once",
  );
  const transactionHashes = snapshot.transactionHashes.map((value) =>
    canonicalHash(value, "invalid_trade_contributions", "Settlement transaction hash"));
  assertUnique(transactionHashes, "duplicate_settlement_transaction", "Settlement transaction hashes contain duplicates");
  const contributedHashes = [...new Set(contributions.map(({ transactionHash }) => transactionHash))];
  assertExactSet(
    transactionHashes,
    contributedHashes,
    "trade_transaction_mismatch",
    "Settlement transaction hashes differ from authenticated trade contributions",
  );

  const groups = transactionHashes.map((transactionHash) => ({
    transactionHash,
    contributions: contributions.filter((value) => value.transactionHash === transactionHash),
  }));
  return Object.freeze({
    snapshot,
    snapshotHash: sha256(snapshot),
    fetchedAt: observed.text,
    contributions: Object.freeze(contributions),
    groups: Object.freeze(groups),
  });
}

function settlementBlock(receipt, block, { venueExpiresAtUnix, orderCreatedAtUnix }) {
  const value = record(block, "missing_settlement_block", "Settlement block was not found");
  invariant(HASH_RE.test(lower(receipt.blockHash)), "invalid_receipt", "Receipt block hash is invalid");
  invariant(HASH_RE.test(lower(value.hash)), "invalid_settlement_block", "Settlement block hash is invalid");
  const receiptBlockNumber = parseHexUint(receipt.blockNumber, "receipt block number");
  const blockNumber = parseHexUint(value.number, "settlement block number");
  invariant(blockNumber === receiptBlockNumber, "settlement_block_mismatch", "Settlement block number differs from the receipt");
  invariant(lower(value.hash) === lower(receipt.blockHash), "settlement_block_mismatch", "Settlement block hash differs from the receipt");
  const timestamp = parseHexUint(value.timestamp, "settlement block timestamp");
  invariant(timestamp >= orderCreatedAtUnix, "settlement_before_order", "Settlement predates the pinned take-profit order");
  invariant(timestamp <= venueExpiresAtUnix, "settlement_after_expiry", "Settlement is later than the signed venue expiry");
  invariant(timestamp <= BigInt(Math.floor(Number.MAX_SAFE_INTEGER / 1_000)), "invalid_settlement_block", "Settlement timestamp is unsafe");
  return Object.freeze({
    blockNumber: Number(blockNumber),
    blockHash: lower(value.hash),
    settledAt: new Date(Number(timestamp) * 1_000).toISOString(),
  });
}

function uniqueReceiptLogs(receipt) {
  const logs = Array.isArray(receipt.logs) ? receipt.logs : [];
  invariant(logs.every((log) => log?.removed !== true), "removed_receipt_log", "Settlement receipt contains a removed log");
  const indexes = logs.map((log) => lower(log?.logIndex));
  invariant(indexes.every((value) => /^0x[0-9a-f]+$/.test(value)), "invalid_receipt", "Every settlement log must have a valid log index");
  assertUnique(indexes, "duplicate_receipt_log", "Settlement receipt contains duplicate log indexes");
  return logs;
}

function exactOrderFills(logs, { orderId, wallet, outcomeTokenId }) {
  const tokenId = BigInt(outcomeTokenId);
  const sameOrder = logs.filter((log) =>
    lower(log?.address) === CONTRACTS.standardExchangeV2 &&
      lower(log?.topics?.[0]) === TOPICS.orderFilled && lower(log?.topics?.[1]) === orderId);
  invariant(sameOrder.length > 0, "missing_take_profit_fill", "Pinned take-profit OrderFilled event was not found");
  return sameOrder.map((log) => {
    invariant(Array.isArray(log.topics) && log.topics.length === 4, "take_profit_fill_substitution", "Pinned OrderFilled topics are invalid");
    invariant(topicAddress(log.topics[2]) === wallet, "take_profit_fill_substitution", "Pinned OrderFilled maker is another wallet");
    const taker = topicAddress(log.topics[3]);
    invariant(
      taker !== CONTRACTS.standardExchangeV2,
      "trade_role_mismatch",
      "Pinned take-profit OrderFilled event is attributed as a taker-order fill",
    );
    const decoded = words(log.data);
    invariant(
      decoded.length === 7 && decoded[0] === 1n && decoded[1] === tokenId,
      "take_profit_fill_substitution",
      "Pinned OrderFilled side or token was substituted",
    );
    invariant(decoded[2] > 0n && decoded[3] > 0n && decoded[4] <= decoded[3], "invalid_take_profit_fill", "Pinned OrderFilled amounts are invalid");
    return Object.freeze({
      logIndex: lower(log.logIndex),
      counterparty: taker,
      sharesRaw: decoded[2],
      grossProceedsRaw: decoded[3],
      feeRaw: decoded[4],
      builder: `0x${decoded[5].toString(16).padStart(64, "0")}`,
      metadata: `0x${decoded[6].toString(16).padStart(64, "0")}`,
    });
  });
}

function selectedOutcomeFlow(logs, { wallet, outcomeTokenId }) {
  const tokenId = BigInt(outcomeTokenId);
  for (const log of logs) {
    if (lower(log?.address) !== CONTRACTS.ctf || lower(log?.topics?.[0]) !== ERC1155_TRANSFER_BATCH_TOPIC) continue;
    invariant(Array.isArray(log.topics) && log.topics.length === 4, "invalid_receipt", "CTF batch transfer topics are invalid");
    const from = topicAddress(log.topics[2]);
    const to = topicAddress(log.topics[3]);
    invariant(from !== wallet && to !== wallet, "unsupported_batched_outcome_flow", "Settlement batches the selected wallet's CTF transfers");
  }
  return logs.reduce((total, log) => {
    if (lower(log?.address) !== CONTRACTS.ctf || lower(log?.topics?.[0]) !== TOPICS.erc1155TransferSingle) return total;
    invariant(Array.isArray(log.topics) && log.topics.length === 4, "invalid_receipt", "CTF transfer topics are invalid");
    const decoded = words(log.data);
    invariant(decoded.length === 2, "invalid_receipt", "CTF transfer data is invalid");
    if (decoded[0] !== tokenId) return total;
    const operator = topicAddress(log.topics[1]);
    const from = topicAddress(log.topics[2]);
    const to = topicAddress(log.topics[3]);
    if (from === wallet || to === wallet) {
      invariant(operator === CONTRACTS.standardExchangeV2, "outcome_operator_substitution", "Selected-token settlement used another operator");
    }
    if (from === wallet) total.debit += decoded[1];
    if (to === wallet) total.credit += decoded[1];
    return total;
  }, { debit: 0n, credit: 0n });
}

function collateralFlow(logs, wallet) {
  return logs.reduce((total, log) => {
    if (lower(log?.address) !== CONTRACTS.pUsd || lower(log?.topics?.[0]) !== TOPICS.erc20Transfer) return total;
    invariant(Array.isArray(log.topics) && log.topics.length === 3, "invalid_receipt", "pUSD transfer topics are invalid");
    const from = topicAddress(log.topics[1]);
    const to = topicAddress(log.topics[2]);
    const amount = parseHexUint(log.data, "pUSD transfer amount");
    if (from === wallet) total.debit += amount;
    if (to === wallet) total.credit += amount;
    return total;
  }, { debit: 0n, credit: 0n });
}

function verifySettlement({ chainId, receipt, block, group, binding, bounds }) {
  invariant(Number(chainId) === POLYGON_CHAIN_ID, "wrong_chain", "Take-profit settlement is not from Polygon");
  record(receipt, "missing_receipt", "Take-profit settlement receipt was not found");
  invariant(lower(receipt.status) === "0x1", "failed_transaction", "Take-profit settlement transaction failed");
  invariant(
    canonicalHash(receipt.transactionHash, "invalid_receipt", "Receipt transaction hash") === group.transactionHash,
    "settlement_transaction_mismatch",
    "Polygon receipt is for another settlement transaction",
  );
  invariant(lower(receipt.to) === CONTRACTS.standardExchangeV2, "wrong_exchange", "Take-profit settlement did not target StandardExchangeV2");
  const orderCreatedAtUnix = uint(binding.proof.observed.createdAt, "invalid_take_profit_passport", "Order creation time", { positive: true });
  const venueExpiresAtUnix = uint(binding.proof.bounds.venueExpiresAtUnix, "invalid_take_profit_passport", "Venue expiry", { positive: true });
  const settlement = settlementBlock(receipt, block, { venueExpiresAtUnix, orderCreatedAtUnix });
  const logs = uniqueReceiptLogs(receipt);
  const fills = exactOrderFills(logs, {
    orderId: binding.orderId,
    wallet: binding.depositWallet,
    outcomeTokenId: binding.outcomeTokenId,
  });
  const onChain = fills.reduce((total, fill) => ({
    sharesRaw: total.sharesRaw + fill.sharesRaw,
    grossProceedsRaw: total.grossProceedsRaw + fill.grossProceedsRaw,
    feeRaw: total.feeRaw + fill.feeRaw,
  }), { sharesRaw: 0n, grossProceedsRaw: 0n, feeRaw: 0n });
  const reported = group.contributions.reduce((total, contribution) => ({
    sharesRaw: total.sharesRaw + contribution.matchedSharesRaw,
    grossProceedsRaw: total.grossProceedsRaw +
      contribution.matchedSharesRaw * contribution.priceRaw / PRICE_SCALE,
    targetGrossFloorRaw: total.targetGrossFloorRaw +
      contribution.matchedSharesRaw * bounds.targetPriceRaw / PRICE_SCALE,
  }), { sharesRaw: 0n, grossProceedsRaw: 0n, targetGrossFloorRaw: 0n });
  invariant(onChain.sharesRaw <= bounds.shareCapRaw, "take_profit_overfill", "Take-profit settlement exceeds the signed share cap");
  invariant(reported.sharesRaw === onChain.sharesRaw, "trade_shares_mismatch", "Authenticated trade shares differ from Polygon OrderFilled logs");
  invariant(
    reported.grossProceedsRaw === onChain.grossProceedsRaw,
    "trade_proceeds_mismatch",
    "Authenticated trade price and shares differ from Polygon integer-rounded gross proceeds",
  );
  invariant(
    group.contributions.every(({ priceRaw }) => priceRaw >= bounds.targetPriceRaw) &&
      onChain.grossProceedsRaw >= reported.targetGrossFloorRaw,
    "price_below_bound",
    "Take-profit execution crossed below the signed target price",
  );
  const outcome = selectedOutcomeFlow(logs, {
    wallet: binding.depositWallet,
    outcomeTokenId: binding.outcomeTokenId,
  });
  invariant(
    outcome.debit >= outcome.credit && outcome.debit - outcome.credit === onChain.sharesRaw,
    "missing_outcome_debit",
    "Exact selected-token debit from the take-profit wallet was not found",
  );
  const netProceedsRaw = onChain.grossProceedsRaw - onChain.feeRaw;
  const collateral = collateralFlow(logs, binding.depositWallet);
  invariant(
    collateral.credit >= collateral.debit && collateral.credit - collateral.debit === netProceedsRaw,
    "missing_collateral_credit",
    "Exact net pUSD credit to the take-profit wallet was not found",
  );
  const proportionalFeeCapRaw = ceilDiv(onChain.sharesRaw * BigInt(bounds.feeBps), BPS_SCALE);
  const actualGrossFeeCapRaw = ceilDiv(onChain.grossProceedsRaw * BigInt(bounds.feeBps), BPS_SCALE);
  invariant(
    onChain.feeRaw <= proportionalFeeCapRaw && onChain.feeRaw <= actualGrossFeeCapRaw &&
      onChain.feeRaw <= bounds.maximumFeeRaw,
    "fee_above_bound",
    "Take-profit settlement fee exceeds the signed fee cap",
  );
  const proportionalGrossFloorRaw = reported.targetGrossFloorRaw;
  const proportionalFeeAtTargetRaw = ceilDiv(proportionalGrossFloorRaw * BigInt(bounds.feeBps), BPS_SCALE);
  const proportionalNetFloorRaw = proportionalGrossFloorRaw - proportionalFeeAtTargetRaw;
  invariant(onChain.grossProceedsRaw >= proportionalGrossFloorRaw, "gross_below_bound", "Take-profit gross proceeds are below the proportional signed minimum");
  invariant(netProceedsRaw >= proportionalNetFloorRaw, "net_below_bound", "Take-profit net proceeds are below the proportional signed minimum");
  const averagePriceFloorRaw = onChain.grossProceedsRaw * PRICE_SCALE / onChain.sharesRaw;
  const tradeIds = Object.freeze(group.contributions.map(({ tradeId }) => tradeId).sort());
  const orderFillLogIndexes = Object.freeze(fills.map(({ logIndex }) => logIndex));
  const counterparties = Object.freeze([...new Set(fills.map(({ counterparty }) => counterparty))].sort());
  const builders = Object.freeze([...new Set(fills.map(({ builder }) => builder))].sort());
  const metadata = Object.freeze([...new Set(fills.map(({ metadata: value }) => value))].sort());
  const evidence = {
    transactionHash: group.transactionHash,
    blockNumber: settlement.blockNumber,
    blockHash: settlement.blockHash,
    settledAt: settlement.settledAt,
    tradeIds,
    orderFillLogIndexes,
    counterparties,
    builders,
    metadata,
    matchedSharesRaw: onChain.sharesRaw.toString(),
    grossProceedsRaw: onChain.grossProceedsRaw.toString(),
    feeRaw: onChain.feeRaw.toString(),
    netProceedsRaw: netProceedsRaw.toString(),
    averagePriceFloor: formatDecimal(averagePriceFloorRaw, SHARE_DECIMALS),
    checks: Object.freeze({
      transactionSucceeded: true,
      standardExchangeV2: true,
      exactOrderFill: true,
      authenticatedTradesMatched: true,
      exactOutcomeDebit: true,
      exactCollateralCredit: true,
      targetPricePreserved: true,
      feeWithinSignedCap: true,
      settlementBeforeVenueExpiry: true,
    }),
  };
  return Object.freeze({
    evidence: Object.freeze(evidence),
    evidenceHash: sha256(evidence),
    sharesRaw: onChain.sharesRaw,
    grossProceedsRaw: onChain.grossProceedsRaw,
    feeRaw: onChain.feeRaw,
    netProceedsRaw,
    targetGrossFloorRaw: proportionalGrossFloorRaw,
  });
}

function verifiedFillState(status) {
  if (status.status === "FILLED_PENDING_CHAIN_PROOF") return "FILLED";
  if (status.status === "PARTIAL_CANCELED_PENDING_CHAIN_PROOF") return "PARTIALLY_FILLED_CANCELED";
  if (status.status === "PARTIAL_EXPIRED_PENDING_CHAIN_PROOF") return "PARTIALLY_FILLED_EXPIRED";
  if (status.status === "PARTIAL_PENDING_CHAIN_PROOF" && status.cancelEligible) {
    return "PARTIALLY_FILLED_ACTIVE";
  }
  return "PARTIALLY_FILLED_UNRESOLVED";
}

function finalityObservation(finalizedBlock, verified) {
  const highestSettlementBlockNumber = verified.reduce(
    (highest, { evidence }) => Math.max(highest, evidence.blockNumber),
    0,
  );
  if (finalizedBlock === undefined || finalizedBlock === null) {
    return Object.freeze({
      status: "PROVISIONAL",
      finalized: false,
      finalizedBlockNumber: null,
      finalizedBlockHash: null,
      highestSettlementBlockNumber,
    });
  }
  const block = record(finalizedBlock, "invalid_finalized_block", "Polygon finalized block is invalid");
  const numberRaw = parseHexUint(block.number, "finalized block number");
  invariant(
    numberRaw <= BigInt(Number.MAX_SAFE_INTEGER),
    "invalid_finalized_block",
    "Polygon finalized block number is unsafe",
  );
  const finalizedBlockNumber = Number(numberRaw);
  const finalizedBlockHash = lower(block.hash);
  invariant(HASH_RE.test(finalizedBlockHash), "invalid_finalized_block", "Polygon finalized block hash is invalid");
  const finalized = finalizedBlockNumber >= highestSettlementBlockNumber;
  return Object.freeze({
    status: finalized ? "FINALIZED" : "PROVISIONAL",
    finalized,
    finalizedBlockNumber,
    finalizedBlockHash,
    highestSettlementBlockNumber,
  });
}

export function verifyTakeProfitAggregateFill({
  chainId,
  journal,
  orderSnapshot,
  tradeContributions,
  settlements,
  finalizedBlock,
} = {}, options = {}) {
  const binding = validateTakeProfitJournal(journal, options);
  const status = buildTakeProfitStatus(journal, orderSnapshot, options);
  invariant(status.settlementProofRequired === true, "take_profit_not_filled", "Exact order has no matched shares to prove on Polygon");
  const bounds = signedBounds(binding);
  const normalized = normalizeTradeContributions(binding, status, tradeContributions, options);
  invariant(Array.isArray(settlements) && settlements.length > 0, "missing_settlements", "Take-profit Polygon settlements are missing");
  const settlementHashes = settlements.map((value, index) => {
    const item = record(value, "invalid_settlement", `Settlement ${index + 1} is invalid`);
    return canonicalHash(item.transactionHash, "invalid_settlement", "Settlement transaction hash");
  });
  assertUnique(settlementHashes, "duplicate_settlement_transaction", "Take-profit settlements contain duplicate transactions");
  assertExactSet(
    settlementHashes,
    normalized.groups.map(({ transactionHash }) => transactionHash),
    "settlement_transaction_mismatch",
    "Polygon settlements differ from authenticated trade transactions",
  );
  const settlementByHash = new Map(settlements.map((value) => [lower(value.transactionHash), value]));
  const verified = normalized.groups.map((group) => {
    const source = settlementByHash.get(group.transactionHash);
    return verifySettlement({
      chainId,
      receipt: source.receipt,
      block: source.block,
      group,
      binding,
      bounds,
    });
  });
  const aggregate = verified.reduce((total, item) => ({
    sharesRaw: total.sharesRaw + item.sharesRaw,
    grossProceedsRaw: total.grossProceedsRaw + item.grossProceedsRaw,
    feeRaw: total.feeRaw + item.feeRaw,
    netProceedsRaw: total.netProceedsRaw + item.netProceedsRaw,
    targetGrossFloorRaw: total.targetGrossFloorRaw + item.targetGrossFloorRaw,
  }), { sharesRaw: 0n, grossProceedsRaw: 0n, feeRaw: 0n, netProceedsRaw: 0n, targetGrossFloorRaw: 0n });
  const reportedMatchedSharesRaw = uint(
    status.order.matchedSharesRaw,
    "invalid_order_snapshot",
    "Exact-order matched shares",
    { positive: true },
  );
  invariant(aggregate.sharesRaw <= bounds.shareCapRaw, "take_profit_overfill", "Take-profit aggregate exceeds the signed share cap");
  invariant(aggregate.sharesRaw === reportedMatchedSharesRaw, "order_matched_shares_mismatch", "Polygon fills differ from exact-order matched shares");
  invariant(
    aggregate.grossProceedsRaw >= aggregate.targetGrossFloorRaw,
    "price_below_bound",
    "Aggregate take-profit price is below the signed target",
  );
  const aggregateProportionalFeeCapRaw = ceilDiv(
    aggregate.sharesRaw * BigInt(bounds.feeBps),
    BPS_SCALE,
  );
  const aggregateGrossFeeCapRaw = ceilDiv(
    aggregate.grossProceedsRaw * BigInt(bounds.feeBps),
    BPS_SCALE,
  );
  invariant(
    aggregate.feeRaw <= aggregateProportionalFeeCapRaw &&
      aggregate.feeRaw <= aggregateGrossFeeCapRaw && aggregate.feeRaw <= bounds.maximumFeeRaw,
    "fee_above_bound",
    "Aggregate take-profit fee exceeds the signed fee cap",
  );
  const aggregateGrossFloorRaw = aggregate.targetGrossFloorRaw;
  const aggregateFeeAtTargetRaw = ceilDiv(aggregateGrossFloorRaw * BigInt(bounds.feeBps), BPS_SCALE);
  const aggregateNetFloorRaw = aggregateGrossFloorRaw - aggregateFeeAtTargetRaw;
  invariant(aggregate.grossProceedsRaw >= aggregateGrossFloorRaw, "gross_below_bound", "Aggregate gross proceeds are below the proportional signed minimum");
  invariant(aggregate.netProceedsRaw >= aggregateNetFloorRaw, "net_below_bound", "Aggregate net proceeds are below the proportional signed minimum");
  if (aggregate.sharesRaw === bounds.shareCapRaw) {
    invariant(aggregate.grossProceedsRaw >= bounds.minimumGrossProceedsRaw, "gross_below_bound", "Full take-profit gross proceeds are below the signed minimum");
    invariant(aggregate.netProceedsRaw >= bounds.minimumNetProceedsRaw, "net_below_bound", "Full take-profit net proceeds are below the signed minimum");
  }
  const averagePriceFloorRaw = aggregate.grossProceedsRaw * PRICE_SCALE / aggregate.sharesRaw;
  const fillState = verifiedFillState(status);
  const finality = finalityObservation(finalizedBlock, verified);
  const proof = Object.freeze({
    version: "conviction-take-profit-fill-proof-v1",
    status: finality.finalized ? fillState : `${fillState}_PROVISIONAL`,
    fillState,
    verificationSource: "independent-polygon-receipts",
    onChain: true,
    chainId: POLYGON_CHAIN_ID,
    intentHash: binding.intentHash,
    takeProfitPassportHash: binding.passportHash,
    restingOrderProofHash: binding.proofHash,
    exactOrderSnapshotHash: status.snapshotHash,
    authenticatedTradeContributionsHash: normalized.snapshotHash,
    orderId: binding.orderId,
    wallet: binding.depositWallet,
    marketConditionId: binding.marketConditionId,
    outcome: binding.outcome,
    outcomeTokenId: binding.outcomeTokenId,
    exchange: CONTRACTS.standardExchangeV2,
    collateral: CONTRACTS.pUsd,
    conditionalTokens: CONTRACTS.ctf,
    lifecycle: Object.freeze({
      clobStatus: status.status,
      venueStatus: status.order.venueStatus,
      orderTerminal: status.orderTerminal,
      cancelEligible: status.cancelEligible,
      cancellationObserved: status.cancellationObserved,
      matchedSharesRaw: status.order.matchedSharesRaw,
      unfilledSharesRaw: status.order.remainingSharesRaw,
    }),
    finality,
    bounds: Object.freeze({
      shareCapRaw: bounds.shareCapRaw.toString(),
      targetPrice: formatDecimal(bounds.targetPriceRaw, SHARE_DECIMALS),
      minimumFullGrossProceedsRaw: bounds.minimumGrossProceedsRaw.toString(),
      feeRateBpsMax: bounds.feeBps,
      maximumFullFeeRaw: bounds.maximumFeeRaw.toString(),
      minimumFullNetProceedsRaw: bounds.minimumNetProceedsRaw.toString(),
    }),
    fill: Object.freeze({
      actualShares: formatDecimal(aggregate.sharesRaw, SHARE_DECIMALS),
      actualSharesRaw: aggregate.sharesRaw.toString(),
      actualGrossProceeds: formatDecimal(aggregate.grossProceedsRaw, SHARE_DECIMALS),
      actualGrossProceedsRaw: aggregate.grossProceedsRaw.toString(),
      actualFee: formatDecimal(aggregate.feeRaw, SHARE_DECIMALS),
      actualFeeRaw: aggregate.feeRaw.toString(),
      actualNetProceeds: formatDecimal(aggregate.netProceedsRaw, SHARE_DECIMALS),
      actualNetProceedsRaw: aggregate.netProceedsRaw.toString(),
      actualAveragePriceFloor: formatDecimal(averagePriceFloorRaw, SHARE_DECIMALS),
      proportionalGrossFloorRaw: aggregateGrossFloorRaw.toString(),
      proportionalNetFloorRaw: aggregateNetFloorRaw.toString(),
      remainingSharesRaw: (bounds.shareCapRaw - aggregate.sharesRaw).toString(),
    }),
    tradeCount: normalized.contributions.length,
    transactionCount: verified.length,
    settlements: Object.freeze(verified.map(({ evidence, evidenceHash }) => Object.freeze({
      ...evidence,
      evidenceHash,
      finalized: finality.finalized && evidence.blockNumber <= finality.finalizedBlockNumber,
    }))),
    issuanceKeyId: binding.issuanceVerification.keyId,
    issuanceFingerprint: binding.issuanceVerification.fingerprint,
    checks: Object.freeze({
      ...(binding.initialStatus === "ARMED"
        ? { immutableArmedPassport: true }
        : { immutableSubmittedOrderPassport: true }),
      immutableAuthenticatedOrderPassport: true,
      trustedIssuerSignature: true,
      exactOrderAndTradeSet: true,
      exactPolygonSettlementSet: true,
      selectedOutcomeToken: true,
      aggregateSharesWithinSignedCap: true,
      reportedMatchedSharesMatched: true,
      eachExecutionAtOrAboveTarget: true,
      aggregateGrossAboveMinimum: true,
      aggregateFeeWithinMaximum: true,
      aggregateNetAboveMinimum: true,
      walletOutcomeDebitsMatched: true,
      walletCollateralCreditsMatched: true,
      allTransactionsSucceeded: true,
    }),
  });
  return Object.freeze({ ok: true, proof, proofHash: sha256(proof) });
}

async function rpc(method, params, { fetchImpl, rpcUrl }) {
  const response = await fetchImpl(rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new ConvictionError("rpc_error", `Polygon RPC returned HTTP ${response.status}`);
  const body = await response.json();
  if (body.error) throw new ConvictionError("rpc_error", "Polygon RPC returned an error", body.error);
  return body.result;
}

export async function fetchAndVerifyTakeProfitAggregateFill({
  journal,
  orderSnapshot,
  tradeContributions,
} = {}, {
  fetchImpl = fetch,
  rpcUrl = POLYGON_RPC_URL,
  rpcCall,
  ...options
} = {}) {
  const call = rpcCall || ((method, params) => rpc(method, params, { fetchImpl, rpcUrl }));
  const transactionHashes = Array.isArray(tradeContributions?.transactionHashes)
    ? tradeContributions.transactionHashes.map((value) => canonicalHash(value, "invalid_trade_contributions", "Settlement transaction hash"))
    : [];
  invariant(transactionHashes.length > 0, "missing_settlements", "Authenticated trade contributions have no settlement transactions");
  assertUnique(transactionHashes, "duplicate_settlement_transaction", "Settlement transaction hashes contain duplicates");
  const chainHex = await call("eth_chainId", []);
  const receipts = await Promise.all(transactionHashes.map(async (transactionHash) => {
    const receipt = await call("eth_getTransactionReceipt", [transactionHash]);
    invariant(receipt && typeof receipt === "object", "missing_receipt", "Take-profit settlement receipt was not found", { transactionHash });
    invariant(lower(receipt.transactionHash) === transactionHash, "settlement_transaction_mismatch", "Polygon RPC returned another settlement receipt");
    const block = await call("eth_getBlockByNumber", [receipt.blockNumber, false]);
    return { transactionHash, receipt, block };
  }));
  let finalizedBlock = null;
  try {
    finalizedBlock = await call("eth_getBlockByNumber", ["finalized", false]);
  } catch {
    // A provider without finalized-tag support may still supply canonical
    // receipts. The resulting proof is explicitly PROVISIONAL, never final.
  }
  return verifyTakeProfitAggregateFill({
    chainId: Number(BigInt(chainHex)),
    journal,
    orderSnapshot,
    tradeContributions,
    settlements: receipts,
    finalizedBlock,
  }, options);
}
