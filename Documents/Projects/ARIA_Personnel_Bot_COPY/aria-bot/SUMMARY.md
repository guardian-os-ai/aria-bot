# ARIA — Personal AI Bot for Windows

## Overview
ARIA is a floating Windows overlay bot — a 348px wide chat-style window that sits bottom-right on screen, always on top. It replaces the need to switch between Gmail, calendar apps, and reminder apps. Everything is accessible from a single chat-like interface.

## How to Run

### Prerequisites
1. **Node.js 18+** installed
2. **Visual Studio Build Tools** — Required for native modules (better-sqlite3, keytar):
   ```bash
   npm install -g windows-build-tools
   # OR install "Desktop development with C++" workload from Visual Studio Installer
   ```

### Setup
```bash
cd aria-bot
npm install                      # Install all dependencies (native modules need VS Build Tools)
npx electron-rebuild             # Rebuild native modules for Electron
node assets/generate-icons.js    # Generate placeholder icons (already done)
npm run dev                      # Launch in development mode
```

### If native modules fail
```bash
npm install --ignore-scripts     # Install JS deps without building native
npx electron-rebuild             # Then rebuild for Electron specifically
```

**Keyboard shortcut:** `Ctrl+Shift+A` toggles the ARIA window visibility.

---

## Files Created

### Project Root
| File | Purpose |
|---|---|
| `package.json` | Dependencies and scripts |
| `electron.vite.config.js` | electron-vite build config (main + preload + renderer) |
| `tailwind.config.js` | Tailwind CSS with ARIA color palette |
| `postcss.config.js` | PostCSS with Tailwind + Autoprefixer |
| `index.html` | HTML entry point for the renderer |
| `SUMMARY.md` | This file |

### Electron Main Process (`electron/`)
| File | Purpose |
|---|---|
| `electron/main.js` | BrowserWindow config, IPC handlers, global shortcut, tray |
| `electron/tray.js` | System tray icon + context menu (Show/Hide, Settings, Quit) |
| `electron/preload.js` | Secure contextBridge IPC bridge → `window.aria` API |

### React Renderer (`src/`)
| File | Purpose |
|---|---|
| `src/main.jsx` | ReactDOM entry point |
| `src/App.jsx` | Root component: title bar, pill nav, panel routing |
| `src/index.css` | Tailwind directives + custom animation keyframes |

### Components (`src/components/`)
| File | Purpose |
|---|---|
| `BotHeader.jsx` | Avatar, name "ARIA", online dot, settings button |
| `PillNav.jsx` | Tab navigation: Today, Mail, Tasks, Ask, Settings |
| `ChatArea.jsx` | Scrollable message list with auto-scroll |
| `MessageBubble.jsx` | Bot and user message bubbles + typing indicator |
| `EmbedCard.jsx` | Rich cards embedded in chat (mail, briefing, reminders) |
| `InputBar.jsx` | Textarea + send button + quick chips |

### Panels (`src/components/panels/`)
| File | Purpose |
|---|---|
| `Today.jsx` | Morning briefing panel — stats, priority action, timeline |
| `Mail.jsx` | Email digest — categorised by urgent/action/fyi/done |
| `Remind.jsx` | Reminders + tasks — natural language input, overdue/upcoming |
| `Ask.jsx` | Chat interface with ARIA — AI-powered responses |
| `Settings.jsx` | Configuration: API key, email IMAP, calendar, weather, briefing time |

### Hooks (`src/hooks/`)
| File | Purpose |
|---|---|
| `useIPC.js` | Safe wrapper for all `window.aria.*` IPC calls |
| `useChat.js` | Chat message state + send logic for Ask panel |

### Backend Services (`services/`)
| File | Purpose |
|---|---|
| `ai.js` | **AI Router** — routes tasks to Ollama (local) or Haiku (cloud) |
| `ollama.js` | Ollama client — localhost:11434, health check, fallback |
| `haiku.js` | Claude Haiku client — Anthropic SDK, caching, token limits, daily cap |
| `mail.js` | IMAP email client — fetch, categorise, summarise |
| `calendar.js` | iCal parser — fetch .ics URL, cache events |
| `remind.js` | Reminders — parse NL, schedule with node-schedule, fire toasts |
| `briefing.js` | Morning briefing — assemble context, generate via Haiku, schedule |
| `weather.js` | Open-Meteo weather — free API, 1-hour cache, auto-detect location |

### Database (`db/`)
| File | Purpose |
|---|---|
| `schema.sql` | All CREATE TABLE statements (reminders, email_cache, calendar_events, ai_usage, settings, notes) |
| `index.js` | SQLite connection (better-sqlite3), migration runner, CRUD helpers |

