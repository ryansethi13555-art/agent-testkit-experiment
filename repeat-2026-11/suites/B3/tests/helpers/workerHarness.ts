// Glue for the worker-marketplace suites: a PaymentProvider over the shared World, a throwaway database,
// a queue drain, and the money-law checker against stored state and the world's true state.
import type { AddressInfo } from "node:net";
import pg from "pg";
import { expect } from "vitest";
import { createPool, type Db, migrate } from "../../worker-marketplace/src/db.ts";
import { type PaymentProvider, ProviderError, providerFromEnv } from "../../worker-marketplace/src/provider.ts";
import { createApp } from "../../worker-marketplace/src/server.ts";
import { ADMIN, createDb, dropDb } from "./inlineHarness.ts";
import { FakeError, holdsMoney, http, refCommission, signedEvent, World } from "./world.ts";

export const WHSEC = "whsec_b3_worker";
export const realWorker = providerFromEnv({ PAYMENT_PROVIDER: "stripe", STRIPE_SECRET_KEY: "sk_test_x", STRIPE_WEBHOOK_SECRET: WHSEC });
export const realRazorpay = providerFromEnv({ PAYMENT_PROVIDER: "razorpay", RAZORPAY_KEY_ID: "rzp_test_x", RAZORPAY_KEY_SECRET: "s", RAZORPAY_WEBHOOK_SECRET: "rzpsecret" });

export function workerProvider(world: World): PaymentProvider & { refundRequestError?: (a: bigint, c: string) => string | undefined } {
  const wrap = async <T>(fn: () => Promise<T>): Promise<T> => {
    try {
      return await fn();
    } catch (e) {
      if (e instanceof FakeError) throw new ProviderError(e.kind, e.status, e.message);
      throw e;
    }
  };
  const pay = (p: Awaited<ReturnType<World["retrievePayment"]>>) => ({
    ref: p.ref,
    status: p.status,
    amount: p.amount,
    amountCaptured: p.captured,
    currency: p.currency,
    orderId: p.orderId,
    clientSecret: `${p.ref}_secret`,
  });
  const ref = (r: Awaited<ReturnType<World["retrieveRefund"]>>) => ({
    ref: r.ref,
    paymentRef: r.paymentRef,
    amount: r.amount,
    currency: r.currency,
    status: r.status,
    requestId: r.metadata.refund_request_id,
  });
  return {
    name: "stripe",
    createPayment: (p) => wrap(async () => pay(await world.createPayment(p))),
    retrievePayment: (r) => wrap(async () => pay(await world.retrievePayment(r))),
    capture: (r, p) => wrap(async () => pay(await world.capture(r, p))),
    createRefund: (r, p) => wrap(async () => ref(await world.createRefund(r, p))),
    retrieveRefund: (r) => wrap(async () => ref(await world.retrieveRefund(r))),
    parseWebhook: (raw, headers) => realWorker.parseWebhook(raw, headers),
  };
}

export interface WCtx {
  db: Db;
  admin: string;
  world: World;
  app: ReturnType<typeof createApp>;
  base: string;
  provider: ReturnType<typeof workerProvider>;
}

export async function startWorker(name: string): Promise<WCtx> {
  const url = await createDb(name);
  const db = createPool(url);
  await migrate(db);
  const world = new World();
  const provider = workerProvider(world);
  const app = createApp(db, provider);
  await new Promise<void>((r) => app.server.listen(0, "127.0.0.1", () => r()));
  return { db, admin: url, world, app, base: `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`, provider };
}
export async function stopWorker(ctx: WCtx, name: string): Promise<void> {
  await ctx.app.stop().catch(() => {});
  await ctx.db.end();
  await dropDb(name);
}
export async function resetWorker(ctx: WCtx): Promise<void> {
  await ctx.app.stop().catch(() => {});
  await ctx.db.query("TRUNCATE jobs, ledger_entries, allocations, refunds, refund_requests, payments, order_lines, orders RESTART IDENTITY CASCADE");
  ctx.world = new World();
  ctx.provider = workerProvider(ctx.world);
  ctx.app = createApp(ctx.db, ctx.provider);
  await new Promise<void>((r) => ctx.app.server.listen(0, "127.0.0.1", () => r()));
  ctx.base = `http://127.0.0.1:${(ctx.app.server.address() as AddressInfo).port}`;
}

