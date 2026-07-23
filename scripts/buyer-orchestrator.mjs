#!/usr/bin/env node

import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import { chmod, link, lstat, mkdir, open, readFile, realpath, rename, stat, unlink, writeFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createInterface } from "node:readline/promises";
import { stdin, stdout, stderr } from "node:process";
import { promisify } from "node:util";

import {
  bindCloseCardToRequest,
  runCloseJourney,
  runOpenJourney,
} from "../src/buyer-orchestrator.mjs";
import { sha256 } from "../src/canonical.mjs";
import { CONTRACTS, POLYGON_CHAIN_ID, POLYGON_RPC_URL } from "../src/constants.mjs";
import { parseDecimal } from "../src/decimal.mjs";
import { finiteEoaOpenPreparation } from "../src/eoa-open-preparation.mjs";
import { fetchAndVerifyClose } from "../src/exit-receipt-verifier.mjs";
import { trustedIssuerRegistry } from "../src/intent-issuer.mjs";
import { fetchPositionSnapshot } from "../src/position-client.mjs";
import { fetchAllOpenOrders, fetchExactOrder } from "../src/polymarket-open-orders.mjs";
import { parsePolymarketShareAtoms } from "../src/polymarket-quantities.mjs";
import {
  polymarketRuntimeEvidenceFromInspection,
  resolvePolymarketRuntime,
} from "../src/polymarket-runtime.mjs";
import { fetchAndVerifyPosition } from "../src/receipt-verifier.mjs";
import { verifySourcePosition } from "../src/source-position.mjs";
import {
  POSITION_CARD_SERVICE,
  POSITION_MANAGER_SERVICE,
  pinnedServiceUrl,
  requirePinnedServiceOrigin,
  SERVICE_ASSET,
  SERVICE_NETWORK,
  SERVICE_PAYEE,
  SERVICE_PAYMENT_TIMEOUT_SECONDS,
} from "../src/service-payment.mjs";
import { fetchAndVerifyX402Payment } from "../src/x402-payment-verifier.mjs";
import { verifyTerminalZeroFillOrder } from "../src/terminal-zero-fill.mjs";
import {
  buildReceiptRequest,
  validateCard,
  validatePluginPreview,
  validateProof,
  validateTerminalZeroOpenResult,
} from "../skills/conviction-executor/scripts/conviction-card.mjs";
import {
  buildCloseReceiptRequest,
  validateCloseCard,
  validateClosePluginPreview,
  validateCloseProof,
  validateTerminalZeroCloseResult,
} from "../skills/conviction-executor/scripts/conviction-exit-card.mjs";

const execFileAsync = promisify(execFile);
const polymarketPluginCommand = () => resolvePolymarketRuntime().binary;
const PAYMENT_SIGNATURE_HEADER = "PAYMENT-SIGNATURE";
let executionAttempted = false;
const journalDirectory = join(homedir(), ".local", "state", "conviction", "reconciliation");
const executionLockFile = join(journalDirectory, "polymarket-execution.lock.json");
const releaseLockBasename = "polymarket-execution.release.lock.json";
const releaseMutexHelper = join(dirname(fileURLToPath(import.meta.url)), "state-release-mutex.py");
const releaseJournalWriteCapabilities = new WeakSet();
const journalPath = join(
  journalDirectory,
  `${new Date().toISOString().replace(/[:.]/g, "-")}-${process.pid}.json`,
);
const checkpoint = {
  journalRevision: 0,
  mode: null,
  stage: "not_started",
  paymentTx: null,
  intentHash: null,
  orderId: null,
  settlementTx: null,
  positionProofHash: null,
  positionPassportHash: null,
  terminalZeroFillProof: null,
  terminalZeroFillProofHash: null,
  closeProofHash: null,
  closePassportHash: null,
  sourceIntentHash: null,
  sourcePositionProofHash: null,
  paidCard: null,
  liveResult: null,
  paymentProof: null,
  paymentClaimPath: null,
  paymentClaimHash: null,
  paymentRequestedAt: null,
  paymentAuthorization: null,
  paidServiceResponse: null,
  request: null,
  sourcePosition: null,
  paymentPayer: null,
  buyerWallet: null,
  tradeConfirmedAt: null,
  tradeConsent: null,
  executionArgv: null,
  executionArgvHash: null,
  executionRuntime: null,
  replayKey: null,
  replayLockPath: null,
  replayLockReleasedAt: null,
  replayLockReleaseError: null,
  executionLockPath: null,
  executionLockGeneration: null,
  executionLockHash: null,
  executionLockPurpose: null,
  executionLockRecoveryNotBefore: null,
  executionLockReleasedAt: null,
  executionLockReleaseError: null,
  reconciliationRequired: false,
  journalPath,
};

function journalRevision(value, label = "Reconciliation journal") {
  const revision = value?.journalRevision ?? 0;
  if (!Number.isSafeInteger(revision) || revision < 0) {
    throw Object.assign(new Error(`${label} revision is invalid`), {
      code: "invalid_journal_revision",
    });
  }
  return revision;
}

function replaceRecord(target, source) {
  for (const key of Object.keys(target)) delete target[key];
  Object.assign(target, source);
}

async function syncStateDirectory(directory, { openImpl = open } = {}) {
  const handle = await openImpl(directory, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function writeDurableAtomicFile(file, text, {
  mode = 0o600,
  noReplace = false,
  openImpl = open,
  renameImpl = rename,
  linkImpl = link,
  unlinkImpl = unlink,
  syncDirectoryImpl = syncStateDirectory,
} = {}) {
  const directory = dirname(file);
  const temporary = join(directory, `.${basename(file)}.${randomUUID()}.tmp`);
  let handle;
  let published = false;
  let temporaryPresent = false;
  let primaryError = null;
  try {
    handle = await openImpl(temporary, "wx", mode);
    temporaryPresent = true;
    await handle.writeFile(text);
    await handle.sync();
    await handle.close();
    handle = null;
    if (noReplace) {
      await linkImpl(temporary, file);
    } else {
      await renameImpl(temporary, file);
    }
    published = true;
    await syncDirectoryImpl(directory);
    if (noReplace) {
      await unlinkImpl(temporary);
      temporaryPresent = false;
      await syncDirectoryImpl(directory);
    }
  } catch (error) {
    primaryError = error;
    if (published && error && typeof error === "object") {
      error.atomicPublishCompleted = true;
      error.atomicPublishedPath = file;
    }
    throw error;
  } finally {
    try { await handle?.close(); } catch (closeError) {
      if (primaryError && typeof primaryError === "object") {
        primaryError.temporaryCloseError = closeError?.code || "temporary_close_failed";
      } else {
        throw closeError;
      }
    }
    if (temporaryPresent) {
      try {
        await unlinkImpl(temporary);
        await syncDirectoryImpl(directory);
      } catch (cleanupError) {
        if (cleanupError?.code === "ENOENT") {
          // The unique temporary was already removed; there is nothing left
          // whose cleanup could weaken the canonical publication boundary.
        } else if (primaryError && typeof primaryError === "object") {
          primaryError.temporaryCleanupError = cleanupError?.code || "temporary_cleanup_failed";
        } else {
          throw cleanupError;
        }
      }
    }
  }
  return file;
}

export async function resolveFailedLockAttachment({
  state,
  before,
  field,
  file,
  lockText,
  journal,
  mutexLease,
  error,
} = {}) {
  const ambiguous = (message, cause = error, details = {}) => Object.assign(new Error(message), {
    code: "lock_attachment_ambiguous",
    cause,
    preserveSourceJournal: true,
    executionLockPath: file,
    ...details,
  });
  if (typeof mutexLease?.unlinkExact !== "function") {
    throw ambiguous("Failed lock attachment has no kernel-held exact-unlink capability", error, {
      cleanupError: "state_release_mutex_lost",
    });
  }
  mutexLease?.assertAlive();
  let durable;
  try {
    durable = JSON.parse(await readFile(journal, "utf8"));
    await ownerOnlyStateFile(journal, "Reconciliation journal");
  } catch (readError) {
    throw ambiguous("Lock attachment may have reached durable state; reconciliation is required", readError);
  }
  const durableIsSource = sha256(durable) === sha256(before);
  if (durable?.[field] === file) {
    replaceRecord(state, durable);
    throw ambiguous("Lock was durably attached even though its writer reported failure");
  }
  if (!durableIsSource) {
    throw ambiguous("Lock attachment journal differs from both its source and attached target", error, {
      cleanupError: "reconciliation_journal_changed",
    });
  }
  let currentLockText;
  try {
    [currentLockText] = await Promise.all([
      readFile(file, "utf8"),
      ownerOnlyStateFile(file, "Execution lock"),
    ]);
  } catch (readError) {
    if (readError?.code === "ENOENT" && durable?.[field] !== file) {
      replaceRecord(state, before);
      return;
    }
    throw ambiguous("Claimed lock cannot be authenticated after attachment failure", readError);
  }
  if (currentLockText !== lockText) {
    throw ambiguous("Claimed lock generation changed during ambiguous attachment", error, {
      cleanupError: "lock_generation_mismatch",
    });
  }
  replaceRecord(state, before);
  try {
    await mutexLease?.unlinkExact(file, lockText);
    mutexLease?.assertAlive();
  } catch (cleanupError) {
    throw ambiguous("Failed lock attachment could not be rolled back exactly", cleanupError, {
      cleanupError: cleanupError?.code || "execution_lock_cleanup_failed",
    });
  }
}

export async function writeReconciliationJournal(value, {
  directory = journalDirectory,
  file = journalPath,
  mutexHeld = false,
  mutexLease,
  expectedRevision,
  targetRevision,
  releaseCapability,
  durableWriteImpl = writeDurableAtomicFile,
} = {}) {
  if (!mutexHeld) {
    return withStateReleaseMutex(directory, (lease) => writeReconciliationJournal(value, {
      directory,
      file,
      mutexHeld: true,
      mutexLease: lease,
      expectedRevision,
      targetRevision,
      releaseCapability,
      durableWriteImpl,
    }));
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw Object.assign(new Error("Reconciliation journal must be an object"), {
      code: "invalid_reconciliation_journal",
    });
  }
  mutexLease?.assertAlive();
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const expected = expectedRevision === undefined
    ? journalRevision(value)
    : journalRevision({ journalRevision: expectedRevision }, "Expected reconciliation journal");
  const target = targetRevision === undefined
    ? expected + 1
    : journalRevision({ journalRevision: targetRevision }, "Target reconciliation journal");
  if (!Number.isSafeInteger(target) || target !== expected + 1) {
    throw Object.assign(new Error("Reconciliation journal revision must advance exactly once"), {
      code: "invalid_journal_revision",
    });
  }
  await authorizeJournalWriteAgainstReleaseGuard({
    directory,
    file,
    value,
    expectedRevision: expected,
    targetRevision: target,
    releaseCapability,
    mutexLease,
  });
  let durableRevision = 0;
  let durableExists = true;
  let durableSourceHash = null;
  try {
    const durable = JSON.parse(await readFile(file, "utf8"));
    await ownerOnlyStateFile(file, "Reconciliation journal");
    durableRevision = journalRevision(durable);
    durableSourceHash = sha256(durable);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    durableExists = false;
  }
  if ((durableExists && durableRevision !== expected) || (!durableExists && expected !== 0)) {
    throw Object.assign(new Error("Reconciliation journal changed before this state update"), {
      code: "stale_journal_write",
      details: { expectedRevision: expected, durableRevision: durableExists ? durableRevision : null },
    });
  }
  const next = structuredClone(value);
  next.journalRevision = target;
  const nextText = `${JSON.stringify(next, null, 2)}\n`;
  mutexLease?.assertAlive();
  try {
    await durableWriteImpl(file, nextText, { mode: 0o600 });
  } catch (error) {
    let durableText = null;
    let durableReadError = null;
    try {
      [durableText] = await Promise.all([
        readFile(file, "utf8"),
        ownerOnlyStateFile(file, "Reconciliation journal"),
      ]);
    } catch (readError) {
      durableReadError = readError;
    }
    if (durableText === nextText) {
      replaceRecord(value, next);
      error.journalWriteReachedTarget = true;
      error.journalTargetRevision = target;
      try {
        await syncStateDirectory(directory);
      } catch (syncError) {
        error.journalDirectorySyncError = syncError?.code || "journal_directory_sync_failed";
      }
      throw error;
    }
    const durableStillSource = durableText != null && (() => {
      try {
        const parsed = JSON.parse(durableText);
        return journalRevision(parsed) === expected && sha256(parsed) === durableSourceHash;
      } catch { return false; }
    })();
    if (durableStillSource || (!durableExists && durableReadError?.code === "ENOENT")) throw error;
    throw Object.assign(new Error("Reconciliation journal differs from both the exact source and target after a failed write"), {
      code: "reconciliation_journal_write_ambiguous",
      cause: error,
      readError: durableReadError?.code || null,
      preserveSourceJournal: true,
    });
  }
  mutexLease?.assertAlive();
  replaceRecord(value, next);
  return file;
}

function usage() {
  return [
    "Usage:",
    "  node scripts/buyer-orchestrator.mjs open --origin https://conviction-bay.vercel.app --market <slug-or-id>",
    "    --side YES|NO --budget <pUSD> --max-price <price>",
    "    --payment-payer <X-Layer-address> --buyer-wallet <Polygon-trading-wallet>",
    "    --issuer-registry <issuers.json> [--trading-mode deposit-wallet|eoa] [--json]",
    "",
    "  node scripts/buyer-orchestrator.mjs close --origin https://conviction-bay.vercel.app --market <slug-or-id>",
    "    --side YES|NO --shares <whole-shares> --min-price <price>",
    "    --payment-payer <X-Layer-address> --seller-wallet <Polygon-deposit-wallet>",
    "    --source-proof <open-result-or-proof.json> --issuer-registry <issuers.json>",
    "    [--rationale <text>] [--json]",
    "",
    "  node scripts/buyer-orchestrator.mjs reconcile-close --journal <journey.json>",
    "    --issuer-registry <issuers.json> [--json]",
    "",
    "  node scripts/buyer-orchestrator.mjs reconcile-open --journal <journey.json>",
    "    --issuer-registry <issuers.json> [--json]",
    "",
    "  node scripts/buyer-orchestrator.mjs resume-close --journal <journey.json>",
    "    --issuer-registry <issuers.json> [--json]",
    "",
    "The program displays the exact service-payment challenge and requires `confirm payment`,",
    "then displays the final signed bounds and requires exactly one",
    "interactive `confirm live mode` before it can submit the Polygon order.",
  ].join("\n");
}

function normalizeOpenTradingMode(value) {
  const mode = String(value || "").trim().toLowerCase().replace(/_/g, "-");
  if (mode !== "deposit-wallet" && mode !== "eoa") {
    throw Object.assign(new Error("--trading-mode must be deposit-wallet or eoa"), { code: "invalid_argument" });
  }
  return mode;
}

export function parseArgs(argv) {
  const rest = [...argv];
  const command = rest.shift();
  const take = (name, required = true) => {
    const index = rest.indexOf(name);
    if (index < 0) {
      if (required) throw Object.assign(new Error(`${name} is required`), { code: "missing_argument" });
      return undefined;
    }
    if (!rest[index + 1] || rest[index + 1].startsWith("--")) {
      throw Object.assign(new Error(`${name} requires a value`), { code: "missing_argument" });
    }
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
  if (command === "reconcile-open" || command === "reconcile-close" || command === "resume-close") {
    const parsed = {
      command,
      journal: take("--journal"),
      issuerRegistry: take("--issuer-registry"),
      json: boolean("--json"),
    };
    if (rest.length) throw Object.assign(new Error(`Unknown arguments: ${rest.join(" ")}`), { code: "invalid_argument" });
    return parsed;
  }
  if (command !== "open" && command !== "close") {
    throw Object.assign(new Error(usage()), { code: "invalid_command" });
  }
  const service = command === "open" ? POSITION_CARD_SERVICE : POSITION_MANAGER_SERVICE;
  const common = {
    command,
    origin: requirePinnedServiceOrigin(take("--origin"), service),
    market: take("--market"),
    side: take("--side").toUpperCase(),
    paymentPayer: take("--payment-payer").toLowerCase(),
    issuerRegistry: take("--issuer-registry"),
    json: boolean("--json"),
  };
  const parsed = command === "open"
    ? {
        ...common,
        budget: take("--budget"),
        maxPrice: take("--max-price"),
        buyerWallet: take("--buyer-wallet").toLowerCase(),
        tradingMode: normalizeOpenTradingMode(take("--trading-mode", false) || "deposit-wallet"),
      }
    : {
        ...common,
        shares: take("--shares"),
        minPrice: take("--min-price"),
        sellerWallet: take("--seller-wallet").toLowerCase(),
        sourceProof: take("--source-proof"),
        rationale: take("--rationale", false) || "",
      };
  if (rest.length) throw Object.assign(new Error(`Unknown arguments: ${rest.join(" ")}`), { code: "invalid_argument" });
  return parsed;
}

export function parseJsonOutput(text, label) {
  const trimmed = String(text || "").trim();
  try {
    return JSON.parse(trimmed);
  } catch {}
  const lines = trimmed.split("\n").reverse();
  for (const line of lines) {
    try { return JSON.parse(line); } catch {}
  }
  throw Object.assign(new Error(`${label} did not return JSON`), { code: "invalid_tool_output" });
}

const ADDRESS_RE = /^0x[0-9a-f]{40}$/i;
const HASH_RE = /^0x[0-9a-f]{64}$/i;
const DECIMAL_UINT_RE = /^(?:0|[1-9][0-9]*)$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const EXECUTION_LOCK_PURPOSES = new Set([
  "OPEN_PLACE",
  "CLOSE_PLACE",
  "CLOSE_RESUME",
  "TP_PLACE",
  "TP_CANCEL",
]);
const AUTHORIZATION_STATE_SELECTOR = "e94a0102";

function asObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}

function firstObject(...values) {
  return values.find((value) => asObject(value)) || null;
}

function firstValue(...values) {
  return values.find((value) => value !== undefined && value !== null && value !== "");
}

/**
 * Accept the native runOpenJourney result/sourcePosition shape as well as the
 * historical public deliverable. The service independently replays the source
 * settlement from Polygon, so this function only normalizes transport shape.
 */
export function normalizeSourcePosition(document) {
  const input = asObject(document);
  if (!input) {
    throw Object.assign(new Error("Source proof file must contain a JSON object"), {
      code: "invalid_source_proof_file",
    });
  }
  const root = firstObject(input.response, input.result, input) || input;
  const direct = firstObject(
    root.sourcePosition,
    root.open?.sourcePosition,
    input.sourcePosition,
    input.open?.sourcePosition,
  );
  const intent = firstObject(
    direct?.intent,
    root.canonicalIntent,
    root.intent,
    root.positionPassport?.intent,
    input.canonicalIntent,
    input.intent,
    input.positionPassport?.intent,
    root.paidCard?.intent,
    input.paidCard?.intent,
  );
  const positionProof = firstObject(
    root.positionProof,
    root.positionPassport?.positionProof,
    root.verifiedPositionProof,
    input.positionProof,
    input.positionPassport?.positionProof,
    input.verifiedPositionProof,
  );
  const receiptProof = firstObject(
    root.receiptProof,
    root.positionPassport?.receiptProof,
    input.receiptProof,
    input.positionPassport?.receiptProof,
  );
  const hashes = firstObject(root.hashes, input.hashes) || {};
  const issuance = firstObject(
    direct?.issuance,
    root.issuance,
    root.positionPassport?.issuance,
    input.issuance,
    input.positionPassport?.issuance,
    root.paidCard?.issuance,
    input.paidCard?.issuance,
  );
  const normalized = {
    transactionHash: String(firstValue(
      direct?.transactionHash,
      positionProof?.transactionHash,
      receiptProof?.transactionHash,
      root.transactionHash,
      input.transactionHash,
      root.settlementTx,
      input.settlementTx,
    ) || "").toLowerCase(),
    orderId: String(firstValue(
      direct?.orderId,
      positionProof?.orderId,
      receiptProof?.orderId,
      root.orderId,
      input.orderId,
    ) || "").toLowerCase(),
    intentHash: String(firstValue(
      direct?.intentHash,
      positionProof?.intentHash,
      hashes.intentHash,
      root.intentHash,
      input.intentHash,
    ) || "").toLowerCase(),
    positionProofHash: String(firstValue(
      direct?.positionProofHash,
      root.positionProofHash,
      hashes.positionProofHash,
      root.verifiedPositionProof?.positionProofHash,
      input.positionProofHash,
      input.verifiedPositionProof?.positionProofHash,
    ) || "").toLowerCase(),
    intent,
    ...(issuance ? { issuance } : {}),
  };
  for (const field of ["transactionHash", "orderId", "intentHash", "positionProofHash"]) {
    if (!HASH_RE.test(normalized[field])) {
      throw Object.assign(new Error(`Source proof file has no valid ${field}`), {
        code: "invalid_source_proof_file",
      });
    }
  }
  if (!intent) {
    throw Object.assign(new Error("Source proof file has no canonical intent"), {
      code: "invalid_source_proof_file",
    });
  }
  return Object.freeze(normalized);
}

export function normalizeOpenOrders(input) {
  const root = input?.data ?? input;
  const orders = Array.isArray(root)
    ? root
    : Array.isArray(root?.orders)
      ? root.orders
      : Array.isArray(root?.results)
        ? root.results
        : Array.isArray(root?.data)
          ? root.data
          : null;
  if (!orders) {
    throw Object.assign(new Error("Polymarket open-orders response has an unknown shape"), {
      code: "invalid_tool_output",
    });
  }
  const active = new Set(["OPEN", "LIVE", "UNMATCHED", "ORDER_STATUS_OPEN", "ORDER_STATUS_LIVE", "ORDER_STATUS_UNMATCHED"]);
  const inactive = new Set(["MATCHED", "CANCELED", "CANCELLED", "EXPIRED", "ORDER_STATUS_MATCHED", "ORDER_STATUS_CANCELED", "ORDER_STATUS_CANCELLED", "ORDER_STATUS_EXPIRED"]);
  return orders.filter((order) => {
    const state = String(order?.status ?? order?.state ?? "").toUpperCase();
    if (active.has(state)) return true;
    if (inactive.has(state)) return false;
    throw Object.assign(new Error("Polymarket returned an order with an unknown status"), {
      code: "invalid_tool_output",
    });
  });
}

export function summarizeOpenSellReservations(input, outcomeTokenId) {
  const tokenId = String(outcomeTokenId || "");
  if (!/^(0|[1-9]\d*)$/.test(tokenId)) {
    throw Object.assign(new Error("Selected outcome token ID is invalid"), {
      code: "invalid_tool_output",
    });
  }

  let reservedSharesRaw = 0n;
  let openSellOrderCount = 0;
  for (const order of normalizeOpenOrders(input)) {
    const side = String(order?.side || "").toUpperCase();
    const orderTokenId = String(order?.token_id ?? order?.asset_id ?? "");
    if ((side !== "BUY" && side !== "SELL") || !/^(0|[1-9]\d*)$/.test(orderTokenId)) {
      throw Object.assign(new Error("Polymarket returned an open order with an invalid side or token"), {
        code: "invalid_tool_output",
      });
    }
    if (side !== "SELL" || orderTokenId !== tokenId) continue;

    try {
      const originalRaw = parsePolymarketShareAtoms(order?.original_size, "Open SELL original size", {
        code: "invalid_tool_output",
        positive: true,
      });
      const matchedRaw = parsePolymarketShareAtoms(order?.size_matched, "Open SELL matched size", {
        code: "invalid_tool_output",
      });
      if (matchedRaw > originalRaw) throw new Error("matched size exceeds original size");
      const remainingRaw = originalRaw - matchedRaw;
      if (remainingRaw > 0n) {
        openSellOrderCount += 1;
        reservedSharesRaw += remainingRaw;
      }
    } catch (error) {
      throw Object.assign(new Error("Polymarket returned an invalid matching open SELL order"), {
        code: "invalid_tool_output",
        cause: error,
      });
    }
  }

  return Object.freeze({
    openSellOrderCount,
    reservedSharesRaw: reservedSharesRaw.toString(),
  });
}

export function closeReplayKey({ request, sellerWallet }) {
  const sourceIntent = asObject(request?.sourcePosition?.intent);
  const conditionId = String(sourceIntent?.market?.conditionId || "").toLowerCase();
  const outcomeTokenId = String(
    sourceIntent?.market?.outcomeTokenId || sourceIntent?.order?.outcomeTokenId || "",
  );
  if (!HASH_RE.test(conditionId) || !/^\d+$/.test(outcomeTokenId)) {
    throw Object.assign(new Error("Close replay identity has no canonical condition and outcome token"), {
      code: "invalid_replay_identity",
    });
  }
  return sha256({
    version: "conviction-close-replay-v1",
    sellerWallet: String(sellerWallet || "").toLowerCase(),
    conditionId,
    outcomeTokenId,
    outcome: String(request?.outcome || request?.side || "").toUpperCase(),
    sharesRaw: parseDecimal(request?.shares, 6, "close replay shares").toString(),
    minPriceRaw: parseDecimal(request?.minPrice, 6, "close replay minimum price").toString(),
    sourceIntentHash: String(request?.sourcePosition?.intentHash || "").toLowerCase(),
    sourcePositionProofHash: String(request?.sourcePosition?.positionProofHash || "").toLowerCase(),
    sourceTransactionHash: String(request?.sourcePosition?.transactionHash || "").toLowerCase(),
    sourceOrderId: String(request?.sourcePosition?.orderId || "").toLowerCase(),
  });
}

export function openReplayKey({ request, buyerWallet }) {
  const market = String(request?.market || "").trim().toLowerCase();
  const outcome = String(request?.outcome || request?.side || "").toUpperCase();
  if (!market || (outcome !== "YES" && outcome !== "NO")) {
    throw Object.assign(new Error("Open replay identity has no canonical market and outcome"), {
      code: "invalid_replay_identity",
    });
  }
  return sha256({
    version: "conviction-open-replay-v1",
    buyerWallet: String(buyerWallet || "").toLowerCase(),
    market,
    outcome,
    budgetRaw: parseDecimal(request?.budget, 6, "open replay budget").toString(),
    maxPriceRaw: parseDecimal(request?.maxPrice, 6, "open replay maximum price").toString(),
  });
}

async function ownerOnlyStateFile(file, label, { statImpl = stat } = {}) {
  const linkStat = await lstat(file);
  if (linkStat.isSymbolicLink()) {
    throw Object.assign(new Error(`${label} must not be a symbolic link`), {
      code: "unsafe_state_symlink",
    });
  }
  const fileStat = statImpl === stat ? linkStat : await statImpl(file);
  const expectedUid = typeof process.getuid === "function" ? process.getuid() : null;
  if (!fileStat.isFile() || (fileStat.mode & 0o077) !== 0) {
    throw Object.assign(new Error(`${label} must be an owner-only regular file`), {
      code: "unsafe_state_permissions",
    });
  }
  if (expectedUid !== null && fileStat.uid !== expectedUid) {
    throw Object.assign(new Error(`${label} must belong to the current OS user`), {
      code: "unsafe_state_owner",
    });
  }
}

async function parsedJournalHash(file) {
  return sha256(JSON.parse(await readFile(file, "utf8")));
}

function validReleaseGuard(guard) {
  return guard?.version === "conviction-state-release-guard-v1" &&
    typeof guard?.journalPath === "string" && HASH_RE.test(String(guard?.sourceJournalHash || "")) &&
    HASH_RE.test(String(guard?.targetJournalHash || "")) &&
    HASH_RE.test(String(guard?.transitionId || "")) && Array.isArray(guard?.fields) &&
    guard.fields.length > 0 && guard.fields.every((field) =>
      field === "replayLockPath" || field === "executionLockPath" || field === "reservationLockPath") &&
    guard?.targetState && typeof guard.targetState === "object" && !Array.isArray(guard.targetState) &&
    sha256(guard.targetState) === guard.targetJournalHash &&
    guard?.lockHashes && typeof guard.lockHashes === "object" && !Array.isArray(guard.lockHashes) &&
    guard.fields.every((field) => guard.lockHashes[field] === null || HASH_RE.test(String(guard.lockHashes[field] || ""))) &&
    Number.isSafeInteger(guard?.pid) && guard.pid > 0 && Number.isFinite(Date.parse(String(guard?.claimedAt || "")));
}

async function resumableStateReleaseGuard({
  releaseFile,
  journal,
  sourceJournalHash,
  transitionId,
  fields,
  statImpl = stat,
}) {
  let text;
  try {
    [text] = await Promise.all([
      readFile(releaseFile, "utf8"),
      ownerOnlyStateFile(releaseFile, "State-release guard", { statImpl }),
    ]);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
  let guard;
  try { guard = JSON.parse(text); } catch { return null; }
  const canonicalFields = [...new Set(fields)].sort();
  if (
    !validReleaseGuard(guard) || guard.journalPath !== journal ||
    guard.sourceJournalHash !== sourceJournalHash || guard.transitionId !== transitionId ||
    sha256(guard.fields) !== sha256(canonicalFields)
  ) return null;
  let currentHash;
  try { currentHash = await parsedJournalHash(journal); } catch { return null; }
  return currentHash === sourceJournalHash ? Object.freeze({ guard, text }) : null;
}

/**
 * Every global/scoped lock claim observes the same release guard. A completed
 * guard left by a crashed process may be removed only when its exact target
 * journal hash is already durable; otherwise the exact transaction must resume.
 */
async function claimStateReleaseMutex({
  directory = journalDirectory,
  helper = releaseMutexHelper,
} = {}) {
  let helperStat;
  try { helperStat = await lstat(helper); } catch (error) {
    throw Object.assign(new Error("State-release mutex helper is unavailable"), {
      code: "state_release_mutex_failed",
      cause: error,
    });
  }
  const expectedUid = typeof process.getuid === "function" ? process.getuid() : null;
  if (helperStat.isSymbolicLink() || !helperStat.isFile() || (expectedUid !== null && helperStat.uid !== expectedUid)) {
    throw Object.assign(new Error("State-release mutex helper is not an owner-controlled regular file"), {
      code: "state_release_mutex_failed",
    });
  }
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const physicalDirectory = await realpath(directory);
  const mutexFile = join(tmpdir(), `conviction-state-release-${sha256(physicalDirectory).slice(2)}.mutex`);
  const child = spawn("python3", [helper, mutexFile, physicalDirectory], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdoutBuffer = "";
  let stderrText = "";
  let acquisitionSettled = false;
  let acquisitionResolve;
  let acquisitionReject;
  const pendingCommands = new Map();
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => { stderrText += chunk; });
  const acquired = new Promise((resolvePromise, rejectPromise) => {
    acquisitionResolve = resolvePromise;
    acquisitionReject = rejectPromise;
  });
  const rejectPending = (error) => {
    for (const { rejectPromise } of pendingCommands.values()) rejectPromise(error);
    pendingCommands.clear();
  };
  const settleAcquisition = (callback, value) => {
    if (acquisitionSettled) return;
    acquisitionSettled = true;
    callback(value);
  };
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdoutBuffer += chunk;
    while (stdoutBuffer.includes("\n")) {
      const newline = stdoutBuffer.indexOf("\n");
      const line = stdoutBuffer.slice(0, newline);
      stdoutBuffer = stdoutBuffer.slice(newline + 1);
      if (!acquisitionSettled) {
        if (line === "LOCKED") settleAcquisition(acquisitionResolve, true);
        else if (line === "BUSY") {
          settleAcquisition(acquisitionReject, Object.assign(
            new Error("Another state-lock reconciliation is already in progress"),
            { code: "execution_release_in_progress" },
          ));
        }
        continue;
      }
      let response;
      try { response = JSON.parse(line); } catch { continue; }
      const pending = pendingCommands.get(response?.id);
      if (!pending) continue;
      pendingCommands.delete(response.id);
      if (response.ok === true) pending.resolvePromise(response);
      else pending.rejectPromise(Object.assign(
        new Error(`State-release mutex exact unlink failed: ${String(response?.code || "unknown")}`),
        { code: String(response?.code || "exact_unlink_failed"), details: response },
      ));
    }
  });
  child.once("error", (error) => {
    settleAcquisition(acquisitionReject, error);
    rejectPending(Object.assign(new Error("State-release mutex helper failed during an exact operation"), {
      code: "state_release_mutex_lost",
      cause: error,
    }));
  });
  child.once("exit", (code) => {
    if (!acquisitionSettled) {
      const busy = code === 75;
      settleAcquisition(acquisitionReject, Object.assign(
        new Error(busy
          ? "Another state-lock reconciliation is already in progress"
          : `State-release mutex helper exited before locking${stderrText ? `: ${stderrText.trim()}` : ""}`),
        { code: busy ? "execution_release_in_progress" : "state_release_mutex_failed" },
      ));
    }
    rejectPending(Object.assign(new Error("State-release mutex helper exited during an exact operation"), {
      code: "state_release_mutex_lost",
    }));
  });
  await acquired;
  try {
    await ownerOnlyStateFile(mutexFile, "State-release mutex");
  } catch (validationError) {
    const exited = new Promise((resolvePromise) => {
      if (child.exitCode !== null || child.signalCode !== null) return resolvePromise();
      child.once("exit", () => resolvePromise());
      child.once("error", () => resolvePromise());
    });
    child.stdin.end();
    await exited;
    throw validationError;
  }
  let released = false;
  const assertAlive = () => {
    if (released || child.exitCode !== null || child.signalCode !== null || child.stdin.destroyed) {
      throw Object.assign(new Error("State-release mutex helper is no longer holding the kernel lock"), {
        code: "state_release_mutex_lost",
      });
    }
  };
  const command = (body) => {
    assertAlive();
    const id = randomUUID();
    return new Promise((resolvePromise, rejectPromise) => {
      pendingCommands.set(id, { resolvePromise, rejectPromise });
      child.stdin.write(`${JSON.stringify({ ...body, id })}\n`, (error) => {
        if (!error) return;
        pendingCommands.delete(id);
        rejectPromise(Object.assign(new Error("State-release mutex command could not be delivered"), {
          code: "state_release_mutex_lost",
          cause: error,
        }));
      });
    });
  };
  return Object.freeze({
    assertAlive,
    unlinkExact: async (file, expectedText) => {
      if (typeof expectedText !== "string") {
        throw Object.assign(new Error("Exact unlink requires the authenticated raw file bytes"), {
          code: "invalid_unlink_request",
        });
      }
      const canonical = safeStatePath(file, "lock", physicalDirectory);
      const response = await command({
        op: "unlink_exact",
        path: join(physicalDirectory, basename(canonical)),
        sha256: sha256(expectedText).slice(2),
      });
      assertAlive();
      return response.removed === true;
    },
    release: async () => {
      if (released) return;
      assertAlive();
      released = true;
      const exited = new Promise((resolvePromise, rejectPromise) => {
        child.once("error", rejectPromise);
        child.once("exit", (code) => code === 0
          ? resolvePromise()
          : rejectPromise(Object.assign(new Error("State-release mutex helper exited abnormally"), {
              code: "state_release_mutex_failed",
            })));
      });
      child.stdin.end();
      await exited;
    },
  });
}

export async function withStateReleaseMutex(directory, callback, { helper = releaseMutexHelper } = {}) {
  const lease = await claimStateReleaseMutex({ directory, helper });
  let callbackError;
  try {
    return await callback(lease);
  } catch (error) {
    callbackError = error;
    throw error;
  } finally {
    try {
      await lease.release();
    } catch (releaseError) {
      if (callbackError && typeof callbackError === "object") {
        callbackError.mutexReleaseError = releaseError?.code || "state_release_mutex_failed";
      } else {
        throw releaseError;
      }
    }
  }
}

export async function assertNoStateReleaseInProgress({
  directory = journalDirectory,
  releaseFile = join(directory, releaseLockBasename),
  statImpl = stat,
  mutexHeld = false,
  mutexLease,
} = {}) {
  if (!mutexHeld) {
    return withStateReleaseMutex(directory, (lease) => assertNoStateReleaseInProgress({
      directory,
      releaseFile,
      statImpl,
      mutexHeld: true,
      mutexLease: lease,
    }));
  }
  let text;
  try {
    [text] = await Promise.all([
      readFile(releaseFile, "utf8"),
      ownerOnlyStateFile(releaseFile, "State-release guard", { statImpl }),
    ]);
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
  let guard;
  try { guard = JSON.parse(text); } catch {}
  if (validReleaseGuard(guard)) {
    let currentHash = null;
    try { currentHash = await parsedJournalHash(guard.journalPath); } catch {}
    if (currentHash === guard.targetJournalHash) {
      const unchanged = await readFile(releaseFile, "utf8");
      if (unchanged !== text) {
        throw Object.assign(new Error("State-release guard changed during completed-release recovery"), {
          code: "state_release_guard_mismatch",
        });
      }
      if (!mutexLease?.unlinkExact) {
        throw Object.assign(new Error("Completed release guard requires its kernel-held exact unlink"), {
          code: "state_release_mutex_lost",
        });
      }
      await mutexLease.unlinkExact(releaseFile, text);
      return false;
    }
  }
  throw Object.assign(
    new Error("A Conviction state-lock release is in progress; retry only after reconciliation finishes"),
    { code: "execution_release_in_progress", details: { executionReleaseLockPath: releaseFile } },
  );
}

async function authorizeJournalWriteAgainstReleaseGuard({
  directory,
  file,
  value,
  expectedRevision,
  targetRevision,
  releaseCapability,
  mutexLease,
  statImpl = stat,
} = {}) {
  mutexLease?.assertAlive();
  if (releaseCapability === undefined) {
    await assertNoStateReleaseInProgress({ directory, mutexHeld: true, statImpl, mutexLease });
    mutexLease?.assertAlive();
    return;
  }
  if (
    !releaseCapability || typeof releaseCapability !== "object" ||
    !releaseJournalWriteCapabilities.has(releaseCapability)
  ) {
    throw Object.assign(new Error("Journal write has no valid internal release capability"), {
      code: "state_release_guard_mismatch",
    });
  }
  const releaseFile = join(directory, releaseLockBasename);
  let guardText;
  try {
    [guardText] = await Promise.all([
      readFile(releaseFile, "utf8"),
      ownerOnlyStateFile(releaseFile, "State-release guard", { statImpl }),
    ]);
  } catch (error) {
    throw Object.assign(new Error("Guarded journal write cannot authenticate its release guard"), {
      code: "state_release_guard_mismatch",
      cause: error,
    });
  }
  let guard;
  try { guard = JSON.parse(guardText); } catch {}
  const projected = structuredClone(value);
  projected.journalRevision = targetRevision;
  const canonicalFields = Array.isArray(guard?.fields) ? [...new Set(guard.fields)].sort() : [];
  const exactCapability =
    releaseCapability.releaseFile === releaseFile &&
    releaseCapability.guardText === guardText &&
    releaseCapability.journalPath === file &&
    releaseCapability.sourceJournalHash === guard?.sourceJournalHash &&
    releaseCapability.targetJournalHash === guard?.targetJournalHash &&
    releaseCapability.transitionId === guard?.transitionId &&
    releaseCapability.fieldsHash === sha256(canonicalFields) &&
    releaseCapability.lockHashesHash === sha256(guard?.lockHashes) &&
    releaseCapability.targetStateHash === sha256(guard?.targetState);
  if (
    !validReleaseGuard(guard) || !exactCapability || guard.journalPath !== file ||
    sha256(guard.fields) !== sha256(canonicalFields) ||
    sha256(projected) !== guard.targetJournalHash ||
    sha256(projected) !== sha256(guard.targetState) ||
    journalRevision(guard.targetState) !== targetRevision
  ) {
    throw Object.assign(new Error("Guarded journal write differs from its exact release transaction"), {
      code: "state_release_guard_mismatch",
    });
  }
  const durable = JSON.parse(await readFile(file, "utf8"));
  await ownerOnlyStateFile(file, "Reconciliation journal", { statImpl });
  if (
    sha256(durable) !== guard.sourceJournalHash ||
    journalRevision(durable) !== expectedRevision || targetRevision !== expectedRevision + 1
  ) {
    throw Object.assign(new Error("Guarded journal source differs from its exact release transaction"), {
      code: "reconciliation_journal_changed",
    });
  }
  mutexLease?.assertAlive();
  releaseJournalWriteCapabilities.delete(releaseCapability);
}

async function claimStateReleaseGuard({
  journal,
  stateDirectory,
  sourceJournalHash,
  targetJournalHash,
  targetState,
  transitionId,
  fields,
  lockHashes,
  now = Date.now,
  statImpl = stat,
  assertMutexAlive = () => {},
  unlinkExact,
  durablePublishImpl = writeDurableAtomicFile,
} = {}) {
  const releaseFile = join(stateDirectory, releaseLockBasename);
  const canonicalFields = [...new Set(fields)].sort();
  const guard = {
    version: "conviction-state-release-guard-v1",
    journalPath: journal,
    sourceJournalHash,
    targetJournalHash,
    targetState,
    transitionId,
    fields: canonicalFields,
    lockHashes,
    pid: process.pid,
    claimedAt: new Date(typeof now === "function" ? now() : now).toISOString(),
  };
  let guardText;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      assertMutexAlive();
      guardText = `${JSON.stringify(guard, null, 2)}\n`;
      await durablePublishImpl(releaseFile, guardText, { mode: 0o600, noReplace: true });
      break;
    } catch (error) {
      if (error?.code !== "EEXIST") {
        let exactPublished = false;
        let provenAbsent = false;
        try {
          const [existingText] = await Promise.all([
            readFile(releaseFile, "utf8"),
            ownerOnlyStateFile(releaseFile, "State-release guard", { statImpl }),
          ]);
          exactPublished = existingText === guardText;
          if (exactPublished) await syncStateDirectory(stateDirectory);
        } catch (probeError) {
          exactPublished = false;
          provenAbsent = probeError?.code === "ENOENT";
        }
        if (exactPublished) {
          error.releaseGuardRetained = true;
          throw error;
        }
        if (provenAbsent) throw error;
        throw Object.assign(new Error("State-release guard publication is ambiguous"), {
          code: "state_release_guard_ambiguous",
          cause: error,
          releaseGuardRetained: true,
        });
      }
      let existingText;
      try {
        [existingText] = await Promise.all([
          readFile(releaseFile, "utf8"),
          ownerOnlyStateFile(releaseFile, "State-release guard", { statImpl }),
        ]);
      } catch (readError) {
        if (readError?.code === "ENOENT" && attempt === 0) continue;
        throw readError;
      }
      let existing;
      try { existing = JSON.parse(existingText); } catch {}
      if (
        !validReleaseGuard(existing) || existing.journalPath !== journal ||
        existing.sourceJournalHash !== sourceJournalHash ||
        existing.targetJournalHash !== targetJournalHash ||
        existing.transitionId !== transitionId ||
        sha256(existing.fields) !== sha256(canonicalFields) ||
        sha256(existing.lockHashes) !== sha256(lockHashes) ||
        sha256(existing.targetState) !== sha256(targetState)
      ) {
        throw Object.assign(new Error("Existing state-release guard belongs to another reconciliation"), {
          code: "state_release_guard_mismatch",
        });
      }
      let currentHash;
      try { currentHash = await parsedJournalHash(journal); } catch {
        throw Object.assign(new Error("Guarded reconciliation journal cannot be authenticated"), {
          code: "reconciliation_journal_changed",
        });
      }
      if (currentHash !== existing.sourceJournalHash && currentHash !== existing.targetJournalHash) {
        throw Object.assign(new Error("Guarded reconciliation journal differs from both durable release states"), {
          code: "reconciliation_journal_changed",
        });
      }
      const unchanged = await readFile(releaseFile, "utf8");
      if (unchanged !== existingText) {
        throw Object.assign(new Error("State-release guard changed during stale-owner recovery"), {
          code: "state_release_guard_mismatch",
        });
      }
      await syncStateDirectory(stateDirectory);
      assertMutexAlive();
      guardText = existingText;
      break;
    }
  }
  const writeCapability = Object.freeze({
    releaseFile,
    guardText,
    journalPath: journal,
    sourceJournalHash,
    targetJournalHash,
    targetStateHash: sha256(targetState),
    transitionId,
    fieldsHash: sha256(canonicalFields),
    lockHashesHash: sha256(lockHashes),
  });
  releaseJournalWriteCapabilities.add(writeCapability);
  return Object.freeze({
    writeCapability,
    release: async () => {
      let currentText;
      try { currentText = await readFile(releaseFile, "utf8"); } catch {
        throw Object.assign(new Error("State-release guard disappeared before durable completion"), {
          code: "state_release_guard_mismatch",
        });
      }
      if (currentText !== guardText) {
        throw Object.assign(new Error("State-release guard generation changed before completion"), {
          code: "state_release_guard_mismatch",
        });
      }
      assertMutexAlive();
      if (typeof unlinkExact !== "function") {
        throw Object.assign(new Error("State-release guard requires its kernel-held exact unlink"), {
          code: "state_release_mutex_lost",
        });
      }
      await unlinkExact(releaseFile, guardText);
      assertMutexAlive();
    },
  });
}

