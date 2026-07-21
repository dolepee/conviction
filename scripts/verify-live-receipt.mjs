import { readFile } from "node:fs/promises";
import { fetchAndVerifyPosition } from "../src/receipt-verifier.mjs";

const [intentArtifactPath, transactionHash, orderId] = process.argv.slice(2);
if (!intentArtifactPath || !transactionHash || !orderId) {
  console.error(
    "Usage: npm run receipt:verify -- <intent-artifact.json> <txHash> <orderId>",
  );
  process.exit(2);
}
const artifact = JSON.parse(await readFile(intentArtifactPath, "utf8"));
const result = await fetchAndVerifyPosition(transactionHash, {
  intent: artifact.intent,
  intentHash: artifact.intentHash,
  orderId,
});
console.log(JSON.stringify(result, null, 2));
