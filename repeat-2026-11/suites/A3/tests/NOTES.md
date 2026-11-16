# Money-correctness suite for inline-marketplace and worker-marketplace

## Run

```
MI_PG_ADMIN_URL=postgres://postgres@127.0.0.1:5432/postgres \
  node node_modules/vitest/vitest.mjs run --configLoader native tests
```

(`MI_PG_ADMIN_URL` defaults to that value.) Each test file creates its own uniquely named database
(`mit_<tag>_<pid>_<rand>`) and drops it afterwards. No application source and no existing test was changed.
Runtime is about 20 seconds. All 104 tests pass, none are skipped.

## Files and test counts

| File | Tests | What it covers |
|---|---|---|
| `tests/inline-money.test.ts` | 42 | Inline app (real server, real Postgres) against an in-memory provider with fault injection |
| `tests/worker-money.test.ts` | 32 | Worker app (webhooks enqueue, queue drives money logic), same style of provider fake |
| `tests/inline-stripe-wire.test.ts` | 11 | Inline app through the REAL Stripe SDK adapter against a fake Stripe HTTP API |
| `tests/pure-and-adapters.test.ts` | 19 | Pure money rules of both apps; real Stripe and Razorpay webhook parsing |
| `tests/helpers/*` | n/a | DB creation, independent commission reference, the two provider fakes |

## What is tested, and why

Properties a payments reviewer would insist on, checked at the HTTP/queue boundary and then by reading the database:

* Ledger: every transaction balances per currency; provider clearing always equals captured minus refunds the provider holds
  (`assertSound`, run after most tests and after every step of the random histories); each seller account equals
  minus net sales plus recognised refunds on that seller's lines; allocations split each line exactly with the specified
  10 % half-even commission (checked against an independent implementation), no line allocated twice.
* Duplicate delivery: same event id delivered 8 to 12 times concurrently, different event ids for the same payment, confirm
  and webhook and checkout racing, redelivery of dead-lettered jobs. A sale is booked once; a refund is booked once.
* Out of order and stale: refund event before payment event (retry later, then applied once); stale or contradictory
  refund status in an event body or provider read cannot resurrect a failed refund or double-book; stale payment reads
  cannot move a payment backwards.
* Lost responses and crashes: create-payment, capture and refund where the provider applied the effect but the caller
  saw an error (also a dropped socket through the real SDK, and a 500 after apply). Never a second payment create, never a
  resent possibly-committed refund POST (also across recovery scans, concurrent recovery workers, worker retries up to the
  dead letter, and a durable "post started" marker after a crash). The amount stays reserved until the exact provider object
  arrives; then the request is linked once. A definitive rejection (400 amount_too_large, 429 before execution) releases it.
* Refund limits and races: 12 concurrent refunds on one line, concurrent refunds across lines, dashboard (provider-origin)
  refunds counting against the order or payment, an unknown reservation limiting its own line, Razorpay INR minimum applied
  before reserving.
* Refund lifecycle: pending holds money; pending to succeeded; pending or succeeded to failed reverses exactly once and
  restores capacity and order status.
* Capture: manual capture once under concurrency, lost capture response, failure before apply, partial capture is never booked
  as the full sale (inline: not booked; worker: held in suspense, unallocated, not refundable per line), a second provider
  payment for one order goes to suspense.
* Input and tampering: malformed, negative, fractional, exponent, oversized amounts; currency codes; payment whose amount,
  currency or order metadata differs; forged, unsigned, altered and expired webhook signatures (Stripe and Razorpay).
* Queue: concurrent workers never run a job twice (SKIP LOCKED), backoff, dead letter, crash recovery, DB-level guards
  (deferred balance trigger, once-only ledger slot).
* Random histories (fast-check, sequences of refunds with faults, dashboard refunds, status flips, duplicates) on both apps.

A small mutation check (done in a scratch copy, not in the repo) confirmed the suite fails on: half-up commission, ignoring
refund reservations, resending an ambiguous refund (both guards removed), re-booking a capture, skipping the refund reversal,
and treating unknown refund requests as unreserved. Removing only the inline `processed_events` check is NOT detected
because the order and refund merges are independently idempotent.

## Observation (not asserted as a bug)

Worker app: six concurrent `POST /orders/:id/capture` calls can return a retryable 502 ("payment snapshot changed immutable
money or currency") to a caller whose provider read was taken before another capture committed. Money state stays correct
(single booking); a retry returns 200. The test accepts 200 or 502 for the concurrent calls and then asserts the retry is 200.

## Not tested

* Real Razorpay wire behaviour (orders/payments/refund endpoints, `X-Refund-Idempotency`); only webhook parsing and the
  minimum-amount rule are tested for Razorpay.
* Real process kill and restart (crash points are simulated with durable rows and by calling recovery directly).
* Stripe idempotency-key expiry (24 hour retention), real network timeouts, clock skew.
* Multi-currency FX; the apps have no FX path (only that a ledger transaction stays in the order's currency).
* Authentication, HTTP body limits, performance and load.
