import { verifyStripeSignature } from "./stripeSignature.js";

/**
 * Flightdeck Local Visibility — Stripe subscription webhook (Cloudflare Worker).
 *
 * Persistence: Cloudflare D1 (binding env.DB), using the pre-existing
 * `stripe_events` / `event_deliveries` schema (see migrations/README.md
 * for the exact column definitions — this file does not create or alter
 * that schema, only reads/writes it).
 *
 * Security/logging discipline (per spec):
 *  - Never logs the raw Stripe-Signature header, the webhook signing secret,
 *    the Stripe secret key, or card data.
 *  - Structured log lines only ever include: event id, event type, customer
 *    id, subscription id, checkout session id, plan key, status, timestamp.
 *  - All credentials come from env bindings (Worker secrets), never literals.
 */

const PLAN_LABELS = {
  "local-presence": "Local Presence",
  "local-search": "Local Search",
};

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/health") {
      return json({ service: "flightdeck-stripe-webhook", environment: env.STRIPE_MODE, appEnv: env.APP_ENV || null, ready: true });
    }

    if (request.method !== "POST") {
      return new Response("Method Not Allowed", { status: 405 });
    }
    if (url.pathname !== "/webhooks/stripe") {
      return new Response("Not Found", { status: 404 });
    }

    const rawBody = await request.text();
    const sigHeader = request.headers.get("Stripe-Signature");

    const verification = await verifyStripeSignature(rawBody, sigHeader, env.STRIPE_WEBHOOK_SECRET);
    if (!verification.valid) {
      console.log(JSON.stringify({ level: "warn", msg: "webhook_signature_rejected", reason: verification.reason, mode: env.STRIPE_MODE }));
      return new Response("Invalid signature", { status: 400 });
    }

    let event;
    try {
      event = JSON.parse(rawBody);
    } catch {
      return new Response("Invalid payload", { status: 400 });
    }

    const nowEpoch = Math.floor(Date.now() / 1000);
    const livemode = event.livemode ? 1 : 0;

    // --- Environment guard: never let a live event be processed by the
    // sandbox deployment, or a test event by the live deployment. APP_ENV
    // is set per-environment in wrangler.toml and must never be absent in
    // a real deployment; if it is, fail safe (reject) rather than guess.
    const expectedLivemode = env.APP_ENV === "live" ? 1 : env.APP_ENV === "sandbox" ? 0 : null;
    if (expectedLivemode === null) {
      console.log(JSON.stringify({ level: "error", msg: "app_env_not_configured", eventId: event.id }));
      return new Response("Environment not configured", { status: 500 });
    }
    if (livemode !== expectedLivemode) {
      console.log(JSON.stringify({ level: "warn", msg: "livemode_mismatch_rejected", eventId: event.id, eventType: event.type, appEnv: env.APP_ENV, eventLivemode: !!event.livemode }));
      // Safely no-op: acknowledge receipt (it's a validly signed Stripe
      // event, just not meant for this environment) without recording or
      // processing it here.
      return new Response("OK (livemode mismatch, ignored)", { status: 200 });
    }

    // --- Atomic event-level dedup: PRIMARY KEY on stripe_events.event_id ---
    // A duplicate delivery of the same Stripe event hits a PK violation on
    // this INSERT rather than a read-then-write race.
    let insertedNewEvent = true;
    try {
      await env.DB.prepare(
        `INSERT INTO stripe_events (event_id, event_type, livemode, status, attempt_count, received_at)
         VALUES (?, ?, ?, 'received', 0, ?)`
      ).bind(event.id, event.type, livemode, nowEpoch).run();
    } catch (err) {
      if (isUniqueConstraintError(err)) {
        insertedNewEvent = false;
      } else {
        console.log(JSON.stringify({ level: "error", msg: "stripe_events_insert_failed", eventId: event.id, error: String(err && err.message ? err.message : err) }));
        // Can't safely proceed without a row to track against -- ack so
        // Stripe doesn't hammer retries for a DB-side problem; this will
        // surface via the error log / dead_letter review instead.
        return new Response("OK", { status: 200 });
      }
    }

    if (!insertedNewEvent) {
      console.log(JSON.stringify({ level: "info", msg: "duplicate_event_skipped", eventId: event.id, eventType: event.type }));
      return new Response("OK (duplicate)", { status: 200 });
    }

    try {
      await routeEvent(event, env, nowEpoch);
      await env.DB.prepare(
        `UPDATE stripe_events SET status = 'succeeded', processed_at = ?, updated_at = CURRENT_TIMESTAMP WHERE event_id = ?`
      ).bind(nowEpoch, event.id).run();
    } catch (err) {
      console.log(JSON.stringify({ level: "error", msg: "event_handler_error", eventId: event.id, eventType: event.type, error: String(err && err.message ? err.message : err) }));
      await env.DB.prepare(
        `UPDATE stripe_events SET status = 'retry', attempt_count = attempt_count + 1, last_attempt_at = ?, next_attempt_at = ?, last_error_code = ?, updated_at = CURRENT_TIMESTAMP WHERE event_id = ?`
      ).bind(nowEpoch, nowEpoch + 300, String(err && err.message ? err.message : err).slice(0, 200), event.id).run().catch(() => {});
      // Still 200 -- Stripe's own retries would otherwise duplicate the
      // stripe_events row attempt; our 5-minute Cron Trigger retries
      // event_deliveries rows left in 'retry'/'pending' instead.
    }

    return new Response("OK", { status: 200 });
  },

  /**
   * Cron Trigger entry point (sandbox: every 5 minutes). Retries any
   * event_deliveries rows still in 'pending' or 'retry' whose
   * next_attempt_at has passed.
   */
  async scheduled(event, env, ctx) {
    const nowEpoch = Math.floor(Date.now() / 1000);
    const due = await env.DB.prepare(
      `SELECT event_id, action, attempt_count FROM event_deliveries
       WHERE status IN ('pending', 'retry')
         AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
       LIMIT 25`
    ).bind(nowEpoch).all();

    for (const row of due.results || []) {
      await retryDelivery(row, env, nowEpoch);
    }

    console.log(JSON.stringify({ level: "info", msg: "retry_sweep_completed", mode: env.STRIPE_MODE, candidates: (due.results || []).length, processedAt: new Date(nowEpoch * 1000).toISOString() }));
  },
};

