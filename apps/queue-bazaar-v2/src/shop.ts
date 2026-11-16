// QueueBazaar's money logic: orders, checkout, capture, per-line refunds, and the reconciliation of provider objects
// into the shop's tables and double-entry ledger. Shared by the HTTP API and the queue worker.
//
// Rules this file keeps (see README.md):
// * State comes from the provider object as fetched, never from a webhook body; a stored payment only moves forward.
// * Every money mutation locks the order row first, so all work on one order is serialised.
// * Every ledger posting has a (cause_ref, effect_ref, account, currency) slot that can be written once; a refund is
//   recognised while the provider holds it (pending / requires_action / succeeded) and reversed once if it fails or
//   is canceled. Transactions balance (checked by a deferred constraint trigger).
// * A refund request reserves its amount on the line before the provider is called, with the request id as the
//   idempotency key; an unknown outcome keeps the reservation and is resolved by a queued job.
import { randomBytes } from "node:crypto";
import { type Db, type Tx, tx } from "./db.ts";
import { enqueue } from "./jobs.ts";
import {
  COMMISSION,
  commissionOf,
  deriveOrderStatus,
  isRefundStatus,
  type Leg,
  lineHeadroom,
  MAX_AMOUNT,
  type PaymentStatus,
  parseMinorUnits,
  paymentMayMove,
  type RefundStatus,
  refundHoldsMoney,
  saleLegs,
} from "./money.ts";
import {
  type PaymentProvider,
  type PaymentSnapshot,
  ProviderError,
  type RefundSnapshot,
} from "./provider.ts";

type Json = Record<string, unknown>;
type Row = Record<string, unknown>;

export class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

const newId = (prefix: string) => `${prefix}_${randomBytes(6).toString("hex")}`;

interface OrderRow {
  id: string;
  currency: string;
  total: bigint;
  capture_method: "automatic" | "manual";
  status: string;
  payment_ref: string | null;
  checkout_create_started: boolean;
}
interface RefundRow {
  id: string;
  provider_ref: string;
  payment_ref: string;
  request_id: string | null;
  order_id: string;
  line_id: string | null;
  currency: string;
  amount: bigint;
  status: RefundStatus;
}

export class Shop {
  readonly db: Db;
  readonly provider: PaymentProvider;
  constructor(db: Db, provider: PaymentProvider) {
    this.db = db;
    this.provider = provider;
  }

  // ------------------------------------------------------------------------------------------------ orders
  async createOrder(body: Json): Promise<Json> {
    const rawLines = body.lines;
    if (!Array.isArray(rawLines) || rawLines.length < 1 || rawLines.length > 20)
      throw new HttpError(400, "an order needs 1 to 20 lines");
    const currency = body.currency === undefined ? "INR" : String(body.currency).toUpperCase();
    if (!/^[A-Z]{3}$/.test(currency)) throw new HttpError(400, "currency must be an ISO code");
    const capture = body.capture === undefined ? "automatic" : body.capture;
    if (capture !== "automatic" && capture !== "manual")
      throw new HttpError(400, "capture must be automatic or manual");
    const lines = rawLines.map((l: unknown) => {
      const line = (l ?? {}) as Json;
      const amount = parseMinorUnits(line.amount);
      if (amount === undefined || amount <= 0n)
        throw new HttpError(400, "line amounts must be positive integers in minor units");
      if (typeof line.seller_id !== "string") throw new HttpError(400, "every line needs a seller_id");
      return { seller: line.seller_id, amount };
    });
    const total = lines.reduce((s, l) => s + l.amount, 0n);
    if (total > MAX_AMOUNT) throw new HttpError(400, "order total too large");
    const buyer = typeof body.buyer === "string" ? body.buyer.slice(0, 100) : "buyer";
    const id = newId("ord");
    const lineIds = lines.map((_l, i) => `${id}_l${i + 1}`);
    await tx(this.db, async (c) => {
      const sellers = await c.query("SELECT id FROM sellers WHERE id = ANY($1)", [
        lines.map((l) => l.seller),
      ]);
      const known = new Set(sellers.rows.map((r) => r.id as string));
      for (const l of lines)
        if (!known.has(l.seller)) throw new HttpError(400, `unknown seller ${l.seller.slice(0, 40)}`);
      await c.query(
        "INSERT INTO orders (id, buyer, currency, total, capture_method, status) VALUES ($1, $2, $3, $4, $5, 'pending_payment')",
        [id, buyer, currency, total, capture],
      );
      for (const [i, l] of lines.entries())
        await c.query(
          "INSERT INTO order_lines (id, order_id, position, seller_id, currency, amount) VALUES ($1, $2, $3, $4, $5, $6)",
          [lineIds[i], id, i + 1, l.seller, currency, l.amount],
        );
    });
    return { id, currency, total: total.toString(), capture, lines: lineIds };
  }

