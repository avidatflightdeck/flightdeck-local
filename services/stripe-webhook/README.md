# Flightdeck Stripe Subscription Webhook

A minimal, maintainable Cloudflare Worker that handles the asynchronous
Stripe events the Local Visibility checkout needs but the browser return
page cannot reliably observe (renewals, failed payments, cancellations,
disputes).

**This package has not been deployed.** No Cloudflare account, KV
namespace, or live endpoint exists yet for Flightdeck — none was found
available/authorized in the session that built this package, and per
instructions no infrastructure, credentials, domains, or accounts were
invented. Everything below is what the owner (or whoever holds Flightdeck's
Cloudflare/Stripe access) needs to do to actually stand this up.

## What's in this package

```
flightdeck-webhook/
  package.json
  wrangler.toml            # sandbox + live Worker environments, no secrets
  src/
    index.js               # the webhook handler (routing + event logic)
    stripeSignature.js      # signature verification (Web Crypto, no deps)
  test/
    stripeSignature.test.js # signature verification unit tests
    worker.test.js          # end-to-end handler tests (routing, idempotency)
  README.md                # this file
```

## What has been tested already (in this package, offline)

Run with `npm test` (needs only Node 18+, no network, no real Stripe keys):

- Signature verification: accepts a correctly signed test payload; rejects
  a tampered body; rejects a signature made with the wrong secret; rejects
  a stale timestamp (replay-window protection); rejects a missing or
  malformed `Stripe-Signature` header.
