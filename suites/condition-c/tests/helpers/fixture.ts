import { randomUUID } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import pg from "pg";
import {
  assertFinancialCorrectness,
  createProviderTwin,
  FinancialInvariantError,
  type FinancialOracleOptions,
  ProviderTwin,
} from "@moneyinvariant/engine";
import { stripeDialect, signStripePayload } from "@moneyinvariant/dialect-stripe";
import { razorpayDialect, signRazorpayPayload } from "@moneyinvariant/dialect-razorpay";
import type { Binding } from "@moneyinvariant/observe";
import { compileInvariant, type InvariantDef } from "@moneyinvariant/core";
import { World, type WorldCommand, type WorldOptions } from "@moneyinvariant/sim";

export const ADMIN_URL = process.env.MI_PG_ADMIN_URL ?? "postgres://postgres@127.0.0.1:5432/postgres";

export async function createTestDb(prefix: string): Promise<{ dbName: string; dbUrl: string; cleanup: () => Promise<void> }> {
  const dbName = `${prefix}_${process.pid}_${randomUUID().slice(0, 8)}`.toLowerCase().replace(/[^a-z0-9_]/g, "_");
  const adminClient = new pg.Client({ connectionString: ADMIN_URL });
  await adminClient.connect();
  await adminClient.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
  await adminClient.query(`CREATE DATABASE ${dbName}`);
  await adminClient.end();

  const dbUrl = ADMIN_URL.replace(/\/[^/]*$/, `/${dbName}`);

  const cleanup = async () => {
    try {
      const c = new pg.Client({ connectionString: ADMIN_URL });
      await c.connect();
      await c.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
      await c.end();
    } catch {
      // ignore cleanup errors
    }
  };

  return { dbName, dbUrl, cleanup };
}

export interface EnhancedTwin {
  twin: ProviderTwin;
  url: string;
  baseUrl: string;
  provider: "stripe" | "razorpay";
  secrets: { apiKey: string; webhookSecret: string };
  confirmPayment: (paymentWireId: string) => Promise<boolean>;
  applyWorld: (command: WorldCommand) => ReturnType<ProviderTwin["world"]["apply"]>;
  resetWorld: (worldOpts?: WorldOptions) => void;
  signStripeWebhook: (payload: unknown, secret?: string, timestampSec?: number) => string;
  signRazorpayWebhook: (payload: unknown, secret?: string) => string;
  gate: {
    next: (opts: { outcome: "drop" | "500" | "429" }) => void;
    clear: () => void;
  };
  stop: () => Promise<void>;
}

export async function startTwin(provider: "stripe" | "razorpay"): Promise<EnhancedTwin> {
  const dialect = provider === "stripe" ? stripeDialect : razorpayDialect;
  const secrets =
    provider === "razorpay"
      ? {
          apiKeyId: "rzp_test_mi",
          apiKey: "rzp_secret_mi",
          webhookSecret: "whsec_rzp_mi",
        }
      : {
          apiKey: "sk_mi_test_secret",
          webhookSecret: "whsec_mi_test_secret",
        };
  const twin = await createProviderTwin({ dialect, secrets });

  const confirmPayment = async (wireId: string): Promise<boolean> => {
    if (provider === "stripe") {
      const res = await fetch(`${twin.baseUrl}/v1/payment_intents/${wireId}/confirm`, {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          authorization: `Bearer ${twin.secrets.apiKey}`,
        },
      });
      return res.status === 200;
    } else {
      const canId = twin.dialect.fromWireId(wireId);
      const res = twin.world.apply({ kind: "customerPays", paymentId: canId, outcome: "success" });
      return res.ok;
    }
  };

  const applyWorld = (cmd: WorldCommand) => twin.world.apply(cmd);

  const signStripe = (payload: unknown, secret?: string, timestampSec?: number) => {
    const raw = typeof payload === "string" ? payload : JSON.stringify(payload);
    const t = timestampSec ?? Math.floor(Date.now() / 1000);
    return signStripePayload(raw, secret ?? twin.secrets.webhookSecret, t);
  };

  const signRazorpay = (payload: unknown, secret?: string) => {
    const raw = typeof payload === "string" ? payload : JSON.stringify(payload);
    return signRazorpayPayload(raw, secret ?? twin.secrets.webhookSecret);
  };

  const gate = {
    next: (opts: { outcome: "drop" | "500" | "429" }) => {
      if (opts.outcome === "drop") {
        twin.injectFault({
          label: "gate-next-drop",
          match: () => true,
          fault: { t: "reset" },
          times: 1,
        });
      } else if (opts.outcome === "500") {
        twin.injectFault({
          label: "gate-next-500",
          match: () => true,
          fault: { t: "fail_before_apply", status: 500 },
          times: 1,
        });
      } else if (opts.outcome === "429") {
        twin.injectFault({
          label: "gate-next-429",
          match: () => true,
          fault: { t: "fail_before_apply", status: 429 },
          times: 1,
        });
      }
    },
    clear: () => twin.clearFaults(),
  };

  const resetWorld = (worldOpts?: WorldOptions) => {
    const newWorld = new World(worldOpts);
    (twin as any).world = newWorld;
    (twin.server as any).world = newWorld;
    twin.clearFaults();
  };

  return {
    twin,
    url: twin.baseUrl,
    baseUrl: twin.baseUrl,
    provider,
    secrets: {
      ...twin.secrets,
      apiSecret: (twin.secrets as any).apiKey,
      apiKeyId: (twin.secrets as any).apiKeyId ?? (twin.secrets as any).apiKey,
    },
    confirmPayment,
    applyWorld,
    resetWorld,
    signStripeWebhook: signStripe,
    signRazorpayWebhook: signRazorpay,
    gate,
    stop: () => twin.stop(),
  };
}

