import { ConvictionError } from "../src/errors.mjs";
import { compilePreview } from "../src/intent-compiler.mjs";
import { resolveMarket } from "../src/market-client.mjs";

function send(response, status, body) {
  response.status(status).setHeader("content-type", "application/json; charset=utf-8");
  response.setHeader("cache-control", "no-store");
  response.end(JSON.stringify(body));
}

export function createPreviewHandler({
  resolveMarketImpl = resolveMarket,
  compilePreviewImpl = compilePreview,
  compileOptions = undefined,
} = {}) {
  return async function handler(request, response) {
    if (request.method !== "POST") {
      response.setHeader("allow", "POST");
      return send(response, 405, { ok: false, error: { code: "method_not_allowed" } });
    }
    try {
      const body = request.body && typeof request.body === "object" ? request.body : {};
      const market = await resolveMarketImpl(body.market, { outcome: body.outcome });
      return send(response, 200, compilePreviewImpl(body, market, compileOptions));
    } catch (error) {
      if (error instanceof ConvictionError) {
        const upstream = ["market_api_error", "rpc_error"].includes(error.code);
        return send(response, upstream ? 502 : 422, {
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
