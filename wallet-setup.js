const POLYGON_CHAIN_HEX = "0x89";
const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

const connectButton = document.querySelector("#connect-wallet");
const deployButton = document.querySelector("#deploy-wallet");
const approveButton = document.querySelector("#approve-wallet");
const approvalAck = document.querySelector("#approval-ack");
const statusBox = document.querySelector("#setup-status");
const eoaOutput = document.querySelector("#setup-eoa");
const depositWalletOutput = document.querySelector("#setup-deposit-wallet");
const readyPanel = document.querySelector("#ready-panel");
const readyWallet = document.querySelector("#ready-wallet");

let scaffold = null;
let owner = null;
let sessionToken = null;
let depositWallet = null;
let pendingDeploymentPollToken = null;
let pendingApprovalPollToken = null;
let walletSetupRetryTimer = null;

function setStatus(message, kind = "info") {
  statusBox.textContent = message;
  statusBox.classList.toggle("is-error", kind === "error");
  statusBox.classList.toggle("is-success", kind === "success");
}

function setStep(current) {
  const order = ["connect", "deploy", "approve", "ready"];
  const currentIndex = order.indexOf(current);
  for (const item of document.querySelectorAll("[data-setup-step]")) {
    const index = order.indexOf(item.dataset.setupStep);
    item.classList.toggle("is-current", index === currentIndex);
    item.classList.toggle("is-done", index < currentIndex);
  }
}

function hexUtf8(value) {
  return `0x${[...new TextEncoder().encode(value)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")}`;
}

function errorMessage(error) {
  if (error?.code === 4001) return "The wallet request was declined. Nothing changed.";
  return error?.message || "The wallet setup step failed.";
}

async function jsonRequest(path, { body, token = sessionToken } = {}) {
  const response = await fetch(path, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok || payload?.ok === false) {
    const error = new Error(payload?.error?.message || `Request failed with HTTP ${response.status}`);
    error.code = payload?.error?.code;
    throw error;
  }
  return payload;
}

async function ensurePolygon() {
  const provider = window.ethereum;
  if (!provider?.request) throw new Error("No browser EVM wallet was found.");
  const chainId = await provider.request({ method: "eth_chainId" });
  if (chainId === POLYGON_CHAIN_HEX) return;
  try {
    await provider.request({
      method: "wallet_switchEthereumChain",
      params: [{ chainId: POLYGON_CHAIN_HEX }],
    });
  } catch (error) {
    if (error?.code !== 4902) throw error;
    await provider.request({
      method: "wallet_addEthereumChain",
      params: [{
        chainId: POLYGON_CHAIN_HEX,
        chainName: "Polygon",
        nativeCurrency: { name: "POL", symbol: "POL", decimals: 18 },
        rpcUrls: ["https://polygon-rpc.com"],
        blockExplorerUrls: ["https://polygonscan.com"],
      }],
    });
  }
  const confirmedChainId = await provider.request({ method: "eth_chainId" });
  if (confirmedChainId !== POLYGON_CHAIN_HEX) {
    throw new Error("Switch to Polygon before continuing.");
  }
}

async function currentAccount() {
  const accounts = await window.ethereum.request({ method: "eth_accounts" });
  const account = String(accounts?.[0] || "").toLowerCase();
  if (!owner || account !== owner.toLowerCase()) {
    throw new Error("The connected wallet changed. Reload and authenticate the intended buyer wallet.");
  }
  return account;
}

async function relay(operation, body = {}) {
  return jsonRequest("/api/wallet-relayer", {
    body: { operation, ...body },
  });
}

async function waitForRelayer(pollToken, label) {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const result = await relay("transaction", { pollToken });
    if (result?.status === "confirmed") return result;
    setStatus(`${label} submitted. Waiting for Polymarket and Polygon confirmation…`);
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  return null;
}

function completeDeployment(result) {
  if (!ADDRESS_RE.test(String(result?.depositWallet || ""))) {
    throw new Error("Setup confirmation did not contain the buyer Deposit Wallet address.");
  }
  depositWallet = result.depositWallet;
  depositWalletOutput.textContent = depositWallet;
  deployButton.textContent = "Deposit wallet deployed";
  approvalAck.disabled = false;
  setStep("approve");
  setStatus("Deposit wallet confirmed on Polygon. No pUSD or outcome-token permission has been granted yet.", "success");
}

