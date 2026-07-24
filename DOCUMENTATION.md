# Upwork Assistant Bot - Comprehensive Technical Case Study & Architecture

This document serves as the complete technical case study, system design map, and engineering documentation for the Upwork Assistant Bot.

---

## 📁 System Architecture & Directory Map

```
├── attachments/           # Persistent attachments library (PDFs, ZIPs, Portfolio docs)
├── browser-data_*/        # Dynamic, isolated Chrome user profile data per account (Git-ignored)
├── src/
│   ├── config.js         # Central configuration, rules getter/setter, dynamic reloader
│   ├── browser.js        # Chrome process spawner, port validator, CDP connection manager
│   ├── cloudflare.js     # Cloudflare Turnstile challenge detector and bypass solver
│   ├── auth.js           # Upwork session cookie injector and user profile name scraper
│   ├── page-utils.js     # DOM tile extractor and navigation challenge helpers
│   ├── storage.js        # Deduplication state tracker (notified_jobs.json)
│   ├── notifier.js       # Telegram bot listener, interactive checklists, inline keyboards
│   ├── scraper.js        # Upwork search cycle runner and full job details extractor
│   ├── proposal.js       # Gemini AI proposal generator, score calculator, rewriter
│   ├── submitter.js      # Playwright form filler, multi-file attachment uploader
│   ├── resume-parser.js  # PDF/DOCX/TXT resume text extractor
│   ├── resume.js         # Gemini NLP rules generator and candidate name parser
│   ├── stats.js          # Runtime metrics, scan counters, connects statistics collector
│   ├── auth-signals.js   # custom Event Emitter bridge for login & credentials signals
│   └── db.js             # MongoDB Atlas connection manager & database driver
├── .env                  # Local environment credentials (ignored in Git)
├── .env.example          # Environment variables template
├── rules.json            # Active search queries, portfolio projects, min budget, connects limit
├── notified_jobs.json    # Local deduplication state file
├── scraper-bot.js        # Main process orchestrator and execution entry point
└── package.json          # Project manifest and NPM script configurations
```

---

## 🧠 Technical Case Study: Problems & Architectural Solutions

### 1. Anti-Bot Evasion via Chrome DevTools Protocol (CDP)
* **Problem:** Synthetic automated browsers (standard Puppeteer/Playwright headless launchers) inject `navigator.webdriver = true` and `cdc_` properties into JavaScript execution contexts, triggering instant Cloudflare Turnstile blocks and account flagging.
* **Solution:** We spawn a real Google Chrome browser desktop instance in debug mode (`--remote-debugging-port=9222`). Playwright connects over CDP using `playwright-extra` with `puppeteer-extra-plugin-stealth` and `--disable-blink-features=AutomationControlled`. This presents a 100% genuine browser footprint with real GPU drivers and active session profiles.

### 2. Turnstile Captcha Auto-Solver
* **Problem:** Cloudflare Turnstile widget checkboxes block standard API-based click automation events, identifying them as non-trusted interactions.
* **Solution:** Spawns coordinates-based Turnstile solver (`src/cloudflare.js`). It reads the checkbox iframe boundaries on the parent page, simulates **human-like cursor curves and speed acceleration modeling (12 distinct steps)** to move the mouse pointer to the Turnstile target coordinates, and performs mouse down/up press cycles with randomized timing delays.

### 3. Dynamic Multi-Account & Profile Isolation
* **Problem:** Managing multiple client bidding profiles from a single bot server risks cross-over cookies, session overrides, and account suspensions.
* **Solution:** Switched configuration variables to dynamic database-driven getters (`src/config.js`). Each Upwork account saved in MongoDB Atlas operates under a fully isolated directory profile (`browser-data_<email>/`) and cookies path (`cookies_<email>.json`). The Telegram control dashboard (`/accounts`) lets users switch accounts instantly, forcing a port clean-up and a fresh Chrome startup with the newly selected profile.
* **Quiet Auto-Login:** If an active database profile is active, the bot auto-fills password credentials quietly without prompting the Telegram channel.

