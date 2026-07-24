import { BuilderConfig } from "@polymarket/builder-signing-sdk";

import {
  BuilderGuardError,
  RELAYER_SUBMIT_PATH,
  validateBuilderRequest,
} from "./polymarket-builder-guard.mjs";

export const POLYMARKET_RELAYER_ORIGIN = "https://relayer-v2.polymarket.com";
const MAX_RELAYER_RESPONSE_BYTES = 64_000;
const RELAYER_TRANSACTION_PATH = "/transaction";
const RELAYER_STATES = new Set([
  "STATE_NEW",
  "STATE_EXECUTED",
  "STATE_MINED",
  "STATE_CONFIRMED",
  "STATE_INVALID",
  "STATE_FAILED",
]);
const TRANSACTION_ID_RE = /^[A-Za-z0-9._:-]{1,191}$/;
const HASH_RE = /^0x[0-9a-fA-F]{64}$/;
const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

function builderConfigFromCredentials(credentials) {
  if (!credentials) return undefined;
  if (
    typeof credentials.key !== "string" ||
    credentials.key.trim().length === 0 ||
    typeof credentials.secret !== "string" ||
    credentials.secret.trim().length === 0 ||
    typeof credentials.passphrase !== "string" ||
    credentials.passphrase.trim().length === 0
  ) {
    return undefined;
  }
  return new BuilderConfig({ localBuilderCreds: credentials });
}

function relayerHeaders(credentials) {
  if (!credentials) return undefined;
  if (
    typeof credentials.key !== "string" ||
    credentials.key.trim().length === 0 ||
    typeof credentials.address !== "string" ||
    !ADDRESS_RE.test(credentials.address)
  ) {
    throw new TypeError("invalid relayer credentials");
  }
  return Object.freeze({
    RELAYER_API_KEY: credentials.key.trim(),
    RELAYER_API_KEY_ADDRESS: credentials.address.toLowerCase(),
  });
}

function transactionId(value) {
  if (typeof value !== "string" || !TRANSACTION_ID_RE.test(value)) {
    throw new BuilderGuardError(502, "invalid_relayer_response", "Polymarket relayer returned an invalid transaction identifier");
  }
  return value;
}

function optionalAddress(value) {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string" || !ADDRESS_RE.test(value)) {
    throw new BuilderGuardError(502, "invalid_relayer_response", "Polymarket relayer returned an invalid address");
  }
  return value.toLowerCase();
}

function optionalHash(value) {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string" || !HASH_RE.test(value)) {
    throw new BuilderGuardError(502, "invalid_relayer_response", "Polymarket relayer returned an invalid transaction hash");
  }
  return value.toLowerCase();
}

function rawRecord(value, expectedId = undefined) {
  const candidates = Array.isArray(value)
    ? value
    : Array.isArray(value?.transactions)
      ? value.transactions
      : [value];
  const record = candidates.find((candidate) => (
    candidate && typeof candidate === "object" &&
    (expectedId === undefined || candidate.transactionID === expectedId || candidate.transactionId === expectedId)
  ));
  if (!record || typeof record !== "object") {
    throw new BuilderGuardError(502, "invalid_relayer_response", "Polymarket relayer did not return the requested transaction");
  }
  return record;
}

function publicTransaction(value, expectedId = undefined) {
  const record = rawRecord(value, expectedId);
  const id = transactionId(record.transactionID ?? record.transactionId);
  if (expectedId !== undefined && id !== expectedId) {
    throw new BuilderGuardError(502, "relayer_transaction_mismatch", "Polymarket relayer returned another transaction");
  }
  const state = String(record.state || "");
  if (!RELAYER_STATES.has(state)) {
    throw new BuilderGuardError(502, "invalid_relayer_response", "Polymarket relayer returned an invalid transaction state");
  }
  const type = record.type === undefined || record.type === null || record.type === ""
    ? undefined
    : String(record.type);
  return Object.freeze({
    transactionId: id,
    state,
    transactionHash: optionalHash(record.transactionHash ?? record.hash),
    from: optionalAddress(record.from),
    to: optionalAddress(record.to),
    proxyAddress: optionalAddress(record.proxyAddress ?? record.walletAddress),
    type,
  });
}

