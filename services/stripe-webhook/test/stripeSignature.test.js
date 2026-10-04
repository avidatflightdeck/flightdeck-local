import { test } from "node:test";
import assert from "node:assert/strict";
import { verifyStripeSignature } from "../src/stripeSignature.js";

// Test-only secret and payload -- NOT a real Stripe credential. Used solely
// to exercise the HMAC verification logic with known-good/bad inputs.
const TEST_SECRET = "whsec_test_fixture_only_not_a_real_secret";

async function signPayload(secret, timestamp, payload) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign(
    "HMAC",
    key,
    enc.encode(`${timestamp}.${payload}`)
  );
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

test("accepts a correctly signed payload within tolerance", async () => {
  const payload = JSON.stringify({ id: "evt_test_1", type: "checkout.session.completed" });
  const t = Math.floor(Date.now() / 1000);
  const v1 = await signPayload(TEST_SECRET, t, payload);
  const header = `t=${t},v1=${v1}`;

  const result = await verifyStripeSignature(payload, header, TEST_SECRET);
  assert.equal(result.valid, true);
});

test("rejects a payload with a tampered body", async () => {
  const originalPayload = JSON.stringify({ id: "evt_test_2", amount: 100 });
  const t = Math.floor(Date.now() / 1000);
  const v1 = await signPayload(TEST_SECRET, t, originalPayload);
  const header = `t=${t},v1=${v1}`;

  const tamperedPayload = JSON.stringify({ id: "evt_test_2", amount: 999999 });
  const result = await verifyStripeSignature(tamperedPayload, header, TEST_SECRET);
  assert.equal(result.valid, false);
  assert.equal(result.reason, "signature_mismatch");
});

test("rejects a signature produced with the wrong secret", async () => {
  const payload = JSON.stringify({ id: "evt_test_3" });
  const t = Math.floor(Date.now() / 1000);
  const v1 = await signPayload("whsec_wrong_secret_fixture", t, payload);
  const header = `t=${t},v1=${v1}`;

  const result = await verifyStripeSignature(payload, header, TEST_SECRET);
  assert.equal(result.valid, false);
  assert.equal(result.reason, "signature_mismatch");
});

test("rejects a timestamp outside tolerance (replay protection)", async () => {
  const payload = JSON.stringify({ id: "evt_test_4" });
  const oldTimestamp = Math.floor(Date.now() / 1000) - 10000; // way outside 300s window
  const v1 = await signPayload(TEST_SECRET, oldTimestamp, payload);
  const header = `t=${oldTimestamp},v1=${v1}`;

  const result = await verifyStripeSignature(payload, header, TEST_SECRET);
  assert.equal(result.valid, false);
  assert.equal(result.reason, "timestamp_outside_tolerance");
});

test("rejects a missing Stripe-Signature header", async () => {
  const result = await verifyStripeSignature("{}", null, TEST_SECRET);
  assert.equal(result.valid, false);
  assert.equal(result.reason, "missing_signature_header");
});

test("rejects a malformed header", async () => {
  const result = await verifyStripeSignature("{}", "not-a-real-header", TEST_SECRET);
  assert.equal(result.valid, false);
  assert.equal(result.reason, "malformed_signature_header");
});

test("rejects when no webhook secret is configured", async () => {
  const payload = "{}";
  const t = Math.floor(Date.now() / 1000);
  const header = `t=${t},v1=deadbeef`;
  const result = await verifyStripeSignature(payload, header, undefined);
  assert.equal(result.valid, false);
  assert.equal(result.reason, "missing_webhook_secret");
});
