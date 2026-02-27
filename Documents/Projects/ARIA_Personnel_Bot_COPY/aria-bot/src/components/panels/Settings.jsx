import React, { useState, useEffect, useCallback } from 'react';
import { Save, Eye, EyeOff, AlertTriangle, Key, Mail, Calendar, Cloud, Clock, Shield, MessageSquare, User, FileText } from 'lucide-react';
import { useTheme } from '../../context/ThemeContext';

export default function Settings() {
  const { theme } = useTheme();
  const isDark = theme === 'dark';

  const [loading, setLoading] = useState(true);
  const [savedSections, setSavedSections] = useState(new Set());
  const [errors, setErrors] = useState({});

  const [baseSettings, setBaseSettings] = useState({});
  const [draftSettings, setDraftSettings] = useState({});

  const [apiKey, setApiKey] = useState('');
  const [grokApiKey, setGrokApiKey] = useState('');
  const [apiKeyVisible, setApiKeyVisible] = useState(false);
  const [grokApiKeyVisible, setGrokApiKeyVisible] = useState(false);
  const [savedApiKey, setSavedApiKey] = useState('');
  const [savedGrokApiKey, setSavedGrokApiKey] = useState('');

  const sectionKeys = {
    email: ['imap_host', 'imap_port', 'imap_user', 'imap_password', 'imap_tls'],
    gmail_oauth: ['gmail_client_id', 'gmail_client_secret'],
    calendar: ['calendar_ical_url'],
    weather: ['weather_city', 'weather_latitude', 'weather_longitude'],
    briefing: ['briefing_time'],
    whatsapp: ['whatsapp_phone', 'twilio_sid', 'twilio_auth_token', 'twilio_whatsapp_from', 'whatsapp_enabled'],
    profile: ['user_name', 'monthly_income']
  };

  useEffect(() => {
    const load = async () => {
      try {
        const settingsData = await window.aria?.getSettings();
        const normalized = settingsData || {};
        setBaseSettings(normalized);
        setDraftSettings(normalized);

        const keyData = await window.aria?.getApiKey();
        const gemini = keyData?.key || '';
        setApiKey(gemini);
        setSavedApiKey(gemini);

        const grokKeyData = await window.aria?.getGrokApiKey();
        const grok = grokKeyData?.key || '';
        setGrokApiKey(grok);
        setSavedGrokApiKey(grok);
      } catch (err) {
        setErrors((prev) => ({ ...prev, general: err.message || 'Failed to load settings' }));
      } finally {
        setLoading(false);
      }
    };

    load();
  }, []);

  const flashSaved = useCallback((sectionId) => {
    setSavedSections((prev) => new Set([...prev, sectionId]));
    setTimeout(() => {
      setSavedSections((prev) => {
        const next = new Set(prev);
        next.delete(sectionId);
        return next;
      });
    }, 1800);
  }, []);

  const updateDraft = useCallback((key, value) => {
    setDraftSettings((prev) => ({ ...prev, [key]: value }));
  }, []);

  const saveSection = useCallback(async (sectionId) => {
    const keys = sectionKeys[sectionId] || [];

    try {
      for (const key of keys) {
        const before = baseSettings[key] ?? '';
        const after = draftSettings[key] ?? '';
        if (String(before) !== String(after)) {
          await window.aria?.saveSetting(key, after);
        }
      }

      setBaseSettings((prev) => {
        const next = { ...prev };
        for (const key of keys) next[key] = draftSettings[key];
        return next;
      });

      setErrors((prev) => ({ ...prev, [sectionId]: null }));
      flashSaved(sectionId);
    } catch (err) {
      setErrors((prev) => ({ ...prev, [sectionId]: err.message || 'Failed to save section' }));
    }
  }, [baseSettings, draftSettings, flashSaved]);

  const saveApiSection = useCallback(async () => {
    try {
      if (apiKey.trim() !== savedApiKey.trim()) {
        await window.aria?.saveApiKey(apiKey.trim());
        setSavedApiKey(apiKey.trim());
      }

      if (grokApiKey.trim() !== savedGrokApiKey.trim()) {
        await window.aria?.saveGrokApiKey(grokApiKey.trim());
        setSavedGrokApiKey(grokApiKey.trim());
      }

      setErrors((prev) => ({ ...prev, api: null }));
      flashSaved('api');
    } catch (err) {
      setErrors((prev) => ({ ...prev, api: err.message || 'Failed to save API keys' }));
    }
  }, [apiKey, grokApiKey, savedApiKey, savedGrokApiKey, flashSaved]);

  const sectionDirty = useCallback((sectionId) => {
    const keys = sectionKeys[sectionId] || [];
    return keys.some((key) => String(baseSettings[key] ?? '') !== String(draftSettings[key] ?? ''));
  }, [baseSettings, draftSettings]);

  const apiDirty = apiKey.trim() !== savedApiKey.trim() || grokApiKey.trim() !== savedGrokApiKey.trim();

  if (loading) {
    return (
      <div className="flex-1 flex items-center justify-center py-12">
        <div className="w-8 h-8 rounded-full border-2 border-[#4f9cf9] border-t-transparent animate-spin" />
      </div>
    );
  }

  return (
    <div className="flex-1 p-2.5 flex flex-col gap-3 overflow-y-auto smooth-scroll">
      <div className="text-[15px] font-semibold" style={{ color: isDark ? '#f0f0f0' : '#1f2937' }}>
        Settings
      </div>

      {errors.general && <ErrorText text={errors.general} />}

      {/* Env-var hint */}
      <div className="rounded-[10px] p-2.5 border flex items-start gap-2"
           style={{ background: isDark ? 'rgba(79,156,249,0.05)' : 'rgba(79,156,249,0.06)',
                    borderColor: isDark ? 'rgba(79,156,249,0.15)' : 'rgba(79,156,249,0.2)' }}>
        <FileText size={13} style={{ color: '#4f9cf9', marginTop: 1, flexShrink: 0 }} />
        <div className="text-[10px] leading-relaxed" style={{ color: isDark ? '#888' : '#6b7280' }}>
          <strong style={{ color: isDark ? '#aaa' : '#374151' }}>Tip:</strong> API keys and secrets can be set in a <code style={{ color: '#4f9cf9' }}>.env</code> file 
          in the project root. Keys from <code style={{ color: '#4f9cf9' }}>.env</code> take priority over values entered here. 
          See <code style={{ color: '#4f9cf9' }}>.env.example</code> for the template.
        </div>
      </div>

      <SettingsSection
        icon={<Key size={15} />}
        title="AI API Keys"
        description="Gemini is required. Grok is optional fallback."
        isDark={isDark}
        action={
          <SectionSaveButton
            onClick={saveApiSection}
            disabled={!apiDirty}
            saved={savedSections.has('api')}
            isDark={isDark}
          />
        }
      >
        <SecretInput
          label="Gemini API Key"
          value={apiKey}
          onChange={setApiKey}
          visible={apiKeyVisible}
          onToggleVisible={() => setApiKeyVisible((v) => !v)}
          placeholder="AIza..."
          isDark={isDark}
        />

        <SecretInput
          label="Grok API Key (Optional)"
          value={grokApiKey}
          onChange={setGrokApiKey}
          visible={grokApiKeyVisible}
          onToggleVisible={() => setGrokApiKeyVisible((v) => !v)}
          placeholder="xai-..."
          isDark={isDark}
        />

        {errors.api && <ErrorText text={errors.api} />}
      </SettingsSection>

      <SettingsSection
        icon={<Mail size={15} />}
        title="Email (IMAP)"
        description="Read-only access to your inbox"
        isDark={isDark}
        action={
          <SectionSaveButton
            onClick={() => saveSection('email')}
            disabled={!sectionDirty('email')}
            saved={savedSections.has('email')}
            isDark={isDark}
          />
        }
      >
        <FieldInput label="IMAP Host" value={draftSettings.imap_host || ''} onChange={(v) => updateDraft('imap_host', v)} placeholder="imap.gmail.com" isDark={isDark} />
        <FieldInput label="Port" value={draftSettings.imap_port || ''} onChange={(v) => updateDraft('imap_port', v)} placeholder="993" type="number" isDark={isDark} />
        <FieldInput label="Username" value={draftSettings.imap_user || ''} onChange={(v) => updateDraft('imap_user', v)} placeholder="you@gmail.com" isDark={isDark} />
        <FieldInput label="Password" value={draftSettings.imap_password || ''} onChange={(v) => updateDraft('imap_password', v)} placeholder="App password" type="password" isDark={isDark} />

        <label className="flex items-center gap-2 text-[12px]" style={{ color: isDark ? '#c8c8c8' : '#374151' }}>
          <input
            type="checkbox"
            checked={String(draftSettings.imap_tls ?? 'true') !== 'false'}
            onChange={(e) => updateDraft('imap_tls', e.target.checked ? 'true' : 'false')}
            className="w-4 h-4 rounded accent-[#4f9cf9]"
          />
          Use TLS
        </label>

        {errors.email && <ErrorText text={errors.email} />}
      </SettingsSection>

      {/* Gmail OAuth2 Section */}
      <GmailOAuthSection isDark={isDark} draftSettings={draftSettings} updateDraft={updateDraft}
        saveSection={saveSection} sectionDirty={sectionDirty} savedSections={savedSections}
        flashSaved={flashSaved} errors={errors} setErrors={setErrors} />

      <SettingsSection
        icon={<Calendar size={15} />}
        title="Calendar"
        description="iCal .ics URL"
        isDark={isDark}
        action={
          <SectionSaveButton
            onClick={() => saveSection('calendar')}
            disabled={!sectionDirty('calendar')}
            saved={savedSections.has('calendar')}
            isDark={isDark}
          />
        }
      >
        <FieldInput
          label="iCal URL"
          value={draftSettings.calendar_ical_url || ''}
          onChange={(v) => updateDraft('calendar_ical_url', v)}
          placeholder="https://calendar.google.com/calendar/ical/..."
          isDark={isDark}
        />
        {errors.calendar && <ErrorText text={errors.calendar} />}
      </SettingsSection>

      <SettingsSection
        icon={<Cloud size={15} />}
        title="Weather"
        description="City and coordinates (optional)"
        isDark={isDark}
        action={
          <SectionSaveButton
            onClick={() => saveSection('weather')}
            disabled={!sectionDirty('weather')}
            saved={savedSections.has('weather')}
            isDark={isDark}
          />
        }
      >
        <FieldInput label="City" value={draftSettings.weather_city || ''} onChange={(v) => updateDraft('weather_city', v)} placeholder="Bengaluru" isDark={isDark} />
        <div className="grid grid-cols-2 gap-2">
          <FieldInput label="Latitude" value={draftSettings.weather_latitude || ''} onChange={(v) => updateDraft('weather_latitude', v)} placeholder="12.9716" isDark={isDark} />
          <FieldInput label="Longitude" value={draftSettings.weather_longitude || ''} onChange={(v) => updateDraft('weather_longitude', v)} placeholder="77.5946" isDark={isDark} />
        </div>
        {errors.weather && <ErrorText text={errors.weather} />}
      </SettingsSection>

      <SettingsSection
        icon={<Clock size={15} />}
        title="Morning Briefing"
        description="Daily briefing time"
        isDark={isDark}
        action={
          <SectionSaveButton
            onClick={() => saveSection('briefing')}
            disabled={!sectionDirty('briefing')}
            saved={savedSections.has('briefing')}
            isDark={isDark}
          />
        }
      >
        <FieldInput
          label="Briefing Time"
          value={draftSettings.briefing_time || '09:00'}
          onChange={(v) => updateDraft('briefing_time', v)}
          placeholder="09:00"
          type="time"
          isDark={isDark}
        />
        {errors.briefing && <ErrorText text={errors.briefing} />}
      </SettingsSection>

      {/* WhatsApp Briefing */}
      <WhatsAppSection isDark={isDark} draftSettings={draftSettings} updateDraft={updateDraft}
        saveSection={saveSection} sectionDirty={sectionDirty} savedSections={savedSections}
        errors={errors} />

      {/* Profile */}
      <SettingsSection
        icon={<User size={15} />}
        title="Profile"
        description="Your name and income for budgeting"
        isDark={isDark}
        action={
          <SectionSaveButton
            onClick={() => saveSection('profile')}
            disabled={!sectionDirty('profile')}
            saved={savedSections.has('profile')}
            isDark={isDark}
          />
        }
      >
        <FieldInput label="Your Name" value={draftSettings.user_name || ''} onChange={(v) => updateDraft('user_name', v)} placeholder="John" isDark={isDark} />
        <FieldInput label="Monthly Income (₹)" value={draftSettings.monthly_income || ''} onChange={(v) => updateDraft('monthly_income', v)} placeholder="50000" type="number" isDark={isDark} />
        {errors.profile && <ErrorText text={errors.profile} />}
      </SettingsSection>
    </div>
  );
}

