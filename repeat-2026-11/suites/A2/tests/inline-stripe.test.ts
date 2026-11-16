// Money-correctness tests for inline-marketplace (Stripe), driven end to end over HTTP against a real Postgres
// and a fault-injecting fake Stripe server. Nothing here reads the app's own tests.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sleep } from "./helpers/db.ts";
import { FakeStripe } from "./helpers/fake-stripe.ts";
import { bootInline, type Inline, ledgerFacts } from "./helpers/inline-harness.ts";

let fake: FakeStripe;
let h: Inline;

beforeAll(async () => {
  fake = new FakeStripe();
  await fake.listen();
  h = await bootInline({ provider: "stripe", apiBase: fake.base });
});
afterAll(async () => {
  await h?.stop();
  await fake?.close();
});
beforeEach(async () => {
  fake.reset();
  await h.reset();
});

// ------------------------------------------------------------------------------------------------ helpers
const TWO = [
  { seller_id: "seller_a", amount: 600 },
  { seller_id: "seller_b", amount: 400 },
];
async function newOrder(lines: unknown[] = TWO, extra: Record<string, unknown> = {}) {
  const r = await h.post("/orders", { buyer: "b1", currency: "INR", lines, ...extra });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return { id: String(r.body.id), lines: r.body.lines as string[], total: BigInt(String(r.body.total)) };
}
async function checkout(orderId: string) {
  const r = await h.post(`/orders/${orderId}/checkout`);
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return String(r.body.payment_intent_id);
}
const piEvent = (type: string, piId: string, id?: string) =>
  fake.event(type, structuredClone(fake.pis.get(piId)), id);
const refundEvent = (type: string, refundId: string, id?: string) =>
  fake.event(type, structuredClone(fake.refunds.get(refundId)), id);
async function hook(ev: unknown, opts: { secret?: string; timestamp?: number } = {}) {
  const s = FakeStripe.sign(ev, opts);
  return h.post("/webhooks/stripe", s.payload, { "stripe-signature": s.header });
}
async function paid(lines: unknown[] = TWO, extra: Record<string, unknown> = {}) {
  const o = await newOrder(lines, extra);
  const pi = await checkout(o.id);
  fake.customerPays(pi);
  if (extra.capture === "manual") return { ...o, pi };
  const r = await hook(piEvent("payment_intent.succeeded", pi));
  expect(r.status).toBe(200);
  return { ...o, pi };
}
const orderStatus = async (id: string) =>
  String((await h.q("SELECT status FROM orders WHERE id=$1", [id]))[0]?.status);
const count = async (table: string, where = "true") =>
  Number((await h.q<{ c: string }>(`SELECT count(*)::text c FROM ${table} WHERE ${where}`))[0]?.c);
const refundRow = async (pi: string) =>
  h.q("SELECT * FROM refunds WHERE order_id=(SELECT id FROM orders WHERE payment_intent_id=$1) ORDER BY created_at", [pi]);

/** The ledger invariants that must hold after ANY sequence of events. */
async function expectLedgerConsistent() {
  const lf = await ledgerFacts(h);
  expect(lf.unbalancedTxns, "every ledger transaction balances per currency").toBe(0);
  expect(await lf.sum(), "ledger sums to zero").toBe(0n);
  // provider clearing = captured money − live refunds
  const captured = BigInt(
    (await h.q<{ s: string }>("SELECT coalesce(sum(total),0)::text s FROM orders WHERE status IN ('paid','partially_refunded','refunded')"))[0]?.s ?? "0",
  );
  const live = BigInt(
    (await h.q<{ s: string }>("SELECT coalesce(sum(amount),0)::text s FROM refunds WHERE status NOT IN ('failed','canceled')"))[0]?.s ?? "0",
  );
  expect(await lf.sum("account='provider:clearing'"), "clearing = captured - live refunds").toBe(captured - live);
  // each refund is recognised exactly once while it holds money, and fully reversed (once) if it failed
  for (const r of await h.q<{ provider_ref: string; amount: string; status: string }>("SELECT * FROM refunds")) {
    const holds = ["pending", "requires_action", "succeeded"].includes(r.status);
    const clearing = await lf.sum("cause_ref=$1 AND account='provider:clearing'", [r.provider_ref]);
    expect(clearing, `refund ${r.provider_ref} clearing effect`).toBe(holds ? -BigInt(r.amount) : 0n);
    const net = await lf.sum("cause_ref=$1", [r.provider_ref]);
    expect(net, `refund ${r.provider_ref} nets to zero`).toBe(0n);
  }
  // no ledger sale posted for an unpaid order
  expect(await count("ledger_entries", "kind='sale' AND cause_ref NOT IN (SELECT payment_intent_id FROM orders WHERE status IN ('paid','partially_refunded','refunded') AND payment_intent_id IS NOT NULL)")).toBe(0);
}

const halfEvenFee = (a: bigint) => {
  const q = a / 10n;
  const r = a % 10n;
  return r > 5n || (r === 5n && q % 2n === 1n) ? q + 1n : q;
};

