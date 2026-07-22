import assert from "node:assert/strict";
import test from "node:test";

import { readProofWithReceiptIndexingRetry } from "../scripts/buyer-orchestrator.mjs";

function codedError(code) {
  return Object.assign(new Error(code), { code });
}

test("retries a not-yet-indexed receipt without changing the proof read", async () => {
  const calls = [];
  const sleeps = [];
  const expected = Object.freeze({ transactionHash: `0x${"1".repeat(64)}` });
  const result = await readProofWithReceiptIndexingRetry(async () => {
    calls.push(expected);
    if (calls.length < 3) throw codedError("missing_receipt");
    return expected;
  }, {
    delaysMs: [1, 2, 4],
    async sleepImpl(delayMs) { sleeps.push(delayMs); },
  });
  assert.equal(result, expected);
  assert.equal(calls.length, 3);
  assert.ok(calls.every((value) => value === expected));
  assert.deepEqual(sleeps, [1, 2]);
});

test("retries a not-yet-indexed settlement block", async () => {
  let calls = 0;
  const result = await readProofWithReceiptIndexingRetry(async () => {
    calls += 1;
    if (calls === 1) throw codedError("missing_settlement_block");
    return { ok: true };
  }, { delaysMs: [0], sleepImpl: async () => {} });
  assert.deepEqual(result, { ok: true });
  assert.equal(calls, 2);
});

test("never retries non-indexing failures", async () => {
  for (const code of ["rpc_error", "settlement_transaction_mismatch", "wrong_exchange", "receipt_failed"]) {
    let calls = 0;
    let sleeps = 0;
    await assert.rejects(
      readProofWithReceiptIndexingRetry(async () => {
        calls += 1;
        throw codedError(code);
      }, {
        delaysMs: [0, 0],
        async sleepImpl() { sleeps += 1; },
      }),
      (error) => error?.code === code,
    );
    assert.equal(calls, 1);
    assert.equal(sleeps, 0);
  }
});

test("exhausts the exact bounded schedule and preserves the final transient code", async () => {
  let calls = 0;
  const sleeps = [];
  await assert.rejects(
    readProofWithReceiptIndexingRetry(async () => {
      calls += 1;
      throw codedError("missing_receipt");
    }, {
      delaysMs: [1, 2, 4, 4, 4],
      async sleepImpl(delayMs) { sleeps.push(delayMs); },
    }),
    (error) => error?.code === "missing_receipt",
  );
  assert.equal(calls, 6);
  assert.deepEqual(sleeps, [1, 2, 4, 4, 4]);
});

test("rejects malformed retry policy before any proof read", async () => {
  let calls = 0;
  await assert.rejects(
    readProofWithReceiptIndexingRetry(async () => { calls += 1; }, { delaysMs: [-1] }),
    (error) => error?.code === "invalid_retry_policy",
  );
  assert.equal(calls, 0);
});
