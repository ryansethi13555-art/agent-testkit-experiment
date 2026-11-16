// Real pinned SDKs against a loopback server; no provider network or live credentials.
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { it } from "node:test";
import fc from "fast-check";
import { sdkMinor } from "../src/money.ts";
import { ProviderError, providerFromEnv } from "../src/provider.ts";

const pay = {
  id: "pay_a",
  order_id: "order_a",
  amount: 1000,
  currency: "INR",
  status: "captured",
  captured: true,
};
const refund = { id: "rf_a", payment_id: "pay_a", amount: 200, currency: "INR", status: "processed" };
const request = { amount: 200n, idempotencyKey: "request_a", metadata: { refund_request_id: "request_a" } };

async function withProvider(
  name: "stripe" | "razorpay",
  handler: (req: http.IncomingMessage, res: http.ServerResponse) => void,
  run: (provider: ReturnType<typeof providerFromEnv>) => Promise<void>,
) {
  const server = http.createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    await run(
      providerFromEnv({
        PAYMENT_PROVIDER: name,
        MONEYINV_STRIPE_API_BASE: base,
        MONEYINV_RAZORPAY_API_BASE: base,
        STRIPE_SECRET_KEY: "sk_test_fixture",
        RAZORPAY_KEY_ID: "rzp_test_fixture",
        RAZORPAY_KEY_SECRET: "fixture",
      }),
    );
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}

const json = (res: http.ServerResponse, value: unknown, status = 200) => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(value));
};
const unknown = (e: unknown) => e instanceof ProviderError && e.outcome === "unknown";

it("Razorpay keeps a committed POST unknown when subsequent payment lookup is refused", async () => {
  let posts = 0;
  await withProvider(
    "razorpay",
    (req, res) => {
      if (req.method === "POST") {
        posts++;
        json(res, refund);
      } else if (req.url?.endsWith("/payments")) json(res, { items: [pay] });
      else json(res, { error: { description: "not available" } }, 404);
    },
    async (p) => {
      await assert.rejects(p.createRefund("order_a", request), unknown);
    },
  );
  assert.equal(posts, 1);
});

for (const name of ["stripe", "razorpay"] as const) {
  it(`${name} surfaces connection loss even when an invisible retry would get a refusal`, async () => {
    let posts = 0;
    const keys: unknown[] = [];
    await withProvider(
      name,
      (req, res) => {
        if (req.method !== "POST") {
          json(res, { items: [pay] });
          return;
        }
        posts++;
        keys.push(req.headers[name === "stripe" ? "idempotency-key" : "x-refund-idempotency"]);
        if (posts === 1) {
          req.socket.destroy();
          return;
        }
        json(
          res,
          { error: { type: "invalid_request_error", message: "refused", description: "refused" } },
          400,
        );
      },
      async (p) => {
        await assert.rejects(p.createRefund(name === "stripe" ? "pi_a" : "order_a", request), unknown);
      },
    );
    assert.equal(posts, 1);
    assert.deepEqual(keys, [request.idempotencyKey]);
  });

  it(`${name} retains definitive first-attempt rejection`, async () => {
    await withProvider(
      name,
      (req, res) => {
        if (req.method === "POST")
          json(
            res,
            { error: { type: "invalid_request_error", message: "refused", description: "refused" } },
            400,
          );
        else json(res, { items: [pay] });
      },
      async (p) => {
        await assert.rejects(
          p.createRefund(name === "stripe" ? "pi_a" : "order_a", request),
          (e: unknown) => e instanceof ProviderError && e.outcome === "rejected",
        );
      },
    );
  });
}

it("Razorpay rejects a refund response pointing to another payment even on the same order", async () => {
  await withProvider(
    "razorpay",
    (req, res) => {
      if (req.method === "POST") json(res, { ...refund, payment_id: "pay_other" });
      else json(res, { items: [pay] });
    },
    async (p) => {
      await assert.rejects(p.createRefund("order_a", request), unknown);
    },
  );
});

