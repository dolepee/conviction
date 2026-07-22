#!/usr/bin/env node

import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, realpath, rename, stat, lstat, unlink, writeFile, chmod } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { createInterface } from "node:readline/promises";
import { stdin, stdout, stderr } from "node:process";
import { promisify } from "node:util";

import { runTakeProfitJourney } from "../src/buyer-orchestrator.mjs";
import { sha256 } from "../src/canonical.mjs";
import { formatDecimal, parseDecimal } from "../src/decimal.mjs";
import { trustedIssuerRegistry } from "../src/intent-issuer.mjs";
import { fetchPositionSnapshot } from "../src/position-client.mjs";
import { fetchAllOpenOrders, fetchExactOrder } from "../src/polymarket-open-orders.mjs";
import {
  polymarketRuntimeEvidenceFromInspection,
  resolvePolymarketRuntime,
} from "../src/polymarket-runtime.mjs";
import { fetchExactAssociatedTradeContributions } from "../src/polymarket-trades.mjs";
import { verifySourcePosition } from "../src/source-position.mjs";
import {
  POSITION_MANAGER_SERVICE,
  pinnedServiceUrl,
  requirePinnedServiceOrigin,
  SERVICE_ASSET,
  SERVICE_PAYEE,
} from "../src/service-payment.mjs";
import { fetchAndVerifyX402Payment } from "../src/x402-payment-verifier.mjs";
import { fetchAndVerifyTakeProfitAggregateFill } from "../src/take-profit-fill-verifier.mjs";
import {
  assertNoStateReleaseInProgress,
  claimExecutionLock,
  fetchEip3009AuthorizationState,
  markExecutionAttempted,
  normalizeOpenOrders,
  normalizePluginReadiness,
  normalizeSourcePosition,
  parseJsonOutput,
  paymentAuthorizationMetadata,
  persistSuccessfulPaidServiceResponse,
  persistVerifiedPaidServicePayment,
  reconcileUnattachedExecutionLock,
  releaseReconciledLocks,
  resumePendingStateRelease,
  requireDistinctPaymentPayer,
  resolveFailedLockAttachment,
  settleExecutionLock,
  summarizeOpenSellReservations,
  validatePaymentChallenge,
  verifyStoredPaymentTransactionClaim,
  verifyJournalLockOwnership,
  withStateReleaseMutex,
  writeReconciliationJournal,
} from "./buyer-orchestrator.mjs";
import {
  buildTakeProfitOrderProof,
  validateTakeProfitCard,
  validateTakeProfitLiveResult,
  validateTakeProfitPluginPreview,
} from "../skills/conviction-executor/scripts/conviction-take-profit-card.mjs";
import {
  buildTakeProfitCancelOutcome,
  buildTakeProfitCancelRequest,
  buildTakeProfitLookupFailureStatus,
  buildTakeProfitStatus,
  TAKE_PROFIT_CANCEL_CONFIRMATION,
  validateTakeProfitJournal,
} from "../src/take-profit-lifecycle.mjs";

const execFileAsync = promisify(execFile);
const polymarketPluginCommand = () => resolvePolymarketRuntime().binary;
const PAYMENT_SIGNATURE_HEADER = "PAYMENT-SIGNATURE";
const ADDRESS_RE = /^0x[0-9a-f]{40}$/;
const HASH_RE = /^0x[0-9a-f]{64}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const UINT_RE = /^(?:0|[1-9][0-9]*)$/;
const STATE_DIRECTORY = join(homedir(), ".local", "state", "conviction", "reconciliation");

function fail(condition, code, message, details = undefined) {
  if (!condition) throw Object.assign(new Error(message), { code, details });
}

function usage() {
  return [
    "Usage:",
    "  node scripts/take-profit-orchestrator.mjs take-profit --origin https://conviction-bay.vercel.app --market <slug-or-id>",
    "    --side YES|NO --shares <whole-shares> --target-price <price>",
    "    --expires-at <UTC-ISO-second> --payment-payer <X-Layer-address>",
    "    --seller-wallet <Polygon-deposit-wallet> --source-proof <open-proof.json>",
    "    --issuer-registry <issuers.json> [--rationale <text>] [--json]",
    "",
    "  node scripts/take-profit-orchestrator.mjs tp-status --journal <journey.json>",
    "    --issuer-registry <issuers.json> [--json]",
    "",
    "  node scripts/take-profit-orchestrator.mjs cancel-tp --journal <journey.json>",
    "    --issuer-registry <issuers.json> [--json]",
    "",
    "  node scripts/take-profit-orchestrator.mjs reconcile-tp --journal <journey.json>",
    "    --issuer-registry <issuers.json> [--json]",
    "",
    "The flow separately requires `confirm payment`, then `confirm live mode`.",
    "It places one post-only GTD order and returns an authenticated initial order binding.",
    "Zero-match LIVE returns ARMED; a first-fetch match or state transition returns a recoverable binding pending reconciliation/proof.",
    "`tp-status` automatically proves any matched shares from CLOB trades and Polygon receipts.",
    "`reconcile-tp` can recover only an exact order ID already persisted with a valid live result; it never pays or places again.",
    "It releases a recovered submit lock only after durably authenticating a zero-match ARMED order while retaining its scoped reservation.",
    "It otherwise cleans pre-order reservations only after authorization/card expiry and exact unused/unstarted proof.",
  ].join("\n");
}

export function parseTakeProfitArgs(argv) {
  const rest = [...argv];
  const command = rest.shift();
  const take = (name, required = true) => {
    const index = rest.indexOf(name);
    if (index < 0) {
      if (required) fail(false, "missing_argument", `${name} is required`);
      return undefined;
    }
    fail(rest[index + 1] && !rest[index + 1].startsWith("--"), "missing_argument", `${name} requires a value`);
    const value = rest[index + 1];
    rest.splice(index, 2);
    return value;
  };
  const boolean = (name) => {
    const index = rest.indexOf(name);
    if (index < 0) return false;
    rest.splice(index, 1);
    return true;
  };
  if (command === "tp-status" || command === "cancel-tp" || command === "reconcile-tp") {
    const parsed = {
      command,
      journal: take("--journal"),
      issuerRegistry: take("--issuer-registry"),
      json: boolean("--json"),
    };
    fail(rest.length === 0, "invalid_argument", `Unknown arguments: ${rest.join(" ")}`);
    return Object.freeze(parsed);
  }
  fail(command === "take-profit", "invalid_command", usage());
  const parsed = {
    command,
    origin: requirePinnedServiceOrigin(take("--origin"), POSITION_MANAGER_SERVICE),
    market: take("--market"),
    side: take("--side").toUpperCase(),
    shares: take("--shares"),
    targetPrice: take("--target-price"),
    venueExpiresAt: take("--expires-at"),
    paymentPayer: take("--payment-payer").toLowerCase(),
    sellerWallet: take("--seller-wallet").toLowerCase(),
    sourceProof: take("--source-proof"),
    issuerRegistry: take("--issuer-registry"),
    rationale: take("--rationale", false) || "",
    json: boolean("--json"),
  };
  fail(rest.length === 0, "invalid_argument", `Unknown arguments: ${rest.join(" ")}`);
  fail(ADDRESS_RE.test(parsed.paymentPayer), "invalid_wallet", "Payment payer is invalid");
  fail(ADDRESS_RE.test(parsed.sellerWallet), "invalid_wallet", "Seller wallet is invalid");
  fail(parsed.side === "YES" || parsed.side === "NO", "invalid_outcome", "Side must be YES or NO");
  fail(parseDecimal(parsed.shares, 6, "shares") > 0n, "invalid_shares", "Shares must be positive");
  const expiry = Date.parse(parsed.venueExpiresAt);
  fail(Number.isFinite(expiry) && expiry % 1_000 === 0, "invalid_venue_expiry", "--expires-at must be a UTC timestamp on a whole second");
  parsed.venueExpiresAt = new Date(expiry).toISOString();
  return Object.freeze(parsed);
}

export function takeProfitReplayKey({ request, sellerWallet }) {
  const sourceIntent = request?.sourcePosition?.intent;
  const conditionId = String(sourceIntent?.market?.conditionId || "").toLowerCase();
  const tokenId = String(sourceIntent?.market?.outcomeTokenId || sourceIntent?.order?.outcomeTokenId || "");
  fail(HASH_RE.test(conditionId) && /^\d+$/.test(tokenId), "invalid_replay_identity", "TAKE_PROFIT source has no canonical market token");
  return sha256({
    version: "conviction-take-profit-replay-v1",
    sellerWallet: String(sellerWallet || "").toLowerCase(),
    conditionId,
    tokenId,
    outcome: String(request?.outcome || "").toUpperCase(),
    sharesRaw: parseDecimal(request?.shares, 6, "TAKE_PROFIT replay shares").toString(),
    targetPriceRaw: parseDecimal(request?.targetPrice, 6, "TAKE_PROFIT replay price").toString(),
    venueExpiresAt: new Date(Date.parse(request?.venueExpiresAt)).toISOString(),
    sourceIntentHash: String(request?.sourcePosition?.intentHash || "").toLowerCase(),
    sourcePositionProofHash: String(request?.sourcePosition?.positionProofHash || "").toLowerCase(),
    sourceTransactionHash: String(request?.sourcePosition?.transactionHash || "").toLowerCase(),
    sourceOrderId: String(request?.sourcePosition?.orderId || "").toLowerCase(),
  });
}

export async function claimTakeProfitReservation({
  key,
  journal,
  directory = STATE_DIRECTORY,
  state,
  writeState = writeTakeProfitState,
  transition,
  beforePersist,
} = {}) {
  fail(HASH_RE.test(String(key || "")), "invalid_replay_key", "TAKE_PROFIT replay key is invalid");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const file = join(directory, `take-profit-${String(key).slice(2)}.lock.json`);
  const releaseFile = join(directory, "polymarket-execution.release.lock.json");
  return withStateReleaseMutex(directory, async (mutexLease) => {
    await assertNoStateReleaseInProgress({ directory, releaseFile, mutexHeld: true, mutexLease });
    fail(!state || resolve(String(state.journalPath || "")) === resolve(journal), "reservation_ownership_mismatch", "TAKE_PROFIT reservation state belongs to another journal");
    if (state) {
      const durable = JSON.parse(await readFile(journal, "utf8"));
      fail(sha256(durable) === sha256(state), "stale_journal_write", "TAKE_PROFIT reservation state is stale before lock claim");
    }
    const lock = {
      version: "conviction-take-profit-reservation-v1",
      generation: randomUUID(),
      replayKey: key,
      journalPath: journal,
      orderId: null,
      status: "PAYMENT_PENDING",
      claimedAt: new Date().toISOString(),
    };
    const lockText = `${JSON.stringify(lock, null, 2)}\n`;
    let handle;
    try {
      mutexLease.assertAlive();
      handle = await open(file, "wx", 0o600);
      await handle.writeFile(lockText);
    } catch (error) {
      if (error?.code === "EEXIST") {
        throw Object.assign(new Error("This exact TAKE_PROFIT is already reserved; inspect its journal instead of paying or placing again"), {
          code: "take_profit_replay_blocked",
          details: { reservationLockPath: file },
        });
      }
      throw error;
    } finally {
      await handle?.close();
    }
    if (state) {
      const before = structuredClone(state);
      try {
        await beforePersist?.(Object.freeze({ file, lock: Object.freeze({ ...lock }) }));
        state.reservationLockPath = file;
        await transition?.(state, { lockPath: file, lock: Object.freeze({ ...lock }) });
        await writeState(state, {
          directory,
          file: journal,
          mutexHeld: true,
          mutexLease,
        });
      } catch (error) {
        await resolveFailedLockAttachment({
          state,
          before,
          field: "reservationLockPath",
          file,
          lockText,
          journal,
          mutexLease,
          error,
        });
        throw error;
      }
    }
    return file;
  });
}

export async function writeTakeProfitState(value, {
  directory = STATE_DIRECTORY,
  file,
  mutexHeld = false,
  mutexLease,
  expectedRevision,
  targetRevision,
  releaseCapability,
} = {}) {
  fail(typeof file === "string" && file.startsWith(`${directory}/`) && basename(file).endsWith(".json"), "invalid_state_path", "TAKE_PROFIT journal path is invalid");
  return writeReconciliationJournal(value, {
    directory,
    file,
    mutexHeld,
    mutexLease,
    expectedRevision,
    targetRevision,
    releaseCapability,
  });
}

async function updateReservation(file, update, { directory = dirname(file), journal, replayKey } = {}) {
  const releaseFile = join(directory, "polymarket-execution.release.lock.json");
  return withStateReleaseMutex(directory, async (mutexLease) => {
    const current = JSON.parse(await readFile(file, "utf8"));
    fail(
      current?.version === "conviction-take-profit-reservation-v1" &&
        current?.journalPath === journal && current?.replayKey === replayKey,
      "reservation_ownership_mismatch",
      "TAKE_PROFIT reservation changed before its order binding was persisted",
    );
    const bindingFields = ["orderId", "intentHash", "takeProfitPassportHash", "restingOrderProofHash", "status"];
    const alreadyExact = bindingFields.every((field) => current?.[field] === update?.[field]);
    if (alreadyExact) return current;
    await assertNoStateReleaseInProgress({ directory, releaseFile, mutexHeld: true, mutexLease });
    fail(
      current?.orderId == null && current?.status === "PAYMENT_PENDING" &&
        current?.intentHash == null && current?.takeProfitPassportHash == null &&
        current?.restingOrderProofHash == null,
      "reservation_ownership_mismatch",
      "TAKE_PROFIT reservation already contains another order binding",
    );
    const next = { ...current, ...update };
    const temporary = `${file}.tmp`;
    mutexLease.assertAlive();
    await writeFile(temporary, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
    mutexLease.assertAlive();
    await rename(temporary, file);
    mutexLease.assertAlive();
    return next;
  });
}

async function progressTakeProfitReservation(journal, {
  stateDirectory = dirname(journal.journalPath),
  now = Date.now,
} = {}) {
  const armed = journal.status === "ARMED";
  return updateReservation(journal.reservationLockPath, {
    orderId: journal.orderId,
    intentHash: journal.intentHash,
    takeProfitPassportHash: journal.takeProfitPassportHash,
    restingOrderProofHash: journal.restingOrderProofHash,
    status: journal.status,
    ...(armed
      ? { armedAt: new Date(typeof now === "function" ? now() : now).toISOString() }
      : { recoveryBoundAt: new Date(typeof now === "function" ? now() : now).toISOString() }),
  }, {
    directory: stateDirectory,
    journal: journal.journalPath,
    replayKey: journal.replayKey,
  });
}

async function commandJson(file, args, label, {
  deadlineEpochMs,
  clock = Date.now,
  onStart = () => {},
} = {}) {
  const commandStartedAt = Number(clock());
  const boundedTimeout = deadlineEpochMs === undefined
    ? 60_000
    : Math.min(60_000, Math.floor(Number(deadlineEpochMs) - commandStartedAt));
  fail(
    Number.isFinite(commandStartedAt) && Number.isFinite(boundedTimeout) && boundedTimeout > 0,
    "placement_deadline_elapsed",
    `${label} cannot start after the signed placement deadline`,
  );
  try {
    onStart();
    const { stdout: output } = await execFileAsync(file, args, {
      timeout: boundedTimeout,
      maxBuffer: 2 * 1024 * 1024,
      encoding: "utf8",
    });
    return parseJsonOutput(output, label);
  } catch (error) {
    if (error?.code && error.code !== "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") throw error;
    throw Object.assign(new Error(`${label} failed`), { code: "tool_failed" });
  }
}

export function requireTakeProfitLaunchWindow(card, {
  now = Date.now,
  minimumHeadroomMs = 15_000,
} = {}) {
  const observedAt = Number(now());
  const placementDeadlineMs = Date.parse(String(card?.expiresAt || ""));
  const venueDeadlineMs = Date.parse(String(card?.bounds?.venueExpiresAt || ""));
  fail(
    Number.isFinite(observedAt) && Number.isFinite(placementDeadlineMs) &&
      placementDeadlineMs - observedAt >= minimumHeadroomMs,
    "insufficient_execution_window",
    "Signed TAKE_PROFIT card has too little time left for locked submission",
  );
  fail(
    Number.isFinite(venueDeadlineMs) && venueDeadlineMs > observedAt,
    "expired_venue_order",
    "TAKE_PROFIT venue expiry has passed before locked submission",
  );
  return Object.freeze({ observedAt, placementDeadlineMs, venueDeadlineMs });
}

export function markTakeProfitPreSpawnFailure(state, error, {
  liveSpawnStarted,
  now = Date.now(),
} = {}) {
  if (liveSpawnStarted) return false;
  const observedAt = Number(typeof now === "function" ? now() : now);
  fail(Number.isFinite(observedAt), "invalid_reconciliation_clock", "TAKE_PROFIT failure clock is invalid");
  state.executionAttempted = false;
  state.executionArgv = null;
  state.executionArgvHash = null;
  state.executionAttemptedAt = null;
  state.reconciliationRequired = true;
  state.stage = "execution_blocked_before_launch";
  state.preSpawnError = {
    code: error?.code || "take_profit_pre_spawn_failed",
    at: new Date(observedAt).toISOString(),
  };
  return true;
}

async function postJson(url, body, { headers = {} } = {}) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
    redirect: "error",
    signal: AbortSignal.timeout(20_000),
  });
  let json;
  try { json = await response.json(); } catch { json = null; }
  return { response, json };
}

