"""
test_aria.py — ARIA Python Engine Test Suite
Tests all Python modules: intents, priority, agent (layers), vectors, engine

Run with:
    cd aria-bot/python-engine
    python -m pytest test_aria.py -v 2>&1
  or
    python test_aria.py       (standalone runner, no pytest required)

Coverage:
  - intents.py        : match_intent, _resolve_category, category synonyms
  - priority.py       : compute_priorities (empty db, with data, schema mismatches)
  - agent.py          : _validate_interpreter_output, _is_followup_message,
                        _period_where_spend, _check_spend_outlier,
                        _compose_response, _emit_log, _route_deterministic
  - vectors.py        : VectorStore instantiation, lazy init, count
  - engine.py         : handle_request router (ping, check_imports, intent, unknown)
"""

import sys
import os
import json
import sqlite3
import tempfile
import time
import io

# ── Path setup ────────────────────────────────────────────────────────────────
_HERE = os.path.dirname(os.path.abspath(__file__))
if _HERE not in sys.path:
    sys.path.insert(0, _HERE)

# ══════════════════════════════════════════════════════════════════════════════
# HELPERS
# ══════════════════════════════════════════════════════════════════════════════

def _ts(days_ago: int = 0) -> int:
    """Return a unix timestamp for start-of-day N days ago (UTC)."""
    import datetime
    d = datetime.datetime.utcnow().replace(hour=12, minute=0, second=0, microsecond=0)
    return int((d - datetime.timedelta(days=days_ago)).timestamp())


def _month_start_ts(months_ago: int = 0) -> int:
    """Return unix timestamp for the 1st of the month N months back."""
    import datetime
    today = datetime.date.today()
    year, month = today.year, today.month
    month -= months_ago
    while month <= 0:
        month += 12
        year -= 1
    return int(datetime.datetime(year, month, 1, 12, 0, 0).timestamp())


def _make_spend_db(rows=None):
    """
    Create a temp SQLite file with spend_log using the canonical schema:
      spend_log(id, category, amount_raw REAL, occurred_at INTEGER, description)
    Rows format: (category: str, amount_raw: float, occurred_at: int)
    """
    f = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
    f.close()
    conn = sqlite3.connect(f.name)
    conn.execute("""
        CREATE TABLE spend_log (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            category TEXT NOT NULL DEFAULT 'other',
            amount_raw REAL NOT NULL DEFAULT 0,
            occurred_at INTEGER NOT NULL,
            description TEXT
        )
    """)
    conn.execute("""
        CREATE TABLE email_cache (
            id TEXT PRIMARY KEY,
            subject TEXT,
            from_name TEXT,
            from_email TEXT,
            is_read INTEGER DEFAULT 0,
            category TEXT,
            cached_at INTEGER,
            body_preview TEXT,
            received_at INTEGER
        )
    """)
    conn.execute("""
        CREATE TABLE calendar_events (
            id TEXT PRIMARY KEY,
            title TEXT,
            start_at INTEGER,
            end_at INTEGER,
            location TEXT,
            description TEXT,
            calendar_url TEXT,
            cached_at INTEGER
        )
    """)
    conn.execute("""
        CREATE TABLE reminders (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            title TEXT NOT NULL,
            due_at INTEGER NOT NULL,
            recurring TEXT,
            completed INTEGER DEFAULT 0,
            snoozed_to INTEGER,
            category TEXT DEFAULT 'task',
            subtitle TEXT,
            source TEXT DEFAULT 'manual',
            priority_score REAL DEFAULT 0,
            linked_calendar_event_id TEXT,
            archived_at INTEGER,
            completed_at INTEGER,
            smart_action TEXT,
            created_at INTEGER DEFAULT (strftime('%s','now'))
        )
    """)
    conn.execute("""
        CREATE TABLE habits (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            icon TEXT DEFAULT '✅',
            created_at INTEGER DEFAULT (strftime('%s','now'))
        )
    """)
    conn.execute("""
        CREATE TABLE habit_log (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            habit_id INTEGER,
            date TEXT NOT NULL,
            done INTEGER DEFAULT 0,
            UNIQUE(habit_id, date)
        )
    """)
    conn.execute("""
        CREATE TABLE subscriptions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            amount TEXT,
            currency TEXT DEFAULT 'INR',
            period TEXT DEFAULT 'monthly',
            next_renewal INTEGER
        )
    """)
    if rows:
        for r in rows:
            conn.execute(
                "INSERT INTO spend_log (category, amount_raw, occurred_at) VALUES (?,?,?)",
                r
            )
    conn.commit()
    conn.close()
    return f.name


