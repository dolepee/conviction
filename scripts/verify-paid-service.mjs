import assert from "node:assert/strict";

import {
  POSITION_CARD_SERVICE,
  POSITION_MANAGER_SERVICE,
  SERVICE_ASSET,
  SERVICE_NETWORK,
  SERVICE_PAYEE,
} from "../src/service-payment.mjs";

const origin = (process.argv[2] || "https://conviction-bay.vercel.app").replace(/\/$/, "");

const healthResponse = await fetch(`${origin}/api/health`);
assert.equal(healthResponse.status, 200, `expected health HTTP 200, received ${healthResponse.status}`);
assert.equal(healthResponse.headers.get("cache-control"), "no-store");
const health = await healthResponse.json();
assert.equal(health.ok, true);
assert.equal(health.product, "Conviction");
assert.equal(health.version, "0.4.6");
assert.deepEqual(health.products, [
  { name: "OPEN", price: POSITION_CARD_SERVICE.priceDisplay, path: POSITION_CARD_SERVICE.path },
  {
    name: "POSITION_MANAGER",
    price: POSITION_MANAGER_SERVICE.priceDisplay,
    path: POSITION_MANAGER_SERVICE.path,
    actions: ["CLOSE", "TAKE_PROFIT"],
  },
]);
assert.deepEqual(health.supported?.actions, ["OPEN", "CLOSE", "TAKE_PROFIT"]);

for (const service of [POSITION_CARD_SERVICE, POSITION_MANAGER_SERVICE]) {
  // Match the marketplace validator's default probe: no method override and
  // no request body. Payment must be advertised before business validation.
  const response = await fetch(`${origin}${service.path}`);
  assert.equal(
    response.status,
    402,
    `${service.path}: expected HTTP 402, received ${response.status}`,
  );
  assert.equal(response.headers.get("cache-control"), "no-store", `${service.path}: cache policy mismatch`);
  const encoded = response.headers.get("payment-required");
  assert.ok(encoded, `${service.path}: PAYMENT-REQUIRED header is missing`);
  const challenge = JSON.parse(Buffer.from(encoded, "base64").toString("utf8"));
  assert.equal(challenge.x402Version, 2, `${service.path}: x402 version mismatch`);
  assert.equal(challenge.resource?.url, service.resource, `${service.path}: resource mismatch`);
  assert.equal(challenge.accepts?.length, 1, `${service.path}: expected one payment requirement`);
  const requirement = challenge.accepts[0];
  assert.equal(requirement.scheme, "exact", `${service.path}: payment scheme mismatch`);
  assert.equal(requirement.network, SERVICE_NETWORK, `${service.path}: network mismatch`);
  assert.equal(requirement.amount, service.priceAtomic, `${service.path}: price mismatch`);
  assert.equal(requirement.asset, SERVICE_ASSET, `${service.path}: asset mismatch`);
  assert.equal(requirement.payTo, SERVICE_PAYEE, `${service.path}: payee mismatch`);
}

console.log(
  `v0.4 deployment verified: OPEN ${POSITION_CARD_SERVICE.priceAtomic} and Position Manager ${POSITION_MANAGER_SERVICE.priceAtomic} atomic USD₮0 on ${SERVICE_NETWORK}`,
);
