/**
 * services/intelligence.js — ARIA Intelligence Engine
 *
 * Core intelligence layer that makes ARIA genuinely smart:
 *   - Behavior metrics: rolling averages + deviation tracking per category
 *   - Anomaly detection: flag unusual spending patterns
 *   - Proactive insights: unprompted intelligence (renewals, overdue, anomalies)
 *   - Conversation memory: feed recent chat history into AI calls
 *   - Dynamic entity loading: merchants + categories from actual DB data
 *
 * ALL data comes from the local SQLite database — no external API calls.
 */

'use strict';

const path = require('path');
const { get, all, run } = require(path.join(__dirname, '..', 'db'));

// ─────────────────────────────────────────────────────────────────────────────
// Caching infrastructure
// ─────────────────────────────────────────────────────────────────────────────

const _cache = {};
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

function cached(key, ttl, fn) {
  const entry = _cache[key];
  if (entry && (Date.now() - entry.ts) < (ttl || CACHE_TTL)) return entry.data;
  const data = fn();
  _cache[key] = { data, ts: Date.now() };
  return data;
}

function invalidateCache(key) {
  if (key) delete _cache[key];
  else Object.keys(_cache).forEach(k => delete _cache[k]);
}

// ─────────────────────────────────────────────────────────────────────────────
// Dynamic Entity Loading (replaces hardcoded merchant/category lists)
// ─────────────────────────────────────────────────────────────────────────────

// Base merchants — common Indian services as fallback when DB is empty
const BASE_MERCHANTS = [
  'swiggy', 'zomato', 'uber', 'ola', 'rapido', 'amazon', 'flipkart',
  'myntra', 'ajio', 'netflix', 'hotstar', 'disney', 'spotify',
  'youtube', 'prime', 'airtel', 'jio', 'vi', 'vodafone',
  'zerodha', 'groww', 'phonepe', 'paytm', 'gpay', 'google pay',
  'cred', 'slice', 'bigbasket', 'blinkit', 'zepto', 'instamart',
  'makemytrip', 'irctc', 'practo', 'pharmeasy', '1mg',
  'steam', 'playstation', 'github', 'chatgpt', 'notion',
  'aws', 'azure', 'dominos', 'starbucks', 'kfc',
  'hdfc', 'icici', 'sbi', 'axis', 'kotak', 'bajaj', 'lic',
  'reliance', 'dmart'
];

// Base categories — standard spending categories
const BASE_CATEGORIES = [
  'food', 'shopping', 'travel', 'entertainment', 'utilities', 'health',
  'groceries', 'subscriptions', 'investments', 'insurance', 'banking',
  'education', 'rent', 'emi', 'recharge', 'fuel', 'other'
];