- Idempotency: posting the exact same event ID twice only triggers
  side-effect handling once (second delivery short-circuits to "duplicate,
  skip").
- Every required event type (`checkout.session.completed` — including the
  `payment_status: "unpaid"` branch that defers fulfillment —
  `checkout.session.async_payment_succeeded`,
  `checkout.session.async_payment_failed`, `invoice.paid`,
  `invoice.payment_failed`, `customer.subscription.updated`,
  `customer.subscription.deleted`, `charge.dispute.created`) is routed and
  handled without error, using realistic fixture payloads modeled on
  Stripe's documented object shapes.
- The `invoice.payment_failed` and `charge.dispute.created` handlers were
  confirmed to call the Flightdeck notification function with `urgent:
  true`.
- All log output produced during tests was inspected and contains only:
  event ID, event type, customer ID, subscription ID, checkout session ID,
  plan key, status, and a timestamp — never a secret, a signature header
  value, or card data.

All 20 tests pass as of this writing (`node --test test/*.test.js`).

**What this package cannot test by itself:** an actual live HTTPS delivery
from Stripe to a deployed URL, a real Cloudflare KV namespace persisting
across requests, or delivery of a real email/notification through a
specific provider's API (the email/notification integration below is a
placeholder that must be pointed at Flightdeck's chosen provider). Those
require the deployment steps below plus Stripe's own CLI-based "send test
event" tooling against the live sandbox endpoint.

## 1. Provision Cloudflare (owner action)

1. Create or use an existing Cloudflare account for Flightdeck.
2. Install Wrangler locally: `npm install` (installs the pinned `wrangler`
   dev dependency) then `npx wrangler login`.
3. Create two KV namespaces (one per environment, so sandbox and live
   dedupe state never mix):
   ```
   npx wrangler kv namespace create flightdeck-webhook-sandbox
   npx wrangler kv namespace create flightdeck-webhook-live
   ```
4. Copy each command's returned `id` into `wrangler.toml`, replacing
   `REPLACE_WITH_SANDBOX_KV_ID` and `REPLACE_WITH_LIVE_KV_ID`.

## 2. Set secrets (owner action — never commit these anywhere)

For the sandbox environment:
```
npx wrangler secret put STRIPE_WEBHOOK_SECRET --env sandbox   # whsec_... from the Stripe sandbox endpoint (step 3)
npx wrangler secret put STRIPE_SECRET_KEY --env sandbox       # sk_test_...
npx wrangler secret put NOTIFY_WEBHOOK_URL --env sandbox      # Flightdeck's internal ops notification endpoint
npx wrangler secret put ACK_EMAIL_API_KEY --env sandbox       # transactional email provider credential
```
Repeat with `--env live` using the live-mode equivalents once sandbox
testing (step 4) has fully passed. Sandbox and live secrets must be
different values in different environments — Wrangler keeps them isolated
per environment by design, which is why `wrangler.toml` defines two
`[env.*]` blocks.

Nothing in this repository, in Webflow, or in any report contains an actual
secret value — only the environment-variable names above.

## 3. Deploy to sandbox and register the Stripe sandbox webhook

```
npm run deploy:sandbox
```
This publishes to a `*.workers.dev` URL (or a custom route, if Flightdeck
configures one) ending in `/webhooks/stripe`. In the Stripe Dashboard,
**switch to test/sandbox mode**, then under Developers → Webhooks, add an
endpoint pointing at that sandbox Worker URL, selecting only these events:

```
checkout.session.completed
checkout.session.async_payment_succeeded
checkout.session.async_payment_failed
invoice.paid
invoice.payment_failed
customer.subscription.updated
customer.subscription.deleted
charge.dispute.created
```

Copy the endpoint's signing secret (`whsec_...`) into
`STRIPE_WEBHOOK_SECRET` for the sandbox environment (step 2) if not already
set, then redeploy (`npm run deploy:sandbox`) so the Worker picks it up.

## 4. Test the sandbox endpoint end-to-end (owner action, before going live)

Using the Stripe CLI against sandbox/test mode:
```
stripe listen --forward-to https://<your-sandbox-worker>.workers.dev/webhooks/stripe
stripe trigger checkout.session.completed
stripe trigger checkout.session.async_payment_succeeded
stripe trigger checkout.session.async_payment_failed
stripe trigger invoice.paid
stripe trigger invoice.payment_failed
stripe trigger customer.subscription.updated
stripe trigger customer.subscription.deleted
stripe trigger charge.dispute.created
```
For each, confirm in `wrangler tail --env sandbox`:
- A 200 response.
- A structured log line with the expected event type, with no secret or
  card data present.
- Re-sending the identical event (Stripe Dashboard → that event → "Resend")
  logs a duplicate/no-op rather than processing twice.
- An intentionally corrupted signature (e.g. editing the endpoint's secret
  temporarily, or using the Dashboard's "send test webhook" against the
  wrong endpoint) is rejected with 400.

Do not proceed to live registration, and do not process a real live
payment, until every item above is confirmed and the owner has explicitly
authorized moving to live mode.

## 5. Deploy live and register the live endpoint

Only after step 4 passes in full:
```
npm run deploy:live
```
In the Stripe Dashboard, switch to **live mode**, add a new webhook
endpoint pointing at the live Worker URL, selecting the same 8 event types
listed in step 3 (no more, no fewer — "only the required events," per
spec). Set the resulting live `whsec_...` as `STRIPE_WEBHOOK_SECRET` for
the live environment, redeploy, and confirm via `wrangler tail --env live`
that the endpoint receives and correctly signs/verifies a real Stripe
healthcheck ping (Stripe sends one automatically when an endpoint is
created).

## 6. Point the acknowledgment/notification integrations at real providers

`src/index.js` currently posts to a placeholder URL
(`https://api.example-email-provider.invalid/v1/send`) for the customer
acknowledgment email. Replace that URL and request body shape with
whatever transactional email provider Flightdeck authorizes (e.g. Postmark,
SendGrid, Resend), using the existing `ACK_EMAIL_API_KEY` secret binding.
`NOTIFY_WEBHOOK_URL` should point at whatever internal channel Flightdeck
wants operational alerts sent to (a Slack/Teams incoming webhook, a
ticketing system's inbound endpoint, etc.) — any HTTPS endpoint that
accepts a JSON POST will work as-is.

Until both are configured, the Worker still runs correctly and logs (without
secrets) that an acknowledgment/notification was "due but not sent," so
nothing fails silently — but customers will not actually receive an
automated acknowledgment and Flightdeck will not receive automated
enrollment/dispute alerts until this step is done.

## Security notes (already built in, carry forward)

- Signature verification runs against the **raw** request body, before any
  JSON parsing, using the endpoint's `STRIPE_WEBHOOK_SECRET` — never the
  Stripe secret API key.
- Invalid or missing signatures are rejected (HTTP 400) before any event
  processing.
- Every event is deduplicated by Stripe's own Event ID via KV before any
  side effect (acknowledgment email, Flightdeck notification) runs, so
  Stripe's automatic retries cannot cause duplicate customer emails or
  duplicate operational alerts.
- Log lines never include the signature header, either secret, or card
  data — only event ID, event type, customer ID, subscription ID,
  checkout session/invoice ID, plan key, status, and a timestamp.
- Sandbox and live each have their own KV namespace and their own secret
  values, set independently via `wrangler secret put --env <sandbox|live>`.
- All credentials are environment bindings (Worker secrets), never literals
  in source, `wrangler.toml`, or logs.
