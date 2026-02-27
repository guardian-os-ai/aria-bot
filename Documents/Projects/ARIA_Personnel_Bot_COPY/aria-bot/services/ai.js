/**
 * services/ai.js — AI Router
 * Single entry point for all AI calls in ARIA.
 *
 * Routing philosophy:
 *   Ollama (local, free, always-first) → fallback only when OFFLINE
 *
 *   Background / email pipeline tasks  → Ollama → heuristic/default (NEVER external API)
 *   User-facing tasks (chat, briefing) → Ollama → Grok → Gemini (user needs a real answer)
 *
 *   Task routing:
 *     'categorise' → Ollama → 'fyi' default
 *     'parse'      → Ollama → manualParseReminder
 *     'intent'     → Ollama → 'chat' default
 *     'summarise'  → Ollama → null (caller uses heuristic)
 *     'analyse'    → Ollama → heuristic (handled in gmail.js / mail.js directly)
 *     'briefing'   → Ollama → Grok → Gemini
 *     'chat'       → Ollama → Grok → Gemini
 */

const ollama = require('./ollama.js');
const haiku  = require('./haiku.js');
const grok   = require('./grok.js');

/**
 * Main AI routing function.
 * @param {string} task - 'categorise'|'parse'|'summarise'|'briefing'|'chat'|'intent'
 * @param {string|object} input - The input text or structured data
 * @param {object} context - Additional context for Haiku calls
 * @returns {Promise<string>} - AI response text
 */
async function aiCall(task, input, context = {}) {
  const inputStr = typeof input === 'object' ? JSON.stringify(input) : input;

  switch (task) {
    case 'categorise':
      return categorise(inputStr);

    case 'parse':
      return parseReminder(inputStr);

    case 'intent':
      return classifyIntent(inputStr);

    case 'summarise':
      // Summarise — Ollama only. Caller uses heuristic if null returned.
      return summariseWithOllama(inputStr);

    case 'briefing':
      // Briefing — Ollama first, then Grok → Gemini (user-facing, needs quality)
      return briefingWithFallback(inputStr, context);

    case 'chat':
      // Chat — Ollama first, then Grok → Gemini (user-facing)
      return chatWithFallback(inputStr, context);

    case 'analyse':
      // Email analysis — Ollama only (handled directly in gmail.js; this is a safety route)
      return analyseWithOllama(inputStr).catch(() => null);

    default:
      throw new Error(`Unknown AI task: ${task}`);
  }
}

/**
 * Summarise an email — Ollama only. Returns null if Ollama is offline.
 * Caller is responsible for heuristic fallback.
 */
async function summariseWithOllama(input) {
  const prompt =
    `Summarise this email in exactly 2 sentences. Be specific: who sent it, what they want, and any deadline.\n` +
    `Write ONLY the 2-sentence summary, nothing else.\n\n` +
    `${input.substring(0, 600)}`;

  try {
    const running = await ollama.isRunning();
    if (!running) return null;
    const result = await ollama.call('llama3.2:3b',
      [{ role: 'user', content: prompt }],
      { temperature: 0.1, max_tokens: 120 }
    );
    if (result && result.trim().length > 20) {
      console.log('[AI] Summarise via Ollama ✓');
      return result.trim();
    }
    return null;
  } catch (err) {
    console.log('[AI] Ollama summarise failed:', err.message);
    return null;
  }
}

/**
 * Generate a briefing — tries Ollama with a compact prompt, falls back to Gemini → Grok.
 */
async function briefingWithFallback(input, context) {
  // Compact prompt for the smaller local model
  const ollamaPrompt =
    `You are ARIA, an executive chief-of-staff. Compress decisions, not summaries.\n` +
    `Return ONLY valid JSON (no markdown):\n` +
    `{"priority_action":"verb-first directive — the single most important action now","summary_line":"risk state under 10 words","timeline":[{"time":"HH:MM","text":"...","type":"meeting|task|email"}],"optimization":null}\n` +
    `timeline: max 3 items. Be decisive.\n\n${input.substring(0, 800)}`;

  try {
    const running = await ollama.isRunning();
    if (running) {
      const result = await ollama.call('llama3.2:3b',
        [{ role: 'user', content: ollamaPrompt }],
        { temperature: 0.2, max_tokens: 400 }
      );
      if (result && result.trim()) {
        const jsonMatch = result.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          const parsed = JSON.parse(jsonMatch[0]);
          if (parsed.priority_action) {
            console.log('[AI] Briefing via Ollama ✓');
            return result;
          }
        }
      }
    }
  } catch (err) {
    console.log('[AI] Ollama briefing failed, falling back:', err.message);
  }

  // Ollama offline — try Grok then Gemini (briefing is user-facing, needs a real answer)
  console.log('[AI] Ollama offline for briefing — trying Grok');
  try {
    const result = await grok.call('briefing', input, context);
    if (result && result.trim()) { console.log('[AI] Briefing via Grok ✓'); return result; }
  } catch (err) {
    console.log('[AI] Grok briefing failed:', err.message);
  }
  console.log('[AI] Falling back to Gemini for briefing');
  return haiku.call('briefing', input, context);
}

