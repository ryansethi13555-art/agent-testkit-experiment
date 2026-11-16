// inline-marketplace: refund reservation, lost responses, crash recovery, lifecycle ordering, attribution.
import fc from "fast-check";
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

const refund = (o: { id: string; lines: string[] }, line: number, amount: number) =>
  t.post(`/orders/${o.id}/refunds`, { line_id: o.lines[line], amount });
type Ev = { payload: string; header: string };
/** Concurrent deliveries: contenders may be told to retry (503, unacknowledged); redelivering them must then succeed. */
const deliverConcurrently = async (evs: Ev[]) => {
  const first = await Promise.all(evs.map((e) => t.deliver(e)));
  expect(first.every((r) => r.status === 200 || r.status === 503)).toBe(true);
  expect(first.some((r) => r.status === 200)).toBe(true);
  for (const [i, r] of first.entries()) if (r.status !== 200) expect((await t.deliver(evs[i]!)).status).toBe(200);
};
const refundEvent = (type: string, id: string, evId?: string) => fake.signedEvent(type, fake.refunds.get(id)!, evId);
const refundRows = () => t.q("SELECT provider_ref, status, origin, line_id, amount::text a FROM refunds ORDER BY created_at");
const requests = () => t.q("SELECT id, resolved, resolution, post_started, ambiguity_history, rejection_reason, amount::text a FROM refund_requests ORDER BY id");
const sellerA = () => t.balance("seller:seller_a");
const clearing = () => t.balance("provider:clearing");

describe("refund posting", () => {
  it("a line refund reverses exactly the refunded amount against that line's seller and the clearing account", async () => {
    const o = await t.newOrder({ paid: true });
    const r = await refund(o, 0, 200);
    expect(r.status).toBe(200);
    expect(await sellerA()).toBe(-540n + 200n);
    expect(await clearing()).toBe(1000n - 200n);
    expect(await t.orderStatus(o.id)).toBe("partially_refunded");
    expect((await refund(o, 0, 400)).status).toBe(200);
    expect((await refund(o, 1, 400)).status).toBe(200);
    expect(await t.orderStatus(o.id)).toBe("refunded");
    expect(await clearing()).toBe(0n);
    expect(fake.liveRefunded(o.pi)).toBe(1000);
    await t.assertLedgerSound();
  });

  it("never lets refunds exceed a line or the order, and does not call the provider for refused requests", async () => {
    const o = await t.newOrder({ paid: true });
    expect((await refund(o, 1, 401)).status).toBe(400);
    expect((await refund(o, 0, 0)).status).toBe(400);
    expect((await refund(o, 0, -1)).status).toBe(400);
    expect((await t.post(`/orders/${o.id}/refunds`, { line_id: o.lines[0], amount: "1.5" })).status).toBe(400);
    expect((await t.post(`/orders/${o.id}/refunds`, { line_id: "nope", amount: 5 })).status).toBe(404);
    expect(fake.posts(/refunds$/).length).toBe(0);
    expect((await refund(o, 1, 400)).status).toBe(200);
    expect((await refund(o, 1, 1)).status).toBe(400);
    expect((await t.q("SELECT 1 FROM refund_requests")).length).toBe(1);
  });

  it("refuses to refund an unpaid order", async () => {
    const o = await t.newOrder();
    expect((await refund(o, 0, 100)).status).toBe(409);
    expect(fake.posts(/refunds$/).length).toBe(0);
  });

  it("concurrent refund requests cannot over-refund a line or the order", async () => {
    const o = await t.newOrder({ paid: true });
    const rs = await Promise.all([...Array.from({ length: 6 }, () => refund(o, 0, 200)), ...Array.from({ length: 4 }, () => refund(o, 1, 150))]);
    const ok = rs.filter((r) => r.status === 200);
    expect(ok.length).toBe(3 + 2); // 600/200 on A, floor(400/150)=2 on B
    expect(rs.filter((r) => r.status !== 200).every((r) => r.status === 400)).toBe(true);
    expect(fake.liveRefunded(o.pi)).toBe(3 * 200 + 2 * 150);
    expect(await clearing()).toBe(1000n - BigInt(3 * 200 + 2 * 150));
    await t.assertLedgerSound();
  });

  it("each API refund uses its own idempotency key and carries order, line and request identity", async () => {
    const o = await t.newOrder({ paid: true });
    await refund(o, 0, 100);
    await refund(o, 0, 100);
    const posts = fake.posts(/refunds$/);
    expect(new Set(posts.map((p) => p.idem)).size).toBe(2);
    for (const p of posts) {
      expect(p.idem).toBe(p.body["metadata[refund_id]"]);
      expect(p.body["metadata[order_id]"]).toBe(o.id);
      expect(p.body["metadata[line_id]"]).toBe(o.lines[0]);
      expect(p.body.payment_intent).toBe(o.pi);
    }
  });
});