function decodeHeader(value, label) {
  fail(typeof value === "string" && value.length > 0, "invalid_payment_header", `${label} is missing`);
  try {
    return JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
  } catch {
    throw Object.assign(new Error(`${label} is invalid`), { code: "invalid_payment_header" });
  }
}

async function sleepUntil(targetEpochMs) {
  const target = Number(targetEpochMs);
  fail(Number.isFinite(target) && target - Date.now() <= 2_000, "invalid_wait", "Strict post-confirmation wait is invalid");
  while (Date.now() < target) {
    await new Promise((resolvePromise) => setTimeout(resolvePromise, target - Date.now()));
  }
}

function snapshotPredatesOrderCreation(snapshot) {
  const createdAt = String(snapshot?.order?.createdAt ?? "");
  const fetchedAt = Date.parse(String(snapshot?.fetchedAt ?? ""));
  if (!UINT_RE.test(createdAt) || !Number.isFinite(fetchedAt)) return false;
  return BigInt(Math.floor(fetchedAt / 1_000)) < BigInt(createdAt);
}

export async function fetchExactOrderWithPropagation(argumentsObject, {
  fetchExactOrderImpl = fetchExactOrder,
  sleep = (milliseconds) => new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds)),
} = {}) {
  let lastError;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      const snapshot = await fetchExactOrderImpl(argumentsObject);
      // The authenticated CLOB timestamp has one-second precision and can be
      // one tick ahead of the caller's local clock. Re-fetch the exact order;
      // never re-submit it. The proof builder still rejects a snapshot that
      // remains chronologically impossible after this bounded propagation.
      if (snapshotPredatesOrderCreation(snapshot) && attempt < 4) {
        await sleep(200 * (attempt + 1));
        continue;
      }
      return snapshot;
    } catch (error) {
      lastError = error;
      if (error?.code !== "order_not_found" || attempt === 4) throw error;
      await sleep(200 * (attempt + 1));
    }
  }
  throw lastError;
}

function record(value, code, message) {
  fail(value !== null && typeof value === "object" && !Array.isArray(value), code, message);
  return value;
}

function canonicalIso(value, code, message) {
  const text = String(value || "");
  const milliseconds = Date.parse(text);
  fail(Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === text, code, message);
  return { text, milliseconds };
}

function requireCanonicalAddress(value, code, message) {
  const address = String(value || "");
  fail(ADDRESS_RE.test(address), code, message);
  return address;
}

function requireCanonicalHash(value, code, message) {
  const hash = String(value || "");
  fail(HASH_RE.test(hash), code, message);
  return hash;
}

async function requireOwnerOnlyRecoveryState(journalPath, stateDirectory, {
  statImpl = stat,
} = {}) {
  const rootPath = await realpath(resolve(stateDirectory));
  const [rootStat, journalLinkStat] = await Promise.all([statImpl(rootPath), lstat(journalPath)]);
  fail(!journalLinkStat.isSymbolicLink(), "unsafe_state_symlink", "TAKE_PROFIT journal must not be a symbolic link");
  const journalStat = statImpl === stat ? journalLinkStat : await statImpl(journalPath);
  const expectedUid = typeof process.getuid === "function" ? process.getuid() : null;
  fail(rootStat.isDirectory() && (rootStat.mode & 0o077) === 0, "unsafe_state_permissions", "Conviction state directory must be owner-only before pre-passport recovery");
  fail(journalStat.isFile() && (journalStat.mode & 0o077) === 0, "unsafe_state_permissions", "TAKE_PROFIT journal must be owner-only before pre-passport recovery");
  if (expectedUid !== null) {
    fail(rootStat.uid === expectedUid && journalStat.uid === expectedUid, "unsafe_state_owner", "TAKE_PROFIT recovery state must belong to the current OS user");
  }
  return true;
}

function validateTakeProfitAuthorizationCheckpoint(journalInput) {
  const journal = record(
    journalInput,
    "invalid_payment_reconciliation",
    "TAKE_PROFIT payment checkpoint must be an object",
  );
  const stages = new Set([
    "payment_authorization_starting",
    "payment_authorization_created",
    "payment_header_rejected_after_authorization",
    "paid_request_ambiguous",
  ]);
  fail(
    journal.version === "conviction-take-profit-journey-v1" && journal.action === "TAKE_PROFIT" &&
      stages.has(journal.stage),
    "invalid_payment_reconciliation",
    "Journal is not a recoverable TAKE_PROFIT payment-authorization checkpoint",
  );
  const response = journal.paidServiceResponse;
  fail(
    (journal.stage === "paid_request_ambiguous"
      ? Number.isInteger(response?.status) && typeof response.paymentResponsePresent === "boolean"
      : response == null),
    "invalid_payment_reconciliation",
    "Paid-service response metadata disagrees with the authorization checkpoint",
  );
  fail(
    journal.paidCard == null && journal.paymentTx == null && journal.paymentProof == null &&
      journal.tradeConsent == null && journal.liveResult == null && journal.orderId == null &&
      journal.takeProfitPassport == null && journal.takeProfitPassportHash == null &&
      journal.restingOrderProofHash == null && journal.executionLockPath == null &&
      journal.executionAttempted === false,
    "invalid_payment_reconciliation",
    "Payment-only reconciliation cannot touch a card, consent, or possible order",
  );
  const paymentPayer = requireCanonicalAddress(
    journal.paymentPayer,
    "invalid_payment_reconciliation",
    "TAKE_PROFIT payment payer is invalid",
  );
  const signerAddress = requireCanonicalAddress(
    journal.signerAddress,
    "invalid_payment_reconciliation",
    "TAKE_PROFIT signer address is invalid",
  );
  const depositWallet = requireCanonicalAddress(
    journal.depositWallet,
    "invalid_payment_reconciliation",
    "TAKE_PROFIT deposit wallet is invalid",
  );
  fail(paymentPayer === signerAddress && paymentPayer !== SERVICE_PAYEE, "payment_identity_mismatch", "TAKE_PROFIT payment checkpoint has another payer");
  const request = record(journal.request, "invalid_payment_reconciliation", "TAKE_PROFIT payment request is missing");
  fail(
    String(request.action || "").toLowerCase() === "take_profit" && request.wallet === depositWallet,
    "payment_request_mismatch",
    "TAKE_PROFIT payment request has another action or wallet",
  );
  const replayKey = requireCanonicalHash(
    journal.replayKey,
    "invalid_payment_reconciliation",
    "TAKE_PROFIT payment replay key is invalid",
  );
  fail(
    replayKey === takeProfitReplayKey({ request: {
      outcome: request.outcome,
      shares: request.shares,
      targetPrice: request.targetPrice,
      venueExpiresAt: request.venueExpiresAt,
      sourcePosition: request.sourcePosition,
    }, sellerWallet: depositWallet }),
    "payment_replay_mismatch",
    "TAKE_PROFIT payment replay identity changed",
  );
  fail(typeof journal.reservationLockPath === "string", "missing_reservation_lock", "TAKE_PROFIT payment reservation is missing");

  if (journal.stage === "payment_authorization_starting") {
    fail(journal.paymentAuthorization == null, "invalid_payment_reconciliation", "Unsigned payment checkpoint unexpectedly contains authorization metadata");
    return Object.freeze({
      journal,
      authorization: null,
      paymentPayer,
      signerAddress,
      depositWallet,
      replayKey,
    });
  }

  const authorization = record(
    journal.paymentAuthorization,
    "invalid_payment_authorization",
    "Stored TAKE_PROFIT payment authorization is missing",
  );
  const validAfter = String(authorization.validAfter || "");
  const validBefore = String(authorization.validBefore || "");
  const validWindow = UINT_RE.test(validAfter) && UINT_RE.test(validBefore)
    ? BigInt(validBefore) - BigInt(validAfter)
    : -1n;
  fail(
    authorization.version === "conviction-x402-authorization-v1" &&
      authorization.scheme === "exact-eip3009" && authorization.network === "eip155:196" &&
      authorization.asset === SERVICE_ASSET && authorization.from === paymentPayer &&
      authorization.to === SERVICE_PAYEE && authorization.value === POSITION_MANAGER_SERVICE.priceAtomic &&
      validWindow > 0n && (validAfter === "0" || validWindow <= 305n) &&
      HASH_RE.test(String(authorization.nonce || "")),
    "invalid_payment_authorization",
    "Stored TAKE_PROFIT authorization differs from the exact Position Manager payment",
  );
  return Object.freeze({ journal, authorization, paymentPayer, signerAddress, depositWallet, replayKey });
}

async function validateTakeProfitReservationOwnership(context, recovery, {
  stateDirectory,
  statImpl = stat,
  allowProgressed = false,
} = {}) {
  const expected = join(stateDirectory, `take-profit-${recovery.replayKey.slice(2)}.lock.json`);
  const requested = resolve(String(recovery.journal.reservationLockPath || ""));
  let requestedInfo;
  try { requestedInfo = await lstat(requested); } catch {
    fail(false, "reservation_ownership_mismatch", "TAKE_PROFIT reservation cannot be resolved");
  }
  fail(!requestedInfo.isSymbolicLink(), "unsafe_state_symlink", "TAKE_PROFIT reservation must not be a symbolic link");
  let actual;
  try {
    actual = await realpath(requested);
  } catch {
    fail(false, "reservation_ownership_mismatch", "TAKE_PROFIT reservation cannot be resolved");
  }
  fail(actual === expected, "reservation_ownership_mismatch", "TAKE_PROFIT reservation path differs from its replay identity");
  const lockStat = await statImpl(actual);
  const expectedUid = typeof process.getuid === "function" ? process.getuid() : null;
  fail(lockStat.isFile() && (lockStat.mode & 0o077) === 0, "unsafe_state_permissions", "TAKE_PROFIT reservation must be owner-only");
  if (expectedUid !== null) {
    fail(lockStat.uid === expectedUid, "unsafe_state_owner", "TAKE_PROFIT reservation must belong to the current OS user");
  }
  const lock = JSON.parse(await readFile(actual, "utf8"));
  let lockJournal;
  const lockJournalPath = resolve(String(lock?.journalPath || ""));
  let lockJournalInfo;
  try { lockJournalInfo = await lstat(lockJournalPath); } catch {}
  fail(!lockJournalInfo?.isSymbolicLink(), "unsafe_state_symlink", "TAKE_PROFIT reservation journal must not be a symbolic link");
  try { lockJournal = await realpath(lockJournalPath); } catch { lockJournal = null; }
  const baseOwned = lock?.version === "conviction-take-profit-reservation-v1" &&
    lock?.replayKey === recovery.replayKey && lockJournal === context.journalPath;
  const paymentPending = lock?.orderId == null && lock?.status === "PAYMENT_PENDING" &&
    lock?.intentHash == null && lock?.takeProfitPassportHash == null && lock?.restingOrderProofHash == null;
  const progressed = allowProgressed &&
    lock?.orderId === recovery.journal?.orderId &&
    lock?.intentHash === recovery.journal?.intentHash &&
    lock?.takeProfitPassportHash === recovery.journal?.takeProfitPassportHash &&
    lock?.restingOrderProofHash === recovery.journal?.restingOrderProofHash &&
    lock?.status === recovery.journal?.status &&
    HASH_RE.test(String(lock?.orderId || "")) && HASH_RE.test(String(lock?.intentHash || "")) &&
    HASH_RE.test(String(lock?.takeProfitPassportHash || "")) &&
    HASH_RE.test(String(lock?.restingOrderProofHash || ""));
  fail(
    baseOwned && (paymentPending || progressed),
    "reservation_ownership_mismatch",
    "TAKE_PROFIT reservation belongs to another request or has an inexact progressed order binding",
  );
  return actual;
}

function validatePaidUnstartedTakeProfitCheckpoint(journal, options) {
  const unstartedStages = new Set([
    "trade_confirmed",
    "execution_lock_acquired",
    "execution_blocked_before_launch",
  ]);
  const attachedExecutionLock = journal?.executionLockPath != null;
  const attachedStage = journal?.stage === "execution_lock_acquired" ||
    journal?.stage === "execution_blocked_before_launch";
  const noV2Binding = journal?.executionLockGeneration == null && journal?.executionLockHash == null &&
    journal?.executionLockPurpose == null && journal?.executionLockRecoveryNotBefore == null;
  const stageCoherent = journal?.stage === "trade_confirmed"
    ? !attachedExecutionLock
    : journal?.stage === "execution_lock_acquired"
      ? attachedExecutionLock
      : true;
  fail(
    unstartedStages.has(journal?.stage) && journal.executionAttempted === false &&
      journal.executionAttemptedAt == null && journal.reconciliationRequired === true &&
      (!attachedExecutionLock || attachedStage) && stageCoherent &&
      (attachedExecutionLock || noV2Binding) &&
      journal.executionArgv == null && journal.executionArgvHash == null &&
      journal.liveResult == null && journal.orderId == null && journal.takeProfitPassport == null &&
      journal.takeProfitPassportHash == null && journal.restingOrderProofHash == null,
    "invalid_unstarted_checkpoint",
    "Journal is not a proven-unstarted paid TAKE_PROFIT checkpoint",
  );
  return Object.freeze({
    ...validatePaidTakeProfitCheckpoint(journal, options),
    attachedExecutionLock,
  });
}

function validateVerifiedUnconfirmedTakeProfitCheckpoint(journal, options) {
  fail(
    journal?.stage === "payment_verified" && journal.reconciliationRequired === true &&
      journal.tradeConsent == null && journal.executionLockPath == null &&
      journal.executionLockGeneration == null && journal.executionLockHash == null &&
      journal.executionLockPurpose == null && journal.executionLockRecoveryNotBefore == null &&
      journal.executionAttempted === false && journal.executionArgv == null &&
      journal.executionAttemptedAt == null && journal.executionArgvHash == null && journal.liveResult == null &&
      journal.orderId == null && journal.takeProfitPassport == null &&
      journal.takeProfitPassportHash == null && journal.restingOrderProofHash == null,
    "invalid_unconfirmed_payment_checkpoint",
    "Journal is not an exact verified-but-unconfirmed TAKE_PROFIT payment",
  );
  return validateVerifiedTakeProfitPaymentCheckpoint(journal, options);
}

