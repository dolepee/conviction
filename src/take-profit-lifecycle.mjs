import { sha256 } from "./canonical.mjs";
import { formatDecimal, parseDecimal } from "./decimal.mjs";
import { invariant } from "./errors.mjs";
import {
  parsePolymarketShareAtoms,
  POLYMARKET_SHARE_DECIMALS,
} from "./polymarket-quantities.mjs";
import {
  trustedIssuerRegistry,
  verifyIntentIssuance,
} from "./intent-issuer.mjs";

const ADDRESS_RE = /^0x[0-9a-f]{40}$/;
const HASH_RE = /^0x[0-9a-f]{64}$/;
const TOKEN_ID_RE = /^(?:0|[1-9][0-9]*)$/;
const UINT_RE = /^(?:0|[1-9][0-9]*)$/;
const SHARE_DECIMALS = POLYMARKET_SHARE_DECIMALS;
const DEFAULT_MAX_SNAPSHOT_AGE_MS = 15_000;
const MAX_FUTURE_SKEW_MS = 1_000;
const CANCEL_CONFIRMATION_MAX_AGE_MS = 120_000;

const ACTIVE = new Set([
  "LIVE",
  "OPEN",
  "UNMATCHED",
  "ORDER_STATUS_LIVE",
  "ORDER_STATUS_OPEN",
  "ORDER_STATUS_UNMATCHED",
]);
const CANCELED = new Set([
  "CANCELED",
  "CANCELLED",
  "ORDER_STATUS_CANCELED",
  "ORDER_STATUS_CANCELLED",
]);
const EXPIRED = new Set(["EXPIRED", "ORDER_STATUS_EXPIRED"]);
const MATCHED = new Set(["MATCHED", "ORDER_STATUS_MATCHED"]);

export const TAKE_PROFIT_CANCEL_CONFIRMATION = "confirm cancel take profit";

function record(value, code, message) {
  invariant(value !== null && typeof value === "object" && !Array.isArray(value), code, message);
  return value;
}

function canonicalHash(value, label) {
  const hash = String(value || "");
  invariant(HASH_RE.test(hash), "invalid_take_profit_journal", `${label} must be a canonical lowercase hash`);
  return hash;
}

function canonicalAddress(value, label) {
  const address = String(value || "");
  invariant(ADDRESS_RE.test(address), "invalid_take_profit_journal", `${label} must be a canonical lowercase address`);
  return address;
}

function canonicalTokenId(value, label = "Outcome token ID") {
  const tokenId = String(value ?? "");
  invariant(TOKEN_ID_RE.test(tokenId), "invalid_take_profit_journal", `${label} is invalid`);
  return tokenId;
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
  invariant(Number.isFinite(milliseconds), "invalid_lifecycle_clock", "Take-profit lifecycle clock is invalid");
  return milliseconds;
}

function canonicalUint(value, code, label, { positive = false } = {}) {
  const text = String(value ?? "");
  invariant(UINT_RE.test(text), code, `${label} must be an unsigned integer`);
  const parsed = BigInt(text);
  invariant(!positive || parsed > 0n, code, `${label} must be positive`);
  return parsed;
}

function registry(value) {
  if (value instanceof Map) return value;
  const records = Array.isArray(value) ? value : value?.issuers;
  invariant(Array.isArray(records), "missing_trusted_issuer", "A pinned trusted issuer registry is required");
  return trustedIssuerRegistry(records);
}

function safeExternalText(value, label) {
  const text = String(value ?? "");
  invariant(
    text === text.trim() && text.length > 0 && text.length <= 500 && !/[\u0000-\u001f\u007f]/.test(text),
    "invalid_order_response",
    `${label} is invalid`,
  );
  return text;
}

function sameDecimal(value, expectedRaw, code, label) {
  invariant(parseDecimal(value, SHARE_DECIMALS, label) === expectedRaw, code, `${label} differs from the ARMED take-profit passport`);
}

function issuerSettlementTime(proof) {
  const createdAt = canonicalUint(
    proof?.observed?.createdAt,
    "invalid_take_profit_passport",
    "Resting-order creation time",
    { positive: true },
  );
  const milliseconds = Number(createdAt) * 1_000;
  invariant(Number.isSafeInteger(milliseconds), "invalid_take_profit_passport", "Resting-order creation time is unsafe");
  return new Date(milliseconds).toISOString();
}