describe("lost / failed refund responses", () => {
  it("a lost response keeps capacity reserved, is never re-posted, and the webhook links it exactly once", async () => {
    const o = await t.newOrder({ paid: true });
    fake.addFault({ method: "POST", path: /refunds$/, mode: "drop-after-apply", times: 1 });
    const r = await refund(o, 0, 600);
    expect(r.status).toBe(502);
    expect(fake.refunds.size).toBe(1); // the provider did apply it
    expect((await requests())[0]).toMatchObject({ resolved: false, post_started: false, ambiguity_history: true });
    // no booking from an unconfirmed attempt
    expect((await t.ledgerRows()).filter((x) => x.kind === "refund").length).toBe(0);
    // capacity is held: the same money cannot be requested again, and the app does not resend the possibly applied POST
    expect((await refund(o, 0, 600)).status).toBe(400);
    await t.app.recoverPendingRefunds();
    await t.q("UPDATE refund_requests SET next_attempt_at = now() - interval '1 minute'");
    await t.app.recoverPendingRefunds();
    expect(fake.posts(/refunds$/).length).toBe(1);
    // exact provider notification resolves it
    const reId = [...fake.refunds.keys()][0]!;
    const ev = refundEvent("refund.created", reId);
    await deliverConcurrently([ev, ev, refundEvent("refund.updated", reId)]);
    expect((await requests())[0]).toMatchObject({ resolved: true, resolution: "linked" });
    expect(await refundRows()).toMatchObject([{ provider_ref: reId, status: "succeeded", origin: "api", line_id: o.lines[0] }]);
    expect(await sellerA()).toBe(-540n + 600n);
    expect(await clearing()).toBe(400n);
    expect(await t.orderStatus(o.id)).toBe("partially_refunded");
    await t.assertLedgerSound();
  });

  it("a 5xx before the effect is also treated as unknown: nothing is re-posted and capacity stays reserved", async () => {
    const o = await t.newOrder({ paid: true });
    fake.addFault({ method: "POST", path: /refunds$/, mode: "500-before", times: 1 });
    expect((await refund(o, 0, 300)).status).toBe(502);
    expect(fake.refunds.size).toBe(0);
    await t.q("UPDATE refund_requests SET next_attempt_at = now() - interval '1 minute'");
    await t.app.recoverPendingRefunds();
    expect(fake.posts(/refunds$/).length).toBe(1);
    expect((await refund(o, 0, 301)).status).toBe(400); // 300 still reserved
    expect((await refund(o, 0, 300)).status).toBe(200); // the remaining 300 is free
  });

  it("a 429 rate limit before execution releases the reservation so the refund can be retried safely", async () => {
    const o = await t.newOrder({ paid: true });
    fake.addFault({ method: "POST", path: /refunds$/, mode: "429-before", times: 1 });
    const r = await refund(o, 0, 600);
    expect(r.status).toBe(409);
    expect((await requests())[0]).toMatchObject({ resolved: true, resolution: "rejected" });
    expect((await t.ledgerRows()).filter((x) => x.kind === "refund").length).toBe(0);
    expect((await refund(o, 0, 600)).status).toBe(200);
    expect(fake.liveRefunded(o.pi)).toBe(600);
    await t.assertLedgerSound();
  });

  it("a definitive provider refusal (amount_too_large) releases the reservation and books nothing", async () => {
    const o = await t.newOrder({ paid: true });
    fake.dashboardRefund(o.pi, 900); // provider-side refund the app has not heard about yet
    const r = await refund(o, 0, 600);
    expect(r.status).toBe(409);
    expect((await requests())[0]).toMatchObject({ resolved: true, resolution: "rejected", rejection_reason: "amount_too_large" });
    expect((await t.ledgerRows()).filter((x) => x.kind === "refund").length).toBe(0);
    expect(await clearing()).toBe(1000n);
  });

  it("a refund created in the dashboard is recorded once, unallocated to any seller, and consumes order capacity", async () => {
    const o = await t.newOrder({ paid: true });
    const d = fake.dashboardRefund(o.pi, 700);
    const ev = fake.signedEvent("refund.updated", d);
    await deliverConcurrently([ev, ev, fake.signedEvent("refund.created", d)]);
    expect(await refundRows()).toMatchObject([{ origin: "provider", line_id: null, a: "700" }]);
    expect(await t.balance("platform:unallocated_refunds")).toBe(700n);
    expect(await clearing()).toBe(300n);
    expect((await refund(o, 0, 301)).status).toBe(400);
    expect((await refund(o, 0, 300)).status).toBe(200);
    expect(await t.orderStatus(o.id)).toBe("refunded");
    await t.assertLedgerSound();
  });

  it("a same-amount dashboard refund is not attributed to an unresolved API request; different amounts are recorded independently", async () => {
    const o = await t.newOrder({ paid: true });
    fake.addFault({ method: "POST", path: /refunds$/, mode: "drop-after-apply", times: 1 });
    expect((await refund(o, 0, 200)).status).toBe(502);
    const apiRefund = [...fake.refunds.keys()][0]!;
    const d200 = fake.dashboardRefund(o.pi, 200);
    const d50 = fake.dashboardRefund(o.pi, 50);
    expect((await t.deliver(fake.signedEvent("refund.created", d200))).status).toBe(503); // retry later, not guessed
    expect((await refundRows()).length).toBe(0);
    expect((await t.deliver(fake.signedEvent("refund.created", d50))).status).toBe(200);
    expect(await refundRows()).toMatchObject([{ provider_ref: d50.id, origin: "provider" }]);
    // the exact event for the API request resolves it; then the held dashboard event is applied separately
    expect((await t.deliver(refundEvent("refund.created", apiRefund))).status).toBe(200);
    expect((await t.deliver(fake.signedEvent("refund.created", d200, "evt_d200_retry"))).status).toBe(200);
    const rows = await refundRows();
    expect(rows.map((r) => `${r.provider_ref}:${r.origin}:${r.a}`).sort()).toEqual([`${apiRefund}:api:200`, `${d200.id}:provider:200`, `${d50.id}:provider:50`].sort());
    expect(await sellerA()).toBe(-540n + 200n);
    expect(await t.balance("platform:unallocated_refunds")).toBe(250n);
    expect(await clearing()).toBe(1000n - 450n);
    await t.assertLedgerSound();
  });

  it("an event whose request metadata names a different amount than the reservation is rejected, not booked", async () => {
    const o = await t.newOrder({ paid: true });
    fake.addFault({ method: "POST", path: /refunds$/, mode: "drop-after-apply", times: 1 });
    await refund(o, 0, 200);
    const reId = [...fake.refunds.keys()][0]!;
    fake.refunds.get(reId)!.amount = 250; // contradictory provider object
    expect((await t.deliver(refundEvent("refund.created", reId))).status).not.toBe(200);
    expect((await t.ledgerRows()).filter((x) => x.kind === "refund").length).toBe(0);
    expect((await requests())[0]!.resolved).toBe(false);
  });
});

