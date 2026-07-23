import { OKXFacilitatorClient } from "@okxweb3/x402-core";
import {
  paymentMiddlewareFromHTTPServer,
  x402HTTPResourceServer,
  x402ResourceServer,
} from "@okxweb3/x402-express";
import { ExactEvmScheme } from "@okxweb3/x402-evm/exact/server";

import { createTelegramNotifier } from "./telegram-notifier.mjs";
import {
  MANAGE_SERVICE_PATH,
  MANAGE_SERVICE_PRICE_ATOMIC,
  MANAGE_SERVICE_PRICE_DISPLAY,
  MANAGE_SERVICE_RESOURCE,
  SERVICE_ASSET,
  SERVICE_NETWORK,
  SERVICE_PATH,
  SERVICE_PAYEE,
  SERVICE_PAYMENT_TIMEOUT_SECONDS,
  SERVICE_PRICE_ATOMIC,
  SERVICE_PRICE_DISPLAY,
  SERVICE_RESOURCE,
} from "./service-constants.mjs";

export {
  MANAGE_SERVICE_PATH,
  MANAGE_SERVICE_PRICE_ATOMIC,
  MANAGE_SERVICE_PRICE_DISPLAY,
  MANAGE_SERVICE_RESOURCE,
  SERVICE_ASSET,
  SERVICE_NETWORK,
  SERVICE_PATH,
  SERVICE_PAYEE,
  SERVICE_PAYMENT_TIMEOUT_SECONDS,
  SERVICE_PRICE_ATOMIC,
  SERVICE_PRICE_DISPLAY,
  SERVICE_RESOURCE,
} from "./service-constants.mjs";

export const POSITION_CARD_SERVICE = Object.freeze({
  path: SERVICE_PATH,
  resource: SERVICE_RESOURCE,
  priceAtomic: SERVICE_PRICE_ATOMIC,
  priceDisplay: SERVICE_PRICE_DISPLAY,
  serviceName: "Bounded YES/NO Position Card",
  description: "Create one ready-to-sign, fee-inclusive YES or NO position card. First call POST /api/readiness; only a request that passes ready-deposit-wallet identity preflight is eligible for an x402 payment challenge.",
  deliveryNoun: "position card",
  previewHtml: "Use the free interactive OPEN preview on the Conviction home page.",
  previewHref: "/#try",
  previewLabel: "Open the free OPEN preview",
  outputSchema: Object.freeze({
    input: Object.freeze({
      type: "http",
      method: "POST",
      bodyType: "json",
      body: Object.freeze({
        $schema: "https://json-schema.org/draft/2020-12/schema",
        type: "object",
        properties: Object.freeze({
          market: Object.freeze({
            type: "string",
            description: "Polymarket event URL, slug, or condition ID.",
          }),
          outcome: Object.freeze({
            type: "string",
            enum: Object.freeze(["YES", "NO", "yes", "no"]),
          }),
          spend: Object.freeze({
            type: "string",
            description: "Fee-inclusive pUSD budget as a decimal string; minimum 1.",
          }),
          maxPrice: Object.freeze({
            type: "string",
            description: "Hard per-share price ceiling as a decimal string between 0 and 1.",
          }),
          wallet: Object.freeze({
            type: "string",
            pattern: "^0x[0-9a-fA-F]{40}$",
            description: "Buyer-controlled, maker-eligible Polymarket deposit wallet.",
          }),
          executionMode: Object.freeze({
            type: "string",
            const: "deposit-wallet",
            description: "OPEN is charged only for an already-ready deposit wallet.",
          }),
          walletReadiness: Object.freeze({
            type: "object",
            description: "Successful official polymarket-plugin quickstart result proving this exact ready deposit wallet. Both flat and { data: ... } official envelopes are accepted.",
            anyOf: Object.freeze([
              Object.freeze({
                required: Object.freeze(["ok", "accessible", "status", "wallet"]),
                properties: Object.freeze({
                  ok: Object.freeze({ const: true }),
                  accessible: Object.freeze({ const: true }),
                  status: Object.freeze({ enum: Object.freeze(["deposit_wallet_ready", "active"]) }),
                  wallet: Object.freeze({
                    type: "object",
                    required: Object.freeze(["eoa", "deposit_wallet"]),
                    properties: Object.freeze({
                      eoa: Object.freeze({ type: "string", pattern: "^0x[0-9a-fA-F]{40}$" }),
                      deposit_wallet: Object.freeze({ type: "string", pattern: "^0x[0-9a-fA-F]{40}$" }),
                    }),
                  }),
                }),
              }),
              Object.freeze({
                required: Object.freeze(["ok", "data"]),
                properties: Object.freeze({
                  ok: Object.freeze({ const: true }),
                  data: Object.freeze({
                    type: "object",
                    required: Object.freeze(["accessible", "status", "wallet"]),
                    properties: Object.freeze({
                      accessible: Object.freeze({ const: true }),
                      status: Object.freeze({ enum: Object.freeze(["deposit_wallet_ready", "active"]) }),
                      wallet: Object.freeze({
                        type: "object",
                        required: Object.freeze(["eoa", "deposit_wallet"]),
                        properties: Object.freeze({
                          eoa: Object.freeze({ type: "string", pattern: "^0x[0-9a-fA-F]{40}$" }),
                          deposit_wallet: Object.freeze({ type: "string", pattern: "^0x[0-9a-fA-F]{40}$" }),
                        }),
                      }),
                    }),
                  }),
                }),
              }),
            ]),
          }),
          pluginPreview: Object.freeze({
            type: "object",
            description: "Successful official polymarket-plugin v0.7.0 dry-run for these exact bounds. It must be a standard V2 FAK BUY and prove no order was submitted.",
            required: Object.freeze(["ok", "dry_run", "data"]),
            properties: Object.freeze({
              ok: Object.freeze({ const: true }),
              dry_run: Object.freeze({ const: true }),
              data: Object.freeze({
                type: "object",
                required: Object.freeze([
                  "clob_version",
                  "collateral_token",
                  "condition_id",
                  "exchange_address",
                  "expires",
                  "fee_rate_bps",
                  "limit_price",
                  "neg_risk",
                  "note",
                  "order_type",
                  "outcome",
                  "post_only",
                  "shares",
                  "side",
                  "token_id",
                  "usdc_amount",
                  "usdc_requested",
                ]),
                properties: Object.freeze({
                  clob_version: Object.freeze({ const: "V2" }),
                  expires: Object.freeze({ const: null }),
                  neg_risk: Object.freeze({ const: false }),
                  note: Object.freeze({ const: "dry-run: order not submitted" }),
                  order_type: Object.freeze({ const: "FAK" }),
                  post_only: Object.freeze({ const: false }),
                  side: Object.freeze({ const: "BUY" }),
                }),
              }),
            }),
          }),
          rationale: Object.freeze({
            type: "string",
            description: "Optional buyer-authored rationale, 20 to 500 characters when present.",
          }),
        }),
        required: Object.freeze([
          "market",
          "outcome",
          "spend",
          "maxPrice",
          "wallet",
          "executionMode",
          "walletReadiness",
          "pluginPreview",
        ]),
        additionalProperties: true,
      }),
    }),
    output: Object.freeze({
      type: "json",
      description: "Issuer-signed, wallet-bound Conviction OPEN card.",
    }),
  }),
});

