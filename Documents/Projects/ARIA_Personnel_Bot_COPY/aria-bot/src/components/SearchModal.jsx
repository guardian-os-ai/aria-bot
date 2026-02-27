import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Search, X, Clock, Mail, StickyNote, ArrowRight } from 'lucide-react';
import { useTheme } from '../context/ThemeContext';

/**
 * SearchModal — Ctrl+K spotlight search across reminders, emails, notes.
 */
export default function SearchModal({ open, onClose, onNavigate }) {
  const { theme } = useTheme();
  const isDark = theme === 'dark';
  const [query, setQuery] = useState('');
  const [results, setResults] = useState([]);
  const [loading, setLoading] = useState(false);
  const inputRef = useRef(null);

  useEffect(() => {
    if (open) {
      setQuery('');
      setResults([]);
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [open]);

  const doSearch = useCallback(async (q) => {
    if (!q.trim()) { setResults([]); return; }
    setLoading(true);
    const merged = [];

    try {
      // Search reminders
      const reminders = await window.aria?.getReminders();
      if (Array.isArray(reminders)) {
        reminders.filter(r => r.title?.toLowerCase().includes(q.toLowerCase()))
          .slice(0, 5)
          .forEach(r => merged.push({ type: 'reminder', title: r.title, id: r.id, panel: 'remind' }));
      }
    } catch (_) {}

    try {
      // Search notes
      const notes = await window.aria?.getNotes();
      if (Array.isArray(notes)) {
        notes.filter(n => n.content?.toLowerCase().includes(q.toLowerCase()))
          .slice(0, 5)
          .forEach(n => merged.push({ type: 'note', title: n.content.substring(0, 80), id: n.id, panel: 'notes' }));
      }
    } catch (_) {}

    try {
      // Search emails (cached)
      const mailData = await window.aria?.getEmails();
      if (mailData?.emails && Array.isArray(mailData.emails)) {
        mailData.emails.filter(e =>
          e.subject?.toLowerCase().includes(q.toLowerCase()) ||
          e.from_name?.toLowerCase().includes(q.toLowerCase())
        ).slice(0, 5)
          .forEach(e => merged.push({ type: 'email', title: `${e.from_name}: ${e.subject}`, id: e.message_id, panel: 'mail' }));
      }
    } catch (_) {}

    setResults(merged);
    setLoading(false);
  }, []);

  useEffect(() => {
    const timer = setTimeout(() => doSearch(query), 200);
    return () => clearTimeout(timer);
  }, [query, doSearch]);

  const handleSelect = (item) => {
    onNavigate(item.panel);
    onClose();
  };

  // Close on Escape
  useEffect(() => {
    const handler = (e) => {
      if (e.key === 'Escape' && open) onClose();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [open, onClose]);

  if (!open) return null;

  const iconMap = {
    reminder: <Clock size={12} style={{ color: '#4f9cf9' }} />,
    note: <StickyNote size={12} style={{ color: '#a78bfa' }} />,
    email: <Mail size={12} style={{ color: '#f97316' }} />
  };

  return (
    <div className="absolute inset-0 z-[100] flex items-start justify-center pt-12 anim-fade"
         style={{ background: 'rgba(0,0,0,0.5)', backdropFilter: 'blur(6px)' }}
         onClick={onClose}>
      <div className="w-[300px] rounded-xl overflow-hidden shadow-2xl anim-pop"
           style={{ background: isDark ? '#1e1e1e' : '#ffffff', border: `1px solid ${isDark ? '#333' : '#d0d0d0'}` }}
           onClick={e => e.stopPropagation()}>

        {/* Search input */}
        <div className="flex items-center gap-2 px-3 py-2.5"
             style={{ borderBottom: `1px solid ${isDark ? '#2a2a2a' : '#e5e7eb'}` }}>
          <Search size={14} style={{ color: isDark ? '#555' : '#9ca3af' }} />
          <input
            ref={inputRef}
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder="Search tasks, notes, emails…"
            className="flex-1 text-[12px] outline-none bg-transparent"
            style={{ color: isDark ? '#e0e0e0' : '#1a1a1a' }}
          />
          <button onClick={onClose} className="p-0.5 rounded" style={{ color: isDark ? '#555' : '#9ca3af' }}>
            <X size={12} />
          </button>
        </div>

        {/* Results */}
        <div className="max-h-[240px] overflow-y-auto">
          {loading && (
            <div className="text-center py-4 text-[11px]" style={{ color: isDark ? '#555' : '#999' }}>Searching…</div>
          )}
          {!loading && query && results.length === 0 && (
            <div className="text-center py-4 text-[11px]" style={{ color: isDark ? '#555' : '#999' }}>No results</div>
          )}
          {results.map((item, i) => (
            <button
              key={`${item.type}-${item.id}-${i}`}
              onClick={() => handleSelect(item)}
              className="w-full flex items-center gap-2 px-3 py-2 text-left transition-colors"
              style={{ borderBottom: `1px solid ${isDark ? '#222' : '#f0f0f0'}` }}
              onMouseEnter={e => e.currentTarget.style.background = isDark ? '#252525' : '#f5f5f5'}
              onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
            >
              {iconMap[item.type]}
              <span className="flex-1 text-[11px] truncate" style={{ color: isDark ? '#ccc' : '#333' }}>
                {item.title}
              </span>
              <ArrowRight size={10} style={{ color: isDark ? '#444' : '#bbb' }} />
            </button>
          ))}
        </div>

        {/* Footer hint */}
        <div className="px-3 py-1.5 text-[9px]" style={{ color: isDark ? '#444' : '#bbb', borderTop: `1px solid ${isDark ? '#2a2a2a' : '#e5e7eb'}` }}>
          <kbd className="px-1 py-0.5 rounded text-[8px]" style={{ background: isDark ? '#252525' : '#eee', border: `1px solid ${isDark ? '#333' : '#d0d0d0'}` }}>↵</kbd> to select · <kbd className="px-1 py-0.5 rounded text-[8px]" style={{ background: isDark ? '#252525' : '#eee', border: `1px solid ${isDark ? '#333' : '#d0d0d0'}` }}>Esc</kbd> to close
        </div>
      </div>
    </div>
  );
}
