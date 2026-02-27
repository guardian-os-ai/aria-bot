import React from 'react';
import { useTheme } from '../context/ThemeContext';

/**
 * EmbedCard — Rich card embedded inside chat messages.
 * Full light/dark theme support.
 */

const colorMap = {
  blue:   { bg: 'rgba(79,156,249,0.07)',   text: '#4f9cf9', border: 'rgba(79,156,249,0.2)' },
  orange: { bg: 'rgba(249,115,22,0.07)',    text: '#f97316', border: 'rgba(249,115,22,0.2)' },
  green:  { bg: 'rgba(34,197,94,0.07)',     text: '#22c55e', border: 'rgba(34,197,94,0.2)' },
  red:    { bg: 'rgba(239,68,68,0.07)',     text: '#ef4444', border: 'rgba(239,68,68,0.2)' },
  purple: { bg: 'rgba(167,139,250,0.07)',   text: '#a78bfa', border: 'rgba(167,139,250,0.2)' },
  yellow: { bg: 'rgba(234,179,8,0.07)',     text: '#eab308', border: 'rgba(234,179,8,0.2)' }
};

export default function EmbedCard({ headerLabel, headerColor = 'blue', headerIcon, children, actions }) {
  const { theme } = useTheme();
  const isDark = theme === 'dark';
  const colors = colorMap[headerColor] || colorMap.blue;

  return (
    <div className="rounded-[10px] overflow-hidden mt-1.5 anim-card hover-lift"
         style={{
           background: isDark ? '#1e1e1e' : '#ffffff',
           border: `1px solid ${isDark ? '#333' : '#d9d9d9'}`
         }}>
      {/* Header strip */}
      {headerLabel && (
        <div
          className="px-3 py-1.5 font-mono text-[9px] tracking-[0.1em] uppercase font-medium flex items-center gap-1.5"
          style={{
            background: colors.bg,
            color: colors.text,
            borderBottom: `1px solid ${isDark ? '#2a2a2a' : '#e5e7eb'}`
          }}
        >
          {headerIcon && <span>{headerIcon}</span>}
          {headerLabel}
        </div>
      )}

      {/* Body */}
      <div>{children}</div>

      {/* Actions */}
      {actions && actions.length > 0 && (
        <div className="px-2.5 py-1.5 flex gap-1.5"
             style={{ borderTop: `1px solid ${isDark ? '#2a2a2a' : '#e5e7eb'}` }}>
          {actions.map((action, i) => (
            <button
              key={i}
              onClick={action.onClick}
              className={`flex-1 py-1.5 px-2 rounded-md border text-[10px] text-center transition-all font-sans btn-press
                ${action.variant === 'primary'
                  ? 'bg-[rgba(79,156,249,0.12)] border-[rgba(79,156,249,0.3)] text-[#4f9cf9] hover:bg-[rgba(79,156,249,0.2)]'
                  : action.variant === 'danger'
                    ? 'bg-[rgba(239,68,68,0.08)] border-[rgba(239,68,68,0.2)] text-[#ef4444] hover:bg-[rgba(239,68,68,0.15)]'
                    : isDark
                      ? 'bg-[rgba(255,255,255,0.03)] border-[#333] text-[#555] hover:bg-[rgba(79,156,249,0.08)] hover:border-[rgba(79,156,249,0.25)] hover:text-[#4f9cf9]'
                      : 'bg-[rgba(0,0,0,0.02)] border-[#d0d0d0] text-[#6b7280] hover:bg-[rgba(79,156,249,0.08)] hover:border-[rgba(79,156,249,0.25)] hover:text-[#4f9cf9]'
                }`}
            >
              {action.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * Badge component for category indicators
 */
export function Badge({ type, children }) {
  const styles = {
    urgent:  'bg-[rgba(239,68,68,0.12)] text-[#ef4444] border-[rgba(239,68,68,0.2)]',
    action:  'bg-[rgba(79,156,249,0.1)] text-[#4f9cf9] border-[rgba(79,156,249,0.2)]',
    fyi:     'bg-[rgba(167,139,250,0.1)] text-[#a78bfa] border-[rgba(167,139,250,0.2)]',
    done:    'bg-[rgba(34,197,94,0.1)] text-[#22c55e] border-[rgba(34,197,94,0.2)]',
    noise:   'bg-[rgba(255,255,255,0.05)] text-[#555555] border-[rgba(255,255,255,0.1)]',
    warning: 'bg-[rgba(234,179,8,0.1)] text-[#eab308] border-[rgba(234,179,8,0.2)]',
    orange:  'bg-[rgba(249,115,22,0.1)] text-[#f97316] border-[rgba(249,115,22,0.2)]'
  };

  return (
    <span className={`text-[8.5px] px-1.5 py-0.5 rounded-[3px] font-semibold tracking-wider uppercase border ${styles[type] || styles.fyi}`}>
      {children}
    </span>
  );
}
