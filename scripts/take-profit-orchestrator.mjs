#!/usr/bin/env node

import { execFile } from "node:child_process";
import { mkdir, open, readFile, rename, unlink, writeFile, chmod } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";
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
  SERVICE_ASSET,
  SERVICE_PAYEE,
} from "../src/service-payment.mjs";
import { fetchAndVerifyX402Payment } from "../src/x402-payment-verifier.mjs";
import { fetchAndVerifyTakeProfitAggregateFill } from "../src/take-profit-fill-verifier.mjs";
import {
  claimExecutionLock,
  normalizeOpenOrders,
  normalizePluginReadiness,
  normalizeSourcePosition,
  parseJsonOutput,
  paymentAuthorizationMetadata,
  paymentTransaction,
  requireDistinctPaymentPayer,
  settleExecutionLock,
  summarizeOpenSellReservations,
  validatePaymentChallenge,
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
  validateArmedTakeProfitJournal,
} from "../src/take-profit-lifecycle.mjs";

const execFileAsync = promisify(execFile);
const ADDRESS_RE = /^0x[0-9a-f]{40}$/;
const HASH_RE = /^0x[0-9a-f]{64}$/;
const STATE_DIRECTORY = join(homedir(), ".local", "state", "conviction", "reconciliation");

function fail(condition, code, message, details = undefined) {
  if (!condition) throw Object.assign(new Error(message), { code, details });
}

