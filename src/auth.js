const fs = require('fs');
const config = require('./config');
const cloudflare = require('./cloudflare');
const { hasJobTiles, isGuestOrLoginPage } = require('./page-utils');
const authSignals = require('./auth-signals');

async function saveCookies(context) {
  const cookies = await context.cookies();
  fs.writeFileSync(config.COOKIES_PATH, JSON.stringify(cookies, null, 2), 'utf8');
  console.log(`💾 Fresh session cookies saved to ${config.COOKIES_PATH}`);

  // Sync cookies to MongoDB Atlas
  try {
    const db = require('./db');
    await db.saveCookiesToDb(config.UPWORK_EMAIL, cookies);
  } catch (err) {
    console.error('⚠️ Failed to sync cookies to database:', err.message);
  }
}

function loadCookies() {
  if (!fs.existsSync(config.COOKIES_PATH)) return null;
  try {
    const data = JSON.parse(fs.readFileSync(config.COOKIES_PATH, 'utf8'));
    return Array.isArray(data) && data.length > 0 ? data : null;
  } catch (e) {
    console.error(`⚠️ Failed to parse cookie file:`, e.message);
    return null;
  }
}

async function injectCookies(context) {
  let cookies = loadCookies();

  if (!cookies) {
    console.log('🔍 Local cookies missing. Checking MongoDB for synced session cookies...');
    try {
      const db = require('./db');
      const dbCookies = await db.loadCookiesFromDb(config.UPWORK_EMAIL);
      if (dbCookies) {
        fs.writeFileSync(config.COOKIES_PATH, JSON.stringify(dbCookies, null, 2), 'utf8');
        cookies = dbCookies;
        console.log('✅ Synced session cookies successfully downloaded from MongoDB Atlas!');
      }
    } catch (err) {
      console.warn('⚠️ Failed to fetch cookies from database:', err.message);
    }
  }

  if (cookies) {
    // Sanitize cookie sameSite attribute to prevent Playwright crash
    cookies = cookies.map(c => {
      const allowed = ['Strict', 'Lax', 'None'];
      let sameSite = c.sameSite;
      if (typeof sameSite === 'string') {
        sameSite = sameSite.charAt(0).toUpperCase() + sameSite.slice(1).toLowerCase();
      }
      if (!allowed.includes(sameSite)) {
        delete c.sameSite;
      } else {
        c.sameSite = sameSite;
      }
      return c;
    });

    await context.addCookies(cookies);
    console.log('🍪 Session cookies injected.');
    return true;
  }
  console.log('📝 No valid cookies found. Will login with config credentials.');
  return false;
}

async function isLoggedIn(page) {
  const hasTiles = await hasJobTiles(page);
  const isGuest = await isGuestOrLoginPage(page);
  return hasTiles && !isGuest;
}

