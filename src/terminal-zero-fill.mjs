import { sha256 } from "./canonical.mjs";
import { parseDecimal } from "./decimal.mjs";
import { invariant } from "./errors.mjs";
import { parsePolymarketShareAtoms } from "./polymarket-quantities.mjs";

const ADDRESS_RE = /^0x[0-9a-f]{40}$/;
const HASH_RE = /^0x[0-9a-f]{64}$/;
const TOKEN_ID_RE = /^(?:0|[1-9][0-9]*)$/;
const TERMINAL_STATUSES = new Set([
  "CANCELED",
  "EXPIRED",
]);
const MAX_FUTURE_SKEW_MS = 1_000;
const DEFAULT_MAX_SNAPSHOT_AGE_MS = 15_000;

function canonicalAddress(value, label) {
  const address = String(value || "").toLowerCase();
  invariant(ADDRESS_RE.test(address), "terminal_zero_identity_mismatch", `${label} is invalid`);
  return address;
}

function canonicalHash(value, label) {
  const hash = String(value || "").toLowerCase();
  invariant(HASH_RE.test(hash), "terminal_zero_identity_mismatch", `${label} is invalid`);
  return hash;
}

function canonicalTokenId(value) {
  const tokenId = String(value ?? "");
  invariant(TOKEN_ID_RE.test(tokenId), "terminal_zero_identity_mismatch", "Outcome token ID is invalid");
  return tokenId;
}

function canonicalNow(value) {
  const milliseconds = typeof value === "function" ? Number(value()) : Number(value ?? Date.now());
  invariant(Number.isFinite(milliseconds), "invalid_order_clock", "Terminal zero-fill clock is invalid");
  return milliseconds;
}

/**
 * Independently bind a terminal plugin result to a fresh authenticated exact
 * CLOB order. FAK/FOK non-resting semantics are accepted only with zero
 * matched shares and no associated trades. Unknown or active states fail
 * closed and keep the execution lock for manual reconciliation.
 */
