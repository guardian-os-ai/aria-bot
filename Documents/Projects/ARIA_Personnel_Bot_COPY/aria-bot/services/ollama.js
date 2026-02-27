/**
 * services/ollama.js — Ollama local LLM client
 * Connects to localhost:11434 for free local inference.
 * Used for: email categorisation, reminder parsing, intent classification.
 */

const axios = require('axios');

const OLLAMA_BASE = 'http://localhost:11434';
const OLLAMA_TIMEOUT = 30000; // 30 seconds for local inference (large context)
const HEALTH_TIMEOUT = 2000;  // 2 seconds for health check

class OllamaOfflineError extends Error {
  constructor() {
    super('Ollama is not running. Install and start Ollama, or ARIA will use Haiku (counts against daily limit).');
    this.name = 'OllamaOfflineError';
  }
}

/**
 * Check if Ollama is running by hitting the tags endpoint.
 * @returns {Promise<boolean>}
 */
async function isRunning() {
  try {
    const res = await axios.get(`${OLLAMA_BASE}/api/tags`, { timeout: HEALTH_TIMEOUT });
    return res.status === 200;
  } catch (err) {
    return false;
  }
}

/**
 * Call Ollama using the OpenAI-compatible chat completions endpoint.
 * @param {string} model - e.g., 'llama3.2:3b', 'phi3:mini'
 * @param {Array} messages - OpenAI-format messages array [{role, content}]
 * @param {object} options - { temperature, max_tokens }
 * @returns {Promise<string>} - The assistant's response text
 */
async function call(model, messages, options = {}) {
  const running = await isRunning();
  if (!running) {
    throw new OllamaOfflineError();
  }

  const temperature = options.temperature ?? 0.1;
  const maxTokens = options.max_tokens ?? 500;
  const timeoutMs = options.timeout ?? OLLAMA_TIMEOUT;

  try {
    const response = await axios.post(
      `${OLLAMA_BASE}/v1/chat/completions`,
      {
        model,
        messages,
        temperature,
        max_tokens: maxTokens,
        stream: false
      },
      { timeout: timeoutMs }
    );

    const choice = response.data?.choices?.[0];
    if (!choice?.message?.content) {
      throw new Error('Empty response from Ollama');
    }

    return choice.message.content.trim();
  } catch (err) {
    if (err instanceof OllamaOfflineError) throw err;
    if (err.code === 'ECONNREFUSED' || err.code === 'ECONNRESET') {
      throw new OllamaOfflineError();
    }
    throw new Error(`Ollama call failed: ${err.message}`);
  }
}

module.exports = { call, isRunning, OllamaOfflineError };
