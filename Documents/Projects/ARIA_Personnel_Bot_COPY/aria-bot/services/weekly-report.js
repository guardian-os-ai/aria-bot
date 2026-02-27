/**
 * services/weekly-report.js — AI Weekly Report Generator
 * Aggregates 7 days of data from all tables and generates
 * a structured productivity report, optionally enhanced by AI.
 */

const { all, get, getSetting, saveSetting } = require('../db/index.js');
const { aiCall } = require('./ai.js');

/**
 * Generate or return cached weekly report.
 * Caches for 12 hours to avoid regenerating every call.
 */
async function generateWeeklyReport() {
  // Check cache
  const cached = getSetting('weekly_report_data');
  const cachedAt = getSetting('weekly_report_at');
  if (cached && cachedAt) {
    const ageHours = (Date.now() - parseInt(cachedAt)) / (1000 * 60 * 60);
    if (ageHours < 12) {
      try { return { ...JSON.parse(cached), cached: true }; } catch (_) {}
    }
  }

  const report = assembleReportData();

  // Try AI-enhanced summary
  try {
    const aiSummary = await generateAISummary(report);
    report.aiSummary = aiSummary;
  } catch (err) {
    console.error('[WeeklyReport] AI summary failed:', err.message);
    report.aiSummary = buildFallbackSummary(report);
  }

  report.generatedAt = Date.now();

  // Cache it
  saveSetting('weekly_report_data', JSON.stringify(report));
  saveSetting('weekly_report_at', String(Date.now()));

  return report;
}

/**
 * Assemble raw report data from all DB tables.
 */
