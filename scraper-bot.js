require('dotenv').config();

const config = require('./src/config');
const { connectCDP, disconnect } = require('./src/browser');
const { injectCookies, isLoggedIn, autoLogin, getLoggedInUser } = require('./src/auth');
const { hasJobTiles, navigateWithCloudflare } = require('./src/page-utils');
const { scrapeAllQueries } = require('./src/scraper');
const { generateRulesFromResume } = require('./src/resume');
const { extractTextFromResume } = require('./src/resume-parser');
const { startTelegramListener } = require('./src/notifier');
const storage = require('./src/storage');
const stats = require('./src/stats');

storage.load();

function isSleepTime() {
  const start = config.SLEEP_START_HOUR;
  const end = config.SLEEP_END_HOUR;
  const current = new Date().getHours();

  if (start === end) {
    return false; // No sleep window configured
  }

  if (start < end) {
    // Sleep window is within the same day (e.g. 9 AM to 5 PM)
    return current >= start && current < end;
  } else {
    // Sleep window spans across midnight (e.g. 11 PM to 8 AM)
    return current >= start || current < end;
  }
}

async function run() {
  if (stats.isPaused()) {
    console.log(`\n⏸️ [${new Date().toLocaleTimeString()}] Scraper is paused via Telegram. Skipping Upwork scraping cycle...`);
    return;
  }

  if (isSleepTime()) {
    console.log(`\n😴 [${new Date().toLocaleTimeString()}] Sleep mode active (${config.SLEEP_START_HOUR}:00 - ${config.SLEEP_END_HOUR}:00). Skipping Upwork scraping cycle...`);
    return;
  }

  console.log('\n=============================================');
  console.log(`⏳ [${new Date().toLocaleTimeString()}] Starting Scraping Run...`);
  stats.setScraping(true);

  // Notify all authorized users that search is starting
  try {
    const { getAuthorizedUsers } = require('./src/db');
    const axios = require('axios');
    const users = await getAuthorizedUsers();
    for (const chatId of users) {
      try {
        await axios.post(`https://api.telegram.org/bot${config.TELEGRAM_TOKEN}/sendMessage`, {
          chat_id: chatId,
          text: '🔎 <b>Upwork Scraper Run Started...</b>',
          parse_mode: 'HTML'
        });
      } catch {}
    }
  } catch {}

  let browser, page;

  try {
    const connection = await connectCDP();
    browser = connection.browser;
    const context = connection.context;

    await injectCookies(context);

    page = await context.newPage();
    const firstUrl = config.getSearchUrls()[0];

    await navigateWithCloudflare(page, firstUrl);

    if (await isLoggedIn(page)) {
      console.log('✅ Cookies are valid! Already logged in.');
    } else {
      console.log('🔐 Not logged in. Starting auto-login...');
      const success = await autoLogin(page, context);
      if (!success) throw new Error('Login failed. Check .env credentials or login manually.');
    }

    if (!await hasJobTiles(page)) {
      await navigateWithCloudflare(page, firstUrl);
    }

    let userName = await getLoggedInUser(page);
    if (!userName || userName === 'Unknown User') {
      userName = config.FREELANCER_NAME;
    }
    if (!userName || userName === 'Unknown User') {
      try {
        const resumeText = await extractTextFromResume();
        if (resumeText) {
          const lines = resumeText.split('\n').map(l => l.trim()).filter(Boolean);
          if (lines.length > 0) {
            const firstLine = lines[0];
            const clean = firstLine.replace(/resume|cv|curriculum\s*vitae/i, '').trim();
            if (clean && clean.split(' ').length >= 2 && clean.length < 40) {
              userName = clean;
              console.log(`👤 Extracted developer name from resume file: ${userName}`);
            }
          }
        }
      } catch (err) {
        console.warn('⚠️ Failed to extract name from resume file:', err.message);
      }
    }
    if (!userName) userName = 'Unknown User';
    console.log(`👤 Logged in as: ${userName}`);

    // Verify name match on startup
    const resumeName = config.FREELANCER_NAME;
    if (userName !== 'Unknown User' && resumeName) {
      const uParts = userName.toLowerCase().split(/\s+/).filter(Boolean);
      const rParts = resumeName.toLowerCase().split(/\s+/).filter(Boolean);
      const matches = uParts.some(p => rParts.includes(p));
      if (!matches) {
        console.warn(`⚠️ Name Verification Warning: Logged-in Upwork profile name "${userName}" does not match resume candidate name "${resumeName}". Auto-submission will require manual confirmation.`);
      }
    }

    const { totalJobs, newAlerts } = await scrapeAllQueries(page, userName);
    console.log(`\n✨ Run completed. Total jobs scanned: ${totalJobs} | New Alerts sent: ${newAlerts}`);

    // Pre-calculate next run details for synchronized Telegram messaging
    const baseMs = config.SCRAPE_INTERVAL_MS;
    const jitterMs = (Math.random() * 7 - 2) * 60 * 1000;
    const nextDelay = Math.max(3 * 60 * 1000, baseMs + jitterMs);
    const nextRunTimeStr = new Date(Date.now() + nextDelay).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: true });
    global.nextScheduledDelay = nextDelay;

    // Notify all authorized users that search is completed
    try {
      const { getAuthorizedUsers } = require('./src/db');
      const axios = require('axios');
      const users = await getAuthorizedUsers();
      for (const chatId of users) {
        try {
          await axios.post(`https://api.telegram.org/bot${config.TELEGRAM_TOKEN}/sendMessage`, {
            chat_id: chatId,
            text: `✅ <b>Upwork Scraper Run Completed</b>\n\n📊 Scanned: <b>${totalJobs}</b> | Alerts sent: <b>${newAlerts}</b>\n⏰ Next search run scheduled at: <b>${nextRunTimeStr}</b>`,
            parse_mode: 'HTML'
          });
        } catch {}
      }
    } catch {}

  } catch (err) {
    console.error('❌ Scraping error:', err.message);
    if (page) {
      try {
        await page.screenshot({ path: config.ERROR_SCREENSHOT_PATH, fullPage: true });
        console.log('📸 Error screenshot saved to error.png');
      } catch {}
    }
  } finally {
    await disconnect(browser, page);
    stats.setScraping(false);
    console.log('=============================================\n');

    // Trigger queue processor to handle any accepted applications waiting for search cycle to end
    try {
      const { processQueue } = require('./src/notifier');
      processQueue();
    } catch (err) {
      console.error('⚠️ Failed to process queued submissions:', err.message);
    }
  }
}

