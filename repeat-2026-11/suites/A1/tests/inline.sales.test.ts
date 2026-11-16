// inline-marketplace: sale recognition, webhook idempotency/ordering, checkout and capture recovery, input safety.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { FakeStripe } from "./helpers/fakeStripe.ts";
import { type Inline, startInline } from "./helpers/inlineApp.ts";

const fake = new FakeStripe();
let t: Inline;
beforeAll(async () => {
  await fake.start();
  t = await startInline(fake);
});
afterAll(async () => {
  await t?.stop();
  await fake.stop();
});
beforeEach(async () => {
  await t.reset();
});
const saleRows = async () => (await t.ledgerRows()).filter((r) => r.kind === "sale" || r.kind === "commission");

describe("sale recognition", () => {
  it("books exactly the captured amount, splitting 10% commission half-even per line, balanced", async () => {
    // fees: 5->0 (0.5 to even 0), 15->2 (1.5 to 2), 25->2 (2.5 to 2), 35->4 (3.5 to 4), 1->0, 999->100
    const amounts = [5, 15, 25, 35, 1, 999];
    const fees = [0n, 2n, 2n, 4n, 0n, 100n];
    const o = await t.newOrder({ lines: amounts.map((amount) => ({ seller_id: "seller_a", amount })), paid: true });
    const rows = await t.ledgerRows();
    const total = amounts.reduce((a, b) => a + b, 0);
    expect(o.total).toBe(BigInt(total));
    expect(await t.balance("provider:clearing")).toBe(BigInt(total));
    for (const [i, line] of o.lines.entries()) {
      const fee = rows.find((r) => r.account === `platform:revenue:${line}`)!;
      expect(BigInt(fee.amount)).toBe(-fees[i]!);
      const net = rows.find((r) => r.account === "seller:seller_a" && r.effect_ref === `allocation:${line}`)!;
      expect(BigInt(net.amount)).toBe(-(BigInt(amounts[i]!) - fees[i]!));
    }
    expect(await t.orderStatus(o.id)).toBe("paid");
    await t.assertLedgerSound();
  });

  it("zero-decimal currency amounts are kept as integers and currency is carried to every ledger row", async () => {
    const o = await t.newOrder({ currency: "jpy", lines: [{ seller_id: "seller_a", amount: 1234 }], paid: true });
    const rows = await t.ledgerRows();
    expect(rows.every((r) => r.currency === "JPY")).toBe(true);
    expect(await t.balance("provider:clearing", "JPY")).toBe(1234n);
    expect(await t.balance("seller:seller_a", "JPY")).toBe(-(1234n - 123n)); // 123.4 -> 123
    expect(await t.orderStatus(o.id)).toBe("paid");
  });
});

