import { cp, mkdir, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const output = fileURLToPath(new URL("../public/", import.meta.url));
const files = [
  "app.js",
  "index.html",
  "manifest.webmanifest",
  "privacy.html",
  "robots.txt",
  "site.js",
  "styles.css",
  "terms.html",
  "wallet-setup.css",
  "wallet-setup.html",
  "wallet-setup.js",
];

await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
await Promise.all([
  ...files.map((file) => cp(`${root}${file}`, `${output}${file}`)),
  cp(`${root}assets`, `${output}assets`, { recursive: true }),
]);