### Assets (`assets/`)
| File | Purpose |
|---|---|
| `tray.png` | 16×16 placeholder tray icon |
| `icon.png` | 32×32 placeholder notification icon |
| `generate-icons.js` | Script to regenerate placeholder icons |

---

## What Needs User Setup

After running `npm install` and `npm run dev`, configure in the **Settings** panel:

### Required for AI Features
- **Claude API Key** — Get from [console.anthropic.com](https://console.anthropic.com). Model used: `claude-haiku-4-5-20251001` only.

### Required for Email Digest
- **IMAP Host** — e.g., `imap.gmail.com`
- **IMAP Port** — `993` (default with TLS)
- **Username** — Your email address
- **Password** — App Password (for Gmail: myaccount.google.com → Security → App Passwords)
- **TLS** — Enabled by default

### Required for Calendar
- **iCal URL** — Your calendar's .ics URL (Google Calendar: Settings → Calendar → Secret address in iCal format)

### Optional
- **City / Latitude / Longitude** — For weather. Auto-detected from IP if not set.
- **Briefing Time** — When to generate morning briefing (default: 09:00)
- **Ollama** — Install and run [Ollama](https://ollama.com) locally for free AI classification. Models: `llama3.2:3b`, `phi3:mini`. Falls back to Haiku if not running.

---

## Architecture

### AI Routing
```
Task            → Primary         → Fallback
─────────────────────────────────────────────
categorise      → Ollama (llama3.2:3b)  → Haiku
parse           → Ollama (phi3:mini)     → Haiku
intent          → Ollama                 → Haiku
summarise       → Haiku (always)
briefing        → Haiku (always)
chat            → Haiku (always, 20/day cap)
```

### Daily Limits
- **20 Haiku calls/day** — tracked in `ai_usage` table, resets at midnight
- **2000 tokens max input** — truncated before sending
- **500 tokens max output** — enforced per call
- Prompt caching enabled via `cache_control: {type: 'ephemeral'}`

### Data Storage
- SQLite database at `%APPDATA%/aria-bot/aria.db`
- API key stored in Windows Credential Store (keytar), with settings DB fallback
- Weather cached for 1 hour
- Briefing cached for 4 hours
- Email results cached indefinitely (refreshed on demand)

---

## Known Limitations (Phase 1)

1. **No email sending** — IMAP is read-only. ARIA categorises and summarises but cannot reply.
2. **No Outlook / Exchange** — Only standard IMAP servers supported. OAuth2 not implemented.
3. **Ollama models not auto-downloaded** — User must `ollama pull llama3.2:3b` and `ollama pull phi3:mini` manually.
4. **Reminder parsing quality** — Depends on AI availability. Manual fallback parser handles basic patterns only.
5. **No encryption at rest** — SQLite is unencrypted. Phase 2 adds SQLCipher via `@journeyapps/sqlcipher`.
6. **Single window position** — Always bottom-right. No drag-to-reposition yet.
7. **No auto-update** — Manual rebuild required for updates.
8. **keytar may need rebuild** — Native module. Run `npm rebuild keytar` if it fails.
9. **better-sqlite3 may need rebuild** — Run `npx electron-rebuild` if DB init fails.
10. **Toast notifications** — `node-notifier` on Windows uses PowerShell toasts. Action buttons (Done/Snooze) may not work on all Windows versions.

---

## Phase 2 Features (Not Implemented)

- 🔥 Habits tracking with streak counters
- 🎯 Focus mode with hosts-file blocking
- 🗑 File cleanup scanner
- 📋 Clipboard monitoring
- 💸 Bills / finance tracking
- 📊 System stats
- 📰 News digest
- 📦 Package tracking
- 🔒 SQLCipher encryption
- 🔐 OAuth2 for Gmail/Outlook

---

## Tech Stack

| Component | Technology |
|---|---|
| Desktop | Electron v28+ with electron-vite |
| UI | React 18 + Tailwind CSS v3 |
| Database | better-sqlite3 (SQLCipher ready) |
| Scheduling | node-schedule |
| Notifications | node-notifier |
| Secrets | keytar (Windows Credential Store) |
| Email | imap + mailparser |
| Calendar | node-ical |
| Weather | Open-Meteo API (free, no key) |
| AI Local | Ollama (localhost:11434) |
| AI Cloud | @anthropic-ai/sdk (claude-haiku-4-5-20251001) |
| HTTP | axios |
| Icons | lucide-react |