// Category synonyms — map user's natural language to canonical category names
const CATEGORY_SYNONYMS = {
  // Food variants
  'dining': 'food', 'restaurant': 'food', 'restaurants': 'food', 'cafe': 'food',
  'takeout': 'food', 'delivery': 'food', 'eating': 'food', 'eat': 'food',
  'lunch': 'food', 'dinner': 'food', 'breakfast': 'food', 'snacks': 'food',
  'meals': 'food', 'meal': 'food', 'order': 'food', 'ordered': 'food',

  // Travel variants
  'commute': 'travel', 'transport': 'travel', 'transportation': 'travel',
  'ride': 'travel', 'rides': 'travel', 'cab': 'travel', 'cabs': 'travel',
  'taxi': 'travel', 'flight': 'travel', 'flights': 'travel', 'hotel': 'travel',
  'hotels': 'travel', 'trip': 'travel', 'trips': 'travel', 'booking': 'travel',
  'bus': 'travel', 'train': 'travel', 'metro': 'travel', 'auto': 'travel',

  // Entertainment variants
  'streaming': 'entertainment', 'movies': 'entertainment', 'movie': 'entertainment',
  'gaming': 'entertainment', 'games': 'entertainment', 'music': 'entertainment',
  'shows': 'entertainment', 'series': 'entertainment', 'ott': 'entertainment',
  'cinema': 'entertainment', 'concert': 'entertainment', 'theatre': 'entertainment',

  // Health variants
  'medicine': 'health', 'medicines': 'health', 'hospital': 'health',
  'doctor': 'health', 'pharmacy': 'health', 'medical': 'health',
  'gym': 'health', 'fitness': 'health', 'wellness': 'health',
  'dental': 'health', 'clinic': 'health', 'checkup': 'health',
  'healthcare': 'health', 'therapy': 'health',

  // Utilities variants
  'electricity': 'utilities', 'electric': 'utilities', 'water': 'utilities',
  'gas': 'utilities', 'internet': 'utilities', 'phone': 'utilities',
  'wifi': 'utilities', 'broadband': 'utilities', 'bill': 'utilities',
  'bills': 'utilities', 'power': 'utilities', 'dth': 'utilities',

  // Shopping variants
  'clothes': 'shopping', 'clothing': 'shopping', 'shoes': 'shopping',
  'fashion': 'shopping', 'apparel': 'shopping', 'electronics': 'shopping',
  'gadgets': 'shopping', 'accessories': 'shopping', 'online': 'shopping',

  // Investment variants
  'mutual fund': 'investments', 'mutual funds': 'investments',
  'stocks': 'investments', 'sip': 'investments', 'trading': 'investments',
  'crypto': 'investments', 'fd': 'investments', 'fixed deposit': 'investments',
  'shares': 'investments', 'demat': 'investments', 'nps': 'investments',

  // EMI/Loan variants
  'loan': 'emi', 'loans': 'emi', 'mortgage': 'emi', 'installment': 'emi',
  'installments': 'emi', 'equated': 'emi',

  // Education variants
  'tuition': 'education', 'course': 'education', 'courses': 'education',
  'school': 'education', 'college': 'education', 'learning': 'education',
  'class': 'education', 'classes': 'education', 'training': 'education',
  'certification': 'education', 'exam': 'education', 'books': 'education',

  // Fuel variants
  'petrol': 'fuel', 'diesel': 'fuel', 'ev charging': 'fuel',
  'charging': 'fuel', 'cng': 'fuel',

  // Groceries variants
  'grocery': 'groceries', 'supermarket': 'groceries', 'vegetables': 'groceries',
  'fruits': 'groceries', 'provisions': 'groceries', 'essentials': 'groceries',
  'daily needs': 'groceries', 'household': 'groceries',

  // Insurance variants
  'premium': 'insurance', 'premiums': 'insurance', 'policy': 'insurance',
  'policies': 'insurance', 'cover': 'insurance', 'claim': 'insurance',

  // Recharge variants
  'mobile': 'recharge', 'prepaid': 'recharge', 'postpaid': 'recharge',
  'top up': 'recharge', 'topup': 'recharge',

  // Subscription variants
  'recurring': 'subscriptions', 'membership': 'subscriptions',
  'plan': 'subscriptions', 'annual': 'subscriptions',

  // Common misspellings
  'entertainement': 'entertainment', 'shoping': 'shopping',
  'grocerys': 'groceries', 'heatlh': 'health', 'travle': 'travel',
  'utiliteis': 'utilities', 'insurace': 'insurance',
};

/**
 * Get all known merchants — merges DB data with base list.
 * Cached for 5 minutes.
 */
function getMerchants() {
  return cached('merchants', CACHE_TTL, () => {
    const merchants = new Set(BASE_MERCHANTS);

    try {
      // Pull distinct merchants from transactions table
      const txMerchants = all(
        `SELECT DISTINCT LOWER(TRIM(merchant)) as m FROM transactions
         WHERE merchant IS NOT NULL AND TRIM(merchant) != '' AND LENGTH(TRIM(merchant)) > 1`
      );
      for (const r of txMerchants) merchants.add(r.m);

      // Pull subscription names too
      const subNames = all(
        `SELECT DISTINCT LOWER(TRIM(name)) as m FROM subscriptions
         WHERE name IS NOT NULL AND TRIM(name) != '' AND LENGTH(TRIM(name)) > 1`
      );
      for (const r of subNames) merchants.add(r.m);

      // Pull spend_log descriptions that look like merchant names (short, no spaces often)
      const descMerchants = all(
        `SELECT DISTINCT LOWER(TRIM(description)) as m FROM spend_log
         WHERE description IS NOT NULL AND LENGTH(TRIM(description)) BETWEEN 2 AND 30
         GROUP BY LOWER(TRIM(description)) HAVING COUNT(*) >= 2`
      );
      for (const r of descMerchants) merchants.add(r.m);
    } catch (_) {}

    return [...merchants].sort((a, b) => b.length - a.length); // longest first for matching
  });
}

