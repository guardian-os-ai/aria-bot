import React, { useState } from 'react';
import { Check, X, Loader2 } from 'lucide-react';

/**
 * ConfirmAction — Commander Model confirmation card.
 *
 * When ARIA proposes an action (reminder, email archive, subscription cancel, etc.),
 * this component renders a confirmation card inline in the Ask panel.
 *
 * Props:
 *   action  — { type, label, description, icon?, payload }
 *   onConfirm(payload) — called when user approves
 *   onDismiss()        — called when user rejects
 */
export default function ConfirmAction({ action, onConfirm, onDismiss }) {
  const [loading, setLoading] = useState(false);
  const [result, setResult]   = useState(null); // 'done' | 'error'

  if (!action) return null;

  const handleConfirm = async () => {
    setLoading(true);
    try {
      await onConfirm(action.payload);
      setResult('done');
      setTimeout(() => onDismiss(), 1200); // auto-dismiss after success
    } catch (err) {
      setResult('error');
      setTimeout(() => { setResult(null); setLoading(false); }, 2000);
    }
  };

  const iconMap = {
    reminder: '⏰',
    email:    '✉️',
    task:     '✅',
    money:    '💳',
    note:     '📝',
    calendar: '📅',
    weather:  '🌤️',
    habit:    '💪',
    default:  '⚡',
  };

  const icon = action.icon || iconMap[action.type] || iconMap.default;

  return (
    <div className="confirm-action mx-3 my-2 rounded-xl border
                    bg-[var(--confirm-bg,rgba(79,156,249,0.06))]
                    border-[var(--confirm-border,rgba(79,156,249,0.2))]
                    overflow-hidden transition-all duration-300">

      {/* Header */}
      <div className="flex items-center gap-2 px-3 py-2 border-b
                      border-[var(--confirm-border,rgba(79,156,249,0.15))]">
        <span className="text-base">{icon}</span>
        <span className="text-[12px] font-semibold text-[var(--text-primary)]">
          {action.label || 'Confirm action'}
        </span>
      </div>

      {/* Description */}
      {action.description && (
        <div className="px-3 py-2 text-[11px] text-[var(--text-secondary)]">
          {action.description}
        </div>
      )}

      {/* Action buttons */}
      <div className="flex items-center gap-2 px-3 py-2">
        {result === 'done' ? (
          <span className="text-[11px] text-green-400 font-medium flex items-center gap-1">
            <Check size={12} /> Done
          </span>
        ) : result === 'error' ? (
          <span className="text-[11px] text-red-400 font-medium">Failed — try again</span>
        ) : (
          <>
            <button
              onClick={handleConfirm}
              disabled={loading}
              className="flex items-center gap-1 px-3 py-1 rounded-lg text-[11px] font-medium
                         bg-[#4f9cf9] text-white hover:bg-[#3d8ae6] transition-colors
                         disabled:opacity-50 disabled:cursor-wait"
            >
              {loading ? <Loader2 size={11} className="animate-spin" /> : <Check size={11} />}
              {loading ? 'Working...' : 'Do it'}
            </button>
            <button
              onClick={onDismiss}
              disabled={loading}
              className="flex items-center gap-1 px-3 py-1 rounded-lg text-[11px]
                         text-[var(--text-secondary)] hover:text-[var(--text-primary)]
                         hover:bg-[var(--hover-bg,rgba(255,255,255,0.05))] transition-colors"
            >
              <X size={11} /> Nah
            </button>
          </>
        )}
      </div>
    </div>
  );
}
