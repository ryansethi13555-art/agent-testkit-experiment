// Randomised end-to-end sequences (fixed seed, so reproducible) on live apps against the provider twin.
// After every sequence the full money-law audit must be clean, whatever mixture of orders, partial refunds,
// concurrency, duplicated and re-ordered webhooks, and lost refund responses was generated.
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { audit, setup } from "./helpers/harness.ts";
import { converge } from "./helpers/scenario.ts";
import { KINDS, PROVIDERS } from "./helpers/scenario.ts";

const lineAmounts = fc.array(fc.integer({ min: 60, max: 5000 }), { minLength: 2, maxLength: 4 });
const ops = fc.array(
  fc.record({
    line: fc.nat(3),
    pct: fc.integer({ min: 1, max: 100 }),
    burst: fc.integer({ min: 1, max: 3 }), // concurrent identical requests
    lose: fc.boolean(), // lose the provider response of this refund
    replay: fc.boolean(), // provider replays every webhook afterwards
  }),
  { minLength: 1, maxLength: 5 },
);

let ruleN = 0;
describe("randomised refund sequences", () => {
  for (const kind of KINDS)
    for (const provider of PROVIDERS)
      it(
        `[${kind}/${provider}] books stay right under random refunds, bursts, lost responses and replays`,
        async () => {
          const ctx = await setup(kind, provider, { asyncRefunds: provider === "stripe" });
          try {
            await fc.assert(
              fc.asyncProperty(lineAmounts, ops, async (amts, seq) => {
                const o = await ctx.paidOrder(amts);
                for (const op of seq) {
                  const lineIdx = op.line % amts.length;
                  const amt = Math.max(provider === "razorpay" ? 100 : 1, Math.floor((amts[lineIdx]! * op.pct) / 100));
                  if (op.lose)
                    ctx.twin.server.addRule({ label: `lose_${++ruleN}`, match: (c) => c.command.kind === "createRefund", fault: { t: "apply_then_reset" } as never, times: 1 });
                  await Promise.all(Array.from({ length: op.burst }, () => ctx.refund(o.id, o.lines[lineIdx]!, amt)));
                  ctx.twin.server.clearRules();
                  await ctx.twin.deliverNew(ctx.hook());
                  if (op.replay) await ctx.twin.replayAll(ctx.hook());
                }
                // settle every pending refund at the provider (some fail, some succeed), then converge
                let i = 0;
                for (const [id, r] of ctx.twin.world.refunds) if (r.status === "pending") ctx.twin.settleRefund(ctx.twin.wire(id), i++ % 3 === 0 ? "failed" : "succeeded");
                await converge(ctx);
                const problems = await audit(ctx, { allowOpenRequests: true });
                expect(problems).toEqual([]);
                // provider never holds more refunds than it captured, per payment
                for (const p of ctx.twin.world.payments.values()) {
                  const live = [...ctx.twin.world.refunds.values()].filter((r) => r.paymentId === p.id && r.status !== "failed" && r.status !== "canceled").reduce((s, r) => s + r.amount, 0n);
                  expect(live <= p.amountCaptured).toBe(true);
                }
              }),
              { seed: 20260514, numRuns: 6, endOnFailure: true },
            );
          } finally {
            await ctx.close();
          }
        },
        280_000,
      );
});
