# ARIA Personnel Bot — Manual Test Cases

> **Version:** 3.0 (Phase 3 — Revenue Stream Consolidation)
> **Last Updated:** June 2025
> **Total Test Cases:** 90 (65 Phase 1-2 + 25 Phase 3)
> **Instructions:** Execute tests sequentially within each panel. Mark Pass/Fail/Skip. Record notes for failures.

---

## Legend

| Symbol | Meaning |
|--------|---------|
| ✅ | Pass |
| ❌ | Fail |
| ⏭️ | Skipped |
| 🔶 | Partial (works with issues) |

---

## Pre-Test Setup Checklist

- [ ] App builds successfully (`npm run build`)
- [ ] App launches (`npm run dev` or electron)
- [ ] Ollama running locally with `llama3.2:3b` model (`ollama run llama3.2:3b`)
- [ ] Gmail OAuth connected (Settings → Connect Gmail)
- [ ] At least 5-10 emails synced
- [ ] At least 3 reminders/tasks created
- [ ] At least 5 transactions added in Money panel
- [ ] At least 2 subscriptions added
- [ ] `monthly_income` set in Settings
- [ ] At least 2 notes created with tags
- [ ] WhatsApp Twilio credentials configured (optional — for WhatsApp tests)
- [ ] At least 1 health log entered (optional — for health tests)

---

## 1. MAIL PANEL TEST CASES

### TC-M01: Smart Inbox (AI-Categorized Priority View)
| Field | Value |
|-------|-------|
| **Precondition** | Gmail connected, 5+ emails synced |
| **Steps** | 1. Open Mail panel<br>2. Observe inbox layout |
| **Expected** | Emails grouped into sections (Important/Action/Newsletters/Others). Each section has icon, label, count badge. Sections are collapsible. |
| **Result** | |
| **Notes** | |

### TC-M02: AI Email Summarization
| Field | Value |
|-------|-------|
| **Precondition** | Ollama running, email synced |
| **Steps** | 1. Open Mail panel<br>2. Click on any email to expand<br>3. Wait 2-3 seconds |
| **Expected** | Green-tinted summary card appears above body with 1-2 sentence AI summary. "Summarizing..." loading text shows briefly. |
| **Result** | |
| **Notes** | |

### TC-M03: AI Draft Reply
| Field | Value |
|-------|-------|
| **Precondition** | Ollama running, email expanded |
| **Steps** | 1. Expand any email<br>2. Click "Reply" button<br>3. Wait for draft generation |
| **Expected** | Reply textarea appears with AI-generated draft. Draft is contextual to the email. Textarea is editable. |
| **Result** | |
| **Notes** | |

### TC-M04: Reply Tone Adjustment
| Field | Value |
|-------|-------|
| **Precondition** | Reply draft generated (TC-M03 complete) |
| **Steps** | 1. With reply draft visible<br>2. Click "Professional" tone button<br>3. Observe draft change<br>4. Click "Friendly" tone<br>5. Click "Concise" tone |
| **Expected** | Draft text changes for each tone. Professional = formal language. Friendly = warm tone. Concise = shorter version. Original meaning preserved. |
| **Result** | |
| **Notes** | |

### TC-M05: Reply Templates (Quick Replies)
| Field | Value |
|-------|-------|
| **Precondition** | Email expanded |
| **Steps** | 1. Click "Template" button<br>2. Observe template picker dropdown<br>3. Click any template |
| **Expected** | Template picker shows pre-saved templates with titles and preview text. Selecting one populates the reply textarea. Mode switches to replying. |
| **Result** | |
| **Notes** | |

### TC-M06: Email Snooze (Boomerang-Style)
| Field | Value |
|-------|-------|
| **Precondition** | Email expanded |
| **Steps** | 1. Click "Snooze" button<br>2. Observe snooze option picker<br>3. Select "1 hour"<br>4. Verify email disappears from inbox<br>5. Wait or check after the time |
| **Expected** | Snooze picker shows 4 options (1hr, 3hr, Tomorrow 9am, Next Monday). Selecting one hides the email. Email should reappear after snooze time. |
| **Result** | |
| **Notes** | |

### TC-M07: Follow-Up Reminders
| Field | Value |
|-------|-------|
| **Precondition** | Email expanded |
| **Steps** | 1. Click "Follow-up" button<br>2. Verify follow-up badge appears on email |
| **Expected** | Orange follow-up badge/pill appears on email showing timeframe. Email is marked for follow-up tracking. |
| **Result** | |
| **Notes** | |

### TC-M08: Block Sender (SaneBox-Style)
| Field | Value |
|-------|-------|
| **Precondition** | Email expanded from a non-important sender |
| **Steps** | 1. Click Ban icon (right side of action bar)<br>2. Refresh inbox |
| **Expected** | Email disappears. On next sync, emails from that sender are auto-hidden. Sender added to blocked list. |
| **Result** | |
| **Notes** | |

### TC-M09: Unsubscribe Detection & One-Click Unsubscribe
| Field | Value |
|-------|-------|
| **Precondition** | Newsletter/marketing email synced that contains unsubscribe link |
| **Steps** | 1. Expand a newsletter email<br>2. Look for orange MailX icon in action bar<br>3. Click the MailX icon |
| **Expected** | Orange MailX icon appears (only on emails with detectable unsubscribe links). Clicking opens the unsubscribe URL in default browser. |
| **Result** | |
| **Notes** | Icon should NOT appear on regular emails without unsub links. |

### TC-M10: Intelligence Routing Labels
| Field | Value |
|-------|-------|
| **Precondition** | Emails categorized by AI |
| **Steps** | 1. Expand an email<br>2. Look at badge row |
| **Expected** | Colored route pills show (Finance, Legal, HR, Project, etc.) where applicable. |
| **Result** | |
| **Notes** | |

### TC-M11: Smart Action Badges
| Field | Value |
|-------|-------|
| **Precondition** | Email expanded |
| **Steps** | 1. Observe badge area below summary |
| **Expected** | Shows relevant badges: email type, risk level (colored), financial impact (₹), deadline, recommended action. Not all badges appear on every email. |
| **Result** | |
| **Notes** | |

### TC-M12: Gmail OAuth Integration
| Field | Value |
|-------|-------|
| **Precondition** | Gmail not yet connected |
| **Steps** | 1. Go to Settings<br>2. Click "Connect Gmail"<br>3. Complete OAuth flow<br>4. Return to Mail panel<br>5. Sync emails |
| **Expected** | OAuth popup opens, user authorizes, token saved. Mail panel shows synced emails. Token auto-refreshes on expiry. |
| **Result** | |
| **Notes** | |

### TC-M13: Email Search
| Field | Value |
|-------|-------|
| **Precondition** | 5+ emails synced |
| **Steps** | 1. Click search bar in Mail panel<br>2. Type a known sender name or subject keyword<br>3. Observe filtering |
| **Expected** | Email list filters in real-time as user types. Matching emails shown, non-matching hidden. |
| **Result** | |
| **Notes** | |

### TC-M14: Priority Score System
| Field | Value |
|-------|-------|
| **Precondition** | Multiple emails with different urgency levels |
| **Steps** | 1. Open Smart Inbox view<br>2. Compare ordering within each section |
| **Expected** | Higher priority emails appear first within each group. Urgent emails with deadlines or financial impact ranked higher. |
| **Result** | |
| **Notes** | Verify by expanding 2 emails and comparing priority_score in badges. |

### TC-M15: Email Archiving
| Field | Value |
|-------|-------|
| **Precondition** | Email expanded |
| **Steps** | 1. Click green "Done" button<br>2. Observe animation<br>3. Verify email removed from list |
| **Expected** | Email slides out with animation. Removed from inbox view. Does not reappear unless refreshed (if not actually archived in Gmail). |
| **Result** | |
| **Notes** | |

### TC-M16: Email Deletion
| Field | Value |
|-------|-------|
| **Precondition** | Email expanded |
| **Steps** | 1. Click Trash icon<br>2. Verify removal |
| **Expected** | Email removed from local cache. Disappears from inbox immediately. |
| **Result** | |
| **Notes** | |

