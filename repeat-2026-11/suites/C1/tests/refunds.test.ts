// Refund-side money correctness: bounds, concurrency, lost / failed / reordered provider outcomes, out-of-band
// refunds, attribution and idempotent recovery. Each test ends with the full money-law audit.
import { describe, expect, it } from "vitest";
import { audit } from "./helpers/harness.ts";
import { converge, fault, ledgerCount, matrix, sleep } from "./helpers/scenario.ts";

const orderStatus = async (ctx: any, id: string) => (await ctx.q("SELECT status FROM orders WHERE id=$1", [id]))[0].status as string;
const liveWorld = (ctx: any) => ctx.twin.liveRefundTotal() as bigint;

describe("refund bounds", () => {
  matrix("sequential partial refunds can never sum past the line, nor the order", async (ctx) => {
    const o = await ctx.paidOrder([1000, 500]);
    const [l1, l2] = o.lines as [string, string];
    expect((await ctx.refund(o.id, l1, 600)).status).toBe(200);
    expect(await audit(ctx)).toEqual([]);
    expect(await orderStatus(ctx, o.id)).toBe("partially_refunded");
    expect((await ctx.refund(o.id, l1, 600)).status).toBe(400); // 1200 > 1000
    expect(ctx.twin.world.refunds.size).toBe(1);
    expect((await ctx.refund(o.id, l1, 400)).status).toBe(200); // exactly the remainder
    expect((await ctx.refund(o.id, l1, 1)).status).toBe(400); // one minor unit too many
    expect(ctx.twin.world.refunds.size).toBe(2);
    expect((await ctx.refund(o.id, l2, 500)).status).toBe(200);
    await converge(ctx);
    expect(await audit(ctx)).toEqual([]);
    expect(await orderStatus(ctx, o.id)).toBe("refunded");
    expect(liveWorld(ctx)).toBe(1500n);
    expect((await ctx.refund(o.id, l2, 1)).status).toBeGreaterThanOrEqual(400);
    expect(ctx.twin.world.refunds.size).toBe(3);
  });

  matrix("a refund of a line that belongs to another order is refused", async (ctx) => {
    const a = await ctx.paidOrder([1000, 500]);
    const b = await ctx.paidOrder([700, 800]);
    const r = await ctx.refund(a.id, b.lines[0]!, 100);
    expect(r.status).toBeGreaterThanOrEqual(400);
    expect(r.status).toBeLessThan(500);
    expect(ctx.twin.world.refunds.size).toBe(0);
    expect((await ctx.refund(a.id, "no_such_line", 100)).status).toBe(404);
    expect(await audit(ctx)).toEqual([]);
  });

  matrix("a refund before the order is paid is refused and moves no money", async (ctx) => {
    const o = await ctx.createOrder([400, 600]);
    await ctx.checkout(o.id);
    expect((await ctx.refund(o.id, o.lines[0]!, 100)).status).toBeGreaterThanOrEqual(400);
    expect(ctx.twin.world.refunds.size).toBe(0);
  });

  matrix("invalid refund amounts never reach the provider", async (ctx) => {
    const o = await ctx.paidOrder([1000, 500]);
    for (const amount of [0, -1, 1.5, "abc", "1e3", null, 9007199254740993, "99999999999999999999"])
      expect((await ctx.app.req("POST", `/orders/${o.id}/refunds`, { line_id: o.lines[0], amount })).status, String(amount)).toBeGreaterThanOrEqual(400);
    expect(ctx.twin.world.refunds.size).toBe(0);
    expect(await audit(ctx)).toEqual([]);
  });

  matrix("provider minimum: Razorpay INR needs 100 minor units, nothing is sent or reserved below it", async (ctx) => {
    const o = await ctx.paidOrder([1000, 500]);
    const tiny = await ctx.refund(o.id, o.lines[0]!, 99);
    if (ctx.provider === "razorpay") {
      expect(tiny.status).toBe(400);
      expect(ctx.twin.world.refunds.size).toBe(0);
      // the rejected tiny request must not have eaten line capacity
      expect((await ctx.refund(o.id, o.lines[0]!, 1000)).status).toBe(200);
    } else {
      expect(tiny.status).toBe(200);
    }
    await converge(ctx);
    expect(await audit(ctx)).toEqual([]);
  });
});

