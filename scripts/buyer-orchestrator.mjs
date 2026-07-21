#!/usr/bin/env node

import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { createInterface } from "node:readline/promises";
import { stdin, stdout, stderr } from "node:process";
import { promisify } from "node:util";

import { runOpenJourney } from "../src/buyer-orchestrator.mjs";
import { CONTRACTS, POLYGON_CHAIN_ID, POLYGON_RPC_URL } from "../src/constants.mjs";
import { trustedIssuerRegistry } from "../src/intent-issuer.mjs";
import {
  SERVICE_ASSET,
  SERVICE_NETWORK,
  SERVICE_PAYEE,
  SERVICE_PRICE_ATOMIC,
  SERVICE_RESOURCE,
} from "../src/service-payment.mjs";
import { fetchAndVerifyX402Payment } from "../src/x402-payment-verifier.mjs";
import {
  buildReceiptRequest,
  validateCard,
  validatePluginPreview,
  validateProof,
} from "../skills/conviction-executor/scripts/conviction-card.mjs";

const execFileAsync = promisify(execFile);
let executionAttempted = false;
const checkpoint = {
  stage: "not_started",
  paymentTx: null,
  intentHash: null,
  orderId: null,
  settlementTx: null,
  positionProofHash: null,
};

function usage() {
  return [
    "Usage:",
    "  node scripts/buyer-orchestrator.mjs open --origin <url> --market <slug-or-id>",
    "    --side YES|NO --budget <pUSD> --max-price <price>",
    "    --payment-payer <X-Layer-address> --buyer-wallet <Polygon-deposit-wallet>",
    "    --issuer-registry <issuers.json> [--json]",
    "",
    "The program displays the exact x402 challenge and requires `confirm payment`,",
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
  if (command !== "open") throw Object.assign(new Error(usage()), { code: "invalid_command" });
  const parsed = {
    origin: take("--origin").replace(/\/$/, ""),
    market: take("--market"),
    side: take("--side").toUpperCase(),
    budget: take("--budget"),
    maxPrice: take("--max-price"),
    paymentPayer: take("--payment-payer").toLowerCase(),
    buyerWallet: take("--buyer-wallet").toLowerCase(),
    issuerRegistry: take("--issuer-registry"),
    json: boolean("--json"),
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

function findAddress(addresses, chainIndex) {
  return addresses?.data?.xlayer?.find((entry) => String(entry.chainIndex) === String(chainIndex))?.address;
}

function depositWalletFromQuickstart(quickstart) {
  const data = quickstart?.data || quickstart;
  const address = data?.wallet?.deposit_wallet;
  return address ? String(address).toLowerCase() : null;
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

export function validatePaymentChallenge(decoded) {
  const requirement = decoded?.accepts?.[0];
  if (
    decoded?.x402Version !== 2 || decoded?.resource?.url !== SERVICE_RESOURCE ||
    requirement?.scheme !== "exact" || requirement?.network !== SERVICE_NETWORK ||
    requirement?.asset?.toLowerCase() !== SERVICE_ASSET ||
    requirement?.payTo?.toLowerCase() !== SERVICE_PAYEE ||
    requirement?.amount !== SERVICE_PRICE_ATOMIC
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
  const trustedIssuers = JSON.parse(await readFile(options.issuerRegistry, "utf8"));
  const pinnedRecords = trustedIssuers?.issuers || trustedIssuers;
  const pinnedRegistry = trustedIssuerRegistry(pinnedRecords);
  if (pinnedRegistry.size === 0) {
    throw Object.assign(new Error("Pinned issuer registry is empty"), { code: "missing_trusted_issuer" });
  }
  const requestBody = {
    market: options.market,
    outcome: options.side.toLowerCase(),
    spend: options.budget,
    maxPrice: options.maxPrice,
    wallet: options.buyerWallet,
  };
  const emit = options.json
    ? (event) => process.stderr.write(`${JSON.stringify(event)}\n`)
    : (event) => {
      if (event.type === "payment_confirmation") {
        const requirement = event.challenge?.decoded?.accepts?.[0] || {};
        stdout.write([
          "\nConviction service payment:",
          `  Amount: ${requirement.amount} atomic USD₮0 (0.05 USD₮0)`,
          `  Network: ${requirement.network}`,
          `  Asset: ${requirement.asset}`,
          `  From: ${options.paymentPayer}`,
          `  To: ${requirement.payTo}`,
          `  Resource: ${event.challenge?.decoded?.resource?.url}`,
          "",
        ].join("\n"));
      } else if (event.type === "trade_confirmation") {
        const b = event.bounds;
        stdout.write([
          "\nBounded order ready:",
          `  Market: ${b.market}`,
          `  Side: ${b.side}`,
          `  Maximum price: ${b.maxPrice}`,
          `  Maximum order principal: ${b.maximumOrderPrincipalRaw} atomic pUSD`,
          `  Current venue-fee reserve: ${b.maximumFeeRaw} atomic pUSD (V2 fee is operator-set at match time)`,
          `  Accepted total-debit ceiling for verification: ${b.maximumTotalDebitRaw} atomic pUSD`,
          `  Buyer wallet: ${b.wallet}`,
          `  Expires: ${b.expiresAt}`,
          "",
        ].join("\n"));
      }
    };
  const readline = createInterface({ input: stdin, output: options.json ? stderr : stdout });
  let paymentConsentUsed = false;
  let selectedTradingMode = "";
  const confirm = async (kind) => {
    if (kind === "payment") {
      if (paymentConsentUsed) return false;
      paymentConsentUsed = true;
      const answer = await readline.question("Type `confirm payment` to pay exactly 0.05 USD₮0 on X Layer: ");
      return answer.trim() === "confirm payment";
    }
    const answer = await readline.question("Type `confirm live mode` to submit this one bounded order: ");
    return answer.trim() === "confirm live mode";
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
    checkReadiness: async () => {
      const [access, addresses, quickstart] = await Promise.all([
        commandJson("polymarket-plugin", ["check-access"], "Polymarket access check"),
        commandJson("onchainos", ["wallet", "addresses"], "Agentic Wallet addresses"),
        commandJson("polymarket-plugin", ["quickstart"], "Polymarket readiness"),
      ]);
      const depositWallet = depositWalletFromQuickstart(quickstart);
      const pUsdBalanceRaw = depositWallet ? await polygonPusdBalanceRaw(depositWallet) : "0";
      return normalizePluginReadiness({
        access,
        addresses,
        quickstart,
        selectedMode: selectedTradingMode,
        pUsdBalanceRaw,
      });
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
    requestPaymentChallenge: async () => {
      const { response, json } = await postJson(`${options.origin}/api/service`, requestBody);
      const encoded = response.headers.get("payment-required");
      if (response.status !== 402 || !encoded) {
        throw Object.assign(new Error(json?.error?.message || "Service did not return an x402 challenge"), {
          code: "invalid_payment_challenge",
        });
      }
      const decoded = decodeHeader(encoded, "PAYMENT-REQUIRED");
      validatePaymentChallenge(decoded);
      return { encoded, decoded };
    },
    payAndRequestCard: async ({ challenge }) => {
      const signed = await commandJson(
        "onchainos",
        ["payment", "pay", "--payload", challenge.encoded, "--selected-index", "0", "--chain", "xlayer"],
        "x402 authorization",
      );
      const data = signed?.data || signed;
      const headerName = data.header_name || "PAYMENT-SIGNATURE";
      if (!data.authorization_header || String(data.wallet || "").toLowerCase() !== options.paymentPayer) {
        throw Object.assign(new Error("x402 authorization was not signed by the pinned payer"), { code: "payment_wallet_mismatch" });
      }
      const { response, json } = await postJson(`${options.origin}/api/service`, requestBody, {
        headers: { [headerName]: data.authorization_header },
      });
      if (!response.ok || json?.ok !== true) {
        throw Object.assign(new Error(json?.error?.message || "Paid service request failed"), {
          code: json?.error?.code || "paid_service_failed",
        });
      }
      const paymentResponseRaw = response.headers.get("payment-response");
      const paymentResponse = decodeHeader(paymentResponseRaw, "PAYMENT-RESPONSE");
      const paymentTx = paymentTransaction(paymentResponse);
      checkpoint.stage = "paid_card_received";
      checkpoint.paymentTx = paymentTx;
      checkpoint.intentHash = json.intentHash || null;
      return { card: json, paymentResponse, paymentTx };
    },
    verifyPayment: async ({ paid, startedAt }) => {
      const result = await fetchAndVerifyX402Payment({
        paymentTx: paid.paymentTx,
        payer: options.paymentPayer,
        payee: SERVICE_PAYEE,
        asset: SERVICE_ASSET,
        amountAtomic: SERVICE_PRICE_ATOMIC,
        earliestAllowedTime: new Date(startedAt).toISOString(),
      });
      checkpoint.stage = "payment_verified";
      return result.proof;
    },
    validateCard: async (card, validationOptions) => validateCard(card, validationOptions),
    dryRun: async (argv) => commandJson("polymarket-plugin", [...argv, "--dry-run"], "Polymarket dry run"),
    validateDryRun: async (card, dryRun, validationOptions) => validatePluginPreview(card, dryRun, validationOptions),
    execute: async (argv) => {
      executionAttempted = true;
      checkpoint.stage = "execution_attempted";
      const result = await commandJson("polymarket-plugin", argv, "Polymarket live order");
      const data = result?.data || result;
      checkpoint.stage = "live_result_received";
      checkpoint.orderId = data?.order_id || null;
      checkpoint.settlementTx = Array.isArray(data?.tx_hashes) ? data.tx_hashes[0] || null : null;
      return result;
    },
    buildReceiptRequest: async (card, result, validationOptions) => buildReceiptRequest(card, result, validationOptions),
    fetchProof: async (body) => {
      const { response, json } = await postJson(`${options.origin}/api/receipt`, body);
      if (!response.ok || json?.ok !== true) {
        throw Object.assign(new Error(json?.error?.message || "Receipt proof failed"), {
          code: json?.error?.code || "receipt_failed",
        });
      }
      checkpoint.stage = "proof_received";
      checkpoint.positionProofHash = json.positionProofHash || null;
      return json;
    },
    validateProof: async (card, proof, validationOptions) => validateProof(card, proof, validationOptions),
  };

  try {
    const result = await runOpenJourney({
      request: {
        market: options.market,
        side: options.side,
        budget: options.budget,
        maxPrice: options.maxPrice,
      },
      paymentPayer: options.paymentPayer,
      buyerWallet: options.buyerWallet,
      trustedIssuers,
      adapters,
      confirm,
      emit,
    });
    stdout.write(`${JSON.stringify(result)}\n`);
    checkpoint.stage = "complete";
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
    process.stdout.write(`${JSON.stringify({
      ok: false,
      code: error?.code || "buyer_journey_failed",
      message: error?.message || "Buyer journey failed",
      ordersPlaced: executionAttempted ? "unknown" : 0,
      reconciliationRequired: executionAttempted,
      checkpoint,
    })}\n`);
    process.exitCode = 1;
  }
}