### TC-M17: Smart Inbox Grouping
| Field | Value |
|-------|-------|
| **Precondition** | 10+ emails synced |
| **Steps** | 1. View Smart Inbox<br>2. Click section headers to collapse/expand |
| **Expected** | Sections collapse and expand smoothly. Count badges update. Empty sections hidden or show "no emails". |
| **Result** | |
| **Notes** | |

### TC-M18: Copy to Clipboard
| Field | Value |
|-------|-------|
| **Precondition** | Reply draft generated |
| **Steps** | 1. Click Copy button in reply mode<br>2. Paste elsewhere (Notepad) |
| **Expected** | Draft text copied to clipboard. "Copied!" confirmation shows briefly. Paste confirms correct text. |
| **Result** | |
| **Notes** | |

### TC-M19: Gmail Compose Integration
| Field | Value |
|-------|-------|
| **Precondition** | Reply draft generated |
| **Steps** | 1. Click "Send via Gmail" button<br>2. Observe browser behavior |
| **Expected** | Default browser opens Gmail compose window pre-addressed to sender. Draft auto-copied to clipboard. |
| **Result** | |
| **Notes** | |

### TC-M20: Snoozed Emails View
| Field | Value |
|-------|-------|
| **Precondition** | At least 1 email snoozed (TC-M06) |
| **Steps** | 1. Look for snoozed section/tab in Mail panel |
| **Expected** | Snoozed emails visible in dedicated section with remaining time indicators. |
| **Result** | |
| **Notes** | |

---

## 2. NOTES PANEL TEST CASES

### TC-N01: Rich Note Editor
| Field | Value |
|-------|-------|
| **Precondition** | None |
| **Steps** | 1. Open Notes panel<br>2. Click "+" to create new note<br>3. Enter title "Test Note"<br>4. Enter body content "This is test content for ARIA"<br>5. Close editor and reopen the note |
| **Expected** | Note editor opens with title + content fields. Content auto-saves. Reopening shows saved content. Timestamps visible. |
| **Result** | |
| **Notes** | |

### TC-N02: Note Tags & Filtering
| Field | Value |
|-------|-------|
| **Precondition** | Note created |
| **Steps** | 1. Open a note in editor<br>2. Add tags: "work", "project"<br>3. Close editor<br>4. Click on "work" tag pill in note card |
| **Expected** | Tags appear as pills on note card. Clicking a tag filters notes list to show only notes with that tag. |
| **Result** | |
| **Notes** | |

### TC-N03: Note Search
| Field | Value |
|-------|-------|
| **Precondition** | Multiple notes created |
| **Steps** | 1. Type a keyword from a note title in search bar<br>2. Observe filtering |
| **Expected** | Notes list filters to show matching notes. Matches by title and content. |
| **Result** | |
| **Notes** | |

### TC-N04: AI Note Summarization
| Field | Value |
|-------|-------|
| **Precondition** | Ollama running, note with 3+ lines of content |
| **Steps** | 1. Open a note with substantial content<br>2. Click "Summarize" button<br>3. Wait for AI response |
| **Expected** | 2-3 sentence summary appears. Loading indicator shown during generation. Summary is accurate to content. |
| **Result** | |
| **Notes** | |

### TC-N05: Extract Action Items
| Field | Value |
|-------|-------|
| **Precondition** | Ollama running, note with actionable content (e.g., "Need to call John, finish report, schedule meeting") |
| **Steps** | 1. Open note with actionable content<br>2. Click "Extract Tasks" button<br>3. Wait for AI response |
| **Expected** | Bulleted list of extracted action items appears. Tasks are specific and actionable. |
| **Result** | |
| **Notes** | |

### TC-N06: Note Templates
| Field | Value |
|-------|-------|
| **Precondition** | None |
| **Steps** | 1. In Notes panel, click template icon button<br>2. View template options (Meeting Notes, Weekly Review, etc.)<br>3. Select "Meeting Notes" template |
| **Expected** | Template picker shows 6 default templates. Selecting creates new note with pre-filled title pattern, sections, and default tags. |
| **Result** | |
| **Notes** | |

### TC-N07: AI Continue Writing
| Field | Value |
|-------|-------|
| **Precondition** | Ollama running, note open in editor with some content |
| **Steps** | 1. Open a note with at least 1 paragraph of content<br>2. Click "Continue" button (PenLine icon) in AI tool strip<br>3. Wait for AI response |
| **Expected** | AI appends 2-3 natural sentences to the note content. Text matches the style and context of existing content. Loading spinner during generation. |
| **Result** | |
| **Notes** | |

### TC-N08: Note Tone Changer
| Field | Value |
|-------|-------|
| **Precondition** | Ollama running, note open in editor with content |
| **Steps** | 1. Open a note with casual content<br>2. Click "Professional" button in AI tool strip<br>3. Observe content change<br>4. Click "Casual" button<br>5. Click "Concise" button |
| **Expected** | Note content rewrites in selected tone. Professional = formal. Casual = relaxed. Concise = shorter. All information preserved. |
| **Result** | |
| **Notes** | |

### TC-N09: Related Notes (Backlinks)
| Field | Value |
|-------|-------|
| **Precondition** | 3+ notes with overlapping keywords or tags |
| **Steps** | 1. Open a note in editor<br>2. Click "Related" button (Link2 icon) in AI tool strip<br>3. Observe related notes panel |
| **Expected** | Yellow-tinted panel appears showing related note titles with relevance. Count badge updates on button. Clicking a related note opens it. |
| **Result** | |
| **Notes** | Create notes with shared keywords for better test: e.g., "Project Alpha plan", "Project Alpha meeting", "Alpha budget" |

### TC-N10: Daily Notes
| Field | Value |
|-------|-------|
| **Precondition** | None |
| **Steps** | 1. In Notes panel, click "Today" button (CalendarDays icon, blue)<br>2. Observe note creation<br>3. Click "Today" again |
| **Expected** | First click: creates note titled "Daily: YYYY-MM-DD" with template sections (Accomplished, Key Thoughts, Tomorrow's Priorities). Auto-tagged "daily". Opens in editor. Second click: opens same note (doesn't create duplicate). |
| **Result** | |
| **Notes** | |

---

## 3. MONEY PANEL TEST CASES

### TC-$01: Transaction Tracking
| Field | Value |
|-------|-------|
| **Precondition** | None |
| **Steps** | 1. Open Money panel<br>2. Click "+" to add transaction<br>3. Enter: amount=500, description="Lunch", category="Food", type=debit<br>4. Save<br>5. Verify in Daily Ledger |
| **Expected** | Transaction form appears. Data saved. Transaction visible in Daily Ledger with date, description, category, ₹500. |
| **Result** | |
| **Notes** | |

### TC-$02: Monthly Cashflow Card
| Field | Value |
|-------|-------|
| **Precondition** | 3+ transactions in current month (mix of income and expense) |
| **Steps** | 1. Open Money panel<br>2. Observe top cashflow card |
| **Expected** | Shows Income total, Expense total, Net balance. Green for surplus, red for deficit. Amounts are correct. |
| **Result** | |
| **Notes** | |

### TC-$03: Category Breakdown
| Field | Value |
|-------|-------|
| **Precondition** | 5+ transactions across different categories |
| **Steps** | 1. Scroll to Category section<br>2. Observe category list |
| **Expected** | Categories listed with total amounts and percentages. Sorted by amount (highest first). |
| **Result** | |
| **Notes** | |

### TC-$04: Donut Pie Chart
| Field | Value |
|-------|-------|
| **Precondition** | Multiple category transactions |
| **Steps** | 1. Observe SVG donut chart in category section |
| **Expected** | Colored donut chart shows up to 6 categories. Center shows total. Colors match category items. Proportions visually accurate. |
| **Result** | |
| **Notes** | |