async function claimReplayLock({
  key,
  journal,
  directory,
  kind,
  state,
  writeState = writeReconciliationJournal,
  transition,
  beforePersist,
}) {
  const isOpen = kind === "open";
  const file = join(directory, `${kind}-${String(key).slice(2)}.lock.json`);
  const releaseFile = join(directory, releaseLockBasename);
  return withStateReleaseMutex(directory, async (mutexLease) => {
    await assertNoStateReleaseInProgress({ directory, releaseFile, mutexHeld: true, mutexLease });
    if (state && resolve(String(state.journalPath || "")) !== resolve(journal)) {
      throw Object.assign(new Error(`${kind.toUpperCase()} replay state belongs to another journal`), {
        code: "lock_ownership_mismatch",
      });
    }
    if (state && await parsedJournalHash(journal) !== sha256(state)) {
      throw Object.assign(new Error(`${kind.toUpperCase()} replay state is stale before lock claim`), {
        code: "stale_journal_write",
      });
    }
    const lock = {
      version: isOpen ? "conviction-open-replay-lock-v1" : "conviction-close-replay-lock-v1",
      generation: randomUUID(),
      replayKey: key,
      journalPath: journal,
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
        throw Object.assign(
          new Error(`This exact ${kind.toUpperCase()} request was already claimed; reconcile its journal before any retry`),
          { code: `${kind}_replay_blocked`, details: { replayLockPath: file } },
        );
      }
      throw error;
    } finally {
      await handle?.close();
    }
    if (state) {
      const before = structuredClone(state);
      try {
        await beforePersist?.(Object.freeze({ file, lock: Object.freeze({ ...lock }) }));
        state.replayLockPath = file;
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
          field: "replayLockPath",
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

export async function claimCloseReplayLock({
  key,
  journal,
  directory = journalDirectory,
  state,
  writeState,
  transition,
  beforePersist,
} = {}) {
  if (!HASH_RE.test(String(key || ""))) {
    throw Object.assign(new Error("Close replay key is invalid"), { code: "invalid_replay_key" });
  }
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  return claimReplayLock({ key, journal, directory, kind: "close", state, writeState, transition, beforePersist });
}

export async function claimOpenReplayLock({
  key,
  journal,
  directory = journalDirectory,
  state,
  writeState,
  transition,
  beforePersist,
} = {}) {
  if (!HASH_RE.test(String(key || ""))) {
    throw Object.assign(new Error("Open replay key is invalid"), { code: "invalid_replay_key" });
  }
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  return claimReplayLock({ key, journal, directory, kind: "open", state, writeState, transition, beforePersist });
}

export async function claimExecutionLock({
  journal,
  directory = journalDirectory,
  file = executionLockFile,
  releaseFile = join(directory, "polymarket-execution.release.lock.json"),
  state,
  purpose,
  recoveryNotBefore,
  writeState = writeReconciliationJournal,
  transition,
  beforePersist,
  now = Date.now,
  durablePublishImpl = writeDurableAtomicFile,
} = {}) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  return withStateReleaseMutex(directory, async (mutexLease) => {
    await assertNoStateReleaseInProgress({ directory, releaseFile, mutexHeld: true, mutexLease });
    const canonicalFile = safeStatePath(file, "execution lock", directory);
    const canonicalJournal = safeStatePath(journal, "journal", directory);
    if (!state || typeof state !== "object" || Array.isArray(state)) {
      throw Object.assign(new Error("A v2 execution lock requires its durable attachment state"), {
        code: "missing_execution_lock_state",
      });
    }
    if (!EXECUTION_LOCK_PURPOSES.has(purpose)) {
      throw Object.assign(new Error("Execution-lock purpose is invalid"), { code: "invalid_execution_lock_purpose" });
    }
    const recoveryAt = Date.parse(String(recoveryNotBefore || ""));
    if (!Number.isFinite(recoveryAt) || new Date(recoveryAt).toISOString() !== recoveryNotBefore) {
      throw Object.assign(new Error("Execution-lock recovery boundary is invalid"), {
        code: "invalid_execution_lock_boundary",
      });
    }
    if (state && resolve(String(state.journalPath || "")) !== canonicalJournal) {
      throw Object.assign(new Error("Execution-lock state belongs to another journal"), {
        code: "lock_ownership_mismatch",
      });
    }
    const [durableText] = await Promise.all([
      readFile(canonicalJournal, "utf8"),
      ownerOnlyStateFile(canonicalJournal, "Reconciliation journal"),
    ]);
    const durable = JSON.parse(durableText);
    const sourceJournalHash = sha256(durable);
    const sourceJournalRevision = journalRevision(durable);
    if (state && sourceJournalHash !== sha256(state)) {
      throw Object.assign(new Error("Execution state is stale before lock claim"), {
        code: "stale_journal_write",
      });
    }
    if (
      durable?.executionLockPath != null || durable?.executionLockGeneration != null ||
      durable?.executionLockHash != null || durable?.executionLockPurpose != null ||
      durable?.executionLockRecoveryNotBefore != null
    ) {
      throw Object.assign(new Error("Execution journal already has a global lock binding"), {
        code: "execution_reconciliation_required",
      });
    }
    const claimedAtMs = Number(typeof now === "function" ? now() : now);
    if (!Number.isFinite(claimedAtMs) || claimedAtMs >= recoveryAt) {
      throw Object.assign(new Error("Execution-lock recovery boundary has already elapsed"), {
        code: "execution_lock_boundary_elapsed",
      });
    }
    const lock = {
      version: "conviction-polymarket-execution-lock-v2",
      generation: randomUUID(),
      pid: process.pid,
      journalPath: canonicalJournal,
      sourceJournalHash,
      sourceJournalRevision,
      purpose,
      attachmentRequired: true,
      claimedAt: new Date(claimedAtMs).toISOString(),
      recoveryNotBefore,
    };
    const lockText = `${JSON.stringify(lock, null, 2)}\n`;
    try {
      mutexLease.assertAlive();
      await durablePublishImpl(canonicalFile, lockText, { mode: 0o600, noReplace: true });
    } catch (error) {
      if (error?.code === "EEXIST") {
        let exactCrashOrphan = false;
        try {
          const [existingText] = await Promise.all([
            readFile(canonicalFile, "utf8"),
            ownerOnlyStateFile(canonicalFile, "Execution lock"),
          ]);
          const existing = JSON.parse(existingText);
          exactCrashOrphan = existing?.version === "conviction-polymarket-execution-lock-v2" &&
            existing?.attachmentRequired === true && existing?.journalPath === canonicalJournal &&
            existing?.sourceJournalHash === sourceJournalHash &&
            existing?.sourceJournalRevision === sourceJournalRevision;
        } catch {}
        throw Object.assign(
          new Error("Another Conviction execution is unresolved; reconcile its journal before trading"),
          {
            code: "execution_reconciliation_required",
            details: { executionLockPath: canonicalFile },
            ...(exactCrashOrphan ? { preserveSourceJournal: true } : {}),
          },
        );
      }
      let publishedProbe = null;
      try {
        const publishedText = await readFile(canonicalFile, "utf8");
        await ownerOnlyStateFile(canonicalFile, "Execution lock");
        publishedProbe = publishedText === lockText ? "exact" : "different";
      } catch (probeError) {
        if (probeError?.code !== "ENOENT") publishedProbe = "ambiguous";
      }
      if (error?.atomicPublishCompleted === true || publishedProbe !== null) {
        let cleanupError;
        try {
          const publishedText = await readFile(canonicalFile, "utf8");
          await ownerOnlyStateFile(canonicalFile, "Execution lock");
          if (publishedText !== lockText) {
            throw Object.assign(new Error("Published execution-lock generation changed"), {
              code: "lock_generation_mismatch",
            });
          }
          await mutexLease.unlinkExact(canonicalFile, publishedText);
          mutexLease.assertAlive();
        } catch (cleanupFailure) {
          cleanupError = cleanupFailure;
        }
        if (!cleanupError) {
          throw Object.assign(new Error("Execution-lock publication did not reach its durability boundary"), {
            code: "execution_lock_publish_failed",
            cause: error,
          });
        }
        throw Object.assign(new Error("Published execution lock could not be safely rolled back"), {
          code: "lock_attachment_ambiguous",
          cause: error,
          cleanupError: cleanupError?.code || "execution_lock_cleanup_failed",
          preserveSourceJournal: true,
          executionLockPath: canonicalFile,
          executionLockHash: sha256(lock),
        });
      }
      throw error;
    }
    if (state) {
      const before = structuredClone(state);
      const lockHash = sha256(lock);
      try {
        await beforePersist?.(Object.freeze({
          file: canonicalFile,
          lock: Object.freeze({ ...lock }),
          lockHash,
        }));
        state.executionLockPath = canonicalFile;
        state.executionLockGeneration = lock.generation;
        state.executionLockHash = lockHash;
        state.executionLockPurpose = purpose;
        state.executionLockRecoveryNotBefore = recoveryNotBefore;
        await transition?.(state, {
          lockPath: canonicalFile,
          lock: Object.freeze({ ...lock }),
          lockHash,
        });
        await writeState(state, {
          directory,
          file: canonicalJournal,
          mutexHeld: true,
          mutexLease,
        });
      } catch (error) {
        await resolveFailedLockAttachment({
          state,
          before,
          field: "executionLockPath",
          file: canonicalFile,
          lockText,
          journal: canonicalJournal,
          mutexLease,
          error,
        });
        throw error;
      }
    }
    return canonicalFile;
  });
}

function requireUnattachedExecutionCheckpoint(durable, lock, {
  canonicalFile,
  canonicalJournal,
  expectedJournalHash,
  expectedPurposes,
} = {}) {
  const allowedPurposes = new Set(Array.isArray(expectedPurposes) ? expectedPurposes : []);
  const noAttachedBinding = durable?.executionLockPath == null &&
    durable?.executionLockGeneration == null && durable?.executionLockHash == null &&
    durable?.executionLockPurpose == null && durable?.executionLockRecoveryNotBefore == null;
  const paidConfirmed = durable?.stage === "trade_confirmed" &&
    durable?.reconciliationRequired === true && durable?.tradeConsent && durable?.paidCard &&
    durable?.paymentProof && HASH_RE.test(String(durable?.paymentTx || "")) &&
    HASH_RE.test(String(durable?.replayKey || "")) &&
    durable?.executionArgv == null && durable?.executionArgvHash == null &&
    durable?.executionAttemptedAt == null && durable?.liveResult == null &&
    durable?.orderId == null && durable?.settlementTx == null;
  const purposeSpecific = lock?.purpose === "OPEN_PLACE"
    ? durable?.mode === "open" && typeof durable?.replayLockPath === "string" &&
      durable?.tradeConsent?.version === "conviction-open-trade-consent-v1" &&
      lock?.recoveryNotBefore === durable.tradeConsent.expiresAt && durable?.executionAttempted !== true
    : lock?.purpose === "CLOSE_PLACE" || lock?.purpose === "CLOSE_RESUME"
      ? durable?.mode === "close" && typeof durable?.replayLockPath === "string" &&
        durable?.tradeConsent?.version === "conviction-close-trade-consent-v1" &&
        lock?.recoveryNotBefore === durable.tradeConsent.expiresAt && durable?.executionAttempted !== true
      : lock?.purpose === "TP_PLACE"
        ? durable?.version === "conviction-take-profit-journey-v1" && durable?.action === "TAKE_PROFIT" &&
          typeof durable?.reservationLockPath === "string" && durable?.executionAttempted === false &&
          durable?.takeProfitPassport == null && durable?.takeProfitPassportHash == null &&
          durable?.restingOrderProofHash == null &&
          lock?.recoveryNotBefore === durable?.tradeConsent?.placementExpiresAt
      : lock?.purpose === "TP_CANCEL"
          ? durable?.version === "conviction-take-profit-journey-v1" && durable?.action === "TAKE_PROFIT" &&
            new Set(["armed", "submitted"]).has(durable?.stage) &&
            typeof durable?.reservationLockPath === "string" && HASH_RE.test(String(durable?.orderId || "")) &&
            HASH_RE.test(String(durable?.takeProfitPassportHash || "")) &&
            HASH_RE.test(String(durable?.restingOrderProofHash || "")) &&
            (durable?.cancelExecution == null
              ? durable?.cancelConsent == null && durable?.cancelAttemptedAt == null &&
                durable?.cancelResult == null && durable?.cancelOutcome == null
              : durable.cancelExecution?.version === "conviction-take-profit-cancel-execution-v2" &&
                new Set(["expired_unattempted", "pre_spawn_failed"]).has(durable.cancelExecution.phase) &&
                durable?.cancelConsent?.version === "conviction-take-profit-cancel-consent-v2" &&
                durable?.reconciliationRequired === false)
          : false;
  const sourceMatches = HASH_RE.test(String(expectedJournalHash || "")) &&
    sha256(durable) === expectedJournalHash && lock?.sourceJournalHash === expectedJournalHash &&
    lock?.sourceJournalRevision === journalRevision(durable);
  if (
    basename(canonicalFile) !== "polymarket-execution.lock.json" || durable?.journalPath !== canonicalJournal ||
    !noAttachedBinding || !allowedPurposes.has(lock?.purpose) || !sourceMatches || !purposeSpecific ||
    (lock?.purpose !== "TP_CANCEL" && !paidConfirmed)
  ) {
    throw Object.assign(new Error("Journal is not the exact purpose-bound preclaim execution checkpoint"), {
      code: "unsafe_unattached_lock_recovery",
    });
  }
}

/**
 * Recover the sole crash window between creating the global execution lock
 * and durably attaching it to a paid, confirmed journey. This performs no
 * network, payment, or order operation. It can remove only the exact
 * owner-only generation whose journal pointer and unchanged durable source
 * both identify the supplied never-started journey.
 */
export async function reconcileUnattachedExecutionLock({
  file,
  journal,
  directory = journalDirectory,
  expectedJournalHash,
  expectedPurposes,
  unlinkImpl = unlink,
  statImpl = stat,
  beforeUnlink,
} = {}) {
  return withStateReleaseMutex(directory, async (mutexLease) => {
    await assertNoStateReleaseInProgress({ directory, mutexHeld: true, mutexLease });
    const canonicalFile = safeStatePath(file, "execution lock", directory);
    const canonicalJournal = safeStatePath(journal, "journal", directory);
    let lockText;
    const [durableText] = await Promise.all([
      readFile(canonicalJournal, "utf8"),
      ownerOnlyStateFile(canonicalJournal, "Reconciliation journal", { statImpl }),
    ]);
    try {
      [lockText] = await Promise.all([
        readFile(canonicalFile, "utf8"),
        ownerOnlyStateFile(canonicalFile, "Execution lock", { statImpl }),
      ]);
    } catch (error) {
      if (error?.code === "ENOENT") {
        return Object.freeze({ released: false, path: canonicalFile, generationHash: null });
      }
      throw error;
    }
    const lock = JSON.parse(lockText);
    const durable = JSON.parse(durableText);
    if (
      lock?.version !== "conviction-polymarket-execution-lock-v2" || lock?.attachmentRequired !== true ||
      !UUID_RE.test(String(lock?.generation || "")) ||
      !Number.isSafeInteger(lock?.pid) || lock.pid <= 0 ||
      !HASH_RE.test(String(lock?.sourceJournalHash || "")) ||
      !Number.isSafeInteger(lock?.sourceJournalRevision) || lock.sourceJournalRevision < 0 ||
      !EXECUTION_LOCK_PURPOSES.has(lock?.purpose) ||
      !Number.isFinite(Date.parse(String(lock?.claimedAt || ""))) ||
      new Date(Date.parse(lock.claimedAt)).toISOString() !== lock.claimedAt ||
      !Number.isFinite(Date.parse(String(lock?.recoveryNotBefore || ""))) ||
      new Date(Date.parse(lock.recoveryNotBefore)).toISOString() !== lock.recoveryNotBefore ||
      Date.parse(lock.claimedAt) >= Date.parse(lock.recoveryNotBefore)
    ) {
      throw Object.assign(new Error("Unattached execution lock belongs to another journey"), {
        code: "lock_ownership_mismatch",
      });
    }
    let lockJournalPath;
    try { lockJournalPath = safeStatePath(lock.journalPath, "journal", directory); } catch {}
    if (!lockJournalPath) {
      throw Object.assign(new Error("Unattached execution lock has an unsafe owner journal"), {
        code: "lock_ownership_mismatch",
      });
    }
    if (lockJournalPath !== canonicalJournal) {
      return Object.freeze({
        released: false,
        path: canonicalFile,
        generationHash: sha256(lock),
        ownedByOtherJourney: true,
        ownerJournalPath: lockJournalPath,
      });
    }
    requireUnattachedExecutionCheckpoint(durable, lock, {
      canonicalFile,
      canonicalJournal,
      expectedJournalHash,
      expectedPurposes,
    });
    const generationHash = sha256(lock);
    await beforeUnlink?.(Object.freeze({
      path: canonicalFile,
      journalPath: canonicalJournal,
      generationHash,
      journalHash: expectedJournalHash,
    }));
    mutexLease.assertAlive();
    await Promise.all([
      ownerOnlyStateFile(canonicalFile, "Execution lock", { statImpl }),
      ownerOnlyStateFile(canonicalJournal, "Reconciliation journal", { statImpl }),
    ]);
    const [currentLockText, currentDurableText] = await Promise.all([
      readFile(canonicalFile, "utf8"),
      readFile(canonicalJournal, "utf8"),
    ]);
    if (currentLockText !== lockText) {
      throw Object.assign(new Error("Unattached execution-lock generation changed before cleanup"), {
        code: "lock_generation_mismatch",
      });
    }
    if (currentDurableText !== durableText || sha256(JSON.parse(currentDurableText)) !== expectedJournalHash) {
      throw Object.assign(new Error("Unattached execution-lock journal changed before cleanup"), {
        code: "reconciliation_journal_changed",
      });
    }
    mutexLease.assertAlive();
    await mutexLease.unlinkExact(canonicalFile, currentLockText);
    mutexLease.assertAlive();
    return Object.freeze({ released: true, path: canonicalFile, generationHash });
  });
}

export async function settleExecutionLock(
  state,
  {
    liveAttempted,
    proofVerified,
    unlinkImpl = unlink,
    now = Date.now(),
    journal = state?.journalPath,
    stateDirectory = journal ? dirname(journal) : journalDirectory,
    writeState = writeReconciliationJournal,
    transition,
    transitionId = "execution-lock-settlement-v1",
    expectedLockHashes,
  } = {},
) {
  if (!state?.executionLockPath) return { released: false, retained: false };
  if (liveAttempted && !proofVerified) {
    return { released: false, retained: true, path: state.executionLockPath };
  }
  if (!liveAttempted && (
    state?.executionAttempted === true || state?.executionAttemptedAt != null ||
    state?.executionArgv != null || state?.executionArgvHash != null
  )) {
    return { released: false, retained: true, path: state.executionLockPath };
  }
  if (!journal) {
    throw Object.assign(new Error("Execution lock cannot be released without its durable journal"), {
      code: "invalid_reconciliation_journal",
    });
  }
  const releasedPath = state.executionLockPath;
  const released = await releaseReconciledLocks(state, {
    stateDirectory,
    journal,
    fields: ["executionLockPath"],
    unlinkImpl,
    writeState,
    now,
    transition,
    transitionId,
    expectedLockHashes,
  });
  return {
    released: released.includes(releasedPath),
    retained: Boolean(state.executionLockPath),
    path: releasedPath,
  };
}

export async function markExecutionAttempted(
  state,
  {
    journal = state?.journalPath,
    stateDirectory = journal ? dirname(journal) : journalDirectory,
    purpose,
    recoveryNotBefore,
    argv,
    stage = "execution_attempted",
    now = Date.now,
    writeState = writeReconciliationJournal,
    transition,
  } = {},
) {
  return withStateReleaseMutex(stateDirectory, async (mutexLease) => {
    await assertNoStateReleaseInProgress({ directory: stateDirectory, mutexHeld: true, mutexLease });
    const canonicalJournal = safeStatePath(journal, "journal", stateDirectory);
    await ownerOnlyStateFile(canonicalJournal, "Reconciliation journal");
    const durable = JSON.parse(await readFile(canonicalJournal, "utf8"));
    if (sha256(durable) !== sha256(state)) {
      throw Object.assign(new Error("Execution checkpoint changed before its attempt marker"), {
        code: "stale_journal_write",
      });
    }
    if (
      !EXECUTION_LOCK_PURPOSES.has(purpose) || state?.executionLockPurpose !== purpose ||
      state?.executionLockRecoveryNotBefore !== recoveryNotBefore ||
      !Array.isArray(argv) || argv.length === 0 || argv.some((value) => typeof value !== "string") ||
      !state?.executionLockPath || !HASH_RE.test(String(state?.executionLockHash || ""))
    ) {
      throw Object.assign(new Error("Execution attempt does not match its attached v2 lock"), {
        code: "lock_ownership_mismatch",
      });
    }
    await verifyJournalLockOwnership(state, {
      stateDirectory,
      journal: canonicalJournal,
      fields: ["executionLockPath"],
      requirePresent: true,
    });
    const observedAt = Number(typeof now === "function" ? now() : now);
    const deadline = Date.parse(String(recoveryNotBefore || ""));
    if (!Number.isFinite(observedAt) || !Number.isFinite(deadline) || observedAt >= deadline) {
      throw Object.assign(new Error("Signed execution window elapsed before the durable attempt marker"), {
        code: "execution_lock_boundary_elapsed",
      });
    }
    const next = structuredClone(state);
    next.stage = stage;
    next.executionArgv = [...argv];
    next.executionArgvHash = sha256(argv);
    next.executionAttemptedAt = new Date(observedAt).toISOString();
    next.reconciliationRequired = true;
    await transition?.(next, { attemptedAt: next.executionAttemptedAt, argvHash: next.executionArgvHash });
    mutexLease.assertAlive();
    try {
      await writeState(next, {
        directory: stateDirectory,
        file: canonicalJournal,
        mutexHeld: true,
        mutexLease,
      });
    } catch (error) {
      if (error?.journalWriteReachedTarget === true) replaceRecord(state, next);
      throw error;
    }
    replaceRecord(state, next);
    return Object.freeze({ attemptedAt: state.executionAttemptedAt, argvHash: state.executionArgvHash });
  });
}

export function requirePinnedCloseExecutionReadiness(readiness, { wallet, tokenId, sharesRaw }) {
  if (
    readiness?.accessible !== true || readiness?.clobVersion !== "V2" ||
    readiness?.currentMode !== "deposit_wallet" ||
    String(readiness?.buyerWallet || "").toLowerCase() !== wallet ||
    String(readiness?.tradingAddress || "").toLowerCase() !== wallet
  ) {
    throw Object.assign(new Error("Active deposit wallet changed immediately before CLOSE"), {
      code: "trading_wallet_mismatch",
    });
  }
  if (String(readiness?.outcomeTokenId || "") !== tokenId) {
    throw Object.assign(new Error("Final position snapshot is for another token"), { code: "token_substitution" });
  }
  if (readiness?.approvedForExchange !== true) {
    throw Object.assign(new Error("Final standard V2 outcome-token approval is missing"), { code: "ctf_approval_missing" });
  }
  if (BigInt(readiness?.outcomeBalanceRaw ?? -1) < sharesRaw) {
    throw Object.assign(new Error("Final outcome-token balance is below the exact CLOSE shares"), { code: "insufficient_position" });
  }
  if (BigInt(readiness?.reservedSharesRaw ?? -1) !== 0n || Number(readiness?.openSellOrderCount ?? -1) !== 0) {
    throw Object.assign(new Error("An open order appeared before CLOSE submission"), { code: "position_reserved" });
  }
}

async function commandJson(file, args, label, {
  deadlineEpochMs,
  clock = Date.now,
  onStart = () => {},
  allowConfirming = false,
} = {}) {
  const commandStartedAt = Number(clock());
  const boundedTimeout = deadlineEpochMs === undefined
    ? 60_000
    : Math.min(60_000, Math.floor(Number(deadlineEpochMs) - commandStartedAt));
  if (!Number.isFinite(commandStartedAt) || !Number.isFinite(boundedTimeout) || boundedTimeout <= 0) {
    throw Object.assign(new Error(`${label} cannot start after the signed execution deadline`), {
      code: "execution_deadline_elapsed",
    });
  }
  try {
    onStart();
    const { stdout: output } = await execFileAsync(file, args, {
      timeout: boundedTimeout,
      maxBuffer: 2 * 1024 * 1024,
      encoding: "utf8",
    });
    const parsed = parseJsonOutput(output, label);
    if (parsed?.ok === false) {
      throw Object.assign(new Error(parsed?.error?.message || `${label} failed`), {
        code: parsed?.error?.code || "tool_failed",
        details: parsed,
      });
    }
    return parsed;
  } catch (error) {
    if (error?.details) throw error;
    const parsed = (() => {
      try { return parseJsonOutput(error?.stdout, label); } catch { return null; }
    })();
    if (allowConfirming && parsed?.confirming === true) return parsed;
    throw Object.assign(new Error(parsed?.error?.message || error?.message || `${label} failed`), {
      code: parsed?.error?.code || "tool_failed",
      details: parsed,
    });
  }
}

async function postJson(url, body, { headers = {} } = {}) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
    redirect: "error",
    signal: AbortSignal.timeout(30_000),
  });
  const text = await response.text();
  let json;
  try { json = text ? JSON.parse(text) : null; } catch { json = null; }
  return { response, json, text };
}

