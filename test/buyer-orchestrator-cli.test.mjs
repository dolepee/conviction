import assert from "node:assert/strict";
import { access, chmod, mkdtemp, readFile, readdir, realpath, rm, stat, symlink, unlink, writeFile as fsWriteFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

const writeFile = (file, data, options = {}) => fsWriteFile(file, data, { ...options, mode: 0o600 });

import { sha256 } from "../src/canonical.mjs";
import {
  claimCloseReplayLock,
  claimExecutionLock,
  claimVerifiedPaymentTransaction,
  closeReplayKey,
  fetchEip3009AuthorizationState,
  normalizeOpenOrders,
  normalizeSourcePosition,
  openReplayKey,
  parseArgs,
  parseJsonOutput,
  paymentAuthorizationMetadata,
  paymentTransaction,
  persistBoundTradeConsent,
  persistSuccessfulPaidServiceResponse,
  persistVerifiedPaidServicePayment,
  reconcileCloseJournal,
  reconcileOpenJournal,
  recoverKnownUnstartedCloseExecution,
  resumePaidCloseJournal,
  normalizePluginReadiness,
  requireDistinctPaymentPayer,
  requireExecutionLaunchWindow,
  requirePinnedCloseExecutionReadiness,
  shouldPersistFailureCheckpoint,
  settleExecutionLock,
  summarizeOpenSellReservations,
  validatePaymentChallenge,
  verifyStoredPaymentTransactionClaim,
  waitForStrictlyPostConfirmationSecond,
  writeReconciliationJournal,
} from "../scripts/buyer-orchestrator.mjs";
import {
  MANAGE_SERVICE_PRICE_ATOMIC,
  MANAGE_SERVICE_RESOURCE,
  POSITION_CARD_SERVICE,
  POSITION_MANAGER_SERVICE,
  SERVICE_ASSET,
  SERVICE_NETWORK,
  SERVICE_PAYEE,
  SERVICE_PRICE_ATOMIC,
  SERVICE_RESOURCE,
} from "../src/service-payment.mjs";
import { fetchAndVerifyX402Payment } from "../src/x402-payment-verifier.mjs";

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

function exactServicePaymentProof({
  paymentTx = `0x${"f".repeat(64)}`,
  payer = "0x1111111111111111111111111111111111111111",
  amountAtomic = MANAGE_SERVICE_PRICE_ATOMIC,
} = {}) {
  return {
    version: "conviction-x402-payment-v1",
    chainId: 196,
    transactionHash: paymentTx,
    blockNumber: "10",
    blockHash: `0x${"e".repeat(64)}`,
    blockTimestamp: "2",
    asset: SERVICE_ASSET,
    payer,
    payee: SERVICE_PAYEE,
    amountAtomic,
    logIndex: "0x1",
    checks: {
      transactionSucceeded: true,
      receiptBoundToBlock: true,
      freshPayment: true,
      exactAsset: true,
      exactPayer: true,
      exactPayee: true,
      exactAmount: true,
    },
  };
}

test("buyer CLI accepts the release contract without pre-authorizing payment", () => {
  const parsed = parseArgs(BASE);
  assert.equal(parsed.command, "open");
  assert.equal(parsed.side, "YES");
  assert.equal(parsed.json, true);
  assert.equal("confirmPayment" in parsed, false);
  assert.throws(
    () => parseArgs(BASE.map((value) => value === "https://conviction-bay.vercel.app" ? "https://attacker.example" : value)),
    (error) => error?.code === "untrusted_service_origin",
  );
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

test("buyer execution launch window is absolute and leaves safe headroom", () => {
  const now = Date.parse("2026-07-21T02:00:00.000Z");
  const card = { expiresAt: "2026-07-21T02:00:30.000Z" };
  assert.deepEqual(requireExecutionLaunchWindow(card, { now: () => now }), {
    observedAt: now,
    deadlineEpochMs: Date.parse(card.expiresAt),
  });
  assert.throws(
    () => requireExecutionLaunchWindow(card, { now: () => now + 20_001 }),
    (error) => error?.code === "insufficient_execution_window",
  );
});

test("buyer execution waits until an order can strictly postdate confirmation", async () => {
  const confirmedAt = "2026-07-22T02:00:10.250Z";
  const sleeps = [];
  let clock = Date.parse("2026-07-22T02:00:10.400Z");
  assert.equal(await waitForStrictlyPostConfirmationSecond(confirmedAt, {
    now: () => clock,
    async sleep(milliseconds) { sleeps.push(milliseconds); clock += milliseconds; },
  }), Date.parse("2026-07-22T02:00:11.000Z"));
  assert.deepEqual(sleeps, [600]);
  clock = Date.parse("2026-07-22T02:00:11.001Z");
  await waitForStrictlyPostConfirmationSecond(confirmedAt, {
    now: () => clock,
    async sleep(milliseconds) { sleeps.push(milliseconds); },
  });
  assert.deepEqual(sleeps, [600]);
  await assert.rejects(
    waitForStrictlyPostConfirmationSecond(confirmedAt, {
      now: () => Date.parse("2026-07-22T02:00:10.400Z"),
      async sleep() {},
    }),
    (error) => error?.code === "confirmation_second_active",
  );
});

for (const [mode, version] of [
  ["open", "conviction-open-trade-consent-v1"],
  ["close", "conviction-close-trade-consent-v1"],
]) {
  test(`${mode.toUpperCase()} journal I/O preserves the exact structured consent timestamp`, async () => {
    let clock = Date.parse("2026-07-22T02:00:10.999Z");
    let durable;
    const state = {
      paymentTx: `0x${"11".repeat(32)}`,
      replayKey: `0x${"22".repeat(32)}`,
      tradeConfirmedAt: null,
      tradeConsent: null,
      stage: "payment_verified",
      reconciliationRequired: false,
    };
    const validated = {
      intentHash: `0x${"33".repeat(32)}`,
      expiresAt: "2026-07-22T02:05:00.000Z",
      executionCard: { argv: [mode === "open" ? "buy" : "sell", "--token-id", "123"] },
    };
    const result = await persistBoundTradeConsent({
      state,
      mode,
      validated,
      now: () => clock,
      writeState: async (value) => {
        durable = structuredClone(value);
        clock = Date.parse("2026-07-22T02:00:11.050Z");
      },
    });
    const exact = Date.parse("2026-07-22T02:00:10.999Z");
    assert.deepEqual(result, { accepted: true, confirmedAt: exact });
    assert.equal(state.tradeConfirmedAt, "2026-07-22T02:00:10.999Z");
    assert.equal(durable.tradeConfirmedAt, state.tradeConfirmedAt);
    assert.equal(state.tradeConsent.version, version);
    assert.equal(state.tradeConsent.confirmedAt, state.tradeConfirmedAt);
    assert.equal(state.tradeConsent.intentHash, validated.intentHash);
    assert.equal(state.tradeConsent.paymentTx, state.paymentTx);
    assert.equal(state.tradeConsent.replayKey, state.replayKey);
    assert.equal(state.stage, "trade_confirmed");
    assert.equal(state.reconciliationRequired, true);
    assert.equal(
      await waitForStrictlyPostConfirmationSecond(state.tradeConfirmedAt, { now: () => clock }),
      Date.parse("2026-07-22T02:00:11.000Z"),
    );
  });
}

test("buyer CLI does not persist an empty journal for parse or other preflight-only failures", () => {
  assert.equal(shouldPersistFailureCheckpoint({ stage: "not_started" }, { executionStarted: false }), false);
  assert.equal(shouldPersistFailureCheckpoint({ stage: "previewed" }, { executionStarted: false }), false);
  assert.equal(shouldPersistFailureCheckpoint({ paymentRequestedAt: "2026-07-21T22:00:00.000Z" }, { executionStarted: false }), true);
  assert.equal(shouldPersistFailureCheckpoint({ replayLockPath: "/private/replay.lock" }, { executionStarted: false }), true);
  assert.equal(shouldPersistFailureCheckpoint({ stage: "not_started" }, { executionStarted: true }), true);
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

test("buyer CLI accepts the owner-bound read-only OPEN reconciliation command", () => {
  assert.deepEqual(parseArgs([
    "reconcile-open",
    "--journal", "/tmp/journey.json",
    "--issuer-registry", "config/trusted-issuer.production.json",
    "--json",
  ]), {
    command: "reconcile-open",
    journal: "/tmp/journey.json",
    issuerRegistry: "config/trusted-issuer.production.json",
    json: true,
  });
  assert.throws(
    () => parseArgs([
      "reconcile-open", "--journal", "/tmp/journey.json",
      "--issuer-registry", "issuers.json", "--transaction", `0x${"11".repeat(32)}`,
    ]),
    /Unknown arguments/,
  );
});

test("OPEN reconciliation rejects a journal symlink that escapes the private state directory", async () => {
  const directory = await mkdtemp(join(tmpdir(), "conviction-open-symlink-state-"));
  const outsideDirectory = await mkdtemp(join(tmpdir(), "conviction-open-symlink-outside-"));
  const outsideJournal = join(outsideDirectory, "outside.json");
  const linkedJournal = join(directory, "journey.json");
  try {
    await writeFile(outsideJournal, JSON.stringify({ mode: "open" }));
    await symlink(outsideJournal, linkedJournal);
    await assert.rejects(
      reconcileOpenJournal({
        file: linkedJournal,
        trustedIssuers: new Map(),
        stateDirectory: directory,
      }),
      (error) => error?.code === "unsafe_state_path",
    );
  } finally {
    await Promise.all([
      rm(directory, { recursive: true, force: true }),
      rm(outsideDirectory, { recursive: true, force: true }),
    ]);
  }
});

test("buyer CLI accepts only journal and issuer inputs for paid CLOSE resume", () => {
  assert.deepEqual(parseArgs([
    "resume-close",
    "--journal", "/tmp/journey.json",
    "--issuer-registry", "config/trusted-issuer.production.json",
    "--json",
  ]), {
    command: "resume-close",
    journal: "/tmp/journey.json",
    issuerRegistry: "config/trusted-issuer.production.json",
    json: true,
  });
  assert.throws(
    () => parseArgs([
      "resume-close", "--journal", "/tmp/journey.json",
      "--issuer-registry", "issuers.json", "--payment-payer", "0x1234",
    ]),
    /Unknown arguments/,
  );
  assert.equal(typeof resumePaidCloseJournal, "function");
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

test("buyer CLI records only pinned non-secret EIP-3009 authorization metadata", () => {
  const payer = "0x1111111111111111111111111111111111111111";
  const nonce = `0x${"ab".repeat(32)}`;
  const encoded = Buffer.from(JSON.stringify({
    x402Version: 2,
    accepted: {
      scheme: "exact",
      network: SERVICE_NETWORK,
      asset: SERVICE_ASSET,
      amount: MANAGE_SERVICE_PRICE_ATOMIC,
      payTo: SERVICE_PAYEE,
      maxTimeoutSeconds: 300,
      extra: { name: "USD₮0", version: "1" },
    },
    payload: {
      authorization: {
        from: payer,
        to: SERVICE_PAYEE,
        value: MANAGE_SERVICE_PRICE_ATOMIC,
        validAfter: "100",
        validBefore: "400",
        nonce,
      },
      signature: `0x${"cd".repeat(65)}`,
    },
  })).toString("base64");
  const metadata = paymentAuthorizationMetadata(encoded, {
    paymentPayer: payer,
    service: POSITION_MANAGER_SERVICE,
    now: 105_000,
  });
  assert.deepEqual(metadata, {
    version: "conviction-x402-authorization-v1",
    scheme: "exact-eip3009",
    network: SERVICE_NETWORK,
    asset: SERVICE_ASSET,
    from: payer,
    to: SERVICE_PAYEE,
    value: MANAGE_SERVICE_PRICE_ATOMIC,
    validAfter: "100",
    validBefore: "400",
    nonce,
  });
  assert.equal("signature" in metadata, false);
  const epochNowSeconds = 1_784_667_653;
  const epochOrigin = JSON.parse(Buffer.from(encoded, "base64").toString("utf8"));
  epochOrigin.payload.authorization.validAfter = "0";
  epochOrigin.payload.authorization.validBefore = String(epochNowSeconds + 300);
  assert.equal(paymentAuthorizationMetadata(
    Buffer.from(JSON.stringify(epochOrigin)).toString("base64"),
    {
      paymentPayer: payer,
      service: POSITION_MANAGER_SERVICE,
      now: epochNowSeconds * 1_000,
    },
  ).validAfter, "0");
  epochOrigin.payload.authorization.validBefore = String(epochNowSeconds + 306);
  assert.throws(
    () => paymentAuthorizationMetadata(
      Buffer.from(JSON.stringify(epochOrigin)).toString("base64"),
      {
        paymentPayer: payer,
        service: POSITION_MANAGER_SERVICE,
        now: epochNowSeconds * 1_000,
      },
    ),
    (error) => error?.code === "payment_authorization_mismatch",
  );
  assert.throws(
    () => paymentAuthorizationMetadata(encoded, {
      paymentPayer: "0x2222222222222222222222222222222222222222",
      service: POSITION_MANAGER_SERVICE,
      now: 105_000,
    }),
    (error) => error?.code === "payment_authorization_mismatch",
  );
  const longLived = JSON.parse(Buffer.from(encoded, "base64").toString("utf8"));
  longLived.payload.authorization.validBefore = "500";
  assert.throws(
    () => paymentAuthorizationMetadata(Buffer.from(JSON.stringify(longLived)).toString("base64"), {
      paymentPayer: payer,
      service: POSITION_MANAGER_SERVICE,
      now: 105_000,
    }),
    (error) => error?.code === "payment_authorization_mismatch",
  );
});

test("authorization-state recovery reads the canonical finalized X Layer block", async () => {
  const calls = [];
  const blockHash = `0x${"12".repeat(32)}`;
  const fetchImpl = async (_url, options) => {
    const request = JSON.parse(options.body);
    calls.push(request);
    const result = request.method === "eth_chainId"
      ? "0xc4"
      : request.method === "eth_getBlockByNumber"
        ? { number: "0x10", timestamp: "0x20", hash: blockHash }
        : `0x${"0".repeat(64)}`;
    return { ok: true, async json() { return { jsonrpc: "2.0", id: request.id, result }; } };
  };
  const result = await fetchEip3009AuthorizationState({
    asset: SERVICE_ASSET,
    from: "0x1111111111111111111111111111111111111111",
    nonce: `0x${"ab".repeat(32)}`,
  }, { fetchImpl, rpcUrl: "https://xlayer.example.invalid" });
  assert.equal(result.used, false);
  assert.equal(result.blockHash, blockHash);
  assert.deepEqual(calls.map((call) => call.method), ["eth_chainId", "eth_getBlockByNumber", "eth_call"]);
  assert.deepEqual(calls[1].params, ["finalized", false]);
  assert.deepEqual(calls[2].params[1], { blockHash, requireCanonical: true });
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
      maxTimeoutSeconds: 300,
      extra: { name: "USD₮0", version: "1" },
    }],
  };

  assert.equal(validatePaymentChallenge(challenge), challenge.accepts[0]);

  for (const mutation of [
    { resource: { url: "https://attacker.example/api/service" } },
    { accepts: [{ ...challenge.accepts[0], amount: "50001" }] },
    { accepts: [{ ...challenge.accepts[0], network: "eip155:137" }] },
    { accepts: [{ ...challenge.accepts[0], payTo: "0x1111111111111111111111111111111111111111" }] },
    { accepts: [{ ...challenge.accepts[0], maxTimeoutSeconds: 600 }] },
    { accepts: [{ ...challenge.accepts[0], extra: { ...challenge.accepts[0].extra, assetTransferMethod: "permit2" } }] },
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
      maxTimeoutSeconds: 300,
      extra: { name: "USD₮0", version: "1" },
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

test("buyer CLI reserves official V2 atomic SELL shares only for the selected outcome token", () => {
  const orders = {
    ok: true,
    data: {
      orders: [
        { status: "ORDER_STATUS_LIVE", side: "BUY", token_id: "1", original_size: "99000000", size_matched: "0" },
        { status: "ORDER_STATUS_LIVE", side: "SELL", token_id: "2", original_size: "8000000", size_matched: "0" },
        { status: "ORDER_STATUS_LIVE", side: "sell", token_id: "1", original_size: "5000000", size_matched: "1250000" },
        { status: "ORDER_STATUS_LIVE", side: "SELL", token_id: "1", original_size: "2000000", size_matched: "2000000" },
        { status: "ORDER_STATUS_MATCHED", side: "SELL", token_id: "1", original_size: "4000000", size_matched: "4000000" },
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
      orders: [{ status: "OPEN", side: null, token_id: "2", original_size: "1", size_matched: "0" }],
    }, "1"),
    (error) => error?.code === "invalid_tool_output",
  );
  assert.throws(
    () => summarizeOpenSellReservations({
      orders: [{ status: "OPEN", side: "BUY", token_id: null, original_size: "1", size_matched: "0" }],
    }, "1"),
    (error) => error?.code === "invalid_tool_output",
  );
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
  assert.throws(
    () => summarizeOpenSellReservations({
      orders: [{ status: "ORDER_STATUS_LIVE", side: "SELL", token_id: "01", original_size: "1", size_matched: "0" }],
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
  const directory = await realpath(await mkdtemp(join(tmpdir(), "conviction-execution-lock-test-")));
  const file = join(directory, "polymarket-execution.lock.json");
  const journal = join(directory, "journey.json");
  const deadline = "2099-01-01T00:00:00.000Z";
  const initialState = (journalPath) => ({
    journalRevision: 0,
    journalPath,
    stage: "trade_confirmed",
    executionLockPath: null,
    executionLockGeneration: null,
    executionLockHash: null,
    executionLockPurpose: null,
    executionLockRecoveryNotBefore: null,
    reconciliationRequired: true,
  });
  try {
    const checkpoint = initialState(journal);
    await writeReconciliationJournal(checkpoint, { directory, file: journal });
    assert.equal(
      await claimExecutionLock({
        journal,
        directory,
        file,
        state: checkpoint,
        purpose: "OPEN_PLACE",
        recoveryNotBefore: deadline,
      }),
      file,
    );
    assert.equal((await stat(file)).mode & 0o777, 0o600);
    const secondJournal = join(directory, "second.json");
    const secondState = initialState(secondJournal);
    await writeReconciliationJournal(secondState, { directory, file: secondJournal });
    await assert.rejects(
      claimExecutionLock({
        journal: secondJournal,
        directory,
        file,
        state: secondState,
        purpose: "CLOSE_PLACE",
        recoveryNotBefore: deadline,
      }),
      (error) => error?.code === "execution_reconciliation_required" &&
        error?.details?.executionLockPath === file,
    );
    assert.deepEqual(
      await settleExecutionLock(checkpoint, { liveAttempted: true, proofVerified: false }),
      { released: false, retained: true, path: file },
    );
    await assert.rejects(
      claimExecutionLock({
        journal: secondJournal,
        directory,
        file,
        state: secondState,
        purpose: "CLOSE_PLACE",
        recoveryNotBefore: deadline,
      }),
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
    const nextJournal = join(directory, "verified-next-close.json");
    const nextState = initialState(nextJournal);
    await writeReconciliationJournal(nextState, { directory, file: nextJournal });
    assert.equal(
      await claimExecutionLock({
        journal: nextJournal,
        directory,
        file,
        state: nextState,
        purpose: "CLOSE_PLACE",
        recoveryNotBefore: deadline,
      }),
      file,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("known-unstarted CLOSE restores only its paid resumable checkpoint and retains replay protection", async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "conviction-close-prelaunch-recovery-")));
  const journal = join(directory, "journey.json");
  const replayKey = `0x${"a".repeat(64)}`;
  const replayLock = join(directory, `close-${"a".repeat(64)}.lock.json`);
  const executionLock = join(directory, "polymarket-execution.lock.json");
  try {
    const state = {
      mode: "close",
      stage: "execution_attempted",
      journalPath: journal,
      reconciliationRequired: true,
      tradeConsent: {
        version: "conviction-close-trade-consent-v1",
        expiresAt: "2026-07-22T02:05:00.000Z",
        executionArgvHash: sha256(["sell", "--order-type", "FOK"]),
      },
      paymentTx: `0x${"1".repeat(64)}`,
      paymentProof: {},
      paidCard: {},
      intentHash: `0x${"2".repeat(64)}`,
      paidServiceResponse: { status: 200, paymentResponsePresent: true },
      paymentRequestedAt: "2026-07-22T01:59:00.000Z",
      paymentPayer: "0x1111111111111111111111111111111111111111",
      buyerWallet: "0x2222222222222222222222222222222222222222",
      replayKey,
      replayLockPath: replayLock,
      executionLockPath: null,
      executionLockGeneration: null,
      executionLockHash: null,
      executionLockPurpose: null,
      executionLockRecoveryNotBefore: null,
      executionArgv: ["sell", "--order-type", "FOK"],
      executionArgvHash: sha256(["sell", "--order-type", "FOK"]),
      executionAttemptedAt: "2026-07-22T02:00:10.000Z",
      liveResult: null,
      orderId: null,
      settlementTx: null,
    };
    await writeFile(replayLock, JSON.stringify({
        version: "conviction-close-replay-lock-v1",
        replayKey,
        journalPath: journal,
      }));
    await writeReconciliationJournal(state, { directory, file: journal });
    await claimExecutionLock({
      journal,
      directory,
      file: executionLock,
      state,
      purpose: "CLOSE_PLACE",
      recoveryNotBefore: state.tradeConsent.expiresAt,
      now: () => Date.parse("2026-07-22T02:00:09.000Z"),
    });
    const result = await recoverKnownUnstartedCloseExecution(state, {
      journal,
      stateDirectory: directory,
      errorCode: "insufficient_execution_window",
      now: 1_000,
    });
    assert.equal(result.resumable, true);
    assert.equal(state.stage, "trade_confirmed");
    assert.equal(state.executionArgv, null);
    assert.equal(state.executionArgvHash, null);
    assert.equal(state.executionAttemptedAt, null);
    assert.equal(state.executionLockPath, null);
    assert.equal(state.replayLockPath, replayLock);
    assert.deepEqual((await readdir(directory)).sort(), [
      `close-${"a".repeat(64)}.lock.json`,
      "journey.json",
    ]);
    const persisted = JSON.parse(await readFile(journal, "utf8"));
    assert.equal(persisted.executionBlockedBeforeLaunch.liveProcessStarted, false);
    assert.equal(persisted.executionBlockedBeforeLaunch.replayLockRetained, true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("known-unstarted CLOSE never releases an execution lock owned by another journey", async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "conviction-close-prelaunch-owner-")));
  const journal = join(directory, "journey.json");
  const replayKey = `0x${"a".repeat(64)}`;
  const replayLock = join(directory, `close-${"a".repeat(64)}.lock.json`);
  const executionLock = join(directory, "polymarket-execution.lock.json");
  const state = {
    mode: "close",
    stage: "execution_attempted",
    journalPath: journal,
    reconciliationRequired: true,
    tradeConsent: {
      version: "conviction-close-trade-consent-v1",
      expiresAt: "2026-07-22T02:05:00.000Z",
      executionArgvHash: sha256(["sell"]),
    },
    paymentTx: `0x${"1".repeat(64)}`,
    paymentProof: {},
    paidCard: {},
    intentHash: `0x${"2".repeat(64)}`,
    paidServiceResponse: { status: 200, paymentResponsePresent: true },
    paymentRequestedAt: "2026-07-22T01:59:00.000Z",
    paymentPayer: "0x1111111111111111111111111111111111111111",
    buyerWallet: "0x2222222222222222222222222222222222222222",
    replayKey,
    replayLockPath: replayLock,
    executionLockPath: null,
    executionLockGeneration: null,
    executionLockHash: null,
    executionLockPurpose: null,
    executionLockRecoveryNotBefore: null,
    executionArgv: ["sell"],
    executionArgvHash: sha256(["sell"]),
    executionAttemptedAt: "2026-07-22T02:00:10.000Z",
    liveResult: null,
    orderId: null,
    settlementTx: null,
  };
  try {
    await writeFile(replayLock, JSON.stringify({
        version: "conviction-close-replay-lock-v1",
        replayKey,
        journalPath: journal,
      }));
    await writeReconciliationJournal(state, { directory, file: journal });
    await claimExecutionLock({
      journal,
      directory,
      file: executionLock,
      state,
      purpose: "CLOSE_PLACE",
      recoveryNotBefore: state.tradeConsent.expiresAt,
      now: () => Date.parse("2026-07-22T02:00:09.000Z"),
    });
    const foreign = JSON.parse(await readFile(executionLock, "utf8"));
    foreign.journalPath = join(directory, "another.json");
    await writeFile(executionLock, JSON.stringify(foreign));
    await assert.rejects(
      recoverKnownUnstartedCloseExecution(state, { journal, stateDirectory: directory }),
      (error) => error?.code === "lock_ownership_mismatch",
    );
    assert.deepEqual((await readdir(directory)).sort(), [
      `close-${"a".repeat(64)}.lock.json`,
      "journey.json",
      "polymarket-execution.lock.json",
    ]);
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

test("CLOSE reconciliation releases only an expired unconfirmed card's replay lock", async () => {
  const directory = await mkdtemp(join(tmpdir(), "conviction-reconcile-test-"));
  const journal = join(directory, "journey.json");
  const paymentTx = `0x${"f".repeat(64)}`;
  const fixture = paidResponseFixture({ mode: "close", journal });
  try {
    const state = {
      ...fixture.state,
      stage: "payment_verified",
      reconciliationRequired: true,
      paymentTx,
      paymentProof: exactServicePaymentProof({ paymentTx }),
      paidServiceResponse: { status: 200, paymentResponsePresent: true },
      paidCard: { fixture: true },
      executionArgvHash: null,
      executionLockPath: null,
      paymentClaimPath: null,
      paymentClaimHash: null,
    };
    await Promise.all([
      writeFile(journal, JSON.stringify(state)),
      writeFile(fixture.replayLockPath, JSON.stringify(fixture.lock)),
    ]);
    const claimed = await claimVerifiedPaymentTransaction({
      state,
      paymentProof: state.paymentProof,
      service: POSITION_MANAGER_SERVICE,
    });
    state.paymentClaimPath = claimed.file;
    state.paymentClaimHash = claimed.claimHash;
    await writeFile(journal, JSON.stringify(state));
    const result = await reconcileCloseJournal({
      file: journal,
      trustedIssuers: new Map(),
      now: 2_000,
      stateDirectory: directory,
      validateCardImpl: () => ({ expiresAt: "1970-01-01T00:00:01.000Z" }),
    });
    assert.equal(result.status, "expired_unexecuted_reconciled");
    assert.equal(result.reconciliationRequired, false);
    assert.deepEqual((await readdir(directory)).sort(), [
      "journey.json",
      `payment-${paymentTx.slice(2)}.lock.json`,
    ]);
    const updated = JSON.parse(await readFile(journal, "utf8"));
    assert.equal(updated.replayLockPath, null);
    assert.equal(updated.executionLockPath, null);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("CLOSE reconciliation never treats a legacy card-only response as paid release authority", async () => {
  const directory = await mkdtemp(join(tmpdir(), "conviction-reconcile-unverified-card-test-"));
  const journal = join(directory, "journey.json");
  const replayLock = join(directory, `close-${"a".repeat(64)}.lock.json`);
  const replayKey = `0x${"a".repeat(64)}`;
  try {
    const state = {
      mode: "close",
      stage: "paid_card_received",
      reconciliationRequired: true,
      paidCard: { fixture: true },
      paymentTx: `0x${"f".repeat(64)}`,
      paymentProof: null,
      executionArgvHash: null,
      replayKey,
      replayLockPath: replayLock,
      executionLockPath: null,
    };
    await Promise.all([
      writeFile(journal, JSON.stringify(state)),
      writeFile(replayLock, JSON.stringify({
        version: "conviction-close-replay-lock-v1",
        replayKey,
        journalPath: journal,
      })),
    ]);
    const result = await reconcileCloseJournal({
      file: journal,
      trustedIssuers: new Map(),
      now: 2_000,
      stateDirectory: directory,
      validateCardImpl: () => assert.fail("unverified merchant card must not be trusted"),
    });
    assert.equal(result.status, "manual_reconciliation_required");
    assert.equal(result.reason, "payment_verification_missing_or_mismatched");
    await access(replayLock);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

function rejectedPaymentState({ replayLock, validBefore = "10", stage = "paid_request_rejected_pre_settlement" }) {
  const replayKey = `0x${"a".repeat(64)}`;
  return {
    mode: "close",
    stage,
    reconciliationRequired: true,
    paymentPayer: "0x1111111111111111111111111111111111111111",
    paymentTx: null,
    paidCard: null,
    orderId: null,
    settlementTx: null,
    tradeConfirmedAt: null,
    liveResult: null,
    executionArgv: null,
    executionArgvHash: null,
    replayKey,
    replayLockPath: replayLock,
    executionLockPath: null,
    paidServiceResponse: stage === "payment_authorization_created" || stage === "payment_header_rejected_after_authorization"
      ? null
      : { status: stage === "paid_request_rejected_pre_settlement" ? 422 : 200, paymentResponsePresent: false },
    paymentAuthorization: {
      version: "conviction-x402-authorization-v1",
      scheme: "exact-eip3009",
      network: SERVICE_NETWORK,
      asset: SERVICE_ASSET,
      from: "0x1111111111111111111111111111111111111111",
      to: SERVICE_PAYEE,
      value: MANAGE_SERVICE_PRICE_ATOMIC,
      validAfter: "0",
      validBefore,
      nonce: `0x${"ab".repeat(32)}`,
    },
  };
}

function replayLockDocument(journal) {
  return JSON.stringify({
    version: "conviction-close-replay-lock-v1",
    replayKey: `0x${"a".repeat(64)}`,
    journalPath: journal,
  });
}

test("CLOSE reconciliation retains a rejected payment lock until the authorization expires on chain", async () => {
  const directory = await mkdtemp(join(tmpdir(), "conviction-reconcile-auth-wait-test-"));
  const journal = join(directory, "journey.json");
  const replayLock = join(directory, `close-${"a".repeat(64)}.lock.json`);
  try {
    await Promise.all([
      writeFile(journal, JSON.stringify(rejectedPaymentState({ replayLock, validBefore: "10" }))),
      writeFile(replayLock, replayLockDocument(journal)),
    ]);
    let stateReads = 0;
    const result = await reconcileCloseJournal({
      file: journal,
      trustedIssuers: new Map(),
      now: 9_000,
      stateDirectory: directory,
      async authorizationStateImpl() { stateReads += 1; return { used: false, blockTimestamp: "11" }; },
    });
    assert.equal(result.status, "waiting_for_authorization_expiry");
    assert.equal(result.reconciliationRequired, true);
    assert.equal(stateReads, 0);
    assert.deepEqual((await readdir(directory)).sort(), [
      `close-${"a".repeat(64)}.lock.json`,
      "journey.json",
    ]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("CLOSE reconciliation releases an expired rejected authorization only when on-chain state is unused", async () => {
  const directory = await mkdtemp(join(tmpdir(), "conviction-reconcile-auth-unused-test-"));
  const journal = join(directory, "journey.json");
  const replayLock = join(directory, `close-${"a".repeat(64)}.lock.json`);
  try {
    await Promise.all([
      writeFile(journal, JSON.stringify(rejectedPaymentState({ replayLock, validBefore: "1" }))),
      writeFile(replayLock, replayLockDocument(journal)),
    ]);
    const result = await reconcileCloseJournal({
      file: journal,
      trustedIssuers: new Map(),
      now: 2_000,
      stateDirectory: directory,
      async authorizationStateImpl() { return { used: false, blockTimestamp: "2" }; },
    });
    assert.equal(result.status, "expired_unsettled_authorization_reconciled");
    assert.equal(result.reconciliationRequired, false);
    assert.deepEqual(await readdir(directory), ["journey.json"]);
    const updated = JSON.parse(await readFile(journal, "utf8"));
    assert.equal(updated.replayLockPath, null);
    assert.equal(updated.reconciliationReason, "expired_unsettled_authorization");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("CLOSE reconciliation retains the lock when a rejected authorization was consumed", async () => {
  const directory = await mkdtemp(join(tmpdir(), "conviction-reconcile-auth-used-test-"));
  const journal = join(directory, "journey.json");
  const replayLock = join(directory, `close-${"a".repeat(64)}.lock.json`);
  try {
    await Promise.all([
      writeFile(journal, JSON.stringify(rejectedPaymentState({ replayLock, validBefore: "1" }))),
      writeFile(replayLock, replayLockDocument(journal)),
    ]);
    const result = await reconcileCloseJournal({
      file: journal,
      trustedIssuers: new Map(),
      now: 2_000,
      stateDirectory: directory,
      async authorizationStateImpl() { return { used: true, blockTimestamp: "2" }; },
    });
    assert.equal(result.status, "manual_reconciliation_required");
    assert.equal(result.reason, "payment_authorization_consumed_or_ambiguous");
    assert.equal(result.reconciliationRequired, true);
    assert.equal((await readdir(directory)).length, 2);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("CLOSE reconciliation safely recovers rejected-header, timeout, and ambiguous-response stages after finalized expiry", async () => {
  for (const stage of [
    "payment_authorization_created",
    "payment_header_rejected_after_authorization",
    "paid_request_settlement_ambiguous",
  ]) {
    const directory = await mkdtemp(join(tmpdir(), `conviction-reconcile-${stage}-test-`));
    const journal = join(directory, "journey.json");
    const replayLock = join(directory, `close-${"a".repeat(64)}.lock.json`);
    try {
      await Promise.all([
        writeFile(journal, JSON.stringify(rejectedPaymentState({ replayLock, validBefore: "1", stage }))),
        writeFile(replayLock, replayLockDocument(journal)),
      ]);
      const result = await reconcileCloseJournal({
        file: journal,
        trustedIssuers: new Map(),
        now: 2_000,
        stateDirectory: directory,
        async authorizationStateImpl() {
          return { used: false, blockNumber: "10", blockHash: `0x${"12".repeat(32)}`, blockTimestamp: "2" };
        },
      });
      assert.equal(result.status, "expired_unsettled_authorization_reconciled");
      assert.equal(result.reconciliationRequired, false);
      assert.deepEqual(await readdir(directory), ["journey.json"]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
});

test("CLOSE reconciliation never releases a replay lock owned by another journal", async () => {
  const directory = await mkdtemp(join(tmpdir(), "conviction-reconcile-wrong-owner-test-"));
  const journal = join(directory, "journey.json");
  const replayLock = join(directory, `close-${"a".repeat(64)}.lock.json`);
  try {
    await Promise.all([
      writeFile(journal, JSON.stringify(rejectedPaymentState({ replayLock, validBefore: "1" }))),
      writeFile(replayLock, replayLockDocument(join(directory, "another-journey.json"))),
    ]);
    await assert.rejects(
      reconcileCloseJournal({
        file: journal,
        trustedIssuers: new Map(),
        now: 2_000,
        stateDirectory: directory,
        async authorizationStateImpl() {
          return { used: false, blockNumber: "10", blockHash: `0x${"12".repeat(32)}`, blockTimestamp: "2" };
        },
      }),
      (error) => error?.code === "lock_ownership_mismatch",
    );
    assert.deepEqual((await readdir(directory)).sort(), [
      `close-${"a".repeat(64)}.lock.json`,
      "journey.json",
    ]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

function recoverableOpenPaymentState({ journal, validBefore = "1", stage, usedResponse = false }) {
  const request = { market: "fixture-open-market", side: "YES", budget: "1.35", maxPrice: "0.27" };
  const buyerWallet = "0x2222222222222222222222222222222222222222";
  const replayKey = openReplayKey({ request, buyerWallet });
  const replayLockPath = join(join(journal, ".."), `open-${replayKey.slice(2)}.lock.json`);
  return {
    state: {
      mode: "open",
      stage,
      journalPath: journal,
      reconciliationRequired: true,
      request,
      paymentPayer: "0x1111111111111111111111111111111111111111",
      buyerWallet,
      paymentTx: null,
      paidCard: null,
      orderId: null,
      settlementTx: null,
      tradeConfirmedAt: null,
      liveResult: null,
      executionArgv: null,
      executionArgvHash: null,
      replayKey,
      replayLockPath,
      executionLockPath: null,
      paidServiceResponse: stage === "payment_authorization_created" || stage === "payment_header_rejected_after_authorization"
        ? null
        : {
            status: stage === "paid_request_rejected_pre_settlement" ? 422 : 200,
            paymentResponsePresent: usedResponse,
          },
      paymentAuthorization: {
        version: "conviction-x402-authorization-v1",
        scheme: "exact-eip3009",
        network: SERVICE_NETWORK,
        asset: SERVICE_ASSET,
        from: "0x1111111111111111111111111111111111111111",
        to: SERVICE_PAYEE,
        value: SERVICE_PRICE_ATOMIC,
        validAfter: "0",
        validBefore,
        nonce: `0x${"cd".repeat(32)}`,
      },
    },
    replayLockPath,
    replayLock: {
      version: "conviction-open-replay-lock-v1",
      replayKey,
      journalPath: journal,
    },
  };
}

function paidResponseFixture({ mode, journal, validBefore = "1" }) {
  if (mode === "open") {
    const fixture = recoverableOpenPaymentState({
      journal,
      validBefore,
      stage: "payment_authorization_created",
    });
    return {
      ...fixture,
      state: { ...fixture.state, journalPath: journal },
      lock: fixture.replayLock,
      service: POSITION_CARD_SERVICE,
      reconcile: (options) => reconcileOpenJournal(options),
    };
  }
  const replayLockPath = join(dirname(journal), `close-${"a".repeat(64)}.lock.json`);
  return {
    state: {
      ...rejectedPaymentState({
        replayLock: replayLockPath,
        validBefore,
        stage: "payment_authorization_created",
      }),
      journalPath: journal,
    },
    replayLockPath,
    lock: JSON.parse(replayLockDocument(journal)),
    service: POSITION_MANAGER_SERVICE,
    reconcile: (options) => reconcileCloseJournal(options),
  };
}

for (const mode of ["open", "close"]) {
  for (const headerCase of ["missing", "malformed"]) {
    test(`${mode.toUpperCase()} durably classifies a successful ${headerCase} PAYMENT-RESPONSE before parsing and safely reconciles`, async () => {
      const directory = await mkdtemp(join(tmpdir(), `conviction-${mode}-${headerCase}-paid-response-`));
      const journal = join(directory, "journey.json");
      const fixture = paidResponseFixture({ mode, journal });
      const header = headerCase === "malformed" ? "not-valid-base64-json" : null;
      const response = new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: header ? { "payment-response": header } : {},
      });
      const json = { ok: true, intentHash: `0x${"d".repeat(64)}` };
      const authorizationBefore = structuredClone(fixture.state.paymentAuthorization);
      const replayKeyBefore = fixture.state.replayKey;
      try {
        await Promise.all([
          writeFile(journal, `${JSON.stringify(fixture.state, null, 2)}\n`),
          writeFile(fixture.replayLockPath, `${JSON.stringify(fixture.lock, null, 2)}\n`),
        ]);
        const lockBefore = await readFile(fixture.replayLockPath, "utf8");
        await assert.rejects(
          persistSuccessfulPaidServiceResponse({
            state: fixture.state,
            response,
            json,
            paymentResponseRaw: response.headers.get("payment-response"),
            writeState: (next) => writeReconciliationJournal(next, {
              directory,
              file: journal,
            }),
          }),
          (error) => error?.code === "invalid_payment_header",
        );

        const durable = JSON.parse(await readFile(journal, "utf8"));
        assert.equal(durable.stage, "paid_request_settlement_ambiguous");
        assert.equal(durable.reconciliationRequired, true);
        assert.deepEqual(durable.paidServiceResponse, {
          status: 200,
          paymentResponsePresent: headerCase === "malformed",
        });
        assert.deepEqual(durable.paymentAuthorization, authorizationBefore);
        assert.equal(durable.replayKey, replayKeyBefore);
        assert.equal(durable.paymentTx, null);
        assert.equal(durable.paidCard, null);
        assert.equal(durable.paymentProof ?? null, null);
        assert.equal("paymentResponseRaw" in durable, false);
        assert.equal(await readFile(fixture.replayLockPath, "utf8"), lockBefore);

        const result = await fixture.reconcile({
          file: journal,
          trustedIssuers: new Map(),
          now: 2_000,
          stateDirectory: directory,
          authorizationStateImpl: async () => ({
            used: false,
            blockNumber: "10",
            blockHash: `0x${"1".repeat(64)}`,
            blockTimestamp: "2",
          }),
        });
        assert.equal(result.status, "expired_unsettled_authorization_reconciled");
        await assert.rejects(access(fixture.replayLockPath), (error) => error?.code === "ENOENT");
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    });
  }

  test(`${mode.toUpperCase()} keeps a valid-looking wrong payment transaction authorization-only when RPC verification fails`, async () => {
    const directory = await mkdtemp(join(tmpdir(), `conviction-${mode}-wrong-payment-tx-`));
    const journal = join(directory, "journey.json");
    const fixture = paidResponseFixture({ mode, journal });
    const claimedTx = `0x${"9".repeat(64)}`;
    const responseHeader = Buffer.from(JSON.stringify({ transaction: claimedTx })).toString("base64");
    const response = new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "payment-response": responseHeader },
    });
    const card = { ok: true, intentHash: `0x${"d".repeat(64)}` };
    try {
      await Promise.all([
        writeFile(journal, `${JSON.stringify(fixture.state, null, 2)}\n`),
        writeFile(fixture.replayLockPath, `${JSON.stringify(fixture.lock, null, 2)}\n`),
      ]);
      const paid = await persistSuccessfulPaidServiceResponse({
        state: fixture.state,
        response,
        json: card,
        paymentResponseRaw: response.headers.get("payment-response"),
        writeState: (next) => writeReconciliationJournal(next, { directory, file: journal }),
      });
      assert.equal(paid.paymentTx, claimedTx);
      assert.equal(paid.card, card);
      await assert.rejects(
        fetchAndVerifyX402Payment({
          paymentTx: paid.paymentTx,
          payer: fixture.state.paymentPayer,
          payee: SERVICE_PAYEE,
          asset: SERVICE_ASSET,
          amountAtomic: fixture.service.priceAtomic,
          earliestAllowedTime: "1970-01-01T00:00:00.000Z",
        }, {
          rpcCall: async () => { throw new Error("simulated unavailable RPC"); },
        }),
        (error) => error?.code === "payment_rpc_error",
      );

      const durable = JSON.parse(await readFile(journal, "utf8"));
      assert.equal(durable.stage, "paid_request_settlement_ambiguous");
      assert.equal(durable.paymentTx, null);
      assert.equal(durable.paidCard, null);
      assert.equal(durable.paymentProof ?? null, null);
      assert.equal(durable.reconciliationRequired, true);

      const result = await fixture.reconcile({
        file: journal,
        trustedIssuers: new Map(),
        now: 2_000,
        stateDirectory: directory,
        authorizationStateImpl: async () => ({ used: true, blockTimestamp: "2" }),
      });
      assert.equal(result.status, "manual_reconciliation_required");
      assert.equal(result.reason, "payment_authorization_consumed_or_ambiguous");
      await access(fixture.replayLockPath);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
}

for (const decodedPaymentResponse of [
  {},
  { transaction: "0x1234" },
]) {
  test("a decoded PAYMENT-RESPONSE without one canonical settlement transaction remains authorization-only", async () => {
    const directory = await mkdtemp(join(tmpdir(), "conviction-decoded-payment-response-"));
    const journal = join(directory, "journey.json");
    const fixture = paidResponseFixture({ mode: "close", journal });
    const response = new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: {
        "payment-response": Buffer.from(JSON.stringify(decodedPaymentResponse)).toString("base64"),
      },
    });
    try {
      await Promise.all([
        writeFile(journal, `${JSON.stringify(fixture.state, null, 2)}\n`),
        writeFile(fixture.replayLockPath, `${JSON.stringify(fixture.lock, null, 2)}\n`),
      ]);
      await assert.rejects(
        persistSuccessfulPaidServiceResponse({
          state: fixture.state,
          response,
          json: { ok: true, intentHash: `0x${"d".repeat(64)}` },
          paymentResponseRaw: response.headers.get("payment-response"),
          writeState: (next) => writeReconciliationJournal(next, { directory, file: journal }),
        }),
        (error) => error?.code === "missing_payment_transaction",
      );
      const durable = JSON.parse(await readFile(journal, "utf8"));
      assert.equal(durable.stage, "paid_request_settlement_ambiguous");
      assert.equal(durable.paymentTx, null);
      assert.equal(durable.paidCard, null);
      assert.equal(durable.paymentProof ?? null, null);
      await access(fixture.replayLockPath);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
}

for (const mismatch of ["transactionHash", "payer", "payee", "asset", "amountAtomic", "checks"]) {
  test(`a ${mismatch} payment-proof mismatch cannot promote merchant output into paid authority`, async () => {
    const directory = await mkdtemp(join(tmpdir(), `conviction-payment-proof-${mismatch}-`));
    const journal = join(directory, "journey.json");
    const fixture = paidResponseFixture({ mode: "close", journal });
    const paymentTx = `0x${"f".repeat(64)}`;
    const response = new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: {
        "payment-response": Buffer.from(JSON.stringify({ transaction: paymentTx })).toString("base64"),
      },
    });
    try {
      await Promise.all([
        writeFile(journal, `${JSON.stringify(fixture.state, null, 2)}\n`),
        writeFile(fixture.replayLockPath, `${JSON.stringify(fixture.lock, null, 2)}\n`),
      ]);
      const writeState = (next) => writeReconciliationJournal(next, { directory, file: journal });
      const paid = await persistSuccessfulPaidServiceResponse({
        state: fixture.state,
        response,
        json: { ok: true, intentHash: `0x${"d".repeat(64)}` },
        paymentResponseRaw: response.headers.get("payment-response"),
        writeState,
      });
      const proof = exactServicePaymentProof({ paymentTx });
      if (mismatch === "transactionHash") proof.transactionHash = `0x${"8".repeat(64)}`;
      if (mismatch === "payer") proof.payer = "0x2222222222222222222222222222222222222222";
      if (mismatch === "payee") proof.payee = "0x2222222222222222222222222222222222222222";
      if (mismatch === "asset") proof.asset = "0x2222222222222222222222222222222222222222";
      if (mismatch === "amountAtomic") proof.amountAtomic = String(BigInt(proof.amountAtomic) + 1n);
      if (mismatch === "checks") proof.checks.exactAmount = false;
      await assert.rejects(
        persistVerifiedPaidServicePayment({
          state: fixture.state,
          paid,
          paymentProof: proof,
          service: POSITION_MANAGER_SERVICE,
          writeState,
        }),
        (error) => error?.code === "payment_proof_mismatch",
      );
      const durable = JSON.parse(await readFile(journal, "utf8"));
      assert.equal(durable.stage, "paid_request_settlement_ambiguous");
      assert.equal(durable.paymentTx, null);
      assert.equal(durable.paidCard, null);
      assert.equal(durable.paymentProof ?? null, null);
      assert.equal(durable.reconciliationRequired, true);
      await access(fixture.replayLockPath);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
}

test("candidate and verified writer failures cannot partially promote live or durable payment state", async () => {
  const directory = await mkdtemp(join(tmpdir(), "conviction-payment-writer-failure-"));
  const journal = join(directory, "journey.json");
  const fixture = paidResponseFixture({ mode: "close", journal });
  const paymentTx = `0x${"f".repeat(64)}`;
  const response = new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: {
      "payment-response": Buffer.from(JSON.stringify({ transaction: paymentTx })).toString("base64"),
    },
  });
  const card = { ok: true, intentHash: `0x${"d".repeat(64)}` };
  try {
    await Promise.all([
      writeFile(journal, `${JSON.stringify(fixture.state, null, 2)}\n`),
      writeFile(fixture.replayLockPath, `${JSON.stringify(fixture.lock, null, 2)}\n`),
    ]);
    const liveBeforeCandidate = structuredClone(fixture.state);
    const durableBeforeCandidate = await readFile(journal, "utf8");
    await assert.rejects(
      persistSuccessfulPaidServiceResponse({
        state: fixture.state,
        response,
        json: card,
        paymentResponseRaw: response.headers.get("payment-response"),
        writeState: async () => {
          throw Object.assign(new Error("simulated candidate writer failure"), { code: "simulated_write_failure" });
        },
      }),
      (error) => error?.code === "simulated_write_failure",
    );
    assert.deepEqual(fixture.state, liveBeforeCandidate);
    assert.equal(await readFile(journal, "utf8"), durableBeforeCandidate);

    const writeState = (next) => writeReconciliationJournal(next, { directory, file: journal });
    const paid = await persistSuccessfulPaidServiceResponse({
      state: fixture.state,
      response,
      json: card,
      paymentResponseRaw: response.headers.get("payment-response"),
      writeState,
    });
    const liveBeforeVerified = structuredClone(fixture.state);
    const durableBeforeVerified = await readFile(journal, "utf8");
    await assert.rejects(
      persistVerifiedPaidServicePayment({
        state: fixture.state,
        paid,
        paymentProof: exactServicePaymentProof({ paymentTx }),
        service: POSITION_MANAGER_SERVICE,
        writeState: async () => {
          throw Object.assign(new Error("simulated verified writer failure"), { code: "simulated_write_failure" });
        },
      }),
      (error) => error?.code === "simulated_write_failure",
    );
    assert.deepEqual(fixture.state, liveBeforeVerified);
    assert.equal(await readFile(journal, "utf8"), durableBeforeVerified);
    assert.equal(fixture.state.stage, "paid_request_settlement_ambiguous");
    assert.equal(fixture.state.paymentTx, null);
    assert.equal(fixture.state.paidCard, null);
    assert.equal(fixture.state.paymentProof ?? null, null);
    await access(fixture.replayLockPath);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("independently verified payment atomically promotes the in-memory card into durable payment authority", async () => {
  const directory = await mkdtemp(join(tmpdir(), "conviction-verified-payment-commit-"));
  const journal = join(directory, "journey.json");
  const fixture = paidResponseFixture({ mode: "close", journal });
  const paymentTx = `0x${"f".repeat(64)}`;
  const response = new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: {
      "payment-response": Buffer.from(JSON.stringify({ transaction: paymentTx })).toString("base64"),
    },
  });
  const card = { ok: true, intentHash: `0x${"d".repeat(64)}` };
  try {
    await Promise.all([
      writeFile(journal, `${JSON.stringify(fixture.state, null, 2)}\n`),
      writeFile(fixture.replayLockPath, `${JSON.stringify(fixture.lock, null, 2)}\n`),
    ]);
    const writeState = (next) => writeReconciliationJournal(next, { directory, file: journal });
    const paid = await persistSuccessfulPaidServiceResponse({
      state: fixture.state,
      response,
      json: card,
      paymentResponseRaw: response.headers.get("payment-response"),
      writeState,
    });
    const proof = exactServicePaymentProof({ paymentTx });
    const result = await persistVerifiedPaidServicePayment({
      state: fixture.state,
      paid,
      paymentProof: proof,
      service: POSITION_MANAGER_SERVICE,
      writeState,
    });
    assert.deepEqual(result, proof);
    const durable = JSON.parse(await readFile(journal, "utf8"));
    assert.equal(durable.stage, "payment_verified");
    assert.equal(durable.reconciliationRequired, true);
    assert.equal(durable.paymentTx, paymentTx);
    assert.deepEqual(durable.paidCard, card);
    assert.deepEqual(durable.paymentProof, proof);
    assert.match(durable.paymentClaimPath, /payment-[0-9a-f]{64}\.lock\.json$/);
    assert.match(durable.paymentClaimHash, /^0x[0-9a-f]{64}$/);
    assert.equal((await stat(durable.paymentClaimPath)).mode & 0o777, 0o600);
    assert.deepEqual(durable.paidServiceResponse, { status: 200, paymentResponsePresent: true });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("one verified X Layer payment transaction can promote only one paid journey", async () => {
  const directory = await mkdtemp(join(tmpdir(), "conviction-payment-transaction-replay-"));
  const paymentTx = `0x${"f".repeat(64)}`;
  const response = new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: {
      "payment-response": Buffer.from(JSON.stringify({ transaction: paymentTx })).toString("base64"),
    },
  });
  const proof = exactServicePaymentProof({ paymentTx });
  const firstJournal = join(directory, "first.json");
  const secondJournal = join(directory, "second.json");
  const first = paidResponseFixture({ mode: "close", journal: firstJournal });
  const second = paidResponseFixture({ mode: "close", journal: secondJournal });
  try {
    await Promise.all([
      writeFile(firstJournal, `${JSON.stringify(first.state, null, 2)}\n`),
      writeFile(secondJournal, `${JSON.stringify(second.state, null, 2)}\n`),
    ]);
    const paidFirst = await persistSuccessfulPaidServiceResponse({
      state: first.state,
      response,
      json: { ok: true, intentHash: `0x${"d".repeat(64)}` },
      paymentResponseRaw: response.headers.get("payment-response"),
      writeState: (next) => writeReconciliationJournal(next, { directory, file: firstJournal }),
    });
    const paidSecond = await persistSuccessfulPaidServiceResponse({
      state: second.state,
      response,
      json: { ok: true, intentHash: `0x${"e".repeat(64)}` },
      paymentResponseRaw: response.headers.get("payment-response"),
      writeState: (next) => writeReconciliationJournal(next, { directory, file: secondJournal }),
    });
    await persistVerifiedPaidServicePayment({
      state: first.state,
      paid: paidFirst,
      paymentProof: proof,
      service: POSITION_MANAGER_SERVICE,
      writeState: (next) => writeReconciliationJournal(next, { directory, file: firstJournal }),
    });
    await assert.rejects(
      persistVerifiedPaidServicePayment({
        state: second.state,
        paid: paidSecond,
        paymentProof: proof,
        service: POSITION_MANAGER_SERVICE,
        writeState: (next) => writeReconciliationJournal(next, { directory, file: secondJournal }),
      }),
      (error) => error?.code === "payment_transaction_replayed",
    );
    const [durableFirst, durableSecond] = await Promise.all([
      readFile(firstJournal, "utf8").then(JSON.parse),
      readFile(secondJournal, "utf8").then(JSON.parse),
    ]);
    assert.equal(durableFirst.stage, "payment_verified");
    assert.equal(durableFirst.paymentTx, paymentTx);
    assert.equal(durableSecond.stage, "paid_request_settlement_ambiguous");
    assert.equal(durableSecond.paymentTx, null);
    assert.equal(durableSecond.paidCard, null);
    assert.equal(durableSecond.paymentProof ?? null, null);
    const claim = JSON.parse(await readFile(durableFirst.paymentClaimPath, "utf8"));
    assert.equal(claim.transactionHash, paymentTx);
    assert.equal(claim.journalPath, await realpath(firstJournal));
    assert.equal(claim.replayKey, first.state.replayKey);
    assert.equal(claim.authorizationNonce, first.state.paymentAuthorization.nonce);
    assert.equal(claim.paymentProofHash, sha256(proof));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a post-publication journal failure retains the global payment claim and blocks replay", async () => {
  const directory = await mkdtemp(join(tmpdir(), "conviction-payment-post-publish-failure-"));
  const paymentTx = `0x${"f".repeat(64)}`;
  const response = new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { "payment-response": Buffer.from(JSON.stringify({ transaction: paymentTx })).toString("base64") },
  });
  const proof = exactServicePaymentProof({ paymentTx });
  const firstJournal = join(directory, "first.json");
  const secondJournal = join(directory, "second.json");
  const first = paidResponseFixture({ mode: "close", journal: firstJournal });
  const second = paidResponseFixture({ mode: "close", journal: secondJournal });
  try {
    await Promise.all([
      writeFile(firstJournal, `${JSON.stringify(first.state, null, 2)}\n`),
      writeFile(secondJournal, `${JSON.stringify(second.state, null, 2)}\n`),
    ]);
    const paidFirst = await persistSuccessfulPaidServiceResponse({
      state: first.state,
      response,
      json: { ok: true, intentHash: `0x${"d".repeat(64)}` },
      paymentResponseRaw: response.headers.get("payment-response"),
      writeState: (next) => writeReconciliationJournal(next, { directory, file: firstJournal }),
    });
    const paidSecond = await persistSuccessfulPaidServiceResponse({
      state: second.state,
      response,
      json: { ok: true, intentHash: `0x${"e".repeat(64)}` },
      paymentResponseRaw: response.headers.get("payment-response"),
      writeState: (next) => writeReconciliationJournal(next, { directory, file: secondJournal }),
    });
    await assert.rejects(
      persistVerifiedPaidServicePayment({
        state: first.state,
        paid: paidFirst,
        paymentProof: proof,
        service: POSITION_MANAGER_SERVICE,
        writeState: async (next) => {
          await writeReconciliationJournal(next, { directory, file: firstJournal });
          throw Object.assign(new Error("simulated post-publication crash"), { code: "simulated_post_publish_crash" });
        },
      }),
      (error) => error?.code === "simulated_post_publish_crash" && error?.paymentClaimRetained === true,
    );
    const durableFirst = JSON.parse(await readFile(firstJournal, "utf8"));
    assert.equal(durableFirst.stage, "payment_verified");
    await access(durableFirst.paymentClaimPath);
    await assert.rejects(
      persistVerifiedPaidServicePayment({
        state: second.state,
        paid: paidSecond,
        paymentProof: proof,
        service: POSITION_MANAGER_SERVICE,
        writeState: (next) => writeReconciliationJournal(next, { directory, file: secondJournal }),
      }),
      (error) => error?.code === "payment_transaction_replayed",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("paid authority requires the exact owner-only payment claim at every later use", async () => {
  const directory = await mkdtemp(join(tmpdir(), "conviction-payment-claim-integrity-"));
  const journal = join(directory, "journey.json");
  const fixture = paidResponseFixture({ mode: "close", journal });
  const paymentTx = `0x${"f".repeat(64)}`;
  const response = new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { "payment-response": Buffer.from(JSON.stringify({ transaction: paymentTx })).toString("base64") },
  });
  try {
    await writeFile(journal, `${JSON.stringify(fixture.state, null, 2)}\n`);
    const paid = await persistSuccessfulPaidServiceResponse({
      state: fixture.state,
      response,
      json: { ok: true, intentHash: `0x${"d".repeat(64)}` },
      paymentResponseRaw: response.headers.get("payment-response"),
      writeState: (next) => writeReconciliationJournal(next, { directory, file: journal }),
    });
    await persistVerifiedPaidServicePayment({
      state: fixture.state,
      paid,
      paymentProof: exactServicePaymentProof({ paymentTx }),
      service: POSITION_MANAGER_SERVICE,
      writeState: (next) => writeReconciliationJournal(next, { directory, file: journal }),
    });
    const claimPath = fixture.state.paymentClaimPath;
    const exactClaim = await readFile(claimPath, "utf8");
    await verifyStoredPaymentTransactionClaim({ state: fixture.state, service: POSITION_MANAGER_SERVICE, stateDirectory: directory });

    await writeFile(claimPath, `${exactClaim.trim()}  \n`);
    await assert.rejects(
      verifyStoredPaymentTransactionClaim({ state: fixture.state, service: POSITION_MANAGER_SERVICE, stateDirectory: directory }),
      (error) => error?.code === "payment_claim_missing_or_mismatched",
    );
    await writeFile(claimPath, exactClaim);
    await chmod(claimPath, 0o644);
    await assert.rejects(
      verifyStoredPaymentTransactionClaim({ state: fixture.state, service: POSITION_MANAGER_SERVICE, stateDirectory: directory }),
      (error) => error?.code === "payment_claim_missing_or_mismatched",
    );
    await chmod(claimPath, 0o600);
    await unlink(claimPath);
    await assert.rejects(
      verifyStoredPaymentTransactionClaim({ state: fixture.state, service: POSITION_MANAGER_SERVICE, stateDirectory: directory }),
      (error) => error?.code === "payment_claim_missing_or_mismatched",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

for (const mode of ["open", "close"]) {
  test(`${mode.toUpperCase()} claimless paid reconciliation stays manual and retains its replay lock`, async () => {
    const directory = await mkdtemp(join(tmpdir(), `conviction-${mode}-claimless-paid-`));
    const journal = join(directory, "journey.json");
    const fixture = paidResponseFixture({ mode, journal });
    const paymentTx = `0x${"f".repeat(64)}`;
    const response = new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "payment-response": Buffer.from(JSON.stringify({ transaction: paymentTx })).toString("base64") },
    });
    try {
      await Promise.all([
        writeFile(journal, `${JSON.stringify(fixture.state, null, 2)}\n`),
        writeFile(fixture.replayLockPath, `${JSON.stringify(fixture.lock, null, 2)}\n`),
      ]);
      const paid = await persistSuccessfulPaidServiceResponse({
        state: fixture.state,
        response,
        json: { ok: true, intentHash: `0x${"d".repeat(64)}` },
        paymentResponseRaw: response.headers.get("payment-response"),
        writeState: (next) => writeReconciliationJournal(next, { directory, file: journal }),
      });
      await persistVerifiedPaidServicePayment({
        state: fixture.state,
        paid,
        paymentProof: exactServicePaymentProof({ paymentTx, amountAtomic: fixture.service.priceAtomic }),
        service: fixture.service,
        writeState: (next) => writeReconciliationJournal(next, { directory, file: journal }),
      });
      await unlink(fixture.state.paymentClaimPath);
      fixture.state.paymentClaimPath = null;
      fixture.state.paymentClaimHash = null;
      await writeReconciliationJournal(fixture.state, { directory, file: journal });
      const result = await fixture.reconcile({
        file: journal,
        trustedIssuers: new Map(),
        stateDirectory: directory,
        validateCardImpl: () => assert.fail("claimless paid card must never be trusted"),
      });
      assert.equal(result.status, "manual_reconciliation_required");
      assert.equal(result.reason, "payment_verification_missing_or_mismatched");
      await access(fixture.replayLockPath);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
}

test("OPEN keeps every ambiguous EIP-3009 payment reserved until finalized expiry proves it unused", async () => {
  for (const stage of [
    "payment_authorization_created",
    "payment_header_rejected_after_authorization",
    "paid_request_rejected_pre_settlement",
    "paid_request_settlement_ambiguous",
  ]) {
    const directory = await mkdtemp(join(tmpdir(), `conviction-open-${stage}-`));
    const journal = join(directory, "journey.json");
    const fixture = recoverableOpenPaymentState({ journal, stage });
    try {
      await Promise.all([
        writeFile(journal, `${JSON.stringify(fixture.state, null, 2)}\n`),
        writeFile(fixture.replayLockPath, `${JSON.stringify(fixture.replayLock, null, 2)}\n`),
      ]);
      let reads = 0;
      const waiting = await reconcileOpenJournal({
        file: journal,
        trustedIssuers: new Map(),
        now: 999,
        stateDirectory: directory,
        authorizationStateImpl: async () => { reads += 1; return { used: false, blockTimestamp: "2" }; },
      });
      assert.equal(waiting.status, "waiting_for_authorization_expiry");
      assert.equal(reads, 0);
      await access(fixture.replayLockPath);

      const result = await reconcileOpenJournal({
        file: journal,
        trustedIssuers: new Map(),
        now: 2_000,
        stateDirectory: directory,
        authorizationStateImpl: async () => {
          reads += 1;
          return { used: false, blockTimestamp: "2", blockNumber: "10", blockHash: `0x${"12".repeat(32)}` };
        },
      });
      assert.equal(result.status, "expired_unsettled_authorization_reconciled");
      assert.equal(result.reconciliationRequired, false);
      assert.equal(reads, 1);
      await assert.rejects(access(fixture.replayLockPath), (error) => error?.code === "ENOENT");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
});

test("OPEN never releases an ambiguous payment reservation when its authorization was consumed", async () => {
  const directory = await mkdtemp(join(tmpdir(), "conviction-open-consumed-auth-"));
  const journal = join(directory, "journey.json");
  const fixture = recoverableOpenPaymentState({ journal, stage: "paid_request_settlement_ambiguous", usedResponse: true });
  try {
    await Promise.all([
      writeFile(journal, `${JSON.stringify(fixture.state, null, 2)}\n`),
      writeFile(fixture.replayLockPath, `${JSON.stringify(fixture.replayLock, null, 2)}\n`),
    ]);
    const result = await reconcileOpenJournal({
      file: journal,
      trustedIssuers: new Map(),
      now: 2_000,
      stateDirectory: directory,
      authorizationStateImpl: async () => ({ used: true, blockTimestamp: "2" }),
    });
    assert.equal(result.status, "manual_reconciliation_required");
    assert.equal(result.reason, "payment_authorization_consumed_or_ambiguous");
    await access(fixture.replayLockPath);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
