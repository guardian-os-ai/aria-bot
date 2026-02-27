"""
python-engine/agent.py — ARIA Agentic Orchestrator

Uses Ollama's native tool calling to let the LLM decide what data to fetch
and how to answer the user's question. Replaces the regex-based intent chain.

Architecture:
  1. User message + conversation history → Ollama with tool definitions
  2. Ollama decides: respond directly OR call tools
  3. If tools called → execute → feed results back
  4. Iterate up to 3 times (plan → execute → verify)
  5. Return final answer

Model preference: qwen2.5:7b (best tool calling) → qwen3:8b → llama3.2:3b
"""

import json
import os
import sys
import sqlite3
import traceback
import datetime
import time
from typing import Dict, Any, List, Optional
from concurrent.futures import ThreadPoolExecutor, TimeoutError as FuturesTimeout

import re

import requests

# Sibling imports
from vectors import VectorStore

# ── Phase F: Cross-session entity memory ─────────────────────────────────────

def _get_entity_memory(db_path: str) -> str:
    """
    Pull active context threads + recent entities from the DB.
    Returns a compact string to inject into the agent's system prompt.
    This gives the agent awareness of ongoing projects, people, and topics
    across multiple sessions without requiring re-mention.
    """
    if not db_path:
        return ""
    try:
        conn = sqlite3.connect(db_path)
        conn.row_factory = sqlite3.Row
        cutoff = int(datetime.datetime.now().timestamp()) - 7 * 86400  # 7 days

        # Active context threads
        threads = conn.execute(
            """SELECT topic, entities, last_activity_at FROM context_threads
               WHERE status = 'active' AND (last_activity_at IS NULL OR last_activity_at >= ?)
               ORDER BY last_activity_at DESC LIMIT 5""",
            (cutoff,),
        ).fetchall()

        # Recent entities (people, projects, companies)
        entities = conn.execute(
            """SELECT entity_type, entity_value, source FROM context_entities
               WHERE created_at >= ?
               ORDER BY created_at DESC LIMIT 20""",
            (cutoff,),
        ).fetchall()

        # Saved memories (ai_memory table if exists)
        memories = []
        try:
            memories = conn.execute(
                "SELECT fact FROM ai_memory ORDER BY created_at DESC LIMIT 10"
            ).fetchall()
        except Exception:
            pass

        conn.close()

        parts = []
        if threads:
            thread_lines = []
            for t in threads:
                ent_list = ""
                try:
                    ents = json.loads(t["entities"] or "[]")
                    if ents:
                        ent_list = f" — entities: {', '.join(str(e) for e in ents[:5])}"
                except Exception:
                    pass
                thread_lines.append(f"  • {t['topic']}{ent_list}")
            parts.append("ACTIVE CONTEXT THREADS (ongoing projects/topics):\n" + "\n".join(thread_lines))

        if entities:
            by_type: Dict[str, list] = {}
            for e in entities:
                by_type.setdefault(e["entity_type"], []).append(e["entity_value"])
            ent_lines = [f"  {k}: {', '.join(list(dict.fromkeys(v))[:8])}" for k, v in by_type.items()]
            parts.append("KNOWN ENTITIES (last 7 days):\n" + "\n".join(ent_lines))

        if memories:
            mem_lines = [f"  • {m['fact']}" for m in memories]
            parts.append("SAVED USER FACTS:\n" + "\n".join(mem_lines))

        if not parts:
            return ""
        return "\n\n[CROSS-SESSION MEMORY]\n" + "\n\n".join(parts) + "\n[/CROSS-SESSION MEMORY]"
    except Exception as exc:
        print(f"[Agent] entity memory error: {exc}", file=sys.stderr)
        return ""

# ── Date/Time Parser for natural language due times ─────────────────────────

def _parse_due_time(text: str) -> Optional[int]:
    """Parse natural language due time into Unix timestamp. Returns None if unparseable."""
    if not text or not text.strip():
        return None
    now = datetime.datetime.now()
    text_low = text.lower().strip()

    # Extract hour/minute from text (e.g. "3pm", "15:30", "noon", "midnight")
    hour, minute = 9, 0  # default 9am
    if 'noon' in text_low:
        hour = 12
    elif 'midnight' in text_low:
        hour = 0
    else:
        t = re.search(r'(\d{1,2})(?::(\d{2}))?\s*(am|pm)', text_low)
        if t:
            h, m = int(t.group(1)), int(t.group(2) or 0)
            meridiem = t.group(3)
            if meridiem == 'pm' and h < 12:
                h += 12
            elif meridiem == 'am' and h == 12:
                h = 0
            hour, minute = h, m
        else:
            t2 = re.search(r'(\d{1,2}):(\d{2})', text_low)
            if t2:
                hour, minute = int(t2.group(1)), int(t2.group(2))
            else:
                # Bare hour like "3" or "at 3" — assume pm for 1-6
                t3 = re.search(r'\bat\s+(\d{1,2})\b', text_low)
                if t3:
                    h = int(t3.group(1))
                    if 1 <= h <= 6:
                        h += 12
                    hour = h

    # Determine the date
    days_of_week = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday']
    base = None

    if 'today' in text_low:
        base = now.replace(hour=hour, minute=minute, second=0, microsecond=0)
    elif 'tomorrow' in text_low:
        base = (now + datetime.timedelta(days=1)).replace(hour=hour, minute=minute, second=0, microsecond=0)
    elif 'next week' in text_low:
        days_ahead = (7 - now.weekday()) % 7 or 7
        base = (now + datetime.timedelta(days=days_ahead)).replace(hour=hour, minute=minute, second=0, microsecond=0)
    else:
        # "in N hours"
        ih = re.search(r'in\s+(\d+)\s+(?:hour|hr)', text_low)
        if ih:
            base = now + datetime.timedelta(hours=int(ih.group(1)))
        else:
            # "in N minutes"
            im = re.search(r'in\s+(\d+)\s+(?:minute|min)', text_low)
            if im:
                base = now + datetime.timedelta(minutes=int(im.group(1)))
            else:
                # "in N days"
                id_ = re.search(r'in\s+(\d+)\s+day', text_low)
                if id_:
                    base = (now + datetime.timedelta(days=int(id_.group(1)))).replace(hour=hour, minute=minute, second=0, microsecond=0)
                else:
                    # Day of week e.g. "Friday", "next Monday"
                    for i, day_name in enumerate(days_of_week):
                        if day_name in text_low:
                            days_ahead = (i - now.weekday()) % 7 or 7
                            base = (now + datetime.timedelta(days=days_ahead)).replace(hour=hour, minute=minute, second=0, microsecond=0)
                            break
                    else:
                        # Month name + day e.g. "March 5", "Jan 20"
                        months = {'jan': 1, 'feb': 2, 'mar': 3, 'apr': 4, 'may': 5, 'jun': 6,
                                  'jul': 7, 'aug': 8, 'sep': 9, 'oct': 10, 'nov': 11, 'dec': 12}
                        mm = re.search(r'(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\w*\s+(\d{1,2})', text_low)
                        if mm:
                            month = months[mm.group(1)]
                            day = int(mm.group(2))
                            target = datetime.datetime(now.year, month, day, hour, minute)
                            if target <= now:
                                target = datetime.datetime(now.year + 1, month, day, hour, minute)
                            base = target
                        else:
                            # Just a time with no date — today or tomorrow if past
                            base = now.replace(hour=hour, minute=minute, second=0, microsecond=0)
                            if base <= now:
                                base += datetime.timedelta(days=1)

    return int(base.timestamp()) if base else None


# ── Write Operations (whitelisted, safe) ─────────────────────────────────────

def _execute_write(table: str, data: Dict[str, Any], db_path: str = "") -> Dict[str, Any]:
    """Execute a whitelisted write operation against ARIA's database."""
    if not db_path:
        db_path = _get_db_path()
    try:
        conn = sqlite3.connect(db_path, timeout=5)
        if table == 'complete_reminder':
            item_id = data.get('id')
            if not item_id:
                return {"error": "id required to complete reminder"}
            conn.execute("UPDATE reminders SET completed = 1 WHERE id = ?", [item_id])
            conn.commit()
            conn.close()
            return {"ok": True, "action": "completed", "id": item_id}

        ALLOWED = {'reminders', 'spend_log', 'notes'}
        if table not in ALLOWED:
            return {"error": f"Write to '{table}' is not permitted"}

        cols = list(data.keys())
        sql = f"INSERT INTO {table} ({', '.join(cols)}) VALUES ({', '.join(['?' for _ in cols])})"
        cursor = conn.execute(sql, list(data.values()))
        new_id = cursor.lastrowid
        conn.commit()
        conn.close()
        return {"ok": True, "id": new_id, "table": table}
    except Exception as e:
        return {"error": str(e)}


def _create_reminder(title: str, due_time_text: str = "", category: str = "personal",
                     priority: int = 3, db_path: str = "") -> Dict[str, Any]:
    """Create a new reminder/task in the database."""
    due_at = _parse_due_time(due_time_text) if due_time_text else None
    now_ts = int(datetime.datetime.now().timestamp())
    data: Dict[str, Any] = {
        "title": title[:255],
        "category": category or "personal",
        "priority_score": float(max(1, min(5, priority))),
        "completed": 0,
        "created_at": now_ts,
    }
    if due_at:
        data["due_at"] = due_at
    result = _execute_write("reminders", data, db_path)
    if result.get("ok"):
        due_display = ""
        if due_at:
            dt = datetime.datetime.fromtimestamp(due_at)
            due_display = dt.strftime("%a %b %d at %I:%M %p")
        return {"ok": True, "id": result["id"], "title": title,
                "due": due_display or "no due date", "category": category}
    return result


