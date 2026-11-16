// Worker marketplace: refunds. Faults around the refund call, races, ordering, async failure, restart recovery,
// the Razorpay minimum, and a stateful property comparing the books with the provider.
import fc from "fast-check";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { deriveOrderStatus } from "../../worker-marketplace/src/money.ts";
import { providerFromEnv } from "../../worker-marketplace/src/provider.ts";
import { acct, commonLaws } from "../helpers/laws.ts";
import { type Worker, startWorker } from "../helpers/workerApp.ts";

let t: Worker;
beforeAll(async () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
  t = await startWorker();
});
afterAll(async () => {
  await t?.stop();
});
beforeEach(async () => {
  await t.reset();
});
const n = async (sql: string, p: unknown[] = []) => Number((await t.one(sql, p)).c);
const reqs = async () => (await t.db.query("SELECT * FROM refund_requests ORDER BY created_at, id")).rows;
const recon = async () => {
  const app = (await t.db.query("SELECT provider_ref, amount, status FROM refunds")).rows;
  expect(app.length).toBe(t.fake.refunds.size);
  for (const a of app) {
    const r = t.fake.refunds.get(a.provider_ref);
    expect(r, `provider refund ${a.provider_ref}`).toBeTruthy();
    expect(BigInt(a.amount)).toBe(r?.amount);
    expect(a.status).toBe(r?.status);
  }
};
/** per line: live refunds plus unresolved reservations never exceed the line */
const lineBound = async () => {
  const rows = (
    await t.db.query(
      `SELECT l.id, l.amount::text a,
        coalesce((SELECT sum(amount) FROM refunds r WHERE r.line_id=l.id AND r.status IN ('pending','requires_action','succeeded')),0)::text live,
        coalesce((SELECT sum(amount) FROM refund_requests q WHERE q.line_id=l.id AND q.state IN ('requested','unknown')),0)::text res
       FROM order_lines l`,
    )
  ).rows;
  for (const r of rows) expect(BigInt(r.live) + BigInt(r.res), `line ${r.id}`).toBeLessThanOrEqual(BigInt(r.a));
};