function SettingsSection({ icon, title, description, children, action, isDark }) {
  return (
    <div
      className="rounded-[10px] p-3 border"
      style={{
        background: isDark ? '#1e1e1e' : '#ffffff',
        borderColor: isDark ? '#2a2a2a' : '#dedede'
      }}
    >
      <div className="flex items-start justify-between gap-2 mb-2">
        <div>
          <div className="flex items-center gap-1.5 mb-0.5">
            <span style={{ color: '#4f9cf9' }}>{icon}</span>
            <span className="text-[13px] font-semibold" style={{ color: isDark ? '#f0f0f0' : '#1f2937' }}>{title}</span>
          </div>
          {description && <p className="text-[11px]" style={{ color: isDark ? '#666666' : '#6b7280' }}>{description}</p>}
        </div>
        {action}
      </div>
      <div className="flex flex-col gap-2">{children}</div>
    </div>
  );
}

function FieldInput({ label, value, onChange, placeholder, type = 'text', isDark }) {
  return (
    <div>
      <label className="text-[11px] mb-0.5 block" style={{ color: isDark ? '#666666' : '#6b7280' }}>{label}</label>
      <input
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="w-full rounded-md px-2.5 py-2 text-[13px] outline-none"
        style={{
          background: isDark ? '#252525' : '#fafafa',
          border: `1px solid ${isDark ? '#333333' : '#d2d2d2'}`,
          color: isDark ? '#c8c8c8' : '#1f2937'
        }}
      />
    </div>
  );
}

