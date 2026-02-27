/**
 * services/calendar-intel.js — Calendar Intelligence
 * Meeting prep briefings, gap detection, and cross-referencing
 * calendar events with emails and tasks.
 */

const { all, get, run } = require('../db/index.js');

/**
 * Get full calendar intelligence for today.
 * Returns: meeting prep data, gaps, suggestions.
 */
function getCalendarIntelligence() {
  const now = Math.floor(Date.now() / 1000);
  const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);
  const todayEnd = new Date(); todayEnd.setHours(23, 59, 59, 999);
  const todayStartTs = Math.floor(todayStart.getTime() / 1000);
  const todayEndTs = Math.floor(todayEnd.getTime() / 1000);

  // Get today's events
  const events = all(
    'SELECT * FROM calendar_events WHERE start_at >= ? AND start_at <= ? ORDER BY start_at ASC',
    [todayStartTs, todayEndTs]
  );

  // Build intel for each event
  const meetingPreps = events.map(event => buildMeetingPrep(event));

  // Detect gaps (free slots ≥ 15 minutes)
  const gaps = detectGaps(events, now, todayEndTs);

  // Suggestions based on gaps and tasks
  const suggestions = generateSuggestions(gaps, now);

  // Upcoming event (next one from now)
  const nextEvent = events.find(e => e.start_at > now);
  const minutesToNext = nextEvent ? Math.round((nextEvent.start_at - now) / 60) : null;

  return {
    events: meetingPreps,
    gaps,
    suggestions,
    nextEvent: nextEvent ? {
      title: nextEvent.title,
      startsIn: minutesToNext,
      startTime: new Date(nextEvent.start_at * 1000).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' }),
      location: nextEvent.location,
    } : null,
    totalMeetings: events.length,
    totalFreeMinutes: gaps.reduce((s, g) => s + g.minutes, 0),
    busyPercent: events.length > 0
      ? Math.round((events.reduce((s, e) => s + (e.end_at - e.start_at), 0) / (8 * 3600)) * 100)  // % of 8hr workday
      : 0,
  };
}

/**
 * Build meeting prep data for a single event.
 * Cross-references with emails and tasks.
 */
function buildMeetingPrep(event) {
  const prep = {
    id: event.id,
    title: event.title,
    startTime: new Date(event.start_at * 1000).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' }),
    endTime: new Date(event.end_at * 1000).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' }),
    durationMinutes: Math.round((event.end_at - event.start_at) / 60),
    location: event.location,
    description: event.description,
    relatedEmails: [],
    relatedTasks: [],
    briefing: null,
  };

  // Extract keywords from event title for cross-referencing
  const titleWords = (event.title || '').toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')
    .split(/\s+/)
    .filter(w => w.length > 3);

  // Find related emails (matching subject or from_name against event title keywords)
  if (titleWords.length > 0) {
    try {
      const recentEmails = all(
        `SELECT message_id, from_name, from_email, subject, summary, category
         FROM email_cache ORDER BY received_at DESC LIMIT 50`
      );

      for (const email of recentEmails) {
        const emailText = `${email.subject} ${email.from_name} ${email.from_email}`.toLowerCase();
        const matches = titleWords.filter(w => emailText.includes(w));
        if (matches.length >= 1) {
          prep.relatedEmails.push({
            from: email.from_name,
            subject: email.subject,
            summary: email.summary,
            category: email.category,
            relevance: matches.length,
          });
        }
      }
      // Sort by relevance, limit to top 3
      prep.relatedEmails.sort((a, b) => b.relevance - a.relevance);
      prep.relatedEmails = prep.relatedEmails.slice(0, 3);
    } catch (_) {}
  }

  // Find related tasks
  try {
    const tasks = all(
      `SELECT id, title, due_at, completed, priority_score
       FROM reminders WHERE archived_at IS NULL ORDER BY priority_score DESC LIMIT 50`
    );

    for (const task of tasks) {
      const taskText = (task.title || '').toLowerCase();
      const matches = titleWords.filter(w => taskText.includes(w));
      if (matches.length >= 1) {
        prep.relatedTasks.push({
          title: task.title,
          completed: !!task.completed,
          priority: task.priority_score,
          relevance: matches.length,
        });
      }
    }
    prep.relatedTasks.sort((a, b) => b.relevance - a.relevance);
    prep.relatedTasks = prep.relatedTasks.slice(0, 3);
  } catch (_) {}

  // Build quick briefing text
  const parts = [`Meeting: "${event.title}"`];
  if (event.location) parts.push(`at ${event.location}`);
  parts.push(`(${prep.durationMinutes}min)`);
  if (prep.relatedEmails.length > 0) {
    parts.push(`— Related emails from ${prep.relatedEmails.map(e => e.from).join(', ')}`);
  }
  if (prep.relatedTasks.filter(t => !t.completed).length > 0) {
    parts.push(`— Open tasks: ${prep.relatedTasks.filter(t => !t.completed).map(t => t.title).join(', ')}`);
  }
  prep.briefing = parts.join(' ');

  return prep;
}

