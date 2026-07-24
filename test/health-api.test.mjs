import assert from "node:assert/strict";
import test from "node:test";

import handler from "../api/health.js";
import { SERVICE_ASSET, SERVICE_NETWORK, SERVICE_PAYEE } from "../src/service-payment.mjs";

function response() {
  return {
    headers: {},
    statusCode: null,
    body: null,
    setHeader(name, value) { this.headers[name.toLowerCase()] = value; },
    status(value) { this.statusCode = value; return this; },
    json(value) { this.body = value; return this; },
  };
}

test("health advertises exactly two paid products and all three bounded actions", () => {
  const output = response();
  handler({ method: "GET" }, output);
  assert.equal(output.statusCode, 200);
  assert.equal(output.body.version, "0.4.22");
  assert.equal(output.body.executorDiscovery, "/api/executor");
  assert.equal(output.body.buyerReadiness, "/api/readiness");
  assert.deepEqual(output.body.payment, {
    network: SERVICE_NETWORK,
    asset: SERVICE_ASSET,
    payee: SERVICE_PAYEE,
    selfPaymentAllowed: false,
  });
  assert.deepEqual(output.body.products, [
    { name: "OPEN", price: "0.05 USD₮0", path: "/api/service" },
    { name: "POSITION_MANAGER", price: "0.10 USD₮0", path: "/api/manage", actions: ["CLOSE", "TAKE_PROFIT"] },
  ]);
  assert.deepEqual(output.body.supported.actions, ["OPEN", "CLOSE", "TAKE_PROFIT"]);
  assert.deepEqual(output.body.supported.orderTypes, ["FAK", "FOK", "GTD"]);
  assert.equal(output.body.firstUse.depositWalletSetupMayBeRequired, true);
  assert.equal(output.body.firstUse.finiteEoaOpenAvailable, false);
  assert.equal(output.body.firstUse.finiteEoaOpenStatus, "disabled-after-live-maker-rejection");
  assert.equal(output.body.firstUse.convictionCanBypassWalletPolicy, false);
});

test("health remains read-only", () => {
  const output = response();
  handler({ method: "POST" }, output);
  assert.equal(output.statusCode, 405);
  assert.equal(output.headers.allow, "GET, HEAD");
});
