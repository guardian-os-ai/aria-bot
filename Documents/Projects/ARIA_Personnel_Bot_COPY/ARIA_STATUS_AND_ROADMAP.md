# ARIA — What We Built, Where We Are, and What's Missing

> **Date:** February 2026  
> **Honest Assessment:** We built a solid, functional personal assistant shell. But "super-intelligent"? We're roughly 25–30% of the way there. This document explains why — and exactly what needs to happen.

---

## Part 1 — What We Actually Built

### The App Shell

ARIA is a Windows desktop app (Electron + React) that lives as a 348×620px overlay in the bottom-right corner. It has:

- A **chat interface** that you type into
- **6 panels**: Today, Ask, Remind, Mail, Money, Notes
- A **tray icon** with keyboard shortcuts (`Ctrl+Shift+A` to toggle)
- A **SQLite database** at `%APPDATA%/aria-bot/aria.db`
- A **Python sidecar process** that runs alongside the Electron app

### What the App Can Do Today

| Feature | What Works | How It Works |
|---|---|---|
| **Email reading** | Fetches inbox via IMAP, shows subject/sender/preview, auto-categorizes | Noise heuristics → Ollama/Gemini for categorization |
| **Reminders** | Create, snooze, complete, priority-sort, overdue detection | SQLite `reminders` table, `node-schedule` for alerts |
| **Notes** | Create, tag, search notes | SQLite `notes` table |
| **Subscriptions** | Track recurring payments, detect from emails, renewal alerts | SQLite `subscriptions`, regex extraction from email subjects |
| **Spending/Transactions** | Log spend from emails, show breakdowns | `spend_log` + `transactions` tables, email parsing |
| **Habits** | Track daily habits, streaks, completion log | `habits` + `habit_log` tables |
| **Focus sessions** | Log focus time, analytics | `focus_sessions` table |
| **Calendar** | Parse .ics events, show meetings | `calendar_events` table, `node-ical` |
| **NL Queries (chat)** | "swiggy summary", "how much on food", "compare this month" → instant SQL answer | New `extractQueryIntent()` semantic parser (Jan 2026 rewrite) |
| **Weekly report** | Auto-generated prose: tasks, habits, focus, money | Ollama → Grok → Gemini chain |
| **Daily briefing** | Morning summary on app start | Priority engine + AI formatting |
| **Priority intelligence** | Tasks sorted by urgency score | Python `priority.py` deterministic scoring |
| **Chat / AI** | General conversation, ask anything | Ollama (local) → Grok → Gemini fallback chain |
| **Semantic search** | "emails about AWS" → ChromaDB vector search | Python `vectors.py` + ChromaDB |

---

## Part 2 — The Honest Gap Analysis

### 2.1 The NL Query Engine Is Still Regex at Heart

The rewrite this session (`services/nl-query.js`) is much better — it extracts `{domain, action, merchant, category, timeRange}` before routing. But it is still fundamentally **a set of hardcoded rules**, not intelligence.

**What "hardcoded" means here:**

```js
// This is what we actually do:
const KNOWN_MERCHANTS = ['swiggy', 'zomato', 'uber', 'ola', 'amazon', ...];
// A 40-item manual list. A new merchant that isn't on this list → silently missed.

const SPEND_CATEGORIES = ['food', 'shopping', 'travel', 'entertainment', ...];
// A 16-item manual list. "dining" → not matched. "commute" → not matched.

// Category extraction:
if (catMatch) {
  const candidate = catMatch[1].toLowerCase();
  if (SPEND_CATEGORIES.includes(candidate)) { ... }
}
// ONLY works if the user uses EXACTLY one of our 16 category words.
// "what's my food bill" → works. "what's my dining bill" → fails silently.
```

**A truly intelligent system would:**
- Understand "dining" = "food", "commute" = "travel", "streaming" = "entertainment"
- Extract merchant names it has never seen before from context
- Understand "that Swiggy order I placed last Tuesday" without a keyword list

