import { test } from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.js";
import { fakeD1 } from "./fakeD1.js";

const TEST_SECRET = "whsec_test_fixture_only_not_a_real_secret";

async function sign(secret, timestamp, payload) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(`${timestamp}.${payload}`));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function fakeEnv(overrides = {}) {
  return {
    STRIPE_WEBHOOK_SECRET: TEST_SECRET,
    STRIPE_MODE: "sandbox",
    DB: fakeD1(),
    // No ACK_EMAIL_API_KEY / NOTIFY_WEBHOOK_URL by default -- exercises
    // the "not configured yet" logging branches without real network calls.
    ...overrides,
  };
}

async function postWebhook(env, eventBody) {
  const payload = JSON.stringify(eventBody);
  const t = Math.floor(Date.now() / 1000);
  const v1 = await sign(TEST_SECRET, t, payload);
  const request = new Request("https://worker.example/webhooks/stripe", {
    method: "POST",
    headers: { "Stripe-Signature": `t=${t},v1=${v1}` },
    body: payload,
  });
  return worker.fetch(request, env, {});
}

function checkoutCompletedEvent(id = "evt_checkout_1") {
  return {
    id,
    type: "checkout.session.completed",
    livemode: false,
    data: {
      object: {
        id: "cs_test_123",
        payment_status: "paid",
        customer: "cus_test_123",
        subscription: "sub_test_123",
        amount_total: 59800,
        currency: "usd",
        metadata: { plan_key: "local-presence" },
        customer_details: { email: "customer@example.com", name: "Jane Customer" },
        consent: { terms_of_service: "accepted" },
      },
    },
  };
}

test("GET /health reports ready:true", async () => {
  const env = fakeEnv();
  const res = await worker.fetch(new Request("https://worker.example/health"), env, {});
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ready, true);
});

test("rejects POST with invalid signature", async () => {
  const env = fakeEnv();
  const payload = JSON.stringify(checkoutCompletedEvent());
  const request = new Request("https://worker.example/webhooks/stripe", {
    method: "POST",
    headers: { "Stripe-Signature": "t=1,v1=bogus" },
    body: payload,
  });
  const res = await worker.fetch(request, env, {});
  assert.equal(res.status, 400);
});

test("rejects non-POST methods on the webhook path", async () => {
  const env = fakeEnv();
  const request = new Request("https://worker.example/webhooks/stripe", { method: "GET" });
  const res = await worker.fetch(request, env, {});
  assert.equal(res.status, 405);
});

test("accepts a validly signed checkout.session.completed and records it in D1", async () => {
  const env = fakeEnv();
  const res = await postWebhook(env, checkoutCompletedEvent("evt_checkout_2"));
  assert.equal(res.status, 200);
  const row = env.DB._stripeEvents.get("evt_checkout_2");
  assert.ok(row, "expected a stripe_events row to be inserted");
  assert.equal(row.status, "succeeded");
});

test("idempotent: replaying the same event id is a no-op second time (PK dedup)", async () => {
  const env = fakeEnv();
  const event = checkoutCompletedEvent("evt_checkout_dup");

  const first = await postWebhook(env, event);
  assert.equal(first.status, 200);
  assert.equal(env.DB._stripeEvents.size, 1);

  const second = await postWebhook(env, event);
  assert.equal(second.status, 200);
  const secondText = await second.text();
  assert.match(secondText, /duplicate/i);
  assert.equal(env.DB._stripeEvents.size, 1, "no second row should be inserted");
});

test("checkout.session.completed with payment_status unpaid does not fulfill yet", async () => {
  const env = fakeEnv();
  const event = checkoutCompletedEvent("evt_checkout_unpaid");
  event.data.object.payment_status = "unpaid";
  const res = await postWebhook(env, event);
  assert.equal(res.status, 200);
  assert.equal(env.DB._eventDeliveries.size, 0, "no deliveries should be scheduled for an unpaid session");
});

test("checkout.session.completed schedules exactly one customer_ack and one ops_notice delivery", async () => {
  const env = fakeEnv();
  await postWebhook(env, checkoutCompletedEvent("evt_checkout_deliveries"));
  const ackKey = "evt_checkout_deliveries:customer_ack";
  const noticeKey = "evt_checkout_deliveries:ops_notice";
  assert.ok(env.DB._eventDeliveries.has(ackKey));
  assert.ok(env.DB._eventDeliveries.has(noticeKey));
  assert.equal(env.DB._eventDeliveries.get(ackKey).status, "sent"); // no provider configured -> logged, not thrown -> still "sent" path short-circuits before fetch
});

test("checkout.session.async_payment_succeeded is accepted", async () => {
  const env = fakeEnv();
  const event = { id: "evt_async_ok", type: "checkout.session.async_payment_succeeded", livemode: false, data: { object: { ...checkoutCompletedEvent().data.object, id: "cs_async_ok" } } };
  const res = await postWebhook(env, event);
  assert.equal(res.status, 200);
});

