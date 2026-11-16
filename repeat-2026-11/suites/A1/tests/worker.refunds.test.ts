// worker-marketplace: refund reservations, unknown outcomes, attribution, lifecycle, restarts.
import fc from "fast-check";
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
const refund = (o: { id: string; lines: string[] }, line: number, amount: number) =>
  t.post(`/orders/${o.id}/refunds`, { line_id: o.lines[line], amount });
const rrs = () => t.q("SELECT id, state, provider_ref, amount::text a FROM refund_requests ORDER BY created_at, id");
const refundRows = () => t.q("SELECT provider_ref, request_id, line_id, status, origin, amount::text a FROM refunds ORDER BY created_at, id");
const seller = (s: string) => t.balance(`seller:${s}`);
const clearing = () => t.balance("provider:clearing");
const deliverRefund = async (reId: string, type = "refund.updated", id?: string) => {
  const r = await t.deliver(t.refundEvent(reId, type, id));
  expect(r.status).toBe(200);
  await t.drain();
};

describe("refund posting", () => {
  it("refunds reverse the right seller and the clearing account, and derive order status from live refunds", async () => {
    const o = await t.newOrder({ paid: true });
    const r = await refund(o, 0, 200);
    expect(r.status).toBe(200);
    expect(await seller("seller_a")).toBe(-540n + 200n);
    expect(await clearing()).toBe(800n);
    expect(await t.orderStatus(o.id)).toBe("partially_refunded");
    expect((await refund(o, 0, 400)).status).toBe(200);
    expect((await refund(o, 1, 400)).status).toBe(200);
    expect(await t.orderStatus(o.id)).toBe("refunded");
    expect(await clearing()).toBe(0n);
    expect(fake.liveRefunded(o.pi)).toBe(1000);
    await t.assertSound();
  });

  it("refuses over-refunds on the line and on the payment, and unpaid orders, without calling the provider", async () => {
    const unpaid = await t.newOrder();
    expect((await refund(unpaid, 0, 10)).status).toBe(409);
    const o = await t.newOrder({ paid: true });
    expect((await refund(o, 1, 401)).status).toBe(400);
    expect((await refund(o, 0, 0)).status).toBe(400);
    expect((await refund(o, 0, -3)).status).toBe(400);
    expect((await t.post(`/orders/${o.id}/refunds`, { line_id: o.lines[0], amount: "7.5" })).status).toBe(400);
    expect((await t.post(`/orders/${o.id}/refunds`, { line_id: "x", amount: 7 })).status).toBe(404);
    expect(fake.posts(/refunds$/).length).toBe(0);
    // a dashboard refund consumes payment capacity the line check alone would not see
    const d = fake.dashboardRefund(o.pi, 700);
    await deliverRefund(d.id);
    expect((await refund(o, 0, 301)).status).toBe(400);
    expect((await refund(o, 0, 300)).status).toBe(200);
    await t.assertSound();
  });

  it("concurrent refund requests cannot exceed line or payment capacity", async () => {
    const o = await t.newOrder({ paid: true });
    const rs = await Promise.all([...Array.from({ length: 6 }, () => refund(o, 0, 200)), ...Array.from({ length: 4 }, () => refund(o, 1, 150))]);
    expect(rs.filter((r) => r.status === 200).length).toBe(5);
    expect(rs.filter((r) => r.status !== 200).every((r) => r.status === 400)).toBe(true);
    expect(fake.liveRefunded(o.pi)).toBe(900);
    expect(await clearing()).toBe(100n);
    await t.assertSound();
  });

  it("each request has its own idempotency key and carries order, line and request ids", async () => {
    const o = await t.newOrder({ paid: true });
    await refund(o, 0, 100);
    await refund(o, 0, 100);
    const posts = fake.posts(/refunds$/);
    expect(new Set(posts.map((p) => p.idem)).size).toBe(2);
    for (const p of posts) {
      expect(p.idem).toBe(p.body["metadata[refund_request_id]"]);
      expect(p.body["metadata[order_id]"]).toBe(o.id);
      expect(p.body["metadata[line_id]"]).toBe(o.lines[0]);
    }
  });
});

