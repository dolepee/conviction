import { sha256 } from "./canonical.mjs";
import { CONTRACTS, POLYGON_CHAIN_ID } from "./constants.mjs";
import { formatDecimal } from "./decimal.mjs";
import { invariant } from "./errors.mjs";

export const EOA_OPEN_PREPARATION_VERSION = "conviction-eoa-open-preparation-v1";

const ADDRESS_RE = /^0x[0-9a-f]{40}$/i;
const UINT_RE = /^\d+$/;
const APPROVE_SELECTOR = "095ea7b3";
const ALLOWANCE_SELECTOR = "dd62ed3e";

function addressWord(value, label) {
  const normalized = String(value || "").toLowerCase();
  invariant(ADDRESS_RE.test(normalized), "invalid_eoa_preparation", `${label} is invalid`);
  return normalized.slice(2).padStart(64, "0");
}

function uintWord(value, label) {
  const raw = String(value ?? "");
  invariant(UINT_RE.test(raw), "invalid_eoa_preparation", `${label} is invalid`);
  const parsed = BigInt(raw);
  invariant(parsed >= 0n && parsed < (1n << 256n), "invalid_eoa_preparation", `${label} is out of range`);
  return parsed.toString(16).padStart(64, "0");
}

function approveCalldata(spender, amountRaw) {
  return `0x${APPROVE_SELECTOR}${addressWord(spender, "approval spender")}${uintWord(amountRaw, "approval amount")}`;
}

function allowanceCalldata(owner, spender) {
  return `0x${ALLOWANCE_SELECTOR}${addressWord(owner, "allowance owner")}${addressWord(spender, "allowance spender")}`;
}

export function finiteEoaOpenPreparation({
  wallet,
  market,
  order,
}) {
  const owner = String(wallet || "").toLowerCase();
  const collateralToken = String(market?.collateral || "").toLowerCase();
  const spender = String(market?.exchange || "").toLowerCase();
  const approvalAmountRaw = String(order?.maximumTotalDebitRaw ?? "");
  const minimumRequiredRaw = String(order?.maximumOrderPrincipalRaw ?? "");

  invariant(ADDRESS_RE.test(owner), "invalid_eoa_preparation", "EOA owner is invalid");
  invariant(
    collateralToken === CONTRACTS.pUsd && spender === CONTRACTS.standardExchangeV2,
    "invalid_eoa_preparation",
    "Finite EOA preparation is only available for standard V2 pUSD BUYs",
  );
  invariant(market?.negRisk === false, "invalid_eoa_preparation", "Neg-risk EOA preparation is unsupported");
  invariant(
    order?.side === "BUY" && order?.orderType === "FAK",
    "invalid_eoa_preparation",
    "Finite EOA preparation is only available for FAK BUYs",
  );
  invariant(UINT_RE.test(approvalAmountRaw) && UINT_RE.test(minimumRequiredRaw), "invalid_eoa_preparation", "EOA approval bounds are invalid");
  const approval = BigInt(approvalAmountRaw);
  const minimum = BigInt(minimumRequiredRaw);
  invariant(
    approval >= minimum && minimum > 0n,
    "invalid_eoa_preparation",
    "EOA approval must cover the signed order principal",
  );

  const approvalData = approveCalldata(spender, approvalAmountRaw);
  const revokeData = approveCalldata(spender, "0");
  const readbackData = allowanceCalldata(owner, spender);

  const plan = {
    version: EOA_OPEN_PREPARATION_VERSION,
    action: "OPEN",
    tradingMode: "eoa",
    chainId: POLYGON_CHAIN_ID,
    scope: "standard-v2-pusd-fak-buy-only",
    owner,
    collateralToken,
    spender,
    directPusdFundingRequired: true,
    negRiskAllowed: false,
    outcomeTokenApprovalRequiredForBuy: false,
    approval: {
      method: "approve(address,uint256)",
      amount: formatDecimal(approval, 6),
      amountRaw: approvalAmountRaw,
      minimumRequiredRaw,
      calldata: approvalData,
      securityScan: {
        program: "onchainos",
        argv: [
          "security",
          "tx-scan",
          "--chain",
          String(POLYGON_CHAIN_ID),
          "--from",
          owner,
          "--to",
          collateralToken,
          "--data",
          approvalData,
          "--value",
          "0x0",
        ],
      },
      submit: {
        program: "onchainos",
        argv: [
          "wallet",
          "contract-call",
          "--chain",
          String(POLYGON_CHAIN_ID),
          "--from",
          owner,
          "--to",
          collateralToken,
          "--input-data",
          approvalData,
          "--amt",
          "0",
          "--strategy",
          "conviction-finite-eoa-open",
        ],
      },
      confirmationText: "Prepare test wallet",
      unlimitedApprovalForbidden: true,
      setApprovalForAllForbidden: true,
    },
    allowanceReadback: {
      rpcMethod: "eth_call",
      to: collateralToken,
      data: readbackData,
      owner,
      spender,
      minimumRaw: minimumRequiredRaw,
      maximumRaw: approvalAmountRaw,
    },
    execution: {
      program: "polymarket-plugin",
      argvPointer: "$.executionCard.argv",
      appendArgv: ["--mode", "eoa"],
      forbiddenArgv: ["--approve"],
      stopIfPluginRequestsApproval: true,
      stopIfPluginRequestsSetApprovalForAll: true,
      stopIfMakerAddressNotAllowed: true,
    },
    cleanup: {
      offeredAfterProof: true,
      method: "approve(address,uint256)",
      amountRaw: "0",
      calldata: revokeData,
      requiresSeparateConfirmation: true,
    },
  };
  return Object.freeze({
    ...plan,
    planHash: sha256(plan),
  });
}

export function finiteEoaOpenPreparationMatches(intent) {
  try {
    const expected = finiteEoaOpenPreparation({
      wallet: intent?.buyer?.wallet,
      market: intent?.market,
      order: intent?.order,
    });
    return sha256(intent?.walletPreparation) === sha256(expected);
  } catch {
    return false;
  }
}