let activeTimeout = null;

function scheduleNextRun() {
  if (activeTimeout) {
    clearTimeout(activeTimeout);
  }

  if (stats.isPaused()) {
    console.log('⏸️ Scraper is paused. Scheduling suspended until resumed.');
    return;
  }

  let nextDelay;
  if (global.nextScheduledDelay) {
    nextDelay = global.nextScheduledDelay;
    delete global.nextScheduledDelay;
  } else {
    const baseMs = config.SCRAPE_INTERVAL_MS;
    const jitterMs = (Math.random() * 7 - 2) * 60 * 1000;
    nextDelay = Math.max(3 * 60 * 1000, baseMs + jitterMs);
  }
  console.log(`⏰ Next scraping run scheduled in ${Math.round(nextDelay / 60000)} minutes (${new Date(Date.now() + nextDelay).toLocaleTimeString()})...`);

  activeTimeout = setTimeout(async () => {
    await run();
    scheduleNextRun();
  }, nextDelay);
}

async function triggerScrapeRun() {
  if (stats.isScraping()) {
    console.log('⚠️ Scrape run requested but a run is already active.');
    return false;
  }
  console.log('⚡ Triggering scraper resume from Telegram command...');
  
  if (activeTimeout) {
    clearTimeout(activeTimeout);
  }

  // 1. Process any pending queued submissions FIRST before starting search run!
  try {
    const { processQueue } = require('./src/notifier');
    await processQueue();
  } catch (err) {
    console.error('⚠️ Failed to process queued submissions on resume:', err.message);
  }

  // 2. Run scraper search queries now
  await run();
  
  // 3. Re-schedule clean timeout
  scheduleNextRun();
  return true;
}

