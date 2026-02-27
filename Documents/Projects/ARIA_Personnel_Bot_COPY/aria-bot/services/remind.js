/**
 * services/remind.js — Reminders CRUD + scheduling + Windows toast notifications
 * Uses node-schedule for in-process job scheduling.
 * Uses node-notifier for Windows toast notifications.
 */

const schedule = require('node-schedule');
const notifier = require('node-notifier');
const path = require('path');
const { run, get, all } = require('../db/index.js');
const { aiCall } = require('./ai.js');

// Track active scheduled jobs by reminder ID
const activeJobs = new Map();

/**
 * Parse natural language and save a new reminder.
 * @param {string} text - Natural language reminder text, e.g. "remind me to call mom tomorrow at 3pm"
 * @returns {Promise<object>} - The saved reminder object
 */
async function parseAndSave(text) {
  // Use AI to parse the natural language input
  let parsed;
  try {
    const result = await aiCall('parse', text, {});
    parsed = typeof result === 'string' ? JSON.parse(result) : result;
  } catch (err) {
    console.error('[Remind] AI parse failed:', err.message);
    // Last resort: create a reminder 1 hour from now with the raw text
    parsed = {
      title: text.substring(0, 100),
      due_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      recurring: null
    };
  }

  // Validate parsed data
  if (!parsed.title) parsed.title = text.substring(0, 100);
  if (!parsed.due_at) parsed.due_at = new Date(Date.now() + 60 * 60 * 1000).toISOString();

  // Convert ISO string to Unix timestamp
  const dueAtUnix = Math.floor(new Date(parsed.due_at).getTime() / 1000);

  // ── Duplicate detection (v1 hard rule) ──────────────────────────────
  // Block exact-title duplicate within ±24h window, or same title any time if not yet completed.
  const normalised = (parsed.title || '').trim().toLowerCase();
  const existing = get(
    `SELECT id FROM reminders
     WHERE completed = 0 AND archived_at IS NULL
       AND (lower(title) = ? OR (lower(title) = ? AND abs(due_at - ?) < 86400))
     LIMIT 1`,
    [normalised, normalised, dueAtUnix]
  );
  if (existing) {
    // Return the existing task silently — no duplicate created
    const dup = get('SELECT * FROM reminders WHERE id = ?', [existing.id]);
    return { ...dup, _duplicate: true };
  }

  // AI-provided intelligence fields (may be absent on fallback)
  const priorityScore = typeof parsed.priority_score === 'number' ? Math.max(1, Math.min(100, parsed.priority_score)) : null;
  const riskLevel     = ['Low', 'Moderate', 'High'].includes(parsed.risk) ? parsed.risk : null;
  const optimalRemind = parsed.optimal_reminder_time
    ? Math.floor(new Date(parsed.optimal_reminder_time).getTime() / 1000)
    : null;

  // Save to database
  const result = run(
    'INSERT INTO reminders (title, due_at, recurring, category, priority_score) VALUES (?, ?, ?, ?, ?)',
    [parsed.title, dueAtUnix, parsed.recurring || null, parsed.category || 'task', priorityScore ?? 0]
  );

  // Detect smart action based on task content and AI risk classification
  const smartAction = detectSmartAction(parsed.title, parsed.category, riskLevel);

  const reminder = {
    id: result.lastInsertRowid,
    title: parsed.title,
    due_at: dueAtUnix,
    recurring: parsed.recurring || null,
    completed: 0,
    category: parsed.category || 'task',
    priority_score: priorityScore ?? 0,
    smart_action: smartAction ? JSON.stringify(smartAction) : null
  };

  // Save smart action to DB
  if (smartAction) {
    run('UPDATE reminders SET smart_action = ? WHERE id = ?', [JSON.stringify(smartAction), reminder.id]);
  }

  // Schedule primary notification at due time
  scheduleReminder(reminder);

  // Schedule advance notification at optimal_reminder_time (if different from due_at and in the future)
  if (optimalRemind && optimalRemind < dueAtUnix && optimalRemind > Math.floor(Date.now() / 1000)) {
    const advanceReminder = { ...reminder, due_at: optimalRemind, _advance: true };
    scheduleReminder(advanceReminder);
    console.log(`[Remind] Advance notification scheduled at ${new Date(optimalRemind * 1000).toLocaleString()}`);
  }

  console.log(`[Remind] Created reminder #${reminder.id}: "${reminder.title}" | priority=${priorityScore ?? 0} risk=${riskLevel || 'n/a'} due=${new Date(dueAtUnix * 1000).toLocaleString()}`);
  return reminder;
}

/**
 * Detect smart action based on reminder content and optional AI-provided risk classification.
 */
