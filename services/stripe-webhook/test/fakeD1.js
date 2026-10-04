/**
 * Minimal in-memory stand-in for a Cloudflare D1 binding, implementing
 * just enough of the real schema (stripe_events, event_deliveries) and
 * SQL subset the Worker actually uses to exercise its dedup logic
 * offline, without a real Cloudflare account.
 *
 * This is NOT a SQL engine -- it pattern-matches the specific statements
 * src/index.js issues. If the handler's queries change, this file needs
 * matching updates. It intentionally enforces the same two constraints
 * that make the real schema's dedup atomic:
 *   - stripe_events.event_id is a PRIMARY KEY (duplicate insert throws)
 *   - event_deliveries (event_id, action) is a composite PRIMARY KEY
 *     (duplicate insert throws)
 */
export function fakeD1() {
  const stripeEvents = new Map(); // event_id -> row
  const eventDeliveries = new Map(); // `${event_id}:${action}` -> row

  function uniqueError(msg) {
    const e = new Error(`UNIQUE constraint failed: ${msg}`);
    return e;
  }

  const db = {
    _stripeEvents: stripeEvents,
    _eventDeliveries: eventDeliveries,

    prepare(sql) {
      const normalized = sql.replace(/\s+/g, " ").trim();
      return {
        bind(...args) {
          return {
            async run() {
              if (/^INSERT INTO stripe_events/i.test(normalized)) {
                const [eventId, eventType, livemode, receivedAt] = args;
                if (stripeEvents.has(eventId)) throw uniqueError("stripe_events.event_id");
                stripeEvents.set(eventId, {
                  event_id: eventId,
                  event_type: eventType,
                  livemode,
                  status: "received",
                  attempt_count: 0,
                  received_at: receivedAt,
                  next_attempt_at: null,
                  last_attempt_at: null,
                  processed_at: null,
                  last_error_code: null,
                });
                return { success: true };
              }
              if (/^UPDATE stripe_events SET status = 'succeeded'/i.test(normalized)) {
                const [processedAt, eventId] = args;
                const row = stripeEvents.get(eventId);
                if (row) { row.status = "succeeded"; row.processed_at = processedAt; }
                return { success: true };
              }
              if (/^UPDATE stripe_events SET status = 'retry'/i.test(normalized)) {
                const [lastAttemptAt, nextAttemptAt, errCode, eventId] = args;
                const row = stripeEvents.get(eventId);
                if (row) {
                  row.status = "retry";
                  row.attempt_count += 1;
                  row.last_attempt_at = lastAttemptAt;
                  row.next_attempt_at = nextAttemptAt;
                  row.last_error_code = errCode;
                }
                return { success: true };
              }
              if (/^INSERT INTO event_deliveries/i.test(normalized)) {
                const [eventId, action, dedupeKey] = args;
                const key = `${eventId}:${action}`;
                if (eventDeliveries.has(key)) throw uniqueError("event_deliveries.event_id, action");
                eventDeliveries.set(key, {
                  event_id: eventId,
                  action,
                  status: "pending",
                  attempt_count: 0,
                  dedupe_key: dedupeKey,
                  next_attempt_at: null,
                  last_attempt_at: null,
                  sent_at: null,
                  last_error_code: null,
                });
                return { success: true };
              }
              if (/^UPDATE event_deliveries SET status = 'sent'/i.test(normalized)) {
                const [sentAt, eventId, action] = args;
                const row = eventDeliveries.get(`${eventId}:${action}`);
                if (row) { row.status = "sent"; row.sent_at = sentAt; }
                return { success: true };
              }
              if (/^UPDATE event_deliveries SET status = 'retry'/i.test(normalized)) {
                // scheduleDelivery's failure path -- status is a literal, not bound
                const [lastAttemptAt, nextAttemptAt, errCode, eventId, action] = args;
                const row = eventDeliveries.get(`${eventId}:${action}`);
                if (row) {
                  row.status = "retry";
                  row.attempt_count += 1;
                  row.last_attempt_at = lastAttemptAt;
                  row.next_attempt_at = nextAttemptAt;
                  row.last_error_code = errCode;
                }
                return { success: true };
              }
              if (/^UPDATE event_deliveries\s+SET status = \?/i.test(normalized)) {
                // retryDelivery's dynamic-status update (status IS bound here)
                const [status, lastAttemptAt, nextAttemptAt, errCode, eventId, action] = args;
                const row = eventDeliveries.get(`${eventId}:${action}`);
                if (row) {
                  row.status = status;
                  row.attempt_count += 1;
                  row.last_attempt_at = lastAttemptAt;
                  row.next_attempt_at = nextAttemptAt;
                  row.last_error_code = errCode;
                }
                return { success: true };
              }
              throw new Error(`fakeD1: unrecognized statement: ${normalized}`);
            },
            async first() {
              if (/^SELECT \* FROM stripe_events WHERE event_id = \?/i.test(normalized)) {
                const [eventId] = args;
                return stripeEvents.get(eventId) || null;
              }
              throw new Error(`fakeD1: unrecognized first() statement: ${normalized}`);
            },
            async all() {
              if (/^SELECT event_id, action, attempt_count FROM event_deliveries/i.test(normalized)) {
                const [nowEpoch] = args;
                const results = [...eventDeliveries.values()].filter(
                  (r) => (r.status === "pending" || r.status === "retry") && (r.next_attempt_at == null || r.next_attempt_at <= nowEpoch)
                );
                return { results };
              }
              throw new Error(`fakeD1: bind().all() not expected for: ${normalized}`);
            },
          };
        },
        async all() {
          if (/^SELECT event_id, action, attempt_count FROM event_deliveries/i.test(normalized)) {
            const results = [...eventDeliveries.values()].filter((r) => r.status === "pending" || r.status === "retry");
            return { results };
          }
          throw new Error(`fakeD1: unrecognized all() statement: ${normalized}`);
        },
      };
    },
  };

  return db;
}
