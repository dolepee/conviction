import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import { sha256 } from "../src/canonical.mjs";

const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
const css = await readFile(new URL("../styles.css", import.meta.url), "utf8");
const app = await readFile(new URL("../app.js", import.meta.url), "utf8");
const privacy = await readFile(new URL("../privacy.html", import.meta.url), "utf8");
const terms = await readFile(new URL("../terms.html", import.meta.url), "utf8");
const controlledProof = JSON.parse(
  await readFile(new URL("../assets/conviction-review-deliverable.json", import.meta.url), "utf8"),
);
const samplePositionCard = JSON.parse(
  await readFile(new URL("../assets/conviction-sample-position-card.json", import.meta.url), "utf8"),
);
const manifest = JSON.parse(
  await readFile(new URL("../manifest.webmanifest", import.meta.url), "utf8"),
);
const robots = await readFile(new URL("../robots.txt", import.meta.url), "utf8");
const vercel = JSON.parse(await readFile(new URL("../vercel.json", import.meta.url), "utf8"));

async function readPngSize(path) {
  const image = await readFile(new URL(path, import.meta.url));
  assert.equal(image.subarray(1, 4).toString("ascii"), "PNG", `${path} is not a PNG`);
  return { width: image.readUInt32BE(16), height: image.readUInt32BE(20) };
}

