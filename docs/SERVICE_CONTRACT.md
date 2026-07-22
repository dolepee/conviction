# Bounded YES/NO OPEN and Position Manager — Service Contract

Conviction has exactly two paid products. OPEN turns an explicit user thesis into a ready-to-sign, fee-inclusive Polymarket YES or NO FAK buy and independently verifies the resulting Polygon settlement. Position Manager consumes a verified OPEN source and produces exactly one selected action: an immediate exact-share FOK CLOSE above a hard floor, or a post-only GTD TAKE_PROFIT at a target and venue expiry. It does not recommend an outcome or take custody.

The OPEN routes are free `POST /api/preview`, paid `POST /api/service` at `0.05 USD₮0`, and proof-only `POST /api/receipt`. Both manager actions use free `POST /api/manage-preview` and paid `POST /api/manage` at `0.10 USD₮0`; the request's explicit `action` selects `close` or `take_profit`. CLOSE proof uses `POST /api/close-receipt`. TAKE_PROFIT returns an authenticated ARMED order proof immediately, then its buyer-side journal supports read-only status, independent Polygon fill proof, and exact-order cancellation. The public web app remains an OPEN preview/manual verifier; the repository-backed buyer agent/CLI runs the complete action without asking the user to type plugin commands.

## OPEN request

Send JSON:

```json
{
  "market": "will-gpt-6-be-released-by-december-31-2026-834-362-194-984-527",
  "outcome": "no",
  "spend": "1.232",
  "maxPrice": "0.14",
  "wallet": "0x1111111111111111111111111111111111111111",
  "rationale": "I selected NO and accept only the stated fee-inclusive bounds."
}
```

Rules:

- `market`: Polymarket URL, slug, or 32-byte condition ID.
- `outcome`: exactly `yes` or `no`.
- `spend`: total fee-inclusive pUSD risk budget of at least 1 pUSD. Conviction derives the largest whole-share order principal that stays within it.
- `maxPrice`: `(0, 1)`, aligned to the market tick.
- `wallet`: buyer-controlled EVM deposit-wallet address.
- `rationale`: optional user-authored note; when present, 20–500 characters.

Never send a seed phrase, private key, bearer token, CLOB credential, reusable signature, or raw transaction authorization.

## OPEN pre-execution response

Conviction returns:

- canonical market condition, both binary tokens, and the selected outcome token;
- live best bid/ask, spread, bounded ask depth, resolution timing, and an explicit expiry;
- maximum order principal, conservative venue-fee reserve, maximum total debit/loss, full-fill payout, fee-adjusted profit, all-in break-even price, and shares at the cap;
- deterministic intent hash;
- machine-readable official-plugin arguments;
- `requiresUserConfirmation: true` and `nonCustodial: true`.

No transaction is signed or broadcast by this response.

The wallet-free economic preview expires 30 seconds after its market snapshot. The final public wallet-bound card is always compiled from a fresh snapshot no more than 30 seconds old and expires five minutes after capture. The paid machine response also accepts only a snapshot no more than 30 seconds old and returns a signed v4 card that expires five minutes after capture. The buyer must reject every expired card.

## OPEN execution

The buyer orchestrator derives an argument vector from canonical `executionCard.argv`, runs the official `polymarket-plugin` dry run, and may execute the identical vector only after a separate, fresh live confirmation. It advances beyond the confirmation second, then rechecks deposit-wallet mode, atomic pUSD balance, card expiry, and the venue dry run immediately before signing. FAK fills only at or below `maxPrice` and cancels any remainder. Conviction does not receive the wallet key or Polymarket credentials. V2 signs the order principal, token, shares, and price while the operator applies fees at match time; Conviction reserves the observed fee in the displayed total and verifies it after settlement, but does not mislabel that fee as part of the V2 signature.

## OPEN verification request

```json
{
  "transactionHash": "0x…",
  "orderId": "0x…",
  "intentHash": "0x…",
  "intent": { "version": "conviction-intent-v4", "...": "original compiler output" },
  "issuance": { "version": "conviction-issuance-v1", "...": "trusted Ed25519 signature" }
}
```

Conviction recomputes the intent hash, verifies the pinned issuer and settlement time against the signed five-minute window, derives actual principal, venue fee, total debit, and shares from the selected order's Polygon events, verifies the selected YES/NO token mapping, and checks every value stayed within the displayed fee-inclusive budget and maximum price. The response includes deterministic position-proof and signed position-passport hashes.

The issuer signature proves the exact card existed inside its issuance window; the buyer wallet separately signs only the Polymarket order. The final passport binds the signed card to the mined settlement block and verified fill. The settlement block second must be strictly later than the recorded trade-confirmation second.

If OPEN submission or proof delivery becomes ambiguous, `buyer-orchestrator.mjs reconcile-open` performs no payment or order. It reverifies the signed card and exact persisted identity, then either independently proves the Polygon settlement or requires a fresh credential-owner-bound exact CLOB snapshot with the signed FAK identity, canonical `CANCELED`/`EXPIRED` status, zero matched shares, no associated trades, and creation strictly after confirmation inside the card window. Only then does it release that journey's owner-verified execution lock; every other state remains locked.

