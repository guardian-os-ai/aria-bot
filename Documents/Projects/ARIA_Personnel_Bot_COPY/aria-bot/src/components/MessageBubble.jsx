import React from 'react';
import { useTheme } from '../context/ThemeContext';

/**
 * MessageBubble — renders a single chat message (bot or user).
 * Bot messages: parse [ACTION] [FYI] [RISK] [STATUS] tags into styled badges.
 * Reasoning lines ("→ ...") rendered in muted style.
 */

const TAG_STYLES = {
  ACTION: { color: '#f97316', bg: 'rgba(249,115,22,0.12)', label: 'ACTION' },
  FYI:    { color: '#4f9cf9', bg: 'rgba(79,156,249,0.12)', label: 'FYI' },
  RISK:   { color: '#ef4444', bg: 'rgba(239,68,68,0.12)', label: 'RISK' },
  STATUS: { color: '#22c55e', bg: 'rgba(34,197,94,0.12)', label: 'STATUS' },
};

function parseMessageContent(text, isDark) {
  if (!text) return null;

  // Check for classification tag at start: [ACTION], [FYI], [RISK], [STATUS]
  const tagMatch = text.match(/^\[(ACTION|FYI|RISK|STATUS)\]\s*/i);
  let tag = null;
  let body = text;

  if (tagMatch) {
    const tagKey = tagMatch[1].toUpperCase();
    tag = TAG_STYLES[tagKey] || null;
    body = text.slice(tagMatch[0].length);
  }

  // Split into lines, style reasoning lines differently
  const lines = body.split('\n');
  const elements = [];

  if (tag) {
    elements.push(
      <span key="tag" style={{
        display: 'inline-block',
        fontSize: '9px',
        fontWeight: 700,
        padding: '1px 6px',
        borderRadius: '3px',
        color: tag.color,
        background: tag.bg,
        marginBottom: '4px',
        letterSpacing: '0.5px'
      }}>
        {tag.label}
      </span>
    );
  }

  lines.forEach((line, i) => {
    if (i > 0) elements.push(<br key={`br-${i}`} />);
    const trimmed = line.trim();

    if (trimmed.startsWith('→')) {
      // Reasoning line — muted, smaller
      elements.push(
        <span key={`line-${i}`} style={{
          color: isDark ? '#666' : '#9ca3af',
          fontSize: '11px',
          display: 'block',
          marginTop: '2px'
        }}>
          {trimmed}
        </span>
      );
    } else {
      elements.push(<span key={`line-${i}`}>{line}</span>);
    }
  });

  return elements;
}

export default function MessageBubble({ role, text, timestamp, isStreaming, children }) {
  const { theme } = useTheme();
  const isDark = theme === 'dark';
  const isUser = role === 'user';
  const time = timestamp || new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });

  return (
    <div className={`flex gap-2 items-start ${isUser ? 'flex-row-reverse' : ''}`}>
      {/* Bot avatar */}
      {!isUser && (
        <div
          className="w-7 h-7 rounded-full flex items-center justify-center text-[13px] shrink-0 mt-0.5"
          style={{
            background: 'linear-gradient(135deg, #1d4ed8, #7c3aed)',
            border: '1.5px solid rgba(79,156,249,0.25)'
          }}
        >
          🤖
        </div>
      )}

      {/* Message content */}
      <div className={`max-w-[88%] flex flex-col gap-0.5 ${isUser ? 'items-end' : ''}`}>
        {/* Text bubble */}
        {text && (
          <div
            className={`px-3 py-2 text-[12.5px] leading-relaxed border ${
              isUser
                ? 'rounded-[12px_3px_12px_12px]'
                : 'rounded-[3px_12px_12px_12px]'
            }`}
            style={{
              background: isUser
                ? (isDark ? '#1d3a6e' : '#dbeafe')
                : (isDark ? '#1e1e1e' : '#ffffff'),
              borderColor: isUser
                ? (isDark ? '#1e4080' : '#93c5fd')
                : (isDark ? '#2a2a2a' : '#dedede'),
              color: isUser
                ? (isDark ? '#e0eaff' : '#1e3a8a')
                : (isDark ? '#c8c8c8' : '#1f2937')
            }}
          >
            {isUser
              ? <span dangerouslySetInnerHTML={{ __html: text.replace(/\n/g, '<br/>') }} />
              : parseMessageContent(text, isDark)
            }
            {isStreaming && (
              <span
                style={{
                  display: 'inline-block',
                  width: '2px',
                  height: '13px',
                  background: 'currentColor',
                  marginLeft: '2px',
                  verticalAlign: 'text-bottom',
                  animation: 'aria-blink 0.7s step-end infinite',
                  opacity: 1
                }}
              />
            )}
          </div>
        )}

        {/* Embedded content (cards, etc.) */}
        {children}

        {/* Timestamp */}
        <span className={`text-[9.5px] px-1 ${isUser ? 'text-right' : ''}`} style={{ color: isDark ? '#555555' : '#6b7280' }}>
          {time}
        </span>
      </div>
    </div>
  );
}

/**
 * TypingIndicator — three animated dots in a bot bubble
 */
export function TypingIndicator() {
  const { theme } = useTheme();
  const isDark = theme === 'dark';

  return (
    <div className="flex gap-2 items-start">
      <div
        className="w-7 h-7 rounded-full flex items-center justify-center text-[13px] shrink-0 mt-0.5"
        style={{
          background: 'linear-gradient(135deg, #1d4ed8, #7c3aed)',
          border: '1.5px solid rgba(79,156,249,0.25)'
        }}
      >
        🤖
      </div>
      <div
        className="flex gap-1 items-center px-3 py-2.5 rounded-[3px_12px_12px_12px] w-fit border"
        style={{
          background: isDark ? '#1e1e1e' : '#ffffff',
          borderColor: isDark ? '#2a2a2a' : '#dedede'
        }}
      >
        <div className="w-1.5 h-1.5 rounded-full typing-dot" style={{ background: isDark ? '#555555' : '#9ca3af' }} />
        <div className="w-1.5 h-1.5 rounded-full typing-dot" style={{ background: isDark ? '#555555' : '#9ca3af' }} />
        <div className="w-1.5 h-1.5 rounded-full typing-dot" style={{ background: isDark ? '#555555' : '#9ca3af' }} />
      </div>
    </div>
  );
}
