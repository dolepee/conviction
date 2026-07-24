import assert from "node:assert/strict";
import test from "node:test";

import {
  browserSetupConfigured,
  createBuilderAuthorizationProbe,
  createWalletSetupHandler,
} from "../src/wallet-setup-handler.mjs";
import { createPublicApiGuard } from "../src/public-api-guard.mjs";
import { createInMemoryWalletSetupState } from "../src/wallet-setup-state.mjs";
import {
  WALLET_SETUP_SCAFFOLD_VERSION,
  walletSetupScaffold,
} from "../src/wallet-setup-scaffold.mjs";
import { APPROVAL_DISCLOSURE } from "../src/buyer-readiness.mjs";

function response() {
  return {
    headers: {},
    statusCode: null,
    body: null,
    setHeader(name, value) { this.headers[name.toLowerCase()] = value; return this; },
    status(value) { this.statusCode = value; return this; },
    json(value) { this.body = value; return this; },
    end() { this.ended = true; return this; },
  };
}

test("wallet setup scaffold is a frozen no-write feasibility contract", () => {
  const result = walletSetupScaffold();
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.actions), true);
  assert.equal(Object.isFrozen(result.compatibility), true);
  assert.equal(Object.isFrozen(result.approvalDisclosure), true);
  assert.equal(result.version, WALLET_SETUP_SCAFFOLD_VERSION);
  assert.equal(result.status, "BROWSER_SETUP_REQUIRES_ACTIVATION");
  assert.equal(result.readOnly, true);
  assert.equal(result.paymentAllowed, false);
  assert.equal(result.chainWritesAllowed, false);
  assert.equal(result.credentialsAccepted, false);
  assert.equal(result.buyerKeysAccepted, false);
  assert.deepEqual(result.actions, {
    connect: false,
    deploy: false,
    approve: false,
    fund: false,
    bridge: false,
    pay: false,
    trade: false,
  });
  assert.equal(result.browserSetup.chainId, 137);
  assert.equal(result.browserSetup.approvalCalls.length, 5);
  assert.strictEqual(result.approvalDisclosure, APPROVAL_DISCLOSURE);
  assert.equal(result.approvalDisclosure.pUsdAllowances, 2);
  assert.equal(result.approvalDisclosure.ctfOperatorApprovals, 3);
  assert.equal(result.approvalDisclosure.revokeCommandAvailable, false);
  assert.equal(result.approvalDisclosure.convictionCanBypassWalletPolicy, false);
  assert.match(result.compatibility.currentNativeOkxExecutor, /existing agent\/plugin route/);
  assert.equal(result.compatibility.xLayerPayment, "inactive");
  assert.match(result.notice, /Do not fund a new wallet/);
});

test("activated wallet setup publishes setup plus buyer-local payment and OPEN", () => {
  const result = walletSetupScaffold({ configured: true, builderAuthorized: true });
  assert.equal(result.status, "BROWSER_SETUP_BETA_READY");
  assert.equal(result.readOnly, false);
  assert.equal(result.paymentAllowed, true);
  assert.equal(result.chainWritesAllowed, true);
  assert.equal(result.actions.connect, true);
  assert.equal(result.actions.deploy, true);
  assert.equal(result.actions.approve, true);
  assert.equal(result.actions.fund, false);
  assert.equal(result.actions.pay, true);
  assert.equal(result.actions.trade, true);
  assert.equal(result.browserSetup.consents.length, 2);
  assert.match(result.notice, /read-only relayer check/);
  assert.match(result.notice, /separate trade confirmation/);
});

test("Builder-unavailable setup is an explicit no-write contract", () => {
  const result = walletSetupScaffold({ configured: true, builderAuthorized: false });
  assert.equal(result.status, "BROWSER_SETUP_AUTH_UNAVAILABLE");
  assert.equal(result.readOnly, true);
  assert.equal(result.paymentAllowed, false);
  assert.equal(result.chainWritesAllowed, false);
  assert.equal(result.retryAfterSeconds, 60);
  assert.deepEqual(result.actions, {
    connect: false,
    deploy: false,
    approve: false,
    fund: false,
    bridge: false,
    pay: false,
    trade: false,
  });
  assert.match(result.notice, /Do not connect or fund a new wallet/);
});

test("Builder-authorization checking is a retryable no-write contract", () => {
  const result = walletSetupScaffold({
    configured: true,
    builderAuthorizationPending: true,
  });
  assert.equal(result.status, "BROWSER_SETUP_AUTH_CHECKING");
  assert.equal(result.retryAfterSeconds, 15);
  assert.equal(result.readOnly, true);
  assert.equal(result.paymentAllowed, false);
  assert.equal(result.chainWritesAllowed, false);
  assert.equal(result.actions.connect, false);
  assert.match(result.notice, /still being checked/);
});