## CLOSE request

Send the paid manager or free manager preview:

```json
{
  "action": "close",
  "market": "will-gpt-6-be-released-by-december-31-2026-834-362-194-984-527",
  "outcome": "no",
  "shares": "7",
  "minPrice": "0.14",
  "wallet": "0x1111111111111111111111111111111111111111",
  "sourcePosition": {
    "transactionHash": "0x…",
    "orderId": "0x…",
    "intentHash": "0x…",
    "intent": { "version": "conviction-intent-v4", "...": "original OPEN intent" },
    "issuance": { "version": "conviction-issuance-v1", "...": "trusted Ed25519 signature" }
  },
  "rationale": "I chose to close exactly seven NO shares above this floor."
}
```

Rules:

- `market`, `outcome`, and `wallet` must identify the same standard V2 position as the independently reverified OPEN source.
- `shares` is an exact positive whole-share quantity. It cannot exceed either the source fill or the seller's freshly observed balance.
- `minPrice` is the lowest acceptable sale price, must align to the market tick, and must produce at least 1 pUSD of cent-aligned gross proceeds.
- `sourcePosition` must contain enough of the prior OPEN result to re-fetch and independently verify its Polygon settlement. A current signed v4 OPEN proves that its card existed inside the signed issuance window. A legacy v2/v3 OPEN is accepted only as retrospective provenance.
- `rationale` is optional; when present, it is 20–500 characters.

## CLOSE pre-execution response

The manager binds the market, YES/NO token, seller wallet, exact whole shares, minimum price, FOK order type, source proof hashes, fresh balance and approval snapshot, signed minimum gross proceeds, observed fee and net verification thresholds, bid depth, and five-minute expiry. It signs only when the standard V2 exchange is approved and current bids at or above `minPrice` can fill the entire requested quantity. Shares, minimum price, FOK, and minimum gross are preventive venue-order controls. Polymarket V2 applies—but does not sign—the operator fee, so fee and net thresholds are post-settlement checks that can detect an unexpected charge but cannot prevent or reverse it.

No transaction is signed or broadcast by either CLOSE endpoint. The free preview is non-executable; the paid manager returns the signed execution card.

## CLOSE execution and proof

The public agent/CLI repeats the seller balance, standard V2 outcome-token approval, open-order, expiry, and exact plugin dry-run checks before submission. Payment consent and trade consent remain distinct: x402 payment never authorizes a sell. After exactly one fresh live confirmation, it waits until the next second, repeats the locked checks, and submits the same FOK SELL arguments from the buyer's configured deposit wallet. The order must sell every requested share at or above `minPrice`, or produce no fill. A verified settlement block second must be strictly later than the confirmation second.

`POST /api/close-receipt` recomputes the exit-intent hash, verifies its issuer and settlement window, and derives the exact outcome-token debit, gross proceeds, venue fee, and net pUSD credit from Polygon logs. It rejects another token, wallet, order, transaction, exchange, share count, price floor, fee bound, or settlement window.

The buyer runtime keys its replay lock to the canonical condition, selected token, seller, source proof, shares, and floor—not to a URL spelling or payment sponsor—and serializes the final deposit-wallet check through submission. An ambiguous CLOSE is never retried. A known refusal before the live child process starts releases only the owner-verified global execution lock, clears attempt markers, restores `trade_confirmed`, and retains the paid card and replay lock; only `resume-close` may continue that exact journey without another payment. `reconcile-close` can release its owner-verified scoped locks only after independently verifying a recorded settlement, proving a canonical terminal zero-fill exact FOK through a fresh credential-owner-bound CLOB snapshot, or confirming that execution never began and the signed card expired. Every other state remains locked for manual investigation.

The OPEN source is a provenance link, not a consumable tax lot or one-time nullifier. Reusing a legacy source proof after shares have left and later returned to the wallet can still describe lineage; it does not prove those later tokens are the identical economic lot. Fresh seller-owned balance is the authority to sell for either Position Manager action.

## TAKE_PROFIT request

Send the paid manager or free manager preview:

```json
{
  "action": "take_profit",
  "market": "will-gpt-6-be-released-by-december-31-2026-834-362-194-984-527",
  "outcome": "no",
  "shares": "7",
  "targetPrice": "0.20",
  "venueExpiresAt": "<canonical UTC ISO timestamp on a whole second>",
  "wallet": "0x1111111111111111111111111111111111111111",
  "sourcePosition": {
    "transactionHash": "0x…",
    "orderId": "0x…",
    "intentHash": "0x…",
    "intent": { "version": "conviction-intent-v4", "...": "original OPEN intent" },
    "issuance": { "version": "conviction-issuance-v1", "...": "trusted Ed25519 signature" },
    "positionProofHash": "0x…"
  },
  "rationale": "I chose this exact target and venue expiry for seven NO shares."
}
```

