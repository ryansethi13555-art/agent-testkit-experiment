import pg from "pg";
import { describe, expect, it } from "vitest";
import { FinancialInvariantError } from "@moneyinvariant/engine";
import {
  assertFinancialInvariants,
  createTestDb,
  startTwin,
} from "./helpers/fixture.ts";

describe("R3 Test Kit & Financial Invariants Engine", () => {
  it("ProviderTwin gate injects 500, drop, 429 and clears faults", async () => {
    const twin = await startTwin("stripe");
    try {
      // Test normal call
      const resNormal = await fetch(`${twin.url}/v1/payment_intents`, {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          authorization: `Bearer ${twin.secrets.apiKey}`,
        },
        body: new URLSearchParams({ amount: "5000", currency: "usd" }).toString(),
      });
      expect(resNormal.status).toBe(200);

      // Gate next 500
      twin.gate.next({ outcome: "500" });
      const res500 = await fetch(`${twin.url}/v1/payment_intents`, {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          authorization: `Bearer ${twin.secrets.apiKey}`,
        },
        body: new URLSearchParams({ amount: "5000", currency: "usd" }).toString(),
      });
      expect(res500.status).toBe(500);

      // Next call after 500 succeeds (since times: 1)
      const resAfter500 = await fetch(`${twin.url}/v1/payment_intents`, {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          authorization: `Bearer ${twin.secrets.apiKey}`,
        },
        body: new URLSearchParams({ amount: "5000", currency: "usd" }).toString(),
      });
      expect(resAfter500.status).toBe(200);

      // Gate next 429
      twin.gate.next({ outcome: "429" });
      const res429 = await fetch(`${twin.url}/v1/payment_intents`, {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          authorization: `Bearer ${twin.secrets.apiKey}`,
        },
        body: new URLSearchParams({ amount: "5000", currency: "usd" }).toString(),
      });
      expect(res429.status).toBe(429);

      // Gate next drop (connection reset)
      twin.gate.next({ outcome: "drop" });
      await expect(
        fetch(`${twin.url}/v1/payment_intents`, {
          method: "POST",
          headers: {
            "content-type": "application/x-www-form-urlencoded",
            authorization: `Bearer ${twin.secrets.apiKey}`,
          },
          body: new URLSearchParams({ amount: "5000", currency: "usd" }).toString(),
        }),
      ).rejects.toThrow();

      // Clear faults
      twin.gate.clear();
      const resCleared = await fetch(`${twin.url}/v1/payment_intents`, {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          authorization: `Bearer ${twin.secrets.apiKey}`,
        },
        body: new URLSearchParams({ amount: "5000", currency: "usd" }).toString(),
      });
      expect(resCleared.status).toBe(200);
    } finally {
      await twin.stop();
    }
  });

  it("Webhook signing produces contract-compliant signatures for Stripe and Razorpay", async () => {
    const stripeTwin = await startTwin("stripe");
    const razorpayTwin = await startTwin("razorpay");
    try {
      const payload = { id: "evt_test_123", type: "payment_intent.succeeded" };
      const stripeSig = stripeTwin.signStripeWebhook(payload);
      expect(stripeSig).toMatch(/^t=\d+,v1=[0-9a-f]{64}$/);

      const rzpPayload = { id: "evt_rzp_123", event: "payment.captured" };
      const rzpSig = razorpayTwin.signRazorpayWebhook(rzpPayload);
      expect(rzpSig).toMatch(/^[0-9a-f]{64}$/);
    } finally {
      await stripeTwin.stop();
      await razorpayTwin.stop();
    }
  });

  it("Financial oracle detects double-entry imbalance and reports value at risk", async () => {
    const { dbUrl, cleanup } = await createTestDb("test_fin_oracle_unbal");
    try {
      const client = new pg.Client({ connectionString: dbUrl });
      await client.connect();

      // Setup minimal schema
      await client.query(`
        CREATE TABLE orders (id text PRIMARY KEY, buyer text, currency text, total bigint, capture_method text, status text, payment_intent_id text);
        CREATE TABLE order_lines (id text PRIMARY KEY, order_id text, seller_id text, currency text, amount bigint);
        CREATE TABLE refunds (id text PRIMARY KEY, order_id text, line_id text, provider_ref text, currency text, amount bigint, status text);
        CREATE TABLE ledger_entries (id bigserial PRIMARY KEY, txn_id text, account text, currency text, amount bigint, cause_ref text, kind text, effect_ref text);
      `);

      // Insert valid order
      await client.query("INSERT INTO orders VALUES ('ord_1', 'buyer', 'USD', 1000, 'automatic', 'paid', 'pi_1')");
      await client.query("INSERT INTO order_lines VALUES ('line_1', 'ord_1', 'seller_a', 'USD', 1000)");

      // Insert unbalanced ledger transaction (e.g. money credited without balancing debit)
      await client.query(`
        INSERT INTO ledger_entries (txn_id, account, currency, amount, cause_ref, kind, effect_ref)
        VALUES ('txn_leak', 'seller:seller_a', 'USD', 1000, 'pi_1', 'sale', 'recognition')
      `);
      await client.end();

      // Oracle must throw FinancialInvariantError
      await expect(
        assertFinancialInvariants({
          pgUrl: dbUrl,
          appId: "inline-marketplace",
        }),
      ).rejects.toThrow(FinancialInvariantError);

      try {
        await assertFinancialInvariants({
          pgUrl: dbUrl,
          appId: "inline-marketplace",
        });
      } catch (err) {
        expect(err).toBeInstanceOf(FinancialInvariantError);
        const finErr = err as FinancialInvariantError;
        expect(finErr.invariantId).toBe("ledger.txn-balanced");
        expect(finErr.magnitude.get("USD")).toBe(1000n);
      }
    } finally {
      await cleanup();
    }
  });

  it("Financial oracle detects refund line over-budget (refund.line-bounded)", async () => {
    const { dbUrl, cleanup } = await createTestDb("test_fin_oracle_headroom");
    try {
      const client = new pg.Client({ connectionString: dbUrl });
      await client.connect();

      await client.query(`
        CREATE TABLE orders (id text PRIMARY KEY, buyer text, currency text, total bigint, capture_method text, status text, payment_intent_id text);
        CREATE TABLE order_lines (id text PRIMARY KEY, order_id text, seller_id text, currency text, amount bigint);
        CREATE TABLE refunds (id text PRIMARY KEY, order_id text, line_id text, provider_ref text, currency text, amount bigint, status text);
        CREATE TABLE ledger_entries (id bigserial PRIMARY KEY, txn_id text, account text, currency text, amount bigint, cause_ref text, kind text, effect_ref text);
      `);

      // Order with line amount 500
      await client.query("INSERT INTO orders VALUES ('ord_1', 'buyer', 'INR', 500, 'automatic', 'paid', 'pi_1')");
      await client.query("INSERT INTO order_lines VALUES ('line_1', 'ord_1', 'seller_a', 'INR', 500)");

      // Balanced sale in ledger
      await client.query(`
        INSERT INTO ledger_entries (txn_id, account, currency, amount, cause_ref, kind, effect_ref) VALUES
        ('txn_sale', 'seller:seller_a', 'INR', 450, 'pi_1', 'sale', 'seller_share'),
        ('txn_sale', 'platform:fee', 'INR', 50, 'pi_1', 'sale', 'commission'),
        ('txn_sale', 'provider:clearing', 'INR', -500, 'pi_1', 'sale', 'clearing')
      `);

      // Two refunds totalling 600 (exceeds line 500 by 100)
      await client.query(`
        INSERT INTO refunds VALUES
        ('ref_1', 'ord_1', 'line_1', 're_1', 'INR', 300, 'succeeded'),
        ('ref_2', 'ord_1', 'line_1', 're_2', 'INR', 300, 'succeeded')
      `);
      await client.end();

      await expect(
        assertFinancialInvariants({
          pgUrl: dbUrl,
          appId: "inline-marketplace",
        }),
      ).rejects.toThrow(FinancialInvariantError);

      try {
        await assertFinancialInvariants({
          pgUrl: dbUrl,
          appId: "inline-marketplace",
        });
      } catch (err) {
        expect(err).toBeInstanceOf(FinancialInvariantError);
        const finErr = err as FinancialInvariantError;
        expect(finErr.invariantId).toBe("refund.line-bounded");
        expect(finErr.magnitude.get("INR")).toBe(100n);
      }
    } finally {
      await cleanup();
    }
  });
});