/**
 * Chat with AI — full fallback chain: Ollama → Grok → Gemini.
 * This ensures chat works even if one or more providers are down.
 */
async function chatWithFallback(input, context) {
  const systemMsg = context.systemContext ||
    'You are ARIA, an executive chief-of-staff assistant. Be calm, decisive, and concise. Compress decisions — never summarise for the sake of it. Max 3 sentences unless the user explicitly asks for more. No filler phrases.';

  // Try Ollama first (free, local)
  try {
    const running = await ollama.isRunning();
    if (running) {
      const messages = [
        { role: 'system', content: systemMsg },
        { role: 'user', content: input }
      ];
      const result = await ollama.call('llama3.2:3b', messages, { temperature: 0.7, max_tokens: 1500 });
      if (result && result.trim()) return result;
    }
  } catch (err) {
    console.log('[AI] Ollama unavailable for chat:', err.message);
  }

  // Try Grok (free tier)
  try {
    const result = await grok.call('chat', input, context);
    if (result && result.trim()) return result;
  } catch (err) {
    console.log('[AI] Grok unavailable for chat:', err.message);
  }

  // Fall back to Gemini
  return haiku.call('chat', input, context);
}

/**
 * Analyse an email with Ollama (free local inference).
 * Returns stringified JSON with category, summary, smart_action.
 */
async function analyseWithOllama(prompt) {
  const messages = [{ role: 'user', content: prompt }];
  try {
    const result = await ollama.call('llama3.2:3b', messages, { temperature: 0.3, max_tokens: 400 });
    return result;
  } catch (err) {
    console.log('[AI] Ollama failed for email analysis:', err.message);
    throw err; // Re-throw so caller can fallback
  }
}

/**
 * Categorise an email — Ollama only. Returns 'fyi' if Ollama is offline.
 * No external API calls (email pipeline task).
 */
async function categorise(input) {
  const prompt = `Classify this email into exactly one category: urgent, action, fyi, done, noise.
Only respond with the single category word, nothing else.

Email: ${input}`;

  try {
    const result = await ollama.call('llama3.2:3b', [{ role: 'user', content: prompt }], { temperature: 0.1, max_tokens: 10 });
    const category = result.toLowerCase().trim();
    const valid = ['urgent', 'action', 'fyi', 'done', 'noise'];
    return valid.includes(category) ? category : 'fyi';
  } catch (err) {
    console.log('[AI] Ollama categorise failed — defaulting to fyi:', err.message);
    return 'fyi'; // Safe default, no external API
  }
}

/**
 * Parse natural language reminder into structured data.
 * Tries Ollama first, falls back to Haiku.
 */