for (const required of [
  "<title>",
  'name="description"',
  'property="og:image"',
  'name="twitter:card"',
  'property="og:image:alt"',
  'name="twitter:image:alt"',
  'rel="icon"',
  'rel="apple-touch-icon"',
  'rel="manifest"',
  'class="skip-link"',
  'id="proof"',
  'id="manage"',
  'id="try"',
  'id="verify"',
  'id="market-form"',
  'id="preview-form"',
  'id="verification-form"',
  'name="outcome" value="yes"',
  'name="outcome" value="no"',
  "0x25d2a555c1fe20493563136b608c7a566261b1e9eaf7cf594171d97c4489fb8a",
]) {
  assert.ok(html.includes(required), `missing required site marker: ${required}`);
}
assert.ok(css.includes("@media (max-width: 560px)"), "missing mobile breakpoint");
assert.ok(css.includes(":focus-visible"), "missing visible focus styling");
assert.ok(css.includes("prefers-reduced-motion"), "missing reduced-motion support");
assert.ok(css.includes("--muted: #5f6964"), "muted text token does not meet AA contrast");
assert.ok(css.includes("--orange: #c23c20"), "accent text token does not meet AA contrast");
assert.ok(app.includes('postJson("/api/market"'), "one-field market lookup is not connected");
assert.ok(app.includes('postJson("/api/preview"'), "wallet-free preview is not connected");
assert.ok(app.includes('postJson("/api/intent"'), "final compiler UI is not connected to intent API");
assert.ok(app.includes('postJson("/api/receipt"'), "receipt verification is not connected");
assert.ok(app.includes('setAttribute("aria-invalid", "true")'), "invalid fields are not identified");
assert.ok(app.includes('setAttribute("aria-errormessage", statusId)'), "field errors are not associated with status text");
assert.ok(app.includes('setAttribute("aria-describedby", [...describedBy].join(" "))'), "field errors lack a broadly supported description");
assert.ok(app.includes('invalid_order_id: ["orderId"]'), "invalid order IDs are not mapped to the Order ID field");
assert.equal(app.includes('missing_order_id: ["orderId"]'), false, "stale missing-order error mapping must not remain");
assert.ok(app.includes("intent.exposure.maximumLoss"), "compiler UI does not render exposure");
assert.ok(app.includes("order.maximumOrderPrincipal"), "compiler UI does not render order principal");
assert.ok(app.includes("exposure.maximumFee"), "compiler UI does not render the venue-fee reserve");
assert.ok(html.includes("Total risk, fees included"), "compiler form does not label the fee-inclusive budget");
assert.ok(app.includes('id="download-dossier"'), "compiler UI does not expose the intent dossier");
assert.ok(app.includes("Copy secure dry-run request"), "compiler UI does not expose a safe Agentic Wallet handoff");
assert.ok(app.includes("Pasting it is not live-trading authorization"), "handoff does not separate copy from authorization");
assert.equal(
  html.includes("0x6a355e4971d9ac2ab97d22c3cf361d42faba33fe"),
  false,
  "house wallet must never be prefilled or exposed in the first-user form",
);
assert.equal(
  html.toLowerCase().includes("invade-iran") || html.toLowerCase().includes("invade iran"),
  false,
  "the reviewer-facing page must not default to the geopolitical proof market",
);
assert.equal(/id="market-input"[^>]*\svalue=/.test(html), false, "market input must start empty");
assert.equal(/id="wallet-input"[^>]*\svalue=/.test(html), false, "wallet input must start empty");
assert.ok(html.includes('href="/privacy.html"'), "footer does not expose privacy terms");
assert.ok(html.includes('href="/terms.html"'), "footer does not expose service terms");
assert.match(privacy, /no application database/i);
assert.match(privacy, /IP-shaped client identifier/i);
assert.match(privacy, /Never submit a seed phrase/i);
assert.match(terms, /ready-to-sign bounded OPEN card/i);
assert.match(terms, /post-only GTD TAKE_PROFIT card/i);
assert.match(terms, /paying 0\.05 or 0\.10 USD₮0 never authorizes a trade/i);
assert.match(terms, /Neither response alone is a fill/i);
assert.ok(html.includes("/assets/conviction-sample-position-card.json"), "historical position card is not linked");
assert.ok(html.includes("/assets/conviction-review-deliverable.json"), "controlled proof dossier is not linked");
assert.equal(samplePositionCard.cardStatus, "historical-expired-do-not-execute");
assert.equal(samplePositionCard.scope.noTransactionSignedOrBroadcast, true);
assert.equal(samplePositionCard.scope.postFillVerificationIncluded, false);
assert.equal(samplePositionCard.response.executionCard.requiresUserConfirmation, true);
assert.equal(sha256(samplePositionCard.response.intent), samplePositionCard.response.intentHash);
assert.equal(controlledProof.relationshipToPaidService.isPaidServiceOutput, false);
assert.equal(controlledProof.cardStatus, "historical-expired-do-not-execute");
assert.equal(controlledProof.summary.provesIntentPredatedTransaction, false);
assert.equal(controlledProof.summary.provesReferenceCardWasExecutionSource, false);
assert.equal(sha256(controlledProof.canonicalIntent), controlledProof.hashes.intentHash);
assert.equal(sha256(controlledProof.receiptProof), controlledProof.hashes.receiptHash);
assert.equal(sha256(controlledProof.positionProof), controlledProof.hashes.positionProofHash);
assert.ok(Object.values(controlledProof.receiptProof.checks).every(Boolean));
assert.ok(Object.values(controlledProof.positionProof.checks).every(Boolean));
assert.ok(html.includes(controlledProof.hashes.receiptHash), "current v3 receipt hash is not shown");
assert.equal(
  html.includes("0x1746d89ea5c08c5edc214fcca3baf5b3bc6ce7b4ea9d02427dd88035cd4373b3"),
  false,
  "legacy v2 receipt hash must not be presented as the current proof",
);
assert.equal(manifest.name, "Conviction");
assert.equal(manifest.start_url, "/");
assert.ok(manifest.icons.some((icon) => icon.sizes === "192x192"));
assert.ok(manifest.icons.some((icon) => icon.sizes === "512x512"));
assert.deepEqual(await readPngSize("../assets/conviction-icon-32.png"), { width: 32, height: 32 });
assert.deepEqual(await readPngSize("../assets/apple-touch-icon.png"), { width: 180, height: 180 });
assert.deepEqual(await readPngSize("../assets/conviction-icon-192.png"), { width: 192, height: 192 });
assert.deepEqual(await readPngSize("../assets/conviction-icon-512.png"), { width: 512, height: 512 });
assert.match(robots, /User-agent: \*/);
assert.match(robots, /Allow: \//);
assert.match(vercel.rewrites[0].source, /robots/);
assert.match(vercel.rewrites[0].source, /manifest/);
assert.deepEqual(vercel.regions, ["sin1"], "serverless APIs must avoid a US payment region");

console.log("site verification passed: metadata, icons, robots, proof, compiler, mobile, and accessibility markers present");
