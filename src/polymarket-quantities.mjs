import { invariant } from "./errors.mjs";

export const POLYMARKET_SHARE_DECIMALS = 6;

const CANONICAL_UINT_RE = /^(?:0|[1-9][0-9]*)$/;
const CANONICAL_DECIMAL_RE = /^(0|[1-9][0-9]*)(?:\.([0-9]{1,6}))?$/;
const SHARE_SCALE = 10n ** BigInt(POLYMARKET_SHARE_DECIMALS);
const UINT256_MAX = (1n << 256n) - 1n;

/**
 * Parse an already-normalized internal share quantity in atomic units.
 *
 * This parser is intentionally distinct from the authenticated CLOB response
 * parser below. Conviction normalizes venue share decimals to six-decimal raw
 * units once, at ingress, and carries canonical integer strings internally.
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

/**
 * Parse a share quantity returned by the authenticated Polymarket CLOB.
 *
 * CLOB order/trade fields such as `original_size`, `size_matched`, `size`, and
 * `matched_amount` are decimal share strings: for example, `"5"` means five
 * shares and `"5.25"` means five and one-quarter shares. Convert exactly once
 * to Conviction's six-decimal atomic representation. Reject numbers, exponent
 * notation, whitespace, signs, leading zeroes, and excess precision so no
 * caller can cross the venue/internal unit boundary ambiguously.
 */
export function parsePolymarketClobShares(value, label, {
  code = "invalid_polymarket_share_quantity",
  positive = false,
} = {}) {
  const match = typeof value === "string" && value.length <= 79
    ? CANONICAL_DECIMAL_RE.exec(value)
    : null;
  invariant(match, code, `${label} must be a canonical decimal share string`, {
    label,
    value,
  });
  const fraction = match[2] || "";
  const raw = (
    BigInt(match[1]) * SHARE_SCALE +
    BigInt((fraction + "0".repeat(POLYMARKET_SHARE_DECIMALS)).slice(0, POLYMARKET_SHARE_DECIMALS))
  );
  invariant(raw <= UINT256_MAX, code, `${label} exceeds uint256`, { label, value });
  invariant(!positive || raw > 0n, code, `${label} must be positive`, { label, value });
  return raw;
}
