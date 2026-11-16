// LeakyBazaar: a small multi-seller marketplace on Stripe or Razorpay + Postgres.
// Corrected control v2. Historical LeakyBazaar and its benchmark evidence remain unchanged.
// Deliberately boring production-style code: official SDK, plain SQL, a double-entry ledger.
import { randomUUID } from "node:crypto";
import http from "node:http";
import pg from "pg";
import { MAX_SDK_MINOR, MoneyInputError, parseMinor, refundHoldsMoney } from "./money.ts";
import { type Payment, providerFromEnv, type Refund, SignatureError, type WebhookEvent } from "./provider.ts";

pg.types.setTypeParser(20, (v: string) => BigInt(v)); // int8 → bigint (money stays exact)

const PORT = Number(process.env.PORT ?? 3000);
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 20 });
pool.on("error", (e: Error) => console.error("pg pool error", e.message));

// Payment provider (PAYMENT_PROVIDER=stripe|razorpay); adapters and the MoneyInvariant redirect live in provider.ts.
const provider = providerFromEnv();
const COMMISSION_BPS = 1000n; // 10% platform commission

export const SCHEMA = `
CREATE TABLE IF NOT EXISTS sellers (id text PRIMARY KEY, name text NOT NULL);
CREATE TABLE IF NOT EXISTS orders (
  id text PRIMARY KEY, buyer text NOT NULL, currency text NOT NULL, total bigint NOT NULL,
  capture_method text NOT NULL DEFAULT 'automatic', status text NOT NULL, payment_intent_id text UNIQUE,
  checkout_create_started boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS order_lines (
  id text PRIMARY KEY, order_id text NOT NULL REFERENCES orders(id), seller_id text NOT NULL REFERENCES sellers(id),
  currency text NOT NULL, amount bigint NOT NULL);
CREATE TABLE IF NOT EXISTS refunds (
  id text PRIMARY KEY, order_id text NOT NULL, line_id text, provider_ref text UNIQUE, currency text NOT NULL,
  amount bigint NOT NULL, status text NOT NULL, origin text NOT NULL, booked boolean NOT NULL DEFAULT false, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS refund_requests (
  id text PRIMARY KEY, order_id text NOT NULL REFERENCES orders(id), line_id text NOT NULL REFERENCES order_lines(id),
  payment_ref text NOT NULL, target_ref text, currency text NOT NULL, amount bigint NOT NULL,
  resolved boolean NOT NULL DEFAULT false, attempt_count integer NOT NULL DEFAULT 0,
  ambiguity_history boolean NOT NULL DEFAULT false, post_started boolean NOT NULL DEFAULT false,
  resolution text NOT NULL DEFAULT 'pending' CHECK (resolution IN ('pending','linked','rejected')),
  rejection_reason text,
  CHECK (resolved = (resolution <> 'pending')),
  CHECK ((resolution = 'rejected') = (rejection_reason IS NOT NULL)),
  next_attempt_at timestamptz NOT NULL DEFAULT (now() + interval '1 second'));
CREATE TABLE IF NOT EXISTS ledger_entries (
  id bigserial PRIMARY KEY, txn_id text NOT NULL, account text NOT NULL, currency text NOT NULL, amount bigint NOT NULL,
  cause_ref text NOT NULL, kind text NOT NULL, effect_ref text, created_at timestamptz NOT NULL DEFAULT now());
ALTER TABLE ledger_entries ADD COLUMN IF NOT EXISTS effect_ref text;
CREATE TABLE IF NOT EXISTS processed_events (event_id text PRIMARY KEY, object_id text NOT NULL, event_type text NOT NULL);
INSERT INTO sellers VALUES ('seller_a', 'Asha Crafts'), ('seller_b', 'Bharat Books') ON CONFLICT DO NOTHING;
`;

type Json = Record<string, unknown>;
class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}
class DefinitiveRefundRejection extends HttpError {
  constructor(reason: string) {
    super(409, `refund rejected by provider: ${reason}`);
  }
}

const commission = (amount: bigint): bigint => {
  // round half-even to minor units, integer-only
  const n = amount * COMMISSION_BPS;
  const q = n / 10000n;
  const r = n % 10000n;
  if (r * 2n > 10000n || (r * 2n === 10000n && q % 2n === 1n)) return q + 1n;
  return q;
};

