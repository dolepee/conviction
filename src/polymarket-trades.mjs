import { createHmac } from "node:crypto";

import { formatDecimal, parseDecimal } from "./decimal.mjs";
import { ConvictionError, invariant } from "./errors.mjs";
import { loadDepositWalletCredentials } from "./polymarket-open-orders.mjs";
import {
  parsePolymarketClobShares,
  parsePolymarketShareAtoms,
  POLYMARKET_SHARE_DECIMALS,
} from "./polymarket-quantities.mjs";

const CLOB_ORIGIN = "https://clob.polymarket.com";
const TRADES_PATH = "/data/trades";
const LAST_CURSOR = "LTE=";
const MAX_ASSOCIATED_TRADES = 100;
const FETCH_CONCURRENCY = 4;
const SHARE_DECIMALS = POLYMARKET_SHARE_DECIMALS;
const ADDRESS_RE = /^0x[0-9a-f]{40}$/;
const HASH_RE = /^0x[0-9a-f]{64}$/;
const TOKEN_ID_RE = /^(?:0|[1-9][0-9]*)$/;
const CONFIRMED_STATUSES = new Set(["CONFIRMED", "TRADE_STATUS_CONFIRMED"]);

function fail(code, message, details) {
  throw new ConvictionError(code, message, details);
}

function record(value, code, message) {
  invariant(value !== null && typeof value === "object" && !Array.isArray(value), code, message);
  return value;
}

function canonicalAddress(value, label, code = "invalid_trade_identity") {
  const address = String(value || "").toLowerCase();
  invariant(ADDRESS_RE.test(address), code, `${label} is invalid`);
  return address;
}

function canonicalHash(value, label, code = "invalid_trade_identity") {
  const hash = String(value || "").toLowerCase();
  invariant(HASH_RE.test(hash), code, `${label} is invalid`);
  return hash;
}

function canonicalTokenId(value) {
  const tokenId = String(value ?? "");
  invariant(TOKEN_ID_RE.test(tokenId), "invalid_trade_identity", "Outcome token ID is invalid");
  return tokenId;
}

function safeTradeId(value, label = "Associated trade ID") {
  const tradeId = String(value ?? "");
  invariant(
    tradeId === tradeId.trim() && tradeId.length > 0 && tradeId.length <= 256 &&
      !/[\u0000-\u001f\u007f]/.test(tradeId),
    "invalid_trade_identity",
    `${label} is invalid`,
  );
  return tradeId;
}

function canonicalSide(value) {
  const side = String(value || "").toUpperCase();
  invariant(side === "SELL", "trade_side_mismatch", "Associated trade contribution is not the pinned SELL");
  return side;
}

function canonicalStatus(value) {
  const status = String(value || "").toUpperCase();
  invariant(CONFIRMED_STATUSES.has(status), "trade_not_confirmed", "Associated trade is not confirmed on the CLOB");
  return status;
}

function positiveDecimal(value, label) {
  const raw = parseDecimal(value, SHARE_DECIMALS, label);
  invariant(raw > 0n, "invalid_trade_amount", `${label} must be positive`);
  return Object.freeze({
    raw,
    formatted: formatDecimal(raw, SHARE_DECIMALS),
  });
}

function positiveClobShares(value, label) {
  const raw = parsePolymarketClobShares(value, label, {
    code: "invalid_trade_amount",
    positive: true,
  });
  return Object.freeze({
    raw,
    formatted: formatDecimal(raw, SHARE_DECIMALS),
  });
}

function canonicalPrice(value) {
  const price = positiveDecimal(value, "Trade price");
  invariant(price.raw <= 1_000_000n, "invalid_trade_price", "Trade price cannot exceed one pUSD per share");
  return price;
}

function paddedBase64Url(buffer) {
  return buffer.toString("base64").replaceAll("+", "-").replaceAll("/", "_");
}