def _add_expense(merchant: str, amount: float, category: str,
                 description: str = "", db_path: str = "") -> Dict[str, Any]:
    """Log a new expense to spend_log."""
    today = datetime.datetime.now().strftime('%Y-%m-%d')
    resolved_cat = _resolve_category(category) if category else "other"
    data: Dict[str, Any] = {
        "description": f"{merchant} — {description}" if description else merchant,
        "amount_raw": float(amount),
        "category": resolved_cat,
        "occurred_at": int(datetime.datetime.now().timestamp()),
    }
    result = _execute_write("spend_log", data, db_path)
    if result.get("ok"):
        return {"ok": True, "id": result["id"], "merchant": merchant,
                "amount": amount, "category": resolved_cat, "date": today}
    return result


def _save_note(title: str, content: str, db_path: str = "") -> Dict[str, Any]:
    """Save a note to the notes table."""
    now_ts = int(datetime.datetime.now().timestamp())
    result = _execute_write("notes", {"title": title[:200], "content": content,
                                       "created_at": now_ts, "updated_at": now_ts}, db_path)
    if result.get("ok"):
        return {"ok": True, "id": result["id"], "title": title}
    return result


def _mark_item_done(item_id: int, item_type: str = "reminder", db_path: str = "") -> Dict[str, Any]:
    """Mark a reminder/task as completed."""
    if item_type in ("reminder", "task"):
        return _execute_write("complete_reminder", {"id": item_id}, db_path)
    return {"error": f"Cannot mark '{item_type}' as done"}


def _get_priorities_tool(limit: int = 8, db_path: str = "") -> Dict[str, Any]:
    """Get ranked priorities from the deterministic priority engine."""
    if not db_path:
        db_path = _get_db_path()
    try:
        from priority import compute_priorities
        result = compute_priorities(db_path)
        items = result if isinstance(result, list) else result.get("priorities", [])
        return {"priorities": items[:limit], "total": len(items)}
    except Exception as e:
        return {"error": str(e)}


# ── Configuration ─────────────────────────────────────────────────────────────

OLLAMA_BASE = "http://localhost:11434"
MAX_ITERATIONS = 3
REQUEST_TIMEOUT = 60  # seconds per Ollama call

# Model preference order for tool calling reliability
MODEL_PREFERENCE = ["qwen2.5:7b", "qwen3:8b", "llama3.2:3b", "phi3:mini"]

# ── Category synonym map (for spending analysis) ─────────────────────────────

CATEGORY_SYNONYMS = {
    'dining': 'food', 'restaurant': 'food', 'cafe': 'food', 'takeout': 'food',
    'eating': 'food', 'lunch': 'food', 'dinner': 'food', 'breakfast': 'food',
    'meals': 'food', 'snacks': 'food', 'delivery': 'food',
    'commute': 'travel', 'transport': 'travel', 'ride': 'travel', 'cab': 'travel',
    'taxi': 'travel', 'flight': 'travel', 'hotel': 'travel', 'trip': 'travel',
    'bus': 'travel', 'train': 'travel', 'metro': 'travel', 'auto': 'travel',
    'streaming': 'entertainment', 'movies': 'entertainment', 'gaming': 'entertainment',
    'music': 'entertainment', 'ott': 'entertainment', 'cinema': 'entertainment',
    'medicine': 'health', 'hospital': 'health', 'doctor': 'health',
    'pharmacy': 'health', 'gym': 'health', 'fitness': 'health',
    'electricity': 'utilities', 'internet': 'utilities', 'wifi': 'utilities',
    'broadband': 'utilities', 'phone': 'utilities', 'bill': 'utilities',
    'clothes': 'shopping', 'clothing': 'shopping', 'fashion': 'shopping',
    'electronics': 'shopping', 'gadgets': 'shopping',
    'grocery': 'groceries', 'supermarket': 'groceries', 'vegetables': 'groceries',
    'petrol': 'fuel', 'diesel': 'fuel', 'cng': 'fuel',
    'loan': 'emi', 'mortgage': 'emi', 'installment': 'emi',
    'recurring': 'subscriptions', 'membership': 'subscriptions',
    'stocks': 'investments', 'sip': 'investments', 'mutual fund': 'investments',
    'premium': 'insurance', 'policy': 'insurance',
    'mobile': 'recharge', 'prepaid': 'recharge',
    'tuition': 'education', 'course': 'education',
}


# ── ARIA System Prompt ────────────────────────────────────────────────────────

# Critical schema context — prevents wrong SQL for Unix timestamp columns
_TIMESTAMP_RULES = """
CRITICAL — TIMESTAMP COLUMNS store UNIX EPOCH SECONDS (integers like 1708451200), NOT strings.
ALL timestamp/date columns in the DB are integers: timestamp, due_at, start_at, end_at, received_at, next_renewal, period_start.

CORRECT date filters (use these EXACTLY):
  This month:   timestamp >= CAST(strftime('%s', date('now','start of month')) AS INTEGER)
  Last month:   timestamp BETWEEN CAST(strftime('%s', date('now','start of month','-1 month')) AS INTEGER)
                             AND   CAST(strftime('%s', date('now','start of month','-1 day')) AS INTEGER)
  Last 7 days:  timestamp >= CAST(strftime('%s', 'now', '-7 days') AS INTEGER)
  Last 30 days: timestamp >= CAST(strftime('%s', 'now', '-30 days') AS INTEGER)
  Last 3 months: timestamp >= CAST(strftime('%s', 'now', '-90 days') AS INTEGER)
  Today:        timestamp >= CAST(strftime('%s', date('now')) AS INTEGER)
  Upcoming 7d:  timestamp BETWEEN CAST(strftime('%s','now') AS INTEGER) AND CAST(strftime('%s','now','+7 days') AS INTEGER)

NEVER write:
  WHERE strftime('%m', timestamp) = ...    ← WRONG, timestamp is an integer
  WHERE timestamp LIKE '2026%'             ← WRONG, timestamp is an integer
  WHERE date(timestamp) = ...              ← WRONG without 'unixepoch' modifier

To display dates use: datetime(timestamp, 'unixepoch') or date(timestamp, 'unixepoch')

EXCEPTION: spend_log.date is TEXT in 'YYYY-MM-DD' format. Use: WHERE date >= date('now','start of month')
EXCEPTION: habit_log.date is TEXT in 'YYYY-MM-DD' format. Use: WHERE date = date('now')
"""

SYSTEM_PROMPT = f"""You are ARIA — a personal executive AI assistant living on the user's Windows desktop. You have DIRECT ACCESS to their personal data through tools.

VOICE: Direct. Decisive. Minimal. Like a sharp chief-of-staff. Never ramble. Never use filler phrases like "Sure!", "Of course!", "Let me help!". Just answer.

TOOLS — USE THEM:
- For ANY data question (spending, emails, tasks, habits, calendar, subscriptions): CALL query_database with SQL
- For content-based search (find emails about X, notes about Y): CALL search_knowledge
- For spending overview with anomaly detection: CALL get_spending_analysis

SQL SCHEMA:
- transactions: id, merchant (TEXT), category (TEXT), amount (REAL), timestamp (INTEGER unix), description (TEXT)
- spend_log: id, description (TEXT), amount (REAL), category (TEXT), date (TEXT YYYY-MM-DD)
- email_cache: message_id, subject, from_name, from_email, body_preview, category, is_read (0/1), received_at (INTEGER unix)
- reminders: id, title, subtitle, category, due_at (INTEGER unix), completed (0/1), archived_at (INTEGER unix or NULL)
- habits: id, name | habit_log: habit_id, date (TEXT YYYY-MM-DD), done (0/1)
- focus_sessions: id, start_at (INTEGER unix), end_at (INTEGER unix), duration_min (INTEGER), label
- calendar_events: id, title, start_at (INTEGER unix), end_at (INTEGER unix), location, description
- subscriptions: id, name, amount, period, next_renewal (INTEGER unix)
- behavior_metrics: category, period_start, weekly_spend, rolling_4week_avg, deviation_percent
- notes: id, title, content
- budget_limits: category, monthly_limit
- chat_messages: id, role ('user'|'assistant'), text, created_at (INTEGER unix)

{_TIMESTAMP_RULES}

RESPONSE FORMAT:
1. Classification tag (first line): [ACTION], [FYI], [RISK], or [STATUS]
2. Answer: 1-4 sentences with REAL numbers/names from tool results
3. On a NEW line: FOLLOW_UP: question1 | question2 | question3

RULES:
- NEVER guess or invent data. Use tools to get real data.
- NEVER say "I cannot access" — you CAN, use tools.
- If tool returns empty results: say "No data found for [time period]" — don't guess.
- For follow-ups ("what about last month?", "and for food?"): use conversation history to understand context, then query with the correct filters.
- When multiple tool calls would help, call them sequentially — plan your approach.
- Include ₹ symbol for Indian Rupee amounts.
- For active tasks/reminders: WHERE completed = 0 AND archived_at IS NULL

WRITE CAPABILITIES — YOU CAN ACT:
Use these tools to create or modify items based on user requests:
- create_reminder: User says "remind me", "add task", "remember to", "schedule", "todo"
- add_expense: User says "I spent", "paid for", "bought", "log expense", "₹X on Y"
- save_note: User says "note that", "remember this", "save this", "jot down"
- mark_item_done: User says "done", "completed", "mark as done", "cross off" (query ID first)
- get_priorities: User asks "what should I focus on?", "what's my priority?", "plan my day"
"""


# ── Tool Definitions for Ollama ───────────────────────────────────────────────

