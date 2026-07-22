import { sha256 } from "./canonical.mjs";

const HASH_RE = /^0x[0-9a-f]{64}$/;

function lower(value) {
  return String(value ?? "").toLowerCase();
}

export function evaluateTakeProfitConsentBinding({
  journal,
  reportCard,
  validatedCard,
  independentPaymentProof,
  reportPaymentTx,
  reportConfirmationCount,
  reportConfirmedAt,
  confirmedEventCount,
  confirmedEventAt,
  expectedPayer,
  expectedPayee,
  expectedAsset,
  expectedAmountAtomic,
} = {}) {
  try {
    const consent = journal?.tradeConsent;
    const consentAt = Date.parse(consent?.confirmedAt);
    const reportAt = Number(reportConfirmedAt);
    const eventAt = Number(confirmedEventAt);
    const paymentBlockTimestamp = String(independentPaymentProof?.blockTimestamp ?? "");
    const paymentBlockAt = /^\d+$/.test(paymentBlockTimestamp)
      ? Number(paymentBlockTimestamp) * 1_000
      : Number.NaN;
    const cardIssuedAt = Date.parse(validatedCard?.issuanceVerification?.issuedAt);
    const cardExpiresAt = Date.parse(validatedCard?.expiresAt);
    const reportTx = lower(reportPaymentTx);
    const independentTx = lower(independentPaymentProof?.transactionHash);
    const journalTx = lower(journal?.paymentTx);

    const exactConfirmation = reportConfirmationCount === 1 && confirmedEventCount === 1 &&
      Number.isSafeInteger(reportAt) && Number.isSafeInteger(eventAt) && reportAt === eventAt &&
      Number.isFinite(consentAt) && new Date(consentAt).toISOString() === consent.confirmedAt &&
      consentAt === reportAt;
    const confirmationInsidePaidCard = exactConfirmation && Number.isFinite(paymentBlockAt) &&
      Number.isFinite(cardIssuedAt) && Number.isFinite(cardExpiresAt) &&
      consentAt >= paymentBlockAt && consentAt >= cardIssuedAt && consentAt < cardExpiresAt;
    const cardBound = journal?.version === "conviction-take-profit-journey-v1" &&
      journal?.action === "TAKE_PROFIT" && sha256(journal.paidCard) === sha256(reportCard) &&
      journal?.intentHash === validatedCard?.intentHash && consent?.intentHash === validatedCard?.intentHash &&
      consent?.executionArgvHash === sha256(validatedCard?.executionCard?.argv) &&
      HASH_RE.test(String(journal?.replayKey || "")) && consent?.replayKey === journal.replayKey &&
      consent?.placementExpiresAt === validatedCard?.expiresAt &&
      consent?.venueExpiresAt === validatedCard?.bounds?.venueExpiresAt;
    const paymentBound = reportTx.length > 0 && reportTx === independentTx && reportTx === journalTx &&
      consent?.paymentTx === journalTx && journal?.paymentProof?.transactionHash === independentTx &&
      journal?.paymentProof?.blockTimestamp === independentPaymentProof?.blockTimestamp &&
      journal?.paymentProof?.payer === expectedPayer && journal?.paymentProof?.payee === expectedPayee &&
      journal?.paymentProof?.asset === expectedAsset &&
      journal?.paymentProof?.amountAtomic === expectedAmountAtomic;

    return Object.freeze({
      ok: exactConfirmation && confirmationInsidePaidCard && cardBound && paymentBound,
      exactConfirmation,
      confirmationInsidePaidCard,
      cardBound,
      paymentBound,
    });
  } catch {
    return Object.freeze({
      ok: false,
      exactConfirmation: false,
      confirmationInsidePaidCard: false,
      cardBound: false,
      paymentBound: false,
    });
  }
}
