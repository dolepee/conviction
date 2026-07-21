import { isIP } from "node:net";

export class PublicApiError extends Error {
  constructor(status, code, message, details = undefined) {
    super(message);
    this.name = "PublicApiError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

function header(request, name) {
  const headers = request?.headers;
  if (!headers) return "";
  if (typeof headers.get === "function") return String(headers.get(name) || "");
  const key = Object.keys(headers).find((candidate) => candidate.toLowerCase() === name.toLowerCase());
  const value = key ? headers[key] : "";
  return Array.isArray(value) ? value[0] || "" : String(value || "");
}

function clientId(request) {
  for (const candidate of [
    header(request, "x-vercel-forwarded-for").split(",")[0]?.trim(),
    header(request, "x-forwarded-for").split(",")[0]?.trim(),
    header(request, "x-real-ip").trim(),
    request?.socket?.remoteAddress,
  ]) {
    if (candidate && isIP(candidate)) return candidate;
  }
  return "unknown";
}

function positiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${label} must be a positive safe integer`);
  }
  return value;
}

export function createPublicApiGuard({
  limit = 30,
  windowMs = 60_000,
  maxBodyBytes = 8_192,
  maxMarketLength = 512,
  maxInFlight = 8,
  maxClients = 5_000,
  now = Date.now,
} = {}) {
  positiveInteger(limit, "limit");
  positiveInteger(windowMs, "windowMs");
  positiveInteger(maxBodyBytes, "maxBodyBytes");
  positiveInteger(maxMarketLength, "maxMarketLength");
  positiveInteger(maxInFlight, "maxInFlight");
  positiveInteger(maxClients, "maxClients");
  if (typeof now !== "function") throw new TypeError("now must be a function");

  const buckets = new Map();
  let inFlight = 0;

  function makeBucket(id, currentTime) {
    if (!buckets.has(id) && buckets.size >= maxClients) {
      for (const [key, value] of buckets) {
        if (value.resetAt <= currentTime) buckets.delete(key);
      }
      while (buckets.size >= maxClients) {
        buckets.delete(buckets.keys().next().value);
      }
    }
    const bucket = { count: 1, resetAt: currentTime + windowMs };
    buckets.set(id, bucket);
    return bucket;
  }

  function inspect(request) {
    const contentLengthHeader = header(request, "content-length").trim();
    const contentLength = Number(contentLengthHeader || "0");
    if (contentLengthHeader && (!/^\d+$/.test(contentLengthHeader) || !Number.isSafeInteger(contentLength))) {
      throw new PublicApiError(400, "invalid_content_length", "Content-Length must be a non-negative integer");
    }
    if (contentLength > maxBodyBytes) {
      throw new PublicApiError(413, "payload_too_large", `Request body exceeds ${maxBodyBytes} bytes`);
    }
    const body = request?.body && typeof request.body === "object" ? request.body : {};
    let encodedLength;
    try {
      encodedLength = Buffer.byteLength(JSON.stringify(body) || "", "utf8");
    } catch {
      throw new PublicApiError(400, "invalid_json", "Request body must be valid JSON data");
    }
    if (encodedLength > maxBodyBytes) {
      throw new PublicApiError(413, "payload_too_large", `Request body exceeds ${maxBodyBytes} bytes`);
    }
    if (Buffer.byteLength(String(body.market || ""), "utf8") > maxMarketLength) {
      throw new PublicApiError(422, "invalid_market_reference", "market reference is too long");
    }

    const currentTime = now();
    const id = clientId(request);
    const bucket = buckets.get(id);
    if (!bucket || bucket.resetAt <= currentTime) {
      makeBucket(id, currentTime);
    } else {
      if (bucket.count >= limit) {
        const retryAfterSeconds = Math.max(1, Math.ceil((bucket.resetAt - currentTime) / 1_000));
        throw new PublicApiError(429, "rate_limited", "Too many public preview requests", {
          retryAfterSeconds,
        });
      }
      bucket.count += 1;
    }
    if (inFlight >= maxInFlight) {
      throw new PublicApiError(
        503,
        "preview_capacity_reached",
        "Public preview capacity is temporarily full",
        { retryAfterSeconds: 1 },
      );
    }
  }

  async function run(request, task) {
    inspect(request);
    inFlight += 1;
    try {
      return await task();
    } finally {
      inFlight -= 1;
    }
  }

  return { run };
}
