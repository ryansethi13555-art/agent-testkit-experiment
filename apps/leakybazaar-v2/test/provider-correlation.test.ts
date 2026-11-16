import { createHash, createHmac } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import fc from "fast-check";
import Stripe from "stripe";
import { describe, expect, it } from "vitest";
import { providerFromEnv } from "../src/provider.ts";

const secret = "control_v2_fake_webhook_secret";
describe("API refund reservation identity survives provider webhook decoding", () => {
  it.each(["pending", "requires_action", "succeeded", "failed", "canceled"] as const)(
    "Stripe signed refund webhook preserves %s",
    async (status) => {
      const provider = providerFromEnv({
        PAYMENT_PROVIDER: "stripe",
        STRIPE_SECRET_KEY: "sk_test_control",
        STRIPE_WEBHOOK_SECRET: secret,
      });
      const payload = JSON.stringify({
        id: `evt_${status}`,
        type: "refund.updated",
        data: {
          object: {
            id: "re_status",
            object: "refund",
            payment_intent: "pi_status",
            amount: 1000,
            currency: "inr",
            status,
          },
        },
      });
      const header = Stripe.webhooks.generateTestHeaderString({ payload, secret });
      const notice = await provider.parseWebhook(payload, { "stripe-signature": header });
      expect(notice.kind).toBe("refund_changed");
      if (notice.kind === "refund_changed") expect(notice.refund.status).toBe(status);
    },
  );
  it("Razorpay INR refund inputs obey the documented minimum before network I/O", () => {
    const provider = providerFromEnv({
      PAYMENT_PROVIDER: "razorpay",
      RAZORPAY_KEY_ID: "rzp_test_control_v2",
      RAZORPAY_KEY_SECRET: "fake_control_v2",
    });
    fc.assert(
      fc.property(fc.bigInt({ min: 1n, max: 10000n }), (amount) => {
        expect(Boolean(provider.refundRequestError?.(amount, "INR"))).toBe(amount < 100n);
      }),
    );
    expect(provider.refundRequestError?.(99n, "INR")).toContain("100 minor units");
    expect(provider.refundRequestError?.(100n, "INR")).toBeUndefined();
    expect(provider.refundRequestError?.(1n, "USD")).toBeUndefined();
    expect(provider.refundRequestError?.(1n, "JPY")).toBeUndefined();
  });
  it.each([
    {
      name: "stripe",
      body: { error: { type: "api_error", code: "api_error", message: "too many requests" } },
      status: 429,
      expected: "rate_limited",
    },
    {
      name: "stripe",
      body: {
        error: {
          type: "invalid_request_error",
          code: "amount_too_large",
          message: "insufficient refundable amount",
        },
      },
      expected: "amount_too_large",
    },
    {
      name: "stripe",
      body: {
        error: { type: "idempotency_error", code: "idempotency_key_in_use", message: "key is in use" },
      },
      expected: undefined,
    },
    {
      name: "razorpay",
      body: {
        error: {
          code: "BAD_REQUEST_ERROR",
          description: "The refund amount provided is greater than amount captured.",
          reason: "input_validation_failed",
        },
      },
      expected: "amount_too_large",
    },
    {
      name: "razorpay",
      body: {
        error: {
          code: "BAD_REQUEST_ERROR",
          description: "The amount must be atleast INR 1.00",
          reason: "input_validation_failed",
        },
      },
      expected: "amount_invalid",
    },
    {
      name: "razorpay",
      body: {
        error: {
          code: "BAD_REQUEST_ERROR",
          description: "Request failed because another payment operation is in progress.",
          reason: "input_validation_failed",
        },
      },
      expected: "concurrent_operation",
    },
    {
      name: "razorpay",
      status: 500,
      body: {
        error: {
          code: "BAD_REQUEST_ERROR",
          description: "Request failed because another payment operation is in progress.",
          reason: "input_validation_failed",
        },
      },
      expected: undefined,
    },
    {
      name: "razorpay",
      body: {
        error: {
          code: "BAD_REQUEST_ERROR",
          description: "Idempotency key conflict",
          reason: "input_validation_failed",
        },
      },
      expected: undefined,
    },
  ] as const)("$name SDK classifies only a definite refund rejection ($expected)", async (entry) => {
    const { name, body, expected } = entry;
    const fake = http.createServer(async (req, res) => {
      for await (const _chunk of req) {
        /* consume request */
      }
      res.writeHead("status" in entry ? entry.status : 400, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    });
    await new Promise<void>((r) => fake.listen(0, "127.0.0.1", r));
    try {
      const base = `http://127.0.0.1:${(fake.address() as AddressInfo).port}`;
      const provider = providerFromEnv({
        PAYMENT_PROVIDER: name,
        STRIPE_SECRET_KEY: "sk_test_control_v2",
        MONEYINV_STRIPE_API_BASE: base,
        RAZORPAY_KEY_ID: "rzp_test_control_v2",
        RAZORPAY_KEY_SECRET: "fake_control_v2",
        MONEYINV_RAZORPAY_API_BASE: `${base}/v1`,
      });
      let thrown: unknown;
      try {
        await provider.refund(name === "stripe" ? "pi_test" : "order_test", {
          amount: 200n,
          idempotencyKey: "rf_test",
          metadata: { order_id: "ord_test", line_id: "line_test", refund_id: "rf_test" },
          targetRef: name === "stripe" ? "pi_test" : "pay_test",
        });
      } catch (e) {
        thrown = e;
      }
      expect(thrown).toBeDefined();
      expect(provider.definitiveRefundRejection(thrown)).toBe(expected);
    } finally {
      await new Promise<void>((r) => fake.close(() => r()));
    }
  });
  it.each(["stripe", "razorpay"] as const)(
    "%s refund sends one SDK POST when the connection drops after the request body",
    async (name) => {
      const keys: (string | undefined)[] = [];
      const fake = http.createServer(async (req, res) => {
        for await (const _chunk of req) {
          /* consume the full POST before losing its response */
        }
        keys.push(
          req.headers[name === "stripe" ? "idempotency-key" : "x-refund-idempotency"] as string | undefined,
        );
        if (keys.length === 1) {
          req.socket.destroy();
          return;
        }
        // An invisible SDK retry would now appear definitively rejected despite the first unknown POST.
        res.writeHead(400, { "content-type": "application/json" });
        res.end(
          JSON.stringify(
            name === "stripe"
              ? {
                  error: { type: "invalid_request_error", code: "amount_too_large", message: "insufficient" },
                }
              : {
                  error: {
                    code: "BAD_REQUEST_ERROR",
                    description: "The refund amount provided is greater than amount captured.",
                    reason: "input_validation_failed",
                  },
                },
          ),
        );
      });
      await new Promise<void>((r) => fake.listen(0, "127.0.0.1", r));
      try {
        const base = `http://127.0.0.1:${(fake.address() as AddressInfo).port}`;
        const provider = providerFromEnv({
          PAYMENT_PROVIDER: name,
          STRIPE_SECRET_KEY: "sk_test_control_v2",
          MONEYINV_STRIPE_API_BASE: base,
          RAZORPAY_KEY_ID: "rzp_test_control_v2",
          RAZORPAY_KEY_SECRET: "fake_control_v2",
          MONEYINV_RAZORPAY_API_BASE: `${base}/v1`,
        });
        let thrown: unknown;
        try {
          await provider.refund(name === "stripe" ? "pi_test" : "order_test", {
            amount: 200n,
            idempotencyKey: "rf_test",
            metadata: { order_id: "ord_test", line_id: "line_test", refund_id: "rf_test" },
            targetRef: name === "stripe" ? "pi_test" : "pay_test",
          });
        } catch (e) {
          thrown = e;
        }
        expect(thrown).toBeDefined();
        expect(keys).toEqual(["rf_test"]);
        expect(provider.definitiveRefundRejection(thrown)).toBeUndefined();
      } finally {
        await new Promise<void>((r) => fake.close(() => r()));
      }
    },
  );
  it("Stripe checkout surfaces an unknown create without a hidden second POST", async () => {
    let posts = 0;
    const fake = http.createServer(async (req, res) => {
      for await (const _chunk of req) {
        /* consume the full request */
      }
      posts++;
      if (posts === 1) {
        req.socket.destroy();
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          id: "pi_test",
          object: "payment_intent",
          status: "requires_payment_method",
          amount: 1000,
          amount_received: 0,
          currency: "inr",
          metadata: { order_id: "ord_test" },
          client_secret: "pi_test_secret",
        }),
      );
    });
    await new Promise<void>((r) => fake.listen(0, "127.0.0.1", r));
    try {
      const provider = providerFromEnv({
        PAYMENT_PROVIDER: "stripe",
        STRIPE_SECRET_KEY: "sk_test_control_v2",
        MONEYINV_STRIPE_API_BASE: `http://127.0.0.1:${(fake.address() as AddressInfo).port}`,
      });
      await expect(
        provider.createPayment({
          orderId: "ord_test",
          amount: 1000n,
          currency: "INR",
          capture: "automatic",
        }),
      ).rejects.toBeDefined();
      expect(posts).toBe(1);
    } finally {
      await new Promise<void>((r) => fake.close(() => r()));
    }
  });
  it.each(["stripe", "razorpay"] as const)(
    "%s current-refund lookup preserves identity and canonical state",
    async (name) => {
      const paths: string[] = [];
      const fake = http.createServer((req, res) => {
        paths.push(String(req.url));
        res.writeHead(200, { "content-type": "application/json" });
        const obj =
          name === "stripe"
            ? {
                id: "re_current",
                payment_intent: "pi_test",
                amount: 200,
                currency: "inr",
                status: "requires_action",
                metadata: { refund_id: "rf_request" },
              }
            : req.url?.includes("/refunds/")
              ? {
                  id: "re_current",
                  payment_id: "pay_test",
                  amount: 200,
                  currency: "INR",
                  status: "processed",
                  notes: { refund_id: "rf_request" },
                }
              : { id: "pay_test", order_id: "order_test", amount: 1000, currency: "INR", status: "captured" };
        res.end(JSON.stringify(obj));
      });
      await new Promise<void>((r) => fake.listen(0, "127.0.0.1", r));
      try {
        const base = `http://127.0.0.1:${(fake.address() as AddressInfo).port}`;
        const provider = providerFromEnv({
          PAYMENT_PROVIDER: name,
          STRIPE_SECRET_KEY: "sk_test_control_v2",
          MONEYINV_STRIPE_API_BASE: base,
          RAZORPAY_KEY_ID: "rzp_test_control_v2",
          RAZORPAY_KEY_SECRET: "fake_control_v2",
          MONEYINV_RAZORPAY_API_BASE: base,
        });
        expect(await provider.retrieveRefund("re_current")).toEqual({
          ref: "re_current",
          requestId: "rf_request",
          paymentRef: name === "stripe" ? "pi_test" : "order_test",
          amount: 200n,
          currency: "INR",
          status: name === "stripe" ? "requires_action" : "succeeded",
        });
        expect(paths).toEqual(
          name === "stripe"
            ? ["/v1/refunds/re_current"]
            : ["/v1/refunds/re_current", "/v1/payments/pay_test"],
        );
      } finally {
        await new Promise<void>((r) => fake.close(() => r()));
      }
    },
  );

  it.each(["stripe", "razorpay"] as const)(
    "%s checkout issues one POST for each supported ambiguous transport/status fault",
    async (name) => {
      for (const fault of ["reset", "500", "502", "429"] as const) {
        let posts = 0;
        const fake = http.createServer(async (req, res) => {
          for await (const _chunk of req) {
            /* consume full mutation before replying */
          }
          posts++;
          if (fault === "reset") {
            req.socket.destroy();
            return;
          }
          res.writeHead(Number(fault), { "content-type": "application/json" });
          res.end(
            JSON.stringify({
              error: {
                type: "api_error",
                code: "SERVER_ERROR",
                message: "test refusal",
                description: "test refusal",
              },
            }),
          );
        });
        await new Promise<void>((r) => fake.listen(0, "127.0.0.1", r));
        try {
          const base = `http://127.0.0.1:${(fake.address() as AddressInfo).port}`;
          const provider = providerFromEnv({
            PAYMENT_PROVIDER: name,
            STRIPE_SECRET_KEY: "sk_test_control_v2",
            MONEYINV_STRIPE_API_BASE: base,
            RAZORPAY_KEY_ID: "rzp_test_control_v2",
            RAZORPAY_KEY_SECRET: "fake_control_v2",
            MONEYINV_RAZORPAY_API_BASE: base,
          });
          await expect(
            provider.createPayment({
              orderId: "ord_test",
              amount: 1000n,
              currency: "INR",
              capture: "automatic",
            }),
          ).rejects.toBeDefined();
          expect(posts).toBe(1);
        } finally {
          await new Promise<void>((r) => fake.close(() => r()));
        }
      }
    },
  );

  it.each([
    { receipt: null, notes: { order_id: "ord_test" }, expected: "ord_test" },
    { receipt: "ord_test", notes: {}, expected: "ord_test" },
  ])(
    "Razorpay order creation accepts a missing $receipt when the remaining identity agrees",
    async (order) => {
      const fake = http.createServer(async (req, res) => {
        for await (const _chunk of req) {
          /* consume request */
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ id: "order_provider", amount: 1000, currency: "INR", ...order }));
      });
      await new Promise<void>((r) => fake.listen(0, "127.0.0.1", r));
      try {
        const provider = providerFromEnv({
          PAYMENT_PROVIDER: "razorpay",
          RAZORPAY_KEY_ID: "rzp_test_control_v2",
          RAZORPAY_KEY_SECRET: "fake_control_v2",
          MONEYINV_RAZORPAY_API_BASE: `http://127.0.0.1:${(fake.address() as AddressInfo).port}/v1`,
        });
        const payment = await provider.createPayment({
          orderId: "ord_test",
          amount: 1000n,
          currency: "INR",
          capture: "automatic",
        });
        expect(payment.orderId).toBe(order.expected);
      } finally {
        await new Promise<void>((r) => fake.close(() => r()));
      }
    },
  );
  it("Razorpay order creation rejects contradictory receipt and notes", async () => {
    const fake = http.createServer(async (req, res) => {
      for await (const _chunk of req) {
        /* consume request */
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          id: "order_provider",
          amount: 1000,
          currency: "INR",
          receipt: "ord_other",
          notes: { order_id: "ord_test" },
        }),
      );
    });
    await new Promise<void>((r) => fake.listen(0, "127.0.0.1", r));
    try {
      const provider = providerFromEnv({
        PAYMENT_PROVIDER: "razorpay",
        RAZORPAY_KEY_ID: "rzp_test_control_v2",
        RAZORPAY_KEY_SECRET: "fake_control_v2",
        MONEYINV_RAZORPAY_API_BASE: `http://127.0.0.1:${(fake.address() as AddressInfo).port}/v1`,
      });
      await expect(
        provider.createPayment({ orderId: "ord_test", amount: 1000n, currency: "INR", capture: "automatic" }),
      ).rejects.toThrow("receipt and notes disagree");
    } finally {
      await new Promise<void>((r) => fake.close(() => r()));
    }
  });
  it("Stripe created intent exposes correlated identity without a captured-money signal", async () => {
    const provider = providerFromEnv({
      PAYMENT_PROVIDER: "stripe",
      STRIPE_SECRET_KEY: "sk_test_control_v2",
      STRIPE_WEBHOOK_SECRET: secret,
    });
    const payload = JSON.stringify({
      id: "evt_created",
      object: "event",
      type: "payment_intent.created",
      data: {
        object: {
          id: "pi_test",
          object: "payment_intent",
          status: "requires_payment_method",
          amount: 1000,
          amount_received: 0,
          currency: "inr",
          metadata: { order_id: "ord_test" },
          client_secret: "pi_test_secret",
        },
      },
    });
    const signer = new Stripe("sk_test_control_v2");
    const ev = await provider.parseWebhook(payload, {
      "stripe-signature": signer.webhooks.generateTestHeaderString({ payload, secret }),
    });
    expect(ev.kind).toBe("payment_observed");
    if (ev.kind === "payment_observed")
      expect(ev.payment).toMatchObject({
        ref: "pi_test",
        orderId: "ord_test",
        amount: 1000n,
        amountReceived: 0n,
        currency: "INR",
        status: "pending",
      });
  });
  it("Razorpay authorised payment exposes order identity without a captured-money signal", async () => {
    const provider = providerFromEnv({
      PAYMENT_PROVIDER: "razorpay",
      RAZORPAY_KEY_ID: "rzp_test_control_v2",
      RAZORPAY_KEY_SECRET: "fake_control_v2",
      RAZORPAY_WEBHOOK_SECRET: secret,
    });
    const payload = JSON.stringify({
      event: "payment.authorized",
      payload: {
        payment: {
          entity: {
            id: "pay_test",
            order_id: "order_provider",
            status: "authorized",
            amount: 1000,
            currency: "INR",
            notes: { order_id: "ord_test" },
          },
        },
      },
    });
    const ev = await provider.parseWebhook(payload, {
      "x-razorpay-signature": createHmac("sha256", secret).update(payload).digest("hex"),
    });
    expect(ev.kind).toBe("payment_observed");
    if (ev.kind === "payment_observed")
      expect(ev.payment).toMatchObject({
        ref: "order_provider",
        orderId: "ord_test",
        amount: 1000n,
        amountReceived: 0n,
        currency: "INR",
        status: "requires_capture",
      });
  });
  it("Stripe metadata binds the pre-response refund to its API reservation", async () => {
    const provider = providerFromEnv({
      PAYMENT_PROVIDER: "stripe",
      STRIPE_SECRET_KEY: "sk_test_control_v2",
      STRIPE_WEBHOOK_SECRET: secret,
    });
    const payload = JSON.stringify({
      id: "evt_test",
      object: "event",
      type: "refund.created",
      data: {
        object: {
          id: "re_test",
          object: "refund",
          payment_intent: "pi_test",
          amount: 200,
          currency: "inr",
          status: "succeeded",
          metadata: { refund_id: "rf_request" },
        },
      },
    });
    const signer = new Stripe("sk_test_control_v2");
    const ev = await provider.parseWebhook(payload, {
      "stripe-signature": signer.webhooks.generateTestHeaderString({ payload, secret }),
    });
    expect(ev.eventId).toBe("evt_test");
    expect(ev.kind).toBe("refund_changed");
    if (ev.kind === "refund_changed")
      expect(ev.refund).toEqual({
        ref: "re_test",
        requestId: "rf_request",
        paymentRef: "pi_test",
        amount: 200n,
        currency: "INR",
        status: "succeeded",
      });
  });
  it.each(["created", "processed", "failed"])(
    "Razorpay refund.%s notes bind the lost-response refund to its API reservation",
    async (status) => {
      const provider = providerFromEnv({
        PAYMENT_PROVIDER: "razorpay",
        RAZORPAY_KEY_ID: "rzp_test_control_v2",
        RAZORPAY_KEY_SECRET: "fake_control_v2",
        RAZORPAY_WEBHOOK_SECRET: secret,
      });
      const payload = JSON.stringify({
        event: `refund.${status}`,
        payload: {
          payment: { entity: { id: "pay_test", order_id: "order_provider" } },
          refund: {
            entity: {
              id: "re_test",
              payment_id: "pay_test",
              amount: 200,
              currency: "inr",
              status,
              notes: { refund_id: "rf_request" },
            },
          },
        },
      });
      const ev = await provider.parseWebhook(payload, {
        "x-razorpay-signature": createHmac("sha256", secret).update(payload).digest("hex"),
      });
      expect(ev.eventId).toBe(createHash("sha256").update(payload).digest("hex"));
      const identified = await provider.parseWebhook(payload, {
        "x-razorpay-signature": createHmac("sha256", secret).update(payload).digest("hex"),
        "x-razorpay-event-id": "evt_rzp_identified",
      });
      expect(identified.eventId).toBe("evt_rzp_identified");
      expect(ev.kind).toBe("refund_changed");
      if (ev.kind === "refund_changed")
        expect(ev.refund).toEqual({
          ref: "re_test",
          requestId: "rf_request",
          paymentRef: "order_provider",
          amount: 200n,
          currency: "INR",
          status: status === "processed" ? "succeeded" : status === "failed" ? "failed" : "pending",
        });
    },
  );
  it("Razorpay webhook rejects an unrelated payment entity", async () => {
    const provider = providerFromEnv({
      PAYMENT_PROVIDER: "razorpay",
      RAZORPAY_KEY_ID: "rzp_test_control_v2",
      RAZORPAY_KEY_SECRET: "fake_control_v2",
      RAZORPAY_WEBHOOK_SECRET: secret,
    });
    const payload = JSON.stringify({
      event: "refund.processed",
      payload: {
        payment: { entity: { id: "pay_other", order_id: "order_other" } },
        refund: {
          entity: {
            id: "re_test",
            payment_id: "pay_test",
            amount: 200,
            currency: "inr",
            status: "processed",
          },
        },
      },
    });
    await expect(
      provider.parseWebhook(payload, {
        "x-razorpay-signature": createHmac("sha256", secret).update(payload).digest("hex"),
      }),
    ).rejects.toThrow("payment identity");
  });
  it.each([
    { paymentId: "pay_other", refundId: "rf_request", error: "payment identity" },
    { paymentId: "pay_test", refundId: "rf_other", error: "refund_id differs" },
  ])("Razorpay SDK refund response rejects contradictory $error", async ({ paymentId, refundId, error }) => {
    let refundKey: string | undefined;
    const fake = http.createServer(async (req, res) => {
      if (req.url?.endsWith("/refund")) refundKey = req.headers["x-refund-idempotency"] as string | undefined;
      for await (const _chunk of req) {
        /* consume request */
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify(
          req.url?.endsWith("/payments")
            ? {
                items: [
                  {
                    id: "pay_test",
                    order_id: "order_provider",
                    amount: 1000,
                    currency: "INR",
                    status: "captured",
                  },
                ],
              }
            : {
                id: "re_test",
                payment_id: paymentId,
                amount: 200,
                currency: "INR",
                status: "processed",
                notes: { refund_id: refundId },
              },
        ),
      );
    });
    await new Promise<void>((r) => fake.listen(0, "127.0.0.1", r));
    try {
      const provider = providerFromEnv({
        PAYMENT_PROVIDER: "razorpay",
        RAZORPAY_KEY_ID: "rzp_test_control_v2",
        RAZORPAY_KEY_SECRET: "fake_control_v2",
        MONEYINV_RAZORPAY_API_BASE: `http://127.0.0.1:${(fake.address() as AddressInfo).port}/v1`,
      });
      await expect(
        provider.refund("order_provider", {
          amount: 200n,
          idempotencyKey: "rf_request",
          metadata: { refund_id: "rf_request" },
        }),
      ).rejects.toThrow(error);
      expect(refundKey).toBe("rf_request");
    } finally {
      await new Promise<void>((r) => fake.close(() => r()));
    }
  });
});
