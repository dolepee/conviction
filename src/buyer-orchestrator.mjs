import { parseDecimal } from "./decimal.mjs";

const ADDRESS_RE = /^0x[0-9a-f]{40}$/i;
const TRADE_CONFIRMATION_HEADROOM_MS = 30_000;
const EXECUTION_HEADROOM_MS = 15_000;

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

function normalizeCloseRequest(request) {
  const market = String(request?.market || "").trim();
  const outcome = String(request?.outcome || request?.side || "").toUpperCase();
  const shares = String(request?.shares || "");
  const minPrice = String(request?.minPrice || "");
  requireValue(market, "invalid_request", "Market is required");
  requireValue(outcome === "YES" || outcome === "NO", "invalid_request", "Outcome must be YES or NO");
  const sharesRaw = parseDecimal(shares, 6, "shares");
  const minPriceRaw = parseDecimal(minPrice, 6, "minPrice");
  requireValue(sharesRaw > 0n && sharesRaw % 1_000_000n === 0n, "invalid_request", "CLOSE shares must be positive whole shares");
  requireValue(minPriceRaw > 0n && minPriceRaw < 1_000_000n, "invalid_request", "Minimum price must be between zero and one");
  const sourcePosition = request?.sourcePosition;
  requireValue(sourcePosition && typeof sourcePosition === "object", "invalid_request", "A verified source position is required");
  const source = Object.freeze({
    intentHash: lower(sourcePosition.intentHash),
    positionProofHash: lower(sourcePosition.positionProofHash),
    transactionHash: lower(sourcePosition.transactionHash),
    orderId: lower(sourcePosition.orderId),
  });
  for (const [field, value] of Object.entries(source)) {
    requireValue(/^0x[0-9a-f]{64}$/.test(value), "invalid_request", `Source ${field} is invalid`);
  }
  requireValue(sourcePosition.intent && typeof sourcePosition.intent === "object", "invalid_request", "Source canonical intent is required");
  return Object.freeze({
    market,
    outcome,
    shares,
    minPrice,
    sharesRaw,
    minPriceRaw,
    rationale: String(request?.rationale || ""),
    sourcePosition,
    source,
  });
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

export function bindCloseCardToRequest(validated, previewInput, request, sellerWallet) {
  const preview = previewInput?.preview || previewInput;
  const intent = validated?.intent;
  requireValue(intent && validated?.bounds && preview?.market && preview?.source, "invalid_card", "Validated CLOSE card or preview is incomplete");
  requireValue(validated.wallet === sellerWallet, "wallet_substitution", "CLOSE card seller differs from the active deposit wallet");
  requireValue(validated.outcome === request.outcome, "outcome_substitution", "CLOSE card outcome differs from the request");
  requireValue(lower(intent.market.conditionId) === lower(preview.market.conditionId), "market_substitution", "CLOSE card condition differs from the free preview");
  requireValue(String(validated.tokenId) === String(preview.market.outcomeTokenId), "token_substitution", "CLOSE card token differs from the free preview");
  requireValue(BigInt(validated.bounds.sharesRaw) === request.sharesRaw, "shares_substitution", "CLOSE card shares differ from the request");
  requireValue(parseDecimal(validated.bounds.minPrice, 6, "card minimum price") === request.minPriceRaw, "price_substitution", "CLOSE card minimum price differs from the request");
  for (const field of ["intentHash", "positionProofHash", "transactionHash", "orderId"]) {
    requireValue(
      lower(intent.source?.[field]) === request.source[field] && lower(preview.source?.[field]) === request.source[field],
      "source_substitution",
      `CLOSE card ${field} differs from the selected source position`,
    );
  }
  requireValue(
    lower(preview.source.wallet) === sellerWallet &&
      lower(preview.source.marketConditionId) === lower(preview.market.conditionId) &&
      preview.source.outcome === request.outcome &&
      String(preview.source.outcomeTokenId) === validated.tokenId,
    "source_substitution",
    "Free preview source identity differs from the CLOSE request",
  );
}

function requireCloseReadiness(readiness, paymentPayer, sellerWallet, tokenId, sharesRaw) {
  requireReadiness(readiness, paymentPayer, sellerWallet);
  requireValue(String(readiness?.outcomeTokenId || "") === String(tokenId), "token_substitution", "Readiness snapshot is for another outcome token");
  const balanceRaw = BigInt(readiness?.outcomeBalanceRaw ?? -1);
  const reservedRaw = BigInt(readiness?.reservedSharesRaw ?? -1);
  requireValue(readiness?.approvedForExchange === true, "ctf_approval_missing", "Deposit wallet has no standard V2 outcome-token approval");
  requireValue(reservedRaw === 0n, "position_reserved", "Outcome shares are reserved by another open SELL order");
  requireValue(Number(readiness?.openSellOrderCount) === 0, "position_reserved", "Another open SELL order exists for this outcome token");
  requireValue(balanceRaw >= sharesRaw, "insufficient_position", "Deposit wallet no longer holds the exact CLOSE shares");
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
    sourcePosition: {
      transactionHash: proof.transactionHash,
      orderId: proof.orderId,
      intentHash: validated.intentHash,
      intent: validated.intent,
      issuance: validated.issuance,
      positionProofHash: proof.positionProofHash,
    },
    confirmation: { count: confirmationCount, confirmedAt: confirmed.at },
    ordersPlaced,
    events,
    timings: {
      startedAt,
      paidAt: events.find((event) => event.type === "payment_verified")?.at,
      confirmedAt: confirmed.at,
      provedAt: proved.at,
      wallMs: proved.at - startedAt,
      paymentToProofMs: proved.at - events.find((event) => event.type === "payment_verified").at,
    },
  };
}