### TC-$05: Subscription Tracking
| Field | Value |
|-------|-------|
| **Precondition** | 2+ subscriptions added |
| **Steps** | 1. Scroll to Subscriptions section<br>2. Verify subscription list |
| **Expected** | Subscriptions shown with name, amount, billing cycle, next due date. Total monthly subscription cost displayed. |
| **Result** | |
| **Notes** | |

### TC-$06: Unused Subscription Detection
| Field | Value |
|-------|-------|
| **Precondition** | Subscription with no related transactions in 60+ days |
| **Steps** | 1. Add a subscription for a category with no recent transactions<br>2. Navigate to Subscriptions section<br>3. Look for "unused" indicator |
| **Expected** | Orange "unused" badge or warning appears on subscription not used in 60+ days. Suggests cancellation. |
| **Result** | |
| **Notes** | |

### TC-$07: Month-over-Month Comparison
| Field | Value |
|-------|-------|
| **Precondition** | Transactions in both current and previous month |
| **Steps** | 1. Scroll to comparison section<br>2. Observe data |
| **Expected** | Shows current vs previous month spending. Percentage change for overall and per-category. Green for decrease, red for increase. |
| **Result** | |
| **Notes** | |

### TC-$08: Spendable Balance ("In My Pocket")
| Field | Value |
|-------|-------|
| **Precondition** | `monthly_income` set in Settings (e.g., 50000), subscriptions and transactions added |
| **Steps** | 1. Open Money panel<br>2. Find "💚 Spendable Today" card (below cashflow) |
| **Expected** | Shows: Income - Bills - Spent = Spendable amount. Daily budget displayed prominently. Progress bar shows utilization. Days left in month shown. |
| **Result** | |
| **Notes** | If `monthly_income` not set, card should NOT appear. |

### TC-$09: Category Budget Limits
| Field | Value |
|-------|-------|
| **Precondition** | Transactions in "Food" category |
| **Steps** | 1. Scroll to "Category Budget Limits" section (Shield icon)<br>2. Set budget limit for "Food" = ₹8000<br>3. Observe progress bar<br>4. (If possible) Add transactions to exceed limit<br>5. Check warning display |
| **Expected** | Input allows setting limit per category. Progress bar shows current vs limit. Colors: green (<80%), orange (80-100%), red (exceeded). "Over by ₹X" warning when exceeded. ⚠ icon on exceeded categories. |
| **Result** | |
| **Notes** | |

### TC-$10: Daily Ledger
| Field | Value |
|-------|-------|
| **Precondition** | Transactions added |
| **Steps** | 1. Scroll to Daily Ledger section |
| **Expected** | Chronological list showing date, description, category, ₹amount for all current month transactions. Income in green, expenses in red/default. |
| **Result** | |
| **Notes** | |

---

## 4. AI CHAT PANEL TEST CASES

### TC-A01: Multi-Provider AI Chat
| Field | Value |
|-------|-------|
| **Precondition** | Ollama running (or any AI provider configured) |
| **Steps** | 1. Open AI Chat panel<br>2. Type "Hello, what can you help with?"<br>3. Send |
| **Expected** | AI responds with a coherent message. No error. Response appears as bot message bubble with timestamp. |
| **Result** | |
| **Notes** | |

### TC-A02: Chat History Persistence
| Field | Value |
|-------|-------|
| **Precondition** | At least 2 messages sent (TC-A01) |
| **Steps** | 1. Close and reopen the app (or navigate away and back)<br>2. Open AI Chat panel |
| **Expected** | Previous messages are restored with correct timestamps. Both user and bot messages visible. |
| **Result** | |
| **Notes** | |

### TC-A03: Quick Action Chips
| Field | Value |
|-------|-------|
| **Precondition** | None |
| **Steps** | 1. Open AI Chat panel<br>2. Click "Plan today" chip<br>3. Wait for response |
| **Expected** | Full prompt "Help me plan my top 3 priorities for today." is sent. AI responds with planning advice based on your data. |
| **Result** | |
| **Notes** | Verify all 4 chips: Plan today, Inbox first, My spending, Focus stats |

### TC-A04: Chat Mode Selector (Work / Personal / Research)
| Field | Value |
|-------|-------|
| **Precondition** | None |
| **Steps** | 1. Open AI Chat panel<br>2. Observe mode strip at top (Work/Personal/Research)<br>3. Select "Personal" mode<br>4. Send "How should I plan my weekend?"<br>5. Switch to "Work" mode<br>6. Send same question |
| **Expected** | Mode pills are visible with icons. Selected mode highlighted with color. Personal mode: friendly, empathetic response. Work mode: professional, actionable response. Placeholder text updates with mode name. |
| **Result** | |
| **Notes** | |

### TC-A05: AI Memory (Remember Facts)
| Field | Value |
|-------|-------|
| **Precondition** | Ollama running |
| **Steps** | 1. Send message: "Remember that I prefer morning meetings"<br>2. Click Brain icon (top-right) to open memory panel<br>3. Verify "prefer morning meetings" is saved<br>4. Start new conversation, ask "When do I prefer meetings?"<br>5. Delete a memory by clicking × button |
| **Expected** | Memory saved automatically on "remember" keyword. Memory panel shows fact. AI references the memory in future responses. Delete removes from panel and database. |
| **Result** | |
| **Notes** | Also test: "Note that my favorite food is pizza", "My name is [name]" |

### TC-A06: Proactive Suggestions
| Field | Value |
|-------|-------|
| **Precondition** | Clear chat history, have overdue tasks or urgent emails |
| **Steps** | 1. Open AI Chat panel with empty chat (clear first if needed)<br>2. Observe welcome area |
| **Expected** | Welcome message from ARIA + orange-tinted suggestion cards below. Each suggestion has icon + text. Suggestions based on real data (overdue tasks, urgent emails, etc.). Clicking a suggestion sends it as a chat message. |
| **Result** | |
| **Notes** | If no data to suggest, only welcome message shows (no suggestion cards). |

### TC-A07: Follow-Up Question Suggestions
| Field | Value |
|-------|-------|
| **Precondition** | Ollama running |
| **Steps** | 1. Send a question like "What should I focus on today?"<br>2. Wait for AI response<br>3. Look for blue chips below the response |
| **Expected** | After AI responds, 1-3 blue follow-up question chips appear. Content questions are relevant to the conversation. Clicking a chip sends it as a new message. |
| **Result** | |
| **Notes** | Follow-ups depend on AI including FOLLOW_UP: lines. May not appear on all responses. |

### TC-A08: Usage Tracking & Limits
| Field | Value |
|-------|-------|
| **Precondition** | Send a few messages |
| **Steps** | 1. Observe bottom bar usage counter<br>2. Note the count (e.g., "5/20 AI calls today") |
| **Expected** | Counter increments with each AI call. Shows current / limit format. |
| **Result** | |
| **Notes** | |

### TC-A09: Chat Clear
| Field | Value |
|-------|-------|
| **Precondition** | Chat has messages |
| **Steps** | 1. Click "Clear" button (Trash icon) in bottom bar<br>2. Observe chat area |
| **Expected** | All messages removed. Welcome message + proactive suggestions reappear. History cleared from database. |
| **Result** | |
| **Notes** | |

### TC-A10: Context-Aware Responses
| Field | Value |
|-------|-------|
| **Precondition** | Tasks, emails, transactions exist. AI Memory has facts. |
| **Steps** | 1. Ask "What am I supposed to do today?"<br>2. Ask "How much did I spend this month?"<br>3. Ask "Any urgent emails?" |
| **Expected** | AI responses reference your actual data — specific tasks, real spending amounts, actual email subjects. Not generic advice. |
| **Result** | |
| **Notes** | Quality depends on how much data the chat-enhanced handler injects. |

---

## 5. TODAY PANEL TEST CASES

### TC-T01: AI Daily Briefing
| Field | Value |
|-------|-------|
| **Precondition** | AI configured, emails synced, tasks created |
| **Steps** | 1. Open Today panel<br>2. Wait for briefing to load |
| **Expected** | Hero card loads with greeting, priority action (orange), executive brief bullets, and timeline. "Preparing your day..." spinner shown briefly. |
| **Result** | |
| **Notes** | |