/**
 * Get all known categories — merges DB data with base list.
 * Cached for 5 minutes.
 */
function getCategories() {
  return cached('categories', CACHE_TTL, () => {
    const categories = new Set(BASE_CATEGORIES);

    try {
      const txCats = all(
        `SELECT DISTINCT LOWER(category) as c FROM transactions
         WHERE category IS NOT NULL AND category != '' AND category != 'other'`
      );
      for (const r of txCats) categories.add(r.c);

      const slCats = all(
        `SELECT DISTINCT LOWER(category) as c FROM spend_log
         WHERE category IS NOT NULL AND category != '' AND category != 'other'`
      );
      for (const r of slCats) categories.add(r.c);
    } catch (_) {}

    return [...categories];
  });
}

/**
 * Resolve a user's category input to a canonical category name.
 * Handles synonyms: "dining" → "food", "commute" → "travel", etc.
 */
function resolveCategory(input) {
  if (!input) return null;
  const low = input.toLowerCase().trim();

  // Direct match against known categories
  const categories = getCategories();
  if (categories.includes(low)) return low;

  // Synonym resolution
  if (CATEGORY_SYNONYMS[low]) return CATEGORY_SYNONYMS[low];

  // Fuzzy: check if input is a prefix of a category (3+ chars)
  if (low.length >= 3) {
    const match = categories.find(c => c.startsWith(low));
    if (match) return match;
  }

  // Check if any synonym key starts with user input
  if (low.length >= 3) {
    const synKey = Object.keys(CATEGORY_SYNONYMS).find(k => k.startsWith(low));
    if (synKey) return CATEGORY_SYNONYMS[synKey];
  }

  return null; // Unknown category
}

// ─────────────────────────────────────────────────────────────────────────────
// Behavior Metrics Computation
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Compute weekly spending metrics per category and populate behavior_metrics table.
 * Should be called daily or on app start.
 */
