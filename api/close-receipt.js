import { ConvictionError } from "../src/errors.mjs";
import { fetchAndVerifyClose } from "../src/exit-receipt-verifier.mjs";
import { trustedIssuerRegistryFromEnvironment } from "../src/intent-issuer.mjs";
import { createPublicApiGuard, PublicApiError } from "../src/public-api-guard.mjs";

function send(response, status, body) {
  response.status(status).setHeader("content-type", "application/json; charset=utf-8");
  response.setHeader("cache-control", "no-store");
  response.end(JSON.stringify(body));
}

export function createCloseReceiptHandler({
  verifyImpl = fetchAndVerifyClose,
  trustedIssuers = undefined,
  environment = process.env,
  publicGuard = createPublicApiGuard({ limit: 15, maxBodyBytes: 32_768, maxInFlight: 6 }),
} = {}) {
  let resolvedTrustedIssuers = trustedIssuers;
  if (!resolvedTrustedIssuers) {
    try {
      resolvedTrustedIssuers = trustedIssuerRegistryFromEnvironment(environment);
    } catch {
      resolvedTrustedIssuers = new Map();
    }
  }
  return async function closeReceiptHandler(request, response) {
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
        issuance: body.issuance,
        trustedIssuers: resolvedTrustedIssuers,
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
        return send(response, error.code === "rpc_error" ? 502 : 422, {
          ok: false,
          error: { code: error.code, message: error.message, details: error.details },
        });
      }
      console.error("close receipt handler failed", { name: error?.name, code: error?.code });
      return send(response, 500, {
        ok: false,
        error: { code: "internal_error", message: "Close proof failed" },
      });
    }
  };
}

export default createCloseReceiptHandler();
