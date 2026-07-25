import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import { sha256 } from "../src/canonical.mjs";

const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
const css = await readFile(new URL("../styles.css", import.meta.url), "utf8");
const app = await readFile(new URL("../app.js", import.meta.url), "utf8");
const site = await readFile(new URL("../site.js", import.meta.url), "utf8");
const walletSetupHtml = await readFile(new URL("../wallet-setup.html", import.meta.url), "utf8");
const walletSetupCss = await readFile(new URL("../wallet-setup.css", import.meta.url), "utf8");
const walletSetupApp = await readFile(new URL("../wallet-setup.js", import.meta.url), "utf8");
const browserOpenSource = await readFile(
  new URL("../src/browser-open-entry.mjs", import.meta.url),
  "utf8",
);
const browserOpenBundle = await readFile(
  new URL("../public/assets/browser-open.js", import.meta.url),
  "utf8",
);
const privacy = await readFile(new URL("../privacy.html", import.meta.url), "utf8");
const terms = await readFile(new URL("../terms.html", import.meta.url), "utf8");
const readme = await readFile(new URL("../README.md", import.meta.url), "utf8");
const serviceContract = await readFile(new URL("../docs/SERVICE_CONTRACT.md", import.meta.url), "utf8");
const listingContract = await readFile(new URL("../docs/ASP_LISTING.md", import.meta.url), "utf8");
const executorSkill = await readFile(new URL("../skills/conviction-executor/SKILL.md", import.meta.url), "utf8");
const takeProfitCli = await readFile(new URL("./take-profit-orchestrator.mjs", import.meta.url), "utf8");
const controlledProof = JSON.parse(
  await readFile(new URL("../assets/conviction-review-deliverable.json", import.meta.url), "utf8"),
);
const liveAcceptance = JSON.parse(
  await readFile(new URL("../assets/conviction-live-acceptance-2026-07-22.json", import.meta.url), "utf8"),
);
const signedOpenProof = JSON.parse(
  await readFile(new URL("../assets/conviction-signed-open-proof.json", import.meta.url), "utf8"),
);
const samplePositionCard = JSON.parse(
  await readFile(new URL("../assets/conviction-sample-position-card.json", import.meta.url), "utf8"),
);
const manifest = JSON.parse(
  await readFile(new URL("../manifest.webmanifest", import.meta.url), "utf8"),
);
const socialImageSvg = await readFile(
  new URL("../assets/conviction-og.svg", import.meta.url),
  "utf8",
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
  'id="nav-toggle"',
  'id="primary-navigation"',
  'data-route-view="home"',
  'data-route-view="trade"',
  'data-route-view="manage"',
  'data-route-view="proofs"',
  'data-route-view="wallet"',
  'data-route-view="security"',
  'data-route-view="developers"',
  'id="proof"',
  'id="manage"',
  'id="try"',
  'id="verify"',
  'id="market-form"',
  'id="preview-form"',
  'id="wallet-setup"',
  'id="verification-form"',
  'name="outcome" value="yes"',
  'name="outcome" value="no"',
  "0xf54b4b0deb2f0e53e0c01688eb5a66277177e96af2913d03cbf84d90d7da7313",
]) {
  assert.ok(html.includes(required), `missing required site marker: ${required}`);
}
assert.ok(css.includes("@media (max-width: 560px)"), "missing mobile breakpoint");
assert.ok(
  css.includes("--shell: calc(100% - 28px)"),
  "mobile page shell must use a valid bounded calculation",
);
assert.match(
  css,
  /\.js \.nav-toggle\s*\{[^}]*display:\s*inline-flex/s,
  "mobile navigation toggle is not exposed",
);
assert.match(
  css,
  /\.js \.site-nav\.is-open\s*\{[^}]*visibility:\s*visible/s,
  "mobile navigation cannot be opened",
);
assert.match(
  css,
  /\.js \.site-nav\.is-open\s*\{[^}]*overflow-y:\s*auto/s,
  "open mobile navigation must remain scrollable on short viewports",
);
assert.ok(site.includes('event.key === "Escape"'), "mobile navigation does not close with Escape");
assert.ok(site.includes('navToggle.setAttribute("aria-expanded"'), "mobile navigation does not expose expanded state");
assert.ok(site.includes('window.matchMedia("(max-width: 860px)")'), "mobile navigation does not track its breakpoint");
assert.match(site, /mobileMenu\.addEventListener\("change"[\s\S]*?setMenu\(false\)/, "mobile navigation state is not cleared when leaving its breakpoint");
assert.ok(site.includes("history.pushState"), "product sessions are not connected to history");
assert.ok(site.includes("window.addEventListener(\"popstate\""), "product sessions do not support browser navigation");
assert.ok(
  site.includes('const productionOrigin = "https://conviction-bay.vercel.app"'),
  "route metadata is not pinned to the production origin",
);
assert.doesNotMatch(
  site,
  /new URL\(route\.path, window\.location\.origin\)/,
  "preview or local hosts must not become route canonicals",
);
assert.ok(site.includes('["#try", "trade"]'), "legacy free-preview links do not route to Trade");
assert.ok(site.includes('["#manage", "manage"]'), "legacy manager links do not route to Manage");
assert.ok(site.includes("view.hidden = !active"), "inactive product sessions are not hidden semantically");
assert.ok(css.includes(":focus-visible"), "missing visible focus styling");
assert.ok(css.includes("prefers-reduced-motion"), "missing reduced-motion support");
assert.ok(css.includes("--muted: #5f6964"), "muted text token does not meet AA contrast");
assert.ok(css.includes("--orange: #c23c20"), "accent text token does not meet AA contrast");
assert.ok(app.includes('postJson("/api/market"'), "one-field market lookup is not connected");
assert.ok(app.includes('fetch("/api/wallet-setup"'), "wallet setup scaffold is not connected");
assert.ok(app.includes('BROWSER_SETUP_BETA_READY'), "wallet setup beta is not discoverable in the UI");
assert.ok(app.includes('BROWSER_SETUP_REQUIRES_ACTIVATION'), "wallet setup UI does not fail closed when inactive");
assert.ok(app.includes('BROWSER_SETUP_AUTH_CHECKING'), "wallet setup UI does not expose a retryable Builder authorization state");
assert.ok(app.includes('BROWSER_SETUP_AUTH_UNAVAILABLE'), "wallet setup UI does not fail closed when Builder authorization is unavailable");
assert.ok(
  app.includes('[429, 503].includes(response.status)') && app.includes('response.headers.get("retry-after")'),
  "homepage does not retry temporary wallet-setup rate-limit or capacity responses",
);
assert.ok(
  walletSetupApp.includes('[429, 503].includes(response.status)') && walletSetupApp.includes('response.headers.get("retry-after")'),
  "wallet setup page does not retry temporary wallet-setup rate-limit or capacity responses",
);
assert.match(
  app,
  /if \(scaffold\.status === "BROWSER_SETUP_BETA_READY"\) \{[\s\S]*?scaffold\?\.paymentAllowed !== true[\s\S]*?scaffold\?\.actions\?\.pay !== true[\s\S]*?scaffold\?\.actions\?\.trade !== true[\s\S]*?scaffold\?\.browserSetup\?\.page !== "\/wallet-setup"/,
  "homepage must validate the active wallet-setup contract before exposing its handoff",
);
assert.match(
  app,
  /BROWSER_SETUP_REQUIRES_ACTIVATION[\s\S]*?BROWSER_SETUP_AUTH_CHECKING[\s\S]*?BROWSER_SETUP_AUTH_UNAVAILABLE[\s\S]*?scaffold\.chainWritesAllowed !== false[\s\S]*?scaffold\?\.paymentAllowed !== false[\s\S]*?scaffold\?\.actions\?\.pay !== false[\s\S]*?scaffold\?\.actions\?\.trade !== false/,
  "homepage must render explicit no-write guidance for inactive or Builder-unavailable setup",
);
assert.match(
  walletSetupApp,
  /BROWSER_SETUP_AUTH_CHECKING[\s\S]*?Retrying shortly; do not connect or fund a new wallet here/,
  "wallet setup page must keep browser actions disabled while Builder authorization is checking",
);
assert.match(
  walletSetupApp,
  /BROWSER_SETUP_AUTH_UNAVAILABLE[\s\S]*?Retrying automatically; do not connect or fund a new wallet here/,
  "wallet setup page must retry safely after temporary Builder authorization failure",
);
for (const marker of [
  'src="/assets/browser-open.js"',
  '<section class="setup-card setup-card-wide browser-open" id="browser-open-panel" hidden>',
  '<form class="browser-open-fields" id="browser-open-form">',
  'id="browser-open-form"',
  'id="confirm-open-payment"',
  'id="confirm-open-trade"',
  'id="open-proof-hash"',
]) {
  assert.ok(walletSetupHtml.includes(marker), `browser OPEN UI is missing ${marker}`);
}
assert.ok(
  browserOpenSource.includes("createBrowserX402Client"),
  "browser OPEN does not create a buyer-local x402 authorization",
);
assert.ok(
  browserOpenSource.includes("createSecureClient"),
  "browser OPEN does not use the official Polymarket TypeScript client",
);
assert.ok(walletSetupApp.includes('relay("auth")'), "browser setup does not verify Builder authorization before deployment consent");
assert.match(
  walletSetupHtml,
  /<button[^>]*id="connect-wallet"[^>]*\bdisabled\b[^>]*>/,
  "browser wallet connection must remain disabled until the asynchronous authorization probe succeeds",
);
assert.ok(
  browserOpenSource.indexOf('element("confirm-open-payment")') <
    browserOpenSource.indexOf('element("confirm-open-trade")'),
  "browser OPEN does not preserve payment-before-trade consent order",
);
assert.ok(browserOpenBundle.length > 100_000, "browser OPEN bundle was not built");
const contentSecurityPolicy = vercel.headers
  .flatMap((entry) => entry.headers || [])
  .find((header) => header.key === "Content-Security-Policy")?.value;
assert.match(
  contentSecurityPolicy || "",
  /connect-src 'self' https:\/\/clob\.polymarket\.com https:\/\/polygon\.drpc\.org/,
  "browser OPEN CSP must allow only the official CLOB and SDK Polygon RPC origins",
);
assert.ok(app.includes('postJson("/api/preview"'), "wallet-free preview is not connected");
assert.ok(app.includes('postJson("/api/intent"'), "final compiler UI is not connected to intent API");
assert.ok(app.includes('postJson("/api/receipt"'), "receipt verification is not connected");
assert.ok(app.includes("artifact.issuance"), "receipt verification omits the issuer signature");
assert.ok(app.includes("Select a paid Conviction-issued v4 dossier"), "receipt verifier does not require a paid signed dossier");
assert.doesNotMatch(app, /Create a signed v4 card above or select its issued intent dossier/, "receipt verifier advertises an unusable unsigned-card path");
assert.ok(html.includes('Signed v4 intent dossier <span class="required">Required</span>'), "receipt verifier dossier input is not required");
assert.ok(app.includes('payload.assurance === "issuer-signed"'), "receipt UI does not branch on cryptographic assurance");
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
assert.ok(
  app.includes("OPEN is currently available only to a ready buyer-controlled Polymarket deposit wallet"),
  "handoff omits the current ready-deposit-wallet requirement",
);
assert.ok(
  app.includes("This handoff is not a first-time venue-setup route"),
  "handoff can still be mistaken for a first-time venue-setup route",
);
assert.doesNotMatch(
  app,
  /First-time OPEN can instead use finite EOA mode/i,
  "handoff still advertises the rejected finite-EOA fallback",
);
assert.ok(
  html.includes("OPEN currently requires an already-ready buyer-controlled Polymarket deposit wallet"),
  "landing page omits the current ready-deposit-wallet requirement",
);
assert.ok(
  html.includes("Prepare a dedicated Polymarket Deposit Wallet first."),
  "landing page does not route first-time buyers to setup",
);
assert.ok(
  html.includes("Setup is separate from payment and trading."),
  "landing page does not separate setup from the paid trading journey",
);
assert.doesNotMatch(
  html,
  /finite EOA mode/i,
  "landing page still advertises the rejected finite-EOA fallback",
);
assert.equal(
  html.includes("0x6a355e4971d9ac2ab97d22c3cf361d42faba33fe"),
  false,
  "house wallet must never be prefilled or exposed in the first-user form",
);
for (const required of [
  "Consent 1 of 2",
  "Consent 2 of 2",
  "2 maximum pUSD allowances",
  "3 blanket ERC-1155 operator approvals",
  "This page cannot fund or bridge assets.",
  "it can request an exact Conviction payment and a separate confirmation for one bounded trade.",
  'id="connect-wallet"',
  'id="deploy-wallet"',
  'id="approve-wallet"',
]) {
  assert.ok(walletSetupHtml.includes(required), `missing wallet setup marker: ${required}`);
}
assert.ok(walletSetupApp.includes('method: "personal_sign"'), "wallet setup does not authenticate buyer ownership");
assert.ok(walletSetupApp.includes('method: "eth_signTypedData_v4"'), "wallet setup does not sign the approval batch locally");
assert.ok(walletSetupApp.includes('relay("submit"'), "wallet setup does not use the guarded relayer proxy");
assert.ok(walletSetupApp.includes('action: "deploy_challenge"'), "wallet setup does not request a separate deployment consent");
assert.ok(walletSetupApp.includes('action: "deploy_authorize"'), "wallet setup does not submit the deployment-consent signature");
assert.ok(walletSetupApp.includes('relay("transaction"'), "wallet setup does not poll the bound relayer transaction");
assert.ok(walletSetupApp.includes("approvalAck.checked"), "wallet setup does not require explicit approval acknowledgement");
assert.ok(walletSetupHtml.includes("Do not send pUSD to the connected EOA"), "wallet setup omits the funding-address boundary");
assert.ok(walletSetupCss.includes("@media (max-width: 760px)"), "wallet setup lacks a mobile layout");
assert.equal(
  html.toLowerCase().includes("invade-iran") || html.toLowerCase().includes("invade iran"),
  false,
  "the reviewer-facing page must not default to the geopolitical proof market",
);
assert.equal(/id="market-input"[^>]*\svalue=/.test(html), false, "market input must start empty");
assert.equal(/id="wallet-input"[^>]*\svalue=/.test(html), false, "wallet input must start empty");
assert.ok(
  terms.includes("must not be funded or paid through Conviction until independently ready"),
  "terms do not prohibit funding or payment through an unfinished venue setup",
);
assert.ok(html.includes('href="/privacy.html"'), "footer does not expose privacy terms");
assert.ok(html.includes('href="/terms.html"'), "footer does not expose service terms");
for (const [page, slug, title] of [
  [privacy, "privacy", "Privacy — Conviction"],
  [terms, "terms", "Terms — Conviction"],
]) {
  assert.ok(
    page.includes(`<link rel="canonical" href="https://conviction-bay.vercel.app/${slug}" />`),
    `${title} does not use its final extensionless canonical URL`,
  );
  for (const marker of [
    'property="og:type"',
    `property="og:url" content="https://conviction-bay.vercel.app/${slug}"`,
    `property="og:title" content="${title}"`,
    'property="og:description"',
    'property="og:image"',
    'property="og:image:width" content="1200"',
    'property="og:image:height" content="675"',
    'property="og:image:alt"',
    'name="twitter:card" content="summary_large_image"',
    `name="twitter:title" content="${title}"`,
    'name="twitter:description"',
    'name="twitter:image"',
    'name="twitter:image:alt"',
    'rel="apple-touch-icon"',
    'rel="manifest"',
  ]) {
    assert.ok(page.includes(marker), `${title} is missing launch metadata: ${marker}`);
  }
}
assert.match(privacy, /no application database/i);
assert.match(privacy, /IP-shaped client identifier/i);
assert.match(privacy, /Never submit a seed phrase/i);
assert.match(terms, /ready-to-sign bounded OPEN card/i);
assert.match(terms, /post-only GTD TAKE_PROFIT card/i);
assert.match(terms, /paying 0\.05 or 0\.10 USD₮0 never authorizes a trade/i);
assert.match(terms, /Neither response alone is a fill/i);
for (const [surface, copy] of [
  ["README", readme],
  ["service contract", serviceContract],
  ["listing contract", listingContract],
  ["executor skill", executorSkill],
  ["TAKE_PROFIT CLI", takeProfitCli],
]) {
  assert.match(copy, /zero-match [`]*LIVE[`]*[^\n]*ARMED/i, `${surface} omits the zero-match ARMED path`);
  assert.match(
    copy,
    /first(?: authenticated)?[- ]fetch[^\n]*(?:match|state transition)[^\n]*recoverable/i,
    `${surface} omits the first-fetch recoverable path`,
  );
}
assert.match(readme, /wallet-bound position-card preview/i);
assert.match(readme, /cancel-tp[^\n]*separately requires the exact cancellation confirmation/i);
assert.ok(html.includes("/assets/conviction-sample-position-card.json"), "historical position card is not linked");
assert.ok(html.includes("/assets/conviction-review-deliverable.json"), "controlled proof dossier is not linked");
assert.ok(html.includes("/assets/conviction-live-acceptance-2026-07-22.json"), "live acceptance pack is not linked");
assert.ok(html.includes("/assets/conviction-signed-open-proof.json"), "issuer-signed OPEN proof is not linked");
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
assert.equal(signedOpenProof.assurance, "issuer-signed");
assert.equal(signedOpenProof.intent.version, "conviction-intent-v4");
assert.equal(signedOpenProof.issuance.intentHash, signedOpenProof.intentHash);
assert.equal(sha256(signedOpenProof.intent), signedOpenProof.intentHash);
assert.equal(sha256(signedOpenProof.receiptProof), signedOpenProof.positionProof.receiptHash);
assert.equal(sha256(signedOpenProof.positionProof), signedOpenProof.positionProofHash);
assert.equal(sha256(signedOpenProof.positionPassport), signedOpenProof.positionPassportHash);
assert.ok(Object.values(signedOpenProof.positionProof.checks).every(Boolean));
assert.equal(signedOpenProof.positionProof.checks.marketConditionTokensMatched, true);
assert.equal(liveAcceptance.version, "conviction-live-acceptance-pack-v2");
assert.equal(liveAcceptance.currentProductionVersion, "0.4.9");
assert.equal(liveAcceptance.currentProductionReleaseTag, "v0.4.9");
assert.ok(
  liveAcceptance.limitations.some((item) => /nonzero-fee verification path.*unproven/i.test(item)),
  "live acceptance pack must disclose that a nonzero-fee settlement remains unproven",
);
assert.equal(liveAcceptance.evidenceExecution.nativeOkxHandoffLiveTested, false);
assert.match(liveAcceptance.evidenceExecution.runtime, /repository-backed Conviction buyer orchestrator/);
assert.ok(Object.values(liveAcceptance.gates).every((gate) => gate.verdict === "PASS"));
assert.ok(
  html.includes(signedOpenProof.positionProofHash),
  "issuer-signed OPEN proof hash is not shown",
);
for (const signedHeroMarker of [
  "9.818180 shares",
  "1.079999 pUSD",
  "90,672,458",
  "0x8d45…f2cb",
  "11/11 checks",
]) {
  assert.ok(html.includes(signedHeroMarker), `issuer-signed hero proof is missing ${signedHeroMarker}`);
}
assert.equal(
  html.includes("0x1746d89ea5c08c5edc214fcca3baf5b3bc6ce7b4ea9d02427dd88035cd4373b3"),
  false,
  "legacy v2 receipt hash must not be presented as the current proof",
);
assert.equal(manifest.name, "Conviction");
assert.equal(manifest.start_url, "/");
assert.match(manifest.description, /OPEN and CLOSE fills plus post-only TAKE_PROFIT lifecycle proof/);
assert.ok(manifest.icons.some((icon) => icon.sizes === "192x192"));
assert.ok(manifest.icons.some((icon) => icon.sizes === "512x512"));
assert.match(socialImageSvg, /OPEN\. CLOSE\. TAKE PROFIT\. PROVE EACH STATE\./);
assert.match(socialImageSvg, /a managed position\./);
assert.match(socialImageSvg, /CONTROLLED HOUSE OPEN PROOF \/ 001/);
assert.match(socialImageSvg, /11\/11 SIGNED PROOF CHECKS/);
assert.doesNotMatch(socialImageSvg, /7\/7 RECEIPT CHECKS/);
assert.doesNotMatch(socialImageSvg, /5\/5 RECEIPT CHECKS/);
assert.doesNotMatch(socialImageSvg, /a bounded order\./);
assert.match(css, /--font-sans: ui-sans-serif/);
assert.match(css, /--font-mono: ui-monospace/);
assert.doesNotMatch(css, /Manrope|DM Mono/);
assert.doesNotMatch(socialImageSvg, /Manrope|DM Mono/);
assert.deepEqual(await readPngSize("../assets/conviction-og.png"), { width: 1200, height: 675 });
assert.deepEqual(await readPngSize("../assets/conviction-icon-32.png"), { width: 32, height: 32 });
assert.deepEqual(await readPngSize("../assets/apple-touch-icon.png"), { width: 180, height: 180 });
assert.deepEqual(await readPngSize("../assets/conviction-icon-192.png"), { width: 192, height: 192 });
assert.deepEqual(await readPngSize("../assets/conviction-icon-512.png"), { width: 512, height: 512 });
assert.match(robots, /User-agent: \*/);
assert.match(robots, /Allow: \//);
const spaRewrite = vercel.rewrites.find((rewrite) => rewrite.destination === "/index.html");
assert.match(spaRewrite?.source || "", /robots/);
assert.match(spaRewrite?.source || "", /manifest/);
assert.match(spaRewrite?.source || "", /site\.js/);
assert.deepEqual(
  vercel.rewrites.filter((rewrite) => rewrite.destination.startsWith("/api/readiness?walletRoute=")).map((rewrite) => [rewrite.source, rewrite.destination]),
  [
    ["/api/wallet-setup", "/api/readiness?walletRoute=setup"],
    ["/api/wallet-session", "/api/readiness?walletRoute=session"],
    ["/api/wallet-relayer", "/api/readiness?walletRoute=relayer"],
  ],
  "browser setup routes must share the existing readiness function on Hobby",
);
assert.deepEqual(vercel.regions, ["sin1"], "serverless APIs must avoid a US payment region");

console.log("site verification passed: metadata, icons, robots, proof, compiler, mobile, and accessibility markers present");
