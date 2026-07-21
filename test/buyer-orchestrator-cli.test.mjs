import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  claimCloseReplayLock,
  claimExecutionLock,
  closeReplayKey,
  normalizeOpenOrders,
  normalizeSourcePosition,
  parseArgs,
  parseJsonOutput,
  paymentTransaction,
  reconcileCloseJournal,
  normalizePluginReadiness,
  requireDistinctPaymentPayer,
  requirePinnedCloseExecutionReadiness,
  settleExecutionLock,
  summarizeOpenSellReservations,
  validatePaymentChallenge,
  writeReconciliationJournal,
} from "../scripts/buyer-orchestrator.mjs";
import {
  MANAGE_SERVICE_PRICE_ATOMIC,
  MANAGE_SERVICE_RESOURCE,
  POSITION_MANAGER_SERVICE,
  SERVICE_ASSET,
  SERVICE_NETWORK,
  SERVICE_PAYEE,
  SERVICE_PRICE_ATOMIC,
  SERVICE_RESOURCE,
} from "../src/service-payment.mjs";

const BASE = [
  "open",
  "--origin", "https://conviction-bay.vercel.app",
  "--market", "example-market",
  "--side", "yes",
  "--budget", "1.35",
  "--max-price", "0.27",
  "--payment-payer", "0x1111111111111111111111111111111111111111",
  "--buyer-wallet", "0x2222222222222222222222222222222222222222",
  "--issuer-registry", "config/trusted-issuer.production.json",
  "--json",
];

const CLOSE = [
  "close",
  "--origin", "https://conviction-bay.vercel.app",
  "--market", "example-market",
  "--side", "yes",
  "--shares", "5",
  "--min-price", "0.26",
  "--payment-payer", "0x1111111111111111111111111111111111111111",
  "--seller-wallet", "0x2222222222222222222222222222222222222222",
  "--source-proof", "proof.json",
  "--issuer-registry", "config/trusted-issuer.production.json",
  "--rationale", "Close only above my floor.",
  "--json",
];

test("buyer CLI accepts the release contract without pre-authorizing payment", () => {
  const parsed = parseArgs(BASE);
  assert.equal(parsed.command, "open");
  assert.equal(parsed.side, "YES");
  assert.equal(parsed.json, true);
  assert.equal("confirmPayment" in parsed, false);
});

test("buyer CLI accepts one source-bound bounded CLOSE contract", () => {
  const parsed = parseArgs(CLOSE);
  assert.deepEqual(parsed, {
    command: "close",
    origin: "https://conviction-bay.vercel.app",
    market: "example-market",
    side: "YES",
    paymentPayer: "0x1111111111111111111111111111111111111111",
    issuerRegistry: "config/trusted-issuer.production.json",
    json: true,
    shares: "5",
    minPrice: "0.26",
    sellerWallet: "0x2222222222222222222222222222222222222222",
    sourceProof: "proof.json",
    rationale: "Close only above my floor.",
  });
  assert.equal("budget" in parsed, false);
  assert.equal("confirmPayment" in parsed, false);
});

test("buyer CLI accepts the read-only CLOSE reconciliation command", () => {
  assert.deepEqual(parseArgs([
    "reconcile-close",
    "--journal", "/tmp/journey.json",
    "--issuer-registry", "config/trusted-issuer.production.json",
    "--json",
  ]), {
    command: "reconcile-close",
    journal: "/tmp/journey.json",
    issuerRegistry: "config/trusted-issuer.production.json",
    json: true,
  });
});

test("buyer CLI refuses incomplete or broadened CLOSE arguments", () => {
  assert.throws(
    () => parseArgs(CLOSE.filter((value, index, values) => value !== "--source-proof" && values[index - 1] !== "--source-proof")),
    /--source-proof is required/,
  );
  assert.throws(() => parseArgs([...CLOSE, "--order-type", "GTC"]), /Unknown arguments/);
  assert.throws(() => parseArgs([...CLOSE, "--auto-confirm"]), /Unknown arguments/);
});