Rules:

- `action` must be exactly `take_profit`; omission selects legacy-compatible `close`, so public callers should always send it explicitly.
- `market`, `outcome`, `wallet`, and `sourcePosition` must resolve to the same independently reverified standard V2 position.
- `shares` must be positive whole shares, meet the market's resting-order minimum, not exceed the verified source or fresh wallet balance, and have no selected-token SELL reservation.
- `targetPrice` must be in `(0, 1)`, align to the current market tick, produce cent-aligned full-fill proceeds, and be strictly above the freshly observed best bid so the order cannot cross on placement.
- `venueExpiresAt` must be a canonical whole-second UTC timestamp with enough headroom to outlive the five-minute placement card, and cannot exceed the market end.

## TAKE_PROFIT placement, lifecycle, and proof

The free and paid manager share the same source, balance, approval, market, precision, expiry, fee, and proceeds checks. The free response is non-executable. The paid response is a signed five-minute placement card whose exact plugin vector is `SELL`, selected token, whole shares, target price, `GTD`, `--post-only`, and the signed venue expiry. The card expiry controls when placement may occur; it does not shorten an already submitted GTD order.

Before payment and again after trade consent, the buyer runtime requires the exact deposit wallet, standard V2 approval, sufficient selected-token balance, a complete authenticated open-order snapshot, and zero selected-token SELL reservations. Payment consent never authorizes placement. After one fresh `confirm live mode`, the runtime advances beyond the confirmation second, repeats the identical dry run and readiness checks, and submits once. It then authenticates the exact CLOB order and returns `conviction-resting-order-proof-v1` plus `conviction-take-profit-passport-v1`, both explicitly `ARMED` and `onChain:false`.

`tp-status` is read-only. It re-fetches the exact order with the buyer's owner-only local CLOB credentials. Zero-match `LIVE` remains `ARMED`; matched quantities are never hidden by a canceled or expired label. When associated trades exist, Conviction fetches every exact trade ID from the authenticated CLOB, requires the pinned post-only order to be the unique maker contribution, and independently verifies each unique Polygon settlement receipt. `conviction-take-profit-fill-proof-v1` aggregates partial fills across trades and transactions while binding the exact order, wallet, selected token, gross proceeds, venue fee, net pUSD credit, target price, and signed quantity cap. It preserves whether the unfilled remainder is active, canceled, or expired. Included receipts remain explicitly `PROVISIONAL` until Polygon's finalized head covers every settlement block.

`cancel-tp` requires the distinct exact phrase `confirm cancel take profit`. It invokes only `polymarket-plugin cancel --order-id <pinned-order-id>`, never a market-wide or all-order cancel, and then re-fetches the exact order. A fill/cancel race returns the matched quantity and still requires chain proof. A missing or indeterminate lookup remains `UNKNOWN` with reconciliation required; a plugin cancel acknowledgement alone is not proof of cancellation. `reconcile-tp` never pays, places, or cancels. It may build the missing passport only from an exact live order ID already persisted before the first authenticated fetch. Before any order exists, it releases a reservation only after an authorization expires and finalized X Layer state proves it unused, or after a paid card expires with execution proven unstarted; consumed or ambiguous authorization state remains locked. The narrow non-terminal exception is a submit lock caught after the live result: once the exact owner-authenticated order is durably persisted as zero-match `ARMED`, a generation-pinned release removes only that global lock and leaves the exact owner-verified TAKE_PROFIT reservation intact. An owner-only release guard serializes new execution claims; `reconcile-tp` reclaims it only when its exact journal/generation binding matches and its recorded PID is dead, while live or foreign guards remain locked. Cancel-attempt locks and initially matched, provisional, partial-live, unknown, or ambiguous submission state retain the global lock until the existing terminal zero-fill or terminal finalized-fill condition is proven.

TAKE_PROFIT is one bounded venue-hosted order. It is not a monitor daemon, recurring strategy, stop loss, autonomous re-entry, hidden price amendment, portfolio grant, or guaranteed fill.

## Refusal conditions

Conviction fails closed for stale or unavailable market, position, order, trade, or receipt data; inactive or closed markets; non-binary or neg-risk markets; outcomes other than YES/NO; an OPEN other than FAK; a CLOSE other than exact FOK; a TAKE_PROFIT other than post-only GTD; sub-minimum or non-whole quantities; insufficient bounded liquidity; crossed targets; price/tick or expiry mismatch; selected-token SELL reservations; inconsistent outcome-token mappings; invalid wallets; missing balance or approval; source, token, order, trade, transaction, fee, debit, credit, or intent substitution; incomplete pagination; ambiguous maker/taker attribution; or unresolved fill/cancel state. Venue/plugin regional eligibility still applies at execution.

## Approval disclosure

New Polymarket deposit-wallet setup uses the official five-call batch: max pUSD allowances to the standard and neg-risk V2 exchanges plus blanket ERC-1155 approvals to three official contracts. The current official CLI has no revoke command. Use a dedicated low-balance wallet.
