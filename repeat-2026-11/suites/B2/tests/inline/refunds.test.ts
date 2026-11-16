// Inline marketplace (Stripe): refund-side money correctness, faults, races, recovery and a stateful property.
import fc from "fast-check";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { type Inline, startInline } from "../helpers/inlineApp.ts";
import { acct, commonLaws, expectedStatus, reconRefunds } from "../helpers/laws.ts";
import { sleep } from "../helpers/pg.ts";

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
const refund = (orderId: string, lineId: string, amount: unknown) =>
  t.post(`/orders/${orderId}/refunds`, { line_id: lineId, amount });
const status = async (id: string) => (await t.one("SELECT status FROM orders WHERE id=$1", [id])).status as string;
const req = async (id?: string) =>
  (await t.db.query("SELECT * FROM refund_requests " + (id ? "WHERE id=$1" : "ORDER BY id"), id ? [id] : [])).rows;
const refundPosts = () => t.fake.log.filter((l) => l.method === "POST" && l.path === "/v1/refunds");

describe("API refunds", () => {
  it("a partial refund reverses the seller share once, links its reservation and agrees with the provider", async () => {
    const { order, pi } = await t.paidOrder();
    const r = await refund(order.id, `${order.id}_l1`, 200);
    expect(r.status).toBe(200);
    expect(t.fake.refunds.size).toBe(1);
    expect([...t.fake.refunds.values()][0]?.metadata.refund_id).toBe(r.body.refund_id);
    expect(await acct(t.db, "seller:seller_a")).toBe(-540n + 200n);
    expect(await acct(t.db, "provider:clearing")).toBe(1000n - 200n);
    expect(await status(order.id)).toBe("partially_refunded");
    expect((await req())[0]).toMatchObject({ resolved: true, resolution: "linked" });
    // the provider's own notification for the same refund (several, with fresh event ids) adds nothing
    const ref = [...t.fake.refunds.keys()][0] as string;
    for (const type of ["refund.created", "refund.updated", "refund.updated"]) expect((await t.webhook(t.refundEvent(ref, type))).status).toBe(200);
    expect(await acct(t.db, "provider:clearing")).toBe(800n);
    await commonLaws(t.db);
    await reconRefunds(t.db, t.fake);
    expect(pi).toBeTruthy();
  });
  it("refunds cannot sum past the line, sequentially (S10); exactly the remainder is accepted", async () => {
    const { order } = await t.paidOrder();
    const l1 = `${order.id}_l1`;
    expect((await refund(order.id, l1, 250)).status).toBe(200);
    expect((await refund(order.id, l1, 250)).status).toBe(200);
    expect((await refund(order.id, l1, 101)).status).toBe(400);
    expect((await refund(order.id, l1, 100)).status).toBe(200);
    expect((await refund(order.id, l1, 1)).status).toBe(400);
    expect(t.fake.liveRefunded([...t.fake.pis.keys()][0] as string)).toBe(600);
    expect(await status(order.id)).toBe("partially_refunded");
    expect((await refund(order.id, `${order.id}_l2`, 400)).status).toBe(200);
    expect(await status(order.id)).toBe("refunded");
    await commonLaws(t.db);
    await reconRefunds(t.db, t.fake);
  });
  it("concurrent refunds on one line cannot over-refund it (S09)", async () => {
    const { order, pi } = await t.paidOrder();
    const l1 = `${order.id}_l1`;
    const rs = await Promise.all(Array.from({ length: 6 }, () => refund(order.id, l1, 200)));
    expect(rs.filter((r) => r.status === 200)).toHaveLength(3);
    expect(rs.filter((r) => r.status === 400)).toHaveLength(3);
    expect(t.fake.liveRefunded(pi)).toBe(600);
    const two = await t.paidOrder();
    const rs2 = await Promise.all([refund(two.order.id, `${two.order.id}_l1`, 400), refund(two.order.id, `${two.order.id}_l1`, 400)]);
    expect(rs2.map((r) => r.status).sort()).toEqual([200, 400]);
    expect(t.fake.liveRefunded(two.pi)).toBe(400);
    await commonLaws(t.db);
    await reconRefunds(t.db, t.fake);
  });
  it("concurrent refunds across the two lines of one order stay within each line and the order", async () => {
    const { order, pi } = await t.paidOrder();
    const rs = await Promise.all([
      refund(order.id, `${order.id}_l1`, 600),
      refund(order.id, `${order.id}_l1`, 1),
      refund(order.id, `${order.id}_l2`, 400),
      refund(order.id, `${order.id}_l2`, 1),
    ]);
    expect(rs.filter((r) => r.status === 200).length).toBeGreaterThanOrEqual(2);
    expect(t.fake.liveRefunded(pi)).toBeLessThanOrEqual(1000);
    await commonLaws(t.db);
    await reconRefunds(t.db, t.fake);
  });
  it.each([[0], [-1], [1.5], ["abc"], ["1e2"], [null], [Number.MAX_SAFE_INTEGER + 2]])("rejects refund amount %s before any provider call", async (amount) => {
    const { order } = await t.paidOrder();
    const before = refundPosts().length;
    const r = await refund(order.id, `${order.id}_l1`, amount as never);
    expect(r.status).toBe(400);
    expect(refundPosts().length).toBe(before);
    expect(await req()).toHaveLength(0);
  });
  it("refuses unknown lines, lines of another order, and unpaid orders", async () => {
    const a = await t.paidOrder();
    const b = await t.paidOrder();
    expect((await refund(a.order.id, "nope", 10)).status).toBe(404);
    expect((await refund(a.order.id, `${b.order.id}_l1`, 10)).status).toBe(404);
    const unpaid = await t.checkedOut();
    expect((await refund(unpaid.order.id, `${unpaid.order.id}_l1`, 10)).status).toBe(409);
    expect(refundPosts()).toHaveLength(0);
  });
  it("accepts string digit amounts exactly", async () => {
    const { order } = await t.paidOrder();
    expect((await refund(order.id, `${order.id}_l1`, "123")).status).toBe(200);
    expect([...t.fake.refunds.values()][0]?.amount).toBe(123);
  });
});

