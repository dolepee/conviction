import express from "express";

import { createIntentHandler } from "./intent.js";
import { createPaymentGate, SERVICE_PATH } from "../src/service-payment.mjs";

export const PAID_SERVICE_QUOTE_TTL_MS = 120_000;
export function createPaidIntentHandler(options = {}) {
  return createIntentHandler({
    ...options,
    compileOptions: options.compileOptions ?? {
      maxSnapshotAgeMs: 30_000,
      quoteTtlMs: PAID_SERVICE_QUOTE_TTL_MS,
    },
    publicAccess: false,
  });
}

const paidIntentHandler = createPaidIntentHandler();

export function createServiceApp(
  environment = process.env,
  {
    facilitatorClient = undefined,
    logger = console,
    compileHandler = paidIntentHandler,
    notifyPaidCall = undefined,
  } = {},
) {
  const app = express();
  app.disable("x-powered-by");
  app.set("case sensitive routing", true);
  app.set("strict routing", true);

  let paymentGate;
  let paymentConfigurationError;
  try {
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
    next();
  }

  // Marketplace validators probe API services without knowing their business
  // method or request schema. Challenge the exact service path first, then run
  // POST-only JSON and business validation after a payment is verified.
  app.all(SERVICE_PATH, serviceResponseHeaders, requirePayment);
  app.post(SERVICE_PATH, express.json({ limit: "32kb", strict: true }), compileHandler);
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
