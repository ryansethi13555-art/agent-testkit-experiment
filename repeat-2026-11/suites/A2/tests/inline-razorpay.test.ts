// inline-marketplace on Razorpay: same money guarantees through a different provider shape
// (order id as payment reference, INR minimum refund, HMAC webhooks, event-id header).
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sleep } from "./helpers/db.ts";
import { FakeRazorpay, type RzpPay } from "./helpers/fake-razorpay.ts";
import { bootInline, type Inline, ledgerFacts } from "./helpers/inline-harness.ts";

let fake: FakeRazorpay;
let h: Inline;
beforeAll(async () => {
  fake = new FakeRazorpay();
  await fake.listen();
  h = await bootInline({ provider: "razorpay", apiBase: fake.base });
});
afterAll(async () => {
  await h?.stop();
  await fake?.close();
});
beforeEach(async () => {
  fake.reset();
  await h.reset();
});

const TWO = [
  { seller_id: "seller_a", amount: 60000 },
  { seller_id: "seller_b", amount: 40000 },
];
async function newOrder(lines: unknown[] = TWO, extra: Record<string, unknown> = {}) {
  const r = await h.post("/orders", { buyer: "b1", currency: "INR", lines, ...extra });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return { id: String(r.body.id), lines: r.body.lines as string[] };
}
async function checkout(id: string) {
  const r = await h.post(`/orders/${id}/checkout`);
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return String(r.body.payment_intent_id);
}
async function send(raw: string, opts: { eventId?: string | null; secret?: string } = {}) {
  const headers: Record<string, string> = { "x-razorpay-signature": FakeRazorpay.sign(raw, opts.secret) };
  if (opts.eventId !== null) headers["x-razorpay-event-id"] = opts.eventId ?? `evt_${Math.random().toString(36).slice(2)}`;
  return h.post("/webhooks/razorpay", raw, headers);
}
async function paid(lines: unknown[] = TWO, extra: Record<string, unknown> = {}) {
  const o = await newOrder(lines, extra);
  const rzpOrder = await checkout(o.id);
  const pay = fake.customerPays(rzpOrder);
  expect((await send(FakeRazorpay.paymentEvent("payment.captured", pay))).status).toBe(200);
  return { ...o, rzpOrder, pay };
}
const count = async (table: string, where = "true") =>
  Number((await h.q<{ c: string }>(`SELECT count(*)::text c FROM ${table} WHERE ${where}`))[0]?.c);
const orderStatus = async (id: string) => String((await h.q("SELECT status FROM orders WHERE id=$1", [id]))[0]?.status);

async function consistent() {
  const lf = await ledgerFacts(h);
  expect(lf.unbalancedTxns).toBe(0);
  expect(await lf.sum()).toBe(0n);
  const captured = BigInt((await h.q<{ s: string }>("SELECT coalesce(sum(total),0)::text s FROM orders WHERE status IN ('paid','partially_refunded','refunded')"))[0]?.s ?? "0");
  const live = BigInt((await h.q<{ s: string }>("SELECT coalesce(sum(amount),0)::text s FROM refunds WHERE status NOT IN ('failed','canceled')"))[0]?.s ?? "0");
  expect(await lf.sum("account='provider:clearing'")).toBe(captured - live);
}

