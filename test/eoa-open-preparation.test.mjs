import assert from "node:assert/strict";
import test from "node:test";

import { CONTRACTS } from "../src/constants.mjs";
import {
  EOA_OPEN_PREPARATION_VERSION,
  finiteEoaOpenPreparation,
  finiteEoaOpenPreparationMatches,
} from "../src/eoa-open-preparation.mjs";

const WALLET = "0x1111111111111111111111111111111111111111";

function intent() {
  const market = {
    collateral: CONTRACTS.pUsd,
    exchange: CONTRACTS.standardExchangeV2,
    negRisk: false,
  };
  const order = {
    side: "BUY",
    orderType: "FAK",
    maximumOrderPrincipalRaw: "2950000",
    maximumTotalDebitRaw: "3245000",
  };
  return {
    buyer: { wallet: WALLET },
    market,
    order,
    walletPreparation: finiteEoaOpenPreparation({ wallet: WALLET, market, order }),
  };
}

test("builds a signed finite pUSD approval and zero-allowance cleanup", () => {
  const value = intent().walletPreparation;
  assert.equal(value.version, EOA_OPEN_PREPARATION_VERSION);
  assert.equal(value.scope, "standard-v2-pusd-fak-buy-only");
  assert.equal(value.owner, WALLET);
  assert.equal(value.collateralToken, CONTRACTS.pUsd);
  assert.equal(value.spender, CONTRACTS.standardExchangeV2);
  assert.equal(value.approval.amount, "3.245");
  assert.equal(value.approval.amountRaw, "3245000");
  assert.equal(value.approval.minimumRequiredRaw, "2950000");
  assert.match(value.approval.calldata, /^0x095ea7b3[0-9a-f]{128}$/);
  assert.equal(value.approval.unlimitedApprovalForbidden, true);
  assert.equal(value.approval.setApprovalForAllForbidden, true);
  assert.deepEqual(value.execution.appendArgv, ["--mode", "eoa"]);
  assert.deepEqual(value.execution.forbiddenArgv, ["--approve"]);
  assert.match(value.allowanceReadback.data, /^0xdd62ed3e[0-9a-f]{128}$/);
  assert.equal(value.allowanceReadback.minimumRaw, "2950000");
  assert.equal(value.allowanceReadback.maximumRaw, "3245000");
  assert.match(value.cleanup.calldata, /^0x095ea7b3[0-9a-f]{128}$/);
  assert.equal(value.cleanup.calldata.endsWith("0".repeat(64)), true);
  assert.equal(finiteEoaOpenPreparationMatches(intent()), true);
});

test("rejects substituted spender, amount, mode, or blanket authority", () => {
  for (const mutate of [
    (value) => { value.spender = "0x2222222222222222222222222222222222222222"; },
    (value) => { value.approval.amountRaw = "340282366920938463463374607431768211455"; },
    (value) => { value.execution.appendArgv = ["--mode", "proxy"]; },
    (value) => { value.approval.setApprovalForAllForbidden = false; },
  ]) {
    const value = structuredClone(intent());
    mutate(value.walletPreparation);
    assert.equal(finiteEoaOpenPreparationMatches(value), false);
  }
});

test("fails closed outside a standard non-neg-risk V2 FAK BUY", () => {
  const base = intent();
  assert.throws(
    () => finiteEoaOpenPreparation({
      wallet: WALLET,
      market: { ...base.market, negRisk: true },
      order: base.order,
    }),
    (error) => error.code === "invalid_eoa_preparation",
  );
  assert.throws(
    () => finiteEoaOpenPreparation({
      wallet: WALLET,
      market: base.market,
      order: { ...base.order, maximumTotalDebitRaw: "2949999" },
    }),
    (error) => error.code === "invalid_eoa_preparation",
  );
});
