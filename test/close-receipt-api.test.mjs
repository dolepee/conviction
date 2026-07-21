import assert from "node:assert/strict";
import test from "node:test";

import { createCloseReceiptHandler } from "../api/close-receipt.js";
import { createPublicApiGuard } from "../src/public-api-guard.mjs";

function responseRecorder() {
  return {
    statusCode: 200,
    headers: {},
    body: "",
    status(code) { this.statusCode = code; return this; },
    setHeader(name, value) { this.headers[name.toLowerCase()] = value; return this; },
    end(body = "") { this.body = body; return this; },
  };
}

test("public CLOSE proof is guarded before Polygon RPC work", async () => {
  let calls = 0;
  const handler = createCloseReceiptHandler({
    trustedIssuers: new Map(),
    publicGuard: createPublicApiGuard({ limit: 1 }),
    async verifyImpl(transactionHash, expected) {
      calls += 1;
      return { ok: true, transactionHash, expected };
    },
  });
  const request = {
    method: "POST",
    headers: { "x-forwarded-for": "192.0.2.20" },
    body: {
      transactionHash: `0x${"1".repeat(64)}`,
      orderId: `0x${"2".repeat(64)}`,
      intentHash: `0x${"3".repeat(64)}`,
      intent: { version: "conviction-exit-intent-v1" },
    },
  };
  const first = responseRecorder();
  await handler(request, first);
  assert.equal(first.statusCode, 200);
  assert.equal(calls, 1);
  const second = responseRecorder();
  await handler(request, second);
  assert.equal(second.statusCode, 429);
  assert.equal(calls, 1);
});
