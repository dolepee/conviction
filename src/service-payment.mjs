import { OKXFacilitatorClient } from "@okxweb3/x402-core";
import {
  paymentMiddlewareFromHTTPServer,
  x402HTTPResourceServer,
  x402ResourceServer,
} from "@okxweb3/x402-express";
import { ExactEvmScheme } from "@okxweb3/x402-evm/exact/server";

import { createTelegramNotifier } from "./telegram-notifier.mjs";

export const SERVICE_PATH = "/api/service";
export const SERVICE_RESOURCE = "https://conviction-bay.vercel.app/api/service";
export const SERVICE_NETWORK = "eip155:196";
export const SERVICE_ASSET = "0x779ded0c9e1022225f8e0630b35a9b54be713736";
export const SERVICE_PAYEE = "0x79e23e61a754901d53e55202e311f295a85fa070";
export const SERVICE_PRICE_ATOMIC = "50000";
export const SERVICE_PRICE_DISPLAY = "0.05 USD₮0";

const SERVICE_PAYWALL_HTML = `<!doctype html>
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
        <p>This machine endpoint costs exactly 0.05 USD₮0 on X Layer per successfully delivered bounded YES/NO position card.</p>
        <p>Call it through an x402-compatible client or use the free interactive preview on the Conviction home page.</p>
        <a class="button button-primary" href="/">Open Conviction</a>
      </div>
    </main>
  </body>
</html>`;

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

export function serviceRouteConfiguration() {
  return Object.freeze({
    [`* ${SERVICE_PATH}`]: {
      accepts: {
        scheme: "exact",
        network: SERVICE_NETWORK,
        payTo: SERVICE_PAYEE,
        price: {
          amount: SERVICE_PRICE_ATOMIC,
          asset: SERVICE_ASSET,
          extra: { name: "USD₮0", version: "1" },
        },
        maxTimeoutSeconds: 300,
      },
      resource: SERVICE_RESOURCE,
      description: "Create one ready-to-sign, fee-inclusive YES or NO position card",
      mimeType: "application/json",
      customPaywallHtml: SERVICE_PAYWALL_HTML,
      unpaidResponseBody: () => ({
        contentType: "application/json",
        body: {
          ok: false,
          error: {
            code: "payment_required",
            message: `Payment of ${SERVICE_PRICE_DISPLAY} is required to create a position card`,
          },
        },
      }),
      settlementFailedResponseBody: () => ({
        contentType: "application/json",
        body: {
          ok: false,
          error: {
            code: "payment_settlement_failed",
            message: "Payment could not be settled; the position card was not delivered",
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
          requestContext?.path !== SERVICE_PATH ||
          result?.success !== true ||
          result?.status !== "success" ||
          typeof result?.transaction !== "string" ||
          !result.transaction ||
          result.network !== SERVICE_NETWORK ||
          requirements?.network !== SERVICE_NETWORK ||
          requirements?.amount !== SERVICE_PRICE_ATOMIC ||
          requirements?.asset !== SERVICE_ASSET ||
          requirements?.payTo?.toLowerCase() !== SERVICE_PAYEE ||
          !responseBody
        ) {
          return;
        }

        const delivered = JSON.parse(responseBody.toString("utf8"));
        if (delivered?.ok !== true) return;

        await notifyPaidCall({
          serviceName: "Bounded YES/NO Position Card",
          amount: SERVICE_PRICE_DISPLAY,
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
    serviceRouteConfiguration(),
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
