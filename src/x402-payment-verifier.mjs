import { ConvictionError, invariant } from "./errors.mjs";

export const XLAYER_CHAIN_ID = 196;
export const XLAYER_RPC_URL = "https://rpc.xlayer.tech";
export const ERC20_TRANSFER_TOPIC =
  "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

const ADDRESS_RE = /^0x[0-9a-f]{40}$/i;
const HASH_RE = /^0x[0-9a-f]{64}$/i;
const TOPIC_RE = /^0x[0-9a-f]{64}$/i;
const UINT256_RE = /^0x[0-9a-f]{64}$/i;
const DECIMAL_UINT_RE = /^(?:0|[1-9][0-9]*)$/;
const QUANTITY_RE = /^(?:0x[0-9a-f]+|0|[1-9][0-9]*)$/i;

function lower(value) {
  return String(value || "").toLowerCase();
}

function normalizeAddress(value, label) {
  const address = lower(value);
  invariant(
    ADDRESS_RE.test(address),
    "invalid_payment_expectation",
    `${label} is invalid`,
  );
  return address;
}

function parseQuantity(value, label, code = "invalid_payment_expectation") {
  try {
    const supportedNumber =
      typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
    const supportedString =
      typeof value === "string" && QUANTITY_RE.test(value);
    invariant(
      typeof value === "bigint" || supportedNumber || supportedString,
      code,
      `${label} is invalid`,
    );
    const quantity = BigInt(value);
    invariant(quantity >= 0n, code, `${label} is invalid`);
    return quantity;
  } catch (error) {
    if (error instanceof ConvictionError) throw error;
    throw new ConvictionError(code, `${label} is invalid`);
  }
}

function parseAmount(value) {
  const raw = typeof value === "bigint" ? value.toString() : String(value || "");
  invariant(
    DECIMAL_UINT_RE.test(raw) && BigInt(raw) > 0n,
    "invalid_payment_expectation",
    "Expected payment amount is invalid",
  );
  return BigInt(raw);
}

function parseTimestamp(value, label, code = "invalid_payment_expectation") {
  const timestamp = parseQuantity(value, label, code);
  invariant(
    timestamp <= BigInt(Number.MAX_SAFE_INTEGER),
    code,
    `${label} is invalid`,
  );
  return timestamp;
}

function parseAllowedTime(value) {
  if (value instanceof Date) {
    invariant(
      !Number.isNaN(value.getTime()),
      "invalid_payment_expectation",
      "Earliest allowed time is invalid",
    );
    return BigInt(Math.floor(value.getTime() / 1000));
  }
  const milliseconds = Date.parse(String(value || ""));
  invariant(
    Number.isFinite(milliseconds),
    "invalid_payment_expectation",
    "Earliest allowed time is invalid",
  );
  return BigInt(Math.floor(milliseconds / 1000));
}

function topicAddress(topic, label) {
  invariant(
    TOPIC_RE.test(topic || ""),
    "invalid_payment_receipt",
    `${label} topic is invalid`,
  );
  invariant(
    /^0{24}$/i.test(topic.slice(2, 26)),
    "invalid_payment_receipt",
    `${label} topic is not canonically address-padded`,
  );
  return `0x${topic.slice(-40)}`.toLowerCase();
}

function decodeTransfer(log) {
  invariant(
    Array.isArray(log?.topics) && log.topics.length === 3,
    "invalid_payment_receipt",
    "Payment Transfer event topics are invalid",
  );
  invariant(
    UINT256_RE.test(log.data || ""),
    "invalid_payment_receipt",
    "Payment Transfer event amount is invalid",
  );
  return {
    from: topicAddress(log.topics[1], "Transfer sender"),
    to: topicAddress(log.topics[2], "Transfer recipient"),
    amount: BigInt(log.data),
    logIndex: log.logIndex,
  };
}

