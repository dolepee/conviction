import { ConvictionError } from "../src/errors.mjs";
import { refreshOpenCard } from "../src/open-card-refresh.mjs";
import { createPublicApiGuard, PublicApiError } from "../src/public-api-guard.mjs";

function send(response, status, body) {
  response.status(status).setHeader("content-type", "application/json; charset=utf-8");
  response.setHeader("cache-control", "no-store");
  response.end(JSON.stringify(body));
}

export function createRefreshHandler({
  environment = process.env,
  publicGuard = createPublicApiGuard(),
  refreshImpl = refreshOpenCard,
  refreshOptions = undefined,
} = {}) {
  return async function handler(request, response) {
    if (request.method !== "POST") {
      response.setHeader("allow", "POST");
      return send(response, 405, { ok: false, error: { code: "method_not_allowed" } });
    }
    try {
      const body = request.body && typeof request.body === "object" ? request.body : {};
      const result = await publicGuard.run(request, () =>
        refreshImpl(body, { environment, ...refreshOptions }));
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
        const upstream = ["market_api_error", "rpc_error", "payment_rpc_error"].includes(error.code);
        const status = error.code === "market_not_found" ? 404 : upstream ? 502 : 422;
        return send(response, status, {
          ok: false,
          error: { code: error.code, message: error.message, details: error.details },
        });
      }
      console.error("refresh handler failed", { name: error?.name, code: error?.code });
      return send(response, 500, {
        ok: false,
        error: { code: "internal_error", message: "OPEN card refresh failed" },
      });
    }
  };
}

export default createRefreshHandler();
