import express from "express";

import { createIntentHandler } from "./intent.js";
import { createEnvironmentIntentIssuer } from "../src/intent-issuer.mjs";
import { EXECUTOR_DISCOVERY_LINK } from "../src/executor-discovery.mjs";
import { ConvictionError } from "../src/errors.mjs";
import { createPublicApiGuard, PublicApiError } from "../src/public-api-guard.mjs";
import { createPaymentGate, SERVICE_PATH } from "../src/service-payment.mjs";

export const PAID_SERVICE_QUOTE_TTL_MS = 300_000;
const PRE_PAYMENT_OPEN_GUARD_OPTIONS = Object.freeze({
  // Structured preflight performs four Polygon RPC reads. Keep that free,
  // safety-critical refusal path bounded without applying it to marketplace
  // discovery probes that intentionally have no buyer body yet.
  limit: 10,
  windowMs: 60_000,
  maxBodyBytes: 32 * 1024,
  maxMarketLength: 512,
  maxInFlight: 4,
});
export function createPaidIntentHandler(options = {}) {
  if (typeof options.issueIntentImpl !== "function") {
    const error = new Error("Paid intent issuance is not configured");
    error.code = "issuer_configuration_error";
    throw error;
  }
  return createIntentHandler({
    ...options,
    compileOptions: {
      maxSnapshotAgeMs: 30_000,
      quoteTtlMs: PAID_SERVICE_QUOTE_TTL_MS,
      ...options.compileOptions,
      intentVersion: "conviction-intent-v4",
    },
    publicAccess: false,
  });
}