function assembleReportData() {
  const now = Math.floor(Date.now() / 1000);
  const weekAgoTs = now - 7 * 86400;
  const weekAgoDate = new Date(Date.now() - 7 * 86400).toISOString().split('T')[0];
  const todayDate = new Date().toISOString().split('T')[0];

  // ── Tasks ──
  const tasksCompleted = all(
    `SELECT COUNT(*) as cnt FROM reminders WHERE completed_at IS NOT NULL AND completed_at >= ?`,
    [weekAgoTs]
  )[0]?.cnt || 0;

  const tasksCreated = all(
    `SELECT COUNT(*) as cnt FROM reminders WHERE created_at >= ?`,
    [weekAgoTs]
  )[0]?.cnt || 0;

  const tasksOverdue = all(
    `SELECT COUNT(*) as cnt FROM reminders WHERE completed = 0 AND archived_at IS NULL AND due_at < ?`,
    [now]
  )[0]?.cnt || 0;

  const topCompletedTasks = all(
    `SELECT title FROM reminders WHERE completed_at IS NOT NULL AND completed_at >= ? ORDER BY completed_at DESC LIMIT 5`,
    [weekAgoTs]
  ).map(r => r.title);

  // ── Focus Sessions ──
  const focusRows = all(
    `SELECT date, SUM(duration) as total_seconds, COUNT(*) as sessions
     FROM focus_sessions WHERE date >= ? GROUP BY date ORDER BY date ASC`,
    [weekAgoDate]
  );

  const focusTotalMinutes = Math.round(focusRows.reduce((s, r) => s + r.total_seconds, 0) / 60);
  const focusTotalSessions = focusRows.reduce((s, r) => s + r.sessions, 0);
  const focusAvgMinutes = focusRows.length > 0 ? Math.round(focusTotalMinutes / focusRows.length) : 0;
  const focusBestDay = focusRows.length > 0
    ? focusRows.reduce((best, r) => r.total_seconds > (best?.total_seconds || 0) ? r : best, focusRows[0])
    : null;

  // ── Habits ──
  const habits = all(`SELECT * FROM habits`);
  const habitStats = habits.map(h => {
    const completed = all(
      `SELECT COUNT(*) as cnt FROM habit_log WHERE habit_id = ? AND date >= ? AND done = 1`,
      [h.id, weekAgoDate]
    )[0]?.cnt || 0;

    return {
      name: h.name,
      icon: h.icon,
      completed,
      total: 7,
      percentage: Math.round((completed / 7) * 100),
      streak: calculateHabitStreak(h.id),
    };
  });

  const habitOverallRate = habitStats.length > 0
    ? Math.round(habitStats.reduce((s, h) => s + h.percentage, 0) / habitStats.length)
    : 0;

  // ── Subscriptions / Money ──
  const subs = all(`SELECT * FROM subscriptions`);
  const parseAmount = (str) => {
    if (!str) return 0;
    return parseFloat(String(str).replace(/[₹$,\s]/g, '')) || 0;
  };
  let monthlySpend = 0;
  for (const s of subs) {
    const amt = parseAmount(s.amount);
    if (s.period === 'monthly') monthlySpend += amt;
    else if (s.period === 'yearly') monthlySpend += amt / 12;
  }

  const upcomingRenewals = subs
    .filter(s => s.next_renewal && s.next_renewal > now && s.next_renewal < now + 7 * 86400)
    .map(s => ({ name: s.name, amount: s.amount, daysLeft: Math.ceil((s.next_renewal - now) / 86400) }));

  // ── Emails ──
  const emailsReceived = all(
    `SELECT COUNT(*) as cnt FROM email_cache WHERE cached_at >= ?`,
    [weekAgoTs]
  )[0]?.cnt || 0;

  const emailsByCategory = all(
    `SELECT category, COUNT(*) as cnt FROM email_cache WHERE cached_at >= ? GROUP BY category`,
    [weekAgoTs]
  );

  const urgentEmails = emailsByCategory.find(e => e.category === 'urgent')?.cnt || 0;
  const actionEmails = emailsByCategory.find(e => e.category === 'action')?.cnt || 0;

  // ── AI Usage ──
  const aiUsage = all(
    `SELECT provider, SUM(tokens_in + tokens_out) as total_tokens, COUNT(*) as calls
     FROM ai_usage WHERE date >= ? GROUP BY provider`,
    [weekAgoDate]
  );

  // ── Calendar ──
  const meetingsThisWeek = all(
    `SELECT COUNT(*) as cnt FROM calendar_events WHERE start_at >= ? AND start_at < ?`,
    [weekAgoTs, now]
  )[0]?.cnt || 0;

  // ── P10-5: Outcome Tracking — time saved & prevented issues ──
  const timeSavedRows = all(
    `SELECT activity, SUM(minutes_saved) as total_minutes, COUNT(*) as count
     FROM time_saved_log WHERE created_at > ?
     GROUP BY activity`,
    [weekAgoTs]
  );
  const totalTimeSaved = timeSavedRows.reduce((s, r) => s + r.total_minutes, 0);

  const preventedRows = all(
    `SELECT issue_type, COUNT(*) as count, SUM(estimated_cost) as total_cost
     FROM prevented_issues WHERE created_at > ?
     GROUP BY issue_type`,
    [weekAgoTs]
  );
  const totalPreventedCount = preventedRows.reduce((s, r) => s + r.count, 0);
  const totalPreventedValue = preventedRows.reduce((s, r) => s + (r.total_cost || 0), 0);

  // ── Streak ──
  const streakRows = all(`SELECT date FROM streaks ORDER BY date DESC LIMIT 365`);
  let currentStreak = 0;
  const checkDate = new Date();
  for (const row of streakRows) {
    const expected = checkDate.toISOString().split('T')[0];
    if (row.date === expected) {
      currentStreak++;
      checkDate.setDate(checkDate.getDate() - 1);
    } else break;
  }

  return {
    period: { from: weekAgoDate, to: todayDate },
    tasks: { completed: tasksCompleted, created: tasksCreated, overdue: tasksOverdue, topCompleted: topCompletedTasks },
    focus: { totalMinutes: focusTotalMinutes, sessions: focusTotalSessions, avgMinutes: focusAvgMinutes, bestDay: focusBestDay, daily: focusRows },
    habits: { stats: habitStats, overallRate: habitOverallRate },
    money: { monthlySpend: Math.round(monthlySpend), subscriptionCount: subs.length, upcomingRenewals },
    emails: { total: emailsReceived, urgent: urgentEmails, action: actionEmails },
    ai: aiUsage,
    meetings: meetingsThisWeek,
    streak: currentStreak,
    outcome: {
      timeSaved: { breakdown: timeSavedRows, totalMinutes: Math.round(totalTimeSaved), totalHours: Math.round(totalTimeSaved / 6) / 10 },
      issuesPrevented: { breakdown: preventedRows, total: totalPreventedCount, totalValue: Math.round(totalPreventedValue) }
    }
  };
}

