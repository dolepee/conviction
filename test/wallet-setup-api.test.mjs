import assert from "node:assert/strict";
import test from "node:test";

import { privateKeyToAccount } from "viem/accounts";

import { createWalletRelayerHandler } from "../src/wallet-relayer-handler.mjs";
import { createWalletSessionHandler } from "../src/wallet-session-handler.mjs";
import { createReadinessHandler } from "../api/readiness.js";
import {
  DEPOSIT_WALLET_FACTORY,
  OFFICIAL_APPROVAL_CALLS,
  POLYGON_CHAIN_ID,
} from "../src/polymarket-builder-guard.mjs";
import { createWalletSetupAuth } from "../src/wallet-setup-auth.mjs";
import { createInMemoryWalletSetupState } from "../src/wallet-setup-state.mjs";

const KEY = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const SECRET = "wallet-session-secret-that-is-definitely-long-enough";
const DEPOSIT_WALLET = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const DEPLOY_TX = `0x${"1".repeat(64)}`;
const APPROVAL_TX = `0x${"2".repeat(64)}`;

function response() {
  return {
    headers: {},
    statusCode: null,
    body: null,
    setHeader(name, value) { this.headers[name.toLowerCase()] = value; return this; },
    status(value) { this.statusCode = value; return this; },
    json(value) { this.body = value; return this; },
  };
}

const passGuard = { run: async (_request, task) => task() };

async function authenticatedSession(auth, account) {
  const challenge = auth.issueChallenge(account.address);
  return auth.authenticate({
    challengeToken: challenge.challengeToken,
    signature: await account.signMessage({ message: challenge.message }),
  });
}

async function approvalRequest(account, { nonce = "7", deadline = "3300" } = {}) {
  const signature = await account.signTypedData({
    domain: {
      name: "DepositWallet",
      version: "1",
      chainId: POLYGON_CHAIN_ID,
      verifyingContract: DEPOSIT_WALLET,
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
      wallet: DEPOSIT_WALLET,
      nonce: BigInt(nonce),
      deadline: BigInt(deadline),
      calls: OFFICIAL_APPROVAL_CALLS.map((call) => ({
        target: call.target,
        value: BigInt(call.value),
        data: call.data,
      })),
    },
  });
  return JSON.stringify({
    type: "WALLET",
    from: account.address,
    to: DEPOSIT_WALLET_FACTORY,
    nonce,
    signature,
    depositWalletParams: {
      depositWallet: DEPOSIT_WALLET,
      deadline,
      calls: OFFICIAL_APPROVAL_CALLS,
    },
  });
}

test("existing readiness function dispatches the three rewritten browser setup routes", async () => {
  const calls = [];
  const handler = createReadinessHandler({
    publicGuard: passGuard,
    walletSetupHandler: async (_request, result) => {
      calls.push("setup");
      return result.status(200).json({ route: "setup" });
    },
    walletSessionHandler: async (_request, result) => {
      calls.push("session");
      return result.status(200).json({ route: "session" });
    },
    walletRelayerHandler: async (_request, result) => {
      calls.push("relayer");
      return result.status(200).json({ route: "relayer" });
    },
  });
  for (const route of ["setup", "session", "relayer"]) {
    const result = response();
    await handler({ method: "POST", query: { walletRoute: route }, headers: {}, body: {} }, result);
    assert.equal(result.statusCode, 200);
    assert.equal(result.body.route, route);
  }
  assert.deepEqual(calls, ["setup", "session", "relayer"]);
});

test("wallet session API completes challenge authentication without granting an action", async () => {
  let now = 1_000;
  let nonce = 0;
  const auth = createWalletSetupAuth({
    secret: SECRET,
    now: () => now,
    randomBytes: (size) => Buffer.alloc(size, ++nonce),
  });
  const handler = createWalletSessionHandler({ auth, apiGuard: passGuard, configured: true });
  const account = privateKeyToAccount(KEY);

  const challenged = response();
  await handler({
    method: "POST",
    headers: {},
    body: { action: "challenge", wallet: account.address },
  }, challenged);
  assert.equal(challenged.statusCode, 200);
  assert.equal(challenged.body.permissions.deploy, false);

  const signature = await account.signMessage({ message: challenged.body.message });
  now += 1;
  const authenticated = response();
  await handler({
    method: "POST",
    headers: {},
    body: {
      action: "authenticate",
      challengeToken: challenged.body.challengeToken,
      signature,
    },
  }, authenticated);
  assert.equal(authenticated.statusCode, 200);
  assert.equal(authenticated.body.wallet, account.address);
  assert.equal(authenticated.headers["cache-control"], "no-store");
});

