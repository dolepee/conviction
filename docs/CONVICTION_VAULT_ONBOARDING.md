# Conviction browser wallet onboarding

Status: implemented behind a configuration gate and not activated in production. When activated, it can connect a browser EVM wallet, authenticate wallet ownership, deploy the buyer-controlled Polymarket Deposit Wallet, and submit the official five-call venue approval batch after two explicit consents. It cannot fund, bridge, collect a Conviction payment, place an order, or manage a position.

## Why this exists

Conviction's existing paid OPEN path is intentionally limited to an already-ready buyer-controlled Polymarket Deposit Wallet. A fresh OKX Agentic Wallet cannot complete Polymarket's current official Deposit Wallet setup when its policy refuses the venue's maximum pUSD allowances and ERC-1155 operator approvals.

The separate onboarding path uses Polymarket's current Builder route: a buyer-controlled browser EVM signer, server-held Builder credentials, and the official relayer. It does not bypass an Agentic Wallet policy and it never takes custody of a buyer key or CLOB credential. It prepares the venue wallet only. The existing paid OPEN route remains ready-Deposit-Wallet-only until a separate browser execution adapter passes the same readiness, payment, dry-run, card, consent, and proof invariants.

## Implemented boundary

`GET /api/wallet-setup` publishes the no-secret capability contract and reports only whether all seven activation variables exist. `/wallet-setup` remains disabled unless the contract reports `BROWSER_SETUP_BETA_READY`.

`POST /api/wallet-session` issues a two-minute wallet challenge, verifies the buyer's message signature, and returns a ten-minute wallet-bound session. The authentication signature explicitly grants no deploy, approval, funding, payment, or trading authority. A separate one-time, wallet-signed deployment-consent message is required before the server may submit a wallet-create request.

`POST /api/wallet-relayer` is a fixed-origin proxy to `https://relayer-v2.polymarket.com`. It accepts only three operations:

- a nonce lookup scoped to the authenticated buyer;
- `POST /submit` for either the exact official Deposit Wallet factory create request or the exact official five-call approval batch;
- polling only via a short-lived, HMAC-signed capability minted for the exact relayer transaction returned to that buyer session.

The server rejects noncanonical JSON, extra fields, another buyer, another factory, another method or path, a deadline beyond five minutes, a substituted call, and a batch whose EIP-712 signature does not recover the authenticated buyer. Builder credentials are used only after validation and never leave the server.

The relayer wallet nonce makes approval-batch replay fail closed. Wallet creation is factory-idempotent. Durable Redis-compatible state consumes authentication and deployment-consent nonces exactly once, binds the relayer transaction to the buyer session, and stores the factory-verified Deposit Wallet before the approval batch can proceed. A fixed server-side Polygon RPC must confirm the factory deployment event and deployed code; it must then confirm both pUSD allowances and all three CTF operator approvals before the UI reports readiness.

## Activation sequence

1. Create a Polymarket Builder profile and Builder API credentials at `polymarket.com → Settings → Builders`.
2. Store the API key, secret, and passphrase only in encrypted server environment variables. They must never enter browser JavaScript, Git, client logs, x402 responses, or chat.
3. Generate an independent random `CONVICTION_WALLET_SESSION_SECRET` with at least 32 bytes and store it only in the encrypted server environment.
4. Configure a server-only Redis-compatible REST endpoint and token as `CONVICTION_WALLET_STATE_REST_URL` and `CONVICTION_WALLET_STATE_REST_TOKEN`; do not activate with in-memory state.
5. Configure `CONVICTION_POLYGON_RPC_URL` as a fixed server-side Polygon RPC used only for receipt, wallet-code, and approval-state verification.
6. Deploy a preview and confirm that inactive production remains fail closed.
7. In a controlled unfunded browser test, explicitly consent to wallet deployment and verify the submitted Polygon receipt plus the factory's buyer-wallet deployment event.
8. Review the exact venue-managed disclosure and explicitly consent to the five-call approval batch: two maximum pUSD allowances and three blanket CTF operator approvals. The current official flow exposes no Deposit Wallet revoke command.
9. Verify the approval transaction, derived wallet identity, and readiness output before giving any funding instruction.
10. Build and prove a separate browser execution adapter. It must reproduce Conviction's ready-wallet, X Layer payment, exact dry-run/card, trade-consent, and receipt-proof invariants before it can replace the current Agentic Wallet route.

## Non-negotiable controls

- Never accept a buyer private key or browser-wallet seed phrase.
- Never expose Builder credentials.
- Never make the Builder-signing endpoint an unauthenticated HMAC oracle.
- Bind every relayer request to the authenticated buyer signer, a one-time deployment consent, and the factory-verified buyer Deposit Wallet.
- Allowlist only official wallet-create and approval batch request shapes.
- Use durable one-time state and edge rate limits; rely on the factory and wallet nonce for on-chain idempotency, and expose failed Polygon receipts as terminal failures.
- Keep deployment consent, approval consent, service payment consent, and trade consent as separate events.
- Do not claim compatibility with the existing native Agentic Wallet runner until the browser adapter has passed the same readiness and exact dry-run/card invariants.

## Source of truth

- [Polymarket: Deposit Wallets](https://docs.polymarket.com/trading/deposit-wallets)
- [Polymarket: Builder Program](https://docs.polymarket.com/builders/overview)
- [Polymarket: Builder tiers](https://docs.polymarket.com/builders/tiers)
- [Polymarket Builder Relayer Client](https://github.com/Polymarket/builder-relayer-client)
