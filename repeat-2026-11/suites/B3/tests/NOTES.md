# Money-correctness test suite for inline-marketplace and worker-marketplace

## How to run

```
cd /home/claude/rep/B3
MI_PG_ADMIN_URL=postgres://postgres@127.0.0.1:5432/postgres node node_modules/vitest/vitest.mjs run --configLoader native tests
```

Total: 149 tests in 6 files, all passing, none skipped. The command in `RUN.md` (without the trailing `tests`) also runs these tests, but it additionally runs `inline-marketplace/test/refund-races.test.ts`. That existing file fails in this workspace, because its `v1` half imports `../../leakybazaar/src/*`, which is not here. It is unrelated to this suite and was left untouched. Each test file creates and drops its own uniquely named database. Files run one at a time. A full run takes about 20 seconds. The app's existing tests were not modified. They still run under the same command.

To run only these tests, add `tests` to the command. For example: `... vitest.mjs run --configLoader native tests`.

If Postgres is unreachable the integration files skip themselves with `describe.skipIf`. They never skip when it is reachable.

## Layout

| File | What it covers |
|---|---|
| `helpers/world.ts` | A stateful in-memory provider: payments, captures, refunds, idempotency keys, plus fault injection around every call. Also builds real signed Stripe-shaped webhook bodies. |
| `helpers/inlineHarness.ts`, `helpers/workerHarness.ts` | Glue for each app, database setup, and the **money-law checkers** (`assertBooks`, `assertWorkerBooks`). |
| `inline/payments.test.ts` | Inline app: input validation, checkout, payment webhooks, manual capture, ledger arithmetic. |
| `inline/refunds.test.ts` | Inline app: API refunds, unknown outcomes, provider-originated refunds, event ordering. |
| `inline/model.test.ts` | Inline app: randomised interleavings plus fixed hostile schedules. |
| `worker/units.test.ts` | Pure money rules of both apps (property tests), backoff, Razorpay minimum. |
| `worker/shop.test.ts` | Worker app: orders, checkout and capture, webhooks as jobs, refunds, recovery, queue. |
| `worker/model.test.ts` | Worker app: randomised interleavings plus fixed hostile schedules. |

## Method

* **The provider is a real state machine.** The world keeps the true state of every payment and refund. Idempotency keys return the first result. Faults are injected per call: `before5xx` (not applied), `reject` (definitive 4xx), `rate429` (not executed), `lost` (applied, then the response is lost).
* **Webhooks are real.** Events are signed with the Stripe SDK's test header and go through each app's own `parseWebhook`, so signature checks and event id handling are exercised. They carry a snapshot of the object at creation time, so stale, late and duplicate delivery is real.
* **Laws are checked on stored state against the world, not on HTTP answers.** After each scenario the checkers assert:
  * every ledger transaction balances per currency;
  * each posting slot (cause, effect, account) occurs once;
  * the sale posts once, with seller part = line − half-even 10% commission and platform = commission, against an independent reference implementation;
  * the provider clearing balance equals captured minus held refunds, per the world;
  * the stored payment and refund state agrees with the provider, and every provider refund is recorded once with the right amount and status;
  * a failed or canceled refund nets to zero on the ledger, and a held refund is recognised exactly once;
  * refunds per line and per payment never exceed the line or the capture;
  * the order is paid if and only if money was captured, and its derived status follows the refunds;
  * the provider never holds more than one payment or more than the total for an order;
  * a second captured payment lands in suspense and never credits a seller;
  * a refund request maps to at most one provider refund.
* **Scenario families** from the playbook: S01 and S02 duplicate delivery (sequential and concurrent), S03 refund before payment, S04 stale refund after final, S05 late retried delivery, S06 capture applied and response lost, S08 5xx on refund, S09 concurrent refunds on one line, S10 sequential partial refunds past the line, S11 checkout double submit, S13 async refund failure, S14 crash after the provider applied an effect (simulated by rows left in the durable states a crash would leave), S16 forged signature.
* **Property and model tests** (fast-check, fixed seeds so failures reproduce): random sequences of API refunds with random faults, bursts of concurrent refunds, dashboard refunds, legal status transitions, replays of old events, recovery scans. At the end every generated event is redelivered at least once in a random order, the system settles, and the laws are checked. Both apps get this treatment.
* **Mutation check** (done once, out of tree): 27 deliberate breakages of the app sources were applied one at a time to a scratch copy and the suite was run against each. See the result at the bottom.

## What is deliberately not asserted

The suite checks safety (no loss, duplication or misattribution of money). It does not assert design choices that a future change may legitimately revisit, for example:

* An ambiguous refund keeps its amount reserved forever until an exact provider event arrives (both apps never re-POST). The tests assert "never re-sent, never double counted, never over-refunded", not how long the reservation lives.
* A partial manual capture is refused (inline) or sent to suspense (worker). The tests assert only that it is never booked as the full sale and never credits more than was captured.

## Could not test, or only partly

* The real SDK and HTTP layer of the adapters (`provider.ts`) against a real or HTTP-level fake provider. The suites replace the provider with the world, except webhook parsing and signature checks, which use the app's real Stripe adapter. The Razorpay adapter's webhook and API paths are not exercised. Only its pure INR minimum rule is tested.
* True process crashes. Crash points are simulated by writing the durable rows a crash would leave behind and then running the recovery entry points (`recoverPendingRefunds`, `recoverRefundRequests`, `Worker.recover`).
* Real clock effects: the inline app's 500 ms recovery timer is faked off so the tests control every schedule, and retry times are advanced by updating the stored due time.
* Deadlocks and lock timeouts under heavy load. Races are tested with bursts of 4 to 6 simultaneous requests, which are reliable but are not a stress test.
* Multi-process workers. The worker app states that it runs exactly one worker process.
* Idempotency-key expiry is modelled only as "the provider forgot every key at once".

## Mutation check result

27 single-line breakages of the app sources were applied to a scratch copy. 20 were caught. 7 survived:

* Four are redundant guards. A second guard in the same code still blocks the behaviour, so the mutant is equivalent. They are: inline checkout resend, worker checkout resend, inline refund resend after ambiguity, and inline order-wide refund bound (the line bound implies it, except for dashboard refunds, which is now asserted).
* Inline webhook event dedupe: every handler is idempotent on its own, so removing the marker changes nothing observable.
* Inline "stale pending over succeeded": the refund path always uses the provider's current object, so the stale body cannot reach that code.
* Worker "create response overwrites status": not reachable with the current provider adapter.
* Three real gaps were found and then closed. They were: a refund booked to the wrong seller (the checker now asserts the account), a refund event acknowledged with 200 when another delivery holds the lock (new test), and the order-wide bound (the test now asserts 400 and no provider call).