function SecretInput({ label, value, onChange, visible, onToggleVisible, placeholder, isDark }) {
  return (
    <div>
      <label className="text-[11px] mb-0.5 block" style={{ color: isDark ? '#666666' : '#6b7280' }}>{label}</label>
      <div className="relative">
        <input
          type={visible ? 'text' : 'password'}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          className="w-full rounded-md px-2.5 py-2 pr-8 text-[13px] font-mono outline-none"
          style={{
            background: isDark ? '#252525' : '#fafafa',
            border: `1px solid ${isDark ? '#333333' : '#d2d2d2'}`,
            color: isDark ? '#c8c8c8' : '#1f2937'
          }}
        />
        <button
          onClick={onToggleVisible}
          className="absolute right-2 top-1/2 -translate-y-1/2"
          style={{ color: isDark ? '#666666' : '#6b7280' }}
          title={visible ? 'Hide key' : 'Show key'}
        >
          {visible ? <EyeOff size={14} /> : <Eye size={14} />}
        </button>
      </div>
    </div>
  );
}

function SectionSaveButton({ onClick, disabled, saved, isDark }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className="flex items-center gap-1 px-2.5 py-1.5 rounded-md text-[12px] font-medium transition-all disabled:opacity-45 disabled:cursor-not-allowed"
      style={{
        color: '#ffffff',
        background: saved ? '#22c55e' : '#4f9cf9',
        border: `1px solid ${isDark ? '#2a2a2a' : '#d0d0d0'}`
      }}
    >
      <Save size={12} />
      {saved ? 'Saved' : 'Save'}
    </button>
  );
}