const PROOF_RECEIPT_RETRY_DELAYS_MS = Object.freeze([1_000, 2_000, 4_000, 4_000, 4_000]);
const RETRYABLE_PROOF_CODES = new Set(["missing_receipt", "missing_settlement_block"]);

export async function readProofWithReceiptIndexingRetry(
  readProof,
  {
    delaysMs = PROOF_RECEIPT_RETRY_DELAYS_MS,
    sleepImpl = (delayMs) => new Promise((resolvePromise) => setTimeout(resolvePromise, delayMs)),
  } = {},
) {
  if (typeof readProof !== "function" || !Array.isArray(delaysMs) ||
      delaysMs.some((delayMs) => !Number.isSafeInteger(delayMs) || delayMs < 0 || delayMs > 10_000)) {
    throw Object.assign(new Error("Proof retry policy is invalid"), { code: "invalid_retry_policy" });
  }
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await readProof();
    } catch (error) {
      if (!RETRYABLE_PROOF_CODES.has(error?.code) || attempt >= delaysMs.length) throw error;
      await sleepImpl(delaysMs[attempt]);
    }
  }
}

export function requireExecutionLaunchWindow(card, {
  now = Date.now,
  minimumHeadroomMs = 10_000,
} = {}) {
  const observedAt = Number(now());
  const deadlineEpochMs = Date.parse(String(card?.expiresAt || ""));
  if (
    !Number.isFinite(observedAt) || !Number.isFinite(deadlineEpochMs) ||
    deadlineEpochMs - observedAt < minimumHeadroomMs
  ) {
    throw Object.assign(new Error("Signed execution card has too little time left for locked submission"), {
      code: "insufficient_execution_window",
    });
  }
  return Object.freeze({ observedAt, deadlineEpochMs });
}

export async function waitForStrictlyPostConfirmationSecond(confirmedAt, {
  now = Date.now,
  sleep = (milliseconds) => new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds)),
} = {}) {
  const confirmedAtMs = Date.parse(String(confirmedAt || ""));
  const observedAt = Number(now());
  if (!Number.isFinite(confirmedAtMs) || !Number.isFinite(observedAt)) {
    throw Object.assign(new Error("Trade-confirmation clock is invalid"), { code: "invalid_trade_consent" });
  }
  const earliestLaunchAt = Math.floor(confirmedAtMs / 1_000) * 1_000 + 1_000;
  if (observedAt < earliestLaunchAt) {
    await sleep(earliestLaunchAt - observedAt);
    const postWait = Number(now());
    if (!Number.isFinite(postWait) || postWait < earliestLaunchAt) {
      throw Object.assign(new Error("Trade confirmation second is still active after the launch wait"), {
        code: "confirmation_second_active",
      });
    }
  }
  return earliestLaunchAt;
}

export async function persistBoundTradeConsent({
  state,
  mode,
  validated,
  executionArgv = validated?.executionCard?.argv,
  now = Date.now,
  writeState = writeReconciliationJournal,
} = {}) {
  const normalizedMode = String(mode || "").toLowerCase();
  const confirmedAt = Number(now());
  const expiresAt = Date.parse(String(validated?.expiresAt || ""));
  if (
    !state || typeof state !== "object" || Array.isArray(state) ||
    (normalizedMode !== "open" && normalizedMode !== "close") ||
    !Number.isSafeInteger(confirmedAt) || !Number.isFinite(expiresAt) || confirmedAt >= expiresAt ||
    !HASH_RE.test(String(validated?.intentHash || "")) ||
    !Array.isArray(executionArgv) || executionArgv.length === 0 ||
    !HASH_RE.test(String(state.paymentTx || "")) || !HASH_RE.test(String(state.replayKey || "")) ||
    typeof writeState !== "function"
  ) {
    throw Object.assign(new Error("Trade consent cannot be bound to this paid execution card"), {
      code: "invalid_trade_consent",
    });
  }
  const confirmedAtIso = new Date(confirmedAt).toISOString();
  state.tradeConfirmedAt = confirmedAtIso;
  state.tradeConsent = {
    version: normalizedMode === "close"
      ? "conviction-close-trade-consent-v1"
      : "conviction-open-trade-consent-v1",
    intentHash: validated.intentHash,
    executionArgvHash: sha256(executionArgv),
    paymentTx: state.paymentTx,
    replayKey: state.replayKey,
    confirmedAt: confirmedAtIso,
    expiresAt: validated.expiresAt,
  };
  state.stage = "trade_confirmed";
  state.reconciliationRequired = true;
  await writeState(state);
  return Object.freeze({ accepted: true, confirmedAt });
}

function decodeHeader(value, label) {
  try {
    return JSON.parse(Buffer.from(String(value || ""), "base64").toString("utf8"));
  } catch {
    throw Object.assign(new Error(`${label} is missing or invalid`), { code: "invalid_payment_header" });
  }
}

export async function persistSuccessfulPaidServiceResponse({
  state,
  response,
  json,
  paymentResponseRaw,
  writeState = writeReconciliationJournal,
  ambiguousStage = "paid_request_settlement_ambiguous",
} = {}) {
  if (
    !state || typeof state !== "object" || Array.isArray(state) ||
    response?.ok !== true || !Number.isInteger(response?.status) ||
    response.status < 200 || response.status >= 300 || json?.ok !== true ||
    typeof writeState !== "function" ||
    (ambiguousStage !== "paid_request_settlement_ambiguous" && ambiguousStage !== "paid_request_ambiguous")
  ) {
    throw Object.assign(new Error("Paid service response is not an accepted successful response"), {
      code: "invalid_paid_service_response",
    });
  }

  // A 2xx body is not settlement evidence. Persist the payment authorization's
  // ambiguous state before parsing any merchant-controlled header so a missing,
  // malformed, or crash-interrupted response remains exactly reconcilable.
  const pending = structuredClone(state);
  pending.paidServiceResponse = {
    status: response.status,
    paymentResponsePresent: Boolean(paymentResponseRaw),
  };
  pending.stage = ambiguousStage;
  pending.reconciliationRequired = true;
  await writeState(pending);
  replaceRecord(state, pending);

  const paymentResponse = decodeHeader(paymentResponseRaw, "PAYMENT-RESPONSE");
  const paymentTx = paymentTransaction(paymentResponse);

  // Keep the merchant response in memory until its claimed settlement is
  // independently proven on X Layer. A syntactically valid transaction hash is
  // not payment authority and must never unlock paid-card expiry cleanup.
  return Object.freeze({ card: json, paymentResponse, paymentTx });
}

const EXACT_PAYMENT_CHECKS = Object.freeze([
  "transactionSucceeded",
  "receiptBoundToBlock",
  "freshPayment",
  "exactAsset",
  "exactPayer",
  "exactPayee",
  "exactAmount",
]);

function paymentTransactionClaim(state, paymentProof, service) {
  const transactionHash = String(paymentProof?.transactionHash || "").toLowerCase();
  let journal = resolve(String(state?.journalPath || ""));
  try { journal = realpathSync(journal); } catch {}
  const replayKey = String(state?.replayKey || "").toLowerCase();
  const authorization = validateStoredPaymentAuthorization(state?.paymentAuthorization, {
    paymentPayer: state?.paymentPayer,
    service,
  });
  if (
    !HASH_RE.test(transactionHash) || !HASH_RE.test(replayKey) ||
    !journal || !HASH_RE.test(String(authorization?.nonce || ""))
  ) {
    throw Object.assign(new Error("Verified payment claim identity is invalid"), {
      code: "invalid_payment_claim",
    });
  }
  return Object.freeze({
    version: "conviction-payment-transaction-claim-v1",
    transactionHash,
    journalPath: journal,
    replayKey,
    authorizationNonce: authorization.nonce,
    paymentAuthorizationHash: sha256(authorization),
    paymentProofHash: sha256(paymentProof),
    serviceResource: service.resource,
    payer: String(state.paymentPayer).toLowerCase(),
    payee: SERVICE_PAYEE,
    asset: SERVICE_ASSET,
    amountAtomic: service.priceAtomic,
  });
}

export async function claimVerifiedPaymentTransaction({
  state,
  paymentProof,
  service,
  directory = dirname(String(state?.journalPath || "")),
  durablePublishImpl = writeDurableAtomicFile,
} = {}) {
  const claim = paymentTransactionClaim(state, paymentProof, service);
  if (!exactServicePaymentProof(state, asObject(paymentProof), claim.transactionHash, service)) {
    throw Object.assign(new Error("Independent x402 proof differs from the exact paid service"), {
      code: "payment_proof_mismatch",
    });
  }
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  try { directory = realpathSync(directory); } catch { directory = resolve(directory); }
  if (directory !== dirname(claim.journalPath)) {
    throw Object.assign(new Error("Payment transaction claim directory differs from its journal"), {
      code: "invalid_payment_claim_directory",
    });
  }
  const file = safeStatePath(
    join(directory, `payment-${claim.transactionHash.slice(2)}.lock.json`),
    "payment claim",
    directory,
  );
  const text = `${JSON.stringify(claim, null, 2)}\n`;
  try {
    await durablePublishImpl(file, text, { mode: 0o600, noReplace: true });
  } catch (error) {
    if (error?.code === "EEXIST") {
      throw Object.assign(
        new Error("This X Layer payment transaction is already claimed by another paid journey"),
        { code: "payment_transaction_replayed", details: { paymentClaimPath: file } },
      );
    }
    let published = false;
    try {
      const [existing] = await Promise.all([
        readFile(file, "utf8"),
        ownerOnlyStateFile(file, "Payment transaction claim"),
      ]);
      published = existing === text;
    } catch {}
    if (error?.atomicPublishCompleted === true || published) {
      throw Object.assign(new Error("Payment transaction claim publication is ambiguous"), {
        code: "payment_claim_ambiguous",
        cause: error,
        preserveSourceJournal: true,
        paymentClaimPath: file,
        paymentClaimHash: sha256(claim),
      });
    }
    throw error;
  }
  return Object.freeze({ file, claim, claimHash: sha256(claim), text });
}

async function releaseFailedPaymentTransactionClaim(claimed, {
  directory = dirname(String(claimed?.file || "")),
} = {}) {
  return withStateReleaseMutex(directory, async (mutexLease) => {
    const file = safeStatePath(claimed?.file, "payment claim", directory);
    const [current] = await Promise.all([
      readFile(file, "utf8"),
      ownerOnlyStateFile(file, "Payment transaction claim"),
    ]);
    if (current !== claimed?.text || sha256(JSON.parse(current)) !== claimed?.claimHash) {
      throw Object.assign(new Error("Payment transaction claim changed before rollback"), {
        code: "payment_claim_rollback_mismatch",
      });
    }
    await mutexLease.unlinkExact(file, current);
    mutexLease.assertAlive();
  });
}

function exactServicePaymentProof(state, proof, paymentTx, service) {
  const response = asObject(state?.paidServiceResponse);
  const paymentPayer = String(state?.paymentPayer || "");
  return Boolean(
    service && typeof service === "object" && DECIMAL_UINT_RE.test(String(service.priceAtomic || "")) &&
    Number.isInteger(response?.status) && response.status >= 200 && response.status < 300 &&
    response.paymentResponsePresent === true &&
    HASH_RE.test(paymentTx) && paymentTx === paymentTx.toLowerCase() &&
    ADDRESS_RE.test(paymentPayer) && paymentPayer === paymentPayer.toLowerCase() &&
    proof?.version === "conviction-x402-payment-v1" && proof.chainId === 196 &&
    proof.transactionHash === paymentTx && proof.payer === paymentPayer &&
    proof.payee === SERVICE_PAYEE && proof.asset === SERVICE_ASSET &&
    proof.amountAtomic === service.priceAtomic &&
    DECIMAL_UINT_RE.test(String(proof.blockNumber || "")) &&
    HASH_RE.test(String(proof.blockHash || "")) &&
    DECIMAL_UINT_RE.test(String(proof.blockTimestamp || "")) &&
    EXACT_PAYMENT_CHECKS.every((field) => proof.checks?.[field] === true)
  );
}

function exactStoredServicePayment(state, service) {
  const proof = asObject(state?.paymentProof);
  const paymentTx = String(state?.paymentTx || "");
  const coreMatches = exactServicePaymentProof(state, proof, paymentTx, service);
  let expectedClaim;
  try {
    expectedClaim = paymentTransactionClaim(state, proof, service);
  } catch {
    return null;
  }
  let claimDirectory = resolve(dirname(String(state.journalPath)));
  try { claimDirectory = realpathSync(claimDirectory); } catch {}
  if (
    !coreMatches ||
    state.paymentClaimPath !== join(claimDirectory, `payment-${paymentTx.slice(2)}.lock.json`) ||
    state.paymentClaimHash !== sha256(expectedClaim)
  ) {
    return null;
  }
  return proof;
}

