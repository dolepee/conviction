import { createHmac } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { ConvictionError, invariant } from "./errors.mjs";
import { parsePolymarketShareAtoms } from "./polymarket-quantities.mjs";

const CLOB_ORIGIN = "https://clob.polymarket.com";
const ORDERS_PATH = "/data/orders";
const ORDER_PATH_PREFIX = "/data/order/";
const LAST_CURSOR = "LTE=";
const MAX_PAGES = 1_000;
const MAX_ORDERS = 100_000;
const ADDRESS_RE = /^0x[0-9a-f]{40}$/;
const TOKEN_ID_RE = /^(0|[1-9]\d*)$/;
const ORDER_ID_RE = /^0x[0-9a-f]{64}$/;
const SAFE_STATUS_RE = /^[A-Z0-9_]{1,64}$/;
const CANONICAL_ORDER_STATUSES = new Map([
  ["ORDER_STATUS_LIVE", "LIVE"],
  ["ORDER_STATUS_OPEN", "OPEN"],
  ["ORDER_STATUS_UNMATCHED", "UNMATCHED"],
  ["ORDER_STATUS_MATCHED", "MATCHED"],
  ["ORDER_STATUS_CANCELED", "CANCELED"],
  ["ORDER_STATUS_CANCELLED", "CANCELED"],
  ["ORDER_STATUS_CANCELED_MARKET_RESOLVED", "CANCELED"],
  ["ORDER_STATUS_EXPIRED", "EXPIRED"],
]);

function fail(code, message, details) {
  throw new ConvictionError(code, message, details);
}

function canonicalAddress(value, label) {
  const address = String(value || "").toLowerCase();
  invariant(ADDRESS_RE.test(address), "invalid_open_orders_identity", `${label} is invalid`);
  return address;
}

function canonicalTokenId(value) {
  const tokenId = String(value || "");
  invariant(TOKEN_ID_RE.test(tokenId), "invalid_open_orders_identity", "Outcome token ID is not canonical");
  return tokenId;
}

function paddedBase64Url(buffer) {
  return buffer.toString("base64").replaceAll("+", "-").replaceAll("/", "_");
}

function hmacHeaders({ signerAddress, apiKey, secret, passphrase, timestamp, requestPath = ORDERS_PATH }) {
  invariant(
    typeof apiKey === "string" && apiKey.length > 0 &&
      typeof passphrase === "string" && passphrase.length > 0 &&
      typeof secret === "string" && /^[A-Za-z0-9_-]+={0,2}$/.test(secret),
    "invalid_open_orders_credentials",
    "Polymarket credentials are incomplete",
  );
  const secretBytes = Buffer.from(secret, "base64url");
  invariant(secretBytes.length > 0, "invalid_open_orders_credentials", "Polymarket credential secret is invalid");
  const message = `${timestamp}GET${requestPath}`;
  const signature = paddedBase64Url(createHmac("sha256", secretBytes).update(message).digest());
  return {
    POLY_ADDRESS: signerAddress,
    POLY_SIGNATURE: signature,
    POLY_TIMESTAMP: String(timestamp),
    POLY_API_KEY: apiKey,
    POLY_PASSPHRASE: passphrase,
  };
}

function canonicalOrderId(value) {
  const orderId = String(value || "").toLowerCase();
  invariant(ORDER_ID_RE.test(orderId), "invalid_order_identity", "Polymarket order ID is invalid");
  return orderId;
}

function canonicalOrderStatus(value, code) {
  const status = typeof value === "string" ? value.toUpperCase() : "";
  invariant(SAFE_STATUS_RE.test(status), code, "Polymarket order status is invalid");
  return CANONICAL_ORDER_STATUSES.get(status) || status;
}

export async function loadDepositWalletCredentials({
  signerAddress: signerValue,
  depositWallet: depositValue,
  credentialsPath = join(homedir(), ".config", "polymarket", "creds.json"),
} = {}) {
  const signerAddress = canonicalAddress(signerValue, "Polymarket signer address");
  const depositWallet = canonicalAddress(depositValue, "Polymarket deposit wallet");
  let metadata;
  let document;
  try {
    [metadata, document] = await Promise.all([
      stat(credentialsPath),
      readFile(credentialsPath, "utf8"),
    ]);
  } catch {
    fail("missing_open_orders_credentials", "Polymarket credential store is unavailable");
  }
  if (process.platform !== "win32" && (metadata.mode & 0o077) !== 0) {
    fail("unsafe_open_orders_credentials", "Polymarket credential store is not owner-only");
  }

  let store;
  try {
    store = JSON.parse(document);
  } catch {
    fail("invalid_open_orders_credentials", "Polymarket credential store is malformed");
  }
  invariant(store?._version === 2, "invalid_open_orders_credentials", "Polymarket credential store version is unsupported");
  const credentials = store[signerAddress];
  invariant(credentials && typeof credentials === "object", "missing_open_orders_credentials", "No Polymarket credentials exist for the active signer");
  invariant(
    credentials.mode === "deposit_wallet" &&
      String(credentials.deposit_wallet || "").toLowerCase() === depositWallet,
    "open_orders_wallet_mismatch",
    "Polymarket credentials are not bound to the selected deposit wallet",
  );
  return Object.freeze({
    signerAddress,
    depositWallet,
    apiKey: credentials.api_key,
    secret: credentials.secret,
    passphrase: credentials.passphrase,
  });
}