---

### 2.2 Python Is Underused — The RAG Pipeline Is Wired But Shallow

**What we built:**

```
Python sidecar (engine.py)
  ├── priority.py     → deterministic rule scoring (ACTUALLY USED in Today panel)
  ├── intents.py      → regex intent classifier (PARTIALLY USED — called after JS filter)
  ├── vectors.py      → ChromaDB wrapper (EXISTS but barely used)
  └── llm.py          → llama-cpp-python wrapper (RARELY USED — LLM not loaded by default)
```

**The RAG flow that EXISTS in code:**

```
1. Email arrives → index in ChromaDB (email subject + first 300 chars)
2. User types in chat → callPython('search', { text: message, n_results: 5 })
3. Results returned → appended to AI prompt as "Related items found: ..."
4. AI answers with context
```

**Why it doesn't really work:**

| Problem | Reality |
|---|---|
| `chromadb` is NOT installed by default | `requirements.txt` has line commented out: `# llama-cpp-python>=0.2.0`. ChromaDB is there but installation fails on Windows without C++ build tools |
| Only emails are indexed | Calendar events and notes are NOT being indexed after updates |
| Indexing is limited to 100 emails at a time | Capped at 100 on initial setup, incremental indexing fires on email fetch only |
| Vector results are appended as raw text | "Related items found: email-abc123: We're updating Terms..." — not meaningful context |
| No re-ranking | All 5 results are dumped to LLM regardless of relevance score |
| No document chunking | Email body capped at 300 chars — misses critical content deeper in emails |
| LLM (Phi-3 local) is never loaded | `get_llm()` only fires on `generate` requests — which almost never happen because Ollama handles chat |

**What a real RAG pipeline looks like vs what we have:**

```
REAL RAG SYSTEM:                          WHAT WE HAVE:
─────────────────────────────────         ──────────────────────────────────
1. Chunk documents at 512 tokens    →     Truncate at 300 chars (not chunking)
2. Embed with sentence-transformers →     ChromaDB default embedding (all-MiniLM)
3. Store chunks with metadata        →     Stores full document, no chunking
4. At query: retrieve top-K chunks  →     Retrieve top-5 (no threshold filter)
5. Re-rank by relevance              →     No re-ranking
6. Inject into LLM prompt            →     Inject as raw string
7. LLM answers ONLY from context    →     LLM uses context + its own training
8. Cite sources                      →     No citation
9. Update index on every change      →     Only on email fetch
10. Handle "no results" gracefully  →     Falls through silently
```

---

### 2.3 Intent Classification: Three Systems That Don't Coordinate

We have **three intent classifiers** that run sequentially, and the design means the worst one runs first:

```
Message arrives
    │
    ▼
[1] JS: isDataQuery()         ← RUNS FIRST — hardcoded regex
    │                           If it claims the query, Python never sees it
    │ (if false)
    ▼
[2] Python: match_intent()    ← RUNS SECOND — better regex with param extraction
    │                           Has category extraction, merchant list
    │ (if intent = 'chat')
    ▼
[3] AI: aiCall('intent', ...) ← RUNS LAST — actual intelligence
                                But only for "chat" fallback
```

**The right order should be:**
```
Message → AI intent classification (always) → route with confidence
```

A language model can determine from "what's eating my wallet this month?" that the intent is `money/summary/thisMonth` without any keyword matching. Our system misses this entirely if `isDataQuery()` returns false and Python also returns 'chat'.

---

### 2.4 The AI Chain Is Fragile

**Current chain:**
```
Ollama (local) → Grok → Gemini Flash-Lite
```

**Problems:**
- Ollama must be separately installed and models pulled (`ollama pull llama3.2:3b`)
- If Ollama is down, falls to Grok API (requires API key in keytar)
- If Grok fails, falls to Gemini (daily cap of 20 calls enforced in `haiku.js`)
- Context window: 2000 token hard cap (emails truncated before AI sees them)
- **No conversation memory**: Each chat message is independent. If you said "remind me about the Airtel thing" after discussing Airtel, ARIA has no idea what "the Airtel thing" is
- **No tool use**: AI cannot query the database itself — it only sees what `buildPersonalBrain()` manually prepares for it

