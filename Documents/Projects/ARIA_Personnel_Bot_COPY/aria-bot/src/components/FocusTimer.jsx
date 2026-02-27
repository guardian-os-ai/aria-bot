import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Play, Square, RotateCcw, Clock } from 'lucide-react';

/**
 * FocusTimer - Pomodoro-style focus with circular progress.
 * Polished: proper ring, visible stats, clean idle/active states.
 */
export default function FocusTimer({ isDark, embedded }) {
  const [status, setStatus]     = useState({ active: false });
  const [stats, setStats]       = useState(null);
  const [duration, setDuration] = useState(25);
  const intervalRef = useRef(null);

  const fetchStatus = useCallback(async () => {
    try {
      const s = await window.aria?.getFocusStatus();
      if (s) {
        setStatus(s);
        if (s?.justFinished) fetchStats();
      }
    } catch (_) {}
  }, []);

  const fetchStats = useCallback(async () => {
    try {
      const s = await window.aria?.getFocusStats();
      if (s) setStats(s);
    } catch (_) {}
  }, []);

  useEffect(() => { fetchStatus(); fetchStats(); }, [fetchStatus, fetchStats]);

  useEffect(() => {
    if (status.active) {
      intervalRef.current = setInterval(fetchStatus, 1000);
      return () => clearInterval(intervalRef.current);
    } else {
      if (intervalRef.current) clearInterval(intervalRef.current);
    }
  }, [status.active, fetchStatus]);

  const handleStart = async () => {
    try {
      const res = await window.aria?.startFocus(duration);
      if (res?.success) fetchStatus();
    } catch (_) {}
  };

  const handleStop = async () => {
    try {
      await window.aria?.endFocus();
      fetchStatus();
      fetchStats();
    } catch (_) {}
  };

  const fmt = (sec) => {
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  };

  const progress = status.active && status.totalDuration > 0
    ? ((status.totalDuration - status.remaining) / status.totalDuration) * 100
    : 0;

  const PRESETS = [15, 25, 45, 60];
  const R = 32;
  const C = 2 * Math.PI * R;

  const innerContent = (
    <>
      {/* Header — hidden when embedded */}
      {!embedded && (
        <div className="flex items-center justify-between px-3 py-1.5"
             style={{ background: isDark ? 'rgba(79,156,249,0.04)' : 'rgba(79,156,249,0.05)', borderBottom: `1px solid ${isDark ? '#232323' : '#eee'}` }}>
          <span className="text-[9px] font-mono font-semibold tracking-widest uppercase"
                style={{ color: '#4f9cf9' }}>
            {'\ud83c\udfaf'} Focus Timer
          </span>
          {stats && (
            <span className="text-[9px]" style={{ color: isDark ? '#444' : '#aaa' }}>
              Today: {stats.todayMinutes}m {'\xb7'} {stats.todaySessions} session{stats.todaySessions !== 1 ? 's' : ''}
            </span>
          )}
        </div>
      )}

      {/* Embedded: show stats inline */}
      {embedded && stats && (
        <div className="flex items-center justify-end px-3 py-1"
             style={{ borderBottom: `1px solid ${isDark ? '#232323' : '#eee'}` }}>
          <span className="text-[9px]" style={{ color: isDark ? '#555' : '#aaa' }}>
            Today: {stats.todayMinutes}m {'\xb7'} {stats.todaySessions} session{stats.todaySessions !== 1 ? 's' : ''}
          </span>
        </div>
      )}

      <div className="px-3 py-2.5">
        {status.active ? (
          /* Active session */
          <div className="flex items-center gap-4">
            {/* Ring */}
            <div className="relative w-[72px] h-[72px] shrink-0">
              <svg className="w-full h-full -rotate-90" viewBox="0 0 72 72">
                <circle cx="36" cy="36" r={R} fill="none"
                        stroke={isDark ? '#222' : '#eee'} strokeWidth="3.5" />
                <circle cx="36" cy="36" r={R} fill="none"
                        stroke="#4f9cf9" strokeWidth="3.5"
                        strokeDasharray={C}
                        strokeDashoffset={C * (1 - progress / 100)}
                        strokeLinecap="round"
                        className="transition-all duration-1000" />
              </svg>
              <div className="absolute inset-0 flex items-center justify-center">
                <span className="font-mono text-[15px] font-bold"
                      style={{ color: isDark ? '#e0e0e0' : '#1f2937' }}>
                  {fmt(status.remaining || 0)}
                </span>
              </div>
            </div>

            {/* Info + Stop */}
            <div className="flex-1 flex flex-col gap-2">
              <div className="text-[10px]" style={{ color: isDark ? '#555' : '#888' }}>
                Elapsed: {fmt(status.elapsed || 0)}
              </div>
              <button onClick={handleStop}
                className="flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-lg text-[10px] font-semibold transition-colors"
                style={{ background: 'rgba(239,68,68,0.1)', color: '#ef4444', border: '1px solid rgba(239,68,68,0.2)' }}>
                <Square size={10} /> End Session
              </button>
            </div>
          </div>
        ) : (
          /* Idle */
          <div className="flex flex-col gap-2">
            {/* Presets row */}
            <div className="flex gap-1.5 justify-center">
              {PRESETS.map(m => (
                <button key={m} onClick={() => setDuration(m)}
                  className={`px-3 py-[4px] rounded-md text-[10.5px] font-medium transition-all ${duration === m ? '' : 'opacity-50 hover:opacity-70'}`}
                  style={{
                    background: duration === m ? 'rgba(79,156,249,0.12)' : isDark ? '#222' : '#f5f5f5',
                    border: `1px solid ${duration === m ? 'rgba(79,156,249,0.3)' : isDark ? '#2a2a2a' : '#ddd'}`,
                    color: duration === m ? '#4f9cf9' : isDark ? '#777' : '#666',
                  }}>
                  {m}m
                </button>
              ))}
            </div>

            {/* Start button */}
            <button onClick={handleStart}
              className="flex items-center justify-center gap-1.5 py-[6px] rounded-lg text-[11px] font-semibold transition-all hover:brightness-110"
              style={{ background: 'rgba(79,156,249,0.1)', color: '#4f9cf9', border: '1px solid rgba(79,156,249,0.2)' }}>
              <Play size={12} fill="#4f9cf9" /> Start Focus
            </button>

            {/* Week stats */}
            {stats && stats.weekTotalMinutes > 0 && (
              <div className="flex items-center justify-center gap-3">
                <span className="flex items-center gap-1 text-[9px]" style={{ color: isDark ? '#444' : '#aaa' }}>
                  <Clock size={9} /> Week: {stats.weekTotalMinutes}m
                </span>
                <span className="flex items-center gap-1 text-[9px]" style={{ color: isDark ? '#444' : '#aaa' }}>
                  <RotateCcw size={9} /> {stats.weekSessions} sessions
                </span>
              </div>
            )}
          </div>
        )}
      </div>
    </>
  );

  if (embedded) return innerContent;

  return (
    <div className="rounded-xl overflow-hidden"
         style={{
           background: isDark ? '#1c1c1c' : '#fff',
           border: `1px solid ${isDark ? '#272727' : '#e0e0e0'}`
         }}>
      {innerContent}
    </div>
  );
}