test("buyer CLI rejects the removed auto/pre-confirmation flags", () => {
  assert.throws(() => parseArgs([...BASE, "--confirm-payment"]), /Unknown arguments/);
  assert.throws(() => parseArgs([...BASE, "--confirm", "auto"]), /Unknown arguments/);
});

test("JSON tool output and payment transaction parsing fail closed", () => {
  assert.deepEqual(parseJsonOutput('{"ok":true}', "fixture"), { ok: true });
  assert.throws(() => parseJsonOutput("not json", "fixture"), /did not return JSON/);
  const tx = `0x${"ab".repeat(32)}`;
  assert.equal(paymentTransaction({ transaction: tx }), tx);
  assert.throws(() => paymentTransaction({ transaction: "0x1234" }), /no settlement transaction/);
});

test("buyer CLI accepts only the exact pinned x402 challenge", () => {
  const challenge = {
    x402Version: 2,
    resource: { url: SERVICE_RESOURCE },
    accepts: [{
      scheme: "exact",
      network: SERVICE_NETWORK,
      asset: SERVICE_ASSET,
      payTo: SERVICE_PAYEE,
      amount: SERVICE_PRICE_ATOMIC,
    }],
  };

  assert.equal(validatePaymentChallenge(challenge), challenge.accepts[0]);

  for (const mutation of [
    { resource: { url: "https://attacker.example/api/service" } },
    { accepts: [{ ...challenge.accepts[0], amount: "50001" }] },
    { accepts: [{ ...challenge.accepts[0], network: "eip155:137" }] },
    { accepts: [{ ...challenge.accepts[0], payTo: "0x1111111111111111111111111111111111111111" }] },
  ]) {
    assert.throws(
      () => validatePaymentChallenge({ ...challenge, ...mutation }),
      (error) => error?.code === "payment_challenge_mismatch",
    );
  }
});

test("buyer CLI pins the position manager to /api/manage and 0.10 USD₮0", () => {
  const challenge = {
    x402Version: 2,
    resource: { url: MANAGE_SERVICE_RESOURCE },
    accepts: [{
      scheme: "exact",
      network: SERVICE_NETWORK,
      asset: SERVICE_ASSET,
      payTo: SERVICE_PAYEE,
      amount: MANAGE_SERVICE_PRICE_ATOMIC,
    }],
  };
  assert.equal(
    validatePaymentChallenge(challenge, POSITION_MANAGER_SERVICE),
    challenge.accepts[0],
  );
  assert.throws(
    () => validatePaymentChallenge({
      ...challenge,
      resource: { url: SERVICE_RESOURCE },
    }, POSITION_MANAGER_SERVICE),
    (error) => error?.code === "payment_challenge_mismatch",
  );
  assert.throws(
    () => validatePaymentChallenge({
      ...challenge,
      accepts: [{ ...challenge.accepts[0], amount: SERVICE_PRICE_ATOMIC }],
    }, POSITION_MANAGER_SERVICE),
    (error) => error?.code === "payment_challenge_mismatch",
  );
});

test("buyer CLI rejects a service-treasury self-payment", () => {
  assert.throws(
    () => requireDistinctPaymentPayer(SERVICE_PAYEE.toUpperCase()),
    (error) => error?.code === "self_payment_disallowed",
  );
  assert.equal(
    requireDistinctPaymentPayer("0x1111111111111111111111111111111111111111"),
    "0x1111111111111111111111111111111111111111",
  );
});