function hmacHeaders({ signerAddress, apiKey, secret, passphrase, timestamp }) {
  invariant(
    typeof apiKey === "string" && apiKey.length > 0 &&
      typeof passphrase === "string" && passphrase.length > 0 &&
      typeof secret === "string" && /^[A-Za-z0-9_-]+={0,2}$/.test(secret),
    "invalid_trade_credentials",
    "Polymarket credentials are incomplete",
  );
  const secretBytes = Buffer.from(secret, "base64url");
  invariant(secretBytes.length > 0, "invalid_trade_credentials", "Polymarket credential secret is invalid");
  // Polymarket L2 auth signs the path, without the query string. Keep `id`
  // outside this message while still pinning it in the request and response.
  const message = `${timestamp}GET${TRADES_PATH}`;
  const signature = paddedBase64Url(createHmac("sha256", secretBytes).update(message).digest());
  return {
    POLY_ADDRESS: signerAddress,
    POLY_SIGNATURE: signature,
    POLY_TIMESTAMP: String(timestamp),
    POLY_API_KEY: apiKey,
    POLY_PASSPHRASE: passphrase,
  };
}

function validateExactOrderSnapshot(snapshotInput, {
  signerAddress,
  depositWallet,
  orderId,
  marketConditionId,
  outcomeTokenId,
}) {
  const snapshot = record(
    snapshotInput,
    "invalid_trade_order_snapshot",
    "An authenticated exact-order snapshot is required",
  );
  const order = record(
    snapshot.order,
    "invalid_trade_order_snapshot",
    "Exact-order snapshot order is missing",
  );
  invariant(
    snapshot.version === "conviction-polymarket-order-snapshot-v1" &&
      snapshot.verificationSource === "authenticated-polymarket-clob" &&
      snapshot.onChain === false && snapshot.credentialOwnerVerified === true,
    "invalid_trade_order_snapshot",
    "Associated trades must come from an authenticated exact CLOB order",
  );
  invariant(
    canonicalAddress(snapshot.signerAddress, "Snapshot signer") === signerAddress &&
      canonicalAddress(snapshot.depositWallet, "Snapshot deposit wallet") === depositWallet,
    "trade_wallet_mismatch",
    "Exact-order snapshot is bound to another wallet",
  );
  invariant(
    canonicalHash(order.id, "Snapshot order ID") === orderId,
    "trade_order_mismatch",
    "Exact-order snapshot is bound to another order",
  );
  invariant(
    canonicalHash(order.market, "Snapshot market") === marketConditionId,
    "trade_market_mismatch",
    "Exact-order snapshot is bound to another market",
  );
  invariant(
    canonicalTokenId(order.assetId) === outcomeTokenId,
    "trade_token_mismatch",
    "Exact-order snapshot is bound to another outcome token",
  );
  canonicalSide(order.side);
  const originalSizeRaw = parsePolymarketShareAtoms(order.originalSize, "Snapshot original size", {
    code: "invalid_trade_order_snapshot",
    positive: true,
  });
  const sizeMatchedRaw = parsePolymarketShareAtoms(order.sizeMatched, "Snapshot matched size", {
    code: "invalid_trade_order_snapshot",
  });
  invariant(
    sizeMatchedRaw <= originalSizeRaw,
    "invalid_trade_order_snapshot",
    "Exact-order snapshot has an impossible matched size",
  );

  invariant(Array.isArray(order.associatedTrades), "invalid_trade_order_snapshot", "Exact order omitted associated trades");
  invariant(
    order.associatedTrades.length <= MAX_ASSOCIATED_TRADES,
    "associated_trade_limit",
    "Exact order has too many associated trades to verify safely",
  );
  const associatedTradeIds = order.associatedTrades.map((value, index) =>
    safeTradeId(value, `Associated trade ${index + 1}`));
  invariant(
    new Set(associatedTradeIds).size === associatedTradeIds.length,
    "duplicate_associated_trade",
    "Exact order contains a repeated associated trade ID",
  );
  return Object.freeze(associatedTradeIds);
}

function responseRows(body) {
  if (Array.isArray(body)) return body;
  const page = record(body, "invalid_trade_response", "Polymarket returned an invalid trade response");
  invariant(Array.isArray(page.data), "invalid_trade_response", "Polymarket trade data is missing");
  invariant(
    Number.isSafeInteger(page.count) && page.count >= 0 && page.count === page.data.length,
    "invalid_trade_response",
    "Polymarket returned inconsistent trade response metadata",
  );
  if (Object.hasOwn(page, "limit")) {
    invariant(
      Number.isSafeInteger(page.limit) && page.limit > 0 && page.count <= page.limit,
      "invalid_trade_response",
      "Polymarket returned an invalid trade response limit",
    );
  }
  invariant(
    page.next_cursor === undefined || page.next_cursor === "" || page.next_cursor === LAST_CURSOR,
    "incomplete_trade_response",
    "Exact trade lookup returned an incomplete page",
  );
  return page.data;
}