async function parseReminder(input) {
  const now = new Date().toISOString();
  const prompt = `Parse this reminder into JSON. Current time: ${now}
Respond with ONLY valid JSON, no other text.

Input: "${input}"

JSON format:
{
  "title": "string — clean, action-verb phrasing",
  "due_at": "ISO 8601 datetime string",
  "recurring": "daily"|"weekly"|"monthly"|null,
  "priority_score": <integer 1–100, based on deadline proximity and financial/work impact>,
  "risk": "Low"|"Moderate"|"High",
  "optimal_reminder_time": "ISO 8601 — best time to remind before deadline (e.g. 1h before for tasks, 24h before for payments)"
}

Priority scoring:
- Due within 2h: 80–100
- Due today: 60–79
- Due tomorrow: 40–59
- Due this week: 20–39
- Later: 1–19
- Financial/payment tasks: +10 bonus

Examples:
- "remind me to call mom tomorrow at 3pm" → {"title": "Call mom", "due_at": "2026-02-25T15:00:00.000Z", "recurring": null, "priority_score": 45, "risk": "Low", "optimal_reminder_time": "2026-02-25T14:00:00.000Z"}
- "pay Netflix bill tonight" → {"title": "Pay Netflix bill", "due_at": "2026-02-24T20:00:00.000Z", "recurring": null, "priority_score": 82, "risk": "Moderate", "optimal_reminder_time": "2026-02-24T18:00:00.000Z"}`;

  const messages = [{ role: 'user', content: prompt }];

  let result;
  try {
    // Try llama3.2:3b first (always available), phi3:mini as secondary
    const running = await ollama.isRunning();
    if (!running) return manualParseReminder(input);
    try {
      result = await ollama.call('llama3.2:3b', messages, { temperature: 0.1, max_tokens: 200 });
    } catch (_) {
      result = await ollama.call('phi3:mini', messages, { temperature: 0.1, max_tokens: 200 });
    }
  } catch (err) {
    console.log('[AI] Ollama parse failed — using manual parser:', err.message);
    return manualParseReminder(input);
  }

  // Try to parse JSON from response
  try {
    // Extract JSON from response (might have extra text around it)
    const jsonMatch = result.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error('No JSON found in response');
    const parsed = JSON.parse(jsonMatch[0]);

    if (!parsed.title || !parsed.due_at) {
      throw new Error('Missing required fields');
    }

    return parsed;
  } catch (parseErr) {
    // Retry once
    try {
      const retryMessages = [
        ...messages,
        { role: 'assistant', content: result },
        { role: 'user', content: 'That was not valid JSON. Please respond with ONLY the JSON object, nothing else.' }
      ];

      let retryResult;
      try {
        retryResult = await ollama.call('llama3.2:3b', retryMessages, { temperature: 0.1, max_tokens: 200 });
      } catch {
        return manualParseReminder(input); // Ollama failed twice — manual parse
      }

      const jsonMatch = retryResult.match(/\{[\s\S]*\}/);
      if (!jsonMatch) throw new Error('No JSON found');
      return JSON.parse(jsonMatch[0]);
    } catch {
      return manualParseReminder(input);
    }
  }
}

/**
 * Simple manual reminder parser — last resort fallback.
 * Handles basic patterns without AI.
 */
function manualParseReminder(input) {
  const now = new Date();
  const title = input
    .replace(/remind me to /i, '')
    .replace(/at \d{1,2}(:\d{2})?\s*(am|pm)?/i, '')
    .replace(/tomorrow|today|tonight/i, '')
    .replace(/every (day|week|month|monday|tuesday|wednesday|thursday|friday|saturday|sunday)/i, '')
    .trim();

  // Default to 1 hour from now
  let dueAt = new Date(now.getTime() + 60 * 60 * 1000);

  // Check for tomorrow
  if (/tomorrow/i.test(input)) {
    dueAt = new Date(now);
    dueAt.setDate(dueAt.getDate() + 1);
    dueAt.setHours(9, 0, 0, 0);
  }

  // Check for tonight
  if (/tonight/i.test(input)) {
    dueAt = new Date(now);
    dueAt.setHours(20, 0, 0, 0);
  }

  // Check for time pattern
  const timeMatch = input.match(/at (\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i);
  if (timeMatch) {
    let hours = parseInt(timeMatch[1]);
    const minutes = parseInt(timeMatch[2] || '0');
    const ampm = timeMatch[3]?.toLowerCase();
    if (ampm === 'pm' && hours < 12) hours += 12;
    if (ampm === 'am' && hours === 12) hours = 0;
    dueAt.setHours(hours, minutes, 0, 0);
  }

  // Check for recurring
  let recurring = null;
  if (/every\s*day|daily/i.test(input)) recurring = 'daily';
  if (/every\s*week|weekly|every\s*(mon|tue|wed|thu|fri|sat|sun)/i.test(input)) recurring = 'weekly';
  if (/every\s*month|monthly/i.test(input)) recurring = 'monthly';

  return {
    title: title || input.substring(0, 50),
    due_at: dueAt.toISOString(),
    recurring
  };
}

/**
 * Classify user chat message intent.
 * Tries Ollama first, falls back to Haiku.
 */
/**
 * Classify intent — Ollama only. Returns 'chat' if Ollama is offline.
 */
async function classifyIntent(input) {
  const prompt = `Classify this user message into one intent: reminder, email, weather, calendar, chat, settings.
Only respond with the single intent word.

Message: "${input}"`;

  try {
    const running = await ollama.isRunning();
    if (!running) return 'chat';
    const result = await ollama.call('llama3.2:3b', [{ role: 'user', content: prompt }], { temperature: 0.1, max_tokens: 10 });
    return result.toLowerCase().trim() || 'chat';
  } catch (err) {
    console.log('[AI] Ollama intent failed — defaulting to chat');
    return 'chat';
  }
}

module.exports = { aiCall };
