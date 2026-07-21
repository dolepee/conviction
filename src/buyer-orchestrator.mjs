import { parseDecimal } from "./decimal.mjs";

const ADDRESS_RE = /^0x[0-9a-f]{40}$/i;

export class BuyerJourneyError extends Error {
  constructor(code, message, details = undefined) {
    super(message);
    this.name = "BuyerJourneyError";
    this.code = code;
    this.details = details;
  }
}

function requireValue(condition, code, message, details = undefined) {
  if (!condition) throw new BuyerJourneyError(code, message, details);
}

function lower(value) {
  return String(value || "").toLowerCase();
}

function normalizeRequest(request) {
  const market = String(request?.market || "").trim();
  const side = String(request?.side || "").toUpperCase();
  const budget = String(request?.budget || "");
  const maxPrice = String(request?.maxPrice || "");
  requireValue(market, "invalid_request", "Market is required");
  requireValue(side === "YES" || side === "NO", "invalid_request", "Side must be YES or NO");
  const budgetRaw = parseDecimal(budget, 6, "budget");
  const maxPriceRaw = parseDecimal(maxPrice, 6, "maxPrice");
  requireValue(budgetRaw > 0n, "invalid_request", "Budget must be positive");
  requireValue(maxPriceRaw > 0n && maxPriceRaw < 1_000_000n, "invalid_request", "Maximum price must be between zero and one");
  return Object.freeze({ market, side, budget, maxPrice, budgetRaw, maxPriceRaw });
}

function requireWallet(value, label) {
  const wallet = lower(value);
  requireValue(ADDRESS_RE.test(wallet), "invalid_wallet", `${label} is invalid`);
  return wallet;
}

function bindCardToRequest(validated, preview, request, buyerWallet) {
  const intent = validated?.intent;
  requireValue(intent && validated?.bounds, "invalid_card", "Validated card is incomplete");
  requireValue(validated.wallet === buyerWallet, "wallet_substitution", "Card buyer wallet differs from the active deposit wallet");
  requireValue(validated.outcome === request.side, "outcome_substitution", "Card outcome differs from the requested side");
  requireValue(
    lower(intent.market?.conditionId) === lower(preview?.conditionId),
    "market_substitution",
    "Card condition differs from the free preview",
  );
  requireValue(
    String(validated.tokenId) === String(preview?.outcomeTokenId),
    "token_substitution",
    "Card outcome token differs from the free preview",
  );
  requireValue(
    BigInt(validated.bounds.requestedBudgetRaw) === request.budgetRaw,
    "budget_substitution",
    "Card budget differs from the buyer request",
  );
  requireValue(
    parseDecimal(validated.bounds.maxPrice, 6, "card max price") === request.maxPriceRaw,
    "price_substitution",
    "Card maximum price differs from the buyer request",
  );
}

function requireReadiness(readiness, paymentPayer, buyerWallet, minimumDebitRaw = undefined) {
  requireValue(readiness?.accessible === true, "venue_unavailable", "Prediction venue is unavailable in the buyer region");
  requireValue(readiness?.clobVersion === "V2", "unsupported_venue", "Standard Polymarket V2 is required");
  requireValue(readiness?.currentMode === "deposit_wallet", "wrong_trading_mode", "Persisted Polymarket mode is not DEPOSIT_WALLET");
  requireValue(lower(readiness?.paymentPayer) === paymentPayer, "payment_wallet_mismatch", "Active X Layer payer differs from the requested payer");
  requireValue(lower(readiness?.buyerWallet) === buyerWallet, "trading_wallet_mismatch", "Active Polygon deposit wallet differs from the card wallet");
  requireValue(lower(readiness?.tradingAddress) === buyerWallet, "trading_wallet_mismatch", "Polymarket trading address differs from the deposit wallet");
  if (minimumDebitRaw !== undefined) {
    requireValue(
      BigInt(readiness?.pUsdBalanceRaw ?? -1) >= BigInt(minimumDebitRaw),
      "insufficient_trade_balance",
      "Deposit wallet lacks enough pUSD for the bounded order",
    );
  }
}