/**
 * Helper: calculate streak for a habit (duplicated from habits.js to avoid circular dep).
 */
function calculateHabitStreak(habitId) {
  const logs = all(
    `SELECT date FROM habit_log WHERE habit_id = ? AND done = 1 ORDER BY date DESC LIMIT 365`,
    [habitId]
  );
  if (logs.length === 0) return 0;
  let streak = 0;
  const today = new Date(); today.setHours(0, 0, 0, 0);
  for (let i = 0; i < 365; i++) {
    const check = new Date(today); check.setDate(check.getDate() - i);
    const dateStr = check.toISOString().split('T')[0];
    if (logs.some(l => l.date === dateStr)) streak++;
    else if (i === 0) continue;
    else break;
  }
  return streak;
}

/**
 * Generate AI-enhanced summary from raw report data.
 */
async function generateAISummary(report) {
  const prompt = `Generate a brief weekly productivity report (4-5 sentences).
Data: Tasks completed: ${report.tasks.completed}/${report.tasks.created} created, ${report.tasks.overdue} overdue.
Focus: ${report.focus.totalMinutes} minutes in ${report.focus.sessions} sessions.
Habits: ${report.habits.overallRate}% overall completion rate.
Emails: ${report.emails.total} received (${report.emails.urgent} urgent, ${report.emails.action} action needed).
Meetings: ${report.meetings}.
Subscriptions: ₹${report.money.monthlySpend}/mo across ${report.money.subscriptionCount} services.
Streak: Day ${report.streak}.
ARIA Value: ${report.outcome?.timeSaved?.totalHours || 0}h saved, ${report.outcome?.issuesPrevented?.total || 0} issues prevented, ₹${report.outcome?.issuesPrevented?.totalValue || 0} potential costs avoided.

Write a supportive, concise summary. Highlight wins and one area for improvement.
Include a line about ARIA's value this week (time saved, issues caught).
Return ONLY the text summary, no JSON.`;

  const result = await aiCall('chat', prompt, {
    systemContext: 'You are ARIA, a personal productivity assistant. Write a brief weekly report. Be warm but data-driven.'
  });

  return typeof result === 'string' ? result : (result?.text || result);
}

/**
 * Build a fallback summary without AI.
 */
function buildFallbackSummary(report) {
  const parts = [];
  parts.push(`This week you completed ${report.tasks.completed} tasks and spent ${report.focus.totalMinutes} minutes in deep focus.`);
  if (report.habits.overallRate > 0) {
    parts.push(`Your habits averaged ${report.habits.overallRate}% completion rate.`);
  }
  if (report.emails.total > 0) {
    parts.push(`You processed ${report.emails.total} emails (${report.emails.urgent} urgent).`);
  }
  if (report.tasks.overdue > 0) {
    parts.push(`${report.tasks.overdue} tasks are still overdue — worth reviewing.`);
  }
  if (report.streak > 3) {
    parts.push(`Great streak — Day ${report.streak}! Keep going.`);
  }
  // P10-5: Outcome tracking in summary
  if (report.outcome?.timeSaved?.totalHours > 0) {
    parts.push(`ARIA saved you ~${report.outcome.timeSaved.totalHours}h this week.`);
  }
  if (report.outcome?.issuesPrevented?.total > 0) {
    parts.push(`${report.outcome.issuesPrevented.total} potential issue${report.outcome.issuesPrevented.total > 1 ? 's' : ''} caught.`);
  }
  return parts.join(' ');
}

module.exports = { generateWeeklyReport };