describe("unknown and rejected outcomes", () => {
  it("a lost response keeps the amount reserved, is never re-posted, and the exact webhook links it once", async () => {
    const o = await t.newOrder({ paid: true });
    fake.addFault({ method: "POST", path: /refunds$/, mode: "drop-after-apply", times: 1 });
    const r = await refund(o, 0, 600);
    expect(r.status).toBe(202);
    expect(fake.refunds.size).toBe(1);
    expect((await rrs())[0]!.state).toBe("unknown");
    expect((await t.q("SELECT 1 FROM ledger_entries WHERE kind='refund'")).length).toBe(0);
    // the resolver cannot resend; capacity stays reserved even when the idempotency key may have expired
    fake.idem.clear();
    await t.drain(4000);
    await t.drain(4000);
    expect(fake.posts(/refunds$/).length).toBe(1);
    expect((await refund(o, 0, 1)).status).toBe(400);
    const reId = [...fake.refunds.keys()][0]!;
    await deliverRefund(reId, "refund.created", "evt_a");
    await deliverRefund(reId, "refund.updated", "evt_b");
    expect((await rrs())[0]).toMatchObject({ state: "sent", provider_ref: reId });
    expect(await refundRows()).toMatchObject([{ provider_ref: reId, origin: "shop", line_id: o.lines[0], status: "succeeded" }]);
    expect(await seller("seller_a")).toBe(-540n + 600n);
    expect(await clearing()).toBe(400n);
    expect((await t.q("SELECT state FROM jobs WHERE type='resolve_refund_request'")).every((j) => j.state === "done")).toBe(true);
    await t.assertSound();
  });

  it("a 5xx before the effect is also unknown: the request is not re-sent", async () => {
    const o = await t.newOrder({ paid: true });
    fake.addFault({ method: "POST", path: /refunds$/, mode: "500-before", times: 1 });
    expect((await refund(o, 0, 300)).status).toBe(202);
    expect(fake.refunds.size).toBe(0);
    await t.drain(3000);
    expect(fake.posts(/refunds$/).length).toBe(1);
    expect((await refund(o, 0, 301)).status).toBe(400);
  });

  it("a 429 before execution and a definitive 400 reject the request and release the reservation", async () => {
    const o = await t.newOrder({ paid: true });
    fake.addFault({ method: "POST", path: /refunds$/, mode: "429-before", times: 1 });
    expect((await refund(o, 0, 600)).status).toBe(409);
    expect((await rrs())[0]!.state).toBe("rejected");
    expect((await refund(o, 0, 600)).status).toBe(200);
    fake.dashboardRefund(o.pi, 400); // provider already consumed the rest
    expect((await refund(o, 1, 400)).status).toBe(409);
    expect((await rrs()).map((x) => x.state)).toEqual(["rejected", "sent", "rejected"]);
    expect(await seller("seller_b")).toBe(-360n);
    await t.assertSound();
  });

  it("a same-amount dashboard refund and an unknown API request are attributed independently, each booked once", async () => {
    const o = await t.newOrder({ paid: true });
    fake.addFault({ method: "POST", path: /refunds$/, mode: "drop-after-apply", times: 1 });
    expect((await refund(o, 0, 200)).status).toBe(202);
    const apiRe = [...fake.refunds.keys()][0]!;
    const dash = fake.dashboardRefund(o.pi, 200);
    await deliverRefund(dash.id);
    await deliverRefund(apiRe);
    const rows = await refundRows();
    expect(rows.find((r) => r.provider_ref === dash.id)).toMatchObject({ origin: "provider", line_id: null, request_id: null });
    expect(rows.find((r) => r.provider_ref === apiRe)).toMatchObject({ origin: "shop", line_id: o.lines[0] });
    expect(await seller("seller_a")).toBe(-540n + 200n);
    expect(await t.balance("platform:unallocated_refunds")).toBe(200n);
    expect(await clearing()).toBe(600n);
    await t.assertSound();
  });

  it("a request whose provider refund shows a different amount is rejected, never linked", async () => {
    const o = await t.newOrder({ paid: true });
    fake.addFault({ method: "POST", path: /refunds$/, mode: "drop-after-apply", times: 1 });
    await refund(o, 0, 200);
    const reId = [...fake.refunds.keys()][0]!;
    fake.refunds.get(reId)!.amount = 250;
    await t.deliver(t.refundEvent(reId));
    await t.drain(2000);
    expect((await t.q("SELECT 1 FROM ledger_entries WHERE kind='refund'")).length).toBe(0);
    expect((await rrs())[0]!.state).toBe("unknown");
  });
});