test("wallet setup endpoint exposes only GET and HEAD", async () => {
  let probeCalls = 0;
  const handler = createWalletSetupHandler({
    configured: false,
    builderAuthorization: async () => { probeCalls += 1; return true; },
  });
  const get = response();
  await handler({ method: "GET", body: { ignored: "do-not-expose" } }, get);
  assert.equal(get.statusCode, 200);
  assert.equal(get.headers["cache-control"], "no-store");
  assert.equal(get.body.chainWritesAllowed, false);
  assert.equal(probeCalls, 0);
  assert.doesNotMatch(JSON.stringify(get.body), /do-not-expose|POLYMARKET_BUILDER_/);

  const head = response();
  await handler({ method: "HEAD", body: { ignored: "do-not-expose" } }, head);
  assert.equal(head.statusCode, 200);
  assert.equal(head.headers["cache-control"], "no-store");
  assert.equal(head.body, null);
  assert.equal(head.ended, true);

  const rejected = response();
  await handler({ method: "POST" }, rejected);
  assert.equal(rejected.statusCode, 405);
  assert.equal(rejected.headers.allow, "GET, HEAD");
  assert.equal(rejected.body.error.code, "method_not_allowed");
});

test("wallet setup verifies Builder authorization before it advertises activation", async () => {
  const unavailable = response();
  const unavailableHandler = createWalletSetupHandler({
    configured: true,
    builderAuthorization: async () => false,
  });
  await unavailableHandler({ method: "GET" }, unavailable);
  assert.equal(unavailable.statusCode, 200);
  assert.equal(unavailable.body.status, "BROWSER_SETUP_AUTH_UNAVAILABLE");
  assert.equal(unavailable.body.actions.connect, false);
  assert.equal(unavailable.body.retryAfterSeconds, 60);
  assert.doesNotMatch(JSON.stringify(unavailable.body), /invalid authorization|builder-secret/);

  const active = response();
  const activeHandler = createWalletSetupHandler({
    configured: true,
    builderAuthorization: async () => true,
  });
  await activeHandler({ method: "GET" }, active);
  assert.equal(active.statusCode, 200);
  assert.equal(active.body.status, "BROWSER_SETUP_BETA_READY");
  assert.equal(active.body.actions.connect, true);

  const pending = response();
  const pendingHandler = createWalletSetupHandler({
    configured: true,
    builderAuthorization: async () => undefined,
  });
  await pendingHandler({ method: "GET" }, pending);
  assert.equal(pending.statusCode, 200);
  assert.equal(pending.body.status, "BROWSER_SETUP_AUTH_CHECKING");
  assert.equal(pending.body.actions.connect, false);
});

test("wallet setup derives its default configuration from an injected environment", async () => {
  const handler = createWalletSetupHandler({
    environment: {
      CONVICTION_WALLET_SESSION_SECRET: "x".repeat(32),
      POLYMARKET_BUILDER_API_KEY: "builder-key",
      POLYMARKET_BUILDER_SECRET: "builder-secret",
      POLYMARKET_BUILDER_PASSPHRASE: "builder-passphrase",
      CONVICTION_WALLET_STATE_REST_URL: "https://state.example",
      CONVICTION_WALLET_STATE_REST_TOKEN: "t".repeat(16),
      CONVICTION_POLYGON_RPC_URL: "https://polygon.example",
    },
    builderAuthorization: async () => true,
  });
  const result = response();
  await handler({ method: "GET" }, result);
  assert.equal(result.statusCode, 200);
  assert.equal(result.body.status, "BROWSER_SETUP_BETA_READY");
});

test("Builder authorization probe coalesces requests and caches only its boolean result", async () => {
  const environment = {
    POLYMARKET_BUILDER_API_KEY: "builder-key",
    POLYMARKET_BUILDER_SECRET: "builder-secret",
    POLYMARKET_BUILDER_PASSPHRASE: "builder-passphrase",
  };
  let now = 1_000;
  let runs = 0;
  const state = createInMemoryWalletSetupState({ now: () => now });
  const probe = createBuilderAuthorizationProbe({
    environment,
    state,
    now: () => now,
    cacheTtlMilliseconds: 60_000,
    createRelayer: () => ({
      run: async () => {
        runs += 1;
        return { ok: true, authentication: "builder" };
      },
    }),
  });
  assert.deepEqual(await Promise.all([probe(), probe()]), [true, true]);
  assert.equal(runs, 1);
  assert.equal(await probe(), true);
  assert.equal(runs, 1);
  now += 60_000;
  assert.equal(await probe(), true);
  assert.equal(runs, 2);
});

