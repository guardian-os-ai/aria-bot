"""
python-engine/priority.py — Deterministic Priority Engine (P2-3)

Reads user's current state from SQLite and produces a ranked Priority list.
No LLM required. Deterministic scoring only.

Priority shape:
  { id, domain, title, description, score, action_type, action_params, silence }

Phase H: Learning from action_feedback — scores adjusted based on user's
  historic confirmation rate per domain. If user rarely acts on email priorities
  (< 30% confirm), de-weight email scores. If they always act (> 80%), boost.
"""

import sqlite3
import time
from typing import List, Dict, Any


DAY = 86400

# Domain mapping from action_feedback.action_type → priority domain
_ACTION_TO_DOMAIN = {
    'reminder': 'task',
    'email': 'email',
    'send-reply': 'email',
    'snooze-email': 'email',
    'block-sender': 'email',
    'auto-archive-email': 'email',
    'follow-up-email': 'email',
    'subscription': 'finance',
    'finance': 'finance',
    'record-spend': 'finance',
    'habit': 'habit',
    'calendar': 'calendar',
    'task': 'task',
}


def _open(db_path: str) -> sqlite3.Connection:
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    return conn


def _get_learning_multipliers(conn: sqlite3.Connection) -> Dict[str, float]:
    """
    Phase H: Compute per-domain score multipliers from action_feedback.
    
    confirmation_rate < 0.30 → multiply by 0.82 (user ignores most, de-weight)
    0.30 <= rate <= 0.70 → multiply by 1.00 (neutral)
    rate > 0.70 → multiply by 1.18 (user acts on these, boost them)
    
    Requires at least 5 feedback events per domain to avoid noise.
    """
    multipliers: Dict[str, float] = {}
    try:
        rows = conn.execute(
            """SELECT action_type,
                      COUNT(*) as total,
                      SUM(confirmed) as confirmed_count
               FROM action_feedback
               WHERE created_at >= strftime('%s','now','-90 days')
               GROUP BY action_type
               HAVING total >= 5"""
        ).fetchall()

        domain_stats: Dict[str, Dict] = {}
        for row in rows:
            domain = _ACTION_TO_DOMAIN.get(row["action_type"], row["action_type"])
            stats = domain_stats.setdefault(domain, {"total": 0, "confirmed": 0})
            stats["total"] += row["total"]
            stats["confirmed"] += (row["confirmed_count"] or 0)

        for domain, stats in domain_stats.items():
            rate = stats["confirmed"] / stats["total"] if stats["total"] > 0 else 0.5
            if rate > 0.70:
                multipliers[domain] = 1.18
            elif rate < 0.30:
                multipliers[domain] = 0.82
            else:
                multipliers[domain] = 1.0

    except Exception:
        pass  # action_feedback may not exist yet — no-op

    return multipliers


def compute_priorities(db_path: str) -> Dict[str, Any]:
    """Read SQLite and return ranked priorities + stats + silence flag."""
    if not db_path:
        return {"priorities": [], "silence": True, "stats": {}, "error": "No db_path"}

    conn = None
    try:
        conn = _open(db_path)
        priorities = _collect_priorities(conn)
        stats = _collect_stats(conn)

        # Phase H: apply learning multipliers from action_feedback
        multipliers = _get_learning_multipliers(conn)
        if multipliers:
            for p in priorities:
                domain = p.get("domain", "")
                m = multipliers.get(domain, 1.0)
                if m != 1.0:
                    p["score"] = min(99, round(p["score"] * m))
                    p["_learning_adjusted"] = True  # debug marker

        conn.close()
        conn = None
    except Exception as e:
        if conn is not None:
            try:
                conn.close()
            except Exception:
                pass
        return {"priorities": [], "silence": True, "stats": {}, "error": str(e)}

    priorities.sort(key=lambda p: p["score"], reverse=True)
    silence = len(priorities) == 0 or priorities[0]["score"] < 40

    return {
        "priorities": priorities[:8],
        "silence": silence,
        "stats": stats,
        "generatedAt": int(time.time() * 1000),
    }


