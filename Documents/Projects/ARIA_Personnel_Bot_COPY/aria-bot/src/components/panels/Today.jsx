import React, { useState, useEffect, useCallback } from 'react';
import { RefreshCw, AlertTriangle, ChevronDown, ChevronRight, CheckCircle2, X, TrendingUp } from 'lucide-react';
import { useTheme } from '../../context/ThemeContext';

/**
 * Today — Executive Decision Surface.
 * Single IPC call → executive summary → ranked priority list.
 * No filter tabs. No decorative elements. Just signal.
 * P10: + Learning Layer tracking, Prediction signals, Relationship badges,
 *       Outcome tracking strip, dismiss tracking.
 */

const DOMAIN_ICON = {
  task: '📋', email: '✉️', finance: '💳', calendar: '📅',
  prediction: '⏱️', relationship: '🤝'
};

const SENDER_BADGE = {
  boss:       { label: '👔 Boss',       color: '#ef4444' },
  client:     { label: '💼 Client',     color: '#f59e0b' },
  colleague:  { label: '👥 Colleague',  color: '#3b82f6' },
  vendor:     { label: '🏢 Vendor',     color: '#8b5cf6' },
  newsletter: { label: '📰 Newsletter', color: '#6b7280' },
};

const CONFIDENCE_STYLE = {
  high:       { label: 'High',       color: '#ef4444', bg: 'rgba(239,68,68,0.1)' },
  medium:     { label: 'Medium',     color: '#f59e0b', bg: 'rgba(245,158,11,0.1)' },
  low:        { label: 'Low',        color: '#6b7280', bg: 'rgba(107,114,128,0.1)' },
  unverified: { label: 'Unverified', color: '#6b7280', bg: 'rgba(107,114,128,0.1)' },
};

