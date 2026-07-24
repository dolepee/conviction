import {
  createSecureClient,
  OrderSide,
  OrderType,
} from "@polymarket/client";
import { signerFrom } from "@polymarket/client/viem";
import {
  createWalletClient,
  custom,
} from "viem";
import { polygon } from "viem/chains";

import {
  browserOpenRequest,
  buyCardWithX402,
  createBrowserX402Client,
  marketOrderFromCard,
  settlementFromOrder,
  verifyBrowserCard,
  verifyBrowserSettlement,
} from "./browser-open-client.mjs";

const X_LAYER_CHAIN_HEX = "0xc4";
const POLYGON_CHAIN_HEX = "0x89";

function element(id) {
  return document.querySelector(`#${id}`);
}

function status(message, kind = "info") {
  const output = element("open-status");
  output.textContent = message;
  output.classList.toggle("is-error", kind === "error");
  output.classList.toggle("is-success", kind === "success");
}

function provider() {
  if (!window.ethereum?.request) throw new Error("No browser EVM wallet was found.");
  return window.ethereum;
}

async function switchChain(chainId) {
  await provider().request({
    method: "wallet_switchEthereumChain",
    params: [{ chainId }],
  });
  if (await provider().request({ method: "eth_chainId" }) !== chainId) {
    throw new Error("Wallet did not switch to the required network.");
  }
}

async function activeOwner(expected) {
  const accounts = await provider().request({ method: "eth_accounts" });
  const owner = String(accounts?.[0] || "").toLowerCase();
  if (owner !== String(expected || "").toLowerCase()) {
    throw new Error("The connected wallet changed. Reload and authenticate the intended buyer wallet.");
  }
  return owner;
}

function typedDataSigner(owner) {
  return {
    address: owner,
    async signTypedData({ domain, types, primaryType, message }) {
      return provider().request({
        method: "eth_signTypedData_v4",
        params: [
          owner,
          JSON.stringify(
            { domain, types, primaryType, message },
            (_key, value) => typeof value === "bigint" ? value.toString() : value,
          ),
        ],
      });
    },
  };
}

function renderBounds(card, request) {
  const bound = verifyBrowserCard(card, request);
  element("open-bounds").hidden = false;
  element("open-bound-outcome").textContent = bound.outcome;
  element("open-bound-principal").textContent = `${bound.principal} pUSD`;
  element("open-bound-debit").textContent = `${bound.maxSpend} pUSD`;
  element("open-bound-price").textContent = `${bound.maxPrice} pUSD`;
  element("open-bound-expiry").textContent = bound.expiresAt;
}

export function activateBrowserOpen({ owner, depositWallet }) {
  const form = element("browser-open-form");
  const paymentButton = element("confirm-open-payment");
  const tradeButton = element("confirm-open-trade");
  let request;
  let card;
  let payment;
  form.hidden = false;

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    paymentButton.disabled = true;
    tradeButton.disabled = true;
    element("open-bounds").hidden = true;
    try {
      const data = Object.fromEntries(new FormData(form));
      request = browserOpenRequest({
        ...data,
        owner,
        depositWallet,
      });
      status("Running a fresh read-only market preview before payment…");
      const response = await fetch("/api/preview", {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify(request),
      });
      const preview = await response.json().catch(() => null);
      if (!response.ok) throw new Error(preview?.error?.message || "Preview failed.");
      element("open-preview-outcome").textContent = preview.preview?.order?.outcome || request.outcome;
      element("open-preview-debit").textContent = `${preview.preview?.order?.maximumTotalDebit || "—"} pUSD`;
      element("open-preview-price").textContent = `${preview.preview?.order?.maxPrice || request.maxPrice} pUSD`;
      paymentButton.disabled = false;
      status("Preview passed. Confirming payment signs only the 0.05 USD₮0 service payment; it cannot place the trade.", "success");
    } catch (error) {
      status(error.message, "error");
    }
  });

  paymentButton.addEventListener("click", async () => {
    paymentButton.disabled = true;
    try {
      await switchChain(X_LAYER_CHAIN_HEX);
      const buyer = await activeOwner(owner);
      status("Confirm 0.05 USD₮0 on X Layer. This payment does not authorize a trade.");
      const paid = await buyCardWithX402({
        request,
        httpClient: createBrowserX402Client({ signer: typedDataSigner(buyer) }),
      });
      card = paid.card;
      payment = paid.payment;
      renderBounds(card, request);
      tradeButton.disabled = false;
      status(`Payment settled: ${payment.transactionHash}. Review the fresh signed bounds, then separately confirm the trade.`, "success");
    } catch (error) {
      paymentButton.disabled = false;
      status(error.message, "error");
    }
  });

  tradeButton.addEventListener("click", async () => {
    tradeButton.disabled = true;
    try {
      const bound = verifyBrowserCard(card, request);
      if (Date.parse(bound.expiresAt) <= Date.now()) {
        throw new Error("The signed card expired. Do not trade; request a fresh card.");
      }
      await switchChain(POLYGON_CHAIN_HEX);
      await activeOwner(owner);
      status("Trade consent received. Your wallet now signs only the displayed bounded FAK order.");
      const walletClient = createWalletClient({
        account: owner,
        chain: polygon,
        transport: custom(provider()),
      });
      const client = await createSecureClient({
        wallet: depositWallet,
        signer: signerFrom(walletClient),
      });
      const order = marketOrderFromCard(card, request);
      const response = await client.placeMarketOrder({
        tokenId: order.tokenId,
        side: OrderSide.BUY,
        amount: order.amount,
        maxSpend: order.maxSpend,
        maxPrice: order.maxPrice,
        orderType: OrderType.FAK,
      });
      const settlement = settlementFromOrder(response);
      status("Polygon fill submitted. Conviction is rebuilding the result from public chain data…");
      const proof = await verifyBrowserSettlement({ card, settlement });
      element("open-result").hidden = false;
      element("open-payment-hash").textContent = payment.transactionHash;
      element("open-fill-hash").textContent = settlement.transactionHash;
      element("open-proof-hash").textContent = proof.positionProofHash;
      status("OPEN complete: service payment, separate trade consent, buyer-held fill, and issuer-signed Polygon proof.", "success");
    } catch (error) {
      tradeButton.disabled = false;
      status(error.message, "error");
    }
  });
}

window.ConvictionBrowserOpen = Object.freeze({ activateBrowserOpen });
