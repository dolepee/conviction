import { ConvictionError } from "../src/errors.mjs";
import { compilePreview } from "../src/intent-compiler.mjs";
import { resolveMarket } from "../src/market-client.mjs";
import { createPublicApiGuard, PublicApiError } from "../src/public-api-guard.mjs";
import { createShortCache } from "../src/short-cache.mjs";

function send(response, status, body) {
  response.status(status).setHeader("content-type", "application/json; charset=utf-8");
  response.setHeader("cache-control", "no-store");
  response.end(JSON.stringify(body));
}

export function createPreviewHandler({
  resolveMarketImpl = resolveMarket,
  compilePreviewImpl = compilePreview,
  compileOptions = undefined,
  publicGuard = createPublicApiGuard(),
  cache = createShortCache(),
} = {}) {
  return async function handler(request, response) {
    if (request.method !== "POST") {
      response.setHeader("allow", "POST");
      return send(response, 405, { ok: false, error: { code: "method_not_allowed" } });
    }
    try {
      const body = request.body && typeof request.body === "object" ? request.body : {};
      const key = JSON.stringify([
        String(body.market || "").trim(),
        String(body.outcome || "").trim().toLowerCase(),
        String(body.spend || "").trim(),
        String(body.maxPrice || "").trim(),
      ]);
      const result = await publicGuard.run(request, () => cache.get(key, async () => {
        const market = await resolveMarketImpl(body.market, { outcome: body.outcome });
        return compilePreviewImpl(body, market, compileOptions);
      }));
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
      console.error("preview handler failed", error);
      return send(response, 500, {
        ok: false,
        error: { code: "internal_error", message: "Bounds preview failed" },
      });
    }
  };
}

export default createPreviewHandler();
