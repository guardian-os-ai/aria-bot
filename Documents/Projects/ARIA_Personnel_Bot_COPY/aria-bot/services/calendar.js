/**
 * services/calendar.js — iCal calendar integration
 * Fetches and parses .ics URLs using node-ical.
 * Caches events in SQLite for offline access.
 */

const ical = require('node-ical');
const { getSetting, run, get, all } = require('../db/index.js');

/**
 * Fetch and parse calendar events from configured iCal URL.
 * Returns today's and tomorrow's events.
 */
async function getEvents() {
  const calendarUrl = getSetting('calendar_ical_url');

  if (!calendarUrl) {
    // Return cached events if available
    const cached = getCachedEvents();
    if (cached.length > 0) {
      return { events: cached, cached: true };
    }
    return { events: [], needsSetup: true };
  }

  try {
    const data = await ical.async.fromURL(calendarUrl);

    const now = new Date();
    const todayStart = new Date(now);
    todayStart.setHours(0, 0, 0, 0);

    const tomorrowEnd = new Date(now);
    tomorrowEnd.setDate(tomorrowEnd.getDate() + 2);
    tomorrowEnd.setHours(0, 0, 0, 0);

    const events = [];

    for (const key of Object.keys(data)) {
      const event = data[key];
      if (event.type !== 'VEVENT') continue;

      const start = new Date(event.start);
      const end = new Date(event.end || event.start);

      // Only include today and tomorrow's events
      if (start >= todayStart && start < tomorrowEnd) {
        const eventObj = {
          id: event.uid || key,
          title: event.summary || '(No title)',
          start_at: Math.floor(start.getTime() / 1000),
          end_at: Math.floor(end.getTime() / 1000),
          location: event.location || null,
          description: (event.description || '').substring(0, 500),
          calendar_url: calendarUrl
        };

        events.push(eventObj);

        // Cache in DB
        run(
          `INSERT OR REPLACE INTO calendar_events 
           (id, title, start_at, end_at, location, description, calendar_url)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [
            eventObj.id,
            eventObj.title,
            eventObj.start_at,
            eventObj.end_at,
            eventObj.location,
            eventObj.description,
            eventObj.calendar_url
          ]
        );
      }
    }

    // Sort by start time
    events.sort((a, b) => a.start_at - b.start_at);

    // Auto-create reminder tasks for upcoming events
    syncEventsToTasks(events);

    return { events, fresh: true };
  } catch (err) {
    console.error('[Calendar] Fetch error:', err.message);

    // Return cached events on error
    const cached = getCachedEvents();
    return { events: cached, cached: true, error: err.message };
  }
}

/**
 * Auto-create reminder tasks for upcoming calendar events.
 * Creates a task 15 minutes before each event if one doesn't already exist.
 */
function syncEventsToTasks(events) {
  const now = Math.floor(Date.now() / 1000);
  for (const event of events) {
    // Skip events that started more than 1 hour ago
    if (event.start_at < now - 3600) continue;

    // Skip if we already have a reminder linked to this event
    try {
      const existing = get(
        `SELECT id FROM reminders WHERE linked_calendar_event_id = ?`,
        [event.id]
      );
      if (existing) continue;

      // 15 minutes before event; if that's past, use event start time
      const reminderDue = event.start_at - 15 * 60;
      const effectiveDue = reminderDue > now ? reminderDue : event.start_at;

      const subtitleParts = [];
      if (event.location) subtitleParts.push(event.location);
      subtitleParts.push('Added by ARIA');
      const subtitle = subtitleParts.join(' · ');

      run(
        `INSERT INTO reminders
           (title, due_at, category, subtitle, source, linked_calendar_event_id, created_at)
         VALUES (?, ?, 'calendar', ?, 'calendar', ?, ?)`,
        [event.title, effectiveDue, subtitle, event.id, now]
      );
      console.log(`[Calendar] Auto-created reminder: "${event.title}"`);
    } catch (err) {
      console.error('[Calendar] syncEventsToTasks error:', err.message);
    }
  }
}

/**
 * Get cached events for today and tomorrow from DB.
 */
function getCachedEvents() {
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const todayStartUnix = Math.floor(todayStart.getTime() / 1000);

  const tomorrowEnd = new Date();
  tomorrowEnd.setDate(tomorrowEnd.getDate() + 2);
  tomorrowEnd.setHours(0, 0, 0, 0);
  const tomorrowEndUnix = Math.floor(tomorrowEnd.getTime() / 1000);

  return all(
    'SELECT * FROM calendar_events WHERE start_at >= ? AND start_at < ? ORDER BY start_at ASC',
    [todayStartUnix, tomorrowEndUnix]
  );
}

module.exports = { getEvents };