describe("refund concurrency", () => {
  matrix("six concurrent refunds of 40% of one line: exactly two succeed, the provider never over-refunds", async (ctx) => {
    const o = await ctx.paidOrder([1000, 500]);
    const rs = await Promise.all(Array.from({ length: 6 }, () => ctx.refund(o.id, o.lines[0]!, 400)));
    expect(rs.filter((r) => r.status === 200).length).toBe(2);
    expect(ctx.twin.world.refunds.size).toBe(2);
    expect(liveWorld(ctx)).toBe(800n);
    await converge(ctx);
    expect(await audit(ctx)).toEqual([]);
  });

  matrix("concurrent refunds on two lines cannot exceed the order total", async (ctx) => {
    const o = await ctx.paidOrder([1000, 500]);
    const reqs = [
      ...Array.from({ length: 4 }, () => ctx.refund(o.id, o.lines[0]!, 700)),
      ...Array.from({ length: 4 }, () => ctx.refund(o.id, o.lines[1]!, 400)),
    ];
    await Promise.all(reqs);
    expect(liveWorld(ctx) <= 1500n).toBe(true);
    await converge(ctx);
    expect(await audit(ctx)).toEqual([]);
  });

  matrix("refunds held at the provider so they hit it together: whatever it accepts is booked exactly", async (ctx) => {
    const o = await ctx.paidOrder([1000, 500]);
    ctx.twin.server.addRule({
      label: "rendezvous",
      match: (c) => c.command.kind === "createRefund",
      hold: { barrier: "refunds", count: 2, timeoutMs: 4000, release: "together" },
    });
    const [a, b] = await Promise.all([ctx.refund(o.id, o.lines[0]!, 450), ctx.refund(o.id, o.lines[0]!, 450)]);
    ctx.twin.server.clearRules();
    expect([a.status, b.status].some((s) => s === 200)).toBe(true);
    await converge(ctx);
    await sleep(500);
    await converge(ctx);
    expect(await audit(ctx, { allowOpenRequests: true })).toEqual([]);
    expect(liveWorld(ctx) <= 1000n).toBe(true);
  });
});

