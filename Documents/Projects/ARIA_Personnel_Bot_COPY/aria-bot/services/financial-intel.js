/**
 * services/financial-intel.js
 * Financial signal extraction engine for ARIA Money Intelligence.
 *
 * Sections implemented:
 *   A — Targeted email filtering (subject + domain matching)
 *   B — Merchant coverage (India focused, 60+ merchants)
 *   C — Regex-first amount extraction with LLM fallback contract
 *   D — Schema constants (tables defined in schema.sql)
 *   E — Behavioral deviation analysis engine
 *   F — Exposure forecasting engine
 *
 * Privacy: No raw email body leaves this process. Only structured
 * financial objects are returned / stored.
 */

'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// SECTION A — FINANCIAL EMAIL FILTER
// ─────────────────────────────────────────────────────────────────────────────

/** Subject-line keywords that signal a financial email. */
const FINANCIAL_SUBJECT_KEYWORDS = [
  'order confirmed', 'order placed', 'order shipped',
  'invoice', 'receipt', 'bill',
  'payment successful', 'payment done', 'payment received',
  'charged', 'debited', 'amount debited',
  'subscription', 'renewal', 'auto-debit', 'auto debit',
  'sip', 'systematic investment',
  'transaction', 'txn',
  'investment', 'nav', 'net asset value',
  'refund', 'cashback',
  'emi', 'loan', 'credit card', 'statement',
  'due date', 'payment due',
];

/** Regex built once from the keyword array. */
const FINANCIAL_SUBJECT_RE = new RegExp(
  FINANCIAL_SUBJECT_KEYWORDS.map(k => k.replace(/[-\s]/g, '[\\s\\-]?')).join('|'),
  'i'
);

/**
 * Sender domains/fragments that indicate financial / commerce emails.
 * These are matched against the from_email field (substring match).
 */
const FINANCIAL_SENDER_DOMAINS = [
  // Food
  'swiggy', 'zomato', 'ubereats', 'olafood',
  // E-commerce
  'amazon', 'flipkart', 'meesho', 'myntra', 'ajio', 'snapdeal',
  'nykaa', 'zepto', 'blinkit', 'bigbasket', 'grofers', 'jiomart',
  // Furniture / large retail
  'urbanladder', 'urban-ladder', 'pepperfry', 'ikea',
  // Fintech / UPI / credit
  'cred', 'simpl', 'lazypay', 'paytm', 'phonepe', 'gpay',
  'razorpay', 'cashfree',
  // Banks
  'axisbank', 'hdfcbank', 'icicibank', 'sbi', 'kotak', 'kotakbank',
  'idfcfirstbank', 'yesbank', 'indusind',
  // Investments
  'zerodha', 'groww', 'kuvera', 'camsonline', 'karvy',
  'mutualfund', 'bslmf', 'sbimf', 'hdfcmf', 'icicipru',
  // SaaS & subscriptions
  'netflix', 'hotstar', 'spotify', 'adobe', 'microsoft', 'google',
  'openai', 'anthropic', 'github', 'dropbox', 'notion',
  // Insurance
  'policybazaar', 'coverfox', 'acko', 'icicilombard', 'hdfcergo',
  'sbilife', 'maxlife', 'licindia', 'hdfclife', 'tataaia', 'bajaj',
  'starhealth', 'icicipru',
];

/**
 * Returns true if the email should be processed for financial extraction.
 * Checks subject keywords first (fast), then sender domain (slower).
 *
 * @param {string} subject     - Email subject line
 * @param {string} fromEmail   - Sender email address
 * @param {string} [bodySnip]  - Optional first ~300 chars of body for keyword check
 * @returns {boolean}
 */
function isFinancialEmail(subject, fromEmail, bodySnip = '') {
  // Fast path: subject keyword match
  if (FINANCIAL_SUBJECT_RE.test(subject || '')) return true;

  // Sender domain match
  const addr = (fromEmail || '').toLowerCase();
  if (FINANCIAL_SENDER_DOMAINS.some(d => addr.includes(d))) return true;

  // Body snippet fallback (only basic keyword check — no deep scan)
  if (bodySnip && FINANCIAL_SUBJECT_RE.test(bodySnip)) return true;

  return false;
}

