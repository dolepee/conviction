import { compileIntent } from "./intent-compiler.mjs";
import {
  createEnvironmentIntentIssuer,
  trustedIssuerRegistryFromEnvironment,
  verifyIntentIssuance,
} from "./intent-issuer.mjs";
import { resolveMarket } from "./market-client.mjs";
import {
  verifyDepositWalletExecution,
  verifyDepositWalletReadiness,
  verifyOpenPluginPreview,
} from "./open-execution-preflight.mjs";
import {
  SERVICE_ASSET,
  SERVICE_PAYEE,
  SERVICE_PRICE_ATOMIC,
} from "./service-constants.mjs";
import { fetchAndVerifyX402Payment } from "./x402-payment-verifier.mjs";
import { invariant } from "./errors.mjs";

export const OPEN_CARD_REFRESH_URL = "https://conviction-bay.vercel.app/api/refresh";
export const OPEN_CARD_REFRESH_WINDOW_MS = 30 * 60 * 1_000;
const HASH_RE = /^0x[0-9a-f]{64}$/i;
const ADDRESS_RE = /^0x[0-9a-f]{40}$/i;

function rawCard(value) {
  const candidate = value?.response ?? value;
  invariant(
    candidate && typeof candidate === "object" && !Array.isArray(candidate),
    "invalid_refresh_card",
    "card must be a Conviction OPEN response",
  );
  invariant(
    candidate.intent?.version === "conviction-intent-v4" &&
      candidate.intent?.order?.side === "BUY" &&
      candidate.intent?.order?.orderType === "FAK",
    "invalid_refresh_card",
    "Only an issuer-signed v4 OPEN card can be refreshed",
  );
  invariant(
    candidate.intent.walletPreparation === undefined,
    "maker_not_eligible",
    "Finite-approval EOA cards cannot be refreshed",
    { paymentAllowed: false, nextAction: "USE_READY_DEPOSIT_WALLET_OR_STOP" },
  );
  return candidate;
}

function refreshDescriptor(paymentTx, payer, paymentBlockTimestamp) {
  return Object.freeze({
    version: "conviction-open-card-refresh-v1",
    endpoint: OPEN_CARD_REFRESH_URL,
    method: "POST",
    additionalPaymentRequired: false,
    paymentTx,
    payer,
    paymentBlockTimestamp,
    reusableUntil: new Date(
      Number(BigInt(paymentBlockTimestamp)) * 1_000 + OPEN_CARD_REFRESH_WINDOW_MS,
    ).toISOString(),
    scope: "same-market-outcome-budget-cap-and-wallet",
  });
}

export async function refreshOpenCard(
  body,
  {
    environment = process.env,
    now = Date.now,
    resolveMarketImpl = resolveMarket,
    verifyWalletImpl = verifyDepositWalletExecution,
    verifyPaymentImpl = fetchAndVerifyX402Payment,
    issueIntentImpl = undefined,
  } = {},
) {
  const original = rawCard(body?.card);
  const trustedIssuers = trustedIssuerRegistryFromEnvironment(environment);
  verifyIntentIssuance({
    intent: original.intent,
    intentHash: original.intentHash,
    issuance: original.issuance,
    trustedIssuers,
    settledAt: original.issuance?.issuedAt,
  });

  const paymentTx = String(body?.paymentTx || "").toLowerCase();
  const payer = String(body?.payer || "").toLowerCase();
  invariant(HASH_RE.test(paymentTx), "invalid_payment_transaction", "paymentTx is invalid");
  invariant(ADDRESS_RE.test(payer), "invalid_payment_expectation", "payer is invalid");

  const issuedAtMs = Date.parse(original.issuance.issuedAt);
  const expiresAtMs = Date.parse(original.issuance.expiresAt);
  const issuanceSecondMs = Math.floor(issuedAtMs / 1_000) * 1_000;
  const verifiedPayment = await verifyPaymentImpl({
    paymentTx,
    payer,
    payee: SERVICE_PAYEE,
    asset: SERVICE_ASSET,
    amountAtomic: SERVICE_PRICE_ATOMIC,
    earliestAllowedTime: new Date(issuanceSecondMs).toISOString(),
  });
  const paymentBlockTimestamp = String(verifiedPayment?.proof?.blockTimestamp || "");
  invariant(/^(?:0|[1-9][0-9]*)$/.test(paymentBlockTimestamp), "invalid_payment_receipt", "Payment proof has no block timestamp");
  const paymentMs = Number(BigInt(paymentBlockTimestamp)) * 1_000;
  invariant(
    paymentMs >= issuanceSecondMs,
    "payment_card_mismatch",
    "Payment settled before the original signed card issuance second",
  );
  invariant(
    paymentMs <= expiresAtMs,
    "payment_card_mismatch",
    "Payment settled outside the original signed card window",
  );
  invariant(
    now() >= paymentMs && now() <= paymentMs + OPEN_CARD_REFRESH_WINDOW_MS,
    "refresh_window_expired",
    "The free card-refresh window has expired",
    {
      reusableUntil: new Date(paymentMs + OPEN_CARD_REFRESH_WINDOW_MS).toISOString(),
    },
  );

  const walletReadiness = verifyDepositWalletReadiness(
    original.intent.buyer.wallet,
    body?.walletReadiness,
  );
  await verifyWalletImpl(original.intent.buyer.wallet, {
    owner: walletReadiness.owner,
  });
  const request = {
    market: original.intent.market.conditionId,
    outcome: original.intent.order.outcome,
    spend: original.intent.order.requestedBudget,
    maxPrice: original.intent.order.maxPrice,
    wallet: original.intent.buyer.wallet,
    executionMode: "deposit-wallet",
    rationale: original.intent.rationale,
  };
  const market = await resolveMarketImpl(request.market, { outcome: request.outcome });
  const compilation = compileIntent(request, market, {
    now: now(),
    maxSnapshotAgeMs: 30_000,
    quoteTtlMs: 300_000,
    intentVersion: "conviction-intent-v4",
  });
  verifyOpenPluginPreview(compilation, body?.pluginPreview, {
    verifiedWallet: walletReadiness.wallet,
  });
  const issue = issueIntentImpl ?? createEnvironmentIntentIssuer(environment, { now });
  const refreshed = await issue(compilation);
  return Object.freeze({
    ...refreshed,
    refreshedFromIntentHash: original.intentHash,
    refresh: refreshDescriptor(paymentTx, payer, paymentBlockTimestamp),
  });
}

export function attachOpenRefreshContract(card) {
  return Object.freeze({
    ...card,
    refresh: Object.freeze({
      version: "conviction-open-card-refresh-v1",
      endpoint: OPEN_CARD_REFRESH_URL,
      method: "POST",
      windowSeconds: OPEN_CARD_REFRESH_WINDOW_MS / 1_000,
      additionalPaymentRequired: false,
      requires: ["card", "paymentTx", "payer", "walletReadiness", "pluginPreview"],
      scope: "same-market-outcome-budget-cap-and-wallet",
    }),
  });
}