describe("webhook delivery (at least once, concurrent, out of order)", () => {
  it("many concurrent deliveries of the same event id book the sale once", async () => {
    const o = await t.newOrder();
    const ev = fake.signedEvent("payment_intent.succeeded", fake.pay(o.pi));
    const rs = await Promise.all(Array.from({ length: 8 }, () => t.deliver(ev)));
    expect(rs.map((r) => r.status)).toEqual(Array(8).fill(200));
    expect((await saleRows()).length).toBe(1 + 2 * 2);
    expect(await t.balance("provider:clearing")).toBe(1000n);
    await t.assertLedgerSound();
  });

  it("different event ids, the return-URL confirm and redelivery together still book once", async () => {
    const o = await t.newOrder();
    const obj = fake.pay(o.pi);
    const jobs = [
      ...Array.from({ length: 3 }, () => t.deliver(fake.signedEvent("payment_intent.succeeded", obj))),
      t.post(`/orders/${o.id}/confirm`, {}),
      t.post(`/orders/${o.id}/confirm`, {}),
    ];
    const rs = await Promise.all(jobs);
    expect(rs.every((r) => r.status === 200)).toBe(true);
    expect(await t.balance("provider:clearing")).toBe(1000n);
    expect((await saleRows()).length).toBe(5);
    // a late redelivery after the acknowledgement was lost
    expect((await t.deliver(fake.signedEvent("payment_intent.succeeded", obj))).status).toBe(200);
    expect((await saleRows()).length).toBe(5);
    await t.assertLedgerSound();
  });

  it("a signed event with a bad signature is rejected and has no effect", async () => {
    const o = await t.newOrder();
    const ev = fake.signedEvent("payment_intent.succeeded", fake.pay(o.pi));
    const r = await t.post("/webhooks/stripe", ev.payload, { "stripe-signature": ev.header.replace(/v1=.{4}/, "v1=0000") });
    expect(r.status).toBe(400);
    expect((await t.ledgerRows()).length).toBe(0);
    expect(await t.orderStatus(o.id)).toBe("pending_payment");
  });

  it("success for an unknown payment is not acknowledged and leaves no dedupe marker (provider will retry)", async () => {
    const ghost = { id: "pi_ghost", object: "payment_intent", amount: 1000, amount_received: 1000, currency: "inr", status: "succeeded", metadata: { order_id: "ord_missing" } };
    const r = await t.deliver(fake.signedEvent("payment_intent.succeeded", ghost, "evt_ghost"));
    expect(r.status).not.toBe(200);
    expect((await t.q("SELECT 1 FROM processed_events")).length).toBe(0);
    expect((await t.ledgerRows()).length).toBe(0);
    const noMeta = { ...ghost, metadata: {} };
    const r2 = await t.deliver(fake.signedEvent("payment_intent.succeeded", noMeta, "evt_ghost2"));
    expect(r2.status).not.toBe(200);
    expect((await t.q("SELECT 1 FROM processed_events")).length).toBe(0);
  });

  it("a failed delivery is retried successfully later with the same event id (marker rolled back with effects)", async () => {
    const o = await t.newOrder();
    const obj = fake.pay(o.pi, { captured: 700n }); // provider reports a partial capture: must not book as a full sale
    const ev = fake.signedEvent("payment_intent.succeeded", obj, "evt_retry");
    const bad = await t.deliver(ev);
    expect(bad.status).not.toBe(200);
    expect((await t.ledgerRows()).length).toBe(0);
    expect(await t.orderStatus(o.id)).toBe("pending_payment");
    // the dedupe marker did not survive the failure, so the same event id can still be applied once the object is right
    expect((await t.q("SELECT 1 FROM processed_events WHERE event_id='stripe:evt_retry'")).length).toBe(0);
    fake.pis.get(o.pi)!.amount_received = 1000;
    const ok = await t.deliver(fake.signedEvent("payment_intent.succeeded", fake.pis.get(o.pi)!, "evt_retry"));
    expect(ok.status).toBe(200);
    expect(await t.balance("provider:clearing")).toBe(1000n);
    await t.assertLedgerSound();
  });

  it("rejects success whose currency, amount or payment identity differs from the order", async () => {
    const o = await t.newOrder();
    const obj = fake.pay(o.pi);
    for (const [i, mut] of [
      { currency: "usd" },
      { amount: 999, amount_received: 999 },
      { amount_received: 1001 },
      { id: "pi_other" },
      { metadata: { order_id: "ord_someoneelse" } },
    ].entries()) {
      const r = await t.deliver(fake.signedEvent("payment_intent.succeeded", { ...obj, ...mut }, `evt_bad${i}`));
      expect(r.status, JSON.stringify(mut)).not.toBe(200);
    }
    expect((await t.ledgerRows()).length).toBe(0);
    expect(await t.orderStatus(o.id)).toBe("pending_payment");
  });

  it("payment_intent.created / amount_capturable_updated observations never book money", async () => {
    const o = await t.newOrder({ capture: "manual" });
    const obj = fake.pay(o.pi); // requires_capture
    expect((await t.deliver(fake.signedEvent("payment_intent.amount_capturable_updated", obj))).status).toBe(200);
    expect((await t.deliver(fake.signedEvent("payment_intent.created", obj))).status).toBe(200);
    expect((await t.ledgerRows()).length).toBe(0);
    expect(await t.orderStatus(o.id)).toBe("pending_payment");
  });
});

describe("checkout", () => {
  it("concurrent checkout submissions create exactly one provider payment", async () => {
    const o = await t.post("/orders", { lines: [{ seller_id: "seller_a", amount: 500 }] });
    const rs = await Promise.all(Array.from({ length: 8 }, () => t.post(`/orders/${o.body.id}/checkout`, {})));
    expect(fake.posts(/payment_intents$/).length).toBe(1);
    expect(fake.pis.size).toBe(1);
    const ok = rs.filter((r) => r.status === 200);
    expect(ok.length).toBeGreaterThanOrEqual(1);
    for (const r of ok) expect(r.body.payment_intent_id).toBe([...fake.pis.keys()][0]);
    for (const r of rs.filter((r) => r.status !== 200)) expect(r.status).toBe(502);
    expect((await t.q("SELECT payment_intent_id FROM orders WHERE id=$1", [o.body.id]))[0].payment_intent_id).toBe([...fake.pis.keys()][0]);
  });

  it("a lost create response never produces a second provider payment; the provider event recovers identity and the sale books once", async () => {
    const o = await t.post("/orders", { lines: [{ seller_id: "seller_a", amount: 800 }] });
    fake.addFault({ method: "POST", path: /payment_intents$/, mode: "drop-after-apply", times: 1 });
    const first = await t.post(`/orders/${o.body.id}/checkout`, {});
    expect(first.status).toBe(502);
    expect(fake.pis.size).toBe(1);
    // a retry (maybe after the idempotency key would have expired) must not create again
    fake.idem.clear();
    for (let i = 0; i < 3; i++) expect((await t.post(`/orders/${o.body.id}/checkout`, {})).status).toBe(502);
    expect(fake.posts(/payment_intents$/).length).toBe(1);
    // the customer pays; provider tells us
    const pi = [...fake.pis.keys()][0]!;
    const obj = fake.pay(pi);
    expect((await t.deliver(fake.signedEvent("payment_intent.succeeded", obj))).status).toBe(200);
    expect(await t.balance("provider:clearing")).toBe(800n);
    expect((await t.q("SELECT payment_intent_id, status FROM orders WHERE id=$1", [o.body.id]))[0]).toMatchObject({ payment_intent_id: pi, status: "paid" });
    await t.assertLedgerSound();
  });

  it("checkout on a paid order is refused and cannot create a second payment", async () => {
    const o = await t.newOrder({ paid: true });
    const r = await t.post(`/orders/${o.id}/checkout`, {});
    expect(r.status).toBe(409);
    expect(fake.posts(/payment_intents$/).length).toBe(1);
  });
});