async function reconcileTakeProfitNonOrderState(context, {
  now = Date.now,
  stateDirectory,
  authorizationStateImpl = fetchEip3009AuthorizationState,
  reconcileUnattachedExecutionLockImpl = reconcileUnattachedExecutionLock,
  writeState = writeTakeProfitState,
  releaseLocks = releaseReconciledLocks,
  unlinkImpl = unlink,
  statImpl = stat,
} = {}) {
  const timestamp = Number(now());
  fail(Number.isFinite(timestamp), "invalid_reconciliation_clock", "TAKE_PROFIT reconciliation clock is invalid");
  const isRejectedLiveResult = context.journal.stage === "live_result_received" &&
    context.journal.liveResult?.ok === false;
  const isReconciledRejectedLiveResult = context.journal.stage === "rejected_live_result_reconciled";
  if (isRejectedLiveResult || isReconciledRejectedLiveResult) {
    await requireOwnerOnlyRecoveryState(context.journalPath, stateDirectory, { statImpl });
    const rejected = validateDefinitiveRejectedTakeProfitCheckpoint(context.journal, {
      trustedIssuers: context.trustedIssuers,
      now: timestamp,
    });
    const canonicalStateDirectory = await realpath(resolve(stateDirectory));
    const reservationPath = await validateTakeProfitReservationOwnership(context, rejected, {
      stateDirectory: canonicalStateDirectory,
      statImpl,
    });
    if (!rejected.active) {
      return Object.freeze({
        ok: true,
        status: "rejected_live_result_reconciled",
        reconciliationRequired: false,
        executionLockReleased: false,
        reservationReleased: false,
        orderSpawned: false,
        journalPath: context.journalPath,
      });
    }
    await verifyJournalLockOwnership(rejected.journal, {
      stateDirectory: canonicalStateDirectory,
      journal: context.journalPath,
      fields: ["executionLockPath"],
      requirePresent: true,
    });
    const expiresAtMs = Date.parse(rejected.validated.expiresAt);
    if (timestamp < expiresAtMs) {
      return Object.freeze({
        ok: true,
        status: "waiting_for_card_expiry",
        expiresAt: rejected.validated.expiresAt,
        reconciliationRequired: true,
        executionLockReleased: false,
        reservationReleased: false,
        orderSpawned: false,
        journalPath: context.journalPath,
      });
    }
    const executionPath = rejected.journal.executionLockPath;
    const currentText = await readFile(context.journalPath, "utf8");
    fail(currentText === context.journalText, "reconciliation_journal_changed", "Rejected TAKE_PROFIT journal changed during recovery");
    const released = await releaseLocks(rejected.journal, {
      stateDirectory: canonicalStateDirectory,
      journal: context.journalPath,
      fields: ["executionLockPath"],
      expectedLockHashes: { executionLockPath: rejected.journal.executionLockHash },
      transitionId: "take-profit-definitive-gtd-rejection-v1",
      writeState,
      unlinkImpl,
      now: timestamp,
      statImpl,
      transition: (next, { releasedAt }) => {
        next.reconciliationReason = "definitive_gtd_rejection_after_card_expiry";
        next.stage = "rejected_live_result_reconciled";
        next.reconciliationRequired = false;
        next.reconciledAt = releasedAt;
        next.lastError = {
          code: "definitive_gtd_rejection",
          at: releasedAt,
          executionAmbiguous: false,
        };
      },
    });
    const releasedSet = new Set(released);
    fail(
      releasedSet.size === 1 && releasedSet.has(executionPath),
      "execution_lock_release_failed",
      "Rejected TAKE_PROFIT global lock was not released exactly",
    );
    await statImpl(reservationPath);
    return Object.freeze({
      ok: true,
      status: "rejected_live_result_reconciled",
      reconciliationRequired: false,
      executionLockReleased: true,
      reservationReleased: false,
      orderSpawned: false,
      journalPath: context.journalPath,
    });
  }
  const isAuthorizationOnly = new Set([
    "payment_authorization_starting",
    "payment_authorization_created",
    "payment_header_rejected_after_authorization",
    "paid_request_ambiguous",
  ]).has(context.journal.stage);
  const isPaidUnstarted = new Set([
    "trade_confirmed",
    "execution_lock_acquired",
    "execution_blocked_before_launch",
  ]).has(context.journal.stage);
  const isVerifiedUnconfirmed = context.journal.stage === "payment_verified";
  if (!isAuthorizationOnly && !isPaidUnstarted && !isVerifiedUnconfirmed) return null;

  await requireOwnerOnlyRecoveryState(context.journalPath, stateDirectory, { statImpl });
  const canonicalStateDirectory = await realpath(resolve(stateDirectory));
  const recovery = isAuthorizationOnly
    ? validateTakeProfitAuthorizationCheckpoint(context.journal)
    : isVerifiedUnconfirmed
      ? validateVerifiedUnconfirmedTakeProfitCheckpoint(context.journal, {
          trustedIssuers: context.trustedIssuers,
          now: timestamp,
        })
      : validatePaidUnstartedTakeProfitCheckpoint(context.journal, {
        trustedIssuers: context.trustedIssuers,
        now: timestamp,
      });
  const reservationPath = await validateTakeProfitReservationOwnership(context, recovery, {
    stateDirectory: canonicalStateDirectory,
    statImpl,
  });
  let unattachedExecutionLock = Object.freeze({ released: false, path: null, generationHash: null });
  if (
    isPaidUnstarted && context.journal.stage === "trade_confirmed" &&
    context.journal.executionLockPath == null
  ) {
    unattachedExecutionLock = await reconcileUnattachedExecutionLockImpl({
      file: join(canonicalStateDirectory, "polymarket-execution.lock.json"),
      journal: context.journalPath,
      directory: canonicalStateDirectory,
      expectedJournalHash: sha256(recovery.journal),
      expectedPurposes: ["TP_PLACE"],
      statImpl,
      unlinkImpl,
    });
  }
  let reconciliationAuthorizationState = null;
  let reconciliationReason;
  let reconciledStage;

  if (isPaidUnstarted && recovery.attachedExecutionLock) {
    const expiresAtMs = Date.parse(recovery.validated.expiresAt);
    const legacyV1 = recovery.journal.executionLockGeneration == null &&
      recovery.journal.executionLockHash == null && recovery.journal.executionLockPurpose == null &&
      recovery.journal.executionLockRecoveryNotBefore == null;
    fail(
      legacyV1 || (
        recovery.journal.executionLockPurpose === "TP_PLACE" &&
        recovery.journal.executionLockRecoveryNotBefore === recovery.validated.expiresAt
      ),
      "lock_ownership_mismatch",
      "TAKE_PROFIT execution lock is not bound to the signed placement window",
    );
    await verifyJournalLockOwnership(recovery.journal, {
      stateDirectory: canonicalStateDirectory,
      journal: context.journalPath,
      fields: ["executionLockPath"],
      requirePresent: true,
    });
    const expired = timestamp >= expiresAtMs;
    const executionPath = recovery.journal.executionLockPath;
    if (!expired) {
      return Object.freeze({
        ok: true,
        status: "waiting_for_card_expiry",
        expiresAt: recovery.validated.expiresAt,
        reconciliationRequired: true,
        executionLockReleased: false,
        reservationReleased: false,
        orderSpawned: false,
        journalPath: context.journalPath,
      });
    }
    const currentText = await readFile(context.journalPath, "utf8");
    fail(currentText === context.journalText, "reconciliation_journal_changed", "TAKE_PROFIT journal changed during execution-lock recovery");
    const released = await releaseLocks(recovery.journal, {
      stateDirectory: canonicalStateDirectory,
      journal: context.journalPath,
      fields: ["executionLockPath", "reservationLockPath"],
      transitionId: "take-profit-attached-unstarted-expiry-v2",
      writeState,
      unlinkImpl,
      now: timestamp,
      statImpl,
      transition: (next, { releasedAt }) => {
        next.reconciliationReason = "expired_paid_card_without_order_spawn";
        next.stage = "expired_paid_unstarted_reconciled";
        next.reconciliationRequired = false;
        next.reconciledAt = releasedAt;
      },
    });
    const releasedSet = new Set(released);
    fail(
      releasedSet.has(executionPath) &&
        releasedSet.has(reservationPath) && releasedSet.size === 2,
      "execution_lock_release_failed",
      "TAKE_PROFIT unstarted execution locks were not released exactly",
    );
    return Object.freeze({
      ok: true,
      status: "expired_paid_unstarted_reconciled",
      reconciliationRequired: false,
      executionLockReleased: true,
      reservationReleased: true,
      orderSpawned: false,
      journalPath: context.journalPath,
    });
  }

  if (isAuthorizationOnly) {
    if (recovery.authorization == null) {
      return Object.freeze({
        ok: true,
        status: "manual_reconciliation_required",
        reason: "payment_authorization_metadata_missing",
        reconciliationRequired: true,
        reservationReleased: false,
        journalPath: context.journalPath,
      });
    }
    const validBeforeMs = Number(BigInt(recovery.authorization.validBefore) * 1_000n);
    fail(Number.isSafeInteger(validBeforeMs), "invalid_payment_authorization", "Stored TAKE_PROFIT authorization expiry is unsafe");
    if (timestamp <= validBeforeMs) {
      return Object.freeze({
        ok: true,
        status: "waiting_for_authorization_expiry",
        expiresAt: new Date(validBeforeMs).toISOString(),
        reconciliationRequired: true,
        reservationReleased: false,
        journalPath: context.journalPath,
      });
    }
    const authorizationState = await authorizationStateImpl(recovery.authorization);
    fail(UINT_RE.test(String(authorizationState?.blockTimestamp || "")), "invalid_authorization_state", "Finalized authorization-state timestamp is invalid");
    if (BigInt(authorizationState.blockTimestamp) <= BigInt(recovery.authorization.validBefore)) {
      return Object.freeze({
        ok: true,
        status: "waiting_for_finalized_authorization_expiry",
        expiresAt: new Date(validBeforeMs).toISOString(),
        reconciliationRequired: true,
        reservationReleased: false,
        journalPath: context.journalPath,
      });
    }
    if (authorizationState.used !== false) {
      return Object.freeze({
        ok: true,
        status: "manual_reconciliation_required",
        reason: "payment_authorization_consumed_or_ambiguous",
        reconciliationRequired: true,
        reservationReleased: false,
        journalPath: context.journalPath,
      });
    }
    fail(
      UINT_RE.test(String(authorizationState.blockNumber || "")) &&
        HASH_RE.test(String(authorizationState.blockHash || "")),
      "invalid_authorization_state",
      "Unused authorization state is not pinned to a finalized X Layer block",
    );
    reconciliationAuthorizationState = authorizationState;
    reconciliationReason = "expired_unused_payment_authorization";
    reconciledStage = "expired_unused_payment_authorization_reconciled";
  } else {
    const expiresAtMs = Date.parse(recovery.validated.expiresAt);
    if (timestamp < expiresAtMs) {
      return Object.freeze({
        ok: true,
        status: "waiting_for_card_expiry",
        expiresAt: recovery.validated.expiresAt,
        reconciliationRequired: true,
        executionLockReleased: unattachedExecutionLock.released,
        reservationReleased: false,
        journalPath: context.journalPath,
      });
    }
    reconciliationReason = "expired_paid_card_without_order_spawn";
    reconciledStage = "expired_paid_unstarted_reconciled";
  }

  const currentText = await readFile(context.journalPath, "utf8");
  fail(currentText === context.journalText, "reconciliation_journal_changed", "TAKE_PROFIT journal changed during reconciliation");
  const released = await releaseLocks(recovery.journal, {
    stateDirectory: canonicalStateDirectory,
    journal: context.journalPath,
    fields: ["reservationLockPath"],
    transitionId: "take-profit-unstarted-reconciliation-v1",
    writeState,
    unlinkImpl,
    now: timestamp,
    transition: (next, { releasedAt }) => {
      next.reconciliationAuthorizationState = reconciliationAuthorizationState;
      next.reconciliationReason = reconciliationReason;
      next.stage = reconciledStage;
      next.reconciliationRequired = false;
      next.reconciledAt = releasedAt;
    },
  });
  fail(released.length === 1 && released[0] === reservationPath, "reservation_release_failed", "TAKE_PROFIT reservation was not released exactly once");
  return Object.freeze({
    ok: true,
    status: reconciledStage,
    reconciliationRequired: false,
    executionLockReleased: unattachedExecutionLock.released,
    reservationReleased: true,
    orderSpawned: false,
    journalPath: context.journalPath,
  });
}

function validateVerifiedTakeProfitPaymentCheckpoint(journalInput, {
  trustedIssuers,
  now = Date.now(),
} = {}) {
  const observedNow = Number(typeof now === "function" ? now() : now);
  fail(Number.isFinite(observedNow), "invalid_prepassport_clock", "Pre-passport recovery clock is invalid");
  const journal = record(
    journalInput,
    "invalid_prepassport_journal",
    "Pre-passport TAKE_PROFIT journal must be an object",
  );
  fail(
    journal.version === "conviction-take-profit-journey-v1" && journal.action === "TAKE_PROFIT",
    "invalid_prepassport_journal",
    "Journal is not a TAKE_PROFIT buyer journey",
  );

  const paymentPayer = requireCanonicalAddress(
    journal.paymentPayer,
    "invalid_prepassport_journal",
    "Journal payment payer is invalid",
  );
  const signerAddress = requireCanonicalAddress(
    journal.signerAddress,
    "invalid_prepassport_journal",
    "Journal signer address is invalid",
  );
  const depositWallet = requireCanonicalAddress(
    journal.depositWallet,
    "invalid_prepassport_journal",
    "Journal deposit wallet is invalid",
  );
  fail(signerAddress === paymentPayer, "prepassport_identity_mismatch", "Journal signer and x402 payer differ");
  fail(paymentPayer !== SERVICE_PAYEE, "prepassport_identity_mismatch", "Service payee cannot recover as the buyer payer");

  const validated = validateTakeProfitCard(journal.paidCard, {
    trustedIssuers,
    now: observedNow,
    allowExpired: true,
  });
  fail(validated.wallet === depositWallet, "prepassport_identity_mismatch", "Signed TAKE_PROFIT card belongs to another Polygon wallet");
  const intentHash = requireCanonicalHash(
    journal.intentHash,
    "invalid_prepassport_journal",
    "Journal intent hash is invalid",
  );
  fail(intentHash === validated.intentHash, "prepassport_intent_mismatch", "Journal intent differs from the trusted signed TAKE_PROFIT card");

  const request = record(
    journal.request,
    "invalid_prepassport_journal",
    "Journal request is missing",
  );
  fail(String(request.action || "").toLowerCase() === "take_profit", "prepassport_request_mismatch", "Journal request is not TAKE_PROFIT");
  fail(String(request.wallet || "") === depositWallet, "prepassport_request_mismatch", "Journal request wallet differs from the signed card");
  fail(String(request.outcome || "").toUpperCase() === validated.outcome, "prepassport_request_mismatch", "Journal request outcome differs from the signed card");
  fail(parseDecimal(request.shares, 6, "journal TAKE_PROFIT shares").toString() === validated.bounds.sharesRaw, "prepassport_request_mismatch", "Journal request shares differ from the signed card");
  fail(parseDecimal(request.targetPrice, 6, "journal TAKE_PROFIT target price") === parseDecimal(validated.bounds.targetPrice, 6, "signed TAKE_PROFIT target price"), "prepassport_request_mismatch", "Journal request target differs from the signed card");
  fail(String(request.venueExpiresAt || "") === validated.bounds.venueExpiresAt, "prepassport_request_mismatch", "Journal request venue expiry differs from the signed card");
  const requestedMarket = String(request.market || "").toLowerCase();
  fail(
    requestedMarket === String(validated.intent.market.slug || "").toLowerCase() ||
      requestedMarket === String(validated.intent.market.conditionId || "").toLowerCase(),
    "prepassport_request_mismatch",
    "Journal request market differs from the signed card",
  );
  const source = record(
    request.sourcePosition,
    "invalid_prepassport_journal",
    "Journal source position is missing",
  );
  for (const field of ["intentHash", "positionProofHash", "transactionHash", "orderId"]) {
    requireCanonicalHash(source[field], "invalid_prepassport_journal", `Journal source ${field} is invalid`);
  }
  fail(
    source.intentHash === validated.intent.source.intentHash &&
      source.positionProofHash === validated.intent.source.positionProofHash &&
      source.transactionHash === validated.intent.source.transactionHash &&
      source.orderId === validated.intent.source.orderId,
    "prepassport_source_mismatch",
    "Journal source position differs from the signed card",
  );

  const replayKey = requireCanonicalHash(
    journal.replayKey,
    "invalid_prepassport_journal",
    "Journal TAKE_PROFIT replay key is invalid",
  );
  fail(
    replayKey === takeProfitReplayKey({ request: {
      outcome: request.outcome,
      shares: request.shares,
      targetPrice: request.targetPrice,
      venueExpiresAt: request.venueExpiresAt,
      sourcePosition: source,
    }, sellerWallet: depositWallet }),
    "prepassport_replay_mismatch",
    "Journal replay identity differs from the paid TAKE_PROFIT request",
  );

  const paymentTx = requireCanonicalHash(
    journal.paymentTx,
    "invalid_prepassport_journal",
    "Journal x402 payment transaction is invalid",
  );
  const paymentProof = record(
    journal.paymentProof,
    "invalid_prepassport_journal",
    "Journal has no independently verified x402 payment proof",
  );
  const paidServiceResponse = record(
    journal.paidServiceResponse,
    "invalid_prepassport_journal",
    "Journal has no paid service response metadata",
  );
  fail(
    Number.isInteger(paidServiceResponse.status) && paidServiceResponse.status >= 200 &&
      paidServiceResponse.status < 300 && paidServiceResponse.paymentResponsePresent === true &&
    paymentProof.version === "conviction-x402-payment-v1" && paymentProof.chainId === 196 &&
      paymentProof.transactionHash === paymentTx && paymentProof.payer === paymentPayer &&
      paymentProof.payee === SERVICE_PAYEE && paymentProof.asset === SERVICE_ASSET &&
      paymentProof.amountAtomic === POSITION_MANAGER_SERVICE.priceAtomic &&
      /^\d+$/.test(String(paymentProof.blockNumber || "")) &&
      HASH_RE.test(String(paymentProof.blockHash || "")) &&
      ["transactionSucceeded", "receiptBoundToBlock", "freshPayment", "exactAsset", "exactPayer", "exactPayee", "exactAmount"]
        .every((field) => paymentProof.checks?.[field] === true),
    "prepassport_payment_mismatch",
    "Stored x402 payment proof is not the exact Position Manager payment",
  );
  fail(/^\d+$/.test(String(paymentProof.blockTimestamp || "")), "invalid_prepassport_journal", "Stored x402 payment timestamp is invalid");

  return Object.freeze({
    journal,
    validated,
    paymentPayer,
    signerAddress,
    depositWallet,
    intentHash,
    replayKey,
    paymentTx,
    paymentProof,
  });
}

