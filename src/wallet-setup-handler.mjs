import { createHash } from "node:crypto";

import { walletSetupScaffold } from "./wallet-setup-scaffold.mjs";
export { browserSetupConfigured } from "./wallet-setup-config.mjs";
import { browserSetupConfigured } from "./wallet-setup-config.mjs";
import { builderCredentialsFromEnvironment } from "./polymarket-builder-credentials.mjs";
import { createPolymarketRelayerProxy } from "./polymarket-relayer-proxy.mjs";
import { createPublicApiGuard, PublicApiError } from "./public-api-guard.mjs";
import { createWalletSetupStateFromEnvironment } from "./wallet-setup-state.mjs";

const BUILDER_AUTH_CACHE_TTL_MILLISECONDS = 60_000;
const BUILDER_AUTH_CACHE_TTL_SECONDS = 60;
const BUILDER_AUTH_LOCK_TTL_SECONDS = 30;
const BUILDER_AUTH_LOCK_WAIT_MILLISECONDS = 2_500;
const BUILDER_AUTH_LOCK_POLL_MILLISECONDS = 100;
const BUILDER_AUTH_STATUS_NAMESPACE = "builder-authorization-status";
const BUILDER_AUTH_LOCK_NAMESPACE = "builder-authorization-probe";
const publicGuard = createPublicApiGuard({
  limit: 6,
  maxBodyBytes: 256,
  maxInFlight: 2,
});

function requireState(state) {
  for (const method of ["claimOnce", "put", "get"]) {
    if (typeof state?.[method] !== "function") {
      throw new TypeError("builder authorization state must implement claimOnce, put, and get");
    }
  }
  return state;
}

function cachedAuthorization(record) {
  return typeof record?.authorized === "boolean" ? record.authorized : undefined;
}

async function persistAuthorization(state, statusId, authorized) {
  try {
    await state.put(
      BUILDER_AUTH_STATUS_NAMESPACE,
      statusId,
      { authorized },
      BUILDER_AUTH_CACHE_TTL_SECONDS,
    );
  } catch {
    // The public route must still fail closed if its best-effort cache is unavailable.
  }
}

function authorizationStatusId(credentials, environment) {
  const environmentScope = typeof environment?.VERCEL_ENV === "string" && environment.VERCEL_ENV.length > 0
    ? environment.VERCEL_ENV
    : "unspecified";
  const deploymentScope = typeof environment?.VERCEL_DEPLOYMENT_ID === "string" && environment.VERCEL_DEPLOYMENT_ID.length > 0
    ? environment.VERCEL_DEPLOYMENT_ID
    : "unspecified";
  return createHash("sha256")
    .update(JSON.stringify({
      environmentScope,
      deploymentScope,
      key: credentials.key,
      secret: credentials.secret,
      passphrase: credentials.passphrase,
    }))
    .digest("hex");
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitForAuthorizationStatus({ state, statusId, wait }) {
  const attempts = Math.ceil(BUILDER_AUTH_LOCK_WAIT_MILLISECONDS / BUILDER_AUTH_LOCK_POLL_MILLISECONDS);
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    await wait(BUILDER_AUTH_LOCK_POLL_MILLISECONDS);
    const stored = cachedAuthorization(
      await state.get(BUILDER_AUTH_STATUS_NAMESPACE, statusId),
    );
    if (stored !== undefined) return stored;
  }
  return undefined;
}

