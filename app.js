import {
  acknowledgementText,
  executionRequest,
  quoteIsExpired,
} from "./src/execution-handoff.mjs";
import { selectAvailableOutcome } from "./src/market-selection.mjs";

const SAFE_EXAMPLE = "will-gpt-6-be-released-by-december-31-2026-834-362-194-984-527";

const marketForm = document.querySelector("#market-form");
const previewForm = document.querySelector("#preview-form");
const intentForm = document.querySelector("#intent-form");
const verificationForm = document.querySelector("#verification-form");
const marketInput = document.querySelector("#market-input");
const spendInput = document.querySelector("#spend-input");
const spendHelp = document.querySelector("#spend-help");
const maxPriceInput = document.querySelector("#max-price-input");
const empty = document.querySelector("#compiled-empty");
const previewResult = document.querySelector("#preview-result");
const compiledResult = document.querySelector("#compiled-result");
const marketResult = document.querySelector("#market-result");
const marketQuotes = document.querySelector("#market-quotes");
const marketStatus = document.querySelector("#market-status");
const previewStatus = document.querySelector("#preview-status");
const formStatus = document.querySelector("#form-status");
const verificationStatus = document.querySelector("#verification-status");
const verificationResult = document.querySelector("#verification-result");
const walletSetupStatus = document.querySelector("[data-wallet-setup-status]");

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
  empty_orderbook: ["outcome"],
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
  invalid_transaction_hash: ["transactionHash"],
  missing_receipt: ["transactionHash"],
  invalid_order_id: ["orderId"],
};

let marketLookup = null;
let previewRequest = null;
let currentCompilation = null;
let expiryTimer = null;
let autoSuggestedSpend = null;

const requestStages = Object.fromEntries(
  ["market", "preview", "intent", "receipt"].map((stage) => [
    stage,
    { epoch: 0, controller: null },
  ]),
);

const idleButtonLabels = new Map([
  [marketForm, "Check live market"],
  [previewForm, "Preview exact bounds"],
  [intentForm, "Create wallet-bound card"],
  [verificationForm, "Verify my fill"],
]);

const defaultSpendHelp = "After market lookup, Conviction suggests the selected side's live fee-inclusive viable minimum. You may set a higher total-risk bound; changing the price cap can change the exact requirement.";

document.querySelector("#year").textContent = String(new Date().getFullYear());

async function loadWalletSetupScaffold() {
  if (!walletSetupStatus) return;
  try {
    const response = await fetch("/api/wallet-setup", {
      headers: { accept: "application/json" },
    });
    if (!response.ok) throw new Error("wallet setup scaffold unavailable");
    const scaffold = await response.json();
    if (scaffold?.paymentAllowed !== false || scaffold?.actions?.pay !== false || scaffold?.actions?.trade !== false) {
      throw new Error("unexpected wallet setup contract");
    }
    if (scaffold.status === "BROWSER_SETUP_BETA_READY" && scaffold?.browserSetup?.page === "/wallet-setup") {
      walletSetupStatus.textContent = "Browser setup is available: ";
      const link = document.createElement("a");
      link.href = scaffold.browserSetup.page;
      link.textContent = "prepare a buyer-controlled wallet";
      walletSetupStatus.append(link, ".");
      return;
    }
    if (
      scaffold.status !== "BROWSER_SETUP_REQUIRES_ACTIVATION" ||
      scaffold.chainWritesAllowed !== false
    ) {
      throw new Error("unexpected wallet setup contract");
    }
    walletSetupStatus.textContent = "Browser setup is not activated yet. Use an already-ready buyer-controlled Deposit Wallet.";
  } catch {
    walletSetupStatus.textContent = "Wallet Setup status is unavailable. Do not fund or connect a new wallet here.";
  }
}

void loadWalletSetupScaffold();

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
  return [...document.querySelectorAll(`[name="${name}"]`)];
}