async function tx<T>(fn: (c: pg.PoolClient) => Promise<T>, existing?: pg.PoolClient): Promise<T> {
  const c = existing ?? (await pool.connect());
  try {
    await c.query("BEGIN");
    const out = await fn(c);
    await c.query("COMMIT");
    return out;
  } catch (e) {
    await c.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    if (!existing) c.release();
  }
}

// ---------------------------------------------------------------------------------------------------------
// Orders and checkout
// ---------------------------------------------------------------------------------------------------------
async function createOrder(body: Json): Promise<Json> {
  const lines = (body.lines as { seller_id: string; amount: string | number }[] | undefined) ?? [];
  const currency = String(body.currency ?? "INR").toUpperCase();
  if (!Array.isArray(lines) || !lines.length) throw new HttpError(400, "order needs at least one line");
  if (!/^[A-Z]{3}$/.test(currency))
    throw new HttpError(400, "currency must be an explicit three-letter code");
  const parsed = lines.map((l) => ({ seller: String(l.seller_id), amount: parseMinor(l.amount) }));
  if (parsed.some((l) => l.amount <= 0n)) throw new HttpError(400, "line amounts must be positive");
  const total = parsed.reduce((s, l) => s + l.amount, 0n);
  if (total > MAX_SDK_MINOR) throw new HttpError(400, "order total exceeds exact SDK integer range");
  const id = `ord_${randomUUID().slice(0, 8)}`;
  const capture = body.capture === "manual" ? "manual" : "automatic";
  await tx(async (c) => {
    await c.query(
      "INSERT INTO orders (id, buyer, currency, total, capture_method, status) VALUES ($1,$2,$3,$4,$5,'pending_payment')",
      [id, String(body.buyer ?? "buyer"), currency, total, capture],
    );
    let i = 0;
    for (const l of parsed)
      await c.query(
        "INSERT INTO order_lines (id, order_id, seller_id, currency, amount) VALUES ($1,$2,$3,$4,$5)",
        [`${id}_l${++i}`, id, l.seller, currency, l.amount],
      );
  });
  return { id, total: total.toString(), currency, lines: parsed.map((_l, k) => `${id}_l${k + 1}`) };
}

async function checkout(orderId: string): Promise<Json> {
  const o = (await pool.query("SELECT * FROM orders WHERE id=$1", [orderId])).rows[0];
  if (!o) throw new HttpError(404, "no such order");
  if (o.status !== "pending_payment") throw new HttpError(409, `order is ${o.status}`);
  if (o.payment_intent_id) {
    const pi = await provider.retrievePayment(o.payment_intent_id);
    // Razorpay can have an order before its first payment; the adapter then has no payment amount/currency yet.
    if (
      pi.ref !== o.payment_intent_id ||
      (pi.amount !== 0n && pi.amount !== BigInt(o.total)) ||
      (pi.currency !== "" && pi.currency !== o.currency) ||
      (pi.orderId !== undefined && pi.orderId !== o.id)
    )
      throw new Error("retrieved payment identity or money differs from order");
    if (pi.status === "succeeded") await markPaid(orderId, pi);
    return { payment_intent_id: pi.ref, client_secret: pi.clientSecret };
  }
  if (o.checkout_create_started)
    throw new HttpError(502, "checkout create outcome unknown; awaiting provider payment observation");
  // Commit the marker before provider I/O. A crash, timeout or expired idempotency key must
  // never turn this order into a fresh create attempt with a second provider payment.
  const begun = await pool.query(
    "UPDATE orders SET checkout_create_started=true WHERE id=$1 AND status='pending_payment' AND payment_intent_id IS NULL AND NOT checkout_create_started RETURNING id",
    [orderId],
  );
  if (!begun.rowCount) throw new HttpError(502, "checkout create outcome unknown; retry observation");
  const pi = await provider.createPayment({
    orderId,
    amount: BigInt(o.total),
    currency: String(o.currency),
    capture: o.capture_method,
  });
  if (
    pi.amount !== BigInt(o.total) ||
    pi.currency !== o.currency ||
    (pi.orderId !== undefined && pi.orderId !== o.id)
  )
    throw new Error("created payment amount, currency or order identity differs from order");
  const recorded = await pool.query(
    "UPDATE orders SET payment_intent_id=$2 WHERE id=$1 AND payment_intent_id IS NULL AND checkout_create_started RETURNING payment_intent_id",
    [orderId, pi.ref],
  );
  if (!recorded.rowCount) {
    const after = (await pool.query("SELECT payment_intent_id FROM orders WHERE id=$1", [orderId])).rows[0];
    if (after?.payment_intent_id !== pi.ref)
      throw new Error("created payment identity conflicts with stored order reference");
  }
  return { payment_intent_id: pi.ref, client_secret: pi.clientSecret };
}

