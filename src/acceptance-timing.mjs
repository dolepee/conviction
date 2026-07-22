function timestampMilliseconds(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value : Number.NaN;
  if (value instanceof Date) return value.getTime();
  if (typeof value !== "string" || value.length === 0) return Number.NaN;
  return Date.parse(value);
}

function epochSeconds(value) {
  const text = String(value ?? "");
  if (!/^\d+$/.test(text)) return Number.NaN;
  const parsed = Number(text);
  return Number.isSafeInteger(parsed) ? parsed : Number.NaN;
}

/**
 * Settlement/order timestamps supplied by Polygon and Polymarket have
 * whole-second resolution. A live action is therefore proven post-consent only
 * when its observed second is strictly greater than the confirmation second.
 */
export function strictlyPostdatesConfirmationSecond(later, confirmation) {
  const laterMs = timestampMilliseconds(later);
  const confirmationMs = timestampMilliseconds(confirmation);
  return Number.isFinite(laterMs) && Number.isFinite(confirmationMs) &&
    Math.floor(laterMs / 1_000) > Math.floor(confirmationMs / 1_000);
}

/**
 * Evaluate a filled OPEN/CLOSE payment-to-proof SLA without counting time
 * spent waiting for the buyer's payment or trade consent. The local interval
 * must agree with the orchestrator's recorded duration, while the verified X
 * Layer payment block and this gate's proof-observation time independently
 * form one nonnegative sub-120s interval.
 */
export function evaluateFilledOrderAcceptanceTiming({
  paymentBlockTimestamp,
  settledAt,
  proofObservedAt,
  localPaidAt,
  localProvedAt,
  recordedLocalPaymentToProofMs,
} = {}) {
  const paymentSecond = epochSeconds(paymentBlockTimestamp);
  const settledAtMs = timestampMilliseconds(settledAt);
  const proofObservedAtMs = timestampMilliseconds(proofObservedAt);
  const paidAtMs = timestampMilliseconds(localPaidAt);
  const provedAtMs = timestampMilliseconds(localProvedAt);
  const recordedLocalMs = Number(recordedLocalPaymentToProofMs);
  const timestampsValid = [
    paymentSecond,
    settledAtMs,
    proofObservedAtMs,
    paidAtMs,
    provedAtMs,
    recordedLocalMs,
  ].every(Number.isFinite);
  const chainPaymentToProofMs = timestampsValid
    ? proofObservedAtMs - paymentSecond * 1_000
    : Number.NaN;
  const chainTimingBound = Number.isFinite(chainPaymentToProofMs) &&
    chainPaymentToProofMs >= 0 && chainPaymentToProofMs < 120_000;
  const settlementChronologyBound = timestampsValid &&
    settledAtMs >= paymentSecond * 1_000 && settledAtMs <= proofObservedAtMs;
  const localPaymentToProofMs = timestampsValid ? provedAtMs - paidAtMs : Number.NaN;
  const localTimingBound = Number.isFinite(localPaymentToProofMs) &&
    localPaymentToProofMs >= 0 && localPaymentToProofMs < 120_000 &&
    localPaymentToProofMs === recordedLocalMs;

  return Object.freeze({
    ok: timestampsValid && chainTimingBound && settlementChronologyBound && localTimingBound,
    timestampsValid,
    chainTimingBound,
    settlementChronologyBound,
    localTimingBound,
    chainPaymentToProofMs,
    localPaymentToProofMs,
  });
}

/**
 * Independently evaluate the time bindings used by live TAKE_PROFIT Gate C.
 * Local runtime timings are retained, but cannot establish the release gate by
 * themselves: the X Layer payment block, authenticated CLOB creation second,
 * and authenticated fetch timestamp must also form one nonnegative sub-120s
 * interval.
 */
export function evaluateTakeProfitAcceptanceTiming({
  paymentBlockTimestamp,
  orderCreatedAt,
  orderFetchedAt,
  reportConfirmedAt,
  journalConfirmedAt,
  cardCapturedAt,
  cardExpiresAt,
  localPaidAt,
  localProvedAt,
  recordedLocalPaymentToProofMs,
} = {}) {
  const paymentSecond = epochSeconds(paymentBlockTimestamp);
  const orderSecond = epochSeconds(orderCreatedAt);
  const fetchedAtMs = timestampMilliseconds(orderFetchedAt);
  const reportConfirmedAtMs = timestampMilliseconds(reportConfirmedAt);
  const journalConfirmedAtMs = timestampMilliseconds(journalConfirmedAt);
  const cardCapturedAtMs = timestampMilliseconds(cardCapturedAt);
  const cardExpiresAtMs = timestampMilliseconds(cardExpiresAt);
  const paidAtMs = timestampMilliseconds(localPaidAt);
  const provedAtMs = timestampMilliseconds(localProvedAt);
  const recordedLocalMs = Number(recordedLocalPaymentToProofMs);

  const timestampsValid = [
    paymentSecond,
    orderSecond,
    fetchedAtMs,
    reportConfirmedAtMs,
    journalConfirmedAtMs,
    cardCapturedAtMs,
    cardExpiresAtMs,
    paidAtMs,
    provedAtMs,
    recordedLocalMs,
  ].every(Number.isFinite);
  const confirmationBound = timestampsValid && reportConfirmedAtMs === journalConfirmedAtMs;
  const orderAfterConfirmation = timestampsValid &&
    orderSecond > Math.floor(reportConfirmedAtMs / 1_000) &&
    orderSecond > Math.floor(journalConfirmedAtMs / 1_000);
  const insideCardWindow = timestampsValid &&
    orderSecond >= Math.floor(cardCapturedAtMs / 1_000) &&
    orderSecond <= Math.floor(cardExpiresAtMs / 1_000);
  const orderAfterPayment = timestampsValid && orderSecond >= paymentSecond;
  const fetchAfterOrder = timestampsValid && fetchedAtMs >= orderSecond * 1_000;
  const chainPaymentToArmedMs = timestampsValid
    ? fetchedAtMs - paymentSecond * 1_000
    : Number.NaN;
  const chainTimingBound = Number.isFinite(chainPaymentToArmedMs) &&
    chainPaymentToArmedMs >= 0 && chainPaymentToArmedMs < 120_000;
  const localPaymentToProofMs = timestampsValid ? provedAtMs - paidAtMs : Number.NaN;
  const localTimingBound = Number.isFinite(localPaymentToProofMs) &&
    localPaymentToProofMs >= 0 && localPaymentToProofMs < 120_000 &&
    localPaymentToProofMs === recordedLocalMs;

  return Object.freeze({
    ok: timestampsValid && confirmationBound && orderAfterConfirmation && insideCardWindow &&
      orderAfterPayment && fetchAfterOrder && chainTimingBound && localTimingBound,
    timestampsValid,
    confirmationBound,
    orderAfterConfirmation,
    insideCardWindow,
    orderAfterPayment,
    fetchAfterOrder,
    chainTimingBound,
    localTimingBound,
    chainPaymentToArmedMs,
    localPaymentToProofMs,
  });
}
