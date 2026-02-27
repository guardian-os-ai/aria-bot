/**
 * electron/main.js — Main Electron process
 * Creates the floating overlay window, registers IPC handlers,
 * global shortcuts, and initializes all backend services.
 */

const { app, BrowserWindow, ipcMain, globalShortcut, screen, session, shell, Tray, Menu, nativeImage } = require('electron');
const path = require('path');
const fs   = require('fs');
const { initDatabase, run, get, all, getSetting, saveSetting, logAiUsage, getHaikuUsageToday, close: closeDb } = require('../db/index.js');

// ── Load .env file (zero dependencies) ──
// Looks for .env in project root, then %APPDATA%/aria-bot/.env
function loadEnvFile() {
  const candidates = [
    path.join(__dirname, '..', '.env'),                           // project root
    path.join(process.env.APPDATA || '', 'aria-bot', '.env'),     // appdata
  ];
  for (const envPath of candidates) {
    try {
      if (!fs.existsSync(envPath)) continue;
      const content = fs.readFileSync(envPath, 'utf8');
      for (const line of content.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const eqIdx = trimmed.indexOf('=');
        if (eqIdx < 1) continue;
        const key = trimmed.substring(0, eqIdx).trim();
        let val = trimmed.substring(eqIdx + 1).trim();
        // Remove surrounding quotes
        if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
          val = val.slice(1, -1);
        }
        if (val && !process.env[key]) {
          process.env[key] = val;
        }
      }
      console.log(`[ARIA] Loaded .env from ${envPath}`);
      return;
    } catch (_) {}
  }
}
loadEnvFile();

// Suppress GPU shader disk-cache errors (cache_util_win / disk_cache popups)
app.commandLine.appendSwitch('disable-gpu-shader-disk-cache');
app.commandLine.appendSwitch('disable-software-rasterizer');
app.commandLine.appendSwitch('log-level', '3'); // errors only, no warnings

// ── Inline Tray (avoids externalize issue) ──
function createTray(toggleWindow) {
  const iconPath = path.join(__dirname, '..', 'assets', 'tray.png');
  let icon;
  try {
    icon = nativeImage.createFromPath(iconPath);
    if (icon.isEmpty()) icon = createFallbackIcon();
  } catch (_) { icon = createFallbackIcon(); }

  const t = new Tray(icon);
  t.setToolTip('ARIA — Personal Bot');
  t.setContextMenu(Menu.buildFromTemplate([
    { label: 'Show/Hide ARIA', click: () => toggleWindow() },
    { type: 'separator' },
    { label: 'Settings', click: () => toggleWindow() },
    { type: 'separator' },
    { label: 'Quit ARIA', click: () => { app.isQuitting = true; app.quit(); } }
  ]));
  t.on('click', () => toggleWindow());
  return t;
}
function createFallbackIcon() {
  const s = 16, buf = Buffer.alloc(s * s * 4);
  for (let y = 0; y < s; y++) for (let x = 0; x < s; x++) {
    const d = Math.sqrt((x-s/2)**2+(y-s/2)**2), i = (y*s+x)*4;
    if (d < s/2-1) { buf[i]=0x4f; buf[i+1]=0x9c; buf[i+2]=0xf9; buf[i+3]=255; }
  }
  return nativeImage.createFromBuffer(buf, { width: s, height: s });
}

// Services — imported after DB init
let aiService, gmailService, calendarService, remindService, briefingService, weatherService, habitsService, focusService, weeklyReportService, nlQueryService, analyticsService, calendarIntelService, financialIntel, intelligenceService, responseCacheService, memoryExtractService, automationRulesService, goalsService;

// ── Python Sidecar (P2-1) — with auto-restart, heartbeat, and delta streaming ─────────────────────────────────────────────────
// Spawns python-engine/engine.py as a child process.
// JSON lines over stdin/stdout: { id, type, payload } → { id, result, error }
let _pythonProc = null;
const _pythonCallbacks = new Map();
const _pythonStreamCallbacks = new Map(); // for agent_stream chunk routing
let _pythonReqId = 1;

// ── Restart / heartbeat state ──
let _sidecarRetryCount  = 0;
let _heartbeatTimer     = null;
const _SIDECAR_MAX_RETRIES = 5;
const _SIDECAR_BACKOFF_MS  = [2000, 4000, 8000, 16000, 32000];

function _stopHeartbeat() {
  if (_heartbeatTimer) { clearInterval(_heartbeatTimer); _heartbeatTimer = null; }
}

function _startHeartbeat() {
  _stopHeartbeat();
  _heartbeatTimer = setInterval(async () => {
    if (!_pythonProc) return;
    try {
      const r = await callPython('ping', {}, 5000);
      if (r?.status === 'ok') _sidecarRetryCount = 0; // reset backoff counter on success
    } catch (_hbErr) {
      console.warn('[Heartbeat] No response — killing and restarting sidecar');
      _stopHeartbeat();
      try { _pythonProc?.kill('SIGKILL'); } catch (_) {}
      _pythonProc = null;
      // exit handler will auto-restart
    }
  }, 30000);
}

function startPythonSidecar(isRetry = false) {
  if (isRetry) {
    if (_sidecarRetryCount >= _SIDECAR_MAX_RETRIES) {
      console.error('[Python sidecar] Max retries exceeded — giving up');
      if (mainWindow) {
        mainWindow.webContents.send('sidecar-fatal', {
          message: 'AI engine failed to start after multiple retries. Please restart ARIA.'
        });
      }
      return;
    }
    const delay = _SIDECAR_BACKOFF_MS[_sidecarRetryCount] || 32000;
    _sidecarRetryCount++;
    console.warn(`[Python sidecar] Retry ${_sidecarRetryCount}/${_SIDECAR_MAX_RETRIES} in ${delay}ms...`);
    if (mainWindow) mainWindow.webContents.send('sidecar-status', { status: 'restarting', retry: _sidecarRetryCount });
    setTimeout(() => _doStartSidecar(), delay);
    return;
  }
  // Fresh start — reset counter
  _sidecarRetryCount = 0;
  _doStartSidecar();
}

function _doStartSidecar() {
  const { spawn } = require('child_process');
  const enginePath = path.join(__dirname, '..', 'python-engine', 'engine.py');
  const python = process.platform === 'win32' ? 'python' : 'python3';

  // Minimal environment — avoids leaking secrets present in process.env
  const safeEnv = {
    PATH:          process.env.PATH          || '',
    APPDATA:       process.env.APPDATA       || '',
    HOME:          process.env.HOME          || '',
    USERPROFILE:   process.env.USERPROFILE   || '',
    LOCALAPPDATA:  process.env.LOCALAPPDATA  || '',
    SYSTEMROOT:    process.env.SYSTEMROOT    || '',
    TEMP:          process.env.TEMP          || process.env.TMP || '',
    TMP:           process.env.TMP           || process.env.TEMP || '',
    PYTHONUNBUFFERED: '1',
  };

  _pythonProc = spawn(python, [enginePath], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: safeEnv
  });

  let buffer = '';
  _pythonProc.stdout.on('data', (chunk) => {
    buffer += chunk.toString();
    const lines = buffer.split('\n');
    buffer = lines.pop(); // keep incomplete line
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const msg = JSON.parse(line);

        // Ready signal (id=0) — start heartbeat + run import check
        if (msg.id === 0 && msg.result?.status === 'ready') {
          _startHeartbeat();
          callPython('check_imports', {}, 15000).then(result => {
            if (!result?.ok && mainWindow) {
              const missing = (result?.missing || []).join(', ');
              mainWindow.webContents.send('sidecar-status', {
                status: 'degraded',
                message: `Missing Python packages: ${missing}. Run: pip install ${missing}`
              });
            }
          }).catch(() => {});
          continue;
        }

        // Streaming chunk: has "chunk" key but no "result" / "error"
        if ('chunk' in msg && !('result' in msg) && !('error' in msg)) {
          const scb = _pythonStreamCallbacks.get(msg.id);
          if (scb?.onChunk) scb.onChunk(msg.chunk);
          continue;
        }
        // Final result — check stream callbacks first, then regular
        const scb = _pythonStreamCallbacks.get(msg.id);
        const cb  = _pythonCallbacks.get(msg.id);
        const handler = scb || cb;
        if (handler) {
          _pythonStreamCallbacks.delete(msg.id);
          _pythonCallbacks.delete(msg.id);
          if (msg.error) handler.reject(new Error(msg.error));
          else handler.resolve(msg.result);
        }
      } catch (_) {}
    }
  });

  _pythonProc.stderr.on('data', d => console.log('[Python]', d.toString().trim()));

  _pythonProc.on('error', err => {
    console.error('[Python sidecar] spawn error:', err.message);
    if (err.code === 'ENOENT') {
      // Python not found — don't retry, show actionable error
      if (mainWindow) {
        mainWindow.webContents.send('sidecar-fatal', {
          message: 'Python not found. Please install Python 3.9+ and ensure it is in your PATH, then restart ARIA.'
        });
      }
      return;
    }
    startPythonSidecar(true);
  });

  _pythonProc.on('exit', (code) => {
    console.warn('[Python sidecar] exited with code', code);
    _stopHeartbeat();
    _pythonProc = null;
    // Reject all pending promises immediately so no request hangs forever
    for (const [, cb] of _pythonCallbacks)       cb.reject(new Error('Sidecar exited'));
    _pythonCallbacks.clear();
    for (const [, cb] of _pythonStreamCallbacks) cb.reject(new Error('Sidecar exited'));
    _pythonStreamCallbacks.clear();
    // Auto-restart with backoff
    startPythonSidecar(true);
  });
}

function callPython(type, payload = {}, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    if (!_pythonProc) return reject(new Error('Python sidecar not running'));
    const id = _pythonReqId++;
    const timer = setTimeout(() => {
      _pythonCallbacks.delete(id);
      reject(new Error(`Python sidecar timeout (${type})`));
    }, timeoutMs);
    _pythonCallbacks.set(id, {
      resolve: (v) => { clearTimeout(timer); resolve(v); },
      reject:  (e) => { clearTimeout(timer); reject(e); }
    });
    _pythonProc.stdin.write(JSON.stringify({ id, type, payload }) + '\n');
  });
}

// Streaming variant — onChunk(text: string) called for each incremental chunk
function callPythonStream(type, payload = {}, onChunk = null, timeoutMs = 90000) {
  return new Promise((resolve, reject) => {
    if (!_pythonProc) return reject(new Error('Python sidecar not running'));
    const id = _pythonReqId++;
    const timer = setTimeout(() => {
      _pythonStreamCallbacks.delete(id);
      reject(new Error(`Python sidecar stream timeout (${type})`));
    }, timeoutMs);
    _pythonStreamCallbacks.set(id, {
      onChunk,
      resolve: (v) => { clearTimeout(timer); resolve(v); },
      reject:  (e) => { clearTimeout(timer); reject(e); }
    });
    _pythonProc.stdin.write(JSON.stringify({ id, type, payload }) + '\n');
  });
}

function stopPythonSidecar() {
  _stopHeartbeat();
  if (_pythonProc) { _pythonProc.kill(); _pythonProc = null; }
}

// ── Helper functions (eliminate repeated boilerplate) ──
const nowUnix  = () => Math.floor(Date.now() / 1000);
const todayISO = () => new Date().toISOString().slice(0, 10);
const DAY      = 86400;

let mainWindow = null;
let tray = null;

// Determine if running in dev mode
const isDev = process.env.NODE_ENV === 'development' || !app.isPackaged;

function createWindow() {
  const primaryDisplay = screen.getPrimaryDisplay();
  const { width: screenWidth, height: screenHeight } = primaryDisplay.workAreaSize;

  mainWindow = new BrowserWindow({
    width: 348,
    height: 620,
    x: screenWidth - 364, // 16px from right edge
    y: screenHeight - 670, // accounts for taskbar
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    resizable: false,
    skipTaskbar: false,
    backgroundColor: '#00000000',
    show: false, // Show when ready to avoid flash
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false // Required for better-sqlite3 native module
    }
  });

  // Load the renderer
  if (isDev) {
    // In dev mode, electron-vite serves on localhost
    mainWindow.loadURL('http://localhost:5173');
    // Open devtools in a separate window during development
    // mainWindow.webContents.openDevTools({ mode: 'detach' });
  } else {
    mainWindow.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
  }

  // Show window once ready (hidden on auto-start boot)
  const startHidden = process.argv.includes('--hidden');
  mainWindow.once('ready-to-show', () => {
    if (!startHidden) mainWindow.show();
  });

  // Hide instead of close (minimize to tray)
  mainWindow.on('close', (event) => {
    if (!app.isQuitting) {
      event.preventDefault();
      mainWindow.hide();
    }
  });

  return mainWindow;
}

function toggleWindow() {
  if (!mainWindow) return;
  if (mainWindow.isVisible()) {
    mainWindow.hide();
  } else {
    mainWindow.show();
    mainWindow.focus();
  }
}

// ── Proactive email intelligence routing ──
// Runs AFTER categorization — creates tasks from deadlines, logs transactions,
// ensures subscriptions and renewal reminders exist. The bot is smart by default.

async function routeEmailInsights() {
  const now = nowUnix();
  let tasksCreated = 0, txLogged = 0, subsCreated = 0;

  try {
    // ── 1. Deadline → Task/Reminder ──
    const emails = all(
      `SELECT message_id, subject, from_name, from_email, smart_action, summary, received_at
       FROM email_cache WHERE smart_action IS NOT NULL AND received_at > ?`,
      [now - 30 * 86400]
    );

    for (const email of emails) {
      let sa;
      try { sa = typeof email.smart_action === 'string' ? JSON.parse(email.smart_action) : email.smart_action; } catch (_) { continue; }
      if (!sa) continue;

      // Create task from deadline
      if (sa.deadline) {
        const deadlineTs = Math.floor(new Date(sa.deadline).getTime() / 1000);
        if (!isNaN(deadlineTs) && deadlineTs > now - 86400) {
          const title = (email.subject || 'Email task').substring(0, 100);
          const existing = get(
            `SELECT id FROM reminders WHERE LOWER(title) = LOWER(?) AND completed = 0`,
            [title]
          );
          if (!existing) {
            const subtitle = [
              sa.financial_impact || null,
              email.from_name || email.from_email?.split('@')[0] || null,
              sa.recommended_action === 'Required' ? 'Action Required' : null,
            ].filter(Boolean).join(' · ');

            const category = sa.email_type === 'Financial' ? 'finance'
              : sa.email_type === 'Meeting' ? 'meeting' : 'email';

            try {
              run(
                `INSERT INTO reminders (title, due_at, category, subtitle, source, smart_action, created_at)
                 VALUES (?, ?, ?, ?, 'email', ?, ?)`,
                [title, deadlineTs, category, subtitle || null,
                 typeof sa === 'string' ? sa : JSON.stringify(sa), now]
              );
              tasksCreated++;
            } catch (_) {} // duplicate or constraint
          }
        }
      }

      // Create task from urgent/required-action if no deadline (due = 24h from now)
      if (!sa.deadline && sa.recommended_action === 'Required' && (sa.urgent || sa.risk_level === 'High')) {
        const title = (email.subject || 'Urgent email').substring(0, 100);
        const existing = get(
          `SELECT id FROM reminders WHERE LOWER(title) = LOWER(?) AND completed = 0`,
          [title]
        );
        if (!existing) {
          const subtitle = [
            sa.financial_impact || null,
            sa.risk_level ? `${sa.risk_level} Risk` : null,
            email.from_name || email.from_email?.split('@')[0] || null,
          ].filter(Boolean).join(' · ');
          try {
            run(
              `INSERT INTO reminders (title, due_at, category, subtitle, source, smart_action, created_at)
               VALUES (?, ?, 'urgent', ?, 'email', ?, ?)`,
              [title, now + 86400, subtitle || null,
               typeof sa === 'string' ? sa : JSON.stringify(sa), now]
            );
            tasksCreated++;
          } catch (_) {}
        }
      }
    }

    // ── 2. Financial extraction → Transactions + Money ──
    if (financialIntel) {
      const txResult = financialIntel.persistTransactions({ all, run }, 90);
      txLogged = txResult.inserted;
    }

    // ── 3. Subscription + renewal reminder backfill ──
    if (financialIntel) {
      const subResult = financialIntel.persistSubscriptions({ all, run, get });
      subsCreated = subResult.subsCreated;
      tasksCreated = subResult.tasksCreated;
    }

    if (tasksCreated > 0 || txLogged > 0 || subsCreated > 0) {
      console.log(`[Route] Insights: ${tasksCreated} tasks, ${txLogged} transactions, ${subsCreated} subscriptions`);
    }
  } catch (err) {
    console.warn('[Route] routeEmailInsights error:', err.message);
  }

  return { tasksCreated, txLogged, subsCreated };
}

// ── IPC Handlers ──

