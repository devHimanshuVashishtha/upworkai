const config = require('./config');
const storage = require('./storage');
const notifier = require('./notifier');
const db = require('./db');
const proposalService = require('./proposal');
const cloudflare = require('./cloudflare');
const { waitForJobTiles, navigateWithCloudflare } = require('./page-utils');
const stats = require('./stats');

async function extractJobs(page) {
  const sel = config.SELECTORS;

  const rawJobs = await page.$$eval(sel.JOB_TILE, (tiles, selectors) => {
    return tiles.map(tile => {
      const titleEl = tile.querySelector(selectors.JOB_TITLE_LINK) || tile.querySelector(selectors.JOB_TITLE_FALLBACK);
      const descEl  = tile.querySelector(selectors.JOB_DESCRIPTION) ||
                       tile.querySelector(selectors.JOB_DESCRIPTION_ALT) ||
                       tile.querySelector(selectors.JOB_DESCRIPTION_FALLBACK);
      
      // Extract connects cost via multiple robust regex matches on the tile's text content
      const cardText = tile.innerText || '';
      let connects = null;
      
      const match1 = cardText.match(/(\d+)\s*connects?/i);
      const match2 = cardText.match(/connects?\s*(?:to\s*apply)?\s*[:\-]?\s*(\d+)/i);
      const match3 = cardText.match(/requires?\s*(\d+)\s*connects?/i);
      
      if (match1) {
        connects = parseInt(match1[1], 10);
      } else if (match2) {
        connects = parseInt(match2[1], 10);
      } else if (match3) {
        connects = parseInt(match3[1], 10);
      }

      // Extract client stats from tile text
      const isPaymentVerified = !/payment unverified/i.test(cardText);
      
      let clientSpend = 0;
      const spendMatch = cardText.match(/\$(\d+(?:\.\d+)?)\s*(k|m)?\+?\s*spent/i);
      if (spendMatch) {
        let val = parseFloat(spendMatch[1]);
        const unit = (spendMatch[2] || '').toLowerCase();
        if (unit === 'k') val *= 1000;
        if (unit === 'm') val *= 1000000;
        clientSpend = val;
      }

      let clientRating = 0;
      const ratingMatch = cardText.match(/(\d(?:\.\d)?)\s*of\s*5\s*stars/i) || cardText.match(/rating\s*:\s*(\d(?:\.\d)?)/i);
      if (ratingMatch) {
        clientRating = parseFloat(ratingMatch[1]);
      }

      let clientLocation = '';
      const locMatch = cardText.match(/(?:located in|from)\s+([A-Za-z\s]+)/i);
      if (locMatch) {
        clientLocation = locMatch[1].trim();
      }

      return {
        title: titleEl ? titleEl.innerText.trim() : 'No Title',
        link: titleEl ? titleEl.href : '',
        description: descEl ? descEl.innerText.trim() : '',
        connects: connects,
        paymentVerified: isPaymentVerified,
        clientSpend: clientSpend,
        clientRating: clientRating,
        clientLocation: clientLocation
      };
    });
  }, sel);

  // Normalize URLs to strip tracking query parameters (avoids duplicate alerts)
  return rawJobs.map(job => {
    if (job.link) {
      try {
        const parsed = new URL(job.link);
        job.link = `${parsed.protocol}//${parsed.hostname}${parsed.pathname}`;
      } catch {
        job.link = job.link.split('?')[0];
      }
    }
    return job;
  });
}

function matchesFilters(job) {
  const text = `${job.title} ${job.description}`.toLowerCase();

  const isMatch = config.TARGET_KEYWORDS.some(kw => text.includes(kw.toLowerCase()));
  const isExcluded = config.IGNORE_KEYWORDS.some(kw => text.includes(kw.toLowerCase()));

  if (!isMatch || isExcluded) return false;

  // 1. Payment Verification Filter
  if (config.PAYMENT_VERIFIED_ONLY && job.paymentVerified === false) {
    console.log(`   🚫 Filtered out "${job.title}": Payment Unverified`);
    return false;
  }

  // 2. Minimum Client Spend Filter
  if (config.MIN_CLIENT_SPEND > 0 && job.clientSpend < config.MIN_CLIENT_SPEND) {
    console.log(`   🚫 Filtered out "${job.title}": Client Spend ($${job.clientSpend}) < Min Required ($${config.MIN_CLIENT_SPEND})`);
    return false;
  }

  // 3. Minimum Client Rating Filter
  if (config.MIN_CLIENT_RATING > 0 && job.clientRating > 0 && job.clientRating < config.MIN_CLIENT_RATING) {
    console.log(`   🚫 Filtered out "${job.title}": Client Rating (${job.clientRating}) < Min Required (${config.MIN_CLIENT_RATING})`);
    return false;
  }

  return true;
}