### TC-T02: Priority Action Card
| Field | Value |
|-------|-------|
| **Precondition** | Briefing loaded (TC-T01) |
| **Steps** | 1. Observe "Action Needed" card (orange)<br>2. Click on it |
| **Expected** | Shows most important action in 1 sentence. Clicking navigates to relevant panel (mail for email actions, remind for tasks). |
| **Result** | |
| **Notes** | |

### TC-T03: Timeline View
| Field | Value |
|-------|-------|
| **Precondition** | Calendar events and/or tasks exist |
| **Steps** | 1. Observe timeline section in Hero card |
| **Expected** | Chronological list with time stamps (monospace), colored dots (blue=meeting, orange=task, red=email, green=break), and descriptions. |
| **Result** | |
| **Notes** | |

### TC-T04: Day Progress Bar
| Field | Value |
|-------|-------|
| **Precondition** | Tasks created, some completed today |
| **Steps** | 1. Observe progress section at bottom of Hero card |
| **Expected** | Shows "X of Y done". Animated progress bar. Colors: orange (<50%), blue (50-99%), green (100%). "X left" counter on right. |
| **Result** | |
| **Notes** | |

### TC-T05: Zero Inbox Celebration
| Field | Value |
|-------|-------|
| **Precondition** | All tasks completed, no urgent emails |
| **Steps** | 1. Complete all remaining tasks<br>2. Refresh Today panel |
| **Expected** | Green "All clear. Nicely done." card appears with CheckCircle icon and pulse animation. Fades after 4 seconds. |
| **Result** | |
| **Notes** | Hard to trigger — requires zero active tasks AND zero urgent emails. |

### TC-T06: Morning Ritual Card
| Field | Value |
|-------|-------|
| **Precondition** | Tasks with priority scores, focus sessions, calendar events |
| **Steps** | 1. Open Today panel<br>2. Observe "Morning Focus" card (orange gradient, below Hero) |
| **Expected** | Shows: numbered top 3 priorities (color-coded 1=red, 2=orange, 3=yellow), Focus hours today (blue box), Meeting count (purple box). Dismissable with × button. |
| **Result** | |
| **Notes** | |

### TC-T07: Bills Due Soon Section
| Field | Value |
|-------|-------|
| **Precondition** | Subscriptions with due dates within 2 days |
| **Steps** | 1. Add/have a subscription due within 2 days<br>2. Open Today panel<br>3. Look for "Bills Due Soon" card (red CreditCard icon) |
| **Expected** | Card shows bill names with ₹amounts. Only bills due within 2 days shown. Red styling. |
| **Result** | |
| **Notes** | If no bills due soon, section should NOT appear. |

### TC-T08: Habits Tracker Section
| Field | Value |
|-------|-------|
| **Precondition** | Habits configured and not yet completed today |
| **Steps** | 1. Have undone habits for today<br>2. Open Today panel<br>3. Look for "Habits to do" card (green Activity icon) |
| **Expected** | Card shows undone habit names with green dots. Only incomplete habits shown. |
| **Result** | |
| **Notes** | If all habits done or no habits configured, section should NOT appear. |

### TC-T09: AI Suggestions Card
| Field | Value |
|-------|-------|
| **Precondition** | Overdue tasks, urgent emails, or spending anomalies exist |
| **Steps** | 1. Open Today panel<br>2. Look for "ARIA Suggests" card (purple Brain icon) |
| **Expected** | Shows up to 4 proactive suggestions with icons and descriptions. Each has a chevron arrow. Clicking navigates to relevant panel (mail/money/remind/ask). |
| **Result** | |
| **Notes** | Suggestions change based on your actual data state. |

### TC-T10: Quick Navigation
| Field | Value |
|-------|-------|
| **Precondition** | None |
| **Steps** | 1. Click "Subscriptions" collapsible row at bottom<br>2. Verify navigation |
| **Expected** | Navigates to Money panel. Row has 💳 icon and chevron arrow. |
| **Result** | |
| **Notes** | |

---

## Cross-Panel Integration Tests

### TC-X01: Proactive Suggestions Across Panels
| Field | Value |
|-------|-------|
| **Steps** | 1. Create overdue task<br>2. Check Today panel → AI Suggestions<br>3. Check AI Chat panel → Proactive Suggestions |
| **Expected** | Same overdue task appears as suggestion in both Today and AI Chat panels. |

### TC-X02: Morning Ritual Data Accuracy
| Field | Value |
|-------|-------|
| **Steps** | 1. Check Today → Morning Ritual priorities vs Remind panel tasks<br>2. Check focus hours vs actual focus sessions |
| **Expected** | Priorities match actual high-priority tasks. Focus hours match logged focus sessions. |

### TC-X03: Spendable Balance Accuracy
| Field | Value |
|-------|-------|
| **Steps** | 1. Note monthly_income from Settings<br>2. Sum all subscriptions = committed<br>3. Sum all debit transactions this month = spent<br>4. Check Spendable card: income - committed - spent |
| **Expected** | Math is accurate. Daily budget = spendable ÷ remaining days in month. |

### TC-X04: AI Memory Cross-Session
| Field | Value |
|-------|-------|
| **Steps** | 1. In AI Chat, say "Remember I like coffee at 3pm"<br>2. Close app completely<br>3. Reopen app<br>4. Ask "What do I like in the afternoon?" |
| **Expected** | AI references the saved memory about coffee at 3pm. Memory persists across app restarts. |

### TC-X05: Unsubscribe + Block Workflow
| Field | Value |
|-------|-------|
| **Steps** | 1. Find newsletter email with unsubscribe link<br>2. Click unsubscribe (MailX icon)<br>3. Then block sender (Ban icon)<br>4. Sync again |
| **Expected** | Unsubscribe opens browser. Block prevents future emails from appearing. Both actions work together. |

---

## 6. CONTACTS CRM TEST CASES (Phase 3)

### TC-C01: Auto-Extract Contacts from Emails
| Field | Value |
|-------|-------|
| **Precondition** | Emails synced, `contacts` table exists |
| **Steps** | 1. Call `extractContactsFromEmails()` via AI chat e.g. "extract my contacts"<br>2. Check contacts table |
| **Expected** | Contacts created from email senders. noreply/notification addresses filtered out. Each contact has email, name, contact_count. |
| **Result** | |
| **Notes** | |

### TC-C02: Inline Contact Info in Mail
| Field | Value |
|-------|-------|
| **Precondition** | At least 1 contact extracted |
| **Steps** | 1. Open Mail panel<br>2. Expand an email from a known contact |
| **Expected** | Below from_email line, subtle info shows: company (if set), email count, last contacted days ago. |
| **Result** | |
| **Notes** | |

### TC-C03: Keep-in-Touch Suggestions
| Field | Value |
|-------|-------|
| **Precondition** | Contacts with old `last_contacted_at` |
| **Steps** | 1. Open Today panel<br>2. Scroll to Life Dashboard |
| **Expected** | "Reconnect" section shows contacts not emailed in 30+ days with name and days count. |
| **Result** | |
| **Notes** | |

### TC-C04: Add/Update Contact
| Field | Value |
|-------|-------|
| **Precondition** | App running |
| **Steps** | 1. Use `addContact({email:'test@test.com', name:'Test', company:'TestCo'})`<br>2. Update same contact with new company |
| **Expected** | Contact created on first call. Updated (UPSERT on email) on second call. |
| **Result** | |
| **Notes** | |

### TC-C05: Delete Contact
| Field | Value |
|-------|-------|
| **Precondition** | At least 1 contact exists |
| **Steps** | 1. Delete a contact by ID |
| **Expected** | Contact removed from `contacts` table. No longer appears in suggestions or Mail inline info. |
| **Result** | |
| **Notes** | |

---

## 7. TIME TRACKING TEST CASES (Phase 3)

