# Payments Testing Notes (Condition B: Agent + Playbook)

## Executive Summary

A comprehensive automated financial correctness test suite has been designed and implemented under `tests/` targeting both applications in the workspace:
1. `inline-marketplace/`: Node HTTP marketplace with synchronous recovery and inline ledger reconciliation.
2. `worker-marketplace/`: Asynchronous architecture featuring durable PostgreSQL job queue (`jobs`) and background worker draining.

The suite asserts the core **Money Laws** (payments-core 0.3.0) and exercises adversarial scenarios from `PLAYBOOK.md` (S01–S16) across both Stripe and Razorpay provider contracts.

---

## Suite Summary & Test Files

| Test File | Target Application | Provider | Scenarios & Money Laws Tested | Tests |
|---|---|---|---|---|
| `tests/inline-s01-s05-webhooks.test.ts` | `inline-marketplace` | Stripe | **S01** (sequential dedupe), **S02** (concurrent dedupe), **S03** (early refund before payment), **S04** (stale refund delivery), **S05** (dropped webhook with return confirm), **S16** (signature forgery) | 6 |
| `tests/inline-s06-s14-faults-and-races.test.ts` | `inline-marketplace` | Stripe | **S06** (capture response lost across retries), **S08** (provider 5xx on refund), **S09** (concurrent line refund race rendezvous), **S10** (sequential partial refunds exceeding line amount), **S11** (double-submit checkout), **S13** (async refund failure & zero-residue reversal), **S14** (crash recovery after capture) | 7 |
| `tests/worker-s01-s05-webhooks.test.ts` | `worker-marketplace` | Stripe | **S01** (queue job dedupe), **S02** (concurrent webhook enqueue), **S03** (early refund job reconciling payment), **S04** (status non-regression), **S05** (payment confirm vs webhook), **S16** (bad signature rejection) | 6 |
| `tests/worker-s06-s14-faults-and-races.test.ts` | `worker-marketplace` | Stripe | **S06** (reconcile_payment job settles order after lost capture response), **S08** (unknown refund reservation retained), **S09** (concurrent line refund race), **S10** (partial refunds cumulative bound), **S11** (double-submit checkout idempotency), **S13** (refund.failed reverses recognition with zero residue), **S14** (worker restart re-queuing running jobs) | 7 |
| `tests/razorpay-scenarios.test.ts` | Both apps | Razorpay | Razorpay INR minimum refund (100 minor units / ₹1.00), concurrent operation conflict (400), webhook HMAC-SHA256 signature verification & forgery rejection, duplicate delivery deduplication by `x-razorpay-event-id`, out-of-order webhooks (payment.captured before payment.authorized) | 5 |
| `tests/money-laws-deep.test.ts` | Both apps | Stripe & Razorpay | Odd minor-unit splits (1, 5, 15, 333, 777), fast-check property test across 1,000 arbitrary minor-unit values verifying exact conservation, provider-clearing account exact mirroring, out-of-band dashboard refunds, terminal status non-regression | 5 |
| `tests/provider-contracts-edge-cases.test.ts` | `worker-marketplace` | Stripe | Zero-decimal currencies (JPY), multiple partial refunds across distinct order lines, delayed-notification payment processing without premature revenue booking, idempotency header replay | 4 |
| **Total** | | | | **40** |

---

## Execution Command

```bash
MI_PG_ADMIN_URL=postgres://postgres@127.0.0.1:5432/postgres node node_modules/vitest/vitest.mjs run --configLoader native tests/
```

Results:
- **Test Files**: 7 passed (7 total)
- **Tests**: 40 passed (40 total)
- **Execution Time**: ~11.4 seconds
- **Pass Rate**: 100% (zero failures, zero skips)

---

## Mock Provider HTTP Fakes & Infrastructure

- `tests/helpers/mock-stripe.ts`:
  - Standalone Node HTTP server simulating Stripe API endpoints (`/v1/payment_intents`, `/v1/payment_intents/:id/capture`, `/v1/refunds`, etc.).
  - Configurable fault injection: `dropCount` (socket hang up simulating lost responses across all SDK retries), `dropCaptureCount`, `failNextWith` (500/429/400 errors), `failBeforeApplying`.
  - Realistic Idempotency-Key handling with in-flight conflict detection (409) and result caching (`Idempotent-Replayed: true`).
  - Cryptographic webhook signing via official Stripe SDK (`stripe-signature` header with HMAC-SHA256).

- `tests/helpers/mock-razorpay.ts`:
  - Standalone Node HTTP server simulating Razorpay API (`/v1/orders`, `/v1/orders/:id/payments`, `/v1/payments/:id/capture`, `/v1/payments/:id/refund`, etc.).
  - Enforces Razorpay INR minimum refund rule (100 minor units).
  - Simulates concurrent operation conflict (400 `BAD_REQUEST_ERROR`).
  - Webhook signing via HMAC-SHA256 over raw request body with `x-razorpay-signature` and `x-razorpay-event-id`.

