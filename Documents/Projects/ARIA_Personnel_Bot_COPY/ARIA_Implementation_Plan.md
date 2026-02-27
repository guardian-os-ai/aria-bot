# ARIA Implementation Plan
**Date:** 2026-02-25  
**Last Updated:** 2026-02-25 (Session 2 — Implementation)  
**Ordered:** High Priority → Low Priority  
**Each task is independent and implementable one at a time**

---

## PHASE 1 — STABILITY
> **Why first:** Bugs and dead code create false signals during development. Fix the foundation before building on it.

---

### P1-1 | Fix 4 Confirmed Bugs ✅ IMPLEMENTED
- **Category:** Bug Fixes
- **Priority:** 🔴 Critical
- **Effort:** 2 hours

| Bug | File | Fix |
|---|---|---|
| WhatsApp handler uses `overdue.text` — column is `title` | main.js ~L3178 | Change to `overdue.title` |
| Meeting stats uses `start_time` — column is `start_at` | main.js ~L3148 | Change to `start_at` |
| `buildPersonalBrain` habits query selects `name, icon` but references `h.id` for completion check | main.js ~L651 | Add `id` to SELECT |
| `get-spending-insight` `seenEmailIds` set is always empty — column not selected | main.js ~L1251 | Add `source_email_id` to SELECT |

---

### P1-2 | Delete mail.js (Dead Code) ✅ IMPLEMENTED
- **Category:** Cleanup
- **Priority:** 🔴 Critical
- **Effort:** 30 minutes

`services/mail.js` is 749 lines of IMAP client code that was replaced by `services/gmail.js` (REST API). Still imported and loaded on every startup. Defines the same function names as gmail.js — naming collision risk. Zero user-facing impact from deletion. Remove it and its import from main.js.

---

### P1-3 | Deduplicate Transaction Extraction ✅ IMPLEMENTED
- **Category:** Refactor
- **Priority:** 🔴 Critical
- **Effort:** 3 hours

The pipeline `email → extractTransaction() → INSERT INTO transactions + spend_log` is written in 3 places:
1. `routeEmailInsights()`
2. `scan-financial-emails` handler
3. `get-spending-insight` handler

Each has slightly different error handling. A bug fix in one doesn't fix the others. Extract into a single `persistTransactions(emails)` function in `financial-intel.js`. Call it from `routeEmailInsights()` only. Remove the duplicate inline implementations.

---

### P1-4 | Deduplicate Subscription Backfill ✅ IMPLEMENTED
- **Category:** Refactor
- **Priority:** 🟠 High
- **Effort:** 2 hours

Same problem as P1-3 but for subscription detection. `routeEmailInsights()` and `get-subscriptions` handler both parse `email_cache.reminder_opportunity` JSON and upsert into `subscriptions`. Risk of double-insertion and race conditions. Extract into `persistSubscriptions(emails)` in financial-intel.js.

---

### P1-5 | Merge Two Chat Handlers ✅ IMPLEMENTED
- **Category:** Refactor
- **Priority:** 🟠 High
- **Effort:** 2 hours

`chat` and `chat-enhanced` are 80% identical:
- `chat-enhanced` has: mode + memory + follow-ups
- `chat` has: NL query pre-check + intent routing

Ask.jsx uses `chat-enhanced`. Merge everything into `chat-enhanced`. Move NL query check and intent routing into it. Delete `chat` handler. One handler, one path.

---

### P1-6 | Consolidate OAuth to One Flow ✅ IMPLEMENTED
- **Category:** Cleanup
- **Priority:** 🟡 Medium
- **Effort:** 1 hour

Two handlers exist for the same thing:
- `connect-gmail` — BrowserWindow-based OAuth
- `gmail-oauth-start` — HTTP server-based OAuth

Pick one (BrowserWindow is more reliable on Windows). Delete the other. Remove the dead bridge method from preload.js.

---

### P1-7 | Add `nowUnix()` and `todayISO()` Helpers ✅ IMPLEMENTED
- **Category:** Cleanup
- **Priority:** 🟢 Low
- **Effort:** 30 minutes

`Math.floor(Date.now() / 1000)` appears 50+ times across main.js. `new Date().toISOString().split('T')[0]` appears ~20 times. Add two helper functions at the top of main.js. Replace all instances. Makes the money/briefing/query code readable.

---

## PHASE 2 — PYTHON SIDECAR (The New Brain)
> **Why second:** This is the architectural pivot. Everything smart (RAG, priority engine, human-feeling responses) depends on having this running. The existing Node/Electron shell doesn't change — you're adding a Python process alongside it.

---

### P2-1 | Set Up Python Sidecar Process
- **Category:** Infrastructure
- **Priority:** 🔴 Critical
- **Effort:** 1 day

Create `python-engine/` directory in the project root. Single Python process (`engine.py`) that Electron spawns on startup via `child_process.spawn()`. Communication via JSON over stdin/stdout — no ports, no HTTP server needed.

Each request: `{ id, type, payload }` in  
Each response: `{ id, result, error }` out

This becomes the single integration point for all AI tasks.

**Dependencies:** Python 3.11+, virtualenv. User installs Python once via installer.

---

### P2-2 | Replace Ollama with llama-cpp-python
- **Category:** AI Infrastructure
- **Priority:** 🔴 Critical
- **Effort:** 1 day

Inside the Python sidecar:
- Install `llama-cpp-python` (CPU build)
- Download Phi-3 Mini Q4 GGUF (1.9GB) or Mistral 7B Q4 (4.1GB) on first run
- Keep model loaded in memory — load once on sidecar startup, not per request
- Exposes `generate(prompt, system, max_tokens, temperature)` internally

All AI calls from Electron route here instead of Ollama. Zero user setup difference — sidecar handles model download on first run.

**Key settings:**
- `n_ctx=2048`
- `n_threads=4` (CPU)
- `temperature=0.7` for chat
- `temperature=0.1` for extraction

---

### P2-3 | Build Deterministic Priority Engine in Python
- **Category:** Core Engine
- **Priority:** 🔴 Critical
- **Effort:** 2-3 days

`python-engine/priority.py` — the most important file in the entire project.

Reads user's current state directly from SQLite and produces a ranked `Priority` list:

```
Priority {
  id,
  domain: email | task | finance | calendar,
  title,
  description,
  score: 0-100,
  action_type,
  action_params,
  silence: bool   ← if nothing matters, return silence=True
}
```

**Scoring rules (deterministic, no LLM):**

| Signal | Base Score | Modifiers |
|---|---|---|
| Overdue task | 80 | +5 per day overdue, cap 99 |
| Urgent email (unread) | 70 | +10 if financial, +10 if known contact |
| Subscription renewal < 3 days | 75 | +20 if already overdue |
| Calendar event < 2 hours away | 85 | +10 if linked task not done |
| Unread action email > 48h old | 60 | — |
| Spending spike >30% vs last month | 55 | — |

**Silence threshold:** if highest score < 40, return `silence=True`. ARIA says nothing.

This engine runs every time Today panel loads and every time `getUserState()` is called.

---

### P2-4 | Set Up ChromaDB for Semantic Search
- **Category:** AI Infrastructure
- **Priority:** 🟠 High
- **Effort:** 1 day

Install `chromadb` in the Python sidecar. Create a local persistent collection at `%APPDATA%/aria-bot/vectors/`.

**What gets indexed:**
- Email subjects + body previews (300 chars)
- Calendar event titles + descriptions
- Notes titles + content

Each document stores the SQLite row ID as metadata for retrieval.

This replaces the keyword-only search in `buildPersonalBrain`. When user asks "anything about AWS this month?" — semantic search returns the 5 most relevant emails, Python passes them as clean 400-token context to the LLM, LLM answers naturally.

---

### P2-5 | Build Incremental Indexing Pipeline
- **Category:** AI Infrastructure
- **Priority:** 🟠 High
- **Effort:** 1 day

After every email fetch, note save, and calendar sync — call the Python sidecar's `index(type, id, text)` method. Sidecar upserts the document into ChromaDB.

- On first run (setup): full index of existing data
- Ongoing: incremental updates only
- Fast for small collections (<10,000 docs) — no GPU needed

---

## PHASE 3 — COMMANDER UI (The Surface Transformation)
> **Why third:** Once the Python engine is running and producing ranked priorities, the UI transformation is mechanical. You're removing panels and rewiring Today to consume the engine's output.

---

### P3-1 | Remove 5 Panels from Navigation
- **Category:** UI Transformation
- **Priority:** 🔴 Critical
- **Effort:** 3 hours

