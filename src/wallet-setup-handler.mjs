import { walletSetupScaffold } from "./wallet-setup-scaffold.mjs";
export { browserSetupConfigured } from "./wallet-setup-config.mjs";
import { browserSetupConfigured } from "./wallet-setup-config.mjs";

export function createWalletSetupHandler({
  scaffold = walletSetupScaffold,
  configured = browserSetupConfigured(),
} = {}) {
  return function handler(request, response) {
    if (!["GET", "HEAD"].includes(request.method)) {
      response.setHeader("allow", "GET, HEAD");
      return response.status(405).json({ ok: false, error: { code: "method_not_allowed" } });
    }
    response.setHeader("cache-control", "no-store");
    response.setHeader("content-type", "application/json; charset=utf-8");
    if (request.method === "HEAD") return response.status(200).end();
    return response.status(200).json(scaffold({ configured }));
  };
}
