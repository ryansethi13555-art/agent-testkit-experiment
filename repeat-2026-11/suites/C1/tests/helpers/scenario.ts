// Scenario plumbing: the app x provider matrix, fault helpers and "provider retries until acknowledged".
import { it } from "vitest";
import { type AppKind, type Ctx, type ProviderName, setup } from "./harness.ts";

export const KINDS: AppKind[] = ["inline", "worker"];
export const PROVIDERS: ProviderName[] = ["stripe", "razorpay"];

export interface MatrixOpts {
  asyncRefunds?: boolean;
  providers?: ProviderName[];
  kinds?: AppKind[];
  timeout?: number;
}

/** Register one test per (app, provider) combination, each with a fresh database, provider twin and app. */
export function matrix(name: string, fn: (ctx: Ctx) => Promise<void>, o: MatrixOpts = {}): void {
  for (const kind of o.kinds ?? KINDS)
    for (const provider of o.providers ?? PROVIDERS)
      it(
        `[${kind}/${provider}] ${name}`,
        async () => {
          const ctx = await setup(kind, provider, { asyncRefunds: o.asyncRefunds ?? false });
          try {
            await fn(ctx);
          } finally {
            await ctx.close();
          }
        },
        o.timeout ?? 90_000,
      );
}

let ruleSeq = 0;
/** Inject a fault on the next `times` provider calls whose canonical command kind matches. */
export function fault(
  ctx: Ctx,
  commandKind: "createPayment" | "capture" | "createRefund" | "getPayment" | "getRefund",
  f: { t: "fail_before_apply"; status: number } | { t: "apply_then_reset" } | { t: "apply_then_500" } | { t: "reset" },
  times = 1,
): string {
  const label = `fault_${++ruleSeq}`;
  ctx.twin.server.addRule({ label, match: (c) => c.command.kind === commandKind, fault: f as never, times });
  return label;
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * The provider delivers at least once and retries until acknowledged: replay every event ever produced until every
 * delivery got a 2xx, letting the app's background machinery run in between.
 */
export async function converge(ctx: Ctx, rounds = 6): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    const statuses = await ctx.twin.replayAll(ctx.hook());
    await ctx.app.drain();
    if (statuses.every((s) => s >= 200 && s < 300)) {
      // one more pass so a delivery that unblocked another (e.g. payment then refund) is applied
      await ctx.twin.replayAll(ctx.hook());
      await ctx.app.drain();
      return;
    }
    await sleep(100);
  }
}

export async function ledgerCount(ctx: Ctx): Promise<number> {
  return Number((await ctx.q("SELECT count(*)::int c FROM ledger_entries"))[0].c);
}
