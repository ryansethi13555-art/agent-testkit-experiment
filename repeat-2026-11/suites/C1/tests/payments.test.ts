// Payment-side money correctness: capture booking, webhook duplication / forgery / loss / reordering,
// lost capture responses, checkout double submit, currencies. Each test ends with the full money-law audit.
import { describe, expect, it } from "vitest";
import { audit, feeOf } from "./helpers/harness.ts";
import { converge, fault, ledgerCount, matrix, sleep } from "./helpers/scenario.ts";

describe("sale booking", () => {
  matrix("books the sale once, per line, with half-even commission on remainder amounts", async (ctx) => {
    // 5 -> 0.5 -> 0, 15 -> 1.5 -> 2, 25 -> 2.5 -> 2, 35 -> 3.5 -> 4 : exact ties must round half to even
    const o = await ctx.paidOrder([5, 15, 25, 35, 120]);
    expect(await audit(ctx)).toEqual([]);
    const fees = [5n, 15n, 25n, 35n, 120n].map(feeOf);
    expect(fees).toEqual([0n, 2n, 2n, 4n, 12n]);
    const status = (await ctx.q("SELECT status FROM orders WHERE id=$1", [o.id]))[0].status;
    expect(status).toBe("paid");
    expect(ctx.twin.payment(o.ref).amountCaptured).toBe(200n);
  });

  matrix("odd amounts across two sellers keep every minor unit (no rounding leak)", async (ctx) => {
    await ctx.paidOrder([333, 667, 1, 99, 1001], { sellers: ["seller_a", "seller_b", "seller_a", "seller_b", "seller_a"] });
    expect(await audit(ctx)).toEqual([]);
  });

  matrix("an order is not paid, and nothing is booked, before the provider captures", async (ctx) => {
    const o = await ctx.createOrder([300, 700]);
    expect((await ctx.checkout(o.id)).status).toBe(200);
    await ctx.twin.deliverNew(ctx.hook()); // payment created / requires_payment_method only
    await ctx.app.drain();
    expect((await ctx.q("SELECT status FROM orders WHERE id=$1", [o.id]))[0].status).toBe("pending_payment");
    expect(await ledgerCount(ctx)).toBe(0);
    expect(await audit(ctx)).toEqual([]);
  });

  matrix("a declined attempt books nothing, a later success books exactly once", async (ctx) => {
    const o = await ctx.createOrder([400, 600]);
    await ctx.checkout(o.id);
    const ref = await ctx.paymentRef(o.id);
    ctx.twin.customerPays(ref, "decline");
    await ctx.twin.deliverNew(ctx.hook());
    await ctx.app.drain();
    expect(await ledgerCount(ctx)).toBe(0);
    expect(await audit(ctx)).toEqual([]);
    ctx.twin.customerPays(ref, "success");
    await ctx.twin.deliverNew(ctx.hook());
    await ctx.app.drain();
    expect(await audit(ctx)).toEqual([]);
    expect(ctx.twin.payment(ref).amountCaptured).toBe(1000n);
  });
});

