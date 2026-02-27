/**
 * services/gmail.js — Gmail REST API client
 *
 * Replaces IMAP-based mail fetching with direct Gmail API calls.
 * Reuses all noise-detection and AI analysis logic from mail.js.
 *
 * Prerequisites (Google Cloud Console):
 *   - OAuth 2.0 client type: Web application
 *   - Authorized redirect URIs must include: http://localhost
 *   - Scopes: gmail.readonly, gmail.modify, userinfo.email
 */

const { getSetting, run, get, all } = require('../db/index.js');
const { refreshAccessToken } = require('../electron/auth.js');
const { getRefreshToken: getKeyedRefreshToken } = require('./gmail-oauth.js');
const { aiCall } = require('./ai.js');
const ollama = require('./ollama.js');

// ─────────────────────────────────────────────
// Ollama-only email analysis — no external API fallback
// If Ollama is offline/fails, we use heuristics only (free).
// External APIs (Grok/Gemini) are reserved for chat + briefing.
// ─────────────────────────────────────────────
const OLLAMA_EMAIL_MODEL   = 'llama3.2:3b';
const OLLAMA_EMAIL_TIMEOUT = 25000; // 25 s — JSON output needs more time than single-word tasks

const BASE             = 'https://gmail.googleapis.com/gmail/v1/users/me';
const BATCH_BASE       = 'https://www.googleapis.com/batch/gmail/v1';
// Gmail quota: metadata = 1 unit each, full = 5 units each.
// Safe ceiling per batch: stay well under 250 units/user/second.
const BATCH_CHUNK_META = 20; // 20 × 1 = 20 units per request
const BATCH_CHUNK_FULL =  8; //  8 × 5 = 40 units per request

// ─────────────────────────────────────────────
// Noise detection constants (mirrored from mail.js)
// ─────────────────────────────────────────────

const NOISE_SENDER_PATTERNS = [
  'noreply', 'no-reply', 'donotreply', 'do-not-reply',
  'newsletter', 'newsletters', 'notifications', 'notification',
  'promotions', 'promotion', 'marketing', 'mailer', 'bounce', 'automated',
  'campaigns', 'campaign', 'mailchimp', 'sendgrid', 'mailgun', 'klaviyo',
  'info@', 'hello@', 'team@', 'news@', 'digest@', 'offers@', 'offer@',
  'deals@', 'sales@', 'sale@', 'shop@', 'store@', 'updates@', 'update@',
  'promo@', 'promos@', 'rewards@', 'alert@', 'alerts@', 'do_not_reply',
  'subscriptions@', 'unsubscribe', 'mail.', 'e.mail', 'em.'
];

const NOISE_SUBJECT_PATTERNS = [
  'unsubscribe',
  '% off', '% discount', 'flat off', 'upto', 'up to',
  'last day', 'last chance', 'today only', 'ends today', 'ends tonight',
  'limited time', 'limited offer', 'hurry', 'act now', 'dont miss', "don't miss",
  'exclusive offer', 'special offer', 'exclusive deal', 'best deal',
  'click here', 'explore now', 'shop now', 'buy now', 'order now',
  'check out our', 'new arrivals', 'new collection', 'just dropped',
  'flash sale', 'mega sale', 'big sale', 'clearance', 'sale ends',
  'free shipping', 'free delivery', 'coupon', 'promo code', 'voucher',
  'webinar', 'weekly digest', 'monthly digest', 'roundup', 'newsletter',
  'you won', 'you have won', 'congratulations', 'claim your', 'claim now',
  'win a ', 'win an ', 'you are selected', "you've been selected",
  'pre-approved', 'pre approved', 'special invitation', 'exclusive invitation',
  'early access', 'beta access', 'waitlist', 'waitlisted',
  'monday drop', 'weekly drop', 'daily drop',
  'referral', 'refer and earn', 'earn cashback', 'earn rewards',
  'exciting offers', 'amazing offers', 'super sale', 'weekend sale',
  'festive offer', 'seasonal offer', 'holiday offer',
  'one-stop', 'destination for', 'your guide to', 'explore our',
  'invest now', 'start investing', 'wealth creation'
];

const IMPORTANT_SUBJECT_OVERRIDES = [
  'security alert', 'sign-in attempt', 'new sign-in', 'suspicious activity',
  'account locked', 'account suspended', 'unauthorized access', 'breach',
  'verify your', 'verification code', 'otp', 'one-time password',
  'password changed', 'password reset', 'your account',
  'payment failed', 'payment declined', 'transaction failed',
  'fraud alert', 'account alert'
];

const GMAIL_NOISE_LABELS = ['CATEGORY_PROMOTIONS', 'CATEGORY_SOCIAL', 'CATEGORY_UPDATES'];

// ─────────────────────────────────────────────
// Payment detection
// ─────────────────────────────────────────────

const PAYMENT_SUBJECT_PATTERNS = [
  'payment', 'receipt', 'invoice', 'subscription', 'renewal',
  'confirmed', 'confirmation', 'order confirmed', 'purchased', 'billing', 'charged',
  'auto-renew', 'auto renew', 'renewed', 'expir', 'plan', 'trial ends',
  'transaction', 'sip', 'mutual fund', 'invested', 'investment', 'folio',
  'debit', 'credit', 'bank', 'upi', 'transfer', 'paid', 'amount', 'balance due',
  'premium', 'insurance', 'policy', 'emi', 'instalment', 'installment', 'due date'
];

const PAYMENT_SENDER_PATTERNS = [
  'billing', 'invoice', 'payments', 'receipts', 'subscriptions',
  'orders', 'purchases', 'mutual', 'fund', 'finance', 'bank', 'invest',
  'insurance', 'hdfc', 'icici', 'sbi', 'lic', 'maxlife', 'bajaj', 'tata'
];

// ─────────────────────────────────────────────
// Noise detection helpers
// ─────────────────────────────────────────────

function isNoise(email, labelIds = []) {
  const fromEmail = (email.from_email || '').toLowerCase();
  const subject   = (email.subject   || '').toLowerCase();

  for (const kw of IMPORTANT_SUBJECT_OVERRIDES) if (subject.includes(kw)) return false;
  for (const label of GMAIL_NOISE_LABELS) if (labelIds.includes(label)) return true;
  for (const pat of NOISE_SENDER_PATTERNS)  if (fromEmail.includes(pat)) return true;
  for (const pat of NOISE_SUBJECT_PATTERNS) if (subject.includes(pat))   return true;

  return false;
}

function isPaymentEmail(email) {
  const subject   = (email.subject   || '').toLowerCase();
  const fromEmail = (email.from_email || '').toLowerCase();
  for (const kw of PAYMENT_SUBJECT_PATTERNS) if (subject.includes(kw)) return true;
  for (const kw of PAYMENT_SENDER_PATTERNS)  if (fromEmail.includes(kw)) return true;
  return false;
}

// ─────────────────────────────────────────────
// Heuristic fallbacks
// ─────────────────────────────────────────────

const URGENT_SUBJECT_HINTS = [
  'security alert', 'sign-in attempt', 'new sign-in', 'unauthorized',
  'suspicious activity', 'account locked', 'account suspended',
  'password reset', 'verify now', 'action required', 'urgent',
  'payment failed', 'payment declined', 'transaction failed', 'fraud alert',
  'overdue', 'expires today', 'expiring today'
];

const ACTION_SUBJECT_HINTS = [
  'invoice', 'receipt', 'order confirmed', 'subscription', 'renewal',
  'paused', 'disabled', 'expiring', 'expir', 'balance due', 'outstanding',
  'action needed', 'reminder', 'follow up', 'follow-up',
  'interview', 'meeting request', 'invitation', 'rsvp', 'confirm',
  'your order', 'your application', 'payment'
];