function ErrorText({ text }) {
  return (
    <div className="flex items-center gap-1 text-[11px] text-[#ef4444]">
      <AlertTriangle size={11} />
      {text}
    </div>
  );
}

/* ── WhatsApp Briefing Section ── */
function WhatsAppSection({ isDark, draftSettings, updateDraft, saveSection, sectionDirty, savedSections, errors }) {
  const [waStatus, setWaStatus] = useState(null);
  const [sending, setSending] = useState(false);
  const [sendResult, setSendResult] = useState(null);

  useEffect(() => {
    window.aria?.getWhatsAppStatus?.().then(s => setWaStatus(s)).catch(() => {});
  }, []);

  const handleTest = async () => {
    // Save first if dirty
    if (sectionDirty('whatsapp')) await saveSection('whatsapp');
    window.aria?.sendWhatsAppTest?.();
  };

  const handleSendBriefing = async () => {
    setSending(true);
    setSendResult(null);
    try {
      if (sectionDirty('whatsapp')) await saveSection('whatsapp');
      const res = await window.aria?.sendWhatsAppBriefing?.();
      setSendResult(res?.success ? '✅ Sent!' : `❌ ${res?.error || 'Failed'}`);
    } catch (err) {
      setSendResult(`❌ ${err.message}`);
    } finally {
      setSending(false);
      setTimeout(() => setSendResult(null), 4000);
    }
  };

  return (
    <SettingsSection
      icon={<MessageSquare size={15} />}
      title="WhatsApp Briefing"
      description={waStatus?.configured ? '✅ Configured' : 'Send daily briefing via WhatsApp (Twilio)'}
      isDark={isDark}
      action={
        <SectionSaveButton
          onClick={() => saveSection('whatsapp')}
          disabled={!sectionDirty('whatsapp')}
          saved={savedSections.has('whatsapp')}
          isDark={isDark}
        />
      }
    >
      <FieldInput label="Your WhatsApp Number" value={draftSettings.whatsapp_phone || ''} onChange={(v) => updateDraft('whatsapp_phone', v)} placeholder="+91XXXXXXXXXX" isDark={isDark} />
      <FieldInput label="Twilio Account SID" value={draftSettings.twilio_sid || ''} onChange={(v) => updateDraft('twilio_sid', v)} placeholder="ACxxxxxxxx" isDark={isDark} />
      <FieldInput label="Twilio Auth Token" value={draftSettings.twilio_auth_token || ''} onChange={(v) => updateDraft('twilio_auth_token', v)} placeholder="xxxxxxxx" type="password" isDark={isDark} />
      <FieldInput label="WhatsApp From Number" value={draftSettings.twilio_whatsapp_from || ''} onChange={(v) => updateDraft('twilio_whatsapp_from', v)} placeholder="+14155238886" isDark={isDark} />
      <label className="flex items-center gap-2 text-[12px]" style={{ color: isDark ? '#c8c8c8' : '#374151' }}>
        <input type="checkbox"
          checked={String(draftSettings.whatsapp_enabled ?? 'false') === 'true'}
          onChange={(e) => updateDraft('whatsapp_enabled', e.target.checked ? 'true' : 'false')}
          className="w-4 h-4 rounded accent-[#25d366]" />
        Enable WhatsApp Briefing
      </label>

      <div className="flex gap-2 mt-1">
        <button onClick={handleTest}
          className="flex-1 py-1.5 rounded-lg text-[11px] font-semibold"
          style={{ background: 'rgba(37,211,102,0.08)', color: '#25d366', border: '1px solid rgba(37,211,102,0.2)' }}>
          📱 Test via WhatsApp Web
        </button>
        <button onClick={handleSendBriefing} disabled={sending}
          className="flex-1 py-1.5 rounded-lg text-[11px] font-semibold disabled:opacity-40"
          style={{ background: '#25d366', color: '#fff', border: 'none' }}>
          {sending ? 'Sending…' : '📬 Send Briefing Now'}
        </button>
      </div>
      {sendResult && <div className="text-[10px] mt-1" style={{ color: sendResult.startsWith('✅') ? '#22c55e' : '#ef4444' }}>{sendResult}</div>}

      <div className="text-[9.5px] mt-1 leading-relaxed" style={{ color: isDark ? '#555' : '#9ca3af' }}>
        Get Twilio credentials at{' '}
        <a href="#" onClick={() => window.aria?.openExternal?.('https://www.twilio.com/console')}
           style={{ color: '#25d366', textDecoration: 'underline' }}>
          Twilio Console
        </a>. Enable WhatsApp sandbox for testing.
      </div>
      {errors.whatsapp && <ErrorText text={errors.whatsapp} />}
    </SettingsSection>
  );
}