export async function runCloseJourney({
  request: rawRequest,
  paymentPayer: paymentPayerValue,
  sellerWallet: sellerWalletValue,
  trustedIssuers,
  adapters,
  confirm,
  emit = () => {},
  now = Date.now,
}) {
  const request = normalizeCloseRequest(rawRequest);
  const paymentPayer = requireWallet(paymentPayerValue, "Payment payer");
  const sellerWallet = requireWallet(sellerWalletValue, "Seller wallet");
  requireValue(typeof confirm === "function", "confirmation_required", "Confirmation handler is required");
  for (const name of [
    "ensureTradingMode", "checkReadiness", "previewClose", "requestPaymentChallenge", "payAndRequestCard",
    "verifyPayment", "validateCloseCard", "dryRun", "validateCloseDryRun", "checkCloseReadiness", "execute",
    "buildCloseReceiptRequest", "fetchCloseProof", "validateCloseProof",
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

  await adapters.ensureTradingMode({ sellerWallet });
  const initialReadiness = await adapters.checkReadiness({ paymentPayer, buyerWallet: sellerWallet });
  requireReadiness(initialReadiness, paymentPayer, sellerWallet);
  mark("readiness_verified");

  const preview = await adapters.previewClose({
    market: request.market,
    outcome: request.outcome,
    shares: request.shares,
    minPrice: request.minPrice,
    wallet: sellerWallet,
    rationale: request.rationale,
    sourcePosition: request.sourcePosition,
  });
  requireValue(preview?.preview?.market?.conditionId && preview?.preview?.market?.outcomeTokenId, "invalid_preview", "Free CLOSE preview did not resolve a market and token");
  requireValue(preview.preview.action === "CLOSE" && preview.preview.executable === false, "invalid_preview", "Free CLOSE preview must be non-executable");
  requireValue(BigInt(preview.preview.order?.sharesRaw ?? -1) === request.sharesRaw, "shares_substitution", "Free CLOSE preview changed the requested shares");
  requireValue(parseDecimal(preview.preview.order?.minPrice, 6, "preview minimum price") === request.minPriceRaw, "price_substitution", "Free CLOSE preview changed the minimum price");
  mark("close_previewed", {
    conditionId: lower(preview.preview.market.conditionId),
    outcomeTokenId: String(preview.preview.market.outcomeTokenId),
  });

  const prePaymentPosition = await adapters.checkCloseReadiness({
    paymentPayer,
    sellerWallet,
    outcomeTokenId: preview.preview.market.outcomeTokenId,
    sharesRaw: request.sharesRaw.toString(),
  });
  requireCloseReadiness(
    prePaymentPosition,
    paymentPayer,
    sellerWallet,
    preview.preview.market.outcomeTokenId,
    request.sharesRaw,
  );
  mark("pre_payment_position_verified");

  const challenge = await adapters.requestPaymentChallenge({ request, sellerWallet });
  emit({
    type: "payment_confirmation",
    challenge,
    request: { market: request.market, outcome: request.outcome, shares: request.shares, minPrice: request.minPrice },
  });
  mark("payment_challenge_presented");
  const paymentConsent = await confirm("payment", { challenge, request, paymentPayer });
  requireValue(paymentConsent === true, "payment_not_confirmed", "Buyer declined the x402 manager payment");
  mark("payment_confirmed");

  const paid = await adapters.payAndRequestCard({
    challenge,
    request: {
      market: request.market,
      outcome: request.outcome,
      shares: request.shares,
      minPrice: request.minPrice,
      rationale: request.rationale,
      sourcePosition: request.sourcePosition,
    },
    sellerWallet,
    paymentPayer,
  });
  const paymentProof = await adapters.verifyPayment({ paid, challenge, paymentPayer, startedAt });
  mark("payment_verified", { transactionHash: paymentProof.transactionHash });

  let validated = await adapters.validateCloseCard(paid.card, { trustedIssuers, now: now() });
  bindCloseCardToRequest(validated, preview, request, sellerWallet);
  mark("signed_close_card_verified", { intentHash: validated.intentHash });

  const dryRun = await adapters.dryRun(validated.executionCard.argv);
  await adapters.validateCloseDryRun(paid.card, dryRun, { trustedIssuers, now: now() });
  mark("close_dry_run_verified");

  emit({
    type: "trade_confirmation",
    bounds: {
      market: request.market,
      marketQuestion: validated.intent.market.question,
      conditionId: lower(validated.intent.market.conditionId),
      outcome: request.outcome,
      outcomeTokenId: validated.tokenId,
      exactShares: request.shares,
      minPrice: validated.bounds.minPrice,
      minimumGrossProceedsRaw: validated.bounds.minimumGrossProceedsRaw,
      maximumFeeRaw: validated.bounds.maximumFeeRaw,
      minimumNetProceedsRaw: validated.bounds.minimumNetProceedsRaw,
      feeAndNetEnforcement: "post-settlement-verification-only",
      expiresAt: validated.expiresAt,
      wallet: validated.wallet,
      sourceIntentHash: validated.intent.source.intentHash,
      sourcePositionProofHash: validated.intent.source.positionProofHash,
      issuerKeyId: validated.issuanceVerification.keyId,
      issuerFingerprint: validated.issuanceVerification.fingerprint,
      issuedAt: validated.issuanceVerification.issuedAt,
      completedPayment: {
        transactionHash: paymentProof.transactionHash,
        amountAtomic: challenge?.decoded?.accepts?.[0]?.amount ?? challenge?.amount,
        resource: challenge?.decoded?.resource?.url,
        network: challenge?.decoded?.accepts?.[0]?.network,
        asset: challenge?.decoded?.accepts?.[0]?.asset,
        payer: paymentPayer,
        payee: challenge?.decoded?.accepts?.[0]?.payTo,
      },
    },
  });
  mark("bounds_presented");
  requireValue(
    Date.parse(validated.expiresAt) - now() >= TRADE_CONFIRMATION_HEADROOM_MS,
    "insufficient_execution_window",
    "Signed CLOSE card has too little time remaining for a safe confirmation",
  );
  const tradeConsent = await confirm("trade", { request, validated, preview, dryRun });
  confirmationCount += 1;
  requireValue(tradeConsent === true, "trade_not_confirmed", "Buyer declined the bounded CLOSE");
  const confirmed = mark("trade_confirmed");

  await adapters.ensureTradingMode({ sellerWallet });
  validated = await adapters.validateCloseCard(paid.card, { trustedIssuers, now: now() });
  requireValue(
    Date.parse(validated.expiresAt) - now() >= EXECUTION_HEADROOM_MS,
    "insufficient_execution_window",
    "Signed CLOSE card has too little time remaining for safe submission",
  );
  bindCloseCardToRequest(validated, preview, request, sellerWallet);
  const finalReadiness = await adapters.checkCloseReadiness({
    paymentPayer,
    sellerWallet,
    outcomeTokenId: validated.tokenId,
    sharesRaw: validated.bounds.sharesRaw,
  });
  requireCloseReadiness(finalReadiness, paymentPayer, sellerWallet, validated.tokenId, BigInt(validated.bounds.sharesRaw));
  const finalDryRun = await adapters.dryRun(validated.executionCard.argv);
  await adapters.validateCloseDryRun(paid.card, finalDryRun, { trustedIssuers, now: now() });
  mark("pre_execution_verified");

  mark("execution_started");
  const liveResult = await adapters.execute(validated.executionCard.argv);
  ordersPlaced += 1;
  mark("close_submitted");
  const receiptRequest = await adapters.buildCloseReceiptRequest(paid.card, liveResult, { trustedIssuers });
  const proofDocument = await adapters.fetchCloseProof(receiptRequest);
  const proof = await adapters.validateCloseProof(paid.card, proofDocument, {
    trustedIssuers,
    expectedReceiptRequest: receiptRequest,
  });
  requireValue(
    Date.parse(proof.settledAt) >= Math.floor(confirmed.at / 1_000) * 1_000,
    "settlement_before_confirmation",
    "Verified CLOSE settlement predates the buyer's live-trade confirmation",
  );
  const proved = mark("close_proof_verified", { transactionHash: proof.transactionHash, closeProofHash: proof.closeProofHash });

  return {
    ok: true,
    mode: "close",
    paymentPayer,
    sellerWallet,
    paymentProof,
    intentHash: validated.intentHash,
    sourceIntentHash: validated.intent.source.intentHash,
    sourcePositionProofHash: validated.intent.source.positionProofHash,
    card: paid.card,
    orderId: proof.orderId,
    settlementTx: proof.transactionHash,
    closeProofHash: proof.closeProofHash,
    closePassportHash: proof.closePassportHash,
    confirmation: { count: confirmationCount, confirmedAt: confirmed.at },
    ordersPlaced,
    events,
    timings: {
      startedAt,
      paidAt: events.find((event) => event.type === "payment_verified")?.at,
      confirmedAt: confirmed.at,
      provedAt: proved.at,
      wallMs: proved.at - startedAt,
      paymentToProofMs: proved.at - events.find((event) => event.type === "payment_verified").at,
    },
  };
}
