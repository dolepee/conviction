import assert from "node:assert/strict";
import test from "node:test";

import { selectAvailableOutcome } from "../src/market-selection.mjs";

test("keeps the current outcome only while that side remains available", () => {
  const both = { YES: { available: true }, NO: { available: true } };
  assert.equal(selectAvailableOutcome(both, "no"), "NO");
  assert.equal(selectAvailableOutcome(both, "YES"), "YES");
});

test("moves a stale disabled selection to the available side", () => {
  assert.equal(
    selectAvailableOutcome({ YES: { available: true }, NO: { available: false } }, "NO"),
    "YES",
  );
  assert.equal(
    selectAvailableOutcome({ YES: { available: false }, NO: { available: true } }, "YES"),
    "NO",
  );
});

test("returns no selection when neither outcome has an ask", () => {
  assert.equal(
    selectAvailableOutcome({ YES: { available: false }, NO: { available: false } }, "YES"),
    null,
  );
});
