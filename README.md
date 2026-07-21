# Conviction

Conviction turns your prediction-market call into a bounded YES or NO position card: preview the live exposure without a wallet, set the budget and maximum price, carry an exact dry-run request into your own Agentic Wallet, and independently verify any resulting fill on Polygon.

It is deliberately narrow: standard Polymarket V2 binary markets, YES or NO buys, FAK, and a hard maximum price. Conviction does not recommend an outcome, hold keys, accept reusable signatures, or broadcast from the web app.

**Live app:** [conviction-bay.vercel.app](https://conviction-bay.vercel.app)

## Live proof

The canonical house proof bought exactly **5 YES shares** for **1.35 pUSD** at a maximum price of **0.27**.

- Polygon settlement: [`0x25d2a555…fb8a`](https://polygonscan.com/tx/0x25d2a555c1fe20493563136b608c7a566261b1e9eaf7cf594171d97c4489fb8a)
- Polymarket order: `0xbad8f143b0e71f0cf78f3ec268d22e5cffa8b8e9ef7f0821ac720eac94ebf42c`
- Receipt block: `90,598,011`
- Deterministic receipt hash: `0x1746d89ea5c08c5edc214fcca3baf5b3bc6ce7b4ea9d02427dd88035cd4373b3`
- Verified invariants: successful Polygon receipt, standard V2 exchange, exact pUSD payment, exact YES-token receipt, and matching order ID.

This is a controlled house proof, not external traction or financial performance.

## Product loop

1. The buyer pastes one Polymarket market. Conviction reads both YES and NO books without requesting a wallet.
2. The buyer selects the outcome, fee-inclusive pUSD risk budget, and maximum price. A wallet-free preview shows the objective exposure.
3. Only after reviewing those bounds does the buyer bind a dedicated deposit wallet and receive a five-minute position card plus a secure dry-run prompt.
4. The official Polymarket plugin previews the exact request in the buyer's Agentic Wallet and requires a separate live confirmation before any write.
5. Conviction derives principal, fee, total debit, and shares from Polygon events and binds them to the original intent, wallet, selected token, economic bounds, order ID, exchange, and chain.

The full wire contract is in [`docs/SERVICE_CONTRACT.md`](docs/SERVICE_CONTRACT.md). The OKX.AI listing copy is in [`docs/ASP_LISTING.md`](docs/ASP_LISTING.md).

## Run locally

Requires Node.js 22+ and Python 3.

```sh
npm run gate
npx vercel dev
```

The site is served at `http://localhost:3000`. The API surface is:

- `GET /api/health`
- `POST /api/market` — wallet-free lookup of both live outcome books
- `POST /api/preview` — wallet-free economic preview; never executable
- `POST /api/intent` — fresh wallet-bound card used by the public web app
- `/api/service` — payment-protected bounded YES/NO position card (`0.05 USD₮0` on X Layer; business requests use `POST`)
- `POST /api/receipt`

The free preview, final public card, and paid machine endpoint use the same fail-closed economic core. The
marketplace fee pays for the standard machine-to-machine payment and delivery
path; the human-facing market and bounds previews intentionally remain free. The paid service pins
its payment requirement to X Layer mainnet, exactly
`0.05 USD₮0`, and the project owner address. It requires `OKX_API_KEY`,
`OKX_SECRET_KEY`, and `OKX_PASSPHRASE` in the server environment. An unpaid
request receives a standard payment challenge. Invalid compile requests are not
settled, and a successful response is withheld if settlement fails.

Before deploying seller credentials, verify that the key is payment-enabled,
then verify the deployed challenge:

```sh
npm run payment:preflight
npm run service:verify
```

To compile against the live Polymarket APIs from the CLI, supply your own current market and dedicated wallet:

```sh
npm run intent:live -- \
  <polymarket-url-or-slug> \
  <yes-or-no> \
  <fee-inclusive-budget> \
  <maximum-price> \
  <dedicated-deposit-wallet> \
  "<optional 20-500 character note>"
```

The public [privacy](https://conviction-bay.vercel.app/privacy.html) and [terms](https://conviction-bay.vercel.app/terms.html) pages state exactly what is processed, what the paid service delivers, and which wallet and approval steps remain third-party operations.

## Verification gate

```sh
npm run gate
```

The gate checks JavaScript and Python syntax, deterministic YES/NO intent compilation, outcome-specific market resolution, server-computed exposure, stale/price/liquidity/rounding refusal paths, intent and receipt substitution, the exact payment challenge, launch-surface markers, and A2A buyer/reviewer/secret-refusal behavior.

## Operational boundary

New Polymarket deposit-wallet setup currently grants max pUSD allowances and blanket ERC-1155 approvals to official Polymarket exchange contracts. Conviction discloses this before execution and recommends a dedicated low-balance wallet. The current official plugin has no revoke command.

Polymarket V2 applies fees at match time rather than in the signed order. Conviction's fee ceiling is therefore enforced before execution by keeping the dedicated wallet balance at or below the requested budget, then checked after settlement against the fee recorded in the selected `OrderFilled` event. Gas is separate.

Never send Conviction a seed phrase, private key, bearer token, CLOB credential, reusable signature, or raw transaction authorization.

## Status

- Live controlled execution: complete
- Intent compiler and receipt verifier: complete
- Judge-facing web surface: deployed and live-verified
- Paid OKX.AI service endpoint: deployed; exact `0.05 USD₮0` payment settled and bounded card delivered with 118 seconds remaining ([X Layer transaction](https://www.oklink.com/xlayer/tx/0xb86bec4537095d4ef771a975fbf73196565f1a6d947ceb953e0d930480ed0eaf))
- OKX.AI ASP: Conviction `#7034` registered with one `0.05 USDT` service and currently under marketplace review; external buyer proof remains pending

The paid call is a controlled house proof between house wallets. It proves the
machine-payment and delivery path, not external revenue or traction.

Built for OKX.AI Genesis.