/**
 * Validate the immutable identity portion of a stored TAKE_PROFIT journal.
 * Runtime lock/retry metadata is intentionally ignored: it may change without
 * changing the signed intent, passport, or pinned order identity.
 */
export function validateTakeProfitJournal(journalInput, { trustedIssuers } = {}) {
  const journal = record(
    journalInput,
    "invalid_take_profit_journal",
    "Take-profit journal must be an object",
  );
  invariant(
    journal.version === "conviction-take-profit-journey-v1" && journal.action === "TAKE_PROFIT" &&
      (journal.stage === "armed" || journal.stage === "submitted"),
    "invalid_take_profit_journal",
    "Journal is not a supported Conviction take-profit journey",
  );

  const signerAddress = canonicalAddress(journal.signerAddress, "Journal signer address");
  const depositWallet = canonicalAddress(journal.depositWallet, "Journal deposit wallet");
  const orderId = canonicalHash(journal.orderId, "Journal order ID");
  const intentHash = canonicalHash(journal.intentHash, "Journal intent hash");
  const passportHash = canonicalHash(journal.takeProfitPassportHash, "Journal take-profit passport hash");
  const proofHash = canonicalHash(journal.restingOrderProofHash, "Journal resting-order proof hash");
  const passport = record(
    journal.takeProfitPassport,
    "invalid_take_profit_passport",
    "Stored take-profit passport must be an object",
  );
  const intent = record(passport.intent, "invalid_take_profit_passport", "Take-profit passport intent is missing");
  const proof = record(
    passport.restingOrderProof,
    "invalid_take_profit_passport",
    "Take-profit passport resting-order proof is missing",
  );

  invariant(sha256(passport) === passportHash, "take_profit_passport_mismatch", "Stored take-profit passport hash does not match");
  invariant(sha256(proof) === proofHash, "take_profit_passport_mismatch", "Stored resting-order proof hash does not match");
  const initialStatus = String(passport.status || "");
  const armed = initialStatus === "ARMED";
  invariant(
    journal.stage === (armed ? "armed" : "submitted") &&
      (journal.status === undefined || journal.status === initialStatus) && proof.status === initialStatus,
    "invalid_take_profit_journal",
    "Stored take-profit stage, status, passport, and order proof disagree",
  );
  invariant(
    passport.version === "conviction-take-profit-passport-v1" &&
      (armed || [
        "PARTIAL_PENDING_CHAIN_PROOF",
        "PARTIAL_CANCELED_PENDING_CHAIN_PROOF",
        "PARTIAL_EXPIRED_PENDING_CHAIN_PROOF",
        "FILLED_PENDING_CHAIN_PROOF",
        "CANCELED",
        "EXPIRED",
        "UNKNOWN",
      ].includes(initialStatus)),
    "invalid_take_profit_passport",
    "Stored take-profit passport status is unsupported",
  );
  invariant(
    proof.version === (armed ? "conviction-resting-order-proof-v1" : "conviction-submitted-order-proof-v1") &&
      proof.verificationSource === "authenticated-polymarket-clob" && proof.onChain === false,
    "invalid_take_profit_passport",
    "Stored order proof is not an authenticated CLOB binding",
  );
  invariant(
    intent.version === "conviction-take-profit-intent-v1" && intent.action === "TAKE_PROFIT" &&
      Number(intent.chainId) === 137,
    "invalid_take_profit_passport",
    "Stored passport has another action, version, or chain",
  );
  invariant(sha256(intent) === intentHash && proof.intentHash === intentHash, "take_profit_intent_mismatch", "Journal, passport, and proof intent hashes differ");
  invariant(passport.issuance?.intentHash === intentHash, "take_profit_intent_mismatch", "Passport issuance is for another intent");

  const market = record(intent.market, "invalid_take_profit_passport", "Take-profit passport market is missing");
  const order = record(intent.order, "invalid_take_profit_passport", "Take-profit passport order is missing");
  const bounds = record(proof.bounds, "invalid_take_profit_passport", "Resting-order proof bounds are missing");
  const observed = record(proof.observed, "invalid_take_profit_passport", "Resting-order observation is missing");
  const wallet = canonicalAddress(proof.wallet, "Proof wallet");
  const marketConditionId = canonicalHash(proof.marketConditionId, "Proof market condition ID");
  const outcome = String(proof.outcome || "");
  const outcomeTokenId = canonicalTokenId(proof.outcomeTokenId);
  const exactSharesRaw = canonicalUint(bounds.exactSharesRaw, "invalid_take_profit_passport", "Exact take-profit shares", { positive: true });
  const targetPriceRaw = parseDecimal(bounds.targetPrice, SHARE_DECIMALS, "Take-profit target price");
  const venueExpiresAt = canonicalIso(bounds.venueExpiresAt, "invalid_take_profit_passport", "Venue expiry");
  const venueExpiresAtUnix = canonicalUint(bounds.venueExpiresAtUnix, "invalid_take_profit_passport", "Venue expiry Unix time", { positive: true });
  invariant(BigInt(venueExpiresAt.milliseconds / 1_000) === venueExpiresAtUnix, "take_profit_passport_mismatch", "Venue expiry representations differ");

  invariant(wallet === depositWallet, "take_profit_journal_mismatch", "Journal deposit wallet differs from the passport");
  invariant(proof.orderId === orderId, "take_profit_journal_mismatch", "Journal order ID differs from the passport");
  invariant(outcome === "YES" || outcome === "NO", "invalid_take_profit_passport", "Take-profit outcome must be YES or NO");
  invariant(
    String(market.conditionId || "") === marketConditionId && String(market.outcomeTokenId || "") === outcomeTokenId &&
      String(market.outcome || "") === outcome && String(order.outcome || "") === outcome &&
      String(order.outcomeTokenId || "") === outcomeTokenId,
    "take_profit_passport_mismatch",
    "Passport market, outcome, token, and proof identity differ",
  );
  invariant(
    order.action === "TAKE_PROFIT" && order.side === "SELL" && order.orderType === "GTD" && order.postOnly === true,
    "invalid_take_profit_passport",
    "Passport order is not a post-only GTD take-profit SELL",
  );
  invariant(
    String(order.sharesRaw || "") === exactSharesRaw.toString() &&
      parseDecimal(order.targetPrice, SHARE_DECIMALS, "Intent target price") === targetPriceRaw &&
      String(order.venueExpiresAtUnix || "") === venueExpiresAtUnix.toString(),
    "take_profit_passport_mismatch",
    "Passport order quantities, target, or expiry differ from its proof",
  );
  invariant(
    intent.seller?.wallet === wallet &&
      proof.sourceIntentHash === intent.source?.intentHash &&
      proof.sourcePositionProofHash === intent.source?.positionProofHash,
    "take_profit_passport_mismatch",
    "Resting-order proof differs from the signed seller or source position",
  );
  invariant(
    bounds.postOnlyRequested === true && bounds.partialFillAllowed === true &&
      String(bounds.minimumGrossProceedsRaw || "") === String(order.minimumGrossProceedsRaw || "") &&
      String(bounds.maximumFeeRaw || "") === String(order.maximumFeeRaw || "") &&
      String(bounds.minimumNetProceedsRaw || "") === String(order.minimumNetProceedsRaw || ""),
    "take_profit_passport_mismatch",
    "Resting-order proof economics differ from the signed take-profit order",
  );
  const observedStatus = String(observed.status || "").toUpperCase();
  invariant(
    observedStatus.length > 0 && observedStatus.length <= 64 && /^[A-Z0-9_]+$/.test(observedStatus) &&
      observed.side === "SELL" && observed.orderType === "GTD" &&
      String(observed.originalSharesRaw || "") === exactSharesRaw.toString() &&
      parseDecimal(observed.price, SHARE_DECIMALS, "Initially observed target price") === targetPriceRaw &&
      String(observed.expiration || "") === venueExpiresAtUnix.toString(),
    "take_profit_passport_mismatch",
    "Initial authenticated order observation differs from the passport bounds",
  );
  const initialMatchedRaw = canonicalUint(
    observed.matchedSharesRaw,
    "invalid_take_profit_passport",
    "Initially matched take-profit shares",
  );
  invariant(initialMatchedRaw <= exactSharesRaw, "take_profit_passport_mismatch", "Initially matched shares exceed the signed take-profit shares");
  const initialFetchedAt = canonicalIso(observed.fetchedAt, "invalid_take_profit_passport", "Initial order observation time");
  invariant(
    classifyExactOrder({
      matchedRaw: initialMatchedRaw,
      originalRaw: exactSharesRaw,
      status: observedStatus,
      fetchedAtMs: initialFetchedAt.milliseconds,
      expirationMs: venueExpiresAt.milliseconds,
    }) === initialStatus,
    "take_profit_passport_mismatch",
    "Initial order status does not match the authenticated observation",
  );

  const requiredChecks = [
    "canonicalTakeProfitIntentHash",
    "trustedIssuerSignature",
    "verifiedSourcePositionBound",
    "selectedOutcomeToken",
    "exactCredentialOwner",
    "exactDepositWallet",
    "exactOrderId",
    "exactGtdSell",
    "exactSharesOffered",
    "targetPriceBound",
    "venueExpiryBound",
    "orderCreatedAfterConfirmation",
    "orderCreatedInsideSignedPlacementWindow",
  ];
  const checks = record(proof.checks, "invalid_take_profit_passport", "Resting-order proof checks are missing");
  invariant(requiredChecks.every((field) => checks[field] === true), "take_profit_passport_mismatch", "Stored order proof did not pass every required check");
  if (armed) {
    invariant(checks.zeroInitiallyMatched === true, "take_profit_passport_mismatch", "Stored ARMED proof was not initially unmatched");
  } else {
    invariant(
      checks.authenticatedInitialExactOrder === true && checks.initialMatchedSharesBounded === true,
      "take_profit_passport_mismatch",
      "Stored submitted-order proof did not pass its recovery checks",
    );
  }

  const issuanceVerification = verifyIntentIssuance({
    intent,
    intentHash,
    issuance: passport.issuance,
    trustedIssuers: registry(trustedIssuers),
    settledAt: issuerSettlementTime(proof),
  });

  return Object.freeze({
    ok: true,
    signerAddress,
    depositWallet,
    orderId,
    intentHash,
    passportHash,
    proofHash,
    passport,
    proof,
    initialStatus,
    initialMatchedRaw,
    marketConditionId,
    outcome,
    outcomeTokenId,
    exactSharesRaw,
    targetPriceRaw,
    venueExpiresAt: venueExpiresAt.text,
    venueExpiresAtUnix,
    issuanceVerification,
  });
}