async function connect() {
  connectButton.disabled = true;
  setStatus("Connecting the buyer wallet on Polygon…");
  try {
    await ensurePolygon();
    const accounts = await window.ethereum.request({ method: "eth_requestAccounts" });
    owner = String(accounts?.[0] || "");
    if (!ADDRESS_RE.test(owner)) throw new Error("Wallet did not return a valid EVM address.");
    const challenge = await jsonRequest("/api/wallet-session", {
      token: null,
      body: { action: "challenge", wallet: owner },
    });
    setStatus("Sign the authentication message. It cannot move funds or approve a trade.");
    const signature = await window.ethereum.request({
      method: "personal_sign",
      params: [hexUtf8(challenge.message), owner],
    });
    const session = await jsonRequest("/api/wallet-session", {
      token: null,
      body: {
        action: "authenticate",
        challengeToken: challenge.challengeToken,
        signature,
      },
    });
    sessionToken = session.sessionToken;
    owner = session.wallet;
    const builderAuth = await relay("auth");
    if (builderAuth?.authentication !== "builder") {
      throw new Error("Conviction could not verify Polymarket Builder authorization. Do not fund or continue setup.");
    }
    eoaOutput.textContent = owner;
    connectButton.textContent = "Buyer wallet authenticated";
    deployButton.disabled = false;
    setStep("deploy");
    setStatus("Buyer wallet authenticated and Builder authorization verified. Nothing has been deployed or approved.");
  } catch (error) {
    connectButton.disabled = false;
    setStatus(errorMessage(error), "error");
  }
}

async function deploy() {
  deployButton.disabled = true;
  setStatus("Consent 1 of 2: confirm one buyer-wallet deployment in your browser wallet. No token permission is granted.");
  try {
    await ensurePolygon();
    await currentAccount();
    if (!pendingDeploymentPollToken) {
      const consentChallenge = await jsonRequest("/api/wallet-session", {
        body: { action: "deploy_challenge" },
      });
      const signature = await window.ethereum.request({
        method: "personal_sign",
        params: [hexUtf8(consentChallenge.message), owner],
      });
      const consent = await jsonRequest("/api/wallet-session", {
        body: {
          action: "deploy_authorize",
          deploymentChallengeToken: consentChallenge.deploymentChallengeToken,
          signature,
        },
      });
      const request = JSON.stringify({
        type: "WALLET-CREATE",
        from: owner,
        to: scaffold.browserSetup.walletFactory,
      });
      const submitted = await relay("submit", {
        request,
        deploymentConsentToken: consent.deploymentConsentToken,
      });
      if (typeof submitted?.pollToken !== "string") {
        throw new Error("Polymarket relayer did not return a setup status capability.");
      }
      pendingDeploymentPollToken = submitted.pollToken;
    }
    const confirmed = await waitForRelayer(pendingDeploymentPollToken, "Deposit wallet deployment");
    if (!confirmed) {
      deployButton.disabled = false;
      deployButton.textContent = "Check deployment confirmation";
      setStatus("Deployment is still pending. Check confirmation again; do not fund until Conviction confirms the Deposit Wallet.");
      return;
    }
    pendingDeploymentPollToken = null;
    completeDeployment(confirmed);
  } catch (error) {
    deployButton.disabled = false;
    setStatus(errorMessage(error), "error");
  }
}

function typedData({ nonce, deadline }) {
  return {
    domain: {
      name: "DepositWallet",
      version: "1",
      chainId: scaffold.browserSetup.chainId,
      verifyingContract: depositWallet,
    },
    types: {
      Call: [
        { name: "target", type: "address" },
        { name: "value", type: "uint256" },
        { name: "data", type: "bytes" },
      ],
      Batch: [
        { name: "wallet", type: "address" },
        { name: "nonce", type: "uint256" },
        { name: "deadline", type: "uint256" },
        { name: "calls", type: "Call[]" },
      ],
    },
    primaryType: "Batch",
    message: {
      wallet: depositWallet,
      nonce,
      deadline,
      calls: scaffold.browserSetup.approvalCalls,
    },
  };
}