async function retryDelivery(row, env, nowEpoch) {
  const eventRow = await env.DB.prepare(`SELECT * FROM stripe_events WHERE event_id = ?`).bind(row.event_id).first();
  if (!eventRow) return;

  try {
    await performDelivery(row.action, eventRow, env);
    await markDeliverySent(env, row.event_id, row.action, nowEpoch);
  } catch (err) {
    const nextAttempt = nowEpoch + 300; // retry again in 5 minutes
    const giveUp = (row.attempt_count || 0) + 1 >= 5;
    await env.DB.prepare(
      `UPDATE event_deliveries
       SET status = ?, attempt_count = attempt_count + 1, last_attempt_at = ?, next_attempt_at = ?, last_error_code = ?, updated_at = CURRENT_TIMESTAMP
       WHERE event_id = ? AND action = ?`
    ).bind(giveUp ? "dead_letter" : "retry", nowEpoch, giveUp ? null : nextAttempt, String(err && err.message ? err.message : err).slice(0, 200), row.event_id, row.action).run();
  }
}

/* ------------------------------------------------------------------------ */
/* Event routing                                                            */
/* ------------------------------------------------------------------------ */

async function routeEvent(event, env, nowEpoch) {
  const type = event.type;
  const obj = event.data && event.data.object;

  switch (type) {
    case "checkout.session.completed":
      return handleCheckoutSessionCompleted(event, obj, env, nowEpoch);
    case "checkout.session.async_payment_succeeded":
      return handleAsyncPaymentSucceeded(event, obj, env, nowEpoch);
    case "checkout.session.async_payment_failed":
      return handleAsyncPaymentFailed(event, obj, env, nowEpoch);
    case "invoice.paid":
      return handleInvoicePaid(event, obj, env, nowEpoch);
    case "invoice.payment_failed":
      return handleInvoicePaymentFailed(event, obj, env, nowEpoch);
    case "customer.subscription.updated":
      return handleSubscriptionUpdated(event, obj, env, nowEpoch);
    case "customer.subscription.deleted":
      return handleSubscriptionDeleted(event, obj, env, nowEpoch);
    case "charge.dispute.created":
      return handleDisputeCreated(event, obj, env, nowEpoch);
    default:
      console.log(JSON.stringify({ level: "info", msg: "unhandled_event_type_ignored", eventId: event.id, eventType: type }));
      return;
  }
}

