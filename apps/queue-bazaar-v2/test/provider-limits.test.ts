import assert from "node:assert/strict";
import { it } from "node:test";
import fc from "fast-check";
import { providerFromEnv } from "../src/provider.ts";

it("Razorpay INR refund validation follows the pinned minimum across integer amounts", () => {
  const provider = providerFromEnv({ PAYMENT_PROVIDER: "razorpay" });
  fc.assert(
    fc.property(fc.bigInt({ min: 1n, max: 10000n }), (amount) => {
      assert.equal(provider.refundRequestError?.(amount, "INR") !== undefined, amount < 100n);
    }),
  );
  assert.equal(provider.refundRequestError?.(100n, "INR"), undefined);
  assert.equal(provider.refundRequestError?.(1n, "JPY"), undefined);
  assert.equal(providerFromEnv({ PAYMENT_PROVIDER: "stripe" }).refundRequestError?.(1n, "INR"), undefined);
});
