#!/usr/bin/env node

import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import { chmod, mkdir, open, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
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
import { fetchAndVerifyClose } from "../src/exit-receipt-verifier.mjs";
import { trustedIssuerRegistry } from "../src/intent-issuer.mjs";
import { fetchPositionSnapshot } from "../src/position-client.mjs";
import { fetchAllOpenOrders } from "../src/polymarket-open-orders.mjs";
import { verifySourcePosition } from "../src/source-position.mjs";
import {
  POSITION_CARD_SERVICE,
  POSITION_MANAGER_SERVICE,
  SERVICE_ASSET,
  SERVICE_NETWORK,
  SERVICE_PAYEE,
  SERVICE_PAYMENT_TIMEOUT_SECONDS,
} from "../src/service-payment.mjs";
import { fetchAndVerifyX402Payment } from "../src/x402-payment-verifier.mjs";
import {
  buildReceiptRequest,
  validateCard,
  validatePluginPreview,
  validateProof,
} from "../skills/conviction-executor/scripts/conviction-card.mjs";
import {
  buildCloseReceiptRequest,
  validateCloseCard,
  validateClosePluginPreview,
  validateCloseProof,
} from "../skills/conviction-executor/scripts/conviction-exit-card.mjs";

const execFileAsync = promisify(execFile);
let executionAttempted = false;
const journalDirectory = join(homedir(), ".local", "state", "conviction", "reconciliation");
const executionLockFile = join(journalDirectory, "polymarket-execution.lock.json");
const journalPath = join(
  journalDirectory,
  `${new Date().toISOString().replace(/[:.]/g, "-")}-${process.pid}.json`,
);
const checkpoint = {
  mode: null,
  stage: "not_started",
  paymentTx: null,
  intentHash: null,
  orderId: null,
  settlementTx: null,
  positionProofHash: null,
  closeProofHash: null,
  closePassportHash: null,
  sourceIntentHash: null,
  sourcePositionProofHash: null,
  paidCard: null,
  liveResult: null,
  paymentProof: null,
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
  replayKey: null,
  replayLockPath: null,
  replayLockReleasedAt: null,
  replayLockReleaseError: null,
  executionLockPath: null,
  executionLockReleasedAt: null,
  executionLockReleaseError: null,
  reconciliationRequired: false,
  journalPath,
};

export async function writeReconciliationJournal(value, { directory = journalDirectory, file = journalPath } = {}) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const temporary = `${file}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, file);
  return file;
}

function usage() {
  return [
    "Usage:",
    "  node scripts/buyer-orchestrator.mjs open --origin <url> --market <slug-or-id>",
    "    --side YES|NO --budget <pUSD> --max-price <price>",
    "    --payment-payer <X-Layer-address> --buyer-wallet <Polygon-deposit-wallet>",
    "    --issuer-registry <issuers.json> [--json]",
    "",
    "  node scripts/buyer-orchestrator.mjs close --origin <url> --market <slug-or-id>",
    "    --side YES|NO --shares <whole-shares> --min-price <price>",
    "    --payment-payer <X-Layer-address> --seller-wallet <Polygon-deposit-wallet>",
    "    --source-proof <open-result-or-proof.json> --issuer-registry <issuers.json>",
    "    [--rationale <text>] [--json]",
    "",
    "  node scripts/buyer-orchestrator.mjs reconcile-close --journal <journey.json>",
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
  if (command === "reconcile-close" || command === "resume-close") {
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
  const common = {
    command,
    origin: take("--origin").replace(/\/$/, ""),
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
  );
  const normalized = {
    transactionHash: String(firstValue(
      direct?.transactionHash,
      positionProof?.transactionHash,
      receiptProof?.transactionHash,
      root.transactionHash,
      input.transactionHash,
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
      const originalSize = String(order?.original_size ?? "");
      const matchedSize = String(order?.size_matched ?? "0");
      if (!/^(0|[1-9]\d*)$/.test(originalSize) || !/^(0|[1-9]\d*)$/.test(matchedSize)) {
        throw new Error("sizes are not canonical atomic integers");
      }
      const originalRaw = BigInt(originalSize);
      const matchedRaw = BigInt(matchedSize);
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

export async function claimCloseReplayLock({
  key,
  journal,
  directory = journalDirectory,
} = {}) {
  if (!HASH_RE.test(String(key || ""))) {
    throw Object.assign(new Error("Close replay key is invalid"), { code: "invalid_replay_key" });
  }
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const file = join(directory, `close-${String(key).slice(2)}.lock.json`);
  let handle;
  try {
    handle = await open(file, "wx", 0o600);
    await handle.writeFile(`${JSON.stringify({
      version: "conviction-close-replay-lock-v1",
      replayKey: key,
      journalPath: journal,
      claimedAt: new Date().toISOString(),
    }, null, 2)}\n`);
  } catch (error) {
    if (error?.code === "EEXIST") {
      throw Object.assign(
        new Error("This exact CLOSE request was already claimed; reconcile its journal before any retry"),
        { code: "close_replay_blocked", details: { replayLockPath: file } },
      );
    }
    throw error;
  } finally {
    await handle?.close();
  }
  return file;
}

export async function claimExecutionLock({
  journal,
  directory = journalDirectory,
  file = executionLockFile,
} = {}) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  let handle;
  try {
    handle = await open(file, "wx", 0o600);
    await handle.writeFile(`${JSON.stringify({
      version: "conviction-polymarket-execution-lock-v1",
      pid: process.pid,
      journalPath: journal,
      claimedAt: new Date().toISOString(),
    }, null, 2)}\n`);
  } catch (error) {
    if (error?.code === "EEXIST") {
      throw Object.assign(
        new Error("Another Conviction execution is unresolved; reconcile its journal before trading"),
        { code: "execution_reconciliation_required", details: { executionLockPath: file } },
      );
    }
    throw error;
  } finally {
    await handle?.close();
  }
  return file;
}

export async function settleExecutionLock(
  state,
  {
    liveAttempted,
    proofVerified,
    unlinkImpl = unlink,
    now = Date.now(),
  } = {},
) {
  if (!state?.executionLockPath) return { released: false, retained: false };
  if (liveAttempted && !proofVerified) {
    return { released: false, retained: true, path: state.executionLockPath };
  }
  try {
    await unlinkImpl(state.executionLockPath);
    const releasedPath = state.executionLockPath;
    state.executionLockReleasedAt = new Date(now).toISOString();
    state.executionLockPath = null;
    return { released: true, retained: false, path: releasedPath };
  } catch (error) {
    state.executionLockReleaseError = error?.code || "lock_release_failed";
    return { released: false, retained: true, path: state.executionLockPath };
  }
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

async function commandJson(file, args, label) {
  try {
    const { stdout: output } = await execFileAsync(file, args, {
      timeout: 60_000,
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
    signal: AbortSignal.timeout(30_000),
  });
  const text = await response.text();
  let json;
  try { json = text ? JSON.parse(text) : null; } catch { json = null; }
  return { response, json, text };
}

function decodeHeader(value, label) {
  try {
    return JSON.parse(Buffer.from(String(value || ""), "base64").toString("utf8"));
  } catch {
    throw Object.assign(new Error(`${label} is missing or invalid`), { code: "invalid_payment_header" });
  }
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
    "paid_request_rejected_pre_settlement",
    "paid_request_settlement_ambiguous",
  ]);
  const response = state?.paidServiceResponse;
  const responseMatchesStage = state?.stage === "payment_authorization_created"
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
  return addresses?.data?.xlayer?.find((entry) => String(entry.chainIndex) === String(chainIndex))?.address;
}

function depositWalletFromQuickstart(quickstart) {
  const data = quickstart?.data || quickstart;
  const address = data?.wallet?.deposit_wallet;
  return address ? String(address).toLowerCase() : null;
}

function safeStatePath(value, kind, stateDirectory = journalDirectory) {
  const stateRoot = resolve(stateDirectory);
  const candidate = resolve(String(value || ""));
  if (!candidate.startsWith(`${stateRoot}${sep}`)) {
    throw Object.assign(new Error(`${kind} path is outside Conviction's private state directory`), {
      code: "unsafe_state_path",
    });
  }
  const name = basename(candidate);
  const valid = kind === "journal"
    ? name.endsWith(".json") && !name.endsWith(".lock.json")
    : kind === "replay lock"
      ? /^close-[0-9a-f]{64}\.lock\.json$/.test(name)
      : name === "polymarket-execution.lock.json";
  if (!valid) {
    throw Object.assign(new Error(`${kind} path is not a recognized Conviction state file`), {
      code: "unsafe_state_path",
    });
  }
  return candidate;
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
    try {
      lock = JSON.parse(await readFile(file, "utf8"));
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
      throw Object.assign(new Error(`${kind} cannot be verified before release`), {
        code: "lock_ownership_mismatch",
      });
    }
    const owned = field === "replayLockPath"
      ? HASH_RE.test(String(state.replayKey || "")) &&
        basename(file) === `close-${String(state.replayKey).slice(2)}.lock.json` &&
        lock?.version === "conviction-close-replay-lock-v1" &&
        lock?.replayKey === state.replayKey && lock?.journalPath === journal
      : basename(file) === "polymarket-execution.lock.json" &&
        lock?.version === "conviction-polymarket-execution-lock-v1" &&
        lock?.journalPath === journal;
    if (!owned) {
      throw Object.assign(new Error(`${kind} belongs to another journey`), {
        code: "lock_ownership_mismatch",
      });
    }
    checked.push({ field, file, missing: false });
  }

  return checked;
}