function heuristicCategory(email) {
  const subject = (email.subject || '').toLowerCase();
  const from    = (email.from_email || '').toLowerCase();
  for (const kw of URGENT_SUBJECT_HINTS) if (subject.includes(kw)) return 'urgent';
  if (from.includes('github.com') || from.includes('supabase') || from.includes('google.com')) {
    for (const kw of ACTION_SUBJECT_HINTS) if (subject.includes(kw)) return 'action';
    if (subject.includes('security') || subject.includes('alert')) return 'urgent';
  }
  for (const kw of ACTION_SUBJECT_HINTS) if (subject.includes(kw)) return 'action';
  return 'fyi';
}

function heuristicSmartAction(email) {
  const subject = (email.subject || '').toLowerCase();
  const from    = (email.from_email || '').toLowerCase();
  if (subject.includes('security alert') || subject.includes('sign-in') || subject.includes('login') || subject.includes('unauthorized'))
    return { suggestion: 'Verify this access was you', cta: 'Review', type: 'security' };
  if (subject.includes('payment failed') || subject.includes('payment declined') || subject.includes('declined'))
    return { suggestion: 'Update your payment method', cta: 'Fix Now', type: 'payment' };
  if (subject.includes('invoice') || subject.includes('receipt') || subject.includes('outstanding') || subject.includes('balance'))
    return { suggestion: 'Review the invoice or payment', cta: 'View', type: 'payment' };
  if (subject.includes('paused') || subject.includes('suspended') || subject.includes('disabled'))
    return { suggestion: 'Check and reactivate your account', cta: 'Reactivate', type: 'account' };
  if (subject.includes('expir') || subject.includes('renewal'))
    return { suggestion: 'Renew before service expires', cta: 'Renew', type: 'payment' };
  if (subject.includes('subscription') || subject.includes('charged') || subject.includes('billing'))
    return { suggestion: 'Review your billing details', cta: 'View', type: 'payment' };
  if (from.includes('github'))
    return { suggestion: 'Review on GitHub', cta: 'Open', type: 'task' };
  if (subject.includes('interview') || subject.includes('offer') || subject.includes('application'))
    return { suggestion: 'Respond to this opportunity', cta: 'Reply', type: 'task' };
  if (subject.includes('meeting') || subject.includes('calendar') || subject.includes('invite'))
    return { suggestion: 'Check and confirm the meeting', cta: 'RSVP', type: 'calendar' };
  return { suggestion: 'Open and review this email', cta: 'Open', type: 'info' };
}

// Returns true if the summary looks like raw body text (heuristic fallback),
// meaning it should be re-analyzed when AI is available.
function looksLikeHeuristicSummary(s) {
  if (!s || s.trim().length < 10) return true;
  const t = s.trim();
  // Pattern 1: heuristicSummary fallback format "From NAME: Subject"
  if (/^From .+:.+/i.test(t)) return true;
  // Pattern 2: starts with common email body openings (raw body text, not an AI summary)
  if (/^(Dear |Hi[, ]|Hello |Greetings|Thank you|Thanks for|We are |We have |We would|We're |Please |Your SIP|Your account|You have |To view |You are |This is to |As per |Kindly |Attached |Find attached|Congratulations|I am |I'm |I would|Welcome to|Good morning|Good afternoon|Good evening|Folio|Team,|FYI|PFA|Reminder:|Note:|Update:|Important:)/i.test(t)) return true;
  // Pattern 3: too long to be an AI summary (>160 chars = probably raw body)
  if (t.length > 160) return true;
  return false;
}

function heuristicSummary(email) {
  const bodyText = (email.body_preview || '').trim().replace(/\s+/g, ' ');
  const sentences = bodyText.split(/[.!?]/);
  // Skip CSS-like lines (contain { or selectors like "div {", "margin:", "padding:")
  const isCss = (s) => /[{}]|:\s*\d|webkit|moz-|padding|margin:|font-size/.test(s);
  const first = sentences.find((s) => s.trim().length > 30 && !isCss(s));
  return first ? first.trim().substring(0, 140) : `From ${email.from_name || email.from_email}: ${email.subject}`;
}

function heuristicEmailType(email) {
  const subject = (email.subject || '').toLowerCase();
  const from    = (email.from_email || '').toLowerCase();
  if (/invoice|receipt|payment|refund|charge|billing|balance due|outstanding|subscription renewed|charged/.test(subject))
    return 'Financial';
  if (/meeting|calendar invite|interview|call scheduled|zoom|teams meet|rsvp/.test(subject))
    return 'Meeting';
  if (/action required|action needed|urgent|deadline|respond by|your response|confirm|verify|complete|sign|approve/.test(subject))
    return 'Action Required';
  if (/newsletter|% off|sale|limited time|exclusive|unsubscribe|discount|offer/.test(subject) ||
      /newsletter|noreply|no-reply|marketing|promo|offers@|deals@|news@/.test(from))
    return 'Promotional';
  return 'Informational';
}

function heuristicRiskLevel(email) {
  const subject = (email.subject || '').toLowerCase();
  if (/security alert|unauthorized|breach|compromised|payment failed|payment declined|account suspended|disabled|hacked|fraud/.test(subject))
    return 'High';
  if (/action required|urgent|deadline|expires|expiring|overdue|final notice|respond by/.test(subject))
    return 'Moderate';
  return 'Low';
}

function heuristicRecommendedAction(email) {
  const subject = (email.subject || '').toLowerCase();
  if (/security alert|unauthorized|payment failed|account suspended|disabled|urgent|action required|respond by|deadline|verify/.test(subject))
    return 'Required';
  if (/invoice|receipt|meeting|interview|renewal|expir|follow.?up|reminder|confirm/.test(subject))
    return 'Optional';
  return 'None';
}

// ── Amount extraction from email text ──
function heuristicFinancialImpact(email) {
  const text = `${email.subject || ''} ${(email.body_preview || '').substring(0, 600)}`;
  // ₹1,234.56 | Rs. 1234 | INR 1234 | $123 | USD 123
  const m = text.match(/(?:₹|rs\.?\s*|inr\s*|usd\s*|\$)\s*([\d,]+(?:\.\d{1,2})?)/i);
  if (m) {
    const raw = m[0].trim();
    const num = parseFloat(m[1].replace(/,/g, ''));
    if (num > 0 && num < 10000000) return raw;
  }
  return null;
}

