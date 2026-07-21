import { sha256 } from "./canonical.mjs";
import {
  CONTRACTS,
  POLYGON_CHAIN_ID,
  POLYGON_RPC_URL,
  TOPICS,
} from "./constants.mjs";
import { formatDecimal, parseDecimal, parseHexUint } from "./decimal.mjs";
import { ConvictionError, invariant } from "./errors.mjs";

const TX_HASH_RE = /^0x[0-9a-f]{64}$/i;
const CONDITION_ID_RE = /^0x[0-9a-f]{64}$/i;
const TOKEN_ID_RE = /^\d+$/;
const PRICE_SCALE = 1_000_000n;
const SHARE_SCALE = 1_000_000n;
const BPS_SCALE = 10_000n;
const V2_PRINCIPAL_STEP_RAW = 10_000n;

function ceilDiv(numerator, denominator) {
  return (numerator + denominator - 1n) / denominator;
}

function normalizeOutcome(value) {
  const outcome = String(value || "").trim().toUpperCase();
  invariant(
    outcome === "YES" || outcome === "NO",
    "invalid_expected_value",
    "Expected outcome must be YES or NO",
  );
  return outcome;
}

function lower(value) {
  return String(value || "").toLowerCase();
}

function topicAddress(topic) {
  invariant(/^0x[0-9a-f]{64}$/i.test(topic || ""), "invalid_receipt", "Invalid address topic");
  return `0x${topic.slice(-40)}`.toLowerCase();
}

function words(data) {
  invariant(/^0x(?:[0-9a-f]{64})+$/i.test(data || ""), "invalid_receipt", "Invalid event data");
  return data.slice(2).match(/.{64}/g).map((word) => BigInt(`0x${word}`));
}

function matchingOrderFills(logs, { wallet, orderId, tokenId }) {
  return logs.flatMap((log) => {
    if (lower(log.address) !== CONTRACTS.standardExchangeV2) return [];
    if (!Array.isArray(log.topics) || log.topics.length !== 4) return [];
    if (lower(log.topics[0]) !== TOPICS.orderFilled) return [];
    if (lower(log.topics[1]) !== orderId) return [];
    if (topicAddress(log.topics[2]) !== lower(wallet)) return [];
    if (topicAddress(log.topics[3]) !== CONTRACTS.standardExchangeV2) return [];
    const decoded = words(log.data);
    if (
      decoded.length !== 7 ||
      decoded[0] !== 0n ||
      decoded[1] !== tokenId ||
      decoded[5] !== 0n ||
      decoded[6] !== 0n
    ) return [];
    return [{
      principalRaw: decoded[2],
      sharesRaw: decoded[3],
      feeRaw: decoded[4],
    }];
  });
}

function deriveActualFill(receipt, { wallet, orderId, outcomeTokenId }) {
  const normalizedWallet = lower(wallet);
  const normalizedOrderId = lower(orderId);
  invariant(/^0x[0-9a-f]{40}$/.test(normalizedWallet), "invalid_intent", "Intent wallet is invalid");
  invariant(TX_HASH_RE.test(normalizedOrderId), "invalid_order_id", "Order ID is invalid");
  invariant(TOKEN_ID_RE.test(String(outcomeTokenId || "")), "invalid_intent", "Intent outcome token is invalid");
  const fills = matchingOrderFills(Array.isArray(receipt?.logs) ? receipt.logs : [], {
    wallet: normalizedWallet,
    orderId: normalizedOrderId,
    tokenId: BigInt(outcomeTokenId),
  });
  invariant(fills.length > 0, "missing_order_fill", "Selected order and outcome token were not found in the receipt");
  return fills.reduce(
    (total, fill) => ({
      principalRaw: total.principalRaw + fill.principalRaw,
      sharesRaw: total.sharesRaw + fill.sharesRaw,
      feeRaw: total.feeRaw + fill.feeRaw,
    }),
    { principalRaw: 0n, sharesRaw: 0n, feeRaw: 0n },
  );
}