export default function Today({ onNavigate }) {
  const { theme } = useTheme();
  const isDark = theme === 'dark';

  const [state, setState] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [expanded, setExpanded] = useState({});
  const [dismissed, setDismissed] = useState(new Set());

  const fetchState = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await window.aria?.getUserState();
      if (data?.error && !data?.priorities?.length) {
        setError(data.error);
      } else {
        setState(data);
        setDismissed(new Set()); // Reset dismissed on refresh
      }
    } catch (err) {
      setError(err.message || 'Failed to load state');
    } finally {
      setLoading(false);
    }
  }, []);

  // P10-1: Track signal interaction
  const trackSignal = useCallback((signalId, action, domain, score) => {
    window.aria?.trackSignal?.(signalId, action, domain, score);
  }, []);

  // P10-1: Handle card dismiss
  const handleDismiss = useCallback((e, priority) => {
    e.stopPropagation();
    trackSignal(priority.id, 'dismissed', priority.domain, priority.score);
    setDismissed(prev => new Set([...prev, priority.id]));
  }, [trackSignal]);

  // P10-1: Handle card action (click)
  const handleAct = useCallback((priority) => {
    trackSignal(priority.id, 'acted', priority.domain, priority.score);
  }, [trackSignal]);

  useEffect(() => { fetchState(); }, [fetchState]);

  if (loading) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center gap-3 py-12">
        <div className="w-8 h-8 rounded-full border-2 border-[#4f9cf9] border-t-transparent animate-spin" />
        <span className="text-[11px]" style={{ color: isDark ? '#555' : '#9ca3af' }}>
          Scanning your data...
        </span>
      </div>
    );
  }

  if (error && !state) {
    return (
      <div className="flex-1 p-3">
        <div className="rounded-xl p-3" style={{
          background: isDark ? 'rgba(249,115,22,0.06)' : 'rgba(249,115,22,0.08)',
          border: '1px solid rgba(249,115,22,0.15)'
        }}>
          <div className="flex items-center gap-2 mb-2">
            <AlertTriangle size={14} className="text-[#f97316]" />
            <span className="text-[11px] text-[#f97316] font-semibold">Could not load state</span>
          </div>
          <p className="text-[11px] leading-relaxed mb-3" style={{ color: isDark ? '#c8c8c8' : '#4b5563' }}>{error}</p>
          <button onClick={fetchState} className="flex items-center gap-1.5 text-[10px] text-[#4f9cf9] hover:opacity-80">
            <RefreshCw size={11} /> Retry
          </button>
        </div>
      </div>
    );
  }

  const { priorities = [], silence, stats = {}, userName, quality = {}, outcomeStats } = state || {};
  const hour = new Date().getHours();
  const greeting = hour < 12 ? 'Morning' : hour < 17 ? 'Afternoon' : 'Evening';
  const toggleExpand = (id) => setExpanded(prev => ({ ...prev, [id]: !prev[id] }));

  // Filter out dismissed cards
  const visiblePriorities = priorities.filter(p => !dismissed.has(p.id));

  // Build executive summary counts
  const overdueCount = visiblePriorities.filter(p => p.domain === 'task').length;
  const emailCount = visiblePriorities.filter(p => p.domain === 'email').length;
  const financeCount = visiblePriorities.filter(p => p.domain === 'finance').length;
  const calendarCount = visiblePriorities.filter(p => p.domain === 'calendar').length;
  const predictionCount = visiblePriorities.filter(p => p.domain === 'prediction').length;
  const relationshipCount = visiblePriorities.filter(p => p.domain === 'relationship').length;
  const riskCount = visiblePriorities.filter(p => p.score >= 75).length;

  return (
    <div className="flex-1 min-h-0 overflow-y-auto px-3 pb-4 pt-2 flex flex-col gap-2.5 smooth-scroll">

      {/* Header: Name */}
      <div className="px-1 pt-1">
        <div className="text-[16px] font-bold tracking-tight"
             style={{ color: isDark ? '#f0f0f0' : '#1f2937', fontFamily: 'Georgia, serif' }}>
          {greeting}{userName ? `, ${userName}` : ''}
        </div>
      </div>

      {/* Executive Summary — one-line status */}
      {!silence && visiblePriorities.length > 0 && (
        <div className="rounded-lg px-3 py-2" style={{
          background: isDark ? 'rgba(249,115,22,0.04)' : 'rgba(249,115,22,0.06)',
          border: `1px solid ${isDark ? 'rgba(249,115,22,0.12)' : 'rgba(249,115,22,0.15)'}`
        }}>
          <div className="text-[11px] font-medium" style={{ color: isDark ? '#e0e0e0' : '#374151' }}>
            {buildSummaryLine(riskCount, overdueCount, emailCount, financeCount, calendarCount, predictionCount, relationshipCount)}
          </div>
        </div>
      )}

      {/* P10-5: Outcome Report Strip — ROI at a glance */}
      {outcomeStats && (outcomeStats.hoursSaved > 0 || outcomeStats.issuesCaught > 0) && (
        <div className="rounded-lg px-3 py-2 flex items-center gap-2" style={{
          background: isDark ? 'rgba(34,197,94,0.04)' : 'rgba(34,197,94,0.06)',
          border: `1px solid ${isDark ? 'rgba(34,197,94,0.12)' : 'rgba(34,197,94,0.15)'}`
        }}>
          <TrendingUp size={12} style={{ color: '#22c55e' }} />
          <div className="text-[10px] flex-1" style={{ color: isDark ? '#a0e0b0' : '#16a34a' }}>
            This week: <strong>{outcomeStats.hoursSaved}h saved</strong>
            {outcomeStats.issuesCaught > 0 && <> · <strong>{outcomeStats.issuesCaught} issue{outcomeStats.issuesCaught > 1 ? 's' : ''} caught</strong></>}
            {outcomeStats.roiMultiple > 0 && <> · <strong>{outcomeStats.roiMultiple}x ROI</strong></>}
          </div>
        </div>
      )}

      {/* Silence Mode */}
      {silence && (
        <div className="rounded-xl px-4 py-5 text-center" style={{
          background: isDark
            ? 'linear-gradient(135deg, rgba(34,197,94,0.04), rgba(79,156,249,0.03))'
            : 'linear-gradient(135deg, rgba(34,197,94,0.08), rgba(79,156,249,0.05))',
          border: `1px solid ${isDark ? 'rgba(34,197,94,0.15)' : 'rgba(34,197,94,0.2)'}`
        }}>
          <CheckCircle2 size={22} className="mx-auto mb-2" style={{ color: '#22c55e' }} />
          <div className="text-[13px] font-semibold" style={{ color: isDark ? '#e0e0e0' : '#374151' }}>
            No urgent items today.
          </div>
          <div className="text-[10px] mt-1" style={{ color: isDark ? '#555' : '#9ca3af' }}>
            All clear. {stats.tasks > 0 ? `${stats.tasks} open tasks, none critical.` : 'No open tasks.'}
          </div>
        </div>
      )}

      {/* Priority List — single ranked list, no tabs */}
      {!silence && visiblePriorities.map((p, i) => {
        const isFirst = i === 0;
        const isOpen = isFirst || expanded[p.id];
        const conf = CONFIDENCE_STYLE[p.confidence] || CONFIDENCE_STYLE.unverified;
        const icon = DOMAIN_ICON[p.domain] || '📋';
        const senderBadge = p.senderType ? SENDER_BADGE[p.senderType] : null;

        return (
          <div key={p.id} className="relative group">
            <button
              onClick={() => { handleAct(p); if (!isFirst) toggleExpand(p.id); }}
              className="w-full text-left rounded-xl transition-all hover:opacity-95"
              style={{
                background: isDark
                  ? isFirst ? 'rgba(249,115,22,0.06)' : '#1c1c1c'
                  : isFirst ? 'rgba(249,115,22,0.08)' : '#fff',
                border: `1px solid ${isFirst
                  ? 'rgba(249,115,22,0.2)'
                  : isDark ? '#252525' : '#e5e7eb'}`,
                padding: isOpen ? '10px 12px' : '8px 12px'
              }}>

              {/* Top row: icon + score + title + badges + expand */}
              <div className="flex items-center gap-2">
                <span className="text-[13px] shrink-0">{icon}</span>
                <span className="text-[9px] font-bold px-1.5 py-0.5 rounded shrink-0"
                      style={{
                        color: p.score >= 80 ? '#ef4444' : p.score >= 60 ? '#f97316' : '#4f9cf9',
                        background: `${p.score >= 80 ? '#ef4444' : p.score >= 60 ? '#f97316' : '#4f9cf9'}18`
                      }}>
                  {p.score}
                </span>
                <div className="flex-1 min-w-0">
                  {isFirst && (
                    <div className="text-[8px] tracking-widest uppercase font-bold mb-0.5"
                         style={{ color: '#ef4444' }}>HANDLE FIRST</div>
                  )}
                  <div className="text-[12px] font-medium truncate"
                       style={{ color: isDark ? '#e0e0e0' : '#1f2937' }}>
                    {p.title}
                  </div>
                </div>
                {/* P10-3: Sender relationship badge */}
                {senderBadge && (
                  <span className="text-[8px] px-1.5 py-0.5 rounded shrink-0"
                        style={{ color: senderBadge.color, background: `${senderBadge.color}15` }}>
                    {senderBadge.label}
                  </span>
                )}
                {/* P10-1: Learned indicator */}
                {p.learned && (
                  <span className="text-[8px] px-1 py-0.5 rounded shrink-0"
                        style={{ color: '#8b5cf6', background: 'rgba(139,92,246,0.1)' }}
                        title={`Adjusted by ${p.learningMultiplier?.toFixed(2)}x from learning`}>
                    🧠
                  </span>
                )}
                {/* Confidence badge */}
                <span className="text-[8px] font-semibold px-1.5 py-0.5 rounded shrink-0"
                      style={{ color: conf.color, background: conf.bg }}>
                  {conf.label}
                </span>
                {!isFirst && (
                  isOpen
                    ? <ChevronDown size={12} className="shrink-0" style={{ color: isDark ? '#555' : '#bbb' }} />
                    : <ChevronRight size={12} className="shrink-0" style={{ color: isDark ? '#555' : '#bbb' }} />
                )}
              </div>

              {/* Expanded: description + reasoning */}
              {isOpen && (
                <div className="mt-1.5 pl-[21px] flex flex-col gap-1">
                  {p.description && (
                    <div className="text-[11px] font-medium"
                         style={{ color: isDark ? '#ccc' : '#374151' }}>
                      {p.description}
                    </div>
                  )}
                  {p.reasoning && (
                    <div className="text-[10px]"
                         style={{ color: isDark ? '#666' : '#9ca3af' }}>
                      → {p.reasoning}
                    </div>
                  )}
                </div>
              )}
            </button>
            {/* P10-1: Dismiss button — appears on hover */}
            <button
              onClick={(e) => handleDismiss(e, p)}
              className="absolute top-1.5 right-1.5 opacity-0 group-hover:opacity-100 transition-opacity rounded-full p-0.5 hover:bg-red-500/10"
              style={{ color: isDark ? '#555' : '#bbb' }}
              title="Dismiss this signal">
              <X size={10} />
            </button>
          </div>
        );
      })}

      {/* Stat Strip */}
      <div className="flex items-center justify-center gap-3 px-2 py-2 rounded-lg"
           style={{
             background: isDark ? 'rgba(255,255,255,0.02)' : 'rgba(0,0,0,0.02)',
             border: `1px solid ${isDark ? 'rgba(255,255,255,0.04)' : 'rgba(0,0,0,0.04)'}`
           }}>
        <StatChip value={stats.tasks || 0} label="tasks" isDark={isDark} />
        <StatDot isDark={isDark} />
        <StatChip value={stats.emails || 0} label="emails" isDark={isDark} />
        <StatDot isDark={isDark} />
        <StatChip value={`\u20B9${(stats.monthSpend || 0).toLocaleString()}`} label="this month" isDark={isDark} />
      </div>

      {/* Ask Prompt */}
      <button onClick={() => onNavigate?.('ask')}
        className="w-full rounded-xl px-3 py-2.5 text-left flex items-center gap-2 transition-opacity hover:opacity-80"
        style={{
          background: isDark
            ? 'linear-gradient(135deg, rgba(167,139,250,0.04), rgba(79,156,249,0.03))'
            : 'linear-gradient(135deg, rgba(167,139,250,0.06), rgba(79,156,249,0.04))',
          border: `1px solid ${isDark ? 'rgba(167,139,250,0.12)' : 'rgba(167,139,250,0.15)'}`
        }}>
        <span className="text-[14px]">✦</span>
        <span className="text-[11px] flex-1" style={{ color: isDark ? '#888' : '#6b7280' }}>
          Ask ARIA anything...
        </span>
        <ChevronRight size={12} style={{ color: isDark ? '#444' : '#bbb' }} />
      </button>

      {/* Data Quality Indicators — compact */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-1">
        {!quality.gmailConnected && (
          <span className="text-[9px] px-1.5 py-0.5 rounded-full flex items-center gap-1"
                style={{ background: 'rgba(249,115,22,0.1)', color: '#f97316' }}>
            ⚠ Gmail disconnected
          </span>
        )}
        {quality.calendarStale && (
          <span className="text-[9px] px-1.5 py-0.5 rounded-full flex items-center gap-1"
                style={{ background: 'rgba(251,191,36,0.1)', color: '#f59e0b' }}>
            ⚠ Calendar stale
          </span>
        )}
        {quality.emailIndexed != null && (
          <span className="text-[9px]" style={{ color: isDark ? '#444' : '#bbb' }}>
            {quality.emailIndexed} emails indexed
          </span>
        )}
        {quality.txDays != null && quality.txDays > 0 && (
          <span className="text-[9px]" style={{ color: isDark ? '#444' : '#bbb' }}>
            · {quality.txDays}d tx data
          </span>
        )}
      </div>

      {/* Refresh */}
      <button onClick={fetchState}
        className="flex items-center justify-center gap-1.5 text-[10px] py-1 hover:opacity-80 transition-colors"
        style={{ color: isDark ? '#444' : '#bbb' }}>
        <RefreshCw size={10} />
        {formatAge(state?.generatedAt)}
      </button>
    </div>
  );
}

