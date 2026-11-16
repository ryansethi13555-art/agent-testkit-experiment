// worker-marketplace: webhook -> durable job -> reconciliation of payments; retries, crashes, ordering, suspense.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { FakeStripe } from "./helpers/fakeStripe.ts";
import { startWorkerApp, type WorkerT } from "./helpers/workerApp.ts";

const fake = new FakeStripe();
let t: WorkerT;
beforeAll(async () => {
  await fake.start();
  t = await startWorkerApp(fake);
});
afterAll(async () => {
  await t?.stop();
  await fake.stop();
});
beforeEach(async () => {
  await t.reset();
});
const saleRows = () => t.q("SELECT account, amount::text a, effect_ref FROM ledger_entries WHERE kind IN ('sale','commission','suspense')");

describe("sale recognition via the queue", () => {
  it("books the capture once with exact seller/commission split and persists the allocation", async () => {
    const o = await t.newOrder({ lines: [{ seller_id: "seller_a", amount: 25 }, { seller_id: "seller_b", amount: 35 }, { seller_id: "seller_a", amount: 5 }], paid: true });
    expect(await t.balance("provider:clearing")).toBe(65n);
    // commissions: 25 -> 2 (half-even), 35 -> 4, 5 -> 0
    expect(await t.balance("platform:commission")).toBe(-6n);
    expect(await t.balance("seller:seller_a")).toBe(-((25n - 2n) + 5n));
    expect(await t.balance("seller:seller_b")).toBe(-(35n - 4n));
    expect(await t.orderStatus(o.id)).toBe("paid");
    const alloc = await t.q("SELECT amount::text a, seller_amount::text s, commission_amount::text c FROM allocations ORDER BY id");
    expect(alloc.map((a) => `${a.a}/${a.s}/${a.c}`)).toEqual(["25/23/2", "35/31/4", "5/5/0"]);
    await t.assertSound();
  });

  it("acknowledges a valid webhook only after the job is durably stored, and drops exact duplicate event ids", async () => {
    const o = await t.newOrder();
    fake.pay(o.pi);
    const ev = t.payEvent(o.pi);
    const rs = await Promise.all(Array.from({ length: 6 }, () => t.deliver(ev)));
    expect(rs.map((r) => r.status)).toEqual(Array(6).fill(200));
    expect((await t.q("SELECT 1 FROM jobs")).length).toBe(1);
    // redelivery after the job already ran
    await t.drain();
    expect((await t.deliver(ev)).status).toBe(200);
    await t.drain();
    expect(await t.balance("provider:clearing")).toBe(1000n);
    expect((await saleRows()).length).toBe(5);
    await t.assertSound();
  });

  it("an invalid signature is rejected and stores no job", async () => {
    const o = await t.newOrder();
    fake.pay(o.pi);
    const ev = t.payEvent(o.pi);
    expect((await t.post("/webhooks/stripe", ev.payload, { "stripe-signature": "t=1,v1=abc" })).status).toBe(400);
    expect((await t.post("/webhooks/stripe", ev.payload)).status).toBe(400);
    expect((await t.q("SELECT 1 FROM jobs")).length).toBe(0);
  });

  it("when the job store is unavailable the webhook is NOT acknowledged (so the provider redelivers)", async () => {
    const o = await t.newOrder();
    fake.pay(o.pi);
    const ev = t.payEvent(o.pi);
    await t.q("ALTER TABLE jobs RENAME TO jobs_gone");
    try {
      const r = await t.deliver(ev);
      expect(r.status).toBeGreaterThanOrEqual(500);
    } finally {
      await t.q("ALTER TABLE jobs_gone RENAME TO jobs");
    }
    expect((await t.deliver(ev)).status).toBe(200);
    await t.drain();
    expect(await t.balance("provider:clearing")).toBe(1000n);
  });

  it("state comes from the provider object, not the webhook body: a lying success event books nothing", async () => {
    const o = await t.newOrder();
    const lie = fake.signedEvent("payment_intent.succeeded", { ...fake.pis.get(o.pi)!, status: "succeeded", amount_received: 1000 });
    expect((await t.deliver(lie)).status).toBe(200);
    await t.drain();
    expect((await t.q("SELECT 1 FROM ledger_entries")).length).toBe(0);
    expect(await t.orderStatus(o.id)).toBe("pending_payment");
  });

  it("concurrent workers, duplicate events with different ids and the confirm endpoint book the sale once", async () => {
    const o = await t.newOrder();
    fake.pay(o.pi);
    for (let i = 0; i < 4; i++) await t.deliver(t.payEvent(o.pi, "payment_intent.succeeded", `evt_dup${i}`));
    await Promise.all([
      ...Array.from({ length: 4 }, () => t.app.worker.runOnce()),
      t.post(`/orders/${o.id}/confirm`, {}),
      t.post(`/orders/${o.id}/confirm`, {}),
    ]);
    await t.drain();
    expect(await t.balance("provider:clearing")).toBe(1000n);
    expect((await saleRows()).length).toBe(5);
    expect((await t.q("SELECT 1 FROM allocations")).length).toBe(2);
    await t.assertSound();
  });

  it("a stale or regressed provider snapshot cannot undo or re-book a captured payment", async () => {
    const o = await t.newOrder({ paid: true });
    fake.pis.get(o.pi)!.status = "requires_payment_method"; // an old replica answers
    await t.deliver(t.payEvent(o.pi, "payment_intent.processing", "evt_stale"));
    await t.drain();
    expect(await t.orderStatus(o.id)).toBe("paid");
    expect(await t.balance("provider:clearing")).toBe(1000n);
    expect((await saleRows()).length).toBe(5);
    await t.assertSound();
  });
});