def _make_priority_db(overdue_task=False, urgent_email=False, upcoming_sub=False,
                       upcoming_cal=False, spend_spike=False):
    """
    Create a temp SQLite for priority.py tests.
    NOTE: priority.py queries 'sender' on email_cache and 'amount'/'date' on spend_log.
    Those mismatches will surface here.
    """
    f = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
    f.close()
    conn = sqlite3.connect(f.name)
    conn.row_factory = sqlite3.Row
    now = int(time.time())

    # reminders — matches schema
    conn.execute("""
        CREATE TABLE reminders (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            title TEXT NOT NULL,
            due_at INTEGER NOT NULL,
            completed INTEGER DEFAULT 0,
            archived_at INTEGER,
            category TEXT DEFAULT 'task',
            priority_score REAL DEFAULT 0
        )
    """)
    # email_cache — matches schema.sql (from_name, from_email) NOT the 'sender' priority.py expects
    conn.execute("""
        CREATE TABLE email_cache (
            id TEXT PRIMARY KEY,
            subject TEXT,
            from_name TEXT,
            from_email TEXT,
            is_read INTEGER DEFAULT 0,
            category TEXT,
            cached_at INTEGER
        )
    """)
    conn.execute("""
        CREATE TABLE subscriptions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            amount TEXT,
            period TEXT DEFAULT 'monthly',
            next_renewal INTEGER
        )
    """)
    conn.execute("""
        CREATE TABLE calendar_events (
            id TEXT PRIMARY KEY,
            title TEXT,
            start_at INTEGER,
            end_at INTEGER,
            location TEXT
        )
    """)
    # spend_log — matches schemas.sql (amount_raw, occurred_at) NOT what priority.py expects (amount, date)
    conn.execute("""
        CREATE TABLE spend_log (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            category TEXT NOT NULL DEFAULT 'other',
            amount_raw REAL NOT NULL DEFAULT 0,
            description TEXT,
            source TEXT DEFAULT 'manual',
            occurred_at INTEGER NOT NULL
        )
    """)
    conn.execute("""
        CREATE TABLE action_feedback (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            action_type TEXT NOT NULL,
            confirmed INTEGER NOT NULL DEFAULT 0,
            created_at INTEGER DEFAULT (strftime('%s','now'))
        )
    """)

    if overdue_task:
        conn.execute(
            "INSERT INTO reminders (title, due_at, completed) VALUES ('Pay electricity bill', ?, 0)",
            (now - 2 * 86400,)  # 2 days ago (overdue)
        )
    if urgent_email:
        # INSERT with from_name/from_email (correct schema) — but priority.py expects 'sender' column
        conn.execute(
            "INSERT INTO email_cache (id, subject, from_name, from_email, is_read, category, cached_at) "
            "VALUES ('e1', 'Invoice Due', 'HDFC Bank', 'hdfc@bank.com', 0, 'urgent', ?)",
            (now - 1000,)
        )
    if upcoming_sub:
        conn.execute(
            "INSERT INTO subscriptions (name, amount, period, next_renewal) VALUES (?, ?, ?, ?)",
            ("Netflix", "₹649", "monthly", now + 1 * 86400)  # renews tomorrow
        )
    if upcoming_cal:
        conn.execute(
            "INSERT INTO calendar_events (id, title, start_at, end_at, location) VALUES (?, ?, ?, ?, ?)",
            ("cal1", "Team Meeting", now + 45 * 60, now + 105 * 60, "Zoom")  # 45 min from now
        )
    if spend_spike:
        # Uses amount_raw + occurred_at (schema.sql format) — priority.py queries 'amount' + 'date'
        conn.execute(
            "INSERT INTO spend_log (category, amount_raw, occurred_at) VALUES (?,?,?)",
            ("food", 5000, now - 1000)
        )

    conn.commit()
    conn.close()
    return f.name


# ══════════════════════════════════════════════════════════════════════════════
# SECTION 1 — intents.py
# ══════════════════════════════════════════════════════════════════════════════

class TestIntentResolveCategory:
    """_resolve_category: canonical + synonyms"""

    def test_canonical_passes_through(self):
        from intents import _resolve_category
        assert _resolve_category("food") == "food"
        assert _resolve_category("travel") == "travel"
        assert _resolve_category("health") == "health"
        assert _resolve_category("groceries") == "groceries"

    def test_synonym_dining_resolves_to_food(self):
        from intents import _resolve_category
        assert _resolve_category("dining") == "food"

    def test_synonym_commute_resolves_to_travel(self):
        from intents import _resolve_category
        assert _resolve_category("commute") == "travel"

    def test_synonym_streaming_resolves_to_entertainment(self):
        from intents import _resolve_category
        assert _resolve_category("streaming") == "entertainment"

    def test_synonym_mutual_fund_resolves_to_investments(self):
        from intents import CATEGORY_SYNONYMS
        assert CATEGORY_SYNONYMS.get("mutual fund") == "investments"

    def test_unknown_returns_none(self):
        from intents import _resolve_category
        assert _resolve_category("unknownxyz") is None

    def test_case_insensitive(self):
        from intents import _resolve_category
        # _resolve_category does w = word.lower().strip() internally
        assert _resolve_category("FOOD") == "food"
        assert _resolve_category("Travel") == "travel"

    def test_case_insensitive_actual(self):
        from intents import _resolve_category
        # The real implementation does w = word.lower().strip()
        assert _resolve_category("Dining") == "food"
        assert _resolve_category("COMMUTE") == "travel"


class TestMatchIntent:
    """match_intent: intent routing"""

    def test_remind_intent(self):
        from intents import match_intent
        r = match_intent("remind me to call mom tomorrow")
        assert r["intent"] == "add-reminder"
        assert "call mom" in r["params"]["title"]

    def test_complete_reminder(self):
        from intents import match_intent
        r = match_intent("done with buying groceries")
        assert r["intent"] == "complete-reminder"

    def test_email_reply(self):
        from intents import match_intent
        r = match_intent("reply to Priya")
        assert r["intent"] == "ai-draft-reply"
        assert r["params"]["recipient"] == "priya"

    def test_check_inbox(self):
        from intents import match_intent
        r = match_intent("check my inbox")
        assert r["intent"] == "refresh-emails"

    def test_spend_category_synonym(self):
        from intents import match_intent
        r = match_intent("how much did I spend on dining last month")
        assert r["intent"] == "nl-query"
        assert r["params"].get("category") == "food"  # synonym resolved

    def test_spend_context_without_category(self):
        from intents import match_intent
        r = match_intent("what is my total spend")
        assert r["intent"] == "nl-query"

    def test_calendar_today(self):
        from intents import match_intent
        r = match_intent("what's on my calendar today")
        assert r["intent"] == "get-calendar-events"

    def test_merchant_detected(self):
        from intents import match_intent
        r = match_intent("swiggy orders this month")
        assert r["intent"] == "nl-query"
        assert r["params"].get("merchant") == "swiggy"

    def test_block_sender(self):
        from intents import match_intent
        r = match_intent("block sender spam@test.com")
        assert r["intent"] == "block-sender"

    def test_balance_check(self):
        from intents import match_intent
        r = match_intent("how much balance do I have")
        assert r["intent"] == "get-spendable-balance"

    def test_search_emails_about(self):
        from intents import match_intent
        r = match_intent("any emails about the new project")
        assert r["intent"] == "search"
        assert r["params"]["type"] == "email"

    def test_habit_streak(self):
        from intents import match_intent
        r = match_intent("how is my habit streak")
        assert r["intent"] == "nl-query"

    def test_fallback_chat(self):
        from intents import match_intent
        r = match_intent("hello there")
        assert r["intent"] == "chat"

    def test_empty_string_fallback(self):
        from intents import match_intent
        r = match_intent("")
        assert r["intent"] == "chat"

    def test_subscription_cancel(self):
        from intents import match_intent
        r = match_intent("cancel my netflix subscription")
        assert r["intent"] == "delete-subscription"


