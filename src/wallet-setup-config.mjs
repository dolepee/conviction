function httpsEndpoint(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password && !url.search && !url.hash;
  } catch {
    return false;
  }
}

// Browser wallet setup must be all-or-nothing.  The same predicate gates the
// informational endpoint and every server-side session/relayer operation.
export function browserSetupConfigured(environment = process.env) {
  return Boolean(
    typeof environment.CONVICTION_WALLET_SESSION_SECRET === "string" &&
    Buffer.byteLength(environment.CONVICTION_WALLET_SESSION_SECRET, "utf8") >= 32 &&
    typeof environment.POLYMARKET_BUILDER_API_KEY === "string" && environment.POLYMARKET_BUILDER_API_KEY.length > 0 &&
    typeof environment.POLYMARKET_BUILDER_SECRET === "string" && environment.POLYMARKET_BUILDER_SECRET.length > 0 &&
    typeof environment.POLYMARKET_BUILDER_PASSPHRASE === "string" && environment.POLYMARKET_BUILDER_PASSPHRASE.length > 0 &&
    httpsEndpoint(environment.CONVICTION_WALLET_STATE_REST_URL) &&
    typeof environment.CONVICTION_WALLET_STATE_REST_TOKEN === "string" && environment.CONVICTION_WALLET_STATE_REST_TOKEN.length >= 16 &&
    httpsEndpoint(environment.CONVICTION_POLYGON_RPC_URL)
  );
}
