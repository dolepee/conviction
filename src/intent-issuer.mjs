import {
  createHash,
  createPrivateKey,
  createPublicKey,
  sign as signBytes,
  verify as verifyBytes,
} from "node:crypto";

import { canonicalJson, sha256 } from "./canonical.mjs";
import { invariant } from "./errors.mjs";

const INTENT_HASH_RE = /^0x[0-9a-f]{64}$/;
const KEY_ID_RE = /^[a-z0-9][a-z0-9._-]{2,63}$/;
const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;
const BASE64URL_RE = /^[A-Za-z0-9_-]+$/;

function configurationError(message, details = undefined) {
  const error = new Error(message);
  error.code = "issuer_configuration_error";
  error.details = details;
  return error;
}

function parseIso(value, label) {
  const text = String(value || "");
  const milliseconds = Date.parse(text);
  invariant(
    Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === text,
    "invalid_issuance",
    `${label} must be a canonical ISO timestamp`,
  );
  return milliseconds;
}

function strictBase64(value, label) {
  const text = String(value || "");
  if (!text || text !== text.trim() || !BASE64_RE.test(text)) {
    throw configurationError(`${label} must be unpadded or padded base64 without whitespace`);
  }
  const bytes = Buffer.from(text, "base64");
  if (!bytes.length || bytes.toString("base64").replace(/=+$/, "") !== text.replace(/=+$/, "")) {
    throw configurationError(`${label} is not canonical base64`);
  }
  return bytes;
}

function strictBase64Url(value, label) {
  const text = String(value || "");
  invariant(text.length > 0 && BASE64URL_RE.test(text), "invalid_issuance", `${label} is invalid`);
  const bytes = Buffer.from(text, "base64url");
  invariant(
    bytes.length > 0 && bytes.toString("base64url") === text,
    "invalid_issuance",
    `${label} is not canonical base64url`,
  );
  return bytes;
}

function normalizeKeyId(value, errorFactory = configurationError) {
  const keyId = String(value || "");
  if (!KEY_ID_RE.test(keyId)) {
    throw errorFactory("Issuer key ID must be 3 to 64 lowercase letters, numbers, dots, dashes, or underscores");
  }
  return keyId;
}

function publicRecord(keyId, publicKey) {
  const publicKeyObject = publicKey?.type === "public" ? publicKey : createPublicKey(publicKey);
  const publicKeyDer = publicKeyObject.export({ format: "der", type: "spki" });
  return Object.freeze({
    keyId,
    algorithm: "Ed25519",
    publicKeySpki: publicKeyDer.toString("base64"),
    fingerprint: `sha256:${createHash("sha256").update(publicKeyDer).digest("hex")}`,
  });
}

export function issuancePayload(issuance) {
  return {
    version: issuance?.version,
    keyId: issuance?.keyId,
    intentHash: issuance?.intentHash,
    issuedAt: issuance?.issuedAt,
    expiresAt: issuance?.expiresAt,
  };
}

export function createIntentIssuer({ keyId: keyIdValue, privateKey, now = Date.now }) {
  const keyId = normalizeKeyId(keyIdValue);
  let privateKeyObject;
  try {
    privateKeyObject = privateKey?.type === "private" ? privateKey : createPrivateKey(privateKey);
  } catch (cause) {
    throw configurationError("Issuer private key is not a valid PKCS#8 Ed25519 key", {
      cause: cause?.code,
    });
  }
  if (privateKeyObject.asymmetricKeyType !== "ed25519") {
    throw configurationError("Issuer private key must use Ed25519");
  }
  const issuer = publicRecord(keyId, privateKeyObject);

  function issue(compilation) {
    const intentHash = String(compilation?.intentHash || "").toLowerCase();
    invariant(INTENT_HASH_RE.test(intentHash), "invalid_intent_hash", "Compiled intent hash is invalid");
    invariant(
      sha256(compilation?.intent) === intentHash,
      "intent_hash_mismatch",
      "Compiled intent does not match its canonical hash",
    );
    const expiresAt = String(compilation?.executionCard?.expiresAt || "");
    invariant(
      expiresAt === compilation?.intent?.snapshot?.expiresAt,
      "invalid_issuance",
      "Execution-card and intent expiries disagree",
    );
    const issuedAt = new Date(now()).toISOString();
    const issuedAtMs = parseIso(issuedAt, "issuedAt");
    const expiresAtMs = parseIso(expiresAt, "expiresAt");
    const capturedAtMs = parseIso(compilation?.intent?.snapshot?.capturedAt, "capturedAt");
    invariant(issuedAtMs >= capturedAtMs, "invalid_issuance", "Intent cannot be issued before its market snapshot");
    invariant(issuedAtMs < expiresAtMs, "expired_intent", "Intent expired before it could be issued");

    const payload = {
      version: "conviction-issuance-v1",
      keyId,
      intentHash,
      issuedAt,
      expiresAt,
    };
    const signature = signBytes(null, Buffer.from(canonicalJson(payload)), privateKeyObject)
      .toString("base64url");
    return {
      ...compilation,
      issuance: {
        ...payload,
        algorithm: "Ed25519",
        publicKeyFingerprint: issuer.fingerprint,
        signature,
      },
    };
  }

  issue.issuer = issuer;
  return issue;
}