// ------------------------------------------------------------------------------------------------ orders & money input
describe("order creation and money parsing", () => {
  it.each([
    ["no lines", { lines: [] }],
    ["zero amount", { lines: [{ seller_id: "seller_a", amount: 0 }] }],
    ["negative amount", { lines: [{ seller_id: "seller_a", amount: -5 }] }],
    ["fractional number", { lines: [{ seller_id: "seller_a", amount: 10.5 }] }],
    ["decimal string", { lines: [{ seller_id: "seller_a", amount: "10.50" }] }],
    ["exponent string", { lines: [{ seller_id: "seller_a", amount: "1e3" }] }],
    ["signed string", { lines: [{ seller_id: "seller_a", amount: "+100" }] }],
    ["empty string", { lines: [{ seller_id: "seller_a", amount: "" }] }],
    ["boolean", { lines: [{ seller_id: "seller_a", amount: true }] }],
    ["null", { lines: [{ seller_id: "seller_a", amount: null }] }],
    ["unsafe integer number", { lines: [{ seller_id: "seller_a", amount: 9007199254740993 }] }],
    ["string beyond safe range", { lines: [{ seller_id: "seller_a", amount: "9007199254740992" }] }],
    ["sum beyond safe range", { lines: [{ seller_id: "seller_a", amount: "9007199254740991" }, { seller_id: "seller_b", amount: 1 }] }],
    ["two letter currency", { currency: "IN", lines: [{ seller_id: "seller_a", amount: 100 }] }],
    ["long currency", { currency: "RUPEE", lines: [{ seller_id: "seller_a", amount: 100 }] }],
  ])("rejects %s with 400 and writes nothing", async (_n, body) => {
    const r = await h.post("/orders", body);
    expect(r.status).toBe(400);
    expect(await count("orders")).toBe(0);
    expect(await count("order_lines")).toBe(0);
  });

  it("accepts decimal-integer strings and normalises the currency code", async () => {
    const o = await h.post("/orders", { currency: "usd", lines: [{ seller_id: "seller_a", amount: "000250" }] });
    expect(o.status).toBe(201);
    expect(o.body.currency).toBe("USD");
    expect(o.body.total).toBe("250");
  });

  it("line amounts sum exactly to the order total, stored as integer minor units", async () => {
    const o = await newOrder([
      { seller_id: "seller_a", amount: "1" },
      { seller_id: "seller_b", amount: 2 },
      { seller_id: "seller_a", amount: "999999" },
    ]);
    expect(o.total).toBe(1000002n);
    const sum = (await h.q<{ s: string }>("SELECT sum(amount)::text s FROM order_lines WHERE order_id=$1", [o.id]))[0]?.s;
    expect(sum).toBe("1000002");
  });

  it("carries amounts at the top of the exact integer range through payment, ledger and refund without rounding", async () => {
    const MAX = 9007199254740991n;
    const o = await paid([{ seller_id: "seller_a", amount: MAX.toString() }]);
    const fee = halfEvenFee(MAX);
    expect(await (await ledgerFacts(h)).sum("account='provider:clearing'")).toBe(MAX);
    expect(await (await ledgerFacts(h)).sum("account='seller:seller_a'")).toBe(-(MAX - fee));
    const r = await h.post(`/orders/${o.id}/refunds`, { line_id: o.lines[0], amount: "1" });
    expect(r.status).toBe(200);
    expect(await (await ledgerFacts(h)).sum("account='provider:clearing'")).toBe(MAX - 1n);
    await expectLedgerConsistent();
  });
});

