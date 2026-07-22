import assert from "node:assert/strict";
import test from "node:test";

import { assertCanonicalSigningValue, canonicalJson, sha256 } from "../src/canonical.mjs";

test("canonical JSON sorts plain object keys and preserves supported values", () => {
  const value = { z: [true, null, 7], a: { y: "two", x: "one" } };
  assert.equal(canonicalJson(value), '{"a":{"x":"one","y":"two"},"z":[true,null,7]}');
  assert.equal(sha256(value), sha256(structuredClone(value)));
});

test("canonical JSON rejects ambiguous or lossy signed values", () => {
  for (const value of [NaN, Infinity, 1.5, Number.MAX_SAFE_INTEGER + 1, undefined, 1n, new Date()]) {
    assert.throws(() => assertCanonicalSigningValue(value), TypeError);
  }
  assert.throws(() => assertCanonicalSigningValue({ optional: undefined }), TypeError);
  assert.throws(() => assertCanonicalSigningValue([, "hole"]), TypeError);
  const cyclic = {};
  cyclic.self = cyclic;
  assert.throws(() => assertCanonicalSigningValue(cyclic), TypeError);
});