function assertCredentialOwner(value, apiKey, code = "trade_wallet_mismatch") {
  invariant(String(value || "") === apiKey, code, "Associated trade is outside the selected credential owner");
}

function extractContribution(body, {
  requestedTradeId,
  apiKey,
  depositWallet,
  orderId,
  marketConditionId,
  outcomeTokenId,
}) {
  const rows = responseRows(body);
  if (rows.length === 0) {
    fail("trade_not_found", "Polymarket did not return the exact associated trade");
  }
  invariant(rows.length === 1, "ambiguous_trade_response", "Exact trade lookup returned more than one trade");
  const trade = record(rows[0], "invalid_trade_response", "Polymarket returned an invalid trade");
  const tradeId = safeTradeId(trade.id, "Returned trade ID");
  invariant(tradeId === requestedTradeId, "trade_identity_mismatch", "Polymarket returned another trade ID");
  invariant(
    canonicalHash(trade.market, "Trade market") === marketConditionId,
    "trade_market_mismatch",
    "Associated trade is for another market",
  );
  invariant(
    canonicalTokenId(trade.asset_id) === outcomeTokenId,
    "trade_token_mismatch",
    "Associated trade is for another outcome token",
  );
  const venueStatus = canonicalStatus(trade.status);
  const transactionHash = canonicalHash(trade.transaction_hash, "Trade transaction hash");
  assertCredentialOwner(trade.owner, apiKey);
  invariant(
    canonicalAddress(trade.maker_address, "Trade deposit wallet") === depositWallet,
    "trade_wallet_mismatch",
    "Associated trade is for another deposit wallet",
  );
  const takerOrderId = canonicalHash(trade.taker_order_id, "Taker order ID");
  invariant(Array.isArray(trade.maker_orders), "invalid_trade_response", "Associated trade omitted maker-order attribution");
  const matchingMakerOrders = trade.maker_orders.filter((candidate) =>
    String(candidate?.order_id || "").toLowerCase() === orderId);
  const takerMatch = takerOrderId === orderId;
  invariant(
    Number(takerMatch) + matchingMakerOrders.length === 1,
    "ambiguous_trade_attribution",
    "Associated trade does not identify the pinned order exactly once",
  );

  const traderSide = String(trade.trader_side || "").toUpperCase();
  let size;
  let price;
  let orderRole;
  if (takerMatch) {
    invariant(traderSide === "TAKER", "trade_role_mismatch", "Pinned taker order was not attributed to the authenticated taker");
    canonicalSide(trade.side);
    size = positiveClobShares(trade.size, "Taker matched shares");
    price = canonicalPrice(trade.price);
    orderRole = "TAKER";
  } else {
    invariant(traderSide === "MAKER", "trade_role_mismatch", "Pinned maker order was not attributed to the authenticated maker");
    const maker = record(matchingMakerOrders[0], "invalid_trade_response", "Matching maker-order contribution is invalid");
    invariant(
      canonicalHash(maker.order_id, "Maker order ID") === orderId,
      "trade_order_mismatch",
      "Maker contribution is for another order",
    );
    assertCredentialOwner(maker.owner, apiKey);
    invariant(
      canonicalAddress(maker.maker_address, "Maker contribution wallet") === depositWallet,
      "trade_wallet_mismatch",
      "Maker contribution is for another deposit wallet",
    );
    invariant(
      canonicalTokenId(maker.asset_id) === outcomeTokenId,
      "trade_token_mismatch",
      "Maker contribution is for another outcome token",
    );
    canonicalSide(maker.side);
    size = positiveClobShares(maker.matched_amount, "Maker matched shares");
    price = canonicalPrice(maker.price);
    orderRole = "MAKER";
  }

  return Object.freeze({
    tradeId,
    orderRole,
    orderId,
    marketConditionId,
    outcomeTokenId,
    side: "SELL",
    depositWallet,
    matchedShares: size.formatted,
    matchedSharesRaw: size.raw.toString(),
    price: price.formatted,
    priceRaw: price.raw.toString(),
    status: "CONFIRMED",
    venueStatus,
    transactionHash,
  });
}