Remove Mail, Tasks, Money, Notes from `PillNav`. The panel components (Mail.jsx, Remind.jsx, Money.jsx, Notes.jsx) **stay in the codebase** — they become deep-dive views that Today or Ask can navigate to if user explicitly asks. But they are not primary navigation.

**New nav: Today | Ask** (Settings via gear icon only)

The capabilities behind each panel still exist. The IPC handlers still exist. They're just not in the nav.

---

### P3-2 | Rebuild Today Panel as Single Executive Surface
- **Category:** UI Transformation
- **Priority:** 🔴 Critical
- **Effort:** 2 days

Today.jsx currently makes 11 IPC calls on mount and renders 7+ sections. Replace with one call: `getUserState()` → returns priority engine output.

**New Today layout:**
```
ARIA greeting (dynamic, based on score and time of day)

[If silence = true]
  "Nothing urgent. Last checked 2 min ago."

[If priorities exist]
  Priority 1 card — title, domain badge, proposed action
  Priority 2 card — (collapsed by default)
  Priority 3 card — (collapsed by default)

[Bottom strip]
  X tasks · Y emails · ₹Z this month
  "Ask ARIA anything..." → routes to Ask panel
```

Removed from Today: weather widget, habit tracker, weekly report, progress bar, analytics card, health summary, trip summary, contact suggestions, separate briefing section. All accessible via Ask if user wants them.

---

### P3-3 | Build Action Confirmation Component ✅ IMPLEMENTED
- **Category:** UI — New Component
- **Priority:** 🔴 Critical
- **Effort:** 1 day

New `ConfirmAction.jsx` component. Renders inside Ask.jsx when `chat-enhanced` returns a `proposedAction` object.

```
┌──────────────────────────────────────┐
│  📧 Reply to Sarah                   │
│  "Sure, I'll be there —              │
│   confirming attendance."            │
│                                      │
│  [Send Reply]    [Edit]    [Cancel]  │
└──────────────────────────────────────┘
```

**Three states:**
1. Pending — shown above
2. Executing — spinner
3. Done — green checkmark, fades out in 2s

**`proposedAction` shape:**
```json
{
  "type": "ai-draft-reply",
  "params": { "messageId": "...", "draft": "..." },
  "description": "Send reply to sarah@example.com",
  "reversible": false
}
```

On confirm, Ask.jsx calls the corresponding IPC handler directly. No LLM involved in execution.

---

### P3-4 | Update chat-enhanced to Return Proposals ✅ IMPLEMENTED
- **Category:** Backend
- **Priority:** 🔴 Critical
- **Effort:** 1 day

When intent routing detects an executable action — instead of executing it, return a proposal:

```json
{
  "text": "I'll reply to Sarah — 'Sure, I'll be there, confirming.'",
  "proposedAction": {
    "type": "ai-draft-reply",
    "params": { "messageId": "...", "draft": "Sure, I'll be there..." },
    "description": "Send reply to sarah@example.com",
    "reversible": false
  }
}
```

Ask.jsx checks for `proposedAction` in the response:
- If present → renders `ConfirmAction` component
- If not present → renders normal message bubble

**Actions that need confirmation:**
- Create reminder
- Send email reply
- Snooze email
- Block sender
- Delete subscription
- Complete task
- Archive email

---

## PHASE 4 — INTENT ROUTING
> **Why fourth:** With the confirmation layer in place, expanding intent coverage is safe. Misfire risk is eliminated because everything needs confirmation.

---

### P4-1 | Build Intent Pattern Table
- **Category:** Intelligence
- **Priority:** 🟠 High
- **Effort:** 2 days

`python-engine/intents.py` — pattern matching for the 30 most common user commands. No LLM required. Deterministic regex/keyword matching.

**Email intents:**
- "reply to {name}" → `ai-draft-reply`
- "snooze {name/subject} until {time}" → `snooze-email`
- "block {sender}" → `block-sender`
- "show emails from {name}" → `get-emails` with filter

**Task intents:**
- "remind me to {X} {time}" → `add-reminder`
- "done with {task}" → `complete-reminder`
- "snooze {task} to {time}" → `extend-reminder`

**Finance intents:**
- "how much did I spend on {category}?" → `nl-query`
- "cancel {subscription}" → `delete-subscription`
- "what's my balance?" → `get-spendable-balance`

**Calendar intents:**
- "what's on today?" → `get-calendar-events`
- "block {time} for {task}" → `add-reminder`

**RAG-routed (everything else):**
- "any emails about {topic}?" → semantic search
- "what did I decide about {topic}?" → RAG over notes + emails
- Anything unrecognised → LLM with RAG context

---

### P4-2 | Expand nl-query.js Patterns
- **Category:** Intelligence
- **Priority:** 🟡 Medium
- **Effort:** 1 day

`nl-query.js` already handles 7 domains. Add 10 more patterns:

- "how many emails from {sender}?"
- "show my {category} subscriptions"
- "what tasks are overdue?"
- "when is my next {event type}?"
- "what did I spend this week?"
- "which subscriptions renew this month?"
- "how many focus hours this week?"
- "what habits did I miss this week?"

All return instant SQL answers — no LLM, no sidecar, no delay.

---

## PHASE 5 — HUMAN-FEELING RESPONSES (The Voice Layer)
> **Why fifth:** Now that the engine is right and routing is right, tune how ARIA talks. This is the layer users feel.

---

### P5-1 | Separate Extraction vs Conversation Prompts
- **Category:** AI Quality
- **Priority:** 🟠 High
- **Effort:** 1 day

Two completely different prompt styles — currently mixed.

**Extraction prompts** (categorise email, parse reminder, extract transaction):
- Temperature: `0.1`
- System: `"Return only a JSON object. No explanation."`
- Input: raw email/text
- Output: structured JSON

**Conversation prompts** (chat response, briefing, summary):
- Temperature: `0.75`
- System: personality prompt (see P5-2)
- Input: clean RAG-retrieved context (300-500 tokens max)
- Output: natural language

Mixing them produces either stiff chat or unreliable extraction. Split into two separate call paths in the Python sidecar.

---

### P5-2 | Write a Personality System Prompt ✅ ALREADY COMPREHENSIVE
- **Category:** AI Quality
- **Priority:** 🟠 High
- **Effort:** 3 hours

Replace the rules-based system prompt with a personality-based one.

**Current (produces robotic output):**
> "You are ARIA. You have FULL access to user data. NEVER say you cannot access. NEVER ask which company..."

**Target (produces human output):**
> "You're ARIA — think of yourself as a sharp, observant assistant who's been working closely with this person for months. You know their habits, their finances, their email patterns. You speak like a knowledgeable friend — direct, clear, occasionally dry. You don't say 'I have access to your data' — you just use it, naturally, the way a person who knows someone would. You don't hedge. You don't over-explain. You answer what was asked, then stop."

Then give it RAG-retrieved context (not a 2,000-token dump) and let it respond naturally.

---

### P5-3 | Per-Task Temperature Tuning
- **Category:** AI Quality
- **Priority:** 🟡 Medium
- **Effort:** 2 hours

| Task | Temperature | Why |
|---|---|---|
| Email categorisation | 0.0 | Must be one of four exact words |
| Transaction extraction | 0.1 | Structured JSON output |
| Reminder parsing | 0.2 | Structured datetime output |
| Email summarisation | 0.5 | Factual but readable |
| Chat response | 0.75 | Natural, varied |
| Morning briefing | 0.8 | Engaging but not hallucinating |

Currently everything gets Ollama's default temperature. This single change meaningfully improves response quality at each task type.

---

## PHASE 6 — WRITE-BACK CAPABILITIES (ARIA Taking Action)
> **Why sixth:** Read capability is largely done. These are the missing write-back actions that complete the "commander" model.

---

### P6-1 | Email Reply Sending via Gmail API
- **Category:** Capability
- **Priority:** 🟠 High
- **Effort:** 1 day

Currently `ai-draft-reply` generates text and opens Gmail compose in the browser. Full loop:

1. Python sidecar generates reply draft
2. `chat-enhanced` returns it as a `proposedAction`
3. User confirms in ARIA
4. Electron calls new `send-reply` IPC handler
5. Gmail API sends the reply directly
6. User never leaves ARIA

**Requires:** adding `gmail.send` scope to Gmail OAuth (currently read-only). One-time OAuth re-consent from user.

---

### P6-2 | Fix WhatsApp Relay
- **Category:** Capability
- **Priority:** 🟡 Medium
- **Effort:** 3 hours

Fix two bugs in `send-whatsapp-briefing`:
1. References `overdue.text` — column is `title`
2. JSON extract issue with `json_extract(smart_action, '$.priority_score')`

