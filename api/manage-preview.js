import { compileClosePreview } from "../src/exit-intent-compiler.mjs";
import { compileTakeProfitPreview } from "../src/take-profit-intent-compiler.mjs";
import { ConvictionError } from "../src/errors.mjs";
import { trustedIssuerRegistryFromEnvironment } from "../src/intent-issuer.mjs";
import { resolveMarket } from "../src/market-client.mjs";
import { fetchPositionSnapshot } from "../src/position-client.mjs";
import { createPublicApiGuard, PublicApiError } from "../src/public-api-guard.mjs";
import { verifySourcePosition } from "../src/source-position.mjs";

function send(response, status, body) {
  response.status(status).setHeader("content-type", "application/json; charset=utf-8");
  response.setHeader("cache-control", "no-store");
  response.end(JSON.stringify(body));
}

function normalizeManagerAction(value) {
  const action = String(value || "close").trim().toUpperCase();
  if (action !== "CLOSE" && action !== "TAKE_PROFIT") {
    throw new ConvictionError(
      "unsupported_manager_action",
      "action must be CLOSE or TAKE_PROFIT",
    );
  }
  return action;
}

export function createManagePreviewHandler({
  environment = process.env,
  trustedIssuers = undefined,
  resolveMarketImpl = resolveMarket,
  verifySourceImpl = verifySourcePosition,
  fetchPositionImpl = fetchPositionSnapshot,
  publicGuard = createPublicApiGuard({ limit: 10, maxBodyBytes: 65_536, maxInFlight: 4 }),
  compileOptions = { maxSnapshotAgeMs: 30_000, quoteTtlMs: 300_000 },
} = {}) {
  let trusted = trustedIssuers;
  if (!trusted) {
    try { trusted = trustedIssuerRegistryFromEnvironment(environment); } catch { trusted = new Map(); }
  }
  return async function managePreviewHandler(request, response) {
    if (request.method !== "POST") {
      response.setHeader("allow", "POST");
      return send(response, 405, { ok: false, error: { code: "method_not_allowed" } });
    }
    try {
      const body = request.body && typeof request.body === "object" ? request.body : {};
      const result = await publicGuard.run(request, async () => {
        const action = normalizeManagerAction(body.action);
        const [market, source] = await Promise.all([
          resolveMarketImpl(body.market, { outcome: body.outcome }),
          verifySourceImpl(body.sourcePosition, { trustedIssuers: trusted }),
        ]);
        const position = await fetchPositionImpl(body.wallet, market.outcomeTokenId);
        const compilePreview = action === "TAKE_PROFIT" ? compileTakeProfitPreview : compileClosePreview;
        return compilePreview({ ...body, action, source }, market, position, compileOptions);
      });
      return send(response, 200, result);
    } catch (error) {
      if (error instanceof PublicApiError) {
        if (error.details?.retryAfterSeconds) response.setHeader("retry-after", String(error.details.retryAfterSeconds));
        return send(response, error.status, { ok: false, error: { code: error.code, message: error.message, details: error.details } });
      }
      if (error instanceof ConvictionError) {
        const upstream = ["market_api_error", "rpc_error"].includes(error.code);
        return send(response, upstream ? 502 : 422, { ok: false, error: { code: error.code, message: error.message, details: error.details } });
      }
      console.error("manage preview handler failed", { name: error?.name, code: error?.code });
      return send(response, 500, { ok: false, error: { code: "internal_error", message: "Position-manager preview failed" } });
    }
  };
}

export default createManagePreviewHandler();