// Store semantic allocation identity at posting time: equal same-account rows cannot reconstruct it later.
// No identity uniqueness constraint is imposed here; the invariant checks realised postings.
/** Idempotent: record the sale once (ledger: provider clearing → sellers + platform commission). */
async function markPaid(orderId: string, pi: Payment): Promise<void> {
  await tx((c) => markPaidInTransaction(c, orderId, pi));
}

async function markPaidInTransaction(c: pg.PoolClient, orderId: string, pi: Payment): Promise<void> {
  const o = (await c.query("SELECT * FROM orders WHERE id=$1 FOR UPDATE", [orderId])).rows[0];
  if (!o) throw new HttpError(503, "order not recorded yet; retry webhook later");
  if (
    (pi.orderId !== undefined && pi.orderId !== o.id) ||
    pi.status !== "succeeded" ||
    pi.currency !== o.currency ||
    (o.payment_intent_id && o.payment_intent_id !== pi.ref)
  )
    throw new Error("payment identity, status or currency differs from order");
  if (pi.amount !== BigInt(o.total) || pi.amountReceived !== BigInt(o.total))
    throw new Error("captured amount differs from order total");
  if (!o.payment_intent_id && !o.checkout_create_started)
    throw new HttpError(503, "checkout create attempt not recorded; retry webhook later");
  if (o.status !== "pending_payment" && o.status !== "capture_pending") return; // already processed
  await c.query("UPDATE orders SET status='paid', payment_intent_id=$2 WHERE id=$1", [orderId, pi.ref]);
  const lines = (await c.query("SELECT * FROM order_lines WHERE order_id=$1 ORDER BY id", [orderId])).rows;
  const txn = `sale_${pi.ref}`;
  await c.query(
    "INSERT INTO ledger_entries (txn_id, account, currency, amount, cause_ref, kind, effect_ref) VALUES ($1,'provider:clearing',$2,$3,$4,'sale','capture')",
    [txn, o.currency, o.total, pi.ref],
  );
  for (const l of lines) {
    const fee = commission(l.amount);
    await c.query(
      "INSERT INTO ledger_entries (txn_id, account, currency, amount, cause_ref, kind, effect_ref) VALUES ($1,$2,$3,$4,$5,'sale',$6)",
      [txn, `seller:${l.seller_id}`, o.currency, -(l.amount - fee), pi.ref, `allocation:${l.id}`],
    );
    await c.query(
      "INSERT INTO ledger_entries (txn_id, account, currency, amount, cause_ref, kind, effect_ref) VALUES ($1,$2,$3,$4,$5,'commission',$6)",
      [txn, `platform:revenue:${l.id}`, o.currency, -fee, pi.ref, `allocation:${l.id}`],
    );
  }
}

/** A signed created/authorised observation may recover identity, never captured money. */
async function observePaymentInTransaction(c: pg.PoolClient, orderId: string, pi: Payment): Promise<void> {
  const o = (await c.query("SELECT * FROM orders WHERE id=$1 FOR UPDATE", [orderId])).rows[0];
  if (!o) throw new HttpError(503, "order not recorded yet; retry webhook later");
  if (
    pi.ref.length === 0 ||
    (pi.orderId !== undefined && pi.orderId !== o.id) ||
    (pi.status !== "pending" && pi.status !== "requires_capture") ||
    pi.currency !== o.currency ||
    pi.amount !== BigInt(o.total) ||
    pi.amountReceived !== 0n ||
    (o.payment_intent_id && o.payment_intent_id !== pi.ref)
  )
    throw new Error("observed payment identity, status or money differs from order");
  if (!o.payment_intent_id && !o.checkout_create_started)
    throw new HttpError(503, "checkout create attempt not recorded; retry webhook later");
  if (!o.payment_intent_id)
    await c.query("UPDATE orders SET payment_intent_id=$2 WHERE id=$1 AND payment_intent_id IS NULL", [
      orderId,
      pi.ref,
    ]);
}

