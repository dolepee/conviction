# Conviction

Conviction turns your prediction-market call into a buyer-held, bounded YES or NO position and manages the exit without taking custody. OPEN buys with a fee-inclusive budget and hard maximum price. Position Manager either CLOSES exact whole shares immediately above a hard floor or arms one post-only TAKE_PROFIT order at a target and venue expiry. The buyer's own Agentic Wallet signs and holds every position, while Conviction verifies order identity and resulting fills independently.

There are exactly two paid products: OPEN Position Card at `0.05 USD₮0`, and Position Manager at `0.10 USD₮0` with an explicit `CLOSE` or `TAKE_PROFIT` action. Conviction stays deliberately narrow: standard Polymarket V2 binary markets, YES or NO, bounded FAK buys, source-bound FOK closes, and one source-bound post-only GTD take-profit. It does not recommend an outcome, hold keys, accept reusable signatures, provide stop loss or recurring strategies, or broadcast from the web app.

**Live app:** [conviction-bay.vercel.app](https://conviction-bay.vercel.app)

## Live proof

The controlled house transaction bought exactly **5 YES shares** for **1.35 pUSD** at a price of **0.27**. The verifier retrospectively matches that fill to the canonical wallet, token, amount, fee, shares, and price bounds below.

- Polygon settlement: [`0x25d2a555…fb8a`](https://polygonscan.com/tx/0x25d2a555c1fe20493563136b608c7a566261b1e9eaf7cf594171d97c4489fb8a)
- Polymarket order: `0xbad8f143b0e71f0cf78f3ec268d22e5cffa8b8e9ef7f0821ac720eac94ebf42c`
- Receipt block: `90,598,011`
- Current fee-aware receipt hash: `0x8b51f365e655afe066383c0b405fc4d978a9c08cba76be7680630b34548a13d0`
- Position-proof hash: `0x63fceb5a55d1f061ab139f3f69fb6f3568620e17b516c6d19c42289d0686c244`
- Verified invariants: successful Polygon receipt, standard V2 exchange, exact pUSD debit, exact YES-token receipt, exact venue fee, matching order ID, and every original position-card bound.

The [historical position card](assets/conviction-sample-position-card.json) is an expired,
non-executable v3 artifact retained for reproducibility; the current paid route issues signed v4 cards. The
[controlled proof dossier](assets/conviction-review-deliverable.json) is separate post-fill evidence;
it is not the paid service output.

This is a controlled house proof, not external traction or financial performance.
The reference intent expired before settlement, so the dossier does not claim that the intent predated or caused the fill. It proves deterministic retrospective verification of the fill against those bounds.

## Product loop

### OPEN

1. The buyer pastes one Polymarket market. Conviction reads both YES and NO books without requesting a wallet.
2. The buyer selects the outcome, fee-inclusive pUSD risk budget, and maximum price. A wallet-free preview shows the objective exposure.
3. Only after reviewing those bounds does the buyer bind their configured deposit wallet and receive a five-minute signed position card plus a secure dry-run prompt.
4. The official Polymarket plugin previews the exact request in the buyer's Agentic Wallet and requires a separate live confirmation before any write.
5. Conviction derives principal, fee, total debit, and shares from Polygon events and binds them to the original intent, wallet, selected token, economic bounds, order ID, exchange, and chain.

### CLOSE

1. The buyer supplies the verified OPEN result for the position, chooses an exact whole-share quantity, and sets a minimum sale price.
2. Conviction independently replays that OPEN settlement from Polygon, then checks a fresh seller-wallet balance and standard V2 outcome-token approval.
3. The position manager signs a five-minute CLOSE card only when current bids can fill every requested share at or above the floor. The exact FOK sell either closes all requested shares within those bounds or places no fill.
4. After a separate live confirmation, the public agent/CLI executes the exact card from the buyer's configured deposit wallet and returns an independently verified Polygon close proof in the same session.

A legacy v2/v3 OPEN proof can establish retrospective provenance for CLOSE, but it is not a consumable lot or a one-time authorization. Fresh seller-owned balance is the authority to sell, and the runtime rechecks it before submission. The browser app currently exposes the OPEN preview and verifier; source-bound CLOSE is available through the public agent/CLI and machine APIs.

### TAKE_PROFIT

1. The buyer supplies a verified OPEN result, exact whole shares, target price, and a whole-second UTC venue expiry.
2. Position Manager independently reverifies the OPEN source, seller balance and V2 approval, market tick and minimum size, current best bid, and the complete selected-token SELL reservation set.
3. After the separate manager payment and one fresh trade confirmation, the buyer runtime waits past the confirmation second, repeats every readiness and dry-run check, and places exactly one post-only GTD SELL.
4. The initial result is an authenticated `ARMED` CLOB proof, never a false on-chain fill claim. The five-minute signed card controls placement only; the submitted order can remain live until its venue expiry, a fill, or exact-order cancellation.
5. `tp-status` recovers the pinned order and associated trades. Any partial or full fill is independently re-derived from Polygon receipts and returned as `conviction-take-profit-fill-proof-v1`. It preserves whether the remainder is active, canceled, or expired, and labels included-but-not-finalized Polygon evidence `PROVISIONAL` until the finalized head covers every settlement. Missing or ambiguous CLOB state remains unresolved rather than being mislabeled canceled.
6. `cancel-tp` requires the separate exact phrase `confirm cancel take profit`, cancels only the pinned order ID, and then rechecks for a fill/cancel race.

The browser is a free OPEN preview and manual proof inspector. The repository-backed buyer agent/CLI executes OPEN, CLOSE, and TAKE_PROFIT without asking the user to type plugin commands or visit Polymarket.

The full wire contract is in [`docs/SERVICE_CONTRACT.md`](docs/SERVICE_CONTRACT.md). The OKX.AI listing copy is in [`docs/ASP_LISTING.md`](docs/ASP_LISTING.md).

## Run locally

Requires Node.js 22.x LTS and Python 3.

```sh
npm run gate
npx vercel dev
```

The site is served at `http://localhost:3000`. The API surface is:

- `GET /api/health`
- `POST /api/market` — wallet-free lookup of both live outcome books
- `POST /api/preview` — wallet-free economic preview; never executable
- `POST /api/intent` — fresh wallet-bound card used by the public web app
- `POST /api/service` — payment-protected OPEN card (`0.05 USD₮0` on X Layer)
- `POST /api/receipt` — independently verified OPEN proof
- `POST /api/manage-preview` — free, non-executable Position Manager preview (`action: close|take_profit`)
- `POST /api/manage` — payment-protected Position Manager card (`0.10 USD₮0` on X Layer; `action: close|take_profit`)
- `POST /api/close-receipt` — independently verified CLOSE proof

The free OPEN preview, final public OPEN card, and paid OPEN endpoint use the same fail-closed economic core. Both Position Manager actions share the same source, position, token, approval, and proceeds core, while CLOSE adds fillable FOK bid-depth checks and TAKE_PROFIT adds post-only GTD placement, exact status, trade recovery, fill proof, and exact cancellation. The machine fees pay for x402 settlement and signed-card delivery; previews and proof/status reads remain free. The paid routes pin their payment requirements to X Layer mainnet, exactly `0.05 USD₮0` for OPEN and `0.10 USD₮0` for one manager action, and the project owner address. They require `OKX_API_KEY`,
`OKX_SECRET_KEY`, and `OKX_PASSPHRASE` in the server environment. An unpaid
request receives a standard payment challenge. Invalid compile requests are not
settled, and a successful response is withheld if settlement fails.

Before deploying seller credentials, verify that the key is payment-enabled,
then verify the deployed v0.4 health manifest and both exact bare x402
challenges:

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

### Run the public buyer agent/CLI

The executable skill is repository-backed: clone this release and run or symlink `skills/conviction-executor` from this repository so its pinned helpers retain their `src/` dependencies. Copying the skill directory alone is unsupported.

Prerequisites are Node.js 22, `onchainos`, the official `polymarket-plugin`, an active OKX Agentic Wallet, persisted `deposit-wallet` mode, owner-only local Polymarket CLOB credentials, the pinned production issuer registry, X Layer USD₮0 for the selected service fee, and the required pUSD or outcome shares on Polygon. Conviction never asks the user to type plugin commands during a journey; the runner invokes them and stops only for the distinct payment and trade confirmations.

OPEN:

```sh
node scripts/buyer-orchestrator.mjs open \
  --origin https://conviction-bay.vercel.app \
  --market <polymarket-url-or-slug> --side <YES-or-NO> \
  --budget <fee-inclusive-pUSD> --max-price <price-cap> \
  --payment-payer <x-layer-wallet> --buyer-wallet <polygon-deposit-wallet> \
  --issuer-registry config/trusted-issuer.production.json --json
```

Immediate CLOSE:

```sh
node scripts/buyer-orchestrator.mjs close \
  --origin https://conviction-bay.vercel.app \
  --market <polymarket-url-or-slug> --side <YES-or-NO> \
  --shares <whole-shares> --min-price <price-floor> \
  --payment-payer <x-layer-wallet> --seller-wallet <polygon-deposit-wallet> \
  --source-proof <verified-open-result.json> \
  --issuer-registry config/trusted-issuer.production.json --json
```

Bounded TAKE_PROFIT:

```sh
node scripts/take-profit-orchestrator.mjs take-profit \
  --origin https://conviction-bay.vercel.app \
  --market <polymarket-url-or-slug> --side <YES-or-NO> \
  --shares <whole-shares> --target-price <target> \
  --expires-at <UTC-ISO-whole-second> \
  --payment-payer <x-layer-wallet> --seller-wallet <polygon-deposit-wallet> \
  --source-proof <verified-open-result.json> \
  --issuer-registry config/trusted-issuer.production.json --json
```

Read status and prove any recovered fill without another payment or trade:

```sh
node scripts/take-profit-orchestrator.mjs tp-status \
  --journal <private-take-profit-journey.json> \
  --issuer-registry config/trusted-issuer.production.json --json
```

Cancel only the pinned remaining order after a fresh exact confirmation:

```sh
node scripts/take-profit-orchestrator.mjs cancel-tp \
  --journal <private-take-profit-journey.json> \
  --issuer-registry config/trusted-issuer.production.json --json
```

If cancellation races a fill or Polygon evidence is not finalized yet, the global execution lock remains. Reconcile it without another payment, placement, or cancellation. The same command can bootstrap a passport only from an exact live order ID already persisted before the first CLOB fetch. Before any order exists, it releases a reservation only for an expired authorization proven unused at a finalized X Layer block, or an expired paid card proven never spawned; consumed or ambiguous payment state remains locked. A submit lock caught between the live response and first passport may release after the exact owner-authenticated order is durably proven zero-match `ARMED`; its generation-pinned release retains the owner-verified scoped TAKE_PROFIT reservation. Its release guard blocks concurrent claims and is automatically reclaimed only when it is owner-only, bound to this exact journal and lock generation, and its recorded process is dead. Live or foreign guards fail closed. Cancel-attempt locks and any initially matched, unknown, or otherwise unresolved submission keep the global lock until the existing terminal zero-fill or terminal finalized-fill condition is proven:

```sh
node scripts/take-profit-orchestrator.mjs reconcile-tp \
  --journal <private-take-profit-journey.json> \
  --issuer-registry config/trusted-issuer.production.json --json
```

The runners wait until the second after live-trade confirmation, serialize the final wallet/configuration window, and keep owner-only reconciliation journals outside Git. A verified OPEN or CLOSE settlement must also have a Polygon block timestamp strictly later than the confirmation second.

If an OPEN returns an ambiguous response, reconcile its recorded order read-only. A verified settlement releases only that journey's owner-verified execution lock. A zero-fill FAK releases it only when a fresh credential-owner-bound exact CLOB snapshot proves the signed order identity, canonical `CANCELED`/`EXPIRED` status, zero matched shares, no trades, and creation inside the signed post-confirmation window:

```sh
node scripts/buyer-orchestrator.mjs reconcile-open \
  --journal "$CONVICTION_JOURNAL_PATH" \
  --issuer-registry config/trusted-issuer.production.json --json
```

If a CLOSE process loses an execution response, never retry it under another market spelling or payer. A known pre-spawn refusal restores the existing paid-and-confirmed checkpoint while retaining its replay lock; continue only through `resume-close`, which reverifies the payment, card, source position, wallet, balance, approval, reservations, and dry run without paying again. Otherwise reconcile the recorded journey read-only:

```sh
node scripts/buyer-orchestrator.mjs resume-close \
  --journal "$CONVICTION_JOURNAL_PATH" \
  --issuer-registry config/trusted-issuer.production.json --json

node scripts/buyer-orchestrator.mjs reconcile-close \
  --journal "$CONVICTION_JOURNAL_PATH" \
  --issuer-registry config/trusted-issuer.production.json --json
```

`reconcile-close` releases its owner-verified replay and execution locks only after independently verifying the recorded settlement, proving an exact terminal zero-fill FOK through the same authenticated CLOB checks, or proving that no execution began and the signed card expired. Ambiguous evidence remains locked for manual reconciliation; never delete a lock to force progress.

The public [privacy](https://conviction-bay.vercel.app/privacy.html) and [terms](https://conviction-bay.vercel.app/terms.html) pages state exactly what is processed, what the paid service delivers, and which wallet and approval steps remain third-party operations.

## Verification gate

```sh
npm run gate
```

The local release gate checks JavaScript and Python syntax, deterministic YES/NO OPEN/CLOSE/TAKE_PROFIT compilation, outcome-specific market resolution, server-computed exposure and proceeds, stale/price/liquidity/rounding refusal paths, source, intent, token, order, trade, and receipt substitution, exact x402 challenges, payment/trade-consent separation, post-only placement, authenticated ARMED proof, lifecycle status, exact cancellation, aggregate Polygon fill verification, launch-surface markers, and A2A secret-refusal behavior. It runs Gates A, B, and C in offline mode, where adversarial mutations must fail with zero orders.

Offline success is not live acceptance. The tracked runtime reports leave all three live gates explicitly undecided until a fresh buyer authorizes each applicable service payment and trade: exact bounds plus one confirmation, buyer-wallet execution (or authenticated ARMED placement), same-journey proof, and payment-to-proof under two minutes. No local test or dry probe is presented as satisfying those live requirements.

## Operational boundary

New Polymarket deposit-wallet setup currently grants max pUSD allowances and blanket ERC-1155 approvals to official Polymarket exchange contracts. Conviction discloses this before execution and recommends a dedicated low-balance wallet. The current official plugin has no revoke command.

Polymarket V2 signs the token, principal, shares, and price but applies operator-set fees at match time. Conviction rechecks the current venue fee immediately before execution, reserves that fee in the displayed total, and verifies the actual settlement afterward. A reusable wallet may hold more than this order needs; that balance does not authorize another order, but the venue fee itself is not part of the V2 signature. Gas is separate.

A CLOSE card is bound to a prior independently reverified OPEN proof, but that source proof is provenance rather than an on-chain lot identifier. It is not consumed by a close. Conviction therefore treats the fresh wallet balance and approval as the sale authority, rechecks both before submission, and verifies the exact outcome-token debit and net pUSD credit afterward.

A TAKE_PROFIT reserves selected-token shares in a venue-hosted order and may fill partially across more than one Polygon transaction. Conviction never submits another selected-token SELL while its complete authenticated reservation snapshot is nonzero. It treats unknown order state, missing trade attribution, missing receipts, and fill/cancel races as unresolved. A retained cancel execution lock is released only by `reconcile-tp` after owner-verified terminal state and, for any fill, finalized Polygon proof. There is no background daemon, recurring strategy, automatic re-entry, hidden price change, or broad cancel.

Never send Conviction a seed phrase, private key, bearer token, CLOB credential, reusable signature, or raw transaction authorization.

## Status

- Controlled OPEN and CLOSE execution: complete
- OPEN/CLOSE intent and Polygon receipt verification: complete
- TAKE_PROFIT source: bounded placement, ARMED proof, exact status/cancel, authenticated trade recovery, and aggregate Polygon fill verification implemented; fresh live Gate C remains consent-gated
- Public web surface: OPEN preview/manual verifier deployed; managed-position copy is part of this v0.4 release
- Paid OKX.AI service endpoint: deployed; exact `0.05 USD₮0` payment settled and bounded card delivered with 118 seconds remaining ([X Layer transaction](https://www.oklink.com/xlayer/tx/0xb86bec4537095d4ef771a975fbf73196565f1a6d947ceb953e0d930480ed0eaf))
- OKX.AI ASP: Conviction `#7034` registered with one `0.05 USDT` service; `Listing under review` was last confirmed 2026-07-21, and external buyer proof remains pending

The paid call is a controlled house proof between house wallets. It proves the
machine-payment and delivery path, not external revenue or traction.

Built for OKX.AI Genesis.
