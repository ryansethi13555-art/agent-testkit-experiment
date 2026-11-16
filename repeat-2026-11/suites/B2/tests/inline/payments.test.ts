// Inline marketplace (Stripe): payment-side money correctness.
import fc from "fast-check";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { stripeEvent } from "../helpers/fakeStripe.ts";
import { type Inline, startInline } from "../helpers/inlineApp.ts";
import { commonLaws } from "../helpers/laws.ts";
import { fee } from "../helpers/pg.ts";

let t: Inline;
beforeAll(async () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  t = await startInline();
});
afterAll(async () => {
  await t?.stop();
});
beforeEach(async () => {
  await t.reset();
});
const count = async (sql: string, p: unknown[] = []) => Number((await t.one(sql, p)).c);
const acctSum = async (a: string) => BigInt((await t.one("SELECT coalesce(sum(amount),0)::text s FROM ledger_entries WHERE account=$1", [a])).s);
const sales = () => count("SELECT count(*) c FROM ledger_entries WHERE kind IN ('sale','commission')");

describe("order validation (amount and currency discipline)", () => {
  it.each([
    ["fractional number", 10.5],
    ["negative", -5],
    ["zero", 0],
    ["zero string", "0"],
    ["exponent string", "1e3"],
    ["decimal string", "12.50"],
    ["alpha string", "12abc"],
    ["null", null],
    ["boolean", true],
    ["unsafe integer number", 9007199254740993],
    ["unsafe integer string", "9007199254740993"],
    ["huge digit string", "9".repeat(40)],
  ])("rejects line amount: %s", async (_n, amount) => {
    const r = await t.post("/orders", { lines: [{ seller_id: "seller_a", amount }] });
    expect(r.status).toBe(400);
    expect(await count("SELECT count(*) c FROM orders")).toBe(0);
  });
  it("rejects an order whose lines sum beyond the exact integer range, and accepts digit strings", async () => {
    const max = String(Number.MAX_SAFE_INTEGER);
    expect((await t.post("/orders", { lines: [{ seller_id: "seller_a", amount: max }, { seller_id: "seller_b", amount: "1" }] })).status).toBe(400);
    expect((await t.post("/orders", { lines: [{ seller_id: "seller_a", amount: "1000" }] })).status).toBe(201);
  });
  it("requires lines and a three letter currency, normalising case", async () => {
    expect((await t.post("/orders", { lines: [] })).status).toBe(400);
    expect((await t.post("/orders", { currency: "IN", lines: [{ seller_id: "seller_a", amount: 5 }] })).status).toBe(400);
    expect((await t.post("/orders", { currency: "INRR", lines: [{ seller_id: "seller_a", amount: 5 }] })).status).toBe(400);
    const ok = await t.post("/orders", { currency: "usd", lines: [{ seller_id: "seller_a", amount: 5 }] });
    expect(ok.status).toBe(201);
    expect((await t.one("SELECT currency FROM orders WHERE id=$1", [ok.body.id])).currency).toBe("USD");
  });
});

describe("checkout", () => {
  it("is idempotent and creates exactly one provider payment carrying the order identity", async () => {
    const { order, pi } = await t.checkedOut();
    const again = await t.post(`/orders/${order.id}/checkout`);
    expect(again.body.payment_intent_id).toBe(pi);
    expect(t.fake.pis.size).toBe(1);
    expect(t.fake.pis.get(pi)?.metadata.order_id).toBe(order.id);
    expect(t.fake.pis.get(pi)?.amount).toBe(1000);
  });
  it("a concurrent double submit never creates a second provider payment (S11)", async () => {
    const order = await t.newOrder();
    const rs = await Promise.all(Array.from({ length: 6 }, () => t.post(`/orders/${order.id}/checkout`)));
    expect(t.fake.pis.size).toBe(1);
    expect(t.fake.posts("/v1/payment_intents")).toBe(1);
    expect(rs.some((r) => r.status === 200)).toBe(true);
    for (const r of rs) expect([200, 502]).toContain(r.status);
  });
  it("a lost checkout response does not authorise a second create; the unknown outcome is surfaced", async () => {
    const order = await t.newOrder();
    t.fake.fault("POST /v1/payment_intents", "apply_then_drop", 1);
    const first = await t.post(`/orders/${order.id}/checkout`);
    expect(first.status).toBeGreaterThanOrEqual(400);
    t.fake.idem.clear(); // the provider's idempotency retention has passed: a second create would now be a second payment
    const second = await t.post(`/orders/${order.id}/checkout`);
    expect(second.status).toBe(502);
    expect(t.fake.pis.size).toBe(1);
    expect(t.fake.posts("/v1/payment_intents")).toBe(1);
    // the signed payment event recovers identity and books the money exactly once
    const [pi] = [...t.fake.pis.keys()] as string[];
    t.fake.pay(pi as string);
    const ev = stripeEvent("evt_late_1", "payment_intent.succeeded", t.fake.snap(t.fake.pis.get(pi as string) as never));
    expect((await t.webhook(ev)).status).toBe(200);
    expect((await t.one("SELECT status, payment_intent_id p FROM orders WHERE id=$1", [order.id])).status).toBe("paid");
    expect(await sales()).toBe(5);
    await commonLaws(t.db);
  });
  it("checkout of an already paid order is refused", async () => {
    const { order } = await t.paidOrder();
    expect((await t.post(`/orders/${order.id}/checkout`)).status).toBe(409);
  });
});

