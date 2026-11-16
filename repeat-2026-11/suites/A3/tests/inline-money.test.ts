// Money-correctness tests for the inline marketplace (HTTP app, Postgres, inline payment/refund recovery).
// The provider is an in-memory fake with lost responses, idempotency replay, pending/failed refunds, partial capture.
import type { AddressInfo } from "node:net";
import fc from "fast-check";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createDb, expectedFee, sleep } from "./helpers/db.ts";
import { fake } from "./helpers/inline-fake.ts";

vi.mock("../inline-marketplace/src/provider.ts", async () => {
  const h = await import("./helpers/inline-fake.ts");
  return { providerFromEnv: () => h.fake, SignatureError: h.TestSignatureError };
});

let testDb: Awaited<ReturnType<typeof createDb>>;
let app: typeof import("../inline-marketplace/src/server.ts");
let db: pg.Client;
let base = "";

beforeAll(async () => {
  testDb = await createDb("inl");
  process.env.DATABASE_URL = testDb.url;
  app = await import("../inline-marketplace/src/server.ts");
  await app.migrate();
  await new Promise<void>((r) => app.server.listen(0, "127.0.0.1", () => r()));
  base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  db = new pg.Client({ connectionString: testDb.url });
  await db.connect();
});
afterAll(async () => {
  await db?.end();
  await app?.stop();
  await testDb?.drop();
});
beforeEach(async () => {
  fake.reset();
  await db.query("TRUNCATE orders, order_lines, refunds, refund_requests, ledger_entries, processed_events CASCADE");
});

