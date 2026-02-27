import React, { useState, useEffect, useCallback } from 'react';
import { Calendar, Clock, MapPin, Mail, CheckSquare, Zap, ChevronDown, ChevronUp } from 'lucide-react';

/**
 * CalendarIntel — Calendar Intelligence card for Today panel.
 * Shows meeting preps, gaps, and suggestions.
 */
export default function CalendarIntel({ isDark }) {
  const [intel, setIntel] = useState(null);
  const [loading, setLoading] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [expandedEvent, setExpandedEvent] = useState(null);

  const fetchIntel = useCallback(async () => {
    if (intel && !intel.error) { setExpanded(e => !e); return; }
    setLoading(true);
    try {
      const data = await window.aria?.getCalendarIntelligence();
      if (data) setIntel(data);
      setExpanded(true);
    } catch (_) {}
    setLoading(false);
  }, [intel]);

  // No events — don't render
  if (intel && intel.totalMeetings === 0 && !loading) {
    return null;
  }

  return (
    <div className="rounded-xl overflow-hidden"
         style={{
           background: isDark ? '#1c1c1c' : '#fff',
           border: `1px solid ${isDark ? '#272727' : '#e0e0e0'}`
         }}>
      {/* Header */}
      <button
        onClick={fetchIntel}
        className="w-full flex items-center justify-between px-3 py-1.5"
        style={{
          background: isDark ? 'rgba(79,156,249,0.04)' : 'rgba(79,156,249,0.05)',
          borderBottom: expanded ? `1px solid ${isDark ? '#232323' : '#eee'}` : 'none'
        }}>
        <span className="text-[9px] font-mono font-semibold tracking-widest uppercase flex items-center gap-1.5"
              style={{ color: '#4f9cf9' }}>
          <Calendar size={10} /> Calendar Intel
        </span>
        <span style={{ color: isDark ? '#444' : '#aaa' }}>
          {loading ? (
            <div className="w-3 h-3 rounded-full border border-[#4f9cf9] border-t-transparent animate-spin" />
          ) : expanded ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
        </span>
      </button>

      {expanded && intel && (
        <div className="px-3 py-2 space-y-2">
          {/* Quick stats row */}
          <div className="flex items-center gap-3 text-[10px]">
            <span style={{ color: isDark ? '#888' : '#6b7280' }}>
              📅 {intel.totalMeetings} meeting{intel.totalMeetings !== 1 ? 's' : ''}
            </span>
            <span style={{ color: isDark ? '#888' : '#6b7280' }}>
              🆓 {intel.totalFreeMinutes}m free
            </span>
            <span style={{ color: intel.busyPercent > 70 ? '#ef4444' : '#22c55e' }}>
              {intel.busyPercent}% busy
            </span>
          </div>

          {/* Next event alert */}
          {intel.nextEvent && intel.nextEvent.startsIn <= 30 && (
            <div className="rounded-lg px-2.5 py-1.5"
                 style={{
                   background: intel.nextEvent.startsIn <= 10
                     ? 'rgba(239,68,68,0.06)' : 'rgba(249,115,22,0.06)',
                   border: `1px solid ${intel.nextEvent.startsIn <= 10
                     ? 'rgba(239,68,68,0.15)' : 'rgba(249,115,22,0.15)'}`
                 }}>
              <div className="text-[10px] font-semibold"
                   style={{ color: intel.nextEvent.startsIn <= 10 ? '#ef4444' : '#f97316' }}>
                ⏰ {intel.nextEvent.title} starts in {intel.nextEvent.startsIn}m
              </div>
              {intel.nextEvent.location && (
                <div className="text-[9px] flex items-center gap-1 mt-0.5"
                     style={{ color: isDark ? '#666' : '#9ca3af' }}>
                  <MapPin size={8} /> {intel.nextEvent.location}
                </div>
              )}
            </div>
          )}

          {/* Meeting preps */}
          {intel.events?.map((event, i) => (
            <div key={i} className="rounded-lg overflow-hidden"
                 style={{
                   border: `1px solid ${isDark ? '#252525' : '#e8e8e8'}`,
                   background: isDark ? 'rgba(255,255,255,0.01)' : 'rgba(0,0,0,0.01)'
                 }}>
              <button
                className="w-full flex items-center gap-2 px-2.5 py-1.5 text-left"
                onClick={() => setExpandedEvent(expandedEvent === i ? null : i)}>
                <span className="text-[10px] font-mono shrink-0"
                      style={{ color: isDark ? '#555' : '#9ca3af' }}>
                  {event.startTime}
                </span>
                <span className="text-[11px] flex-1 truncate"
                      style={{ color: isDark ? '#c0c0c0' : '#374151' }}>
                  {event.title}
                </span>
                <span className="text-[9px] shrink-0"
                      style={{ color: isDark ? '#444' : '#bbb' }}>
                  {event.durationMinutes}m
                </span>
              </button>

              {expandedEvent === i && (
                <div className="px-2.5 pb-2 space-y-1.5"
                     style={{ borderTop: `1px solid ${isDark ? '#252525' : '#f0f0f0'}` }}>
                  {event.location && (
                    <div className="text-[9px] flex items-center gap-1 pt-1"
                         style={{ color: isDark ? '#666' : '#9ca3af' }}>
                      <MapPin size={8} /> {event.location}
                    </div>
                  )}

                  {/* Related emails */}
                  {event.relatedEmails?.length > 0 && (
                    <div>
                      <div className="text-[8px] uppercase tracking-wider font-semibold"
                           style={{ color: isDark ? '#444' : '#bbb' }}>
                        Related Emails
                      </div>
                      {event.relatedEmails.map((email, j) => (
                        <div key={j} className="text-[9px] truncate flex items-center gap-1"
                             style={{ color: isDark ? '#888' : '#6b7280' }}>
                          <Mail size={8} className="shrink-0" />
                          {email.from}: {email.subject}
                        </div>
                      ))}
                    </div>
                  )}

                  {/* Related tasks */}
                  {event.relatedTasks?.length > 0 && (
                    <div>
                      <div className="text-[8px] uppercase tracking-wider font-semibold"
                           style={{ color: isDark ? '#444' : '#bbb' }}>
                        Related Tasks
                      </div>
                      {event.relatedTasks.map((task, j) => (
                        <div key={j} className="text-[9px] truncate flex items-center gap-1"
                             style={{ color: task.completed ? '#22c55e' : (isDark ? '#888' : '#6b7280') }}>
                          <CheckSquare size={8} className="shrink-0" />
                          {task.completed ? '✓' : '○'} {task.title}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          ))}

          {/* Suggestions */}
          {intel.suggestions?.length > 0 && (
            <div>
              <div className="text-[8px] uppercase tracking-wider font-semibold mb-1"
                   style={{ color: isDark ? '#444' : '#bbb' }}>
                <Zap size={8} className="inline mr-1" />
                Suggestions
              </div>
              {intel.suggestions.map((s, i) => (
                <div key={i} className="text-[9.5px] py-0.5"
                     style={{ color: isDark ? '#888' : '#6b7280' }}>
                  {s.type === 'focus' ? '🎯' : s.type === 'task' ? '📋' : '☕'} {s.text}
                </div>
              ))}
            </div>
          )}

          {/* Free gaps */}
          {intel.gaps?.length > 0 && (
            <div className="flex flex-wrap gap-1">
              {intel.gaps.map((g, i) => (
                <span key={i} className="text-[9px] px-1.5 py-0.5 rounded-full"
                      style={{
                        background: isDark ? 'rgba(34,197,94,0.06)' : 'rgba(34,197,94,0.08)',
                        border: '1px solid rgba(34,197,94,0.15)',
                        color: '#22c55e'
                      }}>
                  🆓 {g.startTime}–{g.endTime} ({g.minutes}m)
                </span>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
