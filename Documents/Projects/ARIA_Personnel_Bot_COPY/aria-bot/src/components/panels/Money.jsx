import React, { useState, useEffect, useCallback, useMemo } from 'react';
import {
  Trash2, RefreshCw, AlertTriangle, Scan, ExternalLink,
  TrendingUp, ArrowUpRight, ArrowDownLeft,
  Calendar, CreditCard, Shield, BarChart3, ChevronDown, ChevronUp, Plus,
} from 'lucide-react';

/**
 * Money panel — CA-grade financial intelligence + CRED-style fintech UX.
 * Think: Senior Chartered Accountant meets premium fintech.
 * 348×620 overlay — every pixel earns its place.
 */

// ── Category config ───────────────────────────────────────────────────
const CAT_ICON = {
  food: '🍔', groceries: '🥦', travel: '✈️', shopping: '🛍', entertainment: '🎬',
  health: '💊', utilities: '⚡', subscriptions: '📦', investments: '📈',
  insurance: '🛡', banking: '🏦', other: '💳',
};
const CAT_COLOR = {
  food: '#e8a04c', groceries: '#5cb87a', travel: '#4a9dcc', shopping: '#cc6b8a',
  entertainment: '#9b6acc', health: '#5aad6a', utilities: '#b8a04c', subscriptions: '#7a6acc',
  investments: '#4a8acc', insurance: '#cc7a4a', banking: '#8a6a9a', other: '#707070',
};
const SUB_TYPE_LABEL = {
  insurance: { label: 'Insurance', color: '#cc7a4a' },
  investment: { label: 'SIP / MF', color: '#4a8acc' },
  subscription: { label: 'Subscription', color: '#7a6acc' },
  bill: { label: 'Bill', color: '#b8a04c' },
};

// ── Helpers ───────────────────────────────────────────────────────────
const fmt = (n) => `₹${Math.round(n).toLocaleString('en-IN')}`;
const parseAmt = (str) => {
  if (!str && str !== 0) return 0;
  if (typeof str === 'number') return str;
  return parseFloat(String(str).replace(/[₹$,\s]/g, '')) || 0;
};

function classifySub(sub) {
  const n = (sub.name || '').toLowerCase();
  if (/insurance|premium|policy|hdfc life|sbi life|lic\b|max life|bajaj allianz|icici lombard|icici pru|tata aia|star health|coverfox|acko/i.test(n))
    return 'insurance';
  if (/fund|sip|nps|ppf|rd\b|fd\b|invest|zerodha|groww|coin|mutual|kuvera|nav|bse/i.test(n))
    return 'investment';
  if (/electricity|water|gas|airtel|jio|vi\b|vodafone|bsnl|broadband|internet|fastag|bill/i.test(n))
    return 'bill';
  return 'subscription';
}

function relativeDateLabel(ts) {
  const d = new Date(ts * 1000);
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const txDay = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const diff = Math.round((today - txDay) / 86400000);
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Yesterday';
  if (diff < 7) return d.toLocaleDateString('en-IN', { weekday: 'long' });
  return d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
}

function daysLabel(d) {
  if (d < 0) return `Overdue ${Math.abs(d)}d`;
  if (d === 0) return 'Due today';
  if (d === 1) return 'Tomorrow';
  return `${d} days`;
}

