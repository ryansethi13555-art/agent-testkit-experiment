// Money laws asserted against the apps' stored state and the fake provider's true state (never HTTP bodies).
import { expect } from "vitest";
import type pg from "pg";
import { fee } from "./pg.ts";
import type { FakeStripe } from "./fakeStripe.ts";

const LIVE = ["pending", "requires_action", "succeeded"];
const big = (v: unknown) => BigInt(v as string | number | bigint);

/** Laws that must hold at every committed state of either app (schema columns common to both). */
export async function commonLaws(db: pg.Pool | pg.Client) {
  const q = async (sql: string, p: unknown[] = []) => (await db.query(sql, p)).rows;
  // ledger.txn-balanced
  expect(await q("SELECT txn_id, currency FROM ledger_entries GROUP BY 1,2 HAVING sum(amount) <> 0")).toEqual([]);
  // whole ledger nets to zero per currency
  expect(await q("SELECT currency FROM ledger_entries GROUP BY 1 HAVING sum(amount) <> 0")).toEqual([]);
  // effect.once: no posting slot realised twice
  expect(
    await q(
      "SELECT cause_ref, effect_ref, account, currency FROM ledger_entries GROUP BY 1,2,3,4 HAVING count(*) > 1",
    ),
  ).toEqual([]);
  // refund.line-bounded and order bound (live refunds only)
  const lines = await q(
    `SELECT l.id, l.amount, coalesce((SELECT sum(r.amount) FROM refunds r WHERE r.line_id=l.id AND r.status IN ('pending','requires_action','succeeded')),0) live
       FROM order_lines l`,
  );
  for (const l of lines) expect(big(l.live) <= big(l.amount), `line ${l.id} over-refunded`).toBe(true);
  const orders = await q(
    `SELECT o.id, o.total, coalesce((SELECT sum(r.amount) FROM refunds r WHERE r.order_id=o.id AND r.status IN ('pending','requires_action','succeeded')),0) live FROM orders o`,
  );
  for (const o of orders) expect(big(o.live) <= big(o.total), `order ${o.id} over-refunded`).toBe(true);
  // a failed or canceled refund leaves no net residue; a live one has exactly one recognition pair
  const refunds = await q("SELECT provider_ref, status, amount FROM refunds");
  for (const r of refunds) {
    const net = await q(
      "SELECT account, sum(amount)::bigint s FROM ledger_entries WHERE cause_ref=$1 GROUP BY account",
      [r.provider_ref],
    );
    if (LIVE.includes(r.status)) {
      const clearing = net.find((n) => n.account === "provider:clearing");
      expect(clearing && big(clearing.s), `refund ${r.provider_ref} clearing`).toBe(-big(r.amount));
      const other = net.filter((n) => n.account !== "provider:clearing");
      expect(other.reduce((s, n) => s + big(n.s), 0n), `refund ${r.provider_ref} counter`).toBe(big(r.amount));
    } else for (const n of net) expect(big(n.s), `failed refund ${r.provider_ref} residue`).toBe(0n);
  }
}

export function expectedStatus(total: bigint, live: bigint): string {
  return live === 0n ? "paid" : live >= total ? "refunded" : "partially_refunded";
}

/** Provider (fake Stripe) truth versus app refund table. */
export async function reconRefunds(db: pg.Pool | pg.Client, fake: FakeStripe, table = "refunds") {
  const app = (await db.query(`SELECT provider_ref, amount, status FROM ${table}`)).rows;
  const byRef = new Map(app.map((r) => [r.provider_ref as string, r]));
  for (const r of fake.refunds.values()) {
    const a = byRef.get(r.id);
    expect(a, `provider refund ${r.id} unknown to the app`).toBeTruthy();
    expect(big(a?.amount), `amount of ${r.id}`).toBe(BigInt(r.amount));
    expect(a?.status, `status of ${r.id}`).toBe(r.status);
  }
  for (const a of app) expect(fake.refunds.has(a.provider_ref), `app refund ${a.provider_ref} unknown to provider`).toBe(true);
}

/** Sum of ledger account (bigint). */
export async function acct(db: pg.Pool | pg.Client, account: string | RegExp): Promise<bigint> {
  const rows = (await db.query("SELECT account, sum(amount)::bigint s FROM ledger_entries GROUP BY account")).rows;
  return rows
    .filter((r) => (typeof account === "string" ? r.account === account : account.test(r.account)))
    .reduce((s, r) => s + big(r.s), 0n);
}
export { fee };
