import { createHmac } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { ConvictionError, invariant } from "./errors.mjs";

const CLOB_ORIGIN = "https://clob.polymarket.com";
const ORDERS_PATH = "/data/orders";
const LAST_CURSOR = "LTE=";
const MAX_PAGES = 1_000;
const MAX_ORDERS = 100_000;
const ADDRESS_RE = /^0x[0-9a-f]{40}$/;
const TOKEN_ID_RE = /^(0|[1-9]\d*)$/;

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

function hmacHeaders({ signerAddress, apiKey, secret, passphrase, timestamp }) {
  invariant(
    typeof apiKey === "string" && apiKey.length > 0 &&
      typeof passphrase === "string" && passphrase.length > 0 &&
      typeof secret === "string" && /^[A-Za-z0-9_-]+={0,2}$/.test(secret),
    "invalid_open_orders_credentials",
    "Polymarket credentials are incomplete",
  );
  const secretBytes = Buffer.from(secret, "base64url");
  invariant(secretBytes.length > 0, "invalid_open_orders_credentials", "Polymarket credential secret is invalid");
  const message = `${timestamp}GET${ORDERS_PATH}`;
  const signature = paddedBase64Url(createHmac("sha256", secretBytes).update(message).digest());
  return {
    POLY_ADDRESS: signerAddress,
    POLY_SIGNATURE: signature,
    POLY_TIMESTAMP: String(timestamp),
    POLY_API_KEY: apiKey,
    POLY_PASSPHRASE: passphrase,
  };
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
  let cursor = "";
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const query = new URLSearchParams({ status: "OPEN", asset_id: outcomeTokenId });
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
    for (const order of body.data) {
      const returnedTokenId = String(order?.asset_id ?? order?.token_id ?? "");
      if (!TOKEN_ID_RE.test(returnedTokenId) || returnedTokenId !== outcomeTokenId) {
        fail("open_orders_token_mismatch", "Polymarket returned an order outside the selected outcome token");
      }
    }
    orders.push(...body.data);
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
