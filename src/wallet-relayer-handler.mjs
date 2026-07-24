import { getAddress } from "viem";

import { BuilderGuardError, DEPOSIT_WALLET_FACTORY } from "./polymarket-builder-guard.mjs";
import { builderCredentialsFromEnvironment } from "./polymarket-builder-credentials.mjs";
import { createPolymarketRelayerProxy } from "./polymarket-relayer-proxy.mjs";
import {
  createPolygonWalletSetupVerifierFromEnvironment,
  PolygonWalletSetupVerificationError,
} from "./polygon-wallet-setup-verifier.mjs";
import { createPublicApiGuard, PublicApiError } from "./public-api-guard.mjs";
import { createWalletSetupAuth, WalletSetupAuthError } from "./wallet-setup-auth.mjs";
import { browserSetupConfigured } from "./wallet-setup-config.mjs";
import {
  createInMemoryWalletSetupState,
  createWalletSetupStateFromEnvironment,
  WalletSetupStateError,
} from "./wallet-setup-state.mjs";

const guard = createPublicApiGuard({ limit: 20, maxBodyBytes: 32_768, maxInFlight: 4 });
const TRANSACTION_TTL_SECONDS = 900;

function bearer(request) {
  const raw = String(request.headers?.authorization || "");
  return raw.startsWith("Bearer ") ? raw.slice(7).trim() : "";
}

function relayerCredentialsFromEnvironment() {
  const key = process.env.POLYMARKET_RELAYER_API_KEY;
  const address = process.env.POLYMARKET_RELAYER_API_KEY_ADDRESS;
  if (
    typeof key !== "string" ||
    key.trim().length === 0 ||
    typeof address !== "string" ||
    !/^0x[0-9a-fA-F]{40}$/.test(address)
  ) {
    return undefined;
  }
  return {
    key: key.trim(),
    address,
  };
}

function sameAddress(left, right) {
  try {
    return getAddress(left) === getAddress(right);
  } catch {
    return false;
  }
}

function relayerError(status, code, message) {
  return new BuilderGuardError(status, code, message);
}

function canonicalRequest(raw) {
  if (typeof raw !== "string" || Buffer.byteLength(raw, "utf8") > 24_000) {
    throw relayerError(422, "invalid_builder_body", "Relayer request must be a bounded JSON string");
  }
  let body;
  try {
    body = JSON.parse(raw);
  } catch {
    throw relayerError(422, "invalid_builder_body", "Relayer request must be valid JSON");
  }
  if (raw !== JSON.stringify(body) || !body || typeof body !== "object" || Array.isArray(body)) {
    throw relayerError(422, "noncanonical_builder_body", "Relayer request must use the exact canonical JSON serialization");
  }
  return body;
}

function transactionKey(session, transactionId) {
  return `${session.sessionId}:${transactionId}`;
}

function depositWalletKey(session) {
  return session.wallet.toLowerCase();
}

function sessionTtl(session) {
  return Math.max(1, Math.min(TRANSACTION_TTL_SECONDS, session.expiresAt - Math.floor(Date.now() / 1_000)));
}

function expectedRequest(body) {
  if (body?.type === "WALLET-CREATE") {
    return Object.freeze({ action: "DEPLOY_DEPOSIT_WALLET", type: "WALLET-CREATE" });
  }
  if (body?.type === "WALLET") {
    return Object.freeze({ action: "APPROVE_DEPOSIT_WALLET", type: "WALLET" });
  }
  throw relayerError(422, "unsupported_builder_request", "Only deposit-wallet deployment and the official setup batch are supported");
}

function recordMatches({ record, expected, session, depositWallet = undefined }) {
  if (record?.state === "STATE_INVALID" || record?.state === "STATE_FAILED") {
    throw relayerError(422, "relayer_transaction_failed", "Polymarket relayer rejected the setup transaction");
  }
  if (record?.from && !sameAddress(record.from, session.wallet)) {
    throw relayerError(502, "relayer_transaction_mismatch", "Polymarket relayer returned another buyer transaction");
  }
  if (record?.to && !sameAddress(record.to, DEPOSIT_WALLET_FACTORY)) {
    throw relayerError(502, "relayer_transaction_mismatch", "Polymarket relayer returned another setup factory");
  }
  if (record?.type && record.type !== expected.type) {
    throw relayerError(502, "relayer_transaction_mismatch", "Polymarket relayer returned another setup action");
  }
  if (depositWallet && record?.proxyAddress && !sameAddress(record.proxyAddress, depositWallet)) {
    throw relayerError(502, "relayer_transaction_mismatch", "Polymarket relayer returned another Deposit Wallet");
  }
}