### TC-TT01: Log Time on Task
| Field | Value |
|-------|-------|
| **Precondition** | At least 1 task in Remind panel |
| **Steps** | 1. Open Remind panel<br>2. Click a task to expand<br>3. Click "⏱ Time" button<br>4. Enter 30 minutes<br>5. Click "Log" |
| **Expected** | Time logged. Badge appears "⏱30m" on task. Total updates. |
| **Result** | |
| **Notes** | |

### TC-TT02: Time Badge Display
| Field | Value |
|-------|-------|
| **Precondition** | Task with logged time |
| **Steps** | 1. Open Remind panel<br>2. Look at tasks with logged time |
| **Expected** | Blue badge "⏱Xm" appears next to task title on collapsed view. |
| **Result** | |
| **Notes** | |

### TC-TT03: Productivity Score
| Field | Value |
|-------|-------|
| **Precondition** | Some focus sessions, completed tasks, or habits done today |
| **Steps** | 1. Open Today panel<br>2. Find Life Dashboard section |
| **Expected** | Productivity score 0-100 displayed with color (green≥70, orange≥40, red<40). |
| **Result** | |
| **Notes** | |

### TC-TT04: Billable Hours Summary
| Field | Value |
|-------|-------|
| **Precondition** | Time logs with billable flag |
| **Steps** | 1. Call `getBillableSummary()` |
| **Expected** | Returns total minutes, billable minutes, and billable amount (mins × rate). |
| **Result** | |
| **Notes** | |

---

## 8. READING LIST TEST CASES (Phase 3)

### TC-R01: Add URL to Reading List
| Field | Value |
|-------|-------|
| **Precondition** | Notes panel open |
| **Steps** | 1. Click "📖 Reading" filter pill<br>2. Paste a URL in the input<br>3. Press Enter or click + |
| **Expected** | URL saved. Appears in reading list below. Duplicate URLs are silently ignored. |
| **Result** | |
| **Notes** | |

### TC-R02: Mark as Read
| Field | Value |
|-------|-------|
| **Precondition** | At least 1 reading item |
| **Steps** | 1. In Reading view, click the circle checkbox on an item |
| **Expected** | Circle turns green with checkmark. Item dims to 50% opacity. Title gets strikethrough. |
| **Result** | |
| **Notes** | |

### TC-R03: Delete Reading Item
| Field | Value |
|-------|-------|
| **Precondition** | At least 1 reading item |
| **Steps** | 1. In Reading view, click trash icon on an item |
| **Expected** | Item removed from list immediately. |
| **Result** | |
| **Notes** | |

---

## 9. HEALTH TRACKING TEST CASES (Phase 3)

### TC-H01: Health Summary on Today Panel
| Field | Value |
|-------|-------|
| **Precondition** | Health log exists for today |
| **Steps** | 1. Log health data: `logHealth({water_glasses:4, workout_minutes:30})`<br>2. Open Today panel |
| **Expected** | Life Dashboard shows water count (💧4) and workout minutes (30m 🏃). |
| **Result** | |
| **Notes** | |

### TC-H02: Health Log UPSERT
| Field | Value |
|-------|-------|
| **Precondition** | App running |
| **Steps** | 1. Log health: water=3<br>2. Log health again: water=5 (same day) |
| **Expected** | Only 1 record for today. Water updated to 5 (not appended). UPSERT on date. |
| **Result** | |
| **Notes** | |

### TC-H03: 7-Day Health Averages
| Field | Value |
|-------|-------|
| **Precondition** | Multiple days of health data |
| **Steps** | 1. Call `getHealthSummary()` |
| **Expected** | Returns today's log + 7-day averages for water, sleep, workout. Includes workout streak count. |
| **Result** | |
| **Notes** | |

---

## 10. TRAVEL TEST CASES (Phase 3)

### TC-TR01: Extract Trips from Emails
| Field | Value |
|-------|-------|
| **Precondition** | Emails with booking confirmations synced |
| **Steps** | 1. Call `extractTripsFromEmails()` |
| **Expected** | Trips created from booking emails. Destination, dates, PNR, type extracted. Duplicates avoided via source_email_id. |
| **Result** | |
| **Notes** | |

### TC-TR02: Upcoming Trips on Today Panel
| Field | Value |
|-------|-------|
| **Precondition** | Trip with future start_date exists |
| **Steps** | 1. Open Today panel<br>2. Look at Life Dashboard |
| **Expected** | "Upcoming Trips" section shows trip with icon (✈️/🏨/🚂), destination, and date. |
| **Result** | |
| **Notes** | |

### TC-TR03: Add Trip Manually
| Field | Value |
|-------|-------|
| **Precondition** | App running |
| **Steps** | 1. Call `addTrip({title:'London Trip', destination:'London', start_date:'2025-08-01', type:'flight'})` |
| **Expected** | Trip created. Appears in upcoming trips. |
| **Result** | |
| **Notes** | |

### TC-TR04: Delete Trip
| Field | Value |
|-------|-------|
| **Precondition** | At least 1 trip exists |
| **Steps** | 1. Delete trip by ID |
| **Expected** | Trip removed from database and no longer appears on Today panel. |
| **Result** | |
| **Notes** | |

---

## 11. MEETING PREP TEST CASES (Phase 3)

### TC-MP01: Create Meeting Prep Note
| Field | Value |
|-------|-------|
| **Precondition** | App running |
| **Steps** | 1. Call `createMeetingPrep('Team Standup', '2025-06-20', 'Alice, Bob')`<br>2. Open Notes panel |
| **Expected** | Note created with "Meeting Prep: Team Standup" title, template content (Agenda/Discussion/Decisions/Action Items), tagged "meeting". |
| **Result** | |
| **Notes** | |

### TC-MP02: Meeting Stats on Today Panel
| Field | Value |
|-------|-------|
| **Precondition** | Calendar events synced for this week |
| **Steps** | 1. Open Today panel<br>2. Check Life Dashboard |
| **Expected** | "Meetings/wk" count displayed in purple card (if > 0). |
| **Result** | |
| **Notes** | |

---

## 12. WHATSAPP TEST CASES (Phase 3)

### TC-W01: WhatsApp Settings Configuration
| Field | Value |
|-------|-------|
| **Precondition** | Twilio account created |
| **Steps** | 1. Open Settings panel<br>2. Find "WhatsApp Briefing" section<br>3. Enter phone, Twilio SID, Auth Token, From Number<br>4. Enable toggle<br>5. Click Save |
| **Expected** | All fields saved. Status shows "✅ Configured". |
| **Result** | |
| **Notes** | |

### TC-W02: WhatsApp Test Message
| Field | Value |
|-------|-------|
| **Precondition** | WhatsApp configured |
| **Steps** | 1. Click "📱 Test via WhatsApp Web" button |
| **Expected** | Opens WhatsApp Web in browser with pre-formatted message to configured phone number. |
| **Result** | |
| **Notes** | |

### TC-W03: Send WhatsApp Briefing
| Field | Value |
|-------|-------|
| **Precondition** | Twilio credentials configured and valid |
| **Steps** | 1. Click "📬 Send Briefing Now" button<br>2. Wait for response |
| **Expected** | Shows "Sending…" then "✅ Sent!" on success. WhatsApp message received with briefing content. |
| **Result** | |
| **Notes** | |

---

## 13. SETTINGS NEW SECTIONS TEST CASES (Phase 3)

### TC-S01: Profile Settings
| Field | Value |
|-------|-------|
| **Precondition** | App running |
| **Steps** | 1. Open Settings panel<br>2. Find "Profile" section<br>3. Enter name and monthly income<br>4. Click Save |
| **Expected** | Values saved. Used by Money panel for spendable balance calculation. |
| **Result** | |
| **Notes** | |

---

## Cross-Panel Integration Tests (Phase 3 Additions)

### TC-X06: Life Dashboard Comprehensive
| Field | Value |
|-------|-------|
| **Precondition** | Focus sessions, health log, trips, contacts all populated |
| **Steps** | 1. Open Today panel<br>2. Verify Life Dashboard shows all sections |
| **Expected** | Productivity score, health widget, upcoming trips, and reconnect contacts all render. Dashboard doesn't clutter main view. |
| **Result** | |
| **Notes** | |

