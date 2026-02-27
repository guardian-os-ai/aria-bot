/**
 * services/gmail-oauth.js — Google OAuth2 for Gmail IMAP
 *
 * Handles the full OAuth2 flow:
 *  1. Generate auth URL → open in Electron BrowserWindow
 *  2. Exchange auth code for access + refresh tokens
 *  3. Refresh access token when expired
 *  4. Store tokens securely via settings DB
 *
 * No extra dependencies — uses Node.js built-in https.
 */

const https = require('https');
const { URL, URLSearchParams } = require('url');
const { getSetting, run } = require('../db/index.js');

// Secure token — injected from keytar at startup (overrides DB fallback)
let _injectedRefreshToken = null;

/**
 * Called by main.js after loading the token from keytar.
 * Keeps the refresh token out of persistent module state in DB.
 */
function injectRefreshToken(token) {
  _injectedRefreshToken = token || null;
}

function _getRefreshToken() {
  return _injectedRefreshToken || getSetting('gmail_refresh_token') || null;
}

// Google OAuth2 endpoints
const AUTH_URL   = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL  = 'https://oauth2.googleapis.com/token';
const SCOPE      = 'https://mail.google.com/';
const REDIRECT   = 'http://127.0.0.1:17995/oauth2callback';

/* ── Helpers ── */

function saveSetting(key, value) {
  const exist = getSetting(key);
  if (exist !== undefined && exist !== null) {
    run('UPDATE settings SET value = ? WHERE key = ?', [value, key]);
  } else {
    run('INSERT INTO settings (key, value) VALUES (?, ?)', [key, value]);
  }
}

function httpsPost(url, body) {
  return new Promise((resolve, reject) => {
    const data = new URLSearchParams(body).toString();
    const parsed = new URL(url);
    const opts = {
      hostname: parsed.hostname,
      path: parsed.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(data)
      }
    };
    const req = https.request(opts, (res) => {
      let chunks = '';
      res.on('data', c => chunks += c);
      res.on('end', () => {
        try { resolve(JSON.parse(chunks)); }
        catch { resolve({ raw: chunks }); }
      });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

/* ── Public API ── */

/**
 * Get the OAuth2 authorization URL to open in a browser window.
 */
function getAuthUrl() {
  const clientId = process.env.GMAIL_CLIENT_ID || getSetting('gmail_client_id');
  if (!clientId) return null;

  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: REDIRECT,
    response_type: 'code',
    scope: SCOPE,
    access_type: 'offline',
    prompt: 'consent'
  });
  return `${AUTH_URL}?${params.toString()}`;
}

/**
 * Exchange authorization code for tokens. Save them to DB.
 */
async function exchangeCode(code) {
  const clientId     = process.env.GMAIL_CLIENT_ID || getSetting('gmail_client_id');
  const clientSecret = process.env.GMAIL_CLIENT_SECRET || getSetting('gmail_client_secret');
  if (!clientId || !clientSecret) throw new Error('Missing Gmail OAuth client ID/secret');

  const result = await httpsPost(TOKEN_URL, {
    code,
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: REDIRECT,
    grant_type: 'authorization_code'
  });

  if (result.error) throw new Error(result.error_description || result.error);

  saveSetting('gmail_access_token', result.access_token);
  const newRefresh = result.refresh_token || _getRefreshToken() || '';
  injectRefreshToken(newRefresh);
  // Do NOT persist refresh_token to DB — keytar handles it (main.js)
  saveSetting('gmail_token_expires', String(Date.now() + (result.expires_in || 3600) * 1000));

  return { success: true };
}

/**
 * Refresh the access token using the refresh token.
 */
async function refreshAccessToken() {
  const clientId     = process.env.GMAIL_CLIENT_ID || getSetting('gmail_client_id');
  const clientSecret = process.env.GMAIL_CLIENT_SECRET || getSetting('gmail_client_secret');
  const refreshToken = _getRefreshToken();
  if (!clientId || !clientSecret || !refreshToken) return null;

  const result = await httpsPost(TOKEN_URL, {
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: refreshToken,
    grant_type: 'refresh_token'
  });

  if (result.error) {
    console.error('[OAuth2] Refresh failed:', result.error_description || result.error);
    return null;
  }

  saveSetting('gmail_access_token', result.access_token);
  saveSetting('gmail_token_expires', String(Date.now() + (result.expires_in || 3600) * 1000));

  return result.access_token;
}

/**
 * Get a valid access token (refreshing if needed).
 */
async function getAccessToken() {
  const token = getSetting('gmail_access_token');
  const expires = parseInt(getSetting('gmail_token_expires') || '0', 10);
  const refreshToken = _getRefreshToken();

  if (!token || !refreshToken) return null;

  // If token is still valid (with 5 min buffer), return it
  if (Date.now() < expires - 300_000) return token;

  // Otherwise refresh
  return await refreshAccessToken();
}

/**
 * Check if OAuth2 is configured and has tokens.
 */
function isOAuth2Configured() {
  return !!(getSetting('gmail_access_token') && _getRefreshToken());
}

/**
 * Build the XOAUTH2 token string for IMAP.
 * Format: user=<email>\x01auth=Bearer <token>\x01\x01
 */
function buildXOAuth2Token(email, accessToken) {
  return Buffer.from(
    `user=${email}\x01auth=Bearer ${accessToken}\x01\x01`
  ).toString('base64');
}

/**
 * Clear all OAuth2 tokens (disconnect).
 */
function clearOAuth2() {
  _injectedRefreshToken = null;
  ['gmail_access_token', 'gmail_refresh_token', 'gmail_token_expires'].forEach(key => {
    run('DELETE FROM settings WHERE key = ?', [key]);
  });
}

/**
 * Returns the refresh token — checks keytar-injected variable first, then DB fallback.
 * Used by external services (e.g. gmail.js) that manage their own token refresh.
 */
function getRefreshToken() {
  return _getRefreshToken();
}

module.exports = {
  getAuthUrl,
  exchangeCode,
  refreshAccessToken,
  getAccessToken,
  getRefreshToken,
  isOAuth2Configured,
  buildXOAuth2Token,
  clearOAuth2,
  injectRefreshToken,
  REDIRECT
};
