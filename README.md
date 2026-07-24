# 🚀 Upwork Assistant Bot (AI-Powered & Telegram Controlled)

An enterprise-grade, anti-bot resilient automated system for monitoring Upwork job feeds, evaluating candidacy via Google Gemini AI, drafting human-sounding proposals, supporting multi-document attachments, and providing full remote management through an interactive Telegram Bot interface.

---

## 🏗️ System Architecture & File Map

```
├── attachments/            # Persistent attachments library (PDFs, ZIPs, Portfolio docs)
├── browser-data_*/         # Dynamic, isolated Chrome user profile data per account (Git-ignored)
├── src/
│   ├── config.js          # Centralized configuration, selectors, and dynamic active account getters
│   ├── browser.js         # Chrome process spawning, port checks, and CDP attachment
│   ├── cloudflare.js      # Cloudflare Turnstile challenge solver & wait handler
│   ├── auth.js            # Auto-login, cookies management, and profile parsing
│   ├── page-utils.js      # Job tiles parsing and DOM navigation helpers
│   ├── storage.js         # Local alerted list tracker (notified_jobs.json)
│   ├── notifier.js        # Telegram alerts, inline checklists, and callback polling loops
│   ├── scraper.js         # Job listing parser and full details scraper
│   ├── proposal.js        # Gemini AI proposal generator and conversational rewriter
│   ├── submitter.js       # Playwright human typing and multi-file input attachment handler
│   ├── resume-parser.js   # PDF/DOCX/TXT resume parser
│   ├── resume.js          # Boot-up resume rules analyzer and name extractor
│   ├── stats.js           # Live runtime metrics and connects statistics collector
│   ├── db.js              # MongoDB Atlas connection manager & analytics driver
│   └── auth-signals.js    # custom Event Emitter bridge for login & credentials signals
├── .env                   # Local credentials (ignored in Git)
├── .env.example           # Template for environment configuration
├── rules.json             # Search queries, tech skills, portfolio projects, and rules
├── notified_jobs.json     # Deduplicated record of already processed jobs
├── scraper-bot.js         # Main orchestrator / startup entry point
└── package.json           # Node.js dependencies and scripts
```

---

## 🛡️ Anti-Bot Evasion & Stealth Architecture

Upwork enforces strict Cloudflare Turnstile checks and behavioral profiling. Typical automated browser setups (Puppeteer/Playwright) leave specific internal automation flags (`navigator.webdriver = true`) that get flagged instantly.

### Core Evasion Mechanisms:
1. **Chrome DevTools Protocol (CDP):** The bot attaches to a **real, installed Google Chrome application** running over debugging port `9222`.
2. **Launch Safeguards:** Chrome is launched natively with `--disable-blink-features=AutomationControlled` to wipe automation parameters from the renderer context.
3. **Cloudflare Turnstile Auto-Solver:** If a Cloudflare "I am human" checkbox widget appears, the bot grabs the iframe coordinates, models **human-like cursor curves and acceleration (12 distinct steps)**, moves to the checkbox, and executes mouse press-release cycles.
4. **Gaussian Typing Jitter:** Text inputs are typed char-by-char using Gaussian normal distribution delays (30ms–90ms) with cognitive pauses on spaces and capital letters.
5. **Human Pacing & Random Delays:** Search runs add random jitter (15–25 seconds) between queries, and proposal submissions use random delays (60–120 seconds) to avoid rate limits. Next scrape runs are scheduled with a dynamic jitter of `-2` to `+5` minutes.

---

## 🌟 Key Features

### 🏢 1. Dynamic Multi-Account & Profile Isolation
* **Accounts Panel (`/accounts`):** Register, list, switch, and delete multiple Upwork bidding accounts directly from Telegram.
* **Isolated Session Folders:** Each account uses its own dedicated browser session directory (`browser-data_<email>/`) and cookie storage (`cookies_<email>.json`) so sessions never mix.
* **Quiet Auto-Login:** When switching profiles, the bot logs in automatically using credentials saved in MongoDB, completely bypassing Telegram credentials prompts.

### 🔒 2. Robust 2FA & Security Question Bypass
* **Security Challenge Interception:** If Upwork asks for a security question (e.g. maiden name, pet name), the bot scrapes the question, alerts the owner on Telegram, and waits.
* **Auto-Fill Submission:** The answer sent back via Telegram is filled and submitted automatically.
* **Timeout Resilient:** Submissions try clicking with a 5-second timeout and gracefully fallback to pressing the `Enter` key to prevent DOM state lockups.

### 👥 3. Secure Multi-User Access System (Senior/Client Permission)
* **Access Requests:** If a secondary user (like your senior or client) sends a command to the bot, access is blocked and a pending request is created in MongoDB.
* **Owner Approval Cards:** The bot owner receives an interactive card with **Approve Access** and **Deny Access** buttons.
* **Collaborative Alerts:** Once approved, secondary users receive real-time match alerts and can interact with Accept/Reject buttons directly from their phones.

