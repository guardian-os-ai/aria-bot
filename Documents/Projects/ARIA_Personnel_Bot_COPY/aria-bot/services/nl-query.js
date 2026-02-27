/**
 * services/nl-query.js — Intelligent Natural Language Query Engine
 *
 * Architecture: PARSE FIRST, ROUTE SECOND
 *   1. extractQueryIntent(msg) → { domain, action, params } — semantic extraction
 *   2. Route to handler based on structured intent, NOT keyword match
 *   3. Handlers receive pre-extracted params (category, merchant, timeRange, etc.)
 *
 * Domains: money, subscriptions, email, tasks, focus, habits, calendar, stats
 * Actions: list, summary, total, compare, last, count, search, breakdown
 */

'use strict';

const path = require('path');
const { get, all } = require(path.join(__dirname, '..', 'db'));
const intelligence = require(path.join(__dirname, 'intelligence'));

// ─────────────────────────────────────────────────────────────────────────────
// Dynamic Entities (loaded from DB + base list, cached 5 min)
// ─────────────────────────────────────────────────────────────────────────────

// getMerchants() returns sorted (longest first) array of all known merchants
// getCategories() returns array of all known category names
// resolveCategory(input) maps synonyms: "dining" → "food", "commute" → "travel"
const { getMerchants, getCategories, resolveCategory, CATEGORY_SYNONYMS } = intelligence;
const { enrichResult } = require(path.join(__dirname, 'analysis-engine'));

const MONTHS = {
  jan: 0, january: 0, feb: 1, february: 1, mar: 2, march: 2,
  apr: 3, april: 3, may: 4, jun: 5, june: 5,
  jul: 6, july: 6, aug: 7, august: 7, sep: 8, september: 8,
  oct: 9, october: 9, nov: 10, november: 10, dec: 11, december: 11
};

// ─────────────────────────────────────────────────────────────────────────────
// STEP 1: Semantic Parameter Extraction
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Extract structured intent from natural language query.
 * Returns: { domain, action, params: { merchant, category, timeRange, limit, comparison, searchTerm } }
 */