/** The buyer returns from checkout: verify server-side. */
async function confirmReturn(orderId: string): Promise<Json> {
  const o = (await pool.query("SELECT * FROM orders WHERE id=$1", [orderId])).rows[0];
  if (!o?.payment_intent_id) throw new HttpError(404, "no payment for order");
  const pi = await provider.retrievePayment(o.payment_intent_id);
  if (pi.status === "succeeded") await markPaid(orderId, pi);
  const after = (await pool.query("SELECT status FROM orders WHERE id=$1", [orderId])).rows[0];
  return { status: after?.status };
}

/** Merchant accepts a manual-capture order. */
async function capture(orderId: string): Promise<Json> {
  const o = (await pool.query("SELECT * FROM orders WHERE id=$1", [orderId])).rows[0];
  if (!o?.payment_intent_id) throw new HttpError(404, "no payment for order");
  try {
    const pi = await provider.capture(o.payment_intent_id, {
      amount: BigInt(o.total),
      currency: String(o.currency),
      idempotencyKey: `capture_${orderId}`,
    });
    await markPaid(orderId, pi);
    return { status: "paid" };
  } catch (e) {
    // Outcome unknown (network) or rejected: never assume failure. Park and let the webhook / a re-check decide.
    await pool.query("UPDATE orders SET status='capture_pending' WHERE id=$1 AND status='pending_payment'", [
      orderId,
    ]);
    throw new HttpError(502, `capture outcome unknown: ${(e as Error).message}`);
  }
}

// ---------------------------------------------------------------------------------------------------------
// Refunds (per order line, marketplace semantics)
// ---------------------------------------------------------------------------------------------------------
async function refundLine(orderId: string, body: Json): Promise<Json> {
  const lineId = String(body.line_id ?? "");
  const amount = parseMinor(body.amount ?? "0");
  if (amount <= 0n) throw new HttpError(400, "amount must be positive");
  const refundId = `rf_${randomUUID().slice(0, 8)}`;
  // Commit the reservation before provider I/O. A pre-response webhook can correlate to it without
  // waiting for a transaction whose caller may itself be waiting for webhook delivery.
  await tx(async (c) => {
    const o = (await c.query("SELECT * FROM orders WHERE id=$1 FOR UPDATE", [orderId])).rows[0];
    if (!o || !["paid", "partially_refunded"].includes(o.status))
      throw new HttpError(409, "order not refundable");
    const requestError = provider.refundRequestError?.(amount, String(o.currency));
    if (requestError) throw new HttpError(400, requestError);
    const line = (await c.query("SELECT * FROM order_lines WHERE id=$1 AND order_id=$2", [lineId, orderId]))
      .rows[0];
    if (!line) throw new HttpError(404, "no such line");
    const done = (
      await c.query(
        "SELECT (coalesce((SELECT sum(amount) FROM refunds WHERE line_id=$1 AND status NOT IN ('failed','canceled')),0) + coalesce((SELECT sum(amount) FROM refund_requests WHERE line_id=$1 AND NOT resolved),0))::bigint s",
        [lineId],
      )
    ).rows[0].s as bigint;
    if (amount > line.amount - done) throw new HttpError(400, "amount exceeds refundable for this line");
    const orderReserved = (
      await c.query(
        "SELECT (coalesce((SELECT sum(amount) FROM refunds WHERE order_id=$1 AND status NOT IN ('failed','canceled')),0) + coalesce((SELECT sum(amount) FROM refund_requests WHERE order_id=$1 AND NOT resolved),0))::bigint s",
        [orderId],
      )
    ).rows[0].s as bigint;
    if (amount > o.total - orderReserved)
      throw new HttpError(400, "amount exceeds refundable for this order");
    await c.query(
      "INSERT INTO refund_requests (id, order_id, line_id, payment_ref, currency, amount) VALUES ($1,$2,$3,$4,$5,$6)",
      [refundId, orderId, lineId, o.payment_intent_id, o.currency, amount],
    );
  });
  try {
    const result = await recoverRefundRequest(refundId);
    if (result) return result;
    throw new Error("refund request already in progress");
  } catch (e) {
    if (e instanceof DefinitiveRefundRejection) throw e;
    // Keep capacity reserved after every ambiguous result; exact provider identity must reconcile it.
    throw new HttpError(502, `refund outcome unknown: ${(e as Error).message}`);
  }
}