describe("provider faults around the refund call", () => {
  it("5xx with nothing applied (S08): never resent, capacity stays reserved, nothing booked", async () => {
    const { order } = await t.paidOrder();
    const l1 = `${order.id}_l1`;
    t.fake.fault("POST /v1/refunds", "before_500", 1);
    const r = await refund(order.id, l1, 200);
    expect(r.status).toBe(502);
    expect(t.fake.refunds.size).toBe(0);
    await sleep(1700); // several recovery scans
    expect(refundPosts()).toHaveLength(1);
    expect((await req())[0]).toMatchObject({ resolved: false, ambiguity_history: true });
    // the unknown 200 remains reserved on the line: only 400 more can be asked for
    expect((await refund(order.id, l1, 401)).status).toBe(400);
    expect((await refund(order.id, l1, 400)).status).toBe(200);
    expect(refundPosts()).toHaveLength(2);
    expect(new Set(refundPosts().map((p) => p.key)).size).toBe(2);
    expect(await acct(t.db, "provider:clearing")).toBe(600n);
    await commonLaws(t.db);
  });
  it.each(["apply_then_500", "apply_then_drop"] as const)("applied then response lost (%s): no second refund; the signed event links the original (S06 for refunds)", async (mode) => {
    const { order, pi } = await t.paidOrder();
    const l1 = `${order.id}_l1`;
    t.fake.fault("POST /v1/refunds", mode, 1);
    expect((await refund(order.id, l1, 200)).status).toBe(502);
    expect(t.fake.refunds.size).toBe(1);
    expect(await acct(t.db, "provider:clearing")).toBe(1000n); // not yet known to the app
    await sleep(1700);
    expect(refundPosts()).toHaveLength(1);
    const ref = [...t.fake.refunds.keys()][0] as string;
    const ev = t.refundEvent(ref, "refund.created");
    expect((await t.webhook(ev)).status).toBe(200);
    expect((await t.webhook(ev)).status).toBe(200); // duplicate
    expect((await t.webhook(t.refundEvent(ref))).status).toBe(200); // distinct id, same refund
    expect((await req())[0]).toMatchObject({ resolved: true, resolution: "linked" });
    expect((await t.one("SELECT origin FROM refunds WHERE provider_ref=$1", [ref])).origin).toBe("api");
    expect(await acct(t.db, "provider:clearing")).toBe(800n);
    expect(await acct(t.db, "seller:seller_a")).toBe(-340n);
    expect(t.fake.liveRefunded(pi)).toBe(200);
    await commonLaws(t.db);
    await reconRefunds(t.db, t.fake);
  });
  it("a rate limited first attempt (429 before execution) releases its reservation and is recorded as rejected", async () => {
    const { order } = await t.paidOrder();
    const l1 = `${order.id}_l1`;
    t.fake.fault("POST /v1/refunds", "before_429", 1);
    expect((await refund(order.id, l1, 600)).status).toBe(409);
    expect((await req())[0]).toMatchObject({ resolved: true, resolution: "rejected", rejection_reason: "rate_limited" });
    expect((await refund(order.id, l1, 600)).status).toBe(200); // capacity was released
    expect(t.fake.liveRefunded([...t.fake.pis.keys()][0] as string)).toBe(600);
    await commonLaws(t.db);
  });
  it("a definitive provider rejection (amount too large after an unseen dashboard refund) books nothing and releases capacity", async () => {
    const { order, pi } = await t.paidOrder();
    const l1 = `${order.id}_l1`;
    const dash = t.fake.dashboardRefund(pi, 900); // app has not been told yet
    const r = await refund(order.id, l1, 600);
    expect(r.status).toBe(409);
    expect((await req())[0]).toMatchObject({ resolved: true, resolution: "rejected", rejection_reason: "amount_too_large" });
    expect(await acct(t.db, "provider:clearing")).toBe(1000n);
    expect((await t.webhook(t.refundEvent(dash.id as string, "refund.created"))).status).toBe(200);
    expect(await acct(t.db, "provider:clearing")).toBe(100n);
    expect(await status(order.id)).toBe("partially_refunded");
    await commonLaws(t.db);
    await reconRefunds(t.db, t.fake);
  });
  it("a lost response never lets the same line be refunded again beyond its remaining capacity", async () => {
    const { order, pi } = await t.paidOrder();
    const l1 = `${order.id}_l1`;
    t.fake.fault("POST /v1/refunds", "apply_then_drop", 1);
    await refund(order.id, l1, 500);
    expect((await refund(order.id, l1, 101)).status).toBe(400);
    expect((await refund(order.id, l1, 100)).status).toBe(200);
    expect(t.fake.liveRefunded(pi)).toBe(600);
  });
});

