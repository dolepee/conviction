import assert from "node:assert/strict";
import test from "node:test";

import {
  parseArgs,
  parseJsonOutput,
  paymentTransaction,
  normalizePluginReadiness,
  validatePaymentChallenge,
} from "../scripts/buyer-orchestrator.mjs";
import {
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

test("buyer CLI accepts the release contract without pre-authorizing payment", () => {
  const parsed = parseArgs(BASE);
  assert.equal(parsed.side, "YES");
  assert.equal(parsed.json, true);
  assert.equal("confirmPayment" in parsed, false);
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
