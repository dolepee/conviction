import {
  createHmac,
  randomBytes as nodeRandomBytes,
  timingSafeEqual,
} from "node:crypto";

import { getAddress, verifyMessage } from "viem";

import { DEPOSIT_WALLET_FACTORY } from "./polymarket-builder-guard.mjs";
import { createInMemoryWalletSetupState } from "./wallet-setup-state.mjs";

export const WALLET_SESSION_VERSION = "conviction-wallet-session-v2";
export const WALLET_SESSION_PURPOSE = "Polymarket deposit-wallet setup";

export class WalletSetupAuthError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = "WalletSetupAuthError";
    this.status = status;
    this.code = code;
  }
}

function b64url(value) {
  return Buffer.from(value).toString("base64url");
}

function unb64url(value) {
  return Buffer.from(value, "base64url");
}

function sign(encodedPayload, secret) {
  return createHmac("sha256", secret).update(encodedPayload).digest();
}

function constantTimeEqual(left, right) {
  return left.length === right.length && timingSafeEqual(left, right);
}

function token(payload, secret) {
  const encodedPayload = b64url(JSON.stringify(payload));
  return `${encodedPayload}.${b64url(sign(encodedPayload, secret))}`;
}

function verifyToken(value, secret, expectedType, nowSeconds) {
  if (typeof value !== "string" || value.length > 4_096) {
    throw new WalletSetupAuthError(401, "invalid_wallet_session", "Wallet session token is invalid");
  }
  const parts = value.split(".");
  if (parts.length !== 2) {
    throw new WalletSetupAuthError(401, "invalid_wallet_session", "Wallet session token is invalid");
  }
  const [encodedPayload, encodedSignature] = parts;
  const expectedSignature = sign(encodedPayload, secret);
  let suppliedSignature;
  try {
    suppliedSignature = unb64url(encodedSignature);
  } catch {
    throw new WalletSetupAuthError(401, "invalid_wallet_session", "Wallet session token is invalid");
  }
  if (!constantTimeEqual(expectedSignature, suppliedSignature)) {
    throw new WalletSetupAuthError(401, "invalid_wallet_session", "Wallet session token is invalid");
  }
  let payload;
  try {
    payload = JSON.parse(unb64url(encodedPayload).toString("utf8"));
  } catch {
    throw new WalletSetupAuthError(401, "invalid_wallet_session", "Wallet session token is invalid");
  }
  if (
    payload?.version !== WALLET_SESSION_VERSION ||
    payload?.type !== expectedType ||
    !Number.isSafeInteger(payload?.issuedAt) ||
    !Number.isSafeInteger(payload?.expiresAt) ||
    payload.expiresAt <= nowSeconds
  ) {
    throw new WalletSetupAuthError(401, "expired_wallet_session", "Wallet session has expired");
  }
  return payload;
}

function address(value, code = "invalid_wallet") {
  try {
    return getAddress(value);
  } catch {
    throw new WalletSetupAuthError(422, code, "Wallet must be a valid EVM address");
  }
}

function secretBytes(secret) {
  if (typeof secret !== "string" || Buffer.byteLength(secret, "utf8") < 32) {
    throw new TypeError("wallet setup session secret must contain at least 32 bytes");
  }
  return Buffer.from(secret, "utf8");
}

function positiveTtl(value, name) {
  if (!Number.isSafeInteger(value) || value <= 0 || value > 3_600) {
    throw new TypeError(`${name} must be a positive safe integer no greater than one hour`);
  }
}

function challengeMessage({ wallet, nonce, issuedAt, expiresAt }) {
  return [
    "Conviction wallet setup",
    "",
    `Purpose: ${WALLET_SESSION_PURPOSE}`,
    `Wallet: ${wallet}`,
    `Nonce: ${nonce}`,
    `Issued at: ${issuedAt}`,
    `Expires at: ${expiresAt}`,
    "",
    "This signature authenticates a short-lived setup session.",
    "It does not approve, pay, fund, or place a trade.",
  ].join("\n");
}

function deploymentMessage({ wallet, sessionId, nonce, issuedAt, expiresAt }) {
  return [
    "Conviction Deposit Wallet deployment consent",
    "",
    `Purpose: ${WALLET_SESSION_PURPOSE}`,
    `Wallet: ${wallet}`,
    `Factory: ${DEPOSIT_WALLET_FACTORY}`,
    `Session: ${sessionId}`,
    `Nonce: ${nonce}`,
    `Issued at: ${issuedAt}`,
    `Expires at: ${expiresAt}`,
    "",
    "I authorize exactly one deployment of my buyer-controlled Polymarket Deposit Wallet through the factory above.",
    "This does not approve tokens, pay Conviction, fund the wallet, or place a trade.",
  ].join("\n");
}

