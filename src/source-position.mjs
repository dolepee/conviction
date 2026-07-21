import { invariant } from "./errors.mjs";
import { fetchAndVerifyPosition } from "./receipt-verifier.mjs";

const HASH_RE = /^0x[0-9a-f]{64}$/i;

export async function verifySourcePosition(
  sourcePosition,
  {
    trustedIssuers,
    verifyImpl = fetchAndVerifyPosition,
    rpcUrl = undefined,
    fetchImpl = fetch,
  } = {},
) {
  invariant(sourcePosition && typeof sourcePosition === "object", "missing_source_proof", "Source position proof is required");
  const transactionHash = String(sourcePosition.transactionHash || "").toLowerCase();
  const orderId = String(sourcePosition.orderId || "").toLowerCase();
  const intentHash = String(sourcePosition.intentHash || "").toLowerCase();
  invariant(HASH_RE.test(transactionHash), "invalid_source_proof", "Source settlement transaction is invalid");
  invariant(HASH_RE.test(orderId), "invalid_source_proof", "Source order ID is invalid");
  invariant(HASH_RE.test(intentHash), "invalid_source_proof", "Source intent hash is invalid");
  invariant(sourcePosition.intent && typeof sourcePosition.intent === "object", "invalid_source_proof", "Source canonical intent is required");

  const proof = await verifyImpl(
    transactionHash,
    {
      intent: sourcePosition.intent,
      intentHash,
      orderId,
      issuance: sourcePosition.issuance,
      trustedIssuers,
    },
    { ...(rpcUrl ? { rpcUrl } : {}), fetchImpl },
  );
  const positionProof = proof?.positionProof;
  const positionProofHash = String(proof?.positionProofHash || "").toLowerCase();
  invariant(positionProof && typeof positionProof === "object", "invalid_source_proof", "Source verifier returned no position proof");
  invariant(HASH_RE.test(positionProofHash), "invalid_source_proof", "Source verifier returned an invalid proof hash");
  if (sourcePosition.positionProofHash !== undefined) {
    invariant(
      String(sourcePosition.positionProofHash).toLowerCase() === positionProofHash,
      "source_proof_hash_mismatch",
      "Source position-proof hash differs from the verified chain proof",
    );
  }
  invariant(String(positionProof.intentHash || "").toLowerCase() === intentHash, "source_intent_mismatch", "Source verifier returned another intent");
  invariant(String(positionProof.transactionHash || "").toLowerCase() === transactionHash, "source_transaction_mismatch", "Source verifier returned another transaction");
  invariant(String(positionProof.orderId || "").toLowerCase() === orderId, "source_order_mismatch", "Source verifier returned another order");
  const signedSource = sourcePosition.intent.version === "conviction-intent-v4";
  const verificationMode = String(
    positionProof.verificationMode || (signedSource ? "signed-intent-window" : "retrospective"),
  );
  invariant(
    verificationMode === "signed-intent-window" || verificationMode === "retrospective",
    "invalid_source_proof",
    "Source verifier returned an unsupported verification mode",
  );

  return Object.freeze({
    intentHash,
    positionProofHash,
    transactionHash,
    orderId,
    wallet: String(positionProof.wallet || "").toLowerCase(),
    marketConditionId: String(positionProof.marketConditionId || "").toLowerCase(),
    outcome: String(positionProof.outcome || "").toUpperCase(),
    outcomeTokenId: String(positionProof.outcomeTokenId || ""),
    actualSharesRaw: String(positionProof.fill?.actualSharesRaw || ""),
    intentVersion: String(sourcePosition.intent.version || ""),
    verificationMode,
  });
}
