# Conviction ASP Listing and Target Catalog

Status: Conviction ASP `#7034` is listed with the final two-service catalog submitted on 2026-07-22. The update transaction is `0x861be48333c6ec751ea615b4122816509cfe0679b92b555ffa5815824055cf60`. Production v0.4.21 keeps the submitted names, prices, endpoints, and outcome promise while adding a browser-native OPEN journey for already-ready buyer-controlled Polymarket deposit wallets. It preserves the agent/plugin route, refuses unsupported buyers before payment, rechecks wallet ownership, code, venue approvals, and pUSD balance, separates x402 payment from trade consent, uses the official browser SDK, and returns the existing issuer-signed Polygon proof. The browser path remains labeled acceptance-pending until a fresh controlled live run completes.

Registration transaction: `0x29fa8a07669fd30b3953e02c148dbb17827b179cd55058f2214bad0df4e78fa6`

## Agent

Name: `Conviction`

Tagline: `Choose a side. Bound the trade. Prove the fill.`

Description:

> Conviction turns your prediction-market call into a real YES or NO position: you set the budget and maximum price, your own wallet signs and holds the fill, and every order is bounded and independently verifiable on Polygon.

Avatar: `assets/conviction-avatar-square.png` (full-bleed 1:1 marketplace asset)

## OPEN service

Name: `Bounded YES/NO Position`

Type: `API service`

Fee payload value: `"0.05"`

Displayed price: `0.05 USDT`

Endpoint: `https://conviction-bay.vercel.app/api/service`

Service description, exactly two lines:

```text
Opens one bounded YES or NO position from a ready buyer-controlled Polymarket deposit wallet after one explicit trade confirmation. Every fill returns a verifiable Polygon proof.
Provide: market URL or slug, YES or NO, total pUSD budget of at least 1 pUSD, maximum price, buyer wallet, and optional rationale.
```

Inputs: `market`, `outcome=yes|no`, `spend`, `maxPrice`, `wallet`, `executionMode=deposit-wallet`, `walletReadiness`, `pluginPreview`, `rationale`.

Not included: financial advice, outcome recommendations, signals, custody, recurring/autonomous trading, leverage, neg-risk/categorical markets, or guaranteed profit.

The paid endpoint compiles the bounded pre-execution card only. Companion receipt verification is a free proof route, not another paid product and not part of this service call.

The public website keeps a free interactive preview. The listed fee is for the standard machine-to-machine payment and delivery path, not exclusive access to the underlying compiler.

## Position Manager service

Name: `Bounded Position Manager`

Type: `API service`

Fee payload value: `"0.10"`

Displayed price: `0.10 USDT`

Endpoint: `https://conviction-bay.vercel.app/api/manage`

Target description, exactly two lines:

```text
Manages one verified OPEN per paid call: exact-share FOK CLOSE above a floor, or post-only GTD TAKE_PROFIT with status and exact cancellation. It never recommends an outcome or holds keys.
Provide: CLOSE or TAKE_PROFIT, market, YES or NO, exact whole shares, price floor or target, buyer wallet, verified OPEN proof, TAKE_PROFIT expiry, and optional rationale.
```

`CLOSE` and `TAKE_PROFIT` are action variants of this one paid Position Manager product. Each paid delivery compiles one source-bound manager card; payment never authorizes the Polygon order. CLOSE later uses the free CLOSE receipt verifier. TAKE_PROFIT immediately returns an authenticated initial CLOB-order binding: a zero-match live order is `ARMED`, while a first-fetch match or venue-state transition returns a recoverable submitted-order binding pending reconciliation and any required Polygon proof. Read-only status independently verifies later partial or full Polygon fills, and exact-order cancellation requires separate consent.

## Review sample

Use the canonical request in `docs/SERVICE_CONTRACT.md`. The paid response must return a bounded YES or NO execution card with the user-selected outcome, fee-inclusive budget, price cap, FAK order arguments, and user confirmation still required. It must not claim that the compile response verifies a later receipt.

## Review state

- Identity and service copy: owner-approved
- Submitted service list: exactly two paid services at `0.05 USDT` and `0.10 USDT`
- Final catalog update transaction: `0x861be48333c6ec751ea615b4122816509cfe0679b92b555ffa5815824055cf60`
- Controlled live acceptance: OPEN, CLOSE, and TAKE_PROFIT passed on 2026-07-22 with one payment and one confirmation per action; TAKE_PROFIT was canceled at zero fill after proof
- Listing validation: passed once for the final two-service update
- Agent creation: complete as `#7034`
- Activation submission: complete
- Marketplace state: final update submitted 2026-07-22; approval pending
- Public listing: pending OKX approval