describe("restart", () => {
  it("a request in flight at a crash becomes unknown on restart and is not re-posted", async () => {
    const o = await t.newOrder({ paid: true });
    await t.q("INSERT INTO refund_requests (id, order_id, line_id, currency, amount, state) VALUES ('rr_crash',$1,$2,'INR',250,'requested')", [o.id, o.lines[0]]);
    const app2 = await t.restart();
    expect(await app2.shop.recoverRefundRequests()).toBe(1);
    expect((await rrs())[0]!.state).toBe("unknown");
    await t.drain(3000);
    expect(fake.posts(/refunds$/).length).toBe(0);
    expect((await refund(o, 0, 351)).status).toBe(400); // 250 still reserved
    // the provider applied it before the crash: webhook links it to the original request
    const applied = fake.dashboardRefund(o.pi, 250);
    applied.metadata = { order_id: o.id, line_id: o.lines[0]!, refund_request_id: "rr_crash" };
    await deliverRefund(applied.id);
    expect((await rrs())[0]).toMatchObject({ state: "sent", provider_ref: applied.id });
    expect(await seller("seller_a")).toBe(-540n + 250n);
    expect((await t.q("SELECT state FROM jobs WHERE type='resolve_refund_request'")).every((j) => j.state === "done")).toBe(true);
    await t.assertSound();
  });
});