export function createBuilderAuthorizationProbe({
  environment = process.env,
  createRelayer = createPolymarketRelayerProxy,
  now = () => Date.now(),
  wait = sleep,
  cacheTtlMilliseconds = BUILDER_AUTH_CACHE_TTL_MILLISECONDS,
  state,
} = {}) {
  if (typeof createRelayer !== "function" || typeof now !== "function" || typeof wait !== "function") {
    throw new TypeError("createRelayer, now, and wait must be functions");
  }
  if (!Number.isSafeInteger(cacheTtlMilliseconds) || cacheTtlMilliseconds <= 0) {
    throw new TypeError("cacheTtlMilliseconds must be a positive safe integer");
  }
  const statusState = requireState(state);
  let cached;
  let cachedUntil = 0;
  let inFlight;
  return async function builderAuthorization() {
    const currentTime = now();
    if (cached !== undefined && currentTime < cachedUntil) return cached;
    if (!inFlight) {
      inFlight = (async () => {
        let authorized = false;
        try {
          const credentials = builderCredentialsFromEnvironment(environment);
          if (!credentials) return false;
          const statusId = authorizationStatusId(credentials, environment);
          const stored = cachedAuthorization(
            await statusState.get(BUILDER_AUTH_STATUS_NAMESPACE, statusId),
          );
          if (stored !== undefined) {
            cached = stored;
            cachedUntil = now() + cacheTtlMilliseconds;
            return stored;
          }
          const claimed = await statusState.claimOnce(
            BUILDER_AUTH_LOCK_NAMESPACE,
            statusId,
            BUILDER_AUTH_LOCK_TTL_SECONDS,
          );
          if (!claimed) {
            const contenderResult = await waitForAuthorizationStatus({
              state: statusState,
              statusId,
              wait,
            });
            if (contenderResult !== undefined) {
              cached = contenderResult;
              cachedUntil = now() + cacheTtlMilliseconds;
              return contenderResult;
            }
            return false;
          }
          const relayer = createRelayer({ credentials });
          let result;
          try {
            result = await relayer.run({ operation: "builder-auth", body: {} });
          } catch {
            await persistAuthorization(statusState, statusId, false);
            cached = false;
            cachedUntil = now() + cacheTtlMilliseconds;
            return false;
          }
          authorized = result?.ok === true && result.authentication === "builder";
          await persistAuthorization(statusState, statusId, authorized);
          cached = authorized;
          cachedUntil = now() + cacheTtlMilliseconds;
          return authorized;
        } catch {
          authorized = false;
        }
        return authorized;
      })().finally(() => {
        inFlight = undefined;
      });
    }
    return inFlight;
  };
}

export function createWalletSetupHandler({
  scaffold = walletSetupScaffold,
  environment = process.env,
  configured = browserSetupConfigured(environment),
  state,
  apiGuard = publicGuard,
  builderAuthorization,
} = {}) {
  let authorization = builderAuthorization;
  if (authorization === undefined) {
    try {
      authorization = createBuilderAuthorizationProbe({
        environment,
        state: state || createWalletSetupStateFromEnvironment(environment),
      });
    } catch {
      authorization = async () => false;
    }
  }
  if (typeof authorization !== "function" || typeof apiGuard?.run !== "function") {
    throw new TypeError("builderAuthorization must be a function");
  }
  return async function handler(request, response) {
    if (!["GET", "HEAD"].includes(request.method)) {
      response.setHeader("allow", "GET, HEAD");
      return response.status(405).json({ ok: false, error: { code: "method_not_allowed" } });
    }
    response.setHeader("cache-control", "no-store");
    response.setHeader("content-type", "application/json; charset=utf-8");
    if (request.method === "HEAD") return response.status(200).end();
    if (!configured) return response.status(200).json(scaffold({ configured: false }));
    try {
      return await apiGuard.run(request, async () => {
        let builderAuthorized = false;
        try {
          builderAuthorized = await authorization();
        } catch {
          builderAuthorized = false;
        }
        return response.status(200).json(scaffold({ configured: true, builderAuthorized }));
      });
    } catch (error) {
      if (error instanceof PublicApiError) {
        if (error.details?.retryAfterSeconds) {
          response.setHeader("retry-after", String(error.details.retryAfterSeconds));
        }
        return response.status(error.status).json({
          ok: false,
          error: { code: error.code, message: error.message },
        });
      }
      return response.status(200).json(scaffold({ configured: true, builderAuthorized: false }));
    }
  };
}
