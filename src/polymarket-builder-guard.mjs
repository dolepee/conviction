import {
  encodeFunctionData,
  getAddress,
  recoverTypedDataAddress,
} from "viem";

export const POLYGON_CHAIN_ID = 137;
export const RELAYER_SUBMIT_PATH = "/submit";
export const DEPOSIT_WALLET_FACTORY = getAddress("0x00000000000Fb5C9ADea0298D729A0CB3823Cc07");
export const PUSD = getAddress("0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB");
export const CTF = getAddress("0x4D97DCd97eC945f40cF65F87097ACe5EA0476045");
export const CTF_EXCHANGE_V2 = getAddress("0xE111180000d2663C0091e4f400237545B87B996B");
export const NEG_RISK_CTF_EXCHANGE_V2 = getAddress("0xe2222d279d744050d28e00520010520000310F59");
export const NEG_RISK_ADAPTER = getAddress("0xd91E80cF2E7be2e162c6513ceD06f1dD0dA35296");
export const MAX_UINT256 = (1n << 256n) - 1n;

const APPROVE_ABI = [{
  type: "function",
  name: "approve",
  stateMutability: "nonpayable",
  inputs: [
    { name: "spender", type: "address" },
    { name: "amount", type: "uint256" },
  ],
  outputs: [{ name: "", type: "bool" }],
}];

const SET_APPROVAL_FOR_ALL_ABI = [{
  type: "function",
  name: "setApprovalForAll",
  stateMutability: "nonpayable",
  inputs: [
    { name: "operator", type: "address" },
    { name: "approved", type: "bool" },
  ],
  outputs: [],
}];

const BATCH_TYPES = {
  Call: [
    { name: "target", type: "address" },
    { name: "value", type: "uint256" },
    { name: "data", type: "bytes" },
  ],
  Batch: [
    { name: "wallet", type: "address" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
    { name: "calls", type: "Call[]" },
  ],
};

export class BuilderGuardError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = "BuilderGuardError";
    this.status = status;
    this.code = code;
  }
}

function exactKeys(value, expected, code) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new BuilderGuardError(422, code, "Builder request has an invalid shape");
  }
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (JSON.stringify(actual) !== JSON.stringify(wanted)) {
    throw new BuilderGuardError(422, code, "Builder request contains missing or unsupported fields");
  }
}

function normalizeAddress(value, code) {
  try {
    return getAddress(value);
  } catch {
    throw new BuilderGuardError(422, code, "Builder request contains an invalid address");
  }
}

function decimalInteger(value, code) {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/.test(value)) {
    throw new BuilderGuardError(422, code, "Builder request integer must be a canonical decimal string");
  }
  return BigInt(value);
}

function expectedApprovalCalls() {
  const approve = (spender) => ({
    target: PUSD,
    value: "0",
    data: encodeFunctionData({
      abi: APPROVE_ABI,
      functionName: "approve",
      args: [spender, MAX_UINT256],
    }).toLowerCase(),
  });
  const approveAll = (operator) => ({
    target: CTF,
    value: "0",
    data: encodeFunctionData({
      abi: SET_APPROVAL_FOR_ALL_ABI,
      functionName: "setApprovalForAll",
      args: [operator, true],
    }).toLowerCase(),
  });
  return Object.freeze([
    approve(CTF_EXCHANGE_V2),
    approve(NEG_RISK_CTF_EXCHANGE_V2),
    approveAll(CTF_EXCHANGE_V2),
    approveAll(NEG_RISK_CTF_EXCHANGE_V2),
    approveAll(NEG_RISK_ADAPTER),
  ]);
}

export const OFFICIAL_APPROVAL_CALLS = expectedApprovalCalls();

function normalizeCall(call) {
  exactKeys(call, ["target", "value", "data"], "invalid_builder_call");
  if (typeof call.data !== "string" || !/^0x[0-9a-fA-F]+$/.test(call.data)) {
    throw new BuilderGuardError(422, "invalid_builder_call", "Builder call data is invalid");
  }
  return {
    target: normalizeAddress(call.target, "invalid_builder_call"),
    value: decimalInteger(call.value, "invalid_builder_call").toString(),
    data: call.data.toLowerCase(),
  };
}

