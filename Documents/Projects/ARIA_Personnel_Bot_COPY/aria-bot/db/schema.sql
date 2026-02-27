-- ARIA Bot Database Schema
-- All tables for Phase 1 + placeholders for Phase 2

-- Reminders and tasks
CREATE TABLE IF NOT EXISTS reminders (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  title        TEXT NOT NULL,
  due_at       INTEGER NOT NULL,
  recurring    TEXT,              -- 'daily'|'weekly'|'monthly'|'weekdays'|null
  completed    INTEGER DEFAULT 0,
  snoozed_to   INTEGER,
  category     TEXT DEFAULT 'task',
  subtitle     TEXT,              -- context line: source, amount, location, etc.
  source       TEXT DEFAULT 'manual', -- 'manual'|'email'|'calendar'|'subscription'
  priority_score REAL DEFAULT 0,  -- computed urgency score (higher = more urgent)
  linked_calendar_event_id TEXT, -- links to calendar_events.id for auto-synced tasks
  archived_at  INTEGER,
  completed_at INTEGER,
  smart_action TEXT,              -- JSON: AI-generated next-step suggestion
  created_at   INTEGER DEFAULT (strftime('%s','now'))
);

-- Email cache
CREATE TABLE IF NOT EXISTS email_cache (
  message_id   TEXT PRIMARY KEY,
  from_name    TEXT,
  from_email   TEXT,
  subject      TEXT,
  body_preview TEXT,              -- first 500 chars of plain text body
  summary      TEXT,              -- AI-generated 2-sentence summary
  category     TEXT,              -- urgent|action|fyi|done|noise
  received_at  INTEGER,
  reminder_opportunity TEXT,      -- JSON: detected subscription/renewal info
  smart_action TEXT,              -- JSON: AI-generated next-step suggestion
  cached_at    INTEGER DEFAULT (strftime('%s','now'))
);

-- Calendar event cache
CREATE TABLE IF NOT EXISTS calendar_events (
  id           TEXT PRIMARY KEY,  -- UID from iCal
  title        TEXT,
  start_at     INTEGER,
  end_at       INTEGER,
  location     TEXT,
  description  TEXT,
  calendar_url TEXT,
  cached_at    INTEGER DEFAULT (strftime('%s','now'))
);

-- Daily AI usage tracking
CREATE TABLE IF NOT EXISTS ai_usage (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  date         TEXT NOT NULL,     -- 'YYYY-MM-DD'
  provider     TEXT NOT NULL,     -- 'haiku'|'ollama'
  task         TEXT,              -- 'summarise'|'categorise'|'briefing'|'chat'
  tokens_in    INTEGER DEFAULT 0,
  tokens_out   INTEGER DEFAULT 0,
  created_at   INTEGER DEFAULT (strftime('%s','now'))
);

-- Settings key-value store
CREATE TABLE IF NOT EXISTS settings (
  key          TEXT PRIMARY KEY,
  value        TEXT
);

-- Notes
CREATE TABLE IF NOT EXISTS notes (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  title        TEXT,
  content      TEXT NOT NULL,
  tags         TEXT,              -- JSON array string
  updated_at   INTEGER,
  created_at   INTEGER DEFAULT (strftime('%s','now'))
);

-- Subscription / recurring payments tracker
CREATE TABLE IF NOT EXISTS subscriptions (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  name            TEXT NOT NULL,             -- e.g. "GitHub Copilot"
  amount          TEXT,                      -- e.g. "₹3,400" or "$10"
  currency        TEXT DEFAULT 'INR',
  period          TEXT DEFAULT 'monthly',    -- 'monthly'|'yearly'|'one-time'
  next_renewal    INTEGER,                   -- unix timestamp of next renewal
  notes           TEXT,
  source_email_id TEXT,                      -- message_id of the email that triggered detection
  auto_detected   INTEGER DEFAULT 1,         -- 1 = from email, 0 = manual
  created_at      INTEGER DEFAULT (strftime('%s','now')),
  updated_at      INTEGER DEFAULT (strftime('%s','now'))
);

-- Chat message history
CREATE TABLE IF NOT EXISTS chat_messages (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  role         TEXT NOT NULL,     -- 'user' | 'bot'
  text         TEXT NOT NULL,
  created_at   INTEGER DEFAULT (strftime('%s','now'))
);