# ══════════════════════════════════════════════════════════════════════════════
# SECTION 2 — priority.py
# ══════════════════════════════════════════════════════════════════════════════

class TestComputePriorities:
    """compute_priorities: edge cases and schema issues"""

    def test_empty_db_path_returns_error(self):
        from priority import compute_priorities
        result = compute_priorities("")
        assert result["silence"] is True
        assert "error" in result

    def test_nonexistent_db_returns_error(self):
        from priority import compute_priorities
        result = compute_priorities("/nonexistent/path/aria.db")
        assert "error" in result

    def test_empty_tables_returns_silence(self):
        """Fresh DB with all tables but no data → silence=True, priorities=[]"""
        db_path = _make_priority_db()
        try:
            from priority import compute_priorities
            result = compute_priorities(db_path)
            assert result["priorities"] == []
            assert result["silence"] is True
        finally:
            os.unlink(db_path)

    def test_overdue_task_creates_priority(self):
        """An overdue task → priority score >= 85, domain=task"""
        db_path = _make_priority_db(overdue_task=True)
        try:
            from priority import compute_priorities
            result = compute_priorities(db_path)
            task_prios = [p for p in result["priorities"] if p["domain"] == "task"]
            assert len(task_prios) > 0, "Expected at least one task priority"
            assert task_prios[0]["score"] >= 80
        finally:
            os.unlink(db_path)

    def test_urgent_email_BUG_sender_column_missing(self):
        """
        FIXED: priority.py now uses COALESCE(from_name, from_email) instead of 'sender'.
        This test verifies that the fix works correctly.
        """
        db_path = _make_priority_db(urgent_email=True)
        try:
            from priority import compute_priorities
            result = compute_priorities(db_path)
            # After fix: should NOT error
            assert "error" not in result, (
                f"priority.py still fails on email_cache: {result.get('error')}"
            )
            email_prios = [p for p in result["priorities"] if p["domain"] == "email"]
            assert len(email_prios) > 0, "Expected email priority for urgent email after sender fix"
        finally:
            os.unlink(db_path)

    def test_upcoming_subscription_priority(self):
        """Subscription renewing in <3 days → finance priority"""
        db_path = _make_priority_db(upcoming_sub=True)
        try:
            from priority import compute_priorities
            result = compute_priorities(db_path)
            fin_prios = [p for p in result["priorities"] if p["domain"] == "finance"]
            assert len(fin_prios) > 0, "Expected subscription renewal priority"
        finally:
            os.unlink(db_path)

    def test_upcoming_calendar_event_priority(self):
        """Calendar event within 2 hours → calendar priority"""
        db_path = _make_priority_db(upcoming_cal=True)
        try:
            from priority import compute_priorities
            result = compute_priorities(db_path)
            cal_prios = [p for p in result["priorities"] if p["domain"] == "calendar"]
            assert len(cal_prios) > 0, "Expected calendar event priority"
        finally:
            os.unlink(db_path)

    def test_spend_spike_BUG_wrong_columns(self):
        """
        FIXED: priority.py now uses amount_raw + occurred_at (matching schema.sql).
        This test verifies the spend-spike priority fires correctly after the fix.
        """
        now = int(time.time())
        # Insert big spend this month vs. modest spend last month
        db_path = _make_priority_db()
        conn = sqlite3.connect(db_path)
        import datetime
        today = datetime.date.today()
        this_m = datetime.date(today.year, today.month, 1)
        last_m = (datetime.date(today.year, today.month - 1, 1) if today.month > 1
                  else datetime.date(today.year - 1, 12, 1))
        this_m_ts = int(datetime.datetime(this_m.year, this_m.month, 1, 12).timestamp())
        last_m_ts = int(datetime.datetime(last_m.year, last_m.month, 1, 12).timestamp())
        # Insert: last_month = 5000, this_month = 10000 (>30% spike)
        conn.execute("INSERT INTO spend_log (category, amount_raw, occurred_at) VALUES (?,?,?)",
                     ("other", 5000, last_m_ts))
        conn.execute("INSERT INTO spend_log (category, amount_raw, occurred_at) VALUES (?,?,?)",
                     ("other", 10000, this_m_ts))
        conn.commit()
        conn.close()
        try:
            from priority import compute_priorities
            result = compute_priorities(db_path)
            assert "error" not in result, f"compute_priorities error: {result.get('error')}"
            fin_prios = [p for p in result.get("priorities", []) if p.get("id") == "spend-spike"]
            assert len(fin_prios) > 0, (
                "spend-spike priority not generated — check amount_raw/occurred_at column usage in priority.py"
            )
        finally:
            os.unlink(db_path)

    def test_stats_returns_correct_keys(self):
        """compute_priorities always returns tasks/emails/monthSpend keys"""
        db_path = _make_priority_db()
        try:
            from priority import compute_priorities
            result = compute_priorities(db_path)
            assert "tasks" in result["stats"]
            assert "emails" in result["stats"]
            assert "monthSpend" in result["stats"]
        finally:
            os.unlink(db_path)

    def test_output_shape(self):
        """Result always has priorities, silence, stats, generatedAt"""
        db_path = _make_priority_db(overdue_task=True)
        try:
            from priority import compute_priorities
            result = compute_priorities(db_path)
            for key in ("priorities", "silence", "stats", "generatedAt"):
                assert key in result, f"Missing key: {key}"
        finally:
            os.unlink(db_path)


# ══════════════════════════════════════════════════════════════════════════════
# SECTION 3 — agent.py: interpreter guardrails
# ══════════════════════════════════════════════════════════════════════════════