test("inactive browser setup rejects session and relayer calls before creating any wallet capability", async () => {
  const inactiveSession = createWalletSessionHandler({ configured: false });
  const sessionResult = response();
  await inactiveSession({ method: "POST", headers: {}, body: { action: "challenge", wallet: DEPOSIT_WALLET } }, sessionResult);
  assert.equal(sessionResult.statusCode, 503);
  assert.equal(sessionResult.body.error.code, "browser_setup_inactive");

  let called = false;
  const inactiveRelayer = createWalletRelayerHandler({
    configured: false,
    relayer: { run: async () => { called = true; } },
  });
  const relayerResult = response();
  await inactiveRelayer({ method: "POST", headers: {}, body: { operation: "submit" } }, relayerResult);
  assert.equal(relayerResult.statusCode, 503);
  assert.equal(relayerResult.body.error.code, "browser_setup_inactive");
  assert.equal(called, false);
});

test("a configured relayer path validates Polygon verification before submitting a deployment", async () => {
  let now = 2_500;
  const state = createInMemoryWalletSetupState({ now: () => now * 1_000 });
  const auth = createWalletSetupAuth({
    secret: SECRET,
    now: () => now,
    randomBytes: (size) => Buffer.alloc(size, 4),
    state,
  });
  const account = privateKeyToAccount(KEY);
  const authenticated = await authenticatedSession(auth, account);
  const session = auth.verifySession(authenticated.sessionToken);
  const challenge = auth.issueDeploymentChallenge(session);
  const consent = await auth.authorizeDeployment({
    deploymentChallengeToken: challenge.deploymentChallengeToken,
    signature: await account.signMessage({ message: challenge.message }),
    session,
  });
  let relayerCalled = false;
  const handler = createWalletRelayerHandler({
    configured: true,
    auth,
    state,
    apiGuard: passGuard,
    relayer: { run: async () => { relayerCalled = true; throw new Error("must not submit"); } },
  });
  const result = response();
  await handler({
    method: "POST",
    headers: { authorization: `Bearer ${authenticated.sessionToken}` },
    body: {
      operation: "submit",
      request: JSON.stringify({ type: "WALLET-CREATE", from: account.address, to: DEPOSIT_WALLET_FACTORY }),
      deploymentConsentToken: consent.deploymentConsentToken,
    },
  }, result);
  assert.equal(result.statusCode, 503);
  assert.equal(result.body.error.code, "polygon_rpc_unavailable");
  assert.equal(relayerCalled, false);
});

test("wallet relayer API requires a session bearer and passes no credentials to the response", async () => {
  const account = privateKeyToAccount(KEY);
  const auth = createWalletSetupAuth({
    secret: SECRET,
    now: () => 2_000,
    randomBytes: (size) => Buffer.alloc(size, 7),
  });
  const challenge = auth.issueChallenge(account.address);
  const authenticated = await auth.authenticate({
    challengeToken: challenge.challengeToken,
    signature: await account.signMessage({ message: challenge.message }),
  });
  const observed = [];
  const handler = createWalletRelayerHandler({
    auth,
    apiGuard: passGuard,
    configured: true,
    relayer: {
      run: async (input) => {
        observed.push(input);
        if (input.operation === "builder-auth") {
          return { ok: true, operation: "builder-auth", authentication: "builder" };
        }
        return { ok: true, relayer: { nonce: "3" } };
      },
    },
  });
  const result = response();
  await handler({
    method: "POST",
    headers: { authorization: `Bearer ${authenticated.sessionToken}` },
    body: { operation: "nonce" },
  }, result);
  assert.equal(result.statusCode, 200);
  assert.equal(observed[0].session.wallet, account.address);
  assert.equal(JSON.stringify(result.body).includes("secret"), false);

  const authResult = response();
  await handler({
    method: "POST",
    headers: { authorization: `Bearer ${authenticated.sessionToken}` },
    body: { operation: "auth" },
  }, authResult);
  assert.equal(authResult.statusCode, 200);
  assert.equal(observed[1].operation, "builder-auth");
  assert.deepEqual(authResult.body, { ok: true, operation: "builder-auth", authentication: "builder" });

  const unauthenticated = response();
  await handler({
    method: "POST",
    headers: {},
    body: { operation: "nonce" },
  }, unauthenticated);
  assert.equal(unauthenticated.statusCode, 401);
  assert.equal(unauthenticated.body.error.code, "invalid_wallet_session");
});