function normalizeFreshness(expectation) {
  const hasBlock = expectation.earliestAllowedBlock !== undefined &&
    expectation.earliestAllowedBlock !== null;
  const hasTimestamp = expectation.earliestAllowedTimestamp !== undefined &&
    expectation.earliestAllowedTimestamp !== null;
  const hasTime = expectation.earliestAllowedTime !== undefined &&
    expectation.earliestAllowedTime !== null;

  invariant(
    hasBlock || hasTimestamp || hasTime,
    "missing_payment_freshness",
    "An earliest allowed payment block or time is required",
  );
  invariant(
    !(hasTimestamp && hasTime),
    "invalid_payment_expectation",
    "Use either earliestAllowedTimestamp or earliestAllowedTime, not both",
  );

  return {
    earliestBlock: hasBlock
      ? parseQuantity(expectation.earliestAllowedBlock, "Earliest allowed block")
      : null,
    earliestTimestamp: hasTimestamp
      ? parseTimestamp(expectation.earliestAllowedTimestamp, "Earliest allowed timestamp")
      : hasTime
        ? parseAllowedTime(expectation.earliestAllowedTime)
        : null,
  };
}

export function verifyX402Payment({ chainId, receipt, block, expected }) {
  invariant(
    Number(chainId) === XLAYER_CHAIN_ID,
    "wrong_payment_chain",
    "Payment is not from X Layer",
    { chainId },
  );
  invariant(
    expected && typeof expected === "object",
    "invalid_payment_expectation",
    "Payment expectation is required",
  );

  const paymentTx = lower(expected.paymentTx);
  const payer = normalizeAddress(expected.payer, "Expected payer");
  const payee = normalizeAddress(expected.payee, "Expected payee");
  const asset = normalizeAddress(expected.asset, "Expected payment asset");
  const amount = parseAmount(expected.amountAtomic);
  const freshness = normalizeFreshness(expected);

  invariant(
    HASH_RE.test(paymentTx),
    "invalid_payment_transaction",
    "Payment transaction hash is invalid",
  );
  invariant(
    receipt && typeof receipt === "object",
    "missing_payment_receipt",
    "Payment transaction receipt was not found",
  );
  invariant(
    lower(receipt.transactionHash) === paymentTx,
    "payment_transaction_mismatch",
    "Receipt transaction does not match the requested payment",
  );
  invariant(
    lower(receipt.status) === "0x1",
    "failed_payment_transaction",
    "Payment transaction failed",
  );
  invariant(
    HASH_RE.test(receipt.blockHash || ""),
    "invalid_payment_receipt",
    "Payment receipt block hash is invalid",
  );

  const blockNumber = parseQuantity(
    receipt.blockNumber,
    "Payment receipt block number",
    "invalid_payment_receipt",
  );
  invariant(
    block && typeof block === "object",
    "missing_payment_block",
    "Payment block was not found",
  );
  invariant(
    HASH_RE.test(block.hash || ""),
    "invalid_payment_block",
    "Payment block hash is invalid",
  );
  invariant(
    lower(block.hash) === lower(receipt.blockHash),
    "payment_block_mismatch",
    "Payment receipt is not bound to the fetched block",
  );
  invariant(
    parseQuantity(block.number, "Payment block number", "invalid_payment_block") === blockNumber,
    "payment_block_mismatch",
    "Payment receipt and block numbers disagree",
  );
  const blockTimestamp = parseTimestamp(
    block.timestamp,
    "Payment block timestamp",
    "invalid_payment_block",
  );

  if (freshness.earliestBlock !== null) {
    invariant(
      blockNumber >= freshness.earliestBlock,
      "stale_payment",
      "Payment predates the earliest allowed block",
    );
  }
  if (freshness.earliestTimestamp !== null) {
    invariant(
      blockTimestamp >= freshness.earliestTimestamp,
      "stale_payment",
      "Payment predates the earliest allowed time",
    );
  }

  const transfersFromPayer = [];
  for (const log of Array.isArray(receipt.logs) ? receipt.logs : []) {
    if (lower(log?.address) !== asset || lower(log?.topics?.[0]) !== ERC20_TRANSFER_TOPIC) continue;
    const transfer = decodeTransfer(log);
    if (transfer.from === payer) transfersFromPayer.push(transfer);
  }

  invariant(
    transfersFromPayer.length === 1,
    "payment_transfer_mismatch",
    "Payment must contain exactly one transfer of the expected asset from the payer",
  );
  const [transfer] = transfersFromPayer;
  invariant(
    transfer.to === payee,
    "payment_recipient_mismatch",
    "Payment recipient does not match",
  );
  invariant(
    transfer.amount === amount,
    "payment_amount_mismatch",
    "Payment amount does not match",
  );

  return {
    ok: true,
    proof: {
      version: "conviction-x402-payment-v1",
      chainId: XLAYER_CHAIN_ID,
      transactionHash: paymentTx,
      blockNumber: blockNumber.toString(),
      blockHash: lower(block.hash),
      blockTimestamp: blockTimestamp.toString(),
      asset,
      payer,
      payee,
      amountAtomic: amount.toString(),
      logIndex: transfer.logIndex ?? null,
      checks: {
        transactionSucceeded: true,
        receiptBoundToBlock: true,
        freshPayment: true,
        exactAsset: true,
        exactPayer: true,
        exactPayee: true,
        exactAmount: true,
      },
    },
  };
}