function computeBehaviorMetrics() {
  try {
    const now = Math.floor(Date.now() / 1000);

    // Get all categories with spending in last 12 weeks
    const categories = all(
      `SELECT DISTINCT category FROM transactions WHERE timestamp > ? AND category IS NOT NULL`,
      [now - 84 * 86400]
    );

    if (categories.length === 0) {
      console.log('[Intelligence] No transaction data for behavior metrics');
      return { computed: 0 };
    }

    // Current week start (Monday 00:00 UTC)
    const d = new Date();
    const day = d.getDay();
    const diff = day === 0 ? 6 : day - 1;
    d.setDate(d.getDate() - diff);
    d.setHours(0, 0, 0, 0);
    const currentWeekStart = Math.floor(d.getTime() / 1000);

    let computed = 0;

    for (const { category } of categories) {
      // Compute last 8 weeks of data
      for (let weekOffset = 0; weekOffset < 8; weekOffset++) {
        const weekStart = currentWeekStart - weekOffset * 7 * 86400;
        const weekEnd = weekStart + 7 * 86400;

        // This week's spending
        const weekData = get(
          `SELECT COALESCE(SUM(amount), 0) as total, COUNT(*) as cnt FROM transactions
           WHERE category = ? AND timestamp >= ? AND timestamp < ?`,
          [category, weekStart, weekEnd]
        );

        // Rolling 4-week average (4 weeks BEFORE this week)
        const prevWeeks = [];
        for (let pw = 1; pw <= 4; pw++) {
          const pwStart = weekStart - pw * 7 * 86400;
          const pwEnd = pwStart + 7 * 86400;
          const pwData = get(
            `SELECT COALESCE(SUM(amount), 0) as total FROM transactions
             WHERE category = ? AND timestamp >= ? AND timestamp < ?`,
            [category, pwStart, pwEnd]
          );
          prevWeeks.push(pwData?.total || 0);
        }

        const rollingAvg = prevWeeks.length > 0
          ? prevWeeks.reduce((s, v) => s + v, 0) / prevWeeks.length
          : 0;

        const weeklySpend = weekData?.total || 0;
        const deviation = rollingAvg > 0
          ? Math.round(((weeklySpend - rollingAvg) / rollingAvg) * 100)
          : 0;

        // Most common transaction hour
        const hourData = get(
          `SELECT CAST(((timestamp % 86400) / 3600) AS INT) as hour, COUNT(*) as cnt
           FROM transactions WHERE category = ? AND timestamp >= ? AND timestamp < ?
           GROUP BY hour ORDER BY cnt DESC LIMIT 1`,
          [category, weekStart, weekEnd]
        );

        // Pattern note
        let patternNote = null;
        if (Math.abs(deviation) > 50) {
          patternNote = deviation > 0
            ? `Spending ${deviation}% above 4-week average`
            : `Spending ${Math.abs(deviation)}% below 4-week average`;
        }

        // Upsert
        run(
          `INSERT INTO behavior_metrics (category, period_start, weekly_spend, rolling_4week_avg, deviation_percent, order_count, most_common_hour, pattern_note)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(category, period_start) DO UPDATE SET
             weekly_spend = excluded.weekly_spend,
             rolling_4week_avg = excluded.rolling_4week_avg,
             deviation_percent = excluded.deviation_percent,
             order_count = excluded.order_count,
             most_common_hour = excluded.most_common_hour,
             pattern_note = excluded.pattern_note,
             computed_at = strftime('%s','now')`,
          [category, weekStart, weeklySpend, rollingAvg, deviation,
           weekData?.cnt || 0, hourData?.hour ?? null, patternNote]
        );
        computed++;
      }
    }

    // Invalidate cache since metrics changed
    invalidateCache('anomalies');

    console.log(`[Intelligence] Computed ${computed} behavior metrics for ${categories.length} categories`);
    return { computed, categories: categories.length };
  } catch (err) {
    console.error('[Intelligence] computeBehaviorMetrics error:', err.message);
    return { computed: 0, error: err.message };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Anomaly Detection
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Get spending anomaly for a specific category in the current week.
 * Returns null if normal, or anomaly details object.
 */
function getSpendingAnomaly(category) {
  try {
    if (!category) return null;
    const resolved = resolveCategory(category) || category;

    const metric = get(
      `SELECT * FROM behavior_metrics
       WHERE LOWER(category) = ?
       ORDER BY period_start DESC LIMIT 1`,
      [resolved.toLowerCase()]
    );

    if (!metric || metric.rolling_4week_avg <= 0) return null;
    if (Math.abs(metric.deviation_percent) < 30) return null;

    return {
      category: metric.category,
      currentSpend: metric.weekly_spend,
      average: Math.round(metric.rolling_4week_avg),
      deviation: metric.deviation_percent,
      direction: metric.deviation_percent > 0 ? 'above' : 'below',
      severity: Math.abs(metric.deviation_percent) > 100 ? 'high'
        : Math.abs(metric.deviation_percent) > 50 ? 'medium' : 'low',
      note: metric.pattern_note
    };
  } catch (_) {
    return null;
  }
}

/**
 * Get all current spending anomalies across all categories.
 */
function getAllAnomalies() {
  return cached('anomalies', 10 * 60 * 1000, () => {
    try {
      const now = Math.floor(Date.now() / 1000);
      // Get most recent metric per category
      const metrics = all(
        `SELECT bm.* FROM behavior_metrics bm
         INNER JOIN (
           SELECT category, MAX(period_start) as max_ps
           FROM behavior_metrics GROUP BY category
         ) latest ON bm.category = latest.category AND bm.period_start = latest.max_ps
         WHERE ABS(bm.deviation_percent) > 30
         ORDER BY ABS(bm.deviation_percent) DESC`
      );

      return metrics.map(m => ({
        category: m.category,
        currentSpend: m.weekly_spend,
        average: Math.round(m.rolling_4week_avg),
        deviation: m.deviation_percent,
        direction: m.deviation_percent > 0 ? 'above' : 'below',
        severity: Math.abs(m.deviation_percent) > 100 ? 'high'
          : Math.abs(m.deviation_percent) > 50 ? 'medium' : 'low'
      }));
    } catch (_) {
      return [];
    }
  });
}

/**
 * Get anomaly summary string for injection into query responses.
 * Returns empty string if no anomalies.
 */
function getAnomalySummaryForCategory(category) {
  const anomaly = getSpendingAnomaly(category);
  if (!anomaly) return '';

  const emoji = anomaly.direction === 'above' ? '⚠️' : '📉';
  const verb = anomaly.direction === 'above' ? 'above' : 'below';
  return `\n\n${emoji} **Anomaly detected:** ${anomaly.category} spending is ${Math.abs(anomaly.deviation)}% ${verb} your 4-week average (avg: ₹${anomaly.average.toLocaleString('en-IN')}/week).`;
}

/**
 * Get global anomaly summary for money summary responses.
 */
function getAnomalySummaryGlobal() {
  const anomalies = getAllAnomalies();
  if (anomalies.length === 0) return '';

  const highAnomalies = anomalies.filter(a => a.direction === 'above' && a.severity !== 'low');
  if (highAnomalies.length === 0) return '';

  let lines = ['\n\n⚠️ **Spending Alerts:**'];
  for (const a of highAnomalies.slice(0, 3)) {
    lines.push(`• ${a.category}: ${a.deviation}% above average (₹${Math.round(a.currentSpend).toLocaleString('en-IN')} vs avg ₹${a.average.toLocaleString('en-IN')}/week)`);
  }
  return lines.join('\n');
}

// ─────────────────────────────────────────────────────────────────────────────
// Proactive Intelligence
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Gather proactive insights — things ARIA should surface without being asked.
 * Call on greeting, periodically, or when building context.
 */
function getProactiveInsights() {
  const insights = [];
  const now = Math.floor(Date.now() / 1000);

  try {
    // 1. Overdue tasks
    const overdue = get(
      `SELECT COUNT(*) as cnt FROM reminders WHERE completed = 0 AND archived_at IS NULL AND due_at < ?`,
      [now]
    );
    if (overdue?.cnt > 0) {
      const topOverdue = get(
        `SELECT title, due_at FROM reminders
         WHERE completed = 0 AND archived_at IS NULL AND due_at < ?
         ORDER BY due_at ASC LIMIT 1`,
        [now]
      );
      const daysLate = Math.round((now - (topOverdue?.due_at || now)) / 86400);
      insights.push({
        type: 'overdue_task',
        severity: daysLate > 3 ? 'high' : 'medium',
        message: `${overdue.cnt} overdue task${overdue.cnt > 1 ? 's' : ''}. Most urgent: "${topOverdue?.title}" (${daysLate}d late).`,
        action: 'Show overdue tasks'
      });
    }

    // 2. Upcoming subscription renewals (next 3 days)
    const renewals = all(
      `SELECT name, amount, next_renewal FROM subscriptions
       WHERE next_renewal BETWEEN ? AND ? ORDER BY next_renewal ASC`,
      [now, now + 3 * 86400]
    );
    if (renewals.length > 0) {
      const total = renewals.reduce((s, r) => {
        const amt = parseFloat(String(r.amount || '0').replace(/[₹,$,\s]/g, ''));
        return s + (isNaN(amt) ? 0 : amt);
      }, 0);
      insights.push({
        type: 'upcoming_renewal',
        severity: 'medium',
        message: `${renewals.length} subscription${renewals.length > 1 ? 's' : ''} renewing soon: ${renewals.map(r => r.name).join(', ')} (~₹${Math.round(total)}).`,
        action: 'Show subscriptions'
      });
    }

    // 3. Spending anomalies (high severity only)
    const anomalies = getAllAnomalies();
    const highAnoms = anomalies.filter(a => a.severity === 'high' && a.direction === 'above');
    if (highAnoms.length > 0) {
      const worst = highAnoms[0];
      insights.push({
        type: 'spending_anomaly',
        severity: 'high',
        message: `${worst.category} spending is ${worst.deviation}% above your 4-week average (₹${Math.round(worst.currentSpend)} vs avg ₹${worst.average}).`,
        action: `Show ${worst.category} spending`
      });
    }

    // 4. Unread urgent emails
    try {
      const urgentEmails = get(
        `SELECT COUNT(*) as cnt FROM email_cache WHERE category IN ('urgent','action') AND is_read = 0`
      );
      if (urgentEmails?.cnt > 0) {
        insights.push({
          type: 'urgent_email',
          severity: urgentEmails.cnt > 3 ? 'high' : 'medium',
          message: `${urgentEmails.cnt} urgent email${urgentEmails.cnt > 1 ? 's' : ''} need attention.`,
          action: 'Show urgent emails'
        });
      }
    } catch (_) {}

    // 5. Busy calendar day
    try {
      const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);
      const todayEnd = new Date(); todayEnd.setHours(23, 59, 59, 999);
      const todayEvents = get(
        `SELECT COUNT(*) as cnt FROM calendar_events WHERE start_at BETWEEN ? AND ?`,
        [Math.floor(todayStart.getTime() / 1000), Math.floor(todayEnd.getTime() / 1000)]
      );
      if (todayEvents?.cnt > 5) {
        insights.push({
          type: 'busy_day',
          severity: 'low',
          message: `Packed day: ${todayEvents.cnt} events on your calendar.`,
          action: 'Show today\'s schedule'
        });
      }
    } catch (_) {}

    // 6. Habit streaks at risk
    try {
      const today = new Date().toISOString().split('T')[0];
      const habits = all(`SELECT id, name FROM habits`);
      for (const h of habits) {
        const doneToday = get(`SELECT done FROM habit_log WHERE habit_id = ? AND date = ?`, [h.id, today]);
        if (!doneToday?.done) {
          // Count consecutive days of completion before today
          const recentLogs = all(
            `SELECT date FROM habit_log WHERE habit_id = ? AND done = 1 AND date < ?
             ORDER BY date DESC LIMIT 7`,
            [h.id, today]
          );
          let streak = 0;
          const checkDate = new Date(today);
          for (const log of recentLogs) {
            checkDate.setDate(checkDate.getDate() - 1);
            if (log.date === checkDate.toISOString().split('T')[0]) {
              streak++;
            } else break;
          }
          if (streak >= 3) {
            insights.push({
              type: 'habit_streak_risk',
              severity: 'low',
              message: `"${h.name}" has a ${streak}-day streak. Don't break it!`,
              action: 'Show habits'
            });
          }
        }
      }
    } catch (_) {}

    // 7. Monthly budget warnings (if budget_limits exist)
    try {
      const budgets = all(`SELECT category, monthly_limit FROM budget_limits`);
      if (budgets.length > 0) {
        const now = new Date();
        const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
        const monthStartUnix = Math.floor(monthStart.getTime() / 1000);
        const nowUnix = Math.floor(now.getTime() / 1000);
        const dayOfMonth = now.getDate();
        const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
        const monthProgress = dayOfMonth / daysInMonth;

        for (const b of budgets) {
          const spent = get(
            `SELECT COALESCE(SUM(amount), 0) as total FROM transactions
             WHERE LOWER(category) = ? AND timestamp >= ? AND timestamp <= ?`,
            [b.category.toLowerCase(), monthStartUnix, nowUnix]
          );
          const spentAmt = spent?.total || 0;
          const pctUsed = b.monthly_limit > 0 ? spentAmt / b.monthly_limit : 0;

          // Alert if spending pace exceeds budget pace by >20%
          if (pctUsed > monthProgress + 0.2 && pctUsed > 0.5) {
            insights.push({
              type: 'budget_warning',
              severity: pctUsed > 0.9 ? 'high' : 'medium',
              message: `${b.category} at ${Math.round(pctUsed * 100)}% of ₹${b.monthly_limit} budget with ${daysInMonth - dayOfMonth} days left.`,
              action: `Show ${b.category} spending`
            });
          }
        }
      }
    } catch (_) {}

  } catch (err) {
    console.error('[Intelligence] getProactiveInsights error:', err.message);
  }

  // Sort by severity
  const severityOrder = { high: 0, medium: 1, low: 2 };
  insights.sort((a, b) => (severityOrder[a.severity] || 2) - (severityOrder[b.severity] || 2));

  return insights;
}

/**
 * Format proactive insights as a brief status string for greetings.
 * Returns empty string if nothing notable.
 */
function formatInsightsForGreeting(maxInsights = 3) {
  const insights = getProactiveInsights();
  if (insights.length === 0) return '';

  const top = insights.slice(0, maxInsights);
  const lines = top.map(i => {
    const icon = i.severity === 'high' ? '🔴' : i.severity === 'medium' ? '🟡' : '💡';
    return `${icon} ${i.message}`;
  });

  return '\n\n' + lines.join('\n');
}

// ─────────────────────────────────────────────────────────────────────────────
// Conversation Memory
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Get conversation memory — last N chat messages for AI context injection.
 * Returns a formatted string suitable for system prompt.
 */
function getConversationMemory(limit = 10) {
  try {
    const messages = all(
      `SELECT role, text, created_at FROM chat_messages
       ORDER BY created_at DESC LIMIT ?`,
      [limit]
    );

    if (messages.length === 0) return '';

    // Reverse to chronological order
    messages.reverse();

    const formatted = messages.map(m => {
      const ago = _relativeTime(m.created_at);
      // Truncate long messages to keep context window manageable
      const text = m.text.length > 300 ? m.text.substring(0, 297) + '...' : m.text;
      return `${m.role === 'user' ? 'User' : 'ARIA'} (${ago}): ${text}`;
    }).join('\n');

    return `\n\nRECENT CONVERSATION (last ${messages.length} messages — use for follow-up context):\n` +
      formatted + '\n' +
      'FOLLOW-UP RULES: If user says "what about last month?", "more details", "and for food?", "compare that", etc., ' +
      'infer what they\'re referring to from the conversation above. Don\'t ask them to clarify — figure it out.';
  } catch (_) {
    return '';
  }
}

/**
 * Extract the last user query topic for follow-up context.
 * Useful for resolving "what about X?" style questions.
 */
function getLastQueryContext() {
  try {
    // Get the last few user messages to understand context
    const recent = all(
      `SELECT text FROM chat_messages WHERE role = 'user'
       ORDER BY created_at DESC LIMIT 3`
    );
    if (recent.length === 0) return null;

    return {
      lastQuery: recent[0]?.text || '',
      previousQueries: recent.slice(1).map(r => r.text),
    };
  } catch (_) {
    return null;
  }
}

function _relativeTime(unix) {
  const diff = Math.floor(Date.now() / 1000) - unix;
  if (diff < 60) return 'just now';
  if (diff < 3600) return `${Math.round(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.round(diff / 3600)}h ago`;
  return `${Math.round(diff / 86400)}d ago`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Universal Data Indexing Helper
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Get all indexable data across all domains for ChromaDB indexing.
 * Returns array of { doc_type, doc_id, text } objects.
 */
function getAllIndexableData() {
  const docs = [];

  try {
    // Emails (no limit — index all)
    const emails = all(
      `SELECT message_id, subject, body_preview, from_name, from_email
       FROM email_cache ORDER BY received_at DESC`
    );
    for (const e of emails) {
      const text = [e.subject, e.body_preview, `from ${e.from_name || e.from_email}`]
        .filter(Boolean).join(' ').trim();
      if (text.length > 10) {
        docs.push({ doc_type: 'email', doc_id: `email-${e.message_id}`, text });
      }
    }

    // Transactions (last 6 months)
    const sixMonthsAgo = Math.floor(Date.now() / 1000) - 180 * 86400;
    const txns = all(
      `SELECT id, merchant, category, amount, description, timestamp FROM transactions
       WHERE timestamp > ? ORDER BY timestamp DESC`,
      [sixMonthsAgo]
    );
    for (const t of txns) {
      const date = new Date(t.timestamp * 1000).toLocaleDateString('en-IN');
      const text = `Transaction: ₹${t.amount} at ${t.merchant || 'unknown'} for ${t.category} on ${date}. ${t.description || ''}`.trim();
      docs.push({ doc_type: 'transaction', doc_id: `tx-${t.id}`, text });
    }

    // Reminders (active)
    const reminders = all(
      `SELECT id, title, subtitle, category, due_at FROM reminders
       WHERE completed = 0 AND archived_at IS NULL`
    );
    for (const r of reminders) {
      const due = r.due_at ? new Date(r.due_at * 1000).toLocaleDateString('en-IN') : '';
      const text = `Task: ${r.title}. ${r.subtitle || ''} Category: ${r.category || 'general'}. Due: ${due}`.trim();
      docs.push({ doc_type: 'reminder', doc_id: `reminder-${r.id}`, text });
    }

    // Notes
    const notes = all(`SELECT id, title, content FROM notes`);
    for (const n of notes) {
      const text = `Note: ${n.title}. ${(n.content || '').substring(0, 1500)}`.trim();
      if (text.length > 10) {
        docs.push({ doc_type: 'note', doc_id: `note-${n.id}`, text });
      }
    }

    // Calendar events (next 30 days + last 30 days)
    const calStart = Math.floor(Date.now() / 1000) - 30 * 86400;
    const calEnd = Math.floor(Date.now() / 1000) + 30 * 86400;
    const events = all(
      `SELECT id, title, start_at, location, description FROM calendar_events
       WHERE start_at BETWEEN ? AND ?`,
      [calStart, calEnd]
    );
    for (const e of events) {
      const date = new Date(e.start_at * 1000).toLocaleDateString('en-IN');
      const text = `Calendar: ${e.title} on ${date}. ${e.location ? 'At ' + e.location + '.' : ''} ${e.description || ''}`.trim();
      docs.push({ doc_type: 'calendar', doc_id: `cal-${e.id}`, text });
    }

    // Subscriptions
    const subs = all(`SELECT id, name, amount, period, next_renewal FROM subscriptions`);
    for (const s of subs) {
      const renewal = s.next_renewal ? new Date(s.next_renewal * 1000).toLocaleDateString('en-IN') : '';
      const text = `Subscription: ${s.name}, ₹${s.amount}/${s.period}. Next renewal: ${renewal}`.trim();
      docs.push({ doc_type: 'subscription', doc_id: `sub-${s.id}`, text });
    }

  } catch (err) {
    console.error('[Intelligence] getAllIndexableData error:', err.message);
  }

  return docs;
}

// ─────────────────────────────────────────────────────────────────────────────
// Exports
// ─────────────────────────────────────────────────────────────────────────────

module.exports = {
  // Dynamic entities
  getMerchants,
  getCategories,
  resolveCategory,
  CATEGORY_SYNONYMS,
  BASE_MERCHANTS,
  BASE_CATEGORIES,
  invalidateCache,

  // Behavior metrics
  computeBehaviorMetrics,

  // Anomaly detection
  getSpendingAnomaly,
  getAllAnomalies,
  getAnomalySummaryForCategory,
  getAnomalySummaryGlobal,

  // Proactive intelligence
  getProactiveInsights,
  formatInsightsForGreeting,

  // Conversation memory
  getConversationMemory,
  getLastQueryContext,

  // Universal indexing
  getAllIndexableData,
};
