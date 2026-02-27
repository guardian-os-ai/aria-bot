/**
 * services/briefing.js — Morning briefing generator
 * Assembles context from emails, calendar, reminders, and weather,
 * then calls Haiku to generate a structured morning briefing.
 * Caches the briefing and schedules daily generation at 8:55 AM.
 */

const schedule = require('node-schedule');
const notifier = require('node-notifier');
const path = require('path');
const { getSetting, saveSetting, all } = require('../db/index.js');
const { aiCall } = require('./ai.js');
const weatherService = require('./weather.js');

// In-flight dedup: if a generation is already running, return the same promise
let _inFlight = null;

/**
 * Generate the morning briefing.
 * Returns cached version if < 4 hours old, otherwise generates fresh.
 * Concurrent calls share one in-flight promise.
 */
async function generateBriefing() {
  if (_inFlight) return _inFlight;  // already running — reuse
  _inFlight = _doGenerate().finally(() => { _inFlight = null; });
  return _inFlight;
}

async function _doGenerate() {
  const today = new Date().toISOString().split('T')[0];

  // Check cache
  const cachedBriefing = getSetting('briefing_today');
  const cachedDate = getSetting('briefing_today_date');
  const cachedAt = getSetting('briefing_today_at');

  if (cachedBriefing && cachedDate === today && cachedAt) {
    const ageHours = (Date.now() - parseInt(cachedAt)) / (1000 * 60 * 60);
    if (ageHours < 4) {
      try {
        return { ...JSON.parse(cachedBriefing), cached: true };
      } catch {
        // Cache corrupt, regenerate
      }
    }
  }

  // Don't hammer Gemini if it failed recently — wait 30 min before retrying
  const lastFailedAt = getSetting('briefing_last_failed_at');
  if (lastFailedAt) {
    const failedMinsAgo = (Date.now() - parseInt(lastFailedAt)) / (1000 * 60);
    if (failedMinsAgo < 30) {
      console.log(`[Briefing] Last AI attempt failed ${Math.round(failedMinsAgo)}m ago, using fallback (retrying in ${Math.round(30 - failedMinsAgo)}m)`);
      const context = await assembleBriefingContext();
      return { ...createFallbackBriefing(context), error: 'AI temporarily unavailable, retry in a few minutes.' };
    }
  }

  // Assemble context
  const context = await assembleBriefingContext();

  // Determine day load for dynamic tone
  const dayLoad = determineDayLoad(context);

  // Build prompt for AI (keep under 800 tokens total)
  const prompt = `You are ARIA, an executive chief-of-staff. Compress decisions. Never summarise.

Today: ${today}. Load: ${dayLoad.level}.

OVERDUE TASKS:
${context.overdueSummary || 'None.'}

DUE TODAY:
${context.dueTodaySummary || 'None.'}

FINANCIAL RENEWALS (7 days):
${context.renewalsSummary || 'None.'}${context.totalRenewalExposure > 0 ? `\nTotal exposure: ₹${Math.round(context.totalRenewalExposure).toLocaleString()}` : ''}

MEETINGS (24h):
${context.calendarSummary || 'None.'}

EMAIL VOLUME (last 12h):
${context.emailVolume12h ? `${context.emailVolume12h.total} received · ${context.emailVolume12h.urgent} urgent · ${context.emailVolume12h.action} need action` : context.emailSummary || 'None.'}

Produce an executive brief: 1 primary directive + 3 supporting signals + 1 optional optimization.
Total output: under 6 lines. No filler. No hedging.

Return ONLY valid JSON:
{
  "priority_action": "The single primary directive. Verb-first. The one thing that matters most right now. Never 'No urgent items'.",
  "dynamic_tone": "${dayLoad.level === 'heavy' ? 'High-load day. Prioritise ruthlessly.' : dayLoad.level === 'light' ? 'Low load. Use the space for deep work.' : 'Solid day. Execute the plan.'}",
  "email_bullets": [
    "Signal 1 — what carries the most risk or requires action now (max 12 words)",
    "Signal 2 — what can wait, or is lower priority (max 12 words)",
    "Signal 3 — financial exposure or deadline proximity note (max 12 words)"
  ],
  "timeline": [{"time": "HH:MM", "text": "description", "type": "meeting|task|email|break"}],
  "summary_line": "risk state in under 8 words — zero filler",
  "optimization": "One actionable process or behavioral insight. null if nothing meaningful.",
  "email_count": { "urgent": ${context.emailVolume12h?.urgent ?? context.emailCount?.urgent ?? 0}, "action": ${context.emailVolume12h?.action ?? context.emailCount?.action ?? 0}, "total": ${context.emailVolume12h?.total ?? context.emailCount?.total ?? 0} },
  "meeting_count": ${context.meetingCount || 0},
  "weather_brief": "temp and condition in one phrase"
}

Rules:
- priority_action: verb-first, specific, decisive. Max 20 words.
- email_bullets: exactly 3 signals. Cover risk / waiting / financial exposure.
- summary_line: compress the overall risk state. Under 8 words.
- timeline: max 4 items. Omit break filler.
- optimization: null unless genuinely useful.`;

  try {
    const result = await aiCall('briefing', prompt, {});

    // Parse JSON from response
    let briefing;
    try {
      // Extract JSON if wrapped in backticks or extra text
      const jsonMatch = result.match(/\{[\s\S]*\}/);
      if (!jsonMatch) throw new Error('No JSON in response');
      briefing = JSON.parse(jsonMatch[0]);
    } catch (parseErr) {
      console.error('[Briefing] JSON parse failed, using fallback');
      briefing = createFallbackBriefing(context);
    }

    // Enhance with raw data
    briefing.date = today;
    briefing.generated_at = Date.now();

    // Cache
    saveSetting('briefing_today', JSON.stringify(briefing));
    saveSetting('briefing_today_date', today);
    saveSetting('briefing_today_at', String(Date.now()));
    saveSetting('briefing_last_failed_at', '');  // clear failure record

    return briefing;
  } catch (err) {
    console.error('[Briefing] Generation failed:', err.message);
    // Record failure time to avoid hammering Gemini on every startup
    saveSetting('briefing_last_failed_at', String(Date.now()));

    // Return fallback briefing built from raw data
    const fallback = createFallbackBriefing(context);
    return { ...fallback, error: err.message };
  }
}

