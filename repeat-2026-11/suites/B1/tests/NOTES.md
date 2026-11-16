# Payments test suite notes

## Run
```
MI_PG_ADMIN_URL=postgres://postgres@127.0.0.1:5432/postgres node node_modules/vitest/vitest.mjs run --configLoader native tests
```
84 tests in 3 files (about 6 s, run 4 times in a row with no flake). Each file creates and drops its own uniquely named
Postgres database. Running the whole config (without the `tests` filter) also runs the apps' own
`inline-marketplace/test/*`; `refund-races.test.ts` there fails on a missing `../../leakybazaar` import. That is an existing
problem in the workspace, not part of this suite.

| File | Tests | Target |
|---|---|---|
| `tests/inline-marketplace.test.ts` | 35 | inline app, real HTTP server and real Stripe webhook parsing, in-memory provider world |
| `tests/worker-marketplace.test.ts` | 35 | worker app (Shop, job table, Worker), pure money rules, DB constraints |
| `tests/razorpay-adapters.test.ts` | 14 | both apps through the real Razorpay adapters against a fake Razorpay HTTP API |

Helpers: `tests/helpers/world.ts` (provider truth: payments, refunds, Stripe-style idempotency keys, fault injection
before/after apply, latency for races, signed Stripe events), `tests/helpers/rzp.ts` (fake Razorpay API with the
`X-Refund-Idempotency` header), `tests/helpers/db.ts`.

## Method
Assertions compare the app's database and ledger with the provider world's true state, not with HTTP answers. After
scenarios an `invariants()` check asserts:
- every ledger transaction balances per currency, and no posting slot (cause, effect, account) is written twice;
- a refund's clearing effect is exactly its amount while it holds money (pending, requires_action, succeeded) and exactly zero
  once failed or canceled, with at most one reversal;
- per-line and per-order refunds never exceed the line or the order;
- order paid if and only if the provider captured the full amount, with the sale booked for exactly that amount;
- `provider:clearing` equals provider captures minus provider refunds holding money;
- the app's refunds equal the provider's refunds (same set, amount, status) once settled.

## Scenario families covered (both apps, Stripe semantics; Razorpay adapters in the third file)
- Webhooks: same event id duplicated sequentially and concurrently, fresh ids for the same occurrence, forged / unsigned /
  tampered / wrong-secret / stale-timestamp signatures (no effect, nothing enqueued), refund event before the payment event,
  stale refund snapshots after failure or success, requires_action returning to success, events for unknown or foreign
  payments, wrong currency, wrong amount, partial capture, wrong order identity, over-captured refund totals. Worker: the webhook
  body is not trusted (a lying "succeeded" event books nothing).
- Razorpay: event-id header dedupe and body-hash dedupe, captured-before-authorized snapshots, failed-then-captured attempts.
- Provider API faults: checkout create applied and response lost (never a second payment, even after idempotency expiry),
  double-submitted checkout, capture applied and response lost, capture refused, refund applied and response lost, refund 5xx
  or network error before apply, 429 on the first POST, provider refusing an over-refund the app did not know about.
  The apps must never re-POST a possibly committed refund, must keep capacity reserved, and must link it from the exact event.
- Crash and restart: persisted unsent reservations are sent once, crash after the send marker is never re-sent
  (inline), `recoverRefundRequests` and `Worker.recover` (worker), a job that failed for good is revived by redelivery, and
  re-applying a job never double-books.
- Races: concurrent refunds on one line and across lines (latency injected, outcomes counted exactly), concurrent duplicate
  webhooks, two workers draining one queue, confirm racing a webhook, dashboard refund racing an API refund of the same amount.
- Amounts: half-even commission remainders (5, 15, 25 at 10%), JPY, sum-of-parts properties (fast-check) for the sale
  split, malformed money inputs (fractions, exponent strings, negatives, above 2^53, whitespace, null), Razorpay INR minimum
  of 100 minor units applied before any reservation or POST.
- Attribution: refunds go back to the seller of the refunded line, a line of another order is refused, dashboard refunds are
  attributed to the right order and to the unallocated refunds account, a refund carrying another order's request id is not linked.

## Observations (asserted loosely on purpose, since the intended behaviour is unclear)
- worker: a captured amount different from the order total is booked to suspense (no seller credit, no allocation, line refunds
  refused). The derived order status for such an order is `paid` while only part is captured. I assert the money, not the label.
- inline, Razorpay: retrying `capture` on an already captured payment answers 502 (provider refuses). Money is unaffected, so I only
  assert that the books do not change.
- inline: after an ambiguous refund the line capacity stays reserved, so a legitimate retry is blocked until an exact event arrives.
  Tests assert only the safety property (provider total never exceeds the line), so a future safe auto-resolve would not break them.

## Not tested
- Real Stripe or Razorpay: the fake providers only model the documented behaviours; the real SDK network retry paths
  (`maxNetworkRetries`, the Node-versus-Fetch hidden retry) are not exercised.
- Idempotency-key expiry is only simulated (`expireIdempotency`), not time based. No app clock was advanced.
- Process crashes are simulated with persisted state (rows left in flight, jobs left `running`), not by killing a process
  between two statements. Transaction-boundary crashes inside one request were not injected.
- Stripe partial capture via `amount_to_capture` (the apps always capture in full), multi-currency orders, Razorpay late authorization
  after the app gave up on an order and order reuse across several payment attempts beyond failed-then-captured, ISK/UGX and
  three-decimal currency rules, refund.succeeded reverting to requires_action over a long delay.
- HTTP layer details (413 body limits, malformed JSON) beyond what the money paths need.