Wire two triggers:
1. Daily brief push at briefing time setting
2. Any priority item with score > 85 triggers an alert

Outgoing only — no bidirectional commands. Test end-to-end with Twilio sandbox.

---

### P6-3 | Calendar Event Creation
- **Category:** Capability
- **Priority:** 🟢 Low
- **Effort:** 1 day

Currently ARIA only reads calendar (iCal URL — read-only). To create events:
- Switch to Google Calendar API (write-capable)
- "Block 2pm tomorrow for deep work" → `proposedAction` → confirm → creates event

Requires Google Calendar API scope in OAuth.

---

## PHASE 7 — ONBOARDING & POLISH
> **Why last:** Only matters once the core experience is solid. A polished onboarding for a broken core is wasted effort.

---

### P7-1 | Initial Setup / Onboarding Flow
- **Category:** UX
- **Priority:** 🟡 Medium
- **Effort:** 2 days

First-run experience:
1. ARIA asks for Gmail connect (OAuth)
2. iCal URL (optional)
3. Immediately runs full data ingest — last 30 days of email, calendar events, existing reminders
4. Shows "Getting to know you..." with progress indicator
5. When done: "I've read 847 emails, 12 calendar events, and found ₹34,200 in subscription costs. Here's what I think matters today."

First impression matters — this is what sells it to new users.

---

### P7-2 | Data Quality Indicators
- **Category:** UX
- **Priority:** 🟢 Low
- **Effort:** 1 day

Small status indicator in Today panel:
```
📧 847 emails indexed  |  📅 Synced 2h ago  |  💳 Transactions: last 34 days
```

If Gmail disconnected or calendar hasn't synced in >24h — show a gentle warning. Users need to know ARIA is working and has current data, otherwise they won't trust its signals.

---

### P7-3 | Remove Phase 3 Ghost Feature Handlers
- **Category:** Cleanup
- **Priority:** 🟢 Low
- **Effort:** 2 hours

~30 IPC handlers and preload bridge methods exist for features with no UI (contacts CRM, time tracking, reading list, health, travel). Keep the DB tables — data is valuable. Remove the IPC handlers and preload bridges. Reintroduce when there's a real surface for them.

---

## PHASE 8 — INTELLIGENCE LAYER ("Will It Feel Intelligent?")
> **Why now:** Everything works, but ARIA doesn't learn or remember. These three features are the difference between a tool and a companion. They make ARIA feel like it knows you over time.

---

### P8-1 | Learning Loop (Action Feedback) ✅ IMPLEMENTED
- **Category:** Intelligence
- **Priority:** 🟠 High
- **Effort:** 3 hours

ARIA scores and proposes actions, but never learns from what you confirm or cancel. If you keep cancelling WhatsApp alerts but always confirm email replies, ARIA should adjust. 

**Implementation:**

New `action_feedback` table:
```sql
action_feedback (
  id, action_type TEXT, confirmed INTEGER, context TEXT, created_at
)
```

On every confirm (`confirm-action`) → `recordActionFeedback(type, true)`  
On every dismiss (`dismiss-action`) → `recordActionFeedback(type, false)`

`getActionConfidenceWeight(actionType)` computes a multiplier from recent history:
- Looks at last 30 days of feedback for that action type
- Needs minimum 3 data points before adjusting (neutral until then)
- Maps confirm ratio to weight: 0% → 0.3x, 50% → 0.9x, 100% → 1.5x
- If weight < 0.5 (user dismisses >70% of the time), skip auto-proposal entirely

This feeds back into `chatEnhancedHandler`: before proposing an action, it checks the confidence weight. Actions the user repeatedly dismisses stop being proposed — ARIA learns what you actually want.

**Cost:** Zero. Pure SQLite reads/writes.

---

### P8-2 | Session Memory (Cross-Session Preferences) ✅ IMPLEMENTED
- **Category:** Intelligence
- **Priority:** 🟠 High
- **Effort:** 3 hours

The plan has ChromaDB for semantic search over data, but no memory of the conversation itself across sessions. If you tell ARIA "I'm not worried about AWS costs this month" — tomorrow it should remember that.

**Implementation:**

New `session_preferences` table:
```sql
session_preferences (
  id, key TEXT, value TEXT, source_message TEXT,
  ttl_days INTEGER DEFAULT 30, created_at, expires_at
)
```

**Preference detection patterns:**
- "don't worry about / stop alerting me about X" → TTL 30 days
- "I'm not worried/concerned about X" → TTL 30 days
- "I prefer / I always / I usually X" → TTL 60 days
- "from now on / going forward X" → TTL 90 days
- "my name/job/role/company is X" → permanent (TTL 0)
- "I work at/for X" → permanent

`detectAndStorePreference(message)` runs on every message in `chatEnhancedHandler`. Active preferences are injected into the AI system context under `USER PREFERENCES (remembered from past conversations)`. Expired preferences are auto-cleaned.

**Cost:** Zero. SQLite + one extra context block in prompts.

---

### P8-3 | Graceful "Ask About Action" Fallback ✅ IMPLEMENTED
- **Category:** Intelligence
- **Priority:** 🟠 High
- **Effort:** 2 hours

The intent routing (P4-1) covers known patterns, but what if the user asks to "do something about my emails" or "help me deal with this"? The fallback should be graceful — propose an action via LLM rather than saying "I don't understand."

**Implementation:**

In `chatEnhancedHandler`, when `intent === 'chat'` but the message contains action-seeking language (`do something`, `help me`, `can you`, `take action`, `handle`, `fix`, `deal with`), a special context hint is injected into the LLM system prompt:

> *"The user seems to want you to DO something. If you can figure out what action they want, propose it clearly. Suggest a specific next step they can confirm."*

Additionally, ABSOLUTE RULE #6 was added to the system prompt:
> *"If the user asks you to do something but the intent isn't clear, propose the most reasonable action based on context. Never say 'I don't understand' — always suggest something helpful."*

This means:
- Known intents → deterministic routing (no LLM)
- Unknown but action-seeking → LLM proposes something reasonable
- Unknown and conversational → normal chat response

**Cost:** Zero extra. Uses the same LLM call that would have happened anyway.

---

### Cost Note

You're in good shape. `llama-cpp-python` with Phi-3 Mini is free after download. ChromaDB is local and free. API calls only happen for edge cases. The Learning Loop and Session Memory are pure SQLite — zero cost. This architecture can run at near-zero cost indefinitely.

---

## Master Summary Table

| # | Task | Category | Priority | Effort | Status |
|---|---|---|---|---|---|
| P1-1 | Fix 4 confirmed bugs | Bug Fix | 🔴 Critical | 2h | ✅ Done |
| P1-2 | Delete mail.js | Cleanup | 🔴 Critical | 30m | ✅ Done |
| P1-3 | Deduplicate transaction extraction | Refactor | 🔴 Critical | 3h | ✅ Done |
| P1-4 | Deduplicate subscription backfill | Refactor | 🟠 High | 2h | ✅ Done |
| P1-5 | Merge chat handlers | Refactor | 🟠 High | 2h | ✅ Done |
| P1-6 | Consolidate OAuth | Cleanup | 🟡 Medium | 1h | ✅ Done |
| P1-7 | nowUnix / todayISO helpers | Cleanup | 🟢 Low | 30m | ✅ Done |
| P2-1 | Python sidecar process | Infrastructure | 🔴 Critical | 1d | ✅ Done |
| P2-2 | Replace Ollama → llama-cpp-python | AI Infra | 🔴 Critical | 1d | ✅ Done |
| P2-3 | Deterministic priority engine | Core Engine | 🔴 Critical | 3d | ✅ Done |
| P2-4 | ChromaDB vector store | AI Infra | 🟠 High | 1d | ✅ Done |
| P2-5 | Incremental indexing pipeline | AI Infra | 🟠 High | 1d | ✅ Done |
| P3-1 | Remove 5 panels from nav | UI | 🔴 Critical | 3h | ✅ Done |
| P3-2 | Rebuild Today as executive surface | UI | 🔴 Critical | 2d | ✅ Done |
| P3-3 | Action confirmation component | UI | 🔴 Critical | 1d | ✅ Done |
| P3-4 | chat-enhanced returns proposals | Backend | 🔴 Critical | 1d | ✅ Done |
| P4-1 | Intent pattern table (Python) | Intelligence | 🟠 High | 2d | ✅ Done |
| P4-2 | Expand nl-query patterns | Intelligence | 🟡 Medium | 1d | ✅ Done |
| P5-1 | Separate extraction vs chat prompts | AI Quality | 🟠 High | 1d | ✅ Done |
| P5-2 | Personality system prompt | AI Quality | 🟠 High | 3h | ✅ Done |
| P5-3 | Per-task temperature tuning | AI Quality | 🟡 Medium | 2h | ✅ Done |
| P6-1 | Email reply sending via Gmail API | Capability | 🟠 High | 1d | ✅ Done |
| P6-2 | Fix WhatsApp relay | Capability | 🟡 Medium | 3h | ✅ (via P1-1) |
| P6-3 | Calendar event creation | Capability | 🟢 Low | 1d | ❌ Not Started |
| P7-1 | Onboarding flow | UX | 🟡 Medium | 2d | ✅ Done |
| P7-2 | Data quality indicators | UX | 🟢 Low | 1d | ✅ Done |
| P7-3 | Remove ghost feature handlers | Cleanup | 🟢 Low | 2h | ✅ Done |
| P8-1 | Learning Loop (action feedback) | Intelligence | 🟠 High | 3h | ✅ Done |
| P8-2 | Session Memory (cross-session prefs) | Intelligence | 🟠 High | 3h | ✅ Done |
| P8-3 | Graceful action fallback | Intelligence | 🟠 High | 2h | ✅ Done |

