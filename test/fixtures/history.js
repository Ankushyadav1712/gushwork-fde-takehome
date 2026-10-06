// Reads only the tests need: a job's events and messages, and the text a dedupe key produced,
// straight from SQLite.
import { all, get } from "../../server/db.js";

/** A job's events, newest first (the order Job detail shows them). */
export function eventsOf(db, jobId) {
  return all(db, "SELECT * FROM events WHERE job_id = ? ORDER BY at DESC, id DESC", [jobId]);
}

/** A job's messages in the order they arrived. */
export function messagesOf(db, jobId) {
  return all(db, "SELECT * FROM messages WHERE job_id = ? ORDER BY received_at, id", [jobId]);
}

/** The outbox row a scheduler dedupe key produced ("digest:2026-10-05"), or null. */
export function outboxRow(db, dedupeKey) {
  return get(db, "SELECT * FROM outbox WHERE dedupe_key = ?", [dedupeKey]);
}