describe("API refunds", () => {
  it("reserves, calls the provider with the request id as idempotency key, links and books once", async () => {
    const { order, pi } = await t.paidOrder();
    const r = await t.refund(order.id, `${order.id}_l1`, 200);
    expect(r.status).toBe(200);
    expect(r.body.status).toBe("succeeded");
    expect(t.fake.refunds.size).toBe(1);
    expect([...t.fake.idem.keys()].includes(r.body.request_id)).toBe(true);
    expect((await reqs())[0]).toMatchObject({ state: "sent" });
    expect(await acct(t.db, "provider:clearing")).toBe(800n);
    expect(await acct(t.db, "seller:seller_a")).toBe(-340n);
    expect(await t.status(order.id)).toBe("partially_refunded");
    const ref = [...t.fake.refunds.keys()][0] as string;
    for (let i = 0; i < 3; i++) await t.hook(t.refundEv(ref, pi));
    await t.drain();
    expect(await acct(t.db, "provider:clearing")).toBe(800n);
    expect(await n("SELECT count(*) c FROM refunds")).toBe(1);
    await commonLaws(t.db);
    await recon();
  });
  it("refunds cannot sum past the line (S10); the remainder is accepted; both lines refunded means refunded", async () => {
    const { order, pi } = await t.paidOrder();
    const l1 = `${order.id}_l1`;
    expect((await t.refund(order.id, l1, 300)).status).toBe(200);
    expect((await t.refund(order.id, l1, 300)).status).toBe(200);
    expect((await t.refund(order.id, l1, 1)).status).toBe(400);
    expect((await t.refund(order.id, `${order.id}_l2`, 401)).status).toBe(400);
    expect((await t.refund(order.id, `${order.id}_l2`, 400)).status).toBe(200);
    expect(await t.status(order.id)).toBe("refunded");
    expect(t.fake.liveRefunded(pi)).toBe(1000n);
    await commonLaws(t.db);
    await recon();
  });
  it("concurrent refunds on one line cannot over-refund it (S09)", async () => {
    const { order, pi } = await t.paidOrder();
    const l1 = `${order.id}_l1`;
    const rs = await Promise.all(Array.from({ length: 6 }, () => t.refund(order.id, l1, 200)));
    expect(rs.filter((r) => r.status === 200)).toHaveLength(3);
    expect(rs.filter((r) => r.status === 400)).toHaveLength(3);
    expect(t.fake.liveRefunded(pi)).toBe(600n);
    await lineBound();
    await commonLaws(t.db);
    await recon();
  });
  it("concurrent refunds across both lines respect each line and the payment", async () => {
    const { order, pi } = await t.paidOrder();
    const rs = await Promise.all([
      t.refund(order.id, `${order.id}_l1`, 600),
      t.refund(order.id, `${order.id}_l1`, 1),
      t.refund(order.id, `${order.id}_l2`, 400),
      t.refund(order.id, `${order.id}_l2`, 1),
    ]);
    expect(rs.filter((r) => r.status === 200)).toHaveLength(2);
    expect(t.fake.liveRefunded(pi)).toBeLessThanOrEqual(1000n);
    await lineBound();
    await commonLaws(t.db);
  });
  it.each([[0], [-5], [1.5], ["x"], [null], ["1e2"]])("rejects refund amount %s before reserving anything", async (amount) => {
    const { order } = await t.paidOrder();
    expect((await t.refund(order.id, `${order.id}_l1`, amount)).status).toBe(400);
    expect(t.fake.calls.createRefund).toBe(0);
    expect(await reqs()).toHaveLength(0);
  });
  it("refuses unknown lines, another order's line and unpaid orders without provider calls", async () => {
    const a = await t.paidOrder();
    const b = await t.paidOrder();
    expect((await t.refund(a.order.id, "nope", 10)).status).toBe(404);
    expect((await t.refund(a.order.id, `${b.order.id}_l1`, 10)).status).toBe(404);
    const u = await t.checkedOut();
    expect((await t.refund(u.order.id, `${u.order.id}_l1`, 10)).status).toBe(409);
    expect(t.fake.calls.createRefund).toBe(0);
  });
  it("Razorpay INR refunds below 100 minor units are refused locally, with no reservation and no provider call", async () => {
    const rzp = providerFromEnv({ PAYMENT_PROVIDER: "razorpay", RAZORPAY_KEY_ID: "rzp_test_x", RAZORPAY_KEY_SECRET: "s", RAZORPAY_WEBHOOK_SECRET: "w" });
    t.fake.refundRequestError = rzp.refundRequestError as never;
    const { order } = await t.paidOrder();
    const l1 = `${order.id}_l1`;
    for (const a of [1, 99]) expect((await t.refund(order.id, l1, a)).status).toBe(400);
    expect(await reqs()).toHaveLength(0);
    expect(t.fake.calls.createRefund).toBe(0);
    expect((await t.refund(order.id, l1, 100)).status).toBe(200);
    // other currencies carry no INR minimum
    const usd = await t.paidOrder([{ seller_id: "seller_a", amount: 500 }], "automatic", "USD");
    expect((await t.refund(usd.order.id, `${usd.order.id}_l1`, 5)).status).toBe(200);
  });
});

