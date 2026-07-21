import { invariant } from "./errors.mjs";

export const POLYMARKET_SHARE_DECIMALS = 6;

const CANONICAL_UINT_RE = /^(?:0|[1-9][0-9]*)$/;
const UINT256_MAX = (1n << 256n) - 1n;

/**
 * Parse a Polymarket CLOB share quantity.
 *
 * V2 order and trade payloads encode `original_size`, `size_matched`, `size`,
 * and `matched_amount` as canonical atomic integer strings with six share
 * decimals. They are not human decimal share strings. Accepting numbers,
 * decimal points, exponent notation, whitespace, or leading zeroes would make
 * the unit ambiguous, so this boundary rejects all of them.
 */
export function parsePolymarketShareAtoms(value, label, {
  code = "invalid_polymarket_share_quantity",
  positive = false,
} = {}) {
  invariant(
    typeof value === "string" && value.length <= 78 && CANONICAL_UINT_RE.test(value),
    code,
    `${label} must be a canonical atomic share integer string`,
    { label, value },
  );
  const raw = BigInt(value);
  invariant(raw <= UINT256_MAX, code, `${label} exceeds uint256`, { label, value });
  invariant(!positive || raw > 0n, code, `${label} must be positive`, { label, value });
  return raw;
}
