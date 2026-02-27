import React, { useState, useEffect, useCallback } from 'react';
import { Plus, Trash2, Flame, Check, X } from 'lucide-react';

/**
 * HabitTracker - Compact daily habit grid with streaks.
 * Polished: proper spacing, visible text, no cramping.
 */
export default function HabitTracker({ isDark, embedded }) {
  const [habits, setHabits]   = useState([]);
  const [adding, setAdding]   = useState(false);
  const [newName, setNewName] = useState('');
  const [newIcon, setNewIcon] = useState('\u2705');

  const fetchHabits = useCallback(async () => {
    try {
      const data = await window.aria?.getHabits();
      if (Array.isArray(data)) setHabits(data);
    } catch (_) {}
  }, []);

  useEffect(() => { fetchHabits(); }, [fetchHabits]);

  const handleToggle = async (habitId) => {
    setHabits(prev => prev.map(h =>
      h.id === habitId ? { ...h, doneToday: !h.doneToday, streak: h.doneToday ? Math.max(0, h.streak - 1) : h.streak + 1 } : h
    ));
    try {
      await window.aria?.toggleHabit(habitId);
      fetchHabits();
    } catch (_) {}
  };

  const handleAdd = async () => {
    const name = newName.trim();
    if (!name) return;
    try {
      await window.aria?.createHabit(name, newIcon);
      setNewName('');
      setNewIcon('\u2705');
      setAdding(false);
      fetchHabits();
    } catch (_) {}
  };

  const handleDelete = async (id) => {
    setHabits(prev => prev.filter(h => h.id !== id));
    try { await window.aria?.deleteHabit(id); } catch (_) {}
  };

  const ICONS = ['\u2705', '\ud83d\udcaa', '\ud83d\udcd6', '\ud83e\uddd8', '\ud83d\udca7', '\ud83c\udfc3', '\ud83c\udfaf', '\ud83d\udca4', '\ud83c\udf4e', '\ud83d\udcdd'];

  const innerContent = (
    <>
      {/* Header — hidden when embedded */}
      {!embedded && (
        <div className="flex items-center justify-between px-3 py-1.5"
             style={{ background: isDark ? 'rgba(34,197,94,0.04)' : 'rgba(34,197,94,0.05)', borderBottom: `1px solid ${isDark ? '#232323' : '#eee'}` }}>
          <span className="text-[9px] font-mono font-semibold tracking-widest uppercase"
                style={{ color: '#22c55e' }}>
            {'\ud83d\udcca'} Daily Habits
          </span>
          <button onClick={() => setAdding(!adding)}
            className="w-5 h-5 rounded flex items-center justify-center transition-colors"
            style={{ color: '#22c55e' }}
            title={adding ? 'Cancel' : 'Add habit'}>
            {adding ? <X size={12} /> : <Plus size={12} />}
          </button>
        </div>
      )}

      {/* Embedded header: just the + button */}
      {embedded && (
        <div className="flex items-center justify-end px-3 py-1"
             style={{ borderBottom: `1px solid ${isDark ? '#232323' : '#eee'}` }}>
          <button onClick={() => setAdding(!adding)}
            className="w-5 h-5 rounded flex items-center justify-center transition-colors"
            style={{ color: '#22c55e' }}
            title={adding ? 'Cancel' : 'Add habit'}>
            {adding ? <X size={12} /> : <Plus size={12} />}
          </button>
        </div>
      )}

      {/* Add form */}
      {adding && (
        <div className="px-3 py-2 flex gap-1.5 items-center"
             style={{ borderBottom: `1px solid ${isDark ? '#232323' : '#eee'}` }}>
          <button
            className="w-7 h-7 rounded flex items-center justify-center text-sm shrink-0"
            style={{ background: isDark ? '#222' : '#f5f5f5', border: `1px solid ${isDark ? '#333' : '#ddd'}` }}
            onClick={() => { const i = ICONS.indexOf(newIcon); setNewIcon(ICONS[(i + 1) % ICONS.length]); }}
            title="Change icon">{newIcon}</button>
          <input autoFocus
            className="flex-1 bg-transparent text-[11px] outline-none px-2 py-1 rounded"
            style={{ color: isDark ? '#ddd' : '#1f2937', border: `1px solid ${isDark ? '#333' : '#ccc'}`, background: isDark ? '#222' : '#f9f9f9' }}
            placeholder="Habit name..."
            value={newName}
            onChange={e => setNewName(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') handleAdd(); if (e.key === 'Escape') setAdding(false); }} />
          <button onClick={handleAdd}
            className="px-2.5 py-1 rounded text-[9.5px] font-semibold transition-colors"
            style={{ background: '#22c55e', color: '#fff', opacity: newName.trim() ? 1 : 0.3 }}
            disabled={!newName.trim()}>Add</button>
        </div>
      )}

      {/* Habit list — inside innerContent */}
      {habits.length === 0 && !adding ? (
        <div className="px-3 py-3 text-center">
          <p className="text-[10px]" style={{ color: isDark ? '#444' : '#aaa' }}>
            No habits yet. Tap + to start tracking.
          </p>
        </div>
      ) : (
        <div>
          {habits.map((h, i) => (
            <div key={h.id}
                 className="flex items-center gap-2 px-3 py-[6px] group"
                 style={{ borderBottom: i < habits.length - 1 ? `1px solid ${isDark ? '#232323' : '#f0f0f0'}` : 'none' }}>
              {/* Checkbox */}
              <button onClick={() => handleToggle(h.id)}
                className={`w-5 h-5 rounded flex items-center justify-center shrink-0 transition-all ${
                  h.doneToday ? 'scale-105' : ''
                }`}
                style={{
                  background: h.doneToday ? '#22c55e' : 'transparent',
                  border: h.doneToday ? 'none' : `1.5px solid ${isDark ? '#3a3a3a' : '#ccc'}`,
                }}>
                {h.doneToday && <Check size={12} className="text-white" strokeWidth={3} />}
              </button>

              {/* Icon + Name */}
              <span className="text-[13px] shrink-0 leading-none">{h.icon}</span>
              <span className={`flex-1 text-[11.5px] leading-tight ${h.doneToday ? 'line-through opacity-40' : ''}`}
                    style={{ color: isDark ? '#c0c0c0' : '#374151' }}>
                {h.name}
              </span>

              {/* Streak */}
              {h.streak > 0 && (
                <span className="flex items-center gap-[2px] text-[9px] font-bold text-[#f97316] shrink-0">
                  <Flame size={10} /> {h.streak}
                </span>
              )}

              {/* Delete */}
              <button onClick={() => handleDelete(h.id)}
                className="opacity-0 group-hover:opacity-50 hover:!opacity-100 transition-opacity shrink-0 p-0.5">
                <Trash2 size={10} style={{ color: isDark ? '#555' : '#aaa' }} />
              </button>
            </div>
          ))}
        </div>
      )}
    </>
  );

  if (embedded) return innerContent;

  return (
    <div className="rounded-xl overflow-hidden"
         style={{
           background: isDark ? '#1c1c1c' : '#fff',
           border: `1px solid ${isDark ? '#272727' : '#e0e0e0'}`
         }}>
      {innerContent}
    </div>
  );
}
