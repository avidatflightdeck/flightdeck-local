Migrations 1 and 2 are already applied to both the sandbox and live D1
databases (confirmed via sqlite_master inspection on 2026-10-04). This
directory intentionally contains no .sql files -- the schema already
live in both databases is authoritative; do not re-run or "init" it.

Actual schema (as inspected directly, both databases):

schema_migrations(version INTEGER PRIMARY KEY, applied_at TEXT ...)

stripe_events(
  event_id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL,
  livemode INTEGER NOT NULL CHECK (livemode IN (0,1)),
  status TEXT NOT NULL DEFAULT 'received'
    CHECK (status IN ('received','processing','retry','succeeded','dead_letter')),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  received_at INTEGER NOT NULL,
  next_attempt_at INTEGER,
  last_attempt_at INTEGER,
  processed_at INTEGER,
  last_error_code TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
)

event_deliveries(
  event_id TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('customer_ack','ops_notice','ops_urgent')),
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','sending','retry','sent','dead_letter','skipped')),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  next_attempt_at INTEGER,
  last_attempt_at INTEGER,
  sent_at INTEGER,
  provider_message_id TEXT,
  last_error_code TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  dedupe_key TEXT,
  PRIMARY KEY (event_id, action),
  FOREIGN KEY (event_id) REFERENCES stripe_events(event_id) ON DELETE CASCADE
)

Notes for the application layer:
- Event-level dedup is atomic via the PRIMARY KEY on stripe_events.event_id:
  a second delivery of the same Stripe event hits a PK violation on INSERT,
  which the Worker treats as "already seen."
- Per-action dedup (so a customer_ack and an ops_notice for the same event
  are each sent at most once, independently) is atomic via the composite
  PRIMARY KEY (event_id, action) on event_deliveries.
- livemode is stored as 0/1 (sandbox=0, live=1) rather than a 'sandbox'/'live'
  string -- matches Stripe's own event.livemode boolean.
- Timestamps that drive retry scheduling (received_at, next_attempt_at,
  last_attempt_at, processed_at, sent_at) are INTEGER (unix epoch seconds),
  not ISO text -- needed for cheap numeric comparison in the 5-minute retry
  Cron Trigger's query (WHERE next_attempt_at <= ?).
