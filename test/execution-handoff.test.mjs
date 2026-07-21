import assert from "node:assert/strict";
import test from "node:test";

import {
  acknowledgementText,
  executionRequest,
  quoteIsExpired,
} from "../src/execution-handoff.mjs";

const COMPILATION = Object.freeze({
  intentHash: `0x${"ab".repeat(32)}`,
  intent: {
    buyer: { wallet: "0x1111111111111111111111111111111111111111" },
    market: { outcomeTokenId: "123456789" },
    order: { outcome: "NO", maximumTotalDebit: "1.12", maxPrice: "0.14" },
  },
  executionCard: {
    argv: [
      "buy",
      "--market-id",
      "technology-market",
      "--outcome",
      "no",
      "--amount",
      "0.98",
      "--price",
      "0.14",
      "--order-type",
      "FAK",
    ],
    maximumFundingBalance: "1.12",
    expiresAt: "2026-07-21T12:05:00.000Z",
  },
});

test("builds an explicit bounds acknowledgement", () => {
  assert.equal(
    acknowledgementText(COMPILATION),
    "I choose NO. Maximum total debit 1.12 pUSD. Maximum price 0.14.",
  );
});

test("copies only a dry-run request and requires separate later authorization", () => {
  const prompt = executionRequest(COMPILATION);
  assert.match(prompt, /polymarket-plugin buy .* --dry-run/);
  assert.match(prompt, /not live-trading authorization/i);
  assert.match(prompt, /separate, fresh user message/i);
  assert.match(prompt, /Expected Polygon deposit wallet/);
  assert.match(prompt, /Expected outcome token: 123456789/);
  assert.equal(prompt.includes("confirm live mode"), false);
  const commandLines = prompt.split("\n").filter((line) => line.startsWith("Then preview exactly:"));
  assert.equal(commandLines.length, 1);
  assert.match(commandLines[0], /--dry-run$/);
});

test("fails closed on missing card fields and expired quotes", () => {
  assert.throws(() => executionRequest({}), /Missing canonical execution arguments/);
  assert.equal(quoteIsExpired(COMPILATION, Date.parse("2026-07-21T12:04:59.000Z")), false);
  assert.equal(quoteIsExpired(COMPILATION, Date.parse("2026-07-21T12:05:00.000Z")), true);
  assert.equal(quoteIsExpired({ executionCard: { expiresAt: "not-a-date" } }), true);
});
