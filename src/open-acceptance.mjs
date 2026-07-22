import { parseDecimal } from "./decimal.mjs";
import {
  SERVICE_ASSET,
  SERVICE_NETWORK,
  SERVICE_PAYEE,
  SERVICE_PRICE_ATOMIC,
  SERVICE_RESOURCE,
} from "./service-payment.mjs";

function lower(value) {
  return String(value ?? "").toLowerCase();
}

export const OPEN_ACCEPTANCE_EVENT_SEQUENCE = Object.freeze([
  "readiness_verified",
  "market_previewed",
  "payment_challenge_presented",
  "payment_confirmed",
  "payment_verified",
  "signed_card_verified",
  "dry_run_verified",
  "bounds_presented",
  "trade_confirmed",
  "pre_execution_verified",
  "execution_started",
  "order_submitted",
  "position_proof_verified",
]);

export function evaluateOpenDisplayBinding({
  displayed,
  validatedCard,
  required,
  reportPaymentProof,
} = {}) {
  try {
    const payment = displayed?.completedPayment;
    const intent = validatedCard?.intent;
    const bounds = validatedCard?.bounds;
    return Boolean(
      displayed && validatedCard && required && payment && intent && bounds &&
      displayed.action === "OPEN" && displayed.market === required.market &&
      displayed.marketQuestion === intent.market?.question &&
      lower(displayed.conditionId) === lower(intent.market?.conditionId) &&
      displayed.side === String(required.side || "").toUpperCase() &&
      String(displayed.outcomeTokenId) === String(validatedCard.tokenId) &&
      BigInt(displayed.requestedBudgetRaw) === parseDecimal(required.budget, 6, "displayed budget") &&
      String(displayed.requestedBudgetRaw) === String(bounds.requestedBudgetRaw) &&
      parseDecimal(displayed.maxPrice, 6, "displayed maximum price") ===
        parseDecimal(required.maxPrice, 6, "required maximum price") &&
      parseDecimal(displayed.maxPrice, 6, "displayed maximum price") ===
        parseDecimal(bounds.maxPrice, 6, "card maximum price") &&
      String(displayed.maximumOrderPrincipalRaw) === String(bounds.maximumOrderPrincipalRaw) &&
      String(displayed.maximumFeeRaw) === String(bounds.maximumFeeRaw) &&
      String(displayed.maximumTotalDebitRaw) === String(bounds.maximumTotalDebitRaw) &&
      String(displayed.fullFillSharesRaw) === String(bounds.fullFillSharesRaw) &&
      lower(displayed.wallet) === lower(required.buyerWallet) &&
      lower(displayed.wallet) === lower(validatedCard.wallet) &&
      lower(displayed.intentHash) === lower(validatedCard.intentHash) &&
      displayed.issuerKeyId === validatedCard.issuance?.keyId &&
      displayed.issuedAt === validatedCard.issuance?.issuedAt &&
      displayed.expiresAt === validatedCard.expiresAt &&
      lower(payment.transactionHash) === lower(reportPaymentProof?.transactionHash) &&
      payment.amountAtomic === SERVICE_PRICE_ATOMIC && payment.resource === SERVICE_RESOURCE &&
      payment.network === SERVICE_NETWORK && lower(payment.asset) === SERVICE_ASSET &&
      lower(payment.payer) === lower(required.paymentPayer) && lower(payment.payee) === SERVICE_PAYEE
    );
  } catch {
    return false;
  }
}

export function evaluateOpenConsentAcceptance({
  cardBindingOk,
  displayOk,
  report,
} = {}) {
  try {
    const events = Array.isArray(report?.events) ? report.events : [];
    const eventTypes = events.map((event) => event.type);
    const confirmedEvents = events.filter((event) => event.type === "trade_confirmed");
    const confirmed = confirmedEvents[0];
    const paid = events.find((event) => event.type === "payment_verified");
    const submitted = events.find((event) => event.type === "order_submitted");
    const proved = events.find((event) => event.type === "position_proof_verified");
    const times = [paid?.at, confirmed?.at, submitted?.at, proved?.at].map(Number);
    return Boolean(
      cardBindingOk === true && displayOk === true && report.mode === "open" &&
      report.ordersPlaced === 1 && report.confirmation?.count === 1 && confirmedEvents.length === 1 &&
      JSON.stringify(eventTypes) === JSON.stringify(OPEN_ACCEPTANCE_EVENT_SEQUENCE) &&
      Number(report.confirmation.confirmedAt) === Number(confirmed?.at) &&
      times.every(Number.isSafeInteger) && times[0] < times[1] && times[1] < times[2] &&
      times[2] <= times[3]
    );
  } catch {
    return false;
  }
}