/** A session lock excludes another worker without holding a financial transaction across provider I/O. */
async function recoverRefundRequest(refundId: string): Promise<Json | undefined> {
  const c = await pool.connect();
  let locked = false;
  try {
    locked =
      (await c.query("SELECT pg_try_advisory_lock(hashtext($1)) AS locked", [refundId])).rows[0]?.locked ===
      true;
    if (!locked) return undefined;
    const request = (await c.query("SELECT * FROM refund_requests WHERE id=$1 AND NOT resolved", [refundId]))
      .rows[0];
    if (!request) return undefined;
    // A possibly committed POST cannot be resent without a proven retention window. This also
    // covers a crash after the durable send marker but before recording the provider response.
    if (request.post_started || request.ambiguity_history)
      throw new Error("refund outcome still unknown; awaiting provider reconciliation");
    let targetRef: string = request.target_ref;
    if (!targetRef) {
      targetRef = await provider.refundTarget(String(request.payment_ref));
      // The selected URL target is durable before the first POST. A webhook may resolve during lookup.
      const stored = await c.query(
        "UPDATE refund_requests SET target_ref=$2 WHERE id=$1 AND NOT resolved AND target_ref IS NULL RETURNING id",
        [refundId, targetRef],
      );
      if (!stored.rowCount) return undefined;
    }
    // Mark the POST before sending it. A restart seeing this marker must treat the prior call as
    // potentially committed, even if no HTTP response was recorded. No financial transaction spans I/O.
    const begun = await c.query(
      "UPDATE refund_requests SET post_started=true WHERE id=$1 AND NOT resolved AND NOT post_started AND NOT ambiguity_history RETURNING id",
      [refundId],
    );
    if (!begun.rowCount) return undefined;
    let r: Refund;
    try {
      // Durable identity and parameters are the sole source for the first POST, including after restart.
      r = await provider.refund(String(request.payment_ref), {
        amount: BigInt(request.amount),
        idempotencyKey: refundId,
        metadata: { order_id: request.order_id, line_id: request.line_id, refund_id: refundId },
        targetRef,
      });
    } catch (e) {
      const reason = provider.definitiveRefundRejection(e);
      if (reason) {
        const rejected = await c.query(
          "UPDATE refund_requests SET resolved=true, resolution='rejected', rejection_reason=$2, post_started=false, attempt_count=attempt_count+1 WHERE id=$1 AND NOT resolved AND NOT ambiguity_history RETURNING id",
          [refundId, reason],
        );
        if (rejected.rowCount) throw new DefinitiveRefundRejection(reason);
      }
      throw e;
    }
    if (
      (r.paymentRef !== undefined && r.paymentRef !== request.payment_ref) ||
      (r.requestId !== undefined && r.requestId !== refundId)
    )
      throw new Error("refund response payment or request identity differs from request");
    // Missing echoed metadata may be filled from this exact API request; contradictory values never are.
    const status = await tx(
      (client) =>
        applyRefund(
          client,
          {
            ...r,
            paymentRef: r.paymentRef ?? request.payment_ref,
            requestId: r.requestId ?? refundId,
          },
          false,
        ),
      c,
    );
    return { refund_id: refundId, provider_refund_id: r.ref, status };
  } catch (e) {
    if (locked)
      await c.query(
        "UPDATE refund_requests SET ambiguity_history=ambiguity_history OR post_started, post_started=false, attempt_count=attempt_count+1, next_attempt_at=now() + make_interval(secs => LEAST(8, power(2, LEAST(attempt_count, 3))::integer)) WHERE id=$1 AND NOT resolved",
        [refundId],
      );
    throw e;
  } finally {
    try {
      if (locked) await c.query("SELECT pg_advisory_unlock(hashtext($1))", [refundId]);
    } finally {
      c.release();
    }
  }
}

