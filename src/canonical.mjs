import { createHash } from "node:crypto";

function normalize(value) {
  if (Array.isArray(value)) return value.map(normalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, normalize(value[key])]),
    );
  }
  return value;
}

export function assertCanonicalSigningValue(value, seen = new Set()) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) throw new TypeError("Signed JSON numbers must be safe integers");
    return;
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) throw new TypeError("Signed JSON cannot contain cycles");
    if (Object.keys(value).length !== value.length) throw new TypeError("Signed JSON arrays must be dense");
    seen.add(value);
    for (const entry of value) assertCanonicalSigningValue(entry, seen);
    seen.delete(value);
    return;
  }
  if (value && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    if (seen.has(value)) throw new TypeError("Signed JSON cannot contain cycles");
    seen.add(value);
    for (const entry of Object.values(value)) assertCanonicalSigningValue(entry, seen);
    seen.delete(value);
    return;
  }
  throw new TypeError(`Unsupported signed JSON value: ${typeof value}`);
}

export function canonicalJson(value) {
  return JSON.stringify(normalize(value));
}

export function sha256(value) {
  const body = typeof value === "string" ? value : canonicalJson(value);
  return `0x${createHash("sha256").update(body).digest("hex")}`;
}