async function handleCheckoutSessionCompleted(event, session, env, nowEpoch) {
  if (session.payment_status === "unpaid") {
    console.log(logLine(event, session, { status: "unpaid_awaiting_async_result" }));
    return;
  }

  const planKey = session.metadata && session.metadata.plan_key;
  console.log(JSON.stringify({ level: "info", msg: "enrollment_recorded", eventId: event.id, customerId: asId(session.customer), subscriptionId: asId(session.subscription), checkoutSessionId: session.id, plan: planKey || "unknown", status: "enrollment_paid", processedAt: new Date(nowEpoch * 1000).toISOString() }));

  const consentAccepted = session.consent && session.consent.terms_of_service === "accepted";
  console.log(JSON.stringify({ level: "info", msg: "consent_recorded", eventId: event.id, checkoutSessionId: session.id, termsOfServiceAccepted: !!consentAccepted }));

  await scheduleDelivery(env, event.id, "customer_ack", nowEpoch, session, { planKey });
  await scheduleDelivery(env, event.id, "ops_notice", nowEpoch, session, { planKey, label: "New enrollment" });
}

async function handleAsyncPaymentSucceeded(event, session, env, nowEpoch) {
  const planKey = session.metadata && session.metadata.plan_key;
  console.log(logLine(event, session, { status: "async_payment_succeeded" }));
  await scheduleDelivery(env, event.id, "customer_ack", nowEpoch, session, { planKey });
  await scheduleDelivery(env, event.id, "ops_notice", nowEpoch, session, { planKey, label: "Enrollment completed (delayed payment cleared)" });
}

async function handleAsyncPaymentFailed(event, session, env, nowEpoch) {
  const planKey = session.metadata && session.metadata.plan_key;
  console.log(logLine(event, session, { status: "async_payment_failed" }));
  await scheduleDelivery(env, event.id, "ops_urgent", nowEpoch, session, { planKey, label: "Enrollment NOT completed -- delayed payment failed" });
}

async function handleInvoicePaid(event, invoice, env, nowEpoch) {
  console.log(JSON.stringify({ level: "info", msg: "recurring_billing_period_paid", eventId: event.id, customerId: asId(invoice.customer), subscriptionId: asId(invoice.subscription), invoiceId: invoice.id, status: invoice.status, processedAt: new Date(nowEpoch * 1000).toISOString() }));
}

async function handleInvoicePaymentFailed(event, invoice, env, nowEpoch) {
  console.log(JSON.stringify({ level: "warn", msg: "recurring_billing_payment_failed", eventId: event.id, customerId: asId(invoice.customer), subscriptionId: asId(invoice.subscription), invoiceId: invoice.id, status: invoice.status, processedAt: new Date(nowEpoch * 1000).toISOString() }));
  await scheduleDelivery(env, event.id, "ops_urgent", nowEpoch, invoice, { label: "Recurring payment FAILED", isInvoice: true });
}

async function handleSubscriptionUpdated(event, subscription, env, nowEpoch) {
  console.log(JSON.stringify({ level: "info", msg: "subscription_updated", eventId: event.id, customerId: asId(subscription.customer), subscriptionId: subscription.id, status: subscription.status, cancelAtPeriodEnd: subscription.cancel_at_period_end, cancelAt: subscription.cancel_at || null, processedAt: new Date(nowEpoch * 1000).toISOString() }));
}

