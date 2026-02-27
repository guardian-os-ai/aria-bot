# ARIA Personnel Bot — Feature Documentation

> **Version:** 3.0 (Phase 3 — Revenue Stream Consolidation)
> **Last Updated:** June 2025
> **Pricing Target:** ₹499/month — replaces 18+ SaaS tools worth $173+/month

---

## Table of Contents

1. [Mail Panel (21 Features)](#1-mail-panel)
2. [Notes Panel (14 Features)](#2-notes-panel)
3. [Money Panel (10 Features)](#3-money-panel)
4. [AI Chat Panel (10 Features)](#4-ai-chat-panel)
5. [Today Panel (14 Features)](#5-today-panel)
6. [Remind Panel (3 New Features)](#6-remind-panel)
7. [Contacts CRM (5 Features)](#7-contacts-crm)
8. [Time Tracking (4 Features)](#8-time-tracking)
9. [Reading List (4 Features)](#9-reading-list)
10. [Health Tracking (3 Features)](#10-health-tracking)
11. [Travel Intelligence (3 Features)](#11-travel-intelligence)
12. [Meeting Prep (2 Features)](#12-meeting-prep)
13. [WhatsApp Integration (3 Features)](#13-whatsapp-integration)
14. [Settings — New Sections](#14-settings-new-sections)

---

## 1. Mail Panel

Replaces: **Superhuman** ($30/mo), **SaneBox** ($7/mo), **Boomerang** ($15/mo)

### 1.1 Smart Inbox (AI-Categorized Priority View)
- **What it does:** Automatically categorizes every incoming email into priority groups — Urgent, Action Needed, Finance, Newsletters, FYI — using AI intelligence routing. Emails are displayed in collapsible sections sorted by urgency.
- **How it works:** On sync, each email passes through the AI router (Ollama llama3.2:3b) which analyzes subject, sender, body content, and assigns `email_type`, `risk_level`, `priority_score`, and routing labels.
- **UI Location:** Mail panel → Smart Inbox tab (default view)
- **Backend:** `sync-emails` IPC → `categorize-email` → stores in `email_cache` table with `smart_action` JSON

### 1.2 AI Email Summarization
- **What it does:** Automatically generates a 1-2 sentence summary of every email when expanded. Long emails become scannable in seconds.
- **How it works:** When an email is expanded, if no summary exists, it calls Ollama to generate a concise summary. Displayed in a green-tinted card above the email body.
- **UI Location:** Mail panel → expand any email → green summary card
- **Backend:** `summarize-email` IPC → Ollama with temp 0.3

### 1.3 AI Draft Reply
- **What it does:** Generates a context-aware reply draft based on the email subject, sender, and body content. One-click intelligent responses.
- **How it works:** Clicking "Reply" triggers AI draft generation. The draft appears in an editable textarea. User can modify, copy, or send (opens Gmail compose with draft pre-copied).
- **UI Location:** Mail panel → expand email → "Reply" button
- **Backend:** `ai-draft-reply` IPC → AI with email context

### 1.4 Reply Tone Adjustment
- **What it does:** Transforms your reply draft into different tones — Professional, Friendly, Concise, or Firm — while preserving the original meaning.
- **How it works:** After generating or writing a reply, tone buttons appear. Clicking one sends the text through AI rewriting with tone-specific instructions.
- **UI Location:** Mail panel → reply mode → tone buttons below draft
- **Backend:** `adjust-tone` IPC → Ollama with tone prompt

### 1.5 Reply Templates (Quick Replies)
- **What it does:** Pre-saved reply templates for common responses (acknowledgment, scheduling, delegation, etc.). One-click insertion with shortcut codes.
- **How it works:** Templates are stored in `reply_templates` table, seeded with defaults. Clicking "Template" shows a picker. Selecting one populates the reply textarea.
- **UI Location:** Mail panel → expand email → "Template" button → template picker
- **Backend:** `get-reply-templates` IPC → SQLite `reply_templates` table

### 1.6 Email Snooze (Boomerang-Style)
- **What it does:** Temporarily hides an email and brings it back at a chosen time — 1 hour, 3 hours, tomorrow 9am, or next Monday.
- **How it works:** Sets `snoozed_until` timestamp on the email record. Snoozed emails are filtered from the inbox view. A check runs periodically to "unsnooze" emails when time arrives.
- **UI Location:** Mail panel → expand email → "Snooze" button → time picker
- **Backend:** `snooze-email` IPC → updates `email_cache.snoozed_until`

### 1.7 Follow-Up Reminders
- **What it does:** Sets a reminder if no reply is received within a timeframe (default: 48 hours). Expired follow-ups surface as urgent items.
- **How it works:** Sets `follow_up_at` timestamp on the email. The proactive suggestions engine checks for due follow-ups and surfaces them.
- **UI Location:** Mail panel → expand email → "Follow-up" button
- **Backend:** `set-follow-up` IPC → updates `email_cache.follow_up_at`

### 1.8 Block Sender (SaneBox-Style)
- **What it does:** Permanently blocks a sender. All future emails from that address are auto-archived/hidden. Never see spam from that sender again.
- **How it works:** Adds sender email to `blocked_senders` table. On sync, blocked sender emails are automatically filtered out.
- **UI Location:** Mail panel → expand email → Ban icon (right side of action bar)
- **Backend:** `block-sender` IPC → inserts into `blocked_senders` table

### 1.9 Unsubscribe Detection & One-Click Unsubscribe
- **What it does:** Detects unsubscribe links in newsletter/marketing emails and provides a one-click unsubscribe button directly in the app.
- **How it works:** Regex scans email body for unsubscribe/opt-out/manage-preferences URLs. If found, displays an orange MailX icon in the action bar. Clicking opens the unsubscribe link in the default browser.
- **UI Location:** Mail panel → expand email → orange MailX icon (appears only when link detected)
- **Backend:** `get-unsubscribe-link` IPC → regex extraction from `body_preview`, cached in `email_cache.unsubscribe_link`

### 1.10 Intelligence Routing Labels
- **What it does:** Auto-tags emails with routing labels (Finance, Legal, HR, Project, etc.) so users can see at a glance what department/category each email belongs to.
- **How it works:** The AI categorization returns `route_to` fields in `smart_action` JSON. These appear as colored pills/badges on the email card.
- **UI Location:** Mail panel → email cards → colored route pills
- **Backend:** Part of `categorize-email` response → `smart_action.route_to`

### 1.11 Smart Action Badges
- **What it does:** Shows contextual badges for each email — email type, risk level, financial impact, deadline, recommended action. Instant visual triage.
- **How it works:** AI categorization extracts these fields. Badges render as colored pills below the email summary.
- **UI Location:** Mail panel → expand email → badge row below summary
- **Backend:** `smart_action` JSON fields: `email_type`, `risk_level`, `financial_impact`, `deadline`, `recommended_action`

### 1.12 Gmail OAuth Integration
- **What it does:** Secure OAuth2 connection to Gmail. Syncs inbox, supports labels, handles token refresh automatically.
- **How it works:** Full OAuth2 flow with PKCE, token storage in settings, automatic refresh on expiry. Fetches emails via Gmail API.
- **UI Location:** Settings panel → Gmail connection
- **Backend:** `gmail-oauth.js` service → `gmail.js` API calls

### 1.13 Email Search
- **What it does:** Full-text search across all synced emails by subject, sender, or body content.
- **How it works:** SQLite LIKE queries across email_cache fields, filtered in real-time as user types.
- **UI Location:** Mail panel → search bar at top
- **Backend:** Client-side filter on cached email data

### 1.14 Priority Score System
- **What it does:** Every email gets a 0-100 priority score. Higher scores surface first in the Smart Inbox.
- **How it works:** AI assigns `priority_score` during categorization based on urgency, sender importance, financial impact, and deadline proximity.
- **UI Location:** Used for sorting within priority groups
- **Backend:** `smart_action.priority_score` field

### 1.15 Email Archiving
- **What it does:** Archive emails to remove them from the active inbox. Can be undone by refreshing.
- **How it works:** Sets `archived` flag on the email record. Archived emails are hidden from the inbox view with a slide-out animation.
- **UI Location:** Mail panel → expand email → "Done" button (green)
- **Backend:** `archive-email` IPC → updates `email_cache.archived`

### 1.16 Email Deletion
- **What it does:** Permanently remove an email from the local cache.
- **How it works:** Deletes the email record from `email_cache` table.
- **UI Location:** Mail panel → expand email → Trash icon
- **Backend:** `delete-email` IPC → DELETE from `email_cache`

### 1.17 Smart Inbox Grouping
- **What it does:** Emails are organized into smart groups (Important, Action Needed, Newsletters, Others) with collapsible sections showing count badges.
- **How it works:** Groups are determined by the AI's `email_type` and `priority_score` fields. Each group has its own icon, color, and count.
- **UI Location:** Mail panel → Smart view → collapsible sections
- **Backend:** Client-side grouping logic based on `smart_action` data

### 1.18 Copy to Clipboard
- **What it does:** One-click copy of reply drafts to clipboard for pasting into Gmail or other email clients.
- **UI Location:** Mail panel → reply mode → Copy button

### 1.19 Gmail Compose Integration
- **What it does:** Opens Gmail compose window pre-addressed to the sender. Draft is auto-copied to clipboard for pasting.
- **UI Location:** Mail panel → reply mode → "Send via Gmail" button
- **Backend:** `draft-reply` IPC → opens compose URL

### 1.20 Snoozed Emails View
- **What it does:** View all currently snoozed emails in a dedicated section with countdown timers.
- **UI Location:** Mail panel → Snoozed tab/section
- **Backend:** Filters `email_cache` where `snoozed_until > now`

---

## 2. Notes Panel

Replaces: **Notion** ($10/mo), **Obsidian** (free+$10/mo sync), **Roam Research** ($15/mo)

### 2.1 Rich Note Editor
- **What it does:** Full note editor with title, content, tags, and color-coded organization. Notes are auto-saved with timestamps.
- **How it works:** In-app editor with auto-save on content changes after debounce. Notes stored in SQLite with title, content, tags (JSON), color, and timestamps.
- **UI Location:** Notes panel → click any note or + button
- **Backend:** `save-note`, `get-notes`, `update-note` IPC handlers → `notes` table

### 2.2 Note Tags & Filtering
- **What it does:** Tag notes with searchable labels. Filter by tags to find related notes quickly.
- **How it works:** Tags stored as JSON array in `notes.tags` column. Tag pills shown on note cards. Click a tag to filter.
- **UI Location:** Notes panel → tag pills on cards → tag input in editor
- **Backend:** Tags stored in `notes.tags` as JSON

### 2.3 Note Search
- **What it does:** Full-text search across note titles and content.
- **UI Location:** Notes panel → search bar
- **Backend:** SQLite LIKE query on title and content

### 2.4 AI Note Summarization
- **What it does:** Generates a concise summary of any note using AI. Useful for long meeting notes or research.
- **How it works:** Sends note content to Ollama with "summarize in 2-3 sentences" instruction. Replaces or appends summary.
- **UI Location:** Notes panel → note editor → Summarize button
- **Backend:** `summarize-note` IPC → Ollama temp 0.3

### 2.5 Extract Action Items
- **What it does:** AI scans a note and extracts actionable tasks, presenting them as a bulleted list that can be converted to reminders.
- **How it works:** Sends note content to AI with instruction to extract tasks. Returns structured list of action items.
- **UI Location:** Notes panel → note editor → Extract Tasks button
- **Backend:** `extract-tasks-from-note` IPC → AI extraction

### 2.6 Note Templates
- **What it does:** Pre-built templates for common note types — Meeting Notes, Weekly Review, Project Plan, Decision Log, 1:1 Notes, Brainstorm.
- **How it works:** Templates stored in `note_templates` table, seeded with 6 defaults. Each has title pattern, pre-formatted content with sections, and default tags.
- **UI Location:** Notes panel → Template icon button → template picker
- **Backend:** `get-note-templates` IPC → `note_templates` table

### 2.7 AI Continue Writing
- **What it does:** AI continues writing from where you left off. Generates 2-3 natural sentences that match the style and context of your note.
- **How it works:** Sends current note content (last 500 chars) to Ollama with "continue naturally" instruction at temperature 0.7 for creativity. Result is appended to note content.
- **UI Location:** Notes panel → editor → AI tool strip → "Continue" button (PenLine icon)
- **Backend:** `continue-writing` IPC → Ollama llama3.2:3b, temp 0.7

### 2.8 Note Tone Changer
- **What it does:** Rewrites the entire note in a different tone — Professional, Casual, or Concise — while preserving all information.
- **How it works:** Sends full note content to Ollama with tone-specific rewriting instructions at temperature 0.4 for controlled output. Replaces note content.
- **UI Location:** Notes panel → editor → AI tool strip → "Professional" / "Casual" / "Concise" buttons
- **Backend:** `adjust-note-tone` IPC → Ollama with tone prompts, temp 0.4

### 2.9 Related Notes (Backlinks)
- **What it does:** Automatically finds and displays notes related to the current note based on keyword and tag overlap. Obsidian/Roam-style linked thinking.
- **How it works:** Extracts keywords from current note title+content, removes stop words, scores all other notes by keyword overlap (1 point per match) + tag overlap (2 points per matching tag). Returns top 5 with score > 1.
- **UI Location:** Notes panel → editor → AI tool strip → "Related" button with count badge → collapsible yellow panel showing clickable related note titles
- **Backend:** `get-related-notes` IPC → keyword extraction + scoring algorithm

### 2.10 Daily Notes
- **What it does:** One-click creation of today's daily note with a structured template (Accomplishments, Key Thoughts, Tomorrow's Priorities). Roam Research-style daily journaling.
- **How it works:** Clicking "Today" button checks for existing daily note (is_daily=1, daily_date=today). If none exists, creates one with a pre-formatted template. Auto-opens in editor.
- **UI Location:** Notes panel → search bar area → CalendarDays "Today" button (blue)
- **Backend:** `get-daily-note` IPC → checks/creates in `notes` table with `is_daily=1, daily_date=YYYY-MM-DD`

---

## 3. Money Panel

Replaces: **YNAB** ($14.99/mo), **Mint** (discontinued), **Truebill/Rocket Money** ($12/mo), **PocketGuard** ($7.99/mo), **Copilot Finance** ($10/mo)

### 3.1 Transaction Tracking
- **What it does:** Manual entry and viewing of income/expense transactions with categories, amounts, dates, and type (debit/credit).
- **UI Location:** Money panel → Daily Ledger section → "+" button
- **Backend:** `add-transaction`, `get-transactions` IPC → `transactions` table

### 3.2 Monthly Cashflow Card
- **What it does:** Shows total income vs total expenses for the current month with net balance. Color-coded: green for surplus, red for deficit.
- **UI Location:** Money panel → top cashflow card
- **Backend:** `get-transactions` for current month → client-side aggregation

### 3.3 Category Breakdown
- **What it does:** Breaks down spending by category with amounts and percentages. Visual pie chart shows proportional spending.
- **How it works:** Aggregates transactions by category for the current month. Displays as list with amounts + SVG donut chart.
- **UI Location:** Money panel → Category section with donut pie chart
- **Backend:** Client-side grouping of transactions by category

### 3.4 Donut Pie Chart (Visual)
- **What it does:** SVG donut chart showing top 6 spending categories as colored arcs. Center shows total amount. YNAB/Copilot-style visual.
- **How it works:** Calculates arc segments from category percentages. Renders as concentric circle strokes in an 80x80 SVG.
- **UI Location:** Money panel → category breakdown section → inline donut chart
- **Backend:** Pure client-side SVG rendering

### 3.5 Subscription Tracking
- **What it does:** Tracks all recurring subscriptions with names, amounts, billing cycles, and next due dates. Shows total monthly subscription burden.
- **UI Location:** Money panel → Subscriptions section
- **Backend:** `get-subscriptions` IPC → `subscriptions` table

### 3.6 Unused Subscription Detection
- **What it does:** AI-powered detection of subscriptions that haven't been "used" in 60+ days, suggesting cancellation to save money. Truebill-style savings finder.
- **How it works:** Checks last transaction date for each subscription's category. If >60 days since last related transaction, flags as unused.
- **UI Location:** Money panel → Subscriptions section → orange "unused" badges
- **Backend:** `get-unused-subscriptions` IPC → cross-references subscriptions with transactions

### 3.7 Month-over-Month Comparison
- **What it does:** Compares this month's spending to last month's, showing increase/decrease percentage per category and overall.
- **UI Location:** Money panel → Comparison section
- **Backend:** `get-month-comparison` IPC → queries current vs previous month transactions

### 3.8 Spendable Balance ("In My Pocket")
- **What it does:** PocketGuard-style "safe to spend" calculator. Shows: Income - Committed Bills - Already Spent = Spendable. Also calculates daily budget (spendable ÷ days remaining).
- **How it works:** Reads `monthly_income` from settings, sums subscription amounts as committed, queries month's debit transactions as spent. Green gradient card with prominent daily budget display.
- **UI Location:** Money panel → "💚 Spendable Today" card (below cashflow)
- **Prerequisite:** Must set `monthly_income` in Settings
- **Backend:** `get-spendable-balance` IPC → reads settings + subscriptions + transactions

### 3.9 Category Budget Limits
- **What it does:** Set monthly spending caps per category (e.g., "Food: ₹8000/month"). Shows progress bar with color coding: green (<80%), orange (80-100%), red (exceeded). YNAB-style envelope budgeting.
- **How it works:** User sets limits via inline input. Each category shows current spending vs limit as a progress bar. Exceeded categories show warning icon and "Over by ₹X" text.
- **UI Location:** Money panel → "Category Budget Limits" section with Shield icon
- **Backend:** `get-category-limits`, `set-category-limit`, `delete-category-limit` IPC → `budget_limits` table

### 3.10 Daily Ledger
- **What it does:** Chronological list of all transactions for the current month with date, description, category, and amount.
- **UI Location:** Money panel → Daily Ledger section (bottom)
- **Backend:** `get-transactions` IPC with current month filter

---

## 4. AI Chat Panel

Replaces: **ChatGPT Plus** ($20/mo), **Perplexity Pro** ($20/mo), **Claude Pro** ($20/mo), **Microsoft Copilot** ($20/mo)

### 4.1 Multi-Provider AI Chat
- **What it does:** Chat with ARIA using multiple AI backends — Ollama (local/free), Anthropic Claude Haiku, xAI Grok. Auto-routes based on availability and daily limits.
- **UI Location:** AI Chat panel → chat interface
- **Backend:** `chat` / `chat-enhanced` IPC → `ai.js` router → ollama/haiku/grok services

### 4.2 Chat History Persistence
- **What it does:** All conversations are saved and restored across app restarts. Full chat history with timestamps.
- **UI Location:** AI Chat panel → messages persist on reload
- **Backend:** `save-chat-message`, `get-chat-history`, `clear-chat-history` IPC → `chat_history` table

### 4.3 Quick Action Chips
- **What it does:** Pre-built prompt shortcuts for common queries: "Plan today", "Inbox first", "My spending", "Focus stats". One-click sends the full prompt.
- **UI Location:** AI Chat panel → bottom bar → chip row
- **Backend:** Client-side chip definitions → triggers `handleSend`

### 4.4 Chat Mode Selector (Work / Personal / Research)
- **What it does:** Switch between 3 AI personality modes. Work mode: professional, actionable. Personal mode: friendly, empathetic. Research mode: analytical, detailed with sources.
- **How it works:** Mode is passed to the `chatEnhanced` IPC handler, which injects mode-specific system prompt instructions into the AI context.
- **UI Location:** AI Chat panel → top strip → 3 mode pills (Briefcase/User/Flask icons)
- **Backend:** `chat-enhanced` IPC → mode-specific system prompts

### 4.5 AI Memory (Remember Facts)
- **What it does:** ARIA remembers facts about you across conversations. Say "Remember that I prefer morning meetings" and it's stored permanently. ChatGPT-style personalization.
- **How it works:** Auto-detects "remember", "note that", "my name is" patterns in user messages and saves to `ai_memory` table. On every chat, top 10 memories are injected into the AI context.
- **UI Location:** AI Chat panel → Brain icon (top-right) → collapsible memory panel showing saved facts with delete buttons
- **Backend:** `save-memory`, `get-memories`, `delete-memory` IPC → `ai_memory` table

### 4.6 Proactive Suggestions
- **What it does:** When opening the chat with no messages, ARIA surfaces actionable suggestions based on your current data — overdue tasks, urgent emails, due bills, unused subscriptions, spending spikes.
- **How it works:** Aggregates 6 data sources: overdue tasks (limit 3), urgent unreplied emails (limit 2), bills due in 3 days, unused subscriptions (60-day check), due follow-ups, spending spikes (>30% vs last month). Returns max 5 suggestions with icons and clickable text.
- **UI Location:** AI Chat panel → welcome area → orange-tinted suggestion cards (appear when chat is empty)
- **Backend:** `get-proactive-suggestions` IPC → 6-source aggregator

### 4.7 Follow-Up Question Suggestions
- **What it does:** After each AI response, suggested follow-up questions appear as clickable chips. Perplexity-style conversation flow.
- **How it works:** The AI response is parsed for lines starting with "FOLLOW_UP:" — these are extracted and displayed as blue chips below the bot message. Clicking sends the question.
- **UI Location:** AI Chat panel → below bot messages → blue follow-up chips
- **Backend:** `chat-enhanced` response parsing → `FOLLOW_UP:` line extraction

### 4.8 Usage Tracking & Limits
- **What it does:** Shows daily AI call usage counter. Limits Haiku calls to 20/day to manage costs. Counter auto-resets daily.
- **UI Location:** AI Chat panel → bottom bar → "X/20 AI calls today"
- **Backend:** `get-usage` IPC → tracks daily call count

### 4.9 Chat Clear
- **What it does:** One-click clear all chat history. Fresh start for new conversations.
- **UI Location:** AI Chat panel → bottom bar → "Clear" button (Trash icon)
- **Backend:** `clear-chat-history` IPC → DELETE from `chat_history`

### 4.10 Context-Aware Responses
- **What it does:** AI responses are enriched with context from your emails, tasks, bills, and schedule. Ask "What should I focus on?" and ARIA knows your actual priorities.
- **How it works:** The enhanced chat handler injects memory context + daily data summaries into the system prompt, giving the AI awareness of your real situation.
- **Backend:** `chat-enhanced` IPC → memory injection + contextual system prompt

---

## 5. Today Panel

Replaces: **Sunsama** ($20/mo), **Motion** ($19/mo), **Akiflow** ($15/mo), **Ellie** ($5/mo)

### 5.1 AI Daily Briefing
- **What it does:** Every morning, AI generates a comprehensive briefing: priority action, email signals, calendar optimization suggestion, and timeline.
- **How it works:** Calls AI with aggregated data from emails, calendar, and tasks. Produces structured JSON with priority_action, email_bullets, optimization, and timeline.
- **UI Location:** Today panel → Hero card → Priority action + bullet points
- **Backend:** `get-briefing` IPC → `briefing.js` service → AI briefing generation

### 5.2 Priority Action Card
- **What it does:** Shows THE most important thing to do right now. One sentence, one action. Tappable to navigate to the relevant panel (mail/tasks).
- **UI Location:** Today panel → Hero card → orange "Action Needed" card
- **Backend:** Part of `get-briefing` response → `priority_action` field

### 5.3 Timeline View
- **What it does:** Chronological view of today's schedule — meetings, tasks, emails to handle — with time stamps, colored dots by type, and clean formatting.
- **UI Location:** Today panel → Hero card → timeline section
- **Backend:** Part of `get-briefing` response → `timeline` array

### 5.4 Day Progress Bar
- **What it does:** Shows task completion progress — "3 of 7 done" with animated progress bar. Color changes: orange (<50%), blue (50-99%), green (100%).
- **How it works:** Counts active reminders vs completed-today reminders. Calculates percentage and renders progress bar.
- **UI Location:** Today panel → Hero card → bottom progress section
- **Backend:** `get-reminders` + `get-all-reminders` IPC → client-side calculation

### 5.5 Zero Inbox Celebration
- **What it does:** When all tasks are done and no urgent emails remain, shows a green "All clear. Nicely done." celebration card with pulse animation.
- **UI Location:** Today panel → Hero card → green glow card (auto-appears, fades after 4s)
- **Backend:** Client-side detection of zero remaining tasks + zero urgent emails

### 5.6 Morning Ritual Card
- **What it does:** Sunsama/Motion-style morning focus card showing: top 3 numbered priorities, focus hours today, meeting count. Helps you start the day intentionally.
- **How it works:** Calls `getMorningRitual` which aggregates: top 5 priorities (sorted by priority_score), today's meetings, focus minutes, bills due in 2 days, undone habits (top 3). Displays with numbered priorities, focus/meeting stat boxes.
- **UI Location:** Today panel → "Morning Focus" card (orange gradient, below hero) → numbered priorities + stat boxes
- **Backend:** `get-morning-ritual` IPC → aggregates tasks, calendar, focus, bills, habits

### 5.7 Bills Due Soon Section
- **What it does:** Shows subscriptions/bills due within 2 days with amounts. Prevents missed payments. Part of the unified daily view.
- **UI Location:** Today panel → "Bills Due Soon" card (red CreditCard icon) with name + ₹amount rows
- **Backend:** Part of `get-morning-ritual` response → `billsDue` array

### 5.8 Habits Tracker Section
- **What it does:** Shows today's undone habits — things you need to do daily. Integrated into the Today view for a single dashboard.
- **UI Location:** Today panel → "Habits to do" card (green Activity icon) with habit names
- **Backend:** Part of `get-morning-ritual` response → `undoneHabits` array

### 5.9 AI Suggestions Card
- **What it does:** Proactive AI-powered suggestions based on your data — overdue tasks, urgent emails, spending alerts, unused subscriptions. Each suggestion is tappable and navigates to the relevant panel.
- **How it works:** Calls `getProactiveSuggestions` (same 6-source aggregator as Chat panel). Shows up to 4 suggestions with icons and chevron arrows.
- **UI Location:** Today panel → "ARIA Suggests" card (purple Brain icon) → clickable suggestion rows
- **Backend:** `get-proactive-suggestions` IPC → 6-source aggregator

### 5.10 Quick Navigation
- **What it does:** Collapsible navigation rows to quickly jump to other panels — Subscriptions (→ Money), with more expandable in future.
- **UI Location:** Today panel → collapsible row cards at bottom
- **Backend:** `onNavigate` prop → panel switching

---

## Architecture Summary

| Component | Technology |
|-----------|-----------|
| Desktop App | Electron 28.2 |
| Frontend | React 18.2 + Vite 5.0 |
| Database | better-sqlite3 (WAL mode) |
| AI (Local) | Ollama llama3.2:3b (free) |
| AI (Cloud) | Anthropic Claude Haiku (20/day), xAI Grok |
| Email | Gmail API via OAuth2 |
| Window | 348×620px frameless overlay, always-on-top |
| Tables | ~20 SQLite tables |
| IPC Methods | ~104 handler methods |
| Services | 18 backend service files |

---

## Database Tables

| Table | Purpose |
|-------|---------|
| `email_cache` | Synced emails with smart_action, snoozed_until, follow_up_at, unsubscribe_link |
| `reminders` | Tasks/reminders with priority_score, sub-tasks, completed_at, time_spent, billable, hourly_rate |
| `transactions` | Financial transactions (income/expense) |
| `subscriptions` | Recurring subscription tracking |
| `notes` | Notes with tags, color, is_daily, daily_date |
| `note_templates` | Pre-built note templates |
| `reply_templates` | Email reply templates |
| `chat_history` | Persisted chat messages |
| `ai_memory` | User facts for AI personalization |
| `budget_limits` | Per-category monthly spending caps |
| `blocked_senders` | Blocked email addresses |
| `habits` | Daily habit tracking |
| `focus_sessions` | Focus/pomodoro session records |
| `calendar_events` | Synced calendar events |
| `settings` | App settings (API keys, user prefs, WhatsApp config, profile) |
| `analytics` | Usage analytics |
| `weekly_reports` | Generated weekly report data |
| `contacts` | Contacts CRM — name, email, phone, company, birthday, tags, contact_count |
| `time_logs` | Time logging entries — reminder_id, minutes, billable, hourly_rate |
| `reading_list` | Reading list — url, title, source, is_read |
| `health_logs` | Daily health log — water, sleep, workout, weight, mood |
| `trips` | Travel trips — destination, dates, booking_ref, type, source_email_id |

---

## 6. Remind Panel — New Features

Replaces: **Toggl Track** ($18/mo), **RescueTime** ($12/mo) — time tracking aspects

### 6.1 Time Logging on Tasks
- **What it does:** Log minutes spent on any task directly from the Remind panel. Tracks cumulative time per task.
- **How it works:** Expanded tasks show a "⏱ Time" button. Clicking opens an inline input to log minutes. Time is stored in `time_logs` table and `reminders.time_spent` is updated.
- **UI Location:** Remind panel → expand task → "⏱ Time" button → log input
- **Backend:** `log-time` IPC → inserts `time_logs` + updates `reminders.time_spent`

### 6.2 Time Badge on Tasks
- **What it does:** Shows a compact blue badge on tasks that have logged time (e.g., "⏱45m").
- **How it works:** `time_spent` column on reminders is displayed as a badge next to the task title.
- **UI Location:** Remind panel → task row → blue badge after title

### 6.3 Billable Hours Support
- **What it does:** Time logs can be marked as billable with an hourly rate, enabling freelancer/contractor billing.
- **How it works:** `billable` and `hourly_rate` columns on time_logs and reminders. `get-billable-summary` computes total billable hours and amount.
- **Backend:** `get-billable-summary` IPC → aggregates billable time_logs

---

## 7. Contacts CRM

Replaces: **Dex** ($10/mo), **Clay** ($10/mo) — personal CRM

### 7.1 Auto-Extract Contacts from Emails
- **What it does:** Scans email cache and auto-creates contact records for real people (filters out noreply, notifications, automated senders).
- **How it works:** `extract-contacts-from-emails` IPC scans `email_cache`, extracts unique senders, filters automated addresses, UPSERTs into `contacts` table.
- **Backend:** Filters: `noreply|no-reply|notification|mailer-daemon|bounce|unsubscribe|newsletter`

### 7.2 Contact Notes & Company Tracking
- **What it does:** Store notes, company name, phone, tags for each contact. Full mini-CRM.
- **How it works:** `add-contact` / `update-contact` IPCs, UPSERT on email. Tags stored as JSON array.
- **Backend:** `contacts` table with all fields

### 7.3 Keep-in-Touch Reminders
- **What it does:** Surfaces contacts you haven't emailed in N days on the Today panel's Life Dashboard.
- **How it works:** `get-contact-suggestions` queries contacts with `last_contacted_at` older than threshold days.
- **UI Location:** Today panel → Life Dashboard → "Reconnect" section
- **Backend:** `get-contact-suggestions` IPC with configurable days threshold

### 7.4 Inline Contact Info in Mail
- **What it does:** Shows compact contact metadata (company, email count, last contacted) when viewing an email.
- **How it works:** When email is expanded, `getContactByEmail` is called for the sender. Displays 1-line info below the email address.
- **UI Location:** Mail panel → expand email → subtle info line below from_email

### 7.5 Birthday Tracking
- **What it does:** Store and track contact birthdays for relationship management.
- **How it works:** `birthday` field on contacts record, queryable for upcoming birthdays.
- **Backend:** `contacts.birthday` column

---

## 8. Time Tracking

Replaces: **RescueTime** ($12/mo), **Toggl Track** ($18/mo)

### 8.1 Time Log Entries
- **What it does:** Track time spent on tasks, projects, or activities. Each log is a separate entry with minutes, description, and optional billable flag.
- **How it works:** `log-time` IPC creates entry in `time_logs` table and updates `reminders.time_spent`.
- **Backend:** `time_logs` table, linked to reminders via `reminder_id`

### 8.2 Productivity Score (0-100)
- **What it does:** Computes a daily productivity score combining focus time (40pts max for 2h+), task completion (30pts max), and habit streaks (30pts max).
- **How it works:** `get-productivity-score` aggregates today's focus_sessions, completed reminders, and habit completions into a composite 0-100 score.
- **UI Location:** Today panel → Life Dashboard → productivity number with color indicator
- **Backend:** Composite query across `focus_sessions`, `reminders`, `habits`

### 8.3 Billable Hours Summary
- **What it does:** Aggregates all billable time logs into total hours and billable amount (hours × rate).
- **How it works:** `get-billable-summary` sums billable time_logs with their hourly rates.
- **Backend:** SQL aggregate on `time_logs WHERE billable = 1`

### 8.4 Time Logs History
- **What it does:** View all time log entries for the last N days.
- **How it works:** `get-time-logs` returns recent entries with task descriptions.
- **Backend:** `time_logs` ordered by `logged_at DESC`

---

## 9. Reading List

Replaces: **Pocket** ($5/mo), **Readwise** ($8/mo)

### 9.1 Save Links to Reading List
- **What it does:** Save any URL to a "Read Later" list. De-duplicates by URL automatically.
- **How it works:** Input field in Notes panel's Reading mode. `add-to-reading-list` IPC inserts with dedup check.
- **UI Location:** Notes panel → "📖 Reading" filter → URL input at top
- **Backend:** `reading_list` table, UNIQUE on URL via ON CONFLICT IGNORE

### 9.2 Reading List View
- **What it does:** View all saved links in a clean list with title, URL preview, and read/unread status.
- **How it works:** `get-reading-list` returns all items. Displayed as cards with checkmark for read status.
- **UI Location:** Notes panel → "📖 Reading" filter → list view

### 9.3 Mark as Read
- **What it does:** Mark reading items as completed with a visual checkmark. Read items are dimmed.
- **How it works:** `mark-reading-read` sets `is_read = 1`. UI shows green checkmark and 50% opacity.
- **UI Location:** Notes panel → Reading view → click circle checkbox

### 9.4 Delete Reading Item
- **What it does:** Remove items from reading list permanently.
- **How it works:** `delete-reading-item` removes from `reading_list` table.
- **UI Location:** Notes panel → Reading view → trash icon per item

---

## 10. Health Tracking

Replaces: **MyFitnessPal** ($10/mo), **Strava** ($10/mo) — basic tracking

### 10.1 Daily Health Log
- **What it does:** Log daily health metrics: water intake (glasses), sleep hours, workout minutes + type, weight, and mood.
- **How it works:** `log-health` UPSERTS on today's date. All fields optional — log what matters to you.
- **UI Location:** Today panel → Life Dashboard → health card
- **Backend:** `health_logs` table with date UNIQUE constraint

### 10.2 Health Summary & Averages
- **What it does:** Shows today's health status plus 7-day rolling averages and workout streak count.
- **How it works:** `get-health-summary` returns today's log, 7-day averages for water/sleep/workout, and consecutive workout days streak.
- **UI Location:** Today panel → Life Dashboard → 💧 water count + 🏃 workout minutes
- **Backend:** SQL aggregate over last 7 `health_logs`

### 10.3 Health History
- **What it does:** View health logs for the last N days to spot trends.
- **How it works:** `get-health-log` returns recent entries ordered by date.
- **Backend:** `health_logs` ordered by `date DESC`

---

## 11. Travel Intelligence

Replaces: **TripIt** ($49/yr) — travel organization

### 11.1 Auto-Extract Trips from Emails
- **What it does:** Scans email inbox for flight/hotel/train booking confirmations and auto-creates trip records with destination, dates, PNR, and booking references.
- **How it works:** `extract-trips-from-emails` applies 5 regex patterns against email subjects/bodies: booking confirmation, flight/hotel/train keywords, PNR patterns, check-in/departure mentions, and travel site domains (MakeMyTrip, Goibibo, IRCTC, Booking.com, Expedia, etc.)
- **Backend:** Creates `trips` entries with type (flight/hotel/train), destination extraction, date parsing, PNR/booking ref capture

### 11.2 Upcoming Trips Card
- **What it does:** Shows next upcoming trips on the Today panel with destination, date, and type icon (✈️/🏨/🚂).
- **How it works:** `get-upcoming-trips` queries trips with `start_date >= today`. Limited to 3 on Today panel.
- **UI Location:** Today panel → Life Dashboard → "Upcoming Trips" section
- **Backend:** `trips` table with `start_date` filter

### 11.3 Manual Trip Management
- **What it does:** Add or delete trips manually for trips not found via email extraction.
- **How it works:** `add-trip` / `delete-trip` IPCs for CRUD operations on `trips` table.
- **Backend:** Direct CRUD on `trips` table

---

## 12. Meeting Prep

Replaces: Part of **Otter.ai** ($17/mo), **Fireflies** ($10/mo) — prep aspects

### 12.1 Auto Meeting Prep Notes
- **What it does:** Auto-creates a structured meeting prep note with sections: Agenda, Discussion Points, Decisions, Action Items. Pre-populated from calendar event details.
- **How it works:** `create-meeting-prep` takes event title, date, attendees and creates a note in `notes` table with template content and "meeting" tag.
- **UI Location:** Created via AI chat or API, appears in Notes panel with meeting tag
- **Backend:** `create-meeting-prep` IPC → inserts into `notes`

### 12.2 Meeting Time Stats
- **What it does:** Shows weekly meeting count, total meeting hours, and upcoming meetings today.
- **How it works:** `get-meeting-stats` aggregates from `calendar_events` for the current week.
- **UI Location:** Today panel → Life Dashboard → Meetings/wk count
- **Backend:** SQL aggregate on `calendar_events` for current week

---

## 13. WhatsApp Integration

Replaces: Manual briefing checks — new revenue-enabling channel

### 13.1 WhatsApp Morning Briefing
- **What it does:** Sends your daily ARIA briefing (overdue tasks, urgent emails, priority actions) via WhatsApp through Twilio.
- **How it works:** `send-whatsapp-briefing` IPC formats briefing data and sends via Twilio WhatsApp API. Message includes greeting, overdue tasks list, urgent email count, and top-priority action.
- **UI Location:** Settings → WhatsApp Briefing → "Send Briefing Now" button
- **Backend:** Node.js HTTPS POST to Twilio API (`api.twilio.com/2010-04-01/Accounts/...`)

### 13.2 WhatsApp Test Message
- **What it does:** Opens WhatsApp Web with a pre-formatted test message to verify the user's phone number.
- **How it works:** `send-whatsapp-test` opens `wa.me/{phone}` URL in the default browser.
- **UI Location:** Settings → WhatsApp Briefing → "Test via WhatsApp Web" button

### 13.3 WhatsApp Status Check
- **What it does:** Checks if WhatsApp is properly configured (Twilio credentials + phone number + enabled).
- **How it works:** `get-whatsapp-status` reads settings and returns configuration state.
- **Backend:** Queries `settings` table for whatsapp_* and twilio_* keys

---

## 14. Settings — New Sections

### 14.1 WhatsApp Briefing Configuration
- **What it does:** Configure WhatsApp briefing with Twilio credentials, phone number, and enable/disable toggle.
- **Fields:** WhatsApp Phone Number, Twilio Account SID, Twilio Auth Token, WhatsApp From Number, Enable toggle
- **UI Location:** Settings panel → "WhatsApp Briefing" section

### 14.2 Profile Settings
- **What it does:** Set user name and monthly income (used by Money panel's spendable balance calculation).
- **Fields:** Your Name, Monthly Income (₹)
- **UI Location:** Settings panel → "Profile" section