export function validateArmedTakeProfitJournal(journalInput, options = {}) {
  const binding = validateTakeProfitJournal(journalInput, options);
  invariant(binding.initialStatus === "ARMED", "invalid_take_profit_journal", "Journal is not an ARMED Conviction take-profit journey");
  return binding;
}

function validateFreshExactOrderSnapshot(binding, snapshotInput, {
  now,
  maxSnapshotAgeMs = DEFAULT_MAX_SNAPSHOT_AGE_MS,
} = {}) {
  const snapshot = record(snapshotInput, "invalid_order_snapshot", "Exact-order snapshot must be an object");
  const order = record(snapshot.order, "invalid_order_snapshot", "Exact-order snapshot order is missing");
  invariant(
    snapshot.version === "conviction-polymarket-order-snapshot-v1" &&
      snapshot.verificationSource === "authenticated-polymarket-clob" && snapshot.onChain === false &&
      snapshot.credentialOwnerVerified === true,
    "invalid_order_snapshot",
    "Order status must come from an authenticated exact CLOB snapshot",
  );
  invariant(
    Number.isSafeInteger(maxSnapshotAgeMs) && maxSnapshotAgeMs > 0,
    "invalid_snapshot_age",
    "Maximum order-snapshot age is invalid",
  );
  const nowMs = nowMilliseconds(now);
  const fetchedAt = canonicalIso(snapshot.fetchedAt, "invalid_order_snapshot", "Order snapshot time");
  invariant(fetchedAt.milliseconds <= nowMs + MAX_FUTURE_SKEW_MS, "future_order_snapshot", "Order snapshot is in the future");
  invariant(nowMs - fetchedAt.milliseconds <= maxSnapshotAgeMs, "stale_order_snapshot", "Order snapshot is stale");
  const armedFetchedAt = canonicalIso(binding.proof.observed.fetchedAt, "invalid_take_profit_passport", "Initial ARMED observation time");
  invariant(fetchedAt.milliseconds >= armedFetchedAt.milliseconds, "order_snapshot_regression", "Order snapshot predates the ARMED proof");

  invariant(canonicalAddress(snapshot.signerAddress, "Snapshot signer address") === binding.signerAddress, "order_wallet_mismatch", "Order snapshot uses another signer");
  invariant(canonicalAddress(snapshot.depositWallet, "Snapshot deposit wallet") === binding.depositWallet, "order_wallet_mismatch", "Order snapshot uses another deposit wallet");
  invariant(String(order.id || "") === binding.orderId, "order_identity_mismatch", "Order snapshot is for another order ID");
  invariant(String(order.market || "") === binding.marketConditionId, "order_market_mismatch", "Order snapshot is for another market");
  invariant(String(order.assetId || "") === binding.outcomeTokenId, "order_token_mismatch", "Order snapshot is for another outcome token");
  invariant(order.side === "SELL" && order.orderType === "GTD", "order_type_mismatch", "Order snapshot is not the pinned GTD SELL");
  if (order.outcome) {
    invariant(String(order.outcome).toUpperCase() === binding.outcome, "order_outcome_mismatch", "Order snapshot is for another outcome");
  }

  const originalRaw = parsePolymarketShareAtoms(order.originalSize, "Order original size", {
    code: "invalid_order_response",
    positive: true,
  });
  const matchedRaw = parsePolymarketShareAtoms(order.sizeMatched, "Order matched size", {
    code: "invalid_order_response",
  });
  invariant(originalRaw === binding.exactSharesRaw, "order_size_mismatch", "Order original size differs from the take-profit passport");
  invariant(matchedRaw >= 0n && matchedRaw <= originalRaw, "invalid_order_response", "Order matched size is invalid");
  invariant(
    matchedRaw >= binding.initialMatchedRaw,
    "order_fill_regression",
    "Order matched quantity decreased below the authenticated initial observation",
  );
  sameDecimal(order.price, binding.targetPriceRaw, "order_price_mismatch", "Order target price");
  invariant(String(order.expiration || "") === binding.venueExpiresAtUnix.toString(), "order_expiry_mismatch", "Order expiry differs from the take-profit passport");
  invariant(String(order.createdAt || "") === String(binding.proof.observed.createdAt), "order_creation_mismatch", "Order creation time differs from the authenticated order proof");

  const associatedTrades = Array.isArray(order.associatedTrades) ? order.associatedTrades : null;
  invariant(associatedTrades, "invalid_order_response", "Order associated trades are missing");
  const tradeIds = associatedTrades.map((value, index) => safeExternalText(value, `Associated trade ${index + 1}`));
  invariant(new Set(tradeIds).size === tradeIds.length, "invalid_order_response", "Order associated trades contain duplicates");

  const status = String(order.status || "").toUpperCase();
  invariant(status.length > 0 && status.length <= 64 && /^[A-Z0-9_]+$/.test(status), "invalid_order_response", "Order status is invalid");
  const remainingRaw = originalRaw - matchedRaw;
  const expirationMs = Number(binding.venueExpiresAtUnix) * 1_000;
  invariant(Number.isSafeInteger(expirationMs), "invalid_take_profit_passport", "Venue expiry is unsafe");
  return Object.freeze({
    snapshot,
    snapshotHash: sha256(snapshot),
    fetchedAt: fetchedAt.text,
    fetchedAtMs: fetchedAt.milliseconds,
    nowMs,
    status,
    originalRaw,
    matchedRaw,
    remainingRaw,
    expirationMs,
    associatedTrades: Object.freeze(tradeIds),
  });
}

