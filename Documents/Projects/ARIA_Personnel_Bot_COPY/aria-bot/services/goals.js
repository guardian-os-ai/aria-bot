/**
 * services/goals.js — ARIA Goal Layer
 *
 * The line between a DB wrapper and a personal agent.
 *
 * Bot:   answers "how much did I spend on food?"
 * Agent: knows you want to REDUCE food spend by 30%, tracks it silently,
 *        alerts when you're on pace to miss it, tells you WHY, learns over time.
 *
 * Architecture:
 *   Goal detection: regex fast path — zero Ollama for clear declarations.
 *                   Ollama ONLY for ambiguous ("I've been spending too much on food")
 *   Baseline:       3-month avg from transactions — pure SQL, no LLM
 *   Progress:       current period spend vs target — pure SQL, no LLM
 *   Alerts:         template if on track, Ollama if at risk (1 call/day/goal max)
 *   Learning:       outcomes stored on close → ARIA improves its estimates over time
 *
 * Ollama is called for exactly 2 things:
 *   A. Ambiguous goal text regex can't parse (1 call, disposable)
 *   B. Personalized advice when a goal is at risk (1 call/day/goal, rate-limited)
 *
 * Everything else is SQL + arithmetic.
 */

'use strict';

const path = require('path');
const { get, all, run } = require(path.join(__dirname, '..', 'db'));

// ─────────────────────────────────────────────────────────────────────────────
// Goal detection — Regex fast path
// Covers ~200 common declaration patterns — zero Ollama for clear intent
// ─────────────────────────────────────────────────────────────────────────────

const GOAL_PATTERNS = [
  // "reduce/cut/lower food spending by 30%"
  {
    re: /\b(?:reduce|cut|lower|decrease|limit)\s+(?:my\s+)?(\w+)\s+(?:spend(?:ing)?|expenses?|budget|costs?)\s+by\s+(\d+)%?\s*(?:this\s+(week|month))?\b/i,
    extract: m => ({ goal_type: 'reduce', category: m[1], target_pct: parseFloat(m[2]), period: m[3] || 'month' }),
  },
  // "reduce/cut food spending to 5000"
  {
    re: /\b(?:reduce|cut|lower)\s+(?:my\s+)?(\w+)\s+(?:spend(?:ing)?|expenses?|budget)\s+to\s+(?:₹|rs\.?\s*)?(\d[\d,]*)\s*(?:this\s+(week|month))?\b/i,
    extract: m => ({ goal_type: 'limit', category: m[1], target_amount: parseFloat(m[2].replace(/,/g, '')), period: m[3] || 'month' }),
  },
  // "spend less than 5000 on food" / "spend max 5000 on food"
  {
    re: /\bspend\s+(?:less\s+than|under|max(?:imum)?|at\s+most|not\s+more\s+than)\s+(?:₹|rs\.?\s*)?(\d[\d,]*)\s*(?:rupees?\s+)?(?:on\s+)?(\w+)\b/i,
    extract: m => ({ goal_type: 'limit', target_amount: parseFloat(m[1].replace(/,/g, '')), category: m[2], period: 'month' }),
  },
  // "budget 5000 for food this month"
  {
    re: /\bbudget\s+(?:₹|rs\.?\s*)?(\d[\d,]*)\s*(?:rupees?\s+)?(?:for|on)\s+(\w+)(?:\s+this\s+(week|month))?\b/i,
    extract: m => ({ goal_type: 'limit', target_amount: parseFloat(m[1].replace(/,/g, '')), category: m[2], period: m[3] || 'month' }),
  },
  // "save 10000 this month"
  {
    re: /\bsave\s+(?:₹|rs\.?\s*)?(\d[\d,]*)\s*(?:rupees?\s+)?(?:this\s+(week|month)|per\s+(week|month))?\b/i,
    extract: m => ({ goal_type: 'save', target_amount: parseFloat(m[1].replace(/,/g, '')), period: m[2] || m[3] || 'month' }),
  },
  // "cut Swiggy by 50%" / "reduce Uber spend by 30%"
  {
    re: /\b(?:cut|reduce|lower)\s+(?:my\s+)?(\w+)(?:\s+(?:spend|spending|expenses?))?\s+by\s+(\d+)%\s*(?:this\s+(week|month))?\b/i,
    extract: m => ({ goal_type: 'reduce', merchant: m[1], target_pct: parseFloat(m[2]), period: m[3] || 'month' }),
  },
  // "keep food under 8000 this month"
  {
    re: /\bkeep\s+(?:my\s+)?(\w+)(?:\s+(?:spend(?:ing)?|expenses?))?\s+(?:under|below|to|at)\s+(?:₹|rs\.?\s*)?(\d[\d,]*)\s*(?:this\s+(week|month))?\b/i,
    extract: m => ({ goal_type: 'limit', category: m[1], target_amount: parseFloat(m[2].replace(/,/g, '')), period: m[3] || 'month' }),
  },
  // "I want to spend less on food" / "trying to cut food"
  {
    re: /\b(?:want\s+to|trying\s+to|need\s+to|going\s+to)\s+(?:spend\s+less\s+on|cut|reduce)\s+(?:my\s+)?(\w+)\b/i,
    extract: m => ({ goal_type: 'reduce', category: m[1], target_pct: 20, period: 'month' }), // default 20% reduction
  },
  // "set a budget of 3000 for food"
  {
    re: /\bset\s+(?:a\s+)?budget\s+(?:of\s+)?(?:₹|rs\.?\s*)?(\d[\d,]*)\s*(?:rupees?\s+)?(?:for|on)\s+(\w+)\b/i,
    extract: m => ({ goal_type: 'limit', target_amount: parseFloat(m[1].replace(/,/g, '')), category: m[2], period: 'month' }),
  },
];

