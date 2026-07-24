import { walletSetupStateEnvironment } from "./wallet-setup-config.mjs";

const STORE_VERSION = "conviction-wallet-setup-state-v1";
const KEY_PART_RE = /^[a-z0-9][a-z0-9._:-]{0,511}$/i;

export class WalletSetupStateError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = "WalletSetupStateError";
    this.status = status;
    this.code = code;
  }
}

function positiveSeconds(value, name) {
  if (!Number.isSafeInteger(value) || value <= 0 || value > 86_400) {
    throw new TypeError(`${name} must be a positive safe integer no greater than one day`);
  }
  return value;
}

function part(value, name) {
  if (typeof value !== "string" || !KEY_PART_RE.test(value)) {
    throw new WalletSetupStateError(422, "invalid_wallet_setup_state", `${name} is invalid`);
  }
  return value;
}

function key(prefix, namespace, id) {
  return `${prefix}:${part(namespace, "State namespace")}:${part(id, "State identifier")}`;
}

function parseStored(value) {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string" || value.length > 16_384) {
    throw new WalletSetupStateError(503, "wallet_setup_state_unavailable", "Wallet setup state is unavailable");
  }
  try {
    return JSON.parse(value);
  } catch {
    throw new WalletSetupStateError(503, "wallet_setup_state_unavailable", "Wallet setup state is unavailable");
  }
}

export function createInMemoryWalletSetupState({ now = Date.now, prefix = STORE_VERSION } = {}) {
  if (typeof now !== "function") throw new TypeError("now must be a function");
  const values = new Map();

  function active(storeKey) {
    const entry = values.get(storeKey);
    if (entry && entry.expiresAt <= now()) {
      values.delete(storeKey);
      return null;
    }
    return entry || null;
  }

  return Object.freeze({
    durable: false,
    async claimOnce(namespace, id, ttlSeconds) {
      const storeKey = key(prefix, namespace, id);
      positiveSeconds(ttlSeconds, "ttlSeconds");
      if (active(storeKey)) return false;
      values.set(storeKey, { value: "1", expiresAt: now() + (ttlSeconds * 1_000) });
      return true;
    },
    async put(namespace, id, value, ttlSeconds) {
      const storeKey = key(prefix, namespace, id);
      positiveSeconds(ttlSeconds, "ttlSeconds");
      const serialized = JSON.stringify(value);
      if (Buffer.byteLength(serialized, "utf8") > 16_384) {
        throw new WalletSetupStateError(422, "invalid_wallet_setup_state", "Wallet setup state is too large");
      }
      values.set(storeKey, { value: serialized, expiresAt: now() + (ttlSeconds * 1_000) });
    },
    async get(namespace, id) {
      const entry = active(key(prefix, namespace, id));
      return entry ? parseStored(entry.value) : null;
    },
  });
}

function redisConfig({ url, token }) {
  let endpoint;
  try {
    endpoint = new URL(url);
  } catch {
    throw new WalletSetupStateError(503, "wallet_setup_state_unavailable", "Persistent wallet setup state is not configured");
  }
  if (endpoint.protocol !== "https:" || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
    throw new WalletSetupStateError(503, "wallet_setup_state_unavailable", "Persistent wallet setup state is not configured");
  }
  if (typeof token !== "string" || token.length < 16 || token.length > 4_096) {
    throw new WalletSetupStateError(503, "wallet_setup_state_unavailable", "Persistent wallet setup state is not configured");
  }
  return { endpoint: endpoint.toString().replace(/\/$/, ""), token };
}

export function createRedisWalletSetupState({
  url,
  token,
  fetchImpl = fetch,
  prefix = STORE_VERSION,
} = {}) {
  const config = redisConfig({ url, token });
  if (typeof fetchImpl !== "function") throw new TypeError("fetchImpl must be a function");

  async function command(parts) {
    let response;
    try {
      response = await fetchImpl(config.endpoint, {
        method: "POST",
        headers: {
          authorization: `Bearer ${config.token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(parts),
        redirect: "error",
        signal: AbortSignal.timeout(5_000),
      });
    } catch {
      throw new WalletSetupStateError(503, "wallet_setup_state_unavailable", "Wallet setup state is temporarily unavailable");
    }
    let body;
    try {
      body = await response.json();
    } catch {
      throw new WalletSetupStateError(503, "wallet_setup_state_unavailable", "Wallet setup state is temporarily unavailable");
    }
    if (!response.ok || body?.error || !("result" in (body || {}))) {
      throw new WalletSetupStateError(503, "wallet_setup_state_unavailable", "Wallet setup state is temporarily unavailable");
    }
    return body.result;
  }

  return Object.freeze({
    durable: true,
    async claimOnce(namespace, id, ttlSeconds) {
      positiveSeconds(ttlSeconds, "ttlSeconds");
      const result = await command(["SET", key(prefix, namespace, id), "1", "NX", "EX", String(ttlSeconds)]);
      return result === "OK";
    },
    async put(namespace, id, value, ttlSeconds) {
      positiveSeconds(ttlSeconds, "ttlSeconds");
      const serialized = JSON.stringify(value);
      if (Buffer.byteLength(serialized, "utf8") > 16_384) {
        throw new WalletSetupStateError(422, "invalid_wallet_setup_state", "Wallet setup state is too large");
      }
      const result = await command(["SET", key(prefix, namespace, id), serialized, "EX", String(ttlSeconds)]);
      if (result !== "OK") {
        throw new WalletSetupStateError(503, "wallet_setup_state_unavailable", "Wallet setup state is temporarily unavailable");
      }
    },
    async get(namespace, id) {
      return parseStored(await command(["GET", key(prefix, namespace, id)]));
    },
  });
}

export function createWalletSetupStateFromEnvironment(environment = process.env) {
  const state = walletSetupStateEnvironment(environment);
  return createRedisWalletSetupState({
    url: state.url,
    token: state.token,
  });
}
