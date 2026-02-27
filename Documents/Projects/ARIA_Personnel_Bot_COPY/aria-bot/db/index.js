/**
 * db/index.js — SQLite database connection and helpers
 * Uses better-sqlite3 for synchronous, fast SQLite operations.
 * Phase 2: swap better-sqlite3 for @journeyapps/sqlcipher for encryption.
 */

const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const { app } = require('electron');

let db = null;

/**
 * Initialize the database. Call once on app ready.
 * Stores DB at: %APPDATA%/aria-bot/aria.db
 */
function initDatabase() {
  // Determine user data path — electron's app.getPath('userData')
  // In dev mode, app might not be ready yet, fallback to a local path
  let dbDir;
  try {
    dbDir = app.getPath('userData');
  } catch (e) {
    // Fallback for when app isn't ready or running outside Electron
    dbDir = path.join(process.env.APPDATA || path.join(require('os').homedir(), '.aria-bot'), 'aria-bot');
  }

  if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true });
  }

  const dbPath = path.join(dbDir, 'aria.db');
  console.log('[DB] Opening database at:', dbPath);

  db = new Database(dbPath);

  // Enable WAL mode for better concurrent read performance
  db.pragma('journal_mode = WAL');

  // Run schema
  const schemaPath = path.join(__dirname, 'schema.sql');
  const schema = fs.readFileSync(schemaPath, 'utf-8');
  db.exec(schema);

  // Migrations — add columns to existing tables if they don't exist yet
  const migrations = [
    `ALTER TABLE email_cache ADD COLUMN reminder_opportunity TEXT`,
    `ALTER TABLE email_cache ADD COLUMN smart_action TEXT`,
    `ALTER TABLE reminders ADD COLUMN archived_at INTEGER DEFAULT NULL`,
    `ALTER TABLE reminders ADD COLUMN completed_at INTEGER DEFAULT NULL`,
    `ALTER TABLE reminders ADD COLUMN smart_action TEXT`,
    `ALTER TABLE reminders ADD COLUMN subtitle TEXT`,
    `ALTER TABLE reminders ADD COLUMN source TEXT DEFAULT 'manual'`,
    `ALTER TABLE notes ADD COLUMN title TEXT DEFAULT 'Untitled'`,
    `ALTER TABLE notes ADD COLUMN updated_at INTEGER DEFAULT NULL`,
    // Subscriptions table is created via schema.sql above; migration guard for older installs:
    `CREATE TABLE IF NOT EXISTS subscriptions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      amount TEXT,
      currency TEXT DEFAULT 'INR',
      period TEXT DEFAULT 'monthly',
      next_renewal INTEGER,
      notes TEXT,
      source_email_id TEXT,
      auto_detected INTEGER DEFAULT 1,
      created_at INTEGER DEFAULT (strftime('%s','now')),
      updated_at INTEGER DEFAULT (strftime('%s','now'))
    )`,
    `ALTER TABLE subscriptions ADD COLUMN source_email_id TEXT`,
    `ALTER TABLE subscriptions ADD COLUMN auto_detected INTEGER DEFAULT 1`,
    `ALTER TABLE reminders ADD COLUMN priority_score REAL DEFAULT 0`,
    `ALTER TABLE reminders ADD COLUMN linked_calendar_event_id TEXT`,
    // Store the short Gmail API message ID alongside the RFC Message-ID header
    // so fetchEmails can efficiently detect which messages are already cached
    `ALTER TABLE email_cache ADD COLUMN gmail_id TEXT`,

    // Transactions table — financial events extracted from emails
    `CREATE TABLE IF NOT EXISTS transactions (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      merchant        TEXT,
      category        TEXT NOT NULL DEFAULT 'other',
      amount          REAL NOT NULL DEFAULT 0,
      currency        TEXT DEFAULT 'INR',
      description     TEXT,
      timestamp       INTEGER NOT NULL,
      source_email_id TEXT,
      created_at      INTEGER DEFAULT (strftime('%s','now'))
    )`,
    `CREATE INDEX IF NOT EXISTS idx_tx_timestamp ON transactions(timestamp)`,
    `CREATE INDEX IF NOT EXISTS idx_tx_category  ON transactions(category)`,
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_tx_source ON transactions(source_email_id) WHERE source_email_id IS NOT NULL`,

    // Behavior metrics — pre-computed weekly snapshots per category
    `CREATE TABLE IF NOT EXISTS behavior_metrics (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      category          TEXT NOT NULL,
      period_start      INTEGER NOT NULL,
      weekly_spend      REAL    DEFAULT 0,
      rolling_4week_avg REAL    DEFAULT 0,
      deviation_percent REAL    DEFAULT 0,
      order_count       INTEGER DEFAULT 0,
      most_common_hour  INTEGER,
      pattern_note      TEXT,
      computed_at       INTEGER DEFAULT (strftime('%s','now')),
      UNIQUE(category, period_start)
    )`,

    // ── CA/CRED Money upgrade ──
    `ALTER TABLE transactions ADD COLUMN tx_type TEXT DEFAULT 'debit'`,
    `ALTER TABLE transactions ADD COLUMN payment_link TEXT`,
    // payment_method: card/UPI/cash used for the transaction — enables 'which card for fuel'
    `ALTER TABLE transactions ADD COLUMN payment_method TEXT`,
    `CREATE INDEX IF NOT EXISTS idx_tx_payment_method ON transactions(payment_method)`,
    `ALTER TABLE subscriptions ADD COLUMN payment_link TEXT`,
    `ALTER TABLE subscriptions ADD COLUMN sub_type TEXT DEFAULT 'subscription'`,

    // ── Mega Feature Consolidation (Superhuman+SaneBox+Boomerang+Todoist+YNAB+Notion AI) ──

    // Email power: snooze, follow-up reminder, auto-archive noise
    `ALTER TABLE email_cache ADD COLUMN snoozed_until INTEGER`,
    `ALTER TABLE email_cache ADD COLUMN auto_archived INTEGER DEFAULT 0`,
    `ALTER TABLE email_cache ADD COLUMN follow_up_at INTEGER`,

    // is_read flag for email_cache (missed in original schema)
    `ALTER TABLE email_cache ADD COLUMN is_read INTEGER DEFAULT 0`,

    // Sub-tasks: parent_id links child → parent reminder
    `ALTER TABLE reminders ADD COLUMN parent_id INTEGER`,

    // Blocked senders list
    `CREATE TABLE IF NOT EXISTS blocked_senders (
      email TEXT PRIMARY KEY,
      blocked_at INTEGER DEFAULT (strftime('%s','now'))
    )`,

    // Reply templates (@@meeting, @@thanks, etc.)
    `CREATE TABLE IF NOT EXISTS reply_templates (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      shortcut TEXT UNIQUE,
      title TEXT NOT NULL,
      body TEXT NOT NULL,
      created_at INTEGER DEFAULT (strftime('%s','now'))
    )`,

    // Note templates (Meeting Notes, Project Brief, etc.)
    `CREATE TABLE IF NOT EXISTS note_templates (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at INTEGER DEFAULT (strftime('%s','now'))
    )`,

    // ── UNIQUE index on note_templates.name — fixes duplicate seeding bug.
    //    First deduplicate existing rows (idempotent), then create the index.
    //    Without this, INSERT OR IGNORE has nothing to conflict against and
    //    inserts 4 new rows EVERY startup.
    `DELETE FROM note_templates WHERE id NOT IN (SELECT MIN(id) FROM note_templates GROUP BY name)`,
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_note_template_name ON note_templates(name)`,

    // ── Phase 2: Full SaaS Consolidation ──

    // AI Memory — persistent user facts across chats (ChatGPT-style)
    `CREATE TABLE IF NOT EXISTS ai_memory (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      fact TEXT NOT NULL,
      source TEXT DEFAULT 'chat',
      created_at INTEGER DEFAULT (strftime('%s','now'))
    )`,

    // Budget limits per category (PocketGuard/YNAB-style)
    `CREATE TABLE IF NOT EXISTS budget_limits (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      category TEXT UNIQUE NOT NULL,
      monthly_limit REAL NOT NULL,
      created_at INTEGER DEFAULT (strftime('%s','now'))
    )`,

    // Unsubscribe link extracted from emails
    `ALTER TABLE email_cache ADD COLUMN unsubscribe_link TEXT`,

    // Daily notes auto-creation tracker
    `ALTER TABLE notes ADD COLUMN is_daily INTEGER DEFAULT 0`,
    `ALTER TABLE notes ADD COLUMN daily_date TEXT`,

    // ── Phase 3: Revenue Stream Consolidation ──

    // Contacts CRM (Dex-style relationship management)
    `CREATE TABLE IF NOT EXISTS contacts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT,
      email TEXT UNIQUE,
      phone TEXT,
      company TEXT,
      notes TEXT,
      birthday TEXT,
      last_contacted_at INTEGER,
      contact_count INTEGER DEFAULT 0,
      tags TEXT DEFAULT '[]',
      created_at INTEGER DEFAULT (strftime('%s','now'))
    )`,

    // Time tracking logs (Toggl/RescueTime-style)
    `CREATE TABLE IF NOT EXISTS time_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      reminder_id INTEGER,
      description TEXT,
      minutes INTEGER NOT NULL,
      billable INTEGER DEFAULT 0,
      hourly_rate REAL,
      logged_at INTEGER DEFAULT (strftime('%s','now')),
      created_at INTEGER DEFAULT (strftime('%s','now'))
    )`,

    // Reading list (Pocket-style save-for-later)
    `CREATE TABLE IF NOT EXISTS reading_list (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      url TEXT NOT NULL,
      title TEXT,
      source TEXT,
      is_read INTEGER DEFAULT 0,
      saved_at INTEGER DEFAULT (strftime('%s','now'))
    )`,

    // Health tracking logs (MyFitnessPal-style)
    `CREATE TABLE IF NOT EXISTS health_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      date TEXT NOT NULL UNIQUE,
      water_glasses INTEGER DEFAULT 0,
      sleep_hours REAL,
      workout_minutes INTEGER DEFAULT 0,
      workout_type TEXT,
      weight REAL,
      mood TEXT,
      notes TEXT,
      created_at INTEGER DEFAULT (strftime('%s','now'))
    )`,

    // Trips extracted from emails (TripIt-style)
    `CREATE TABLE IF NOT EXISTS trips (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      destination TEXT,
      start_date TEXT,
      end_date TEXT,
      booking_ref TEXT,
      source_email_id TEXT,
      type TEXT DEFAULT 'flight',
      details TEXT DEFAULT '{}',
      created_at INTEGER DEFAULT (strftime('%s','now'))
    )`,

    // Task time tracking columns
    `ALTER TABLE reminders ADD COLUMN time_spent INTEGER DEFAULT 0`,
    `ALTER TABLE reminders ADD COLUMN billable INTEGER DEFAULT 0`,
    `ALTER TABLE reminders ADD COLUMN hourly_rate REAL`,

    // WhatsApp settings columns not needed (uses settings k/v store)

    // ── Phase 8: Intelligence Features ──

    // Learning Loop — action feedback tracking (P8-1)
    `CREATE TABLE IF NOT EXISTS action_feedback (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      action_type     TEXT NOT NULL,
      confirmed       INTEGER NOT NULL DEFAULT 0,
      context         TEXT,
      created_at      INTEGER DEFAULT (strftime('%s','now'))
    )`,
    `CREATE INDEX IF NOT EXISTS idx_feedback_type ON action_feedback(action_type)`,
    `CREATE INDEX IF NOT EXISTS idx_feedback_time ON action_feedback(created_at)`,

    // Session Memory — cross-session preferences with TTL (P8-2)
    `CREATE TABLE IF NOT EXISTS session_preferences (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      key             TEXT NOT NULL,
      value           TEXT NOT NULL,
      source_message  TEXT,
      ttl_days        INTEGER DEFAULT 30,
      created_at      INTEGER DEFAULT (strftime('%s','now')),
      expires_at      INTEGER
    )`,
    `CREATE INDEX IF NOT EXISTS idx_pref_key ON session_preferences(key)`,
    `CREATE INDEX IF NOT EXISTS idx_pref_expires ON session_preferences(expires_at)`,

    // ══════════════════════════════════════════════════════════════════
    // Phase 10 — Intelligence Layers (P10-1 through P10-5)
    // ══════════════════════════════════════════════════════════════════

    // P10-1: Learning Layer — signal-level behavioral learning
    `CREATE TABLE IF NOT EXISTS signal_interactions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      signal_id TEXT NOT NULL,
      domain TEXT NOT NULL,
      action TEXT NOT NULL,
      score_at_time REAL DEFAULT 0,
      created_at INTEGER DEFAULT (strftime('%s','now'))
    )`,
    `CREATE INDEX IF NOT EXISTS idx_signal_domain ON signal_interactions(domain)`,
    `CREATE INDEX IF NOT EXISTS idx_signal_time ON signal_interactions(created_at)`,
    `CREATE TABLE IF NOT EXISTS signal_adjustments (
      domain TEXT PRIMARY KEY,
      multiplier REAL DEFAULT 1.0,
      sample_size INTEGER DEFAULT 0,
      updated_at INTEGER DEFAULT (strftime('%s','now'))
    )`,
    `CREATE TABLE IF NOT EXISTS sender_profiles (
      email TEXT PRIMARY KEY,
      name TEXT,
      relationship_type TEXT DEFAULT 'unknown',
      response_rate REAL DEFAULT 0,
      avg_response_hours REAL DEFAULT 0,
      importance_score REAL DEFAULT 50,
      total_received INTEGER DEFAULT 0,
      total_replied INTEGER DEFAULT 0,
      last_analyzed_at INTEGER,
      created_at INTEGER DEFAULT (strftime('%s','now'))
    )`,

    // P10-2: Predictive Engine
    `CREATE TABLE IF NOT EXISTS task_completions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_title TEXT,
      category TEXT,
      estimated_minutes INTEGER,
      actual_minutes INTEGER,
      was_late INTEGER DEFAULT 0,
      created_at INTEGER DEFAULT (strftime('%s','now'))
    )`,
    `CREATE INDEX IF NOT EXISTS idx_task_comp_cat ON task_completions(category)`,
    `CREATE TABLE IF NOT EXISTS prediction_signals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      signal_type TEXT NOT NULL,
      target_id TEXT,
      title TEXT NOT NULL,
      description TEXT,
      risk_level TEXT DEFAULT 'medium',
      estimated_hours REAL,
      hours_remaining REAL,
      resolved INTEGER DEFAULT 0,
      created_at INTEGER DEFAULT (strftime('%s','now'))
    )`,
    `CREATE INDEX IF NOT EXISTS idx_pred_resolved ON prediction_signals(resolved)`,

    // P10-3: Relationship Intelligence
    `CREATE TABLE IF NOT EXISTS email_interactions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sender_email TEXT NOT NULL,
      direction TEXT NOT NULL,
      message_id TEXT,
      replied INTEGER DEFAULT 0,
      response_minutes INTEGER,
      created_at INTEGER DEFAULT (strftime('%s','now'))
    )`,
    `CREATE INDEX IF NOT EXISTS idx_ei_sender ON email_interactions(sender_email)`,
    `CREATE INDEX IF NOT EXISTS idx_ei_time ON email_interactions(created_at)`,

    // P10-4: Context Memory
    `CREATE TABLE IF NOT EXISTS context_threads (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      topic TEXT NOT NULL,
      entities TEXT DEFAULT '[]',
      status TEXT DEFAULT 'active',
      last_activity_at INTEGER,
      created_at INTEGER DEFAULT (strftime('%s','now'))
    )`,
    `CREATE INDEX IF NOT EXISTS idx_ctx_status ON context_threads(status)`,
    `CREATE TABLE IF NOT EXISTS context_links (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      thread_id INTEGER,
      item_type TEXT NOT NULL,
      item_id TEXT NOT NULL,
      relevance REAL DEFAULT 0.5,
      created_at INTEGER DEFAULT (strftime('%s','now')),
      UNIQUE(thread_id, item_type, item_id)
    )`,
    `CREATE INDEX IF NOT EXISTS idx_cl_thread ON context_links(thread_id)`,
    `CREATE TABLE IF NOT EXISTS context_entities (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      entity_type TEXT NOT NULL,
      entity_value TEXT NOT NULL,
      thread_id INTEGER,
      source TEXT,
      created_at INTEGER DEFAULT (strftime('%s','now'))
    )`,
    `CREATE INDEX IF NOT EXISTS idx_ce_value ON context_entities(entity_value)`,

    // P10-5: Outcome Tracking
    `CREATE TABLE IF NOT EXISTS time_saved_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      activity TEXT NOT NULL,
      minutes_saved REAL NOT NULL,
      details TEXT,
      created_at INTEGER DEFAULT (strftime('%s','now'))
    )`,
    `CREATE INDEX IF NOT EXISTS idx_ts_time ON time_saved_log(created_at)`,
    `CREATE TABLE IF NOT EXISTS prevented_issues (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      issue_type TEXT NOT NULL,
      description TEXT NOT NULL,
      estimated_cost REAL DEFAULT 0,
      related_item_id TEXT,
      created_at INTEGER DEFAULT (strftime('%s','now'))
    )`,
    `CREATE TABLE IF NOT EXISTS outcome_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      week_start TEXT NOT NULL UNIQUE,
      total_minutes_saved REAL DEFAULT 0,
      issues_prevented INTEGER DEFAULT 0,
      estimated_savings REAL DEFAULT 0,
      roi_multiple REAL DEFAULT 0,
      details TEXT,
      created_at INTEGER DEFAULT (strftime('%s','now'))
    )`,

    // ── Persistent Q+A cache — cross-session SQL/agent answer store ──────────
    // query_norm  = normalized query (lowercase, stripped punctuation) — unique key
    // ttl_secs    = answer validity window (3600 for sql/agent, 604800 for recall facts)
    // hit_count   = how many times this answer was served without an LLM call
    `CREATE TABLE IF NOT EXISTS query_answers (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      query_norm  TEXT    NOT NULL UNIQUE,
      query_text  TEXT    NOT NULL,
      answer_text TEXT    NOT NULL,
      source      TEXT    DEFAULT 'sql',
      ttl_secs    INTEGER DEFAULT 3600,
      hit_count   INTEGER DEFAULT 1,
      created_at  INTEGER DEFAULT (strftime('%s','now')),
      last_hit_at INTEGER DEFAULT (strftime('%s','now'))
    )`,
    `CREATE INDEX IF NOT EXISTS idx_qa_norm ON query_answers(query_norm)`,
    `CREATE INDEX IF NOT EXISTS idx_qa_source ON query_answers(source)`,

    // ── Automation rules — trigger-action engine (local Zapier replacement) ────────
    // trigger_type: spend_over | category_spike | email_from | subscription_renewing
    //               reminder_overdue | habit_streak_broken
    // action_type:  notify | create_reminder | flag_email
    `CREATE TABLE IF NOT EXISTS automation_rules (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      name          TEXT NOT NULL,
      trigger_type  TEXT NOT NULL,
      trigger_params TEXT DEFAULT '{}',
      action_type   TEXT NOT NULL,
      action_params  TEXT DEFAULT '{}',
      cooldown_mins INTEGER DEFAULT 60,
      enabled       INTEGER DEFAULT 1,
      last_fired_at INTEGER,
      fire_count    INTEGER DEFAULT 0,
      created_at    INTEGER DEFAULT (strftime('%s','now'))
    )`,
    `CREATE INDEX IF NOT EXISTS idx_ar_enabled ON automation_rules(enabled)`,
    `CREATE INDEX IF NOT EXISTS idx_ar_trigger ON automation_rules(trigger_type)`,

    // ── Route signals — query routing history. Powers learn-over-time routing. ───
    // Every chat query is logged with which tier handled it + latency.
    // getRouteStats() surfaces agent queries that could be promoted to SQL.
    `CREATE TABLE IF NOT EXISTS route_signals (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      query_norm TEXT NOT NULL,
      tier       TEXT NOT NULL,
      latency_ms INTEGER DEFAULT 0,
      had_answer INTEGER DEFAULT 1,
      created_at INTEGER DEFAULT (strftime('%s','now'))
    )`,
    `CREATE INDEX IF NOT EXISTS idx_rs_query ON route_signals(query_norm)`,
    `CREATE INDEX IF NOT EXISTS idx_rs_tier  ON route_signals(tier)`,
    `CREATE INDEX IF NOT EXISTS idx_rs_time  ON route_signals(created_at)`,

    // ── Goal Layer — tracks user spending goals across periods ──
    `CREATE TABLE IF NOT EXISTS goals (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      title           TEXT NOT NULL,
      goal_type       TEXT NOT NULL,
      category        TEXT,
      merchant        TEXT,
      target_amount   REAL,
      target_pct      REAL,
      baseline_amount REAL,
      period          TEXT DEFAULT 'month',
      deadline        INTEGER,
      status          TEXT DEFAULT 'active',
      last_checked    INTEGER,
      last_alert      INTEGER,
      created_at      INTEGER DEFAULT (strftime('%s','now'))
    )`,
    `CREATE INDEX IF NOT EXISTS idx_goals_status   ON goals(status)`,
    `CREATE INDEX IF NOT EXISTS idx_goals_category ON goals(category)`,
    `CREATE INDEX IF NOT EXISTS idx_goals_merchant ON goals(merchant)`,
    `CREATE TABLE IF NOT EXISTS goal_progress (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      goal_id         INTEGER REFERENCES goals(id) ON DELETE CASCADE,
      checked_at      INTEGER NOT NULL,
      current_amount  REAL DEFAULT 0,
      target_amount   REAL,
      pct_used        REAL,
      pct_elapsed     REAL,
      status          TEXT DEFAULT 'on_track',
      note            TEXT
    )`,
    `CREATE INDEX IF NOT EXISTS idx_goal_progress ON goal_progress(goal_id, checked_at)`,
  ];
  for (const migration of migrations) {
    try { db.exec(migration); } catch (e) { /* column already exists — ignore */ }
  }

  // ── Seed-once: templates, defaults — guarded by settings flag ────────────
  // Runs ONCE ever, not on every startup. The flag prevents re-seeding.
  const alreadySeeded = db.prepare('SELECT value FROM settings WHERE key=?').get('db_seeded_v2');
  if (!alreadySeeded) {
    const seedStmts = [
      // Reply templates — shortcut has UNIQUE so INSERT OR IGNORE works
      `INSERT OR IGNORE INTO reply_templates (shortcut, title, body) VALUES
        ('@@thanks', 'Thank You', 'Thank you for your email. I appreciate you reaching out and will get back to you shortly.'),
        ('@@meeting', 'Schedule Meeting', 'I would be happy to discuss this further. Could you share your availability for a quick call this week?'),
        ('@@ack', 'Acknowledged', 'Got it, thanks for the update. I will review and follow up if needed.'),
        ('@@delay', 'Need More Time', 'Thanks for following up. I need a bit more time to look into this — I will get back to you by end of week.')`,

      // Note templates — name now has UNIQUE index so INSERT OR IGNORE works
      `INSERT OR IGNORE INTO note_templates (name, content) VALUES
        ('Meeting Notes', '# Meeting Notes\n\nDate: \nAttendees: \n\n## Agenda\n- \n\n## Discussion\n- \n\n## Action Items\n- [ ] \n\n## Next Steps\n- '),
        ('Project Brief', '# Project Brief\n\n## Objective\n\n## Scope\n\n## Timeline\n\n## Key Stakeholders\n\n## Success Metrics\n\n## Risks & Mitigations\n'),
        ('Daily Standup', '# Standup — \n\n## Yesterday\n- \n\n## Today\n- \n\n## Blockers\n- None'),
        ('Decision Log', '# Decision\n\nDate: \nDecision: \n\n## Context\n\n## Options Considered\n1. \n2. \n\n## Rationale\n\n## Impact\n')`,

      // Mark seeded
      `INSERT OR REPLACE INTO settings (key, value) VALUES ('db_seeded_v2', '1')`,
    ];
    for (const s of seedStmts) {
      try { db.exec(s); } catch (_) {}
    }
    console.log('[DB] Templates seeded (first run)');
  }

  // ── Startup cleanup: remove junk data that accumulates over time ──────────
  // Runs on every startup but is fast (indexed deletes).
  const cleanupStmts = [
    // Context threads extracted from question words like "What", "How", "Any"
    `DELETE FROM context_threads WHERE length(trim(topic)) <= 4
       OR LOWER(trim(topic)) IN ('what','how','why','who','when','where','any','hi','hey','the','and','is')`,
    // Garbage entities — stopwords/question words tagged as people
    `DELETE FROM context_entities WHERE length(trim(entity_value)) <= 2
       OR LOWER(trim(entity_value)) IN ('what','how','why','who','when','where','any','hi','hey','the','and','is','are','was','were')`,
    // Orphaned context links (thread was deleted)
    `DELETE FROM context_links WHERE thread_id NOT IN (SELECT id FROM context_threads)`,
    // Expired session preferences
    `DELETE FROM session_preferences WHERE expires_at IS NOT NULL AND expires_at < CAST(strftime('%s','now') AS INTEGER)`,
    // Duplicate chat messages (same role + text stored twice — bot+assistant bug)
    `DELETE FROM chat_messages WHERE id NOT IN (SELECT MIN(id) FROM chat_messages GROUP BY role, text)`,
    // Chat messages that contain leaked system prompts
    `DELETE FROM chat_messages WHERE (role='bot' OR role='assistant')
       AND (text LIKE 'Classification Line:%' OR text LIKE 'You are ARIA%' OR text LIKE 'Answer:%You are%')`,
    // Reminders created with junk titles: greeting words, single chars, pure numbers
    // These come from the "hi" bug or bad email subject extraction
    `DELETE FROM reminders WHERE length(trim(title)) <= 3
       OR LOWER(trim(title)) IN ('hi','hey','hello','yo','sup','hiya','ok','yes','no','re')`,
  ];
  for (const s of cleanupStmts) {
    try { db.exec(s); } catch (_) {}
  }

  console.log('[DB] Database initialized successfully');
  return db;
}