async function requestRpc(method, params, { fetchImpl, rpcUrl }) {
  let response;
  try {
    response = await fetchImpl(rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch (error) {
    throw new ConvictionError("payment_rpc_error", "X Layer RPC request failed", {
      cause: error instanceof Error ? error.message : String(error),
    });
  }
  if (!response.ok) {
    throw new ConvictionError("payment_rpc_error", `X Layer RPC returned HTTP ${response.status}`);
  }
  let body;
  try {
    body = await response.json();
  } catch {
    throw new ConvictionError("payment_rpc_error", "X Layer RPC returned invalid JSON");
  }
  if (body.error) {
    throw new ConvictionError("payment_rpc_error", "X Layer RPC returned an error", body.error);
  }
  return body.result;
}

export async function fetchAndVerifyX402Payment(
  expected,
  {
    rpcCall = undefined,
    fetchImpl = globalThis.fetch,
    rpcUrl = XLAYER_RPC_URL,
  } = {},
) {
  invariant(
    HASH_RE.test(expected?.paymentTx || ""),
    "invalid_payment_transaction",
    "Payment transaction hash is invalid",
  );
  invariant(
    rpcCall === undefined || typeof rpcCall === "function",
    "invalid_payment_rpc",
    "Injected RPC must be a function",
  );
  invariant(
    rpcCall !== undefined || typeof fetchImpl === "function",
    "invalid_payment_rpc",
    "A fetch implementation is required",
  );

  const call = rpcCall ?? ((method, params) => requestRpc(method, params, { fetchImpl, rpcUrl }));
  let chainHex;
  let receipt;
  let block;
  try {
    chainHex = await call("eth_chainId", []);
    receipt = await call("eth_getTransactionReceipt", [lower(expected.paymentTx)]);
    invariant(
      receipt && typeof receipt === "object",
      "missing_payment_receipt",
      "Payment transaction receipt was not found",
    );
    block = await call("eth_getBlockByNumber", [receipt.blockNumber, false]);
  } catch (error) {
    if (error instanceof ConvictionError) throw error;
    throw new ConvictionError("payment_rpc_error", "X Layer RPC request failed", {
      cause: error instanceof Error ? error.message : String(error),
    });
  }

  let chainId;
  try {
    chainId = Number(BigInt(chainHex));
  } catch {
    throw new ConvictionError("payment_rpc_error", "X Layer RPC returned an invalid chain ID");
  }
  return verifyX402Payment({ chainId, receipt, block, expected });
}