export async function fetchAllOpenOrders({
  signerAddress: signerValue,
  depositWallet: depositValue,
  outcomeTokenId: tokenValue,
  credentials,
  credentialsPath,
  fetchImpl = fetch,
  now = () => Date.now(),
  origin = CLOB_ORIGIN,
} = {}) {
  const signerAddress = canonicalAddress(signerValue, "Polymarket signer address");
  const depositWallet = canonicalAddress(depositValue, "Polymarket deposit wallet");
  const outcomeTokenId = canonicalTokenId(tokenValue);
  invariant(origin === CLOB_ORIGIN, "invalid_open_orders_origin", "Open-order verification must use the canonical Polymarket CLOB");
  const auth = credentials || await loadDepositWalletCredentials({
    signerAddress,
    depositWallet,
    credentialsPath,
  });
  invariant(
    auth.signerAddress === signerAddress && auth.depositWallet === depositWallet,
    "open_orders_wallet_mismatch",
    "Open-order credentials changed wallet identity",
  );

  const orders = [];
  const seenCursors = new Set();
  const seenOrderIds = new Set();
  let cursor = "";
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const query = new URLSearchParams({ asset_id: outcomeTokenId });
    if (cursor) query.set("next_cursor", cursor);
    const timestamp = Math.floor(Number(now()) / 1_000);
    invariant(Number.isSafeInteger(timestamp) && timestamp > 0, "invalid_open_orders_clock", "Open-order clock is invalid");
    const headers = hmacHeaders({ ...auth, signerAddress, timestamp });

    let response;
    let body;
    try {
      response = await fetchImpl(`${origin}${ORDERS_PATH}?${query}`, {
        method: "GET",
        headers,
        redirect: "error",
        signal: AbortSignal.timeout(10_000),
      });
      body = await response.json();
    } catch {
      fail("open_orders_unavailable", "Complete Polymarket open orders could not be fetched");
    }
    if (!response.ok || !body || !Array.isArray(body.data)) {
      fail("open_orders_unavailable", "Polymarket returned an invalid open-orders page", {
        status: response.status,
      });
    }
    if (!Object.hasOwn(body, "next_cursor") || typeof body.next_cursor !== "string") {
      fail("incomplete_open_orders", "Polymarket omitted the pagination completeness cursor");
    }
    if (
      !Number.isSafeInteger(body.count) || body.count < 0 || body.count !== body.data.length ||
      !Number.isSafeInteger(body.limit) || body.limit <= 0 || body.count > body.limit
    ) {
      fail("incomplete_open_orders", "Polymarket returned inconsistent open-order page metadata");
    }
    const normalizedPage = [];
    for (const order of body.data) {
      const returnedTokenId = String(order?.asset_id ?? order?.token_id ?? "");
      if (!TOKEN_ID_RE.test(returnedTokenId) || returnedTokenId !== outcomeTokenId) {
        fail("open_orders_token_mismatch", "Polymarket returned an order outside the selected outcome token");
      }
      if (
        String(order?.owner || "") !== auth.apiKey ||
        String(order?.maker_address || "").toLowerCase() !== depositWallet
      ) {
        fail("open_orders_wallet_mismatch", "Polymarket returned an order outside the selected credential and deposit wallet");
      }
      const orderId = String(order?.id || "");
      if (!orderId || seenOrderIds.has(orderId)) {
        fail("incomplete_open_orders", "Polymarket returned a missing or repeated open-order ID");
      }
      seenOrderIds.add(orderId);
      const originalSizeRaw = parsePolymarketShareAtoms(order?.original_size, "Open-order original size", {
        code: "invalid_open_orders_quantity",
        positive: true,
      });
      const sizeMatchedRaw = parsePolymarketShareAtoms(order?.size_matched, "Open-order matched size", {
        code: "invalid_open_orders_quantity",
      });
      invariant(
        sizeMatchedRaw <= originalSizeRaw,
        "invalid_open_orders_quantity",
        "Open-order matched size exceeds its original size",
      );
      normalizedPage.push(Object.freeze({
        ...order,
        status: canonicalOrderStatus(order?.status, "invalid_open_orders_status"),
        original_size: originalSizeRaw.toString(),
        size_matched: sizeMatchedRaw.toString(),
      }));
    }
    orders.push(...normalizedPage);
    if (orders.length > MAX_ORDERS) {
      fail("open_orders_limit", "Polymarket open-order verification exceeded its safe bound");
    }

    const next = body.next_cursor;
    if (next === "" || next === LAST_CURSOR) {
      return Object.freeze({
        complete: true,
        pageCount: page,
        outcomeTokenId,
        orders: Object.freeze(orders),
      });
    }
    if (seenCursors.has(next)) {
      fail("incomplete_open_orders", "Polymarket repeated an open-orders cursor");
    }
    seenCursors.add(next);
    cursor = next;
  }
  fail("open_orders_limit", "Polymarket open-order pagination did not terminate");
}