export function verifyReceipt({ chainId, receipt, expected }) {
  invariant(Number(chainId) === POLYGON_CHAIN_ID, "wrong_chain", "Receipt is not from Polygon", {
    chainId,
  });
  invariant(receipt && typeof receipt === "object", "missing_receipt", "Transaction receipt was not found");
  invariant(lower(receipt.status) === "0x1", "failed_transaction", "Settlement transaction failed");
  invariant(TX_HASH_RE.test(receipt.transactionHash || ""), "invalid_receipt", "Receipt has no valid transaction hash");
  invariant(lower(receipt.to) === CONTRACTS.standardExchangeV2, "wrong_exchange", "Transaction did not target the standard V2 exchange");

  const wallet = lower(expected.wallet);
  const orderId = lower(expected.orderId);
  const outcome = normalizeOutcome(expected.outcome || "YES");
  const outcomeTokenId = String(expected.outcomeTokenId || expected.yesTokenId || "");
  invariant(TOKEN_ID_RE.test(outcomeTokenId), "invalid_expected_value", "Expected outcome token ID is invalid");
  const tokenId = BigInt(outcomeTokenId);
  const legacyReceipt = expected.receiptVersion !== "conviction-receipt-v3";
  const principalRaw = BigInt(expected.principalRaw ?? expected.spendRaw);
  const feeRaw = BigInt(expected.feeRaw ?? 0);
  const totalDebitRaw = BigInt(expected.totalDebitRaw ?? principalRaw + feeRaw);
  const sharesRaw = BigInt(expected.sharesRaw);
  invariant(totalDebitRaw === principalRaw + feeRaw, "invalid_expected_value", "Expected debit fields disagree");
  invariant(/^0x[0-9a-f]{40}$/.test(wallet), "invalid_expected_value", "Expected wallet is invalid");
  invariant(TX_HASH_RE.test(orderId), "invalid_expected_value", "Expected order ID is invalid");

  const logs = Array.isArray(receipt.logs) ? receipt.logs : [];
  const collateralTransferRaw = logs.reduce((total, log) => {
    if (lower(log.address) !== CONTRACTS.pUsd) return total;
    if (lower(log.topics?.[0]) !== TOPICS.erc20Transfer) return total;
    if (topicAddress(log.topics?.[1]) !== wallet) return total;
    return total + parseHexUint(log.data, "pUSD transfer amount");
  }, 0n);
  invariant(collateralTransferRaw === totalDebitRaw, "missing_collateral_transfer", "Exact fee-inclusive pUSD debit from the buyer wallet was not found");

  const outcomeTransferRaw = logs.reduce((total, log) => {
    if (lower(log.address) !== CONTRACTS.ctf) return total;
    if (lower(log.topics?.[0]) !== TOPICS.erc1155TransferSingle) return total;
    if (topicAddress(log.topics?.[1]) !== CONTRACTS.standardExchangeV2) return total;
    if (topicAddress(log.topics?.[3]) !== wallet) return total;
    const decoded = words(log.data);
    return decoded[0] === tokenId ? total + decoded[1] : total;
  }, 0n);
  invariant(outcomeTransferRaw === sharesRaw, "missing_outcome_transfer", `Exact ${outcome} outcome-token transfer to the buyer wallet was not found`);

  const orderFills = matchingOrderFills(logs, { wallet, orderId, tokenId });
  const orderFillTotals = orderFills.reduce(
    (total, fill) => ({
      principalRaw: total.principalRaw + fill.principalRaw,
      sharesRaw: total.sharesRaw + fill.sharesRaw,
      feeRaw: total.feeRaw + fill.feeRaw,
    }),
    { principalRaw: 0n, sharesRaw: 0n, feeRaw: 0n },
  );
  invariant(
    orderFills.length > 0 &&
      orderFillTotals.principalRaw === principalRaw &&
      orderFillTotals.sharesRaw === sharesRaw &&
      orderFillTotals.feeRaw === feeRaw,
    "missing_order_fill",
    "Exact fee-bearing bounded OrderFilled event was not found",
  );

  if (legacyReceipt) {
    invariant(feeRaw === 0n, "invalid_expected_value", "Legacy receipt proof cannot contain a venue fee");
    const proof = {
      version: "conviction-receipt-v2",
      chainId: POLYGON_CHAIN_ID,
      transactionHash: lower(receipt.transactionHash),
      blockNumber: Number(parseHexUint(receipt.blockNumber, "block number")),
      exchange: CONTRACTS.standardExchangeV2,
      wallet,
      orderId,
      outcome,
      outcomeTokenId: tokenId.toString(),
      spendRaw: principalRaw.toString(),
      sharesRaw: sharesRaw.toString(),
      checks: {
        transactionSucceeded: true,
        standardExchangeV2: true,
        exactCollateralTransfer: true,
        exactOutcomeTransfer: true,
        exactOrderFill: true,
      },
    };
    return { ok: true, proof, receiptHash: sha256(proof) };
  }

  const proof = {
    version: "conviction-receipt-v3",
    chainId: POLYGON_CHAIN_ID,
    transactionHash: lower(receipt.transactionHash),
    blockNumber: Number(parseHexUint(receipt.blockNumber, "block number")),
    exchange: CONTRACTS.standardExchangeV2,
    wallet,
    orderId,
    outcome,
    outcomeTokenId: tokenId.toString(),
    principalRaw: principalRaw.toString(),
    feeRaw: feeRaw.toString(),
    totalDebitRaw: totalDebitRaw.toString(),
    sharesRaw: sharesRaw.toString(),
    checks: {
      transactionSucceeded: true,
      standardExchangeV2: true,
      exactCollateralTransfer: true,
      exactOutcomeTransfer: true,
      exactVenueFee: true,
      exactOrderFill: true,
    },
  };
  return { ok: true, proof, receiptHash: sha256(proof) };
}