function usage() {
  return [
    "Usage:",
    "  node scripts/take-profit-orchestrator.mjs take-profit --origin <url> --market <slug-or-id>",
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
    "The flow separately requires `confirm payment`, then `confirm live mode`.",
    "It places one post-only GTD order and returns an authenticated ARMED proof.",
    "`tp-status` automatically proves any matched shares from CLOB trades and Polygon receipts.",
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
  if (command === "tp-status" || command === "cancel-tp") {
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
    origin: take("--origin").replace(/\/$/, ""),
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

export async function claimTakeProfitReservation({ key, journal, directory = STATE_DIRECTORY } = {}) {
  fail(HASH_RE.test(String(key || "")), "invalid_replay_key", "TAKE_PROFIT replay key is invalid");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const file = join(directory, `take-profit-${String(key).slice(2)}.lock.json`);
  let handle;
  try {
    handle = await open(file, "wx", 0o600);
    await handle.writeFile(`${JSON.stringify({
      version: "conviction-take-profit-reservation-v1",
      replayKey: key,
      journalPath: journal,
      orderId: null,
      status: "PAYMENT_PENDING",
      claimedAt: new Date().toISOString(),
    }, null, 2)}\n`);
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
  return file;
}

export async function writeTakeProfitState(value, { directory = STATE_DIRECTORY, file } = {}) {
  fail(typeof file === "string" && file.startsWith(`${directory}/`) && basename(file).endsWith(".json"), "invalid_state_path", "TAKE_PROFIT journal path is invalid");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const temporary = `${file}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, file);
  return file;
}

async function updateReservation(file, update) {
  const current = JSON.parse(await readFile(file, "utf8"));
  const next = { ...current, ...update };
  const temporary = `${file}.tmp`;
  await writeFile(temporary, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, file);
  return next;
}

async function commandJson(file, args, label) {
  try {
    const { stdout: output } = await execFileAsync(file, args, {
      timeout: 60_000,
      maxBuffer: 2 * 1024 * 1024,
      encoding: "utf8",
    });
    return parseJsonOutput(output, label);
  } catch (error) {
    if (error?.code && error.code !== "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") throw error;
    throw Object.assign(new Error(`${label} failed`), { code: "tool_failed" });
  }
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

function safeJournalPath(value, stateDirectory = STATE_DIRECTORY) {
  const file = String(value || "");
  fail(file.startsWith(`${stateDirectory}/`) && basename(file).endsWith("-take-profit.json"), "invalid_state_path", "TAKE_PROFIT journal must be inside the private Conviction state directory");
  return file;
}

async function loadLifecycleContext(options, { stateDirectory = STATE_DIRECTORY } = {}) {
  const journalPath = safeJournalPath(options.journal, stateDirectory);
  const [journalText, trustedText] = await Promise.all([
    readFile(journalPath, "utf8"),
    readFile(options.issuerRegistry, "utf8"),
  ]);
  const journal = JSON.parse(journalText);
  const trustedDocument = JSON.parse(trustedText);
  const trustedIssuers = trustedIssuerRegistry(trustedDocument?.issuers || trustedDocument);
  fail(trustedIssuers.size > 0, "missing_trusted_issuer", "Pinned issuer registry is empty");
  const binding = validateArmedTakeProfitJournal(journal, { trustedIssuers });
  return { journalPath, journal, trustedIssuers, binding };
}

async function exactLifecycleSnapshot(binding) {
  return fetchExactOrderWithPropagation({
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
    context.journal.executionLockPath = await claimExecutionLock({ journal: context.journalPath });
    context.journal.cancelConsent = {
      version: "conviction-take-profit-cancel-consent-v1",
      orderId: cancelRequest.orderId,
      confirmedAt,
      preCancelSnapshotHash: cancelRequest.preCancelSnapshotHash,
      argvHash: sha256(cancelRequest.argv),
    };
    await writeTakeProfitState(context.journal, { directory: stateDirectory, file: context.journalPath });
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
    await settleExecutionLock(context.journal, {
      liveAttempted: true,
      proofVerified: safelyResolved,
    });
    await writeTakeProfitState(context.journal, { directory: stateDirectory, file: context.journalPath });
    return { ...verifiedOutcome, journalPath: context.journalPath };
  } catch (error) {
    context.journal.reconciliationRequired = executionAttempted;
    context.journal.cancelError = {
      code: error?.code || "take_profit_cancel_failed",
      at: new Date(now()).toISOString(),
      executionAmbiguous: executionAttempted,
    };
    if (context.journal.executionLockPath) {
      await settleExecutionLock(context.journal, {
        liveAttempted: executionAttempted,
        proofVerified: false,
      });
    }
    try { await writeTakeProfitState(context.journal, { directory: stateDirectory, file: context.journalPath }); } catch {}
    throw error;
  } finally {
    readline.close();
  }
}

function paymentDisplay(event, options) {
  const requirement = event.challenge?.decoded?.accepts?.[0] || {};
  stdout.write([
    "\nConviction Position Manager payment:",
    `  Amount: ${POSITION_MANAGER_SERVICE.priceDisplay} (${requirement.amount} atomic USD₮0)`,
    `  Network: ${requirement.network}`,
    `  From: ${options.paymentPayer}`,
    `  To: ${requirement.payTo}`,
    "  This payment does not authorize the Polygon order.",
    "",
  ].join("\n"));
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
      state.tradeConsent = {
        version: "conviction-take-profit-consent-v1",
        intentHash: context.validated.intentHash,
        executionArgvHash: sha256(context.validated.executionCard.argv),
        paymentTx: state.paymentTx,
        replayKey: state.replayKey,
        confirmedAt: new Date(now()).toISOString(),
        placementExpiresAt: context.validated.expiresAt,
        venueExpiresAt: context.validated.bounds.venueExpiresAt,
      };
      await persist("trade_confirmed");
    }
    return accepted;
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
      const { response, json } = await postJson(`${options.origin}/api/manage-preview`, requestBody);
      fail(response.ok && json?.ok === true, json?.error?.code || "preview_failed", json?.error?.message || "Free TAKE_PROFIT preview failed");
      return json;
    },
    checkTakeProfitReadiness: loadTakeProfitReadiness,
    requestPaymentChallenge: async () => {
      state.paymentRequestedAt = new Date(now()).toISOString();
      await persist("payment_challenge_requested");
      const { response, json } = await postJson(`${options.origin}${POSITION_MANAGER_SERVICE.path}`, requestBody);
      const encoded = response.headers.get("payment-required");
      fail(response.status === 402 && encoded, "invalid_payment_challenge", json?.error?.message || "Manager did not return an x402 challenge");
      const decoded = decodeHeader(encoded, "PAYMENT-REQUIRED");
      validatePaymentChallenge(decoded, POSITION_MANAGER_SERVICE);
      return { encoded, decoded };
    },
    payAndRequestCard: async ({ challenge }) => {
      state.replayKey = takeProfitReplayKey({ request, sellerWallet: options.sellerWallet });
      state.reservationLockPath = await claimTakeProfitReservation({
        key: state.replayKey,
        journal,
        directory: stateDirectory,
      });
      await persist("payment_authorization_starting");
      let signed;
      try {
        signed = await commandJson(
          "onchainos",
          ["payment", "pay", "--payload", challenge.encoded, "--selected-index", "0", "--chain", "xlayer"],
          "Position Manager payment authorization",
        );
      } catch (error) {
        await unlink(state.reservationLockPath);
        state.reservationLockPath = null;
        await persist("payment_authorization_failed_before_replay");
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
        await unlink(state.reservationLockPath);
        state.reservationLockPath = null;
        await persist("payment_authorization_rejected_before_replay");
        throw error;
      }
      await persist("payment_authorization_created");
      const headerName = data.header_name || "PAYMENT-SIGNATURE";
      const { response, json } = await postJson(`${options.origin}${POSITION_MANAGER_SERVICE.path}`, requestBody, {
        headers: { [headerName]: data.authorization_header },
      });
      const paymentResponseRaw = response.headers.get("payment-response");
      state.paidServiceResponse = { status: response.status, paymentResponsePresent: Boolean(paymentResponseRaw) };
      if (!response.ok || json?.ok !== true || !paymentResponseRaw) {
        state.reconciliationRequired = true;
        await persist("paid_request_ambiguous");
        fail(false, json?.error?.code || "paid_service_failed", json?.error?.message || "Paid TAKE_PROFIT compilation failed");
      }
      const paymentResponse = decodeHeader(paymentResponseRaw, "PAYMENT-RESPONSE");
      state.paymentTx = paymentTransaction(paymentResponse);
      state.paidCard = json;
      state.intentHash = json.intentHash;
      await persist("paid_card_received");
      return { card: json, paymentResponse, paymentTx: state.paymentTx };
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
      state.paymentProof = result.proof;
      await persist("payment_verified");
      return result.proof;
    },
    validateTakeProfitCard: (card, validationOptions) => validateTakeProfitCard(card, validationOptions),
    dryRun: (argv) => commandJson("polymarket-plugin", [...argv, "--dry-run"], "Polymarket TAKE_PROFIT dry run"),
    validateTakeProfitDryRun: (card, result, validationOptions) => validateTakeProfitPluginPreview(card, result, validationOptions),
    waitUntil: sleepUntil,
    execute: async (argv) => {
      state.executionLockPath = await claimExecutionLock({ journal });
      await persist("execution_lock_acquired");
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
        const lockedCard = validateTakeProfitCard(state.paidCard, { trustedIssuers, now: now() });
        const lockedDryRun = await commandJson("polymarket-plugin", [...argv, "--dry-run"], "Locked TAKE_PROFIT dry run");
        validateTakeProfitPluginPreview(state.paidCard, lockedDryRun, { trustedIssuers, now: now() });
        fail(sha256(lockedCard.executionCard.argv) === state.tradeConsent.executionArgvHash, "trade_consent_mismatch", "Locked TAKE_PROFIT differs from the confirmed order");
        state.executionAttempted = true;
        state.reconciliationRequired = true;
        await persist("execution_attempted");
        executionAttempted = true;
        const result = await commandJson("polymarket-plugin", argv, "Polymarket TAKE_PROFIT live order");
        state.liveResult = result;
        state.orderId = String((result?.data || result)?.order_id || "").toLowerCase();
        await persist("live_result_received");
        return result;
      } finally {
        await settleExecutionLock(state, { liveAttempted: executionAttempted, proofVerified: false });
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
    state.stage = "armed";
    state.orderId = result.orderId;
    state.takeProfitPassport = result.takeProfitPassport;
    state.takeProfitPassportHash = result.takeProfitPassportHash;
    state.restingOrderProofHash = result.restingOrderProofHash;
    state.reconciliationRequired = false;
    await settleExecutionLock(state, { liveAttempted: true, proofVerified: true });
    await updateReservation(state.reservationLockPath, {
      orderId: result.orderId,
      intentHash: result.intentHash,
      takeProfitPassportHash: result.takeProfitPassportHash,
      restingOrderProofHash: result.restingOrderProofHash,
      status: "ARMED",
      armedAt: new Date(now()).toISOString(),
    });
    await persist();
    return { ...result, journalPath: journal, reservationLockPath: state.reservationLockPath };
  } catch (error) {
    state.reconciliationRequired = Boolean(
      executionAttempted || state.paymentAuthorization || state.paymentTx || state.reservationLockPath,
    );
    state.lastError = {
      code: error?.code || "take_profit_journey_failed",
      at: new Date(now()).toISOString(),
      executionAmbiguous: executionAttempted,
    };
    try { await persist(); } catch {}
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
