// SQLite storage (node:sqlite DatabaseSync): schema, migrations and small query helpers.
// The schema is SPEC §6, verbatim. Migrations are keyed by PRAGMA user_version.
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

const SCHEMA_V1 = `
CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);           -- value = JSON

CREATE TABLE customers (
  id INTEGER PRIMARY KEY,
  contact_name TEXT, business_name TEXT,
  phone TEXT,                         -- E.164, e.g. +13125550142
  email TEXT,                         -- lowercased
  address TEXT, notes TEXT,
  blocked INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX customers_phone ON customers(phone) WHERE phone IS NOT NULL;
CREATE INDEX customers_email ON customers(email);

CREATE TABLE jobs (
  id INTEGER PRIMARY KEY,
  customer_id INTEGER NOT NULL REFERENCES customers(id),
  stage TEXT NOT NULL CHECK (stage IN ('new','quote','waiting_yes','to_schedule','scheduled','done','lost')),
  source TEXT NOT NULL CHECK (source IN ('call','sms','email','form','manual','bulk')),
  source_detail TEXT CHECK (source_detail IS NULL OR source_detail IN ('voicemail','missed','answered','forwarded')),
  problem TEXT,                       -- one line, <= 60 chars
  details TEXT,
  equipment TEXT CHECK (equipment IS NULL OR equipment IN
    ('walk_in_cooler','walk_in_freezer','ice_machine','reach_in','display_case','prep_table','other')),
  urgent INTEGER NOT NULL DEFAULT 0,
  urgent_source TEXT,                 -- 'rules' | 'ai' | 'manual'
  ai_not_service INTEGER NOT NULL DEFAULT 0,
  parsed_by TEXT,                     -- 'rules' | 'ai' | 'manual'
  quote_amount INTEGER, quote_sent_at TEXT,
  visit_date TEXT, tech TEXT, notes TEXT,
  created_at TEXT NOT NULL,           -- when the request came in (message received_at)
  updated_at TEXT NOT NULL,
  stage_entered_at TEXT NOT NULL,
  first_touch_at TEXT, last_touch_at TEXT,
  next_due_at TEXT, snoozed_until TEXT, unread_inbound_at TEXT,
  attempts INTEGER NOT NULL DEFAULT 0, nudges INTEGER NOT NULL DEFAULT 0,
  won_at TEXT, done_at TEXT, lost_at TEXT,
  lost_reason TEXT CHECK (lost_reason IS NULL OR lost_reason IN
    ('went_elsewhere','price','fixed_themselves','no_response','not_a_job')),
  closed_at TEXT,
  CHECK ((stage IN ('done','lost')) = (next_due_at IS NULL))   -- the invariant: open <=> has a next date
);
CREATE INDEX jobs_stage ON jobs(stage);
CREATE INDEX jobs_customer ON jobs(customer_id);
CREATE INDEX jobs_due ON jobs(next_due_at);

CREATE TABLE messages (                -- raw inbound log; written BEFORE any parsing
  id INTEGER PRIMARY KEY,
  received_at TEXT NOT NULL,
  channel TEXT NOT NULL CHECK (channel IN ('call','sms','email','form','manual','bulk')),
  provider TEXT NOT NULL,             -- 'twilio' | 'postmark' | 'mailgun' | 'form' | 'generic' | 'raw' | 'app'
  external_id TEXT,                   -- MessageSid / CallSid / Message-ID / submission id / content hash
  call_status TEXT,                   -- 'missed' | 'voicemail' | 'answered' | NULL
  call_duration_s INTEGER,
  from_phone TEXT, from_email TEXT, from_name TEXT, subject TEXT,
  body TEXT NOT NULL DEFAULT '',
  forwarded INTEGER NOT NULL DEFAULT 0,
  raw_json TEXT NOT NULL,             -- original payload, verbatim
  status TEXT NOT NULL CHECK (status IN ('received','created_job','attached','ignored','blocked','error')),
  job_id INTEGER REFERENCES jobs(id),
  customer_id INTEGER REFERENCES customers(id),
  parse_json TEXT,                    -- {rules:{...}, ai:{...}|null, merged:{...}}
  error TEXT
);
CREATE UNIQUE INDEX messages_external ON messages(channel, external_id) WHERE external_id IS NOT NULL;
CREATE INDEX messages_job ON messages(job_id);

CREATE TABLE events (                  -- job timeline + undo
  id INTEGER PRIMARY KEY,
  job_id INTEGER NOT NULL REFERENCES jobs(id),
  at TEXT NOT NULL,
  kind TEXT NOT NULL,                 -- created|inbound|outcome|stage|edit|seen|undo|call_tap|text_tap|tech_text|ai_refined|notified
  actor TEXT NOT NULL CHECK (actor IN ('denise','customer','system')),
  summary TEXT NOT NULL,              -- one human line for the timeline
  data_json TEXT,                     -- {outcome, from, to, args, fields...}
  prev_json TEXT,                     -- full job row before (outcome/stage/edit/seen only)
  message_id INTEGER REFERENCES messages(id),
  undone INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX events_job ON events(job_id, id);

CREATE TABLE outbox (                  -- every text the system sends or would have sent
  id INTEGER PRIMARY KEY,
  created_at TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('digest','friday_sweep','nag','auto_ack','husband_summary','manual')),
  to_phone TEXT NOT NULL, to_name TEXT,
  body TEXT NOT NULL,
  job_id INTEGER REFERENCES jobs(id),
  dedupe_key TEXT UNIQUE,             -- digest:2026-10-05 | sweep:2026-10-02 | nag:16 | ack:+1312...:2026-10-05T1
  status TEXT NOT NULL CHECK (status IN ('simulated','sent','failed')),
  provider_id TEXT, error TEXT
);
`;

