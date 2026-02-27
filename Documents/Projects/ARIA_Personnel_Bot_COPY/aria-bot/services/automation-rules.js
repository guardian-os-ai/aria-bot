/**
 * services/automation-rules.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Trigger-action automation engine — the local Zapier replacement.
 * Runs every 5 min inside runBackgroundSync(). Zero LLM calls — pure SQL.
 *
 * Triggers:
 *   spend_over           — category/total spend hits threshold in N days
 *   category_spike       — weekly spend > N% above 4-week rolling average
 *   email_from           — email received from matching sender pattern
 *   subscription_renewing — subscription renews within N days
 *   reminder_overdue     — tasks overdue for > N hours
 *   habit_streak_broken  — habit has no entry today
 *
 * Actions:
 *   notify              — push notification to renderer (system tray + chat)
 *   create_reminder     — insert a task into reminders table
 *   flag_email          — update email category/smart_action
 *
 * Adding more channels (WhatsApp, Telegram, Notion) = add a new case in
 * executeAction(). The trigger evaluation layer never changes.
 *
 * Usage:
 *   automationRulesService.init(dbModule, notifyFn);
 *   await automationRulesService.evaluate();   // called from runBackgroundSync
 */

'use strict';

let _db = null;
let _notify = null; // fn({ type, title, message, severity }) → IPC to renderer

function init(db, notifyFn) {
  _db = db;
  _notify = notifyFn || (() => {});
  console.log('[AutoRules] Automation rule engine initialized');
}

// ─────────────────────────────────────────────────────────────────────────────
// Core: evaluate all enabled rules
// ─────────────────────────────────────────────────────────────────────────────

async function evaluate() {
  if (!_db) return;
  const { all } = _db;
  let rules;
  try {
    rules = all(`SELECT * FROM automation_rules WHERE enabled = 1 ORDER BY created_at ASC`);
  } catch (_) { return; }
  if (!rules || rules.length === 0) return;

  const now = Math.floor(Date.now() / 1000);
  let fired = 0;
  for (const rule of rules) {
    try {
      const didFire = await evaluateRule(rule, now);
      if (didFire) fired++;
    } catch (err) {
      console.warn(`[AutoRules] Rule "${rule.name}" error: ${err.message}`);
    }
  }
  if (fired > 0) console.log(`[AutoRules] ${fired} rule(s) fired`);
}

async function evaluateRule(rule, now) {
  const { run } = _db;
  const triggerParams = _parse(rule.trigger_params);
  const actionParams  = _parse(rule.action_params);

  // Cooldown: don't re-fire within cooldown_mins window
  const cooldownSecs = (rule.cooldown_mins || 60) * 60;
  if (rule.last_fired_at && (now - rule.last_fired_at) < cooldownSecs) return false;

  const { triggered, payload } = checkTrigger(rule.trigger_type, triggerParams, now);
  if (!triggered) return false;

  await executeAction(rule.action_type, actionParams, payload, rule, now);
  run(`UPDATE automation_rules SET last_fired_at = ?, fire_count = fire_count + 1 WHERE id = ?`, [now, rule.id]);
  console.log(`[AutoRules] ✓ "${rule.name}" fired (${rule.trigger_type} → ${rule.action_type})`);
  return true;
}

// ─────────────────────────────────────────────────────────────────────────────
// Trigger evaluation — all pure SQL, no LLM
// ─────────────────────────────────────────────────────────────────────────────

