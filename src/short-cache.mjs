function positiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${label} must be a positive safe integer`);
  }
  return value;
}

export function createShortCache({ ttlMs = 3_000, maxEntries = 256, now = Date.now } = {}) {
  positiveInteger(ttlMs, "ttlMs");
  positiveInteger(maxEntries, "maxEntries");
  if (typeof now !== "function") throw new TypeError("now must be a function");

  const entries = new Map();

  function prune(currentTime) {
    for (const [key, entry] of entries) {
      if (!entry.promise && entry.expiresAt <= currentTime) entries.delete(key);
    }
    while (entries.size >= maxEntries) {
      const settled = [...entries].find(([, entry]) => !entry.promise);
      if (!settled) break;
      entries.delete(settled[0]);
    }
  }

  async function get(key, loader) {
    if (typeof key !== "string" || !key) throw new TypeError("cache key must be a non-empty string");
    if (typeof loader !== "function") throw new TypeError("cache loader must be a function");
    const currentTime = now();
    const existing = entries.get(key);
    if (existing?.promise) return existing.promise;
    if (existing && existing.expiresAt > currentTime) {
      entries.delete(key);
      entries.set(key, existing);
      return existing.value;
    }
    if (existing) entries.delete(key);

    prune(currentTime);

    const promise = Promise.resolve().then(loader);
    const cacheable = entries.size < maxEntries;
    if (cacheable) entries.set(key, { promise });
    try {
      const value = await promise;
      if (cacheable && entries.get(key)?.promise === promise) {
        entries.set(key, { value, expiresAt: now() + ttlMs });
      }
      return value;
    } catch (error) {
      if (cacheable && entries.get(key)?.promise === promise) entries.delete(key);
      throw error;
    }
  }

  return { get };
}
