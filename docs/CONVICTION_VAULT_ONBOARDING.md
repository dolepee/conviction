# Conviction browser wallet onboarding

Status: the browser wallet-setup lane is deployed. It advertises activation only after a server-side, read-only Builder-authorization check succeeds, then can connect a browser EVM wallet, authenticate wallet ownership, deploy the buyer-controlled Polymarket Deposit Wallet, and submit the official five-call venue approval batch after two explicit consents. A failed Builder check stops before connection, deployment, funding, payment, or trade.

The browser OPEN adapter is implemented in source and remains unproven live until a controlled funded acceptance run completes. It adds a free preview, an exact 0.05 USD₮0 buyer-local x402 confirmation on X Layer, a fresh issuer-signed card, a separate trade confirmation, an official Polymarket TypeScript SDK FAK BUY from the Deposit Wallet, and the existing issuer-signed Polygon receipt proof. It does not fund or bridge assets, and it does not manage an existing position.

## Why this exists

Conviction's existing paid OPEN path is intentionally limited to an already-ready buyer-controlled Polymarket Deposit Wallet. A fresh OKX Agentic Wallet cannot complete Polymarket's current official Deposit Wallet setup when its policy refuses the venue's maximum pUSD allowances and ERC-1155 operator approvals.

The separate onboarding path uses Polymarket's current official Builder route: a buyer-controlled browser EVM signer, server-held Builder credentials, and the official relayer. A dedicated Relayer API key may authorize operations only for its exact associated account; it cannot replace Builder authentication when creating Deposit Wallets for new buyers. The path does not bypass an Agentic Wallet policy and it never takes custody of a buyer key or CLOB credential. After setup, the browser adapter keeps the buyer's ephemeral CLOB authentication local and executes only after the paid card is displayed and the buyer gives separate trade consent. The existing agent/plugin paid route remains unchanged.

## Implemented boundary

`GET /api/wallet-setup` publishes the no-secret capability contract and performs a server-side, read-only Builder-relayer authorization probe. It reports `BROWSER_SETUP_BETA_READY` only when the seven activation prerequisites are present and the probe succeeds; otherwise it returns an explicit no-write status. The session-bound browser flow repeats the same check after a buyer signs only the wallet-session authentication message, before it enables deployment consent. `/wallet-setup` remains disabled unless the contract reports `BROWSER_SETUP_BETA_READY`, and it stops before any connection, deployment, or funding if Builder authorization is unavailable.

`POST /api/wallet-session` issues a two-minute wallet challenge, verifies the buyer's message signature, and returns a ten-minute wallet-bound session. The authentication signature explicitly grants no deploy, approval, funding, payment, or trading authority. A separate one-time, wallet-signed deployment-consent message is required before the server may submit a wallet-create request.

`POST /api/wallet-relayer` is a fixed-origin proxy to `https://relayer-v2.polymarket.com`. It accepts only four operations:

- an authenticated, read-only Builder authorization check before deployment consent is enabled;
- a nonce lookup scoped to the authenticated buyer;
- `POST /submit` for either the exact official Deposit Wallet factory create request or the exact official five-call approval batch;
- polling only via a short-lived, HMAC-signed capability minted for the exact relayer transaction returned to that buyer session.

The server rejects noncanonical JSON, extra fields, another buyer, another factory, another method or path, a deadline beyond five minutes, a substituted call, and a batch whose EIP-712 signature does not recover the authenticated buyer. Builder credentials are mandatory for new-buyer wallet creation and are used only after validation. An optional Relayer key is accepted only when its authorized address matches the active buyer. Neither credential leaves the server.

The relayer wallet nonce makes approval-batch replay fail closed. Wallet creation is factory-idempotent. Durable Redis-compatible state consumes authentication and deployment-consent nonces exactly once, binds the relayer transaction to the buyer session, and stores the factory-verified Deposit Wallet before the approval batch can proceed. A fixed server-side Polygon RPC must confirm the factory deployment event and deployed code; it must then confirm both pUSD allowances and all three CTF operator approvals before the UI reports readiness.

Before presenting an x402 signature request, the paid service independently rechecks the factory owner binding, deployed code, all five current venue permissions, and that the Deposit Wallet holds at least the buyer's stated pUSD budget. Browser readiness is a distinct `browser-deposit-wallet` execution mode; it cannot satisfy or weaken the official agent/plugin preview contract.

## Activation sequence

1. Create a Polymarket Builder profile and Builder API credentials at `polymarket.com → Settings → Builders`. These credentials are mandatory for creating Deposit Wallets for new buyers.
2. Store the Builder key, secret, and passphrase only in encrypted server environment variables. An optional Relayer API key and address receive the same treatment but may be used only for their exact associated account. They must never enter browser JavaScript, Git, client logs, x402 responses, or chat.
3. Generate an independent random `CONVICTION_WALLET_SESSION_SECRET` with at least 32 bytes and store it only in the encrypted server environment.
4. Configure a server-only Redis-compatible REST endpoint and token as `CONVICTION_WALLET_STATE_REST_URL` and `CONVICTION_WALLET_STATE_REST_TOKEN`, or use Vercel's injected `KV_REST_API_URL` and `KV_REST_API_TOKEN`; do not activate with in-memory state.
5. Configure `CONVICTION_POLYGON_RPC_URL` as a fixed server-side Polygon RPC used only for receipt, wallet-code, and approval-state verification.
6. Deploy a preview and confirm configuration failures remain fail closed.
7. In a controlled unfunded browser test, explicitly consent to wallet deployment and verify the submitted Polygon receipt plus the factory's buyer-wallet deployment event.
8. Review the exact venue-managed disclosure and explicitly consent to the five-call approval batch: two maximum pUSD allowances and three blanket CTF operator approvals. The current official flow exposes no Deposit Wallet revoke command.
9. Verify the approval transaction, derived wallet identity, and readiness output before giving any funding instruction.
10. Run a controlled funded browser acceptance: preview, x402 payment, signed card, separate trade consent, buyer-held Polygon fill, and issuer-signed proof. Do not call the browser adapter production-verified before that run passes.

## Non-negotiable controls

- Never accept a buyer private key or browser-wallet seed phrase.
- Never expose Relayer or Builder credentials.
- Never make the Builder-signing endpoint an unauthenticated HMAC oracle.
- Bind every relayer request to the authenticated buyer signer, a one-time deployment consent, and the factory-verified buyer Deposit Wallet.
- Allowlist only official wallet-create and approval batch request shapes.
- Use durable one-time state and edge rate limits; rely on the factory and wallet nonce for on-chain idempotency, and expose failed Polygon receipts as terminal failures.
- Keep deployment consent, approval consent, service payment consent, and trade consent as separate events.
- Do not claim the browser execution adapter is live-proven until the funded acceptance run has produced both chain receipts and the issuer-signed proof.

## Source of truth

- [Polymarket: Deposit Wallets](https://docs.polymarket.com/trading/deposit-wallets)
- [Polymarket: Builder Program](https://docs.polymarket.com/builders/overview)
- [Polymarket: Builder tiers](https://docs.polymarket.com/builders/tiers)
- [Polymarket Builder Relayer Client](https://github.com/Polymarket/builder-relayer-client)