function validateCreate(body, wallet) {
  exactKeys(body, ["type", "from", "to"], "invalid_wallet_create_request");
  if (body.type !== "WALLET-CREATE") {
    throw new BuilderGuardError(422, "unsupported_builder_request", "Only official deposit-wallet setup is supported");
  }
  if (normalizeAddress(body.from, "invalid_wallet_create_request") !== wallet) {
    throw new BuilderGuardError(403, "wallet_session_mismatch", "Builder request wallet does not match the authenticated session");
  }
  if (normalizeAddress(body.to, "invalid_wallet_create_request") !== DEPOSIT_WALLET_FACTORY) {
    throw new BuilderGuardError(422, "invalid_deposit_wallet_factory", "Deposit-wallet factory is not allowlisted");
  }
  return Object.freeze({ action: "DEPLOY_DEPOSIT_WALLET", body });
}

async function validateBatch(body, wallet, nowSeconds) {
  exactKeys(
    body,
    ["type", "from", "to", "nonce", "signature", "depositWalletParams"],
    "invalid_wallet_batch_request",
  );
  if (body.type !== "WALLET") {
    throw new BuilderGuardError(422, "unsupported_builder_request", "Only official deposit-wallet setup is supported");
  }
  if (normalizeAddress(body.from, "invalid_wallet_batch_request") !== wallet) {
    throw new BuilderGuardError(403, "wallet_session_mismatch", "Builder request wallet does not match the authenticated session");
  }
  if (normalizeAddress(body.to, "invalid_wallet_batch_request") !== DEPOSIT_WALLET_FACTORY) {
    throw new BuilderGuardError(422, "invalid_deposit_wallet_factory", "Deposit-wallet factory is not allowlisted");
  }
  if (typeof body.signature !== "string" || !/^0x[0-9a-fA-F]{130}$/.test(body.signature)) {
    throw new BuilderGuardError(422, "invalid_batch_signature", "Deposit-wallet batch signature is invalid");
  }
  const nonce = decimalInteger(body.nonce, "invalid_wallet_nonce");
  exactKeys(
    body.depositWalletParams,
    ["depositWallet", "deadline", "calls"],
    "invalid_wallet_batch_request",
  );
  const depositWallet = normalizeAddress(
    body.depositWalletParams.depositWallet,
    "invalid_deposit_wallet",
  );
  const deadline = decimalInteger(body.depositWalletParams.deadline, "invalid_wallet_deadline");
  if (deadline <= BigInt(nowSeconds) || deadline > BigInt(nowSeconds + 300)) {
    throw new BuilderGuardError(422, "invalid_wallet_deadline", "Deposit-wallet setup signature must expire within five minutes");
  }
  if (!Array.isArray(body.depositWalletParams.calls) || body.depositWalletParams.calls.length !== 5) {
    throw new BuilderGuardError(422, "invalid_approval_batch", "Setup must contain the exact five official approval calls");
  }
  const calls = body.depositWalletParams.calls.map(normalizeCall);
  if (JSON.stringify(calls) !== JSON.stringify(OFFICIAL_APPROVAL_CALLS)) {
    throw new BuilderGuardError(422, "invalid_approval_batch", "Setup approval calls do not match the official allowlist");
  }
  const recovered = await recoverTypedDataAddress({
    domain: {
      name: "DepositWallet",
      version: "1",
      chainId: POLYGON_CHAIN_ID,
      verifyingContract: depositWallet,
    },
    types: BATCH_TYPES,
    primaryType: "Batch",
    message: {
      wallet: depositWallet,
      nonce,
      deadline,
      calls: calls.map((call) => ({
        target: call.target,
        value: BigInt(call.value),
        data: call.data,
      })),
    },
    signature: body.signature,
  });
  if (getAddress(recovered) !== wallet) {
    throw new BuilderGuardError(403, "batch_signature_mismatch", "Deposit-wallet batch was not signed by the authenticated buyer");
  }
  return Object.freeze({
    action: "APPROVE_DEPOSIT_WALLET",
    depositWallet,
    deadline: deadline.toString(),
    body,
  });
}

export async function validateBuilderRequest({
  method,
  path,
  body,
  session,
  nowSeconds = Math.floor(Date.now() / 1_000),
}) {
  if (method !== "POST" || path !== RELAYER_SUBMIT_PATH) {
    throw new BuilderGuardError(422, "unsupported_builder_request", "Builder signing is limited to POST /submit");
  }
  const wallet = normalizeAddress(session?.wallet, "invalid_wallet_session");
  if (body?.type === "WALLET-CREATE") return validateCreate(body, wallet);
  if (body?.type === "WALLET") return validateBatch(body, wallet, nowSeconds);
  throw new BuilderGuardError(422, "unsupported_builder_request", "Only deposit-wallet deployment and the official setup batch are supported");
}