describe("refund lifecycle (async failure, staleness, ordering)", () => {
  it("a pending refund that later fails is reversed exactly once and the line is refundable again (S13)", async () => {
    const { order, pi } = await t.paidOrder();
    const l1 = `${order.id}_l1`;
    t.fake.newRefundStatus = "pending";
    expect((await refund(order.id, l1, 600)).status).toBe(200);
    expect(await acct(t.db, "provider:clearing")).toBe(400n);
    expect(await status(order.id)).toBe("partially_refunded");
    const ref = [...t.fake.refunds.keys()][0] as string;
    t.fake.setRefundStatus(ref, "failed");
    for (let i = 0; i < 3; i++) expect((await t.webhook(t.refundEvent(ref, "refund.failed"))).status).toBe(200);
    expect(await acct(t.db, "provider:clearing")).toBe(1000n);
    expect(await acct(t.db, "seller:seller_a")).toBe(-540n);
    expect(await status(order.id)).toBe("paid");
    expect((await t.one("SELECT count(*) c FROM ledger_entries WHERE kind='refund_reversal'")).c).toBe(2n);
    await commonLaws(t.db);
    await reconRefunds(t.db, t.fake);
    t.fake.newRefundStatus = "succeeded";
    expect((await refund(order.id, l1, 600)).status).toBe(200);
    expect(t.fake.liveRefunded(pi)).toBe(600);
  });
  it("a stale 'succeeded' or 'pending' notice after the refund failed cannot resurrect it (S04)", async () => {
    const { order } = await t.paidOrder();
    t.fake.newRefundStatus = "pending";
    await refund(order.id, `${order.id}_l1`, 300);
    const ref = [...t.fake.refunds.keys()][0] as string;
    const stalePending = t.refundEvent(ref, "refund.created");
    t.fake.setRefundStatus(ref, "succeeded");
    const staleSucceeded = t.refundEvent(ref, "refund.updated");
    t.fake.setRefundStatus(ref, "failed");
    await t.webhook(t.refundEvent(ref, "refund.failed"));
    for (const e of [staleSucceeded, stalePending]) expect((await t.webhook(e)).status).toBe(200);
    expect((await t.one("SELECT status FROM refunds WHERE provider_ref=$1", [ref])).status).toBe("failed");
    expect(await acct(t.db, "provider:clearing")).toBe(1000n);
    expect(await status(order.id)).toBe("paid");
    await commonLaws(t.db);
  });
  it("a late 'pending' notice after success does not regress the refund", async () => {
    const { order } = await t.paidOrder();
    t.fake.newRefundStatus = "pending";
    await refund(order.id, `${order.id}_l1`, 300);
    const ref = [...t.fake.refunds.keys()][0] as string;
    const stale = t.refundEvent(ref, "refund.created");
    t.fake.setRefundStatus(ref, "succeeded");
    await t.webhook(t.refundEvent(ref, "refund.updated"));
    expect((await t.webhook(stale)).status).toBe(200);
    expect((await t.one("SELECT status FROM refunds WHERE provider_ref=$1", [ref])).status).toBe("succeeded");
    await reconRefunds(t.db, t.fake);
    await commonLaws(t.db);
  });
  it("a refund notice arriving before the payment notice is retried, then applied once (S03)", async () => {
    const { order, pi } = await t.checkedOut();
    t.fake.pay(pi);
    const dash = t.fake.dashboardRefund(pi, 250);
    const rev = t.refundEvent(dash.id as string, "refund.created", "evt_rf_early");
    expect((await t.webhook(rev)).status).toBe(503);
    expect(await acct(t.db, /./)).toBe(0n);
    expect((await t.one("SELECT count(*) c FROM refunds")).c).toBe(0n);
    await t.webhook({ id: "evt_late_pay", object: "event", type: "payment_intent.succeeded", data: { object: t.fake.snap(t.fake.pis.get(pi) as never) } });
    expect((await t.webhook(rev)).status).toBe(200);
    expect((await t.webhook(rev)).status).toBe(200);
    expect(await status(order.id)).toBe("partially_refunded");
    expect((await t.one("SELECT count(*) c FROM refunds")).c).toBe(1n);
    expect(await acct(t.db, "provider:clearing")).toBe(750n);
    await commonLaws(t.db);
    await reconRefunds(t.db, t.fake);
  });
  it("dashboard refunds are recorded once into the unallocated account and count against the order bound", async () => {
    const { order, pi } = await t.paidOrder();
    const dash = t.fake.dashboardRefund(pi, 900);
    const ev = t.refundEvent(dash.id as string, "refund.created");
    await Promise.all([t.webhook(ev), t.webhook(ev), t.webhook(t.refundEvent(dash.id as string))]);
    expect((await t.one("SELECT count(*) c FROM refunds")).c).toBe(1n);
    expect(await acct(t.db, "platform:unallocated_refunds")).toBe(900n);
    expect((await refund(order.id, `${order.id}_l1`, 200)).status).toBe(400); // order has 100 left
    expect((await refund(order.id, `${order.id}_l2`, 100)).status).toBe(200);
    expect(await status(order.id)).toBe("refunded");
    await commonLaws(t.db);
    await reconRefunds(t.db, t.fake);
  });
  it("a refund notice in a different currency than the order is refused and books nothing", async () => {
    const { pi } = await t.paidOrder();
    const dash = t.fake.dashboardRefund(pi, 100);
    (t.fake.refunds.get(dash.id as string) as { currency: string }).currency = "usd";
    expect((await t.webhook(t.refundEvent(dash.id as string, "refund.created"))).status).not.toBe(200);
    expect((await t.one("SELECT count(*) c FROM refunds")).c).toBe(0n);
    expect(await acct(t.db, "provider:clearing")).toBe(1000n);
  });
  it("a failed dashboard refund leaves no residue and the order returns to paid", async () => {
    const { order, pi } = await t.paidOrder();
    const dash = t.fake.dashboardRefund(pi, 300, "pending");
    await t.webhook(t.refundEvent(dash.id as string, "refund.created"));
    expect(await status(order.id)).toBe("partially_refunded");
    t.fake.setRefundStatus(dash.id as string, "failed");
    await t.webhook(t.refundEvent(dash.id as string, "refund.failed"));
    expect(await status(order.id)).toBe("paid");
    expect(await acct(t.db, "platform:unallocated_refunds")).toBe(0n);
    await commonLaws(t.db);
  });
  it("an unrelated dashboard refund of a different amount is recorded while an API request is unresolved; one of the same amount is held back, never mis-linked", async () => {
    const { order, pi } = await t.paidOrder();
    const l1 = `${order.id}_l1`;
    t.fake.fault("POST /v1/refunds", "apply_then_drop", 1);
    await refund(order.id, l1, 200);
    const apiRef = [...t.fake.refunds.keys()][0] as string;
    const diff = t.fake.dashboardRefund(pi, 70);
    const same = t.fake.dashboardRefund(pi, 200);
    expect((await t.webhook(t.refundEvent(diff.id as string, "refund.created"))).status).toBe(200);
    const sameEv = t.refundEvent(same.id as string, "refund.created");
    expect((await t.webhook(sameEv)).status).toBe(503);
    expect((await t.one("SELECT count(*) c FROM refunds WHERE provider_ref=$1", [same.id])).c).toBe(0n);
    expect((await t.webhook(t.refundEvent(apiRef, "refund.created"))).status).toBe(200);
    expect((await t.webhook(sameEv)).status).toBe(200);
    expect((await t.one("SELECT origin FROM refunds WHERE provider_ref=$1", [apiRef])).origin).toBe("api");
    expect((await t.one("SELECT origin FROM refunds WHERE provider_ref=$1", [same.id])).origin).toBe("provider");
    expect((await t.one("SELECT count(*) c FROM refunds")).c).toBe(3n);
    await commonLaws(t.db);
    await reconRefunds(t.db, t.fake);
  });
});