async function post(path: string, body: unknown = {}, headers: Record<string, string> = {}) {
  const r = await fetch(base + path, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
  return { status: r.status, body: (await r.json()) as Record<string, any> };
}
const deliver = async (ev: { eventId: string }) => {
  fake.events.set(ev.eventId, ev as never);
  return (await post("/webhooks/stripe", JSON.stringify({ key: ev.eventId }), { "x-sig": "ok" })).status;
};
let evn = 0;
const eid = () => `evt_${++evn}`;
const rows = async (sql: string, params: unknown[] = []) => (await db.query(sql, params)).rows as any[];
const big = async (sql: string, params: unknown[] = []) => BigInt((await rows(sql, params))[0].v);

async function mkOrder(lines: [string, number | string][], extra: Record<string, unknown> = {}) {
  const r = await post("/orders", {
    buyer: "b1",
    currency: "INR",
    lines: lines.map(([s, a]) => ({ seller_id: s, amount: a })),
    ...extra,
  });
  expect(r.status).toBe(201);
  return { id: r.body.id as string, lines: r.body.lines as string[], total: BigInt(r.body.total) };
}
async function checkoutRef(orderId: string) {
  const c = await post(`/orders/${orderId}/checkout`, {});
  expect(c.status).toBe(200);
  return String(c.body.payment_intent_id);
}
async function paidOrder(lines: [string, number | string][] = [["seller_a", 600], ["seller_b", 400]], extra = {}) {
  const o = await mkOrder(lines, extra);
  const ref = await checkoutRef(o.id);
  fake.pay(ref);
  expect(await deliver(fake.payEvent(eid(), ref))).toBe(200);
  return { ...o, ref };
}

/** Ledger and order invariants that must hold after any sequence of events. */
async function assertSound() {
  expect(await rows("SELECT txn_id, currency FROM ledger_entries GROUP BY 1,2 HAVING sum(amount) <> 0")).toEqual([]);
  expect(await rows("SELECT currency FROM ledger_entries GROUP BY 1 HAVING sum(amount) <> 0")).toEqual([]);
  const live = "('pending','requires_action','succeeded')";
  // clearing = money captured for recorded sales minus refunds the provider holds (and the ledger has recognised)
  const sold = await big(
    "SELECT coalesce(sum(total),0)::text v FROM orders WHERE status IN ('paid','partially_refunded','refunded')",
  );
  const refunded = await big(`SELECT coalesce(sum(amount),0)::text v FROM refunds WHERE booked AND status IN ${live}`);
  expect(await big("SELECT coalesce(sum(amount),0)::text v FROM ledger_entries WHERE account='provider:clearing'")).toBe(
    sold - refunded,
  );
  // never more refunded than captured, per order
  expect(
    await rows(
      `SELECT r.order_id FROM refunds r JOIN orders o ON o.id=r.order_id WHERE r.status IN ${live}
       GROUP BY r.order_id, o.total HAVING sum(r.amount) > o.total`,
    ),
  ).toEqual([]);
  // every live API refund fits within its line
  expect(
    await rows(
      `SELECT r.line_id FROM refunds r JOIN order_lines l ON l.id=r.line_id WHERE r.status IN ${live}
       GROUP BY r.line_id, l.amount HAVING sum(r.amount) > l.amount`,
    ),
  ).toEqual([]);
  // each seller's account = -(their net sales) + refunds recognised against their lines
  const lines = await rows(
    "SELECT l.id, l.seller_id, l.amount::text a FROM order_lines l JOIN orders o ON o.id=l.order_id WHERE o.status IN ('paid','partially_refunded','refunded')",
  );
  for (const seller of ["seller_a", "seller_b"]) {
    const net = lines
      .filter((l) => l.seller_id === seller)
      .reduce((s, l) => s + BigInt(l.a) - expectedFee(BigInt(l.a)), 0n);
    const refs = await big(
      `SELECT coalesce(sum(r.amount),0)::text v FROM refunds r JOIN order_lines l ON l.id=r.line_id
       WHERE r.booked AND r.status IN ${live} AND l.seller_id=$1`,
      [seller],
    );
    expect(await big("SELECT coalesce(sum(amount),0)::text v FROM ledger_entries WHERE account=$1", [`seller:${seller}`])).toBe(
      -net + refs,
    );
  }
}
const saleCount = async () => Number((await rows("SELECT count(*)::int c FROM ledger_entries WHERE kind='sale'"))[0].c);

describe("orders and input validation", () => {
  it("rejects malformed money and currency without creating an order", async () => {
    const bad: unknown[] = [-5, 10.5, "1e3", "12.5", "-1", "", "abc", 0, "0", Number.MAX_SAFE_INTEGER + 1, "9007199254740993", null, {}];
    for (const amount of bad) {
      const r = await post("/orders", { lines: [{ seller_id: "seller_a", amount }] });
      expect(r.status, `amount ${JSON.stringify(amount)}`).toBeGreaterThanOrEqual(400);
    }
    expect((await post("/orders", { currency: "RUPEE", lines: [{ seller_id: "seller_a", amount: 100 }] })).status).toBe(400);
    expect((await post("/orders", { currency: "", lines: [{ seller_id: "seller_a", amount: 100 }] })).status).toBe(400);
    expect((await post("/orders", { lines: [] })).status).toBe(400);
    expect(
      (await post("/orders", { lines: [{ seller_id: "seller_a", amount: 9007199254740991 }, { seller_id: "seller_b", amount: 5 }] })).status,
    ).toBe(400); // total beyond exact range
    expect(Number((await rows("SELECT count(*)::int c FROM orders"))[0].c)).toBe(0);
  });

  it("stores amounts exactly as integer minor units, with the currency", async () => {
    const o = await mkOrder([["seller_a", "123456789012"], ["seller_b", 1]], { currency: "usd" });
    expect(o.total).toBe(123456789013n);
    const row = (await rows("SELECT currency, total::text t FROM orders WHERE id=$1", [o.id]))[0];
    expect(row).toEqual({ currency: "USD", t: "123456789013" });
  });

  it("an order is not refundable before it is paid, and a missing order is 404", async () => {
    const o = await mkOrder([["seller_a", 1000]]);
    expect((await post(`/orders/${o.id}/refunds`, { line_id: o.lines[0], amount: 100 })).status).toBe(409);
    expect((await post(`/orders/ord_nope/checkout`, {})).status).toBe(404);
  });
});

describe("sale booking, commission and ledger", () => {
  it("books a balanced sale: clearing debit, seller net and commission credits per line", async () => {
    const o = await paidOrder();
    const entries = await rows("SELECT account, amount::text a, effect_ref FROM ledger_entries WHERE kind IN ('sale','commission') ORDER BY id");
    expect(entries.find((e) => e.account === "provider:clearing")?.a).toBe("1000");
    expect(entries.find((e) => e.account === "seller:seller_a")?.a).toBe("-540");
    expect(entries.find((e) => e.account === "seller:seller_b")?.a).toBe("-360");
    expect(entries.find((e) => e.account === `platform:revenue:${o.lines[0]}`)?.a).toBe("-60");
    expect(entries.find((e) => e.account === `platform:revenue:${o.lines[1]}`)?.a).toBe("-40");
    await assertSound();
  });

  it("rounds commission half to even per line and never loses or creates a minor unit", async () => {
    const amounts = [5, 15, 25, 35, 1, 9, 10, 11, 999_999_995];
    const o = await mkOrder(amounts.map((a) => ["seller_a", a] as [string, number]));
    const ref = await checkoutRef(o.id);
    fake.pay(ref);
    expect(await deliver(fake.payEvent(eid(), ref))).toBe(200);
    for (const [i, a] of amounts.entries()) {
      const fee = expectedFee(BigInt(a));
      const lid = o.lines[i];
      expect(await big("SELECT coalesce(sum(-amount),0)::text v FROM ledger_entries WHERE account=$1", [`platform:revenue:${lid}`])).toBe(fee);
      expect(await big("SELECT coalesce(sum(-amount),0)::text v FROM ledger_entries WHERE account='seller:seller_a' AND effect_ref=$1", [`allocation:${lid}`])).toBe(BigInt(a) - fee);
    }
    expect([0n, 2n, 2n, 4n].map(String)).toEqual([expectedFee(5n), expectedFee(15n), expectedFee(25n), expectedFee(35n)].map(String));
    await assertSound();
  });

  it("property: any set of lines books exactly the order total", async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(fc.integer({ min: 1, max: 100_000 }), { minLength: 1, maxLength: 6 }), async (amounts) => {
        fake.reset();
        await db.query("TRUNCATE orders, order_lines, refunds, refund_requests, ledger_entries, processed_events CASCADE");
        const o = await mkOrder(amounts.map((a, i) => [i % 2 ? "seller_b" : "seller_a", a] as [string, number]));
        const ref = await checkoutRef(o.id);
        fake.pay(ref);
        expect(await deliver(fake.payEvent(eid(), ref))).toBe(200);
        const total = amounts.reduce((s, a) => s + a, 0);
        expect(await big("SELECT coalesce(sum(amount),0)::text v FROM ledger_entries WHERE account='provider:clearing'")).toBe(BigInt(total));
        await assertSound();
      }),
      { numRuns: 20 },
    );
  });

  it("books each ledger transaction in a single currency and keeps the order currency (USD)", async () => {
    const o = await paidOrder([["seller_a", 5000]], { currency: "USD" });
    expect(await rows("SELECT DISTINCT currency FROM ledger_entries")).toEqual([{ currency: "USD" }]);
    const r = await post(`/orders/${o.id}/refunds`, { line_id: o.lines[0], amount: 1000 });
    expect(r.status).toBe(200);
    expect(await rows("SELECT DISTINCT currency FROM ledger_entries")).toEqual([{ currency: "USD" }]);
    await assertSound();
  });
});

