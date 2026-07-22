import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { trustedIssuerRegistry } from "../src/intent-issuer.mjs";
import { fetchAndVerifyPosition } from "../src/receipt-verifier.mjs";

const [inputPath, outputPath] = process.argv.slice(2);
if (!inputPath || !outputPath) {
  throw new Error("usage: node scripts/export-signed-open-proof.mjs <gate-report.json> <output.json>");
}

const gate = JSON.parse(readFileSync(resolve(inputPath), "utf8"));
const trustedConfig = JSON.parse(readFileSync(new URL("../config/trusted-issuer.production.json", import.meta.url), "utf8"));
const journey = gate?.reconciliation;
const card = journey?.paidCard;
if (card?.intent?.version !== "conviction-intent-v4" || !card?.issuance) {
  throw new Error("gate report does not contain a signed v4 paid card");
}
const proof = await fetchAndVerifyPosition(journey.settlementTx, {
  intent: card.intent,
  intentHash: card.intentHash,
  issuance: card.issuance,
  trustedIssuers: trustedIssuerRegistry(trustedConfig.issuers),
  orderId: journey.orderId,
});
if (proof.assurance !== "issuer-signed") throw new Error("exported proof is not issuer-signed");

const artifact = {
  version: "conviction-signed-open-proof-v1",
  artifactType: "controlled-issuer-signed-open-proof",
  label: "Controlled house proof — issuer-signed intent and independently verified Polygon fill",
  assurance: proof.assurance,
  controlledHouseProof: true,
  externalTraction: false,
  financialPerformanceClaim: false,
  transactionHash: journey.settlementTx,
  orderId: journey.orderId,
  intentHash: card.intentHash,
  issuance: card.issuance,
  intent: card.intent,
  receiptProof: proof.receiptProof,
  positionProof: proof.positionProof,
  positionProofHash: proof.positionProofHash,
  positionPassport: proof.positionPassport,
  positionPassportHash: proof.positionPassportHash,
};
writeFileSync(resolve(outputPath), `${JSON.stringify(artifact, null, 2)}\n`);
console.log(JSON.stringify({
  ok: true,
  assurance: artifact.assurance,
  transactionHash: artifact.transactionHash,
  positionProofHash: artifact.positionProofHash,
  output: resolve(outputPath),
}));
