import React, { useState, useRef, useCallback } from 'react';
import { Send } from 'lucide-react';
import { useTheme } from '../context/ThemeContext';

/**
 * InputBar — chat input with send button and quick chips.
 * Adapts behavior based on active panel:
 *   - 'ask': sends to ARIA chat
 *   - 'remind': creates a reminder from natural language
 */

const QUICK_CHIPS = {
  ask: [
    { label: '📅 My day', text: "What's my day look like?" },
    { label: '🔴 Urgent mail', text: 'Show urgent emails' },
    { label: '🌤 Weather', text: "What's the weather?" },
    { label: '📝 Notes', text: 'Show my recent notes' }
  ],
  remind: [
    { label: '⏰ In 1 hour', text: 'Remind me in 1 hour to ' },
    { label: '🌅 Tomorrow 9am', text: 'Remind me tomorrow at 9am to ' },
    { label: '📅 Next Monday', text: 'Remind me next Monday to ' },
    { label: '🔁 Every day', text: 'Remind me every day at 9am to ' }
  ]
};

export default function InputBar({ activePanel, onSend }) {
  const { theme } = useTheme();
  const isDark = theme === 'dark';
  const [text, setText] = useState('');
  const [loading, setLoading] = useState(false);
  const textareaRef = useRef(null);

  const chips = QUICK_CHIPS[activePanel] || QUICK_CHIPS.ask;

  const handleSend = useCallback(async () => {
    const message = text.trim();
    if (!message || loading) return;

    setLoading(true);
    setText('');

    try {
      if (onSend) {
        await onSend(message);
      } else if (activePanel === 'remind') {
        // Add reminder via IPC
        await window.aria?.addReminder(message);
      } else {
        // Chat via IPC
        await window.aria?.chat(message);
      }
    } catch (err) {
      console.error('[InputBar] Send error:', err);
    } finally {
      setLoading(false);
    }

    // Refocus textarea
    textareaRef.current?.focus();
  }, [text, loading, activePanel, onSend]);

  const handleKeyDown = useCallback((e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  }, [handleSend]);

  const handleChipClick = useCallback((chipText) => {
    setText(chipText);
    textareaRef.current?.focus();
  }, []);

  // Auto-resize textarea
  const handleInput = useCallback((e) => {
    const ta = e.target;
    ta.style.height = 'auto';
    ta.style.height = Math.min(ta.scrollHeight, 70) + 'px';
    setText(ta.value);
  }, []);

  const placeholder = activePanel === 'remind'
    ? 'Add a reminder... "Call mom tomorrow at 3pm"'
    : 'Ask ARIA anything...';

  return (
    <div className="shrink-0">
      {/* Quick chips */}
      <div
        className="flex gap-1 overflow-x-auto px-2 pt-1.5 pb-0"
        style={{ scrollbarWidth: 'none', msOverflowStyle: 'none' }}
      >
        {chips.map((chip, i) => (
          <button
            key={i}
            onClick={() => handleChipClick(chip.text)}
            className="text-[11px] px-2.5 py-1 rounded-full border cursor-pointer whitespace-nowrap transition-all"
            style={{
              borderColor: isDark ? '#333333' : '#d2d2d2',
              background: isDark ? 'rgba(255,255,255,0.03)' : '#f8f8f8',
              color: isDark ? '#555555' : '#6b7280'
            }}
          >
            {chip.label}
          </button>
        ))}
      </div>

      {/* Input row */}
      <div
        className="px-2 py-2 flex gap-1.5 items-end"
        style={{
          borderTop: `1px solid ${isDark ? '#2a2a2a' : '#d0d0d0'}`,
          background: isDark ? '#1a1a1a' : '#efefef'
        }}
      >
        <textarea
          ref={textareaRef}
          value={text}
          onChange={handleInput}
          onKeyDown={handleKeyDown}
          placeholder={placeholder}
          disabled={loading}
          rows={1}
          className="flex-1 rounded-[9px] px-3 py-2 text-[13px] font-sans outline-none resize-none leading-snug max-h-[70px] disabled:opacity-50"
          style={{
            background: isDark ? '#252525' : '#ffffff',
            border: `1px solid ${isDark ? '#333333' : '#d2d2d2'}`,
            color: isDark ? '#c8c8c8' : '#1f2937'
          }}
        />
        <button
          onClick={handleSend}
          disabled={!text.trim() || loading}
          className="w-[34px] h-[34px] shrink-0 rounded-[9px] flex items-center justify-center text-white text-sm cursor-pointer transition-all hover:scale-105 hover:brightness-110 disabled:opacity-40 disabled:cursor-not-allowed"
          style={{
            background: 'linear-gradient(135deg, #1d4ed8, #7c3aed)',
            boxShadow: '0 2px 12px rgba(79,156,249,0.25)'
          }}
        >
          <Send size={14} />
        </button>
      </div>
    </div>
  );
}