describe("process crash and restart", () => {
  const reserve = async (o: { id: string; lines: string[]; pi: string }, amount: number, flags = "") => {
    await t.q(
      `INSERT INTO refund_requests (id, order_id, line_id, payment_ref, currency, amount, next_attempt_at ${flags ? ", " + flags.split("=")[0] : ""}) VALUES ('rf_crash1',$1,$2,$3,'INR',$4, now() - interval '1 minute' ${flags ? ", " + flags.split("=")[1] : ""})`,
      [o.id, o.lines[0], o.pi, amount],
    );
  };
  it("a reservation committed before any POST is sent exactly once after restart, with its original identity", async () => {
    const o = await t.newOrder({ paid: true });
    await reserve(o, 250);
    await Promise.all([t.app.recoverPendingRefunds(), t.app.recoverPendingRefunds(), t.app.recoverPendingRefunds()]);
    await t.app.recoverPendingRefunds();
    const posts = fake.posts(/refunds$/);
    expect(posts.length).toBe(1);
    expect(posts[0]!.idem).toBe("rf_crash1");
    expect(posts[0]!.body["metadata[refund_id]"]).toBe("rf_crash1");
    expect((await requests())[0]).toMatchObject({ resolved: true, resolution: "linked" });
    expect(await sellerA()).toBe(-540n + 250n);
    expect(await clearing()).toBe(750n);
    await t.assertLedgerSound();
  });

  it("a reservation whose POST may have started (crash after the marker) is not re-sent and waits for exact reconciliation", async () => {
    const o = await t.newOrder({ paid: true });
    await reserve(o, 250, "post_started=true");
    await t.app.recoverPendingRefunds();
    expect(fake.posts(/refunds$/).length).toBe(0);
    expect((await requests())[0]).toMatchObject({ resolved: false, ambiguity_history: true });
    // capacity remains held
    expect((await refund(o, 0, 351)).status).toBe(400);
    // the provider did apply it before the crash; its webhook arrives
    const applied = fake.dashboardRefund(o.pi, 250);
    applied.metadata = { order_id: o.id, line_id: o.lines[0]!, refund_id: "rf_crash1" };
    expect((await t.deliver(fake.signedEvent("refund.created", applied))).status).toBe(200);
    expect((await requests())[0]).toMatchObject({ resolved: true, resolution: "linked" });
    expect(await refundRows()).toMatchObject([{ origin: "api", line_id: o.lines[0] }]);
    expect(await clearing()).toBe(750n);
    await t.assertLedgerSound();
  });
});