async function autoLogin(page, context) {
  let activeEmail = config.UPWORK_EMAIL;
  let activePassword = config.UPWORK_PASSWORD;
  let isDynamic = false;

  const hasActiveDbAccount = !!config.activeAccountEmail;

  if (!hasActiveDbAccount) {
    // 1. Request dynamic credentials from Telegram
    console.log('❓ Requesting session login credentials from Telegram...');
    authSignals.emit('login-credentials-request', { chatId: config.CHAT_ID });

    const dynamicCreds = await new Promise((resolve) => {
      const timeout = setTimeout(() => {
        authSignals.off('login-credentials-received', handler);
        resolve(null);
      }, 60000); // 1 minute timeout

      const handler = (data) => {
        clearTimeout(timeout);
        resolve(data);
      };

      authSignals.once('login-credentials-received', handler);
    });

    if (dynamicCreds && !dynamicCreds.fallback && dynamicCreds.email && dynamicCreds.password) {
      console.log(`🔑 Using dynamic credentials received from Telegram: ${dynamicCreds.email}`);
      activeEmail = dynamicCreds.email;
      activePassword = dynamicCreds.password;
      isDynamic = true;
    } else {
      console.log(`⚠️ No dynamic credentials provided or timed out. Falling back to config credentials: ${activeEmail}`);
    }
  } else {
    console.log(`📦 Active DB account detected: ${config.activeAccountEmail}. Skipping dynamic Telegram credentials prompt.`);
  }

  if (!activeEmail || !activePassword) {
    console.log('⚠️ UPWORK_EMAIL or UPWORK_PASSWORD not configured.');
    console.log('👉 Please log in manually in the browser window...');
    return waitForManualLogin(page, context);
  }

  console.log(`🔑 Auto-login with: ${activeEmail}`);

  try {
    console.log('🌐 Navigating to Upwork login page...');
    await page.goto(config.UPWORK_LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: config.TIMEOUTS.NAVIGATION });
    await new Promise(r => setTimeout(r, 3000));

    await cloudflare.handleIfPresent(page);

    const formReady = await waitForLoginForm(page, context);
    if (formReady === 'already_logged_in') return true;
    if (!formReady) return waitForManualLogin(page, context);

    await fillCredentials(page, activeEmail, activePassword);

    const loginSuccess = await waitForLoginCompletion(page, context);
    if (loginSuccess) {
      return true;
    }

    // If dynamic credentials login failed, try fallback to config credentials!
    if (isDynamic) {
      console.log('❌ Dynamic credentials login failed. Trying fallback to default config credentials...');
      authSignals.emit('login-failed-alert', { chatId: config.CHAT_ID, reason: 'Wrong credentials or login timed out' });

      const defaultEmail = config.UPWORK_EMAIL;
      const defaultPassword = config.UPWORK_PASSWORD;
      if (defaultEmail && defaultPassword && defaultEmail !== activeEmail) {
        console.log(`🔑 Fallback auto-login with: ${defaultEmail}`);
        await page.goto(config.UPWORK_LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: config.TIMEOUTS.NAVIGATION });
        await new Promise(r => setTimeout(r, 3000));
        await cloudflare.handleIfPresent(page);
        const formReady2 = await waitForLoginForm(page, context);
        if (formReady2 === 'already_logged_in') return true;
        if (formReady2) {
          await fillCredentials(page, defaultEmail, defaultPassword);
          return waitForLoginCompletion(page, context);
        }
      }
    }

    return waitForManualLogin(page, context);

  } catch (e) {
    console.error('❌ Auto-login error:', e.message);
    
    // Retry fallback to config on error if we had tried dynamic creds
    if (isDynamic && config.UPWORK_EMAIL && config.UPWORK_PASSWORD && config.UPWORK_EMAIL !== activeEmail) {
      try {
        console.log('❌ Error during dynamic login. Trying fallback to config credentials...');
        await page.goto(config.UPWORK_LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: config.TIMEOUTS.NAVIGATION });
        const formReady2 = await waitForLoginForm(page, context);
        if (formReady2 && formReady2 !== 'already_logged_in') {
          await fillCredentials(page, config.UPWORK_EMAIL, config.UPWORK_PASSWORD);
          return waitForLoginCompletion(page, context);
        }
      } catch (err2) {
        console.error('❌ Fallback login error:', err2.message);
      }
    }

    console.log('👉 Falling back to manual login...');
    return waitForManualLogin(page, context);
  }
}

async function waitForLoginForm(page, context) {
  for (let attempt = 0; attempt < config.LIMITS.LOGIN_FORM_RETRIES; attempt++) {
    try {
      await page.waitForSelector(config.SELECTORS.LOGIN_EMAIL, { timeout: 10000 });
      return true;
    } catch {
      console.log(`[Attempt ${attempt + 1}/${config.LIMITS.LOGIN_FORM_RETRIES}] Login form not found, checking page...`);

      if (await cloudflare.isOnCloudflare(page)) {
        await cloudflare.waitForBypass(page);
        await new Promise(r => setTimeout(r, 2000));
        continue;
      }

      if (await hasJobTiles(page)) {
        console.log('✅ Already logged in! Job feed detected.');
        await saveCookies(context);
        return 'already_logged_in';
      }

      if (attempt < config.LIMITS.LOGIN_FORM_RETRIES - 1) {
        console.log('🔄 Reloading login page...');
        await page.goto(config.UPWORK_LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: config.TIMEOUTS.NAVIGATION });
        await new Promise(r => setTimeout(r, 3000));
      }
    }
  }

  console.log('❌ Login form could not be loaded.');
  return false;
}

