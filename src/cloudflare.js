const axios = require('axios');
const db = require('./db');
const config = require('./config');
const { startRemoteDebuggerTunnel, stopRemoteDebuggerTunnel } = require('./browser');

async function notifyCloudflareChallenge(tunnelUrl, serverIp) {
  try {
    const users = await db.getAuthorizedUsers();
    console.log(`🛡️ Broadcasting Cloudflare challenge alert to ${users.length} authorized users...`);
    
    let messageText = '🛡️ <b>Cloudflare Challenge Detected!</b>\n\nThe bot is currently stuck on a Cloudflare captcha page. Please open the browser window and solve it manually.';
    
    if (tunnelUrl) {
      messageText = `🛡️ <b>Cloudflare Challenge Detected!</b>\n\n` +
        `The bot is stuck in the cloud. You can solve it remotely from your screen:\n` +
        `🔗 <a href="${tunnelUrl}">Open Remote Chrome Debugger</a>\n\n` +
        `🔑 <b>Tunnel Password (if prompted):</b> <code>${serverIp}</code>\n\n` +
        `<i>Instruction: Click the link, select the active Upwork tab (e.g. login/search), click the Screencast icon (device icon) on the top left of DevTools, and click the captcha checkbox!</i>`;
    }

    for (const chatId of users) {
      try {
        await axios.post(`https://api.telegram.org/bot${config.TELEGRAM_TOKEN}/sendMessage`, {
          chat_id: chatId,
          text: messageText,
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

    console.log('🤖 Detected Cloudflare Turnstile widget. Attempting auto-bypass...');

    // Method 1: Playwright locator-based relative offset click (highly robust for headless containers)
    try {
      const locator = page.locator('iframe[src*="challenges.cloudflare.com"]');
      const clickX = 35 + Math.floor(Math.random() * 6 - 3);
      const clickY = 32 + Math.floor(Math.random() * 4 - 2);
      await locator.click({ position: { x: clickX, y: clickY }, force: true, timeout: 5000 });
      console.log('🤖 Clicked Turnstile checkbox using locator relative offset!');
      return true;
    } catch (locatorErr) {
      console.warn('⚠️ Locator offset click failed, falling back to mouse move emulation:', locatorErr.message);
    }

    // Method 2: Custom coordinates-based mouse emulation curve fallback
    const box = await iframeElement.boundingBox();
    if (!box) return false;

    const clickX = box.x + 35 + Math.floor(Math.random() * 6 - 3);
    const clickY = box.y + box.height / 2 + Math.floor(Math.random() * 4 - 2);

    await page.mouse.move(box.x - 50, box.y - 50);
    await new Promise(r => setTimeout(r, 200 + Math.random() * 300));
    await page.mouse.move(clickX, clickY, { steps: 12 });
    await new Promise(r => setTimeout(r, 100 + Math.random() * 200));

    await page.mouse.down();
    await new Promise(r => setTimeout(r, 50 + Math.random() * 50));
    await page.mouse.up();

    console.log('🤖 Clicked Turnstile checkbox using human mouse emulation!');
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
  let alertSent = false;

  try {
    for (let i = 0; i < config.LIMITS.CLOUDFLARE_RETRIES; i++) {
      await new Promise(r => setTimeout(r, 5000));
      try {
        if (page.isClosed()) return false;

        const title = await page.title();
        if (title.includes('Just a moment')) {
          console.log(`[${i + 1}/${config.LIMITS.CLOUDFLARE_RETRIES}] Still on Cloudflare challenge...`);
          
          // Notify only if we are stuck on the challenge for more than 15 seconds (i >= 2)
          if (i >= 2 && !alertSent) {
            alertSent = true;
            // Launch debugger tunnel in background
            (async () => {
              try {
                // Fetch public IP address for localtunnel bypass password
                let serverIp = 'Unknown';
                try {
                  const ipRes = await axios.get('https://api.ipify.org', { timeout: 5000 });
                  serverIp = ipRes.data.trim();
                } catch (ipErr) {
                  console.warn('⚠️ Could not fetch public IP:', ipErr.message);
                }
                
                const tunnelUrl = await startRemoteDebuggerTunnel();
                await notifyCloudflareChallenge(tunnelUrl, serverIp);
              } catch (tunnelErr) {
                console.error('⚠️ Failed to launch remote debugging tunnel:', tunnelErr.message);
                await notifyCloudflareChallenge(null, 'Unknown');
              }
            })();
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
      } catch (err) {
        console.log(`[${i + 1}/${config.LIMITS.CLOUDFLARE_RETRIES}] Page transitioning...`);
      }
    }
    return false;
  } finally {
    // Always stop remote debugger tunnel when exiting the Cloudflare loop
    stopRemoteDebuggerTunnel();
  }
}

async function handleIfPresent(page) {
  if (await isOnCloudflare(page)) {
    const bypassed = await waitForBypass(page);
    if (!bypassed) throw new Error('Cloudflare challenge could not be bypassed.');
    await new Promise(r => setTimeout(r, 3000));
  }
}

module.exports = { isOnCloudflare, waitForBypass, handleIfPresent };