export function verifyPositionProof({
  chainId,
  receipt,
  intent,
  intentHash,
  orderId,
}) {
  const legacyIntent = intent?.version === "conviction-intent-v2";
  invariant(
    legacyIntent || intent?.version === "conviction-intent-v3",
    "invalid_intent",
    "Unsupported intent version",
  );
  invariant(TX_HASH_RE.test(intentHash || ""), "invalid_intent_hash", "Invalid intent hash");
  invariant(sha256(intent) === lower(intentHash), "intent_hash_mismatch", "Intent hash does not match the canonical intent");
  invariant(Number(intent.chainId) === POLYGON_CHAIN_ID, "wrong_chain", "Intent is not for Polygon");
  invariant(intent.market?.source === "polymarket", "invalid_intent", "Intent market source is invalid");
  invariant(
    lower(intent.market?.exchange) === CONTRACTS.standardExchangeV2 &&
      lower(intent.market?.collateral) === CONTRACTS.pUsd &&
      intent.market?.negRisk === false,
    "invalid_intent",
    "Intent venue contracts or market type are invalid",
  );
  invariant(
    intent.order?.side === "BUY" && intent.order?.orderType === "FAK",
    "invalid_intent",
    "Intent must be a bounded FAK buy",
  );

  const outcome = normalizeOutcome(intent.order?.outcome);
  invariant(intent.market?.outcome === outcome, "intent_outcome_mismatch", "Intent market and order outcomes disagree");
  const outcomeTokenId = String(intent.market?.outcomeTokenId || "");
  invariant(TOKEN_ID_RE.test(outcomeTokenId), "invalid_intent", "Intent outcome token is invalid");
  invariant(
    String(intent.order?.outcomeTokenId || "") === outcomeTokenId,
    "intent_outcome_mismatch",
    "Intent order and market outcome tokens disagree",
  );
  const mappedTokenId = String(intent.market?.outcomes?.[outcome]?.tokenId || "");
  const counterOutcome = outcome === "YES" ? "NO" : "YES";
  const counterTokenId = String(intent.market?.outcomes?.[counterOutcome]?.tokenId || "");
  invariant(
    mappedTokenId === outcomeTokenId && TOKEN_ID_RE.test(counterTokenId) && counterTokenId !== outcomeTokenId,
    "intent_token_mapping_mismatch",
    "Intent outcome-token mapping is inconsistent",
  );
  invariant(CONDITION_ID_RE.test(intent.market?.conditionId || ""), "invalid_intent", "Intent condition ID is invalid");
  const maxPriceRaw = parseDecimal(intent.order?.maxPrice, 6, "maxPrice");
  invariant(maxPriceRaw > 0n && maxPriceRaw < PRICE_SCALE, "invalid_intent", "Intent maximum price is invalid");

  let requestedBudgetRaw;
  let maximumPrincipalRaw;
  let maximumFeeRaw;
  let maximumTotalDebitRaw;
  let fullFillSharesRaw;
  let feeBps;

  if (legacyIntent) {
    invariant(TOKEN_ID_RE.test(String(intent.order?.maximumSpendRaw || "")), "invalid_intent", "Intent maximum spend is invalid");
    maximumPrincipalRaw = BigInt(intent.order.maximumSpendRaw);
    maximumFeeRaw = 0n;
    maximumTotalDebitRaw = maximumPrincipalRaw;
    requestedBudgetRaw = maximumTotalDebitRaw;
    feeBps = Number(intent.order?.feeBps || 0);
    invariant(feeBps === 0, "unsafe_legacy_fee_intent", "Fee-bearing v2 intents are not supported");
    invariant(maximumPrincipalRaw > 0n, "invalid_intent", "Intent maximum spend must be positive");
    invariant(
      intent.order.maximumSpend === formatDecimal(maximumPrincipalRaw, 6),
      "intent_economics_mismatch",
      "Intent maximum spend fields disagree",
    );
    const fullFillNumerator = maximumPrincipalRaw * PRICE_SCALE;
    invariant(fullFillNumerator % maxPriceRaw === 0n, "intent_economics_mismatch", "Intent does not encode an exact full fill at the cap");
    fullFillSharesRaw = fullFillNumerator / maxPriceRaw;
  } else {
    for (const field of [
      "requestedBudgetRaw",
      "maximumOrderPrincipalRaw",
      "maximumFeeRaw",
      "maximumTotalDebitRaw",
      "maximumSpendRaw",
      "fullFillSharesAtCapRaw",
    ]) {
      invariant(TOKEN_ID_RE.test(String(intent.order?.[field] || "")), "invalid_intent", `Intent ${field} is invalid`);
    }
    requestedBudgetRaw = BigInt(intent.order.requestedBudgetRaw);
    maximumPrincipalRaw = BigInt(intent.order.maximumOrderPrincipalRaw);
    maximumFeeRaw = BigInt(intent.order.maximumFeeRaw);
    maximumTotalDebitRaw = BigInt(intent.order.maximumTotalDebitRaw);
    fullFillSharesRaw = BigInt(intent.order.fullFillSharesAtCapRaw);
    feeBps = Number(intent.order.feeBps);
    invariant(
      Number.isInteger(feeBps) && feeBps >= 0 && feeBps <= Number(BPS_SCALE),
      "invalid_intent",
      "Intent fee rate is invalid",
    );
    invariant(
      requestedBudgetRaw > 0n && maximumPrincipalRaw > 0n && fullFillSharesRaw > 0n,
      "invalid_intent",
      "Intent economic bounds must be positive",
    );
    invariant(fullFillSharesRaw % SHARE_SCALE === 0n, "intent_economics_mismatch", "Intent must encode whole outcome shares");
    invariant(
      maximumPrincipalRaw % V2_PRINCIPAL_STEP_RAW === 0n &&
        intent.order.principalPrecision === "v2-cent-aligned-whole-shares",
      "intent_economics_mismatch",
      "Intent principal must match the V2 cent-aligned whole-share precision policy",
    );
    invariant(
      maximumPrincipalRaw === (fullFillSharesRaw * maxPriceRaw) / SHARE_SCALE &&
        (fullFillSharesRaw * maxPriceRaw) % SHARE_SCALE === 0n,
      "intent_economics_mismatch",
      "Intent principal, shares, and price disagree",
    );
    const recomputedFeeRaw = ceilDiv(maximumPrincipalRaw * BigInt(feeBps), BPS_SCALE);
    invariant(
      maximumFeeRaw === recomputedFeeRaw &&
        maximumTotalDebitRaw === maximumPrincipalRaw + maximumFeeRaw &&
        BigInt(intent.order.maximumSpendRaw) === maximumTotalDebitRaw &&
        requestedBudgetRaw >= maximumTotalDebitRaw &&
        intent.order.feeSource === "polymarket_clob_maker_base_fee" &&
        intent.order.feeReserveMethod === "ceil(orderPrincipal*feeBps/10000)" &&
        intent.order.feeEnforcement === "dedicated-wallet-balance-cap-plus-post-settlement-verification",
      "intent_economics_mismatch",
      "Intent fee-inclusive debit fields disagree",
    );
    invariant(
      intent.order.requestedBudget === formatDecimal(requestedBudgetRaw, 6) &&
        intent.order.maximumOrderPrincipal === formatDecimal(maximumPrincipalRaw, 6) &&
        intent.order.maximumFee === formatDecimal(maximumFeeRaw, 6) &&
        intent.order.maximumTotalDebit === formatDecimal(maximumTotalDebitRaw, 6) &&
        intent.order.maximumSpend === formatDecimal(maximumTotalDebitRaw, 6) &&
        intent.order.unusedBudget === formatDecimal(requestedBudgetRaw - maximumTotalDebitRaw, 6),
      "intent_economics_mismatch",
      "Intent formatted debit fields disagree",
    );
  }

  invariant(
    String(intent.order.fullFillSharesAtCapRaw || "") === fullFillSharesRaw.toString() &&
      intent.order.fullFillSharesAtCap === formatDecimal(fullFillSharesRaw, 6),
    "intent_economics_mismatch",
    "Intent full-fill share fields disagree",
  );
  const snapshotBestAskRaw = parseDecimal(intent.snapshot?.bestAsk, 6, "bestAsk");
  const snapshotDepthRaw = parseDecimal(intent.snapshot?.boundedAskDepth, 6, "boundedAskDepth");
  const priceCapCushionRaw = maxPriceRaw - snapshotBestAskRaw;
  const boundedLiquidityCoverageBps = (snapshotDepthRaw * 10_000n) / fullFillSharesRaw;
  invariant(priceCapCushionRaw >= 0n, "intent_exposure_mismatch", "Intent price cap is below its recorded best ask");
  const allInBreakEvenPriceRaw = ceilDiv(maximumTotalDebitRaw * SHARE_SCALE, fullFillSharesRaw);
  const commonExposureMatches =
    intent.exposure?.maximumLoss === formatDecimal(maximumTotalDebitRaw, 6) &&
    intent.exposure?.fullFillPayoutAtCap === formatDecimal(fullFillSharesRaw, 6) &&
    intent.exposure?.grossProfitAtCap === formatDecimal(fullFillSharesRaw - maximumTotalDebitRaw, 6) &&
    intent.exposure?.grossBreakEvenPrice === formatDecimal(allInBreakEvenPriceRaw, 6) &&
    intent.exposure?.priceCapCushion === formatDecimal(priceCapCushionRaw, 6) &&
    intent.exposure?.boundedLiquidityCoverageBps === boundedLiquidityCoverageBps.toString() &&
    intent.exposure?.assumesFullFillAtCap === true;
  const versionedExposureMatches = legacyIntent
    ? intent.exposure?.feesIncluded === false
    : intent.exposure?.feesIncluded === true &&
      intent.exposure?.maximumFee === formatDecimal(maximumFeeRaw, 6) &&
      intent.exposure?.maximumTotalDebit === formatDecimal(maximumTotalDebitRaw, 6) &&
      intent.exposure?.unusedBudget === formatDecimal(requestedBudgetRaw - maximumTotalDebitRaw, 6);
  invariant(
    commonExposureMatches && versionedExposureMatches,
    "intent_exposure_mismatch",
    "Intent exposure panel does not match its economic bounds",
  );
  const derivedFill = deriveActualFill(receipt, {
    wallet: intent.buyer?.wallet,
    orderId,
    outcomeTokenId,
  });
  const principalRaw = derivedFill.principalRaw;
  const sharesRaw = derivedFill.sharesRaw;
  const feeRaw = derivedFill.feeRaw;
  const totalDebitRaw = principalRaw + feeRaw;
  invariant(principalRaw > 0n && sharesRaw > 0n, "empty_fill", "Verified fill must spend and receive a positive amount");
  invariant(principalRaw <= maximumPrincipalRaw, "spend_above_bound", "Actual order principal exceeds the intent maximum");
  const actualMaximumFeeRaw = ceilDiv(principalRaw * BigInt(feeBps), BPS_SCALE);
  invariant(feeRaw <= maximumFeeRaw && feeRaw <= actualMaximumFeeRaw, "fee_above_bound", "Actual venue fee exceeds the intent maximum");
  invariant(totalDebitRaw <= maximumTotalDebitRaw, "debit_above_bound", "Actual fee-inclusive debit exceeds the intent maximum");
  invariant(
    principalRaw * PRICE_SCALE <= sharesRaw * maxPriceRaw,
    "price_above_bound",
    "Actual average price exceeds the intent maximum",
  );

  const receiptResult = verifyReceipt({
    chainId,
    receipt,
    expected: {
      orderId,
      wallet: intent.buyer?.wallet,
      outcome,
      outcomeTokenId,
      principalRaw: principalRaw.toString(),
      feeRaw: feeRaw.toString(),
      totalDebitRaw: totalDebitRaw.toString(),
      sharesRaw: sharesRaw.toString(),
      receiptVersion: legacyIntent ? "conviction-receipt-v2" : "conviction-receipt-v3",
    },
  });
  const averagePriceCeilingRaw =
    ceilDiv(principalRaw * PRICE_SCALE, sharesRaw);
  const allInAveragePriceCeilingRaw =
    ceilDiv(totalDebitRaw * PRICE_SCALE, sharesRaw);

  if (legacyIntent) {
    const positionProof = {
      version: "conviction-position-proof-v1",
      intentHash: lower(intentHash),
      receiptHash: receiptResult.receiptHash,
      transactionHash: receiptResult.proof.transactionHash,
      blockNumber: receiptResult.proof.blockNumber,
      orderId: lower(orderId),
      marketConditionId: lower(intent.market?.conditionId),
      outcome,
      outcomeTokenId,
      wallet: receiptResult.proof.wallet,
      bounds: {
        maximumSpendRaw: maximumPrincipalRaw.toString(),
        maxPrice: intent.order.maxPrice,
      },
      fill: {
        actualSpendRaw: principalRaw.toString(),
        actualSharesRaw: sharesRaw.toString(),
        averagePriceCeiling: formatDecimal(averagePriceCeilingRaw, 6),
      },
      checks: {
        canonicalIntentHash: true,
        selectedOutcomeToken: true,
        spendWithinMaximum: true,
        averagePriceWithinMaximum: true,
        receiptSettlementMatched: true,
      },
    };
    return {
      ok: true,
      intent,
      receiptProof: receiptResult.proof,
      positionProof,
      positionProofHash: sha256(positionProof),
    };
  }

  const positionProof = {
    version: "conviction-position-proof-v2",
    intentHash: lower(intentHash),
    receiptHash: receiptResult.receiptHash,
    transactionHash: receiptResult.proof.transactionHash,
    blockNumber: receiptResult.proof.blockNumber,
    orderId: lower(orderId),
    marketConditionId: lower(intent.market?.conditionId),
    outcome,
    outcomeTokenId,
    wallet: receiptResult.proof.wallet,
    bounds: {
      requestedBudgetRaw: requestedBudgetRaw.toString(),
      maximumOrderPrincipalRaw: maximumPrincipalRaw.toString(),
      maximumFeeRaw: maximumFeeRaw.toString(),
      maximumTotalDebitRaw: maximumTotalDebitRaw.toString(),
      maxPrice: intent.order.maxPrice,
    },
    fill: {
      actualSpendRaw: principalRaw.toString(),
      actualOrderPrincipalRaw: principalRaw.toString(),
      actualFeeRaw: feeRaw.toString(),
      actualTotalDebitRaw: totalDebitRaw.toString(),
      actualSharesRaw: sharesRaw.toString(),
      averagePriceCeiling: formatDecimal(averagePriceCeilingRaw, 6),
      allInAveragePriceCeiling: formatDecimal(allInAveragePriceCeilingRaw, 6),
    },
    checks: {
      canonicalIntentHash: true,
      selectedOutcomeToken: true,
      orderPrincipalWithinMaximum: true,
      venueFeeWithinMaximum: true,
      totalDebitWithinMaximum: true,
      averagePriceWithinMaximum: true,
      receiptSettlementMatched: true,
    },
  };
  return {
    ok: true,
    intent,
    receiptProof: receiptResult.proof,
    positionProof,
    positionProofHash: sha256(positionProof),
  };
}