/**
 * Assemble context from all data sources.
 */
async function assembleBriefingContext() {
  const context = {
    emailSummary: '',
    calendarSummary: '',
    overdueSummary: '',
    weatherSummary: ''
  };

  // Top 3 urgent/action emails
  try {
    const emails = all(
      `SELECT subject, summary, category FROM email_cache 
       WHERE category IN ('urgent', 'action') 
       ORDER BY received_at DESC LIMIT 3`
    );
    if (emails.length > 0) {
      context.emailSummary = emails
        .map((e, i) => `${i + 1}. [${e.category}] ${e.subject} — ${e.summary || 'No summary'}`)
        .join('\n');
      context.emailCount = {
        urgent: all("SELECT COUNT(*) as c FROM email_cache WHERE category = 'urgent'")[0]?.c || 0,
        action: all("SELECT COUNT(*) as c FROM email_cache WHERE category = 'action'")[0]?.c || 0,
        total: all('SELECT COUNT(*) as c FROM email_cache')[0]?.c || 0
      };
    }
  } catch (err) {
    console.error('[Briefing] Email context error:', err.message);
  }

  // Calendar events within next 24 hours (not just today — catches late-night/next-morning meetings)
  try {
    const nowUnix = Math.floor(Date.now() / 1000);
    const in24h   = nowUnix + 24 * 3600;

    const events = all(
      'SELECT title, start_at, end_at, location FROM calendar_events WHERE start_at >= ? AND start_at <= ? ORDER BY start_at ASC',
      [nowUnix, in24h]
    );

    if (events.length > 0) {
      context.calendarSummary = events
        .map((e) => {
          const start = new Date(e.start_at * 1000);
          const time = start.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
          return `${time}: ${e.title}${e.location ? ` (${e.location})` : ''}`;
        })
        .join('\n');
      context.meetingCount = events.length;
    }
  } catch (err) {
    console.error('[Briefing] Calendar context error:', err.message);
  }

  // Overdue reminders
  try {
    const nowUnix = Math.floor(Date.now() / 1000);
    const overdue = all(
      'SELECT title, due_at FROM reminders WHERE due_at < ? AND completed = 0 ORDER BY due_at ASC LIMIT 5',
      [nowUnix]
    );

    if (overdue.length > 0) {
      context.overdueSummary = overdue
        .map((r) => `⚠️ ${r.title} (was due ${new Date(r.due_at * 1000).toLocaleDateString()})`)
        .join('\n');
      context.overdueCount = overdue.length;
      context.topOverdue = overdue[0]?.title;
    }
  } catch (err) {
    console.error('[Briefing] Reminders context error:', err.message);
  }

  // Upcoming tasks (not overdue, not completed)
  try {
    const nowUnix = Math.floor(Date.now() / 1000);
    const upcoming = all(
      'SELECT title FROM reminders WHERE due_at >= ? AND completed = 0 ORDER BY due_at ASC LIMIT 3',
      [nowUnix]
    );
    if (upcoming.length > 0) {
      context.upcomingTasks = upcoming.map(r => r.title);
      context.upcomingTasksSummary = upcoming.map(r => r.title).join(', ');
    }
  } catch (_) {}

  // Tasks due today (not overdue — due_at is today window)
  try {
    const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);
    const todayEnd   = new Date(); todayEnd.setHours(23, 59, 59, 999);
    const todayStartUnix = Math.floor(todayStart.getTime() / 1000);
    const todayEndUnix   = Math.floor(todayEnd.getTime() / 1000);
    const nowForToday    = Math.floor(Date.now() / 1000);

    const dueToday = all(
      'SELECT title, due_at FROM reminders WHERE due_at >= ? AND due_at <= ? AND completed = 0 ORDER BY due_at ASC LIMIT 5',
      [Math.max(nowForToday, todayStartUnix), todayEndUnix]
    );
    if (dueToday.length > 0) {
      context.dueTodayCount = dueToday.length;
      context.dueTodaySummary = dueToday.map(r => {
        const t = new Date(r.due_at * 1000).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
        return `${r.title} (${t})`;
      }).join(', ');
    }
  } catch (_) {}

  // Financial renewals within 7 days
  try {
    const nowUnix3 = Math.floor(Date.now() / 1000);
    const in7Days  = nowUnix3 + 7 * 86400;
    const renewals = all(
      'SELECT name, amount, next_renewal FROM subscriptions WHERE next_renewal >= ? AND next_renewal <= ? ORDER BY next_renewal ASC LIMIT 5',
      [nowUnix3, in7Days]
    );
    if (renewals.length > 0) {
      context.renewalCount  = renewals.length;
      context.renewalsSummary = renewals.map(r => {
        const days = Math.ceil((r.next_renewal - nowUnix3) / 86400);
        const amt  = r.amount ? ` (${r.amount})` : '';
        return `${r.name}${amt} — ${days === 0 ? 'today' : `in ${days}d`}`;
      }).join(', ');
      context.totalRenewalExposure = renewals.reduce((sum, r) => {
        return sum + (parseFloat((r.amount || '0').replace(/[^\d.]/g, '')) || 0);
      }, 0);
    }
  } catch (_) {}

  // Email volume in last 12 hours
  try {
    const nowUnix4   = Math.floor(Date.now() / 1000);
    const last12hStart = nowUnix4 - 12 * 3600;
    const vol = all(
      'SELECT COUNT(*) as total, SUM(category = \'urgent\') as urgent, SUM(category = \'action\') as action FROM email_cache WHERE received_at >= ?',
      [last12hStart]
    );
    if (vol.length > 0) {
      context.emailVolume12h = {
        total: vol[0]?.total || 0,
        urgent: vol[0]?.urgent || 0,
        action: vol[0]?.action || 0
      };
    }
  } catch (_) {}

  // First meeting within 24h (for prep suggestions)
  try {
    const nowUnix2 = Math.floor(Date.now() / 1000);
    const firstEvent = all(
      'SELECT title, start_at FROM calendar_events WHERE start_at >= ? AND start_at <= ? ORDER BY start_at ASC LIMIT 1',
      [nowUnix2, nowUnix2 + 24 * 3600]
    );
    if (firstEvent.length > 0) context.firstMeeting = firstEvent[0];
  } catch (_) {}

  // Top urgent email subject (for smart priority action)
  try {
    const topUrgent = all(
      "SELECT subject FROM email_cache WHERE category = 'urgent' ORDER BY received_at DESC LIMIT 1"
    );
    if (topUrgent.length > 0) context.topUrgentSubject = topUrgent[0].subject;
  } catch (_) {}

  // Weather
  try {
    const weather = await weatherService.getWeather();
    if (weather && weather.temp !== null) {
      context.weatherSummary = `${weather.emoji} ${weather.temp}°C, ${weather.condition}. High ${weather.high}°C, Low ${weather.low}°C. Rain: ${weather.rain_chance}%`;
      context.weather = weather;
    }
  } catch (err) {
    console.error('[Briefing] Weather context error:', err.message);
  }

  return context;
}

