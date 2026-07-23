import {
  buyerReadinessContract,
  classifyBuyerReadiness,
} from "../src/buyer-readiness.mjs";
import { createPublicApiGuard, PublicApiError } from "../src/public-api-guard.mjs";

function send(response, status, body) {
  response.status(status).setHeader("content-type", "application/json; charset=utf-8");
  response.setHeader("cache-control", "no-store");
  response.end(JSON.stringify(body));
}

export function createReadinessHandler({
  publicGuard = createPublicApiGuard(),
} = {}) {
  return async function handler(request, response) {
    if (request.method === "GET" || request.method === "HEAD") {
      response.setHeader("cache-control", "no-store");
      return response.status(200).json({
        ok: true,
        contract: buyerReadinessContract(),
      });
    }
    if (request.method !== "POST") {
      response.setHeader("allow", "GET, HEAD, POST");
      return send(response, 405, {
        ok: false,
        error: { code: "method_not_allowed" },
      });
    }
    try {
      const result = await publicGuard.run(request, async () =>
        classifyBuyerReadiness(
          request.body && typeof request.body === "object" ? request.body : {},
        ));
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
      console.error("readiness handler failed", error);
      return send(response, 500, {
        ok: false,
        error: { code: "internal_error", message: "Buyer readiness classification failed" },
      });
    }
  };
}

export default createReadinessHandler();
