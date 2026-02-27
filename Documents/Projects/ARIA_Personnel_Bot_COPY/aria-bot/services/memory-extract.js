/**
 * services/memory-extract.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Two responsibilities — zero LLM calls:
 *
 *  1. AUTO-LEARN  : Passively extract structured facts from every user message
 *                   → write to ai_memory with 60-day deduplication.
 *                   Over time ARIA builds a real profile without the user
 *                   needing to explicitly say "remember this".
 *
 *  2. PERSIST CACHE: Save Q+A pairs (from SQL, agent, recall) to query_answers
 *                    table so repeat questions survive app restarts and skip
 *                    Ollama entirely (served as "persisted-sql", "persisted-agent"
 *                    etc. in aiProvider field).
 *
 * Usage (in main.js):
 *   const memoryExtractService = require('../services/memory-extract.js');
 *   memoryExtractService.init(dbModule);   // pass { run, get, all }
 */

'use strict';

let _db = null;

/**
 * Pass the db helper module ({ run, get, all }) from db/index.js.
 */
function init(db) {
  _db = db;
  console.log('[MemoryExtract] Service initialized');
}

// ─────────────────────────────────────────────────────────────────────────────
// Fact extraction patterns
// Each entry: { re, tpl, category }
//   re       — regex with 1–2 capture groups
//   tpl      — output fact string, $1/$2 = capture groups
//   category — stored as ai_memory.source so facts are queryable by type
// ─────────────────────────────────────────────────────────────────────────────
const FACT_PATTERNS = [
  // ── Name ──────────────────────────────────────────────────────────────────
  {
    re: /\bmy\s+name\s+is\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)/i,
    tpl: 'User name: $1', category: 'auto-name',
  },
  {
    re: /\bcall\s+me\s+([A-Z][a-z]+)/i,
    tpl: 'User name: $1', category: 'auto-name',
  },

  // ── Employer / Role ─────────────────────────────────────────────────────
  {
    // Stops at 'as/in/with/and' so 'I work at Google as a PM in Bangalore' → 'Google'
    re: /\bi\s+work\s+(?:at|for|in)\s+([A-Za-z0-9 &.',-]{2,50}?)(?:\s+(?:as|in|with|and)\b|\s*[,;.]|$)/i,
    tpl: 'User works at: $1', category: 'auto-employer',
  },
  {
    re: /\bmy\s+company\s+is\s+([A-Za-z0-9 &.',-]{2,50})/i,
    tpl: 'User company: $1', category: 'auto-employer',
  },
  {
    // Second capture stops at 'in/as/and' so 'I am a PM at Google in Bangalore' → 'Google'
    re: /\bi(?:'m|\s+am)\s+(?:a\s+|an\s+)?(?:senior\s+|lead\s+|junior\s+|chief\s+)?([A-Za-z ]{3,30}?)\s+at\s+([A-Za-z0-9 &.',-]{2,50}?)(?:\s+(?:in|as|and)\b|\s*[,;.]|$)/i,
    tpl: 'User is $1 at $2', category: 'auto-employer',
  },

  // ── Location ─────────────────────────────────────────────────────────────
  {
    re: /\bi\s+live\s+in\s+([A-Za-z ,]{3,50}?)(?:\s*[,;.]|$)/i,
    tpl: 'User lives in: $1', category: 'auto-location',
  },
  {
    re: /\bi(?:'m|\s+am)\s+(?:from|based\s+in)\s+([A-Za-z ,]{3,50}?)(?:\s*[,;.]|$)/i,
    tpl: 'User is from: $1', category: 'auto-location',
  },
  {
    re: /\bmy\s+city\s+is\s+([A-Za-z ]{3,40})/i,
    tpl: 'User city: $1', category: 'auto-location',
  },

  // ── Relationships / Contacts ─────────────────────────────────────────────
  {
    re: /\bmy\s+(wife|husband|partner|girlfriend|boyfriend|boss|manager|doctor|dad|mom|father|mother|brother|sister|friend)\s+(?:is\s+(?:named?\s+)?)?([A-Z][a-z]+)/i,
    tpl: "User's $1: $2", category: 'auto-contact',
  },
  {
    re: /\bmy\s+phone(?:\s+number)?\s+(?:is|:)\s*([\d\s+\-]{8,18})/i,
    tpl: 'User phone: $1', category: 'auto-contact',
  },

  // ── Preferences / Dislikes ────────────────────────────────────────────────
  {
    re: /\bi\s+(?:really\s+)?(?:prefer|like|love|enjoy)\s+([a-z][a-zA-Z0-9 ]{3,60}?)(?:\s*[,;.]|$)/i,
    tpl: 'User prefers: $1', category: 'auto-pref',
  },
  {
    re: /\bi\s+(?:don\'t|do\s+not|hate|dislike)\s+(?:like\s+)?([a-z][a-zA-Z0-9 ]{3,60}?)(?:\s*[,;.]|$)/i,
    tpl: 'User dislikes: $1', category: 'auto-pref',
  },
  {
    re: /\bmy\s+(?:monthly\s+)?budget\s+(?:is\s+|for\s+[a-z ]{1,20}\s+is\s+)?([\d,₹$]{1,15})/i,
    tpl: 'User budget: $1', category: 'auto-pref',
  },

  // ── Habits / Routines ─────────────────────────────────────────────────────
  {
    re: /\bi\s+usually\s+([a-z][a-zA-Z0-9 ,]{4,80}?)(?:\s*[,;.]|$)/i,
    tpl: 'User usually: $1', category: 'auto-habit',
  },
  {
    re: /\bi\s+(?:always|never)\s+([a-z][a-zA-Z0-9 ,]{4,60}?)(?:\s*[,;.]|$)/i,
    tpl: 'User habit: $1', category: 'auto-habit',
  },

  // ── Demographics ─────────────────────────────────────────────────────────
  {
    re: /\bi(?:'m|\s+am)\s+(\d{1,3})\s+years?\s+old\b/i,
    tpl: 'User age: $1', category: 'auto-profile',
  },
];

// ─────────────────────────────────────────────────────────────────────────────
// PUBLIC: Auto-learn
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Extract structured facts from any user message and persist to ai_memory.
 * Deduplication: same fact won't be written again if stored within last 60 days.
 * Returns count of NEW facts saved (0 = nothing new learned).
 */
function extractAndSave(userMsg) {
  if (!_db || !userMsg || userMsg.length < 5) return 0;
  const { run, get } = _db;
  const now = Math.floor(Date.now() / 1000);
  const dedupeWindow = now - 60 * 86400; // 60 days
  let saved = 0;

  for (const { re, tpl, category } of FACT_PATTERNS) {
    const match = userMsg.match(re);
    if (!match) continue;

    // Build fact by substituting capture groups ($1, $2 ...)
    let fact = tpl;
    for (let i = 1; i < match.length; i++) {
      const cap = (match[i] || '').trim();
      fact = fact.replace(`$${i}`, cap);
    }
    // Clean up any un-substituted placeholders and trailing space
    fact = fact.replace(/\$\d/g, '').trim();
    // Sanity: skip very short or placeholder-heavy results
    if (fact.length < 6) continue;

    try {
      const factLower = fact.toLowerCase();
      const existing = get(
        `SELECT id FROM ai_memory WHERE LOWER(fact) = ? AND created_at > ?`,
        [factLower, dedupeWindow]
      );
      if (existing) continue; // already know this within 60 days

      run(
        `INSERT INTO ai_memory (fact, source, created_at) VALUES (?, ?, ?)`,
        [fact, category, now]
      );
      saved++;
      console.log(`[MemoryExtract] ✓ Learned: "${fact}" (${category})`);
    } catch (_) { /* ignore individual errors */ }
  }

  return saved;
}

/**
 * Look up facts from ai_memory by topic keyword.
 * E.g. recallFacts('name') → "User name: Rahul"
 * Returns newline-joined string, or null if nothing found.
 */
function recallFacts(topic) {
  if (!_db || !topic) return null;
  const { all } = _db;
  try {
    const rows = all(
      `SELECT fact FROM ai_memory WHERE LOWER(fact) LIKE ? ORDER BY created_at DESC LIMIT 5`,
      [`%${topic.toLowerCase()}%`]
    );
    if (!rows || rows.length === 0) return null;
    return rows.map(r => r.fact).join('\n');
  } catch (_) {
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// PUBLIC: Persistent Q+A cache (query_answers table)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Normalize a query for consistent cache key matching.
 * Strips punctuation, lowercases, collapses whitespace.
 */
function _norm(q) {
  return q.toLowerCase().trim().replace(/[^a-z0-9\s₹]/g, '').replace(/\s+/g, ' ');
}

/**
 * Persist a Q+A pair in query_answers so it survives app restarts.
 *
 * @param {string} query     - original user question
 * @param {string} answer    - ARIA's answer (text only, no objects)
 * @param {string} source    - 'sql' | 'agent' | 'memory-recall'
 * @param {number} ttlSecs   - how long this answer stays valid
 *                             sql → 3600 (1h), agent → 3600, memory-recall → 604800 (7d)
 */
function saveAnswer(query, answer, source = 'sql', ttlSecs = 3600) {
  if (!_db || !query || !answer) return;
  const { run, get } = _db;
  const norm = _norm(query);
  const now = Math.floor(Date.now() / 1000);
  const answerStr = String(answer).substring(0, 4000);

  try {
    const existing = get(`SELECT id FROM query_answers WHERE query_norm = ?`, [norm]);
    if (existing) {
      // Refresh: update answer + bump hit count + reset TTL clock
      run(
        `UPDATE query_answers SET answer_text=?, source=?, ttl_secs=?, last_hit_at=?, hit_count=hit_count+1 WHERE query_norm=?`,
        [answerStr, source, ttlSecs, now, norm]
      );
    } else {
      run(
        `INSERT INTO query_answers (query_norm, query_text, answer_text, source, ttl_secs, created_at, last_hit_at) VALUES (?,?,?,?,?,?,?)`,
        [norm, query.substring(0, 500), answerStr, source, ttlSecs, now, now]
      );
    }
  } catch (_) { /* query_answers table may not exist yet in older DBs — silently skip */ }
}

/**
 * Look up a valid (non-expired) persisted answer for a query.
 * Returns { answer_text, source, hit_count } or null.
 */
function recallAnswer(query) {
  if (!_db || !query) return null;
  const { get, run } = _db;
  const norm = _norm(query);
  const now = Math.floor(Date.now() / 1000);

  try {
    const row = get(
      `SELECT answer_text, source, hit_count FROM query_answers WHERE query_norm = ? AND (created_at + ttl_secs) > ?`,
      [norm, now]
    );
    if (!row) return null;
    // Bump hit counter silently
    try { run(`UPDATE query_answers SET hit_count=hit_count+1, last_hit_at=? WHERE query_norm=?`, [now, norm]); } catch (_) {}
    return row;
  } catch (_) {
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// PUBLIC: Dedup-aware explicit ai_memory write
// (use this wherever main.js does an explicit INSERT INTO ai_memory)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Write an explicit fact to ai_memory only if not already stored in last 30 days.
 * Safer replacement for bare run('INSERT INTO ai_memory ...').
 */
function saveExplicitFact(fact, source = 'chat') {
  if (!_db || !fact) return;
  const { run, get } = _db;
  const now = Math.floor(Date.now() / 1000);
  try {
    const factLower = fact.toLowerCase().trim();
    const existing = get(
      `SELECT id FROM ai_memory WHERE LOWER(fact) = ? AND created_at > ?`,
      [factLower, now - 30 * 86400]
    );
    if (existing) return; // already stored recently
    run(`INSERT INTO ai_memory (fact, source, created_at) VALUES (?, ?, ?)`, [fact.trim(), source, now]);
  } catch (_) {}
}

module.exports = { init, extractAndSave, recallFacts, saveAnswer, recallAnswer, saveExplicitFact };