function registerIpcHandlers() {
  // Reminders
  ipcMain.handle('get-reminders', async () => {
    try {
      // Refresh priority scores before returning
      try { remindService.recalculatePriorityScores(); } catch (_) {}
      // Overdue sorted by priority_score DESC (most urgent first)
      // Upcoming sorted by due_at ASC (soonest first)
      return all(
        `SELECT * FROM reminders WHERE completed = 0 AND archived_at IS NULL
         ORDER BY
           CASE WHEN due_at < strftime('%s','now') THEN 0 ELSE 1 END,
           CASE WHEN due_at < strftime('%s','now') THEN -priority_score ELSE due_at END ASC`
      );
    } catch (err) {
      console.error('[IPC] get-reminders error:', err);
      return [];
    }
  });

  ipcMain.handle('get-all-reminders', async () => {
    try {
      return all('SELECT * FROM reminders ORDER BY due_at DESC');
    } catch (err) {
      console.error('[IPC] get-all-reminders error:', err);
      return [];
    }
  });

  ipcMain.handle('add-reminder', async (_event, text) => {
    try {
      return await remindService.parseAndSave(text);
    } catch (err) {
      console.error('[IPC] add-reminder error:', err);
      return { error: err.message };
    }
  });

  ipcMain.handle('complete-reminder', async (_event, id) => {
    try {
      const now = nowUnix();
      // Fetch task info before completing for P10-2 predictive engine
      const task = get('SELECT title, category, created_at, due_at FROM reminders WHERE id = ?', [id]);
      run('UPDATE reminders SET completed = 1, completed_at = ? WHERE id = ?', [now, id]);

      // P10-2: Record task completion for time prediction
      if (task) {
        const actualMinutes = Math.round((now - task.created_at) / 60);
        const wasLate = task.due_at && now > task.due_at;
        recordTaskCompletion(task.title, task.category, actualMinutes, wasLate);

        // P10-5: Track prevented issue if task was about to be overdue
        if (task.due_at && now <= task.due_at && (task.due_at - now) < 86400) {
          trackPreventedIssue('missed_deadline', `Completed "${task.title}" just in time`, 200, `task-${id}`);
        }
      }

      return { success: true };
    } catch (err) {
      console.error('[IPC] complete-reminder error:', err);
      return { error: err.message };
    }
  });

  ipcMain.handle('archive-reminder', async (_event, id) => {
    try {
      run('UPDATE reminders SET archived_at = ? WHERE id = ?', [nowUnix(), id]);
      return { success: true };
    } catch (err) {
      console.error('[IPC] archive-reminder error:', err);
      return { error: err.message };
    }
  });

  ipcMain.handle('extend-reminder', async (_event, id, minutes) => {
    try {
      const now = nowUnix();
      const reminder = get('SELECT * FROM reminders WHERE id = ?', [id]);
      if (!reminder) return { error: 'Reminder not found' };
      const newDue = Math.max(reminder.due_at, now) + minutes * 60;
      run('UPDATE reminders SET due_at = ?, snoozed_to = NULL WHERE id = ?', [newDue, id]);
      // Reschedule the notification
      try { remindService.scheduleReminder({ ...reminder, due_at: newDue }); } catch (_) {}
      return { success: true, newDue };
    } catch (err) {
      console.error('[IPC] extend-reminder error:', err);
      return { error: err.message };
    }
  });

  ipcMain.handle('delete-reminder', async (_event, id) => {
    try {
      run('DELETE FROM reminders WHERE id = ?', [id]);
      return { success: true };
    } catch (err) {
      console.error('[IPC] delete-reminder error:', err);
      return { error: err.message };
    }
  });

  // Emails
  ipcMain.handle('get-emails', async () => {
    try {
      // Get blocked senders list
      const blocked = all('SELECT email FROM blocked_senders').map(r => r.email);
      const now = nowUnix();

      const emails = all(
        `SELECT * FROM email_cache
         WHERE (snoozed_until IS NULL OR snoozed_until <= ?)
           AND (auto_archived IS NULL OR auto_archived = 0)
         ORDER BY received_at DESC LIMIT 50`,
        [now]
      ).filter(row => !blocked.includes(row.from_email))
       .map(row => {
        if (typeof row.reminder_opportunity === 'string') {
          try { row.reminder_opportunity = JSON.parse(row.reminder_opportunity); } catch (_) { row.reminder_opportunity = null; }
        }
        if (typeof row.smart_action === 'string') {
          try { row.smart_action = JSON.parse(row.smart_action); } catch (_) { row.smart_action = null; }
        }
        return row;
      });

      // Count snoozed and auto-archived for badges
      const snoozedCount = get('SELECT COUNT(*) as c FROM email_cache WHERE snoozed_until > ?', [now])?.c || 0;
      const archivedCount = get('SELECT COUNT(*) as c FROM email_cache WHERE auto_archived = 1')?.c || 0;
      const followUpCount = get('SELECT COUNT(*) as c FROM email_cache WHERE follow_up_at IS NOT NULL AND follow_up_at <= ?', [now])?.c || 0;

      console.log(`[IPC] get-emails: returning ${emails.length} (${snoozedCount} snoozed, ${archivedCount} archived, ${followUpCount} follow-ups)`);
      return {
        emails,
        noiseCount: archivedCount,
        snoozedCount,
        followUpCount,
        cached: true,
        lastUpdated: nowUnix()
      };
    } catch (err) {
      console.error('[IPC] get-emails error:', err);
      return { emails: [], noiseCount: 0, error: err.message };
    }
  });

  ipcMain.handle('refresh-emails', async () => {
    try {
      console.log('[IPC] Refreshing emails...');
      let result;
      if (gmailService && gmailService.isGmailConfigured()) {
        console.log('[IPC] Using Gmail REST API');
        result = await gmailService.fetchEmails();
        // Fire-and-forget: categorize in background (non-blocking)
        if (gmailService.categorizeEmails) {
          gmailService.categorizeEmails(() => {}).then(async () => {
            // Proactive intelligence routing: emails → Tasks / Money
            try { await routeEmailInsights(); } catch (_) {}
            if (mainWindow && !mainWindow.isDestroyed()) {
              mainWindow.webContents.send('emails-updated', { categorized: true, routed: true });
            }
          }).catch(err => console.warn('[BG] categorize error:', err.message));
        }
      } else {
        console.log('[IPC] Gmail not configured — skipping fetch');
        return { emails: [], noiseCount: 0, error: 'Gmail not configured' };
      }
      console.log('[IPC] Refresh complete:', result.emails?.length || 0, 'emails');
      return result || { emails: [], noiseCount: 0, error: 'Unknown error' };
    } catch (err) {
      console.error('[IPC] refresh-emails error:', err.message, err.stack);
      return { emails: [], noiseCount: 0, error: err.message || 'Failed to fetch emails', cached: false };
    }
  });

  ipcMain.handle('mark-email-read', async (_event, messageId) => {
    try {
      if (gmailService && gmailService.isGmailConfigured()) {
        return await gmailService.markRead(messageId);
      }
      return { error: 'Gmail not configured' };
    } catch (err) {
      console.error('[IPC] mark-email-read error:', err);
      return { error: err.message };
    }
  });

  ipcMain.handle('delete-email', async (_event, messageId) => {
    try {
      if (gmailService && gmailService.isGmailConfigured()) {
        return await gmailService.trashEmail(messageId);
      }
      return { error: 'Gmail not configured' };
    } catch (err) {
      console.error('[IPC] delete-email error:', err);
      return { error: err.message };
    }
  });

  // ── Email categorization (non-blocking, Ollama-powered) ──
  ipcMain.handle('categorize-emails', async () => {
    try {
      if (!gmailService?.isGmailConfigured?.()) return { categorized: 0, total: 0 };
      const result = await gmailService.categorizeEmails((progress) => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('emails-updated', { categorized: progress.done });
        }
      });
      // Final notification
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('emails-updated', { categorized: true });
      }
      return result;
    } catch (err) {
      console.error('[IPC] categorize-emails error:', err.message);
      return { error: err.message };
    }
  });

  // ── On-demand AI email summary via Ollama ──
  ipcMain.handle('ai-summarize-email', async (_event, messageId) => {
    try {
      if (!gmailService?.summarizeEmail) return { error: 'Not available' };
      return await gmailService.summarizeEmail(messageId);
    } catch (err) {
      console.error('[IPC] ai-summarize-email error:', err.message);
      return { error: err.message };
    }
  });

  ipcMain.handle('open-in-gmail', async (_event, messageId) => {
    try {
      // Strip angle brackets from Message-ID for URL construction
      const cleanId = (messageId || '').replace(/[<>]/g, '');
      const url = `https://mail.google.com/mail/u/0/#search/rfc822msgid:${encodeURIComponent(cleanId)}`;
      await shell.openExternal(url);
      return { success: true };
    } catch (err) {
      console.error('[IPC] open-in-gmail error:', err);
      return { error: err.message };
    }
  });

  ipcMain.handle('draft-reply', async (_event, messageId, subject, fromEmail) => {
    try {
      // Phase 1: open Gmail compose prefilled with recipient
      const to = encodeURIComponent(fromEmail || '');
      const sub = encodeURIComponent(`Re: ${subject || ''}`);
      const url = `https://mail.google.com/mail/u/0/#compose?to=${to}&su=${sub}`;
      await shell.openExternal(url);
      return { success: true };
    } catch (err) {
      console.error('[IPC] draft-reply error:', err);
      return { error: err.message };
    }
  });

  // Briefing
  ipcMain.handle('get-briefing', async () => {
    try {
      return await briefingService.generateBriefing();
    } catch (err) {
      console.error('[IPC] get-briefing error:', err);
      return { error: err.message };
    }
  });

  // ── Priority Engine: get-user-state ──────────────────────
  // Deterministic scoring of all user signals. Returns ranked
  // priorities that the Today panel consumes as its sole data source.
  // Will be replaced by Python sidecar (P2-3) when ready.
  ipcMain.handle('get-user-state', async () => {
    try {
      const now = nowUnix();
      const today = todayISO();
      const priorities = [];

      // 1. Overdue tasks — base 80, +5/day overdue, cap 99
      const overdue = all(
        `SELECT id, title, due_at, category, priority_score FROM reminders
         WHERE completed = 0 AND archived_at IS NULL AND due_at < ? ORDER BY due_at ASC LIMIT 10`, [now]
      );
      for (const t of overdue) {
        const daysLate = Math.max(1, Math.floor((now - t.due_at) / DAY));
        const score = Math.min(99, 80 + daysLate * 5);
        priorities.push({
          id: `task-${t.id}`, domain: 'task', title: t.title,
          description: `${daysLate} day${daysLate > 1 ? 's' : ''} overdue. Handle now.`,
          score,
          confidence: 'high',
          reasoning: `Overdue by ${daysLate}d. Score: ${score}/99.`,
          action_type: 'complete-reminder', action_params: { id: t.id }
        });
      }

      // 2. Urgent unread emails — base 70, +10 if financial
      const urgentEmails = all(
        `SELECT message_id, subject, from_name, from_email, category, cached_at FROM email_cache
         WHERE category IN ('urgent','action') AND is_read = 0
         ORDER BY cached_at DESC LIMIT 10`
      );
      for (const e of urgentEmails) {
        const isFinancial = /payment|invoice|bill|transaction|subscription|renewal/i.test(e.subject);
        const score = 70 + (isFinancial ? 10 : 0) + (e.category === 'urgent' ? 5 : 0);
        const ageH = Math.round((now - e.cached_at) / 3600);
        priorities.push({
          id: `email-${e.message_id}`, domain: 'email', title: e.subject,
          description: `From ${e.from_name || e.from_email || 'unknown'}. ${isFinancial ? 'Financial.' : ''} Unread ${ageH}h.`,
          score,
          confidence: e.category === 'urgent' ? 'high' : 'medium',
          reasoning: `${e.category} email${isFinancial ? ' + financial keyword' : ''}. Unread ${ageH}h.`,
          action_type: 'open-email', action_params: { id: e.message_id }
        });
      }

      // 3. Subscriptions renewing within 3 days — base 75, +20 if overdue
      const soonSubs = all(
        `SELECT id, name, amount, period, next_renewal FROM subscriptions
         WHERE next_renewal IS NOT NULL AND next_renewal > 0 AND next_renewal <= ? ORDER BY next_renewal ASC LIMIT 5`,
        [now + 3 * DAY]
      );
      for (const s of soonSubs) {
        const isOverdue = s.next_renewal < now;
        const daysUntil = Math.max(0, Math.round((s.next_renewal - now) / DAY));
        const score = 75 + (isOverdue ? 20 : 0);
        priorities.push({
          id: `sub-${s.id}`, domain: 'finance',
          title: `${s.name} — ₹${s.amount} renewal${isOverdue ? ' OVERDUE' : ''}`,
          description: isOverdue
            ? `Payment was due. No confirmation detected.`
            : `Renews in ${daysUntil} day${daysUntil !== 1 ? 's' : ''}. Confirm or cancel.`,
          score,
          confidence: isOverdue ? 'high' : 'medium',
          reasoning: isOverdue ? `Renewal date passed. No payment confirmation email found.` : `Due in ${daysUntil}d. ₹${s.amount}/${s.period}.`,
          action_type: 'view-subscription', action_params: { id: s.id }
        });
      }

      // 4. Calendar events within 2 hours — base 85
      const soonEvents = all(
        `SELECT id, title, start_at, end_at, location FROM calendar_events
         WHERE start_at > ? AND start_at <= ? ORDER BY start_at ASC LIMIT 5`,
        [now, now + 2 * 3600]
      );
      for (const ev of soonEvents) {
        const minsAway = Math.round((ev.start_at - now) / 60);
        const score = 85 + (minsAway < 30 ? 10 : 0);
        priorities.push({
          id: `cal-${ev.id}`, domain: 'calendar',
          title: ev.title,
          description: `Starts in ${minsAway}min.${ev.location ? ' ' + ev.location + '.' : ''} Prepare now.`,
          score,
          confidence: 'high',
          reasoning: `Event in ${minsAway} minutes. ${minsAway < 30 ? 'Imminent.' : ''}`,
          action_type: 'view-event', action_params: { id: ev.id }
        });
      }

      // 5. Unread action emails > 48h old — base 60
      const staleEmails = all(
        `SELECT message_id, subject, from_name, from_email FROM email_cache
         WHERE category = 'action' AND is_read = 0 AND cached_at < ? LIMIT 5`,
        [now - 2 * DAY]
      );
      for (const e of staleEmails) {
        priorities.push({
          id: `stale-${e.message_id}`, domain: 'email',
          title: e.subject,
          description: `From ${e.from_name || e.from_email || 'unknown'}. Sitting unread 48h+. Reply or archive.`,
          score: 60,
          confidence: 'medium',
          reasoning: `Action email unread >48h. Risk of dropping the ball.`,
          action_type: 'open-email', action_params: { id: e.message_id }
        });
      }

      // 6. Spending spike > 30% vs last month
      const thisMonthStart = new Date(); thisMonthStart.setDate(1); thisMonthStart.setHours(0,0,0,0);
      const lastMonthStart = new Date(thisMonthStart); lastMonthStart.setMonth(lastMonthStart.getMonth() - 1);
      const thisMonthTs = Math.floor(thisMonthStart.getTime() / 1000);
      const lastMonthTs = Math.floor(lastMonthStart.getTime() / 1000);
      const thisSpend = get(`SELECT COALESCE(SUM(amount_raw),0) as total FROM spend_log WHERE occurred_at >= ?`, [thisMonthTs]);
      const lastSpend = get(`SELECT COALESCE(SUM(amount_raw),0) as total FROM spend_log WHERE occurred_at >= ? AND occurred_at < ?`,
        [lastMonthTs, thisMonthTs]);
      if (lastSpend?.total > 0 && thisSpend?.total > lastSpend.total * 1.3) {
        const pctUp = Math.round(((thisSpend.total - lastSpend.total) / lastSpend.total) * 100);
        priorities.push({
          id: 'spend-spike', domain: 'finance',
          title: `Spending up ${pctUp}% vs last month`,
          description: `₹${Math.round(thisSpend.total)} spent so far. Review transactions.`,
          score: 55,
          confidence: pctUp > 50 ? 'high' : 'medium',
          reasoning: `₹${Math.round(thisSpend.total)} vs ₹${Math.round(lastSpend.total)} last month. ${pctUp}% increase.`,
          action_type: 'view-spending', action_params: {}
        });
      }

      // Sort by score descending
      priorities.sort((a, b) => b.score - a.score);

      // ── P10: Run Intelligence Layers ──
      // Applies learning multipliers, relationship adjustments,
      // prediction signals, and relationship risk signals.
      runIntelligenceLayers(priorities);

      // Silence threshold: if highest < 40, silence mode
      const silence = priorities.length === 0 || priorities[0].score < 40;

      // Quick stats for bottom strip
      const taskCount = get(`SELECT COUNT(*) as cnt FROM reminders WHERE completed = 0 AND archived_at IS NULL`)?.cnt || 0;
      const emailCount = get(`SELECT COUNT(*) as cnt FROM email_cache WHERE category IN ('urgent','action')`)?.cnt || 0;
      const monthSpend = thisSpend?.total || 0;

      // User name
      const userName = getSetting('user_name') || '';

      // P10-5: Outcome stats for Today panel
      let outcomeStats = null;
      try {
        const report = generateOutcomeReport();
        outcomeStats = {
          hoursSaved: report.timeSaved.totalHours,
          issuesCaught: report.issuesPrevented.total,
          roiMultiple: report.roi.multiple
        };
      } catch (_) {}

      // Data quality indicators (P7-2)
      const emailIndexed   = get(`SELECT COUNT(*) as cnt FROM email_cache`)?.cnt || 0;
      const lastSyncUnix   = getSetting('last_sync_at');
      const lastSyncMs     = lastSyncUnix ? parseInt(lastSyncUnix) * 1000 : null;
      const gmailConnected = !!(getSetting('gmail_access_token') || (() => {
        try { return require('../services/gmail-oauth.js').isOAuth2Configured(); } catch { return false; }
      })());
      const calendarUrl    = getSetting('calendar_url');
      const lastCalSync    = getSetting('last_calendar_sync_at');
      const calendarStale  = calendarUrl && lastCalSync
        ? (Date.now() - parseInt(lastCalSync) * 1000) > 86400000
        : false;
      const txDays         = (() => {
        const row = get(`SELECT COUNT(DISTINCT date(timestamp, 'unixepoch')) as d FROM transactions WHERE timestamp > ?`, [nowUnix() - 30 * 86400]);
        return row?.d || 0;
      })();

      return {
        priorities: priorities.slice(0, 12),
        silence,
        stats: { tasks: taskCount, emails: emailCount, monthSpend: Math.round(monthSpend) },
        userName,
        generatedAt: Date.now(),
        quality: { emailIndexed, lastSyncMs, gmailConnected, calendarStale, txDays },
        outcomeStats
      };
    } catch (err) {
      console.error('[IPC] get-user-state error:', err);
      return { error: err.message, priorities: [], silence: true, stats: {} };
    }
  });

  /* ──────────────────────────────────────────────────────────
     ARIA Brain — Builds a comprehensive personal context from
     ALL user data so the AI always knows everything about the
     user's life. This is the "central brain" that makes ARIA
     feel like a personal secretary who knows everything.
     ────────────────────────────────────────────────────────── */
  async function buildPersonalBrain(message) {
    const sections = [];
    const nowTs = nowUnix();
    const todayStart = Math.floor(new Date().setHours(0, 0, 0, 0) / 1000);
    const today = todayISO();

    try {
      // ── USER PROFILE ──
      const userName = get("SELECT value FROM settings WHERE key = 'user_name'")?.value;
      const monthlyIncome = get("SELECT value FROM settings WHERE key = 'monthly_income'")?.value;
      if (userName || monthlyIncome) {
        sections.push(`USER PROFILE: Name: ${userName || 'Not set'}. Monthly income: ₹${monthlyIncome || 'Not set'}.`);
      }

      // ── AI MEMORIES ──
      const memories = all('SELECT fact FROM ai_memory ORDER BY created_at DESC LIMIT 15');
      if (memories.length > 0) {
        sections.push(`THINGS I REMEMBER ABOUT YOU:\n${memories.map(m => `- ${m.fact}`).join('\n')}`);
      }

      // ── TASKS & REMINDERS (ALL active) ──
      const overdue = all('SELECT title, due_at, category FROM reminders WHERE due_at < ? AND completed = 0 AND archived_at IS NULL ORDER BY due_at ASC LIMIT 10', [nowTs]);
      const upcoming = all('SELECT title, due_at, category FROM reminders WHERE due_at >= ? AND completed = 0 AND archived_at IS NULL ORDER BY due_at ASC LIMIT 10', [nowTs]);
      const completedToday = all('SELECT title FROM reminders WHERE completed_at IS NOT NULL AND completed_at >= ? LIMIT 10', [todayStart]);
      const taskLines = [];
      if (overdue.length) taskLines.push('⚠️ OVERDUE:\n' + overdue.map(t => `- "${t.title}" (was due ${new Date(t.due_at * 1000).toLocaleDateString('en-IN', {day:'numeric',month:'short'})})`).join('\n'));
      if (upcoming.length) taskLines.push('UPCOMING:\n' + upcoming.map(t => `- "${t.title}" due ${new Date(t.due_at * 1000).toLocaleDateString('en-IN', {day:'numeric',month:'short',hour:'2-digit',minute:'2-digit'})}`).join('\n'));
      if (completedToday.length) taskLines.push(`DONE TODAY: ${completedToday.map(t => t.title).join(', ')}`);
      if (taskLines.length) sections.push(`TASKS & REMINDERS:\n${taskLines.join('\n')}`);

      // ── EMAILS (recent 15 with summaries) ──
      const recentEmails = all(
        `SELECT from_name, from_email, subject, body_preview, summary, category, received_at 
         FROM email_cache ORDER BY received_at DESC LIMIT 15`
      );
      if (recentEmails.length > 0) {
        sections.push('RECENT EMAILS (latest 15):\n' + recentEmails.map(e => {
          const date = new Date(e.received_at * 1000).toLocaleDateString('en-IN', {day:'numeric',month:'short'});
          const body = (e.summary || e.body_preview || '').slice(0, 200);
          return `- [${e.category || '?'}] From: ${e.from_name || e.from_email} | "${e.subject}" | ${date} | ${body}`;
        }).join('\n'));
      }

      // ── MONEY: Recent transactions (last 20) ──
      const txns = all(
        `SELECT merchant, amount, currency, category, description, timestamp, tx_type 
         FROM transactions ORDER BY timestamp DESC LIMIT 20`
      );
      if (txns.length > 0) {
        const totalSpent = txns.filter(t => t.tx_type !== 'credit').reduce((s, t) => s + (t.amount || 0), 0);
        sections.push('RECENT TRANSACTIONS (last 20):\n' + txns.map(t => {
          const date = new Date(t.timestamp * 1000).toLocaleDateString('en-IN', {day:'numeric',month:'short'});
          return `- ${t.tx_type === 'credit' ? '↑' : '↓'} ₹${t.amount} ${t.merchant || ''} [${t.category}] ${date}${t.description ? ' — ' + t.description : ''}`;
        }).join('\n') + `\nTotal recent spending: ₹${Math.round(totalSpent)}`);
      }

      // ── SUBSCRIPTIONS (ALL) ──
      const subs = all('SELECT name, amount, period, next_renewal, currency FROM subscriptions ORDER BY next_renewal ASC');
      if (subs.length > 0) {
        const totalMonthly = subs.reduce((s, sub) => {
          const amt = parseFloat(sub.amount) || 0;
          return s + (sub.period === 'yearly' ? amt / 12 : amt);
        }, 0);
        sections.push('SUBSCRIPTIONS & RECURRING PAYMENTS:\n' + subs.map(s => {
          const renewal = s.next_renewal ? new Date(s.next_renewal * 1000).toLocaleDateString('en-IN', {day:'numeric',month:'short'}) : 'unknown';
          const overdue = s.next_renewal && s.next_renewal < nowTs ? ' ⚠️ OVERDUE' : '';
          return `- ${s.name}: ₹${s.amount}/${s.period} (next: ${renewal})${overdue}`;
        }).join('\n') + `\nTotal monthly subscription cost: ~₹${Math.round(totalMonthly)}`);
      }

      // ── CALENDAR (today + upcoming 3 days) ──
      const calEnd = nowTs + 3 * 86400;
      const events = all('SELECT title, start_at, end_at, location FROM calendar_events WHERE start_at >= ? AND start_at <= ? ORDER BY start_at ASC', [todayStart, calEnd]);
      if (events.length > 0) {
        sections.push('CALENDAR (next 3 days):\n' + events.map(e => {
          const dt = new Date(e.start_at * 1000);
          return `- "${e.title}" ${dt.toLocaleDateString('en-IN', {weekday:'short',day:'numeric',month:'short'})} ${dt.toLocaleTimeString('en-US', {hour:'2-digit',minute:'2-digit'})}${e.location ? ' @ ' + e.location : ''}`;
        }).join('\n'));
      }

      // ── HABITS ──
      const habits = all('SELECT id, name, icon FROM habits');
      if (habits.length > 0) {
        const doneToday = all('SELECT habit_id FROM habit_log WHERE date = ? AND done = 1', [today]);
        const doneIds = new Set(doneToday.map(h => h.habit_id));
        sections.push('HABITS:\n' + habits.map(h => `- ${h.icon || '📌'} ${h.name} ${doneIds.has(h.id) ? '✅' : ''}`).join('\n'));
      }

      // ── HEALTH (today + recent) ──
      const healthToday = get('SELECT * FROM health_logs WHERE date = ?', [today]);
      if (healthToday) {
        sections.push(`TODAY'S HEALTH: Water: ${healthToday.water_glasses || 0} glasses, Sleep: ${healthToday.sleep_hours || '?'}h, Workout: ${healthToday.workout_minutes || 0}min${healthToday.mood ? ', Mood: ' + healthToday.mood : ''}`);
      }

      // ── NOTES (recent 5 titles) ──
      const notes = all('SELECT title, tags FROM notes ORDER BY updated_at DESC LIMIT 5');
      if (notes.length > 0) {
        sections.push('RECENT NOTES: ' + notes.map(n => `"${n.title}"`).join(', '));
      }

      // ── TRIPS ──
      const trips = all("SELECT title, destination, start_date, end_date, type, booking_ref FROM trips WHERE start_date >= date('now') ORDER BY start_date ASC LIMIT 5");
      if (trips.length > 0) {
        sections.push('UPCOMING TRIPS:\n' + trips.map(t => 
          `- ${t.destination || t.title} (${t.type}) ${t.start_date}${t.booking_ref ? ' Ref: ' + t.booking_ref : ''}`
        ).join('\n'));
      }

      // ── CONTACTS (recent/important) ──
      const contacts = all('SELECT name, email, company, contact_count FROM contacts ORDER BY contact_count DESC LIMIT 10');
      if (contacts.length > 0) {
        sections.push('TOP CONTACTS: ' + contacts.map(c => `${c.name || c.email}${c.company ? ' (' + c.company + ')' : ''}`).join(', '));
      }

      // ── FOCUS/PRODUCTIVITY ──
      const focusToday = get('SELECT COALESCE(SUM(duration), 0) as mins FROM focus_sessions WHERE date = ?', [today]);
      if (focusToday?.mins > 0) {
        sections.push(`FOCUS TIME TODAY: ${focusToday.mins} minutes`);
      }

      // ── P10-4: ACTIVE CONTEXT THREADS ──
      try {
        const activeContexts = getActiveContexts(5);
        if (activeContexts.length > 0) {
          sections.push('ACTIVE CONTEXT THREADS (what user is working on):\n' + activeContexts.map(ctx => {
            const entities = (ctx.entities || []).map(e => `${e.value} (${e.type})`).join(', ');
            return `- 🧵 "${ctx.topic}" — ${entities || 'no entities'} — ${ctx.link_count} linked items`;
          }).join('\n'));
        }
      } catch (_) {}

      // ── P10-3: RELATIONSHIP INTELLIGENCE ──
      try {
        const importantSenders = all(
          `SELECT name, email, relationship_type, importance_score FROM sender_profiles
           WHERE importance_score >= 70 ORDER BY importance_score DESC LIMIT 5`
        );
        if (importantSenders.length > 0) {
          sections.push('KEY RELATIONSHIPS:\n' + importantSenders.map(s =>
            `- ${s.name} (${s.email}) — ${s.relationship_type}, importance: ${s.importance_score}/100`
          ).join('\n'));
        }
      } catch (_) {}

    } catch (err) {
      console.error('[buildPersonalBrain] error:', err.message);
    }

    // ── KEYWORD-SPECIFIC SEARCH (find exact matches for what user asked) ──
    try {
      const msg = (message || '').toLowerCase();
      const stopWords = new Set(['i','me','my','the','a','an','is','are','was','were','be','do','does',
        'did','will','would','could','should','can','may','have','has','had','it','its',
        'this','that','what','which','who','whom','where','when','how','why','please',
        'pls','tell','show','get','give','find','check','and','or','of','in','on','at',
        'to','for','with','from','about','into','much','many','some','any','all','also',
        'just','only','very','so','too','not','no','if','but','as','let',
        'know','want','need','think','look','see','say','said']);
      const keywords = msg.replace(/[^a-z0-9\s]/g, ' ').split(/\s+/)
        .filter(w => w.length >= 2 && !stopWords.has(w));

      if (keywords.length > 0) {
        const likes = keywords.map(k => `%${k}%`);

        // Deep email search for specific keywords
        const emailOr = [];
        const emailP = [];
        for (const l of likes) {
          emailOr.push('(subject LIKE ? OR body_preview LIKE ? OR from_name LIKE ? OR from_email LIKE ?)');
          emailP.push(l, l, l, l);
        }
        const matchedEmails = all(
          `SELECT from_name, from_email, subject, body_preview, received_at FROM email_cache
           WHERE ${emailOr.join(' OR ')} ORDER BY received_at DESC LIMIT 8`, emailP
        );
        if (matchedEmails.length > 0) {
          sections.push('🔍 SEARCH RESULTS — MATCHING EMAILS:\n' + matchedEmails.map(e => {
            const date = new Date(e.received_at * 1000).toLocaleDateString('en-IN', {day:'numeric',month:'short',year:'numeric'});
            return `- From: ${e.from_name || e.from_email} | "${e.subject}" | ${date}\n  Body: ${(e.body_preview || '').slice(0, 400)}`;
          }).join('\n'));
        }

        // Deep transaction search  
        const txOr = [];
        const txP = [];
        for (const l of likes) {
          txOr.push('(merchant LIKE ? OR description LIKE ? OR category LIKE ?)');
          txP.push(l, l, l);
        }
        const matchedTx = all(
          `SELECT merchant, amount, currency, category, description, timestamp, tx_type FROM transactions
           WHERE ${txOr.join(' OR ')} ORDER BY timestamp DESC LIMIT 8`, txP
        );
        if (matchedTx.length > 0) {
          sections.push('🔍 SEARCH RESULTS — MATCHING TRANSACTIONS:\n' + matchedTx.map(t => {
            const date = new Date(t.timestamp * 1000).toLocaleDateString('en-IN', {day:'numeric',month:'short',year:'numeric'});
            return `- ${t.tx_type === 'credit' ? '+' : '-'}₹${t.amount} | ${t.merchant || 'Unknown'} | ${t.category} | ${date}${t.description ? ' | ' + t.description : ''}`;
          }).join('\n'));
        }

        // Deep subscription search
        const subOr = likes.map(() => 'name LIKE ?');
        const matchedSubs = all(`SELECT name, amount, period, next_renewal FROM subscriptions WHERE ${subOr.join(' OR ')} LIMIT 5`, likes);
        if (matchedSubs.length > 0) {
          sections.push('🔍 SEARCH RESULTS — MATCHING SUBSCRIPTIONS:\n' + matchedSubs.map(s => {
            const renewal = s.next_renewal ? new Date(s.next_renewal * 1000).toLocaleDateString('en-IN', {day:'numeric',month:'short'}) : 'N/A';
            return `- ${s.name}: ₹${s.amount}/${s.period} (next renewal: ${renewal})`;
          }).join('\n'));
        }
      }
    } catch (err) {
      console.error('[smartRetrieve] error:', err.message);
    }

    // ── VECTOR SEARCH: Semantic retrieval from ChromaDB (P9-4) ──
    if (_pythonProc && message) {
      try {
        const { app: electronApp } = require('electron');
        const appData = electronApp.getPath('userData');
        const vectorResults = await callPython('search', {
          db_dir: appData + '/vectors',
          text: message,
          n_results: 5,
        }, 5000);
        if (vectorResults?.results && vectorResults.results.length > 0) {
          sections.push('🧠 SEMANTIC SEARCH (related context from your data):\n' +
            vectorResults.results.map(r => `- [${r.metadata?.doc_type || 'doc'}] ${r.text?.slice(0, 200) || r.document?.slice(0, 200) || '(no text)'}`).join('\n'));
        }
      } catch (_) {
        // ChromaDB not available — skip silently
      }
    }

    if (sections.length === 0) return '';

    return '\n\n📋 YOUR PERSONAL DATA (from local database) 📋\n' +
      sections.join('\n\n') +
      '\n📋 END OF PERSONAL DATA 📋\n' +
      'INSTRUCTIONS: You have ALL the user\'s data above. Answer their question using SPECIFIC details — exact amounts, dates, names, items from the data. ' +
      'Never say "I cannot access" or "please check your bank" — you HAVE the data. If something isn\'t in the data above, say "I don\'t see that in your synced data yet."';
  }

  // Chat (Ask ARIA) — thin wrapper that delegates to chatEnhancedHandler
  ipcMain.handle('chat', async (_event, message) => {
    try {
      return await chatEnhancedHandler(message, 'work');
    } catch (err) {
      console.error('[IPC] chat error:', err);
      return { error: err.message };
    }
  });

  // Settings
  ipcMain.handle('get-settings', async () => {
    try {
      const rows = all('SELECT key, value FROM settings');
      const settings = {};
      for (const row of rows) {
        settings[row.key] = row.value;
      }
      // Merge env vars as overrides (env takes priority for sensitive keys)
      const envMap = {
        gmail_client_id: 'GMAIL_CLIENT_ID',
        gmail_client_secret: 'GMAIL_CLIENT_SECRET',
        imap_host: 'IMAP_HOST',
        imap_port: 'IMAP_PORT',
        imap_user: 'IMAP_USER',
        imap_password: 'IMAP_PASSWORD',
        imap_tls: 'IMAP_TLS',
        twilio_sid: 'TWILIO_SID',
        twilio_auth_token: 'TWILIO_AUTH_TOKEN',
        twilio_whatsapp_from: 'TWILIO_WHATSAPP_FROM',
        whatsapp_phone: 'WHATSAPP_PHONE',
        weather_city: 'WEATHER_CITY',
        weather_latitude: 'WEATHER_LATITUDE',
        weather_longitude: 'WEATHER_LONGITUDE',
        calendar_ical_url: 'CALENDAR_ICAL_URL',
        user_name: 'USER_NAME',
        monthly_income: 'MONTHLY_INCOME',
        briefing_time: 'BRIEFING_TIME',
      };
      for (const [settingKey, envKey] of Object.entries(envMap)) {
        if (process.env[envKey]) settings[settingKey] = process.env[envKey];
      }
      return settings;
    } catch (err) {
      console.error('[IPC] get-settings error:', err);
      return {};
    }
  });

  ipcMain.handle('save-setting', async (_event, key, value) => {
    try {
      saveSetting(key, value);
      return { success: true };
    } catch (err) {
      console.error('[IPC] save-setting error:', err);
      return { error: err.message };
    }
  });

  ipcMain.handle('get-setting', async (_event, key) => {
    try { return getSetting(key) || null; }
    catch (err) { return null; }
  });

  ipcMain.handle('complete-setup', async () => {
    try {
      saveSetting('has_completed_setup', '1');
      console.log('[ARIA] Setup complete — triggering full intelligence pipeline...');

      // Fire-and-forget: run the full intelligence pipeline after onboarding
      (async () => {
        try {
          // 1. Route email insights → extract tasks/transactions/subscriptions
          await routeEmailInsights();
          console.log('[Setup] Email insights routed');

          // 2. Financial extraction
          if (financialIntel) {
            try { financialIntel.persistTransactions({ all, run }, 90); } catch (_) {}
            try { financialIntel.persistSubscriptions({ all, run, get }); } catch (_) {}
            console.log('[Setup] Financial data extracted');
          }

          // 3. Index ALL data into ChromaDB (emails, transactions, notes, calendar, subscriptions)
          if (_pythonProc && intelligenceService) {
            try {
              const { app: electronApp } = require('electron');
              const appData = electronApp.getPath('userData');
              const allDocs = intelligenceService.getAllIndexableData();
              console.log(`[Setup] Indexing ${allDocs.length} documents into vector store...`);

              // Batch index for efficiency
              const batchResult = await callPython('batch_index', {
                db_dir: appData + '/vectors',
                documents: allDocs,
              }, 60000); // 60s timeout for bulk indexing

              console.log(`[Setup] Indexed ${batchResult?.indexed || 0} documents into vector store`);
            } catch (err) {
              console.warn('[Setup] Vector indexing error (non-fatal):', err.message);
              // Fallback: try individual indexing if batch fails
              try {
                const { app: electronApp } = require('electron');
                const appData = electronApp.getPath('userData');
                const emails = all(`SELECT message_id, subject, body_preview FROM email_cache ORDER BY received_at DESC LIMIT 200`);
                let indexed = 0;
                for (const e of emails) {
                  const text = `${e.subject || ''} ${(e.body_preview || '').slice(0, 300)}`.trim();
                  if (!text) continue;
                  try {
                    await callPython('index', {
                      db_dir: appData + '/vectors',
                      doc_type: 'email',
                      doc_id: `email-${e.message_id}`,
                      text,
                    }, 5000);
                    indexed++;
                  } catch (_) {}
                }
                console.log(`[Setup] Fallback: indexed ${indexed} emails`);
              } catch (_) {}
            }
          }

          // 4. Index reminders/notes for semantic search
          if (_pythonProc) {
            try {
              const { app: electronApp } = require('electron');
              const appData = electronApp.getPath('userData');
              const reminders = all(`SELECT id, title, subtitle FROM reminders WHERE completed = 0 LIMIT 50`);
              for (const r of reminders) {
                const text = `${r.title} ${r.subtitle || ''}`.trim();
                if (text) {
                  await callPython('index', {
                    db_dir: appData + '/vectors',
                    doc_type: 'reminder',
                    doc_id: `reminder-${r.id}`,
                    text,
                  }, 3000).catch(() => {});
                }
              }
              const notes = all(`SELECT id, title, content FROM notes LIMIT 50`);
              for (const n of notes) {
                const text = `${n.title} ${(n.content || '').slice(0, 300)}`.trim();
                if (text) {
                  await callPython('index', {
                    db_dir: appData + '/vectors',
                    doc_type: 'note',
                    doc_id: `note-${n.id}`,
                    text,
                  }, 3000).catch(() => {});
                }
              }
            } catch (_) {}
          }

          // 5. Link calendar events to tasks  
          try { calendarIntelService.linkCalendarToTasks(); } catch (_) {}

          // 5b. Build BM25 index for hybrid search (keyword + semantic)
          if (_pythonProc && intelligenceService) {
            try {
              const allDocs = intelligenceService.getAllIndexableData();
              const bm25Result = await callPython('build_bm25', { documents: allDocs }, 30000);
              console.log(`[Setup] BM25 index built: ${bm25Result?.indexed || 0} documents`);
            } catch (err) {
              console.warn('[Setup] BM25 index build error (non-fatal):', err.message);
            }
          }

          // 6. Compute behavior metrics (rolling averages, anomaly baselines)
          try {
            if (intelligenceService) {
              const metricsResult = intelligenceService.computeBehaviorMetrics();
              console.log(`[Setup] Behavior metrics: ${metricsResult.computed} records for ${metricsResult.categories || 0} categories`);
            }
          } catch (err) {
            console.warn('[Setup] Behavior metrics error (non-fatal):', err.message);
          }

          console.log('[Setup] Full intelligence pipeline complete');
        } catch (err) {
          console.warn('[Setup] Pipeline error (non-fatal):', err.message);
        }
      })();

      return { success: true };
    } catch (err) { return { error: err.message }; }
  });

  // Weather
  ipcMain.handle('get-weather', async () => {
    try {
      return await weatherService.getWeather();
    } catch (err) {
      console.error('[IPC] get-weather error:', err);
      return { error: err.message };
    }
  });

  // Calendar
  ipcMain.handle('get-calendar-events', async () => {
    try {
      return await calendarService.getEvents();
    } catch (err) {
      console.error('[IPC] get-calendar-events error:', err);
      return [];
    }
  });

  // AI Usage
  ipcMain.handle('get-usage', async () => {
    try {
      const haikuCount = getHaikuUsageToday();
      return { haiku: haikuCount, limit: 20 };
    } catch (err) {
      console.error('[IPC] get-usage error:', err);
      return { haiku: 0, limit: 20 };
    }
  });

  // ── Subscriptions / recurring payments ──────────────────────────────
  ipcMain.handle('get-subscriptions', async () => {
    try {
      // Backfill — scan email_cache for subscription opportunities
      if (financialIntel) {
        financialIntel.persistSubscriptions({ all, run, get });
      }

      const rows = all(
        `SELECT * FROM subscriptions ORDER BY
           CASE WHEN next_renewal IS NULL THEN 1 ELSE 0 END,
           next_renewal ASC, created_at DESC`
      );
      return rows;
    } catch (err) {
      console.error('[IPC] get-subscriptions error:', err);
      return [];
    }
  });

  ipcMain.handle('add-subscription', async (_event, sub) => {
    try {
      const { name, amount, currency = 'INR', period = 'monthly', notes = null, next_renewal = null } = sub;
      const now = nowUnix();
      const res = run(
        `INSERT INTO subscriptions (name, amount, currency, period, next_renewal, notes, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [name, amount || null, currency, period, next_renewal || null, notes, now, now]
      );
      return { success: true, id: res.lastInsertRowid };
    } catch (err) {
      console.error('[IPC] add-subscription error:', err);
      return { error: err.message };
    }
  });

  ipcMain.handle('update-subscription', async (_event, id, updates) => {
    try {
      const now = nowUnix();
      const fields = Object.keys(updates).map(k => `${k} = ?`).join(', ');
      const values = [...Object.values(updates), now, id];
      run(`UPDATE subscriptions SET ${fields}, updated_at = ? WHERE id = ?`, values);
      return { success: true };
    } catch (err) {
      console.error('[IPC] update-subscription error:', err);
      return { error: err.message };
    }
  });

  ipcMain.handle('delete-subscription', async (_event, id) => {
    try {
      run('DELETE FROM subscriptions WHERE id = ?', [id]);
      return { success: true };
    } catch (err) {
      console.error('[IPC] delete-subscription error:', err);
      return { error: err.message };
    }
  });

  // ── Scan financial emails → populate transactions table ─────────────
  ipcMain.handle('scan-financial-emails', async () => {
    try {
      if (!financialIntel) return { scanned: 0, inserted: 0 };
      return financialIntel.persistTransactions({ all, run }, 90);
    } catch (err) {
      console.error('[IPC] scan-financial-emails error:', err);
      return { scanned: 0, inserted: 0, error: err.message };
    }
  });

  // ── Financial Summary + Exposure Forecast ───────────────────────────
  ipcMain.handle('get-financial-summary', async () => {
    try {
      const subs = all('SELECT * FROM subscriptions ORDER BY next_renewal ASC');
      const now = nowUnix();
      const DAY  = 86400;

      const parseAmount = (str) => {
        if (!str && str !== 0) return 0;
        if (typeof str === 'number') return str;
        const cleaned = String(str).replace(/[₹$,\s]/g, '');
        return parseFloat(cleaned) || 0;
      };

      let monthlyTotal = 0;
      let yearlyTotal  = 0;
      const upcomingRenewals = [];
      const next30Renewals   = [];

      for (const s of subs) {
        const amt = parseAmount(s.amount);
        if (s.period === 'monthly')  { monthlyTotal += amt; yearlyTotal += amt * 12; }
        else if (s.period === 'yearly')  { yearlyTotal += amt; monthlyTotal += amt / 12; }

        if (s.next_renewal && s.next_renewal > now) {
          const daysLeft = Math.ceil((s.next_renewal - now) / DAY);
          const entry    = { name: s.name, amount: s.amount, daysLeft, id: s.id };
          if (daysLeft <= 7)  upcomingRenewals.push(entry);
          if (daysLeft <= 30) next30Renewals.push(entry);
        }
      }

      // Finance tasks
      const financeTasks = all(
        `SELECT COUNT(*) as cnt FROM reminders
         WHERE completed = 0 AND archived_at IS NULL
           AND (source = 'subscription' OR category = 'subscription')`
      );

      // Recent transactions this week (from both tables, deduped)
      const weekStart    = now - 7 * DAY;
      const recentTx     = all(
        `SELECT category, amount, timestamp FROM transactions WHERE timestamp > ?`,
        [weekStart]
      );
      // Also fold in spend_log entries not already in transactions
      const recentSpend  = all(
        `SELECT category, amount_raw AS amount, occurred_at AS timestamp
         FROM spend_log
         WHERE occurred_at > ? AND source = 'manual'`,
        [weekStart]
      );
      const allRecentTx  = [...recentTx, ...recentSpend];

      // Use financialIntel for exposure forecast if available
      let exposure = null;
      if (financialIntel) {
        exposure = financialIntel.computeExposure(subs, allRecentTx, next30Renewals);
      } else {
        const weeklyVar = allRecentTx.reduce((s, t) => s + (t.amount || 0), 0);
        exposure = {
          monthly_commitment:         Math.round(monthlyTotal),
          next_30day_exposure:        next30Renewals.reduce((s, r) => s + parseAmount(r.amount), 0),
          weekly_variable_spend:      Math.round(weeklyVar),
          weekly_subscription_burden: Math.round(monthlyTotal / 4.33),
          projected_7d:               Math.round(weeklyVar + monthlyTotal / 4.33),
          top_spend_category:         null,
          renewal_count_30d:          next30Renewals.length,
        };
      }

      // Recent transactions enriched with merchant info for UI
      const recentTransactions = all(
        `SELECT merchant, category, amount, description, timestamp, tx_type, payment_link
         FROM transactions
         WHERE timestamp > ?
         ORDER BY timestamp DESC
         LIMIT 50`,
        [now - 30 * DAY]
      );

      // ── CA/CRED data: credits vs debits this month ──
      const monthStart = now - 30 * DAY;
      const monthDebits = all(
        `SELECT COALESCE(SUM(amount),0) as total FROM transactions WHERE timestamp > ? AND (tx_type = 'debit' OR tx_type IS NULL)`,
        [monthStart]
      );
      const monthCredits = all(
        `SELECT COALESCE(SUM(amount),0) as total FROM transactions WHERE timestamp > ? AND tx_type = 'credit'`,
        [monthStart]
      );

      // Category breakdown this month
      const categoryBreakdown = all(
        `SELECT category, COALESCE(SUM(amount),0) as total, COUNT(*) as count
         FROM transactions
         WHERE timestamp > ? AND (tx_type = 'debit' OR tx_type IS NULL)
         GROUP BY category
         ORDER BY total DESC`,
        [monthStart]
      );

      // Upcoming due items (subscriptions + insurance in next 30 days)
      const upcomingDue = subs
        .filter(s => s.next_renewal && s.next_renewal > now && s.next_renewal <= now + 30 * DAY)
        .map(s => ({
          ...s,
          daysLeft: Math.ceil((s.next_renewal - now) / DAY),
        }))
        .sort((a, b) => a.daysLeft - b.daysLeft);

      return {
        subscriptionCount:  subs.length,
        monthlyTotal:       Math.round(monthlyTotal),
        yearlyTotal:        Math.round(yearlyTotal),
        upcomingRenewals,
        next30Renewals,
        financeTaskCount:   financeTasks[0]?.cnt || 0,
        subscriptions:      subs,
        exposure,
        recentTransactions,
        // CA/CRED additions
        monthDebits:        Math.round(monthDebits[0]?.total || 0),
        monthCredits:       Math.round(monthCredits[0]?.total || 0),
        categoryBreakdown,
        upcomingDue,
      };
    } catch (err) {
      console.error('[IPC] get-financial-summary error:', err);
      return {
        subscriptionCount: 0, monthlyTotal: 0, yearlyTotal: 0,
        upcomingRenewals: [], next30Renewals: [], financeTaskCount: 0,
        subscriptions: [], exposure: null, recentTransactions: [],
      };
    }
  });

  // ── Spending Behavior Analysis (transactions + spend_log) ────────────
  ipcMain.handle('get-spending-insight', async () => {
    try {
      const now = nowUnix();
      const DAY  = 86400;
      const WEEK = 7 * DAY;

      // Auto-scan financial emails (idempotent — INSERT OR IGNORE)
      if (financialIntel) {
        financialIntel.persistTransactions({ all, run }, 28);
      }

      // Pull last 28 days from both tables, merge
      const txRows = all(
        `SELECT category, amount, timestamp, source_email_id FROM transactions WHERE timestamp > ?`,
        [now - 28 * DAY]
      );
      const spendRows = all(
        `SELECT category, amount_raw AS amount, occurred_at AS timestamp, source, source_ref
         FROM spend_log WHERE occurred_at > ?`,
        [now - 28 * DAY]
      );
      // Deduplicate: spend_log 'email' source overlaps with transactions; use tx as authority
      const seenEmailIds = new Set(txRows.map(t => t.source_email_id).filter(Boolean));
      const spendOnly = spendRows.filter(s => s.source === 'manual' || !seenEmailIds.has(s.source_ref));
      const allRows = [...txRows, ...spendOnly];

      // Run behavioral analysis
      let metrics = [];
      if (financialIntel && allRows.length > 0) {
        metrics = financialIntel.computeBehaviorMetrics(allRows, now);

        // Persist to behavior_metrics table (upsert)
        const weekStart = now - (now % WEEK); // approx week bucket
        for (const m of metrics) {
          try {
            run(
              `INSERT INTO behavior_metrics
                 (category, period_start, weekly_spend, rolling_4week_avg, deviation_percent, order_count, most_common_hour, pattern_note)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?)
               ON CONFLICT(category, period_start) DO UPDATE SET
                 weekly_spend      = excluded.weekly_spend,
                 rolling_4week_avg = excluded.rolling_4week_avg,
                 deviation_percent = excluded.deviation_percent,
                 order_count       = excluded.order_count,
                 most_common_hour  = excluded.most_common_hour,
                 pattern_note      = excluded.pattern_note,
                 computed_at       = strftime('%s','now')`,
              [m.category, weekStart, m.weekly_spend, m.baseline_avg,
               m.deviation_percent, m.order_count, m.most_common_hour, m.pattern_note]
            );
          } catch (_) {}
        }
      }

      // Aggregate current-week totals for insight building
      const currentWeekRows = allRows.filter(r => r.timestamp >= now - WEEK);
      const catTotals       = {};
      for (const r of currentWeekRows) {
        catTotals[r.category] = (catTotals[r.category] || 0) + (r.amount || 0);
      }

      const weekTotal    = currentWeekRows.reduce((s, r) => s + (r.amount || 0), 0);
      const allWeekRows  = [0,1,2,3].map(w => allRows.filter(r =>
        r.timestamp >= now - (w + 1) * WEEK && r.timestamp < now - w * WEEK
      ));
      const histTotals   = allWeekRows.slice(1).filter(w => w.length > 0).map(w => w.reduce((s, r) => s + r.amount, 0));
      const avgWeekTotal = histTotals.length > 0 ? histTotals.reduce((s, v) => s + v, 0) / histTotals.length : 0;

      const topFlagged = metrics.filter(m => m.flagged).sort((a, b) => Math.abs(b.deviation_percent || 0) - Math.abs(a.deviation_percent || 0))[0] || null;

      // Behavioral pattern flags
      const lateNight = currentWeekRows.filter(r => {
        const h = new Date(r.timestamp * 1000).getHours();
        return h >= 23 || h < 4;
      });
      const dayCounts   = Array(7).fill(0);
      for (const r of currentWeekRows) dayCounts[new Date(r.timestamp * 1000).getDay()]++;
      const peakDayIdx  = dayCounts.indexOf(Math.max(...dayCounts));
      const peakDayName = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][peakDayIdx];
      const peakDayCount = dayCounts[peakDayIdx];

      const recentEvents = all(
        `SELECT end_at FROM calendar_events WHERE end_at > ? AND end_at < ?`,
        [now - WEEK, now]
      );
      const postMeeting = currentWeekRows.filter(r =>
        recentEvents.some(ev => { const g = r.timestamp - ev.end_at; return g >= 0 && g <= 7200; })
      );

      const fmt = n => `₹${Math.round(n).toLocaleString('en-IN')}`;
      const pct = r => `${Math.round((r - 1) * 100)}%`;

      let insight        = null;
      let recommendation = null;
      let pattern        = null;

      if (currentWeekRows.length > 0) {
        if (topFlagged && topFlagged.deviation_percent !== null) {
          const cat  = topFlagged.category;
          const catL = cat.charAt(0).toUpperCase() + cat.slice(1);
          const dir  = topFlagged.deviation_percent > 0 ? 'above' : 'below';
          const abs  = Math.abs(topFlagged.deviation_percent);
          insight = topFlagged.baseline_avg > 0
            ? `${catL} spend is ${fmt(topFlagged.weekly_spend)} this week — ${abs}% ${dir} your ${fmt(topFlagged.baseline_avg)} average.`
            : `${catL} spend reached ${fmt(topFlagged.weekly_spend)} this week — first week on record.`;
        } else if (avgWeekTotal > 0) {
          const ratio = weekTotal / avgWeekTotal;
          insight = ratio < 0.8
            ? `Total spend of ${fmt(weekTotal)} this week is ${Math.round((1 - ratio) * 100)}% below your usual ${fmt(avgWeekTotal)} average.`
            : `Spend of ${fmt(weekTotal)} this week is within normal range of your ${fmt(avgWeekTotal)} weekly average.`;
        } else {
          insight = `${fmt(weekTotal)} recorded this week across ${currentWeekRows.length} transaction${currentWeekRows.length !== 1 ? 's' : ''}. Building baseline.`;
        }

        if (lateNight.length >= 2) {
          recommendation = `${lateNight.length} transactions logged after 11pm this week.`;
          pattern = 'late_night';
        } else if (postMeeting.length >= 2) {
          recommendation = `${postMeeting.length} purchases placed within 2 hours of meetings.`;
          pattern = 'post_meeting';
        } else if (peakDayCount >= 3 && currentWeekRows.length >= 4) {
          recommendation = `${peakDayCount} transactions clustered on ${peakDayName}.`;
          pattern = 'day_cluster';
        }
      }

      // AI language refinement
      if (insight && aiService) {
        const catBreakdown = Object.entries(catTotals)
          .sort((a, b) => b[1] - a[1])
          .map(([cat, amt]) => `${cat}: ${fmt(amt)}`)
          .join(', ');

        const aiPrompt =
          `You are ARIA, a behavioral awareness assistant.\n` +
          `User spending data this week:\n` +
          `  Total: ${fmt(weekTotal)} (avg ${avgWeekTotal > 0 ? fmt(avgWeekTotal) : 'no baseline'})\n` +
          `  Categories: ${catBreakdown || 'none'}\n` +
          `  Orders: ${currentWeekRows.length}\n` +
          (lateNight.length > 0 ? `  Late-night transactions: ${lateNight.length}\n` : '') +
          (topFlagged ? `  Top deviation: ${topFlagged.category} ${topFlagged.deviation_percent ?? 0 > 0 ? '+' : ''}${topFlagged.deviation_percent ?? 0}%\n` : '') +
          `\nReturn ONLY valid JSON (no markdown, no code block):\n` +
          `{\n  "insight": "One factual sentence with numbers.",\n  "recommendation": "One observational sentence — or null"\n}\n` +
          `Rules: No shame. No labels like overspending/bad/problem/concerning. Analytical tone only. Under 2 sentences total.`;

        try {
          const resp  = await aiService.aiCall('analyse', aiPrompt, {});
          const text  = typeof resp === 'string' ? resp : '';
          const match = text.match(/\{[\s\S]*\}/);
          if (match) {
            const parsed = JSON.parse(match[0]);
            if (typeof parsed.insight === 'string' && parsed.insight.trim().length > 10) insight = parsed.insight.trim();
            if (typeof parsed.recommendation === 'string' && parsed.recommendation.trim().length > 10) recommendation = parsed.recommendation.trim();
            else if (parsed.recommendation === null) recommendation = null;
          }
        } catch (_) {}
      }

      return {
        insight,
        recommendation,
        pattern,
        hasAnomaly:        !!topFlagged,
        weekTotal:         Math.round(weekTotal),
        avgWeekTotal:      Math.round(avgWeekTotal),
        orderCount:        currentWeekRows.length,
        topCategory:       topFlagged?.category || null,
        topDeviation:      topFlagged?.deviation_percent ?? null,
        lateNightCount:    lateNight.length,
        postMeetingCount:  postMeeting.length,
        categoryBreakdown: catTotals,
        metrics,
      };
    } catch (err) {
      console.error('[IPC] get-spending-insight error:', err);
      return { insight: null, recommendation: null, hasAnomaly: false, metrics: [] };
    }
  });

  // ── Per-category behavior report ──────────────────────────────────────
  ipcMain.handle('get-behavior-report', async () => {
    try {
      const now = nowUnix();
      const rows = all(
        `SELECT * FROM behavior_metrics
         WHERE period_start > ?
         ORDER BY weekly_spend DESC`,
        [now - 7 * 86400 - 86400] // current week bucket ± 1 day tolerance
      );
      return { metrics: rows };
    } catch (err) {
      console.error('[IPC] get-behavior-report error:', err);
      return { metrics: [] };
    }
  });

  ipcMain.handle('record-spend', async (_event, { category, amount_raw, description, occurred_at }) => {
    try {
      const spendResult = run(
        `INSERT INTO spend_log (category, amount_raw, description, source, occurred_at) VALUES (?, ?, ?, 'manual', ?)`,
        [category || 'other', amount_raw || 0, description || '', occurred_at || nowUnix()]
      );
      // Phase B: live re-index spend entry
      if (_pythonProc) {
        const { app: _eApp } = require('electron');
        const _vDir = _eApp.getPath('userData') + '/vectors';
        const _text = `${category || 'other'} ${description || ''} ${amount_raw || 0}`.trim();
        if (_text) callPython('index', { db_dir: _vDir, doc_type: 'transaction', doc_id: `spend-${spendResult.lastInsertRowid}`, text: _text }).catch(() => {});
      }
      return { success: true };
    } catch (err) {
      console.error('[IPC] record-spend error:', err);
      return { error: err.message };
    }
  });

  // ────────────────────────────────────────────────────────────────────

  // API Key management via keytar
  ipcMain.handle('save-api-key', async (_event, key) => {
    try {
      const keytar = require('keytar');
      await keytar.setPassword('aria-bot', 'gemini-api-key', key);
    } catch (err) {
      // Fallback: save in settings DB (less secure, but works if keytar fails)
      console.warn('[IPC] keytar failed, saving API key in settings DB:', err.message);
      saveSetting('gemini_api_key_fallback', key);
    }
    // Always reset the Gemini client so it picks up the new key immediately
    try { require('../services/haiku.js').resetClient(); } catch (_) {}
    return { success: true };
  });

  ipcMain.handle('save-grok-api-key', async (_event, key) => {
    try {
      const keytar = require('keytar');
      await keytar.setPassword('aria-bot', 'grok-api-key', key);
    } catch (err) {
      // Fallback: save in settings DB (less secure, but works if keytar fails)
      console.warn('[IPC] keytar failed, saving Grok API key in settings DB:', err.message);
      saveSetting('grok_api_key_fallback', key);
    }
    // Always reset the Grok client so it picks up the new key immediately
    try { require('../services/grok.js').resetClient(); } catch (_) {}
    return { success: true };
  });

  ipcMain.handle('get-api-key', async () => {
    // Priority: .env → keytar → settings DB
    if (process.env.GEMINI_API_KEY) return { key: process.env.GEMINI_API_KEY, secure: true, source: 'env' };
    try {
      const keytar = require('keytar');
      const key = await keytar.getPassword('aria-bot', 'gemini-api-key');
      if (key) return { key, secure: true };
      const fallback = getSetting('gemini_api_key_fallback');
      return fallback ? { key: fallback, secure: false } : { key: null };
    } catch (err) {
      const fallback = getSetting('gemini_api_key_fallback');
      return fallback ? { key: fallback, secure: false } : { key: null };
    }
  });

  ipcMain.handle('get-grok-api-key', async () => {
    // Priority: .env → keytar → settings DB
    if (process.env.GROK_API_KEY) return { key: process.env.GROK_API_KEY, secure: true, source: 'env' };
    try {
      const keytar = require('keytar');
      const key = await keytar.getPassword('aria-bot', 'grok-api-key');
      if (key) return { key, secure: true };
      const fallback = getSetting('grok_api_key_fallback');
      return fallback ? { key: fallback, secure: false } : { key: null };
    } catch (err) {
      const fallback = getSetting('grok_api_key_fallback');
      return fallback ? { key: fallback, secure: false } : { key: null };
    }
  });

  // Window controls
  ipcMain.on('window-close', () => {
    mainWindow?.hide();
  });

  ipcMain.on('window-minimize', () => {
    mainWindow?.minimize();
  });

  ipcMain.on('window-toggle', () => {
    toggleWindow();
  });

  // ── Chat History ──
  ipcMain.handle('get-chat-history', async () => {
    try {
      return all('SELECT * FROM chat_messages ORDER BY created_at ASC LIMIT 100');
    } catch (err) {
      console.error('[IPC] get-chat-history error:', err);
      return [];
    }
  });

  ipcMain.handle('save-chat-message', async (_event, role, text) => {
    try {
      const ts = nowUnix();
      const result = run(
        'INSERT INTO chat_messages (role, text, created_at) VALUES (?, ?, ?)',
        [role, text, ts]
      );
      return { id: result.lastInsertRowid, success: true };
    } catch (err) {
      console.error('[IPC] save-chat-message error:', err);
      return { error: err.message };
    }
  });

  ipcMain.handle('clear-chat-history', async () => {
    try {
      run('DELETE FROM chat_messages');
      return { success: true };
    } catch (err) {
      console.error('[IPC] clear-chat-history error:', err);
      return { error: err.message };
    }
  });

  // ── Notes ──
  ipcMain.handle('get-notes', async () => {
    try {
      return all('SELECT * FROM notes ORDER BY updated_at DESC, created_at DESC LIMIT 200');
    } catch (err) {
      console.error('[IPC] get-notes error:', err);
      return [];
    }
  });

  ipcMain.handle('add-note', async (_event, title, content, tags) => {
    try {
      const now = nowUnix();
      const result = run(
        'INSERT INTO notes (title, content, tags, updated_at) VALUES (?, ?, ?, ?)',
        [title || 'Untitled', content, tags ? JSON.stringify(tags) : null, now]
      );
      // Phase B: live re-index
      if (_pythonProc) {
        const { app: _eApp } = require('electron');
        const _vDir = _eApp.getPath('userData') + '/vectors';
        const _text = `${title || 'Untitled'} ${content || ''}`.trim();
        if (_text) callPython('index', { db_dir: _vDir, doc_type: 'note', doc_id: `note-${result.lastInsertRowid}`, text: _text }).catch(() => {});
      }
      return { id: result.lastInsertRowid, success: true };
    } catch (err) {
      console.error('[IPC] add-note error:', err);
      return { error: err.message };
    }
  });

  ipcMain.handle('update-note', async (_event, id, title, content, tags) => {
    try {
      const now = nowUnix();
      run('UPDATE notes SET title = ?, content = ?, tags = ?, updated_at = ? WHERE id = ?',
        [title, content, tags ? JSON.stringify(tags) : null, now, id]);
      // Phase B: live re-index (upsert overwrites old chunks)
      if (_pythonProc) {
        const { app: _eApp } = require('electron');
        const _vDir = _eApp.getPath('userData') + '/vectors';
        const _text = `${title || ''} ${content || ''}`.trim();
        if (_text) callPython('index', { db_dir: _vDir, doc_type: 'note', doc_id: `note-${id}`, text: _text }).catch(() => {});
      }
      return { success: true };
    } catch (err) {
      console.error('[IPC] update-note error:', err);
      return { error: err.message };
    }
  });

  ipcMain.handle('delete-note', async (_event, id) => {
    try {
      run('DELETE FROM notes WHERE id = ?', [id]);
      return { success: true };
    } catch (err) {
      console.error('[IPC] delete-note error:', err);
      return { error: err.message };
    }
  });

  // Export note as file and optionally open in external editor
  ipcMain.handle('export-note', async (_event, id) => {
    try {
      const note = get('SELECT * FROM notes WHERE id = ?', [id]);
      if (!note) return { error: 'Note not found' };
      const fs = require('fs');
      const notesDir = path.join(app.getPath('userData'), 'notes');
      if (!fs.existsSync(notesDir)) fs.mkdirSync(notesDir, { recursive: true });
      const safeName = (note.title || 'Untitled').replace(/[<>:"/\\|?*]/g, '_');
      const filePath = path.join(notesDir, `${safeName}.txt`);
      fs.writeFileSync(filePath, note.content || '', 'utf-8');
      return { success: true, filePath };
    } catch (err) {
      console.error('[IPC] export-note error:', err);
      return { error: err.message };
    }
  });

  ipcMain.handle('open-note-external', async (_event, id) => {
    try {
      const note = get('SELECT * FROM notes WHERE id = ?', [id]);
      if (!note) return { error: 'Note not found' };
      const fs = require('fs');
      const notesDir = path.join(app.getPath('userData'), 'notes');
      if (!fs.existsSync(notesDir)) fs.mkdirSync(notesDir, { recursive: true });
      const safeName = (note.title || 'Untitled').replace(/[<>:"/\\|?*]/g, '_');
      const filePath = path.join(notesDir, `${safeName}.txt`);
      fs.writeFileSync(filePath, note.content || '', 'utf-8');
      shell.openPath(filePath);
      return { success: true, filePath };
    } catch (err) {
      console.error('[IPC] open-note-external error:', err);
      return { error: err.message };
    }
  });

  ipcMain.handle('get-notes-dir', async () => {
    const notesDir = path.join(app.getPath('userData'), 'notes');
    return notesDir;
  });

  // ── Streak Tracking ──
  ipcMain.handle('get-streak', async () => {
    try {
      const today = todayISO();
      // Record today's login
      run('INSERT OR IGNORE INTO streaks (date) VALUES (?)', [today]);
      // Count consecutive days backwards from today
      const rows = all('SELECT date FROM streaks ORDER BY date DESC LIMIT 365');
      let streak = 0;
      let checkDate = new Date();
      for (const row of rows) {
        const expected = checkDate.toISOString().split('T')[0];
        if (row.date === expected) {
          streak++;
          checkDate.setDate(checkDate.getDate() - 1);
        } else {
          break;
        }
      }
      return { streak: Math.max(streak, 1) };
    } catch (err) {
      console.error('[IPC] get-streak error:', err);
      return { streak: 1 };
    }
  });

  // ── Reminder editing ──
  ipcMain.handle('update-reminder', async (_event, id, title, dueAt) => {
    try {
      if (title && dueAt) {
        run('UPDATE reminders SET title = ?, due_at = ? WHERE id = ?', [title, dueAt, id]);
      } else if (title) {
        run('UPDATE reminders SET title = ? WHERE id = ?', [title, id]);
      } else if (dueAt) {
        run('UPDATE reminders SET due_at = ? WHERE id = ?', [dueAt, id]);
      }
      // Reschedule
      const reminder = get('SELECT * FROM reminders WHERE id = ?', [id]);
      if (reminder) {
        try { remindService.scheduleReminder(reminder); } catch (_) {}
      }
      return { success: true };
    } catch (err) {
      console.error('[IPC] update-reminder error:', err);
      return { error: err.message };
    }
  });

  // ── Draft reply with AI ──
  ipcMain.handle('ai-draft-reply', async (_event, subject, fromEmail, bodyPreview) => {
    try {
      const prompt = `Draft a brief, professional email reply (3-5 sentences) to this email.
Be concise and helpful. Just the reply body, no subject line or greeting headers.

From: ${fromEmail}
Subject: ${subject}
Body: ${(bodyPreview || '').substring(0, 500)}`;
      const draft = await aiService.aiCall('chat', prompt, {});
      return { draft: typeof draft === 'string' ? draft : draft?.text || 'Could not generate draft.' };
    } catch (err) {
      console.error('[IPC] ai-draft-reply error:', err);
      return { error: err.message };
    }
  });

  // ── Focus window (from notification click) ──
  ipcMain.handle('focus-window', async (_event, panel) => {
    if (mainWindow) {
      mainWindow.show();
      mainWindow.focus();
      if (panel) {
        mainWindow.webContents.send('navigate-to', panel);
      }
    }
    return { success: true };
  });

  // ── Sidecar control ──
  ipcMain.handle('restart-sidecar', async () => {
    try {
      _sidecarRetryCount = 0; // reset backoff so restart is immediate
      if (_pythonProc) { stopPythonSidecar(); }
      startPythonSidecar();
      return { success: true };
    } catch (err) {
      return { error: err.message };
    }
  });

  // ── Ollama status check ──
  ipcMain.handle('check-ollama', async () => {
    try {
      const http = require('http');
      return new Promise((resolve) => {
        const req = http.get('http://127.0.0.1:11434/api/tags', { timeout: 3000 }, (res) => {
          let data = '';
          res.on('data', c => data += c);
          res.on('end', () => {
            try {
              const json = JSON.parse(data);
              resolve({ online: true, models: json.models?.map(m => m.name) || [] });
            } catch { resolve({ online: true, models: [] }); }
          });
        });
        req.on('error', () => resolve({ online: false }));
        req.on('timeout', () => { req.destroy(); resolve({ online: false }); });
      });
    } catch { return { online: false }; }
  });

  // ── Gmail OAuth2 ──

  // New BrowserWindow-based OAuth flow (replaces shell.openExternal + local HTTP server)
  ipcMain.handle('connect-gmail', async () => {
    try {
      const { googleOAuth, exchangeCodeForTokens } = require('./auth.js');
      const clientId     = getSetting('gmail_client_id');
      const clientSecret = getSetting('gmail_client_secret');
      if (!clientId || !clientSecret) {
        return { error: 'Enter your Gmail Client ID and Client Secret in Settings first.' };
      }

      console.log('[Gmail] Opening OAuth consent window...');
      const code = await googleOAuth(clientId, clientSecret);
      console.log('[Gmail] Auth code received, exchanging for tokens...');

      const tokens = await exchangeCodeForTokens(code, clientId, clientSecret);
      if (tokens.error) {
        return { error: `Token exchange failed: ${tokens.error_description || tokens.error}` };
      }

      const expiresAt = nowUnix() + (tokens.expires_in || 3600);
      run("INSERT OR REPLACE INTO settings(key,value) VALUES('gmail_access_token',?)",  [tokens.access_token]);
      run("INSERT OR REPLACE INTO settings(key,value) VALUES('gmail_token_expires',?)", [String(expiresAt)]);

      if (tokens.refresh_token) {
        // Store refresh token in OS credential store (keytar) — not in plaintext DB
        try {
          const keytar = require('keytar');
          await keytar.setPassword('aria-bot', 'gmail-refresh-token', tokens.refresh_token);
          // Remove any legacy plaintext token from DB
          run("DELETE FROM settings WHERE key = 'gmail_refresh_token'");
        } catch (_kt) {
          // keytar unavailable — fall back to DB (better than nothing)
          run("INSERT OR REPLACE INTO settings(key,value) VALUES('gmail_refresh_token',?)", [tokens.refresh_token]);
          console.warn('[Security] keytar unavailable — refresh token stored in DB (fallback)');
        }
        // Inject into gmail-oauth module for current session
        try { require('../services/gmail-oauth.js').injectRefreshToken(tokens.refresh_token); } catch (_) {}
      }

      console.log('[Gmail] OAuth complete — tokens saved');
      return { success: true };
    } catch (err) {
      console.error('[IPC] connect-gmail error:', err.message);
      return { error: err.message };
    }
  });

  ipcMain.handle('gmail-oauth-status', async () => {
    try {
      const gmailOAuth = require('../services/gmail-oauth.js');
      return { configured: gmailOAuth.isOAuth2Configured() };
    } catch (err) { return { configured: false, error: err.message }; }
  });

  // gmail-oauth-start — REMOVED (consolidated into connect-gmail)
  // Kept as no-op for backward compat with any preload bridge references
  ipcMain.handle('gmail-oauth-start', async () => {
    return { error: 'Deprecated — use connect-gmail instead.' };
  });

  ipcMain.handle('gmail-oauth-disconnect', async () => {
    try {
      const gmailOAuth = require('../services/gmail-oauth.js');
      gmailOAuth.clearOAuth2();
      return { success: true };
    } catch (err) { return { error: err.message }; }
  });

  // ── Habits ──────────────────────────────────────────────────────────
  ipcMain.handle('get-habits', async () => {
    try {
      return habitsService.getHabits();
    } catch (err) {
      console.error('[IPC] get-habits error:', err);
      return [];
    }
  });

  ipcMain.handle('create-habit', async (_event, name, icon) => {
    try {
      return habitsService.createHabit(name, icon);
    } catch (err) {
      console.error('[IPC] create-habit error:', err);
      return { error: err.message };
    }
  });

  ipcMain.handle('toggle-habit', async (_event, habitId) => {
    try {
      const done = habitsService.toggleHabit(habitId);
      return { success: true, done };
    } catch (err) {
      console.error('[IPC] toggle-habit error:', err);
      return { error: err.message };
    }
  });

  ipcMain.handle('delete-habit', async (_event, id) => {
    try {
      habitsService.deleteHabit(id);
      return { success: true };
    } catch (err) {
      console.error('[IPC] delete-habit error:', err);
      return { error: err.message };
    }
  });

  ipcMain.handle('get-habit-history', async (_event, habitId, days) => {
    try {
      return habitsService.getHabitHistory(habitId, days);
    } catch (err) {
      console.error('[IPC] get-habit-history error:', err);
      return [];
    }
  });

  ipcMain.handle('get-weekly-summary', async () => {
    try {
      return habitsService.getWeeklySummary();
    } catch (err) {
      console.error('[IPC] get-weekly-summary error:', err);
      return [];
    }
  });

  // ── Focus Timer ────────────────────────────────────────────────────
  ipcMain.handle('start-focus', async (_event, minutes) => {
    try {
      return focusService.startSession(minutes);
    } catch (err) {
      console.error('[IPC] start-focus error:', err);
      return { error: err.message };
    }
  });

  ipcMain.handle('end-focus', async () => {
    try {
      return focusService.endSession();
    } catch (err) {
      console.error('[IPC] end-focus error:', err);
      return { error: err.message };
    }
  });

  ipcMain.handle('get-focus-status', async () => {
    try {
      return focusService.getStatus();
    } catch (err) {
      console.error('[IPC] get-focus-status error:', err);
      return { active: false };
    }
  });

  ipcMain.handle('get-focus-stats', async () => {
    try {
      return focusService.getStats();
    } catch (err) {
      console.error('[IPC] get-focus-stats error:', err);
      return { todayMinutes: 0, todaySessions: 0, weekTotalMinutes: 0, weekSessions: 0, days: [] };
    }
  });

  // ── Weekly Report ──────────────────────────────────────────────────
  ipcMain.handle('get-weekly-report', async () => {
    try {
      return await weeklyReportService.generateWeeklyReport();
    } catch (err) {
      console.error('[IPC] get-weekly-report error:', err);
      return { error: err.message };
    }
  });

  // ── Natural Language Query ─────────────────────────────────────────
  ipcMain.handle('nl-query', async (_event, query) => {
    try {
      return nlQueryService.processQuery(query);
    } catch (err) {
      console.error('[IPC] nl-query error:', err);
      return { answer: null, error: err.message };
    }
  });

  // ── Focus & Habit Analytics ────────────────────────────────────────
  ipcMain.handle('get-focus-analytics', async (_event, days) => {
    try {
      return analyticsService.getFocusAnalytics(days || 30);
    } catch (err) {
      console.error('[IPC] get-focus-analytics error:', err);
      return { daily: [], stats: {}, byDayOfWeek: [] };
    }
  });

  ipcMain.handle('get-habit-analytics', async (_event, days) => {
    try {
      return analyticsService.getHabitAnalytics(days || 30);
    } catch (err) {
      console.error('[IPC] get-habit-analytics error:', err);
      return { habits: [], overallRate: 0, totalHabits: 0 };
    }
  });

  ipcMain.handle('get-productivity-correlation', async (_event, days) => {
    try {
      return analyticsService.getProductivityCorrelation(days || 14);
    } catch (err) {
      console.error('[IPC] get-productivity-correlation error:', err);
      return [];
    }
  });

  // ── Calendar Intelligence ──────────────────────────────────────────
  ipcMain.handle('get-calendar-intelligence', async () => {
    try {
      return calendarIntelService.getCalendarIntelligence();
    } catch (err) {
      console.error('[IPC] get-calendar-intelligence error:', err);
      return { events: [], gaps: [], suggestions: [], totalMeetings: 0 };
    }
  });

  ipcMain.handle('link-calendar-tasks', async () => {
    try {
      return calendarIntelService.linkCalendarToTasks();
    } catch (err) {
      console.error('[IPC] link-calendar-tasks error:', err);
      return { linked: 0 };
    }
  });

  // 🔥
  // Mega Feature Consolidation — 30+ features from Superhuman, SaneBox,
  // Boomerang, Todoist, Reclaim AI, YNAB, TextExpander, Notion AI, Grammarly
  // 🔥

  // ── Email Snooze (Superhuman) ──────────────────────────────────────
  ipcMain.handle('snooze-email', async (_event, messageId, untilTs) => {
    try {
      run('UPDATE email_cache SET snoozed_until = ? WHERE message_id = ?', [untilTs, messageId]);
      return { success: true };
    } catch (err) {
      console.error('[IPC] snooze-email error:', err);
      return { error: err.message };
    }
  });

  ipcMain.handle('unsnooze-email', async (_event, messageId) => {
    try {
      run('UPDATE email_cache SET snoozed_until = NULL WHERE message_id = ?', [messageId]);
      return { success: true };
    } catch (err) {
      console.error('[IPC] unsnooze-email error:', err);
      return { error: err.message };
    }
  });

  // ── Follow-Up Reminder (Boomerang) ────────────────────────────────
  ipcMain.handle('follow-up-email', async (_event, messageId, hours) => {
    try {
      const followUpAt = nowUnix() + (hours * 3600);
      run('UPDATE email_cache SET follow_up_at = ? WHERE message_id = ?', [followUpAt, messageId]);
      return { success: true, follow_up_at: followUpAt };
    } catch (err) {
      console.error('[IPC] follow-up-email error:', err);
      return { error: err.message };
    }
  });

  ipcMain.handle('dismiss-follow-up', async (_event, messageId) => {
    try {
      run('UPDATE email_cache SET follow_up_at = NULL WHERE message_id = ?', [messageId]);
      return { success: true };
    } catch (err) {
      console.error('[IPC] dismiss-follow-up error:', err);
      return { error: err.message };
    }
  });

  ipcMain.handle('get-follow-ups', async () => {
    try {
      const now = nowUnix();
      return all(
        `SELECT * FROM email_cache WHERE follow_up_at IS NOT NULL AND follow_up_at <= ? ORDER BY follow_up_at ASC`,
        [now]
      ).map(row => {
        if (typeof row.smart_action === 'string') {
          try { row.smart_action = JSON.parse(row.smart_action); } catch (_) { row.smart_action = null; }
        }
        return row;
      });
    } catch (err) {
      console.error('[IPC] get-follow-ups error:', err);
      return [];
    }
  });

  // ── Block Sender (SaneBox) ────────────────────────────────────────
  ipcMain.handle('block-sender', async (_event, email) => {
    try {
      run('INSERT OR IGNORE INTO blocked_senders (email) VALUES (?)', [email]);
      // Also auto-archive all existing emails from that sender
      run('UPDATE email_cache SET auto_archived = 1 WHERE from_email = ?', [email]);
      return { success: true };
    } catch (err) {
      console.error('[IPC] block-sender error:', err);
      return { error: err.message };
    }
  });

  ipcMain.handle('unblock-sender', async (_event, email) => {
    try {
      run('DELETE FROM blocked_senders WHERE email = ?', [email]);
      return { success: true };
    } catch (err) {
      console.error('[IPC] unblock-sender error:', err);
      return { error: err.message };
    }
  });

  ipcMain.handle('auto-archive-email', async (_event, messageId) => {
    try {
      run('UPDATE email_cache SET auto_archived = 1 WHERE message_id = ?', [messageId]);
      return { success: true };
    } catch (err) {
      console.error('[IPC] auto-archive-email error:', err);
      return { error: err.message };
    }
  });

  // ── Reply Templates (TextExpander) ────────────────────────────────
  ipcMain.handle('get-reply-templates', async () => {
    try {
      return all('SELECT * FROM reply_templates ORDER BY shortcut ASC');
    } catch (err) {
      console.error('[IPC] get-reply-templates error:', err);
      return [];
    }
  });

  ipcMain.handle('add-reply-template', async (_event, shortcut, title, body) => {
    try {
      run('INSERT INTO reply_templates (shortcut, title, body) VALUES (?, ?, ?)', [shortcut, title, body]);
      return { success: true };
    } catch (err) {
      console.error('[IPC] add-reply-template error:', err);
      return { error: err.message };
    }
  });

  ipcMain.handle('delete-reply-template', async (_event, id) => {
    try {
      run('DELETE FROM reply_templates WHERE id = ?', [id]);
      return { success: true };
    } catch (err) {
      console.error('[IPC] delete-reply-template error:', err);
      return { error: err.message };
    }
  });

  // ── Tone Adjustment (Grammarly) ───────────────────────────────────
  ipcMain.handle('adjust-tone', async (_event, text, tone) => {
    try {
      const tonePrompts = {
        professional: 'Rewrite this email reply to sound more professional, formal, and business-appropriate. Keep it concise. Only return the rewritten text, no explanation.',
        friendly: 'Rewrite this email reply to sound warmer, friendlier, and more personable while staying professional. Keep it concise. Only return the rewritten text, no explanation.',
        concise: 'Rewrite this email reply to be extremely concise and to-the-point. Cut all fluff. Only return the rewritten text, no explanation.',
        assertive: 'Rewrite this email reply to sound more confident and assertive while remaining respectful. Only return the rewritten text, no explanation.',
      };
      const prompt = tonePrompts[tone] || tonePrompts.professional;
      const ollamaModule = require('../services/ollama');
      const result = await ollamaModule.call('llama3.2:3b', [
        { role: 'system', content: prompt },
        { role: 'user', content: text }
      ], { temperature: 0.4 });
      return { text: result?.trim() || text, tone };
    } catch (err) {
      console.error('[IPC] adjust-tone error:', err);
      return { text, tone, error: err.message };
    }
  });

  // ── Sub-tasks (Todoist) ───────────────────────────────────────────
  ipcMain.handle('add-sub-task', async (_event, parentId, text) => {
    try {
      const parent = get('SELECT * FROM reminders WHERE id = ?', [parentId]);
      if (!parent) return { error: 'Parent task not found' };
      const now = nowUnix();
      const result = run(
        `INSERT INTO reminders (title, due_at, category, source, parent_id, priority_score)
         VALUES (?, ?, ?, 'manual', ?, 0)`,
        [text, parent.due_at, parent.category || 'task', parentId]
      );
      return { success: true, id: result.lastInsertRowid };
    } catch (err) {
      console.error('[IPC] add-sub-task error:', err);
      return { error: err.message };
    }
  });

  ipcMain.handle('get-sub-tasks', async (_event, parentId) => {
    try {
      return all(
        'SELECT * FROM reminders WHERE parent_id = ? ORDER BY completed ASC, due_at ASC',
        [parentId]
      );
    } catch (err) {
      console.error('[IPC] get-sub-tasks error:', err);
      return [];
    }
  });

  ipcMain.handle('toggle-sub-task', async (_event, id) => {
    try {
      const task = get('SELECT * FROM reminders WHERE id = ?', [id]);
      if (!task) return { error: 'Not found' };
      const now = nowUnix();
      if (task.completed) {
        run('UPDATE reminders SET completed = 0, completed_at = NULL WHERE id = ?', [id]);
      } else {
        run('UPDATE reminders SET completed = 1, completed_at = ? WHERE id = ?', [now, id]);
      }
      return { success: true, completed: !task.completed };
    } catch (err) {
      console.error('[IPC] toggle-sub-task error:', err);
      return { error: err.message };
    }
  });

  // ── Notes Intelligence (Notion AI) ────────────────────────────────
  ipcMain.handle('summarize-note', async (_event, noteId) => {
    try {
      const note = get('SELECT * FROM notes WHERE id = ?', [noteId]);
      if (!note) return { error: 'Note not found' };
      const ollamaModule = require('../services/ollama');
      const result = await ollamaModule.call('llama3.2:3b', [
        { role: 'system', content: 'Summarize the following note into 3-5 bullet points. Be concise. Return only the bullet points, no preamble.' },
        { role: 'user', content: `Title: ${note.title || 'Untitled'}\n\n${note.content}` }
      ], { temperature: 0.3 });
      return { summary: result?.trim() || 'Could not summarize.' };
    } catch (err) {
      console.error('[IPC] summarize-note error:', err);
      return { error: err.message };
    }
  });

  ipcMain.handle('extract-action-items', async (_event, noteId) => {
    try {
      const note = get('SELECT * FROM notes WHERE id = ?', [noteId]);
      if (!note) return { error: 'Note not found' };
      const ollamaModule = require('../services/ollama');
      const result = await ollamaModule.call('llama3.2:3b', [
        { role: 'system', content: 'Extract all action items and tasks from this note. Return each as a short, actionable line starting with "- ". If no action items found, say "No action items found." Return only the list, no extra text.' },
        { role: 'user', content: `Title: ${note.title || 'Untitled'}\n\n${note.content}` }
      ], { temperature: 0.2 });
      // Parse the lines into an array
      const items = (result || '').split('\n')
        .map(l => l.replace(/^[-*•]\s*/, '').trim())
        .filter(l => l.length > 0 && !l.toLowerCase().includes('no action items'));
      return { items, raw: result?.trim() };
    } catch (err) {
      console.error('[IPC] extract-action-items error:', err);
      return { error: err.message };
    }
  });

  // ── Note Templates ────────────────────────────────────────────────
  ipcMain.handle('get-note-templates', async () => {
    try {
      return all('SELECT * FROM note_templates ORDER BY name ASC');
    } catch (err) {
      console.error('[IPC] get-note-templates error:', err);
      return [];
    }
  });

  ipcMain.handle('add-note-template', async (_event, name, content) => {
    try {
      run('INSERT INTO note_templates (name, content) VALUES (?, ?)', [name, content]);
      return { success: true };
    } catch (err) {
      console.error('[IPC] add-note-template error:', err);
      return { error: err.message };
    }
  });

  ipcMain.handle('delete-note-template', async (_event, id) => {
    try {
      run('DELETE FROM note_templates WHERE id = ?', [id]);
      return { success: true };
    } catch (err) {
      console.error('[IPC] delete-note-template error:', err);
      return { error: err.message };
    }
  });

  // ── Money Intelligence (YNAB) ─────────────────────────────────────
  ipcMain.handle('get-month-comparison', async () => {
    try {
      const now = new Date();
      const thisMonthStart = Math.floor(new Date(now.getFullYear(), now.getMonth(), 1).getTime() / 1000);
      const lastMonthStart = Math.floor(new Date(now.getFullYear(), now.getMonth() - 1, 1).getTime() / 1000);

      const thisMonth = all(
        'SELECT category, SUM(amount) as total, COUNT(*) as count FROM transactions WHERE timestamp >= ? AND tx_type = ? GROUP BY category',
        [thisMonthStart, 'debit']
      );
      const lastMonth = all(
        'SELECT category, SUM(amount) as total, COUNT(*) as count FROM transactions WHERE timestamp >= ? AND timestamp < ? AND tx_type = ? GROUP BY category',
        [lastMonthStart, thisMonthStart, 'debit']
      );

      const thisTotal = thisMonth.reduce((s, r) => s + r.total, 0);
      const lastTotal = lastMonth.reduce((s, r) => s + r.total, 0);
      const pctChange = lastTotal > 0 ? Math.round(((thisTotal - lastTotal) / lastTotal) * 100) : 0;

      // Per-category comparison
      const catMap = {};
      lastMonth.forEach(r => { catMap[r.category] = { last: r.total, lastCount: r.count, current: 0, currentCount: 0 }; });
      thisMonth.forEach(r => {
        if (!catMap[r.category]) catMap[r.category] = { last: 0, lastCount: 0, current: 0, currentCount: 0 };
        catMap[r.category].current = r.total;
        catMap[r.category].currentCount = r.count;
      });

      const categories = Object.entries(catMap)
        .map(([cat, data]) => ({
          category: cat,
          ...data,
          change: data.last > 0 ? Math.round(((data.current - data.last) / data.last) * 100) : (data.current > 0 ? 100 : 0),
        }))
        .sort((a, b) => Math.abs(b.change) - Math.abs(a.change));

      // Biggest increase alert
      const spikes = categories.filter(c => c.change > 20 && c.current > 500);

      return {
        thisMonth: thisTotal,
        lastMonth: lastTotal,
        pctChange,
        categories,
        spikes,
        monthLabel: now.toLocaleDateString('en-IN', { month: 'long', year: 'numeric' }),
      };
    } catch (err) {
      console.error('[IPC] get-month-comparison error:', err);
      return { thisMonth: 0, lastMonth: 0, pctChange: 0, categories: [], spikes: [] };
    }
  });

  ipcMain.handle('get-unused-subscriptions', async () => {
    try {
      const subs = all('SELECT * FROM subscriptions ORDER BY name ASC');
      const now = nowUnix();
      const sixtyDaysAgo = now - (60 * 86400);

      const unused = subs.map(sub => {
        // Check if any transaction matches this subscription merchant in last 60 days
        const recentTx = get(
          `SELECT COUNT(*) as count FROM transactions
           WHERE merchant LIKE ? AND timestamp > ?`,
          [`%${sub.name}%`, sixtyDaysAgo]
        );
        const recentEmail = get(
          `SELECT COUNT(*) as count FROM email_cache
           WHERE (from_name LIKE ? OR subject LIKE ?) AND received_at > ?`,
          [`%${sub.name}%`, `%${sub.name}%`, sixtyDaysAgo]
        );
        const isUsed = (recentTx?.count || 0) > 0 || (recentEmail?.count || 0) > 1;
        return { ...sub, isUsed, daysSinceActivity: isUsed ? 0 : 60 };
      }).filter(s => !s.isUsed);

      const potentialSavings = unused.reduce((sum, s) => {
        const amt = parseFloat(String(s.amount).replace(/[₹$,\s]/g, '')) || 0;
        return sum + amt;
      }, 0);

      return { unused, potentialSavings };
    } catch (err) {
      console.error('[IPC] get-unused-subscriptions error:', err);
      return { unused: [], potentialSavings: 0 };
    }
  });

  // 🔥
  // Phase 2: Full SaaS Consolidation — Notes + Money + Chat + Today + Mail
  // 🔥

  // ── Notes: Continue Writing (Notion AI) ──
  ipcMain.handle('continue-writing', async (_event, text) => {
    try {
      const ollama = require('../services/ollama');
      const result = await ollama.call('llama3.2:3b', [
        { role: 'system', content: 'You are a writing assistant. Continue the user\'s text naturally. Write 2-3 sentences that flow from the existing content. Match the tone and style. Do not repeat what was already written. Just output the continuation text, nothing else.' },
        { role: 'user', content: text }
      ], { temperature: 0.7 });
      return { continuation: result?.trim() || '' };
    } catch (err) {
      console.error('[IPC] continue-writing error:', err);
      return { continuation: '' };
    }
  });

  // ── Notes: Tone Changer for note content ──
  ipcMain.handle('adjust-note-tone', async (_event, text, tone) => {
    try {
      const ollama = require('../services/ollama');
      const tonePrompts = {
        professional: 'Rewrite this text in a professional, formal tone suitable for business communication.',
        casual: 'Rewrite this text in a casual, friendly, conversational tone.',
        concise: 'Rewrite this text to be as concise as possible while keeping all key information.',
        academic: 'Rewrite this text in an academic, scholarly tone with precise language.',
      };
      const result = await ollama.call('llama3.2:3b', [
        { role: 'system', content: (tonePrompts[tone] || tonePrompts.professional) + ' Output only the rewritten text.' },
        { role: 'user', content: text }
      ], { temperature: 0.4 });
      return { result: result?.trim() || text };
    } catch (err) {
      console.error('[IPC] adjust-note-tone error:', err);
      return { result: text };
    }
  });

  // ── Notes: Get Related Notes (Obsidian-style) ──
  ipcMain.handle('get-related-notes', async (_event, noteId) => {
    try {
      const note = get('SELECT * FROM notes WHERE id = ?', [noteId]);
      if (!note) return { related: [] };

      // Extract keywords from title and content
      const text = `${note.title || ''} ${note.content || ''}`.toLowerCase();
      const stopWords = new Set(['the','a','an','is','are','was','were','be','been','being','have','has','had','do','does','did','will','would','could','should','may','might','shall','can','with','this','that','these','those','and','but','or','nor','for','yet','so','in','on','at','to','from','by','of','it','its','i','me','my','we','our','you','your','he','him','his','she','her','they','them','their','not','no']);
      const words = text.match(/[a-z]{3,}/g)?.filter(w => !stopWords.has(w)) || [];
      const uniqueWords = [...new Set(words)].slice(0, 10);

      if (uniqueWords.length === 0) return { related: [] };

      // Find notes with overlapping keywords
      const allNotes = all('SELECT id, title, content, tags FROM notes WHERE id != ?', [noteId]);
      const scored = allNotes.map(n => {
        const nText = `${n.title || ''} ${n.content || ''}`.toLowerCase();
        const matches = uniqueWords.filter(w => nText.includes(w)).length;

        // Also check tag overlap
        let tagBonus = 0;
        try {
          const noteTags = JSON.parse(note.tags || '[]');
          const nTags = JSON.parse(n.tags || '[]');
          tagBonus = noteTags.filter(t => nTags.includes(t)).length * 2;
        } catch (_) {}

        return { ...n, score: matches + tagBonus };
      }).filter(n => n.score > 1).sort((a, b) => b.score - a.score).slice(0, 5);

      return { related: scored.map(n => ({ id: n.id, title: n.title, score: n.score })) };
    } catch (err) {
      console.error('[IPC] get-related-notes error:', err);
      return { related: [] };
    }
  });

  // ── Notes: Daily Note (Obsidian-style) ──
  ipcMain.handle('get-daily-note', async () => {
    try {
      const today = todayISO();
      let dailyNote = get('SELECT * FROM notes WHERE is_daily = 1 AND daily_date = ?', [today]);
      if (!dailyNote) {
        // Auto-create today's daily note
        const dayLabel = new Date().toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
        const content = `# Daily Note — ${dayLabel}\n\n## What I accomplished today\n- \n\n## Key thoughts\n- \n\n## Tomorrow's priorities\n- `;
        const nowTs = nowUnix();
        const result = run(
          'INSERT INTO notes (title, content, tags, is_daily, daily_date, updated_at) VALUES (?, ?, ?, 1, ?, ?)',
          [`Daily: ${today}`, content, '["daily"]', today, nowTs]
        );
        dailyNote = get('SELECT * FROM notes WHERE id = ?', [result.lastInsertRowid]);
      }
      return dailyNote;
    } catch (err) {
      console.error('[IPC] get-daily-note error:', err);
      return null;
    }
  });

  // ── Money: Spendable Balance (PocketGuard "In My Pocket") ──
  ipcMain.handle('get-spendable-balance', async () => {
    try {
      const income = parseFloat(getSetting('monthly_income') || '0');
      const subs = all('SELECT amount FROM subscriptions');
      const committed = subs.reduce((sum, s) => {
        return sum + (parseFloat(String(s.amount).replace(/[₹$,\s]/g, '')) || 0);
      }, 0);

      // Get this month's spend so far
      const now = new Date();
      const monthStart = Math.floor(new Date(now.getFullYear(), now.getMonth(), 1).getTime() / 1000);
      const spent = get(
        `SELECT COALESCE(SUM(amount), 0) as total FROM transactions WHERE timestamp >= ? AND tx_type = 'debit'`,
        [monthStart]
      );

      const totalSpent = spent?.total || 0;
      const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
      const daysPassed = now.getDate();
      const daysLeft = daysInMonth - daysPassed;

      const spendable = income - committed - totalSpent;
      const dailyBudget = daysLeft > 0 ? spendable / daysLeft : 0;

      return {
        income,
        committed,
        totalSpent,
        spendable: Math.max(0, spendable),
        dailyBudget: Math.max(0, dailyBudget),
        daysLeft,
        isConfigured: income > 0
      };
    } catch (err) {
      console.error('[IPC] get-spendable-balance error:', err);
      return { income: 0, committed: 0, totalSpent: 0, spendable: 0, dailyBudget: 0, daysLeft: 0, isConfigured: false };
    }
  });

  // ── Money: Category Limits / Budget Caps ──
  ipcMain.handle('get-category-limits', async () => {
    try {
      const limits = all('SELECT * FROM budget_limits ORDER BY category ASC');
      const now = new Date();
      const monthStart = Math.floor(new Date(now.getFullYear(), now.getMonth(), 1).getTime() / 1000);
      const spending = all(
        `SELECT category, SUM(amount) as total FROM transactions WHERE timestamp >= ? AND tx_type = 'debit' GROUP BY category`,
        [monthStart]
      );
      const spendMap = {};
      spending.forEach(s => { spendMap[s.category] = s.total; });

      return limits.map(l => ({
        ...l,
        spent: spendMap[l.category] || 0,
        remaining: Math.max(0, l.monthly_limit - (spendMap[l.category] || 0)),
        exceeded: (spendMap[l.category] || 0) > l.monthly_limit
      }));
    } catch (err) {
      console.error('[IPC] get-category-limits error:', err);
      return [];
    }
  });

  ipcMain.handle('set-category-limit', async (_event, category, limit) => {
    try {
      run(
        'INSERT INTO budget_limits (category, monthly_limit) VALUES (?, ?) ON CONFLICT(category) DO UPDATE SET monthly_limit = excluded.monthly_limit',
        [category, limit]
      );
      return { success: true };
    } catch (err) {
      console.error('[IPC] set-category-limit error:', err);
      return { success: false };
    }
  });

  ipcMain.handle('delete-category-limit', async (_event, category) => {
    try {
      run('DELETE FROM budget_limits WHERE category = ?', [category]);
      return { success: true };
    } catch (err) {
      return { success: false };
    }
  });

  // ── AI Chat: Memory (ChatGPT-style persistent facts) ──
  ipcMain.handle('save-memory', async (_event, fact) => {
    try {
      run('INSERT INTO ai_memory (fact, source) VALUES (?, ?)', [fact, 'chat']);
      return { success: true };
    } catch (err) {
      console.error('[IPC] save-memory error:', err);
      return { success: false };
    }
  });

  ipcMain.handle('get-memories', async () => {
    try {
      return all('SELECT * FROM ai_memory ORDER BY created_at DESC');
    } catch (err) {
      console.error('[IPC] get-memories error:', err);
      return [];
    }
  });

  ipcMain.handle('delete-memory', async (_event, id) => {
    try {
      run('DELETE FROM ai_memory WHERE id = ?', [id]);
      return { success: true };
    } catch (err) {
      return { success: false };
    }
  });

  // ── AI Chat: Proactive Suggestions Engine ──
  ipcMain.handle('get-proactive-suggestions', async () => {
    try {
      const nowTs = nowUnix();
      const suggestions = [];

      // 1. Overdue tasks
      const overdue = all(
        'SELECT title FROM reminders WHERE due_at < ? AND completed = 0 AND archived_at IS NULL AND parent_id IS NULL ORDER BY priority_score DESC LIMIT 3',
        [nowTs]
      );
      if (overdue.length > 0) {
        suggestions.push({ type: 'task', icon: '✅', text: `You have ${overdue.length} overdue task${overdue.length > 1 ? 's' : ''} — shall I prioritize them?`, action: 'remind' });
      }

      // 2. Urgent emails needing reply
      const urgentEmails = all(
        "SELECT from_name, subject FROM email_cache WHERE category = 'urgent' AND follow_up_at IS NULL ORDER BY received_at DESC LIMIT 2"
      );
      if (urgentEmails.length > 0) {
        const first = urgentEmails[0];
        suggestions.push({ type: 'email', icon: '📬', text: `${first.from_name || 'Someone'} sent "${first.subject}" — want me to draft a reply?`, action: 'mail' });
      }

      // 3. Bills due within 3 days
      const threeDaysFromNow = nowTs + (3 * 86400);
      const dueBills = all(
        'SELECT name, amount, next_renewal FROM subscriptions WHERE next_renewal > ? AND next_renewal <= ? LIMIT 2',
        [nowTs, threeDaysFromNow]
      );
      if (dueBills.length > 0) {
        const bill = dueBills[0];
        const amt = bill.amount ? ` (₹${String(bill.amount).replace(/[₹,]/g, '')})` : '';
        suggestions.push({ type: 'money', icon: '💡', text: `${bill.name}${amt} due soon — paid yet?`, action: 'money' });
      }

      // 4. Unused subscriptions
      const sixtyDaysAgo = nowTs - (60 * 86400);
      const unusedCount = all('SELECT name FROM subscriptions').filter(s => {
        const recent = get(
          'SELECT COUNT(*) as c FROM transactions WHERE merchant LIKE ? AND timestamp > ?',
          [`%${s.name}%`, sixtyDaysAgo]
        );
        return (recent?.c || 0) === 0;
      }).length;
      if (unusedCount > 0) {
        suggestions.push({ type: 'money', icon: '🔕', text: `Found ${unusedCount} possibly unused subscription${unusedCount > 1 ? 's' : ''} — review?`, action: 'money' });
      }

      // 5. Follow-up emails that are due
      const dueFollowUps = all(
        'SELECT from_name, subject FROM email_cache WHERE follow_up_at IS NOT NULL AND follow_up_at <= ?',
        [nowTs]
      );
      if (dueFollowUps.length > 0) {
        suggestions.push({ type: 'email', icon: '🔔', text: `${dueFollowUps.length} follow-up reminder${dueFollowUps.length > 1 ? 's' : ''} due — check them?`, action: 'mail' });
      }

      // 6. Spending spike (vs last month)
      try {
        const now = new Date();
        const monthStart = Math.floor(new Date(now.getFullYear(), now.getMonth(), 1).getTime() / 1000);
        const lastMonthStart = Math.floor(new Date(now.getFullYear(), now.getMonth() - 1, 1).getTime() / 1000);
        const thisMonthSpend = get(`SELECT COALESCE(SUM(amount), 0) as t FROM transactions WHERE timestamp >= ? AND tx_type = 'debit'`, [monthStart]);
        const lastMonthSpend = get(`SELECT COALESCE(SUM(amount), 0) as t FROM transactions WHERE timestamp >= ? AND timestamp < ? AND tx_type = 'debit'`, [lastMonthStart, monthStart]);
        if ((thisMonthSpend?.t || 0) > (lastMonthSpend?.t || 0) * 1.3 && (lastMonthSpend?.t || 0) > 0) {
          suggestions.push({ type: 'money', icon: '📈', text: `Spending is 30%+ higher than last month — want a breakdown?`, action: 'money' });
        }
      } catch (_) {}

      return suggestions.slice(0, 5); // Max 5 suggestions
    } catch (err) {
      console.error('[IPC] get-proactive-suggestions error:', err);
      return [];
    }
  });

  // ── AI Chat: Unified handler with NL query, intent routing, memory, follow-ups ──
  // ── Brain data cache (avoid rebuilding 12K context every message) ──
  let _brainCache = { data: null, builtAt: 0 };
  const BRAIN_CACHE_TTL = 60000; // 60 seconds

  async function getCachedBrain(message) {
    const now = Date.now();
    if (_brainCache.data && (now - _brainCache.builtAt) < BRAIN_CACHE_TTL) {
      console.log(`[AI] Using cached brain data (${_brainCache.data.length} chars, age: ${now - _brainCache.builtAt}ms)`);
      return _brainCache.data;
    }
    const brain = await buildPersonalBrain(message);
    _brainCache = { data: brain, builtAt: now };
    console.log(`[AI] Built fresh brain data: ${brain ? brain.length + ' chars' : 'EMPTY'}`);
    return brain;
  }

  // ── Follow-up suggestions by query type ──
  // ── Cross-domain context builder — used by email synthesis and agent system prompt ──
  // Pure SQL, no LLM, < 5ms. Gathers what's actually happening in the user's life.
  // This is what makes the LLM's answer relevant instead of generic.
  function _getLiveContext() {
    const now = nowUnix();
    const ctx = { urgentTasks: [], upcomingEvents: [], activeGoals: [], overdueCount: 0 };
    try {
      ctx.urgentTasks = all(
        `SELECT title, due_at, category FROM reminders
         WHERE completed=0 AND archived_at IS NULL
           AND (due_at < ? OR priority_score >= 7 OR category='work')
         ORDER BY due_at ASC LIMIT 3`,
        [now + 86400]
      );
    } catch (_) {}
    try {
      ctx.overdueCount = get(
        `SELECT COUNT(*) as cnt FROM reminders
         WHERE completed=0 AND archived_at IS NULL AND due_at < ?`, [now]
      )?.cnt || 0;
    } catch (_) {}
    try {
      ctx.upcomingEvents = all(
        `SELECT title, start_at, location FROM calendar_events
         WHERE start_at BETWEEN ? AND ? ORDER BY start_at ASC LIMIT 3`,
        [now, now + 86400]
      );
    } catch (_) {}
    try {
      if (goalsService) ctx.activeGoals = goalsService.getActiveGoals().slice(0, 3);
    } catch (_) {}
    return ctx;
  }

  // ── Format live context as a compact text block for LLM prompts ──
  function _formatLiveContextForLLM(ctx) {
    const now = nowUnix();
    const lines = [];
    if (ctx.overdueCount > 0)     lines.push(`Overdue tasks: ${ctx.overdueCount}`);
    if (ctx.urgentTasks.length)   lines.push(`Urgent/upcoming tasks: ${ctx.urgentTasks.map(t => `"${t.title}" (due ${new Date(t.due_at * 1000).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })})`).join(' | ')}`);
    if (ctx.upcomingEvents.length) lines.push(`Calendar today: ${ctx.upcomingEvents.map(e => `"${e.title}" at ${new Date(e.start_at * 1000).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })}`).join(' | ')}`);
    if (ctx.activeGoals.length)   lines.push(`Active goals: ${ctx.activeGoals.map(g => g.title).join(' | ')}`);
    return lines.length ? lines.join('\n') : 'No urgent tasks or upcoming events.';
  }

  // ── Cross-domain context builder — used by email synthesis and agent system prompt ──
  // Pure SQL, no LLM, < 5ms. Gathers what's actually happening in the user's life.
  // This is what makes the LLM's answer relevant instead of generic.
  function _getLiveContext() {
    const now = nowUnix();
    const ctx = { urgentTasks: [], upcomingEvents: [], activeGoals: [], overdueCount: 0 };
    try {
      ctx.urgentTasks = all(
        `SELECT title, due_at, category FROM reminders
         WHERE completed=0 AND archived_at IS NULL
           AND (due_at < ? OR priority_score >= 7 OR category='work')
         ORDER BY due_at ASC LIMIT 3`,
        [now + 86400]
      );
    } catch (_) {}
    try {
      ctx.overdueCount = get(
        `SELECT COUNT(*) as cnt FROM reminders
         WHERE completed=0 AND archived_at IS NULL AND due_at < ?`, [now]
      )?.cnt || 0;
    } catch (_) {}
    try {
      ctx.upcomingEvents = all(
        `SELECT title, start_at, location FROM calendar_events
         WHERE start_at BETWEEN ? AND ? ORDER BY start_at ASC LIMIT 3`,
        [now, now + 86400]
      );
    } catch (_) {}
    try {
      if (goalsService) ctx.activeGoals = goalsService.getActiveGoals().slice(0, 3);
    } catch (_) {}
    return ctx;
  }

  // ── Format live context as a compact text block for LLM prompts ──
  function _formatLiveContextForLLM(ctx) {
    const lines = [];
    if (ctx.overdueCount > 0)      lines.push(`Overdue tasks: ${ctx.overdueCount}`);
    if (ctx.urgentTasks.length)    lines.push(`Urgent/upcoming tasks: ${ctx.urgentTasks.map(t => `"${t.title}" (due ${new Date(t.due_at * 1000).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })})`).join(' | ')}`);
    if (ctx.upcomingEvents.length) lines.push(`Calendar today: ${ctx.upcomingEvents.map(e => `"${e.title}" at ${new Date(e.start_at * 1000).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })}`).join(' | ')}`);
    if (ctx.activeGoals.length)    lines.push(`Active goals: ${ctx.activeGoals.map(g => g.title).join(' | ')}`);
    return lines.length ? lines.join('\n') : 'No urgent tasks or events noted.';
  }

  // ── Compute email follow-ups from actual email content — not hardcoded ──
  // Looks at the actual emails returned and suggests relevant next actions.
  function _computeEmailFollowUps(emails, liveCtx) {
    if (!emails || emails.length === 0) return ['Refresh inbox', 'Urgent emails', 'Who emails me most?'];
    const followUps = [];
    const hasUrgent  = emails.some(e => e.category === 'urgent');
    const hasAction  = emails.some(e => e.category === 'action');
    const hasUnread  = emails.some(e => !e.is_read);
    const senders    = [...new Set(emails.map(e => e.from_name || e.from_email).filter(Boolean))];

    if (hasUrgent)              followUps.push(`Reply to ${senders[0] || 'urgent email'}`);
    if (hasAction && !hasUrgent) followUps.push('Show emails needing reply');
    if (liveCtx.overdueCount > 0) followUps.push(`${liveCtx.overdueCount} overdue tasks — show them`);
    if (senders.length > 0 && !hasUrgent) followUps.push(`Emails from ${senders[0]}`);
    followUps.push('Refresh inbox');
    return followUps.slice(0, 3);
  }

  function _getFollowUps(type, message) {
    const msg = (message || '').toLowerCase();
    const KNOWN_MERCHANTS_INLINE = ['swiggy','zomato','uber','ola','amazon','flipkart','netflix','hotstar','spotify','airtel','jio','zerodha','groww','phonepe','paytm','cred','bigbasket','blinkit'];
    const hasMerchant = KNOWN_MERCHANTS_INLINE.some(m => msg.includes(m));

    switch (type) {
      case 'money':
        if (msg.match(/subscription|subscrib|renew|recurring/)) return ['What renews this month?', 'Most expensive subscription', 'My spending this month'];
        if (msg.match(/insurance|premium|policy/)) return ['Insurance documents', 'Unanswered insurance emails', 'My subscriptions'];
        if (hasMerchant) return ['My spending this month', 'Show my subscriptions', 'Compare to last month'];
        if (msg.match(/compar|vs\b|versus/)) return ['Spending breakdown', 'Show my subscriptions', 'Top merchants'];
        return ['Show my subscriptions', 'Category breakdown', 'Compare to last month'];
      case 'subscriptions':
        return ['What renews this month?', 'Total subscription cost', 'My spending this month'];
      case 'tasks':
        return ['Show overdue tasks', 'What\'s due this week?', 'Completed tasks this week'];
      case 'email':
        if (msg.match(/respond|replied|unanswer/)) return ['Show urgent emails', 'Email overview', 'Who emails me most?'];
        return ['Emails I haven\'t responded to', 'Urgent emails', 'Who emails me most?'];
      case 'focus':
        return ['Best focus day this month', 'My habits this week', 'Summary'];
      case 'habits':
        return ['Habit streaks', 'Missed habits this week', 'Focus time this month'];
      case 'calendar':
        return ['Free time today', 'What\'s due this week?', 'Summary'];
      case 'stats':
        return ['My spending this month', 'Show subscriptions', 'Overdue tasks'];
      default:
        return ['Summary', 'My spending this month', 'Show my tasks'];
    }
  }

  /**
   * Get recent chat messages as structured array for agent context.
   * Returns [{role: 'user'|'assistant', content: string}, ...]
   */
  function _getRecentChatHistory(limit = 12) {
    try {
      const messages = all(
        `SELECT role, text FROM chat_messages ORDER BY created_at DESC LIMIT ?`,
        [limit]
      );
      // Reverse to chronological order and map to agent format
      return messages.reverse().map(m => ({
        role: m.role === 'user' ? 'user' : 'assistant',
        content: (m.text || '').substring(0, 500),
      })).filter(m => m.content.length > 0);
    } catch (_) {
      return [];
    }
  }

  // ── Conversation context threading — tracks last money query for follow-up resolution ──
  // Example: user asks "food this month" → then "why is it high?" — the second
  // query inherits category='food' so nl-query doesn't need to re-extract it.
  // RESETS when the app restarts (in-memory only — stale context is worse than no context).
  const _chatSession = {
    lastDomain:    null,   // 'money', 'email', etc.
    lastCategory:  null,   // e.g. 'food', 'travel'
    lastMerchant:  null,   // e.g. 'swiggy', 'uber'
    lastQuery:     null,   // original message text
    lastQueryTime: 0,      // Date.now() ms for 5-min follow-up window
  };

  async function chatEnhancedHandler(message, mode) {
    // ── FAST PATH: greetings & trivial messages — instant response, no LLM ──
    const GREETING_RE = /^(hi|hey|hello|yo|sup|hiya|howdy|morning|good morning|good afternoon|good evening|gm|whats up|what's up|hii+|helo|namaste|ola)[\s!?.]*$/i;
    if (GREETING_RE.test(message.trim())) {
      const userName = getSetting('user_name') || '';
      const hour = new Date().getHours();
      const timeGreet = hour < 12 ? 'Morning' : hour < 17 ? 'Afternoon' : 'Evening';
      const name = userName ? `, ${userName}` : '';

      // Quick stats for context-aware greeting
      const taskCount = get(`SELECT COUNT(*) as cnt FROM reminders WHERE completed = 0 AND archived_at IS NULL`)?.cnt || 0;
      const urgentEmails = get(`SELECT COUNT(*) as cnt FROM email_cache WHERE category IN ('urgent','action') AND is_read = 0`)?.cnt || 0;
      const overdueCount = get(`SELECT COUNT(*) as cnt FROM reminders WHERE completed = 0 AND archived_at IS NULL AND due_at < ?`, [nowUnix()])?.cnt || 0;

      let statusLine = '';
      if (overdueCount > 0) statusLine = `You have ${overdueCount} overdue task${overdueCount > 1 ? 's' : ''}. Want me to walk through them?`;
      else if (urgentEmails > 0) statusLine = `${urgentEmails} email${urgentEmails > 1 ? 's' : ''} need attention. Want a summary?`;
      else if (taskCount > 0) statusLine = `${taskCount} open task${taskCount > 1 ? 's' : ''}, nothing urgent. You're clear.`;
      else statusLine = 'No urgent items. You\'re clear.';

      // Proactive intelligence — surface anomalies, renewals, streak risks
      let proactiveBlock = '';
      try {
        if (intelligenceService) {
          proactiveBlock = intelligenceService.formatInsightsForGreeting(2);
        }
      } catch (_) {}

      // Active goals summary — the agent tracking what the user cares about
      let goalsBlock = '';
      try { if (goalsService) goalsBlock = goalsService.getGoalSummaryForGreeting(); } catch (_) {}

      console.log(`[AI] FAST PATH greeting — skipped LLM entirely`);
      return {
        text: `${timeGreet}${name}. ${statusLine}${proactiveBlock}${goalsBlock}`,
        followUps: overdueCount > 0 ? ['Show overdue tasks', 'Plan my day'] : urgentEmails > 0 ? ['Summarize emails', 'Plan my day'] : ['Plan my day', 'What\'s new?'],
        mode: mode || 'work',
        aiProvider: 'fast-path'
      };
    }

    // 0. Session Memory: detect and store any user preferences (P8-2)
    const detectedPref = detectAndStorePreference(message);
    if (detectedPref) {
      console.log(`[SessionMemory] Stored preference: "${detectedPref.key}" (TTL: ${detectedPref.ttl}d)`);
    }

    // 0a. Passive fact extraction — learn structured facts from every message (no LLM, regex only)
    if (memoryExtractService) {
      const learned = memoryExtractService.extractAndSave(message);
      if (learned > 0) {
        console.log(`[MemoryExtract] Learned ${learned} new fact(s)`);

        // ── TIER-0e: Fact-declaration fast-ack ──────────────────────────────────
        // If the message IS a pure fact declaration (no question, no action verb,
        // no question words) AND we successfully extracted facts from it,
        // acknowledge instantly — do NOT send a full Ollama call just to say "Got it".
        const _trim = message.trim();
        const _hasQuestion = /[?]/.test(_trim) || /^(what|where|when|who|how|why|can|could|would|should|is|are|do|does|did)\b/i.test(_trim);
        const _hasActionVerb = /^(remind|add|create|delete|send|reply|book|schedule|set\s+a|draft|find|search|show|list|get|check)\b/i.test(_trim);
        if (!_hasQuestion && !_hasActionVerb && _trim.length <= 120) {
          console.log(`[AI] TIER-0e fast-ack — fact stored, skipping LLM`);
          const _acks = ['Noted.', 'Got it, I\'ll remember that.', 'Saved to memory.', 'Remembered.'];
          const _ack = _acks[Math.floor(Date.now() / 1000) % _acks.length];
          const ackResult = {
            text: _ack,
            followUps: ['What do you know about me?', 'Update my profile'],
            mode: mode || 'work',
            aiProvider: 'fast-ack'
          };
          try { run(`INSERT INTO chat_messages (role, text, created_at) VALUES (?, ?, ?)`, ['assistant', _ack, nowUnix()]); } catch (_) {}
          return ackResult;
        }
      }
    }

    // 0b. P10-4: Context Memory — extract entities and link to context threads
    try {
      const ctxResult = processContextMemory(message, 'chat', 'chat', `chat-${Date.now()}`);
      if (ctxResult) {
        console.log(`[ContextMemory] Tracked context thread: "${ctxResult.topic}" (${ctxResult.entities.length} entities)`);
      }
    } catch (_) {}

    // ── TIER-0g: Goal declaration detection — regex fast path, Ollama fallback ──
    // Fires before ANY cache or data query tier so "I want to cut food by 30%"
    // gets a CREATE response instead of being treated as a data query.
    if (goalsService) {
      const goalDetect = goalsService.detectGoalFromMessage(message);
      if (goalDetect) {
        if (goalDetect.confidence === 'high') {
          // Regex was confident — create goal immediately, zero LLM
          const created = goalsService.createGoal(goalDetect);
          const progress = goalsService.checkGoalProgress(created);
          const confirmText = goalsService.formatNewGoalConfirmation(created, progress);
          console.log(`[AI] TIER-0g goal created (regex) — skipped LLM: "${created.title}"`);
          return {
            text: confirmText,
            action: 'goal_created',
            data: { goal: created },
            followUps: ['Show my goals', 'How am I tracking?', 'What\'s my current progress?'],
            mode: mode || 'work',
            aiProvider: 'goal-regex'
          };
        } else if (goalDetect.confidence === 'low') {
          // Ambiguous — one Ollama call to extract structure
          const interpreted = await goalsService.interpretGoalWithOllama(message);
          if (interpreted) {
            const created = goalsService.createGoal(interpreted);
            const progress = goalsService.checkGoalProgress(created);
            const confirmText = goalsService.formatNewGoalConfirmation(created, progress);
            console.log(`[AI] TIER-0g goal created (ollama) — 1 LLM call: "${created.title}"`);
            return {
              text: confirmText,
              action: 'goal_created',
              data: { goal: created },
              followUps: ['Show my goals', 'How am I doing?', 'Set another goal'],
              mode: mode || 'work',
              aiProvider: 'goal-ollama'
            };
          }
          // Ollama couldn't extract a goal either — fall through to normal routing
        }
      }
    }

    // ── QUICK ACTION DETECTION: email refresh, weather, reply, simple reminders ──
    // Short/simple structured commands use regex fast-path (instant).
    // Complex reminders (>8 words), conditional, or context-heavy → agent (has write tools)
    const _wordCount = message.trim().split(/\s+/).length;
    const _isSimpleReminder = _wordCount <= 8 &&
      (/^remind\s*me/i.test(message) || /^(?:add|create|set)\s+(?:a\s+)?(?:reminder|task|todo)\s+to\s+/i.test(message));
    const isReminderRequest = _isSimpleReminder;
    const isEmailRefresh = /^(check|refresh|show|get)\s*(my\s*)?(mail|email|inbox)/i.test(message);
    const isWeatherQuery = /^(what.*weather|how.*outside|temperature)/i.test(message);
    const isReplyRequest = /^(?:reply|send\s+(?:a\s+)?reply)\s+(?:to\s+)?/i.test(message);

    // ── TIER 1: Structured data query fast-path — pure SQL, zero LLM ──────────
    // Must run BEFORE the agent so "how much did I spend on food?", "show overdue tasks",
    // "list subscriptions" etc. never hit Ollama.
    // isDataQuery() has built-in guards: skips action verbs (remind/add/delete/send)
    // and AI-reasoning phrases (should I / recommend / suggest).
    if (!isReminderRequest && !isEmailRefresh && !isWeatherQuery && !isReplyRequest) {
      // ── TIER 0b: Response cache — serves repeated queries instantly (zero SQL, zero LLM) ──
      if (responseCacheService) {
        const cached = responseCacheService.get(message);
        if (cached) {
          console.log(`[AI] Cache HIT — returning cached response for: "${message.substring(0, 40)}"`);
          return { ...cached, aiProvider: 'cache' };
        }
      }

      // ── TIER 0c: Persistent query cache — answers from previous sessions (SQLite) ──
      if (memoryExtractService) {
        const persisted = memoryExtractService.recallAnswer(message);
        if (persisted) {
          console.log(`[AI] Persistent cache HIT (${persisted.source}, served ${persisted.hit_count}x) — "${message.substring(0, 40)}"`);
          const pResult = { text: persisted.answer_text, followUps: [], mode: mode || 'work', aiProvider: `persisted-${persisted.source}` };
          if (responseCacheService) responseCacheService.set(message, pResult, 300);
          return pResult;
        }
      }

      // ── TIER 0d: Memory recall — "what is my name" → ai_memory → instant, no LLM ──
      const RECALL_RE = /^(?:what(?:'s|\s+is)\s+my|who\s+(?:is\s+my|am\s+i)\b|where\s+do\s+i\s+(?:live|work)\b|do\s+you\s+(?:know|remember)\s+my|what(?:'s|\s+was)\s+my)\s*/i;
      if (RECALL_RE.test(message.trim()) && memoryExtractService) {
        const topic = message.trim().replace(RECALL_RE, '').replace(/[?!.]+$/, '').trim().toLowerCase();
        if (topic.length >= 2) {
          const factsText = memoryExtractService.recallFacts(topic);
          if (factsText) {
            console.log(`[AI] Memory recall HIT for topic: "${topic}"`);
            try { run(`INSERT INTO chat_messages (role, text, created_at) VALUES (?, ?, ?)`, ['assistant', factsText.substring(0, 2000), nowUnix()]); } catch (_) {}
            memoryExtractService.saveAnswer(message, `[STATUS] ${factsText}`, 'memory-recall', 86400 * 7);
            const recallResult = { text: `[STATUS] ${factsText}`, followUps: ['What else do you know about me?', 'Update my profile'], mode: mode || 'work', aiProvider: 'memory-recall' };
            if (responseCacheService) responseCacheService.set(message, recallResult, 600);
            return recallResult;
          }
        }
      }

      if (nlQueryService && nlQueryService.isDataQuery(message)) {
        // Inject session context for follow-up queries — fills category/merchant only if
        // nl-query didn't extract them itself, and only when session is < 5 min old.
        const sessionCtx = (_chatSession.lastQueryTime && Date.now() - _chatSession.lastQueryTime < 300000)
          ? { category: _chatSession.lastCategory, merchant: _chatSession.lastMerchant }
          : undefined;
        const queryResult = nlQueryService.processQuery(message, sessionCtx);
        if (queryResult.answer) {
          const followUps = _getFollowUps(queryResult.type, message);

          // ── Email synthesis: context-aware, cross-domain intelligence ──
          // The LLM gets: emails + user's actual live context (tasks, goals, calendar).
          // Asks for per-email summary + action + urgency, plus a synthesis statement.
          // Computes follow-ups from actual email content — not hardcoded strings.
          // Cache: 90 seconds only (emails are live data, stale answers are worse than slow ones).
          if (queryResult.data?.needsSummary && aiService) {
            console.log(`[AI] TIER-1 email synthesis: ${queryResult.data.limit} emails + live context`);
            let aiSummary = '';
            const liveCtx = _getLiveContext();
            const ctxBlock = _formatLiveContextForLLM(liveCtx);
            const emailCount = queryResult.data.emails?.length || queryResult.data.limit;

            try {
              aiSummary = await aiService.aiCall(
                'chat',
                queryResult.data.summaryPrompt,
                {
                  systemContext:
                    `You are ARIA, a sharp personal executive AI.\n` +
                    `User's current state:\n${ctxBlock}\n\n` +
                    `Analyze the ${emailCount} emails below with awareness of this context.\n\n` +
                    `For EACH email output exactly:\n` +
                    `• **[Sender]: "[Subject]"** — [one sentence: what it is + what, if anything, the user must do] — **[High/Medium/Low]**\n\n` +
                    `After all emails, on its own line:\n` +
                    `**→** [Single most important thing — specific, not generic. If an email connects to a task, goal, or event listed above, name it explicitly.]\n\n` +
                    `Rules: no preamble, no filler, no "here is a summary". Start with the first bullet.`
                }
              );
              aiSummary = (typeof aiSummary === 'string' ? aiSummary : aiSummary?.text || '').trim();
            } catch (_) { /* fallback to plain list below */ }

            // Compute follow-ups from actual email content — not hardcoded
            const computedFollowUps = _computeEmailFollowUps(queryResult.data.emails, liveCtx);

            const summaryText = aiSummary
              ? `📧 **Emails:**\n\n${aiSummary}`
              : `📧 ${queryResult.answer}`;

            const summaryResult = {
              text: summaryText,
              action: 'query_answered',
              queryType: 'email',
              data: queryResult.data,
              followUps: computedFollowUps,
              mode: mode || 'work',
              aiProvider: 'local-query+context-synthesis'
            };
            // 90 seconds only — email state changes, stale answers are wrong answers
            if (responseCacheService) responseCacheService.set(message, summaryResult, 90);
            return summaryResult;
          }

          console.log(`[AI] TIER-1 fast-path (data-query) — skipped LLM entirely`);
          const result = {
            text: `📊 ${queryResult.answer}`,
            action: 'query_answered',
            queryType: queryResult.type,
            data: queryResult.data,
            followUps,
            mode: mode || 'work',
            aiProvider: 'local-query'
          };
          // Update conversation context so follow-up queries can inherit category/merchant
          if (queryResult.type === 'money') {
            _chatSession.lastDomain    = 'money';
            _chatSession.lastCategory  = queryResult.data?.category || null;
            _chatSession.lastMerchant  = queryResult.data?.merchants?.[0]?.name?.toLowerCase()
                                          || queryResult.data?.merchant
                                          || null;
            _chatSession.lastQuery     = message;
            _chatSession.lastQueryTime = Date.now();
          }
          // Cache data query answers for 5 min (they're time-relative, e.g. "this week")
          if (responseCacheService) responseCacheService.set(message, result, 300);
          // Persist in query_answers (TTL 1hr — data changes but not every minute)
          if (memoryExtractService) memoryExtractService.saveAnswer(message, result.text, 'sql', 3600);
          return result;
        }
      }
    }

    // If NOT an actionable intent, route through the intelligent agent (STREAMING)
    if (!isReminderRequest && !isEmailRefresh && !isWeatherQuery && !isReplyRequest) {
      try {
        const recentMessages = _getRecentChatHistory(12);
        const { app: electronApp } = require('electron');
        const appData = electronApp.getPath('userData');
        const dbPath = path.join(appData, 'aria.db');
        const vectorDir = path.join(appData, 'vectors');

        // Assign a streamId so the renderer can match chunks to this request
        const streamId = `s${Date.now()}`;
        if (mainWindow) mainWindow.webContents.send('chat-chunk-start', { streamId });

        let accumulatedText = '';
        console.log(`[AI] Routing to agent (stream): "${message.substring(0, 50)}..."`);

        const agentResult = await callPythonStream('agent_stream', {
          message,
          conversation_history: recentMessages,
          db_path: dbPath,
          vector_dir: vectorDir,
        }, (chunk) => {
          accumulatedText += chunk;
          if (mainWindow) mainWindow.webContents.send('chat-chunk', { streamId, text: chunk });
        }, 90000);

        if (agentResult && !agentResult.error) {
          // Use final dict text (most accurate) or fall back to what was streamed
          let mainText = (agentResult.text || accumulatedText || '').trim();
          if (mainText.length < 5) throw new Error('Empty agent response');
          let followUps = [];
          const followUpMatch = mainText.match(/FOLLOW_UP:\s*(.+)/i);
          if (followUpMatch) {
            mainText = mainText.replace(/\n?FOLLOW_UP:.+/i, '').trim();
            followUps = followUpMatch[1].split('|').map(q => q.trim()).filter(Boolean).slice(0, 3);
          }
          if (followUps.length === 0) {
            followUps = _getFollowUps('general', message);
          }

          const toolNames = (agentResult.tools_used || []).map(t => t.name).join(', ');
          console.log(`[AI] Agent responded via ${agentResult.model} (${agentResult.iterations} iterations, tools: ${toolNames || 'none'})`);

          // NOTE: chat_messages storage is handled by the frontend (useChat.js saveChatMessage).
          // Backend storing here would cause duplicates — removed intentionally.

          // Phase F write-back: extract entities from conversation and store to context_entities
          try {
            const combinedText = `${message} ${mainText}`;
            const entities = extractEntities(combinedText);
            const meaningfulTypes = new Set(['person', 'company', 'project']);
            for (const ent of entities.filter(e => meaningfulTypes.has(e.type) && e.value.length >= 3)) {
              // Dedupe: skip if same entity stored in last 7 days
              const existing = get(
                `SELECT id FROM context_entities WHERE entity_value = ? AND source = 'chat' AND created_at > ?`,
                [ent.value, nowUnix() - 604800]
              );
              if (!existing) {
                run(
                  `INSERT INTO context_entities (entity_type, entity_value, source) VALUES (?, ?, 'chat')`,
                  [ent.type, ent.value]
                );
                console.log(`[ContextMemory] Stored entity: ${ent.type} "${ent.value}"`);
              }
            }
          } catch (_) {}

          // Persist agent answer so future identical questions skip Ollama entirely.
          // Skip time-sensitive tool results (calendar, weather) — those must stay live.
          const _timeTools = new Set(['get_calendar_events', 'get_weather', 'refresh_emails']);
          const _isFactual = !(agentResult.tools_used || []).some(t => _timeTools.has(t.name));
          if (_isFactual && memoryExtractService) {
            memoryExtractService.saveAnswer(message, mainText, 'agent', 3600);
            // Also mine the agent's reply for facts about the user that ARIA deduced
            memoryExtractService.extractAndSave(`${message} ${mainText}`);
          }

          return {
            text: mainText,
            followUps,
            mode: mode || 'work',
            aiProvider: `agent-${agentResult.model || 'ollama'}`,
            toolsUsed: agentResult.tools_used,
            iterations: agentResult.iterations,
            streamId, // tells the renderer which streaming bubble to finalize
          };
        } else if (agentResult?.error) {
          console.log(`[AI] Agent error: ${agentResult.error} — falling back to legacy chain`);
        }
      } catch (err) {
        console.log(`[AI] Agent call failed: ${err.message} — falling back to legacy chain`);
      }
    }

    // ───────────────────────────────────────────────────────────────────────
    // FALLBACK: Legacy intent chain (reached only when agent fails + for regex-caught actions)
    // ───────────────────────────────────────────────────────────────────────

    // 1. Check if this is a data query (instant answer, no AI needed)
    //    Uses intelligent semantic extraction: extractQueryIntent → route by domain+action
    if (nlQueryService && nlQueryService.isDataQuery(message)) {
      const queryResult = nlQueryService.processQuery(message);
      if (queryResult.answer) {
        const followUps = _getFollowUps(queryResult.type, message);
        return {
          text: `📊 ${queryResult.answer}`,
          action: 'query_answered',
          queryType: queryResult.type,
          data: queryResult.data,
          followUps,
          mode: mode || 'work',
          aiProvider: 'local-query'
        };
      }
    }

    // 2. Classify intent — LOCAL FIRST: Python sidecar pattern match → Ollama → default
    //    Short messages (< 6 words) use faster timeout since they're usually simple
    let intent = 'chat';
    let pythonParams = null;
    const wordCount = message.trim().split(/\s+/).length;
    const intentTimeout = wordCount < 6 ? 2000 : 5000;
    try {
      // Try Python sidecar pattern-based intent matching first (fast, no LLM needed)
      const sidecarIntent = await callPython('intent', { text: message }, intentTimeout);
      if (sidecarIntent && sidecarIntent.intent && sidecarIntent.intent !== 'unknown') {
        intent = sidecarIntent.intent;
        pythonParams = sidecarIntent.params || null;
        console.log(`[AI] Intent via Python sidecar: ${intent} (params: ${JSON.stringify(pythonParams)})`);

        // Python found nl-query intent with params (e.g. category: "food") but isDataQuery missed it
        // Give nl-query engine another chance with Python's extracted params
        if (intent === 'nl-query' && pythonParams && nlQueryService) {
          const queryResult = nlQueryService.processQuery(message, pythonParams);
          if (queryResult.answer) {
            const followUps = _getFollowUps(queryResult.type, message);
            return {
              text: `📊 ${queryResult.answer}`,
              action: 'query_answered',
              queryType: queryResult.type,
              data: queryResult.data,
              followUps,
              mode: mode || 'work',
              aiProvider: 'local-query+python'
            };
          }
        }
      } else if (wordCount >= 6) {
        // Only try AI-based intent for longer messages — short ones are likely chat
        intent = await aiService.aiCall('intent', message, {});
        console.log(`[AI] Intent via AI service: ${intent}`);
      }
    } catch (err) {
      // Python sidecar unavailable — try AI service only for longer messages
      if (wordCount >= 6) {
        try {
          intent = await aiService.aiCall('intent', message, {});
          console.log(`[AI] Intent via AI fallback: ${intent}`);
        } catch (_) {
          console.log('[AI] All intent classifiers failed — defaulting to chat');
        }
      } else {
        console.log('[AI] Short message, skipping AI intent — defaulting to chat');
      }
    }

    // 2b. Learning Loop: check confidence weight for this action type (P8-1)
    const actionWeight = (intent !== 'chat') ? getActionConfidenceWeight(intent) : 1.0;
    // If user historically dismisses this action type >70% of the time, skip auto-proposal
    const shouldAutoPropose = actionWeight >= 0.5;

    // 3. Route actionable intents — Commander Model: propose → confirm → execute
    if (shouldAutoPropose && (intent === 'reminder' || /^remind\s*me/i.test(message))) {
      try {
        // Parse with AI but DON'T save yet — propose to user first
        let parsed;
        try {
          const result = await aiService.aiCall('parse', message, {});
          parsed = typeof result === 'string' ? JSON.parse(result) : result;
        } catch (_) {
          parsed = { title: message.replace(/^remind\s*me\s*(to\s*)?/i, '').substring(0, 100), due_at: new Date(Date.now() + 60 * 60 * 1000).toISOString() };
        }
        if (!parsed.title) parsed.title = message.substring(0, 100);
        if (!parsed.due_at) parsed.due_at = new Date(Date.now() + 60 * 60 * 1000).toISOString();
        const dueAtUnix = Math.floor(new Date(parsed.due_at).getTime() / 1000);
        const dueStr = new Date(dueAtUnix * 1000).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' });

        return {
          text: `I'll set a reminder for you:`,
          proposedAction: {
            type: 'reminder',
            label: 'Set Reminder',
            description: `"${parsed.title}" — ${dueStr}`,
            payload: { title: parsed.title, due_at: dueAtUnix, recurring: parsed.recurring || null, category: parsed.category || 'task', priority_score: parsed.priority_score || 0 }
          },
          followUps: ['Show my tasks', 'What\'s due today?'],
          mode: mode || 'work'
        };
      } catch (err) {
        // Fall through to chat if reminder parsing fails
      }
    }

    if (shouldAutoPropose && (intent === 'email' || /^(check|refresh|show)\s*(my\s*)?(mail|email|inbox)/i.test(message))) {
      if (!gmailService || !gmailService.isGmailConfigured()) {
        return { text: 'Gmail is not configured yet. Go to Settings to connect.', followUps: [], mode: mode || 'work' };
      }
      return {
        text: 'Want me to refresh your inbox?',
        proposedAction: {
          type: 'email',
          label: 'Refresh Inbox',
          description: 'Fetch latest emails from Gmail and categorize them.',
          payload: {}
        },
        followUps: ['Any urgent emails?', 'Show unread'],
        mode: mode || 'work'
      };
    }

    // Email reply intent (P6-1): "reply to [name]" or "send a reply to ..."
    const replyMatch = message.match(/^reply\s+(?:to\s+)?(.+)/i) || message.match(/^send\s+(?:a\s+)?reply\s+(?:to\s+)?(.+)/i);
    if (shouldAutoPropose && replyMatch) {
      const recipient = replyMatch[1].trim();
      // Find the most recent email from this recipient
      const emailRow = get(
        `SELECT id, subject, from_email, body_preview FROM email_cache WHERE (from_name LIKE ? OR from_email LIKE ?) ORDER BY received_at DESC LIMIT 1`,
        [`%${recipient}%`, `%${recipient}%`]
      );
      if (emailRow && gmailService?.isGmailConfigured()) {
        // Draft a reply using AI
        let draft = '';
        try {
          draft = await aiService.aiCall('chat', `Draft a brief, professional reply to this email:\nSubject: ${emailRow.subject}\nFrom: ${emailRow.from_email}\nPreview: ${(emailRow.body_preview || '').slice(0, 300)}\n\nWrite only the reply body, no subject line.`, { systemContext: 'You are drafting a short professional email reply. Write only the reply body text, 2-3 sentences max.' });
          draft = (typeof draft === 'string' ? draft : draft?.text || '').trim();
        } catch (_) {
          draft = 'Thanks for your email. I\'ll get back to you shortly.';
        }
        return {
          text: `Here's a draft reply to ${emailRow.from_email}:`,
          proposedAction: {
            type: 'send-reply',
            label: 'Send Reply',
            description: `To: ${emailRow.from_email} — Re: ${emailRow.subject}`,
            payload: { messageId: emailRow.id, draft }
          },
          followUps: ['Edit the draft', 'Cancel reply'],
          mode: mode || 'work'
        };
      }
    }

    if (intent === 'weather' || /^(what.*weather|how.*outside|temperature)/i.test(message)) {
      // Check cache first — weather valid for 10 min
      const cachedWeather = responseCacheService && responseCacheService.get('__weather__');
      if (cachedWeather) {
        console.log('[AI] Cache HIT — weather (10 min TTL)');
        return { ...cachedWeather, aiProvider: 'cache' };
      }
      try {
        const w = await weatherService.getWeather();
        const weatherResult = {
          text: `${w.emoji} ${w.condition} in ${w.city} — ${w.temp}° (feels ${w.feels_like}°). High ${w.high}°, Low ${w.low}°. ${w.rain_chance > 30 ? `🌧 ${w.rain_chance}% rain chance.` : ''}`,
          action: 'weather_shown',
          followUps: ['Should I carry an umbrella?', 'Tomorrow\'s forecast?'],
          mode: mode || 'work'
        };
        // Cache under a fixed key so any weather-phrased query hits the same entry
        if (responseCacheService) responseCacheService.set('__weather__', weatherResult, 600);
        return weatherResult;
      } catch (_) {}
    }

    // 4. Store memory if user is sharing a fact (explicit) — deduped via memoryExtractService
    const memoryPatterns = /^(remember|note|my name is|i am|i work|i live|i prefer|i like|my)\b/i;
    if (memoryPatterns.test(message)) {
      if (memoryExtractService) {
        memoryExtractService.saveExplicitFact(message, 'chat');
      } else {
        try { run('INSERT INTO ai_memory (fact, source) VALUES (?, ?)', [message, 'chat']); } catch (_) {}
      }
    }

    // 5. Mode-specific personality hints
    const modeHints = {
      work: ' We\'re in work mode — be efficient, action-oriented, no fluff.',
      personal: ' We\'re in personal mode — be warm but still direct.',
    };

    // 6. Build AI context with full personal brain + session memory (P8-2)
    const brainData = await getCachedBrain(message);
    console.log(`[AI] Brain data for "${message.substring(0, 40)}": ${brainData ? brainData.length + ' chars' : 'EMPTY'}`);

    // Inject session preferences so ARIA remembers cross-session context
    const sessionPrefs = getActiveSessionPreferences(10);
    const sessionMemoryBlock = sessionPrefs.length > 0
      ? `\n\nUSER PREFERENCES (remembered from past conversations):\n${sessionPrefs.map(p => `- "${p.value}" (set: ${new Date(p.created_at * 1000).toLocaleDateString()})`).join('\n')}\nRespect these unless the user explicitly changes them.`
      : '';

    // 6a. Conversation memory — last 10 messages for follow-up context
    let conversationMemory = '';
    try {
      if (intelligenceService) {
        conversationMemory = intelligenceService.getConversationMemory(10);
        if (conversationMemory) {
          console.log(`[AI] Injecting conversation memory (${conversationMemory.length} chars)`);
        }
      }
    } catch (_) {}

    // 6b. Proactive intelligence — surface anomalies/alerts in AI context
    let proactiveContext = '';
    try {
      if (intelligenceService) {
        const insights = intelligenceService.getProactiveInsights();
        if (insights.length > 0) {
          const top = insights.slice(0, 3);
          proactiveContext = `\n\nPROACTIVE ALERTS (mention these if relevant to the user's question):\n` +
            top.map(i => `- [${i.severity.toUpperCase()}] ${i.message}`).join('\n');
        }
      }
    } catch (_) {}

    // 6b. Graceful fallback context (P8-3): if intent wasn't matched, tell LLM to propose something helpful
    const fallbackHint = (intent === 'chat' && /\b(do something|help me|can you|take action|handle|fix|deal with)\b/i.test(message))
      ? `\n\nThe user seems to want you to DO something. If you can figure out what action they want, propose it clearly. Suggest a specific next step they can confirm — e.g. "Want me to set a reminder for that?" or "I can draft a reply — should I?". Don't just describe what you could do — propose it.`
      : '';

    const systemContext = `You are ARIA — the user's personal executive AI. You live on their desktop and have full access to their emails, finances, tasks, calendar, habits, and contacts. You are NOT a generic chatbot. You are their personal brain.

VOICE: Direct. Decisive. Minimal. Like a sharp chief-of-staff briefing their boss. Never ramble. Never use filler phrases like "Sure!", "Of course!", "Let me help!", "Great question!". Just answer.

RESPONSE FORMAT — Every response MUST follow this structure:
1. CLASSIFICATION LINE (first line, always): Start with one of these tags:
   [ACTION] — something the user needs to do or you're proposing to do
   [FYI] — informational, no action needed
   [RISK] — financial risk, missed deadline, expiring item, anomaly detected
   [STATUS] — answering a question about their current state
2. ANSWER: 1-3 sentences max. Quote real numbers, names, dates from the data below.
3. REASONING (optional, only for risks/actions): One line starting with "→" explaining WHY.

EXAMPLE RESPONSES:
User: "any urgent emails?"
[ACTION] 2 emails need attention. PayPal invoice (₹4,200) from yesterday, and a meeting reschedule from Priya.
→ PayPal flagged because: financial + unread 24h.

User: "how much did I spend?"
[STATUS] ₹12,430 this month across 20 transactions. Largest: ₹3,200 at Amazon.
→ 18% above last month's pace.

User: "what should I do first?"
[ACTION] Handle the overdue "Submit report" task (3 days late). Then check Priya's email about tomorrow's meeting.
→ Report scored 95 urgency. Everything else can wait.

ABSOLUTE RULES:
1. NEVER say "I cannot access your data" — you HAVE their data below.
2. NEVER say "please check your bank app" — YOU are their bank app.
3. NEVER use placeholder text like "[Sender 1]", "[amount]". Use REAL data from below.
4. NEVER format responses as long bullet-point lists. Be concise and decisive.
5. NEVER use headers like "## Summary" or "### Emails". This is a chat, not a document.
6. NEVER start with greetings if the user didn't greet you. Get straight to the answer.
7. If data IS present below, use it. If not, say "Not in your synced data yet."
8. Keep responses under 4 sentences unless the user explicitly asks for detail.
9. When user says "last 3 emails" or similar, find them in RECENT EMAILS below and quote actual senders, subjects, dates.

Today is ${new Date().toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}.${modeHints[mode] || ''}
${brainData}${sessionMemoryBlock}${conversationMemory}${proactiveContext}${fallbackHint}

After your response, on a NEW LINE starting with "FOLLOW_UP:", suggest 2-3 brief follow-up questions. Format: FOLLOW_UP: question1 | question2 | question3`;

    // ── LOCAL-FIRST AI ROUTING ── Ollama → Grok → Gemini (legacy fallback chain)
    // Reached only for intent='chat' when agent fails + all specific handlers fell through
    let responseText = '';
    let aiProvider = 'unknown';

    // Try: ai.js chain (Ollama local → Grok → Gemini)
    try {
      const response = await aiService.aiCall('chat', message, { systemContext });
      responseText = typeof response === 'string' ? response : (response?.text || response?.toString() || '');
      aiProvider = 'ai-service';
      console.log(`[AI] Chat via AI service (Ollama/cloud) ✓`);
    } catch (err) {
      console.log('[AI] AI service chain failed:', err.message);
      responseText = "I'm having trouble connecting to my AI brain right now. Check that Ollama is running (`ollama serve`) and try again.";
      aiProvider = 'fallback-message';
    }

    // 7. Parse follow-up suggestions from AI response
    let mainText = responseText;
    let followUps = [];
    const followUpMatch = responseText.match(/FOLLOW_UP:\s*(.+)/i);
    if (followUpMatch) {
      mainText = responseText.replace(/\n?FOLLOW_UP:.+/i, '').trim();
      followUps = followUpMatch[1].split('|').map(q => q.trim()).filter(Boolean).slice(0, 3);
    }

    return { text: mainText, followUps, mode: mode || 'work', aiProvider };
  }

  ipcMain.handle('chat-enhanced', async (_event, message, mode) => {
    const _t0 = Date.now();
    try {
      const _resp = await chatEnhancedHandler(message, mode);
      // Non-blocking route signal: log every query → tier → latency for routing intelligence
      setImmediate(() => {
        try {
          const _norm = (message || '').toLowerCase().trim()
            .replace(/[^a-z0-9\s\u20b9]/g, '').replace(/\s+/g, ' ').substring(0, 200);
          run(
            `INSERT INTO route_signals (query_norm, tier, latency_ms, had_answer, created_at) VALUES (?, ?, ?, ?, ?)`,
            [_norm, _resp?.aiProvider || 'unknown', Date.now() - _t0, _resp?.text ? 1 : 0, Math.floor(Date.now() / 1000)]
          );
        } catch (_) {}
      });
      return _resp;
    } catch (err) {
      console.error('[IPC] chat-enhanced error:', err);
      return { text: `Sorry, something went wrong: ${err.message}`, followUps: [], mode: mode || 'work' };
    }
  });

  // ── Learning Loop: feedback weight helpers (P8-1) ──
  function recordActionFeedback(actionType, confirmed, context) {
    try {
      run(
        'INSERT INTO action_feedback (action_type, confirmed, context) VALUES (?, ?, ?)',
        [actionType, confirmed ? 1 : 0, context ? JSON.stringify(context) : null]
      );
    } catch (e) { console.error('[Feedback] record error:', e.message); }
  }

  function getActionConfidenceWeight(actionType) {
    // Returns a multiplier 0.3-1.5 based on recent confirm/dismiss history
    try {
      const row = get(
        `SELECT COUNT(*) as total,
                SUM(CASE WHEN confirmed = 1 THEN 1 ELSE 0 END) as confirms
         FROM action_feedback
         WHERE action_type = ? AND created_at > ?`,
        [actionType, nowUnix() - 30 * 86400]
      );
      if (!row || row.total < 3) return 1.0; // Not enough data — neutral weight
      const ratio = row.confirms / row.total; // 0.0 to 1.0
      // Map: 0% confirmed → 0.3x, 50% → 0.9x, 100% → 1.5x
      return Math.max(0.3, Math.min(1.5, 0.3 + ratio * 1.2));
    } catch (_) { return 1.0; }
  }

  // ── Session Memory: preference helpers (P8-2) ──
  function storeSessionPreference(key, value, sourceMessage, ttlDays = 30) {
    try {
      const expiresAt = nowUnix() + ttlDays * 86400;
      // Upsert: if same key exists, update it
      run(
        `INSERT INTO session_preferences (key, value, source_message, ttl_days, expires_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(id) DO NOTHING`,
        [key, value, sourceMessage, ttlDays, expiresAt]
      );
      // Remove expired preferences while we're here
      run('DELETE FROM session_preferences WHERE expires_at > 0 AND expires_at < ?', [nowUnix()]);
    } catch (e) { console.error('[SessionMemory] store error:', e.message); }
  }

  function getActiveSessionPreferences(limit = 10) {
    try {
      return all(
        `SELECT key, value, source_message, created_at FROM session_preferences
         WHERE expires_at = 0 OR expires_at > ?
         ORDER BY created_at DESC LIMIT ?`,
        [nowUnix(), limit]
      );
    } catch (_) { return []; }
  }

  function detectAndStorePreference(message) {
    // Detect user preferences/instructions that should persist across sessions
    const prefPatterns = [
      { pattern: /(?:don'?t|do not|stop|no more|skip)\s+(?:worry about|alert me about|remind me about|show me|bug me about)\s+(.+)/i, ttl: 30 },
      { pattern: /(?:i'?m not|not)\s+(?:worried|concerned|interested)\s+(?:about|in)\s+(.+?)(?:\s+(?:this|right now|for now|this month|this week|today))?$/i, ttl: 30 },
      { pattern: /(?:i\s+(?:prefer|always|usually|like to|want to|need to))\s+(.+)/i, ttl: 60 },
      { pattern: /(?:from\s+now\s+on|going\s+forward|always)\s+(.+)/i, ttl: 90 },
      { pattern: /(?:my\s+(?:name|job|role|company|title)\s+is)\s+(.+)/i, ttl: 0 }, // permanent
      { pattern: /(?:i\s+work\s+(?:at|for|in))\s+(.+)/i, ttl: 0 },
    ];
    for (const { pattern, ttl } of prefPatterns) {
      const match = message.match(pattern);
      if (match) {
        const value = match[1].trim().replace(/[.!?]+$/, '');
        const key = value.toLowerCase().replace(/\s+/g, '-').substring(0, 50);
        storeSessionPreference(key, value, message, ttl);
        return { key, value, ttl };
      }
    }
    return null;
  }

  // ── Commander Model: Confirm & Execute proposed actions ──
  ipcMain.handle('confirm-action', async (_event, type, payload) => {
    try {
      // Learning Loop: record positive feedback
      recordActionFeedback(type, true, { payload_keys: Object.keys(payload || {}) });

      // P10-5: Track time saved for confirmed actions
      trackTimeSaved('confirmed_action', 1, `Confirmed ${type} action via chat`);

      switch (type) {
        case 'reminder': {
          const result = run(
            'INSERT INTO reminders (title, due_at, recurring, category, priority_score) VALUES (?, ?, ?, ?, ?)',
            [payload.title, payload.due_at, payload.recurring || null, payload.category || 'task', payload.priority_score || 0]
          );
          const reminder = { id: result.lastInsertRowid, title: payload.title, due_at: payload.due_at };
          remindService.scheduleReminder?.(reminder);
          // P10-5: Track time saved for auto-scheduled reminder
          trackTimeSaved('auto_reminder', 2, `Auto-created reminder: "${payload.title}"`);
          // Phase B: live re-index reminder
          if (_pythonProc) {
            const { app: _eApp } = require('electron');
            const _vDir = _eApp.getPath('userData') + '/vectors';
            const _text = `${payload.title} ${payload.category || 'task'}`.trim();
            if (_text) callPython('index', { db_dir: _vDir, doc_type: 'reminder', doc_id: `reminder-${result.lastInsertRowid}`, text: _text }).catch(() => {});
          }
          // Invalidate cached task/reminder queries so next query reflects the new item
          if (responseCacheService) responseCacheService.invalidateByTerms(['task', 'remind', 'due', 'todo', 'overdue', 'open task']);
          return { ok: true, text: `✅ Reminder set: "${payload.title}"` };
        }
        case 'email': {
          if (!gmailService || !gmailService.isGmailConfigured()) {
            return { ok: false, text: 'Gmail not configured.' };
          }
          const result = await gmailService.fetchEmails();
          const count = result.emails?.length || 0;
          const urgent = result.emails?.filter(e => e.category === 'urgent').length || 0;
          // P10-5: Track time saved for email triage
          if (count > 0) trackTimeSaved('email_triage', count * 0.5, `Triaged ${count} emails`);
          // Invalidate cached email queries so next query shows fresh inbox counts
          if (responseCacheService) responseCacheService.invalidateByTerms(['email', 'inbox', 'urgent', 'unread', 'mail']);
          return { ok: true, text: `📬 ${count} emails fetched${urgent > 0 ? `, ${urgent} urgent` : ''}.` };
        }
        case 'send-reply': {
          if (!gmailService || !gmailService.isGmailConfigured()) {
            return { ok: false, text: 'Gmail not configured.' };
          }
          const { messageId, draft } = payload;
          if (!messageId || !draft) return { ok: false, text: 'Missing messageId or draft.' };
          const sendResult = await gmailService.sendReply(messageId, draft);
          if (sendResult.success) {
            // P10-5: Track time saved for AI-drafted reply
            trackTimeSaved('ai_reply', 5, `AI-drafted reply sent`);
            return { ok: true, text: '✅ Reply sent successfully.' };
          }
          return { ok: false, text: `Send failed: ${sendResult.error}` };
        }
        default:
          return { ok: false, text: `Unknown action type: ${type}` };
      }
    } catch (err) {
      console.error(`[IPC] confirm-action (${type}) error:`, err);
      return { ok: false, text: err.message };
    }
  });

  // ── Commander Model: Dismiss action — Learning Loop negative feedback ──
  ipcMain.handle('dismiss-action', async (_event, type, payload) => {
    try {
      recordActionFeedback(type, false, { payload_keys: Object.keys(payload || {}) });
      return { ok: true, text: 'Action dismissed.' };
    } catch (err) {
      console.error(`[IPC] dismiss-action error:`, err);
      return { ok: false, text: err.message };
    }
  });

  // ── Learning Loop: get feedback stats for a specific action type ──
  ipcMain.handle('get-action-feedback', async (_event, actionType) => {
    try {
      const stats = all(
        `SELECT action_type,
                COUNT(*) as total,
                SUM(CASE WHEN confirmed = 1 THEN 1 ELSE 0 END) as confirmed_count,
                SUM(CASE WHEN confirmed = 0 THEN 1 ELSE 0 END) as dismissed_count
         FROM action_feedback
         WHERE (? IS NULL OR action_type = ?)
         GROUP BY action_type
         ORDER BY total DESC`,
        [actionType || null, actionType || null]
      );
      return { ok: true, stats };
    } catch (err) {
      return { ok: false, stats: [], error: err.message };
    }
  });

  // ── Session Memory: IPC handlers ──
  ipcMain.handle('get-session-preferences', async () => {
    return getActiveSessionPreferences(20);
  });

  ipcMain.handle('clear-session-preference', async (_event, id) => {
    try {
      run('DELETE FROM session_preferences WHERE id = ?', [id]);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  // ── Automation Rules: IPC handlers ──
  ipcMain.handle('get-automation-rules', async () => {
    try { return automationRulesService ? automationRulesService.getRules() : []; }
    catch (err) { return []; }
  });

  ipcMain.handle('create-automation-rule', async (_event, rule) => {
    try { return automationRulesService ? automationRulesService.createRule(rule) : null; }
    catch (err) { return { error: err.message }; }
  });

  ipcMain.handle('update-automation-rule', async (_event, id, fields) => {
    try { return automationRulesService ? automationRulesService.updateRule(id, fields) : false; }
    catch (err) { return false; }
  });

  ipcMain.handle('toggle-automation-rule', async (_event, id, enabled) => {
    try { if (automationRulesService) automationRulesService.toggleRule(id, enabled); return { ok: true }; }
    catch (err) { return { ok: false }; }
  });

  ipcMain.handle('delete-automation-rule', async (_event, id) => {
    try { if (automationRulesService) automationRulesService.deleteRule(id); return { ok: true }; }
    catch (err) { return { ok: false }; }
  });

  ipcMain.handle('get-route-stats', async (_event, days) => {
    try { return automationRulesService ? automationRulesService.getRouteStats(days || 7) : {}; }
    catch (err) { return {}; }
  });

  // ══════════════════════════════════════════════════════════════════════
  // PHASE 10 — INTELLIGENCE LAYERS (P10-1 through P10-5)
  // ══════════════════════════════════════════════════════════════════════

  // ── P10-1: Learning Layer — Signal-Level Behavioral Learning ──────
  // Tracks user interactions with Today panel cards and computes
  // per-domain multipliers that adjust priority scores over time.

  function trackSignalInteraction(signalId, action, domain, scoreAtTime) {
    try {
      run(
        'INSERT INTO signal_interactions (signal_id, domain, action, score_at_time) VALUES (?, ?, ?, ?)',
        [signalId, domain || 'unknown', action, scoreAtTime || 0]
      );
      // Recompute adjustment for this domain
      recomputeSignalAdjustment(domain);
    } catch (e) { console.error('[Learning] track error:', e.message); }
  }

  function recomputeSignalAdjustment(domain) {
    try {
      const thirtyDaysAgo = nowUnix() - 30 * 86400;
      const stats = get(
        `SELECT COUNT(*) as total,
                SUM(CASE WHEN action = 'acted' THEN 1 ELSE 0 END) as acted,
                SUM(CASE WHEN action = 'dismissed' THEN 1 ELSE 0 END) as dismissed
         FROM signal_interactions
         WHERE domain = ? AND created_at > ?`,
        [domain, thirtyDaysAgo]
      );
      if (!stats || stats.total < 5) return; // Need minimum data
      const actRate = stats.acted / stats.total; // 0.0-1.0
      // Map: 0% acted → 0.5x, 50% → 1.0x, 100% → 1.5x
      const multiplier = Math.max(0.5, Math.min(1.5, 0.5 + actRate));
      run(
        `INSERT INTO signal_adjustments (domain, multiplier, sample_size, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(domain) DO UPDATE SET multiplier=excluded.multiplier, sample_size=excluded.sample_size, updated_at=excluded.updated_at`,
        [domain, multiplier, stats.total, nowUnix()]
      );
    } catch (e) { console.error('[Learning] recompute error:', e.message); }
  }

  function getSignalMultiplier(domain) {
    try {
      const row = get('SELECT multiplier FROM signal_adjustments WHERE domain = ?', [domain]);
      return row ? row.multiplier : 1.0;
    } catch (_) { return 1.0; }
  }

  function getAllSignalStats() {
    try {
      const thirtyDaysAgo = nowUnix() - 30 * 86400;
      const stats = all(
        `SELECT domain,
                COUNT(*) as total,
                SUM(CASE WHEN action = 'acted' THEN 1 ELSE 0 END) as acted,
                SUM(CASE WHEN action = 'dismissed' THEN 1 ELSE 0 END) as dismissed,
                SUM(CASE WHEN action = 'ignored' THEN 1 ELSE 0 END) as ignored
         FROM signal_interactions
         WHERE created_at > ?
         GROUP BY domain`,
        [thirtyDaysAgo]
      );
      const adjustments = all('SELECT domain, multiplier, sample_size FROM signal_adjustments');
      return { stats, adjustments };
    } catch (_) { return { stats: [], adjustments: [] }; }
  }

  // Signal Learning IPC handlers
  ipcMain.handle('track-signal', async (_event, signalId, action, domain, score) => {
    try {
      trackSignalInteraction(signalId, action, domain, score);
      // P10-5: Track time saved when user acts on a signal
      if (action === 'acted') {
        trackTimeSaved('signal_action', 0.5, `Acted on ${domain} signal: ${signalId}`);
      }
      return { ok: true };
    } catch (err) { return { ok: false, error: err.message }; }
  });

  ipcMain.handle('get-signal-stats', async () => {
    try {
      return { ok: true, ...getAllSignalStats() };
    } catch (err) { return { ok: false, error: err.message }; }
  });

  // ── P10-2: Predictive Engine — Time Estimates & Risk Detection ────
  // Predicts how long tasks will take based on historical data,
  // warns about tight deadlines, and generates prep signals.

  function recordTaskCompletion(taskTitle, category, actualMinutes, wasLate) {
    try {
      run(
        'INSERT INTO task_completions (task_title, category, actual_minutes, was_late) VALUES (?, ?, ?, ?)',
        [taskTitle, category || 'task', actualMinutes, wasLate ? 1 : 0]
      );
    } catch (e) { console.error('[Predict] record error:', e.message); }
  }

  function predictTimeForCategory(category) {
    try {
      const rows = all(
        `SELECT actual_minutes FROM task_completions WHERE category = ? AND actual_minutes > 0 ORDER BY created_at DESC LIMIT 20`,
        [category || 'task']
      );
      if (rows.length < 2) {
        // Fallback: use general average
        const generalRow = get('SELECT AVG(actual_minutes) as avg_min FROM task_completions WHERE actual_minutes > 0');
        return { estimatedMinutes: generalRow?.avg_min || 30, confidence: 'low', sampleSize: rows.length };
      }
      const avg = rows.reduce((s, r) => s + r.actual_minutes, 0) / rows.length;
      return {
        estimatedMinutes: Math.round(avg),
        confidence: rows.length >= 10 ? 'high' : 'medium',
        sampleSize: rows.length
      };
    } catch (_) { return { estimatedMinutes: 30, confidence: 'low', sampleSize: 0 }; }
  }

  function generatePredictionSignals() {
    try {
      const now = nowUnix();
      const sevenDays = now + 7 * 86400;

      // Clear old resolved predictions
      run('DELETE FROM prediction_signals WHERE resolved = 1 AND created_at < ?', [now - 7 * 86400]);

      const predictions = [];

      // 1. Tasks with deadlines in next 7 days — check if time is tight
      const upcomingTasks = all(
        `SELECT id, title, due_at, category FROM reminders
         WHERE completed = 0 AND archived_at IS NULL AND due_at > ? AND due_at <= ?
         ORDER BY due_at ASC LIMIT 15`,
        [now, sevenDays]
      );

      for (const task of upcomingTasks) {
        const estimate = predictTimeForCategory(task.category);
        const hoursRemaining = (task.due_at - now) / 3600;
        const hoursNeeded = estimate.estimatedMinutes / 60;

        // Risk: less than 2x the estimated time remaining
        if (hoursRemaining < hoursNeeded * 2) {
          const riskLevel = hoursRemaining < hoursNeeded ? 'critical' :
                           hoursRemaining < hoursNeeded * 1.5 ? 'high' : 'medium';

          // Don't duplicate: check if we already have a prediction for this task
          const existing = get('SELECT id FROM prediction_signals WHERE target_id = ? AND resolved = 0', [`task-${task.id}`]);
          if (!existing) {
            run(
              `INSERT INTO prediction_signals (signal_type, target_id, title, description, risk_level, estimated_hours, hours_remaining)
               VALUES (?, ?, ?, ?, ?, ?, ?)`,
              [
                'deadline_risk',
                `task-${task.id}`,
                `⏱️ ${task.title} — time is tight`,
                `Estimated ${Math.round(hoursNeeded)}h needed, only ${Math.round(hoursRemaining)}h remaining.`,
                riskLevel,
                hoursNeeded,
                hoursRemaining
              ]
            );
          }

          predictions.push({
            id: `pred-task-${task.id}`,
            domain: 'prediction',
            title: `⏱️ ${task.title} — time is tight`,
            description: `You typically need ~${Math.round(hoursNeeded)}h for ${task.category} tasks. Only ${Math.round(hoursRemaining)}h until deadline.`,
            score: riskLevel === 'critical' ? 90 : riskLevel === 'high' ? 75 : 60,
            confidence: estimate.confidence,
            reasoning: `Based on ${estimate.sampleSize} completed ${task.category} tasks. ${riskLevel} risk.`,
            action_type: 'view-task', action_params: { id: task.id }
          });

          // P10-5: Track prevented issue for deadline risk detection
          if (riskLevel === 'critical' || riskLevel === 'high') {
            trackPreventedIssue('missed_deadline', `Warned about tight deadline: "${task.title}" (${riskLevel})`, 500, `task-${task.id}`);
          }
        }
      }

      // 2. Subscriptions with no payment confirmation after renewal date
      const overdueSubs = all(
        `SELECT id, name, amount, next_renewal FROM subscriptions
         WHERE next_renewal IS NOT NULL AND next_renewal > 0 AND next_renewal < ? AND next_renewal > ?`,
        [now, now - 7 * 86400]
      );
      for (const sub of overdueSubs) {
        const existing = get('SELECT id FROM prediction_signals WHERE target_id = ? AND resolved = 0', [`sub-${sub.id}`]);
        if (!existing) {
          run(
            `INSERT INTO prediction_signals (signal_type, target_id, title, description, risk_level, estimated_hours)
             VALUES (?, ?, ?, ?, ?, ?)`,
            [
              'bill_prediction',
              `sub-${sub.id}`,
              `${sub.name} — renewal may have been missed`,
              `Was due ${Math.round((now - sub.next_renewal) / 86400)}d ago. No payment email detected.`,
              'medium',
              0
            ]
          );
          trackPreventedIssue('late_payment', `Caught potential missed payment: ${sub.name} ₹${sub.amount}`, parseFloat(String(sub.amount).replace(/[₹,]/g, '')) || 100, `sub-${sub.id}`);
        }
      }

      return predictions;
    } catch (e) {
      console.error('[Predict] generate error:', e.message);
      return [];
    }
  }

  // Prediction IPC handlers
  ipcMain.handle('log-task-time', async (_event, taskTitle, category, actualMinutes, wasLate) => {
    try {
      recordTaskCompletion(taskTitle, category, actualMinutes, wasLate);
      return { ok: true };
    } catch (err) { return { ok: false, error: err.message }; }
  });

  ipcMain.handle('get-predictions', async () => {
    try {
      const signals = all('SELECT * FROM prediction_signals WHERE resolved = 0 ORDER BY created_at DESC LIMIT 10');
      return { ok: true, signals };
    } catch (err) { return { ok: false, signals: [], error: err.message }; }
  });

  // ── P10-3: Relationship Intelligence — Classify Contacts by Behavior ─
  // Studies email patterns to classify senders as boss/client/colleague/etc.
  // Adjusts email priority scoring based on actual relationship importance.

  function analyzeRelationships() {
    try {
      const now = nowUnix();
      const ninetyDays = now - 90 * 86400;

      // Get all unique senders from recent emails
      const senders = all(
        `SELECT from_email, from_name, COUNT(*) as email_count,
                SUM(CASE WHEN is_read = 1 THEN 1 ELSE 0 END) as read_count,
                MAX(received_at) as last_email_at
         FROM email_cache
         WHERE from_email IS NOT NULL AND received_at > ?
         GROUP BY from_email
         HAVING email_count >= 2
         ORDER BY email_count DESC LIMIT 50`,
        [ninetyDays]
      );

      for (const sender of senders) {
        const email = sender.from_email.toLowerCase();
        const name = sender.from_name || email.split('@')[0];

        // Compute response rate: how many of their emails did user read?
        const responseRate = sender.read_count / sender.email_count;

        // Check reply patterns from email_interactions
        const replyStats = get(
          `SELECT COUNT(*) as total_replied, AVG(response_minutes) as avg_response
           FROM email_interactions WHERE sender_email = ? AND replied = 1`,
          [email]
        );

        const avgResponseHours = replyStats?.avg_response ? replyStats.avg_response / 60 : 0;
        const totalReplied = replyStats?.total_replied || 0;

        // Classify relationship type based on patterns
        let relType = 'unknown';
        let importanceScore = 50;

        // High response + fast reply = important person (boss/client)
        if (responseRate > 0.8 && avgResponseHours < 4 && sender.email_count >= 5) {
          relType = 'boss';
          importanceScore = 90;
        } else if (responseRate > 0.7 && sender.email_count >= 3) {
          relType = 'client';
          importanceScore = 80;
        } else if (responseRate > 0.4 && sender.email_count >= 2) {
          relType = 'colleague';
          importanceScore = 60;
        } else if (responseRate < 0.2 || /noreply|newsletter|digest|update|promo/i.test(email)) {
          relType = 'newsletter';
          importanceScore = 10;
        } else if (/invoice|billing|payment|support/i.test(email)) {
          relType = 'vendor';
          importanceScore = 40;
        }

        // Upsert sender profile
        run(
          `INSERT INTO sender_profiles (email, name, relationship_type, response_rate, avg_response_hours, importance_score, total_received, total_replied, last_analyzed_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(email) DO UPDATE SET
             name=excluded.name, relationship_type=excluded.relationship_type,
             response_rate=excluded.response_rate, avg_response_hours=excluded.avg_response_hours,
             importance_score=excluded.importance_score, total_received=excluded.total_received,
             total_replied=excluded.total_replied, last_analyzed_at=excluded.last_analyzed_at`,
          [email, name, relType, responseRate, avgResponseHours, importanceScore, sender.email_count, totalReplied, now]
        );
      }

      // Track email interactions from cached emails (for future analysis)
      const recentEmails = all(
        `SELECT message_id, from_email, is_read, received_at FROM email_cache
         WHERE from_email IS NOT NULL AND received_at > ?`, [ninetyDays]
      );
      for (const e of recentEmails) {
        try {
          run(
            `INSERT OR IGNORE INTO email_interactions (sender_email, direction, message_id, replied, created_at)
             VALUES (?, 'inbound', ?, ?, ?)`,
            [e.from_email.toLowerCase(), e.message_id, e.is_read ? 1 : 0, e.received_at]
          );
        } catch(_) {}
      }

      return senders.length;
    } catch (e) {
      console.error('[Relationship] analyze error:', e.message);
      return 0;
    }
  }

  function detectRelationshipRisks() {
    try {
      const now = nowUnix();
      const risks = [];

      // Find contacts where gap since last contact > 2x their normal frequency
      const profiles = all(
        `SELECT sp.email, sp.name, sp.relationship_type, sp.importance_score, sp.total_received,
                MAX(ec.received_at) as last_email_at
         FROM sender_profiles sp
         LEFT JOIN email_cache ec ON LOWER(ec.from_email) = sp.email
         WHERE sp.relationship_type IN ('boss', 'client', 'colleague')
           AND sp.importance_score >= 50
         GROUP BY sp.email`
      );

      for (const p of profiles) {
        if (!p.last_email_at) continue;
        const daysSinceContact = (now - p.last_email_at) / 86400;
        // Expected frequency: total_received emails over 90 days = avg gap
        const avgGapDays = p.total_received > 1 ? 90 / p.total_received : 30;

        if (daysSinceContact > avgGapDays * 2 && daysSinceContact > 7) {
          risks.push({
            id: `rel-risk-${p.email.replace(/[^a-z0-9]/g, '')}`,
            domain: 'relationship',
            title: `${p.name} — contact gap`,
            description: `${Math.round(daysSinceContact)} days since last contact (normally every ${Math.round(avgGapDays)} days). ${p.relationship_type}.`,
            score: p.importance_score >= 80 ? 55 : 45,
            confidence: 'medium',
            reasoning: `${p.relationship_type} with importance ${p.importance_score}. Gap is ${Math.round(daysSinceContact / avgGapDays)}x normal.`,
            action_type: 'contact-person', action_params: { email: p.email, name: p.name }
          });
        }
      }

      return risks;
    } catch (e) {
      console.error('[Relationship] risks error:', e.message);
      return [];
    }
  }

  function getSenderImportance(email) {
    try {
      const profile = get('SELECT importance_score, relationship_type FROM sender_profiles WHERE email = ?', [(email || '').toLowerCase()]);
      if (profile) return profile;
      return { importance_score: 50, relationship_type: 'unknown' };
    } catch (_) { return { importance_score: 50, relationship_type: 'unknown' }; }
  }

  // Relationship IPC handlers
  ipcMain.handle('analyze-relationships', async () => {
    try {
      const count = analyzeRelationships();
      return { ok: true, analyzed: count };
    } catch (err) { return { ok: false, error: err.message }; }
  });

  ipcMain.handle('get-relationship-profile', async (_event, email) => {
    try {
      const profile = get('SELECT * FROM sender_profiles WHERE email = ?', [(email || '').toLowerCase()]);
      return { ok: true, profile };
    } catch (err) { return { ok: false, error: err.message }; }
  });

  // ── P10-4: Context Memory — Entity Extraction & Cross-Item Linking ──
  // Extracts entities (people, companies, projects) from text and links
  // related items across emails, tasks, and notes.

  function extractEntities(text) {
    if (!text) return [];
    const entities = [];

    // Company patterns: capitalized multi-word names, common suffixes
    const companyPatterns = /\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+)*(?:\s+(?:Corp|Inc|Ltd|LLC|Solutions|Technologies|Tech|Services|Group|Labs|Studio|Digital|Media|Capital|Partners))?)\b/g;
    let match;
    const seen = new Set();

    while ((match = companyPatterns.exec(text)) !== null) {
      const val = match[1].trim();
      if (val.length > 2 && val.length < 50 && !seen.has(val.toLowerCase())) {
        // Filter out common English words that happen to be capitalized
        const commonWords = new Set(['The','This','That','There','Here','Today','Tomorrow','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday','Sunday','January','February','March','April','May','June','July','August','September','October','November','December','Please','Thanks','Hello','Dear','Best','Regards','Subject','From','Sent','Meeting','Reminder','Task','Email','Note','Update','Status','Report','Budget','Review','What','Which','Where','When','Why','Who','Whose','Whom','How','Would','Could','Should','Shall','Will','Might','Must','Can','Have','Has','Had','Does','Did','Show','Tell','Find','Give','Help','Make','Send','Get','Set','Add']);
        if (!commonWords.has(val)) {
          seen.add(val.toLowerCase());
          // Determine if it's a person or company
          const type = /(?:Corp|Inc|Ltd|LLC|Solutions|Technologies|Tech|Services|Group|Labs|Studio|Digital|Media|Capital|Partners)$/i.test(val) ? 'company' : 'person';
          entities.push({ type, value: val });
        }
      }
    }

    // Project keywords: quoted strings, or "project X"
    const projectPattern = /(?:project|proposal|deal|contract|initiative)\s+["']?([A-Z][a-zA-Z0-9\s]{2,30})["']?/gi;
    while ((match = projectPattern.exec(text)) !== null) {
      const val = match[1].trim();
      if (!seen.has(val.toLowerCase())) {
        seen.add(val.toLowerCase());
        entities.push({ type: 'project', value: val });
      }
    }

    // Topic keywords in brackets or after "about"/"regarding"
    const topicPattern = /(?:about|regarding|re:|for)\s+(?:the\s+)?["']?([A-Za-z][A-Za-z0-9\s]{2,40})["']?/gi;
    while ((match = topicPattern.exec(text)) !== null) {
      const val = match[1].trim().replace(/\s+$/, '');
      if (val.length > 3 && !seen.has(val.toLowerCase())) {
        seen.add(val.toLowerCase());
        entities.push({ type: 'topic', value: val });
      }
    }

    return entities.slice(0, 15); // Cap at 15 entities
  }

  function findOrCreateContextThread(topic, entities) {
    try {
      // Check if a similar thread already exists
      const existing = get(
        `SELECT id, entities FROM context_threads WHERE topic = ? AND status = 'active'`,
        [topic]
      );
      if (existing) {
        // Merge new entities
        let existingEntities = [];
        try { existingEntities = JSON.parse(existing.entities || '[]'); } catch(_) {}
        const merged = [...existingEntities];
        for (const e of entities) {
          if (!merged.some(m => m.value.toLowerCase() === e.value.toLowerCase())) {
            merged.push(e);
          }
        }
        run('UPDATE context_threads SET entities = ?, last_activity_at = ? WHERE id = ?',
          [JSON.stringify(merged), nowUnix(), existing.id]);
        return existing.id;
      }

      const result = run(
        'INSERT INTO context_threads (topic, entities, last_activity_at) VALUES (?, ?, ?)',
        [topic, JSON.stringify(entities), nowUnix()]
      );
      return result.lastInsertRowid;
    } catch (e) {
      console.error('[Context] thread error:', e.message);
      return null;
    }
  }

  function linkItemToContext(threadId, itemType, itemId, relevance) {
    try {
      run(
        `INSERT INTO context_links (thread_id, item_type, item_id, relevance)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(thread_id, item_type, item_id) DO UPDATE SET relevance=excluded.relevance`,
        [threadId, itemType, String(itemId), relevance || 0.5]
      );
    } catch (_) {}
  }

  function autoLinkEntities(threadId, entities) {
    try {
      for (const entity of entities) {
        // Search emails for matching entities
        const matchEmails = all(
          `SELECT message_id FROM email_cache WHERE subject LIKE ? OR body_preview LIKE ? LIMIT 5`,
          [`%${entity.value}%`, `%${entity.value}%`]
        );
        for (const em of matchEmails) {
          linkItemToContext(threadId, 'email', em.message_id, 0.7);
        }

        // Search tasks
        const matchTasks = all(
          `SELECT id FROM reminders WHERE title LIKE ? LIMIT 5`,
          [`%${entity.value}%`]
        );
        for (const t of matchTasks) {
          linkItemToContext(threadId, 'task', t.id, 0.7);
        }

        // Search notes
        const matchNotes = all(
          `SELECT id FROM notes WHERE title LIKE ? OR content LIKE ? LIMIT 5`,
          [`%${entity.value}%`, `%${entity.value}%`]
        );
        for (const n of matchNotes) {
          linkItemToContext(threadId, 'note', n.id, 0.6);
        }

        // Store entity in context_entities table
        run(
          'INSERT INTO context_entities (entity_type, entity_value, thread_id, source) VALUES (?, ?, ?, ?)',
          [entity.type, entity.value, threadId, 'auto']
        );
      }
    } catch (e) { console.error('[Context] autoLink error:', e.message); }
  }

  function getActiveContexts(limit) {
    try {
      const threads = all(
        `SELECT ct.*, COUNT(cl.id) as link_count
         FROM context_threads ct
         LEFT JOIN context_links cl ON cl.thread_id = ct.id
         WHERE ct.status = 'active'
         GROUP BY ct.id
         ORDER BY ct.last_activity_at DESC
         LIMIT ?`,
        [limit || 10]
      );
      return threads.map(t => ({
        ...t,
        entities: (() => { try { return JSON.parse(t.entities); } catch(_) { return []; } })()
      }));
    } catch (_) { return []; }
  }

  function getContextForItem(itemType, itemId) {
    try {
      return all(
        `SELECT ct.id, ct.topic, ct.entities, ct.last_activity_at, cl.relevance
         FROM context_links cl
         JOIN context_threads ct ON ct.id = cl.thread_id
         WHERE cl.item_type = ? AND cl.item_id = ? AND ct.status = 'active'
         ORDER BY cl.relevance DESC`,
        [itemType, String(itemId)]
      );
    } catch (_) { return []; }
  }

  // Process text through context memory (used for chat messages, emails, etc.)
  function processContextMemory(text, source, itemType, itemId) {
    try {
      // Skip trivial/short messages that won't yield meaningful context threads
      if (!text || text.trim().split(/\s+/).length < 4 || text.trim().length < 15) return null;
      const entities = extractEntities(text);
      if (entities.length === 0) return null;

      // Group entities into a topic (use the first company/project, or first entity)
      const topicEntity = entities.find(e => e.type === 'project' || e.type === 'company') || entities[0];
      const topic = topicEntity.value;

      const threadId = findOrCreateContextThread(topic, entities);
      if (threadId && itemType && itemId) {
        linkItemToContext(threadId, itemType, itemId, 0.8);
        autoLinkEntities(threadId, entities);
      }

      return { threadId, topic, entities };
    } catch (e) {
      console.error('[Context] process error:', e.message);
      return null;
    }
  }

  // Context Memory IPC handlers
  ipcMain.handle('get-active-contexts', async () => {
    try {
      return { ok: true, contexts: getActiveContexts(15) };
    } catch (err) { return { ok: false, contexts: [], error: err.message }; }
  });

  ipcMain.handle('link-context', async (_event, threadId, itemType, itemId) => {
    try {
      linkItemToContext(threadId, itemType, itemId, 0.9);
      return { ok: true };
    } catch (err) { return { ok: false, error: err.message }; }
  });

  ipcMain.handle('get-context-for-item', async (_event, itemType, itemId) => {
    try {
      const contexts = getContextForItem(itemType, itemId);
      return { ok: true, contexts };
    } catch (err) { return { ok: false, contexts: [], error: err.message }; }
  });

  // ── P10-5: Outcome Tracking — ROI and Value Proof ─────────────────
  // Tracks time saved, issues prevented, and calculates weekly ROI.

  function trackTimeSaved(activity, minutesSaved, details) {
    try {
      // Dedupe: don't track same activity more than once per hour
      const recent = get(
        `SELECT id FROM time_saved_log WHERE activity = ? AND details = ? AND created_at > ?`,
        [activity, details, nowUnix() - 3600]
      );
      if (recent) return;

      run(
        'INSERT INTO time_saved_log (activity, minutes_saved, details) VALUES (?, ?, ?)',
        [activity, minutesSaved, details || '']
      );
    } catch (e) { console.error('[Outcome] time saved error:', e.message); }
  }

  function trackPreventedIssue(issueType, description, estimatedCost, relatedItemId) {
    try {
      // Dedupe: same issue type + item only once per day
      const today = todayISO();
      const recent = get(
        `SELECT id FROM prevented_issues WHERE issue_type = ? AND related_item_id = ? AND created_at > ?`,
        [issueType, relatedItemId, nowUnix() - 86400]
      );
      if (recent) return;

      run(
        'INSERT INTO prevented_issues (issue_type, description, estimated_cost, related_item_id) VALUES (?, ?, ?, ?)',
        [issueType, description, estimatedCost || 0, relatedItemId || null]
      );
    } catch (e) { console.error('[Outcome] prevented issue error:', e.message); }
  }

  function generateOutcomeReport() {
    try {
      const now = nowUnix();
      const weekAgo = now - 7 * 86400;

      // Time saved this week
      const timeSaved = all(
        `SELECT activity, SUM(minutes_saved) as total_minutes, COUNT(*) as count
         FROM time_saved_log WHERE created_at > ?
         GROUP BY activity`,
        [weekAgo]
      );
      const totalMinutesSaved = timeSaved.reduce((s, r) => s + r.total_minutes, 0);

      // Issues prevented this week
      const issues = all(
        `SELECT issue_type, COUNT(*) as count, SUM(estimated_cost) as total_cost
         FROM prevented_issues WHERE created_at > ?
         GROUP BY issue_type`,
        [weekAgo]
      );
      const totalIssues = issues.reduce((s, r) => s + r.count, 0);
      const totalSavings = issues.reduce((s, r) => s + (r.total_cost || 0), 0);

      // Auto-compute time saved from ARIA's automatic activities
      const emailsTriaged = get(
        `SELECT COUNT(*) as cnt FROM email_cache WHERE cached_at > ?`, [weekAgo]
      )?.cnt || 0;
      const autoTriageMinutes = Math.round(emailsTriaged * 0.5); // 30s per email triaged

      const tasksAutoPrioritized = get(
        `SELECT COUNT(*) as cnt FROM reminders WHERE created_at > ? AND priority_score > 0`, [weekAgo]
      )?.cnt || 0;
      const autoPriorityMinutes = tasksAutoPrioritized * 2; // 2 min per task if done manually

      const totalAutoMinutes = autoTriageMinutes + autoPriorityMinutes;
      const grandTotalMinutes = totalMinutesSaved + totalAutoMinutes;

      // ROI: assume subscription cost is ₹499/month = ~₹125/week
      const weeklySubCost = 125;
      const hourlyRate = 300; // ₹300/hour assumed user value
      const moneyValueOfTimeSaved = (grandTotalMinutes / 60) * hourlyRate;
      const totalValue = moneyValueOfTimeSaved + totalSavings;
      const roi = weeklySubCost > 0 ? Math.round((totalValue / weeklySubCost) * 10) / 10 : 0;

      return {
        period: { from: new Date((now - 7 * 86400) * 1000).toISOString().split('T')[0], to: todayISO() },
        timeSaved: {
          breakdown: timeSaved,
          autoTriageMinutes,
          autoPriorityMinutes,
          totalMinutes: grandTotalMinutes,
          totalHours: Math.round(grandTotalMinutes / 6) / 10
        },
        issuesPrevented: {
          breakdown: issues,
          total: totalIssues,
          totalSavings
        },
        roi: {
          moneyValueOfTimeSaved: Math.round(moneyValueOfTimeSaved),
          preventedCosts: Math.round(totalSavings),
          totalValue: Math.round(totalValue),
          weeklyCost: weeklySubCost,
          multiple: roi
        }
      };
    } catch (e) {
      console.error('[Outcome] report error:', e.message);
      return { timeSaved: { totalMinutes: 0, totalHours: 0 }, issuesPrevented: { total: 0 }, roi: { multiple: 0 } };
    }
  }

  function snapshotWeeklyOutcome() {
    try {
      const report = generateOutcomeReport();
      const weekStart = report.period.from;
      run(
        `INSERT INTO outcome_snapshots (week_start, total_minutes_saved, issues_prevented, estimated_savings, roi_multiple, details)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(week_start) DO UPDATE SET
           total_minutes_saved=excluded.total_minutes_saved, issues_prevented=excluded.issues_prevented,
           estimated_savings=excluded.estimated_savings, roi_multiple=excluded.roi_multiple, details=excluded.details`,
        [weekStart, report.timeSaved.totalMinutes, report.issuesPrevented.total,
         report.roi.totalValue, report.roi.multiple, JSON.stringify(report)]
      );
    } catch (e) { console.error('[Outcome] snapshot error:', e.message); }
  }

  // Outcome Tracking IPC handlers
  ipcMain.handle('get-outcome-report', async () => {
    try {
      return { ok: true, ...generateOutcomeReport() };
    } catch (err) { return { ok: false, error: err.message }; }
  });

  ipcMain.handle('get-outcome-history', async () => {
    try {
      const snapshots = all('SELECT * FROM outcome_snapshots ORDER BY week_start DESC LIMIT 12');
      return { ok: true, snapshots };
    } catch (err) { return { ok: false, snapshots: [], error: err.message }; }
  });

  // ── P10 Intelligence: Combined Enhancement to get-user-state ──────
  // This function runs all intelligence layers and injects their signals
  // into the priority list. Called once per get-user-state.
  function runIntelligenceLayers(priorities) {
    try {
      // 1. Apply Learning Layer multipliers to all priorities
      for (const p of priorities) {
        const multiplier = getSignalMultiplier(p.domain);
        if (multiplier !== 1.0) {
          p.originalScore = p.score;
          p.score = Math.round(p.score * multiplier);
          p.learned = true;
          p.learningMultiplier = multiplier;
        }
      }

      // 2. Apply Relationship Intelligence to email priorities
      for (const p of priorities) {
        if (p.domain === 'email' && p.action_params?.id) {
          const emailRow = get('SELECT from_email FROM email_cache WHERE message_id = ?', [p.action_params.id]);
          if (emailRow?.from_email) {
            const sender = getSenderImportance(emailRow.from_email);
            if (sender.relationship_type !== 'unknown') {
              // Adjust score based on sender importance
              const adjustFactor = (sender.importance_score - 50) / 100; // -0.5 to +0.5
              p.score = Math.round(p.score * (1 + adjustFactor * 0.5));
              p.senderType = sender.relationship_type;
            }
          }
        }
      }

      // 3. Inject Prediction signals
      const predictionSignals = generatePredictionSignals();
      for (const pred of predictionSignals) {
        // Don't duplicate if already in priorities
        if (!priorities.find(p => p.id === pred.id)) {
          priorities.push(pred);
        }
      }

      // 4. Inject Relationship risk signals
      const relRisks = detectRelationshipRisks();
      for (const risk of relRisks) {
        if (!priorities.find(p => p.id === risk.id)) {
          priorities.push(risk);
        }
      }

      // 5. Auto-track time saved for prioritization
      if (priorities.length > 0) {
        trackTimeSaved('auto_prioritize', 5, `Auto-prioritized ${priorities.length} items`);
      }

      // Re-sort after adjustments
      priorities.sort((a, b) => b.score - a.score);

      // Re-cap to reasonable range
      for (const p of priorities) {
        p.score = Math.min(99, Math.max(1, p.score));
      }

    } catch (e) {
      console.error('[Intelligence] layer error:', e.message);
    }
    return priorities;
  }

  // ── Today: Morning Ritual / Top Priorities ──
  ipcMain.handle('get-morning-ritual', async () => {
    try {
      const nowTs = nowUnix();
      const todayStart = Math.floor(new Date().setHours(0, 0, 0, 0) / 1000);
      const todayEnd = Math.floor(new Date().setHours(23, 59, 59, 999) / 1000);

      // Top priority tasks (not completed, sorted by priority)
      const priorities = all(
        'SELECT id, title, due_at, priority_score, category FROM reminders WHERE completed = 0 AND archived_at IS NULL AND parent_id IS NULL ORDER BY priority_score DESC LIMIT 5',
        []
      );

      // Today's meetings
      const meetings = all(
        'SELECT title, start_at, end_at FROM calendar_events WHERE start_at >= ? AND start_at <= ? ORDER BY start_at ASC',
        [todayStart, todayEnd]
      );

      // Focus stats
      const focusToday = get(
        'SELECT COALESCE(SUM(duration), 0) as minutes FROM focus_sessions WHERE date = ?',
        [new Date().toISOString().split('T')[0]]
      );

      // Bills due today/tomorrow
      const twoDaysFromNow = nowTs + (2 * 86400);
      const dueBills = all(
        'SELECT name, amount, next_renewal FROM subscriptions WHERE next_renewal >= ? AND next_renewal <= ?',
        [todayStart, twoDaysFromNow]
      );

      // Habits not yet done today
      const habits = all('SELECT id, name, icon FROM habits');
      const todayDate = new Date().toISOString().split('T')[0];
      const undoneHabits = habits.filter(h => {
        const log = get('SELECT done FROM habit_log WHERE habit_id = ? AND date = ?', [h.id, todayDate]);
        return !log || !log.done;
      });

      return {
        priorities: priorities.slice(0, 3),
        meetings,
        focusMinutes: Math.round((focusToday?.minutes || 0) / 60),
        dueBills,
        undoneHabits: undoneHabits.slice(0, 3),
        totalTasks: priorities.length,
      };
    } catch (err) {
      console.error('[IPC] get-morning-ritual error:', err);
      return { priorities: [], meetings: [], focusMinutes: 0, dueBills: [], undoneHabits: [], totalTasks: 0 };
    }
  });

  // ── Mail: Extract Unsubscribe Link ──
  ipcMain.handle('get-unsubscribe-link', async (_event, messageId) => {
    try {
      const email = get('SELECT body_preview, unsubscribe_link FROM email_cache WHERE message_id = ?', [messageId]);
      if (!email) return { link: null };

      // If already extracted, return it
      if (email.unsubscribe_link) return { link: email.unsubscribe_link };

      // Try to extract from body
      const body = email.body_preview || '';
      const unsubPatterns = [
        /https?:\/\/[^\s"'<>]*unsubscribe[^\s"'<>]*/i,
        /https?:\/\/[^\s"'<>]*opt[_-]?out[^\s"'<>]*/i,
        /https?:\/\/[^\s"'<>]*remove[^\s"'<>]*/i,
        /https?:\/\/[^\s"'<>]*manage[_-]?preferences[^\s"'<>]*/i,
      ];

      let link = null;
      for (const pattern of unsubPatterns) {
        const match = body.match(pattern);
        if (match) { link = match[0]; break; }
      }

      // Cache it for future use
      if (link) {
        run('UPDATE email_cache SET unsubscribe_link = ? WHERE message_id = ?', [link, messageId]);
      }

      return { link };
    } catch (err) {
      console.error('[IPC] get-unsubscribe-link error:', err);
      return { link: null };
    }
  });

  // ── Ghost feature handlers removed (P7-3) ──
  // Contacts CRM, Time Tracking, Reading List, Health Tracking, Travel, Meeting Prep
  // handlers have been removed — no UI exists for these features.
  // Data tables are preserved; handlers will be re-added when a surface is built.

  // ── WhatsApp Briefing (Twilio-powered) ──

  ipcMain.handle('send-whatsapp-briefing', async () => {
    try {
      const sid = getSetting('twilio_sid');
      const authToken = getSetting('twilio_auth_token');
      const fromNumber = getSetting('twilio_whatsapp_from');
      const toNumber = getSetting('whatsapp_phone');
      if (!sid || !authToken || !toNumber) return { error: 'WhatsApp not configured. Set Twilio credentials in Settings.' };

      // Generate briefing text
      const briefing = await require('../services/briefing').generateBriefing?.() || {};
      const now = new Date();
      const hour = now.getHours();
      const greeting = hour < 12 ? 'morning' : hour < 17 ? 'afternoon' : 'evening';

      // Get urgent items
      const overdue = all('SELECT title FROM reminders WHERE completed = 0 AND due_at < ? ORDER BY due_at LIMIT 3', [nowUnix()]);
      const urgentEmails = all(`SELECT subject FROM email_cache WHERE json_extract(smart_action, '$.priority_score') >= 80 AND archived IS NULL LIMIT 3`);

      let msg = `🌅 Good ${greeting}!\n\n`;
      if (overdue.length > 0) {
        msg += `🔍 URGENT (${overdue.length}):\n${overdue.map(t => `⚠ ${t.title}`).join('\n')}\n\n`;
      }
      if (urgentEmails.length > 0) {
        msg += `📬 Priority emails:\n${urgentEmails.map(e => `📧 ${e.subject}`).join('\n')}\n\n`;
      }
      if (briefing.priority_action) {
        msg += `💡 ${briefing.priority_action}\n\n`;
      }
      msg += `Open ARIA for full briefing 📊`;

      // Send via Twilio
      const https = require('https');
      const data = new URLSearchParams({
        From: `whatsapp:${fromNumber || '+14155238886'}`,
        To: `whatsapp:${toNumber}`,
        Body: msg
      }).toString();

      return new Promise((resolve) => {
        const req = https.request({
          hostname: 'api.twilio.com',
          path: `/2010-04-01/Accounts/${sid}/Messages.json`,
          method: 'POST',
          auth: `${sid}:${authToken}`,
          headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': data.length }
        }, (res) => {
          let body = '';
          res.on('data', d => body += d);
          res.on('end', () => {
            try {
              const json = JSON.parse(body);
              resolve({ success: !!json.sid, messageSid: json.sid, error: json.message });
            } catch (_) { resolve({ success: false, error: 'Parse error' }); }
          });
        });
        req.on('error', (e) => resolve({ success: false, error: e.message }));
        req.write(data);
        req.end();
      });
    } catch (err) { console.error('[IPC] send-whatsapp error:', err); return { error: err.message }; }
  });

  ipcMain.handle('send-whatsapp-test', async () => {
    try {
      const phone = getSetting('whatsapp_phone');
      if (!phone) return { error: 'No WhatsApp number configured' };
      // Use simple URL scheme for testing
      const msg = encodeURIComponent('✅ ARIA WhatsApp test successful! Your briefings will arrive here.');
      const { shell } = require('electron');
      shell.openExternal(`https://wa.me/${phone.replace(/[^0-9]/g, '')}?text=${msg}`);
      return { success: true };
    } catch (err) { return { error: err.message }; }
  });

  ipcMain.handle('get-whatsapp-status', async () => {
    try {
      const phone = getSetting('whatsapp_phone');
      const sid = getSetting('twilio_sid');
      const enabled = getSetting('whatsapp_enabled');
      return { configured: !!(phone && sid), enabled: enabled === 'true', phone };
    } catch (err) { return { configured: false, enabled: false }; }
  });
}

// ── App Lifecycle ──

// ── Background autonomous sync ──────────────────────────────────────────
// Runs email fetch + financial extraction every 15 min automatically.
// This is what makes ARIA autonomous — no manual scans needed.

let _bgSyncTimer = null;

async function runBackgroundSync() {
  try {
    // 1. Fetch new emails (Gmail REST preferred, IMAP fallback)
    let result;
    if (gmailService && gmailService.isGmailConfigured()) {
      result = await gmailService.fetchEmails();
    } else {
      return; // Gmail not configured — skip auto-sync
    }

    const newCount = result?.emails?.length || 0;
    console.log(`[AutoSync] Fetched ${newCount} emails`);

    // 1b. Categorize uncategorized emails (non-blocking Ollama/heuristics)
    if (gmailService && gmailService.categorizeEmails) {
      try {
        const catResult = await gmailService.categorizeEmails(() => {});
        if (catResult.categorized > 0) {
          console.log(`[AutoSync] Categorized ${catResult.categorized} emails`);
        }
      } catch (err) {
        console.warn('[AutoSync] Categorization error:', err.message);
      }
    }

    // 2. Proactive intelligence routing: emails → Tasks / Money
    try {
      await routeEmailInsights();
    } catch (err) {
      console.warn('[AutoSync] routeEmailInsights error:', err.message);
    }

    // 3. Invalidate briefing cache so next Today load picks up fresh emails
    if (newCount > 0) {
      try { saveSetting('briefing_stale', '1'); } catch (_) {}
    }

    // 3b. Incremental vector indexing (P2-5) — index new emails into ChromaDB
    if (newCount > 0 && _pythonProc) {
      try {
        const { app: electronApp } = require('electron');
        const appData = electronApp.getPath('userData');
        const newEmails = (result?.emails || []).slice(0, 50);
        for (const e of newEmails) {
          const text = `${e.subject || ''} ${(e.body_preview || '').slice(0, 300)}`.trim();
          if (!text) continue;
          callPython('index', {
            db_dir: appData + '/vectors',
            doc_type: 'email',
            doc_id: `email-${e.message_id || e.id}`,
            text,
          }).catch(() => {});
        }
      } catch (_) {}
    }

    // 3c. Recompute behavior metrics (rolling averages, anomaly detection)
    try {
      if (intelligenceService) {
        intelligenceService.computeBehaviorMetrics();
      }
    } catch (_) {}

    // 4. Notify renderer that new emails arrived (if window is open)
    if (newCount > 0 && mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('emails-updated', { count: newCount });
    }

    // 5. P10-3: Run relationship analysis on new emails
    try {
      const { analyzeRelationships: analyzeRel } = (() => {
        // analyzeRelationships is defined inside registerIpcHandlers closure,
        // so we call it via the IPC handle directly
        return { analyzeRelationships: null };
      })();
      // We'll use the db directly since functions are in main scope
      // Relationship analysis runs via IPC trigger or on-demand
    } catch (_) {}

    // 6. P10-5: Snapshot weekly outcome on Mondays
    try {
      const dayOfWeek = new Date().getDay();
      if (dayOfWeek === 1) { // Monday
        const lastSnapshot = getSetting('last_outcome_snapshot');
        const today = new Date().toISOString().split('T')[0];
        if (lastSnapshot !== today) {
          saveSetting('last_outcome_snapshot', today);
        }
      }
    } catch (_) {}

    // 7. Automation rules — evaluate all triggers (Zapier replacement)
    try {
      if (automationRulesService) await automationRulesService.evaluate();
    } catch (err) {
      console.warn('[AutoSync] automation rules error:', err.message);
    }

    // 8. Goal progress check — runs silently, sends proactive alerts if any goal is at risk
    try {
      if (goalsService) {
        const goalAlerts = await goalsService.checkAllGoals(
          aiService ? aiService.aiCall.bind(aiService) : null
        );
        if (goalAlerts.length > 0 && mainWindow && !mainWindow.isDestroyed()) {
          for (const alert of goalAlerts) {
            mainWindow.webContents.send('proactive-message', { text: alert, type: 'goal-alert' });
          }
          console.log(`[AutoSync] Goal alerts sent: ${goalAlerts.length}`);
        }
      }
    } catch (err) {
      console.warn('[AutoSync] goal check error:', err.message);
    }

    // 9. Prune old route signals (keep last 30 days only)
    try {
      const pruneThreshold = Math.floor(Date.now() / 1000) - 30 * 86400;
      run(`DELETE FROM route_signals WHERE created_at < ?`, [pruneThreshold]);
    } catch (_) {}

  } catch (err) {
    console.warn('[AutoSync] Sync error (non-fatal):', err.message);
  }
}

function startBackgroundSync() {
  // First run: after 25 seconds (let app fully boot)
  setTimeout(() => {
    runBackgroundSync();
    // Then every 5 minutes
    _bgSyncTimer = setInterval(runBackgroundSync, 5 * 60 * 1000);
    console.log('[AutoSync] Background email sync started — every 5 min');
  }, 25000);
}

// ── Phase E: Ollama health check at startup ──────────────────────────────────
async function checkOllamaAtStartup() {
  const http = require('http');
  try {
    await new Promise((resolve, reject) => {
      const req = http.get('http://127.0.0.1:11434/api/tags', { timeout: 4000 }, (res) => {
        let data = '';
        res.on('data', c => data += c);
        res.on('end', () => {
          try {
            const json = JSON.parse(data);
            const models = json.models?.map(m => m.name) || [];
            console.log(`[Ollama] Online — ${models.length} model(s): ${models.slice(0, 3).join(', ')}`);
            if (mainWindow && !mainWindow.isDestroyed()) {
              mainWindow.webContents.send('ollama-status', { online: true, models });
            }
            resolve();
          } catch { resolve(); }
        });
      });
      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    });
  } catch {
    console.warn('[Ollama] NOT REACHABLE — AI features degraded');
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('ollama-status', { online: false, models: [] });
    }
  }
}

// ── Phase C: Proactive push alert (every 30 min) ─────────────────────────────
const _shownProactiveIds = new Set();
let _proactivePushTimer = null;

async function runProactivePush() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (!intelligenceService) return;
  try {
    const dbPath = require('electron').app.getPath('userData') + '/aria.db';
    const insights = await intelligenceService.getProactiveInsights?.({ get, all }, dbPath);
    if (!insights || !Array.isArray(insights)) return;
    for (const insight of insights) {
      const key = insight.id || insight.title || JSON.stringify(insight);
      if (_shownProactiveIds.has(key)) continue;
      if (insight.severity === 'critical' || insight.severity === 'high' || insight.priority >= 70) {
        _shownProactiveIds.add(key);
        mainWindow.webContents.send('proactive-alert', insight);
        // Cap shown set at 100 to avoid memory bloat
        if (_shownProactiveIds.size > 100) {
          const [first] = _shownProactiveIds;
          _shownProactiveIds.delete(first);
        }
      }
    }
  } catch (err) {
    console.warn('[ProactivePush] error:', err.message);
  }
}

function startProactivePush() {
  // First check after 3 min (let data load)
  setTimeout(() => {
    runProactivePush();
    _proactivePushTimer = setInterval(runProactivePush, 30 * 60 * 1000);
    console.log('[ProactivePush] Started — every 30 min');
  }, 3 * 60 * 1000);
}

// ── Phase G: Behavior metrics 24-hour schedule ───────────────────────────────
function startBehaviorMetricsSchedule() {
  // Run once after 60s (let DB warm up), then every 24h
  setTimeout(() => {
    try { if (intelligenceService) intelligenceService.computeBehaviorMetrics?.(); } catch (_) {}
    setInterval(() => {
      try { if (intelligenceService) intelligenceService.computeBehaviorMetrics?.(); } catch (_) {}
    }, 24 * 60 * 60 * 1000);
    console.log('[BehaviorMetrics] 24h schedule started');
  }, 60 * 1000);
}

app.whenReady().then(async () => {
  // Auto-start on Windows boot
  app.setLoginItemSettings({
    openAtLogin: true,
    path: app.getPath('exe'),
    args: ['--hidden']
  });
  console.log('[ARIA] Auto-start configured');

  // Start Python sidecar (P2-1)
  try {
    startPythonSidecar();
    console.log('[ARIA] Python sidecar starting...');
  } catch (err) {
    console.warn('[ARIA] Python sidecar failed to start (non-fatal):', err.message);
  }

  // Initialize database first
  initDatabase();
  console.log('[ARIA] Database initialized');

  // Load services after DB is ready
  aiService = require('../services/ai.js');
  gmailService = require('../services/gmail.js');
  calendarService = require('../services/calendar.js');
  remindService = require('../services/remind.js');
  briefingService = require('../services/briefing.js');
  weatherService = require('../services/weather.js');
  habitsService = require('../services/habits.js');
  focusService = require('../services/focus.js');
  weeklyReportService = require('../services/weekly-report.js');
  nlQueryService = require('../services/nl-query.js');
  analyticsService = require('../services/analytics.js');
  calendarIntelService = require('../services/calendar-intel.js');
  financialIntel = require('../services/financial-intel.js');
  intelligenceService = require('../services/intelligence.js');
  responseCacheService = require('../services/response-cache.js');
  console.log('[ARIA] Response cache initialized');
  memoryExtractService = require('../services/memory-extract.js');
  memoryExtractService.init(require('../db/index.js'));
  console.log('[ARIA] Memory extract service initialized');
  automationRulesService = require('../services/automation-rules.js');
  automationRulesService.init(
    require('../db/index.js'),
    ({ type, title, message, severity, ruleId }) => {
      // Push automation notification to renderer (chat panel + tray badge)
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('automation-notification', { type, title, message, severity, ruleId });
      }
    }
  );
  console.log('[ARIA] Automation rule engine initialized');
  goalsService = require('../services/goals.js');
  console.log('[ARIA] Goal layer initialized');
  try {
    const keytar = require('keytar');
    const gmailOAuthSvc = require('../services/gmail-oauth.js');
    // Try keytar first (already migrated)
    let refreshToken = await keytar.getPassword('aria-bot', 'gmail-refresh-token');
    if (!refreshToken) {
      // Migration: check DB for legacy plaintext token
      const dbToken = getSetting('gmail_refresh_token');
      if (dbToken) {
        await keytar.setPassword('aria-bot', 'gmail-refresh-token', dbToken);
        run("DELETE FROM settings WHERE key = 'gmail_refresh_token'");
        refreshToken = dbToken;
        console.log('[Security] Gmail refresh token migrated from DB to keytar');
      }
    }
    if (refreshToken) {
      gmailOAuthSvc.injectRefreshToken(refreshToken);
      console.log('[Security] Gmail refresh token loaded from keytar');
    }
  } catch (ktErr) {
    // keytar unavailable (e.g. dev machine without secret service) — use DB fallback
    console.warn('[Security] keytar unavailable, using DB fallback for refresh token:', ktErr.message);
    try {
      const gmailOAuthSvc = require('../services/gmail-oauth.js');
      const dbToken = getSetting('gmail_refresh_token');
      if (dbToken) gmailOAuthSvc.injectRefreshToken(dbToken);
    } catch (_) {}
  }

  // Register IPC handlers
  registerIpcHandlers();

  // Create window
  createWindow();

  // Create system tray
  tray = createTray(toggleWindow);

  // Register global shortcut: Ctrl+Shift+A
  globalShortcut.register('Ctrl+Shift+A', toggleWindow);
  console.log('[ARIA] Global shortcut Ctrl+Shift+A registered');

  // Load and reschedule existing reminders
  try {
    remindService.loadAndReschedule();
    console.log('[ARIA] Reminders rescheduled');
  } catch (err) {
    console.error('[ARIA] Failed to reschedule reminders:', err);
  }

  // Schedule morning briefing
  try {
    briefingService.scheduleBriefing();
    console.log('[ARIA] Morning briefing scheduled');
  } catch (err) {
    console.error('[ARIA] Failed to schedule briefing:', err);
  }

  // Schedule habit evening reminder
  try {
    habitsService.scheduleHabitReminder();
  } catch (err) {
    console.error('[ARIA] Failed to schedule habit reminder:', err);
  }

  // Link calendar events to tasks (Calendar Intelligence)
  try {
    calendarIntelService.linkCalendarToTasks();
    console.log('[ARIA] Calendar-task linking complete');
  } catch (err) {
    console.error('[ARIA] Calendar-task link error:', err);
  }

  // Start autonomous background email + financial sync
  startBackgroundSync();

  // Phase E: Ollama health check — run after window is ready (2s delay)
  setTimeout(checkOllamaAtStartup, 2000);

  // Phase C: Proactive push alerts every 30 min
  startProactivePush();

  // Phase G: Behavior metrics on 24h schedule
  startBehaviorMetricsSchedule();
});

app.on('window-all-closed', () => {
  // On Windows, keep app running in tray
  // Do not quit
});

app.on('before-quit', () => {
  app.isQuitting = true;
  globalShortcut.unregisterAll();
  stopPythonSidecar();
  closeDb();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});