export const POSITION_MANAGER_SERVICE = Object.freeze({
  path: MANAGE_SERVICE_PATH,
  resource: MANAGE_SERVICE_RESOURCE,
  priceAtomic: MANAGE_SERVICE_PRICE_ATOMIC,
  priceDisplay: MANAGE_SERVICE_PRICE_DISPLAY,
  serviceName: "Bounded Position Manager",
  description: "Create one source-bound bounded CLOSE or TAKE_PROFIT card",
  deliveryNoun: "bounded position-manager card",
  previewHtml: "Use the repository-backed buyer agent/CLI, or send the same JSON to <code>/api/manage-preview</code> for a free non-executable manager preview.",
  previewHref: "/#manage",
  previewLabel: "See Position Manager",
  outputSchema: Object.freeze({
    input: Object.freeze({
      type: "http",
      method: "POST",
      bodyType: "json",
      body: Object.freeze({
        $schema: "https://json-schema.org/draft/2020-12/schema",
        type: "object",
        properties: Object.freeze({
          action: Object.freeze({
            type: "string",
            enum: Object.freeze(["CLOSE", "TAKE_PROFIT", "close", "take_profit"]),
          }),
          market: Object.freeze({
            type: "string",
            description: "The same Polymarket URL, slug, or condition ID as the OPEN proof.",
          }),
          outcome: Object.freeze({
            type: "string",
            enum: Object.freeze(["YES", "NO", "yes", "no"]),
          }),
          wallet: Object.freeze({
            type: "string",
            pattern: "^0x[0-9a-fA-F]{40}$",
            description: "Buyer-controlled wallet that owns the verified position.",
          }),
          shares: Object.freeze({
            type: "string",
            description: "Exact whole shares to manage.",
          }),
          minPrice: Object.freeze({
            type: "string",
            description: "Required for CLOSE: hard minimum sale price.",
          }),
          targetPrice: Object.freeze({
            type: "string",
            description: "Required for TAKE_PROFIT: post-only target price.",
          }),
          venueExpiresAt: Object.freeze({
            type: "string",
            description: "Required for TAKE_PROFIT: canonical UTC expiry.",
          }),
          sourcePosition: Object.freeze({
            type: "object",
            description: "Complete issuer-signed verified OPEN proof returned by Conviction.",
          }),
          rationale: Object.freeze({
            type: "string",
            description: "Optional buyer-authored rationale, 20 to 500 characters when present.",
          }),
        }),
        required: Object.freeze([
          "action",
          "market",
          "outcome",
          "wallet",
          "shares",
          "sourcePosition",
        ]),
        additionalProperties: true,
        allOf: Object.freeze([
          Object.freeze({
            if: Object.freeze({
              properties: Object.freeze({ action: Object.freeze({ enum: Object.freeze(["CLOSE", "close"]) }) }),
              required: Object.freeze(["action"]),
            }),
            then: Object.freeze({ required: Object.freeze(["minPrice"]) }),
          }),
          Object.freeze({
            if: Object.freeze({
              properties: Object.freeze({ action: Object.freeze({ enum: Object.freeze(["TAKE_PROFIT", "take_profit"]) }) }),
              required: Object.freeze(["action"]),
            }),
            then: Object.freeze({ required: Object.freeze(["targetPrice", "venueExpiresAt"]) }),
          }),
        ]),
      }),
    }),
    output: Object.freeze({
      type: "json",
      description: "Issuer-signed CLOSE or TAKE_PROFIT card bound to a verified OPEN proof.",
    }),
  }),
});

