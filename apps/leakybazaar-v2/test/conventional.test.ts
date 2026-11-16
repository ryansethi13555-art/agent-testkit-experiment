// LeakyBazaar's own conventional test suite: what a competent team typically writes.
// Happy paths, validation, a sequential duplicate-webhook test and a signature test (as provider docs advise),
// against a simple in-test fake Stripe. It is independent of MoneyInvariant's simulator.
import http from "node:http";
import type { AddressInfo } from "node:net";
import pg from "pg";
import Stripe from "stripe";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

const ADMIN = process.env.MI_PG_ADMIN_URL ?? "postgres://postgres@127.0.0.1:5432/postgres";
const DB = (process.env.LB_TEST_DB ?? `lb_v2_conv_${process.pid}`).toLowerCase().replace(/[^a-z0-9_]/g, "_");
const WHSEC = "whsec_conventional_test";
let pgUp = true;
try {
  const c = new pg.Client({ connectionString: ADMIN });
  await c.connect();
  await c.query(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`);
  await c.query(`CREATE DATABASE ${DB}`);
  await c.end();
} catch {
  pgUp = false;
}

// --- a simple happy-path fake Stripe (what teams often hand-roll for tests) ---
const pis = new Map<string, Record<string, unknown>>();
const refunds = new Map<string, Record<string, unknown>>();
let n = 0;
const fake = http.createServer(async (req, res) => {
  let body = "";
  for await (const c of req) body += c;
  const p = new URLSearchParams(body);
  const send = (o: unknown) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(o));
  };
  const url = req.url ?? "";
  if (url === "/v1/payment_intents" && req.method === "POST") {
    const id = `pi_fake${++n}`;
    const pi = {
      id,
      object: "payment_intent",
      amount: Number(p.get("amount")),
      amount_received: 0,
      currency: p.get("currency"),
      capture_method: p.get("capture_method"),
      status: "requires_payment_method",
      client_secret: `${id}_secret`,
      metadata: { order_id: p.get("metadata[order_id]") },
    };
    pis.set(id, pi);
    return send(pi);
  }
  const m = /^\/v1\/payment_intents\/(\w+)(\/capture)?$/.exec(url);
  if (m) {
    const pi = pis.get(m[1] ?? "") ?? {};
    if (m[2]) Object.assign(pi, { status: "succeeded", amount_received: pi.amount });
    return send(pi);
  }
  const refundRef = /^\/v1\/refunds\/(\w+)$/.exec(url)?.[1];
  if (refundRef && req.method === "GET") return send(refunds.get(refundRef) ?? {});
  if (url === "/v1/refunds" && req.method === "POST") {
    const r = {
      id: `re_fake${++n}`,
      object: "refund",
      currency: "inr",
      amount: Number(p.get("amount")),
      status: "succeeded",
      payment_intent: p.get("payment_intent"),
    };
    refunds.set(r.id, r);
    return send(r);
  }
  res.writeHead(404);
  res.end("{}");
});

let app: typeof import("../src/server.ts");
let base = "";
let db: pg.Client;
const signer = new Stripe("sk_test_x");

async function post(path: string, body: unknown, headers: Record<string, string> = {}) {
  const r = await fetch(base + path, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
  return { status: r.status, body: (await r.json()) as Record<string, unknown> };
}
async function webhook(event: Record<string, unknown>) {
  const payload = JSON.stringify(event);
  return post("/webhooks/stripe", payload, {
    "stripe-signature": signer.webhooks.generateTestHeaderString({ payload, secret: WHSEC }),
  });
}
function succeed(piId: string) {
  const pi = pis.get(piId) as Record<string, unknown>;
  Object.assign(pi, { status: "succeeded", amount_received: pi.amount });
  return { id: `evt_${++n}`, object: "event", type: "payment_intent.succeeded", data: { object: pi } };
}
async function paidOrder(
  lines = [
    { seller_id: "seller_a", amount: 600 },
    { seller_id: "seller_b", amount: 400 },
  ],
  capture = "automatic",
) {
  const o = await post("/orders", { buyer: "b1", currency: "INR", lines, capture });
  const co = await post(`/orders/${o.body.id}/checkout`, {});
  return { order: o.body, pi: String(co.body.payment_intent_id) };
}

beforeAll(async () => {
  if (!pgUp) return;
  await new Promise<void>((r) => fake.listen(0, "127.0.0.1", () => r()));
  process.env.DATABASE_URL = ADMIN.replace(/\/[^/]*$/, `/${DB}`);
  process.env.STRIPE_SECRET_KEY = "sk_test_x";
  process.env.STRIPE_WEBHOOK_SECRET = WHSEC;
  process.env.MONEYINV_STRIPE_API_BASE = `http://127.0.0.1:${(fake.address() as AddressInfo).port}`;
  app = await import("../src/server.ts");
  await app.migrate();
  await new Promise<void>((r) => app.server.listen(0, "127.0.0.1", () => r()));
  base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  db = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();
});
afterAll(async () => {
  if (!pgUp) return;
  await db.end();
  await app.stop();
  fake.close();
});
beforeEach(async () => {
  if (pgUp) await db.query("TRUNCATE orders, order_lines, refunds, ledger_entries, processed_events CASCADE");
});