export const W = (c: WCtx) => ({
  post: (path: string, body: unknown = {}, headers: Record<string, string> = {}) => http(c.base, "POST", path, body, headers),
  get: (path: string) => http(c.base, "GET", path),
  order: async (lines: (number | string)[], opts: { currency?: string; capture?: string } = {}) => {
    const r = await http(c.base, "POST", "/orders", {
      buyer: "b",
      currency: opts.currency ?? "INR",
      capture: opts.capture ?? "automatic",
      lines: lines.map((a, i) => ({ seller_id: i % 2 === 0 ? "seller_a" : "seller_b", amount: a })),
    });
    expect(r.status).toBe(201);
    return { id: String(r.body.id), lines: r.body.lines as string[], total: BigInt(String(r.body.total)) };
  },
  checkout: (id: string) => http(c.base, "POST", `/orders/${id}/checkout`, {}),
  refund: (orderId: string, lineId: string, amount: unknown) => http(c.base, "POST", `/orders/${orderId}/refunds`, { line_id: lineId, amount }),
  hook: (e: ReturnType<typeof signedEvent>) => http(c.base, "POST", "/webhooks/stripe", e.payload, e.headers),
});
export const wev = {
  pi: (c: WCtx, type: string, ref: string, id?: string) => signedEvent(WHSEC, type, { id: ref, object: "payment_intent", ...(c.world.payments.has(ref) ? { status: c.world.get(ref).status } : {}) }, id),
  refund: (c: WCtx, type: string, ref: string, id?: string) => {
    const r = c.world.getRefund(ref);
    return signedEvent(WHSEC, type, { id: ref, object: "refund", payment_intent: r.paymentRef }, id);
  },
};

/** Run the queue until quiet; failing jobs are made due again so retries and dead-lettering are exercised. */
export async function drain(c: WCtx, rounds = 10): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    await c.db.query("UPDATE jobs SET run_after = now() WHERE state = 'queued'");
    let any = false;
    while (await c.app.worker.runOnce()) any = true;
    const left = (await c.db.query("SELECT count(*)::int n FROM jobs WHERE state='queued'")).rows[0].n as number;
    if (!any && left === 0) return;
  }
}

export const bigv = (v: unknown) => BigInt(String(v));

