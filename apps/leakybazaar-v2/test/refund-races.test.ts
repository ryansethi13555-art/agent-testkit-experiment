// Deterministic clean-control regressions. No benchmark patches, packs or sealed cases are used.
// Pool wrappers park explicit SQL boundaries; provider callbacks order response/webhook delivery.

import type { AddressInfo } from "node:net";
import fc from "fast-check";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { leakybazaarProfile } from "../moneyinvariant.profile.ts";
import type { Payment, PaymentProvider, Refund, WebhookEvent } from "../src/provider.ts";

const hooks = vi.hoisted(() => ({
  before: async (_sql: string) => {},
  after: async (_sql: string) => {},
  provider: undefined as PaymentProvider | undefined,
}));
vi.mock("pg", async (load) => {
  const actual = await load<typeof import("pg")>();
  function wrap<T extends object>(target: T): T {
    return new Proxy(target, {
      get(obj, key) {
        const value: unknown = Reflect.get(obj, key);
        if (typeof value !== "function") return value;
        if (key === "query")
          return async (...args: unknown[]) => {
            const sql = String(args[0]);
            await hooks.before(sql);
            const result: unknown = await Reflect.apply(value, obj, args);
            await hooks.after(sql);
            return result;
          };
        if (key === "connect")
          return async (...args: unknown[]) => wrap(await Reflect.apply(value, obj, args));
        return value.bind(obj);
      },
    });
  }
  const Pool = new Proxy(actual.default.Pool, {
    construct(target, args) {
      return wrap(Reflect.construct(target, args));
    },
  });
  return { ...actual, default: { ...actual.default, Pool } };
});
vi.mock("../../leakybazaar/src/provider.ts", () => ({
  providerFromEnv: () => hooks.provider,
  SignatureError: class extends Error {},
}));
vi.mock("../src/provider.ts", () => ({
  providerFromEnv: () => hooks.provider,
  SignatureError: class extends Error {},
}));

