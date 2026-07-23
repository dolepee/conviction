#!/usr/bin/env node

// Gate C is the executable release definition for Conviction's bounded
// TAKE_PROFIT placement path. Offline mode proves the fail-closed journey
// without network calls. Dry mode adds read-only production probes. Live mode
// launches the public buyer CLI with inherited stdin: the buyer must separately
// confirm the 0.10 USD₮0 manager payment and the one post-only GTD SELL.

import { spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { evaluateTakeProfitAcceptanceTiming } from "../src/acceptance-timing.mjs";
import { runTakeProfitJourney } from "../src/buyer-orchestrator.mjs";
import { parseDecimal } from "../src/decimal.mjs";
import { trustedIssuerRegistry } from "../src/intent-issuer.mjs";
import { fetchExactOrder } from "../src/polymarket-open-orders.mjs";
import { parsePolymarketShareAtoms } from "../src/polymarket-quantities.mjs";
import { polymarketRuntimeEvidence } from "../src/polymarket-runtime.mjs";
import { localSourceEvidence } from "../src/source-evidence.mjs";
import { verifySourcePosition } from "../src/source-position.mjs";
import {
  POSITION_MANAGER_SERVICE,
  SERVICE_ASSET,
  SERVICE_NETWORK,
  SERVICE_PAYEE,
} from "../src/service-payment.mjs";
import { validateArmedTakeProfitJournal } from "../src/take-profit-lifecycle.mjs";
import { evaluateTakeProfitConsentBinding } from "../src/take-profit-acceptance.mjs";
import { fetchAndVerifyX402Payment } from "../src/x402-payment-verifier.mjs";
import { validateTakeProfitCard } from "../skills/conviction-executor/scripts/conviction-take-profit-card.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HASH_RE = /^0x[0-9a-f]{64}$/i;
const ADDRESS_RE = /^0x[0-9a-f]{40}$/i;
const argv = process.argv.slice(2);
const has = (name) => argv.includes(`--${name}`);
const take = (name, fallback = undefined) => {
  const index = argv.indexOf(`--${name}`);
  return index >= 0 && argv[index + 1] && !argv[index + 1].startsWith("--")
    ? argv[index + 1]
    : fallback;
};
const mode = has("live") ? "live" : has("dry") ? "dry" : "offline";
const productionOrigin = new URL(POSITION_MANAGER_SERVICE.resource).origin;
const origin = String(take("origin", productionOrigin)).replace(/\/$/, "");
const runId = new Date().toISOString().replace(/[:.]/g, "-");
const reportPath = take(
  "report",
  path.join(
    HERE,
    "..",
    mode === "live" ? `acceptance-report-c-live-${runId}.json` : `acceptance-report-c-${mode}.json`,
  ),
);
const orchestratorPath = path.join(HERE, "take-profit-orchestrator.mjs");
const productionRegistryPath = path.join(HERE, "..", "config", "trusted-issuer.production.json");
const source = localSourceEvidence({ cwd: path.join(HERE, "..") });
if (mode === "live" && !source.trackedTreeClean) {
  throw new Error("Live acceptance requires a clean tracked source tree");
}
const results = [];
let reconciliation;
let executionRuntime = polymarketRuntimeEvidence({ verified: false });

function record(id, name, status, detail = "") {
  results.push({ id, name, status, detail });
  process.stdout.write(`${status.padEnd(7)} ${id.padEnd(5)} ${name}${detail ? ` — ${detail}` : ""}\n`);
}

function firstObject(...values) {
  return values.find((value) => value && typeof value === "object" && !Array.isArray(value));
}

function loadSourcePosition(file) {
  const document = JSON.parse(readFileSync(file, "utf8"));
  const root = firstObject(document.response, document.result, document) || document;
  const direct = firstObject(root.sourcePosition, root.open?.sourcePosition);
  const intent = firstObject(direct?.intent, root.canonicalIntent, root.intent, root.paidCard?.intent, root.positionPassport?.intent);
  const positionProof = firstObject(root.positionProof, root.positionPassport?.positionProof, root.verifiedPositionProof);
  const receiptProof = firstObject(root.receiptProof, root.positionPassport?.receiptProof);
  const hashes = firstObject(root.hashes) || {};
  if (!intent) throw Object.assign(new Error("Source proof file has no canonical sourcePosition envelope"), { code: "invalid_source_proof_file" });
  const firstValue = (...values) => values.find((value) => value !== undefined && value !== null && value !== "");
  const source = {
    transactionHash: firstValue(direct?.transactionHash, positionProof?.transactionHash, receiptProof?.transactionHash, root.transactionHash, root.settlementTx),
    orderId: firstValue(direct?.orderId, positionProof?.orderId, receiptProof?.orderId, root.orderId),
    intentHash: firstValue(direct?.intentHash, positionProof?.intentHash, hashes.intentHash, root.intentHash),
    positionProofHash: firstValue(direct?.positionProofHash, root.positionProofHash, hashes.positionProofHash, root.verifiedPositionProof?.positionProofHash),
    intent,
    issuance: firstObject(direct?.issuance, root.issuance, root.paidCard?.issuance, root.positionPassport?.issuance),
  };
  for (const field of ["transactionHash", "orderId", "intentHash", "positionProofHash"]) {
    if (!HASH_RE.test(String(source[field] || ""))) {
      throw Object.assign(new Error(`Source proof file has no valid ${field}`), { code: "invalid_source_proof_file" });
    }
  }
  return {
    transactionHash: String(source.transactionHash).toLowerCase(),
    orderId: String(source.orderId).toLowerCase(),
    intentHash: String(source.intentHash).toLowerCase(),
    intent: source.intent,
    ...(source.issuance ? { issuance: source.issuance } : {}),
    positionProofHash: String(source.positionProofHash).toLowerCase(),
  };
}

function decodeChallenge(encoded) {
  try {
    return JSON.parse(Buffer.from(String(encoded || ""), "base64").toString("utf8"));
  } catch {
    return null;
  }
}

function isPinnedManagerChallenge(challenge) {
  const accepts = challenge?.accepts;
  const requirement = Array.isArray(accepts) && accepts.length === 1 ? accepts[0] : null;
  return challenge?.x402Version === 2 &&
    challenge?.resource?.url === POSITION_MANAGER_SERVICE.resource &&
    requirement?.scheme === "exact" && requirement?.network === SERVICE_NETWORK &&
    requirement?.amount === POSITION_MANAGER_SERVICE.priceAtomic &&
    String(requirement?.asset || "").toLowerCase() === SERVICE_ASSET &&
    String(requirement?.payTo || "").toLowerCase() === SERVICE_PAYEE;
}

function fixture({ mutateValidated, validationError, tradeConsent = true, mutateFinalReadiness } = {}) {
  let clock = Date.parse("2030-01-01T00:00:10.250Z");
  let readinessCalls = 0;
  let orders = 0;
  const payer = "0x1111111111111111111111111111111111111111";
  const wallet = "0x2222222222222222222222222222222222222222";
  const conditionId = `0x${"ab".repeat(32)}`;
  const tokenId = "123456789";
  const source = {
    intentHash: `0x${"31".repeat(32)}`,
    positionProofHash: `0x${"32".repeat(32)}`,
    transactionHash: `0x${"33".repeat(32)}`,
    orderId: `0x${"34".repeat(32)}`,
    wallet,
    marketConditionId: conditionId,
    outcome: "YES",
    outcomeTokenId: tokenId,
    actualSharesRaw: "5000000",
  };
  const sourcePosition = {
    intentHash: source.intentHash,
    positionProofHash: source.positionProofHash,
    transactionHash: source.transactionHash,
    orderId: source.orderId,
    intent: { version: "conviction-intent-v4" },
    issuance: { version: "conviction-issuance-v1" },
  };
  const expiresAt = "2030-01-01T00:05:00.000Z";
  const venueExpiresAt = "2030-01-01T01:00:00.000Z";
  const venueExpiresAtUnix = String(Date.parse(venueExpiresAt) / 1_000);
  const validated = {
    wallet,
    outcome: "YES",
    tokenId,
    intentHash: `0x${"cd".repeat(32)}`,
    expiresAt,
    intent: { market: { conditionId, question: "Fixture market?" }, source },
    executionCard: { argv: ["sell", "--token-id", tokenId, "--shares", "5", "--price", "0.4", "--order-type", "GTD", "--post-only", "--expires", venueExpiresAtUnix] },
    issuanceVerification: { keyId: "fixture", fingerprint: `sha256:${"11".repeat(32)}`, issuedAt: "2030-01-01T00:00:00.000Z" },
    bounds: {
      sharesRaw: "5000000", targetPrice: "0.4", minimumGrossProceedsRaw: "2000000",
      maximumFeeRaw: "0", minimumNetProceedsRaw: "2000000", venueExpiresAt, venueExpiresAtUnix,
    },
  };
  const baseReadiness = {
    accessible: true, clobVersion: "V2", currentMode: "deposit_wallet", paymentPayer: payer,
    buyerWallet: wallet, tradingAddress: wallet, outcomeTokenId: tokenId, outcomeBalanceRaw: "5000000",
    approvedForExchange: true, reservedSharesRaw: "0", openSellOrderCount: 0, openOrdersComplete: true,
  };
  const adapters = {
    ensureTradingMode: async () => ({ currentMode: "deposit_wallet" }),
    checkReadiness: async () => baseReadiness,
    previewTakeProfit: async () => ({
      ok: true,
      preview: {
        action: "TAKE_PROFIT", executable: false,
        market: { conditionId, outcomeTokenId: tokenId },
        order: { side: "SELL", orderType: "GTD", postOnly: true, outcome: "YES", outcomeTokenId: tokenId, sharesRaw: "5000000", targetPrice: "0.4", venueExpiresAt, venueExpiresAtUnix },
        source,
      },
    }),
    checkTakeProfitReadiness: async () => {
      readinessCalls += 1;
      return readinessCalls === 2 && mutateFinalReadiness ? { ...baseReadiness, ...mutateFinalReadiness } : baseReadiness;
    },
    requestPaymentChallenge: async () => ({ decoded: { resource: { url: POSITION_MANAGER_SERVICE.resource }, accepts: [{ amount: POSITION_MANAGER_SERVICE.priceAtomic, network: SERVICE_NETWORK, asset: SERVICE_ASSET, payTo: SERVICE_PAYEE }] } }),
    payAndRequestCard: async () => ({ card: {}, paymentTx: `0x${"ef".repeat(32)}` }),
    verifyPayment: async () => ({ transactionHash: `0x${"ef".repeat(32)}` }),
    validateTakeProfitCard: async () => {
      if (validationError) throw validationError;
      return mutateValidated ? mutateValidated(structuredClone(validated)) : structuredClone(validated);
    },
    dryRun: async () => ({ ok: true, dry_run: true }),
    validateTakeProfitDryRun: async () => ({ ok: true }),
    waitUntil: async (target) => { clock = Math.max(clock, target); },
    execute: async () => { orders += 1; return { ok: true, data: { order_id: `0x${"41".repeat(32)}`, status: "live" } }; },
    validateTakeProfitLiveResult: async () => ({ ok: true, orderId: `0x${"41".repeat(32)}` }),
    fetchExactOrder: async () => ({ order: { createdAt: String(Math.floor(clock / 1_000)) } }),
    buildTakeProfitOrderProof: async () => ({
      ok: true, orderId: `0x${"41".repeat(32)}`,
      restingOrderProof: { status: "ARMED", onChain: false }, restingOrderProofHash: `0x${"42".repeat(32)}`,
      takeProfitPassport: { version: "conviction-take-profit-passport-v1" }, takeProfitPassportHash: `0x${"43".repeat(32)}`,
    }),
  };
  return {
    input: {
      request: { action: "take_profit", market: "fixture", outcome: "YES", shares: "5", targetPrice: "0.4", venueExpiresAt, sourcePosition },
      paymentPayer: payer, sellerWallet: wallet, trustedIssuers: [], adapters,
      confirm: async (kind) => kind === "payment" || tradeConsent,
      now: () => (clock += 5),
    },
    orders: () => orders,
  };
}

async function adversarialProbe(id, name, options, expectedCode) {
  const prepared = fixture(options);
  let code;
  try { await runTakeProfitJourney(prepared.input); } catch (error) { code = error?.code; }
  const passed = code === expectedCode && prepared.orders() === 0;
  record(id, name, passed ? "PASS" : "FAIL", `code:${code || "none"} orders:${prepared.orders()}`);
}

async function probeManagerChallenge() {
  try {
    const response = await fetch(`${origin}${POSITION_MANAGER_SERVICE.path}`, { signal: AbortSignal.timeout(20_000) });
    const valid = response.status === 402 && isPinnedManagerChallenge(decodeChallenge(response.headers.get("payment-required")));
    record("0", "Bare manager endpoint returns the pinned 0.10 x402 challenge", valid ? "PASS" : "FAIL", `HTTP ${response.status}`);
  } catch (error) {
    record("0", "Bare manager endpoint returns the pinned 0.10 x402 challenge", "FAIL", error?.message || "probe failed");
  }
}

function liveInputs() {
  return {
    market: take("market"), side: take("side")?.toUpperCase(), shares: take("shares"),
    targetPrice: take("target-price"), venueExpiresAt: take("expires-at"),
    paymentPayer: take("payment-payer")?.toLowerCase(), sellerWallet: take("seller-wallet")?.toLowerCase(),
    sourceProof: take("source-proof"), rationale: take("rationale", ""),
  };
}

async function probePreview(required, sourcePosition) {
  const response = await fetch(`${origin}/api/manage-preview`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      action: "take_profit", market: required.market, outcome: required.side.toLowerCase(),
      shares: required.shares, targetPrice: required.targetPrice, venueExpiresAt: required.venueExpiresAt,
      wallet: required.sellerWallet, rationale: required.rationale, sourcePosition,
    }),
    signal: AbortSignal.timeout(30_000),
  });
  const body = await response.json();
  const preview = body?.preview;
  const valid = response.ok && body?.ok === true && preview?.action === "TAKE_PROFIT" &&
    preview?.executable === false && preview?.order?.orderType === "GTD" && preview?.order?.postOnly === true &&
    String(preview?.source?.intentHash || "").toLowerCase() === sourcePosition.intentHash &&
    String(preview?.source?.positionProofHash || "").toLowerCase() === sourcePosition.positionProofHash &&
    BigInt(preview?.order?.sharesRaw ?? -1) === parseDecimal(required.shares, 6, "shares") &&
    parseDecimal(preview?.order?.targetPrice, 6, "preview target") === parseDecimal(required.targetPrice, 6, "target");
  return { valid, response };
}