// ------------------------------------------------------------------------------------------------ sale booking
describe("recording a sale", () => {
  it("books provider clearing against sellers and commission; commission rounds half to even and nothing is lost", async () => {
    const amounts = [5n, 15n, 25n, 35n, 1n, 9n, 1005n, 4n, 6n];
    const o = await paid(amounts.map((a, i) => ({ seller_id: i % 2 ? "seller_a" : "seller_b", amount: a.toString() })));
    const lf = await ledgerFacts(h);
    expect(await lf.sum("account='provider:clearing'")).toBe(amounts.reduce((s, a) => s + a, 0n));
    for (const [i, a] of amounts.entries()) {
      const lineId = o.lines[i] as string;
      const fee = halfEvenFee(a);
      const seller = await lf.sum("effect_ref=$1 AND kind='sale'", [`allocation:${lineId}`]);
      const comm = await lf.sum("effect_ref=$1 AND kind='commission'", [`allocation:${lineId}`]);
      expect(-seller, `seller share of ${a}`).toBe(a - fee);
      expect(-comm, `commission of ${a}`).toBe(fee);
      expect(-seller + -comm).toBe(a);
    }
    await expectLedgerConsistent();
  });

  it("an unpaid order has no ledger entries and confirm does not mark it paid", async () => {
    const o = await newOrder();
    await checkout(o.id);
    const r = await h.post(`/orders/${o.id}/confirm`);
    expect(r.status).toBe(200);
    expect(r.body.status).toBe("pending_payment");
    expect(await count("ledger_entries")).toBe(0);
  });

  it("confirm on an order that never started checkout is a 404", async () => {
    const o = await newOrder();
    expect((await h.post(`/orders/${o.id}/confirm`)).status).toBe(404);
  });

  it("USD sale books in USD only", async () => {
    await paid([{ seller_id: "seller_a", amount: 12345 }], { currency: "USD" });
    const cur = await h.q<{ currency: string }>("SELECT DISTINCT currency FROM ledger_entries");
    expect(cur.map((c) => c.currency)).toEqual(["USD"]);
    await expectLedgerConsistent();
  });

  it("sequential redelivery of the same event id books once", async () => {
    const o = await newOrder();
    const pi = await checkout(o.id);
    fake.customerPays(pi);
    const ev = piEvent("payment_intent.succeeded", pi);
    for (let i = 0; i < 4; i++) expect((await hook(ev)).status).toBe(200);
    expect(await count("ledger_entries", "kind='sale'")).toBe(3);
    expect(await count("processed_events")).toBe(1);
    await expectLedgerConsistent();
  });

  it("concurrent redelivery of the same event id books once", async () => {
    const o = await newOrder();
    const pi = await checkout(o.id);
    fake.customerPays(pi);
    const s = FakeStripe.sign(piEvent("payment_intent.succeeded", pi));
    const rs = await Promise.all(
      Array.from({ length: 12 }, () => h.post("/webhooks/stripe", s.payload, { "stripe-signature": s.header })),
    );
    expect(rs.every((r) => r.status === 200)).toBe(true);
    expect(await count("ledger_entries", "kind='sale'")).toBe(3);
    expect(await count("ledger_entries", "kind='commission'")).toBe(2);
    expect(await orderStatus(o.id)).toBe("paid");
    await expectLedgerConsistent();
  });

  it("different event ids for one payment, racing return-from-checkout, still book exactly once", async () => {
    const o = await newOrder();
    const pi = await checkout(o.id);
    fake.customerPays(pi);
    const calls: Promise<unknown>[] = [];
    for (let i = 0; i < 5; i++) calls.push(hook(piEvent("payment_intent.succeeded", pi)));
    for (let i = 0; i < 4; i++) calls.push(h.post(`/orders/${o.id}/confirm`));
    await Promise.all(calls);
    expect(await count("ledger_entries", "kind='sale'")).toBe(3);
    expect(await count("ledger_entries", "kind='commission'")).toBe(2);
    expect(await orderStatus(o.id)).toBe("paid");
    await expectLedgerConsistent();
  });

  it("late created/capturable observations after payment change nothing", async () => {
    const o = await paid();
    const before = await count("ledger_entries");
    const stale = { ...structuredClone(fake.pis.get(o.pi)), status: "requires_payment_method", amount_received: 0 };
    expect((await hook(fake.event("payment_intent.created", stale))).status).toBe(200);
    const auth = { ...stale, status: "requires_capture" };
    expect((await hook(fake.event("payment_intent.amount_capturable_updated", auth))).status).toBe(200);
    expect(await count("ledger_entries")).toBe(before);
    expect(await orderStatus(o.id)).toBe("paid");
  });

  it("an observation claiming money was received is not accepted as an observation", async () => {
    const o = await newOrder();
    const pi = await checkout(o.id);
    fake.customerPays(pi);
    const r = await hook(piEvent("payment_intent.created", pi));
    expect(r.status).not.toBe(200);
    expect(await count("ledger_entries")).toBe(0);
    expect(await orderStatus(o.id)).toBe("pending_payment");
  });

  it("a success event for an order the app has not recorded is asked to retry (503) and leaves no trace", async () => {
    fake.pis.set("pi_ghost", {
      id: "pi_ghost",
      object: "payment_intent",
      amount: 100,
      amount_received: 100,
      currency: "inr",
      capture_method: "automatic",
      status: "succeeded",
      client_secret: "x",
      metadata: { order_id: "ord_nonexistent" },
    });
    const r = await hook(piEvent("payment_intent.succeeded", "pi_ghost", "evt_ghost"));
    expect(r.status).toBe(503);
    expect(await count("processed_events")).toBe(0);
    expect(await count("ledger_entries")).toBe(0);
  });

  it("a success event arriving before the app recorded its checkout attempt is retried, not booked", async () => {
    const o = await newOrder();
    fake.pis.set("pi_early", {
      id: "pi_early",
      object: "payment_intent",
      amount: 1000,
      amount_received: 1000,
      currency: "inr",
      capture_method: "automatic",
      status: "succeeded",
      client_secret: "x",
      metadata: { order_id: o.id },
    });
    const r = await hook(piEvent("payment_intent.succeeded", "pi_early"));
    expect(r.status).toBe(503);
    expect(await count("ledger_entries")).toBe(0);
    expect(await orderStatus(o.id)).toBe("pending_payment");
  });

  it.each([
    ["short capture (partial amount_received)", (pi: { amount_received: number }) => void (pi.amount_received -= 1)],
    ["over capture", (pi: { amount_received: number }) => void (pi.amount_received += 1)],
    ["amount changed", (pi: { amount: number }) => void (pi.amount -= 1)],
    ["currency changed", (pi: { currency: string }) => void (pi.currency = "usd")],
  ])("refuses to book a sale when the provider object disagrees with the order: %s", async (_n, mutate) => {
    const o = await newOrder();
    const pi = await checkout(o.id);
    fake.customerPays(pi);
    const obj = fake.pis.get(pi);
    expect(obj).toBeDefined();
    mutate(obj as never);
    const r = await hook(piEvent("payment_intent.succeeded", pi));
    expect(r.status).not.toBe(200);
    expect(await count("ledger_entries")).toBe(0);
    expect(await orderStatus(o.id)).toBe("pending_payment");
    // and the failed delivery is not remembered as processed: a corrected redelivery can still be applied
    expect(await count("processed_events")).toBe(0);
  });

  it("a payment event cannot be redirected onto another order", async () => {
    const o1 = await newOrder();
    const o2 = await newOrder();
    const pi1 = await checkout(o1.id);
    const pi2 = await checkout(o2.id);
    fake.customerPays(pi1);
    fake.customerPays(pi2);
    const forged = structuredClone(fake.pis.get(pi1));
    expect(forged).toBeDefined();
    (forged as { metadata: Record<string, string> }).metadata.order_id = o2.id;
    const r = await hook(fake.event("payment_intent.succeeded", forged));
    expect(r.status).not.toBe(200);
    expect(await count("ledger_entries")).toBe(0);
    expect(await orderStatus(o2.id)).toBe("pending_payment");
  });

  it("two orders with identical amounts are booked independently", async () => {
    await paid();
    await paid();
    expect(await count("ledger_entries", "kind='sale' AND account='provider:clearing'")).toBe(2);
    expect(await (await ledgerFacts(h)).sum("account='provider:clearing'")).toBe(2000n);
    await expectLedgerConsistent();
  });
});

