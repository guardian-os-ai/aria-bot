# ARIA Constitution
### Single Source of Truth — Project Decisions, Features, and Rules

> **Last updated:** 2026-02-24  
> **Version:** 3.0 (Phase 3 — All Tier 2 & 3 intelligence features implemented)

This document records every architectural decision, feature contract, AI rule, and future task for ARIA. All agents and developers must read this before making changes. 

**MANDATORY RULE:** Every code change, feature addition, UI modification, or architectural decision MUST be documented in this CONSTITUTION.md file. Update the Change Log at the bottom with date, author, and a brief description. This prevents the need to scan the entire codebase to understand recent changes.

---

## 1. Project Identity

| Property | Value |
|---|---|
| **Name** | ARIA — Personal AI Bot for Windows |
| **Window size** | 348 × 620 px |
| **Position** | Always bottom-right, always on top, frameless, transparent |
| **Shortcut** | `Ctrl+Shift+A` — toggle visibility; `Ctrl+1-5` panel switch; `Ctrl+K` search; `Ctrl+/` Ask |
| **DB location** | `%APPDATA%\Electron\aria.db` (dev) / `%APPDATA%\aria-bot\aria.db` (prod) |
| **Tray** | System tray icon with Show/Hide, Settings, Quit |

---

## 2. Tech Stack (Locked for Phase 1)

| Layer | Technology | Notes |
|---|---|---|
| Desktop shell | Electron v28 + electron-vite | CJS main, ESM renderer |
| UI | React 18 + Tailwind CSS v3 | Dark/Light theme toggle, custom color tokens |
| DB | better-sqlite3 | Sync SQLite — no async DB calls |
| Secrets | keytar (Windows Credential Store) | Falls back to settings DB if keytar fails |
| Email | `imap` + `mailparser` | Read-only IMAP; supports App Password or OAuth2 XOAUTH2 for Gmail |
| Email OAuth2 | `services/gmail-oauth.js` | Google OAuth2 with local HTTP callback server (port 17995) |
| Calendar | `node-ical` | Fetches .ics URL |
| Weather | Open-Meteo (free, no key) | Auto-detects location via ipapi.co |
| Scheduling | `node-schedule` | Reminders + morning briefing |
| Notifications | `node-notifier` | Windows toast notifications |
| AI local | Ollama (`llama3.2:3b`, `phi3:mini`) | Free, offline |
| AI cloud | Gemini 2.0 Flash Lite via OpenAI SDK | Free tier; keytar account `gemini-api-key` |
| HTTP | axios | External API calls |
| Icons | lucide-react | UI icons only |

---

## 3. AI Routing Rules (CRITICAL — Do Not Change Without Note)

```
Task            → Primary                   → Fallback
────────────────────────────────────────────────────────────
categorise      → Ollama (llama3.2:3b)      → Grok → Gemini Flash-Lite
parse reminder  → Ollama (phi3:mini)         → Grok → Gemini Flash-Lite
intent classify → Ollama                     → Grok → Gemini Flash-Lite
analyse email   → Ollama                     → Grok → Gemini Flash-Lite
summarise       → Gemini Flash-Lite          → Grok → plain attribution
briefing        → Gemini Flash-Lite          → Grok → error
chat            → Ollama (llama3.2:3b)       → Grok → Gemini Flash-Lite
reminder detect → Gemini Flash-Lite (chat)   → null (silent fail)
```

**Hard limits (services/haiku.js — applies to Gemini calls):**
- Max 2000 tokens input (truncated before sending)
- Max 500 tokens output
- Max 20 AI calls/day (tracked in `ai_usage` table, resets at midnight)
- Never call AI for `noise` emails
- Never call AI for `fyi` summaries — use `"From Name: Subject"` locally

**API key storage:**
- Gemini API key: Service `aria-bot` | Account `gemini-api-key` (keytar)
- Grok API key: Service `aria-bot` | Account `grok-api-key` (keytar)
- DB fallback keys: `gemini_api_key_fallback` and `grok_api_key_fallback` (settings table)
- Get Gemini key at: https://aistudio.google.com/apikey
- Get Grok key at: https://console.x.ai

---

## 4. Database Schema

### Tables