function classifyExactOrder(exact) {
  if (exact.matchedRaw === exact.originalRaw) return "FILLED_PENDING_CHAIN_PROOF";
  if (exact.matchedRaw > 0n) {
    if (CANCELED.has(exact.status)) return "PARTIAL_CANCELED_PENDING_CHAIN_PROOF";
    if (EXPIRED.has(exact.status)) return "PARTIAL_EXPIRED_PENDING_CHAIN_PROOF";
    return "PARTIAL_PENDING_CHAIN_PROOF";
  }
  if (CANCELED.has(exact.status)) return "CANCELED";
  if (EXPIRED.has(exact.status)) return "EXPIRED";
  if (ACTIVE.has(exact.status)) {
    return exact.fetchedAtMs < exact.expirationMs ? "ARMED" : "UNKNOWN";
  }
  if (MATCHED.has(exact.status)) return "UNKNOWN";
  return "UNKNOWN";
}

function statusOutput(binding, exact, status) {
  const orderTerminal = [
    "CANCELED",
    "EXPIRED",
    "PARTIAL_CANCELED_PENDING_CHAIN_PROOF",
    "PARTIAL_EXPIRED_PENDING_CHAIN_PROOF",
    "FILLED_PENDING_CHAIN_PROOF",
  ].includes(status);
  const cancelEligible = (status === "ARMED" || status === "PARTIAL_PENDING_CHAIN_PROOF") &&
    ACTIVE.has(exact.status) && exact.remainingRaw > 0n && exact.fetchedAtMs < exact.expirationMs;
  return Object.freeze({
    ok: true,
    version: "conviction-take-profit-status-v1",
    status,
    verificationSource: "authenticated-polymarket-clob",
    onChain: false,
    intentHash: binding.intentHash,
    takeProfitPassportHash: binding.passportHash,
    restingOrderProofHash: binding.proofHash,
    snapshotHash: exact.snapshotHash,
    order: Object.freeze({
      id: binding.orderId,
      wallet: binding.depositWallet,
      marketConditionId: binding.marketConditionId,
      outcome: binding.outcome,
      outcomeTokenId: binding.outcomeTokenId,
      side: "SELL",
      orderType: "GTD",
      venueStatus: exact.status,
      originalShares: formatDecimal(exact.originalRaw, SHARE_DECIMALS),
      originalSharesRaw: exact.originalRaw.toString(),
      matchedShares: formatDecimal(exact.matchedRaw, SHARE_DECIMALS),
      matchedSharesRaw: exact.matchedRaw.toString(),
      remainingShares: formatDecimal(exact.remainingRaw, SHARE_DECIMALS),
      remainingSharesRaw: exact.remainingRaw.toString(),
      targetPrice: formatDecimal(binding.targetPriceRaw, SHARE_DECIMALS),
      venueExpiresAt: binding.venueExpiresAt,
      associatedTrades: exact.associatedTrades,
    }),
    observedAt: exact.fetchedAt,
    orderTerminal,
    settlementProofRequired: exact.matchedRaw > 0n,
    cancelEligible,
    cancellationObserved: CANCELED.has(exact.status),
  });
}