function emittedEvent(text, type) {
  for (const line of String(text || "").split("\n")) {
    for (let index = line.indexOf("{"); index >= 0; index = line.indexOf("{", index + 1)) {
      try {
        const parsed = JSON.parse(line.slice(index));
        if (parsed?.type === type) return parsed;
      } catch {}
    }
  }
  return null;
}

process.stdout.write(`\nConviction Gate C — ${mode}\n\n`);
await adversarialProbe("5.1", "Substituted outcome token fails before placement", {
  mutateValidated: (value) => ({ ...value, tokenId: "987654321" }),
}, "token_substitution");
await adversarialProbe("5.2", "Crossed target substitution fails before placement", {
  mutateValidated: (value) => ({ ...value, bounds: { ...value.bounds, targetPrice: "0.39" } }),
}, "price_substitution");
await adversarialProbe("5.3", "Substituted source proof fails before placement", {
  mutateValidated: (value) => ({ ...value, intent: { ...value.intent, source: { ...value.intent.source, positionProofHash: `0x${"99".repeat(32)}` } } }),
}, "source_substitution");
await adversarialProbe("5.4", "Expired signed card fails before placement", {
  validationError: Object.assign(new Error("Take-profit card expired"), { code: "expired_card" }),
}, "expired_card");
await adversarialProbe("5.5", "Manager payment alone never authorizes a TAKE_PROFIT", {
  tradeConsent: false,
}, "trade_not_confirmed");
await adversarialProbe("5.6", "A late selected-token reservation blocks placement", {
  mutateFinalReadiness: { reservedSharesRaw: "1000000", openSellOrderCount: 1 },
}, "position_reserved");