class TestValidateInterpreterOutput:
    """_validate_interpreter_output: schema validation + sanitisation"""

    def _fn(self):
        from agent import _validate_interpreter_output
        return _validate_interpreter_output

    def test_valid_full_object(self):
        fn = self._fn()
        result = fn({
            "intent": "spend_total", "confidence": 0.9,
            "domain": "finance", "action": "query",
            "filters": {"period": "month"}, "needs_narrative": False,
        })
        assert result is not None
        assert result["intent"] == "spend_total"
        assert result["confidence"] == 0.9

    def test_missing_intent_key_returns_none(self):
        fn = self._fn()
        assert fn({"confidence": 0.8}) is None

    def test_missing_confidence_key_returns_none(self):
        fn = self._fn()
        assert fn({"intent": "spend_total"}) is None

    def test_non_whitelisted_intent_becomes_unknown(self):
        fn = self._fn()
        result = fn({"intent": "inject_sql", "confidence": 0.9})
        assert result is not None
        assert result["intent"] == "unknown"

    def test_confidence_clamped_above_1(self):
        fn = self._fn()
        result = fn({"intent": "spend_total", "confidence": 5.0})
        assert result["confidence"] == 1.0

    def test_confidence_clamped_below_0(self):
        fn = self._fn()
        result = fn({"intent": "spend_total", "confidence": -2.0})
        assert result["confidence"] == 0.0

    def test_non_numeric_confidence_defaults_to_0(self):
        fn = self._fn()
        result = fn({"intent": "spend_total", "confidence": "high"})
        assert result["confidence"] == 0.0

    def test_defaults_applied_for_optional_fields(self):
        fn = self._fn()
        result = fn({"intent": "inbox_count", "confidence": 0.7})
        assert result["domain"] == "unknown"
        assert result["action"] == "unknown"
        assert result["filters"] == {}
        assert result["needs_narrative"] is True

    def test_needs_narrative_normalised_to_bool(self):
        fn = self._fn()
        result = fn({"intent": "spend_total", "confidence": 0.8, "needs_narrative": 1})
        assert result["needs_narrative"] is True

    def test_non_dict_input_returns_none(self):
        fn = self._fn()
        assert fn("string") is None
        assert fn(None) is None
        assert fn([1, 2]) is None

    def test_all_valid_intents_pass_whitelist(self):
        fn = self._fn()
        valid = [
            "spend_total", "spend_compare", "spend_trend", "inbox_count",
            "urgent_emails", "events_upcoming", "free_slots", "overdue_tasks",
            "streak_status", "category_breakdown", "multi", "unknown"
        ]
        for intent in valid:
            r = fn({"intent": intent, "confidence": 0.5})
            assert r["intent"] == intent, f"Intent {intent} should pass whitelist"


class TestIsFollowupMessage:
    """_is_followup_message: follow-up detection logic"""

    def _fn(self):
        from agent import _is_followup_message
        return _is_followup_message

    def test_pronoun_word(self):
        fn = self._fn()
        assert fn("that") is True
        assert fn("it") is True

    def test_two_word_message_with_pronoun(self):
        fn = self._fn()
        assert fn("show more") is True

    def test_two_word_message_no_pronoun(self):
        fn = self._fn()
        # 2 words, no pronoun → still True because len(words) <= 2
        assert fn("last week") is True

    def test_one_word_is_followup(self):
        fn = self._fn()
        assert fn("yesterday?") is True

    def test_longer_message_with_pronoun_in_middle(self):
        fn = self._fn()
        # "show more details" → 3 words; _is_followup_message only checks pronouns
        # for messages with <= 2 words. 3-word messages return False even with pronouns.
        result = fn("show more details")
        assert result is False

    def test_long_specific_question_not_followup(self):
        fn = self._fn()
        result = fn("what did I spend on food in March 2025")
        assert result is False

    def test_empty_string(self):
        fn = self._fn()
        # Empty string → words=[], len<=2 → True
        result = fn("")
        assert result is True


# ══════════════════════════════════════════════════════════════════════════════
# SECTION 4 — agent.py: period SQL helper
# ══════════════════════════════════════════════════════════════════════════════

class TestPeriodWhereSpend:
    """_period_where_spend: correct SQL fragments for each period"""

    def _fn(self):
        from agent import _period_where_spend
        return _period_where_spend

    def test_today(self):
        fn = self._fn()
        sql = fn("today")
        assert "date('now')" in sql
        assert ">=" in sql

    def test_week(self):
        fn = self._fn()
        sql = fn("week")
        assert "-7 days" in sql

    def test_month_default(self):
        fn = self._fn()
        sql = fn("month")
        assert "start of month" in sql

    def test_last_month(self):
        fn = self._fn()
        sql = fn("last_month")
        assert "-1 month" in sql
        assert "occurred_at <" in sql

    def test_year(self):
        fn = self._fn()
        sql = fn("year")
        assert "start of year" in sql

    def test_unknown_defaults_to_month(self):
        fn = self._fn()
        sql = fn("foobar")
        assert "start of month" in sql

    def test_sql_is_valid_sqlite(self):
        """Each generated WHERE clause must be executable in SQLite"""
        from agent import _period_where_spend
        conn = sqlite3.connect(":memory:")
        conn.execute("CREATE TABLE spend_log (amount_raw REAL, occurred_at INTEGER)")
        for period in ("today", "week", "month", "last_month", "year"):
            where = _period_where_spend(period)
            try:
                conn.execute(f"SELECT SUM(amount_raw) FROM spend_log WHERE {where}")
            except sqlite3.OperationalError as e:
                raise AssertionError(f"Period '{period}' generated invalid SQL: {e}\nSQL: {where}")
        conn.close()


# ══════════════════════════════════════════════════════════════════════════════
# SECTION 5 — agent.py: spend outlier detection
# ══════════════════════════════════════════════════════════════════════════════

