# Flightdeck Local

Source of truth for Flightdeck Advertising & Marketing's "Local Visibility"
product infrastructure: the Webflow landing page and onboarding flow,
Stripe Checkout subscriptions, and the backing services that keep
enrollment, billing, and customer communication correct after checkout.

This repository is intended to grow beyond the Stripe webhook over time.
Today it contains one service:

```
flightdeck-local/
  services/
    stripe-webhook/      -- Cloudflare Worker: Stripe subscription webhook
  README.md               -- this file
  .gitignore
```

## Architecture

```
┌─────────────────────┐        ┌──────────────────────────┐
│  Webflow             │        │  Stripe                   │
│  /local-visibility    │──────▶│  Checkout (Payment Links)  │
│  landing page +        │       │  Subscriptions              │
│  /onboarding           │◀──────│  (sync return redirect)     │
└─────────────────────┘        └───────────┬──────────────┘
                                             │ async webhook events
                                             ▼
                                ┌──────────────────────────┐
                                │  Cloudflare Worker         │
                                │  services/stripe-webhook   │
                                │  - verifies Stripe          │
                                │    signatures               │
                                │  - records a minimal event  │
                                │    row, fast                │
                                └───────────┬──────────────┘
                                             │
                     ┌───────────────────────┼───────────────────────┐
                     ▼                                               ▼
        ┌──────────────────────────┐                  ┌──────────────────────────┐
        │  Cloudflare D1             │                  │  (planned) Cloudflare     │
        │  stripe_events              │                  │  Queue + DLQ               │
        │  event_deliveries           │                  │  async consumer for        │
        │  -- idempotency, status,    │◀─────────────────│  slow side effects          │
        │  retry/audit state          │   delivery status  │  (see services/            │
        └──────────────────────────┘    written back     │  stripe-webhook/README)    │
                                                           └───────────┬──────────────┘
                                                                       │
                                                       ┌───────────────┴───────────────┐
                                                       ▼                               ▼
                                          ┌──────────────────────┐      ┌──────────────────────┐
                                          │ Transactional email    │      │ Flightdeck internal    │
                                          │ (customer               │      │ notification             │
                                          │ acknowledgment)          │      │ (new enrollment,          │
                                          │                          │      │ failed payment, dispute)  │
                                          └──────────────────────┘      └──────────────────────┘
```

**Webflow landing page and onboarding** — `/local-visibility` presents the
two subscription plans (Local Presence, Local Search) and links to Stripe
Payment Links. After checkout, Stripe redirects the customer to
`/onboarding` with the plan and Checkout Session ID in the URL. This page
is a confirmation step for the customer, not a fulfillment mechanism — see
below.

**Stripe Checkout and subscriptions** — two live Stripe Payment Links, one
per plan, with required Terms-of-Service consent (linking to Flightdeck's
own Service Terms and Privacy Policy, not to be confused with Stripe
Link's own, separate legal pages), automatic monthly renewal, a 90-day
initial commitment, and a one-time setup fee alongside the first month's
charge. Automatic tax is currently disabled pending a jurisdiction review.

**Cloudflare Worker webhook** (`services/stripe-webhook/`) — the
asynchronous side of the integration. Renewals, failed payments,
subscription changes, and cancellations all happen on Stripe's own clock,
not in the customer's browser, so the onboarding return page cannot be the
system of record for any of them. The Worker verifies every inbound
Stripe signature, rejects invalid ones, and persists a minimal event
record before doing anything else, so the request returns to Stripe
quickly and reliably.

**D1 event and delivery records** — `stripe_events` is the idempotency
ledger (one row per Stripe Event ID, enforced by its PRIMARY KEY so a
retried delivery can never be processed twice); `event_deliveries` tracks
each individual side effect (a customer acknowledgment email, an internal
Flightdeck notification) with its own status, attempt count, and retry
timestamp, keyed so a given event's given delivery type is also sent at
most once. See `services/stripe-webhook/migrations/README.md` for the
exact schema.

**Future Cloudflare Queue and dead-letter queue** — the current
synchronous Cron-based retry sweep (a 5-minute scheduled check of
`event_deliveries` rows left in `pending`/`retry`) is a deliberate,
documented interim design. The target production architecture moves slow
side effects (sending email, calling the internal notification endpoint)
off the webhook request entirely: the webhook's job narrows to
verify-and-record, a Cloudflare Queue carries each delivery to an
asynchronous consumer, and a dead-letter queue catches anything that
exhausts its retries for manual review. See
`services/stripe-webhook/README.md` for the current status of that
migration.

**Transactional customer email and Flightdeck notifications** — on a
successful enrollment (or a delayed-payment success), the customer
receives an acknowledgment with their plan, pricing, commitment terms,
cancellation method, and Flightdeck's Service Terms/Privacy Policy links;
Flightdeck's own team is notified of new enrollments, failed payments, and
disputes. Neither path ever includes card data, and both are keyed for
the same per-event-per-action idempotency as the rest of the system.

## Services

| Service | Path | Description |
|---|---|---|
| Stripe webhook | [`services/stripe-webhook/`](services/stripe-webhook/) | Cloudflare Worker handling Stripe subscription lifecycle events for Local Visibility |
