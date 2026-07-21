import assert from "node:assert/strict";

import { OKXFacilitatorClient } from "@okxweb3/x402-core";

import {
  readFacilitatorCredentials,
  SERVICE_NETWORK,
} from "../src/service-payment.mjs";

try {
  const credentials = readFacilitatorCredentials(process.env);
  const client = new OKXFacilitatorClient(credentials);
  const supported = await client.getSupported();
  const exactXLayer = supported?.kinds?.find(
    (kind) =>
      kind.x402Version === 2 &&
      kind.scheme === "exact" &&
      kind.network === SERVICE_NETWORK,
  );
  assert.ok(exactXLayer, "API key does not expose exact payments on X Layer mainnet");
  console.log("payment credential preflight passed: exact payments on eip155:196");
} catch (error) {
  console.error(`payment credential preflight failed: ${error?.message || "unknown error"}`);
  process.exitCode = 1;
}
