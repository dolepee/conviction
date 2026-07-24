import { ConvictionError } from "../src/errors.mjs";
import { parseDecimal } from "../src/decimal.mjs";
import { compileIntent } from "../src/intent-compiler.mjs";
import { resolveMarket } from "../src/market-client.mjs";
import { createPublicApiGuard, PublicApiError } from "../src/public-api-guard.mjs";
import {
  requirePaidOpenExecutionMode,
  verifyBrowserWalletReadiness,
  verifyDepositWalletExecution,
  verifyDepositWalletReadiness,
  verifyOpenPluginPreview,
} from "../src/open-execution-preflight.mjs";
import { attachOpenRefreshContract } from "../src/open-card-refresh.mjs";

export const PUBLIC_INTENT_QUOTE_TTL_MS = 300_000;

export async function preflightPaidOpenExecution(
  body,
  { verifyExecutionWalletImpl = verifyDepositWalletExecution } = {},
) {
  requirePaidOpenExecutionMode(body);
  const walletReadiness = body.executionMode === "browser-deposit-wallet"
    ? verifyBrowserWalletReadiness(body.wallet, body.browserWalletReadiness)
    : verifyDepositWalletReadiness(body.wallet, body.walletReadiness);
  const walletExecution = await verifyExecutionWalletImpl(body.wallet, {
    owner: walletReadiness.owner,
    minimumBalanceRaw: parseDecimal(String(body.spend || ""), 6, "spend").toString(),
  });
  return Object.freeze({ walletReadiness, walletExecution });
}

function send(response, status, body) {
  response.status(status).setHeader("content-type", "application/json; charset=utf-8");
  response.setHeader("cache-control", "no-store");
  response.end(JSON.stringify(body));
}

export function createIntentHandler({
  compileOptions = { maxSnapshotAgeMs: 30_000, quoteTtlMs: PUBLIC_INTENT_QUOTE_TTL_MS },
  publicAccess = true,
  publicGuard = createPublicApiGuard(),
  resolveMarketImpl = resolveMarket,
  issueIntentImpl = undefined,
  verifyExecutionWalletImpl = verifyDepositWalletExecution,
} = {}) {
  const paidOpenEligibility = publicAccess
    ? undefined
    : (body) => preflightPaidOpenExecution(body, { verifyExecutionWalletImpl });

  const handler = async function handler(request, response) {
    if (request.method !== "POST") {
      response.setHeader("allow", "POST");
      return send(response, 405, { ok: false, error: { code: "method_not_allowed" } });
    }
    try {
      const body = request.body && typeof request.body === "object" ? request.body : {};
      const compile = async () => {
        let paidPreflight;
        if (!publicAccess) {
          paidPreflight = request.convictionPaidOpenPreflight ?? await paidOpenEligibility(body);
        }
        const market = await resolveMarketImpl(body.market, { outcome: body.outcome });
        const compilation = compileIntent(body, market, compileOptions);
        if (!publicAccess && body.executionMode === "deposit-wallet") {
          verifyOpenPluginPreview(compilation, body.pluginPreview, {
            verifiedWallet: paidPreflight.walletReadiness.wallet,
          });
        }
        const delivered = issueIntentImpl ? await issueIntentImpl(compilation) : compilation;
        return publicAccess ? delivered : attachOpenRefreshContract(delivered);
      };
      const result = publicAccess ? await publicGuard.run(request, compile) : await compile();
      return send(response, 200, result);
    } catch (error) {
      if (error instanceof PublicApiError) {
        if (error.details?.retryAfterSeconds) {
          response.setHeader("retry-after", String(error.details.retryAfterSeconds));
        }
        return send(response, error.status, {
          ok: false,
          error: { code: error.code, message: error.message, details: error.details },
        });
      }
      if (error instanceof ConvictionError) {
        const upstream = ["market_api_error", "rpc_error"].includes(error.code);
        const status = error.code === "market_not_found" ? 404 : upstream ? 502 : 422;
        return send(response, status, {
          ok: false,
          error: { code: error.code, message: error.message, details: error.details },
        });
      }
      console.error("intent handler failed", error);
      return send(response, 500, {
        ok: false,
        error: { code: "internal_error", message: "Intent compilation failed" },
      });
    }
  };
  if (paidOpenEligibility) {
    Object.defineProperty(handler, "prePaymentEligibility", {
      value: paidOpenEligibility,
      enumerable: false,
    });
  }
  return handler;
}

export default createIntentHandler();
