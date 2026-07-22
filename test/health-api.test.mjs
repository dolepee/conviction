import assert from "node:assert/strict";
import test from "node:test";

import handler from "../api/health.js";

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
  assert.equal(output.body.version, "0.4.6");
  assert.equal(output.body.executorDiscovery, "/api/executor");
  assert.deepEqual(output.body.products, [
    { name: "OPEN", price: "0.05 USD₮0", path: "/api/service" },
    { name: "POSITION_MANAGER", price: "0.10 USD₮0", path: "/api/manage", actions: ["CLOSE", "TAKE_PROFIT"] },
  ]);
  assert.deepEqual(output.body.supported.actions, ["OPEN", "CLOSE", "TAKE_PROFIT"]);
  assert.deepEqual(output.body.supported.orderTypes, ["FAK", "FOK", "GTD"]);
});

test("health remains read-only", () => {
  const output = response();
  handler({ method: "POST" }, output);
  assert.equal(output.statusCode, 405);
  assert.equal(output.headers.allow, "GET, HEAD");
});