function checkTrigger(type, p, now) {
  const { get, all } = _db;
  let triggered = false;
  let payload = {};

  try {
    switch (type) {

      case 'spend_over': {
        // Fire when total spend (optionally filtered by category) exceeds threshold in last N days
        const days      = p.days || 30;
        const threshold = p.amount || 5000;
        const since     = now - days * 86400;
        const catClause = p.category ? `AND LOWER(category) = '${p.category.toLowerCase()}'` : '';

        const txRow = get(`SELECT SUM(amount) as t FROM transactions WHERE timestamp > ? ${catClause}`, [since]);
        const slRow = get(`SELECT SUM(amount_raw) as t FROM spend_log WHERE occurred_at > ? ${catClause}`, [since]);
        const total = (txRow?.t || 0) + (slRow?.t || 0);

        if (total >= threshold) {
          triggered = true;
          payload = { total, threshold, category: p.category || 'total', days };
        }
        break;
      }

      case 'category_spike': {
        // Fire when weekly spend is > threshold_pct% above 4-week rolling average
        const category     = (p.category || '').toLowerCase();
        const thresholdPct = p.threshold_pct || 50;
        if (!category) break;

        const metric = get(
          `SELECT weekly_spend, rolling_4week_avg, deviation_percent
           FROM behavior_metrics WHERE LOWER(category) = ? ORDER BY computed_at DESC LIMIT 1`,
          [category]
        );
        if (metric && metric.rolling_4week_avg > 0 && metric.deviation_percent >= thresholdPct) {
          triggered = true;
          payload = {
            category, weekly_spend: metric.weekly_spend,
            avg: metric.rolling_4week_avg, deviation_pct: metric.deviation_percent
          };
        }
        break;
      }

      case 'email_from': {
        // Fire when an email arrives from a matching sender (since last fire)
        const pattern   = `%${p.sender || ''}%`;
        const checkFrom = p.sender ? 'sender' : 'any';
        const since     = now - (p.check_hours || 24) * 3600;

        const email = get(
          `SELECT id, subject, from_name, from_email, received_at FROM email_cache
           WHERE (LOWER(from_email) LIKE ? OR LOWER(from_name) LIKE ?) AND received_at > ?
           ORDER BY received_at DESC LIMIT 1`,
          [pattern, pattern, since]
        );
        if (email) {
          triggered = true;
          payload = { email, checkFrom };
        }
        break;
      }

      case 'subscription_renewing': {
        // Fire when any subscription renews within days_ahead days
        const daysAhead = p.days_ahead || 3;
        const soon      = now + daysAhead * 86400;
        const namePattern = p.name ? `AND LOWER(name) LIKE '%${p.name.toLowerCase()}%'` : '';

        const subs = all(
          `SELECT name, amount, next_renewal FROM subscriptions
           WHERE next_renewal BETWEEN ? AND ? ${namePattern} ORDER BY next_renewal ASC`,
          [now, soon]
        );
        if (subs.length > 0) {
          triggered = true;
          payload = { subscriptions: subs, daysAhead };
        }
        break;
      }

      case 'reminder_overdue': {
        // Fire when tasks have been overdue for > hours hours
        const hours    = p.hours || 2;
        const deadline = now - hours * 3600;
        const catFilter = p.category ? `AND LOWER(category) = '${p.category.toLowerCase()}'` : '';

        const tasks = all(
          `SELECT id, title, due_at, category FROM reminders
           WHERE completed = 0 AND archived_at IS NULL AND due_at < ? ${catFilter}
           ORDER BY due_at ASC LIMIT 5`,
          [deadline]
        );
        if (tasks.length > 0) {
          triggered = true;
          payload = { tasks };
        }
        break;
      }

      case 'habit_streak_broken': {
        // Fire when a tracked habit has no entry for today
        const habitName = p.habit_name;
        if (!habitName) break;
        const today = new Date().toISOString().split('T')[0];

        const entry = get(
          `SELECT id FROM habits WHERE LOWER(name) LIKE ? AND date = ?`,
          [`%${habitName.toLowerCase()}%`, today]
        );
        if (!entry) {
          triggered = true;
          payload = { habit: habitName, date: today };
        }
        break;
      }
    }
  } catch (err) {
    console.warn(`[AutoRules] trigger check failed (${type}):`, err.message);
  }

  return { triggered, payload };
}

// ─────────────────────────────────────────────────────────────────────────────
// Action execution
// Adding a new channel (WhatsApp, Notion sync, etc.)? Add a case here.
// ─────────────────────────────────────────────────────────────────────────────

