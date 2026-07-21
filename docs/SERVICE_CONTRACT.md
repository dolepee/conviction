# Bounded YES/NO OPEN and CLOSE — Service Contract

Conviction turns an explicit user thesis into a ready-to-sign, fee-inclusive Polymarket YES or NO OPEN card, computes the objective exposure before signing, and independently verifies the resulting Polygon settlement. Its source-bound position manager can then produce an exact-share CLOSE card with a hard minimum price and independently verify the sale. It does not recommend an outcome or take custody.

The OPEN routes are free `POST /api/preview`, paid `POST /api/service` at `0.05 USD₮0`, and proof-only `POST /api/receipt`. The CLOSE routes are free `POST /api/manage-preview`, paid `POST /api/manage` at `0.10 USD₮0`, and proof-only `POST /api/close-receipt`. The public web app remains an OPEN preview and verifier; the public agent/CLI can run a paid OPEN or source-bound CLOSE through bounds, one trade confirmation, execution, and proof in the same session.

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

The buyer orchestrator derives an argument vector from canonical `executionCard.argv`, runs the official `polymarket-plugin` dry run, and may execute the identical vector only after a separate, fresh live confirmation. It rechecks deposit-wallet mode, atomic pUSD balance, card expiry, and the venue dry run immediately before signing. FAK fills only at or below `maxPrice` and cancels any remainder. Conviction does not receive the wallet key or Polymarket credentials. V2 signs the order principal, token, shares, and price while the operator applies fees at match time; Conviction reserves the observed fee in the displayed total and verifies it after settlement, but does not mislabel that fee as part of the V2 signature.

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

The issuer signature proves the exact card existed inside its issuance window; the buyer wallet separately signs only the Polymarket order. The final passport binds the signed card to the mined settlement block and verified fill.

## CLOSE request

Send the paid manager or free manager preview:

```json
{
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

The public agent/CLI repeats the seller balance, standard V2 outcome-token approval, open-order, expiry, and exact plugin dry-run checks before submission. Payment consent and trade consent remain distinct: x402 payment never authorizes a sell. After exactly one fresh live confirmation, it submits the same FOK SELL arguments from the buyer's configured deposit wallet. The order must sell every requested share at or above `minPrice`, or produce no fill.

`POST /api/close-receipt` recomputes the exit-intent hash, verifies its issuer and settlement window, and derives the exact outcome-token debit, gross proceeds, venue fee, and net pUSD credit from Polygon logs. It rejects another token, wallet, order, transaction, exchange, share count, price floor, fee bound, or settlement window.

The buyer runtime keys its replay lock to the canonical condition, selected token, seller, source proof, shares, and floor—not to a URL spelling or payment sponsor—and serializes the final deposit-wallet check through submission. An ambiguous CLOSE is never retried. `buyer-orchestrator.mjs reconcile-close` can release the scoped lock only after independently verifying a recorded settlement, or after confirming that execution never began and the signed card has expired; every other state remains locked for manual investigation.

The OPEN source is a provenance link, not a consumable tax lot or one-time nullifier. Reusing a legacy source proof after shares have left and later returned to the wallet can still describe lineage; it does not prove those later tokens are the identical economic lot. Fresh seller-owned balance is the authority to sell. Conviction does not currently provide take-profit, stop-loss, or resting-order automation.

## Refusal conditions

Conviction fails closed for stale or unavailable market or position data, inactive or closed markets, non-binary markets, neg-risk markets, outcomes other than YES/NO, an OPEN other than FAK, a CLOSE other than exact FOK, an OPEN principal or CLOSE proceeds below the CLOB marketable-order floor, insufficient bounded liquidity, price/tick mismatch, inconsistent outcome-token mappings, invalid wallets, missing balance or approval, source substitution, fee/debit/credit mutation, intent mutation, or receipt substitution. Venue/plugin regional eligibility still applies at execution.

## Approval disclosure

New Polymarket deposit-wallet setup uses the official five-call batch: max pUSD allowances to the standard and neg-risk V2 exchanges plus blanket ERC-1155 approvals to three official contracts. The current official CLI has no revoke command. Use a dedicated low-balance wallet.
