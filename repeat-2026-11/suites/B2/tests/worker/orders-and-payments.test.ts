// Worker marketplace: webhook intake, payment reconciliation, capture, checkout and the job queue.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Worker as Queue, backoffMs, enqueue } from "../../worker-marketplace/src/jobs.ts";
import { signStripe, stripeEvent } from "../helpers/fakeStripe.ts";
import { acct, commonLaws } from "../helpers/laws.ts";
import { type Worker, startWorker } from "../helpers/workerApp.ts";

let t: Worker;
beforeAll(async () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  t = await startWorker();
});
afterAll(async () => {
  await t?.stop();
});
beforeEach(async () => {
  await t.reset();
});
const n = async (sql: string, p: unknown[] = []) => Number((await t.one(sql, p)).c);

describe("webhook intake", () => {
  it("stores one job per event id, however many times and however concurrently it is delivered (S01, S02)", async () => {
    const { pi } = await t.checkedOut();
    t.fake.pay(pi);
    const ev = t.payEvent(pi, "evt_same");
    expect((await t.hook(ev)).status).toBe(200);
    expect((await t.hook(ev)).status).toBe(200);
    const rs = await Promise.all(Array.from({ length: 8 }, () => t.hook(ev)));
    for (const r of rs) expect(r.status).toBe(200);
    expect(await n("SELECT count(*) c FROM jobs")).toBe(1);
  });
  it("many events (fresh ids) for one payment book the sale exactly once", async () => {
    const { order, pi } = await t.checkedOut();
    t.fake.pay(pi);
    await Promise.all(Array.from({ length: 6 }, (_v, i) => t.hook(t.payEvent(pi, `evt_${i}`))));
    await t.post(`/orders/${order.id}/confirm`);
    await t.drain();
    expect(await n("SELECT count(*) c FROM ledger_entries WHERE kind='sale'")).toBe(3);
    expect(await n("SELECT count(*) c FROM allocations")).toBe(2);
    expect(await acct(t.db, "provider:clearing")).toBe(1000n);
    expect(await acct(t.db, "seller:seller_a")).toBe(-540n);
    expect(await acct(t.db, "platform:commission")).toBe(-100n);
    await commonLaws(t.db);
  });
  it("rejects forged, unsigned and mis-keyed notices without queueing anything (S16)", async () => {
    const { pi } = await t.checkedOut();
    const ev = t.payEvent(pi, "evt_forged");
    const raw = JSON.stringify(ev);
    expect((await t.post("/webhooks/stripe", raw, { "stripe-signature": "t=1,v1=00" })).status).toBe(400);
    expect((await t.post("/webhooks/stripe", raw)).status).toBe(400);
    const w = signStripe(ev, "whsec_other");
    expect((await t.post("/webhooks/stripe", w.payload, { "stripe-signature": w.header })).status).toBe(400);
    expect((await t.post("/webhooks/stripe", "not json", { "stripe-signature": "x" })).status).toBe(400);
    expect(await n("SELECT count(*) c FROM jobs")).toBe(0);
  });
  it("takes state from the provider, never from the notice body", async () => {
    const { order, pi } = await t.checkedOut();
    // the notice claims success and a captured amount, the provider says the payment is still pending
    const lying = stripeEvent("evt_lie", "payment_intent.succeeded", { id: pi, object: "payment_intent", status: "succeeded", amount: 1000, amount_received: 1000 });
    expect((await t.hook(lying)).status).toBe(200);
    await t.drain();
    expect(await t.status(order.id)).toBe("pending_payment");
    expect(await n("SELECT count(*) c FROM ledger_entries")).toBe(0);
  });
  it("ignores event types that carry no money object", async () => {
    expect((await t.hook(stripeEvent("evt_c", "customer.created", { id: "cus_1", object: "customer" }))).status).toBe(200);
    expect(await n("SELECT count(*) c FROM jobs")).toBe(0);
  });
  it("a notice for a payment that is not ours is dropped without booking money", async () => {
    expect((await t.hook(t.payEvent("pi_stranger"))).status).toBe(200);
    t.fake.payments.set("pi_stranger", { status: "succeeded", amount: 500n, captured: 500n, currency: "INR", orderId: "ord_nobody" });
    await t.drain();
    expect(await n("SELECT count(*) c FROM ledger_entries")).toBe(0);
  });
});

