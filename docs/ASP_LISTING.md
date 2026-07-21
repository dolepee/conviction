# Conviction ASP Listing

Status: Conviction ASP `#7034` was created and submitted for marketplace review on 2026-07-21 with the single service recorded below. The paid route is deployed, and an exact `0.05 USD₮0` controlled house payment settled successfully before delivering the bounded card. Do not create or resubmit the identity unless OKX returns a rejection requiring a specific change.

Registration transaction: `0x29fa8a07669fd30b3953e02c148dbb17827b179cd55058f2214bad0df4e78fa6`

## Agent

Name: `Conviction`

Tagline: `Choose a side. Bound the trade. Prove the fill.`

Description:

> Conviction turns your prediction-market call into a real YES or NO position: you set the budget and maximum price, your own wallet signs and holds the fill, and every order is bounded and independently verifiable on Polygon.

Avatar: `assets/conviction-avatar-square.png` (full-bleed 1:1 marketplace asset)

## Service

Name: `Bounded YES/NO Position Card`

Type: `API service`

Fee payload value: `"0.05"`

Displayed price: `0.05 USDT`

Endpoint: `https://conviction-bay.vercel.app/api/service`

Service description, exactly two lines:

```text
Turns your chosen market side into a ready-to-sign YES or NO position card with a fee-inclusive budget and hard maximum price.
Provide: 1. market URL or slug 2. YES or NO 3. total pUSD budget 4. maximum price 5. buyer wallet 6. rationale.
```

Inputs: `market`, `outcome=yes|no`, `spend`, `maxPrice`, `wallet`, `rationale`.

Not included: financial advice, outcome recommendations, signals, custody, recurring/autonomous trading, leverage, selling, neg-risk/categorical markets, or guaranteed profit.

The paid endpoint compiles the bounded pre-execution card only. Receipt verification is a separate product route and is not part of this service call.

The public website keeps a free interactive preview. The listed fee is for the standard machine-to-machine payment and delivery path, not exclusive access to the underlying compiler.

## Review sample

Use the canonical request in `docs/SERVICE_CONTRACT.md`. The paid response must return a bounded YES or NO execution card with the user-selected outcome, fee-inclusive budget, price cap, FAK order arguments, and user confirmation still required. It must not claim that the compile response verifies a later receipt.

## Review state

- Identity and service copy: owner-approved
- Complete service list: one service
- Listing validation: passed once before creation
- Agent creation: complete as `#7034`
- Activation submission: complete
- Marketplace state: `Listing under review`
- Public listing: pending OKX approval