export function createEnvironmentIntentIssuer(environment, { now = Date.now } = {}) {
  const keyId = normalizeKeyId(environment?.CONVICTION_ISSUER_KEY_ID);
  const privateKeyDer = strictBase64(
    environment?.CONVICTION_ISSUER_PRIVATE_KEY_B64,
    "CONVICTION_ISSUER_PRIVATE_KEY_B64",
  );
  const issue = createIntentIssuer({
    keyId,
    privateKey: { key: privateKeyDer, format: "der", type: "pkcs8" },
    now,
  });
  const trusted = trustedIssuerRegistryFromEnvironment(environment).get(keyId);
  if (trusted?.record?.fingerprint !== issue.issuer.fingerprint) {
    throw configurationError("Issuer private key does not match the configured trusted public key", {
      keyId,
    });
  }
  return issue;
}

export function trustedIssuerRegistry(records) {
  const registry = new Map();
  for (const record of records || []) {
    const keyId = normalizeKeyId(record?.keyId, (message) => configurationError(message));
    if (registry.has(keyId)) throw configurationError(`Duplicate issuer key ID: ${keyId}`);
    let publicKey;
    try {
      publicKey = createPublicKey({
        key: strictBase64(record?.publicKeySpki, `Public key ${keyId}`),
        format: "der",
        type: "spki",
      });
    } catch (cause) {
      if (cause?.code === "issuer_configuration_error") throw cause;
      throw configurationError(`Issuer public key ${keyId} is invalid`, { cause: cause?.code });
    }
    if (publicKey.asymmetricKeyType !== "ed25519") {
      throw configurationError(`Issuer public key ${keyId} must use Ed25519`);
    }
    registry.set(keyId, { publicKey, record: publicRecord(keyId, publicKey) });
  }
  return registry;
}

export function trustedIssuerRegistryFromEnvironment(environment) {
  const keyId = normalizeKeyId(environment?.CONVICTION_ISSUER_KEY_ID);
  return trustedIssuerRegistry([{
    keyId,
    algorithm: "Ed25519",
    publicKeySpki: environment?.CONVICTION_ISSUER_PUBLIC_KEY_B64,
  }]);
}

export function verifyIntentIssuance({
  intent,
  intentHash: intentHashValue,
  issuance,
  trustedIssuers,
  settledAt,
}) {
  const intentHash = String(intentHashValue || "").toLowerCase();
  invariant(INTENT_HASH_RE.test(intentHash), "invalid_intent_hash", "Intent hash is invalid");
  invariant(sha256(intent) === intentHash, "intent_hash_mismatch", "Intent does not match its canonical hash");
  invariant(issuance?.version === "conviction-issuance-v1", "invalid_issuance", "Unsupported issuance version");
  invariant(issuance?.algorithm === "Ed25519", "invalid_issuance", "Unsupported issuance algorithm");
  const keyId = String(issuance?.keyId || "");
  invariant(KEY_ID_RE.test(keyId), "invalid_issuance", "Issuer key ID is invalid");
  invariant(issuance?.intentHash === intentHash, "issuance_intent_mismatch", "Issuance is for a different intent");
  invariant(
    issuance?.expiresAt === intent?.snapshot?.expiresAt,
    "issuance_expiry_mismatch",
    "Issuance and intent expiries disagree",
  );

  const trusted = trustedIssuers instanceof Map ? trustedIssuers.get(keyId) : undefined;
  invariant(trusted?.publicKey, "untrusted_issuer", "Intent issuer is not trusted", { keyId });
  invariant(
    issuance?.publicKeyFingerprint === trusted.record.fingerprint,
    "untrusted_issuer",
    "Issuer fingerprint does not match the trusted key",
    { keyId },
  );
  const signature = strictBase64Url(issuance?.signature, "Issuance signature");
  invariant(
    verifyBytes(
      null,
      Buffer.from(canonicalJson(issuancePayload(issuance))),
      trusted.publicKey,
      signature,
    ),
    "invalid_issuance_signature",
    "Intent issuance signature is invalid",
  );

  const issuedAtMs = parseIso(issuance.issuedAt, "issuedAt");
  const expiresAtMs = parseIso(issuance.expiresAt, "expiresAt");
  const capturedAtMs = parseIso(intent?.snapshot?.capturedAt, "capturedAt");
  const settledAtMs = parseIso(settledAt, "settledAt");
  invariant(issuedAtMs >= capturedAtMs && issuedAtMs < expiresAtMs, "invalid_issuance_window", "Issuance window is invalid");
  invariant(
    settledAtMs >= issuedAtMs && settledAtMs <= expiresAtMs,
    "settlement_outside_intent_window",
    "Settlement did not occur inside the signed intent window",
    { issuedAt: issuance.issuedAt, settledAt, expiresAt: issuance.expiresAt },
  );
  return {
    ok: true,
    keyId,
    fingerprint: trusted.record.fingerprint,
    issuedAt: issuance.issuedAt,
    expiresAt: issuance.expiresAt,
    settledAt,
  };
}
