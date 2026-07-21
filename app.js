const form = document.querySelector("#intent-form");
const empty = document.querySelector("#compiled-empty");
const result = document.querySelector("#compiled-result");
const status = document.querySelector("#form-status");

const fieldNamesByErrorCode = {
  missing_market: ["market"],
  unsupported_market_host: ["market"],
  invalid_market_reference: ["market"],
  market_not_found: ["market"],
  market_api_error: ["market"],
  invalid_market_data: ["market"],
  market_source_mismatch: ["market"],
  unsupported_outcomes: ["market"],
  unsupported_market: ["market"],
  unsupported_clob_version: ["market"],
  invalid_market: ["market"],
  inactive_market: ["market"],
  closed_market: ["market"],
  orders_disabled: ["market"],
  unsupported_neg_risk: ["market"],
  empty_orderbook: ["market"],
  invalid_snapshot: ["market"],
  stale_snapshot: ["market"],
  invalid_market_fee: ["market"],
  invalid_orderbook: ["market"],
  unsupported_outcome: ["outcome"],
  outcome_snapshot_mismatch: ["outcome"],
  invalid_wallet: ["wallet"],
  invalid_rationale: ["rationale"],
  amount_below_floor: ["spend"],
  marketable_order_below_minimum: ["spend"],
  budget_calculation_error: ["spend"],
  insufficient_bounded_liquidity: ["spend", "maxPrice"],
  invalid_price: ["maxPrice"],
  price_tick_mismatch: ["maxPrice"],
  limit_below_best_ask: ["maxPrice"],
};

document.querySelector("#year").textContent = String(new Date().getFullYear());

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function shortAddress(value) {
  return `${value.slice(0, 8)}…${value.slice(-6)}`;
}

function controlsForField(name) {
  return [...form.querySelectorAll(`[name="${name}"]`)];
}

function clearFieldErrors() {
  for (const control of form.querySelectorAll('[aria-invalid="true"]')) {
    control.removeAttribute("aria-invalid");
    control.removeAttribute("aria-errormessage");
    control.removeAttribute("aria-describedby");
  }
}

function fieldsForError(error) {
  if (["invalid_decimal", "too_many_decimals"].includes(error.code)) {
    if (error.details?.label === "spend") return ["spend"];
    if (error.details?.label === "maxPrice") return ["maxPrice"];
    return ["market"];
  }
  return fieldNamesByErrorCode[error.code] || [];
}

function markFieldErrors(error) {
  const controls = fieldsForError(error).flatMap(controlsForField);
  for (const control of controls) {
    control.setAttribute("aria-invalid", "true");
    control.setAttribute("aria-errormessage", "form-status");
    control.setAttribute("aria-describedby", "form-status");
  }
  controls.find((control) => control.checked)?.focus();
  if (!controls.some((control) => document.activeElement === control)) {
    controls[0]?.focus();
  }
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  clearFieldErrors();
  const button = form.querySelector("button[type=submit]");
  const data = Object.fromEntries(new FormData(form));
  button.disabled = true;
  form.setAttribute("aria-busy", "true");
  button.textContent = "Resolving live market…";
  status.textContent = `Reading the canonical market and live ${data.outcome.toUpperCase()} order book.`;
  try {
    const response = await fetch("/api/intent", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(data),
    });
    const body = await response.json();
    if (!response.ok || !body.ok) {
      const failure = new Error(body.error?.message || "Intent could not be compiled");
      failure.code = body.error?.code;
      failure.details = body.error?.details;
      throw failure;
    }
    const { intent, intentHash } = body;
    const outcome = intent.order.outcome;
    empty.hidden = true;
    result.hidden = false;
    result.innerHTML = `
      <div class="result-top"><span>EXECUTION CARD</span><b>READY / CONFIRMATION REQUIRED</b></div>
      <h3 class="result-market">${escapeHtml(intent.market.question)}</h3>
      <div class="result-order">
        <div><small>Maximum loss</small><strong>${escapeHtml(intent.exposure.maximumLoss)} pUSD</strong></div>
        <div><small>Max price</small><strong>${escapeHtml(intent.order.maxPrice)}</strong></div>
        <div><small>Full fill at cap</small><strong>${escapeHtml(intent.order.fullFillSharesAtCap)} ${escapeHtml(outcome)}</strong></div>
      </div>
      <div class="exposure-panel" aria-label="Objective pre-trade exposure">
        <div><small>Selected token</small><strong>${escapeHtml(outcome)}</strong></div>
        <div><small>Order principal</small><strong>${escapeHtml(intent.order.maximumOrderPrincipal)} pUSD</strong></div>
        <div><small>Max venue fee</small><strong>${escapeHtml(intent.exposure.maximumFee)} pUSD</strong></div>
        <div><small>Payout if correct</small><strong>${escapeHtml(intent.exposure.fullFillPayoutAtCap)} pUSD</strong></div>
        <div><small>Profit after max fee</small><strong>${escapeHtml(intent.exposure.grossProfitAtCap)} pUSD</strong></div>
        <div><small>All-in break-even</small><strong>${escapeHtml(intent.exposure.grossBreakEvenPrice)}</strong></div>
        <div><small>Price-cap cushion</small><strong>${escapeHtml(intent.exposure.priceCapCushion)}</strong></div>
        <div><small>Depth coverage</small><strong>${escapeHtml((Number(intent.exposure.boundedLiquidityCoverageBps) / 10_000).toFixed(2))}×</strong></div>
      </div>
      <p><strong>${escapeHtml(shortAddress(intent.buyer.wallet))}</strong> signs. Conviction never receives the key.</p>
      <p><small>Live ask ${escapeHtml(intent.snapshot.bestAsk)} · expires ${escapeHtml(new Date(intent.snapshot.expiresAt).toLocaleTimeString())}</small></p>
      <div class="result-hash"><span>INTENT HASH</span><code>${escapeHtml(intentHash)}</code></div>
      <button class="dossier-button" type="button" id="download-dossier">Download intent dossier</button>
    `;
    result.querySelector("#download-dossier").addEventListener("click", () => {
      const blob = new Blob([JSON.stringify(body, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `conviction-${outcome.toLowerCase()}-${intentHash.slice(2, 10)}.json`;
      anchor.click();
      URL.revokeObjectURL(url);
    });
    status.textContent = "Fee-inclusive bounded intent compiled. Keep the dedicated wallet at or below the requested budget; no transaction was signed or broadcast.";
  } catch (error) {
    result.hidden = true;
    empty.hidden = false;
    status.textContent = error.message;
    markFieldErrors(error);
  } finally {
    form.removeAttribute("aria-busy");
    button.disabled = false;
    button.textContent = "Compile bounded intent";
  }
});