/* ── Helpers ───────────────────────────── */

function buildSummaryLine(risks, overdue, emails, finance, calendar, predictions, relationships) {
  const parts = [];
  if (risks > 0) parts.push(`${risks} high-priority`);
  if (overdue > 0) parts.push(`${overdue} overdue`);
  if (emails > 0) parts.push(`${emails} email${emails > 1 ? 's' : ''}`);
  if (finance > 0) parts.push(`${finance} financial`);
  if (calendar > 0) parts.push(`${calendar} event${calendar > 1 ? 's' : ''}`);
  if (predictions > 0) parts.push(`${predictions} prediction${predictions > 1 ? 's' : ''}`);
  if (relationships > 0) parts.push(`${relationships} relationship${relationships > 1 ? 's' : ''}`);
  if (parts.length === 0) return 'Nothing flagged.';
  return parts.join(' · ') + '.';
}

function StatChip({ value, label, isDark }) {
  return (
    <div className="flex items-center gap-1">
      <span className="text-[11px] font-semibold" style={{ color: isDark ? '#c0c0c0' : '#374151' }}>{value}</span>
      <span className="text-[10px]" style={{ color: isDark ? '#555' : '#9ca3af' }}>{label}</span>
    </div>
  );
}

function StatDot({ isDark }) {
  return <span className="text-[10px]" style={{ color: isDark ? '#2a2a2a' : '#d0d0d0' }}>·</span>;
}

function formatAge(ts) {
  if (!ts) return 'just now';
  const m = Math.floor((Date.now() - ts) / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  return `${Math.floor(m / 60)}h ago`;
}