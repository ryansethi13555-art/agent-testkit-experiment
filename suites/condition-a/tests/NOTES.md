# Automated Payments & Money-Correctness Test Suite: Verification Notes

## Overview
This test suite was designed and implemented for **Condition A: Agent Alone** to rigorously test the payment, refund, and accounting flows across both applications in the workspace:
1. `inline-marketplace`: HTTP marketplace with inline payment/refund recovery, Postgres advisory locking, and direct double-entry ledger postings.
2. `worker-marketplace`: Event-driven marketplace with a durable Postgres job queue, asynchronous single-worker draining, and double-entry ledger triggers.

All tests execute against real, throwaway PostgreSQL databases and dedicated fake provider servers simulating both Stripe and Razorpay behaviors.

---

## Test Execution Command

To run the newly authored test suite under `tests/`:
```bash
MI_PG_ADMIN_URL=postgres://postgres@127.0.0.1:5432/postgres node node_modules/vitest/vitest.mjs run --configLoader native tests/
```

To run all test suites in the workspace (including pre-existing test files):
```bash
MI_PG_ADMIN_URL=postgres://postgres@127.0.0.1:5432/postgres node node_modules/vitest/vitest.mjs run --configLoader native
```
And the worker marketplace's node runner tests:
```bash
node --test --test-concurrency=1 worker-marketplace/test/*.test.ts
```

All suites pass deterministically with **zero failures** and **zero flakes**.

---

## Test Files and Test Counts

The test suite consists of **7 test files** containing **42 tests** under `tests/`, supported by reusable helpers under `tests/helpers/`:

### Helpers (`tests/helpers/`)
- `tests/helpers/db.ts`: Manages isolated, throwaway Postgres databases using `MI_PG_ADMIN_URL`, enforcing clean creation and forced teardown (`DROP DATABASE ... WITH (FORCE)`).
- `tests/helpers/fake-stripe.ts`: Full-featured in-memory fake Stripe HTTP server simulating PaymentIntents, captures, refunds, webhooks with valid Stripe signature headers (`stripe-signature`), idempotency key tracking, and fault injection (socket drops, 502 Bad Gateway, 429 Rate Limits, 400 amount too large).
- `tests/helpers/fake-razorpay.ts`: In-memory fake Razorpay HTTP server supporting Orders, Payments, Captures, Refunds, `X-Refund-Idempotency` headers, and HMAC-SHA256 webhook signature validation.
- `tests/helpers/apps.ts`: Standardized HTTP client helpers and ledger balance querying utilities (`getLedgerTotal`, `getLedgerAccountBalance`, `areAllLedgerTransactionsBalanced`).

### Test Suites (`tests/*.test.ts`)
1. **`tests/inline-stripe-payments.test.ts` (7 tests)**
   - Input validation: Empty lines, negative amounts, non-numeric strings, invalid currency codes.
   - Checkout idempotency: High-concurrency checkouts (12 simultaneous requests) create exactly one Stripe PaymentIntent.
   - Crash marker protection: `checkout_create_started` prevents duplicate provider payments when initial outcome is ambiguous.
   - Webhook processing: Validates `payment_intent.succeeded`, double-entry ledger postings, 10% platform commission with half-even rounding, and deduplication of repeated webhook deliveries.
   - Webhook tampering: Rejects forged/tampered payloads with invalid signatures.
   - Manual capture: Verifies `capture: "manual"`, observation events do not book money prematurely, and merchant capture triggers ledger booking.
   - Return-from-checkout race: Concurrent `confirm` endpoint and webhook delivery book the sale exactly once.

2. **`tests/inline-stripe-refunds.test.ts` (6 tests)**
   - Headroom bounds: Enforces line-level and order-level headroom limits, rejecting over-refunds with 400.
   - Race conditions: Concurrent refund attempts on the same line serialized via order row locking; capacity is never exceeded.
   - Ambiguous outcome reservation: When provider returns 502/network drop, the refund reservation remains active in `refund_requests`, preventing over-refunding while in-flight.
   - Definitive rejection: 400 `amount_too_large` resolves the reservation as rejected and unreserves line headroom.
   - Dashboard refunds: External refunds (`origin: "provider"`) booked to `platform:unallocated_refunds` without corrupting seller accounts.
   - Refund failure & reversal: Lifecycle transitions from succeeded/pending to failed post exact ledger reversals, restoring net clearing balance and line headroom.

3. **`tests/inline-razorpay.test.ts` (5 tests)**
   - Minimum refund validation: Rejects INR refunds under 100 minor units pre-flight before reservation or network I/O.
   - Checkout & payment capture: Orders API flow, simulated payment capture, HMAC-SHA256 signature verification, and balanced double-entry ledger.
   - Webhook signature security: Rejects bad Razorpay HMAC signatures.
   - Idempotency in refunds: Verifies `X-Refund-Idempotency` header passing and target resolution.
   - Concurrent checkouts: Concurrent requests for same Razorpay order return the same payment reference without duplicate creation.

