import assert from "node:assert/strict";
import test from "node:test";

import { browserSetupConfigured, createWalletSetupHandler } from "../src/wallet-setup-handler.mjs";
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
  assert.match(result.compatibility.currentNativeOkxExecutor, /not-compatible/);
  assert.match(result.compatibility.xLayerPayment, /not-implemented/);
  assert.match(result.notice, /Do not fund a new wallet/);
});

test("activated wallet setup publishes the two-consent browser lane without enabling payment or trade", () => {
  const result = walletSetupScaffold({ configured: true });
  assert.equal(result.status, "BROWSER_SETUP_BETA_READY");
  assert.equal(result.readOnly, false);
  assert.equal(result.chainWritesAllowed, true);
  assert.equal(result.actions.connect, true);
  assert.equal(result.actions.deploy, true);
  assert.equal(result.actions.approve, true);
  assert.equal(result.actions.fund, false);
  assert.equal(result.actions.pay, false);
  assert.equal(result.actions.trade, false);
  assert.equal(result.browserSetup.consents.length, 2);
  assert.match(result.notice, /two explicit browser-wallet consents/);
});

test("wallet setup endpoint exposes only GET and HEAD", () => {
  const handler = createWalletSetupHandler({ configured: false });
  const get = response();
  handler({ method: "GET", body: { ignored: "do-not-expose" } }, get);
  assert.equal(get.statusCode, 200);
  assert.equal(get.headers["cache-control"], "no-store");
  assert.equal(get.body.chainWritesAllowed, false);
  assert.doesNotMatch(JSON.stringify(get.body), /do-not-expose|POLYMARKET_BUILDER_/);

  const head = response();
  handler({ method: "HEAD", body: { ignored: "do-not-expose" } }, head);
  assert.equal(head.statusCode, 200);
  assert.equal(head.headers["cache-control"], "no-store");
  assert.equal(head.body, null);
  assert.equal(head.ended, true);

  const rejected = response();
  handler({ method: "POST" }, rejected);
  assert.equal(rejected.statusCode, 405);
  assert.equal(rejected.headers.allow, "GET, HEAD");
  assert.equal(rejected.body.error.code, "method_not_allowed");
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
});