async function fetchOneTrade({
  tradeId,
  auth,
  signerAddress,
  depositWallet,
  orderId,
  marketConditionId,
  outcomeTokenId,
  timestamp,
  fetchImpl,
  origin,
}) {
  const query = new URLSearchParams({ id: tradeId });
  const headers = hmacHeaders({ ...auth, signerAddress, timestamp });
  let response;
  let body;
  try {
    response = await fetchImpl(`${origin}${TRADES_PATH}?${query}`, {
      method: "GET",
      headers,
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
    });
    body = await response.json();
  } catch {
    fail("trade_unavailable", "Exact associated Polymarket trade could not be fetched");
  }
  if (!response.ok) {
    fail(
      response.status === 404 ? "trade_not_found" : "trade_unavailable",
      response.status === 404
        ? "Polymarket did not return the exact associated trade"
        : "Polymarket returned an invalid exact-trade response",
      { status: response.status },
    );
  }
  return extractContribution(body, {
    requestedTradeId: tradeId,
    apiKey: auth.apiKey,
    depositWallet,
    orderId,
    marketConditionId,
    outcomeTokenId,
  });
}

export async function fetchExactAssociatedTradeContributions({
  signerAddress: signerValue,
  depositWallet: depositValue,
  orderId: orderValue,
  marketConditionId: marketValue,
  outcomeTokenId: tokenValue,
  exactOrderSnapshot,
  credentials,
  credentialsPath,
  fetchImpl = fetch,
  now = () => Date.now(),
  origin = CLOB_ORIGIN,
} = {}) {
  const signerAddress = canonicalAddress(signerValue, "Polymarket signer address");
  const depositWallet = canonicalAddress(depositValue, "Polymarket deposit wallet");
  const orderId = canonicalHash(orderValue, "Take-profit order ID");
  const marketConditionId = canonicalHash(marketValue, "Market condition ID");
  const outcomeTokenId = canonicalTokenId(tokenValue);
  invariant(
    origin === CLOB_ORIGIN,
    "invalid_trade_origin",
    "Trade recovery must use the canonical Polymarket CLOB",
  );
  const auth = credentials || await loadDepositWalletCredentials({
    signerAddress,
    depositWallet,
    credentialsPath,
  });
  invariant(
    auth.signerAddress === signerAddress && auth.depositWallet === depositWallet,
    "trade_wallet_mismatch",
    "Polymarket trade credentials changed wallet identity",
  );
  const associatedTradeIds = validateExactOrderSnapshot(exactOrderSnapshot, {
    signerAddress,
    depositWallet,
    orderId,
    marketConditionId,
    outcomeTokenId,
  });

  const nowMs = Number(now());
  const timestamp = Math.floor(nowMs / 1_000);
  invariant(
    Number.isFinite(nowMs) && Number.isSafeInteger(timestamp) && timestamp > 0,
    "invalid_trade_clock",
    "Trade-recovery clock is invalid",
  );

  const contributions = new Array(associatedTradeIds.length);
  let cursor = 0;
  async function worker() {
    while (cursor < associatedTradeIds.length) {
      const index = cursor;
      cursor += 1;
      contributions[index] = await fetchOneTrade({
        tradeId: associatedTradeIds[index],
        auth,
        signerAddress,
        depositWallet,
        orderId,
        marketConditionId,
        outcomeTokenId,
        timestamp,
        fetchImpl,
        origin,
      });
    }
  }
  await Promise.all(
    Array.from(
      { length: Math.min(FETCH_CONCURRENCY, associatedTradeIds.length) },
      () => worker(),
    ),
  );

  const returnedTradeIds = contributions.map(({ tradeId }) => tradeId);
  invariant(
    returnedTradeIds.length === associatedTradeIds.length &&
      returnedTradeIds.every((value, index) => value === associatedTradeIds[index]) &&
      new Set(returnedTradeIds).size === returnedTradeIds.length,
    "incomplete_trade_recovery",
    "Recovered trades differ from the exact order's associated trade IDs",
  );
  const transactionHashes = [...new Set(contributions.map(({ transactionHash }) => transactionHash))];
  const result = {
    version: "conviction-polymarket-associated-trades-v1",
    verificationSource: "authenticated-polymarket-clob",
    onChain: false,
    fetchedAt: new Date(nowMs).toISOString(),
    signerAddress,
    depositWallet,
    orderId,
    marketConditionId,
    outcomeTokenId,
    associatedTradeIds: Object.freeze([...associatedTradeIds]),
    transactionHashes: Object.freeze(transactionHashes),
    contributions: Object.freeze(contributions),
  };
  return Object.freeze(result);
}
