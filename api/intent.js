import { ConvictionError } from "../src/errors.mjs";
import { compileIntent } from "../src/intent-compiler.mjs";
import { resolveMarket } from "../src/market-client.mjs";
import { createPublicApiGuard, PublicApiError } from "../src/public-api-guard.mjs";

export const PUBLIC_INTENT_QUOTE_TTL_MS = 300_000;

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
} = {}) {
  return async function handler(request, response) {
    if (request.method !== "POST") {
      response.setHeader("allow", "POST");
      return send(response, 405, { ok: false, error: { code: "method_not_allowed" } });
    }
    try {
      const body = request.body && typeof request.body === "object" ? request.body : {};
      const compile = async () => {
        const market = await resolveMarketImpl(body.market, { outcome: body.outcome });
        return compileIntent(body, market, compileOptions);
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
        return send(response, upstream ? 502 : 422, {
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
}

export default createIntentHandler();