function extractQueryIntent(msg) {
  const q = (msg || '').trim();
  const low = q.toLowerCase();
  const words = low.split(/\s+/);

  const result = {
    domain: null,     // money | subscriptions | email | tasks | focus | habits | calendar | stats
    action: null,     // list | summary | total | compare | last | count | search | breakdown | trend
    params: {
      merchant: null,
      merchants: [],   // ALL matched merchants — "uber vs rapido", "swiggy or zomato" — dynamic from DB
      category: null,
      categories: [],  // ALL matched categories — enables "food vs travel" comparison — dynamic from DB
      cardQuery: false, // "which card for fuel" → GROUP BY payment_method
      multiPeriod: null, // "compare last 3 months" → [{start,end,label}...] per-period breakdown
      timeRange: null,  // { start, end } unix timestamps
      limit: null,
      comparison: false,
      searchTerm: null,
      raw: q
    }
  };

  // Dynamic merchant extraction — loaded from DB + base list, sorted longest-first.
  // NO hardcoding. Any merchant in transactions DB is auto-detected.
  // "uber vs rapido", "swiggy or zomato" — merchants[] collects ALL matches.
  const knownMerchants = getMerchants();
  for (const m of knownMerchants) {
    const mRegex = new RegExp(`\\b${m.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
    if (mRegex.test(low)) {
      if (!result.params.merchant) result.params.merchant = m; // primary = longest/first
      if (!result.params.merchants.includes(m)) result.params.merchants.push(m);
    }
  }
  // 2+ merchants found → auto-enable comparison. Zero hardcoding.
  if (result.params.merchants.length >= 2) result.params.comparison = true;

  // ── Raw "A vs B" fallback extractor ──
  // Runs AFTER the DB-lookup loop. Catches unknown merchants/services not yet in DB.
  // e.g. "BluSmart vs Rapido" — BluSmart has no transactions yet, so the DB loop misses it.
  // We extract both sides of vs/or/versus and try SQL LIKE anyway.
  // If 0 data found for a side, we say "No data for X" — never silently wrong-route.
  // Also resolves categories: "rides vs food" → categories if both are synonyms.
  const _vsStopWords = new Set([
    'this', 'last', 'the', 'my', 'that', 'month', 'week', 'year', 'day',
    'how', 'much', 'did', 'is', 'was', 'been', 'am', 'spending', 'spend',
    'more', 'less', 'better', 'cheaper', 'expensive', 'which', 'what',
    'than', 'total', 'cost', 'costs', 'paid', 'me', 'i', 'do', 'should'
  ]);
  if (/\bvs\.?\b|\bversus\b|\bagainst\b/.test(low) && result.params.merchants.length < 2) {
    // Match: "word(s) vs word(s)" — handles multi-word like "google pay vs phonepe"
    const rawVs = low.match(/\b([\w]+(?:\s+[\w]+)?)\s+(?:vs\.?|versus|against)\s+([\w]+(?:\s+[\w]+)?)/);
    if (rawVs) {
      const clean = (s) => s.split(/\s+/).filter(w => !_vsStopWords.has(w)).join(' ').trim();
      const left  = clean(rawVs[1]);
      const right = clean(rawVs[2]);
      if (left && right && left !== right) {
        // Try category resolution first — "food vs travel" → categories[]
        const leftCat  = resolveCategory(left);
        const rightCat = resolveCategory(right);
        if (leftCat && rightCat && leftCat !== rightCat) {
          if (!result.params.categories.includes(leftCat))  result.params.categories.push(leftCat);
          if (!result.params.categories.includes(rightCat)) result.params.categories.push(rightCat);
          if (!result.params.category) result.params.category = leftCat;
        } else {
          // Unknown merchants — push raw strings. handleMerchantComparison uses LIKE %X%
          // SQL will find whatever data exists; zero data → informative "no data" message.
          if (result.params.merchants.length === 0) {
            result.params.merchants.push(left, right);
            result.params.merchant = left;
          } else if (result.params.merchants.length === 1) {
            // One side already matched by DB; raw-extract the other side
            const known = result.params.merchants[0];
            const other = (known === left || left.includes(known) || known.includes(left.split(' ')[0])) ? right : left;
            if (other && !result.params.merchants.includes(other)) result.params.merchants.push(other);
          }
        }
      }
    }
  }

  // ── Extract category (DYNAMIC: with synonym resolution) ──
  // "spend on food" / "dining expenses" / "commute costs" → resolved via synonyms
  const knownCategories = getCategories(); // dynamic from DB
  const allSynonymKeys = Object.keys(CATEGORY_SYNONYMS);

  // First try: "on/for/in [word]" pattern
  const catMatch = low.match(/(?:on|for|in|under|category)\s+(\w+)/);
  if (catMatch) {
    const candidate = catMatch[1].toLowerCase();
    const resolved = resolveCategory(candidate);
    if (resolved) {
      result.params.category = resolved;
    }
  }

  // Second try: any category or synonym word + spending context
  if (!result.params.category) {
    // Check canonical categories first
    for (const cat of knownCategories) {
      const catRegex = new RegExp(`\\b${cat}\\b`, 'i');
      if (catRegex.test(low) && low.match(/spend|expense|cost|bill|paid|bought|order|transaction|budget|money|total|summary|breakdown/i)) {
        result.params.category = cat;
        break;
      }
    }
  }

  // Third try: check synonym words in the message
  if (!result.params.category) {
    for (const syn of allSynonymKeys) {
      const synRegex = new RegExp(`\\b${syn.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
      if (synRegex.test(low)) {
        const resolved = CATEGORY_SYNONYMS[syn];
        // Only assign if there's a spending context or the synonym is very specific
        if (low.match(/spend|expense|cost|bill|paid|bought|order|transaction|budget|money|total|summary|breakdown|how\s+much/i)
            || ['dining', 'commute', 'streaming', 'medicine', 'gym', 'clothes', 'petrol', 'grocery'].includes(syn)) {
          result.params.category = resolved;
          break;
        }
      }
    }
  }

  // ── Multi-category extraction ("food vs travel", "compare shopping and entertainment") ──
  // Works for ANY categories stored in DB. Zero hardcoding — new categories auto-detected.
  for (const cat of knownCategories) {
    const catRegex = new RegExp(`\\b${cat}\\b`, 'i');
    if (catRegex.test(low)) {
      if (!result.params.categories.includes(cat)) result.params.categories.push(cat);
    }
  }
  for (const syn of allSynonymKeys) {
    const synRegex = new RegExp(`\\b${syn.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\$&')}\\b`, 'i');
    if (synRegex.test(low)) {
      const resolved = CATEGORY_SYNONYMS[syn];
      if (resolved && !result.params.categories.includes(resolved)) {
        result.params.categories.push(resolved);
      }
    }
  }
  if (result.params.categories.length >= 2) {
    result.params.comparison = true;
    if (!result.params.category) result.params.category = result.params.categories[0];
  }

  // ── Card/payment method query detection ──
  // "which card", "what card", "on hdfc", "axis credit card spend"
  // Covers named banks (hdfc/icici/sbi/axis) and generic "which card" phrasing
  if (/which\s+card|what\s+card|on\s+which\s+card|card.*(?:use|pay|spent|spend)|(?:paid|pay).*card|\bhdfc\b|\bicici\b|\bsbi\b|\baxis\b|\bkotak\b|\bamex\b|\bciti\b|\brbl\b|\bindus(?:ind)?\b/.test(low)) {
    result.params.cardQuery = true;
  }

  // ── Extract time range ──
  result.params.timeRange = parseTimeRange(low);

  // ── Extract limit ──
  // IMPORTANT: Don't match "last N days/weeks/months" — that's a time range, not a limit
  // Use a two-step approach: match "top/last N", then reject if followed by time unit
  const limitCandidate = low.match(/(?:top|last|recent|latest|first)\s+(\d+)/i);
  if (limitCandidate) {
    const afterNum = low.substring(limitCandidate.index + limitCandidate[0].length).trim();
    if (!/^(?:day|week|month|year|hour|min)/i.test(afterNum)) {
      result.params.limit = parseInt(limitCandidate[1], 10);
    }
  }
  if (/\b(?:last|latest|most recent|recent)\s+(?:order|transaction|purchase|payment|spend)\b/.test(low)) {
    result.params.limit = result.params.limit || 1;
  }
  if (/\btop\s+\d+\b/.test(low)) {
    // "top 5 spends" — already handled by limitMatch
  }

  // ── Detect comparison intent ──
  if (/\bcompar|vs\.?\b|\bversus\b|\bagainst\b|than\s+last|to\s+last|month\s+over\s+month|week\s+over\s+week/.test(low)) {
    result.params.comparison = true;
  }

  // ── Multi-period breakdown: "compare last 3 months" / "last 6 months food trend" ──
  // comparison=true + last N months/weeks → per-period [{start,end,label}] array
  // NOT a single flattened range — each period rendered separately with delta.
  const multiPeriodMatch = low.match(/\blast\s+(\d+)\s+(month|week)s?\b/);
  if (multiPeriodMatch && result.params.comparison) {
    const n = parseInt(multiPeriodMatch[1], 10);
    const unit = multiPeriodMatch[2];
    if (n >= 2 && n <= 12) {
      const periods = [];
      const nowDate = new Date();
      for (let i = n - 1; i >= 0; i--) {
        let pStart, pEnd;
        if (unit === 'month') {
          pStart = new Date(nowDate.getFullYear(), nowDate.getMonth() - i, 1);
          pEnd   = new Date(nowDate.getFullYear(), nowDate.getMonth() - i + 1, 0, 23, 59, 59, 999);
        } else {
          const refMon = new Date(nowDate);
          const dow = refMon.getDay();
          refMon.setDate(refMon.getDate() - (dow === 0 ? 6 : dow - 1) - i * 7);
          refMon.setHours(0, 0, 0, 0);
          pStart = new Date(refMon);
          pEnd   = new Date(refMon.getTime() + 6 * 86400000 + 86399999);
        }
        const label = unit === 'month'
          ? pStart.toLocaleString('default', { month: 'short', year: '2-digit' })
          : `W-${i === 0 ? 'now' : i} ${pStart.toLocaleString('default', { month: 'short' })}`;
        periods.push({
          start: Math.floor(pStart.getTime() / 1000),
          end:   Math.floor(pEnd.getTime()   / 1000),
          label
        });
      }
      result.params.multiPeriod = periods;
    }
  }

  // ── Determine domain ──
  // Priority: most specific patterns first

  // Subscriptions domain
  if (/\bsubscri|recurring\s+(?:pay|charge|bill)|renew|auto.?(?:pay|debit|charge)|proper\s+sub/.test(low)) {
    result.domain = 'subscriptions';
  }
  // Insurance domain (subset of money but specialized)
  else if (/\binsurance|premium|policy|lic\b|claim\b/.test(low)) {
    result.domain = 'money';
    result.params.category = result.params.category || 'insurance';
  }
  // Email domain
  else if (/\bemail|mail|inbox|unread|sender|from\s+\w+.*email|newsletter|spam/.test(low)) {
    result.domain = 'email';
  }
  // Task domain
  else if (/\btask|reminder|todo|to.?do|overdue|deadline|pending\s+task|due\s+(?:today|this|next)/.test(low)) {
    result.domain = 'tasks';
  }
  // Focus domain
  else if (/\bfocus\s+(?:time|session|hour|minute|today|this|last)|deep\s+work|pomodoro/.test(low)) {
    result.domain = 'focus';
  }
  // Habits domain
  else if (/\bhabit|streak|daily\s+(?:check|log|routine)|routine\s+(?:today|this)/.test(low)) {
    result.domain = 'habits';
  }
  // Calendar domain
  else if (/\bmeeting|calendar|schedule|agenda|appointment|event|free\s+(?:time|slot)/.test(low)) {
    result.domain = 'calendar';
  }
  // Money domain — most common, check last
  else if (/\bspend|spent|expense|cost|paid|bill|budget|money|balanc|earn|income|financ|transaction|payment|order|bought|purchase|emi\b|loan\b/.test(low)) {
    result.domain = 'money';
  }
  // Stats / summary — BUT only if no merchant detected (merchant queries → money)
  else if (!result.params.merchant && /\bsummary|overview|report|stats|statistics|dashboard|breakdown|classify|categori/.test(low)) {
    result.domain = 'stats';
  }

  // ── If we have a merchant but no domain, assume money ──
  if (result.params.merchant && !result.domain) {
    result.domain = 'money';
  }

  // ── If comparison intent but no domain, assume money (most common comparison) ──
  if (result.params.comparison && !result.domain) {
    result.domain = 'money';
  }

  // ── If category was extracted but no domain, assume money ──
  if (result.params.category && !result.domain) {
    result.domain = 'money';
  }

  // ── Determine action ──
  if (result.params.comparison) {
    result.action = 'compare';
  } else if (/\bhow\s+much|total|sum\b|amount\b/.test(low)) {
    result.action = 'total';
  } else if (/\bbreakdown|classify|categori|split\s+by|group\s+by/.test(low)) {
    result.action = 'breakdown';
  } else if (/\blast\s+(?:order|transaction|purchase|payment|time)|most\s+recent|when\s+(?:did|was).*(?:last|recent)/.test(low)) {
    result.action = 'last';
  } else if (/\btrend|pattern|over\s+time|month\s+by\s+month|week\s+by\s+week|growing|increasing|decreasing/.test(low)) {
    result.action = 'trend';
  } else if (/\bhow\s+many|count\b|number\s+of/.test(low)) {
    result.action = 'count';
  } else if (/\bsummary|overview|report|stats|quick\s+look|tell\s+me\s+about|show.*about|what.*about/.test(low)) {
    result.action = 'summary';
  } else if (/\blist|show|display|all\s+my|my\s+(?:recent|all)/.test(low)) {
    result.action = 'list';
  } else if (/\bsearch|find|look\s+for|any.*about|related\s+to/.test(low)) {
    result.action = 'search';
  } else if (/\bwho\s+(?:email|send|mail)|top\s+sender|most\s+(?:email|mail)/.test(low)) {
    result.action = 'count';
  } else {
    // Default action based on domain
    result.action = 'summary';
  }

  return result;
}

// ─────────────────────────────────────────────────────────────────────────────
// Time Range Parser
// ─────────────────────────────────────────────────────────────────────────────

function parseTimeRange(low) {
  const now = new Date();

  // "last N days/weeks/months"
  const relMatch = low.match(/\blast\s+(\d+)\s+(day|week|month|year)s?\b/);
  if (relMatch) {
    const n = parseInt(relMatch[1], 10);
    const unit = relMatch[2];
    const start = new Date(now);
    if (unit === 'day') start.setDate(start.getDate() - n);
    else if (unit === 'week') start.setDate(start.getDate() - n * 7);
    else if (unit === 'month') start.setMonth(start.getMonth() - n);
    else if (unit === 'year') start.setFullYear(start.getFullYear() - n);
    return { start: Math.floor(start.getTime() / 1000), end: Math.floor(now.getTime() / 1000) };
  }

  // "this week" / "this month" / "this year"
  const thisMatch = low.match(/\bthis\s+(week|month|year)\b/);
  if (thisMatch) {
    const unit = thisMatch[1];
    const start = new Date(now);
    if (unit === 'week') {
      const day = start.getDay();
      const diff = day === 0 ? 6 : day - 1; // Monday start
      start.setDate(start.getDate() - diff);
    } else if (unit === 'month') {
      start.setDate(1);
    } else if (unit === 'year') {
      start.setMonth(0, 1);
    }
    start.setHours(0, 0, 0, 0);
    return { start: Math.floor(start.getTime() / 1000), end: Math.floor(now.getTime() / 1000) };
  }

  // "last week" / "last month" / "last year" (without number)
  const lastUnitMatch = low.match(/\blast\s+(week|month|year)\b/);
  if (lastUnitMatch && !relMatch) {
    const unit = lastUnitMatch[1];
    const end = new Date(now);
    const start = new Date(now);
    if (unit === 'week') {
      const day = end.getDay();
      const diff = day === 0 ? 6 : day - 1;
      end.setDate(end.getDate() - diff); // This Monday
      end.setHours(0, 0, 0, 0);
      start.setTime(end.getTime());
      start.setDate(start.getDate() - 7); // Last Monday
    } else if (unit === 'month') {
      end.setDate(1);
      end.setHours(0, 0, 0, 0);
      start.setTime(end.getTime());
      start.setMonth(start.getMonth() - 1);
    } else if (unit === 'year') {
      end.setMonth(0, 1);
      end.setHours(0, 0, 0, 0);
      start.setTime(end.getTime());
      start.setFullYear(start.getFullYear() - 1);
    }
    return { start: Math.floor(start.getTime() / 1000), end: Math.floor(end.getTime() / 1000) };
  }

  // "today"
  if (/\btoday\b/.test(low)) {
    const start = new Date(now);
    start.setHours(0, 0, 0, 0);
    return { start: Math.floor(start.getTime() / 1000), end: Math.floor(now.getTime() / 1000) };
  }

  // "yesterday"
  if (/\byesterday\b/.test(low)) {
    const start = new Date(now);
    start.setDate(start.getDate() - 1);
    start.setHours(0, 0, 0, 0);
    const end = new Date(start);
    end.setHours(23, 59, 59, 999);
    return { start: Math.floor(start.getTime() / 1000), end: Math.floor(end.getTime() / 1000) };
  }

  // Named month: "in january" / "january spending" / "for march"
  // CRITICAL: Use word boundaries to avoid "march" inside "summary" etc.
  const monthNames = Object.keys(MONTHS);
  for (const mName of monthNames) {
    const mRegex = new RegExp(`\\b${mName}\\b`, 'i');
    if (mRegex.test(low)) {
      const monthIdx = MONTHS[mName];
      const year = monthIdx > now.getMonth() ? now.getFullYear() - 1 : now.getFullYear();
      const start = new Date(year, monthIdx, 1);
      const end = new Date(year, monthIdx + 1, 0, 23, 59, 59);
      return { start: Math.floor(start.getTime() / 1000), end: Math.floor(end.getTime() / 1000) };
    }
  }

  // No time range detected — default to last 30 days for money queries
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// STEP 2: Query Router — Routes based on extracted intent, NOT keyword matching
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Process a natural language query.
 * Can also accept pre-extracted params from Python sidecar:
 *   processQuery(msg, { category: 'food' })
 */
function processQuery(msg, externalParams) {
  const intent = extractQueryIntent(msg);

  // Merge external params (e.g. from Python sidecar) if provided
  if (externalParams) {
    if (externalParams.category && !intent.params.category) {
      intent.params.category = externalParams.category;
    }
    if (externalParams.merchant && !intent.params.merchant) {
      intent.params.merchant = externalParams.merchant;
    }
  }

  console.log(`[NL-Query] Intent: domain=${intent.domain}, action=${intent.action}, merchant=${intent.params.merchant}, category=${intent.params.category}, timeRange=${JSON.stringify(intent.params.timeRange)}, limit=${intent.params.limit}`);

  if (!intent.domain) {
    return { answer: null, type: null };
  }

  try {
    switch (intent.domain) {
      case 'money':
        return enrichResult(handleMoney(intent), intent);
      case 'subscriptions':
        return handleSubscriptions(intent);
      case 'email':
        return handleEmail(intent);
      case 'tasks':
        return handleTasks(intent);
      case 'focus':
        return handleFocus(intent);
      case 'habits':
        return handleHabits(intent);
      case 'calendar':
        return handleCalendar(intent);
      case 'stats':
        return handleStats(intent);
      default:
        return { answer: null, type: null };
    }
  } catch (err) {
    console.error('[NL-Query] Handler error:', err);
    return { answer: `Error processing query: ${err.message}`, type: 'error' };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// SQL Helpers
// ─────────────────────────────────────────────────────────────────────────────

function fmt(amount) {
  if (amount == null) return '₹0';
  const n = typeof amount === 'string' ? parseFloat(amount.replace(/[₹,]/g, '')) : amount;
  if (isNaN(n)) return amount;
  return '₹' + Math.round(n).toLocaleString('en-IN');
}

function fmtDate(unix) {
  if (!unix) return 'N/A';
  return new Date(unix * 1000).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
}

function fmtDateShort(unix) {
  if (!unix) return '';
  return new Date(unix * 1000).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
}

function defaultTimeRange() {
  const now = Math.floor(Date.now() / 1000);
  const thirtyDaysAgo = now - 30 * 86400;
  return { start: thirtyDaysAgo, end: now };
}

function timeRangeLabel(tr) {
  if (!tr) return 'last 30 days';
  const start = new Date(tr.start * 1000);
  const end = new Date(tr.end * 1000);
  const now = new Date();

  // Check if it's "this month"
  if (start.getDate() === 1 && start.getMonth() === now.getMonth() && start.getFullYear() === now.getFullYear()) {
    return start.toLocaleString('en-IN', { month: 'long', year: 'numeric' });
  }

  // Check if it's a specific month
  if (start.getDate() === 1 && end.getDate() >= 28) {
    return start.toLocaleString('en-IN', { month: 'long', year: 'numeric' });
  }

  const days = Math.round((tr.end - tr.start) / 86400);
  if (days <= 1) return 'today';
  if (days <= 2) return 'yesterday';
  if (days <= 7) return 'this week';
  return `last ${days} days`;
}

// ─────────────────────────────────────────────────────────────────────────────
// HANDLER: Money (spend_log + transactions)
// ─────────────────────────────────────────────────────────────────────────────

function handleMoney(intent) {
  const { action, params } = intent;
  const { merchant, category, limit, comparison } = params;
  const tr = params.timeRange || defaultTimeRange();

  // ── Multi-period breakdown: "compare last 3 months", "food last 6 months" ──
  // Triggered when comparison intent + "last N months/weeks" detected.
  // Each period rendered separately — NOT a flat range sum.
  if (params.multiPeriod && params.multiPeriod.length >= 2) {
    return handleMultiPeriodBreakdown(category, merchant, params.multiPeriod);
  }

  // ── Multi-category comparison: "food vs travel", "compare shopping vs entertainment" ──
  // Dynamic: categories[] built from DB, NOT from any hardcoded list.
  if (params.categories && params.categories.length >= 2) {
    return handleCategoryComparison(params.categories, tr);
  }

  // ── Card-level analysis: "which card did I use for fuel", "HDFC vs ICICI spend" ──
  // Groups by payment_method column in transactions table.
  if (params.cardQuery) {
    return handleCardAnalysis(category, tr);
  }

  // ── Multi-merchant comparison: "uber vs rapido", "swiggy or zomato" ──
  // Dynamic: merchants[] built from DB — any pair the user asks about. Zero hardcoding.
  if (params.merchants && params.merchants.length >= 2) {
    return handleMerchantComparison(params.merchants, tr);
  }

  // ── Single merchant queries ──
  if (merchant) {
    return handleMerchantQuery(merchant, action, tr, limit);
  }

  // ── Category-specific queries ──
  if (category) {
    return handleCategoryQuery(category, action, tr, limit);
  }

  // ── Route by action ──
  switch (action) {
    case 'compare':
      return handleMoneyCompare(tr);
    case 'breakdown':
      return handleMoneyBreakdown(tr);
    case 'total':
      return handleMoneyTotal(tr);
    case 'last':
      return handleMoneyRecent(limit || 5);
    case 'trend':
      return handleMoneyTrend(tr);
    case 'list':
      return handleMoneyList(tr, limit || 15);
    case 'summary':
    default:
      return handleMoneySummary(tr);
  }
}

// ── Multi-merchant comparison sub-handler ──

function handleMerchantComparison(merchants, tr) {
  const period = timeRangeLabel(tr);
  const results = merchants.map(m => {
    const like = `%${m}%`;
    const tx = get(
      `SELECT SUM(amount) as t, COUNT(*) as c FROM transactions
       WHERE (LOWER(merchant) LIKE ? OR LOWER(description) LIKE ?) AND timestamp BETWEEN ? AND ?`,
      [like, like, tr.start, tr.end]
    );
    const sl = get(
      `SELECT SUM(amount_raw) as t, COUNT(*) as c FROM spend_log
       WHERE LOWER(description) LIKE ? AND occurred_at BETWEEN ? AND ?`,
      [like, tr.start, tr.end]
    );
    return {
      name: m.charAt(0).toUpperCase() + m.slice(1),
      total: (tx?.t || 0) + (sl?.t || 0),
      count: (tx?.c || 0) + (sl?.c || 0)
    };
  }).sort((a, b) => b.total - a.total);

  const lines = [`**${results.map(r => r.name).join(' vs ')}** — ${period}:\n`];
  for (const r of results) {
    lines.push(`• ${r.name}: **${fmt(r.total)}** (${r.count} transaction${r.count !== 1 ? 's' : ''})`);
  }

  if (results.every(r => r.total === 0)) {
    // Neither merchant has any data at all
    lines.push(`\n⚠️ No transactions found for ${results.map(r => r.name).join(' or ')} in ${period}.`);
    lines.push(`_ARIA learns from your bank/app emails. If you've used these services, forward a transaction email to add data._`);
  } else if (results.length >= 2 && results[0].total > 0 && results[1].total > 0) {
    const diff = results[0].total - results[1].total;
    const pct  = Math.round((diff / results[1].total) * 100);
    lines.push(`\n→ **${results[0].name}** is ${fmt(diff)} (${pct}%) higher`);
  } else if (results[0].total > 0 && results[1]?.total === 0) {
    lines.push(`\n⚠️ No transactions found for **${results[1]?.name}** in ${period} — either no data yet, or the name differs in your emails.`);
  }

  return { answer: lines.join('\n'), type: 'money', data: { merchants: results, period } };
}

// ── Multi-category comparison sub-handler ──
// "food vs travel", "compare shopping and entertainment this month"
// Dynamic: works for ANY two categories from DB + synonyms — never hardcoded.
function handleCategoryComparison(categories, tr) {
  const period = timeRangeLabel(tr);
  const results = categories.map(cat => {
    const tx = get(
      `SELECT COALESCE(SUM(amount),0) as t, COUNT(*) as c FROM transactions
       WHERE LOWER(category) = ? AND timestamp BETWEEN ? AND ?`,
      [cat.toLowerCase(), tr.start, tr.end]
    );
    const sl = get(
      `SELECT COALESCE(SUM(amount_raw),0) as t, COUNT(*) as c FROM spend_log
       WHERE LOWER(category) = ? AND occurred_at BETWEEN ? AND ?`,
      [cat.toLowerCase(), tr.start, tr.end]
    );
    // Top merchant in this category for extra context
    const topMerch = get(
      `SELECT merchant, SUM(amount) as total FROM transactions
       WHERE LOWER(category) = ? AND timestamp BETWEEN ? AND ?
       AND merchant IS NOT NULL GROUP BY merchant ORDER BY total DESC LIMIT 1`,
      [cat.toLowerCase(), tr.start, tr.end]
    );
    return {
      name: cat.charAt(0).toUpperCase() + cat.slice(1),
      total: (tx?.t || 0) + (sl?.t || 0),
      count: (tx?.c || 0) + (sl?.c || 0),
      topMerchant: topMerch?.merchant || null
    };
  }).sort((a, b) => b.total - a.total);

  const lines = [`**${results.map(r => r.name).join(' vs ')}** — ${period}:\n`];
  for (const r of results) {
    const topNote = r.topMerchant ? ` (top: ${r.topMerchant})` : '';
    lines.push(`• ${r.name}: **${fmt(r.total)}** across ${r.count} txn${r.count !== 1 ? 's' : ''}${topNote}`);
  }

  if (results.every(r => r.total === 0)) {
    lines.push(`\n⚠️ No spending data found for ${results.map(r => r.name).join(' or ')} in ${period}.`);
    lines.push(`_These might be new categories or named differently in your transactions._`);
  } else if (results.length >= 2 && results[0].total > 0 && results[1].total > 0) {
    const diff = results[0].total - results[1].total;
    const pct  = Math.round((diff / results[1].total) * 100);
    lines.push(`\n→ You spend **${pct}% more** on ${results[0].name} than ${results[1].name} (${fmt(diff)} difference)`);
  } else if (results[0].total > 0) {
    const empty = results.find(r => r.total === 0);
    lines.push(`\n⚠️ No data for **${empty?.name}** in ${period} — either no transactions logged yet, or categorised differently.`);
  }
  return { answer: lines.join('\n'), type: 'money', data: { categories: results, period } };
}

// ── Card / payment method analysis ──
// "which card did I use most for fuel", "HDFC vs ICICI spend last month"
// Groups by payment_method column in transactions (added via migration).
function handleCardAnalysis(category, tr) {
  const period = timeRangeLabel(tr);
  const catParam = category ? [category.toLowerCase()] : [];
  const catWhere = category ? `AND LOWER(category) = ?` : '';
  const rows = all(
    `SELECT COALESCE(payment_method, 'Unknown') as card,
            ROUND(SUM(amount), 2) as total,
            COUNT(*) as cnt
     FROM transactions
     WHERE timestamp BETWEEN ? AND ? ${catWhere}
       AND payment_method IS NOT NULL AND TRIM(payment_method) != ''
     GROUP BY payment_method
     ORDER BY total DESC`,
    [tr.start, tr.end, ...catParam]
  );

  if (rows.length === 0) {
    const catLabel = category ? ` **${category}**` : '';
    return {
      answer: `No card data found for${catLabel} in ${period}.\n\n_Tip: When logging transactions, include the card/payment method so ARIA can track per-card spending._`,
      type: 'money', data: { category, period }
    };
  }

  const catLabel = category ? ` **${category.charAt(0).toUpperCase() + category.slice(1)}**` : '';
  const lines = [`**Card Breakdown**${catLabel} — ${period}:\n`];
  for (const r of rows) {
    lines.push(`• ${r.card}: **${fmt(r.total)}** (${r.cnt} txn${r.cnt !== 1 ? 's' : ''})`);
  }
  lines.push(`\n→ **${rows[0].card}** used the most${catLabel ? ` for${catLabel}` : ''} (${fmt(rows[0].total)})`);
  return { answer: lines.join('\n'), type: 'money', data: { cards: rows, category, period } };
}

// ── Multi-period breakdown: "compare last 3 months food", "Swiggy last 6 months" ──
// periods = [{start, end, label}] built in extractQueryIntent.
// Renders a bar chart representation + delta vs previous period.
function handleMultiPeriodBreakdown(category, merchant, periods) {
  const subjectLabel = category
    ? `**${category.charAt(0).toUpperCase() + category.slice(1)}** spending`
    : merchant
      ? `**${merchant.charAt(0).toUpperCase() + merchant.slice(1)}** spend`
      : '**Total spending**';

  const catWhere  = category ? `AND LOWER(category) = '${category.toLowerCase().replace(/'/g, "''")}'` : '';
  const merchLike = merchant ? merchant.toLowerCase().replace(/'/g, "''"): '';
  const merchWhere = merchant
    ? `AND (LOWER(merchant) LIKE '%${merchLike}%' OR LOWER(description) LIKE '%${merchLike}%')`
    : '';

  const results = periods.map(p => {
    const tx = get(
      `SELECT COALESCE(SUM(amount),0) as t, COUNT(*) as c FROM transactions
       WHERE timestamp BETWEEN ? AND ? ${catWhere} ${merchWhere}`,
      [p.start, p.end]
    );
    const sl = get(
      `SELECT COALESCE(SUM(amount_raw),0) as t, COUNT(*) as c FROM spend_log
       WHERE occurred_at BETWEEN ? AND ? ${catWhere} ${merchWhere}`,
      [p.start, p.end]
    );
    return {
      label:  p.label,
      total:  (tx?.t || 0) + (sl?.t || 0),
      count:  (tx?.c || 0) + (sl?.c || 0)
    };
  });

  const maxTotal = Math.max(...results.map(r => r.total), 1);
  const lines = [`${subjectLabel} — period comparison:\n`];
  for (const r of results) {
    const bar = '█'.repeat(Math.max(1, Math.round((r.total / maxTotal) * 10)));
    lines.push(`• **${r.label}**: ${fmt(r.total)} ${bar} (${r.count} txn${r.count !== 1 ? 's' : ''})`);
  }

  // Delta vs immediately previous period
  if (results.length >= 2) {
    const last = results[results.length - 1];
    const prev = results[results.length - 2];
    if (prev.total > 0) {
      const delta    = last.total - prev.total;
      const deltaPct = Math.round((delta / prev.total) * 100);
      const arrow    = delta > 0 ? '↑' : '↓';
      lines.push(`\n${arrow} Latest vs prev period: **${deltaPct > 0 ? '+' : ''}${deltaPct}%** (${delta >= 0 ? '+' : ''}${fmt(Math.abs(delta))})`);
    }
  }

  const overallTotal  = results.reduce((s, r) => s + r.total, 0);
  const avgPerPeriod  = overallTotal / results.length;
  lines.push(`**Overall**: ${fmt(overallTotal)} total | avg ${fmt(avgPerPeriod)}/period`);

  return { answer: lines.join('\n'), type: 'money', data: { periods: results, subjectLabel } };
}

// ── Merchant sub-handler ──

function handleMerchantQuery(merchant, action, tr, limit) {
  const merchantLike = `%${merchant}%`;

  // Search both tables
  const txRows = all(
    `SELECT merchant, category, amount, description, timestamp FROM transactions
     WHERE (LOWER(merchant) LIKE ? OR LOWER(description) LIKE ?) AND timestamp BETWEEN ? AND ?
     ORDER BY timestamp DESC`,
    [merchantLike, merchantLike, tr.start, tr.end]
  );
  const slRows = all(
    `SELECT category, amount_raw as amount, description, occurred_at as timestamp FROM spend_log
     WHERE LOWER(description) LIKE ? AND occurred_at BETWEEN ? AND ?
     ORDER BY occurred_at DESC`,
    [merchantLike, tr.start, tr.end]
  );

  const allRows = [...txRows, ...slRows].sort((a, b) => b.timestamp - a.timestamp);
  const total = allRows.reduce((s, r) => s + (r.amount || 0), 0);
  const count = allRows.length;
  const period = timeRangeLabel(tr);

  if (count === 0) {
    return {
      answer: `No transactions found for **${merchant}** in ${period}.`,
      type: 'money', data: { merchant, period, total: 0, count: 0 }
    };
  }

  // Action-specific responses
  if (action === 'last' || limit === 1) {
    const last = allRows[0];
    return {
      answer: `Last ${merchant} transaction: **${fmt(last.amount)}** on ${fmtDate(last.timestamp)}${last.description ? ` — ${last.description}` : ''}`,
      type: 'money', data: { merchant, transactions: [last] }
    };
  }

  if (action === 'total' || action === 'count') {
    return {
      answer: `**${merchant}** — ${period}:\n• Total: **${fmt(total)}** across ${count} transaction${count > 1 ? 's' : ''}`,
      type: 'money', data: { merchant, total, count, period }
    };
  }

  // Default: summary with recent transactions
  const showRows = allRows.slice(0, limit || 10);
  let lines = [`**${merchant}** — ${period}:\n• Total spent: **${fmt(total)}** (${count} transactions)\n`];

  if (count > 1) {
    const avg = total / count;
    lines.push(`• Average per transaction: ${fmt(avg)}`);
  }

  lines.push(`\nRecent transactions:`);
  for (const r of showRows) {
    lines.push(`• ${fmtDateShort(r.timestamp)} — ${fmt(r.amount)}${r.description ? ` (${r.description.substring(0, 50)})` : ''}`);
  }
  if (count > showRows.length) {
    lines.push(`\n_...and ${count - showRows.length} more_`);
  }

  return {
    answer: lines.join('\n'),
    type: 'money', data: { merchant, total, count, transactions: showRows }
  };
}

// ── Category sub-handler ──

function handleCategoryQuery(category, action, tr, limit) {
  // Query both tables with category filter
  const txRows = all(
    `SELECT merchant, category, amount, description, timestamp FROM transactions
     WHERE LOWER(category) = ? AND timestamp BETWEEN ? AND ?
     ORDER BY timestamp DESC`,
    [category.toLowerCase(), tr.start, tr.end]
  );
  const slRows = all(
    `SELECT category, amount_raw as amount, description, occurred_at as timestamp FROM spend_log
     WHERE LOWER(category) = ? AND occurred_at BETWEEN ? AND ?
     ORDER BY occurred_at DESC`,
    [category.toLowerCase(), tr.start, tr.end]
  );

  const allRows = [...txRows, ...slRows].sort((a, b) => b.timestamp - a.timestamp);
  const total = allRows.reduce((s, r) => s + (r.amount || 0), 0);
  const count = allRows.length;
  const period = timeRangeLabel(tr);

  if (count === 0) {
    return {
      answer: `No **${category}** expenses found in ${period}.`,
      type: 'money', data: { category, period, total: 0, count: 0 }
    };
  }

  // Group by merchant/description for breakdown
  const byMerchant = {};
  for (const r of allRows) {
    const key = (r.merchant || r.description || 'Unknown').substring(0, 40);
    if (!byMerchant[key]) byMerchant[key] = { total: 0, count: 0 };
    byMerchant[key].total += r.amount || 0;
    byMerchant[key].count++;
  }

  const sorted = Object.entries(byMerchant).sort((a, b) => b[1].total - a[1].total);
  let lines = [`**${category.charAt(0).toUpperCase() + category.slice(1)}** spending — ${period}:\n• Total: **${fmt(total)}** across ${count} transaction${count > 1 ? 's' : ''}\n`];

  if (action === 'breakdown' || sorted.length > 1) {
    lines.push(`Breakdown by merchant:`);
    for (const [name, data] of sorted.slice(0, 10)) {
      const pct = total > 0 ? Math.round(data.total / total * 100) : 0;
      lines.push(`• ${name}: ${fmt(data.total)} (${pct}%, ${data.count}x)`);
    }
  }

  if (action === 'list') {
    lines.push(`\nRecent transactions:`);
    for (const r of allRows.slice(0, limit || 10)) {
      lines.push(`• ${fmtDateShort(r.timestamp)} — ${fmt(r.amount)} ${r.merchant || r.description || ''}`);
    }
  }

  // Inject category-specific anomaly insight
  const anomalyNote = intelligence.getAnomalySummaryForCategory(category);
  if (anomalyNote) lines.push(anomalyNote);

  return {
    answer: lines.join('\n'),
    type: 'money', data: { category, total, count, period, breakdown: sorted }
  };
}

// ── Money summary (no merchant, no category) ──

function handleMoneySummary(tr) {
  const txRows = all(
    `SELECT category, SUM(amount) as total, COUNT(*) as cnt FROM transactions
     WHERE timestamp BETWEEN ? AND ? GROUP BY category ORDER BY total DESC`,
    [tr.start, tr.end]
  );
  const slRows = all(
    `SELECT category, SUM(amount_raw) as total, COUNT(*) as cnt FROM spend_log
     WHERE occurred_at BETWEEN ? AND ? GROUP BY category ORDER BY total DESC`,
    [tr.start, tr.end]
  );

  // Merge categories from both tables
  const merged = {};
  for (const r of [...txRows, ...slRows]) {
    const cat = (r.category || 'other').toLowerCase();
    if (!merged[cat]) merged[cat] = { total: 0, count: 0 };
    merged[cat].total += r.total || 0;
    merged[cat].count += r.cnt || 0;
  }

  const grandTotal = Object.values(merged).reduce((s, v) => s + v.total, 0);
  const totalCount = Object.values(merged).reduce((s, v) => s + v.count, 0);
  const sorted = Object.entries(merged).sort((a, b) => b[1].total - a[1].total);
  const period = timeRangeLabel(tr);

  if (totalCount === 0) {
    return { answer: `No spending data found for ${period}.`, type: 'money' };
  }

  let lines = [`**Spending Summary** — ${period}:\n• Total: **${fmt(grandTotal)}** across ${totalCount} transactions\n`];
  lines.push(`Category breakdown:`);
  for (const [cat, data] of sorted) {
    const pct = grandTotal > 0 ? Math.round(data.total / grandTotal * 100) : 0;
    const bar = '█'.repeat(Math.max(1, Math.round(pct / 5)));
    lines.push(`• ${cat.charAt(0).toUpperCase() + cat.slice(1)}: ${fmt(data.total)} ${bar} ${pct}%`);
  }

  // Top merchant
  const topMerchant = get(
    `SELECT merchant, SUM(amount) as total FROM transactions
     WHERE timestamp BETWEEN ? AND ? AND merchant IS NOT NULL
     GROUP BY merchant ORDER BY total DESC LIMIT 1`,
    [tr.start, tr.end]
  );
  if (topMerchant) {
    lines.push(`\nTop merchant: **${topMerchant.merchant}** (${fmt(topMerchant.total)})`);
  }

  // Inject spending anomalies (from behavior_metrics)
  const anomalyBlock = intelligence.getAnomalySummaryGlobal();
  if (anomalyBlock) lines.push(anomalyBlock);

  return {
    answer: lines.join('\n'),
    type: 'money', data: { grandTotal, categories: sorted, period }
  };
}

// ── Money total ──

function handleMoneyTotal(tr) {
  const period = timeRangeLabel(tr);
  const tx = get(`SELECT SUM(amount) as total, COUNT(*) as cnt FROM transactions WHERE timestamp BETWEEN ? AND ?`, [tr.start, tr.end]);
  const sl = get(`SELECT SUM(amount_raw) as total, COUNT(*) as cnt FROM spend_log WHERE occurred_at BETWEEN ? AND ?`, [tr.start, tr.end]);
  const total = (tx?.total || 0) + (sl?.total || 0);
  const count = (tx?.cnt || 0) + (sl?.cnt || 0);

  return {
    answer: `**Total spending** (${period}): **${fmt(total)}** across ${count} transactions.`,
    type: 'money', data: { total, count, period }
  };
}

// ── Money breakdown ──

function handleMoneyBreakdown(tr) {
  // Same as summary but more detailed
  return handleMoneySummary(tr);
}

// ── Money recent list ──

function handleMoneyList(tr, limit) {
  const rows = all(
    `SELECT merchant, category, amount, description, timestamp FROM transactions
     WHERE timestamp BETWEEN ? AND ? ORDER BY timestamp DESC LIMIT ?`,
    [tr.start, tr.end, limit]
  );
  const period = timeRangeLabel(tr);

  if (rows.length === 0) {
    return { answer: `No transactions found for ${period}.`, type: 'money' };
  }

  let lines = [`**Recent transactions** — ${period}:\n`];
  for (const r of rows) {
    lines.push(`• ${fmtDateShort(r.timestamp)} — **${fmt(r.amount)}** at ${r.merchant || r.description || 'Unknown'} [${r.category || 'other'}]`);
  }

  return { answer: lines.join('\n'), type: 'money', data: { transactions: rows } };
}

// ── Money recent (last N) ──

function handleMoneyRecent(limit) {
  const rows = all(
    `SELECT merchant, category, amount, description, timestamp FROM transactions
     ORDER BY timestamp DESC LIMIT ?`,
    [limit]
  );

  if (rows.length === 0) {
    return { answer: 'No transactions recorded yet.', type: 'money' };
  }

  if (limit === 1) {
    const r = rows[0];
    return {
      answer: `Last transaction: **${fmt(r.amount)}** at **${r.merchant || r.description || 'Unknown'}** on ${fmtDate(r.timestamp)}`,
      type: 'money', data: { transactions: rows }
    };
  }

  let lines = [`**Last ${limit} transactions:**\n`];
  for (const r of rows) {
    lines.push(`• ${fmtDateShort(r.timestamp)} — ${fmt(r.amount)} at ${r.merchant || r.description || 'Unknown'} [${r.category}]`);
  }

  return { answer: lines.join('\n'), type: 'money', data: { transactions: rows } };
}

// ── Money compare ──

function handleMoneyCompare(tr) {
  // Compare current period to previous period of same length
  const duration = tr.end - tr.start;
  const prevStart = tr.start - duration;
  const prevEnd = tr.start;

  const current = get(
    `SELECT SUM(amount) as total, COUNT(*) as cnt FROM transactions WHERE timestamp BETWEEN ? AND ?`,
    [tr.start, tr.end]
  );
  const previous = get(
    `SELECT SUM(amount) as total, COUNT(*) as cnt FROM transactions WHERE timestamp BETWEEN ? AND ?`,
    [prevStart, prevEnd]
  );

  const curTotal = current?.total || 0;
  const prevTotal = previous?.total || 0;
  const diff = curTotal - prevTotal;
  const pct = prevTotal > 0 ? Math.round((diff / prevTotal) * 100) : 0;
  const direction = diff > 0 ? '📈 Up' : diff < 0 ? '📉 Down' : '→ Same';
  const period = timeRangeLabel(tr);

  let lines = [`**Spending Comparison:**\n`];
  lines.push(`• Current (${period}): **${fmt(curTotal)}** (${current?.cnt || 0} txns)`);
  lines.push(`• Previous period: **${fmt(prevTotal)}** (${previous?.cnt || 0} txns)`);
  lines.push(`• Change: ${direction} ${fmt(Math.abs(diff))} (${Math.abs(pct)}%)`);

  // Category-level comparison
  const curCats = all(
    `SELECT category, SUM(amount) as total FROM transactions WHERE timestamp BETWEEN ? AND ? GROUP BY category ORDER BY total DESC LIMIT 5`,
    [tr.start, tr.end]
  );
  const prevCats = all(
    `SELECT category, SUM(amount) as total FROM transactions WHERE timestamp BETWEEN ? AND ? GROUP BY category ORDER BY total DESC LIMIT 5`,
    [prevStart, prevEnd]
  );

  if (curCats.length > 0) {
    const prevMap = {};
    for (const c of prevCats) prevMap[c.category] = c.total;

    lines.push(`\nCategory changes:`);
    for (const c of curCats) {
      const prev = prevMap[c.category] || 0;
      const catDiff = c.total - prev;
      const arrow = catDiff > 0 ? '↑' : catDiff < 0 ? '↓' : '→';
      lines.push(`• ${c.category}: ${fmt(c.total)} ${arrow} (was ${fmt(prev)})`);
    }
  }

  // Inject global anomaly summary
  const anomalyBlock = intelligence.getAnomalySummaryGlobal();
  if (anomalyBlock) lines.push(anomalyBlock);

  return {
    answer: lines.join('\n'),
    type: 'money', data: { current: curTotal, previous: prevTotal, diff, pct }
  };
}

// ── Money trend ──

function handleMoneyTrend(tr) {
  // Weekly spending trend
  const weeks = all(
    `SELECT
       (timestamp - ?) / 604800 as week_num,
       SUM(amount) as total,
       COUNT(*) as cnt
     FROM transactions
     WHERE timestamp BETWEEN ? AND ?
     GROUP BY week_num ORDER BY week_num`,
    [tr.start, tr.start, tr.end]
  );

  if (weeks.length < 2) {
    return handleMoneySummary(tr);
  }

  let lines = [`**Spending Trend** — ${timeRangeLabel(tr)}:\n`];
  for (const w of weeks) {
    const weekStart = new Date((tr.start + w.week_num * 604800) * 1000);
    const label = weekStart.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
    const bar = '█'.repeat(Math.max(1, Math.round(w.total / 1000)));
    lines.push(`• Week of ${label}: ${fmt(w.total)} ${bar}`);
  }

  const totals = weeks.map(w => w.total);
  const avg = totals.reduce((s, t) => s + t, 0) / totals.length;
  const latest = totals[totals.length - 1];
  const trend = latest > avg * 1.2 ? '📈 Spending is above average this week' :
    latest < avg * 0.8 ? '📉 Spending is below average this week' :
      '→ Spending is steady';

  lines.push(`\n${trend} (avg: ${fmt(avg)}/week)`);

  return { answer: lines.join('\n'), type: 'money', data: { weeks, avg } };
}

// ─────────────────────────────────────────────────────────────────────────────
// HANDLER: Subscriptions
// ─────────────────────────────────────────────────────────────────────────────

function handleSubscriptions(intent) {
  const { action, params } = intent;
  const now = Math.floor(Date.now() / 1000);

  const subs = all(`SELECT * FROM subscriptions ORDER BY next_renewal ASC`);
  if (subs.length === 0) {
    return { answer: 'No subscriptions tracked yet. I can detect them from your emails.', type: 'subscriptions' };
  }

  // If asking about a specific subscription by merchant
  if (params.merchant) {
    const sub = subs.find(s => s.name.toLowerCase().includes(params.merchant));
    if (sub) {
      const renewStr = sub.next_renewal ? fmtDate(sub.next_renewal) : 'Unknown';
      const isUpcoming = sub.next_renewal && sub.next_renewal - now < 7 * 86400;
      return {
        answer: `**${sub.name}**\n• Amount: ${sub.amount || 'Unknown'}\n• Period: ${sub.period}\n• Next renewal: ${renewStr}${isUpcoming ? ' ⚠️ Upcoming!' : ''}\n• ${sub.auto_detected ? 'Auto-detected from email' : 'Manually added'}`,
        type: 'subscriptions', data: { subscription: sub }
      };
    }
  }

  // Upcoming renewals
  if (action === 'list' || /renew|upcoming|due|next/.test(params.raw.toLowerCase())) {
    const upcoming = subs.filter(s => s.next_renewal && s.next_renewal > now).sort((a, b) => a.next_renewal - b.next_renewal);
    const overdue = subs.filter(s => s.next_renewal && s.next_renewal <= now);

    let lines = [`**Subscriptions** (${subs.length} tracked):\n`];

    if (overdue.length > 0) {
      lines.push(`⚠️ Possibly overdue:`);
      for (const s of overdue) {
        lines.push(`• ${s.name}: ${s.amount || '?'} (was due ${fmtDate(s.next_renewal)})`);
      }
      lines.push('');
    }

    if (upcoming.length > 0) {
      lines.push(`Upcoming renewals:`);
      for (const s of upcoming.slice(0, 10)) {
        const days = Math.round((s.next_renewal - now) / 86400);
        lines.push(`• ${s.name}: ${s.amount || '?'} — renews ${fmtDate(s.next_renewal)} (${days}d)`);
      }
    }

    const monthly = subs.filter(s => s.period === 'monthly');
    const yearly = subs.filter(s => s.period === 'yearly');
    const monthlyTotal = monthly.reduce((s, sub) => s + parseAmount(sub.amount), 0);
    const yearlyTotal = yearly.reduce((s, sub) => s + parseAmount(sub.amount), 0);

    lines.push(`\n💰 Monthly total: ~${fmt(monthlyTotal)} | Yearly: ~${fmt(yearlyTotal)}`);

    return {
      answer: lines.join('\n'),
      type: 'subscriptions', data: { subscriptions: subs, monthlyTotal, yearlyTotal }
    };
  }

  // Summary (default)
  const monthly = subs.filter(s => s.period === 'monthly');
  const yearly = subs.filter(s => s.period === 'yearly');
  const monthlyTotal = monthly.reduce((s, sub) => s + parseAmount(sub.amount), 0);
  const yearlyTotal = yearly.reduce((s, sub) => s + parseAmount(sub.amount), 0);

  let lines = [`**Subscriptions Overview** (${subs.length} tracked):\n`];

  if (monthly.length > 0) {
    lines.push(`Monthly (${monthly.length}):`);
    for (const s of monthly) {
      lines.push(`• ${s.name}: ${s.amount || '?'} / month`);
    }
  }
  if (yearly.length > 0) {
    lines.push(`\nYearly (${yearly.length}):`);
    for (const s of yearly) {
      lines.push(`• ${s.name}: ${s.amount || '?'} / year`);
    }
  }

  lines.push(`\n💰 Est. monthly burn: ~${fmt(monthlyTotal + Math.round(yearlyTotal / 12))}`);

  // Flag expensive ones
  const expensive = subs.filter(s => parseAmount(s.amount) > 500).sort((a, b) => parseAmount(b.amount) - parseAmount(a.amount));
  if (expensive.length > 0) {
    lines.push(`\n💡 Highest cost: ${expensive[0].name} (${expensive[0].amount})`);
  }

  return {
    answer: lines.join('\n'),
    type: 'subscriptions', data: { subscriptions: subs, monthlyTotal, yearlyTotal }
  };
}

function parseAmount(amountStr) {
  if (!amountStr) return 0;
  const n = parseFloat(String(amountStr).replace(/[₹,$,\s]/g, ''));
  return isNaN(n) ? 0 : n;
}

// ─────────────────────────────────────────────────────────────────────────────
// HANDLER: Email
// ─────────────────────────────────────────────────────────────────────────────

function handleEmail(intent) {
  const { action, params } = intent;
  const low = params.raw.toLowerCase();

  // ── Extract optional sender filter: "from Rahul", "from my boss", "sent by Priya" ──
  // Parsed here once — used in the sender-specific block below.
  const _senderMatch = low.match(/\bfrom\s+(?:my\s+)?([a-z]{2,40})\b|\bsent\s+by\s+([a-z]{2,40})\b/);
  const _senderRaw   = (_senderMatch?.[1] || _senderMatch?.[2] || '').trim();
  const _ignoreWords = new Set(['me','us','them','you','him','her','inbox','chat','mail','email','anyone','someone','anyone']);
  const senderFilter = _senderRaw && !_ignoreWords.has(_senderRaw) ? `%${_senderRaw}%` : null;

  // ── Sender-specific block: "emails from Rahul", "urgent emails from boss" ──
  // Combines sender filter with optional urgency/action filter from the query.
  if (senderFilter) {
    const urgentOnly = /urgent|important|critical|action\s+needed/i.test(low);
    const catClause  = urgentOnly ? `AND category IN ('urgent','action')` : '';
    const emails = all(
      `SELECT from_name, from_email, subject, body_preview, category, received_at FROM email_cache
       WHERE (LOWER(from_name) LIKE ? OR LOWER(from_email) LIKE ?) ${catClause}
       ORDER BY received_at DESC LIMIT ?`,
      [senderFilter, senderFilter, params.limit || 10]
    );
    if (emails.length === 0) {
      const who = _senderRaw.charAt(0).toUpperCase() + _senderRaw.slice(1);
      return { answer: `No ${urgentOnly ? 'urgent ' : ''}emails from ${who} in your cached inbox.`, type: 'email' };
    }
    const displayName = emails[0].from_name || (_senderRaw.charAt(0).toUpperCase() + _senderRaw.slice(1));
    let lines = [`**${urgentOnly ? 'Urgent emails' : 'Emails'} from ${displayName}** (${emails.length}):\n`];
    for (const e of emails) {
      const flag    = e.category === 'urgent' ? '\ud83d\udd34 ' : e.category === 'action' ? '\ud83d\udfe1 ' : '';
      const preview = e.body_preview ? ` \u2014 ${e.body_preview.substring(0, 80).trim()}...` : '';
      lines.push(`\u2022 ${flag}"${e.subject}" \u2014 ${fmtDateShort(e.received_at)}${preview}`);
    }
    return { answer: lines.join('\n'), type: 'email', data: { emails, sender: _senderRaw } };
  }

  // "who emails me the most" / "top senders"
  if (/who\s+(?:email|send|mail)|top\s+sender|most\s+(?:email|mail)/.test(low)) {
    const senders = all(
      `SELECT from_name, from_email, COUNT(*) as cnt FROM email_cache
       GROUP BY from_email ORDER BY cnt DESC LIMIT 10`
    );
    if (senders.length === 0) return { answer: 'No emails cached yet.', type: 'email' };

    let lines = [`**Top Senders:**\n`];
    for (const s of senders) {
      lines.push(`• ${s.from_name || s.from_email}: ${s.cnt} emails`);
    }
    return { answer: lines.join('\n'), type: 'email', data: { senders } };
  }

  // "unread emails" / "emails I haven't read"
  if (/unread|haven.?t\s+read|not\s+read/.test(low)) {
    const unread = all(
      `SELECT from_name, subject, received_at, category FROM email_cache
       WHERE is_read = 0 ORDER BY received_at DESC LIMIT 15`
    );
    if (unread.length === 0) return { answer: 'All caught up! No unread emails.', type: 'email' };

    let lines = [`**Unread Emails** (${unread.length}):\n`];
    for (const e of unread) {
      lines.push(`• ${e.from_name || 'Unknown'}: "${e.subject}" ${e.category === 'urgent' ? '🔴' : ''}`);
    }
    return { answer: lines.join('\n'), type: 'email', data: { emails: unread } };
  }

  // "urgent emails"
  if (/urgent|important|critical|action\s+needed|priority/.test(low)) {
    const urgent = all(
      `SELECT from_name, subject, received_at, summary FROM email_cache
       WHERE category IN ('urgent', 'action') ORDER BY received_at DESC LIMIT 10`
    );
    if (urgent.length === 0) return { answer: 'No urgent emails right now. 👍', type: 'email' };

    let lines = [`**Urgent / Action Required** (${urgent.length}):\n`];
    for (const e of urgent) {
      lines.push(`• 🔴 ${e.from_name || 'Unknown'}: "${e.subject}"${e.summary ? `\n  ${e.summary}` : ''}`);
    }
    return { answer: lines.join('\n'), type: 'email', data: { emails: urgent } };
  }

  // "emails I haven't responded to" / "unanswered emails"
  if (/respond|replied|unanswer|haven.?t\s+(?:replied|respond)|pending\s+repl|need\s+to\s+reply/.test(low)) {
    const pending = all(
      `SELECT from_name, from_email, subject, received_at, summary FROM email_cache
       WHERE category IN ('action', 'urgent') AND is_read = 1
       ORDER BY received_at DESC LIMIT 10`
    );
    if (pending.length === 0) return { answer: 'No pending replies detected.', type: 'email' };

    let lines = [`**Emails needing your reply** (${pending.length}):\n`];
    for (const e of pending) {
      lines.push(`• ${e.from_name}: "${e.subject}" — ${fmtDateShort(e.received_at)}`);
    }
    return { answer: lines.join('\n'), type: 'email', data: { emails: pending } };
  }

  // "emails about [topic]"
  if (params.searchTerm || /about|regarding|related/.test(low)) {
    const term = params.searchTerm || low.match(/(?:about|regarding|related\s+to)\s+(.+)/)?.[1]?.trim();
    if (term) {
      const results = all(
        `SELECT from_name, subject, received_at, summary FROM email_cache
         WHERE subject LIKE ? OR body_preview LIKE ? OR summary LIKE ?
         ORDER BY received_at DESC LIMIT 10`,
        [`%${term}%`, `%${term}%`, `%${term}%`]
      );
      if (results.length === 0) return { answer: `No emails found about "${term}".`, type: 'email' };

      let lines = [`**Emails about "${term}"** (${results.length}):\n`];
      for (const e of results) {
        lines.push(`• ${e.from_name || 'Unknown'}: "${e.subject}" — ${fmtDateShort(e.received_at)}`);
      }
      return { answer: lines.join('\n'), type: 'email', data: { emails: results } };
    }
  }

  // ── "summarize/list last N emails" — return previews + flag for targeted AI summary ──
  // Triggered by action='summary' or action='list' (both land here after falling through
  // the specific sub-patterns above).  main.js sees needsSummary=true and fires one short
  // Ollama call to turn the previews into a digest — result cached for 10 min.
  if (action === 'summary' || action === 'list') {
    const lim = params.limit || 5;
    const emails = all(
      `SELECT from_name, from_email, subject, body_preview, category, received_at
       FROM email_cache ORDER BY received_at DESC LIMIT ?`,
      [lim]
    );
    if (emails.length === 0) {
      return { answer: 'No emails cached yet. Try refreshing your inbox first.', type: 'email' };
    }

    // Structured preview list shown immediately (before AI summary is generated)
    let lines = [`**Last ${emails.length} email${emails.length > 1 ? 's' : ''}:**\n`];
    for (const e of emails) {
      const flag = e.category === 'urgent' ? '🔴 ' : e.category === 'action' ? '🟡 ' : '';
      const preview = e.body_preview ? ` — ${e.body_preview.substring(0, 90).trim()}...` : '';
      lines.push(`• ${flag}**${e.from_name || e.from_email || 'Unknown'}**: "${e.subject}"${preview}`);
    }

    // summaryPrompt passed to main.js for a single targeted Ollama call
    const summaryPrompt = emails.map(e =>
      `From: ${e.from_name || e.from_email}\nSubject: ${e.subject}\nPreview: ${(e.body_preview || 'No preview').substring(0, 300)}`
    ).join('\n---\n');

    return {
      answer: lines.join('\n'),
      type: 'email',
      data: { emails, needsSummary: true, summaryPrompt, limit: lim }
    };
  }

  // Default: email overview
  const total = get(`SELECT COUNT(*) as cnt FROM email_cache`)?.cnt || 0;
  const unreadCnt = get(`SELECT COUNT(*) as cnt FROM email_cache WHERE is_read = 0`)?.cnt || 0;
  const urgentCnt = get(`SELECT COUNT(*) as cnt FROM email_cache WHERE category IN ('urgent','action') AND is_read = 0`)?.cnt || 0;

  const recent = all(
    `SELECT from_name, subject, category, received_at FROM email_cache
     ORDER BY received_at DESC LIMIT 5`
  );

  let lines = [`**Email Overview:**\n• Total cached: ${total}\n• Unread: ${unreadCnt}\n• Urgent/Action: ${urgentCnt}\n`];
  if (recent.length > 0) {
    lines.push(`Latest:`);
    for (const e of recent) {
      const flag = e.category === 'urgent' ? '🔴 ' : e.category === 'action' ? '🟡 ' : '';
      lines.push(`• ${flag}${e.from_name || 'Unknown'}: "${e.subject}"`);
    }
  }

  return { answer: lines.join('\n'), type: 'email', data: { total, unreadCnt, urgentCnt } };
}

// ─────────────────────────────────────────────────────────────────────────────
// HANDLER: Tasks
// ─────────────────────────────────────────────────────────────────────────────

function handleTasks(intent) {
  const { action, params } = intent;
  const low = params.raw.toLowerCase();
  const now = Math.floor(Date.now() / 1000);

  // Overdue tasks
  if (/overdue|past\s+due|missed|late/.test(low)) {
    const overdue = all(
      `SELECT title, due_at, category, priority_score FROM reminders
       WHERE completed = 0 AND archived_at IS NULL AND due_at < ?
       ORDER BY due_at ASC`,
      [now]
    );
    if (overdue.length === 0) return { answer: 'No overdue tasks! You\'re on track. 🎯', type: 'tasks' };

    let lines = [`**Overdue Tasks** (${overdue.length}):\n`];
    for (const t of overdue) {
      const daysLate = Math.round((now - t.due_at) / 86400);
      lines.push(`• ⚠️ ${t.title} — ${daysLate}d overdue (due ${fmtDate(t.due_at)})`);
    }
    return { answer: lines.join('\n'), type: 'tasks', data: { tasks: overdue } };
  }

  // Due today
  if (/today|due\s+today|today.?s/.test(low)) {
    const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);
    const todayEnd = new Date(); todayEnd.setHours(23, 59, 59, 999);
    const tasks = all(
      `SELECT title, due_at, category, priority_score FROM reminders
       WHERE completed = 0 AND archived_at IS NULL AND due_at BETWEEN ? AND ?
       ORDER BY due_at ASC`,
      [Math.floor(todayStart.getTime() / 1000), Math.floor(todayEnd.getTime() / 1000)]
    );
    if (tasks.length === 0) return { answer: 'Nothing due today. Clear schedule! ✨', type: 'tasks' };

    let lines = [`**Due Today** (${tasks.length}):\n`];
    for (const t of tasks) {
      const time = new Date(t.due_at * 1000).toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit' });
      lines.push(`• ${t.title} — ${time}`);
    }
    return { answer: lines.join('\n'), type: 'tasks', data: { tasks } };
  }

  // This week / upcoming — use parsed timeRange if available, else default 7-day window
  if (/this\s+week|week|upcoming/.test(low)) {
    const tr = params.timeRange;
    const rangeStart = tr ? tr.start : now;
    const rangeEnd   = tr ? tr.end   : now + 7 * 86400;
    const tasks = all(
      `SELECT title, due_at, category, priority_score FROM reminders
       WHERE completed = 0 AND archived_at IS NULL AND due_at BETWEEN ? AND ?
       ORDER BY due_at ASC`,
      [rangeStart, rangeEnd]
    );
    if (tasks.length === 0) return { answer: 'No tasks due this week. 🎉', type: 'tasks' };

    let lines = [`**This Week's Tasks** (${tasks.length}):\n`];
    for (const t of tasks) {
      lines.push(`• ${t.title} — due ${fmtDate(t.due_at)}`);
    }
    return { answer: lines.join('\n'), type: 'tasks', data: { tasks } };
  }

  // Completed tasks
  if (/completed|done|finished|accomplished/.test(low)) {
    const tr = params.timeRange || defaultTimeRange();
    const tasks = all(
      `SELECT title, completed_at, category FROM reminders
       WHERE completed = 1 AND completed_at BETWEEN ? AND ?
       ORDER BY completed_at DESC LIMIT 20`,
      [tr.start, tr.end]
    );
    if (tasks.length === 0) return { answer: 'No completed tasks in this period.', type: 'tasks' };

    let lines = [`**Completed Tasks** (${tasks.length}, ${timeRangeLabel(tr)}):\n`];
    for (const t of tasks) {
      lines.push(`• ✅ ${t.title} — ${fmtDate(t.completed_at)}`);
    }
    return { answer: lines.join('\n'), type: 'tasks', data: { tasks } };
  }

  // Generic time range: "tasks due next month", "tasks due in March", "tasks by Dec 15"
  // Uses the parsed params.timeRange from extractQueryIntent
  if (params.timeRange) {
    const tr = params.timeRange;
    const tasks = all(
      `SELECT title, due_at, category, priority_score FROM reminders
       WHERE completed = 0 AND archived_at IS NULL AND due_at BETWEEN ? AND ?
       ORDER BY due_at ASC LIMIT 25`,
      [tr.start, tr.end]
    );
    const period = timeRangeLabel(tr);
    if (tasks.length === 0) {
      return { answer: `No tasks due in ${period}. 🎉`, type: 'tasks' };
    }
    let lines = [`**Tasks due in ${period}** (${tasks.length}):\n`];
    for (const t of tasks) {
      const isOverdue = t.due_at < now;
      lines.push(`${isOverdue ? '⚠️' : '•'} ${t.title} — ${fmtDate(t.due_at)}`);
    }
    return { answer: lines.join('\n'), type: 'tasks', data: { tasks, period } };
  }

  // Default: all pending tasks
  const pending = all(
    `SELECT title, due_at, category, priority_score FROM reminders
     WHERE completed = 0 AND archived_at IS NULL
     ORDER BY priority_score DESC, due_at ASC LIMIT 15`
  );
  const overdueCnt = all(
    `SELECT COUNT(*) as cnt FROM reminders WHERE completed = 0 AND archived_at IS NULL AND due_at < ?`,
    [now]
  )[0]?.cnt || 0;

  if (pending.length === 0) return { answer: 'No pending tasks. All clear! ✨', type: 'tasks' };

  let lines = [`**Pending Tasks** (${pending.length}${overdueCnt > 0 ? `, ${overdueCnt} overdue` : ''}):\n`];
  for (const t of pending) {
    const isOverdue = t.due_at < now;
    const prefix = isOverdue ? '⚠️' : '•';
    lines.push(`${prefix} ${t.title} — due ${fmtDate(t.due_at)}${t.priority_score > 0.5 ? ' 🔥' : ''}`);
  }
  return { answer: lines.join('\n'), type: 'tasks', data: { tasks: pending } };
}

// ─────────────────────────────────────────────────────────────────────────────
// HANDLER: Focus
// ─────────────────────────────────────────────────────────────────────────────

function handleFocus(intent) {
  const { params } = intent;
  const tr = params.timeRange || defaultTimeRange();
  const period = timeRangeLabel(tr);

  const sessions = all(
    `SELECT date, duration FROM focus_sessions
     WHERE created_at BETWEEN ? AND ?
     ORDER BY date DESC`,
    [tr.start, tr.end]
  );

  if (sessions.length === 0) {
    return { answer: `No focus sessions recorded for ${period}.`, type: 'focus' };
  }

  const totalMins = sessions.reduce((s, r) => s + r.duration, 0);
  const avgMins = Math.round(totalMins / sessions.length);

  // Group by date
  const byDate = {};
  for (const s of sessions) {
    if (!byDate[s.date]) byDate[s.date] = 0;
    byDate[s.date] += s.duration;
  }

  const dates = Object.entries(byDate).sort((a, b) => b[0].localeCompare(a[0]));
  const bestDay = dates.reduce((best, d) => d[1] > best[1] ? d : best, ['', 0]);

  let lines = [`**Focus Time** — ${period}:\n`];
  lines.push(`• Total: ${Math.round(totalMins / 60)}h ${totalMins % 60}m across ${sessions.length} sessions`);
  lines.push(`• Daily average: ${avgMins} min`);
  if (bestDay[0]) lines.push(`• Best day: ${bestDay[0]} (${bestDay[1]} min)`);

  lines.push(`\nRecent days:`);
  for (const [date, mins] of dates.slice(0, 7)) {
    const bar = '█'.repeat(Math.max(1, Math.round(mins / 15)));
    lines.push(`• ${date}: ${mins} min ${bar}`);
  }

  return { answer: lines.join('\n'), type: 'focus', data: { totalMins, sessions: sessions.length } };
}

// ─────────────────────────────────────────────────────────────────────────────
// HANDLER: Habits
// ─────────────────────────────────────────────────────────────────────────────

function handleHabits(intent) {
  const habits = all(`SELECT * FROM habits ORDER BY created_at`);
  if (habits.length === 0) {
    return { answer: 'No habits tracked yet. Try: "add habit meditation"', type: 'habits' };
  }

  const today = new Date().toISOString().split('T')[0];
  const weekAgo = new Date(Date.now() - 7 * 86400000).toISOString().split('T')[0];

  let lines = [`**Your Habits** (${habits.length}):\n`];

  for (const h of habits) {
    const todayDone = get(
      `SELECT done FROM habit_log WHERE habit_id = ? AND date = ?`,
      [h.id, today]
    );
    const weekCount = get(
      `SELECT COUNT(*) as cnt FROM habit_log WHERE habit_id = ? AND date >= ? AND done = 1`,
      [h.id, weekAgo]
    )?.cnt || 0;

    // Streak calculation
    let streak = 0;
    const logs = all(
      `SELECT date, done FROM habit_log WHERE habit_id = ? AND done = 1 ORDER BY date DESC LIMIT 30`,
      [h.id]
    );
    if (logs.length > 0) {
      let checkDate = new Date(today);
      for (const log of logs) {
        const logDate = log.date;
        const expected = checkDate.toISOString().split('T')[0];
        if (logDate === expected) {
          streak++;
          checkDate.setDate(checkDate.getDate() - 1);
        } else {
          break;
        }
      }
    }

    const status = todayDone?.done ? '✅' : '⬜';
    lines.push(`${status} ${h.icon || ''} ${h.name} — ${weekCount}/7 this week${streak > 1 ? ` 🔥${streak}` : ''}`);
  }

  return { answer: lines.join('\n'), type: 'habits', data: { habits } };
}

// ─────────────────────────────────────────────────────────────────────────────
// HANDLER: Calendar
// ─────────────────────────────────────────────────────────────────────────────

function handleCalendar(intent) {
  const { params } = intent;
  const now = Math.floor(Date.now() / 1000);
  const low = params.raw.toLowerCase();

  let start = now;
  let end = now + 86400; // default: next 24 hours

  if (/today/.test(low)) {
    const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);
    const todayEnd = new Date(); todayEnd.setHours(23, 59, 59, 999);
    start = Math.floor(todayStart.getTime() / 1000);
    end = Math.floor(todayEnd.getTime() / 1000);
  } else if (/this\s+week/.test(low)) {
    end = now + 7 * 86400;
  } else if (/tomorrow/.test(low)) {
    const tom = new Date(); tom.setDate(tom.getDate() + 1); tom.setHours(0, 0, 0, 0);
    const tomEnd = new Date(tom); tomEnd.setHours(23, 59, 59, 999);
    start = Math.floor(tom.getTime() / 1000);
    end = Math.floor(tomEnd.getTime() / 1000);
  }

  const events = all(
    `SELECT title, start_at, end_at, location FROM calendar_events
     WHERE start_at BETWEEN ? AND ? ORDER BY start_at ASC`,
    [start, end]
  );

  if (events.length === 0) {
    return { answer: 'No calendar events found for this period. Your schedule is clear! 🎉', type: 'calendar' };
  }

  let lines = [`**Upcoming Events** (${events.length}):\n`];
  for (const e of events) {
    const time = new Date(e.start_at * 1000).toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit' });
    const endTime = e.end_at ? new Date(e.end_at * 1000).toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit' }) : '';
    lines.push(`• ${time}${endTime ? `–${endTime}` : ''}: **${e.title}**${e.location ? ` (${e.location})` : ''}`);
  }

  return { answer: lines.join('\n'), type: 'calendar', data: { events } };
}

// ─────────────────────────────────────────────────────────────────────────────
// HANDLER: Stats (cross-domain overview)
// ─────────────────────────────────────────────────────────────────────────────

function handleStats(intent) {
  const { params } = intent;
  const tr = params.timeRange || defaultTimeRange();
  const period = timeRangeLabel(tr);

  // If merchant or category specified, route to money
  if (params.merchant || params.category) {
    return handleMoney(intent);
  }

  // Cross-domain summary
  const spending = get(
    `SELECT SUM(amount) as total, COUNT(*) as cnt FROM transactions WHERE timestamp BETWEEN ? AND ?`,
    [tr.start, tr.end]
  );
  const tasksDone = get(
    `SELECT COUNT(*) as cnt FROM reminders WHERE completed = 1 AND completed_at BETWEEN ? AND ?`,
    [tr.start, tr.end]
  )?.cnt || 0;
  const tasksPending = get(
    `SELECT COUNT(*) as cnt FROM reminders WHERE completed = 0 AND archived_at IS NULL`
  )?.cnt || 0;
  const focusMins = get(
    `SELECT SUM(duration) as total FROM focus_sessions WHERE created_at BETWEEN ? AND ?`,
    [tr.start, tr.end]
  )?.total || 0;
  const emailCount = get(
    `SELECT COUNT(*) as cnt FROM email_cache WHERE received_at BETWEEN ? AND ?`,
    [tr.start, tr.end]
  )?.cnt || 0;

  let lines = [`**Overview** — ${period}:\n`];
  lines.push(`💰 Spending: ${fmt(spending?.total || 0)} (${spending?.cnt || 0} transactions)`);
  lines.push(`✅ Tasks completed: ${tasksDone} | Pending: ${tasksPending}`);
  lines.push(`🎯 Focus time: ${Math.round(focusMins / 60)}h ${focusMins % 60}m`);
  lines.push(`📧 Emails: ${emailCount}`);

  // Top spending category
  const topCat = get(
    `SELECT category, SUM(amount) as total FROM transactions
     WHERE timestamp BETWEEN ? AND ? GROUP BY category ORDER BY total DESC LIMIT 1`,
    [tr.start, tr.end]
  );
  if (topCat) {
    lines.push(`\n📊 Top spending: ${topCat.category} (${fmt(topCat.total)})`);
  }

  return { answer: lines.join('\n'), type: 'stats', data: { spending, tasksDone, tasksPending, focusMins } };
}

// ─────────────────────────────────────────────────────────────────────────────
// isDataQuery — Conservative classifier
// Only returns true when we're CONFIDENT we can handle the query locally
// ─────────────────────────────────────────────────────────────────────────────

function isDataQuery(msg) {
  const intent = extractQueryIntent(msg);

  // Only claim this query if we identified a valid domain
  if (!intent.domain) return false;

  // Extra safety: don't intercept action intents that need AI
  const low = (msg || '').toLowerCase();

  // These are ACTION requests, not DATA queries — let them through to intent handlers
  if (/^(?:remind|set|create|add|delete|remove|cancel|block|snooze|reply|draft|send|forward|schedule|book)\b/.test(low)) {
    return false;
  }

  // "what should I" type questions need AI reasoning, not data lookup
  if (/\bshould\s+i\b|\badvice\b|\brecommend\b|\bsuggest\b|\bhelp\s+me\b|\bwhat\s+do\s+you\s+think\b/.test(low)) {
    return false;
  }

  return true;
}

// ─────────────────────────────────────────────────────────────────────────────
// Module exports
// ─────────────────────────────────────────────────────────────────────────────

module.exports = {
  processQuery,
  isDataQuery,
  extractQueryIntent  // export for Python params merge in main.js
};