export function createServiceApp(
  environment = process.env,
  {
    facilitatorClient = undefined,
    logger = console,
    compileHandler = undefined,
    notifyPaidCall = undefined,
    now = Date.now,
    prePaymentOpenGuard = createPublicApiGuard(PRE_PAYMENT_OPEN_GUARD_OPTIONS),
  } = {},
) {
  const app = express();
  app.disable("x-powered-by");
  app.set("case sensitive routing", true);
  app.set("strict routing", true);

  let paymentGate;
  let paymentConfigurationError;
  let resolvedCompileHandler = compileHandler;
  try {
    if (!resolvedCompileHandler) {
      const issueIntentImpl = createEnvironmentIntentIssuer(environment, { now });
      resolvedCompileHandler = createPaidIntentHandler({ issueIntentImpl });
    }
    paymentGate = createPaymentGate(environment, {
      facilitatorClient,
      logger,
      notifyPaidCall,
    });
  } catch (error) {
    paymentConfigurationError = error;
  }

  function requirePayment(request, response, next) {
    if (!paymentGate) {
      if (paymentConfigurationError) {
        logger.error("payment service configuration failed", {
          name: paymentConfigurationError?.name,
          code: paymentConfigurationError?.code,
        });
        paymentConfigurationError = undefined;
      }
      response.setHeader("cache-control", "no-store");
      return response.status(503).json({
        ok: false,
        error: {
          code: "payment_service_unavailable",
          message: "Payment verification is temporarily unavailable",
        },
      });
    }
    return paymentGate(request, response, next);
  }

  function serviceResponseHeaders(request, response, next) {
    response.setHeader("cache-control", "no-store");
    response.vary("Accept");
    response.vary("PAYMENT-SIGNATURE");
    response.vary("X-PAYMENT");
    response.setHeader("link", EXECUTOR_DISCOVERY_LINK);
    next();
  }

  function unavailableCompileHandler(request, response) {
    response.setHeader("cache-control", "no-store");
    return response.status(503).json({
      ok: false,
      error: {
        code: "service_configuration_error",
        message: "Signed intent issuance is temporarily unavailable",
      },
    });
  }

  // Preserve marketplace discovery behavior for malformed/empty probes while
  // making a structured unsupported buyer fail before x402 verification.
  const serviceJson = express.json({ limit: "32kb", strict: true });
  function parseServiceBody(request, response, next) {
    return serviceJson(request, response, (error) => {
      if (error) {
        request.serviceBodyParseError = error;
        request.body = {};
      }
      return next();
    });
  }

  async function prePaymentOpenEligibility(request, response, next) {
    const eligibility = resolvedCompileHandler?.prePaymentEligibility;
    const body = request.body && typeof request.body === "object" ? request.body : {};
    // A bare or malformed marketplace probe must still receive the standard
    // x402 discovery response. A body that names an OPEN journey is eligible
    // for an authoritative no-payment preflight.
    if (
      request.serviceBodyParseError ||
      typeof eligibility !== "function" ||
      !["wallet", "executionMode", "walletReadiness"].some((field) =>
        Object.prototype.hasOwnProperty.call(body, field),
      )
    ) return next();
    try {
      request.convictionPaidOpenPreflight = await prePaymentOpenGuard.run(
        request,
        () => eligibility(body),
      );
      return next();
    } catch (error) {
      if (error instanceof PublicApiError) {
        if (error.details?.retryAfterSeconds) {
          response.setHeader("retry-after", String(error.details.retryAfterSeconds));
        }
        response.setHeader("cache-control", "no-store");
        return response.status(error.status).json({
          ok: false,
          error: { code: error.code, message: error.message, details: error.details },
        });
      }
      if (error instanceof ConvictionError) {
        response.setHeader("cache-control", "no-store");
        return response.status(422).json({
          ok: false,
          error: { code: error.code, message: error.message, details: error.details },
        });
      }
      logger.error("pre-payment OPEN eligibility failed", { name: error?.name, code: error?.code });
      response.setHeader("cache-control", "no-store");
      return response.status(500).json({
        ok: false,
        error: { code: "prepayment_eligibility_failed", message: "Buyer eligibility could not be verified" },
      });
    }
  }

  function rejectVerifiedBodyParseError(request, response, next) {
    const error = request.serviceBodyParseError;
    if (!error) return next();
    response.setHeader("cache-control", "no-store");
    if (error.type === "entity.too.large") {
      return response.status(413).json({
        ok: false,
        error: { code: "payload_too_large", message: "Request body exceeds 32 KB" },
      });
    }
    return response.status(400).json({
      ok: false,
      error: { code: "invalid_json", message: "Request body must be valid JSON" },
    });
  }

  // GET/HEAD and a bare POST retain the marketplace-compatible x402 discovery
  // response. A structured POST is first checked against the deposit-wallet
  // maker identity so unsupported buyers never enter payment verification.
  app.post(
    SERVICE_PATH,
    serviceResponseHeaders,
    parseServiceBody,
    prePaymentOpenEligibility,
    requirePayment,
    rejectVerifiedBodyParseError,
    resolvedCompileHandler ?? unavailableCompileHandler,
  );
  app.all(SERVICE_PATH, serviceResponseHeaders, requirePayment);
  app.all(SERVICE_PATH, (request, response) => {
    response.setHeader("allow", "POST");
    response.setHeader("cache-control", "no-store");
    return response.status(405).json({
      ok: false,
      error: { code: "method_not_allowed" },
    });
  });

  app.use((error, request, response, next) => {
    if (response.headersSent) return next(error);
    if (error?.type === "entity.too.large") {
      response.setHeader("cache-control", "no-store");
      return response.status(413).json({
        ok: false,
        error: { code: "payload_too_large", message: "Request body exceeds 32 KB" },
      });
    }
    if (error?.type === "entity.parse.failed") {
      response.setHeader("cache-control", "no-store");
      return response.status(400).json({
        ok: false,
        error: { code: "invalid_json", message: "Request body must be valid JSON" },
      });
    }
    logger.error("service handler failed", { name: error?.name, code: error?.code });
    response.setHeader("cache-control", "no-store");
    return response.status(500).json({
      ok: false,
      error: { code: "internal_error", message: "Service request failed" },
    });
  });

  return app;
}

export default createServiceApp();