export async function verifyStoredPaymentTransactionClaim({
  state,
  service,
  stateDirectory = dirname(String(state?.journalPath || "")),
  statImpl = stat,
} = {}) {
  const proof = exactStoredServicePayment(state, service);
  if (!proof) {
    throw Object.assign(new Error("Stored paid journey has no exact payment transaction claim"), {
      code: "payment_claim_missing_or_mismatched",
    });
  }
  const expected = paymentTransactionClaim(state, proof, service);
  let claimDirectory = resolve(stateDirectory);
  try { claimDirectory = realpathSync(claimDirectory); } catch {}
  const expectedPath = safeStatePath(
    join(claimDirectory, `payment-${expected.transactionHash.slice(2)}.lock.json`),
    "payment claim",
    claimDirectory,
  );
  if (state.paymentClaimPath !== expectedPath || state.paymentClaimHash !== sha256(expected)) {
    throw Object.assign(new Error("Stored payment transaction claim binding is invalid"), {
      code: "payment_claim_missing_or_mismatched",
      details: {
        expectedPath,
        actualPath: state.paymentClaimPath,
        expectedHash: sha256(expected),
        actualHash: state.paymentClaimHash,
      },
    });
  }
  let text;
  try {
    [text] = await Promise.all([
      readFile(expectedPath, "utf8"),
      ownerOnlyStateFile(expectedPath, "Payment transaction claim", { statImpl }),
    ]);
  } catch (cause) {
    throw Object.assign(new Error("Stored payment transaction claim is missing or unsafe"), {
      code: "payment_claim_missing_or_mismatched",
      cause,
    });
  }
  let stored;
  try { stored = JSON.parse(text); } catch (cause) {
    throw Object.assign(new Error("Stored payment transaction claim is not valid JSON"), {
      code: "payment_claim_missing_or_mismatched",
      cause,
    });
  }
  if (text !== `${JSON.stringify(expected, null, 2)}\n` || sha256(stored) !== sha256(expected)) {
    throw Object.assign(new Error("Stored payment transaction claim differs from the paid journey"), {
      code: "payment_claim_missing_or_mismatched",
    });
  }
  return Object.freeze({ file: expectedPath, claim: expected, claimHash: sha256(expected) });
}

export async function persistVerifiedPaidServicePayment({
  state,
  paid,
  paymentProof,
  service,
  writeState = writeReconciliationJournal,
  ambiguousStage = "paid_request_settlement_ambiguous",
  claimPaymentImpl = claimVerifiedPaymentTransaction,
  releasePaymentClaimImpl = releaseFailedPaymentTransactionClaim,
} = {}) {
  const card = asObject(paid?.card);
  const paymentTx = String(paid?.paymentTx || "").toLowerCase();
  if (
    !state || typeof state !== "object" || Array.isArray(state) ||
    typeof writeState !== "function" || !card || !HASH_RE.test(paymentTx) ||
    !HASH_RE.test(String(card.intentHash || "")) || state.stage !== ambiguousStage ||
    (ambiguousStage !== "paid_request_settlement_ambiguous" && ambiguousStage !== "paid_request_ambiguous") ||
    state.reconciliationRequired !== true || state.paidCard != null || state.paymentTx != null ||
    state.paymentProof != null || state.paymentClaimPath != null || state.paymentClaimHash != null ||
    state.executionArgvHash != null || state.orderId != null ||
    state.settlementTx != null
  ) {
    throw Object.assign(new Error("Verified paid service response cannot be committed from this state"), {
      code: "invalid_payment_verification_state",
    });
  }

  // A receipt proves that one exact transfer occurred, but the merchant header
  // does not prove that it belongs to only this journal. Claim the transaction
  // hash durably before promoting the card so one PAYMENT-RESPONSE cannot pay
  // two overlapping journeys. The claim also binds this journal's authorization
  // nonce, replay identity, service, payer, and independently verified proof.
  if (!exactServicePaymentProof(state, asObject(paymentProof), paymentTx, service)) {
    throw Object.assign(new Error("Independent x402 proof differs from the exact paid service"), {
      code: "payment_proof_mismatch",
    });
  }
  const claimed = await claimPaymentImpl({ state, paymentProof, service });
  const verified = structuredClone(state);
  verified.stage = "payment_verified";
  verified.paymentTx = paymentTx;
  verified.intentHash = card.intentHash;
  verified.paidCard = card;
  verified.paymentProof = structuredClone(paymentProof);
  verified.paymentClaimPath = claimed.file;
  verified.paymentClaimHash = claimed.claimHash;
  verified.reconciliationRequired = true;
  try {
    if (!exactStoredServicePayment(verified, service)) {
      throw Object.assign(new Error("Independent x402 proof differs from the exact paid service"), {
        code: "payment_proof_mismatch",
      });
    }
    await verifyStoredPaymentTransactionClaim({ state: verified, service });
    await writeState(verified);
  } catch (error) {
    let durableReachedTarget = error?.journalWriteReachedTarget === true;
    let durableTarget = null;
    if (!durableReachedTarget) {
      try {
        const [text] = await Promise.all([
          readFile(claimed.claim.journalPath, "utf8"),
          ownerOnlyStateFile(claimed.claim.journalPath, "Reconciliation journal"),
        ]);
        const parsed = JSON.parse(text);
        const expected = structuredClone(verified);
        expected.journalRevision = journalRevision(verified) + 1;
        if (sha256(parsed) === sha256(verified) || sha256(parsed) === sha256(expected)) {
          durableReachedTarget = true;
          durableTarget = parsed;
        }
      } catch {}
    }
    if (durableReachedTarget || error?.preserveSourceJournal === true) {
      if (durableTarget) replaceRecord(state, durableTarget);
      else if (error?.journalWriteReachedTarget === true) replaceRecord(state, verified);
      error.preserveSourceJournal = true;
      error.paymentClaimRetained = true;
      error.paymentClaimPath = claimed.file;
      error.paymentClaimHash = claimed.claimHash;
      throw error;
    }
    try {
      await releasePaymentClaimImpl(claimed);
    } catch (cleanupError) {
      throw Object.assign(new Error("Verified payment claim could not be rolled back after journal failure"), {
        code: "payment_claim_rollback_failed",
        cause: error,
        cleanupError: cleanupError?.code || "payment_claim_cleanup_failed",
        preserveSourceJournal: true,
        paymentClaimPath: claimed.file,
        paymentClaimHash: claimed.claimHash,
      });
    }
    throw error;
  }
  replaceRecord(state, verified);
  return state.paymentProof;
}

export function paymentAuthorizationMetadata(headerValue, {
  paymentPayer,
  service = POSITION_CARD_SERVICE,
  now = Date.now(),
} = {}) {
  const decoded = decodeHeader(headerValue, "PAYMENT-SIGNATURE");
  const accepted = decoded?.accepted;
  const authorization = decoded?.payload?.authorization;
  const signature = String(decoded?.payload?.signature || "");
  const from = String(authorization?.from || "").toLowerCase();
  const to = String(authorization?.to || "").toLowerCase();
  const asset = String(accepted?.asset || "").toLowerCase();
  const network = String(accepted?.network || "");
  const value = String(authorization?.value || "");
  const validAfter = String(authorization?.validAfter || "");
  const validBefore = String(authorization?.validBefore || "");
  const nonce = String(authorization?.nonce || "").toLowerCase();
  const extra = accepted?.extra;
  const validWindow = DECIMAL_UINT_RE.test(validAfter) && DECIMAL_UINT_RE.test(validBefore)
    ? BigInt(validBefore) - BigInt(validAfter)
    : -1n;
  // OKX's standard EIP-3009 signer uses an epoch origin and bounds exposure with validBefore.
  const epochOrigin = validAfter === "0";
  const nowSeconds = BigInt(Math.floor(now / 1_000));
  if (
    decoded?.x402Version !== 2 || accepted?.scheme !== "exact" ||
    network !== SERVICE_NETWORK || asset !== SERVICE_ASSET ||
    String(accepted?.amount || "") !== service.priceAtomic ||
    String(accepted?.payTo || "").toLowerCase() !== SERVICE_PAYEE ||
    accepted?.maxTimeoutSeconds !== SERVICE_PAYMENT_TIMEOUT_SECONDS ||
    extra?.name !== "USD₮0" || extra?.version !== "1" ||
    Object.keys(extra || {}).sort().join(",") !== "name,version" ||
    !ADDRESS_RE.test(from) || from !== String(paymentPayer || "").toLowerCase() ||
    to !== SERVICE_PAYEE || value !== service.priceAtomic ||
    !DECIMAL_UINT_RE.test(validAfter) || !DECIMAL_UINT_RE.test(validBefore) ||
    validWindow <= 0n || (!epochOrigin && validWindow > BigInt(SERVICE_PAYMENT_TIMEOUT_SECONDS + 5)) ||
    (!epochOrigin && (BigInt(validAfter) < nowSeconds - 60n || BigInt(validAfter) > nowSeconds + 5n)) ||
    BigInt(validBefore) <= nowSeconds || BigInt(validBefore) > nowSeconds + BigInt(SERVICE_PAYMENT_TIMEOUT_SECONDS + 5) ||
    !HASH_RE.test(nonce) || !/^0x[0-9a-f]{130}$/i.test(signature)
  ) {
    throw Object.assign(new Error("x402 authorization differs from the pinned payment"), {
      code: "payment_authorization_mismatch",
    });
  }
  return Object.freeze({
    version: "conviction-x402-authorization-v1",
    scheme: "exact-eip3009",
    network,
    asset,
    from,
    to,
    value,
    validAfter,
    validBefore,
    nonce,
  });
}

function validateStoredPaymentAuthorization(metadata, {
  paymentPayer,
  service = POSITION_MANAGER_SERVICE,
} = {}) {
  const validAfter = String(metadata?.validAfter || "");
  const validBefore = String(metadata?.validBefore || "");
  const validWindow = DECIMAL_UINT_RE.test(validAfter) && DECIMAL_UINT_RE.test(validBefore)
    ? BigInt(validBefore) - BigInt(validAfter)
    : -1n;
  const epochOrigin = validAfter === "0";
  if (
    metadata?.version !== "conviction-x402-authorization-v1" ||
    metadata?.scheme !== "exact-eip3009" || metadata?.network !== SERVICE_NETWORK ||
    String(metadata?.asset || "").toLowerCase() !== SERVICE_ASSET ||
    String(metadata?.from || "").toLowerCase() !== String(paymentPayer || "").toLowerCase() ||
    String(metadata?.to || "").toLowerCase() !== SERVICE_PAYEE ||
    String(metadata?.value || "") !== service.priceAtomic ||
    validWindow <= 0n || (!epochOrigin && validWindow > BigInt(SERVICE_PAYMENT_TIMEOUT_SECONDS + 5)) ||
    !HASH_RE.test(String(metadata?.nonce || ""))
  ) {
    throw Object.assign(new Error("Stored x402 authorization differs from the pinned payment"), {
      code: "invalid_payment_authorization",
    });
  }
  return metadata;
}

function isRecoverablePaymentAuthorizationState(state) {
  const allowedStages = new Set([
    "payment_authorization_created",
    "payment_header_rejected_after_authorization",
    "paid_request_rejected_pre_settlement",
    "paid_request_settlement_ambiguous",
  ]);
  const response = state?.paidServiceResponse;
  const responseMatchesStage = state?.stage === "payment_authorization_created" ||
      state?.stage === "payment_header_rejected_after_authorization"
    ? response === null || response === undefined
    : state?.stage === "paid_request_rejected_pre_settlement"
      ? Number.isInteger(response?.status) && response.status >= 400 && response.paymentResponsePresent === false
      : response && Number.isInteger(response.status);
  return allowedStages.has(state?.stage) && responseMatchesStage &&
    state.reconciliationRequired === true && !state.executionArgvHash && !state.executionArgv &&
    !state.paidCard && !state.paymentTx && !state.orderId && !state.settlementTx &&
    !state.executionLockPath && !state.tradeConfirmedAt && !state.liveResult &&
    HASH_RE.test(String(state.replayKey || "")) && Boolean(state.replayLockPath) &&
    state.paymentAuthorization?.version === "conviction-x402-authorization-v1";
}

async function xlayerRpc(method, params, { fetchImpl = fetch, rpcUrl = "https://rpc.xlayer.tech" } = {}) {
  const response = await fetchImpl(rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: AbortSignal.timeout(10_000),
  });
  const body = await response.json();
  if (!response.ok || body?.error || body?.result === undefined || body?.result === null) {
    throw Object.assign(new Error("X Layer authorization-state RPC failed"), {
      code: "payment_rpc_error",
    });
  }
  return body.result;
}

export async function fetchEip3009AuthorizationState(metadata, options = {}) {
  const from = String(metadata?.from || "").toLowerCase();
  const nonce = String(metadata?.nonce || "").toLowerCase();
  const asset = String(metadata?.asset || "").toLowerCase();
  if (!ADDRESS_RE.test(from) || !HASH_RE.test(nonce) || asset !== SERVICE_ASSET) {
    throw Object.assign(new Error("Stored payment authorization is invalid"), {
      code: "invalid_payment_authorization",
    });
  }
  const chainHex = await xlayerRpc("eth_chainId", [], options);
  if (Number(BigInt(chainHex)) !== 196) {
    throw Object.assign(new Error("Payment authorization RPC is not X Layer"), {
      code: "wrong_payment_chain",
    });
  }
  const block = await xlayerRpc("eth_getBlockByNumber", ["finalized", false], options);
  if (
    !/^0x[0-9a-f]+$/i.test(String(block?.number || "")) ||
    !/^0x[0-9a-f]+$/i.test(String(block?.timestamp || "")) ||
    !HASH_RE.test(String(block?.hash || ""))
  ) {
    throw Object.assign(new Error("X Layer finalized block is invalid"), { code: "payment_rpc_error" });
  }
  const data = `0x${AUTHORIZATION_STATE_SELECTOR}${from.slice(2).padStart(64, "0")}${nonce.slice(2)}`;
  const result = await xlayerRpc("eth_call", [
    { to: asset, data },
    { blockHash: String(block.hash).toLowerCase(), requireCanonical: true },
  ], options);
  if (!/^0x[0-9a-f]+$/i.test(String(result || "")) || (BigInt(result) !== 0n && BigInt(result) !== 1n)) {
    throw Object.assign(new Error("X Layer authorization state is invalid"), { code: "payment_rpc_error" });
  }
  return Object.freeze({
    used: BigInt(result) === 1n,
    blockNumber: BigInt(block.number).toString(),
    blockHash: String(block.hash).toLowerCase(),
    blockTimestamp: BigInt(block.timestamp).toString(),
  });
}

function findAddress(addresses, chainIndex) {
  const data = addresses?.data || addresses;
  const direct = data?.xlayer?.find?.((entry) => String(entry.chainIndex) === String(chainIndex))?.address;
  if (direct) return direct;
  const stack = [data];
  const seen = new Set();
  while (stack.length) {
    const value = stack.pop();
    if (!value || typeof value !== "object" || seen.has(value)) continue;
    seen.add(value);
    if (
      String(value.chainIndex) === String(chainIndex) &&
      ADDRESS_RE.test(String(value.address || ""))
    ) return value.address;
    for (const child of Array.isArray(value) ? value : Object.values(value)) stack.push(child);
  }
  return undefined;
}

function depositWalletFromQuickstart(quickstart) {
  const data = quickstart?.data || quickstart;
  const address = data?.wallet?.deposit_wallet;
  return address ? String(address).toLowerCase() : null;
}

function effectiveOpenExecutionArgv(validated, tradingMode) {
  const base = validated?.executionCard?.argv;
  if (!Array.isArray(base) || base.length === 0) {
    throw Object.assign(new Error("OPEN execution argv is missing"), { code: "invalid_execution_card" });
  }
  if (tradingMode !== "eoa") return [...base];
  const append = validated?.walletPreparation?.execution?.appendArgv;
  const forbidden = new Set(validated?.walletPreparation?.execution?.forbiddenArgv || []);
  if (
    validated?.walletPreparation?.tradingMode !== "eoa" ||
    JSON.stringify(append) !== JSON.stringify(["--mode", "eoa"])
  ) {
    throw Object.assign(new Error("Signed EOA preparation is missing the exact execution mode"), {
      code: "invalid_eoa_preparation",
    });
  }
  if (base.some((entry) => forbidden.has(String(entry)))) {
    throw Object.assign(new Error("OPEN argv contains a forbidden EOA argument"), {
      code: "invalid_eoa_preparation",
    });
  }
  return [...base, ...append];
}

function safeStatePath(value, kind, stateDirectory = journalDirectory) {
  const resolvedRoot = resolve(stateDirectory);
  const resolvedCandidate = resolve(String(value || ""));
  let physicalRoot = resolvedRoot;
  let physicalCandidate = resolvedCandidate;
  try { physicalRoot = realpathSync(resolvedRoot); } catch {}
  try { physicalCandidate = realpathSync(resolvedCandidate); } catch {}
  if (!physicalCandidate.startsWith(`${physicalRoot}${sep}`)) {
    throw Object.assign(new Error(`${kind} path is outside Conviction's private state directory`), {
      code: "unsafe_state_path",
    });
  }
  const name = basename(resolvedCandidate);
  const valid = kind === "journal"
    ? name.endsWith(".json") && !name.endsWith(".lock.json")
    : kind === "replay lock"
      ? /^(?:open|close)-[0-9a-f]{64}\.lock\.json$/.test(name)
      : kind === "payment claim"
        ? /^payment-[0-9a-f]{64}\.lock\.json$/.test(name)
      : kind === "reservation lock"
        ? /^take-profit-[0-9a-f]{64}\.lock\.json$/.test(name)
        : kind === "lock"
          ? name === "polymarket-execution.lock.json" ||
            name === releaseLockBasename ||
            /^(?:open|close)-[0-9a-f]{64}\.lock\.json$/.test(name) ||
            /^payment-[0-9a-f]{64}\.lock\.json$/.test(name) ||
            /^take-profit-[0-9a-f]{64}\.lock\.json$/.test(name)
          : name === "polymarket-execution.lock.json";
  if (!valid) {
    throw Object.assign(new Error(`${kind} path is not a recognized Conviction state file`), {
      code: "unsafe_state_path",
    });
  }
  return resolvedCandidate;
}

export async function verifyJournalLockOwnership(
  state,
  {
    stateDirectory = journalDirectory,
    journal,
    fields = ["replayLockPath", "executionLockPath"],
    requirePresent = false,
  } = {},
) {
  const definitions = {
    replayLockPath: "replay lock",
    executionLockPath: "execution lock",
    reservationLockPath: "reservation lock",
  };
  const checked = [];
  for (const field of fields) {
    const kind = definitions[field];
    if (!kind) continue;
    if (!state[field]) {
      if (requirePresent) {
        throw Object.assign(new Error(`${kind} is missing from the journey`), {
          code: "lock_ownership_mismatch",
        });
      }
      continue;
    }
    const file = safeStatePath(state[field], kind, stateDirectory);
    let lock;
    let lockText;
    try {
      lockText = await readFile(file, "utf8");
      lock = JSON.parse(lockText);
      await ownerOnlyStateFile(file, kind);
    } catch (error) {
      if (error?.code === "ENOENT") {
        if (requirePresent) {
          throw Object.assign(new Error(`${kind} is missing`), {
            code: "lock_ownership_mismatch",
          });
        }
        checked.push({ field, file, missing: true });
        continue;
      }
      if (String(error?.code || "").startsWith("unsafe_state_")) throw error;
      throw Object.assign(new Error(`${kind} cannot be verified before release`), {
        code: "lock_ownership_mismatch",
      });
    }
    const replayKind = basename(file).startsWith("open-") ? "open" : "close";
    const lockHash = sha256(lock);
    const owned = field === "replayLockPath"
      ? HASH_RE.test(String(state.replayKey || "")) &&
        basename(file) === `${replayKind}-${String(state.replayKey).slice(2)}.lock.json` &&
        lock?.version === `conviction-${replayKind}-replay-lock-v1` &&
        lock?.replayKey === state.replayKey && lock?.journalPath === journal
      : field === "reservationLockPath"
        ? HASH_RE.test(String(state.replayKey || "")) &&
          basename(file) === `take-profit-${String(state.replayKey).slice(2)}.lock.json` &&
          lock?.version === "conviction-take-profit-reservation-v1" &&
          lock?.replayKey === state.replayKey && lock?.journalPath === journal
        : basename(file) === "polymarket-execution.lock.json" && lock?.journalPath === journal && (
          lock?.version === "conviction-polymarket-execution-lock-v2"
            ? lock?.attachmentRequired === true && UUID_RE.test(String(lock?.generation || "")) &&
              EXECUTION_LOCK_PURPOSES.has(lock?.purpose) && HASH_RE.test(String(lock?.sourceJournalHash || "")) &&
              Number.isSafeInteger(lock?.sourceJournalRevision) && lock.sourceJournalRevision >= 0 &&
              Number.isFinite(Date.parse(String(lock?.claimedAt || ""))) &&
              new Date(Date.parse(lock.claimedAt)).toISOString() === lock.claimedAt &&
              Number.isFinite(Date.parse(String(lock?.recoveryNotBefore || ""))) &&
              new Date(Date.parse(lock.recoveryNotBefore)).toISOString() === lock.recoveryNotBefore &&
              Date.parse(lock.claimedAt) < Date.parse(lock.recoveryNotBefore) &&
              journalRevision(state) > lock.sourceJournalRevision &&
              state.executionLockGeneration === lock.generation &&
              state.executionLockHash === lockHash && state.executionLockPurpose === lock.purpose &&
              state.executionLockRecoveryNotBefore === lock.recoveryNotBefore
            : lock?.version === "conviction-polymarket-execution-lock-v1" &&
              state.executionLockGeneration == null && state.executionLockHash == null &&
              state.executionLockPurpose == null && state.executionLockRecoveryNotBefore == null
        );
    if (!owned) {
      throw Object.assign(new Error(`${kind} belongs to another journey`), {
        code: "lock_ownership_mismatch",
      });
    }
    const item = { field, file, missing: false, lockHash };
    Object.defineProperty(item, "lockText", { value: lockText, enumerable: false });
    checked.push(item);
  }

  return checked;
}

export async function releaseReconciledLocks(
  state,
  options = {},
) {
  const stateDirectory = options.stateDirectory || journalDirectory;
  return withStateReleaseMutex(stateDirectory, (mutexLease) => releaseReconciledLocksLocked(state, {
    ...options,
    stateDirectory,
    mutexLease,
  }));
}

/**
 * Resume an exact crash-incomplete lock-release transaction without requiring
 * the restart command to know the original transition label. The durable guard
 * is the authority: its source/target hashes, field set, lock generations, and
 * transition identity are all re-authenticated under the owner-local mutex.
 */
export async function resumePendingStateRelease({
  journal,
  stateDirectory = journalDirectory,
  writeState = writeReconciliationJournal,
  statImpl = stat,
} = {}) {
  return withStateReleaseMutex(stateDirectory, async (mutexLease) => {
    const canonicalJournal = safeStatePath(journal, "journal", stateDirectory);
    const releaseFile = join(stateDirectory, releaseLockBasename);
    let guardText;
    try {
      [guardText] = await Promise.all([
        readFile(releaseFile, "utf8"),
        ownerOnlyStateFile(releaseFile, "State-release guard", { statImpl }),
        ownerOnlyStateFile(canonicalJournal, "Reconciliation journal", { statImpl }),
      ]);
    } catch (error) {
      if (error?.code === "ENOENT") return Object.freeze({ resumed: false, completed: false, released: Object.freeze([]) });
      throw error;
    }
    let guard;
    try { guard = JSON.parse(guardText); } catch {}
    if (!validReleaseGuard(guard) || guard.journalPath !== canonicalJournal) {
      throw Object.assign(new Error("Pending state-release guard does not belong to this journal"), {
        code: "state_release_guard_mismatch",
      });
    }
    const durable = JSON.parse(await readFile(canonicalJournal, "utf8"));
    const durableHash = sha256(durable);
    if (durableHash === guard.targetJournalHash) {
      await assertNoStateReleaseInProgress({
        directory: stateDirectory,
        releaseFile,
        statImpl,
        mutexHeld: true,
        mutexLease,
      });
      return Object.freeze({ resumed: true, completed: true, released: Object.freeze([]) });
    }
    if (durableHash !== guard.sourceJournalHash) {
      throw Object.assign(new Error("Pending state-release journal differs from both guarded states"), {
        code: "reconciliation_journal_changed",
      });
    }
    const legacyV1ExecutionBinding = durable.executionLockGeneration == null &&
      durable.executionLockHash == null && durable.executionLockPurpose == null &&
      durable.executionLockRecoveryNotBefore == null;
    if (
      guard.fields.includes("executionLockPath") && !legacyV1ExecutionBinding &&
      durable.executionLockHash !== guard.lockHashes.executionLockPath
    ) {
      throw Object.assign(new Error("Pending state-release execution generation differs from its source journal"), {
        code: "lock_generation_mismatch",
      });
    }
    const released = await releaseReconciledLocksLocked(durable, {
      stateDirectory,
      journal: canonicalJournal,
      fields: guard.fields,
      expectedLockHashes: guard.lockHashes,
      writeState,
      statImpl,
      mutexLease,
      stableTransitionIdOverride: guard.transitionId,
    });
    return Object.freeze({ resumed: true, completed: true, released: Object.freeze([...released]) });
  });
}