### TC-X07: Time Tracking End-to-End
| Field | Value |
|-------|-------|
| **Precondition** | Task created, time logged |
| **Steps** | 1. Create task<br>2. Log 45 min<br>3. Check productivity score<br>4. Check time logs |
| **Expected** | Time logged on task, badge visible, productivity score includes focus contribution, time log entry exists. |
| **Result** | |
| **Notes** | |

### TC-X08: Contact CRM Email Integration
| Field | Value |
|-------|-------|
| **Precondition** | Emails synced, contacts extracted |
| **Steps** | 1. Extract contacts from emails<br>2. Open email from extracted contact<br>3. Check inline contact info |
| **Expected** | Contact auto-created. Email expanded shows company/count/last-contacted inline. |
| **Result** | |
| **Notes** | |

### TC-X09: Reading List Workflow
| Field | Value |
|-------|-------|
| **Precondition** | Notes panel open |
| **Steps** | 1. Switch to Reading mode<br>2. Add 3 URLs<br>3. Mark 1 as read<br>4. Delete 1<br>5. Switch back to notes mode |
| **Expected** | URLs saved, read status updates visually, delete removes item, switching back shows normal notes. |
| **Result** | |
| **Notes** | |

### TC-X10: WhatsApp Briefing Content Accuracy
| Field | Value |
|-------|-------|
| **Precondition** | WhatsApp configured, tasks and emails exist |
| **Steps** | 1. Create an overdue task<br>2. Sync urgent email<br>3. Send WhatsApp briefing |
| **Expected** | WhatsApp message includes the overdue task and urgent email information accurately. |
| **Result** | |
| **Notes** | |

---

## Test Summary Sheet

| Panel | Total | Pass | Fail | Skip | Notes |
|-------|-------|------|------|------|-------|
| Mail | 20 | | | | |
| Notes | 10 | | | | |
| Money | 10 | | | | |
| AI Chat | 10 | | | | |
| Today | 10 | | | | |
| Cross-Panel (P2) | 5 | | | | |
| Contacts CRM | 5 | | | | |
| Time Tracking | 4 | | | | |
| Reading List | 3 | | | | |
| Health Tracking | 3 | | | | |
| Travel | 4 | | | | |
| Meeting Prep | 2 | | | | |
| WhatsApp | 3 | | | | |
| Settings (P3) | 1 | | | | |
| Cross-Panel (P3) | 5 | | | | |
| Learning Loop (P8-1) | 7 | | | | |
| Session Memory (P8-2) | 8 | | | | |
| Graceful Fallback (P8-3) | 5 | | | | |
| **TOTAL** | **115** | | | | |

---

## Phase 8 — Intelligence Layer Test Cases

### TC-P8-01: Learning Loop — Confirm Feedback
| Field | Value |
|-------|-------|
| **Precondition** | App running, Ask panel open |
| **Steps** | 1. Type "remind me to call mom at 5pm"<br>2. Wait for proposal card<br>3. Click "Do it" (Confirm) |
| **Expected** | Reminder saved. `action_feedback` table has new row with `action_type='reminder'`, `confirmed=1`. |
| **Result** | |
| **Notes** | Verify in DevTools: `await window.aria.getActionFeedback('reminder')` |

### TC-P8-02: Learning Loop — Dismiss Feedback
| Field | Value |
|-------|-------|
| **Precondition** | App running, Ask panel open |
| **Steps** | 1. Type "check my email"<br>2. Wait for proposal card<br>3. Click "Nah" (Dismiss) |
| **Expected** | No email fetch happens. `action_feedback` table has new row with `action_type='email'`, `confirmed=0`. |
| **Result** | |
| **Notes** | Verify: `await window.aria.getActionFeedback('email')` shows dismissed_count incremented |

### TC-P8-03: Learning Loop — Confidence Weight Neutral
| Field | Value |
|-------|-------|
| **Precondition** | Fresh install or cleared feedback table |
| **Steps** | 1. Type "remind me to call mom at 5pm"<br>2. Observe proposal |
| **Expected** | Proposal appears normally. With <3 feedback entries, confidence weight is neutral (1.0). |
| **Result** | |
| **Notes** | |

### TC-P8-04: Learning Loop — Dismiss Suppresses Proposals
| Field | Value |
|-------|-------|
| **Precondition** | App running |
| **Steps** | 1. Dismiss email proposals 5+ times<br>2. Type "check my email" again |
| **Expected** | After ~5 dismissals, email proposals stop appearing. ARIA routes to chat instead of proposing refresh. |
| **Result** | |
| **Notes** | Weight drops below 0.5 threshold |

### TC-P8-05: Learning Loop — Feedback Stats API
| Field | Value |
|-------|-------|
| **Precondition** | Some confirm/dismiss history exists |
| **Steps** | 1. Open DevTools console<br>2. Run `await window.aria.getActionFeedback(null)` |
| **Expected** | Returns array of objects with `action_type`, `total`, `confirmed_count`, `dismissed_count`. |
| **Result** | |
| **Notes** | |

### TC-P8-06: Learning Loop — Dismiss Action IPC
| Field | Value |
|-------|-------|
| **Precondition** | App running |
| **Steps** | 1. Open DevTools console<br>2. Run `await window.aria.dismissAction('reminder', {})` |
| **Expected** | Returns `{ ok: true, text: 'Action dismissed.' }`. New row in `action_feedback` with `confirmed=0`. |
| **Result** | |
| **Notes** | |

### TC-P8-07: Learning Loop — High Confirm Rate
| Field | Value |
|-------|-------|
| **Precondition** | App running |
| **Steps** | 1. Confirm reminder proposals 5+ times<br>2. Type "remind me to buy groceries" |
| **Expected** | Proposal still appears (weight > 1.0). High confirm rate does not suppress proposals. |
| **Result** | |
| **Notes** | |

---

### TC-P8-08: Session Memory — Don't Worry Pattern
| Field | Value |
|-------|-------|
| **Precondition** | App running, Ask panel open |
| **Steps** | 1. Type "I'm not worried about AWS costs this month"<br>2. Check DevTools: `await window.aria.getSessionPreferences()` |
| **Expected** | Preference stored with key containing 'aws-costs', value 'AWS costs this month', TTL 30 days. |
| **Result** | |
| **Notes** | |

### TC-P8-09: Session Memory — Permanent Preference
| Field | Value |
|-------|-------|
| **Precondition** | App running, Ask panel open |
| **Steps** | 1. Type "I work at Google"<br>2. Check preferences |
| **Expected** | Preference stored with TTL 0 (permanent). `expires_at` is 0 or null. |
| **Result** | |
| **Notes** | |

### TC-P8-10: Session Memory — From Now On Pattern
| Field | Value |
|-------|-------|
| **Precondition** | App running, Ask panel open |
| **Steps** | 1. Type "from now on, always show me tasks first"<br>2. Check preferences |
| **Expected** | Preference stored with TTL 90 days. |
| **Result** | |
| **Notes** | |

### TC-P8-11: Session Memory — Injected in AI Context
| Field | Value |
|-------|-------|
| **Precondition** | At least one preference stored |
| **Steps** | 1. Ask any question (e.g. "what should I focus on?")<br>2. Observe response |
| **Expected** | ARIA's response respects stored preferences (e.g. doesn't mention AWS costs if that was dismissed). |
| **Result** | |
| **Notes** | Check console for "USER PREFERENCES" in system context |

### TC-P8-12: Session Memory — Expired Cleanup
| Field | Value |
|-------|-------|
| **Precondition** | Insert a preference with past expires_at |
| **Steps** | 1. Manually insert expired pref in DB<br>2. Send any message to ARIA<br>3. Check `session_preferences` table |
| **Expected** | Expired row deleted. Only active non-expired prefs remain. |
| **Result** | |
| **Notes** | |