| Table | Purpose |
|---|---|
| `reminders` | Saved reminders with scheduling fields (+ `completed_at`, `archived_at` columns) |
| `email_cache` | Fetched + processed emails (includes `reminder_opportunity` JSON column) |
| `calendar_events` | Cached iCal events |
| `ai_usage` | Per-call logging: provider, task, tokens, date |
| `settings` | Key/value store for all user config |
| `notes` | Quick notes with optional JSON tags array |
| `chat_messages` | Persistent chat history (role: user/bot, text, created_at) |
| `streaks` | Daily login tracking for streak counter (date TEXT PRIMARY KEY) |

### email_cache columns (Phase 1 + migration)
```
message_id, from_name, from_email, subject, body_preview,
summary, category, received_at, cached_at,
reminder_opportunity  ← added by migration in db/index.js
```

### Migration strategy
- Schema uses `CREATE TABLE IF NOT EXISTS` (safe re-run)
- Column additions use `ALTER TABLE … ADD COLUMN` in `db/index.js initDatabase()` inside try/catch (ignored if column exists)

---

## 5. Email Pipeline (services/mail.js)

### Fetch flow
1. Open IMAP `INBOX` in read-only mode
2. Search `UNSEEN SINCE yesterday`, take last 30
3. Parse each message: `message_id`, `from_name`, `from_email`, `subject`, `body_preview` (500 chars), `received_at`
4. Parse raw headers for noise detection (before AI)

### Noise pre-filter (zero AI cost)
Mark as `noise` if ANY of:
- `List-Unsubscribe` header exists
- `X-GM-LABELS` contains `\Promotions`, `\Social`, or `\Updates`
- `from_email` matches patterns: noreply, no-reply, newsletter, notifications, updates, promotions, marketing, mailer, automated, campaigns, info@, hello@, team@, digest@, mailchimp, sendgrid, mailgun
- `subject` (lowercase) contains: unsubscribe, sale, deal, % off, last day, limited time, exclusive offer, click here, explore now, webinar, last chance, free shipping, coupon, discount, promo code, newsletter, weekly digest

Noise emails: saved to DB with `category='noise'`, `summary=null`. Never shown in UI unless noise tab clicked. **No AI calls.**

### AI categorisation (5 per batch, 500ms between batches)
Prompt returns one word: `urgent | action | fyi | noise`. Falls back to `fyi` on error.

### Summarisation
- `urgent` / `action` → 2-sentence AI summary (Gemini)
- `fyi` → `"From {Name}: {Subject}"` — no AI call
- `noise` → nothing

### Reminder opportunity detection
After categorisation, check if email is about a payment/subscription (`payment`, `receipt`, `invoice`, `subscription`, `renewal`, `charged`, `billing`, `auto-renew`, etc.). If yes, call Gemini to extract `{ service_name, amount, currency, renewal_date }`. Store as JSON in `reminder_opportunity` column.

### Sort order returned to UI
`urgent` (newest-first) → `action` (newest-first) → `fyi` (newest-first). Noise excluded.

### Caching
- On error: return cached non-noise emails + noise count from DB
- On success: overwrite/upsert all fetched emails; mark last updated timestamp

### IMAP actions
- `markRead(messageId)` — STORE +FLAGS `\Seen`; update DB `category='done'`; fallback to DB-only if IMAP fails
- `deleteEmail(messageId)` — STORE +FLAGS `\Deleted` + EXPUNGE; DELETE from DB; fallback to DB-only

---

## 6. Email UI (src/components/panels/Mail.jsx)

### Header
- Left: `"{N} emails need attention"` (urgent + action count)
- Right: `Refresh` button
- Sub-text: noise count (`🔇 N filtered`), last updated time (cached data)

### Section layout
| Section | Color | Default | Condition |
|---|---|---|---|
| URGENT | Red | Always open | `urgent.length > 0` |
| ACTION NEEDED | Orange | Always open | `action.length > 0` |
| FYI | Blue | Collapsed | `fyi.length > 0` |
| Noise | Never shown | — | Shown only in header count |

### Email card (collapsed)
- Bold subject, sender name, time-ago, category badge
- Summary preview (1 line, truncated)
- Left border: red=urgent, orange=action, blue=fyi