async function releaseReconciledLocksLocked(
  state,
  {
    stateDirectory = journalDirectory,
    journal,
    fields = ["replayLockPath", "executionLockPath"],
    expectedLockHashes = {},
    transition,
    transitionId,
    writeState = writeReconciliationJournal,
    unlinkImpl = unlink,
    now = Date.now,
    beforeUnlink,
    afterUnlink,
    beforeGuardRelease,
    durableGuardPublishImpl = writeDurableAtomicFile,
    statImpl = stat,
    mutexLease,
    stableTransitionIdOverride,
  } = {},
) {
  if (typeof mutexLease?.unlinkExact !== "function") {
    throw Object.assign(new Error("Lock release requires its kernel-held exact-unlink capability"), {
      code: "state_release_mutex_lost",
    });
  }
  mutexLease?.assertAlive();
  const canonicalJournal = safeStatePath(journal, "journal", stateDirectory);
  await ownerOnlyStateFile(canonicalJournal, "Reconciliation journal", { statImpl });
  const selectedFields = [...new Set(fields)].filter((field) => state?.[field]).sort();
  if (selectedFields.length === 0) return [];
  const source = structuredClone(state);
  const sourceRevision = journalRevision(source);
  const sourceHash = sha256(source);
  const stableTransitionId = stableTransitionIdOverride === undefined
    ? sha256({
      version: "conviction-state-release-transition-v1",
      kind: String(transitionId || "release-selected-locks"),
      fields: selectedFields,
      sourceVersion: source.version || null,
      sourceMode: source.mode || null,
      sourceAction: source.action || null,
      sourceStage: source.stage || null,
    })
    : String(stableTransitionIdOverride);
  if (!HASH_RE.test(stableTransitionId)) {
    throw Object.assign(new Error("State-release transition identity is invalid"), {
      code: "state_release_guard_mismatch",
    });
  }
  const durableBeforeGuard = JSON.parse(await readFile(canonicalJournal, "utf8"));
  if (sha256(durableBeforeGuard) !== sourceHash) {
    throw Object.assign(new Error("Reconciliation journal changed before lock-release preparation"), {
      code: "reconciliation_journal_changed",
    });
  }
  const preparedLocks = await verifyJournalLockOwnership(source, {
    stateDirectory,
    journal: canonicalJournal,
    fields: selectedFields,
  });
  for (const item of preparedLocks) {
    const expectedHash = expectedLockHashes?.[item.field];
    if (expectedHash !== undefined && !item.missing && expectedHash !== item.lockHash) {
      throw Object.assign(new Error(`${item.field} generation differs from the reconciled operation`), {
        code: "lock_generation_mismatch",
      });
    }
  }
  const observedNow = Number(typeof now === "function" ? now() : now);
  if (!Number.isFinite(observedNow)) {
    throw Object.assign(new Error("State-release clock is invalid"), { code: "invalid_reconciliation_clock" });
  }
  const releaseFile = join(stateDirectory, releaseLockBasename);
  const resumable = await resumableStateReleaseGuard({
    releaseFile,
    journal: canonicalJournal,
    sourceJournalHash: sourceHash,
    transitionId: stableTransitionId,
    fields: selectedFields,
    statImpl,
  });
  const releaseNow = resumable ? Date.parse(resumable.guard.claimedAt) : observedNow;
  if (!Number.isFinite(releaseNow)) {
    throw Object.assign(new Error("State-release guard clock is invalid"), {
      code: "state_release_guard_mismatch",
    });
  }
  if (!resumable && preparedLocks.some((item) => item.missing)) {
    throw Object.assign(new Error("A lock may be missing only when resuming its exact durable release guard"), {
      code: "lock_ownership_mismatch",
    });
  }
  const releasedAt = new Date(releaseNow).toISOString();
  let next;
  let targetHash;
  let guardedLockHashes;
  if (resumable) {
    next = structuredClone(resumable.guard.targetState);
    targetHash = resumable.guard.targetJournalHash;
    if (journalRevision(next) !== sourceRevision + 1 || sha256(next) !== targetHash) {
      throw Object.assign(new Error("Crash-incomplete release target has an invalid journal generation"), {
        code: "state_release_guard_mismatch",
      });
    }
    for (const field of selectedFields) {
      const releasedField = field === "executionLockPath"
        ? "executionLockReleasedAt"
        : field === "replayLockPath" ? "replayLockReleasedAt" : "reservationLockReleasedAt";
      if (next[field] !== null || next[releasedField] !== releasedAt) {
        throw Object.assign(new Error(`${field} crash target is not the exact guarded release state`), {
          code: "state_release_guard_mismatch",
        });
      }
      if (field === "executionLockPath" && (
        next.executionLockGeneration != null || next.executionLockHash != null ||
        next.executionLockPurpose != null || next.executionLockRecoveryNotBefore != null
      )) {
        throw Object.assign(new Error("Crash target retains part of a released execution-lock binding"), {
          code: "state_release_guard_mismatch",
        });
      }
    }
    guardedLockHashes = structuredClone(resumable.guard.lockHashes);
    for (const item of preparedLocks) {
      const expectedGeneration = guardedLockHashes[item.field];
      if (!item.missing && item.lockHash !== expectedGeneration) {
        throw Object.assign(new Error(`${item.field} differs from the crash-incomplete guarded generation`), {
          code: "lock_generation_mismatch",
        });
      }
      const requestedGeneration = expectedLockHashes?.[item.field];
      if (requestedGeneration !== undefined && requestedGeneration !== expectedGeneration) {
        throw Object.assign(new Error(`${item.field} requested generation differs from the guarded transaction`), {
          code: "lock_generation_mismatch",
        });
      }
    }
  } else {
    next = structuredClone(source);
    for (const field of selectedFields) {
      next[field] = null;
      if (field === "executionLockPath") {
        next.executionLockReleasedAt = releasedAt;
        next.executionLockReleaseError = null;
        next.executionLockGeneration = null;
        next.executionLockHash = null;
        next.executionLockPurpose = null;
        next.executionLockRecoveryNotBefore = null;
      } else if (field === "replayLockPath") {
        next.replayLockReleasedAt = releasedAt;
        next.replayLockReleaseError = null;
      } else if (field === "reservationLockPath") {
        next.reservationLockReleasedAt = releasedAt;
        next.reservationLockReleaseError = null;
      }
    }
    if (transition) await transition(next, { releasedAt, now: releaseNow });
    if (journalRevision(next) !== sourceRevision) {
      throw Object.assign(new Error("State-release transition changed the journal revision"), {
        code: "invalid_journal_revision",
      });
    }
    next.journalRevision = sourceRevision + 1;
    targetHash = sha256(next);
    guardedLockHashes = Object.fromEntries(preparedLocks.map((item) => [
      item.field,
      item.missing ? null : item.lockHash,
    ]));
  }
  const releaseGuard = await claimStateReleaseGuard({
    journal: canonicalJournal,
    stateDirectory,
    sourceJournalHash: sourceHash,
    targetJournalHash: targetHash,
    targetState: next,
    transitionId: stableTransitionId,
    fields: selectedFields,
    lockHashes: guardedLockHashes,
    now: releaseNow,
    statImpl,
    assertMutexAlive: () => mutexLease?.assertAlive(),
    unlinkExact: (file, expectedText) => mutexLease?.unlinkExact(file, expectedText),
    durablePublishImpl: durableGuardPublishImpl,
  });
  let destructive = false;
  try {
    mutexLease?.assertAlive();
    const durable = JSON.parse(await readFile(canonicalJournal, "utf8"));
    if (sha256(durable) !== sourceHash) {
      throw Object.assign(new Error("Reconciliation journal changed before guarded lock release"), {
        code: "reconciliation_journal_changed",
      });
    }
    const checked = await verifyJournalLockOwnership(source, {
      stateDirectory,
      journal: canonicalJournal,
      fields: selectedFields,
    });
    for (const item of checked) {
      if (item.missing && !resumable) {
        throw Object.assign(new Error(`${item.field} disappeared before its guarded release`), {
          code: "lock_generation_mismatch",
        });
      }
      const expectedHash = guardedLockHashes[item.field];
      if (!item.missing && expectedHash !== item.lockHash) {
        throw Object.assign(new Error(`${item.field} generation differs from the reconciled operation`), {
          code: "lock_generation_mismatch",
        });
      }
    }
    await beforeUnlink?.(Object.freeze(checked.map((item) => Object.freeze({ ...item }))));
    const released = [];
    for (const { field, file, missing, lockHash, lockText } of checked) {
      released.push(file);
      if (missing) {
        destructive = true;
        continue;
      }
      let current;
      try { current = JSON.parse(await readFile(file, "utf8")); } catch (error) {
        if (error?.code === "ENOENT") {
          if (!resumable) {
            throw Object.assign(new Error(`${field} disappeared during its guarded release`), {
              code: "lock_generation_mismatch",
            });
          }
          destructive = true;
          continue;
        }
        throw error;
      }
      if (sha256(current) !== lockHash) {
        throw Object.assign(new Error(`${field} generation changed during guarded release`), {
          code: "lock_generation_mismatch",
        });
      }
      destructive = true;
      await mutexLease?.unlinkExact(file, lockText);
      mutexLease?.assertAlive();
    }
    await afterUnlink?.(Object.freeze([...released]));
    mutexLease?.assertAlive();
    await writeState(next, {
      directory: stateDirectory,
      file: canonicalJournal,
      mutexHeld: true,
      mutexLease,
      expectedRevision: sourceRevision,
      targetRevision: sourceRevision + 1,
      releaseCapability: releaseGuard.writeCapability,
    });
    releaseJournalWriteCapabilities.delete(releaseGuard.writeCapability);
    mutexLease?.assertAlive();
    const durableAfterRelease = JSON.parse(await readFile(canonicalJournal, "utf8"));
    if (sha256(durableAfterRelease) !== targetHash) {
      throw Object.assign(new Error("Reconciliation journal differs from the guarded release target"), {
        code: "reconciliation_journal_changed",
      });
    }
    replaceRecord(state, next);
    await beforeGuardRelease?.(Object.freeze({
      journalPath: canonicalJournal,
      targetJournalHash: targetHash,
      released: Object.freeze([...released]),
    }));
    mutexLease?.assertAlive();
    await releaseGuard.release();
    return released;
  } catch (error) {
    if (!destructive) {
      try { await releaseGuard.release(); } catch (guardError) {
        error.releaseGuardError = guardError?.code || "state_release_guard_mismatch";
      }
    }
    releaseJournalWriteCapabilities.delete(releaseGuard.writeCapability);
    error.releaseGuardRetained = destructive;
    throw error;
  }
}

async function recoverKnownUnstartedOpenExecution(
  state,
  {
    journal,
    stateDirectory = journalDirectory,
    errorCode = "execution_blocked_before_launch",
    now = Date.now(),
    releaseLocks = releaseReconciledLocks,
    writeState = writeReconciliationJournal,
  } = {},
) {
  const consent = asObject(state?.tradeConsent);
  const argvConsistent = state?.executionArgv == null && state?.executionArgvHash == null || (
    Array.isArray(state?.executionArgv) && state.executionArgv.length > 0 &&
    HASH_RE.test(String(state?.executionArgvHash || "")) && sha256(state.executionArgv) === state.executionArgvHash &&
    consent?.executionArgvHash === state.executionArgvHash
  );
  if (
    state?.mode !== "open" || state?.reconciliationRequired !== true ||
    !new Set(["execution_lock_acquired", "execution_attempted", "execution_blocked_before_launch"]).has(state?.stage) ||
    !consent || !HASH_RE.test(String(state?.replayKey || "")) || !state?.replayLockPath ||
    !state?.executionLockPath || state?.executionLockPurpose !== "OPEN_PLACE" ||
    state?.executionLockRecoveryNotBefore !== consent.expiresAt || !argvConsistent ||
    state?.liveResult != null || state?.orderId != null || state?.settlementTx != null
  ) {
    throw Object.assign(new Error("OPEN is not a known-unstarted in-process checkpoint"), {
      code: "unsafe_prelaunch_recovery",
    });
  }
  await verifyJournalLockOwnership(state, {
    stateDirectory,
    journal,
    fields: ["replayLockPath", "executionLockPath"],
    requirePresent: true,
  });
  const releasedLocks = await releaseLocks(state, {
    stateDirectory,
    journal,
    fields: ["executionLockPath"],
    writeState,
    now,
    transitionId: "open-known-unstarted-recovery-v1",
    transition: (next, { releasedAt }) => {
      next.stage = "execution_blocked_before_launch";
      next.executionArgv = null;
      next.executionArgvHash = null;
      next.executionAttemptedAt = null;
      next.reconciliationRequired = true;
      next.executionBlockedBeforeLaunch = {
        code: String(errorCode || "execution_blocked_before_launch"),
        at: releasedAt,
        liveProcessStarted: false,
        replayLockRetained: true,
      };
    },
  });
  if (releasedLocks.length !== 1 || state.executionLockPath) {
    throw Object.assign(new Error("OPEN execution lock was not released exactly once"), {
      code: "execution_lock_release_failed",
    });
  }
  return Object.freeze({
    ok: true,
    status: state.stage,
    replayLockRetained: true,
    releasedLocks: Object.freeze(releasedLocks),
  });
}

/**
 * Restore a paid CLOSE to its sole resumable checkpoint when every failure is
 * known to have happened before the live child process started. The replay
 * lock deliberately remains in place, so neither a second payment nor a
 * second order can be started outside `resume-close`.
 */
export async function recoverKnownUnstartedCloseExecution(
  state,
  {
    journal,
    stateDirectory = journalDirectory,
    errorCode = "execution_blocked_before_launch",
    now = Date.now(),
    releaseLocks = releaseReconciledLocks,
    writeState = writeReconciliationJournal,
  } = {},
) {
  const consent = asObject(state?.tradeConsent);
  const argvConsistent = state?.executionArgv == null && state?.executionArgvHash == null || (
    Array.isArray(state?.executionArgv) && state.executionArgv.length > 0 &&
    HASH_RE.test(String(state?.executionArgvHash || "")) && sha256(state.executionArgv) === state.executionArgvHash &&
    consent?.executionArgvHash === state.executionArgvHash
  );
  if (
    state?.mode !== "close" || state?.reconciliationRequired !== true ||
    !new Set(["execution_lock_acquired", "execution_attempted", "execution_blocked_before_launch"]).has(state?.stage) ||
    !consent || !HASH_RE.test(String(state.replayKey || "")) ||
    !state.replayLockPath || !state.executionLockPath ||
    state.executionLockPurpose !== "CLOSE_PLACE" ||
    state.executionLockRecoveryNotBefore !== consent.expiresAt ||
    !UUID_RE.test(String(state.executionLockGeneration || "")) ||
    !HASH_RE.test(String(state.executionLockHash || "")) || !argvConsistent ||
    state.liveResult != null || state.orderId != null || state.settlementTx != null
  ) {
    throw Object.assign(new Error("CLOSE is not a known-unstarted resumable checkpoint"), {
      code: "unsafe_prelaunch_recovery",
    });
  }
  // Prove that clearing only the known-unstarted execution markers produces
  // the exact checkpoint accepted by `resume-close` before releasing a lock.
  requireExactResumeCheckpoint({
    ...state,
    stage: "trade_confirmed",
    executionArgv: null,
    executionArgvHash: null,
    executionAttemptedAt: null,
    executionLockPath: null,
    executionLockGeneration: null,
    executionLockHash: null,
    executionLockPurpose: null,
    executionLockRecoveryNotBefore: null,
  }, journal);
  await verifyJournalLockOwnership(state, {
    stateDirectory,
    journal,
    fields: ["replayLockPath", "executionLockPath"],
    requirePresent: true,
  });
  const releasedLocks = await releaseLocks(state, {
    stateDirectory,
    journal,
    fields: ["executionLockPath"],
    writeState,
    now,
    transitionId: "close-known-unstarted-recovery-v1",
    transition: (next, { releasedAt }) => {
      next.stage = "trade_confirmed";
      next.executionArgv = null;
      next.executionArgvHash = null;
      next.executionAttemptedAt = null;
      next.reconciliationRequired = true;
      next.executionBlockedBeforeLaunch = {
        code: String(errorCode || "execution_blocked_before_launch"),
        at: releasedAt,
        liveProcessStarted: false,
        replayLockRetained: true,
      };
    },
  });
  if (releasedLocks.length !== 1 || state.executionLockPath) {
    throw Object.assign(new Error("CLOSE execution lock was not released exactly once"), {
      code: "execution_lock_release_failed",
    });
  }
  return Object.freeze({
    ok: true,
    status: state.stage,
    resumable: true,
    replayLockRetained: true,
    releasedLocks: Object.freeze(releasedLocks),
  });
}

async function releaseUnsentReplayLock(state, { journal = journalPath } = {}) {
  try {
    await releaseReconciledLocks(state, {
      journal,
      fields: ["replayLockPath"],
      transitionId: "unsent-payment-replay-release-v1",
      transition: (next, { releasedAt }) => {
        next.replayKey = null;
        next.replayLockReleaseError = null;
      },
    });
  } catch (error) {
    state.replayLockReleaseError = error?.code || "lock_release_failed";
    state.reconciliationRequired = true;
    throw Object.assign(new Error("Unsent payment replay lock could not be released safely"), {
      code: "replay_lock_release_failed",
      cause: error,
    });
  }
}

function validatePersistedLiveExecution(state, {
  journal,
  mode,
  validated,
} = {}) {
  const confirmationAt = Date.parse(String(state?.tradeConfirmedAt || ""));
  const expiresAt = Date.parse(String(validated?.expiresAt || ""));
  const paymentProof = asObject(state?.paymentProof);
  if (
    state?.mode !== mode || resolve(String(state.journalPath || "")) !== journal ||
    state.reconciliationRequired !== true || !state.executionLockPath ||
    !asObject(state.paidCard) || !asObject(state.liveResult) ||
    !HASH_RE.test(String(state.paymentTx || "")) ||
    paymentProof?.transactionHash !== state.paymentTx ||
    !HASH_RE.test(String(state.intentHash || "")) || state.intentHash !== validated.intentHash ||
    !Array.isArray(state.executionArgv) || state.executionArgv.length === 0 ||
    state.executionArgv.some((value) => typeof value !== "string") ||
    !HASH_RE.test(String(state.executionArgvHash || "")) ||
    sha256(state.executionArgv) !== state.executionArgvHash ||
    sha256(validated.executionCard.argv) !== state.executionArgvHash ||
    !ADDRESS_RE.test(String(state.paymentPayer || "")) || state.paymentPayer !== String(state.paymentPayer).toLowerCase() ||
    !ADDRESS_RE.test(String(state.buyerWallet || "")) || state.buyerWallet !== validated.wallet ||
    !Number.isFinite(confirmationAt) || !Number.isFinite(expiresAt) || confirmationAt >= expiresAt
  ) {
    throw Object.assign(new Error(`${mode.toUpperCase()} live checkpoint is incomplete or internally inconsistent`), {
      code: "invalid_reconciliation_journal",
    });
  }
  const paidAt = Number(BigInt(paymentProof.blockTimestamp ?? -1) * 1_000n);
  if (!Number.isSafeInteger(paidAt) || confirmationAt < paidAt) {
    throw Object.assign(new Error(`${mode.toUpperCase()} confirmation predates its verified payment`), {
      code: "invalid_reconciliation_journal",
    });
  }
  return Object.freeze({ confirmationAt, expiresAt, paidAt });
}

export async function reconcileOpenJournal({
  file,
  trustedIssuers,
  now = Date.now(),
  verifyPosition = fetchAndVerifyPosition,
  validateCardImpl = validateCard,
  buildReceiptRequestImpl = buildReceiptRequest,
  validateProofImpl = validateProof,
  validateTerminalResultImpl = validateTerminalZeroOpenResult,
  fetchExactOrderImpl = fetchExactOrder,
  verifyTerminalOrderImpl = verifyTerminalZeroFillOrder,
  authorizationStateImpl = fetchEip3009AuthorizationState,
  reconcileUnattachedExecutionLockImpl = reconcileUnattachedExecutionLock,
  stateDirectory = journalDirectory,
} = {}) {
  const journal = safeStatePath(file, "journal", stateDirectory);
  await resumePendingStateRelease({ journal, stateDirectory });
  const state = JSON.parse(await readFile(journal, "utf8"));
  if (state?.mode !== "open") {
    throw Object.assign(new Error("Journal is not a Conviction OPEN journey"), {
      code: "invalid_reconciliation_journal",
    });
  }
  if (state.paymentTx != null || state.paymentProof != null || state.paidCard != null) {
    try {
      await verifyStoredPaymentTransactionClaim({ state, service: POSITION_CARD_SERVICE, stateDirectory });
    } catch (error) {
      if (error?.code !== "payment_claim_missing_or_mismatched") throw error;
      return {
        ok: true,
        status: "manual_reconciliation_required",
        reason: "payment_verification_missing_or_mismatched",
        reconciliationRequired: true,
        journalPath: journal,
        stage: state.stage,
      };
    }
  }

  if (isRecoverablePaymentAuthorizationState(state)) {
    if (state.replayKey !== openReplayKey({ request: state.request, buyerWallet: state.buyerWallet })) {
      throw Object.assign(new Error("OPEN payment replay identity differs from its reserved request"), {
        code: "invalid_replay_key",
      });
    }
    const authorization = validateStoredPaymentAuthorization(state.paymentAuthorization, {
      paymentPayer: state.paymentPayer,
      service: POSITION_CARD_SERVICE,
    });
    const expiresAtMs = Number(BigInt(authorization.validBefore) * 1_000n);
    if (now <= expiresAtMs) {
      return {
        ok: true,
        status: "waiting_for_authorization_expiry",
        expiresAt: new Date(expiresAtMs).toISOString(),
        reconciliationRequired: true,
        journalPath: journal,
      };
    }
    const authorizationState = await authorizationStateImpl(authorization);
    if (BigInt(authorizationState?.blockTimestamp ?? -1) <= BigInt(authorization.validBefore)) {
      return {
        ok: true,
        status: "waiting_for_authorization_expiry",
        expiresAt: new Date(expiresAtMs).toISOString(),
        reconciliationRequired: true,
        journalPath: journal,
      };
    }
    if (authorizationState?.used !== false) {
      return {
        ok: true,
        status: "manual_reconciliation_required",
        reason: "payment_authorization_consumed_or_ambiguous",
        reconciliationRequired: true,
        journalPath: journal,
        stage: state.stage,
      };
    }
    const releasedLocks = await releaseReconciledLocks(state, {
      stateDirectory,
      journal,
      fields: ["replayLockPath"],
      now,
      transitionId: "open-expired-authorization-reconciliation-v1",
      transition: (next, { releasedAt }) => {
        next.reconciliationAuthorizationState = authorizationState;
        next.stage = "expired_unsettled_authorization_reconciled";
        next.reconciliationRequired = false;
        next.reconciledAt = releasedAt;
        next.reconciliationReason = "expired_unsettled_authorization";
      },
    });
    return {
      ok: true,
      status: state.stage,
      reconciliationRequired: false,
      journalPath: journal,
      releasedLocks,
    };
  }

  if (!state.executionArgvHash && state.paidCard) {
    if (
      !new Set([
        "payment_verified",
        "trade_confirmed",
        "execution_lock_acquired",
        "execution_blocked_before_launch",
      ]).has(state.stage) ||
      !exactStoredServicePayment(state, POSITION_CARD_SERVICE)
    ) {
      return {
        ok: true,
        status: "manual_reconciliation_required",
        reason: "payment_verification_missing_or_mismatched",
        reconciliationRequired: true,
        journalPath: journal,
        stage: state.stage,
      };
    }
    const validated = validateCardImpl(state.paidCard, {
      trustedIssuers,
      allowExpired: true,
      now,
    });
    const expectedReplayKey = openReplayKey({ request: state.request, buyerWallet: state.buyerWallet });
    if (
      state.replayKey !== expectedReplayKey || validated.wallet !== state.buyerWallet ||
      validated.outcome !== String(state.request?.side || "").toUpperCase() ||
      BigInt(validated.bounds?.requestedBudgetRaw ?? -1) !== parseDecimal(state.request?.budget, 6, "open request budget") ||
      parseDecimal(validated.bounds?.maxPrice, 6, "open card maximum price") !==
        parseDecimal(state.request?.maxPrice, 6, "open request maximum price")
    ) {
      throw Object.assign(new Error("Paid OPEN card differs from its reserved buyer request"), {
        code: "invalid_replay_key",
      });
    }
    await verifyJournalLockOwnership(state, {
      stateDirectory,
      journal,
      fields: ["replayLockPath"],
      requirePresent: true,
    });
    if (state.executionLockPath) {
      requireExactAttachedExecutionA0(state, {
        mode: "open",
        expectedPurpose: "OPEN_PLACE",
        recoveryNotBefore: validated.expiresAt,
      });
      await verifyJournalLockOwnership(state, {
        stateDirectory,
        journal,
        fields: ["executionLockPath"],
        requirePresent: true,
      });
    } else {
      requireExactNoLockExecutionA0(state, { journal, mode: "open", validated });
    }
    let unattachedExecutionLock = Object.freeze({ released: false, path: null, generationHash: null });
    if (state.stage === "trade_confirmed" && state.executionLockPath == null) {
      unattachedExecutionLock = await reconcileUnattachedExecutionLockImpl({
        file: join(stateDirectory, basename(executionLockFile)),
        journal,
        directory: stateDirectory,
        expectedJournalHash: sha256(state),
        expectedPurposes: ["OPEN_PLACE"],
      });
    }
    if (Date.parse(validated.expiresAt) > now) {
      return {
        ok: true,
        status: "waiting_for_card_expiry",
        expiresAt: validated.expiresAt,
        reconciliationRequired: true,
        journalPath: journal,
        unattachedExecutionLockReleased: unattachedExecutionLock.released,
      };
    }
    const releasedLocks = await releaseReconciledLocks(state, {
      stateDirectory,
      journal,
      fields: ["replayLockPath", "executionLockPath"],
      now,
      transitionId: "open-expired-unexecuted-reconciliation-v1",
      transition: (next, { releasedAt }) => {
        next.stage = "expired_unexecuted_reconciled";
        next.reconciliationRequired = false;
        next.reconciledAt = releasedAt;
        next.reconciliationReason = "expired_without_execution";
      },
    });
    return {
      ok: true,
      status: state.stage,
      reconciliationRequired: false,
      journalPath: journal,
      releasedLocks: unattachedExecutionLock.released
        ? [unattachedExecutionLock.path, ...releasedLocks]
        : releasedLocks,
      unattachedExecutionLockReleased: unattachedExecutionLock.released,
    };
  }

  const validated = validateCardImpl(state.paidCard, {
    trustedIssuers,
    allowExpired: true,
    now,
  });
  const executionWindow = validatePersistedLiveExecution(state, { journal, mode: "open", validated });
  await verifyJournalLockOwnership(state, {
    stateDirectory,
    journal,
    fields: ["replayLockPath", "executionLockPath"],
    requirePresent: true,
  });

  let status;
  let proof;
  let terminal;
  if (HASH_RE.test(String(state.orderId || "")) && HASH_RE.test(String(state.settlementTx || ""))) {
    const request = buildReceiptRequestImpl(state.paidCard, state.liveResult, { trustedIssuers });
    if (
      request?.orderId !== state.orderId || request?.transactionHash !== state.settlementTx ||
      request?.intentHash !== validated.intentHash
    ) {
      throw Object.assign(new Error("Persisted OPEN settlement identity differs from the signed live result"), {
        code: "open_live_identity_mismatch",
      });
    }
    const document = await verifyPosition(state.settlementTx, {
      intent: request.intent,
      intentHash: request.intentHash,
      orderId: request.orderId,
      issuance: request.issuance,
      trustedIssuers,
    });
    const settledAt = Date.parse(String(document?.positionProof?.settledAt || ""));
    if (
      !Number.isFinite(settledAt) ||
      Math.floor(settledAt / 1_000) <= Math.floor(executionWindow.confirmationAt / 1_000)
    ) {
      throw Object.assign(new Error("Independent OPEN settlement predates the recorded trade confirmation"), {
        code: "settlement_before_confirmation",
      });
    }
    proof = validateProofImpl(state.paidCard, document, { trustedIssuers });
    if (
      proof?.orderId !== state.orderId || proof?.transactionHash !== state.settlementTx ||
      !HASH_RE.test(String(proof?.positionProofHash || ""))
    ) {
      throw Object.assign(new Error("Independent OPEN proof differs from the persisted live settlement"), {
        code: "open_proof_mismatch",
      });
    }
    status = "complete_reconciled";
  } else if (HASH_RE.test(String(state.orderId || "")) && !state.settlementTx) {
    const live = validateTerminalResultImpl(state.paidCard, state.liveResult, { trustedIssuers });
    if (live.orderId !== state.orderId || live.validated.intentHash !== validated.intentHash) {
      throw Object.assign(new Error("Persisted terminal OPEN identity differs from the signed live result"), {
        code: "open_live_identity_mismatch",
      });
    }
    const snapshot = await fetchExactOrderImpl({
      signerAddress: state.paymentPayer,
      depositWallet: state.buyerWallet,
      orderId: state.orderId,
      outcomeTokenId: validated.tokenId,
    });
    terminal = verifyTerminalOrderImpl({
      action: "OPEN",
      signerAddress: state.paymentPayer,
      wallet: state.buyerWallet,
      live,
      snapshot,
      confirmedAt: state.tradeConfirmedAt,
      expiresAt: validated.expiresAt,
      now,
    });
    if (
      terminal?.ok !== true || terminal.proof?.orderId !== state.orderId ||
      terminal.proof?.intentHash !== validated.intentHash ||
      !HASH_RE.test(String(terminal.proofHash || ""))
    ) {
      throw Object.assign(new Error("Terminal OPEN proof differs from the signed live result"), {
        code: "terminal_zero_proof_mismatch",
      });
    }
    status = "terminal_zero_fill_reconciled";
  } else {
    return {
      ok: true,
      status: "manual_reconciliation_required",
      reconciliationRequired: true,
      journalPath: journal,
      stage: state.stage,
      orderId: state.orderId || null,
      settlementTx: state.settlementTx || null,
    };
  }

  const releasedLocks = await releaseReconciledLocks(state, {
    stateDirectory,
    journal,
    fields: ["replayLockPath", "executionLockPath"],
    now,
    transitionId: "open-terminal-reconciliation-v1",
    transition: (next, { releasedAt }) => {
      next.stage = status;
      next.reconciliationRequired = false;
      next.reconciledAt = releasedAt;
      next.reconciliationReason = proof ? "verified_settlement" : "authenticated_terminal_zero_fill";
      if (proof) {
        next.positionProofHash = proof.positionProofHash;
        next.positionPassportHash = proof.positionPassportHash || null;
      } else {
        next.terminalZeroFillProof = terminal.proof;
        next.terminalZeroFillProofHash = terminal.proofHash;
      }
    },
  });
  if (releasedLocks.length !== 2) {
    throw Object.assign(new Error("OPEN reconciliation did not release its replay and execution locks"), {
      code: "execution_lock_release_failed",
    });
  }
  return {
    ok: true,
    status,
    reconciliationRequired: false,
    journalPath: journal,
    orderId: state.orderId,
    settlementTx: state.settlementTx || null,
    releasedLocks,
    ...(proof ? {
      positionProofHash: proof.positionProofHash,
      positionPassportHash: proof.positionPassportHash || null,
    } : {
      terminalZeroFillProofHash: terminal.proofHash,
      matchedSharesRaw: "0",
    }),
  };
}

