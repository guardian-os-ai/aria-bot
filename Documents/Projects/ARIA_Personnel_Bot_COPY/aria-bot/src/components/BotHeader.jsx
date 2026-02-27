import React, { useState, useEffect } from 'react';
import { Moon, Settings, Sun } from 'lucide-react';

export default function BotHeader({ onSettingsClick, onThemeToggle, theme = 'dark' }) {
  const isDark = theme === 'dark';
  const [ollamaStatus, setOllamaStatus] = useState('checking'); // 'online' | 'offline' | 'checking'

  useEffect(() => {
    const check = async () => {
      try {
        const res = await window.aria?.checkOllama?.();
        setOllamaStatus(res?.online ? 'online' : 'offline');
      } catch { setOllamaStatus('offline'); }
    };
    check();
    const interval = setInterval(check, 60_000); // re-check every minute
    return () => clearInterval(interval);
  }, []);

  return (
    <div
      className="px-3.5 py-3 flex items-center gap-2.5 shrink-0"
      style={{
        borderBottom: `1px solid ${isDark ? '#2a2a2a' : '#d0d0d0'}`,
        background: isDark
          ? 'linear-gradient(160deg, #1a1a1a 0%, #161616 100%)'
          : 'linear-gradient(160deg, #f4f4f4 0%, #ebebeb 100%)'
      }}
    >
      {/* Avatar */}
      <div className="relative w-10 h-10 rounded-full flex items-center justify-center text-lg shrink-0"
           style={{
             background: 'linear-gradient(135deg, #1d4ed8, #7c3aed)',
             border: '2px solid rgba(79,156,249,0.35)',
             boxShadow: '0 0 18px rgba(79,156,249,0.2)'
           }}>
        🤖
        {/* Online dot */}
        <div
          className="absolute bottom-[1px] right-[1px] w-2.5 h-2.5 rounded-full bg-[#22c55e] animate-pulse-dot"
          style={{
            border: '2px solid #161616',
            boxShadow: '0 0 6px rgba(34,197,94,0.6)'
          }}
        />
      </div>

      {/* Name + subtitle */}
      <div className="flex-1 min-w-0">
        <div className="text-[15px] font-bold tracking-tight flex items-center gap-1.5" style={{ color: isDark ? '#f0f0f0' : '#1a1a1a' }}>
          ARIA
          {/* Ollama status dot */}
          <span
            className="text-[8px] px-1.5 py-0.5 rounded-full font-mono"
            style={{
              background: ollamaStatus === 'online' ? 'rgba(34,197,94,0.12)' : 'rgba(239,68,68,0.08)',
              color: ollamaStatus === 'online' ? '#22c55e' : ollamaStatus === 'checking' ? '#eab308' : '#ef4444',
              border: `1px solid ${ollamaStatus === 'online' ? 'rgba(34,197,94,0.2)' : 'rgba(239,68,68,0.15)'}`
            }}
            title={ollamaStatus === 'online' ? 'Ollama is running locally' : 'Ollama offline — using cloud AI'}
          >
            {ollamaStatus === 'online' ? '🟢 Local' : ollamaStatus === 'checking' ? '⏳' : '☁️ Cloud'}
          </span>
        </div>
        <div className="font-mono text-[11px] mt-0.5 flex items-center gap-1.5 truncate" style={{ color: isDark ? '#555555' : '#666666' }}>
          <span
            className="w-[5px] h-[5px] rounded-full bg-[#22c55e] animate-pulse-dot"
            style={{ boxShadow: '0 0 5px #22c55e' }}
          />
          Watching everything so you don't have to
        </div>
      </div>

      <div className="flex items-center gap-1">
        <button
          onClick={onThemeToggle}
          className="w-7 h-7 rounded-lg flex items-center justify-center transition-all"
          style={{
            color: isDark ? '#555555' : '#666666',
            background: isDark ? 'rgba(255,255,255,0.04)' : 'rgba(0,0,0,0.03)',
            border: `1px solid ${isDark ? '#2a2a2a' : '#d0d0d0'}`
          }}
          title={isDark ? 'Switch to Light Mode' : 'Switch to Dark Mode'}
        >
          {isDark ? <Sun size={13} /> : <Moon size={13} />}
        </button>

        <button
          onClick={onSettingsClick}
          className="w-7 h-7 rounded-lg flex items-center justify-center transition-all"
          style={{
            color: isDark ? '#555555' : '#666666',
            background: isDark ? 'rgba(255,255,255,0.04)' : 'rgba(0,0,0,0.03)',
            border: `1px solid ${isDark ? '#2a2a2a' : '#d0d0d0'}`
          }}
          title="Settings"
        >
          <Settings size={13} />
        </button>
      </div>
    </div>
  );
}