describe("checkout", () => {
  it("is idempotent: repeated and concurrent checkouts create exactly one provider payment", async () => {
    const o = await mkOrder([["seller_a", 1000]]);
    const results = await Promise.all(Array.from({ length: 10 }, () => post(`/orders/${o.id}/checkout`, {})));
    expect(fake.calls.createPayment).toBe(1);
    const refs = new Set(results.filter((r) => r.status === 200).map((r) => r.body.payment_intent_id));
    expect(refs.size).toBe(1);
    expect(fake.payments.size).toBe(1);
    const again = await post(`/orders/${o.id}/checkout`, {});
    expect(again.body.payment_intent_id).toBe([...refs][0]);
    expect(fake.calls.createPayment).toBe(1);
  });

  it("a lost create response never causes a second provider payment; the observed payment id is adopted", async () => {
    const o = await mkOrder([["seller_a", 1000]]);
    fake.faults.createPayment = "lose";
    expect((await post(`/orders/${o.id}/checkout`, {})).status).toBeGreaterThanOrEqual(500);
    for (let i = 0; i < 3; i++) expect((await post(`/orders/${o.id}/checkout`, {})).status).toBe(502);
    expect(fake.calls.createPayment).toBe(1);
    const ref = [...fake.payments.keys()][0] as string;
    expect(await deliver(fake.payEvent(eid(), ref, "payment_observed"))).toBe(200);
    const c = await post(`/orders/${o.id}/checkout`, {});
    expect(c.status).toBe(200);
    expect(c.body.payment_intent_id).toBe(ref);
    fake.pay(ref);
    expect(await deliver(fake.payEvent(eid(), ref))).toBe(200);
    expect(fake.calls.createPayment).toBe(1);
    await assertSound();
  });

  it("a failure before the provider applied the create also never leads to a second create", async () => {
    const o = await mkOrder([["seller_a", 1000]]);
    fake.faults.createPayment = "fail";
    await post(`/orders/${o.id}/checkout`, {});
    const r = await post(`/orders/${o.id}/checkout`, {});
    expect(r.status).toBe(502);
    expect(fake.calls.createPayment).toBe(1);
  });

  it("a paid order cannot be checked out again", async () => {
    const o = await paidOrder();
    expect((await post(`/orders/${o.id}/checkout`, {})).status).toBe(409);
    expect(fake.calls.createPayment).toBe(1);
  });
});

describe("payment webhooks: duplicates, ordering, tampering", () => {
  it("rejects an invalid signature with 400 and no effect", async () => {
    const o = await mkOrder([["seller_a", 1000]]);
    const ref = await checkoutRef(o.id);
    fake.pay(ref);
    const ev = fake.payEvent(eid(), ref);
    fake.events.set(ev.eventId, ev);
    const r = await post("/webhooks/stripe", JSON.stringify({ key: ev.eventId }), { "x-sig": "bad" });
    expect(r.status).toBe(400);
    expect(await saleCount()).toBe(0);
    expect((await rows("SELECT status FROM orders WHERE id=$1", [o.id]))[0].status).toBe("pending_payment");
  });

  it("the same event delivered many times, concurrently, books the sale once", async () => {
    const o = await mkOrder([["seller_a", 600], ["seller_b", 400]]);
    const ref = await checkoutRef(o.id);
    fake.pay(ref);
    const ev = fake.payEvent(eid(), ref);
    const statuses = await Promise.all(Array.from({ length: 12 }, () => deliver(ev)));
    expect(statuses.every((s) => s === 200)).toBe(true);
    expect(await saleCount()).toBe(3); // 1 clearing debit + 2 seller credits
    expect(Number((await rows("SELECT count(*)::int c FROM ledger_entries WHERE kind='commission'"))[0].c)).toBe(2);
    await assertSound();
  });

  it("different event ids, confirm-return and capture for one payment still book the sale once", async () => {
    const o = await mkOrder([["seller_a", 600], ["seller_b", 400]]);
    const ref = await checkoutRef(o.id);
    fake.pay(ref);
    await Promise.all([
      deliver(fake.payEvent(eid(), ref)),
      deliver(fake.payEvent(eid(), ref)),
      post(`/orders/${o.id}/confirm`, {}),
      post(`/orders/${o.id}/confirm`, {}),
      post(`/orders/${o.id}/checkout`, {}),
    ]);
    expect(Number((await rows("SELECT count(*)::int c FROM ledger_entries WHERE kind='sale' AND account='provider:clearing'"))[0].c)).toBe(1);
    await assertSound();
  });

  it("a succeeded event for an unknown order is retried later (5xx) and leaves no processed marker", async () => {
    const ref = "pi_ghost";
    fake.payments.set(ref, { status: "succeeded", amount: 500n, received: 500n, currency: "INR", orderId: "ord_ghost", capture: "automatic" });
    const ev = fake.payEvent("evt_ghost", ref);
    expect(await deliver(ev)).toBe(503);
    expect(Number((await rows("SELECT count(*)::int c FROM processed_events"))[0].c)).toBe(0);
    expect(await saleCount()).toBe(0);
  });

  it("does not book a payment whose captured amount differs from the order total", async () => {
    const o = await mkOrder([["seller_a", 1000]]);
    const ref = await checkoutRef(o.id);
    const p = fake.payments.get(ref)!;
    Object.assign(p, { status: "succeeded", received: 900n });
    const status = await deliver(fake.payEvent(eid(), ref));
    expect(status).not.toBe(200);
    expect(await saleCount()).toBe(0);
    expect(Number((await rows("SELECT count(*)::int c FROM processed_events"))[0].c)).toBe(0);
    expect((await rows("SELECT status FROM orders WHERE id=$1", [o.id]))[0].status).not.toBe("paid");
    // a later correct event (new id) for the right amount is still honoured
    Object.assign(p, { received: 1000n });
    expect(await deliver(fake.payEvent(eid(), ref))).toBe(200);
    expect(await saleCount()).toBe(2);
  });

  it("does not book a payment whose currency or order identity differs", async () => {
    const a = await mkOrder([["seller_a", 1000]]);
    const b = await mkOrder([["seller_b", 1000]]);
    const refA = await checkoutRef(a.id);
    const refB = await checkoutRef(b.id);
    fake.pay(refA);
    fake.payments.get(refA)!.orderId = b.id; // tampered metadata points at the other order
    expect(await deliver(fake.payEvent(eid(), refA))).not.toBe(200);
    fake.payments.get(refA)!.orderId = a.id;
    fake.payments.get(refA)!.currency = "USD";
    expect(await deliver(fake.payEvent(eid(), refA))).not.toBe(200);
    expect(await saleCount()).toBe(0);
    expect((await rows("SELECT status FROM orders ORDER BY id")).every((r) => r.status === "pending_payment")).toBe(true);
    expect(refB).not.toBe(refA);
  });

  it("an authorisation or created event never books money", async () => {
    const o = await mkOrder([["seller_a", 1000]], { capture: "manual" });
    const ref = await checkoutRef(o.id);
    fake.pay(ref); // authorised only
    expect(await deliver(fake.payEvent(eid(), ref, "payment_observed"))).toBe(200);
    expect(await saleCount()).toBe(0);
    expect((await rows("SELECT status FROM orders WHERE id=$1", [o.id]))[0].status).toBe("pending_payment");
  });
});