async function boundedJson(response) {
  const contentLength = Number(response.headers?.get?.("content-length") || "0");
  if (Number.isFinite(contentLength) && contentLength > MAX_RELAYER_RESPONSE_BYTES) {
    throw new BuilderGuardError(502, "relayer_response_too_large", "Polymarket relayer response exceeded the safety limit");
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > MAX_RELAYER_RESPONSE_BYTES) {
    throw new BuilderGuardError(502, "relayer_response_too_large", "Polymarket relayer response exceeded the safety limit");
  }
  const text = new TextDecoder().decode(bytes);
  let body;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    throw new BuilderGuardError(502, "invalid_relayer_response", "Polymarket relayer returned invalid JSON");
  }
  if (!response.ok) {
    throw new BuilderGuardError(
      response.status >= 400 && response.status < 500 ? 422 : 502,
      "relayer_request_failed",
      typeof body?.error === "string" ? body.error : "Polymarket relayer rejected the setup request",
    );
  }
  return body;
}

export function createPolymarketRelayerProxy({
  credentials,
  relayerCredentials,
  fetchImpl = fetch,
  validate = validateBuilderRequest,
  nowSeconds = () => Math.floor(Date.now() / 1_000),
  origin = POLYMARKET_RELAYER_ORIGIN,
} = {}) {
  if (origin !== POLYMARKET_RELAYER_ORIGIN) {
    throw new TypeError("Polymarket relayer origin is immutable");
  }
  if (typeof fetchImpl !== "function" || typeof nowSeconds !== "function") {
    throw new TypeError("fetchImpl and nowSeconds must be functions");
  }
  const builderConfig = builderConfigFromCredentials(credentials);
  const fixedRelayerHeaders = relayerHeaders(relayerCredentials);
  if (!builderConfig && !fixedRelayerHeaders) {
    throw new TypeError("relayer authentication is required");
  }

  async function request(path, options = {}) {
    const response = await fetchImpl(`${POLYMARKET_RELAYER_ORIGIN}${path}`, {
      ...options,
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
    });
    return boundedJson(response);
  }

  async function run({ operation, session, body }) {
    if (operation === "nonce") {
      const query = new URLSearchParams({ address: session.wallet, type: "WALLET" });
      return {
        ok: true,
        operation,
        relayer: await request(`/nonce?${query}`),
      };
    }
    if (operation === "transaction") {
      const id = transactionId(body?.transactionId);
      const query = new URLSearchParams({ id });
      const relayer = publicTransaction(await request(`${RELAYER_TRANSACTION_PATH}?${query}`), id);
      return { ok: true, operation, relayer };
    }
    if (operation !== "submit") {
      throw new BuilderGuardError(422, "unsupported_relayer_operation", "Relayer operation must be nonce, transaction, or submit");
    }
    if (typeof body?.request !== "string" || Buffer.byteLength(body.request, "utf8") > 24_000) {
      throw new BuilderGuardError(422, "invalid_builder_body", "Relayer request must be a bounded JSON string");
    }
    let requestBody;
    try {
      requestBody = JSON.parse(body.request);
    } catch {
      throw new BuilderGuardError(422, "invalid_builder_body", "Relayer request must be valid JSON");
    }
    if (body.request !== JSON.stringify(requestBody)) {
      throw new BuilderGuardError(
        422,
        "noncanonical_builder_body",
        "Relayer request must use the exact canonical JSON serialization",
      );
    }
    const validated = await validate({
      method: "POST",
      path: RELAYER_SUBMIT_PATH,
      body: requestBody,
      session,
      nowSeconds: nowSeconds(),
    });
    const timestamp = nowSeconds();
    const authenticationHeaders = fixedRelayerHeaders || await builderConfig.generateBuilderHeaders(
      "POST",
      RELAYER_SUBMIT_PATH,
      body.request,
      timestamp,
    );
    if (!authenticationHeaders) throw new Error("Relayer credentials are unavailable");
    const relayer = await request(RELAYER_SUBMIT_PATH, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...authenticationHeaders,
      },
      body: body.request,
    });
    return {
      ok: true,
      operation,
      action: validated.action,
      wallet: session.wallet,
      relayer: publicTransaction(relayer),
    };
  }

  return Object.freeze({ run });
}
