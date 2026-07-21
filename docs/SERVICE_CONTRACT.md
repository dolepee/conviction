# Bounded YES/NO Position Card — Service Contract

Conviction turns an explicit user thesis into a ready-to-sign, fee-inclusive Polymarket YES or NO position card, computes the objective exposure before signing, and independently verifies the resulting Polygon settlement. The public web flow begins with wallet-free market and bounds previews. It does not recommend an outcome or take custody.

The paid marketplace call is `POST /api/service` and covers the pre-execution compile only. The public web app uses the free `POST /api/intent` preview. Post-execution verification is a separate `POST /api/receipt` call.

## Request

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

## Pre-execution response

Conviction returns:

- canonical market condition, both binary tokens, and the selected outcome token;
- live best bid/ask, spread, bounded ask depth, resolution timing, and an explicit expiry;
- maximum order principal, conservative venue-fee reserve, maximum total debit/loss, full-fill payout, fee-adjusted profit, all-in break-even price, and shares at the cap;
- deterministic intent hash;
- machine-readable official-plugin arguments;
- `requiresUserConfirmation: true` and `nonCustodial: true`.

No transaction is signed or broadcast by this response.

The wallet-free economic preview expires 30 seconds after its market snapshot. The final public wallet-bound card is always compiled from a fresh snapshot no more than 30 seconds old and expires five minutes after capture. The paid machine response also accepts only a snapshot no more than 30 seconds old and returns a signed v4 card that expires five minutes after capture. The buyer must reject every expired card.

## Execution

The buyer orchestrator derives an argument vector from canonical `executionCard.argv`, runs the official `polymarket-plugin` dry run, and may execute the identical vector only after a separate, fresh live confirmation. It rechecks deposit-wallet mode, atomic pUSD balance, card expiry, and the venue dry run immediately before signing. FAK fills only at or below `maxPrice` and cancels any remainder. Conviction does not receive the wallet key or Polymarket credentials. V2 signs the order principal, token, shares, and price while the operator applies fees at match time; Conviction reserves the observed fee in the displayed total and verifies it after settlement, but does not mislabel that fee as part of the V2 signature.

## Verification request

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

## Refusal conditions

Conviction fails closed for stale or unavailable market data, inactive or closed markets, non-binary markets, neg-risk markets, outcomes other than YES/NO, non-FAK orders, a fee-adjusted principal below the CLOB marketable-order floor, insufficient bounded liquidity, price/tick mismatch, inconsistent outcome-token mappings, invalid wallets, fee/debit mutation, intent mutation, or receipt substitution. Venue/plugin regional eligibility still applies at execution.

## Approval disclosure

New Polymarket deposit-wallet setup uses the official five-call batch: max pUSD allowances to the standard and neg-risk V2 exchanges plus blanket ERC-1155 approvals to three official contracts. The current official CLI has no revoke command. Use a dedicated low-balance wallet.
