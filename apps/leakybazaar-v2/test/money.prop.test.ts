import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { MAX_SDK_MINOR, parseMinor, sdkMinor } from "../src/money.ts";

describe("control money boundary", () => {
  it("safe integer SDK round-trips preserve exact minor units", () => {
    fc.assert(
      fc.property(fc.bigInt({ min: 0n, max: MAX_SDK_MINOR }), (value) => {
        expect(parseMinor(sdkMinor(value))).toBe(value);
        expect(parseMinor(value.toString())).toBe(value);
      }),
      { seed: 20261006, numRuns: 1000 },
    );
  });
  it.each([9007199254740992n, -1n])("rejects SDK conversion outside the exact domain: %s", (value) => {
    expect(() => sdkMinor(value)).toThrow();
  });
  it.each([1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, "1e3", "1.1", "-1", {}, null])(
    "rejects invalid wire money: %s",
    (value) => {
      expect(() => parseMinor(value)).toThrow();
    },
  );
});

// Supported canonical refund states conserve live capacity; unknown statuses never become pending.
import { refundHoldsMoney, stripeRefundStatus } from "../src/money.ts";

describe("refund monetary status vocabulary", () => {
  it("all supported statuses retain their meaning", () => {
    fc.assert(
      fc.property(
        fc.constantFrom("pending", "requires_action", "succeeded", "failed", "canceled"),
        (status) => {
          expect(stripeRefundStatus(status)).toBe(status);
          expect(refundHoldsMoney(status)).toBe(status !== "failed" && status !== "canceled");
        },
      ),
    );
    expect(() => stripeRefundStatus("unknown")).toThrow("unsupported provider refund status");
  });
});
