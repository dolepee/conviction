import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
const css = await readFile(new URL("../styles.css", import.meta.url), "utf8");
const app = await readFile(new URL("../app.js", import.meta.url), "utf8");
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
  'id="compile"',
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
assert.ok(app.includes('fetch("/api/intent"'), "compiler UI is not connected to intent API");
assert.ok(app.includes('setAttribute("aria-invalid", "true")'), "invalid fields are not identified");
assert.ok(app.includes('setAttribute("aria-errormessage", "form-status")'), "field errors are not associated with status text");
assert.ok(app.includes('setAttribute("aria-describedby", "form-status")'), "field errors lack a broadly supported description");
assert.ok(app.includes("intent.exposure.maximumLoss"), "compiler UI does not render exposure");
assert.ok(app.includes("intent.order.maximumOrderPrincipal"), "compiler UI does not render order principal");
assert.ok(app.includes("intent.exposure.maximumFee"), "compiler UI does not render the venue-fee reserve");
assert.ok(html.includes("Total risk budget, fees included"), "compiler form does not label the fee-inclusive budget");
assert.ok(app.includes('id="download-dossier"'), "compiler UI does not expose the intent dossier");
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
