/**
 * electron/auth.js — Google OAuth2 via Electron BrowserWindow + local HTTP server
 *
 * Starts a temporary HTTP server on localhost:17995 to receive the OAuth redirect.
 * This is the only 100% reliable method — no BrowserWindow event interception needed.
 *
 * Google Cloud Console requirements:
 *   - OAuth client type: Web application
 *   - Authorized redirect URIs: http://localhost:17995
 */

const { BrowserWindow, shell } = require('electron');
const http = require('http');
const { URL } = require('url');

const REDIRECT_PORT = 17995;
const REDIRECT_URI  = `http://localhost:${REDIRECT_PORT}`;

const SCOPES = [
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.modify',
  'https://www.googleapis.com/auth/userinfo.email'
].join(' ');

/**
 * Start a temporary HTTP server, open the Google consent page in a BrowserWindow,
 * and resolve with the auth code once Google redirects back.
 * @returns {Promise<string>} authorization code
 */
function googleOAuth(clientId, clientSecret) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const settle = (fn, val) => {
      if (settled) return;
      settled = true;
      fn(val);
    };

    // ── 1. Start local HTTP server to receive the redirect ──
    const server = http.createServer((req, res) => {
      const reqUrl = new URL(req.url, `http://localhost:${REDIRECT_PORT}`);
      const code   = reqUrl.searchParams.get('code');
      const error  = reqUrl.searchParams.get('error');

      if (!code && !error) {
        res.writeHead(204);
        res.end();
        return;
      }

      // Send a friendly page so the browser window shows something
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(`<html><body style="font-family:sans-serif;text-align:center;padding:60px">
        <h2>${code ? '✅ Gmail connected!' : '❌ Auth failed'}</h2>
        <p>${code ? 'You can close this window and return to ARIA.' : (error || 'Unknown error')}</p>
        <script>setTimeout(()=>window.close(),2000)</script>
      </body></html>`);

      server.close();
      try { if (authWin && !authWin.isDestroyed()) authWin.close(); } catch (_) {}

      if (code) settle(resolve, code);
      else      settle(reject, new Error(`Google auth error: ${error}`));
    });

    server.on('error', (err) => {
      settle(reject, new Error(`OAuth server failed to start: ${err.message}`));
    });

    server.listen(REDIRECT_PORT, '127.0.0.1', () => {
      // ── 2. Open consent screen in a BrowserWindow ──
      const authUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth');
      authUrl.searchParams.set('client_id',     clientId);
      authUrl.searchParams.set('redirect_uri',  REDIRECT_URI);
      authUrl.searchParams.set('response_type', 'code');
      authUrl.searchParams.set('scope',         SCOPES);
      authUrl.searchParams.set('access_type',   'offline');
      authUrl.searchParams.set('prompt',        'consent');

      const authWin = new BrowserWindow({
        width: 520,
        height: 680,
        center: true,
        title: 'Sign in with Google — ARIA',
        webPreferences: {
          nodeIntegration: false,
          contextIsolation: true
        }
      });

      authWin.loadURL(authUrl.toString());

      authWin.on('closed', () => {
        server.close();
        settle(reject, new Error('Sign-in window closed before completing — please try again'));
      });
    });
  });
}

/**
 * Exchange authorization code for access + refresh tokens.
 * @returns {Promise<{access_token, refresh_token, expires_in, ...}>}
 */
async function exchangeCodeForTokens(code, clientId, clientSecret) {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: REDIRECT_URI,
      grant_type: 'authorization_code'
    }).toString()
  });
  return res.json();
}

/**
 * Refresh an expired access token.
 * @returns {Promise<{access_token, expires_in, ...}>}
 */
async function refreshAccessToken(refreshToken, clientId, clientSecret) {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      refresh_token: refreshToken,
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: 'refresh_token'
    }).toString()
  });
  return res.json();
}

module.exports = { googleOAuth, exchangeCodeForTokens, refreshAccessToken, REDIRECT_URI };