### Email card (expanded — on click)
- Full 2-sentence summary in inset box
- Reminder opportunity pill (yellow) if `reminder_opportunity` exists
- Action buttons: `Mark Read` | `Open Gmail` | `Delete` | `Draft Reply` (urgent/action only)

### Actions
- **Mark Read** — calls `window.aria.markEmailRead(id)` → fade-out (150ms)
- **Open Gmail** — calls `window.aria.openInGmail(id)` → opens browser
- **Delete** — shows 3-second undo toast → calls `window.aria.deleteEmail(id)` → fade-out
- **Draft Reply** — calls `window.aria.draftReply(id, subject, fromEmail)` → opens Gmail compose

### Reminder pill
- Shows when `email.reminder_opportunity.shouldRemind === true`
- "🔔 Set renewal reminder for {service} on {date}?" + [Set Reminder] button
- On click: calls `window.aria.addReminder(suggestion)` → shows "✓ Reminder set for {date}"

### Inbox zero state
When all urgent + action cleared:
> ✨ Inbox zero on what matters. {N} promotions filtered. Good work.

### Loading state
3 skeleton card shimmer animations while fetching.

---

## 7. IPC Surface (window.aria)

All methods exposed via `electron/preload.js` contextBridge:

```js
// Reminders
window.aria.getReminders()
window.aria.getAllReminders()
window.aria.addReminder(text)
window.aria.completeReminder(id)
window.aria.archiveReminder(id)
window.aria.deleteReminder(id)
window.aria.updateReminder(id, title, dueAt)   // inline editing
window.aria.extendReminder(id, minutes)          // snooze/extend

// Emails
window.aria.getEmails()
window.aria.refreshEmails()
window.aria.markEmailRead(messageId)
window.aria.deleteEmail(messageId)
window.aria.openInGmail(messageId)
window.aria.draftReply(messageId, subject, fromEmail)
window.aria.aiDraftReply(subject, fromEmail, bodyPreview)  // AI-generated draft

// Briefing
window.aria.getBriefing()

// Chat (with intent routing + persistence)
window.aria.chat(message)                       // routes to actions or AI
window.aria.getChatHistory()
window.aria.saveChatMessage(role, text)
window.aria.clearChatHistory()

// Notes
window.aria.getNotes()
window.aria.addNote(content, tags)               // tags: string[] | null
window.aria.updateNote(id, content, tags)
window.aria.deleteNote(id)

// Streak
window.aria.getStreak()                          // records login + returns {streak: N}

// Settings
window.aria.getSettings()
window.aria.saveSetting(key, value)
window.aria.saveApiKey(key)     // saves Gemini key to keytar
window.aria.getApiKey()
window.aria.saveGrokApiKey(key)
window.aria.getGrokApiKey()

// Gmail OAuth2
window.aria.gmailOAuthStatus()                   // {configured: bool}
window.aria.gmailOAuthStart()                    // starts OAuth flow
window.aria.gmailOAuthDisconnect()               // clears tokens

// Weather + Calendar
window.aria.getWeather()
window.aria.getCalendarEvents()

// AI Usage
window.aria.getUsage()

// Ollama Status
window.aria.checkOllama()                        // {online: bool, models: string[]}

// Window
window.aria.closeWindow()
window.aria.minimizeWindow()
window.aria.toggleWindow()

// Events (from main → renderer)
window.aria.onNavigate(callback)                 // notification click routing

// Intelligence Features (Phase 3)
window.aria.getWeeklyReport()                    // 7-day productivity report (cached 12h)
window.aria.nlQuery(query)                       // NL data query → instant local answer
window.aria.getFocusAnalytics(days)              // Focus trends, productivity score 0-100
window.aria.getHabitAnalytics(days)              // Per-habit completion rates, streaks
window.aria.getProductivityCorrelation(days)     // Daily focus+tasks+habits overlay
window.aria.getCalendarIntelligence()            // Meeting prep, gaps, suggestions
window.aria.linkCalendarTasks()                  // Wire linked_calendar_event_id
```

---

## 8. Reminders System (services/remind.js)

- Natural language parsing via Ollama (`phi3:mini`) → Gemini fallback → manual regex fallback
- Stored in `reminders` table; scheduled via `node-schedule`
- On app start: `loadAndReschedule()` restores all incomplete reminders
- On fire: `node-notifier` Windows toast with actions: Done / Snooze 15m / Snooze 1h
- Recurring: `daily | weekly | monthly` — creates next occurrence on completion