export function buildTakeProfitStatus(journalInput, snapshotInput, options = {}) {
  const binding = validateTakeProfitJournal(journalInput, options);
  const exact = validateFreshExactOrderSnapshot(binding, snapshotInput, options);
  return statusOutput(binding, exact, classifyExactOrder(exact));
}

export function buildTakeProfitLookupFailureStatus(journalInput, {
  errorCode,
  observedAt,
} = {}, options = {}) {
  const binding = validateTakeProfitJournal(journalInput, options);
  const code = String(errorCode || "");
  invariant(
    ["order_not_found", "order_unavailable", "unknown"].includes(code),
    "invalid_order_lookup_failure",
    "Unsupported exact-order lookup failure",
  );
  const observation = canonicalIso(observedAt, "invalid_order_lookup_failure", "Order lookup failure time");
  const nowMs = nowMilliseconds(options.now);
  invariant(observation.milliseconds <= nowMs + MAX_FUTURE_SKEW_MS, "future_order_snapshot", "Order lookup failure is in the future");
  return Object.freeze({
    ok: false,
    version: "conviction-take-profit-status-v1",
    status: "UNKNOWN",
    verificationSource: "authenticated-polymarket-clob",
    onChain: false,
    intentHash: binding.intentHash,
    takeProfitPassportHash: binding.passportHash,
    restingOrderProofHash: binding.proofHash,
    order: Object.freeze({
      id: binding.orderId,
      wallet: binding.depositWallet,
      marketConditionId: binding.marketConditionId,
      outcome: binding.outcome,
      outcomeTokenId: binding.outcomeTokenId,
    }),
    observedAt: observation.text,
    lookupErrorCode: code,
    orderTerminal: false,
    // The last authenticated state started at zero matched, but a fill may
    // have landed before this failed lookup. Require reconciliation instead
    // of treating missing status data as evidence that no settlement exists.
    settlementProofRequired: true,
    potentialFillUnresolved: true,
    cancelEligible: false,
    cancellationObserved: false,
  });
}