/** Recover unsent durable requests; possibly committed calls await exact reconciliation with backoff. */
export async function recoverPendingRefunds(): Promise<void> {
  const rows = (
    await pool.query(
      "SELECT id FROM refund_requests WHERE NOT resolved AND next_attempt_at <= now() ORDER BY next_attempt_at,id LIMIT 8",
    )
  ).rows;
  await Promise.all(
    rows.map(async ({ id }: { id: string }) => {
      try {
        await recoverRefundRequest(id);
      } catch {
        console.error("refund recovery deferred; reservation retained");
      }
    }),
  );
}

/** Merge a provider observation while serialising all financial mutations for its order. */
async function applyRefund(c: pg.PoolClient, r: Refund, authoritative = true): Promise<Refund["status"]> {
  const o = (await c.query("SELECT * FROM orders WHERE payment_intent_id=$1 FOR UPDATE", [r.paymentRef]))
    .rows[0];
  if (!o || !["paid", "partially_refunded", "refunded"].includes(o.status))
    throw new HttpError(503, "payment not recorded yet; retry webhook later");
  if (r.currency !== o.currency || r.amount <= 0n || r.amount > MAX_SDK_MINOR)
    throw new Error("refund amount or currency differs from order domain");
  let known = (await c.query("SELECT * FROM refunds WHERE provider_ref=$1", [r.ref])).rows[0];
  if (!known && r.requestId) {
    const reserved = (
      await c.query("SELECT * FROM refund_requests WHERE id=$1 AND order_id=$2 AND NOT resolved", [
        r.requestId,
        o.id,
      ])
    ).rows[0];
    if (reserved && reserved.amount === r.amount) {
      known = (
        await c.query(
          "INSERT INTO refunds (id, order_id, line_id, provider_ref, currency, amount, status, origin) VALUES ($1,$2,$3,$4,$5,$6,$7,'api') RETURNING *",
          [reserved.id, o.id, reserved.line_id, r.ref, reserved.currency, reserved.amount, r.status],
        )
      ).rows[0];
      await c.query(
        "UPDATE refund_requests SET resolved=true, resolution='linked', post_started=false WHERE id=$1 AND NOT resolved",
        [reserved.id],
      );
    } else if (reserved) throw new Error("refund amount differs from reserved request");
  }
  if (known?.origin === "api" && r.requestId !== undefined && r.requestId !== known.id)
    throw new Error("refund request identity differs from stored refund");
  if (
    !known &&
    r.requestId &&
    (await c.query("SELECT 1 FROM refund_requests WHERE id=$1", [r.requestId])).rowCount
  )
    throw new Error("refund request identity or order differs from reservation");
  if (!known) {
    // An uncorrelated event with the same immutable amount could be an in-flight API refund.
    // Different amounts exclude that identity, so unrelated provider effects can be recorded
    // without waiting for the request's fate. This never links by amount or resolves uncertainty.
    const unresolved = (
      await c.query(
        "SELECT 1 FROM refund_requests WHERE order_id=$1 AND amount=$2 AND NOT resolved LIMIT 1",
        [o.id, r.amount],
      )
    ).rowCount;
    if (unresolved) throw new HttpError(503, "refund request not correlated yet; retry webhook later");
  }
  if (!known) {
    const inserted = await c.query(
      "INSERT INTO refunds (id, order_id, line_id, provider_ref, currency, amount, status, origin) VALUES ($1,$2,NULL,$3,$4,$5,$6,'provider') RETURNING *",
      [`rf_${randomUUID().slice(0, 8)}`, o.id, r.ref, o.currency, r.amount, r.status],
    );
    known = inserted.rows[0];
  }
  if (known.order_id !== o.id || known.amount !== r.amount)
    throw new Error("refund identity or amount differs from stored refund");
  const liveOthers = (
    await c.query(
      "SELECT coalesce(sum(amount),0)::bigint s FROM refunds WHERE order_id=$1 AND provider_ref<>$2 AND status NOT IN ('failed','canceled')",
      [o.id, r.ref],
    )
  ).rows[0].s as bigint;
  if (refundHoldsMoney(known.status) && refundHoldsMoney(r.status) && liveOthers + r.amount > o.total)
    throw new Error("provider refunds exceed captured order total");
  // pending → succeeded/failed; succeeded → failed. A stale pending/success cannot undo failure.
  const status =
    !authoritative ||
    known.status === "failed" ||
    known.status === "canceled" ||
    (known.status === "succeeded" && r.status === "pending")
      ? known.status
      : r.status;
  const forwardFailure = refundHoldsMoney(known.status) && !refundHoldsMoney(status);
  await c.query("UPDATE refunds SET status=$2 WHERE id=$1", [known.id, status]);
  if (!known.booked && refundHoldsMoney(status)) {
    const line = known.line_id
      ? (
          await c.query("SELECT seller_id FROM order_lines WHERE id=$1 AND order_id=$2", [
            known.line_id,
            o.id,
          ])
        ).rows[0]
      : undefined;
    if (known.line_id && !line) throw new Error("refund line no longer exists");
    const account = line ? `seller:${line.seller_id}` : "platform:unallocated_refunds";
    const txn = `refund_${r.ref}`;
    await c.query(
      "INSERT INTO ledger_entries (txn_id, account, currency, amount, cause_ref, kind, effect_ref) VALUES ($1,$2,$3,$4,$5,'refund','recognition')",
      [txn, account, known.currency, known.amount, r.ref],
    );
    await c.query(
      "INSERT INTO ledger_entries (txn_id, account, currency, amount, cause_ref, kind, effect_ref) VALUES ($1,'provider:clearing',$2,$3,$4,'refund','recognition')",
      [txn, known.currency, -known.amount, r.ref],
    );
    await c.query("UPDATE refunds SET booked=true WHERE id=$1", [known.id]);
  } else if (known.booked && forwardFailure) {
    await c.query(
      "INSERT INTO ledger_entries (txn_id, account, currency, amount, cause_ref, kind, effect_ref) SELECT 'refund_reversal_' || cause_ref, account, currency, -amount, cause_ref, 'refund_reversal', 'reversal:' || effect_ref FROM ledger_entries WHERE cause_ref=$1 AND kind='refund'",
      [r.ref],
    );
  }
  const liveRefunded = (
    await c.query(
      "SELECT coalesce(sum(amount),0)::bigint s FROM refunds WHERE order_id=$1 AND status NOT IN ('failed','canceled')",
      [o.id],
    )
  ).rows[0].s as bigint;
  await c.query("UPDATE orders SET status=$2 WHERE id=$1", [
    o.id,
    liveRefunded === 0n ? "paid" : liveRefunded >= o.total ? "refunded" : "partially_refunded",
  ]);
  return status;
}

