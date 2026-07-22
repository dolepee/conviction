import { ConvictionError, invariant } from "./errors.mjs";

export function parseDecimal(value, decimals, label) {
  const text = String(value).trim();
  const match = /^(0|[1-9]\d*)(?:\.(\d+))?$/.exec(text);
  invariant(match, "invalid_decimal", `${label} must be a positive decimal`, {
    label,
    value,
  });
  const fraction = match[2] || "";
  invariant(
    fraction.length <= decimals,
    "too_many_decimals",
    `${label} supports at most ${decimals} decimal places`,
    { label, value, decimals },
  );
  return (
    BigInt(match[1]) * 10n ** BigInt(decimals) +
    BigInt((fraction + "0".repeat(decimals)).slice(0, decimals))
  );
}

export function formatDecimal(rawValue, decimals) {
  const raw = BigInt(rawValue);
  const negative = raw < 0n;
  const absolute = negative ? -raw : raw;
  const scale = 10n ** BigInt(decimals);
  const whole = absolute / scale;
  const fraction = String(absolute % scale)
    .padStart(decimals, "0")
    .replace(/0+$/, "");
  const formatted = fraction ? `${whole}.${fraction}` : String(whole);
  return negative ? `-${formatted}` : formatted;
}

export function parseHexUint(value, label = "hex value") {
  if (typeof value !== "string" || !/^0x[0-9a-f]+$/i.test(value)) {
    throw new ConvictionError("invalid_hex", `${label} is not valid hex`, {
      value,
    });
  }
  return BigInt(value);
}