// ─────────────────────────────────────────────────────────────────────────────
// SECTION B — MERCHANT-TO-CATEGORY MAPPER (India focused)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Ordered mapping rules: each rule is [regex, category_slug].
 * First match wins. Category slugs align with spend_log.category values.
 */
const MERCHANT_RULES = [
  // ── Food & Delivery ────────────────────────────────────────────────
  [/swiggy|zomato|uber\s*eats|ola\s*food|faasos|rebel\s*foods|box8|freshmenu|domino|mcdonald|kfc|pizza\s*hut/i, 'food'],

  // ── Groceries / Daily Essentials ──────────────────────────────────
  [/blinkit|zepto|bigbasket|grofers|jiomart|nature'?s\s*basket|dmart/i, 'groceries'],

  // ── Travel ────────────────────────────────────────────────────────
  [/uber|ola|rapido|redbus|irctc|makemytrip|goibibo|yatra|cleartrip|ixigo|airasia|indigo|spicejet|airindia|vistara/i, 'travel'],

  // ── E-commerce / Shopping ─────────────────────────────────────────
  [/amazon|flipkart|meesho|myntra|ajio|snapdeal|nykaa|tatacliq|limeroad|jabong|hopscotch|pepperfry|urbanladder|ikea/i, 'shopping'],

  // ── Entertainment / Streaming ─────────────────────────────────────
  [/netflix|prime\s*video|hotstar|disney|sony\s*liv|zee5|voot|mxplayer|spotify|apple\s*music|youtube\s*premium|gaana|jio\s*saavn/i, 'entertainment'],

  // ── Health / Pharmacy ─────────────────────────────────────────────
  [/1mg|netmeds|apollo|pharmeasy|healthkart|medlife|lybrate|practo|cult\.fit|healthifyme/i, 'health'],

  // ── Utilities / Bills ─────────────────────────────────────────────
  [/electricity|water\s*bill|gas\s*bill|airtel|jio|vi\b|vodafone|bsnl|tata\s*sky|d2h|tataplay|broadband|internet\s*bill|fastag/i, 'utilities'],

  // ── SaaS / Software Subscriptions ─────────────────────────────────
  [/github|adobe|microsoft|google\s*one|dropbox|notion|slack|zoom|figma|openai|anthropic|copilot|canva/i, 'subscriptions'],

  // ── Fintech / Investments ─────────────────────────────────────────
  [/zerodha|groww|kuvera|cams|karvy|sbi\s*mf|hdfc\s*mf|icici\s*pru|uti\s*mf|birla|nippon|mutual\s*fund|sip\s*installment|nav|bse\s*star/i, 'investments'],

  // ── Insurance ─────────────────────────────────────────────────────
  [/insurance|policybazaar|acko|coverfox|icicilombard|hdfcergo|bajaj\s*allianz|premium\s*debit|hdfc\s*life|sbi\s*life|max\s*life|tata\s*aia|star\s*health|lic\b/i, 'insurance'],

  // ── Banking / Credit ──────────────────────────────────────────────
  [/credit\s*card|emi|loan\s*instalment?|bank\s*charge|account\s*debit|neft|imps|rtgs|upi\s*payment/i, 'banking'],
];

/**
 * Map a merchant name / email text to a category slug.
 * @param {string} text - Subject, sender, or merchant name
 * @returns {string}    - Category slug (default: 'other')
 */
function merchantToCategory(text) {
  if (!text) return 'other';
  for (const [re, cat] of MERCHANT_RULES) {
    if (re.test(text)) return cat;
  }
  return 'other';
}

// ─────────────────────────────────────────────────────────────────────────────
// SECTION C — AMOUNT EXTRACTION (regex-first)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Ordered regex patterns for amount extraction.
 * All patterns must capture the raw numeric string in group 1.
 */
const AMOUNT_PATTERNS = [
  // ₹ symbol followed by amount (with optional spaces/commas)
  /₹\s?([\d,]+(?:\.\d{1,2})?)/,
  // INR prefix
  /INR\s?([\d,]+(?:\.\d{1,2})?)/i,
  // Rs. / Rs prefix
  /Rs\.?\s?([\d,]+(?:\.\d{1,2})?)/i,
  // "amount: 1,234" style
  /amount[:\s]+(?:of\s+)?(?:₹|INR|Rs\.?)?\s*([\d,]+(?:\.\d{1,2})?)/i,
  // "total: 1,234" style
  /total[:\s]+(?:₹|INR|Rs\.?)?\s*([\d,]+(?:\.\d{1,2})?)/i,
  // "charged ₹1,234" / "debited ₹1,234"
  /(?:charged|debited|deducted|paid)[^\d₹]{0,20}(?:₹|INR|Rs\.?)?\s*([\d,]+(?:\.\d{1,2})?)/i,
  // "order value 1,234" (e-commerce)
  /(?:order|item)\s+(?:value|total|amount)[:\s]+(?:₹|INR|Rs\.?)?\s*([\d,]+(?:\.\d{1,2})?)/i,
];

/**
 * Extract the primary monetary amount from a text blob.
 * Returns the first confident match, or 0 if nothing found.
 *
 * @param {string} text - Raw subject + body snippet (max ~500 chars recommended)
 * @returns {number}    - Numeric amount (0 = not found)
 */
function extractAmount(text) {
  if (!text) return 0;
  for (const pattern of AMOUNT_PATTERNS) {
    const m = pattern.exec(text);
    if (m && m[1]) {
      const num = parseFloat(m[1].replace(/,/g, ''));
      if (!isNaN(num) && num > 0 && num < 10_000_000) return num; // sanity cap 1 crore
    }
  }
  return 0;
}

// ─────────────────────────────────────────────────────────────────────────────
// SECTION C2 — PAYMENT LINK EXTRACTION
// ─────────────────────────────────────────────────────────────────────────────

/**
 * URL patterns in email bodies that are likely payment / action links.
 */
const PAYMENT_LINK_PATTERNS = [
  // Direct payment/billing URLs
  /https?:\/\/[^\s<>"']+(?:pay|payment|billing|invoice|renew|checkout|recharge|topup|subscribe|premium)[^\s<>"']*/gi,
  // UPI deep links
  /upi:\/\/pay\?[^\s<>"']+/gi,
  // Razorpay / Cashfree / PayU / Instamojo checkout links
  /https?:\/\/(?:rzp\.io|pages\.razorpay\.com|cashfree\.com|payu\.in|instamojo\.com|payumoney\.com)[^\s<>"']*/gi,
  // CRED / PhonePe / Paytm links
  /https?:\/\/(?:cred\.club|phonepe\.com|paytm\.com)[^\s<>"']*(?:pay|bill|recharge)[^\s<>"']*/gi,
  // Generic "pay now" / "renew" button links (often shortened)
  /https?:\/\/(?:bit\.ly|goo\.gl|t\.co|short\.io|tinyurl\.com)\/[^\s<>"']+/gi,
];

/**
 * Extract the most relevant payment link from email text.
 * Returns the first match or null.
 *
 * @param {string} text - Email body / body_preview
 * @returns {string|null}
 */
function extractPaymentLink(text) {
  if (!text) return null;
  for (const pattern of PAYMENT_LINK_PATTERNS) {
    pattern.lastIndex = 0; // reset global regex
    const m = pattern.exec(text);
    if (m && m[0]) {
      // Clean trailing punctuation
      return m[0].replace(/[.,;)\]}>]+$/, '');
    }
  }
  // Fallback: any URL with pay/bill/renew in path
  const fallback = text.match(/https?:\/\/[^\s<>"']+/g);
  if (fallback) {
    const payUrl = fallback.find(u => /pay|bill|renew|invoice|checkout|premium/i.test(u));
    if (payUrl) return payUrl.replace(/[.,;)\]}>]+$/, '');
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// SECTION C3 — CREDIT / DEBIT DETECTION
// ─────────────────────────────────────────────────────────────────────────────

const CREDIT_KEYWORDS = [
  'refund', 'cashback', 'cash back', 'credited', 'received', 'reversal',
  'reimbursement', 'reward', 'bonus', 'income', 'salary', 'payout',
  'dividend', 'interest earned', 'interest credited', 'maturity amount',
  'claim settled', 'money received', 'amount credited',
];
const CREDIT_RE = new RegExp(CREDIT_KEYWORDS.join('|'), 'i');

/**
 * Detect whether a transaction is a credit or debit.
 * @param {string} subject
 * @param {string} bodyPreview
 * @returns {'credit'|'debit'}
 */
function detectTxType(subject, bodyPreview) {
  const text = `${subject || ''} ${bodyPreview || ''}`;
  return CREDIT_RE.test(text) ? 'credit' : 'debit';
}

/**
 * Extract merchant name heuristically from the sender / subject.
 * Returns a clean merchant string or empty string.
 *
 * @param {string} fromName   - Sender display name
 * @param {string} fromEmail  - Sender email (used as fallback)
 * @param {string} subject    - Email subject
 * @returns {string}
 */
function extractMerchant(fromName, fromEmail, subject) {
  // Prefer sender display name — usually the merchant
  if (fromName && fromName.trim() && fromName.length < 60) {
    return fromName.trim();
  }
  // Fallback: extract domain label from email address
  const domainMatch = (fromEmail || '').match(/@([^.]+)/);
  if (domainMatch) {
    return domainMatch[1].charAt(0).toUpperCase() + domainMatch[1].slice(1);
  }
  return subject ? subject.slice(0, 40) : 'Unknown';
}

/**
 * Extract a full structured transaction object from an email.
 * Returns null if the email is not financial or no amount is found.
 *
 * @param {{ message_id, from_name, from_email, subject, body_preview, received_at }} email
 * @returns {{ merchant, category, amount, currency, description, timestamp, source_email_id } | null}
 */
function extractTransaction(email) {
  const { message_id, from_name, from_email, subject, body_preview, received_at } = email;

  // Gate: must pass financial filter
  if (!isFinancialEmail(subject, from_email, body_preview)) return null;

  const searchText = `${subject || ''} ${body_preview || ''}`;
  const amount = extractAmount(searchText);

  // Skip zero-value signals (marketing, info-only)
  if (amount <= 0) return null;

  const merchant     = extractMerchant(from_name, from_email, subject);
  const category     = merchantToCategory(searchText);
  const timestamp    = received_at || Math.floor(Date.now() / 1000);
  const tx_type      = detectTxType(subject, body_preview);
  const payment_link = extractPaymentLink(body_preview);

  return {
    merchant,
    category,
    amount,
    currency: 'INR',
    description: (subject || '').slice(0, 120),
    timestamp,
    source_email_id: message_id || null,
    tx_type,
    payment_link,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// SECTION E — BEHAVIORAL DEVIATION ANALYSIS
// ─────────────────────────────────────────────────────────────────────────────

const DAY  = 86400;
const WEEK = 7 * DAY;

/**
 * Compute behavioral deviation metrics for a set of transactions.
 * The transactions array is expected to cover the last 28 days.
 * Returns an array of per-category insight objects.
 *
 * @param {Array<{ category, amount, timestamp }>} transactions  - Last 28 days
 * @param {number} [nowUnix]                                     - Reference timestamp
 * @returns {Array<BehaviorMetric>}
 */
function computeBehaviorMetrics(transactions, nowUnix) {
  const now = nowUnix || Math.floor(Date.now() / 1000);

  // Split into 4 weekly windows (window 0 = current week)
  const windows = Array.from({ length: 4 }, (_, w) => ({
    entries: transactions.filter(t =>
      t.timestamp >= now - (w + 1) * WEEK &&
      t.timestamp <  now - w * WEEK
    ),
  }));

  // Aggregate per-category per-window
  windows.forEach(w => {
    w.cats  = {};
    w.hours = {};
    for (const t of w.entries) {
      w.cats[t.category] = (w.cats[t.category] || 0) + t.amount;
      const h = new Date(t.timestamp * 1000).getHours();
      w.hours[h] = (w.hours[h] || 0) + 1;
    }
    w.total = w.entries.reduce((s, t) => s + t.amount, 0);
  });

  const current    = windows[0];
  const historical = windows.slice(1).filter(w => w.entries.length > 0);

  // Build 3-week rolling average per category
  const avgCats = {};
  if (historical.length > 0) {
    const allCatKeys = new Set(historical.flatMap(w => Object.keys(w.cats)));
    for (const cat of allCatKeys) {
      const weeksWithData = historical.filter(w => (w.cats[cat] || 0) > 0);
      avgCats[cat] = weeksWithData.length > 0
        ? weeksWithData.reduce((s, w) => s + w.cats[cat], 0) / weeksWithData.length
        : 0;
    }
  }

  // Build behavioral metrics for all categories in current week
  const metrics = [];
  const allCurrentCats = new Set([
    ...Object.keys(current.cats),
    ...Object.keys(avgCats),
  ]);

  for (const cat of allCurrentCats) {
    const weeklySp  = current.cats[cat] || 0;
    const baseline  = avgCats[cat] || 0;
    const deviation = baseline > 0
      ? Math.round(((weeklySp - baseline) / baseline) * 100)
      : (weeklySp > 0 ? null : 0); // null = no baseline yet

    const orderCount = current.entries.filter(t => t.category === cat).length;

    // Peak hour for this category
    const catEntries  = current.entries.filter(t => t.category === cat);
    const hourCounts  = {};
    for (const t of catEntries) {
      const h = new Date(t.timestamp * 1000).getHours();
      hourCounts[h] = (hourCounts[h] || 0) + 1;
    }
    const peakHour = Object.keys(hourCounts).length > 0
      ? Number(Object.entries(hourCounts).sort((a, b) => b[1] - a[1])[0][0])
      : null;

    // Pattern note
    let patternNote = '';
    if (deviation !== null && deviation > 30) {
      patternNote = `${cat.charAt(0).toUpperCase() + cat.slice(1)} spend is ${deviation}% above your usual average.`;
    } else if (deviation !== null && deviation < -30) {
      patternNote = `${cat.charAt(0).toUpperCase() + cat.slice(1)} spend is ${Math.abs(deviation)}% below average — lighter week.`;
    } else if (deviation === null && weeklySp > 0) {
      patternNote = `First recorded ${cat} spend — building baseline.`;
    }

    metrics.push({
      category:         cat,
      deviation_percent: deviation,
      weekly_spend:     Math.round(weeklySp),
      baseline_avg:     Math.round(baseline),
      order_count:      orderCount,
      most_common_hour: peakHour,
      pattern_note:     patternNote,
      flagged:          deviation !== null && Math.abs(deviation) > 30,
    });
  }

  return metrics.sort((a, b) => (b.weekly_spend || 0) - (a.weekly_spend || 0));
}

// ─────────────────────────────────────────────────────────────────────────────
// SECTION F — EXPOSURE FORECASTING
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Compute exposure forecast from subscriptions + recent transactions.
 *
 * @param {Array<{ amount, period }>} subscriptions
 * @param {Array<{ category, amount, timestamp }>} recentTransactions  - Last 7 days
 * @param {Array<{ name, amount, next_renewal }>} upcomingRenewals     - Any upcoming
 * @returns {ExposureForecast}
 */
function computeExposure(subscriptions, recentTransactions, upcomingRenewals) {
  const parseAmt = (str) => {
    if (!str && str !== 0) return 0;
    if (typeof str === 'number') return str;
    const cleaned = String(str).replace(/[₹$,\s]/g, '');
    return parseFloat(cleaned) || 0;
  };

  // Monthly recurring commitment from subscriptions
  let monthlyCommit = 0;
  for (const s of (subscriptions || [])) {
    const a = parseAmt(s.amount);
    if (s.period === 'monthly')   monthlyCommit += a;
    else if (s.period === 'yearly')  monthlyCommit += a / 12;
    else if (s.period === 'weekly')  monthlyCommit += a * 4.33;
  }

  // Upcoming renewals in next 30 days (total cost)
  const next30Renewals = (upcomingRenewals || []).filter(r => r.daysLeft <= 30);
  const next30Exposure = next30Renewals.reduce((s, r) => s + parseAmt(r.amount), 0);

  // Variable spend this week
  const weeklyVariableSpend = (recentTransactions || [])
    .reduce((s, t) => s + (parseAmt(t.amount) || parseAmt(t.amount_raw)), 0);

  // Top spend category this week
  const catTotals = {};
  for (const t of (recentTransactions || [])) {
    catTotals[t.category] = (catTotals[t.category] || 0) + (parseAmt(t.amount) || parseAmt(t.amount_raw) || 0);
  }
  const topSpendCat = Object.keys(catTotals).length > 0
    ? Object.entries(catTotals).sort((a, b) => b[1] - a[1])[0][0]
    : null;

  // 7-day projected exposure = weekly variable + weekly subscription burden
  const weeklyBurden    = monthlyCommit / 4.33;
  const projectedWeek7d = Math.round(weeklyVariableSpend + weeklyBurden);

  return {
    monthly_commitment:    Math.round(monthlyCommit),
    next_30day_exposure:   Math.round(next30Exposure),
    weekly_variable_spend: Math.round(weeklyVariableSpend),
    weekly_subscription_burden: Math.round(weeklyBurden),
    projected_7d:          projectedWeek7d,
    top_spend_category:    topSpendCat,
    renewal_count_30d:     next30Renewals.length,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// EXPORTS
// ─────────────────────────────────────────────────────────────────────────────
// SECTION G — PERSIST HELPERS (extracted from main.js to eliminate triplication)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Scan emails from email_cache, extract transactions, and persist into
 * both `transactions` and `spend_log` tables. Idempotent (INSERT OR IGNORE).
 *
 * @param {{ all: Function, run: Function }} db — object with `all(sql, params)` and `run(sql, params)`
 * @param {number} [lookbackDays=90] — how many days back to scan
 * @returns {{ scanned: number, inserted: number }}
 */
function persistTransactions(db, lookbackDays = 90) {
  const now = Math.floor(Date.now() / 1000);
  const limit = now - lookbackDays * 86400;

  const emails = db.all(
    `SELECT message_id, from_name, from_email, subject, body_preview, received_at, smart_action
     FROM email_cache WHERE received_at > ? ORDER BY received_at DESC`,
    [limit]
  );

  let inserted = 0;
  for (const email of emails) {
    const tx = extractTransaction(email);
    if (!tx) continue;
    if (tx.amount <= 0) {
      let sa = null;
      try { sa = email.smart_action ? JSON.parse(email.smart_action) : null; } catch (_) {}
      const fiStr = sa?.financial_impact;
      if (fiStr) {
        const amt = extractAmount(fiStr);
        if (amt > 0) tx.amount = amt;
      }
      if (tx.amount <= 0) continue;
    }
    try {
      db.run(
        `INSERT OR IGNORE INTO transactions
           (merchant, category, amount, currency, description, timestamp, source_email_id, tx_type, payment_link)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [tx.merchant, tx.category, tx.amount, tx.currency, tx.description, tx.timestamp, tx.source_email_id, tx.tx_type || 'debit', tx.payment_link || null]
      );
      db.run(
        `INSERT OR IGNORE INTO spend_log (category, amount_raw, description, source, source_ref, occurred_at)
         VALUES (?, ?, ?, 'email', ?, ?)`,
        [tx.category, tx.amount, tx.description || '', tx.source_email_id, tx.timestamp]
      );
      inserted++;
    } catch (_) {}
  }
  return { scanned: emails.length, inserted };
}

/**
 * Scan email_cache for renewal/subscription opportunities and upsert
 * into `subscriptions` table + create renewal reminder tasks.
 *
 * @param {{ all: Function, run: Function, get: Function }} db
 * @returns {{ subsCreated: number, subsUpdated: number, tasksCreated: number }}
 */
function persistSubscriptions(db) {
  const now = Math.floor(Date.now() / 1000);
  const paymentEmails = db.all(
    `SELECT message_id, reminder_opportunity FROM email_cache
     WHERE reminder_opportunity IS NOT NULL`
  );

  let subsCreated = 0, subsUpdated = 0, tasksCreated = 0;
  for (const row of paymentEmails) {
    try {
      const opp = typeof row.reminder_opportunity === 'string'
        ? JSON.parse(row.reminder_opportunity) : row.reminder_opportunity;
      if (!opp || !opp.service_name) continue;

      const name      = opp.service_name.trim();
      const period    = opp.period || 'monthly';
      const amount    = opp.amount || null;
      const renewalTs = opp.renewal_date
        ? Math.floor(new Date(opp.renewal_date).getTime() / 1000)
        : null;

      const existing = db.get(`SELECT id, next_renewal FROM subscriptions WHERE LOWER(name) = LOWER(?)`, [name]);
      if (!existing) {
        db.run(
          `INSERT INTO subscriptions
             (name, amount, currency, period, next_renewal, source_email_id, auto_detected, created_at, updated_at)
           VALUES (?, ?, 'INR', ?, ?, ?, 1, ?, ?)`,
          [name, amount, period, renewalTs, row.message_id, now, now]
        );
        subsCreated++;
      } else if (renewalTs && (!existing.next_renewal || renewalTs > existing.next_renewal) || amount) {
        db.run(
          `UPDATE subscriptions SET amount = COALESCE(?, amount), period = ?,
             next_renewal = COALESCE(?, next_renewal), source_email_id = COALESCE(source_email_id, ?),
             auto_detected = 1, updated_at = ? WHERE id = ?`,
          [amount, period, renewalTs, row.message_id, now, existing.id]
        );
        subsUpdated++;
      }

      // Renewal reminder task 3 days before billing
      if (renewalTs && renewalTs > now) {
        const taskTitle = `${name} renewal`;
        const taskDueAt = renewalTs - 3 * 86400;
        const existingTask = db.get(`SELECT id FROM reminders WHERE LOWER(title) = LOWER(?) AND completed = 0`, [taskTitle]);
        if (!existingTask && taskDueAt > now - 86400) {
          const subtitle = `${amount ? amount + ' · ' : ''}${period} · Review before billing`;
          db.run(
            `INSERT INTO reminders (title, due_at, category, subtitle, source, created_at)
             VALUES (?, ?, 'subscription', ?, 'subscription', ?)`,
            [taskTitle, taskDueAt, subtitle, now]
          );
          tasksCreated++;
        }
      }
    } catch (_) {}
  }
  return { subsCreated, subsUpdated, tasksCreated };
}

// ─────────────────────────────────────────────────────────────────────────────

module.exports = {
  // Section A
  isFinancialEmail,
  FINANCIAL_SUBJECT_KEYWORDS,
  FINANCIAL_SENDER_DOMAINS,

  // Section B
  merchantToCategory,
  MERCHANT_RULES,

  // Section C
  extractAmount,
  extractMerchant,
  extractTransaction,

  // Section C2 — Payment links
  extractPaymentLink,

  // Section C3 — Credit/debit detection
  detectTxType,

  // Section E
  computeBehaviorMetrics,

  // Section F
  computeExposure,

  // Section G — Persist helpers
  persistTransactions,
  persistSubscriptions,
};