def _collect_priorities(conn: sqlite3.Connection) -> List[Dict[str, Any]]:
    now = int(time.time())
    priorities = []

    # 1. Overdue tasks — base 80, +5/day overdue, cap 99
    rows = conn.execute(
        """SELECT id, title, due_at, category, priority_score
           FROM reminders
           WHERE completed = 0 AND archived_at IS NULL AND due_at < ?
           ORDER BY due_at ASC LIMIT 10""",
        (now,),
    ).fetchall()
    for r in rows:
        days_late = max(1, (now - r["due_at"]) // DAY)
        priorities.append({
            "id": f"task-{r['id']}",
            "domain": "task",
            "title": r["title"],
            "description": f"{days_late}d overdue",
            "score": min(99, 80 + days_late * 5),
            "action_type": "complete-reminder",
            "action_params": {"id": r["id"]},
        })

    # 2. Urgent unread emails — base 70, +10 if financial, +5 if urgent cat
    rows = conn.execute(
        """SELECT id, subject,
              COALESCE(from_name, from_email, 'unknown') as sender,
              category, cached_at
           FROM email_cache
           WHERE category IN ('urgent','action') AND is_read = 0
           ORDER BY cached_at DESC LIMIT 10""",
    ).fetchall()
    fin_pattern = ("payment", "invoice", "bill", "transaction", "subscription", "renewal")
    for r in rows:
        subj = (r["subject"] or "").lower()
        is_financial = any(p in subj for p in fin_pattern)
        score = 70 + (10 if is_financial else 0) + (5 if r["category"] == "urgent" else 0)
        priorities.append({
            "id": f"email-{r['id']}",
            "domain": "email",
            "title": r["subject"] or "(no subject)",
            "description": f"From {r['sender'] or 'unknown'}",
            "score": score,
            "action_type": "open-email",
            "action_params": {"id": r["id"]},
        })

    # 3. Subscriptions renewing within 3 days — base 75, +20 if overdue
    rows = conn.execute(
        """SELECT id, name, amount, period, next_renewal
           FROM subscriptions
           WHERE next_renewal IS NOT NULL AND next_renewal > 0 AND next_renewal <= ?
           ORDER BY next_renewal ASC LIMIT 5""",
        (now + 3 * DAY,),
    ).fetchall()
    for r in rows:
        is_overdue = r["next_renewal"] < now
        priorities.append({
            "id": f"sub-{r['id']}",
            "domain": "finance",
            "title": f"{r['name']} renewal",
            "description": f"{r['amount']}/{r['period']}" + (" — OVERDUE" if is_overdue else ""),
            "score": 75 + (20 if is_overdue else 0),
            "action_type": "view-subscription",
            "action_params": {"id": r["id"]},
        })

    # 4. Calendar events within 2 hours — base 85, +10 if < 30 min
    rows = conn.execute(
        """SELECT id, title, start_at, end_at, location
           FROM calendar_events
           WHERE start_at > ? AND start_at <= ?
           ORDER BY start_at ASC LIMIT 5""",
        (now, now + 2 * 3600),
    ).fetchall()
    for r in rows:
        mins_away = (r["start_at"] - now) // 60
        loc = f" · {r['location']}" if r["location"] else ""
        priorities.append({
            "id": f"cal-{r['id']}",
            "domain": "calendar",
            "title": r["title"],
            "description": f"In {mins_away}m{loc}",
            "score": 85 + (10 if mins_away < 30 else 0),
            "action_type": "view-event",
            "action_params": {"id": r["id"]},
        })

    # 5. Stale action emails > 48h old — base 60
    rows = conn.execute(
        """SELECT id, subject,
              COALESCE(from_name, from_email, 'unknown') as sender
           FROM email_cache
           WHERE category = 'action' AND is_read = 0 AND cached_at < ?
           LIMIT 5""",
        (now - 2 * DAY,),
    ).fetchall()
    for r in rows:
        priorities.append({
            "id": f"stale-{r['id']}",
            "domain": "email",
            "title": r["subject"] or "(no subject)",
            "description": f"Action needed — {r['sender'] or 'unknown'}",
            "score": 60,
            "action_type": "open-email",
            "action_params": {"id": r["id"]},
        })

    # 6. Spending spike > 30% vs last month — base 55
    try:
        import datetime
        today = datetime.date.today()
        this_month = today.replace(day=1).isoformat()
        prev = today.replace(day=1)
        last_month = (prev.replace(month=prev.month - 1) if prev.month > 1
                      else prev.replace(year=prev.year - 1, month=12)).isoformat()

        this_row = conn.execute(
            "SELECT COALESCE(SUM(amount_raw),0) as total FROM spend_log "
            "WHERE occurred_at >= strftime('%s', ?)",
            (this_month,),
        ).fetchone()
        last_row = conn.execute(
            "SELECT COALESCE(SUM(amount_raw),0) as total FROM spend_log "
            "WHERE occurred_at >= strftime('%s', ?) AND occurred_at < strftime('%s', ?)",
            (last_month, this_month),
        ).fetchone()

        this_total = this_row["total"] if this_row else 0
        last_total = last_row["total"] if last_row else 0

        if last_total > 0 and this_total > last_total * 1.3:
            pct = round(((this_total - last_total) / last_total) * 100)
            priorities.append({
                "id": "spend-spike",
                "domain": "finance",
                "title": "Spending spike detected",
                "description": f"Up {pct}% vs last month",
                "score": 55,
                "action_type": "view-spending",
                "action_params": {},
            })
    except Exception:
        pass

    return priorities


def _collect_stats(conn: sqlite3.Connection) -> Dict[str, Any]:
    now = int(time.time())
    try:
        import datetime
        today = datetime.date.today().replace(day=1).isoformat()

        task_count = conn.execute(
            "SELECT COUNT(*) as cnt FROM reminders WHERE completed = 0 AND archived_at IS NULL"
        ).fetchone()["cnt"]
        email_count = conn.execute(
            "SELECT COUNT(*) as cnt FROM email_cache WHERE is_read = 0"
        ).fetchone()["cnt"]
        spend_row = conn.execute(
            "SELECT COALESCE(SUM(amount_raw),0) as total FROM spend_log "
            "WHERE occurred_at >= strftime('%s', ?)", (today,)
        ).fetchone()
        month_spend = round(spend_row["total"]) if spend_row else 0

        return {"tasks": task_count, "emails": email_count, "monthSpend": month_spend}
    except Exception:
        return {"tasks": 0, "emails": 0, "monthSpend": 0}
