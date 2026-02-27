/**
 * services/analytics.js — Focus & Habit Analytics Engine
 * Provides detailed analytics, trends, correlations, and scores
 * for both focus sessions and habit tracking.
 */

const { all, get } = require('../db/index.js');

/**
 * Get comprehensive focus analytics (14/30 day trends).
 */
function getFocusAnalytics(days = 30) {
  const since = new Date();
  since.setDate(since.getDate() - days);
  const sinceStr = since.toISOString().split('T')[0];
  const todayStr = new Date().toISOString().split('T')[0];

  // Daily breakdown
  const daily = all(
    `SELECT date, SUM(duration) as total_seconds, COUNT(*) as sessions
     FROM focus_sessions WHERE date >= ? GROUP BY date ORDER BY date ASC`,
    [sinceStr]
  );

  // Fill in missing days with zeros
  const filled = [];
  for (let i = 0; i < days; i++) {
    const d = new Date();
    d.setDate(d.getDate() - (days - 1 - i));
    const dateStr = d.toISOString().split('T')[0];
    const existing = daily.find(r => r.date === dateStr);
    filled.push({
      date: dateStr,
      minutes: existing ? Math.round(existing.total_seconds / 60) : 0,
      sessions: existing ? existing.sessions : 0,
      dayOfWeek: d.getDay(),
      dayName: d.toLocaleDateString('en-US', { weekday: 'short' })
    });
  }

  // Stats
  const totalMinutes = filled.reduce((s, d) => s + d.minutes, 0);
  const totalSessions = filled.reduce((s, d) => s + d.sessions, 0);
  const activeDays = filled.filter(d => d.minutes > 0).length;
  const avgPerActiveDay = activeDays > 0 ? Math.round(totalMinutes / activeDays) : 0;
  const avgPerDay = Math.round(totalMinutes / days);

  // Best day
  const bestDay = filled.reduce((b, d) => d.minutes > (b?.minutes || 0) ? d : b, filled[0]);

  // Trend: compare first half vs second half
  const half = Math.floor(filled.length / 2);
  const firstHalf = filled.slice(0, half).reduce((s, d) => s + d.minutes, 0);
  const secondHalf = filled.slice(half).reduce((s, d) => s + d.minutes, 0);
  const trend = firstHalf > 0 ? Math.round(((secondHalf - firstHalf) / firstHalf) * 100) : 0;

  // Day-of-week pattern
  const byDow = [0, 1, 2, 3, 4, 5, 6].map(dow => {
    const dayEntries = filled.filter(d => d.dayOfWeek === dow);
    const total = dayEntries.reduce((s, d) => s + d.minutes, 0);
    return {
      dow,
      label: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][dow],
      avgMinutes: dayEntries.length > 0 ? Math.round(total / dayEntries.length) : 0
    };
  });
  const bestDow = byDow.reduce((b, d) => d.avgMinutes > (b?.avgMinutes || 0) ? d : b, byDow[0]);

  // Current streak (consecutive days with focus)
  let focusStreak = 0;
  for (let i = filled.length - 1; i >= 0; i--) {
    if (filled[i].minutes > 0) focusStreak++;
    else if (filled[i].date === todayStr) continue; // today might not have focus yet
    else break;
  }

  // Productivity score (0-100) based on: consistency, volume, trend
  const consistencyScore = Math.min(40, Math.round((activeDays / days) * 40));
  const volumeScore = Math.min(30, Math.round(Math.min(totalMinutes / (days * 30), 1) * 30)); // 30min/day target
  const trendScore = trend > 0 ? Math.min(30, Math.round(trend / 3)) : Math.max(0, 15 + Math.round(trend / 5));
  const productivityScore = consistencyScore + volumeScore + trendScore;

  return {
    daily: filled,
    stats: {
      totalMinutes,
      totalSessions,
      activeDays,
      avgPerActiveDay,
      avgPerDay,
      bestDay: bestDay?.date,
      bestDayMinutes: bestDay?.minutes || 0,
      trend,
      trendLabel: trend > 10 ? 'Improving 📈' : trend < -10 ? 'Declining 📉' : 'Steady ➡️',
      bestDow: bestDow.label,
      focusStreak,
      productivityScore,
    },
    byDayOfWeek: byDow
  };
}

/**
 * Get comprehensive habit analytics.
 */
