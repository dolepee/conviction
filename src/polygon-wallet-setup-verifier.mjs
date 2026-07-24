import {
  decodeFunctionResult,
  encodeFunctionData,
  getAddress,
} from "viem";

import {
  CTF,
  CTF_EXCHANGE_V2,
  DEPOSIT_WALLET_FACTORY,
  MAX_UINT256,
  NEG_RISK_ADAPTER,
  NEG_RISK_CTF_EXCHANGE_V2,
  OFFICIAL_APPROVAL_CALLS,
  PUSD,
} from "./polymarket-builder-guard.mjs";

export const WALLET_DEPLOYED_TOPIC = "0x7441de0ad639fe5d2bf1c22447715a0528b682385736bb40ae8dd92555eb8276";

const HASH_RE = /^0x[0-9a-fA-F]{64}$/;
const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const MAX_RESPONSE_BYTES = 128_000;

const ERC20_ABI = [{
  type: "function",
  name: "allowance",
  stateMutability: "view",
  inputs: [
    { name: "owner", type: "address" },
    { name: "spender", type: "address" },
  ],
  outputs: [{ name: "", type: "uint256" }],
}];

const ERC1155_ABI = [{
  type: "function",
  name: "isApprovedForAll",
  stateMutability: "view",
  inputs: [
    { name: "account", type: "address" },
    { name: "operator", type: "address" },
  ],
  outputs: [{ name: "", type: "bool" }],
}];

export class PolygonWalletSetupVerificationError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = "PolygonWalletSetupVerificationError";
    this.status = status;
    this.code = code;
  }
}

function address(value, code = "invalid_polygon_response") {
  try {
    return getAddress(value);
  } catch {
    throw new PolygonWalletSetupVerificationError(502, code, "Polygon returned an invalid address");
  }
}

function hash(value, code = "invalid_polygon_response") {
  if (typeof value !== "string" || !HASH_RE.test(value)) {
    throw new PolygonWalletSetupVerificationError(502, code, "Polygon returned an invalid transaction hash");
  }
  return value.toLowerCase();
}

function hexQuantity(value, code = "invalid_polygon_response") {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]+$/.test(value)) {
    throw new PolygonWalletSetupVerificationError(502, code, "Polygon returned an invalid quantity");
  }
  try {
    return BigInt(value);
  } catch {
    throw new PolygonWalletSetupVerificationError(502, code, "Polygon returned an invalid quantity");
  }
}

function topicAddress(topic) {
  if (typeof topic !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(topic)) return null;
  return `0x${topic.slice(-40)}`.toLowerCase();
}

function rpcUrl(value) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new PolygonWalletSetupVerificationError(503, "polygon_rpc_unavailable", "Polygon verification is not configured");
  }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new PolygonWalletSetupVerificationError(503, "polygon_rpc_unavailable", "Polygon verification is not configured");
  }
  return parsed.toString();
}

function canonicalRecord({ transactionHash, receipt }) {
  const expected = hash(transactionHash);
  if (!receipt || typeof receipt !== "object") {
    throw new PolygonWalletSetupVerificationError(502, "missing_polygon_receipt", "Polygon has not returned the submitted transaction receipt");
  }
  if (hash(receipt.transactionHash) !== expected) {
    throw new PolygonWalletSetupVerificationError(502, "polygon_receipt_mismatch", "Polygon returned another transaction receipt");
  }
  if (hexQuantity(receipt.status) !== 1n) {
    throw new PolygonWalletSetupVerificationError(422, "polygon_transaction_reverted", "The relayed Polygon transaction reverted");
  }
  if (hexQuantity(receipt.blockNumber) < 1n) {
    throw new PolygonWalletSetupVerificationError(502, "invalid_polygon_receipt", "Polygon receipt has no block number");
  }
  return { transactionHash: expected, blockNumber: receipt.blockNumber, receipt };
}

function expectedOwnerTopic(owner) {
  return `0x${address(owner).slice(2).padStart(64, "0").toLowerCase()}`;
}

export function walletFromDeploymentReceipt({ receipt, transactionHash, owner, factory = DEPOSIT_WALLET_FACTORY }) {
  const record = canonicalRecord({ transactionHash, receipt });
  const expectedFactory = address(factory).toLowerCase();
  const expectedOwner = expectedOwnerTopic(owner);
  const logs = Array.isArray(record.receipt.logs) ? record.receipt.logs : [];
  const event = logs.find((log) => (
    address(log?.address).toLowerCase() === expectedFactory &&
    Array.isArray(log?.topics) &&
    log.topics.length === 4 &&
    String(log.topics[0]).toLowerCase() === WALLET_DEPLOYED_TOPIC &&
    String(log.topics[2]).toLowerCase() === expectedOwner
  ));
  const wallet = topicAddress(event?.topics?.[1]);
  if (!wallet || !ADDRESS_RE.test(wallet)) {
    throw new PolygonWalletSetupVerificationError(502, "deposit_wallet_event_missing", "Polygon receipt did not prove deployment of the buyer Deposit Wallet");
  }
  return Object.freeze({
    wallet: address(wallet),
    transactionHash: record.transactionHash,
    blockNumber: record.blockNumber,
  });
}

function exactBooleanResult(value) {
  if (value === "0x" || typeof value !== "string") {
    throw new PolygonWalletSetupVerificationError(502, "invalid_polygon_response", "Polygon returned an invalid contract response");
  }
  try {
    return decodeFunctionResult({ abi: ERC1155_ABI, functionName: "isApprovedForAll", data: value });
  } catch {
    throw new PolygonWalletSetupVerificationError(502, "invalid_polygon_response", "Polygon returned an invalid contract response");
  }
}

