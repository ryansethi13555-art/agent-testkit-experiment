# Money-correctness suite

Run (99 tests, about 40 s, needs Postgres at MI_PG_ADMIN_URL):

    MI_PG_ADMIN_URL=postgres://postgres@127.0.0.1:5432/postgres node node_modules/vitest/vitest.mjs run --configLoader native tests/

(The path filter `tests/` matters: the default config also includes `inline-marketplace/test/*`, and the existing
`refund-races.test.ts` there imports a non-existent `../../leakybazaar/src/server.ts` for its "v1" suite, so it fails
independently of this work.) Each file creates and drops its own uniquely named database.

## Approach
Black box at the HTTP boundary. `tests/helpers/fakeStripe.ts` and `fakeRazorpay.ts` are stateful fakes of the provider
REST APIs, so the real stripe-node / razorpay-node SDKs and the apps' own adapters run unchanged. The fakes model:
idempotency keys (replay returns the first response), lost responses after the effect was applied, 5xx before the
effect, 429, manual and partial capture, refund capacity, pending/failed refunds, dashboard refunds without app
metadata, and a hold that lets a test deliver a webhook while an API call is in flight. Every scenario ends with
ledger invariants (each transaction balances, no effect posted twice, clearing equals captured minus live refunds,
seller and commission amounts exact, order status derived from live refunds).

| File | Tests | Covers |
|---|---|---|
| inline.sales | 27 | half-even commission, zero-decimal currency, concurrent/duplicate/out-of-order webhooks, unknown payment, retry after failed delivery, amount/currency/identity mismatch, partial capture, concurrent checkout, lost create response, lost capture response, unsafe amounts |
| inline.refunds | 22 | line/order capacity, concurrent over-refund, lost response never re-posted, 5xx/429/definitive rejection, crash before and after POST marker, same-amount dashboard refund not misattributed, pending/failed/stale events, event before sale, property test over status timelines and event orders, API-response vs webhook races |
| inline.razorpay | 5 | event-id and payload-hash dedupe, signature, INR minimum before any reservation, idempotency header, lost response, failed refund reversal |
| worker.sales | 24 | webhook to durable job, ack only after enqueue, body untrusted, concurrent workers, stale snapshots, suspense for partial/second/foreign money, 5xx retry, dead-letter requeue on redelivery, crash recovery, checkout and capture recovery |
| worker.refunds | 17 | reservation races, unknown outcome never re-sent, rejected releases capacity, attribution of same-amount dashboard refund, restart of in-flight request, lifecycle property test, API-response vs job races |
| worker.razorpay | 4 | dedupe, minimum, lost response, failure reversal |

Sanity check: I temporarily mutated copies of the sources (not committed, copies deleted). Killed: half-up commission,
missing line reservation, resend of unknown refund, no failure reversal, partial capture booked, removed uncorrelated
hold, duplicate checkout create, unknown treated as rejected, no capture-once guard, payment status regression,
partial capture allocated to sellers, dead letters not re-queued. Survivors were equivalent mutants (the webhook dedupe
marker is redundant with order/refund state locks; the early checkout guard duplicates the atomic UPDATE guard).

## Could not / did not test
- Real provider semantics (idempotency key expiry is only simulated by clearing the fake's key table).
- Multi-process deployment (apps declare single process); only advisory-lock paths inside one process are raced.
- Crash injection at arbitrary instruction points; crashes are modelled by writing the durable row states the code
  documents (post_started, requested, running).
- Razorpay is covered for the main flows only; Stripe carries the long tail.
- Behaviour I found questionable but did not pin: a partially captured worker payment sets the order to `paid`
  (money is safely held in suspense, sellers untouched).
