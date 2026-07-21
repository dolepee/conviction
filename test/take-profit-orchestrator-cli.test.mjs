import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  attachTakeProfitFillProof,
  claimTakeProfitReservation,
  parseTakeProfitArgs,
  requirePinnedTakeProfitExecutionReadiness,
  requireTakeProfitLaunchWindow,
  safeTakeProfitJournalPath,
  settleTakeProfitReconciliation,
  takeProfitReconciliationResolved,
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
    "--origin", "https://conviction-bay.vercel.app",
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
  assert.equal(parsed.origin, "https://conviction-bay.vercel.app");
  assert.throws(
    () => parseTakeProfitArgs(argv().map((value) => value === "https://conviction-bay.vercel.app" ? "https://attacker.example" : value)),
    (error) => error?.code === "untrusted_service_origin",
  );
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
  assert.deepEqual(parseTakeProfitArgs([
    "reconcile-tp", "--journal", "/tmp/journey.json", "--issuer-registry", "/tmp/issuers.json", "--json",
  ]), {
    command: "reconcile-tp",
    journal: "/tmp/journey.json",
    issuerRegistry: "/tmp/issuers.json",
    json: true,
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

test("TAKE_PROFIT locked launch window is rechecked against card and venue deadlines", () => {
  const now = Date.parse("2026-07-21T02:00:00.000Z");
  const card = {
    expiresAt: "2026-07-21T02:00:30.000Z",
    bounds: { venueExpiresAt: "2026-07-21T03:00:00.000Z" },
  };
  assert.deepEqual(requireTakeProfitLaunchWindow(card, { now: () => now }), {
    observedAt: now,
    placementDeadlineMs: Date.parse(card.expiresAt),
    venueDeadlineMs: Date.parse(card.bounds.venueExpiresAt),
  });
  assert.throws(
    () => requireTakeProfitLaunchWindow(card, { now: () => now + 15_001 }),
    (error) => error?.code === "insufficient_execution_window",
  );
  assert.throws(
    () => requireTakeProfitLaunchWindow({ ...card, bounds: { venueExpiresAt: new Date(now).toISOString() } }, { now: () => now }),
    (error) => error?.code === "expired_venue_order",
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

test("TAKE_PROFIT lifecycle journals reject traversal and symlink escapes", async () => {
  const root = await mkdtemp(join(tmpdir(), "conviction-tp-journal-root-"));
  const state = join(root, "state");
  const outside = join(root, "outside-take-profit.json");
  const inside = join(state, "inside-take-profit.json");
  const link = join(state, "linked-take-profit.json");
  await mkdir(state);
  await writeFile(inside, "{}\n");
  await writeFile(outside, "{}\n");
  await symlink(outside, link);
  assert.equal(await safeTakeProfitJournalPath(inside, state), await realpath(inside));
  await assert.rejects(
    safeTakeProfitJournalPath(join(state, "..", "outside-take-profit.json"), state),
    (error) => error?.code === "invalid_state_path",
  );
  await assert.rejects(
    safeTakeProfitJournalPath(link, state),
    (error) => error?.code === "invalid_state_path",
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

test("TAKE_PROFIT status wires the exact CLOB trade set into independent Polygon fill proof", async () => {
  const snapshotHash = HASH("8");
  const orderId = HASH("9");
  const binding = {
    signerAddress: PAYER,
    depositWallet: WALLET,
    orderId,
    marketConditionId: CONDITION,
    outcomeTokenId: TOKEN,
  };
  const snapshot = { exact: "authenticated-order-snapshot" };
  const status = {
    version: "conviction-take-profit-status-v1",
    status: "PARTIAL_PENDING_CHAIN_PROOF",
    snapshotHash,
    settlementProofRequired: true,
  };
  const journal = { exact: "armed-journal" };
  const trustedIssuers = new Map([["issuer", {}]]);
  const recovered = { version: "conviction-polymarket-associated-trades-v1" };
  let tradeCalls = 0;
  let proofCalls = 0;
  const times = [1_700_000_000_000, 1_700_000_000_100];
  const result = await attachTakeProfitFillProof({
    journal,
    binding,
    trustedIssuers,
    snapshot,
    status,
  }, {
    now: () => times.shift(),
    fetchTradeContributions: async (input) => {
      tradeCalls += 1;
      assert.equal(input.signerAddress, PAYER);
      assert.equal(input.depositWallet, WALLET);
      assert.equal(input.orderId, orderId);
      assert.equal(input.marketConditionId, CONDITION);
      assert.equal(input.outcomeTokenId, TOKEN);
      assert.equal(input.exactOrderSnapshot, snapshot);
      assert.equal(input.now(), 1_700_000_000_000);
      return recovered;
    },
    verifyAggregateFill: async (input, options) => {
      proofCalls += 1;
      assert.equal(input.journal, journal);
      assert.equal(input.orderSnapshot, snapshot);
      assert.equal(input.tradeContributions, recovered);
      assert.equal(options.trustedIssuers, trustedIssuers);
      assert.equal(options.now, 1_700_000_000_100);
      const proof = {
        version: "conviction-take-profit-fill-proof-v1",
        status: "PARTIALLY_FILLED_ACTIVE_PROVISIONAL",
        orderId,
        wallet: WALLET,
        outcomeTokenId: TOKEN,
        exactOrderSnapshotHash: snapshotHash,
        finality: { finalized: false },
        lifecycle: { orderTerminal: false },
      };
      return { ok: true, proof, proofHash: HASH("7") };
    },
  });
  assert.equal(tradeCalls, 1);
  assert.equal(proofCalls, 1);
  assert.equal(result.version, "conviction-take-profit-status-with-fill-v1");
  assert.equal(result.status, "PARTIALLY_FILLED_ACTIVE_PROVISIONAL");
  assert.equal(result.finalized, false);
  assert.equal(result.followUpRequired, true);
  assert.equal(result.orderStatus, status);
  assert.equal(result.fillProofHash, HASH("7"));
});

test("TAKE_PROFIT status does not fetch trades or Polygon receipts before a match", async () => {
  const status = { status: "ARMED", settlementProofRequired: false };
  const result = await attachTakeProfitFillProof({ status }, {
    fetchTradeContributions: async () => assert.fail("trade recovery must not run"),
    verifyAggregateFill: async () => assert.fail("fill verifier must not run"),
  });
  assert.equal(result, status);
});

test("TAKE_PROFIT reconciliation releases only a finalized terminal or zero-fill terminal lock", async () => {
  const provisional = {
    version: "conviction-take-profit-status-with-fill-v1",
    status: "FILLED_PROVISIONAL",
    finalized: false,
    fillProof: { lifecycle: { orderTerminal: true } },
  };
  const active = {
    version: "conviction-take-profit-status-with-fill-v1",
    status: "PARTIALLY_FILLED_ACTIVE",
    finalized: true,
    fillProof: { lifecycle: { orderTerminal: false } },
  };
  const finalized = {
    version: "conviction-take-profit-status-with-fill-v1",
    status: "FILLED",
    finalized: true,
    fillProof: { lifecycle: { orderTerminal: true } },
    fillProofHash: HASH("6"),
  };
  assert.equal(takeProfitReconciliationResolved(provisional), false);
  assert.equal(takeProfitReconciliationResolved(active), false);
  assert.equal(takeProfitReconciliationResolved(finalized), true);
  assert.equal(takeProfitReconciliationResolved({ orderTerminal: true, settlementProofRequired: false }), true);
  assert.equal(takeProfitReconciliationResolved({ status: "UNKNOWN", orderTerminal: false, settlementProofRequired: true }), false);

  const context = {
    journalPath: "/private/state/journey-take-profit.json",
    journal: { executionLockPath: "/private/state/polymarket-execution.lock.json", reconciliationRequired: true },
  };
  let releases = 0;
  let writes = 0;
  const result = await settleTakeProfitReconciliation({
    context,
    status: finalized,
    stateDirectory: "/private/state",
  }, {
    now: () => 1_700_000_000_000,
    releaseLocks: async (journal, options) => {
      releases += 1;
      assert.equal(journal, context.journal);
      assert.equal(options.journal, context.journalPath);
      assert.deepEqual(options.fields, ["executionLockPath"]);
      journal.executionLockPath = null;
      return ["/private/state/polymarket-execution.lock.json"];
    },
    writeState: async (journal, options) => {
      writes += 1;
      assert.equal(journal.reconciliationRequired, false);
      assert.equal(journal.latestFillProofHash, HASH("6"));
      assert.equal(options.file, context.journalPath);
    },
  });
  assert.equal(releases, 1);
  assert.equal(writes, 1);
  assert.equal(result.executionLockReleased, true);
  assert.equal(result.reconciliationRequired, false);

  const unresolved = await settleTakeProfitReconciliation({
    context: { journalPath: context.journalPath, journal: {} },
    status: provisional,
    stateDirectory: "/private/state",
  }, {
    releaseLocks: async () => assert.fail("provisional evidence cannot release a lock"),
    writeState: async () => assert.fail("provisional evidence cannot clear reconciliation"),
  });
  assert.equal(unresolved.executionLockReleased, false);
  assert.equal(unresolved.reconciliationRequired, true);
});
