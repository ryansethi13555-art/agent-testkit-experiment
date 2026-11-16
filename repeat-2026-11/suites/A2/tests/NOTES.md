# Independent money-correctness suite

Total: **242 tests**, 4 files, none skipped, none failing. Two consecutive full runs were green (about 10 s).

## Run

```
MI_PG_ADMIN_URL=postgres://postgres@127.0.0.1:5432/postgres \
  node node_modules/vitest/vitest.mjs run --configLoader native tests/
```

Each file creates its own uniquely named throwaway database (`ta_*`) and drops it afterwards. No application source or existing test was modified.
(Running the repo's default config also runs `inline-marketplace/test/refund-races.test.ts`. Its v1 suite imports a `../../leakybazaar` directory that is not in this workspace, so that one suite fails to load. That is pre-existing and unrelated to `tests/`.)

## What is tested and why

Both apps are driven through their public HTTP surface against real Postgres. Provider calls go to fakes that behave like the real providers on the points the brief lists: idempotency replay, lost responses, "applied then 5xx / connection dropped", 429 before execution, refunds that stay pending and later fail, partial capture, and signed webhooks.

| File | Tests | Covers |
|---|---|---|
| `inline-stripe.test.ts` | 78 | inline-marketplace on a fault-injecting fake Stripe HTTP server (real SDK, real signatures) |
| `inline-razorpay.test.ts` | 14 | the same app on a fake Razorpay (order id as payment ref, HMAC webhooks, event-id header, INR 100 minimum) |
| `worker-marketplace.test.ts` | 78 | webhook to durable job to worker to ledger, with an in-memory provider |
| `money-pure.test.ts` | 72 | pure money rules in both apps, with property tests (fast-check) against an independent oracle |

Properties each file checks:

- **Money input.** Floats, negatives, exponents, signs, unsafe integers and over-range sums are rejected. Amounts at 2^53-1 go through checkout, ledger and refund without loss.
- **Sale booking.**
  - Clearing equals sellers plus commission.
  - Commission is half-even and independently recomputed.
  - Every ledger transaction balances per currency.
  - Currency is preserved.
- **Duplicates and races.**
  - Same event id delivered sequentially or concurrently books once.
  - Different event ids for one payment, racing the return-from-checkout path, book once.
  - Late `created` / `capturable` observations change nothing.
- **Webhooks.** Missing, wrong, tampered or stale signatures apply nothing. An event for an unrecorded order gets 503 and leaves no trace. An event before the checkout is recorded is retried, not booked.
- **Provider disagreement.** Short capture, over capture, changed amount, changed currency, an event redirected onto another order, a second payment for a paid order, and a partial capture are never booked as the order's sale. A suspense account or a refusal is used instead.
- **Checkout.** Idempotent. Concurrent calls create one provider payment. A lost create response never produces a second payment, including after a restart.
- **Manual capture.** Authorisation books nothing. A capture with a lost response is not booked on a guess. It is booked exactly once when the provider confirms, by webhook, confirm, or queue reconcile.
- **Refund reservation.**
  - Validation happens before any provider I/O.
  - Parallel refunds cannot exceed a line or the order.
  - Reservations and dashboard refunds are counted together.
- **Refund uncertainty.**
  - A lost response, a 5xx, or a dropped connection keeps the amount reserved. The refund is never re-POSTed. The inline app waits out its recovery timer and the worker app runs its resolver job to its attempt limit.
  - An exact provider event later links it once, with no double count of reservation plus refund.
  - Same-amount provider refunds are never linked by amount.
  - Definitive rejections (429 before execution, `amount_too_large`) release the reservation.
- **Refund lifecycle.**
  - Pending, succeeded and failed transitions are covered.
  - A refund is recognised once and reversed once.
  - A failed refund is terminal against stale or duplicate events.
  - Provider state, not the webhook body, decides status.
  - A refund that reappears after failure is not re-recognised.
  - Wrong currency, a request on another order, and mismatched amounts are refused.
- **Delivery order.** A refund event before the payment event is retried (inline) or reconciles the payment first (worker).
- **Worker queue.**
  - Dedupe by event id, re-queue of dead letters, retry backoff and the attempt budget.
  - Crash recovery (`recover()`, `recoverRefundRequests()`).
  - Five concurrent workers never run a job twice.
- **Database guards.** An unbalanced ledger transaction is rejected at commit, including one balanced only across currencies. A ledger slot cannot be posted twice. CHECK constraints hold.

### Do the tests have teeth?

I ran 16 hand-made mutations of a scratch copy of the application source (not the workspace) against the suite. Examples: commission rounds half-up, the captured-amount check is removed, reservations are ignored in headroom or at order level, failed refunds can be resurrected, reversal is skipped, a duplicate payment is allocated to sellers again, an ambiguous refund is re-sent, capture is re-sent.

- 14 were killed.
- Two were not killed and are redundant code: removing the `processed_events` marker (the payment and refund paths are independently idempotent), and removing only the first of two guards against re-sending an ambiguous refund. Removing both guards is killed.
- One test was added after the first round (reservations plus dashboard refunds against the order total).

## Observations for the owners (not asserted as failures)

- `worker-marketplace` marks an order `paid` as soon as any money is captured, even when a partial capture was routed to suspense and nothing was allocated to sellers. The tests assert only the money facts (suspense, no allocations, line refunds blocked), not the order status. Whether an underpaid order should read `paid` is a product decision.
- `inline-marketplace` uses a constant idempotency key per order for capture (`capture_<orderId>`). If a provider stores and replays an early error result for the same key, a later legitimate capture would replay the failure. My fake does not replay error results, because I could not establish Stripe's behaviour here. The test therefore does not try to capture again after an early failure. It confirms via the provider event instead.

## Not tested, and why

- **Real provider fidelity.** The fakes encode the brief's behaviours, not Stripe's or Razorpay's full semantics. Idempotency-key retention windows and expiry cannot be exercised, since a fake has no wall clock.
- **Partial capture initiated by the app.** Neither app requests a partial capture. Only a provider reporting one is tested.
- **True process crashes.** A kill between two statements is only simulated. Persisted states are written directly (for example a `requested` refund row, or a `running` job) and recovery is run. Crash points inside a single transaction rely on Postgres atomicity.
- **Postgres lock timing.** The advisory-lock and `FOR UPDATE` races are exercised with real concurrency (10 to 12 parallel requests). That makes them probabilistic detectors rather than exhaustive schedules. The assertions are on final invariants, so they do not flake.
- **Razorpay through the worker app's money paths.** Only its webhook parsing and INR minimum are covered there. The Stripe-shaped fake covers the shared logic. The inline app is covered on both providers.
- **Multi-currency FX and zero-decimal currencies.** Neither app converts currency. Only USD and INR are used, with currency preserved and mismatches refused.
- **`confirm` and `capture` under provider outages for Razorpay in the worker app, and the HTTP server's body-size limit.** Out of scope for money correctness.