export async function fetchExactOrder({
  signerAddress: signerValue,
  depositWallet: depositValue,
  orderId: orderValue,
  outcomeTokenId: tokenValue,
  credentials,
  credentialsPath,
  fetchImpl = fetch,
  now = () => Date.now(),
  origin = CLOB_ORIGIN,
} = {}) {
  const signerAddress = canonicalAddress(signerValue, "Polymarket signer address");
  const depositWallet = canonicalAddress(depositValue, "Polymarket deposit wallet");
  const orderId = canonicalOrderId(orderValue);
  const outcomeTokenId = canonicalTokenId(tokenValue);
  invariant(origin === CLOB_ORIGIN, "invalid_order_origin", "Order verification must use the canonical Polymarket CLOB");
  const auth = credentials || await loadDepositWalletCredentials({
    signerAddress,
    depositWallet,
    credentialsPath,
  });
  invariant(
    auth.signerAddress === signerAddress && auth.depositWallet === depositWallet,
    "order_wallet_mismatch",
    "Polymarket order credentials changed wallet identity",
  );

  const requestPath = `${ORDER_PATH_PREFIX}${orderId}`;
  const nowMs = Number(now());
  const timestamp = Math.floor(nowMs / 1_000);
  invariant(
    Number.isFinite(nowMs) && Number.isSafeInteger(timestamp) && timestamp > 0,
    "invalid_order_clock",
    "Order-verification clock is invalid",
  );
  const headers = hmacHeaders({ ...auth, signerAddress, timestamp, requestPath });
  let response;
  let body;
  try {
    response = await fetchImpl(`${origin}${requestPath}`, {
      method: "GET",
      headers,
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
    });
    body = await response.json();
  } catch {
    fail("order_unavailable", "Exact Polymarket order could not be fetched");
  }
  if (response.status === 404) {
    fail("order_not_found", "Polymarket did not return the exact order");
  }
  if (!response.ok || !body || typeof body !== "object" || Array.isArray(body)) {
    fail("order_unavailable", "Polymarket returned an invalid exact-order response", {
      status: response.status,
    });
  }
  if (String(body.id || "").toLowerCase() !== orderId) {
    fail("order_identity_mismatch", "Polymarket returned another order ID");
  }
  if (String(body.asset_id || "") !== outcomeTokenId) {
    fail("order_token_mismatch", "Polymarket returned another outcome token");
  }
  if (
    String(body.owner || "") !== auth.apiKey ||
    String(body.maker_address || "").toLowerCase() !== depositWallet
  ) {
    fail("order_wallet_mismatch", "Polymarket returned an order outside the selected credential and deposit wallet");
  }
  const associatedTrades = Array.isArray(body.associate_trades)
    ? body.associate_trades.map((value) => String(value))
    : null;
  if (!associatedTrades || associatedTrades.some((value) => !value || value !== value.trim())) {
    fail("invalid_order_response", "Polymarket returned invalid associated-trade metadata");
  }
  const originalSizeRaw = parsePolymarketShareAtoms(body.original_size, "Order original size", {
    code: "invalid_order_response",
    positive: true,
  });
  const sizeMatchedRaw = parsePolymarketShareAtoms(body.size_matched, "Order matched size", {
    code: "invalid_order_response",
  });
  invariant(
    sizeMatchedRaw <= originalSizeRaw,
    "invalid_order_response",
    "Polymarket order matched size exceeds its original size",
  );

  return Object.freeze({
    version: "conviction-polymarket-order-snapshot-v1",
    verificationSource: "authenticated-polymarket-clob",
    onChain: false,
    fetchedAt: new Date(nowMs).toISOString(),
    signerAddress,
    depositWallet,
    credentialOwnerVerified: true,
    order: Object.freeze({
      id: orderId,
      status: canonicalOrderStatus(body.status, "invalid_order_response"),
      market: String(body.market || "").toLowerCase(),
      assetId: String(body.asset_id || ""),
      side: String(body.side || "").toUpperCase(),
      // These snapshot fields remain atomic integer strings. Human-readable
      // formatting only happens after the lifecycle verifier has bound them.
      originalSize: originalSizeRaw.toString(),
      sizeMatched: sizeMatchedRaw.toString(),
      price: String(body.price ?? ""),
      orderType: String(body.order_type || "").toUpperCase(),
      expiration: String(body.expiration ?? ""),
      outcome: String(body.outcome || ""),
      createdAt: String(body.created_at || ""),
      associatedTrades: Object.freeze(associatedTrades),
    }),
  });
}