function getHabitAnalytics(days = 30) {
  const since = new Date();
  since.setDate(since.getDate() - days);
  const sinceStr = since.toISOString().split('T')[0];

  const habits = all('SELECT * FROM habits ORDER BY created_at ASC');

  const habitAnalytics = habits.map(h => {
    // Daily completion for the period
    const logs = all(
      `SELECT date, done FROM habit_log WHERE habit_id = ? AND date >= ? ORDER BY date ASC`,
      [h.id, sinceStr]
    );

    // Fill in missing days
    const filled = [];
    for (let i = 0; i < days; i++) {
      const d = new Date();
      d.setDate(d.getDate() - (days - 1 - i));
      const dateStr = d.toISOString().split('T')[0];
      const log = logs.find(l => l.date === dateStr);
      filled.push({
        date: dateStr,
        done: log?.done === 1,
        dayOfWeek: d.getDay()
      });
    }

    const doneCount = filled.filter(d => d.done).length;
    const completionRate = Math.round((doneCount / days) * 100);

    // Current streak
    let streak = 0;
    const today = new Date().toISOString().split('T')[0];
    for (let i = filled.length - 1; i >= 0; i--) {
      if (filled[i].done) streak++;
      else if (filled[i].date === today) continue;
      else break;
    }

    // Longest streak in period
    let longestStreak = 0, currentRun = 0;
    for (const d of filled) {
      if (d.done) { currentRun++; longestStreak = Math.max(longestStreak, currentRun); }
      else currentRun = 0;
    }

    // Day-of-week pattern
    const byDow = [0, 1, 2, 3, 4, 5, 6].map(dow => {
      const dayEntries = filled.filter(d => d.dayOfWeek === dow);
      const done = dayEntries.filter(d => d.done).length;
      return {
        dow,
        label: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][dow],
        rate: dayEntries.length > 0 ? Math.round((done / dayEntries.length) * 100) : 0
      };
    });

    // Trend: first half vs second half
    const half = Math.floor(filled.length / 2);
    const firstRate = filled.slice(0, half).filter(d => d.done).length / Math.max(1, half);
    const secondRate = filled.slice(half).filter(d => d.done).length / Math.max(1, filled.length - half);
    const trend = firstRate > 0 ? Math.round(((secondRate - firstRate) / firstRate) * 100) : 0;

    return {
      id: h.id,
      name: h.name,
      icon: h.icon,
      completionRate,
      doneCount,
      totalDays: days,
      currentStreak: streak,
      longestStreak,
      trend,
      trendLabel: trend > 10 ? '📈' : trend < -10 ? '📉' : '➡️',
      byDayOfWeek: byDow,
      heatmap: filled.map(d => ({ date: d.date, done: d.done })),
      bestDay: byDow.reduce((b, d) => d.rate > (b?.rate || 0) ? d : b, byDow[0])?.label || 'N/A',
      worstDay: byDow.reduce((w, d) => d.rate < (w?.rate || 100) ? d : w, byDow[0])?.label || 'N/A',
    };
  });

  // Overall habit score (0-100)
  const overallRate = habitAnalytics.length > 0
    ? Math.round(habitAnalytics.reduce((s, h) => s + h.completionRate, 0) / habitAnalytics.length)
    : 0;

  // Best and worst performing habits
  const sortedByRate = [...habitAnalytics].sort((a, b) => b.completionRate - a.completionRate);

  return {
    habits: habitAnalytics,
    overallRate,
    totalHabits: habits.length,
    bestHabit: sortedByRate[0] || null,
    worstHabit: sortedByRate[sortedByRate.length - 1] || null,
  };
}

/**
 * Get correlation data between focus sessions and task completion.
 */
function getProductivityCorrelation(days = 14) {
  const since = new Date();
  since.setDate(since.getDate() - days);
  const sinceStr = since.toISOString().split('T')[0];
  const sinceTs = Math.floor(since.getTime() / 1000);

  const data = [];
  for (let i = 0; i < days; i++) {
    const d = new Date();
    d.setDate(d.getDate() - (days - 1 - i));
    const dateStr = d.toISOString().split('T')[0];
    const dayStart = new Date(d); dayStart.setHours(0, 0, 0, 0);
    const dayEnd = new Date(d); dayEnd.setHours(23, 59, 59, 999);
    const startTs = Math.floor(dayStart.getTime() / 1000);
    const endTs = Math.floor(dayEnd.getTime() / 1000);

    const focus = all(
      `SELECT COALESCE(SUM(duration), 0) as s FROM focus_sessions WHERE date = ?`,
      [dateStr]
    )[0]?.s || 0;

    const tasksCompleted = all(
      `SELECT COUNT(*) as cnt FROM reminders WHERE completed_at >= ? AND completed_at <= ?`,
      [startTs, endTs]
    )[0]?.cnt || 0;

    const habitsCompleted = all(
      `SELECT COUNT(*) as cnt FROM habit_log WHERE date = ? AND done = 1`,
      [dateStr]
    )[0]?.cnt || 0;

    data.push({
      date: dateStr,
      focusMinutes: Math.round(focus / 60),
      tasksCompleted,
      habitsCompleted,
    });
  }

  return data;
}

module.exports = { getFocusAnalytics, getHabitAnalytics, getProductivityCorrelation };