---

### 2.5 Financial Intelligence Is Keyword Extraction, Not Understanding

**Subscription detection (from emails):**

```js
// services/financial-intel.js — actual logic
const isSubscription = subject.match(
  /subscription|renewal|billing|receipt|invoice|charged|payment|plan/i
);
const amount = subject.match(/[\₹\$\€]?\s*[\d,]+\.?\d*/);
```

This catches "Your Netflix subscription has been renewed — ₹649" but misses:
- "Your Spotify account — Monthly charge processed" (no keyword but IS a subscription)
- PDF receipts (not in email subject/preview)
- Multi-currency transactions
- Refunds being counted as expenses

**Transaction categorization:**

```js
// Category assigned by Ollama/Gemini from email subject+preview
// But NO learning: if you correct a category, it doesn't remember
// If you make 50 Swiggy orders, it runs AI categorization 50 times independently
```

A real financial intelligence system would:
- Learn from corrections
- Deduplicate similar transactions
- Detect spending anomalies ("you spent 3x more on food this week than average")
- Predict upcoming bills based on historical patterns

---

### 2.6 Context Memory Is Shallow

We implemented P8 (Learning Loop) and P10 (Context Memory), but:

```js
// session_preferences table exists — "TTL preferences"
// But stored as regex-matched key-value pairs:
if (/i (?:prefer|like|want|always)/i.test(message)) {
  // Store the preference
}
// This only fires on explicit "I prefer..." statements
// "show me swiggy orders" said 10 times → no learning that user likes Swiggy queries

// context_threads: tracks entities mentioned (email IDs, task IDs, merchant names)
// BUT: each context thread is independent — no linking across sessions
// "that thing I mentioned yesterday" → completely lost
```

---

## Part 3 — What "Super Intelligent Bot" Actually Requires

### Level 1 — Conversational Intelligence (6–8 months of work)

| Capability | What's Needed | Current State |
|---|---|---|
| **Follow-up understanding** | "What about last month?" after a spending query → understands "last month" refers to the previous query's context | ❌ No conversation state |
| **Entity resolution** | "The Airtel thing" → resolves to the specific Airtel email/subscription being discussed | Partial — context_threads exists but shallow |
| **Coreference** | "When did I last pay *it*?" → resolves "*it*" from conversation history | ❌ Not implemented |
| **Clarification** | "You spent ₹12,000 on food — do you want the breakdown or the trend?" | ❌ Always picks one interpretation |
| **Multi-step queries** | "Show me unread emails from Amazon about orders placed this week" | ❌ Can't compose multi-condition queries |

**What's required:**
- Persistent conversation state (last 20 turns stored + referenced)
- Entity linking across turns
- Small reasoning layer (even a 3B parameter model can do this)

---

### Level 2 — True Financial Intelligence (3–4 months)

| Capability | What's Needed | Current State |
|---|---|---|
| **Anomaly detection** | "You spent 3x more on food this week — Tuesday order was ₹2,400 when your average is ₹400" | ❌ No baseline tracking |
| **Pattern recognition** | "You order Swiggy every Friday evening" | ❌ No temporal pattern analysis |
| **Forecasting** | "Based on history, you'll spend ~₹8,000 on subscriptions this month" | ❌ No forecasting model |
| **Savings suggestions** | "You have 3 music apps — Spotify, YouTube Music, Gaana. That's ₹1,200/month. Cancel 2?" | ❌ No cross-category analysis |
| **Bill prediction** | "Airtel bill should come in 4 days based on last 3 months" | ❌ No predictive modeling |

