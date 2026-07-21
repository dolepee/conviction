# Conviction ASP Listing and Target Catalog

Status: Conviction ASP `#7034` was created and submitted for marketplace review on 2026-07-21 with the single service recorded below; `Listing under review` is the last confirmed state from that date, not a live status assertion. The paid route is deployed, and an exact `0.05 USD₮0` controlled house payment settled successfully before delivering the bounded card. Do not create or resubmit the identity unless OKX returns a rejection requiring a specific change.

Registration transaction: `0x29fa8a07669fd30b3953e02c148dbb17827b179cd55058f2214bad0df4e78fa6`

## Agent

Name: `Conviction`

Tagline: `Choose a side. Bound the trade. Prove the fill.`

Description:

> Conviction turns your prediction-market call into a real YES or NO position: you set the budget and maximum price, your own wallet signs and holds the fill, and every order is bounded and independently verifiable on Polygon.

Avatar: `assets/conviction-avatar-square.png` (full-bleed 1:1 marketplace asset)

## Current registered service

Name: `Bounded YES/NO Position Card`

Type: `API service`

Fee payload value: `"0.05"`

Displayed price: `0.05 USDT`

Endpoint: `https://conviction-bay.vercel.app/api/service`

Service description, exactly two lines:

```text
Turns your chosen market side into a ready-to-sign YES or NO position card with a fee-inclusive budget and hard maximum price.
Provide: 1. market URL or slug 2. YES or NO 3. total pUSD budget 4. maximum price 5. buyer wallet 6. optional rationale.
```

Inputs: `market`, `outcome=yes|no`, `spend`, `maxPrice`, `wallet`, `rationale`.

Not included: financial advice, outcome recommendations, signals, custody, recurring/autonomous trading, leverage, neg-risk/categorical markets, or guaranteed profit.

The paid endpoint compiles the bounded pre-execution card only. Companion receipt verification is a free proof route, not another paid product and not part of this service call.

The public website keeps a free interactive preview. The listed fee is for the standard machine-to-machine payment and delivery path, not exclusive access to the underlying compiler.

## Target second service after team review

This service is implemented in the release but is **not** registered or active in the marketplace yet. Do not edit the listing under review or submit this addition until the team reruns the complete review against the final deployed release.

Name: `Bounded Position Manager`

Type: `API service`

Fee payload value: `"0.10"`

Displayed price: `0.10 USDT`

Endpoint: `https://conviction-bay.vercel.app/api/manage`

Target description, exactly two lines:

```text
Manages a verified Conviction position with one explicit action: close exact whole shares now above your floor, or arm one post-only take-profit at your target and expiry.
Provide: action CLOSE or TAKE_PROFIT, market, YES or NO, exact whole shares, price floor or target, buyer wallet, verified OPEN source, and optional rationale.
```

`CLOSE` and `TAKE_PROFIT` are action variants of this one paid Position Manager product. Each paid delivery compiles one source-bound manager card; payment never authorizes the Polygon order. CLOSE later uses the free CLOSE receipt verifier. TAKE_PROFIT immediately returns an authenticated `ARMED` CLOB-order proof, while read-only status independently verifies any later partial or full Polygon fills and exact-order cancellation requires separate consent.

## Review sample

Use the canonical request in `docs/SERVICE_CONTRACT.md`. The paid response must return a bounded YES or NO execution card with the user-selected outcome, fee-inclusive budget, price cap, FAK order arguments, and user confirmation still required. It must not claim that the compile response verifies a later receipt.

## Review state

- Identity and service copy: owner-approved
- Current registered service list: one service
- Target catalog after final team review: exactly two paid services; Position Manager is not yet registered or activated
- Listing validation: passed once before creation
- Agent creation: complete as `#7034`
- Activation submission: complete
- Marketplace state last confirmed 2026-07-21: `Listing under review`
- Public listing: pending OKX approval