export async function reconcileCloseJournal({
  file,
  trustedIssuers,
  now = Date.now(),
  verifyClose = fetchAndVerifyClose,
  validateCardImpl = validateCloseCard,
  validateTerminalResultImpl = validateTerminalZeroCloseResult,
  fetchExactOrderImpl = fetchExactOrder,
  verifyTerminalOrderImpl = verifyTerminalZeroFillOrder,
  authorizationStateImpl = fetchEip3009AuthorizationState,
  reconcileUnattachedExecutionLockImpl = reconcileUnattachedExecutionLock,
  stateDirectory = journalDirectory,
} = {}) {
  const journal = safeStatePath(file, "journal", stateDirectory);
  await resumePendingStateRelease({ journal, stateDirectory });
  const state = JSON.parse(await readFile(journal, "utf8"));
  if (state?.mode !== "close") {
    throw Object.assign(new Error("Journal is not a Conviction CLOSE journey"), { code: "invalid_reconciliation_journal" });
  }
  if (state.paymentTx != null || state.paymentProof != null || state.paidCard != null) {
    try {
      await verifyStoredPaymentTransactionClaim({ state, service: POSITION_MANAGER_SERVICE, stateDirectory });
    } catch (error) {
      if (error?.code !== "payment_claim_missing_or_mismatched") throw error;
      return {
        ok: true,
        status: "manual_reconciliation_required",
        reason: "payment_verification_missing_or_mismatched",
        reconciliationRequired: true,
        journalPath: journal,
        stage: state.stage,
      };
    }
  }

  let reason;
  let proof;
  let terminal;
  let reconciledAuthorizationState;
  let unattachedExecutionLock = Object.freeze({ released: false, path: null, generationHash: null });
  if (HASH_RE.test(String(state.settlementTx || "")) && HASH_RE.test(String(state.orderId || "")) && state.paidCard) {
    proof = await verifyClose(state.settlementTx, {
      intent: state.paidCard.intent,
      intentHash: state.paidCard.intentHash,
      orderId: state.orderId,
      issuance: state.paidCard.issuance,
      trustedIssuers,
    });
    const confirmedAt = Date.parse(String(state.tradeConfirmedAt || ""));
    const settledAt = Date.parse(String(proof?.closeProof?.settledAt || ""));
    if (
      !Number.isFinite(confirmedAt) || !Number.isFinite(settledAt) ||
      Math.floor(settledAt / 1_000) <= Math.floor(confirmedAt / 1_000)
    ) {
      throw Object.assign(new Error("Verified CLOSE settlement does not strictly postdate trade confirmation"), {
        code: "settlement_before_confirmation",
      });
    }
    reason = "verified_settlement";
  } else if (
    HASH_RE.test(String(state.orderId || "")) && !state.settlementTx &&
    state.paidCard && state.liveResult && state.executionArgvHash
  ) {
    const validated = validateCardImpl(state.paidCard, {
      trustedIssuers,
      allowExpired: true,
      now,
    });
    validatePersistedLiveExecution(state, { journal, mode: "close", validated });
    const request = resumeRequest(state);
    bindCloseCardToRequest(validated, {
      market: {
        conditionId: validated.intent?.market?.conditionId,
        outcomeTokenId: validated.tokenId,
      },
      source: {
        ...validated.intent?.source,
        wallet: state.buyerWallet,
        marketConditionId: validated.intent?.market?.conditionId,
        outcome: validated.outcome,
        outcomeTokenId: validated.tokenId,
      },
    }, request, state.buyerWallet);
    const expectedReplayKey = closeReplayKey({ request, sellerWallet: state.buyerWallet });
    if (state.replayKey !== expectedReplayKey) {
      throw Object.assign(new Error("Terminal CLOSE replay identity differs from its paid request"), {
        code: "invalid_replay_key",
      });
    }
    await verifyJournalLockOwnership(state, {
      stateDirectory,
      journal,
      fields: ["replayLockPath", "executionLockPath"],
      requirePresent: true,
    });
    const live = validateTerminalResultImpl(state.paidCard, state.liveResult, { trustedIssuers });
    if (live.orderId !== state.orderId || live.validated.intentHash !== validated.intentHash) {
      throw Object.assign(new Error("Persisted terminal CLOSE identity differs from the signed live result"), {
        code: "close_live_identity_mismatch",
      });
    }
    const snapshot = await fetchExactOrderImpl({
      signerAddress: state.paymentPayer,
      depositWallet: state.buyerWallet,
      orderId: state.orderId,
      outcomeTokenId: validated.tokenId,
    });
    terminal = verifyTerminalOrderImpl({
      action: "CLOSE",
      signerAddress: state.paymentPayer,
      wallet: state.buyerWallet,
      live,
      snapshot,
      confirmedAt: state.tradeConfirmedAt,
      expiresAt: validated.expiresAt,
      now,
    });
    if (
      terminal?.ok !== true || terminal.proof?.orderId !== state.orderId ||
      terminal.proof?.intentHash !== validated.intentHash ||
      !HASH_RE.test(String(terminal.proofHash || ""))
    ) {
      throw Object.assign(new Error("Terminal CLOSE proof differs from the signed live result"), {
        code: "terminal_zero_proof_mismatch",
      });
    }
    reason = "authenticated_terminal_zero_fill";
  } else if (!state.executionArgvHash && state.paidCard) {
    if (
      !new Set([
        "payment_verified",
        "trade_confirmed",
        "execution_lock_acquired",
        "resume_execution_lock_acquired",
        "execution_blocked_before_launch",
      ]).has(state.stage) ||
      !exactStoredServicePayment(state, POSITION_MANAGER_SERVICE)
    ) {
      return {
        ok: true,
        status: "manual_reconciliation_required",
        reason: "payment_verification_missing_or_mismatched",
        reconciliationRequired: true,
        journalPath: journal,
        stage: state.stage,
      };
    }
    const card = validateCardImpl(state.paidCard, {
      trustedIssuers,
      allowExpired: true,
      now,
    });
    if (state.stage === "payment_verified" && state.executionLockPath) {
      throw Object.assign(new Error("Unconfirmed CLOSE payment cannot own an execution lock"), {
        code: "invalid_unstarted_checkpoint",
      });
    }
    if (state.stage === "payment_verified") {
      requireExactNoLockExecutionA0(state, { journal, mode: "close", validated: card });
    }
    if (state.stage !== "payment_verified") {
      const request = resumeRequest(state);
      bindCloseCardToRequest(card, {
        market: {
          conditionId: card.intent?.market?.conditionId,
          outcomeTokenId: card.tokenId,
        },
        source: {
          ...card.intent?.source,
          wallet: state.buyerWallet,
          marketConditionId: card.intent?.market?.conditionId,
          outcome: card.outcome,
          outcomeTokenId: card.tokenId,
        },
      }, request, state.buyerWallet);
      const expectedReplayKey = closeReplayKey({ request, sellerWallet: state.buyerWallet });
      if (state.replayKey !== expectedReplayKey) {
        throw Object.assign(new Error("Paid CLOSE replay identity differs from its confirmed request"), {
          code: "invalid_replay_key",
        });
      }
      await verifyJournalLockOwnership(state, {
        stateDirectory,
        journal,
        fields: ["replayLockPath"],
        requirePresent: true,
      });
      if (state.executionLockPath) {
        const expectedPurpose = state.stage === "resume_execution_lock_acquired"
          ? "CLOSE_RESUME"
          : "CLOSE_PLACE";
        requireExactAttachedExecutionA0(state, {
          mode: "close",
          expectedPurpose,
          recoveryNotBefore: card.expiresAt,
        });
        await verifyJournalLockOwnership(state, {
          stateDirectory,
          journal,
          fields: ["executionLockPath"],
          requirePresent: true,
        });
      } else {
        requireExactNoLockExecutionA0(state, { journal, mode: "close", validated: card });
      }
    }
    if (state.stage === "trade_confirmed" && state.executionLockPath == null) {
      validatePersistedUnattachedTradeConsent(state, { journal, mode: "close", validated: card });
      unattachedExecutionLock = await reconcileUnattachedExecutionLockImpl({
        file: join(stateDirectory, basename(executionLockFile)),
        journal,
        directory: stateDirectory,
        expectedJournalHash: sha256(state),
        expectedPurposes: ["CLOSE_PLACE", "CLOSE_RESUME"],
      });
    }
    if (Date.parse(card.expiresAt) > now) {
      return {
        ok: true,
        status: "waiting_for_card_expiry",
        expiresAt: card.expiresAt,
        reconciliationRequired: true,
        journalPath: journal,
        unattachedExecutionLockReleased: unattachedExecutionLock.released,
      };
    }
    reason = "expired_without_execution";
  } else if (isRecoverablePaymentAuthorizationState(state)) {
    const authorization = validateStoredPaymentAuthorization(state.paymentAuthorization, {
      paymentPayer: state.paymentPayer,
      service: POSITION_MANAGER_SERVICE,
    });
    if (now <= Number(BigInt(authorization.validBefore) * 1_000n)) {
      return {
        ok: true,
        status: "waiting_for_authorization_expiry",
        expiresAt: new Date(Number(BigInt(authorization.validBefore) * 1_000n)).toISOString(),
        reconciliationRequired: true,
        journalPath: journal,
      };
    }
    const authorizationState = await authorizationStateImpl(authorization);
    if (BigInt(authorizationState?.blockTimestamp ?? -1) <= BigInt(authorization.validBefore)) {
      return {
        ok: true,
        status: "waiting_for_authorization_expiry",
        expiresAt: new Date(Number(BigInt(authorization.validBefore) * 1_000n)).toISOString(),
        reconciliationRequired: true,
        journalPath: journal,
      };
    }
    if (authorizationState?.used !== false) {
      return {
        ok: true,
        status: "manual_reconciliation_required",
        reason: "payment_authorization_consumed_or_ambiguous",
        reconciliationRequired: true,
        journalPath: journal,
        stage: state.stage,
      };
    }
    reconciledAuthorizationState = authorizationState;
    reason = "expired_unsettled_authorization";
  } else {
    return {
      ok: true,
      status: "manual_reconciliation_required",
      reconciliationRequired: true,
      journalPath: journal,
      stage: state.stage,
      paymentTx: state.paymentTx || null,
      orderId: state.orderId || null,
      settlementTx: state.settlementTx || null,
    };
  }

  const releasedLocks = await releaseReconciledLocks(state, {
    stateDirectory,
    journal,
    fields: reason === "expired_unsettled_authorization"
      ? ["replayLockPath"]
      : ["replayLockPath", "executionLockPath"],
    now,
    transitionId: "close-terminal-reconciliation-v1",
    transition: (next, { releasedAt }) => {
      next.stage = reason === "verified_settlement"
        ? "complete_reconciled"
        : reason === "authenticated_terminal_zero_fill"
          ? "terminal_zero_fill_reconciled"
          : reason === "expired_unsettled_authorization"
            ? "expired_unsettled_authorization_reconciled"
            : "expired_unexecuted_reconciled";
      next.reconciliationRequired = false;
      next.reconciledAt = releasedAt;
      next.reconciliationReason = reason;
      if (reason === "expired_unsettled_authorization") {
        next.reconciliationAuthorizationState = reconciledAuthorizationState;
      }
      if (proof) {
        next.closeProofHash = proof.closeProofHash;
        next.closePassportHash = proof.closePassportHash;
      }
      if (terminal) {
        next.terminalZeroFillProof = terminal.proof;
        next.terminalZeroFillProofHash = terminal.proofHash;
      }
    },
  });
  return {
    ok: true,
    status: state.stage,
    reconciliationRequired: false,
    journalPath: journal,
    releasedLocks: unattachedExecutionLock.released
      ? [unattachedExecutionLock.path, ...releasedLocks]
      : releasedLocks,
    unattachedExecutionLockReleased: unattachedExecutionLock.released,
    ...(proof ? {
      transactionHash: proof.closeProof.transactionHash,
      closeProofHash: proof.closeProofHash,
      closePassportHash: proof.closePassportHash,
    } : terminal ? {
      orderId: state.orderId,
      terminalZeroFillProofHash: terminal.proofHash,
      matchedSharesRaw: "0",
    } : {}),
  };
}

function resumeInvariant(condition, code, message) {
  if (!condition) throw Object.assign(new Error(message), { code });
}

function resumeRequest(state) {
  const stored = asObject(state?.request);
  const sourcePosition = normalizeSourcePosition(
    firstObject(state?.sourcePosition, stored?.sourcePosition),
  );
  resumeInvariant(stored, "invalid_resume_checkpoint", "Paid CLOSE journal has no request");
  if (state?.sourcePosition && stored.sourcePosition) {
    resumeInvariant(
      sha256(normalizeSourcePosition(state.sourcePosition)) ===
        sha256(normalizeSourcePosition(stored.sourcePosition)),
      "invalid_resume_checkpoint",
      "Paid CLOSE journal contains conflicting source proofs",
    );
  }
  const request = {
    market: String(stored.market || "").trim(),
    outcome: String(stored.outcome || stored.side || "").toUpperCase(),
    shares: String(stored.shares || ""),
    minPrice: String(stored.minPrice || ""),
    rationale: String(stored.rationale || ""),
    sourcePosition,
    source: {
      intentHash: sourcePosition.intentHash,
      positionProofHash: sourcePosition.positionProofHash,
      transactionHash: sourcePosition.transactionHash,
      orderId: sourcePosition.orderId,
    },
  };
  resumeInvariant(request.market, "invalid_resume_checkpoint", "Paid CLOSE journal has no market");
  resumeInvariant(request.outcome === "YES" || request.outcome === "NO", "invalid_resume_checkpoint", "Paid CLOSE outcome is invalid");
  const sharesRaw = parseDecimal(request.shares, 6, "resume CLOSE shares");
  const minPriceRaw = parseDecimal(request.minPrice, 6, "resume CLOSE minimum price");
  resumeInvariant(sharesRaw > 0n && sharesRaw % 1_000_000n === 0n, "invalid_resume_checkpoint", "Paid CLOSE shares are invalid");
  resumeInvariant(minPriceRaw > 0n && minPriceRaw < 1_000_000n, "invalid_resume_checkpoint", "Paid CLOSE minimum price is invalid");
  resumeInvariant(
    String(stored.sourceIntentHash || "").toLowerCase() === sourcePosition.intentHash &&
      String(stored.sourcePositionProofHash || "").toLowerCase() === sourcePosition.positionProofHash,
    "invalid_resume_checkpoint",
    "Paid CLOSE request source hashes differ from its source proof",
  );
  return { ...request, sharesRaw, minPriceRaw };
}

function bindResumeCard({ state, request, validated, verifiedSource }) {
  const source = request.sourcePosition;
  const signedSource = validated.intent?.source;
  const preview = {
    market: {
      conditionId: verifiedSource.marketConditionId,
      outcomeTokenId: verifiedSource.outcomeTokenId,
    },
    source: {
      ...verifiedSource,
      intentHash: source.intentHash,
      positionProofHash: source.positionProofHash,
      transactionHash: source.transactionHash,
      orderId: source.orderId,
    },
  };
  bindCloseCardToRequest(validated, preview, request, state.buyerWallet);
  resumeInvariant(
    verifiedSource.wallet === state.buyerWallet &&
      verifiedSource.outcome === request.outcome &&
      String(verifiedSource.outcomeTokenId) === String(validated.tokenId) &&
      BigInt(verifiedSource.actualSharesRaw) >= request.sharesRaw &&
      signedSource?.wallet === verifiedSource.wallet &&
      String(signedSource?.marketConditionId || "").toLowerCase() === verifiedSource.marketConditionId &&
      signedSource?.outcome === verifiedSource.outcome &&
      String(signedSource?.outcomeTokenId || "") === verifiedSource.outcomeTokenId &&
      String(signedSource?.actualSharesRaw || "") === verifiedSource.actualSharesRaw &&
      signedSource?.intentVersion === verifiedSource.intentVersion &&
      signedSource?.verificationMode === verifiedSource.verificationMode,
    "source_substitution",
    "Freshly verified source position cannot authorize this CLOSE",
  );
  resumeInvariant(
    String(state.intentHash || "").toLowerCase() === validated.intentHash &&
      String(state.sourceIntentHash || "").toLowerCase() === source.intentHash &&
      String(state.sourcePositionProofHash || "").toLowerCase() === source.positionProofHash,
    "invalid_resume_checkpoint",
    "Paid CLOSE journal hashes differ from the signed card or source proof",
  );
}

function validateResumeConsent({ state, validated, paymentProof, now }) {
  const consent = asObject(state.tradeConsent);
  const confirmedAt = Date.parse(String(consent?.confirmedAt || ""));
  const expiresAt = Date.parse(String(validated.expiresAt || ""));
  const issuedAt = Date.parse(String(validated.issuanceVerification?.issuedAt || ""));
  const paymentAt = Number(BigInt(paymentProof.blockTimestamp) * 1_000n);
  const argvHash = sha256(validated.executionCard.argv);
  resumeInvariant(
    consent?.version === "conviction-close-trade-consent-v1" &&
      consent.intentHash === validated.intentHash &&
      consent.executionArgvHash === argvHash &&
      consent.paymentTx === state.paymentTx &&
      consent.replayKey === state.replayKey &&
      consent.expiresAt === validated.expiresAt &&
      state.tradeConfirmedAt === consent.confirmedAt,
    "invalid_trade_consent",
    "Recorded trade consent is missing or does not bind the paid CLOSE",
  );
  resumeInvariant(
    Number.isFinite(confirmedAt) && Number.isFinite(expiresAt) && Number.isFinite(issuedAt) &&
      confirmedAt >= paymentAt && confirmedAt >= issuedAt && confirmedAt < expiresAt,
    "invalid_trade_consent",
    "Recorded trade consent is outside the paid card and payment window",
  );
  resumeInvariant(
    expiresAt - now >= 15_000,
    "insufficient_execution_window",
    "Paid CLOSE card has too little time remaining for safe resume",
  );
  return { consent, confirmedAt, expiresAt, argvHash };
}

function requireExactResumeCheckpoint(state, journal) {
  resumeInvariant(state?.mode === "close", "invalid_resume_checkpoint", "Journal is not a Conviction CLOSE journey");
  resumeInvariant(resolve(String(state.journalPath || "")) === journal, "invalid_resume_checkpoint", "Journal identity does not match its file");
  resumeInvariant(
    state.stage === "trade_confirmed" && state.reconciliationRequired === true,
    "invalid_resume_checkpoint",
    "Only an exact paid-and-confirmed pre-execution CLOSE checkpoint can resume",
  );
  resumeInvariant(
    !state.executionArgv && !state.executionArgvHash && state.executionAttemptedAt == null &&
      !state.executionLockPath && state.executionLockGeneration == null &&
      state.executionLockHash == null && state.executionLockPurpose == null &&
      state.executionLockRecoveryNotBefore == null &&
      !state.liveResult && !state.orderId && !state.settlementTx &&
      !state.closeProofHash && !state.closePassportHash,
    "ambiguous_execution",
    "CLOSE may already have crossed the execution boundary; reconcile it instead",
  );
  resumeInvariant(
    HASH_RE.test(String(state.paymentTx || "")) && asObject(state.paymentProof) &&
      asObject(state.paidCard) && HASH_RE.test(String(state.intentHash || "")) &&
      Number.isInteger(state.paidServiceResponse?.status) &&
      state.paidServiceResponse.status >= 200 && state.paidServiceResponse.status < 300 &&
      state.paidServiceResponse.paymentResponsePresent === true,
    "invalid_resume_checkpoint",
    "Paid CLOSE checkpoint is incomplete",
  );
  const requestedAt = Date.parse(String(state.paymentRequestedAt || ""));
  resumeInvariant(Number.isFinite(requestedAt), "invalid_resume_checkpoint", "Paid CLOSE checkpoint has no payment freshness boundary");
  resumeInvariant(
    ADDRESS_RE.test(String(state.paymentPayer || "")) && state.paymentPayer === String(state.paymentPayer).toLowerCase(),
    "invalid_resume_checkpoint",
    "Paid CLOSE payer is invalid or non-canonical",
  );
  resumeInvariant(
    ADDRESS_RE.test(String(state.buyerWallet || "")) && state.buyerWallet === String(state.buyerWallet).toLowerCase(),
    "invalid_resume_checkpoint",
    "Paid CLOSE seller is invalid or non-canonical",
  );
}

function validatePersistedUnattachedTradeConsent(state, {
  journal,
  mode,
  validated,
  allowedStages = ["trade_confirmed"],
} = {}) {
  const consent = asObject(state?.tradeConsent);
  const paymentProof = asObject(state?.paymentProof);
  const confirmationAt = Date.parse(String(state?.tradeConfirmedAt || ""));
  const expiresAt = Date.parse(String(validated?.expiresAt || ""));
  const paidAt = Number(BigInt(paymentProof?.blockTimestamp ?? -1) * 1_000n);
  const expectedConsentVersion = mode === "close"
    ? "conviction-close-trade-consent-v1"
    : "conviction-open-trade-consent-v1";
  const executionArgvHash = sha256(validated?.executionCard?.argv);
  if (
    state?.mode !== mode || !new Set(allowedStages).has(state?.stage) ||
    resolve(String(state?.journalPath || "")) !== journal || state?.reconciliationRequired !== true ||
    state?.executionLockPath != null || state?.executionLockGeneration != null ||
    state?.executionLockHash != null || state?.executionLockPurpose != null ||
    state?.executionLockRecoveryNotBefore != null ||
    state?.executionArgv != null || state?.executionArgvHash != null ||
    state?.executionAttemptedAt != null || state?.executionAttempted === true ||
    state?.liveResult != null || state?.orderId != null || state?.settlementTx != null ||
    state?.positionProofHash != null || state?.positionPassportHash != null ||
    state?.terminalZeroFillProof != null || state?.terminalZeroFillProofHash != null ||
    state?.closeProofHash != null || state?.closePassportHash != null ||
    !asObject(state?.paidCard) || !HASH_RE.test(String(state?.intentHash || "")) ||
    state.intentHash !== validated?.intentHash || !Array.isArray(validated?.executionCard?.argv) ||
    validated.executionCard.argv.length === 0 || !ADDRESS_RE.test(String(state?.paymentPayer || "")) ||
    state.paymentPayer !== String(state.paymentPayer).toLowerCase() ||
    !ADDRESS_RE.test(String(state?.buyerWallet || "")) || state.buyerWallet !== validated?.wallet ||
    consent?.version !== expectedConsentVersion || consent?.intentHash !== validated.intentHash ||
    consent?.executionArgvHash !== executionArgvHash || consent?.paymentTx !== state.paymentTx ||
    consent?.replayKey !== state.replayKey || consent?.confirmedAt !== state.tradeConfirmedAt ||
    consent?.expiresAt !== validated.expiresAt ||
    !Number.isSafeInteger(paidAt) || !Number.isFinite(confirmationAt) || !Number.isFinite(expiresAt) ||
    confirmationAt < paidAt || confirmationAt >= expiresAt
  ) {
    throw Object.assign(new Error(`${String(mode || "trade").toUpperCase()} unattached-lock checkpoint is incomplete or inconsistent`), {
      code: "unsafe_unattached_lock_recovery",
    });
  }
  return Object.freeze({ confirmationAt, expiresAt, paidAt, executionArgvHash });
}

function requireExactNoLockExecutionA0(state, { journal, mode, validated } = {}) {
  const noBinding = state?.executionLockPath == null && state?.executionLockGeneration == null &&
    state?.executionLockHash == null && state?.executionLockPurpose == null &&
    state?.executionLockRecoveryNotBefore == null;
  const noAttemptOrProof = state?.executionArgv == null && state?.executionArgvHash == null &&
    state?.executionAttemptedAt == null && state?.executionAttempted !== true &&
    state?.liveResult == null && state?.orderId == null && state?.settlementTx == null &&
    state?.positionProofHash == null && state?.positionPassportHash == null &&
    state?.terminalZeroFillProof == null && state?.terminalZeroFillProofHash == null &&
    state?.closeProofHash == null && state?.closePassportHash == null;
  if (!noBinding || !noAttemptOrProof || state?.mode !== mode || state?.reconciliationRequired !== true) {
    throw Object.assign(new Error(`${String(mode || "execution").toUpperCase()} no-lock checkpoint is not exact A0`), {
      code: "invalid_unstarted_checkpoint",
    });
  }
  if (state.stage === "payment_verified") {
    if (state?.tradeConsent != null || state?.tradeConfirmedAt != null) {
      throw Object.assign(new Error(`${mode.toUpperCase()} unconfirmed checkpoint contains trade consent`), {
        code: "invalid_unstarted_checkpoint",
      });
    }
    return;
  }
  const allowedStages = mode === "open"
    ? ["trade_confirmed", "execution_blocked_before_launch"]
    : ["trade_confirmed"];
  validatePersistedUnattachedTradeConsent(state, { journal, mode, validated, allowedStages });
  if (state.stage === "execution_blocked_before_launch" && (
    state?.executionBlockedBeforeLaunch?.liveProcessStarted !== false ||
    state?.executionBlockedBeforeLaunch?.replayLockRetained !== true ||
    !Number.isFinite(Date.parse(String(state?.executionBlockedBeforeLaunch?.at || "")))
  )) {
    throw Object.assign(new Error("OPEN prelaunch rollback marker is incomplete"), {
      code: "invalid_unstarted_checkpoint",
    });
  }
}

function requireExactAttachedExecutionA0(state, {
  mode,
  expectedPurpose,
  recoveryNotBefore,
} = {}) {
  const exactStage = expectedPurpose === "CLOSE_RESUME"
    ? state?.stage === "resume_execution_lock_acquired"
    : state?.stage === "execution_lock_acquired";
  const noAttemptOrProof = state?.executionArgv == null && state?.executionArgvHash == null &&
    state?.executionAttemptedAt == null && state?.executionAttempted !== true &&
    state?.liveResult == null && state?.orderId == null && state?.settlementTx == null &&
    state?.positionProofHash == null && state?.positionPassportHash == null &&
    state?.terminalZeroFillProof == null && state?.terminalZeroFillProofHash == null &&
    state?.closeProofHash == null && state?.closePassportHash == null;
  const legacyBinding = state?.executionLockGeneration == null && state?.executionLockHash == null &&
    state?.executionLockPurpose == null && state?.executionLockRecoveryNotBefore == null;
  const v2Binding = (
    state.executionLockPurpose === expectedPurpose &&
    state.executionLockRecoveryNotBefore === recoveryNotBefore &&
    UUID_RE.test(String(state.executionLockGeneration || "")) &&
    HASH_RE.test(String(state.executionLockHash || ""))
  );
  if (
    state?.mode !== mode || !exactStage || state?.reconciliationRequired !== true ||
    !state?.executionLockPath || !noAttemptOrProof || (!legacyBinding && !v2Binding)
  ) {
    throw Object.assign(new Error(`${String(mode || "execution").toUpperCase()} attached lock is not exact A0`), {
      code: "invalid_unstarted_checkpoint",
    });
  }
}

/**
 * Resume only the paid-and-confirmed, never-attempted CLOSE checkpoint. This
 * path deliberately has no payment adapter: it can reverify a payment but can
 * never create or submit another authorization.
 */