  async getOrder(orderId: string): Promise<Json> {
    const o = (await this.db.query("SELECT * FROM orders WHERE id = $1", [orderId])).rows[0];
    if (!o) throw new HttpError(404, "no such order");
    const lines = (
      await this.db.query(
        "SELECT id, seller_id, amount FROM order_lines WHERE order_id = $1 ORDER BY position",
        [orderId],
      )
    ).rows;
    const refunds = (
      await this.db.query(
        "SELECT id, provider_ref, line_id, amount, status FROM refunds WHERE order_id = $1 ORDER BY created_at",
        [orderId],
      )
    ).rows;
    return { ...o, lines, refunds };
  }

  async #order(orderId: string): Promise<OrderRow> {
    const o = (await this.db.query("SELECT * FROM orders WHERE id = $1", [orderId])).rows[0] as
      | OrderRow
      | undefined;
    if (!o) throw new HttpError(404, "no such order");
    return o;
  }

  /** The buyer starts paying: create (or reuse) the provider payment for the order. */
  async checkout(orderId: string): Promise<Json> {
    const o = await this.#order(orderId);
    if (o.status !== "pending_payment") throw new HttpError(409, `order is ${o.status}`);
    if (o.payment_ref) {
      const snap = await this.provider.retrievePayment(o.payment_ref);
      if (
        snap.ref !== o.payment_ref ||
        (snap.orderId !== undefined && snap.orderId !== orderId) ||
        snap.amount !== o.total ||
        snap.currency !== o.currency
      )
        throw new ProviderError("unknown", undefined, "checkout lookup changed identity or money");
      await this.applyPayment(snap);
      return { payment_ref: snap.ref, client_secret: snap.clientSecret, status: snap.status };
    }
    if (o.checkout_create_started)
      throw new HttpError(502, "checkout outcome unknown; awaiting provider observation");
    // A lost response, crash or expired key never authorizes a second create.
    const begun = await this.db.query(
      "UPDATE orders SET checkout_create_started=true WHERE id=$1 AND status='pending_payment' AND payment_ref IS NULL AND NOT checkout_create_started RETURNING id",
      [orderId],
    );
    if (!begun.rowCount) throw new HttpError(502, "checkout outcome unknown; awaiting provider observation");
    const snap = await this.provider.createPayment({
      orderId,
      amount: o.total,
      currency: o.currency,
      capture: o.capture_method,
    });
    if (snap.orderId !== undefined && snap.orderId !== orderId)
      throw new ProviderError("unknown", undefined, "checkout response names another order");
    if (snap.amount !== o.total || snap.currency !== o.currency)
      throw new ProviderError("unknown", undefined, "checkout response changed money or currency");
    // A response and event can race; both must retain the same reference.
    const recorded = await this.db.query(
      "UPDATE orders SET payment_ref=$2 WHERE id=$1 AND payment_ref IS NULL RETURNING id",
      [orderId, snap.ref],
    );
    if (!recorded.rowCount && (await this.#order(orderId)).payment_ref !== snap.ref)
      throw new ProviderError("unknown", undefined, "checkout response conflicts with stored payment");
    await this.applyPayment({ ...snap, orderId: snap.orderId ?? orderId });
    return { payment_ref: snap.ref, client_secret: snap.clientSecret, status: snap.status };
  }

  /** The buyer is back from the payment page: verify with the provider, server-side. */
  async confirm(orderId: string): Promise<Json> {
    await this.#order(orderId);
    const refs = await this.#paymentRefs(orderId);
    if (!refs.length) throw new HttpError(409, "no payment for this order yet");
    for (const ref of refs) await this.reconcilePayment(ref);
    return { status: (await this.#order(orderId)).status };
  }

  async #paymentRefs(orderId: string): Promise<string[]> {
    const rows = (
      await this.db.query(
        `SELECT provider_ref FROM payments WHERE order_id = $1
         UNION SELECT payment_ref FROM orders WHERE id = $1 AND payment_ref IS NOT NULL`,
        [orderId],
      )
    ).rows;
    return rows.map((r) => r.provider_ref as string).sort();
  }

  /** The merchant captures a manual-capture order. */
  async capture(orderId: string): Promise<Json> {
    const o = await this.#order(orderId);
    if (!o.payment_ref) throw new HttpError(409, "no payment for this order yet");
    const ref = o.payment_ref;
    const now = await this.provider.retrievePayment(ref);
    if (now.ref !== ref)
      throw new ProviderError("unknown", undefined, "capture lookup returned another payment");
    await this.applyPayment(now);
    if (now.status === "succeeded") return { status: (await this.#order(orderId)).status };
    if (now.status !== "requires_capture")
      throw new HttpError(409, `payment is ${now.status}, nothing to capture`);
    try {
      const snap = await this.provider.capture(ref, {
        amount: o.total,
        currency: o.currency,
        idempotencyKey: `capture_${ref}`,
      });
      if (snap.ref !== ref) throw new ProviderError("unknown", undefined, "capture returned another payment");
      await this.applyPayment(snap);
      return { status: (await this.#order(orderId)).status };
    } catch (e) {
      if (!(e instanceof ProviderError)) throw e;
      // Never assume the outcome: reconcile from the provider object in the background.
      await enqueue(this.db, "reconcile_payment", { ref }, null);
      if (e.outcome === "rejected") throw new HttpError(409, `capture rejected: ${e.message}`);
      throw new HttpError(502, "capture outcome unknown; reconciling with the provider");
    }
  }

  // ------------------------------------------------------------------------------------------------ refunds
  /** Refund part of one order line. */
  async refundLine(orderId: string, body: Json): Promise<{ status: number; body: Json }> {
    const lineId = typeof body.line_id === "string" ? body.line_id : "";
    const amount = parseMinorUnits(body.amount);
    if (amount === undefined || amount <= 0n)
      throw new HttpError(400, "amount must be a positive integer in minor units");
    // 1. Reserve: under the order lock, check the line's headroom and record the request before calling the provider.
    const req = await tx(this.db, async (c) => {
      const o = (await c.query("SELECT * FROM orders WHERE id = $1 FOR UPDATE", [orderId])).rows[0] as
        | OrderRow
        | undefined;
      if (!o) throw new HttpError(404, "no such order");
      if (!["paid", "partially_refunded", "refunded"].includes(o.status))
        throw new HttpError(409, `order is ${o.status}`);
      const line = (
        await c.query("SELECT * FROM order_lines WHERE id = $1 AND order_id = $2", [lineId, orderId])
      ).rows[0];
      if (!line) throw new HttpError(404, "no such line on this order");
      const alloc = (await c.query("SELECT cause_ref FROM allocations WHERE line_id = $1", [lineId])).rows[0];
      if (!alloc) throw new HttpError(409, "this line has no captured money allocated to it");
      const refunds = (await c.query("SELECT amount, status FROM refunds WHERE line_id = $1", [lineId]))
        .rows as {
        amount: bigint;
        status: RefundStatus;
      }[];
      const reserved = (
        await c.query(
          "SELECT amount FROM refund_requests WHERE line_id = $1 AND state IN ('requested', 'unknown')",
          [lineId],
        )
      ).rows.map((r) => r.amount as bigint);
      const headroom = lineHeadroom(line.amount as bigint, refunds, reserved);
      if (amount > headroom)
        throw new HttpError(400, `amount exceeds what is refundable on this line (${headroom})`);
      // the whole payment's headroom too (refunds the shop did not initiate count against it)
      const paid = (
        await c.query(
          "SELECT coalesce(sum(amount_captured), 0)::bigint s FROM payments WHERE provider_ref = $1",
          [alloc.cause_ref],
        )
      ).rows[0]?.s as bigint;
      const held = (
        await c.query(
          "SELECT coalesce(sum(amount), 0)::bigint s FROM refunds WHERE payment_ref = $1 AND status IN ('pending', 'requires_action', 'succeeded')",
          [alloc.cause_ref],
        )
      ).rows[0]?.s as bigint;
      const pendingReq = (
        await c.query(
          "SELECT coalesce(sum(amount), 0)::bigint s FROM refund_requests WHERE order_id = $1 AND state IN ('requested', 'unknown')",
          [orderId],
        )
      ).rows[0]?.s as bigint;
      if (amount > paid - held - pendingReq)
        throw new HttpError(400, "amount exceeds what is refundable on this payment");
      const requestError = this.provider.refundRequestError?.(amount, o.currency);
      if (requestError) throw new HttpError(400, requestError);
      const id = newId("rr");
      await c.query(
        "INSERT INTO refund_requests (id, order_id, line_id, currency, amount, state) VALUES ($1, $2, $3, $4, $5, 'requested')",
        [id, orderId, lineId, o.currency, amount],
      );
      return { id, paymentRef: alloc.cause_ref as string };
    });
    // 2. Ask the provider, with the request id as idempotency key and in metadata (so a webhook can link it).
    const outcome = await this.#sendRefund(req.id, req.paymentRef, amount, orderId, lineId);
    if (outcome.kind === "rejected")
      return { status: 409, body: { error: `refund rejected: ${outcome.message}`, request_id: req.id } };
    if (outcome.kind === "unknown")
      return { status: 202, body: { request_id: req.id, status: "processing" } };
    return {
      status: 200,
      body: {
        request_id: req.id,
        refund_id: outcome.refund.id,
        provider_refund_id: outcome.refund.provider_ref,
        status: outcome.refund.status,
      },
    };
  }

  /** Send the first refund POST and record what came back. Unknown outcomes are not resent. */
  async #sendRefund(
    requestId: string,
    paymentRef: string,
    amount: bigint,
    orderId: string,
    lineId: string,
  ): Promise<
    { kind: "ok"; refund: RefundRow } | { kind: "rejected"; message: string } | { kind: "unknown" }
  > {
    let snap: RefundSnapshot;
    try {
      snap = await this.provider.createRefund(paymentRef, {
        amount,
        idempotencyKey: requestId,
        metadata: { order_id: orderId, line_id: lineId, refund_request_id: requestId },
      });
    } catch (e) {
      if (e instanceof ProviderError && e.outcome === "rejected") {
        const rejected = await this.db.query(
          "UPDATE refund_requests SET state = 'rejected', last_error = $2, updated_at = now() WHERE id = $1 AND state = 'requested' RETURNING id",
          [requestId, e.message.slice(0, 300)],
        );
        if (rejected.rowCount) return { kind: "rejected", message: e.message };
        // A later refusal does not establish that the earlier unknown attempt did not commit.
        await this.#markUnknown(requestId, e.message);
        return { kind: "unknown" };
      }
      await this.#markUnknown(requestId, String((e as Error)?.message ?? e));
      return { kind: "unknown" };
    }
    try {
      if (
        snap.paymentRef !== paymentRef ||
        snap.amount !== amount ||
        (snap.requestId !== undefined && snap.requestId !== requestId)
      )
        throw new ProviderError("unknown", undefined, "refund response does not match the issued request");
      // an idempotent replay returns the original response, which may be stale: it never overwrites a status
      return { kind: "ok", refund: await this.applyRefund(snap, { authoritative: false, requestId }) };
    } catch (e) {
      await this.#markUnknown(requestId, String((e as Error)?.message ?? e));
      throw e;
    }
  }

  async #markUnknown(requestId: string, message: string): Promise<void> {
    await tx(this.db, async (c) => {
      const r = await c.query(
        "UPDATE refund_requests SET state = 'unknown', last_error = $2, updated_at = now() WHERE id = $1 AND state IN ('requested', 'unknown') RETURNING id",
        [requestId, message.slice(0, 300)],
      );
      if (r.rowCount)
        await enqueue(c, "resolve_refund_request", { request_id: requestId }, `resolve_refund:${requestId}`);
    });
  }

  /** Await exact reconciliation; an unknown POST may commit after its idempotency key expires. */
  async resolveRefundRequest(requestId: string): Promise<void> {
    const r = (await this.db.query("SELECT state FROM refund_requests WHERE id = $1", [requestId])).rows[0];
    if (r?.state !== "unknown") return; // linked by a webhook meanwhile, or already settled
    // The provider port supplies no trustworthy retention window or proof of non-commit. Reposting
    // could issue a second financial effect. Exact refund-object recovery retires this resolver.
    throw new Error(`refund request ${requestId}: outcome still unknown; awaiting provider reconciliation`);
  }

  /** Startup recovery: requests a crashed process left in flight get resolved by the queue. */
  async recoverRefundRequests(): Promise<number> {
    const rows = (await this.db.query("SELECT id FROM refund_requests WHERE state = 'requested'")).rows;
    for (const r of rows)
      await this.#markUnknown(r.id as string, "process restarted while the request was in flight");
    return rows.length;
  }

  // ------------------------------------------------------------------------------------------------ reconciliation
  /** Fetch a payment from the provider and apply it. Returns the order id, or undefined if it is not ours. */
  async reconcilePayment(ref: string): Promise<string | undefined> {
    const snap = await this.provider.retrievePayment(ref);
    if (snap.ref !== ref)
      throw new ProviderError("unknown", undefined, "payment lookup returned another object");
    const orderId = await this.applyPayment(snap);
    if (!orderId) console.warn(`payment ${ref.slice(0, 60)} belongs to no known order; ignored`);
    return orderId;
  }

  async #orderForPayment(c: Tx, ref: string, hint: string | undefined): Promise<string | undefined> {
    const p = (await c.query("SELECT order_id FROM payments WHERE provider_ref = $1", [ref])).rows[0];
    if (p) return p.order_id as string;
    const o = (await c.query("SELECT id FROM orders WHERE payment_ref = $1", [ref])).rows[0];
    if (o) return o.id as string;
    if (hint) {
      const h = (await c.query("SELECT id FROM orders WHERE id = $1", [hint])).rows[0];
      if (h) return h.id as string;
    }
    return undefined;
  }

  /** Record a payment snapshot: move the stored status forward only, book the capture once, derive the order. */
  async applyPayment(snap: PaymentSnapshot): Promise<string | undefined> {
    return tx(this.db, async (c) => {
      const orderId = await this.#orderForPayment(c, snap.ref, snap.orderId);
      if (!orderId) return undefined;
      if (snap.orderId !== undefined && snap.orderId !== orderId)
        throw new ProviderError("unknown", undefined, "payment metadata changed order identity");
      const o = (await c.query("SELECT * FROM orders WHERE id = $1 FOR UPDATE", [orderId]))
        .rows[0] as OrderRow;
      const cur = (await c.query("SELECT * FROM payments WHERE provider_ref = $1 FOR UPDATE", [snap.ref]))
        .rows[0] as
        | { status: PaymentStatus; amount: bigint; amount_captured: bigint; currency: string }
        | undefined;
      if (
        snap.currency !== o.currency ||
        (cur && (cur.currency !== snap.currency || cur.amount !== snap.amount)) ||
        (cur?.status === "succeeded" && cur.amount_captured !== snap.amountCaptured)
      )
        throw new ProviderError("unknown", undefined, "payment snapshot changed immutable money or currency");
      let status: PaymentStatus = snap.status;
      let captured = snap.amountCaptured;
      if (!cur) {
        await c.query(
          "INSERT INTO payments (provider_ref, order_id, status, amount, amount_captured, currency) VALUES ($1, $2, $3, $4, $5, $6)",
          [snap.ref, orderId, snap.status, snap.amount, snap.amountCaptured, snap.currency || o.currency],
        );
      } else if (paymentMayMove(cur.status, snap.status)) {
        await c.query(
          "UPDATE payments SET status = $2, amount_captured = $3, updated_at = now() WHERE provider_ref = $1",
          [snap.ref, snap.status, snap.amountCaptured],
        );
      } else {
        status = cur.status; // stale or repeated snapshot: keep what we know
        captured = cur.amount_captured;
      }
      if (!o.payment_ref)
        await c.query("UPDATE orders SET payment_ref = $2 WHERE id = $1", [orderId, snap.ref]);
      if (status === "succeeded")
        await this.#bookCapture(c, o, snap.ref, captured, cur?.currency ?? (snap.currency || o.currency));
      await this.#refreshOrder(c, orderId);
      return orderId;
    });
  }

  /** Book a captured payment once: allocate it to the lines (sellers + commission), or to suspense if it does not match. */
  async #bookCapture(c: Tx, o: OrderRow, ref: string, captured: bigint, currency: string): Promise<void> {
    const done = await c.query(
      "SELECT 1 FROM ledger_entries WHERE cause_ref = $1 AND effect_ref = 'capture' AND account = 'provider:clearing'",
      [ref],
    );
    if (done.rowCount) return;
    if (captured <= 0n) return;
    const allocated = await c.query("SELECT 1 FROM allocations WHERE order_id = $1", [o.id]);
    const lines = (
      await c.query("SELECT id, seller_id, amount FROM order_lines WHERE order_id = $1 ORDER BY position", [
        o.id,
      ])
    ).rows.map((l) => ({ id: l.id as string, seller: l.seller_id as string, amount: l.amount as bigint }));
    const matches = !allocated.rowCount && captured === o.total && currency === o.currency;
    if (matches) {
      await this.#post(c, `sale:${ref}`, ref, currency, saleLegs(captured, lines));
      for (const l of lines) {
        const fee = commissionOf(l.amount);
        await c.query(
          `INSERT INTO allocations (id, cause_ref, order_id, line_id, currency, amount, seller_amount, commission_amount,
                                    rate_num, rate_den, rounding) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
          [
            `alloc:${ref}:${l.id}`,
            ref,
            o.id,
            l.id,
            currency,
            l.amount,
            l.amount - fee,
            fee,
            COMMISSION.num,
            COMMISSION.den,
            COMMISSION.rounding,
          ],
        );
      }
    } else {
      // Money arrived that the order does not explain (a second payment, or a different amount): keep it in suspense.
      console.warn(
        `payment ${ref} for order ${o.id}: captured ${captured} ${currency} does not match; booked to suspense`,
      );
      await this.#post(c, `sale:${ref}`, ref, currency, [
        { account: "provider:clearing", amount: captured, kind: "sale", effectRef: "capture" },
        {
          account: "platform:unallocated_receipts",
          amount: -captured,
          kind: "suspense",
          effectRef: "capture",
        },
      ]);
    }
  }

  async #post(c: Tx, txnId: string, cause: string, currency: string, legs: readonly Leg[]): Promise<void> {
    for (const l of legs)
      await c.query(
        "INSERT INTO ledger_entries (txn_id, account, currency, amount, cause_ref, kind, effect_ref) VALUES ($1, $2, $3, $4, $5, $6, $7)",
        [txnId, l.account, currency, l.amount, cause, l.kind, l.effectRef],
      );
  }

  async #refreshOrder(c: Tx, orderId: string): Promise<void> {
    const pays = (
      await c.query("SELECT status, amount_captured FROM payments WHERE order_id = $1", [orderId])
    ).rows as {
      status: PaymentStatus;
      amount_captured: bigint;
    }[];
    const captured = pays.filter((p) => p.status === "succeeded").reduce((s, p) => s + p.amount_captured, 0n);
    const refunded = (
      await c.query(
        "SELECT coalesce(sum(amount), 0)::bigint s FROM refunds WHERE order_id = $1 AND status IN ('pending', 'requires_action', 'succeeded')",
        [orderId],
      )
    ).rows[0]?.s as bigint;
    const status = deriveOrderStatus({ captured, refunded, payments: pays.map((p) => p.status) });
    await c.query(
      "UPDATE orders SET status = $2, updated_at = now() WHERE id = $1 AND status IS DISTINCT FROM $2",
      [orderId, status],
    );
  }

  /**
   * Record a refund snapshot. `authoritative`: the snapshot was fetched from the provider by the worker (the only
   * writer of refund status after creation, and it fetches in order). Otherwise (a create response, possibly an
   * idempotent replay) it only fills in a refund the shop did not know yet.
   */
  async applyRefund(
    snap: RefundSnapshot,
    opts: { authoritative: boolean; requestId?: string },
  ): Promise<RefundRow> {
    if (!isRefundStatus(snap.status)) throw new Error(`refund ${snap.ref}: bad status`);
    return tx(this.db, async (c) => {
      if (opts.requestId !== undefined && snap.requestId !== undefined && opts.requestId !== snap.requestId)
        throw new ProviderError("unknown", undefined, "refund response changed request identity");
      const reqId = opts.requestId ?? snap.requestId;
      const known = (await c.query("SELECT order_id FROM refunds WHERE provider_ref = $1", [snap.ref]))
        .rows[0];
      const reqRow = reqId
        ? (await c.query("SELECT order_id FROM refund_requests WHERE id = $1", [reqId])).rows[0]
        : undefined;
      const orderId = await this.#orderForPayment(c, snap.paymentRef, undefined);
      if (!orderId || (known && known.order_id !== orderId) || (reqRow && reqRow.order_id !== orderId))
        throw new ProviderError(
          "unknown",
          undefined,
          "refund payment does not match its known order/request",
        );
      await c.query("SELECT 1 FROM orders WHERE id = $1 FOR UPDATE", [orderId]);
      let row = (await c.query("SELECT * FROM refunds WHERE provider_ref = $1 FOR UPDATE", [snap.ref]))
        .rows[0] as RefundRow | undefined;
      const req = reqId
        ? ((
            await c.query("SELECT * FROM refund_requests WHERE id = $1 AND order_id = $2 FOR UPDATE", [
              reqId,
              orderId,
            ])
          ).rows[0] as Row | undefined)
        : undefined;
      if (row?.request_id && reqId !== undefined && row.request_id !== reqId)
        throw new ProviderError("unknown", undefined, "refund changed its linked request identity");
      if (req) {
        const allocation = (
          await c.query("SELECT cause_ref FROM allocations WHERE line_id = $1", [req.line_id])
        ).rows[0];
        if (allocation?.cause_ref !== snap.paymentRef)
          throw new ProviderError(
            "unknown",
            undefined,
            "refund does not match the request's allocated payment",
          );
      }
      const payment = (
        await c.query("SELECT currency FROM payments WHERE provider_ref = $1", [snap.paymentRef])
      ).rows[0];
      if (
        !payment ||
        payment.currency !== snap.currency ||
        (req && (req.currency !== snap.currency || req.amount !== snap.amount)) ||
        (row &&
          (row.payment_ref !== snap.paymentRef ||
            row.currency !== snap.currency ||
            row.amount !== snap.amount))
      )
        throw new ProviderError("unknown", undefined, "refund snapshot changed immutable money or currency");
      if (!row) {
        // link to the shop's request, unless that request already has its refund (then this is a second provider
        // refund for one request: still recorded against the same line, because that is where the money went)
        const free = req
          ? !(await c.query("SELECT 1 FROM refunds WHERE request_id = $1", [req.id])).rowCount
          : false;
        row = (
          await c.query(
            `INSERT INTO refunds (id, provider_ref, request_id, order_id, line_id, payment_ref, currency, amount, status, origin)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *`,
            [
              newId("rf"),
              snap.ref,
              free ? req?.id : null,
              orderId,
              (req?.line_id as string | undefined) ?? null,
              snap.paymentRef,
              snap.currency,
              snap.amount,
              snap.status,
              req ? "shop" : "provider",
            ],
          )
        ).rows[0] as RefundRow;
      } else if (opts.authoritative && row.status !== snap.status) {
        row = (
          await c.query(
            "UPDATE refunds SET status = $2, updated_at = now() WHERE provider_ref = $1 RETURNING *",
            [snap.ref, snap.status],
          )
        ).rows[0] as RefundRow;
      }
      if (req && row.request_id === req.id && req.state !== "sent")
        await c.query(
          "UPDATE refund_requests SET state = 'sent', provider_ref = $2, updated_at = now() WHERE id = $1",
          [req.id, snap.ref],
        );
      if (req && row.request_id === req.id)
        await c.query(
          "UPDATE jobs SET state = 'done', last_error = NULL, updated_at = now() WHERE type = 'resolve_refund_request' AND payload->>'request_id' = $1 AND state = 'failed'",
          [req.id],
        );
      await this.#syncRefundLedger(c, row);
      await this.#refreshOrder(c, orderId);
      return row;
    });
  }

  /** Recognise a refund while the provider holds it; reverse the recognition once if it fails or is canceled. */
  async #syncRefundLedger(c: Tx, r: RefundRow): Promise<void> {
    const rec = (
      await c.query(
        "SELECT account, amount FROM ledger_entries WHERE cause_ref = $1 AND effect_ref = 'recognition' ORDER BY id",
        [r.provider_ref],
      )
    ).rows as { account: string; amount: bigint }[];
    const reversed = (
      await c.query("SELECT 1 FROM ledger_entries WHERE cause_ref = $1 AND effect_ref = 'reversal'", [
        r.provider_ref,
      ])
    ).rowCount;
    if (refundHoldsMoney(r.status)) {
      if (reversed) {
        throw new ProviderError(
          "unknown",
          undefined,
          "refund holds money after its reversal; reconciliation requires review",
        );
      }
      if (rec.length) return;
      let counter = "platform:unallocated_refunds";
      if (r.line_id) {
        const line = (await c.query("SELECT seller_id FROM order_lines WHERE id = $1", [r.line_id])).rows[0];
        counter = `seller:${line?.seller_id as string}`;
      }
      await this.#post(c, `refund:${r.provider_ref}`, r.provider_ref, r.currency, [
        { account: counter, amount: r.amount, kind: "refund", effectRef: "recognition" },
        { account: "provider:clearing", amount: -r.amount, kind: "refund", effectRef: "recognition" },
      ]);
      return;
    }
    if (rec.length && !reversed)
      await this.#post(
        c,
        `refund_reversal:${r.provider_ref}`,
        r.provider_ref,
        r.currency,
        rec.map((l) => ({
          account: l.account,
          amount: -l.amount,
          kind: "refund_reversal",
          effectRef: "reversal",
        })),
      );
  }

  // ------------------------------------------------------------------------------------------------ job handlers
  /** Job: a provider payment changed. */
  async onPaymentJob(ref: string): Promise<void> {
    await this.reconcilePayment(ref);
  }

  /** Job: a provider refund changed. Reconcile its payment first, so the order is known and paid in any event order. */
  async onRefundJob(ref: string): Promise<void> {
    const snap = await this.provider.retrieveRefund(ref);
    if (snap.ref !== ref)
      throw new ProviderError("unknown", undefined, "refund lookup returned another object");
    const orderId = await this.reconcilePayment(snap.paymentRef);
    if (!orderId) return; // not one of our payments
    await this.applyRefund(snap, { authoritative: true });
  }
}