TOOLS = [
    {
        "type": "function",
        "function": {
            "name": "query_database",
            "description": "Execute a read-only SQL SELECT query against ARIA's personal SQLite database. Use for ANY question about spending, emails, tasks, habits, calendar, subscriptions. All timestamps are Unix epoch seconds. Use strftime('%s','now','-N days') for relative dates. Common queries: SUM(amount) for totals, COUNT(*) for counts, GROUP BY for breakdowns.",
            "parameters": {
                "type": "object",
                "properties": {
                    "sql": {
                        "type": "string",
                        "description": "SQL SELECT query. Read-only. Timestamps are Unix epoch seconds."
                    }
                },
                "required": ["sql"]
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "search_knowledge",
            "description": "Semantic search across all indexed personal data (emails, notes, transactions, calendar, subscriptions). Use when searching by content/meaning rather than structured fields. Example: 'emails about AWS billing' or 'notes about project meeting'.",
            "parameters": {
                "type": "object",
                "properties": {
                    "query": {
                        "type": "string",
                        "description": "Natural language search query"
                    },
                    "doc_type": {
                        "type": "string",
                        "description": "Optional filter by type: email, note, transaction, calendar, subscription, reminder"
                    },
                    "num_results": {
                        "type": "integer",
                        "description": "Number of results (default 5)"
                    }
                },
                "required": ["query"]
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "get_spending_analysis",
            "description": "Get spending analysis with anomaly detection. Returns totals, category breakdown, top merchants, and alerts for unusual spending patterns. Use for broad spending questions like 'where is my money going?', 'spending analysis', 'am I overspending?'.",
            "parameters": {
                "type": "object",
                "properties": {
                    "category": {
                        "type": "string",
                        "description": "Optional: filter by spending category (food, travel, shopping, entertainment, utilities, health, groceries, subscriptions, etc.)"
                    },
                    "days": {
                        "type": "integer",
                        "description": "Number of days to look back (default: 30)"
                    }
                },
                "required": []
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "create_reminder",
            "description": "Create a new task or reminder. Use when user says 'remind me', 'add a task', 'remember to', 'schedule', 'todo', 'I need to'. Parse due time from natural language.",
            "parameters": {
                "type": "object",
                "properties": {
                    "title": {"type": "string", "description": "Task title — concise and action-oriented"},
                    "due_time": {"type": "string", "description": "Natural language due time: 'tomorrow at 3pm', 'next Monday', 'Friday at 5pm', 'in 2 hours', 'March 5'. Leave empty if no time specified."},
                    "category": {"type": "string", "description": "Category: work, personal, health, finance, shopping, errands, or other"},
                    "priority": {"type": "integer", "description": "Priority 1-5 (5=highest). Default 3. Use 5 for urgent."}
                },
                "required": ["title"]
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "add_expense",
            "description": "Log a new expense or transaction. Use when user says 'I spent X on Y', 'paid', 'bought', 'log expense', 'add transaction'. Extract merchant, amount, and category.",
            "parameters": {
                "type": "object",
                "properties": {
                    "merchant": {"type": "string", "description": "Merchant or vendor name"},
                    "amount": {"type": "number", "description": "Amount spent (positive number, ₹ implied)"},
                    "category": {"type": "string", "description": "Spending category: food, travel, shopping, entertainment, utilities, health, groceries, subscriptions, fuel, etc."},
                    "description": {"type": "string", "description": "Optional context or description"}
                },
                "required": ["merchant", "amount", "category"]
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "save_note",
            "description": "Save a note or piece of information for later. Use when user says 'note that', 'remember this', 'save this', 'jot down', or shares information they want preserved.",
            "parameters": {
                "type": "object",
                "properties": {
                    "title": {"type": "string", "description": "Short note title or topic"},
                    "content": {"type": "string", "description": "Full note content"}
                },
                "required": ["title", "content"]
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "mark_item_done",
            "description": "Mark a reminder or task as completed. Use when user says 'done', 'completed it', 'finished', 'mark X as done', 'cross off X'. First query_database to find the item ID, then call this.",
            "parameters": {
                "type": "object",
                "properties": {
                    "item_id": {"type": "integer", "description": "Numeric ID of the reminder (from query_database)"},
                    "item_type": {"type": "string", "description": "Type: reminder (default)"}
                },
                "required": ["item_id"]
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "get_priorities",
            "description": "Get a ranked priority list across all domains (tasks, emails, finance, habits, calendar). Use when asked 'what should I focus on?', 'what are my priorities?', 'what's most important?', 'plan my day', 'what's urgent?'.",
            "parameters": {
                "type": "object",
                "properties": {
                    "limit": {"type": "integer", "description": "Max items to return (default 8)"}
                },
                "required": []
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "create_automation_rule",
            "description": "Create a trigger-action automation rule (like Zapier, but local). Use when user says 'alert me when', 'notify me if', 'remind me when X happens', 'create a rule for'. Examples: 'alert me when Swiggy spend > 2000 this week', 'notify when I have an overdue task', 'flag emails from boss@company.com'. Converts natural-language rules into persistent automation.",
            "parameters": {
                "type": "object",
                "properties": {
                    "name": {"type": "string", "description": "Human-readable rule name (e.g. 'Swiggy weekly limit alert')"},
                    "trigger_type": {"type": "string", "description": "Trigger type: spend_over (total/category exceeds threshold), category_spike (unusual spike vs avg), email_from (email arrives from sender), subscription_renewing (sub renews within N days), reminder_overdue (task past due), habit_streak_broken (habit not logged today)"},
                    "trigger_params": {"type": "string", "description": "JSON string of trigger parameters. spend_over: {category, threshold, period_days}. category_spike: {category, deviation_percent}. email_from: {sender_pattern, hours_window}. subscription_renewing: {days_ahead}. reminder_overdue: {hours_past_due}. habit_streak_broken: {habit_name}."},
                    "action_type": {"type": "string", "description": "Action type: notify (push notification to user), create_reminder (create a task), flag_email (mark email important)"},
                    "action_params": {"type": "string", "description": "JSON string of action parameters. notify: {message}. create_reminder: {title, priority}. flag_email: {label}."},
                    "cooldown_mins": {"type": "integer", "description": "Minutes between repeat firings to prevent spam (default 60, use 1440 for once-daily)"}
                },
                "required": ["name", "trigger_type", "trigger_params", "action_type", "action_params"]
            }
        }
    }
]


# ── Database Access ───────────────────────────────────────────────────────────

def _get_db_path():
    """Get the ARIA database path."""
    appdata = os.environ.get("APPDATA") or os.path.expanduser("~")
    return os.path.join(appdata, "aria-bot", "aria.db")


# Tables the LLM is allowed to query — settings is explicitly excluded
_ALLOWED_TABLES = {
    'transactions', 'spend_log', 'email_cache', 'reminders', 'habits', 'habit_log',
    'focus_sessions', 'calendar_events', 'subscriptions', 'behavior_metrics', 'notes',
    'budget_limits', 'chat_messages', 'context_threads', 'context_entities', 'ai_memory',
    'task_timeline', 'signal_log', 'task_time_data', 'relationship_contacts',
    'relationship_interactions', 'context_links', 'outcome_log',
}

# Tokens that must never appear in LLM-generated SQL
_SQL_BLOCKED_TOKENS = {
    'DROP', 'DELETE', 'INSERT', 'UPDATE', 'ALTER', 'CREATE', 'TRUNCATE',
    'UNION', 'PRAGMA', 'ATTACH', 'DETACH', 'VACUUM', 'REINDEX', 'LOAD_EXTENSION',
}


def _execute_sql(sql: str, db_path: str = "") -> Dict[str, Any]:
    """Execute a read-only SQL query against whitelisted tables only."""
    if not db_path:
        db_path = _get_db_path()

    sql_clean = sql.strip()
    sql_upper = sql_clean.upper()

    # 1. Must start with SELECT or WITH CTE
    if not sql_upper.startswith("SELECT") and not sql_upper.startswith("WITH"):
        return {"error": "Only SELECT/WITH queries are allowed", "rows": []}

    # 2. Tokenise (split on whitespace and common SQL punctuation)
    tokens = set(re.split(r'[\s;(),\[\]]+', sql_upper))
    tokens.discard('')

    # 3. Block forbidden keywords — covers UNION injection, DDL, PRAGMA, ATTACH
    blocked = tokens & _SQL_BLOCKED_TOKENS
    if blocked:
        return {"error": f"Query contains forbidden keyword(s): {', '.join(sorted(blocked))}", "rows": []}

    # 4. Block settings table — prevent OAuth token exfiltration
    if 'SETTINGS' in tokens:
        return {"error": "Access to the settings table is not permitted", "rows": []}

    try:
        conn = sqlite3.connect(db_path, timeout=5)
        conn.row_factory = sqlite3.Row
        cursor = conn.execute(sql_clean)
        rows = [dict(row) for row in cursor.fetchall()]
        conn.close()

        # Cap output size to prevent context window overflow
        if len(rows) > 50:
            return {"rows": rows[:50], "total": len(rows), "truncated": True}
        return {"rows": rows, "total": len(rows)}
    except Exception as e:
        return {"error": str(e), "rows": []}


def _resolve_category(cat: str) -> str:
    """Resolve a category synonym to its canonical name."""
    if not cat:
        return cat
    low = cat.lower().strip()
    return CATEGORY_SYNONYMS.get(low, low)


def _get_spending_analysis(category: Optional[str] = None, days: int = 30,
                           db_path: str = "") -> Dict[str, Any]:
    """Get spending analysis with anomaly detection."""
    if not db_path:
        db_path = _get_db_path()

    # Resolve category synonyms
    if category:
        category = _resolve_category(category)

    try:
        conn = sqlite3.connect(db_path, timeout=5)
        conn.row_factory = sqlite3.Row

        cutoff = f"CAST(strftime('%s','now','-{int(days)} days') AS INTEGER)"

        # Total spending
        if category:
            total = conn.execute(
                f"SELECT COALESCE(SUM(amount),0) as total, COUNT(*) as cnt "
                f"FROM transactions WHERE timestamp > {cutoff} AND LOWER(category) = ?",
                [category.lower()]
            ).fetchone()
        else:
            total = conn.execute(
                f"SELECT COALESCE(SUM(amount),0) as total, COUNT(*) as cnt "
                f"FROM transactions WHERE timestamp > {cutoff}"
            ).fetchone()

        # Category breakdown (top 8)
        breakdown = conn.execute(
            f"SELECT LOWER(category) as category, ROUND(SUM(amount),2) as total, COUNT(*) as cnt "
            f"FROM transactions WHERE timestamp > {cutoff} "
            f"GROUP BY LOWER(category) ORDER BY total DESC LIMIT 8"
        ).fetchall()

        # Top merchants
        if category:
            merchants = conn.execute(
                f"SELECT LOWER(merchant) as merchant, ROUND(SUM(amount),2) as total, COUNT(*) as cnt "
                f"FROM transactions WHERE timestamp > {cutoff} AND LOWER(category) = ? "
                f"GROUP BY LOWER(merchant) ORDER BY total DESC LIMIT 5",
                [category.lower()]
            ).fetchall()
        else:
            merchants = conn.execute(
                f"SELECT LOWER(merchant) as merchant, ROUND(SUM(amount),2) as total, COUNT(*) as cnt "
                f"FROM transactions WHERE timestamp > {cutoff} "
                f"GROUP BY LOWER(merchant) ORDER BY total DESC LIMIT 5"
            ).fetchall()

        # Anomalies from behavior_metrics
        anomalies = conn.execute(
            "SELECT category, deviation_percent, ROUND(weekly_spend,2) as weekly_spend, "
            "ROUND(rolling_4week_avg,2) as avg_4wk "
            "FROM behavior_metrics "
            "WHERE ABS(deviation_percent) > 30 "
            "ORDER BY period_start DESC LIMIT 5"
        ).fetchall()

        conn.close()

        return {
            "period_days": days,
            "filter_category": category,
            "total_spent": dict(total) if total else {"total": 0, "cnt": 0},
            "category_breakdown": [dict(r) for r in breakdown],
            "top_merchants": [dict(r) for r in merchants],
            "anomalies": [dict(r) for r in anomalies],
        }
    except Exception as e:
        return {"error": str(e)}


def _create_automation_rule(name: str, trigger_type: str, trigger_params: str,
                             action_type: str, action_params: str,
                             cooldown_mins: int = 60, db_path: str = "") -> Dict[str, Any]:
    """
    Create a new automation rule in the automation_rules table.
    Called by the agent when the user requests a natural-language rule like
    'alert me when Swiggy spend > 2000 this week' or 'flag emails from boss'.
    trigger_params and action_params arrive as JSON strings from Ollama.
    """
    if not db_path:
        db_path = _get_db_path()

    # Parse JSON params — Ollama may send either a string or an already-parsed dict
    def _parse_json(val):
        if isinstance(val, dict):
            return val
        try:
            return json.loads(val) if val else {}
        except Exception:
            return {}

    tp = _parse_json(trigger_params)
    ap = _parse_json(action_params)

    VALID_TRIGGERS = {'spend_over', 'category_spike', 'email_from',
                      'subscription_renewing', 'reminder_overdue', 'habit_streak_broken'}
    VALID_ACTIONS  = {'notify', 'create_reminder', 'flag_email'}

    if trigger_type not in VALID_TRIGGERS:
        return {"error": f"Unknown trigger_type '{trigger_type}'. Valid: {', '.join(VALID_TRIGGERS)}"}
    if action_type not in VALID_ACTIONS:
        return {"error": f"Unknown action_type '{action_type}'. Valid: {', '.join(VALID_ACTIONS)}"}

    try:
        conn = sqlite3.connect(db_path, timeout=5)
        now_ts = int(datetime.datetime.now().timestamp())
        conn.execute(
            """INSERT INTO automation_rules
               (name, trigger_type, trigger_params, action_type, action_params,
                cooldown_mins, enabled, fire_count, created_at)
               VALUES (?, ?, ?, ?, ?, ?, 1, 0, ?)""",
            (name, trigger_type, json.dumps(tp), action_type, json.dumps(ap),
             cooldown_mins, now_ts)
        )
        conn.commit()
        rule_id = conn.execute("SELECT last_insert_rowid() as id").fetchone()["id"]
        conn.close()
        return {
            "success": True,
            "rule_id": rule_id,
            "name": name,
            "trigger_type": trigger_type,
            "action_type": action_type,
            "message": f"Automation rule '{name}' created (ID {rule_id}). It will start evaluating on the next background sync (every 5 minutes)."
        }
    except Exception as e:
        return {"error": str(e)}


# ── Tool Execution ────────────────────────────────────────────────────────────

# Isolated thread pool — tool calls run here so they can be timed out
_tool_executor = ThreadPoolExecutor(max_workers=4, thread_name_prefix='aria-tool')

_TOOL_TIMEOUT_S = 20


def _execute_tool_inner(name: str, arguments: Dict[str, Any],
                        db_path: str = "", vector_dir: str = "") -> str:
    """Internal tool executor — runs in isolated thread for timeout enforcement."""
    try:
        if name == "query_database":
            result = _execute_sql(arguments.get("sql", ""), db_path)

        elif name == "search_knowledge":
            store = VectorStore(vector_dir) if vector_dir else VectorStore()
            raw = store.query(
                text=arguments.get("query", ""),
                n_results=arguments.get("num_results", 5),
                doc_type=arguments.get("doc_type"),
            )
            result = {"results": raw, "count": len(raw)}

        elif name == "get_spending_analysis":
            result = _get_spending_analysis(
                category=arguments.get("category"),
                days=arguments.get("days", 30),
                db_path=db_path,
            )

        elif name == "create_reminder":
            result = _create_reminder(
                title=arguments.get("title", ""),
                due_time_text=arguments.get("due_time", ""),
                category=arguments.get("category", "personal"),
                priority=arguments.get("priority", 3),
                db_path=db_path,
            )

        elif name == "add_expense":
            result = _add_expense(
                merchant=arguments.get("merchant", ""),
                amount=float(arguments.get("amount", 0)),
                category=arguments.get("category", "other"),
                description=arguments.get("description", ""),
                db_path=db_path,
            )

        elif name == "save_note":
            result = _save_note(
                title=arguments.get("title", "Note"),
                content=arguments.get("content", ""),
                db_path=db_path,
            )

        elif name == "mark_item_done":
            result = _mark_item_done(
                item_id=int(arguments.get("item_id", 0)),
                item_type=arguments.get("item_type", "reminder"),
                db_path=db_path,
            )

        elif name == "get_priorities":
            result = _get_priorities_tool(
                limit=int(arguments.get("limit", 8)),
                db_path=db_path,
            )

        elif name == "create_automation_rule":
            result = _create_automation_rule(
                name=arguments.get("name", "Unnamed Rule"),
                trigger_type=arguments.get("trigger_type", "spend_over"),
                trigger_params=arguments.get("trigger_params", "{}"),
                action_type=arguments.get("action_type", "notify"),
                action_params=arguments.get("action_params", "{}"),
                cooldown_mins=int(arguments.get("cooldown_mins", 60)),
                db_path=db_path,
            )

        else:
            result = {"error": f"Unknown tool: {name}"}

        return json.dumps(result, default=str, ensure_ascii=False)

    except Exception as e:
        return json.dumps({"error": str(e)})


def execute_tool(name: str, arguments: Dict[str, Any],
                 db_path: str = "", vector_dir: str = "") -> str:
    """Execute a tool call with a 20-second timeout for safety."""
    fut = _tool_executor.submit(_execute_tool_inner, name, arguments, db_path, vector_dir)
    try:
        return fut.result(timeout=_TOOL_TIMEOUT_S)
    except FuturesTimeout:
        fut.cancel()
        return json.dumps({"error": f"Tool '{name}' timed out after {_TOOL_TIMEOUT_S}s"})
    except Exception as e:
        return json.dumps({"error": str(e)})


# ── Ollama API ────────────────────────────────────────────────────────────────

_model_cache = None


def _select_model() -> str:
    """Select the best available model for tool calling. Cached after first call."""
    global _model_cache
    if _model_cache:
        return _model_cache

    try:
        r = requests.get(f"{OLLAMA_BASE}/api/tags", timeout=5)
        if r.status_code == 200:
            available = [m["name"] for m in r.json().get("models", [])]
            for model in MODEL_PREFERENCE:
                if model in available:
                    _model_cache = model
                    print(f"[Agent] Selected model: {model}", file=sys.stderr)
                    return model
    except Exception:
        pass

    _model_cache = MODEL_PREFERENCE[0]
    return _model_cache


def _call_ollama(messages: List[Dict], tools: Optional[List] = None,
                 model: str = None, max_tokens: int = 1024) -> Dict[str, Any]:
    """Call Ollama chat API with optional tool definitions."""
    if not model:
        model = _select_model()

    payload = {
        "model": model,
        "messages": messages,
        "stream": False,
        "options": {
            "temperature": 0.3,
            "num_predict": max_tokens,
        }
    }

    if tools:
        payload["tools"] = tools

    try:
        r = requests.post(
            f"{OLLAMA_BASE}/api/chat",
            json=payload,
            timeout=REQUEST_TIMEOUT,
        )
        if r.status_code == 200:
            return r.json()
        else:
            return {"error": f"Ollama HTTP {r.status_code}: {r.text[:200]}"}
    except requests.exceptions.Timeout:
        return {"error": "Ollama request timed out"}
    except requests.exceptions.ConnectionError:
        return {"error": "Cannot connect to Ollama — is it running?"}
    except Exception as e:
        return {"error": str(e)}


def _call_ollama_stream(messages: List[Dict], model: str = None, max_tokens: int = 1024):
    """
    Call Ollama with streaming=True. Yields str text chunks, then a final dict.
    Used for the human-readable final answer phase (after tools are done).
    """
    if not model:
        model = _select_model()

    payload = {
        "model": model,
        "messages": messages,
        "stream": True,
        "options": {"temperature": 0.3, "num_predict": max_tokens},
    }

    full_text = ""
    try:
        r = requests.post(
            f"{OLLAMA_BASE}/api/chat",
            json=payload,
            stream=True,
            timeout=(10, 20),  # (connect_timeout, idle_read_timeout between chunks)
        )
        if r.status_code != 200:
            yield {"text": "", "error": f"Ollama HTTP {r.status_code}"}
            return

        for raw_line in r.iter_lines():
            if not raw_line:
                continue
            try:
                data = json.loads(raw_line)
                delta = (data.get("message") or {}).get("content", "")
                if delta:
                    full_text += delta
                    yield delta  # str chunk — will be forwarded to renderer
                if data.get("done"):
                    break
            except (json.JSONDecodeError, Exception):
                continue

        yield {"text": full_text}  # final dict with accumulated text

    except requests.exceptions.Timeout:
        yield {"text": full_text, "error": "Ollama stream timed out"}
    except requests.exceptions.ConnectionError:
        yield {"text": full_text, "error": "Cannot connect to Ollama"}
    except Exception as e:
        yield {"text": full_text, "error": str(e)}


def _stream_content_as_chunks(text: str, chunk_size: int = 6):
    """Simulate streaming for already-computed text (e.g. first LLM pass had no tools)."""
    for i in range(0, len(text), chunk_size):
        yield text[i:i + chunk_size]


# ── Layered Intelligence: Interpreter + Deterministic Router ─────────────────
#
#  Layer 1 — Intent Interpreter   (cheap JSON-only LLM call, ~300 tokens)
#  Layer 2 — Deterministic Router (SQL templates, 0 runtime tokens)
#  Layer 3 — Narrative Layer       (existing agent loop, only when required)
#
# Decision:
#   confidence >= 0.75 AND needs_narrative=false AND intent != unknown
#     → Layer 2 (SQL) → _compose_response() → pseudo-stream → done
#   otherwise
#     → Layer 3 (existing agent) with slim context (last 2 turns only)

_INTERPRETER_SYSTEM = (
    "You are a JSON-only intent classifier. Output ONLY valid JSON. No prose. No markdown.\n\n"
    'Schema: {"intent":"<name>","domain":"<dom>","action":"<act>","filters":{},"needs_narrative":<bool>,"confidence":<float>}\n\n'
    "Intent names: spend_total, spend_compare, spend_trend, inbox_count, urgent_emails, "
    "events_upcoming, free_slots, overdue_tasks, streak_status, category_breakdown, multi, unknown\n"
    "Domains: expense, email, calendar, habit, note, task, multi, unknown\n"
    "Actions: query, compare, trend, count, list, explain, draft, rewrite, unknown\n\n"
    "needs_narrative=true when user says: explain, why, summarize, draft, rewrite, analyze, review, outlook\n"
    "needs_narrative=false when: numeric totals, counts, lists, filter queries, status checks\n\n"
    "filters keys: period (today/week/month/last_month/year), category (string), days (int), limit (int)\n\n"
    "Output ONLY the JSON object. Nothing else."
)

# ── Interpreter guardrails ────────────────────────────────────────────────────

# Whitelisted intent values — anything outside this set is forced to "unknown"
_VALID_INTENTS = frozenset({
    "spend_total", "spend_compare", "spend_trend", "inbox_count", "urgent_emails",
    "events_upcoming", "free_slots", "overdue_tasks", "streak_status",
    "category_breakdown", "multi", "unknown",
})

# Pronoun / follow-up words that should trigger intent reuse, not re-classification
_FOLLOWUP_PRONOUNS = frozenset({
    "it", "that", "those", "them", "there", "this", "same", "more", "else",
    "also", "similar", "related", "then", "again",
})

# Session-level counters (reset each Python process restart)
_interpreter_fail_count: int = 0
_deterministic_misfire_count: int = 0
_last_deterministic_intent: Optional[Dict[str, Any]] = None  # for follow-up reuse

# After this many consecutive interpreter failures, skip interpreter for the session
_INTERPRETER_FAIL_THRESHOLD = 3


def _validate_interpreter_output(parsed: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    """
    Validate and sanitise interpreter JSON output.
    Returns cleaned dict or None if output is unrecoverable.
    """
    if not isinstance(parsed, dict):
        return None
    # Required keys
    if "intent" not in parsed or "confidence" not in parsed:
        return None
    # Whitelist intent
    intent = str(parsed.get("intent", "unknown")).strip()
    if intent not in _VALID_INTENTS:
        intent = "unknown"
    parsed["intent"] = intent
    # Clamp confidence to [0.0, 1.0]
    try:
        conf = float(parsed["confidence"])
        parsed["confidence"] = max(0.0, min(1.0, conf))
    except (TypeError, ValueError):
        parsed["confidence"] = 0.0
    # Default optional fields
    parsed.setdefault("domain", "unknown")
    parsed.setdefault("action", "unknown")
    parsed.setdefault("filters", {})
    parsed.setdefault("needs_narrative", True)
    # Normalise needs_narrative to bool
    parsed["needs_narrative"] = bool(parsed.get("needs_narrative", True))
    return parsed


def _is_followup_message(message: str) -> bool:
    """
    Return True if the message is a short pronoun/follow-up that should
    reuse the previous deterministic intent rather than re-classify.
    """
    words = [w.strip("?.,!").lower() for w in message.strip().split() if w.strip("?.,!")]
    if len(words) <= 2 and any(w in _FOLLOWUP_PRONOUNS for w in words):
        return True
    # Very short bare queries like "yesterday?" or "last week?"
    if len(words) <= 2:
        return True
    return False


# Prefer smallest available model for interpreter — cached after first call
_INTERPRETER_MODELS = ["qwen2.5:0.5b", "qwen2.5:1.5b", "llama3.2:1b", "qwen2.5:3b"]
_interpreter_model_cache: Optional[str] = None


def _get_interpreter_model() -> str:
    global _interpreter_model_cache
    if _interpreter_model_cache:
        return _interpreter_model_cache
    try:
        r = requests.get(f"{OLLAMA_BASE}/api/tags", timeout=5)
        if r.status_code == 200:
            available = [m["name"] for m in r.json().get("models", [])]
            for m in _INTERPRETER_MODELS + MODEL_PREFERENCE:
                if m in available:
                    _interpreter_model_cache = m
                    print(f"[Interpreter] Model: {m}", file=sys.stderr)
                    return m
    except Exception:
        pass
    _interpreter_model_cache = MODEL_PREFERENCE[0]
    return _interpreter_model_cache


def _call_interpreter(message: str, last_user_turn: str = "") -> Optional[Dict[str, Any]]:
    """
    Lightweight LLM call — returns strict intent JSON or None on failure.
    Token budget: ~300 input + ~120 output. Temperature 0 for determinism.

    Guards applied before calling:
    - Skip if interpreter has failed too many times this session
    - Skip if message is a follow-up pronoun: reuse last deterministic intent
    - Skip if message is blank
    """
    global _interpreter_fail_count, _last_deterministic_intent

    if not message or not message.strip():
        return None

    # Auto-bypass: too many failures in this session
    if _interpreter_fail_count >= _INTERPRETER_FAIL_THRESHOLD:
        _emit_log("interpreter_bypassed", tokens=0, intent="",
                  reason=f"fail_count={_interpreter_fail_count}")
        return None

    # Follow-up reuse: short pronoun message → inherit last deterministic intent
    if _is_followup_message(message) and _last_deterministic_intent is not None:
        reused = dict(_last_deterministic_intent)
        # Adjust period if message contains a time word
        msg_l = message.lower()
        for period_kw, period_val in [("yesterday", "today"), ("last week", "week"),
                                       ("last month", "last_month"), ("this year", "year"),
                                       ("today", "today"), ("this week", "week"),
                                       ("this month", "month")]:
            if period_kw in msg_l:
                reused.setdefault("filters", {})["period"] = period_val
                break
        reused["confidence"] = 0.85  # inherit with moderate confidence
        _emit_log("interpreter_followup_reuse", tokens=0, intent=reused.get("intent", ""),
                  reason="pronoun/short follow-up")
        return reused

    # Build user content — hard cap at 300 chars to stay within token budget
    user_content = message[:300]
    if last_user_turn:
        user_content = f"[prev: {last_user_turn[:80]}]\n{user_content}"

    model = _get_interpreter_model()
    payload = {
        "model": model,
        "messages": [
            {"role": "system", "content": _INTERPRETER_SYSTEM},
            {"role": "user", "content": user_content},
        ],
        "stream": False,
        "options": {"temperature": 0.0, "num_predict": 120},
    }

    try:
        r = requests.post(f"{OLLAMA_BASE}/api/chat", json=payload, timeout=(5, 10))
        if r.status_code != 200:
            _interpreter_fail_count += 1
            _emit_log("interpreter_error", tokens=0, intent="",
                      reason=f"http_{r.status_code}")
            return None
        raw = r.json().get("message", {}).get("content", "").strip()
        # Strip markdown fences if the model wraps output
        if raw.startswith("```"):
            raw = re.sub(r"```[a-z]*\n?", "", raw).strip().rstrip("`").strip()
        parsed = json.loads(raw)
        validated = _validate_interpreter_output(parsed)
        if validated is None:
            _interpreter_fail_count += 1
            _emit_log("interpreter_invalid_schema", tokens=0, intent="",
                      reason="missing keys or unparseable")
            return None
        tokens_est = (len(_INTERPRETER_SYSTEM) + len(user_content) + len(raw)) // 4
        _emit_log("interpreter_called", tokens=tokens_est,
                  intent=validated.get("intent", ""),
                  confidence=round(validated.get("confidence", 0.0), 3))
        # Reset fail counter on success
        _interpreter_fail_count = 0
        return validated
    except Exception as exc:
        _interpreter_fail_count += 1
        print(f"[Interpreter] Failed ({_interpreter_fail_count}/{_INTERPRETER_FAIL_THRESHOLD}): {exc}",
              file=sys.stderr)
        _emit_log("interpreter_exception", tokens=0, intent="", reason=str(exc)[:80])
        return None


# ── Deterministic SQL Templates ───────────────────────────────────────────────

def _period_where_spend(period: str) -> str:
    """Return a spend_log WHERE clause for a named period (uses occurred_at INTEGER unix epoch)."""
    p = (period or "month").lower()
    if p == "today":
        return "occurred_at >= strftime('%s', date('now'))"
    elif p == "week":
        return "occurred_at >= strftime('%s', date('now','-7 days'))"
    elif p == "last_month":
        return ("occurred_at >= strftime('%s', date('now','start of month','-1 month')) "
                "AND occurred_at < strftime('%s', date('now','start of month'))")
    elif p == "year":
        return "occurred_at >= strftime('%s', date('now','start of year'))"
    else:
        return "occurred_at >= strftime('%s', date('now','start of month'))"


def _check_spend_outlier(value: float, period: str = "month",
                         conn: Optional[Any] = None) -> Optional[str]:
    """
    Inline outlier sanity check for a spend total.
    Returns a warning string if value looks anomalous, else None.
    Thresholds are intentionally generous to avoid false positives.
    """
    # Absolute outlier: >₹10 Lakh (10,00,000) in a single month is unusual for personal use
    if value > 1_000_000:
        return f"⚠ ₹{value:,.0f} looks unusually high — verify data integrity."
    # Relative outlier: compare to rolling avg if conn provided
    if conn is not None and period in ("today", "week", "month"):
        try:
            avg_row = conn.execute(
                "SELECT ROUND(AVG(monthly_total),2) FROM ("
                "  SELECT SUM(amount_raw) as monthly_total FROM spend_log "
                "  WHERE occurred_at >= strftime('%s', date('now','-90 days')) "
                "  GROUP BY strftime('%Y-%m', datetime(occurred_at,'unixepoch'))"
                ")"
            ).fetchone()
            if avg_row:
                avg = float(avg_row[0] or 0)
                if avg > 0 and value > avg * 5:
                    return f"⚠ This is {value / avg:.1f}× higher than your 3-month average (₹{avg:,.0f}/mo)."
        except Exception:
            pass
    return None


def _route_deterministic(intent_data: Dict[str, Any], db_path: str) -> Optional[Dict[str, Any]]:
    """
    Execute a deterministic SQL query for a known intent.
    SQL is written here (never from LLM input) so whitelist doesn't apply,
    but we still use the existing _execute_sql path for read-only enforcement.
    Returns a structured dict, or None if intent is not routable.
    """
    intent = intent_data.get("intent", "unknown")
    filters = intent_data.get("filters") or {}
    if not db_path:
        db_path = _get_db_path()

    try:
        conn = sqlite3.connect(db_path, timeout=5)
        conn.row_factory = sqlite3.Row

        if intent == "spend_total":
            period = filters.get("period", "month")
            cat = filters.get("category")
            where = _period_where_spend(period)
            if cat:
                cat_r = _resolve_category(cat)
                row = conn.execute(
                    f"SELECT COALESCE(SUM(amount_raw),0) as total, COUNT(*) as cnt "
                    f"FROM spend_log WHERE {where} AND LOWER(category)=?",
                    [cat_r.lower()],
                ).fetchone()
            else:
                row = conn.execute(
                    f"SELECT COALESCE(SUM(amount_raw),0) as total, COUNT(*) as cnt "
                    f"FROM spend_log WHERE {where}"
                ).fetchone()
            result = dict(row) if row else {"total": 0, "cnt": 0}
            outlier_warn = _check_spend_outlier(float(result.get("total", 0)), period, conn)
            conn.close()
            result.update({"period": period, "category": cat, "intent": intent})
            if outlier_warn:
                result["outlier_warning"] = outlier_warn
            return result

        elif intent == "spend_compare":
            tm_row = conn.execute(
                "SELECT COALESCE(SUM(amount_raw),0) as total FROM spend_log "
                "WHERE occurred_at >= strftime('%s', date('now','start of month'))"
            ).fetchone()
            lm_row = conn.execute(
                "SELECT COALESCE(SUM(amount_raw),0) as total FROM spend_log "
                "WHERE occurred_at >= strftime('%s', date('now','start of month','-1 month')) "
                "AND occurred_at < strftime('%s', date('now','start of month'))"
            ).fetchone()
            tm = float(dict(tm_row)["total"]) if tm_row else 0.0
            lm = float(dict(lm_row)["total"]) if lm_row else 0.0
            diff = tm - lm
            pct = round(diff / lm * 100, 1) if lm > 0 else None
            outlier_warn = _check_spend_outlier(tm, "month", conn)
            conn.close()
            result = {"intent": intent, "this_month": tm, "last_month": lm,
                      "diff": diff, "pct_change": pct}
            if outlier_warn:
                result["outlier_warning"] = outlier_warn
            return result

        elif intent == "spend_trend":
            rows = conn.execute(
                "SELECT strftime('%Y-%m', datetime(occurred_at,'unixepoch')) as month, "
                "ROUND(SUM(amount_raw),2) as total, "
                "COUNT(*) as cnt FROM spend_log "
                "WHERE occurred_at >= strftime('%s', date('now','-90 days')) "
                "GROUP BY strftime('%Y-%m', datetime(occurred_at,'unixepoch')) ORDER BY month ASC"
            ).fetchall()
            conn.close()
            return {"intent": intent, "months": [dict(r) for r in rows]}

        elif intent == "inbox_count":
            row = conn.execute(
                "SELECT COUNT(*) as total, "
                "SUM(CASE WHEN is_read=0 THEN 1 ELSE 0 END) as unread "
                "FROM email_cache"
            ).fetchone()
            conn.close()
            return {"intent": intent, **(dict(row) if row else {"total": 0, "unread": 0})}

        elif intent == "urgent_emails":
            limit = int(filters.get("limit", 5))
            rows = conn.execute(
                "SELECT subject, from_name, from_email, "
                "datetime(received_at,'unixepoch') as received "
                "FROM email_cache WHERE is_read=0 "
                "ORDER BY received_at DESC LIMIT ?",
                [limit],
            ).fetchall()
            conn.close()
            return {"intent": intent, "emails": [dict(r) for r in rows], "count": len(rows)}

        elif intent == "events_upcoming":
            days = int(filters.get("days", 7))
            now_ts = int(datetime.datetime.now().timestamp())
            end_ts = now_ts + days * 86400
            rows = conn.execute(
                "SELECT title, datetime(start_at,'unixepoch') as start, location "
                "FROM calendar_events WHERE start_at BETWEEN ? AND ? "
                "ORDER BY start_at ASC LIMIT 10",
                [now_ts, end_ts],
            ).fetchall()
            conn.close()
            return {"intent": intent, "events": [dict(r) for r in rows], "days": days}

        elif intent == "overdue_tasks":
            now_ts = int(datetime.datetime.now().timestamp())
            rows = conn.execute(
                "SELECT id, title, category, datetime(due_at,'unixepoch') as due "
                "FROM reminders WHERE completed=0 AND archived_at IS NULL "
                "AND due_at IS NOT NULL AND due_at < ? ORDER BY due_at ASC LIMIT 10",
                [now_ts],
            ).fetchall()
            conn.close()
            return {"intent": intent, "overdue": [dict(r) for r in rows], "count": len(rows)}

        elif intent == "streak_status":
            today = datetime.datetime.now().strftime('%Y-%m-%d')
            rows = conn.execute(
                "SELECT h.name, hl.done FROM habits h "
                "LEFT JOIN habit_log hl ON hl.habit_id=h.id AND hl.date=? "
                "ORDER BY h.name",
                [today],
            ).fetchall()
            conn.close()
            return {"intent": intent, "habits": [dict(r) for r in rows], "date": today}

        elif intent == "category_breakdown":
            period = filters.get("period", "month")
            where = _period_where_spend(period)
            rows = conn.execute(
                f"SELECT LOWER(category) as category, ROUND(SUM(amount_raw),2) as total, "
                f"COUNT(*) as cnt FROM spend_log WHERE {where} "
                f"GROUP BY LOWER(category) ORDER BY total DESC LIMIT 10"
            ).fetchall()
            conn.close()
            return {"intent": intent, "period": period, "categories": [dict(r) for r in rows]}

        else:
            conn.close()
            return None

    except Exception as exc:
        print(f"[Deterministic] Error routing {intent}: {exc}", file=sys.stderr)
        return None


def _compose_response(r: Dict[str, Any]) -> str:
    """
    Build a human-like response string from a deterministic result dict.
    No LLM. Template-driven but natural. Mirrors ARIA's voice (direct, minimal).
    """
    intent = r.get("intent", "")

    if intent == "spend_total":
        total = float(r.get("total", 0))
        cnt = int(r.get("cnt", 0))
        period = r.get("period", "month")
        cat = r.get("category")
        lbl = {"today": "today", "week": "this week", "month": "this month",
               "last_month": "last month", "year": "this year"}.get(period, period)
        if total == 0:
            return f"[STATUS] No spend recorded {lbl}{' for ' + cat if cat else ''}."
        on_cat = f" on {cat}" if cat else ""
        warn = ("\n" + r.get("outlier_warning", "")) if r.get("outlier_warning") else ""
        return (f"[STATUS] ₹{total:,.0f}{on_cat} {lbl} "
                f"across {cnt} transaction{'s' if cnt != 1 else ''}.{warn}\n\n"
                f"FOLLOW_UP: What's the breakdown by category? | "
                f"Compare to last month? | Which merchants were the biggest?")

    elif intent == "spend_compare":
        tm = float(r.get("this_month", 0))
        lm = float(r.get("last_month", 0))
        diff = float(r.get("diff", 0))
        pct = r.get("pct_change")
        if lm == 0 and tm == 0:
            return "[STATUS] No spend data for either month."
        direction = "↑" if diff > 0 else "↓"
        pct_str = f" ({abs(pct):.1f}%)" if pct is not None else ""
        verdict = "over last month" if diff > 0 else "under last month"
        warn = ("\n" + r.get("outlier_warning", "")) if r.get("outlier_warning") else ""
        return (f"[ACTION] This month ₹{tm:,.0f} · Last month ₹{lm:,.0f}\n"
                f"{direction} ₹{abs(diff):,.0f}{pct_str} {verdict}.{warn}\n\n"
                f"FOLLOW_UP: Which category drove the increase? | "
                f"Show me the trend | What am I spending most on?")

    elif intent == "spend_trend":
        months = r.get("months", [])
        if not months:
            return "[STATUS] No spending data in the last 3 months."
        parts = [f"{m['month']}: ₹{float(m['total']):,.0f}" for m in months]
        return (f"[FYI] 3-month trend:\n" + "\n".join(f"• {p}" for p in parts) + "\n\n"
                f"FOLLOW_UP: Explain what changed | "
                f"Break down by category | Compare to budget?")

    elif intent == "inbox_count":
        total = int(r.get("total", 0))
        unread = int(r.get("unread", 0))
        if total == 0:
            return "[STATUS] Inbox cache is empty — sync emails first."
        return (f"[STATUS] {unread} unread of {total} cached emails.\n\n"
                f"FOLLOW_UP: Show urgent ones | "
                f"Any emails from a specific sender? | Summarize what's new?")

    elif intent == "urgent_emails":
        emails = r.get("emails", [])
        if not emails:
            return "[STATUS] No unread emails in cache."
        lines = "\n".join(
            f"• {e.get('from_name') or e.get('from_email', '?')}: "
            f"{e.get('subject', '(no subject)')}"
            for e in emails[:5]
        )
        return (f"[ACTION] {len(emails)} unread:\n{lines}\n\n"
                f"FOLLOW_UP: Draft a reply to one? | "
                f"Mark all as read? | Any from a specific sender?")

    elif intent == "events_upcoming":
        events = r.get("events", [])
        days = int(r.get("days", 7))
        if not events:
            return f"[STATUS] Nothing on calendar in the next {days} days."
        lines = "\n".join(
            f"• {(e.get('start') or '')[:16].replace('T', ' ')} — "
            f"{e.get('title', '?')}"
            + (f" @ {e['location']}" if e.get("location") else "")
            for e in events[:8]
        )
        return (f"[STATUS] Next {days} days:\n{lines}\n\n"
                f"FOLLOW_UP: What am I free tomorrow? | "
                f"Prep notes for any of these? | Any conflicts?")

    elif intent == "overdue_tasks":
        overdue = r.get("overdue", [])
        if not overdue:
            return "[STATUS] No overdue tasks — clear."
        lines = "\n".join(
            f"• [{t.get('category', '?')}] {t.get('title', '?')} "
            f"(due {(t.get('due') or '')[:10]})"
            for t in overdue[:8]
        )
        return (f"[RISK] {len(overdue)} overdue task{'s' if len(overdue) != 1 else ''}:\n{lines}\n\n"
                f"FOLLOW_UP: Mark one done? | "
                f"What's highest priority? | Reschedule any?")

    elif intent == "streak_status":
        habits = r.get("habits", [])
        date = r.get("date", "today")
        if not habits:
            return "[STATUS] No habits tracked yet."
        done = [h for h in habits if h.get("done") == 1]
        pending = [h for h in habits if h.get("done") != 1]
        lines = []
        if done:
            lines.append("✓ Done: " + ", ".join(h["name"] for h in done))
        if pending:
            lines.append("✗ Pending: " + ", ".join(h["name"] for h in pending))
        return (f"[STATUS] Habits {date}:\n" + "\n".join(lines) + "\n\n"
                f"FOLLOW_UP: Log one as done? | "
                f"Show streak history? | Any at risk?")

    elif intent == "category_breakdown":
        cats = r.get("categories", [])
        period = r.get("period", "month")
        lbl = {"today": "today", "week": "this week", "month": "this month",
               "last_month": "last month", "year": "this year"}.get(period, period)
        if not cats:
            return f"[STATUS] No spend data {lbl}."
        lines = "\n".join(
            f"• {c['category']}: ₹{float(c['total']):,.0f} "
            f"({c['cnt']} txn{'s' if c['cnt'] != 1 else ''})"
            for c in cats[:8]
        )
        return (f"[FYI] Spending {lbl} by category:\n{lines}\n\n"
                f"FOLLOW_UP: Drill into a specific category? | "
                f"Compare to last month? | Any over budget?")

    return ""


def _emit_log(event: str, tokens: int = 0, intent: str = "",
              confidence: float = 0.0, reason: str = "") -> None:
    """Emit a structured metrics log line to stderr for observability."""
    entry: Dict[str, Any] = {
        "_aria_log": event,
        "tokens": tokens,
        "intent": intent,
        "ts": int(time.time()),
    }
    if confidence:
        entry["confidence"] = confidence
    if reason:
        entry["reason"] = reason
    print(json.dumps(entry), file=sys.stderr)


# ── Agent Core ────────────────────────────────────────────────────────────────

def agent_chat(
    message: str,
    conversation_history: Optional[List[Dict]] = None,
    db_path: str = "",
    vector_dir: str = "",
) -> Dict[str, Any]:
    """
    Main agent entry point. Processes user messages through an agentic loop:
      1. Send message + tools to Ollama
      2. If Ollama calls tools → execute → feed results back
      3. Iterate until final text response (max 3 iterations)

    Args:
        message: The user's current message
        conversation_history: List of {role, content} dicts for context
        db_path: Path to ARIA's SQLite database
        vector_dir: Path to ChromaDB vector store directory

    Returns:
        { "text": str, "tools_used": list, "model": str, "iterations": int }
    """
    if not db_path:
        db_path = _get_db_path()
    if not vector_dir:
        appdata = os.environ.get("APPDATA") or os.path.expanduser("~")
        vector_dir = os.path.join(appdata, "aria-bot", "vectors")

    # ── Layer 1+2: Interpreter Gate → Deterministic Route ────────────────────
    # Pull last user turn for follow-up context in interpreter
    _last_user_turn = ""
    if conversation_history:
        for _t in reversed(conversation_history[-2:]):
            if _t.get("role") == "user":
                _last_user_turn = _t.get("content", _t.get("text", ""))[:100]
                break

    global _last_deterministic_intent, _deterministic_misfire_count

    _intent_data = _call_interpreter(message, _last_user_turn)
    _slim_context = False
    _narrative_budget = 1024  # default
    if _intent_data is not None:
        _conf = float(_intent_data.get("confidence", 0))
        _needs_narrative = bool(_intent_data.get("needs_narrative", True))
        _intent_name = _intent_data.get("intent", "unknown")

        if _conf >= 0.75 and not _needs_narrative and _intent_name != "unknown":
            _det = _route_deterministic(_intent_data, db_path)
            if _det is not None:
                _resp = _compose_response(_det)
                if _resp:
                    _last_deterministic_intent = _intent_data
                    _emit_log("deterministic_routed", tokens=0, intent=_intent_name,
                              confidence=_conf)
                    return {
                        "text": _resp,
                        "tools_used": [],
                        "model": "deterministic",
                        "iterations": 0,
                        "routed": "deterministic",
                    }
                else:
                    _deterministic_misfire_count += 1
                    _emit_log("deterministic_misfire", tokens=0, intent=_intent_name,
                              reason="compose returned empty")
            else:
                _deterministic_misfire_count += 1
                _emit_log("deterministic_misfire", tokens=0, intent=_intent_name,
                          reason="route returned None")

        # Fell through to LLM — log why
        if _needs_narrative:
            _emit_log("narrative_called", tokens=0, intent=_intent_name,
                      reason="needs_narrative=true", confidence=_conf)
            _narrative_budget = 2000 if _intent_name == "multi" else 800
        elif _conf < 0.75:
            _emit_log("fallback_reason", tokens=0, intent=_intent_name,
                      reason=f"low_confidence={_conf:.2f}")
        elif _intent_name == "unknown":
            _emit_log("fallback_reason", tokens=0, intent="unknown",
                      reason="intent_unknown")
        _slim_context = True  # use slim context for all interpreter-classified falls-through
    else:
        _emit_log("fallback_reason", tokens=0, intent="", reason="interpreter_returned_none")
    # ── End Interpreter Gate ─────────────────────────────────────────────────

    model = _select_model()

    # Build messages array — inject entity memory into system prompt (Phase F)
    entity_memory = _get_entity_memory(db_path)
    system_content = SYSTEM_PROMPT + entity_memory if entity_memory else SYSTEM_PROMPT
    messages = [{"role": "system", "content": system_content}]

    # History window: slim=2 turns; full=6 turns (was 12 — capped to reduce token waste)
    _history_limit = 2 if _slim_context else 6

    # Add conversation history
    if conversation_history:
        for turn in conversation_history[-_history_limit:]:
            role = turn.get("role", "user")
            content = turn.get("content", turn.get("text", ""))
            if content and role in ("user", "assistant"):
                # Truncate very long messages to keep context manageable
                if len(content) > 500:
                    content = content[:497] + "..."
                messages.append({"role": role, "content": content})

    # Add current user message with today's date for temporal context
    today_str = datetime.datetime.now().strftime('%A, %B %d, %Y')
    messages.append({
        "role": "user",
        "content": f"[Today is {today_str}]\n{message}"
    })

    tools_used = []
    iterations = 0

    # ── Agent Loop: call Ollama → execute tools → feed back → repeat ──
    for iteration in range(MAX_ITERATIONS):
        iterations = iteration + 1

        response = _call_ollama(messages, tools=TOOLS, model=model)

        if "error" in response:
            return {
                "text": "",
                "tools_used": tools_used,
                "model": model,
                "iterations": iterations,
                "error": response["error"],
            }

        assistant_msg = response.get("message", {})
        content = assistant_msg.get("content", "") or ""
        tool_calls = assistant_msg.get("tool_calls") or []

        # Add assistant message to conversation
        messages.append(assistant_msg)

        # If no tool calls → final answer (apply narrative budget)
        if not tool_calls:
            _emit_log("narrative_tokens_used", tokens=len(content) // 4,
                      intent=_intent_data.get("intent", "") if _intent_data else "")
            return {
                "text": content.strip(),
                "tools_used": tools_used,
                "model": model,
                "iterations": iterations,
            }

        # Execute each tool call
        for tc in tool_calls:
            func = tc.get("function", {})
            tool_name = func.get("name", "")

            # Parse arguments — handle both dict and string formats
            args = func.get("arguments", {})
            if isinstance(args, str):
                try:
                    args = json.loads(args)
                except (json.JSONDecodeError, ValueError):
                    args = {}

            print(f"[Agent] Tool call: {tool_name}({json.dumps(args, ensure_ascii=False)[:100]})",
                  file=sys.stderr)

            # Execute
            tool_result = execute_tool(tool_name, args, db_path, vector_dir)

            tools_used.append({
                "name": tool_name,
                "arguments": args,
            })

            # Feed tool result back to Ollama
            messages.append({
                "role": "tool",
                "content": tool_result,
            })

    # Exhausted iterations — get final response without tools (apply narrative budget cap)
    response = _call_ollama(messages, tools=None, model=model, max_tokens=_narrative_budget)
    content = response.get("message", {}).get("content", "")

    return {
        "text": content.strip() if content else "I analyzed the data but couldn't form a clear answer. Try rephrasing?",
        "tools_used": tools_used,
        "model": model,
        "iterations": iterations,
    }


def agent_chat_stream(
    message: str,
    conversation_history: Optional[List[Dict]] = None,
    db_path: str = "",
    vector_dir: str = "",
):
    """
    Streaming version of agent_chat.

    Phase 1: Tool-calling loop runs non-streaming (Ollama tools + streaming can't co-exist).
    Phase 2: Final answer generation runs with stream=True — yields text chunks.

    Yields:
        str  — incremental text chunks (forward to renderer as they arrive)
        dict — final result: { text, tools_used, model, iterations }
    """
    if not db_path:
        db_path = _get_db_path()
    if not vector_dir:
        appdata = os.environ.get("APPDATA") or os.path.expanduser("~")
        vector_dir = os.path.join(appdata, "aria-bot", "vectors")

    # ── Layer 1+2: Interpreter Gate → Deterministic Route ─────────────────────
    _last_user_turn_s = ""
    if conversation_history:
        for _t in reversed(conversation_history[-2:]):
            if _t.get("role") == "user":
                _last_user_turn_s = _t.get("content", _t.get("text", ""))[:100]
                break

    global _last_deterministic_intent, _deterministic_misfire_count

    _intent_data_s = _call_interpreter(message, _last_user_turn_s)
    _slim_context_s = False
    _narrative_budget_s = 1024  # default
    if _intent_data_s is not None:
        _conf_s = float(_intent_data_s.get("confidence", 0))
        _needs_nar_s = bool(_intent_data_s.get("needs_narrative", True))
        _intent_name_s = _intent_data_s.get("intent", "unknown")

        if _conf_s >= 0.75 and not _needs_nar_s and _intent_name_s != "unknown":
            _det_s = _route_deterministic(_intent_data_s, db_path)
            if _det_s is not None:
                _resp_s = _compose_response(_det_s)
                if _resp_s:
                    _last_deterministic_intent = _intent_data_s
                    _emit_log("deterministic_routed", tokens=0, intent=_intent_name_s,
                              confidence=_conf_s)
                    for _chunk in _stream_content_as_chunks(_resp_s):
                        yield _chunk
                    yield {
                        "text": _resp_s,
                        "tools_used": [],
                        "model": "deterministic",
                        "iterations": 0,
                        "routed": "deterministic",
                    }
                    return
                else:
                    _deterministic_misfire_count += 1
                    _emit_log("deterministic_misfire", tokens=0, intent=_intent_name_s,
                              reason="compose returned empty")
            else:
                _deterministic_misfire_count += 1
                _emit_log("deterministic_misfire", tokens=0, intent=_intent_name_s,
                          reason="route returned None")

        # Fell through to LLM — log why
        if _needs_nar_s:
            _emit_log("narrative_called", tokens=0, intent=_intent_name_s,
                      reason="needs_narrative=true", confidence=_conf_s)
            _narrative_budget_s = 2000 if _intent_name_s == "multi" else 800
        elif _conf_s < 0.75:
            _emit_log("fallback_reason", tokens=0, intent=_intent_name_s,
                      reason=f"low_confidence={_conf_s:.2f}")
        elif _intent_name_s == "unknown":
            _emit_log("fallback_reason", tokens=0, intent="unknown", reason="intent_unknown")
        _slim_context_s = True
    else:
        _emit_log("fallback_reason", tokens=0, intent="", reason="interpreter_returned_none")
    # ── End Interpreter Gate ──────────────────────────────────────────────────

    model = _select_model()
    entity_memory = _get_entity_memory(db_path)
    system_content = SYSTEM_PROMPT + entity_memory if entity_memory else SYSTEM_PROMPT

    messages = [{"role": "system", "content": system_content}]

    # History window: slim=2 turns; full=6 turns (was 12 — capped for token savings)
    _history_limit_s = 2 if _slim_context_s else 6

    if conversation_history:
        for turn in conversation_history[-_history_limit_s:]:
            role = turn.get("role", "user")
            content = turn.get("content", turn.get("text", ""))
            if content and role in ("user", "assistant"):
                if len(content) > 500:
                    content = content[:497] + "..."
                messages.append({"role": role, "content": content})

    today_str = datetime.datetime.now().strftime('%A, %B %d, %Y')
    messages.append({"role": "user", "content": f"[Today is {today_str}]\n{message}"})

    tools_used: List[Dict] = []
    iterations = 0

    # Phase 1: Tool-calling loop (non-streaming, up to MAX_ITERATIONS - 1)
    for iteration in range(MAX_ITERATIONS - 1):
        iterations = iteration + 1
        response = _call_ollama(messages, tools=TOOLS, model=model)

        if "error" in response:
            yield {"text": "", "tools_used": tools_used, "model": model,
                   "iterations": iterations, "error": response["error"]}
            return

        assistant_msg = response.get("message", {})
        content = assistant_msg.get("content", "") or ""
        tool_calls = assistant_msg.get("tool_calls") or []
        messages.append(assistant_msg)

        if not tool_calls:
            # No tools needed — stream the already-computed answer
            full_text = ""
            for chunk in _stream_content_as_chunks(content.strip()):
                full_text += chunk
                yield chunk
            yield {"text": full_text, "tools_used": tools_used,
                   "model": model, "iterations": iterations}
            return

        # Execute each tool call
        for tc in tool_calls:
            func = tc.get("function", {})
            tool_name = func.get("name", "")
            args = func.get("arguments", {})
            if isinstance(args, str):
                try:
                    args = json.loads(args)
                except Exception:
                    args = {}
            print(f"[Agent] Stream tool: {tool_name}({json.dumps(args, ensure_ascii=False)[:80]})",
                  file=sys.stderr)
            tool_result = execute_tool(tool_name, args, db_path, vector_dir)
            tools_used.append({"name": tool_name, "arguments": args})
            messages.append({"role": "tool", "content": tool_result})

    # Phase 2: Final streaming response (tools done, stream the human-readable answer)
    full_text = ""
    for item in _call_ollama_stream(messages, model=model, max_tokens=_narrative_budget_s):
        if isinstance(item, str):
            full_text += item
            yield item  # stream chunk to Node
        elif isinstance(item, dict):
            final_text = item.get("text", full_text)
            _emit_log("narrative_tokens_used", tokens=len(final_text) // 4,
                      intent=_intent_data_s.get("intent", "") if _intent_data_s else "")
            yield {"text": final_text, "tools_used": tools_used,
                   "model": model, "iterations": MAX_ITERATIONS}
            return

    yield {"text": full_text, "tools_used": tools_used, "model": model, "iterations": iterations}


# ── Quick Test ────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    # Quick test: run with a sample query
    query = sys.argv[1] if len(sys.argv) > 1 else "How much did I spend this month?"
    print(f"Testing agent with: {query}")
    result = agent_chat(query)
    print(f"\nModel: {result['model']}")
    print(f"Iterations: {result['iterations']}")
    print(f"Tools used: {json.dumps(result['tools_used'], indent=2)}")
    print(f"\nResponse:\n{result['text']}")
