import { sha256 } from "./canonical.mjs";
import {
  CONTRACTS,
  POLYGON_CHAIN_ID,
  POLYGON_RPC_URL,
  TOPICS,
} from "./constants.mjs";
import { formatDecimal, parseDecimal, parseHexUint } from "./decimal.mjs";
import { ConvictionError, invariant } from "./errors.mjs";
import { verifyIntentIssuance } from "./intent-issuer.mjs";

const HASH_RE = /^0x[0-9a-f]{64}$/i;
const ADDRESS_RE = /^0x[0-9a-f]{40}$/i;
const CONDITION_ID_RE = /^0x[0-9a-f]{64}$/i;
const TOKEN_ID_RE = /^\d+$/;
const PRICE_SCALE = 1_000_000n;
const SHARE_SCALE = 1_000_000n;
const BPS_SCALE = 10_000n;

function ceilDiv(numerator, denominator) {
  return (numerator + denominator - 1n) / denominator;
}

function lower(value) {
  return String(value || "").toLowerCase();
}

function normalizeOutcome(value) {
  const outcome = String(value || "").toUpperCase();
  invariant(outcome === "YES" || outcome === "NO", "invalid_expected_value", "Expected outcome must be YES or NO");
  return outcome;
}

function topicAddress(topic) {
  invariant(/^0x[0-9a-f]{64}$/i.test(topic || ""), "invalid_receipt", "Invalid address topic");
  return `0x${topic.slice(-40)}`.toLowerCase();
}

function words(data) {
  invariant(/^0x(?:[0-9a-f]{64})+$/i.test(data || ""), "invalid_receipt", "Invalid event data");
  return data.slice(2).match(/.{64}/g).map((word) => BigInt(`0x${word}`));
}

function matchingCloseFills(logs, { wallet, orderId, tokenId }) {
  return logs.flatMap((log) => {
    if (lower(log.address) !== CONTRACTS.standardExchangeV2) return [];
    if (!Array.isArray(log.topics) || log.topics.length !== 4) return [];
    if (lower(log.topics[0]) !== TOPICS.orderFilled) return [];
    if (lower(log.topics[1]) !== orderId) return [];
    if (topicAddress(log.topics[2]) !== wallet) return [];
    if (topicAddress(log.topics[3]) !== CONTRACTS.standardExchangeV2) return [];
    const decoded = words(log.data);
    if (
      decoded.length !== 7 ||
      decoded[0] !== 1n ||
      decoded[1] !== tokenId ||
      decoded[5] !== 0n ||
      decoded[6] !== 0n
    ) return [];
    return [{
      sharesRaw: decoded[2],
      grossProceedsRaw: decoded[3],
      feeRaw: decoded[4],
    }];
  });
}

function deriveCloseFill(receipt, { wallet, orderId, outcomeTokenId }) {
  const normalizedWallet = lower(wallet);
  const normalizedOrderId = lower(orderId);
  invariant(ADDRESS_RE.test(normalizedWallet), "invalid_intent", "Intent seller wallet is invalid");
  invariant(HASH_RE.test(normalizedOrderId), "invalid_order_id", "Order ID is invalid");
  invariant(TOKEN_ID_RE.test(String(outcomeTokenId || "")), "invalid_intent", "Intent outcome token is invalid");
  const fills = matchingCloseFills(Array.isArray(receipt?.logs) ? receipt.logs : [], {
    wallet: normalizedWallet,
    orderId: normalizedOrderId,
    tokenId: BigInt(outcomeTokenId),
  });
  invariant(fills.length > 0, "missing_close_fill", "Selected SELL order and outcome token were not found in the receipt");
  return fills.reduce((total, fill) => ({
    sharesRaw: total.sharesRaw + fill.sharesRaw,
    grossProceedsRaw: total.grossProceedsRaw + fill.grossProceedsRaw,
    feeRaw: total.feeRaw + fill.feeRaw,
  }), { sharesRaw: 0n, grossProceedsRaw: 0n, feeRaw: 0n });
}