---

## 9. Morning Briefing (services/briefing.js)

- Scheduled daily at `briefing_time` setting (default 09:00)
- Assembles: top urgent/action emails + today's calendar events + overdue reminders + weather
- Calls Gemini to generate structured JSON briefing
- Cached for 4 hours — re-used if re-requested within cache window
- Toast notification fires at scheduled time

---

## 10. Settings (src/components/panels/Settings.jsx)

**UI Behavior:**
- Single explicit "Save" button per Settings section (no per-field save buttons)
- API key fields show eye icon to toggle visibility
- Save button shows "Saved" state briefly after successful save
- Theme toggle button (Sun/Moon icon) is next to the Settings gear in `BotHeader`

**Theme System:**
- Dark theme (default): `#161616` background, light text
- Light theme: `#f5f5f5` background, dark text
- Persisted in localStorage as `aria-theme`
- Context provider: `src/context/ThemeContext.jsx`
- Toggle accessible from the main header on every panel
- `data-theme` root attribute + CSS light overrides keep legacy dark classes in sync

**Ask Panel UX:**
- Only one composer is visible (duplicate bottom input removed)
- Welcome copy is conversational and task-focused (less "AI-ish")
- Prompt chips are action-oriented and human-readable
- Message bubbles, chips, and input area follow active theme colors

**Font Sizes (Universal Increase):**
- Body text: 12-14px (was 10-12px)
- Headings: 14-18px (was 12-16px)
- Labels: 11-12px (was 9-10px)
- Captions: 10-11px (was 8-9px)

| Field | DB key | Notes |
|---|---|---|
| Gemini API Key | keytar `gemini-api-key` | Falls back to `gemini_api_key_fallback` |
| Grok API Key | keytar `grok-api-key` | Optional, falls back to `grok_api_key_fallback` |
| IMAP Host | `imap_host` | e.g. `imap.gmail.com` |
| IMAP Port | `imap_port` | Default 993 |
| IMAP User | `imap_user` | Email address |
| IMAP Password | `imap_password` | App Password for Gmail |
| IMAP TLS | `imap_tls` | Default `true` |
| Gmail Client ID | `gmail_client_id` | For OAuth2 (optional) |
| Gmail Client Secret | `gmail_client_secret` | For OAuth2 (optional) |
| Gmail Access Token | `gmail_access_token` | Auto-managed by OAuth2 flow |
| Gmail Refresh Token | `gmail_refresh_token` | Auto-managed by OAuth2 flow |
| Calendar iCal URL | `calendar_ical_url` | Google Calendar secret .ics URL |
| Weather Lat | `weather_lat` | Auto-detected if empty |
| Weather Lon | `weather_lon` | Auto-detected if empty |
| City | `weather_city` | Display name |
| Briefing Time | `briefing_time` | HH:MM, default `09:00` |

---

## 11. Known Limitations

1. No email sending — IMAP read-only; AI Draft Reply generates text, user copies to Gmail compose
2. ~~Gmail only with App Password~~ → OAuth2 now supported as optional auth method
3. Ollama models not auto-installed — user must run `ollama pull llama3.2:3b && ollama pull phi3:mini`
4. Noise filtering is heuristic-first then AI; edge cases may slip through
5. Reminder parsing quality depends on AI quality; manual regex handles basic patterns
6. No SQLCipher encryption — Phase 3
7. No drag-to-reposition window — Phase 3
8. Toast action buttons (Done/Snooze) may not work on all Windows versions (node-notifier limitation)
9. DB at `%APPDATA%\Electron\aria.db` in dev (Electron default); `aria-bot\aria.db` in prod

---

## 12. Phase 2 Features (Implemented)

