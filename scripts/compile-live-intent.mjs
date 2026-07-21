import { compileIntent } from "../src/intent-compiler.mjs";
import { resolveMarket } from "../src/market-client.mjs";

const [market, outcome, spend, maxPrice, wallet, ...rationaleParts] = process.argv.slice(2);
if (!market || !outcome || !spend || !maxPrice || !wallet) {
  console.error("Usage: npm run intent:live -- <market> <yes|no> <spend> <maxPrice> <wallet> [rationale]");
  process.exit(2);
}
const snapshot = await resolveMarket(market, { outcome });
const result = compileIntent(
  { market, outcome, spend, maxPrice, wallet, rationale: rationaleParts.join(" ") },
  snapshot,
);
console.log(JSON.stringify(result, null, 2));