test("Builder authorization status is shared durably across setup-handler instances", async () => {
  const environment = {
    VERCEL_ENV: "production",
    POLYMARKET_BUILDER_API_KEY: "builder-key",
    POLYMARKET_BUILDER_SECRET: "builder-secret",
    POLYMARKET_BUILDER_PASSPHRASE: "builder-passphrase",
  };
  const state = createInMemoryWalletSetupState();
  let runs = 0;
  const createRelayer = () => ({
    run: async () => {
      runs += 1;
      return { ok: true, authentication: "builder" };
    },
  });
  const first = createBuilderAuthorizationProbe({ environment, state, createRelayer });
  const second = createBuilderAuthorizationProbe({ environment, state, createRelayer });
  assert.equal(await first(), true);
  assert.equal(await second(), true);
  assert.equal(runs, 1);
});

test("shared Builder authorization cannot extend its local cache past the durable TTL", async () => {
  const environment = {
    VERCEL_ENV: "production",
    POLYMARKET_BUILDER_API_KEY: "builder-key",
    POLYMARKET_BUILDER_SECRET: "builder-secret",
    POLYMARKET_BUILDER_PASSPHRASE: "builder-passphrase",
  };
  let currentTime = 1_000;
  const state = createInMemoryWalletSetupState({ now: () => currentTime });
  let runs = 0;
  const createRelayer = () => ({
    run: async () => {
      runs += 1;
      return { ok: true, authentication: "builder" };
    },
  });
  const first = createBuilderAuthorizationProbe({
    environment,
    state,
    createRelayer,
    now: () => currentTime,
  });
  assert.equal(await first(), true);
  assert.equal(runs, 1);

  currentTime += 59_999;
  const second = createBuilderAuthorizationProbe({
    environment,
    state,
    createRelayer,
    now: () => currentTime,
  });
  assert.equal(await second(), true);
  assert.equal(runs, 1);

  currentTime += 1;
  assert.equal(await second(), true);
  assert.equal(runs, 2);
});

test("contending Builder authorization probes report retryable checking until the owner finishes", async () => {
  const environment = {
    VERCEL_ENV: "production",
    POLYMARKET_BUILDER_API_KEY: "builder-key",
    POLYMARKET_BUILDER_SECRET: "builder-secret",
    POLYMARKET_BUILDER_PASSPHRASE: "builder-passphrase",
  };
  const state = createInMemoryWalletSetupState();
  let releaseOwner;
  let runs = 0;
  const owner = createBuilderAuthorizationProbe({
    environment,
    state,
    createRelayer: () => ({
      run: async () => {
        runs += 1;
        await new Promise((resolve) => { releaseOwner = resolve; });
        return { ok: true, authentication: "builder" };
      },
    }),
  });
  const ownerPromise = owner();
  await new Promise((resolve) => setImmediate(resolve));
  const contender = createBuilderAuthorizationProbe({
    environment,
    state,
    createRelayer: () => ({
      run: async () => {
        throw new Error("the contender must not create a second upstream probe");
      },
    }),
  });
  assert.equal(await contender(), undefined);
  releaseOwner();
  assert.equal(await ownerPromise, true);
  assert.equal(await contender(), true);
  assert.equal(runs, 1);
});

test("Builder authorization status never crosses credential sets", async () => {
  const state = createInMemoryWalletSetupState();
  let runs = 0;
  const createRelayer = ({ credentials }) => ({
    run: async () => {
      runs += 1;
      return {
        ok: credentials.key === "valid-builder-key",
        authentication: credentials.key === "valid-builder-key" ? "builder" : "none",
      };
    },
  });
  const valid = createBuilderAuthorizationProbe({
    environment: {
      VERCEL_ENV: "production",
      POLYMARKET_BUILDER_API_KEY: "valid-builder-key",
      POLYMARKET_BUILDER_SECRET: "shared-secret",
      POLYMARKET_BUILDER_PASSPHRASE: "shared-passphrase",
    },
    state,
    createRelayer,
  });
  const invalid = createBuilderAuthorizationProbe({
    environment: {
      VERCEL_ENV: "production",
      POLYMARKET_BUILDER_API_KEY: "invalid-builder-key",
      POLYMARKET_BUILDER_SECRET: "shared-secret",
      POLYMARKET_BUILDER_PASSPHRASE: "shared-passphrase",
    },
    state,
    createRelayer,
  });
  assert.equal(await valid(), true);
  assert.equal(await invalid(), false);
  assert.equal(runs, 2);
});

