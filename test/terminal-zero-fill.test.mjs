import assert from "node:assert/strict";
import test from "node:test";

import { verifyTerminalZeroFillOrder } from "../src/terminal-zero-fill.mjs";

const NOW = Date.parse("2026-07-22T02:00:10.000Z");
const SIGNER = "0x1111111111111111111111111111111111111111";
const WALLET = "0x2222222222222222222222222222222222222222";
const CONDITION = `0x${"33".repeat(32)}`;
const INTENT = `0x${"44".repeat(32)}`;
const ORDER = `0x${"55".repeat(32)}`;
const TOKEN = "123456789";

function live(action = "OPEN") {
  return {
    ok: true,
    orderId: ORDER,
    status: "unmatched",
    reportedSharesRaw: action === "OPEN" ? "8000000" : "5000000",
    validated: {
      intentHash: INTENT,
      intent: {
        market: { conditionId: CONDITION },
        snapshot: { capturedAt: "2026-07-22T02:00:00.000Z" },
      },
      outcome: "YES",
      tokenId: TOKEN,
      wallet: WALLET,
      bounds: action === "OPEN"
        ? { maxPrice: "0.140000", fullFillSharesRaw: "8000000" }
        : { minPrice: "0.260000", sharesRaw: "5000000" },
    },
    result: { order_id: ORDER, status: "unmatched", tx_hashes: [] },
  };
}

function snapshot(action = "OPEN") {
  return {
    version: "conviction-polymarket-order-snapshot-v1",
    verificationSource: "authenticated-polymarket-clob",
    onChain: false,
    fetchedAt: new Date(NOW - 1_000).toISOString(),
    signerAddress: SIGNER,
    depositWallet: WALLET,
    credentialOwnerVerified: true,
    order: {
      id: ORDER,
      status: "CANCELED",
      market: CONDITION,
      assetId: TOKEN,
      side: action === "OPEN" ? "BUY" : "SELL",
      originalSize: action === "OPEN" ? "8000000" : "5000000",
      sizeMatched: "0",
      price: action === "OPEN" ? "0.14" : "0.26",
      orderType: action === "OPEN" ? "FAK" : "FOK",
      expiration: "0",
      outcome: "YES",
      createdAt: "1784685609",
      associatedTrades: [],
    },
  };
}

for (const action of ["OPEN", "CLOSE"]) {
  test(`proves an owner-bound terminal zero-fill ${action} from exact authenticated CLOB evidence`, () => {
    const result = verifyTerminalZeroFillOrder({
      action,
      signerAddress: SIGNER,
      wallet: WALLET,
      live: live(action),
      snapshot: snapshot(action),
      confirmedAt: "2026-07-22T02:00:08.000Z",
      expiresAt: "2026-07-22T02:05:00.000Z",
      now: NOW,
    });
    assert.equal(result.ok, true);
    assert.equal(result.proof.action, action);
    assert.equal(result.proof.matchedSharesRaw, "0");
    assert.equal(result.proof.checks.zeroAssociatedTrades, true);
    assert.match(result.proofHash, /^0x[0-9a-f]{64}$/);
  });
}

test("terminal zero-fill proof rejects active, filled, substituted, stale, or resting evidence", () => {
  const mutations = [
    (value) => { value.order.status = "LIVE"; },
    (value) => { value.order.sizeMatched = "1"; },
    (value) => { value.order.associatedTrades = ["trade-1"]; },
    (value) => { value.order.assetId = "987"; },
    (value) => { value.order.market = `0x${"66".repeat(32)}`; },
    (value) => { value.order.orderType = "GTC"; },
    (value) => { value.order.price = "0.15"; },
    (value) => { value.order.originalSize = "7000000"; },
    (value) => { value.depositWallet = "0x9999999999999999999999999999999999999999"; },
    (value) => { value.fetchedAt = new Date(NOW - 20_000).toISOString(); },
  ];
  for (const mutate of mutations) {
    const invalid = structuredClone(snapshot("OPEN"));
    mutate(invalid);
    assert.throws(() => verifyTerminalZeroFillOrder({
      action: "OPEN",
      signerAddress: SIGNER,
      wallet: WALLET,
      live: live("OPEN"),
      snapshot: invalid,
      confirmedAt: "2026-07-22T02:00:08.000Z",
      expiresAt: "2026-07-22T02:05:00.000Z",
      now: NOW,
    }));
  }
});

test("terminal OPEN zero-fill proof binds original size to the signed card, not a smaller plugin report", () => {
  const substitutedLive = live("OPEN");
  substitutedLive.reportedSharesRaw = "7000000";
  const substitutedSnapshot = snapshot("OPEN");
  substitutedSnapshot.order.originalSize = "7000000";
  assert.throws(() => verifyTerminalZeroFillOrder({
    action: "OPEN",
    signerAddress: SIGNER,
    wallet: WALLET,
    live: substitutedLive,
    snapshot: substitutedSnapshot,
    confirmedAt: "2026-07-22T02:00:08.000Z",
    expiresAt: "2026-07-22T02:05:00.000Z",
    now: NOW,
  }), (error) => error?.code === "order_size_mismatch");
});

test("terminal zero-fill proof rejects an older identical order and a post-expiry order", () => {
  for (const createdAt of [
    String(Date.parse("2026-07-22T02:00:08.000Z") / 1_000),
    String(Date.parse("2026-07-22T02:05:01.000Z") / 1_000),
  ]) {
    const invalid = structuredClone(snapshot("OPEN"));
    invalid.order.createdAt = createdAt;
    assert.throws(() => verifyTerminalZeroFillOrder({
      action: "OPEN",
      signerAddress: SIGNER,
      wallet: WALLET,
      live: live("OPEN"),
      snapshot: invalid,
      confirmedAt: "2026-07-22T02:00:08.000Z",
      expiresAt: "2026-07-22T02:05:00.000Z",
      now: NOW,
    }), (error) => ["order_before_confirmation", "order_outside_signed_window"].includes(error?.code));
  }
});