/**
 * Get the database instance. Throws if not initialized.
 */
function getDb() {
  if (!db) {
    throw new Error('Database not initialized. Call initDatabase() first.');
  }
  return db;
}

/**
 * Run an INSERT/UPDATE/DELETE statement.
 * @param {string} sql - SQL statement with ? placeholders
 * @param {Array} params - Parameter values
 * @returns {object} - { changes, lastInsertRowid }
 */
function run(sql, params = []) {
  const stmt = getDb().prepare(sql);
  return stmt.run(...params);
}

/**
 * Get a single row.
 * @param {string} sql - SQL query with ? placeholders
 * @param {Array} params - Parameter values
 * @returns {object|undefined} - Row object or undefined
 */
function get(sql, params = []) {
  const stmt = getDb().prepare(sql);
  return stmt.get(...params);
}

/**
 * Get all matching rows.
 * @param {string} sql - SQL query with ? placeholders
 * @param {Array} params - Parameter values
 * @returns {Array} - Array of row objects
 */
function all(sql, params = []) {
  const stmt = getDb().prepare(sql);
  return stmt.all(...params);
}

/**
 * Close the database connection gracefully.
 */
function close() {
  if (db) {
    db.close();
    db = null;
    console.log('[DB] Database closed');
  }
}

// ── Settings helpers ──

function getSetting(key) {
  const row = get('SELECT value FROM settings WHERE key = ?', [key]);
  return row ? row.value : null;
}

function saveSetting(key, value) {
  run(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    [key, value]
  );
}

// ── AI usage helpers ──

function logAiUsage(provider, task, tokensIn = 0, tokensOut = 0) {
  const today = new Date().toISOString().split('T')[0];
  run(
    'INSERT INTO ai_usage (date, provider, task, tokens_in, tokens_out) VALUES (?, ?, ?, ?, ?)',
    [today, provider, task, tokensIn, tokensOut]
  );
}

function getHaikuUsageToday() {
  const today = new Date().toISOString().split('T')[0];
  const row = get(
    'SELECT COUNT(*) as count FROM ai_usage WHERE date = ? AND provider = ?',
    [today, 'haiku']
  );
  return row ? row.count : 0;
}

module.exports = {
  initDatabase,
  getDb,
  run,
  get,
  all,
  close,
  getSetting,
  saveSetting,
  logAiUsage,
  getHaikuUsageToday
};