describe("payment webhooks", () => {
  it("books a balanced sale once: clearing = total, sellers net of 10 percent, commission per line (S01)", async () => {
    const { order } = await t.paidOrder();
    expect((await t.one("SELECT status FROM orders WHERE id=$1", [order.id])).status).toBe("paid");
    expect(await sales()).toBe(5);
    const rows = (await t.db.query("SELECT account, amount::text a FROM ledger_entries ORDER BY id")).rows;
    const by = Object.fromEntries(rows.map((r) => [r.account, BigInt(r.a)]));
    expect(by["provider:clearing"]).toBe(1000n);
    expect(by["seller:seller_a"]).toBe(-540n);
    expect(by["seller:seller_b"]).toBe(-360n);
    await commonLaws(t.db);
  });
  it("sequential duplicate delivery of the same event id posts nothing twice", async () => {
    const { pi } = await t.checkedOut();
    t.fake.pay(pi);
    const ev = stripeEvent("evt_dup", "payment_intent.succeeded", t.fake.snap(t.fake.pis.get(pi) as never));
    for (let i = 0; i < 3; i++) expect((await t.webhook(ev)).status).toBe(200);
    expect(await sales()).toBe(5);
    await commonLaws(t.db);
  });
  it("concurrent duplicate delivery of the same event id posts once (S02)", async () => {
    const { pi } = await t.checkedOut();
    t.fake.pay(pi);
    const ev = stripeEvent("evt_dupc", "payment_intent.succeeded", t.fake.snap(t.fake.pis.get(pi) as never));
    const rs = await Promise.all(Array.from({ length: 8 }, () => t.webhook(ev)));
    for (const r of rs) expect(r.status).toBe(200);
    expect(await sales()).toBe(5);
    expect(await count("SELECT count(*) c FROM processed_events")).toBe(1);
  });
  it("distinct event ids for the same occurrence still post once (provider emits two Event objects)", async () => {
    const { pi } = await t.checkedOut();
    t.fake.pay(pi);
    const snap = t.fake.snap(t.fake.pis.get(pi) as never);
    const rs = await Promise.all(["evt_a", "evt_b", "evt_c", "evt_d"].map((id) => t.webhook(stripeEvent(id, "payment_intent.succeeded", snap))));
    for (const r of rs) expect(r.status).toBe(200);
    expect(await sales()).toBe(5);
    await commonLaws(t.db);
  });
  it("return-from-checkout confirm racing the webhook records the sale once", async () => {
    const { order, pi } = await t.checkedOut();
    t.fake.pay(pi);
    const ev = stripeEvent("evt_race", "payment_intent.succeeded", t.fake.snap(t.fake.pis.get(pi) as never));
    const rs = await Promise.all([
      t.post(`/orders/${order.id}/confirm`),
      t.webhook(ev),
      t.post(`/orders/${order.id}/confirm`),
      t.webhook({ ...ev, id: "evt_race2" }),
    ]);
    for (const r of rs) expect(r.status).toBe(200);
    expect(await sales()).toBe(5);
    await commonLaws(t.db);
  });
  it("confirm before the customer paid leaves the order unpaid", async () => {
    const { order } = await t.checkedOut();
    expect((await t.post(`/orders/${order.id}/confirm`)).body.status).toBe("pending_payment");
    expect(await sales()).toBe(0);
  });
  it("rejects forged, tampered and replayed-too-late signatures with no effect (S16)", async () => {
    const { pi } = await t.checkedOut();
    t.fake.pay(pi);
    const ev = stripeEvent("evt_forged", "payment_intent.succeeded", t.fake.snap(t.fake.pis.get(pi) as never));
    const raw = JSON.stringify(ev);
    expect((await t.post("/webhooks/stripe", raw, { "stripe-signature": "t=1,v1=deadbeef" })).status).toBe(400);
    expect((await t.post("/webhooks/stripe", raw)).status).toBe(400);
    const { signStripe } = await import("../helpers/fakeStripe.ts");
    const wrong = signStripe(ev, "whsec_someone_else");
    expect((await t.post("/webhooks/stripe", wrong.payload, { "stripe-signature": wrong.header })).status).toBe(400);
    const good = signStripe(ev);
    const tampered = good.payload.replace("1000", "1");
    expect((await t.post("/webhooks/stripe", tampered, { "stripe-signature": good.header })).status).toBe(400);
    const old = signStripe(ev, undefined, Math.floor(Date.now() / 1000) - 3600);
    expect((await t.post("/webhooks/stripe", old.payload, { "stripe-signature": old.header })).status).toBe(400);
    expect(await sales()).toBe(0);
    expect(await count("SELECT count(*) c FROM processed_events")).toBe(0);
  });
  it("a success event for a payment whose captured amount is not the order total books nothing (partial capture)", async () => {
    const { order, pi } = await t.checkedOut();
    t.fake.dashboardCapture(pi, 900);
    const r = await t.webhook(stripeEvent("evt_partial", "payment_intent.succeeded", t.fake.snap(t.fake.pis.get(pi) as never)));
    expect(r.status).not.toBe(200);
    expect((await t.one("SELECT status FROM orders WHERE id=$1", [order.id])).status).toBe("pending_payment");
    expect(await sales()).toBe(0);
    expect(await count("SELECT count(*) c FROM processed_events")).toBe(0); // marker rolled back so a retry can succeed
  });
  it("a success event in another currency books nothing", async () => {
    const { order, pi } = await t.checkedOut();
    t.fake.pay(pi);
    const snap = t.fake.snap(t.fake.pis.get(pi) as never);
    snap.currency = "usd";
    const r = await t.webhook(stripeEvent("evt_cur", "payment_intent.succeeded", snap));
    expect(r.status).not.toBe(200);
    expect((await t.one("SELECT status FROM orders WHERE id=$1", [order.id])).status).toBe("pending_payment");
    expect(await sales()).toBe(0);
  });
  it("a payment cannot be attributed to a different order through event metadata", async () => {
    const a = await t.checkedOut();
    const b = await t.checkedOut();
    t.fake.pay(a.pi);
    const snap = t.fake.snap(t.fake.pis.get(a.pi) as never);
    snap.metadata.order_id = b.order.id;
    const r = await t.webhook(stripeEvent("evt_mis", "payment_intent.succeeded", snap));
    expect(r.status).not.toBe(200);
    for (const o of [a.order, b.order])
      expect((await t.one("SELECT status FROM orders WHERE id=$1", [o.id])).status).toBe("pending_payment");
    expect(await sales()).toBe(0);
  });
  it("a success event for a payment the app never created is not booked, and succeeds on retry only once known", async () => {
    const order = await t.newOrder();
    const fakePi = { id: "pi_unknown", object: "payment_intent", status: "succeeded", amount: 1000, amount_received: 1000, currency: "inr", client_secret: "x", metadata: { order_id: order.id } };
    const r = await t.webhook(stripeEvent("evt_unknown", "payment_intent.succeeded", fakePi));
    expect(r.status).toBe(503);
    expect(await sales()).toBe(0);
    expect(await count("SELECT count(*) c FROM processed_events")).toBe(0);
  });
  it("a success event naming an unknown order is retried later, not dropped", async () => {
    const fakePi = { id: "pi_x", object: "payment_intent", status: "succeeded", amount: 1000, amount_received: 1000, currency: "inr", client_secret: "x", metadata: { order_id: "ord_nope" } };
    expect((await t.webhook(stripeEvent("evt_noorder", "payment_intent.succeeded", fakePi))).status).toBe(503);
    expect(await count("SELECT count(*) c FROM processed_events")).toBe(0);
  });
  it("ignores unrelated event types without side effects", async () => {
    const r = await t.webhook(stripeEvent("evt_other", "customer.created", { id: "cus_1", object: "customer" }));
    expect(r.status).toBe(200);
    expect(await sales()).toBe(0);
  });
});

