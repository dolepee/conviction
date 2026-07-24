function present(value) {
  return typeof value === "string" && value.trim().length > 0;
}

// This returns server-only values for relayer construction. Callers must never
// serialize the result into an HTTP response, card, log, or browser bundle.
export function builderCredentialsFromEnvironment(environment = process.env) {
  const key = environment.POLYMARKET_BUILDER_API_KEY;
  const secret = environment.POLYMARKET_BUILDER_SECRET;
  const passphrase = environment.POLYMARKET_BUILDER_PASSPHRASE;
  if (![key, secret, passphrase].every(present)) return undefined;
  return Object.freeze({
    key: key.trim(),
    secret: secret.trim(),
    passphrase: passphrase.trim(),
  });
}