---

## Effort Summary

| Phase | Focus | Estimated Effort |
|---|---|---|
| Phase 1 | Stability (bugs + cleanup) | 2 days |
| Phase 2 | Python brain (sidecar + RAG + priority engine) | 7 days |
| Phase 3 | Commander UI (surface transformation) | 5 days |
| Phase 4 | Intent routing | 3 days |
| Phase 5 | Voice layer (human responses) | 2 days |
| Phase 6 | Write-back capabilities | 2 days |
| Phase 7 | Onboarding + polish | 3 days |
| Phase 8 | Intelligence layer (learning + memory + fallback) | 1 day |
| **Total** | | **~26 working days** |

**Minimum Viable ARIA** (P1 + P2 + P3 + P5-2 only): **~14 working days**

---

---

## Session 2 — Implementation Log (2026-02-25)

### Phase 1: Stability (ALL 7 TASKS COMPLETE)

**P1-1 — Fix 4 confirmed bugs** `electron/main.js`
- WhatsApp briefing: `SELECT text` → `SELECT title` (tasks table has `title`)
- Meeting stats: `start_time` → `start_at` (3 occurrences in meetings queries)
- Habit completion: `SELECT name, icon` → `SELECT id, name, icon` (id needed for completion lookup)
- Spending queries: added `source_email_id` to spending INSERT; added `source, source_ref` to SELECT

**P1-2 — Delete mail.js** `services/mail.js` → `mail.js.deprecated`
- Removed `mailService` require at top of main.js
- Removed `mailService` variable declaration
- Replaced 5 IMAP fallback call sites with Gmail-or-error returns
- Renamed file to `mail.js.deprecated`

**P1-3 — Deduplicate transaction extraction** `services/financial-intel.js` + `electron/main.js`
- Created `persistTransactions(db, lookbackDays=90)` in financial-intel.js Section G
- Replaces 3 inline extraction+INSERT blocks in main.js with single function call

**P1-4 — Deduplicate subscription backfill** `services/financial-intel.js` + `electron/main.js`
- Created `persistSubscriptions(db)` in financial-intel.js Section G
- Replaces 2 inline subscription INSERT blocks in main.js with single function call

**P1-5 — Merge chat handlers** `electron/main.js`
- Extracted `async function chatEnhancedHandler(message, mode)` combining NL query routing, intent detection, memory context, and follow-up suggestions
- `chat` IPC handler now delegates to `chatEnhancedHandler` (thin wrapper)
- `chat-enhanced` handler calls `chatEnhancedHandler` directly

**P1-6 — Consolidate OAuth** `electron/main.js`
- `gmail-oauth-start` handler → returns `{ success: false, error: 'Deprecated...' }` stub
- All OAuth flows consolidated through `gmail-oauth-callback` and `gmail-check-auth`

**P1-7 — Helper functions** `electron/main.js`
- Added `const DAY = 86400`, `function nowUnix()`, `function todayISO()` at top of file
- Replaced 20+ `Math.floor(Date.now()/1000)` occurrences with `nowUnix()`
- Replaced 5+ inline date patterns with `todayISO()`

### Phase 3: Commander UI (3 of 4 TASKS COMPLETE)

**P3-1 — Remove panels from navigation** `src/App.jsx`
- `PANELS` array reduced from 6 entries to 2: `Today` + `Ask`
- `PANEL_ORDER` and keyboard shortcuts updated accordingly
- Hidden panel components still exist for future deep-link access

**P3-3 — ConfirmAction component** `src/components/ConfirmAction.jsx` (NEW, 107 lines)
- Props: `action { type, label, description, icon?, payload }`, `onConfirm`, `onDismiss`
- Built-in icon mapping for 8 action types (reminder, email, task, money, note, calendar, weather, habit)
- Loading → success → error state machine with auto-dismiss after 1.2s

**P3-4 — chat-enhanced returns proposals** `electron/main.js` + `electron/preload.js` + `src/components/panels/Ask.jsx`
- **Reminder intent**: AI parses text but does NOT save; returns `proposedAction: { type: 'reminder', label, description, payload: { title, due_at, recurring, category, priority_score } }`
- **Email intent**: Returns `proposedAction: { type: 'email', label: 'Refresh Inbox', description, payload: {} }` instead of auto-fetching
- **Weather intent**: Stays auto-execute (read-only, no side effects)
- **New IPC handler** `confirm-action`: switch on type → 'reminder' (INSERT + scheduleReminder) or 'email' (gmailService.fetchEmails)
- **Preload bridge**: Added `confirmAction: (type, payload) => ipcRenderer.invoke('confirm-action', type, payload)`
- **Ask.jsx**: Imports ConfirmAction, manages `pendingAction` state, renders confirmation card, handles confirm/dismiss

### Phase 5: Voice Layer

**P5-2 — Personality system prompt** ✅ Already comprehensive
- Verified the existing system prompt in `chatEnhancedHandler` covers identity, tone, modes, absolute rules, and brain context injection
- No changes needed

### Encoding Corruption Fix (Emergency)
- **Root cause**: PowerShell 5.1 `Set-Content -Encoding UTF8` double-encoded main.js through Windows-1252
- **Symptoms**: Myanmar characters (န) instead of em dashes (—), box drawing chars, arrow chars, broken emojis, invisible C1 control characters
- **Resolution**: 7 progressive fix scripts culminating in `fix-definitive.js`
  - 1,269 global character replacements (Myanmar→—, box drawing→─, etc.)
  - 8 Khmer+FFFD → emoji pair fixes (🔍, 📬, 🌧)
  - 488 C1 control characters (U+0080-U+009F) removed
  - 16 remaining FFFD replaced with correct chars (₹, 📋, 🔥, •, 📌, ⚠, 📧)
- **Final state**: 0 C1 controls, 0 FFFD, 0 suspicious characters — **FILE IS CLEAN**

### Build & Launch Verification
- `npm run build` — ✓ 1,263 modules transformed, all chunks generated
- `npx electron .` — ✓ App launches without console errors

---

## Session 3 — Implementation Log (2026-02-26)

### Phase 2: Python Sidecar (ALL 5 TASKS COMPLETE)

**P2-1 — Python sidecar process** `electron/main.js` + `python-engine/engine.py`
- Added `startPythonSidecar()`, `callPython()`, `stopPythonSidecar()` to main.js
- JSON newline protocol: `{ id, type, payload }` → `{ id, result, error }`
- Sidecar spawned in `app.whenReady()`, killed in `before-quit`
- Incremental indexing fire-and-forget after each email sync

**P2-2 — llama-cpp-python wrapper** `python-engine/llm.py` (NEW)
- `LocalLLM` class with lazy-load of `llama_cpp.Llama`
- Auto-downloads Phi-3 Mini Q4 GGUF to `%APPDATA%/aria-bot/models/` on first use
- ARIA persona system prompt; extraction mode (JSON-only, temp 0.0) vs chat mode (temp 0.75)

**P2-3 — Deterministic priority engine** `python-engine/priority.py` (NEW)
- Reads SQLite directly via `sqlite3`; scores items across email/task/finance/calendar domains
- Mirrors JS `get-user-state` scoring logic but runs in Python sidecar
- Returns ranked list with score, domain, action, and urgency flag

