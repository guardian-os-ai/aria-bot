/**
 * services/focus.js — Focus / Deep-Work Timer
 * Tracks focus sessions with a simple start/end model.
 * No invasive hosts-file manipulation — just a timer + stats.
 */

const { run, get, all } = require('../db/index.js');

// In-memory session state (only one session at a time)
let currentSession = null;

/**
 * Start a focus session.
 */
function startSession(durationMinutes = 25) {
  if (currentSession) {
    return { error: 'A focus session is already running.' };
  }
  currentSession = {
    startedAt: Date.now(),
    duration: durationMinutes * 60 * 1000, // ms
  };
  return { success: true, endsAt: currentSession.startedAt + currentSession.duration };
}

/**
 * End the current focus session and persist it.
 */
function endSession() {
  if (!currentSession) {
    return { error: 'No active focus session.' };
  }
  const elapsed = Math.floor((Date.now() - currentSession.startedAt) / 1000); // seconds
  const date = new Date().toISOString().split('T')[0];
  const now = Math.floor(Date.now() / 1000);

  run(
    `INSERT INTO focus_sessions (date, duration, created_at) VALUES (?, ?, ?)`,
    [date, elapsed, now]
  );

  currentSession = null;
  return { success: true, duration: elapsed };
}

/**
 * Get the status of the current session (or null).
 */
function getStatus() {
  if (!currentSession) return { active: false };

  const elapsed = Date.now() - currentSession.startedAt;
  const remaining = Math.max(0, currentSession.duration - elapsed);
  const finished = remaining <= 0;

  if (finished) {
    // Auto-end if timer expired
    const result = endSession();
    return { active: false, justFinished: true, duration: result.duration };
  }

  return {
    active: true,
    elapsed: Math.floor(elapsed / 1000),
    remaining: Math.floor(remaining / 1000),
    totalDuration: Math.floor(currentSession.duration / 1000),
  };
}

/**
 * Get focus stats for the last N days.
 */
function getStats(days = 7) {
  const since = new Date();
  since.setDate(since.getDate() - days);
  const sinceStr = since.toISOString().split('T')[0];

  const rows = all(
    `SELECT date, SUM(duration) as total_seconds, COUNT(*) as sessions
     FROM focus_sessions WHERE date >= ? GROUP BY date ORDER BY date ASC`,
    [sinceStr]
  );

  // Total today
  const today = new Date().toISOString().split('T')[0];
  const todayRow = rows.find(r => r.date === today);

  return {
    days: rows,
    todayMinutes: todayRow ? Math.round(todayRow.total_seconds / 60) : 0,
    todaySessions: todayRow ? todayRow.sessions : 0,
    weekTotalMinutes: Math.round(rows.reduce((s, r) => s + r.total_seconds, 0) / 60),
    weekSessions: rows.reduce((s, r) => s + r.sessions, 0),
  };
}

module.exports = {
  startSession,
  endSession,
  getStatus,
  getStats,
};