export function verifyTerminalZeroFillOrder({
  action,
  signerAddress,
  wallet,
  live,
  snapshot,
  confirmedAt,
  expiresAt,
  now = Date.now,
  maxSnapshotAgeMs = DEFAULT_MAX_SNAPSHOT_AGE_MS,
} = {}) {
  invariant(action === "OPEN" || action === "CLOSE", "invalid_terminal_zero_action", "Terminal zero-fill action is invalid");
  invariant(live?.ok === true && live.validated && live.result, "invalid_terminal_zero_result", "Terminal plugin result was not validated");
  invariant(snapshot && typeof snapshot === "object" && !Array.isArray(snapshot), "invalid_order_snapshot", "Exact-order snapshot is missing");
  invariant(snapshot.order && typeof snapshot.order === "object" && !Array.isArray(snapshot.order), "invalid_order_snapshot", "Exact-order body is missing");
  invariant(
    snapshot.version === "conviction-polymarket-order-snapshot-v1" &&
      snapshot.verificationSource === "authenticated-polymarket-clob" &&
      snapshot.onChain === false && snapshot.credentialOwnerVerified === true,
    "invalid_order_snapshot",
    "Terminal order evidence is not an authenticated exact CLOB snapshot",
  );

  const observedAt = canonicalNow(now);
  const fetchedAt = Date.parse(String(snapshot.fetchedAt || ""));
  invariant(Number.isFinite(fetchedAt), "invalid_order_snapshot", "Exact-order snapshot time is invalid");
  invariant(
    Number.isSafeInteger(maxSnapshotAgeMs) && maxSnapshotAgeMs > 0 &&
      fetchedAt <= observedAt + MAX_FUTURE_SKEW_MS && observedAt - fetchedAt <= maxSnapshotAgeMs,
    "stale_order_snapshot",
    "Exact terminal order snapshot is stale or from the future",
  );

  const validated = live.validated;
  const intent = validated.intent;
  const order = snapshot.order;
  const expectedSigner = canonicalAddress(signerAddress, "Signer address");
  const expectedWallet = canonicalAddress(wallet, "Deposit wallet");
  const expectedOrderId = canonicalHash(live.orderId, "Terminal order ID");
  const expectedTokenId = canonicalTokenId(validated.tokenId);
  const expectedCondition = canonicalHash(intent?.market?.conditionId, "Market condition ID");
  const expectedSide = action === "OPEN" ? "BUY" : "SELL";
  const expectedOrderType = action === "OPEN" ? "FAK" : "FOK";
  const expectedPrice = action === "OPEN" ? validated.bounds.maxPrice : validated.bounds.minPrice;
  const expectedSharesRaw = BigInt(String(
    action === "OPEN" ? validated.bounds.fullFillSharesRaw : validated.bounds.sharesRaw,
  ));
  const confirmedAtMs = Date.parse(String(confirmedAt || ""));
  const expiresAtMs = Date.parse(String(expiresAt || ""));
  const capturedAtMs = Date.parse(String(validated.intent?.snapshot?.capturedAt || ""));
  invariant(
    Number.isFinite(confirmedAtMs) && Number.isFinite(expiresAtMs) &&
      Number.isFinite(capturedAtMs) && confirmedAtMs < expiresAtMs,
    "invalid_terminal_zero_window",
    "Terminal zero-fill signed and confirmed window is invalid",
  );

  invariant(canonicalAddress(snapshot.signerAddress, "Snapshot signer") === expectedSigner, "order_wallet_mismatch", "Exact order belongs to another signer");
  invariant(canonicalAddress(snapshot.depositWallet, "Snapshot wallet") === expectedWallet, "order_wallet_mismatch", "Exact order belongs to another deposit wallet");
  invariant(canonicalHash(order.id, "Snapshot order ID") === expectedOrderId, "order_identity_mismatch", "Exact snapshot is for another order ID");
  invariant(canonicalHash(order.market, "Snapshot market") === expectedCondition, "order_market_mismatch", "Exact snapshot is for another market");
  invariant(canonicalTokenId(order.assetId) === expectedTokenId, "order_token_mismatch", "Exact snapshot is for another outcome token");
  invariant(order.side === expectedSide && order.orderType === expectedOrderType, "order_type_mismatch", "Exact snapshot is not the signed non-resting order type");
  if (String(order.outcome || "")) {
    invariant(String(order.outcome).toUpperCase() === validated.outcome, "order_outcome_mismatch", "Exact snapshot is for another outcome");
  }

  const originalRaw = parsePolymarketShareAtoms(order.originalSize, "Terminal order original size", {
    code: "invalid_order_response",
    positive: true,
  });
  const matchedRaw = parsePolymarketShareAtoms(order.sizeMatched, "Terminal order matched size", {
    code: "invalid_order_response",
  });
  invariant(expectedSharesRaw > 0n && originalRaw === expectedSharesRaw, "order_size_mismatch", "Exact order size differs from the signed card");
  if (action === "CLOSE") {
    invariant(
      BigInt(String(live.reportedSharesRaw || "-1")) === expectedSharesRaw,
      "order_size_mismatch",
      "Terminal CLOSE result differs from the signed exact size",
    );
  }
  invariant(matchedRaw === 0n, "nonzero_terminal_fill", "Terminal order reports matched shares");
  invariant(parseDecimal(order.price, 6, "Terminal order price") === parseDecimal(expectedPrice, 6, "Signed order price"), "order_price_mismatch", "Exact order price differs from the signed bound");
  invariant(order.expiration === "" || order.expiration === "0", "resting_order_mismatch", "FAK/FOK terminal order unexpectedly has an expiry");
  invariant(Array.isArray(order.associatedTrades) && order.associatedTrades.length === 0, "nonzero_terminal_fill", "Terminal zero-fill order has associated trades");

  const createdAtText = String(order.createdAt || "");
  invariant(/^(?:0|[1-9][0-9]*)$/.test(createdAtText), "invalid_order_response", "Exact order creation time is invalid");
  const createdAtSeconds = BigInt(createdAtText);
  const confirmedAtSeconds = BigInt(Math.floor(confirmedAtMs / 1_000));
  const expiresAtSeconds = BigInt(Math.floor(expiresAtMs / 1_000));
  const capturedAtSeconds = BigInt(Math.floor(capturedAtMs / 1_000));
  const fetchedAtSeconds = BigInt(Math.floor(fetchedAt / 1_000));
  invariant(createdAtSeconds > confirmedAtSeconds, "order_before_confirmation", "Exact terminal order does not strictly postdate trade confirmation");
  invariant(
    createdAtSeconds >= capturedAtSeconds && createdAtSeconds <= expiresAtSeconds &&
      createdAtSeconds <= fetchedAtSeconds,
    "order_outside_signed_window",
    "Exact terminal order was created outside the signed card and snapshot window",
  );

  const status = String(order.status || "").toUpperCase();
  invariant(TERMINAL_STATUSES.has(status), "nonterminal_order", "Exact CLOB order is not in a supported terminal zero-fill state");
  const proof = Object.freeze({
    version: "conviction-terminal-zero-fill-proof-v1",
    action,
    verificationSource: "authenticated-polymarket-clob",
    onChain: false,
    signerAddress: expectedSigner,
    wallet: expectedWallet,
    intentHash: validated.intentHash,
    orderId: expectedOrderId,
    marketConditionId: expectedCondition,
    outcome: validated.outcome,
    outcomeTokenId: expectedTokenId,
    side: expectedSide,
    orderType: expectedOrderType,
    status,
    originalSharesRaw: originalRaw.toString(),
    matchedSharesRaw: "0",
    associatedTradeCount: 0,
    createdAt: createdAtText,
    confirmedAt: new Date(confirmedAtMs).toISOString(),
    signedExpiresAt: new Date(expiresAtMs).toISOString(),
    snapshotHash: sha256(snapshot),
    pluginResultHash: sha256(live.result),
    observedAt: new Date(observedAt).toISOString(),
    checks: Object.freeze({
      credentialOwnerVerified: true,
      exactOrderIdentity: true,
      signedMarketTokenWallet: true,
      signedSideTypePriceSize: true,
      nonRestingOrder: true,
      terminalStatus: true,
      zeroMatchedShares: true,
      zeroAssociatedTrades: true,
      zeroSettlementTransactions: true,
      strictlyAfterTradeConfirmation: true,
      insideSignedCardWindow: true,
    }),
  });
  return Object.freeze({ ok: true, proof, proofHash: sha256(proof) });
}