function errorResponse(response, error) {
  const known =
    error instanceof BuilderGuardError ||
    error instanceof WalletSetupAuthError ||
    error instanceof PublicApiError ||
    error instanceof WalletSetupStateError ||
    error instanceof PolygonWalletSetupVerificationError;
  const status = known ? error.status : 500;
  const code = known ? error.code : "wallet_relayer_failed";
  const message = known ? error.message : "Wallet setup relayer request failed";
  return response.status(status).json({ ok: false, error: { code, message } });
}

function inactive(response) {
  return response.status(503).json({
    ok: false,
    error: {
      code: "browser_setup_inactive",
      message: "Browser Deposit Wallet setup is not active",
    },
  });
}

export function createWalletRelayerHandler({
  auth,
  relayer,
  state,
  verifier,
  apiGuard = guard,
  configured = browserSetupConfigured(),
} = {}) {
  if (!configured) {
    return function handler(request, response) {
      response.setHeader("cache-control", "no-store");
      response.setHeader("content-type", "application/json; charset=utf-8");
      if (request.method !== "POST") {
        response.setHeader("allow", "POST");
        return response.status(405).json({ ok: false, error: { code: "method_not_allowed" } });
      }
      return inactive(response);
    };
  }
  const walletState = state || (auth ? createInMemoryWalletSetupState() : createWalletSetupStateFromEnvironment());
  const walletAuth = auth || createWalletSetupAuth({
    secret: process.env.CONVICTION_WALLET_SESSION_SECRET,
    state: walletState,
  });
  const walletRelayer = relayer || createPolymarketRelayerProxy({
    credentials: builderCredentialsFromEnvironment(),
    relayerCredentials: relayerCredentialsFromEnvironment(),
  });
  let polygonVerifier = verifier;

  function setupVerifier() {
    if (!polygonVerifier) polygonVerifier = createPolygonWalletSetupVerifierFromEnvironment();
    return polygonVerifier;
  }

  async function submit({ request, deploymentConsentToken, session }) {
    // Validate the fixed Polygon verifier before the Builder relayer sees a
    // signed transaction. A partial deployment must not create a wallet and
    // only discover its missing verification RPC during polling.
    setupVerifier();
    const body = canonicalRequest(request);
    const expected = expectedRequest(body);
    let depositWallet;
    if (expected.action === "DEPLOY_DEPOSIT_WALLET") {
      await walletAuth.requireBuilderAuthorization(session);
      const consent = await walletAuth.consumeDeploymentConsent(deploymentConsentToken, session);
      if (!sameAddress(consent.wallet, session.wallet) || !sameAddress(consent.factory, DEPOSIT_WALLET_FACTORY)) {
        throw relayerError(403, "deployment_session_mismatch", "Deployment consent does not match this buyer session");
      }
    } else {
      const ready = await walletState.get("deposit-wallet", depositWalletKey(session));
      if (!ready?.wallet || !sameAddress(body?.depositWalletParams?.depositWallet, ready.wallet)) {
        throw relayerError(409, "deposit_wallet_not_confirmed", "A confirmed buyer Deposit Wallet is required before approval setup");
      }
      depositWallet = ready.wallet;
    }
    const result = await walletRelayer.run({ operation: "submit", session, body: { request } });
    if (result.action !== expected.action) {
      throw relayerError(502, "relayer_transaction_mismatch", "Relayer did not accept the expected setup action");
    }
    const transaction = result.relayer;
    await walletState.put("relayer-transaction", transactionKey(session, transaction.transactionId), {
      action: expected.action,
      type: expected.type,
      wallet: session.wallet,
      depositWallet,
    }, sessionTtl(session));
    return {
      ok: true,
      operation: "submit",
      action: expected.action,
      state: transaction.state,
      pollToken: walletAuth.issuePollToken({
        session,
        transactionId: transaction.transactionId,
        action: expected.action,
      }),
    };
  }

  async function poll({ pollToken, session }) {
    const ticket = walletAuth.verifyPollToken(pollToken, session);
    const expected = await walletState.get("relayer-transaction", transactionKey(session, ticket.transactionId));
    if (!expected || expected.action !== ticket.action || !sameAddress(expected.wallet, session.wallet)) {
      throw relayerError(403, "relayer_poll_not_authorized", "Relayer transaction is not authorized for this wallet session");
    }
    const result = await walletRelayer.run({
      operation: "transaction",
      session,
      body: { transactionId: ticket.transactionId },
    });
    const record = result.relayer;
    recordMatches({ record, expected, session, depositWallet: expected.depositWallet });
    if (record.state !== "STATE_CONFIRMED") {
      return Object.freeze({ ok: true, operation: "transaction", action: expected.action, state: record.state, status: "pending" });
    }
    if (!record.transactionHash) {
      throw relayerError(502, "invalid_relayer_response", "Confirmed relayer transaction has no Polygon transaction hash");
    }
    if (expected.action === "DEPLOY_DEPOSIT_WALLET") {
      const confirmed = await setupVerifier().verifyDeployment({
        transactionHash: record.transactionHash,
        owner: session.wallet,
        expectedWallet: record.proxyAddress,
      });
      await walletState.put("deposit-wallet", depositWalletKey(session), {
        wallet: confirmed.wallet,
        deploymentTransactionHash: confirmed.transactionHash,
      }, sessionTtl(session));
      return Object.freeze({
        ok: true,
        operation: "transaction",
        action: expected.action,
        state: record.state,
        status: "confirmed",
        transactionHash: confirmed.transactionHash,
        depositWallet: confirmed.wallet,
      });
    }
    const ready = await walletState.get("deposit-wallet", depositWalletKey(session));
    if (!ready?.wallet || !sameAddress(ready.wallet, expected.depositWallet)) {
      throw relayerError(409, "deposit_wallet_not_confirmed", "Buyer Deposit Wallet confirmation expired; restart setup before funding");
    }
    const confirmed = await setupVerifier().verifyApprovals({
      transactionHash: record.transactionHash,
      wallet: ready.wallet,
    });
    return Object.freeze({
      ok: true,
      operation: "transaction",
      action: expected.action,
      state: record.state,
      status: "confirmed",
      transactionHash: confirmed.transactionHash,
      depositWallet: confirmed.wallet,
      approvalCalls: confirmed.approvalCalls,
    });
  }

  return async function handler(request, response) {
    response.setHeader("cache-control", "no-store");
    response.setHeader("content-type", "application/json; charset=utf-8");
    if (request.method !== "POST") {
      response.setHeader("allow", "POST");
      return response.status(405).json({ ok: false, error: { code: "method_not_allowed" } });
    }
    try {
      return await apiGuard.run(request, async () => {
        const session = walletAuth.verifySession(bearer(request));
        if (request.body?.operation === "auth") {
          const result = await walletRelayer.run({ operation: "builder-auth", session, body: {} });
          await walletAuth.recordBuilderAuthorization(session);
          return response.status(200).json(result);
        }
        if (request.body?.operation === "nonce") {
          const result = await walletRelayer.run({ operation: "nonce", session, body: {} });
          return response.status(200).json(result);
        }
        if (request.body?.operation === "submit") {
          return response.status(200).json(await submit({
            request: request.body?.request,
            deploymentConsentToken: request.body?.deploymentConsentToken,
            session,
          }));
        }
        if (request.body?.operation === "transaction") {
          return response.status(200).json(await poll({ pollToken: request.body?.pollToken, session }));
        }
        throw relayerError(422, "unsupported_relayer_operation", "Relayer operation must be auth, nonce, submit, or transaction");
      });
    } catch (error) {
      return errorResponse(response, error);
    }
  };
}
