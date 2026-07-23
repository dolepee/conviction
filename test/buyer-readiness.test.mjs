import assert from "node:assert/strict";
import test from "node:test";

import handler from "../api/readiness.js";
import {
  buyerReadinessContract,
  classifyBuyerReadiness,
} from "../src/buyer-readiness.mjs";
import { SERVICE_PAYEE } from "../src/service-payment.mjs";

const PAYER = "0x1111111111111111111111111111111111111111";
const EOA = "0x2222222222222222222222222222222222222222";
const DEPOSIT = "0x3333333333333333333333333333333333333333";

function ready(overrides = {}) {
  return {
    capabilities: {
      walletTools: true,
      x402Payment: true,
      polymarketTrading: true,
    },
    xLayer: { payer: PAYER, usdt0: "0.05" },
    polygon: {
      eoa: EOA,
      depositWallet: DEPOSIT,
      tradingMode: "deposit-wallet",
      pUsd: "1.25",
      approvalsReady: true,
    },
    venue: { accessible: true, clobVersion: "V2" },
    requestedOpenBudget: "1.25",
    ...overrides,
  };
}

function response() {
  return {
    headers: {},
    statusCode: null,
    body: null,
    setHeader(name, value) { this.headers[name.toLowerCase()] = value; return this; },
    status(value) { this.statusCode = value; return this; },
    json(value) { this.body = value; return this; },
    end(value) { this.body = JSON.parse(value); return this; },
  };
}

test("buyer readiness contract exposes the free classifier and approval disclosure", () => {
  const contract = buyerReadinessContract();
  assert.equal(contract.method, "POST");
  assert.equal(contract.readOnly, true);
  assert.equal(contract.approvalDisclosure.setupRelayerPaid, true);
  assert.equal(contract.approvalDisclosure.polygonGasRequired, false);
  assert.equal(contract.approvalDisclosure.pUsdAllowances, 2);
  assert.equal(contract.approvalDisclosure.pUsdAllowanceAmount, "maximum");
  assert.equal(contract.approvalDisclosure.ctfOperatorApprovals, 3);
  assert.equal(contract.approvalDisclosure.ctfOperatorApprovalScope, "blanket");
  assert.equal(contract.approvalDisclosure.revokeCommandAvailable, false);
  assert.equal(contract.approvalDisclosure.convictionCanBypassWalletPolicy, false);
});

test("ready buyer advances to the free preview", () => {
  const result = classifyBuyerReadiness(ready());
  assert.equal(result.ok, true);
  assert.equal(result.status, "READY_FOR_CONVICTION");
  assert.equal(result.nextAction, "RUN_FREE_PREVIEW_AND_PLUGIN_DRY_RUN");
  assert.equal(result.paymentAllowed, true);
  assert.equal(result.service.priceAtomic, "50000");
  assert.equal(result.service.payee, SERVICE_PAYEE);
  assert.equal(result.requirements.polygonPusdRaw, "1250000");
  assert.equal(result.observed.polygonPusd, "1.25");
  assert.equal(result.funding.polygon.destination, "buyer.depositWallet");
  assert.equal(result.funding.polygon.doNotFund, "buyer.polygonEoa");
  assert.equal(result.funding.polygon.polGasRequiredInDepositWalletMode, false);
  assert.equal(result.approvalDisclosure.pUsdAllowanceAmount, "maximum");
  assert.deepEqual(result.remainingActions, []);
});

test("unsupported is reserved for genuinely missing runtime capabilities", () => {
  const result = classifyBuyerReadiness(ready({
    capabilities: {
      walletTools: true,
      x402Payment: false,
      polymarketTrading: true,
    },
  }));
  assert.equal(result.status, "UNSUPPORTED_EXECUTION_RUNTIME");
  assert.deepEqual(result.missing, ["capabilities.x402Payment"]);
  assert.equal(result.paymentAllowed, false);
  assert.equal(result.service, undefined);
  assert.equal(result.funding, undefined);
  assert.equal(result.recoverable, false);
  assert.equal(result.canResumeWithReadyDepositWallet, undefined);
  assert.equal(result.stopReason, undefined);
});