function validatePaidTakeProfitCheckpoint(journalInput, options = {}) {
  const verified = validateVerifiedTakeProfitPaymentCheckpoint(journalInput, options);
  const {
    journal,
    validated,
    paymentPayer,
    signerAddress,
    depositWallet,
    intentHash,
    replayKey,
    paymentTx,
    paymentProof,
  } = verified;

  const consent = record(
    journal.tradeConsent,
    "invalid_prepassport_journal",
    "Journal has no recorded TAKE_PROFIT trade consent",
  );
  const confirmed = canonicalIso(
    consent.confirmedAt,
    "invalid_prepassport_journal",
    "TAKE_PROFIT consent time is invalid",
  );
  fail(
    consent.version === "conviction-take-profit-consent-v1" &&
      consent.intentHash === validated.intentHash &&
      consent.executionArgvHash === sha256(validated.executionCard.argv) &&
      consent.paymentTx === paymentTx && consent.replayKey === replayKey &&
      consent.placementExpiresAt === validated.expiresAt &&
      consent.venueExpiresAt === validated.bounds.venueExpiresAt,
    "prepassport_consent_mismatch",
    "Recorded TAKE_PROFIT consent does not authorize the trusted signed card",
  );
  fail(
    confirmed.milliseconds >= Number(BigInt(paymentProof.blockTimestamp) * 1_000n) &&
      confirmed.milliseconds >= Date.parse(validated.issuanceVerification.issuedAt) &&
      confirmed.milliseconds < Date.parse(validated.expiresAt),
    "prepassport_consent_mismatch",
    "Recorded TAKE_PROFIT consent is not strictly inside the paid placement window",
  );

  return Object.freeze({
    journal,
    validated,
    paymentPayer,
    signerAddress,
    depositWallet,
    intentHash,
    confirmedAt: confirmed.text,
    replayKey,
    paymentTx,
    paymentProof,
  });
}

const DEFINITIVE_GTD_REJECTION = Object.freeze({
  error_code: "SELL_FAILED",
  error: "Order placement failed: expiration is required for GTD orders",
});

function validateDefinitiveRejectedTakeProfitCheckpoint(journalInput, options = {}) {
  const journal = record(
    journalInput,
    "invalid_rejected_live_result",
    "Rejected TAKE_PROFIT checkpoint must be an object",
  );
  const active = journal.stage === "live_result_received" && journal.reconciliationRequired === true;
  const reconciled = journal.stage === "rejected_live_result_reconciled" && journal.reconciliationRequired === false;
  fail(active || reconciled, "invalid_rejected_live_result", "Journal is not a supported rejected TAKE_PROFIT checkpoint");
  const checkpoint = validatePaidTakeProfitCheckpoint(journal, options);
  const result = record(journal.liveResult, "invalid_rejected_live_result", "Rejected TAKE_PROFIT result is missing");
  fail(
    journal.executionAttempted === true && (() => {
      const attemptedAt = canonicalIso(
        journal.executionAttemptedAt,
        "invalid_rejected_live_result",
        "Rejected TAKE_PROFIT attempt time is invalid",
      ).milliseconds;
      return attemptedAt >= Date.parse(checkpoint.confirmedAt) && attemptedAt < Date.parse(checkpoint.validated.expiresAt);
    })() &&
      journal.executionArgvHash === sha256(checkpoint.validated.executionCard.argv) &&
      sha256(journal.executionArgv) === journal.executionArgvHash &&
      result.ok === false && result.error_code === DEFINITIVE_GTD_REJECTION.error_code &&
      result.error === DEFINITIVE_GTD_REJECTION.error &&
      (journal.orderId == null || journal.orderId === "") &&
      journal.takeProfitPassport == null && journal.takeProfitPassportHash == null &&
      journal.restingOrderProofHash == null,
    "invalid_rejected_live_result",
    "Rejected TAKE_PROFIT checkpoint is not the exact definitive pre-order GTD rejection",
  );
  if (active) {
    fail(
      typeof journal.executionLockPath === "string" && typeof journal.reservationLockPath === "string" &&
        HASH_RE.test(String(journal.executionLockHash || "")) && UUID_RE.test(String(journal.executionLockGeneration || "")) &&
        journal.executionLockPurpose === "TP_PLACE" &&
        journal.executionLockRecoveryNotBefore === checkpoint.validated.expiresAt,
      "lock_ownership_mismatch",
      "Rejected TAKE_PROFIT checkpoint has no exact execution and reservation lock binding",
    );
  } else {
    fail(
      journal.executionLockPath == null && typeof journal.reservationLockPath === "string" &&
        journal.executionLockPurpose == null && journal.executionLockRecoveryNotBefore == null &&
        journal.reconciliationReason === "definitive_gtd_rejection_after_card_expiry",
      "invalid_rejected_live_result",
      "Reconciled TAKE_PROFIT rejection retained a lock or changed its reason",
    );
  }
  return Object.freeze({ ...checkpoint, active });
}

/**
 * Validate only the narrow journal state written after a live order command
 * returned but before the first authenticated exact-order fetch completed.
 *
 * This intentionally accepts no candidate order ID: recovery is possible only
 * from the exact live result already persisted before the ambiguity occurred.
 */
export function validatePrePassportTakeProfitJournal(journalInput, options = {}) {
  const journal = record(
    journalInput,
    "invalid_prepassport_journal",
    "Pre-passport TAKE_PROFIT journal must be an object",
  );
  fail(
    journal.stage === "live_result_received" && journal.executionAttempted === true &&
      journal.reconciliationRequired === true,
    "invalid_prepassport_journal",
    "Journal is not the supported ambiguous post-submit/pre-passport TAKE_PROFIT state",
  );
  fail(
    journal.takeProfitPassport == null && journal.takeProfitPassportHash == null &&
      journal.restingOrderProofHash == null,
    "invalid_prepassport_journal",
    "Pre-passport recovery cannot replace an existing take-profit passport",
  );
  const checkpoint = validatePaidTakeProfitCheckpoint(journal, options);
  const observedNow = Number(typeof options.now === "function" ? options.now() : options.now ?? Date.now());
  fail(Number.isFinite(observedNow), "invalid_prepassport_clock", "Pre-passport recovery clock is invalid");
  const live = validateTakeProfitLiveResult(journal.paidCard, journal.liveResult, {
    trustedIssuers: options.trustedIssuers,
    now: observedNow,
    allowExpired: true,
  });
  const orderId = requireCanonicalHash(
    journal.orderId,
    "missing_prepassport_order_id",
    "Pre-passport recovery requires the exact persisted live order ID",
  );
  fail(orderId === live.orderId, "prepassport_order_mismatch", "Persisted order ID differs from the authenticated live result");
  return Object.freeze({ ...checkpoint, live, orderId });
}

export function recoverPrePassportTakeProfitJournal(journalInput, snapshot, {
  trustedIssuers,
  now = Date.now(),
  buildOrderProof = buildTakeProfitOrderProof,
} = {}) {
  const observedNow = Number(typeof now === "function" ? now() : now);
  fail(Number.isFinite(observedNow), "invalid_prepassport_clock", "Pre-passport recovery clock is invalid");
  const recovery = validatePrePassportTakeProfitJournal(journalInput, { trustedIssuers, now: observedNow });
  const proof = buildOrderProof(
    recovery.journal.paidCard,
    recovery.journal.liveResult,
    snapshot,
    { trustedIssuers, confirmedAt: Date.parse(recovery.confirmedAt) },
  );
  const status = String(proof?.status || proof?.restingOrderProof?.status || "");
  const armed = status === "ARMED";
  const recoverableStatuses = new Set([
    "PARTIAL_PENDING_CHAIN_PROOF",
    "PARTIAL_CANCELED_PENDING_CHAIN_PROOF",
    "PARTIAL_EXPIRED_PENDING_CHAIN_PROOF",
    "FILLED_PENDING_CHAIN_PROOF",
    "CANCELED",
    "EXPIRED",
    "UNKNOWN",
  ]);
  fail(
    proof?.ok === true && proof?.orderId === recovery.orderId &&
      proof?.restingOrderProof?.status === status && proof.restingOrderProof.onChain === false &&
      HASH_RE.test(String(proof.restingOrderProofHash || "")) &&
      HASH_RE.test(String(proof.takeProfitPassportHash || "")) &&
      (armed
        ? proof.restingOrderProof.version === "conviction-resting-order-proof-v1" && proof.recoverable !== true
        : recoverableStatuses.has(status) &&
          proof.restingOrderProof.version === "conviction-submitted-order-proof-v1" && proof.recoverable === true),
    "invalid_prepassport_order_proof",
    "Recovered exact order did not produce a valid TAKE_PROFIT passport",
  );

  const next = structuredClone(recovery.journal);
  next.stage = armed ? "armed" : "submitted";
  next.status = status;
  next.orderId = proof.orderId;
  next.takeProfitPassport = proof.takeProfitPassport;
  next.takeProfitPassportHash = proof.takeProfitPassportHash;
  next.restingOrderProofHash = proof.restingOrderProofHash;
  next.initialOrderSnapshot = proof.initialOrderSnapshot || snapshot;
  next.initialOrderSnapshotHash = proof.initialOrderSnapshotHash || sha256(snapshot);
  next.reconciliationRequired = true;
  next.prePassportRecoveredAt = new Date(observedNow).toISOString();
  next.prePassportRecovery = {
    version: "conviction-take-profit-prepassport-recovery-v1",
    orderId: proof.orderId,
    intentHash: recovery.intentHash,
    confirmedAt: recovery.confirmedAt,
    initialOrderSnapshotHash: next.initialOrderSnapshotHash,
    noPaymentOrPlacementPerformed: true,
  };
  const binding = validateTakeProfitJournal(next, { trustedIssuers });
  return Object.freeze({ journal: next, binding, snapshot: next.initialOrderSnapshot });
}

export async function safeTakeProfitJournalPath(value, stateDirectory = STATE_DIRECTORY) {
  const requested = resolve(String(value || ""));
  let linkInfo;
  try { linkInfo = await lstat(requested); } catch {
    fail(false, "invalid_state_path", "TAKE_PROFIT journal path does not resolve inside the private Conviction state directory");
  }
  fail(!linkInfo.isSymbolicLink(), "unsafe_state_symlink", "TAKE_PROFIT journal must not be a symbolic link");
  fail(linkInfo.isFile(), "invalid_state_path", "TAKE_PROFIT journal must be a regular file");
  let root;
  let file;
  try {
    [root, file] = await Promise.all([realpath(resolve(stateDirectory)), realpath(requested)]);
  } catch {
    fail(false, "invalid_state_path", "TAKE_PROFIT journal path does not resolve inside the private Conviction state directory");
  }
  const within = relative(root, file);
  fail(
    within && within !== ".." && !within.startsWith(`..${sep}`) && !isAbsolute(within) && basename(file).endsWith("-take-profit.json"),
    "invalid_state_path",
    "TAKE_PROFIT journal must be inside the private Conviction state directory",
  );
  return file;
}

async function loadRawLifecycleContext(options, { stateDirectory = STATE_DIRECTORY } = {}) {
  const journalPath = await safeTakeProfitJournalPath(options.journal, stateDirectory);
  await resumePendingStateRelease({
    journal: journalPath,
    stateDirectory,
    writeState: writeTakeProfitState,
  });
  const [journalText, trustedText] = await Promise.all([
    readFile(journalPath, "utf8"),
    readFile(options.issuerRegistry, "utf8"),
  ]);
  const journal = JSON.parse(journalText);
  if (journal.paymentTx != null || journal.paymentProof != null || journal.paidCard != null) {
    await verifyStoredPaymentTransactionClaim({
      state: journal,
      service: POSITION_MANAGER_SERVICE,
      stateDirectory,
    });
  }
  const trustedDocument = JSON.parse(trustedText);
  const trustedIssuers = trustedIssuerRegistry(trustedDocument?.issuers || trustedDocument);
  fail(trustedIssuers.size > 0, "missing_trusted_issuer", "Pinned issuer registry is empty");
  return { journalPath, journalText, journal, trustedIssuers };
}

async function loadLifecycleContext(options, { stateDirectory = STATE_DIRECTORY } = {}) {
  const context = await loadRawLifecycleContext(options, { stateDirectory });
  const binding = validateTakeProfitJournal(context.journal, { trustedIssuers: context.trustedIssuers });
  return { ...context, binding };
}

