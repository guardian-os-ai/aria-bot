"""
python-engine/intents.py — Intent Pattern Matching (P4-1)

Deterministic regex/keyword matching for the 40+ most common user commands.
No LLM required. Returns { intent, params } or { intent: 'chat' } for unrecognized.

Features:
  - Category synonym resolution (dining → food, commute → travel)
  - Dynamic merchant detection
  - Spending context awareness
  - Multi-turn follow-up detection
"""

import re
from typing import Dict, Any, Optional


# ── Category synonym map (mirrors services/intelligence.js) ──────────────────

CATEGORY_SYNONYMS = {
    'dining': 'food', 'restaurant': 'food', 'restaurants': 'food', 'cafe': 'food',
    'takeout': 'food', 'delivery': 'food', 'eating': 'food', 'eat': 'food',
    'lunch': 'food', 'dinner': 'food', 'breakfast': 'food', 'snacks': 'food',
    'meals': 'food', 'meal': 'food',
    'commute': 'travel', 'transport': 'travel', 'transportation': 'travel',
    'ride': 'travel', 'rides': 'travel', 'cab': 'travel', 'cabs': 'travel',
    'taxi': 'travel', 'flight': 'travel', 'flights': 'travel', 'hotel': 'travel',
    'hotels': 'travel', 'trip': 'travel', 'trips': 'travel',
    'bus': 'travel', 'train': 'travel', 'metro': 'travel', 'auto': 'travel',
    'streaming': 'entertainment', 'movies': 'entertainment', 'movie': 'entertainment',
    'gaming': 'entertainment', 'games': 'entertainment', 'music': 'entertainment',
    'shows': 'entertainment', 'ott': 'entertainment', 'cinema': 'entertainment',
    'medicine': 'health', 'medicines': 'health', 'hospital': 'health',
    'doctor': 'health', 'pharmacy': 'health', 'medical': 'health',
    'gym': 'health', 'fitness': 'health', 'wellness': 'health',
    'dental': 'health', 'clinic': 'health',
    'electricity': 'utilities', 'electric': 'utilities', 'internet': 'utilities',
    'phone': 'utilities', 'wifi': 'utilities', 'broadband': 'utilities',
    'bill': 'utilities', 'bills': 'utilities',
    'clothes': 'shopping', 'clothing': 'shopping', 'shoes': 'shopping',
    'fashion': 'shopping', 'electronics': 'shopping', 'gadgets': 'shopping',
    'mutual fund': 'investments', 'mutual funds': 'investments',
    'stocks': 'investments', 'sip': 'investments', 'trading': 'investments',
    'crypto': 'investments',
    'loan': 'emi', 'loans': 'emi', 'mortgage': 'emi', 'installment': 'emi',
    'tuition': 'education', 'course': 'education', 'courses': 'education',
    'school': 'education', 'college': 'education', 'learning': 'education',
    'petrol': 'fuel', 'diesel': 'fuel', 'cng': 'fuel',
    'grocery': 'groceries', 'supermarket': 'groceries', 'vegetables': 'groceries',
    'fruits': 'groceries', 'provisions': 'groceries', 'essentials': 'groceries',
    'premium': 'insurance', 'premiums': 'insurance', 'policy': 'insurance',
    'mobile': 'recharge', 'prepaid': 'recharge', 'postpaid': 'recharge',
    'recurring': 'subscriptions', 'membership': 'subscriptions',
}

CANONICAL_CATEGORIES = [
    'food', 'shopping', 'travel', 'entertainment', 'utilities', 'health',
    'groceries', 'subscriptions', 'investments', 'insurance', 'banking',
    'education', 'rent', 'emi', 'recharge', 'fuel', 'other'
]

def _resolve_category(word: str) -> Optional[str]:
    """Resolve a word to a canonical category name."""
    w = word.lower().strip()
    if w in CANONICAL_CATEGORIES:
        return w
    return CATEGORY_SYNONYMS.get(w)


# ── Time expression helpers ──────────────────────────────────────────────────

_REL_TIME = re.compile(
    r"""
    (?:
        (?P<num>\d+)\s*
        (?P<unit>min(?:ute)?s?|h(?:our)?s?|day?s?|week?s?)
        |tomorrow
        |tonight
        |today
        |next\s+\w+
        |at\s+\d{1,2}(?::\d{2})?\s*(?:am|pm)?
        |(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)
    )
    """,
    re.IGNORECASE | re.VERBOSE,
)


def _extract_time(text: str) -> str:
    m = _REL_TIME.search(text)
    return m.group(0).strip() if m else ""


