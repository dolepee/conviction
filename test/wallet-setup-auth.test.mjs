import assert from "node:assert/strict";
import test from "node:test";

import { privateKeyToAccount } from "viem/accounts";

import {
  createWalletSetupAuth,
  WalletSetupAuthError,
} from "../src/wallet-setup-auth.mjs";
import { createInMemoryWalletSetupState } from "../src/wallet-setup-state.mjs";

const ALICE_KEY = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const BOB_KEY = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const SECRET = "wallet-session-secret-that-is-definitely-long-enough";

function authAt(clock) {
  let counter = 0;
  return createWalletSetupAuth({
    secret: SECRET,
    now: () => clock.now,
    randomBytes: (size) => Buffer.alloc(size, ++counter),
    state: createInMemoryWalletSetupState({ now: () => clock.now * 1_000 }),
  });
}

test("wallet challenge authenticates only the signing wallet and grants no action", async () => {
  const clock = { now: 1_000 };
  const auth = authAt(clock);
  const alice = privateKeyToAccount(ALICE_KEY);
  const challenge = auth.issueChallenge(alice.address);
  assert.equal(challenge.permissions.authenticateOnly, true);
  assert.equal(challenge.permissions.deploy, false);
  assert.match(challenge.message, /does not approve, pay, fund, or place a trade/);

  const signature = await alice.signMessage({ message: challenge.message });
  const session = await auth.authenticate({
    challengeToken: challenge.challengeToken,
    signature,
  });
  assert.equal(session.wallet, alice.address);
  assert.equal(auth.verifySession(session.sessionToken).wallet, alice.address);
});

test("wallet challenge rejects a different signer, tampering, and expiry", async () => {
  const clock = { now: 2_000 };
  const auth = authAt(clock);
  const alice = privateKeyToAccount(ALICE_KEY);
  const bob = privateKeyToAccount(BOB_KEY);
  const challenge = auth.issueChallenge(alice.address);
  const wrongSignature = await bob.signMessage({ message: challenge.message });
  await assert.rejects(
    auth.authenticate({ challengeToken: challenge.challengeToken, signature: wrongSignature }),
    (error) => error instanceof WalletSetupAuthError && error.code === "wallet_signature_mismatch",
  );
  await assert.rejects(
    auth.authenticate({
      challengeToken: `${challenge.challengeToken.slice(0, -1)}x`,
      signature: await alice.signMessage({ message: challenge.message }),
    }),
    (error) => error instanceof WalletSetupAuthError && error.code === "invalid_wallet_session",
  );
  clock.now += 121;
  await assert.rejects(
    auth.authenticate({
      challengeToken: challenge.challengeToken,
      signature: await alice.signMessage({ message: challenge.message }),
    }),
    (error) => error instanceof WalletSetupAuthError && error.code === "expired_wallet_session",
  );
});

test("wallet authentication and deployment consent are each one-time and separately signed", async () => {
  const clock = { now: 3_000 };
  const auth = authAt(clock);
  const alice = privateKeyToAccount(ALICE_KEY);
  const challenge = auth.issueChallenge(alice.address);
  const signature = await alice.signMessage({ message: challenge.message });
  const session = await auth.authenticate({ challengeToken: challenge.challengeToken, signature });
  await assert.rejects(
    auth.authenticate({ challengeToken: challenge.challengeToken, signature }),
    (error) => error instanceof WalletSetupAuthError && error.code === "wallet_challenge_used",
  );

  const verifiedSession = auth.verifySession(session.sessionToken);
  const deployChallenge = auth.issueDeploymentChallenge(verifiedSession);
  assert.match(deployChallenge.message, /authorize exactly one deployment/i);
  assert.match(deployChallenge.message, /does not approve tokens, pay Conviction, fund the wallet, or place a trade/i);
  const deploySignature = await alice.signMessage({ message: deployChallenge.message });
  const consent = await auth.authorizeDeployment({
    deploymentChallengeToken: deployChallenge.deploymentChallengeToken,
    signature: deploySignature,
    session: verifiedSession,
  });
  const consumed = await auth.consumeDeploymentConsent(consent.deploymentConsentToken, verifiedSession);
  assert.equal(consumed.wallet, alice.address);
  await assert.rejects(
    auth.consumeDeploymentConsent(consent.deploymentConsentToken, verifiedSession),
    (error) => error instanceof WalletSetupAuthError && error.code === "deployment_consent_used",
  );
});

test("poll capabilities are session-bound and do not authorize another wallet", async () => {
  const clock = { now: 4_000 };
  const auth = authAt(clock);
  const alice = privateKeyToAccount(ALICE_KEY);
  const bob = privateKeyToAccount(BOB_KEY);
  const challenge = auth.issueChallenge(alice.address);
  const session = auth.verifySession((await auth.authenticate({
    challengeToken: challenge.challengeToken,
    signature: await alice.signMessage({ message: challenge.message }),
  })).sessionToken);
  const pollToken = auth.issuePollToken({
    session,
    transactionId: "transaction-1",
    action: "DEPLOY_DEPOSIT_WALLET",
  });
  assert.equal(auth.verifyPollToken(pollToken, session).transactionId, "transaction-1");
  const bobChallenge = auth.issueChallenge(bob.address);
  const bobSession = auth.verifySession((await auth.authenticate({
    challengeToken: bobChallenge.challengeToken,
    signature: await bob.signMessage({ message: bobChallenge.message }),
  })).sessionToken);
  assert.throws(
    () => auth.verifyPollToken(pollToken, bobSession),
    (error) => error instanceof WalletSetupAuthError && error.code === "poll_session_mismatch",
  );
});