**What's required:**
- Behavioral baseline computation (rolling 4-week averages per category) — `behavior_metrics` table exists but not populated
- Anomaly scoring vs. baseline
- Time-series pattern matching (day-of-week, day-of-month)

---

### Level 3 — Proactive Intelligence (This is what makes it "super") (6–12 months)

A super bot doesn't wait for you to ask. It tells you things before you need them.

| Action | Trigger | What's Needed |
|---|---|---|
| "Your Paytm auto-pay fires tomorrow — your balance is low" | Upcoming renewal + bank balance check | Payment API integration |
| "You have 3 unread emails from your manager — usually urgent for you" | Sender pattern learning | Per-sender urgency model |
| "Focus session suggested — you have 2 free hours before your 3 PM meeting" | Calendar gap detection | ✅ CalendarIntel EXISTS — but suggestion not pushed |
| "You missed your water habit 3 days in a row — want me to add a reminder?" | Habit failure pattern | ❌ Only detects, doesn't act |
| "The last 4 flights you searched ended up cheaper 2 weeks before travel" | Personal behavior pattern | ❌ No behavior learning |

**What's required:**
- Proactive push system (timed checks every 15–30 min)
- Per-user behavioral model (small, local, updatable)
- Agency: ARIA proposes actions, user approves

---

### Level 4 — True RAG + Local LLM (This is the Python work) (2–3 months)

The ChromaDB + Python pipeline exists but needs to actually work:

```python
# WHAT NEEDS TO BE BUILT:

# 1. Proper document chunking
def chunk_document(text, chunk_size=512, overlap=64):
    """Split on sentence boundaries, not character count"""
    # Use spaCy or sentence-splitter library
    sentences = split_into_sentences(text)
    return sliding_window(sentences, chunk_size, overlap)

# 2. Embedding model (not ChromaDB default)
# Install: pip install sentence-transformers
# Use: "all-MiniLM-L6-v2" — 22MB, fast, runs locally
from sentence_transformers import SentenceTransformer
model = SentenceTransformer('all-MiniLM-L6-v2')
embeddings = model.encode(chunks)

# 3. Re-ranking retrieved chunks
# After retrieval: score each chunk against query
# Use BM25 for keyword re-ranking on top of semantic results
# Install: pip install rank_bm25

# 4. Grounded answers (LLM only uses retrieved context)
system = """Answer ONLY from the provided context. 
If the answer is not in the context, say "I don't have that information."
Context: {retrieved_chunks}"""

# 5. Index ALL data types, not just emails:
# - Notes (every save → re-index)
# - Calendar descriptions
# - Transactions (merchant + description)
# - Chat history (for "what did I tell you about X?")

# 6. Incremental index maintenance
# Right now: only indexes on email fetch
# Needed: index on every DB write (hooks in db/index.js)
```

---

### Level 5 — Tool-Use / Agentic Behavior (12+ months, the real frontier)

The app currently has a "Commander Model" (propose → confirm → execute) but it's minimal:

```
Currently: "Remind me to call mom" → shows proposed reminder card → user clicks Confirm

Super Bot: "Clean up my inbox" →
  1. AI analyzes all unread emails
  2. Categorizes as urgent/archive/delete suggestions
  3. Shows grouped action card: "Archive 12 newsletters, delete 3 spam, keep 5 urgent"
  4. User approves → executes batch
```

**What's needed for agentic behavior:**
- LLM with **function calling** capability (GPT-4, Claude-3, or Mistral with tool_use)
- Tool definitions: `query_db`, `send_email`, `create_reminder`, `search_web`, `read_file`
- Execution loop: LLM decides which tools to call → executes → observes result → continues
- Safety: Every destructive action still requires user confirm

---

## Part 4 — The Hardcoded List (What Needs to Be Dynamic)

### Currently Hardcoded → Must Be Learned/Dynamic