4. **`tests/worker-stripe-payments.test.ts` (6 tests)**
   - Order validation: Validates seller existence, positive minor units, ISO currency codes.
   - Job queue integration: Webhook returns 200 immediately, enqueues durable job; worker drains queue and updates payment records.
   - Job deduplication: Deduplicates webhooks via `provider_event_id` in Postgres `jobs` table.
   - Suspense accounting: Mismatched or unexpected payment amounts routed to `platform:unallocated_receipts` rather than misallocating to sellers.
   - Manual capture: Verifies authorized payment leaves order in `authorized`; manual capture books money.
   - Crash recovery: Re-queues jobs left in `'running'` by crashed worker processes.

5. **`tests/worker-stripe-refunds.test.ts` (4 tests)**
   - Line headroom: Enforces line headroom in QueueBazaar and updates order statuses (`partially_refunded`, `refunded`).
   - Lost response handling: Network drops mark request `unknown`, enqueue `resolve_refund_request`, retain reservation against over-refunds, and link exact webhook without re-posting.
   - Out-of-order dashboard refunds: Handles dashboard refund arriving before payment webhook by reconciling payment first and booking to unallocated refunds.
   - Reversal & illegal resurrection: Failed refunds reverse recognition; attempts to resurrect a reversed refund throw `ProviderError`.

6. **`tests/worker-razorpay.test.ts` (3 tests)**
   - INR refund minimum: Validates Razorpay INR 100 minor unit minimum prior to reserving capacity.
   - Asynchronous payment processing: Razorpay webhook parsing, HMAC verification, job queue drainage, and balanced double-entry ledger.
   - Idempotency & rejection: Passes `X-Refund-Idempotency` header and releases reservations upon definitive 400 rejection.

7. **`tests/cross-cutting-money-invariants.test.ts` (11 tests)**
   - Banker's rounding properties: Half-even rounding at exact `.5` boundaries (`5 -> 0`, `15 -> 2`, `25 -> 2`, `35 -> 4`, `45 -> 4`, `55 -> 6`).
   - Conservation of money: Property-based proof across 1000 generated amounts that `seller_amount + commission_amount === line_amount` with zero penny lost.
   - Ledger zero-sum: Property-based proof across 500 multi-line combinations that `sumLegs(saleLegs) === 0n`.
   - Headroom invariance: Property-based proof that headroom calculation strictly accounts for all refunds holding money and active reservations.
   - Strict input validation: Rejects non-integers, floats, exponents, negatives, and SDK overflow.
   - State machine monotonicity: Proves terminal payment states (`succeeded`, `canceled`) can never transition backwards.

---

## Money Risks Covered

1. **Double Charging & Duplicate Payments**:
   - Concurrent checkouts racing on the same order.
   - Network drop after payment creation at provider before response is stored locally.
   - Verified that `checkout_create_started` prevents sending a second payment creation request after ambiguous outcome.

2. **Over-Refunding & Headroom Leaks**:
   - Refunding more than line total or order total.
   - Concurrent refund attempts on the same line racing to over-refund.
   - Ambiguous refund responses keeping capacity reserved so client cannot issue parallel requests that over-refund.

3. **Webhook Redelivery & Out-of-Order Delivery**:
   - Duplicate webhook delivery with identical event IDs deduplicated at database level (`processed_events` in inline, `jobs` table unique index in worker).
   - Webhook delivery arriving before checkout API response returns.
   - Observation events (`created`, `authorized`) updating identity without prematurely booking captured money.
   - External dashboard refunds arriving before payment webhooks.

4. **Idempotency & Retry Safety across Retention Windows**:
   - In-flight network drops / 5xx errors from provider.
   - Proof that ambiguous refund requests are never re-sent blindly across retention expiry, relying instead on exact provider-object reconciliation.

5. **Double-Entry Ledger Invariants & Mathematical Precision**:
   - Conservation of money across platform and sellers: $\sum \text{amount} = 0$ for every ledger transaction.
   - Provider clearing account balance strictly tracks net money at provider ($\text{total captured} - \text{refunds holding money}$).
   - Half-even (Banker's) rounding verified to prevent systemic drift or bias in commission calculations.
   - Mismatched or unallocated money routed to suspense accounts (`platform:unallocated_receipts` or `platform:unallocated_refunds`) rather than corrupted across seller balances.

6. **Provider Contract Rules**:
   - Razorpay INR minimum refund rule: < 100 minor units rejected pre-flight before reservation or network I/O.
   - Safe integer limits and integer minor unit domain enforcement across wire formats.
   - Signature verification: Webhook signatures strictly verified with HMAC-SHA256 / Stripe webhook secrets.

7. **Crash Recovery & Concurrency Resilience**:
   - Worker marketplace crash recovery cleans up `'running'` jobs to `'queued'` upon startup.
   - Inline marketplace recovery periodically scans and reconciles due refund requests.
