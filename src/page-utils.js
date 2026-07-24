const config = require('./config');

async function hasJobTiles(page) {
  try {
    return await page.evaluate((sel) => {
      return !!document.querySelector(sel.JOB_TILE) || !!document.querySelector(sel.JOB_TILE_ALT);
    }, config.SELECTORS);
  } catch {
    return false;
  }
}

async function isGuestOrLoginPage(page) {
  try {
    const url = page.url();
    if (url.includes('login') || url.includes('signup')) return true;

    return await page.evaluate((sel) => {
      const header = document.querySelector(sel.HEADER) || document.querySelector(sel.HEADER_ALT);
      if (!header) return false;

      const links = Array.from(header.querySelectorAll(sel.GUEST_LINKS));
      return links.some(link => {
        const style = window.getComputedStyle(link);
        return style.display !== 'none' && style.visibility !== 'hidden' && link.offsetWidth > 0;
      });
    }, config.SELECTORS);
  } catch {
    return false;
  }
}

async function waitForJobTiles(page) {
  for (let i = 0; i < config.LIMITS.JOB_TILE_RETRIES; i++) {
    if (await hasJobTiles(page)) return true;
    await new Promise(r => setTimeout(r, 2000));
  }
  return false;
}

async function navigateWithCloudflare(page, url) {
  const cloudflare = require('./cloudflare');

  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: config.TIMEOUTS.NAVIGATION });
  await new Promise(r => setTimeout(r, config.TIMEOUTS.STABILIZE));

  await cloudflare.handleIfPresent(page);
}

module.exports = { hasJobTiles, isGuestOrLoginPage, waitForJobTiles, navigateWithCloudflare };