**P2-4 — ChromaDB vector store** `python-engine/vectors.py` (NEW)
- Lazy-imports chromadb; graceful fail if not installed
- Stores embeddings in `%APPDATA%/aria-bot/vectors/`
- Methods: `add_documents()`, `search()`, `delete_old()`

**P2-5 — Incremental indexing** `electron/main.js`
- After email fetch in `runBackgroundSync()`, calls `callPython('index', { emails })` non-blocking

### Phase 3: Commander UI

**P3-2 — Today panel executive surface** `src/components/panels/Today.jsx`
- Already implemented in Session 2; plan status updated

### Phase 4: Intent Routing (BOTH TASKS COMPLETE)

**P4-1 — Intent pattern table** `python-engine/intents.py` (NEW)
- 30 regex/keyword patterns across email, task, finance, calendar, habit intents
- Returns `{ intent, params }` with extracted entities

**P4-2 — Expand nl-query patterns** `services/nl-query.js`
- Added "emails from [sender]", "show [category] subscriptions", "renew this month", "spend this week", "next [event type]", "habits I missed"
- Updated `isDataQuery()` regex to match all new patterns

### Phase 5: Voice Layer (BOTH REMAINING TASKS COMPLETE)

**P5-1 — Separate extraction vs chat prompts** `services/ai.js`
- Verified: `intent`/`parse`/`categorise` tasks route to dedicated functions with JSON-focused prompts
- `chatWithFallback()` uses rich personality system prompt with brain context injection
- Separation already in place; plan status updated

**P5-3 — Per-task temperature tuning** `services/ai.js`
- Verified: `intent`=0.1, `parse`=0.1, `categorise`=0.1, `summarise`=0.1, `chat`=0.7
- Already implemented; plan status updated

### Phase 6: Write-Back Capabilities

**P6-1 — Email reply via Gmail API** `services/gmail.js` + `electron/main.js`
- `sendReply(originalMessageId, draft)` added to gmail.js
- Fetches original message headers; builds RFC 2822 MIME with `In-Reply-To`/`References`
- `confirm-action` handler extended with `send-reply` case
- Reply intent detection added to `chatEnhancedHandler` (regex: "reply to [name]")

### Phase 7: Onboarding & Polish (ALL 3 TASKS COMPLETE)

**P7-1 — Onboarding flow** `src/components/panels/Onboarding.jsx` (NEW) + `src/App.jsx`
- 4-step wizard: Intro → Gmail → iCal → Ingest → Done
- `has_completed_setup` setting gates first-run detection in App.jsx
- `complete-setup` IPC handler + `get-setting` IPC handler added to main.js
- `completeSetup`, `getSetting` bridges added to preload.js

**P7-2 — Data quality indicators** `src/components/panels/Today.jsx` + `electron/main.js`
- `quality` object added to `get-user-state` response: `{ emailIndexed, lastSyncMs, gmailConnected, calendarStale, txDays }`
- Quality strip added above Refresh button in Today.jsx
- Shows email count, transaction days, Gmail disconnected warning, calendar stale warning

**P7-3 — Remove ghost feature handlers** `electron/main.js` + `electron/preload.js`
- Removed 22 ghost IPC handlers: Contacts CRM, Time Tracking, Reading List, Health Tracking, Travel, Meeting Prep
- Removed corresponding preload bridges
- DB tables preserved; WhatsApp and other real handlers intact

---

## Session 4 — Implementation Log (2026-02-25)

### Phase 8: Intelligence Layer (ALL 3 TASKS COMPLETE)

**P8-1 — Learning Loop (action feedback)** `electron/main.js` + `electron/preload.js` + `src/components/panels/Ask.jsx` + `db/schema.sql` + `db/index.js`
- New `action_feedback` table with `action_type`, `confirmed`, `context`, `created_at`
- `recordActionFeedback(type, confirmed, context)` — writes feedback row on every confirm/dismiss
- `getActionConfidenceWeight(actionType)` — computes 0.3-1.5 multiplier from last 30 days of feedback; neutral (<3 data points), scales with confirm ratio
- `confirm-action` handler now calls `recordActionFeedback(type, true)` before executing
- New `dismiss-action` IPC handler calls `recordActionFeedback(type, false)` 
- New `get-action-feedback` IPC handler returns per-type stats (total, confirmed_count, dismissed_count)
- `chatEnhancedHandler` checks `shouldAutoPropose` flag before proposing reminder/email/reply actions
- Ask.jsx `onDismiss` now calls `window.aria.dismissAction()` to record negative feedback
- Preload bridges: `dismissAction`, `getActionFeedback`

**P8-2 — Session Memory (cross-session preferences)** `electron/main.js` + `electron/preload.js` + `db/schema.sql` + `db/index.js`
- New `session_preferences` table with `key`, `value`, `source_message`, `ttl_days`, `expires_at`
- `storeSessionPreference(key, value, sourceMessage, ttlDays)` — upsert with computed `expires_at`
- `getActiveSessionPreferences(limit)` — returns non-expired prefs, auto-cleans expired on each write
- `detectAndStorePreference(message)` — 6 regex patterns matching "don't worry about", "I prefer", "from now on", identity statements
- Session prefs injected into AI system context as `USER PREFERENCES (remembered from past conversations)` block
- New IPC handlers: `get-session-preferences`, `clear-session-preference`
- Preload bridges: `getSessionPreferences`, `clearSessionPreference`

**P8-3 — Graceful action fallback** `electron/main.js`
- When `intent === 'chat'` but message contains action-seeking language, `fallbackHint` injected into LLM system prompt
- Pattern detection: `do something|help me|can you|take action|handle|fix|deal with`
- Added ABSOLUTE RULE #6 to system prompt: "Never say 'I don't understand' — always suggest something helpful"
- Zero extra LLM calls — hint is appended to the same chat call that would happen anyway

---



### TC-01: Bug Fixes (P1-1)

| # | Test | Steps | Expected Result |
|---|------|-------|-----------------|
| 1.1 | WhatsApp briefing shows task titles | Ask "summarize my WhatsApp" or trigger WhatsApp intent | Briefing contains task `title` field values, not undefined |
| 1.2 | Meeting stats use correct column | Trigger today-stats or meeting summary | Queries use `start_at` column; no SQL errors |
| 1.3 | Habit completion status works | Ask about habits or trigger habit summary | Each habit includes `id` for completion lookup; shows completion status |
| 1.4 | Spending tracks source | Trigger financial extraction with emails containing transactions | Spending entries include `source` and `source_ref` columns |

### TC-02: Dead Code Removal (P1-2)

| # | Test | Steps | Expected Result |
|---|------|-------|-----------------|
| 2.1 | App starts without mail.js | Launch app normally | No "Cannot find module" errors; app starts cleanly |
| 2.2 | Email fetch uses Gmail only | Ask "check my email" | Uses Gmail API; if not authenticated, returns auth instructions (no IMAP fallback) |

### TC-03: Transaction Deduplication (P1-3)

| # | Test | Steps | Expected Result |
|---|------|-------|-----------------|
| 3.1 | Transactions persist once | Trigger extraction twice with same emails | `SELECT COUNT(*) FROM spending` shows no duplicate rows for same transaction |
| 3.2 | New transactions added | Add new email with new transaction | New spending row appears with correct amount, vendor, date |

### TC-04: Subscription Deduplication (P1-4)

| # | Test | Steps | Expected Result |
|---|------|-------|-----------------|
| 4.1 | Subscriptions persist once | Trigger subscription backfill twice | `SELECT COUNT(*) FROM subscriptions` shows no duplicate rows |
| 4.2 | New subscriptions detected | Add email with new subscription | New subscription row appears with correct name, amount, frequency |

### TC-05: Chat Handler Merge (P1-5)

| # | Test | Steps | Expected Result |
|---|------|-------|-----------------|
| 5.1 | `chat` IPC works | Send message via basic chat handler | Returns response from `chatEnhancedHandler()` |
| 5.2 | `chat-enhanced` IPC works | Send message via enhanced chat handler | Returns response with `reply`, `mode`, optional `proposedAction` |
| 5.3 | Mode routing works | Send message with mode="reminder" | Intent detection triggers reminder proposal flow |

### TC-06: OAuth Consolidation (P1-6)

| # | Test | Steps | Expected Result |
|---|------|-------|-----------------|
| 6.1 | Deprecated endpoint returns error | Call `gmail-oauth-start` IPC | Returns `{ success: false, error: 'Deprecated...' }` |
| 6.2 | Active OAuth still works | Call `gmail-oauth-callback` with valid code | Gmail auth completes successfully |

### TC-07: Helper Functions (P1-7)