| Feature | Status | Notes |
|---|---|---|
| Chat → Action routing | ✅ Done | Intent classification routes "remind me..." / "check email" / "weather" to services |
| Chat history persistence | ✅ Done | `chat_messages` DB table, loads on mount, clears via button |
| Notes panel | ✅ Done | Full CRUD with tags, EmbedCard design, 📝 Notes tab |
| Reminder editing | ✅ Done | Inline edit (title + datetime picker) + extend/snooze (15m/1h/3h/tomorrow) |
| Reminder UI reverted | ✅ Done | EmbedCard-based design with Overdue (red) / Upcoming (blue) sections |
| AI Draft Reply | ✅ Done | AI generates reply text, user copies to Gmail |
| OAuth2 Gmail | ✅ Done | Optional OAuth2 via Google Cloud Console; local HTTP callback on port 17995 |
| Streak tracking | ✅ Done | `streaks` table, consecutive days counter, shown in title bar (🔥 Day N) |
| Notification click → focus | ✅ Done | Window shows/focuses + navigates to relevant panel |
| Keyboard shortcuts | ✅ Done | Ctrl+1-5 panels, Ctrl+K search, Ctrl+/ Ask |
| Search modal | ✅ Done | Ctrl+K spotlight: searches reminders, notes, emails in real-time |
| Ollama status indicator | ✅ Done | BotHeader shows 🟢 Local (online) or ☁️ Cloud (offline), checks every 60s |
| Build fix | ✅ Done | `emptyOutDir: false` on preload config to prevent overwriting main.js |

---

## 12b. Intelligence & Monetization Roadmap

> Features planned and prioritized for making ARIA a paid product.
> Updated: 2026-02-24

### TIER 1 — "Instant Value" (Must-haves that sell the product)

| # | Feature | Status | Description |
|---|---------|--------|-------------|
| T1.1 | **Smart Money Dashboard** | ✅ Implemented | Dedicated Money panel showing all subscriptions, monthly spend, renewal countdowns, add/delete manual subs |
| T1.2 | **Priority Intelligence** | ✅ Implemented | Tasks sorted by `priority_score` (overdue→proximity→source bonus); color-coded priority badges (Critical/High/Medium/Low) |
| T1.3 | **Task Category Grouping** | ✅ Implemented | Tasks grouped by smart_action type (💳 Financial, 💼 Work, 🗣 Follow-up, 🤔 Decision, ✅ Tasks) with category headers |
| T1.4 | **Financial Summary in Today** | ✅ Implemented | Today panel shows subscription count, total monthly spend, and upcoming renewal alert |

### TIER 2 — "Intelligence Layer" (What makes people stay & pay)

| # | Feature | Status | Description |
|---|---------|--------|-------------|
| T2.1 | Email-to-Action Pipeline | ✅ Exists | Deadline extraction + cross-reference already creates tasks from emails |
| T2.2 | AI Weekly Report | ✅ Implemented | Auto-generated weekly summary: tasks completed, focus hours, habit streaks, money spent. Collapsible card in Today panel with AI-enhanced prose summary via Ollama→Grok→Gemini fallback. Cached 12h. |
| T2.3 | Smart Notifications with Context | ✅ Implemented | Rich toast: "💳 ARIA — Subscription Alert: GitHub Copilot renewal — ₹3,400 will be charged (monthly)". Cross-references subscriptions table for amounts, includes smart_action suggestions, meeting locations, subtitle context. |
| T2.4 | Natural Language Query Engine | ✅ Implemented | "What did I spend on subscriptions last month?" → instant answer from local SQLite. Integrated into chat handler — data queries bypass AI for instant response. Supports: spending, tasks, focus, habits, emails, calendar, stats queries with time range parsing (today/this week/last month etc). |

### TIER 3 — "Sticky Features" (Retention & differentiation)

| # | Feature | Status | Description |
|---|---------|--------|-------------|
| T3.1 | Focus Analytics Dashboard | ✅ Implemented | 14/30-day trends, productivity score (0-100), day-of-week patterns, mini bar chart, focus streak, best day tracking. Tabbed Analytics card in Today panel. |
| T3.2 | Habit Insights | ✅ Implemented | Per-habit completion rates, current/longest streak, trend indicators, progress bars, day-of-week analysis, best/worst habit callouts. Tabbed Analytics card in Today panel. |
| T3.3 | Privacy-First AI | ✅ Exists | Ollama-first, data never leaves machine unless user opts in to cloud |
| T3.4 | Calendar Intelligence | ✅ Implemented | Meeting prep with cross-referenced emails/tasks, gap detection (free slots between meetings), suggestions (focus session/task/break), linked_calendar_event_id auto-wiring on startup. Collapsible CalendarIntel card in Today panel. |
| T3.5 | Smart Note Tagging | 🔜 Phase 3 | Auto-tag notes via AI, cross-reference with tasks/emails |