test("ordinary Polygon-identity blockers omit venue-wallet stop metadata", () => {
  const result = classifyBuyerReadiness(ready({
    polygon: {
      eoa: null,
      depositWallet: DEPOSIT,
      tradingMode: "deposit-wallet",
      pUsd: "1.25",
      approvalsReady: true,
    },
  }));
  assert.equal(result.status, "BUYER_SETUP_REQUIRED");
  assert.equal(result.nextAction, "CONNECT_POLYGON_WALLET");
  assert.equal(result.paymentAllowed, false);
  assert.equal(result.canResumeWithReadyDepositWallet, undefined);
  assert.equal(result.stopReason, undefined);
});

test("treasury payer is rejected before any setup or payment", () => {
  const result = classifyBuyerReadiness(ready({
    xLayer: { payer: SERVICE_PAYEE.toUpperCase(), usdt0: "100" },
  }));
  assert.equal(result.status, "SELF_PAYMENT_FORBIDDEN");
  assert.equal(result.nextAction, "SWITCH_TO_DISTINCT_BUYER_ACCOUNT");
  assert.equal(result.paymentAllowed, false);
  assert.equal(result.service, undefined);
  assert.equal(result.funding, undefined);
});

test("missing X Layer payer cannot receive funding or payment guidance", () => {
  const result = classifyBuyerReadiness(ready({
    xLayer: { payer: null, usdt0: "0" },
  }));
  assert.equal(result.status, "BUYER_SETUP_REQUIRED");
  assert.equal(result.nextAction, "CONNECT_X_LAYER_PAYER");
  assert.equal(result.paymentAllowed, false);
  assert.equal(result.service, undefined);
  assert.equal(result.funding, undefined);
  assert.equal(result.recoverable, false);
  assert.equal(result.canResumeWithReadyDepositWallet, undefined);
  assert.equal(result.stopReason, undefined);
});

test("missing deposit wallet is a no-payment stop, not an in-session setup loop", () => {
  const result = classifyBuyerReadiness(ready({
    polygon: {
      eoa: EOA,
      depositWallet: null,
      tradingMode: null,
      pUsd: "0",
      approvalsReady: false,
    },
  }));
  assert.equal(result.status, "BUYER_SETUP_REQUIRED");
  assert.equal(result.nextAction, "USE_READY_DEPOSIT_WALLET_OR_STOP");
  assert.equal(result.paymentAllowed, false);
  assert.equal(result.recoverable, false);
  assert.equal(result.canResumeWithReadyDepositWallet, true);
  assert.equal(result.service, undefined);
  assert.equal(result.funding, undefined);
  assert.deepEqual(result.remainingActions, ["USE_READY_DEPOSIT_WALLET_OR_STOP"]);
  assert.doesNotMatch(JSON.stringify(result), /SETUP_DEPOSIT_WALLET|COMPLETE_POLYMARKET_V2_SETUP|FUND_/);
});

test("fresh EOA is routed away before payment after the live V2 maker rejection", () => {
  const result = classifyBuyerReadiness(ready({
    polygon: {
      eoa: EOA,
      depositWallet: null,
      tradingMode: "eoa",
      pUsd: "3.60",
      pol: "0.05",
      approvalsReady: false,
    },
    requestedOpenBudget: "3.575",
  }));
  assert.equal(result.ok, false);
  assert.equal(result.status, "BUYER_SETUP_REQUIRED");
  assert.equal(result.nextAction, "USE_READY_DEPOSIT_WALLET_OR_STOP");
  assert.equal(result.paymentAllowed, false);
  assert.equal(result.recoverable, false);
  assert.equal(result.buyer.depositWallet, null);
  assert.equal(result.service, undefined);
  assert.equal(result.funding, undefined);
  assert.equal(result.approvalDisclosure.finiteEoaOpen.supported, false);
  assert.equal(result.approvalDisclosure.finiteEoaOpen.status, "disabled-after-live-maker-rejection");
  assert.deepEqual(result.remainingActions, ["USE_READY_DEPOSIT_WALLET_OR_STOP"]);
});