// ── Main Component ────────────────────────────────────────────────────
export default function Money() {
  const [summary, setSummary]       = useState(null);
  const [insight, setInsight]       = useState(null);
  const [loading, setLoading]       = useState(true);
  const [scanning, setScanning]     = useState(false);
  const [scanMsg, setScanMsg]       = useState(null);
  const [showAdd, setShowAdd]       = useState(false);
  const [addForm, setAddForm]       = useState({ name: '', amount: '', period: 'monthly' });
  const [adding, setAdding]         = useState(false);
  const [addError, setAddError]     = useState(null);
  const [expandCats, setExpandCats] = useState(false);
  const [expandLedger, setExpandLedger] = useState(false);
  const [monthComp, setMonthComp]   = useState(null);
  const [unusedSubs, setUnusedSubs] = useState(null);
  const [spendable, setSpendable]   = useState(null);
  const [catLimits, setCatLimits]   = useState([]);

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      const [data, ins, mom, unused, spend, limits] = await Promise.all([
        window.aria?.getFinancialSummary(),
        window.aria?.getSpendingInsight(),
        window.aria?.getMonthComparison?.(),
        window.aria?.getUnusedSubscriptions?.(),
        window.aria?.getSpendableBalance?.(),
        window.aria?.getCategoryLimits?.(),
      ]);
      setSummary(data || null);
      setInsight(ins || null);
      setMonthComp(mom || null);
      setUnusedSubs(unused || null);
      setSpendable(spend || null);
      setCatLimits(Array.isArray(limits) ? limits : []);
    } catch (_) {}
    setLoading(false);
  }, []);

  const handleScan = useCallback(async () => {
    setScanning(true);
    setScanMsg(null);
    try {
      const result = await window.aria?.scanFinancialEmails();
      setScanMsg(result?.inserted != null
        ? `${result.inserted} transaction${result.inserted !== 1 ? 's' : ''} found`
        : 'Scan complete');
      fetchData();
    } catch (_) {
      setScanMsg('Scan failed');
    } finally {
      setScanning(false);
    }
  }, [fetchData]);

  const handleAdd = useCallback(async () => {
    if (!addForm.name.trim()) return;
    setAdding(true);
    setAddError(null);
    try {
      const result = await window.aria?.addSubscription({
        name: addForm.name.trim(),
        amount: addForm.amount.trim() || null,
        period: addForm.period,
      });
      if (result?.error) { setAddError(result.error); return; }
      setAddForm({ name: '', amount: '', period: 'monthly' });
      setShowAdd(false);
      fetchData();
    } catch (err) {
      setAddError(err.message || 'Failed');
    } finally {
      setAdding(false);
    }
  }, [addForm, fetchData]);

  const handleDelete = useCallback(async (id) => {
    try { await window.aria?.deleteSubscription(id); fetchData(); } catch (_) {}
  }, [fetchData]);

  useEffect(() => { fetchData(); }, [fetchData]);

  // ── Derived data ────────────────────────────────────────────────────
  const subs         = summary?.subscriptions      || [];
  const recentTx     = summary?.recentTransactions || [];
  const monthly      = summary?.monthlyTotal       || 0;
  const yearly       = summary?.yearlyTotal        || 0;
  const monthDebits  = summary?.monthDebits        || 0;
  const monthCredits = summary?.monthCredits       || 0;
  const catBreakdown = summary?.categoryBreakdown  || [];
  const upcomingDue  = summary?.upcomingDue        || [];
  const exposure     = summary?.exposure           || null;
  const metrics      = insight?.metrics            || [];
  const nowUnix      = Math.floor(Date.now() / 1000);

  // Net cashflow
  const netFlow = monthCredits - monthDebits;

  // Classify subscriptions
  const classified = useMemo(() => {
    const groups = { insurance: [], investment: [], bill: [], subscription: [] };
    subs.forEach(s => {
      const type = classifySub(s);
      groups[type].push({ ...s, _type: type });
    });
    return groups;
  }, [subs]);

  // Group transactions by day
  const dailyLedger = useMemo(() => {
    const groups = {};
    for (const tx of recentTx) {
      const label = relativeDateLabel(tx.timestamp);
      if (!groups[label]) groups[label] = { label, date: tx.timestamp, items: [] };
      groups[label].items.push(tx);
    }
    return Object.values(groups).sort((a, b) => b.date - a.date);
  }, [recentTx]);

  // Category totals
  const catTotal = catBreakdown.reduce((s, c) => s + c.total, 0);

  // ── Loading ─────────────────────────────────────────────────────────
  if (loading) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center gap-2 py-12">
        <div className="w-5 h-5 rounded-full border border-[#333] border-t-[#888] animate-spin" />
      </div>
    );
  }

  const hasData = subs.length > 0 || recentTx.length > 0 || monthly > 0;

  return (
    <div className="flex-1 min-h-0 overflow-y-auto smooth-scroll" style={{ color: '#dcdcdc' }}>
      <div className="px-5 pt-5 pb-8 flex flex-col gap-5">

        {/* ═══════════════════════════════════════════════════════════════
            ZERO-DATA PROMPT
        ═══════════════════════════════════════════════════════════════ */}
        {!hasData && (
          <div className="flex flex-col items-center py-8 gap-3">
            <div className="text-[36px]">💰</div>
            <div className="text-[13px] font-medium" style={{ color: '#888' }}>
              No financial data yet
            </div>
            <div className="text-[11px] text-center leading-relaxed" style={{ color: '#555', maxWidth: '240px' }}>
              ARIA scans your emails to auto-detect subscriptions, insurance premiums, bills, and investments — like a personal CA.
            </div>
            <button onClick={handleScan} disabled={scanning}
              className="flex items-center gap-1.5 mt-2 px-4 py-2 rounded text-[11px] transition-opacity hover:opacity-80 disabled:opacity-40"
              style={{ border: '1px solid #3a3a3a', color: '#c8c8c8', background: 'transparent' }}>
              <Scan size={10} />
              {scanning ? 'Scanning…' : 'Scan emails now'}
            </button>
            {scanMsg && <span className="text-[10px]" style={{ color: '#686868' }}>{scanMsg}</span>}
          </div>
        )}

        {hasData && (
          <>
            {/* ═══════════════════════════════════════════════════════════
                1. CASHFLOW CARD — Net position at a glance
            ═══════════════════════════════════════════════════════════ */}
            <div className="rounded-lg p-4" style={{ background: '#0d0d0d', border: '1px solid #1a1a1a' }}>
              {/* Monthly commitment headline */}
              <div className="flex items-baseline justify-between">
                <div>
                  <div className="font-light tracking-tight leading-none"
                       style={{
                         color: '#f0f0f0', fontVariantNumeric: 'tabular-nums',
                         letterSpacing: '-0.03em',
                         fontSize: monthly >= 100000 ? '24px' : '28px',
                       }}>
                    {fmt(monthly)}
                    <span className="font-light ml-1" style={{ fontSize: '11px', color: '#606060' }}>/mo</span>
                  </div>
                  <div className="text-[10px] mt-1.5" style={{ color: '#707070' }}>
                    {subs.length} commitment{subs.length !== 1 ? 's' : ''} · {fmt(yearly)}/yr
                  </div>
                </div>
                {/* Net flow indicator */}
                {(monthDebits > 0 || monthCredits > 0) && (
                  <div className="text-right">
                    <div className="text-[10px] uppercase tracking-wider mb-1" style={{ color: '#555' }}>
                      30d Net
                    </div>
                    <div className="text-[15px] font-mono font-light" style={{
                      color: netFlow >= 0 ? '#4a9a6a' : '#c06060',
                      fontVariantNumeric: 'tabular-nums',
                    }}>
                      {netFlow >= 0 ? '+' : ''}{fmt(netFlow)}
                    </div>
                  </div>
                )}
              </div>

              {/* Credits / Debits mini bar */}
              {(monthDebits > 0 || monthCredits > 0) && (
                <div className="mt-3 flex gap-3">
                  <div className="flex items-center gap-1.5">
                    <ArrowDownLeft size={10} style={{ color: '#4a9a6a' }} />
                    <span className="text-[10px]" style={{ color: '#4a9a6a' }}>In {fmt(monthCredits)}</span>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <ArrowUpRight size={10} style={{ color: '#c06060' }} />
                    <span className="text-[10px]" style={{ color: '#c06060' }}>Out {fmt(monthDebits)}</span>
                  </div>
                </div>
              )}

              {/* 30-day exposure */}
              {exposure?.next_30day_exposure > 0 && (
                <div className="mt-2 text-[9.5px]" style={{ color: '#555' }}>
                  30d exposure: {fmt(exposure.next_30day_exposure)}
                  {exposure.weekly_variable_spend > 0 && (
                    <span> · {fmt(exposure.weekly_variable_spend)} variable this week</span>
                  )}
                </div>
              )}
            </div>

            {/* ═══════════════════════════════════════════════════════════
                1a. SPENDABLE BALANCE — PocketGuard "In My Pocket"
            ═══════════════════════════════════════════════════════════ */}
            {spendable && spendable.isConfigured && (
              <div className="rounded-lg p-3.5" style={{
                background: 'linear-gradient(135deg, rgba(74,154,106,0.06), rgba(79,156,249,0.04))',
                border: '1px solid rgba(74,154,106,0.15)'
              }}>
                <div className="flex items-center justify-between mb-2">
                  <div className="text-[10px] uppercase tracking-wider font-medium" style={{ color: '#4a9a6a' }}>
                    💚 Spendable Today
                  </div>
                  <div className="text-[9px]" style={{ color: '#555' }}>
                    {spendable.daysLeft}d left in month
                  </div>
                </div>
                <div className="text-[22px] font-light tracking-tight leading-none mb-1.5"
                     style={{ color: spendable.spendable > 0 ? '#4a9a6a' : '#c06060', fontVariantNumeric: 'tabular-nums' }}>
                  {fmt(spendable.dailyBudget)}
                  <span className="text-[10px] ml-1" style={{ color: '#555' }}>/day</span>
                </div>
                <div className="flex items-center gap-3 text-[9px]" style={{ color: '#666' }}>
                  <span>Income: {fmt(spendable.income)}</span>
                  <span>Bills: {fmt(spendable.committed)}</span>
                  <span>Spent: {fmt(spendable.totalSpent)}</span>
                </div>
                {/* Progress bar: how much of budget used */}
                {spendable.income > 0 && (
                  <div className="mt-2 h-[3px] rounded-full" style={{ background: '#1a1a1a' }}>
                    <div style={{
                      width: `${Math.min(100, Math.round(((spendable.committed + spendable.totalSpent) / spendable.income) * 100))}%`,
                      height: '100%', borderRadius: '9999px',
                      background: spendable.spendable > spendable.income * 0.2 ? '#4a9a6a' : '#c06060',
                      transition: 'width 0.4s ease',
                    }} />
                  </div>
                )}
              </div>
            )}

            {/* ═══════════════════════════════════════════════════════════
                1b. MONTH vs LAST MONTH (YNAB-style comparison)
            ═══════════════════════════════════════════════════════════ */}
            {monthComp && monthComp.lastMonth > 0 && (
              <div className="rounded-lg p-3.5" style={{ background: '#0d0d0d', border: '1px solid #1a1a1a' }}>
                <div className="flex items-center justify-between mb-2.5">
                  <div className="text-[10px] uppercase tracking-wider font-medium" style={{ color: '#888' }}>
                    <TrendingUp size={10} className="inline mr-1" style={{ color: monthComp.pctChange > 0 ? '#c06060' : '#4a9a6a' }} />
                    Month vs Last Month
                  </div>
                  <div className="text-[12px] font-mono font-medium" style={{
                    color: monthComp.pctChange > 0 ? '#c06060' : '#4a9a6a',
                    fontVariantNumeric: 'tabular-nums',
                  }}>
                    {monthComp.pctChange > 0 ? '+' : ''}{monthComp.pctChange}%
                  </div>
                </div>
                <div className="flex items-center justify-between text-[10px] mb-2" style={{ color: '#707070' }}>
                  <span>This month: {fmt(monthComp.thisMonth)}</span>
                  <span>Last: {fmt(monthComp.lastMonth)}</span>
                </div>
                {/* Category spikes */}
                {monthComp.spikes && monthComp.spikes.length > 0 && (
                  <div className="flex flex-col gap-1 mt-1.5 pt-2" style={{ borderTop: '1px solid #1e1e1e' }}>
                    {monthComp.spikes.slice(0, 3).map((s, i) => (
                      <div key={i} className="flex items-center justify-between text-[9px]">
                        <span style={{ color: '#888' }}>
                          {CAT_ICON[s.category] || '💳'} {s.category}
                        </span>
                        <span style={{ color: s.change > 0 ? '#c06060' : '#4a9a6a' }}>
                          {s.change > 0 ? '↑' : '↓'}{Math.abs(s.change)}% ({fmt(s.current)})
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

            {/* ═══════════════════════════════════════════════════════════
                1c. UNUSED SUBSCRIPTIONS ALERT (YNAB savings opportunity)
            ═══════════════════════════════════════════════════════════ */}
            {unusedSubs && unusedSubs.unused && unusedSubs.unused.length > 0 && (
              <div className="rounded-lg p-3.5" style={{
                background: 'rgba(192,96,96,0.04)',
                border: '1px solid rgba(192,96,96,0.12)'
              }}>
                <div className="flex items-center justify-between mb-2">
                  <div className="text-[10px] uppercase tracking-wider font-medium" style={{ color: '#c06060' }}>
                    💤 Possibly Unused
                  </div>
                  {unusedSubs.potentialSavings > 0 && (
                    <div className="text-[10px] font-mono" style={{ color: '#c06060' }}>
                      Save {fmt(unusedSubs.potentialSavings)}/mo
                    </div>
                  )}
                </div>
                <div className="text-[9px] mb-2" style={{ color: '#888' }}>
                  No activity in 60 days. Consider cancelling:
                </div>
                {unusedSubs.unused.slice(0, 4).map((sub, i) => (
                  <div key={sub.id || i} className="flex items-center justify-between py-1.5"
                       style={{ borderBottom: i < Math.min(unusedSubs.unused.length, 4) - 1 ? '1px solid rgba(192,96,96,0.08)' : 'none' }}>
                    <span className="text-[11px]" style={{ color: '#b08080' }}>{sub.name}</span>
                    <span className="text-[10px] font-mono" style={{ color: '#888' }}>
                      {sub.amount ? (typeof sub.amount === 'string' ? sub.amount : fmt(sub.amount)) : '—'}
                    </span>
                  </div>
                ))}
              </div>
            )}

            {/* ═══════════════════════════════════════════════════════════
                2. UPCOMING DUE — Bills, SIPs, Premiums, Subscriptions
            ═══════════════════════════════════════════════════════════ */}
            {upcomingDue.length > 0 && (
              <section>
                <SectionHeader icon={<Calendar size={10} />} title="Upcoming Due" count={upcomingDue.length} accent="#cc7a4a" />
                <div className="flex flex-col">
                  {upcomingDue.map((item, i) => {
                    const type = classifySub(item);
                    const amt = parseAmt(item.amount);
                    const urgent = item.daysLeft <= 3;
                    const overdue = item.daysLeft < 0;
                    return (
                      <div key={item.id} className="flex items-center py-2 gap-2.5"
                           style={{ borderBottom: i < upcomingDue.length - 1 ? '1px solid #141414' : 'none' }}>
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-1.5 flex-wrap">
                            <span className="text-[12px] truncate" style={{ color: '#d0d0d0' }}>{item.name}</span>
                            <TypePill type={type} />
                          </div>
                          <div className="flex items-center gap-1.5 mt-0.5">
                            <span className="text-[10px]" style={{
                              color: overdue ? '#ef4444' : urgent ? '#cc7a4a' : '#686868'
                            }}>
                              {(overdue || urgent) && <AlertTriangle size={8} className="inline mr-0.5 mb-px" />}
                              {daysLabel(item.daysLeft)}
                            </span>
                            {item.payment_link && (
                              <PayLink href={item.payment_link} />
                            )}
                          </div>
                        </div>
                        {amt > 0 && (
                          <div className="text-[13px] font-mono shrink-0"
                               style={{ color: urgent || overdue ? '#cc7a4a' : '#b0b0b0', fontVariantNumeric: 'tabular-nums' }}>
                            {fmt(amt)}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </section>
            )}

            {/* ═══════════════════════════════════════════════════════════
                3. CATEGORY BREAKDOWN — Where your money goes
            ═══════════════════════════════════════════════════════════ */}
            {catBreakdown.length > 0 && (
              <section>
                <button onClick={() => setExpandCats(v => !v)}
                  className="w-full flex items-center justify-between group">
                  <SectionHeader icon={<BarChart3 size={10} />} title="Spend Breakdown" accent="#707070" />
                  {catBreakdown.length > 4 && (
                    expandCats
                      ? <ChevronUp size={12} style={{ color: '#555' }} />
                      : <ChevronDown size={12} style={{ color: '#555' }} />
                  )}
                </button>

                {/* Mini CSS Donut Pie Chart */}
                {catTotal > 0 && (
                  <div className="flex justify-center my-3">
                    <div style={{ position: 'relative', width: 80, height: 80 }}>
                      <svg width="80" height="80" viewBox="0 0 36 36">
                        {(() => {
                          let cumPct = 0;
                          return catBreakdown.slice(0, 6).map((cat, i) => {
                            const pct = (cat.total / catTotal) * 100;
                            const offset = 100 - cumPct;
                            cumPct += pct;
                            const color = CAT_COLOR[cat.category] || '#555';
                            return (
                              <circle key={i} cx="18" cy="18" r="15.9155" fill="none"
                                stroke={color} strokeWidth="3"
                                strokeDasharray={`${pct} ${100 - pct}`}
                                strokeDashoffset={offset}
                                style={{ transition: 'stroke-dasharray 0.6s ease' }} />
                            );
                          });
                        })()}
                      </svg>
                      <div style={{
                        position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center',
                        flexDirection: 'column',
                      }}>
                        <span className="text-[11px] font-mono font-light" style={{ color: '#ccc' }}>
                          {fmt(catTotal)}
                        </span>
                        <span className="text-[7px]" style={{ color: '#555' }}>total</span>
                      </div>
                    </div>
                  </div>
                )}

                <div className="flex flex-col gap-[6px] mt-1">
                  {(expandCats ? catBreakdown : catBreakdown.slice(0, 4)).map(cat => {
                    const pct = catTotal > 0 ? Math.round((cat.total / catTotal) * 100) : 0;
                    const color = CAT_COLOR[cat.category] || '#555';
                    return (
                      <div key={cat.category} className="flex items-center gap-2">
                        <span className="text-[12px] w-4 text-center">{CAT_ICON[cat.category] || '💳'}</span>
                        <span className="text-[11px] w-[68px] capitalize truncate" style={{ color: '#999' }}>
                          {cat.category}
                        </span>
                        <div className="flex-1 h-[3px] rounded-full" style={{ background: '#1a1a1a' }}>
                          <div style={{
                            width: `${Math.max(pct, 2)}%`, height: '100%', borderRadius: '9999px',
                            background: color, transition: 'width 0.4s ease',
                          }} />
                        </div>
                        <span className="text-[10px] font-mono w-[48px] text-right" style={{ color: '#888', fontVariantNumeric: 'tabular-nums' }}>
                          {fmt(cat.total)}
                        </span>
                        <span className="text-[9px] w-[28px] text-right" style={{ color: '#555' }}>
                          {pct}%
                        </span>
                      </div>
                    );
                  })}
                </div>
              </section>
            )}

            {/* ═══════════════════════════════════════════════════════════
                3b. CATEGORY BUDGET LIMITS — PocketGuard-style alerts
            ═══════════════════════════════════════════════════════════ */}
            {catLimits.length > 0 && (
              <section>
                <SectionHeader icon={<Shield size={10} />} title="Budget Limits" accent="#f97316" />
                <div className="flex flex-col gap-1.5 mt-1">
                  {catLimits.map(lim => {
                    const pct = lim.monthly_limit > 0 ? Math.round((lim.spent / lim.monthly_limit) * 100) : 0;
                    const color = lim.exceeded ? '#c06060' : pct > 80 ? '#f97316' : '#4a9a6a';
                    return (
                      <div key={lim.category}>
                        <div className="flex items-center justify-between">
                          <span className="text-[10px] capitalize flex items-center gap-1" style={{ color: '#999' }}>
                            {CAT_ICON[lim.category] || '💳'} {lim.category}
                          </span>
                          <span className="text-[9px] font-mono" style={{ color }}>
                            {fmt(lim.spent)} / {fmt(lim.monthly_limit)}
                            {lim.exceeded && <span className="ml-1" style={{ color: '#c06060' }}>⚠</span>}
                          </span>
                        </div>
                        <div className="h-[2px] rounded-full mt-1" style={{ background: '#1a1a1a' }}>
                          <div style={{
                            width: `${Math.min(100, pct)}%`, height: '100%', borderRadius: '9999px',
                            background: color, transition: 'width 0.4s ease',
                          }} />
                        </div>
                        {lim.exceeded && (
                          <div className="text-[8px] mt-0.5" style={{ color: '#c06060' }}>
                            Over by {fmt(lim.spent - lim.monthly_limit)}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </section>
            )}

            {/* ═══════════════════════════════════════════════════════════
                4. DAILY LEDGER — Recent activity, day-by-day
            ═══════════════════════════════════════════════════════════ */}
            {dailyLedger.length > 0 && (
              <section>
                <button onClick={() => setExpandLedger(v => !v)}
                  className="w-full flex items-center justify-between group">
                  <SectionHeader icon={<CreditCard size={10} />} title="Activity Ledger" accent="#707070" />
                  {dailyLedger.length > 2 && (
                    expandLedger
                      ? <ChevronUp size={12} style={{ color: '#555' }} />
                      : <ChevronDown size={12} style={{ color: '#555' }} />
                  )}
                </button>
                {(expandLedger ? dailyLedger : dailyLedger.slice(0, 2)).map((day, di) => (
                  <div key={day.label} className={di > 0 ? 'mt-2' : ''}>
                    <div className="text-[9px] uppercase tracking-widest mb-1" style={{ color: '#4a4a4a' }}>
                      {day.label}
                    </div>
                    {day.items.slice(0, expandLedger ? 10 : 4).map((tx, ti) => {
                      const isCredit = tx.tx_type === 'credit';
                      const catColor = CAT_COLOR[tx.category] || '#555';
                      return (
                        <div key={ti} className="flex items-center py-[5px] gap-2"
                             style={{ borderBottom: ti < day.items.length - 1 ? '1px solid #111' : 'none' }}>
                          <span style={{
                            width: 6, height: 6, borderRadius: '50%', flexShrink: 0,
                            background: isCredit ? '#4a9a6a' : catColor,
                          }} />
                          <div className="flex-1 min-w-0">
                            <div className="text-[11.5px] truncate" style={{ color: '#c8c8c8' }}>
                              {tx.merchant || tx.description || tx.category}
                            </div>
                            <div className="text-[9px] mt-px flex items-center gap-1" style={{ color: '#4a4a4a' }}>
                              <span className="capitalize">{tx.category}</span>
                              {tx.payment_link && <PayLink href={tx.payment_link} small />}
                            </div>
                          </div>
                          <div className="text-[12px] font-mono shrink-0" style={{
                            color: isCredit ? '#4a9a6a' : '#a0a0a0',
                            fontVariantNumeric: 'tabular-nums',
                          }}>
                            {isCredit ? '+' : '-'}{fmt(tx.amount)}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                ))}
              </section>
            )}

            {/* ═══════════════════════════════════════════════════════════
                5. INSURANCE & INVESTMENTS — Policies + SIPs
            ═══════════════════════════════════════════════════════════ */}
            {(classified.insurance.length > 0 || classified.investment.length > 0) && (
              <section>
                <SectionHeader icon={<Shield size={10} />} title="Insurance & Investments" accent="#cc7a4a" />
                {classified.insurance.concat(classified.investment).map((s, i, arr) => {
                  const type = classifySub(s);
                  const amt = parseAmt(s.amount);
                  const renewalDate = s.next_renewal ? new Date(s.next_renewal * 1000) : null;
                  const daysUntil = renewalDate ? Math.ceil((s.next_renewal - nowUnix) / 86400) : null;
                  const periodLabel = { monthly: '/mo', yearly: '/yr', 'one-time': '' }[s.period] || '';
                  return (
                    <div key={s.id} className="flex items-center py-2 gap-2 group"
                         style={{ borderBottom: i < arr.length - 1 ? '1px solid #141414' : 'none' }}>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-1.5 flex-wrap">
                          <span className="text-[12px] truncate" style={{ color: '#d0d0d0' }}>{s.name}</span>
                          <TypePill type={type} />
                        </div>
                        <div className="flex items-center gap-1.5 mt-0.5">
                          {daysUntil !== null && (
                            <span className="text-[9.5px]" style={{
                              color: daysUntil < 0 ? '#ef4444' : daysUntil <= 30 ? '#cc7a4a' : '#555'
                            }}>
                              {daysUntil < 0 ? `Overdue ${Math.abs(daysUntil)}d`
                                : daysUntil === 0 ? 'Due today'
                                : `Next: ${renewalDate.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })}`}
                            </span>
                          )}
                          {s.payment_link && <PayLink href={s.payment_link} />}
                        </div>
                      </div>
                      <div className="shrink-0 text-right flex items-center gap-2">
                        {amt > 0 && (
                          <span className="text-[13px] font-mono" style={{ color: '#b0b0b0', fontVariantNumeric: 'tabular-nums' }}>
                            {fmt(amt)}<span className="text-[8px]" style={{ color: '#555' }}>{periodLabel}</span>
                          </span>
                        )}
                        <button onClick={() => handleDelete(s.id)}
                          className="opacity-0 group-hover:opacity-100 transition-opacity"
                          style={{ color: '#404040' }} title="Remove">
                          <Trash2 size={9} />
                        </button>
                      </div>
                    </div>
                  );
                })}
              </section>
            )}

            {/* ═══════════════════════════════════════════════════════════
                6. SUBSCRIPTIONS & BILLS
            ═══════════════════════════════════════════════════════════ */}
            <section>
              <div className="flex items-center justify-between">
                <SectionHeader icon={<CreditCard size={10} />} title="Subscriptions & Bills" accent="#707070" />
                {!showAdd && (
                  <button onClick={() => { setShowAdd(true); setAddError(null); }}
                    className="text-[10px] transition-opacity hover:opacity-70 flex items-center gap-0.5"
                    style={{ color: '#686868' }}>
                    <Plus size={9} /> Add
                  </button>
                )}
              </div>

              {classified.subscription.concat(classified.bill).length === 0 && !showAdd && (
                <div className="text-[11px] py-1" style={{ color: '#555' }}>
                  No subscriptions tracked.{' '}
                  <button onClick={() => setShowAdd(true)}
                    className="underline underline-offset-2 hover:opacity-80" style={{ color: '#888' }}>
                    Add one.
                  </button>
                </div>
              )}

              {classified.subscription.concat(classified.bill).map((s, i, arr) => {
                const type = classifySub(s);
                const amt = parseAmt(s.amount);
                const renewalDate = s.next_renewal ? new Date(s.next_renewal * 1000) : null;
                const daysUntil = renewalDate ? Math.ceil((s.next_renewal - nowUnix) / 86400) : null;
                const periodLabel = { monthly: '/mo', yearly: '/yr', 'one-time': '' }[s.period] || '';
                const urgent = daysUntil !== null && daysUntil >= 0 && daysUntil <= 3;
                return (
                  <div key={s.id} className="flex items-center py-2 gap-2 group"
                       style={{ borderBottom: i < arr.length - 1 ? '1px solid #141414' : 'none' }}>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-1.5 flex-wrap">
                        <span className="text-[12px] truncate" style={{ color: '#d0d0d0' }}>{s.name}</span>
                        <TypePill type={type} />
                      </div>
                      {daysUntil !== null && (
                        <div className="flex items-center gap-1.5 mt-0.5">
                          <span className="text-[9.5px]" style={{
                            color: daysUntil < 0 ? '#ef4444' : urgent ? '#cc7a4a' : '#555'
                          }}>
                            {daysUntil < 0 ? `Overdue ${Math.abs(daysUntil)}d`
                              : daysUntil === 0 ? 'Due today'
                              : `Renews ${renewalDate.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })}`}
                          </span>
                          {s.payment_link && <PayLink href={s.payment_link} />}
                        </div>
                      )}
                    </div>
                    <div className="shrink-0 text-right flex items-center gap-2">
                      {amt > 0 && (
                        <span className="text-[13px] font-mono" style={{ color: '#b0b0b0', fontVariantNumeric: 'tabular-nums' }}>
                          {fmt(amt)}<span className="text-[8px]" style={{ color: '#555' }}>{periodLabel}</span>
                        </span>
                      )}
                      <button onClick={() => handleDelete(s.id)}
                        className="opacity-0 group-hover:opacity-100 transition-opacity"
                        style={{ color: '#404040' }} title="Remove">
                        <Trash2 size={9} />
                      </button>
                    </div>
                  </div>
                );
              })}

              {/* Inline Add Form */}
              {showAdd && (
                <div className="mt-3 pt-3" style={{ borderTop: '1px solid #1a1a1a' }}>
                  <div className="flex flex-col gap-2">
                    <FieldInput placeholder="Service name (e.g. Netflix)" value={addForm.name}
                      onChange={v => setAddForm(f => ({ ...f, name: v }))} onEnter={handleAdd} />
                    <div className="flex gap-2">
                      <FieldInput placeholder="Amount (e.g. ₹499)" value={addForm.amount}
                        onChange={v => setAddForm(f => ({ ...f, amount: v }))} onEnter={handleAdd} />
                      <select value={addForm.period}
                        onChange={e => setAddForm(f => ({ ...f, period: e.target.value }))}
                        className="rounded text-[11px] outline-none px-2"
                        style={{ background: '#0a0a0a', border: '1px solid #2a2a2a', color: '#777', minWidth: '76px' }}>
                        <option value="monthly">Monthly</option>
                        <option value="yearly">Yearly</option>
                        <option value="one-time">One-time</option>
                      </select>
                    </div>
                    {addError && <div className="text-[10px]" style={{ color: '#c06060' }}>{addError}</div>}
                    <div className="flex gap-2 mt-1">
                      <button onClick={handleAdd} disabled={!addForm.name.trim() || adding}
                        className="px-4 py-1.5 rounded text-[11px] transition-opacity hover:opacity-80 disabled:opacity-30"
                        style={{ border: '1px solid #404040', color: '#c8c8c8', background: 'transparent' }}>
                        {adding ? 'Adding…' : 'Confirm'}
                      </button>
                      <button onClick={() => { setShowAdd(false); setAddForm({ name: '', amount: '', period: 'monthly' }); setAddError(null); }}
                        className="px-4 py-1.5 rounded text-[11px] transition-opacity hover:opacity-80"
                        style={{ border: '1px solid #2a2a2a', color: '#777', background: 'transparent' }}>
                        Cancel
                      </button>
                    </div>
                  </div>
                </div>
              )}
            </section>

            {/* ═══════════════════════════════════════════════════════════
                7. SMART CA INSIGHT — AI-powered analysis
            ═══════════════════════════════════════════════════════════ */}
            {(insight?.insight || subs.length > 0) && (
              <section>
                <div style={{ borderLeft: '2px solid #1e1e1e', paddingLeft: '12px' }}>
                  <div className="text-[8px] uppercase tracking-[0.16em] mb-2" style={{ color: '#606060' }}>
                    ARIA CA Insight
                  </div>

                  {/* Weekly spend headline */}
                  {insight?.weekTotal > 0 && (
                    <p className="text-[12px] leading-relaxed" style={{ color: '#c8c8c8' }}>
                      This week: {fmt(insight.weekTotal)} across {insight.orderCount || 0} transaction{insight.orderCount !== 1 ? 's' : ''}
                      {insight.avgWeekTotal > 0 && (
                        <span style={{
                          color: insight.weekTotal > insight.avgWeekTotal * 1.15 ? '#c06060'
                            : insight.weekTotal < insight.avgWeekTotal * 0.85 ? '#4a9a6a' : '#686868'
                        }}>
                          {' '}— {insight.weekTotal > insight.avgWeekTotal * 1.15 ? 'above' : insight.weekTotal < insight.avgWeekTotal * 0.85 ? 'below' : 'within'} avg
                        </span>
                      )}
                    </p>
                  )}

                  {/* AI insight */}
                  {insight?.insight && (
                    <p className="text-[11px] leading-[1.7] mt-1" style={{ color: '#999' }}>
                      {insight.insight}
                    </p>
                  )}

                  {/* Recommendation */}
                  {insight?.recommendation && (
                    <p className="text-[11px] leading-[1.7] mt-1" style={{ color: '#7a6a50' }}>
                      {insight.recommendation}
                    </p>
                  )}

                  {/* Insurance summary */}
                  {classified.insurance.length > 0 && (() => {
                    const insYearly = classified.insurance.reduce((acc, s) => {
                      const a = parseAmt(s.amount);
                      return acc + (s.period === 'yearly' ? a : a * 12);
                    }, 0);
                    return (
                      <p className="text-[11px] leading-[1.7] mt-1" style={{ color: '#cc7a4a' }}>
                        {classified.insurance.length} insurance polic{classified.insurance.length === 1 ? 'y' : 'ies'} → {fmt(insYearly)}/yr in premiums
                      </p>
                    );
                  })()}

                  {/* Investment summary */}
                  {classified.investment.length > 0 && (() => {
                    const invMonthly = classified.investment.reduce((acc, s) => {
                      const a = parseAmt(s.amount);
                      return acc + (s.period === 'monthly' ? a : s.period === 'yearly' ? a / 12 : 0);
                    }, 0);
                    return (
                      <p className="text-[11px] leading-[1.7] mt-1" style={{ color: '#4a8acc' }}>
                        {classified.investment.length} SIP{classified.investment.length !== 1 ? 's' : ''}/investment{classified.investment.length !== 1 ? 's' : ''} → {fmt(invMonthly)}/mo systematic
                      </p>
                    );
                  })()}

                  {/* 5% hike impact */}
                  {yearly > 5000 && (
                    <p className="text-[10px] leading-[1.7] mt-1" style={{ color: '#555' }}>
                      A 5% price hike across all services adds {fmt(yearly * 0.05)}/yr to your commitments.
                    </p>
                  )}
                </div>
              </section>
            )}

            {/* ═══════════════════════════════════════════════════════════
                8. SPENDING PATTERN — Behavioral intelligence
            ═══════════════════════════════════════════════════════════ */}
            {metrics.length > 0 && (
              <BehaviorBlock insight={insight} metrics={metrics} onRefresh={fetchData} />
            )}

            {/* ═══════════════════════════════════════════════════════════
                9. ACTIONS
            ═══════════════════════════════════════════════════════════ */}
            <div className="flex items-center gap-2 flex-wrap pt-1">
              <button onClick={handleScan} disabled={scanning}
                className="flex items-center gap-1 px-3 py-1.5 rounded text-[10px] transition-opacity hover:opacity-80 disabled:opacity-40"
                style={{ border: '1px solid #2a2a2a', color: '#777', background: 'transparent' }}>
                <Scan size={9} />
                {scanning ? 'Scanning…' : 'Scan emails'}
              </button>
              {scanMsg && <span className="text-[9px]" style={{ color: '#555' }}>{scanMsg}</span>}
              <button onClick={fetchData}
                className="flex items-center gap-1 text-[10px] transition-opacity hover:opacity-80 ml-auto"
                style={{ color: '#555' }}>
                <RefreshCw size={9} />
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

/* ═════════════════════════════════════════════════════════════════════════
   SUB-COMPONENTS
═════════════════════════════════════════════════════════════════════════ */

function SectionHeader({ icon, title, count, accent = '#707070' }) {
  return (
    <div className="flex items-center gap-1.5 mb-2" style={{ borderTop: '1px solid #151515', paddingTop: '12px' }}>
      <span style={{ color: accent }}>{icon}</span>
      <span className="text-[9px] uppercase tracking-[0.12em]" style={{ color: accent }}>{title}</span>
      {count != null && (
        <span className="text-[9px] font-mono" style={{ color: '#444' }}>{count}</span>
      )}
    </div>
  );
}

function TypePill({ type }) {
  const meta = SUB_TYPE_LABEL[type] || SUB_TYPE_LABEL.subscription;
  return (
    <span className="text-[7px] uppercase tracking-widest px-1.5 py-px rounded"
          style={{ color: meta.color, border: `1px solid ${meta.color}25`, background: `${meta.color}08` }}>
      {meta.label}
    </span>
  );
}

function PayLink({ href, small }) {
  return (
    <a href={href} target="_blank" rel="noopener noreferrer"
       className="flex items-center gap-0.5 rounded transition-opacity hover:opacity-80"
       style={{
         color: '#4a9dcc', border: '1px solid #4a9dcc30', background: '#4a9dcc08',
         fontSize: small ? '8px' : '9px', padding: small ? '0 4px' : '0 6px 0 6px',
         lineHeight: '16px',
       }}
       onClick={(e) => { e.stopPropagation(); window.open(href, '_blank'); }}>
      Pay <ExternalLink size={small ? 6 : 7} />
    </a>
  );
}

function FieldInput({ placeholder, value, onChange, onEnter }) {
  return (
    <input value={value}
      onChange={e => onChange(e.target.value)}
      onKeyDown={e => { if (e.key === 'Enter' && onEnter) { e.preventDefault(); onEnter(); } }}
      placeholder={placeholder}
      className="flex-1 w-full outline-none text-[11px] py-2 bg-transparent"
      style={{ borderBottom: '1px solid #2a2a2a', color: '#d0d0d0', caretColor: '#888' }} />
  );
}

/* ── Behavior Block ──────────────────────────────────────────────────── */

function BehaviorBlock({ insight, metrics, onRefresh }) {
  const [showLog, setShowLog] = useState(false);
  const [logForm, setLogForm] = useState({ category: 'food', amount: '', description: '' });
  const [logging, setLogging] = useState(false);

  const handleLog = async () => {
    const amt = parseFloat(logForm.amount);
    if (!amt || amt <= 0) return;
    setLogging(true);
    try {
      await window.aria?.recordSpend({
        category: logForm.category,
        amount_raw: amt,
        description: logForm.description.trim() || logForm.category,
      });
      setLogForm({ category: 'food', amount: '', description: '' });
      setShowLog(false);
      onRefresh();
    } catch (_) {}
    setLogging(false);
  };

  const flagged = (metrics || []).filter(m => m.flagged);

  return (
    <section>
      <div className="flex items-center justify-between" style={{ borderTop: '1px solid #151515', paddingTop: '12px' }}>
        <div className="flex items-center gap-1.5 mb-2">
          <TrendingUp size={10} style={{ color: '#707070' }} />
          <span className="text-[9px] uppercase tracking-[0.12em]" style={{ color: '#707070' }}>
            Spending Pattern
          </span>
        </div>
        <button onClick={() => setShowLog(v => !v)}
          className="text-[9px] transition-opacity hover:opacity-70 mb-2"
          style={{ color: '#555' }}>
          {showLog ? 'cancel' : '+ log'}
        </button>
      </div>

      {/* Deviation bars */}
      <div className="flex flex-col gap-[5px]">
        {metrics.slice(0, 6).map(m => {
          const catColor = CAT_COLOR[m.category] || '#555';
          const devAbs = Math.abs(Math.round(m.deviation_percent || 0));
          const isHigh = (m.deviation_percent || 0) > 0;
          const barPct = Math.min(100, devAbs);
          return (
            <div key={m.category} className="flex items-center gap-2">
              <span style={{ width: 5, height: 5, borderRadius: '50%', background: catColor, flexShrink: 0 }} />
              <div className="text-[10px] w-[68px] capitalize truncate" style={{ color: '#777' }}>{m.category}</div>
              <div className="flex-1 h-[2px] rounded-full" style={{ background: '#1a1a1a' }}>
                {devAbs > 0 && (
                  <div style={{
                    width: `${barPct}%`, height: '100%', borderRadius: '9999px',
                    background: m.flagged ? '#8a4a2e' : '#333', transition: 'width 0.3s ease',
                  }} />
                )}
              </div>
              <div className="text-[10px] font-mono w-[42px] text-right" style={{
                color: m.flagged ? '#9a5a3a' : '#555', fontVariantNumeric: 'tabular-nums',
              }}>
                {m.deviation_percent != null && devAbs > 0
                  ? `${isHigh ? '+' : '-'}${devAbs}%`
                  : m.baseline_avg > 0 ? `₹${Math.round(m.baseline_avg / 1000)}k` : '—'}
              </div>
            </div>
          );
        })}
      </div>

      {/* Flagged anomalies */}
      {flagged.length > 0 && (
        <div className="mt-2">
          {flagged.map(m => (
            <div key={m.category} className="text-[10px] leading-[1.6]" style={{ color: '#9a5a3a' }}>
              {m.category.charAt(0).toUpperCase() + m.category.slice(1)}: {Math.abs(Math.round(m.deviation_percent))}%{' '}
              {m.deviation_percent > 0 ? 'above' : 'below'} avg
              {m.pattern_note ? ` · ${m.pattern_note}` : ''}
            </div>
          ))}
        </div>
      )}

      {/* Quick log form */}
      {showLog && (
        <div className="mt-3 flex flex-col gap-2">
          <div className="flex gap-2">
            <select value={logForm.category}
              onChange={e => setLogForm(f => ({ ...f, category: e.target.value }))}
              className="rounded text-[10px] outline-none px-2 py-1"
              style={{ background: 'transparent', border: '1px solid #1e1e1e', color: '#555', minWidth: '80px' }}>
              {['food','shopping','travel','entertainment','health','utilities','other'].map(c => (
                <option key={c} value={c}>{c.charAt(0).toUpperCase() + c.slice(1)}</option>
              ))}
            </select>
            <FieldInput placeholder="Amount" value={logForm.amount}
              onChange={v => setLogForm(f => ({ ...f, amount: v }))} onEnter={handleLog} />
          </div>
          <FieldInput placeholder="Description (optional)" value={logForm.description}
            onChange={v => setLogForm(f => ({ ...f, description: v }))} />
          <button onClick={handleLog} disabled={!logForm.amount || logging}
            className="px-4 py-1.5 rounded text-[11px] transition-opacity hover:opacity-80 disabled:opacity-30 self-start"
            style={{ border: '1px solid #2a2a2a', color: '#c8c8c8', background: 'transparent' }}>
            {logging ? 'Saving…' : 'Log'}
          </button>
        </div>
      )}
    </section>
  );
}