describe("crash recovery of durable refund reservations", () => {
  async function reservation(orderId: string, lineId: string, ref: string, amount: number, postStarted: boolean) {
    const id = `rf_crash_${Math.random().toString(36).slice(2, 8)}`;
    await t.db.query(
      "INSERT INTO refund_requests (id, order_id, line_id, payment_ref, currency, amount, post_started, next_attempt_at) VALUES ($1,$2,$3,$4,'INR',$5,$6, now() - interval '1 minute')",
      [id, orderId, lineId, ref, amount, postStarted],
    );
    return id;
  }
  it("a reservation committed but never sent is sent exactly once after restart, even with concurrent recoverers", async () => {
    const { order, pi } = await t.paidOrder();
    const id = await reservation(order.id, `${order.id}_l1`, pi, 250, false);
    await Promise.all([t.app.recoverPendingRefunds(), t.app.recoverPendingRefunds(), t.app.recoverPendingRefunds()]);
    expect(refundPosts()).toHaveLength(1);
    expect(refundPosts()[0]?.key).toBe(id);
    expect((await req(id))[0]).toMatchObject({ resolved: true, resolution: "linked" });
    expect(await acct(t.db, "provider:clearing")).toBe(750n);
    await t.app.recoverPendingRefunds();
    expect(refundPosts()).toHaveLength(1);
    await commonLaws(t.db);
    await reconRefunds(t.db, t.fake);
  });
  it("a crash after the send marker is treated as possibly committed: never resent, capacity retained, event resolves it", async () => {
    const { order, pi } = await t.paidOrder();
    const l1 = `${order.id}_l1`;
    const id = await reservation(order.id, l1, pi, 250, true);
    await t.app.recoverPendingRefunds();
    await sleep(1200);
    expect(refundPosts()).toHaveLength(0);
    expect((await req(id))[0]).toMatchObject({ resolved: false });
    expect((await refund(order.id, l1, 351)).status).toBe(400); // 600 - 250 reserved
    // the provider had in fact applied it before the crash
    const r = t.fake.dashboardRefund(pi, 250);
    (r.metadata as Record<string, string>).refund_id = id;
    (r.metadata as Record<string, string>).order_id = order.id;
    (r.metadata as Record<string, string>).line_id = l1;
    expect((await t.webhook(t.refundEvent(r.id as string, "refund.created"))).status).toBe(200);
    expect((await req(id))[0]).toMatchObject({ resolved: true, resolution: "linked" });
    expect(await acct(t.db, "provider:clearing")).toBe(750n);
    await commonLaws(t.db);
    await reconRefunds(t.db, t.fake);
  });
});

