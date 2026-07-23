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
  description: "Create one ready-to-sign, fee-inclusive YES or NO position card",
  deliveryNoun: "position card",
  previewHtml: "Use the free interactive OPEN preview on the Conviction home page.",
  previewHref: "/#try",
  previewLabel: "Open the free OPEN preview",
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
