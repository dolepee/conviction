import assert from "node:assert/strict";

import {
  SERVICE_ASSET,
  SERVICE_NETWORK,
  SERVICE_PAYEE,
  SERVICE_PRICE_ATOMIC,
  SERVICE_RESOURCE,
} from "../src/service-payment.mjs";

const origin = (process.argv[2] || "https://conviction-bay.vercel.app").replace(/\/$/, "");
// Match the marketplace validator's default probe: no method override and no
// request body. The service must advertise payment before business validation.
const response = await fetch(`${origin}/api/service`);

assert.equal(response.status, 402, `expected HTTP 402, received ${response.status}`);
assert.equal(response.headers.get("cache-control"), "no-store");
const encoded = response.headers.get("payment-required");
assert.ok(encoded, "PAYMENT-REQUIRED header is missing");
const challenge = JSON.parse(Buffer.from(encoded, "base64").toString("utf8"));
assert.equal(challenge.x402Version, 2);
assert.equal(challenge.resource?.url, SERVICE_RESOURCE);
assert.equal(challenge.accepts?.length, 1);
const requirement = challenge.accepts[0];
assert.equal(requirement.scheme, "exact");
assert.equal(requirement.network, SERVICE_NETWORK);
assert.equal(requirement.amount, SERVICE_PRICE_ATOMIC);
assert.equal(requirement.asset, SERVICE_ASSET);
assert.equal(requirement.payTo, SERVICE_PAYEE);

console.log(
  `default paid service probe verified: ${SERVICE_PRICE_ATOMIC} atomic USD₮0 on ${SERVICE_NETWORK}`,
);
