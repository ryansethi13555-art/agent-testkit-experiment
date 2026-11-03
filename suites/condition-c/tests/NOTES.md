# Payments Correctness Automated Test Suite — Condition C

## 1. Overview & Test Execution Command

This test suite provides automated, contract-faithful payments correctness verification for both **LeakyBazaar** (`inline-marketplace`) and **QueueBazaar** (`worker-marketplace`) across both supported providers (**Stripe** and **Razorpay**).

The suite is built using Vitest and the `@moneyinvariant/engine` R3 Test Kit (`createProviderTwin`, `assertFinancialCorrectness`).

### Execution Command

```bash
MI_PG_ADMIN_URL=postgres://postgres@127.0.0.1:5432/postgres node node_modules/vitest/vitest.mjs run --configLoader native tests/
```

### Summary of Results
- **Total Test Files:** 5
- **Total Tests:** 39
- **Passing Tests:** 39 (100% pass rate)
- **Failing / Skipped Tests:** 0
- **Execution Wall Time:** ~18 seconds

---

## 2. Test Files Breakdown

| Test File | Target Application / Scope | Provider | Test Count | Description |
|---|---|---|:---:|---|
| [`tests/provider-invariants.test.ts`](file:///home/ryan-sethi/.codex/blind-release-v2/plan-b/gemini-comp/ws-c/tests/provider-invariants.test.ts) | Provider Twin & Financial Oracle | Stripe & Razorpay | 4 | Unit verification of ProviderTwin fault injection (drop, 500, 429), webhook HMAC signing, and Financial Oracle detection of ledger imbalances and line headroom breaches. |
| [`tests/inline-marketplace-stripe.test.ts`](file:///home/ryan-sethi/.codex/blind-release-v2/plan-b/gemini-comp/ws-c/tests/inline-marketplace-stripe.test.ts) | LeakyBazaar (Synchronous inline marketplace) | Stripe | 12 | Comprehensive coverage of adversarial playbook scenarios S01–S16 on inline marketplace. |
| [`tests/worker-marketplace.test.ts`](file:///home/ryan-sethi/.codex/blind-release-v2/plan-b/gemini-comp/ws-c/tests/worker-marketplace.test.ts) | QueueBazaar (Asynchronous job worker marketplace) | Stripe | 13 | Comprehensive coverage of adversarial playbook scenarios S01–S16 on worker marketplace, including job deduplication and worker crash recovery (S14). |
| [`tests/inline-marketplace-razorpay.test.ts`](file:///home/ryan-sethi/.codex/blind-release-v2/plan-b/gemini-comp/ws-c/tests/inline-marketplace-razorpay.test.ts) | LeakyBazaar (Synchronous inline marketplace) | Razorpay | 5 | Razorpay-specific flows including signature verification (S16), webhook capture (S01), INR 100 minor unit minimum check, headroom bounding (S10), and provider 500 fault injection (S08). |
| [`tests/worker-marketplace-razorpay.test.ts`](file:///home/ryan-sethi/.codex/blind-release-v2/plan-b/gemini-comp/ws-c/tests/worker-marketplace-razorpay.test.ts) | QueueBazaar (Asynchronous job worker marketplace) | Razorpay | 5 | Razorpay queue worker integration, idempotent job processing, INR refund minimum boundary validation, line headroom capping, and fault injection. |

---

## 3. Playbook Scenarios Tested

The suite exercises the core adversarial scenarios from [`PLAYBOOK.md`](file:///home/ryan-sethi/.codex/blind-release-v2/plan-b/gemini-comp/ws-c/PLAYBOOK.md):

- **S01 — Duplicate webhook (sequential, distinct event id):** Delivers distinct event payloads for the same payment/refund. Confirms the marketplace records the payment once and creates only one set of double-entry ledger entries.
- **S02 — Duplicate webhook (concurrent):** Fires concurrent identical webhook requests. Confirms locking and unique constraints prevent duplicate ledger postings (`effect.once-per-provider-event`).
- **S03 — Out-of-order delivery (refund before payment):** Delivers a refund webhook before the initial payment webhook has arrived. Confirms the app safely rejects or defers the refund without financial corruption, and reconciles cleanly once payment arrives.
- **S04 — Stale refund event delivery:** Delivers a stale event with status `pending` after the refund is already `succeeded`. Confirms terminal statuses never regress (`refund.lifecycle-no-regression`).
- **S05 — Webhook dropped, app recovers via confirm / polling:** Simulates lost webhook. Merchant/buyer triggers checkout confirmation (`/orders/:id/confirm`) which queries provider truth and settles the order. When the dropped webhook is later retried, it is safely deduped.
- **S06 — Manual capture applied, response dropped across retries:** Simulates two-phase auth-capture flow (`capture: "manual"`). Confirms payment authorization, manual capture execution, and idempotency of capture retry (`order.paid-iff-captured`).
- **S08 — Provider 5xx on refund:** Injects HTTP 500 on refund API call via `twin.gate.next({ outcome: "500" })`. Confirms that no refund row is marked `succeeded`, no unbacked ledger refund postings exist, and QueueBazaar enters `unknown` state with background reconciliation.
- **S09 — Concurrent refunds on one order line (rendezvous):** Fires concurrent refund requests on a single line that individually fit within headroom but collectively exceed it. Confirms database row locking ensures the sum never breaches the line amount (`refund.line-bounded`).
- **S10 — Sequential partial refunds summing past line amount:** Exercises multiple partial refunds. Asserts that refunds within headroom succeed and any request pushing cumulative refunds beyond the line amount is rejected with HTTP 400 (`refund.line-bounded`).
- **S11 — Client double-submits checkout:** Simultaneously fires duplicate `/checkout` requests. Confirms only a single payment intent is generated at the provider (`intent.order-collection-bounded`).
- **S13 — Refund fails asynchronously after acceptance:** Configures twin with `refundSettlement: "async"`. Books refund in `pending`/`succeeded`, then applies simulated failure (`applyWorld({ kind: "settleRefund", outcome: "failed" })`). Confirms the double-entry ledger reverses cleanly without leaving phantom debits/credits (`ledger.failed-operation-no-residue`).
- **S14 — Worker crash and job recovery:** Simulates an in-flight worker failure leaving a job in `running` status. Restarts the worker and asserts that `worker.recover()` picks up the abandoned job and finishes processing without duplicate ledger writes.
- **S16 — Forged payment webhook (invalid signature):** Submits webhook payloads with forged or invalid signatures. Confirms rejection with HTTP 400, no jobs queued, and zero database mutations.
- **Razorpay Contract Rules:** Tests provider-specific rules including Razorpay INR 100-minor-unit refund minimum (`refundRequestError`), Razorpay order-id mapping, and HMAC-SHA256 signature verification.

---

## 4. R3 Test Kit Usage

The suite makes direct use of the `@moneyinvariant/engine` R3 Test Kit:

1. **`createProviderTwin`**:
   - Spawns in-process loopback simulator servers faithful to Stripe and Razorpay contract specifications.
   - Binds `@moneyinvariant/dialect-stripe` and `@moneyinvariant/dialect-razorpay`.
   - Exposes `twin.url` via `MONEYINV_STRIPE_API_BASE` and `MONEYINV_RAZORPAY_API_BASE`.
2. **`twin.gate` Fault Injection**:
   - Utilizes `twin.gate.next({ outcome: 'drop' | '500' | '429' })` to test network drops, internal server errors, and rate limits without external mocking libraries.
3. **`twin.world` and `applyWorld`**:
   - Manages stateful provider world simulations, customer payment completions (`customerPays`), and asynchronous refund resolutions (`settleRefund`).
4. **`assertFinancialCorrectness` & `FinancialOracle`**:
   - Audits database state inside `REPEATABLE READ READ ONLY` transactions.
   - Compiles and asserts financial invariants across all tests:
     - `ledger.txn-balanced`: Every double-entry transaction sums to zero.
     - `refund.line-bounded`: Refunds on any line never exceed the line amount.
     - `effect.once-per-provider-event`: Every economic posting slot is booked at most once.
     - `recon.refunds-agree`: Recorded refunds match provider settled truth.
     - `order.paid-iff-captured`: Order status agrees with captured funds.

---

## 5. Money Correctness Risks Covered

- **Double Crediting / Double Capture:** Prevented and verified under concurrent and retried webhook deliveries.
- **Headroom Breaches / Over-Refunding:** Verified under both concurrent races and sequential attempts exceeding seller line boundaries.
- **Status Regression / Lost Updates:** Verified that stale out-of-order notifications cannot revert terminal states.
- **Ghost Money & Unbalanced Books:** Verified that failed provider operations leave net-zero ledger balances and zero orphaned records.
- **Forged Money Movements:** Verified that unauthenticated or forged webhook payloads cannot inject money into the system.

---

## 6. Scope Limitations & What Could Not Be Tested

- **Multi-day idempotency key retention (>24h):** The 24-hour key expiration was not tested in real time (simulated clocks were used where applicable).
- **Hard OS crashes / disk corruption:** The test environment runs against a local PostgreSQL server; hardware-level filesystem failure or power cuts were out of scope.