// ------------------------------------------------------------------------------------------------ signatures
describe("webhook authentication", () => {
  async function rawPaid() {
    const o = await newOrder();
    const pi = await checkout(o.id);
    fake.customerPays(pi);
    return { o, pi, ev: piEvent("payment_intent.succeeded", pi) };
  }
  it("rejects a missing, wrong-secret, tampered or stale-timestamp signature and applies nothing", async () => {
    const { o, ev } = await rawPaid();
    const s = FakeStripe.sign(ev);
    expect((await h.post("/webhooks/stripe", s.payload)).status).toBe(400);
    expect((await hook(ev, { secret: "whsec_wrong" })).status).toBe(400);
    expect((await h.post("/webhooks/stripe", s.payload.replace('"amount_received":1000', '"amount_received":1'), { "stripe-signature": s.header })).status).toBe(400);
    expect((await hook(ev, { timestamp: Math.floor(Date.now() / 1000) - 3600 })).status).toBe(400);
    expect(await count("ledger_entries")).toBe(0);
    expect(await count("processed_events")).toBe(0);
    expect(await orderStatus(o.id)).toBe("pending_payment");
    expect((await hook(ev)).status).toBe(200);
  });
  it("an event for an unsubscribed type is acknowledged and ignored", async () => {
    const r = await hook(fake.event("customer.created", { id: "cus_1", object: "customer" }));
    expect(r.status).toBe(200);
    expect(await count("ledger_entries")).toBe(0);
  });
});

// ------------------------------------------------------------------------------------------------ checkout
describe("checkout", () => {
  it("is idempotent: repeated checkout returns the same payment and creates one provider object", async () => {
    const o = await newOrder();
    const a = await checkout(o.id);
    const b = await checkout(o.id);
    expect(b).toBe(a);
    expect(fake.pis.size).toBe(1);
    expect(fake.pis.get(a)?.metadata.order_id).toBe(o.id);
    expect(fake.pis.get(a)?.amount).toBe(1000);
  });

  it("concurrent checkouts create at most one provider payment", async () => {
    const o = await newOrder();
    const rs = await Promise.all(Array.from({ length: 10 }, () => h.post(`/orders/${o.id}/checkout`)));
    expect(rs.some((r) => r.status === 200)).toBe(true);
    expect(fake.count("POST", /^\/v1\/payment_intents$/)).toBe(1);
    expect(fake.pis.size).toBe(1);
  });

  it("a create whose response is lost never produces a second payment; a later observation recovers the identity", async () => {
    const o = await newOrder();
    fake.inject(/^POST \/v1\/payment_intents$/, "apply_then_drop");
    const first = await h.post(`/orders/${o.id}/checkout`);
    expect(first.status).toBeGreaterThanOrEqual(500);
    expect(fake.pis.size).toBe(1);
    for (let i = 0; i < 3; i++) expect((await h.post(`/orders/${o.id}/checkout`)).status).toBe(502);
    expect(fake.count("POST", /^\/v1\/payment_intents$/)).toBe(1);
    const lost = [...fake.pis.values()][0];
    expect(lost).toBeDefined();
    const r = await hook(piEvent("payment_intent.created", (lost as { id: string }).id));
    expect(r.status).toBe(200);
    expect(await checkout(o.id)).toBe((lost as { id: string }).id);
    expect(fake.count("POST", /^\/v1\/payment_intents$/)).toBe(1);
  });

  it("a 5xx on create (effect applied) is also never retried into a second payment", async () => {
    const o = await newOrder();
    fake.inject(/^POST \/v1\/payment_intents$/, "apply_then_500");
    await h.post(`/orders/${o.id}/checkout`);
    await h.post(`/orders/${o.id}/checkout`);
    expect(fake.pis.size).toBe(1);
  });

  it("cannot check out an order that is already paid", async () => {
    const o = await paid();
    expect((await h.post(`/orders/${o.id}/checkout`)).status).toBe(409);
  });

  it("an unknown order is a 404", async () => {
    expect((await h.post("/orders/ord_missing/checkout")).status).toBe(404);
  });

  it("if the provider returns a payment with different money, the order is not bound to it", async () => {
    const o = await newOrder();
    fake.inject(/^POST \/v1\/payment_intents$/, "apply_then_500"); // ensures we go through create; mutate after
    const r0 = await h.post(`/orders/${o.id}/checkout`);
    expect(r0.status).toBeGreaterThanOrEqual(500);
    const only = [...fake.pis.values()][0] as { id: string; amount: number };
    only.amount = 999;
    const r = await hook(piEvent("payment_intent.created", only.id));
    expect(r.status).not.toBe(200);
    expect((await h.q("SELECT payment_intent_id FROM orders WHERE id=$1", [o.id]))[0]?.payment_intent_id).toBeNull();
  });
});

