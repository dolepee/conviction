#!/usr/bin/env node

import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, realpath, rename, stat, unlink, writeFile, chmod } from "node:fs/promises";
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
  normalizeOpenOrders,
  normalizePluginReadiness,
  normalizeSourcePosition,
  parseJsonOutput,
  paymentAuthorizationMetadata,
  persistSuccessfulPaidServiceResponse,
  persistVerifiedPaidServicePayment,
  releaseReconciledLocks,
  requireDistinctPaymentPayer,
  resolveFailedLockAttachment,
  settleExecutionLock,
  summarizeOpenSellReservations,
  validatePaymentChallenge,
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
const PAYMENT_SIGNATURE_HEADER = "PAYMENT-SIGNATURE";
const ADDRESS_RE = /^0x[0-9a-f]{40}$/;
const HASH_RE = /^0x[0-9a-f]{64}$/;
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
    "It places one post-only GTD order and returns an authenticated ARMED proof.",
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
    await assertNoStateReleaseInProgress({ directory, releaseFile, mutexHeld: true });
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
    await assertNoStateReleaseInProgress({ directory, releaseFile, mutexHeld: true });
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

async function fetchExactOrderWithPropagation(argumentsObject) {
  let lastError;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      return await fetchExactOrder(argumentsObject);
    } catch (error) {
      lastError = error;
      if (error?.code !== "order_not_found" || attempt === 4) throw error;
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 200 * (attempt + 1)));
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
  const [rootStat, journalStat] = await Promise.all([statImpl(rootPath), statImpl(journalPath)]);
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
  let actual;
  try {
    actual = await realpath(resolve(String(recovery.journal.reservationLockPath || "")));
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
  try { lockJournal = await realpath(resolve(String(lock?.journalPath || ""))); } catch { lockJournal = null; }
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
  fail(
    unstartedStages.has(journal?.stage) && journal.executionAttempted === false &&
      journal.reconciliationRequired === true && journal.executionLockPath == null &&
      journal.liveResult == null && journal.orderId == null && journal.takeProfitPassport == null &&
      journal.takeProfitPassportHash == null && journal.restingOrderProofHash == null,
    "invalid_unstarted_checkpoint",
    "Journal is not a proven-unstarted paid TAKE_PROFIT checkpoint",
  );
  return validatePaidTakeProfitCheckpoint(journal, options);
}