const wrongPriceChallenge = {
  x402Version: 2,
  resource: { url: POSITION_MANAGER_SERVICE.resource },
  accepts: [{ scheme: "exact", network: SERVICE_NETWORK, amount: "50000", asset: SERVICE_ASSET, payTo: SERVICE_PAYEE }],
};
record("5.7", "An OPEN-priced x402 challenge cannot authorize TAKE_PROFIT", isPinnedManagerChallenge(wrongPriceChallenge) ? "FAIL" : "PASS", "0.05 rejected before payment");

const pendingNames = [
  ["1", "Fresh buyer-seat 0.10 x402 payment independently verified"],
  ["2", "Signed GTD bounds shown and exactly one placement confirmation"],
  ["3", "One post-only GTD SELL is ARMED for the pinned seller wallet"],
  ["4", "Authenticated ARMED proof and passport return in the same journey"],
  ["6", "Payment-to-ARMED-proof journey finishes under two minutes"],
];

if (mode === "offline") {
  record("0", "Bare manager endpoint returns the pinned 0.10 x402 challenge", "PENDING", "run --dry or --live");
  for (const [id, name] of pendingNames) record(id, name, "PENDING", "run --live");
}

if (mode === "dry" || mode === "live") await probeManagerChallenge();

if (mode === "dry") {
  const required = liveInputs();
  const missing = ["market", "side", "shares", "targetPrice", "venueExpiresAt", "sellerWallet", "sourceProof"].filter((name) => !required[name]);
  if (missing.length === 0) {
    try {
      const sourcePosition = loadSourcePosition(required.sourceProof);
      const preview = await probePreview(required, sourcePosition);
      record("D1", "Free TAKE_PROFIT preview reverifies and binds the source", preview.valid ? "PASS" : "FAIL", `HTTP ${preview.response.status}`);
    } catch (error) {
      record("D1", "Free TAKE_PROFIT preview reverifies and binds the source", "FAIL", error?.code || error?.message);
    }
  } else {
    record("D1", "Free TAKE_PROFIT preview reverifies and binds the source", "PENDING", `supply ${missing.join(", ")}`);
  }
  for (const [id, name] of pendingNames) record(id, name, "PENDING", "run --live");
}

