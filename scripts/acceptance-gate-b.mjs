#!/usr/bin/env node

// Gate B is the executable release definition for Conviction's bounded CLOSE
// path. Offline mode exercises fail-closed orchestration without network calls.
// Dry mode adds read-only production probes. Live mode launches the public CLI
// with inherited stdin, so the user—not this gate—must separately confirm the
// x402 payment and the one live FOK SELL. It then independently verifies both
// the X Layer payment and the exact Polygon settlement.

import { spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import {
  evaluateFilledOrderAcceptanceTiming,
  strictlyPostdatesConfirmationSecond,
} from "../src/acceptance-timing.mjs";
import { runCloseJourney } from "../src/buyer-orchestrator.mjs";
import { parseDecimal } from "../src/decimal.mjs";
import { fetchAndVerifyClose } from "../src/exit-receipt-verifier.mjs";
import { trustedIssuerRegistry } from "../src/intent-issuer.mjs";
import { verifySourcePosition } from "../src/source-position.mjs";
import {
  POSITION_MANAGER_SERVICE,
  SERVICE_ASSET,
  SERVICE_NETWORK,
  SERVICE_PAYEE,
} from "../src/service-payment.mjs";
import { fetchAndVerifyX402Payment } from "../src/x402-payment-verifier.mjs";
import {
  validateCloseCard,
  validateCloseProof,
} from "../skills/conviction-executor/scripts/conviction-exit-card.mjs";

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
const origin = String(take("origin", new URL(POSITION_MANAGER_SERVICE.resource).origin)).replace(/\/$/, "");
const reportPath = take("report", path.join(HERE, "..", "acceptance-report-b.json"));
const orchestratorPath = path.join(HERE, "buyer-orchestrator.mjs");
const productionRegistryPath = path.join(HERE, "..", "config", "trusted-issuer.production.json");
const productionOrigin = new URL(POSITION_MANAGER_SERVICE.resource).origin;
const results = [];
let reconciliation = null;

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
  const intent = firstObject(
    direct?.intent,
    root.canonicalIntent,
    root.intent,
    root.paidCard?.intent,
    root.positionPassport?.intent,
  );
  const positionProof = firstObject(
    root.positionProof,
    root.positionPassport?.positionProof,
    root.verifiedPositionProof,
  );
  const receiptProof = firstObject(root.receiptProof, root.positionPassport?.receiptProof);
  const hashes = firstObject(root.hashes) || {};
  if (!intent) {
    throw Object.assign(new Error("Source proof file has no canonical sourcePosition envelope"), {
      code: "invalid_source_proof_file",
    });
  }
  const firstValue = (...values) => values.find((value) => value !== undefined && value !== null && value !== "");
  const source = {
    transactionHash: firstValue(
      direct?.transactionHash,
      positionProof?.transactionHash,
      receiptProof?.transactionHash,
      root.transactionHash,
      root.settlementTx,
    ),
    orderId: firstValue(
      direct?.orderId,
      positionProof?.orderId,
      receiptProof?.orderId,
      root.orderId,
    ),
    intentHash: firstValue(
      direct?.intentHash,
      positionProof?.intentHash,
      hashes.intentHash,
      root.intentHash,
    ),
    positionProofHash: firstValue(
      direct?.positionProofHash,
      root.positionProofHash,
      hashes.positionProofHash,
      root.verifiedPositionProof?.positionProofHash,
    ),
    intent,
    issuance: firstObject(direct?.issuance, root.issuance, root.paidCard?.issuance, root.positionPassport?.issuance),
  };
  for (const field of ["transactionHash", "orderId", "intentHash", "positionProofHash"]) {
    if (!HASH_RE.test(String(source[field] || ""))) {
      throw Object.assign(new Error(`Source proof file has no valid ${field}`), {
        code: "invalid_source_proof_file",
      });
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

function isPinnedManageChallenge(challenge) {
  const accepts = challenge?.accepts;
  const requirement = Array.isArray(accepts) && accepts.length === 1 ? accepts[0] : null;
  return challenge?.x402Version === 2 &&
    challenge?.resource?.url === POSITION_MANAGER_SERVICE.resource &&
    requirement?.scheme === "exact" &&
    requirement?.network === SERVICE_NETWORK &&
    requirement?.amount === POSITION_MANAGER_SERVICE.priceAtomic &&
    String(requirement?.asset || "").toLowerCase() === SERVICE_ASSET &&
    String(requirement?.payTo || "").toLowerCase() === SERVICE_PAYEE;
}

function adversarialFixture({ mutateValidated, validationError, tradeConsent = true } = {}) {
  let executes = 0;
  const conditionId = `0x${"ab".repeat(32)}`;
  const tokenId = "123456789";
  const payer = "0x1111111111111111111111111111111111111111";
  const wallet = "0x2222222222222222222222222222222222222222";
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
  const validated = {
    wallet,
    outcome: "YES",
    tokenId,
    intentHash: `0x${"cd".repeat(32)}`,
    expiresAt: "2030-01-01T00:00:00.000Z",
    intent: { market: { conditionId, question: "Fixture market?" }, source },
    issuanceVerification: {
      keyId: "fixture-key",
      fingerprint: `sha256:${"11".repeat(32)}`,
      issuedAt: "2029-12-31T23:55:00.000Z",
    },
    executionCard: { argv: ["sell", "--order-type", "FOK"] },
    bounds: {
      sharesRaw: "5000000",
      minPrice: "0.26",
      minimumGrossProceedsRaw: "1300000",
      maximumFeeRaw: "0",
      minimumNetProceedsRaw: "1300000",
    },
  };
  const readiness = {
    accessible: true,
    clobVersion: "V2",
    currentMode: "deposit_wallet",
    paymentPayer: payer,
    buyerWallet: wallet,
    tradingAddress: wallet,
    outcomeTokenId: tokenId,
    outcomeBalanceRaw: "5000000",
    approvedForExchange: true,
    reservedSharesRaw: "0",
    openSellOrderCount: 0,
  };
  const adapters = {
    ensureTradingMode: async () => ({ currentMode: "deposit_wallet" }),
    checkReadiness: async () => readiness,
    previewClose: async () => ({
      ok: true,
      preview: {
        action: "CLOSE",
        executable: false,
        market: { conditionId, outcomeTokenId: tokenId },
        order: { sharesRaw: "5000000", minPrice: "0.26" },
        source,
      },
    }),
    checkCloseReadiness: async () => readiness,
    requestPaymentChallenge: async () => ({ amount: POSITION_MANAGER_SERVICE.priceAtomic }),
    payAndRequestCard: async () => ({ card: {}, paymentTx: `0x${"ef".repeat(32)}` }),
    verifyPayment: async () => ({ transactionHash: `0x${"ef".repeat(32)}` }),
    validateCloseCard: async () => {
      if (validationError) throw validationError;
      return mutateValidated ? mutateValidated(structuredClone(validated)) : structuredClone(validated);
    },
    dryRun: async () => ({ ok: true, dry_run: true }),
    validateCloseDryRun: async () => ({ ok: true }),
    execute: async () => { executes += 1; return { ok: true }; },
    buildCloseReceiptRequest: async () => ({}),
    fetchCloseProof: async () => ({}),
    validateCloseProof: async () => ({
      transactionHash: `0x${"41".repeat(32)}`,
      orderId: `0x${"42".repeat(32)}`,
      closeProofHash: `0x${"43".repeat(32)}`,
      closePassportHash: `0x${"44".repeat(32)}`,
      settledAt: "2030-01-01T00:00:00.000Z",
    }),
  };
  return {
    input: {
      request: { market: "example", outcome: "YES", shares: "5", minPrice: "0.26", sourcePosition },
      paymentPayer: payer,
      sellerWallet: wallet,
      trustedIssuers: [],
      adapters,
      confirm: async (kind) => kind === "payment" || tradeConsent,
    },
    executes: () => executes,
  };
}

async function adversarialProbe(id, name, options, expectedCode) {
  const fixture = adversarialFixture(options);
  let code;
  try { await runCloseJourney(fixture.input); } catch (error) { code = error?.code; }
  const passed = code === expectedCode && fixture.executes() === 0;
  record(id, name, passed ? "PASS" : "FAIL", `code:${code || "none"} orders:${fixture.executes()}`);
}

async function probeManageChallenge() {
  try {
    const response = await fetch(`${origin}${POSITION_MANAGER_SERVICE.path}`, {
      signal: AbortSignal.timeout(20_000),
    });
    const challenge = decodeChallenge(response.headers.get("payment-required"));
    const valid = response.status === 402 && isPinnedManageChallenge(challenge);
    record("0", "Bare manager endpoint returns the pinned 0.10 x402 challenge", valid ? "PASS" : "FAIL", `HTTP ${response.status}`);
  } catch (error) {
    record("0", "Bare manager endpoint returns the pinned 0.10 x402 challenge", "FAIL", error?.message || "probe failed");
  }
}

function liveInputs() {
  return {
    market: take("market"),
    side: take("side")?.toUpperCase(),
    shares: take("shares"),
    minPrice: take("min-price"),
    paymentPayer: take("payment-payer")?.toLowerCase(),
    sellerWallet: take("seller-wallet")?.toLowerCase(),
    sourceProof: take("source-proof"),
    rationale: take("rationale", ""),
  };
}

async function probeManagePreview(required, sourcePosition) {
  const response = await fetch(`${origin}/api/manage-preview`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      action: "close",
      market: required.market,
      outcome: required.side.toLowerCase(),
      shares: required.shares,
      minPrice: required.minPrice,
      wallet: required.sellerWallet,
      rationale: required.rationale,
      sourcePosition,
    }),
    signal: AbortSignal.timeout(30_000),
  });
  const body = await response.json();
  const preview = body?.preview;
  const valid = response.ok && body?.ok === true && preview?.action === "CLOSE" &&
    preview?.executable === false &&
    String(preview?.source?.intentHash || "").toLowerCase() === sourcePosition.intentHash &&
    String(preview?.source?.positionProofHash || "").toLowerCase() === sourcePosition.positionProofHash &&
    BigInt(preview?.order?.sharesRaw ?? -1) === parseDecimal(required.shares, 6, "shares") &&
    parseDecimal(preview?.order?.minPrice, 6, "preview minPrice") === parseDecimal(required.minPrice, 6, "minPrice");
  return { valid, response, body };
}