function validateTakeProfitCancelExecutionCheckpoint(context) {
  const journal = context?.journal;
  const binding = context?.binding || validateTakeProfitJournal(journal, {
    trustedIssuers: context?.trustedIssuers,
  });
  const cancel = record(
    journal?.cancelExecution,
    "invalid_cancel_execution_checkpoint",
    "TAKE_PROFIT cancel execution checkpoint is missing",
  );
  fail(
    cancel.version === "conviction-take-profit-cancel-execution-v2" &&
      new Set([
        "lock_acquired",
        "attempted",
        "expired_unattempted",
        "pre_spawn_failed",
        "terminal",
      ]).has(cancel.phase),
    "invalid_cancel_execution_checkpoint",
    "TAKE_PROFIT cancel execution phase is invalid",
  );
  const confirmedAt = canonicalIso(cancel.confirmedAt, "invalid_cancel_execution_checkpoint", "Cancel confirmation time");
  const launchExpiresAt = canonicalIso(cancel.launchExpiresAt, "invalid_cancel_execution_checkpoint", "Cancel launch expiry");
  const request = buildTakeProfitCancelRequest({
    journal,
    snapshot: cancel.preCancelSnapshot,
    typedConfirmation: TAKE_PROFIT_CANCEL_CONFIRMATION,
    confirmedAt: confirmedAt.text,
  }, {
    trustedIssuers: context?.trustedIssuers,
    now: confirmedAt.milliseconds,
  });
  const exactArgv = Array.isArray(cancel.argv) && cancel.argv.length === request.argv.length &&
    cancel.argv.every((value, index) => value === request.argv[index]);
  const consent = record(
    journal?.cancelConsent,
    "invalid_cancel_execution_checkpoint",
    "TAKE_PROFIT cancel consent is missing",
  );
  fail(
    cancel.orderId === binding.orderId && cancel.orderId === request.orderId &&
      cancel.intentHash === binding.intentHash && cancel.intentHash === request.intentHash &&
      cancel.takeProfitPassportHash === binding.passportHash &&
      cancel.takeProfitPassportHash === request.takeProfitPassportHash &&
      cancel.preCancelSnapshotHash === request.preCancelSnapshotHash &&
      cancel.preCancelSnapshotHash === sha256(cancel.preCancelSnapshot) && exactArgv &&
      cancel.argvHash === sha256(request.argv) && cancel.launchExpiresAt === request.launchExpiresAt &&
      consent.version === "conviction-take-profit-cancel-consent-v2" &&
      consent.orderId === cancel.orderId && consent.confirmedAt === cancel.confirmedAt &&
      consent.launchExpiresAt === cancel.launchExpiresAt &&
      consent.preCancelSnapshotHash === cancel.preCancelSnapshotHash && consent.argvHash === cancel.argvHash &&
      UUID_RE.test(String(cancel.executionLockGeneration || "")) &&
      HASH_RE.test(String(cancel.executionLockHash || "")) &&
      launchExpiresAt.milliseconds > confirmedAt.milliseconds &&
      (new Set(["lock_acquired", "attempted"]).has(cancel.phase)
        ? journal.executionLockPurpose === "TP_CANCEL" &&
          journal.executionLockRecoveryNotBefore === cancel.launchExpiresAt &&
          journal.executionLockHash === cancel.executionLockHash &&
          journal.executionLockGeneration === cancel.executionLockGeneration &&
          journal.executionLockPath != null && journal.reconciliationRequired === true
        : journal.executionLockPath == null && journal.executionLockGeneration == null &&
          journal.executionLockHash == null && journal.executionLockPurpose == null &&
          journal.executionLockRecoveryNotBefore == null),
    "invalid_cancel_execution_checkpoint",
    "TAKE_PROFIT cancel execution differs from its exact order, snapshot, or lock",
  );
  const attemptedAt = cancel.attemptedAt == null
    ? null
    : canonicalIso(cancel.attemptedAt, "invalid_cancel_execution_checkpoint", "Cancel attempt time");
  if (cancel.phase === "lock_acquired") {
    fail(
      attemptedAt == null && journal.cancelAttemptedAt == null && journal.cancelExecutionArgv == null &&
        journal.cancelResult == null && journal.cancelOutcome == null,
      "invalid_cancel_execution_checkpoint",
      "Unattempted TAKE_PROFIT cancel contains execution evidence",
    );
  } else if (cancel.phase === "attempted") {
    fail(
      attemptedAt != null && attemptedAt.milliseconds < launchExpiresAt.milliseconds &&
        journal.cancelAttemptedAt === attemptedAt.text &&
        Array.isArray(journal.cancelExecutionArgv) && sha256(journal.cancelExecutionArgv) === cancel.argvHash,
      "invalid_cancel_execution_checkpoint",
      "Attempted TAKE_PROFIT cancel lacks its exact durable pre-spawn marker",
    );
  } else if (cancel.phase === "expired_unattempted") {
    const expiredAt = canonicalIso(cancel.expiredAt, "invalid_cancel_execution_checkpoint", "Cancel expiry recovery time");
    fail(
      attemptedAt == null && expiredAt.milliseconds >= launchExpiresAt.milliseconds &&
        journal.cancelAttemptedAt == null && journal.cancelExecutionArgv == null &&
        journal.cancelResult == null && journal.cancelOutcome == null && journal.reconciliationRequired === false,
      "invalid_cancel_execution_checkpoint",
      "Expired TAKE_PROFIT cancel is not an exact unattempted terminal checkpoint",
    );
  } else if (cancel.phase === "pre_spawn_failed") {
    canonicalIso(cancel.failedAt, "invalid_cancel_execution_checkpoint", "Cancel pre-spawn failure time");
    const markerConsistent = attemptedAt == null
      ? journal.cancelAttemptedAt == null && journal.cancelExecutionArgv == null
      : journal.cancelAttemptedAt === attemptedAt.text && Array.isArray(journal.cancelExecutionArgv) &&
        sha256(journal.cancelExecutionArgv) === cancel.argvHash;
    fail(
      markerConsistent && journal.cancelResult == null && journal.cancelOutcome == null &&
        journal.reconciliationRequired === false && journal.cancelError?.executionAmbiguous === false,
      "invalid_cancel_execution_checkpoint",
      "Pre-spawn TAKE_PROFIT cancel recovery contains possible live evidence",
    );
  } else if (cancel.phase === "terminal") {
    canonicalIso(cancel.terminalAt, "invalid_cancel_execution_checkpoint", "Cancel terminal time");
    fail(
      attemptedAt != null && journal.cancelAttemptedAt === attemptedAt.text &&
        Array.isArray(journal.cancelExecutionArgv) && sha256(journal.cancelExecutionArgv) === cancel.argvHash &&
        journal.reconciliationRequired === false,
      "invalid_cancel_execution_checkpoint",
      "Terminal TAKE_PROFIT cancel lacks its durable attempted marker",
    );
  }
  return Object.freeze({ cancel, binding, request, confirmedAt, launchExpiresAt, attemptedAt });
}

async function markTakeProfitCancelAttempted(context, {
  now = Date.now,
  stateDirectory,
  writeState = writeTakeProfitState,
  statImpl = stat,
} = {}) {
  return withStateReleaseMutex(stateDirectory, async (mutexLease) => {
    await assertNoStateReleaseInProgress({ directory: stateDirectory, mutexHeld: true, mutexLease });
    await requireOwnerOnlyRecoveryState(context.journalPath, stateDirectory, { statImpl });
    const durableText = await readFile(context.journalPath, "utf8");
    fail(durableText === context.journalText, "reconciliation_journal_changed", "TAKE_PROFIT cancel journal changed before attempt");
    const checkpoint = validateTakeProfitCancelExecutionCheckpoint(context);
    fail(checkpoint.cancel.phase === "lock_acquired", "cancel_execution_ambiguous", "TAKE_PROFIT cancel is not pre-attempt");
    await validateTakeProfitReservationOwnership(context, {
      journal: context.journal,
      replayKey: context.journal.replayKey,
    }, {
      stateDirectory,
      statImpl,
      allowProgressed: true,
    });
    await verifyJournalLockOwnership(context.journal, {
      stateDirectory,
      journal: context.journalPath,
      fields: ["executionLockPath"],
      requirePresent: true,
    });
    const attemptedAtMs = Number(typeof now === "function" ? now() : now);
    fail(
      Number.isFinite(attemptedAtMs) && attemptedAtMs < checkpoint.launchExpiresAt.milliseconds,
      "cancel_execution_window_elapsed",
      "TAKE_PROFIT cancel launch window elapsed before its durable attempt marker",
    );
    const next = structuredClone(context.journal);
    next.cancelExecution.phase = "attempted";
    next.cancelExecution.attemptedAt = new Date(attemptedAtMs).toISOString();
    next.cancelAttemptedAt = next.cancelExecution.attemptedAt;
    next.cancelExecutionArgv = [...checkpoint.request.argv];
    next.reconciliationRequired = true;
    mutexLease.assertAlive();
    try {
      await writeState(next, {
        directory: stateDirectory,
        file: context.journalPath,
        mutexHeld: true,
        mutexLease,
      });
    } catch (error) {
      if (error?.journalWriteReachedTarget === true) {
        for (const key of Object.keys(context.journal)) delete context.journal[key];
        Object.assign(context.journal, next);
        context.journalText = await readFile(context.journalPath, "utf8");
      }
      throw error;
    }
    for (const key of Object.keys(context.journal)) delete context.journal[key];
    Object.assign(context.journal, next);
    context.journalText = await readFile(context.journalPath, "utf8");
    return Object.freeze({ attemptedAt: next.cancelAttemptedAt, argv: Object.freeze([...checkpoint.request.argv]) });
  });
}

async function recoverKnownUnstartedTakeProfitCancel(context, {
  now = Date.now,
  stateDirectory,
  errorCode = "take_profit_cancel_pre_spawn_failed",
  writeState = writeTakeProfitState,
  releaseLocks = releaseReconciledLocks,
} = {}) {
  const checkpoint = validateTakeProfitCancelExecutionCheckpoint(context);
  fail(
    checkpoint.cancel.phase === "lock_acquired" || checkpoint.cancel.phase === "attempted",
    "unsafe_prelaunch_recovery",
    "TAKE_PROFIT cancel is not a known-unstarted in-process checkpoint",
  );
  await verifyJournalLockOwnership(context.journal, {
    stateDirectory,
    journal: context.journalPath,
    fields: ["executionLockPath"],
    requirePresent: true,
  });
  const released = await releaseLocks(context.journal, {
    stateDirectory,
    journal: context.journalPath,
    fields: ["executionLockPath"],
    expectedLockHashes: { executionLockPath: checkpoint.cancel.executionLockHash },
    transitionId: "take-profit-cancel-known-unstarted-v2",
    writeState,
    now,
    transition: (next, { releasedAt }) => {
      next.cancelExecution.phase = "pre_spawn_failed";
      next.cancelExecution.failedAt = releasedAt;
      next.reconciliationRequired = false;
      next.cancelError = {
        code: String(errorCode || "take_profit_cancel_pre_spawn_failed"),
        at: releasedAt,
        executionAmbiguous: false,
      };
    },
  });
  fail(released.length === 1, "execution_lock_release_failed", "TAKE_PROFIT cancel lock was not released exactly once");
  context.journalText = await readFile(context.journalPath, "utf8");
  return Object.freeze({ releasedLocks: Object.freeze(released), reservationRetained: true });
}

async function reconcileTakeProfitCancelExecution(context, {
  now = Date.now,
  stateDirectory,
  writeState = writeTakeProfitState,
  releaseLocks = releaseReconciledLocks,
  unlinkImpl = unlink,
  statImpl = stat,
} = {}) {
  if (context.journal?.cancelExecution?.version !== "conviction-take-profit-cancel-execution-v2") return null;
  const checkpoint = validateTakeProfitCancelExecutionCheckpoint(context);
  await requireOwnerOnlyRecoveryState(context.journalPath, stateDirectory, { statImpl });
  const reservationPath = await validateTakeProfitReservationOwnership(context, {
    journal: context.journal,
    replayKey: context.journal.replayKey,
  }, {
    stateDirectory,
    statImpl,
    allowProgressed: true,
  });
  if (checkpoint.cancel.phase === "lock_acquired" || checkpoint.cancel.phase === "attempted") {
    await verifyJournalLockOwnership(context.journal, {
      stateDirectory,
      journal: context.journalPath,
      fields: ["executionLockPath"],
      requirePresent: true,
    });
  }
  if (checkpoint.cancel.phase === "attempted") return null;
  if (checkpoint.cancel.phase !== "lock_acquired") {
    return Object.freeze({
      ok: true,
      status: checkpoint.cancel.phase,
      reconciliationRequired: false,
      executionLockReleased: true,
      reservationReleased: false,
      journalPath: context.journalPath,
    });
  }
  const timestamp = Number(typeof now === "function" ? now() : now);
  fail(Number.isFinite(timestamp), "invalid_reconciliation_clock", "TAKE_PROFIT cancel reconciliation clock is invalid");
  if (timestamp < checkpoint.launchExpiresAt.milliseconds) {
    return Object.freeze({
      ok: true,
      status: "waiting_for_cancel_launch_expiry",
      expiresAt: checkpoint.launchExpiresAt.text,
      reconciliationRequired: true,
      executionLockReleased: false,
      reservationReleased: false,
      journalPath: context.journalPath,
    });
  }
  fail(
    await readFile(context.journalPath, "utf8") === context.journalText,
    "reconciliation_journal_changed",
    "TAKE_PROFIT cancel journal changed during expiry reconciliation",
  );
  const executionPath = context.journal.executionLockPath;
  const released = await releaseLocks(context.journal, {
    stateDirectory,
    journal: context.journalPath,
    fields: ["executionLockPath"],
    expectedLockHashes: { executionLockPath: checkpoint.cancel.executionLockHash },
    transitionId: "take-profit-cancel-expired-unattempted-v2",
    writeState,
    unlinkImpl,
    now: timestamp,
    statImpl,
    transition: (next, { releasedAt }) => {
      next.cancelExecution.phase = "expired_unattempted";
      next.cancelExecution.expiredAt = releasedAt;
      next.reconciliationRequired = false;
      next.cancelError = {
        code: "cancel_execution_window_elapsed",
        at: releasedAt,
        executionAmbiguous: false,
      };
    },
  });
  fail(
    released.length === 1 && released[0] === executionPath && context.journal.reservationLockPath === reservationPath,
    "execution_lock_release_failed",
    "Expired unattempted TAKE_PROFIT cancel did not release exactly its global lock",
  );
  return Object.freeze({
    ok: true,
    status: "cancel_expired_unattempted_reconciled",
    reconciliationRequired: false,
    executionLockReleased: true,
    reservationReleased: false,
    journalPath: context.journalPath,
  });
}

async function loadReconcileContext(options, {
  now = Date.now,
  stateDirectory = STATE_DIRECTORY,
  fetchExactOrderImpl = fetchExactOrderWithPropagation,
  buildOrderProof = buildTakeProfitOrderProof,
  writeState = writeTakeProfitState,
  releaseLocks = releaseReconciledLocks,
  authorizationStateImpl = fetchEip3009AuthorizationState,
  reconcileUnattachedExecutionLockImpl = reconcileUnattachedExecutionLock,
  unlinkImpl = unlink,
  statImpl = stat,
} = {}) {
  const context = await loadRawLifecycleContext(options, { stateDirectory });
  const canonicalStateDirectory = await realpath(resolve(stateDirectory));
  const earlyResult = await reconcileTakeProfitNonOrderState(context, {
    now,
    stateDirectory,
    authorizationStateImpl,
    reconcileUnattachedExecutionLockImpl,
    writeState,
    releaseLocks,
    unlinkImpl,
    statImpl,
  });
  if (earlyResult) {
    return {
      ...context,
      stateDirectory: canonicalStateDirectory,
      earlyResult,
    };
  }
  const hasPassportMaterial = context.journal.takeProfitPassport != null ||
    context.journal.takeProfitPassportHash != null || context.journal.restingOrderProofHash != null;
  if (hasPassportMaterial || context.journal.stage === "armed" || context.journal.stage === "submitted") {
    const binding = validateTakeProfitJournal(context.journal, { trustedIssuers: context.trustedIssuers });
    const lifecycleContext = { ...context, binding };
    await requireOwnerOnlyRecoveryState(context.journalPath, stateDirectory, { statImpl });
    await validateTakeProfitReservationOwnership(lifecycleContext, {
      journal: context.journal,
      replayKey: context.journal.replayKey,
    }, {
      stateDirectory: canonicalStateDirectory,
      statImpl,
      allowProgressed: true,
    });
    if (context.journal.executionLockPath == null) {
      await reconcileUnattachedExecutionLockImpl({
        file: join(canonicalStateDirectory, "polymarket-execution.lock.json"),
        journal: context.journalPath,
        directory: canonicalStateDirectory,
        expectedJournalHash: sha256(context.journal),
        expectedPurposes: ["TP_CANCEL"],
        statImpl,
        unlinkImpl,
      });
    }
    const cancelEarlyResult = await reconcileTakeProfitCancelExecution(lifecycleContext, {
      now,
      stateDirectory: canonicalStateDirectory,
      writeState,
      releaseLocks,
      unlinkImpl,
      statImpl,
    });
    if (cancelEarlyResult) {
      return {
        ...lifecycleContext,
        stateDirectory: canonicalStateDirectory,
        earlyResult: cancelEarlyResult,
      };
    }
    await progressTakeProfitReservation(context.journal, {
      stateDirectory: canonicalStateDirectory,
      now,
    });
    return {
      ...lifecycleContext,
      stateDirectory: canonicalStateDirectory,
      recoveredSnapshot: null,
      prePassportRecovered: false,
    };
  }

  await requireOwnerOnlyRecoveryState(context.journalPath, stateDirectory, { statImpl });
  const recovery = validatePrePassportTakeProfitJournal(context.journal, {
    trustedIssuers: context.trustedIssuers,
    now: now(),
  });
  const snapshot = await fetchExactOrderImpl({
    signerAddress: recovery.signerAddress,
    depositWallet: recovery.depositWallet,
    orderId: recovery.orderId,
    outcomeTokenId: recovery.validated.tokenId,
  });
  const recovered = recoverPrePassportTakeProfitJournal(context.journal, snapshot, {
    trustedIssuers: context.trustedIssuers,
    now,
    buildOrderProof,
  });
  const currentText = await readFile(context.journalPath, "utf8");
  fail(currentText === context.journalText, "prepassport_journal_changed", "TAKE_PROFIT journal changed while its exact order was being recovered");
  await validateTakeProfitReservationOwnership(context, recovery, {
    stateDirectory: canonicalStateDirectory,
    statImpl,
    allowProgressed: true,
  });
  const executionLock = await inspectOwnerVerifiedRecoveredExecutionLock(context, {
    stateDirectory: canonicalStateDirectory,
    statImpl,
  });
  recovered.journal.executionLockPath = executionLock.path;
  recovered.journal.prePassportRecovery.executionLockHash = executionLock.hash;
  recovered.journal.prePassportRecovery.executionLockObservedMissing = executionLock.missing;
  const unchangedText = await readFile(context.journalPath, "utf8");
  fail(unchangedText === context.journalText, "prepassport_journal_changed", "TAKE_PROFIT journal changed before its recovered passport was persisted");
  await writeState(recovered.journal, { directory: canonicalStateDirectory, file: context.journalPath });
  await progressTakeProfitReservation(recovered.journal, {
    stateDirectory: canonicalStateDirectory,
    now,
  });
  return {
    ...context,
    journalText: `${JSON.stringify(recovered.journal, null, 2)}\n`,
    journal: recovered.journal,
    stateDirectory: canonicalStateDirectory,
    binding: recovered.binding,
    recoveredSnapshot: recovered.snapshot,
    prePassportRecovered: true,
  };
}