describe("refund provider faults", () => {
  matrix("lost response (applied at provider): capacity stays reserved, webhook links it, books agree", async (ctx) => {
    const o = await ctx.paidOrder([400, 600]);
    const l1 = o.lines[0]!;
    fault(ctx, "createRefund", { t: "apply_then_reset" }, 5);
    const r = await ctx.refund(o.id, l1, 300);
    expect([202, 502]).toContain(r.status);
    ctx.twin.server.clearRules();
    expect(ctx.twin.world.refunds.size).toBe(1); // it really happened
    // while the outcome is unknown the 300 stays reserved: a further 200 would exceed the 400 line
    expect((await ctx.refund(o.id, l1, 200)).status).toBe(400);
    expect(ctx.twin.world.refunds.size).toBe(1);
    await converge(ctx);
    expect(await audit(ctx)).toEqual([]);
    expect((await ctx.refund(o.id, l1, 100)).status).toBe(200); // exactly the remaining 100
    expect((await ctx.refund(o.id, l1, 1)).status).toBe(400);
    await converge(ctx);
    expect(await audit(ctx)).toEqual([]);
    expect(liveWorld(ctx)).toBe(400n);
    expect((await ctx.q("SELECT line_id FROM refunds ORDER BY amount DESC"))[0].line_id).toBe(l1);
  });

  matrix("applied-then-500: the unknown refund is never resent, even after the provider forgot the idempotency key", async (ctx) => {
    const o = await ctx.paidOrder([400, 600]);
    fault(ctx, "createRefund", { t: "apply_then_500" }, 5);
    const r = await ctx.refund(o.id, o.lines[0]!, 250);
    expect(r.status).not.toBe(200); // outcome unknown: 502 (inline) or 202 processing (worker)
    ctx.twin.server.clearRules();
    expect(ctx.twin.world.refunds.size).toBe(1);
    ctx.twin.server.expireIdempotencyKeys();
    await ctx.app.drain();
    await sleep(2200); // let the app's recovery scans / retries run
    await ctx.app.drain();
    expect(ctx.twin.world.refunds.size).toBe(1); // still one refund: money was not duplicated
    await converge(ctx);
    expect(await audit(ctx)).toEqual([]);
    expect(liveWorld(ctx)).toBe(250n);
  });

  matrix("5xx before anything was applied: no refund, no ledger posting, never a double refund later", async (ctx) => {
    const o = await ctx.paidOrder([400, 600]);
    const before = await ledgerCount(ctx);
    fault(ctx, "createRefund", { t: "fail_before_apply", status: 500 }, 6);
    const r = await ctx.refund(o.id, o.lines[0]!, 250);
    expect(r.status).not.toBe(200); // outcome unknown: 502 (inline) or 202 processing (worker)
    ctx.twin.server.clearRules();
    expect(ctx.twin.world.refunds.size).toBe(0);
    expect(await ledgerCount(ctx)).toBe(before);
    ctx.twin.server.expireIdempotencyKeys();
    await ctx.app.drain();
    await sleep(2200);
    await ctx.app.drain();
    expect(ctx.twin.world.refunds.size).toBeLessThanOrEqual(1); // a safe retry is allowed; a duplicate is not
    await converge(ctx);
    expect(await audit(ctx, { allowOpenRequests: true })).toEqual([]);
    expect(liveWorld(ctx) <= 250n).toBe(true);
  });

  matrix("Stripe 429 is rejected before execution, so its reservation is released", async (ctx) => {
    const o = await ctx.paidOrder([400, 600]);
    fault(ctx, "createRefund", { t: "fail_before_apply", status: 429 }, 1);
    const r = await ctx.refund(o.id, o.lines[0]!, 400);
    expect(r.status).toBeGreaterThanOrEqual(400);
    expect(ctx.twin.world.refunds.size).toBe(0);
    expect((await ctx.refund(o.id, o.lines[0]!, 400)).status).toBe(200); // the full line is refundable again
    await converge(ctx);
    expect(await audit(ctx)).toEqual([]);
  }, { providers: ["stripe"] });

  matrix("app crash while the provider applied a refund: restart neither loses nor repeats it", async (ctx) => {
    const o = await ctx.paidOrder([400, 600]);
    fault(ctx, "createRefund", { t: "apply_then_reset" }, 5);
    await ctx.refund(o.id, o.lines[0]!, 300);
    ctx.twin.server.clearRules();
    expect(ctx.twin.world.refunds.size).toBe(1);
    ctx.twin.server.expireIdempotencyKeys();
    await ctx.app.crashAndRestart();
    await ctx.app.drain();
    await sleep(2200);
    await ctx.app.drain();
    expect(ctx.twin.world.refunds.size).toBe(1);
    expect((await ctx.refund(o.id, o.lines[0]!, 200)).status).toBe(400); // reservation survived the restart
    await converge(ctx);
    expect(await audit(ctx)).toEqual([]);
    expect((await ctx.q("SELECT line_id FROM refunds"))[0].line_id).toBe(o.lines[0]);
  });

  matrix("app crash with the payment captured but unseen: restart still books it once", async (ctx) => {
    const o = await ctx.createOrder([400, 600]);
    await ctx.checkout(o.id);
    ctx.twin.customerPays(await ctx.paymentRef(o.id));
    await ctx.app.crashAndRestart();
    await converge(ctx);
    expect(await audit(ctx)).toEqual([]);
    await ctx.app.crashAndRestart();
    await converge(ctx);
    expect(await audit(ctx)).toEqual([]);
  });
});