async function executeAction(type, p, payload, rule, now) {
  const { run } = _db;

  switch (type) {

    case 'notify': {
      const message = p.message
        ? _interpolate(p.message, payload)
        : _buildNotification(rule.trigger_type, payload);
      if (message) {
        _notify({ type: 'automation', title: rule.name, message, severity: p.severity || 'info', ruleId: rule.id });
      }
      break;
    }

    case 'create_reminder': {
      const title = p.title_template
        ? _interpolate(p.title_template, payload)
        : _buildReminderTitle(rule.trigger_type, payload);
      if (title) {
        const due = now + (p.due_minutes || 60) * 60;
        try {
          run(
            `INSERT OR IGNORE INTO reminders (title, due_at, source, category, created_at) VALUES (?, ?, 'automation', ?, ?)`,
            [title, due, p.category || 'task', now]
          );
        } catch (_) {}
      }
      break;
    }

    case 'flag_email': {
      if (payload.email?.id) {
        try {
          run(
            `UPDATE email_cache SET category = ?, smart_action = ? WHERE id = ?`,
            [p.flag_as || 'action', p.smart_action || 'Review', payload.email.id]
          );
        } catch (_) {}
      }
      break;
    }

    // ── Future channels: add cases below ──
    // case 'whatsapp_message': ...
    // case 'notion_create_page': ...
    // case 'slack_message': ...
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Message builders
// ─────────────────────────────────────────────────────────────────────────────

function _buildNotification(triggerType, payload) {
  switch (triggerType) {
    case 'spend_over':
      return `💰 ${_cap(payload.category)} spend reached ₹${Math.round(payload.total).toLocaleString('en-IN')} (threshold ₹${payload.threshold.toLocaleString('en-IN')}) in last ${payload.days} days`;
    case 'category_spike':
      return `📊 ${_cap(payload.category)} spend is ${Math.round(payload.deviation_pct)}% above your 4-week average (₹${Math.round(payload.weekly_spend).toLocaleString('en-IN')} this week vs avg ₹${Math.round(payload.avg).toLocaleString('en-IN')})`;
    case 'email_from':
      return `📧 Email from ${payload.email?.from_name || payload.email?.from_email}: "${payload.email?.subject}"`;
    case 'subscription_renewing':
      return `🔔 ${payload.subscriptions.length} subscription${payload.subscriptions.length > 1 ? 's' : ''} renewing within ${payload.daysAhead} days: ${payload.subscriptions.map(s => s.name).join(', ')}`;
    case 'reminder_overdue':
      return `⚠️ ${payload.tasks.length} task${payload.tasks.length > 1 ? 's' : ''} overdue: "${payload.tasks[0]?.title}"${payload.tasks.length > 1 ? ` +${payload.tasks.length - 1} more` : ''}`;
    case 'habit_streak_broken':
      return `🎯 Habit not logged yet today: "${payload.habit}"`;
    default:
      return null;
  }
}

function _buildReminderTitle(triggerType, payload) {
  switch (triggerType) {
    case 'email_from':       return `Follow up: ${payload.email?.subject || 'email'}`;
    case 'spend_over':       return `Review ${payload.category} expenses`;
    case 'subscription_renewing': return `Review ${payload.subscriptions[0]?.name} renewal`;
    default:                 return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// CRUD helpers — used by IPC handlers in main.js
// ─────────────────────────────────────────────────────────────────────────────

function getRules() {
  if (!_db) return [];
  try { return _db.all(`SELECT * FROM automation_rules ORDER BY enabled DESC, created_at ASC`); }
  catch (_) { return []; }
}

function createRule({ name, trigger_type, trigger_params, action_type, action_params, cooldown_mins }) {
  if (!_db) return null;
  const now = Math.floor(Date.now() / 1000);
  try {
    const r = _db.run(
      `INSERT INTO automation_rules (name, trigger_type, trigger_params, action_type, action_params, cooldown_mins, enabled, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 1, ?)`,
      [name, trigger_type, JSON.stringify(trigger_params || {}),
       action_type, JSON.stringify(action_params || {}), cooldown_mins || 60, now]
    );
    return { id: r.lastInsertRowid, name, trigger_type, action_type, enabled: true };
  } catch (err) {
    console.error('[AutoRules] createRule error:', err.message);
    return null;
  }
}

function updateRule(id, { name, trigger_params, action_params, cooldown_mins, enabled }) {
  if (!_db) return false;
  try {
    _db.run(
      `UPDATE automation_rules SET name=COALESCE(?,name), trigger_params=COALESCE(?,trigger_params),
       action_params=COALESCE(?,action_params), cooldown_mins=COALESCE(?,cooldown_mins),
       enabled=COALESCE(?,enabled) WHERE id=?`,
      [name, trigger_params ? JSON.stringify(trigger_params) : null,
       action_params ? JSON.stringify(action_params) : null,
       cooldown_mins, enabled != null ? (enabled ? 1 : 0) : null, id]
    );
    return true;
  } catch (_) { return false; }
}

function toggleRule(id, enabled) {
  if (!_db) return;
  try { _db.run(`UPDATE automation_rules SET enabled = ? WHERE id = ?`, [enabled ? 1 : 0, id]); } catch (_) {}
}

function deleteRule(id) {
  if (!_db) return;
  try { _db.run(`DELETE FROM automation_rules WHERE id = ?`, [id]); } catch (_) {}
}

// ─────────────────────────────────────────────────────────────────────────────
// Route intelligence — analyse route_signals to surface improvement candidates
// Called by IPC 'get-route-stats' for the developer dashboard
// ─────────────────────────────────────────────────────────────────────────────

function getRouteStats(days = 7) {
  if (!_db) return {};
  const since = Math.floor(Date.now() / 1000) - days * 86400;
  try {
    const byTier = _db.all(
      `SELECT tier, COUNT(*) as count, ROUND(AVG(latency_ms)) as avg_ms
       FROM route_signals WHERE created_at > ? GROUP BY tier ORDER BY count DESC`,
      [since]
    );
    // Queries that consistently hit agent but have a sql/persisted twin → candidates to promote
    const agentCandidates = _db.all(
      `SELECT query_norm, COUNT(*) as hits
       FROM route_signals WHERE tier LIKE 'agent%' AND created_at > ?
       GROUP BY query_norm ORDER BY hits DESC LIMIT 10`,
      [since]
    );
    return { byTier, agentCandidates, periodDays: days };
  } catch (_) { return {}; }
}

// ─────────────────────────────────────────────────────────────────────────────
// Utils
// ─────────────────────────────────────────────────────────────────────────────

function _parse(str) {
  try { return JSON.parse(str || '{}'); } catch (_) { return {}; }
}

function _interpolate(template, data) {
  return template.replace(/\{\{(\w+)\}\}/g, (_, k) => {
    const val = data[k];
    return val !== undefined ? String(val) : `{{${k}}}`;
  });
}

function _cap(str) {
  if (!str) return '';
  return str.charAt(0).toUpperCase() + str.slice(1);
}

module.exports = { init, evaluate, getRules, createRule, updateRule, toggleRule, deleteRule, getRouteStats };