describe("provider faults around the refund call", () => {
  it("5xx with nothing applied (S08): recorded unknown and reserved, never resent, never booked", async () => {
    const { order } = await t.paidOrder();
    const l1 = `${order.id}_l1`;
    t.fake.fault("createRefund", "before_unknown");
    const r = await t.refund(order.id, l1, 200);
    expect(r.status).toBe(202);
    expect((await reqs())[0]).toMatchObject({ state: "unknown" });
    await t.settle(8);
    expect(t.fake.calls.createRefund).toBe(1);
    expect(t.fake.refunds.size).toBe(0);
    expect(await n("SELECT count(*) c FROM ledger_entries WHERE kind='refund'")).toBe(0);
    expect((await t.refund(order.id, l1, 401)).status).toBe(400); // 200 still reserved
    expect((await t.refund(order.id, l1, 400)).status).toBe(200);
    expect(t.fake.calls.createRefund).toBe(2);
    await lineBound();
    await commonLaws(t.db);
  });
  it("applied then response lost: never resent even after the idempotency key expired; the notice links the original", async () => {
    const { order, pi } = await t.paidOrder();
    const l1 = `${order.id}_l1`;
    t.fake.fault("createRefund", "apply_then_unknown");
    expect((await t.refund(order.id, l1, 250)).status).toBe(202);
    t.fake.idem.clear(); // provider retention window passed: any resend would now create a second refund
    await t.settle(8);
    expect(t.fake.calls.createRefund).toBe(1);
    expect(t.fake.refunds.size).toBe(1);
    expect(await acct(t.db, "provider:clearing")).toBe(1000n); // the app does not know yet
    const ref = [...t.fake.refunds.keys()][0] as string;
    await t.hook(t.refundEv(ref, pi));
    await t.drain();
    const req = (await reqs())[0];
    expect(req).toMatchObject({ state: "sent", provider_ref: ref });
    expect((await t.one("SELECT origin, request_id FROM refunds WHERE provider_ref=$1", [ref]))).toMatchObject({ origin: "shop", request_id: req.id });
    expect(await acct(t.db, "provider:clearing")).toBe(750n);
    expect(await n("SELECT count(*) c FROM jobs WHERE type='resolve_refund_request' AND state='failed'")).toBe(0);
    await t.hook(t.refundEv(ref, pi));
    await t.drain();
    expect(await n("SELECT count(*) c FROM ledger_entries WHERE kind='refund'")).toBe(2);
    await commonLaws(t.db);
    await recon();
  });
  it("a first definitive rejection releases the reservation; nothing is booked", async () => {
    const { order } = await t.paidOrder();
    const l1 = `${order.id}_l1`;
    t.fake.fault("createRefund", "before_rejected");
    expect((await t.refund(order.id, l1, 600)).status).toBe(409);
    expect((await reqs())[0]).toMatchObject({ state: "rejected" });
    expect((await t.refund(order.id, l1, 600)).status).toBe(200);
    await lineBound();
    await commonLaws(t.db);
  });
  it("an over-limit refund created at the dashboard first makes the app's own request fail cleanly", async () => {
    const { order, pi } = await t.paidOrder();
    const dash = t.fake.dashboardRefund(pi, 900n);
    expect((await t.refund(order.id, `${order.id}_l1`, 600)).status).toBe(409);
    expect(await acct(t.db, "provider:clearing")).toBe(1000n);
    await t.hook(t.refundEv(dash, pi));
    await t.drain();
    expect(await acct(t.db, "provider:clearing")).toBe(100n);
    expect(await acct(t.db, "platform:unallocated_refunds")).toBe(900n);
    // the shop must also count the dashboard refund against the payment
    expect((await t.refund(order.id, `${order.id}_l2`, 101)).status).toBe(400);
    expect((await t.refund(order.id, `${order.id}_l2`, 100)).status).toBe(200);
    await commonLaws(t.db);
    await recon();
  });
  it("a restart finding a request still 'requested' marks it unknown and does not resend it", async () => {
    const { order, pi } = await t.paidOrder();
    const l1 = `${order.id}_l1`;
    await t.db.query("INSERT INTO refund_requests (id, order_id, line_id, currency, amount, state) VALUES ('rr_crash', $1, $2, 'INR', 250, 'requested')", [order.id, l1]);
    expect(await t.app.shop.recoverRefundRequests()).toBe(1);
    expect((await reqs())[0]).toMatchObject({ state: "unknown" });
    await t.settle(8);
    expect(t.fake.calls.createRefund).toBe(0);
    expect((await t.refund(order.id, l1, 351)).status).toBe(400); // reservation retained
    // the provider had applied it before the crash: its notice resolves the reservation
    const ref = t.fake.dashboardRefund(pi, 250n);
    (t.fake.refunds.get(ref) as { requestId?: string }).requestId = "rr_crash";
    await t.hook(t.refundEv(ref, pi));
    await t.drain();
    expect((await reqs())[0]).toMatchObject({ state: "sent", provider_ref: ref });
    await t.settle(2);
    expect(await n("SELECT count(*) c FROM jobs WHERE state='failed'")).toBe(0);
    expect(await acct(t.db, "provider:clearing")).toBe(750n);
    await lineBound();
    await commonLaws(t.db);
  });
});

