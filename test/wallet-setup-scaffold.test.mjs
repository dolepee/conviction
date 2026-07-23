import assert from "node:assert/strict";
import test from "node:test";

import { createWalletSetupHandler } from "../api/wallet-setup.js";
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
  assert.equal(result.status, "FEASIBILITY_ONLY_NOT_CONFIGURED");
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
  assert.strictEqual(result.approvalDisclosure, APPROVAL_DISCLOSURE);
  assert.equal(result.approvalDisclosure.pUsdAllowances, 2);
  assert.equal(result.approvalDisclosure.ctfOperatorApprovals, 3);
  assert.equal(result.approvalDisclosure.revokeCommandAvailable, false);
  assert.equal(result.approvalDisclosure.convictionCanBypassWalletPolicy, false);
  assert.match(result.compatibility.currentNativeOkxExecutor, /not-compatible/);
  assert.match(result.compatibility.xLayerPayment, /not-implemented/);
  assert.match(result.notice, /Do not fund a new wallet/);
});

test("wallet setup endpoint exposes only GET and HEAD", () => {
  const handler = createWalletSetupHandler();
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