### Monetization Tiers (Planned)

| Plan | Price | Includes |
|------|-------|----------|
| **Free** | ₹0 | 5 tasks, basic email view, 3 focus sessions/day, local AI only |
| **Pro** | ₹299/mo | Unlimited tasks, Smart Money Dashboard, Priority Intelligence, Habit Tracker, Weekly Reports |
| **Pro+** | ₹499/mo | Everything + Cloud AI (Grok/Gemini), Calendar Intelligence, NL Queries, PDF Export |

---

## 12c. Phase 3 Feature Backlog (Infrastructure)

> These are NOT implemented. Do not code these without updating this document.

| Feature | Priority | Notes |
|---|---|---|
| SMTP email sending (reply from ARIA) | High | Direct send via nodemailer |
| Focus mode (hosts-file blocking) | Medium | Admin permissions required |
| File cleanup scanner | Medium | |
| Clipboard monitoring | Medium | |
| System stats overlay | Low | CPU, RAM, disk |
| News digest | Low | RSS or News API |
| Package tracking | Low | Parcel API |
| SQLCipher encryption | High | Phase 3 security requirement |
| Drag-to-reposition window | Low | |
| Auto-update | Medium | electron-updater |
| Noise tab in Mail panel | Low | Show filtered promotions on demand |
| ARIA profile / avatar customisation | Low | |

---

## 13. Development Setup

```powershell
cd aria-bot
npm install --ignore-scripts         # Install JS deps (if no VS Build Tools)
npx electron-rebuild -f -w better-sqlite3,keytar  # Build native modules
node node_modules/electron/install.js             # Install Electron binary
npm run dev                                        # Start app
```

**If editing native modules only:**
```powershell
npx electron-rebuild -f -w better-sqlite3,keytar
```

**Keyboard shortcut:** `Ctrl+Shift+A` toggles ARIA window. `Ctrl+1-5` switches panels. `Ctrl+K` opens search. `Ctrl+/` opens Ask.

---

## 14. Dev Script (package.json)

```json
"dev": "cross-env ELECTRON_ENTRY=electron/main.js electron-vite dev"
```
`ELECTRON_ENTRY` bypasses electron-vite's pre-build file-existence check.

---

## Change Log