// ── Deadline extraction from email text ──
function heuristicDeadline(email) {
  const text = `${email.subject || ''} ${(email.body_preview || '').substring(0, 600)}`;
  // "due on March 2, 2026" / "before 15 Mar 2026" / "by 02/03/2026" / "expires 2nd March"
  const patterns = [
    /(?:due|before|by|expires?|deadline|renew|valid till|last date)[:\s]+([\d]{1,2}[\/-][\d]{1,2}[\/-][\d]{2,4})/i,
    /(?:due|before|by|expires?|deadline|renew|valid till|last date)[:\s]+([\d]{1,2}\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s*,?\s*\d{2,4})/i,
    /(?:due|before|by|expires?|deadline|renew|valid till|last date)[:\s]+((?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+\d{1,2}(?:st|nd|rd|th)?,?\s*\d{2,4})/i,
    /([\d]{1,2}\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s*,?\s*\d{4})/i,
    /((?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+\d{1,2}(?:st|nd|rd|th)?,?\s*\d{4})/i,
  ];
  for (const pat of patterns) {
    const m = text.match(pat);
    if (m) {
      try {
        const d = new Date(m[1].replace(/(\d)(st|nd|rd|th)/i, '$1'));
        if (!isNaN(d.getTime()) && d.getTime() > Date.now() - 7 * 86400000)
          return d.toISOString().split('T')[0];
      } catch (_) {}
    }
  }
  return null;
}

function heuristicSenderImportance(email) {
  const from = (email.from_email || '').toLowerCase();
  const subject = (email.subject || '').toLowerCase();
  if (/github\.com|google\.com|microsoft\.com|apple\.com|amazon\.com|stripe\.com|paypal\.com|bank|chase\.com|payroll/.test(from))
    return 'High';
  if (/noreply|no-reply|newsletter|marketing|promo|notifications@|updates@/.test(from) ||
      /unsubscribe|newsletter|% off|sale/.test(subject))
    return 'Low';
  return 'Normal';
}

// ─────────────────────────────────────────────
// AI analysis (single combined call per email)
// ─────────────────────────────────────────────

async function analyseEmail(email) {
  const prompt =
    `You are ARIA, an executive email triage assistant.\n` +
    `Analyse this email and return ONLY valid JSON (no markdown, no code block):\n` +
    `{\n` +
    `  "category": "urgent|action|fyi|noise",\n` +
    `  "email_type": "Action Required|Informational|Financial|Meeting|Promotional",\n` +
    `  "classification_line": "One-line: [Type] from [Sender] re: [Topic]",\n` +
    `  "summary": "2-sentence executive summary, max 30 words total. No full email text.",\n` +
    `  "recommended_action": "Required|Optional|None",\n` +
    `  "risk_level": "Low|Moderate|High",\n` +
    `  "deadline": "ISO 8601 date string if a deadline is detected, else null",\n` +
    `  "financial_impact": "Amount or brief description if financial content present, else null",\n` +
    `  "sender_importance": "High|Normal|Low",\n` +
    `  "smart_action": {\n` +
    `    "suggestion": "recommended next step for the user in max 10 words",\n` +
    `    "cta": "2-3 word button label",\n` +
    `    "type": "security|payment|task|info|calendar|account"\n` +
    `  }\n` +
    `}\n\n` +
    `category: urgent = needs action today | action = task/request, not time-critical | fyi = informational | noise = marketing/newsletter\n` +
    `risk_level: High = security/fraud/payment failure/account suspension | Moderate = deadline/expiry/action needed | Low = everything else\n` +
    `recommended_action: Required = user must act | Optional = worth reviewing | None = no action needed\n` +
    `sender_importance: High = bank/payment processor/security/major service | Low = newsletter/marketing | Normal = everything else\n` +
    `For noise emails return: {"category":"noise","email_type":"Promotional","classification_line":null,"summary":null,"recommended_action":"None","risk_level":"Low","deadline":null,"financial_impact":null,"sender_importance":"Low","smart_action":null}\n\n` +
    `From: ${email.from_name || email.from_email}\n` +
    `Subject: ${email.subject}\n` +
    `Body: ${(email.body_preview || '').substring(0, 500)}`;

  const _buildResult = (data, fallback = false) => {
    const validCats = ['urgent', 'action', 'fyi', 'noise'];
    const validTypes = ['Action Required', 'Informational', 'Financial', 'Meeting', 'Promotional'];
    const validRisk  = ['Low', 'Moderate', 'High'];
    const validRA    = ['Required', 'Optional', 'None'];
    const validSI    = ['High', 'Normal', 'Low'];

    const category   = validCats.includes(data.category) ? data.category : heuristicCategory(email);
    if (category === 'noise') return { category: 'noise', email_type: 'Promotional', summary: null, classification_line: null, recommended_action: 'None', risk_level: 'Low', deadline: null, financial_impact: null, sender_importance: 'Low', smart_action: null };

    const email_type          = validTypes.includes(data.email_type)          ? data.email_type          : heuristicEmailType(email);
    const risk_level          = validRisk.includes(data.risk_level)           ? data.risk_level          : heuristicRiskLevel(email);
    const recommended_action  = validRA.includes(data.recommended_action)     ? data.recommended_action  : heuristicRecommendedAction(email);
    const sender_importance   = validSI.includes(data.sender_importance)      ? data.sender_importance   : heuristicSenderImportance(email);
    const summary             = typeof data.summary === 'string' && data.summary.trim() ? data.summary.trim() : heuristicSummary(email);
    const classification_line = typeof data.classification_line === 'string'  ? data.classification_line : null;
    const deadline            = data.deadline || null;
    const financial_impact    = data.financial_impact || null;

    const base_action = (!fallback && data.smart_action && data.smart_action.suggestion)
      ? data.smart_action
      : heuristicSmartAction(email);

    // Pack all triage meta into smart_action for persistence (no schema change required)
    const smart_action = {
      ...base_action,
      email_type, classification_line, recommended_action,
      risk_level, deadline, financial_impact, sender_importance
    };

    return { category, email_type, summary, classification_line, recommended_action, risk_level, deadline, financial_impact, sender_importance, smart_action };
  };

  // Short-circuit: pure heuristics for clearly-FYI emails — zero AI calls
  if (heuristicCategory(email) === 'fyi') {
    return _buildResult({}, true);
  }

  // ── Try Ollama (local, free) ──
  try {
    const running = await ollama.isRunning();
    if (running) {
      const resp  = await ollama.call(
        OLLAMA_EMAIL_MODEL,
        [{ role: 'user', content: prompt }],
        { temperature: 0.2, max_tokens: 400, timeout: OLLAMA_EMAIL_TIMEOUT }
      );
      const text  = typeof resp === 'string' ? resp : '';
      const match = text.match(/\{[\s\S]*\}/);
      if (!match) throw new Error('No JSON in Ollama response');
      const data = JSON.parse(match[0]);
      console.log('[Gmail] analyseEmail via Ollama ✓', email.subject?.substring(0, 40));
      return _buildResult(data, false);
    } else {
      console.log('[Gmail] Ollama offline — using heuristics for:', email.subject?.substring(0, 40));
    }
  } catch (err) {
    console.log('[Gmail] Ollama analysis failed for', email.subject?.substring(0, 40), '—', err.message.substring(0, 80));
  }

  // ── Heuristic fallback (FREE — no external API) ──
  return _buildResult({}, true);
}

// ─────────────────────────────────────────────
// Subscription auto-upsert helper
// Deduplicates by service name (case-insensitive).
// Updates renewal date if a newer one is found.
// ─────────────────────────────────────────────

function upsertSubscription(opp, messageId) {
  if (!opp || !opp.service_name) return;
  try {
    const name        = opp.service_name.trim();
    const period      = opp.period  || 'monthly';
    const amount      = opp.amount  || null;
    const renewalTs   = opp.renewal_date
      ? Math.floor(new Date(opp.renewal_date).getTime() / 1000)
      : null;
    const now = Math.floor(Date.now() / 1000);

    // Check if this service already exists (case-insensitive name match)
    const existing = get(
      `SELECT id, next_renewal FROM subscriptions WHERE LOWER(name) = LOWER(?)`,
      [name]
    );

    if (existing) {
      // Update if we have a newer/more specific renewal date, or refresh amount
      const shouldUpdate = renewalTs && (!existing.next_renewal || renewalTs > existing.next_renewal);
      if (shouldUpdate || amount) {
        run(
          `UPDATE subscriptions SET
             amount = COALESCE(?, amount),
             period = ?,
             next_renewal = COALESCE(?, next_renewal),
             source_email_id = ?,
             auto_detected = 1,
             updated_at = ?
           WHERE id = ?`,
          [amount, period, renewalTs, messageId, now, existing.id]
        );
        console.log(`[Subs] Updated subscription: ${name}`);
      }
    } else {
      run(
        `INSERT INTO subscriptions
           (name, amount, currency, period, next_renewal, source_email_id, auto_detected, created_at, updated_at)
         VALUES (?, ?, 'INR', ?, ?, ?, 1, ?, ?)`,
        [name, amount, period, renewalTs, messageId, now, now]
      );
      console.log(`[Subs] Auto-detected new subscription: ${name}`);
    }

    // Auto-create a reminder task for this renewal
    if (renewalTs) createRenewalReminder(name, amount, period, renewalTs);
  } catch (err) {
    console.error('[Subs] upsertSubscription error:', err.message);
  }
}

// Creates (or updates) a reminder task 3 days before subscription renewal.
function createRenewalReminder(name, amount, period, renewalTs) {
  try {
    const title    = `${name} renewal`;
    const dueAt    = renewalTs - (3 * 86400); // warn 3 days early
    const subtitle = `${amount ? amount + ' · ' : ''}${period} · Review before billing · Added by ARIA`;
    const existing = get(
      `SELECT id, due_at FROM reminders WHERE LOWER(title) = LOWER(?) AND completed = 0`,
      [title]
    );
    if (existing) {
      if (Math.abs(existing.due_at - dueAt) > 86400) {
        run(`UPDATE reminders SET due_at = ?, subtitle = ? WHERE id = ?`, [dueAt, subtitle, existing.id]);
      }
    } else {
      run(
        `INSERT INTO reminders (title, due_at, category, subtitle, source, created_at)
         VALUES (?, ?, 'subscription', ?, 'subscription', ?)`,
        [title, dueAt, subtitle, Math.floor(Date.now() / 1000)]
      );
      console.log(`[Subs] Created renewal task: ${title}`);
    }
  } catch (err) {
    console.error('[Subs] createRenewalReminder error:', err.message);
  }
}

// ─────────────────────────────────────────────
// Email deadline extraction
// Detects "reply by X", "deadline X", "due by X" patterns and auto-creates tasks
// ─────────────────────────────────────────────

const DEADLINE_TRIGGER_PATTERNS = [
  /reply\s+by/i, /respond\s+by/i, /response\s+due/i, /response\s+required/i,
  /deadline[:\s]/i, /due\s+by/i, /due\s+date/i,
  /rsvp\s+by/i, /rsvp\s+before/i, /confirm\s+by/i, /please\s+confirm/i,
  /action\s+required\s+by/i, /action\s+needed\s+by/i,
  /complete\s+by/i, /submit\s+by/i, /send\s+by/i,
  /by\s+eod/i, /by\s+cob/i, /by\s+end\s+of\s+day/i, /by\s+end\s+of\s+week/i,
  /by\s+tomorrow/i, /respond\s+before/i,
  /before\s+(monday|tuesday|wednesday|thursday|friday|saturday|sunday)/i,
  /by\s+(monday|tuesday|wednesday|thursday|friday|saturday|sunday)/i,
  /by\s+\d{1,2}\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)/i,
  /within\s+\d+\s+(hour|day|business\s*day)/i
];

function hasDeadlineTrigger(text) {
  return DEADLINE_TRIGGER_PATTERNS.some(p => p.test(text));
}

async function detectEmailDeadline(email) {
  if (!email || !email.body_preview) return;
  if (isPaymentEmail(email)) return; // handled by subscription pipeline

  const bodyText = `Subject: ${email.subject}\n${email.body_preview}`;
  if (!hasDeadlineTrigger(bodyText)) return;

  const today = new Date().toISOString().split('T')[0];
  const prompt =
    `This email may require action by a specific date.\n` +
    `Extract as JSON: { "task_title": "string", "due_date": "YYYY-MM-DD or null", "has_deadline": true|false }\n` +
    `- task_title: a short actionable task (e.g. "Reply to John about proposal", "RSVP for Tech Meetup")\n` +
    `- due_date: exact date if mentioned, else null\n` +
    `- has_deadline: false if this is just informational — no real action deadline\n` +
    `Today is ${today}. Return JSON only.\n\n` +
    `From: ${email.from_name || email.from_email}\n` +
    `Subject: ${email.subject}\n` +
    `Body: ${(email.body_preview || '').substring(0, 400)}`;

  // ── Try Ollama (local, free) — skip entirely if offline ──
  let data = null;
  try {
    const running = await ollama.isRunning();
    if (!running) return; // skip, don't hit external APIs for deadline extraction
    const response = await ollama.call(
      OLLAMA_EMAIL_MODEL,
      [{ role: 'user', content: prompt }],
      { temperature: 0.1, max_tokens: 150 }
    );
    const text  = typeof response === 'string' ? response : '';
    const match = text.match(/\{[\s\S]*?\}/);
    if (!match) return;
    data = JSON.parse(match[0]);
  } catch (err) {
    console.log('[Gmail] Ollama deadline detection failed — skipping');
    return; // skip, don't escalate to external API
  }
  try {
    if (!data || !data.has_deadline || !data.task_title) return;

    const dueTs = data.due_date
      ? Math.floor(new Date(data.due_date + 'T18:00:00').getTime() / 1000)
      : Math.floor(Date.now() / 1000) + 24 * 3600; // default: tomorrow EOD

    const title    = data.task_title.substring(0, 100);
    const subtitle = `From ${email.from_name || email.from_email} \u00b7 ${email.subject} \u00b7 Added by ARIA`;

    const exists = get(
      `SELECT id FROM reminders WHERE LOWER(title) = LOWER(?) AND completed = 0`, [title]
    );
    if (!exists) {
      run(
        `INSERT INTO reminders (title, due_at, category, subtitle, source, created_at)
         VALUES (?, ?, 'task', ?, 'email', ?)`,
        [title, dueTs, subtitle, Math.floor(Date.now() / 1000)]
      );
      console.log(`[Deadline] Created task from email: ${title}`);
    }
  } catch (err) {
    console.error('[Gmail] detectEmailDeadline error:', err.message);
  }
}

// ─────────────────────────────────────────────
// Cross-reference: urgent email + calendar
// If someone sends an urgent email and you have a meeting with them soon
// ─────────────────────────────────────────────

function crossReferenceWithCalendar(email, category) {
  if (category !== 'urgent') return;
  try {
    const senderName = (email.from_name || '').trim();
    if (!senderName || senderName.length < 3) return;

    const now     = Math.floor(Date.now() / 1000);
    const next24h = now + 24 * 3600;
    // Match on first name (ignore common single-word senders like 'GitHub')
    const firstName = senderName.split(/\s+/)[0];
    if (firstName.length < 3) return;

    const events = all(
      `SELECT * FROM calendar_events WHERE start_at >= ? AND start_at <= ? AND (title LIKE ? OR description LIKE ?)`,
      [now, next24h, `%${firstName}%`, `%${firstName}%`]
    );
    if (events.length === 0) return;

    const event     = events[0];
    const eventTime = new Date(event.start_at * 1000).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
    const title     = `\u26a1 ${senderName} emailed urgently \u2014 you meet at ${eventTime}`;
    const subtitle  = `${email.subject} \u00b7 ${event.title} \u00b7 Added by ARIA`;

    const exists = get(
      `SELECT id FROM reminders WHERE LOWER(title) = LOWER(?) AND completed = 0`, [title]
    );
    if (!exists) {
      run(
        `INSERT INTO reminders (title, due_at, category, subtitle, source, created_at)
         VALUES (?, ?, 'task', ?, 'email', ?)`,
        [title, event.start_at - 30 * 60, subtitle, Math.floor(Date.now() / 1000)]
      );
      console.log(`[CrossRef] Combined alert created: ${title}`);
    }
  } catch (err) {
    console.error('[Gmail] crossReferenceWithCalendar error:', err.message);
  }
}

// ─────────────────────────────────────────────
// Reminder opportunity detection
// ─────────────────────────────────────────────

// ─────────────────────────────────────────────
// Heuristic reminder extraction (zero-AI fallback)
// ─────────────────────────────────────────────
function heuristicReminderData(email) {
  const text = `${email.subject} ${email.body_preview || ''}`.toLowerCase();
  // Extract amount — ₹ or Rs or INR followed by number
  const amtMatch = text.match(/(₹|rs\.?\s*|inr\s*)(\d[\d,]*(?:\.\d{1,2})?)/i);
  const amount = amtMatch ? `₹${amtMatch[2].replace(/,/g, '')}` : null;
  // Try to extract service name from sender / subject
  let service_name = (email.from_name && email.from_name.length > 2 && email.from_name.length < 40)
    ? email.from_name
    : (email.from_email || '').split('@')[1]?.split('.')[0] || 'Subscription';

  // Clean known brand names
  const brandMap = {
    'hdfc life': /hdfc\s*life/i, 'HDFC Bank': /hdfc\s*bank/i, 'ICICI Lombard': /icici\s*lombard/i,
    'ICICI Prudential': /icici\s*pru/i, 'SBI Life': /sbi\s*life/i, 'LIC': /\blic\b/i,
    'Max Life': /max\s*life/i, 'Bajaj Allianz': /bajaj\s*allianz/i, 'Tata AIA': /tata\s*aia/i,
    'Star Health': /star\s*health/i,
  };
  for (const [clean, re] of Object.entries(brandMap)) {
    if (re.test(text)) { service_name = clean; break; }
  }

  // Period detection — include insurance patterns
  const period = /annual|yearly|year|premium\s*(?:due|payment|amount)/i.test(text) ? 'yearly'
    : /one[- ]?time|single/i.test(text) ? 'one-time'
    : 'monthly';

  // Try to extract actual date from email before falling back to estimated
  const extractedDeadline = heuristicDeadline(email);
  let renewal_date = null;
  if (extractedDeadline) {
    renewal_date = extractedDeadline;
  } else if (period !== 'one-time') {
    const today = new Date();
    if (period === 'yearly') today.setFullYear(today.getFullYear() + 1);
    else today.setMonth(today.getMonth() + 1);
    renewal_date = today.toISOString().split('T')[0];
  }

  return { service_name, amount, period, renewal_date };
}

async function detectReminderOpportunity(email) {
  if (!isPaymentEmail(email)) return null;

  const today = new Date().toISOString().split('T')[0];
  const prompt =
    `This email is about a payment or subscription.\n` +
    `Extract as JSON: { "service_name": "...", "amount": "...", "currency": "INR", "renewal_date": "YYYY-MM-DD or null", "period": "monthly|yearly|one-time|null" }\n` +
    `If monthly, renewal_date = one month from ${today}. If yearly, one year from ${today}.\n` +
    `Be specific with service names (e.g. "GitHub Copilot" not "GitHub").\n` +
    `Return JSON only. If nothing meaningful, return null.\n\n` +
    `Subject: ${email.subject}\nFrom: ${email.from_name || email.from_email}\n` +
    `Body: ${(email.body_preview || '').substring(0, 400)}`;

  let data = null;

  // ── Try Ollama (local, free) ──
  try {
    const running = await ollama.isRunning();
    if (running) {
      const response = await ollama.call(
        OLLAMA_EMAIL_MODEL,
        [{ role: 'user', content: prompt }],
        { temperature: 0.1, max_tokens: 200 }
      );
      const text  = typeof response === 'string' ? response : '';
      const match = text.match(/\{[\s\S]*?\}/);
      if (match) data = JSON.parse(match[0]);
    }
  } catch (err) {
    console.log('[Gmail] Ollama reminder detection failed — using heuristics');
  }

  // ── Heuristic fallback (FREE) ──
  if (!data || !data.service_name || data.service_name === '...') {
    data = heuristicReminderData(email);
  }

  if (!data || !data.service_name) return null;

  const dateStr  = data.renewal_date && data.renewal_date !== 'null' ? data.renewal_date : null;
  const currency = data.currency || 'INR';
  const rawAmt   = data.amount && data.amount !== '...' ? data.amount : null;
  const amount   = rawAmt ? (rawAmt.startsWith('₹') ? rawAmt : `${currency !== 'INR' ? currency : '₹'}${rawAmt}`) : null;
  const period   = data.period && data.period !== 'null' ? data.period : 'monthly';

  const opp = {
    shouldRemind:  true,
    service_name:  data.service_name,
    renewal_date:  dateStr,
    amount,
    period,
    suggestion: `Remind me to renew ${data.service_name}${amount ? ` (${amount})` : ''}${dateStr ? ` on ${dateStr}` : ''}`
  };

  // Auto-write to subscriptions table
  upsertSubscription(opp, email.message_id);
  return opp;
}

// ─────────────────────────────────────────────
// Token management
// ─────────────────────────────────────────────

async function getValidAccessToken(forceRefresh = false) {
  const accessToken  = getSetting('gmail_access_token');
  // Use keytar-injected token first (preferred), fall back to DB (legacy plain-text)
  const refreshToken = getKeyedRefreshToken() || getSetting('gmail_refresh_token');
  const expiresAt    = parseInt(getSetting('gmail_token_expires') || '0', 10);
  const clientId     = getSetting('gmail_client_id');
  const clientSecret = getSetting('gmail_client_secret');

  if (!accessToken || !clientId || !clientSecret) {
    throw new Error('Gmail not configured. Please connect via Settings.');
  }

  // Refresh if token is expiring within 5 minutes OR if forced (e.g. after a 401)
  const now = Math.floor(Date.now() / 1000);
  if (forceRefresh || now >= expiresAt - 300) {
    if (!refreshToken) throw new Error('No refresh token — please reconnect Gmail in Settings.');
    const data = await refreshAccessToken(refreshToken, clientId, clientSecret);
    if (data.error) throw new Error(`Token refresh failed: ${data.error_description || data.error}`);

    const newExpiry = now + (data.expires_in || 3600);
    run("INSERT OR REPLACE INTO settings(key,value) VALUES('gmail_access_token',?)", [data.access_token]);
    run("INSERT OR REPLACE INTO settings(key,value) VALUES('gmail_token_expires',?)", [String(newExpiry)]);
    console.log('[Gmail] Access token refreshed, expires in', data.expires_in, 'seconds');

    return data.access_token;
  }

  return accessToken;
}

// ─────────────────────────────────────────────
// Gmail API helpers
// ─────────────────────────────────────────────

async function gmailFetch(path, options = {}, _isRetry = false) {
  const token = await getValidAccessToken(_isRetry);
  const res = await fetch(`${BASE}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...(options.headers || {})
    }
  });

  // On 401 — force-refresh the token and retry exactly once
  if (res.status === 401 && !_isRetry) {
    console.warn('[Gmail] Got 401, forcing token refresh and retrying...');
    return gmailFetch(path, options, true /* isRetry */);
  }

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Gmail API ${path} → ${res.status}: ${body}`);
  }
  return res.json();
}