// Words that look like categories/merchants but are noise (skip them)
const _NOISE = new Set([
  'the', 'my', 'less', 'more', 'much', 'total', 'all', 'every', 'some', 'a', 'an',
  'this', 'that', 'i', 'on', 'in', 'at', 'by', 'to', 'for', 'and', 'or', 'not',
  'your', 'its', 'it', 'of', 'from', 'about', 'spend', 'spending', 'amount',
]);

// Category synonym resolution
const _CAT_MAP = {
  eating: 'food', dining: 'food', meals: 'food', restaurants: 'food',
  swiggy: 'food', zomato: 'food', 'uber eats': 'food',
  commute: 'travel', transport: 'travel', cab: 'travel', taxi: 'travel',
  uber: 'travel', rapido: 'travel', ola: 'travel', bus: 'travel',
  clothes: 'shopping', clothing: 'shopping', amazon: 'shopping', flipkart: 'shopping',
  movies: 'entertainment', netflix: 'entertainment', hotstar: 'entertainment',
  prime: 'entertainment', spotify: 'entertainment', gaming: 'entertainment',
  medical: 'health', medicine: 'health', pharmacy: 'health', doctor: 'health',
  gym: 'health', hospital: 'health',
  electricity: 'utilities', internet: 'utilities', wifi: 'utilities', phone: 'utilities',
  bill: 'utilities', bills: 'utilities',
};

function _resolveCategory(raw) {
  const clean = (raw || '').toLowerCase().trim();
  return _CAT_MAP[clean] || clean;
}

/**
 * Detect structured goal from natural language.
 * Returns: { goal_type, category?, merchant?, target_amount?, target_pct?, period, confidence, rawText }
 * confidence='high'  → regex match, directly actionable
 * confidence='low'   → signal words present but ambiguous, needs Ollama
 * null               → no goal intent detected
 */
function detectGoalFromMessage(msg) {
  const low = msg.toLowerCase().trim();

  // Fast bail: if no goal-signal words, skip entirely
  const hasSignal = /\b(?:reduce|cut|lower|limit|budget|save|goal|target|keep.*under|spend.*less|want to spend|trying to|control|track|stop spending|spending too much)\b/.test(low);
  if (!hasSignal) return null;

  for (const pat of GOAL_PATTERNS) {
    const m = low.match(pat.re);
    if (!m) continue;

    const extracted = pat.extract(m);

    // Normalise + validate extracted fields
    if (extracted.category) {
      const cat = extracted.category.toLowerCase().trim();
      if (_NOISE.has(cat) || cat.length < 2) { extracted.category = null; continue; }
      extracted.category = _resolveCategory(cat);
    }
    if (extracted.merchant) {
      const merch = extracted.merchant.toLowerCase().trim();
      if (_NOISE.has(merch) || merch.length < 2) { extracted.merchant = null; continue; }
    }
    if (extracted.target_pct && (extracted.target_pct > 100 || extracted.target_pct <= 0)) continue;
    if (extracted.target_amount && extracted.target_amount < 0) continue;
    if (!extracted.category && !extracted.merchant && extracted.goal_type !== 'save') continue;

    return { ...extracted, confidence: 'high', rawText: msg };
  }

  // Signal present but no pattern matched
  return { confidence: 'low', rawText: msg };
}

