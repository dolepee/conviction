const ADDRESS_RE = /^0x[0-9a-f]{40}$/i;
const HASH_RE = /^0x[0-9a-f]{64}$/i;
const SERVICE_NETWORK = "eip155:196";
const SERVICE_ASSET = "0x779ded0c9e1022225f8e0630b35a9b54be713736";
const SERVICE_PAYEE = "0x4abbae03afff90f50d4f6b42b3e362f5228ad4c7";
const SERVICE_AMOUNT = "50000";
const AUTHORIZATION_TYPES = {
  TransferWithAuthorization: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
};

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function canonicalDecimal(value, label) {
  const text = String(value || "").trim();
  assert(/^(?:0|[1-9][0-9]*)(?:\.[0-9]{1,6})?$/.test(text), `${label} must be a decimal with at most six places.`);
  const [whole, fraction = ""] = text.split(".");
  const trimmed = fraction.replace(/0+$/, "");
  return trimmed ? `${whole}.${trimmed}` : whole;
}

function base64Encode(value) {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function base64Decode(value) {
  const binary = atob(value);
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

function headerJson(getHeader, name) {
  const encoded = getHeader(name);
  assert(typeof encoded === "string" && /^[A-Za-z0-9+/]*={0,2}$/.test(encoded), `${name} header is missing or invalid.`);
  return JSON.parse(base64Decode(encoded));
}

function randomNonce() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return `0x${[...bytes].map((value) => value.toString(16).padStart(2, "0")).join("")}`;
}

export function createBrowserX402Client({ signer, now = () => Math.floor(Date.now() / 1_000) }) {
  assert(ADDRESS_RE.test(String(signer?.address || "")), "X Layer payment signer is invalid.");
  assert(typeof signer?.signTypedData === "function", "X Layer payment signer cannot sign typed data.");
  return Object.freeze({
    getPaymentRequiredResponse(getHeader) {
      return headerJson(getHeader, "PAYMENT-REQUIRED");
    },
    getPaymentSettleResponse(getHeader) {
      return headerJson(getHeader, "PAYMENT-RESPONSE");
    },
    encodePaymentSignatureHeader(paymentPayload) {
      return { "PAYMENT-SIGNATURE": base64Encode(JSON.stringify(paymentPayload)) };
    },
    async createPaymentPayload(paymentRequired) {
      assert(paymentRequired?.x402Version === 2, "Unsupported x402 version.");
      assert(Array.isArray(paymentRequired.accepts) && paymentRequired.accepts.length === 1, "Expected one exact payment option.");
      const accepted = paymentRequired.accepts[0];
      assert(accepted.scheme === "exact", "Payment scheme is not exact.");
      assert(accepted.network === SERVICE_NETWORK, "Payment challenge is not on X Layer.");
      assert(String(accepted.asset || "").toLowerCase() === SERVICE_ASSET, "Payment challenge asset is not USD₮0.");
      assert(String(accepted.payTo || "").toLowerCase() === SERVICE_PAYEE, "Payment challenge recipient is not Conviction.");
      assert(accepted.amount === SERVICE_AMOUNT, "Payment challenge amount is not exactly 0.05 USD₮0.");
      assert((accepted.extra?.assetTransferMethod ?? "eip3009") === "eip3009", "Payment challenge is not EIP-3009.");
      assert(accepted.extra?.name && accepted.extra?.version, "USD₮0 signing domain is missing.");
      const timestamp = now();
      const authorization = {
        from: signer.address.toLowerCase(),
        to: SERVICE_PAYEE,
        value: SERVICE_AMOUNT,
        validAfter: String(timestamp - 5),
        validBefore: String(timestamp + Number(accepted.maxTimeoutSeconds)),
        nonce: randomNonce(),
      };
      const signature = await signer.signTypedData({
        domain: {
          name: accepted.extra.name,
          version: accepted.extra.version,
          chainId: 196,
          verifyingContract: SERVICE_ASSET,
        },
        types: AUTHORIZATION_TYPES,
        primaryType: "TransferWithAuthorization",
        message: {
          ...authorization,
          value: BigInt(authorization.value),
          validAfter: BigInt(authorization.validAfter),
          validBefore: BigInt(authorization.validBefore),
        },
      });
      return {
        x402Version: 2,
        payload: { authorization, signature },
        extensions: paymentRequired.extensions,
        resource: paymentRequired.resource,
        accepted,
      };
    },
  });
}

export function browserReadiness({ owner, depositWallet }) {
  const normalizedOwner = String(owner || "").toLowerCase();
  const normalizedWallet = String(depositWallet || "").toLowerCase();
  assert(ADDRESS_RE.test(normalizedOwner), "Buyer owner address is invalid.");
  assert(ADDRESS_RE.test(normalizedWallet), "Deposit Wallet address is invalid.");
  return Object.freeze({
    ok: true,
    version: "conviction-browser-wallet-readiness-v1",
    status: "ready",
    owner: normalizedOwner,
    depositWallet: normalizedWallet,
  });
}

export function browserOpenRequest({
  market,
  outcome,
  spend,
  maxPrice,
  owner,
  depositWallet,
  rationale = "",
}) {
  const readiness = browserReadiness({ owner, depositWallet });
  return Object.freeze({
    market: String(market || "").trim(),
    outcome: String(outcome || "").trim().toUpperCase(),
    spend: canonicalDecimal(spend, "Total budget"),
    maxPrice: canonicalDecimal(maxPrice, "Maximum price"),
    wallet: readiness.depositWallet,
    executionMode: "browser-deposit-wallet",
    browserWalletReadiness: readiness,
    ...(String(rationale || "").trim() ? { rationale: String(rationale).trim() } : {}),
  });
}

export function verifyBrowserCard(card, request) {
  const intent = card?.intent;
  const order = intent?.order;
  assert(card?.ok === true, "Conviction did not return a successful card.");
  assert(intent?.version === "conviction-intent-v4", "Conviction did not return a signed v4 intent.");
  assert(card?.issuance?.version === "conviction-issuance-v1", "Conviction card has no issuer signature.");
  assert(intent?.buyer?.wallet === request.wallet, "Card is bound to another Deposit Wallet.");
  assert(
    intent?.buyer?.executionMode === "browser-deposit-wallet",
    "Card is not bound to Conviction's browser execution route.",
  );
  assert(order?.side === "BUY" && order?.orderType === "FAK", "Card is not a bounded FAK BUY.");
  assert(order?.outcome === request.outcome, "Card outcome differs from the buyer request.");
  assert(order?.maxPrice === request.maxPrice, "Card increased or changed the buyer's price cap.");
  assert(order?.requestedBudget === request.spend, "Card changed the buyer's total budget.");
  assert(Date.parse(card.issuance.expiresAt) > Date.now(), "Conviction card expired before trade confirmation.");
  return Object.freeze({
    tokenId: intent.market.outcomeTokenId,
    conditionId: intent.market.conditionId,
    outcome: order.outcome,
    principal: order.maximumOrderPrincipal,
    maxSpend: order.maximumTotalDebit,
    maxPrice: order.maxPrice,
    expiresAt: card.issuance.expiresAt,
  });
}

export async function buyCardWithX402({
  endpoint = "/api/service",
  request,
  fetchImpl = fetch,
  httpClient,
}) {
  const headers = { "content-type": "application/json", accept: "application/json" };
  const body = JSON.stringify(request);
  const challengeResponse = await fetchImpl(endpoint, { method: "POST", headers, body });
  assert(challengeResponse.status === 402, `Expected x402 payment challenge, received HTTP ${challengeResponse.status}.`);
  const paymentRequired = httpClient.getPaymentRequiredResponse(
    (name) => challengeResponse.headers.get(name),
  );
  const accepted = paymentRequired?.accepts?.[0];
  assert(accepted?.network === SERVICE_NETWORK, "Payment challenge is not on X Layer.");
  assert(accepted?.amount === SERVICE_AMOUNT, "Payment challenge amount is not exactly 0.05 USD₮0.");
  const paymentPayload = await httpClient.createPaymentPayload(paymentRequired);
  const paidResponse = await fetchImpl(endpoint, {
    method: "POST",
    headers: {
      ...headers,
      ...httpClient.encodePaymentSignatureHeader(paymentPayload),
    },
    body,
  });
  const payload = await paidResponse.json().catch(() => null);
  assert(paidResponse.ok, payload?.error?.message || `Paid request failed with HTTP ${paidResponse.status}.`);
  const settlement = httpClient.getPaymentSettleResponse(
    (name) => paidResponse.headers.get(name),
  );
  assert(HASH_RE.test(String(settlement?.transaction || "")), "Payment settlement hash is missing.");
  return Object.freeze({
    card: payload,
    payment: Object.freeze({
      transactionHash: settlement.transaction.toLowerCase(),
      network: accepted.network,
      amount: accepted.amount,
    }),
  });
}

export function marketOrderFromCard(card, request) {
  const bound = verifyBrowserCard(card, request);
  return Object.freeze({
    tokenId: bound.tokenId,
    side: "BUY",
    amount: bound.principal,
    maxSpend: bound.maxSpend,
    maxPrice: bound.maxPrice,
    orderType: "FAK",
  });
}

export function settlementFromOrder(response) {
  assert(response?.ok === true, response?.message || "Polymarket rejected the order.");
  const hashes = Array.isArray(response.transactionsHashes) ? response.transactionsHashes : [];
  const transactionHash = hashes.findLast((value) => HASH_RE.test(String(value || "")));
  assert(transactionHash, "Polymarket accepted the order without a settlement transaction hash.");
  assert(typeof response.orderId === "string" && response.orderId.length > 0, "Polymarket order ID is missing.");
  return Object.freeze({
    orderId: response.orderId,
    transactionHash: transactionHash.toLowerCase(),
    status: response.status,
  });
}

export async function verifyBrowserSettlement({
  card,
  settlement,
  fetchImpl = fetch,
}) {
  const response = await fetchImpl("/api/receipt", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({
      transactionHash: settlement.transactionHash,
      orderId: settlement.orderId,
      intent: card.intent,
      intentHash: card.intentHash,
      issuance: card.issuance,
    }),
  });
  const payload = await response.json().catch(() => null);
  assert(response.ok, payload?.error?.message || "Conviction could not verify the Polygon fill.");
  assert(payload?.assurance === "issuer-signed", "Position proof is not issuer-signed.");
  assert(HASH_RE.test(String(payload?.positionProofHash || "")), "Position proof hash is missing.");
  return payload;
}
