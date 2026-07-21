import assert from "node:assert/strict";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  claimTakeProfitReservation,
  parseTakeProfitArgs,
  requirePinnedTakeProfitExecutionReadiness,
  takeProfitReplayKey,
} from "../scripts/take-profit-orchestrator.mjs";

const PAYER = "0x1111111111111111111111111111111111111111";
const WALLET = "0x2222222222222222222222222222222222222222";
const CONDITION = `0x${"a".repeat(64)}`;
const TOKEN = "123456789";
const HASH = (digit) => `0x${digit.repeat(64)}`;

function argv(extra = []) {
  return [
    "take-profit",
    "--origin", "https://conviction.example",
    "--market", "example-market",
    "--side", "YES",
    "--shares", "5",
    "--target-price", "0.4",
    "--expires-at", "2026-07-22T01:00:00.000Z",
    "--payment-payer", PAYER,
    "--seller-wallet", WALLET,
    "--source-proof", "/tmp/source.json",
    "--issuer-registry", "/tmp/issuers.json",
    ...extra,
  ];
}

function request() {
  return {
    outcome: "YES",
    shares: "5",
    targetPrice: "0.4",
    venueExpiresAt: "2026-07-22T01:00:00.000Z",
    sourcePosition: {
      intentHash: HASH("1"),
      positionProofHash: HASH("2"),
      transactionHash: HASH("3"),
      orderId: HASH("4"),
      intent: {
        market: { conditionId: CONDITION, outcomeTokenId: TOKEN },
      },
    },
  };
}

function readiness(overrides = {}) {
  return {
    accessible: true,
    clobVersion: "V2",
    currentMode: "deposit_wallet",
    paymentPayer: PAYER,
    buyerWallet: WALLET,
    tradingAddress: WALLET,
    outcomeTokenId: TOKEN,
    outcomeBalanceRaw: "5000000",
    approvedForExchange: true,
    openOrdersComplete: true,
    reservedSharesRaw: "0",
    openSellOrderCount: 0,
    ...overrides,
  };
}

test("TAKE_PROFIT CLI accepts exactly one bounded manager request", () => {
  const parsed = parseTakeProfitArgs(argv(["--rationale", "Take profit at the selected price.", "--json"]));
  assert.equal(parsed.command, "take-profit");
  assert.equal(parsed.side, "YES");
  assert.equal(parsed.shares, "5");
  assert.equal(parsed.targetPrice, "0.4");
  assert.equal(parsed.json, true);
  assert.throws(() => parseTakeProfitArgs(argv(["--auto"])), (error) => error?.code === "invalid_argument");
  assert.deepEqual(parseTakeProfitArgs([
    "tp-status", "--journal", "/tmp/journey.json", "--issuer-registry", "/tmp/issuers.json", "--json",
  ]), {
    command: "tp-status",
    journal: "/tmp/journey.json",
    issuerRegistry: "/tmp/issuers.json",
    json: true,
  });
  assert.deepEqual(parseTakeProfitArgs([
    "cancel-tp", "--journal", "/tmp/journey.json", "--issuer-registry", "/tmp/issuers.json",
  ]), {
    command: "cancel-tp",
    journal: "/tmp/journey.json",
    issuerRegistry: "/tmp/issuers.json",
    json: false,
  });
});

test("TAKE_PROFIT replay identity binds source, shares, target, expiry, and wallet", () => {
  const base = takeProfitReplayKey({ request: request(), sellerWallet: WALLET });
  assert.match(base, /^0x[0-9a-f]{64}$/);
  for (const mutate of [
    (value) => { value.shares = "6"; },
    (value) => { value.targetPrice = "0.41"; },
    (value) => { value.venueExpiresAt = "2026-07-22T01:01:00.000Z"; },
    (value) => { value.sourcePosition.orderId = HASH("5"); },
  ]) {
    const changed = structuredClone(request());
    mutate(changed);
    assert.notEqual(takeProfitReplayKey({ request: changed, sellerWallet: WALLET }), base);
  }
  assert.notEqual(
    takeProfitReplayKey({ request: request(), sellerWallet: "0x3333333333333333333333333333333333333333" }),
    base,
  );
});

test("TAKE_PROFIT reservation lock is atomic and owner-only", async () => {
  const directory = await mkdtemp(join(tmpdir(), "conviction-tp-lock-"));
  const key = takeProfitReplayKey({ request: request(), sellerWallet: WALLET });
  const journal = join(directory, "journey.json");
  const file = await claimTakeProfitReservation({ key, journal, directory });
  assert.equal((await stat(directory)).mode & 0o777, 0o700);
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  const lock = JSON.parse(await readFile(file, "utf8"));
  assert.equal(lock.replayKey, key);
  assert.equal(lock.journalPath, journal);
  await assert.rejects(
    claimTakeProfitReservation({ key, journal, directory }),
    (error) => error?.code === "take_profit_replay_blocked",
  );
});

test("locked TAKE_PROFIT readiness fails closed on every identity and reservation drift", () => {
  assert.equal(requirePinnedTakeProfitExecutionReadiness(readiness(), {
    paymentPayer: PAYER,
    sellerWallet: WALLET,
    tokenId: TOKEN,
    sharesRaw: 5_000_000n,
  }), true);
  const cases = [
    [{ paymentPayer: "0x3333333333333333333333333333333333333333" }, "trading_wallet_mismatch"],
    [{ buyerWallet: "0x3333333333333333333333333333333333333333" }, "trading_wallet_mismatch"],
    [{ outcomeTokenId: "987" }, "token_substitution"],
    [{ approvedForExchange: false }, "ctf_approval_missing"],
    [{ openOrdersComplete: false }, "incomplete_open_orders"],
    [{ outcomeBalanceRaw: "4999999" }, "insufficient_position"],
    [{ reservedSharesRaw: "1", openSellOrderCount: 1 }, "position_reserved"],
  ];
  for (const [mutation, code] of cases) {
    assert.throws(
      () => requirePinnedTakeProfitExecutionReadiness(readiness(mutation), {
        paymentPayer: PAYER,
        sellerWallet: WALLET,
        tokenId: TOKEN,
        sharesRaw: 5_000_000n,
      }),
      (error) => error?.code === code,
    );
  }
});