test("wallet relayer requires separate deployment consent, session-bound polling, factory verification, and a confirmed wallet before approval", async () => {
  let now = 3_000;
  let counter = 0;
  const state = createInMemoryWalletSetupState({ now: () => now * 1_000 });
  const auth = createWalletSetupAuth({
    secret: SECRET,
    now: () => now,
    randomBytes: (size) => Buffer.alloc(size, ++counter),
    state,
  });
  const account = privateKeyToAccount(KEY);
  const authenticated = await authenticatedSession(auth, account);
  const verifiedSession = auth.verifySession(authenticated.sessionToken);
  const observed = [];
  const relayer = {
    async run(input) {
      observed.push(input);
      if (input.operation === "nonce") return { ok: true, relayer: { nonce: "7" } };
      if (input.operation === "submit") {
        const body = JSON.parse(input.body.request);
        if (body.type === "WALLET-CREATE") {
          return { ok: true, action: "DEPLOY_DEPOSIT_WALLET", relayer: { transactionId: "deploy-1", state: "STATE_NEW" } };
        }
        return { ok: true, action: "APPROVE_DEPOSIT_WALLET", relayer: { transactionId: "approve-1", state: "STATE_NEW" } };
      }
      if (input.operation === "transaction" && input.body.transactionId === "deploy-1") {
        return {
          ok: true,
          relayer: {
            transactionId: "deploy-1",
            state: "STATE_CONFIRMED",
            transactionHash: DEPLOY_TX,
            from: account.address,
            to: DEPOSIT_WALLET_FACTORY,
            proxyAddress: DEPOSIT_WALLET,
            type: "WALLET-CREATE",
          },
        };
      }
      return {
        ok: true,
        relayer: {
          transactionId: "approve-1",
          state: "STATE_CONFIRMED",
          transactionHash: APPROVAL_TX,
          from: account.address,
          to: DEPOSIT_WALLET_FACTORY,
          proxyAddress: DEPOSIT_WALLET,
          type: "WALLET",
        },
      };
    },
  };
  const verifier = {
    async verifyDeployment(input) {
      assert.equal(input.owner, account.address);
      assert.equal(input.expectedWallet, DEPOSIT_WALLET);
      return { wallet: DEPOSIT_WALLET, transactionHash: DEPLOY_TX, blockNumber: "0x123" };
    },
    async verifyApprovals(input) {
      assert.equal(input.wallet, DEPOSIT_WALLET);
      return { wallet: DEPOSIT_WALLET, transactionHash: APPROVAL_TX, approvalCalls: 5 };
    },
  };
  const handler = createWalletRelayerHandler({ auth, state, relayer, verifier, apiGuard: passGuard, configured: true });
  const header = { authorization: `Bearer ${authenticated.sessionToken}` };
  const createRequest = JSON.stringify({
    type: "WALLET-CREATE",
    from: account.address,
    to: DEPOSIT_WALLET_FACTORY,
  });

  const withoutConsent = response();
  await handler({ method: "POST", headers: header, body: { operation: "submit", request: createRequest } }, withoutConsent);
  assert.equal(withoutConsent.statusCode, 401);
  assert.equal(withoutConsent.body.error.code, "invalid_wallet_session");

  const deploymentChallenge = auth.issueDeploymentChallenge(verifiedSession);
  const deploymentConsent = await auth.authorizeDeployment({
    deploymentChallengeToken: deploymentChallenge.deploymentChallengeToken,
    signature: await account.signMessage({ message: deploymentChallenge.message }),
    session: verifiedSession,
  });
  const create = response();
  await handler({
    method: "POST",
    headers: header,
    body: {
      operation: "submit",
      request: createRequest,
      deploymentConsentToken: deploymentConsent.deploymentConsentToken,
    },
  }, create);
  assert.equal(create.statusCode, 200);
  assert.equal(create.body.state, "STATE_NEW");
  assert.equal(typeof create.body.pollToken, "string");
  assert.equal(JSON.stringify(create.body).includes("transactionId"), false);

  const deployed = response();
  await handler({ method: "POST", headers: header, body: { operation: "transaction", pollToken: create.body.pollToken } }, deployed);
  assert.equal(deployed.statusCode, 200);
  assert.equal(deployed.body.status, "confirmed");
  assert.equal(deployed.body.depositWallet, DEPOSIT_WALLET);

  const approval = response();
  await handler({
    method: "POST",
    headers: header,
    body: { operation: "submit", request: await approvalRequest(account) },
  }, approval);
  assert.equal(approval.statusCode, 200);
  const approved = response();
  await handler({ method: "POST", headers: header, body: { operation: "transaction", pollToken: approval.body.pollToken } }, approved);
  assert.equal(approved.statusCode, 200);
  assert.equal(approved.body.status, "confirmed");
  assert.equal(approved.body.approvalCalls, 5);
  assert.equal(observed.filter((entry) => entry.operation === "transaction").length, 2);
});

test("wallet relayer rejects approval submission before a factory-confirmed Deposit Wallet exists", async () => {
  let now = 4_000;
  const state = createInMemoryWalletSetupState({ now: () => now * 1_000 });
  const auth = createWalletSetupAuth({
    secret: SECRET,
    now: () => now,
    randomBytes: (size) => Buffer.alloc(size, 9),
    state,
  });
  const account = privateKeyToAccount(KEY);
  const authenticated = await authenticatedSession(auth, account);
  const handler = createWalletRelayerHandler({
    auth,
    state,
    apiGuard: passGuard,
    relayer: { run: async () => { throw new Error("must not call relayer"); } },
    verifier: {},
    configured: true,
  });
  const result = response();
  await handler({
    method: "POST",
    headers: { authorization: `Bearer ${authenticated.sessionToken}` },
    body: { operation: "submit", request: await approvalRequest(account, { deadline: "4300" }) },
  }, result);
  assert.equal(result.statusCode, 409);
  assert.equal(result.body.error.code, "deposit_wallet_not_confirmed");
});