class TestCheckSpendOutlier:

    def _fn(self):
        from agent import _check_spend_outlier
        return _check_spend_outlier

    def test_absolute_outlier_above_1M(self):
        fn = self._fn()
        result = fn(1_100_000, "month", None)
        assert result is not None
        assert "unusually high" in result

    def test_no_warning_for_normal_amount(self):
        fn = self._fn()
        result = fn(50_000, "month", None)
        assert result is None

    def test_zero_amount_no_warning(self):
        fn = self._fn()
        assert fn(0, "month", None) is None

    def test_relative_outlier_with_db(self):
        """Value > 5x 3-month avg triggers relative outlier warning"""
        conn = sqlite3.connect(":memory:")
        conn.row_factory = sqlite3.Row  # required: _check_spend_outlier uses dict(avg_row)... actually now uses avg_row[0]
        conn.execute("CREATE TABLE spend_log (amount_raw REAL, occurred_at INTEGER)")
        import datetime
        # 90 days of ~333/day = ~10,000/month average
        for i in range(1, 91):
            ts = _ts(i)
            conn.execute("INSERT INTO spend_log VALUES (333.33, ?)", (ts,))
        conn.commit()
        from agent import _check_spend_outlier
        # 60,000 > 5 × 10,000 average → should warn
        result = _check_spend_outlier(60_000, "month", conn)
        assert result is not None, f"Expected outlier warning but got None (avg might be 0)"
        assert "higher than your 3-month average" in result
        conn.close()

    def test_relative_no_warning_when_normal(self):
        """Value within 5x avg → no warning"""
        conn = sqlite3.connect(":memory:")
        conn.execute("CREATE TABLE spend_log (amount_raw REAL, occurred_at INTEGER)")
        import datetime
        for i in range(1, 91):
            ts = _ts(i)
            conn.execute("INSERT INTO spend_log VALUES (500, ?)", (ts,))
        conn.commit()
        from agent import _check_spend_outlier
        # 15,000/mo avg; 30,000 = 2x → no warning
        result = _check_spend_outlier(30_000, "month", conn)
        assert result is None
        conn.close()

    def test_period_today_skips_relative_check(self):
        """Period 'year' is not in (today/week/month) so relative check skipped"""
        from agent import _check_spend_outlier
        conn = sqlite3.connect(":memory:")
        conn.execute("CREATE TABLE spend_log (amount_raw REAL, occurred_at INTEGER)")
        result = _check_spend_outlier(50_000, "year", conn)
        assert result is None  # year not in relative-check period list
        conn.close()


# ══════════════════════════════════════════════════════════════════════════════
# SECTION 6 — agent.py: compose response
# ══════════════════════════════════════════════════════════════════════════════

class TestComposeResponse:

    def _fn(self):
        from agent import _compose_response
        return _compose_response

    def test_spend_total_normal(self):
        fn = self._fn()
        r = fn({"intent": "spend_total", "total": 25000, "cnt": 12, "period": "month"})
        assert "₹25,000" in r
        assert "12 transactions" in r
        assert "FOLLOW_UP" in r

    def test_spend_total_zero(self):
        fn = self._fn()
        r = fn({"intent": "spend_total", "total": 0, "cnt": 0, "period": "month"})
        assert "No spend recorded" in r

    def test_spend_total_with_outlier_warning(self):
        fn = self._fn()
        r = fn({
            "intent": "spend_total", "total": 1_200_000, "cnt": 5,
            "period": "month", "outlier_warning": "⚠ Looks high"
        })
        assert "⚠ Looks high" in r

    def test_spend_total_with_category(self):
        fn = self._fn()
        r = fn({"intent": "spend_total", "total": 5000, "cnt": 3, "period": "month", "category": "food"})
        assert "on food" in r

    def test_spend_compare_more_than_last(self):
        fn = self._fn()
        r = fn({
            "intent": "spend_compare",
            "this_month": 30000, "last_month": 20000,
            "diff": 10000, "pct_change": 50.0
        })
        assert "↑" in r
        assert "50.0%" in r
        assert "FOLLOW_UP" in r

    def test_spend_compare_less_than_last(self):
        fn = self._fn()
        r = fn({
            "intent": "spend_compare",
            "this_month": 15000, "last_month": 20000,
            "diff": -5000, "pct_change": -25.0
        })
        assert "↓" in r

    def test_spend_compare_both_zero(self):
        fn = self._fn()
        r = fn({"intent": "spend_compare", "this_month": 0, "last_month": 0, "diff": 0})
        assert "No spend data" in r

    def test_spend_trend_empty(self):
        fn = self._fn()
        r = fn({"intent": "spend_trend", "months": []})
        assert "No spending data" in r

    def test_spend_trend_with_data(self):
        fn = self._fn()
        r = fn({"intent": "spend_trend", "months": [
            {"month": "2025-11", "total": 12000},
            {"month": "2025-12", "total": 18000},
        ]})
        assert "2025-11" in r
        assert "₹12,000" in r

    def test_inbox_count_empty_cache(self):
        fn = self._fn()
        r = fn({"intent": "inbox_count", "total": 0, "unread": 0})
        assert "empty" in r.lower() or "cache" in r.lower()

    def test_inbox_count_with_data(self):
        fn = self._fn()
        r = fn({"intent": "inbox_count", "total": 50, "unread": 8})
        assert "8 unread" in r
        assert "50" in r

    def test_urgent_emails_empty(self):
        fn = self._fn()
        r = fn({"intent": "urgent_emails", "emails": [], "count": 0})
        assert "No unread" in r

    def test_urgent_emails_with_data(self):
        fn = self._fn()
        r = fn({"intent": "urgent_emails", "emails": [
            {"from_name": "HDFC", "subject": "Payment Due", "from_email": "noreply@hdfc.com"},
        ], "count": 1})
        assert "HDFC" in r
        assert "Payment Due" in r

    def test_events_upcoming_none(self):
        fn = self._fn()
        r = fn({"intent": "events_upcoming", "events": [], "days": 7})
        assert "Nothing on calendar" in r

    def test_events_upcoming_with_data(self):
        fn = self._fn()
        r = fn({"intent": "events_upcoming", "events": [
            {"start": "2026-03-01T10:00:00", "title": "Sprint Review", "location": "Zoom"},
        ], "days": 7})
        assert "Sprint Review" in r

    def test_overdue_tasks_empty(self):
        fn = self._fn()
        r = fn({"intent": "overdue_tasks", "overdue": [], "count": 0})
        assert "clear" in r.lower() or "No overdue" in r

    def test_overdue_tasks_with_data(self):
        fn = self._fn()
        r = fn({"intent": "overdue_tasks", "overdue": [
            {"title": "File taxes", "category": "finance", "due": "2026-01-15"},
        ], "count": 1})
        assert "File taxes" in r
        assert "RISK" in r

    def test_streak_status_no_habits(self):
        fn = self._fn()
        r = fn({"intent": "streak_status", "habits": [], "date": "2026-02-26"})
        assert "No habits" in r

    def test_streak_status_with_done(self):
        fn = self._fn()
        r = fn({"intent": "streak_status", "habits": [
            {"name": "Workout", "done": 1},
            {"name": "Reading", "done": 0},
        ], "date": "2026-02-26"})
        assert "Workout" in r
        assert "Reading" in r
        assert "✓ Done" in r
        assert "✗ Pending" in r

    def test_category_breakdown_empty(self):
        fn = self._fn()
        r = fn({"intent": "category_breakdown", "categories": [], "period": "month"})
        assert "No spend data" in r

    def test_category_breakdown_with_data(self):
        fn = self._fn()
        r = fn({"intent": "category_breakdown", "categories": [
            {"category": "food", "total": 8000.0, "cnt": 15},
            {"category": "travel", "total": 3000.0, "cnt": 5},
        ], "period": "month"})
        assert "food" in r
        assert "₹8,000" in r
        assert "travel" in r

    def test_unknown_intent_returns_empty_string(self):
        fn = self._fn()
        r = fn({"intent": "totally_unknown"})
        assert r == ""

    def test_single_transaction_singular_form(self):
        fn = self._fn()
        r = fn({"intent": "spend_total", "total": 500, "cnt": 1, "period": "today"})
        assert "1 transaction" in r
        assert "transactions" not in r