describe("asynchronous refund outcomes", () => {
  matrix("pending refund that later FAILS leaves no residue and frees the capacity; stale events do not resurrect it", async (ctx) => {
    const o = await ctx.paidOrder([1000, 500]);
    const l1 = o.lines[0]!;
    expect((await ctx.refund(o.id, l1, 300)).status).toBe(200);
    await ctx.twin.deliverNew(ctx.hook());
    await ctx.app.drain();
    expect((await ctx.q("SELECT status FROM refunds"))[0].status).toBe("pending");
    expect(await audit(ctx)).toEqual([]); // pending refunds are already recognised money
    const [wire] = ctx.twin.refundWireIds();
    ctx.twin.settleRefund(wire!, "failed");
    await ctx.twin.deliverNew(ctx.hook());
    await ctx.app.drain();
    expect(await audit(ctx)).toEqual([]);
    expect(await orderStatus(ctx, o.id)).toBe("paid");
    // the stale 'pending' / 'created' notices arrive after the final one
    for (let i = 0; i < 2; i++) await ctx.twin.replayAll(ctx.hook());
    await ctx.app.drain();
    expect((await ctx.q("SELECT status FROM refunds"))[0].status).toBe("failed");
    expect(await audit(ctx)).toEqual([]);
    // the failed refund's money is refundable again, in full
    expect((await ctx.refund(o.id, l1, 1000)).status).toBe(200);
    await converge(ctx);
    expect(await audit(ctx)).toEqual([]);
  }, { asyncRefunds: true });

  matrix("pending refund that SUCCEEDS: replayed pending notice cannot regress it, ledger recognised once", async (ctx) => {
    const o = await ctx.paidOrder([1000, 500]);
    await ctx.refund(o.id, o.lines[0]!, 300);
    await ctx.twin.deliverNew(ctx.hook());
    const [wire] = ctx.twin.refundWireIds();
    ctx.twin.settleRefund(wire!, "succeeded");
    await ctx.twin.deliverNew(ctx.hook());
    await ctx.app.drain();
    for (let i = 0; i < 3; i++) await ctx.twin.replayAll(ctx.hook());
    await ctx.app.drain();
    expect((await ctx.q("SELECT status FROM refunds"))[0].status).toBe("succeeded");
    expect(await audit(ctx)).toEqual([]);
  }, { asyncRefunds: true });

  matrix("Stripe: canceled refund, and a succeeded refund that reverts to requires_action, stay accounted", async (ctx) => {
    const o = await ctx.paidOrder([1000, 500]);
    const l1 = o.lines[0]!;
    await ctx.refund(o.id, l1, 200);
    await ctx.refund(o.id, l1, 300);
    await ctx.twin.deliverNew(ctx.hook());
    const [w1, w2] = ctx.twin.refundWireIds();
    ctx.twin.settleRefund(w1!, "canceled");
    ctx.twin.settleRefund(w2!, "succeeded");
    await ctx.twin.deliverNew(ctx.hook());
    await ctx.app.drain();
    expect(await audit(ctx)).toEqual([]);
    const rv = ctx.twin.world.apply({ kind: "revertRefund", refundId: ctx.twin.canon(w2!), to: "requires_action" });
    expect(rv.ok).toBe(true);
    await ctx.twin.deliverNew(ctx.hook());
    await ctx.app.drain();
    await ctx.twin.replayAll(ctx.hook()); // older 'succeeded' snapshots arrive after the revert
    await ctx.app.drain();
    expect(await audit(ctx)).toEqual([]);
    expect(liveWorld(ctx)).toBe(300n); // requires_action still holds the money
    expect((await ctx.q("SELECT status FROM refunds WHERE provider_ref=$1", [w2]))[0].status).toBe("requires_action");
    await converge(ctx);
    expect(await audit(ctx)).toEqual([]);
  }, { asyncRefunds: true, providers: ["stripe"] });

  matrix("failed refund then a new full refund: attribution and ledger stay per refund object", async (ctx) => {
    const o = await ctx.paidOrder([400, 600]);
    await ctx.refund(o.id, o.lines[0]!, 400);
    await ctx.twin.deliverNew(ctx.hook());
    ctx.twin.settleRefund(ctx.twin.refundWireIds()[0]!, "failed");
    await converge(ctx);
    await ctx.refund(o.id, o.lines[0]!, 400);
    const w = ctx.twin.refundWireIds()[1]!;
    ctx.twin.settleRefund(w, "succeeded");
    await converge(ctx);
    expect(await audit(ctx)).toEqual([]);
    expect(await orderStatus(ctx, o.id)).toBe("partially_refunded");
  }, { asyncRefunds: true });
});