test("buyer CLI normalizes the installed deposit-wallet quickstart shape", () => {
  const payer = "0x1111111111111111111111111111111111111111";
  const wallet = "0x2222222222222222222222222222222222222222";
  const readiness = normalizePluginReadiness({
    access: { ok: true, data: { accessible: true } },
    addresses: {
      ok: true,
      data: { xlayer: [{ chainIndex: "196", address: payer }] },
    },
    quickstart: {
      ok: true,
      accessible: true,
      status: "active",
      assets: { deposit_wallet_pusd: "1.12" },
      wallet: { deposit_wallet: wallet },
    },
    selectedMode: "deposit-wallet",
    pUsdBalanceRaw: "1120000",
  });

  assert.deepEqual(readiness, {
    accessible: true,
    clobVersion: "V2",
    currentMode: "deposit_wallet",
    paymentPayer: payer,
    buyerWallet: wallet,
    tradingAddress: wallet,
    pUsdBalanceRaw: "1120000",
  });
});

test("buyer CLI does not infer V2 readiness without the selected deposit-wallet mode", () => {
  const readiness = normalizePluginReadiness({
    access: { data: { accessible: true } },
    addresses: { data: { xlayer: [] } },
    quickstart: {
      accessible: true,
      status: "active",
      wallet: { deposit_wallet: "0x2222222222222222222222222222222222222222" },
    },
    selectedMode: "",
    pUsdBalanceRaw: "0",
  });

  assert.equal(readiness.clobVersion, "");
  assert.equal(readiness.currentMode, "");
});

test("buyer CLI normalizes native OPEN output and the historical proof artifact", () => {
  const transactionHash = `0x${"11".repeat(32)}`;
  const orderId = `0x${"22".repeat(32)}`;
  const intentHash = `0x${"33".repeat(32)}`;
  const positionProofHash = `0x${"44".repeat(32)}`;
  const intent = { version: "conviction-intent-v3" };
  const issuance = { version: "conviction-issuance-v1" };
  const native = normalizeSourcePosition({
    ok: true,
    sourcePosition: {
      transactionHash,
      orderId,
      intentHash,
      positionProofHash,
      intent,
      issuance,
    },
  });
  assert.deepEqual(native, {
    transactionHash,
    orderId,
    intentHash,
    positionProofHash,
    intent,
    issuance,
  });

  const historical = normalizeSourcePosition({
    canonicalIntent: intent,
    hashes: { intentHash, positionProofHash },
    receiptProof: { transactionHash, orderId },
    positionProof: { transactionHash, orderId, intentHash },
  });
  assert.deepEqual(historical, {
    transactionHash,
    orderId,
    intentHash,
    positionProofHash,
    intent,
  });
  assert.throws(
    () => normalizeSourcePosition({ canonicalIntent: intent }),
    (error) => error?.code === "invalid_source_proof_file",
  );
});

test("buyer CLI normalizes only active open orders", () => {
  assert.deepEqual(normalizeOpenOrders({ ok: true, data: [] }), []);
  assert.equal(normalizeOpenOrders({
    ok: true,
    data: {
      orders: [
        { status: "OPEN", side: "BUY", token_id: "1" },
        { status: "live", side: "SELL", token_id: "2" },
        { status: "MATCHED", side: "SELL", token_id: "3" },
      ],
    },
  }).length, 2);
  assert.throws(
    () => normalizeOpenOrders({ ok: true, data: { count: 0 } }),
    (error) => error?.code === "invalid_tool_output",
  );
});

test("buyer CLI reserves only unmatched SELL shares for the selected outcome token", () => {
  const orders = {
    ok: true,
    data: {
      orders: [
        { status: "OPEN", side: "BUY", token_id: "1", original_size: "99", size_matched: "0" },
        { status: "LIVE", side: "SELL", token_id: "2", original_size: "8", size_matched: "0" },
        { status: "OPEN", side: "sell", token_id: "1", original_size: "5", size_matched: "1.25" },
        { status: "MATCHED", side: "SELL", token_id: "1", original_size: "4", size_matched: "4" },
      ],
    },
  };

  assert.deepEqual(summarizeOpenSellReservations(orders, "1"), {
    openSellOrderCount: 1,
    reservedSharesRaw: "3750000",
  });
  assert.deepEqual(summarizeOpenSellReservations(orders, "3"), {
    openSellOrderCount: 0,
    reservedSharesRaw: "0",
  });
});

