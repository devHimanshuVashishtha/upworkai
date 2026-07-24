const axios = require('axios');
const db = require('./db');
const config = require('./config');

async function notifyCloudflareChallenge() {
  try {
    const users = await db.getAuthorizedUsers();
    console.log(`🛡️ Broadcasting Cloudflare challenge alert to ${users.length} authorized users...`);
    for (const chatId of users) {
      try {
        await axios.post(`https://api.telegram.org/bot${config.TELEGRAM_TOKEN}/sendMessage`, {
          chat_id: chatId,
          text: '🛡️ <b>Cloudflare Challenge Detected!</b>\n\nThe bot is currently stuck on a Cloudflare captcha page. Please open the browser window and solve it manually.',
          parse_mode: 'HTML'
        });
      } catch (err) {
        console.error(`⚠️ Failed to send Cloudflare alert to ${chatId}:`, err.message);
      }
    }
  } catch (err) {
    console.error('⚠️ Cloudflare alert broadcast error:', err.message);
  }
}

async function isOnCloudflare(page) {
  try {
    const title = await page.title();
    if (title.includes('Just a moment')) return true;
    return await page.evaluate(() => {
      const text = document.body ? document.body.innerText : '';
      return text.includes('Cloudflare') || text.includes('checking your browser') || text.includes('security check');
    });
  } catch {
    return false;
  }
}

async function tryAutoSolveTurnstile(page) {
  try {
    const iframeElement = await page.$('iframe[src*="challenges.cloudflare.com"]');
    if (!iframeElement) return false;

    const box = await iframeElement.boundingBox();
    if (!box) return false;

    console.log('🤖 Detected Cloudflare Turnstile widget. Attempting auto-bypass...');

    // The checkbox is located on the left side of the widget
    const clickX = box.x + 35 + Math.floor(Math.random() * 6 - 3);
    const clickY = box.y + box.height / 2 + Math.floor(Math.random() * 4 - 2);

    // Simulate human-like mouse movement curves
    await page.mouse.move(box.x - 50, box.y - 50);
    await new Promise(r => setTimeout(r, 200 + Math.random() * 300));
    
    // Move to target with 12 steps to mimic human cursor acceleration
    await page.mouse.move(clickX, clickY, { steps: 12 });
    await new Promise(r => setTimeout(r, 100 + Math.random() * 200));

    // Click at the checkbox coordinates
    await page.mouse.down();
    await new Promise(r => setTimeout(r, 50 + Math.random() * 50));
    await page.mouse.up();

    console.log('🤖 Clicked "I am human" Turnstile checkbox!');
    return true;
  } catch (err) {
    console.warn('⚠️ Auto-solve Turnstile error:', err.message);
    return false;
  }
}

async function waitForBypass(page) {
  console.log('🛡️ Cloudflare challenge detected! Solve the captcha in the browser window.');
  console.log('Waiting for bypass (up to 5 minutes)...');

  // Attempt auto-solve multiple times in a loop
  let autoSolveAttempted = false;
  let alertSent = false;

  for (let i = 0; i < config.LIMITS.CLOUDFLARE_RETRIES; i++) {
    await new Promise(r => setTimeout(r, 5000));
    try {
      if (page.isClosed()) return false;

      const title = await page.title();
      if (title.includes('Just a moment')) {
        console.log(`[${i + 1}/${config.LIMITS.CLOUDFLARE_RETRIES}] Still on Cloudflare challenge...`);
        
        // Notify only if we are stuck on the challenge for more than 15 seconds (i >= 2)
        if (i >= 2 && !alertSent) {
          notifyCloudflareChallenge().catch(() => {});
          alertSent = true;
        }
        
        // Try to solve it automatically if we haven't succeeded yet
        const hasWidget = await page.$('iframe[src*="challenges.cloudflare.com"]');
        if (hasWidget) {
          await tryAutoSolveTurnstile(page);
        }
        continue;
      }

      console.log('✅ Cloudflare bypassed!');
      return true;
    } catch {
      console.log(`[${i + 1}/${config.LIMITS.CLOUDFLARE_RETRIES}] Page transitioning...`);
    }
  }

  return false;
}

async function handleIfPresent(page) {
  if (await isOnCloudflare(page)) {
    const bypassed = await waitForBypass(page);
    if (!bypassed) throw new Error('Cloudflare challenge could not be bypassed.');
    await new Promise(r => setTimeout(r, 3000));
  }
}

module.exports = { isOnCloudflare, waitForBypass, handleIfPresent };