describe("refund lifecycle and ordering", () => {
  it("a pending refund that later fails is reversed exactly once and the line is refundable again (S13)", async () => {
    const { order, pi } = await t.paidOrder();
    const l1 = `${order.id}_l1`;
    t.fake.newRefundStatus = "pending";
    expect((await t.refund(order.id, l1, 600)).status).toBe(200);
    expect(await t.status(order.id)).toBe("partially_refunded");
    const ref = [...t.fake.refunds.keys()][0] as string;
    t.fake.setRefund(ref, "failed");
    for (let i = 0; i < 3; i++) {
      await t.hook(t.refundEv(ref, pi, undefined, "refund.failed"));
      await t.drain();
    }
    expect(await acct(t.db, "provider:clearing")).toBe(1000n);
    expect(await acct(t.db, "seller:seller_a")).toBe(-540n);
    expect(await t.status(order.id)).toBe("paid");
    expect(await n("SELECT count(*) c FROM ledger_entries WHERE kind='refund_reversal'")).toBe(2);
    t.fake.newRefundStatus = "succeeded";
    expect((await t.refund(order.id, l1, 600)).status).toBe(200);
    await commonLaws(t.db);
    await recon();
  });
  it("a refund notice before any payment notice reconciles the payment first (S03)", async () => {
    const { order, pi } = await t.checkedOut();
    t.fake.pay(pi);
    const ref = t.fake.dashboardRefund(pi, 250n);
    await t.hook(t.refundEv(ref, pi));
    await t.drain();
    expect(await t.status(order.id)).toBe("partially_refunded");
    expect(await n("SELECT count(*) c FROM ledger_entries WHERE kind='sale'")).toBe(3);
    expect(await acct(t.db, "provider:clearing")).toBe(750n);
    await commonLaws(t.db);
    await recon();
  });
  it("the provider's current object wins over an older notice: pending, then succeeded, then stale pending notice", async () => {
    const { order, pi } = await t.paidOrder();
    t.fake.newRefundStatus = "pending";
    await t.refund(order.id, `${order.id}_l1`, 300);
    const ref = [...t.fake.refunds.keys()][0] as string;
    const stale = t.refundEv(ref, pi, "evt_old");
    t.fake.setRefund(ref, "succeeded");
    await t.hook(t.refundEv(ref, pi));
    await t.drain();
    await t.hook(stale);
    await t.drain();
    expect((await t.one("SELECT status FROM refunds WHERE provider_ref=$1", [ref])).status).toBe("succeeded");
    await recon();
    await commonLaws(t.db);
  });
  it("a refund the provider reports as failed can never be revived by a later 'succeeded' snapshot", async () => {
    const { order, pi } = await t.paidOrder();
    t.fake.newRefundStatus = "pending";
    await t.refund(order.id, `${order.id}_l1`, 300);
    const ref = [...t.fake.refunds.keys()][0] as string;
    t.fake.setRefund(ref, "failed");
    await t.hook(t.refundEv(ref, pi));
    await t.drain();
    t.fake.setRefund(ref, "succeeded"); // contradictory, impossible provider data
    await t.hook(t.refundEv(ref, pi));
    await t.settle(3);
    expect((await t.one("SELECT status FROM refunds WHERE provider_ref=$1", [ref])).status).toBe("failed");
    expect(await acct(t.db, "provider:clearing")).toBe(1000n);
    expect(await t.status(order.id)).toBe("paid");
    await commonLaws(t.db);
  });
  it("a refund with a mismatched amount or currency against its request is refused and books nothing", async () => {
    const { order, pi } = await t.paidOrder();
    const l1 = `${order.id}_l1`;
    t.fake.fault("createRefund", "apply_then_unknown");
    await t.refund(order.id, l1, 200);
    const ref = [...t.fake.refunds.keys()][0] as string;
    (t.fake.refunds.get(ref) as { amount: bigint }).amount = 300n; // provider object disagrees with the request
    await t.hook(t.refundEv(ref, pi));
    await t.settle(2);
    expect(await n("SELECT count(*) c FROM refunds")).toBe(0);
    expect(await acct(t.db, "provider:clearing")).toBe(1000n);
  });
  it("duplicate dashboard refund notices record one refund; a failed dashboard refund leaves no residue", async () => {
    const { order, pi } = await t.paidOrder();
    const ref = t.fake.dashboardRefund(pi, 300n, "pending");
    await Promise.all([t.hook(t.refundEv(ref, pi)), t.hook(t.refundEv(ref, pi)), t.hook(t.refundEv(ref, pi, "evt_fixed")), t.hook(t.refundEv(ref, pi, "evt_fixed"))]);
    await t.drain();
    expect(await n("SELECT count(*) c FROM refunds")).toBe(1);
    expect(await t.status(order.id)).toBe("partially_refunded");
    t.fake.setRefund(ref, "failed");
    await t.hook(t.refundEv(ref, pi));
    await t.drain();
    expect(await t.status(order.id)).toBe("paid");
    expect(await acct(t.db, "platform:unallocated_refunds")).toBe(0n);
    await commonLaws(t.db);
  });
});