# ══════════════════════════════════════════════════════════════════════════════
# SECTION 7 — agent.py: _emit_log
# ══════════════════════════════════════════════════════════════════════════════

class TestEmitLog:

    def _capture(self, event, **kwargs):
        from agent import _emit_log
        buf = io.StringIO()
        old = sys.stderr
        sys.stderr = buf
        try:
            _emit_log(event, **kwargs)
        finally:
            sys.stderr = old
        return buf.getvalue().strip()

    def test_basic_event_is_valid_json(self):
        raw = self._capture("test_event", tokens=50, intent="spend_total")
        obj = json.loads(raw)
        assert obj["_aria_log"] == "test_event"
        assert obj["tokens"] == 50
        assert obj["intent"] == "spend_total"
        assert "ts" in obj

    def test_confidence_only_present_when_nonzero(self):
        raw_zero = self._capture("ev", tokens=0, intent="", confidence=0.0)
        obj_zero = json.loads(raw_zero)
        assert "confidence" not in obj_zero

        raw_nonzero = self._capture("ev", tokens=0, intent="", confidence=0.85)
        obj_nonzero = json.loads(raw_nonzero)
        assert "confidence" in obj_nonzero
        assert obj_nonzero["confidence"] == 0.85

    def test_reason_only_present_when_nonempty(self):
        raw_empty = self._capture("ev", tokens=0, intent="", reason="")
        obj = json.loads(raw_empty)
        assert "reason" not in obj

        raw_reason = self._capture("ev", tokens=0, intent="", reason="low_confidence")
        obj = json.loads(raw_reason)
        assert obj["reason"] == "low_confidence"

    def test_ts_is_recent_unix_timestamp(self):
        raw = self._capture("ev")
        obj = json.loads(raw)
        ts = obj["ts"]
        now = int(time.time())
        assert abs(ts - now) < 5, f"Timestamp {ts} is not close to now {now}"


# ══════════════════════════════════════════════════════════════════════════════
# SECTION 8 — agent.py: _route_deterministic (with temp DB)
# ══════════════════════════════════════════════════════════════════════════════

