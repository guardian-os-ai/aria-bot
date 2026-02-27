import React, { useState, useCallback, useEffect, useRef, lazy, Suspense } from 'react';
import { useTheme } from './context/ThemeContext';
import { Minus, X } from 'lucide-react';
import BotHeader from './components/BotHeader';
import PillNav from './components/PillNav';
import SearchModal from './components/SearchModal';

// Lazy-load heavy panels — only render when first visited
const Today      = lazy(() => import('./components/panels/Today'));
const Mail       = lazy(() => import('./components/panels/Mail'));
const Remind     = lazy(() => import('./components/panels/Remind'));
const Notes      = lazy(() => import('./components/panels/Notes'));
const Money      = lazy(() => import('./components/panels/Money'));
const Ask        = lazy(() => import('./components/panels/Ask'));
const Settings   = lazy(() => import('./components/panels/Settings'));
const Onboarding = lazy(() => import('./components/panels/Onboarding'));

const PANELS = [
  { id: 'today',  label: '🌅 Today' },
  { id: 'ask',    label: '✦ Ask'    },
];

// Full panel order includes hidden panels (accessible via Ask commands / Settings gear)
const PANEL_ORDER = { today: 0, ask: 1, mail: 2, remind: 3, money: 4, notes: 5, settings: 6 };

// Fallback for lazy panels
const PanelLoader = () => (
  <div className="flex-1 flex items-center justify-center">
    <div className="flex gap-1">
      {[0,1,2].map(i => (
        <div key={i} className="w-1.5 h-1.5 rounded-full bg-[#4f9cf9] typing-dot"
             style={{ animationDelay: `${i * 0.2}s` }} />
      ))}
    </div>
  </div>
);