describe("manual capture", () => {
  const manual = async () => {
    const o = await mkOrder([["seller_a", 600], ["seller_b", 400]], { capture: "manual" });
    const ref = await checkoutRef(o.id);
    fake.pay(ref);
    return { ...o, ref };
  };

  it("captures once even when requested many times concurrently", async () => {
    const o = await manual();
    const rs = await Promise.all(Array.from({ length: 6 }, () => post(`/orders/${o.id}/capture`, {})));
    expect(rs.every((r) => r.status === 200 && r.body.status === "paid")).toBe(true);
    expect(Number((await rows("SELECT count(*)::int c FROM ledger_entries WHERE kind='sale' AND account='provider:clearing'"))[0].c)).toBe(1);
    await assertSound();
  });

  it("a lost capture response parks the order; the webhook later books exactly once", async () => {
    const o = await manual();
    fake.faults.capture = "lose";
    expect((await post(`/orders/${o.id}/capture`, {})).status).toBe(502);
    expect((await rows("SELECT status FROM orders WHERE id=$1", [o.id]))[0].status).toBe("capture_pending");
    expect(await saleCount()).toBe(0);
    expect(await deliver(fake.payEvent(eid(), o.ref))).toBe(200);
    expect(await deliver(fake.payEvent(eid(), o.ref))).toBe(200);
    expect((await rows("SELECT status FROM orders WHERE id=$1", [o.id]))[0].status).toBe("paid");
    expect(Number((await rows("SELECT count(*)::int c FROM ledger_entries WHERE kind='sale' AND account='provider:clearing'"))[0].c)).toBe(1);
    await assertSound();
  });

  it("a capture failing before the provider applied it books nothing and can be retried", async () => {
    const o = await manual();
    fake.faults.capture = "fail";
    expect((await post(`/orders/${o.id}/capture`, {})).status).toBe(502);
    expect(await saleCount()).toBe(0);
    expect((await post(`/orders/${o.id}/capture`, {})).status).toBe(200);
    expect(Number((await rows("SELECT count(*)::int c FROM ledger_entries WHERE kind='sale' AND account='provider:clearing'"))[0].c)).toBe(1);
  });

  it("a partial capture is never booked as the full sale", async () => {
    const o = await manual();
    fake.partialCapture = 600n;
    const r = await post(`/orders/${o.id}/capture`, {});
    expect(r.status).toBe(502);
    expect(await saleCount()).toBe(0);
    expect(await deliver(fake.payEvent(eid(), o.ref))).not.toBe(200);
    expect(await saleCount()).toBe(0);
    expect((await rows("SELECT status FROM orders WHERE id=$1", [o.id]))[0].status).not.toBe("paid");
  });
});

