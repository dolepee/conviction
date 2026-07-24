import { createWalletSetupAuth, WalletSetupAuthError } from "../src/wallet-setup-auth.mjs";
import { createPublicApiGuard, PublicApiError } from "../src/public-api-guard.mjs";
import { browserSetupConfigured } from "../src/wallet-setup-config.mjs";
import {
  createWalletSetupStateFromEnvironment,
  WalletSetupStateError,
} from "../src/wallet-setup-state.mjs";

const guard = createPublicApiGuard({ limit: 20, maxBodyBytes: 8_192, maxInFlight: 4 });

function bearer(request) {
  const raw = String(request.headers?.authorization || "");
  return raw.startsWith("Bearer ") ? raw.slice(7).trim() : "";
}

function errorResponse(response, error) {
  const known =
    error instanceof WalletSetupAuthError ||
    error instanceof PublicApiError ||
    error instanceof WalletSetupStateError;
  const status = known ? error.status : 500;
  const code = known ? error.code : "wallet_session_failed";
  const message = known ? error.message : "Wallet session could not be created";
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

export function createWalletSessionHandler({
  auth,
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
  const walletAuth = auth || createWalletSetupAuth({
    secret: process.env.CONVICTION_WALLET_SESSION_SECRET,
    state: createWalletSetupStateFromEnvironment(),
  });
  return async function handler(request, response) {
    response.setHeader("cache-control", "no-store");
    response.setHeader("content-type", "application/json; charset=utf-8");
    if (request.method !== "POST") {
      response.setHeader("allow", "POST");
      return response.status(405).json({ ok: false, error: { code: "method_not_allowed" } });
    }
    try {
      return await apiGuard.run(request, async () => {
        if (request.body?.action === "challenge") {
          return response.status(200).json(walletAuth.issueChallenge(request.body.wallet));
        }
        if (request.body?.action === "authenticate") {
          return response.status(200).json(await walletAuth.authenticate(request.body));
        }
        const session = walletAuth.verifySession(bearer(request));
        if (request.body?.action === "deploy_challenge") {
          return response.status(200).json(walletAuth.issueDeploymentChallenge(session));
        }
        if (request.body?.action === "deploy_authorize") {
          return response.status(200).json(await walletAuth.authorizeDeployment({
            deploymentChallengeToken: request.body?.deploymentChallengeToken,
            signature: request.body?.signature,
            session,
          }));
        }
        return response.status(422).json({
          ok: false,
          error: {
            code: "invalid_wallet_session_action",
            message: "action must be challenge, authenticate, deploy_challenge, or deploy_authorize",
          },
        });
      });
    } catch (error) {
      return errorResponse(response, error);
    }
  };
}

export default function handler(request, response) {
  try {
    return createWalletSessionHandler()(request, response);
  } catch (error) {
    return errorResponse(response, error);
  }
}