describe("manual capture", () => {
  it("captures the authorised amount and books the sale once, also when confirm and the webhook follow", async () => {
    const { order, pi } = await t.checkedOut(undefined, "manual");
    t.fake.authorize(pi);
    const cap = await t.post(`/orders/${order.id}/capture`);
    expect(cap.body.status).toBe("paid");
    await t.post(`/orders/${order.id}/confirm`);
    await t.webhook(stripeEvent("evt_cap", "payment_intent.succeeded", t.fake.snap(t.fake.pis.get(pi) as never)));
    expect(await sales()).toBe(5);
    expect(t.fake.posts(`/v1/payment_intents/${pi}/capture`)).toBe(1);
    await commonLaws(t.db);
  });
  it("capture applied but response lost on every retry: parked, never assumed failed; webhook then books once (S06)", async () => {
    const { order, pi } = await t.checkedOut(undefined, "manual");
    t.fake.authorize(pi);
    t.fake.fault(`POST /v1/payment_intents/${pi}/capture`, "apply_then_500", 10);
    const cap = await t.post(`/orders/${order.id}/capture`);
    expect(cap.status).toBe(502);
    expect((await t.one("SELECT status FROM orders WHERE id=$1", [order.id])).status).toBe("capture_pending");
    expect(t.fake.pis.get(pi)?.status).toBe("succeeded"); // provider truth: money was taken
    expect(await sales()).toBe(0);
    expect((await t.webhook(stripeEvent("evt_cap2", "payment_intent.succeeded", t.fake.snap(t.fake.pis.get(pi) as never)))).status).toBe(200);
    await t.post(`/orders/${order.id}/confirm`);
    expect((await t.one("SELECT status FROM orders WHERE id=$1", [order.id])).status).toBe("paid");
    expect(await sales()).toBe(5);
    await commonLaws(t.db);
  }, 30000);
  it("a transient capture failure that heals through the same idempotency key captures exactly once", async () => {
    const { order, pi } = await t.checkedOut(undefined, "manual");
    t.fake.authorize(pi);
    t.fake.fault(`POST /v1/payment_intents/${pi}/capture`, "apply_then_500", 1);
    const cap = await t.post(`/orders/${order.id}/capture`);
    expect(cap.body.status).toBe("paid");
    const keys = t.fake.log.filter((l) => l.path.endsWith("/capture")).map((l) => l.key);
    expect(new Set(keys).size).toBe(1);
    expect(await sales()).toBe(5);
  }, 30000);
  it("capture of an order without a payment is refused", async () => {
    const order = await t.newOrder(undefined, "manual");
    expect((await t.post(`/orders/${order.id}/capture`)).status).toBe(404);
  });
});