| # | Test | Steps | Expected Result |
|---|------|-------|-----------------|
| 7.1 | `nowUnix()` returns correct timestamp | Check any code path using `nowUnix()` | Returns integer close to `Math.floor(Date.now()/1000)` |
| 7.2 | `todayISO()` returns correct date | Check any code path using `todayISO()` | Returns string in `YYYY-MM-DD` format matching today |
| 7.3 | `DAY` constant is correct | Inspect value | Equals `86400` |

### TC-08: Panel Navigation (P3-1)

| # | Test | Steps | Expected Result |
|---|------|-------|-----------------|
| 8.1 | Only 2 panels visible | Launch app, check PillNav | Only "🌅 Today" and "✦ Ask" pills shown |
| 8.2 | Keyboard shortcuts work | Press assigned keyboard shortcuts | Switches between Today and Ask panels |
| 8.3 | Hidden panels accessible via code | Call `handlePanelChange('finance')` | Panel renders correctly (component still exists) |

### TC-09: ConfirmAction Component (P3-3)

| # | Test | Steps | Expected Result |
|---|------|-------|-----------------|
| 9.1 | Component renders | Pass valid `action` prop with type "reminder" | Card shows icon (⏰), label, description, Confirm/Dismiss buttons |
| 9.2 | Confirm triggers callback | Click Confirm button | `onConfirm(payload)` called; loading state shown; success state with checkmark |
| 9.3 | Dismiss clears card | Click Dismiss button | `onDismiss()` called; card removed |
| 9.4 | Auto-dismiss after success | Confirm action, wait 1.2s | Card auto-removes after success animation |
| 9.5 | Error state renders | `onConfirm` throws/rejects | Error message displayed on card |

### TC-10: Commander Model — Proposals (P3-4)

| # | Test | Steps | Expected Result |
|---|------|-------|-----------------|
| 10.1 | Reminder returns proposal | Type "remind me to call mom at 5pm" in Ask | Response includes `proposedAction` with type "reminder", parsed title/due_at; ConfirmAction card renders |
| 10.2 | Email returns proposal | Type "check my email" in Ask | Response includes `proposedAction` with type "email"; ConfirmAction card renders |
| 10.3 | Weather auto-executes | Type "what's the weather?" in Ask | Weather data returned directly; NO ConfirmAction card |
| 10.4 | Confirm reminder saves to DB | Click Confirm on reminder proposal | `reminders` table gets new row; reminder scheduled; success message shown |
| 10.5 | Confirm email fetches inbox | Click Confirm on email proposal | Gmail API called; email results returned; success message shown |
| 10.6 | Dismiss cancels action | Click Dismiss on any proposal | No DB changes; no API calls; card removed |

### TC-11: Personality (P5-2)

| # | Test | Steps | Expected Result |
|---|------|-------|-----------------|
| 11.1 | Casual tone in responses | Ask any general question | Response uses friendly, casual tone per personality prompt |
| 11.2 | Brain context injected | Ask about personal data (tasks, meetings) | Response references real user data from DB |
| 11.3 | Identity maintained | Ask "who are you?" | Responds as ARIA with defined personality traits |

### TC-12: Build & Runtime

| # | Test | Steps | Expected Result |
|---|------|-------|-----------------|
| 12.1 | Production build succeeds | Run `npm run build` | Exit code 0; all modules transformed; no errors |
| 12.2 | App launches cleanly | Run `npx electron .` | Window opens; no console errors; no crash |
| 12.3 | No encoding corruption | Inspect main.js for Unicode anomalies | 0 C1 control chars; 0 FFFD replacements; all emojis render correctly |

### TC-13: Python Sidecar (P2-1 to P2-5)

| # | Test | Steps | Expected Result |
|---|------|-------|-----------------|
| 13.1 | Sidecar starts on app launch | Launch app; check console | `[Python]` log lines appear; sidecar process spawned |
| 13.2 | Sidecar responds to ping | App startup IPC `callPython('ping', {})` | Returns `{ pong: true }` within 10s |
| 13.3 | Priority scoring works | Sidecar call with `type: 'priority'` | Returns ranked list of items with numeric scores |
| 13.4 | Intent matching works | Sidecar call `type: 'intent'`, payload `"remind me to call mom"` | Returns `{ intent: 'reminder', params: { text: 'call mom' } }` |
| 13.5 | Vector indexing works | After email sync, check ChromaDB | `vectors.py` indexes emails without crash; graceful fail if chromadb missing |
| 13.6 | Sidecar killed on quit | Quit app normally | Python process exits; no zombie processes |

### TC-14: Today Panel Executive Surface (P3-2)

| # | Test | Steps | Expected Result |
|---|------|-------|-----------------|
| 14.1 | Today panel loads | Open app, stay on Today tab | Priority cards render; stat strip visible; no loading errors |
| 14.2 | Silence mode shows | When no urgent items | Green silence card shown instead of empty list |
| 14.3 | Priority cards expand | Click a priority card | Card expands to show detail; chevron rotates |
| 14.4 | Stats strip shows counts | Today panel with data | Tasks/Emails/Spend counts show real numbers |
| 14.5 | Data quality strip | Panel with Gmail connected | Email count and last-sync time shown |
| 14.6 | Gmail disconnect warning | Gmail not authenticated | Orange "Gmail disconnected" badge shown in quality strip |
| 14.7 | Calendar stale warning | Calendar sync >24h old | Yellow "Calendar stale" badge shown |
| 14.8 | Refresh button works | Click refresh | Panel re-fetches `get-user-state`; updated data shown |

### TC-15: Expanded NL Queries (P4-1, P4-2)

| # | Test | Steps | Expected Result |
|---|------|-------|-----------------|
| 15.1 | "emails from [sender]" | Ask "show emails from John" | Returns filtered email list from john |
| 15.2 | "category subscriptions" | Ask "show streaming subscriptions" | Returns subscriptions matching that category |
| 15.3 | "renew this month" | Ask "which subscriptions renew this month?" | Returns subscriptions with billing date this month |
| 15.4 | "spent this week" | Ask "what did I spend this week?" | Returns total spend with breakdown for last 7 days |
| 15.5 | "next [event type]" | Ask "when is my next meeting?" | Returns next calendar event matching that type |
| 15.6 | "habits I missed" | Ask "what habits did I miss?" | Returns habits not completed today |

### TC-16: Prompt Separation & Temperature (P5-1, P5-3)

| # | Test | Steps | Expected Result |
|---|------|-------|-----------------|
| 16.1 | Intent classification uses temp 0.1 | Ask action-oriented message | `classifyIntent()` called with temp 0.1; deterministic result |
| 16.2 | Reminder parsing uses temp 0.1 | "remind me at 3pm" | `parseReminder()` returns structured JSON; no prose |
| 16.3 | Chat uses temp 0.7 | Ask open-ended question | `chatWithFallback()` called with temp 0.7; varied, natural response |
| 16.4 | Email categorisation uses temp 0.1 | Categorise email during sync | `categorise()` returns single word from valid list |

### TC-17: Email Reply via Gmail API (P6-1)

| # | Test | Steps | Expected Result |
|---|------|-------|-----------------|
| 17.1 | Reply intent detected | Ask "reply to the email from Sarah" | Chat returns `proposedAction` with type `send-reply`, draft text, target messageId |
| 17.2 | Confirm sends reply | Click Confirm on reply proposal | Gmail `messages/send` called; RFC 2822 MIME with thread headers |
| 17.3 | Reply threads correctly | Check Gmail after confirm | Reply appears in same thread as original message |
| 17.4 | Dismiss cancels | Click Dismiss on reply proposal | No Gmail API call; card removed |
| 17.5 | Missing email graceful fail | "reply to email from unknown" | Returns helpful error text; no crash |

### TC-18: Ghost Handler Removal (P7-3)

| # | Test | Steps | Expected Result |
|---|------|-------|-----------------|
| 18.1 | Removed IPC handlers gone | Call `get-contacts` from DevTools | Returns `undefined` or IPC error (not 404) |
| 18.2 | No preload bridges for ghosts | Check preload.js | `window.aria.getContacts` is undefined |
| 18.3 | Remaining handlers intact | Call `get-user-state` IPC | Returns priority state normally |
| 18.4 | WhatsApp handler intact | Call `send-whatsapp-briefing` | Returns response (success or "not configured") |
| 18.5 | DB tables preserved | Check `contacts`, `trips` tables | Tables still exist in SQLite; just no IPC access |

### TC-19: Onboarding Flow (P7-1)