function validateVerifiedUnconfirmedTakeProfitCheckpoint(journal, options) {
  fail(
    journal?.stage === "payment_verified" && journal.reconciliationRequired === true &&
      journal.tradeConsent == null && journal.executionLockPath == null &&
      journal.executionAttempted === false && journal.executionArgv == null &&
      journal.executionArgvHash == null && journal.liveResult == null &&
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
  writeState = writeTakeProfitState,
  releaseLocks = releaseReconciledLocks,
  unlinkImpl = unlink,
  statImpl = stat,
} = {}) {
  const timestamp = Number(now());
  fail(Number.isFinite(timestamp), "invalid_reconciliation_clock", "TAKE_PROFIT reconciliation clock is invalid");
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
  let reconciliationAuthorizationState = null;
  let reconciliationReason;
  let reconciledStage;

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
    if (timestamp <= expiresAtMs) {
      return Object.freeze({
        ok: true,
        status: "waiting_for_card_expiry",
        expiresAt: recovery.validated.expiresAt,
        reconciliationRequired: true,
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
    reservationReleased: true,
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
  const [journalText, trustedText] = await Promise.all([
    readFile(journalPath, "utf8"),
    readFile(options.issuerRegistry, "utf8"),
  ]);
  const journal = JSON.parse(journalText);
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

async function loadReconcileContext(options, {
  now = Date.now,
  stateDirectory = STATE_DIRECTORY,
  fetchExactOrderImpl = fetchExactOrderWithPropagation,
  buildOrderProof = buildTakeProfitOrderProof,
  writeState = writeTakeProfitState,
  authorizationStateImpl = fetchEip3009AuthorizationState,
  unlinkImpl = unlink,
  statImpl = stat,
} = {}) {
  const context = await loadRawLifecycleContext(options, { stateDirectory });
  const canonicalStateDirectory = await realpath(resolve(stateDirectory));
  const earlyResult = await reconcileTakeProfitNonOrderState(context, {
    now,
    stateDirectory,
    authorizationStateImpl,
    writeState,
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
    await requireOwnerOnlyRecoveryState(context.journalPath, stateDirectory, { statImpl });
    await validateTakeProfitReservationOwnership(context, {
      journal: context.journal,
      replayKey: context.journal.replayKey,
    }, {
      stateDirectory: canonicalStateDirectory,
      statImpl,
      allowProgressed: true,
    });
    await progressTakeProfitReservation(context.journal, {
      stateDirectory: canonicalStateDirectory,
      now,
    });
    return {
      ...context,
      stateDirectory: canonicalStateDirectory,
      binding,
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

  const root = await realpath(resolve(stateDirectory));
  const expected = join(root, "polymarket-execution.lock.json");
  let canonicalDeclared;
  try {
    canonicalDeclared = join(await realpath(dirname(resolve(String(declared)))), basename(String(declared)));
  } catch {
    fail(false, "lock_ownership_mismatch", "Recovered TAKE_PROFIT execution-lock directory cannot be verified");
  }
  fail(canonicalDeclared === expected, "lock_ownership_mismatch", "Recovered TAKE_PROFIT points to another execution lock");

  let lockStat;
  try {
    lockStat = await statImpl(expected);
  } catch (error) {
    if (error?.code === "ENOENT") return Object.freeze({ path: expected, hash: null, missing: true });
    throw error;
  }
  const expectedUid = typeof process.getuid === "function" ? process.getuid() : null;
  fail(lockStat.isFile() && (lockStat.mode & 0o077) === 0, "unsafe_state_permissions", "Recovered TAKE_PROFIT execution lock must be owner-only");
  if (expectedUid !== null) {
    fail(lockStat.uid === expectedUid, "unsafe_state_owner", "Recovered TAKE_PROFIT execution lock must belong to the current OS user");
  }
  let lock;
  try {
    lock = JSON.parse(await readFile(expected, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return Object.freeze({ path: expected, hash: null, missing: true });
    fail(false, "lock_ownership_mismatch", "Recovered TAKE_PROFIT execution lock cannot be authenticated");
  }
  fail(
    lock?.version === "conviction-polymarket-execution-lock-v1" &&
      lock?.journalPath === context.journalPath,
    "lock_ownership_mismatch",
    "Recovered TAKE_PROFIT execution lock belongs to another journey",
  );
  return Object.freeze({ path: expected, hash: sha256(lock), missing: false });
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
  unlinkImpl = unlink,
  statImpl = stat,
} = {}) {
  const context = await loadReconcileContext(options, {
    now,
    stateDirectory,
    fetchExactOrderImpl,
    buildOrderProof,
    writeState,
    authorizationStateImpl,
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
} = {}) {
  const context = await loadLifecycleContext(options, { stateDirectory });
  const beforeSnapshot = await exactLifecycleSnapshot(context.binding);
  const beforeStatus = buildTakeProfitStatus(context.journal, beforeSnapshot, {
    trustedIssuers: context.trustedIssuers,
    now: now(),
  });
  (options.json ? stderr : stdout).write(`${JSON.stringify({ type: "take_profit_cancel_confirmation", status: beforeStatus })}\n`);
  const readline = createInterface({ input: stdin, output: options.json ? stderr : stdout });
  let executionAttempted = false;
  try {
    const answer = await readline.question(`Type exactly \`${TAKE_PROFIT_CANCEL_CONFIRMATION}\` to cancel only ${context.binding.orderId}: `);
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
    await claimExecutionLock({
      journal: context.journalPath,
      directory: stateDirectory,
      file: join(stateDirectory, "polymarket-execution.lock.json"),
      state: context.journal,
      writeState: writeTakeProfitState,
      transition: (next) => {
        next.cancelConsent = {
          version: "conviction-take-profit-cancel-consent-v1",
          orderId: cancelRequest.orderId,
          confirmedAt,
          preCancelSnapshotHash: cancelRequest.preCancelSnapshotHash,
          argvHash: sha256(cancelRequest.argv),
        };
      },
    });
    context.journal.cancelAttemptedAt = new Date(now()).toISOString();
    context.journal.cancelExecutionArgv = [...cancelRequest.argv];
    context.journal.reconciliationRequired = true;
    executionAttempted = true;
    await writeTakeProfitState(context.journal, { directory: stateDirectory, file: context.journalPath });
    const cancelResult = await commandJson("polymarket-plugin", cancelRequest.argv, "Exact TAKE_PROFIT cancellation");
    context.journal.cancelResult = cancelResult;
    await writeTakeProfitState(context.journal, { directory: stateDirectory, file: context.journalPath });

    let outcome;
    let afterSnapshot;
    try {
      afterSnapshot = await exactLifecycleSnapshot(context.binding);
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
    context.journal.reconciliationRequired = !safelyResolved;
    await writeTakeProfitState(context.journal, { directory: stateDirectory, file: context.journalPath });
    await settleExecutionLock(context.journal, {
      liveAttempted: true,
      proofVerified: safelyResolved,
      stateDirectory,
      journal: context.journalPath,
      writeState: writeTakeProfitState,
      now,
      transitionId: "take-profit-cancel-terminal-release-v1",
    });
    return { ...verifiedOutcome, journalPath: context.journalPath };
  } catch (error) {
    context.journal.reconciliationRequired = executionAttempted;
    context.journal.cancelError = {
      code: error?.code || "take_profit_cancel_failed",
      at: new Date(now()).toISOString(),
      executionAmbiguous: executionAttempted,
    };
    try { await writeTakeProfitState(context.journal, { directory: stateDirectory, file: context.journalPath }); } catch {}
    if (context.journal.executionLockPath) {
      await settleExecutionLock(context.journal, {
        liveAttempted: executionAttempted,
        proofVerified: false,
        stateDirectory,
        journal: context.journalPath,
        writeState: writeTakeProfitState,
        now,
        transitionId: "take-profit-cancel-prelaunch-release-v1",
      });
    }
    throw error;
  } finally {
    readline.close();
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
    "  ARMED proof is authenticated CLOB evidence, not an on-chain fill claim.",
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
    paidCard: null,
    intentHash: null,
    tradeConsent: null,
    replayKey: null,
    reservationLockPath: null,
    executionLockPath: null,
    executionAttempted: false,
    liveResult: null,
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
      "polymarket-plugin",
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
      commandJson("polymarket-plugin", ["check-access"], "Polymarket access check"),
      commandJson("onchainos", ["wallet", "addresses"], "Agentic Wallet addresses"),
      commandJson("polymarket-plugin", ["quickstart"], "Polymarket readiness"),
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
    dryRun: (argv) => commandJson("polymarket-plugin", [...argv, "--dry-run"], "Polymarket TAKE_PROFIT dry run"),
    validateTakeProfitDryRun: (card, result, validationOptions) => validateTakeProfitPluginPreview(card, result, validationOptions),
    waitUntil: sleepUntil,
    execute: async (argv) => {
      try {
        await claimExecutionLock({
          journal,
          directory: stateDirectory,
          file: join(stateDirectory, "polymarket-execution.lock.json"),
          state,
          writeState: writeTakeProfitState,
          transition: (next) => {
            next.stage = "execution_lock_acquired";
          },
        });
      } catch (error) {
        markTakeProfitPreSpawnFailure(state, error, { liveSpawnStarted: false, now });
        await persist();
        throw error;
      }
      const tokenIndex = argv.indexOf("--token-id");
      const tokenId = tokenIndex >= 0 ? String(argv[tokenIndex + 1] || "") : "";
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
          "polymarket-plugin",
          [...argv, "--dry-run"],
          "Locked TAKE_PROFIT dry run",
          { deadlineEpochMs: preDryRunWindow.placementDeadlineMs, clock: now },
        );
        validateTakeProfitPluginPreview(state.paidCard, lockedDryRun, { trustedIssuers, now: now() });
        lockedCard = validateTakeProfitCard(state.paidCard, { trustedIssuers, now: now() });
        requireTakeProfitLaunchWindow(lockedCard, { now });
        fail(sha256(lockedCard.executionCard.argv) === state.tradeConsent.executionArgvHash, "trade_consent_mismatch", "Locked TAKE_PROFIT differs from the confirmed order");
        state.executionAttempted = true;
        state.reconciliationRequired = true;
        await persist("execution_attempted");
        const launchCard = validateTakeProfitCard(state.paidCard, { trustedIssuers, now: now() });
        const launchWindow = requireTakeProfitLaunchWindow(launchCard, { now });
        fail(sha256(launchCard.executionCard.argv) === state.tradeConsent.executionArgvHash, "trade_consent_mismatch", "Live TAKE_PROFIT differs from the confirmed order");
        const result = await commandJson("polymarket-plugin", argv, "Polymarket TAKE_PROFIT live order", {
          deadlineEpochMs: launchWindow.placementDeadlineMs,
          clock: now,
          onStart: () => { executionAttempted = true; },
        });
        state.liveResult = result;
        state.orderId = String((result?.data || result)?.order_id || "").toLowerCase();
        await persist("live_result_received");
        return result;
      } catch (error) {
        if (markTakeProfitPreSpawnFailure(state, error, { liveSpawnStarted: executionAttempted, now })) {
          await persist();
        }
        throw error;
      } finally {
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
    return { ...result, journalPath: journal, reservationLockPath: state.reservationLockPath };
  } catch (error) {
    if (error?.releaseGuardRetained !== true) {
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