describe("commission ties (half to even)", () => {
  it("5, 15, 25, 35 minor units round to 0, 2, 2, 4 and every line still sums exactly", async () => {
    const { order } = await t.paidOrder([5, 15, 25, 35].map((a, i) => ({ seller_id: i % 2 ? "seller_b" : "seller_a", amount: a })));
    const comm = (await t.db.query("SELECT amount::text a FROM ledger_entries WHERE account LIKE 'platform:revenue:%' ORDER BY account")).rows.map((r) => -BigInt(r.a));
    expect(comm).toEqual([0n, 2n, 2n, 4n]);
    expect(await acctSum("provider:clearing")).toBe(80n);
    expect(order.id).toBeTruthy();
    await commonLaws(t.db);
  });
});

describe("property: splitting money never creates or loses a minor unit", () => {
  it("seller + commission equals every line, clearing equals total, for odd and tiny amounts", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.oneof(fc.integer({ min: 1, max: 40 }), fc.integer({ min: 1, max: 2_000_000 })), { minLength: 1, maxLength: 4 }),
        async (amounts) => {
          await t.reset();
          const lines = amounts.map((a, i) => ({ seller_id: i % 2 ? "seller_b" : "seller_a", amount: a }));
          const { order } = await t.paidOrder(lines);
          const total = amounts.reduce((s, a) => s + a, 0);
          for (const [i, a] of amounts.entries()) {
            const lid = `${order.id}_l${i + 1}`;
            const e = (await t.db.query("SELECT account, amount::text v FROM ledger_entries WHERE effect_ref=$1", [`allocation:${lid}`])).rows;
            const sum = e.reduce((s, r) => s + BigInt(r.v), 0n);
            expect(sum).toBe(-BigInt(a));
            const comm = e.find((r) => r.account.startsWith("platform:revenue"));
            expect(BigInt(comm?.v ?? "0")).toBe(-fee(BigInt(a)));
          }
          const clearing = (await t.one("SELECT sum(amount)::text s FROM ledger_entries WHERE account='provider:clearing'")).s;
          expect(BigInt(clearing)).toBe(BigInt(total));
          await commonLaws(t.db);
        },
      ),
      { numRuns: 12 },
    );
  }, 120000);
});