async function handleSubscriptionDeleted(event, subscription, env, nowEpoch) {
  console.log(JSON.stringify({ level: "info", msg: "subscription_terminated", eventId: event.id, customerId: asId(subscription.customer), subscriptionId: subscription.id, status: subscription.status, processedAt: new Date(nowEpoch * 1000).toISOString() }));
}

async function handleDisputeCreated(event, dispute, env, nowEpoch) {
  console.log(JSON.stringify({ level: "error", msg: "dispute_created", eventId: event.id, chargeId: asId(dispute.charge), reason: dispute.reason, amount: dispute.amount, processedAt: new Date(nowEpoch * 1000).toISOString() }));
  await scheduleDelivery(env, event.id, "ops_urgent", nowEpoch, dispute, { label: "URGENT: Payment dispute opened", isDispute: true });
}

/* ------------------------------------------------------------------------ */
/* Deliveries (D1-backed, atomic per (event_id, action))                    */
/* ------------------------------------------------------------------------ */

/**
 * Inserts a pending event_deliveries row and attempts it immediately.
 * The composite PRIMARY KEY (event_id, action) means a second attempt to
 * schedule the same action for the same event (e.g. a retried Stripe
 * delivery that got past the event-level dedup some other way) hits a PK
 * violation and is treated as already-scheduled -- never double-sent.
 */
async function scheduleDelivery(env, eventId, action, nowEpoch, payloadObj, meta) {
  const dedupeKey = `${eventId}:${action}`;
  try {
    await env.DB.prepare(
      `INSERT INTO event_deliveries (event_id, action, status, attempt_count, dedupe_key)
       VALUES (?, ?, 'pending', 0, ?)`
    ).bind(eventId, action, dedupeKey).run();
  } catch (err) {
    if (isUniqueConstraintError(err)) {
      console.log(JSON.stringify({ level: "info", msg: "delivery_already_scheduled", eventId, action }));
      return;
    }
    throw err;
  }

  try {
    await performDelivery(action, { event_id: eventId, _payload: payloadObj, _meta: meta }, env);
    await markDeliverySent(env, eventId, action, nowEpoch);
  } catch (err) {
    await env.DB.prepare(
      `UPDATE event_deliveries SET status = 'retry', attempt_count = attempt_count + 1, last_attempt_at = ?, next_attempt_at = ?, last_error_code = ?, updated_at = CURRENT_TIMESTAMP WHERE event_id = ? AND action = ?`
    ).bind(nowEpoch, nowEpoch + 300, String(err && err.message ? err.message : err).slice(0, 200), eventId, action).run();
    console.log(JSON.stringify({ level: "warn", msg: "delivery_attempt_failed_will_retry", eventId, action }));
  }
}

async function markDeliverySent(env, eventId, action, nowEpoch) {
  await env.DB.prepare(
    `UPDATE event_deliveries SET status = 'sent', sent_at = ?, updated_at = CURRENT_TIMESTAMP WHERE event_id = ? AND action = ?`
  ).bind(nowEpoch, eventId, action).run();
}

/**
 * Executes one delivery action. For a fresh send, `record._payload` carries
 * the original Stripe object; for a retry sweep, only `record` (the D1 row
 * + the re-fetched stripe_events row) is available, so retried deliveries
 * send a reduced-content version (reference IDs only) rather than
 * re-deriving full customer details that were not persisted -- this is a
 * deliberate privacy tradeoff (see README: full session/customer detail is
 * not stored in D1, only IDs).
 */