export default function App() {
  const { theme, toggleTheme } = useTheme();
  const isDark = theme === 'dark';

  const [activePanel, setActivePanel]   = useState('today');
  const [displayPanel, setDisplayPanel] = useState('today');
  const [animClass, setAnimClass]       = useState('panel-enter');
  const [streakDay, setStreakDay]        = useState(1);
  const [searchOpen, setSearchOpen]     = useState(false);
  const [showOnboarding, setShowOnboarding] = useState(false);
  // Phase E: Ollama Banner
  const [ollamaOffline, setOllamaOffline] = useState(false);
  // Phase C: Proactive alert toast
  const [proactiveAlert, setProactiveAlert] = useState(null);
  const proactiveTimerRef = useRef(null);
  // Sidecar health banner
  const [sidecarState, setSidecarState] = useState(null); // { status, message, fatal }
  const animLock = useRef(false);

  // ── Define callbacks FIRST before any effects that reference them ──

  const handlePanelChange = useCallback((id) => {
    if (id === displayPanel || animLock.current) return;
    const oldIdx = PANEL_ORDER[displayPanel] ?? 0;
    const newIdx = PANEL_ORDER[id] ?? 0;

    animLock.current = true;
    setAnimClass(newIdx >= oldIdx ? 'panel-exit-left' : 'panel-exit-right');

    setTimeout(() => {
      setDisplayPanel(id);
      setActivePanel(id);
      setAnimClass(newIdx >= oldIdx ? 'panel-enter-right' : 'panel-enter-left');
      setTimeout(() => { animLock.current = false; }, 300);
    }, 150);
  }, [displayPanel]);

  const handleClose    = useCallback(() => window.aria?.closeWindow(),    []);
  const handleMinimize = useCallback(() => window.aria?.minimizeWindow(), []);

  // ── Effects ──

  useEffect(() => {
    window.aria?.getStreak?.()
      .then(d => { if (d?.streak) setStreakDay(d.streak); })
      .catch(() => {});
  }, []);

  useEffect(() => {
    // First-run detection (P7-1)
    window.aria?.getSetting?.('has_completed_setup')
      .then(v => { if (!v) setShowOnboarding(true); })
      .catch(() => {});
  }, []);

  useEffect(() => {
    window.aria?.onNavigate?.((panel) => {
      if (PANEL_ORDER[panel] !== undefined) handlePanelChange(panel);
    });
  }, [handlePanelChange]);

  // Phase E: Listen for Ollama offline status
  useEffect(() => {
    window.aria?.onOllamaStatus?.((data) => {
      setOllamaOffline(!data.online);
    });
  }, []);

  // Phase C: Listen for proactive alerts
  useEffect(() => {
    window.aria?.onProactiveAlert?.((insight) => {
      setProactiveAlert(insight);
      if (proactiveTimerRef.current) clearTimeout(proactiveTimerRef.current);
      proactiveTimerRef.current = setTimeout(() => setProactiveAlert(null), 8000);
    });
    return () => { if (proactiveTimerRef.current) clearTimeout(proactiveTimerRef.current); };
  }, []);

  // Sidecar health: listen for status + fatal events
  useEffect(() => {
    window.aria?.onSidecarStatus?.((data) => {
      if (data.status === 'restarting') {
        setSidecarState({ status: 'restarting', message: `AI engine restarting (attempt ${data.retry || '?'}/5)...`, fatal: false });
      } else if (data.status === 'degraded') {
        setSidecarState({ status: 'degraded', message: data.message || 'AI engine degraded.', fatal: false });
      } else {
        setSidecarState(null); // status: 'ok' clears the banner
      }
    });
    window.aria?.onSidecarFatal?.((data) => {
      setSidecarState({ status: 'fatal', message: data.message || 'AI engine failed.', fatal: true });
    });
  }, []);

  useEffect(() => {
    const map = { '1':'today','2':'ask','3':'mail','4':'remind','5':'money','6':'notes' };
    const onKey = (e) => {
      if (showOnboarding) return; // Block shortcuts during onboarding
      if (!e.ctrlKey) return;
      if (map[e.key])    { e.preventDefault(); handlePanelChange(map[e.key]); }
      if (e.key === '/') { e.preventDefault(); handlePanelChange('ask'); }
      if (e.key === 'k') { e.preventDefault(); setSearchOpen(v => !v); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [handlePanelChange, showOnboarding]);

  // ── Theme tokens ──
  const bg        = isDark ? '#161616' : '#f5f5f5';
  const border    = isDark ? '#2a2a2a' : '#d0d0d0';
  const titleBg   = isDark ? '#1a1a1a' : '#e8e8e8';
  const textMuted = isDark ? '#555555' : '#888888';
  const btnColor  = isDark ? '#c8c8c8' : '#444444';
  const btnBg     = isDark ? 'rgba(255,255,255,0.04)' : 'rgba(0,0,0,0.04)';
  const shadow    = isDark
    ? '0 24px 80px rgba(0,0,0,0.8), 0 0 40px rgba(79,156,249,0.08)'
    : '0 24px 80px rgba(0,0,0,0.15), 0 0 40px rgba(79,156,249,0.15)';

  return (
    <div data-theme={theme}
         className="h-screen w-[348px] flex flex-col rounded-[14px] overflow-hidden animate-win-in"
         style={{ backgroundColor: bg, border: `1.5px solid ${border}`, boxShadow: shadow }}>

      {/* ── Title bar ── */}
      <div className="h-[30px] flex items-center px-2.5 shrink-0 drag"
           style={{ backgroundColor: titleBg, borderBottom: `1px solid ${border}` }}>

        <div className="flex gap-1 no-drag">
          <TitleBtn onClick={handleClose}    title="Hide"     variant="close"    ><X    size={11} /></TitleBtn>
          <TitleBtn onClick={handleMinimize} title="Minimize" variant="minimize" ><Minus size={11} /></TitleBtn>
        </div>

        <span className="flex-1 text-center font-mono text-[12px] tracking-wider -ml-[33px]"
              style={{ color: textMuted }}>
          ARIA
        </span>

        <div className="flex items-center gap-1 text-[11px] text-[#f97316] font-semibold
                        bg-[rgba(249,115,22,0.1)] border border-[rgba(249,115,22,0.2)]
                        rounded-full px-1.5 py-0.5 no-drag">
          🔥 Day {streakDay}
        </div>
      </div>

      {/* ── Bot header (hidden during onboarding) ── */}
      {!showOnboarding && (
        <BotHeader
          onSettingsClick={() => handlePanelChange('settings')}
          onThemeToggle={toggleTheme}
          theme={theme}
        />
      )}

      {/* ── Phase E: Ollama offline banner ── */}
      {ollamaOffline && (
        <div className="mx-2 mb-1 px-3 py-1.5 rounded-lg text-[11px] flex items-center gap-1.5"
             style={{ background: 'rgba(239,68,68,0.12)', border: '1px solid rgba(239,68,68,0.3)', color: '#f87171' }}>
          <span>⚠️</span>
          <span>Ollama offline — AI answers limited. Start Ollama to restore.</span>
          <button className="ml-auto opacity-60 hover:opacity-100" onClick={() => setOllamaOffline(false)}>✕</button>
        </div>
      )}

      {/* ── AI engine sidecar status banner ── */}
      {sidecarState && (
        <div className="mx-2 mb-1 px-3 py-1.5 rounded-lg text-[11px] flex items-center gap-1.5"
             style={{
               background: sidecarState.fatal ? 'rgba(239,68,68,0.15)' : 'rgba(249,115,22,0.12)',
               border: `1px solid ${sidecarState.fatal ? 'rgba(239,68,68,0.4)' : 'rgba(249,115,22,0.3)'}`,
               color: sidecarState.fatal ? '#f87171' : '#fb923c'
             }}>
          <span>{sidecarState.fatal ? '🔴' : '🟡'}</span>
          <span className="flex-1 leading-tight">{sidecarState.message}</span>
          <button
            className="shrink-0 px-2 py-0.5 rounded text-[10px] font-semibold border ml-1"
            style={{ borderColor: 'currentColor', opacity: 0.8 }}
            onClick={async () => {
              setSidecarState(null);
              await window.aria?.restartSidecar?.();
            }}
          >Restart</button>
          {!sidecarState.fatal && (
            <button className="ml-1 opacity-60 hover:opacity-100" onClick={() => setSidecarState(null)}>✕</button>
          )}
        </div>
      )}

      {/* ── Phase C: Proactive alert toast ── */}
      {proactiveAlert && (
        <div className="mx-2 mb-1 px-3 py-2 rounded-lg text-[11px] cursor-pointer"
             style={{ background: 'rgba(79,156,249,0.12)', border: '1px solid rgba(79,156,249,0.3)', color: isDark ? '#93c5fd' : '#2563eb' }}
             onClick={() => { setProactiveAlert(null); handlePanelChange('ask'); }}>
          <div className="flex items-start gap-1.5">
            <span className="mt-0.5">🔔</span>
            <div className="flex-1">
              <div className="font-semibold">{proactiveAlert.title || 'ARIA Insight'}</div>
              {proactiveAlert.description && <div className="opacity-80 mt-0.5">{proactiveAlert.description}</div>}
            </div>
            <button className="opacity-60 hover:opacity-100 mt-0.5" onClick={(e) => { e.stopPropagation(); setProactiveAlert(null); }}>✕</button>
          </div>
        </div>
      )}

      {/* ── Navigation (hidden during onboarding) ── */}
      {!showOnboarding && (
        <PillNav panels={PANELS} active={activePanel} onChange={handlePanelChange} />
      )}

      {/* ── Panel content ── */}
      <div className="flex-1 flex flex-col min-h-0 overflow-hidden">
        <Suspense fallback={<PanelLoader />}>
          <div className={`flex-1 min-h-0 flex flex-col ${animClass}`}>
            {showOnboarding
              ? <Onboarding onComplete={() => setShowOnboarding(false)} />
              : (
                <>
                  {displayPanel === 'today'    && <Today onNavigate={handlePanelChange} />}
                  {displayPanel === 'mail'     && <Mail />}
                  {displayPanel === 'remind'   && <Remind />}
                  {displayPanel === 'money'    && <Money />}
                  {displayPanel === 'notes'    && <Notes />}
                  {displayPanel === 'ask'      && <Ask />}
                  {displayPanel === 'settings' && <Settings />}
                </>
              )
            }
          </div>
        </Suspense>
      </div>

      {/* ── Search modal (Ctrl+K) ── */}
      {searchOpen && (
        <SearchModal open={searchOpen} onClose={() => setSearchOpen(false)} onNavigate={handlePanelChange} />
      )}
    </div>
  );
}

// Small reusable title bar button
function TitleBtn({ onClick, title, variant, children }) {
  return (
    <button
      onClick={onClick}
      title={title}
      className={`title-btn title-btn--${variant}`}
    >
      {children}
    </button>
  );
}