export async function resumePaidCloseJournal({
  file,
  trustedIssuers,
  adapters,
  now = Date.now,
  stateDirectory = journalDirectory,
  executionFile = join(stateDirectory, basename(executionLockFile)),
  claimExecutionLockImpl = claimExecutionLock,
} = {}) {
  for (const name of [
    "verifyPayment", "verifySourcePosition", "validateCloseCard", "ensureTradingMode",
    "checkCloseReadiness", "dryRun", "validateCloseDryRun", "execute",
    "resolveExecutionRuntime", "buildCloseReceiptRequest", "fetchCloseProof", "validateCloseProof",
  ]) {
    resumeInvariant(typeof adapters?.[name] === "function", "invalid_adapter", `Missing resume adapter: ${name}`);
  }

  const journal = safeStatePath(file, "journal", stateDirectory);
  await resumePendingStateRelease({ journal, stateDirectory });
  const state = JSON.parse(await readFile(journal, "utf8"));
  requireExactResumeCheckpoint(state, journal);
  await verifyStoredPaymentTransactionClaim({
    state,
    service: POSITION_MANAGER_SERVICE,
    stateDirectory,
  });
  requireDistinctPaymentPayer(state.paymentPayer);
  const request = resumeRequest(state);
  const expectedReplayKey = closeReplayKey({ request, sellerWallet: state.buyerWallet });
  resumeInvariant(state.replayKey === expectedReplayKey, "invalid_replay_key", "Paid CLOSE replay identity changed");
  validateStoredPaymentAuthorization(state.paymentAuthorization, {
    paymentPayer: state.paymentPayer,
    service: POSITION_MANAGER_SERVICE,
  });
  await verifyJournalLockOwnership(state, {
    stateDirectory,
    journal,
    fields: ["replayLockPath"],
    requirePresent: true,
  });

  const freshPaymentResult = await adapters.verifyPayment({
    paymentTx: state.paymentTx,
    payer: state.paymentPayer,
    payee: SERVICE_PAYEE,
    asset: SERVICE_ASSET,
    amountAtomic: POSITION_MANAGER_SERVICE.priceAtomic,
    earliestAllowedTime: state.paymentRequestedAt,
  });
  const paymentProof = freshPaymentResult?.proof || freshPaymentResult;
  resumeInvariant(
    asObject(paymentProof) && sha256(paymentProof) === sha256(state.paymentProof),
    "payment_proof_mismatch",
    "Fresh X Layer payment proof differs from the paid checkpoint",
  );

  const verifiedSource = await adapters.verifySourcePosition(request.sourcePosition, { trustedIssuers });
  let validated = await adapters.validateCloseCard(state.paidCard, {
    trustedIssuers,
    now: now(),
  });
  bindResumeCard({ state, request, validated, verifiedSource });
  validateResumeConsent({ state, validated, paymentProof, now: now() });

  // Recheck ownership immediately before acquiring the global execution lock.
  await verifyJournalLockOwnership(state, {
    stateDirectory,
    journal,
    fields: ["replayLockPath"],
    requirePresent: true,
  });

  let lockClaimed = false;
  let lockStateVerified = false;
  let liveAttempted = false;
  let releaseGuardRetained = false;
  try {
    await claimExecutionLockImpl({
      journal,
      directory: stateDirectory,
      file: executionFile,
      state,
      purpose: "CLOSE_RESUME",
      recoveryNotBefore: state.tradeConsent.expiresAt,
      now,
      writeState: writeReconciliationJournal,
      transition: (next) => {
        next.stage = "resume_execution_lock_acquired";
        next.resumeStartedAt = new Date(now()).toISOString();
      },
    });
    lockClaimed = true;
    lockStateVerified = true;
    const lockedState = JSON.parse(await readFile(journal, "utf8"));
    resumeInvariant(
      sha256(lockedState) === sha256(state),
      "resume_checkpoint_changed",
      "Paid CLOSE checkpoint changed while acquiring the execution lock",
    );
    await verifyJournalLockOwnership(state, {
      stateDirectory,
      journal,
      fields: ["replayLockPath", "executionLockPath"],
      requirePresent: true,
    });

    await adapters.ensureTradingMode({ sellerWallet: state.buyerWallet });
    validated = await adapters.validateCloseCard(state.paidCard, {
      trustedIssuers,
      now: now(),
    });
    bindResumeCard({ state, request, validated, verifiedSource });
    let consent = validateResumeConsent({ state, validated, paymentProof, now: now() });
    const readiness = await adapters.checkCloseReadiness({
      paymentPayer: state.paymentPayer,
      sellerWallet: state.buyerWallet,
      outcomeTokenId: validated.tokenId,
      sharesRaw: validated.bounds.sharesRaw,
    });
    resumeInvariant(
      String(readiness?.paymentPayer || "").toLowerCase() === state.paymentPayer,
      "payment_wallet_mismatch",
      "Active X Layer payer differs from the paid CLOSE journal",
    );
    requirePinnedCloseExecutionReadiness(readiness, {
      wallet: state.buyerWallet,
      tokenId: validated.tokenId,
      sharesRaw: BigInt(validated.bounds.sharesRaw),
    });
    const preDryRunWindow = requireExecutionLaunchWindow(validated, { now });
    const dryRun = await adapters.dryRun(validated.executionCard.argv, {
      deadlineEpochMs: preDryRunWindow.deadlineEpochMs,
      clock: now,
    });
    await adapters.validateCloseDryRun(state.paidCard, dryRun, {
      trustedIssuers,
      now: now(),
    });
    validated = await adapters.validateCloseCard(state.paidCard, {
      trustedIssuers,
      now: now(),
    });
    bindResumeCard({ state, request, validated, verifiedSource });
    consent = validateResumeConsent({ state, validated, paymentProof, now: now() });
    requireExecutionLaunchWindow(validated, { now });

    // The durable marker is written before the first possibly-live call. A
    // final pre-spawn refusal clears it; once onStart fires, every failure is
    // ambiguous and is never auto-retried.
    await markExecutionAttempted(state, {
      journal,
      stateDirectory,
      purpose: "CLOSE_RESUME",
      recoveryNotBefore: state.tradeConsent.expiresAt,
      argv: validated.executionCard.argv,
      now,
      writeState: writeReconciliationJournal,
    });
    resumeInvariant(state.executionArgvHash === consent.argvHash, "trade_consent_mismatch", "Durable CLOSE attempt differs from consent");
    validated = await adapters.validateCloseCard(state.paidCard, {
      trustedIssuers,
      now: now(),
    });
    bindResumeCard({ state, request, validated, verifiedSource });
    consent = validateResumeConsent({ state, validated, paymentProof, now: now() });
    const launchWindow = requireExecutionLaunchWindow(validated, { now });
    const persistedRuntime = await adapters.resolveExecutionRuntime();
    resumeInvariant(
      typeof persistedRuntime?.binary === "string" && persistedRuntime.binary.length > 0 &&
        persistedRuntime?.evidence?.verification === "release-digest",
      "runtime_evidence_unverified",
      "Resumed CLOSE requires release-digest runtime evidence",
    );
    state.executionRuntime = structuredClone(persistedRuntime.evidence);
    await writeReconciliationJournal(state, { directory: stateDirectory, file: journal });
    const launchRuntime = await adapters.resolveExecutionRuntime();
    resumeInvariant(
      JSON.stringify(launchRuntime?.evidence || null) === JSON.stringify(state.executionRuntime),
      "runtime_changed_before_execution",
      "Pinned Polymarket runtime changed before resumed CLOSE execution",
    );
    const liveResult = await adapters.execute(validated.executionCard.argv, {
      deadlineEpochMs: launchWindow.deadlineEpochMs,
      clock: now,
      onStart: () => { liveAttempted = true; },
    }, launchRuntime.binary);
    const receiptRequest = await adapters.buildCloseReceiptRequest(state.paidCard, liveResult, {
      trustedIssuers,
    });
    resumeInvariant(
      HASH_RE.test(String(receiptRequest?.transactionHash || "")) &&
        HASH_RE.test(String(receiptRequest?.orderId || "")),
      "ambiguous_execution",
      "Live CLOSE result has no single verifiable settlement",
    );
    state.liveResult = liveResult;
    state.orderId = String(receiptRequest.orderId).toLowerCase();
    state.settlementTx = String(receiptRequest.transactionHash).toLowerCase();
    state.stage = "live_result_received";
    await writeReconciliationJournal(state, { directory: stateDirectory, file: journal });

    const proofDocument = await adapters.fetchCloseProof(receiptRequest);
    const proof = await adapters.validateCloseProof(state.paidCard, proofDocument, {
      trustedIssuers,
      expectedReceiptRequest: receiptRequest,
    });
    resumeInvariant(
      String(proof?.transactionHash || "").toLowerCase() === state.settlementTx &&
        String(proof?.orderId || "").toLowerCase() === state.orderId &&
        HASH_RE.test(String(proof?.closeProofHash || "")) &&
        HASH_RE.test(String(proof?.closePassportHash || "")),
      "close_proof_mismatch",
      "Verified CLOSE proof differs from the one live result",
    );
    resumeInvariant(
      Math.floor(Date.parse(proof.settledAt) / 1_000) > Math.floor(consent.confirmedAt / 1_000),
      "settlement_before_confirmation",
      "Verified CLOSE settlement does not strictly postdate the recorded trade-consent second",
    );
    state.closeProofHash = proof.closeProofHash;
    state.closePassportHash = proof.closePassportHash;
    state.stage = "resume_proof_verified";
    await writeReconciliationJournal(state, { directory: stateDirectory, file: journal });

    await verifyJournalLockOwnership(state, {
      stateDirectory,
      journal,
      fields: ["replayLockPath", "executionLockPath"],
      requirePresent: true,
    });
    const releasedLocks = await releaseReconciledLocks(state, {
      stateDirectory,
      journal,
      fields: ["replayLockPath", "executionLockPath"],
      now,
      transitionId: "close-paid-resume-complete-v1",
      transition: (next, { releasedAt }) => {
        next.stage = "complete_resumed";
        next.reconciliationRequired = false;
        next.resumedAt = releasedAt;
        next.resumeError = null;
      },
    });
    return {
      ok: true,
      status: state.stage,
      resumed: true,
      journalPath: journal,
      paymentTx: paymentProof.transactionHash,
      intentHash: validated.intentHash,
      orderId: proof.orderId,
      settlementTx: proof.transactionHash,
      closeProofHash: proof.closeProofHash,
      closePassportHash: proof.closePassportHash,
      executionRuntime: state.executionRuntime,
      releasedLocks,
      ordersPlaced: 1,
      timings: {
        paidAt: Number(BigInt(paymentProof.blockTimestamp) * 1_000n),
        confirmedAt: consent.confirmedAt,
        provedAt: Date.parse(proof.settledAt),
        paymentToProofMs: Date.parse(proof.settledAt) - Number(BigInt(paymentProof.blockTimestamp) * 1_000n),
      },
    };
  } catch (error) {
    if (error?.preserveSourceJournal === true) throw error;
    if (lockClaimed && !lockStateVerified && !liveAttempted) {
      try {
        const durableUnattached = JSON.parse(await readFile(journal, "utf8"));
        await reconcileUnattachedExecutionLock({
          file: state.executionLockPath || executionFile,
          journal,
          directory: stateDirectory,
          expectedJournalHash: sha256(durableUnattached),
          expectedPurposes: ["CLOSE_RESUME"],
        });
        lockClaimed = false;
        state.executionLockPath = null;
      } catch (releaseError) {
        state.resumeError = {
          code: error?.code || "resume_failed",
          at: new Date(now()).toISOString(),
          executionAmbiguous: false,
          lockReleaseError: releaseError?.code || "lock_release_failed",
        };
      }
    }
    state.reconciliationRequired = true;
    state.resumeError = {
      code: error?.code || "resume_failed",
      at: new Date(now()).toISOString(),
      executionAmbiguous: liveAttempted,
    };
    if (lockClaimed && !liveAttempted) {
      try {
        await writeReconciliationJournal(state, { directory: stateDirectory, file: journal });
        await releaseReconciledLocks(state, {
          stateDirectory,
          journal,
          fields: ["executionLockPath"],
          now,
          transitionId: "close-paid-resume-prelaunch-release-v1",
          transition: (next) => {
            if (lockStateVerified) {
              next.stage = "trade_confirmed";
              next.executionArgv = null;
              next.executionArgvHash = null;
              next.executionAttemptedAt = null;
            }
          },
        });
      } catch (releaseError) {
        releaseGuardRetained = releaseError?.releaseGuardRetained === true;
        if (!releaseGuardRetained) {
          state.resumeError.lockReleaseError = releaseError?.code || "lock_release_failed";
        }
      }
    }
    if (lockClaimed && lockStateVerified && !releaseGuardRetained) {
      try {
        await writeReconciliationJournal(state, { directory: stateDirectory, file: journal });
      } catch {}
    }
    throw error;
  }
}

export function normalizePluginReadiness({
  access,
  addresses,
  quickstart,
  selectedMode,
  pUsdBalanceRaw,
  pUsdAllowanceRaw,
}) {
  const data = quickstart?.data || quickstart;
  const depositWallet = depositWalletFromQuickstart(quickstart);
  const status = data?.status;
  const explicitTradingAddress = data?.trading_address;
  const normalizedMode = selectedMode === "deposit-wallet"
    ? "deposit_wallet"
    : selectedMode;
  const eoaWallet = String(findAddress(addresses, 137) || findAddress(addresses, 196) || "").toLowerCase();
  const depositWalletActive =
    normalizedMode === "deposit_wallet" &&
    (status === "active" || status === "deposit_wallet_ready");
  const eoaActive = normalizedMode === "eoa";
  const buyerWallet = eoaActive ? eoaWallet : depositWallet || "";

  return {
    accessible:
      access?.data?.accessible === true &&
      data?.accessible !== false,
    clobVersion: depositWalletActive || eoaActive ? "V2" : "",
    currentMode: normalizedMode,
    paymentPayer: String(findAddress(addresses, 196) || "").toLowerCase(),
    buyerWallet,
    tradingAddress: String(explicitTradingAddress || buyerWallet || "").toLowerCase(),
    pUsdBalanceRaw,
    ...(pUsdAllowanceRaw !== undefined ? { pUsdAllowanceRaw } : {}),
  };
}

async function polygonPusdBalanceRaw(wallet) {
  const result = await polygonEthCall({
    to: CONTRACTS.pUsd,
    data: `0x70a08231${wallet.slice(2).padStart(64, "0")}`,
    errorCode: "balance_rpc_error",
    errorMessage: "Polygon balance RPC failed",
  });
  return BigInt(result).toString();
}

async function polygonPusdAllowanceRaw(owner, spender) {
  const result = await polygonEthCall({
    to: CONTRACTS.pUsd,
    data: `0xdd62ed3e${owner.slice(2).padStart(64, "0")}${spender.slice(2).padStart(64, "0")}`,
    errorCode: "allowance_rpc_error",
    errorMessage: "Polygon allowance RPC failed",
  });
  return BigInt(result).toString();
}

async function polygonEthCall({ to, data, errorCode, errorMessage }) {
  const rpc = async (method, params) => {
    const response = await fetch(POLYGON_RPC_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal: AbortSignal.timeout(10_000),
    });
    const body = await response.json();
    if (!response.ok || body.error) {
      throw Object.assign(new Error(errorMessage), { code: errorCode });
    }
    return body.result;
  };
  const chainHex = await rpc("eth_chainId", []);
  if (Number(BigInt(chainHex)) !== POLYGON_CHAIN_ID) {
    throw Object.assign(new Error("RPC is not Polygon chain 137"), { code: "wrong_balance_chain" });
  }
  const result = await rpc("eth_call", [{
    to,
    data,
  }, "latest"]);
  if (!/^0x[0-9a-f]+$/i.test(result || "")) {
    throw Object.assign(new Error(errorMessage), { code: errorCode });
  }
  return result;
}

export function paymentTransaction(paymentResponse) {
  const transaction = paymentResponse?.transaction || paymentResponse?.txHash || paymentResponse?.transactionHash;
  if (!/^0x[0-9a-f]{64}$/i.test(String(transaction || ""))) {
    throw Object.assign(new Error("Merchant payment response has no settlement transaction"), {
      code: "missing_payment_transaction",
    });
  }
  return String(transaction).toLowerCase();
}

export function requireDistinctPaymentPayer(paymentPayer) {
  if (String(paymentPayer || "").toLowerCase() === SERVICE_PAYEE) {
    throw Object.assign(
      new Error("Buyer-seat payment payer must differ from Conviction's service treasury"),
      { code: "self_payment_disallowed" },
    );
  }
  return String(paymentPayer || "").toLowerCase();
}