test("checkout.session.async_payment_failed is accepted and schedules an urgent ops delivery", async () => {
  const env = fakeEnv();
  const event = { id: "evt_async_fail", type: "checkout.session.async_payment_failed", livemode: false, data: { object: { ...checkoutCompletedEvent().data.object, id: "cs_async_fail" } } };
  const res = await postWebhook(env, event);
  assert.equal(res.status, 200);
  assert.ok(env.DB._eventDeliveries.has("evt_async_fail:ops_urgent"));
});

test("invoice.paid is accepted", async () => {
  const env = fakeEnv();
  const event = { id: "evt_invoice_paid", type: "invoice.paid", livemode: false, data: { object: { id: "in_test_1", customer: "cus_test_123", subscription: "sub_test_123", status: "paid", amount_paid: 29900 } } };
  const res = await postWebhook(env, event);
  assert.equal(res.status, 200);
});

test("invoice.payment_failed is accepted and triggers an urgent Flightdeck notification attempt", async () => {
  const notified = [];
  const env = fakeEnv({ NOTIFY_WEBHOOK_URL: "https://notify.example.invalid/hook" });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    notified.push({ url, body: JSON.parse(opts.body) });
    return new Response("ok", { status: 200 });
  };
  try {
    const event = { id: "evt_invoice_failed", type: "invoice.payment_failed", livemode: false, data: { object: { id: "in_test_2", customer: "cus_test_123", subscription: "sub_test_123", status: "open" } } };
    const res = await postWebhook(env, event);
    assert.equal(res.status, 200);
    assert.equal(notified.length, 1);
    assert.equal(notified[0].body.urgent, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("customer.subscription.updated is accepted", async () => {
  const env = fakeEnv();
  const event = { id: "evt_sub_updated", type: "customer.subscription.updated", livemode: false, data: { object: { id: "sub_test_123", customer: "cus_test_123", status: "active", cancel_at_period_end: true, cancel_at: 1999999999 } } };
  const res = await postWebhook(env, event);
  assert.equal(res.status, 200);
});

test("customer.subscription.deleted is accepted", async () => {
  const env = fakeEnv();
  const event = { id: "evt_sub_deleted", type: "customer.subscription.deleted", livemode: false, data: { object: { id: "sub_test_123", customer: "cus_test_123", status: "canceled" } } };
  const res = await postWebhook(env, event);
  assert.equal(res.status, 200);
});

test("charge.dispute.created triggers an urgent Flightdeck notification", async () => {
  const notified = [];
  const env = fakeEnv({ NOTIFY_WEBHOOK_URL: "https://notify.example.invalid/hook" });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    notified.push({ url, body: JSON.parse(opts.body) });
    return new Response("ok", { status: 200 });
  };
  try {
    const event = { id: "evt_dispute", type: "charge.dispute.created", livemode: false, data: { object: { id: "dp_test_1", charge: "ch_test_1", reason: "fraudulent", amount: 29900 } } };
    const res = await postWebhook(env, event);
    assert.equal(res.status, 200);
    assert.equal(notified.length, 1);
    assert.equal(notified[0].body.urgent, true);
    assert.match(notified[0].body.event, /dispute/i);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("an unhandled event type still returns 200 and is a no-op", async () => {
  const env = fakeEnv();
  const event = { id: "evt_unhandled", type: "payment_intent.created", livemode: false, data: { object: { id: "pi_x" } } };
  const res = await postWebhook(env, event);
  assert.equal(res.status, 200);
});

test("a failed delivery (e.g. ack provider down) is left in retry status, not silently dropped", async () => {
  const env = fakeEnv({ ACK_EMAIL_API_KEY: "test_key_fixture" });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response("down", { status: 500 });
  try {
    const event = checkoutCompletedEvent("evt_ack_provider_down");
    const res = await postWebhook(env, event);
    assert.equal(res.status, 200); // still ack to Stripe
    const row = env.DB._eventDeliveries.get("evt_ack_provider_down:customer_ack");
    assert.equal(row.status, "retry");
    assert.equal(row.attempt_count, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("scheduled() retries a pending/retry delivery and marks it sent on success", async () => {
  const env = fakeEnv({ NOTIFY_WEBHOOK_URL: "https://notify.example.invalid/hook" });
  // Manually seed a stripe_events row + a failed ops_notice delivery due for retry.
  const nowEpoch = Math.floor(Date.now() / 1000);
  env.DB._stripeEvents.set("evt_retry_me", { event_id: "evt_retry_me", event_type: "checkout.session.completed", livemode: 0, status: "succeeded", attempt_count: 0, received_at: nowEpoch });
  env.DB._eventDeliveries.set("evt_retry_me:ops_notice", { event_id: "evt_retry_me", action: "ops_notice", status: "retry", attempt_count: 1, dedupe_key: "evt_retry_me:ops_notice", next_attempt_at: nowEpoch - 10 });

  const originalFetch = globalThis.fetch;
  let called = false;
  globalThis.fetch = async () => { called = true; return new Response("ok", { status: 200 }); };
  try {
    await worker.scheduled({}, env, {});
    assert.equal(called, true);
    const row = env.DB._eventDeliveries.get("evt_retry_me:ops_notice");
    assert.equal(row.status, "sent");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