export function requirePinnedServiceOrigin(value, service = POSITION_CARD_SERVICE) {
  let supplied;
  let expected;
  try {
    supplied = new URL(String(value || ""));
    expected = new URL(service.resource);
  } catch {
    throw Object.assign(new Error("Service origin is not a valid absolute URL"), {
      code: "invalid_service_origin",
    });
  }
  if (
    supplied.username || supplied.password || supplied.pathname !== "/" ||
    supplied.search || supplied.hash || supplied.origin !== expected.origin
  ) {
    throw Object.assign(
      new Error(`Service origin must be exactly ${expected.origin}`),
      { code: "untrusted_service_origin" },
    );
  }
  return expected.origin;
}

export function pinnedServiceUrl(service = POSITION_CARD_SERVICE, path = service.path) {
  const resource = new URL(service.resource);
  if (path === service.path) return resource.toString();
  if (typeof path !== "string" || !path.startsWith("/") || path.startsWith("//")) {
    throw Object.assign(new Error("Service sibling path must be an absolute path on the pinned origin"), {
      code: "invalid_service_path",
    });
  }
  const sibling = new URL(path, resource.origin);
  if (sibling.origin !== resource.origin) {
    throw Object.assign(new Error("Service sibling escaped the pinned origin"), {
      code: "invalid_service_path",
    });
  }
  return sibling.toString();
}

