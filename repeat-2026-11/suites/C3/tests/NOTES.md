# Money correctness suite: notes

## How to run

```
MI_PG_ADMIN_URL=postgres://postgres@127.0.0.1:5432/postgres \
  node node_modules/vitest/vitest.mjs run --configLoader native tests/
```

288 tests in 6 files, none skipped, about 6 minutes (each scenario boots a real app process). Files run one at a
time (see `vitest.config.mjs`); each test uses its own database (`ct_*`, dropped afterwards), its own app process and
its own provider twin, so tests do not share state. Needs local Postgres (`MI_PG_ADMIN_URL`).

The two pre-existing `inline-marketplace/test/refund-races.test.ts` suites fail at import on this checkout
(`Cannot find module '/leakybazaar/src/server.ts'`, a v1 path that is not in the workspace). That is independent of
this suite, and I did not touch it. Running plain `vitest run` therefore reports that one file failed; `tests/` is clean.

## Approach

Real processes, real Postgres, ground truth from the provider twin. `tests/harness.ts` starts `inline-marketplace` or
`worker-marketplace` as a child process (`node src/server.ts`) against a throwaway database, and a provider twin
(`SimServer` from `@moneyinvariant/engine` over the Stripe or Razorpay dialect and the canonical `World`). Every
scenario runs on all four combinations: inline/worker x Stripe/Razorpay. The test plays the buyer, the dashboard and the
provider's webhook sender (signed with the twin's secrets). Faults come from the twin's gate: lost response after apply
(`apply_then_reset`), 5xx after apply, 5xx or 429 before apply, timeout, crash of the app after apply (kill -9), and
rendezvous holds for true concurrency at the provider. Idempotent replay and key expiry are the twin's.

After a scenario `assertBooks` audits the app's stored state against the twin's truth (not against HTTP replies).
The laws, taken from PLAYBOOK.md: ledger transactions balance per currency; each posting slot appears once; clearing
account equals provider captured minus money-holding refunds, per currency; order paid iff captured and never more
than the order total collected; one provider payment per order; sale legs net to zero; refunds never exceed the line or
the order; app refunds and provider refunds agree in set, amount, currency and outcome; refund recognition exists
exactly while the provider holds the refund (no residue after failure); refund legs net to zero.

## Files

* `payments.test.ts` (80): split with half even rounding on odd amounts, duplicate/concurrent/fresh id webhooks, buyer
  return vs webhook, dropped webhook, declined then paid, stale failure after success, reversed fan out events,
  double submit checkout, lost or failed checkout, manual capture (lost response, 5xx after apply, crash after apply),
  unknown order, non INR currency, interleaved orders.
* `refunds.test.ts` (98): partial refunds and bounds, invalid requests, idempotency keys, Razorpay minimum, concurrent
  refunds (race and provider rendezvous), 5xx and 429 before apply, lost answer after apply (three kinds), key
  expiry then restart, crash during refund, refund notice before payment notice, stale pending after final,
  async pending then failed (reversal once, capacity released, refund again), duplicate failure notices, dashboard
  refunds (duplicates, counted against later API refunds, provider over refund refusal), Stripe requires_action
  revert, odd amount multi piece refunds.
* `webhook-security.test.ts` (34): wrong secret, missing header, tampered body, stale timestamp (Stripe), forged refund
  notices, garbage bodies, hostile money inputs (0, negative, fractions, exponents, above 2^53, strings), exact total.
* `durability.test.ts` (32): provider lookup failures during notice processing, acknowledged means committed or queued,
  crash after acknowledgement, repeated crashes, crash mid refund notice, worker only: running job re queued after
  kill -9, one job per event id, in flight refund never resent; inline only: no dedupe marker after failed processing.
* `money-units.test.ts` (12): property tests (fast-check) of both apps' pure money modules against an independent
  reference: half even commission, sale legs conservation, headroom, strict amount parsing, status machine.
* `random-schedules.test.ts` (32): seeded random schedules of orders, payments, refunds with faults, dashboard
  refunds, async outcomes and partial/duplicated/reordered delivery, then the provider retries everything and all
  laws are checked. Same seed, same schedule.

## Deviations from the brief

The test kit as installed differs from the brief. `createProviderTwin` takes `{ dialect }` (no `provider`,
`twin.url`, `signStripeWebhook`) and `assertFinancialCorrectness` needs bindings and invariant definitions (no `pgUrl`),
and no invariant packs ship in `node_modules`. I used `createProviderTwin`'s underlying pieces directly (`SimServer`,
`World` with async refund settlement, the dialect packages, `dialect.encodeEvent` for signed webhooks) and wrote the money
laws myself as SQL against the app's tables plus the twin's `World` facts.

## Not tested, and caveats

* Real provider behaviour: only the twin's contract model. Razorpay `order.paid` fan out is delivered, but late
  authorisation, authorisation expiry and partial capture were not driven.
* The twin's idempotency key retention is forgotten on demand (`expireIdempotencyKeys`), not by a 24 hour clock.
* A refund request left in an unknown state (lost answer, no webhook ever) stays reserved by design in both apps; the
  tests assert it is never resent and never double counted, not that it resolves without provider evidence.
* Multiple app processes, a second worker, or database failover were not tested (the apps declare one process).
* Tests assert laws and outcomes, not exact HTTP codes, where the apps legitimately differ (200, 202, 409, 502).
* Mutation check: I could not modify application source, so I did not run mutants against the apps. The audit and
  scenarios were chosen from the PLAYBOOK so that double posting, a missed refund, a stale event overwriting a final
  state, a missing reversal, over refund and wrong order attribution would each fail them.