describe("webhook delivery hazards", () => {
  matrix("sequential redelivery of every event (replay / lost acknowledgements) books nothing twice", async (ctx) => {
    const o = await ctx.paidOrder([250, 750]);
    const before = await ledgerCount(ctx);
    for (let i = 0; i < 3; i++) await ctx.twin.replayAll(ctx.hook());
    await ctx.app.drain();
    expect(await ledgerCount(ctx)).toBe(before);
    expect(await audit(ctx)).toEqual([]);
    expect(o.id).toBeTruthy();
  });

  matrix("concurrent duplicates of the same event books once", async (ctx) => {
    const o = await ctx.createOrder([250, 750]);
    await ctx.checkout(o.id);
    ctx.twin.customerPays(await ctx.paymentRef(o.id));
    const events = ctx.twin.world.events.slice();
    // every encoding of every event, each delivered 8 times at the same instant
    const all = events.flatMap((e) => ctx.twin.encodings(e));
    await Promise.all(all.flatMap((enc) => Array.from({ length: 8 }, () => ctx.twin.post(ctx.hook(), enc).catch(() => undefined))));
    await converge(ctx);
    expect(await audit(ctx)).toEqual([]);
    expect(Number((await ctx.q("SELECT count(*)::int c FROM ledger_entries WHERE kind='sale' AND account='provider:clearing'"))[0].c)).toBe(1);
  });

  matrix("forged or unsigned webhooks are rejected and change nothing", async (ctx) => {
    const o = await ctx.createOrder([400, 600]);
    await ctx.checkout(o.id);
    ctx.twin.customerPays(await ctx.paymentRef(o.id));
    for (const sig of ["wrong_secret", "missing_header", "body_tampered"] as const)
      for (const e of ctx.twin.world.events) {
        const statuses = await ctx.twin.deliver(ctx.hook(), e, sig);
        for (const s of statuses) expect(s, `${sig} ${e.type}`).toBeGreaterThanOrEqual(400);
      }
    await ctx.app.drain();
    expect((await ctx.q("SELECT status FROM orders WHERE id=$1", [o.id]))[0].status).not.toBe("paid");
    expect(await ledgerCount(ctx)).toBe(0);
    // a genuine delivery afterwards works
    await ctx.twin.deliverNew(ctx.hook());
    await ctx.app.drain();
    expect(await audit(ctx)).toEqual([]);
    expect((await ctx.q("SELECT status FROM orders WHERE id=$1", [o.id]))[0].status).toBe("paid");
  });

  matrix("a dropped payment webhook is recovered from the provider (return-from-checkout), and the late webhook adds nothing", async (ctx) => {
    const o = await ctx.createOrder([400, 600]);
    await ctx.checkout(o.id);
    const ref = await ctx.paymentRef(o.id);
    const unpaid = await ctx.app.req("POST", `/orders/${o.id}/confirm`, {});
    expect(unpaid.status === 200 || unpaid.status === 409).toBe(true);
    expect(await ledgerCount(ctx)).toBe(0);
    ctx.twin.customerPays(ref); // webhooks never delivered
    for (let i = 0; i < 3; i++) expect((await ctx.app.req("POST", `/orders/${o.id}/confirm`, {})).status).toBe(200);
    await ctx.app.drain();
    expect(await audit(ctx, { allowOpenRequests: true })).toEqual([]);
    const n = await ledgerCount(ctx);
    await ctx.twin.replayAll(ctx.hook()); // the provider finally delivers
    await ctx.app.drain();
    expect(await ledgerCount(ctx)).toBe(n);
    expect(await audit(ctx)).toEqual([]);
  });

  matrix("payment events arriving in reverse order still book exactly once", async (ctx) => {
    const o = await ctx.createOrder([100, 300, 600]);
    await ctx.checkout(o.id);
    ctx.twin.customerPays(await ctx.paymentRef(o.id));
    const events = ctx.twin.world.events.slice().reverse();
    for (const e of events) await ctx.twin.deliver(ctx.hook(), e);
    await ctx.app.drain();
    await converge(ctx);
    expect(await audit(ctx)).toEqual([]);
  });

  matrix("events about payments the app never created book nothing", async (ctx) => {
    const r = ctx.twin.world.apply({ kind: "createPayment", amount: 5000n, currency: "INR", captureMethod: "automatic", metadata: { order_id: "ord_unknown" } });
    expect(r.ok).toBe(true);
    const id = (r.ok ? r.value : undefined) as { id: string };
    ctx.twin.world.apply({ kind: "customerPays", paymentId: id.id, outcome: "success" });
    await ctx.twin.deliverNew(ctx.hook());
    await ctx.app.drain();
    expect(await ledgerCount(ctx)).toBe(0);
    expect(Number((await ctx.q("SELECT count(*)::int c FROM orders"))[0].c)).toBe(0);
  });
});

describe("provider faults around capture", () => {
  for (const mode of ["lost response (applied, connection reset)", "applied then HTTP 500"] as const)
    matrix(
      `manual capture ${mode}: never double-books, never leaves captured money unbooked`,
      async (ctx) => {
        const o = await ctx.createOrder([400, 600], { capture: "manual" });
        expect((await ctx.checkout(o.id)).status).toBe(200);
        const ref = await ctx.paymentRef(o.id);
        ctx.twin.customerPays(ref); // authorised only
        await ctx.twin.deliverNew(ctx.hook());
        await ctx.app.drain();
        expect(await ledgerCount(ctx)).toBe(0);
        expect(ctx.twin.payment(ref).amountCaptured).toBe(0n);
        fault(ctx, "capture", mode.startsWith("lost") ? { t: "apply_then_reset" } : { t: "apply_then_500" }, 6);
        const r = await ctx.app.req("POST", `/orders/${o.id}/capture`, {});
        expect([502, 200]).toContain(r.status);
        expect(ctx.twin.payment(ref).amountCaptured).toBe(1000n); // provider really captured
        ctx.twin.server.clearRules();
        // the app learns through the webhook or through a re-check; both must end in "paid" exactly once
        await ctx.twin.deliverNew(ctx.hook());
        await ctx.app.drain();
        await ctx.app.req("POST", `/orders/${o.id}/capture`, {}); // merchant retries: must not capture twice or book twice
        await ctx.app.req("POST", `/orders/${o.id}/confirm`, {});
        await converge(ctx);
        expect(await audit(ctx)).toEqual([]);
        expect(ctx.twin.payment(ref).amountCaptured).toBe(1000n);
        expect((await ctx.q("SELECT status FROM orders WHERE id=$1", [o.id]))[0].status).toBe("paid");
      },
    );

  matrix("capture rejected before applying (5xx) leaves the order unpaid and the books empty", async (ctx) => {
    const o = await ctx.createOrder([400, 600], { capture: "manual" });
    await ctx.checkout(o.id);
    const ref = await ctx.paymentRef(o.id);
    ctx.twin.customerPays(ref);
    await ctx.twin.deliverNew(ctx.hook());
    await ctx.app.drain();
    fault(ctx, "capture", { t: "fail_before_apply", status: 500 }, 6);
    await ctx.app.req("POST", `/orders/${o.id}/capture`, {});
    expect(ctx.twin.payment(ref).amountCaptured).toBe(0n);
    expect(await ledgerCount(ctx)).toBe(0);
    expect((await ctx.q("SELECT status FROM orders WHERE id=$1", [o.id]))[0].status).not.toBe("paid");
    ctx.twin.server.clearRules();
    expect((await ctx.app.req("POST", `/orders/${o.id}/capture`, {})).status).toBe(200);
    await converge(ctx);
    expect(await audit(ctx)).toEqual([]);
  });

  matrix("a capture made in the provider dashboard is booked once", async (ctx) => {
    const o = await ctx.createOrder([400, 600], { capture: "manual" });
    await ctx.checkout(o.id);
    const ref = await ctx.paymentRef(o.id);
    ctx.twin.customerPays(ref);
    const c = ctx.twin.world.apply({ kind: "capture", paymentId: ctx.twin.canon(ref), origin: "dashboard" });
    expect(c.ok).toBe(true);
    await converge(ctx);
    expect(await audit(ctx)).toEqual([]);
  });
});

