import { executorDiscoveryDocument } from "../src/executor-discovery.mjs";

export default function handler(request, response) {
  if (!["GET", "HEAD"].includes(request.method)) {
    response.setHeader("allow", "GET, HEAD");
    return response.status(405).json({ ok: false, error: { code: "method_not_allowed" } });
  }
  response.setHeader("cache-control", "public, max-age=300, immutable");
  response.setHeader("content-type", "application/json; charset=utf-8");
  return response.status(200).json(executorDiscoveryDocument());
}