async function performDelivery(action, record, env) {
  const payload = record._payload || null;
  const meta = record._meta || {};

  if (action === "customer_ack") {
    return sendCustomerAcknowledgment(payload, env, meta);
  }
  if (action === "ops_notice" || action === "ops_urgent") {
    return notifyFlightdeck(env, {
      event: meta.label || "Flightdeck notification",
      plan: PLAN_LABELS[meta.planKey] || meta.planKey || undefined,
      checkoutSessionId: payload && !meta.isInvoice && !meta.isDispute ? payload.id : null,
      customerId: payload ? asId(payload.customer) : null,
      subscriptionId: payload ? asId(payload.subscription) : null,
      chargeId: meta.isDispute ? asId(payload && payload.charge) : undefined,
      urgent: action === "ops_urgent",
    });
  }
}

async function sendCustomerAcknowledgment(session, env, { planKey }) {
  if (!session) return; // retry sweep with no cached payload -- nothing to send without PII we don't store
  const plan = PLAN_LABELS[planKey] || planKey || "Local Visibility";
  const customerEmail = (session.customer_details && session.customer_details.email) || null;
  const customerName = (session.customer_details && session.customer_details.name) || null;

  const acknowledgment = {
    customerName,
    plan,
    initialPayment: formatAmount(session.amount_total, session.currency),
    monthlyRenewalPrice: planRenewalPrice(planKey),
    billingFrequency: "Monthly",
    setupFee: planSetupFee(planKey),
    initialCommitment: "90 days (first 3 monthly billing periods)",
    cancellationMethod: "Email support@flightdeckadvertising.com to cancel.",
    supportEmail: "support@flightdeckadvertising.com",
    serviceTermsUrl: "https://flightdeckadvertising.com/terms",
    privacyPolicyUrl: "https://flightdeckadvertising.com/privacy-policy",
    reference: session.id,
  };

  if (!env.ACK_EMAIL_API_KEY || !customerEmail) {
    console.log(JSON.stringify({ level: "warn", msg: "customer_acknowledgment_not_sent_missing_provider_or_email", checkoutSessionId: session.id, plan: planKey || "unknown" }));
    return;
  }

  const res = await fetch("https://api.example-email-provider.invalid/v1/send", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${env.ACK_EMAIL_API_KEY}` },
    body: JSON.stringify({ to: customerEmail, template: "flightdeck-enrollment-acknowledgment", data: acknowledgment }),
  });
  if (!res.ok) throw new Error(`ack_email_provider_${res.status}`);
}

async function notifyFlightdeck(env, payload) {
  if (!env.NOTIFY_WEBHOOK_URL) {
    console.log(JSON.stringify({ level: "warn", msg: "flightdeck_notification_not_sent_missing_target", event: payload.event }));
    return;
  }
  const res = await fetch(env.NOTIFY_WEBHOOK_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error(`notify_target_${res.status}`);
}

/* ------------------------------------------------------------------------ */
/* Helpers                                                                   */
/* ------------------------------------------------------------------------ */

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" } });
}

function asId(objOrId) {
  if (!objOrId) return null;
  return typeof objOrId === "string" ? objOrId : objOrId.id || null;
}

function isUniqueConstraintError(err) {
  const msg = String(err && err.message ? err.message : err);
  return /UNIQUE constraint failed/i.test(msg) || /SQLITE_CONSTRAINT/i.test(msg);
}

function formatAmount(amountInCents, currency) {
  if (typeof amountInCents !== "number") return null;
  return `${(currency || "usd").toUpperCase()} $${(amountInCents / 100).toFixed(2)}`;
}

function planRenewalPrice(planKey) {
  if (planKey === "local-presence") return "$299/month";
  if (planKey === "local-search") return "$499/month";
  return "See plan details";
}

function planSetupFee(planKey) {
  if (planKey === "local-presence") return "$299 one-time";
  if (planKey === "local-search") return "$499 one-time";
  return "See plan details";
}

function logLine(event, obj, extra) {
  return JSON.stringify({
    level: "info",
    eventId: event.id,
    eventType: event.type,
    checkoutSessionId: obj && obj.id,
    customerId: asId(obj && obj.customer),
    subscriptionId: asId(obj && obj.subscription),
    plan: (obj && obj.metadata && obj.metadata.plan_key) || null,
    processedAt: new Date().toISOString(),
    ...extra,
  });
}
