/**
 * Verifies a Stripe webhook signature using Web Crypto (no Node-only APIs,
 * so this runs on Cloudflare Workers / any fetch-based runtime).
 *
 * Mirrors Stripe's own verification algorithm:
 * https://docs.stripe.com/webhooks#verify-manually
 *
 * @param {string} payload   Raw request body as a string (NOT parsed JSON --
 *                           signature verification must run against the
 *                           exact bytes Stripe sent, before any parsing).
 * @param {string} sigHeader The raw "Stripe-Signature" request header.
 * @param {string} secret    The endpoint's whsec_... signing secret.
 * @param {number} toleranceSeconds Max allowed clock skew (default 300s).
 * @returns {Promise<{valid: boolean, reason?: string}>}
 */
export async function verifyStripeSignature(
  payload,
  sigHeader,
  secret,
  toleranceSeconds = 300
) {
  if (!sigHeader) return { valid: false, reason: "missing_signature_header" };
  if (!secret) return { valid: false, reason: "missing_webhook_secret" };

  // Stripe-Signature header looks like: t=1699999999,v1=abcdef...,v1=...
  const parts = sigHeader.split(",").reduce((acc, part) => {
    const [k, v] = part.split("=");
    if (k === "t") acc.t = v;
    else if (k === "v1") (acc.v1 ||= []).push(v);
    return acc;
  }, { v1: [] });

  if (!parts.t || parts.v1.length === 0) {
    return { valid: false, reason: "malformed_signature_header" };
  }

  const timestamp = Number(parts.t);
  if (!Number.isFinite(timestamp)) {
    return { valid: false, reason: "malformed_timestamp" };
  }

  const nowSeconds = Math.floor(Date.now() / 1000);
  if (Math.abs(nowSeconds - timestamp) > toleranceSeconds) {
    return { valid: false, reason: "timestamp_outside_tolerance" };
  }

  const signedPayload = `${parts.t}.${payload}`;
  const expectedSig = await hmacSha256Hex(secret, signedPayload);

  const matched = parts.v1.some((candidate) =>
    timingSafeEqualHex(candidate, expectedSig)
  );

  return matched ? { valid: true } : { valid: false, reason: "signature_mismatch" };
}

async function hmacSha256Hex(secret, message) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sigBuffer = await crypto.subtle.sign("HMAC", key, enc.encode(message));
  return [...new Uint8Array(sigBuffer)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function timingSafeEqualHex(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}
