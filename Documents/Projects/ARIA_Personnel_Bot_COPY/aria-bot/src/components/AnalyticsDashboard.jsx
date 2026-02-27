import React, { useState, useEffect, useCallback } from 'react';
import { BarChart3, TrendingUp, TrendingDown, Flame, Target, ChevronDown, ChevronUp, Activity } from 'lucide-react';

/**
 * AnalyticsDashboard — Focus & Habit analytics card for Today panel.
 * Shows trends, scores, day-of-week patterns, and streaks.
 */
export default function AnalyticsDashboard({ isDark }) {
  const [focusData, setFocusData] = useState(null);
  const [habitData, setHabitData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [tab, setTab] = useState('focus'); // 'focus' | 'habits'

  const fetchData = useCallback(async () => {
    if (focusData && habitData) { setExpanded(e => !e); return; }
    setLoading(true);
    try {
      const [focus, habits] = await Promise.all([
        window.aria?.getFocusAnalytics?.(14),
        window.aria?.getHabitAnalytics?.(14)
      ]);
      if (focus) setFocusData(focus);
      if (habits) setHabitData(habits);
      setExpanded(true);
    } catch (_) {}
    setLoading(false);
  }, [focusData, habitData]);

  return (
    <div className="rounded-xl overflow-hidden"
         style={{
           background: isDark ? '#1c1c1c' : '#fff',
           border: `1px solid ${isDark ? '#272727' : '#e0e0e0'}`
         }}>
      {/* Header */}
      <button
        onClick={fetchData}
        className="w-full flex items-center justify-between px-3 py-1.5"
        style={{
          background: isDark ? 'rgba(249,115,22,0.04)' : 'rgba(249,115,22,0.05)',
          borderBottom: expanded ? `1px solid ${isDark ? '#232323' : '#eee'}` : 'none'
        }}>
        <span className="text-[9px] font-mono font-semibold tracking-widest uppercase flex items-center gap-1.5"
              style={{ color: '#f97316' }}>
          <Activity size={10} /> Analytics
        </span>
        <span style={{ color: isDark ? '#444' : '#aaa' }}>
          {loading ? (
            <div className="w-3 h-3 rounded-full border border-[#f97316] border-t-transparent animate-spin" />
          ) : expanded ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
        </span>
      </button>

      {expanded && (focusData || habitData) && (
        <div className="px-3 py-2 space-y-2">
          {/* Tab switch */}
          <div className="flex gap-1">
            <TabBtn active={tab === 'focus'} onClick={() => setTab('focus')} isDark={isDark}>
              🎯 Focus
            </TabBtn>
            <TabBtn active={tab === 'habits'} onClick={() => setTab('habits')} isDark={isDark}>
              📊 Habits
            </TabBtn>
          </div>

          {tab === 'focus' && focusData && <FocusTab data={focusData} isDark={isDark} />}
          {tab === 'habits' && habitData && <HabitsTab data={habitData} isDark={isDark} />}
        </div>
      )}
    </div>
  );
}

function TabBtn({ active, onClick, children, isDark }) {
  return (
    <button
      onClick={onClick}
      className="flex-1 text-[10px] font-semibold py-1 rounded-md transition-all"
      style={{
        background: active ? 'rgba(249,115,22,0.1)' : 'transparent',
        border: `1px solid ${active ? 'rgba(249,115,22,0.25)' : isDark ? '#2a2a2a' : '#e0e0e0'}`,
        color: active ? '#f97316' : isDark ? '#666' : '#9ca3af'
      }}>
      {children}
    </button>
  );
}

function FocusTab({ data, isDark }) {
  const s = data.stats || {};

  return (
    <div className="space-y-2">
      {/* Productivity score */}
      <div className="flex items-center gap-2">
        <div className="relative w-10 h-10">
          <svg className="w-full h-full -rotate-90" viewBox="0 0 40 40">
            <circle cx="20" cy="20" r="16" fill="none" stroke={isDark ? '#222' : '#eee'} strokeWidth="3" />
            <circle cx="20" cy="20" r="16" fill="none" stroke={scoreColor(s.productivityScore)} strokeWidth="3"
                    strokeDasharray={`${2 * Math.PI * 16}`}
                    strokeDashoffset={`${2 * Math.PI * 16 * (1 - (s.productivityScore || 0) / 100)}`}
                    strokeLinecap="round" />
          </svg>
          <div className="absolute inset-0 flex items-center justify-center">
            <span className="text-[10px] font-bold" style={{ color: scoreColor(s.productivityScore) }}>
              {s.productivityScore || 0}
            </span>
          </div>
        </div>
        <div>
          <div className="text-[11px] font-semibold" style={{ color: isDark ? '#ddd' : '#1f2937' }}>
            Productivity Score
          </div>
          <div className="text-[9px]" style={{ color: isDark ? '#555' : '#9ca3af' }}>
            {s.trendLabel || ''}
          </div>
        </div>
      </div>

      {/* Key stats */}
      <div className="grid grid-cols-2 gap-1.5">
        <StatChip label="Total" value={`${s.totalMinutes || 0}m`} icon="⏱" isDark={isDark} />
        <StatChip label="Sessions" value={s.totalSessions || 0} icon="🔄" isDark={isDark} />
        <StatChip label="Avg/Day" value={`${s.avgPerDay || 0}m`} icon="📊" isDark={isDark} />
        <StatChip label="Streak" value={`${s.focusStreak || 0}d`} icon="🔥" isDark={isDark} />
      </div>

      {/* Mini bar chart — last 14 days */}
      {data.daily && data.daily.length > 0 && (
        <div>
          <div className="text-[8px] uppercase tracking-wider font-semibold mb-1"
               style={{ color: isDark ? '#444' : '#bbb' }}>Last 14 Days</div>
          <div className="flex items-end gap-[2px] h-[32px]">
            {data.daily.slice(-14).map((d, i) => {
              const maxMins = Math.max(...data.daily.slice(-14).map(x => x.minutes), 1);
              const h = Math.max(2, (d.minutes / maxMins) * 30);
              return (
                <div key={i} className="flex-1 rounded-t-sm transition-all"
                     style={{
                       height: `${h}px`,
                       background: d.minutes > 0 ? '#4f9cf9' : (isDark ? '#222' : '#eee'),
                       opacity: d.minutes > 0 ? 0.8 : 0.3
                     }}
                     title={`${d.date}: ${d.minutes}m`} />
              );
            })}
          </div>
        </div>
      )}

      {/* Best day of week */}
      {s.bestDow && (
        <div className="text-[9px]" style={{ color: isDark ? '#666' : '#9ca3af' }}>
          Best focus day: <strong style={{ color: '#4f9cf9' }}>{s.bestDow}</strong> · 
          Best recorded: {s.bestDayMinutes}m on {s.bestDay}
        </div>
      )}
    </div>
  );
}

function HabitsTab({ data, isDark }) {
  if (!data.habits || data.habits.length === 0) {
    return (
      <div className="text-[10px] text-center py-2" style={{ color: isDark ? '#555' : '#9ca3af' }}>
        No habits tracked yet. Start in the Today panel!
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {/* Overall rate */}
      <div className="flex items-center gap-2">
        <div className="relative w-10 h-10">
          <svg className="w-full h-full -rotate-90" viewBox="0 0 40 40">
            <circle cx="20" cy="20" r="16" fill="none" stroke={isDark ? '#222' : '#eee'} strokeWidth="3" />
            <circle cx="20" cy="20" r="16" fill="none" stroke={scoreColor(data.overallRate)} strokeWidth="3"
                    strokeDasharray={`${2 * Math.PI * 16}`}
                    strokeDashoffset={`${2 * Math.PI * 16 * (1 - (data.overallRate || 0) / 100)}`}
                    strokeLinecap="round" />
          </svg>
          <div className="absolute inset-0 flex items-center justify-center">
            <span className="text-[10px] font-bold" style={{ color: scoreColor(data.overallRate) }}>
              {data.overallRate}%
            </span>
          </div>
        </div>
        <div>
          <div className="text-[11px] font-semibold" style={{ color: isDark ? '#ddd' : '#1f2937' }}>
            Overall Completion
          </div>
          <div className="text-[9px]" style={{ color: isDark ? '#555' : '#9ca3af' }}>
            {data.totalHabits} habit{data.totalHabits !== 1 ? 's' : ''} tracked
          </div>
        </div>
      </div>

      {/* Per-habit breakdown */}
      {data.habits.map((h, i) => (
        <div key={i} className="flex items-center gap-2"
             style={{ borderBottom: i < data.habits.length - 1 ? `1px solid ${isDark ? '#232323' : '#f0f0f0'}` : 'none', paddingBottom: '4px' }}>
          <span className="text-[12px] shrink-0">{h.icon}</span>
          <div className="flex-1 min-w-0">
            <div className="flex items-center justify-between">
              <span className="text-[10.5px] truncate" style={{ color: isDark ? '#c0c0c0' : '#374151' }}>
                {h.name}
              </span>
              <span className="text-[9px] font-mono shrink-0 ml-1"
                    style={{ color: scoreColor(h.completionRate) }}>
                {h.completionRate}%
              </span>
            </div>
            {/* Progress bar */}
            <div className="h-[3px] rounded-full mt-0.5" style={{ background: isDark ? '#222' : '#eee' }}>
              <div className="h-full rounded-full transition-all"
                   style={{
                     width: `${h.completionRate}%`,
                     background: scoreColor(h.completionRate)
                   }} />
            </div>
            <div className="flex items-center gap-2 mt-0.5">
              <span className="text-[8px]" style={{ color: isDark ? '#444' : '#bbb' }}>
                🔥 {h.currentStreak}d streak
              </span>
              <span className="text-[8px]" style={{ color: isDark ? '#444' : '#bbb' }}>
                Best: {h.longestStreak}d
              </span>
              <span className="text-[8px]" style={{ color: isDark ? '#444' : '#bbb' }}>
                {h.trendLabel}
              </span>
            </div>
          </div>
        </div>
      ))}

      {/* Best/Worst habit callout */}
      {data.bestHabit && data.habits.length > 1 && (
        <div className="text-[9px]" style={{ color: isDark ? '#666' : '#9ca3af' }}>
          🏆 Best: <strong>{data.bestHabit.icon} {data.bestHabit.name}</strong> ({data.bestHabit.completionRate}%)
          {data.worstHabit && data.worstHabit.id !== data.bestHabit.id && (
            <> · Needs work: <strong>{data.worstHabit.icon} {data.worstHabit.name}</strong> ({data.worstHabit.completionRate}%)</>
          )}
        </div>
      )}
    </div>
  );
}

function StatChip({ label, value, icon, isDark }) {
  return (
    <div className="flex items-center gap-1.5 rounded-md px-2 py-1"
         style={{
           background: isDark ? 'rgba(255,255,255,0.02)' : 'rgba(0,0,0,0.02)',
           border: `1px solid ${isDark ? '#252525' : '#e8e8e8'}`
         }}>
      <span className="text-[10px]">{icon}</span>
      <div>
        <div className="font-mono text-[11px] font-bold" style={{ color: isDark ? '#ddd' : '#1f2937' }}>{value}</div>
        <div className="text-[7px] uppercase tracking-wider" style={{ color: isDark ? '#444' : '#aaa' }}>{label}</div>
      </div>
    </div>
  );
}

function scoreColor(score) {
  if (score >= 75) return '#22c55e';
  if (score >= 50) return '#eab308';
  if (score >= 25) return '#f97316';
  return '#ef4444';
}
