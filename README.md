# Conviction

Conviction turns your prediction-market call into a real YES or NO position: you set the budget and maximum price, your own wallet signs and holds the fill, and every order is bounded and independently verifiable on Polygon.

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

1. The buyer supplies a Polymarket market, `YES` or `NO`, total pUSD risk budget including fees, maximum price, buyer-controlled deposit wallet, and their own rationale.
2. Conviction resolves both canonical tokens and the selected token's live order book, derives whole-share principal plus a conservative venue-fee reserve, then emits a 30-second execution card and deterministic intent hash.
3. The buyer confirms the official Polymarket plugin call in their own Agentic Wallet.
4. Conviction derives principal, fee, total debit, and shares from Polygon events and binds them to the original intent, wallet, selected token, economic bounds, order ID, exchange, and chain.

The full wire contract is in [`docs/SERVICE_CONTRACT.md`](docs/SERVICE_CONTRACT.md). The OKX.AI listing copy is in [`docs/ASP_LISTING.md`](docs/ASP_LISTING.md).

## Run locally

Requires Node.js 22+ and Python 3.

```sh
npm run gate
npx vercel dev
```

The site is served at `http://localhost:3000`. The API surface is:

- `GET /api/health`
- `POST /api/intent` — free interactive preview used by the public web app
- `/api/service` — payment-protected bounded YES/NO position card (`0.05 USD₮0` on X Layer; business requests use `POST`)
- `POST /api/receipt`

The free preview and paid machine endpoint use the same fail-closed compiler. The
marketplace fee pays for the standard machine-to-machine payment and delivery
path; the human-facing preview intentionally remains free. The paid service pins
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

To compile against the live Polymarket APIs from the CLI:

```sh
npm run intent:live -- \
  will-the-us-invade-iran-before-2027 \
  yes \
  1.35 \
  0.27 \
  0x6a355e4971d9ac2ab97d22c3cf361d42faba33fe \
  "I expect this event to resolve YES and will not pay above 27 cents."
```

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
