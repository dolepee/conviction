#!/usr/bin/env node

// Gate A is the executable definition of Conviction's repeat-trade OPEN path.
// It never grants trade consent automatically and never places an adversarial
// live order. Live mode requires one fresh x402 payment and one fresh Polygon
// fill, then independently verifies both chains from this process.

import { spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { runOpenJourney } from "../src/buyer-orchestrator.mjs";
import { parseDecimal } from "../src/decimal.mjs";
import { trustedIssuerRegistry } from "../src/intent-issuer.mjs";
import { fetchAndVerifyPosition } from "../src/receipt-verifier.mjs";
import {
  SERVICE_ASSET,
  SERVICE_NETWORK,
  SERVICE_PAYEE,
  SERVICE_PRICE_ATOMIC,
  SERVICE_RESOURCE,
} from "../src/service-payment.mjs";
import { fetchAndVerifyX402Payment } from "../src/x402-payment-verifier.mjs";
import { validateCard } from "../skills/conviction-executor/scripts/conviction-card.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const has = (name) => argv.includes(`--${name}`);
const take = (name, fallback = undefined) => {
  const index = argv.indexOf(`--${name}`);
  return index >= 0 && argv[index + 1] && !argv[index + 1].startsWith("--")
    ? argv[index + 1]
    : fallback;
};
const mode = has("live") ? "live" : has("dry") ? "dry" : "offline";
const origin = String(take("origin", "https://conviction-bay.vercel.app")).replace(/\/$/, "");
const reportPath = take("report", path.join(HERE, "..", "acceptance-report.json"));
const orchestratorPath = path.join(HERE, "buyer-orchestrator.mjs");
const productionRegistryPath = path.join(HERE, "..", "config", "trusted-issuer.production.json");
const productionOrigin = new URL(SERVICE_RESOURCE).origin;
const results = [];
let reconciliation = null;

function record(id, name, status, detail = "") {
  results.push({ id, name, status, detail });
  process.stdout.write(`${status.padEnd(7)} ${id.padEnd(5)} ${name}${detail ? ` — ${detail}` : ""}\n`);
}

function adversarialFixture(mutation) {
  let executes = 0;
  const conditionId = `0x${"ab".repeat(32)}`;
  const tokenId = "123456789";
  const payer = "0x1111111111111111111111111111111111111111";
  const wallet = "0x2222222222222222222222222222222222222222";
  const base = {
    wallet,
    outcome: "YES",
    tokenId,
    intentHash: `0x${"cd".repeat(32)}`,
    expiresAt: "2030-01-01T00:00:00.000Z",
    intent: { market: { conditionId } },
    executionCard: { argv: ["buy"] },
    bounds: {
      requestedBudgetRaw: "1350000",
      maximumOrderPrincipalRaw: "1350000",
      maximumFeeRaw: "0",
      maximumTotalDebitRaw: "1350000",
      maxPrice: "0.27",
    },
  };
  const adapters = {
    ensureTradingMode: async () => ({ currentMode: "deposit_wallet" }),
    checkReadiness: async () => ({ accessible: true, clobVersion: "V2", currentMode: "deposit_wallet", paymentPayer: payer, buyerWallet: wallet, tradingAddress: wallet, pUsdBalanceRaw: "9999999" }),
    previewMarket: async () => ({ conditionId, outcomeTokenId: tokenId }),
    requestPaymentChallenge: async () => ({ amount: SERVICE_PRICE_ATOMIC }),
    payAndRequestCard: async () => ({ card: {}, paymentTx: `0x${"ef".repeat(32)}` }),
    verifyPayment: async () => ({ transactionHash: `0x${"ef".repeat(32)}` }),
    validateCard: async () => mutation(structuredClone(base)),
    dryRun: async () => ({ ok: true }),
    validateDryRun: async () => ({ ok: true }),
    execute: async () => { executes += 1; return { ok: true }; },
    buildReceiptRequest: async () => ({}),
    fetchProof: async () => ({}),
    validateProof: async () => ({ orderId: `0x${"12".repeat(32)}`, transactionHash: `0x${"34".repeat(32)}`, positionProofHash: `0x${"56".repeat(32)}` }),
  };
  return { adapters, payer, wallet, executes: () => executes };
}

async function adversarialProbe(id, name, mutation, expectedCode) {
  const fixture = adversarialFixture(mutation);
  let code;
  try {
    await runOpenJourney({
      request: { market: "example", side: "YES", budget: "1.35", maxPrice: "0.27" },
      paymentPayer: fixture.payer,
      buyerWallet: fixture.wallet,
      adapters: fixture.adapters,
      trustedIssuers: [],
      confirm: async () => true,
    });
  } catch (error) {
    code = error?.code;
  }
  const passed = code === expectedCode && fixture.executes() === 0;
  record(id, name, passed ? "PASS" : "FAIL", `code:${code || "none"} orders:${fixture.executes()}`);
}

process.stdout.write(`\nConviction Gate A — ${mode}\n\n`);
await adversarialProbe("5.1", "Substituted outcome token fails before execution", (value) => ({ ...value, tokenId: "987654321" }), "token_substitution");
await adversarialProbe("5.2", "Crossed price cap fails before execution", (value) => ({ ...value, bounds: { ...value.bounds, maxPrice: "0.28" } }), "price_substitution");
await adversarialProbe("5.3", "Substituted buyer wallet fails before execution", (value) => ({ ...value, wallet: "0x3333333333333333333333333333333333333333" }), "wallet_substitution");

if (mode === "offline") {
  for (const [id, name] of [
    ["1", "Fresh buyer-seat x402 payment independently verified"],
    ["2", "Signed bounds shown and exactly one trade confirmation"],
    ["3", "Fresh Polygon fill lands in the pinned buyer wallet"],
    ["4", "Verified position proof returns in the same journey"],
    ["6", "Payment-to-proof journey finishes under two minutes"],
  ]) record(id, name, "PENDING", "run --live");
} else {
  try {
    const response = await fetch(`${origin}/api/service`, { signal: AbortSignal.timeout(20_000) });
    const encoded = response.headers.get("payment-required");
    const challenge = encoded ? JSON.parse(Buffer.from(encoded, "base64").toString("utf8")) : null;
    const requirement = challenge?.accepts?.[0];
    const valid = response.status === 402 && challenge?.x402Version === 2 &&
      challenge?.resource?.url === SERVICE_RESOURCE && requirement?.scheme === "exact" &&
      requirement?.network === SERVICE_NETWORK && requirement?.amount === SERVICE_PRICE_ATOMIC &&
      requirement?.asset?.toLowerCase() === SERVICE_ASSET && requirement?.payTo?.toLowerCase() === SERVICE_PAYEE;
    record("0", "Bare endpoint returns the pinned x402 challenge", valid ? "PASS" : "FAIL", `HTTP ${response.status}`);
  } catch (error) {
    record("0", "Bare endpoint returns the pinned x402 challenge", "FAIL", error?.message || "probe failed");
  }
}

if (mode === "dry") {
  for (const [id, name] of [
    ["1", "Fresh buyer-seat x402 payment independently verified"],
    ["2", "Signed bounds shown and exactly one trade confirmation"],
    ["3", "Fresh Polygon fill lands in the pinned buyer wallet"],
    ["4", "Verified position proof returns in the same journey"],
    ["6", "Payment-to-proof journey finishes under two minutes"],
  ]) record(id, name, "PENDING", "run --live");
}

if (mode === "live") {
  if (origin !== productionOrigin || has("orchestrator") || has("issuer-registry")) {
    process.stderr.write("Release-live Gate A pins the production origin, bundled orchestrator, and production issuer registry.\n");
    process.exit(2);
  }
  const required = {
    market: take("market"),
    side: take("side"),
    budget: take("budget"),
    maxPrice: take("max-price"),
    paymentPayer: take("payment-payer"),
    buyerWallet: take("buyer-wallet"),
  };
  const missing = Object.entries(required).filter(([, value]) => !value).map(([key]) => key);
  if (missing.length) {
    process.stderr.write(`Missing live arguments: ${missing.join(", ")}\n`);
    process.exit(2);
  }
  if (required.paymentPayer.toLowerCase() === SERVICE_PAYEE) {
    process.stderr.write("Release-live Gate A requires a buyer-seat payer distinct from the service treasury.\n");
    process.exit(2);
  }
  const trustedIssuerDocument = JSON.parse(readFileSync(productionRegistryPath, "utf8"));
  const trustedIssuers = trustedIssuerRegistry(trustedIssuerDocument.issuers || trustedIssuerDocument);
  const gateStartedAt = Date.now();
  const journey = await new Promise((resolve) => {
    const child = spawn(process.execPath, [
      orchestratorPath, "open", "--origin", origin,
      "--market", required.market, "--side", required.side,
      "--budget", required.budget, "--max-price", required.maxPrice,
      "--payment-payer", required.paymentPayer, "--buyer-wallet", required.buyerWallet,
      "--issuer-registry", productionRegistryPath, "--json",
    ], { stdio: ["inherit", "pipe", "pipe"] });
    let output = "";
    let errors = "";
    child.stdout.on("data", (chunk) => { output += chunk; process.stdout.write(chunk); });
    child.stderr.on("data", (chunk) => { errors += chunk; process.stderr.write(chunk); });
    const timer = setTimeout(() => child.kill("SIGKILL"), 150_000);
    child.on("close", (code) => {
      clearTimeout(timer);
      let report;
      try { report = JSON.parse(output.trim()); } catch {}
      resolve({ code, report, errors, wallMs: Date.now() - gateStartedAt });
    });
  });

  if (journey.code !== 0 || journey.report?.ok !== true) {
    if (journey.report?.reconciliationRequired === true && journey.report?.checkpoint) {
      reconciliation = journey.report.checkpoint;
    }
    const detail = journey.report?.code || `orchestrator exit ${journey.code}`;
    for (const [id, name] of [
      ["1", "Fresh buyer-seat x402 payment independently verified"],
      ["2", "Signed bounds shown and exactly one trade confirmation"],
      ["3", "Fresh Polygon fill lands in the pinned buyer wallet"],
      ["4", "Verified position proof returns in the same journey"],
      ["6", "Payment-to-proof journey finishes under two minutes"],
    ]) record(id, name, "FAIL", detail);
  } else {
    const r = journey.report;
    let payment;
    try {
      payment = await fetchAndVerifyX402Payment({
        paymentTx: r.paymentProof?.transactionHash,
        payer: required.paymentPayer,
        payee: SERVICE_PAYEE,
        asset: SERVICE_ASSET,
        amountAtomic: SERVICE_PRICE_ATOMIC,
        earliestAllowedTime: new Date(gateStartedAt).toISOString(),
      });
      record("1", "Fresh buyer-seat x402 payment independently verified", "PASS", payment.proof.transactionHash);
    } catch (error) {
      record("1", "Fresh buyer-seat x402 payment independently verified", "FAIL", error?.code || error?.message);
    }

    let cardBindingOk = false;
    let validatedCard;
    try {
      validatedCard = validateCard(r.card, { trustedIssuers, allowExpired: true });
      const previewResponse = await fetch(`${origin}/api/preview`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          market: required.market,
          outcome: required.side.toLowerCase(),
          spend: required.budget,
          maxPrice: required.maxPrice,
        }),
        signal: AbortSignal.timeout(20_000),
      });
      const gatePreview = await previewResponse.json();
      cardBindingOk = previewResponse.ok && gatePreview?.ok === true &&
        validatedCard.intent.version === "conviction-intent-v4" &&
        validatedCard.wallet === required.buyerWallet.toLowerCase() &&
        validatedCard.outcome === required.side.toUpperCase() &&
        BigInt(validatedCard.bounds.requestedBudgetRaw) === parseDecimal(required.budget, 6, "gate budget") &&
        parseDecimal(validatedCard.bounds.maxPrice, 6, "card cap") === parseDecimal(required.maxPrice, 6, "gate cap") &&
        validatedCard.intent.market.conditionId.toLowerCase() === gatePreview.preview.market.conditionId.toLowerCase() &&
        validatedCard.tokenId === String(gatePreview.preview.market.outcomeTokenId);
    } catch {}

    const eventTypes = Array.isArray(r.events) ? r.events.map((event) => event.type) : [];
    const expectedSequence = [
      "readiness_verified", "market_previewed", "payment_challenge_presented",
      "payment_confirmed", "payment_verified", "signed_card_verified",
      "dry_run_verified", "bounds_presented", "trade_confirmed",
      "pre_execution_verified", "execution_started", "order_submitted",
      "position_proof_verified",
    ];
    const paidIndex = eventTypes.indexOf("payment_verified");
    const confirmIndex = eventTypes.indexOf("trade_confirmed");
    const submitIndex = eventTypes.indexOf("order_submitted");
    const confirmedEvent = r.events?.find((event) => event.type === "trade_confirmed");
    const consentOk = cardBindingOk && r.confirmation?.count === 1 &&
      JSON.stringify(eventTypes) === JSON.stringify(expectedSequence) &&
      r.confirmation.confirmedAt === confirmedEvent?.at &&
      paidIndex >= 0 && paidIndex < confirmIndex && confirmIndex < submitIndex;
    record("2", "Signed bounds shown and exactly one trade confirmation", consentOk ? "PASS" : "FAIL", `confirmations:${r.confirmation?.count}`);

    let position;
    try {
      position = await fetchAndVerifyPosition(r.settlementTx, {
        intent: r.card.intent,
        intentHash: r.card.intentHash,
        orderId: r.orderId,
        issuance: r.card.issuance,
        trustedIssuers,
      });
      const walletOk = position.ok && position.positionProof.wallet.toLowerCase() === required.buyerWallet.toLowerCase();
      const settledAfterConfirmation = Date.parse(position.positionProof.settledAt) >=
        Math.floor(Number(r.confirmation.confirmedAt) / 1_000) * 1_000;
      record("3", "Fresh Polygon fill lands in the pinned buyer wallet", walletOk && settledAfterConfirmation ? "PASS" : "FAIL", r.settlementTx);
      const proofOk = position.positionProofHash === r.positionProofHash &&
        position.positionPassport?.version === "conviction-position-passport-v1" &&
        /^0x[0-9a-f]{64}$/i.test(position.positionPassportHash || "");
      record("4", "Verified position proof returns in the same journey", proofOk ? "PASS" : "FAIL", position.positionProofHash);
    } catch (error) {
      record("3", "Fresh Polygon fill lands in the pinned buyer wallet", "FAIL", error?.code || error?.message);
      record("4", "Verified position proof returns in the same journey", "FAIL", "independent verification failed");
    }

    const chainSeconds = payment && position
      ? Date.parse(position.positionProof.settledAt) / 1000 - Number(payment.proof.blockTimestamp)
      : Number.POSITIVE_INFINITY;
    const fast = journey.wallMs < 120_000 && chainSeconds >= 0 && chainSeconds < 120;
    record("6", "Payment-to-proof journey finishes under two minutes", fast ? "PASS" : "FAIL", `${(journey.wallMs / 1000).toFixed(1)}s wall / ${chainSeconds}s chain`);
  }
}

const failed = results.filter((result) => result.status === "FAIL");
const pending = results.filter((result) => result.status === "PENDING");
const verdict = mode === "live"
  ? failed.length === 0 && pending.length === 0 ? "GATE A: PASS" : "GATE A: FAIL"
  : failed.length === 0 ? `NO FAILURES (${pending.length} pending; Gate A undecided)` : "FAILURES PRESENT";
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