// ─────────────────────────────────────────────────────────────────────────────
// Ollama: interpret ambiguous goal text
// Called ONLY when regex confidence is 'low' — maximum once per declaration
// ─────────────────────────────────────────────────────────────────────────────

async function interpretGoalWithOllama(msg) {
  let ollamaService;
  try { ollamaService = require(path.join(__dirname, 'ollama')); } catch (_) { return null; }

  const system = `You are a goal extractor for a personal finance AI.
Extract a structured spending goal from the user message.
Return ONLY valid JSON — no explanation, no markdown — exactly this shape:
{
  "goal_type": "reduce|limit|save",
  "category": "food|travel|shopping|entertainment|utilities|health|subscriptions|null",
  "merchant": "merchant name or null",
  "target_amount": number or null,
  "target_pct": reduction percentage as positive number or null,
  "period": "week|month"
}
If there is no spending goal in the message, return: {"goal_type": null}`;

  try {
    const raw = await ollamaService.call(
      'qwen2.5:7b',
      [{ role: 'system', content: system }, { role: 'user', content: msg }],
      { temperature: 0, max_tokens: 180, timeout: 15000 }
    );
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;
    const parsed = JSON.parse(jsonMatch[0]);
    if (!parsed.goal_type) return null;
    if (parsed.category) parsed.category = _resolveCategory(parsed.category);
    if (parsed.target_pct && parsed.target_pct > 100) return null;
    return { ...parsed, confidence: 'high', rawText: msg, from_llm: true };
  } catch (err) {
    console.warn('[Goals] Ollama interpret error:', err.message);
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Baseline — 3-month average from transaction history, pure SQL
// ─────────────────────────────────────────────────────────────────────────────

function _computeBaseline(category, merchant) {
  const now  = Math.floor(Date.now() / 1000);
  const from = now - 90 * 86400; // 3 months back

  let total = 0;
  if (merchant) {
    const like = `%${merchant.toLowerCase()}%`;
    const tx = get(`SELECT COALESCE(SUM(amount),0) as t FROM transactions WHERE (LOWER(merchant) LIKE ? OR LOWER(description) LIKE ?) AND timestamp BETWEEN ? AND ?`, [like, like, from, now]);
    const sl = get(`SELECT COALESCE(SUM(amount_raw),0) as t FROM spend_log WHERE LOWER(description) LIKE ? AND occurred_at BETWEEN ? AND ?`, [like, from, now]);
    total = (tx?.t || 0) + (sl?.t || 0);
  } else if (category) {
    const cat = category.toLowerCase();
    const tx = get(`SELECT COALESCE(SUM(amount),0) as t FROM transactions WHERE LOWER(category)=? AND timestamp BETWEEN ? AND ?`, [cat, from, now]);
    const sl = get(`SELECT COALESCE(SUM(amount_raw),0) as t FROM spend_log WHERE LOWER(category)=? AND occurred_at BETWEEN ? AND ?`, [cat, from, now]);
    total = (tx?.t || 0) + (sl?.t || 0);
  } else {
    // Save goal: total spending across everything
    const tx = get(`SELECT COALESCE(SUM(amount),0) as t FROM transactions WHERE timestamp BETWEEN ? AND ?`, [from, now]);
    const sl = get(`SELECT COALESCE(SUM(amount_raw),0) as t FROM spend_log WHERE occurred_at BETWEEN ? AND ?`, [from, now]);
    total = (tx?.t || 0) + (sl?.t || 0);
  }
  return Math.round(total / 3); // monthly average
}

// ─────────────────────────────────────────────────────────────────────────────
// Period helpers
// ─────────────────────────────────────────────────────────────────────────────

function _getPeriodRange(period) {
  const now = new Date();
  let start, end;
  if (period === 'week') {
    const day = now.getDay() === 0 ? 6 : now.getDay() - 1; // Mon=0
    start = new Date(now); start.setDate(now.getDate() - day); start.setHours(0, 0, 0, 0);
    end   = new Date(start); end.setDate(start.getDate() + 7);
  } else { // month
    start = new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0, 0);
    end   = new Date(now.getFullYear(), now.getMonth() + 1, 1, 0, 0, 0, 0);
  }
  const nowTs = Math.floor(now.getTime() / 1000);
  const startTs = Math.floor(start.getTime() / 1000);
  const endTs   = Math.floor(end.getTime() / 1000);
  const total   = endTs - startTs;
  const elapsed = nowTs - startTs;
  return { start: startTs, end: endTs, now: nowTs, totalSecs: total, elapsedSecs: Math.max(0, elapsed) };
}

function _fmt(n) { return `₹${Math.round(n || 0).toLocaleString('en-IN')}`; }

// ─────────────────────────────────────────────────────────────────────────────
// Goal title builder
// ─────────────────────────────────────────────────────────────────────────────

function _buildTitle(goal_type, category, merchant, target_pct, target_amount, period) {
  const subject = merchant || category || 'total spending';
  if (goal_type === 'reduce' && target_pct)
    return `Reduce ${subject} by ${target_pct}% this ${period}`;
  if (goal_type === 'limit' && target_amount)
    return `Keep ${subject} under ${_fmt(target_amount)} this ${period}`;
  if (goal_type === 'save' && target_amount)
    return `Save ${_fmt(target_amount)} this ${period}`;
  return `${goal_type} goal: ${subject}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Goal CRUD
// ─────────────────────────────────────────────────────────────────────────────

function createGoal(goalData) {
  _ensureTables();
  const { goal_type, category, merchant, target_amount, target_pct, period = 'month' } = goalData;

  const baseline = _computeBaseline(category, merchant);

  // Derive target amount if only percentage given
  let finalTarget = target_amount;
  if (!finalTarget && target_pct && baseline > 0) {
    finalTarget = Math.round(baseline * (1 - target_pct / 100));
  }

  const pr       = _getPeriodRange(period);
  const deadline = pr.end;
  const title    = _buildTitle(goal_type, category, merchant, target_pct, finalTarget, period);

  run(
    `INSERT INTO goals (title, goal_type, category, merchant,
       target_amount, target_pct, baseline_amount, period, deadline, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?)`,
    [title, goal_type, category || null, merchant || null,
     finalTarget || null, target_pct || null, baseline, period, deadline,
     Math.floor(Date.now() / 1000)]
  );

  const created = get(`SELECT * FROM goals ORDER BY id DESC LIMIT 1`);
  console.log(`[Goals] Created: "${title}" | baseline=${_fmt(baseline)} → target=${_fmt(finalTarget)}`);
  return created;
}

function getActiveGoals() {
  try {
    _ensureTables();
    const now = Math.floor(Date.now() / 1000);
    return all(`SELECT * FROM goals WHERE status='active' AND (deadline IS NULL OR deadline>?) ORDER BY created_at DESC`, [now]);
  } catch (_) { return []; }
}

function getGoalForCategory(category) {
  try {
    _ensureTables();
    return get(`SELECT * FROM goals WHERE LOWER(category)=? AND status='active' LIMIT 1`, [category.toLowerCase()]) || null;
  } catch (_) { return null; }
}

function getGoalForMerchant(merchant) {
  try {
    _ensureTables();
    return get(`SELECT * FROM goals WHERE LOWER(merchant)=? AND status='active' LIMIT 1`, [merchant.toLowerCase()]) || null;
  } catch (_) { return null; }
}

function closeGoal(id, outcome, note) {
  run(`UPDATE goals SET status=?, last_checked=? WHERE id=?`, [outcome, Math.floor(Date.now() / 1000), id]);
  try {
    run(`INSERT INTO goal_progress (goal_id, checked_at, status, note) VALUES (?,?,?,?)`,
      [id, Math.floor(Date.now() / 1000), outcome, note || null]);
  } catch (_) {}
}

// ─────────────────────────────────────────────────────────────────────────────
// Progress checking — pure SQL, no LLM
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Compute current progress for a single goal.
 * Returns: { current, target, pctUsed, pctElapsed, status, periodEnded }
 */
function checkGoalProgress(goal) {
  const pr = _getPeriodRange(goal.period || 'month');
  let current = 0;

  if (goal.merchant) {
    const like = `%${goal.merchant.toLowerCase()}%`;
    const tx = get(`SELECT COALESCE(SUM(amount),0) as t FROM transactions WHERE (LOWER(merchant) LIKE ? OR LOWER(description) LIKE ?) AND timestamp BETWEEN ? AND ?`, [like, like, pr.start, pr.now]);
    const sl = get(`SELECT COALESCE(SUM(amount_raw),0) as t FROM spend_log WHERE LOWER(description) LIKE ? AND occurred_at BETWEEN ? AND ?`, [like, pr.start, pr.now]);
    current = (tx?.t || 0) + (sl?.t || 0);
  } else if (goal.category) {
    const cat = goal.category.toLowerCase();
    const tx = get(`SELECT COALESCE(SUM(amount),0) as t FROM transactions WHERE LOWER(category)=? AND timestamp BETWEEN ? AND ?`, [cat, pr.start, pr.now]);
    const sl = get(`SELECT COALESCE(SUM(amount_raw),0) as t FROM spend_log WHERE LOWER(category)=? AND occurred_at BETWEEN ? AND ?`, [cat, pr.start, pr.now]);
    current = (tx?.t || 0) + (sl?.t || 0);
  } else {
    // Save goal — track total spending
    const tx = get(`SELECT COALESCE(SUM(amount),0) as t FROM transactions WHERE timestamp BETWEEN ? AND ?`, [pr.start, pr.now]);
    const sl = get(`SELECT COALESCE(SUM(amount_raw),0) as t FROM spend_log WHERE occurred_at BETWEEN ? AND ?`, [pr.start, pr.now]);
    current = (tx?.t || 0) + (sl?.t || 0);
  }

  const target     = goal.target_amount || 1;
  const pctUsed    = Math.round(current / target * 100);
  const pctElapsed = pr.totalSecs > 0 ? Math.round(pr.elapsedSecs / pr.totalSecs * 100) : 0;
  const periodEnded = pr.now >= pr.end;

  let status = 'on_track';
  if (periodEnded) {
    status = current <= target ? 'achieved' : 'failed';
  } else if (current >= target) {
    status = 'exceeded';   // blew the budget mid-period
  } else if (pctUsed > pctElapsed + 20) {
    status = 'at_risk';    // spending faster than time is progressing
  }

  return { current, target, pctUsed, pctElapsed, status, periodEnded };
}

// ─────────────────────────────────────────────────────────────────────────────
// Background goal check — called by runBackgroundSync every 5 min
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Check all active goals. Returns array of alert strings for at-risk goals.
 * @param {Function} aiCallFn — aiService.aiCall.bind(aiService) or null for template-only
 */
async function checkAllGoals(aiCallFn) {
  let goals;
  try { goals = getActiveGoals(); } catch (_) { return []; }
  if (!goals.length) return [];

  const alerts = [];
  const now    = Math.floor(Date.now() / 1000);

  for (const goal of goals) {
    try {
      const progress = checkGoalProgress(goal);

      // Persist progress snapshot
      try {
        run(`INSERT INTO goal_progress (goal_id, checked_at, current_amount, target_amount, pct_used, pct_elapsed, status)
             VALUES (?,?,?,?,?,?,?)`,
          [goal.id, now, progress.current, progress.target, progress.pctUsed, progress.pctElapsed, progress.status]);
      } catch (_) {}
      run(`UPDATE goals SET last_checked=? WHERE id=?`, [now, goal.id]);

      // Close if period ended
      if (progress.periodEnded) {
        const note = `Final: ${_fmt(progress.current)} vs target ${_fmt(progress.target)} (${progress.pctUsed}%)`;
        closeGoal(goal.id, progress.status, note);
        const emoji = progress.status === 'achieved' ? '🎯' : '📉';
        alerts.push(`${emoji} Goal closed: "${goal.title}" — ${note}`);
        continue;
      }

      // Alert only if at risk or exceeded
      if (progress.status !== 'at_risk' && progress.status !== 'exceeded') continue;

      // Rate limit: 1 alert per goal per 24 hours
      const lastAlert = goal.last_alert || 0;
      if (now - lastAlert < 86400) continue;

      const alertMsg = aiCallFn ? await _ollamaAlert(goal, progress, aiCallFn) : _templateAlert(goal, progress);
      if (alertMsg) {
        alerts.push(alertMsg);
        run(`UPDATE goals SET last_alert=? WHERE id=?`, [now, goal.id]);
      }
    } catch (err) {
      console.warn(`[Goals] checkGoal ${goal.id} error:`, err.message);
    }
  }
  return alerts;
}

// Template alert — zero LLM, instant
function _templateAlert(goal, progress) {
  const emoji = progress.status === 'exceeded' ? '🚨' : '⚠️';
  const rem   = 100 - progress.pctElapsed;
  return `${emoji} **Goal at risk:** "${goal.title}"\n${_fmt(progress.current)} spent = ${progress.pctUsed}% of ${_fmt(progress.target)} target, but only ${rem}% of the period remains.`;
}

// Ollama alert — personalized, max 1/day/goal
async function _ollamaAlert(goal, progress, aiCallFn) {
  // Get top merchant for context (free — pure SQL)
  let context = '';
  if (goal.category && !goal.merchant) {
    const pr  = _getPeriodRange(goal.period || 'month');
    const top = get(
      `SELECT merchant, SUM(amount) as t FROM transactions
       WHERE LOWER(category)=? AND timestamp BETWEEN ? AND ? AND merchant IS NOT NULL
       GROUP BY merchant ORDER BY t DESC LIMIT 1`,
      [goal.category.toLowerCase(), pr.start, pr.now]
    );
    if (top?.merchant) context = ` Your top driver is ${top.merchant} at ${_fmt(top.t)}.`;
  }

  const prompt = `Goal: "${goal.title}"
Spent ${_fmt(progress.current)} (${progress.pctUsed}% of ${_fmt(progress.target)} target) with ${100 - progress.pctElapsed}% of the ${goal.period} remaining.${context}
Write exactly 2 sentences: (1) the risk in plain language, (2) one concrete action to get back on track. No filler. Direct.`;

  try {
    const res = await aiCallFn('chat', prompt, {
      systemContext: 'You are ARIA, a personal finance assistant. Be sharp and direct. No intro phrases.'
    });
    const text = (typeof res === 'string' ? res : res?.text || '').trim();
    if (text.length < 20) return _templateAlert(goal, progress);
    return `⚠️ **${goal.title}**\n${text}`;
  } catch (_) {
    return _templateAlert(goal, progress);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Greeting summary — injected into chatEnhancedHandler greeting fast-path
// ─────────────────────────────────────────────────────────────────────────────

function getGoalSummaryForGreeting() {
  const goals = getActiveGoals();
  if (!goals.length) return '';

  const lines = [];
  for (const goal of goals.slice(0, 2)) {
    try {
      const p   = checkGoalProgress(goal);
      const dot = p.status === 'on_track' ? '🟢' : p.status === 'at_risk' ? '🟡' : '🔴';
      const rem = 100 - p.pctElapsed;
      lines.push(`  ${dot} ${goal.title} — ${p.pctUsed}% used, ${rem}% of ${goal.period} left`);
    } catch (_) {}
  }
  return lines.length ? `\n\n**Goals:**\n${lines.join('\n')}` : '';
}

/**
 * Format goal progress for inline response (used after createGoal).
 * Returns a 2-line summary the user sees immediately.
 */
function formatNewGoalConfirmation(goal, progress) {
  const lines = [
    `🎯 **Goal set:** ${goal.title}`,
    `Baseline (3-month avg): ${_fmt(goal.baseline_amount || 0)} → Target: ${_fmt(goal.target_amount || 0)}`,
  ];
  if (progress.current > 0) {
    lines.push(`Current: ${_fmt(progress.current)} (${progress.pctUsed}% of target, ${progress.pctElapsed}% of ${goal.period} elapsed)`);
  }
  lines.push(`_I'll track this in the background and alert you if you go off pace._`);
  return lines.join('\n');
}

// ─────────────────────────────────────────────────────────────────────────────
// Table guard — idempotent CREATE IF NOT EXISTS
// ─────────────────────────────────────────────────────────────────────────────

function _ensureTables() {
  run(`CREATE TABLE IF NOT EXISTS goals (
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
  )`);
  run(`CREATE TABLE IF NOT EXISTS goal_progress (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    goal_id         INTEGER REFERENCES goals(id) ON DELETE CASCADE,
    checked_at      INTEGER NOT NULL,
    current_amount  REAL DEFAULT 0,
    target_amount   REAL,
    pct_used        REAL,
    pct_elapsed     REAL,
    status          TEXT DEFAULT 'on_track',
    note            TEXT
  )`);
  try {
    run(`CREATE INDEX IF NOT EXISTS idx_goals_status ON goals(status)`);
    run(`CREATE INDEX IF NOT EXISTS idx_goal_progress_goal ON goal_progress(goal_id, checked_at)`);
  } catch (_) {}
}

module.exports = {
  detectGoalFromMessage,
  interpretGoalWithOllama,
  createGoal,
  getActiveGoals,
  getGoalForCategory,
  getGoalForMerchant,
  checkGoalProgress,
  checkAllGoals,
  getGoalSummaryForGreeting,
  formatNewGoalConfirmation,
};