| What | Where | Problem | Fix |
|---|---|---|---|
| Merchant list (40 names) | `nl-query.js:KNOWN_MERCHANTS` | New merchants silently missed | Extract merchants from transaction history dynamically |
| Spend categories (16 names) | `nl-query.js:SPEND_CATEGORIES` | "dining"/"commute" not recognized | Use word embeddings to fuzzy-match to categories |
| Noise filter keywords | `mail.js:NOISE_PATTERNS` | Static list gets stale | Learn from user's mark-as-read patterns |
| Email category heuristics | `mail.js` pre-filter | Hard rules for "noreply" etc | User feedback should update weights |
| Priority scoring formula | `priority.py` | Fixed formula, not tuned per user | Learn from which items user actually acts on |
| Weekly report template | `weekly-report.js` | Same structure every week | Adaptive — surface different insights each week |
| Follow-up suggestions | `main.js:_getFollowUps` | 3 hardcoded per query type | Generate dynamically based on what was returned |
| Time-window defaults | `nl-query.js:defaultTimeRange` | Always "last 30 days" | Infer from query context |
| AI routing chain | `ai.js` | Fixed: Ollama → Grok → Gemini | Should track latency/quality per provider and adapt |
| Intent keyword patterns | `intents.py` | 200+ lines of regex | Replace with intent classification model |

---

## Part 5 — Prioritized Implementation Roadmap

### Phase A — Fix What's Broken (2–4 weeks)

These are known gaps that make the current system unreliable:

1. **Fix RAG indexing pipeline**
   - Install `sentence-transformers` and `rank-bm25` alongside chromadb
   - Index ALL writes: notes, calendar, transactions, not just emails
   - Remove 100-email cap on initial indexing
   - Add chunk-level indexing (512 token chunks with overlap)

2. **Fix conversation continuity**
   - Store last 10 chat turns in context for every AI call
   - Use `chat_messages` table (already populated) as context window
   - Add entity linking: if user mentioned a merchant name 2 turns ago, bind it

3. **Populate `behavior_metrics` table**
   - Run weekly job: compute rolling 4-week avg per category per merchant
   - Surface on "my spending is normal/high/low" queries

4. **Fix local LLM loading**
   - `llm.py` exists and works but is never called for chat (Ollama handles it)
   - Wire Phi-3 Mini as offline fallback when Ollama is not running

---

### Phase B — Real Intelligence Layer (2–3 months)

5. **Replace regex intent classifiers with embedding-based intent**
   ```python
   # intents.py
   # Instead of regex, use semantic similarity to intent examples:
   INTENT_EXAMPLES = {
     "money_summary": ["how much did I spend", "show my expenses", "my spending this week"],
     "merchant_lookup": ["swiggy orders", "tell me about amazon", "zomato summary"],
     # ...
   }
   # Match query to nearest intent by cosine similarity
   ```

6. **Dynamic merchant extraction**
   - Extract all unique merchants from `transactions.merchant` column
   - Use that as the runtime lookup table instead of hardcoded 40 names
   - Fuzzy match for typos ("amazoon" → "amazon")

7. **Spending anomaly alerts**
   - After `behavior_metrics` is populated, detect: current > 1.5x rolling avg
   - Push proactive notification: "You've spent 2x more on food than usual this week"

8. **Multi-turn conversation state**
   - Add `conversation_context` to chatEnhancedHandler: last 5 messages + extracted entities
   - Pass to every AI call as system context

---

### Phase C — Agentic Capabilities (3–6 months)

9. **Email action agent**
   - "Clean up my inbox" → AI proposes batch actions → user confirms → executes

10. **Financial advisor mode**
    - Monthly auto-analysis: subscriptions you can cut, spending trends, savings opportunities
    - Triggered on 1st of each month, shown as Today panel card

11. **Proactive push intelligence**
    - Every 30 min: check for anomalies, upcoming renewals, overdue tasks, calendar gaps
    - If anything notable: push notification with natural language summary