test("buyer CLI fail-closes on malformed selected-token SELL reservations", () => {
  assert.throws(
    () => summarizeOpenSellReservations({
      orders: [{ status: "OPEN", side: "SELL", token_id: "1", original_size: null, size_matched: "0" }],
    }, "1"),
    (error) => error?.code === "invalid_tool_output",
  );
  assert.throws(
    () => summarizeOpenSellReservations({
      orders: [{ status: "OPEN", side: "SELL", token_id: "1", original_size: "1", size_matched: "2" }],
    }, "1"),
    (error) => error?.code === "invalid_tool_output",
  );
});

test("buyer CLI atomically blocks an unresolved duplicate CLOSE payment", async () => {
  const directory = await mkdtemp(join(tmpdir(), "conviction-close-replay-test-"));
  try {
    const input = {
      request: {
        market: "example-market",
        outcome: "YES",
        shares: "5",
        minPrice: "0.26",
        sourcePosition: {
          intentHash: `0x${"11".repeat(32)}`,
          positionProofHash: `0x${"22".repeat(32)}`,
          transactionHash: `0x${"33".repeat(32)}`,
          orderId: `0x${"44".repeat(32)}`,
          intent: {
            market: {
              conditionId: `0x${"55".repeat(32)}`,
              outcomeTokenId: "123456789",
            },
          },
        },
      },
      paymentPayer: "0x1111111111111111111111111111111111111111",
      sellerWallet: "0x2222222222222222222222222222222222222222",
    };
    const key = closeReplayKey(input);
    const path = await claimCloseReplayLock({ key, journal: "/tmp/journey.json", directory });
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    await assert.rejects(
      claimCloseReplayLock({ key, journal: "/tmp/another.json", directory }),
      (error) => error?.code === "close_replay_blocked" && error?.details?.replayLockPath === path,
    );
    assert.notEqual(
      closeReplayKey({ ...input, request: { ...input.request, minPrice: "0.27" } }),
      key,
    );
    assert.equal(
      closeReplayKey({
        ...input,
        paymentPayer: "0x9999999999999999999999999999999999999999",
        request: { ...input.request, market: "https://polymarket.com/event/example-market", shares: "5.000000", minPrice: "0.260000" },
      }),
      key,
    );
    assert.notEqual(
      closeReplayKey({
        ...input,
        request: {
          ...input.request,
          sourcePosition: {
            ...input.request.sourcePosition,
            intent: {
              market: {
                ...input.request.sourcePosition.intent.market,
                outcomeTokenId: "987654321",
              },
            },
          },
        },
      }),
      key,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("buyer CLI atomically journals reconciliation state outside Git with owner-only permissions", async () => {
  const directory = await mkdtemp(join(tmpdir(), "conviction-journal-test-"));
  const file = join(directory, "journey.json");
  try {
    const checkpoint = {
      stage: "live_result_received",
      reconciliationRequired: true,
      paidCard: { intentHash: `0x${"a".repeat(64)}` },
      liveResult: { ok: true, data: { order_id: `0x${"b".repeat(64)}` } },
    };
    assert.equal(
      await writeReconciliationJournal(checkpoint, { directory, file }),
      file,
    );
    assert.deepEqual(JSON.parse(await readFile(file, "utf8")), checkpoint);
    assert.equal((await stat(directory)).mode & 0o777, 0o700);
    assert.equal((await stat(file)).mode & 0o777, 0o600);
    assert.deepEqual(await readdir(directory), ["journey.json"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("buyer CLI serializes the final Polymarket execution window", async () => {
  const directory = await mkdtemp(join(tmpdir(), "conviction-execution-lock-test-"));
  const file = join(directory, "execution.lock.json");
  try {
    assert.equal(
      await claimExecutionLock({ journal: "/tmp/first.json", directory, file }),
      file,
    );
    assert.equal((await stat(file)).mode & 0o777, 0o600);
    await assert.rejects(
      claimExecutionLock({ journal: "/tmp/second.json", directory, file }),
      (error) => error?.code === "execution_reconciliation_required" &&
        error?.details?.executionLockPath === file,
    );
    const checkpoint = { executionLockPath: file };
    assert.deepEqual(
      await settleExecutionLock(checkpoint, { liveAttempted: true, proofVerified: false }),
      { released: false, retained: true, path: file },
    );
    await assert.rejects(
      claimExecutionLock({ journal: "/tmp/modified-close.json", directory, file }),
      (error) => error?.code === "execution_reconciliation_required",
    );
    const released = await settleExecutionLock(checkpoint, {
      liveAttempted: true,
      proofVerified: true,
      now: 1_000,
    });
    assert.equal(released.released, true);
    assert.equal(checkpoint.executionLockPath, null);
    assert.equal(checkpoint.executionLockReleasedAt, "1970-01-01T00:00:01.000Z");
    assert.equal(
      await claimExecutionLock({ journal: "/tmp/verified-next-close.json", directory, file }),
      file,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("locked CLOSE execution rechecks the active wallet, balance, approval, and reservations", () => {
  const wallet = "0x2222222222222222222222222222222222222222";
  const ready = {
    accessible: true,
    clobVersion: "V2",
    currentMode: "deposit_wallet",
    buyerWallet: wallet,
    tradingAddress: wallet,
    outcomeTokenId: "123",
    outcomeBalanceRaw: "5000000",
    approvedForExchange: true,
    reservedSharesRaw: "0",
    openSellOrderCount: 0,
  };
  assert.doesNotThrow(() => requirePinnedCloseExecutionReadiness(ready, {
    wallet,
    tokenId: "123",
    sharesRaw: 5_000_000n,
  }));
  assert.throws(
    () => requirePinnedCloseExecutionReadiness({ ...ready, tradingAddress: "0x3333333333333333333333333333333333333333" }, {
      wallet,
      tokenId: "123",
      sharesRaw: 5_000_000n,
    }),
    (error) => error?.code === "trading_wallet_mismatch",
  );
  assert.throws(
    () => requirePinnedCloseExecutionReadiness({ ...ready, openSellOrderCount: 1 }, {
      wallet,
      tokenId: "123",
      sharesRaw: 5_000_000n,
    }),
    (error) => error?.code === "position_reserved",
  );
});

test("CLOSE reconciliation releases only an expired unexecuted card's scoped locks", async () => {
  const directory = await mkdtemp(join(tmpdir(), "conviction-reconcile-test-"));
  const journal = join(directory, "journey.json");
  const replayLock = join(directory, `close-${"a".repeat(64)}.lock.json`);
  const executionLock = join(directory, "polymarket-execution.lock.json");
  try {
    const state = {
      mode: "close",
      stage: "paid_card_received",
      reconciliationRequired: true,
      paidCard: { fixture: true },
      executionArgvHash: null,
      replayLockPath: replayLock,
      executionLockPath: executionLock,
    };
    await Promise.all([
      writeFile(journal, JSON.stringify(state)),
      writeFile(replayLock, "{}"),
      writeFile(executionLock, "{}"),
    ]);
    const result = await reconcileCloseJournal({
      file: journal,
      trustedIssuers: new Map(),
      now: 2_000,
      stateDirectory: directory,
      validateCardImpl: () => ({ expiresAt: "1970-01-01T00:00:01.000Z" }),
    });
    assert.equal(result.status, "expired_unexecuted_reconciled");
    assert.equal(result.reconciliationRequired, false);
    assert.deepEqual((await readdir(directory)).sort(), ["journey.json"]);
    const updated = JSON.parse(await readFile(journal, "utf8"));
    assert.equal(updated.replayLockPath, null);
    assert.equal(updated.executionLockPath, null);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
