# ARIA Personnel Bot

ARIA Personnel Bot is an intelligent, privacy-focused personal assistant designed to help users manage their daily tasks, emails, calendar events, habits, finances, and more. Built with a modular architecture, ARIA integrates AI, secure credential storage, and a modern UI to deliver actionable insights and automation for knowledge workers.

## Features
- **AI-Powered Chat**: Natural language chat interface for queries, reminders, and task management.
- **Calendar & Email Intelligence**: Integrates with Gmail and calendar services to summarize, remind, and analyze events and messages.
- **Focus & Habit Tracking**: Built-in Pomodoro timer and habit tracker to boost productivity.
- **Financial Insights**: Automated parsing and summarization of financial emails and transactions.
- **Weekly Reports**: Generates actionable weekly summaries and insights.
- **Secure Credential Storage**: Uses OS keychain (keytar) for sensitive tokens and secrets.
- **Extensible Services**: Modular service architecture for analytics, weather, reminders, and more.

## Project Structure
```
aria-bot/
  assets/           # Icons, images, and static assets
  db/               # Database schema and access layer
  dist-electron/    # Electron build outputs
  docs/             # Documentation (features, testing)
  electron/         # Electron main, preload, and tray scripts
  python-engine/    # Python AI engine (LLM, RAG, agent logic)
  services/         # Modular Node.js services (AI, calendar, email, etc.)
  src/              # React frontend (components, context, hooks)
  ...
```

## Setup & Installation
1. **Clone the repository:**
   ```sh
   git clone https://github.com/guardian-os-ai/aria-bot.git
   cd aria-bot
   ```
2. **Install dependencies:**
   ```sh
   npm install
   pip install -r python-engine/requirements.txt
   ```
3. **Configure environment variables:**
   - Copy `.env.example` to `.env` and fill in required API keys and secrets.
   - Sensitive credentials are stored securely using keytar.
4. **Run the app:**
   ```sh
   npm run dev
   # or for Electron
   npm run electron:dev
   ```

## Usage Flow
- **Startup**: Electron launches, loads environment, and starts the Python AI engine as a sidecar.
- **User Interaction**: Users interact via the chat UI, panels (Today, Remind, Money, Notes, etc.), and receive insights and reminders.
- **AI & Services**: User queries are routed to the Python engine and Node.js services for processing, summarization, and action.
- **Security**: All sensitive tokens are managed via OS credential store; no secrets are stored in plaintext.

## Security & Privacy
- API keys, tokens, and secrets are never stored in plaintext or committed to git.
- Use `.env` and OS keychain for all sensitive configuration.
- See `.gitignore` for excluded files and patterns.

## Contributing
Pull requests and issues are welcome! Please see `docs/FEATURE_DOCUMENTATION.md` and `docs/TESTING_DOCUMENT.md` for guidelines.

## License
[MIT](LICENSE)

---

For more details, see the implementation plan and roadmap in the root directory.