describe("refund lifecycle (pending, failed, out of order)", () => {
  it("pending refunds are recognised once; success later does not book again", async () => {
    const o = await t.newOrder({ paid: true });
    fake.refundInitialStatus = "pending";
    expect((await refund(o, 0, 300)).status).toBe(200);
    const reId = [...fake.refunds.keys()][0]!;
    expect(await clearing()).toBe(700n);
    expect(await t.orderStatus(o.id)).toBe("partially_refunded");
    fake.setRefundStatus(reId, "succeeded");
    for (let i = 0; i < 3; i++) expect((await t.deliver(refundEvent("refund.updated", reId))).status).toBe(200);
    expect(await clearing()).toBe(700n);
    expect((await refundRows())[0]!.status).toBe("succeeded");
    await t.assertLedgerSound();
  });

  it("a refund that fails later is reversed exactly once, capacity returns, and stale success events cannot resurrect it", async () => {
    const o = await t.newOrder({ paid: true });
    fake.refundInitialStatus = "pending";
    await refund(o, 0, 600);
    const reId = [...fake.refunds.keys()][0]!;
    const stalePending = refundEvent("refund.created", reId, "evt_stale_pending");
    fake.setRefundStatus(reId, "failed");
    const failed = refundEvent("refund.failed", reId, "evt_failed");
    await deliverConcurrently([failed, failed, refundEvent("refund.updated", reId)]);
    // a delayed older delivery claiming success
    const staleSuccess = fake.signedEvent("refund.updated", { ...fake.refunds.get(reId)!, status: "succeeded" }, "evt_stale_success");
    expect((await t.deliver(staleSuccess)).status).toBe(200);
    expect((await t.deliver(stalePending)).status).toBe(200);
    expect((await refundRows())[0]!.status).toBe("failed");
    expect(await sellerA()).toBe(-540n);
    expect(await clearing()).toBe(1000n);
    expect(await t.orderStatus(o.id)).toBe("paid");
    expect((await t.ledgerRows()).filter((x) => x.kind === "refund_reversal").length).toBe(2);
    fake.refundInitialStatus = "succeeded";
    expect((await refund(o, 0, 600)).status).toBe(200); // capacity was released by the failure
    await t.assertLedgerSound();
  });

  it("a refund event that arrives before the sale is recorded is not acknowledged, and applies once the sale lands", async () => {
    const o = await t.newOrder();
    fake.pay(o.pi);
    const d = fake.dashboardRefund(o.pi, 100);
    const ev = fake.signedEvent("refund.created", d, "evt_early");
    expect((await t.deliver(ev)).status).toBe(503);
    expect((await t.q("SELECT 1 FROM processed_events WHERE event_id='stripe:evt_early'")).length).toBe(0);
    expect((await t.deliver(fake.signedEvent("payment_intent.succeeded", fake.pis.get(o.pi)!))).status).toBe(200);
    expect((await t.deliver(ev)).status).toBe(200);
    expect(await clearing()).toBe(900n);
    await t.assertLedgerSound();
  });

  it("rejects refund observations in another currency or exceeding the captured total, booking nothing", async () => {
    const o = await t.newOrder({ paid: true });
    const wrongCur = fake.dashboardRefund(o.pi, 100);
    wrongCur.currency = "usd";
    expect((await t.deliver(fake.signedEvent("refund.created", wrongCur))).status).not.toBe(200);
    const over = fake.dashboardRefund(o.pi, 1001);
    expect((await t.deliver(fake.signedEvent("refund.created", over))).status).not.toBe(200);
    expect((await t.ledgerRows()).filter((x) => x.kind === "refund").length).toBe(0);
    expect((await refundRows()).length).toBe(0);
  });

  it("a signed refund body that disagrees with the provider's current object is not applied", async () => {
    const o = await t.newOrder({ paid: true });
    const d = fake.dashboardRefund(o.pi, 100);
    const lie = { ...d, amount: 999 };
    expect((await t.deliver(fake.signedEvent("refund.created", lie))).status).not.toBe(200);
    expect((await t.ledgerRows()).filter((x) => x.kind === "refund").length).toBe(0);
  });

  it("property: any interleaving of refund status transitions and (duplicated, reordered) events ends consistent with the provider", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom("succeeded", "failed", "canceled") as fc.Arbitrary<string>,
        fc.boolean(),
        fc.array(fc.nat({ max: 5 }), { minLength: 2, maxLength: 7 }),
        async (final, viaPending, order) => {
          await t.reset();
          const o = await t.newOrder({ paid: true });
          fake.refundInitialStatus = viaPending ? "pending" : "succeeded";
          const amt = 330;
          expect((await refund(o, 0, amt)).status).toBe(200);
          const reId = [...fake.refunds.keys()][0]!;
          const snapshots = [fake.refunds.get(reId)!.status as string];
          // provider timeline: [pending ->] succeeded [-> failed/canceled]
          const timeline = viaPending ? ["succeeded", final] : [final];
          const evs: { payload: string; header: string }[] = [];
          for (const [i, s] of timeline.entries()) {
            if (i > 0 || s !== fake.refunds.get(reId)!.status) fake.setRefundStatus(reId, s);
            snapshots.push(s);
            evs.push(fake.signedEvent("refund.updated", structuredClone(fake.refunds.get(reId)!), `evt_${i}_${Math.random()}`));
          }
          const all = [...evs, ...evs];
          for (const k of order) await t.deliver(all[k % all.length]!);
          for (const e of evs) await t.deliver(e); // eventually every event is delivered at least once
          const holds = !["failed", "canceled"].includes(final);
          expect((await refundRows())[0]!.status).toBe(final);
          expect(await sellerA()).toBe(-540n + (holds ? BigInt(amt) : 0n));
          expect(await clearing()).toBe(1000n - (holds ? BigInt(amt) : 0n));
          expect(await t.orderStatus(o.id)).toBe(holds ? "partially_refunded" : "paid");
          await t.assertLedgerSound();
        },
      ),
      { numRuns: 25 },
    );
  });
});