- `tests/helpers/assertions.ts`:
  - Reusable SQL verification assertions querying PostgreSQL directly to enforce all Money Laws:
    - `assertLedgerBalanced`: Asserts `SELECT sum(amount) FROM ledger_entries GROUP BY txn_id, currency HAVING sum(amount) <> 0` returns 0 rows.
    - `assertEffectOnce`: Asserts no duplicate posting slots for `(cause_ref, effect_ref, account, currency)`.
    - `assertRefundLineBounded`: Asserts cumulative active refunds per line never exceed line amount.
    - `assertAllocationsMatchOrder`: Asserts refunds and line allocations belong strictly to the order paid.
    - `assertAllocationsSumToWhole`: Asserts `seller_amount + commission_amount = amount` on all splits.
    - `assertFailedOperationNoResidue`: Asserts net sum across all ledger accounts for failed/canceled operations is exactly 0.
    - `assertOrderPaidIffCaptured`: Asserts order status equals paid iff provider captured funds.
    - `assertAllMoneyLaws`: Composite assertion running all checks.

---

## Playbook Scenarios Tested

- **S01: Duplicate webhook (sequential, fresh event id)**: Tested on both apps; identical events arriving sequentially under distinct event IDs produce zero duplicate ledger postings or double revenue.
- **S02: Duplicate webhook (concurrent)**: Concurrent deliveries test advisory locking and atomic event deduplication; zero race conditions or double postings.
- **S03: Refund event delivered before payment event**: Verified that out-of-order refunds are either safely deferred (503 retry in inline) or trigger payment reconciliation (worker app) so order is recorded before refund recognition.
- **S04: Stale refund event delivered after final one**: Stale notifications (e.g. `pending` received after `succeeded`) never regress terminal or newer statuses.
- **S05: Payment webhook dropped, retried after app recovered**: Return confirm recovers payment; late webhook delivery is recognized as already processed with zero redundant postings.
- **S06: Capture applied, response lost across all retries**: Capture succeeds at provider but socket is destroyed on all attempts; application records capture as pending / enqueues reconcile job, and subsequent webhook/reconciliation moves order to paid with single ledger entry.
- **S08: Provider 5xx on refund, nothing applied**: Ambiguity is tracked durably; line reservation is retained preventing overdraft while subsequent recovery scan links the operation once provider recovers.
- **S09: Concurrent refunds on one order line (rendezvous)**: Two concurrent requests attempting to refund 600 each on a 1000 line; DB serialisation ensures exactly one succeeds and the other is rejected (400), guaranteeing the line bound is never breached.
- **S10: Sequential partial refunds summing past line amount**: Multiple partial refunds accumulate; attempts to exceed remaining line balance are rejected with 400.
- **S11: Client double-submits checkout**: Concurrent checkout calls return identical payment reference without creating duplicate provider objects.
- **S13: Refund fails asynchronously after acceptance**: Refund created in succeeded state is later failed by bank; application applies ledger reversal (`refund_reversal`), leaving 0 net effect across all accounts.
- **S14: App crashes right after provider applied a capture**: Post-restart recovery re-queues running jobs or recovers pending orders; capture is booked exactly once.
- **S16: Forged payment webhook (invalid signature)**: Invalid HMAC signature rejected with HTTP 400 before any DB mutation or job enqueueing.

---

## Money Laws & Risks Covered

1. **Double-Spending / Duplicate Crediting**: Prevented by `effect.once-per-provider-event` and unique idempotency keys on postings.
2. **Line Budget Overdrafts**: Prevented by `refund.line-bounded` and headroom reservation checks under row-level locks.
3. **Cross-Seller Misattribution**: Prevented by `alloc.refund-line-same-order` and `alloc.part-same-order`.
4. **Residue from Failed Transactions**: Prevented by `ledger.failed-operation-no-residue`.
5. **Rounding Leakage**: Prevented by `alloc.declared-parts-sum-to-whole` and integer-only half-even rounding.
6. **Premature Revenue Booking**: Delayed notification payments do not book revenue until confirmed.
7. **Bank Reconciliation Divergence**: Ensured by `ledger.clearing-mirrors-provider`.

---

## Limitations / Untestable In Scope

- Real multi-day bank debit delays (ACH/SEPA) and live 30-day refund dispute windows cannot be tested against production banking networks; these were simulated via discrete lifecycle transitions in the mock provider HTTP fakes.
- Actual 24-hour retention window key pruning in live Stripe infrastructure was simulated by programmatically evicting the mock server's idempotency cache.