describe("money that does not match the order goes to suspense, never to sellers", () => {
  it("a partial capture is not allocated to sellers and does not mint money", async () => {
    const o = await t.newOrder();
    fake.pay(o.pi, { captured: 700n });
    await t.deliver(t.payEvent(o.pi));
    await t.drain();
    expect(await t.balance("seller:seller_a")).toBe(0n);
    expect(await t.balance("seller:seller_b")).toBe(0n);
    expect(await t.balance("provider:clearing")).toBe(700n);
    expect(await t.balance("platform:unallocated_receipts")).toBe(-700n);
    expect((await t.q("SELECT 1 FROM allocations")).length).toBe(0);
    // seller money that was never allocated cannot be refunded to a seller line
    const r = await t.post(`/orders/${o.id}/refunds`, { line_id: o.lines[0], amount: 100 });
    expect(r.status).toBeGreaterThanOrEqual(400);
    expect(fake.posts(/refunds$/).length).toBe(0);
    await t.assertSound();
  });

  it("a second captured payment for an already paid order is not allocated twice", async () => {
    const o = await t.newOrder({ paid: true });
    fake.pis.set("pi_rogue", { id: "pi_rogue", object: "payment_intent", amount: 1000, amount_received: 1000, currency: "inr", status: "succeeded", capture_method: "automatic", metadata: { order_id: o.id }, client_secret: "x", last_payment_error: null });
    await t.deliver(t.payEvent("pi_rogue"));
    await t.drain();
    expect(await t.balance("seller:seller_a")).toBe(-540n);
    expect(await t.balance("seller:seller_b")).toBe(-360n);
    expect(await t.balance("provider:clearing")).toBe(2000n);
    expect(await t.balance("platform:unallocated_receipts")).toBe(-1000n);
    expect((await t.q("SELECT 1 FROM allocations")).length).toBe(2);
    await t.assertSound();
  });

  it("a payment in another currency than the order is rejected (job fails), nothing booked", async () => {
    const o = await t.newOrder();
    fake.pay(o.pi);
    fake.pis.get(o.pi)!.currency = "usd";
    await t.deliver(t.payEvent(o.pi));
    await t.drain(1500);
    expect((await t.q("SELECT 1 FROM ledger_entries")).length).toBe(0);
    expect(await t.orderStatus(o.id)).toBe("pending_payment");
  });

  it("an object that is not ours is ignored without booking", async () => {
    fake.pis.set("pi_foreign", { id: "pi_foreign", object: "payment_intent", amount: 500, amount_received: 500, currency: "inr", status: "succeeded", metadata: {}, client_secret: "x", last_payment_error: null });
    await t.deliver(t.payEvent("pi_foreign"));
    await t.drain();
    expect((await t.q("SELECT 1 FROM ledger_entries")).length).toBe(0);
    expect((await t.q("SELECT state FROM jobs"))[0].state).toBe("done");
  });
});

describe("retries and crashes", () => {
  it("a job that hits provider 5xx is retried and applies exactly once", async () => {
    const o = await t.newOrder();
    fake.pay(o.pi);
    fake.addFault({ method: "GET", path: /payment_intents\/\w+$/, mode: "500-before", times: 6 });
    await t.deliver(t.payEvent(o.pi));
    await t.drain(15000);
    expect((await t.q("SELECT state, attempts FROM jobs"))[0]).toMatchObject({ state: "done" });
    expect((await t.q("SELECT attempts FROM jobs"))[0].attempts).toBeGreaterThan(1);
    expect(await t.balance("provider:clearing")).toBe(1000n);
    await t.assertSound();
  });

  it("a dead-lettered job is re-queued when the provider redelivers the same event", async () => {
    const o = await t.newOrder();
    fake.pay(o.pi);
    const ev = t.payEvent(o.pi, "payment_intent.succeeded", "evt_dead");
    await t.deliver(ev);
    await t.q("UPDATE jobs SET state='failed', attempts=25, last_error='boom'");
    expect((await t.deliver(ev)).status).toBe(200);
    expect((await t.q("SELECT state FROM jobs"))[0].state).toBe("queued");
    await t.drain();
    expect(await t.balance("provider:clearing")).toBe(1000n);
    expect((await t.q("SELECT count(*)::int c FROM jobs"))[0].c).toBe(1);
  });

  it("a crash with a job 'running' is recovered; a crash AFTER the money was booked does not book twice", async () => {
    const o = await t.newOrder();
    fake.pay(o.pi);
    await t.deliver(t.payEvent(o.pi));
    // process claimed the job, applied the effect, died before marking it done
    await t.q("UPDATE jobs SET state='running', attempts=1");
    await t.app.shop.onPaymentJob(o.pi);
    const app2 = await t.restart();
    await app2.start();
    await app2.stop();
    await t.restart();
    expect(await t.app.worker.recover()).toBeGreaterThanOrEqual(0);
    await t.drain();
    expect((await t.q("SELECT state FROM jobs"))[0].state).toBe("done");
    expect(await t.balance("provider:clearing")).toBe(1000n);
    expect((await saleRows()).length).toBe(5);
    await t.assertSound();
  });
});