// ------------------------------------------------------------------------------------------------ manual capture
describe("manual capture", () => {
  it("authorisation alone books nothing; capture books once", async () => {
    const o = await paid(TWO, { capture: "manual" });
    expect((await hook(piEvent("payment_intent.amount_capturable_updated", o.pi))).status).toBe(200);
    expect(await count("ledger_entries")).toBe(0);
    expect(await orderStatus(o.id)).toBe("pending_payment");
    const c = await h.post(`/orders/${o.id}/capture`);
    expect(c.status).toBe(200);
    expect(c.body.status).toBe("paid");
    expect(await count("ledger_entries", "kind='sale'")).toBe(3);
    await hook(piEvent("payment_intent.succeeded", o.pi));
    await h.post(`/orders/${o.id}/confirm`);
    expect(await count("ledger_entries", "kind='sale'")).toBe(3);
    await expectLedgerConsistent();
  });

  it("capture before the customer authorised is refused and books nothing; money later confirmed by the provider is booked once", async () => {
    const o = await newOrder(TWO, { capture: "manual" });
    const pi = await checkout(o.id);
    const r = await h.post(`/orders/${o.id}/capture`);
    expect(r.status).toBe(502);
    expect(await count("ledger_entries")).toBe(0);
    expect(await orderStatus(o.id)).toBe("capture_pending");
    // the provider side completes (e.g. captured from the dashboard) and says so
    Object.assign(fake.pis.get(pi) ?? {}, { status: "succeeded", amount_received: 1000 });
    expect((await hook(piEvent("payment_intent.succeeded", pi))).status).toBe(200);
    expect((await h.post(`/orders/${o.id}/confirm`)).body.status).toBe("paid");
    expect(await count("ledger_entries", "kind='sale'")).toBe(3);
    await expectLedgerConsistent();
  });

  it("a capture whose response is lost is not booked on the client's guess, and is booked once when the provider confirms", async () => {
    const o = await newOrder(TWO, { capture: "manual" });
    const pi = await checkout(o.id);
    fake.customerPays(pi);
    fake.inject(/^POST \/v1\/payment_intents\/\w+\/capture$/, "apply_then_500", 3);
    const r = await h.post(`/orders/${o.id}/capture`);
    expect(r.status).toBe(502);
    expect(fake.pis.get(pi)?.status).toBe("succeeded"); // the provider did capture
    expect(await count("ledger_entries")).toBe(0); // but we have not been told, so nothing is booked
    expect(await orderStatus(o.id)).toBe("capture_pending");
    // retry of the capture API call replays the first result and books once
    const again = await h.post(`/orders/${o.id}/capture`);
    expect(again.status).toBe(200);
    expect(await count("ledger_entries", "kind='sale'")).toBe(3);
    // the webhook that was always going to come changes nothing
    expect((await hook(piEvent("payment_intent.succeeded", pi))).status).toBe(200);
    expect(await count("ledger_entries", "kind='sale'")).toBe(3);
    await expectLedgerConsistent();
  });

  it("a parked capture is resolved by the webhook alone", async () => {
    const o = await newOrder(TWO, { capture: "manual" });
    const pi = await checkout(o.id);
    fake.customerPays(pi);
    fake.inject(/^POST \/v1\/payment_intents\/\w+\/capture$/, "apply_then_drop", 3);
    expect((await h.post(`/orders/${o.id}/capture`)).status).toBe(502);
    expect(await orderStatus(o.id)).toBe("capture_pending");
    expect((await hook(piEvent("payment_intent.succeeded", pi))).status).toBe(200);
    expect(await orderStatus(o.id)).toBe("paid");
    expect(await count("ledger_entries", "kind='sale'")).toBe(3);
    await expectLedgerConsistent();
  });

  it("capturing an order with no payment is a 404", async () => {
    const o = await newOrder(TWO, { capture: "manual" });
    expect((await h.post(`/orders/${o.id}/capture`)).status).toBe(404);
  });
});

