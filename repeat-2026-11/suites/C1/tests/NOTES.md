# Money-correctness test suite: notes

## How to run

```
MI_PG_ADMIN_URL=postgres://postgres@127.0.0.1:5432/postgres \
  node node_modules/vitest/vitest.mjs run --configLoader native tests/
```

(about 6.5 minutes; the inline app is a real child process per test and its refund recovery scans run on a 500 ms
timer, so those tests wait for them). Every test creates its own uniquely named Postgres database, provider twin and
app instance and drops the database afterwards. Test files run serially (`vitest.config.mjs`).

Running the whole config (`run --configLoader native` without `tests/`) also picks up the applications' own
`inline-marketplace/test/*.test.ts`. One of those, `refund-races.test.ts` ("LeakyBazaar v1"), already fails at import
on the untouched workspace (`Cannot find module '/leakybazaar/src/server.ts'`, a v1 app that is not present) and
skips 7 tests. That is unrelated to this suite and was left alone as instructed.

Total tests in `tests/`: 175 (all passing, none skipped).

## What is tested and why

The apps are exercised black-box, over HTTP, with real Postgres and their real Stripe / Razorpay SDK adapters, against
a contract-faithful provider twin (`SimServer` + the cited Stripe and Razorpay dialects from `@moneyinvariant/*`).
The harness plays "the outside world" (customer pays, dashboard refunds, refund settlement, webhook delivery) directly
on the twin's World, so every ordering, duplication, loss and fault is chosen by the test. Both apps x both providers
run every scenario (`matrix()` in `tests/helpers/scenario.ts`), which is the "[inline|worker/stripe|razorpay]" prefix.

After every scenario `audit()` (in `tests/helpers/harness.ts`) checks the money laws against the apps' stored state
and the provider's true state (never HTTP responses):

* every ledger transaction and the whole book balance per currency;
* an order is paid / partially_refunded / refunded iff the provider captured the money, and the status matches the
  provider's live refunds;
* `provider:clearing` mirrors the provider per payment (captured minus live refunds), per cause, in the order's currency;
* sale legs are exact per line with half-even 10% commission; seller and platform accounts equal what the provider
  truth implies (this catches duplicated, missing or misattributed postings even when the transaction balances);
* provider refunds and app refunds agree on existence, amount and settled outcome; failed / canceled refunds leave no
  residue; each refund is recognised once and reversed at most once;
* refund bounds per line, per order, and per provider payment;
* attribution: a refund is booked to a line of the order whose payment moved, API refunds are attributed to a line and
  dashboard refunds never inherit one;
* no unresolved refund reservations remain when the scenario is meant to be settled.

Scenario families (`tests/payments.test.ts`, `tests/refunds.test.ts`):

* sale booking: half-even ties and odd amounts, multiple sellers, USD and JPY, decline then success, nothing booked
  before capture;
* webhook hazards: sequential and concurrent duplicates, forged / unsigned / tampered signatures, dropped webhook
  recovered via return-from-checkout, reverse-order events, events for payments the app never created;
* capture faults: lost response, applied-then-500, rejected-before-apply, dashboard capture, with retries;
* checkout: concurrent double submit, lost create response and key expiry (must never create a second payment);
* refunds: bounds (sequential, concurrent, cross-line, cross-order, dashboard-origin), invalid amounts, Razorpay INR
  100 minor unit minimum, lost response, applied-then-500, 5xx before apply, Stripe 429, resend after idempotency key
  expiry, app crash and restart with refunds or payments in flight, held-together provider calls;
* asynchronous refund lifecycle: pending to failed / succeeded / canceled, succeeded back to requires_action (Stripe),
  stale and replayed notices after the final one, failed refund followed by a new refund;
* out-of-band refunds: recorded once without a line, bound later API refunds, refund-before-payment ordering,
  an API refund and a dashboard refund of the same amount, identical amounts on two orders at once;
* `tests/property.test.ts`: fixed-seed fast-check sequences of random orders, partial refunds, bursts, lost responses,
  replays and refund settlement, audited after each sequence (per app x provider);
* `tests/money.test.ts`: pure money rules of both apps (half-even oracle, conservation of sale legs, exact parsing
  and SDK conversion, headroom arithmetic, status derivation, payment forward-only rule);
* the audit is itself tested (it must flag tampered ledgers and refunds the app never heard about).

## Deviations from the brief and things not tested

* The brief describes `createProviderTwin({ provider })`, `twin.url`, `twin.signStripeWebhook`, `twin.gate.next(...)`
  and `assertFinancialCorrectness({ pgUrl, twin, appId })`. The installed `@moneyinvariant/engine` has a different
  API (`createProviderTwin({ dialect })`, `injectFault(GateRule)`, `assertFinancialCorrectness({ dbUrl, bindings,
  invariants, ... })`, and no invariant pack files on disk). I therefore used the library's underlying pieces (`SimServer`,
  `World`, the dialects' `encodeEvent`, gate rules) and wrote the money-law checks as `audit()` instead of using the
  packaged invariant packs.
* Source is not mutated in this suite (rule: no changes under `*/src`), so I could not run a mutation campaign;
  sensitivity of the audit is demonstrated by the "audit itself" test only.
* Not covered: multiple simultaneous payment attempts for one order, partial captures (the apps declare them out of
  scope), refunds older than the provider's refund window, real wall-clock 24 hour idempotency expiry (simulated with
  `expireIdempotencyKeys()`), multiple app processes sharing one database, Razorpay late authorisation, webhook
  timestamp tolerance (Stripe) and non-INR provider minimums.
* The worker app is run in-process (one process, as designed); the inline app as a child process so it can be killed
  with SIGKILL. The worker "crash" is a hard close of its server and pool followed by the startup recovery path.
* Timing: inline tests wait about 1.1 s per drain for its 500 ms refund recovery scan; no test relies on a race
  winner, concurrency tests assert order-independent outcomes only.