function clearFieldErrors(scope = document) {
  for (const control of scope.querySelectorAll('[aria-invalid="true"]')) {
    const errorId = control.getAttribute("aria-errormessage");
    const describedBy = (control.getAttribute("aria-describedby") || "")
      .split(/\s+/)
      .filter((value) => value && value !== errorId);
    control.removeAttribute("aria-invalid");
    control.removeAttribute("aria-errormessage");
    if (describedBy.length) control.setAttribute("aria-describedby", describedBy.join(" "));
    else control.removeAttribute("aria-describedby");
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

function markFieldErrors(error, statusId) {
  const controls = fieldsForError(error).flatMap(controlsForField);
  for (const control of controls) {
    control.setAttribute("aria-invalid", "true");
    control.setAttribute("aria-errormessage", statusId);
    const describedBy = new Set(
      (control.getAttribute("aria-describedby") || "").split(/\s+/).filter(Boolean),
    );
    describedBy.add(statusId);
    control.setAttribute("aria-describedby", [...describedBy].join(" "));
  }
  const target = controls.find((control) => control.checked) || controls[0];
  target?.focus();
}

function failureMessage(error) {
  if (error.code === "marketable_order_below_minimum" && error.details?.minimumTotalBudget) {
    return `${error.message}. Minimum total budget at this cap: ${error.details.minimumTotalBudget} pUSD.`;
  }
  if (error.code === "limit_below_best_ask" && error.details?.bestAsk) {
    return `${error.message}. Current best ask: ${error.details.bestAsk}.`;
  }
  if (error.code === "missing_receipt") {
    return "The Polygon receipt is not available yet. Nothing has been marked verified; wait briefly and retry.";
  }
  return error.message;
}

function invalidateRequest(stage) {
  const state = requestStages[stage];
  state.controller?.abort();
  state.controller = null;
  state.epoch += 1;
}

function beginRequest(stage) {
  invalidateRequest(stage);
  const state = requestStages[stage];
  state.controller = new AbortController();
  return { epoch: state.epoch, signal: state.controller.signal };
}

function isCurrentRequest(stage, request) {
  return requestStages[stage].epoch === request.epoch;
}

function completeRequest(stage, request) {
  if (isCurrentRequest(stage, request)) requestStages[stage].controller = null;
}

function setFormIdle(form) {
  form.removeAttribute("aria-busy");
  const button = form.querySelector('button[type="submit"]');
  button.disabled = false;
  button.textContent = idleButtonLabels.get(form);
}

function cancelFormRequest(stage, form) {
  invalidateRequest(stage);
  setFormIdle(form);
}

function isDiscardedRequest(error, stage, request) {
  return error?.name === "AbortError" || !isCurrentRequest(stage, request);
}

async function postJson(path, body, signal) {
  const response = await fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
  const payload = await response.json();
  if (!response.ok || !payload.ok) {
    const failure = new Error(payload.error?.message || "Request failed");
    failure.code = payload.error?.code;
    failure.details = payload.error?.details;
    throw failure;
  }
  return payload;
}

function setStep(step) {
  const order = ["market", "bounds", "wallet", "handoff"];
  const current = order.indexOf(step);
  for (const item of document.querySelectorAll(".journey-progress li")) {
    const position = order.indexOf(item.dataset.step);
    item.classList.toggle("is-current", position === current);
    item.classList.toggle("is-complete", position < current);
    if (position === current) item.setAttribute("aria-current", "step");
    else item.removeAttribute("aria-current");
  }
}

function clearExpiryTimer() {
  if (expiryTimer) window.clearInterval(expiryTimer);
  expiryTimer = null;
}

function resetCompiledCard() {
  clearExpiryTimer();
  currentCompilation = null;
  compiledResult.hidden = true;
  compiledResult.replaceChildren();
}

function clearVerificationResult() {
  verificationResult.hidden = true;
  verificationResult.replaceChildren();
}

function resetVerification() {
  cancelFormRequest("receipt", verificationForm);
  clearFieldErrors(verificationForm);
  clearVerificationResult();
  verificationStatus.textContent = "";
}

function clearAutoSuggestedSpend() {
  if (autoSuggestedSpend !== null && spendInput.value === autoSuggestedSpend) {
    spendInput.value = "";
  }
  autoSuggestedSpend = null;
  spendInput.placeholder = "Shown after market lookup";
  spendHelp.textContent = defaultSpendHelp;
}

function resetAfterMarket() {
  cancelFormRequest("market", marketForm);
  cancelFormRequest("preview", previewForm);
  cancelFormRequest("intent", intentForm);
  resetVerification();
  clearFieldErrors(marketForm);
  clearFieldErrors(previewForm);
  clearFieldErrors(intentForm);
  clearAutoSuggestedSpend();
  marketLookup = null;
  previewRequest = null;
  resetCompiledCard();
  marketResult.hidden = true;
  previewForm.hidden = true;
  intentForm.hidden = true;
  previewResult.hidden = true;
  empty.hidden = false;
  marketStatus.textContent = "";
  previewStatus.textContent = "";
  formStatus.textContent = "";
  setStep("market");
}

function resetAfterBounds() {
  cancelFormRequest("preview", previewForm);
  cancelFormRequest("intent", intentForm);
  resetVerification();
  clearFieldErrors(previewForm);
  clearFieldErrors(intentForm);
  previewRequest = null;
  resetCompiledCard();
  intentForm.hidden = true;
  previewResult.hidden = true;
  empty.hidden = false;
  previewStatus.textContent = "";
  formStatus.textContent = "";
  if (marketLookup) setStep("bounds");
}

function resetAfterWallet() {
  cancelFormRequest("intent", intentForm);
  resetVerification();
  clearFieldErrors(intentForm);
  resetCompiledCard();
  formStatus.textContent = "";
  if (previewRequest) setStep("wallet");
}

function selectedOutcome() {
  return new FormData(previewForm).get("outcome")?.toString().toUpperCase() || "YES";
}

function syncOutcomePrice() {
  if (!marketLookup) return;
  const quote = marketLookup.outcomes[selectedOutcome()];
  maxPriceInput.value = quote?.suggestedMaxPrice || "";
}

function syncOutcomeMinimum() {
  if (!marketLookup) return;
  const outcome = selectedOutcome();
  const quote = marketLookup.outcomes[outcome];
  const minimum = quote?.minimumMarketableBudget;
  if (!minimum) {
    if (autoSuggestedSpend !== null && spendInput.value === autoSuggestedSpend) {
      spendInput.value = "";
    }
    autoSuggestedSpend = null;
    spendInput.placeholder = "Enter total risk";
    spendHelp.textContent = quote?.available
      ? `${outcome} has live asks, but no quoted price level currently has enough bounded depth for the venue minimum. Set a deliberate cap or try again when depth improves.`
      : `${outcome} has no live viable minimum because no ask is currently available.`;
    return;
  }

  if (!spendInput.value.trim() || spendInput.value === autoSuggestedSpend) {
    spendInput.value = minimum.minimumTotalBudget;
    autoSuggestedSpend = minimum.minimumTotalBudget;
  }
  spendInput.placeholder = `Minimum ${minimum.minimumTotalBudget}`;
  const feeDetail = minimum.maximumFeeAtMinimum === "0"
    ? "with no venue fee at this snapshot"
    : `including up to ${minimum.maximumFeeAtMinimum} pUSD venue fee`;
  const capDetail = quote.suggestedMaxPrice === quote.bestAsk
    ? `best ask ${quote.bestAsk}`
    : `depth-aware cap ${quote.suggestedMaxPrice} (best ask ${quote.bestAsk})`;
  spendHelp.textContent = `Live viable minimum for ${outcome} at ${capDetail}: ${minimum.minimumTotalBudget} pUSD total for ${minimum.minimumShares} shares, ${feeDetail}. You may set a higher total-risk bound; preview recomputes the requirement if you change the price cap.`;
}

function renderMarketLookup(payload) {
  const { market, outcomes } = payload;
  document.querySelector("#market-result-title").textContent = market.question || market.slug;
  marketQuotes.innerHTML = ["YES", "NO"].map((outcome) => {
    const quote = outcomes[outcome];
    return `
      <div>
        <span>${outcome}</span>
        <strong>${quote.available ? escapeHtml(quote.bestAsk) : "No ask"}</strong>
        <small>live best ask</small>
      </div>
    `;
  }).join("");
  const previouslyChecked = previewForm
    .querySelector('input[name="outcome"]:checked')
    ?.value.toUpperCase();
  const nextOutcome = selectAvailableOutcome(outcomes, previouslyChecked);
  for (const outcome of ["YES", "NO"]) {
    const control = document.querySelector(`#outcome-${outcome.toLowerCase()}`);
    control.disabled = !outcomes[outcome].available;
    control.checked = outcome === nextOutcome;
  }
  previewForm.querySelector('button[type="submit"]').disabled = nextOutcome === null;
  marketResult.hidden = false;
  previewForm.hidden = false;
  if (nextOutcome) {
    syncOutcomePrice();
    syncOutcomeMinimum();
  } else {
    maxPriceInput.value = "";
    clearAutoSuggestedSpend();
    spendHelp.textContent = "Neither outcome currently has an ask. Try again when the market is liquid.";
  }
  return nextOutcome;
}

function exposureMarkup(data, title) {
  const { order, exposure, snapshot, market } = data;
  return `
    <div class="result-top"><span>${escapeHtml(title)}</span><b>READ-ONLY / NO TRANSACTION</b></div>
    <h3 class="result-market">${escapeHtml(market.question)}</h3>
    <div class="result-order">
      <div><small>Maximum loss</small><strong>${escapeHtml(exposure.maximumLoss)} pUSD</strong></div>
      <div><small>Maximum price</small><strong>${escapeHtml(order.maxPrice)}</strong></div>
      <div><small>Full fill at cap</small><strong>${escapeHtml(order.fullFillSharesAtCap)} ${escapeHtml(order.outcome)}</strong></div>
    </div>
    <div class="exposure-panel" aria-label="Objective pre-trade exposure">
      <div><small>Selected token</small><strong>${escapeHtml(order.outcome)}</strong></div>
      <div><small>Order principal</small><strong>${escapeHtml(order.maximumOrderPrincipal)} pUSD</strong></div>
      <div><small>Max venue fee</small><strong>${escapeHtml(exposure.maximumFee)} pUSD</strong></div>
      <div><small>Payout if correct</small><strong>${escapeHtml(exposure.fullFillPayoutAtCap)} pUSD</strong></div>
      <div><small>Profit after max fee</small><strong>${escapeHtml(exposure.grossProfitAtCap)} pUSD</strong></div>
      <div><small>All-in break-even</small><strong>${escapeHtml(exposure.grossBreakEvenPrice)}</strong></div>
      <div><small>Live best ask</small><strong>${escapeHtml(snapshot.bestAsk)}</strong></div>
      <div><small>Price-cap cushion</small><strong>${escapeHtml(exposure.priceCapCushion)}</strong></div>
      <div><small>Depth coverage</small><strong>${escapeHtml((Number(exposure.boundedLiquidityCoverageBps) / 10_000).toFixed(2))}×</strong></div>
    </div>
  `;
}

function renderPreview(payload) {
  empty.hidden = true;
  compiledResult.hidden = true;
  previewResult.hidden = false;
  previewResult.innerHTML = `
    ${exposureMarkup(payload.preview, "BOUNDS PREVIEW")}
    <div class="notice notice-safe">
      <strong>No wallet used.</strong>
      <span>This preview cannot be signed or executed. Continue only if these are the bounds you intended.</span>
    </div>
  `;
}

function secondsRemaining(compilation) {
  return Math.max(0, Math.ceil((Date.parse(compilation.executionCard.expiresAt) - Date.now()) / 1_000));
}

function renderCompiled(payload) {
  empty.hidden = true;
  previewResult.hidden = true;
  compiledResult.hidden = false;
  const { intent, intentHash } = payload;
  const prompt = executionRequest(payload);
  compiledResult.innerHTML = `
    <div class="result-top"><span>WALLET-BOUND CARD</span><b>CONFIRMATION REQUIRED</b></div>
    <h3 class="result-market">${escapeHtml(intent.market.question)}</h3>
    <div class="result-order">
      <div><small>Maximum loss</small><strong>${escapeHtml(intent.exposure.maximumLoss)} pUSD</strong></div>
      <div><small>Maximum price</small><strong>${escapeHtml(intent.order.maxPrice)}</strong></div>
      <div><small>Full fill at cap</small><strong>${escapeHtml(intent.order.fullFillSharesAtCap)} ${escapeHtml(intent.order.outcome)}</strong></div>
    </div>
    <div class="notice">
      <strong>${escapeHtml(shortAddress(intent.buyer.wallet))}</strong>
      <span>is the only wallet this card permits. Conviction never receives its key.</span>
    </div>
    <p class="quote-expiry" id="quote-expiry" role="status">Card expires in ${secondsRemaining(payload)} seconds.</p>
    <div class="result-hash"><span>INTENT HASH</span><code>${escapeHtml(intentHash)}</code></div>
    <label class="bounds-acknowledgement">
      <input id="bounds-ack" type="checkbox" />
      <span>${escapeHtml(acknowledgementText(payload))}</span>
    </label>
    <div class="handoff-panel" id="handoff-panel" hidden>
      <div class="stage-heading">
        <span>Manual fallback</span>
        <h4>Inspect the exact request in OKX Agentic Wallet</h4>
        <p>The public buyer-agent runner handles this handoff automatically. If you use this browser fallback, copying still places no order: the official plugin dry-runs first and requires separate confirmation.</p>
      </div>
      <textarea id="execution-prompt" rows="12" readonly aria-label="Secure execution prompt">${escapeHtml(prompt)}</textarea>
      <div class="stage-actions">
        <button class="button button-primary" id="copy-execution" type="button">Copy secure dry-run request</button>
        <button class="button button-quiet" id="download-dossier" type="button">Download intent dossier</button>
      </div>
      <div class="handoff-links">
        <a href="https://web3.okx.com/onchainos/plugins/detail/polymarket-plugin" target="_blank" rel="noreferrer">Official Polymarket plugin <span aria-hidden="true">↗</span></a>
        <a href="https://web3.okx.com/onchainos/dev-docs/home/install-your-agentic-wallet" target="_blank" rel="noreferrer">Agentic Wallet documentation <span aria-hidden="true">↗</span></a>
      </div>
      <p class="approval-warning"><strong>Approval warning:</strong> OPEN is currently available only to a ready buyer-controlled Polymarket deposit wallet. This handoff is not a first-time venue-setup route: if your wallet is not already ready, stop without funding or payment. Conviction will not bypass your wallet or organization policy.</p>
    </div>
  `;

  const acknowledgement = compiledResult.querySelector("#bounds-ack");
  const handoff = compiledResult.querySelector("#handoff-panel");
  acknowledgement.addEventListener("change", () => {
    if (acknowledgement.checked && quoteIsExpired(payload)) {
      acknowledgement.checked = false;
      formStatus.textContent = "This card expired. Create a fresh wallet-bound card before continuing.";
      return;
    }
    handoff.hidden = !acknowledgement.checked;
  });

  compiledResult.querySelector("#copy-execution").addEventListener("click", async (event) => {
    if (quoteIsExpired(payload)) {
      formStatus.textContent = "This card expired. Nothing was copied; create a fresh card.";
      return;
    }
    const promptControl = compiledResult.querySelector("#execution-prompt");
    try {
      await navigator.clipboard.writeText(promptControl.value);
      event.currentTarget.textContent = "Copied — dry run first";
      formStatus.textContent = "Secure dry-run request copied. Pasting it is not live-trading authorization.";
    } catch {
      promptControl.focus();
      promptControl.select();
      formStatus.textContent = "Clipboard access was blocked. The request is selected for manual copy.";
    }
  });

  compiledResult.querySelector("#download-dossier").addEventListener("click", () => {
    downloadJson(`conviction-${intent.order.outcome.toLowerCase()}-${intentHash.slice(2, 10)}.json`, payload);
  });

  const expiry = compiledResult.querySelector("#quote-expiry");
  clearExpiryTimer();
  expiryTimer = window.setInterval(() => {
    const remaining = secondsRemaining(payload);
    expiry.textContent = remaining > 0
      ? `Card expires in ${remaining} seconds.`
      : "Card expired. Create a fresh card before copying or executing.";
    expiry.classList.toggle("is-expired", remaining === 0);
    if (remaining === 0) {
      acknowledgement.disabled = true;
      handoff.hidden = true;
      clearExpiryTimer();
    }
  }, 1_000);
}

function downloadJson(filename, value) {
  const blob = new Blob([JSON.stringify(value, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

marketInput.addEventListener("input", resetAfterMarket);
spendInput.addEventListener("input", () => {
  if (spendInput.value !== autoSuggestedSpend) autoSuggestedSpend = null;
});
for (const control of previewForm.elements) {
  control.addEventListener("input", resetAfterBounds);
}
for (const control of intentForm.elements) {
  control.addEventListener("input", resetAfterWallet);
}
for (const control of verificationForm.elements) {
  control.addEventListener(control.type === "file" ? "change" : "input", resetVerification);
}

document.querySelector("#load-example").addEventListener("click", () => {
  marketInput.value = SAFE_EXAMPLE;
  resetAfterMarket();
  marketForm.requestSubmit();
});

marketForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  clearFieldErrors(marketForm);
  resetAfterMarket();
  const request = beginRequest("market");
  const button = marketForm.querySelector('button[type="submit"]');
  button.disabled = true;
  marketForm.setAttribute("aria-busy", "true");
  button.textContent = "Reading market…";
  marketStatus.textContent = "Resolving both live outcome books. No wallet is involved.";
  try {
    const payload = await postJson("/api/market", { market: marketInput.value }, request.signal);
    if (!isCurrentRequest("market", request)) return;
    marketLookup = payload;
    const selected = renderMarketLookup(payload);
    setStep("bounds");
    marketStatus.textContent = selected
      ? `Market found. ${selected} is selected; choose the economic bounds below.`
      : "Market found, but neither outcome currently has an ask. Nothing can be previewed yet.";
  } catch (error) {
    if (isDiscardedRequest(error, "market", request)) return;
    marketStatus.textContent = failureMessage(error);
    markFieldErrors(error, "market-status");
  } finally {
    if (isCurrentRequest("market", request)) {
      setFormIdle(marketForm);
      completeRequest("market", request);
    }
  }
});

previewForm.addEventListener("change", (event) => {
  if (event.target.name === "outcome") {
    resetAfterBounds();
    syncOutcomePrice();
    syncOutcomeMinimum();
  }
});

previewForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  clearFieldErrors(previewForm);
  resetCompiledCard();
  cancelFormRequest("intent", intentForm);
  resetVerification();
  const request = beginRequest("preview");
  const button = previewForm.querySelector('button[type="submit"]');
  const data = Object.fromEntries(new FormData(previewForm));
  previewRequest = {
    market: marketLookup?.market?.slug || marketLookup?.market?.conditionId || marketInput.value,
    outcome: data.outcome,
    spend: data.spend,
    maxPrice: data.maxPrice,
  };
  button.disabled = true;
  previewForm.setAttribute("aria-busy", "true");
  button.textContent = "Computing exposure…";
  previewStatus.textContent = `Reading a fresh ${data.outcome.toUpperCase()} book and checking the cap.`;
  try {
    const payload = await postJson("/api/preview", previewRequest, request.signal);
    if (!isCurrentRequest("preview", request)) return;
    renderPreview(payload);
    intentForm.hidden = false;
    setStep("wallet");
    previewStatus.textContent = "Read-only bounds passed. Add your wallet only if you want a final card.";
  } catch (error) {
    if (isDiscardedRequest(error, "preview", request)) return;
    previewRequest = null;
    previewStatus.textContent = failureMessage(error);
    markFieldErrors(error, "preview-status");
  } finally {
    if (isCurrentRequest("preview", request)) {
      setFormIdle(previewForm);
      completeRequest("preview", request);
    }
  }
});

intentForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  clearFieldErrors(intentForm);
  resetCompiledCard();
  resetVerification();
  const request = beginRequest("intent");
  const button = intentForm.querySelector('button[type="submit"]');
  const data = Object.fromEntries(new FormData(intentForm));
  button.disabled = true;
  intentForm.setAttribute("aria-busy", "true");
  button.textContent = "Creating fresh card…";
  formStatus.textContent = "Re-reading the live book and binding the exact wallet. Nothing will be signed.";
  try {
    const payload = await postJson("/api/intent", { ...previewRequest, ...data }, request.signal);
    if (!isCurrentRequest("intent", request)) return;
    currentCompilation = payload;
    renderCompiled(payload);
    setStep("handoff");
    formStatus.textContent = "Fresh card created. Confirm the displayed bounds to reveal the dry-run handoff.";
  } catch (error) {
    if (isDiscardedRequest(error, "intent", request)) return;
    formStatus.textContent = failureMessage(error);
    markFieldErrors(error, "form-status");
  } finally {
    if (isCurrentRequest("intent", request)) {
      setFormIdle(intentForm);
      completeRequest("intent", request);
    }
  }
});

