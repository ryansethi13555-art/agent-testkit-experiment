// Unit tests for the pure money rules (node:test).
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  commissionOf,
  deriveOrderStatus,
  divHalfEven,
  lineHeadroom,
  MAX_AMOUNT,
  PAYMENT_STATUSES,
  parseMinorUnits,
  paymentMayMove,
  providerMinor,
  REFUND_STATUSES,
  refundHoldsMoney,
  saleLegs,
  sdkMinor,
  sumLegs,
} from "../src/money.ts";

describe("divHalfEven", () => {
  it("rounds half to even and otherwise to nearest", () => {
    assert.equal(divHalfEven(5n, 2n), 2n); // 2.5 → 2
    assert.equal(divHalfEven(7n, 2n), 4n); // 3.5 → 4
    assert.equal(divHalfEven(14n, 10n), 1n); // 1.4 → 1
    assert.equal(divHalfEven(16n, 10n), 2n); // 1.6 → 2
    assert.equal(divHalfEven(0n, 7n), 0n);
  });
  it("rejects negative numerators and non-positive denominators", () => {
    assert.throws(() => divHalfEven(-1n, 2n), RangeError);
    assert.throws(() => divHalfEven(1n, 0n), RangeError);
  });
});

describe("commissionOf", () => {
  it("is 10 % rounded half-even", () => {
    assert.equal(commissionOf(1000n), 100n);
    assert.equal(commissionOf(5n), 0n); // 0.5 → 0
    assert.equal(commissionOf(15n), 2n); // 1.5 → 2
    assert.equal(commissionOf(25n), 2n); // 2.5 → 2
    assert.equal(commissionOf(1n), 0n);
  });
  it("never exceeds the amount and leaves a non-negative seller part", () => {
    for (let a = 1n; a < 5000n; a += 7n) {
      const fee = commissionOf(a);
      assert.ok(fee >= 0n && fee <= a);
    }
  });
});

describe("parseMinorUnits", () => {
  it("accepts non-negative integers and digit strings", () => {
    assert.equal(parseMinorUnits(500), 500n);
    assert.equal(parseMinorUnits("500"), 500n);
    assert.equal(parseMinorUnits(0), 0n);
  });
  it("rejects fractions, negatives, exponents, junk and oversized values", () => {
    for (const v of [
      1.5,
      -1,
      "1e3",
      "-5",
      "12.0",
      "",
      " 5",
      null,
      undefined,
      {},
      [],
      Number.MAX_SAFE_INTEGER,
      "9999999999999",
    ])
      assert.equal(parseMinorUnits(v), undefined, String(v));
  });
});

describe("refund holds money", () => {
  it("pending, requires_action and succeeded hold money; failed and canceled do not", () => {
    assert.deepEqual(
      REFUND_STATUSES.filter((s) => refundHoldsMoney(s)),
      ["pending", "requires_action", "succeeded"],
    );
  });
});

describe("lineHeadroom", () => {
  it("subtracts refunds that hold money and unresolved reservations", () => {
    const refunds = [
      { amount: 300n, status: "succeeded" as const },
      { amount: 100n, status: "pending" as const },
      { amount: 200n, status: "failed" as const },
      { amount: 50n, status: "canceled" as const },
    ];
    assert.equal(lineHeadroom(1000n, refunds, [150n]), 450n);
    assert.equal(lineHeadroom(1000n, [], []), 1000n);
  });
});

describe("payment status moves", () => {
  it("only moves forward; succeeded and canceled are terminal", () => {
    assert.ok(paymentMayMove("pending", "requires_capture"));
    assert.ok(paymentMayMove("requires_capture", "succeeded"));
    assert.ok(paymentMayMove("failed", "succeeded"));
    assert.ok(paymentMayMove("pending", "failed"));
    assert.ok(paymentMayMove("failed", "pending")); // a retried attempt
    assert.ok(!paymentMayMove("succeeded", "requires_capture"));
    assert.ok(!paymentMayMove("succeeded", "pending"));
    assert.ok(!paymentMayMove("canceled", "requires_capture"));
    assert.ok(!paymentMayMove("requires_capture", "pending"));
    for (const s of PAYMENT_STATUSES) assert.ok(!paymentMayMove(s, s));
  });
});

describe("deriveOrderStatus", () => {
  it("follows captured money and refunds that hold money", () => {
    assert.equal(deriveOrderStatus({ captured: 1000n, refunded: 0n, payments: ["succeeded"] }), "paid");
    assert.equal(
      deriveOrderStatus({ captured: 1000n, refunded: 1n, payments: ["succeeded"] }),
      "partially_refunded",
    );
    assert.equal(
      deriveOrderStatus({ captured: 1000n, refunded: 1000n, payments: ["succeeded"] }),
      "refunded",
    );
    assert.equal(
      deriveOrderStatus({ captured: 0n, refunded: 0n, payments: ["requires_capture"] }),
      "authorized",
    );
    assert.equal(deriveOrderStatus({ captured: 0n, refunded: 0n, payments: ["canceled"] }), "canceled");
    assert.equal(deriveOrderStatus({ captured: 0n, refunded: 0n, payments: ["failed"] }), "pending_payment");
    assert.equal(deriveOrderStatus({ captured: 0n, refunded: 0n, payments: [] }), "pending_payment");
  });
});

describe("saleLegs", () => {
  it("balances for every line split and omits zero legs", () => {
    for (let a = 1n; a < 3000n; a += 13n) {
      const lines = [
        { id: "l1", seller: "seller_a", amount: a },
        { id: "l2", seller: "seller_b", amount: a * 3n + 1n },
        { id: "l3", seller: "seller_a", amount: 7n },
      ];
      const total = lines.reduce((s, l) => s + l.amount, 0n);
      const legs = saleLegs(total, lines);
      assert.equal(sumLegs(legs), 0n);
      assert.ok(legs.every((l) => l.amount !== 0n));
      // each line's legs sum to the line amount (credit side)
      for (const l of lines)
        assert.equal(
          -legs.filter((x) => x.effectRef === `allocation:${l.id}`).reduce((s, x) => s + x.amount, 0n),
          l.amount,
        );
    }
  });
});

describe("SDK money boundaries", () => {
  it("round trips exact minor units in the declared domain", () => {
    for (const n of [0n, 1n, 999n, MAX_AMOUNT]) assert.equal(providerMinor(sdkMinor(n)), n);
    for (let i = 1n; i <= 1000n; i++) {
      const n = (i * 982451653n) % MAX_AMOUNT;
      assert.equal(providerMinor(sdkMinor(n)), n);
    }
  });
  it("refuses non-exact or out-of-domain provider JSON before conversion", () => {
    for (const value of [
      1.5,
      -1,
      NaN,
      Infinity,
      Number.MAX_SAFE_INTEGER + 1,
      Number(MAX_AMOUNT + 1n),
      "100",
      null,
    ])
      assert.throws(() => providerMinor(value), RangeError);
    for (const value of [-1n, MAX_AMOUNT + 1n]) assert.throws(() => sdkMinor(value), RangeError);
  });
});
