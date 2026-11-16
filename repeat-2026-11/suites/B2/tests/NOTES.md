# Independent money-correctness suite

## Run
```
MI_PG_ADMIN_URL=postgres://postgres@127.0.0.1:5432/postgres node node_modules/vitest/vitest.mjs run --configLoader native tests
```
(the config in `vitest.config.mjs` also picks up `tests/**/*.test.ts` when running the whole workspace command in `RUN.md`).
Each file creates and drops its own uniquely named database. No test is skipped. ~21 s, 153 tests, run twice with identical results.

## Total tests: 153 in 6 files
| File | Tests | Scope |
|---|---|---|
| `inline/payments.test.ts` | 37 | inline app on a fake Stripe HTTP server: input validation, checkout, webhooks, capture, commission |
| `inline/refunds.test.ts` | 30 | inline app: API refunds, faults, lifecycle, crash recovery, stateful property |
| `inline/razorpay.test.ts` | 13 | inline app on a fake Razorpay HTTP server |
| `worker/orders-and-payments.test.ts` | 37 | worker app: webhook intake, reconciliation, checkout, capture, validation, job queue |
| `worker/refunds.test.ts` | 24 | worker app: refunds, faults, lifecycle, restart recovery, stateful property |
| `money/money.test.ts` | 12 | pure money rules of both apps (rounding, parsing, state machines) |

## Method
Following PLAYBOOK.md: every scenario asserts the laws against stored state and the provider's true state, never HTTP bodies.
* `helpers/laws.ts`: every ledger transaction balances per currency; the whole ledger nets to zero; no posting slot realised twice; live refunds never exceed a line or the order; a live refund has exactly one recognition pair, a failed or canceled refund nets to zero in every account; app refund table equals provider refunds (existence, amount, status); order label derived from live refunds; clearing account equals captured minus live refunds.
* `helpers/fakeStripe.ts`, `helpers/fakeRazorpay.ts`: stateful HTTP fakes of the provider APIs (real SDKs talk to them via the apps' own redirect variables) with idempotency keys (first result replayed), cumulative refund bound, async refund states, and fault injection: apply then 500, apply then drop, 500 before applying, 429, drop before applying, plus dashboard (out of band) refunds and captures.
* `helpers/workerApp.ts`: in-process fake provider for the worker app with call counters and faults, real Postgres and real HTTP app, and an explicitly drained job queue (no timing dependence). Idempotency retention expiry is simulated by clearing the key table, so any resend of an uncertain call would create a visible second refund or payment.

Scenario families covered, in both apps where applicable: duplicate webhooks (sequential, concurrent, fresh event ids, with and without the Razorpay event id header), refund-before-payment ordering, stale and reordered refund events, late `payment.authorized`, forged/tampered/stale-timestamp signatures, lost capture response, crash after the provider captured, 5xx and 429 on refund with nothing applied, refund applied with lost response (never resent, linked later by signed event), definite rejection releases reservations, concurrent refunds on one line and across lines (rendezvous via real concurrent requests and row locks), sequential partial refunds past the line, async refund failure and reversal exactly once, failed refunds never revived, dashboard refunds counted against order/payment bounds, same-amount dashboard refund never mis-linked to an in-flight request, double-submit checkout, lost checkout response, partial capture, wrong currency, wrong amount, event metadata naming another order, second payment for one order held in suspense, Razorpay INR 100-minor-unit minimum, odd/tiny amounts with half-even commission ties, malformed/overflow amounts, crash recovery of durable reservations (committed but unsent; send marker set), job queue retry/backoff/dead letter/SKIP LOCKED/crash re-queue.

Two stateful property tests (one per app, 25 runs each) generate random histories of refunds, async settlements, dashboard refunds, notices and (worker) injected faults, then assert every law and agreement with the provider.

## Sensitivity check (not part of the suite)
To check the tests would catch plausible regressions I applied 33 single edits to a scratch copy of the apps (since deleted) and re-ran the relevant files. 27 were caught at once. Six survived: five are redundant duplicate guards (a resend check and a checkout-create check each protected twice; the processed-events marker, whose job object-level locks also do; a payment-identity check repeated by a second check; linking a reservation by amount, which a later amount check refuses). Removing both copies of the resend and checkout guards is caught. The sixth, commission tie rounding, and a refund currency check were genuine gaps, so I added deterministic tests for them, plus provider idempotency expiry before the checkout retry; all now fail on the mutants.

## Not tested or limited
* The apps' real SDK retry behaviour on timing (hung requests, slow responses past 5 s) is not exercised; faults are connection drops and status codes.
* Worker app is only driven through a fake provider object, not through the real Stripe/Razorpay SDK adapters (inline app covers the adapters over HTTP). Worker `provider.ts` mapping (e.g. Razorpay order/payment/refund snapshots) is therefore untested.
* Multi-process races (two app processes) are not tested; concurrency is many in-flight requests in one process against one database, which does exercise row and advisory locks.
* Real idempotency-key expiry over 24 h is simulated, not timed; backoff timing is only partly checked.
* Currencies other than INR/USD, zero/three-decimal handling at the provider boundary, FX, and multi-currency orders are not covered (apps only keep one currency per order).
* The inline app's background recovery timer is observed by waiting about 1.7 s (several 500 ms scans) in four tests; those waits are the only sleeps.