### 📎 4. Persistent Attachments Library & Multi-File Submission
* **Pre-Upload Files:** Upload portfolio PDFs, ZIPs, or case studies directly to Telegram chat. They save permanently to your `attachments/` library.
* **Interactive Checkboxes:** Tapping **Accept ✅** displays a clean checklist of all saved files (`[ ☑️ resume.pdf ]`, `[ ◻️ portfolio.pdf ]`).
* **Multi-File Upload:** Playwright attaches all checked files simultaneously to Upwork's file input.

### 🛎️ 5. Real-Time Operational Signals & Captcha Alerts
* **Delayed Cloudflare Alerts:** If stuck on a Cloudflare captcha challenge for more than 15 seconds, the bot sends a Telegram alert requesting manual help (skips notification if bypassed instantly).
* **Manual Login Notifications:** Automatically alerts the owner if the browser falls back to waiting for a manual user login.
* **Synchronized Search Run Status:** Dispatches notifications when scraper search runs start and complete, detailing scanned jobs, sent alerts, and the exact synchronized time of the next scheduled run.
* **Auto-Submission Connects Interceptor:** Automatically detects the Upwork "More connects needed" modal and fails gracefully with an alert, preventing 30-second Playwright page lockups.
* **Silent Re-Authorization Dashboard:** Revoked or denied access requests are tracked in history (with status `'revoked'` or `'denied'`) and can be re-approved silently via interactive button clicks under `/users` or `/grant`.

---

## 🗄️ Database Schema & Storage Persistence

All persistent configuration, dynamic sessions, search results, and access permissions are managed directly inside your MongoDB Atlas cluster to guarantee state safety across server restarts:

* **`authorized_users`:** Tracks secondary users who have been approved by the owner (stores `chatId`, `username`, status: `authorized`/`revoked`/`denied`, and approved/revoked timestamps).
* **`pending_access_requests`:** Holds active request queues (`chatId`, `username`, `requestedAt`) from new devices waiting for owner interaction.
* **`accounts`:** Stores credential sets, rules (`rules.json` mirrors), and target keyword settings.
* **`alerts`:** Audit trail for proposal statuses (`pending`, `submitted`, `rejected`) and AI-generated copy.

---

## 🚀 Setup & Execution

### 1. Prerequisites
Ensure Node.js (v18+) and Google Chrome are installed on your machine.

### 2. Environment Configuration
Create a `.env` file in the root directory (or copy `.env.example`):
```env
HEADLESS=false
UPWORK_EMAIL="your-email@example.com"
UPWORK_PASSWORD="your-secure-password"
TELEGRAM_TOKEN="your_telegram_bot_token"
CHAT_ID="your_telegram_chat_id"
GEMINI_API_KEY="your_google_gemini_api_key"
MONGODB_URI="mongodb+srv://..."
MONGODB_DB_NAME="upwork_assistant"
```

### 3. Launch & Profile Selection
1. Run the scraper-bot:
   ```bash
   npm start
   ```
2. The bot will send a **startup profile selection menu** on Telegram showing all registered profiles and a default configuration fallback option.
3. Select the desired profile to load configurations and trigger the search cycle.

---

## 📱 Telegram Command Reference

| Command | Description |
| :--- | :--- |
| `/start` / `/resume_scraper` | ▶️ Resume scraping loop & process queued submissions |
| `/pause` | ⏸️ Pause scraper loop |
| `/status` | 📊 Display live bot status, metrics, and connects balance |
| `/analytics` | 📊 Display proposal conversion analytics dashboard |
| `/accounts` | 🏢 Manage multi-tenant Upwork bidding profiles (switch, delete, add) |
| `/users` | 👥 Manage authorized secondary users (Revoke access) |
| `/grant [chat_id] [username]` | 🤫 Grant silent access (loads revoked/denied list as buttons if called without arguments) |
| `/rules` | ⚙️ View current rules configuration |
| `/resume` | 📄 View freelancer profile info or upload new resume PDF |
| `/attachments` | 📎 View all saved files in your Attachments Library |
| `/delattachment <file>` | 🗑️ Delete a file from your Attachments Library |
| `/projects` | 📂 View configured portfolio project links |
| `/addproject` | ➕ Interactive 3-step prompt to add a portfolio project |
| `/delproject` | 🗑️ Interactive inline deletion of portfolio projects |
| `/addquery` | ➕ Interactive prompt or direct command to add search query |
| `/delquery` | 🗑️ Interactive inline deletion of search queries |
| `/setbudget` | 💰 Set minimum job budget filter |
| `/setconnects` | 💳 Set max connects warning threshold |