test("finite EOA funding no longer makes an unsupported maker chargeable", () => {
  const noGas = classifyBuyerReadiness(ready({
    polygon: {
      eoa: EOA,
      depositWallet: null,
      tradingMode: "eoa",
      pUsd: "3.60",
      pol: "0.009999",
      approvalsReady: false,
    },
    requestedOpenBudget: "3.575",
  }));
  assert.equal(noGas.nextAction, "USE_READY_DEPOSIT_WALLET_OR_STOP");
  assert.equal(noGas.paymentAllowed, false);
  assert.equal(noGas.funding, undefined);

  const noPusd = classifyBuyerReadiness(ready({
    polygon: {
      eoa: EOA,
      depositWallet: null,
      tradingMode: "eoa",
      pUsd: "3.574999",
      pol: "0.05",
      approvalsReady: false,
    },
    requestedOpenBudget: "3.575",
  }));
  assert.equal(noPusd.nextAction, "USE_READY_DEPOSIT_WALLET_OR_STOP");
  assert.equal(noPusd.paymentAllowed, false);
  assert.equal(noPusd.funding, undefined);
});

test("readiness returns one actionable blocker in deterministic order", () => {
  const setup = classifyBuyerReadiness(ready({
    xLayer: { payer: PAYER, usdt0: "0" },
    polygon: {
      eoa: EOA,
      depositWallet: DEPOSIT,
      tradingMode: "deposit-wallet",
      pUsd: "0",
      approvalsReady: true,
    },
  }));
  assert.equal(setup.nextAction, "FUND_X_LAYER_USDT0");
  assert.equal(setup.paymentAllowed, false);
  assert.equal(setup.recoverable, true);
  assert.equal(setup.service, undefined);
  assert.equal(setup.funding.polygon.destination, "buyer.depositWallet");
  assert.deepEqual(setup.remainingActions, ["FUND_X_LAYER_USDT0"]);

  const polygon = classifyBuyerReadiness(ready({
    polygon: {
      eoa: EOA,
      depositWallet: DEPOSIT,
      tradingMode: "deposit-wallet",
      pUsd: "1.249999",
      approvalsReady: true,
    },
  }));
  assert.equal(polygon.nextAction, "FUND_POLYGON_DEPOSIT_WALLET_PUSD");
  assert.equal(polygon.paymentAllowed, false);
  assert.equal(polygon.recoverable, true);
});

test("region states stop or request the official check", () => {
  assert.equal(
    classifyBuyerReadiness(ready({ venue: { accessible: false, clobVersion: "V2" } })).status,
    "REGION_RESTRICTED",
  );
  const unchecked = classifyBuyerReadiness(ready({
    venue: { accessible: null, clobVersion: "V2" },
  }));
  assert.equal(unchecked.status, "REGION_CHECK_REQUIRED");
  assert.equal(unchecked.nextAction, "RUN_POLYMARKET_CHECK_ACCESS");
  assert.equal(unchecked.paymentAllowed, false);
  assert.equal(unchecked.service, undefined);
  assert.equal(unchecked.funding, undefined);
  assert.equal(unchecked.remainingActions.includes("RUN_POLYMARKET_CHECK_ACCESS"), true);

  const stringAccess = classifyBuyerReadiness(ready({
    venue: { accessible: "true", clobVersion: "V2" },
  }));
  assert.equal(stringAccess.status, "REGION_CHECK_REQUIRED");
  assert.equal(stringAccess.nextAction, "RUN_POLYMARKET_CHECK_ACCESS");
  assert.equal(stringAccess.remainingActions.includes("RUN_POLYMARKET_CHECK_ACCESS"), true);
});

test("readiness API serves its contract and classifies without payment", async () => {
  const get = response();
  await handler({ method: "GET" }, get);
  assert.equal(get.statusCode, 200);
  assert.equal(get.body.contract.readOnly, true);

  const post = response();
  await handler({ method: "POST", body: ready(), headers: {} }, post);
  assert.equal(post.statusCode, 200);
  assert.equal(post.body.status, "READY_FOR_CONVICTION");

  const put = response();
  await handler({ method: "PUT" }, put);
  assert.equal(put.statusCode, 405);
  assert.equal(put.headers.allow, "GET, HEAD, POST");
});