/** Money laws against stored state and the world's true state. Call when settled (events delivered, queue drained). */
export async function assertWorkerBooks(c: WCtx, opts: { reservedOk?: boolean } = {}): Promise<void> {
  const q = async (sql: string, p: unknown[] = []) => (await c.db.query(sql, p)).rows;
  const { world } = c;
  expect(await q("SELECT txn_id, currency FROM ledger_entries GROUP BY 1,2 HAVING sum(amount)<>0")).toEqual([]);
  expect(await q("SELECT cause_ref, effect_ref, account FROM ledger_entries GROUP BY 1,2,3 HAVING count(*)>1")).toEqual([]);
  let expectedClearing = 0n;
  const orders = await q("SELECT * FROM orders");
  for (const o of orders) {
    const total = bigv(o.total);
    const worldPays = [...world.payments.values()].filter((p) => p.orderId === o.id);
    const known = await q("SELECT * FROM payments WHERE order_id=$1", [o.id]);
    // recon: stored payment state agrees with the provider's
    for (const wp of worldPays) {
      const mine = known.find((k) => k.provider_ref === wp.ref);
      if (!mine) {
        expect(wp.captured).toBe(0n); // unknown to the app is only acceptable while nothing was captured
        continue;
      }
      expect(mine.status).toBe(wp.status);
      expect(bigv(mine.amount_captured)).toBe(wp.captured);
    }
    const captured = worldPays.reduce((s, p) => s + p.captured, 0n);
    const paidish = ["paid", "partially_refunded", "refunded"];
    if (captured > 0n) expect(paidish).toContain(o.status);
    else expect(paidish).not.toContain(o.status);
    // sales: booked once per captured payment, to suspense when it does not match the order
    const allocs = await q("SELECT * FROM allocations WHERE order_id=$1", [o.id]);
    expect(allocs.length === 0 || allocs.length === (await q("SELECT 1 FROM order_lines WHERE order_id=$1", [o.id])).length).toBe(true);
    const allocCauses = new Set(allocs.map((a) => a.cause_ref));
    expect(allocCauses.size <= 1).toBe(true);
    for (const a of allocs) {
      expect(bigv(a.seller_amount) + bigv(a.commission_amount)).toBe(bigv(a.amount));
      expect(bigv(a.commission_amount)).toBe(refCommission(bigv(a.amount)));
      const line = (await q("SELECT * FROM order_lines WHERE id=$1", [a.line_id]))[0];
      expect(bigv(line.amount)).toBe(bigv(a.amount));
      const seller = await q("SELECT sum(amount)::text s FROM ledger_entries WHERE cause_ref=$1 AND effect_ref=$2 AND account=$3", [a.cause_ref, `allocation:${a.line_id}`, `seller:${line.seller_id}`]);
      expect(bigv(seller[0].s ?? 0)).toBe(-bigv(a.seller_amount));
    }
    for (const wp of worldPays) {
      const sale = await q("SELECT sum(amount)::text s FROM ledger_entries WHERE cause_ref=$1 AND account='provider:clearing' AND effect_ref='capture'", [wp.ref]);
      expect(bigv(sale[0].s ?? 0)).toBe(wp.captured);
      expectedClearing += wp.captured;
      if (wp.captured > 0n && !allocCauses.has(wp.ref)) {
        // unexplained money lives in suspense, never on a seller or on commission
        const susp = await q("SELECT sum(amount)::text s FROM ledger_entries WHERE cause_ref=$1 AND account='platform:unallocated_receipts'", [wp.ref]);
        expect(bigv(susp[0].s)).toBe(-wp.captured);
        const sellers = await q("SELECT 1 FROM ledger_entries WHERE cause_ref=$1 AND account LIKE 'seller:%'", [wp.ref]);
        expect(sellers).toEqual([]);
      }
    }
    // refunds: recon with the world, line and payment bounds, ledger recognition
    const myRefunds = await q("SELECT * FROM refunds WHERE order_id=$1", [o.id]);
    for (const wp of worldPays)
      for (const wr of [...world.refunds.values()].filter((r) => r.paymentRef === wp.ref)) {
        const mine = myRefunds.filter((r) => r.provider_ref === wr.ref);
        expect(mine.length, `refund ${wr.ref} recorded`).toBe(1);
        expect(bigv(mine[0].amount)).toBe(wr.amount);
        expect(mine[0].status).toBe(wr.status);
        if (mine[0].line_id) {
          const ln = (await q("SELECT seller_id FROM order_lines WHERE id=$1", [mine[0].line_id]))[0];
          const accts = (await q("SELECT DISTINCT account FROM ledger_entries WHERE cause_ref=$1 AND account<>'provider:clearing'", [wr.ref])).map((r) => r.account);
          expect(accts.every((x) => x === `seller:${ln.seller_id}`)).toBe(true);
        }
        const clr = await q("SELECT sum(amount)::text s FROM ledger_entries WHERE cause_ref=$1 AND account='provider:clearing' AND kind IN ('refund','refund_reversal')", [wr.ref]);
        expect(bigv(clr[0].s ?? 0)).toBe(holdsMoney(wr.status) ? -wr.amount : 0n);
        if (holdsMoney(wr.status)) expectedClearing -= wr.amount;
      }
    for (const mr of myRefunds) expect(world.refunds.has(mr.provider_ref)).toBe(true);
    const lines = await q("SELECT * FROM order_lines WHERE order_id=$1", [o.id]);
    for (const l of lines) {
      const held = myRefunds.filter((r) => r.line_id === l.id && holdsMoney(r.status)).reduce((s, r) => s + bigv(r.amount), 0n);
      const reserved = (await q("SELECT coalesce(sum(amount),0)::text s FROM refund_requests WHERE line_id=$1 AND state IN ('requested','unknown')", [l.id]))[0].s;
      expect(held + bigv(reserved) <= bigv(l.amount)).toBe(true);
    }
    const heldAll = myRefunds.filter((r) => holdsMoney(r.status)).reduce((s, r) => s + bigv(r.amount), 0n);
    expect(heldAll <= captured).toBe(true);
    // order status follows money facts
    const status = captured === 0n ? undefined : heldAll >= captured ? "refunded" : heldAll > 0n ? "partially_refunded" : "paid";
    if (status) expect(o.status).toBe(status);
    expect(total > 0n).toBe(true);
  }
  // refund requests: at most one provider refund per request; none left in flight
  for (const req of await q("SELECT * FROM refund_requests")) {
    expect([...world.refunds.values()].filter((r) => r.metadata.refund_request_id === req.id).length <= 1).toBe(true);
    if (!opts.reservedOk) expect(req.state).not.toBe("requested");
    expect(await q("SELECT 1 FROM refunds WHERE request_id=$1", [req.id])).toHaveLength(req.state === "sent" ? 1 : req.state === "unknown" ? 0 : 0);
  }
  const clearing = bigv((await q("SELECT coalesce(sum(amount),0)::text s FROM ledger_entries WHERE account='provider:clearing'"))[0].s);
  expect(clearing).toBe(expectedClearing);
}