// ------------------------------------------------------------------------------------------------ refunds
describe("refund requests", () => {
  it.each([
    ["zero", 0],
    ["negative", -1],
    ["fractional", 1.5],
    ["text", "abc"],
    ["exponent", "1e2"],
    ["too big", "9007199254740993"],
  ])("rejects a %s amount before touching the provider", async (_n, amount) => {
    const o = await paid();
    const r = await h.post(`/orders/${o.id}/refunds`, { line_id: o.lines[0], amount });
    expect(r.status).toBe(400);
    expect(fake.refunds.size).toBe(0);
    expect(await count("refund_requests")).toBe(0);
  });

  it("rejects a missing amount, an unknown line and another order's line", async () => {
    const o = await paid();
    const other = await paid();
    expect((await h.post(`/orders/${o.id}/refunds`, { line_id: o.lines[0] })).status).toBe(400);
    expect((await h.post(`/orders/${o.id}/refunds`, { line_id: "nope", amount: 10 })).status).toBe(404);
    expect((await h.post(`/orders/${o.id}/refunds`, { line_id: other.lines[0], amount: 10 })).status).toBe(404);
    expect(fake.refunds.size).toBe(0);
  });

  it("cannot refund an unpaid order or an unknown order", async () => {
    const o = await newOrder();
    await checkout(o.id);
    expect((await h.post(`/orders/${o.id}/refunds`, { line_id: o.lines[0], amount: 10 })).status).toBe(409);
    expect((await h.post(`/orders/ord_none/refunds`, { line_id: "x", amount: 10 })).status).toBe(409);
    expect(fake.refunds.size).toBe(0);
  });

  it("partial refund reverses the right seller, in the right amount, and tracks order status", async () => {
    const o = await paid();
    const r = await h.post(`/orders/${o.id}/refunds`, { line_id: o.lines[0], amount: 250 });
    expect(r.status).toBe(200);
    expect(r.body.status).toBe("succeeded");
    const lf = await ledgerFacts(h);
    expect(await lf.sum("kind='refund' AND account='seller:seller_a'")).toBe(250n);
    expect(await lf.sum("kind='refund' AND account='seller:seller_b'")).toBe(0n);
    expect(await lf.sum("kind='refund' AND account='provider:clearing'")).toBe(-250n);
    expect(await orderStatus(o.id)).toBe("partially_refunded");
    const sent = [...fake.refunds.values()][0];
    expect(sent?.amount).toBe(250);
    expect(sent?.payment_intent).toBe(o.pi);
    expect(sent?.metadata.line_id).toBe(o.lines[0]);
    await expectLedgerConsistent();
  });

  it("refunding every line in full ends in refunded; nothing more can be refunded", async () => {
    const o = await paid();
    expect((await h.post(`/orders/${o.id}/refunds`, { line_id: o.lines[0], amount: 600 })).status).toBe(200);
    expect((await h.post(`/orders/${o.id}/refunds`, { line_id: o.lines[1], amount: 400 })).status).toBe(200);
    expect(await orderStatus(o.id)).toBe("refunded");
    const more = await h.post(`/orders/${o.id}/refunds`, { line_id: o.lines[1], amount: 1 });
    expect(more.status).toBe(409); // a fully refunded order is not refundable at all
    expect(fake.refunds.size).toBe(2);
    await expectLedgerConsistent();
  });

  it("never refunds more than the line holds, over several requests", async () => {
    const o = await paid();
    expect((await h.post(`/orders/${o.id}/refunds`, { line_id: o.lines[1], amount: 150 })).status).toBe(200);
    expect((await h.post(`/orders/${o.id}/refunds`, { line_id: o.lines[1], amount: 250 })).status).toBe(200);
    expect((await h.post(`/orders/${o.id}/refunds`, { line_id: o.lines[1], amount: 1 })).status).toBe(400);
    expect((await h.post(`/orders/${o.id}/refunds`, { line_id: o.lines[1], amount: 401 })).status).toBe(400);
    expect(fake.count("POST", /^\/v1\/refunds$/)).toBe(2);
  });

  it("parallel refunds on one line cannot exceed it", async () => {
    const o = await paid([{ seller_id: "seller_a", amount: 500 }]);
    const rs = await Promise.all(
      Array.from({ length: 10 }, () => h.post(`/orders/${o.id}/refunds`, { line_id: o.lines[0], amount: 100 })),
    );
    expect(rs.filter((r) => r.status === 200).length).toBe(5);
    expect(rs.filter((r) => r.status === 400).length).toBe(5);
    expect(fake.count("POST", /^\/v1\/refunds$/)).toBe(5);
    expect(await orderStatus(o.id)).toBe("refunded");
    await expectLedgerConsistent();
  });

  it("parallel refunds across lines respect each line and the order", async () => {
    const o = await paid();
    const reqs = [
      ...Array.from({ length: 4 }, () => h.post(`/orders/${o.id}/refunds`, { line_id: o.lines[0], amount: 300 })),
      ...Array.from({ length: 4 }, () => h.post(`/orders/${o.id}/refunds`, { line_id: o.lines[1], amount: 300 })),
    ];
    await Promise.all(reqs);
    const perLine = await h.q<{ line_id: string; s: string }>("SELECT line_id, sum(amount)::text s FROM refunds GROUP BY line_id");
    for (const l of perLine) expect(BigInt(l.s)).toBeLessThanOrEqual(l.line_id === o.lines[0] ? 600n : 400n);
    const total = perLine.reduce((s, l) => s + BigInt(l.s), 0n);
    expect(total).toBe(900n);
    expect(fake.count("POST", /^\/v1\/refunds$/)).toBe(3);
    await expectLedgerConsistent();
  });

  it("sends a stable idempotency key and the identifying metadata with every refund", async () => {
    const o = await paid();
    await h.post(`/orders/${o.id}/refunds`, { line_id: o.lines[0], amount: 100 });
    const req = fake.log.find((l) => l.path === "/v1/refunds");
    expect(req?.idemKey).toMatch(/^rf_/);
    expect(req?.form.get("amount")).toBe("100");
    expect(req?.form.get("metadata[order_id]")).toBe(o.id);
    expect(req?.form.get("metadata[refund_id]")).toBe(req?.idemKey);
  });
});

