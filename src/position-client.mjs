import { CONTRACTS, POLYGON_CHAIN_ID, POLYGON_RPC_URL } from "./constants.mjs";
import { ConvictionError, invariant } from "./errors.mjs";

const ADDRESS_RE = /^0x[0-9a-f]{40}$/i;
const HASH_RE = /^0x[0-9a-f]{64}$/i;
const TOKEN_ID_RE = /^\d+$/;
const BALANCE_OF_SELECTOR = "00fdd58e";
const IS_APPROVED_FOR_ALL_SELECTOR = "e985e9c5";

function rpcError(message, details = undefined) {
  return new ConvictionError("rpc_error", message, details);
}

async function rpc(method, params, { rpcUrl, fetchImpl }) {
  const response = await fetchImpl(rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: AbortSignal.timeout(10_000),
  });
  let body;
  try {
    body = await response.json();
  } catch {
    throw rpcError("Polygon RPC returned invalid JSON", { method, status: response.status });
  }
  if (!response.ok || body?.error || body?.result === undefined || body?.result === null) {
    throw rpcError("Polygon RPC request failed", {
      method,
      status: response.status,
      rpcCode: body?.error?.code,
    });
  }
  return body.result;
}

function balanceOfData(wallet, outcomeTokenId) {
  return `0x${BALANCE_OF_SELECTOR}${wallet.slice(2).padStart(64, "0")}${BigInt(outcomeTokenId).toString(16).padStart(64, "0")}`;
}

function isApprovedForAllData(wallet, operator) {
  return `0x${IS_APPROVED_FOR_ALL_SELECTOR}${wallet.slice(2).padStart(64, "0")}${operator.slice(2).padStart(64, "0")}`;
}

export async function fetchPositionSnapshot(
  walletValue,
  outcomeTokenIdValue,
  {
    rpcUrl = POLYGON_RPC_URL,
    fetchImpl = fetch,
  } = {},
) {
  const wallet = String(walletValue || "").toLowerCase();
  const outcomeTokenId = String(outcomeTokenIdValue || "");
  invariant(ADDRESS_RE.test(wallet), "invalid_wallet", "Position wallet is invalid");
  invariant(TOKEN_ID_RE.test(outcomeTokenId), "invalid_token", "Outcome token ID is invalid");

  const chainHex = await rpc("eth_chainId", [], { rpcUrl, fetchImpl });
  invariant(/^0x[0-9a-f]+$/i.test(chainHex), "rpc_error", "Polygon RPC returned an invalid chain ID");
  invariant(Number(BigInt(chainHex)) === POLYGON_CHAIN_ID, "wrong_chain", "Position RPC is not Polygon chain 137");
  const block = await rpc("eth_getBlockByNumber", ["latest", false], { rpcUrl, fetchImpl });
  invariant(/^0x[0-9a-f]+$/i.test(String(block?.number || "")), "rpc_error", "Polygon RPC returned an invalid block number");
  invariant(HASH_RE.test(String(block?.hash || "")), "rpc_error", "Polygon RPC returned an invalid block hash");
  invariant(/^0x[0-9a-f]+$/i.test(String(block?.timestamp || "")), "rpc_error", "Polygon RPC returned an invalid block timestamp");

  const [balanceHex, approvalHex] = await Promise.all([
    rpc("eth_call", [{
      to: CONTRACTS.ctf,
      data: balanceOfData(wallet, outcomeTokenId),
    }, block.number], { rpcUrl, fetchImpl }),
    rpc("eth_call", [{
      to: CONTRACTS.ctf,
      data: isApprovedForAllData(wallet, CONTRACTS.standardExchangeV2),
    }, block.number], { rpcUrl, fetchImpl }),
  ]);
  invariant(/^0x[0-9a-f]+$/i.test(String(balanceHex || "")), "rpc_error", "Polygon RPC returned an invalid outcome-token balance");
  invariant(/^0x[0-9a-f]+$/i.test(String(approvalHex || "")), "rpc_error", "Polygon RPC returned an invalid CTF approval");
  const approvalRaw = BigInt(approvalHex);
  invariant(approvalRaw === 0n || approvalRaw === 1n, "rpc_error", "Polygon RPC returned a non-boolean CTF approval");

  return {
    chainId: POLYGON_CHAIN_ID,
    wallet,
    outcomeTokenId,
    balanceRaw: BigInt(balanceHex).toString(),
    approvedForExchange: approvalRaw === 1n,
    blockNumber: String(block.number).toLowerCase(),
    blockHash: String(block.hash).toLowerCase(),
    capturedAt: new Date(Number(BigInt(block.timestamp)) * 1_000).toISOString(),
  };
}
