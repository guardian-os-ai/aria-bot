/**
 * services/haiku.js — Gemini client via OpenAI-compatible endpoint
 * Used for: email summarisation, briefing generation, chat responses.
 * Hard limits: 2000 tokens in, 500 tokens out, 20 calls/day.
 *
 * Key stored under keytar service 'aria-bot', account 'gemini-api-key'.
 * Get a free key at: https://aistudio.google.com/apikey
 */

const OpenAI = require('openai');
const { logAiUsage, getHaikuUsageToday, getSetting } = require('../db/index.js');

const MODEL         = 'gemini-2.5-flash';  // primary model
const MODEL_FALLBACK = 'gemini-2.5-flash';  // same model for fallback
const GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta/openai/';
const MAX_INPUT_TOKENS = 8000;
const MAX_OUTPUT_TOKENS = 1500;
const DAILY_CAP = 20;

class NoApiKeyError extends Error {
  constructor() {
    super('Add your Gemini API key in Settings to enable AI features. Get one free at aistudio.google.com/apikey');
    this.name = 'NoApiKeyError';
  }
}

class DailyCapReachedError extends Error {
  constructor(count) {
    super(`Daily AI limit reached (${count}/${DAILY_CAP}). Resets at midnight.`);
    this.name = 'DailyCapReachedError';
  }
}

let client = null;

/**
 * Get or create the OpenAI client pointed at Gemini.
 * Priority: process.env.GEMINI_API_KEY → keytar → settings DB fallback.
 */
async function getClient() {
  let apiKey = process.env.GEMINI_API_KEY || null;

  if (!apiKey) {
    try {
      const keytar = require('keytar');
      apiKey = await keytar.getPassword('aria-bot', 'gemini-api-key');
    } catch (err) {
      // keytar not available, fall through to settings
    }
  }

  if (!apiKey) {
    apiKey = getSetting('gemini_api_key_fallback');
  }

  if (!apiKey) {
    throw new NoApiKeyError();
  }

  if (!client) {
    client = new OpenAI({
      apiKey,
      baseURL: GEMINI_BASE_URL
    });
  }

  return client;
}

/**
 * Reset client (call when API key changes)
 */
function resetClient() {
  client = null;
}

/**
 * Rough token estimation — ~4 chars per token.
 */
function estimateTokens(text) {
  return Math.ceil((text || '').length / 4);
}

/**
 * Truncate text to stay within a token limit.
 */
function truncateToTokens(text, maxTokens) {
  const maxChars = maxTokens * 4;
  if (text.length <= maxChars) return text;
  return text.substring(0, maxChars) + '\n[...truncated]';
}

/**
 * Call Gemini via OpenAI-compatible chat completions.
 * @param {string} task - 'summarise'|'briefing'|'chat' etc.
 * @param {string} userMessage - The user message/prompt
 * @param {object} context - Optional context (emails, calendar, reminders, weather)
 * @returns {Promise<string>} - Response text
 */
async function call(task, userMessage, context = {}) {
  // Check daily cap
  const usageCount = getHaikuUsageToday();
  if (usageCount >= DAILY_CAP) {
    throw new DailyCapReachedError(usageCount);
  }

  const openai = await getClient();

  // Use full system context from chatEnhancedHandler when available (includes all personal brain data)
  let systemPrompt;
  if (context.systemContext) {
    systemPrompt = context.systemContext;
  } else {
    const contextParts = [];
    if (context.emails)    contextParts.push(`Recent emails: ${JSON.stringify(context.emails)}`);
    if (context.calendar)  contextParts.push(`Calendar today: ${JSON.stringify(context.calendar)}`);
    if (context.reminders) contextParts.push(`Reminders: ${JSON.stringify(context.reminders)}`);
    if (context.weather)   contextParts.push(`Weather: ${JSON.stringify(context.weather)}`);
    const contextStr = contextParts.join('\n') || 'No additional context available.';
    systemPrompt = `You are ARIA, a personal assistant bot running on Windows.
You have access to the user's email summaries, calendar events, and reminders.
Be concise. Max 3 sentences unless asked for more.
Current context: ${contextStr}`;
  }

  // Truncate to stay within limits
  const availableForMessage = MAX_INPUT_TOKENS - estimateTokens(systemPrompt) - 50;
  const truncatedMessage = truncateToTokens(userMessage, Math.max(availableForMessage, 200));
  const inputTokenEstimate = estimateTokens(systemPrompt + truncatedMessage);

  const doRequest = async (model) => {
    const response = await openai.chat.completions.create({
      model,
      max_tokens: MAX_OUTPUT_TOKENS,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user',   content: truncatedMessage }
      ]
    });
    return response;
  };

  let response;
  try {
    response = await doRequest(MODEL);
  } catch (err) {
    if (err instanceof NoApiKeyError || err instanceof DailyCapReachedError) {
      throw err;
    }
    // Retry once on 429 (rate limit) after a short delay, using fallback model
    const is429 = err?.status === 429 ||
                  err?.message?.includes('429') ||
                  err?.message?.includes('rate') ||
                  err?.message?.includes('quota');
    if (is429) {
      console.warn(`[AI] Rate limited on ${MODEL}, retrying with ${MODEL_FALLBACK} in 5s...`);
      await new Promise((r) => setTimeout(r, 5000));
      try {
        response = await doRequest(MODEL_FALLBACK);
      } catch (retryErr) {
        throw new Error(`Gemini call failed: ${retryErr.message}`);
      }
    } else {
      throw new Error(`Gemini call failed: ${err.message}`);
    }
  }

  const responseText = response.choices[0]?.message?.content || '';

  // Log usage
  const tokensIn  = response.usage?.prompt_tokens     || inputTokenEstimate;
  const tokensOut = response.usage?.completion_tokens || estimateTokens(responseText);
  logAiUsage('haiku', task, tokensIn, tokensOut);

  return responseText;
}

/**
 * Save Gemini API key (keytar or DB fallback)
 */
async function setApiKey(key) {
  try {
    const keytar = require('keytar');
    await keytar.setPassword('aria-bot', 'gemini-api-key', key);
  } catch (err) {
    const { saveSetting } = require('../db/index.js');
    saveSetting('gemini_api_key_fallback', key);
  }
  resetClient();
}

module.exports = {
  call,
  setApiKey,
  resetClient,
  NoApiKeyError,
  DailyCapReachedError,
  DAILY_CAP
};
