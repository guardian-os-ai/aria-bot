import React, { useRef, useEffect } from 'react';
import MessageBubble, { TypingIndicator } from './MessageBubble';

/**
 * ChatArea — scrollable message list with auto-scroll on new messages.
 * Props:
 * - messages: array of { id, role, text, timestamp, embed }
 * - isTyping: boolean — show typing indicator
 * - children: additional content to render (panels inject cards here)
 */
export default function ChatArea({ messages = [], isTyping = false, children }) {
  const bottomRef = useRef(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, isTyping]);

  return (
    <div className="flex-1 overflow-y-auto px-2.5 py-3 flex flex-col gap-3">
      {/* Panel-specific content */}
      {children}

      {/* Chat messages */}
      {messages.map((msg) => (
        <MessageBubble
          key={msg.id}
          role={msg.role}
          text={msg.text}
          timestamp={msg.timestamp}
          isStreaming={msg.isStreaming}
        >
          {msg.embed}
        </MessageBubble>
      ))}

      {/* Typing indicator */}
      {isTyping && <TypingIndicator />}

      {/* Auto-scroll anchor */}
      <div ref={bottomRef} />
    </div>
  );
}
