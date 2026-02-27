import React, { useState, useCallback } from 'react';
import { FileText, TrendingUp, TrendingDown, Minus, ChevronDown, ChevronUp } from 'lucide-react';

/**
 * WeeklyReport — Collapsible AI-generated weekly productivity summary.
 * Shows in Today panel. Loads on demand (user clicks to expand).
 */
export default function WeeklyReport({ isDark }) {
  const [report, setReport] = useState(null);
  const [loading, setLoading] = useState(false);
  const [expanded, setExpanded] = useState(false);

  const fetchReport = useCallback(async () => {
    if (report && !report.error) { setExpanded(e => !e); return; }
    setLoading(true);
    try {
      const data = await window.aria?.getWeeklyReport();
      if (data) setReport(data);
      setExpanded(true);
    } catch (_) {}
    setLoading(false);
  }, [report]);

  const T = (v, suffix = '') => v != null ? `${v}${suffix}` : '--';

  return (
    <div className="rounded-xl overflow-hidden"
         style={{
           background: isDark ? '#1c1c1c' : '#fff',
           border: `1px solid ${isDark ? '#272727' : '#e0e0e0'}`
         }}>
      {/* Header — always visible, clickable */}
      <button
        onClick={fetchReport}
        className="w-full flex items-center justify-between px-3 py-1.5"
        style={{
          background: isDark ? 'rgba(167,139,250,0.04)' : 'rgba(167,139,250,0.05)',
          borderBottom: expanded ? `1px solid ${isDark ? '#232323' : '#eee'}` : 'none'
        }}>
        <span className="text-[9px] font-mono font-semibold tracking-widest uppercase flex items-center gap-1.5"
              style={{ color: '#a78bfa' }}>
          <FileText size={10} /> Weekly Report
        </span>
        <span style={{ color: isDark ? '#444' : '#aaa' }}>
          {loading ? (
            <div className="w-3 h-3 rounded-full border border-[#a78bfa] border-t-transparent animate-spin" />
          ) : expanded ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
        </span>
      </button>

      {/* Body */}
      {expanded && report && (
        <div className="px-3 py-2 space-y-2">
          {/* Period */}
          <div className="text-[9px]" style={{ color: isDark ? '#555' : '#9ca3af' }}>
            {report.period?.from} → {report.period?.to}
          </div>

          {/* Stats grid */}
          <div className="grid grid-cols-3 gap-1.5">
            <MiniStat label="Tasks Done" value={T(report.tasks?.completed)} color="#22c55e" isDark={isDark} />
            <MiniStat label="Focus Time" value={T(report.focus?.totalMinutes, 'm')} color="#4f9cf9" isDark={isDark} />
            <MiniStat label="Habits" value={T(report.habits?.overallRate, '%')} color="#f97316" isDark={isDark} />
            <MiniStat label="Emails" value={T(report.emails?.total)} color="#ef4444" isDark={isDark} />
            <MiniStat label="Meetings" value={T(report.meetings)} color="#a78bfa" isDark={isDark} />
            <MiniStat label="Streak" value={T(report.streak, 'd')} color="#eab308" isDark={isDark} />
          </div>

          {/* Overdue alert */}
          {report.tasks?.overdue > 0 && (
            <div className="text-[10px] px-2 py-1 rounded"
                 style={{ background: 'rgba(239,68,68,0.06)', color: '#ef4444', border: '1px solid rgba(239,68,68,0.15)' }}>
              ⚠️ {report.tasks.overdue} overdue task{report.tasks.overdue > 1 ? 's' : ''} need attention
            </div>
          )}

          {/* Top completed tasks */}
          {report.tasks?.topCompleted?.length > 0 && (
            <div>
              <div className="text-[8px] uppercase tracking-wider font-semibold mb-1"
                   style={{ color: isDark ? '#444' : '#aaa' }}>Completed</div>
              {report.tasks.topCompleted.slice(0, 3).map((t, i) => (
                <div key={i} className="text-[10px] truncate" style={{ color: isDark ? '#888' : '#6b7280' }}>
                  ✓ {t}
                </div>
              ))}
            </div>
          )}

          {/* AI Summary */}
          {report.aiSummary && (
            <div className="rounded-lg px-2.5 py-2 text-[10.5px] leading-relaxed"
                 style={{
                   background: isDark ? 'rgba(167,139,250,0.04)' : 'rgba(167,139,250,0.06)',
                   border: '1px solid rgba(167,139,250,0.12)',
                   color: isDark ? '#b0b0b0' : '#4b5563'
                 }}>
              {report.aiSummary}
            </div>
          )}

          {/* Spending */}
          {report.money?.monthlySpend > 0 && (
            <div className="text-[10px] flex items-center gap-1.5"
                 style={{ color: isDark ? '#888' : '#6b7280' }}>
              💳 ₹{report.money.monthlySpend.toLocaleString()}/mo across {report.money.subscriptionCount} subscriptions
              {report.money.upcomingRenewals?.length > 0 && (
                <span className="text-[#f97316]">
                  · {report.money.upcomingRenewals.length} renewing soon
                </span>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function MiniStat({ label, value, color, isDark }) {
  return (
    <div className="rounded-md px-2 py-1 text-center"
         style={{
           background: isDark ? 'rgba(255,255,255,0.02)' : 'rgba(0,0,0,0.02)',
           border: `1px solid ${isDark ? '#252525' : '#e8e8e8'}`
         }}>
      <div className="font-mono text-[13px] font-bold" style={{ color }}>{value}</div>
      <div className="text-[8px] uppercase tracking-wider" style={{ color: isDark ? '#444' : '#aaa' }}>{label}</div>
    </div>
  );
}