if (mode === "live") {
  if (origin !== productionOrigin || has("orchestrator") || has("issuer-registry")) {
    process.stderr.write("Release-live Gate C pins the production origin, bundled orchestrator, and production issuer registry.\n");
    process.exit(2);
  }
  const required = liveInputs();
  const missing = Object.entries(required).filter(([name, value]) => name !== "rationale" && !value).map(([name]) => name);
  if (missing.length) {
    process.stderr.write(`Missing live arguments: ${missing.join(", ")}\n`);
    process.exit(2);
  }
  if (!ADDRESS_RE.test(required.paymentPayer) || !ADDRESS_RE.test(required.sellerWallet)) {
    process.stderr.write("Live payer and seller wallet must be EVM addresses.\n");
    process.exit(2);
  }
  if (required.paymentPayer === SERVICE_PAYEE) {
    process.stderr.write("Release-live Gate C requires a buyer-seat payer distinct from the service treasury.\n");
    process.exit(2);
  }
  const sourcePosition = loadSourcePosition(required.sourceProof);
  const trustedDocument = JSON.parse(readFileSync(productionRegistryPath, "utf8"));
  const trustedIssuers = trustedIssuerRegistry(trustedDocument.issuers || trustedDocument);
  const gateStartedAt = Date.now();
  const childArgs = [
    orchestratorPath, "take-profit", "--origin", origin,
    "--market", required.market, "--side", required.side,
    "--shares", required.shares, "--target-price", required.targetPrice,
    "--expires-at", required.venueExpiresAt,
    "--payment-payer", required.paymentPayer, "--seller-wallet", required.sellerWallet,
    "--source-proof", required.sourceProof, "--issuer-registry", productionRegistryPath,
    ...(required.rationale ? ["--rationale", required.rationale] : []), "--json",
  ];
  const journey = await new Promise((resolve) => {
    const child = spawn(process.execPath, childArgs, { stdio: ["inherit", "pipe", "pipe"] });
    let output = "";
    let errors = "";
    child.stdout.on("data", (chunk) => { output += chunk; process.stdout.write(chunk); });
    child.stderr.on("data", (chunk) => { errors += chunk; process.stderr.write(chunk); });
    child.on("close", (code) => {
      let report;
      try { report = JSON.parse(output.trim()); } catch {}
      resolve({ code, report, errors });
    });
  });

  if (journey.code !== 0 || journey.report?.ok !== true) {
    reconciliation = { journalPath: journey.report?.journalPath, reconciliationRequired: journey.report?.reconciliationRequired === true };
    const detail = journey.report?.code || `orchestrator exit ${journey.code}`;
    record("7", "Executed plugin is bound to the released runtime digest", "FAIL", "journey did not return spawn-bound runtime evidence");
    for (const [id, name] of pendingNames) record(id, name, "FAIL", detail);
  } else {
    const report = journey.report;
    const installedRuntime = polymarketRuntimeEvidence({ verified: true });
    const runtimeBound = JSON.stringify(report.executionRuntime || null) === JSON.stringify(installedRuntime);
    executionRuntime = report.executionRuntime || null;
    record("7", "Executed plugin is bound to the released runtime digest", runtimeBound ? "PASS" : "FAIL", report.executionRuntime?.binarySha256 || "missing");
    let payment;
    try {
      payment = await fetchAndVerifyX402Payment({
        paymentTx: report.paymentProof?.transactionHash,
        payer: required.paymentPayer, payee: SERVICE_PAYEE, asset: SERVICE_ASSET,
        amountAtomic: POSITION_MANAGER_SERVICE.priceAtomic,
        earliestAllowedTime: new Date(gateStartedAt).toISOString(),
      });
      record("1", "Fresh buyer-seat 0.10 x402 payment independently verified", "PASS", payment.proof.transactionHash);
    } catch (error) {
      record("1", "Fresh buyer-seat 0.10 x402 payment independently verified", "FAIL", error?.code || error?.message);
    }

    let card;
    let source;
    let journal;
    try {
      card = validateTakeProfitCard(report.card, { trustedIssuers, allowExpired: true });
      source = await verifySourcePosition(sourcePosition, { trustedIssuers });
      journal = JSON.parse(readFileSync(report.journalPath, "utf8"));
    } catch {}
    const events = Array.isArray(report.events) ? report.events : [];
    const eventTypes = events.map((event) => event.type);
    const expectedSequence = [
      "readiness_verified", "take_profit_previewed", "pre_payment_position_verified",
      "payment_challenge_presented", "payment_confirmed", "payment_verified",
      "signed_take_profit_card_verified", "take_profit_dry_run_verified", "bounds_presented",
      "trade_confirmed", "post_confirmation_second_reached", "pre_execution_verified",
      "execution_started", "take_profit_submitted", "authenticated_order_fetched", "take_profit_proof_verified",
    ];
    const displayed = emittedEvent(journey.errors, "trade_confirmation")?.bounds;
    const paidIndex = eventTypes.indexOf("payment_verified");
    const confirmIndex = eventTypes.indexOf("trade_confirmed");
    const submitIndex = eventTypes.indexOf("take_profit_submitted");
    const confirmedEvents = events.filter((event) => event.type === "trade_confirmed");
    const confirmedEvent = confirmedEvents[0];
    let consentOk = false;
    try {
      const consentBinding = evaluateTakeProfitConsentBinding({
        journal,
        reportCard: report.card,
        validatedCard: card,
        independentPaymentProof: payment?.proof,
        reportPaymentTx: report.paymentProof?.transactionHash,
        reportConfirmationCount: report.confirmation?.count,
        reportConfirmedAt: report.confirmation?.confirmedAt,
        confirmedEventCount: confirmedEvents.length,
        confirmedEventAt: confirmedEvent?.at,
        expectedPayer: required.paymentPayer,
        expectedPayee: SERVICE_PAYEE,
        expectedAsset: SERVICE_ASSET,
        expectedAmountAtomic: POSITION_MANAGER_SERVICE.priceAtomic,
      });
      consentOk = Boolean(card && source && displayed && report.confirmation?.count === 1 && report.ordersPlaced === 1 &&
        confirmedEvents.length === 1 && report.confirmation.confirmedAt === confirmedEvent?.at &&
        JSON.stringify(eventTypes) === JSON.stringify(expectedSequence) && paidIndex >= 0 && paidIndex < confirmIndex && confirmIndex < submitIndex &&
        consentBinding.ok &&
        card.wallet === required.sellerWallet && card.outcome === required.side &&
        BigInt(card.bounds.sharesRaw) === parseDecimal(required.shares, 6, "shares") &&
        parseDecimal(card.bounds.targetPrice, 6, "target") === parseDecimal(required.targetPrice, 6, "target") &&
        card.bounds.venueExpiresAt === new Date(Date.parse(required.venueExpiresAt)).toISOString() &&
        source.wallet === required.sellerWallet && source.outcome === required.side && source.outcomeTokenId === card.tokenId &&
        displayed.action === "TAKE_PROFIT" && displayed.orderType === "GTD" && displayed.postOnly === true &&
        displayed.partialFillAllowed === true && displayed.wallet === required.sellerWallet &&
        displayed.completedPayment?.amountAtomic === POSITION_MANAGER_SERVICE.priceAtomic &&
        displayed.completedPayment?.resource === POSITION_MANAGER_SERVICE.resource &&
        displayed.completedPayment?.payer === required.paymentPayer &&
        String(displayed.completedPayment?.transactionHash).toLowerCase() === String(report.paymentProof?.transactionHash).toLowerCase());
    } catch {}
    record("2", "Signed GTD bounds shown and exactly one placement confirmation", consentOk ? "PASS" : "FAIL", `confirmations:${report.confirmation?.count}`);

    let armed;
    let snapshot;
    let timing;
    try {
      armed = validateArmedTakeProfitJournal(journal, { trustedIssuers });
      snapshot = await fetchExactOrder({
        signerAddress: armed.signerAddress, depositWallet: armed.depositWallet,
        orderId: armed.orderId, outcomeTokenId: armed.outcomeTokenId,
      });
      const order = snapshot.order;
      timing = evaluateTakeProfitAcceptanceTiming({
        paymentBlockTimestamp: payment?.proof?.blockTimestamp,
        orderCreatedAt: order.createdAt,
        orderFetchedAt: snapshot.fetchedAt,
        reportConfirmedAt: report.confirmation?.confirmedAt,
        journalConfirmedAt: journal.tradeConsent?.confirmedAt,
        cardCapturedAt: card?.intent?.snapshot?.capturedAt,
        cardExpiresAt: card?.expiresAt,
        localPaidAt: report.timings?.paidAt,
        localProvedAt: report.timings?.provedAt,
        recordedLocalPaymentToProofMs: report.timings?.paymentToProofMs,
      });
      const orderOk = order.status === "LIVE" && order.id === armed.orderId && order.market === armed.marketConditionId &&
        order.assetId === armed.outcomeTokenId && order.side === "SELL" && order.orderType === "GTD" &&
        parsePolymarketShareAtoms(order.originalSize, "original size") === armed.exactSharesRaw &&
        parsePolymarketShareAtoms(order.sizeMatched, "matched size") === 0n &&
        parseDecimal(order.price, 6, "order price") === armed.targetPriceRaw &&
        timing.confirmationBound && timing.orderAfterConfirmation && timing.insideCardWindow &&
        timing.orderAfterPayment && timing.fetchAfterOrder;
      record("3", "One post-only GTD SELL is ARMED for the pinned seller wallet", orderOk ? "PASS" : "FAIL", armed.orderId);
      const proofOk = report.status === "ARMED" && report.orderId === armed.orderId &&
        report.restingOrderProof?.verificationSource === "authenticated-polymarket-clob" && report.restingOrderProof?.onChain === false &&
        report.restingOrderProofHash === armed.proofHash && report.takeProfitPassportHash === armed.passportHash;
      record("4", "Authenticated ARMED proof and passport return in the same journey", proofOk ? "PASS" : "FAIL", armed.passportHash);
    } catch (error) {
      record("3", "One post-only GTD SELL is ARMED for the pinned seller wallet", "FAIL", error?.code || error?.message);
      record("4", "Authenticated ARMED proof and passport return in the same journey", "FAIL", "independent validation failed");
    }

    const chainMs = timing?.chainPaymentToArmedMs;
    const localMs = timing?.localPaymentToProofMs;
    const fast = timing?.ok === true;
    const timingDetail = Number.isFinite(chainMs) && Number.isFinite(localMs)
      ? `${(localMs / 1_000).toFixed(1)}s local / ${(chainMs / 1_000).toFixed(1)}s independent`
      : "independent timing unavailable";
    record("6", "Payment-to-ARMED-proof journey finishes under two minutes", fast ? "PASS" : "FAIL", timingDetail);
  }
}

const failed = results.filter((result) => result.status === "FAIL");
const pending = results.filter((result) => result.status === "PENDING");
const verdict = mode === "live"
  ? failed.length === 0 && pending.length === 0 ? "GATE C: PASS" : "GATE C: FAIL"
  : failed.length === 0 ? `NO FAILURES (${pending.length} pending; Gate C undecided)` : "FAILURES PRESENT";
process.stdout.write(`\n${verdict}\n`);
writeFileSync(reportPath, `${JSON.stringify({ mode, origin, at: new Date().toISOString(), verdict, source, executionRuntime, results, ...(reconciliation ? { reconciliation } : {}) }, null, 2)}\n`, { flag: mode === "live" ? "wx" : "w" });
process.stdout.write(`Evidence report: ${reportPath}${mode === "live" ? " (write-once)" : ""}\n`);
process.exitCode = failed.length || (mode === "live" && pending.length) ? 1 : 0;