describe("refunds", () => {
  it("a partial refund debits the line's seller, reduces refundable capacity and updates the order", async () => {
    const o = await paidOrder();
    const r = await post(`/orders/${o.id}/refunds`, { line_id: o.lines[0], amount: 250 });
    expect(r.status).toBe(200);
    expect(r.body.status).toBe("succeeded");
    expect((await rows("SELECT status FROM orders WHERE id=$1", [o.id]))[0].status).toBe("partially_refunded");
    expect(await big("SELECT coalesce(sum(amount),0)::text v FROM ledger_entries WHERE account='seller:seller_a'")).toBe(-540n + 250n);
    expect((await post(`/orders/${o.id}/refunds`, { line_id: o.lines[0], amount: 351 })).status).toBe(400);
    expect((await post(`/orders/${o.id}/refunds`, { line_id: o.lines[0], amount: 350 })).status).toBe(200);
    expect((await post(`/orders/${o.id}/refunds`, { line_id: o.lines[0], amount: 1 })).status).toBe(400);
    expect((await post(`/orders/${o.id}/refunds`, { line_id: o.lines[1], amount: 400 })).status).toBe(200);
    expect((await rows("SELECT status FROM orders WHERE id=$1", [o.id]))[0].status).toBe("refunded");
    expect(fake.calls.refundApplied).toBe(3);
    await assertSound();
  });

  it("validates the refund request: positive integers, existing line of this order, never another order's line", async () => {
    const o = await paidOrder();
    const other = await paidOrder([["seller_b", 700]]);
    for (const amount of [0, -1, 1.5, "x", null, "1e2"])
      expect((await post(`/orders/${o.id}/refunds`, { line_id: o.lines[0], amount })).status).toBeGreaterThanOrEqual(400);
    expect((await post(`/orders/${o.id}/refunds`, { line_id: other.lines[0], amount: 10 })).status).toBe(404);
    expect((await post(`/orders/${o.id}/refunds`, { line_id: "nope", amount: 10 })).status).toBe(404);
    expect(fake.calls.refund).toBe(0);
  });

  it("concurrent refunds on a line can never exceed it (and each accepted refund is sent exactly once)", async () => {
    const o = await paidOrder([["seller_a", 1000]]);
    const rs = await Promise.all(Array.from({ length: 12 }, () => post(`/orders/${o.id}/refunds`, { line_id: o.lines[0], amount: 400 })));
    const ok = rs.filter((r) => r.status === 200).length;
    expect(ok).toBe(2);
    expect(rs.filter((r) => r.status === 400).length).toBe(10);
    expect(fake.calls.refundApplied).toBe(2);
    expect(await big("SELECT coalesce(sum(amount),0)::text v FROM refunds WHERE status='succeeded'")).toBe(800n);
    await assertSound();
  });

  it("concurrent refunds across lines cannot exceed the order total", async () => {
    const o = await paidOrder([["seller_a", 500], ["seller_b", 500]]);
    const reqs = o.lines.flatMap((l) => Array.from({ length: 6 }, () => post(`/orders/${o.id}/refunds`, { line_id: l, amount: 200 })));
    const rs = await Promise.all(reqs);
    expect(rs.filter((r) => r.status === 200).length).toBe(4);
    expect(await big("SELECT coalesce(sum(amount),0)::text v FROM refunds WHERE status='succeeded'")).toBe(800n);
    await assertSound();
  });

  it("a lost refund response keeps the amount reserved, is never resent, and a later webhook links it exactly once", async () => {
    const o = await paidOrder([["seller_a", 1000]]);
    fake.faults.refund = "lose";
    const r = await post(`/orders/${o.id}/refunds`, { line_id: o.lines[0], amount: 600 });
    expect(r.status).toBe(502);
    expect(fake.calls.refundApplied).toBe(1);
    // capacity stays reserved while the outcome is unknown
    expect((await post(`/orders/${o.id}/refunds`, { line_id: o.lines[0], amount: 401 })).status).toBe(400);
    // recovery scans (the periodic one and explicit ones) must not repost a possibly committed refund
    await db.query("UPDATE refund_requests SET next_attempt_at = now() - interval '1 minute'");
    await Promise.all([app.recoverPendingRefunds(), app.recoverPendingRefunds()]);
    await sleep(1200);
    expect(fake.calls.refund).toBe(1);
    expect(fake.calls.refundApplied).toBe(1);
    expect(Number((await rows("SELECT count(*)::int c FROM refund_requests WHERE NOT resolved"))[0].c)).toBe(1);
    expect(await big("SELECT count(*)::text v FROM ledger_entries WHERE kind='refund'")).toBe(0n);
    // provider webhook (carrying the request id) resolves it
    const pr = [...fake.refunds.values()][0]!;
    expect(await deliver(fake.refundEvent(eid(), pr.ref))).toBe(200);
    expect(await deliver(fake.refundEvent(eid(), pr.ref))).toBe(200);
    expect(Number((await rows("SELECT count(*)::int c FROM refund_requests WHERE NOT resolved"))[0].c)).toBe(0);
    expect(Number((await rows("SELECT count(*)::int c FROM refunds"))[0].c)).toBe(1);
    expect((await rows("SELECT origin, line_id FROM refunds"))[0]).toEqual({ origin: "api", line_id: o.lines[0] });
    expect(await big("SELECT count(*)::text v FROM ledger_entries WHERE kind='refund'")).toBe(2n);
    expect((await post(`/orders/${o.id}/refunds`, { line_id: o.lines[0], amount: 401 })).status).toBe(400);
    expect((await post(`/orders/${o.id}/refunds`, { line_id: o.lines[0], amount: 400 })).status).toBe(200);
    await assertSound();
  });

  it("an unknown-outcome reservation limits its own line even when the rest of the order has room", async () => {
    const o = await paidOrder([["seller_a", 600], ["seller_b", 400]]);
    fake.faults.refund = "lose";
    expect((await post(`/orders/${o.id}/refunds`, { line_id: o.lines[0], amount: 500 })).status).toBe(502);
    expect((await post(`/orders/${o.id}/refunds`, { line_id: o.lines[0], amount: 101 })).status).toBe(400);
    expect((await post(`/orders/${o.id}/refunds`, { line_id: o.lines[0], amount: 100 })).status).toBe(200);
    expect((await post(`/orders/${o.id}/refunds`, { line_id: o.lines[1], amount: 400 })).status).toBe(200);
  });

  it("a request whose POST may have started before a crash is never resent after restart", async () => {
    const o = await paidOrder([["seller_a", 1000]]);
    await db.query(
      "INSERT INTO refund_requests (id, order_id, line_id, payment_ref, target_ref, currency, amount, post_started, next_attempt_at) VALUES ('rf_crash',$1,$2,$3,$3,'INR',300,true, now() - interval '1 minute')",
      [o.id, o.lines[0], o.ref],
    );
    await app.recoverPendingRefunds();
    await sleep(1200);
    expect(fake.calls.refund).toBe(0);
    expect(Number((await rows("SELECT count(*)::int c FROM refund_requests WHERE NOT resolved"))[0].c)).toBe(1);
    expect((await post(`/orders/${o.id}/refunds`, { line_id: o.lines[0], amount: 701 })).status).toBe(400);
  });

  it("a durable reservation never yet sent is sent exactly once, even with concurrent recovery workers", async () => {
    const o = await paidOrder([["seller_a", 1000]]);
    await db.query(
      "INSERT INTO refund_requests (id, order_id, line_id, payment_ref, currency, amount, next_attempt_at) VALUES ('rf_unsent',$1,$2,$3,'INR',300, now() - interval '1 minute')",
      [o.id, o.lines[0], o.ref],
    );
    await Promise.all(Array.from({ length: 6 }, () => app.recoverPendingRefunds()));
    await sleep(800);
    expect(fake.calls.refundApplied).toBe(1);
    expect(fake.calls.refund).toBe(1);
    expect(Number((await rows("SELECT count(*)::int c FROM refunds"))[0].c)).toBe(1);
    expect(Number((await rows("SELECT count(*)::int c FROM refund_requests WHERE NOT resolved"))[0].c)).toBe(0);
    await assertSound();
  });

  it("a definitive provider rejection releases the reservation; an ambiguous failure does not", async () => {
    const o = await paidOrder([["seller_a", 1000]]);
    fake.faults.refund = "reject";
    expect((await post(`/orders/${o.id}/refunds`, { line_id: o.lines[0], amount: 900 })).status).toBe(409);
    expect((await rows("SELECT resolution FROM refund_requests"))[0].resolution).toBe("rejected");
    // capacity is available again
    expect((await post(`/orders/${o.id}/refunds`, { line_id: o.lines[0], amount: 900 })).status).toBe(200);
    fake.faults.refund = "fail"; // generic failure: unknown outcome
    expect((await post(`/orders/${o.id}/refunds`, { line_id: o.lines[0], amount: 100 })).status).toBe(502);
    expect((await post(`/orders/${o.id}/refunds`, { line_id: o.lines[0], amount: 1 })).status).toBe(400);
    await assertSound();
  });

  it("a pending refund holds money; success does not double-book; failure reverses exactly once and frees capacity", async () => {
    const o = await paidOrder([["seller_a", 1000]]);
    fake.nextRefundStatus = "pending";
    const r = await post(`/orders/${o.id}/refunds`, { line_id: o.lines[0], amount: 700 });
    expect(r.body.status).toBe("pending");
    expect(await big("SELECT count(*)::text v FROM ledger_entries WHERE kind='refund'")).toBe(2n);
    expect((await post(`/orders/${o.id}/refunds`, { line_id: o.lines[0], amount: 301 })).status).toBe(400);
    const ref = [...fake.refunds.keys()][0]!;
    fake.refunds.get(ref)!.status = "succeeded";
    expect(await deliver(fake.refundEvent(eid(), ref))).toBe(200);
    expect(await big("SELECT count(*)::text v FROM ledger_entries WHERE kind='refund'")).toBe(2n);
    expect((await rows("SELECT status FROM refunds"))[0].status).toBe("succeeded");
    await assertSound();
  });

  it("pending then failed: reversal posted once even with duplicate and stale events; order and capacity restored", async () => {
    const o = await paidOrder([["seller_a", 1000]]);
    fake.nextRefundStatus = "pending";
    await post(`/orders/${o.id}/refunds`, { line_id: o.lines[0], amount: 700 });
    const ref = [...fake.refunds.keys()][0]!;
    const staleSucceeded = fake.refundEvent("evt_stale", ref, { status: "succeeded" }); // body claims success
    fake.refunds.get(ref)!.status = "failed";
    expect(await deliver(fake.refundEvent(eid(), ref))).toBe(200);
    expect(await deliver(staleSucceeded)).toBe(200); // current provider state (failed) wins over the body
    expect(await deliver(fake.refundEvent(eid(), ref))).toBe(200);
    expect(await deliver(fake.refundEvent("evt_stale", ref))).toBe(200);
    expect((await rows("SELECT status FROM refunds"))[0].status).toBe("failed");
    expect(await big("SELECT count(*)::text v FROM ledger_entries WHERE kind='refund_reversal'")).toBe(2n);
    expect(await big("SELECT coalesce(sum(amount),0)::text v FROM ledger_entries WHERE account='provider:clearing'")).toBe(1000n);
    expect((await rows("SELECT status FROM orders WHERE id=$1", [o.id]))[0].status).toBe("paid");
    // a stale "succeeded" read after the failure must not resurrect the refund
    fake.refunds.get(ref)!.status = "succeeded";
    expect(await deliver(fake.refundEvent(eid(), ref))).toBe(200);
    expect((await rows("SELECT status FROM refunds"))[0].status).toBe("failed");
    expect(await big("SELECT count(*)::text v FROM ledger_entries WHERE kind='refund'")).toBe(2n);
    fake.refunds.get(ref)!.status = "failed";
    expect((await post(`/orders/${o.id}/refunds`, { line_id: o.lines[0], amount: 1000 })).status).toBe(200);
    await assertSound();
  });

  it("a refund that succeeded and later failed is reversed once", async () => {
    const o = await paidOrder([["seller_a", 1000]]);
    await post(`/orders/${o.id}/refunds`, { line_id: o.lines[0], amount: 500 });
    const ref = [...fake.refunds.keys()][0]!;
    fake.refunds.get(ref)!.status = "failed";
    for (let i = 0; i < 3; i++) expect(await deliver(fake.refundEvent(eid(), ref))).toBe(200);
    expect(await big("SELECT count(*)::text v FROM ledger_entries WHERE kind='refund_reversal'")).toBe(2n);
    expect(await big("SELECT coalesce(sum(amount),0)::text v FROM ledger_entries WHERE account='seller:seller_a'")).toBe(-900n);
    await assertSound();
  });

  it("a refund event arriving before the payment event is retried later, then applied once", async () => {
    const o = await mkOrder([["seller_a", 1000]]);
    const ref = await checkoutRef(o.id);
    fake.pay(ref);
    const dash = fake.dashboardRefund(ref, 100n);
    const ev = fake.refundEvent(eid(), dash.ref);
    expect(await deliver(ev)).toBe(503);
    expect(Number((await rows("SELECT count(*)::int c FROM refunds"))[0].c)).toBe(0);
    expect(await deliver(fake.payEvent(eid(), ref))).toBe(200);
    expect(await deliver(ev)).toBe(200);
    expect(await deliver(ev)).toBe(200);
    expect(Number((await rows("SELECT count(*)::int c FROM refunds"))[0].c)).toBe(1);
    expect((await rows("SELECT origin FROM refunds"))[0].origin).toBe("provider");
    await assertSound();
  });

  it("dashboard refunds are recorded once, count against the order, and block over-refunding through the API", async () => {
    const o = await paidOrder([["seller_a", 600], ["seller_b", 400]]);
    const dash = fake.dashboardRefund(o.ref, 700n);
    const ev = fake.refundEvent(eid(), dash.ref);
    const rs = await Promise.all([deliver(ev), deliver(ev), deliver(fake.refundEvent(eid(), dash.ref))]);
    expect(rs.every((s) => s === 200 || s === 503)).toBe(true);
    expect(await deliver(ev)).toBe(200);
    expect(await big("SELECT coalesce(sum(amount),0)::text v FROM refunds")).toBe(700n);
    expect(await big("SELECT coalesce(sum(amount),0)::text v FROM ledger_entries WHERE account='platform:unallocated_refunds'")).toBe(700n);
    expect((await post(`/orders/${o.id}/refunds`, { line_id: o.lines[0], amount: 301 })).status).toBe(400);
    expect((await post(`/orders/${o.id}/refunds`, { line_id: o.lines[0], amount: 300 })).status).toBe(200);
    await assertSound();
  });

  it("a dashboard refund larger than what is left on the order is not recorded as money out", async () => {
    const o = await paidOrder([["seller_a", 1000]]);
    await post(`/orders/${o.id}/refunds`, { line_id: o.lines[0], amount: 800 });
    // a (buggy or malicious) observation of refunds exceeding capture must be refused, not booked
    const bogus = fake.dashboardRefund(o.ref, 500n);
    expect(await deliver(fake.refundEvent(eid(), bogus.ref))).not.toBe(200);
    expect(await big("SELECT coalesce(sum(amount),0)::text v FROM refunds WHERE status='succeeded'")).toBe(800n);
    await assertSound();
  });

  it("never links an uncorrelated refund to a reservation by amount alone", async () => {
    const o = await paidOrder([["seller_a", 1000]]);
    fake.faults.refund = "fail"; // unknown outcome, nothing applied at the provider
    await post(`/orders/${o.id}/refunds`, { line_id: o.lines[0], amount: 300 });
    const dash = fake.dashboardRefund(o.ref, 300n);
    expect(await deliver(fake.refundEvent(eid(), dash.ref))).toBe(503);
    expect(Number((await rows("SELECT count(*)::int c FROM refund_requests WHERE NOT resolved"))[0].c)).toBe(1);
    const other = fake.dashboardRefund(o.ref, 301n);
    expect(await deliver(fake.refundEvent(eid(), other.ref))).toBe(200);
    expect(await big("SELECT coalesce(sum(amount),0)::text v FROM refunds")).toBe(301n);
    await assertSound();
  });

  it("refuses a refund whose provider-side currency differs from the order, booking nothing", async () => {
    const o = await paidOrder([["seller_a", 1000]]);
    fake.refundCurrency = "USD";
    const r = await post(`/orders/${o.id}/refunds`, { line_id: o.lines[0], amount: 100 });
    expect(r.status).toBe(502);
    expect(await big("SELECT count(*)::text v FROM ledger_entries WHERE kind='refund'")).toBe(0n);
    expect(Number((await rows("SELECT count(*)::int c FROM refunds"))[0].c)).toBe(0);
  });

  it("applies the Razorpay INR minimum before reserving or calling the provider", async () => {
    const o = await paidOrder([["seller_a", 1000]]);
    fake.refundRequestError = (amount, currency) => (currency === "INR" && amount < 100n ? "minimum" : undefined);
    try {
      expect((await post(`/orders/${o.id}/refunds`, { line_id: o.lines[0], amount: 99 })).status).toBe(400);
      expect(fake.calls.refund).toBe(0);
      expect(Number((await rows("SELECT count(*)::int c FROM refund_requests"))[0].c)).toBe(0);
      expect((await post(`/orders/${o.id}/refunds`, { line_id: o.lines[0], amount: 100 })).status).toBe(200);
    } finally {
      fake.refundRequestError = undefined;
    }
  });

  it("refunds on one order never touch another order's money", async () => {
    const a = await paidOrder([["seller_a", 1000]]);
    const b = await paidOrder([["seller_a", 1000]]);
    await post(`/orders/${a.id}/refunds`, { line_id: a.lines[0], amount: 1000 });
    expect((await rows("SELECT status FROM orders WHERE id=$1", [b.id]))[0].status).toBe("paid");
    expect((await post(`/orders/${b.id}/refunds`, { line_id: b.lines[0], amount: 1000 })).status).toBe(200);
    await assertSound();
  });
});