async function approve() {
  if (!approvalAck.checked) {
    setStatus("Read and acknowledge the reusable approval scope before continuing.", "error");
    return;
  }
  approveButton.disabled = true;
  approvalAck.disabled = true;
  setStatus("Consent 2 of 2: review and sign the exact five-call Polymarket approval batch.");
  try {
    await ensurePolygon();
    await currentAccount();
    if (!pendingApprovalPollToken) {
      const nonceResult = await relay("nonce");
      const nonce = String(nonceResult?.relayer?.nonce ?? "");
      if (!/^(0|[1-9][0-9]*)$/.test(nonce)) throw new Error("Relayer returned an invalid wallet nonce.");
      const deadline = String(Math.floor(Date.now() / 1_000) + 270);
      const data = typedData({ nonce, deadline });
      const signature = await window.ethereum.request({
        method: "eth_signTypedData_v4",
        params: [owner, JSON.stringify(data)],
      });
      const request = JSON.stringify({
        type: "WALLET",
        from: owner,
        to: scaffold.browserSetup.walletFactory,
        nonce,
        signature,
        depositWalletParams: {
          depositWallet,
          deadline,
          calls: scaffold.browserSetup.approvalCalls,
        },
      });
      const submitted = await relay("submit", { request });
      if (typeof submitted?.pollToken !== "string") {
        throw new Error("Polymarket relayer did not return a setup status capability.");
      }
      pendingApprovalPollToken = submitted.pollToken;
    }
    const confirmed = await waitForRelayer(pendingApprovalPollToken, "Approval batch");
    if (!confirmed) {
      approveButton.disabled = false;
      approveButton.textContent = "Check approval confirmation";
      setStatus("Venue approval is still pending. Check confirmation again; do not fund until Conviction verifies all five permissions.");
      return;
    }
    pendingApprovalPollToken = null;
    approveButton.textContent = "Venue permissions confirmed";
    readyWallet.textContent = depositWallet;
    readyPanel.hidden = false;
    if (window.ConvictionBrowserOpen?.activateBrowserOpen) {
      window.ConvictionBrowserOpen.activateBrowserOpen({ owner, depositWallet });
    } else {
      throw new Error("Browser execution adapter did not load. Reload before funding or paying.");
    }
    setStep("ready");
    setStatus(
      `All five venue permissions were confirmed on Polygon: ${confirmed.transactionHash}. Fund only the Deposit Wallet address shown.`,
      "success",
    );
  } catch (error) {
    approveButton.disabled = false;
    approvalAck.disabled = false;
    setStatus(errorMessage(error), "error");
  }
}

async function initialize() {
  try {
    const response = await fetch("/api/wallet-setup", {
      headers: { accept: "application/json" },
    });
    scaffold = await response.json();
    if (
      !response.ok ||
      scaffold?.status !== "BROWSER_SETUP_BETA_READY" ||
      scaffold?.browserSetup?.approvalCalls?.length !== 5
    ) {
      connectButton.disabled = true;
      if (scaffold?.status === "BROWSER_SETUP_AUTH_CHECKING") {
        setStatus("Browser setup authorization is still being checked. Retrying shortly; do not connect or fund a new wallet here.");
        if (!walletSetupRetryTimer) {
          const delay = Number.isSafeInteger(scaffold.retryAfterSeconds)
            ? scaffold.retryAfterSeconds * 1_000
            : 15_000;
          walletSetupRetryTimer = window.setTimeout(() => {
            walletSetupRetryTimer = null;
            void initialize();
          }, delay);
        }
        return;
      }
      setStatus(
        scaffold?.status === "BROWSER_SETUP_AUTH_UNAVAILABLE"
          ? "Browser setup authorization is temporarily unavailable. Do not connect or fund a new wallet here."
          : "Browser wallet setup is not activated yet. Do not connect or fund a new wallet here.",
        "error",
      );
      return;
    }
    connectButton.disabled = false;
    setStatus("Setup is available. Connect a dedicated buyer wallet to begin; no chain action occurs on connect.");
  } catch {
    connectButton.disabled = true;
    setStatus("Wallet setup status is unavailable. Do not connect or fund a new wallet here.", "error");
  }
}

approvalAck.addEventListener("change", () => {
  approveButton.disabled = !approvalAck.checked;
});
connectButton.addEventListener("click", connect);
deployButton.addEventListener("click", deploy);
approveButton.addEventListener("click", approve);
window.ethereum?.on?.("accountsChanged", () => {
  if (owner) location.reload();
});
window.ethereum?.on?.("chainChanged", () => {
  if (owner) location.reload();
});

void initialize();
