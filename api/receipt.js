import { ConvictionError } from "../src/errors.mjs";
import { createPublicApiGuard, PublicApiError } from "../src/public-api-guard.mjs";
import { fetchAndVerifyPosition } from "../src/receipt-verifier.mjs";

function send(response, status, body) {
  response.status(status).setHeader("content-type", "application/json; charset=utf-8");
  response.setHeader("cache-control", "no-store");
  response.end(JSON.stringify(body));
}

export function createReceiptHandler({
  verifyImpl = fetchAndVerifyPosition,
  publicGuard = createPublicApiGuard({ limit: 15, maxBodyBytes: 32_768, maxInFlight: 6 }),
} = {}) {
  return async function handler(request, response) {
    if (request.method !== "POST") {
      response.setHeader("allow", "POST");
      return send(response, 405, { ok: false, error: { code: "method_not_allowed" } });
    }
    try {
      const body = request.body && typeof request.body === "object" ? request.body : {};
      const result = await publicGuard.run(request, () => verifyImpl(body.transactionHash, {
        intent: body.intent,
        intentHash: body.intentHash,
        orderId: body.orderId,
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
        const upstream = error.code === "rpc_error";
        return send(response, upstream ? 502 : 422, {
          ok: false,
          error: { code: error.code, message: error.message, details: error.details },
        });
      }
      console.error("receipt handler failed", error);
      return send(response, 500, {
        ok: false,
        error: { code: "internal_error", message: "Execution proof failed" },
      });
    }
  };
}

export default createReceiptHandler();
