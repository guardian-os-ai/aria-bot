import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import {
  Plus, Trash2, Save, X, Tag, FileText, ChevronLeft,
  ExternalLink, Copy, Search, Clock, FolderOpen,
  Sparkles, ListChecks, Layout, PenLine, Wand2, Link2, CalendarDays
} from 'lucide-react';
import { useTheme } from '../../context/ThemeContext';

/**
 * Notes panel — Mini Notepad++ experience + Notion AI features.
 * Two views: file browser (list) and editor (open note).
 * Tag-based categories, AI summarize, extract action items, templates.
 */

const TAG_COLORS = ['#4f9cf9', '#22c55e', '#f97316', '#a78bfa', '#eab308', '#ef4444', '#ec4899', '#14b8a6'];

export default function Notes() {
  const { theme } = useTheme();
  const isDark = theme === 'dark';

  // State
  const [notes, setNotes] = useState([]);
  const [loading, setLoading] = useState(true);
  const [activeFilter, setActiveFilter] = useState('All');
  const [searchQuery, setSearchQuery] = useState('');

  // Editor state
  const [openNote, setOpenNote] = useState(null); // null = file list view, object = editor view
  const [editorTitle, setEditorTitle] = useState('');
  const [editorContent, setEditorContent] = useState('');
  const [editorTags, setEditorTags] = useState('');
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);

  // New note mode
  const [creating, setCreating] = useState(false);

  // AI features (Notion AI)
  const [summarizing, setSummarizing] = useState(false);
  const [aiSummary, setAiSummary] = useState(null);
  const [extracting, setExtracting] = useState(false);
  const [actionItems, setActionItems] = useState(null);

  // Template picker
  const [showTemplates, setShowTemplates] = useState(false);
  const [noteTemplates, setNoteTemplates] = useState([]);

  // Continue Writing (Notion AI)
  const [continuing, setContinuing] = useState(false);

  // Tone Changer
  const [changingTone, setChangingTone] = useState(false);

  // Related Notes (Obsidian-style)
  const [relatedNotes, setRelatedNotes] = useState(null);

  // Reading List (Pocket/Readwise replacement)
  const [readingMode, setReadingMode] = useState(false);
  const [readingList, setReadingList] = useState([]);
  const [readingUrl, setReadingUrl] = useState('');
  const [loadingReading, setLoadingReading] = useState(false);

  const editorRef = useRef(null);
  const titleRef = useRef(null);

  /* ── Fetch notes ── */
  const fetchNotes = useCallback(async () => {
    setLoading(true);
    try {
      const data = await window.aria?.getNotes();
      setNotes(Array.isArray(data) ? data : []);
    } catch (_) {}
    setLoading(false);
  }, []);

  useEffect(() => { fetchNotes(); }, [fetchNotes]);

  /* ── Fetch reading list ── */
  const fetchReading = useCallback(async () => {
    setLoadingReading(true);
    try {
      const data = await window.aria?.getReadingList?.();
      setReadingList(Array.isArray(data) ? data : []);
    } catch (_) {}
    setLoadingReading(false);
  }, []);

  useEffect(() => { if (readingMode) fetchReading(); }, [readingMode, fetchReading]);

  const handleAddReading = async () => {
    const url = readingUrl.trim();
    if (!url) return;
    try {
      await window.aria?.addToReadingList?.(url, url.split('/').pop()?.slice(0, 60) || 'Link');
      setReadingUrl('');
      fetchReading();
    } catch (_) {}
  };

  const handleMarkRead = async (id) => {
    try {
      await window.aria?.markReadingRead?.(id);
      setReadingList(prev => prev.map(r => r.id === id ? { ...r, is_read: 1 } : r));
    } catch (_) {}
  };

  const handleDeleteReading = async (id) => {
    try {
      await window.aria?.deleteReadingItem?.(id);
      setReadingList(prev => prev.filter(r => r.id !== id));
    } catch (_) {}
  };

  /* ── Derived: all unique tags ── */
  const allTags = useMemo(() => {
    const tagSet = new Set();
    notes.forEach(n => {
      const tags = parseTags(n.tags);
      tags.forEach(t => tagSet.add(t));
    });
    return ['All', ...Array.from(tagSet).sort()];
  }, [notes]);

  /* ── Filtered notes ── */
  const filteredNotes = useMemo(() => {
    let list = notes;
    if (activeFilter !== 'All') {
      list = list.filter(n => {
        const tags = parseTags(n.tags);
        return tags.includes(activeFilter);
      });
    }
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      list = list.filter(n =>
        (n.title || '').toLowerCase().includes(q) ||
        (n.content || '').toLowerCase().includes(q)
      );
    }
    return list;
  }, [notes, activeFilter, searchQuery]);

  /* ── Open a note in editor ── */
  const openInEditor = useCallback((note) => {
    setOpenNote(note);
    setEditorTitle(note.title || 'Untitled');
    setEditorContent(note.content || '');
    const tags = parseTags(note.tags);
    setEditorTags(tags.join(', '));
    setDirty(false);
    setCreating(false);
    setAiSummary(null);
    setActionItems(null);
  }, []);

  /* ── Create new note ── */
  const startNewNote = useCallback(() => {
    setOpenNote({ id: null });
    setEditorTitle('');
    setEditorContent('');
    setEditorTags('');
    setDirty(true);
    setCreating(true);
    setTimeout(() => titleRef.current?.focus(), 80);
  }, []);

  /* ── Save note ── */
  const saveNote = useCallback(async () => {
    if (!editorTitle.trim() && !editorContent.trim()) return;
    setSaving(true);
    const title = editorTitle.trim() || 'Untitled';
    const tags = editorTags.trim()
      ? editorTags.split(',').map(t => t.trim()).filter(Boolean)
      : null;

    try {
      if (creating || !openNote?.id) {
        const result = await window.aria?.addNote(title, editorContent, tags);
        if (result?.id) {
          setOpenNote({ ...openNote, id: result.id });
          setCreating(false);
        }
      } else {
        await window.aria?.updateNote(openNote.id, title, editorContent, tags);
      }
      setDirty(false);
      fetchNotes();
    } catch (_) {}
    setSaving(false);
  }, [openNote, creating, editorTitle, editorContent, editorTags, fetchNotes]);

  /* ── Delete note ── */
  const deleteNote = useCallback(async (id) => {
    try {
      await window.aria?.deleteNote(id);
      if (openNote?.id === id) {
        setOpenNote(null);
      }
      fetchNotes();
    } catch (_) {}
  }, [openNote, fetchNotes]);

  /* ── Open in external editor ── */
  const openExternal = useCallback(async () => {
    if (!openNote?.id) return;
    // Save first
    await saveNote();
    try { await window.aria?.openNoteExternal(openNote.id); } catch (_) {}
  }, [openNote, saveNote]);

  /* ── Back to list ── */
  const backToList = useCallback(async () => {
    if (dirty) await saveNote();
    setOpenNote(null);
    setCreating(false);
    setAiSummary(null);
    setActionItems(null);
    setShowTemplates(false);
  }, [dirty, saveNote]);

  /* ── Copy content ── */
  const copyContent = useCallback(() => {
    navigator.clipboard?.writeText(editorContent);
  }, [editorContent]);

  /* ── AI: Summarize note ── */
  const handleSummarize = useCallback(async () => {
    if (!openNote?.id || summarizing) return;
    setSummarizing(true);
    setAiSummary(null);
    try {
      const result = await window.aria?.summarizeNote(openNote.id);
      setAiSummary(result?.summary || 'Could not generate summary.');
    } catch (_) {
      setAiSummary('Failed to summarize.');
    }
    setSummarizing(false);
  }, [openNote, summarizing]);

  /* ── AI: Extract action items ── */
  const handleExtractActions = useCallback(async () => {
    if (!openNote?.id || extracting) return;
    setExtracting(true);
    setActionItems(null);
    try {
      const result = await window.aria?.extractActionItems(openNote.id);
      setActionItems(Array.isArray(result?.items) ? result.items : []);
    } catch (_) {
      setActionItems([]);
    }
    setExtracting(false);
  }, [openNote, extracting]);

  /* ── Create task from action item ── */
  const createTaskFromItem = useCallback(async (item) => {
    try {
      await window.aria?.parseAndSaveReminder(item);
    } catch (_) {}
  }, []);

  /* ── Load note templates ── */
  const loadTemplates = useCallback(async () => {
    try {
      const t = await window.aria?.getNoteTemplates();
      setNoteTemplates(Array.isArray(t) ? t : []);
    } catch (_) {}
  }, []);

  /* ── Use a template ── */
  const useTemplate = useCallback((tpl) => {
    setOpenNote({ id: null });
    setEditorTitle(tpl.name || '');
    setEditorContent(tpl.content || '');
    setEditorTags('');
    setDirty(true);
    setCreating(true);
    setShowTemplates(false);
    setTimeout(() => titleRef.current?.focus(), 80);
  }, []);

  /* ── AI: Continue Writing (Notion AI) ── */
  const handleContinueWriting = useCallback(async () => {
    if (!editorContent.trim() || continuing) return;
    setContinuing(true);
    try {
      const result = await window.aria?.continueWriting(editorContent);
      if (result?.continuation) {
        setEditorContent(prev => prev + ' ' + result.continuation);
        setDirty(true);
      }
    } catch (_) {}
    setContinuing(false);
  }, [editorContent, continuing]);

  /* ── Tone Changer for notes ── */
  const handleToneChange = useCallback(async (tone) => {
    if (!editorContent.trim() || changingTone) return;
    setChangingTone(true);
    try {
      const result = await window.aria?.adjustNoteTone(editorContent, tone);
      if (result?.result) {
        setEditorContent(result.result);
        setDirty(true);
      }
    } catch (_) {}
    setChangingTone(false);
  }, [editorContent, changingTone]);

  /* ── Related Notes (Obsidian-style) ── */
  const loadRelatedNotes = useCallback(async () => {
    if (!openNote?.id) return;
    try {
      const result = await window.aria?.getRelatedNotes(openNote.id);
      setRelatedNotes(result?.related || []);
    } catch (_) {
      setRelatedNotes([]);
    }
  }, [openNote]);

  /* ── Open Daily Note (Obsidian-style) ── */
  const openDailyNote = useCallback(async () => {
    try {
      const note = await window.aria?.getDailyNote();
      if (note) {
        openInEditor(note);
        fetchNotes();
      }
    } catch (_) {}
  }, [openInEditor, fetchNotes]);

  /* ── Keyboard: Ctrl+S to save ── */
  useEffect(() => {
    if (!openNote) return;
    const handler = (e) => {
      if (e.ctrlKey && e.key === 's') {
        e.preventDefault();
        saveNote();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [openNote, saveNote]);

  /* ── Line count for gutter ── */
  const lineCount = editorContent.split('\n').length;

  /* ── File Browser View (Main) ── */
  return (
    <div className="flex-1 flex flex-col min-h-0 overflow-hidden relative">
      {/* Tag filter bar */}
      <div className="shrink-0 overflow-x-auto flex items-center gap-1 px-2 py-1.5"
           style={{
             background: isDark ? '#1a1a1a' : '#efefef',
             borderBottom: `1px solid ${isDark ? '#2a2a2a' : '#d0d0d0'}`,
             scrollbarWidth: 'none'
           }}>
        {allTags.map((tag, i) => {
          const isActive = activeFilter === tag;
          const color = tag === 'All' ? '#4f9cf9' : TAG_COLORS[(i - 1) % TAG_COLORS.length];
          return (
            <button
              key={tag}
              onClick={() => setActiveFilter(tag)}
              className="shrink-0 px-2 py-0.5 rounded-full text-[9px] font-medium transition-all btn-press whitespace-nowrap"
              style={{
                background: isActive ? `${color}20` : 'transparent',
                color: isActive ? color : isDark ? '#555' : '#999',
                border: `1px solid ${isActive ? `${color}40` : 'transparent'}`
              }}>
              {tag === 'All' ? `All (${notes.length})` : tag}
            </button>
          );
        })}
        <button
          onClick={() => { setReadingMode(!readingMode); setActiveFilter('All'); }}
          className="shrink-0 px-2 py-0.5 rounded-full text-[9px] font-medium transition-all btn-press whitespace-nowrap"
          style={{
            background: readingMode ? 'rgba(249,115,22,0.12)' : 'transparent',
            color: readingMode ? '#f97316' : isDark ? '#555' : '#999',
            border: `1px solid ${readingMode ? 'rgba(249,115,22,0.3)' : 'transparent'}`
          }}>
          📖 Reading
        </button>
      </div>

      {/* Search bar + Daily Note */}
      <div className="shrink-0 flex items-center gap-1.5 px-2.5 py-1.5"
           style={{ borderBottom: `1px solid ${isDark ? '#222' : '#e0e0e0'}` }}>
        <Search size={11} style={{ color: isDark ? '#444' : '#bbb' }} />
        <input
          value={searchQuery}
          onChange={e => setSearchQuery(e.target.value)}
          placeholder="Search notes…"
          className="flex-1 text-[10px] bg-transparent outline-none"
          style={{ color: isDark ? '#ccc' : '#333' }}
        />
        {searchQuery && (
          <button onClick={() => setSearchQuery('')} className="btn-press">
            <X size={10} style={{ color: isDark ? '#555' : '#999' }} />
          </button>
        )}
        <button onClick={openDailyNote}
          className="shrink-0 flex items-center gap-1 px-2 py-0.5 rounded-md text-[9px] font-medium btn-press"
          style={{
            background: isDark ? 'rgba(79,156,249,0.08)' : 'rgba(79,156,249,0.06)',
            color: '#4f9cf9',
            border: '1px solid rgba(79,156,249,0.15)'
          }}
          title="Open today's daily note">
          <CalendarDays size={10} />
          Today
        </button>
      </div>

      {/* File list / Reading list */}
      {readingMode ? (
        <div className="flex-1 overflow-y-auto px-2 pt-1.5 pb-1.5 space-y-1.5 smooth-scroll">
          {/* URL input */}
          <div className="flex gap-1 mb-1">
            <input value={readingUrl} onChange={e => setReadingUrl(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && handleAddReading()}
              placeholder="Paste URL to save…"
              className="flex-1 text-[10px] px-2 py-1.5 rounded-md outline-none"
              style={{ background: isDark ? '#1a1a1a' : '#f5f5f5', color: isDark ? '#ccc' : '#333',
                border: `1px solid ${isDark ? '#282828' : '#ddd'}` }} />
            <button onClick={handleAddReading}
              className="px-2 py-1 rounded-md text-[9px] font-semibold btn-press"
              style={{ background: '#f97316', color: '#fff' }}>+</button>
          </div>
          {loadingReading ? (
            <div className="text-center text-[10px] py-6" style={{ color: isDark ? '#555' : '#999' }}>Loading…</div>
          ) : readingList.length === 0 ? (
            <div className="text-center py-8 text-[10px]" style={{ color: isDark ? '#555' : '#999' }}>
              No saved links yet. Paste a URL above to save it.
            </div>
          ) : (
            readingList.map(item => (
              <div key={item.id} className="flex items-start gap-2 py-1.5 px-2 rounded-lg"
                style={{ background: isDark ? '#1a1a1a' : '#fafafa', border: `1px solid ${isDark ? '#222' : '#eee'}`,
                  opacity: item.is_read ? 0.5 : 1 }}>
                <button onClick={() => handleMarkRead(item.id)}
                  className="mt-0.5 shrink-0 w-4 h-4 rounded-full border-2 flex items-center justify-center"
                  style={{ borderColor: item.is_read ? '#22c55e' : isDark ? '#444' : '#ccc',
                    background: item.is_read ? '#22c55e' : 'transparent' }}>
                  {item.is_read && <span className="text-white text-[8px]">✓</span>}
                </button>
                <div className="flex-1 min-w-0">
                  <div className="text-[10px] font-medium truncate" style={{ color: isDark ? '#ddd' : '#333',
                    textDecoration: item.is_read ? 'line-through' : 'none' }}>
                    {item.title || item.url}
                  </div>
                  <div className="text-[8px] truncate" style={{ color: isDark ? '#444' : '#aaa' }}>{item.url}</div>
                </div>
                <button onClick={() => handleDeleteReading(item.id)}
                  className="shrink-0 btn-press"
                  style={{ color: isDark ? '#444' : '#ccc' }}>
                  <Trash2 size={10} />
                </button>
              </div>
            ))
          )}
        </div>
      ) : (
      <div className="flex-1 overflow-y-auto px-1.5 pt-1 pb-1.5 space-y-0.5 smooth-scroll">
        {loading ? (
          <div className="text-center text-[11px] py-8" style={{ color: isDark ? '#555' : '#999' }}>
            Loading notes…
          </div>
        ) : filteredNotes.length === 0 ? (
          <div className="text-center py-10">
            <FileText size={28} className="mx-auto mb-2" style={{ color: isDark ? '#2a2a2a' : '#ddd' }} />
            <div className="text-[11px] mb-1" style={{ color: isDark ? '#555' : '#999' }}>
              {notes.length === 0 ? 'No notes yet' : 'No matching notes'}
            </div>
            <div className="text-[9px]" style={{ color: isDark ? '#333' : '#bbb' }}>
              Tap + to create your first note
            </div>
          </div>
        ) : (
          filteredNotes.map((note) => (
            <NoteFileRow
              key={note.id}
              note={note}
              isDark={isDark}
              onOpen={() => openInEditor(note)}
              onDelete={() => deleteNote(note.id)}
              onOpenExternal={async () => {
                try { await window.aria?.openNoteExternal(note.id); } catch (_) {}
              }}
            />
          ))
        )}
      </div>
      )}

      {/* New note button + Template picker */}
      <div className="shrink-0 px-2.5 py-2"
           style={{ borderTop: `1px solid ${isDark ? '#2a2a2a' : '#e5e7eb'}` }}>
        <div className="flex items-center gap-1.5">
          <button
            onClick={startNewNote}
            className="flex-1 flex items-center justify-center gap-1.5 py-2 rounded-lg text-[11px] font-semibold transition-all btn-press"
            style={{
              background: isDark ? 'rgba(79,156,249,0.08)' : 'rgba(79,156,249,0.06)',
              color: '#4f9cf9',
              border: '1px solid rgba(79,156,249,0.2)'
            }}>
            <Plus size={13} />
            New Note
          </button>
          <button
            onClick={() => { loadTemplates(); setShowTemplates(!showTemplates); }}
            className="flex items-center justify-center gap-1 py-2 px-2.5 rounded-lg text-[11px] font-semibold transition-all btn-press"
            style={{
              background: showTemplates
                ? 'rgba(167,139,250,0.12)'
                : isDark ? 'rgba(167,139,250,0.06)' : 'rgba(167,139,250,0.04)',
              color: '#a78bfa',
              border: `1px solid ${showTemplates ? 'rgba(167,139,250,0.3)' : 'rgba(167,139,250,0.15)'}`
            }}
            title="From template">
            <Layout size={12} />
          </button>
        </div>

        {/* Template dropdown */}
        {showTemplates && (
          <div className="mt-1.5 rounded-lg overflow-hidden"
               style={{
                 background: isDark ? '#151515' : '#f9f9f9',
                 border: `1px solid ${isDark ? '#2a2a2a' : '#e0e0e0'}`
               }}>
            <div className="px-2.5 py-1.5 text-[9px] font-semibold"
                 style={{
                   color: '#a78bfa',
                   background: isDark ? 'rgba(167,139,250,0.05)' : 'rgba(167,139,250,0.03)',
                   borderBottom: `1px solid ${isDark ? '#222' : '#e5e7eb'}`
                 }}>
              Templates
            </div>
            {noteTemplates.length === 0 ? (
              <div className="px-2.5 py-3 text-center text-[10px]"
                   style={{ color: isDark ? '#555' : '#999' }}>
                No templates found
              </div>
            ) : (
              noteTemplates.map((tpl) => (
                <button
                  key={tpl.id}
                  onClick={() => useTemplate(tpl)}
                  className="w-full text-left px-2.5 py-1.5 transition-colors btn-press flex items-center gap-2"
                  style={{
                    borderBottom: `1px solid ${isDark ? '#1e1e1e' : '#f0f0f0'}`,
                    color: isDark ? '#bbb' : '#444'
                  }}>
                  <Layout size={10} style={{ color: '#a78bfa', flexShrink: 0 }} />
                  <div className="flex-1 min-w-0">
                    <div className="text-[10px] font-medium truncate">{tpl.name}</div>
                    <div className="text-[8px] truncate mt-0.5"
                         style={{ color: isDark ? '#444' : '#aaa' }}>
                      {(tpl.content || '').substring(0, 50)}…
                    </div>
                  </div>
                </button>
              ))
            )}
          </div>
        )}
      </div>

      {/* ── Modal Editor Popup ── */}
      {openNote && (
        <div className="absolute inset-0 bg-black bg-opacity-60 flex items-center justify-center z-50 p-4 animate-fade-in"
             onClick={backToList}>
          <div className="w-full h-full max-w-[320px] max-h-[520px] flex flex-col rounded-xl overflow-hidden shadow-2xl animate-scale-in"
               onClick={(e) => e.stopPropagation()}
               style={{
                 background: isDark ? '#1a1a1a' : '#ffffff',
                 border: `1.5px solid ${isDark ? '#333' : '#d0d0d0'}`
               }}>
            {/* Modal toolbar */}
            <div className="shrink-0 flex items-center gap-1.5 px-3 py-2"
                 style={{
                   background: isDark ? '#141414' : '#f5f5f5',
                   borderBottom: `1px solid ${isDark ? '#2a2a2a' : '#d0d0d0'}`
                 }}>
              <button onClick={backToList}
                className="p-1 rounded-md transition-colors btn-press"
                style={{ color: isDark ? '#888' : '#666' }}
                title="Close">
                <X size={14} />
              </button>

              {/* Editable title */}
              <input
                ref={titleRef}
                value={editorTitle}
                onChange={e => { setEditorTitle(e.target.value); setDirty(true); }}
                placeholder="Note title…"
                className="flex-1 text-[12px] font-semibold bg-transparent outline-none min-w-0"
                style={{ color: isDark ? '#e0e0e0' : '#1a1a1a' }}
                spellCheck={false}
              />

              {/* Action buttons */}
              <button onClick={copyContent}
                className="p-1 rounded-md transition-colors btn-press"
                style={{ color: isDark ? '#555' : '#9ca3af' }}
                title="Copy content">
                <Copy size={13} />
              </button>

              {/* AI Summarize */}
              {openNote?.id && (
                <button onClick={handleSummarize}
                  disabled={summarizing}
                  className="p-1 rounded-md transition-colors btn-press"
                  style={{ color: summarizing ? '#a78bfa' : isDark ? '#555' : '#9ca3af' }}
                  title="AI Summarize">
                  <Sparkles size={13} />
                </button>
              )}

              {/* AI Extract Tasks */}
              {openNote?.id && (
                <button onClick={handleExtractActions}
                  disabled={extracting}
                  className="p-1 rounded-md transition-colors btn-press"
                  style={{ color: extracting ? '#34d399' : isDark ? '#555' : '#9ca3af' }}
                  title="Extract Action Items">
                  <ListChecks size={13} />
                </button>
              )}

              {openNote?.id && (
                <button onClick={openExternal}
                  className="p-1 rounded-md transition-colors btn-press"
                  style={{ color: isDark ? '#555' : '#9ca3af' }}
                  title="Open in Notepad">
                  <ExternalLink size={13} />
                </button>
              )}

              <button onClick={saveNote}
                disabled={saving || !dirty}
                className="px-2.5 py-1 rounded-md text-[10px] font-semibold transition-all btn-press"
                style={{
                  background: dirty ? 'rgba(34,197,94,0.12)' : 'rgba(0,0,0,0.03)',
                  color: dirty ? '#22c55e' : isDark ? '#444' : '#ccc',
                  border: `1px solid ${dirty ? 'rgba(34,197,94,0.3)' : isDark ? '#2a2a2a' : '#e5e7eb'}`
                }}>
                {saving ? '⏳' : '💾 Save'}
              </button>
            </div>

            {/* Tags bar */}
            <div className="shrink-0 flex items-center gap-1.5 px-3 py-1.5"
                 style={{
                   background: isDark ? '#161616' : '#f9f9f9',
                   borderBottom: `1px solid ${isDark ? '#222' : '#e5e7eb'}`
                 }}>
              <Tag size={10} style={{ color: isDark ? '#444' : '#bbb' }} />
              <input
                value={editorTags}
                onChange={e => { setEditorTags(e.target.value); setDirty(true); }}
                placeholder="Tags (comma-separated)…"
                className="flex-1 text-[10px] bg-transparent outline-none"
                style={{ color: isDark ? '#777' : '#666' }}
              />
            </div>

            {/* AI Tool Strip — Continue Writing, Tone, Related */}
            <div className="shrink-0 flex items-center gap-1 px-3 py-1.5 overflow-x-auto"
                 style={{
                   background: isDark ? '#131313' : '#f5f5f5',
                   borderBottom: `1px solid ${isDark ? '#1e1e1e' : '#eee'}`,
                   scrollbarWidth: 'none'
                 }}>
              <button onClick={handleContinueWriting}
                disabled={continuing || !editorContent.trim()}
                className="shrink-0 flex items-center gap-1 px-2 py-1 rounded-md text-[9px] font-medium btn-press"
                style={{
                  background: continuing ? 'rgba(79,156,249,0.12)' : 'transparent',
                  color: continuing ? '#4f9cf9' : isDark ? '#555' : '#999',
                  border: `1px solid ${continuing ? 'rgba(79,156,249,0.2)' : isDark ? '#222' : '#e5e7eb'}`
                }}>
                <PenLine size={9} />
                {continuing ? 'Writing…' : 'Continue'}
              </button>

              {['professional', 'casual', 'concise'].map(tone => (
                <button key={tone}
                  onClick={() => handleToneChange(tone)}
                  disabled={changingTone || !editorContent.trim()}
                  className="shrink-0 px-2 py-1 rounded-md text-[9px] font-medium btn-press"
                  style={{
                    background: 'transparent',
                    color: isDark ? '#555' : '#999',
                    border: `1px solid ${isDark ? '#222' : '#e5e7eb'}`
                  }}>
                  {tone.charAt(0).toUpperCase() + tone.slice(1)}
                </button>
              ))}

              {openNote?.id && (
                <button onClick={() => { loadRelatedNotes(); }}
                  className="shrink-0 flex items-center gap-1 px-2 py-1 rounded-md text-[9px] font-medium btn-press"
                  style={{
                    background: relatedNotes?.length > 0 ? 'rgba(234,179,8,0.08)' : 'transparent',
                    color: relatedNotes?.length > 0 ? '#eab308' : isDark ? '#555' : '#999',
                    border: `1px solid ${relatedNotes?.length > 0 ? 'rgba(234,179,8,0.2)' : isDark ? '#222' : '#e5e7eb'}`
                  }}>
                  <Link2 size={9} />
                  Related{relatedNotes?.length > 0 ? ` (${relatedNotes.length})` : ''}
                </button>
              )}
            </div>

            {/* Related Notes Panel */}
            {relatedNotes && relatedNotes.length > 0 && (
              <div className="shrink-0 px-3 py-1.5"
                   style={{
                     background: isDark ? '#111' : '#fffbeb',
                     borderBottom: `1px solid ${isDark ? '#222' : '#fde68a'}`,
                     maxHeight: 60
                   }}>
                <div className="flex items-center gap-1 mb-1">
                  <Link2 size={9} style={{ color: '#eab308' }} />
                  <span className="text-[8px] font-semibold" style={{ color: '#eab308' }}>Related Notes</span>
                  <button onClick={() => setRelatedNotes(null)} className="ml-auto btn-press p-0.5">
                    <X size={8} style={{ color: isDark ? '#555' : '#999' }} />
                  </button>
                </div>
                <div className="flex flex-wrap gap-1">
                  {relatedNotes.map(rn => (
                    <button key={rn.id}
                      onClick={() => {
                        const note = notes.find(n => n.id === rn.id);
                        if (note) { openInEditor(note); setRelatedNotes(null); }
                      }}
                      className="text-[9px] px-1.5 py-0.5 rounded-md btn-press"
                      style={{
                        background: isDark ? 'rgba(234,179,8,0.06)' : 'rgba(234,179,8,0.08)',
                        color: isDark ? '#ccc' : '#444',
                        border: '1px solid rgba(234,179,8,0.15)'
                      }}>
                      {rn.title || 'Untitled'}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {/* Larger textarea for note content */}
            <div className="flex-1 flex flex-col min-h-0 overflow-hidden">

              {/* AI Results Panel (collapsible) */}
              {(aiSummary || summarizing || actionItems || extracting) && (
                <div className="shrink-0 px-3 py-2 space-y-2 overflow-y-auto"
                     style={{
                       maxHeight: 140,
                       background: isDark ? '#111' : '#f0f4ff',
                       borderBottom: `1px solid ${isDark ? '#2a2a2a' : '#d0d0d0'}`
                     }}>
                  {/* Summary */}
                  {(summarizing || aiSummary) && (
                    <div>
                      <div className="flex items-center gap-1 mb-1">
                        <Sparkles size={10} style={{ color: '#a78bfa' }} />
                        <span className="text-[9px] font-semibold" style={{ color: '#a78bfa' }}>
                          {summarizing ? 'Summarizing…' : 'Summary'}
                        </span>
                        {aiSummary && (
                          <button onClick={() => setAiSummary(null)}
                            className="ml-auto btn-press p-0.5 rounded"
                            style={{ color: isDark ? '#555' : '#999' }}>
                            <X size={9} />
                          </button>
                        )}
                      </div>
                      {summarizing ? (
                        <div className="text-[9px] animate-pulse" style={{ color: isDark ? '#666' : '#999' }}>
                          AI is reading your note…
                        </div>
                      ) : (
                        <div className="text-[10px] leading-relaxed whitespace-pre-wrap"
                             style={{ color: isDark ? '#aaa' : '#444' }}>
                          {aiSummary}
                        </div>
                      )}
                    </div>
                  )}

                  {/* Action Items */}
                  {(extracting || actionItems) && (
                    <div>
                      <div className="flex items-center gap-1 mb-1">
                        <ListChecks size={10} style={{ color: '#34d399' }} />
                        <span className="text-[9px] font-semibold" style={{ color: '#34d399' }}>
                          {extracting ? 'Extracting…' : `Action Items (${actionItems?.length || 0})`}
                        </span>
                        {actionItems && (
                          <button onClick={() => setActionItems(null)}
                            className="ml-auto btn-press p-0.5 rounded"
                            style={{ color: isDark ? '#555' : '#999' }}>
                            <X size={9} />
                          </button>
                        )}
                      </div>
                      {extracting ? (
                        <div className="text-[9px] animate-pulse" style={{ color: isDark ? '#666' : '#999' }}>
                          Finding action items…
                        </div>
                      ) : actionItems?.length > 0 ? (
                        <div className="space-y-1">
                          {actionItems.map((item, i) => (
                            <div key={i} className="flex items-start gap-1.5">
                              <span className="text-[9px] mt-[1px]" style={{ color: '#34d399' }}>•</span>
                              <span className="text-[10px] flex-1 leading-snug"
                                    style={{ color: isDark ? '#aaa' : '#444' }}>
                                {item}
                              </span>
                              <button
                                onClick={() => createTaskFromItem(item)}
                                className="shrink-0 text-[8px] px-1.5 py-0.5 rounded font-medium btn-press"
                                style={{
                                  background: 'rgba(52,211,153,0.1)',
                                  color: '#34d399',
                                  border: '1px solid rgba(52,211,153,0.2)'
                                }}
                                title="Create task">
                                + Task
                              </button>
                            </div>
                          ))}
                        </div>
                      ) : (
                        <div className="text-[9px]" style={{ color: isDark ? '#555' : '#999' }}>
                          No action items found.
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )}

              <textarea
                ref={editorRef}
                value={editorContent}
                onChange={e => { setEditorContent(e.target.value); setDirty(true); }}
                className="flex-1 resize-none outline-none text-[12px] leading-relaxed p-3 min-h-0"
                style={{
                  background: isDark ? '#1a1a1a' : '#ffffff',
                  color: isDark ? '#d0d0d0' : '#2a2a2a',
                  caretColor: '#4f9cf9',
                  fontFamily: 'system-ui, -apple-system, sans-serif'
                }}
                spellCheck={false}
                placeholder="Start typing your note here…

You can use multiple lines and paragraphs.

Press Ctrl+S to save."
                autoFocus={!creating}
              />
            </div>

            {/* Status bar */}
            <div className="shrink-0 flex items-center justify-between px-3 py-1.5"
                 style={{
                   background: isDark ? '#141414' : '#f3f4f6',
                   borderTop: `1px solid ${isDark ? '#222' : '#e5e7eb'}`
                 }}>
              <span className="text-[9px] font-mono" style={{ color: isDark ? '#555' : '#999' }}>
                {editorContent.length} chars · {lineCount} lines
              </span>
              <span className="text-[9px] font-mono" style={{ color: dirty ? '#f97316' : '#22c55e' }}>
                {dirty ? '● Unsaved' : '✓ Saved'}
              </span>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/* ── NoteFileRow — File-browser style row ── */
function NoteFileRow({ note, isDark, onOpen, onDelete, onOpenExternal }) {
  const tags = parseTags(note.tags);
  const preview = (note.content || '').split('\n')[0]?.substring(0, 60) || 'Empty note';
  const lineCount = (note.content || '').split('\n').length;
  const charCount = (note.content || '').length;

  return (
    <div
      onClick={onOpen}
      className="group flex items-center gap-2 px-2 py-2 rounded-lg cursor-pointer transition-all hover-lift"
      style={{
        background: isDark ? 'rgba(255,255,255,0.02)' : 'rgba(0,0,0,0.015)',
        border: `1px solid ${isDark ? '#222' : '#eee'}`,
      }}>
      {/* File icon */}
      <div className="shrink-0 w-7 h-7 rounded-md flex items-center justify-center"
           style={{
             background: isDark ? 'rgba(79,156,249,0.08)' : 'rgba(79,156,249,0.06)',
             border: '1px solid rgba(79,156,249,0.15)'
           }}>
        <FileText size={13} style={{ color: '#4f9cf9' }} />
      </div>

      {/* Content */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5">
          <span className="text-[11px] font-semibold truncate"
                style={{ color: isDark ? '#e0e0e0' : '#1a1a1a' }}>
            {note.title || 'Untitled'}
          </span>
          <span className="text-[8px] font-mono shrink-0 opacity-50"
                style={{ color: isDark ? '#555' : '#999' }}>
            .txt
          </span>
        </div>
        <div className="text-[9.5px] truncate mt-0.5" style={{ color: isDark ? '#555' : '#999' }}>
          {preview}
        </div>
        <div className="flex items-center gap-1 mt-1">
          {tags.slice(0, 3).map((tag, i) => (
            <span key={i}
              className="text-[7.5px] px-1.5 py-[1px] rounded-full font-medium"
              style={{
                background: `${TAG_COLORS[i % TAG_COLORS.length]}12`,
                color: TAG_COLORS[i % TAG_COLORS.length],
                border: `1px solid ${TAG_COLORS[i % TAG_COLORS.length]}25`
              }}>
              {tag}
            </span>
          ))}
          {tags.length > 3 && (
            <span className="text-[7.5px]" style={{ color: isDark ? '#444' : '#bbb' }}>
              +{tags.length - 3}
            </span>
          )}
          <span className="text-[7.5px] ml-auto font-mono" style={{ color: isDark ? '#333' : '#ccc' }}>
            {lineCount}L · {charCount > 999 ? `${(charCount / 1000).toFixed(1)}k` : charCount}c
          </span>
          <span className="text-[7.5px] font-mono" style={{ color: isDark ? '#333' : '#ccc' }}>
            {fmtDate(note.updated_at || note.created_at)}
          </span>
        </div>
      </div>

      {/* Hover actions - horizontal layout with bigger, colored buttons */}
      <div className="shrink-0 flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
        <button onClick={(e) => { e.stopPropagation(); onOpenExternal(); }}
          className="px-2 py-1 rounded-md transition-all btn-press font-medium text-[9px] flex items-center gap-1"
          style={{ 
            background: 'rgba(79,156,249,0.1)', 
            color: '#4f9cf9',
            border: '1px solid rgba(79,156,249,0.25)'
          }}
          title="Open in Notepad">
          <FolderOpen size={11} /> Open
        </button>
        <button onClick={(e) => { e.stopPropagation(); onDelete(); }}
          className="px-2 py-1 rounded-md transition-all btn-press font-medium text-[9px] flex items-center gap-1"
          style={{ 
            background: 'rgba(239,68,68,0.1)', 
            color: '#ef4444',
            border: '1px solid rgba(239,68,68,0.25)'
          }}
          title="Delete">
          <Trash2 size={11} /> Delete
        </button>
      </div>
    </div>
  );
}

/* ── Helpers ── */
function parseTags(tagsStr) {
  if (!tagsStr) return [];
  try { return JSON.parse(tagsStr); } catch (_) { return []; }
}

function fmtDate(ts) {
  if (!ts) return '';
  const d = new Date(ts * 1000);
  const now = new Date();
  const diff = now - d;
  if (diff < 60000) return 'now';
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h`;
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}