it("Razorpay checks returned order money before normalizing it", async () => {
  await withProvider(
    "razorpay",
    (_req, res) => json(res, { id: "order_a", amount: 1001, currency: "INR", receipt: null }),
    async (p) => {
      await assert.rejects(
        p.createPayment({ orderId: "shop_a", amount: 1000n, currency: "INR", capture: "automatic" }),
        unknown,
      );
    },
  );
});

it("Razorpay preserves order money before there is a customer payment attempt", async () => {
  await withProvider(
    "razorpay",
    (req, res) => {
      json(
        res,
        req.url?.endsWith("/payments")
          ? { items: [] }
          : {
              id: "order_a",
              amount: 1000,
              currency: "INR",
              notes: { order_id: "shop_a" },
            },
      );
    },
    async (p) => {
      const value = await p.retrievePayment("order_a");
      assert.equal(value.amount, 1000n);
      assert.equal(value.amountCaptured, 0n);
      assert.equal(value.orderId, "shop_a");
    },
  );
});

it("Razorpay refuses a payment list containing another order's objects", async () => {
  await withProvider(
    "razorpay",
    (_req, res) => json(res, { items: [{ ...pay, order_id: "other" }] }),
    async (p) => {
      await assert.rejects(p.retrievePayment("order_a"), unknown);
    },
  );
});

it("Stripe refund rate limit is a single pre-execution rejection", async () => {
  let posts = 0;
  await withProvider(
    "stripe",
    (req, res) => {
      assert.equal(req.method, "POST");
      posts++;
      json(res, { error: { type: "api_error", code: "api_error", message: "rate limited" } }, 429);
    },
    async (p) => {
      await assert.rejects(
        p.createRefund("pi_a", request),
        (e: unknown) => e instanceof ProviderError && e.outcome === "rejected" && e.status === 429,
      );
    },
  );
  assert.equal(posts, 1);
});

it("Razorpay never resends a possibly committed refund across unknown responses", async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.bigInt({ min: 100n, max: 1000n }),
      fc.constantFrom("500", "502", "reset"),
      async (amount, fault) => {
        let posts = 0;
        const keys: unknown[] = [];
        await withProvider(
          "razorpay",
          (req, res) => {
            if (req.method !== "POST") {
              json(res, req.url?.endsWith("/payments") ? { items: [pay] } : pay);
              return;
            }
            posts++;
            keys.push(req.headers["x-refund-idempotency"]);
            // The first POST may have committed before its answer was lost. A repeated POST
            // could create another refund after retention expiry; the adapter must never send it.
            if (posts > 1) json(res, { ...refund, id: "rf_duplicate", amount: sdkMinor(amount) });
            else if (fault === "reset") req.socket.destroy();
            else json(res, { error: { description: "uncertain provider result" } }, Number(fault));
          },
          async (p) => {
            await assert.rejects(p.createRefund("order_a", { ...request, amount }), unknown);
          },
        );
        assert.equal(posts, 1);
        assert.deepEqual(keys, [request.idempotencyKey]);
      },
    ),
    { seed: 804210, numRuns: 30 },
  );
});

for (const name of ["stripe", "razorpay"] as const) {
  it(`${name} checkout does not hide another create POST after ambiguous transport/status faults`, async () => {
    for (const fault of ["reset", "500", "502", "429"] as const) {
      let posts = 0;
      await withProvider(
        name,
        (req, res) => {
          assert.equal(req.method, "POST");
          posts++;
          if (fault === "reset") req.socket.destroy();
          else
            json(
              res,
              {
                error: {
                  type: "api_error",
                  code: "SERVER_ERROR",
                  message: "uncertain",
                  description: "uncertain",
                },
              },
              Number(fault),
            );
        },
        async (p) => {
          await assert.rejects(
            p.createPayment({ orderId: "shop_a", amount: 1000n, currency: "INR", capture: "automatic" }),
          );
        },
      );
      assert.equal(posts, 1);
    }
  });
}