// ---------------------------------------------------------------------------------------------------------
// Webhooks
// ---------------------------------------------------------------------------------------------------------
async function handleEvent(ev: WebhookEvent): Promise<number> {
  if (ev.kind !== "refund_changed") return applyEvent(ev);
  const c = await pool.connect();
  const key = `refund-observation:${provider.name}:${ev.refund.ref}`;
  let locked = false;
  try {
    // A waiter must not consume the pool while the holder needs to commit. Retry delivery instead.
    locked = (await c.query("SELECT pg_try_advisory_lock(hashtext($1)) locked", [key])).rows[0].locked;
    if (!locked) return 503;
    if (
      (await c.query("SELECT 1 FROM processed_events WHERE event_id=$1", [`${provider.name}:${ev.eventId}`]))
        .rowCount
    )
      return 200;
    // Signed callbacks are notifications, not an ordering proof for cyclic refund states.
    // Serialize current-object retrieval and commit on this same connection, without a transaction across I/O.
    const current = await provider.retrieveRefund(ev.refund.ref);
    if (
      current.ref !== ev.refund.ref ||
      current.paymentRef !== ev.refund.paymentRef ||
      current.amount !== ev.refund.amount ||
      current.currency !== ev.refund.currency ||
      (current.requestId !== undefined &&
        ev.refund.requestId !== undefined &&
        current.requestId !== ev.refund.requestId)
    )
      throw new Error("current refund identity or money differs from signed observation");
    return await applyEvent(
      { ...ev, refund: { ...current, requestId: current.requestId ?? ev.refund.requestId } },
      c,
    );
  } finally {
    try {
      if (locked) await c.query("SELECT pg_advisory_unlock(hashtext($1))", [key]);
    } finally {
      c.release();
    }
  }
}