describe("manual capture", () => {
  it("capture + success webhook + confirm book once", async () => {
    const o = await t.newOrder({ capture: "manual" });
    fake.pay(o.pi); // authorised
    const cap = await t.post(`/orders/${o.id}/capture`, {});
    expect(cap).toMatchObject({ status: 200, body: { status: "paid" } });
    const obj = fake.pis.get(o.pi)!;
    const rs = await Promise.all([
      t.deliver(fake.signedEvent("payment_intent.succeeded", obj)),
      t.post(`/orders/${o.id}/confirm`, {}),
      t.post(`/orders/${o.id}/capture`, {}),
    ]);
    expect(rs.map((r) => r.status)).toEqual([200, 200, 200]);
    expect(await t.balance("provider:clearing")).toBe(1000n);
    expect((await saleRows()).length).toBe(5);
    await t.assertLedgerSound();
  });

  it("a capture whose response is lost parks the order; the webhook later books it once and a repeated capture is a no-op", async () => {
    const o = await t.newOrder({ capture: "manual" });
    fake.pay(o.pi);
    fake.addFault({ method: "POST", path: /capture$/, mode: "drop-after-apply", times: 10 });
    const cap = await t.post(`/orders/${o.id}/capture`, {});
    expect(cap.status).toBe(502);
    expect(await t.orderStatus(o.id)).toBe("capture_pending");
    expect((await t.ledgerRows()).length).toBe(0);
    expect(fake.pis.get(o.pi)!.status).toBe("succeeded"); // the provider did capture
    expect((await t.deliver(fake.signedEvent("payment_intent.succeeded", fake.pis.get(o.pi)!))).status).toBe(200);
    expect(await t.orderStatus(o.id)).toBe("paid");
    fake.faults = [];
    await t.post(`/orders/${o.id}/capture`, {});
    expect(await t.balance("provider:clearing")).toBe(1000n);
    expect((await saleRows()).length).toBe(5);
    await t.assertLedgerSound();
  });

  it("a partial capture is never booked as a full sale", async () => {
    const o = await t.newOrder({ capture: "manual" });
    fake.pay(o.pi);
    fake.pis.get(o.pi)!.status = "requires_capture";
    // provider captures only 700 of 1000
    const r = await fetch(`${fake.base}/v1/payment_intents/${o.pi}/capture`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "amount_to_capture=700" });
    expect(r.status).toBe(200);
    const ev = await t.deliver(fake.signedEvent("payment_intent.succeeded", fake.pis.get(o.pi)!));
    expect(ev.status).not.toBe(200);
    expect((await t.post(`/orders/${o.id}/confirm`, {})).status).not.toBe(200);
    expect((await t.ledgerRows()).length).toBe(0);
    expect(await t.orderStatus(o.id)).not.toBe("paid");
  });
});

describe("input safety", () => {
  it.each([
    ["fraction string", "12.5"],
    ["fraction number", 12.5],
    ["negative", -5],
    ["exponent string", "1e3"],
    ["beyond safe integer string", "9007199254740993"],
    ["beyond safe integer number", 9007199254740993],
    ["boolean", true],
    ["null-ish text", "null"],
    ["zero", 0],
    ["empty", ""],
  ])("rejects a %s line amount without creating money rows", async (_n, amount) => {
    const r = await t.post("/orders", { lines: [{ seller_id: "seller_a", amount }] });
    expect(r.status).toBe(400);
    expect((await t.q("SELECT 1 FROM orders")).length).toBe(0);
    expect((await t.q("SELECT 1 FROM order_lines")).length).toBe(0);
  });
  it("rejects bad currency codes and an overflowing order total", async () => {
    expect((await t.post("/orders", { currency: "RUPEES", lines: [{ seller_id: "seller_a", amount: 100 }] })).status).toBe(400);
    expect((await t.post("/orders", { currency: "", lines: [{ seller_id: "seller_a", amount: 100 }] })).status).not.toBe(201);
    const big = Number.MAX_SAFE_INTEGER;
    expect((await t.post("/orders", { lines: [{ seller_id: "seller_a", amount: big }, { seller_id: "seller_b", amount: big }] })).status).toBe(400);
    expect((await t.q("SELECT 1 FROM orders")).length).toBe(0);
  });
  it("large exact amounts survive the provider round trip without rounding", async () => {
    const amount = 123_456_789_012_345; // < 2^53, > 2^32
    const o = await t.newOrder({ lines: [{ seller_id: "seller_a", amount: String(amount) }], paid: true });
    expect(o.total).toBe(BigInt(amount));
    expect(await t.balance("provider:clearing")).toBe(BigInt(amount));
    await t.assertLedgerSound();
  });
});