describe("checkout and capture", () => {
  it("concurrent checkouts create one provider payment; a lost create response never creates a second", async () => {
    const o = await t.post("/orders", { lines: [{ seller_id: "seller_a", amount: 500 }] });
    const rs = await Promise.all(Array.from({ length: 6 }, () => t.post(`/orders/${o.body.id}/checkout`, {})));
    expect(fake.posts(/payment_intents$/).length).toBe(1);
    for (const r of rs) expect([200, 502]).toContain(r.status);

    const o2 = await t.post("/orders", { lines: [{ seller_id: "seller_a", amount: 800 }] });
    fake.addFault({ method: "POST", path: /payment_intents$/, mode: "drop-after-apply", times: 1 });
    expect((await t.post(`/orders/${o2.body.id}/checkout`, {})).status).toBe(502);
    fake.idem.clear(); // key retention window elapsed
    expect((await t.post(`/orders/${o2.body.id}/checkout`, {})).status).toBe(502);
    expect(fake.posts(/payment_intents$/).length).toBe(2); // one per order, none duplicated
    // the provider event (metadata names the order) recovers the identity and books once
    const pi = [...fake.pis.values()].find((p) => p.metadata.order_id === o2.body.id)!;
    fake.pay(pi.id);
    await t.deliver(t.payEvent(pi.id));
    await t.drain();
    expect((await t.q("SELECT payment_ref FROM orders WHERE id=$1", [o2.body.id]))[0].payment_ref).toBe(pi.id);
    expect(await t.orderStatus(o2.body.id)).toBe("paid");
    expect(await t.balance("provider:clearing")).toBe(800n);
    await t.assertSound();
  });

  it("manual capture: a lost capture response is reconciled by the queue and booked once", async () => {
    const o = await t.newOrder({ capture: "manual" });
    fake.pay(o.pi);
    await t.deliver(t.payEvent(o.pi, "payment_intent.amount_capturable_updated"));
    await t.drain();
    expect(await t.orderStatus(o.id)).toBe("authorized");
    expect((await t.q("SELECT 1 FROM ledger_entries")).length).toBe(0);
    fake.addFault({ method: "POST", path: /capture$/, mode: "drop-after-apply", times: 10 });
    expect((await t.post(`/orders/${o.id}/capture`, {})).status).toBe(502);
    expect(fake.pis.get(o.pi)!.status).toBe("succeeded");
    fake.faults = [];
    await t.drain();
    expect(await t.orderStatus(o.id)).toBe("paid");
    // repeated / concurrent captures are harmless
    await Promise.all([t.post(`/orders/${o.id}/capture`, {}), t.post(`/orders/${o.id}/capture`, {})]);
    await t.drain();
    expect(await t.balance("provider:clearing")).toBe(1000n);
    expect((await saleRows()).length).toBe(5);
    await t.assertSound();
  });
});

describe("input safety", () => {
  it.each([["fraction", 1.5], ["negative", -1], ["string fraction", "2.5"], ["exponent", "1e3"], ["huge", "99999999999999999999"], ["zero", 0], ["bool", true]])(
    "rejects a %s amount",
    async (_n, amount) => {
      expect((await t.post("/orders", { lines: [{ seller_id: "seller_a", amount }] })).status).toBe(400);
      expect((await t.q("SELECT 1 FROM orders")).length).toBe(0);
    },
  );
  it("rejects unknown sellers, bad currencies and oversized orders", async () => {
    expect((await t.post("/orders", { lines: [{ seller_id: "nobody", amount: 5 }] })).status).toBe(400);
    expect((await t.post("/orders", { currency: "XX", lines: [{ seller_id: "seller_a", amount: 5 }] })).status).toBe(400);
    expect((await t.post("/orders", { lines: [{ seller_id: "seller_a", amount: "999999999999" }, { seller_id: "seller_a", amount: 1 }] })).status).toBe(400);
    expect((await t.q("SELECT 1 FROM orders")).length).toBe(0);
  });
});