describe("out of band (dashboard) refunds and attribution", () => {
  matrix("a dashboard refund is recorded without a line, once, and bounds later API refunds", async (ctx) => {
    const o = await ctx.paidOrder([1000, 500]);
    ctx.twin.dashboardRefund(o.ref, 600n);
    await converge(ctx);
    expect(await audit(ctx)).toEqual([]);
    expect((await ctx.q("SELECT origin, line_id FROM refunds"))[0].line_id).toBeNull();
    expect((await ctx.refund(o.id, o.lines[0]!, 1000)).status).toBeGreaterThanOrEqual(400); // 600 + 1000 > 1500
    expect(ctx.twin.world.refunds.size).toBe(1);
    expect((await ctx.refund(o.id, o.lines[0]!, 900)).status).toBe(200); // 600 + 900 = 1500
    await converge(ctx);
    expect(await audit(ctx)).toEqual([]);
    expect(await orderStatus(ctx, o.id)).toBe("refunded");
  });

  matrix("refund event delivered before the payment event is applied once the payment is known", async (ctx) => {
    const o = await ctx.createOrder([1000, 500]);
    await ctx.checkout(o.id);
    const ref = await ctx.paymentRef(o.id);
    ctx.twin.customerPays(ref);
    ctx.twin.dashboardRefund(ref, 200n);
    const events = ctx.twin.world.events.slice();
    const refundEvents = events.filter((e) => e.type.startsWith("refund."));
    const otherEvents = events.filter((e) => !e.type.startsWith("refund."));
    for (const e of refundEvents) await ctx.twin.deliver(ctx.hook(), e); // too early: must not be lost
    for (const e of otherEvents) await ctx.twin.deliver(ctx.hook(), e);
    await ctx.app.drain();
    await converge(ctx);
    expect(await audit(ctx)).toEqual([]);
    expect(Number((await ctx.q("SELECT count(*)::int c FROM refunds"))[0].c)).toBe(1);
  });

  matrix("an API refund and a dashboard refund of the SAME amount are never confused", async (ctx) => {
    const o = await ctx.paidOrder([1000, 500]);
    fault(ctx, "createRefund", { t: "apply_then_reset" }, 5);
    await ctx.refund(o.id, o.lines[1]!, 200); // applied at provider, response lost
    ctx.twin.server.clearRules();
    ctx.twin.dashboardRefund(o.ref, 200n); // same amount, other origin
    // deliver the dashboard refund's notices first
    const evs = ctx.twin.world.events.filter((e) => e.type.startsWith("refund."));
    const dash = ctx.twin.world.refunds;
    const dashWire = ctx.twin.refundWireIds()[1]!;
    for (const e of evs.slice().reverse()) await ctx.twin.deliver(ctx.hook(), e);
    await converge(ctx);
    expect(await audit(ctx)).toEqual([]);
    const rows = await ctx.q("SELECT provider_ref, line_id FROM refunds");
    expect(rows.length).toBe(2);
    expect(rows.find((r) => r.provider_ref === dashWire)?.line_id).toBeNull();
    expect(rows.find((r) => r.provider_ref !== dashWire)?.line_id).toBe(o.lines[1]);
    expect(dash.size).toBe(2);
  });

  matrix("two orders refunded with identical amounts at the same time stay on their own order", async (ctx) => {
    const a = await ctx.paidOrder([1000, 500]);
    const b = await ctx.paidOrder([1000, 500]);
    await Promise.all([ctx.refund(a.id, a.lines[0]!, 300), ctx.refund(b.id, b.lines[0]!, 300), ctx.refund(a.id, a.lines[1]!, 300), ctx.refund(b.id, b.lines[1]!, 300)]);
    await converge(ctx);
    expect(await audit(ctx)).toEqual([]);
    const rows = await ctx.q("SELECT order_id, line_id FROM refunds");
    for (const r of rows) expect(String(r.line_id).startsWith(r.order_id)).toBe(true);
    expect(rows.length).toBe(4);
  });
});

describe("the audit itself", () => {
  it("is not vacuous: it flags tampered books and unobserved provider refunds", async () => {
    const { setup } = await import("./helpers/harness.ts");
    for (const kind of ["inline", "worker"] as const) {
      const ctx = await setup(kind, "stripe");
      try {
        const o = await ctx.paidOrder([1000, 500]);
        expect(await audit(ctx)).toEqual([]);
        // 1. a provider refund the app never heard about
        ctx.twin.dashboardRefund(o.ref, 100n);
        expect((await audit(ctx)).join("\n")).toMatch(/unknown to the app/);
        await converge(ctx);
        expect(await audit(ctx)).toEqual([]);
        // 2. a duplicated seller posting (balanced, so only the provider-truth comparison can catch it)
        await ctx.q(
          "INSERT INTO ledger_entries (txn_id, account, currency, amount, cause_ref, kind, effect_ref) VALUES ('t_x','seller:seller_a','INR',-50,'" +
            o.ref +
            "','sale','dup'), ('t_x','platform:unallocated_refunds','INR',50,'" +
            o.ref +
            "','sale','dup')",
        );
        const bad = (await audit(ctx)).join("\n");
        expect(bad).toMatch(/seller:seller_a nets/);
        // 3. an unbalanced entry
        await ctx.q("INSERT INTO ledger_entries (txn_id, account, currency, amount, cause_ref, kind, effect_ref) VALUES ('t_y','seller:seller_b','INR',-7,'x','sale','y')").catch(() => {});
        const unbal = (await audit(ctx)).join("\n");
        expect(unbal.length).toBeGreaterThan(0);
      } finally {
        await ctx.close();
      }
    }
  });
});