function verifySettlementBlock(receipt, block) {
  invariant(block && typeof block === "object", "missing_settlement_block", "Settlement block was not found");
  invariant(HASH_RE.test(receipt?.blockHash || ""), "invalid_receipt", "Receipt has no valid block hash");
  invariant(HASH_RE.test(block.hash || ""), "invalid_settlement_block", "Settlement block hash is invalid");
  const receiptBlockNumber = parseHexUint(receipt.blockNumber, "receipt block number");
  const blockNumber = parseHexUint(block.number, "settlement block number");
  invariant(blockNumber === receiptBlockNumber, "settlement_block_mismatch", "Settlement block number does not match the receipt");
  invariant(lower(block.hash) === lower(receipt.blockHash), "settlement_block_mismatch", "Settlement block hash does not match the receipt");
  const timestampSeconds = parseHexUint(block.timestamp, "settlement block timestamp");
  invariant(timestampSeconds <= BigInt(Math.floor(Number.MAX_SAFE_INTEGER / 1_000)), "invalid_settlement_block", "Settlement timestamp is out of range");
  return {
    blockNumber: Number(blockNumber),
    blockHash: lower(block.hash),
    settledAt: new Date(Number(timestampSeconds) * 1_000).toISOString(),
  };
}

export function verifyCloseReceipt({ chainId, receipt, expected }) {
  invariant(Number(chainId) === POLYGON_CHAIN_ID, "wrong_chain", "Receipt is not from Polygon", { chainId });
  invariant(receipt && typeof receipt === "object", "missing_receipt", "Close transaction receipt was not found");
  invariant(lower(receipt.status) === "0x1", "failed_transaction", "Close settlement transaction failed");
  invariant(HASH_RE.test(receipt.transactionHash || ""), "invalid_receipt", "Receipt has no valid transaction hash");
  invariant(lower(receipt.to) === CONTRACTS.standardExchangeV2, "wrong_exchange", "Close did not target the standard V2 exchange");

  const wallet = lower(expected.wallet);
  const orderId = lower(expected.orderId);
  const outcome = normalizeOutcome(expected.outcome);
  const outcomeTokenId = String(expected.outcomeTokenId || "");
  invariant(ADDRESS_RE.test(wallet), "invalid_expected_value", "Expected seller wallet is invalid");
  invariant(HASH_RE.test(orderId), "invalid_expected_value", "Expected close order ID is invalid");
  invariant(TOKEN_ID_RE.test(outcomeTokenId), "invalid_expected_value", "Expected outcome token is invalid");
  const tokenId = BigInt(outcomeTokenId);
  const sharesRaw = BigInt(expected.sharesRaw);
  const grossProceedsRaw = BigInt(expected.grossProceedsRaw);
  const feeRaw = BigInt(expected.feeRaw);
  const netProceedsRaw = BigInt(expected.netProceedsRaw);
  invariant(netProceedsRaw === grossProceedsRaw - feeRaw, "invalid_expected_value", "Expected close proceeds disagree");

  const logs = Array.isArray(receipt.logs) ? receipt.logs : [];
  const collateralFlows = logs.reduce((total, log) => {
    if (lower(log.address) !== CONTRACTS.pUsd) return total;
    if (lower(log.topics?.[0]) !== TOPICS.erc20Transfer) return total;
    const from = topicAddress(log.topics?.[1]);
    const to = topicAddress(log.topics?.[2]);
    const amount = parseHexUint(log.data, "pUSD transfer amount");
    if (to === wallet) total.credit += amount;
    if (from === wallet) total.debit += amount;
    return total;
  }, { credit: 0n, debit: 0n });
  invariant(
    collateralFlows.credit >= collateralFlows.debit && collateralFlows.credit - collateralFlows.debit === netProceedsRaw,
    "missing_collateral_credit",
    "Exact net fee-adjusted pUSD proceeds to the seller wallet were not found",
  );

  const outcomeFlows = logs.reduce((total, log) => {
    if (lower(log.address) !== CONTRACTS.ctf) return total;
    if (lower(log.topics?.[0]) !== TOPICS.erc1155TransferSingle) return total;
    if (topicAddress(log.topics?.[1]) !== CONTRACTS.standardExchangeV2) return total;
    const decoded = words(log.data);
    if (decoded[0] !== tokenId) return total;
    const from = topicAddress(log.topics?.[2]);
    const to = topicAddress(log.topics?.[3]);
    if (from === wallet) total.debit += decoded[1];
    if (to === wallet) total.credit += decoded[1];
    return total;
  }, { debit: 0n, credit: 0n });
  invariant(
    outcomeFlows.debit >= outcomeFlows.credit && outcomeFlows.debit - outcomeFlows.credit === sharesRaw,
    "missing_outcome_debit",
    `Exact net ${outcome} outcome-token debit from the seller wallet was not found`,
  );

  const fill = deriveCloseFill(receipt, { wallet, orderId, outcomeTokenId });
  invariant(
    fill.sharesRaw === sharesRaw && fill.grossProceedsRaw === grossProceedsRaw && fill.feeRaw === feeRaw,
    "missing_close_fill",
    "Exact fee-bearing bounded SELL fill was not found",
  );

  const proof = {
    version: "conviction-close-receipt-v1",
    chainId: POLYGON_CHAIN_ID,
    transactionHash: lower(receipt.transactionHash),
    blockNumber: Number(parseHexUint(receipt.blockNumber, "block number")),
    exchange: CONTRACTS.standardExchangeV2,
    wallet,
    orderId,
    outcome,
    outcomeTokenId,
    sharesRaw: sharesRaw.toString(),
    grossProceedsRaw: grossProceedsRaw.toString(),
    feeRaw: feeRaw.toString(),
    netProceedsRaw: netProceedsRaw.toString(),
    checks: {
      transactionSucceeded: true,
      standardExchangeV2: true,
      exactOutcomeDebit: true,
      exactCollateralCredit: true,
      exactVenueFee: true,
      exactSellOrderFill: true,
    },
  };
  return { ok: true, proof, receiptHash: sha256(proof) };
}