-- Streak tracking (one row per active day)
CREATE TABLE IF NOT EXISTS streaks (
  date         TEXT PRIMARY KEY   -- 'YYYY-MM-DD'
);

-- Habits
CREATE TABLE IF NOT EXISTS habits (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  name         TEXT NOT NULL,
  icon         TEXT DEFAULT '✅',
  created_at   INTEGER DEFAULT (strftime('%s','now'))
);

-- Habit completion log (one row per habit per day)
CREATE TABLE IF NOT EXISTS habit_log (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  habit_id     INTEGER REFERENCES habits(id) ON DELETE CASCADE,
  date         TEXT NOT NULL,     -- 'YYYY-MM-DD'
  done         INTEGER DEFAULT 0,
  UNIQUE(habit_id, date)
);
CREATE INDEX IF NOT EXISTS idx_habit_log_date ON habit_log(date);

-- Focus sessions
CREATE TABLE IF NOT EXISTS focus_sessions (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  date         TEXT NOT NULL,     -- 'YYYY-MM-DD'
  duration     INTEGER NOT NULL,  -- minutes
  created_at   INTEGER DEFAULT (strftime('%s','now'))
);
CREATE INDEX IF NOT EXISTS idx_focus_date ON focus_sessions(date);

-- Spend log — variable spending tracker for behavioral analysis
CREATE TABLE IF NOT EXISTS spend_log (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  category     TEXT    NOT NULL DEFAULT 'other',  -- food|shopping|travel|entertainment|utilities|health|other
  amount_raw   REAL    NOT NULL DEFAULT 0,         -- numeric amount in base currency (no symbols)
  description  TEXT,                               -- merchant / item description
  source       TEXT    DEFAULT 'manual',           -- 'email'|'manual'
  source_ref   TEXT,                               -- email message_id or other reference (for dedup)
  occurred_at  INTEGER NOT NULL,                   -- unix timestamp of the transaction
  created_at   INTEGER DEFAULT (strftime('%s','now'))
);
CREATE INDEX IF NOT EXISTS idx_spend_occurred ON spend_log(occurred_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_spend_source_ref ON spend_log(source_ref) WHERE source_ref IS NOT NULL;

-- Transactions — normalized financial events extracted from emails
CREATE TABLE IF NOT EXISTS transactions (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  merchant        TEXT,                              -- extracted merchant name
  category        TEXT NOT NULL DEFAULT 'other',    -- food|shopping|travel|entertainment|health|utilities|subscriptions|investments|insurance|banking|groceries|other
  amount          REAL NOT NULL DEFAULT 0,           -- numeric amount in base currency
  currency        TEXT DEFAULT 'INR',
  description     TEXT,                              -- subject line / short context
  timestamp       INTEGER NOT NULL,                  -- unix epoch of the transaction
  source_email_id TEXT,                              -- email message_id (for dedup / tracing)
  created_at      INTEGER DEFAULT (strftime('%s','now'))
);
CREATE INDEX IF NOT EXISTS idx_tx_timestamp  ON transactions(timestamp);
CREATE INDEX IF NOT EXISTS idx_tx_category   ON transactions(category);
CREATE UNIQUE INDEX IF NOT EXISTS idx_tx_source ON transactions(source_email_id) WHERE source_email_id IS NOT NULL;

-- Behavior metrics — pre-computed weekly snapshots per category
CREATE TABLE IF NOT EXISTS behavior_metrics (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  category          TEXT NOT NULL,
  period_start      INTEGER NOT NULL,                -- unix epoch of week start (Mon 00:00)
  weekly_spend      REAL    DEFAULT 0,
  rolling_4week_avg REAL    DEFAULT 0,
  deviation_percent REAL    DEFAULT 0,
  order_count       INTEGER DEFAULT 0,
  most_common_hour  INTEGER,                         -- 0-23
  pattern_note      TEXT,
  computed_at       INTEGER DEFAULT (strftime('%s','now')),
  UNIQUE(category, period_start)
);

-- Learning Loop — action feedback tracking (P8-1)
CREATE TABLE IF NOT EXISTS action_feedback (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  action_type     TEXT NOT NULL,              -- 'reminder'|'email'|'send-reply'|'snooze-email'|'block-sender' etc.
  confirmed       INTEGER NOT NULL DEFAULT 0, -- 1 = user confirmed, 0 = user cancelled/dismissed
  context         TEXT,                       -- JSON: optional context (e.g. domain, time of day)
  created_at      INTEGER DEFAULT (strftime('%s','now'))
);
CREATE INDEX IF NOT EXISTS idx_feedback_type ON action_feedback(action_type);
CREATE INDEX IF NOT EXISTS idx_feedback_time ON action_feedback(created_at);

-- Session Memory — cross-session user preferences with TTL (P8-2)
CREATE TABLE IF NOT EXISTS session_preferences (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  key             TEXT NOT NULL,              -- short topic key e.g. 'aws-costs', 'meeting-frequency'
  value           TEXT NOT NULL,              -- the user's stated preference / fact
  source_message  TEXT,                       -- original user message that set this pref
  ttl_days        INTEGER DEFAULT 30,         -- preference expires after N days (0 = permanent)
  created_at      INTEGER DEFAULT (strftime('%s','now')),
  expires_at      INTEGER                     -- computed: created_at + (ttl_days * 86400)
);
CREATE INDEX IF NOT EXISTS idx_pref_key ON session_preferences(key);
CREATE INDEX IF NOT EXISTS idx_pref_expires ON session_preferences(expires_at);

-- ═══════════════════════════════════════════════════════════════════════
-- Phase 10 — Intelligence Layers (The ₹499/Month Features)
-- ═══════════════════════════════════════════════════════════════════════

-- P10-1: Learning Layer — Signal-level behavioral learning
CREATE TABLE IF NOT EXISTS signal_interactions (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  signal_id    TEXT NOT NULL,               -- e.g. 'task-5', 'email-abc123', 'sub-2'
  domain       TEXT NOT NULL,               -- 'task'|'email'|'finance'|'calendar'|'prediction'|'relationship'
  action       TEXT NOT NULL,               -- 'acted'|'dismissed'|'ignored'
  score_at_time REAL DEFAULT 0,            -- priority score when interaction happened
  created_at   INTEGER DEFAULT (strftime('%s','now'))
);
CREATE INDEX IF NOT EXISTS idx_signal_domain ON signal_interactions(domain);
CREATE INDEX IF NOT EXISTS idx_signal_time ON signal_interactions(created_at);

CREATE TABLE IF NOT EXISTS signal_adjustments (
  domain       TEXT PRIMARY KEY,            -- 'task'|'email'|'finance'|'calendar'
  multiplier   REAL DEFAULT 1.0,            -- 0.5 to 1.5
  sample_size  INTEGER DEFAULT 0,           -- how many interactions computed from
  updated_at   INTEGER DEFAULT (strftime('%s','now'))
);

CREATE TABLE IF NOT EXISTS sender_profiles (
  email        TEXT PRIMARY KEY,
  name         TEXT,
  relationship_type TEXT DEFAULT 'unknown', -- 'boss'|'client'|'colleague'|'vendor'|'newsletter'|'unknown'
  response_rate  REAL DEFAULT 0,            -- 0.0-1.0 (what % of their emails user responds to)
  avg_response_hours REAL DEFAULT 0,        -- avg hours to respond
  importance_score  REAL DEFAULT 50,        -- 0-100 computed importance
  total_received  INTEGER DEFAULT 0,
  total_replied   INTEGER DEFAULT 0,
  last_analyzed_at INTEGER,
  created_at   INTEGER DEFAULT (strftime('%s','now'))
);

-- P10-2: Predictive Engine — Time estimation and risk prediction
CREATE TABLE IF NOT EXISTS task_completions (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  task_title   TEXT,
  category     TEXT,
  estimated_minutes INTEGER,                -- AI-estimated time
  actual_minutes    INTEGER,                -- actual time spent (from completion timestamps)
  was_late     INTEGER DEFAULT 0,           -- 1 = completed after due_at
  created_at   INTEGER DEFAULT (strftime('%s','now'))
);
CREATE INDEX IF NOT EXISTS idx_task_comp_cat ON task_completions(category);

CREATE TABLE IF NOT EXISTS prediction_signals (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  signal_type  TEXT NOT NULL,               -- 'deadline_risk'|'time_estimate'|'prep_needed'|'bill_prediction'
  target_id    TEXT,                        -- related task/event/sub ID
  title        TEXT NOT NULL,
  description  TEXT,
  risk_level   TEXT DEFAULT 'medium',       -- 'low'|'medium'|'high'|'critical'
  estimated_hours REAL,
  hours_remaining REAL,
  resolved     INTEGER DEFAULT 0,
  created_at   INTEGER DEFAULT (strftime('%s','now'))
);
CREATE INDEX IF NOT EXISTS idx_pred_resolved ON prediction_signals(resolved);

-- P10-3: Relationship Intelligence — tracks email interaction patterns
CREATE TABLE IF NOT EXISTS email_interactions (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  sender_email TEXT NOT NULL,
  direction    TEXT NOT NULL,               -- 'inbound'|'outbound'
  message_id   TEXT,
  replied      INTEGER DEFAULT 0,           -- 1 = user replied to this inbound email
  response_minutes INTEGER,                 -- minutes to respond (null if no reply)
  created_at   INTEGER DEFAULT (strftime('%s','now'))
);
CREATE INDEX IF NOT EXISTS idx_ei_sender ON email_interactions(sender_email);
CREATE INDEX IF NOT EXISTS idx_ei_time ON email_interactions(created_at);

-- P10-4: Context Memory — entity extraction and cross-item linking
CREATE TABLE IF NOT EXISTS context_threads (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  topic        TEXT NOT NULL,               -- e.g. 'Acme proposal', 'Q4 budget review'
  entities     TEXT DEFAULT '[]',           -- JSON array of extracted entities
  status       TEXT DEFAULT 'active',       -- 'active'|'resolved'|'archived'
  last_activity_at INTEGER,
  created_at   INTEGER DEFAULT (strftime('%s','now'))
);
CREATE INDEX IF NOT EXISTS idx_ctx_status ON context_threads(status);

CREATE TABLE IF NOT EXISTS context_links (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  thread_id    INTEGER REFERENCES context_threads(id) ON DELETE CASCADE,
  item_type    TEXT NOT NULL,               -- 'email'|'task'|'note'|'calendar'|'chat'
  item_id      TEXT NOT NULL,               -- message_id, reminder id, note id, etc
  relevance    REAL DEFAULT 0.5,            -- 0-1 relevance score
  created_at   INTEGER DEFAULT (strftime('%s','now')),
  UNIQUE(thread_id, item_type, item_id)
);
CREATE INDEX IF NOT EXISTS idx_cl_thread ON context_links(thread_id);

CREATE TABLE IF NOT EXISTS context_entities (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  entity_type  TEXT NOT NULL,               -- 'person'|'company'|'project'|'topic'
  entity_value TEXT NOT NULL,               -- 'Priya', 'Acme Corp', 'Q4 budget'
  thread_id    INTEGER REFERENCES context_threads(id) ON DELETE CASCADE,
  source       TEXT,                        -- 'email'|'chat'|'note'
  created_at   INTEGER DEFAULT (strftime('%s','now'))
);
CREATE INDEX IF NOT EXISTS idx_ce_value ON context_entities(entity_value);

-- P10-5: Outcome Tracking — ROI and value proof
CREATE TABLE IF NOT EXISTS time_saved_log (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  activity     TEXT NOT NULL,               -- 'email_triage'|'auto_prioritize'|'task_schedule'|'bill_catch'
  minutes_saved REAL NOT NULL,
  details      TEXT,                        -- human-readable description
  created_at   INTEGER DEFAULT (strftime('%s','now'))
);
CREATE INDEX IF NOT EXISTS idx_ts_time ON time_saved_log(created_at);

CREATE TABLE IF NOT EXISTS prevented_issues (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  issue_type      TEXT NOT NULL,            -- 'missed_deadline'|'late_payment'|'forgotten_followup'|'overdue_task'
  description     TEXT NOT NULL,
  estimated_cost  REAL DEFAULT 0,           -- estimated cost if issue had occurred (in INR)
  related_item_id TEXT,                     -- task/email/sub id that was at risk
  created_at      INTEGER DEFAULT (strftime('%s','now'))
);

CREATE TABLE IF NOT EXISTS outcome_snapshots (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  week_start      TEXT NOT NULL,            -- 'YYYY-MM-DD'
  total_minutes_saved REAL DEFAULT 0,
  issues_prevented    INTEGER DEFAULT 0,
  estimated_savings   REAL DEFAULT 0,       -- in INR
  roi_multiple        REAL DEFAULT 0,       -- savings / subscription cost
  details         TEXT,                     -- JSON breakdown
  created_at      INTEGER DEFAULT (strftime('%s','now')),
  UNIQUE(week_start)
);