function requireState(state) {
  for (const method of ["claimOnce", "put", "get"]) {
    if (typeof state?.[method] !== "function") {
      throw new TypeError("wallet setup state must implement claimOnce, put, and get");
    }
  }
  return state;
}

function sessionMatches(payload, session) {
  return (
    payload?.wallet === session?.wallet &&
    payload?.sessionId === session?.sessionId
  );
}

export function createWalletSetupAuth({
  secret,
  now = () => Math.floor(Date.now() / 1_000),
  randomBytes = nodeRandomBytes,
  challengeTtlSeconds = 120,
  sessionTtlSeconds = 600,
  deploymentTtlSeconds = 120,
  state = createInMemoryWalletSetupState(),
} = {}) {
  const key = secretBytes(secret);
  if (typeof now !== "function" || typeof randomBytes !== "function") {
    throw new TypeError("now and randomBytes must be functions");
  }
  positiveTtl(challengeTtlSeconds, "challengeTtlSeconds");
  positiveTtl(sessionTtlSeconds, "sessionTtlSeconds");
  positiveTtl(deploymentTtlSeconds, "deploymentTtlSeconds");
  const walletState = requireState(state);

  function issueChallenge(walletValue) {
    const wallet = address(walletValue);
    const issuedAt = now();
    const expiresAt = issuedAt + challengeTtlSeconds;
    const payload = {
      version: WALLET_SESSION_VERSION,
      type: "challenge",
      wallet,
      nonce: randomBytes(24).toString("hex"),
      issuedAt,
      expiresAt,
    };
    return Object.freeze({
      ok: true,
      wallet,
      message: challengeMessage(payload),
      challengeToken: token(payload, key),
      issuedAt,
      expiresAt,
      permissions: Object.freeze({
        authenticateOnly: true,
        deploy: false,
        approve: false,
        fund: false,
        pay: false,
        trade: false,
      }),
    });
  }

  async function authenticate({ challengeToken, signature }) {
    const currentTime = now();
    const challenge = verifyToken(challengeToken, key, "challenge", currentTime);
    if (typeof signature !== "string" || !/^0x[0-9a-fA-F]{130}$/.test(signature)) {
      throw new WalletSetupAuthError(422, "invalid_wallet_signature", "Wallet signature is invalid");
    }
    const message = challengeMessage(challenge);
    const valid = await verifyMessage({
      address: challenge.wallet,
      message,
      signature,
    });
    if (!valid) {
      throw new WalletSetupAuthError(401, "wallet_signature_mismatch", "Signature does not match the requested wallet");
    }
    const claimed = await walletState.claimOnce(
      "challenge",
      challenge.nonce,
      Math.max(1, challenge.expiresAt - currentTime),
    );
    if (!claimed) {
      throw new WalletSetupAuthError(409, "wallet_challenge_used", "Wallet authentication challenge was already used");
    }
    const issuedAt = currentTime;
    const expiresAt = issuedAt + sessionTtlSeconds;
    const session = {
      version: WALLET_SESSION_VERSION,
      type: "session",
      wallet: challenge.wallet,
      sessionId: randomBytes(24).toString("hex"),
      issuedAt,
      expiresAt,
    };
    return Object.freeze({
      ok: true,
      wallet: challenge.wallet,
      sessionToken: token(session, key),
      issuedAt,
      expiresAt,
    });
  }

  function verifySession(sessionToken) {
    const session = verifyToken(sessionToken, key, "session", now());
    return Object.freeze({
      wallet: address(session.wallet),
      sessionId: session.sessionId,
      issuedAt: session.issuedAt,
      expiresAt: session.expiresAt,
    });
  }

  function issueDeploymentChallenge(session) {
    const currentTime = now();
    const payload = {
      version: WALLET_SESSION_VERSION,
      type: "deploy-challenge",
      wallet: address(session?.wallet),
      sessionId: String(session?.sessionId || ""),
      factory: DEPOSIT_WALLET_FACTORY,
      nonce: randomBytes(24).toString("hex"),
      issuedAt: currentTime,
      expiresAt: currentTime + deploymentTtlSeconds,
    };
    if (!/^[0-9a-f]{48}$/.test(payload.sessionId)) {
      throw new WalletSetupAuthError(401, "invalid_wallet_session", "Wallet session is invalid");
    }
    return Object.freeze({
      ok: true,
      wallet: payload.wallet,
      factory: payload.factory,
      message: deploymentMessage(payload),
      deploymentChallengeToken: token(payload, key),
      issuedAt: payload.issuedAt,
      expiresAt: payload.expiresAt,
      permissions: Object.freeze({
        deployExactlyOneDepositWallet: true,
        approve: false,
        fund: false,
        pay: false,
        trade: false,
      }),
    });
  }

  async function authorizeDeployment({ deploymentChallengeToken, signature, session }) {
    const currentTime = now();
    const challenge = verifyToken(deploymentChallengeToken, key, "deploy-challenge", currentTime);
    if (!sessionMatches(challenge, session) || challenge.factory !== DEPOSIT_WALLET_FACTORY) {
      throw new WalletSetupAuthError(403, "deployment_session_mismatch", "Deployment consent does not match this wallet session");
    }
    if (typeof signature !== "string" || !/^0x[0-9a-fA-F]{130}$/.test(signature)) {
      throw new WalletSetupAuthError(422, "invalid_wallet_signature", "Wallet signature is invalid");
    }
    const valid = await verifyMessage({
      address: challenge.wallet,
      message: deploymentMessage(challenge),
      signature,
    });
    if (!valid) {
      throw new WalletSetupAuthError(401, "wallet_signature_mismatch", "Deployment signature does not match the buyer wallet");
    }
    const claimed = await walletState.claimOnce(
      "deployment-challenge",
      challenge.nonce,
      Math.max(1, challenge.expiresAt - currentTime),
    );
    if (!claimed) {
      throw new WalletSetupAuthError(409, "deployment_challenge_used", "Deployment consent was already used");
    }
    const issuedAt = currentTime;
    const expiresAt = Math.min(session.expiresAt, issuedAt + deploymentTtlSeconds);
    const consent = {
      version: WALLET_SESSION_VERSION,
      type: "deploy-consent",
      wallet: session.wallet,
      sessionId: session.sessionId,
      factory: DEPOSIT_WALLET_FACTORY,
      consentId: randomBytes(24).toString("hex"),
      issuedAt,
      expiresAt,
    };
    return Object.freeze({
      ok: true,
      deploymentConsentToken: token(consent, key),
      expiresAt,
    });
  }

  async function consumeDeploymentConsent(deploymentConsentToken, session) {
    const currentTime = now();
    const consent = verifyToken(deploymentConsentToken, key, "deploy-consent", currentTime);
    if (!sessionMatches(consent, session) || consent.factory !== DEPOSIT_WALLET_FACTORY) {
      throw new WalletSetupAuthError(403, "deployment_session_mismatch", "Deployment consent does not match this wallet session");
    }
    const claimed = await walletState.claimOnce(
      "deployment-consent",
      consent.consentId,
      Math.max(1, consent.expiresAt - currentTime),
    );
    if (!claimed) {
      throw new WalletSetupAuthError(409, "deployment_consent_used", "Deployment consent was already used");
    }
    return Object.freeze({ wallet: consent.wallet, factory: consent.factory });
  }

  function issuePollToken({ session, transactionId, action }) {
    const issuedAt = now();
    const expiresAt = Math.min(session.expiresAt, issuedAt + sessionTtlSeconds);
    if (typeof transactionId !== "string" || !/^[A-Za-z0-9._:-]{1,191}$/.test(transactionId)) {
      throw new WalletSetupAuthError(422, "invalid_relayer_transaction", "Relayer transaction is invalid");
    }
    if (!/^(DEPLOY_DEPOSIT_WALLET|APPROVE_DEPOSIT_WALLET)$/.test(action)) {
      throw new WalletSetupAuthError(422, "invalid_relayer_transaction", "Relayer transaction is invalid");
    }
    return token({
      version: WALLET_SESSION_VERSION,
      type: "poll",
      wallet: session.wallet,
      sessionId: session.sessionId,
      transactionId,
      action,
      issuedAt,
      expiresAt,
    }, key);
  }

  function verifyPollToken(pollToken, session) {
    const payload = verifyToken(pollToken, key, "poll", now());
    if (!sessionMatches(payload, session)) {
      throw new WalletSetupAuthError(403, "poll_session_mismatch", "Relayer status check does not match this wallet session");
    }
    return Object.freeze({ transactionId: payload.transactionId, action: payload.action });
  }

  return Object.freeze({
    issueChallenge,
    authenticate,
    verifySession,
    issueDeploymentChallenge,
    authorizeDeployment,
    consumeDeploymentConsent,
    issuePollToken,
    verifyPollToken,
  });
}
