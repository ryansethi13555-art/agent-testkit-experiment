# MoneyInvariant adversarial payments playbook (generic knowledge, no app- or bug-specific content)

This playbook packages what a payments-correctness tool knows about how providers can misbehave and which money laws must hold. Use it to design tests: for each scenario family and provider behaviour, ask "what happens to the books if this occurs at every possible point in the order/payment/refund lifecycle?" and assert the money laws below after every scenario.

## How to use it
1. Model each provider object (payment/intent, capture, refund) and each app object (order, line, refund request, ledger) as a state machine. For every legal transition at the provider, test it arriving before, after, twice, late, and interleaved with every app action (create order, checkout, capture, refund line, cancel), including after the app has already finished processing a previous notice.
2. Inject faults around every outgoing provider call: fail before applying; apply then lose the response; apply then 5xx/429/timeout; apply then crash the app process; resend after idempotency expiry.
3. Vary inputs systematically: amounts that do not divide evenly (remainders, 1 minor unit, odd values), multiple lines and multiple sellers, partial captures, partial and multiple refunds, non-default currencies, minimums.
4. After every scenario, check the money laws (below) against the app's stored state and the fake provider's true state, not against HTTP responses.

## Curated adversarial scenarios

- **S01** Duplicate webhook (sequential, fresh event id)
- **S02** Duplicate webhook (concurrent)
- **S03** Refund event delivered before the payment event
- **S06** Capture applied, response lost across all retries
- **S09** Concurrent refunds on one order line (rendezvous)
- **S04** Stale refund event delivered after the final one
- **S05** Payment webhook dropped, retried after the app already recovered
- **S08** Provider 5xx on refund, nothing applied
- **S10** Sequential partial refunds summing past the line amount
- **S11** Client double-submits checkout
- **S13** Refund fails asynchronously after acceptance
- **S14** App crashes right after the provider applied a capture
- **S16** Forged payment webhook (invalid signature)

## Money laws to assert (payments-core 0.3.0)