export async function post(
  baseUrl: string,
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: Record<string, unknown> }> {
  const payload = typeof body === "string" ? body : JSON.stringify(body);
  const res = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: payload,
  });
  let jsonBody: Record<string, unknown> = {};
  try {
    jsonBody = (await res.json()) as Record<string, unknown>;
  } catch {
    // non-json response
  }
  return { status: res.status, body: jsonBody };
}

export async function get(
  baseUrl: string,
  path: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`${baseUrl}${path}`);
  let jsonBody: Record<string, unknown> = {};
  try {
    jsonBody = (await res.json()) as Record<string, unknown>;
  } catch {
    // non-json
  }
  return { status: res.status, body: jsonBody };
}

export async function assertFinancialInvariants(opts: {
  pgUrl: string;
  twin?: EnhancedTwin | ProviderTwin;
  appId: "inline-marketplace" | "worker-marketplace";
  phase?: "observation" | "final";
}) {
  const rawTwin = opts.twin && "twin" in opts.twin ? opts.twin.twin : (opts.twin as ProviderTwin | undefined);

  // 1. Direct SQL check against PostgreSQL for immediate ledger and headroom checks
  const client = new pg.Client({ connectionString: opts.pgUrl });
  await client.connect();
  try {
    // A. Check ledger transactions balance
    const unbalRes = await client.query(`
      SELECT txn_id, currency, sum(amount) AS diff
      FROM ledger_entries
      GROUP BY txn_id, currency
      HAVING sum(amount) <> 0
    `);
    if (unbalRes.rows.length > 0) {
      const witnesses = unbalRes.rows;
      const mag = new Map<string, bigint>();
      for (const r of witnesses) {
        mag.set(String(r.currency), (mag.get(String(r.currency)) ?? 0n) + BigInt(Math.abs(Number(r.diff))));
      }
      throw new FinancialInvariantError(
        `Financial invariant "ledger.txn-balanced" VIOLATED! Unbalanced transactions: ${JSON.stringify(witnesses)}`,
        "ledger.txn-balanced",
        witnesses,
        mag,
      );
    }

    // B. Check refund line headroom
    const overRefundRes = await client.query(`
      SELECT r.line_id, sum(r.amount) AS refunded, ol.amount AS max_amount
      FROM refunds r
      JOIN order_lines ol ON ol.id = r.line_id
      WHERE r.status NOT IN ('failed', 'canceled')
      GROUP BY r.line_id, ol.amount
      HAVING sum(r.amount) > ol.amount
    `);
    if (overRefundRes.rows.length > 0) {
      const witnesses = overRefundRes.rows;
      const mag = new Map<string, bigint>();
      mag.set("INR", BigInt(Number(witnesses[0]?.refunded) - Number(witnesses[0]?.max_amount)));
      throw new FinancialInvariantError(
        `Financial invariant "refund.line-bounded" VIOLATED! Line headroom exceeded: ${JSON.stringify(witnesses)}`,
        "refund.line-bounded",
        witnesses,
        mag,
      );
    }
  } finally {
    await client.end();
  }

  // 2. Build FactStore bindings & invariants
  const isInline = opts.appId === "inline-marketplace";
  const bindings: Binding[] = [
    {
      relation: "orders",
      sql: isInline
        ? "SELECT id AS order_id, currency, total AS amount, status, payment_intent_id AS payment_ref FROM orders"
        : "SELECT id AS order_id, currency, total AS amount, status, payment_ref FROM orders",
    },
    {
      relation: "order_lines",
      sql: "SELECT id AS line_id, order_id, currency, amount FROM order_lines",
    },
    {
      relation: "refunds",
      sql: "SELECT id AS refund_id, order_id, line_id AS line_ref, provider_ref, currency, amount, status FROM refunds",
    },
    {
      relation: "ledger_entries",
      sql: isInline
        ? "SELECT id AS entry_id, txn_id, account, currency, amount, cause_ref, kind, coalesce(effect_ref, kind) AS effect_ref FROM ledger_entries"
        : "SELECT id AS entry_id, txn_id, account, currency, amount, cause_ref, kind, effect_ref FROM ledger_entries",
    },
  ];

  const rawInvariants: InvariantDef[] = [
    {
      id: "refund.line-bounded",
      title: "Refunds on an order line never exceed line amount",
      when: "always",
      bound: {
        lhs: { sum: "refunds.amount", per: "refunds.line_ref", where: "line_ref IS NOT NULL AND status <> 'failed' AND status <> 'canceled'" },
        op: "<=",
        rhs: { column: "order_lines.amount", key: "order_lines.line_id" },
      },
    },
    {
      id: "effect.once-per-provider-event",
      title: "Each intended economic posting slot is realised at most once",
      when: "always",
      magnitude: "amount",
      currency: "currency",
      sql: `
        SELECT cause_ref, account, effect_ref, currency, sum(amount) AS amount
        FROM app_ledger_entries
        WHERE effect_ref IS NOT NULL
        GROUP BY cause_ref, account, effect_ref, currency
        HAVING count(*) > 1
      `,
    },
    {
      id: "ledger.txn-balanced",
      title: "Every ledger transaction balances, per currency",
      when: "always",
      magnitude: "diff",
      currency: "currency",
      sql: `
        SELECT txn_id, currency, abs(sum(amount)) AS diff
        FROM app_ledger_entries
        GROUP BY txn_id, currency
        HAVING sum(amount) <> 0
      `,
    },
  ];

  if (rawTwin) {
    rawInvariants.push(
      {
        id: "recon.refunds-agree",
        title: "Provider refunds and app refunds agree once settled",
        when: "quiescent",
        correspond: {
          left: { relation: "world.refunds", key: "refund_ref", amount: "amount", where: "status <> 'failed' AND status <> 'canceled'" },
          right: { relation: "refunds", key: "provider_ref", amount: "amount", where: "status <> 'failed' AND status <> 'canceled'" },
          require: "both_ways",
        },
      },
      {
        id: "order.paid-iff-captured",
        title: "Money captured at provider iff order is recorded as paid",
        when: "quiescent",
        magnitude: "amount",
        currency: "currency",
        sql: `
          SELECT o.order_id, o.status, o.amount, o.currency
          FROM app_orders o
          JOIN world_payments w ON w.payment_ref = o.payment_ref
          WHERE (o.status = 'paid' AND w.amount_captured = 0)
             OR (o.status = 'pending_payment' AND w.amount_captured > 0 AND w.status = 'succeeded')
        `,
      },
    );
  }

  const compiledInvariants = rawInvariants.map(compileInvariant);

  // 3. Run assertion via FactStore
  return assertFinancialCorrectness({
    dbUrl: opts.pgUrl,
    twin: rawTwin,
    bindings,
    invariants: compiledInvariants,
    phase: opts.phase ?? "final",
  });
}