const ledgerSum = async () =>
  BigInt((await db.query("SELECT coalesce(sum(amount),0)::text s FROM ledger_entries")).rows[0].s);

describe.skipIf(!pgUp)("LeakyBazaar conventional suite", () => {
  it("rejects orders without lines or with non-positive amounts", async () => {
    expect((await post("/orders", { lines: [] })).status).toBe(400);
    expect((await post("/orders", { lines: [{ seller_id: "seller_a", amount: 0 }] })).status).toBe(400);
  });

  it("checkout creates one PaymentIntent with the order id and is idempotent", async () => {
    const { order, pi } = await paidOrder();
    const again = await post(`/orders/${order.id}/checkout`, {});
    expect(again.body.payment_intent_id).toBe(pi);
    expect((pis.get(pi) as { metadata: { order_id: string } }).metadata.order_id).toBe(order.id);
  });

  it("payment webhook marks the order paid and posts a balanced ledger with 10% commission", async () => {
    const { order, pi } = await paidOrder();
    expect((await webhook(succeed(pi))).status).toBe(200);
    expect((await db.query("SELECT status FROM orders WHERE id=$1", [order.id])).rows[0].status).toBe("paid");
    expect(await ledgerSum()).toBe(0n);
    const sellerA = (
      await db.query("SELECT amount::text a FROM ledger_entries WHERE account='seller:seller_a'")
    ).rows[0].a;
    expect(sellerA).toBe("-540");
  });

  it("a duplicated webhook delivery does not double-post (sequential redelivery)", async () => {
    const { pi } = await paidOrder();
    const ev = succeed(pi);
    await webhook(ev);
    await webhook(ev);
    expect((await db.query("SELECT count(*)::int c FROM ledger_entries WHERE kind='sale'")).rows[0].c).toBe(
      3,
    );
  });

  it("rejects webhooks with an invalid signature", async () => {
    const r = await post(
      "/webhooks/stripe",
      JSON.stringify({ id: "evt_x", type: "payment_intent.succeeded", data: { object: {} } }),
      { "stripe-signature": "t=1,v1=deadbeef" },
    );
    expect(r.status).toBe(400);
  });

  it("return-from-checkout and webhook together still record the sale once", async () => {
    const { order, pi } = await paidOrder();
    const ev = succeed(pi);
    expect((await post(`/orders/${order.id}/confirm`, {})).body.status).toBe("paid");
    await webhook(ev);
    expect((await db.query("SELECT count(*)::int c FROM ledger_entries WHERE kind='sale'")).rows[0].c).toBe(
      3,
    );
  });

  it("refunds part of a line and reverses the seller's share", async () => {
    const { order, pi } = await paidOrder();
    await webhook(succeed(pi));
    const lineA = `${order.id}_l1`;
    const r = await post(`/orders/${order.id}/refunds`, { line_id: lineA, amount: 200 });
    expect(r.status).toBe(200);
    expect((await db.query("SELECT status FROM orders WHERE id=$1", [order.id])).rows[0].status).toBe(
      "partially_refunded",
    );
    expect(await ledgerSum()).toBe(0n);
  });

  it("rejects a refund beyond what is left on the line", async () => {
    const { order, pi } = await paidOrder();
    await webhook(succeed(pi));
    const lineA = `${order.id}_l1`;
    expect((await post(`/orders/${order.id}/refunds`, { line_id: lineA, amount: 500 })).status).toBe(200);
    expect((await post(`/orders/${order.id}/refunds`, { line_id: lineA, amount: 200 })).status).toBe(400);
  });

  it("manual capture marks the order paid", async () => {
    const { order } = await paidOrder(undefined, "manual");
    expect((await post(`/orders/${order.id}/capture`, {})).body.status).toBe("paid");
  });

  it("records a refund created in the provider dashboard", async () => {
    const { order, pi } = await paidOrder();
    await webhook(succeed(pi));
    refunds.set("re_dash1", {
      id: "re_dash1",
      object: "refund",
      amount: 100,
      currency: "inr",
      status: "succeeded",
      payment_intent: pi,
    });
    const r = await webhook({
      id: "evt_dash",
      object: "event",
      type: "refund.updated",
      data: {
        object: {
          id: "re_dash1",
          object: "refund",
          amount: 100,
          currency: "inr",
          status: "succeeded",
          payment_intent: pi,
        },
      },
    });
    expect(r.status).toBe(200);
    expect((await db.query("SELECT origin FROM refunds WHERE provider_ref='re_dash1'")).rows[0].origin).toBe(
      "provider",
    );
    expect(await ledgerSum()).toBe(0n);
    expect(order.id).toBeTruthy();
  });
});