function detectSmartAction(title, category, riskLevel) {
  const lowerTitle = (title || '').toLowerCase();
  const riskNote    = riskLevel === 'High' ? ' — high risk, act promptly'
                    : riskLevel === 'Moderate' ? ' — moderate urgency'
                    : '';

  // Finance / Subscription patterns
  if (lowerTitle.match(/renew|subscription|payment|bill|invoice|due/)) {
    if (lowerTitle.match(/review|check|compare/)) {
      return {
        suggestion: `Review pricing and consider alternatives before renewal${riskNote}`,
        cta: 'Compare Plans',
        type: 'finance',
        actions: ['Check current pricing', 'Compare with competitors', 'Review usage']
      };
    }
    return {
      suggestion: `Prepare payment method and confirm renewal terms${riskNote}`,
      cta: 'Review & Pay',
      type: 'finance',
      actions: ['Check payment method', 'Review renewal terms', 'Set budget reminder']
    };
  }

  // Work / Meeting patterns
  if (lowerTitle.match(/meeting|call|interview|presentation/)) {
    return {
      suggestion: `Prepare agenda and review relevant materials${riskNote}`,
      cta: 'Prepare',
      type: 'work',
      actions: ['Review agenda', 'Prepare materials', 'Test connection']
    };
  }

  // Review / Decision patterns
  if (lowerTitle.match(/review|decide|evaluate|consider/)) {
    return {
      suggestion: `Gather information and make an informed decision${riskNote}`,
      cta: 'Research',
      type: 'decision',
      actions: ['List pros/cons', 'Research options', 'Consult others']
    };
  }

  // Follow-up patterns
  if (lowerTitle.match(/follow up|check in|reach out|contact/)) {
    return {
      suggestion: 'Draft message and send follow-up',
      cta: 'Send',
      type: 'communication',
      actions: ['Draft message', 'Review context', 'Send follow-up']
    };
  }

  // Generic task
  return {
    suggestion: 'Complete this task on time',
    cta: 'Do It',
    type: 'task',
    actions: ['Start working', 'Mark done when finished']
  };
}

/**
 * Schedule a notification for a reminder.
 */
function scheduleReminder(reminder) {
  const dueDate = new Date(reminder.due_at * 1000);

  // Don't schedule if already past (unless recurring)
  if (dueDate <= new Date() && !reminder.recurring) {
    console.log(`[Remind] Skipping past reminder #${reminder.id}`);
    return;
  }

  // Cancel existing job if any
  if (activeJobs.has(reminder.id)) {
    activeJobs.get(reminder.id).cancel();
  }

  const job = schedule.scheduleJob(dueDate, () => {
    fireReminder(reminder.id);
  });

  if (job) {
    activeJobs.set(reminder.id, job);
    console.log(`[Remind] Scheduled reminder #${reminder.id} for ${dueDate.toLocaleString()}`);
  }
}

/**
 * Build a context-rich notification message for a reminder.
 * Enriches basic title with subscription amounts, smart action suggestions, etc.
 */
function buildContextualMessage(reminder) {
  const parts = [reminder.title];

  // If it's a subscription/financial reminder, look up the amount
  if (reminder.source === 'subscription' || reminder.category === 'subscription' ||
      (reminder.title || '').toLowerCase().match(/renew|subscription|payment|bill/)) {
    try {
      // Try to find matching subscription by name
      const titleLower = (reminder.title || '').toLowerCase();
      const subs = all('SELECT name, amount, period FROM subscriptions');
      for (const sub of subs) {
        if (titleLower.includes(sub.name.toLowerCase())) {
          if (sub.amount) parts.push(`— ${sub.amount} will be charged`);
          if (sub.period) parts.push(`(${sub.period})`);
          break;
        }
      }
    } catch (_) {}
  }

  // Add smart action suggestion if available
  if (reminder.smart_action) {
    try {
      const action = typeof reminder.smart_action === 'string'
        ? JSON.parse(reminder.smart_action)
        : reminder.smart_action;
      if (action?.suggestion && parts.length < 3) {
        parts.push(`· ${action.suggestion}`);
      }
    } catch (_) {}
  }

  // Add subtitle context if present
  if (reminder.subtitle && parts.length < 3) {
    parts.push(`· ${reminder.subtitle}`);
  }

  // If linked to a calendar event, add meeting context
  if (reminder.linked_calendar_event_id) {
    try {
      const event = get('SELECT title, location FROM calendar_events WHERE id = ?', [reminder.linked_calendar_event_id]);
      if (event) {
        if (event.location) parts.push(`📍 ${event.location}`);
      }
    } catch (_) {}
  }

  return parts.join(' ');
}