/**
 * Determine the day's load level for dynamic tone.
 */
function determineDayLoad(context) {
  const meetings     = context.meetingCount || 0;
  const urgentEmails = context.emailVolume12h?.urgent ?? context.emailCount?.urgent ?? 0;
  const overdueCount = context.overdueCount || 0;
  const renewals     = context.renewalCount || 0;
  const score = meetings * 2 + urgentEmails * 3 + overdueCount * 2 + renewals;

  if (score >= 8) return { level: 'heavy',   reason: `${meetings} meetings, ${urgentEmails} urgent, ${overdueCount} overdue` };
  if (score >= 3) return { level: 'moderate', reason: `${meetings} meetings, ${urgentEmails} urgent` };
  return { level: 'light', reason: 'low activity' };
}

/**
 * Build a smart priority action from context (no AI needed).
 */
function buildSmartPriorityAction(context) {
  const emailCount = context.emailCount || {};
  const meetingCount = context.meetingCount || 0;
  const overdueCount = context.overdueCount || 0;
  const upcomingTasks = context.upcomingTasks || [];
  const firstMeeting = context.firstMeeting;

  // Priority 1: Overdue tasks
  if (overdueCount > 0 && context.topOverdue) {
    return `Complete "${context.topOverdue}" — it's overdue and needs your attention.`;
  }
  // Priority 2: Urgent emails
  if (emailCount.urgent > 0 && context.topUrgentSubject) {
    return `Reply to "${context.topUrgentSubject}" — ${emailCount.urgent > 1 ? `plus ${emailCount.urgent - 1} more urgent` : 'it needs a response'}.`;
  }
  // Priority 3: Upcoming meeting needs prep
  if (firstMeeting) {
    const minsUntil = Math.floor((firstMeeting.start_at - Date.now() / 1000) / 60);
    if (minsUntil > 0 && minsUntil < 120) {
      return `Prepare for "${firstMeeting.title}" starting in ${minsUntil} minutes.`;
    }
  }
  // Priority 4: Action emails
  if (emailCount.action > 0) {
    return `Review ${emailCount.action} email${emailCount.action > 1 ? 's' : ''} that need${emailCount.action === 1 ? 's' : ''} a response.`;
  }
  // Priority 5: Suggest upcoming task
  if (upcomingTasks.length > 0) {
    return `You're clear today. Consider tackling "${upcomingTasks[0]}".`;
  }
  // Priority 6: Deep work
  return 'You\'re clear today — perfect time for deep work or planning ahead.';
}