class TestRouteDeterministic:
    """Full routing tests using temp SQLite files"""

    def test_spend_total_this_month(self):
        db = _make_spend_db(rows=[
            ("food", 500, _ts(0)),
            ("travel", 300, _ts(0)),
        ])
        try:
            from agent import _route_deterministic
            r = _route_deterministic(
                {"intent": "spend_total", "filters": {"period": "month"}, "confidence": 0.9},
                db
            )
            assert r is not None
            assert r["intent"] == "spend_total"
            assert float(r["total"]) == 800.0
            assert int(r["cnt"]) == 2
        finally:
            os.unlink(db)

    def test_spend_total_empty_db(self):
        db = _make_spend_db()
        try:
            from agent import _route_deterministic
            r = _route_deterministic(
                {"intent": "spend_total", "filters": {"period": "month"}, "confidence": 0.9},
                db
            )
            assert r is not None
            assert float(r["total"]) == 0.0
        finally:
            os.unlink(db)

    def test_spend_total_with_category_filter(self):
        db = _make_spend_db(rows=[
            ("food", 1000, _ts(0)),
            ("travel", 500, _ts(0)),
        ])
        try:
            from agent import _route_deterministic
            r = _route_deterministic(
                {"intent": "spend_total", "filters": {"period": "month", "category": "food"}, "confidence": 0.9},
                db
            )
            assert r is not None
            assert float(r["total"]) == 1000.0
        finally:
            os.unlink(db)

    def test_spend_compare(self):
        db = _make_spend_db(rows=[
            ("food", 5000, _month_start_ts(0)),   # this month
            ("food", 3000, _month_start_ts(1)),   # last month
        ])
        try:
            from agent import _route_deterministic
            r = _route_deterministic({"intent": "spend_compare", "filters": {}, "confidence": 0.9}, db)
            assert r is not None
            assert r["intent"] == "spend_compare"
            assert "this_month" in r
            assert "last_month" in r
        finally:
            os.unlink(db)

    def test_spend_trend(self):
        db = _make_spend_db(rows=[
            ("food", 1000, _ts(60)),
            ("food", 1500, _ts(30)),
            ("food", 2000, _ts(0)),
        ])
        try:
            from agent import _route_deterministic
            r = _route_deterministic({"intent": "spend_trend", "filters": {}, "confidence": 0.8}, db)
            assert r is not None
            assert len(r["months"]) >= 1
        finally:
            os.unlink(db)

    def test_inbox_count(self):
        db = _make_spend_db()
        conn = sqlite3.connect(db)
        conn.execute("INSERT INTO email_cache (id, subject, is_read) VALUES ('e1', 'Hello', 0)")
        conn.execute("INSERT INTO email_cache (id, subject, is_read) VALUES ('e2', 'World', 1)")
        conn.commit()
        conn.close()
        try:
            from agent import _route_deterministic
            r = _route_deterministic({"intent": "inbox_count", "filters": {}, "confidence": 0.9}, db)
            assert r is not None
            assert int(r["total"]) == 2
            assert int(r["unread"]) == 1
        finally:
            os.unlink(db)

    def test_urgent_emails(self):
        db = _make_spend_db()
        conn = sqlite3.connect(db)
        import time as _t
        conn.execute(
            "INSERT INTO email_cache (id, subject, from_name, from_email, is_read, received_at) "
            "VALUES ('e1', 'URGENT: Pay now', 'Bank', 'bank@x.com', 0, ?)",
            (int(_t.time()),)
        )
        conn.commit()
        conn.close()
        try:
            from agent import _route_deterministic
            r = _route_deterministic({"intent": "urgent_emails", "filters": {"limit": 5}, "confidence": 0.9}, db)
            assert r is not None
            assert len(r["emails"]) == 1
            assert r["emails"][0]["subject"] == "URGENT: Pay now"
        finally:
            os.unlink(db)

    def test_events_upcoming(self):
        db = _make_spend_db()
        conn = sqlite3.connect(db)
        now_ts = int(time.time())
        conn.execute(
            "INSERT INTO calendar_events (id, title, start_at, end_at, location) VALUES (?,?,?,?,?)",
            ("ev1", "Design Review", now_ts + 3600, now_ts + 7200, "Conference Room A")
        )
        conn.commit()
        conn.close()
        try:
            from agent import _route_deterministic
            r = _route_deterministic({"intent": "events_upcoming", "filters": {"days": 7}, "confidence": 0.9}, db)
            assert r is not None
            assert len(r["events"]) == 1
            assert r["events"][0]["title"] == "Design Review"
        finally:
            os.unlink(db)

    def test_overdue_tasks(self):
        db = _make_spend_db()
        conn = sqlite3.connect(db)
        now_ts = int(time.time())
        conn.execute(
            "INSERT INTO reminders (title, due_at, completed, category) VALUES (?,?,?,?)",
            ("Submit report", now_ts - 86400, 0, "work")
        )
        conn.commit()
        conn.close()
        try:
            from agent import _route_deterministic
            r = _route_deterministic({"intent": "overdue_tasks", "filters": {}, "confidence": 0.9}, db)
            assert r is not None
            assert r["count"] == 1
            assert r["overdue"][0]["title"] == "Submit report"
        finally:
            os.unlink(db)

    def test_streak_status(self):
        db = _make_spend_db()
        conn = sqlite3.connect(db)
        import datetime
        today_str = datetime.date.today().isoformat()
        conn.execute("INSERT INTO habits (name) VALUES (?)", ("Running",))
        conn.execute("INSERT INTO habits (name) VALUES (?)", ("Meditation",))
        conn.execute("INSERT INTO habit_log (habit_id, date, done) VALUES (1, ?, 1)", (today_str,))
        conn.commit()
        conn.close()
        try:
            from agent import _route_deterministic
            r = _route_deterministic({"intent": "streak_status", "filters": {}, "confidence": 0.9}, db)
            assert r is not None
            names = [h["name"] for h in r["habits"]]
            assert "Running" in names
            assert "Meditation" in names
            done = [h for h in r["habits"] if h["name"] == "Running"]
            assert done[0]["done"] == 1
        finally:
            os.unlink(db)

    def test_category_breakdown(self):
        db = _make_spend_db(rows=[
            ("food", 2000, _ts(0)),
            ("food", 1500, _ts(0)),
            ("travel", 800, _ts(0)),
        ])
        try:
            from agent import _route_deterministic
            r = _route_deterministic(
                {"intent": "category_breakdown", "filters": {"period": "month"}, "confidence": 0.9},
                db
            )
            assert r is not None
            cats = {c["category"]: float(c["total"]) for c in r["categories"]}
            assert cats.get("food") == 3500.0
            assert cats.get("travel") == 800.0
        finally:
            os.unlink(db)

    def test_outlier_warning_appended_for_high_spend(self):
        db = _make_spend_db(rows=[("other", 2_000_000, _ts(0))])
        try:
            from agent import _route_deterministic
            r = _route_deterministic(
                {"intent": "spend_total", "filters": {"period": "month"}, "confidence": 0.9},
                db
            )
            assert r is not None
            assert "outlier_warning" in r
        finally:
            os.unlink(db)

    def test_unknown_intent_returns_none(self):
        db = _make_spend_db()
        try:
            from agent import _route_deterministic
            r = _route_deterministic({"intent": "free_slots", "filters": {}, "confidence": 0.7}, db)
            # free_slots is in _VALID_INTENTS but has no SQL template → returns None
            assert r is None
        finally:
            os.unlink(db)


# ══════════════════════════════════════════════════════════════════════════════
# SECTION 9 — vectors.py
# ══════════════════════════════════════════════════════════════════════════════