describe("property: random event/refund histories keep the books sound", () => {
  type Op =
    | { t: "refund"; line: number; amt: number; mode: "ok" | "lose" | "fail" | "pending" | "reject" }
    | { t: "dash"; amt: number }
    | { t: "failRefund"; i: number }
    | { t: "succeedRefund"; i: number }
    | { t: "dupRefundEvent"; i: number }
    | { t: "dupPayEvent" };
  const opArb: fc.Arbitrary<Op> = fc.oneof(
    fc.record({ t: fc.constant("refund" as const), line: fc.nat(2), amt: fc.integer({ min: 1, max: 2500 }), mode: fc.constantFrom("ok", "ok", "ok", "lose", "fail", "pending", "reject") }),
    fc.record({ t: fc.constant("dash" as const), amt: fc.integer({ min: 1, max: 2500 }) }),
    fc.record({ t: fc.constant("failRefund" as const), i: fc.nat(5) }),
    fc.record({ t: fc.constant("succeedRefund" as const), i: fc.nat(5) }),
    fc.record({ t: fc.constant("dupRefundEvent" as const), i: fc.nat(5) }),
    fc.record({ t: fc.constant("dupPayEvent" as const) }),
  );

  it("ledger balanced, clearing exact, refunds within capture, DB agrees with provider after reconciliation", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.integer({ min: 100, max: 3000 }), { minLength: 1, maxLength: 3 }),
        fc.array(opArb, { minLength: 1, maxLength: 12 }),
        async (lineAmounts, ops) => {
          fake.reset();
          await db.query("TRUNCATE orders, order_lines, refunds, refund_requests, ledger_entries, processed_events CASCADE");
          const o = await paidOrder(lineAmounts.map((a, i) => [i % 2 ? "seller_b" : "seller_a", a] as [string, number]));
          const refs = () => [...fake.refunds.keys()];
          for (const op of ops) {
            if (op.t === "refund") {
              if (op.mode === "lose" || op.mode === "fail" || op.mode === "reject") fake.faults.refund = op.mode;
              if (op.mode === "pending") fake.nextRefundStatus = "pending";
              await post(`/orders/${o.id}/refunds`, { line_id: o.lines[op.line % o.lines.length], amount: op.amt });
              fake.faults.refund = undefined;
              fake.nextRefundStatus = "succeeded";
            } else if (op.t === "dash") {
              const pay = fake.payments.get(o.ref)!;
              if (BigInt(op.amt) <= pay.received - fake.liveRefunded(o.ref)) {
                const d = fake.dashboardRefund(o.ref, BigInt(op.amt));
                await deliver(fake.refundEvent(eid(), d.ref));
              }
            } else if (op.t === "failRefund" || op.t === "succeedRefund" || op.t === "dupRefundEvent") {
              const r = refs()[op.i % Math.max(1, refs().length)];
              if (!r) continue;
              if (op.t === "failRefund") fake.refunds.get(r)!.status = "failed";
              if (op.t === "succeedRefund" && fake.refunds.get(r)!.status === "pending") fake.refunds.get(r)!.status = "succeeded";
              await deliver(fake.refundEvent(eid(), r));
            } else await deliver(fake.payEvent(eid(), o.ref));
          }
          await assertSound();
          // reconcile: provider is the truth for every refund it knows
          for (const r of refs()) await deliver(fake.refundEvent(eid(), r));
          for (const r of refs()) await deliver(fake.refundEvent(eid(), r));
          await assertSound();
          for (const row of await rows("SELECT provider_ref, status FROM refunds")) {
            const p = fake.refunds.get(row.provider_ref);
            expect(p, `db refund ${row.provider_ref} unknown to provider`).toBeDefined();
            const holds = (s: string) => ["pending", "requires_action", "succeeded"].includes(s);
            // a failed refund never comes back; otherwise DB must hold exactly what the provider holds
            expect(holds(row.status)).toBe(holds(p!.status));
          }
          expect(fake.liveRefunded(o.ref) <= fake.payments.get(o.ref)!.received).toBe(true);
        },
      ),
      { numRuns: 20 },
    );
  });
});
