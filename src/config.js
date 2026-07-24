const path = require('path');
const fs = require('fs');
const os = require('os');

let rules = {};
const rulesPath = path.resolve(__dirname, '..', 'rules.json');

function loadRules() {
  try {
    if (fs.existsSync(rulesPath)) {
      rules = JSON.parse(fs.readFileSync(rulesPath, 'utf8'));
    }
  } catch (err) {
    console.error('⚠️ Failed to load rules.json:', err.message);
  }
}

loadRules();

const isWin = os.platform() === 'win32';
const winChromeDefault = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const winChromeFallback = 'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe';

let defaultChrome;
if (isWin) {
  if (fs.existsSync(winChromeDefault)) {
    defaultChrome = winChromeDefault;
  } else if (fs.existsSync(winChromeFallback)) {
    defaultChrome = winChromeFallback;
  } else {
    try {
      const { chromium } = require('playwright-extra');
      defaultChrome = chromium.executablePath();
    } catch {
      defaultChrome = winChromeDefault;
    }
  }
} else {
  try {
    const { chromium } = require('playwright-extra');
    defaultChrome = chromium.executablePath();
  } catch {
    defaultChrome = '/usr/bin/chromium-browser';
  }
}

let activeAccount = null;

async function initActiveAccount() {
  try {
    const db = require('./db');
    const acc = await db.getActiveAccount();
    if (acc) {
      activeAccount = acc;
      console.log(`📦 Loaded active account: ${acc.email} (${acc.name})`);
    } else {
      console.log('📝 No active account in database. Using default .env / rules.json configurations.');
      activeAccount = null;
    }
  } catch (err) {
    console.warn('⚠️ MongoDB connection not ready yet during config initialization. Using local fallback rules.');
  }
}