describe("payment reconciliation", () => {
  it("books one balanced sale with allocations per line when a notice is processed", async () => {
    const { order } = await t.paidOrder();
    expect(await t.status(order.id)).toBe("paid");
    const alloc = (await t.db.query("SELECT line_id, amount::text a, seller_amount::text s, commission_amount::text c FROM allocations ORDER BY line_id")).rows;
    expect(alloc.map((a) => [a.a, a.s, a.c])).toEqual([["600", "540", "60"], ["400", "360", "40"]]);
    await commonLaws(t.db);
  });
  it("odd and tiny amounts split with half-even commission and lose no minor unit", async () => {
    const { order } = await t.paidOrder([
      { seller_id: "seller_a", amount: 5 },
      { seller_id: "seller_b", amount: 15 },
      { seller_id: "seller_a", amount: 25 },
      { seller_id: "seller_b", amount: 1 },
    ]);
    const rows = (await t.db.query("SELECT amount::text a, seller_amount::text s, commission_amount::text c FROM allocations ORDER BY line_id")).rows;
    expect(rows.map((r) => r.c)).toEqual(["0", "2", "2", "0"]); // 0.5 -> 0, 1.5 -> 2, 2.5 -> 2, 0.1 -> 0
    for (const r of rows) expect(BigInt(r.s) + BigInt(r.c)).toBe(BigInt(r.a));
    expect(await acct(t.db, "provider:clearing")).toBe(46n);
    expect(await t.status(order.id)).toBe("paid");
    await commonLaws(t.db);
  });
  it("a payment that stays failed or pending books nothing", async () => {
    const { order, pi } = await t.checkedOut();
    await t.hook(t.payEvent(pi));
    await t.drain();
    expect(await t.status(order.id)).toBe("pending_payment");
    expect(await n("SELECT count(*) c FROM ledger_entries")).toBe(0);
  });
  it("capture applied at the provider but the app crashed before recording it (S14): confirm, notice and re-poll book once", async () => {
    const { order, pi } = await t.checkedOut();
    t.fake.pay(pi); // provider captured; the app never heard
    expect(await t.status(order.id)).toBe("pending_payment");
    await t.post(`/orders/${order.id}/confirm`);
    await t.hook(t.payEvent(pi));
    await t.drain();
    await t.post(`/orders/${order.id}/confirm`);
    expect(await t.status(order.id)).toBe("paid");
    expect(await n("SELECT count(*) c FROM ledger_entries WHERE kind='sale'")).toBe(3);
    await commonLaws(t.db);
  });
  it("a partial capture that does not match the order goes to suspense, never to sellers", async () => {
    const { order, pi } = await t.checkedOut();
    t.fake.pay(pi, 700n);
    await t.hook(t.payEvent(pi));
    await t.drain();
    expect(await acct(t.db, "provider:clearing")).toBe(700n);
    expect(await acct(t.db, "platform:unallocated_receipts")).toBe(-700n);
    expect(await acct(t.db, /^seller:/)).toBe(0n);
    expect(await n("SELECT count(*) c FROM allocations")).toBe(0);
    expect((await t.refund(order.id, `${order.id}_l1`, 100)).status).toBe(409); // nothing allocated to refund against
    await commonLaws(t.db);
  });
  it("a second paid payment for the same order is held in suspense; sellers are credited once", async () => {
    const { order, pi } = await t.paidOrder();
    const dup = t.fake.extraPayment(order.id, 1000n);
    await t.hook(t.payEvent(dup));
    await t.hook(t.payEvent(dup));
    await t.drain();
    expect(await acct(t.db, "provider:clearing")).toBe(2000n);
    expect(await acct(t.db, "platform:unallocated_receipts")).toBe(-1000n);
    expect(await acct(t.db, "seller:seller_a")).toBe(-540n);
    expect(await acct(t.db, "seller:seller_b")).toBe(-360n);
    expect(await n("SELECT count(*) c FROM allocations")).toBe(2);
    // the first payment's lines still refund against the first payment only
    expect((await t.refund(order.id, `${order.id}_l1`, 600)).status).toBe(200);
    expect(t.fake.liveRefunded(pi)).toBe(600n);
    await commonLaws(t.db);
  });
  it("a payment snapshot in a different currency is refused and books nothing", async () => {
    const { order, pi } = await t.checkedOut();
    t.fake.pay(pi);
    (t.fake.payments.get(pi) as { currency: string }).currency = "USD";
    await t.hook(t.payEvent(pi));
    await t.drain();
    expect(await n("SELECT count(*) c FROM ledger_entries")).toBe(0);
    expect(await t.status(order.id)).toBe("pending_payment");
  });
  it("a payment cannot move backwards: a later 'requires_capture' or 'pending' snapshot never undoes success", async () => {
    const { order, pi } = await t.paidOrder();
    (t.fake.payments.get(pi) as { status: string }).status = "requires_capture";
    await t.hook(t.payEvent(pi));
    await t.drain();
    expect((await t.one("SELECT status FROM payments WHERE provider_ref=$1", [pi])).status).toBe("succeeded");
    expect(await t.status(order.id)).toBe("paid");
    expect(await n("SELECT count(*) c FROM ledger_entries WHERE kind='sale'")).toBe(3);
  });
});