async function fillCredentials(page, email, password) {
  const { SELECTORS, TIMEOUTS } = config;

  console.log('📧 Entering email...');
  await page.fill(SELECTORS.LOGIN_EMAIL, '');
  await page.type(SELECTORS.LOGIN_EMAIL, email, { delay: TIMEOUTS.TYPING_DELAY });
  await new Promise(r => setTimeout(r, 1000));

  const continueBtn = await page.$(SELECTORS.LOGIN_CONTINUE) || await page.$(SELECTORS.SUBMIT_FALLBACK);
  if (continueBtn) {
    await continueBtn.click();
    console.log('➡️ Continue clicked...');
  }
  await new Promise(r => setTimeout(r, 3000));

  console.log('🔒 Entering password...');
  await page.waitForSelector(SELECTORS.LOGIN_PASSWORD, { timeout: TIMEOUTS.ELEMENT_WAIT });
  await page.fill(SELECTORS.LOGIN_PASSWORD, '');
  await page.type(SELECTORS.LOGIN_PASSWORD, password, { delay: TIMEOUTS.TYPING_DELAY });
  await new Promise(r => setTimeout(r, 1000));

  const loginBtn = await page.$(SELECTORS.LOGIN_SUBMIT) || await page.$(SELECTORS.SUBMIT_FALLBACK);
  if (loginBtn) {
    await loginBtn.click();
    console.log('🚪 Login submitted!');
  }
}

