import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import {
  RefreshCw, AlertTriangle, MailOpen, Trash2,
  ChevronDown, ChevronRight, Sparkles, Copy, Check,
  Send, CornerUpLeft, Archive, MoreHorizontal,
  Clock, BellRing, Ban, FileText, Wand2, AlarmClock, MailX
} from 'lucide-react';
import { useTheme } from '../../context/ThemeContext';

/* ═══════════════════════════════════════════════
   Helpers
   ═══════════════════════════════════════════════ */

function timeAgo(ts) {
  if (!ts) return '';
  const diff = Math.floor(Date.now() / 1000) - ts;
  if (diff < 60)    return 'now';
  if (diff < 3600)  return `${Math.floor(diff / 60)}m`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h`;
  const d = new Date(ts * 1000);
  const now = new Date();
  if (d.getFullYear() === now.getFullYear())
    return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: '2-digit' });
}

const AVATAR_COLORS = [
  '#4285f4','#ea4335','#34a853','#fbbc04','#ff6d01',
  '#46bdc6','#7baaf7','#f07b72','#57bb8a','#e8710a'
];
function avatarColor(name) {
  let h = 0;
  for (let i = 0; i < (name || '').length; i++) h = name.charCodeAt(i) + ((h << 5) - h);
  return AVATAR_COLORS[Math.abs(h) % AVATAR_COLORS.length];
}

function cleanBody(text) {
  if (!text) return '';
  return text.replace(/\[image:[^\]]*\]/gi, '').replace(/[{}].*?[{}]/g, '').replace(/\s+/g, ' ').trim();
}

function getDisplayCategory(email) {
  const cat = email.category;
  if (['primary', 'social', 'promotions', 'updates'].includes(cat)) return cat;
  if (cat === 'noise') return 'promotions';
  return 'primary';
}

function getSmartGroup(email) {
  const sa = email.smart_action || {};
  if (sa.urgent || sa.risk_level === 'High' || sa.recommended_action === 'Required')
    return 'attention';
  if (sa.email_type === 'Financial' || sa.type === 'payment' || sa.financial_impact)
    return 'finance';
  if (sa.email_type === 'Meeting' || sa.type === 'calendar')
    return 'events';
  return 'other';
}

const SMART_GROUPS = [
  { key: 'attention', label: 'Needs Attention', color: '#ef4444', icon: '🔴' },
  { key: 'finance',   label: 'Finance & Bills', color: '#eab308', icon: '💰' },
  { key: 'events',    label: 'Events',          color: '#a78bfa', icon: '📅' },
  { key: 'other',     label: 'Everything Else',  color: '#6b7280', icon: '📬' },
];

const INBOX_TABS = [
  { key: 'primary',    label: 'Primary' },
  { key: 'social',     label: 'Social' },
  { key: 'promotions', label: 'Promos' },
  { key: 'updates',    label: 'Updates' },
];

/* ═══════════════════════════════════════════════
   InboxRow — compact Gmail-style row for Inbox tab
   ═══════════════════════════════════════════════ */

function InboxRow({ email, isOpen, onToggle, isDark }) {
  const initial = (email.from_name || email.from_email || '?')[0].toUpperCase();
  const bg = avatarColor(email.from_name || email.from_email);
  const snippet = email.summary && email.summary.length < 120
    ? email.summary
    : cleanBody(email.body_preview)?.substring(0, 80) || '';

  return (
    <div onClick={onToggle}
         className="flex items-start gap-2.5 px-3 py-2.5 cursor-pointer transition-colors"
         style={{
           background: isOpen ? (isDark ? '#1a1a1a' : '#f0f4ff') : 'transparent',
           borderLeft: email.smart_action?.urgent ? '3px solid #ef4444' : '3px solid transparent',
         }}>
      <div className="shrink-0 w-8 h-8 rounded-full flex items-center justify-center text-[13px] font-semibold text-white mt-0.5"
           style={{ background: bg }}>
        {initial}
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center justify-between gap-2">
          <span className="text-[13px] font-semibold truncate"
                style={{ color: isDark ? '#e5e5e5' : '#1f2937' }}>
            {email.from_name || email.from_email?.split('@')[0]}
          </span>
          <span className="text-[11px] shrink-0" style={{ color: isDark ? '#555' : '#9ca3af' }}>
            {timeAgo(email.received_at)}
          </span>
        </div>
        <div className="text-[12px] font-medium truncate mt-0.5"
             style={{ color: isDark ? '#b0b0b0' : '#374151' }}>
          {email.subject}
        </div>
        {!isOpen && snippet && (
          <div className="text-[11px] truncate mt-0.5"
               style={{ color: isDark ? '#505050' : '#9ca3af' }}>
            {snippet}
          </div>
        )}
      </div>
    </div>
  );
}

/* ═══════════════════════════════════════════════
   EmailExpanded — full self-contained email view
   Everything happens here. No "open gmail" needed.
   ═══════════════════════════════════════════════ */

function EmailExpanded({ email, onArchive, onDelete, onSnooze, onFollowUp, onBlock, isDark }) {
  const [mode, setMode]         = useState('view');      // 'view' | 'replying' | 'templates' | 'snooze'
  const [drafting, setDrafting]  = useState(false);
  const [draftText, setDraft]    = useState('');
  const [copied, setCopied]      = useState(false);
  const [summarizing, setSumm]   = useState(false);
  const [liveSum, setLiveSum]    = useState(null);
  const [showMore, setShowMore]  = useState(false);
  const [toning, setToning]      = useState(false);
  const [templates, setTemplates] = useState([]);
  const [unsubLink, setUnsubLink] = useState(null);
  const [contactInfo, setContactInfo] = useState(null);
  const replyRef = useRef(null);

  const body    = cleanBody(email.body_preview) || '';
  const summary = email.summary || null;
  const sa      = email.smart_action || {};

  /* Auto-request summary when expanded if none exists */
  useEffect(() => {
    if (!summary && !liveSum && !summarizing) {
      setSumm(true);
      window.aria?.summarizeEmail(email.message_id)
        .then(r => { if (r?.summary) setLiveSum(r.summary); })
        .catch(() => {})
        .finally(() => setSumm(false));
    }
  }, [email.message_id]); // eslint-disable-line

  /* Load reply templates on demand */
  useEffect(() => {
    if (mode === 'templates') {
      window.aria?.getReplyTemplates?.().then(t => setTemplates(t || [])).catch(() => {});
    }
  }, [mode]);

  /* Check for unsubscribe link */
  useEffect(() => {
    window.aria?.getUnsubscribeLink?.(email.message_id)
      .then(r => { if (r?.link) setUnsubLink(r.link); })
      .catch(() => {});
  }, [email.message_id]);

  /* Load contact info for sender */
  useEffect(() => {
    if (email.from_email) {
      window.aria?.getContactByEmail?.(email.from_email)
        .then(c => { if (c) setContactInfo(c); })
        .catch(() => {});
    }
  }, [email.from_email]);

  const displaySummary = liveSum || summary;

  /* Generate AI draft */
  const handleGenerateDraft = async () => {
    setDrafting(true);
    setMode('replying');
    try {
      const res = await window.aria?.aiDraftReply(email.subject, email.from_email, email.body_preview);
      setDraft(res?.draft || res?.error || 'Could not generate draft.');
    } catch (e) { setDraft('Failed: ' + e.message); }
    finally { setDrafting(false); setTimeout(() => replyRef.current?.focus(), 100); }
  };

  /* Tone adjustment */
  const handleTone = async (tone) => {
    if (!draftText.trim()) return;
    setToning(true);
    try {
      const res = await window.aria?.adjustTone(draftText, tone);
      if (res?.text) setDraft(res.text);
    } catch (_) {}
    setToning(false);
  };

  /* Use template */
  const handleUseTemplate = (tpl) => {
    setDraft(tpl.body);
    setMode('replying');
    setTimeout(() => replyRef.current?.focus(), 100);
  };

  /* Copy draft to clipboard */
  const handleCopy = () => {
    navigator.clipboard.writeText(draftText);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  /* Send = copy + open Gmail compose (only escape hatch, clearly labeled) */
  const handleSend = async () => {
    navigator.clipboard.writeText(draftText);
    try { await window.aria?.draftReply(email.message_id, email.subject, email.from_email); } catch (_) {}
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  /* Snooze options */
  const SNOOZE_OPTIONS = [
    { label: '1 hour',       hours: 1 },
    { label: '3 hours',      hours: 3 },
    { label: 'Tomorrow 9am', hours: null, getTs: () => {
      const d = new Date(); d.setDate(d.getDate() + 1); d.setHours(9, 0, 0, 0);
      return Math.floor(d.getTime() / 1000);
    }},
    { label: 'Next Monday',  hours: null, getTs: () => {
      const d = new Date(); d.setDate(d.getDate() + ((8 - d.getDay()) % 7 || 7)); d.setHours(9, 0, 0, 0);
      return Math.floor(d.getTime() / 1000);
    }},
  ];

  const handleSnooze = (opt) => {
    const until = opt.getTs ? opt.getTs() : Math.floor(Date.now() / 1000) + (opt.hours * 3600);
    onSnooze?.(email, until);
    setMode('view');
  };

  const accent = isDark ? '#222' : '#e5e7eb';

  return (
    <div style={{ background: isDark ? '#111' : '#fafbfc', borderTop: `1px solid ${accent}` }}
         onClick={e => e.stopPropagation()}>

      {/* ── From + subject context ── */}
      <div className="px-4 pt-3 pb-1">
        <div className="text-[11px] mb-1" style={{ color: isDark ? '#555' : '#9ca3af' }}>
          {email.from_email}
        </div>
        {contactInfo && (
          <div className="text-[9px] mb-1 flex items-center gap-1.5 flex-wrap" style={{ color: isDark ? '#4a4a4a' : '#b0b0b0' }}>
            {contactInfo.company && <span>🏢 {contactInfo.company}</span>}
            {contactInfo.contact_count > 0 && <span>· {contactInfo.contact_count} emails</span>}
            {contactInfo.last_contacted_at && (
              <span>· Last: {Math.floor((Date.now() / 1000 - contactInfo.last_contacted_at) / 86400)}d ago</span>
            )}
            {contactInfo.tags && (() => { try { const t = JSON.parse(contactInfo.tags); return t.length > 0 ? <span>· {t.join(', ')}</span> : null; } catch(_) { return null; } })()}
          </div>
        )}
      </div>

      {/* ── Smart summary (auto-loaded) ── */}
      {summarizing && (
        <div className="px-4 pb-2">
          <div className="flex items-center gap-1.5 text-[11px]" style={{ color: isDark ? '#444' : '#9ca3af' }}>
            <Sparkles size={10} className="animate-pulse" /> Summarizing...
          </div>
        </div>
      )}
      {displaySummary && (
        <div className="mx-4 mb-2 rounded-lg px-3 py-2.5"
             style={{
               background: isDark ? '#162016' : '#f0fdf4',
               border: `1px solid ${isDark ? '#1e3a26' : '#bbf7d0'}`,
             }}>
          <div className="text-[11px] leading-relaxed"
               style={{ color: isDark ? '#86efac' : '#166534' }}>
            {displaySummary}
          </div>
        </div>
      )}

      {/* ── Insight badges ── */}
      {(sa.email_type || sa.risk_level || sa.financial_impact || sa.deadline || sa.recommended_action) && (
        <div className="flex items-center gap-1.5 px-4 pb-2 flex-wrap">
          {sa.email_type && <Pill label={sa.email_type} isDark={isDark} />}
          {sa.risk_level && sa.risk_level !== 'Low' && (
            <Pill label={`${sa.risk_level} Risk`} isDark={isDark}
                  color={sa.risk_level === 'High' ? '#ef4444' : '#f59e0b'} />
          )}
          {sa.financial_impact && <Pill label={`₹ ${sa.financial_impact}`} isDark={isDark} color="#eab308" />}
          {sa.deadline && <Pill label={sa.deadline} isDark={isDark} color="#a78bfa" />}
          {sa.recommended_action && (
            <Pill label={sa.recommended_action} isDark={isDark}
                  color={sa.recommended_action === 'Required' ? '#ef4444' : '#6b7280'} />
          )}
          {emailRouteTargets(sa).map(t => (
            <RoutePill key={t} label={t} isDark={isDark} />
          ))}
          {/* Follow-up indicator */}
          {email.follow_up_at && (
            <Pill label={`Follow-up ${timeAgo(email.follow_up_at)}`} isDark={isDark} color="#f97316" />
          )}
        </div>
      )}

      {/* ── Body (collapsible original) ── */}
      {body && (
        <div className="px-4 pb-2">
          <button onClick={() => setShowMore(s => !s)}
                  className="text-[10px] font-medium mb-1 flex items-center gap-1"
                  style={{ color: isDark ? '#444' : '#9ca3af' }}>
            {showMore ? <ChevronDown size={10} /> : <ChevronRight size={10} />}
            {showMore ? 'Hide original' : 'Show original'}
          </button>
          {showMore && (
            <div className="text-[11px] leading-relaxed rounded-lg px-3 py-2"
                 style={{
                   color: isDark ? '#777' : '#6b7280',
                   background: isDark ? '#151515' : '#f9fafb',
                   maxHeight: 180, overflowY: 'auto',
                 }}>
              {body.substring(0, 600)}
            </div>
          )}
        </div>
      )}

      {/* ── AI suggestion (subtle) ── */}
      {sa.suggestion && mode === 'view' && (
        <div className="px-4 pb-2">
          <div className="text-[10px] leading-snug px-3 py-2 rounded-lg"
               style={{
                 background: isDark ? '#17151f' : '#faf5ff',
                 border: `1px solid ${isDark ? '#251f35' : '#e9d5ff'}`,
                 color: isDark ? '#a78bfa' : '#7c3aed',
               }}>
            <span className="font-medium">Suggested:</span> {sa.suggestion}
          </div>
        </div>
      )}

      {/* ── Snooze picker (inline dropdown) ── */}
      {mode === 'snooze' && (
        <div className="mx-4 mb-2 rounded-lg overflow-hidden"
             style={{ border: `1px solid ${isDark ? '#2d3548' : '#dbeafe'}`, background: isDark ? '#111827' : '#eff6ff' }}>
          <div className="px-3 py-1.5 flex items-center justify-between"
               style={{ borderBottom: `1px solid ${isDark ? '#1e2d4a' : '#dbeafe'}` }}>
            <span className="text-[10px] font-semibold uppercase tracking-wider"
                  style={{ color: isDark ? '#60a5fa' : '#2563eb' }}>
              <AlarmClock size={10} className="inline mr-1" /> Snooze Until
            </span>
            <button onClick={() => setMode('view')} className="text-[10px]" style={{ color: isDark ? '#555' : '#9ca3af' }}>Cancel</button>
          </div>
          <div className="flex flex-col">
            {SNOOZE_OPTIONS.map((opt, i) => (
              <button key={i} onClick={() => handleSnooze(opt)}
                      className="text-left px-3 py-2 text-[11px] font-medium transition-colors hover:opacity-80"
                      style={{
                        color: isDark ? '#93c5fd' : '#1d4ed8',
                        borderBottom: i < SNOOZE_OPTIONS.length - 1 ? `1px solid ${isDark ? '#1e2d4a' : '#dbeafe'}` : 'none',
                      }}>
                {opt.label}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* ── Reply templates picker ── */}
      {mode === 'templates' && (
        <div className="mx-4 mb-2 rounded-lg overflow-hidden"
             style={{ border: `1px solid ${isDark ? '#2d2545' : '#e9d5ff'}`, background: isDark ? '#151020' : '#faf8ff' }}>
          <div className="px-3 py-1.5 flex items-center justify-between"
               style={{ borderBottom: `1px solid ${isDark ? '#221d33' : '#ede9fe'}` }}>
            <span className="text-[10px] font-semibold uppercase tracking-wider"
                  style={{ color: isDark ? '#a78bfa' : '#7c3aed' }}>
              <FileText size={10} className="inline mr-1" /> Quick Reply
            </span>
            <button onClick={() => setMode('view')} className="text-[10px]" style={{ color: isDark ? '#555' : '#9ca3af' }}>Cancel</button>
          </div>
          <div className="flex flex-col">
            {templates.length === 0 ? (
              <div className="px-3 py-3 text-[10px]" style={{ color: isDark ? '#555' : '#9ca3af' }}>No templates yet</div>
            ) : templates.map((tpl, i) => (
              <button key={tpl.id} onClick={() => handleUseTemplate(tpl)}
                      className="text-left px-3 py-2 transition-colors hover:opacity-80"
                      style={{ borderBottom: i < templates.length - 1 ? `1px solid ${isDark ? '#221d33' : '#ede9fe'}` : 'none' }}>
                <div className="text-[11px] font-medium" style={{ color: isDark ? '#c4b5fd' : '#6d28d9' }}>
                  {tpl.shortcut && <span className="font-mono mr-1.5" style={{ color: isDark ? '#666' : '#a78bfa' }}>{tpl.shortcut}</span>}
                  {tpl.title}
                </div>
                <div className="text-[9px] truncate mt-0.5" style={{ color: isDark ? '#555' : '#9ca3af' }}>
                  {tpl.body.substring(0, 60)}...
                </div>
              </button>
            ))}
          </div>
        </div>
      )}

      {/* ── Reply composer ── */}
      {mode === 'replying' && (
        <div className="mx-4 mb-2 rounded-lg overflow-hidden"
             style={{
               border: `1px solid ${isDark ? '#2d2545' : '#ddd6fe'}`,
               background: isDark ? '#151020' : '#faf8ff',
             }}>
          <div className="px-3 py-1.5 flex items-center justify-between"
               style={{ borderBottom: `1px solid ${isDark ? '#221d33' : '#ede9fe'}` }}>
            <span className="text-[10px] font-semibold uppercase tracking-wider"
                  style={{ color: isDark ? '#7c3aed' : '#6d28d9' }}>
              Reply Draft
            </span>
            {drafting && (
              <span className="text-[10px] flex items-center gap-1" style={{ color: isDark ? '#555' : '#9ca3af' }}>
                <Sparkles size={9} className="animate-pulse" /> Generating...
              </span>
            )}
          </div>
          <textarea
            ref={replyRef}
            value={draftText}
            onChange={e => setDraft(e.target.value)}
            rows={5}
            className="w-full px-3 py-2 text-[12px] leading-relaxed resize-none outline-none"
            style={{
              background: 'transparent',
              color: isDark ? '#c4b5fd' : '#4c1d95',
            }}
            placeholder={drafting ? 'AI is writing...' : 'Write your reply...'}
            disabled={drafting}
          />
          {/* Tone adjustment strip (Grammarly-style) */}
          {draftText && !drafting && (
            <div className="flex items-center gap-1 px-3 pb-1.5">
              <Wand2 size={9} style={{ color: isDark ? '#555' : '#9ca3af' }} />
              <span className="text-[9px] mr-1" style={{ color: isDark ? '#444' : '#9ca3af' }}>Tone:</span>
              {['professional', 'friendly', 'concise', 'assertive'].map(tone => (
                <button key={tone} onClick={() => handleTone(tone)} disabled={toning}
                        className="text-[9px] px-2 py-0.5 rounded-full font-medium transition-all hover:opacity-80 disabled:opacity-30"
                        style={{
                          color: isDark ? '#888' : '#6b7280',
                          background: isDark ? '#1a1a1a' : '#f3f4f6',
                          border: `1px solid ${isDark ? '#2a2a2a' : '#e5e7eb'}`,
                        }}>
                  {toning ? '...' : tone.charAt(0).toUpperCase() + tone.slice(1)}
                </button>
              ))}
            </div>
          )}
          {draftText && !drafting && (
            <div className="flex items-center gap-2 px-3 pb-2.5">
              <button onClick={handleSend}
                      className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[11px] font-semibold transition-all hover:opacity-90"
                      style={{
                        background: isDark ? '#7c3aed' : '#7c3aed',
                        color: '#fff',
                      }}>
                <Send size={10} /> Send via Gmail
              </button>
              <button onClick={handleCopy}
                      className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-[11px] font-medium transition-all hover:opacity-80"
                      style={{
                        color: isDark ? '#888' : '#6b7280',
                        background: isDark ? '#1e1e1e' : '#f3f4f6',
                      }}>
                {copied ? <><Check size={10} /> Copied</> : <><Copy size={10} /> Copy</>}
              </button>
              <button onClick={() => { setMode('view'); setDraft(''); }}
                      className="text-[10px] ml-auto" style={{ color: isDark ? '#444' : '#9ca3af' }}>
                Cancel
              </button>
            </div>
          )}
        </div>
      )}

      {/* ── Action bar — Superhuman-grade ── */}
      <div className="flex items-center gap-1.5 px-3 pb-3 pt-1 flex-wrap">
        {/* Primary: Reply with AI */}
        {mode === 'view' && (
          <button onClick={handleGenerateDraft}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[11px] font-semibold transition-all hover:opacity-90"
                  style={{
                    background: isDark ? 'rgba(124,58,237,0.15)' : 'rgba(124,58,237,0.08)',
                    color: '#a78bfa',
                    border: `1px solid ${isDark ? '#2d2545' : '#e9d5ff'}`,
                  }}>
            <CornerUpLeft size={11} /> Reply
          </button>
        )}
        {/* Templates */}
        {mode === 'view' && (
          <button onClick={() => setMode('templates')}
                  className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-[11px] font-medium transition-all hover:opacity-80"
                  style={{
                    color: isDark ? '#888' : '#6b7280',
                    background: isDark ? 'rgba(255,255,255,0.03)' : 'rgba(0,0,0,0.03)',
                    border: `1px solid ${isDark ? '#222' : '#e5e7eb'}`,
                  }}>
            <FileText size={10} /> Template
          </button>
        )}
        {/* Archive / Done */}
        <button onClick={() => onArchive(email)}
                className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-[11px] font-medium transition-all hover:opacity-80"
                style={{
                  color: '#22c55e',
                  background: isDark ? 'rgba(34,197,94,0.08)' : 'rgba(34,197,94,0.06)',
                  border: `1px solid ${isDark ? '#1a3a24' : '#bbf7d0'}`,
                }}>
          <Archive size={10} /> Done
        </button>
        {/* Snooze */}
        <button onClick={() => setMode(mode === 'snooze' ? 'view' : 'snooze')}
                className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-[11px] font-medium transition-all hover:opacity-80"
                style={{
                  color: '#60a5fa',
                  background: isDark ? 'rgba(96,165,250,0.08)' : 'rgba(96,165,250,0.06)',
                  border: `1px solid ${isDark ? '#1e3a5f' : '#bfdbfe'}`,
                }}>
          <AlarmClock size={10} /> Snooze
        </button>
        {/* Follow-up */}
        {mode === 'view' && (
          <button onClick={() => onFollowUp?.(email, 48)}
                  className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-[11px] font-medium transition-all hover:opacity-80"
                  title="Remind me if no reply in 2 days"
                  style={{
                    color: '#f97316',
                    background: isDark ? 'rgba(249,115,22,0.08)' : 'rgba(249,115,22,0.05)',
                    border: `1px solid ${isDark ? '#5f3a1e' : '#fed7aa'}`,
                  }}>
            <BellRing size={10} /> Follow-up
          </button>
        )}
        {/* Spacer */}
        <div className="flex-1" />
        {/* Unsubscribe */}
        {unsubLink && (
          <button onClick={() => window.aria?.openExternal?.(unsubLink) || window.open(unsubLink, '_blank')}
                  className="p-1.5 rounded-lg transition-opacity hover:opacity-70"
                  title="Unsubscribe from this sender"
                  style={{ color: '#f97316' }}>
            <MailX size={12} />
          </button>
        )}
        {/* Block sender */}
        <button onClick={() => onBlock?.(email)}
                className="p-1.5 rounded-lg transition-opacity hover:opacity-70"
                title="Block this sender"
                style={{ color: isDark ? '#333' : '#d1d5db' }}>
          <Ban size={12} />
        </button>
        {/* Delete — subtle */}
        <button onClick={() => onDelete(email)}
                className="p-1.5 rounded-lg transition-opacity hover:opacity-70"
                style={{ color: isDark ? '#333' : '#d1d5db' }}>
          <Trash2 size={12} />
        </button>
      </div>
    </div>
  );
}

function Pill({ label, isDark, color }) {
  const c = color || (isDark ? '#555' : '#6b7280');
  return (
    <span className="text-[9px] font-semibold px-2 py-0.5 rounded-full tracking-wide"
          style={{
            color: c,
            background: `${c}12`,
            border: `1px solid ${c}25`,
          }}>
      {label}
    </span>
  );
}

function RoutePill({ label, isDark }) {
  const c = label.includes('Tasks') ? '#22c55e' : '#eab308';
  return (
    <span className="text-[8px] font-bold px-1.5 py-0.5 rounded tracking-wider uppercase"
          style={{
            color: c,
            background: `${c}15`,
            border: `1px dashed ${c}40`,
          }}>
      {label}
    </span>
  );
}

function emailRouteTargets(sa) {
  const targets = [];
  if (sa.deadline || (sa.recommended_action === 'Required' && (sa.urgent || sa.risk_level === 'High')))
    targets.push('→ Tasks');
  if (sa.financial_impact || sa.email_type === 'Financial')
    targets.push('→ Money');
  return targets;
}

/* ═══════════════════════════════════════════════
   SmartCard — rich card for Smart tab
   ═══════════════════════════════════════════════ */

function SmartCard({ email, isOpen, onToggle, onArchive, onDelete, onSnooze, onFollowUp, onBlock, isDark }) {
  const sa = email.smart_action || {};
  const initial = (email.from_name || email.from_email || '?')[0].toUpperCase();
  const bg = avatarColor(email.from_name || email.from_email);

  return (
    <div style={{
      background: isDark ? '#151515' : '#ffffff',
      borderRadius: 12,
      border: `1px solid ${isDark ? (isOpen ? '#2a2a2a' : '#1e1e1e') : (isOpen ? '#d1d5db' : '#e5e7eb')}`,
      marginBottom: 8,
      overflow: 'hidden',
      transition: 'border-color 0.15s',
    }}>
      {/* Header row */}
      <div onClick={onToggle} className="flex items-start gap-2.5 px-3 py-3 cursor-pointer">
        <div className="shrink-0 w-8 h-8 rounded-full flex items-center justify-center text-[12px] font-bold text-white mt-0.5"
             style={{ background: bg }}>
          {initial}
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5">
            <span className="text-[13px] font-semibold truncate"
                  style={{ color: isDark ? '#e5e5e5' : '#111827' }}>
              {email.from_name || email.from_email?.split('@')[0]}
            </span>
            {sa.urgent && (
              <span className="text-[8px] font-bold tracking-wider px-1.5 py-0.5 rounded-full shrink-0"
                    style={{ color: '#fff', background: '#ef4444' }}>
                URGENT
              </span>
            )}
            <span className="text-[10px] ml-auto shrink-0" style={{ color: isDark ? '#444' : '#9ca3af' }}>
              {timeAgo(email.received_at)}
            </span>
          </div>
          <div className="text-[12px] font-medium truncate mt-0.5"
               style={{ color: isDark ? '#b0b0b0' : '#374151' }}>
            {email.subject}
          </div>
          {/* Inline summary preview */}
          {!isOpen && email.summary && (
            <div className="text-[11px] mt-1 leading-snug"
                 style={{
                   color: isDark ? '#666' : '#9ca3af',
                   display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden'
                 }}>
              {email.summary}
            </div>
          )}
          {/* Compact badges when collapsed */}
          {!isOpen && (sa.email_type || sa.financial_impact || sa.deadline || sa.urgent) && (
            <div className="flex items-center gap-1.5 mt-1.5 flex-wrap">
              {sa.email_type && <Pill label={sa.email_type} isDark={isDark} />}
              {sa.financial_impact && <Pill label={`₹ ${sa.financial_impact}`} isDark={isDark} color="#eab308" />}
              {emailRouteTargets(sa).map(t => (
                <RoutePill key={t} label={t} isDark={isDark} />
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Full expanded view */}
      {isOpen && (
        <EmailExpanded email={email} onArchive={onArchive} onDelete={onDelete}
                       onSnooze={onSnooze} onFollowUp={onFollowUp} onBlock={onBlock} isDark={isDark} />
      )}
    </div>
  );
}

/* ═══════════════════════════════════════════════
   SmartSection — collapsible group
   ═══════════════════════════════════════════════ */

function SmartSection({ group, emails, openId, setOpenId, hiddenIds, onArchive, onDelete, onSnooze, onFollowUp, onBlock, isDark }) {
  const [collapsed, setCollapsed] = useState(false);

  return (
    <div className="mb-4">
      <button onClick={() => setCollapsed(c => !c)}
              className="flex items-center gap-1.5 w-full text-left px-1 py-1 mb-1">
        <span className="text-[12px]">{group.icon}</span>
        <span className="text-[11px] font-bold uppercase tracking-wider"
              style={{ color: group.color }}>
          {group.label}
        </span>
        <span className="text-[10px] font-semibold ml-0.5" style={{ color: isDark ? '#444' : '#d1d5db' }}>
          {emails.length}
        </span>
        <span className="ml-auto" style={{ color: isDark ? '#333' : '#d1d5db' }}>
          {collapsed ? <ChevronRight size={11} /> : <ChevronDown size={11} />}
        </span>
      </button>

      {!collapsed && emails.map(email => (
        <div key={email.message_id}
             className={`transition-all duration-150 ${hiddenIds.has(email.message_id) ? 'opacity-0 scale-95' : ''}`}>
          <SmartCard
            email={email}
            isOpen={openId === email.message_id}
            onToggle={() => setOpenId(openId === email.message_id ? null : email.message_id)}
            onArchive={onArchive}
            onDelete={onDelete}
            onSnooze={onSnooze}
            onFollowUp={onFollowUp}
            onBlock={onBlock}
            isDark={isDark}
          />
        </div>
      ))}
    </div>
  );
}

/* ═══════════════════════════════════════════════
   SkeletonLoader
   ═══════════════════════════════════════════════ */

function SkeletonLoader({ isDark }) {
  const s1 = isDark ? '#1a1a1a' : '#f3f4f6';
  const s2 = isDark ? '#161616' : '#e5e7eb';
  return (
    <div className="flex-1 p-3 flex flex-col gap-3">
      {[1, 2, 3, 4].map(i => (
        <div key={i} className="rounded-xl p-3 animate-pulse"
             style={{ background: isDark ? '#131313' : '#fff', border: `1px solid ${isDark ? '#1e1e1e' : '#e5e7eb'}` }}>
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-full" style={{ background: s1 }} />
            <div className="flex-1 flex flex-col gap-1.5">
              <div className="h-3 rounded w-2/3" style={{ background: s1 }} />
              <div className="h-2.5 rounded w-full" style={{ background: s2 }} />
            </div>
            <div className="h-2.5 w-6 rounded" style={{ background: s2 }} />
          </div>
          <div className="mt-3 h-10 rounded-lg" style={{ background: s2 }} />
        </div>
      ))}
      <div className="text-center text-[10px] mt-1" style={{ color: isDark ? '#333' : '#9ca3af' }}>
        Loading your emails...
      </div>
    </div>
  );
}

/* ═══════════════════════════════════════════════
   SetupCard
   ═══════════════════════════════════════════════ */

function SetupCard({ isDark }) {
  return (
    <div className="rounded-xl p-4 mx-3 mt-3"
         style={{
           background: isDark ? '#151515' : '#ffffff',
           border: `1px solid ${isDark ? '#222' : '#e5e7eb'}`
         }}>
      <div className="flex items-center gap-2 mb-3">
        <MailOpen size={18} style={{ color: '#7c3aed' }} />
        <span className="text-[14px] font-semibold" style={{ color: isDark ? '#e5e5e5' : '#1f2937' }}>
          Connect Gmail
        </span>
      </div>
      <div className="text-[12px] leading-relaxed" style={{ color: isDark ? '#666' : '#6b7280' }}>
        <p>ARIA handles your emails so you never need to open Gmail.</p>
        <p className="mt-2">Go to <span style={{ color: '#7c3aed' }} className="font-medium">Settings</span> to connect your account.</p>
      </div>
    </div>
  );
}

/* ═══════════════════════════════════════════════
   EmptyState
   ═══════════════════════════════════════════════ */

function EmptyState({ isDark, title, sub }) {
  return (
    <div className="flex flex-col items-center justify-center py-16 gap-2">
      <MailOpen size={28} style={{ color: isDark ? '#252525' : '#d1d5db' }} />
      <div className="text-[13px] font-medium" style={{ color: isDark ? '#555' : '#6b7280' }}>
        {title}
      </div>
      <div className="text-[11px]" style={{ color: isDark ? '#333' : '#9ca3af' }}>
        {sub}
      </div>
    </div>
  );
}

/* ═══════════════════════════════════════════════
   MAIN — Mail Panel
   ═══════════════════════════════════════════════ */

export default function Mail() {
  const { theme } = useTheme();
  const isDark = theme === 'dark';

  /* State */
  const [emails,        setEmails]        = useState([]);
  const [loading,       setLoading]       = useState(true);
  const [refreshing,    setRefreshing]    = useState(false);
  const [error,         setError]         = useState(null);
  const [needsSetup,    setNeedsSetup]    = useState(false);
  const [hiddenIds,     setHiddenIds]     = useState(new Set());
  const [confirmDelete, setConfirmDelete] = useState(null);
  const [undoTimer,     setUndoTimer]     = useState(null);

  /* Smart is default — the intelligent view is the whole point */
  const [view,     setView]     = useState('smart');
  const [inboxTab, setInboxTab] = useState('primary');
  const [openId,   setOpenId]   = useState(null);

  /* Data */
  const removeEmail = useCallback((id) => {
    setHiddenIds(p => new Set([...p, id]));
    setTimeout(() => {
      setEmails(p => p.filter(e => e.message_id !== id));
      setHiddenIds(p => { const n = new Set(p); n.delete(id); return n; });
    }, 200);
  }, []);

  const loadEmails = useCallback(async (refresh = false) => {
    try {
      if (refresh) setRefreshing(true); else setLoading(true);
      setError(null);
      const data = refresh
        ? await window.aria?.refreshEmails()
        : await window.aria?.getEmails();
      if (data?.needsSetup) { setNeedsSetup(true); setEmails([]); }
      else if (data?.emails !== undefined) {
        setEmails(data.emails || []);
        if (data.error) setError(data.error);
      } else if (Array.isArray(data)) { setEmails(data); }
    } catch (err) { setError(err.message || 'Failed to load emails'); }
    finally { setLoading(false); setRefreshing(false); }
  }, []);

  useEffect(() => { loadEmails(false); setTimeout(() => loadEmails(true), 400); }, []); // eslint-disable-line
  useEffect(() => {
    if (!window.aria?.onEmailsUpdated) return;
    window.aria.onEmailsUpdated(() => loadEmails(false));
  }, [loadEmails]);
  useEffect(() => {
    const iv = setInterval(() => { if (!refreshing && !loading) loadEmails(true); }, 5 * 60 * 1000);
    return () => clearInterval(iv);
  }, [loadEmails, refreshing, loading]);

  /* Actions */
  const handleArchive = useCallback(async (email) => {
    try { await window.aria?.markEmailRead(email.message_id); } catch (_) {}
    removeEmail(email.message_id);
  }, [removeEmail]);

  const handleDelete = useCallback((email) => {
    setConfirmDelete(email.message_id);
    const t = setTimeout(async () => {
      setConfirmDelete(null);
      try { await window.aria?.deleteEmail(email.message_id); } catch (_) {}
      removeEmail(email.message_id);
    }, 3000);
    setUndoTimer(t);
  }, [removeEmail]);

  const handleUndoDelete = useCallback(() => {
    if (undoTimer) clearTimeout(undoTimer);
    setConfirmDelete(null); setUndoTimer(null);
  }, [undoTimer]);

  /* Snooze email — Superhuman-style: vanish now, come back later */
  const handleSnooze = useCallback(async (email, untilTs) => {
    try { await window.aria?.snoozeEmail(email.message_id, untilTs); } catch (_) {}
    removeEmail(email.message_id);
  }, [removeEmail]);

  /* Follow-up reminder — Boomerang-style: remind if no reply in N hours */
  const handleFollowUp = useCallback(async (email, hours) => {
    try { await window.aria?.followUpEmail(email.message_id, hours); } catch (_) {}
    // Visual feedback: update local state
    setEmails(prev => prev.map(e =>
      e.message_id === email.message_id
        ? { ...e, follow_up_at: Math.floor(Date.now() / 1000) + (hours * 3600) }
        : e
    ));
  }, []);

  /* Block sender — SaneBox-style: never see emails from this sender again */
  const handleBlock = useCallback(async (email) => {
    try { await window.aria?.blockSender(email.from_email); } catch (_) {}
    setEmails(prev => prev.filter(e => e.from_email !== email.from_email));
  }, []);

  /* Computed */
  const tabCounts = useMemo(() => {
    const c = {};
    INBOX_TABS.forEach(t => { c[t.key] = 0; });
    emails.forEach(e => { const k = getDisplayCategory(e); if (c[k] !== undefined) c[k]++; });
    return c;
  }, [emails]);

  const smartGroups = useMemo(() => {
    const groups = {};
    SMART_GROUPS.forEach(g => { groups[g.key] = []; });
    emails.forEach(e => {
      const k = getSmartGroup(e);
      if (groups[k]) groups[k].push(e);
      else groups.other.push(e);
    });
    return groups;
  }, [emails]);

  const urgentCount = useMemo(() => emails.filter(e => e.smart_action?.urgent).length, [emails]);

  const inboxEmails = useMemo(() =>
    emails.filter(e => getDisplayCategory(e) === inboxTab)
  , [emails, inboxTab]);

  /* Render gates */
  if (loading) return <SkeletonLoader isDark={isDark} />;
  if (needsSetup) return <div className="flex-1 p-3"><SetupCard isDark={isDark} /></div>;

  return (
    <div className="flex-1 min-h-0 flex flex-col overflow-hidden">

      {/* ═══ Top bar ═══ */}
      <div className="flex items-center justify-between px-3 py-1.5 shrink-0">
        <div className="flex items-center gap-0.5 rounded-lg p-0.5"
             style={{ background: isDark ? '#111' : '#f3f4f6' }}>
          {/* Smart first — it's the star */}
          <TabBtn label="Smart" active={view === 'smart'}
                  badge={urgentCount > 0 ? urgentCount : null}
                  onClick={() => { setView('smart'); setOpenId(null); }} isDark={isDark} />
          <TabBtn label="Inbox" active={view === 'inbox'}
                  onClick={() => { setView('inbox'); setOpenId(null); }} isDark={isDark} />
        </div>
        <button onClick={() => loadEmails(true)} disabled={refreshing}
                className="flex items-center gap-1 text-[11px] font-medium disabled:opacity-30 transition-opacity px-2 py-1 rounded-lg"
                style={{
                  color: isDark ? '#666' : '#9ca3af',
                  background: refreshing ? (isDark ? '#111' : '#f3f4f6') : 'transparent',
                }}>
          <RefreshCw size={11} className={refreshing ? 'animate-spin' : ''} />
          {refreshing ? 'Syncing' : 'Sync'}
        </button>
      </div>

      {/* ═══ Error / Toast ═══ */}
      {error && (
        <div className="mx-2.5 mb-1 rounded-lg px-2.5 py-1.5 text-[10px] text-[#f97316] flex items-center gap-1.5 shrink-0"
             style={{ background: 'rgba(249,115,22,0.06)', border: '1px solid rgba(249,115,22,0.12)' }}>
          <AlertTriangle size={11} /> {error}
        </div>
      )}
      {confirmDelete && (
        <div className="mx-2.5 mb-1 rounded-lg px-2.5 py-1.5 text-[10px] text-[#ef4444] flex items-center justify-between shrink-0"
             style={{ background: 'rgba(239,68,68,0.06)', border: '1px solid rgba(239,68,68,0.12)' }}>
          <span>Deleting...</span>
          <button onClick={handleUndoDelete} className="underline ml-2"
                  style={{ color: isDark ? '#e5e5e5' : '#1f2937' }}>Undo</button>
        </div>
      )}

      {/* ═══ SMART VIEW — default ═══ */}
      {view === 'smart' && (
        <div className="flex-1 min-h-0 overflow-y-auto px-2.5 py-2">
          {emails.length === 0 ? (
            <EmptyState isDark={isDark} title="No emails yet" sub="Tap Sync to fetch your inbox" />
          ) : (
            SMART_GROUPS.map(group => {
              const items = smartGroups[group.key] || [];
              if (items.length === 0) return null;
              return (
                <SmartSection
                  key={group.key}
                  group={group}
                  emails={items}
                  openId={openId}
                  setOpenId={setOpenId}
                  hiddenIds={hiddenIds}
                  onArchive={handleArchive}
                  onDelete={handleDelete}
                  onSnooze={handleSnooze}
                  onFollowUp={handleFollowUp}
                  onBlock={handleBlock}
                  isDark={isDark}
                />
              );
            })
          )}
        </div>
      )}

      {/* ═══ INBOX VIEW ═══ */}
      {view === 'inbox' && (
        <>
          <div className="flex shrink-0"
               style={{ borderBottom: `1px solid ${isDark ? '#1c1c1c' : '#e5e7eb'}` }}>
            {INBOX_TABS.map(tab => {
              const active = inboxTab === tab.key;
              const count  = tabCounts[tab.key] || 0;
              return (
                <button key={tab.key} onClick={() => { setInboxTab(tab.key); setOpenId(null); }}
                        className="flex-1 py-1.5 text-center text-[11px] font-medium transition-all"
                        style={{
                          color: active ? '#7c3aed' : (isDark ? '#444' : '#9ca3af'),
                          borderBottom: active ? '2px solid #7c3aed' : '2px solid transparent',
                        }}>
                  {tab.label}
                  {count > 0 && <span className="ml-0.5 text-[9px]" style={{ opacity: 0.5 }}>{count}</span>}
                </button>
              );
            })}
          </div>

          <div className="flex-1 min-h-0 overflow-y-auto">
            {inboxEmails.length === 0 ? (
              <EmptyState isDark={isDark}
                          title={emails.length === 0 ? 'No emails' : `No ${inboxTab} emails`}
                          sub={emails.length === 0 ? 'Tap Sync to fetch' : 'Try another tab'} />
            ) : (
              inboxEmails.map(email => (
                <div key={email.message_id}
                     className={`transition-all duration-150 ${hiddenIds.has(email.message_id) ? 'opacity-0' : ''}`}
                     style={{ borderBottom: `1px solid ${isDark ? '#1a1a1a' : '#f3f4f6'}` }}>
                  <InboxRow
                    email={email}
                    isOpen={openId === email.message_id}
                    onToggle={() => setOpenId(openId === email.message_id ? null : email.message_id)}
                    isDark={isDark}
                  />
                  {openId === email.message_id && (
                    <EmailExpanded email={email} onArchive={handleArchive} onDelete={handleDelete}
                                   onSnooze={handleSnooze} onFollowUp={handleFollowUp} onBlock={handleBlock} isDark={isDark} />
                  )}
                </div>
              ))
            )}
          </div>
        </>
      )}
    </div>
  );
}

/* ═══════════════════════════════════════════════
   TabBtn — top-level view switcher
   ═══════════════════════════════════════════════ */

function TabBtn({ label, active, badge, onClick, isDark }) {
  return (
    <button onClick={onClick}
            className="relative text-[12px] font-semibold px-3 py-1 rounded-md transition-all"
            style={{
              color: active ? (isDark ? '#e5e5e5' : '#111827') : (isDark ? '#555' : '#9ca3af'),
              background: active ? (isDark ? '#1e1e1e' : '#ffffff') : 'transparent',
              boxShadow: active ? (isDark ? '0 1px 3px rgba(0,0,0,0.3)' : '0 1px 2px rgba(0,0,0,0.06)') : 'none',
            }}>
      {label}
      {badge && (
        <span className="absolute -top-1 -right-1 text-[8px] font-bold w-4 h-4 rounded-full flex items-center justify-center"
              style={{ color: '#fff', background: '#ef4444' }}>
          {badge}
        </span>
      )}
    </button>
  );
}