describe("refund outcomes the provider leaves uncertain", () => {
  it("a refund whose response is lost keeps its amount reserved, is never re-sent, and is linked exactly once when the provider's event arrives", async () => {
    const o = await paid();
    fake.inject(/^POST \/v1\/refunds$/, "apply_then_500");
    const r = await h.post(`/orders/${o.id}/refunds`, { line_id: o.lines[0], amount: 200 });
    expect(r.status).toBe(502);
    expect(fake.refunds.size).toBe(1); // the provider did refund
    expect(await count("refunds")).toBe(0); // we do not yet know
    const req = (await h.q<{ id: string; resolved: boolean }>("SELECT id, resolved FROM refund_requests"))[0];
    expect(req?.resolved).toBe(false);
    // the reservation still counts against the line: only 400 remains on this 600 line
    expect((await h.post(`/orders/${o.id}/refunds`, { line_id: o.lines[0], amount: 401 })).status).toBe(400);
    // background recovery must not blindly POST again
    await sleep(1800);
    expect(fake.count("POST", /^\/v1\/refunds$/)).toBe(1);
    expect(await count("refunds")).toBe(0);
    // provider tells us about it (twice, different event ids)
    const provRefund = [...fake.refunds.values()][0] as { id: string };
    expect((await hook(refundEvent("refund.created", provRefund.id))).status).toBe(200);
    expect((await hook(refundEvent("refund.updated", provRefund.id))).status).toBe(200);
    const rows = await h.q<{ origin: string; line_id: string; id: string }>("SELECT * FROM refunds");
    expect(rows.length).toBe(1);
    expect(rows[0]?.origin).toBe("api");
    expect(rows[0]?.line_id).toBe(o.lines[0]);
    expect(rows[0]?.id).toBe(req?.id);
    expect((await h.q<{ resolution: string }>("SELECT resolution FROM refund_requests"))[0]?.resolution).toBe("linked");
    expect(await count("ledger_entries", "kind='refund'")).toBe(2);
    expect(await (await ledgerFacts(h)).sum("kind='refund' AND account='seller:seller_a'")).toBe(200n);
    // capacity is exactly line - 200 now (no double count of reservation + refund)
    expect((await h.post(`/orders/${o.id}/refunds`, { line_id: o.lines[0], amount: 400 })).status).toBe(200);
    expect((await h.post(`/orders/${o.id}/refunds`, { line_id: o.lines[0], amount: 1 })).status).toBe(400);
    await expectLedgerConsistent();
  });

  it("reservations and provider-side refunds together cannot exceed the order total, even though no single line is over", async () => {
    const o = await paid([{ seller_id: "seller_a", amount: 1000 }]);
    const d = fake.dashboardRefund(o.pi, 700); // not tied to a line
    expect((await hook(refundEvent("refund.created", d.id))).status).toBe(200);
    fake.inject(/^POST \/v1\/refunds$/, "apply_then_500");
    expect((await h.post(`/orders/${o.id}/refunds`, { line_id: o.lines[0], amount: 300 })).status).toBe(502);
    // 700 refunded + 300 in doubt = the whole order: nothing more may even be attempted
    const extra = await h.post(`/orders/${o.id}/refunds`, { line_id: o.lines[0], amount: 100 });
    expect(extra.status).toBe(400);
    expect(fake.count("POST", /^\/v1\/refunds$/)).toBe(1);
  });

  it("a lost connection after the refund was applied behaves the same as a 5xx", async () => {
    const o = await paid();
    fake.inject(/^POST \/v1\/refunds$/, "apply_then_drop");
    expect((await h.post(`/orders/${o.id}/refunds`, { line_id: o.lines[1], amount: 100 })).status).toBe(502);
    expect(fake.refunds.size).toBe(1);
    expect((await h.post(`/orders/${o.id}/refunds`, { line_id: o.lines[1], amount: 301 })).status).toBe(400);
    expect(fake.count("POST", /^\/v1\/refunds$/)).toBe(1);
    expect(await count("ledger_entries", "kind='refund'")).toBe(0);
  });

  it("a timeout where the provider did NOT apply the refund still keeps the reservation (it cannot be proven unsent)", async () => {
    const o = await paid();
    fake.inject(/^POST \/v1\/refunds$/, "drop");
    expect((await h.post(`/orders/${o.id}/refunds`, { line_id: o.lines[1], amount: 100 })).status).toBe(502);
    expect(fake.refunds.size).toBe(0);
    expect((await h.post(`/orders/${o.id}/refunds`, { line_id: o.lines[1], amount: 301 })).status).toBe(400);
  });

  it("an unrelated provider refund of the same amount as an unresolved request is deferred, never linked by amount", async () => {
    const o = await paid();
    fake.inject(/^POST \/v1\/refunds$/, "apply_then_500");
    await h.post(`/orders/${o.id}/refunds`, { line_id: o.lines[0], amount: 200 });
    const other = fake.dashboardRefund(o.pi, 200);
    const r = await hook(refundEvent("refund.created", other.id));
    expect(r.status).toBe(503);
    expect(await count("refunds")).toBe(0);
    expect(await count("ledger_entries", "kind='refund'")).toBe(0);
    // a different amount is unambiguous and is recorded as the provider's own refund
    const diff = fake.dashboardRefund(o.pi, 150);
    expect((await hook(refundEvent("refund.created", diff.id))).status).toBe(200);
    const rows = await h.q<{ origin: string; line_id: string | null }>("SELECT * FROM refunds");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.origin).toBe("provider");
    expect(rows[0]?.line_id).toBeNull();
    expect(await (await ledgerFacts(h)).sum("account='platform:unallocated_refunds'")).toBe(150n);
  });

  it("a rate limit that provably prevented execution releases the reservation", async () => {
    const o = await paid([{ seller_id: "seller_a", amount: 500 }]);
    fake.inject(/^POST \/v1\/refunds$/, "429");
    const r = await h.post(`/orders/${o.id}/refunds`, { line_id: o.lines[0], amount: 500 });
    expect(r.status).toBe(409);
    expect((await h.q<{ resolution: string }>("SELECT resolution FROM refund_requests"))[0]?.resolution).toBe("rejected");
    expect(await count("ledger_entries", "kind='refund'")).toBe(0);
    expect((await h.post(`/orders/${o.id}/refunds`, { line_id: o.lines[0], amount: 500 })).status).toBe(200);
    await expectLedgerConsistent();
  });

  it("when the provider definitively says the refund is too large (money moved outside the app), nothing is booked and capacity returns", async () => {
    const o = await paid([{ seller_id: "seller_a", amount: 1000 }]);
    fake.dashboardRefund(o.pi, 700); // not yet known to the app
    const r = await h.post(`/orders/${o.id}/refunds`, { line_id: o.lines[0], amount: 500 });
    expect(r.status).toBe(409);
    expect(await count("refunds")).toBe(0);
    expect(await count("ledger_entries", "kind='refund'")).toBe(0);
    expect((await h.q<{ resolution: string }>("SELECT resolution FROM refund_requests"))[0]?.resolution).toBe("rejected");
    expect((await h.post(`/orders/${o.id}/refunds`, { line_id: o.lines[0], amount: 300 })).status).toBe(200);
    await expectLedgerConsistent();
  });
});

