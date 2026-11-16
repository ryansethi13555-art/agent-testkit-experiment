# QueueBazaar v2 control candidate

A corrected development reference app with a Postgres webhook/job queue, Stripe and Razorpay SDK adapters, and a double-entry ledger. This is a **control candidate**, pending the development precision campaign and independent control adjudication. It is not evidence that MoneyInvariant has zero false positives.

The original `bench/queue-bazaar` and frozen campaign artifacts are unchanged. This version was developed after the fresh blind campaign was revealed; its author knew the missed case. Its tests and any runs are development/regression evidence, never new blind evidence. The original app's authorship provenance does not apply to these changes.

Changes from the original:

- Both refund adapters issue a single visible POST. Razorpay no longer retries internally on lost responses, 5xx, or subsequent lookup failures; the durable shop retains uncertainty and reconciles exact provider identity. A documented idempotency header alone supplies no retention proof after expiry.
- Keep a refund reservation when a later refusal follows an unknown attempt, including prior SDK-hidden attempts. Unknown requests now await exact provider-object reconciliation rather than resending a POST after its key might expire. A first-attempt definitive refusal can release it. A successful refund POST followed by a failed lookup remains unknown.
- Check payment/refund identities, exact minor-unit amounts, currency, request metadata and the original allocated payment before correlating financial state. Caller hints cannot override contradictory provider identity. A known unlinked refund cannot resolve a request merely because later metadata names it.
- Roll back a refund resurrection after its ledger reversal and leave reconciliation work unresolved, rather than silently reporting a successful job with mismatched accounting.
- Preserve Razorpay order money before any customer payment attempt. Check the raw payment identity before translating it to the app's stored order reference.
- Settlement requires no queued, running **or failed** jobs and no requested/unknown refund requests. Dead letters and unknown provider outcomes are not a clean control verdict.

The inherited design remains: one app process and one worker; order-row locks serialize financial transactions; a durable request reserves capacity before provider I/O; stable request identity survives recovery; unknown POSTs are never resent without retention proof; provider event IDs dedupe jobs; unique economic-effect slots and balanced transactions protect the ledger. Provider webhooks identify objects; the worker fetches their current state.

Limitations: this app does not promise recovery from every unsupported provider transition. A terminal refund becoming live again after reversal, contradictory identities, unavailable objects, or exhausted retries require investigation and can remain UNSETTLED. There is no automatic late reassignment of an already unlinked refund to a request. Multiple app/worker processes require a lease/recovery design. Razorpay order-level references do not model multiple simultaneous successful payment attempts for an order. These limits must be retained in control evidence, not counted as passing runs.

## Local use

From the repo root, start/reuse disposable Postgres with `scripts/pg-local.sh`, then create a dedicated database. Never point the destructive test/reset configuration at valuable state.

```bash
createdb -h 127.0.0.1 -U postgres qb_v2_stripe
cd bench/queue-bazaar-v2
export MI_DATABASE_URL=postgres://postgres@127.0.0.1:5432/qb_v2_stripe
../../bin/moneyinv check-config
../../bin/moneyinv test --seed 1 --runs 20
# A separate disposable database is required for the Razorpay config:
# ../../bin/moneyinv test --config moneyinvariant.razorpay.yaml --seed 1 --runs 20
```

The configs retain the original `payments-core@0.3.0` selection and original execution budgets. This is not the future CI/default profile or release-pack selection. MoneyInvariant redirects SDK calls to its simulator for test runs. Do not run this example against a real provider.

## Verification

```bash
node --test --test-concurrency=1 bench/queue-bazaar-v2/test/*.test.ts
pnpm exec tsc -p bench/queue-bazaar-v2/tsconfig.json
```

`scripts/check.sh` runs these tests in addition to the main Vitest suite. The conventional suite retains the original tests and adds financial identity/reservation/settlement regressions, exact SDK money conversions (1,000 sampled round trips), and actual pinned-SDK loopback tests. Postgres integration tests visibly skip when unavailable; a release-quality check requires zero skips. These tests are not the requested >=400-run precision campaign.

Intermediate `work_probe` drains runnable jobs while allowing a dead-lettered ambiguous refund resolver to await a held webhook. The final probe still rejects every failed job and unresolved request. Linking the exact refund request retires its failed resolver in the same transaction; unrelated failed jobs remain visible.

Before creating a reservation or issuing a refund POST, the Razorpay adapter enforces the pinned INR refund minimum (100 minor units; `contracts/razorpay/behaviours.yaml`, `refund.minimum-amount`). Other currency limits are not assumed. Invalid inputs therefore cannot become ambiguous requests after a lost rejection response. Existing unknown requests retain their reservations and remain subject to the strict final settlement probe.

Stripe rate-limit429 responses are pre-execution rejections under the pinned `idempotency.rate-limit-precedes` contract ([official explanation](https://docs.stripe.com/error-low-level#content-errors)). A first such response can reject its reservation; a later429 never releases an earlier unknown attempt. Refund-only SDK calls use Fetch with zero hidden retries so the durable recovery worker sees each uncertainty. Other SDK operations retain their existing retry settings.

V7 postmortem: unconditional retry of an unknown refund could create a second financial effect after provider key expiry. Recovery now preserves its reservation and awaits exact webhook/object identity. Startup treats an in-flight request conservatively even if the crash might have preceded the call. Missing authoritative evidence can remain UNSETTLED; no invariant, financial observation or strict final probe is weakened. Simulator expiry compresses retention without advancing app/DB clocks, so this boundary-model regression is not a measured 24-hour production reproduction.

### Integration-test database configuration

`MI_PG_ADMIN_URL` supplies the administrative connection used to create disposable test databases. The suites preserve its username, password and connection options when selecting those databases; password-authenticated CI is supported. Unreachable-database messages omit the URL to avoid logging credentials. Historical campaign snapshots are unchanged.

Pre-blind audit correction: checkout atomically persists one create marker before provider I/O and holds no pool connection across that I/O. In-flight/unknown contenders cannot create another provider order; a validated observation recovers the exact original identity. Response amount/currency/order identity must agree. Stripe create uses the existing Fetch/zero-retry SDK client so closed connections/5xx cannot hide a second POST; capture/read settings remain unchanged. Loopback tests cover reset/500/502/429 and24 contenders, with actual captured/order-due equality. Redirected mutations remain outside the modeled fault envelope. Prospective control configs select payments-core0.5.0; fresh validation is required, and original control/campaign bytes remain pinned.