describe("checkout", () => {
  it("concurrent double submit creates one provider payment", async () => {
    const order = await t.newOrder();
    const rs = await Promise.all(Array.from({ length: 6 }, () => t.post(`/orders/${order.id}/checkout`)));
    expect(t.fake.calls.createPayment).toBe(1);
    expect(rs.some((r) => r.status === 200)).toBe(true);
    for (const r of rs) expect([200, 502]).toContain(r.status);
    expect(t.fake.payments.size).toBe(1);
  });
  it("a lost create response never authorises a second create; the payment notice later binds the existing one", async () => {
    const order = await t.newOrder();
    t.fake.fault("createPayment", "apply_then_unknown");
    expect((await t.post(`/orders/${order.id}/checkout`)).status).toBe(502);
    t.fake.idem.clear(); // provider idempotency retention has passed
    expect((await t.post(`/orders/${order.id}/checkout`)).status).toBe(502);
    expect(t.fake.calls.createPayment).toBe(1);
    expect(t.fake.payments.size).toBe(1);
    const [pi] = [...t.fake.payments.keys()] as string[];
    t.fake.pay(pi as string);
    await t.hook(t.payEvent(pi as string));
    await t.drain();
    expect(await t.status(order.id)).toBe("paid");
    expect((await t.one("SELECT payment_ref p FROM orders WHERE id=$1", [order.id])).p).toBe(pi);
    expect(await n("SELECT count(*) c FROM ledger_entries WHERE kind='sale'")).toBe(3);
    await commonLaws(t.db);
  });
  it("refuses to check out an order that is already paid", async () => {
    const { order } = await t.paidOrder();
    expect((await t.post(`/orders/${order.id}/checkout`)).status).toBe(409);
  });
});

describe("manual capture", () => {
  it("captures once; a repeat or a notice adds nothing", async () => {
    const { order, pi } = await t.checkedOut(undefined, "manual");
    t.fake.authorize(pi);
    await t.hook(t.payEvent(pi));
    await t.drain();
    expect(await t.status(order.id)).toBe("authorized");
    expect((await t.post(`/orders/${order.id}/capture`)).body.status).toBe("paid");
    expect((await t.post(`/orders/${order.id}/capture`)).body.status).toBe("paid");
    expect(t.fake.calls.capture).toBe(1);
    expect(await n("SELECT count(*) c FROM ledger_entries WHERE kind='sale'")).toBe(3);
    await commonLaws(t.db);
  });
  it("capture applied but response lost (S06): reconciled from the provider, never captured twice", async () => {
    const { order, pi } = await t.checkedOut(undefined, "manual");
    t.fake.authorize(pi);
    t.fake.fault("capture", "apply_then_unknown");
    expect((await t.post(`/orders/${order.id}/capture`)).status).toBe(502);
    expect(await n("SELECT count(*) c FROM jobs WHERE type='reconcile_payment'")).toBe(1);
    await t.drain();
    expect(await t.status(order.id)).toBe("paid");
    expect((await t.post(`/orders/${order.id}/capture`)).body.status).toBe("paid");
    expect(t.fake.calls.capture).toBe(1);
    expect(await n("SELECT count(*) c FROM ledger_entries WHERE kind='sale'")).toBe(3);
  });
  it("capture refused or failed before applying leaves the order authorised and books nothing", async () => {
    const { order, pi } = await t.checkedOut(undefined, "manual");
    t.fake.authorize(pi);
    t.fake.fault("capture", "before_unknown");
    expect((await t.post(`/orders/${order.id}/capture`)).status).toBe(502);
    await t.drain();
    expect(await t.status(order.id)).toBe("authorized");
    expect(await n("SELECT count(*) c FROM ledger_entries")).toBe(0);
    t.fake.fault("capture", "before_rejected");
    expect((await t.post(`/orders/${order.id}/capture`)).status).toBe(409);
    expect(await n("SELECT count(*) c FROM ledger_entries")).toBe(0);
  });
  it("capture of an unpaid order with nothing authorised is refused", async () => {
    const { order } = await t.checkedOut(undefined, "manual");
    expect((await t.post(`/orders/${order.id}/capture`)).status).toBe(409);
  });
});