async function applyEvent(ev: WebhookEvent, existing?: pg.PoolClient): Promise<number> {
  try {
    return await tx(async (c) => {
      // The marker and its effects commit together. A duplicate waits for this transaction and then
      // either sees its committed result, or retries its own work after rollback.
      const fresh = await c.query(
        "INSERT INTO processed_events (event_id, object_id, event_type) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING RETURNING 1",
        [`${provider.name}:${ev.eventId}`, ev.objectId, ev.type],
      );
      if (fresh.rowCount === 0) return 200;
      if (ev.kind === "payment_succeeded" || ev.kind === "payment_observed") {
        const orderId =
          ev.payment.orderId ??
          (await c.query("SELECT id FROM orders WHERE payment_intent_id=$1", [ev.payment.ref])).rows[0]?.id;
        if (!orderId) throw new HttpError(503, "payment order identity missing; retry webhook later");
        if (ev.kind === "payment_succeeded") await markPaidInTransaction(c, String(orderId), ev.payment);
        else await observePaymentInTransaction(c, String(orderId), ev.payment);
      }
      if (ev.kind === "refund_changed") await applyRefund(c, ev.refund);
      return 200;
    }, existing);
  } catch (e) {
    if (e instanceof HttpError && e.status === 503) return 503;
    throw e;
  }
}

// ---------------------------------------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------------------------------------
async function readBody(req: http.IncomingMessage): Promise<string> {
  let s = "";
  for await (const chunk of req) {
    s += chunk;
    if (s.length > 1_000_000) throw new HttpError(413, "body too large");
  }
  return s;
}
const send = (res: http.ServerResponse, status: number, body: Json) => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
};

export const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", "http://localhost");
    const raw = await readBody(req);
    if (req.method === "GET" && url.pathname === "/healthz") {
      await pool.query("SELECT 1"); // readiness: the database is reachable
      return send(res, 200, { ok: true });
    }
    if (req.method === "POST" && url.pathname === `/webhooks/${provider.name}`) {
      let ev: WebhookEvent;
      try {
        ev = await provider.parseWebhook(raw, req.headers);
      } catch (e) {
        if (e instanceof SignatureError) return send(res, 400, { error: "invalid signature" });
        throw e;
      }
      const status = await handleEvent(ev);
      return send(res, status, { received: status === 200 });
    }
    const body = raw ? (JSON.parse(raw) as Json) : {};
    if (req.method === "POST" && url.pathname === "/orders") return send(res, 201, await createOrder(body));
    const m = /^\/orders\/([\w-]+)\/(checkout|confirm|capture|refunds)$/.exec(url.pathname);
    if (req.method === "POST" && m) {
      const [, id, action] = m as unknown as [string, string, string];
      if (action === "checkout") return send(res, 200, await checkout(id));
      if (action === "confirm") return send(res, 200, await confirmReturn(id));
      if (action === "capture") return send(res, 200, await capture(id));
      if (action === "refunds") return send(res, 200, await refundLine(id, body));
    }
    send(res, 404, { error: "not found" });
  } catch (e) {
    if (e instanceof MoneyInputError) return send(res, 400, { error: e.message });
    if (e instanceof HttpError) return send(res, e.status, { error: e.message });
    if (provider.isProviderError(e)) return send(res, 502, { error: `provider: ${(e as Error).message}` });
    console.error(e);
    send(res, 500, { error: "internal" });
  }
});

export async function migrate(): Promise<void> {
  await pool.query(SCHEMA);
}

export async function stop(): Promise<void> {
  clearInterval(recoveryTimer);
  await new Promise<void>((r) => server.close(() => r()));
  await pool.end();
}

let recoveryTimer: ReturnType<typeof setInterval> | undefined;
server.on("listening", () => {
  recoveryTimer = setInterval(() => {
    void recoverPendingRefunds().catch((e: unknown) => console.error("refund recovery scan deferred", e));
  }, 500);
  recoveryTimer.unref();
});

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop() ?? "")) {
  await migrate();
  server.listen(PORT, "127.0.0.1", () => console.log(`leakybazaar listening on ${PORT}`));
}