/**
 * Build a context-rich notification title.
 */
function buildContextualTitle(reminder) {
  if (reminder.source === 'subscription' || reminder.category === 'subscription') {
    return '💳 ARIA — Subscription Alert';
  }
  if (reminder.source === 'calendar' || reminder.linked_calendar_event_id) {
    return '📅 ARIA — Meeting Prep';
  }
  if ((reminder.title || '').toLowerCase().match(/follow up|reach out|contact/)) {
    return '🗣 ARIA — Follow Up';
  }
  if ((reminder.title || '').toLowerCase().match(/payment|bill|invoice/)) {
    return '💰 ARIA — Payment Due';
  }
  return 'ARIA Reminder';
}

/**
 * Fire a reminder notification via Windows toast.
 * Uses contextual enrichment for subscription amounts, smart actions, etc.
 */
function fireReminder(id) {
  const reminder = get('SELECT * FROM reminders WHERE id = ?', [id]);
  if (!reminder || reminder.completed) return;

  const iconPath = path.join(__dirname, '..', 'assets', 'icon.png');
  const contextTitle = buildContextualTitle(reminder);
  const contextMessage = buildContextualMessage(reminder);

  notifier.notify(
    {
      title: contextTitle,
      message: contextMessage,
      icon: iconPath,
      sound: true,
      wait: true,
      appID: 'ARIA Bot',
      actions: ['Done', 'Snooze 15m', 'Snooze 1h']
    },
    (err, response, metadata) => {
      if (err) {
        console.error('[Remind] Notification error:', err);
        return;
      }

      const action = metadata?.activationValue || response;

      if (action === 'Done' || response === 'activate') {
        // Mark as completed
        run('UPDATE reminders SET completed = 1, completed_at = ? WHERE id = ?', [Math.floor(Date.now() / 1000), id]);
        activeJobs.delete(id);
        console.log(`[Remind] Reminder #${id} marked as done`);

        // Focus ARIA window on notification click
        try {
          const { BrowserWindow } = require('electron');
          const win = BrowserWindow.getAllWindows()[0];
          if (win) { win.show(); win.focus(); win.webContents.send('navigate-to', 'remind'); }
        } catch (_) {}

        // If recurring, create next occurrence
        if (reminder.recurring) {
          createNextRecurrence(reminder);
        }
      } else if (action === 'Snooze 15m') {
        snoozeReminder(id, 15);
      } else if (action === 'Snooze 1h') {
        snoozeReminder(id, 60);
      } else {
        // Default click (no specific action) — focus the window
        try {
          const { BrowserWindow } = require('electron');
          const win = BrowserWindow.getAllWindows()[0];
          if (win) { win.show(); win.focus(); win.webContents.send('navigate-to', 'remind'); }
        } catch (_) {}
      }
    }
  );

  console.log(`[Remind] Fired notification for reminder #${id}: "${reminder.title}"`);
}

/**
 * Snooze a reminder by N minutes.
 */
function snoozeReminder(id, minutes) {
  const newDue = Math.floor(Date.now() / 1000) + minutes * 60;
  run('UPDATE reminders SET snoozed_to = ? WHERE id = ?', [newDue, id]);

  const reminder = get('SELECT * FROM reminders WHERE id = ?', [id]);
  if (reminder) {
    scheduleReminder({ ...reminder, due_at: newDue });
  }

  console.log(`[Remind] Snoozed reminder #${id} by ${minutes} minutes`);
}

/**
 * Create the next occurrence of a recurring reminder.
 */
function createNextRecurrence(reminder) {
  const now = new Date();
  let nextDue = new Date(reminder.due_at * 1000);

  switch (reminder.recurring) {
    case 'daily':
      nextDue.setDate(nextDue.getDate() + 1);
      break;
    case 'weekly':
      nextDue.setDate(nextDue.getDate() + 7);
      break;
    case 'monthly':
      nextDue.setMonth(nextDue.getMonth() + 1);
      break;
    default:
      return;
  }

  // Make sure next occurrence is in the future
  while (nextDue <= now) {
    switch (reminder.recurring) {
      case 'daily':
        nextDue.setDate(nextDue.getDate() + 1);
        break;
      case 'weekly':
        nextDue.setDate(nextDue.getDate() + 7);
        break;
      case 'monthly':
        nextDue.setMonth(nextDue.getMonth() + 1);
        break;
    }
  }

  const dueAtUnix = Math.floor(nextDue.getTime() / 1000);
  const result = run(
    'INSERT INTO reminders (title, due_at, recurring, category) VALUES (?, ?, ?, ?)',
    [reminder.title, dueAtUnix, reminder.recurring, reminder.category || 'task']
  );

  const newReminder = {
    id: result.lastInsertRowid,
    title: reminder.title,
    due_at: dueAtUnix,
    recurring: reminder.recurring,
    completed: 0,
    category: reminder.category
  };

  scheduleReminder(newReminder);
  console.log(`[Remind] Created next recurrence #${newReminder.id} for ${nextDue.toLocaleString()}`);
}

