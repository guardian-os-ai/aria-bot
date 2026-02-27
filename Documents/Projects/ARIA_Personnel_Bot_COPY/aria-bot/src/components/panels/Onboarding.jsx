import React, { useState } from 'react';
import { useTheme } from '../../context/ThemeContext';
import { CheckCircle2, Mail, Calendar, Zap, ArrowRight, Loader } from 'lucide-react';

/**
 * Onboarding — First-run wizard (P7-1).
 * Steps: Gmail → iCal (optional) → Ingest → Done
 */
export default function Onboarding({ onComplete }) {
  const { theme } = useTheme();
  const isDark = theme === 'dark';

  const [step, setStep]         = useState(0); // 0=intro, 1=gmail, 2=ical, 3=ingest, 4=done
  const [icalUrl, setIcalUrl]   = useState('');
  const [busy, setBusy]         = useState(false);
  const [progress, setProgress] = useState('');
  const [error, setError]       = useState('');

  const bg     = isDark ? '#1a1a1a' : '#f5f5f5';
  const card   = isDark ? 'rgba(255,255,255,0.03)' : 'rgba(0,0,0,0.04)';
  const border = isDark ? '#2a2a2a' : '#d0d0d0';
  const text   = isDark ? '#e0e0e0' : '#1f2937';
  const muted  = isDark ? '#555' : '#9ca3af';

  const connectGmail = async () => {
    setBusy(true);
    setError('');
    try {
      const result = await window.aria?.connectGmail?.();
      if (result?.error) { setError(result.error); setBusy(false); return; }
      setStep(2);
    } catch (e) { setError(e.message); }
    setBusy(false);
  };

  const saveIcal = async () => {
    if (icalUrl.trim()) {
      await window.aria?.saveSetting?.('calendar_ical_url', icalUrl.trim());
    }
    setStep(3);
    runIngest();
  };

  const runIngest = async () => {
    setBusy(true);
    setProgress('Fetching emails…');
    try {
      await window.aria?.refreshEmails?.();
      setProgress('Categorizing emails…');
      try { await window.aria?.categorizeEmails?.(); } catch (_) {}
      setProgress('Syncing calendar…');
      if (icalUrl.trim()) {
        try { await window.aria?.getCalendarEvents?.(); } catch (_) {}
      }
      setProgress('Scanning financial data…');
      try { await window.aria?.scanFinancialEmails?.(); } catch (_) {}
      setProgress('Done!');
      await window.aria?.completeSetup?.();
      setStep(4);
    } catch (e) {
      setProgress('');
      setError(e.message || 'Sync failed — you can retry from Settings.');
      await window.aria?.completeSetup?.(); // mark done even on error
      setStep(4);
    }
    setBusy(false);
  };

  return (
    <div className="flex-1 min-h-0 overflow-y-auto px-4 py-6 flex flex-col gap-5 smooth-scroll"
         style={{ background: bg }}>

      {/* Step 0 — Intro */}
      {step === 0 && (
        <>
          <div className="text-center pt-4">
            <div className="text-[32px] mb-2">✦</div>
            <div className="text-[18px] font-bold" style={{ color: text, fontFamily: 'Georgia, serif' }}>
              Meet ARIA
            </div>
            <p className="text-[11px] mt-2 leading-relaxed" style={{ color: muted }}>
              Your executive chief-of-staff. Let's connect your accounts so ARIA can
              see what matters and surface it for you every morning.
            </p>
          </div>
          <StepCard isDark={isDark} card={card} border={border}>
            <div className="flex items-center gap-2 mb-1">
              <Mail size={14} style={{ color: '#4f9cf9' }} />
              <span className="text-[12px] font-semibold" style={{ color: text }}>Gmail</span>
            </div>
            <p className="text-[10px]" style={{ color: muted }}>Reads your inbox, extracts action items, tracks orders and subscriptions.</p>
          </StepCard>
          <StepCard isDark={isDark} card={card} border={border}>
            <div className="flex items-center gap-2 mb-1">
              <Calendar size={14} style={{ color: '#4f9cf9' }} />
              <span className="text-[12px] font-semibold" style={{ color: text }}>Calendar</span>
            </div>
            <p className="text-[10px]" style={{ color: muted }}>Any iCal feed — Google, Outlook, Apple. Optional but recommended.</p>
          </StepCard>
          <button onClick={() => setStep(1)}
                  className="w-full rounded-xl py-2.5 text-[12px] font-semibold flex items-center justify-center gap-2 mt-2"
                  style={{ background: '#4f9cf9', color: '#fff' }}>
            Get Started <ArrowRight size={14} />
          </button>
        </>
      )}

      {/* Step 1 — Gmail */}
      {step === 1 && (
        <>
          <StepHeader num={1} label="Connect Gmail" isDark={isDark} text={text} muted={muted} />
          <p className="text-[11px] leading-relaxed" style={{ color: muted }}>
            ARIA uses Gmail OAuth — your credentials stay on your device and are never shared.
          </p>
          {error && <ErrorBanner msg={error} isDark={isDark} />}
          <button onClick={connectGmail} disabled={busy}
                  className="w-full rounded-xl py-2.5 text-[12px] font-semibold flex items-center justify-center gap-2"
                  style={{ background: busy ? '#2a2a2a' : '#4f9cf9', color: busy ? '#555' : '#fff' }}>
            {busy ? <Loader size={13} className="animate-spin" /> : <Mail size={13} />}
            {busy ? 'Connecting…' : 'Connect Gmail'}
          </button>
          <button onClick={() => setStep(2)} className="text-[10px] text-center w-full" style={{ color: muted }}>
            Skip for now
          </button>
        </>
      )}

      {/* Step 2 — iCal */}
      {step === 2 && (
        <>
          <StepHeader num={2} label="Add Calendar (optional)" isDark={isDark} text={text} muted={muted} />
          <p className="text-[11px] leading-relaxed" style={{ color: muted }}>
            Paste an iCal URL (Google: Settings → Other calendars → Export). Leave blank to skip.
          </p>
          <input
            type="url"
            value={icalUrl}
            onChange={e => setIcalUrl(e.target.value)}
            placeholder="https://calendar.google.com/calendar/ical/…"
            className="w-full rounded-xl px-3 py-2 text-[11px] outline-none"
            style={{ background: isDark ? '#222' : '#fff', border: `1px solid ${border}`, color: text }}
          />
          {error && <ErrorBanner msg={error} isDark={isDark} />}
          <button onClick={saveIcal}
                  className="w-full rounded-xl py-2.5 text-[12px] font-semibold flex items-center justify-center gap-2"
                  style={{ background: '#4f9cf9', color: '#fff' }}>
            Continue <ArrowRight size={14} />
          </button>
        </>
      )}

      {/* Step 3 — Ingest */}
      {step === 3 && (
        <>
          <StepHeader num={3} label="Fetching your data" isDark={isDark} text={text} muted={muted} />
          <div className="flex flex-col items-center gap-4 py-6">
            {busy && <div className="w-8 h-8 rounded-full border-2 border-[#4f9cf9] border-t-transparent animate-spin" />}
            <p className="text-[11px]" style={{ color: muted }}>{progress || 'Starting…'}</p>
          </div>
          {error && <ErrorBanner msg={error} isDark={isDark} />}
        </>
      )}

      {/* Step 4 — Done */}
      {step === 4 && (
        <>
          <div className="text-center pt-6">
            <CheckCircle2 size={36} className="mx-auto mb-3" style={{ color: '#22c55e' }} />
            <div className="text-[16px] font-bold" style={{ color: text, fontFamily: 'Georgia, serif' }}>
              You're all set!
            </div>
            <p className="text-[11px] mt-2 leading-relaxed" style={{ color: muted }}>
              ARIA has synced your data. Your executive briefing is ready.
            </p>
          </div>
          <button onClick={onComplete}
                  className="w-full rounded-xl py-2.5 text-[12px] font-semibold flex items-center justify-center gap-2 mt-4"
                  style={{ background: '#22c55e', color: '#fff' }}>
            <Zap size={13} /> Open ARIA
          </button>
        </>
      )}
    </div>
  );
}

function StepCard({ children, isDark, card, border }) {
  return (
    <div className="rounded-xl px-3 py-3" style={{ background: card, border: `1px solid ${border}` }}>
      {children}
    </div>
  );
}

function StepHeader({ num, label, isDark, text, muted }) {
  return (
    <div>
      <div className="text-[9px] uppercase tracking-widest mb-1" style={{ color: muted }}>Step {num} of 3</div>
      <div className="text-[15px] font-bold" style={{ color: text, fontFamily: 'Georgia, serif' }}>{label}</div>
    </div>
  );
}

function ErrorBanner({ msg, isDark }) {
  return (
    <div className="rounded-xl px-3 py-2 text-[10px]"
         style={{ background: 'rgba(239,68,68,0.08)', color: '#ef4444', border: '1px solid rgba(239,68,68,0.15)' }}>
      {msg}
    </div>
  );
}
