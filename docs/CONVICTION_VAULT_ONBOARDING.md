# Conviction Vault onboarding feasibility

Status: Phase A scaffold only. It cannot connect a wallet, accept a key or credential, create a Deposit Wallet, submit an approval, fund a wallet, collect payment, or trade.

## Why this exists

Conviction's existing paid OPEN path is intentionally limited to an already-ready buyer-controlled Polymarket Deposit Wallet. A fresh OKX Agentic Wallet cannot complete Polymarket's current official Deposit Wallet setup when its policy refuses the venue's maximum pUSD allowances and ERC-1155 operator approvals.

The separate onboarding product will use Polymarket's current Builder route: a buyer-controlled browser or embedded EVM signer, server-held Builder credentials, and the official relayer. It does not bypass an Agentic Wallet policy and it must never take custody of a buyer key or CLOB credential. The existing Conviction application has no browser wallet connector, browser execution adapter, or browser X Layer payer integration today; this scaffold does not claim that a Builder-created wallet can use the current native Agentic Wallet runner.

## Phase A — this release

`GET /api/wallet-setup` publishes a static feasibility contract. It makes no network calls, reads no environment variables, and accepts no input. Its purpose is to establish the public no-write boundary before any Builder credential is configured.

## Activation sequence

1. Create a Polymarket Builder profile and Builder API credentials at `polymarket.com → Settings → Builders`.
2. Store the API key, secret, and passphrase only in encrypted server environment variables. They must never enter browser JavaScript, Git, client logs, x402 responses, or chat.
3. Move the Builder adapter to Node 24+ because the current official TypeScript SDK requires it. Do not silently change the existing Node 22 production runtime.
4. Add an authenticated, wallet-bound browser session and a tightly allowlisted server-side Builder-signing gateway.
5. In a controlled unfunded test, have the buyer explicitly consent to a wallet deployment; poll the official relayer until it is confirmed.
6. Show the exact venue-managed approval disclosure and require a second explicit buyer consent for the approval batch. Conviction's authoritative readiness contract discloses the official five-call setup used by its supported route: two maximum pUSD allowances and three blanket ERC-1155 operator approvals. The current CLI does not offer a Deposit Wallet approval-revoke command.
7. Build and prove a separate browser execution adapter: it must independently reproduce Conviction's ready-wallet checks and exact official dry-run/card invariants before it can request X Layer payment or execution. The existing native Agentic Wallet paid OPEN route remains unchanged and ready-Deposit-Wallet-only.
8. Only after that browser adapter independently verifies a ready Deposit Wallet and buyer-controlled X Layer payer can a buyer fund it and start a paid OPEN journey.

## Non-negotiable controls

- Never accept a buyer private key or browser-wallet seed phrase.
- Never expose Builder credentials.
- Never make the Builder-signing endpoint an unauthenticated HMAC oracle.
- Bind every relayer request to the authenticated buyer signer and deterministic Deposit Wallet.
- Allowlist only official wallet-create and approval batch request shapes.
- Rate-limit creation, persist idempotency/replay state, and expose `STATE_FAILED` / `STATE_INVALID` as terminal failures.
- Keep deployment consent, approval consent, service payment consent, and trade consent as separate events.
- Do not claim compatibility with the existing native Agentic Wallet runner until the browser adapter has passed the same readiness and exact dry-run/card invariants.

## Source of truth

- [Polymarket: Wallets and Authentication](https://docs.polymarket.com/trading/wallets-auth)
- [Polymarket: Builder Program](https://docs.polymarket.com/programs/builders/overview)
- [Polymarket TypeScript SDK](https://github.com/Polymarket/ts-sdk)