async function start() {
  // 1. Initialize MongoDB connection
  try {
    const { connectDb } = require('./src/db');
    await connectDb();
  } catch (err) {
    console.warn('⚠️ Failed to initialize MongoDB connection on startup:', err.message);
  }

  // 2. Start listening to Telegram events (so user button clicks are received immediately)
  startTelegramListener();

  // 3. Prompt user on Telegram to select the active profile for this session
  try {
    const { promptStartupProfile } = require('./src/notifier');
    await promptStartupProfile();
  } catch (err) {
    console.warn('⚠️ Failed to prompt startup profile selection, loading last active:', err.message);
    try {
      await config.initActiveAccount();
    } catch {}
  }

  // 4. Force terminate any orphaned background Chrome processes on debugging port 9222 to guarantee a fresh visual GUI window
  try {
    const { killPortProcess } = require('./src/browser');
    console.log('🧹 Cleaning up orphaned Chrome processes on port 9222...');
    killPortProcess(config.CHROME_DEBUG_PORT);
  } catch (err) {
    console.warn('⚠️ Port cleanup warning:', err.message);
  }

  // 5. Only auto-generate rules from local template if no dynamic accounts are configured in DB yet
  if (!config.activeAccountEmail) {
    try {
      const updated = await generateRulesFromResume();
      if (updated) {
        config.reloadRules();
      }
    } catch (err) {
      console.error('⚠️ Failed during system initialization:', err.message);
    }
  } else {
    console.log('📄 Active account loaded from database. Skipping startup local rules regeneration.');
  }

  // Enable fully automated scraper startup and search scheduling runs
  await run();
  scheduleNextRun();
}

start();

// Shutdown notification helper to alert all authorized users
async function notifyShutdown(reason) {
  try {
    const { getAuthorizedUsers } = require('./src/db');
    const axios = require('axios');
    const users = await getAuthorizedUsers();
    
    console.log(`🛑 Broadcasting shutdown alert to ${users.length} authorized users...`);
    for (const chatId of users) {
      try {
        await axios.post(`https://api.telegram.org/bot${config.TELEGRAM_TOKEN}/sendMessage`, {
          chat_id: chatId,
          text: `🛑 <b>Bot Offline Alert:</b>\n\n<b>Reason:</b> ${reason}`,
          parse_mode: 'HTML'
        });
      } catch (err) {
        console.error(`⚠️ Failed to send shutdown alert to ${chatId}:`, err.message);
      }
    }
  } catch (err) {
    console.error('⚠️ Shutdown broadcast error:', err.message);
  }
}

// Register system process exit handlers
process.on('SIGINT', async () => {
  console.log('🛑 SIGINT received (Ctrl+C). Notifying shutdown...');
  await notifyShutdown('The scraper bot process was stopped manually (Ctrl+C) on the server.');
  process.exit(0);
});

process.on('SIGTERM', async () => {
  console.log('🛑 SIGTERM received. Notifying shutdown...');
  await notifyShutdown('The scraper bot process was terminated by system shutdown or reload command.');
  process.exit(0);
});

process.on('uncaughtException', async (err) => {
  console.error('❌ Uncaught Exception:', err);
  await notifyShutdown(`The scraper bot process crashed due to an unhandled exception:\n<code>${err.message}</code>\n\n<i>Stack trace:</i>\n<pre>${err.stack ? err.stack.substring(0, 500) : ''}</pre>`);
  process.exit(1);
});

process.on('unhandledRejection', async (reason) => {
  console.error('❌ Unhandled Rejection:', reason);
  const msg = reason instanceof Error ? reason.message : String(reason);
  const stack = reason instanceof Error && reason.stack ? reason.stack.substring(0, 500) : '';
  await notifyShutdown(`The scraper bot process crashed due to an unhandled Promise rejection:\n<code>${msg}</code>\n\n<i>Stack trace:</i>\n<pre>${stack}</pre>`);
  process.exit(1);
});

module.exports = { triggerScrapeRun };