describe("races between the API response and provider webhooks", () => {
  it("a webhook that links and fails the refund while the POST response is still in flight is not overwritten by the stale response", async () => {
    const o = await t.newOrder({ paid: true });
    fake.refundInitialStatus = "pending";
    let release!: () => void;
    fake.refundHold = new Promise<void>((r) => (release = r));
    const applied = new Promise<void>((r) => (fake.onRefundApplied = r));
    const inflight = refund(o, 0, 300);
    await applied;
    const reId = [...fake.refunds.keys()][0]!;
    fake.setRefundStatus(reId, "failed");
    expect((await t.deliver(refundEvent("refund.failed", reId))).status).toBe(200);
    release();
    expect((await inflight).status).toBe(200); // the reply body was computed while the refund was still pending
    expect((await refundRows())[0]!.status).toBe("failed");
    expect(await sellerA()).toBe(-540n);
    expect(await clearing()).toBe(1000n);
    expect(await t.orderStatus(o.id)).toBe("paid");
    expect((await requests())[0]).toMatchObject({ resolved: true, resolution: "linked" });
    await t.assertLedgerSound();
  });

  it("a success webhook racing the API response books the refund once", async () => {
    const o = await t.newOrder({ paid: true });
    let release!: () => void;
    fake.refundHold = new Promise<void>((r) => (release = r));
    const applied = new Promise<void>((r) => (fake.onRefundApplied = r));
    const inflight = refund(o, 0, 300);
    await applied;
    const reId = [...fake.refunds.keys()][0]!;
    expect((await t.deliver(refundEvent("refund.created", reId))).status).toBe(200);
    release();
    expect((await inflight).status).toBe(200);
    expect(await sellerA()).toBe(-540n + 300n);
    expect(await clearing()).toBe(700n);
    expect((await refundRows()).length).toBe(1);
    await t.assertLedgerSound();
  });
});