describe("refund lifecycle", () => {
  it("pending refunds are recognised once and success later adds nothing", async () => {
    const o = await t.newOrder({ paid: true });
    fake.refundInitialStatus = "pending";
    expect((await refund(o, 0, 300)).status).toBe(200);
    const reId = [...fake.refunds.keys()][0]!;
    expect(await clearing()).toBe(700n);
    fake.setRefundStatus(reId, "succeeded");
    await deliverRefund(reId, "refund.updated", "e1");
    await deliverRefund(reId, "refund.updated", "e2");
    expect(await clearing()).toBe(700n);
    expect((await refundRows())[0]!.status).toBe("succeeded");
    await t.assertSound();
  });

  it("a failed refund is reversed once, frees capacity, and later events cannot revive it", async () => {
    const o = await t.newOrder({ paid: true });
    fake.refundInitialStatus = "pending";
    await refund(o, 0, 600);
    const reId = [...fake.refunds.keys()][0]!;
    const early = t.refundEvent(reId, "refund.created", "e_early");
    fake.setRefundStatus(reId, "failed");
    await deliverRefund(reId, "refund.failed", "e_fail");
    await deliverRefund(reId, "refund.failed", "e_fail"); // duplicate
    await deliverRefund(reId, "refund.updated", "e_other");
    expect((await t.deliver(early)).status).toBe(200); // delayed, older
    await t.drain();
    expect((await refundRows())[0]!.status).toBe("failed");
    expect(await seller("seller_a")).toBe(-540n);
    expect(await clearing()).toBe(1000n);
    expect(await t.orderStatus(o.id)).toBe("paid");
    expect((await t.refundLedger()).filter((r) => r.kind === "refund_reversal").length).toBe(2);
    fake.refundInitialStatus = "succeeded";
    expect((await refund(o, 0, 600)).status).toBe(200);
    await t.assertSound();
  });

  it("a refund event processed before its payment event still resolves (payment is reconciled first)", async () => {
    const o = await t.newOrder();
    fake.pay(o.pi);
    const d = fake.dashboardRefund(o.pi, 100);
    await t.deliver(t.refundEvent(d.id, "refund.created", "e_ref_first"));
    await t.deliver(t.payEvent(o.pi, "payment_intent.succeeded", "e_pay_second"));
    await t.drain();
    expect(await clearing()).toBe(900n);
    expect((await t.q("SELECT state FROM jobs")).every((j) => j.state === "done")).toBe(true);
    await t.assertSound();
  });

  it("refunds in another currency than their payment are rejected without booking", async () => {
    const o = await t.newOrder({ paid: true });
    const d = fake.dashboardRefund(o.pi, 100);
    d.currency = "usd";
    await t.deliver(t.refundEvent(d.id));
    await t.drain(1500);
    expect((await t.q("SELECT 1 FROM ledger_entries WHERE kind='refund'")).length).toBe(0);
    expect((await refundRows()).length).toBe(0);
  });

  it("property: any interleaving of provider refund transitions and reordered/duplicated events ends consistent with the provider", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom("succeeded", "failed", "canceled") as fc.Arbitrary<string>,
        fc.boolean(),
        fc.array(fc.nat({ max: 5 }), { minLength: 2, maxLength: 6 }),
        async (final, viaPending, order) => {
          await t.reset();
          const o = await t.newOrder({ paid: true });
          fake.refundInitialStatus = viaPending ? "pending" : "succeeded";
          expect((await refund(o, 0, 330)).status).toBe(200);
          const reId = [...fake.refunds.keys()][0]!;
          const timeline = viaPending ? ["succeeded", final] : [final];
          const evs: { payload: string; header: string }[] = [];
          for (const [i, s] of timeline.entries()) {
            if (s !== fake.refunds.get(reId)!.status) fake.setRefundStatus(reId, s);
            evs.push(t.refundEvent(reId, "refund.updated", `e_${i}_${Math.random()}`));
          }
          const all = [...evs, ...evs];
          for (const k of order) {
            await t.deliver(all[k % all.length]!);
            await t.drain();
          }
          for (const e of evs) await t.deliver(e);
          await t.drain();
          const holds = !["failed", "canceled"].includes(final);
          expect((await refundRows())[0]!.status).toBe(final);
          expect(await seller("seller_a")).toBe(-540n + (holds ? 330n : 0n));
          expect(await clearing()).toBe(1000n - (holds ? 330n : 0n));
          expect(await t.orderStatus(o.id)).toBe(holds ? "partially_refunded" : "paid");
          await t.assertSound();
        },
      ),
      { numRuns: 15 },
    );
  });
});

describe("races between the API response and provider webhooks", () => {
  it("a job that links and fails the refund while the POST response is in flight is not overwritten by the stale response", async () => {
    const o = await t.newOrder({ paid: true });
    fake.refundInitialStatus = "pending";
    let release!: () => void;
    fake.refundHold = new Promise<void>((r) => (release = r));
    const applied = new Promise<void>((r) => (fake.onRefundApplied = r));
    const inflight = refund(o, 0, 300);
    await applied;
    const reId = [...fake.refunds.keys()][0]!;
    fake.setRefundStatus(reId, "failed");
    expect((await t.deliver(t.refundEvent(reId, "refund.failed"))).status).toBe(200);
    await t.drain();
    release();
    expect((await inflight).status).toBe(200);
    expect((await refundRows())[0]!.status).toBe("failed");
    expect(await seller("seller_a")).toBe(-540n);
    expect(await clearing()).toBe(1000n);
    expect(await t.orderStatus(o.id)).toBe("paid");
    expect((await rrs())[0]!.state).toBe("sent");
    await t.assertSound();
  });

  it("a success event racing the API response books the refund once", async () => {
    const o = await t.newOrder({ paid: true });
    let release!: () => void;
    fake.refundHold = new Promise<void>((r) => (release = r));
    const applied = new Promise<void>((r) => (fake.onRefundApplied = r));
    const inflight = refund(o, 0, 300);
    await applied;
    const reId = [...fake.refunds.keys()][0]!;
    await t.deliver(t.refundEvent(reId, "refund.created"));
    await t.drain();
    release();
    expect((await inflight).status).toBe(200);
    expect(await seller("seller_a")).toBe(-540n + 300n);
    expect((await refundRows()).length).toBe(1);
    await t.assertSound();
  });
});