describe("checkout", () => {
  matrix("concurrent double submit creates exactly one provider payment", async (ctx) => {
    const o = await ctx.createOrder([400, 600]);
    const rs = await Promise.all(Array.from({ length: 8 }, () => ctx.checkout(o.id).catch(() => ({ status: 0, body: {} }))));
    expect(rs.some((r) => r.status === 200)).toBe(true);
    expect(ctx.twin.world.payments.size).toBe(1);
    const again = await ctx.checkout(o.id);
    expect([200, 502]).toContain(again.status);
    expect(ctx.twin.world.payments.size).toBe(1);
    const ref = await ctx.paymentRef(o.id);
    ctx.twin.customerPays(ref);
    await converge(ctx);
    expect(await audit(ctx)).toEqual([]);
  });

  matrix("a lost checkout response never creates a second provider payment, and the payment is still booked", async (ctx) => {
    const o = await ctx.createOrder([400, 600]);
    fault(ctx, "createPayment", { t: "apply_then_reset" }, 4);
    const first = await ctx.checkout(o.id);
    expect(first.status).not.toBe(200);
    ctx.twin.server.clearRules();
    expect(ctx.twin.world.payments.size).toBe(1); // applied at the provider
    for (let i = 0; i < 3; i++) await ctx.checkout(o.id);
    expect(ctx.twin.world.payments.size).toBe(1); // retries must not double-create
    ctx.twin.server.expireIdempotencyKeys(); // even after the provider forgot the key
    await ctx.checkout(o.id);
    expect(ctx.twin.world.payments.size).toBe(1);
    const [p] = [...ctx.twin.world.payments.values()];
    ctx.twin.world.apply({ kind: "customerPays", paymentId: p!.id, outcome: "success" });
    await converge(ctx);
    expect(await audit(ctx)).toEqual([]);
    expect((await ctx.q("SELECT status FROM orders WHERE id=$1", [o.id]))[0].status).toBe("paid");
  });
});

describe("currencies and units", () => {
  for (const [currency, lines] of [
    ["USD", [1999, 3001]],
    ["JPY", [500, 1501]],
  ] as const)
    matrix(`${currency} order: sale, refund and ledger stay in ${currency}`, async (ctx) => {
      const o = await ctx.paidOrder([...lines], { currency });
      expect(await audit(ctx)).toEqual([]);
      expect((await ctx.refund(o.id, o.lines[1]!, 123)).status).toBe(200);
      await converge(ctx);
      expect(await audit(ctx)).toEqual([]);
      const cur = await ctx.q("SELECT DISTINCT currency FROM ledger_entries");
      expect(cur.map((r) => r.currency)).toEqual([currency]);
    });

  matrix("a malformed order is refused before any provider call", async (ctx) => {
    const bad = [
      { lines: [] },
      { lines: [{ seller_id: "seller_a", amount: 0 }] },
      { lines: [{ seller_id: "seller_a", amount: -5 }] },
      { lines: [{ seller_id: "seller_a", amount: 10.5 }] },
      { lines: [{ seller_id: "seller_a", amount: "1e3" }] },
      { lines: [{ seller_id: "seller_a", amount: 9007199254740993 }] },
      { currency: "rupees", lines: [{ seller_id: "seller_a", amount: 500 }] },
    ];
    for (const b of bad) expect((await ctx.app.req("POST", "/orders", b)).status, JSON.stringify(b)).toBe(400);
    expect(ctx.twin.world.payments.size).toBe(0);
    await sleep(0);
  });
});
