import express from "express";

import { compileCloseIntent } from "../src/exit-intent-compiler.mjs";
import { compileTakeProfitIntent } from "../src/take-profit-intent-compiler.mjs";
import { ConvictionError } from "../src/errors.mjs";
import {
  createEnvironmentIntentIssuer,
  trustedIssuerRegistryFromEnvironment,
} from "../src/intent-issuer.mjs";
import { resolveMarket } from "../src/market-client.mjs";
import { fetchPositionSnapshot } from "../src/position-client.mjs";
import {
  createPaymentGate,
  MANAGE_SERVICE_PATH,
  POSITION_MANAGER_SERVICE,
} from "../src/service-payment.mjs";
import { verifySourcePosition } from "../src/source-position.mjs";

export const MANAGE_QUOTE_TTL_MS = 300_000;

function normalizeManagerAction(value) {
  const action = String(value ?? "").trim().toUpperCase();
  if (action !== "CLOSE" && action !== "TAKE_PROFIT") {
    throw new ConvictionError(
      "unsupported_manager_action",
      "action must be CLOSE or TAKE_PROFIT",
    );
  }
  return action;
}

function send(response, status, body) {
  response.status(status).setHeader("content-type", "application/json; charset=utf-8");
  response.setHeader("cache-control", "no-store");
  response.end(JSON.stringify(body));
}

export function createManageHandler({
  environment = process.env,
  issueIntentImpl = undefined,
  trustedIssuers = undefined,
  resolveMarketImpl = resolveMarket,
  verifySourceImpl = verifySourcePosition,
  fetchPositionImpl = fetchPositionSnapshot,
  compileOptions = {
    maxSnapshotAgeMs: 30_000,
    quoteTtlMs: MANAGE_QUOTE_TTL_MS,
  },
} = {}) {
  const issue = issueIntentImpl ?? createEnvironmentIntentIssuer(environment);
  const trusted = trustedIssuers ?? trustedIssuerRegistryFromEnvironment(environment);
  return async function manageHandler(request, response) {
    if (request.method !== "POST") {
      response.setHeader("allow", "POST");
      return send(response, 405, { ok: false, error: { code: "method_not_allowed" } });
    }
    try {
      const body = request.body && typeof request.body === "object" ? request.body : {};
      const action = normalizeManagerAction(body.action);
      const [market, source] = await Promise.all([
        resolveMarketImpl(body.market, { outcome: body.outcome }),
        verifySourceImpl(body.sourcePosition, { trustedIssuers: trusted }),
      ]);
      const compileIntent = action === "TAKE_PROFIT" ? compileTakeProfitIntent : compileCloseIntent;
      const compile = (position) => compileIntent(
        {
          ...body,
          action,
          source,
        },
        market,
        position,
        compileOptions,
      );
      let position = await fetchPositionImpl(body.wallet, market.outcomeTokenId);
      let compilation;
      try {
        compilation = compile(position);
      } catch (error) {
        if (!(error instanceof ConvictionError) || error.code !== "stale_position_snapshot") {
          throw error;
        }
        // Public RPC load balancers can briefly serve a lagging `latest` head.
        // Preserve the 30-second safety bound and refetch once; a second stale
        // snapshot still fails closed and, because this is a 4xx response, x402
        // does not settle the signed payment authorization.
        position = await fetchPositionImpl(body.wallet, market.outcomeTokenId);
        compilation = compile(position);
      }
      return send(response, 200, await issue(compilation));
    } catch (error) {
      if (error instanceof ConvictionError) {
        const upstream = ["market_api_error", "rpc_error"].includes(error.code);
        return send(response, upstream ? 502 : 422, {
          ok: false,
          error: { code: error.code, message: error.message, details: error.details },
        });
      }
      console.error("manage handler failed", { name: error?.name, code: error?.code });
      return send(response, 500, {
        ok: false,
        error: { code: "internal_error", message: "Bounded position-management compilation failed" },
      });
    }
  };
}

export function createManageApp(
  environment = process.env,
  {
    facilitatorClient = undefined,
    logger = console,
    manageHandler = undefined,
    notifyPaidCall = undefined,
    now = Date.now,
  } = {},
) {
  const app = express();
  app.disable("x-powered-by");
  app.set("case sensitive routing", true);
  app.set("strict routing", true);

  let paymentGate;
  let paymentConfigurationError;
  let resolvedManageHandler = manageHandler;
  try {
    if (!resolvedManageHandler) {
      resolvedManageHandler = createManageHandler({
        environment,
        issueIntentImpl: createEnvironmentIntentIssuer(environment, { now }),
      });
    }
    paymentGate = createPaymentGate(environment, {
      facilitatorClient,
      logger,
      notifyPaidCall,
      service: POSITION_MANAGER_SERVICE,
    });
  } catch (error) {
    paymentConfigurationError = error;
  }

  async function requirePayment(request, response, next) {
    if (!paymentGate) {
      if (paymentConfigurationError) {
        logger.error("position manager configuration failed", {
          name: paymentConfigurationError?.name,
          code: paymentConfigurationError?.code,
        });
        paymentConfigurationError = undefined;
      }
      response.setHeader("cache-control", "no-store");
      return response.status(503).json({
        ok: false,
        error: { code: "payment_service_unavailable", message: "Position manager is temporarily unavailable" },
      });
    }
    return paymentGate(request, response, next);
  }

  function responseHeaders(request, response, next) {
    response.setHeader("cache-control", "no-store");
    response.vary("Accept");
    response.vary("PAYMENT-SIGNATURE");
    response.vary("X-PAYMENT");
    next();
  }

  app.all(MANAGE_SERVICE_PATH, responseHeaders, requirePayment);
  app.post(
    MANAGE_SERVICE_PATH,
    express.json({ limit: "64kb", strict: true }),
    resolvedManageHandler ?? ((request, response) => response.status(503).json({
      ok: false,
      error: { code: "service_configuration_error", message: "Position manager is temporarily unavailable" },
    })),
  );
  app.all(MANAGE_SERVICE_PATH, (request, response) => {
    response.setHeader("allow", "POST");
    return response.status(405).json({ ok: false, error: { code: "method_not_allowed" } });
  });

  app.use((error, request, response, next) => {
    if (response.headersSent) return next(error);
    if (error?.type === "entity.too.large") {
      return send(response, 413, { ok: false, error: { code: "payload_too_large", message: "Request body exceeds 64 KB" } });
    }
    if (error?.type === "entity.parse.failed") {
      return send(response, 400, { ok: false, error: { code: "invalid_json", message: "Request body must be valid JSON" } });
    }
    logger.error("position manager failed", { name: error?.name, code: error?.code });
    return send(response, 500, { ok: false, error: { code: "internal_error", message: "Position manager request failed" } });
  });

  return app;
}

export default createManageApp();