/**
 * Compute and store a priority score for every incomplete reminder.
 * Score factors:
 *   Overdue:   +10 per day late (capped at 100)
 *   Upcoming:  +30 if < 2h, +20 if < 6h, +10 if < 24h
 *   Source:    +12 calendar, +8 subscription, +5 email
 *   Context:   +3 if has subtitle, +10 if has linked_calendar_event_id
 * Higher score = surface first in the task list.
 */
function recalculatePriorityScores() {
  const now = Math.floor(Date.now() / 1000);
  try {
    const reminders = all('SELECT * FROM reminders WHERE completed = 0 AND archived_at IS NULL');
    for (const r of reminders) {
      let score = 0;

      if (r.due_at < now) {
        // Overdue: 10 points per day late, capped at 100
        const daysLate = (now - r.due_at) / 86400;
        score += Math.min(daysLate * 10, 100);
      } else {
        // Upcoming: bonus for proximity
        const hoursUntil = (r.due_at - now) / 3600;
        if (hoursUntil < 2)       score += 30;
        else if (hoursUntil < 6)  score += 20;
        else if (hoursUntil < 24) score += 10;
      }

      // Source bonuses
      if (r.source === 'calendar')     score += 12;
      if (r.source === 'subscription') score += 8;
      if (r.source === 'email')        score += 5;

      // Financial-risk weight — hard rule: financially exposed tasks rank higher
      const FIN_KEYWORDS = /pay|bill|renew|subscription|invoice|due|emi|loan|credit|transfer|payment/i;
      if (
        r.category === 'finance' ||
        r.category === 'payment' ||
        r.category === 'subscription' ||
        FIN_KEYWORDS.test(r.title || '')
      ) score += 20;

      // Context richness
      if (r.subtitle)                  score += 3;
      if (r.linked_calendar_event_id)  score += 10;

      run('UPDATE reminders SET priority_score = ? WHERE id = ?', [Math.round(score), r.id]);
    }
    console.log(`[Remind] Priority scores updated for ${reminders.length} tasks`);
  } catch (err) {
    console.error('[Remind] recalculatePriorityScores error:', err.message);
  }
}

/**
 * Load all uncompleted future reminders and reschedule them.
 * Call this on app startup — node-schedule doesn't persist across restarts.
 */
function loadAndReschedule() {
  const nowUnix = Math.floor(Date.now() / 1000);

  // Get all uncompleted reminders (both future and overdue for notification)
  const reminders = all(
    'SELECT * FROM reminders WHERE completed = 0'
  );

  let scheduled = 0;
  let overdue = 0;
  let updated = 0;

  for (const reminder of reminders) {
    // Backfill smart_action for existing reminders without it
    if (!reminder.smart_action) {
      const smartAction = detectSmartAction(reminder.title, reminder.category);
      if (smartAction) {
        run('UPDATE reminders SET smart_action = ? WHERE id = ?', [JSON.stringify(smartAction), reminder.id]);
        updated++;
      }
    }

    // Use snoozed_to if set, otherwise due_at
    const effectiveDue = reminder.snoozed_to || reminder.due_at;

    if (effectiveDue > nowUnix) {
      scheduleReminder({ ...reminder, due_at: effectiveDue });
      scheduled++;
    } else {
      // Overdue — fire notification immediately (slight delay to not spam on startup)
      overdue++;
      setTimeout(() => fireReminder(reminder.id), overdue * 2000);
    }
  }

  console.log(`[Remind] Loaded ${reminders.length} reminders: ${scheduled} scheduled, ${overdue} overdue, ${updated} updated with smart actions`);

  // Compute priority scores for the UI sort
  recalculatePriorityScores();
}

/**
 * Get all reminders (for display).
 */
function getReminders(includeCompleted = false) {
  if (includeCompleted) {
    return all('SELECT * FROM reminders ORDER BY due_at DESC');
  }
  return all('SELECT * FROM reminders WHERE completed = 0 ORDER BY due_at ASC');
}

module.exports = {
  parseAndSave,
  fireReminder,
  snoozeReminder,
  loadAndReschedule,
  getReminders,
  scheduleReminder,
  detectSmartAction,
  recalculatePriorityScores
};