### TC-P8-13: Session Memory — Clear Preference
| Field | Value |
|-------|-------|
| **Precondition** | Preference exists |
| **Steps** | 1. Get pref id from `getSessionPreferences()`<br>2. Run `await window.aria.clearSessionPreference(id)` |
| **Expected** | Returns `{ ok: true }`. Preference no longer in table. |
| **Result** | |
| **Notes** | |

### TC-P8-14: Session Memory — Non-Preference Ignored
| Field | Value |
|-------|-------|
| **Precondition** | App running |
| **Steps** | 1. Type "what's the weather?"<br>2. Check `session_preferences` table |
| **Expected** | No new preference row created. Normal response returned. |
| **Result** | |
| **Notes** | |

### TC-P8-15: Session Memory — Get Preferences IPC
| Field | Value |
|-------|-------|
| **Precondition** | Some stored preferences |
| **Steps** | 1. Run `await window.aria.getSessionPreferences()` |
| **Expected** | Returns array of objects with key, value, source_message, created_at. |
| **Result** | |
| **Notes** | |

---

### TC-P8-16: Graceful Fallback — Action-Seeking Language
| Field | Value |
|-------|-------|
| **Precondition** | App running, Ask panel open |
| **Steps** | 1. Type "can you do something about my overdue tasks?" |
| **Expected** | ARIA proposes a specific action (e.g. "Want me to list your overdue tasks?" or "I can mark them as done"). Does NOT say "I don't understand". |
| **Result** | |
| **Notes** | |

### TC-P8-17: Graceful Fallback — Help Me Deal With
| Field | Value |
|-------|-------|
| **Precondition** | App running |
| **Steps** | 1. Type "help me deal with my inbox" |
| **Expected** | ARIA suggests concrete steps (e.g. "Want me to refresh your inbox?" or "I see 5 unread emails — want a summary?"). |
| **Result** | |
| **Notes** | |

### TC-P8-18: Graceful Fallback — Normal Chat Unaffected
| Field | Value |
|-------|-------|
| **Precondition** | App running |
| **Steps** | 1. Type "tell me a joke" or "what did I have for lunch?" |
| **Expected** | Normal conversational response. No forced action proposal. |
| **Result** | |
| **Notes** | |

### TC-P8-19: Graceful Fallback — Handle Verb
| Field | Value |
|-------|-------|
| **Precondition** | App running |
| **Steps** | 1. Type "handle my subscriptions" |
| **Expected** | ARIA proposes something relevant (e.g. "You have 3 subscriptions renewing soon — want to see them?"). |
| **Result** | |
| **Notes** | |

### TC-P8-20: Graceful Fallback — Fix Verb
| Field | Value |
|-------|-------|
| **Precondition** | App running |
| **Steps** | 1. Type "fix my schedule for tomorrow" |
| **Expected** | ARIA proposes organizing tasks or reviewing calendar, not "I can't do that". |
| **Result** | |
| **Notes** | |

---

## Phase 10 — Intelligence Layers (P10-1 through P10-5)

> **30 test cases** covering all 5 intelligence features added in Phase 10.

---

### P10-1: Learning Layer (Signal-Level Behavioral Learning)

### TC-P10-01: Signal Tracking — Dismiss Card
| Field | Value |
|-------|-------|
| **Precondition** | Today panel loaded with at least 1 priority card |
| **Steps** | 1. Hover over a priority card in Today panel 2. Click the X (dismiss) button that appears |
| **Expected** | Card disappears from view. `signal_interactions` table has a row with action='dismissed'. |
| **Result** | |
| **Notes** | |

### TC-P10-02: Signal Tracking — Act on Card
| Field | Value |
|-------|-------|
| **Precondition** | Today panel loaded with at least 1 priority card |
| **Steps** | 1. Click on a priority card to expand it |
| **Expected** | Card expands. `signal_interactions` table records action='acted' for that signal_id. |
| **Result** | |
| **Notes** | |

### TC-P10-03: Learning Multiplier — Computed After 5+ Interactions
| Field | Value |
|-------|-------|
| **Precondition** | At least 5 interactions recorded for one domain (e.g. 'email') |
| **Steps** | 1. Dismiss 4 email cards, act on 1 email card 2. Refresh Today panel |
| **Expected** | `signal_adjustments` table shows multiplier < 1.0 for 'email' domain. Email priority scores are lower. |
| **Result** | |
| **Notes** | Multiplier range: 0.5x to 1.5x. Requires 5+ samples to activate. |

### TC-P10-04: Learned Indicator — Brain Emoji on Adjusted Cards
| Field | Value |
|-------|-------|
| **Precondition** | Signal adjustments exist (multiplier ≠ 1.0) for at least one domain |
| **Steps** | 1. Open Today panel |
| **Expected** | Cards with adjusted scores show a 🧠 brain emoji badge. Hovering shows the multiplier value. |
| **Result** | |
| **Notes** | |

### TC-P10-05: Signal Stats — IPC Handler
| Field | Value |
|-------|-------|
| **Precondition** | Some signal interactions recorded |
| **Steps** | 1. Call `window.aria.getSignalStats()` from console |
| **Expected** | Returns object with `stats` (per-domain breakdown) and `adjustments` (multiplier per domain). |
| **Result** | |
| **Notes** | |

### TC-P10-06: Dismissed Cards Reset on Refresh
| Field | Value |
|-------|-------|
| **Precondition** | Today panel loaded |
| **Steps** | 1. Dismiss 2 cards 2. Click Refresh button |
| **Expected** | All cards reappear (dismissed state is local/temporary). Signal interactions are persisted in DB. |
| **Result** | |
| **Notes** | |

---

### P10-2: Predictive Engine (Time Estimates & Risk Detection)

### TC-P10-07: Task Completion Recording
| Field | Value |
|-------|-------|
| **Precondition** | At least 1 active task exists |
| **Steps** | 1. Complete a task via Remind panel |
| **Expected** | `task_completions` table has a new row with task_title, category, actual_minutes. |
| **Result** | |
| **Notes** | actual_minutes = (completed_at - created_at) / 60 |

### TC-P10-08: Deadline Risk Detection
| Field | Value |
|-------|-------|
| **Precondition** | A task with deadline in next 2 days, and 3+ task_completions for same category |
| **Steps** | 1. Open Today panel |
| **Expected** | A prediction signal card appears with ⏱️ icon, showing estimated time needed vs time remaining. |
| **Result** | |
| **Notes** | Risk levels: critical (time < needed), high (time < 1.5x needed), medium (time < 2x needed) |

### TC-P10-09: Prediction Signal in Priority List
| Field | Value |
|-------|-------|
| **Precondition** | At least one deadline risk exists |
| **Steps** | 1. Open Today panel and check for domain='prediction' cards |
| **Expected** | Prediction cards show with ⏱️ icon, estimated hours, hours remaining, and risk level in confidence badge. |
| **Result** | |
| **Notes** | |

### TC-P10-10: Bill Prediction — Missed Renewal
| Field | Value |
|-------|-------|
| **Precondition** | A subscription with next_renewal in the past 7 days |
| **Steps** | 1. Open Today panel |
| **Expected** | A prediction signal for 'bill_prediction' type appears warning about potential missed payment. |
| **Result** | |
| **Notes** | |

### TC-P10-11: Prediction IPC — Get Predictions
| Field | Value |
|-------|-------|
| **Precondition** | App running |
| **Steps** | 1. Call `window.aria.getPredictions()` from console |
| **Expected** | Returns `{ ok: true, signals: [...] }` with unresolved prediction_signals. |
| **Result** | |
| **Notes** | |

### TC-P10-12: Time Estimation Accuracy
| Field | Value |
|-------|-------|
| **Precondition** | 5+ task_completions exist for a category |
| **Steps** | 1. Create a new task in that category with a tight deadline |
| **Expected** | Prediction shows estimated time based on average of historical completions for that category. |
| **Result** | |
| **Notes** | Confidence: 'high' if 10+ samples, 'medium' if 2-9, 'low' if 0-1. |