module.exports = {
  CHROME_DEBUG_PORT: 9222,
  CHROME_PATH: process.env.CHROME_PATH || defaultChrome,
  
  get BROWSER_DATA_DIR() {
    if (activeAccount && activeAccount.email) {
      const safeEmail = activeAccount.email.replace(/[^a-zA-Z0-9]/g, '_');
      return path.resolve(__dirname, '..', `browser-data_${safeEmail}`);
    }
    return path.resolve(__dirname, '..', 'browser-data');
  },
  
  get COOKIES_PATH() {
    if (activeAccount && activeAccount.email) {
      const safeEmail = activeAccount.email.replace(/[^a-zA-Z0-9]/g, '_');
      return path.resolve(__dirname, '..', `cookies_${safeEmail}.json`);
    }
    return path.resolve(__dirname, '..', 'cookies.json');
  },
  
  NOTIFIED_JOBS_PATH: path.resolve(__dirname, '..', 'notified_jobs.json'),
  ERROR_SCREENSHOT_PATH: path.resolve(__dirname, '..', 'error.png'),

  TELEGRAM_TOKEN: process.env.TELEGRAM_TOKEN,
  CHAT_ID: process.env.CHAT_ID,
  
  get UPWORK_EMAIL() {
    return activeAccount ? activeAccount.email : (process.env.UPWORK_EMAIL || '');
  },
  
  get UPWORK_PASSWORD() {
    return activeAccount ? activeAccount.password : (process.env.UPWORK_PASSWORD || '');
  },

  MONGODB_URI: process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/',
  MONGODB_DB_NAME: process.env.MONGODB_DB_NAME || 'upwork_assistant',
  GEMINI_API_KEY: process.env.GEMINI_API_KEY,

  UPWORK_LOGIN_URL: 'https://www.upwork.com/ab/account-security/login',
  UPWORK_SEARCH_BASE: 'https://www.upwork.com/nx/search/jobs/',

  get FREELANCER_NAME() {
    return activeAccount ? activeAccount.name : (rules.freelancer_name || '');
  },
  get SEARCH_QUERIES() {
    return activeAccount && activeAccount.rules ? (activeAccount.rules.search_queries || []) : (rules.search_queries || []);
  },
  get TARGET_KEYWORDS() {
    return activeAccount && activeAccount.rules ? (activeAccount.rules.target_keywords || []) : (rules.target_keywords || []);
  },
  get IGNORE_KEYWORDS() {
    return activeAccount && activeAccount.rules ? (activeAccount.rules.ignore_keywords || []) : (rules.ignore_keywords || []);
  },
  get MIN_BUDGET() {
    return activeAccount && activeAccount.rules ? (activeAccount.rules.min_budget || 0) : (rules.min_budget || 0);
  },
  get MAX_CONNECTS_LIMIT() {
    return activeAccount && activeAccount.rules ? activeAccount.rules.max_connects_limit : (rules.max_connects_limit || null);
  },
  get PORTFOLIO_PROJECTS() {
    return activeAccount && activeAccount.rules ? (activeAccount.rules.portfolio_projects || []) : (rules.portfolio_projects || []);
  },
  get PAYMENT_VERIFIED_ONLY() {
    const rulesObj = activeAccount && activeAccount.rules ? activeAccount.rules : rules;
    return rulesObj.payment_verified_only !== false;
  },
  get MIN_CLIENT_SPEND() {
    const rulesObj = activeAccount && activeAccount.rules ? activeAccount.rules : rules;
    return rulesObj.min_client_spend || 0;
  },
  get MIN_CLIENT_RATING() {
    const rulesObj = activeAccount && activeAccount.rules ? activeAccount.rules : rules;
    return rulesObj.min_client_rating || 0;
  },
  get MIN_CONNECTS_ALERT() {
    const rulesObj = activeAccount && activeAccount.rules ? activeAccount.rules : rules;
    return rulesObj.min_connects_alert || 15;
  },

  reloadRules() {
    loadRules();
  },

  async reloadActiveAccount() {
    try {
      const db = require('./db');
      const acc = await db.getActiveAccount();
      if (acc) {
        activeAccount = acc;
        console.log(`🔄 Reloaded config for active account: ${acc.email}`);
      } else {
        activeAccount = null;
        console.log('🔄 Reloaded config: No active account loaded, using local fallback.');
      }
    } catch (err) {
      console.error('⚠️ Failed to reload active account:', err.message);
    }
  },

  async initActiveAccount() {
    await initActiveAccount();
  },

  get activeAccountEmail() {
    return activeAccount ? activeAccount.email : null;
  },

  HEADLESS: process.env.HEADLESS === 'true' || process.env.HEADLESS === undefined, // default to true if not specified
  
  SLEEP_START_HOUR: parseInt(process.env.SLEEP_START_HOUR || '23', 10),
  SLEEP_END_HOUR: parseInt(process.env.SLEEP_END_HOUR || '8', 10),

  SCRAPE_INTERVAL_MS: 10 * 60 * 1000,

  TIMEOUTS: {
    NAVIGATION: 30000,
    ELEMENT_WAIT: 15000,
    CLOUDFLARE_MAX: 5 * 60 * 1000,
    LOGIN_MAX: 3 * 60 * 1000,
    STABILIZE: 4000,
    TYPING_DELAY: 50,
  },

  LIMITS: {
    MAX_NOTIFIED_JOBS: 500,
    CLOUDFLARE_RETRIES: 60,
    LOGIN_RETRIES: 36,
    LOGIN_FORM_RETRIES: 3,
    JOB_TILE_RETRIES: 10,
    CHROME_STARTUP_RETRIES: 15,
  },

  SELECTORS: {
    JOB_TILE: 'article[data-test="JobTile"]',
    JOB_TILE_ALT: 'article.job-tile',
    JOB_TITLE_LINK: '[data-test*="job-tile-title-link"]',
    JOB_TITLE_FALLBACK: 'h2 a',
    JOB_DESCRIPTION: '[data-test="job-description-text"]',
    JOB_DESCRIPTION_ALT: '[data-test*="JobDescription"]',
    JOB_DESCRIPTION_FALLBACK: '.air3-line-clamp',
    LOGIN_EMAIL: 'input#login_username',
    LOGIN_PASSWORD: 'input#login_password',
    LOGIN_CONTINUE: 'button#login_password_continue',
    LOGIN_SUBMIT: 'button#login_control_continue',
    SUBMIT_FALLBACK: 'button[type="submit"]',
    AVATAR_IMG: 'img[class*="avatar"]',
    AVATAR_TEST: '[data-test*="avatar"] img',
    USER_NAV_IMG: '[data-test="UpSTopNavUser"] img',
    USER_MENU: '[data-test="user-menu-trigger"]',
    USER_MENU_ALT: 'button[class*="avatar"]',
    USER_MENU_ARIA: 'button[aria-label*="User Menu"]',
    GUEST_LINKS: 'a[href*="login"], a[href*="signup"], .login-link, .pathfinder-signup-cta-pill',
    HEADER: 'header',
    HEADER_ALT: '.nav-parent-wrapper',
  },

  buildSearchUrl(query) {
    return `${this.UPWORK_SEARCH_BASE}?q=${encodeURIComponent(query)}&sort=recency`;
  },

  getSearchUrls() {
    return this.SEARCH_QUERIES.map(q => this.buildSearchUrl(q));
  },

  getRawRules() {
    if (activeAccount && activeAccount.rules) {
      return { ...activeAccount.rules, freelancer_name: activeAccount.name };
    }
    return { ...rules };
  },

  loadAndGetRules() {
    if (activeAccount && activeAccount.rules) {
      return { ...activeAccount.rules, freelancer_name: activeAccount.name };
    }
    loadRules();
    return { ...rules };
  },

  async saveRules(newRules) {
    try {
      if (activeAccount && activeAccount.email) {
        const db = require('./db');
        const success = await db.updateAccountRules(activeAccount.email, newRules);
        if (success) {
          activeAccount.rules = newRules;
        }
        return success;
      } else {
        fs.writeFileSync(rulesPath, JSON.stringify(newRules, null, 2), 'utf8');
        loadRules();
        return true;
      }
    } catch (err) {
      console.error('⚠️ Failed to save rules:', err.message);
      return false;
    }
  },
};
