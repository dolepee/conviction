function httpsEndpoint(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password && !url.search && !url.hash;
  } catch {
    return false;
  }
}

export function walletSetupStateEnvironment(environment = process.env) {
  const explicitUrl = environment.CONVICTION_WALLET_STATE_REST_URL;
  const explicitToken = environment.CONVICTION_WALLET_STATE_REST_TOKEN;
  const hasExplicitUrl = typeof explicitUrl === "string" && explicitUrl.length > 0;
  const hasExplicitToken = typeof explicitToken === "string" && explicitToken.length > 0;

  // Explicit state configuration is an inseparable credential pair. Never
  // combine one stale/custom override with the other half of Vercel's KV pair.
  if (hasExplicitUrl || hasExplicitToken) {
    return Object.freeze({
      url: hasExplicitUrl && hasExplicitToken ? explicitUrl : undefined,
      token: hasExplicitUrl && hasExplicitToken ? explicitToken : undefined,
    });
  }

  return Object.freeze({
    url: environment.KV_REST_API_URL,
    token: environment.KV_REST_API_TOKEN,
  });
}

// Browser wallet setup must be all-or-nothing.  The same predicate gates the
// informational endpoint and every server-side session/relayer operation.
export function browserSetupConfigured(environment = process.env) {
  const state = walletSetupStateEnvironment(environment);
  const hasBuilderCredentials =
    typeof environment.POLYMARKET_BUILDER_API_KEY === "string" && environment.POLYMARKET_BUILDER_API_KEY.trim().length > 0 &&
    typeof environment.POLYMARKET_BUILDER_SECRET === "string" && environment.POLYMARKET_BUILDER_SECRET.trim().length > 0 &&
    typeof environment.POLYMARKET_BUILDER_PASSPHRASE === "string" && environment.POLYMARKET_BUILDER_PASSPHRASE.trim().length > 0;
  const hasRelayerCredentials =
    typeof environment.POLYMARKET_RELAYER_API_KEY === "string" && environment.POLYMARKET_RELAYER_API_KEY.trim().length > 0 &&
    typeof environment.POLYMARKET_RELAYER_API_KEY_ADDRESS === "string" &&
    /^0x[0-9a-fA-F]{40}$/.test(environment.POLYMARKET_RELAYER_API_KEY_ADDRESS);
  return Boolean(
    typeof environment.CONVICTION_WALLET_SESSION_SECRET === "string" &&
    Buffer.byteLength(environment.CONVICTION_WALLET_SESSION_SECRET, "utf8") >= 32 &&
    (hasBuilderCredentials || hasRelayerCredentials) &&
    httpsEndpoint(state.url) &&
    typeof state.token === "string" && state.token.length >= 16 &&
    httpsEndpoint(environment.CONVICTION_POLYGON_RPC_URL)
  );
}