class TestVectorStore:

    def test_instantiation_without_chromadb(self):
        """VectorStore can be imported and instantiated even without chromadb installed"""
        try:
            from vectors import VectorStore
            tmpdir = tempfile.mkdtemp()
            vs = VectorStore(db_dir=tmpdir)
            assert vs is not None
        except Exception as e:
            raise AssertionError(f"VectorStore instantiation failed: {e}")

    def test_count_without_chromadb_raises_gracefully(self):
        """count() should raise an ImportError (chromadb not installed) or return 0"""
        try:
            import chromadb  # noqa
            from vectors import VectorStore
            tmpdir = tempfile.mkdtemp()
            vs = VectorStore(db_dir=tmpdir)
            c = vs.count()
            assert isinstance(c, int)
            assert c == 0
        except ImportError:
            pass  # chromadb not installed — expected in bare environments

    def test_chunk_constants_are_sane(self):
        from vectors import VectorStore
        assert VectorStore.MAX_CHUNK_SIZE > 100
        assert VectorStore.CHUNK_OVERLAP >= 0
        assert VectorStore.CHUNK_OVERLAP < VectorStore.MAX_CHUNK_SIZE


# ══════════════════════════════════════════════════════════════════════════════
# SECTION 10 — engine.py: handle_request router
# ══════════════════════════════════════════════════════════════════════════════

class TestHandleRequest:

    def test_ping(self):
        from engine import handle_request
        r = handle_request({"type": "ping", "payload": {}})
        assert r["status"] == "ok"
        assert "version" in r

    def test_check_imports_returns_ok_or_missing(self):
        from engine import handle_request
        r = handle_request({"type": "check_imports", "payload": {}})
        assert "ok" in r
        assert "missing" in r
        assert isinstance(r["missing"], list)

    def test_intent_basic(self):
        from engine import handle_request
        r = handle_request({"type": "intent", "payload": {"text": "remind me to exercise"}})
        assert "intent" in r
        assert r["intent"] == "add-reminder"

    def test_intent_fallback_chat(self):
        from engine import handle_request
        r = handle_request({"type": "intent", "payload": {"text": "hello world"}})
        assert r["intent"] == "chat"

    def test_unknown_request_type_raises(self):
        from engine import handle_request
        try:
            handle_request({"type": "nonexistent_type", "payload": {}})
            raise AssertionError("Should have raised ValueError")
        except ValueError as e:
            assert "Unknown request type" in str(e)

    def test_empty_payload(self):
        from engine import handle_request
        r = handle_request({"type": "ping"})
        assert r["status"] == "ok"


# ══════════════════════════════════════════════════════════════════════════════
# SECTION 11 — agent.py: _VALID_INTENTS and _FOLLOWUP_PRONOUNS constants
# ══════════════════════════════════════════════════════════════════════════════

class TestConstants:

    def test_valid_intents_is_frozenset(self):
        from agent import _VALID_INTENTS
        assert isinstance(_VALID_INTENTS, frozenset)
        assert len(_VALID_INTENTS) == 12

    def test_followup_pronouns_is_frozenset(self):
        from agent import _FOLLOWUP_PRONOUNS
        assert isinstance(_FOLLOWUP_PRONOUNS, frozenset)
        assert len(_FOLLOWUP_PRONOUNS) == 14  # it, that, those, them, there, this, same, more, else, also, similar, related, then, again

    def test_interpreter_fail_threshold_is_3(self):
        from agent import _INTERPRETER_FAIL_THRESHOLD
        assert _INTERPRETER_FAIL_THRESHOLD == 3

    def test_unknown_in_valid_intents(self):
        from agent import _VALID_INTENTS
        assert "unknown" in _VALID_INTENTS
        assert "multi" in _VALID_INTENTS


# ══════════════════════════════════════════════════════════════════════════════
# STANDALONE RUNNER (no pytest needed)
# ══════════════════════════════════════════════════════════════════════════════

if __name__ == "__main__":
    import traceback

    PASS = "\033[92m✓ PASS\033[0m"
    FAIL = "\033[91m✗ FAIL\033[0m"
    SKIP = "\033[93m~ SKIP\033[0m"

    results = []

    def run_test(cls_name, method_name, fn):
        try:
            fn()
            results.append((cls_name, method_name, "PASS", None))
            print(f"  {PASS}  {cls_name}.{method_name}")
        except AssertionError as e:
            msg = str(e)
            results.append((cls_name, method_name, "FAIL", msg))
            print(f"  {FAIL}  {cls_name}.{method_name}")
            print(f"         {msg}")
        except Exception as e:
            tb = traceback.format_exc().strip().splitlines()[-1]
            results.append((cls_name, method_name, "ERROR", f"{type(e).__name__}: {e}"))
            print(f"  {FAIL}  {cls_name}.{method_name} [EXCEPTION]")
            print(f"         {type(e).__name__}: {e}")

    test_classes = [
        TestIntentResolveCategory,
        TestMatchIntent,
        TestComputePriorities,
        TestValidateInterpreterOutput,
        TestIsFollowupMessage,
        TestPeriodWhereSpend,
        TestCheckSpendOutlier,
        TestComposeResponse,
        TestEmitLog,
        TestRouteDeterministic,
        TestVectorStore,
        TestHandleRequest,
        TestConstants,
    ]

    total = passed = failed = errored = 0

    for cls in test_classes:
        print(f"\n{'─'*60}")
        print(f"  {cls.__name__}")
        print(f"{'─'*60}")
        instance = cls()
        for name in dir(instance):
            if name.startswith("test_"):
                total += 1
                run_test(cls.__name__, name, getattr(instance, name))

    passed = sum(1 for r in results if r[2] == "PASS")
    failed_list = [r for r in results if r[2] in ("FAIL", "ERROR")]

    print(f"\n{'═'*60}")
    print(f"  TOTAL: {total}  |  PASSED: {passed}  |  FAILED: {len(failed_list)}")
    print(f"{'═'*60}")

    if failed_list:
        print("\n  FAILURES SUMMARY:")
        for cls_name, meth, status, msg in failed_list:
            print(f"\n  [{status}] {cls_name}.{meth}")
            if msg:
                for line in (msg or "").splitlines():
                    print(f"    {line}")
    else:
        print("\n  All tests passed.")

    sys.exit(0 if not failed_list else 1)