async function waitForLoginCompletion(page, context) {
  console.log('⏳ Waiting for login to complete (checking for 2FA)...');

  for (let i = 0; i < config.LIMITS.LOGIN_RETRIES; i++) {
    await new Promise(r => setTimeout(r, 5000));
    try {
      if (page.isClosed()) return false;

      const url = page.url();
      const stillOnLogin = url.includes('login') || url.includes('signup') || url.includes('verification') || url.includes('two-step');

      // Check if 2FA code input is present on the page
      const codeInputSelector = 'input#deviceVerificationCode, input#twoFactorCode, input[name*="code"], input[id*="verification"], input[id*="factor"], input[id*="otp"]';
      const is2faPresent = await page.evaluate((sel) => {
        const el = document.querySelector(sel);
        return el ? true : false;
      }, codeInputSelector);

      if (is2faPresent && stillOnLogin) {
        console.log('🔒 2FA challenge detected! Prompting owner on Telegram...');
        authSignals.emit('2fa-required', { chatId: config.CHAT_ID });

        // Wait for the code from Telegram
        const code = await new Promise((resolve) => {
          const timeout = setTimeout(() => {
            authSignals.off('2fa-code-received', handler);
            resolve(null);
          }, 120000); // 2 minutes timeout

          const handler = (data) => {
            clearTimeout(timeout);
            resolve(data.code);
          };

          authSignals.once('2fa-code-received', handler);
        });

        if (code) {
          console.log(`📥 Received 2FA code from Telegram. Filling into page...`);
          const elements = await page.$$(codeInputSelector);
          let filled = false;
          for (const el of elements) {
            try {
              if (await el.isVisible()) {
                await el.fill('');
                await el.fill(code);
                filled = true;
                break;
              }
            } catch {}
          }

          if (filled) {
            const submitBtn = await page.$('button[type="submit"], button#submitCode, button#twoStepSubmit, button[id*="submit"], button[class*="submit"]');
            if (submitBtn) {
              try {
                await submitBtn.click({ timeout: 5000 });
                console.log('➡️ Submitted 2FA verification code via button click!');
              } catch (err) {
                console.warn('⚠️ 2FA button click failed or timed out, falling back to Enter key press...');
                await page.keyboard.press('Enter');
              }
            } else {
              await page.keyboard.press('Enter');
              console.log('➡️ Pressed Enter to submit 2FA code!');
            }
            await new Promise(r => setTimeout(r, 5000));
          }
        } else {
          console.warn('⚠️ 2FA timeout: No code received from Telegram within 2 minutes.');
        }
      }

      // Check if Upwork Security Question is present on the page
      const securityAnswerSelector = 'input#login_answer, input[id*=' + '"answer"' + '], input[name*=' + '"answer"' + ']';
      const isSecurityQuestionPresent = await page.evaluate((sel) => {
        const el = document.querySelector(sel);
        return el ? true : false;
      }, securityAnswerSelector);

      if (isSecurityQuestionPresent && stillOnLogin) {
        console.log('🔒 Security question challenge detected! Prompting owner on Telegram...');
        
        // Extract the question text
        const questionText = await page.evaluate(() => {
          const label = document.querySelector('label[for="login_answer"], label[id*="question"], label[class*="label"], .air3-card label');
          if (label) return label.innerText.trim();
          
          // Fallback look for questions
          const headers = Array.from(document.querySelectorAll('h1, h2, h3, p, label, div'));
          for (const el of headers) {
            const text = el.innerText.trim();
            if (text.includes('?') && (text.toLowerCase().includes('security') || text.toLowerCase().includes('answer') || text.toLowerCase().includes('question') || text.toLowerCase().includes('first') || text.toLowerCase().includes('last') || text.toLowerCase().includes('mother') || text.toLowerCase().includes('pet') || text.toLowerCase().includes('place'))) {
              return text;
            }
          }
          return 'Verification Question';
        });

        authSignals.emit('security-question-required', { chatId: config.CHAT_ID, question: questionText });

        // Wait for the answer from Telegram
        const answer = await new Promise((resolve) => {
          const timeout = setTimeout(() => {
            authSignals.off('security-answer-received', handler);
            resolve(null);
          }, 120000); // 2 minutes timeout

          const handler = (data) => {
            clearTimeout(timeout);
            resolve(data.answer);
          };

          authSignals.once('security-answer-received', handler);
        });

        if (answer) {
          console.log(`📥 Received security answer from Telegram. Filling into page...`);
          const elements = await page.$$(securityAnswerSelector);
          let filled = false;
          for (const el of elements) {
            try {
              if (await el.isVisible()) {
                await el.fill('');
                await el.fill(answer);
                filled = true;
                break;
              }
            } catch {}
          }

          if (filled) {
            const submitBtn = await page.$('button[type="submit"], button#submitAnswer, button[id*="submit"], button[class*="submit"]');
            if (submitBtn) {
              try {
                await submitBtn.click({ timeout: 5000 });
                console.log('➡️ Submitted security question answer via button click!');
              } catch (err) {
                console.warn('⚠️ Button click failed or timed out, falling back to Enter key press...');
                await page.keyboard.press('Enter');
              }
            } else {
              await page.keyboard.press('Enter');
              console.log('➡️ Pressed Enter to submit security answer!');
            }
            await new Promise(r => setTimeout(r, 5000));
          }
        } else {
          console.warn('⚠️ Security question timeout: No answer received from Telegram within 2 minutes.');
        }
      }

      if (!stillOnLogin && url.includes('upwork.com')) {
        console.log('✅ Login successful!');
        await saveCookies(context);
        return true;
      }

      console.log(`[${i + 1}/${config.LIMITS.LOGIN_RETRIES}] Waiting for login completion...`);
    } catch (err) {
      console.log(`[${i + 1}/${config.LIMITS.LOGIN_RETRIES}] Page transitioning: ${err.message}`);
    }
  }

  console.log('❌ Login timed out after 3 minutes.');
  return false;
}