def _strip_time(text: str, t: str) -> str:
    if t:
        text = text.replace(t, "").strip()
    return re.sub(r"\s+", " ", text).strip(" ,;.")


def _extract_category_from_text(text: str) -> Optional[str]:
    """Try to find a category or synonym in the text."""
    words = text.lower().split()
    # Check multi-word synonyms first
    for phrase in ['mutual fund', 'mutual funds']:
        if phrase in text.lower():
            return CATEGORY_SYNONYMS.get(phrase)
    # Then single words
    for word in words:
        word = re.sub(r'[^a-z]', '', word)
        resolved = _resolve_category(word)
        if resolved:
            return resolved
    return None


# ── Spending context keywords ────────────────────────────────────────────────

_SPEND_CONTEXT = re.compile(
    r'spend|spent|expense|cost|paid|bill|budget|money|transaction|payment|order|bought|purchase|total|summary|breakdown|how\s+much',
    re.IGNORECASE
)


# ── Intent definitions ───────────────────────────────────────────────────────

def match_intent(text: str) -> Dict[str, Any]:
    """
    Match a user utterance to an intent.
    Returns: { "intent": <str>, "params": <dict> }
    """
    q = (text or "").strip()
    q_lower = q.lower()

    # ── Follow-up / context queries ──────────────────────────────────────────
    # "what about last month?" / "and for food?" / "more details" / "compare that"
    if re.match(r'^(what about|and for|how about|same for|also for|more details?|compare that|break\s*down)', q_lower):
        return {"intent": "nl-query", "params": {"query": q, "follow_up": True}}

    # ── Email intents ────────────────────────────────────────────────────────

    m = re.search(r"reply\s+(?:to\s+)?(.+)", q_lower)
    if m:
        recipient = m.group(1).strip().rstrip(".,;")
        return {"intent": "ai-draft-reply", "params": {"recipient": recipient}}

    m = re.search(r"snooze\s+(?:email\s+(?:from\s+)?)?(.+?)\s+(?:until|to)\s+(.+)", q_lower)
    if m:
        return {"intent": "snooze-email", "params": {
            "target": m.group(1).strip(),
            "until": m.group(2).strip(),
        }}

    m = re.search(r"block\s+(?:sender\s+)?(.+)", q_lower)
    if m and not re.search(r"\d{1,2}(?::\d{2})?\s*(?:am|pm)", q_lower):
        return {"intent": "block-sender", "params": {"email": m.group(1).strip()}}

    m = re.search(r"(?:show\s+)?emails?\s+from\s+(.+)", q_lower)
    if m:
        return {"intent": "get-emails", "params": {"from": m.group(1).strip()}}

    if re.search(r"(?:check|refresh|show|get)\s+(?:my\s+)?(?:mail|email|inbox)", q_lower):
        return {"intent": "refresh-emails", "params": {}}

    # ── Task intents ─────────────────────────────────────────────────────────

    m = re.search(r"remind(?:\s+me)?\s+(?:to\s+)?(.+)", q_lower)
    if m:
        body = m.group(1)
        t = _extract_time(body)
        title = _strip_time(body, t)
        return {"intent": "add-reminder", "params": {"title": title, "time": t}}

    m = re.search(r"(?:done\s+with|completed?|finished?)\s+(?:the\s+)?(.+)", q_lower)
    if m:
        return {"intent": "complete-reminder", "params": {"title": m.group(1).strip()}}

    m = re.search(r"snooze\s+(.+?)\s+(?:to|until)\s+(.+)", q_lower)
    if m:
        return {"intent": "extend-reminder", "params": {
            "title": m.group(1).strip(),
            "until": m.group(2).strip(),
        }}

    # ── Finance intents (enhanced with synonym resolution) ───────────────────

    # "how much did I spend on dining?" → resolves "dining" to "food"
    m = re.search(r"(?:how\s+much|what|show).*(?:spend|spent|expense|cost|paid).*(?:on|for|in)\s+(.+)", q_lower)
    if m:
        raw_cat = m.group(1).strip().rstrip("?").split()[0]
        resolved = _resolve_category(raw_cat) or raw_cat
        return {"intent": "nl-query", "params": {
            "query": q,
            "category": resolved,
        }}

    # Category-first patterns: "food spending" / "dining expenses" / "commute costs"
    # Check ALL synonyms + canonical categories
    all_category_words = list(CANONICAL_CATEGORIES) + list(CATEGORY_SYNONYMS.keys())
    for _cat in all_category_words:
        if re.search(rf"\b{re.escape(_cat)}\b", q_lower) and _SPEND_CONTEXT.search(q_lower):
            resolved = _resolve_category(_cat) or _cat
            return {"intent": "nl-query", "params": {"query": q, "category": resolved}}

    # "cancel [subscription name]" / "delete Netflix"
    m = re.search(r"(?:cancel|delete|remove)\s+(?:my\s+)?(?:subscription\s+(?:to\s+)?)?(.+)", q_lower)
    if m and re.search(r"subscription|netflix|spotify|amazon|prime|hulu|disney", q_lower):
        return {"intent": "delete-subscription", "params": {"name": m.group(1).strip()}}

    # Balance check
    if re.search(r"balance|how\s+much\s+(?:do\s+i|left|remain|have)", q_lower):
        return {"intent": "get-spendable-balance", "params": {}}

    # General spending — check for synonym words with spending context
    # NOTE: merchant detection is included here so it isn't shadowed by the spend context match
    _MERCHANTS = ['swiggy', 'zomato', 'uber', 'ola', 'amazon', 'flipkart', 'netflix',
                  'hotstar', 'spotify', 'airtel', 'jio', 'zerodha', 'groww', 'phonepe',
                  'paytm', 'cred', 'bigbasket', 'blinkit', 'myntra', 'makemytrip',
                  'dunzo', 'zepto', 'rapido', 'practo', 'pharmeasy', 'steam',
                  'github', 'chatgpt', 'notion', 'aws', 'dominos', 'starbucks',
                  'hdfc', 'icici', 'sbi', 'axis', 'kotak', 'lic', 'dmart']
    if _SPEND_CONTEXT.search(q_lower):
        cat = _extract_category_from_text(q_lower)
        params = {"query": q}
        if cat:
            params["category"] = cat
        # Also extract merchant if present within a spend-context query
        for _m in _MERCHANTS:
            if re.search(rf"\b{_m}\b", q_lower):
                params["merchant"] = _m
                break
        return {"intent": "nl-query", "params": params}

    # Merchant-specific queries without explicit spend context: "swiggy summary" / "check netflix"
    for _m in _MERCHANTS:
        if re.search(rf"\b{_m}\b", q_lower):
            return {"intent": "nl-query", "params": {"query": q, "merchant": _m}}

    # ── Calendar intents ─────────────────────────────────────────────────────

    if re.search(r"(?:what(?:'s|\s+is)\s+on|schedule|agenda|calendar)\s+(?:for\s+)?today", q_lower):
        return {"intent": "get-calendar-events", "params": {"when": "today"}}

    if re.search(r"(?:what\s+)?meetings?\s+(?:do\s+i\s+have|today|this\s+week)", q_lower):
        return {"intent": "get-calendar-events", "params": {"when": "today"}}

    m = re.search(r"block\s+(.+?)\s+for\s+(.+)", q_lower)
    if m:
        return {"intent": "add-reminder", "params": {
            "title": m.group(2).strip(),
            "time": m.group(1).strip(),
        }}

    # ── Summary / overview intents ───────────────────────────────────────────

    if re.search(r"\b(?:summary|overview|report|dashboard|stats|statistics)\b", q_lower):
        cat = _extract_category_from_text(q_lower)
        if cat:
            return {"intent": "nl-query", "params": {"query": q, "category": cat}}
        return {"intent": "nl-query", "params": {"query": q}}

    # ── RAG-routed patterns ──────────────────────────────────────────────────

    m = re.search(r"(?:any\s+)?emails?\s+(?:about|regarding|related\s+to)\s+(.+)", q_lower)
    if m:
        return {"intent": "search", "params": {
            "query": m.group(1).strip().rstrip("?"),
            "type": "email",
        }}

    m = re.search(r"what\s+did\s+i\s+decide\s+(?:about\s+)?(.+)", q_lower)
    if m:
        return {"intent": "search", "params": {
            "query": m.group(1).strip().rstrip("?"),
            "type": "notes",
        }}

    # ── Subscription queries ─────────────────────────────────────────────────
    if re.search(r"\bsubscri|recurring|renew|auto.?(?:pay|debit)", q_lower):
        return {"intent": "nl-query", "params": {"query": q}}

    # ── Habit / focus queries ────────────────────────────────────────────────
    if re.search(r"\bhabit|streak|routine|focus\s+(?:time|session)", q_lower):
        return {"intent": "nl-query", "params": {"query": q}}

    # Fallback: general chat
    return {"intent": "chat", "params": {}}
