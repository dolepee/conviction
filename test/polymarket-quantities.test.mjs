import assert from "node:assert/strict";
import test from "node:test";

import {
  parsePolymarketClobShares,
  parsePolymarketShareAtoms,
} from "../src/polymarket-quantities.mjs";

test("CLOB share decimals normalize exactly once to six-decimal atoms", () => {
  for (const [value, expected] of [
    ["0", 0n],
    ["0.0", 0n],
    ["0.000001", 1n],
    ["5", 5_000_000n],
    ["5.0", 5_000_000n],
    ["5.250001", 5_250_001n],
    ["5000000", 5_000_000_000_000n],
  ]) {
    assert.equal(parsePolymarketClobShares(value, "shares"), expected);
  }
});

test("CLOB share parser rejects ambiguous, imprecise, and overflowing values", () => {
  for (const value of [
    5,
    "",
    " 5",
    "5 ",
    "+5",
    "-5",
    "05",
    ".5",
    "5.",
    "5e0",
    "5.0000001",
    `${1n << 256n}`,
  ]) {
    assert.throws(
      () => parsePolymarketClobShares(value, "shares"),
      (error) => error?.code === "invalid_polymarket_share_quantity",
    );
  }
  assert.throws(
    () => parsePolymarketClobShares("0.0", "shares", { positive: true }),
    (error) => error?.code === "invalid_polymarket_share_quantity",
  );
});

test("internal share atoms remain canonical integers and are never rescaled", () => {
  assert.equal(parsePolymarketShareAtoms("5000000", "shares"), 5_000_000n);
  for (const value of ["5.0", "05000000", 5_000_000]) {
    assert.throws(
      () => parsePolymarketShareAtoms(value, "shares"),
      (error) => error?.code === "invalid_polymarket_share_quantity",
    );
  }
});