| Date | Author | Change |
|---|---|---|
| 2026-02-23 | Agent | Phase 1 scaffold complete — all services, DB, Electron shell, React UI |
| 2026-02-23 | Agent | Switched AI backend from Anthropic SDK to Gemini 2.0 Flash Lite (free tier) |
| 2026-02-23 | Agent | Fixed electron-vite dev startup (ELECTRON_ENTRY + binary install) |
| 2026-02-23 | Agent | Rewrote mail.js: noise pre-filter, batch categorisation, IMAP actions, reminder detection |
| 2026-02-23 | Agent | Rewrote Mail.jsx: category headers, expand/collapse, action buttons, reminder pill, skeleton loader |
| 2026-02-23 | Agent | Added IPC: mark-email-read, delete-email, open-in-gmail, draft-reply |
| 2026-02-23 | Agent | DB migration: added reminder_opportunity column to email_cache |
| 2026-02-23 | Agent | Created this CONSTITUTION.md |
| 2026-02-23 | Agent | Added Grok API as middle fallback layer (Ollama → Grok → Gemini) |
| 2026-02-23 | Agent | Removed duplicate Settings button from tab navigation (kept gear icon in header) |
| 2026-02-23 | Agent | Added explicit Save buttons to Settings panel (replaced auto-save on blur) |
| 2026-02-23 | Agent | Implemented light/dark theme toggle with localStorage persistence |
| 2026-02-23 | Agent | Increased all font sizes by 2-3px across entire UI for better readability |
| 2026-02-23 | Agent | Updated CONSTITUTION.md to document all architectural changes (this habit is now mandatory) |
| 2026-02-23 | Agent | Fixed Ask panel duplicate composer/input and simplified Ask UX copy/chips for a more human tone |
| 2026-02-23 | Agent | Moved theme toggle from Settings panel to BotHeader next to Settings icon |
| 2026-02-23 | Agent | Replaced unclear red/yellow/green title controls with explicit hide/minimize icon buttons |
| 2026-02-23 | Agent | Refactored Settings to section-level saves with one button per section and theme-consistent button styling |
| 2026-02-23 | Agent | Added global light-theme sync overrides for legacy hardcoded dark utility classes |
| 2026-02-23 | Agent | Hidden all visible scrollbars globally (width:0, scrollbar-width:none) — scroll via mouse only |
| 2026-02-23 | Agent | Fixed Tasks (Remind) panel: removed duplicate input bar (was rendered in both App.jsx and Remind.jsx), consolidated single input pinned to bottom |
| 2026-02-23 | Agent | Rebuilt Ask.jsx: pinned bottom typing bar with auto-expanding textarea (max 120px), scrollable chat area above, usage info + quick chips in footer |
| 2026-02-23 | Agent | Fixed bot overall border: replaced subtle inset box-shadow with explicit 1.5px solid border for clear visibility in both themes |
| 2026-02-23 | Agent | Made panel content wrapper a flex container (flex-col min-h-0) so Ask panel flex layout works correctly |
| 2026-02-23 | Agent | Removed unused InputBar import from App.jsx |
| 2026-02-23 | Agent | Full light mode fix: Remind.jsx, Today.jsx, Mail.jsx, EmbedCard.jsx — all components now use isDark conditional styling instead of hardcoded dark colors |
| 2026-02-23 | Agent | Remind.jsx: replaced basic input with auto-expanding textarea (matches Ask layout), added quick chips ("In 1 hour", "Tomorrow 9am", "End of day") |
| 2026-02-23 | Agent | Chat AI fallback chain: chat task now routes Ollama → Grok → Gemini (was Gemini-only before) via chatWithFallback() |
| 2026-02-23 | Agent | Summarise & briefing tasks now also fallback to Grok when Gemini 429s |
| 2026-02-23 | Agent | Categorise fallback: now catches ANY Ollama error (not just OllamaOfflineError) before falling to Grok → Gemini |
| 2026-02-23 | Agent | Fixed get-emails IPC: now returns {emails, noiseCount, cached, lastUpdated} instead of raw array; parses JSON fields (smart_action, reminder_opportunity); filters noise from response |
| 2026-02-23 | Agent | Updated Grok model list: added grok-3-mini, grok-2 models; improved model-not-found detection (handles 400/404 status codes) |
| 2026-02-23 | Agent | Today panel: stat cards now clickable (Urgent Emails → navigates to Mail), priority action card clickable, full theme support |
| 2026-02-23 | Agent | Mail.jsx: full rewrite with isDark prop threading to all sub-components (EmailCard, SectionLabel, SkeletonLoader, SetupCard) |
| 2026-02-24 | Agent | Added Intelligence & Monetization Roadmap to CONSTITUTION.md (Section 12b) — 3 tiers, 12 features, pricing plan |
| 2026-02-24 | Agent | Created Money panel (src/components/panels/Money.jsx) — full subscription dashboard with spend overview, renewal alerts, add/delete, ARIA insights |
| 2026-02-24 | Agent | Added `get-financial-summary` IPC handler in main.js — aggregates subscriptions table into monthlyTotal, yearlyTotal, upcomingRenewals, financeTaskCount |
| 2026-02-24 | Agent | Added `getFinancialSummary` to preload.js bridge |
| 2026-02-24 | Agent | Remind.jsx: added Timeline/Categories view toggle — category groups tasks by smart_action type (Financial/Work/Follow-up/Decision/Tasks) |
| 2026-02-24 | Agent | Remind.jsx: added priority badges (red/orange/yellow dots) based on priority_score; added purple/orange/green to SectionCard colors |
| 2026-02-24 | Agent | Today.jsx: added Financial Summary card — shows subscription count, monthly spend, nearest upcoming renewal; clickable → navigates to Money panel |
| 2026-02-24 | Agent | App.jsx: wired Money panel into navigation — lazy import, PANELS array (💳 Money), PANEL_ORDER, Ctrl+4 shortcut, render switch |
| 2026-02-24 | Agent | **Phase 3 — All 5 remaining intelligence features implemented:** |
| 2026-02-24 | Agent | **T2.2 AI Weekly Report:** Created `services/weekly-report.js` — aggregates 7-day data (tasks, focus, habits, money, emails, calendar, AI usage, streak), generates AI-enhanced prose summary with fallback. Added WeeklyReport.jsx collapsible card to Today panel. IPC: `get-weekly-report`. |
| 2026-02-24 | Agent | **T2.3 Smart Notifications:** Enhanced `services/remind.js` `fireReminder()` — builds context-rich messages by cross-referencing subscriptions (amounts), smart_action suggestions, subtitle, calendar event locations. Dynamic titles (💳 Subscription Alert / 📅 Meeting Prep / 🗣 Follow Up / 💰 Payment Due). |
| 2026-02-24 | Agent | **T2.4 NL Query Engine:** Created `services/nl-query.js` — pattern matching + SQL query builder for 7 domains (money, tasks, focus, habits, emails, calendar, stats) with time range parsing. Integrated into chat handler via `isDataQuery()` — data queries get instant 📊 answers, no AI needed. Added 'My spending' and 'Focus stats' chips to Ask panel. |
| 2026-02-24 | Agent | **T3.1+T3.2 Focus & Habit Analytics:** Created `services/analytics.js` — `getFocusAnalytics()` (productivity score 0-100, trend %, day-of-week patterns, focus streak), `getHabitAnalytics()` (per-habit completion rates, longest streak, trend indicators, best/worst day), `getProductivityCorrelation()`. Added AnalyticsDashboard.jsx tabbed card (Focus/Habits tabs) to Today panel with mini bar charts and progress rings. |
| 2026-02-24 | Agent | **T3.4 Calendar Intelligence:** Created `services/calendar-intel.js` — meeting prep (cross-references emails/tasks by keyword matching), gap detection (free slots ≥15min between meetings), suggestions (focus session/task/break recommendations), `linkCalendarToTasks()` auto-wires `linked_calendar_event_id`. Added CalendarIntel.jsx collapsible card to Today panel. Runs linking on app startup. |
| 2026-02-24 | Agent | Wired all 5 features into IPC (main.js): 8 new handlers (`get-weekly-report`, `nl-query`, `get-focus-analytics`, `get-habit-analytics`, `get-productivity-correlation`, `get-calendar-intelligence`, `link-calendar-tasks`). Updated preload.js with 7 new bridge methods. Loaded 4 new services on startup. |
| 2026-02-24 | Agent | Updated CONSTITUTION.md to v3.0 — all Tier 2 & 3 features now marked ✅ Implemented. Phase 3 complete. |
| 2026-02-24 | Agent | **Critical Fix:** React hooks order violation in Remind.jsx — `useState('timeline')` was after early return. Moved all hooks above conditionals. App was crashing with blank white window. |
| 2026-02-24 | Agent | **Smarter "Do This First":** Rewrote `buildSmartPriorityAction()` in briefing.js — context-aware suggestions based on overdue tasks, urgent emails, upcoming meetings (prep time), action emails, and upcoming task suggestions. Never says "No urgent items" — always gives a concrete action verb. |
| 2026-02-24 | Agent | **Dynamic Briefing Tone:** Added `determineDayLoad()` — scores day intensity (heavy/moderate/light) from meetings×2 + urgent×3 + overdue×2. Sets `dynamic_tone` field: "Big day ahead…" / "Light schedule…" / "Solid day planned…". Displayed below greeting in Today panel. |
| 2026-02-24 | Agent | **Progress Visualization:** Added "Today's Load: X% handled" progress bar to Today hero card. Calculates completedToday vs total (active + completed-today). Color shifts: orange→yellow→blue→green as progress increases. |
| 2026-02-24 | Agent | **Calm Reward Animation:** Subtle green glow + "All clear. Nicely done." with pulse animation when all tasks done + inbox clear. Auto-fades after 4 seconds. |
| 2026-02-24 | Agent | **Email Summary Clarity:** AI prompt now requires 1-2 bullet max with action verbs. Added `buildEmailBullets()` fallback. Email bullets displayed as red-dot list items below "Do This First" in Today panel. |