async function waitForManualLogin(page, context) {
  console.log('Waiting up to 3 minutes for manual login in browser...');

  // Send a single Telegram notification to alert the owner/users
  try {
    const axios = require('axios');
    const db = require('./db');
    const users = await db.getAuthorizedUsers();
    console.log(`📡 Broadcasting manual login request to ${users.length} authorized users...`);
    for (const chatId of users) {
      try {
        await axios.post(`https://api.telegram.org/bot${config.TELEGRAM_TOKEN}/sendMessage`, {
          chat_id: chatId,
          text: '🔑 <b>Manual Login Required:</b>\n\nAuto-login could not complete automatically. Please open the browser window and perform a manual login.',
          parse_mode: 'HTML'
        });
      } catch {}
    }
  } catch (err) {
    console.error('⚠️ Failed to send manual login Telegram alert:', err.message);
  }

  for (let i = 0; i < config.LIMITS.LOGIN_RETRIES; i++) {
    await new Promise(r => setTimeout(r, 5000));
    try {
      if (page.isClosed()) return false;

      const url = page.url();
      if (await hasJobTiles(page) || (url.includes('upwork.com') && !url.includes('login'))) {
        console.log('✅ Login detected!');
        await saveCookies(context);
        return true;
      }

      console.log(`[${i + 1}/${config.LIMITS.LOGIN_RETRIES}] Waiting for manual login...`);
    } catch {
      console.log(`[${i + 1}/${config.LIMITS.LOGIN_RETRIES}] Page transitioning...`);
    }
  }

  return false;
}

async function getLoggedInUser(page) {
  try {
    const avatarSelector = sel => sel.AVATAR_IMG || '[data-test="UpSTopNavUser"] img' || 'img[class*="avatar"]';
    try {
      await page.waitForSelector(avatarSelector(config.SELECTORS), { timeout: 8000 });
    } catch {}

    return await page.evaluate((sel) => {
      const cleanName = (str) => {
        if (!str) return '';
        let clean = str.replace(/user menu/i, '')
                       .replace(/profile/i, '')
                       .replace(/photo of/i, '')
                       .replace(/avatar of/i, '')
                       .replace(/profile picture of/i, '')
                       .replace(/logged in as/i, '')
                       .replace(/[:\-\s]+/g, ' ')
                       .trim();
        const uiNoise = /logo|badge|banner|icon|flag|star|close|menu|upwork|toggle|navigation|main|button|tab|search|notification|message|skip|content|dropdown|link|alert|help|feedback|setting|click|open|expand|collapse/i;
        if (clean && clean.split(' ').length >= 2 && !uiNoise.test(clean) && clean.length < 40) {
          return clean;
        }
        return '';
      };

      const images = Array.from(document.querySelectorAll('img'));
      for (const img of images) {
        const name = cleanName(img.alt);
        if (name) {
          const parent = img.closest('header, nav, button, [data-test*="user"], [data-test*="menu"]');
          if (parent) return name;
        }
      }

      const elements = Array.from(document.querySelectorAll('button[aria-label], a[aria-label], [data-test*="user"]'));
      for (const el of elements) {
        const ariaLabel = el.getAttribute('aria-label') || el.getAttribute('title') || '';
        const lowerLabel = ariaLabel.toLowerCase();
        if (lowerLabel.includes('user') || lowerLabel.includes('profile') || lowerLabel.includes('account')) {
          const name = cleanName(ariaLabel);
          if (name) return name;
        }
      }

      const img = document.querySelector(sel.AVATAR_IMG) ||
                  document.querySelector(sel.AVATAR_TEST) ||
                  document.querySelector(sel.USER_NAV_IMG);
      if (img) {
        const name = cleanName(img.alt);
        if (name) return name;
      }

      const trigger = document.querySelector(sel.USER_MENU) ||
                      document.querySelector(sel.USER_MENU_ALT) ||
                      document.querySelector(sel.USER_MENU_ARIA);
      if (trigger) {
        const text = trigger.getAttribute('aria-label') || trigger.getAttribute('title') || trigger.innerText;
        const name = cleanName(text);
        if (name) return name;
      }

      return 'Unknown User';
    }, config.SELECTORS);
  } catch {
    return 'Unknown User';
  }
}

module.exports = { injectCookies, isLoggedIn, autoLogin, getLoggedInUser };