export function validatePaymentChallenge(decoded, service = POSITION_CARD_SERVICE) {
  const requirement = decoded?.accepts?.[0];
  const extra = requirement?.extra;
  if (
    decoded?.x402Version !== 2 || decoded?.resource?.url !== service.resource ||
    requirement?.scheme !== "exact" || requirement?.network !== SERVICE_NETWORK ||
    requirement?.asset?.toLowerCase() !== SERVICE_ASSET ||
    requirement?.payTo?.toLowerCase() !== SERVICE_PAYEE ||
    requirement?.amount !== service.priceAtomic ||
    requirement?.maxTimeoutSeconds !== SERVICE_PAYMENT_TIMEOUT_SECONDS ||
    extra?.name !== "USD₮0" || extra?.version !== "1" ||
    Object.keys(extra || {}).sort().join(",") !== "name,version"
  ) {
    throw Object.assign(
      new Error("x402 challenge differs from Conviction's pinned price"),
      { code: "payment_challenge_mismatch" },
    );
  }
  return requirement;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.command === "reconcile-open" || options.command === "reconcile-close" || options.command === "resume-close") {
    const trustedIssuerDocument = JSON.parse(await readFile(options.issuerRegistry, "utf8"));
    const trustedIssuers = trustedIssuerRegistry(trustedIssuerDocument.issuers || trustedIssuerDocument);
    if (trustedIssuers.size === 0) {
      throw Object.assign(new Error("Pinned issuer registry is empty"), { code: "missing_trusted_issuer" });
    }
    if (options.command === "reconcile-open") {
      const result = await reconcileOpenJournal({
        file: options.journal,
        trustedIssuers,
      });
      stdout.write(`${JSON.stringify(result)}\n`);
      return;
    }
    if (options.command === "reconcile-close") {
      const result = await reconcileCloseJournal({
        file: options.journal,
        trustedIssuers,
      });
      stdout.write(`${JSON.stringify(result)}\n`);
      return;
    }

    let selectedTradingMode = "";
    const loadResumeReadiness = async ({ paymentPayer, sellerWallet }) => {
      const [access, addresses, quickstart] = await Promise.all([
        commandJson(polymarketPluginCommand(), ["check-access"], "Polymarket access check"),
        commandJson("onchainos", ["wallet", "addresses"], "Agentic Wallet addresses"),
        commandJson(polymarketPluginCommand(), ["quickstart"], "Polymarket readiness"),
      ]);
      const depositWallet = depositWalletFromQuickstart(quickstart);
      const pUsdBalanceRaw = depositWallet ? await polygonPusdBalanceRaw(depositWallet) : "0";
      const readiness = normalizePluginReadiness({
        access,
        addresses,
        quickstart,
        selectedMode: selectedTradingMode,
        pUsdBalanceRaw,
      });
      resumeInvariant(
        readiness.paymentPayer === paymentPayer && readiness.buyerWallet === sellerWallet,
        "trading_wallet_mismatch",
        "Active payer or deposit wallet differs from the paid CLOSE journal",
      );
      return readiness;
    };
    const result = await resumePaidCloseJournal({
      file: options.journal,
      trustedIssuers,
      adapters: {
        verifyPayment: (expected) => fetchAndVerifyX402Payment(expected),
        verifySourcePosition: (source, verificationOptions) => verifySourcePosition(source, verificationOptions),
        validateCloseCard: (card, validationOptions) => validateCloseCard(card, validationOptions),
        ensureTradingMode: async () => {
          const switched = await commandJson(
            polymarketPluginCommand(),
            ["switch-mode", "--mode", "deposit-wallet"],
            "Polymarket trading-mode selection",
          );
          const value = switched?.data || switched;
          resumeInvariant(value?.mode === "deposit-wallet", "wrong_trading_mode", "Polymarket did not select DEPOSIT_WALLET mode");
          selectedTradingMode = value.mode;
          return value;
        },
        checkCloseReadiness: async ({ paymentPayer, sellerWallet, outcomeTokenId }) => {
          const [readiness, position] = await Promise.all([
            loadResumeReadiness({ paymentPayer, sellerWallet }),
            fetchPositionSnapshot(sellerWallet, outcomeTokenId),
          ]);
          const completeOpenOrders = await fetchAllOpenOrders({
            signerAddress: paymentPayer,
            depositWallet: sellerWallet,
            outcomeTokenId: position.outcomeTokenId,
          });
          resumeInvariant(completeOpenOrders.complete === true, "incomplete_open_orders", "Polymarket open-order pagination is incomplete");
          const reservations = summarizeOpenSellReservations(
            normalizeOpenOrders(completeOpenOrders.orders),
            position.outcomeTokenId,
          );
          return {
            ...readiness,
            outcomeTokenId: position.outcomeTokenId,
            outcomeBalanceRaw: position.balanceRaw,
            positionBlockNumber: position.blockNumber,
            positionBlockHash: position.blockHash,
            approvedForExchange: position.approvedForExchange,
            reservedSharesRaw: reservations.reservedSharesRaw,
            openSellOrderCount: reservations.openSellOrderCount,
          };
        },
        dryRun: (executionArgv, executionOptions) => commandJson(
          polymarketPluginCommand(),
          [...executionArgv, "--dry-run"],
          "Resumed Polymarket dry run",
          executionOptions,
        ),
        validateCloseDryRun: (card, dryRun, validationOptions) => validateClosePluginPreview(card, dryRun, validationOptions),
        resolveExecutionRuntime: () => {
          const runtime = resolvePolymarketRuntime();
          return {
            binary: runtime.binary,
            evidence: polymarketRuntimeEvidenceFromInspection(runtime),
          };
        },
        execute: (executionArgv, executionOptions, runtimeBinary) => commandJson(
          runtimeBinary,
          executionArgv,
          "Resumed Polymarket live order",
          executionOptions,
        ),
        buildCloseReceiptRequest: (card, liveResult, validationOptions) => buildCloseReceiptRequest(card, liveResult, validationOptions),
        fetchCloseProof: (receiptRequest) => readProofWithReceiptIndexingRetry(
          () => fetchAndVerifyClose(receiptRequest.transactionHash, {
            intent: receiptRequest.intent,
            intentHash: receiptRequest.intentHash,
            orderId: receiptRequest.orderId,
            issuance: receiptRequest.issuance,
            trustedIssuers,
          }),
        ),
        validateCloseProof: (card, proof, validationOptions) => validateCloseProof(card, proof, validationOptions),
      },
    });
    stdout.write(`${JSON.stringify(result)}\n`);
    return;
  }
  requireDistinctPaymentPayer(options.paymentPayer);
  const trustedIssuers = JSON.parse(await readFile(options.issuerRegistry, "utf8"));
  const pinnedRecords = trustedIssuers?.issuers || trustedIssuers;
  const pinnedRegistry = trustedIssuerRegistry(pinnedRecords);
  if (pinnedRegistry.size === 0) {
    throw Object.assign(new Error("Pinned issuer registry is empty"), { code: "missing_trusted_issuer" });
  }
  const closeMode = options.command === "close";
  const tradingWallet = closeMode ? options.sellerWallet : options.buyerWallet;
  const service = closeMode ? POSITION_MANAGER_SERVICE : POSITION_CARD_SERVICE;
  const sourcePosition = closeMode
    ? normalizeSourcePosition(JSON.parse(await readFile(options.sourceProof, "utf8")))
    : undefined;
  const journeyRequest = closeMode
    ? {
        action: "close",
        market: options.market,
        outcome: options.side,
        shares: options.shares,
        minPrice: options.minPrice,
        rationale: options.rationale,
        sourcePosition,
      }
    : {
        market: options.market,
        side: options.side,
        budget: options.budget,
        maxPrice: options.maxPrice,
      };
  const requestBody = closeMode
    ? {
        action: "close",
        market: options.market,
        outcome: options.side.toLowerCase(),
        shares: options.shares,
        minPrice: options.minPrice,
        wallet: options.sellerWallet,
        rationale: options.rationale,
        sourcePosition,
      }
    : {
        market: options.market,
        outcome: options.side.toLowerCase(),
        spend: options.budget,
        maxPrice: options.maxPrice,
        wallet: options.buyerWallet,
      };
  checkpoint.mode = options.command;
  checkpoint.request = closeMode
    ? {
        action: "close",
        market: options.market,
        outcome: options.side,
        shares: options.shares,
        minPrice: options.minPrice,
        rationale: options.rationale,
        sourceIntentHash: sourcePosition.intentHash,
        sourcePositionProofHash: sourcePosition.positionProofHash,
        sourcePosition,
      }
    : {
        market: options.market,
        side: options.side,
        budget: options.budget,
        maxPrice: options.maxPrice,
      };
  checkpoint.paymentPayer = options.paymentPayer;
  checkpoint.buyerWallet = tradingWallet;
  checkpoint.sourcePosition = sourcePosition || null;
  checkpoint.sourceIntentHash = sourcePosition?.intentHash || null;
  checkpoint.sourcePositionProofHash = sourcePosition?.positionProofHash || null;
  let latestReadiness;
  let latestCloseReadiness;
  const emit = options.json
    ? (event) => process.stderr.write(`${JSON.stringify(event)}\n`)
    : (event) => {
      if (event.type === "payment_confirmation") {
        const requirement = event.challenge?.decoded?.accepts?.[0] || {};
        stdout.write([
          "\nConviction service payment via **OKX Agent Payments Protocol**:",
          `  Product: ${service.serviceName}`,
          `  Amount: ${service.priceDisplay} (${requirement.amount} atomic)`,
          `  Network: ${requirement.network}`,
          `  Asset: ${requirement.asset}`,
          `  From: ${options.paymentPayer}`,
          `  To: ${requirement.payTo}`,
          `  Resource: ${event.challenge?.decoded?.resource?.url}`,
          "",
        ].join("\n"));
      } else if (event.type === "trade_confirmation") {
        const b = event.bounds;
        if (closeMode) {
          stdout.write([
            "\nBounded CLOSE ready:",
            `  Market: ${b.marketQuestion}`,
            `  Condition: ${b.conditionId}`,
            `  Outcome sold: ${b.outcome}`,
            `  Outcome token: ${b.outcomeTokenId}`,
            `  Exact shares: ${b.exactShares}`,
            `  Minimum price: ${b.minPrice}`,
            `  Minimum gross proceeds: ${b.minimumGrossProceedsRaw} atomic pUSD`,
            `  Current fee verification ceiling: ${b.maximumFeeRaw} atomic pUSD`,
            `  Post-settlement net verification floor: ${b.minimumNetProceedsRaw} atomic pUSD`,
            "  Fee/net note: V2 does not sign the operator fee; these are detected after settlement, not preventive controls.",
            `  Current position balance: ${latestCloseReadiness?.outcomeBalanceRaw || "unknown"} atomic shares`,
            `  Matching open SELL reservations: ${latestCloseReadiness?.openSellOrderCount ?? "unknown"}`,
            `  Seller wallet: ${b.wallet}`,
            `  Source OPEN intent: ${b.sourceIntentHash}`,
            `  Source position proof: ${b.sourcePositionProofHash}`,
            `  Signed by: ${b.issuerKeyId} (${b.issuerFingerprint})`,
            `  Issued: ${b.issuedAt}`,
            `  Expires: ${b.expiresAt}`,
            `  Service payment completed: ${b.completedPayment.amountAtomic} atomic USD₮0 on ${b.completedPayment.network}`,
            `  Payment transaction: ${b.completedPayment.transactionHash}`,
            `  Payment payer: ${b.completedPayment.payer}`,
            `  Payment recipient: ${b.completedPayment.payee}`,
            "  Order type: FOK (exact fill or no fill)",
            "  Buyer-wallet gas: 0 (off-chain order signature; venue settlement)",
            "  Polygon settlement is irreversible.",
            "",
          ].join("\n"));
        } else {
          stdout.write([
            "\nBounded order ready:",
            `  Market: ${b.marketQuestion}`,
            `  Condition: ${b.conditionId}`,
            `  Side: ${b.side}`,
            `  Outcome token: ${b.outcomeTokenId}`,
            `  Total fee-inclusive budget: ${b.requestedBudgetRaw} atomic pUSD`,
            `  Maximum price: ${b.maxPrice}`,
            `  Maximum order principal: ${b.maximumOrderPrincipalRaw} atomic pUSD`,
            `  Current venue-fee reserve: ${b.maximumFeeRaw} atomic pUSD (V2 fee is operator-set at match time)`,
            `  Accepted total-debit ceiling for verification: ${b.maximumTotalDebitRaw} atomic pUSD`,
            `  Full-fill shares at cap: ${b.fullFillSharesRaw} atomic shares`,
            `  Current pUSD balance: ${latestReadiness?.pUsdBalanceRaw || "unknown"} atomic`,
            `  Buyer wallet: ${b.wallet}`,
            `  Intent: ${b.intentHash}`,
            `  Signed by: ${b.issuerKeyId}`,
            `  Issued: ${b.issuedAt}`,
            `  Expires: ${b.expiresAt}`,
            `  Service payment completed: ${b.completedPayment.amountAtomic} atomic USD₮0 on ${b.completedPayment.network}`,
            `  Payment transaction: ${b.completedPayment.transactionHash}`,
            `  Payment payer: ${b.completedPayment.payer}`,
            `  Payment recipient: ${b.completedPayment.payee}`,
            "  Order type: FAK (bounded immediate fill; unfilled remainder cancels)",
            "  Polygon settlement is irreversible.",
            "",
          ].join("\n"));
        }
      }
    };
  const readline = createInterface({ input: stdin, output: options.json ? stderr : stdout });
  let paymentConsentUsed = false;
  const requestedTradingMode = closeMode ? "deposit-wallet" : options.tradingMode;
  let selectedTradingMode = "";
  const confirm = async (kind, context = {}) => {
    if (kind === "wallet_preparation") {
      const plan = context.plan || {};
      const confirming = context.confirming || {};
      if (confirming.message) stdout.write(`\n${confirming.message}\n`);
      stdout.write([
        "\nPrepare finite EOA pUSD allowance:",
        `  Wallet: ${plan.owner}`,
        `  Token: ${plan.collateralToken}`,
        `  Spender: ${plan.spender}`,
        `  Amount: ${plan.approval?.amount} pUSD (${plan.approval?.amountRaw} raw)`,
        `  Scope: ${plan.scope}`,
        "  No unlimited approval and no setApprovalForAll.",
        "",
      ].join("\n"));
      const answer = await readline.question("Type `Prepare test wallet` to approve this exact pUSD allowance: ");
      return answer.trim() === "Prepare test wallet";
    }
    if (kind === "payment") {
      if (paymentConsentUsed) return false;
      paymentConsentUsed = true;
      const answer = await readline.question(
        `Type \`confirm payment\` to pay exactly ${service.priceDisplay} (${service.priceAtomic} atomic) on X Layer: `,
      );
      return answer.trim() === "confirm payment";
    }
    const action = closeMode ? "bounded FOK CLOSE" : "bounded order";
    const answer = await readline.question(`Type \`confirm live mode\` to submit this one ${action}: `);
    const accepted = answer.trim() === "confirm live mode";
    if (accepted) {
      return persistBoundTradeConsent({
        state: checkpoint,
        mode: closeMode ? "close" : "open",
        validated: context.validated,
        executionArgv: context.executionArgv,
      });
    }
    return false;
  };

  const loadReadiness = async () => {
    const [access, addresses, quickstart] = await Promise.all([
      commandJson(polymarketPluginCommand(), ["check-access"], "Polymarket access check"),
      commandJson("onchainos", ["wallet", "addresses"], "Agentic Wallet addresses"),
      commandJson(polymarketPluginCommand(), ["quickstart"], "Polymarket readiness"),
    ]);
    const depositWallet = depositWalletFromQuickstart(quickstart);
    const balanceWallet = requestedTradingMode === "eoa" ? options.buyerWallet : depositWallet;
    const pUsdBalanceRaw = balanceWallet ? await polygonPusdBalanceRaw(balanceWallet) : "0";
    const pUsdAllowanceRaw = requestedTradingMode === "eoa" && balanceWallet
      ? await polygonPusdAllowanceRaw(balanceWallet, CONTRACTS.standardExchangeV2)
      : undefined;
    latestReadiness = normalizePluginReadiness({
      access,
      addresses,
      quickstart,
      selectedMode: selectedTradingMode,
      pUsdBalanceRaw,
      pUsdAllowanceRaw,
    });
    return latestReadiness;
  };

  const releaseCreatedReplayLock = async (releasedStage) => {
    try {
      await releaseUnsentReplayLock(checkpoint);
    } catch (cleanupError) {
      checkpoint.stage = "replay_lock_release_failed_before_replay";
      await writeReconciliationJournal(checkpoint);
      throw cleanupError;
    }
    checkpoint.stage = releasedStage;
    await writeReconciliationJournal(checkpoint);
  };

  const adapters = {
    ensureTradingMode: async () => {
      const switched = await commandJson(
        polymarketPluginCommand(),
        ["switch-mode", "--mode", requestedTradingMode],
        "Polymarket trading-mode selection",
      );
      const result = switched?.data || switched;
      if (result?.mode !== requestedTradingMode) {
        throw Object.assign(new Error(`Polymarket did not select ${requestedTradingMode} mode`), {
          code: "wrong_trading_mode",
        });
      }
      selectedTradingMode = result.mode;
      return result;
    },
    checkReadiness: loadReadiness,
    prepareOpenWallet: async ({ preview, buyerWallet, confirm: confirmPreparation }) => {
      if (requestedTradingMode !== "eoa") return null;
      const body = preview?.preview || preview;
      const plan = finiteEoaOpenPreparation({
        wallet: buyerWallet,
        market: body?.market,
        order: body?.order,
      });
      const scan = await commandJson(
        plan.approval.securityScan.program,
        plan.approval.securityScan.argv,
        "Finite pUSD approval security scan",
      );
      const scanAction = String((scan?.data || scan)?.action || "").toLowerCase();
      if (scanAction === "block") {
        throw Object.assign(new Error("Security scan blocked the finite pUSD approval"), {
          code: "approval_security_blocked",
          details: scan,
        });
      }
      const confirming = await commandJson(
        plan.approval.submit.program,
        plan.approval.submit.argv,
        "Finite pUSD approval request",
        { allowConfirming: true },
      );
      if (confirming?.confirming !== true) {
        throw Object.assign(new Error("Wallet did not present a confirmation for the finite approval"), {
          code: "approval_confirmation_missing",
          details: confirming,
        });
      }
      const accepted = await confirmPreparation("wallet_preparation", { plan, scan, confirming });
      if (accepted !== true) {
        throw Object.assign(new Error("Buyer declined the finite pUSD approval"), {
          code: "wallet_preparation_not_confirmed",
        });
      }
      const approved = await commandJson(
        plan.approval.submit.program,
        [...plan.approval.submit.argv, "--force"],
        "Finite pUSD approval",
      );
      const allowanceRaw = await polygonPusdAllowanceRaw(plan.owner, plan.spender);
      if (
        BigInt(allowanceRaw) < BigInt(plan.allowanceReadback.minimumRaw) ||
        BigInt(allowanceRaw) > BigInt(plan.allowanceReadback.maximumRaw)
      ) {
        throw Object.assign(new Error("Finite pUSD allowance readback is outside the signed bounds"), {
          code: "allowance_readback_mismatch",
          details: {
            allowanceRaw,
            minimumRaw: plan.allowanceReadback.minimumRaw,
            maximumRaw: plan.allowanceReadback.maximumRaw,
          },
        });
      }
      return {
        ok: true,
        mode: "eoa",
        planHash: plan.planHash,
        allowanceRaw,
        transactionHash: String((approved?.data || approved)?.txHash || (approved?.data || approved)?.transactionHash || ""),
      };
    },
    checkCloseReadiness: async ({ outcomeTokenId }) => {
      const [readiness, position] = await Promise.all([
        loadReadiness(),
        fetchPositionSnapshot(tradingWallet, outcomeTokenId),
      ]);
      const completeOpenOrders = await fetchAllOpenOrders({
        signerAddress: readiness.paymentPayer,
        depositWallet: tradingWallet,
        outcomeTokenId: position.outcomeTokenId,
      });
      if (completeOpenOrders.complete !== true) {
        throw Object.assign(new Error("Polymarket open-order pagination is incomplete"), {
          code: "incomplete_open_orders",
        });
      }
      const openOrders = normalizeOpenOrders(completeOpenOrders.orders);
      const reservations = summarizeOpenSellReservations(openOrders, position.outcomeTokenId);
      latestCloseReadiness = {
        ...readiness,
        outcomeTokenId: position.outcomeTokenId,
        outcomeBalanceRaw: position.balanceRaw,
        positionBlockNumber: position.blockNumber,
        positionBlockHash: position.blockHash,
        approvedForExchange: position.approvedForExchange,
        reservedSharesRaw: reservations.reservedSharesRaw,
        openSellOrderCount: reservations.openSellOrderCount,
        totalOpenOrderCount: openOrders.length,
        openOrderPageCount: completeOpenOrders.pageCount,
        openOrdersComplete: true,
      };
      return latestCloseReadiness;
    },
    previewMarket: async () => {
      const { response, json } = await postJson(pinnedServiceUrl(POSITION_CARD_SERVICE, "/api/preview"), requestBody);
      if (!response.ok || json?.ok !== true) {
        throw Object.assign(new Error(json?.error?.message || "Free bounds preview failed"), {
          code: json?.error?.code || "preview_failed",
        });
      }
      return {
        preview: json.preview,
        conditionId: json.preview.market.conditionId,
        outcomeTokenId: json.preview.market.outcomeTokenId,
      };
    },
    previewClose: async () => {
      const { response, json } = await postJson(pinnedServiceUrl(POSITION_MANAGER_SERVICE, "/api/manage-preview"), requestBody);
      if (!response.ok || json?.ok !== true) {
        throw Object.assign(new Error(json?.error?.message || "Free CLOSE preview failed"), {
          code: json?.error?.code || "preview_failed",
        });
      }
      return json;
    },
    requestPaymentChallenge: async () => {
      checkpoint.paymentRequestedAt = new Date().toISOString();
      checkpoint.stage = "payment_challenge_requested";
      await writeReconciliationJournal(checkpoint);
      const { response, json } = await postJson(pinnedServiceUrl(service), requestBody);
      const encoded = response.headers.get("payment-required");
      if (response.status !== 402 || !encoded) {
        throw Object.assign(new Error(json?.error?.message || "Service did not return an x402 challenge"), {
          code: "invalid_payment_challenge",
        });
      }
      const decoded = decodeHeader(encoded, "PAYMENT-REQUIRED");
      validatePaymentChallenge(decoded, service);
      return { encoded, decoded };
    },
    payAndRequestCard: async ({ challenge }) => {
      let createdReplayLock = false;
      const replayKey = closeMode
        ? closeReplayKey({ request: journeyRequest, sellerWallet: options.sellerWallet })
        : openReplayKey({ request: journeyRequest, buyerWallet: options.buyerWallet });
      await (closeMode ? claimCloseReplayLock : claimOpenReplayLock)({
        key: replayKey,
        journal: journalPath,
        state: checkpoint,
        transition: (next) => {
          next.replayKey = replayKey;
          next.stage = "payment_authorization_starting";
        },
      });
      createdReplayLock = true;
      let signed;
      try {
        signed = await commandJson(
          "onchainos",
          ["payment", "pay", "--payload", challenge.encoded, "--selected-index", "0", "--chain", "xlayer"],
          "service payment authorization",
        );
      } catch (error) {
        if (createdReplayLock) {
          await releaseCreatedReplayLock("payment_authorization_failed_before_replay");
        }
        throw error;
      }
      const data = signed?.data || signed;
      if (!data.authorization_header || String(data.wallet || "").toLowerCase() !== options.paymentPayer) {
        if (createdReplayLock) {
          await releaseCreatedReplayLock("payment_authorization_rejected_before_replay");
        }
        throw Object.assign(new Error("x402 authorization was not signed by the pinned payer"), { code: "payment_wallet_mismatch" });
      }
      try {
        checkpoint.paymentAuthorization = paymentAuthorizationMetadata(data.authorization_header, {
          paymentPayer: options.paymentPayer,
          service,
        });
      } catch (error) {
        if (createdReplayLock) {
          await releaseCreatedReplayLock("payment_authorization_rejected_before_replay");
        }
        throw error;
      }
      checkpoint.stage = "payment_authorization_created";
      await writeReconciliationJournal(checkpoint);
      if (data.header_name && String(data.header_name).toUpperCase() !== PAYMENT_SIGNATURE_HEADER) {
        checkpoint.stage = "payment_header_rejected_after_authorization";
        checkpoint.reconciliationRequired = true;
        await writeReconciliationJournal(checkpoint);
        throw Object.assign(new Error("x402 signer returned an unexpected authorization header name"), {
          code: "payment_header_mismatch",
        });
      }
      const { response, json } = await postJson(pinnedServiceUrl(service), requestBody, {
        headers: { [PAYMENT_SIGNATURE_HEADER]: data.authorization_header },
      });
      const paymentResponseRaw = response.headers.get("payment-response");
      if (!response.ok || json?.ok !== true) {
        checkpoint.paidServiceResponse = {
          status: response.status,
          paymentResponsePresent: Boolean(paymentResponseRaw),
        };
        checkpoint.stage = response.status >= 400 && !paymentResponseRaw
          ? "paid_request_rejected_pre_settlement"
          : "paid_request_settlement_ambiguous";
        checkpoint.reconciliationRequired = true;
        await writeReconciliationJournal(checkpoint);
        throw Object.assign(new Error(json?.error?.message || "Paid service request failed"), {
          code: json?.error?.code || "paid_service_failed",
        });
      }
      return persistSuccessfulPaidServiceResponse({
        state: checkpoint,
        response,
        json,
        paymentResponseRaw,
      });
    },
    verifyPayment: async ({ paid, startedAt }) => {
      const result = await fetchAndVerifyX402Payment({
        paymentTx: paid.paymentTx,
        payer: options.paymentPayer,
        payee: SERVICE_PAYEE,
        asset: SERVICE_ASSET,
        amountAtomic: service.priceAtomic,
        earliestAllowedTime: new Date(startedAt).toISOString(),
      });
      return persistVerifiedPaidServicePayment({
        state: checkpoint,
        paid,
        paymentProof: result.proof,
        service,
      });
    },
    validateCard: async (card, validationOptions) => validateCard(card, validationOptions),
    validateCloseCard: async (card, validationOptions) => validateCloseCard(card, validationOptions),
    dryRun: async (argv) => commandJson(polymarketPluginCommand(), [...argv, "--dry-run"], "Polymarket dry run"),
    validateDryRun: async (card, dryRun, validationOptions) => validatePluginPreview(card, dryRun, validationOptions),
    validateCloseDryRun: async (card, dryRun, validationOptions) => validateClosePluginPreview(card, dryRun, validationOptions),
    execute: async (argv) => {
      await verifyStoredPaymentTransactionClaim({
        state: checkpoint,
        service,
        stateDirectory: journalDirectory,
      });
      await claimExecutionLock({
        journal: journalPath,
        state: checkpoint,
        purpose: closeMode ? "CLOSE_PLACE" : "OPEN_PLACE",
        recoveryNotBefore: checkpoint.tradeConsent.expiresAt,
        transition: (next) => {
          next.stage = "execution_lock_acquired";
        },
      });
      let preserveExecutionSource = false;
      try {
        // Exact CLOB recovery requires the accepted order to strictly postdate
        // the buyer's confirmation second. Waiting here keeps the temporal
        // boundary deterministic without authorizing any additional action.
        await waitForStrictlyPostConfirmationSecond(checkpoint.tradeConfirmedAt);
        const reasserted = await commandJson(
          polymarketPluginCommand(),
          ["switch-mode", "--mode", requestedTradingMode],
          "Final Polymarket trading-mode selection",
        );
        if ((reasserted?.data || reasserted)?.mode !== requestedTradingMode) {
          throw Object.assign(new Error(`Polymarket did not preserve ${requestedTradingMode} mode before execution`), {
            code: "wrong_trading_mode",
          });
        }
        selectedTradingMode = reasserted.data?.mode || reasserted.mode;

        if (closeMode) {
          const tokenIndex = argv.indexOf("--token-id");
          const sharesIndex = argv.indexOf("--shares");
          const tokenId = tokenIndex >= 0 ? String(argv[tokenIndex + 1] || "") : "";
          const sharesRaw = sharesIndex >= 0 ? parseDecimal(argv[sharesIndex + 1], 6, "execution shares") : -1n;
          const lockedReadiness = await adapters.checkCloseReadiness({ outcomeTokenId: tokenId });
          requirePinnedCloseExecutionReadiness(lockedReadiness, {
            wallet: tradingWallet,
            tokenId,
            sharesRaw,
          });
          let lockedCard = validateCloseCard(checkpoint.paidCard, {
            trustedIssuers: pinnedRegistry,
            now: Date.now(),
          });
          const preDryRunWindow = requireExecutionLaunchWindow(lockedCard);
          const lockedDryRun = await commandJson(
            polymarketPluginCommand(),
            [...argv, "--dry-run"],
            "Locked final Polymarket dry run",
            { deadlineEpochMs: preDryRunWindow.deadlineEpochMs },
          );
          validateClosePluginPreview(checkpoint.paidCard, lockedDryRun, {
            trustedIssuers: pinnedRegistry,
            now: Date.now(),
          });
          lockedCard = validateCloseCard(checkpoint.paidCard, {
            trustedIssuers: pinnedRegistry,
            now: Date.now(),
          });
          requireExecutionLaunchWindow(lockedCard);
          if (
            lockedCard.intentHash !== checkpoint.tradeConsent?.intentHash ||
            sha256(lockedCard.executionCard.argv) !== checkpoint.tradeConsent?.executionArgvHash
          ) {
            throw Object.assign(new Error("Locked CLOSE differs from the confirmed order"), {
              code: "trade_consent_mismatch",
            });
          }
        } else {
          const lockedReadiness = await loadReadiness();
          if (
            lockedReadiness.currentMode !== (requestedTradingMode === "eoa" ? "eoa" : "deposit_wallet") ||
            lockedReadiness.buyerWallet !== tradingWallet ||
            lockedReadiness.tradingAddress !== tradingWallet
          ) {
            throw Object.assign(new Error("Active trading wallet changed immediately before OPEN"), {
              code: "trading_wallet_mismatch",
            });
          }
          let lockedCard = validateCard(checkpoint.paidCard, {
            trustedIssuers: pinnedRegistry,
            now: Date.now(),
          });
          const preDryRunWindow = requireExecutionLaunchWindow(lockedCard);
          const lockedDryRun = await commandJson(
            polymarketPluginCommand(),
            [...argv, "--dry-run"],
            "Locked final Polymarket OPEN dry run",
            { deadlineEpochMs: preDryRunWindow.deadlineEpochMs },
          );
          validatePluginPreview(checkpoint.paidCard, lockedDryRun, {
            trustedIssuers: pinnedRegistry,
            now: Date.now(),
          });
          lockedCard = validateCard(checkpoint.paidCard, {
            trustedIssuers: pinnedRegistry,
            now: Date.now(),
          });
          requireExecutionLaunchWindow(lockedCard);
          if (
            lockedCard.intentHash !== checkpoint.tradeConsent?.intentHash ||
            sha256(effectiveOpenExecutionArgv(lockedCard, requestedTradingMode)) !== checkpoint.tradeConsent?.executionArgvHash
          ) {
            throw Object.assign(new Error("Locked OPEN differs from the confirmed order"), {
              code: "trade_consent_mismatch",
            });
          }
        }

        await markExecutionAttempted(checkpoint, {
          journal: journalPath,
          stateDirectory: journalDirectory,
          purpose: closeMode ? "CLOSE_PLACE" : "OPEN_PLACE",
          recoveryNotBefore: checkpoint.tradeConsent.expiresAt,
          argv,
          now: Date.now,
          writeState: writeReconciliationJournal,
        });
        let result;
        try {
          const launchCard = closeMode
            ? validateCloseCard(checkpoint.paidCard, { trustedIssuers: pinnedRegistry, now: Date.now() })
            : validateCard(checkpoint.paidCard, { trustedIssuers: pinnedRegistry, now: Date.now() });
          const launchWindow = requireExecutionLaunchWindow(launchCard);
          const launchArgv = closeMode
            ? launchCard.executionCard.argv
            : effectiveOpenExecutionArgv(launchCard, requestedTradingMode);
          if (sha256(launchArgv) !== checkpoint.executionArgvHash) {
            throw Object.assign(new Error("Live order differs from the persisted bounded execution"), {
              code: "trade_consent_mismatch",
            });
          }
          const persistedRuntime = resolvePolymarketRuntime();
          checkpoint.executionRuntime = polymarketRuntimeEvidenceFromInspection(persistedRuntime);
          await writeReconciliationJournal(checkpoint);
          const launchRuntime = resolvePolymarketRuntime();
          const launchEvidence = polymarketRuntimeEvidenceFromInspection(launchRuntime);
          if (JSON.stringify(launchEvidence) !== JSON.stringify(checkpoint.executionRuntime)) {
            throw Object.assign(new Error("Pinned Polymarket runtime changed before live execution"), {
              code: "runtime_changed_before_execution",
            });
          }
          result = await commandJson(launchRuntime.binary, argv, "Polymarket live order", {
            deadlineEpochMs: launchWindow.deadlineEpochMs,
            onStart: () => { executionAttempted = true; },
          });
        } catch (error) {
          if (!executionAttempted) {
            checkpoint.stage = "execution_blocked_before_launch";
            checkpoint.reconciliationRequired = true;
            await writeReconciliationJournal(checkpoint);
          }
          throw error;
        }
        checkpoint.liveResult = result;
        const data = result?.data || result;
        checkpoint.stage = "live_result_received";
        checkpoint.orderId = HASH_RE.test(String(data?.order_id || ""))
          ? String(data.order_id).toLowerCase()
          : null;
        checkpoint.settlementTx = Array.isArray(data?.tx_hashes) && data.tx_hashes.length === 1 &&
          HASH_RE.test(String(data.tx_hashes[0] || ""))
          ? String(data.tx_hashes[0]).toLowerCase()
          : null;
        await writeReconciliationJournal(checkpoint);
        return result;
      } catch (error) {
        preserveExecutionSource = error?.preserveSourceJournal === true;
        if (!preserveExecutionSource && !executionAttempted) {
          try {
            if (closeMode) {
              await recoverKnownUnstartedCloseExecution(checkpoint, {
                journal: journalPath,
                errorCode: error?.code,
              });
            } else {
              await recoverKnownUnstartedOpenExecution(checkpoint, {
                journal: journalPath,
                errorCode: error?.code,
              });
            }
          } catch (recoveryError) {
            error.details = {
              ...(error?.details && typeof error.details === "object" ? error.details : {}),
              prelaunchRecoveryError: recoveryError?.code || "prelaunch_recovery_failed",
            };
          }
        } else if (!preserveExecutionSource && executionAttempted && error?.details && typeof error.details === "object") {
          const candidate = error.details;
          const data = candidate?.data || candidate;
          if (HASH_RE.test(String(data?.order_id || ""))) {
            checkpoint.liveResult = candidate;
            checkpoint.orderId = String(data.order_id).toLowerCase();
            checkpoint.settlementTx = Array.isArray(data?.tx_hashes) && data.tx_hashes.length === 1 &&
              HASH_RE.test(String(data.tx_hashes[0] || ""))
              ? String(data.tx_hashes[0]).toLowerCase()
              : null;
            checkpoint.stage = "live_result_error_received";
            await writeReconciliationJournal(checkpoint);
          }
        }
        throw error;
      } finally {
        if (!preserveExecutionSource) {
          await settleExecutionLock(checkpoint, {
            liveAttempted: executionAttempted,
            proofVerified: false,
            transitionId: "buyer-prelaunch-execution-release-v1",
          });
          await writeReconciliationJournal(checkpoint);
        }
      }
    },
    buildReceiptRequest: async (card, result, validationOptions) => buildReceiptRequest(card, result, validationOptions),
    buildCloseReceiptRequest: async (card, result, validationOptions) => buildCloseReceiptRequest(card, result, validationOptions),
    fetchProof: async (body) => {
      const json = await readProofWithReceiptIndexingRetry(async () => {
        const result = await postJson(pinnedServiceUrl(POSITION_CARD_SERVICE, "/api/receipt"), body);
        if (!result.response.ok || result.json?.ok !== true) {
          throw Object.assign(new Error(result.json?.error?.message || "Receipt proof failed"), {
            code: result.json?.error?.code || "receipt_failed",
          });
        }
        return result.json;
      });
      checkpoint.stage = "proof_received";
      checkpoint.positionProofHash = json.positionProofHash || null;
      checkpoint.reconciliationRequired = false;
      await writeReconciliationJournal(checkpoint);
      return json;
    },
    validateProof: async (card, proof, validationOptions) => validateProof(card, proof, validationOptions),
    fetchCloseProof: async (body) => {
      const proof = await readProofWithReceiptIndexingRetry(
        () => fetchAndVerifyClose(body.transactionHash, {
          intent: body.intent,
          intentHash: body.intentHash,
          orderId: body.orderId,
          issuance: body.issuance,
          trustedIssuers: pinnedRegistry,
        }),
      );
      checkpoint.stage = "close_proof_received";
      checkpoint.closeProofHash = proof.closeProofHash || null;
      checkpoint.closePassportHash = proof.closePassportHash || null;
      checkpoint.reconciliationRequired = true;
      await writeReconciliationJournal(checkpoint);
      return proof;
    },
    validateCloseProof: async (card, proof, validationOptions) => validateCloseProof(card, proof, validationOptions),
  };

  try {
    const result = closeMode
      ? await runCloseJourney({
          request: journeyRequest,
          paymentPayer: options.paymentPayer,
          sellerWallet: options.sellerWallet,
          trustedIssuers,
          adapters,
          confirm,
          emit,
        })
      : await runOpenJourney({
          request: journeyRequest,
          paymentPayer: options.paymentPayer,
          buyerWallet: options.buyerWallet,
          trustedIssuers,
          adapters,
          confirm,
          emit,
        });
    await releaseReconciledLocks(checkpoint, {
      journal: journalPath,
      fields: ["replayLockPath", "executionLockPath"],
      transitionId: "buyer-complete-reconciliation-v1",
      transition: (next) => {
        next.stage = "complete";
        next.reconciliationRequired = false;
      },
    });
    stdout.write(`${JSON.stringify({ ...result, executionRuntime: checkpoint.executionRuntime, journalPath })}\n`);
  } finally {
    readline.close();
  }
}

function isMain() {
  return process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
}

export function shouldPersistFailureCheckpoint(state, { executionStarted = executionAttempted } = {}) {
  return Boolean(
    executionStarted || state?.replayLockPath || state?.executionLockPath ||
    state?.paymentRequestedAt || state?.paymentAuthorization || state?.paymentTx ||
    state?.paidCard || state?.liveResult,
  );
}

if (isMain()) {
  try {
    await main();
  } catch (error) {
    const stateCommand = process.argv[2] === "reconcile-open" ||
      process.argv[2] === "reconcile-close" || process.argv[2] === "resume-close";
    const persistCheckpoint = !stateCommand && shouldPersistFailureCheckpoint(checkpoint);
    if (
      persistCheckpoint && error?.releaseGuardRetained !== true &&
      error?.preserveSourceJournal !== true
    ) {
      checkpoint.reconciliationRequired = Boolean(
        executionAttempted ||
        (checkpoint.replayLockPath && checkpoint.stage !== "complete"),
      );
      try { await writeReconciliationJournal(checkpoint); } catch {}
    }
    process.stdout.write(`${JSON.stringify({
      ok: false,
      code: error?.code || "buyer_journey_failed",
      message: error?.message || "Buyer journey failed",
      ...(stateCommand ? {} : {
        ordersPlaced: executionAttempted ? "unknown" : 0,
        reconciliationRequired: persistCheckpoint ? checkpoint.reconciliationRequired : false,
        ...(persistCheckpoint ? { journalPath, checkpoint } : {}),
      }),
    })}\n`);
    process.exitCode = 1;
  }
}