/**
 * Properly convert HTML email body to plain text.
 * Strips <style>/<script> content, HTML tags, and decodes entities.
 */
function cleanHtmlBody(raw) {
  return raw
    .replace(/<style[\s\S]*?<\/style>/gi, '')   // strip entire style blocks (CSS)
    .replace(/<script[\s\S]*?<\/script>/gi, '')  // strip entire script blocks
    .replace(/<head[\s\S]*?<\/head>/gi, '')       // strip entire head section
    .replace(/<br\s*\/?>/gi, ' ')                 // <br> → space
    .replace(/<\/(?:p|div|tr|td|li|h[1-6])>/gi, ' ') // block-end tags → space
    .replace(/<[^>]+>/g, '')                      // strip all remaining tags
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#\d+;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Extract plain-text body from a Gmail message payload (recursive through parts).
 */
function extractBody(payload) {
  if (!payload) return '';

  if (payload.body && payload.body.data) {
    return Buffer.from(payload.body.data, 'base64').toString('utf-8');
  }

  if (payload.parts) {
    // Prefer text/plain
    for (const part of payload.parts) {
      if (part.mimeType === 'text/plain') {
        const text = extractBody(part);
        if (text) return text;
      }
    }
    // Fallback to first part with data
    for (const part of payload.parts) {
      const text = extractBody(part);
      if (text) return text;
    }
  }

  return '';
}

function getHeader(headers, name) {
  const h = (headers || []).find((h) => h.name.toLowerCase() === name.toLowerCase());
  return h ? h.value : '';
}

// ─────────────────────────────────────────────
// Cached fallback
// ─────────────────────────────────────────────

function parseEmailJson(email) {
  if (typeof email.reminder_opportunity === 'string') {
    try { email.reminder_opportunity = JSON.parse(email.reminder_opportunity); } catch (_) { email.reminder_opportunity = null; }
  }
  if (typeof email.smart_action === 'string') {
    try { email.smart_action = JSON.parse(email.smart_action); } catch (_) { email.smart_action = heuristicSmartAction(email); }
  }
  if (!email.smart_action) email.smart_action = heuristicSmartAction(email);
  return email;
}

function getCachedFallback(errorMsg) {
  const cached = all(
    `SELECT * FROM email_cache WHERE category != 'noise'
     ORDER BY CASE category WHEN 'urgent' THEN 1 WHEN 'action' THEN 2 WHEN 'fyi' THEN 3 ELSE 4 END,
              received_at DESC LIMIT 50`
  ).map(parseEmailJson);
  const noiseRow = get("SELECT COUNT(*) as n FROM email_cache WHERE category='noise'");
  return {
    emails: cached,
    noiseCount: noiseRow?.n || 0,
    cached: true,
    error: errorMsg,
    lastUpdated: Math.floor(Date.now() / 1000)
  };
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// ─────────────────────────────────────────────
// Gmail Batch API — single HTTP request for multiple messages
// https://developers.google.com/gmail/api/guides/batch
// Chunked at safe quota sizes. 429 parts within a batch are retried
// individually with exponential back-off so no messages are lost.
// ─────────────────────────────────────────────

/**
 * Fetch multiple Gmail messages in one batch HTTP request per chunk.
 * Retries any parts that return 429 with exponential back-off.
 *
 * @param {string[]} gmailIds        - Gmail API message IDs
 * @param {'full'|'metadata'} format
 * @param {string[]} metadataHeaders - Only used for format=metadata
 * @returns {Promise<object[]>}      - Parsed Gmail message objects
 */
async function batchFetchMessages(gmailIds, format = 'full', metadataHeaders = []) {
  if (gmailIds.length === 0) return [];

  const chunkSize = format === 'metadata' ? BATCH_CHUNK_META : BATCH_CHUNK_FULL;
  const results   = [];

  // Process in safe-sized chunks with a pause between them
  for (let start = 0; start < gmailIds.length; start += chunkSize) {
    const chunk    = gmailIds.slice(start, start + chunkSize);
    const chunkRes = await _batchChunkWithRetry(chunk, format, metadataHeaders);
    results.push(...chunkRes);
    if (start + chunkSize < gmailIds.length) await sleep(400); // pace between chunks
  }

  return results;
}

/**
 * Execute one batch chunk with up to 3 retry rounds for 429 parts.
 * Each retry waits longer and only re-requests the failed IDs.
 */
async function _batchChunkWithRetry(ids, format, metadataHeaders, attempt = 0) {
  if (ids.length === 0) return [];

  const token    = await getValidAccessToken();
  const boundary = `batch_aria_${Date.now()}_${attempt}`;

  const metaParam = metadataHeaders.length
    ? `&metadataHeaders=${metadataHeaders.join('&metadataHeaders=')}`
    : '';

  // Each part tagged Content-ID <idx> so we can map back to the original ID
  const parts = ids.map((id, i) =>
    `--${boundary}\r\n` +
    `Content-Type: application/http\r\n` +
    `Content-ID: <item${i}>\r\n` +
    `\r\n` +
    `GET /gmail/v1/users/me/messages/${id}?format=${format}${metaParam} HTTP/1.1\r\n` +
    `\r\n`
  );
  const body = parts.join('') + `--${boundary}--`;

  let res;
  try {
    res = await fetch(BATCH_BASE, {
      method:  'POST',
      headers: {
        Authorization:  `Bearer ${token}`,
        'Content-Type': `multipart/mixed; boundary=${boundary}`
      },
      body
    });
  } catch (netErr) {
    console.error('[Gmail] Batch network error:', netErr.message);
    return [];
  }

  // Whole-request 429 — back off and retry entire chunk
  if (res.status === 429) {
    if (attempt >= 3) { console.warn('[Gmail] Batch 429 — giving up after 3 retries'); return []; }
    const delay = [2000, 5000, 10000][attempt];
    console.log(`[Gmail] Whole-batch 429 — waiting ${delay}ms then retrying (attempt ${attempt + 1})`);
    await sleep(delay);
    return _batchChunkWithRetry(ids, format, metadataHeaders, attempt + 1);
  }

  if (!res.ok) {
    const errText = await res.text();
    console.error(`[Gmail] Batch HTTP ${res.status}:`, errText.substring(0, 200));
    return [];
  }

  const responseText = await res.text();
  const { results, retryIndices } = parseBatchResponse(responseText, ids);

  // Per-part 429s — retry just those IDs after a delay
  if (retryIndices.length > 0 && attempt < 3) {
    const retryIds = retryIndices.map(i => ids[i]);
    const delay    = [1500, 3000, 6000][attempt];
    console.log(`[Gmail] ${retryIds.length} part(s) 429'd — retrying in ${delay}ms (attempt ${attempt + 1})`);
    await sleep(delay);
    const retried = await _batchChunkWithRetry(retryIds, format, metadataHeaders, attempt + 1);
    results.push(...retried);
  }

  return results;
}

/**
 * Parse Gmail batch API multipart/mixed response.
 * Returns successfully-parsed objects AND the indices of parts that returned 429
 * (so the caller can retry just those IDs).
 *
 * @returns {{ results: object[], retryIndices: number[] }}
 */
function parseBatchResponse(text, ids = []) {
  const results      = [];
  const retryIndices = [];

  // Find boundary from first non-empty line
  const firstLine = text.split('\n').find(l => l.trim().startsWith('--'));
  if (!firstLine) { console.error('[Gmail] parseBatchResponse: no boundary'); return { results, retryIndices }; }
  const boundary = firstLine.trim().replace(/^--/, '');
  const sections = text.split(`--${boundary}`);

  for (const section of sections) {
    const trimmed = section.trim();
    if (!trimmed || trimmed === '--') continue;

    // Outer part headers end at first blank line
    const outerBodyStart = trimmed.indexOf('\r\n\r\n');
    if (outerBodyStart === -1) continue;
    const httpPart = trimmed.substring(outerBodyStart + 4);

    // Extract Content-ID index from outer headers so we know which ID this part is for
    const cidMatch  = trimmed.match(/Content-ID:\s*<item(\d+)>/i);
    const partIndex = cidMatch ? parseInt(cidMatch[1], 10) : -1;

    // HTTP response: status line, headers, blank line, body
    const httpBodyStart = httpPart.indexOf('\r\n\r\n');
    if (httpBodyStart === -1) continue;

    const statusLine = httpPart.substring(0, httpPart.indexOf('\r\n'));
    const statusCode = parseInt((statusLine.split(' ')[1] || '0'), 10);

    if (statusCode === 429) {
      if (partIndex >= 0) retryIndices.push(partIndex);
      continue;
    }
    if (statusCode !== 200) {
      if (statusCode >= 400) console.warn(`[Gmail] Batch part ${partIndex} status ${statusCode} — skipping`);
      continue;
    }

    const jsonBody = httpPart.substring(httpBodyStart + 4).trim();
    try {
      results.push(JSON.parse(jsonBody));
    } catch (_) { /* trailing boundary markers — ignore */ }
  }

  return { results, retryIndices };
}

// ─────────────────────────────────────────────
// Gmail-style categorization (non-blocking, post-sync)
// Categories: primary | social | promotions | updates
// Urgency is a flag in smart_action, not a separate category
// ─────────────────────────────────────────────

const SOCIAL_SENDERS = [
  'facebook', 'facebookmail', 'linkedin', 'twitter', 'x.com', 'instagram',
  'whatsapp', 'snapchat', 'tiktok', 'reddit', 'discord',
  'telegram', 'pinterest', 'quora', 'medium.com', 'youtube'
];

const SOCIAL_SUBJECTS = [
  'friend request', 'tagged you', 'mentioned you', 'liked your', 'commented on',
  'followed you', 'shared a', 'posted in', 'invitation to connect', 'new follower',
  'endorsed you', 'reacted to', 'new connection'
];

function categorizeWithHeuristics(email) {
  const from = (email.from_email || '').toLowerCase();
  const subject = (email.subject || '').toLowerCase();
  const urgent = /security alert|unauthorized|account (locked|suspended)|payment (failed|declined)|fraud|breach|compromised/.test(subject);

  // Extract enrichment data
  const financial_impact    = heuristicFinancialImpact(email);
  const deadline            = heuristicDeadline(email);
  const email_type          = heuristicEmailType(email);
  const risk_level          = urgent ? 'High' : heuristicRiskLevel(email);
  const recommended_action  = heuristicRecommendedAction(email);
  const sender_importance   = heuristicSenderImportance(email);

  const buildAction = (base, isUrgent) => ({
    ...base, urgent: isUrgent, email_type, risk_level,
    recommended_action, sender_importance,
    ...(financial_impact ? { financial_impact } : {}),
    ...(deadline         ? { deadline }         : {}),
  });

  // Social
  if (SOCIAL_SENDERS.some(s => from.includes(s)) || SOCIAL_SUBJECTS.some(s => subject.includes(s))) {
    return { category: 'social', urgent, summary: heuristicSummary(email), smart_action: buildAction(heuristicSmartAction(email), urgent) };
  }
  // Promotions
  if (isNoise(email)) {
    return { category: 'promotions', urgent: false, summary: heuristicSummary(email), smart_action: buildAction(heuristicSmartAction(email), false) };
  }
  // Updates
  if (/noreply|no-reply|donotreply|notifications?@|alerts?@|updates?@|mailer-daemon/.test(from) ||
      /receipt|invoice|order|shipped|delivered|confirmation|verify|otp|password|transaction|debit|credit|upi|statement|bank alert/i.test(subject)) {
    return { category: 'updates', urgent, summary: heuristicSummary(email), smart_action: buildAction(heuristicSmartAction(email), urgent) };
  }
  // Primary
  return { category: 'primary', urgent, summary: heuristicSummary(email), smart_action: buildAction(heuristicSmartAction(email), urgent) };
}

async function categorizeWithOllama(email) {
  const prompt =
    `Classify this email and extract actionable intelligence.\n` +
    `Return ONLY valid JSON (no markdown, no code block):\n` +
    `{"category":"primary|social|promotions|updates","urgent":true|false,"summary":"1 sentence max 25 words","financial_impact":"amount string or null","deadline":"YYYY-MM-DD or null","recommended_action":"Required|Optional|None"}\n\n` +
    `Categories: primary (personal/work), social (social media), promotions (marketing/offers), updates (automated/receipts/OTP/bank)\n` +
    `urgent=true ONLY for: security breaches, payment failures, account lockouts, fraud, critical deadlines\n` +
    `financial_impact: Extract exact amount with currency if any payment/bill/charge/balance/premium/fee mentioned (e.g. "₹1,234"), else null\n` +
    `deadline: Extract due date/expiry/renewal date as YYYY-MM-DD if mentioned, else null\n` +
    `recommended_action: Required=user must act, Optional=worth reviewing, None=no action\n\n` +
    `From: ${email.from_name || email.from_email}\n` +
    `Subject: ${email.subject}\n` +
    `Body: ${(email.body_preview || '').substring(0, 400)}`;

  const resp = await ollama.call(
    OLLAMA_EMAIL_MODEL,
    [{ role: 'user', content: prompt }],
    { temperature: 0.2, max_tokens: 250, timeout: OLLAMA_EMAIL_TIMEOUT }
  );
  const text = typeof resp === 'string' ? resp : '';
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) throw new Error('No JSON in response');
  const data = JSON.parse(match[0]);

  const validCats = ['primary', 'social', 'promotions', 'updates'];
  const category = validCats.includes(data.category) ? data.category : 'primary';
  const urgent = data.urgent === true;
  const summary = typeof data.summary === 'string' && data.summary.trim().length > 5
    ? data.summary.trim() : heuristicSummary(email);

  // Merge AI extraction with heuristic fallbacks
  const financial_impact = data.financial_impact || heuristicFinancialImpact(email);
  const deadline         = data.deadline         || heuristicDeadline(email);
  const validRA          = ['Required', 'Optional', 'None'];
  const recommended_action = validRA.includes(data.recommended_action) ? data.recommended_action : heuristicRecommendedAction(email);

  return {
    category, urgent, summary,
    smart_action: {
      ...heuristicSmartAction(email), urgent,
      email_type: heuristicEmailType(email),
      risk_level: urgent ? 'High' : heuristicRiskLevel(email),
      sender_importance: heuristicSenderImportance(email),
      recommended_action,
      ...(financial_impact ? { financial_impact } : {}),
      ...(deadline         ? { deadline }         : {}),
    }
  };
}

/**
 * Non-blocking background categorization.
 * Picks uncategorized emails (summary IS NULL), uses Ollama or heuristics.
 * Called AFTER fetchEmails — never blocks email loading.
 */
async function categorizeEmails(onProgress) {
  const uncategorized = all(
    `SELECT * FROM email_cache WHERE summary IS NULL ORDER BY received_at DESC LIMIT 25`
  );
  if (uncategorized.length === 0) {
    console.log('[Gmail] No emails need categorization');
    return { categorized: 0, total: 0 };
  }

  console.log(`[Gmail] ── categorizeEmails: ${uncategorized.length} pending ──`);

  let ollamaUp = false;
  try { ollamaUp = await ollama.isRunning(); } catch (_) {}
  if (!ollamaUp) console.log('[Gmail] Ollama offline — heuristic categorization');

  let done = 0;
  for (const email of uncategorized) {
    let result;
    try {
      if (ollamaUp) {
        result = await categorizeWithOllama(email);
        console.log(`[Gmail] ✓ "${email.subject?.substring(0, 40)}" → ${result.category}${result.urgent ? ' ⚠' : ''}`);
      }
    } catch (err) {
      console.warn(`[Gmail] Ollama fail: ${err.message.substring(0, 60)}`);
    }
    if (!result) {
      result = categorizeWithHeuristics(email);
      console.log(`[Gmail] ⚡ "${email.subject?.substring(0, 40)}" → ${result.category}`);
    }
    // Detect subscription/payment opportunities inline
    let reminderOpp = null;
    if (isPaymentEmail(email)) {
      try {
        reminderOpp = await detectReminderOpportunity(email);
        if (reminderOpp) console.log(`[Gmail] 💰 Subscription detected: ${reminderOpp.service_name}`);
      } catch (err) {
        console.warn(`[Gmail] Reminder detection fail: ${err.message.substring(0, 60)}`);
      }
    }

    run(
      `UPDATE email_cache SET category = ?, summary = ?, smart_action = ?, reminder_opportunity = ? WHERE message_id = ?`,
      [result.category, result.summary, JSON.stringify(result.smart_action),
       reminderOpp ? JSON.stringify(reminderOpp) : null, email.message_id]
    );
    done++;
    if (onProgress) onProgress({ done, total: uncategorized.length, messageId: email.message_id });
    if (ollamaUp) await sleep(300);
  }

  console.log(`[Gmail] ── categorizeEmails DONE: ${done}/${uncategorized.length} ──`);
  return { categorized: done, total: uncategorized.length };
}

/**
 * On-demand AI summary for a single email via Ollama.
 */
async function summarizeEmail(messageId) {
  const row = get(`SELECT summary, subject, body_preview FROM email_cache WHERE message_id = ?`, [messageId]);
  if (!row) return { error: 'Email not found' };
  if (row.summary) return { summary: row.summary };

  const running = await ollama.isRunning();
  if (!running) return { error: 'Start Ollama for AI summaries' };

  const prompt = `Summarize this email in 2-3 concise sentences. Be direct and actionable.\n\nSubject: ${row.subject}\nBody: ${(row.body_preview || '').substring(0, 600)}`;
  const resp = await ollama.call(OLLAMA_EMAIL_MODEL, [{ role: 'user', content: prompt }], { temperature: 0.3, max_tokens: 150, timeout: OLLAMA_EMAIL_TIMEOUT });
  const summary = typeof resp === 'string' ? resp.trim() : 'Could not summarize.';
  run(`UPDATE email_cache SET summary = ? WHERE message_id = ?`, [summary, messageId]);
  return { summary };
}

// ─────────────────────────────────────────────
// Exported functions
// ─────────────────────────────────────────────

/**
 * Fetch and cache emails via Gmail REST API.
 * Wipes stale DB entries, fetches fresh from Gmail, stores with gmail_id as PK.
 * No AI — just raw sync. Returns all emails sorted by date.
 */
async function fetchEmails() {
  try {
    console.log('[Gmail] ── fetchEmails START ──');

    // ── Step 1: get inbox message IDs from Gmail ──
    const listData = await gmailFetch('/messages?maxResults=50&q=in:inbox');
    const gmailIds = (listData.messages || []).map(m => m.id);
    console.log(`[Gmail] Gmail returned ${gmailIds.length} inbox message IDs`);

    if (gmailIds.length === 0) {
      // Inbox is empty — clear cache and return empty
      run(`DELETE FROM email_cache`);
      return { emails: [], noiseCount: 0, fresh: true, lastUpdated: Math.floor(Date.now() / 1000) };
    }

    // ── Step 2: wipe any DB rows that are NOT in current inbox ──
    // This removes ALL old-format and stale rows in one shot.
    const placeholders = gmailIds.map(() => '?').join(',');
    run(`DELETE FROM email_cache WHERE message_id NOT IN (${placeholders})`, gmailIds);
    console.log('[Gmail] Cleaned stale rows from DB');

    // ── Step 3: check which IDs we already have ──
    const existingIds = new Set(
      all(`SELECT message_id FROM email_cache`).map(r => r.message_id)
    );
    const newIds = gmailIds.filter(id => !existingIds.has(id));
    console.log(`[Gmail] ${existingIds.size} already in DB | ${newIds.length} need fetching`);

    // ── Step 4: fetch each new message and write to DB immediately ──
    let stored = 0;
    for (let i = 0; i < newIds.length; i++) {
      const gid = newIds[i];
      try {
        const msg = await gmailFetch(`/messages/${gid}?format=full`);
        const headers  = msg.payload?.headers || [];
        const fromFull = getHeader(headers, 'From') || '';
        const subject  = getHeader(headers, 'Subject') || '(No subject)';
        const dateStr  = getHeader(headers, 'Date');

        const m = fromFull.match(/^(.*?)\s*<(.+?)>$/);
        const from_name  = m ? m[1].trim().replace(/^"|"$/g, '') : fromFull;
        const from_email = m ? m[2].toLowerCase() : fromFull.toLowerCase();

        const rawBody = extractBody(msg.payload);
        const body_preview = cleanHtmlBody(rawBody).substring(0, 600);

        const received_at = dateStr
          ? Math.floor(new Date(dateStr).getTime() / 1000)
          : Math.floor(Date.now() / 1000);

        run(
          `INSERT OR REPLACE INTO email_cache
             (message_id, gmail_id, from_name, from_email, subject, body_preview,
              summary, category, received_at, reminder_opportunity, smart_action)
           VALUES (?, ?, ?, ?, ?, ?, NULL, 'primary', ?, NULL, NULL)`,
          [gid, gid, from_name, from_email, subject, body_preview, received_at]
        );
        stored++;
        console.log(`[Gmail]  ${stored}/${newIds.length} "${subject.substring(0, 50)}"`);
      } catch (e) {
        console.warn(`[Gmail]  SKIP ${gid}: ${e.message}`);
      }
      if (i < newIds.length - 1) await sleep(200);
    }

    // ── Step 5: read everything from DB and return ──
    const emails = all(
      `SELECT * FROM email_cache ORDER BY received_at DESC LIMIT 50`
    ).map(parseEmailJson);

    console.log(`[Gmail] ── fetchEmails DONE: returning ${emails.length} emails ──`);
    return {
      emails,
      noiseCount: 0,
      fresh: true,
      lastUpdated: Math.floor(Date.now() / 1000)
    };

  } catch (err) {
    console.error('[Gmail] fetchEmails FAILED:', err.message, err.stack);
    // On error, return whatever is in DB
    const fallback = all(`SELECT * FROM email_cache ORDER BY received_at DESC LIMIT 50`).map(parseEmailJson);
    return {
      emails: fallback,
      noiseCount: 0,
      cached: true,
      error: err.message,
      lastUpdated: Math.floor(Date.now() / 1000)
    };
  }
}

/**
 * Mark a Gmail message as read (remove UNREAD label).
 * messageId is now always the Gmail API ID (used as PK in email_cache).
 */
async function markRead(messageId) {
  try {
    await gmailFetch(`/messages/${messageId}/modify`, {
      method: 'POST',
      body: JSON.stringify({ removeLabelIds: ['UNREAD'] })
    });
  } catch (err) {
    console.warn('[Gmail] markRead API error:', err.message);
  }
  // Remove from cache so it doesn't show next time
  run("DELETE FROM email_cache WHERE message_id=?", [messageId]);
  return { success: true };
}

/**
 * Move a Gmail message to Trash.
 */
async function trashEmail(messageId) {
  try {
    await gmailFetch(`/messages/${messageId}/trash`, { method: 'POST', body: '{}' });
  } catch (err) {
    console.warn('[Gmail] trashEmail API error:', err.message);
  }
  run('DELETE FROM email_cache WHERE message_id=?', [messageId]);
  return { success: true };
}

/**
 * Resolve a Message-ID header value or gmail alphanumeric ID to gmail API ID.
 * Tries to search Gmail if needed.
 */
async function resolveGmailId(messageId) {
  // If it looks like a Gmail API id (short alphanumeric, no angle brackets)
  if (messageId && !messageId.includes('@') && !messageId.startsWith('<')) {
    return messageId;
  }
  // Search by header
  try {
    const clean = messageId.replace(/[<>]/g, '').trim();
    const data = await gmailFetch(`/messages?q=rfc822msgid:${encodeURIComponent(clean)}&maxResults=1`);
    return data.messages?.[0]?.id || null;
  } catch (_) {
    return null;
  }
}

/**
 * Check whether Gmail credentials are stored in DB.
 */
function isGmailConfigured() {
  return !!(getSetting('gmail_access_token') && getSetting('gmail_client_id'));
}

/**
 * Send an email reply via Gmail API (P6-1).
 *
 * @param {string} originalMessageId - Gmail message ID to reply to
 * @param {string} draft - Plain-text body for the reply
 * @returns {{ success: boolean, messageId?: string, error?: string }}
 */
async function sendReply(originalMessageId, draft) {
  try {
    // Fetch the original message to get headers (To, Subject, threadId)
    const original = await gmailFetch(`/messages/${originalMessageId}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Message-ID&metadataHeaders=References`);
    const headers = original.payload?.headers || [];
    const getH = (name) => headers.find(h => h.name.toLowerCase() === name.toLowerCase())?.value || '';

    const toAddress   = getH('From');
    const subject     = getH('Subject').startsWith('Re:') ? getH('Subject') : `Re: ${getH('Subject')}`;
    const messageId   = getH('Message-ID');
    const references  = getH('References');
    const threadId    = original.threadId;

    // Build RFC 2822 message
    const newRefs = references ? `${references} ${messageId}` : messageId;
    const mime = [
      `To: ${toAddress}`,
      `Subject: ${subject}`,
      `In-Reply-To: ${messageId}`,
      `References: ${newRefs}`,
      'Content-Type: text/plain; charset=UTF-8',
      'MIME-Version: 1.0',
      '',
      draft,
    ].join('\r\n');

    // Base64url encode
    const encoded = Buffer.from(mime).toString('base64')
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

    const result = await gmailFetch('/messages/send', {
      method: 'POST',
      body: JSON.stringify({ raw: encoded, threadId }),
    });

    return { success: true, messageId: result.id };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

module.exports = { fetchEmails, categorizeEmails, summarizeEmail, markRead, trashEmail, isGmailConfigured, getValidAccessToken, sendReply };