| # | Test | Steps | Expected Result |
|---|------|-------|-----------------|
| 19.1 | Shown on first launch | Delete `has_completed_setup` setting, relaunch | Onboarding panel renders before Today |
| 19.2 | Skip Gmail works | Click "Skip for now" on Gmail step | Moves to iCal step without error |
| 19.3 | iCal URL saved | Enter iCal URL, click Continue | `getSetting('calendar_url')` returns entered URL |
| 19.4 | Ingest progress shown | Continue from iCal step | Progress text updates through sync steps |
| 19.5 | Done screen appears | Sync completes | Green check, "You're all set!" message, Open button |
| 19.6 | Not shown on return | `has_completed_setup = 1`, relaunch | Today panel shown directly; onboarding not rendered |
| 19.7 | complete-setup IPC sets flag | Call `complete-setup` | `getSetting('has_completed_setup')` returns `"1"` |

### TC-20: Data Quality Indicators (P7-2)

| # | Test | Steps | Expected Result |
|---|------|-------|-----------------|
| 20.1 | Email count shown | Today panel with emails in DB | "N emails indexed" shown in quality strip |
| 20.2 | Transaction days shown | Today panel with recent transactions | "Nd tx data" shown in quality strip |
| 20.3 | Gmail warning when disconnected | Remove gmail token from settings | Orange "⚠ Gmail disconnected" badge visible |
| 20.4 | Calendar stale warning | Set last_calendar_sync_at to >24h ago | Yellow "⚠ Calendar stale" badge visible |
| 20.5 | No warnings when healthy | Gmail connected, calendar fresh | No warning badges; only count info shown |

### TC-21: Learning Loop (P8-1)

| # | Test | Steps | Expected Result |
|---|------|-------|-----------------|
| 21.1 | Feedback recorded on confirm | Ask "remind me to call mom at 5pm", click Confirm | `action_feedback` table has row: `action_type='reminder', confirmed=1` |
| 21.2 | Feedback recorded on dismiss | Ask "check my email", click Dismiss (Nah) | `action_feedback` table has row: `action_type='email', confirmed=0` |
| 21.3 | Confidence weight neutral | New action type with <3 feedback entries | `getActionConfidenceWeight` returns 1.0 (neutral) |
| 21.4 | Confidence weight adjusts | Dismiss same action 5+ times | Weight drops below 0.5; proposals for that type stop appearing |
| 21.5 | High confirm rate boosts | Confirm same action 5+ times | Weight above 1.0; proposals remain active |
| 21.6 | Feedback stats API | Call `get-action-feedback` IPC | Returns stats with confirmed_count, dismissed_count per type |
| 21.7 | dismiss-action IPC works | Call `window.aria.dismissAction('reminder', {})` | Returns `{ ok: true }` |

### TC-22: Session Memory (P8-2)

| # | Test | Steps | Expected Result |
|---|------|-------|-----------------|
| 22.1 | Preference detected — don't worry | Send "I'm not worried about AWS costs this month" | `session_preferences` table has row with key containing 'aws-costs', TTL 30 days |
| 22.2 | Preference detected — permanent | Send "I work at Google" | `session_preferences` row with TTL 0 (permanent), no expires_at |
| 22.3 | Preference detected — from now on | Send "from now on, always show me tasks first" | Row with TTL 90 days |
| 22.4 | Preferences injected in context | After storing prefs, send any question | AI system prompt includes `USER PREFERENCES` section with stored prefs |
| 22.5 | Expired prefs cleaned | Insert pref with expired TTL, send any message | Expired row deleted from table |
| 22.6 | get-session-preferences IPC | Call `window.aria.getSessionPreferences()` | Returns array of active non-expired preferences |
| 22.7 | clear-session-preference IPC | Call `window.aria.clearSessionPreference(1)` | Preference with id=1 deleted; returns `{ ok: true }` |
| 22.8 | Non-preference messages ignored | Send "what's the weather?" | No new row in `session_preferences` |

### TC-23: Graceful Action Fallback (P8-3)

| # | Test | Steps | Expected Result |
|---|------|-------|-----------------|
| 23.1 | Action-seeking → proposal | Send "can you do something about my overdue tasks?" | ARIA proposes a specific action (e.g. "Want me to list your overdue tasks?") instead of "I don't understand" |
| 23.2 | "help me deal with" | Send "help me deal with my inbox" | ARIA suggests a concrete step like refreshing emails or showing unread |
| 23.3 | Normal chat unaffected | Send "what did I have for lunch?" | Normal conversational response; no forced action proposal |
| 23.4 | Unknown verb handled | Send "handle my subscriptions" | ARIA proposes something relevant (e.g. showing renewal dates) |
| 23.5 | System prompt rule #6 | Send any vague request | Response never says "I don't understand" — always proposes something helpful |

---

## Session 5 — Implementation Log (2026-02-25)

### Phase 9: Local-First Architecture & Production Hardening (ALL 4 TASKS COMPLETE)

**P9-1 — Local-First AI Routing** `electron/main.js`
- Chat now routes through Python sidecar LLM (Phi-3 Mini Q4) FIRST, before any external API
- Intent classification: Python sidecar pattern matcher → Ollama → default 'chat'
- Chat response: Python sidecar `callPython('generate')` → `aiService.aiCall('chat')` (Ollama → Grok → Gemini)
- 30s timeout for local LLM generation, 5s for intent classification
- `aiProvider` field returned with every chat response (`local-llm` / `ai-service` / `fallback-message`)
- Graceful fallback: if all AI backends fail, provides helpful error message with install instructions
- Console logs which provider handled each request for debugging

**P9-2 — Mandatory Onboarding Gate** `src/App.jsx` + `src/components/panels/Onboarding.jsx`
- BotHeader and PillNav hidden during onboarding — no accidental navigation
- Keyboard shortcuts (Ctrl+1-6, Ctrl+K, Ctrl+/) blocked while `showOnboarding === true`
- Fixed broken IPC calls: `startGmailAuth` → `connectGmail`, `triggerSync` → `refreshEmails`, `syncCalendar` → `getCalendarEvents`
- Fixed setting key: `calendar_url` → `calendar_ical_url` (matches schema)
- Onboarding ingest now runs full pipeline: emails → categorize → calendar → financial scan

**P9-3 — Secrets via .env File** `electron/main.js` + `services/haiku.js` + `services/grok.js` + `services/gmail-oauth.js`
- Zero-dependency `.env` loader in main process (reads `project/.env` then `%APPDATA%/aria-bot/.env`)
- Priority chain: `process.env` → keytar → settings DB for all API keys
- `GEMINI_API_KEY` env var → `haiku.js` `getClient()`
- `GROK_API_KEY` env var → `grok.js` `getClient()`
- `GMAIL_CLIENT_ID` / `GMAIL_CLIENT_SECRET` env vars → `gmail-oauth.js` (auth URL, token exchange, refresh)
- `get-settings` IPC handler merges 17 env vars as overrides (IMAP, Twilio, weather, calendar, profile, briefing)
- `get-api-key` / `get-grok-api-key` check env first, return `source: 'env'` when applicable
- Settings UI shows `.env` tip banner with `FileText` icon
- Created `.env.example` template with all configurable keys
- Created `.gitignore` excluding `.env`, `node_modules`, build output, `*.gguf`

**P9-4 — End-to-End Intelligence Pipeline** `electron/main.js` + `src/components/panels/Onboarding.jsx`
- `complete-setup` handler now triggers full pipeline (fire-and-forget):
  1. `routeEmailInsights()` — tasks from deadlines, urgent actions
  2. `financialIntel.persistTransactions()` — extract spending from emails
  3. `financialIntel.persistSubscriptions()` — detect recurring payments
  4. ChromaDB vector indexing — up to 100 emails indexed for semantic search
  5. Reminders + notes indexed into vector store
  6. Calendar-task linking via `calendarIntelService`
- `buildPersonalBrain()` now `async` — queries ChromaDB vector store for semantic results
- Semantic search results injected as "🧠 SEMANTIC SEARCH" section in AI context
- Onboarding `runIngest()` runs categorization + financial scan inline before completing

### Files Modified (Session 5)
| File | Changes |
|------|---------|
| `electron/main.js` | .env loader, local-first AI routing, async buildPersonalBrain, vector search, pipeline on setup |
| `services/haiku.js` | env var priority for Gemini API key |
| `services/grok.js` | env var priority for Grok API key |
| `services/gmail-oauth.js` | env var priority for Gmail OAuth client ID/secret |
| `src/App.jsx` | Onboarding gates BotHeader, PillNav, keyboard shortcuts |
| `src/components/panels/Onboarding.jsx` | Fixed IPC calls, added categorize + financial scan to ingest |
| `src/components/panels/Settings.jsx` | .env tip banner |
| `.env.example` | New file — template for all configurable secrets/settings |
| `.gitignore` | New file — excludes .env, node_modules, dist, models |