function sanitizedCheckpoint(report) {
  const checkpoint = report?.checkpoint;
  if (!checkpoint || typeof checkpoint !== "object") return undefined;
  return {
    stage: checkpoint.stage,
    journalPath: checkpoint.journalPath,
    paymentTx: checkpoint.paymentTx,
    orderId: checkpoint.orderId,
    settlementTx: checkpoint.settlementTx,
    reconciliationRequired: checkpoint.reconciliationRequired === true,
  };
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

process.stdout.write(`\nConviction Gate B — ${mode}\n\n`);
await adversarialProbe("5.1", "Substituted outcome token fails before execution", {
  mutateValidated: (value) => ({ ...value, tokenId: "987654321" }),
}, "token_substitution");
await adversarialProbe("5.2", "Rewritten exact shares fail before execution", {
  mutateValidated: (value) => ({ ...value, bounds: { ...value.bounds, sharesRaw: "4000000" } }),
}, "shares_substitution");
await adversarialProbe("5.3", "Crossed minimum price fails before execution", {
  mutateValidated: (value) => ({ ...value, bounds: { ...value.bounds, minPrice: "0.25" } }),
}, "price_substitution");
await adversarialProbe("5.4", "Substituted source proof fails before execution", {
  mutateValidated: (value) => ({
    ...value,
    intent: { ...value.intent, source: { ...value.intent.source, positionProofHash: `0x${"99".repeat(32)}` } },
  }),
}, "source_substitution");
await adversarialProbe("5.5", "Expired signed card fails before execution", {
  validationError: Object.assign(new Error("Close card expired"), { code: "expired_card" }),
}, "expired_card");
await adversarialProbe("5.6", "Manager payment alone never authorizes a CLOSE", {
  tradeConsent: false,
}, "trade_not_confirmed");

const wrongPriceChallenge = {
  x402Version: 2,
  resource: { url: POSITION_MANAGER_SERVICE.resource },
  accepts: [{
    scheme: "exact",
    network: SERVICE_NETWORK,
    amount: "50000",
    asset: SERVICE_ASSET,
    payTo: SERVICE_PAYEE,
  }],
};
record(
  "5.7",
  "An OPEN-priced x402 challenge cannot authorize CLOSE",
  isPinnedManageChallenge(wrongPriceChallenge) ? "FAIL" : "PASS",
  "0.05 rejected before payment",
);

if (take("source-proof")) {
  try {
    const normalizedSource = loadSourcePosition(take("source-proof"));
    record(
      "S1",
      "Native or public retrospective OPEN artifact normalizes without mutation",
      "PASS",
      `${normalizedSource.intent.version || "unknown version"} / ${normalizedSource.positionProofHash}`,
    );
  } catch (error) {
    record(
      "S1",
      "Native or public retrospective OPEN artifact normalizes without mutation",
      "FAIL",
      error?.code || error?.message,
    );
  }
}

const pendingNames = [
  ["1", "Fresh buyer-seat 0.10 x402 payment independently verified"],
  ["2", "Signed CLOSE bounds shown and exactly one trade confirmation"],
  ["3", "Exact FOK SELL settles from the pinned seller wallet"],
  ["4", "Independent close proof and passport return in the same journey"],
  ["6", "Payment-to-proof CLOSE journey finishes under two minutes"],
];

if (mode === "offline") {
  record("0", "Bare manager endpoint returns the pinned 0.10 x402 challenge", "PENDING", "run --dry or --live");
  for (const [id, name] of pendingNames) record(id, name, "PENDING", "run --live");
}

if (mode === "dry" || mode === "live") await probeManageChallenge();

if (mode === "dry") {
  const required = liveInputs();
  const dryRequired = ["market", "side", "shares", "minPrice", "sellerWallet", "sourceProof"];
  const missing = dryRequired.filter((name) => !required[name]);
  if (missing.length === 0) {
    try {
      const sourcePosition = loadSourcePosition(required.sourceProof);
      const preview = await probeManagePreview(required, sourcePosition);
      record("D1", "Free manager preview reverifies and binds the source position", preview.valid ? "PASS" : "FAIL", `HTTP ${preview.response.status}`);
    } catch (error) {
      record("D1", "Free manager preview reverifies and binds the source position", "FAIL", error?.code || error?.message);
    }
  } else {
    record("D1", "Free manager preview reverifies and binds the source position", "PENDING", `supply ${missing.join(", ")}`);
  }
  for (const [id, name] of pendingNames) record(id, name, "PENDING", "run --live");
}

if (mode === "live") {
  if (origin !== productionOrigin || has("orchestrator") || has("issuer-registry")) {
    process.stderr.write("Release-live Gate B pins the production origin, bundled orchestrator, and production issuer registry.\n");
    process.exit(2);
  }
  const required = liveInputs();
  const missing = Object.entries(required)
    .filter(([name, value]) => name !== "rationale" && !value)
    .map(([name]) => name);
  if (missing.length) {
    process.stderr.write(`Missing live arguments: ${missing.join(", ")}\n`);
    process.exit(2);
  }
  if (!ADDRESS_RE.test(required.paymentPayer) || !ADDRESS_RE.test(required.sellerWallet)) {
    process.stderr.write("Live payer and seller wallet must be EVM addresses.\n");
    process.exit(2);
  }
  if (required.paymentPayer === SERVICE_PAYEE) {
    process.stderr.write("Release-live Gate B requires a buyer-seat payer distinct from the service treasury.\n");
    process.exit(2);
  }
  const sourcePosition = loadSourcePosition(required.sourceProof);
  const trustedIssuerDocument = JSON.parse(readFileSync(productionRegistryPath, "utf8"));
  const trustedIssuers = trustedIssuerRegistry(trustedIssuerDocument.issuers || trustedIssuerDocument);
  const gateStartedAt = Date.now();
  const childArgs = [
    orchestratorPath, "close", "--origin", origin,
    "--market", required.market, "--side", required.side,
    "--shares", required.shares, "--min-price", required.minPrice,
    "--payment-payer", required.paymentPayer, "--seller-wallet", required.sellerWallet,
    "--source-proof", required.sourceProof,
    "--issuer-registry", productionRegistryPath,
    ...(required.rationale ? ["--rationale", required.rationale] : []),
    "--json",
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
    reconciliation = sanitizedCheckpoint(journey.report);
    const detail = journey.report?.code || `orchestrator exit ${journey.code}`;
    for (const [id, name] of pendingNames) record(id, name, "FAIL", detail);
  } else {
    const report = journey.report;
    let payment;
    try {
      payment = await fetchAndVerifyX402Payment({
        paymentTx: report.paymentProof?.transactionHash,
        payer: required.paymentPayer,
        payee: SERVICE_PAYEE,
        asset: SERVICE_ASSET,
        amountAtomic: POSITION_MANAGER_SERVICE.priceAtomic,
        earliestAllowedTime: new Date(gateStartedAt).toISOString(),
      });
      record("1", "Fresh buyer-seat 0.10 x402 payment independently verified", "PASS", payment.proof.transactionHash);
    } catch (error) {
      record("1", "Fresh buyer-seat 0.10 x402 payment independently verified", "FAIL", error?.code || error?.message);
    }

    let validatedCard;
    let cardBindingOk = false;
    try {
      validatedCard = validateCloseCard(report.card, { trustedIssuers, allowExpired: true });
      const verifiedSource = await verifySourcePosition(sourcePosition, { trustedIssuers });
      cardBindingOk = validatedCard.wallet === required.sellerWallet &&
        validatedCard.outcome === required.side &&
        BigInt(validatedCard.bounds.sharesRaw) === parseDecimal(required.shares, 6, "shares") &&
        parseDecimal(validatedCard.bounds.minPrice, 6, "card minPrice") === parseDecimal(required.minPrice, 6, "minPrice") &&
        String(validatedCard.intent.market.conditionId).toLowerCase() === verifiedSource.marketConditionId &&
        String(validatedCard.tokenId) === verifiedSource.outcomeTokenId &&
        verifiedSource.wallet === required.sellerWallet &&
        verifiedSource.outcome === required.side &&
        BigInt(verifiedSource.actualSharesRaw) >= parseDecimal(required.shares, 6, "shares") &&
        String(validatedCard.intent.source.intentHash).toLowerCase() === sourcePosition.intentHash &&
        String(validatedCard.intent.source.positionProofHash).toLowerCase() === sourcePosition.positionProofHash &&
        String(validatedCard.intent.source.transactionHash).toLowerCase() === sourcePosition.transactionHash &&
        String(validatedCard.intent.source.orderId).toLowerCase() === sourcePosition.orderId;
    } catch {}

    const eventTypes = Array.isArray(report.events) ? report.events.map((event) => event.type) : [];
    const expectedSequence = [
      "readiness_verified", "close_previewed", "pre_payment_position_verified",
      "payment_challenge_presented", "payment_confirmed", "payment_verified",
      "signed_close_card_verified", "close_dry_run_verified", "bounds_presented",
      "trade_confirmed", "pre_execution_verified", "execution_started",
      "close_submitted", "close_proof_verified",
    ];
    const paidIndex = eventTypes.indexOf("payment_verified");
    const confirmIndex = eventTypes.indexOf("trade_confirmed");
    const submitIndex = eventTypes.indexOf("close_submitted");
    const confirmedEvent = report.events?.find((event) => event.type === "trade_confirmed");
    const displayed = emittedEvent(journey.errors, "trade_confirmation")?.bounds;
    const displayedPayment = displayed?.completedPayment;
    let displayOk = false;
    try {
      displayOk = Boolean(validatedCard && displayed &&
        displayed.marketQuestion === validatedCard.intent.market.question &&
        String(displayed.conditionId).toLowerCase() === String(validatedCard.intent.market.conditionId).toLowerCase() &&
        displayed.outcome === required.side &&
        String(displayed.outcomeTokenId) === validatedCard.tokenId &&
        parseDecimal(displayed.exactShares, 6, "displayed shares") === parseDecimal(required.shares, 6, "shares") &&
        parseDecimal(displayed.minPrice, 6, "displayed minPrice") === parseDecimal(required.minPrice, 6, "minPrice") &&
        String(displayed.minimumGrossProceedsRaw) === String(validatedCard.bounds.minimumGrossProceedsRaw) &&
        String(displayed.maximumFeeRaw) === String(validatedCard.bounds.maximumFeeRaw) &&
        String(displayed.minimumNetProceedsRaw) === String(validatedCard.bounds.minimumNetProceedsRaw) &&
        displayed.feeAndNetEnforcement === "post-settlement-verification-only" &&
        String(displayed.wallet).toLowerCase() === required.sellerWallet &&
        String(displayed.sourceIntentHash).toLowerCase() === sourcePosition.intentHash &&
        String(displayed.sourcePositionProofHash).toLowerCase() === sourcePosition.positionProofHash &&
        displayed.issuerKeyId === validatedCard.issuanceVerification.keyId &&
        displayed.issuerFingerprint === validatedCard.issuanceVerification.fingerprint &&
        displayed.issuedAt === validatedCard.issuanceVerification.issuedAt &&
        displayed.expiresAt === validatedCard.expiresAt &&
        String(displayedPayment?.transactionHash).toLowerCase() === String(report.paymentProof?.transactionHash).toLowerCase() &&
        displayedPayment?.amountAtomic === POSITION_MANAGER_SERVICE.priceAtomic &&
        displayedPayment?.resource === POSITION_MANAGER_SERVICE.resource &&
        displayedPayment?.network === SERVICE_NETWORK &&
        String(displayedPayment?.asset).toLowerCase() === SERVICE_ASSET &&
        String(displayedPayment?.payer).toLowerCase() === required.paymentPayer &&
        String(displayedPayment?.payee).toLowerCase() === SERVICE_PAYEE);
    } catch {}
    const consentOk = cardBindingOk && displayOk && report.mode === "close" && report.ordersPlaced === 1 &&
      report.confirmation?.count === 1 &&
      JSON.stringify(eventTypes) === JSON.stringify(expectedSequence) &&
      report.confirmation.confirmedAt === confirmedEvent?.at &&
      paidIndex >= 0 && paidIndex < confirmIndex && confirmIndex < submitIndex;
    record("2", "Signed CLOSE bounds shown and exactly one trade confirmation", consentOk ? "PASS" : "FAIL", `confirmations:${report.confirmation?.count}`);

    let close;
    let independentlyValidated;
    let proofObservedAt;
    try {
      const expectedReceiptRequest = {
        transactionHash: report.settlementTx,
        orderId: report.orderId,
        intentHash: report.card.intentHash,
        intent: report.card.intent,
        issuance: report.card.issuance,
      };
      close = await fetchAndVerifyClose(report.settlementTx, {
        intent: report.card.intent,
        intentHash: report.card.intentHash,
        orderId: report.orderId,
        issuance: report.card.issuance,
        trustedIssuers,
      });
      independentlyValidated = validateCloseProof(report.card, close, {
        trustedIssuers,
        expectedReceiptRequest,
      });
      proofObservedAt = Date.now();
      const settlementOk = close.ok === true &&
        close.closeProof.wallet === required.sellerWallet &&
        BigInt(close.closeProof.fill.actualSharesRaw) === parseDecimal(required.shares, 6, "shares") &&
        close.closeProof.outcome === required.side &&
        close.closeProof.transactionHash === report.settlementTx.toLowerCase() &&
        close.closeProof.orderId === report.orderId.toLowerCase() &&
        strictlyPostdatesConfirmationSecond(
          close.closeProof.settledAt,
          report.confirmation?.confirmedAt,
        );
      record("3", "Exact FOK SELL settles from the pinned seller wallet", settlementOk ? "PASS" : "FAIL", report.settlementTx);
      const proofOk = independentlyValidated.closeProofHash === report.closeProofHash &&
        independentlyValidated.closePassportHash === report.closePassportHash &&
        close.closePassport?.version === "conviction-close-passport-v1" &&
        close.closePassport?.status === "CLOSED";
      record("4", "Independent close proof and passport return in the same journey", proofOk ? "PASS" : "FAIL", independentlyValidated.closeProofHash);
    } catch (error) {
      record("3", "Exact FOK SELL settles from the pinned seller wallet", "FAIL", error?.code || error?.message);
      record("4", "Independent close proof and passport return in the same journey", "FAIL", "independent verification failed");
    }

    const paidEvent = report.events?.find((event) => event.type === "payment_verified");
    const provedEvent = report.events?.find((event) => event.type === "close_proof_verified");
    const timing = evaluateFilledOrderAcceptanceTiming({
      paymentBlockTimestamp: payment?.proof?.blockTimestamp,
      settledAt: close?.closeProof?.settledAt,
      proofObservedAt,
      localPaidAt: paidEvent?.at,
      localProvedAt: provedEvent?.at,
      recordedLocalPaymentToProofMs: report.timings?.paymentToProofMs,
    });
    const timingDetail = Number.isFinite(timing.localPaymentToProofMs) && Number.isFinite(timing.chainPaymentToProofMs)
      ? `${(timing.localPaymentToProofMs / 1_000).toFixed(1)}s local / ${(timing.chainPaymentToProofMs / 1_000).toFixed(1)}s independently observed`
      : "independent timing unavailable";
    record("6", "Payment-to-proof CLOSE journey finishes under two minutes", timing.ok ? "PASS" : "FAIL", timingDetail);
  }
}

const failed = results.filter((result) => result.status === "FAIL");
const pending = results.filter((result) => result.status === "PENDING");
const verdict = mode === "live"
  ? failed.length === 0 && pending.length === 0 ? "GATE B: PASS" : "GATE B: FAIL"
  : failed.length === 0 ? `NO FAILURES (${pending.length} pending; Gate B undecided)` : "FAILURES PRESENT";
process.stdout.write(`\n${verdict}\n`);
writeFileSync(reportPath, `${JSON.stringify({
  mode,
  origin,
  at: new Date().toISOString(),
  verdict,
  results,
  ...(reconciliation ? { reconciliation } : {}),
}, null, 2)}\n`);
process.exitCode = failed.length || (mode === "live" && pending.length) ? 1 : 0;