describe("refund lifecycle and provider-originated refunds", () => {
  it("a pending refund is recognised once; success does not double-book; failure reverses exactly once and frees the line", async () => {
    fake.newRefundStatus = "pending";
    const o = await paid();
    const r = await h.post(`/orders/${o.id}/refunds`, { line_id: o.lines[0], amount: 200 });
    expect(r.status).toBe(200);
    expect(r.body.status).toBe("pending");
    const prov = [...fake.refunds.values()][0] as { id: string; status: string };
    expect(await count("ledger_entries", "kind='refund'")).toBe(2);
    expect(await orderStatus(o.id)).toBe("partially_refunded");
    await expectLedgerConsistent();

    prov.status = "succeeded";
    expect((await hook(refundEvent("refund.updated", prov.id))).status).toBe(200);
    expect(await count("ledger_entries", "kind='refund'")).toBe(2);

    prov.status = "failed";
    expect((await hook(refundEvent("refund.failed", prov.id))).status).toBe(200);
    expect(await count("ledger_entries", "kind='refund_reversal'")).toBe(2);
    expect((await h.q<{ status: string }>("SELECT status FROM refunds"))[0]?.status).toBe("failed");
    expect(await orderStatus(o.id)).toBe("paid");
    await expectLedgerConsistent();

    // duplicates, replays and stale observations after the failure change nothing
    await hook(refundEvent("refund.failed", prov.id));
    await hook(refundEvent("refund.updated", prov.id));
    prov.status = "succeeded";
    await hook(refundEvent("refund.updated", prov.id));
    expect((await h.q<{ status: string }>("SELECT status FROM refunds"))[0]?.status).toBe("failed");
    expect(await count("ledger_entries", "kind='refund_reversal'")).toBe(2);
    expect(await count("ledger_entries", "kind='refund'")).toBe(2);
    expect(await orderStatus(o.id)).toBe("paid");
    prov.status = "failed";
    await expectLedgerConsistent();
    // the failed refund no longer consumes the line
    expect((await h.post(`/orders/${o.id}/refunds`, { line_id: o.lines[0], amount: 600 })).status).toBe(200);
  });

  it("a refund that succeeded and is later reported failed is reversed once", async () => {
    const o = await paid();
    await h.post(`/orders/${o.id}/refunds`, { line_id: o.lines[1], amount: 400 });
    expect(await orderStatus(o.id)).toBe("partially_refunded");
    const prov = [...fake.refunds.values()][0] as { id: string; status: string };
    prov.status = "failed";
    for (let i = 0; i < 3; i++) await hook(refundEvent("refund.updated", prov.id));
    expect(await count("ledger_entries", "kind='refund_reversal'")).toBe(2);
    expect(await orderStatus(o.id)).toBe("paid");
    await expectLedgerConsistent();
  });

  it("the provider's current state, not the webhook body, decides the refund status", async () => {
    fake.newRefundStatus = "pending";
    const o = await paid();
    await h.post(`/orders/${o.id}/refunds`, { line_id: o.lines[0], amount: 100 });
    const prov = [...fake.refunds.values()][0] as { id: string; status: string };
    prov.status = "failed";
    const stale = { ...structuredClone(prov), status: "succeeded" }; // an old body delivered late
    expect((await hook(fake.event("refund.updated", stale))).status).toBe(200);
    expect((await h.q<{ status: string }>("SELECT status FROM refunds"))[0]?.status).toBe("failed");
    await expectLedgerConsistent();
  });

  it("records a dashboard refund against unallocated refunds once, however often it is announced", async () => {
    const o = await paid();
    const d = fake.dashboardRefund(o.pi, 100);
    const ev = refundEvent("refund.created", d.id);
    await Promise.all([hook(ev), hook(ev), hook(ev), hook(refundEvent("refund.updated", d.id))]);
    expect(await count("refunds")).toBe(1);
    expect(await count("ledger_entries", "kind='refund'")).toBe(2);
    expect(await (await ledgerFacts(h)).sum("account='platform:unallocated_refunds'")).toBe(100n);
    expect(await orderStatus(o.id)).toBe("partially_refunded");
    await expectLedgerConsistent();
  });

  it("dashboard refunds count against what the app may still refund", async () => {
    const o = await paid([{ seller_id: "seller_a", amount: 1000 }]);
    const d = fake.dashboardRefund(o.pi, 800);
    expect((await hook(refundEvent("refund.created", d.id))).status).toBe(200);
    expect((await h.post(`/orders/${o.id}/refunds`, { line_id: o.lines[0], amount: 300 })).status).toBe(400);
    expect((await h.post(`/orders/${o.id}/refunds`, { line_id: o.lines[0], amount: 200 })).status).toBe(200);
    expect(await orderStatus(o.id)).toBe("refunded");
    await expectLedgerConsistent();
  });

  it("refuses provider refunds that would exceed the captured total, and in the wrong currency", async () => {
    const o = await paid([{ seller_id: "seller_a", amount: 1000 }]);
    const a = fake.dashboardRefund(o.pi, 1001);
    expect((await hook(refundEvent("refund.created", a.id))).status).not.toBe(200);
    const b = fake.dashboardRefund(o.pi, 100);
    b.currency = "usd";
    expect((await hook(refundEvent("refund.created", b.id))).status).not.toBe(200);
    expect(await count("refunds")).toBe(0);
    expect(await count("ledger_entries", "kind='refund'")).toBe(0);
    await expectLedgerConsistent();
  });

  it("a refund event that arrives before the payment event is retried, then applied once the payment is known", async () => {
    const o = await newOrder();
    const pi = await checkout(o.id);
    fake.customerPays(pi);
    const d = fake.dashboardRefund(pi, 100);
    const early = await hook(refundEvent("refund.created", d.id, "evt_refund_first"));
    expect(early.status).toBe(503);
    expect(await count("refunds")).toBe(0);
    expect((await hook(piEvent("payment_intent.succeeded", pi))).status).toBe(200);
    expect((await hook(refundEvent("refund.created", d.id, "evt_refund_first"))).status).toBe(200); // provider retries same id
    expect(await count("refunds")).toBe(1);
    expect(await orderStatus(o.id)).toBe("partially_refunded");
    await expectLedgerConsistent();
  });

  it("a refund whose payment belongs to no known order is not recorded", async () => {
    fake.pis.set("pi_stranger", {
      id: "pi_stranger",
      object: "payment_intent",
      amount: 500,
      amount_received: 500,
      currency: "inr",
      capture_method: "automatic",
      status: "succeeded",
      client_secret: "x",
      metadata: {},
    });
    const d = fake.dashboardRefund("pi_stranger", 100);
    expect((await hook(refundEvent("refund.created", d.id))).status).toBe(503);
    expect(await count("refunds")).toBe(0);
    expect(await count("ledger_entries")).toBe(0);
  });
});