function latch() {
  let resolve = () => {};
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
const ADMIN = process.env.MI_PG_ADMIN_URL ?? "postgres://postgres@127.0.0.1:5432/postgres";
let pgUp = true;
const probe = new pg.Client({ connectionString: ADMIN });
try {
  await probe.connect();
} catch {
  pgUp = false;
} finally {
  await probe.end();
}
if (!pgUp) console.warn("Skipping refund race regressions: local Postgres unavailable");

for (const version of ["v1", "v2"] as const) {
  describe.skipIf(!pgUp)(`LeakyBazaar ${version}: controlled refund interleavings`, () => {
    const DB = `lb_races_${version}_${process.pid}`;
    let app: Pick<typeof import("../src/server.ts"), "server" | "migrate" | "stop">;
    let db: pg.Client;
    let base: string;
    let created: Refund[];
    let refundCalls: {
      ref: string;
      amount: bigint;
      idempotencyKey: string;
      metadata: Record<string, string>;
      targetRef?: string;
    }[];
    let onRefund: (r: Refund) => Promise<void>;
    let lostResponse: boolean;
    let responseOverride: Partial<Refund>;
    let refundErrors: unknown[];
    let currentRefunds: Map<string, Refund>;
    let beforeRetrieve: (ref: string) => Promise<void>;
    const event = (
      status: Refund["status"] = "succeeded",
      paymentRef = "pi_test",
      type = "refund.created",
    ): Extract<WebhookEvent, { kind: "refund_changed" }> => ({
      eventId: `${type}_${status}`,
      kind: "refund_changed",
      objectId: "re_test",
      type,
      refund: { ref: "re_test", paymentRef, amount: 200n, currency: "INR", status },
    });
    async function post(path: string, body: unknown) {
      const r = await fetch(base + path, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body, (_k, v: unknown) => (typeof v === "bigint" ? v.toString() : v)),
      });
      return { status: r.status, body: (await r.json()) as Record<string, unknown> };
    }
    const webhook = (ev: WebhookEvent = event(), updateCurrent = true) => {
      if (ev.kind === "refund_changed" && updateCurrent) currentRefunds.set(ev.refund.ref, ev.refund);
      return post("/webhooks/stripe", ev);
    };
    async function simultaneous(a: WebhookEvent, b: WebhookEvent) {
      const secondTried = latch();
      const previousAfter = hooks.after,
        previousRetrieve = beforeRetrieve;
      let attempted = 0;
      if (version === "v2") {
        hooks.after = async (sql) => {
          await previousAfter(sql);
          if (sql.startsWith("SELECT pg_try_advisory_lock") && ++attempted === 2) secondTried.resolve();
        };
        beforeRetrieve = async (ref) => {
          await secondTried.promise;
          await previousRetrieve(ref);
        };
      }
      const responses = await Promise.all([webhook(a), webhook(b)]);
      hooks.after = previousAfter;
      beforeRetrieve = previousRetrieve;
      if (version === "v2") {
        expect(responses.map((r) => r.status).sort()).toEqual([200, 503]);
        const retry = responses[0]?.status === 503 ? a : b;
        const accepted = await webhook(retry, false);
        expect(accepted.status).toBe(200);
        return responses.map((out) => (out.status === 503 ? accepted : out));
      }
      return responses;
    }
    const apiRefund = (amount = "200") => post("/orders/ord_test/refunds", { line_id: "line_test", amount });
    async function clearing() {
      return BigInt(
        (
          await db.query(
            "SELECT coalesce(sum(amount),0)::text s FROM ledger_entries WHERE kind='refund' AND account='provider:clearing'",
          )
        ).rows[0].s,
      );
    }
    beforeAll(async () => {
      const admin = new pg.Client({ connectionString: ADMIN });
      await admin.connect();
      await admin.query(`CREATE DATABASE ${DB}`);
      await admin.end();
      process.env.DATABASE_URL = ADMIN.replace(/\/[^/]*$/, `/${DB}`);
      hooks.provider = {
        name: "stripe",
        async createPayment() {
          throw new Error("unused");
        },
        async retrievePayment() {
          throw new Error("unused");
        },
        async retrieveRefund(ref) {
          await beforeRetrieve(ref);
          const current = currentRefunds.get(ref);
          if (!current) throw new Error("refund object unavailable");
          return { ...current };
        },
        async capture() {
          throw new Error("unused");
        },
        async cancel() {},
        refundTarget: async (ref) => ref,
        async refund(ref, p) {
          refundCalls.push({ ref, ...p });
          if (refundErrors.length) throw refundErrors.shift();
          const r = {
            ref: "re_test",
            paymentRef: "pi_test",
            amount: p.amount,
            currency: "INR",
            status: "succeeded" as const,
            requestId: p.metadata.refund_id,
          };
          created.push(r);
          currentRefunds.set(r.ref, r);
          await onRefund(r);
          if (lostResponse) throw new Error("test provider response lost after commit");
          return { ...r, ...responseOverride };
        },
        async parseWebhook(raw) {
          const ev = JSON.parse(raw) as WebhookEvent;
          if (ev.kind === "refund_changed")
            return { ...ev, refund: { ...ev.refund, amount: BigInt(ev.refund.amount) } };
          if (ev.kind === "payment_succeeded" || ev.kind === "payment_observed")
            return {
              ...ev,
              payment: {
                ...ev.payment,
                amount: BigInt(ev.payment.amount),
                amountReceived: BigInt(ev.payment.amountReceived),
              },
            };
          return ev;
        },
        isProviderError: () => true,
        definitiveRefundRejection: (e) => (e as { definitiveRefundReason?: string })?.definitiveRefundReason,
      };
      app =
        version === "v1" ? await import("../../leakybazaar/src/server.ts") : await import("../src/server.ts");
      await app.migrate();
      // Explicit recovery calls own this suite's schedules; a wall-clock scan must not race them.
      // Keep network timeouts and Date real, and leave production timer behavior unchanged.
      if (version === "v2") vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
      await new Promise<void>((r) => app.server.listen(0, "127.0.0.1", r));
      base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
      db = new pg.Client({ connectionString: process.env.DATABASE_URL });
      await db.connect();
    });
    beforeEach(async () => {
      hooks.before = async () => {};
      hooks.after = async () => {};
      onRefund = async () => {};
      created = [];
      refundCalls = [];
      lostResponse = false;
      responseOverride = {};
      refundErrors = [];
      currentRefunds = new Map();
      beforeRetrieve = async () => {};
      if (hooks.provider) {
        hooks.provider.refundTarget = async (ref) => ref;
        delete hooks.provider.refundRequestError;
      }
      await db.query("TRUNCATE orders, order_lines, refunds, ledger_entries, processed_events CASCADE");
      await db.query(
        "INSERT INTO orders(id,buyer,currency,total,status,payment_intent_id) VALUES ('ord_test','buyer','INR',1000,'paid','pi_test')",
      );
      await db.query(
        "INSERT INTO order_lines(id,order_id,seller_id,currency,amount) VALUES ('line_test','ord_test','seller_a','INR',1000)",
      );
    });
    afterAll(async () => {
      hooks.before = async () => {};
      hooks.after = async () => {};
      await db.end();
      await app.stop();
      if (version === "v2") vi.useRealTimers();
      const admin = new pg.Client({ connectionString: ADMIN });
      await admin.connect();
      await admin.query(`DROP DATABASE ${DB} WITH (FORCE)`);
      await admin.end();
    });

    it("F1/A: webhook reads during an API refund's uncommitted posting", async () => {
      const posted = latch(),
        release = latch(),
        hookReached = latch();
      let parked = false;
      hooks.after = async (sql) => {
        if (
          !parked &&
          sql.startsWith("INSERT INTO ledger_entries") &&
          sql.includes("'provider:clearing'") &&
          sql.includes("'refund'")
        ) {
          parked = true;
          posted.resolve();
          await release.promise;
        }
        if (version === "v1" && sql === "SELECT * FROM refunds WHERE provider_ref=$1") hookReached.resolve();
      };
      hooks.before = async (sql) => {
        if (version === "v2" && parked && sql.startsWith("SELECT * FROM orders WHERE payment_intent_id"))
          hookReached.resolve();
      };
      const api = apiRefund();
      await posted.promise;
      const hook = webhook();
      await hookReached.promise;
      release.resolve();
      expect((await api).status).toBe(200);
      expect((await hook).status).toBe(200);
      expect(await clearing()).toBe(version === "v1" ? -400n : -200n);
    });

    it("F1/B: webhook completes before the provider API response", async () => {
      let hookStatus = 0;
      onRefund = async (r) => {
        hookStatus = (await webhook({ ...event(), refund: r })).status;
      };
      const result = await apiRefund();
      expect(hookStatus).toBe(200);
      expect(result.status).toBe(version === "v1" ? 502 : 200);
      expect(await clearing()).toBe(-200n);
      const rows = (await db.query("SELECT origin,line_id FROM refunds WHERE provider_ref='re_test'")).rows;
      expect(rows).toEqual([
        { origin: version === "v1" ? "provider" : "api", line_id: version === "v1" ? null : "line_test" },
      ]);
    });

    it("F2: lost API response then concurrent created/processed lifecycle events", async () => {
      lostResponse = true;
      expect((await apiRefund()).status).toBe(502);
      const both = latch();
      let arrivals = 0;
      const barrier = async () => {
        if (++arrivals === 2) both.resolve();
        await both.promise;
      };
      hooks.after = async (sql) => {
        if (version === "v1" && sql === "SELECT * FROM refunds WHERE provider_ref=$1") await barrier();
      };
      hooks.before = async (sql) => {
        if (version === "v2" && sql.startsWith("SELECT pg_try_advisory_lock")) await barrier();
      };
      const results = await simultaneous(
        { ...event("pending"), refund: { ...(created[0] as Refund), status: "pending" } },
        { ...event("succeeded", "pi_test", "refund.processed"), refund: created[0] as Refund },
      );
      expect(results.map((r) => r.status)).toEqual([200, 200]);
      expect(await clearing()).toBe(version === "v1" ? -400n : -200n);
      expect((await db.query("SELECT count(*)::int n FROM refunds")).rows[0].n).toBe(1);
      if (version === "v2")
        expect(
          (await db.query("SELECT count(*)::int n FROM refund_requests WHERE NOT resolved")).rows[0].n,
        ).toBe(0);
      expect(
        (await db.query("SELECT status FROM refunds WHERE provider_ref='re_test'")).rows[0].status,
      ).toEqual(version === "v1" ? expect.any(String) : "succeeded");
    });

    it("different lifecycle events for an unrecognised dashboard refund book once", async () => {
      const both = latch();
      let arrivals = 0;
      const barrier = async () => {
        if (++arrivals === 2) both.resolve();
        await both.promise;
      };
      hooks.after = async (sql) => {
        if (version === "v1" && sql === "SELECT * FROM refunds WHERE provider_ref=$1") await barrier();
      };
      hooks.before = async (sql) => {
        if (version === "v2" && sql.startsWith("SELECT pg_try_advisory_lock")) await barrier();
      };
      expect(
        (await simultaneous(event("pending"), event("succeeded", "pi_test", "refund.processed"))).map(
          (r) => r.status,
        ),
      ).toEqual([200, 200]);
      expect(await clearing()).toBe(version === "v1" ? -400n : -200n);
    });

    it.each(["unknown", "unpaid"])(
      "F3: concurrent same-id %s-payment event cannot receive a premature acknowledgement",
      async (state) => {
        if (state === "unpaid") await db.query("UPDATE orders SET status='pending_payment'");
        const firstInserted = latch(),
          release = latch(),
          duplicateAttempted = latch();
        let markers = 0;
        hooks.before = async (sql) => {
          const boundary = version === "v1" ? "INSERT INTO processed_events" : "SELECT pg_try_advisory_lock";
          if (sql.startsWith(boundary) && ++markers === 2) duplicateAttempted.resolve();
        };
        let parked = false;
        hooks.after = async (sql) => {
          if (sql.startsWith("INSERT INTO processed_events") && !parked) {
            parked = true;
            firstInserted.resolve();
            await release.promise;
          }
        };
        const ev = event("succeeded", state === "unknown" ? "pi_unknown" : "pi_test");
        const first = webhook(ev);
        await firstInserted.promise;
        const second = webhook(ev);
        await duplicateAttempted.promise;
        if (version === "v1") expect((await second).status).toBe(200);
        release.resolve();
        expect((await first).status).toBe(503);
        if (version === "v2") expect((await second).status).toBe(503);
        expect((await db.query("SELECT count(*)::int n FROM processed_events")).rows[0].n).toBe(0);
        hooks.before = async () => {};
        hooks.after = async () => {};
        if (state === "unknown") await db.query("UPDATE orders SET payment_intent_id='pi_unknown'");
        else await db.query("UPDATE orders SET status='paid'");
        expect((await webhook(ev)).status).toBe(200);
        expect(await clearing()).toBe(-200n);
      },
    );

    it("sequential lifecycle duplicates and stale pending events retain one recognition and one reversal", async () => {
      for (const ev of [
        event("pending"),
        event("succeeded", "pi_test", "refund.processed"),
        event("pending"),
        event("failed", "pi_test", "refund.failed"),
        event("failed", "pi_test", "refund.failed"),
      ])
        expect((await webhook(ev)).status).toBe(200);
      expect(await clearing()).toBe(-200n);
      expect((await db.query("SELECT status FROM refunds")).rows[0].status).toBe("failed");
      expect(
        BigInt(
          (await db.query("SELECT sum(amount)::text s FROM ledger_entries WHERE account='provider:clearing'"))
            .rows[0].s,
        ),
      ).toBe(0n);
    });
    if (version === "v2") {
      it("provider minimum input rejection precedes reservations and every refund POST", async () => {
        if (!hooks.provider) throw new Error("missing test provider");
        hooks.provider.refundRequestError = (amount, currency) =>
          currency === "INR" && amount < 100n ? "minimum refund is 100 minor units" : undefined;
        for (const amount of ["1", "2", "99"]) expect((await apiRefund(amount)).status).toBe(400);
        expect(refundCalls).toHaveLength(0);
        expect((await db.query("SELECT count(*)::int n FROM refund_requests")).rows[0].n).toBe(0);
        expect(await clearing()).toBe(0n);
        expect((await apiRefund("100")).status).toBe(200);
        expect(refundCalls).toHaveLength(1);
      });
      const checkoutPayment = (ref: string, status: Payment["status"] = "pending"): Payment => ({
        ref,
        status,
        amount: 1000n,
        amountReceived: status === "succeeded" ? 1000n : 0n,
        currency: "INR",
        orderId: "ord_test",
        clientSecret: `${ref}_secret`,
      });
      const paymentEvent = (
        payment: Payment,
        kind: "payment_observed" | "payment_succeeded",
        eventId: string,
      ): WebhookEvent => ({
        kind,
        eventId,
        type: kind === "payment_succeeded" ? "payment_intent.succeeded" : "payment_intent.created",
        objectId: payment.ref,
        payment,
      });
      const pendingCheckout = async () => {
        await db.query(
          "UPDATE orders SET status='pending_payment', payment_intent_id=NULL, checkout_create_started=false WHERE id='ord_test'",
        );
      };
      const checkoutAction = () => post("/orders/ord_test/checkout", {});
      const salePosts = async () =>
        (
          await db.query(
            "SELECT count(*)::int n FROM ledger_entries WHERE kind='sale' AND account='provider:clearing'",
          )
        ).rows[0].n as number;
      const definitivelyRejected = (
        reason: "amount_too_large" | "amount_invalid" | "rate_limited" | "concurrent_operation",
      ) =>
        Object.assign(new Error(`provider rejected refund: ${reason}`), {
          definitiveRefundReason: reason,
        });

      it.each(["amount_too_large", "amount_invalid", "rate_limited", "concurrent_operation"] as const)(
        "rejects a first %s without blocking unrelated dashboard accounting",
        async (reason) => {
          refundErrors = [definitivelyRejected(reason)];
          const dashboard = { ...event(), refund: { ...event().refund, amount: 1000n } };
          const entered = latch();
          const release = latch();
          if (!hooks.provider) throw new Error("missing test provider");
          const originalRefund = hooks.provider.refund;
          hooks.provider.refund = async (ref, p) => {
            entered.resolve();
            await release.promise;
            return originalRefund(ref, p);
          };
          const api = apiRefund(reason === "amount_invalid" ? "99" : "200");
          await entered.promise;
          expect((await webhook(dashboard)).status).toBe(200);
          release.resolve();
          expect((await api).status).toBe(409);
          hooks.provider.refund = originalRefund;
          const request = (
            await db.query(
              "SELECT resolved,resolution,rejection_reason,ambiguity_history FROM refund_requests",
            )
          ).rows[0];
          expect(request).toEqual({
            resolved: true,
            resolution: "rejected",
            rejection_reason: reason,
            ambiguity_history: false,
          });
          expect((await webhook(dashboard)).status).toBe(200);
          expect(await clearing()).toBe(-1000n);
          expect((await db.query("SELECT origin,line_id FROM refunds")).rows).toEqual([
            { origin: "provider", line_id: null },
          ]);
        },
      );

      it.each(["amount_too_large", "amount_invalid", "rate_limited", "concurrent_operation"] as const)(
        "retains a reservation when %s follows an unknown POST",
        async (reason) => {
          const { recoverPendingRefunds } = await import("../src/server.ts");
          refundErrors = [new Error("response lost"), definitivelyRejected(reason)];
          expect((await apiRefund(reason === "amount_invalid" ? "99" : "200")).status).toBe(502);
          await db.query("UPDATE refund_requests SET next_attempt_at=now() - interval '1 second'");
          await recoverPendingRefunds();
          expect(refundCalls).toHaveLength(1); // no second POST can safely determine the first one's fate
          expect(
            (
              await db.query(
                "SELECT resolved,resolution,rejection_reason,ambiguity_history,post_started FROM refund_requests",
              )
            ).rows[0],
          ).toEqual({
            resolved: false,
            resolution: "pending",
            rejection_reason: null,
            ambiguity_history: true,
            post_started: false,
          });
          expect(await clearing()).toBe(0n);
        },
      );

      it("a failed read-only target lookup does not turn the first POST rejection ambiguous", async () => {
        const { recoverPendingRefunds } = await import("../src/server.ts");
        if (!hooks.provider) throw new Error("missing test provider");
        let lookups = 0;
        hooks.provider.refundTarget = async () => {
          if (++lookups === 1) throw new Error("lookup timed out");
          return "pi_test";
        };
        refundErrors = [definitivelyRejected("amount_too_large")];
        expect((await apiRefund()).status).toBe(502);
        expect(
          (await db.query("SELECT ambiguity_history,post_started FROM refund_requests")).rows[0],
        ).toEqual({
          ambiguity_history: false,
          post_started: false,
        });
        await db.query("UPDATE refund_requests SET next_attempt_at=now() - interval '1 second'");
        await recoverPendingRefunds();
        expect(refundCalls).toHaveLength(1);
        expect((await db.query("SELECT resolution,rejection_reason FROM refund_requests")).rows[0]).toEqual({
          resolution: "rejected",
          rejection_reason: "amount_too_large",
        });
      });

      it("a crash after POST start cannot trigger another refund POST", async () => {
        const { recoverPendingRefunds } = await import("../src/server.ts");
        await db.query(
          "INSERT INTO refund_requests(id,order_id,line_id,payment_ref,target_ref,currency,amount,post_started,next_attempt_at) VALUES ('rf_crash_1','ord_test','line_test','pi_test','pi_test','INR',200,true,now() - interval '1 second')",
        );
        refundErrors = [definitivelyRejected("amount_too_large")];
        await recoverPendingRefunds();
        expect(refundCalls).toHaveLength(0);
        expect((await db.query("SELECT resolved,ambiguity_history FROM refund_requests")).rows[0]).toEqual({
          resolved: false,
          ambiguity_history: true,
        });
      });

      it("concurrent checkout submits create one provider order and return its stored identity", async () => {
        await db.query("UPDATE orders SET status='pending_payment', payment_intent_id=NULL");
        const entered = latch(),
          release = latch();
        let creates = 0;
        if (!hooks.provider) throw new Error("missing test provider");
        hooks.provider.createPayment = async () => {
          creates++;
          entered.resolve();
          await release.promise;
          return {
            ref: "order_test",
            status: "pending",
            amount: 1000n,
            amountReceived: 0n,
            currency: "INR",
            orderId: "ord_test",
            clientSecret: "order_test",
          };
        };
        hooks.provider.retrievePayment = async () => ({
          ref: "order_test",
          status: "pending",
          amount: 1000n,
          amountReceived: 0n,
          currency: "INR",
          orderId: "ord_test",
          clientSecret: "order_test",
        });
        const first = post("/orders/ord_test/checkout", {});
        await entered.promise;
        const contenders = await Promise.all(
          Array.from({ length: 24 }, () => post("/orders/ord_test/checkout", {})),
        );
        expect(contenders.map((r) => r.status)).toEqual(Array.from({ length: 24 }, () => 502));
        release.resolve();
        const responses = [await first, await post("/orders/ord_test/checkout", {})];
        expect(responses.map((r) => r.status)).toEqual([200, 200]);
        expect(responses.map((r) => r.body.payment_intent_id)).toEqual(["order_test", "order_test"]);
        expect(creates).toBe(1);
      });

      it("commits checkout attempt before provider I/O and prevents a new create after an unknown outcome", async () => {
        await pendingCheckout();
        if (!hooks.provider) throw new Error("missing test provider");
        let creates = 0;
        hooks.provider.createPayment = async () => {
          creates++;
          expect(
            (
              await db.query(
                "SELECT checkout_create_started,payment_intent_id FROM orders WHERE id='ord_test'",
              )
            ).rows[0],
          ).toEqual({ checkout_create_started: true, payment_intent_id: null });
          if (creates === 1) throw new Error("response lost after provider commit");
          return checkoutPayment("pi_second_after_key_expiry");
        };
        expect((await checkoutAction()).status).toBe(502);
        expect((await checkoutAction()).status).toBe(502);
        expect(creates).toBe(1);
        expect(
          (await db.query("SELECT payment_intent_id FROM orders WHERE id='ord_test'")).rows[0]
            .payment_intent_id,
        ).toBeNull();
      });

      it("a signed success adopts a crash-left checkout identity and posts only once", async () => {
        await pendingCheckout();
        await db.query("UPDATE orders SET checkout_create_started=true WHERE id='ord_test'");
        const success = checkoutPayment("pi_original", "succeeded");
        expect((await checkoutAction()).status).toBe(502);
        expect((await webhook(paymentEvent(success, "payment_succeeded", "evt_paid_one"))).status).toBe(200);
        expect((await webhook(paymentEvent(success, "payment_succeeded", "evt_paid_two"))).status).toBe(200);
        expect(
          (await db.query("SELECT status,payment_intent_id FROM orders WHERE id='ord_test'")).rows[0],
        ).toEqual({
          status: "paid",
          payment_intent_id: "pi_original",
        });
        expect(await salePosts()).toBe(1);
        expect((await db.query("SELECT count(*)::int n FROM processed_events")).rows[0].n).toBe(2);
      });

      it("created and authorised observations recover identity without booking capture", async () => {
        await pendingCheckout();
        await db.query("UPDATE orders SET checkout_create_started=true WHERE id='ord_test'");
        const pending = checkoutPayment("pi_original");
        const authorised = checkoutPayment("pi_original", "requires_capture");
        expect((await webhook(paymentEvent(pending, "payment_observed", "evt_created"))).status).toBe(200);
        expect((await webhook(paymentEvent(authorised, "payment_observed", "evt_authorised"))).status).toBe(
          200,
        );
        expect(
          (await db.query("SELECT status,payment_intent_id FROM orders WHERE id='ord_test'")).rows[0],
        ).toEqual({
          status: "pending_payment",
          payment_intent_id: "pi_original",
        });
        expect(await salePosts()).toBe(0);
        expect(
          (
            await webhook(
              paymentEvent(checkoutPayment("pi_original", "succeeded"), "payment_succeeded", "evt_paid"),
            )
          ).status,
        ).toBe(200);
        expect(await salePosts()).toBe(1);
      });

      it("rejects wrong money and a second payment identity without changing the adopted reference", async () => {
        await pendingCheckout();
        await db.query("UPDATE orders SET checkout_create_started=true WHERE id='ord_test'");
        const original = checkoutPayment("pi_original");
        expect(
          (await webhook(paymentEvent({ ...original, amount: 999n }, "payment_observed", "evt_wrong_amount")))
            .status,
        ).toBe(502);
        expect(
          (await db.query("SELECT payment_intent_id FROM orders WHERE id='ord_test'")).rows[0]
            .payment_intent_id,
        ).toBeNull();
        expect((await webhook(paymentEvent(original, "payment_observed", "evt_original"))).status).toBe(200);
        expect(
          (await webhook(paymentEvent(checkoutPayment("pi_other"), "payment_observed", "evt_other"))).status,
        ).toBe(502);
        expect(
          (
            await webhook(
              paymentEvent(checkoutPayment("pi_other", "succeeded"), "payment_succeeded", "evt_other_paid"),
            )
          ).status,
        ).toBe(502);
        expect(
          (await db.query("SELECT payment_intent_id,status FROM orders WHERE id='ord_test'")).rows[0],
        ).toEqual({
          payment_intent_id: "pi_original",
          status: "pending_payment",
        });
        expect(await salePosts()).toBe(0);
      });

      it("a success webhook can adopt identity before the create response, which must agree", async () => {
        await pendingCheckout();
        if (!hooks.provider) throw new Error("missing test provider");
        hooks.provider.createPayment = async () => {
          const success = checkoutPayment("pi_original", "succeeded");
          expect((await webhook(paymentEvent(success, "payment_succeeded", "evt_early_paid"))).status).toBe(
            200,
          );
          return checkoutPayment("pi_original");
        };
        expect((await checkoutAction()).status).toBe(200);
        expect(
          (await db.query("SELECT payment_intent_id,status FROM orders WHERE id='ord_test'")).rows[0],
        ).toEqual({
          payment_intent_id: "pi_original",
          status: "paid",
        });
        expect(await salePosts()).toBe(1);
      });

      it("ordinary checkout reuse retrieves the stored reference without another create", async () => {
        await pendingCheckout();
        if (!hooks.provider) throw new Error("missing test provider");
        let creates = 0;
        hooks.provider.createPayment = async () => {
          creates++;
          return checkoutPayment("pi_original");
        };
        hooks.provider.retrievePayment = async () => checkoutPayment("pi_original");
        expect((await checkoutAction()).body.payment_intent_id).toBe("pi_original");
        expect((await checkoutAction()).body.payment_intent_id).toBe("pi_original");
        expect(creates).toBe(1);
        expect(await salePosts()).toBe(0);
      });

      it("unknown response awaits exact identity and duplicate webhook posts once", async () => {
        const { recoverPendingRefunds } = await import("../src/server.ts");
        let targetLookups = 0;
        if (!hooks.provider) throw new Error("missing test provider");
        hooks.provider.refundTarget = async () => (++targetLookups === 1 ? "pi_test" : "pi_other");
        lostResponse = true;
        expect((await apiRefund()).status).toBe(502);
        expect(refundCalls).toHaveLength(1);
        expect(await clearing()).toBe(0n);
        lostResponse = false;
        await db.query("UPDATE refund_requests SET next_attempt_at=now() - interval '1 second'");
        await recoverPendingRefunds();
        expect(refundCalls).toHaveLength(1);
        expect(targetLookups).toBe(1);
        expect((await db.query("SELECT resolved FROM refund_requests")).rows[0].resolved).toBe(false);
        expect((await webhook({ ...event(), refund: created[0] as Refund })).status).toBe(200);
        expect((await db.query("SELECT resolved,resolution FROM refund_requests")).rows[0]).toEqual({
          resolved: true,
          resolution: "linked",
        });
        expect((await webhook({ ...event(), refund: created[0] as Refund })).status).toBe(200);
        expect(await clearing()).toBe(-200n);
        expect(
          (await db.query("SELECT count(*)::int n FROM ledger_entries WHERE kind='refund'")).rows[0].n,
        ).toBe(2);
      });

      it("possibly committed refunds are never repeated even if all provider keys have expired", async () => {
        const { recoverPendingRefunds } = await import("../src/server.ts");
        await fc.assert(
          fc.asyncProperty(
            fc.bigInt({ min: 1n, max: 499n }),
            fc.integer({ min: 1, max: 6 }),
            async (amount, attempts) => {
              await db.query("TRUNCATE refunds,refund_requests,ledger_entries,processed_events");
              await db.query("UPDATE orders SET status='paid'");
              created = [];
              refundCalls = [];
              lostResponse = true;
              // The fake has no key cache: every POST creates an effect, as after retention expiry.
              expect((await apiRefund(amount.toString())).status).toBe(502);
              lostResponse = false;
              for (let i = 0; i < attempts; i++) {
                await db.query("UPDATE refund_requests SET next_attempt_at=now() - interval '1 second'");
                await recoverPendingRefunds();
              }
              expect(refundCalls).toHaveLength(1);
              expect(created).toHaveLength(1);
              expect(created.reduce((sum, r) => sum + r.amount, 0n)).toBe(amount);
              expect((await db.query("SELECT resolved FROM refund_requests")).rows[0].resolved).toBe(false);
              expect((await webhook({ ...event(), refund: created[0] as Refund })).status).toBe(200);
              await recoverPendingRefunds();
              expect(refundCalls).toHaveLength(1);
              expect((await db.query("SELECT resolution FROM refund_requests")).rows[0].resolution).toBe(
                "linked",
              );
              expect(await clearing()).toBe(-amount);
            },
          ),
          { numRuns: 30, seed: 20261008 },
        );
      });

      it("recovers a committed reservation left by a crash before the first provider call", async () => {
        const { recoverPendingRefunds } = await import("../src/server.ts");
        await db.query(
          "INSERT INTO refund_requests(id,order_id,line_id,payment_ref,currency,amount,next_attempt_at) VALUES ('rf_restart_1','ord_test','line_test','pi_test','INR',200,now() - interval '1 second')",
        );
        await recoverPendingRefunds();
        expect(refundCalls).toEqual([
          {
            ref: "pi_test",
            amount: 200n,
            idempotencyKey: "rf_restart_1",
            metadata: { order_id: "ord_test", line_id: "line_test", refund_id: "rf_restart_1" },
            targetRef: "pi_test",
          },
        ]);
        expect(
          (await db.query("SELECT resolved FROM refund_requests WHERE id='rf_restart_1'")).rows[0].resolved,
        ).toBe(true);
        expect(await clearing()).toBe(-200n);
      });

      it("background scan recovers a due reservation without another client request", async () => {
        await db.query(
          "INSERT INTO refund_requests(id,order_id,line_id,payment_ref,currency,amount,next_attempt_at) VALUES ('rf_worker_1','ord_test','line_test','pi_test','INR',200,now() + interval '1 second')",
        );
        await vi.waitFor(
          async () => {
            expect(
              (await db.query("SELECT resolved FROM refund_requests WHERE id='rf_worker_1'")).rows[0]
                .resolved,
            ).toBe(true);
          },
          { timeout: 10_000, interval: 50 },
        );
        expect(refundCalls).toHaveLength(1);
        expect(refundCalls[0]?.idempotencyKey).toBe("rf_worker_1");
        expect(await clearing()).toBe(-200n);
      });

      it.each(["paymentRef", "requestId"] as const)(
        "wrong API response %s is rejected before fallback correlation",
        async (field) => {
          responseOverride = { [field]: "other_identity" };
          expect((await apiRefund()).status).toBe(502);
          expect((await db.query("SELECT count(*)::int n FROM refunds")).rows[0].n).toBe(0);
          expect((await db.query("SELECT count(*)::int n FROM ledger_entries")).rows[0].n).toBe(0);
          expect(
            (await db.query("SELECT count(*)::int n FROM refund_requests WHERE NOT resolved")).rows[0].n,
          ).toBe(1);
        },
      );

      it("fresh event IDs for the same object/type cannot repeat recognition or reversal", async () => {
        for (const status of ["succeeded", "failed"] as const) {
          const both = latch();
          let arrivals = 0;
          hooks.before = async (sql) => {
            if (sql.startsWith("SELECT pg_try_advisory_lock")) {
              if (++arrivals === 2) both.resolve();
              await both.promise;
            }
          };
          const ev = event(status, "pi_test", "refund.updated");
          const results = await simultaneous(
            { ...ev, eventId: `evt_${status}_one` },
            { ...ev, eventId: `evt_${status}_two` },
          );
          expect(results.map((r) => r.status)).toEqual([200, 200]);
          expect(
            (await db.query("SELECT count(*)::int n FROM ledger_entries WHERE kind='refund'")).rows[0].n,
          ).toBe(2);
        }
        expect(
          (await db.query("SELECT count(*)::int n FROM ledger_entries WHERE kind='refund_reversal'")).rows[0]
            .n,
        ).toBe(2);
        expect(
          BigInt(
            (
              await db.query(
                "SELECT sum(amount)::text s FROM ledger_entries WHERE account='provider:clearing'",
              )
            ).rows[0].s,
          ),
        ).toBe(0n);
      });

      it("terminal webhook failure wins over a stale API success response and label", async () => {
        onRefund = async (r) => {
          expect(
            (
              await webhook({
                ...event("failed", "pi_test", "refund.failed"),
                refund: { ...r, status: "failed" },
              })
            ).status,
          ).toBe(200);
        };
        const response = await apiRefund();
        expect(response.status).toBe(200);
        expect(response.body.status).toBe("failed");
        expect((await db.query("SELECT status FROM orders")).rows[0].status).toBe("paid");
        expect((await db.query("SELECT status FROM refunds")).rows[0].status).toBe("failed");
        expect(await clearing()).toBe(0n);
      });

      it("distinct refund.updated lifecycle states both apply, even with one object/type", async () => {
        expect((await webhook(event("pending", "pi_test", "refund.updated"))).status).toBe(200);
        expect((await webhook(event("failed", "pi_test", "refund.updated"))).status).toBe(200);
        expect((await db.query("SELECT status FROM refunds")).rows[0].status).toBe("failed");
        expect((await db.query("SELECT status FROM orders")).rows[0].status).toBe("paid");
        expect(
          BigInt(
            (
              await db.query(
                "SELECT sum(amount)::text s FROM ledger_entries WHERE account='provider:clearing'",
              )
            ).rows[0].s,
          ),
        ).toBe(0n);
      });
      it("unknown payment order rolls back event dedupe and retries after order creation", async () => {
        const ev: WebhookEvent = {
          eventId: "evt_payment_unknown",
          objectId: "pi_unknown",
          type: "payment_intent.succeeded",
          kind: "payment_succeeded",
          payment: {
            ref: "pi_unknown",
            status: "succeeded",
            currency: "INR",
            amount: 1000n,
            amountReceived: 1000n,
            orderId: "ord_unknown",
            clientSecret: null,
          },
        };
        expect((await webhook(ev)).status).toBe(503);
        expect((await db.query("SELECT count(*)::int n FROM processed_events")).rows[0].n).toBe(0);
        await db.query(
          "INSERT INTO orders(id,buyer,currency,total,status,payment_intent_id) VALUES ('ord_unknown','buyer','INR',1000,'pending_payment','pi_unknown')",
        );
        await db.query(
          "INSERT INTO order_lines(id,order_id,seller_id,currency,amount) VALUES ('line_unknown','ord_unknown','seller_a','INR',1000)",
        );
        const response = await post("/webhooks/stripe", ev);
        expect(response.status).toBe(200);
        expect((await db.query("SELECT status FROM orders WHERE id='ord_unknown'")).rows[0].status).toBe(
          "paid",
        );
      });
      it.each(["payment", "amount", "currency"])(
        "mismatched captured %s is rejected without committing effects",
        async (mismatch) => {
          await db.query("UPDATE orders SET status='pending_payment'");
          const ev: WebhookEvent = {
            eventId: "evt_payment_mismatch",
            objectId: "pi_test",
            type: "payment_intent.succeeded",
            kind: "payment_succeeded",
            payment: {
              ref: mismatch === "payment" ? "pi_other" : "pi_test",
              status: "succeeded",
              currency: mismatch === "currency" ? "USD" : "INR",
              amount: 1000n,
              amountReceived: mismatch === "amount" ? 999n : 1000n,
              orderId: "ord_test",
              clientSecret: null,
            },
          };
          expect((await post("/webhooks/stripe", ev)).status).toBe(502);
          expect((await db.query("SELECT count(*)::int n FROM processed_events")).rows[0].n).toBe(0);
          expect((await db.query("SELECT count(*)::int n FROM ledger_entries")).rows[0].n).toBe(0);
        },
      );
      it("dashboard refund consumes order capacity and failure restores its paid label", async () => {
        const ev = { ...event(), refund: { ...event().refund, amount: 900n } };
        expect((await webhook(ev)).status).toBe(200);
        expect((await post("/orders/ord_test/refunds", { line_id: "line_test", amount: "200" })).status).toBe(
          400,
        );
        expect((await db.query("SELECT status FROM orders")).rows[0].status).toBe("partially_refunded");
        expect(
          (
            await webhook({
              ...event("failed", "pi_test", "refund.failed"),
              refund: { ...ev.refund, status: "failed" },
            })
          ).status,
        ).toBe(200);
        expect((await db.query("SELECT status FROM orders")).rows[0].status).toBe("paid");
      });
      it.each(["currency", "amount"])(
        "out-of-domain dashboard refund %s is rejected transactionally",
        async (mismatch) => {
          const ev = {
            ...event(),
            refund: {
              ...event().refund,
              currency: mismatch === "currency" ? "USD" : "INR",
              amount: mismatch === "amount" ? 1001n : 200n,
            },
          };
          expect((await webhook(ev)).status).toBe(502);
          expect((await db.query("SELECT count(*)::int n FROM processed_events")).rows[0].n).toBe(0);
          expect((await db.query("SELECT count(*)::int n FROM refunds")).rows[0].n).toBe(0);
        },
      );
      it("declared probe stays unsettled while a lost-response request remains unresolved", async () => {
        const profile = leakybazaarProfile({
          appDir: "unused",
          appDbUrl: String(process.env.DATABASE_URL),
          observerUrl: String(process.env.DATABASE_URL),
          reset: async () => {},
        });
        expect(await profile.quiescenceProbe?.()).toBe(true);
        lostResponse = true;
        expect((await apiRefund()).status).toBe(502);
        expect(await profile.quiescenceProbe?.()).toBe(false);
        expect((await webhook({ ...event(), refund: created[0] as Refund })).status).toBe(200);
        expect(await profile.quiescenceProbe?.()).toBe(true);
      });
      it.each([1.1, Number.MAX_SAFE_INTEGER + 1, "9007199254740992", "1.1", "-1"])(
        "invalid client amount %s never reaches provider or money rows",
        async (value) => {
          expect(
            (await post("/orders/ord_test/refunds", { line_id: "line_test", amount: value })).status,
          ).toBe(400);
          expect(
            (await post("/orders", { currency: "INR", lines: [{ seller_id: "seller_a", amount: value }] }))
              .status,
          ).toBe(400);
          expect(created).toHaveLength(0);
          expect((await db.query("SELECT count(*)::int n FROM refund_requests")).rows[0].n).toBe(0);
        },
      );

      it("pre-response webhook without reservation metadata asks for retry until API correlation commits", async () => {
        onRefund = async (r) => {
          const { requestId: _requestId, ...uncorrelated } = r;
          expect((await webhook({ ...event(), refund: uncorrelated })).status).toBe(503);
        };
        expect((await apiRefund()).status).toBe(200);
        expect((await webhook()).status).toBe(200);
        expect(await clearing()).toBe(-200n);
        expect((await db.query("SELECT origin,line_id FROM refunds")).rows).toEqual([
          { origin: "api", line_id: "line_test" },
        ]);
      });

      it("records an unrelated full dashboard refund without erasing an uncertain POST", async () => {
        const { recoverPendingRefunds } = await import("../src/server.ts");
        refundErrors = [new Error("unknown POST outcome"), definitivelyRejected("amount_too_large")];
        expect((await apiRefund()).status).toBe(502);
        const dashboard = { ...event(), refund: { ...event().refund, ref: "re_dashboard", amount: 1000n } };
        expect((await webhook(dashboard)).status).toBe(200);
        expect((await webhook({ ...dashboard, eventId: "evt_dashboard_duplicate" })).status).toBe(200);
        expect(await clearing()).toBe(-1000n);
        expect((await db.query("SELECT origin,line_id FROM refunds")).rows).toEqual([
          { origin: "provider", line_id: null },
        ]);
        expect((await db.query("SELECT status FROM orders")).rows[0].status).toBe("refunded");
        await db.query("UPDATE refund_requests SET next_attempt_at=now() - interval '1 second'");
        await recoverPendingRefunds();
        expect((await db.query("SELECT resolved,ambiguity_history FROM refund_requests")).rows[0]).toEqual({
          resolved: false,
          ambiguity_history: true,
        });
        const profile = leakybazaarProfile({
          appDir: "unused",
          appDbUrl: String(process.env.DATABASE_URL),
          observerUrl: String(process.env.DATABASE_URL),
          reset: async () => {},
        });
        expect(await profile.quiescenceProbe?.()).toBe(false);
        expect((await apiRefund("1")).status).toBe(409);
        expect(refundCalls).toHaveLength(1);
      });

      it("different-amount provider observations preserve exact late API attribution", async () => {
        await fc.assert(
          fc.asyncProperty(fc.bigInt({ min: 1n, max: 400n }), async (amount) => {
            await db.query("TRUNCATE refunds,refund_requests,ledger_entries,processed_events");
            await db.query("UPDATE orders SET status='paid'");
            refundErrors = [new Error("unknown POST outcome")];
            expect((await apiRefund(amount.toString())).status).toBe(502);
            const requestId = (await db.query("SELECT id FROM refund_requests")).rows[0].id as string;
            const dashboard = {
              ...event(),
              refund: { ...event().refund, ref: "re_dashboard", amount: amount + 1n },
            };
            expect((await webhook(dashboard)).status).toBe(200);
            expect((await db.query("SELECT resolved FROM refund_requests")).rows[0].resolved).toBe(false);
            expect(
              (
                await webhook({
                  ...event(),
                  eventId: "evt_late_api",
                  refund: { ...event().refund, amount, requestId },
                })
              ).status,
            ).toBe(200);
            expect((await db.query("SELECT resolved,resolution FROM refund_requests")).rows[0]).toEqual({
              resolved: true,
              resolution: "linked",
            });
            expect((await db.query("SELECT origin,line_id FROM refunds ORDER BY provider_ref")).rows).toEqual(
              [
                { origin: "provider", line_id: null },
                { origin: "api", line_id: "line_test" },
              ],
            );
            expect(await clearing()).toBe(-(2n * amount + 1n));
            expect(
              BigInt(
                (await db.query("SELECT coalesce(sum(amount),0)::text s FROM ledger_entries")).rows[0].s,
              ),
            ).toBe(0n);
          }),
          { seed: 20261007, numRuns: 30 },
        );
      });

      it("reservation bounds concurrent API refunds without posting an unknown outcome", async () => {
        const providerStarted = latch(),
          release = latch();
        onRefund = async () => {
          providerStarted.resolve();
          await release.promise;
        };
        const first = post("/orders/ord_test/refunds", { line_id: "line_test", amount: "700" });
        await providerStarted.promise;
        expect((await post("/orders/ord_test/refunds", { line_id: "line_test", amount: "400" })).status).toBe(
          400,
        );
        expect((await db.query("SELECT count(*)::int n FROM refunds")).rows[0].n).toBe(0);
        expect(await clearing()).toBe(0n);
        release.resolve();
        expect((await first).status).toBe(200);
        expect(await clearing()).toBe(-700n);
      });

      it("canceled refund reverses once, releases capacity and cannot be resurrected", async () => {
        expect((await webhook(event("pending"))).status).toBe(200);
        expect((await webhook(event("canceled", "pi_test", "refund.updated"))).status).toBe(200);
        expect((await db.query("SELECT status FROM refunds")).rows[0].status).toBe("canceled");
        expect(
          BigInt(
            (
              await db.query(
                "SELECT sum(amount)::text s FROM ledger_entries WHERE account='provider:clearing'",
              )
            ).rows[0].s,
          ),
        ).toBe(0n);
        expect((await db.query("SELECT status FROM orders")).rows[0].status).toBe("paid");
        expect((await webhook({ ...event("succeeded"), eventId: "stale_succeeded" }, false)).status).toBe(
          200,
        );
        expect((await db.query("SELECT status FROM refunds")).rows[0].status).toBe("canceled");
        responseOverride = { ref: "re_replacement" };
        expect((await apiRefund("1000")).status).toBe(200);
        expect(
          BigInt(
            (
              await db.query(
                "SELECT sum(amount)::text s FROM ledger_entries WHERE account='provider:clearing'",
              )
            ).rows[0].s,
          ),
        ).toBe(-1000n);
      });

      it("delayed success/pending callbacks cannot overwrite the current requires_action object", async () => {
        expect((await webhook(event("succeeded"))).status).toBe(200);
        expect((await webhook(event("requires_action", "pi_test", "refund.updated"))).status).toBe(200);
        for (const status of ["succeeded", "pending"] as const) {
          expect((await webhook({ ...event(status), eventId: `delayed_${status}` }, false)).status).toBe(200);
          expect((await db.query("SELECT status FROM refunds")).rows[0].status).toBe("requires_action");
          expect(await clearing()).toBe(-200n);
        }
        expect((await webhook({ ...event("succeeded"), eventId: "new_success" })).status).toBe(200);
        expect((await db.query("SELECT status FROM refunds")).rows[0].status).toBe("succeeded");
        expect(await clearing()).toBe(-200n);
      });

      it("a current-object identity mismatch has no financial effects or ACK", async () => {
        const original = hooks.provider?.retrieveRefund;
        if (!hooks.provider || !original) throw new Error("missing provider");
        try {
          hooks.provider.retrieveRefund = async (ref) => ({
            ...(await original(ref)),
            paymentRef: "pi_other",
          });
          expect((await webhook(event())).status).toBe(502);
          expect((await db.query("SELECT count(*)::int n FROM refunds")).rows[0].n).toBe(0);
          expect((await db.query("SELECT count(*)::int n FROM processed_events")).rows[0].n).toBe(0);
          expect(await clearing()).toBe(0n);
        } finally {
          hooks.provider.retrieveRefund = original;
        }
      });

      it("a stale POST reply cannot overwrite a current-object callback", async () => {
        onRefund = async (r) => {
          expect(
            (await webhook({ ...event("requires_action"), refund: { ...r, status: "requires_action" } }))
              .status,
          ).toBe(200);
        };
        expect((await apiRefund()).status).toBe(200);
        expect((await db.query("SELECT status FROM refunds")).rows[0].status).toBe("requires_action");
        expect(await clearing()).toBe(-200n);
      });

      it("a contended current-object read refuses delivery before ACK and retries safely", async () => {
        const entered = latch(),
          release = latch();
        beforeRetrieve = async () => {
          entered.resolve();
          await release.promise;
        };
        const first = webhook(event());
        await entered.promise;
        const contenders = await Promise.all(
          Array.from({ length: 24 }, (_, i) => webhook({ ...event(), eventId: `contender_${i}` }, false)),
        );
        expect(contenders.every((out) => out.status === 503)).toBe(true);
        expect((await db.query("SELECT count(*)::int n FROM processed_events")).rows[0].n).toBe(0);
        release.resolve();
        expect((await first).status).toBe(200);
        beforeRetrieve = async () => {};
        expect((await webhook({ ...event(), eventId: "contender_0" }, false)).status).toBe(200);
        expect(await clearing()).toBe(-200n);
        expect((await db.query("SELECT count(*)::int n FROM refunds")).rows[0].n).toBe(1);
      });

      it("a succeeded refund may return to requires_action without fabricating success or reversal", async () => {
        expect((await webhook(event("succeeded"))).status).toBe(200);
        expect((await webhook(event("requires_action", "pi_test", "refund.updated"))).status).toBe(200);
        expect((await db.query("SELECT status FROM refunds")).rows[0].status).toBe("requires_action");
        expect(
          BigInt(
            (
              await db.query(
                "SELECT sum(amount)::text s FROM ledger_entries WHERE account='provider:clearing'",
              )
            ).rows[0].s,
          ),
        ).toBe(-200n);
        expect((await webhook(event("canceled", "pi_test", "refund.updated"))).status).toBe(200);
        expect(
          BigInt(
            (
              await db.query(
                "SELECT sum(amount)::text s FROM ledger_entries WHERE account='provider:clearing'",
              )
            ).rows[0].s,
          ),
        ).toBe(0n);
      });

      it("refund recognition/reversal stays bounded and balanced across lifecycle permutations", async () => {
        await fc.assert(
          fc.asyncProperty(
            fc.array(fc.constantFrom("pending" as const, "succeeded" as const, "failed" as const), {
              minLength: 1,
              maxLength: 8,
            }),
            async (statuses) => {
              await db.query("TRUNCATE refunds,ledger_entries,processed_events");
              for (const status of statuses) {
                const type =
                  status === "pending"
                    ? "refund.created"
                    : status === "succeeded"
                      ? "refund.processed"
                      : "refund.failed";
                expect((await webhook(event(status, "pi_test", type))).status).toBe(200);
                const counts = (
                  await db.query("SELECT kind,count(*)::int n FROM ledger_entries GROUP BY kind")
                ).rows as { kind: string; n: number }[];
                expect(counts.every((r) => r.n <= 2)).toBe(true);
                expect(
                  BigInt(
                    (await db.query("SELECT coalesce(sum(amount),0)::text s FROM ledger_entries")).rows[0].s,
                  ),
                ).toBe(0n);
              }
              expect((await db.query("SELECT status FROM refunds")).rows[0].status).toBe(
                statuses.includes("failed")
                  ? "failed"
                  : statuses.includes("succeeded")
                    ? "succeeded"
                    : "pending",
              );
              const net = BigInt(
                (
                  await db.query(
                    "SELECT coalesce(sum(amount),0)::text s FROM ledger_entries WHERE account='provider:clearing'",
                  )
                ).rows[0].s,
              );
              expect(net).toBe(statuses.includes("failed") ? 0n : -200n);
            },
          ),
          { seed: 20261006, numRuns: 40 },
        );
      });
    }
  });
}