export async function releaseReconciledLocks(
  state,
  {
    stateDirectory = journalDirectory,
    journal,
    fields = ["replayLockPath", "executionLockPath"],
  } = {},
) {
  const checked = await verifyJournalLockOwnership(state, {
    stateDirectory,
    journal,
    fields,
  });

  const released = [];
  for (const { field, file, missing } of checked) {
    if (!missing) {
      try {
        await unlink(file);
        released.push(file);
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
    }
    state[field] = null;
  }
  return released;
}

async function releaseUnsentReplayLock(state, { journal = journalPath } = {}) {
  try {
    await releaseReconciledLocks(state, {
      journal,
      fields: ["replayLockPath"],
    });
    state.replayKey = null;
    state.replayLockReleaseError = null;
  } catch (error) {
    state.replayLockReleaseError = error?.code || "lock_release_failed";
    state.reconciliationRequired = true;
    throw Object.assign(new Error("Unsent payment replay lock could not be released safely"), {
      code: "replay_lock_release_failed",
      cause: error,
    });
  }
}

export async function reconcileCloseJournal({
  file,
  trustedIssuers,
  now = Date.now(),
  verifyClose = fetchAndVerifyClose,
  validateCardImpl = validateCloseCard,
  authorizationStateImpl = fetchEip3009AuthorizationState,
  stateDirectory = journalDirectory,
} = {}) {
  const journal = safeStatePath(file, "journal", stateDirectory);
  const state = JSON.parse(await readFile(journal, "utf8"));
  if (state?.mode !== "close") {
    throw Object.assign(new Error("Journal is not a Conviction CLOSE journey"), { code: "invalid_reconciliation_journal" });
  }

  let reason;
  let proof;
  if (HASH_RE.test(String(state.settlementTx || "")) && HASH_RE.test(String(state.orderId || "")) && state.paidCard) {
    proof = await verifyClose(state.settlementTx, {
      intent: state.paidCard.intent,
      intentHash: state.paidCard.intentHash,
      orderId: state.orderId,
      issuance: state.paidCard.issuance,
      trustedIssuers,
    });
    reason = "verified_settlement";
  } else if (!state.executionArgvHash && state.paidCard) {
    const card = validateCardImpl(state.paidCard, {
      trustedIssuers,
      allowExpired: true,
      now,
    });
    if (Date.parse(card.expiresAt) > now) {
      return {
        ok: true,
        status: "waiting_for_card_expiry",
        expiresAt: card.expiresAt,
        reconciliationRequired: true,
        journalPath: journal,
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
    state.reconciliationAuthorizationState = authorizationState;
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
  });
  state.stage = reason === "verified_settlement"
    ? "complete_reconciled"
    : reason === "expired_unsettled_authorization"
      ? "expired_unsettled_authorization_reconciled"
      : "expired_unexecuted_reconciled";
  state.reconciliationRequired = false;
  state.reconciledAt = new Date(now).toISOString();
  state.reconciliationReason = reason;
  if (proof) {
    state.closeProofHash = proof.closeProofHash;
    state.closePassportHash = proof.closePassportHash;
  }
  await writeReconciliationJournal(state, { directory: dirname(journal), file: journal });
  return {
    ok: true,
    status: state.stage,
    reconciliationRequired: false,
    journalPath: journal,
    releasedLocks,
    ...(proof ? {
      transactionHash: proof.closeProof.transactionHash,
      closeProofHash: proof.closeProofHash,
      closePassportHash: proof.closePassportHash,
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
    !state.executionArgv && !state.executionArgvHash && !state.executionLockPath &&
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
    "buildCloseReceiptRequest", "fetchCloseProof", "validateCloseProof",
  ]) {
    resumeInvariant(typeof adapters?.[name] === "function", "invalid_adapter", `Missing resume adapter: ${name}`);
  }

  const journal = safeStatePath(file, "journal", stateDirectory);
  const state = JSON.parse(await readFile(journal, "utf8"));
  requireExactResumeCheckpoint(state, journal);
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
  const preLockCheckpointHash = sha256(state);
  try {
    state.executionLockPath = await claimExecutionLockImpl({
      journal,
      directory: stateDirectory,
      file: executionFile,
    });
    lockClaimed = true;
    const lockedState = JSON.parse(await readFile(journal, "utf8"));
    resumeInvariant(
      sha256(lockedState) === preLockCheckpointHash,
      "resume_checkpoint_changed",
      "Paid CLOSE checkpoint changed while acquiring the execution lock",
    );
    requireExactResumeCheckpoint(lockedState, journal);
    await verifyJournalLockOwnership(lockedState, {
      stateDirectory,
      journal,
      fields: ["replayLockPath"],
      requirePresent: true,
    });
    lockStateVerified = true;
    state.stage = "resume_execution_lock_acquired";
    state.resumeStartedAt = new Date(now()).toISOString();
    await writeReconciliationJournal(state, { directory: stateDirectory, file: journal });

    await adapters.ensureTradingMode({ sellerWallet: state.buyerWallet });
    validated = await adapters.validateCloseCard(state.paidCard, {
      trustedIssuers,
      now: now(),
    });
    bindResumeCard({ state, request, validated, verifiedSource });
    const consent = validateResumeConsent({ state, validated, paymentProof, now: now() });
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
    const dryRun = await adapters.dryRun(validated.executionCard.argv);
    await adapters.validateCloseDryRun(state.paidCard, dryRun, {
      trustedIssuers,
      now: now(),
    });

    // The durable marker is written before the first possibly-live call. Any
    // crash or error after this point is ambiguous and is never auto-retried.
    state.stage = "execution_attempted";
    state.executionArgv = [...validated.executionCard.argv];
    state.executionArgvHash = consent.argvHash;
    state.executionAttemptedAt = new Date(now()).toISOString();
    state.reconciliationRequired = true;
    await writeReconciliationJournal(state, { directory: stateDirectory, file: journal });
    liveAttempted = true;

    const liveResult = await adapters.execute(validated.executionCard.argv);
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
      Date.parse(proof.settledAt) >= Math.floor(consent.confirmedAt / 1_000) * 1_000,
      "settlement_before_confirmation",
      "Verified CLOSE settlement predates the recorded trade consent",
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
    });
    state.stage = "complete_resumed";
    state.reconciliationRequired = false;
    state.resumedAt = new Date(now()).toISOString();
    state.resumeError = null;
    await writeReconciliationJournal(state, { directory: stateDirectory, file: journal });
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
    state.reconciliationRequired = true;
    state.resumeError = {
      code: error?.code || "resume_failed",
      at: new Date(now()).toISOString(),
      executionAmbiguous: liveAttempted,
    };
    if (lockClaimed && !liveAttempted) {
      try {
        await releaseReconciledLocks(state, {
          stateDirectory,
          journal,
          fields: ["executionLockPath"],
        });
        if (lockStateVerified) state.stage = "trade_confirmed";
      } catch (releaseError) {
        state.resumeError.lockReleaseError = releaseError?.code || "lock_release_failed";
      }
    }
    if (lockClaimed && lockStateVerified) {
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
}) {
  const data = quickstart?.data || quickstart;
  const depositWallet = depositWalletFromQuickstart(quickstart);
  const status = data?.status;
  const explicitTradingAddress = data?.trading_address;
  const normalizedMode = selectedMode === "deposit-wallet"
    ? "deposit_wallet"
    : selectedMode;
  const depositWalletActive =
    normalizedMode === "deposit_wallet" &&
    (status === "active" || status === "deposit_wallet_ready");

  return {
    accessible:
      access?.data?.accessible === true &&
      data?.accessible !== false,
    clobVersion: depositWalletActive ? "V2" : "",
    currentMode: normalizedMode,
    paymentPayer: String(findAddress(addresses, 196) || "").toLowerCase(),
    buyerWallet: depositWallet || "",
    tradingAddress: String(explicitTradingAddress || depositWallet || "").toLowerCase(),
    pUsdBalanceRaw,
  };
}

async function polygonPusdBalanceRaw(wallet) {
  const rpc = async (method, params) => {
    const response = await fetch(POLYGON_RPC_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal: AbortSignal.timeout(10_000),
    });
    const body = await response.json();
    if (!response.ok || body.error) {
      throw Object.assign(new Error("Polygon balance RPC failed"), { code: "balance_rpc_error" });
    }
    return body.result;
  };
  const chainHex = await rpc("eth_chainId", []);
  if (Number(BigInt(chainHex)) !== POLYGON_CHAIN_ID) {
    throw Object.assign(new Error("Balance RPC is not Polygon chain 137"), { code: "wrong_balance_chain" });
  }
  const result = await rpc("eth_call", [{
    to: CONTRACTS.pUsd,
    data: `0x70a08231${wallet.slice(2).padStart(64, "0")}`,
  }, "latest"]);
  if (!/^0x[0-9a-f]+$/i.test(result || "")) {
    throw Object.assign(new Error("Could not read the deposit wallet's atomic pUSD balance"), { code: "balance_rpc_error" });
  }
  return BigInt(result).toString();
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
  if (options.command === "reconcile-close" || options.command === "resume-close") {
    const trustedIssuerDocument = JSON.parse(await readFile(options.issuerRegistry, "utf8"));
    const trustedIssuers = trustedIssuerRegistry(trustedIssuerDocument.issuers || trustedIssuerDocument);
    if (trustedIssuers.size === 0) {
      throw Object.assign(new Error("Pinned issuer registry is empty"), { code: "missing_trusted_issuer" });
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
        commandJson("polymarket-plugin", ["check-access"], "Polymarket access check"),
        commandJson("onchainos", ["wallet", "addresses"], "Agentic Wallet addresses"),
        commandJson("polymarket-plugin", ["quickstart"], "Polymarket readiness"),
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
            "polymarket-plugin",
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
        dryRun: (executionArgv) => commandJson(
          "polymarket-plugin",
          [...executionArgv, "--dry-run"],
          "Resumed Polymarket dry run",
        ),
        validateCloseDryRun: (card, dryRun, validationOptions) => validateClosePluginPreview(card, dryRun, validationOptions),
        execute: (executionArgv) => commandJson("polymarket-plugin", executionArgv, "Resumed Polymarket live order"),
        buildCloseReceiptRequest: (card, liveResult, validationOptions) => buildCloseReceiptRequest(card, liveResult, validationOptions),
        fetchCloseProof: (receiptRequest) => fetchAndVerifyClose(receiptRequest.transactionHash, {
          intent: receiptRequest.intent,
          intentHash: receiptRequest.intentHash,
          orderId: receiptRequest.orderId,
          issuance: receiptRequest.issuance,
          trustedIssuers,
        }),
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
            `  Market: ${b.market}`,
            `  Side: ${b.side}`,
            `  Maximum price: ${b.maxPrice}`,
            `  Maximum order principal: ${b.maximumOrderPrincipalRaw} atomic pUSD`,
            `  Current venue-fee reserve: ${b.maximumFeeRaw} atomic pUSD (V2 fee is operator-set at match time)`,
            `  Accepted total-debit ceiling for verification: ${b.maximumTotalDebitRaw} atomic pUSD`,
            `  Current pUSD balance: ${latestReadiness?.pUsdBalanceRaw || "unknown"} atomic`,
            `  Buyer wallet: ${b.wallet}`,
            `  Expires: ${b.expiresAt}`,
            "  Polygon settlement is irreversible.",
            "",
          ].join("\n"));
        }
      }
    };
  const readline = createInterface({ input: stdin, output: options.json ? stderr : stdout });
  let paymentConsentUsed = false;
  let selectedTradingMode = "";
  const confirm = async (kind, context = {}) => {
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
      checkpoint.tradeConfirmedAt = new Date().toISOString();
      if (closeMode) {
        checkpoint.tradeConsent = {
          version: "conviction-close-trade-consent-v1",
          intentHash: context.validated.intentHash,
          executionArgvHash: sha256(context.validated.executionCard.argv),
          paymentTx: checkpoint.paymentTx,
          replayKey: checkpoint.replayKey,
          confirmedAt: checkpoint.tradeConfirmedAt,
          expiresAt: context.validated.expiresAt,
        };
        checkpoint.stage = "trade_confirmed";
        checkpoint.reconciliationRequired = true;
      }
      await writeReconciliationJournal(checkpoint);
    }
    return accepted;
  };

  const loadReadiness = async () => {
    const [access, addresses, quickstart] = await Promise.all([
      commandJson("polymarket-plugin", ["check-access"], "Polymarket access check"),
      commandJson("onchainos", ["wallet", "addresses"], "Agentic Wallet addresses"),
      commandJson("polymarket-plugin", ["quickstart"], "Polymarket readiness"),
    ]);
    const depositWallet = depositWalletFromQuickstart(quickstart);
    const pUsdBalanceRaw = depositWallet ? await polygonPusdBalanceRaw(depositWallet) : "0";
    latestReadiness = normalizePluginReadiness({
      access,
      addresses,
      quickstart,
      selectedMode: selectedTradingMode,
      pUsdBalanceRaw,
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
        "polymarket-plugin",
        ["switch-mode", "--mode", "deposit-wallet"],
        "Polymarket trading-mode selection",
      );
      const result = switched?.data || switched;
      if (result?.mode !== "deposit-wallet") {
        throw Object.assign(new Error("Polymarket did not select DEPOSIT_WALLET mode"), {
          code: "wrong_trading_mode",
        });
      }
      selectedTradingMode = result.mode;
      return result;
    },
    checkReadiness: loadReadiness,
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
      const { response, json } = await postJson(`${options.origin}/api/preview`, requestBody);
      if (!response.ok || json?.ok !== true) {
        throw Object.assign(new Error(json?.error?.message || "Free bounds preview failed"), {
          code: json?.error?.code || "preview_failed",
        });
      }
      return {
        conditionId: json.preview.market.conditionId,
        outcomeTokenId: json.preview.market.outcomeTokenId,
      };
    },
    previewClose: async () => {
      const { response, json } = await postJson(`${options.origin}/api/manage-preview`, requestBody);
      if (!response.ok || json?.ok !== true) {
        throw Object.assign(new Error(json?.error?.message || "Free CLOSE preview failed"), {
          code: json?.error?.code || "preview_failed",
        });
      }
      return json;
    },
    requestPaymentChallenge: async () => {
      if (closeMode) {
        checkpoint.paymentRequestedAt = new Date().toISOString();
        checkpoint.stage = "payment_challenge_requested";
        await writeReconciliationJournal(checkpoint);
      }
      const { response, json } = await postJson(`${options.origin}${service.path}`, requestBody);
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
      if (closeMode) {
        checkpoint.replayKey = closeReplayKey({
          request: journeyRequest,
          sellerWallet: options.sellerWallet,
        });
        checkpoint.replayLockPath = await claimCloseReplayLock({
          key: checkpoint.replayKey,
          journal: journalPath,
        });
        checkpoint.stage = "payment_authorization_starting";
        await writeReconciliationJournal(checkpoint);
        createdReplayLock = true;
      }
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
      const headerName = data.header_name || "PAYMENT-SIGNATURE";
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
      const { response, json } = await postJson(`${options.origin}${service.path}`, requestBody, {
        headers: { [headerName]: data.authorization_header },
      });
      const paymentResponseRaw = response.headers.get("payment-response");
      checkpoint.paidServiceResponse = {
        status: response.status,
        paymentResponsePresent: Boolean(paymentResponseRaw),
      };
      if (!response.ok || json?.ok !== true) {
        checkpoint.stage = response.status >= 400 && !paymentResponseRaw
          ? "paid_request_rejected_pre_settlement"
          : "paid_request_settlement_ambiguous";
        checkpoint.reconciliationRequired = true;
        await writeReconciliationJournal(checkpoint);
        throw Object.assign(new Error(json?.error?.message || "Paid service request failed"), {
          code: json?.error?.code || "paid_service_failed",
        });
      }
      const paymentResponse = decodeHeader(paymentResponseRaw, "PAYMENT-RESPONSE");
      const paymentTx = paymentTransaction(paymentResponse);
      checkpoint.stage = "paid_card_received";
      checkpoint.paymentTx = paymentTx;
      checkpoint.intentHash = json.intentHash || null;
      checkpoint.paidCard = json;
      await writeReconciliationJournal(checkpoint);
      return { card: json, paymentResponse, paymentTx };
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
      checkpoint.stage = "payment_verified";
      checkpoint.paymentProof = result.proof;
      await writeReconciliationJournal(checkpoint);
      return result.proof;
    },
    validateCard: async (card, validationOptions) => validateCard(card, validationOptions),
    validateCloseCard: async (card, validationOptions) => validateCloseCard(card, validationOptions),
    dryRun: async (argv) => commandJson("polymarket-plugin", [...argv, "--dry-run"], "Polymarket dry run"),
    validateDryRun: async (card, dryRun, validationOptions) => validatePluginPreview(card, dryRun, validationOptions),
    validateCloseDryRun: async (card, dryRun, validationOptions) => validateClosePluginPreview(card, dryRun, validationOptions),
    execute: async (argv) => {
      checkpoint.executionLockPath = await claimExecutionLock({ journal: journalPath });
      checkpoint.stage = "execution_lock_acquired";
      await writeReconciliationJournal(checkpoint);
      try {
        const reasserted = await commandJson(
          "polymarket-plugin",
          ["switch-mode", "--mode", "deposit-wallet"],
          "Final Polymarket trading-mode selection",
        );
        if ((reasserted?.data || reasserted)?.mode !== "deposit-wallet") {
          throw Object.assign(new Error("Polymarket did not preserve DEPOSIT_WALLET mode before CLOSE"), {
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
          const lockedCard = validateCloseCard(checkpoint.paidCard, {
            trustedIssuers: pinnedRegistry,
            now: Date.now(),
          });
          if (Date.parse(lockedCard.expiresAt) - Date.now() < 10_000) {
            throw Object.assign(new Error("Signed CLOSE card has too little time left for locked submission"), {
              code: "insufficient_execution_window",
            });
          }
          const lockedDryRun = await commandJson(
            "polymarket-plugin",
            [...argv, "--dry-run"],
            "Locked final Polymarket dry run",
          );
          validateClosePluginPreview(checkpoint.paidCard, lockedDryRun, {
            trustedIssuers: pinnedRegistry,
            now: Date.now(),
          });
        } else {
          const lockedReadiness = await loadReadiness();
          if (
            lockedReadiness.currentMode !== "deposit_wallet" ||
            lockedReadiness.buyerWallet !== tradingWallet ||
            lockedReadiness.tradingAddress !== tradingWallet
          ) {
            throw Object.assign(new Error("Active deposit wallet changed immediately before OPEN"), {
              code: "trading_wallet_mismatch",
            });
          }
        }

        executionAttempted = true;
        checkpoint.stage = "execution_attempted";
        checkpoint.reconciliationRequired = true;
        checkpoint.executionArgv = [...argv];
        checkpoint.executionArgvHash = sha256(argv);
        await writeReconciliationJournal(checkpoint);
        const result = await commandJson("polymarket-plugin", argv, "Polymarket live order");
        checkpoint.liveResult = result;
        const data = result?.data || result;
        checkpoint.stage = "live_result_received";
        checkpoint.orderId = data?.order_id || null;
        checkpoint.settlementTx = Array.isArray(data?.tx_hashes) ? data.tx_hashes[0] || null : null;
        await writeReconciliationJournal(checkpoint);
        return result;
      } finally {
        await settleExecutionLock(checkpoint, {
          liveAttempted: executionAttempted,
          proofVerified: false,
        });
        await writeReconciliationJournal(checkpoint);
      }
    },
    buildReceiptRequest: async (card, result, validationOptions) => buildReceiptRequest(card, result, validationOptions),
    buildCloseReceiptRequest: async (card, result, validationOptions) => buildCloseReceiptRequest(card, result, validationOptions),
    fetchProof: async (body) => {
      const { response, json } = await postJson(`${options.origin}/api/receipt`, body);
      if (!response.ok || json?.ok !== true) {
        throw Object.assign(new Error(json?.error?.message || "Receipt proof failed"), {
          code: json?.error?.code || "receipt_failed",
        });
      }
      checkpoint.stage = "proof_received";
      checkpoint.positionProofHash = json.positionProofHash || null;
      checkpoint.reconciliationRequired = false;
      await writeReconciliationJournal(checkpoint);
      return json;
    },
    validateProof: async (card, proof, validationOptions) => validateProof(card, proof, validationOptions),
    fetchCloseProof: async (body) => {
      const proof = await fetchAndVerifyClose(body.transactionHash, {
        intent: body.intent,
        intentHash: body.intentHash,
        orderId: body.orderId,
        issuance: body.issuance,
        trustedIssuers: pinnedRegistry,
      });
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
    stdout.write(`${JSON.stringify(result)}\n`);
    checkpoint.stage = "complete";
    checkpoint.reconciliationRequired = false;
    await settleExecutionLock(checkpoint, {
      liveAttempted: executionAttempted,
      proofVerified: true,
    });
    if (checkpoint.replayLockPath) {
      try {
        await unlink(checkpoint.replayLockPath);
        checkpoint.replayLockReleasedAt = new Date().toISOString();
        checkpoint.replayLockPath = null;
      } catch (error) {
        checkpoint.replayLockReleaseError = error?.code || "lock_release_failed";
      }
    }
    await writeReconciliationJournal(checkpoint);
  } finally {
    readline.close();
  }
}

function isMain() {
  return process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
}

if (isMain()) {
  try {
    await main();
  } catch (error) {
    const stateCommand = process.argv[2] === "reconcile-close" || process.argv[2] === "resume-close";
    if (!stateCommand) {
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
        reconciliationRequired: checkpoint.reconciliationRequired,
        journalPath,
        checkpoint,
      }),
    })}\n`);
    process.exitCode = 1;
  }
}
