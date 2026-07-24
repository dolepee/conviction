import { SERVICE_ASSET, SERVICE_NETWORK, SERVICE_PAYEE } from "../src/service-constants.mjs";

export default function handler(request, response) {
  if (!["GET", "HEAD"].includes(request.method)) {
    response.setHeader("allow", "GET, HEAD");
    return response.status(405).json({ ok: false, error: { code: "method_not_allowed" } });
  }
  response.setHeader("cache-control", "no-store");
  return response.status(200).json({
    ok: true,
    product: "Conviction",
    version: "0.4.21",
    execution: "non-custodial",
    executorDiscovery: "/api/executor",
    buyerReadiness: "/api/readiness",
    openCardRefresh: "/api/refresh",
    payment: {
      network: SERVICE_NETWORK,
      asset: SERVICE_ASSET,
      payee: SERVICE_PAYEE,
      selfPaymentAllowed: false,
    },
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
    firstUse: {
      depositWalletSetupMayBeRequired: true,
      finiteEoaOpenAvailable: false,
      finiteEoaOpenStatus: "disabled-after-live-maker-rejection",
      approvalModel: "Only already-ready buyer-controlled deposit wallets are chargeable; new setup uses 2 reusable pUSD allowances + 3 reusable CTF operator approvals",
      convictionCanBypassWalletPolicy: false,
    },
  });
}
