import { readFile } from "node:fs/promises";
import { trustedIssuerRegistry } from "../src/intent-issuer.mjs";
import { fetchAndVerifyPosition } from "../src/receipt-verifier.mjs";

const args = process.argv.slice(2);
const allowUnsigned = args.includes("--allow-unsigned");
const positional = args.filter((value) => value !== "--allow-unsigned");
const [intentArtifactPath, transactionHash, orderId] = positional;
if (!intentArtifactPath || !transactionHash || !orderId) {
  console.error(
    "Usage: npm run receipt:verify -- <intent-artifact.json> <txHash> <orderId> [--allow-unsigned]",
  );
  process.exit(2);
}
const artifact = JSON.parse(await readFile(intentArtifactPath, "utf8"));
const intent = artifact.intent || artifact.canonicalIntent;
const trustedConfig = JSON.parse(
  await readFile(new URL("../config/trusted-issuer.production.json", import.meta.url), "utf8"),
);
const result = await fetchAndVerifyPosition(transactionHash, {
  intent,
  intentHash: artifact.intentHash || artifact.hashes?.intentHash,
  orderId,
  issuance: artifact.issuance,
  trustedIssuers: trustedIssuerRegistry(trustedConfig.issuers),
  allowUnsigned,
});
console.log(JSON.stringify(result, null, 2));