async function exactLifecycleSnapshot(binding, {
  fetchExactOrderImpl = fetchExactOrderWithPropagation,
} = {}) {
  return fetchExactOrderImpl({
    signerAddress: binding.signerAddress,
    depositWallet: binding.depositWallet,
    orderId: binding.orderId,
    outcomeTokenId: binding.outcomeTokenId,
  });
}

export async function attachTakeProfitFillProof({
  journal,
  binding,
  trustedIssuers,
  snapshot,
  status,
} = {}, {
  now = Date.now,
  fetchTradeContributions = fetchExactAssociatedTradeContributions,
  verifyAggregateFill = fetchAndVerifyTakeProfitAggregateFill,
} = {}) {
  if (status?.settlementProofRequired !== true) return status;
  fail(snapshot && typeof snapshot === "object", "missing_order_snapshot", "Matched TAKE_PROFIT status has no exact-order snapshot");
  const tradeFetchedAt = Number(now());
  fail(Number.isFinite(tradeFetchedAt), "invalid_trade_clock", "TAKE_PROFIT trade-recovery clock is invalid");
  const tradeContributions = await fetchTradeContributions({
    signerAddress: binding.signerAddress,
    depositWallet: binding.depositWallet,
    orderId: binding.orderId,
    marketConditionId: binding.marketConditionId,
    outcomeTokenId: binding.outcomeTokenId,
    exactOrderSnapshot: snapshot,
    now: () => tradeFetchedAt,
  });
  const verified = await verifyAggregateFill({
    journal,
    orderSnapshot: snapshot,
    tradeContributions,
  }, {
    trustedIssuers,
    now: Number(now()),
  });
  const proof = verified?.proof;
  fail(
    verified?.ok === true && proof?.version === "conviction-take-profit-fill-proof-v1" &&
      /^0x[0-9a-f]{64}$/.test(String(verified?.proofHash || "")) &&
      proof.orderId === binding.orderId && proof.wallet === binding.depositWallet &&
      proof.outcomeTokenId === binding.outcomeTokenId &&
      proof.exactOrderSnapshotHash === status.snapshotHash,
    "invalid_take_profit_fill_proof",
    "TAKE_PROFIT fill verifier returned an inconsistent proof",
  );
  const finalized = proof.finality?.finalized === true;
  const orderTerminal = proof.lifecycle?.orderTerminal === true;
  return Object.freeze({
    ok: true,
    version: "conviction-take-profit-status-with-fill-v1",
    status: proof.status,
    verificationSource: "authenticated-clob-plus-independent-polygon-receipts",
    onChain: true,
    finalized,
    followUpRequired: !finalized || !orderTerminal,
    orderStatus: status,
    fillProof: proof,
    fillProofHash: verified.proofHash,
  });
}

export async function runTakeProfitStatusCli(options, {
  now = Date.now,
  stateDirectory = STATE_DIRECTORY,
  fetchTradeContributions = fetchExactAssociatedTradeContributions,
  verifyAggregateFill = fetchAndVerifyTakeProfitAggregateFill,
} = {}) {
  const context = await loadLifecycleContext(options, { stateDirectory });
  try {
    const snapshot = await exactLifecycleSnapshot(context.binding);
    const status = buildTakeProfitStatus(context.journal, snapshot, {
      trustedIssuers: context.trustedIssuers,
      now: now(),
    });
    return attachTakeProfitFillProof({
      ...context,
      snapshot,
      status,
    }, {
      now,
      fetchTradeContributions,
      verifyAggregateFill,
    });
  } catch (error) {
    if (!["order_not_found", "order_unavailable"].includes(error?.code)) throw error;
    return buildTakeProfitLookupFailureStatus(context.journal, {
      errorCode: error.code,
      observedAt: new Date(now()).toISOString(),
    }, {
      trustedIssuers: context.trustedIssuers,
      now: now(),
    });
  }
}

export function takeProfitReconciliationResolved(status) {
  if (status?.version === "conviction-take-profit-status-with-fill-v1") {
    return status.finalized === true && status.fillProof?.lifecycle?.orderTerminal === true;
  }
  return status?.orderTerminal === true && status?.settlementProofRequired === false;
}

function recoveredArmedPlacementState(context, status) {
  const journal = context?.journal;
  const binding = context?.binding;
  const recovery = journal?.prePassportRecovery;
  const exactRecoveredArmedJournal = (
    recovery?.version === "conviction-take-profit-prepassport-recovery-v1" &&
    recovery.noPaymentOrPlacementPerformed === true &&
    (recovery.executionLockHash === null || HASH_RE.test(String(recovery.executionLockHash || ""))) &&
    recovery.orderId === binding?.orderId && recovery.intentHash === binding?.intentHash &&
    recovery.confirmedAt === journal?.tradeConsent?.confirmedAt &&
    recovery.initialOrderSnapshotHash === journal?.initialOrderSnapshotHash &&
    recovery.initialOrderSnapshotHash === sha256(journal?.initialOrderSnapshot) &&
    journal?.stage === "armed" && journal?.status === "ARMED" &&
    binding?.initialStatus === "ARMED" && binding?.initialMatchedRaw === 0n
  );
  if (!exactRecoveredArmedJournal) return null;
  if (
    recovery.executionLockReleasedAt != null && journal.executionLockPath == null &&
    journal.reconciliationRequired === false
  ) return "resolved";
  const exactCurrentArmed = (
    status?.version === "conviction-take-profit-status-v1" && status.status === "ARMED" &&
    status.takeProfitPassportHash === binding.passportHash &&
    status.restingOrderProofHash === binding.proofHash &&
    status.order?.id === binding.orderId && status.order?.matchedSharesRaw === "0" &&
    status.orderTerminal === false && status.settlementProofRequired === false
  );
  const cancelFields = [
    "cancelConsent",
    "cancelAttemptedAt",
    "cancelExecutionArgv",
    "cancelResult",
    "cancelOutcome",
    "cancelError",
  ];
  return exactCurrentArmed && recovery.executionLockReleasedAt == null && journal.reconciliationRequired === true &&
    cancelFields.every((field) => journal[field] == null)
    ? "pending"
    : null;
}

async function inspectOwnerVerifiedRecoveredExecutionLock(context, {
  stateDirectory,
  statImpl = stat,
} = {}) {
  await requireOwnerOnlyRecoveryState(context.journalPath, stateDirectory, { statImpl });
  const declared = context.journal.executionLockPath;
  if (!declared) return Object.freeze({ path: null, hash: null, missing: true });
  let observed;
  try {
    [observed] = await verifyJournalLockOwnership(context.journal, {
      stateDirectory,
      journal: context.journalPath,
      fields: ["executionLockPath"],
      requirePresent: false,
    });
  } catch (error) {
    if (error?.code === "lock_ownership_mismatch") {
      try {
        const candidate = JSON.parse(await readFile(declared, "utf8"));
        if (candidate?.journalPath === context.journalPath) {
          throw Object.assign(new Error("Recovered TAKE_PROFIT execution-lock generation changed"), {
            code: "lock_generation_mismatch",
            cause: error,
          });
        }
      } catch (candidateError) {
        if (candidateError?.code === "lock_generation_mismatch") throw candidateError;
      }
    }
    throw error;
  }
  fail(observed, "lock_ownership_mismatch", "Recovered TAKE_PROFIT execution lock cannot be authenticated");
  return Object.freeze({
    path: observed.file,
    hash: observed.missing ? null : observed.lockHash,
    missing: observed.missing === true,
  });
}

async function settleRecoveredArmedPlacement({
  context,
  status,
  stateDirectory,
} = {}, {
  now = Date.now,
  releaseLocks = releaseReconciledLocks,
  writeState = writeTakeProfitState,
  statImpl = stat,
} = {}) {
  const placementState = recoveredArmedPlacementState(context, status);
  if (!placementState) return null;
  if (placementState === "resolved") {
    await requireOwnerOnlyRecoveryState(context.journalPath, stateDirectory, { statImpl });
    await assertNoStateReleaseInProgress({ directory: stateDirectory });
    const lifecycleRequiresFollowUp = status?.status !== "ARMED" && !takeProfitReconciliationResolved(status);
    return Object.freeze({
      ...status,
      journalPath: context.journalPath,
      reconciliationRequired: lifecycleRequiresFollowUp,
      executionLockReleased: false,
    });
  }

  const currentText = await readFile(context.journalPath, "utf8");
  fail(currentText === context.journalText, "prepassport_journal_changed", "Recovered ARMED journal changed before execution-lock release");
  const reservationPath = await validateTakeProfitReservationOwnership(context, {
    journal: context.journal,
    replayKey: context.journal.replayKey,
  }, {
    stateDirectory,
    statImpl,
    allowProgressed: true,
  });
  const reservationText = await readFile(reservationPath, "utf8");
  const observedLock = await inspectOwnerVerifiedRecoveredExecutionLock(context, { stateDirectory, statImpl });
  fail(
    observedLock.missing || observedLock.hash === context.journal.prePassportRecovery.executionLockHash,
    "lock_generation_mismatch",
    "Recovered TAKE_PROFIT execution lock is from another operation",
  );
  fail(
    context.journal.prePassportRecovery.executionLockHash !== null || observedLock.missing,
    "lock_generation_mismatch",
    "A new execution lock appeared after the recovered TAKE_PROFIT snapshot",
  );
  const declaredLock = Boolean(context.journal.executionLockPath);
  if (observedLock.path) context.journal.executionLockPath = observedLock.path;
  const released = await releaseLocks(context.journal, {
    stateDirectory,
    journal: context.journalPath,
    fields: ["executionLockPath"],
    transitionId: "take-profit-prepassport-armed-recovery-v1",
    expectedLockHashes: { executionLockPath: context.journal.prePassportRecovery.executionLockHash },
    writeState,
    now,
    statImpl,
    beforeUnlink: async () => {
      fail(
        await readFile(reservationPath, "utf8") === reservationText,
        "reservation_ownership_mismatch",
        "Recovered ARMED reconciliation changed its TAKE_PROFIT reservation before release",
      );
    },
    afterUnlink: async () => {
      fail(
        await readFile(reservationPath, "utf8") === reservationText,
        "reservation_ownership_mismatch",
        "Recovered ARMED reconciliation changed its TAKE_PROFIT reservation during release",
      );
    },
    transition: (next, { releasedAt }) => {
      next.latestLifecycleStatus = "ARMED";
      next.reconciliationRequired = false;
      next.reconciledAt = releasedAt;
      next.prePassportRecovery.executionLockReleasedAt = releasedAt;
    },
  });
  return Object.freeze({
    ...status,
    journalPath: context.journalPath,
    reconciliationRequired: false,
    executionLockReleased: declaredLock && released.length === 1,
  });
}

export async function settleTakeProfitReconciliation({
  context,
  status,
  stateDirectory = STATE_DIRECTORY,
} = {}, {
  now = Date.now,
  releaseLocks = releaseReconciledLocks,
  writeState = writeTakeProfitState,
  statImpl = stat,
} = {}) {
  let cancelCheckpoint = null;
  if (context.journal?.cancelExecution?.version === "conviction-take-profit-cancel-execution-v2") {
    cancelCheckpoint = validateTakeProfitCancelExecutionCheckpoint(context);
    fail(
      cancelCheckpoint.cancel.phase === "attempted",
      "invalid_cancel_execution_checkpoint",
      "Only an attempted TAKE_PROFIT cancel may await terminal venue evidence",
    );
    await verifyJournalLockOwnership(context.journal, {
      stateDirectory,
      journal: context.journalPath,
      fields: ["executionLockPath"],
      requirePresent: true,
    });
  }
  const recoveredArmed = await settleRecoveredArmedPlacement({
    context,
    status,
    stateDirectory,
  }, {
    now,
    releaseLocks,
    writeState,
    statImpl,
  });
  if (recoveredArmed) return recoveredArmed;
  if (!takeProfitReconciliationResolved(status)) {
    return Object.freeze({
      ...status,
      journalPath: context.journalPath,
      reconciliationRequired: true,
      executionLockReleased: false,
    });
  }
  const released = await releaseLocks(context.journal, {
    stateDirectory,
    journal: context.journalPath,
    fields: ["executionLockPath"],
    expectedLockHashes: cancelCheckpoint
      ? { executionLockPath: cancelCheckpoint.cancel.executionLockHash }
      : undefined,
    transitionId: "take-profit-lifecycle-reconciliation-v1",
    writeState,
    now,
    transition: (next, { releasedAt }) => {
      next.latestLifecycleStatus = status.status;
      if (status.version === "conviction-take-profit-status-with-fill-v1") {
        next.latestFillProof = status.fillProof;
        next.latestFillProofHash = status.fillProofHash;
      }
      next.reconciliationRequired = false;
      next.reconciledAt = releasedAt;
      if (cancelCheckpoint) {
        next.cancelExecution.phase = "terminal";
        next.cancelExecution.terminalAt = releasedAt;
      }
    },
  });
  return Object.freeze({
    ...status,
    journalPath: context.journalPath,
    reconciliationRequired: false,
    executionLockReleased: released.length > 0,
  });
}

export async function runTakeProfitReconcileCli(options, {
  now = Date.now,
  stateDirectory = STATE_DIRECTORY,
  fetchExactOrderImpl = fetchExactOrderWithPropagation,
  fetchTradeContributions = fetchExactAssociatedTradeContributions,
  verifyAggregateFill = fetchAndVerifyTakeProfitAggregateFill,
  buildOrderProof = buildTakeProfitOrderProof,
  writeState = writeTakeProfitState,
  releaseLocks = releaseReconciledLocks,
  authorizationStateImpl = fetchEip3009AuthorizationState,
  reconcileUnattachedExecutionLockImpl = reconcileUnattachedExecutionLock,
  unlinkImpl = unlink,
  statImpl = stat,
} = {}) {
  const context = await loadReconcileContext(options, {
    now,
    stateDirectory,
    fetchExactOrderImpl,
    buildOrderProof,
    writeState,
    releaseLocks,
    authorizationStateImpl,
    reconcileUnattachedExecutionLockImpl,
    unlinkImpl,
    statImpl,
  });
  if (context.earlyResult) return context.earlyResult;
  let status;
  try {
    const snapshot = context.recoveredSnapshot || await exactLifecycleSnapshot(context.binding, { fetchExactOrderImpl });
    const clobStatus = buildTakeProfitStatus(context.journal, snapshot, {
      trustedIssuers: context.trustedIssuers,
      now: now(),
    });
    status = await attachTakeProfitFillProof({
      ...context,
      snapshot,
      status: clobStatus,
    }, {
      now,
      fetchTradeContributions,
      verifyAggregateFill,
    });
  } catch (error) {
    if (!["order_not_found", "order_unavailable"].includes(error?.code)) throw error;
    status = buildTakeProfitLookupFailureStatus(context.journal, {
      errorCode: error.code,
      observedAt: new Date(now()).toISOString(),
    }, {
      trustedIssuers: context.trustedIssuers,
      now: now(),
    });
  }

  return settleTakeProfitReconciliation({
    context,
    status,
    stateDirectory: context.stateDirectory,
  }, {
    now,
    releaseLocks,
    writeState,
    statImpl,
  });
}