describe("order validation", () => {
  it.each([[10.5], [-1], [0], ["0"], ["1e3"], ["12.5"], [null], [true], [Number.MAX_SAFE_INTEGER + 2], ["9".repeat(30)], ["1000000000000"]])("rejects line amount %s", async (amount) => {
    const r = await t.post("/orders", { lines: [{ seller_id: "seller_a", amount }] });
    expect(r.status).toBe(400);
    expect(await n("SELECT count(*) c FROM orders")).toBe(0);
  });
  it("rejects unknown sellers, bad currency, bad capture mode, empty and oversized orders; stores nothing", async () => {
    const line = { seller_id: "seller_a", amount: 10 };
    expect((await t.post("/orders", { lines: [{ seller_id: "ghost", amount: 10 }] })).status).toBe(400);
    expect((await t.post("/orders", { currency: "RUPEE", lines: [line] })).status).toBe(400);
    expect((await t.post("/orders", { capture: "sometimes", lines: [line] })).status).toBe(400);
    expect((await t.post("/orders", { lines: [] })).status).toBe(400);
    expect((await t.post("/orders", { lines: Array.from({ length: 21 }, () => line) })).status).toBe(400);
    expect((await t.post("/orders", { lines: [{ seller_id: "seller_a", amount: "999999999999" }, line] })).status).toBe(400);
    expect(await n("SELECT count(*) c FROM orders")).toBe(0);
    expect(await n("SELECT count(*) c FROM order_lines")).toBe(0);
  });
});

describe("job queue", () => {
  const mk = (handlers: Partial<Record<string, (p: Record<string, string>) => Promise<void>>>, maxAttempts = 3) =>
    new Queue(t.db, { payment: async () => {}, refund: async () => {}, resolve_refund_request: async () => {}, reconcile_payment: async () => {}, ...handlers } as never, { maxAttempts: { default: maxAttempts } });
  it("retries a failing job with backoff, then parks it as failed; a redelivery of a failed job queues it again, of a done job does not", async () => {
    let runs = 0;
    const q = mk({ payment: async () => { runs++; throw new Error("boom"); } });
    await enqueue(t.db, "payment", { ref: "x" }, "k1");
    for (let i = 0; i < 4; i++) {
      await q.runOnce();
      await t.forceDue();
    }
    expect(runs).toBe(3);
    expect((await t.one("SELECT state, attempts FROM jobs")).state).toBe("failed");
    await enqueue(t.db, "payment", { ref: "x" }, "k1");
    expect((await t.one("SELECT state, attempts FROM jobs")).state).toBe("queued");
    expect(await n("SELECT count(*) c FROM jobs")).toBe(1);
    const ok = mk({});
    await ok.runOnce();
    await enqueue(t.db, "payment", { ref: "x" }, "k1");
    expect((await t.one("SELECT state FROM jobs")).state).toBe("done");
    expect(backoffMs(1)).toBeLessThan(backoffMs(3));
    expect(backoffMs(50)).toBeLessThanOrEqual(2000);
  });
  it("two workers racing for one job run it once (SKIP LOCKED)", async () => {
    let runs = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const slow = async () => { runs++; await gate; };
    const a = mk({ payment: slow });
    const b = mk({ payment: slow });
    await enqueue(t.db, "payment", { ref: "x" }, "k2");
    const ra = a.runOnce();
    const rb = b.runOnce();
    await new Promise((r) => setTimeout(r, 150));
    release();
    const res = await Promise.all([ra, rb]);
    expect(res.filter(Boolean)).toHaveLength(1);
    expect(runs).toBe(1);
  });
  it("a job left running by a crashed process is re-queued on startup and runs once more", async () => {
    await enqueue(t.db, "payment", { ref: "x" }, "k3");
    await t.db.query("UPDATE jobs SET state='running'");
    let runs = 0;
    const q = mk({ payment: async () => { runs++; } });
    expect(await q.runOnce()).toBe(false);
    expect(await q.recover()).toBe(1);
    expect(await q.runOnce()).toBe(true);
    expect(runs).toBe(1);
  });
  it("a payment job that throws midway leaves no partial ledger (atomic per transaction)", async () => {
    const { pi } = await t.checkedOut();
    t.fake.pay(pi);
    (t.fake.payments.get(pi) as { currency: string }).currency = "USD";
    await t.hook(t.payEvent(pi));
    await t.drain();
    expect(await n("SELECT count(*) c FROM ledger_entries")).toBe(0);
    expect((await t.one("SELECT status FROM payments WHERE provider_ref=$1", [pi])).status).toBe("pending");
  });
});