describe("Razorpay sale", () => {
  it("creates one provider order carrying the app's order id, amount and currency; checkout is idempotent", async () => {
    const o = await newOrder();
    const a = await checkout(o.id);
    const b = await checkout(o.id);
    expect(a).toBe(b);
    expect(fake.orders.size).toBe(1);
    const ro = fake.orders.get(a);
    expect(ro?.amount).toBe(100000);
    expect(ro?.currency).toBe("INR");
    expect(ro?.notes.order_id).toBe(o.id);
  });

  it("books a captured payment once, whatever the delivery pattern", async () => {
    const o = await newOrder();
    const ref = await checkout(o.id);
    const pay = fake.customerPays(ref);
    const raw = FakeRazorpay.paymentEvent("payment.captured", pay);
    const sameId = await Promise.all(Array.from({ length: 8 }, () => send(raw, { eventId: "evt_same" })));
    expect(sameId.every((r) => r.status === 200)).toBe(true);
    // no event-id header: deduped on the signed body
    await send(raw, { eventId: null });
    await send(raw, { eventId: null });
    // a fresh event id for the same payment, and the return-from-checkout path
    await send(raw, { eventId: "evt_other" });
    await h.post(`/orders/${o.id}/confirm`);
    expect(await count("ledger_entries", "kind='sale'")).toBe(3);
    expect(await count("ledger_entries", "kind='commission'")).toBe(2);
    expect(await orderStatus(o.id)).toBe("paid");
    await consistent();
  });

  it("books a payment whose notes are missing by matching the stored order reference", async () => {
    fake.paymentsCarryNotes = false;
    const o = await newOrder();
    const ref = await checkout(o.id);
    const pay = fake.customerPays(ref);
    expect((await send(FakeRazorpay.paymentEvent("payment.captured", pay))).status).toBe(200);
    expect(await orderStatus(o.id)).toBe("paid");
    expect(await count("ledger_entries", "kind='sale'")).toBe(3);
  });

  it("rejects missing or wrong signatures and applies nothing", async () => {
    const o = await newOrder();
    const pay = fake.customerPays(await checkout(o.id));
    const raw = FakeRazorpay.paymentEvent("payment.captured", pay);
    expect((await h.post("/webhooks/razorpay", raw)).status).toBe(400);
    expect((await send(raw, { secret: "wrong" })).status).toBe(400);
    expect((await h.post("/webhooks/razorpay", raw.replace('"amount":100000', '"amount":1'), { "x-razorpay-signature": FakeRazorpay.sign(raw) })).status).toBe(400);
    expect(await count("ledger_entries")).toBe(0);
    expect(await orderStatus(o.id)).toBe("pending_payment");
  });

  it("an authorisation is not money: nothing is booked until capture", async () => {
    const o = await newOrder(TWO, { capture: "manual" });
    const ref = await checkout(o.id);
    expect(fake.orders.get(ref)?.payment_capture).toBe(false);
    const pay = fake.customerPays(ref, "authorized");
    expect((await send(FakeRazorpay.paymentEvent("payment.authorized", pay))).status).toBe(200);
    expect(await count("ledger_entries")).toBe(0);
    expect(await orderStatus(o.id)).toBe("pending_payment");
    const c = await h.post(`/orders/${o.id}/capture`);
    expect(c.status).toBe(200);
    expect(await count("ledger_entries", "kind='sale'")).toBe(3);
    // replays and an idempotent re-capture do not double book
    await send(FakeRazorpay.paymentEvent("payment.captured", fake.payments.get(pay.id) as RzpPay));
    await h.post(`/orders/${o.id}/confirm`);
    expect(await count("ledger_entries", "kind='sale'")).toBe(3);
    await consistent();
  });

  it("refuses to book a captured payment whose amount or currency differs from the order", async () => {
    const o = await newOrder();
    const pay = fake.customerPays(await checkout(o.id));
    pay.amount -= 1;
    expect((await send(FakeRazorpay.paymentEvent("payment.captured", pay))).status).not.toBe(200);
    pay.amount += 1;
    pay.currency = "USD";
    expect((await send(FakeRazorpay.paymentEvent("payment.captured", pay))).status).not.toBe(200);
    expect(await count("ledger_entries")).toBe(0);
    expect(await orderStatus(o.id)).toBe("pending_payment");
  });

  it("a failed attempt then a captured attempt on the same order books the captured one", async () => {
    const o = await newOrder();
    const ref = await checkout(o.id);
    const failed = fake.customerPays(ref, "failed");
    expect((await send(FakeRazorpay.paymentEvent("payment.failed", failed))).status).toBe(200);
    expect(await count("ledger_entries")).toBe(0);
    const good = fake.customerPays(ref);
    expect((await send(FakeRazorpay.paymentEvent("payment.captured", good))).status).toBe(200);
    expect(await count("ledger_entries", "kind='sale'")).toBe(3);
    await consistent();
  });
});

