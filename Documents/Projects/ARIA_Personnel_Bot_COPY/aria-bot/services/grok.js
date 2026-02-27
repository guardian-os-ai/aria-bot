/**
 * services/grok.js — Grok (xAI) client via OpenAI-compatible endpoint
 * Used for: Email analysis fallback between Gemini and Ollama
 * 
 * Key stored under keytar service 'aria-bot', account 'grok-api-key'.
 * Get a free key at: https://console.x.ai/
 */

const OpenAI = require('openai');
const { logAiUsage, getSetting } = require('../db/index.js');

const MODELS = ['grok-3-mini', 'grok-2-latest', 'grok-2', 'grok-beta'];
const GROK_BASE_URL = 'https://api.x.ai/v1';
const MAX_OUTPUT_TOKENS = 1500;

class NoApiKeyError extends Error {
  constructor() {
    super('Add your Grok API key in Settings to enable Grok fallback. Get one at console.x.ai');
    this.name = 'NoApiKeyError';
  }
}

let client = null;

/**
 * Get or create the OpenAI client pointed at xAI's Grok.
 * Priority: process.env.GROK_API_KEY → keytar → settings DB fallback.
 */
async function getClient() {
  let apiKey = process.env.GROK_API_KEY || null;

  if (!apiKey) {
    try {
      const keytar = require('keytar');
      apiKey = await keytar.getPassword('aria-bot', 'grok-api-key');
    } catch (err) {
      // keytar not available, fall through to settings
    }
  }

  if (!apiKey) {
    apiKey = getSetting('grok_api_key_fallback');
  }

  if (!apiKey) {
    throw new NoApiKeyError();
  }

  if (!client) {
    client = new OpenAI({
      apiKey,
      baseURL: GROK_BASE_URL
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
 * Call Grok via OpenAI-compatible chat completions.
 * @param {string} task - 'analyse'|'chat' etc.
 * @param {string} userMessage - The user message/prompt
 * @param {object} context - Optional context
 * @returns {Promise<string>} - Response text
 */
async function call(task, userMessage, context = {}) {
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
    const contextStr = contextParts.join('\n') || 'No additional context available.';
    systemPrompt = `You are ARIA, a personal assistant bot running on Windows.
You have access to the user's email summaries, calendar events, and reminders.
Be concise and accurate.
Current context: ${contextStr}`;
  }

  const inputTokenEstimate = estimateTokens(systemPrompt + userMessage);

  let response = null;
  let lastError = null;

  for (const model of MODELS) {
    try {
      response = await openai.chat.completions.create({
        model,
        max_tokens: MAX_OUTPUT_TOKENS,
        temperature: 0.3,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userMessage }
        ]
      });
      break;
    } catch (err) {
      lastError = err;
      const msg = err?.message?.toLowerCase?.() || '';
      const isModelIssue = msg.includes('model not found') || msg.includes('model_not_found')
        || msg.includes('not available') || err?.status === 404 || err?.status === 400;
      if (!isModelIssue) {
        throw err; // Non-model error, don't try next model
      }
      console.log(`[Grok] Model '${model}' unavailable, trying next...`);
    }
  }

  if (!response) {
    throw new Error(`Grok call failed: ${lastError?.message || 'No Grok model available'}`);
  }

  const responseText = response.choices[0]?.message?.content || '';

  // Log usage
  const tokensIn  = response.usage?.prompt_tokens     || inputTokenEstimate;
  const tokensOut = response.usage?.completion_tokens || estimateTokens(responseText);
  logAiUsage('grok', task, tokensIn, tokensOut);

  return responseText;
}

/**
 * Save Grok API key (keytar or DB fallback)
 */
async function setApiKey(key) {
  try {
    const keytar = require('keytar');
    await keytar.setPassword('aria-bot', 'grok-api-key', key);
  } catch (err) {
    const { saveSetting } = require('../db/index.js');
    saveSetting('grok_api_key_fallback', key);
  }
  resetClient();
}

module.exports = {
  call,
  setApiKey,
  resetClient,
  NoApiKeyError
};
