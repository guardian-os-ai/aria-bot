/**
 * services/habits.js — Habit tracking with streaks
 * Supports creating habits, daily logging, streak calculation,
 * and weekly summaries.
 */

const { run, get, all } = require('../db/index.js');
const schedule = require('node-schedule');

/**
 * Create a new habit.
 */
function createHabit(name, icon = '✅') {
  const now = Math.floor(Date.now() / 1000);
  run(`INSERT INTO habits (name, icon, created_at) VALUES (?, ?, ?)`, [name.trim(), icon, now]);
  const row = get(`SELECT * FROM habits WHERE name = ? ORDER BY id DESC LIMIT 1`, [name.trim()]);
  return row;
}

/**
 * Delete a habit + its logs.
 */
function deleteHabit(id) {
  run(`DELETE FROM habit_log WHERE habit_id = ?`, [id]);
  run(`DELETE FROM habits WHERE id = ?`, [id]);
}

/**
 * Get all habits with today's status.
 */
function getHabits() {
  const habits = all(`SELECT * FROM habits ORDER BY created_at ASC`);
  const today = new Date().toISOString().split('T')[0];

  return habits.map(h => {
    const log = get(`SELECT done FROM habit_log WHERE habit_id = ? AND date = ?`, [h.id, today]);
    const streak = calculateStreak(h.id);
    return {
      ...h,
      doneToday: log?.done === 1,
      streak,
    };
  });
}

/**
 * Toggle today's log for a habit.
 */
function toggleHabit(habitId) {
  const today = new Date().toISOString().split('T')[0];
  const existing = get(`SELECT * FROM habit_log WHERE habit_id = ? AND date = ?`, [habitId, today]);

  if (existing) {
    const newDone = existing.done ? 0 : 1;
    run(`UPDATE habit_log SET done = ? WHERE habit_id = ? AND date = ?`, [newDone, habitId, today]);
    return newDone === 1;
  } else {
    run(`INSERT INTO habit_log (habit_id, date, done) VALUES (?, ?, 1)`, [habitId, today]);
    return true;
  }
}

/**
 * Calculate consecutive-day streak for a habit.
 */
function calculateStreak(habitId) {
  const logs = all(
    `SELECT date FROM habit_log WHERE habit_id = ? AND done = 1 ORDER BY date DESC LIMIT 365`,
    [habitId]
  );
  if (logs.length === 0) return 0;

  let streak = 0;
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  for (let i = 0; i < 365; i++) {
    const checkDate = new Date(today);
    checkDate.setDate(checkDate.getDate() - i);
    const dateStr = checkDate.toISOString().split('T')[0];

    const found = logs.some(l => l.date === dateStr);
    if (found) {
      streak++;
    } else if (i === 0) {
      // Today not done yet — don't break streak, just skip
      continue;
    } else {
      break;
    }
  }

  return streak;
}

/**
 * Get habit history (last N days) for heatmap/graph.
 */
function getHabitHistory(habitId, days = 30) {
  const logs = all(
    `SELECT date, done FROM habit_log WHERE habit_id = ? ORDER BY date DESC LIMIT ?`,
    [habitId, days]
  );

  const history = [];
  for (let i = 0; i < days; i++) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const dateStr = d.toISOString().split('T')[0];
    const log = logs.find(l => l.date === dateStr);
    history.push({ date: dateStr, done: log?.done === 1 });
  }

  return history.reverse();
}

/**
 * Weekly summary stats.
 */
function getWeeklySummary() {
  const habits = all(`SELECT * FROM habits`);
  const weekAgo = new Date();
  weekAgo.setDate(weekAgo.getDate() - 7);
  const weekAgoStr = weekAgo.toISOString().split('T')[0];

  return habits.map(h => {
    const completed = all(
      `SELECT COUNT(*) as cnt FROM habit_log WHERE habit_id = ? AND date >= ? AND done = 1`,
      [h.id, weekAgoStr]
    );
    const count = completed[0]?.cnt || 0;
    return {
      id: h.id,
      name: h.name,
      icon: h.icon,
      completed: count,
      total: 7,
      percentage: Math.round((count / 7) * 100),
      streak: calculateStreak(h.id),
    };
  });
}

/**
 * Schedule evening reminder (8 PM) for incomplete habits.
 */
function scheduleHabitReminder() {
  try {
    schedule.scheduleJob('0 20 * * *', () => {
      const habits = getHabits();
      const incomplete = habits.filter(h => !h.doneToday);
      if (incomplete.length > 0) {
        try {
          const notifier = require('node-notifier');
          const path = require('path');
          notifier.notify({
            title: 'Habit Check-in 📊',
            message: `${incomplete.length} habit${incomplete.length > 1 ? 's' : ''} left today: ${incomplete.map(h => h.name).join(', ')}`,
            icon: path.join(__dirname, '../assets/tray-32.png'),
            sound: true,
          });
        } catch (_) {}
      }
    });
    console.log('[Habits] Evening reminder scheduled at 8 PM');
  } catch (err) {
    console.error('[Habits] Failed to schedule reminder:', err.message);
  }
}

module.exports = {
  createHabit,
  deleteHabit,
  getHabits,
  toggleHabit,
  calculateStreak,
  getHabitHistory,
  getWeeklySummary,
  scheduleHabitReminder,
};