/**
 * Create a fallback briefing without AI, using raw data.
 */
function createFallbackBriefing(context) {
  const emailCount  = context.emailVolume12h || context.emailCount || { urgent: 0, action: 0, total: 0 };
  const meetingCount = context.meetingCount || 0;
  const weather = context.weather || { emoji: '🌡️', temp: '?', condition: 'Unknown' };
  const dayLoad = determineDayLoad(context);

  return {
    priority_action: buildSmartPriorityAction(context),
    dynamic_tone: dayLoad.level === 'heavy'
      ? 'High-load day. Prioritise ruthlessly.'
      : dayLoad.level === 'light'
        ? 'Low load. Use the space for deep work.'
        : 'Solid day. Execute the plan.',
    email_bullets: buildEmailBullets(context),
    timeline: [],
    summary_line: buildRiskSummaryLine(context),
    optimization: null,
    email_count: emailCount,
    meeting_count: meetingCount,
    weather_brief: `${weather.emoji} ${weather.temp}°C ${weather.condition}`,
    date: new Date().toISOString().split('T')[0],
    generated_at: Date.now(),
    fallback: true
  };
}

/**
 * Build a compressed risk/status summary line from context (no AI).
 */
function buildRiskSummaryLine(context) {
  const parts = [];
  if (context.overdueCount > 0)  parts.push(`${context.overdueCount} overdue`);
  if (context.dueTodayCount > 0) parts.push(`${context.dueTodayCount} due today`);
  if (context.renewalCount > 0)  parts.push(`${context.renewalCount} renewal${context.renewalCount > 1 ? 's' : ''} pending`);
  const urgent = context.emailVolume12h?.urgent ?? context.emailCount?.urgent ?? 0;
  if (urgent > 0) parts.push(`${urgent} urgent`);
  if (context.meetingCount > 0)  parts.push(`${context.meetingCount} meeting${context.meetingCount > 1 ? 's' : ''}`);
  return parts.length > 0 ? parts.join(' · ') : 'Clear day.';
}

/**
 * Build 1-3 signal bullets from context (risk / waiting / optimization).
 * Always attempts to pull real email subjects first; tasks fill remaining slots.
 */