export function buildTakeProfitCancelRequest({
  journal,
  snapshot,
  typedConfirmation,
  confirmedAt,
} = {}, options = {}) {
  invariant(
    typedConfirmation === TAKE_PROFIT_CANCEL_CONFIRMATION,
    "cancel_confirmation_required",
    `Type exactly: ${TAKE_PROFIT_CANCEL_CONFIRMATION}`,
  );
  const binding = validateTakeProfitJournal(journal, options);
  const exact = validateFreshExactOrderSnapshot(binding, snapshot, options);
  const status = classifyExactOrder(exact);
  const confirmation = canonicalIso(confirmedAt, "invalid_cancel_confirmation", "Take-profit cancel confirmation time");
  const nowMs = nowMilliseconds(options.now);
  invariant(confirmation.milliseconds >= exact.fetchedAtMs, "stale_cancel_confirmation", "Cancel confirmation predates the displayed order status");
  invariant(confirmation.milliseconds <= nowMs + MAX_FUTURE_SKEW_MS, "future_cancel_confirmation", "Cancel confirmation is in the future");
  invariant(nowMs - confirmation.milliseconds <= CANCEL_CONFIRMATION_MAX_AGE_MS, "stale_cancel_confirmation", "Cancel confirmation is stale");
  invariant(
    (status === "ARMED" || status === "PARTIAL_PENDING_CHAIN_PROOF") && ACTIVE.has(exact.status) &&
      exact.remainingRaw > 0n && exact.fetchedAtMs < exact.expirationMs,
    "take_profit_not_cancelable",
    "Pinned take-profit order is not freshly cancelable",
    { status },
  );
  invariant(
    confirmation.milliseconds < exact.expirationMs,
    "take_profit_not_cancelable",
    "Take-profit venue expiry elapsed before cancel authorization",
  );
  const launchExpiresAt = new Date(Math.min(
    confirmation.milliseconds + CANCEL_CONFIRMATION_MAX_AGE_MS,
    exact.expirationMs,
  )).toISOString();

  const argv = Object.freeze(["cancel", "--order-id", binding.orderId]);
  invariant(!argv.includes("--market") && !argv.includes("--all"), "unsafe_cancel_scope", "Cancel request is not limited to one order");
  return Object.freeze({
    ok: true,
    version: "conviction-take-profit-cancel-request-v2",
    action: "CANCEL_TAKE_PROFIT",
    authorizationScope: "single-pinned-order",
    tool: "polymarket-plugin",
    argv,
    orderId: binding.orderId,
    intentHash: binding.intentHash,
    takeProfitPassportHash: binding.passportHash,
    preCancelSnapshotHash: exact.snapshotHash,
    preCancelSnapshot: structuredClone(snapshot),
    confirmedAt: confirmation.text,
    launchExpiresAt,
    confirmation: TAKE_PROFIT_CANCEL_CONFIRMATION,
    preCancelStatus: status,
    matchedSharesRaw: exact.matchedRaw.toString(),
    remainingSharesRaw: exact.remainingRaw.toString(),
    fillCancelRacePossible: true,
    requiresPostCancelExactOrderRecheck: true,
  });
}