function exactAllowanceResult(value) {
  if (value === "0x" || typeof value !== "string") {
    throw new PolygonWalletSetupVerificationError(502, "invalid_polygon_response", "Polygon returned an invalid contract response");
  }
  try {
    return decodeFunctionResult({ abi: ERC20_ABI, functionName: "allowance", data: value });
  } catch {
    throw new PolygonWalletSetupVerificationError(502, "invalid_polygon_response", "Polygon returned an invalid contract response");
  }
}

export function createPolygonWalletSetupVerifier({ rpcUrl: configuredRpcUrl, fetchImpl = fetch } = {}) {
  const endpoint = rpcUrl(configuredRpcUrl);
  if (typeof fetchImpl !== "function") throw new TypeError("fetchImpl must be a function");
  let requestId = 0;

  async function rpc(method, params) {
    let response;
    try {
      response = await fetchImpl(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: ++requestId, method, params }),
        redirect: "error",
        signal: AbortSignal.timeout(10_000),
      });
    } catch {
      throw new PolygonWalletSetupVerificationError(503, "polygon_rpc_unavailable", "Polygon verification is temporarily unavailable");
    }
    const length = Number(response.headers?.get?.("content-length") || "0");
    if (Number.isFinite(length) && length > MAX_RESPONSE_BYTES) {
      throw new PolygonWalletSetupVerificationError(502, "invalid_polygon_response", "Polygon returned an oversized response");
    }
    let body;
    try {
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes.byteLength > MAX_RESPONSE_BYTES) throw new Error("oversized");
      body = JSON.parse(new TextDecoder().decode(bytes));
    } catch {
      throw new PolygonWalletSetupVerificationError(502, "invalid_polygon_response", "Polygon returned invalid JSON");
    }
    if (!response.ok || body?.error || !("result" in (body || {}))) {
      throw new PolygonWalletSetupVerificationError(502, "polygon_rpc_failed", "Polygon could not verify the setup transaction");
    }
    return body.result;
  }

  async function receipt(transactionHash) {
    return rpc("eth_getTransactionReceipt", [hash(transactionHash)]);
  }

  async function code(wallet, blockTag = "latest") {
    const result = await rpc("eth_getCode", [address(wallet), blockTag]);
    if (typeof result !== "string" || !/^0x[0-9a-fA-F]*$/.test(result)) {
      throw new PolygonWalletSetupVerificationError(502, "invalid_polygon_response", "Polygon returned invalid contract code");
    }
    return result;
  }

  async function ethCall(to, data, blockTag) {
    const result = await rpc("eth_call", [{ to: address(to), data }, blockTag]);
    if (typeof result !== "string") {
      throw new PolygonWalletSetupVerificationError(502, "invalid_polygon_response", "Polygon returned invalid contract data");
    }
    return result;
  }

  async function verifyDeployment({ transactionHash, owner, expectedWallet = undefined }) {
    const found = walletFromDeploymentReceipt({
      receipt: await receipt(transactionHash),
      transactionHash,
      owner,
    });
    if (expectedWallet && address(expectedWallet) !== found.wallet) {
      throw new PolygonWalletSetupVerificationError(502, "deposit_wallet_mismatch", "Relayer and Polygon reported different Deposit Wallet addresses");
    }
    if ((await code(found.wallet, found.blockNumber)) === "0x") {
      throw new PolygonWalletSetupVerificationError(502, "deposit_wallet_code_missing", "Polygon did not confirm Deposit Wallet contract code");
    }
    return found;
  }

  async function verifyApprovals({ transactionHash, wallet }) {
    const record = canonicalRecord({ transactionHash, receipt: await receipt(transactionHash) });
    const buyerWallet = address(wallet);
    const allowanceCalls = [CTF_EXCHANGE_V2, NEG_RISK_CTF_EXCHANGE_V2].map((spender) => ethCall(
      PUSD,
      encodeFunctionData({ abi: ERC20_ABI, functionName: "allowance", args: [buyerWallet, spender] }),
      record.blockNumber,
    ));
    const operatorCalls = [CTF_EXCHANGE_V2, NEG_RISK_CTF_EXCHANGE_V2, NEG_RISK_ADAPTER].map((operator) => ethCall(
      CTF,
      encodeFunctionData({ abi: ERC1155_ABI, functionName: "isApprovedForAll", args: [buyerWallet, operator] }),
      record.blockNumber,
    ));
    const [allowanceResults, approvalResults] = await Promise.all([
      Promise.all(allowanceCalls),
      Promise.all(operatorCalls),
    ]);
    if (allowanceResults.some((result) => exactAllowanceResult(result) !== MAX_UINT256)) {
      throw new PolygonWalletSetupVerificationError(422, "deposit_wallet_allowance_incomplete", "Polygon did not confirm both required pUSD allowances");
    }
    if (approvalResults.some((result) => exactBooleanResult(result) !== true)) {
      throw new PolygonWalletSetupVerificationError(422, "deposit_wallet_approval_incomplete", "Polygon did not confirm every required outcome-token permission");
    }
    return Object.freeze({
      wallet: buyerWallet,
      transactionHash: record.transactionHash,
      blockNumber: record.blockNumber,
      approvalCalls: OFFICIAL_APPROVAL_CALLS.length,
    });
  }

  return Object.freeze({ verifyDeployment, verifyApprovals });
}

export function createPolygonWalletSetupVerifierFromEnvironment(environment = process.env) {
  return createPolygonWalletSetupVerifier({ rpcUrl: environment.CONVICTION_POLYGON_RPC_URL });
}