async function rpc(method, params, { fetchImpl, rpcUrl }) {
  const response = await fetchImpl(rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) {
    throw new ConvictionError("rpc_error", `Polygon RPC returned HTTP ${response.status}`);
  }
  const body = await response.json();
  if (body.error) {
    throw new ConvictionError("rpc_error", "Polygon RPC returned an error", body.error);
  }
  return body.result;
}

export async function fetchAndVerifyReceipt(
  transactionHash,
  expected,
  { fetchImpl = fetch, rpcUrl = POLYGON_RPC_URL } = {},
) {
  invariant(TX_HASH_RE.test(transactionHash || ""), "invalid_transaction_hash", "Invalid transaction hash");
  const [chainHex, receipt] = await Promise.all([
    rpc("eth_chainId", [], { fetchImpl, rpcUrl }),
    rpc("eth_getTransactionReceipt", [transactionHash], { fetchImpl, rpcUrl }),
  ]);
  return verifyReceipt({ chainId: Number(BigInt(chainHex)), receipt, expected });
}

export async function fetchAndVerifyPosition(
  transactionHash,
  expected,
  { fetchImpl = fetch, rpcUrl = POLYGON_RPC_URL } = {},
) {
  invariant(TX_HASH_RE.test(transactionHash || ""), "invalid_transaction_hash", "Invalid transaction hash");
  const [chainHex, receipt] = await Promise.all([
    rpc("eth_chainId", [], { fetchImpl, rpcUrl }),
    rpc("eth_getTransactionReceipt", [transactionHash], { fetchImpl, rpcUrl }),
  ]);
  return verifyPositionProof({
    chainId: Number(BigInt(chainHex)),
    receipt,
    ...expected,
  });
}