---

### P10-3: Relationship Intelligence (Contact Classification)

### TC-P10-13: Relationship Analysis — IPC
| Field | Value |
|-------|-------|
| **Precondition** | Email cache has 2+ emails from at least 3 unique senders |
| **Steps** | 1. Call `window.aria.analyzeRelationships()` from console |
| **Expected** | Returns `{ ok: true, analyzed: N }` where N > 0. `sender_profiles` table populated with classified senders. |
| **Result** | |
| **Notes** | |

### TC-P10-14: Sender Classification Types
| Field | Value |
|-------|-------|
| **Precondition** | analyzeRelationships() has been run |
| **Steps** | 1. Query sender_profiles table |
| **Expected** | Senders classified as: boss/client/colleague/vendor/newsletter/unknown based on response rate and patterns. |
| **Result** | |
| **Notes** | boss: >80% response + <4h avg + 5+ emails. newsletter: <20% response or noreply domain. |

### TC-P10-15: Sender Badge on Email Cards
| Field | Value |
|-------|-------|
| **Precondition** | sender_profiles populated with classified senders, email cards in Today panel |
| **Steps** | 1. Open Today panel with email priority cards |
| **Expected** | Email cards show sender relationship badge (e.g. 👔 Boss, 💼 Client, 📰 Newsletter) if classified. |
| **Result** | |
| **Notes** | |

### TC-P10-16: Email Score Adjustment by Relationship
| Field | Value |
|-------|-------|
| **Precondition** | sender_profiles exist with boss (importance=90) and newsletter (importance=10) |
| **Steps** | 1. Open Today panel |
| **Expected** | Email from boss has higher score than email from newsletter (score adjusted by sender importance). |
| **Result** | |
| **Notes** | Adjustment: (importance - 50) / 100 * 0.5 factor applied to base score. |

### TC-P10-17: Relationship Risk Detection
| Field | Value |
|-------|-------|
| **Precondition** | sender_profiles with importance >= 50 and last email > 2x normal gap |
| **Steps** | 1. Open Today panel |
| **Expected** | Relationship risk card appears with 🤝 icon showing "N days since last contact (normally every X days)". |
| **Result** | |
| **Notes** | |

### TC-P10-18: Relationship Profile IPC
| Field | Value |
|-------|-------|
| **Precondition** | sender_profiles populated |
| **Steps** | 1. Call `window.aria.getRelationshipProfile('email@example.com')` |
| **Expected** | Returns the full sender_profiles row: relationship_type, response_rate, importance_score, etc. |
| **Result** | |
| **Notes** | |

### TC-P10-19: Brain Data Includes Key Relationships
| Field | Value |
|-------|-------|
| **Precondition** | sender_profiles with importance >= 70 exist |
| **Steps** | 1. Type a message in chat and observe AI context |
| **Expected** | buildPersonalBrain includes "KEY RELATIONSHIPS" section with high-importance senders. |
| **Result** | |
| **Notes** | Only senders with importance_score >= 70 are included. |

---

### P10-4: Context Memory (Entity Extraction & Cross-Item Linking)

### TC-P10-20: Entity Extraction from Chat
| Field | Value |
|-------|-------|
| **Precondition** | App running |
| **Steps** | 1. Type "I'm working on the Acme Corp proposal for Priya" in chat |
| **Expected** | context_threads table has entry with topic containing "Acme Corp". context_entities has "Acme Corp" (company) and "Priya" (person). |
| **Result** | |
| **Notes** | |

### TC-P10-21: Cross-Item Linking
| Field | Value |
|-------|-------|
| **Precondition** | An email with "Acme" in subject exists in email_cache |
| **Steps** | 1. Type "I'm reviewing the Acme proposal" in chat |
| **Expected** | context_links table links the context thread to the Acme email(s) via item_type='email'. |
| **Result** | |
| **Notes** | Auto-linking searches emails, tasks, and notes for matching entity values. |

### TC-P10-22: Active Contexts in Brain Data
| Field | Value |
|-------|-------|
| **Precondition** | Active context threads exist |
| **Steps** | 1. Type any question in chat |
| **Expected** | AI response context includes "ACTIVE CONTEXT THREADS" section with thread topics and entities. |
| **Result** | |
| **Notes** | |

### TC-P10-23: Get Active Contexts IPC
| Field | Value |
|-------|-------|
| **Precondition** | Context threads exist |
| **Steps** | 1. Call `window.aria.getActiveContexts()` from console |
| **Expected** | Returns `{ ok: true, contexts: [...] }` with active threads, entities, and link_count. |
| **Result** | |
| **Notes** | |

### TC-P10-24: Context For Item IPC
| Field | Value |
|-------|-------|
| **Precondition** | A context thread linked to an email exists |
| **Steps** | 1. Call `window.aria.getContextForItem('email', '<message_id>')` |
| **Expected** | Returns matching context threads for that item with topic, entities, and relevance score. |
| **Result** | |
| **Notes** | |

---

### P10-5: Outcome Tracking (ROI & Value Proof)

### TC-P10-25: Time Saved Auto-Tracking
| Field | Value |
|-------|-------|
| **Precondition** | App running, email sync has run |
| **Steps** | 1. Open Today panel (triggers get-user-state) |
| **Expected** | `time_saved_log` table has entry for 'auto_prioritize' with minutes_saved and details. |
| **Result** | |
| **Notes** | Auto-tracked: auto_prioritize (5min), email_triage (0.5min/email), confirmed_action (1min each). |

### TC-P10-26: Prevented Issue Tracking
| Field | Value |
|-------|-------|
| **Precondition** | Overdue tasks or tight-deadline tasks exist |
| **Steps** | 1. Complete a task that was about to be overdue (< 24h remaining) |
| **Expected** | `prevented_issues` table has entry with issue_type='missed_deadline'. |
| **Result** | |
| **Notes** | Also tracked: late_payment (missed subscription renewals), deadline warnings from predictive engine. |

### TC-P10-27: Outcome Report IPC
| Field | Value |
|-------|-------|
| **Precondition** | Some time_saved_log and/or prevented_issues exist |
| **Steps** | 1. Call `window.aria.getOutcomeReport()` from console |
| **Expected** | Returns object with: timeSaved (totalHours, breakdown), issuesPrevented (total, totalSavings), roi (multiple, totalValue). |
| **Result** | |
| **Notes** | ROI = (time_value + prevented_costs) / ₹125 weekly sub cost. |

### TC-P10-28: Outcome Stats in Today Panel
| Field | Value |
|-------|-------|
| **Precondition** | time_saved_log and/or prevented_issues have data |
| **Steps** | 1. Open Today panel |
| **Expected** | Green strip below summary shows: "This week: Xh saved · N issues caught · Yx ROI" with TrendingUp icon. |
| **Result** | |
| **Notes** | Only shown when hoursSaved > 0 or issuesCaught > 0. |

### TC-P10-29: Outcome in Weekly Report
| Field | Value |
|-------|-------|
| **Precondition** | Outcome data exists for this week |
| **Steps** | 1. Call `window.aria.getWeeklyReport()` |
| **Expected** | Report includes `outcome` section with timeSaved and issuesPrevented breakdowns. Fallback summary mentions ARIA's value. |
| **Result** | |
| **Notes** | |

### TC-P10-30: Outcome History IPC
| Field | Value |
|-------|-------|
| **Precondition** | App has been running for some time |
| **Steps** | 1. Call `window.aria.getOutcomeHistory()` from console |
| **Expected** | Returns `{ ok: true, snapshots: [...] }` containing weekly outcome_snapshots (up to 12 weeks). |
| **Result** | |
| **Notes** | Snapshots include: week_start, total_minutes_saved, issues_prevented, roi_multiple. |

---

## Environment

| Item | Value |
|------|-------|
| OS | Windows |
| Node.js | |
| Electron | 28.2 |
| Ollama Model | llama3.2:3b |
| Test Date | |
| Tester | |
| Build Version | |
