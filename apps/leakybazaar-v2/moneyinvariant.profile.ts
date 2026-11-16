// LeakyBazaar's app profile for MoneyInvariant: how to start it, its actions, and its read-only bindings.
// (G3 will express this as moneyinvariant.yaml; G1 keeps it typed.)

import type { AppProfile } from "@moneyinvariant/engine";
import pg from "pg";

export type LeakyBazaarProvider = "stripe" | "razorpay";

/** Env the app reads for its provider, pointed at the MoneyInvariant simulator (fake per-run credentials). */
function providerEnv(
  provider: LeakyBazaarProvider,
  simUrl: string,
  secrets: { apiKeyId?: string; apiKey: string; webhookSecret: string },
): Record<string, string> {
  return provider === "stripe"
    ? {
        PAYMENT_PROVIDER: "stripe",
        MONEYINV_STRIPE_API_BASE: simUrl,
        STRIPE_SECRET_KEY: secrets.apiKey,
        STRIPE_WEBHOOK_SECRET: secrets.webhookSecret,
        MONEYINV_RUN: "1",
      }
    : {
        PAYMENT_PROVIDER: "razorpay",
        MONEYINV_RAZORPAY_API_BASE: simUrl,
        RAZORPAY_KEY_ID: secrets.apiKeyId ?? "",
        RAZORPAY_KEY_SECRET: secrets.apiKey,
        RAZORPAY_WEBHOOK_SECRET: secrets.webhookSecret,
        MONEYINV_RUN: "1",
      };
}

export function leakybazaarProfile(o: {
  appDir: string;
  appDbUrl: string;
  observerUrl: string;
  reset: () => Promise<void>;
  provider?: LeakyBazaarProvider;
}): AppProfile {
  const provider = o.provider ?? "stripe";
  return {
    name: "leakybazaar-v2",
    start: {
      cmd: process.execPath,
      args: ["src/server.ts"],
      cwd: o.appDir,
      env: { DATABASE_URL: o.appDbUrl },
    },
    portEnv: "PORT",
    health: "/healthz",
    warmup: { path: "/healthz", concurrency: 4 },
    webhookPath: `/webhooks/${provider}`,
    providerEnv: (simUrl, secrets) => providerEnv(provider, simUrl, secrets),
    actions: {
      create_order: (a) => ({
        method: "POST",
        path: "/orders",
        json: { buyer: "buyer_1", currency: "INR", lines: a.lines, capture: a.capture },
      }),
      checkout: (a) => ({ method: "POST", path: `/orders/${a.order_id}/checkout`, json: {} }),
      confirm: (a) => ({ method: "POST", path: `/orders/${a.order_id}/confirm`, json: {} }),
      capture: (a) => ({ method: "POST", path: `/orders/${a.order_id}/capture`, json: {} }),
      refund_line: (a) => ({
        method: "POST",
        path: `/orders/${a.order_id}/refunds`,
        json: { line_id: a.line_id, amount: a.amount },
      }),
    },
    bindings: [
      { relation: "orders", sql: "SELECT id AS order_id, currency, total AS amount_due, status FROM orders" },
      {
        relation: "order_lines",
        sql: "SELECT id AS line_id, order_id AS order_ref, seller_id AS seller_ref, currency, amount FROM order_lines",
      },
      {
        relation: "refunds",
        sql: "SELECT id AS refund_id, order_id AS order_ref, line_id AS line_ref, provider_ref, currency, amount, status, origin FROM refunds",
      },
      {
        relation: "ledger_entries",
        sql: "SELECT id AS entry_id, txn_id, account, currency, amount, cause_ref, kind, effect_ref FROM ledger_entries",
      },
      {
        // chart of accounts: 'provider:clearing' holds the funds at the payment provider (debit-positive, like
        // world.postings); every other account is internal to the marketplace
        relation: "ledger_accounts",
        sql: "SELECT DISTINCT account, CASE WHEN account = 'provider:clearing' THEN 'provider_clearing' ELSE 'internal' END AS class FROM ledger_entries",
      },
    ],
    observerUrl: o.observerUrl,
    // This app's background retries may await a withheld webhook. Final settlement still requires zero reservations.
    workProbe: async () => true,
    quiescenceProbe: async () => {
      const c = new pg.Client({ connectionString: o.observerUrl });
      try {
        await c.connect();
        await c.query("BEGIN READ ONLY");
        await c.query("SET LOCAL statement_timeout='2s'");
        const r = await c.query("SELECT count(*) = 0 AS idle FROM refund_requests WHERE NOT resolved");
        await c.query("COMMIT");
        return r.rows[0]?.idle === true;
      } finally {
        await c.end();
      }
    },
    settleTimeoutMs: 30_000,
    reset: o.reset,
  };
}
