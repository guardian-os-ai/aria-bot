import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Send, Trash2, Info, Brain, Zap, BookOpen, Briefcase, User } from 'lucide-react';
import MessageBubble, { TypingIndicator } from '../MessageBubble';
import ConfirmAction from '../ConfirmAction';
import { useTheme } from '../../context/ThemeContext';

/**
 * Ask panel — ARIA Executive Chat
 * Structured, decisive, minimal. Not a ChatGPT clone.
 */

const CHAT_MODES = [
  { key: 'work', label: 'Work', icon: Briefcase, color: '#4f9cf9' },
  { key: 'personal', label: 'Personal', icon: User, color: '#22c55e' },
];

export default function Ask() {
  const { theme } = useTheme();
  const isDark = theme === 'dark';
  const [messages, setMessages] = useState([]);
  const [isTyping, setIsTyping] = useState(false);
  const [usage, setUsage] = useState({ haiku: 0, limit: 20 });
  const [input, setInput] = useState('');
  const [mode, setMode] = useState('work');
  const [suggestions, setSuggestions] = useState([]);
  const [followUps, setFollowUps] = useState([]);
  const [pendingAction, setPendingAction] = useState(null);
  const [showMemory, setShowMemory] = useState(false);
  const [memories, setMemories] = useState([]);
  const bottomRef = useRef(null);
  const inputRef = useRef(null);

  // Load chat history + proactive suggestions on mount
  useEffect(() => {
    const loadHistory = async () => {
      try {
        const history = await window.aria?.getChatHistory();
        if (Array.isArray(history) && history.length > 0) {
          setMessages(history.map(row => ({
            id: `db-${row.id}`,
            role: row.role === 'user' ? 'user' : 'bot',
            text: row.text,
            timestamp: new Date(row.created_at * 1000).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })
          })));
        }
      } catch (_) {}
    };
    const loadSuggestions = async () => {
      try {
        const s = await window.aria?.getProactiveSuggestions();
        if (Array.isArray(s) && s.length > 0) setSuggestions(s);
      } catch (_) {}
    };
    loadHistory();
    loadSuggestions();
  }, []);

  // Fetch usage on message change
  useEffect(() => {
    const fetchUsage = async () => {
      try {
        const data = await window.aria?.getUsage();
        if (data) setUsage(data);
      } catch (_) {}
    };
    fetchUsage();
  }, [messages]);

  // Auto-scroll on new messages
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, isTyping]);

  // Load memories
  const loadMemories = useCallback(async () => {
    try {
      const m = await window.aria?.getMemories();
      setMemories(Array.isArray(m) ? m : []);
    } catch (_) {}
  }, []);

  const handleSend = useCallback(async (text) => {
    const msg = (text || input).trim();
    if (!msg || isTyping) return;

    setInput('');
    setFollowUps([]);
    if (inputRef.current) inputRef.current.style.height = 'auto';

    const userMsg = {
      id: `user-${Date.now()}`,
      role: 'user',
      text: msg,
      timestamp: new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })
    };
    setMessages(prev => [...prev, userMsg]);
    setIsTyping(true);

    try { await window.aria?.saveChatMessage('user', msg); } catch (_) {}

    try {
      // Use enhanced chat with memory + mode + follow-ups
      const response = await window.aria?.chatEnhanced?.(msg, mode)
        || await window.aria?.chat(msg);

      let botText, newFollowUps = [];

      if (typeof response === 'object' && response !== null) {
        botText = response.text || response.error || 'Sorry, I encountered an error.';
        newFollowUps = response.followUps || [];
        // Commander Model: if ARIA proposes an action, show confirmation card
        if (response.proposedAction) {
          setPendingAction(response.proposedAction);
        }
      } else {
        botText = response || "I'm not connected to the AI service. Check your API key in Settings.";
      }

      const botMsg = {
        id: `bot-${Date.now()}`,
        role: 'bot',
        text: botText,
        timestamp: new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })
      };
      setMessages(prev => [...prev, botMsg]);
      setFollowUps(newFollowUps);

      try { await window.aria?.saveChatMessage('bot', botText); } catch (_) {}
    } catch (err) {
      const errorMsg = {
        id: `bot-${Date.now()}`,
        role: 'bot',
        text: `Sorry, something went wrong: ${err.message}`,
        timestamp: new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })
      };
      setMessages(prev => [...prev, errorMsg]);
    } finally {
      setIsTyping(false);
    }
  }, [input, isTyping, mode]);

  const handleKeyDown = useCallback((e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  }, [handleSend]);

  const clearMessages = useCallback(async () => {
    setMessages([]);
    setFollowUps([]);
    try { await window.aria?.clearChatHistory(); } catch (_) {}
  }, []);

  const deleteMemory = useCallback(async (id) => {
    try {
      await window.aria?.deleteMemory(id);
      setMemories(prev => prev.filter(m => m.id !== id));
    } catch (_) {}
  }, []);

  const chips = [
    { label: 'Plan today', text: "Help me plan my top 3 priorities for today." },
    { label: 'Inbox first', text: 'What email should I handle first and why?' },
    { label: 'My spending', text: 'What did I spend this month? Any concerns?' },
    { label: 'Focus stats', text: 'How productive was I this week?' }
  ];

  return (
    <div className="flex-1 flex flex-col min-h-0">

      {/* Mode selector strip */}
      <div className="shrink-0 flex items-center gap-1 px-2.5 py-1.5"
           style={{
             borderBottom: `1px solid ${isDark ? '#2a2a2a' : '#d0d0d0'}`,
             background: isDark ? '#141414' : '#f5f5f5'
           }}>
        {CHAT_MODES.map(m => (
          <button key={m.key}
            onClick={() => setMode(m.key)}
            className="flex items-center gap-1 px-2 py-1 rounded-md text-[10px] font-medium transition-all btn-press"
            style={{
              background: mode === m.key ? `${m.color}15` : 'transparent',
              color: mode === m.key ? m.color : isDark ? '#555' : '#999',
              border: `1px solid ${mode === m.key ? `${m.color}30` : 'transparent'}`
            }}>
            <m.icon size={10} />
            {m.label}
          </button>
        ))}
        <div className="flex-1" />
        <button
          onClick={() => { setShowMemory(!showMemory); if (!showMemory) loadMemories(); }}
          className="flex items-center gap-1 px-2 py-1 rounded-md text-[10px] font-medium btn-press"
          style={{
            background: showMemory ? 'rgba(234,179,8,0.1)' : 'transparent',
            color: showMemory ? '#eab308' : isDark ? '#555' : '#999',
            border: `1px solid ${showMemory ? 'rgba(234,179,8,0.2)' : 'transparent'}`
          }}
          title="AI Memory">
          <Brain size={10} />
        </button>
      </div>

      {/* Memory panel (collapsible) */}
      {showMemory && (
        <div className="shrink-0 px-2.5 py-2 overflow-y-auto"
             style={{
               maxHeight: 100,
               background: isDark ? '#111' : '#fffbeb',
               borderBottom: `1px solid ${isDark ? '#222' : '#fde68a'}`
             }}>
          <div className="text-[9px] font-semibold mb-1.5" style={{ color: '#eab308' }}>
            <Brain size={9} className="inline mr-1" />
            ARIA remembers ({memories.length})
          </div>
          {memories.length === 0 ? (
            <div className="text-[9px]" style={{ color: isDark ? '#555' : '#999' }}>
              Say "Remember that..." to save facts about you.
            </div>
          ) : (
            memories.slice(0, 6).map(m => (
              <div key={m.id} className="flex items-center gap-1.5 py-0.5">
                <span className="text-[9px] flex-1 truncate" style={{ color: isDark ? '#aaa' : '#555' }}>
                  {m.fact}
                </span>
                <button onClick={() => deleteMemory(m.id)}
                  className="shrink-0 text-[8px] px-1 rounded btn-press"
                  style={{ color: '#c06060' }}>
                  ×
                </button>
              </div>
            ))
          )}
        </div>
      )}

      {/* Chat messages — scrollable area */}
      <div className="flex-1 overflow-y-auto px-2.5 py-3 flex flex-col gap-3 smooth-scroll">

        {/* Proactive Suggestions (shown when no messages or as welcome) */}
        {messages.length === 0 && (
          <>
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
              <div className="max-w-[88%] flex flex-col gap-0.5">
                <div
                  className="px-3 py-2 text-[14px] leading-relaxed rounded-[3px_12px_12px_12px]"
                  style={{
                    background: isDark ? '#1e1e1e' : '#ffffff',
                    border: `1px solid ${isDark ? '#2a2a2a' : '#d9d9d9'}`,
                    color: isDark ? '#c8c8c8' : '#2f2f2f'
                  }}
                >
                  What do you need? I have your emails, tasks, finances, and calendar loaded.
                  {suggestions.length > 0 && (
                    <>
                      <br /><br />
                      <span className="text-[11px] font-semibold" style={{ color: '#f97316' }}>
                        Needs your attention:
                      </span>
                    </>
                  )}
                </div>
              </div>
            </div>

            {/* Proactive suggestion cards */}
            {suggestions.length > 0 && (
              <div className="flex flex-col gap-1.5 ml-9">
                {suggestions.map((s, i) => (
                  <button key={i}
                    onClick={() => handleSend(s.text)}
                    className="text-left px-3 py-2 rounded-lg transition-all btn-press"
                    style={{
                      background: isDark ? 'rgba(249,115,22,0.04)' : 'rgba(249,115,22,0.06)',
                      border: `1px solid ${isDark ? 'rgba(249,115,22,0.12)' : 'rgba(249,115,22,0.15)'}`
                    }}>
                    <span className="text-[12px] mr-1.5">{s.icon}</span>
                    <span className="text-[11px]" style={{ color: isDark ? '#ccc' : '#444' }}>
                      {s.text}
                    </span>
                  </button>
                ))}
              </div>
            )}
          </>
        )}

        {/* Message list */}
        {messages.map((msg) => (
          <MessageBubble
            key={msg.id}
            role={msg.role}
            text={msg.text}
            timestamp={msg.timestamp}
          />
        ))}

        {/* Follow-up question suggestions */}
        {followUps.length > 0 && !isTyping && (
          <div className="flex flex-wrap gap-1.5 ml-9">
            {followUps.map((q, i) => (
              <button key={i}
                onClick={() => handleSend(q)}
                className="px-2.5 py-1.5 rounded-lg text-[10px] transition-all btn-press"
                style={{
                  background: isDark ? 'rgba(79,156,249,0.06)' : 'rgba(79,156,249,0.08)',
                  color: '#4f9cf9',
                  border: `1px solid rgba(79,156,249,0.15)`
                }}>
                {q}
              </button>
            ))}
          </div>
        )}

        {/* Commander Model: Confirm Action card */}
        {pendingAction && (
          <ConfirmAction
            action={pendingAction}
            onConfirm={async (payload) => {
              const result = await window.aria?.confirmAction(pendingAction.type, payload);
              if (result?.ok) {
                const confirmMsg = {
                  id: `bot-${Date.now()}`,
                  role: 'bot',
                  text: result.text || '✅ Done!',
                  timestamp: new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })
                };
                setMessages(prev => [...prev, confirmMsg]);
                try { await window.aria?.saveChatMessage('bot', result.text); } catch (_) {}
              } else {
                throw new Error(result?.text || 'Action failed');
              }
            }}
            onDismiss={() => {
              // Learning Loop: record negative feedback for dismissed actions
              try { window.aria?.dismissAction(pendingAction.type, pendingAction.payload); } catch (_) {}
              setPendingAction(null);
            }}
          />
        )}

        {/* Typing indicator */}
        {isTyping && <TypingIndicator />}

        {/* Scroll anchor */}
        <div ref={bottomRef} />
      </div>

      {/* Bottom bar — pinned: usage + chips + input */}
      <div
        className="shrink-0"
        style={{
          borderTop: `1px solid ${isDark ? '#2a2a2a' : '#d0d0d0'}`,
          background: isDark ? '#1a1a1a' : '#efefef'
        }}
      >

        {/* Usage + Clear row */}
        <div className="px-3 py-1.5 flex items-center justify-between">
          <span className="text-[11px] flex items-center gap-1" style={{ color: isDark ? '#666666' : '#6b7280' }}>
            <Info size={11} />
            {usage.haiku}/{usage.limit} AI calls today
          </span>
          {messages.length > 0 && (
            <button
              onClick={clearMessages}
              className="text-[11px] flex items-center gap-1 transition-colors"
              style={{ color: isDark ? '#666666' : '#6b7280' }}
            >
              <Trash2 size={11} /> Clear
            </button>
          )}
        </div>

        {/* Quick chips */}
        <div className="flex gap-1 px-2.5 pb-1.5 overflow-x-auto" style={{ scrollbarWidth: 'none' }}>
          {chips.map((chip, i) => (
            <button
              key={i}
              onClick={() => handleSend(chip.text)}
              className="text-[11px] px-3 py-1 rounded-full cursor-pointer whitespace-nowrap transition-all shrink-0"
              style={{
                border: `1px solid ${isDark ? '#333333' : '#d2d2d2'}`,
                background: isDark ? 'rgba(255,255,255,0.03)' : '#f8f8f8',
                color: isDark ? '#7a7a7a' : '#4b5563'
              }}
            >
              {chip.label}
            </button>
          ))}
        </div>

        {/* Input row */}
        <div className="px-2.5 py-2 flex gap-1.5 items-end">
          <textarea
            ref={inputRef}
            value={input}
            onChange={(e) => {
              setInput(e.target.value);
              e.target.style.height = 'auto';
              e.target.style.height = Math.min(e.target.scrollHeight, 120) + 'px';
            }}
            onKeyDown={handleKeyDown}
            placeholder="Ask ARIA..."
            disabled={isTyping}
            rows={1}
            className="flex-1 rounded-[9px] px-3 py-2 text-[13px] font-sans outline-none resize-none leading-snug disabled:opacity-50"
            style={{
              background: isDark ? '#252525' : '#ffffff',
              border: `1px solid ${isDark ? '#333333' : '#d2d2d2'}`,
              color: isDark ? '#c8c8c8' : '#1f2937',
              maxHeight: '120px'
            }}
          />
          <button
            onClick={() => handleSend()}
            disabled={!input.trim() || isTyping}
            className="w-9 h-9 shrink-0 rounded-[9px] flex items-center justify-center text-white text-sm cursor-pointer transition-all hover:scale-105 hover:brightness-110 disabled:opacity-40 disabled:cursor-not-allowed"
            style={{
              background: 'linear-gradient(135deg, #1d4ed8, #7c3aed)',
              boxShadow: '0 2px 12px rgba(79,156,249,0.25)'
            }}
          >
            <Send size={14} />
          </button>
        </div>
      </div>
    </div>
  );
}