12. **True tool use**
    - Wire function calling (Gemini / Grok support this)
    - Tools: `query_db`, `search_emails`, `create_task`, `search_web`
    - ARIA can self-direct: "Let me check your transactions... I found 3 Netflix charges this month. That seems unusual — want me to look into it?"

---

## Part 6 — Current Architecture Diagram

```
┌──────────────────────────────────────────────────────────────┐
│                    ARIA Desktop App                          │
│                                                              │
│  React UI (renderer)                                         │
│  ┌──────────┬──────────┬──────────┬──────────┬──────────┐   │
│  │  Today   │   Ask    │  Remind  │   Mail   │  Money   │   │
│  └──────────┴──────────┴──────────┴──────────┴──────────┘   │
│                         IPC                                  │
│  Electron Main Process                                       │
│  ┌────────────────────────────────────────────────────────┐  │
│  │  chatEnhancedHandler()                                 │  │
│  │    1. isDataQuery? → nl-query.js (regex + SQL)         │  │
│  │    2. Python intent? → intents.py (regex)              │  │
│  │    3. AI intent → Ollama / Grok / Gemini               │  │
│  │    4. Route → services/*.js                            │  │
│  └────────────────────────────────────────────────────────┘  │
│  Services: gmail.js, calendar.js, remind.js, habits.js...    │
│                 │                    │                        │
│         better-sqlite3          callPython()                 │
│                 │                    │                        │
│           aria.db (SQLite)    Python Sidecar                 │
│                               ┌──────────────┐               │
│                               │ engine.py    │               │
│                               │ priority.py ←│─ USED ✓      │
│                               │ intents.py  ←│─ PARTIALLY ✓ │
│                               │ vectors.py  ←│─ EXISTS ~     │
│                               │ llm.py      ←│─ INACTIVE ✗  │
│                               └──────────────┘               │
│                                     │                        │
│                              ChromaDB (local)                │
│                              100 emails indexed              │
└──────────────────────────────────────────────────────────────┘
         │                    │                    │
    Ollama (local)       Grok API            Gemini API
    llama3.2:3b         (optional)           Flash-Lite
    phi3:mini                                (20 calls/day)
```

---

## Part 7 — Honest Summary

| Dimension | Score | Notes |
|---|---|---|
| **Core functionality** | 8/10 | Works. Tasks, email, money, habits, calendar — all solid |
| **Query understanding** | 4/10 | Better after rewrite but still regex-based |
| **Financial intelligence** | 3/10 | Shows data, no anomaly detection, no learning |
| **Conversation context** | 2/10 | Each message is independent. No memory across turns |
| **RAG / Semantic search** | 2/10 | Infrastructure exists, barely used, shallow indexing |
| **Proactive intelligence** | 2/10 | Priority scoring + one scheduled briefing only |
| **Learning / personalization** | 1/10 | Preference detection exists, not used for routing |
| **Agentic capability** | 1/10 | Propose-confirm for reminders only |
| **Overall intelligence** | **3/10** | Functional assistant. Not yet "intelligent". |

### The Honest One-Line Answer

> ARIA is a well-built **dashboard with a chat interface**. It retrieves and displays your data well. It is not yet intelligent — it doesn't learn, doesn't anticipate, doesn't maintain context, and its "understanding" of your queries is still pattern matching against lists we wrote by hand.

### What Makes the Leap to "Super Bot"

The single biggest leverage point is **proper conversation memory + tool-use LLM**. If every chat message had:
1. The last 10 turns of conversation as context
2. A description of the user's behavior patterns
3. An LLM that can call `query_db(sql)` as a tool

...then ARIA could answer "what's eating my money" by actually writing (and running) a SQL query, not by matching the word "eating" against a list of patterns. That is the qualitative leap. Everything else (better RAG, anomaly detection, proactive pushes) is additive on top of that foundation.

**Estimated work to get to 7/10 intelligence: 3–4 months of focused development.**

---

*This document should be your reference for every new feature decision. Ask: does this move the needle on conversation memory, tool use, or learning? If not, it's polish.*