---

*This document is the single source of truth for ARIA's implementation roadmap.*  
*Update it as tasks are completed.*

---

## PHASE 10 — INTELLIGENCE LAYERS (The ₹499/Month Features)
> **Why now:** Foundation is solid (Phases 1-9). These 5 layers create switching cost, prove ROI, and turn ARIA from a "useful organizer" into an "intelligent agent worth paying for."

---

### P10-1 | Learning Layer — Signal-Level Behavioral Learning
- **Category:** Intelligence Engine
- **Priority:** 🔴 Critical
- **Effort:** 1 day

**Goal:** ARIA learns from what the user acts on, dismisses, or ignores on the Today panel. Scores adjust over time so the priority list gets smarter.

**DB Changes:**
- New table: `signal_interactions` — tracks every time a user acts on, dismisses, or ignores a Today card
- New table: `signal_adjustments` — stores learned multipliers per signal type
- New table: `sender_profiles` — tracks per-sender response patterns and importance

**Backend Changes (electron/main.js):**
- Add `trackSignalInteraction(signalId, action)` — records 'acted', 'dismissed', 'ignored'
- Add `computeSignalAdjustment(signalType)` — analyzes last 30 days of interactions, returns 0.5x-1.5x multiplier
- Add `applyLearning(priority)` — applies stored multiplier to priority score before returning to UI
- Modify `get-user-state` handler — apply learning adjustments to every priority before sorting
- IPC: `track-signal` — called from Today panel when user interacts with cards
- IPC: `get-signal-stats` — returns learning stats for diagnostics

**Frontend Changes (Today.jsx):**
- Track when cards are acted on (clicked action button) vs dismissed (swipe/close)
- Track "ignored" — cards that were visible for 10+ seconds without interaction
- Show "learned" indicator on cards that have been adjusted

**Why it matters:** After 4 weeks, ARIA knows "emails from Priya = always ignore" and stops showing them. Switching cost: lose all this learning.

---

### P10-2 | Predictive Engine — Prevent Problems Before They Happen
- **Category:** Intelligence Engine
- **Priority:** 🔴 Critical
- **Effort:** 1 day

**Goal:** ARIA predicts time needed for tasks, warns about tight deadlines in advance, and generates preparation signals.

**DB Changes:**
- New table: `task_time_logs` — tracks start/end time per task for historical estimation
- New table: `prediction_signals` — stores generated prediction alerts

**Backend Changes (electron/main.js):**
- Add `predictTimeNeeded(task)` — looks at completed similar tasks, returns estimated hours + confidence
- Add `predictTaskRisk(task)` — compares estimated hours needed vs hours until deadline
- Add `generatePredictionSignals()` — scans upcoming tasks (next 7 days), generates risk alerts
- Inject prediction signals into `get-user-state` priorities with domain='prediction'
- IPC: `log-task-time` — records time spent when a task is completed
- IPC: `get-predictions` — returns current prediction alerts

**Frontend Changes (Today.jsx):**
- New domain icon for predictions: ⏱️
- Prediction cards show: estimated time, hours remaining, risk level
- Action buttons: "Block time", "Snooze", "Simplify"

**Why it matters:** Monday: "Proposal due Friday. You typically need 6h for proposals. Block Tuesday 10am-4pm?" Prevents Friday 4pm panic.

---

### P10-3 | Relationship Intelligence — Understand Who Matters
- **Category:** Intelligence Engine
- **Priority:** 🟠 High
- **Effort:** 1 day

**Goal:** ARIA classifies email senders based on YOUR behavior patterns (not regex), detects relationship gaps, and adjusts email priority by relationship type.

**DB Changes:**
- Extend `contacts` table: add `relationship_type`, `response_rate`, `avg_response_hours`, `importance_score`, `last_analyzed_at`
- New table: `email_interactions` — tracks direction (inbound/outbound), replied flag, response_time per sender

**Backend Changes (electron/main.js):**
- Add `analyzeRelationship(senderEmail)` — looks at email history, computes response rate, frequency, classifies as boss/client/colleague/newsletter
- Add `detectRelationshipRisks()` — finds contacts where gap since last contact > 2x normal frequency
- Add `getRelationshipContext(senderEmail)` — returns classification + communication patterns for AI context
- Modify email priority scoring — factor in sender relationship type (boss = +30, client = +20, newsletter = -40)
- Inject relationship risk signals into `get-user-state`
- IPC: `analyze-relationships` — triggers relationship analysis for all contacts
- IPC: `get-relationship-profile` — returns profile for a specific sender

**Frontend Changes (Today.jsx + Mail.jsx):**
- Email cards show relationship badge: 👔 Boss, 💼 Client, 👥 Colleague, 📰 Newsletter
- Relationship risk cards: "12 days since last contact with Acme Corp (normally every 5 days)"
- New domain icon for relationship: 🤝

**Why it matters:** Email from boss at 8am = urgent (score 95). Newsletter from same time = auto-archived (score 5). Same inbox, completely different handling.

---

### P10-4 | Context Memory — Remember What You're Working On
- **Category:** Intelligence Engine
- **Priority:** 🟠 High
- **Effort:** 1 day

**Goal:** ARIA extracts entities (people, companies, projects) from conversations and links related items across emails, tasks, and notes. When an Acme email arrives, ARIA knows "this relates to the proposal you started Monday."

**DB Changes:**
- New table: `context_threads` — stores active project/topic contexts with extracted entities
- New table: `context_links` — links context_threads to specific emails, tasks, notes by item_type + item_id
- New table: `context_entities` — extracted people, companies, projects from each context

**Backend Changes (electron/main.js):**
- Add `extractEntities(text)` — uses keyword extraction (no LLM needed) to find people names, company names, project keywords
- Add `storeContext(source, text, entities)` — creates context thread and links related DB items
- Add `linkRelatedItems(contextId, entities)` — searches emails, tasks, notes for matching entities and links them
- Add `getContextForItem(itemType, itemId)` — returns active context threads related to an item
- Modify `buildPersonalBrain()` — inject active context threads into AI context
- Modify chat memory handler — auto-extract entities when user mentions working on something
- IPC: `get-active-contexts` — returns current active context threads
- IPC: `link-context` — manually link an item to a context

**Frontend Changes (Ask.jsx, MessageBubble):**
- Bot messages show context badge when related: "🧵 Related to: Acme proposal (since Monday)"
- Active contexts shown in memory panel

**Why it matters:** Friday: "Email from Acme replied to proposal" + [Context: proposal you've been working on since Monday] + [Related: 3 emails, 2 tasks, 1 note]. Feels like ARIA "knows" what you're doing.

---

### P10-5 | Outcome Tracking — Prove ARIA's Value with ROI
- **Category:** Intelligence Engine
- **Priority:** 🟠 High
- **Effort:** 1 day

**Goal:** Track time saved, problems prevented, and calculate weekly ROI so users can see concrete value and justify the cost.

**DB Changes:**
- New table: `time_saved_log` — records time-saving events (email triage, auto-scheduling, etc.)
- New table: `prevented_issues` — records prevented problems (missed deadline, late payment, forgotten follow-up)
- New table: `outcome_snapshots` — weekly aggregated ROI snapshots

**Backend Changes (electron/main.js):**
- Add `trackTimeSaved(activity, minutes, details)` — records a time-saving event
- Add `trackPreventedIssue(type, details, estimatedCost)` — records a prevented problem
- Add `generateOutcomeReport()` — aggregates last 7 days of time saved + prevented issues, calculates ROI
- Auto-track: email triage time saved (count/50 * 0.5 min per email), task auto-prioritization (5 min/day), bill reminder catch (estimated late fee)
- Modify `confirm-action` handler — record time saved when user confirms an action
- Modify `get-user-state` — record prevented issues when showing overdue warnings
- IPC: `get-outcome-report` — returns current weekly outcome data
- IPC: `get-outcome-history` — returns last 12 weeks of snapshots

**Frontend Changes:**
- New `OutcomeReport` section in Today panel (below stat strip): "This week: 1.5h saved · 2 issues caught · ROI: 6x"
- Weekly summary card shown every Monday with full breakdown
- Expandable to see details: which emails triaged, which deadlines caught, etc.

**Why it matters:** "ARIA saved me 2.3 hours and caught ₹500 in late fees this week. At ₹499/month, that's 9x ROI." Makes renewal obvious.

---
