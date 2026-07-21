export default function handler(request, response) {
  if (!["GET", "HEAD"].includes(request.method)) {
    response.setHeader("allow", "GET, HEAD");
    return response.status(405).json({ ok: false, error: { code: "method_not_allowed" } });
  }
  response.setHeader("cache-control", "no-store");
  return response.status(200).json({
    ok: true,
    product: "Conviction",
    version: "0.3.4",
    execution: "non-custodial",
    supported: { venue: "Polymarket", clob: "V2", outcomes: ["YES", "NO"], orderType: "FAK" },
  });
}