async function artifactForVerification() {
  const file = document.querySelector("#dossier-input").files[0];
  if (!file) {
    throw new Error("Select a paid Conviction-issued v4 dossier; the free preview card is not a verification credential");
  }
  const artifact = JSON.parse(await file.text());
  if (artifact?.intent?.version !== "conviction-intent-v4" || !artifact?.intentHash || !artifact?.issuance) {
    throw new Error("Public verification requires a paid Conviction-issued v4 dossier with its issuance signature");
  }
  return artifact;
}

function renderVerification(payload) {
  const proof = payload.positionProof;
  const issuerSigned = payload.assurance === "issuer-signed";
  const checks = Object.entries(proof.checks || {});
  verificationResult.hidden = false;
  verificationResult.innerHTML = `
    <div class="verification-proof">
      <div class="result-top"><span>POSITION PROOF</span><b>${issuerSigned ? "ISSUER-SIGNED · VERIFIED ON POLYGON" : "SELF-ASSERTED MATCH"}</b></div>
      <h3>${issuerSigned
        ? `${escapeHtml(proof.outcome)} fill matched its pre-issued bounds and market.`
        : "This fill matches supplied bounds, but Conviction did not issue the intent."}</h3>
      <div class="exposure-panel">
        <div><small>Actual principal</small><strong>${escapeHtml(proof.fill.actualOrderPrincipalRaw || proof.fill.actualSpendRaw)} raw</strong></div>
        <div><small>Actual venue fee</small><strong>${escapeHtml(proof.fill.actualFeeRaw || "0")} raw</strong></div>
        <div><small>Actual total debit</small><strong>${escapeHtml(proof.fill.actualTotalDebitRaw || proof.fill.actualSpendRaw)} raw</strong></div>
        <div><small>Shares received</small><strong>${escapeHtml(proof.fill.actualSharesRaw)} raw</strong></div>
        <div><small>Average price ceiling</small><strong>${escapeHtml(proof.fill.allInAveragePriceCeiling || proof.fill.averagePriceCeiling)}</strong></div>
        <div><small>Block</small><strong>${escapeHtml(proof.blockNumber)}</strong></div>
      </div>
      <ul class="check-list">${checks.map(([name, passed]) => `<li><span>${escapeHtml(name)}</span><b>${passed ? "PASS" : "FAIL"}</b></li>`).join("")}</ul>
      <div class="result-hash"><span>POSITION PROOF HASH</span><code>${escapeHtml(payload.positionProofHash)}</code></div>
      <div class="stage-actions">
        <a class="button button-primary" href="https://polygonscan.com/tx/${encodeURIComponent(proof.transactionHash)}" target="_blank" rel="noreferrer">Open Polygon receipt <span aria-hidden="true">↗</span></a>
        <button class="button button-quiet" id="download-proof" type="button">Download proof</button>
      </div>
    </div>
  `;
  verificationResult.querySelector("#download-proof").addEventListener("click", () => {
    downloadJson(`conviction-proof-${proof.transactionHash.slice(2, 10)}.json`, payload);
  });
}

verificationForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  clearFieldErrors(verificationForm);
  clearVerificationResult();
  const request = beginRequest("receipt");
  const button = verificationForm.querySelector('button[type="submit"]');
  const data = Object.fromEntries(new FormData(verificationForm));
  button.disabled = true;
  verificationForm.setAttribute("aria-busy", "true");
  button.textContent = "Reading Polygon…";
  verificationStatus.textContent = "Fetching the receipt and checking every selected-token and economic bound.";
  try {
    const artifact = await artifactForVerification();
    if (!isCurrentRequest("receipt", request)) return;
    const payload = await postJson("/api/receipt", {
      transactionHash: data.transactionHash,
      orderId: data.orderId,
      intent: artifact.intent,
      intentHash: artifact.intentHash,
      issuance: artifact.issuance,
    }, request.signal);
    if (!isCurrentRequest("receipt", request)) return;
    renderVerification(payload);
    verificationStatus.textContent = payload.assurance === "issuer-signed"
      ? "Issuer signature, CTF market binding, signed window, and Polygon fill verified independently."
      : "On-chain fill matched self-asserted bounds; no Conviction issuance was proven.";
  } catch (error) {
    if (isDiscardedRequest(error, "receipt", request)) return;
    clearVerificationResult();
    verificationStatus.textContent = failureMessage(error);
    markFieldErrors(error, "verification-status");
  } finally {
    if (isCurrentRequest("receipt", request)) {
      setFormIdle(verificationForm);
      completeRequest("receipt", request);
    }
  }
});
