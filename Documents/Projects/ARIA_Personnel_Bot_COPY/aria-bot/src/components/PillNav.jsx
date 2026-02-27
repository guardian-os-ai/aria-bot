import React, { useRef, useState, useEffect, useLayoutEffect } from 'react';
import { useTheme } from '../context/ThemeContext';

export default function PillNav({ panels, active, onChange }) {
  const { theme } = useTheme();
  const isDark = theme === 'dark';
  const navRef = useRef(null);
  const [indicator, setIndicator] = useState({ left: 0, width: 0 });

  // Calculate sliding indicator position
  useLayoutEffect(() => {
    if (!navRef.current) return;
    const activeBtn = navRef.current.querySelector(`[data-panel="${active}"]`);
    if (activeBtn) {
      const navRect = navRef.current.getBoundingClientRect();
      const btnRect = activeBtn.getBoundingClientRect();
      setIndicator({
        left: btnRect.left - navRect.left + navRef.current.scrollLeft,
        width: btnRect.width
      });
    }
  }, [active]);

  return (
    <div
      ref={navRef}
      className="relative flex shrink-0"
      style={{
        borderBottom: `1px solid ${isDark ? '#2a2a2a' : '#d0d0d0'}`,
        background: isDark ? '#1a1a1a' : '#efefef',
        padding: '0 6px',
      }}
    >
      {/* Sliding glow indicator */}
      <div
        className="absolute bottom-0 h-[2px] rounded-full"
        style={{
          left: indicator.left,
          width: indicator.width,
          background: '#4f9cf9',
          boxShadow: '0 0 8px rgba(79,156,249,0.5)',
          transition: 'left 0.3s cubic-bezier(0.4, 0, 0.2, 1), width 0.25s cubic-bezier(0.4, 0, 0.2, 1)',
          zIndex: 2,
        }}
      />

      {panels.map((panel) => {
        const isActive = active === panel.id;
        return (
          <button
            key={panel.id}
            data-panel={panel.id}
            onClick={() => onChange(panel.id)}
            className="relative flex-1 min-w-0 cursor-pointer select-none"
            style={{
              padding: '8px 2px 10px',
              fontSize: '11px',
              fontWeight: isActive ? 600 : 500,
              letterSpacing: '0.02em',
              whiteSpace: 'nowrap',
              textAlign: 'center',
              color: isActive ? '#4f9cf9' : isDark ? '#666' : '#888',
              background: 'transparent',
              border: 'none',
              outline: 'none',
              transition: 'color 0.25s ease, transform 0.15s ease',
              transform: isActive ? 'scale(1.02)' : 'scale(1)',
            }}
          >
            {panel.label}
          </button>
        );
      })}
    </div>
  );
}