function cancelAcknowledgement(cancelResultInput, orderId) {
  const outer = record(cancelResultInput, "invalid_cancel_response", "Cancel result must be an object");
  const result = outer.data === undefined
    ? outer
    : record(outer.data, "invalid_cancel_response", "Cancel result data must be an object");
  invariant(outer.ok === undefined || outer.ok === true, "invalid_cancel_response", "Plugin did not report a successful cancel request");
  const canceled = result.canceled === undefined ? [] : result.canceled;
  const notCanceled = result.not_canceled === undefined ? {} : result.not_canceled;
  invariant(Array.isArray(canceled), "invalid_cancel_response", "Cancel response canceled field is invalid");
  record(notCanceled, "invalid_cancel_response", "Cancel response not_canceled field is invalid");
  const canceledIds = canceled.map((value) => String(value || ""));
  const notCanceledIds = Object.keys(notCanceled);
  invariant(
    canceledIds.every((value) => value === orderId) && notCanceledIds.every((value) => value === orderId),
    "unsafe_cancel_response",
    "Cancel response contains an order outside the pinned order ID",
  );
  invariant(new Set(canceledIds).size === canceledIds.length, "invalid_cancel_response", "Cancel response repeats the pinned order ID");
  invariant(!(canceledIds.includes(orderId) && Object.hasOwn(notCanceled, orderId)), "invalid_cancel_response", "Cancel response both canceled and rejected the pinned order");
  if (Object.hasOwn(notCanceled, orderId)) {
    invariant(typeof notCanceled[orderId] === "string", "invalid_cancel_response", "Cancel rejection reason must be text");
  }
  const reason = Object.hasOwn(notCanceled, orderId)
    ? safeExternalText(notCanceled[orderId], "Cancel rejection reason")
    : canceledIds.includes(orderId)
      ? null
      : "exact_order_result_missing";
  return Object.freeze({ acknowledged: canceledIds.includes(orderId), reason });
}