function servicePaywallHtml(service) {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Conviction service payment</title>
    <link rel="stylesheet" href="/styles.css" />
  </head>
  <body>
    <main class="compiler-section">
      <div class="section-heading">
        <p class="eyebrow">Conviction API</p>
        <h1>Payment required</h1>
        <p>This machine endpoint costs exactly ${service.priceDisplay} on X Layer per successfully delivered ${service.deliveryNoun}.</p>
        <p>Call it through an x402-compatible client. ${service.previewHtml}</p>
        <a class="button button-primary" href="${service.previewHref}">${service.previewLabel}</a>
      </div>
    </main>
  </body>
</html>`;
}

const REQUIRED_CREDENTIALS = Object.freeze([
  "OKX_API_KEY",
  "OKX_SECRET_KEY",
  "OKX_PASSPHRASE",
]);

export function readFacilitatorCredentials(environment) {
  const credentials = {};
  const missing = [];
  const padded = [];

  for (const name of REQUIRED_CREDENTIALS) {
    const value = typeof environment[name] === "string" ? environment[name] : "";
    if (!value.trim()) {
      missing.push(name);
    } else if (value !== value.trim()) {
      padded.push(name);
    } else {
      credentials[name] = value;
    }
  }

  if (missing.length > 0 || padded.length > 0) {
    const error = new Error("Payment service credentials are incomplete");
    error.code = "payment_configuration_error";
    error.missing = missing;
    error.padded = padded;
    throw error;
  }

  return Object.freeze({
    apiKey: credentials.OKX_API_KEY,
    secretKey: credentials.OKX_SECRET_KEY,
    passphrase: credentials.OKX_PASSPHRASE,
    syncSettle: true,
  });
}

export function serviceRouteConfiguration(service = POSITION_CARD_SERVICE) {
  return Object.freeze({
    [`* ${service.path}`]: {
      accepts: {
        scheme: "exact",
        network: SERVICE_NETWORK,
        payTo: SERVICE_PAYEE,
        price: {
          amount: service.priceAtomic,
          asset: SERVICE_ASSET,
          extra: { name: "USD₮0", version: "1" },
        },
        maxTimeoutSeconds: SERVICE_PAYMENT_TIMEOUT_SECONDS,
      },
      resource: service.resource,
      description: service.description,
      mimeType: "application/json",
      extensions: {
        outputSchema: service.outputSchema,
      },
      customPaywallHtml: servicePaywallHtml(service),
      unpaidResponseBody: () => ({
        contentType: "application/json",
        body: {
          ok: false,
          error: {
            code: "payment_required",
            message: `Payment of ${service.priceDisplay} is required to create a ${service.deliveryNoun}`,
          },
        },
      }),
      settlementFailedResponseBody: () => ({
        contentType: "application/json",
        body: {
          ok: false,
          error: {
            code: "payment_settlement_failed",
            message: `Payment could not be settled; the ${service.deliveryNoun} was not delivered`,
          },
        },
      }),
    },
  });
}

export function createPaymentGate(
  environment,
  {
    facilitatorClient = undefined,
    logger = console,
    notifyPaidCall = createTelegramNotifier(environment),
    service = POSITION_CARD_SERVICE,
  } = {},
) {
  const credentials = readFacilitatorCredentials(environment);
  const facilitator =
    facilitatorClient ?? new OKXFacilitatorClient(credentials);
  const resourceServer = new x402ResourceServer(facilitator)
    .register(SERVICE_NETWORK, new ExactEvmScheme())
    .registerExtension({
      key: "outputSchema",
      async enrichPaymentRequiredResponse(schema, context) {
        // OKX A2MCP discovers paid-replay parameters from Bazaar's
        // `outputSchema.input`. The current x402 SDK exposes extension hooks
        // but does not yet model this Bazaar field, so enrich the top-level
        // wire response consumed by current OKX clients.
        context.paymentRequiredResponse.outputSchema = schema;
        return schema;
      },
    })
    .onAfterSettle(async ({ result, requirements, transportContext }) => {
      try {
        const requestContext = transportContext?.request;
        const responseBody = transportContext?.responseBody;
        if (
          requestContext?.method !== "POST" ||
          requestContext?.path !== service.path ||
          result?.success !== true ||
          result?.status !== "success" ||
          typeof result?.transaction !== "string" ||
          !result.transaction ||
          result.network !== SERVICE_NETWORK ||
          requirements?.network !== SERVICE_NETWORK ||
          requirements?.amount !== service.priceAtomic ||
          requirements?.asset !== SERVICE_ASSET ||
          requirements?.payTo?.toLowerCase() !== SERVICE_PAYEE ||
          !responseBody
        ) {
          return;
        }

        const delivered = JSON.parse(responseBody.toString("utf8"));
        if (delivered?.ok !== true) return;

        await notifyPaidCall({
          serviceName: service.serviceName,
          amount: service.priceDisplay,
          network: SERVICE_NETWORK,
          transaction: result.transaction,
          settledAt: new Date().toISOString(),
        });
      } catch (error) {
        try {
          logger.error("paid call notification failed", {
            name: error?.name,
            code: error?.code,
            status: error?.status,
          });
        } catch {}
      }
    })
    .onVerifyFailure(async ({ error }) => {
      logger.error("payment verification failed", {
        name: error?.name,
        code: error?.code,
        message: error?.message,
      });
    })
    .onSettleFailure(async ({ error }) => {
      logger.error("payment settlement failed", {
        name: error?.name,
        code: error?.code,
        message: error?.message,
      });
    });
  const httpServer = new x402HTTPResourceServer(
    resourceServer,
    serviceRouteConfiguration(service),
  );
  const middleware = paymentMiddlewareFromHTTPServer(
    httpServer,
    undefined,
    undefined,
    false,
  );

  let initialized = false;
  let initializationPromise;

  async function ensureInitialized() {
    if (initialized) return;
    if (!initializationPromise) {
      initializationPromise = httpServer
        .initialize()
        .then(() => {
          initialized = true;
        })
        .catch((error) => {
          initializationPromise = undefined;
          throw error;
        });
    }
    await initializationPromise;
  }

  return async function paymentGate(request, response, next) {
    try {
      await ensureInitialized();
      return middleware(request, response, next);
    } catch (error) {
      logger.error("payment service initialization failed", {
        name: error?.name,
        code: error?.code,
      });
      response.setHeader("cache-control", "no-store");
      return response.status(503).json({
        ok: false,
        error: {
          code: "payment_service_unavailable",
          message: "Payment verification is temporarily unavailable",
        },
      });
    }
  };
}