test("Builder authorization failures cache a fail-closed result across instances", async () => {
  const environment = {
    VERCEL_ENV: "production",
    POLYMARKET_BUILDER_API_KEY: "builder-key",
    POLYMARKET_BUILDER_SECRET: "builder-secret",
    POLYMARKET_BUILDER_PASSPHRASE: "builder-passphrase",
  };
  const state = createInMemoryWalletSetupState();
  let runs = 0;
  const createRelayer = () => ({
    run: async () => {
      runs += 1;
      throw new Error("upstream builder authentication rejected");
    },
  });
  const first = createBuilderAuthorizationProbe({ environment, state, createRelayer });
  const second = createBuilderAuthorizationProbe({ environment, state, createRelayer });
  assert.equal(await first(), false);
  assert.equal(await second(), false);
  assert.equal(runs, 1);
});

test("wallet setup public status is rate limited before an authorization probe", async () => {
  const apiGuard = createPublicApiGuard({ limit: 1, maxBodyBytes: 256, maxInFlight: 1 });
  const handler = createWalletSetupHandler({
    configured: true,
    apiGuard,
    builderAuthorization: async () => false,
  });
  const request = {
    method: "GET",
    headers: { "x-vercel-forwarded-for": "203.0.113.9" },
  };
  const first = response();
  await handler(request, first);
  assert.equal(first.statusCode, 200);
  const second = response();
  await handler(request, second);
  assert.equal(second.statusCode, 429);
  assert.equal(second.body.error.code, "rate_limited");
  assert.equal(second.headers["retry-after"], "60");
});

test("wallet setup capacity response advises a bounded retry", async () => {
  const apiGuard = createPublicApiGuard({ limit: 6, maxBodyBytes: 256, maxInFlight: 1 });
  let releaseAuthorization;
  const handler = createWalletSetupHandler({
    configured: true,
    apiGuard,
    builderAuthorization: async () => new Promise((resolve) => { releaseAuthorization = resolve; }),
  });
  const first = response();
  const firstRequest = handler({ method: "GET" }, first);
  await new Promise((resolve) => setImmediate(resolve));

  const second = response();
  await handler({ method: "GET" }, second);
  assert.equal(second.statusCode, 503);
  assert.equal(second.body.error.code, "preview_capacity_reached");
  assert.equal(second.headers["retry-after"], "1");

  releaseAuthorization(false);
  await firstRequest;
});

test("wallet setup activation requires a complete secure server configuration", () => {
  const environment = {
    CONVICTION_WALLET_SESSION_SECRET: "x".repeat(32),
    POLYMARKET_BUILDER_API_KEY: "key",
    POLYMARKET_BUILDER_SECRET: "secret",
    POLYMARKET_BUILDER_PASSPHRASE: "passphrase",
    CONVICTION_WALLET_STATE_REST_URL: "https://state.example.com",
    CONVICTION_WALLET_STATE_REST_TOKEN: "token-that-is-at-least-sixteen-bytes",
    CONVICTION_POLYGON_RPC_URL: "https://polygon.example.com",
  };
  assert.equal(browserSetupConfigured(environment), true);
  const relayerEnvironment = {
    ...environment,
    POLYMARKET_BUILDER_API_KEY: undefined,
    POLYMARKET_BUILDER_SECRET: undefined,
    POLYMARKET_BUILDER_PASSPHRASE: undefined,
    POLYMARKET_RELAYER_API_KEY: "relayer-key",
    POLYMARKET_RELAYER_API_KEY_ADDRESS: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  };
  assert.equal(browserSetupConfigured(relayerEnvironment), false);
  assert.equal(browserSetupConfigured({ ...relayerEnvironment, POLYMARKET_RELAYER_API_KEY_ADDRESS: "0x1234" }), false);
  assert.equal(browserSetupConfigured({ ...environment, CONVICTION_WALLET_STATE_REST_URL: "http://state.example.com" }), false);
  assert.equal(browserSetupConfigured({ ...environment, CONVICTION_WALLET_SESSION_SECRET: "short" }), false);
  const vercelKvEnvironment = {
    ...environment,
    CONVICTION_WALLET_STATE_REST_URL: undefined,
    CONVICTION_WALLET_STATE_REST_TOKEN: undefined,
    KV_REST_API_URL: "https://state.example.com",
    KV_REST_API_TOKEN: "token-that-is-at-least-sixteen-bytes",
  };
  assert.equal(browserSetupConfigured(vercelKvEnvironment), true);
  assert.equal(browserSetupConfigured({ ...vercelKvEnvironment, KV_REST_API_URL: "http://state.example.com" }), false);
  assert.equal(browserSetupConfigured({
    ...vercelKvEnvironment,
    CONVICTION_WALLET_STATE_REST_URL: "https://stale-custom.example.com",
  }), false);
  assert.equal(browserSetupConfigured({
    ...vercelKvEnvironment,
    CONVICTION_WALLET_STATE_REST_TOKEN: "stale-custom-token-at-least-sixteen-bytes",
  }), false);
});