export function buildTakeProfitCancelOutcome({
  journal,
  beforeSnapshot,
  cancelResult,
  afterSnapshot,
  afterLookupErrorCode,
  observedAt,
} = {}, options = {}) {
  const binding = validateTakeProfitJournal(journal, options);
  const before = validateFreshExactOrderSnapshot(binding, beforeSnapshot, options);
  const acknowledgement = cancelAcknowledgement(cancelResult, binding.orderId);

  if (afterSnapshot === undefined || afterSnapshot === null) {
    const unknown = buildTakeProfitLookupFailureStatus(journal, {
      errorCode: afterLookupErrorCode,
      observedAt,
    }, options);
    return Object.freeze({
      ...unknown,
      version: "conviction-take-profit-cancel-outcome-v1",
      cancelAcknowledgedByPlugin: acknowledgement.acknowledged,
      cancelNotAcknowledgedReason: acknowledgement.reason,
      cancelConfirmedFromFreshOrder: false,
      fillCancelRaceOccurred: false,
      settlementProofRequired: true,
      potentialFillUnresolved: true,
      matchedSharesBeforeRaw: before.matchedRaw.toString(),
      matchedSharesAfterRaw: null,
    });
  }

  const after = validateFreshExactOrderSnapshot(binding, afterSnapshot, options);
  invariant(after.fetchedAtMs >= before.fetchedAtMs, "order_snapshot_regression", "Post-cancel snapshot predates the pre-cancel snapshot");
  invariant(after.matchedRaw >= before.matchedRaw, "order_fill_regression", "Post-cancel matched quantity decreased");
  const status = classifyExactOrder(after);
  const output = statusOutput(binding, after, status);
  const cancellationObserved = status === "CANCELED" || status === "PARTIAL_CANCELED_PENDING_CHAIN_PROOF";
  return Object.freeze({
    ...output,
    version: "conviction-take-profit-cancel-outcome-v1",
    cancelAcknowledgedByPlugin: acknowledgement.acknowledged,
    cancelNotAcknowledgedReason: acknowledgement.reason,
    cancelConfirmedFromFreshOrder: cancellationObserved,
    fillCancelRaceOccurred: after.matchedRaw > before.matchedRaw,
    matchedSharesBeforeRaw: before.matchedRaw.toString(),
    matchedSharesAfterRaw: after.matchedRaw.toString(),
  });
}