### 4. Interactive Security Question Bypass
* **Problem:** Upwork randomly triggers security question verification forms (e.g. maiden name, pet name) during logins, blocking the scraping background process.
* **Solution:** Intercepts security question forms, extracts the question text, and sends it directly to the Telegram owner. While waiting for the user's answer, execution is paused. Once the answer is typed back on Telegram, the bot auto-fills the field.
* **Resilient Submission:** To prevent button status lockups, the submit action uses a 5-second timeout and automatically falls back to pressing the keyboard `Enter` key.

### 5. Permission-based Multi-User Access System (Senior/Client control)
* **Problem:** Team leads, clients, or seniors want to monitor bot logs and accept/reject proposals without configuring direct server access or sharing credentials.
* **Solution:** Implemented a secure database access control list (`authorized_users` and `pending_access_requests` collections). If an unauthorized user messages the bot, they are blocked, and an interactive prompt is sent to the master owner:
  > 🔔 **New Access Request:** User: @username (ID: 12345)
  > `[ Approve Access ✅ ]` `[ Deny Access ❌ ]`
  Once approved by the owner, their chat ID receives all real-time job alerts and can perform operations seamlessly.
* **Silent Re-Authorization Dashboard:** Denied or revoked access requests are preserved in MongoDB with status tags (`'denied'` / `'revoked'`). Typing `/grant` without parameters dynamically draws an inline dashboard to silently re-authorize former users with a single click.

### 6. Real-Time Operational Signals & Connects Safeguards
* **Delayed Cloudflare Alerts:** If the bot gets stuck on a Cloudflare captcha for more than 15 seconds, a push notification is sent to Telegram (ignored if auto-bypassed quickly).
* **Manual Login Warnings:** Dispatches a Telegram warning when the bot waits for manual user authentication.
* **Synchronized Search Run Status:** Dispatches notifications when scraper search runs start and complete, detailing scanned jobs, sent alerts, and the exact synchronized time of the next scheduled run.
* **Connects Dialog Interceptor:** Dynamically detects the Upwork "More connects needed" modal (`fe-proposal-more-connects-needed-dialog`) during submission workflows, instantly failing and alerting the user rather than locking up the page for a 30-second timeout.

---

## 🛠️ Complete Telegram Command Menu

| Command | Action |
| :--- | :--- |
| `/start` / `/resume_scraper` | ▶️ Resume scraping loop & process queued submissions |
| `/pause` | ⏸️ Pause scraper loop |
| `/status` | 📊 Display live bot status, metrics, and connects balance |
| `/accounts` | 🏢 Manage multi-tenant Upwork bidding profiles (switch, delete, add) |
| `/users` | 👥 Manage authorized secondary users (Revoke access) |
| `/grant [chat_id] [username]` | 🤫 Grant silent access (loads revoked/denied list as buttons if called without arguments) |
| `/rules` | ⚙️ View current rules configuration |
| `/resume` | 📄 View profile info or upload a new PDF resume |
| `/attachments` | 📎 View all saved files in your Attachments Library |
| `/delattachment <file>` | 🗑️ Delete a file from your Attachments Library |
| `/projects` | 📂 View all portfolio project links |
| `/addproject` | ➕ Interactive 3-step prompt to add a portfolio project |
| `/delproject` | 🗑️ Interactive inline deletion of portfolio projects |
| `/addquery` | ➕ Interactive prompt or direct command to add a search query |
| `/delquery` | 🗑️ Interactive inline deletion of search queries |
| `/setbudget` | 💰 Set minimum job budget filter |
| `/setconnects` | 💳 Set max connects warning threshold |

---

## ⚙️ Maintenance & Operation

1. **Start Server:** `npm start`
2. **View Logs:** Monitor terminal for real-time Chrome CDP logs, Gemini API responses, and Telegram dispatch events.
3. **Inspect Browser:** Set `HEADLESS=false` in `.env` to view Chrome executing search cycles and submitting proposals visually on your desktop.
