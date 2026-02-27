import { useState, useCallback, useEffect } from 'react';

/**
 * useChat — Chat message state + send logic for Ask ARIA panel.
 * Persists messages to DB via IPC. Handles action routing responses.
 */
export default function useChat() {
  const [messages, setMessages] = useState([]);
  const [isTyping, setIsTyping] = useState(false);
  const [pendingNav, setPendingNav] = useState(null);

  // Load chat history on mount
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
    loadHistory();
  }, []);

  const sendMessage = useCallback(async (text) => {
    const ts = new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
    const userMsg = {
      id: `user-${Date.now()}`,
      role: 'user',
      text,
      timestamp: ts
    };

    setMessages((prev) => [...prev, userMsg]);
    setIsTyping(true);

    // Save user message to DB
    try { await window.aria?.saveChatMessage('user', text); } catch (_) {}

    // Track which streaming bubble ID was created (if agent streams)
    let streamMsgId = null;

    // Register stream listeners BEFORE invoking chat (chunks may arrive during the await)
    window.aria?.onChatChunkStart?.((data) => {
      streamMsgId = data.streamId;
      setIsTyping(false); // replace typing dots with streaming bubble
      setMessages((prev) => [...prev, {
        id: data.streamId,
        role: 'bot',
        text: '',
        isStreaming: true,
        timestamp: ts
      }]);
    });

    window.aria?.onChatChunk?.((data) => {
      setMessages((prev) => prev.map((m) =>
        m.id === data.streamId ? { ...m, text: (m.text || '') + data.text } : m
      ));
    });

    try {
      let response;
      if (window.aria?.chat) {
        response = await window.aria.chat(text);
      }

      // Clean up stream listeners
      window.aria?.offChatChunk?.();

      let botText;
      let navigate = null;

      if (typeof response === 'object' && response !== null) {
        botText = response.text || response.error || 'Sorry, I encountered an error.';
        navigate = response.navigate || null;
      } else {
        botText = response || "I'm not connected to the AI service. Please check your API key in Settings.";
      }

      const finalStreamId = response?.streamId || streamMsgId;

      if (finalStreamId) {
        // Finalize the streaming bubble: replace text + mark done
        setMessages((prev) => prev.map((m) =>
          m.id === finalStreamId
            ? { ...m, text: botText, isStreaming: false, navigate }
            : m
        ));
      } else {
        // Fast path (greeting / email / weather) — no streaming occurred
        const botMsg = {
          id: `bot-${Date.now()}`,
          role: 'bot',
          text: botText,
          timestamp: ts,
          navigate
        };
        setMessages((prev) => [...prev, botMsg]);
      }

      // Save bot message to DB
      try { await window.aria?.saveChatMessage('bot', botText); } catch (_) {}

      // Set pending navigation
      if (navigate) setPendingNav(navigate);
    } catch (err) {
      window.aria?.offChatChunk?.();
      const errorMsg = {
        id: `bot-${Date.now()}`,
        role: 'bot',
        text: `Sorry, something went wrong: ${err.message}`,
        timestamp: ts
      };
      // If a streaming bubble was started, replace it; otherwise append
      if (streamMsgId) {
        setMessages((prev) => prev.map((m) =>
          m.id === streamMsgId ? { ...m, text: errorMsg.text, isStreaming: false } : m
        ));
      } else {
        setMessages((prev) => [...prev, errorMsg]);
      }
      try { await window.aria?.saveChatMessage('bot', errorMsg.text); } catch (_) {}
    } finally {
      setIsTyping(false);
    }
  }, []);

  const clearMessages = useCallback(async () => {
    setMessages([]);
    try { await window.aria?.clearChatHistory(); } catch (_) {}
  }, []);

  const consumeNav = useCallback(() => {
    const nav = pendingNav;
    setPendingNav(null);
    return nav;
  }, [pendingNav]);

  return { messages, isTyping, sendMessage, clearMessages, pendingNav, consumeNav };
}