export async function runTakeProfitCancelCli(options, {
  now = Date.now,
  stateDirectory = STATE_DIRECTORY,
  fetchTradeContributions = fetchExactAssociatedTradeContributions,
  verifyAggregateFill = fetchAndVerifyTakeProfitAggregateFill,
  fetchExactOrderImpl = fetchExactOrderWithPropagation,
  claimExecutionLockImpl = claimExecutionLock,
  markCancelAttemptedImpl = markTakeProfitCancelAttempted,
  commandJsonImpl = commandJson,
  pluginCommand = undefined,
  settleExecutionLockImpl = settleExecutionLock,
  readConfirmationImpl = undefined,
} = {}) {
  const context = await loadLifecycleContext(options, { stateDirectory });
  const beforeSnapshot = await exactLifecycleSnapshot(context.binding, { fetchExactOrderImpl });
  const beforeStatus = buildTakeProfitStatus(context.journal, beforeSnapshot, {
    trustedIssuers: context.trustedIssuers,
    now: now(),
  });
  (options.json ? stderr : stdout).write(`${JSON.stringify({ type: "take_profit_cancel_confirmation", status: beforeStatus })}\n`);
  const readline = readConfirmationImpl
    ? null
    : createInterface({ input: stdin, output: options.json ? stderr : stdout });
  let executionAttempted = false;
  let ownedCancelLock = null;
  try {
    const prompt = `Type exactly \`${TAKE_PROFIT_CANCEL_CONFIRMATION}\` to cancel only ${context.binding.orderId}: `;
    const answer = readConfirmationImpl
      ? await readConfirmationImpl(prompt)
      : await readline.question(prompt);
    const confirmedAt = new Date(now()).toISOString();
    const cancelRequest = buildTakeProfitCancelRequest({
      journal: context.journal,
      snapshot: beforeSnapshot,
      typedConfirmation: answer.trim(),
      confirmedAt,
    }, {
      trustedIssuers: context.trustedIssuers,
      now: now(),
    });
    await claimExecutionLockImpl({
      journal: context.journalPath,
      directory: stateDirectory,
      file: join(stateDirectory, "polymarket-execution.lock.json"),
      state: context.journal,
      purpose: "TP_CANCEL",
      recoveryNotBefore: cancelRequest.launchExpiresAt,
      now,
      writeState: writeTakeProfitState,
      transition: (next, { lock, lockHash }) => {
        delete next.cancelResult;
        delete next.cancelOutcome;
        delete next.cancelError;
        delete next.cancelAttemptedAt;
        delete next.cancelExecutionArgv;
        next.cancelConsent = {
          version: "conviction-take-profit-cancel-consent-v2",
          orderId: cancelRequest.orderId,
          confirmedAt,
          launchExpiresAt: cancelRequest.launchExpiresAt,
          preCancelSnapshotHash: cancelRequest.preCancelSnapshotHash,
          argvHash: sha256(cancelRequest.argv),
        };
        next.cancelExecution = {
          version: "conviction-take-profit-cancel-execution-v2",
          phase: "lock_acquired",
          orderId: cancelRequest.orderId,
          intentHash: cancelRequest.intentHash,
          takeProfitPassportHash: cancelRequest.takeProfitPassportHash,
          preCancelSnapshot: structuredClone(cancelRequest.preCancelSnapshot),
          preCancelSnapshotHash: cancelRequest.preCancelSnapshotHash,
          argv: [...cancelRequest.argv],
          argvHash: sha256(cancelRequest.argv),
          confirmedAt,
          launchExpiresAt: cancelRequest.launchExpiresAt,
          lockAcquiredAt: lock.claimedAt,
          executionLockGeneration: lock.generation,
          executionLockHash: lockHash,
          attemptedAt: null,
          executionRuntime: null,
        };
        next.reconciliationRequired = true;
      },
    });
    const claimedCancel = context.journal.cancelExecution;
    fail(
      claimedCancel?.version === "conviction-take-profit-cancel-execution-v2" &&
        claimedCancel.phase === "lock_acquired" &&
        claimedCancel.executionLockGeneration === context.journal.executionLockGeneration &&
        claimedCancel.executionLockHash === context.journal.executionLockHash,
      "lock_ownership_mismatch",
      "TAKE_PROFIT cancel did not durably attach the locally claimed execution lock",
    );
    ownedCancelLock = Object.freeze({
      generation: claimedCancel.executionLockGeneration,
      hash: claimedCancel.executionLockHash,
    });
    context.journalText = await readFile(context.journalPath, "utf8");
    const attempt = await markCancelAttemptedImpl(context, {
      now,
      stateDirectory,
      writeState: writeTakeProfitState,
    });
    const persistedRuntime = pluginCommand ? null : resolvePolymarketRuntime();
    if (persistedRuntime) {
      context.journal.cancelExecution.executionRuntime = polymarketRuntimeEvidenceFromInspection(persistedRuntime);
      await writeTakeProfitState(context.journal, { directory: stateDirectory, file: context.journalPath });
    }
    const launchRuntime = pluginCommand ? null : resolvePolymarketRuntime();
    if (launchRuntime && JSON.stringify(polymarketRuntimeEvidenceFromInspection(launchRuntime)) !==
      JSON.stringify(context.journal.cancelExecution.executionRuntime)) {
      throw Object.assign(new Error("Pinned Polymarket runtime changed before cancellation"), {
        code: "runtime_changed_before_execution",
      });
    }
    const cancelResult = await commandJsonImpl(pluginCommand || launchRuntime.binary, attempt.argv, "Exact TAKE_PROFIT cancellation", {
      deadlineEpochMs: Date.parse(cancelRequest.launchExpiresAt),
      clock: now,
      onStart: () => { executionAttempted = true; },
    });
    context.journal.cancelResult = cancelResult;
    await writeTakeProfitState(context.journal, { directory: stateDirectory, file: context.journalPath });

    let outcome;
    let afterSnapshot;
    try {
      afterSnapshot = await exactLifecycleSnapshot(context.binding, { fetchExactOrderImpl });
      outcome = buildTakeProfitCancelOutcome({
        journal: context.journal,
        beforeSnapshot,
        cancelResult,
        afterSnapshot,
      }, {
        trustedIssuers: context.trustedIssuers,
        now: now(),
      });
    } catch (error) {
      if (!["order_not_found", "order_unavailable"].includes(error?.code)) throw error;
      outcome = buildTakeProfitCancelOutcome({
        journal: context.journal,
        beforeSnapshot,
        cancelResult,
        afterLookupErrorCode: error.code,
        observedAt: new Date(now()).toISOString(),
      }, {
        trustedIssuers: context.trustedIssuers,
        now: now(),
      });
    }
    const verifiedOutcome = afterSnapshot && outcome.settlementProofRequired === true
      ? await attachTakeProfitFillProof({
        ...context,
        snapshot: afterSnapshot,
        status: outcome,
      }, {
        now,
        fetchTradeContributions,
        verifyAggregateFill,
      })
      : outcome;
    context.journal.latestLifecycleStatus = verifiedOutcome.status;
    context.journal.cancelOutcome = outcome;
    if (verifiedOutcome.version === "conviction-take-profit-status-with-fill-v1") {
      context.journal.latestFillProof = verifiedOutcome.fillProof;
      context.journal.latestFillProofHash = verifiedOutcome.fillProofHash;
    }
    const safelyResolved = outcome.orderTerminal === true && (
      outcome.settlementProofRequired === false ||
      (verifiedOutcome.finalized === true && verifiedOutcome.fillProof?.lifecycle?.orderTerminal === true)
    );
    // Keep the journal explicitly recoverable until the guarded lock release
    // atomically commits the terminal phase. A crash before that transition
    // must never leave an attached lock behind a non-reconcilable journal.
    context.journal.reconciliationRequired = true;
    await writeTakeProfitState(context.journal, { directory: stateDirectory, file: context.journalPath });
    await settleExecutionLockImpl(context.journal, {
      liveAttempted: true,
      proofVerified: safelyResolved,
      stateDirectory,
      journal: context.journalPath,
      writeState: writeTakeProfitState,
      now,
      transitionId: "take-profit-cancel-terminal-release-v2",
      expectedLockHashes: {
        executionLockPath: context.journal.cancelExecution.executionLockHash,
      },
      transition: (next, { releasedAt }) => {
        next.cancelExecution.phase = "terminal";
        next.cancelExecution.terminalAt = releasedAt;
        next.reconciliationRequired = false;
      },
    });
    return { ...verifiedOutcome, journalPath: context.journalPath };
  } catch (error) {
    // An attachment ambiguity deliberately preserves the exact source
    // journal. This process has no proven release authority in that case.
    if (error?.preserveSourceJournal === true) throw error;
    let durable = context.journal;
    try {
      durable = JSON.parse(await readFile(context.journalPath, "utf8"));
      for (const key of Object.keys(context.journal)) delete context.journal[key];
      Object.assign(context.journal, durable);
      context.journalText = await readFile(context.journalPath, "utf8");
    } catch {}
    const activeCancel = durable?.cancelExecution?.version === "conviction-take-profit-cancel-execution-v2" &&
      new Set(["lock_acquired", "attempted"]).has(durable.cancelExecution.phase) && durable.executionLockPath;
    const locallyOwned = Boolean(
      ownedCancelLock && activeCancel &&
      durable.executionLockGeneration === ownedCancelLock.generation &&
      durable.executionLockHash === ownedCancelLock.hash &&
      durable.cancelExecution.executionLockGeneration === ownedCancelLock.generation &&
      durable.cancelExecution.executionLockHash === ownedCancelLock.hash,
    );
    if (locallyOwned && !executionAttempted) {
      try {
        await recoverKnownUnstartedTakeProfitCancel(context, {
          now,
          stateDirectory,
          errorCode: error?.code,
        });
      } catch (recoveryError) {
        error.details = {
          ...(error?.details && typeof error.details === "object" ? error.details : {}),
          prelaunchRecoveryError: recoveryError?.code || "prelaunch_recovery_failed",
        };
      }
    } else if (locallyOwned) {
      context.journal.reconciliationRequired = true;
      context.journal.cancelError = {
        code: error?.code || "take_profit_cancel_failed",
        at: new Date(now()).toISOString(),
        executionAmbiguous: true,
      };
      try { await writeTakeProfitState(context.journal, { directory: stateDirectory, file: context.journalPath }); } catch {}
    }
    throw error;
  } finally {
    readline?.close();
  }
}

export function formatTakeProfitPaymentDisplay(event, options) {
  const requirement = event.challenge?.decoded?.accepts?.[0] || {};
  return [
    "\nConviction Position Manager payment via **OKX Agent Payments Protocol**:",
    `  Product: ${POSITION_MANAGER_SERVICE.serviceName}`,
    `  Amount: ${POSITION_MANAGER_SERVICE.priceDisplay} (${requirement.amount} atomic USD₮0)`,
    `  Network: ${requirement.network}`,
    `  Asset: USD₮0 (${requirement.asset})`,
    `  From: ${options.paymentPayer}`,
    `  To: ${requirement.payTo}`,
    `  Resource: ${event.challenge?.decoded?.resource?.url}`,
    "  This payment does not authorize the Polygon order.",
    "",
  ].join("\n");
}

function paymentDisplay(event, options) {
  stdout.write(formatTakeProfitPaymentDisplay(event, options));
}

function tradeDisplay(event, latestReadiness) {
  const bounds = event.bounds;
  const minimumGross = formatDecimal(BigInt(bounds.minimumGrossProceedsRaw), 6);
  const minimumNet = formatDecimal(BigInt(bounds.minimumNetProceedsRaw), 6);
  stdout.write([
    "\nBounded TAKE_PROFIT ready:",
    `  Market: ${bounds.marketQuestion}`,
    `  Outcome sold: ${bounds.outcome}`,
    `  Exact shares offered: ${bounds.exactShares}`,
    `  Target price: ${bounds.targetPrice}`,
    `  Minimum gross proceeds at full fill: ${minimumGross} pUSD`,
    `  Post-settlement net verification floor: ${minimumNet} pUSD`,
    `  Venue expiry: ${bounds.venueExpiresAt}`,
    `  Placement-card expiry: ${bounds.placementExpiresAt}`,
    `  Current wallet shares: ${latestReadiness?.outcomeBalanceRaw || "unknown"} atomic`,
    `  Existing selected-token SELL reservations: ${latestReadiness?.openSellOrderCount ?? "unknown"}`,
    `  Seller wallet: ${bounds.wallet}`,
    `  Source position proof: ${bounds.sourcePositionProofHash}`,
    "  Order type: post-only GTD; partial fills are possible while the remainder rests.",
    "  Initial result is authenticated CLOB order evidence, not an on-chain fill claim.",
    "  Zero-match LIVE returns ARMED; a first-fetch match or state transition remains recoverable pending reconciliation/proof.",
    "",
  ].join("\n"));
}

export function requirePinnedTakeProfitExecutionReadiness(readiness, {
  paymentPayer,
  sellerWallet,
  tokenId,
  sharesRaw,
}) {
  fail(
    readiness?.accessible === true && readiness?.clobVersion === "V2" &&
      readiness?.currentMode === "deposit_wallet" &&
      String(readiness?.paymentPayer || "").toLowerCase() === paymentPayer &&
      String(readiness?.buyerWallet || "").toLowerCase() === sellerWallet &&
      String(readiness?.tradingAddress || "").toLowerCase() === sellerWallet,
    "trading_wallet_mismatch",
    "Active payer or Polygon deposit wallet changed before TAKE_PROFIT placement",
  );
  fail(String(readiness?.outcomeTokenId || "") === tokenId, "token_substitution", "Final position snapshot is for another outcome token");
  fail(readiness?.approvedForExchange === true, "ctf_approval_missing", "Final standard V2 outcome-token approval is missing");
  fail(readiness?.openOrdersComplete === true, "incomplete_open_orders", "Final open-order snapshot is incomplete");
  fail(BigInt(readiness?.outcomeBalanceRaw ?? -1) >= BigInt(sharesRaw), "insufficient_position", "Final outcome-token balance is below TAKE_PROFIT shares");
  fail(
    BigInt(readiness?.reservedSharesRaw ?? -1) === 0n && Number(readiness?.openSellOrderCount ?? -1) === 0,
    "position_reserved",
    "An open selected-token SELL appeared before TAKE_PROFIT placement",
  );
  return true;
}