async function scrapeAllQueries(page, freelancerName = '') {
  // Establish MongoDB connection at the start of the run
  try {
    await db.connectDb();
  } catch (e) {
    console.error('⚠️ MongoDB connection could not be established. Alerts will not be saved to DB.');
  }

  const searchUrls = config.getSearchUrls();
  const queries = config.SEARCH_QUERIES;

  let totalJobs = 0;
  let newAlerts = 0;
  let failedQueriesCount = 0;

  for (let i = 0; i < searchUrls.length; i++) {
    if (stats.isPaused()) {
      console.log(`\n⏸️ [${new Date().toLocaleTimeString()}] Scraper was paused via Telegram. Aborting search run...`);
      break;
    }
    const queryName = queries[i] || 'search';
    
    if (i > 0) {
      const queryDelay = Math.round(15 + Math.random() * 10);
      console.log(`   ⏳ Waiting ${queryDelay} seconds before loading next search query to mimic human browsing...`);
      await new Promise(r => setTimeout(r, queryDelay * 1000));
      
      console.log(`\n🔎 [${i + 1}/${searchUrls.length}] Searching: "${queryName}"`);
      try {
        await navigateWithCloudflare(page, searchUrls[i]);
      } catch (e) {
        console.log(`   ⚠️ Cloudflare blocked "${queryName}", skipping...`);
        failedQueriesCount++;
        continue;
      }
    } else {
      console.log(`\n🔎 [${i + 1}/${searchUrls.length}] Searching: "${queryName}"`);
    }

    const tilesLoaded = await waitForJobTiles(page);
    if (!tilesLoaded) {
      console.log(`   ⚠️ No job tiles found for "${queryName}", skipping...`);
      failedQueriesCount++;
      continue;
    }

    const jobs = await extractJobs(page);
    console.log(`   📊 Found ${jobs.length} jobs for "${queryName}"`);
    totalJobs += jobs.length;
    stats.incrementScanned(jobs.length);

    for (const job of jobs) {
      if (stats.isPaused()) {
        console.log('⏸️ Scraper was paused via Telegram. Aborting job match checks...');
        break;
      }
      if (!job.link || storage.has(job.link)) continue;
      if (!matchesFilters(job)) continue;

      console.log(`   🎯 MATCH: "${job.title}"`);
      stats.incrementMatches(1);

      // Add delay to prevent hitting Gemini API 429 rate limits when processing multiple matched jobs
      if (newAlerts > 0) {
        const apiDelay = Math.round(30 + Math.random() * 15);
        console.log(`   ⏳ Waiting ${apiDelay} seconds to respect Gemini API rate limits...`);
        await new Promise(r => setTimeout(r, apiDelay * 1000));
      }

      // Open the job link in a new tab to extract full description and connects required
      console.log(`   🌐 Fetching full details for: "${job.title}"`);
      let fullDescription = job.description;
      let connects = null;
      try {
        let jobId = job.link ? job.link.match(/~[0-9a-fA-F]+/) : null;
        jobId = jobId ? jobId[0] : null;
        const targetUrl = jobId ? `https://www.upwork.com/ab/proposals/job/${jobId}/apply/` : job.link;

        const detailPage = await page.context().newPage();
        await detailPage.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 25000 });
        await new Promise(r => setTimeout(r, 4000));
        await cloudflare.handleIfPresent(detailPage);

        // Get full description text
        const descEl = await detailPage.$('[data-test="job-description-text"]') ||
                       await detailPage.$('.job-description') ||
                       await detailPage.$('.break-word');
        if (descEl) {
          fullDescription = await descEl.innerText();
        }

        // Parse connects cost from body innerText
        const bodyText = await detailPage.innerText('body');
        const connectsMatch = bodyText.match(/requires?\s*(\d+)\s*connects?/i) ||
                              bodyText.match(/(\d+)\s*connects?/i) ||
                              bodyText.match(/connects?\s*(?:to\s*\w+)*\s*[:\-]?\s*(\d+)/i) ||
                              bodyText.match(/connects?\s+[^0-9]*\s*(\d+)/i);
        if (connectsMatch) {
          connects = parseInt(connectsMatch[1], 10);
        }

        await detailPage.close();
      } catch (err) {
        console.warn(`   ⚠️ Failed to load full details for "${job.title}":`, err.message);
      }

      job.description = fullDescription || job.description;
      job.connects = connects || job.connects;

      // Generate AI proposal via Gemini signed with the freelancer's name
      const { summary, proposal, score } = await proposalService.generateProposal(job.title, job.description, freelancerName);
      job.score = score;

      try {
        await notifier.sendTelegramAlert(job, queryName, proposal, summary);
        storage.add(job.link);
        storage.save(); // Save immediately to prevent duplicate alerts if script is interrupted
        newAlerts++;
        console.log('   ✅ Telegram alert sent.');

        // Persist to MongoDB along with proposal
        await db.saveJobAlert(job, queryName, proposal, summary);
      } catch (e) {
        const detail = e.response && e.response.data ? JSON.stringify(e.response.data) : '';
        console.error(`   ❌ Telegram or Database error: ${e.message}. Detail: ${detail}`);
      }
    }
  }

  // Send diagnostic alert if all queries failed (likely broken selectors or Cloudflare gate)
  if (searchUrls.length > 0 && failedQueriesCount === searchUrls.length) {
    console.error('🚨 CRITICAL: Selector failed to locate job listings on all queries. Layout change or CAPTCHA blocked.');
    try {
      await page.screenshot({ path: config.ERROR_SCREENSHOT_PATH, fullPage: true });
      await notifier.sendTelegramAlert({
        title: '🚨 BOT DIAGNOSTIC ERROR',
        link: 'https://www.upwork.com',
        description: 'The scraper was unable to locate any job cards on Upwork. This happens when Upwork updates its layout selectors, the session is invalidated, or Cloudflare blocks the request. Please run in headful mode (HEADLESS=false) to debug.'
      }, 'System Diagnostics', 'Attention Required: The DOM parser could not match selectors. Verify layout elements or login state.');
    } catch (err) {
      console.error('⚠️ Failed to send Telegram diagnostic alert:', err.message);
    }
  }

  return { totalJobs, newAlerts };
}

module.exports = {
  scrapeAllQueries,
  matchesFilters
};
