import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import test from "node:test";

import { compileIntent } from "../src/intent-compiler.mjs";
import {
  createEnvironmentIntentIssuer,
  createIntentIssuer,
  trustedIssuerRegistry,
  verifyIntentIssuance,
} from "../src/intent-issuer.mjs";
import { ConvictionError } from "../src/errors.mjs";
import { LIVE_MARKET_SNAPSHOT } from "./fixtures.mjs";

const NOW = Date.parse("2026-07-21T02:00:10.000Z");
const REQUEST = Object.freeze({
  market: LIVE_MARKET_SNAPSHOT.slug,
  outcome: "yes",
  spend: "1.35",
  maxPrice: "0.27",
  wallet: "0x6a355e4971d9ac2ab97d22c3cf361d42faba33fe",
  rationale: "I expect this event to resolve YES and will not pay above 27 cents.",
});

function fixture() {
  const keys = generateKeyPairSync("ed25519");
  const compilation = compileIntent(REQUEST, LIVE_MARKET_SNAPSHOT, {
    now: NOW,
    quoteTtlMs: 300_000,
  });
  const issue = createIntentIssuer({
    keyId: "conviction-test-2026-07",
    privateKey: keys.privateKey,
    now: () => NOW + 1_000,
  });
  const issued = issue(compilation);
  const trustedIssuers = trustedIssuerRegistry([issue.issuer]);
  return { issued, trustedIssuers, keys };
}

function errorCode(fn, code) {
  assert.throws(fn, (error) => error instanceof ConvictionError && error.code === code);
}

test("issues and verifies a canonical intent inside its on-chain settlement window", () => {
  const { issued, trustedIssuers } = fixture();
  const result = verifyIntentIssuance({
    intent: issued.intent,
    intentHash: issued.intentHash,
    issuance: issued.issuance,
    trustedIssuers,
    settledAt: "2026-07-21T02:00:12.000Z",
  });
  assert.equal(result.ok, true);
  assert.equal(result.keyId, "conviction-test-2026-07");
  assert.match(result.fingerprint, /^sha256:[0-9a-f]{64}$/);
  assert.equal(issued.issuance.expiresAt, issued.intent.snapshot.expiresAt);
});

test("rejects intent, signature, key, and settlement-time substitution", () => {
  const { issued, trustedIssuers } = fixture();
  const base = {
    intent: issued.intent,
    intentHash: issued.intentHash,
    issuance: issued.issuance,
    trustedIssuers,
    settledAt: "2026-07-21T02:00:12.000Z",
  };
  errorCode(
    () => verifyIntentIssuance({ ...base, intent: { ...issued.intent, rationale: "mutated after issue" } }),
    "intent_hash_mismatch",
  );
  errorCode(
    () => verifyIntentIssuance({
      ...base,
      issuance: {
        ...issued.issuance,
        signature: `${issued.issuance.signature[0] === "A" ? "B" : "A"}${issued.issuance.signature.slice(1)}`,
      },
    }),
    "invalid_issuance_signature",
  );
  errorCode(
    () => verifyIntentIssuance({ ...base, trustedIssuers: new Map() }),
    "untrusted_issuer",
  );
  errorCode(
    () => verifyIntentIssuance({ ...base, settledAt: "2026-07-21T02:05:01.000Z" }),
    "settlement_outside_intent_window",
  );
  errorCode(
    () => verifyIntentIssuance({ ...base, settledAt: "2026-07-21T02:00:10.500Z" }),
    "settlement_outside_intent_window",
  );
});

test("loads a strict PKCS#8 Ed25519 key from environment", () => {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const environment = {
    CONVICTION_ISSUER_KEY_ID: "conviction-test-2026-07",
    CONVICTION_ISSUER_PRIVATE_KEY_B64: privateKey
      .export({ format: "der", type: "pkcs8" })
      .toString("base64"),
    CONVICTION_ISSUER_PUBLIC_KEY_B64: publicKey
      .export({ format: "der", type: "spki" })
      .toString("base64"),
  };
  const issue = createEnvironmentIntentIssuer(environment, { now: () => NOW + 1_000 });
  assert.equal(issue.issuer.keyId, environment.CONVICTION_ISSUER_KEY_ID);
  assert.throws(
    () => createEnvironmentIntentIssuer({ ...environment, CONVICTION_ISSUER_PRIVATE_KEY_B64: " padded " }),
    (error) => error.code === "issuer_configuration_error",
  );
});