describe("Razorpay refunds", () => {
  it("enforces the 100 minor-unit INR minimum before reserving or calling the provider; other currencies are not limited", async () => {
    const o = await paid();
    for (const amount of [1, 99]) {
      const r = await h.post(`/orders/${o.id}/refunds`, { line_id: o.lines[0], amount });
      expect(r.status).toBe(400);
    }
    expect(await count("refund_requests")).toBe(0);
    expect(fake.count("POST", /refund$/)).toBe(0);
    expect((await h.post(`/orders/${o.id}/refunds`, { line_id: o.lines[0], amount: 100 })).status).toBe(200);
    expect(fake.refunds.size).toBe(1);

    const usd = await paid([{ seller_id: "seller_a", amount: 5000 }], { currency: "USD" });
    expect((await h.post(`/orders/${usd.id}/refunds`, { line_id: usd.lines[0], amount: 50 })).status).toBe(200);
  });

  it("refunds the payment (not the order), with idempotency key and identifying notes, and books the seller reversal", async () => {
    const o = await paid();
    const r = await h.post(`/orders/${o.id}/refunds`, { line_id: o.lines[1], amount: 12345 });
    expect(r.status).toBe(200);
    const post = fake.log.find((l) => /refund$/.test(l.path));
    expect(post?.path).toBe(`/payments/${o.pay.id}/refund`);
    expect(post?.headers["x-refund-idempotency"]).toMatch(/^rf_/);
    expect((post?.body.notes as Record<string, string>).line_id).toBe(o.lines[1]);
    expect(post?.body.amount).toBe(12345);
    expect(await (await ledgerFacts(h)).sum("kind='refund' AND account='seller:seller_b'")).toBe(12345n);
    expect(await orderStatus(o.id)).toBe("partially_refunded");
    await consistent();
  });

  it("parallel refunds cannot over-refund a line", async () => {
    const o = await paid([{ seller_id: "seller_a", amount: 500 }]);
    const rs = await Promise.all(Array.from({ length: 8 }, () => h.post(`/orders/${o.id}/refunds`, { line_id: o.lines[0], amount: 100 })));
    expect(rs.filter((r) => r.status === 200).length).toBe(5);
    expect(fake.count("POST", /refund$/)).toBe(5);
    expect(await orderStatus(o.id)).toBe("refunded");
    await consistent();
  });

  it("an unknown refund outcome keeps its reservation, is not re-posted, and is linked exactly once by its event", async () => {
    const o = await paid();
    fake.inject(/refund$/, "apply_then_500");
    const r = await h.post(`/orders/${o.id}/refunds`, { line_id: o.lines[0], amount: 20000 });
    expect(r.status).toBe(502);
    expect(fake.refunds.size).toBe(1);
    expect((await h.post(`/orders/${o.id}/refunds`, { line_id: o.lines[0], amount: 40001 })).status).toBe(400);
    await sleep(1800);
    expect(fake.count("POST", /refund$/)).toBe(1); // only the original POST (the 40001 attempt never reached the provider)
    const prov = [...fake.refunds.values()][0];
    expect(prov).toBeDefined();
    const raw = FakeRazorpay.refundEvent("refund.processed", prov as never);
    expect((await send(raw, { eventId: "e1" })).status).toBe(200);
    expect((await send(raw, { eventId: "e2" })).status).toBe(200);
    const rows = await h.q<{ origin: string; line_id: string }>("SELECT * FROM refunds");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.origin).toBe("api");
    expect(rows[0]?.line_id).toBe(o.lines[0]);
    expect(await (await ledgerFacts(h)).sum("kind='refund' AND account='seller:seller_a'")).toBe(20000n);
    expect((await h.post(`/orders/${o.id}/refunds`, { line_id: o.lines[0], amount: 40000 })).status).toBe(200);
    expect((await h.post(`/orders/${o.id}/refunds`, { line_id: o.lines[0], amount: 100 })).status).toBe(400);
    await consistent();
  });

  it("a definitive over-refund rejection from the provider releases the reservation and books nothing", async () => {
    const o = await paid([{ seller_id: "seller_a", amount: 100000 }]);
    fake.dashboardRefund(o.pay.id, 70000); // refunded in the dashboard; the app has not heard yet
    const r = await h.post(`/orders/${o.id}/refunds`, { line_id: o.lines[0], amount: 50000 });
    expect(r.status).toBe(409);
    expect(await count("refunds")).toBe(0);
    expect(await count("ledger_entries", "kind='refund'")).toBe(0);
    expect((await h.post(`/orders/${o.id}/refunds`, { line_id: o.lines[0], amount: 30000 })).status).toBe(200);
    await consistent();
  });

  it("pending then failed: recognised once, reversed once, line capacity returns", async () => {
    fake.newRefundStatus = "pending";
    const o = await paid([{ seller_id: "seller_a", amount: 50000 }]);
    const r = await h.post(`/orders/${o.id}/refunds`, { line_id: o.lines[0], amount: 20000 });
    expect(r.status).toBe(200);
    expect(r.body.status).toBe("pending");
    expect(await count("ledger_entries", "kind='refund'")).toBe(2);
    const prov = [...fake.refunds.values()][0];
    expect(prov).toBeDefined();
    if (prov) prov.status = "failed";
    for (let i = 0; i < 3; i++) await send(FakeRazorpay.refundEvent("refund.failed", prov as never));
    expect(await count("ledger_entries", "kind='refund_reversal'")).toBe(2);
    expect(await orderStatus(o.id)).toBe("paid");
    if (prov) prov.status = "processed"; // a stale/contradictory observation cannot resurrect it
    await send(FakeRazorpay.refundEvent("refund.processed", prov as never));
    expect((await h.q<{ status: string }>("SELECT status FROM refunds"))[0]?.status).toBe("failed");
    expect(await count("ledger_entries", "kind='refund'")).toBe(2);
    if (prov) prov.status = "failed"; // provider truth is still "failed"
    expect((await h.post(`/orders/${o.id}/refunds`, { line_id: o.lines[0], amount: 50000 })).status).toBe(200);
  });

  it("a dashboard refund is recorded once against unallocated refunds", async () => {
    const o = await paid();
    const d = fake.dashboardRefund(o.pay.id, 5000);
    const raw = FakeRazorpay.refundEvent("refund.processed", d);
    await Promise.all([send(raw, { eventId: "d1" }), send(raw, { eventId: "d1" }), send(raw, { eventId: "d2" })]);
    expect(await count("refunds")).toBe(1);
    expect(await (await ledgerFacts(h)).sum("account='platform:unallocated_refunds'")).toBe(5000n);
    await consistent();
  });
});