export function verifyCloseProof({
  chainId,
  receipt,
  settlementBlock,
  intent,
  intentHash,
  orderId,
  issuance,
  trustedIssuers,
}) {
  invariant(intent?.version === "conviction-exit-intent-v1", "invalid_intent", "Unsupported exit intent version");
  invariant(intent.action === "CLOSE", "invalid_intent", "Exit intent action must be CLOSE");
  invariant(HASH_RE.test(intentHash || ""), "invalid_intent_hash", "Invalid exit intent hash");
  invariant(sha256(intent) === lower(intentHash), "intent_hash_mismatch", "Exit intent hash does not match canonical JSON");
  invariant(Number(intent.chainId) === POLYGON_CHAIN_ID, "wrong_chain", "Exit intent is not for Polygon");
  const settlement = verifySettlementBlock(receipt, settlementBlock);
  const issuanceProof = verifyIntentIssuance({
    intent,
    intentHash,
    issuance,
    trustedIssuers,
    settledAt: settlement.settledAt,
  });
  invariant(
    intent.market?.source === "polymarket" &&
      lower(intent.market?.exchange) === CONTRACTS.standardExchangeV2 &&
      lower(intent.market?.collateral) === CONTRACTS.pUsd &&
      lower(intent.market?.conditionalTokens) === CONTRACTS.ctf &&
      intent.market?.negRisk === false,
    "invalid_intent",
    "Exit venue contracts or market type are invalid",
  );
  invariant(CONDITION_ID_RE.test(intent.market?.conditionId || ""), "invalid_intent", "Exit condition ID is invalid");
  invariant(
    intent.order?.action === "CLOSE" && intent.order?.side === "SELL" && intent.order?.orderType === "FOK",
    "invalid_intent",
    "CLOSE intent must be an exact FOK SELL",
  );

  const outcome = normalizeOutcome(intent.order?.outcome);
  const outcomeTokenId = String(intent.order?.outcomeTokenId || "");
  invariant(intent.market?.outcome === outcome, "intent_outcome_mismatch", "Intent market and order outcomes disagree");
  invariant(TOKEN_ID_RE.test(outcomeTokenId), "invalid_intent", "Exit outcome token is invalid");
  const counterOutcome = outcome === "YES" ? "NO" : "YES";
  const counterTokenId = String(intent.market?.outcomes?.[counterOutcome]?.tokenId || "");
  invariant(
    String(intent.market?.outcomeTokenId || "") === outcomeTokenId &&
      String(intent.market?.outcomes?.[outcome]?.tokenId || "") === outcomeTokenId &&
      String(intent.market?.counterOutcomeTokenId || "") === counterTokenId &&
      TOKEN_ID_RE.test(counterTokenId) && counterTokenId !== outcomeTokenId,
    "intent_token_mapping_mismatch",
    "Exit outcome-token mapping is inconsistent",
  );
  const wallet = lower(intent.seller?.wallet);
  invariant(ADDRESS_RE.test(wallet), "invalid_intent", "Exit seller wallet is invalid");
  invariant(
    intent.position?.wallet === wallet && intent.position?.outcomeTokenId === outcomeTokenId &&
      intent.position?.approvedForExchange === true,
    "intent_position_mismatch",
    "Exit position snapshot is for another wallet or token",
  );
  for (const field of ["availableSharesRaw", "requestedCloseSharesRaw", "remainingSharesAfterFullCloseRaw"]) {
    invariant(TOKEN_ID_RE.test(String(intent.position?.[field] ?? "")), "invalid_intent", `Exit position ${field} is invalid`);
  }
  const availableSharesRaw = BigInt(String(intent.position?.availableSharesRaw || "-1"));
  const positionCloseSharesRaw = BigInt(String(intent.position?.requestedCloseSharesRaw || "-1"));
  const remainingSharesRaw = BigInt(String(intent.position?.remainingSharesAfterFullCloseRaw || "-1"));
  invariant(
    intent.source?.wallet === wallet &&
      intent.source?.marketConditionId === lower(intent.market?.conditionId) &&
      intent.source?.outcome === outcome &&
      intent.source?.outcomeTokenId === outcomeTokenId &&
      HASH_RE.test(intent.source?.intentHash || "") &&
      HASH_RE.test(intent.source?.positionProofHash || "") &&
      HASH_RE.test(intent.source?.transactionHash || "") &&
      HASH_RE.test(intent.source?.orderId || "") &&
      TOKEN_ID_RE.test(String(intent.source?.actualSharesRaw || "")) &&
      ((intent.source?.verificationMode === "signed-intent-window" && intent.source?.intentVersion === "conviction-intent-v4") ||
        (intent.source?.verificationMode === "retrospective" && ["conviction-intent-v2", "conviction-intent-v3"].includes(intent.source?.intentVersion))),
    "intent_source_mismatch",
    "Exit source proof is inconsistent",
  );

  for (const field of [
    "sharesRaw", "minimumGrossProceedsRaw", "feeAtPriceFloorRaw", "maximumFeeRaw", "minimumNetProceedsRaw",
  ]) invariant(TOKEN_ID_RE.test(String(intent.order?.[field] ?? "")), "invalid_intent", `Exit ${field} is invalid`);
  const sharesRaw = BigInt(intent.order.sharesRaw);
  const minPriceRaw = parseDecimal(intent.order.minPrice, 6, "minPrice");
  const minimumGrossRaw = BigInt(intent.order.minimumGrossProceedsRaw);
  const feeAtPriceFloorRaw = BigInt(intent.order.feeAtPriceFloorRaw);
  const maximumFeeRaw = BigInt(intent.order.maximumFeeRaw);
  const minimumNetRaw = BigInt(intent.order.minimumNetProceedsRaw);
  const feeBps = Number(intent.order.feeRateBpsMax);
  invariant(sharesRaw > 0n && sharesRaw % SHARE_SCALE === 0n, "intent_economics_mismatch", "Exit shares are invalid");
  invariant(
    availableSharesRaw >= sharesRaw &&
      positionCloseSharesRaw === sharesRaw &&
      remainingSharesRaw === availableSharesRaw - sharesRaw &&
      BigInt(intent.source.actualSharesRaw) >= sharesRaw,
    "intent_position_mismatch",
    "Exit position or source quantities disagree with the close",
  );
  invariant(minPriceRaw > 0n && minPriceRaw < PRICE_SCALE, "intent_economics_mismatch", "Exit minimum price is invalid");
  invariant(sharesRaw * minPriceRaw === minimumGrossRaw * SHARE_SCALE, "intent_economics_mismatch", "Exit shares, price, and gross floor disagree");
  invariant(Number.isInteger(feeBps) && feeBps >= 0 && feeBps <= 10_000 && intent.order.feeBps === feeBps, "intent_economics_mismatch", "Exit fee-rate cap is invalid");
  invariant(feeAtPriceFloorRaw === ceilDiv(minimumGrossRaw * BigInt(feeBps), BPS_SCALE), "intent_economics_mismatch", "Exit floor fee is invalid");
  invariant(maximumFeeRaw === ceilDiv(sharesRaw * BigInt(feeBps), BPS_SCALE), "intent_economics_mismatch", "Exit absolute fee ceiling is invalid");
  invariant(minimumNetRaw === minimumGrossRaw - feeAtPriceFloorRaw, "intent_economics_mismatch", "Exit minimum net proceeds are invalid");
  invariant(
    intent.order.shares === formatDecimal(sharesRaw, 6) &&
      intent.order.minimumGrossProceeds === formatDecimal(minimumGrossRaw, 6) &&
      intent.order.feeAtPriceFloor === formatDecimal(feeAtPriceFloorRaw, 6) &&
      intent.order.maximumFee === formatDecimal(maximumFeeRaw, 6) &&
      intent.order.minimumNetProceeds === formatDecimal(minimumNetRaw, 6),
    "intent_economics_mismatch",
    "Exit formatted economics disagree",
  );
  invariant(
    intent.order.feeSource === "polymarket_clob_maker_base_fee" &&
      intent.order.feeReserveMethod === "floor=ceil(minimumGrossProceeds*feeBps/10000);absolute=ceil(shares*feeBps/10000)" &&
      intent.order.feeEnforcement === "post-settlement-verification-only" &&
      intent.order.proceedsPrecision === "v2-cent-aligned-whole-shares",
    "intent_economics_mismatch",
    "Exit fee or precision policy is unsupported",
  );
  invariant(
    intent.proceeds?.minimumGrossProceeds === intent.order.minimumGrossProceeds &&
      intent.proceeds?.feeAtPriceFloor === intent.order.feeAtPriceFloor &&
      intent.proceeds?.maximumFee === intent.order.maximumFee &&
      intent.proceeds?.minimumNetProceeds === intent.order.minimumNetProceeds &&
      intent.proceeds?.grossProceedsPreventivelyEnforced === true &&
      intent.proceeds?.feeAndNetPreventivelyEnforced === false &&
      intent.proceeds?.feeAndNetEnforcement === "post-settlement-verification-only" &&
      intent.proceeds?.exactSharesRequired === true && intent.proceeds?.partialFillAllowed === false,
    "intent_economics_mismatch",
    "Exit proceeds panel disagrees",
  );
  invariant(
    intent.snapshot?.positionCapturedAt === intent.position?.observedAt &&
      intent.snapshot?.positionBlockNumber === intent.position?.observedAtBlock &&
      intent.snapshot?.positionBlockHash === intent.position?.observedAtBlockHash &&
      /^0x[0-9a-f]+$/i.test(intent.position?.observedAtBlock || "") &&
      HASH_RE.test(intent.position?.observedAtBlockHash || ""),
    "intent_position_mismatch",
    "Exit position snapshot binding is invalid",
  );
  const snapshotBestBidRaw = parseDecimal(intent.snapshot?.bestBid, 6, "bestBid");
  const snapshotDepthRaw = parseDecimal(intent.snapshot?.boundedBidDepth, 6, "boundedBidDepth");
  invariant(snapshotBestBidRaw >= minPriceRaw && snapshotDepthRaw >= sharesRaw, "intent_economics_mismatch", "Exit order-book bounds are invalid");

  const fill = deriveCloseFill(receipt, { wallet, orderId, outcomeTokenId });
  invariant(fill.sharesRaw === sharesRaw, "partial_or_excess_close", "FOK CLOSE did not fill exactly the signed shares");
  invariant(fill.grossProceedsRaw >= minimumGrossRaw, "gross_below_bound", "Actual gross proceeds are below the signed minimum");
  invariant(fill.grossProceedsRaw * SHARE_SCALE >= sharesRaw * minPriceRaw, "price_below_bound", "Actual average sell price is below the signed minimum");
  const actualFeeLimitRaw = ceilDiv(fill.grossProceedsRaw * BigInt(feeBps), BPS_SCALE);
  invariant(fill.feeRaw <= actualFeeLimitRaw && fill.feeRaw <= maximumFeeRaw, "fee_above_bound", "Actual close fee exceeds the signed fee cap");
  const netProceedsRaw = fill.grossProceedsRaw - fill.feeRaw;
  invariant(netProceedsRaw >= minimumNetRaw, "net_below_bound", "Actual net proceeds are below the signed minimum");

  const receiptResult = verifyCloseReceipt({
    chainId,
    receipt,
    expected: {
      wallet,
      orderId,
      outcome,
      outcomeTokenId,
      sharesRaw: fill.sharesRaw.toString(),
      grossProceedsRaw: fill.grossProceedsRaw.toString(),
      feeRaw: fill.feeRaw.toString(),
      netProceedsRaw: netProceedsRaw.toString(),
    },
  });
  const actualAveragePriceFloorRaw = (fill.grossProceedsRaw * PRICE_SCALE) / fill.sharesRaw;
  const closeProof = {
    version: "conviction-close-proof-v1",
    intentHash: lower(intentHash),
    sourceIntentHash: lower(intent.source.intentHash),
    sourcePositionProofHash: lower(intent.source.positionProofHash),
    receiptHash: receiptResult.receiptHash,
    transactionHash: receiptResult.proof.transactionHash,
    blockNumber: receiptResult.proof.blockNumber,
    blockHash: settlement.blockHash,
    settledAt: settlement.settledAt,
    orderId: lower(orderId),
    marketConditionId: lower(intent.market.conditionId),
    outcome,
    outcomeTokenId,
    wallet,
    bounds: {
      exactSharesRaw: sharesRaw.toString(),
      minPrice: intent.order.minPrice,
      minimumGrossProceedsRaw: minimumGrossRaw.toString(),
      feeRateBpsMax: feeBps,
      maximumFeeRaw: maximumFeeRaw.toString(),
      minimumNetProceedsRaw: minimumNetRaw.toString(),
    },
    fill: {
      actualSharesRaw: fill.sharesRaw.toString(),
      actualGrossProceedsRaw: fill.grossProceedsRaw.toString(),
      actualFeeRaw: fill.feeRaw.toString(),
      actualNetProceedsRaw: netProceedsRaw.toString(),
      actualAveragePriceFloor: formatDecimal(actualAveragePriceFloorRaw, 6),
    },
    issuanceKeyId: issuanceProof.keyId,
    issuanceFingerprint: issuanceProof.fingerprint,
    checks: {
      canonicalExitIntentHash: true,
      verifiedSourcePositionBound: true,
      selectedOutcomeToken: true,
      exactSharesClosed: true,
      grossProceedsAboveMinimum: true,
      sellPriceAboveMinimum: true,
      venueFeeWithinMaximum: true,
      netProceedsAboveMinimum: true,
      receiptSettlementMatched: true,
      trustedIssuerSignature: true,
      settlementInsideSignedWindow: true,
      settlementBlockMatched: true,
    },
  };
  const result = {
    ok: true,
    intent,
    issuance,
    receiptProof: receiptResult.proof,
    closeProof,
    closeProofHash: sha256(closeProof),
  };
  const closePassport = {
    version: "conviction-close-passport-v1",
    status: "CLOSED",
    issuance,
    intent,
    receiptProof: receiptResult.proof,
    closeProof,
  };
  return {
    ...result,
    closePassport,
    closePassportHash: sha256(closePassport),
  };
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

export async function fetchAndVerifyClose(
  transactionHash,
  expected,
  { fetchImpl = fetch, rpcUrl = POLYGON_RPC_URL } = {},
) {
  invariant(HASH_RE.test(transactionHash || ""), "invalid_transaction_hash", "Invalid close transaction hash");
  const [chainHex, receipt] = await Promise.all([
    rpc("eth_chainId", [], { fetchImpl, rpcUrl }),
    rpc("eth_getTransactionReceipt", [transactionHash], { fetchImpl, rpcUrl }),
  ]);
  invariant(receipt && typeof receipt === "object", "missing_receipt", "Close transaction receipt was not found");
  invariant(lower(receipt.transactionHash) === lower(transactionHash), "settlement_transaction_mismatch", "Polygon RPC returned another close transaction receipt");
  const settlementBlock = await rpc("eth_getBlockByNumber", [receipt.blockNumber, false], { fetchImpl, rpcUrl });
  return verifyCloseProof({
    chainId: Number(BigInt(chainHex)),
    receipt,
    settlementBlock,
    ...expected,
  });
}
