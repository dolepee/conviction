export default function handler(request, response) {
  if (!["GET", "HEAD"].includes(request.method)) {
    response.setHeader("allow", "GET, HEAD");
    return response.status(405).json({ ok: false, error: { code: "method_not_allowed" } });
  }
  response.setHeader("cache-control", "no-store");
  return response.status(200).json({
    ok: true,
    product: "Conviction",
    version: "0.4.8",
    execution: "non-custodial",
    executorDiscovery: "/api/executor",
    products: [
      { name: "OPEN", price: "0.05 USD₮0", path: "/api/service" },
      { name: "POSITION_MANAGER", price: "0.10 USD₮0", path: "/api/manage", actions: ["CLOSE", "TAKE_PROFIT"] },
    ],
    supported: {
      venue: "Polymarket",
      clob: "V2",
      outcomes: ["YES", "NO"],
      actions: ["OPEN", "CLOSE", "TAKE_PROFIT"],
      orderTypes: ["FAK", "FOK", "GTD"],
    },
  });
}