- **alloc.refund-line-same-order**: A refund allocated to an order line is a refund of a payment for that line's order. When the app allocates a refund to an order line (refunds.line_ref), the money must have moved back on a payment for the order that line belongs to. Allocating it to a line of another order debits the wrong seller or line budget, leaves the right one apparently unrefunded (so it can be refunded again), and makes the line bound (refund.line-bounded) judge the wrong line. The provider only knows the
- **alloc.part-same-order**: Money allocated to a part of an order moved on a payment or refund of that same order. Any allocation of provider money to a sub-part of an order (a line, or a seller's or platform's share derived from a line, or a split) belongs to the order whose payment or refund the money moved on. An allocation that lands on a line of another order credits or debits the wrong party; one that names a line or a provider object that does not exist attributes money to nothing. Requires the optional
- **alloc.declared-part-arithmetic**: Each part of a declared split equals its declared rate of the whole under its declared rounding. Only where the app declares how a part is computed (a rate as an integer fraction and a rounding mode, plan §I.2) does MoneyInvariant judge the arithmetic; it never guesses a rate. A part declared with one of the seven rounding modes must equal whole × rate_num / rate_den rounded in that mode, exactly, in integer minor units. Parts declared 'largest_remainder' (weights rate_num / rate_den) must ea
- **alloc.declared-parts-sum-to-whole**: The parts of a declared split sum exactly to the whole, per currency. Splitting money must neither create nor lose a minor unit: the parts of one split (declared or remainder) sum exactly to the whole they divide (plan §I.2, allocation conservation). Rounding each part independently without assigning the residue to a remainder part, or a part written twice, breaks this. Every row of one split must state the same whole; a split whose rows disagree about the whole has
- **ledger.clearing-mirrors-provider**: The app's provider-clearing ledger mirrors the provider's money movements, per cause. A ledger is a claim about money. The account that represents funds at the payment provider must move exactly as the provider's balance moves for the same cause (bank reconciliation, per transaction). Booking a refund the provider never completed, keeping it after the provider failed it, missing a capture, or booking a different amount all leave the app's books claiming money that is not where they
- **ledger.failed-operation-no-residue**: A provider operation that failed leaves no net effect on any ledger account. When the provider reports a refund or payment as failed or canceled, no money moved for it. Every account the app touched for that cause (seller, platform, clearing, suspense) must net back to zero, whether the app never booked it or booked it and reversed it. A partial compensation (cash restored, seller still debited) leaves a party owed or charged for something that did not happen. This needs n
- **effect.once-per-provider-event**: Each intended economic posting slot is realised at most once. One business or provider occurrence may justify several allocations, including equal amounts to the same account. Each intended allocation or recognition slot must be realised at most once per account and currency. effect_ref is stable semantic attribution scoped to the financial cause, reused across retries and delivery envelopes, never a row or transaction id. Reversals have their own stable slo
- **ledger.txn-balanced**: Every ledger transaction balances, per currency. Double entry; a committed state where a transaction does not sum to zero is a partial write.
- **refund.line-bounded**: Refunds on an order line never exceed the line amount. The provider only bounds refunds by the payment total; per-seller line bounds are the platform's own derived state and nothing outside the app protects them.
- **order.paid-iff-captured**: Money captured at the provider if and only if the order is recorded as paid. Money taken for an order the app considers unpaid (or the reverse) is lost or unearned money.
- **recon.refunds-agree**: Provider refunds and app refunds agree once settled. Every refund the provider made must be recorded by the app with the same amount, and vice versa.
- **intent.api-refund-accounted-once**: Every refund the app created through the provider API is recorded by the app and claimed at most once. A refund the app's own API path created at the provider is the effect of an intent the app recorded. Each such provider refund that can still move money (anything but failed or canceled) must be known to the app: an orphan is money the app's own path moved without knowing it, e.g. a retry without an idempotency key or a timeout after the provider applied the request (contracts stripe api.network-e
- **intent.order-collection-bounded**: The provider never keeps more for an order than the order is due. Each order the app records is one payment intent. However many provider payments the app's checkout path created for it (a retried checkout, a payment that authorised late after the app gave up on it and started another, contracts razorpay payment.late-authorisation and api.order-and-capture-no-idempotency-key, stripe api.500-side-effects-and-late-webhooks), the money the provider keeps for the or
- **refund.lifecycle-no-regression**: A refund's status only moves along transitions the provider contracts document. A refund outcome is a fact about the outside world. The app's record of it may only move the way the provider says the object can move. Undocumented moves, such as succeeded back to pending, mean older information overwrote newer information (a stale or reordered event, or a lost update), and decisions taken on the regressed state (another refund, a payout) are taken on a false picture. Failed and
- **recon.refund-outcome-agrees**: Once settled, the app's refund status agrees with the provider's. recon.refunds-agree compares which refunds exist and their amounts, not their outcome. An app that shows a refund as pending after the provider completed it (stale), as succeeded while the provider failed it (contradiction), or as final while the provider is still processing it (premature) misstates where the money is to its users and to its own later decisions. After every delivery has drained, t

## Documented provider behaviours (contract corpus)


### stripe

- `webhook.duplicate-delivery` (documented): The same Event may be delivered to an endpoint more than once.
- `webhook.duplicate-distinct-event-objects` (documented): Stripe may generate two separate Event objects (different event IDs) for the same occurrence. Deduplication by event ID alone is therefore insufficient; the docs advise keying on the data.object ID plus event type.
- `webhook.unordered` (documented): Events are not guaranteed to be delivered in the order they were generated.
- `webhook.created-not-an-ordering` (documented): Event `created` timestamps have one-second resolution; distinct events can share a timestamp, and `created` must not be used to order events or detect reprocessing.
- `webhook.payload-snapshot-at-event-time` (documented): A snapshot event carries the object as it was when the event occurred, and Event objects are immutable after creation. A late-delivered event therefore carries stale object state.
- `webhook.retry-schedule` (documented): Failed deliveries are retried with exponential back-off for up to three days in live mode; sandbox deliveries are retried three times over a few hours.
- `webhook.retry-stops-if-endpoint-disabled` (documented): If the destination is disabled or deleted when a retry is due, future retries of that event are cancelled.
- `webhook.manual-resend` (documented): An event can be manually resent from the Dashboard (up to 15 days after creation) or the CLI (up to 30 days), and manual resends do not cancel automatic retries. Resends are a legitimate source of repeated delivery of an already-processed event.
- `webhook.response-2xx-quickly` (documented): The endpoint must return a 2xx quickly, before complex logic that could cause a timeout.
- `webhook.redirect-is-failure` (documented): 3xx responses to webhook deliveries are treated as failures.
- `webhook.timeout-causes-redelivery` (inferred): A delivery that the app processed but acknowledged too slowly (timeout) or with a non-2xx is a failed delivery and is retried, so the app sees the same event again after having applied it.
- `webhook.duplicate-concurrent` (inferred): Two deliveries of the same logical event can be in flight at the endpoint at the same time (for example a retry or a second Event object arriving while the first handler still runs).
- `webhook.delivery-timeout-seconds` (assumed): The numeric timeout Stripe applies to a webhook delivery attempt.
- `webhook.endpoint-auto-disable` (assumed): Whether and when Stripe automatically disables an endpoint that keeps failing.
- `signature.header-format` (documented): Each signed event carries a Stripe-Signature header with a `t=` timestamp and one or more scheme-prefixed signatures (`v1=`; test events also carry a fake `v0`).
- `signature.hmac-sha256-v1` (documented): Signatures are HMAC-SHA256; verifiers must ignore schemes other than v1.
- `signature.signed-payload` (documented): The HMAC key is the endpoint signing secret and the message is signed_payload, which the same page defines as the timestamp string, the character ".", and the raw JSON request body.
- `signature.timestamp-tolerance` (documented): Official libraries reject events whose signed timestamp is more than 5 minutes from the current time (configurable).
- `signature.replay-mitigation` (documented): The timestamp is part of the signed payload, so a replayed valid payload can be rejected on age alone.
- `signature.fresh-per-attempt` (documented): Every delivery attempt, including retries, gets a new timestamp and signature. A legitimate retry therefore passes the tolerance check; only a replay of a captured old request fails it.
- `signature.multiple-secrets-during-roll` (documented): While a rolled secret is kept alive (up to 24 hours), Stripe sends one v1 signature per active secret.
- `idempotency.header` (documented): Idempotency keys are sent in the Idempotency-Key request header, for POST requests.
- `idempotency.result-replay` (documented): The first result for a key (status code and body, success or failure, including 500s) is saved and returned for later requests with the same key.
- `idempotency.replayed-header` (documented): A response replayed from the idempotency cache carries the header `Idempotent-Replayed: true`.
- `idempotency.ttl-24h` (documented): Retries with the same key are safe only within 24 hours; keys expire after 24 hours.
- `idempotency.reuse-after-prune` (documented): Keys may be pruned once at least 24 hours old; reusing a pruned key executes a new request (for example a second refund).
- `idempotency.parameter-mismatch` (documented): Reusing a key with different parameters returns an error instead of executing.
- `idempotency.not-saved-unless-executed` (documented): Results are not saved when parameter validation fails or the request conflicts with a concurrently executing request with the same key; such requests can be retried.
- `idempotency.conflict-409` (documented): A request conflicting with another (for example the same idempotency key in flight) gets HTTP 409.
- `idempotency.key-uniqueness-scope` (documented): Keys must uniquely identify one operation within the account over at least the last 24 hours.
- `idempotency.rate-limit-precedes` (documented): Rate limiting (429) and some 401/400s run before the idempotency layer, so they are not cached and nothing was executed.
- `api.network-error-unknown-outcome` (documented): On network errors (socket errors, timeouts, premature connection close) the client cannot know whether the request was received or applied.
- `api.500-indeterminate` (documented): A 500 response must be treated as indeterminate; the operation may or may not have taken effect.
- `api.500-side-effects-and-late-webhooks` (documented): After a 500, Stripe may roll the operation forward or back during reconciliation and fire webhooks for objects created by reconciliation; requests that returned 500 can still have user-visible side effects.
- `payment.delayed-notification-processing` (documented): For payment methods with delayed notification, the PaymentIntent stays `processing` until it succeeds or fails; payment is not guaranteed during the delay.
- `payment.async-takes-days` (documented): Asynchronous payment methods (for example bank debits) can take up to a few days to process.
- `payment.failed-attempt-retryable` (documented): A failed payment attempt returns the PaymentIntent to `requires_payment_method` so it can be retried; one PaymentIntent can therefore emit payment_failed and later succeeded.
- `payment.uncaptured-auto-cancel` (documented): Uncaptured PaymentIntents are cancelled a set number of days (7 by default) after creation.
- `payment.authorization-expiry-cancels` (documented): If an authorisation expires before capture, funds are released and the payment becomes canceled.
- `payment.no-cancel-after-success` (documented): A succeeded PaymentIntent cannot be canceled.
- `capture.partial-releases-remainder` (documented): Capture may be for less than the authorised amount via amount_to_capture; the remainder is released automatically.
- `capture.single-capture` (documented): For most payments only one capture is allowed; after a partial capture the difference cannot be captured.
- `refund.partial-multiple` (documented): A charge can be partially refunded multiple times until fully refunded.
- `refund.over-refund-rejected` (documented): Refunding an already fully refunded charge, or more than remains, returns an error (cumulative bound enforced by the provider).
- `refund.statuses` (documented): Refund status is one of pending, requires_action, succeeded, failed, canceled.
- `refund.async-failure` (documented): A refund can fail after creation; Stripe sends refund.failed and the merchant must return funds another way.
- `refund.failure-up-to-30-days` (documented): Refund failure is caused by the customer's bank or issuer; the amount returns to the Stripe balance and the process can take up to 30 days.
- `refund.succeeded-may-revert` (documented): For refunds where Stripe collects the customer's bank details, a refund in `succeeded` can move back to `requires_action` when the customer's bank returns the funds.
- `refund.pending-insufficient-balance` (documented): If the available balance does not cover a refund, card refunds are held as pending (other payment method refunds fail) until the balance suffices.
- `refund.cancel-is-failure` (documented): Canceled refunds move to `canceled` and carry failure attributes; cancellation is a type of refund failure.
- `events.payment-intent-succeeded` (documented): payment_intent.succeeded is sent when a PaymentIntent completes payment.
- `events.payment-intent-payment-failed` (documented): payment_intent.payment_failed is sent when a payment attempt fails.
- `events.payment-intent-processing` (documented): payment_intent.processing is sent when a delayed-notification payment starts processing.
- `events.payment-intent-canceled` (documented): payment_intent.canceled is sent when a PaymentIntent is canceled.
- `events.charge-refunded` (documented): charge.refunded is sent for full and partial refunds; refund details come from refund.created.
- `events.refund-updated` (documented): refund.updated is sent whenever a refund is updated.
- `events.refund-failed` (documented): refund.failed is sent whenever a refund has failed.
- `currency.minor-units` (documented): Amounts are integers in the currency's minor unit; currencies are two-decimal unless stated otherwise.
- `currency.zero-decimal` (documented): Zero-decimal currencies take the amount without multiplication. Listed on retrieval: BIF CLP DJF GNF JPY KMF KRW MGA PYG RWF UGX VND VUV XAF XOF XPF.
- `currency.isk-two-decimal-representation` (documented): ISK is zero-decimal in practice but must be sent as a two-decimal value whose decimals are always 00 (dialect override of ISO exponent 0).
- `currency.ugx-two-decimal-representation` (documented): UGX must be sent as a two-decimal value whose decimals are always 00, yet UGX also appears in the zero-decimal list (contradiction, see README).
- `currency.huf-twd-payout-divisible-by-100` (documented): HUF and TWD charges may have two decimals, but manual payouts in them must be divisible by 100 (V0.2, payouts).
- `amount.minimum-charge` (documented): A minimum charge applies per settlement currency (for example 0.50 USD, 0.50 INR, 50 JPY on retrieval).
- `amount.maximum-digits` (documented): Card amounts are limited to 12 digits in minor units (9 for most American Express); some non-card methods have lower limits (INR 9 digits).
- `events.payment-intent-created` (documented): payment_intent.created is sent when a new PaymentIntent is created.
- `events.payment-intent-amount-capturable-updated` (documented): payment_intent.amount_capturable_updated is sent when a PaymentIntent has funds to be captured (the event of a manual-capture authorisation). The Stripe dialect already emits it; this replaces its ASSUMED marker.
- `events.charge-succeeded` (documented): charge.succeeded is sent whenever a charge is successful.
- `events.charge-captured` (documented): charge.captured is sent whenever a previously uncaptured charge is captured.
- `events.charge-failed` (documented): charge.failed is sent whenever a charge attempt fails.
- `events.refund-created` (documented): refund.created is sent whenever a refund is created. The Stripe dialect already emits it; charge.refunded's own description also points to it ("Listen to refund.created for information about the refund").
- `events.multiple-per-action` (documented): One action can trigger several events (the page's example is a subscription creating two events).
- `events.fan-out-payment` (inferred): A PaymentIntent state change emits a PaymentIntent event and a Charge event: a successful automatic-capture payment emits payment_intent.succeeded and charge.succeeded; a manual capture emits payment_intent.succeeded and charge.captured; a failed attempt emits payment_intent.payment_failed and charg
- `events.fan-out-refund` (inferred): Creating a refund emits refund.created and charge.refunded (full or partial); a later status change of the refund emits refund.updated, and a failure also emits refund.failed.
- `events.fan-out-concurrent-delivery` (inferred): The events of one fan-out are separate deliveries with no documented ordering or serialisation, so they may reach the endpoint in either order or at the same time.
- `refund.dashboard-origin` (documented): Refunds can be issued from the Dashboard as well as the API (out-of-band refunds the app did not request), and the cumulative bound applies to both.
- `refund.card-cancel-dashboard` (documented): Some card refunds can be canceled for a short time after creation, from the Dashboard only (out-of-band).
- `capture.dashboard` (documented): An uncaptured payment can be captured from the Dashboard (an out-of-band capture the app did not request).
- `signature.every-event-signed` (documented): Stripe signs every webhook event with the Stripe-Signature header, so a request without the header (or with a signature that does not verify) was not sent by Stripe.
- `events.charge-expired` (documented): charge.expired is sent whenever an uncaptured charge expires (the Charge-side event of an authorisation expiry).
- `events.charge-pending` (documented): charge.pending is sent whenever a pending charge is created (delayed-notification payments).
- `events.payment-intent-requires-action` (documented): payment_intent.requires_action is sent when a PaymentIntent needs customer action (e.g. authentication).

### razorpay

- `webhook.duplicate-delivery` (documented): Webhooks have at-least-once delivery; the same event may arrive multiple times.
- `webhook.timeout-5s-redelivery` (documented): If the endpoint accepts an event but does not respond within 5 seconds, the delivery is marked as timed out, treated as unprocessed, and sent again.
- `webhook.duplicate-concurrent` (inferred): A redelivery can reach the endpoint while the first delivery of the same event is still being processed (the server accepted it but had not answered within 5 seconds).
- `webhook.event-id-header` (documented): The x-razorpay-event-id header is unique per event and identifies duplicate deliveries.
- `webhook.unordered` (documented): Webhooks may not arrive in the order the events occurred (for example payment.captured before payment.authorized).
- `webhook.payload-snapshot-at-event-time` (documented): A webhook payload is a snapshot of the entity when the event occurred; a payment may already be captured when its payment.authorized webhook is sent.
- `webhook.async-near-real-time` (documented): Webhooks are asynchronous and near real-time, not synchronous with the API call.
- `webhook.retry-24h` (documented): Any non-2xx response is a delivery failure; failures are retried with exponential back-off for 24 hours after event creation.
- `webhook.auto-disable-after-24h` (documented): If deliveries keep failing for 24 hours the webhook is disabled and must be re-enabled from the Dashboard.
- `webhook.unacknowledged-not-redelivered` (documented): Events not acknowledged within the 24-hour retry window are not delivered again automatically (permanent drop unless replayed).
- `webhook.replay-at-least-once` (documented): Merchants can replay unacknowledged events (up to 7 days old via Dashboard); replay is at-least-once and may deliver an event already processed.
- `signature.webhook-hmac-sha256` (documented): The webhook signature is HMAC-SHA256 over the raw request body, keyed with the webhook secret.
- `signature.webhook-header` (documented): The signature is sent in the X-Razorpay-Signature header.
- `signature.raw-body` (documented): Verification must use the raw request body, not a parsed or re-serialised one.
- `signature.no-signed-timestamp` (inferred): The webhook signature covers only the body; no timestamp is signed, so the provider offers no timestamp tolerance and a captured valid request can be replayed with a valid signature. Replay must be rejected by event-id deduplication, not by signature checks.
- `signature.old-secret-for-retries` (documented): After a secret change, retries of older events are signed with the old secret (validation page wording).
- `signature.checkout-payment-signature` (documented): The Checkout success callback carries razorpay_signature = hex HMAC-SHA256 of order_id + "|" + razorpay_payment_id, keyed with the API key_secret. The server must use its own stored order_id, not the one returned by Checkout.
- `idempotency.refund-header` (documented): Refund creation (normal and instant) is idempotent when the X-Refund-Idempotency header carries a key.
- `idempotency.refund-no-response` (documented): A refund request may get no response because of network problems, leaving the refund id and state unknown to the caller; retrying with the same key is the documented remedy.
- `idempotency.refund-payload-mismatch` (documented): A retry with the same key but a different body is rejected.
- `idempotency.refund-in-progress-409` (documented): A request arriving while a prior request with the same key is still processing gets 409 Conflict and may be retried.
- `idempotency.refund-key-ttl` (assumed): How long Razorpay retains a refund idempotency key.
- `idempotency.refund-receipt` (documented): The refund `receipt` is treated as an idempotency key per payment; a reused receipt returns an error ("Duplicate receipt found") rather than replaying the original result.
- `idempotency.payout-header` (documented): RazorpayX Create Payout and Composite APIs support the X-Payout-Idempotency header (V0.2 scope).
- `api.order-and-capture-no-idempotency-key` (assumed): No idempotency key is documented for Orders create or Payments capture. Retried order creation can create a second order; capture retry safety rests on the state guard (capture.only-from-authorized).
- `api.concurrent-payment-operation-rejected` (documented): A refund request is rejected (400) while another operation (another refund or a capture) is running on the same payment.
- `api.server-errors` (documented): The API can return 500, 502, 503 and 504 responses.
- `api.apply-then-timeout-general` (assumed): A capture or order request may take effect while the client sees a timeout or 5xx.
- `api.rate-limit-429` (documented): Rate-limited requests return 429 and should be retried with back-off.
- `payment.late-authorisation` (documented): A payment with no bank response is marked failed after 10 minutes; Razorpay keeps polling the bank for 3 days and moves it to authorized if the bank reports success.
- `payment.failed-to-authorized` (documented): A payment marked failed can later move to authorized; a notification is sent.
- `payment.auto-capture-default` (documented): By default, a completed payment is moved to captured automatically (capture settings apply only to Orders API payments).
- `payment.uncaptured-auto-refund` (documented): Payments left in authorized are refunded automatically if not captured within the capture window.
- `payment.capture-timeouts-configurable` (documented): Merchants can auto-capture only payments authorised within a set period and capture later ones manually; payments authorised after the manual timeout are auto-refunded.
- `payment.late-auth-may-stay-authorized` (inferred): A late-authorised payment can arrive as authorized but not captured (when it lands after the automatic capture timeout), and is auto-refunded if the app does not capture it in time. The app therefore sees payment.failed, then payment.authorized, possibly never payment.captured.
- `capture.only-from-authorized` (documented): Capture moves authorized to captured; capturing a payment in any other status errors.
- `capture.full-order-amount` (documented): The capture amount should equal the order amount; partial capture is not documented.
- `capture.requires-order` (documented): Payments made without an order_id cannot be captured and are refunded automatically.
- `order.paid-on-capture` (documented): Once a payment is captured the order is marked paid; order.paid and payment.captured both fire on capture.
- `refund.partial` (documented): A refund amount below the payment amount is a partial refund; omitting amount refunds the full payment.
- `refund.over-refund-rejected` (documented): A refund larger than the captured amount is rejected.
- `refund.cumulative-bound` (inferred): Cumulative refunds on a payment cannot exceed the captured amount.
- `refund.only-captured-payments` (documented): Refunds can only be created for payments currently in captured state.
- `refund.pending-then-final` (documented): A refund can remain pending (accepted, being processed by the bank or network) before reaching a final status.
- `refund.failed-state` (documented): A refund can end in `failed` (for example normal refunds on payments older than 6 months, or instant refunds failing for account or bank reasons).
- `refund.failed-event` (documented): refund.failed is triggered when Razorpay cannot process a refund.
- `refund.async-failure` (inferred): A refund accepted as pending can later fail, signalled by refund.failed, after the create call returned success.
- `refund.processed-before-arn` (documented): Razorpay usually marks a refund processed before receiving the ARN/RRN from the gateway (configurable via support).
- `refund.not-cancellable` (documented): Once issued, a refund cannot be cancelled or reversed.
- `refund.minimum-amount` (documented): The minimum refund amount is INR 1.00.
- `events.payment-authorized` (documented): payment.authorized is triggered when a payment is authorised.
- `events.payment-captured` (documented): payment.captured is triggered when a payment is captured.
- `events.payment-failed` (documented): payment.failed is triggered when a payment fails (including timeouts).
- `events.refund-created` (documented): refund.created is triggered when a refund is created.
- `events.refund-processed` (documented): refund.processed is triggered when a refund is successfully processed.
- `fee.includes-gst` (documented): The payment `fee` includes GST, which is also reported separately as `tax`.
- `payout.webhooks-unordered-terminal` (documented): RazorpayX payout webhooks may arrive out of order; payout.processed and payout.reversed are described as the last states, and webhooks received after them should be ignored (V0.2).
- `currency.subunits` (documented): Amounts are integers in currency subunits (paise for INR; ₹1 = 100).
- `currency.three-decimal-last-digit-zero` (documented): For three-decimal currencies (KWD, BHD, OMR) the last decimal digit must be passed as 0, so amounts are multiples of 10 in minor units (dialect override).
- `currency.zero-decimal-jpy` (documented): Zero-decimal currencies such as JPY are passed without multiplication.
- `amount.minimum-order` (documented): The minimum order amount is INR 1.00 (sample error on Orders create).
- `events.order-paid` (documented): order.paid is triggered when an order is successfully paid (on capture of its payment, order.paid-on-capture).
- `events.refund-speed-changed` (documented): refund.speed_changed is triggered when a refund's speed changes (instant to normal).
- `events.fan-out-auto-capture` (inferred): An automatically captured payment of an order emits payment.authorized, payment.captured and order.paid; the payment.authorized payload is the authorised-time snapshot even though the payment is already captured.
- `events.fan-out-concurrent-delivery` (inferred): The events of one state change (payment.captured and order.paid; payment.authorized and payment.captured) are separate deliveries that may arrive in either order or at the same time.
- `refund.dashboard-origin` (documented): Refunds can be initiated from the Dashboard as well as the API (out-of-band refunds the app did not request).
- `capture.dashboard` (documented): Authorised payments can be captured manually from the Dashboard (an out-of-band capture the app did not request).
- `order.multiple-payment-attempts` (documented): An order can have several payment attempts, successful and failed; each attempt is a separate payment (pay_…) under one order (order_…).
- `order.no-payment-after-paid` (documented): Once an order is paid no further payment is accepted for it, and it stays paid even if the payment is refunded.
- `currency.supported-exponents` (documented): Razorpay publishes the currencies it accepts for international payments with their exponents. On retrieval the table listed exponent 3 for BHD, IQD, JOD, KWD, OMR and TND, and exponent 0 for BIF, CLP, DJF, GNF, ISK, JPY, KMF, KRW, PYG, RWF, UGX, VND, VUV, XAF, XOF and XPF; the rest of the listed cur
- `webhook.created-at-event-time` (inferred): A webhook's `created_at` is the time of the event in integer unix seconds, so distinct events can share it and a late or reordered delivery carries an older `created_at` than events delivered before it.
