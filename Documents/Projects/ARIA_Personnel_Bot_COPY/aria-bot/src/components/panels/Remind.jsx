import React, { useState, useEffect, useCallback, useRef } from 'react';
import { Check, Send, RotateCcw, Trash2, Edit3, Save, Archive, Filter, Repeat, ListTree, Plus, ChevronRight, ChevronDown } from 'lucide-react';

/**
 * Tasks panel — Executive redesign + Todoist/Reclaim features.
 * Focus-first · Flat timeline · Recurring · Sub-tasks · Smart filters.
 */

const TASK_FILTERS = [
  { key: 'all',      label: 'All' },
  { key: 'today',    label: 'Today' },
  { key: 'overdue',  label: 'Overdue' },
  { key: 'priority', label: 'Priority' },
];

const RECURRING_LABELS = {
  daily: '🔁 Daily',
  weekly: '🔁 Weekly',
  monthly: '🔁 Monthly',
  weekdays: '🔁 Weekdays',
};

export default function Remind() {
  const [reminders, setReminders]     = useState([]);
  const [loading, setLoading]         = useState(true);
  const [error, setError]             = useState(null);
  const [addingText, setAddingText]   = useState('');
  const [adding, setAdding]           = useState(false);
  const [showArchived, setShowArchived] = useState(false);
  const [archivedTasks, setArchivedTasks] = useState([]);
  const [selectedId, setSelectedId]   = useState(null);
  const [filter, setFilter]           = useState('all');
  const inputRef = useRef(null);

  const fetchReminders = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await window.aria?.getReminders();
      setReminders(Array.isArray(data) ? data : []);
    } catch (err) {
      setError(err.message || 'Failed to load tasks');
    } finally {
      setLoading(false);
    }
  }, []);

  const fetchArchived = useCallback(async () => {
    try {
      const data = await window.aria?.getAllReminders();
      setArchivedTasks((Array.isArray(data) ? data : []).filter(r => r.archived_at || r.completed));
    } catch (_) {}
  }, []);

  useEffect(() => { fetchReminders(); }, [fetchReminders]);

  const handleComplete = useCallback(async (id) => {
    setReminders(prev => prev.map(r => r.id === id ? { ...r, _completing: true } : r));
    try { await window.aria?.completeReminder(id); } catch (_) {}
    setTimeout(() => {
      setReminders(prev => prev.filter(r => r.id !== id));
      setSelectedId(v => v === id ? null : v);
    }, 350);
  }, []);

  const handleSnooze = useCallback(async (id, minutes) => {
    try {
      await window.aria?.extendReminder(id, minutes);
      fetchReminders();
      setSelectedId(null);
    } catch (_) {}
  }, [fetchReminders]);

  const handleArchive = useCallback(async (id) => {
    setReminders(prev => prev.map(r => r.id === id ? { ...r, _archiving: true } : r));
    try { await window.aria?.archiveReminder(id); } catch (_) {}
    setTimeout(() => {
      setReminders(prev => prev.filter(r => r.id !== id));
      setSelectedId(v => v === id ? null : v);
    }, 300);
  }, []);

  const handleDelete = useCallback(async (id) => {
    try {
      await window.aria?.deleteReminder(id);
      setReminders(prev => prev.filter(r => r.id !== id));
      setArchivedTasks(prev => prev.filter(r => r.id !== id));
      setSelectedId(v => v === id ? null : v);
    } catch (_) {}
  }, []);

  const handleEdit = useCallback(async (id, title, dueAt) => {
    try {
      await window.aria?.updateReminder(id, title, dueAt);
      fetchReminders();
    } catch (_) {}
  }, [fetchReminders]);

  const handleAdd = useCallback(async () => {
    if (!addingText.trim()) return;
    setAdding(true);
    try {
      const result = await window.aria?.addReminder(addingText);
      if (result && !result.error) {
        setAddingText('');
        if (inputRef.current) inputRef.current.style.height = 'auto';
        fetchReminders();
      } else if (result?.error) setError(result.error);
    } catch (err) { setError(err.message); }
    finally { setAdding(false); }
  }, [addingText, fetchReminders]);

  const handleKeyDown = useCallback((e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleAdd(); }
  }, [handleAdd]);

  // ── Derived ──────────────────────────────────────────────────────────
  const nowUnix  = Math.floor(Date.now() / 1000);

  // Filter out sub-tasks from main list (they render nested under parents)
  const topLevel = reminders.filter(r => !r.parent_id);

  // Apply smart filter
  const filtered = topLevel.filter(r => {
    if (filter === 'today') {
      const d = new Date(r.due_at * 1000);
      return d.toDateString() === new Date().toDateString();
    }
    if (filter === 'overdue') return r.due_at < nowUnix;
    if (filter === 'priority') return (r.priority_score || 0) >= 25;
    return true;
  });

  const overdue  = filtered.filter(r => r.due_at < nowUnix);
  const upcoming = filtered.filter(r => r.due_at >= nowUnix);

  // "Focus Now" = highest priority_score overdue task, else highest upcoming
  const focusTask = [...overdue, ...upcoming].sort((a, b) => (b.priority_score || 0) - (a.priority_score || 0))[0] || null;

  // Rest of list, excluding focus task, sorted by due_at
  const restTasks = filtered
    .filter(r => r.id !== focusTask?.id)
    .sort((a, b) => a.due_at - b.due_at);

  // ── Loading ──────────────────────────────────────────────────────────
  if (loading) {
    return (
      <div className="flex-1 flex items-center justify-center py-12">
        <div className="w-5 h-5 rounded-full border border-[#2a2a2a] border-t-[#555] animate-spin" />
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col min-h-0 overflow-hidden" style={{ color: '#dcdcdc' }}>

      {/* ── Smart Filter Bar (Todoist-style) ── */}
      <div className="shrink-0 flex items-center gap-1 px-4 pt-3 pb-1">
        <Filter size={10} style={{ color: '#555', marginRight: 2 }} />
        {TASK_FILTERS.map(f => {
          const isActive = filter === f.key;
          const count = f.key === 'overdue' ? overdue.length
            : f.key === 'today' ? topLevel.filter(r => new Date(r.due_at * 1000).toDateString() === new Date().toDateString()).length
            : f.key === 'priority' ? topLevel.filter(r => (r.priority_score || 0) >= 25).length
            : topLevel.length;
          return (
            <button key={f.key} onClick={() => setFilter(f.key)}
                    className="px-2 py-0.5 rounded-full text-[9px] font-medium transition-all"
                    style={{
                      background: isActive ? 'rgba(255,255,255,0.06)' : 'transparent',
                      color: isActive ? '#e0e0e0' : '#666',
                      border: `1px solid ${isActive ? '#333' : 'transparent'}`
                    }}>
              {f.label}{count > 0 ? ` ${count}` : ''}
            </button>
          );
        })}
      </div>

      {/* ── Scrollable body ── */}
      <div className="flex-1 min-h-0 overflow-y-auto smooth-scroll">
        <div className="px-5 pt-3 pb-5 flex flex-col gap-7">

          {/* Error */}
          {error && (
            <div className="text-[10.5px]" style={{ color: '#7a3030' }}>
              {error}
            </div>
          )}

          {/* ── Focus Now ── */}
          {focusTask && (
            <FocusCard
              task={focusTask}
              nowUnix={nowUnix}
              onComplete={handleComplete}
              onSnooze={handleSnooze}
            />
          )}

          {/* ── Flat Timeline ── */}
          {restTasks.length > 0 && (() => {
            const overdueRest  = restTasks.filter(r => r.due_at < nowUnix);
            const cap          = 5;
            const visible      = restTasks.slice(0, cap);
            const hidden       = restTasks.length - cap;
            return (
              <div>
                {focusTask && (
                  <div className="flex items-center gap-2 mb-4">
                    <div className="text-[9px] uppercase tracking-[0.12em]" style={{ color: '#909090' }}>
                      Queue
                    </div>
                    {overdueRest.length > 0 && (
                      <span className="text-[8px] font-bold px-1.5 py-0.5 rounded tracking-wide"
                            style={{ background: 'rgba(192,96,96,0.12)', color: '#c06060' }}>
                        {overdueRest.length} Overdue
                      </span>
                    )}
                    <span className="text-[9px] ml-auto" style={{ color: '#555' }}>
                      {restTasks.length} task{restTasks.length !== 1 ? 's' : ''}
                    </span>
                  </div>
                )}
                <div>
                  {visible.map((task, i) => (
                    <TimelineRow
                      key={task.id}
                      task={task}
                      nowUnix={nowUnix}
                      selected={selectedId === task.id}
                      onSelect={() => setSelectedId(v => v === task.id ? null : task.id)}
                      onComplete={handleComplete}
                      onSnooze={handleSnooze}
                      onArchive={handleArchive}
                      onDelete={handleDelete}
                      onEdit={handleEdit}
                      divider={i < visible.length - 1 || hidden > 0}
                    />
                  ))}
                  {hidden > 0 && (
                    <div className="py-2 text-[10px]" style={{ color: '#555' }}>
                      +{hidden} more · complete current tasks to surface them
                    </div>
                  )}
                </div>
              </div>
            );
          })()}

          {/* Empty */}
          {reminders.length === 0 && !error && (
            <div className="pt-4">
              <div className="text-[12px] font-light" style={{ color: '#888' }}>No tasks.</div>
              <div className="text-[10px] mt-1" style={{ color: '#666' }}>
                Type a reminder below in natural language.
              </div>
            </div>
          )}

          {/* Controls */}
          <div className="flex items-center gap-4 -mt-2">
            <button onClick={fetchReminders}
                    className="flex items-center gap-1.5 text-[10px] transition-opacity hover:opacity-80"
                    style={{ color: '#888' }}>
              <RotateCcw size={9} /> Refresh
            </button>
            <button onClick={() => { if (!showArchived) fetchArchived(); setShowArchived(v => !v); }}
                    className="flex items-center gap-1.5 text-[10px] transition-opacity hover:opacity-80"
                    style={{ color: '#888' }}>
              <Archive size={9} /> {showArchived ? 'Hide' : 'Archive'}
            </button>
          </div>

          {/* Archived */}
          {showArchived && (
            <div>
              <div className="text-[9px] uppercase tracking-[0.12em] mb-3" style={{ color: '#909090' }}>
                Archive
              </div>
              {archivedTasks.length === 0 ? (
                <div className="text-[10px]" style={{ color: '#666' }}>Empty.</div>
              ) : archivedTasks.map((t, i) => (
                <div key={t.id}
                     className="flex items-center py-2.5 group"
                     style={{ borderBottom: i < archivedTasks.length - 1 ? '1px solid #1a1a1a' : 'none' }}>
                  <div className="flex-1 min-w-0">
                    <div className="text-[11px] line-through truncate" style={{ color: '#666' }}>
                      {t.title}
                    </div>
                    <div className="text-[9px] mt-[2px]" style={{ color: '#555' }}>
                      {new Date(t.due_at * 1000).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })}
                      {' · '}{t.completed ? 'completed' : 'archived'}
                    </div>
                  </div>
                  <button onClick={() => handleDelete(t.id)}
                          className="opacity-0 group-hover:opacity-100 transition-opacity ml-3 shrink-0"
                          style={{ color: '#888' }}>
                    <Trash2 size={9} />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* ── Pinned Input ── */}
      <div className="shrink-0" style={{ borderTop: '1px solid #1a1a1a', background: '#111' }}>
        <div className="px-4 py-3 flex gap-2 items-end">
          <textarea
            ref={inputRef}
            value={addingText}
            onChange={e => {
              setAddingText(e.target.value);
              e.target.style.height = 'auto';
              e.target.style.height = Math.min(e.target.scrollHeight, 72) + 'px';
            }}
            onKeyDown={handleKeyDown}
            placeholder='e.g. "Call bank tomorrow at 11am"'
            disabled={adding}
            rows={1}
            className="flex-1 outline-none resize-none text-[11.5px] leading-snug disabled:opacity-40"
            style={{
              background: 'transparent',
              color: '#888',
              caretColor: '#555',
              maxHeight: '72px',
            }}
          />
          <button
            onClick={handleAdd}
            disabled={!addingText.trim() || adding}
            className="shrink-0 w-7 h-7 rounded-full flex items-center justify-center transition-opacity hover:opacity-80 disabled:opacity-20"
            style={{ background: '#1e1e1e', border: '1px solid #2a2a2a' }}
          >
            <Send size={11} style={{ color: '#555' }} />
          </button>
        </div>
      </div>
    </div>
  );
}

/* ── Focus Card — top priority task ── */

function FocusCard({ task, nowUnix, onComplete, onSnooze }) {
  const isOverdue = task.due_at < nowUnix;
  const overdueHours = isOverdue ? (nowUnix - task.due_at) / 3600 : 0;
  const alertColor = overdueHours > 2;   // only flag when >2h late

  // Financial-risk detection (v1 hard rule: no defer on fin-risk tasks)
  const FIN_RE = /pay|bill|renew|subscription|invoice|due|emi|loan|credit|transfer|payment/i;
  const isFinancialRisk = (
    task.category === 'finance' ||
    task.category === 'payment' ||
    task.category === 'subscription' ||
    FIN_RE.test(task.title || '')
  );

  const dueDate  = new Date(task.due_at * 1000);
  const isToday  = new Date().toDateString() === dueDate.toDateString();
  const timeStr  = dueDate.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
  const dateStr  = dueDate.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
  const dueLabel = isOverdue
    ? (overdueHours < 1 ? 'Due now' : `${Math.floor(overdueHours)}h overdue`)
    : (isToday ? `Today ${timeStr}` : `${dateStr} · ${timeStr}`);

  // Financial impact from smart_action
  let financialNote = null;
  try {
    const sa = typeof task.smart_action === 'string'
      ? JSON.parse(task.smart_action) : task.smart_action;
    if (sa?.type === 'finance' && sa?.suggestion) financialNote = sa.suggestion;
  } catch (_) {}

  const completing = task._completing;

  return (
    <div style={{
      borderLeft: `2px solid ${alertColor ? '#7a3a3a' : '#383838'}`,
      paddingLeft: '14px',
      paddingTop: '12px',
      paddingBottom: '14px',
      paddingRight: '8px',
      background: 'rgba(255,255,255,0.03)',
      borderRadius: '0 4px 4px 0',
      opacity: completing ? 0 : 1,
      transform: completing ? 'translateX(12px)' : 'none',
      transition: 'opacity 0.3s ease, transform 0.3s ease'
    }}>
      {/* Label row */}
      <div className="flex items-center gap-2 mb-3">
        <div className="text-[9px] uppercase tracking-[0.14em]"
             style={{ color: alertColor ? '#b06060' : '#909090' }}>
          {isOverdue ? 'Overdue' : 'Do This First'}
        </div>
        {isOverdue && (
          <span className="text-[8px] font-bold px-1.5 py-0.5 rounded tracking-wide"
                style={{ background: 'rgba(192,96,96,0.15)', color: '#c06060', letterSpacing: '0.05em' }}>
            HIGH PRIORITY
          </span>
        )}
      </div>

      {/* Title */}
      <div className="text-[14px] font-light leading-snug mb-1.5"
           style={{ color: alertColor ? '#d08080' : '#e8e8e8' }}>
        {task.title}
      </div>

      {/* Due time */}
      <div className="text-[10px] mb-1" style={{ color: alertColor ? '#c06060' : '#a0a0a0', fontWeight: alertColor ? 500 : 400 }}>
        {dueLabel}
      </div>

      {/* Financial note */}
      {financialNote && (
        <div className="text-[10px] mb-3" style={{ color: '#888', fontStyle: 'italic' }}>
          {financialNote}
        </div>
      )}

      {/* Actions — always visible on focus card */}
      <div className="flex items-center gap-3 mt-4">
        <button
          onClick={() => onComplete(task.id)}
          className="px-4 py-1.5 rounded text-[10.5px] transition-opacity hover:opacity-80"
          style={{ border: '1px solid #505050', color: '#c8c8c8', background: 'transparent', letterSpacing: '0.01em' }}
        >
          Complete
        </button>
        {isFinancialRisk ? (
          <span className="text-[9px] tracking-wide" style={{ color: '#7a4a2e' }}>
            Financial risk — defer not available
          </span>
        ) : (
          <SnoozeMenu taskId={task.id} onSnooze={onSnooze} />
        )}
      </div>
    </div>
  );
}

/* ── Snooze Menu ── */

function SnoozeMenu({ taskId, onSnooze }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    if (!open) return;
    const handler = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  const OPTIONS = [
    { label: '+15 min',   m: 15   },
    { label: '+1 hour',   m: 60   },
    { label: '+3 hours',  m: 180  },
    { label: 'Tomorrow',  m: 1440 },
  ];

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen(v => !v)}
        className="px-4 py-1.5 rounded text-[10.5px] transition-opacity hover:opacity-80"
        style={{ border: '1px solid #3a3a3a', color: '#909090', background: 'transparent', letterSpacing: '0.01em' }}
      >
        Snooze
      </button>
      {open && (
        <div className="absolute bottom-[calc(100%+4px)] left-0 py-1 rounded-lg shadow-xl z-50 min-w-[110px]"
             style={{ background: '#161616', border: '1px solid #222' }}>
          {OPTIONS.map(o => (
            <button
              key={o.m}
              onClick={() => { setOpen(false); onSnooze(taskId, o.m); }}
              className="block w-full text-left px-3.5 py-1.5 text-[10px] transition-colors hover:opacity-70"
              style={{ color: '#a0a0a0' }}
            >
              {o.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/* ── Timeline Row — flat, minimal + recurring badge + sub-tasks ── */

function TimelineRow({ task, nowUnix, selected, onSelect, onComplete, onSnooze, onArchive, onDelete, onEdit, divider }) {
  const [editing, setEditing] = useState(false);
  const [editTitle, setEditTitle] = useState(task.title);
  const [editDate, setEditDate]   = useState('');
  const [subTasks, setSubTasks]   = useState([]);
  const [showSubs, setShowSubs]   = useState(false);
  const [newSub, setNewSub]       = useState('');
  const [addingSub, setAddingSub] = useState(false);
  const [logMinutes, setLogMinutes] = useState('');
  const [showTimeLog, setShowTimeLog] = useState(false);
  const [timeLogged, setTimeLogged]  = useState(task.time_spent || 0);

  const isOverdue     = task.due_at < nowUnix;
  const overdueHours  = isOverdue ? (nowUnix - task.due_at) / 3600 : 0;
  const alertColor    = overdueHours > 2;
  const completing    = task._completing;
  const archiving     = task._archiving;

  const dueDate  = new Date(task.due_at * 1000);
  const isToday  = new Date().toDateString() === dueDate.toDateString();
  const timeStr  = dueDate.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
  const dateStr  = dueDate.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
  const dueLabel = isOverdue
    ? (overdueHours < 1 ? 'Overdue' : `${Math.floor(overdueHours)}h overdue`)
    : (isToday ? timeStr : `${dateStr}`);

  // Load sub-tasks when expanded
  useEffect(() => {
    if (showSubs && task.id) {
      window.aria?.getSubTasks?.(task.id).then(s => setSubTasks(s || [])).catch(() => {});
    }
  }, [showSubs, task.id]);

  const handleAddSub = async () => {
    if (!newSub.trim() || addingSub) return;
    setAddingSub(true);
    try {
      await window.aria?.addSubTask(task.id, newSub.trim());
      setNewSub('');
      const subs = await window.aria?.getSubTasks?.(task.id);
      setSubTasks(subs || []);
    } catch (_) {}
    setAddingSub(false);
  };

  const handleToggleSub = async (subId) => {
    try {
      await window.aria?.toggleSubTask(subId);
      const subs = await window.aria?.getSubTasks?.(task.id);
      setSubTasks(subs || []);
    } catch (_) {}
  };

  const startEdit = (e) => {
    e.stopPropagation();
    setEditing(true);
    setEditTitle(task.title);
    const d = new Date(task.due_at * 1000);
    const p = n => String(n).padStart(2, '0');
    setEditDate(`${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`);
  };

  const saveEdit = (e) => {
    e.stopPropagation();
    onEdit(task.id, editTitle, editDate ? Math.floor(new Date(editDate).getTime() / 1000) : task.due_at);
    setEditing(false);
  };

  if (editing) {
    return (
      <div className="py-[11px]" style={{ borderBottom: divider ? '1px solid #1e1e1e' : 'none' }}
           onClick={e => e.stopPropagation()}>
        <input
          value={editTitle}
          onChange={e => setEditTitle(e.target.value)}
          autoFocus
          onKeyDown={e => { if (e.key === 'Enter') saveEdit(e); if (e.key === 'Escape') setEditing(false); }}
          className="w-full outline-none bg-transparent text-[12px] mb-2"
          style={{ borderBottom: '1px solid #333', color: '#d0d0d0', caretColor: '#888', paddingBottom: '4px' }}
        />
        <input
          type="datetime-local"
          value={editDate}
          onChange={e => setEditDate(e.target.value)}
          className="outline-none bg-transparent text-[10px] mb-3 block"
          style={{ borderBottom: '1px solid #2a2a2a', color: '#888', caretColor: '#666', paddingBottom: '3px' }}
        />
        <div className="flex gap-3">
          <button onClick={saveEdit}
                  className="px-3 py-1 rounded text-[10px] transition-opacity hover:opacity-80"
                  style={{ border: '1px solid #505050', color: '#c8c8c8', background: 'transparent' }}>
            Save
          </button>
          <button onClick={() => setEditing(false)}
                  className="text-[10px] transition-opacity hover:opacity-80"
                  style={{ color: '#888' }}>
            Cancel
          </button>
        </div>
      </div>
    );
  }

  const subDone = subTasks.filter(s => s.completed).length;
  const subTotal = subTasks.length;

  return (
    <div
      className="py-[11px] cursor-pointer"
      style={{
        borderBottom: divider ? '1px solid #1e1e1e' : 'none',
        opacity: completing || archiving ? 0 : 1,
        transform: completing ? 'translateX(10px)' : archiving ? 'translateX(-10px)' : 'none',
        transition: 'opacity 0.3s ease, transform 0.3s ease',
      }}
      onClick={onSelect}
    >
      {/* Main row */}
      <div className="flex items-center gap-3">
        {/* Title + badges */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5">
            <span className="text-[12px] leading-snug truncate"
                  style={{ color: completing ? '#444' : '#d0d0d0', textDecoration: completing ? 'line-through' : 'none' }}>
              {task.title}
            </span>
            {/* Recurring badge */}
            {task.recurring && (
              <span className="text-[8px] shrink-0" title={RECURRING_LABELS[task.recurring] || task.recurring}>
                🔁
              </span>
            )}
            {/* Time logged badge */}
            {timeLogged > 0 && (
              <span className="text-[7px] shrink-0 px-1 py-[1px] rounded-full"
                    style={{ background: 'rgba(79,156,249,0.08)', color: '#4f9cf9' }}>
                ⏱{timeLogged}m
              </span>
            )}
            {/* Sub-task count */}
            {showSubs && subTotal > 0 && (
              <span className="text-[8px] shrink-0 px-1 py-[1px] rounded-full"
                    style={{ background: 'rgba(255,255,255,0.05)', color: '#888' }}>
                {subDone}/{subTotal}
              </span>
            )}
          </div>
          {/* Source label */}
          {task.source && task.source !== 'manual' && (
            <span className="text-[8px] mt-0.5 block" style={{ color: '#555' }}>
              from {task.source}
            </span>
          )}
        </div>

        {/* Due label — right */}
        <div className="shrink-0 text-[10px] text-right"
             style={{ color: alertColor ? '#b06060' : '#999', letterSpacing: '0.01em' }}>
          {dueLabel}
        </div>
      </div>

      {/* Selected: action strip */}
      {selected && !completing && !archiving && (
        <div className="mt-3" onClick={e => e.stopPropagation()}>
          <div className="flex items-center gap-3">
            <button
              onClick={() => onComplete(task.id)}
              className="text-[10px] transition-opacity hover:opacity-80"
              style={{ color: '#c8c8c8', borderBottom: '1px solid #555', paddingBottom: '1px' }}
            >
              Complete
            </button>
            <SnoozeMenu taskId={task.id} onSnooze={onSnooze} />
            <button onClick={startEdit}
                    className="text-[10px] transition-opacity hover:opacity-80"
                    style={{ color: '#a0a0a0' }}>
              Edit
            </button>
            {/* Sub-tasks toggle (Todoist-style) */}
            <button onClick={() => setShowSubs(v => !v)}
                    className="text-[10px] flex items-center gap-1 transition-opacity hover:opacity-80"
                    style={{ color: '#888' }}>
              <ListTree size={9} /> Subs
            </button>
            <button onClick={() => setShowTimeLog(v => !v)}
                    className="text-[10px] flex items-center gap-1 transition-opacity hover:opacity-80"
                    style={{ color: timeLogged > 0 ? '#4f9cf9' : '#888' }}>
              ⏱ {timeLogged > 0 ? `${timeLogged}m` : 'Time'}
            </button>
            <div className="flex-1" />
            <button onClick={() => onDelete(task.id)}
                    className="transition-opacity hover:opacity-80"
                    style={{ color: '#888' }}>
              <Trash2 size={9} />
            </button>
          </div>

          {/* Time logging (RescueTime/Toggl replacement) */}
          {showTimeLog && (
            <div className="mt-2.5 ml-3 pl-3 flex items-center gap-2" style={{ borderLeft: '1px solid #1e4a6e' }}>
              <input value={logMinutes} onChange={e => setLogMinutes(e.target.value)}
                type="number" placeholder="min" min="1" max="480"
                className="w-14 text-[10px] px-1.5 py-1 rounded outline-none"
                style={{ background: '#1a1a1a', color: '#ccc', border: '1px solid #333' }}
                onKeyDown={async (e) => {
                  if (e.key === 'Enter' && logMinutes > 0) {
                    await window.aria?.logTime?.(task.id, task.title, parseInt(logMinutes));
                    setTimeLogged(prev => prev + parseInt(logMinutes));
                    setLogMinutes('');
                  }
                }}
              />
              <button onClick={async () => {
                if (logMinutes > 0) {
                  await window.aria?.logTime?.(task.id, task.title, parseInt(logMinutes));
                  setTimeLogged(prev => prev + parseInt(logMinutes));
                  setLogMinutes('');
                }
              }}
                className="text-[9px] px-2 py-1 rounded font-medium"
                style={{ background: 'rgba(79,156,249,0.1)', color: '#4f9cf9', border: '1px solid rgba(79,156,249,0.2)' }}>
                Log
              </button>
              <span className="text-[8px]" style={{ color: '#555' }}>
                Total: {timeLogged}m
              </span>
            </div>
          )}

          {/* Sub-tasks list (Todoist nested tasks) */}
          {showSubs && (
            <div className="mt-2.5 ml-3 pl-3" style={{ borderLeft: '1px solid #1e1e1e' }}>
              {subTasks.map(sub => (
                <div key={sub.id} className="flex items-center gap-2 py-1.5">
                  <button onClick={() => handleToggleSub(sub.id)}
                          className="shrink-0 w-3.5 h-3.5 rounded border flex items-center justify-center transition-colors"
                          style={{
                            borderColor: sub.completed ? '#22c55e' : '#444',
                            background: sub.completed ? 'rgba(34,197,94,0.15)' : 'transparent',
                          }}>
                    {sub.completed && <Check size={8} style={{ color: '#22c55e' }} />}
                  </button>
                  <span className="text-[11px] truncate"
                        style={{
                          color: sub.completed ? '#555' : '#aaa',
                          textDecoration: sub.completed ? 'line-through' : 'none',
                        }}>
                    {sub.title}
                  </span>
                </div>
              ))}
              {/* Add sub-task input */}
              <div className="flex items-center gap-1.5 py-1.5">
                <Plus size={10} style={{ color: '#555' }} />
                <input
                  value={newSub}
                  onChange={e => setNewSub(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter') handleAddSub(); }}
                  placeholder="Add sub-task..."
                  className="flex-1 bg-transparent outline-none text-[10px]"
                  style={{ color: '#888', caretColor: '#555' }}
                  disabled={addingSub}
                />
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