describe("property: random refund histories keep the books equal to the provider", () => {
  const op = fc.oneof(
    fc.record({ k: fc.constant("refund" as const), line: fc.integer({ min: 0, max: 1 }), amount: fc.integer({ min: 1, max: 700 }), pending: fc.boolean() }),
    fc.record({ k: fc.constant("settle" as const), idx: fc.nat(8), to: fc.constantFrom("succeeded", "failed") }),
    fc.record({ k: fc.constant("dash" as const), amount: fc.integer({ min: 1, max: 300 }) }),
    fc.record({ k: fc.constant("notice" as const), idx: fc.nat(8) }),
  );
  it("after every notice drains, refund table, ledger, labels and bounds agree with the provider", async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(op, { minLength: 1, maxLength: 9 }), async (ops) => {
        await t.reset();
        const { order, pi } = await t.paidOrder();
        for (const o of ops) {
          const refs = [...t.fake.refunds.keys()];
          if (o.k === "refund") {
            t.fake.newRefundStatus = o.pending ? "pending" : "succeeded";
            await refund(order.id, `${order.id}_l${o.line + 1}`, o.amount);
          } else if (o.k === "dash") {
            const left = 1000 - t.fake.liveRefunded(pi);
            if (o.amount <= left) t.fake.dashboardRefund(pi, o.amount, "pending");
          } else if (refs.length) {
            const ref = refs[o.idx % refs.length] as string;
            if (o.k === "settle" && t.fake.refunds.get(ref)?.status === "pending") t.fake.setRefundStatus(ref, o.to);
            await t.webhook(t.refundEvent(ref));
          }
        }
        for (const ref of t.fake.refunds.keys()) {
          const r = await t.webhook(t.refundEvent(ref));
          expect([200, 503]).toContain(r.status);
          if (r.status === 503) await t.webhook(t.refundEvent(ref));
        }
        await commonLaws(t.db);
        await reconRefunds(t.db, t.fake);
        const live = BigInt(t.fake.liveRefunded(pi));
        expect(live <= 1000n).toBe(true);
        expect(await status(order.id)).toBe(expectedStatus(1000n, live));
        expect(await acct(t.db, "provider:clearing")).toBe(1000n - live);
      }),
      { numRuns: 25 },
    );
  }, 240000);
});