/* ── Gmail OAuth2 Section ── */
function GmailOAuthSection({ isDark, draftSettings, updateDraft, saveSection, sectionDirty, savedSections, flashSaved, errors, setErrors }) {
  const [oauthStatus, setOAuthStatus] = useState(null); // null = loading, true = connected, false = not connected
  const [connecting, setConnecting] = useState(false);
  const [showSetup, setShowSetup] = useState(false);

  useEffect(() => {
    window.aria?.gmailOAuthStatus?.().then(res => setOAuthStatus(!!res?.configured)).catch(() => setOAuthStatus(false));
  }, []);

  const handleConnect = async () => {
    setConnecting(true);
    setErrors(prev => ({ ...prev, gmail_oauth: null }));
    try {
      if (sectionDirty('gmail_oauth')) await saveSection('gmail_oauth');
      const result = await window.aria?.connectGmail?.();
      if (result?.success) {
        setOAuthStatus(true);
        flashSaved('gmail_oauth');
      } else if (result?.error) {
        setErrors(prev => ({ ...prev, gmail_oauth: result.error }));
      }
    } catch (err) {
      setErrors(prev => ({ ...prev, gmail_oauth: err.message }));
    } finally {
      setConnecting(false);
    }
  };

  const handleDisconnect = async () => {
    try {
      await window.aria?.gmailOAuthDisconnect?.();
      setOAuthStatus(false);
    } catch (_) {}
  };

  const open = (url) => window.aria?.openExternal?.(url);

  // Status badge colours
  const badge = oauthStatus === null
    ? { bg: 'rgba(100,100,100,0.15)', border: 'rgba(100,100,100,0.3)', dot: '#888', text: 'Checking…' }
    : oauthStatus
      ? { bg: 'rgba(34,197,94,0.12)', border: 'rgba(34,197,94,0.35)', dot: '#22c55e', text: 'Connected' }
      : { bg: 'rgba(239,68,68,0.10)', border: 'rgba(239,68,68,0.30)', dot: '#ef4444', text: 'Not connected' };

  return (
    <SettingsSection
      icon={<Shield size={15} />}
      title="Gmail OAuth2"
      description="Secure Gmail access — no app password needed"
      isDark={isDark}
      action={
        oauthStatus ? (
          <button onClick={handleDisconnect}
            className="px-2.5 py-1.5 rounded-md text-[12px] font-medium transition-all"
            style={{ color: '#ef4444', background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.2)' }}>
            Disconnect
          </button>
        ) : (
          <SectionSaveButton
            onClick={() => saveSection('gmail_oauth')}
            disabled={!sectionDirty('gmail_oauth')}
            saved={savedSections.has('gmail_oauth')}
            isDark={isDark}
          />
        )
      }
    >
      {/* ── Status Badge ── */}
      <div className="flex items-center gap-2 px-3 py-2 rounded-lg mb-2"
        style={{ background: badge.bg, border: `1px solid ${badge.border}` }}>
        <span style={{
          width: 8, height: 8, borderRadius: '50%', background: badge.dot, flexShrink: 0,
          boxShadow: oauthStatus ? `0 0 6px ${badge.dot}` : 'none',
          animation: oauthStatus ? 'pulse 2s infinite' : 'none'
        }} />
        <span className="text-[11px] font-semibold" style={{ color: badge.dot }}>
          Gmail OAuth2 — {badge.text}
        </span>
        {oauthStatus === true && (
          <span className="ml-auto text-[10px]" style={{ color: '#22c55e', opacity: 0.7 }}>
            ✓ Emails syncing
          </span>
        )}
      </div>

      {/* ── Credentials ── */}
      <FieldInput
        label="Google Client ID"
        value={draftSettings.gmail_client_id || ''}
        onChange={v => updateDraft('gmail_client_id', v)}
        placeholder="175923155369-xxxx.apps.googleusercontent.com"
        isDark={isDark}
      />
      <FieldInput
        label="Google Client Secret"
        value={draftSettings.gmail_client_secret || ''}
        onChange={v => updateDraft('gmail_client_secret', v)}
        placeholder="GOCSPX-..."
        isDark={isDark}
        type="password"
      />

      {/* ── Connect Button ── */}
      {!oauthStatus && (
        <button
          onClick={handleConnect}
          disabled={connecting || !draftSettings.gmail_client_id || !draftSettings.gmail_client_secret}
          className="w-full mt-1 py-2 rounded-lg text-[12px] font-semibold transition-all disabled:opacity-40"
          style={{ background: 'linear-gradient(135deg, #4285F4, #34A853)', color: '#fff', border: 'none' }}
        >
          {connecting ? '⏳ Waiting for Google sign-in…' : '🔐 Connect Gmail with OAuth2'}
        </button>
      )}

      {/* ── Setup Instructions (collapsible) ── */}
      <button
        onClick={() => setShowSetup(v => !v)}
        className="w-full mt-2 text-left text-[10.5px] font-medium flex items-center gap-1 transition-opacity hover:opacity-80"
        style={{ color: '#4f9cf9', background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}
      >
        <span style={{ fontSize: 9 }}>{showSetup ? '▼' : '▶'}</span>
        {showSetup ? 'Hide' : 'Show'} setup instructions
      </button>

      {showSetup && (
        <div className="mt-2 rounded-lg p-3 text-[10.5px] leading-relaxed space-y-2"
          style={{ background: isDark ? 'rgba(255,255,255,0.04)' : 'rgba(0,0,0,0.04)', border: `1px solid ${isDark ? 'rgba(255,255,255,0.07)' : 'rgba(0,0,0,0.08)'}` }}>

          <div className="font-semibold text-[11px] mb-1" style={{ color: isDark ? '#ccc' : '#333' }}>
            How to get Gmail OAuth2 credentials:
          </div>

          {[
            { n: 1, text: 'Go to Google Cloud Console', link: 'https://console.cloud.google.com/', label: 'Open Console' },
            { n: 2, text: 'Create a project (or select existing one).' },
            { n: 3, text: 'Enable the Gmail API', link: 'https://console.cloud.google.com/apis/library/gmail.googleapis.com', label: 'Enable Gmail API' },
            { n: 4, text: 'Go to Credentials → Create Credentials → OAuth client ID', link: 'https://console.cloud.google.com/apis/credentials', label: 'Open Credentials' },
            { n: 5, text: 'Application type: Web application' },
            {
              n: 6,
              text: 'Under Authorized redirect URIs, click Add URI and enter exactly:',
              code: 'http://localhost:17995'
            },
            { n: 7, text: 'Copy Client ID and Client Secret into the fields above, then click Save.' },
            { n: 8, text: 'If your app is in testing mode, add your Gmail address under OAuth consent screen → Test users', link: 'https://console.cloud.google.com/apis/credentials/consent', label: 'Open Consent Screen' },
            { n: 9, text: 'Click "Connect Gmail with OAuth2" — a Google sign-in window will appear.' },
          ].map(step => (
            <div key={step.n} className="flex gap-2">
              <span className="flex-shrink-0 w-4 h-4 rounded-full text-[9px] font-bold flex items-center justify-center mt-0.5"
                style={{ background: isDark ? 'rgba(79,156,249,0.2)' : 'rgba(79,156,249,0.15)', color: '#4f9cf9' }}>
                {step.n}
              </span>
              <span style={{ color: isDark ? '#aaa' : '#555' }}>
                {step.text}
                {step.code && (
                  <code className="mx-1 px-1 rounded text-[10px]"
                    style={{ background: isDark ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.07)', color: isDark ? '#7dd3fc' : '#1e40af' }}>
                    {step.code}
                  </code>
                )}
                {step.link && (
                  <>
                    {' — '}
                    <a href="#" onClick={e => { e.preventDefault(); open(step.link); }}
                      style={{ color: '#4f9cf9', textDecoration: 'underline' }}>
                      {step.label}
                    </a>
                  </>
                )}
              </span>
            </div>
          ))}
        </div>
      )}

      {errors.gmail_oauth && <ErrorText text={errors.gmail_oauth} />}
    </SettingsSection>
  );
}
