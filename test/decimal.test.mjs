import assert from "node:assert/strict";
import test from "node:test";

import { formatDecimal } from "../src/decimal.mjs";

test("formats negative fixed-point values with one leading sign", () => {
  assert.equal(formatDecimal(-100000n, 6), "-0.1");
  assert.equal(formatDecimal(-1n, 6), "-0.000001");
  assert.equal(formatDecimal(-2500000n, 6), "-2.5");
  assert.equal(formatDecimal(-2000000n, 6), "-2");
  assert.equal(formatDecimal(0n, 6), "0");
});