describe("property: random histories keep the books equal to the provider", () => {
  const op = fc.oneof(
    fc.record({ k: fc.constant("refund" as const), line: fc.integer({ min: 0, max: 1 }), amount: fc.integer({ min: 1, max: 700 }), pending: fc.boolean(), fault: fc.constantFrom("none", "none", "none", "lose", "before") }),
    fc.record({ k: fc.constant("settle" as const), idx: fc.nat(8), to: fc.constantFrom("succeeded", "failed") }),
    fc.record({ k: fc.constant("dash" as const), amount: fc.integer({ min: 1, max: 300 }) }),
    fc.record({ k: fc.constant("notice" as const), idx: fc.nat(8) }),
  );
  it("laws hold after the queue drains, whatever the order of API calls, faults and notices", async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(op, { minLength: 1, maxLength: 9 }), async (ops) => {
        await t.reset();
        const { order, pi } = await t.paidOrder();
        for (const o of ops) {
          const refs = [...t.fake.refunds.keys()];
          if (o.k === "refund") {
            t.fake.newRefundStatus = o.pending ? "pending" : "succeeded";
            if (o.fault === "lose") t.fake.fault("createRefund", "apply_then_unknown");
            if (o.fault === "before") t.fake.fault("createRefund", "before_unknown");
            await t.refund(order.id, `${order.id}_l${o.line + 1}`, o.amount);
          } else if (o.k === "dash") {
            if (BigInt(o.amount) <= 1000n - t.fake.liveRefunded(pi)) t.fake.dashboardRefund(pi, BigInt(o.amount), "pending");
          } else if (refs.length) {
            const ref = refs[o.idx % refs.length] as string;
            if (o.k === "settle" && t.fake.refunds.get(ref)?.status === "pending") t.fake.setRefund(ref, o.to);
            await t.hook(t.refundEv(ref, pi));
          }
          await t.drain();
        }
        for (const ref of t.fake.refunds.keys()) await t.hook(t.refundEv(ref, pi));
        await t.settle(3);
        await commonLaws(t.db);
        await recon();
        await lineBound();
        const live = t.fake.liveRefunded(pi);
        expect(live <= 1000n).toBe(true);
        expect(await t.status(order.id)).toBe(deriveOrderStatus({ captured: 1000n, refunded: live, payments: ["succeeded"] }));
        expect(await acct(t.db, "provider:clearing")).toBe(1000n - live);
        // the app never asked the provider twice for one request
        const keys = [...new Set((await reqs()).map((r) => r.id as string))];
        expect(t.fake.calls.createRefund).toBeLessThanOrEqual(keys.length + 0);
      }),
      { numRuns: 25 },
    );
  }, 240000);
});