/**
 * Detect free gaps between meetings.
 */
function detectGaps(events, nowTs, dayEndTs) {
  const gaps = [];
  const workStart = Math.floor(new Date().setHours(9, 0, 0, 0) / 1000);
  const workEnd = Math.floor(new Date().setHours(18, 0, 0, 0) / 1000);

  let prevEnd = Math.max(nowTs, workStart);

  for (const event of events) {
    if (event.start_at < prevEnd) {
      // Overlapping or already past
      prevEnd = Math.max(prevEnd, event.end_at);
      continue;
    }

    const gapMinutes = Math.round((event.start_at - prevEnd) / 60);
    if (gapMinutes >= 15 && prevEnd < workEnd) {
      gaps.push({
        startTime: new Date(prevEnd * 1000).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' }),
        endTime: new Date(event.start_at * 1000).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' }),
        minutes: gapMinutes,
        startTs: prevEnd,
      });
    }
    prevEnd = event.end_at;
  }

  // Gap after last meeting until end of work
  if (prevEnd < workEnd) {
    const gapMinutes = Math.round((workEnd - prevEnd) / 60);
    if (gapMinutes >= 15) {
      gaps.push({
        startTime: new Date(prevEnd * 1000).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' }),
        endTime: new Date(workEnd * 1000).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' }),
        minutes: gapMinutes,
        startTs: prevEnd,
      });
    }
  }

  return gaps;
}

/**
 * Generate suggestions based on gaps and current tasks.
 */
function generateSuggestions(gaps, nowTs) {
  const suggestions = [];

  // Find high-priority tasks that could fit in gaps
  const openTasks = all(
    `SELECT title, priority_score, category FROM reminders
     WHERE completed = 0 AND archived_at IS NULL
     ORDER BY priority_score DESC LIMIT 5`
  );

  for (const gap of gaps) {
    if (gap.minutes >= 25 && gap.minutes <= 60) {
      // Perfect for a focus session
      suggestions.push({
        type: 'focus',
        text: `${gap.startTime} – ${gap.endTime}: ${gap.minutes}min gap — perfect for a focus session`,
        gap,
      });
    } else if (gap.minutes > 60) {
      // Suggest tackling a high-priority task
      const task = openTasks[0];
      if (task) {
        suggestions.push({
          type: 'task',
          text: `${gap.startTime} – ${gap.endTime}: ${gap.minutes}min free — tackle "${task.title}"?`,
          gap,
          task: task.title,
        });
      }
    } else if (gap.minutes >= 15) {
      // Quick break or review
      suggestions.push({
        type: 'break',
        text: `${gap.startTime} – ${gap.endTime}: ${gap.minutes}min — quick break or email review`,
        gap,
      });
    }
  }

  return suggestions;
}

/**
 * Wire calendar events to linked reminder tasks.
 * Updates linked_calendar_event_id on matching reminders.
 */
function linkCalendarToTasks() {
  try {
    const events = all('SELECT id, title FROM calendar_events');
    const reminders = all('SELECT id, title, linked_calendar_event_id FROM reminders WHERE linked_calendar_event_id IS NULL AND completed = 0');

    let linked = 0;
    for (const reminder of reminders) {
      const rTitle = (reminder.title || '').toLowerCase();
      for (const event of events) {
        const eTitle = (event.title || '').toLowerCase();
        // Match if titles share significant words
        const eWords = eTitle.split(/\s+/).filter(w => w.length > 3);
        const matches = eWords.filter(w => rTitle.includes(w));
        if (matches.length >= 1 || rTitle.includes(eTitle) || eTitle.includes(rTitle)) {
          run('UPDATE reminders SET linked_calendar_event_id = ? WHERE id = ?', [event.id, reminder.id]);
          linked++;
          break;
        }
      }
    }

    if (linked > 0) console.log(`[CalendarIntel] Linked ${linked} tasks to calendar events`);
    return { linked };
  } catch (err) {
    console.error('[CalendarIntel] Link error:', err.message);
    return { linked: 0 };
  }
}

module.exports = { getCalendarIntelligence, linkCalendarToTasks };