export async function runOpenJourney({
  request: rawRequest,
  paymentPayer: paymentPayerValue,
  buyerWallet: buyerWalletValue,
  trustedIssuers,
  adapters,
  confirm,
  emit = () => {},
  now = Date.now,
}) {
  const request = normalizeRequest(rawRequest);
  const paymentPayer = requireWallet(paymentPayerValue, "Payment payer");
  const buyerWallet = requireWallet(buyerWalletValue, "Buyer wallet");
  requireValue(typeof confirm === "function", "confirmation_required", "Confirmation handler is required");
  for (const name of [
    "ensureTradingMode", "checkReadiness", "previewMarket", "requestPaymentChallenge", "payAndRequestCard",
    "verifyPayment", "validateCard", "dryRun", "validateDryRun", "execute",
    "buildReceiptRequest", "fetchProof", "validateProof",
  ]) requireValue(typeof adapters?.[name] === "function", "invalid_adapter", `Missing adapter: ${name}`);

  const startedAt = now();
  const events = [];
  let confirmationCount = 0;
  let ordersPlaced = 0;
  const mark = (type, details = undefined) => {
    const event = { sequence: events.length + 1, type, at: now(), ...(details ? { details } : {}) };
    events.push(event);
    return event;
  };

  await adapters.ensureTradingMode({ buyerWallet });
  const initialReadiness = await adapters.checkReadiness({ paymentPayer, buyerWallet });
  requireReadiness(initialReadiness, paymentPayer, buyerWallet);
  mark("readiness_verified");

  const preview = await adapters.previewMarket(request);
  requireValue(preview?.conditionId && preview?.outcomeTokenId, "invalid_preview", "Free preview did not resolve the selected market and outcome token");
  mark("market_previewed", { conditionId: lower(preview.conditionId), outcomeTokenId: String(preview.outcomeTokenId) });

  const challenge = await adapters.requestPaymentChallenge({ request, buyerWallet });
  emit({ type: "payment_confirmation", challenge, request: { ...request, budgetRaw: undefined, maxPriceRaw: undefined } });
  mark("payment_challenge_presented");
  const paymentConsent = await confirm("payment", { challenge, request, paymentPayer });
  requireValue(paymentConsent === true, "payment_not_confirmed", "Buyer declined the x402 payment");
  mark("payment_confirmed");

  const paid = await adapters.payAndRequestCard({ challenge, request, buyerWallet, paymentPayer });
  const paymentProof = await adapters.verifyPayment({ paid, challenge, paymentPayer, startedAt });
  mark("payment_verified", { transactionHash: paymentProof.transactionHash });

  let validated = await adapters.validateCard(paid.card, { trustedIssuers, now: now() });
  bindCardToRequest(validated, preview, request, buyerWallet);
  mark("signed_card_verified", { intentHash: validated.intentHash });

  const dryRun = await adapters.dryRun(validated.executionCard.argv);
  await adapters.validateDryRun(paid.card, dryRun, { trustedIssuers, now: now() });
  mark("dry_run_verified");

  emit({
    type: "trade_confirmation",
    bounds: {
      market: request.market,
      side: request.side,
      maxPrice: validated.bounds.maxPrice,
      maximumOrderPrincipalRaw: validated.bounds.maximumOrderPrincipalRaw,
      maximumFeeRaw: validated.bounds.maximumFeeRaw,
      maximumTotalDebitRaw: validated.bounds.maximumTotalDebitRaw,
      expiresAt: validated.expiresAt,
      wallet: validated.wallet,
    },
  });
  mark("bounds_presented");
  const tradeConsent = await confirm("trade", { request, validated, preview, dryRun });
  confirmationCount += 1;
  requireValue(tradeConsent === true, "trade_not_confirmed", "Buyer declined the bounded trade");
  const confirmed = mark("trade_confirmed");

  await adapters.ensureTradingMode({ buyerWallet });
  validated = await adapters.validateCard(paid.card, { trustedIssuers, now: now() });
  bindCardToRequest(validated, preview, request, buyerWallet);
  const finalReadiness = await adapters.checkReadiness({ paymentPayer, buyerWallet });
  requireReadiness(finalReadiness, paymentPayer, buyerWallet, validated.bounds.maximumTotalDebitRaw);
  const finalDryRun = await adapters.dryRun(validated.executionCard.argv);
  await adapters.validateDryRun(paid.card, finalDryRun, { trustedIssuers, now: now() });
  mark("pre_execution_verified");

  mark("execution_started");
  const liveResult = await adapters.execute(validated.executionCard.argv);
  ordersPlaced += 1;
  mark("order_submitted");
  const receiptRequest = await adapters.buildReceiptRequest(paid.card, liveResult, { trustedIssuers });
  const proofDocument = await adapters.fetchProof(receiptRequest);
  const proof = await adapters.validateProof(paid.card, proofDocument, { trustedIssuers });
  const proved = mark("position_proof_verified", { transactionHash: proof.transactionHash, positionProofHash: proof.positionProofHash });

  return {
    ok: true,
    mode: "open",
    paymentPayer,
    buyerWallet,
    paymentProof,
    intentHash: validated.intentHash,
    card: paid.card,
    orderId: proof.orderId,
    settlementTx: proof.transactionHash,
    positionProofHash: proof.positionProofHash,
    confirmation: { count: confirmationCount, confirmedAt: confirmed.at },
    ordersPlaced,
    events,
    timings: {
      startedAt,
      paidAt: events.find((event) => event.type === "payment_verified")?.at,
      confirmedAt: confirmed.at,
      provedAt: proved.at,
      wallMs: proved.at - startedAt,
    },
  };
}