export async function runTakeProfitCli(options, {
  now = Date.now,
  stateDirectory = STATE_DIRECTORY,
} = {}) {
  requireDistinctPaymentPayer(options.paymentPayer);
  const trustedDocument = JSON.parse(await readFile(options.issuerRegistry, "utf8"));
  const trustedRecords = trustedDocument?.issuers || trustedDocument;
  const trustedIssuers = trustedIssuerRegistry(trustedRecords);
  fail(trustedIssuers.size > 0, "missing_trusted_issuer", "Pinned issuer registry is empty");
  const sourcePosition = normalizeSourcePosition(JSON.parse(await readFile(options.sourceProof, "utf8")));
  const request = {
    action: "take_profit",
    market: options.market,
    outcome: options.side,
    shares: options.shares,
    targetPrice: options.targetPrice,
    venueExpiresAt: options.venueExpiresAt,
    rationale: options.rationale,
    sourcePosition,
  };
  const requestBody = {
    action: "take_profit",
    market: options.market,
    outcome: options.side.toLowerCase(),
    shares: options.shares,
    targetPrice: options.targetPrice,
    venueExpiresAt: options.venueExpiresAt,
    wallet: options.sellerWallet,
    rationale: options.rationale,
    sourcePosition,
  };
  const journal = join(stateDirectory, `${new Date(now()).toISOString().replace(/[:.]/g, "-")}-${process.pid}-take-profit.json`);
  const state = {
    version: "conviction-take-profit-journey-v1",
    action: "TAKE_PROFIT",
    stage: "not_started",
    journalPath: journal,
    request: { ...requestBody, sourcePosition },
    paymentPayer: options.paymentPayer,
    signerAddress: options.paymentPayer,
    depositWallet: options.sellerWallet,
    paymentRequestedAt: null,
    paymentAuthorization: null,
    paymentTx: null,
    paymentProof: null,
    paymentClaimPath: null,
    paymentClaimHash: null,
    paidCard: null,
    intentHash: null,
    tradeConsent: null,
    replayKey: null,
    reservationLockPath: null,
    executionLockPath: null,
    executionLockGeneration: null,
    executionLockHash: null,
    executionLockPurpose: null,
    executionLockRecoveryNotBefore: null,
    executionAttempted: false,
    liveResult: null,
    executionRuntime: null,
    orderId: null,
    takeProfitPassport: null,
    takeProfitPassportHash: null,
    restingOrderProofHash: null,
    reconciliationRequired: false,
  };
  await writeTakeProfitState(state, { directory: stateDirectory, file: journal });

  let selectedTradingMode = "";
  let latestReadiness;
  let paymentConsentUsed = false;
  let executionAttempted = false;
  const readline = createInterface({ input: stdin, output: options.json ? stderr : stdout });
  const persist = async (stage = undefined) => {
    if (stage) state.stage = stage;
    await writeTakeProfitState(state, { directory: stateDirectory, file: journal });
  };
  const emit = options.json
    ? (event) => stderr.write(`${JSON.stringify(event)}\n`)
    : (event) => {
        if (event.type === "payment_confirmation") paymentDisplay(event, options);
        if (event.type === "trade_confirmation") tradeDisplay(event, latestReadiness);
      };
  const confirm = async (kind, context = {}) => {
    if (kind === "payment") {
      if (paymentConsentUsed) return false;
      paymentConsentUsed = true;
      const answer = await readline.question(
        `Type \`confirm payment\` to pay exactly ${POSITION_MANAGER_SERVICE.priceDisplay} on X Layer: `,
      );
      return answer.trim() === "confirm payment";
    }
    const answer = await readline.question("Type `confirm live mode` to place this one bounded TAKE_PROFIT order: ");
    const accepted = answer.trim() === "confirm live mode";
    if (accepted) {
      const confirmedAt = now();
      state.tradeConsent = {
        version: "conviction-take-profit-consent-v1",
        intentHash: context.validated.intentHash,
        executionArgvHash: sha256(context.validated.executionCard.argv),
        paymentTx: state.paymentTx,
        replayKey: state.replayKey,
        confirmedAt: new Date(confirmedAt).toISOString(),
        placementExpiresAt: context.validated.expiresAt,
        venueExpiresAt: context.validated.bounds.venueExpiresAt,
      };
      await persist("trade_confirmed");
      return { accepted: true, confirmedAt };
    }
    return false;
  };

  const ensureTradingMode = async () => {
    const switched = await commandJson(
      polymarketPluginCommand(),
      ["switch-mode", "--mode", "deposit-wallet"],
      "Polymarket trading-mode selection",
    );
    const data = switched?.data || switched;
    fail(data?.mode === "deposit-wallet", "wrong_trading_mode", "Polymarket did not select DEPOSIT_WALLET mode");
    selectedTradingMode = data.mode;
    return data;
  };
  const loadReadiness = async () => {
    const [access, addresses, quickstart] = await Promise.all([
      commandJson(polymarketPluginCommand(), ["check-access"], "Polymarket access check"),
      commandJson("onchainos", ["wallet", "addresses"], "Agentic Wallet addresses"),
      commandJson(polymarketPluginCommand(), ["quickstart"], "Polymarket readiness"),
    ]);
    latestReadiness = normalizePluginReadiness({
      access,
      addresses,
      quickstart,
      selectedMode: selectedTradingMode,
      pUsdBalanceRaw: "0",
    });
    return latestReadiness;
  };
  const loadTakeProfitReadiness = async ({ outcomeTokenId }) => {
    const [readiness, position] = await Promise.all([
      loadReadiness(),
      fetchPositionSnapshot(options.sellerWallet, outcomeTokenId),
    ]);
    const complete = await fetchAllOpenOrders({
      signerAddress: options.paymentPayer,
      depositWallet: options.sellerWallet,
      outcomeTokenId: position.outcomeTokenId,
    });
    fail(complete.complete === true, "incomplete_open_orders", "Polymarket open-order pagination is incomplete");
    const active = normalizeOpenOrders(complete.orders);
    const reservations = summarizeOpenSellReservations(active, position.outcomeTokenId);
    latestReadiness = {
      ...readiness,
      outcomeTokenId: position.outcomeTokenId,
      outcomeBalanceRaw: position.balanceRaw,
      positionBlockNumber: position.blockNumber,
      positionBlockHash: position.blockHash,
      approvedForExchange: position.approvedForExchange,
      reservedSharesRaw: reservations.reservedSharesRaw,
      openSellOrderCount: reservations.openSellOrderCount,
      openOrdersComplete: true,
    };
    return latestReadiness;
  };

  const adapters = {
    ensureTradingMode,
    checkReadiness: loadReadiness,
    previewTakeProfit: async () => {
      const { response, json } = await postJson(pinnedServiceUrl(POSITION_MANAGER_SERVICE, "/api/manage-preview"), requestBody);
      fail(response.ok && json?.ok === true, json?.error?.code || "preview_failed", json?.error?.message || "Free TAKE_PROFIT preview failed");
      return json;
    },
    checkTakeProfitReadiness: loadTakeProfitReadiness,
    requestPaymentChallenge: async () => {
      state.paymentRequestedAt = new Date(now()).toISOString();
      await persist("payment_challenge_requested");
      const { response, json } = await postJson(pinnedServiceUrl(POSITION_MANAGER_SERVICE), requestBody);
      const encoded = response.headers.get("payment-required");
      fail(response.status === 402 && encoded, "invalid_payment_challenge", json?.error?.message || "Manager did not return an x402 challenge");
      const decoded = decodeHeader(encoded, "PAYMENT-REQUIRED");
      validatePaymentChallenge(decoded, POSITION_MANAGER_SERVICE);
      return { encoded, decoded };
    },
    payAndRequestCard: async ({ challenge }) => {
      const replayKey = takeProfitReplayKey({ request, sellerWallet: options.sellerWallet });
      await claimTakeProfitReservation({
        key: replayKey,
        journal,
        directory: stateDirectory,
        state,
        writeState: writeTakeProfitState,
        transition: (next) => {
          next.replayKey = replayKey;
          next.reconciliationRequired = true;
          next.stage = "payment_authorization_starting";
        },
      });
      let signed;
      try {
        signed = await commandJson(
          "onchainos",
          ["payment", "pay", "--payload", challenge.encoded, "--selected-index", "0", "--chain", "xlayer"],
          "Position Manager payment authorization",
        );
      } catch (error) {
        await releaseReconciledLocks(state, {
          stateDirectory,
          journal,
          fields: ["reservationLockPath"],
          transitionId: "take-profit-payment-presign-failure-v1",
          writeState: writeTakeProfitState,
          now,
          transition: (next) => {
            next.reconciliationRequired = false;
            next.stage = "payment_authorization_failed_before_replay";
          },
        });
        throw error;
      }
      const data = signed?.data || signed;
      try {
        fail(data?.authorization_header && String(data.wallet || "").toLowerCase() === options.paymentPayer, "payment_wallet_mismatch", "x402 authorization was not signed by the pinned payer");
        state.paymentAuthorization = paymentAuthorizationMetadata(data.authorization_header, {
          paymentPayer: options.paymentPayer,
          service: POSITION_MANAGER_SERVICE,
        });
      } catch (error) {
        await releaseReconciledLocks(state, {
          stateDirectory,
          journal,
          fields: ["reservationLockPath"],
          transitionId: "take-profit-payment-metadata-rejection-v1",
          writeState: writeTakeProfitState,
          now,
          transition: (next) => {
            next.reconciliationRequired = false;
            next.stage = "payment_authorization_rejected_before_replay";
          },
        });
        throw error;
      }
      await persist("payment_authorization_created");
      if (data.header_name && String(data.header_name).toUpperCase() !== PAYMENT_SIGNATURE_HEADER) {
        state.reconciliationRequired = true;
        await persist("payment_header_rejected_after_authorization");
        fail(false, "payment_header_mismatch", "x402 signer returned an unexpected authorization header name");
      }
      const { response, json } = await postJson(pinnedServiceUrl(POSITION_MANAGER_SERVICE), requestBody, {
        headers: { [PAYMENT_SIGNATURE_HEADER]: data.authorization_header },
      });
      const paymentResponseRaw = response.headers.get("payment-response");
      if (!response.ok || json?.ok !== true) {
        state.paidServiceResponse = { status: response.status, paymentResponsePresent: Boolean(paymentResponseRaw) };
        state.reconciliationRequired = true;
        await persist("paid_request_ambiguous");
        fail(false, json?.error?.code || "paid_service_failed", json?.error?.message || "Paid TAKE_PROFIT compilation failed");
      }
      return persistSuccessfulPaidServiceResponse({
        state,
        response,
        json,
        paymentResponseRaw,
        ambiguousStage: "paid_request_ambiguous",
        writeState: async (next) => writeTakeProfitState(next, {
          directory: stateDirectory,
          file: journal,
        }),
      });
    },
    verifyPayment: async ({ paid, startedAt }) => {
      const result = await fetchAndVerifyX402Payment({
        paymentTx: paid.paymentTx,
        payer: options.paymentPayer,
        payee: SERVICE_PAYEE,
        asset: SERVICE_ASSET,
        amountAtomic: POSITION_MANAGER_SERVICE.priceAtomic,
        earliestAllowedTime: state.paymentRequestedAt || new Date(startedAt).toISOString(),
      });
      return persistVerifiedPaidServicePayment({
        state,
        paid,
        paymentProof: result.proof,
        service: POSITION_MANAGER_SERVICE,
        ambiguousStage: "paid_request_ambiguous",
        writeState: async (next) => writeTakeProfitState(next, {
          directory: stateDirectory,
          file: journal,
        }),
      });
    },
    validateTakeProfitCard: (card, validationOptions) => validateTakeProfitCard(card, validationOptions),
    dryRun: (argv) => commandJson(polymarketPluginCommand(), [...argv, "--dry-run"], "Polymarket TAKE_PROFIT dry run"),
    validateTakeProfitDryRun: (card, result, validationOptions) => validateTakeProfitPluginPreview(card, result, validationOptions),
    waitUntil: sleepUntil,
    execute: async (argv) => {
      await verifyStoredPaymentTransactionClaim({
        state,
        service: POSITION_MANAGER_SERVICE,
        stateDirectory,
      });
      try {
        await claimExecutionLock({
          journal,
          directory: stateDirectory,
          file: join(stateDirectory, "polymarket-execution.lock.json"),
          state,
          purpose: "TP_PLACE",
          recoveryNotBefore: state.tradeConsent.placementExpiresAt,
          now,
          writeState: writeTakeProfitState,
          transition: (next) => {
            next.stage = "execution_lock_acquired";
          },
        });
      } catch (error) {
        if (error?.preserveSourceJournal === true) throw error;
        markTakeProfitPreSpawnFailure(state, error, { liveSpawnStarted: false, now });
        await persist();
        throw error;
      }
      const tokenIndex = argv.indexOf("--token-id");
      const tokenId = tokenIndex >= 0 ? String(argv[tokenIndex + 1] || "") : "";
      let preserveExecutionSource = false;
      try {
        await ensureTradingMode();
        const lockedReadiness = await loadTakeProfitReadiness({ outcomeTokenId: tokenId });
        requirePinnedTakeProfitExecutionReadiness(lockedReadiness, {
          paymentPayer: options.paymentPayer,
          sellerWallet: options.sellerWallet,
          tokenId,
          sharesRaw: parseDecimal(argv[argv.indexOf("--shares") + 1], 6, "TAKE_PROFIT shares"),
        });
        let lockedCard = validateTakeProfitCard(state.paidCard, { trustedIssuers, now: now() });
        const preDryRunWindow = requireTakeProfitLaunchWindow(lockedCard, { now });
        const lockedDryRun = await commandJson(
          polymarketPluginCommand(),
          [...argv, "--dry-run"],
          "Locked TAKE_PROFIT dry run",
          { deadlineEpochMs: preDryRunWindow.placementDeadlineMs, clock: now },
        );
        validateTakeProfitPluginPreview(state.paidCard, lockedDryRun, { trustedIssuers, now: now() });
        lockedCard = validateTakeProfitCard(state.paidCard, { trustedIssuers, now: now() });
        requireTakeProfitLaunchWindow(lockedCard, { now });
        fail(sha256(lockedCard.executionCard.argv) === state.tradeConsent.executionArgvHash, "trade_consent_mismatch", "Locked TAKE_PROFIT differs from the confirmed order");
        await markExecutionAttempted(state, {
          journal,
          stateDirectory,
          purpose: "TP_PLACE",
          recoveryNotBefore: state.tradeConsent.placementExpiresAt,
          argv: lockedCard.executionCard.argv,
          now,
          writeState: writeTakeProfitState,
          transition: (next) => { next.executionAttempted = true; },
        });
        const launchCard = validateTakeProfitCard(state.paidCard, { trustedIssuers, now: now() });
        const launchWindow = requireTakeProfitLaunchWindow(launchCard, { now });
        fail(sha256(launchCard.executionCard.argv) === state.tradeConsent.executionArgvHash, "trade_consent_mismatch", "Live TAKE_PROFIT differs from the confirmed order");
        const persistedRuntime = resolvePolymarketRuntime();
        state.executionRuntime = polymarketRuntimeEvidenceFromInspection(persistedRuntime);
        await persist();
        const launchRuntime = resolvePolymarketRuntime();
        if (JSON.stringify(polymarketRuntimeEvidenceFromInspection(launchRuntime)) !== JSON.stringify(state.executionRuntime)) {
          throw Object.assign(new Error("Pinned Polymarket runtime changed before TAKE_PROFIT execution"), {
            code: "runtime_changed_before_execution",
          });
        }
        const result = await commandJson(launchRuntime.binary, argv, "Polymarket TAKE_PROFIT live order", {
          deadlineEpochMs: launchWindow.placementDeadlineMs,
          clock: now,
          onStart: () => { executionAttempted = true; },
        });
        state.liveResult = result;
        state.orderId = String((result?.data || result)?.order_id || "").toLowerCase();
        await persist("live_result_received");
        return result;
      } catch (error) {
        preserveExecutionSource = error?.preserveSourceJournal === true;
        if (!preserveExecutionSource && markTakeProfitPreSpawnFailure(state, error, { liveSpawnStarted: executionAttempted, now })) {
          await persist();
        }
        throw error;
      } finally {
        if (!preserveExecutionSource) {
          await settleExecutionLock(state, {
            liveAttempted: executionAttempted,
            proofVerified: false,
            stateDirectory,
            journal,
            writeState: writeTakeProfitState,
            now,
            transitionId: "take-profit-prelaunch-execution-release-v1",
          });
          await persist();
        }
      }
    },
    validateTakeProfitLiveResult: (card, result, validationOptions) => validateTakeProfitLiveResult(card, result, validationOptions),
    fetchExactOrder: (identity) => fetchExactOrderWithPropagation(identity),
    buildTakeProfitOrderProof: (card, live, snapshot, proofOptions) => buildTakeProfitOrderProof(card, live, snapshot, proofOptions),
  };

  try {
    const result = await runTakeProfitJourney({
      request,
      paymentPayer: options.paymentPayer,
      sellerWallet: options.sellerWallet,
      trustedIssuers,
      adapters,
      confirm,
      emit,
      now,
    });
    const armed = result.status === "ARMED";
    state.stage = armed ? "armed" : "submitted";
    state.status = result.status;
    state.orderId = result.orderId;
    state.takeProfitPassport = result.takeProfitPassport;
    state.takeProfitPassportHash = result.takeProfitPassportHash;
    state.restingOrderProofHash = result.restingOrderProofHash;
    state.initialOrderSnapshot = result.initialOrderSnapshot;
    state.initialOrderSnapshotHash = result.initialOrderSnapshotHash;
    // The authenticated passport is the durable source of truth. Persist it
    // before progressing the scoped reservation or releasing the global lock,
    // so every crash point is exactly recoverable without another placement.
    state.reconciliationRequired = true;
    await persist();
    await progressTakeProfitReservation(state, { stateDirectory, now });
    if (armed) {
      await settleExecutionLock(state, {
        liveAttempted: true,
        proofVerified: true,
        stateDirectory,
        journal,
        writeState: writeTakeProfitState,
        now,
        transitionId: "take-profit-armed-release-v1",
        transition: (next, { releasedAt }) => {
          next.reconciliationRequired = false;
          next.armedAt = releasedAt;
        },
      });
    }
    return {
      ...result,
      executionRuntime: state.executionRuntime,
      journalPath: journal,
      reservationLockPath: state.reservationLockPath,
    };
  } catch (error) {
    if (error?.releaseGuardRetained !== true && error?.preserveSourceJournal !== true) {
      state.reconciliationRequired = Boolean(
        executionAttempted || state.paymentAuthorization || state.paymentTx || state.reservationLockPath,
      );
      state.lastError = {
        code: error?.code || "take_profit_journey_failed",
        at: new Date(now()).toISOString(),
        executionAmbiguous: executionAttempted,
      };
      try { await persist(); } catch {}
    }
    error.details = {
      ...(error?.details && typeof error.details === "object" ? error.details : {}),
      journalPath: journal,
      ordersPlaced: executionAttempted ? "unknown" : 0,
      reconciliationRequired: state.reconciliationRequired,
    };
    throw error;
  } finally {
    readline.close();
  }
}

function isMain() {
  return process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
}

if (isMain()) {
  let options;
  try {
    options = parseTakeProfitArgs(process.argv.slice(2));
    const result = options.command === "tp-status"
      ? await runTakeProfitStatusCli(options)
      : options.command === "reconcile-tp"
        ? await runTakeProfitReconcileCli(options)
      : options.command === "cancel-tp"
        ? await runTakeProfitCancelCli(options)
        : await runTakeProfitCli(options);
    stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    stdout.write(`${JSON.stringify({
      ok: false,
      code: error?.code || "take_profit_journey_failed",
      message: error?.message || "TAKE_PROFIT journey failed",
      ordersPlaced: error?.details?.ordersPlaced ?? "unknown",
      journalPath: error?.details?.journalPath,
      reconciliationRequired: error?.details?.reconciliationRequired,
    })}\n`);
    process.exitCode = 1;
  }
}