function buildEmailBullets(context) {
  const bullets = [];

  // Signal 1 — always try real emails first (urgent → action → recent unread)
  try {
    const urgentEmails = all(
      `SELECT subject, from_name, category FROM email_cache
       WHERE category IN ('urgent','action') AND category != 'done'
       ORDER BY received_at DESC LIMIT 2`
    );
    for (const e of urgentEmails) {
      const verb = e.category === 'urgent' ? 'Reply to' : 'Review';
      const name = e.from_name ? e.from_name.split(' ')[0] : 'sender';
      bullets.push(`${verb} ${name}: "${(e.subject || '').substring(0, 42)}"`);
      if (bullets.length >= 2) break;
    }
    // If no urgent/action emails, try recent unread
    if (bullets.length === 0) {
      const recent = all(
        `SELECT subject, from_name FROM email_cache
         WHERE category NOT IN ('noise','done') ORDER BY received_at DESC LIMIT 1`
      );
      if (recent.length > 0) {
        const e = recent[0];
        const name = e.from_name ? e.from_name.split(' ')[0] : 'someone';
        bullets.push(`New from ${name}: "${(e.subject || '').substring(0, 42)}"`);
      }
    }
  } catch (_) {}

  // Fill remaining slots with task / risk context
  if (bullets.length < 3 && context.overdueCount > 0 && context.topOverdue) {
    bullets.push(`Clear overdue: "${context.topOverdue.substring(0, 45)}"`);
  }

  if (bullets.length < 3 && context.dueTodayCount > 0) {
    bullets.push(`${context.dueTodayCount} task${context.dueTodayCount > 1 ? 's' : ''} due today — sequence by deadline`);
  } else if (bullets.length < 3 && context.upcomingTasks?.length > 0 && context.overdueCount === 0) {
    bullets.push(`"${context.upcomingTasks[0].substring(0, 50)}" can be deferred if needed`);
  }

  if (bullets.length < 3 && context.renewalCount > 0) {
    const exposure = context.totalRenewalExposure > 0
      ? ` — ₹${Math.round(context.totalRenewalExposure).toLocaleString()} at risk`
      : '';
    bullets.push(`${context.renewalCount} renewal${context.renewalCount > 1 ? 's' : ''} within 7 days${exposure}`);
  }

  return bullets.slice(0, 3);
}

/**
 * Schedule the daily briefing generation at 8:55 AM.
 * Also fires a Windows toast notification at 9:00 AM.
 */
function scheduleBriefing() {
  // Get configured briefing time (default 09:00)
  const briefingTime = getSetting('briefing_time') || '09:00';
  const [hours, minutes] = briefingTime.split(':').map(Number);

  // Schedule generation 5 minutes before notification
  const genHour = minutes >= 5 ? hours : hours - 1;
  const genMinute = minutes >= 5 ? minutes - 5 : 55;

  schedule.scheduleJob({ hour: genHour, minute: genMinute }, async () => {
    console.log('[Briefing] Generating morning briefing...');
    try {
      await generateBriefing();
      console.log('[Briefing] Morning briefing generated');
    } catch (err) {
      console.error('[Briefing] Failed to generate:', err.message);
    }
  });

  // Schedule toast notification — show actual briefing stats in the message
  schedule.scheduleJob({ hour: hours, minute: minutes }, async () => {
    const iconPath = path.join(__dirname, '..', 'assets', 'icon.png');

    // Build notification message from cached briefing content
    let message = '☀️ Your morning briefing is ready. Click to view.';
    try {
      const cached = getSetting('briefing_today');
      if (cached) {
        const b = JSON.parse(cached);
        const parts = [];
        if (b.email_count?.urgent > 0)
          parts.push(`${b.email_count.urgent} urgent email${b.email_count.urgent > 1 ? 's' : ''}`);
        if (b.meeting_count > 0)
          parts.push(`${b.meeting_count} meeting${b.meeting_count > 1 ? 's' : ''}`);
        if (b.weather_brief)
          parts.push(b.weather_brief);
        if (parts.length > 0)
          message = `☀️ ${parts.join(' · ')}. Tap to see your day.`;
        else if (b.priority_action)
          message = `☀️ ${b.priority_action.substring(0, 90)}`;
      }
    } catch (_) {}

    notifier.notify({
      title: 'ARIA — Good Morning',
      message,
      icon: iconPath,
      sound: true,
      wait: true,
      appID: 'ARIA Bot'
    });
    console.log('[Briefing] Morning notification sent:', message);
  });

  console.log(`[Briefing] Scheduled daily briefing at ${briefingTime}`);
}

module.exports = { generateBriefing, scheduleBriefing };