/** MIGRATIONS[i] upgrades a database from user_version i to i + 1. */
const MIGRATIONS = [SCHEMA_V1];

export const SCHEMA_VERSION = MIGRATIONS.length;

/** Tables in an order where every table comes before the tables it references. */
const WIPE_ORDER = ["events", "outbox", "messages", "jobs", "customers", "settings"];

/** Open (or create) the database, apply pragmas and run pending migrations. ':memory:' works. */
export function openDb(path = process.env.DB_PATH || "data/callback.db") {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;");
  migrate(db);
  return db;
}

/** Bring the schema up to SCHEMA_VERSION. Each step runs in its own transaction. */
function migrate(db) {
  let version = get(db, "PRAGMA user_version").user_version;
  while (version < MIGRATIONS.length) {
    const target = version + 1;
    tx(db, () => {
      db.exec(MIGRATIONS[version]);
      db.exec(`PRAGMA user_version=${target}`);
    });
    version = target;
  }
  return version;
}

/** node:sqlite rejects undefined and booleans; bind null and 0/1 instead. */
function bindValue(value) {
  if (value === undefined) return null;
  if (typeof value === "boolean") return value ? 1 : 0;
  return value;
}

/** Turn the params argument (array, named-params object, single value or nothing) into bind args. */
function bindArgs(params) {
  if (params == null) return [];
  if (Array.isArray(params)) return params.map(bindValue);
  if (typeof params === "object") {
    const named = {};
    for (const [key, value] of Object.entries(params)) named[key] = bindValue(value);
    return [named];
  }
  return [bindValue(params)];
}

/** First row as a plain object, or null. */
export function get(db, sql, params) {
  const row = db.prepare(sql).get(...bindArgs(params));
  return row ? { ...row } : null;
}

/** All rows as plain objects. */
export function all(db, sql, params) {
  return db.prepare(sql).all(...bindArgs(params)).map((row) => ({ ...row }));
}

/** Run a write. Returns { changes, lastInsertRowid } as Numbers. */
export function run(db, sql, params) {
  const result = db.prepare(sql).run(...bindArgs(params));
  return { changes: Number(result.changes), lastInsertRowid: Number(result.lastInsertRowid) };
}

/**
 * Run fn() inside BEGIN/COMMIT, rolling back and rethrowing on error.
 * Nested calls just run fn() inside the outer transaction. fn must be synchronous.
 */
export function tx(db, fn) {
  if (db.isTransaction) return fn();
  db.exec("BEGIN");
  let result;
  try {
    result = fn();
    if (result && typeof result.then === "function") {
      throw new TypeError("tx(db, fn): fn must be synchronous");
    }
  } catch (err) {
    if (db.isTransaction) db.exec("ROLLBACK");
    throw err;
  }
  db.exec("COMMIT");
  return result;
}

/** Delete every row (children before parents) and keep the schema. */
export function wipe(db) {
  tx(db, () => {
    for (const table of WIPE_ORDER) db.exec(`DELETE FROM ${table}`);
  });
}
