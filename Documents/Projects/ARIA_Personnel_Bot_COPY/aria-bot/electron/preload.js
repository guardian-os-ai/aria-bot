/**
 * electron/preload.js — Secure contextBridge IPC bridge
 * Exposes window.aria API to the renderer process.
 * All communication with main process goes through here.
 */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('aria', {
  // ── Reminders ──
  getReminders: () => ipcRenderer.invoke('get-reminders'),
  getAllReminders: () => ipcRenderer.invoke('get-all-reminders'),
  addReminder: (text) => ipcRenderer.invoke('add-reminder', text),
  completeReminder: (id) => ipcRenderer.invoke('complete-reminder', id),
  archiveReminder: (id) => ipcRenderer.invoke('archive-reminder', id),
  extendReminder: (id, minutes) => ipcRenderer.invoke('extend-reminder', id, minutes),
  deleteReminder: (id) => ipcRenderer.invoke('delete-reminder', id),

  // ── Emails ──
  getEmails: () => ipcRenderer.invoke('get-emails'),
  refreshEmails: () => ipcRenderer.invoke('refresh-emails'),
  categorizeEmails: () => ipcRenderer.invoke('categorize-emails'),
  summarizeEmail: (messageId) => ipcRenderer.invoke('ai-summarize-email', messageId),
  markEmailRead: (messageId) => ipcRenderer.invoke('mark-email-read', messageId),
  deleteEmail: (messageId) => ipcRenderer.invoke('delete-email', messageId),
  openInGmail: (messageId) => ipcRenderer.invoke('open-in-gmail', messageId),
  draftReply: (messageId, subject, fromEmail) => ipcRenderer.invoke('draft-reply', messageId, subject, fromEmail),
  aiDraftReply: (subject, fromEmail, bodyPreview) => ipcRenderer.invoke('ai-draft-reply', subject, fromEmail, bodyPreview),

  // ── Briefing ──
  getBriefing: () => ipcRenderer.invoke('get-briefing'),
  getUserState: () => ipcRenderer.invoke('get-user-state'),

  // ── Chat ──
  chat: (message) => ipcRenderer.invoke('chat', message),
  getChatHistory: () => ipcRenderer.invoke('get-chat-history'),
  saveChatMessage: (role, text) => ipcRenderer.invoke('save-chat-message', role, text),
  clearChatHistory: () => ipcRenderer.invoke('clear-chat-history'),

  // Streaming chat events (agent responses stream token-by-token)
  onChatChunkStart: (cb) => ipcRenderer.on('chat-chunk-start', (_ev, data) => cb(data)),
  onChatChunk:      (cb) => ipcRenderer.on('chat-chunk',       (_ev, data) => cb(data)),
  offChatChunk:     ()   => {
    ipcRenderer.removeAllListeners('chat-chunk-start');
    ipcRenderer.removeAllListeners('chat-chunk');
  },

  // Sidecar health events
  onSidecarStatus: (cb) => ipcRenderer.on('sidecar-status', (_ev, data) => cb(data)),
  onSidecarFatal:  (cb) => ipcRenderer.on('sidecar-fatal',  (_ev, data) => cb(data)),
  restartSidecar:  ()   => ipcRenderer.invoke('restart-sidecar'),

  // ── Notes ──
  getNotes: () => ipcRenderer.invoke('get-notes'),
  addNote: (title, content, tags) => ipcRenderer.invoke('add-note', title, content, tags),
  updateNote: (id, title, content, tags) => ipcRenderer.invoke('update-note', id, title, content, tags),
  deleteNote: (id) => ipcRenderer.invoke('delete-note', id),
  exportNote: (id) => ipcRenderer.invoke('export-note', id),
  openNoteExternal: (id) => ipcRenderer.invoke('open-note-external', id),
  getNotesDir: () => ipcRenderer.invoke('get-notes-dir'),

  // ── Streak ──
  getStreak: () => ipcRenderer.invoke('get-streak'),

  // ── Settings ──
  getSettings: () => ipcRenderer.invoke('get-settings'),
  saveSetting: (key, value) => ipcRenderer.invoke('save-setting', key, value),
  getSetting:  (key)        => ipcRenderer.invoke('get-setting', key),
  completeSetup: ()         => ipcRenderer.invoke('complete-setup'),

  // ── Weather ──
  getWeather: () => ipcRenderer.invoke('get-weather'),

  // ── Calendar ──
  getCalendarEvents: () => ipcRenderer.invoke('get-calendar-events'),

  // ── AI Usage ──
  getUsage: () => ipcRenderer.invoke('get-usage'),

  // ── API Key ──
  saveApiKey: (key) => ipcRenderer.invoke('save-api-key', key),
  getApiKey: () => ipcRenderer.invoke('get-api-key'),
  saveGrokApiKey: (key) => ipcRenderer.invoke('save-grok-api-key', key),
  getGrokApiKey: () => ipcRenderer.invoke('get-grok-api-key'),

  // ── Reminder editing ──
  updateReminder: (id, title, dueAt) => ipcRenderer.invoke('update-reminder', id, title, dueAt),

  // ── Gmail OAuth2 ──
  connectGmail: () => ipcRenderer.invoke('connect-gmail'),           // new BrowserWindow flow
  gmailOAuthStatus: () => ipcRenderer.invoke('gmail-oauth-status'),
  gmailOAuthStart: () => ipcRenderer.invoke('gmail-oauth-start'),    // legacy (kept for fallback)
  gmailOAuthDisconnect: () => ipcRenderer.invoke('gmail-oauth-disconnect'),

  // ── Ollama status ──
  checkOllama: () => ipcRenderer.invoke('check-ollama'),

  // ── Subscriptions ──
  getSubscriptions: () => ipcRenderer.invoke('get-subscriptions'),
  addSubscription: (sub) => ipcRenderer.invoke('add-subscription', sub),
  updateSubscription: (id, updates) => ipcRenderer.invoke('update-subscription', id, updates),
  deleteSubscription: (id) => ipcRenderer.invoke('delete-subscription', id),

  // ── Financial Summary ──
  getFinancialSummary:   () => ipcRenderer.invoke('get-financial-summary'),
  getSpendingInsight:    () => ipcRenderer.invoke('get-spending-insight'),
  recordSpend:  (entry) => ipcRenderer.invoke('record-spend', entry),
  scanFinancialEmails:   () => ipcRenderer.invoke('scan-financial-emails'),
  getBehaviorReport:     () => ipcRenderer.invoke('get-behavior-report'),

  // ── Habits ──
  getHabits: () => ipcRenderer.invoke('get-habits'),
  createHabit: (name, icon) => ipcRenderer.invoke('create-habit', name, icon),
  toggleHabit: (habitId) => ipcRenderer.invoke('toggle-habit', habitId),
  deleteHabit: (id) => ipcRenderer.invoke('delete-habit', id),
  getHabitHistory: (habitId, days) => ipcRenderer.invoke('get-habit-history', habitId, days),
  getWeeklySummary: () => ipcRenderer.invoke('get-weekly-summary'),

  // ── Focus Timer ──
  startFocus: (minutes) => ipcRenderer.invoke('start-focus', minutes),
  endFocus: () => ipcRenderer.invoke('end-focus'),
  getFocusStatus: () => ipcRenderer.invoke('get-focus-status'),
  getFocusStats: () => ipcRenderer.invoke('get-focus-stats'),

  // ── Weekly Report ──
  getWeeklyReport: () => ipcRenderer.invoke('get-weekly-report'),

  // ── Natural Language Query ──
  nlQuery: (query) => ipcRenderer.invoke('nl-query', query),

  // ── Focus & Habit Analytics ──
  getFocusAnalytics: (days) => ipcRenderer.invoke('get-focus-analytics', days),
  getHabitAnalytics: (days) => ipcRenderer.invoke('get-habit-analytics', days),
  getProductivityCorrelation: (days) => ipcRenderer.invoke('get-productivity-correlation', days),

  // ── Calendar Intelligence ──
  getCalendarIntelligence: () => ipcRenderer.invoke('get-calendar-intelligence'),
  linkCalendarTasks: () => ipcRenderer.invoke('link-calendar-tasks'),

  // ── Window Controls ──
  closeWindow: () => ipcRenderer.send('window-close'),
  minimizeWindow: () => ipcRenderer.send('window-minimize'),
  toggleWindow: () => ipcRenderer.send('window-toggle'),

  // ── Navigation listener (for notification click routing) ──
  onNavigate: (callback) => ipcRenderer.on('navigate-to', (_event, panel) => callback(panel)),

  // ── Auto-sync push event — fires when background sync fetches new emails ──
  onEmailsUpdated: (callback) => {
    ipcRenderer.on('emails-updated', (_event, data) => callback(data));
  },

  // ── Phase E: Ollama online/offline status push ──
  onOllamaStatus: (callback) => {
    ipcRenderer.on('ollama-status', (_event, data) => callback(data));
  },

  // ── Phase C: Proactive alert push (every 30 min) ──
  onProactiveAlert: (callback) => {
    ipcRenderer.on('proactive-alert', (_event, insight) => callback(insight));
  },

  // ══════════════════════════════════════════════════════════════════════
  // Mega Feature Consolidation — Superhuman+SaneBox+Boomerang+Todoist+
  // YNAB+Notion AI+TextExpander+Calendly+Grammarly features
  // ══════════════════════════════════════════════════════════════════════

  // ── Email Power (Superhuman + SaneBox + Boomerang) ──
  snoozeEmail:       (messageId, until)  => ipcRenderer.invoke('snooze-email', messageId, until),
  unsnoozeEmail:     (messageId)         => ipcRenderer.invoke('unsnooze-email', messageId),
  followUpEmail:     (messageId, hours)  => ipcRenderer.invoke('follow-up-email', messageId, hours),
  dismissFollowUp:   (messageId)         => ipcRenderer.invoke('dismiss-follow-up', messageId),
  getFollowUps:      ()                  => ipcRenderer.invoke('get-follow-ups'),
  blockSender:       (email)             => ipcRenderer.invoke('block-sender', email),
  unblockSender:     (email)             => ipcRenderer.invoke('unblock-sender', email),
  autoArchiveEmail:  (messageId)         => ipcRenderer.invoke('auto-archive-email', messageId),

  // ── Reply Templates (TextExpander-style) ──
  getReplyTemplates:    ()                      => ipcRenderer.invoke('get-reply-templates'),
  addReplyTemplate:     (shortcut, title, body) => ipcRenderer.invoke('add-reply-template', shortcut, title, body),
  deleteReplyTemplate:  (id)                    => ipcRenderer.invoke('delete-reply-template', id),

  // ── Tone Adjustment (Grammarly-style) ──
  adjustTone: (text, tone) => ipcRenderer.invoke('adjust-tone', text, tone),

  // ── Sub-tasks (Todoist-style) ──
  addSubTask:  (parentId, text) => ipcRenderer.invoke('add-sub-task', parentId, text),
  getSubTasks: (parentId)       => ipcRenderer.invoke('get-sub-tasks', parentId),
  toggleSubTask: (id)           => ipcRenderer.invoke('toggle-sub-task', id),

  // ── Notes Intelligence (Notion AI) ──
  summarizeNote:      (noteId) => ipcRenderer.invoke('summarize-note', noteId),
  extractActionItems: (noteId) => ipcRenderer.invoke('extract-action-items', noteId),

  // ── Note Templates ──
  getNoteTemplates:    ()              => ipcRenderer.invoke('get-note-templates'),
  addNoteTemplate:     (name, content) => ipcRenderer.invoke('add-note-template', name, content),
  deleteNoteTemplate:  (id)            => ipcRenderer.invoke('delete-note-template', id),

  // ── Money Intelligence (YNAB-style) ──
  getMonthComparison:       () => ipcRenderer.invoke('get-month-comparison'),
  getUnusedSubscriptions:   () => ipcRenderer.invoke('get-unused-subscriptions'),

  // ══════════════════════════════════════════════════════════════════════
  // Phase 2: Full SaaS Consolidation — Notes + Money + Chat + Today + Mail
  // ══════════════════════════════════════════════════════════════════════

  // ── Notes Intelligence (Obsidian + Notion AI extended) ──
  continueWriting:  (text)       => ipcRenderer.invoke('continue-writing', text),
  adjustNoteTone:   (text, tone) => ipcRenderer.invoke('adjust-note-tone', text, tone),
  getRelatedNotes:  (noteId)     => ipcRenderer.invoke('get-related-notes', noteId),
  getDailyNote:     ()           => ipcRenderer.invoke('get-daily-note'),

  // ── Money Intelligence (PocketGuard + YNAB extended) ──
  getSpendableBalance:    () => ipcRenderer.invoke('get-spendable-balance'),
  getCategoryLimits:      () => ipcRenderer.invoke('get-category-limits'),
  setCategoryLimit:       (category, limit) => ipcRenderer.invoke('set-category-limit', category, limit),
  deleteCategoryLimit:    (category) => ipcRenderer.invoke('delete-category-limit', category),

  // ── AI Chat Intelligence (ChatGPT + Perplexity + Claude) ──
  saveMemory:              (fact)          => ipcRenderer.invoke('save-memory', fact),
  getMemories:             ()              => ipcRenderer.invoke('get-memories'),
  deleteMemory:            (id)            => ipcRenderer.invoke('delete-memory', id),
  getProactiveSuggestions: ()              => ipcRenderer.invoke('get-proactive-suggestions'),
  chatEnhanced:            (message, mode) => ipcRenderer.invoke('chat-enhanced', message, mode),
  confirmAction:           (type, payload) => ipcRenderer.invoke('confirm-action', type, payload),
  dismissAction:           (type, payload) => ipcRenderer.invoke('dismiss-action', type, payload),
  getActionFeedback:       (actionType)    => ipcRenderer.invoke('get-action-feedback', actionType),
  getSessionPreferences:   ()              => ipcRenderer.invoke('get-session-preferences'),
  clearSessionPreference:  (id)            => ipcRenderer.invoke('clear-session-preference', id),

  // ── Today Intelligence (Sunsama + Motion) ──
  getMorningRitual: () => ipcRenderer.invoke('get-morning-ritual'),

  // ── Mail Intelligence (Unsubscribe) ──
  getUnsubscribeLink: (messageId) => ipcRenderer.invoke('get-unsubscribe-link', messageId),

  // ── WhatsApp Briefing (Twilio-powered) ──
  sendWhatsAppBriefing: () => ipcRenderer.invoke('send-whatsapp-briefing'),
  sendWhatsAppTest:     () => ipcRenderer.invoke('send-whatsapp-test'),
  getWhatsAppStatus:    () => ipcRenderer.invoke('get-whatsapp-status'),

  // ══════════════════════════════════════════════════════════════════════
  // Phase 10 — Intelligence Layers (P10-1 through P10-5)
  // ══════════════════════════════════════════════════════════════════════

  // P10-1: Learning Layer — Signal-level behavioral learning
  trackSignal:        (signalId, action, domain, score) => ipcRenderer.invoke('track-signal', signalId, action, domain, score),
  getSignalStats:     () => ipcRenderer.invoke('get-signal-stats'),

  // P10-2: Predictive Engine — Time estimates and risk detection
  logTaskTime:        (taskTitle, category, actualMinutes, wasLate) => ipcRenderer.invoke('log-task-time', taskTitle, category, actualMinutes, wasLate),
  getPredictions:     () => ipcRenderer.invoke('get-predictions'),

  // P10-3: Relationship Intelligence — Contact classification
  analyzeRelationships:   () => ipcRenderer.invoke('analyze-relationships'),
  getRelationshipProfile: (email) => ipcRenderer.invoke('get-relationship-profile', email),

  // P10-4: Context Memory — Entity extraction and cross-item linking
  getActiveContexts:  () => ipcRenderer.invoke('get-active-contexts'),
  linkContext:         (threadId, itemType, itemId) => ipcRenderer.invoke('link-context', threadId, itemType, itemId),
  getContextForItem:   (itemType, itemId) => ipcRenderer.invoke('get-context-for-item', itemType, itemId),

  // P10-5: Outcome Tracking — ROI and value proof
  getOutcomeReport:   () => ipcRenderer.invoke('get-outcome-report'),
  getOutcomeHistory:  () => ipcRenderer.invoke('get-outcome-history'),
});
