import assert from "node:assert/strict";
import test from "node:test";

import { ConvictionError } from "../src/errors.mjs";
import { verifySourcePosition } from "../src/source-position.mjs";

const SOURCE = Object.freeze({
  transactionHash: `0x${"1".repeat(64)}`,
  orderId: `0x${"2".repeat(64)}`,
  intentHash: `0x${"3".repeat(64)}`,
  intent: { version: "conviction-intent-v4" },
  issuance: { version: "conviction-issuance-v1" },
  positionProofHash: `0x${"4".repeat(64)}`,
});
const VERIFIED = Object.freeze({
  positionProofHash: SOURCE.positionProofHash,
  positionProof: {
    intentHash: SOURCE.intentHash,
    transactionHash: SOURCE.transactionHash,
    orderId: SOURCE.orderId,
    wallet: "0x6a355e4971d9ac2ab97d22c3cf361d42faba33fe",
    marketConditionId: `0x${"5".repeat(64)}`,
    outcome: "YES",
    outcomeTokenId: "123",
    fill: { actualSharesRaw: "5000000" },
  },
});

test("normalizes a freshly reverified source position", async () => {
  let received;
  const result = await verifySourcePosition(SOURCE, {
    trustedIssuers: new Map(),
    async verifyImpl(transactionHash, options) {
      received = { transactionHash, options };
      return VERIFIED;
    },
  });
  assert.equal(received.transactionHash, SOURCE.transactionHash);
  assert.equal(received.options.intent, SOURCE.intent);
  assert.equal(result.wallet, VERIFIED.positionProof.wallet);
  assert.equal(result.actualSharesRaw, "5000000");
  assert.equal(result.positionProofHash, SOURCE.positionProofHash);
  assert.equal(result.intentVersion, "conviction-intent-v4");
  assert.equal(result.verificationMode, "signed-intent-window");
});

test("labels legacy source positions as retrospective", async () => {
  let receivedOptions;
  const result = await verifySourcePosition({ ...SOURCE, intent: { version: "conviction-intent-v3" }, issuance: undefined }, {
    trustedIssuers: new Map(),
    async verifyImpl(_transactionHash, options) { receivedOptions = options; return VERIFIED; },
  });
  assert.equal(receivedOptions.allowUnsigned, true);
  assert.equal(result.intentVersion, "conviction-intent-v3");
  assert.equal(result.verificationMode, "retrospective");
});

test("rejects a caller-supplied source proof hash substitution", async () => {
  await assert.rejects(
    () => verifySourcePosition({ ...SOURCE, positionProofHash: `0x${"9".repeat(64)}` }, {
      async verifyImpl() { return VERIFIED; },
    }),
    (error) => error instanceof ConvictionError && error.code === "source_proof_hash_mismatch",
  );
});
