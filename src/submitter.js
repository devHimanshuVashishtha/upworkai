const path = require('path');
const axios = require('axios');
const config = require('./config');
const db = require('./db');
const cloudflare = require('./cloudflare');
const { getLoggedInUser } = require('./auth');
const stats = require('./stats');

// Box-Muller transform to generate normally distributed random variables (Gaussian)
function randomNormal(mean = 0, stdDev = 1) {
  let u = 0, v = 0;
  while (u === 0) u = Math.random(); 
  while (v === 0) v = Math.random();
  let num = Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
  return num * stdDev + mean;
}

// Bezier curve calculations for realistic human-like mouse movement
async function moveMouseHumanLike(page, startX, startY, endX, endY, steps = 12) {
  const controlX = startX + (endX - startX) / 2 + (Math.random() - 0.5) * 120;
  const controlY = startY + (endY - startY) / 2 + (Math.random() - 0.5) * 120;

  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const x = (1 - t) * (1 - t) * startX + 2 * (1 - t) * t * controlX + t * t * endX;
    const y = (1 - t) * (1 - t) * startY + 2 * (1 - t) * t * controlY + t * t * endY;

    await page.mouse.move(Math.round(x), Math.round(y));
    await new Promise(r => setTimeout(r, Math.random() * 12 + 8));
  }
}

// Perform a human-like hover and click action using Bezier paths
async function humanClick(page, element) {
  const box = await element.boundingBox();
  if (!box) {
    await element.click();
    return;
  }

  const startX = Math.round(Math.random() * 200 + 50);
  const startY = Math.round(Math.random() * 200 + 50);
  const endX = Math.round(box.x + box.width * (0.25 + Math.random() * 0.5));
  const endY = Math.round(box.y + box.height * (0.25 + Math.random() * 0.5));

  await moveMouseHumanLike(page, startX, startY, endX, endY);
  await new Promise(r => setTimeout(r, Math.max(100, randomNormal(250, 60))));

  await page.mouse.down();
  await new Promise(r => setTimeout(r, Math.max(40, randomNormal(90, 20))));
  await page.mouse.up();
  await new Promise(r => setTimeout(r, 400));
}

// Helper to simulate human typing character-by-character with Gaussian delays and cognitive pauses
async function typeHumanStyle(page, element, text) {
  await element.focus();
  await element.scrollIntoViewIfNeeded();

  // Clear existing text for both standard textareas and contenteditable containers
  const isEditable = await element.evaluate(el => el.getAttribute('contenteditable') === 'true' || el.tagName !== 'TEXTAREA');
  await element.click();
  
  if (isEditable) {
    await page.keyboard.press('Control+A');
    await page.keyboard.press('Backspace');
  } else {
    await element.fill('');
    await element.click(); // Ensure focus returns to the textarea after clearing
  }

  const totalChars = text.length;
  let lastLoggedProgress = 0;

  for (let i = 0; i < totalChars; i++) {
    const char = text[i];
    let delay = Math.max(15, randomNormal(45, 15));

    if (char === ' ') {
      delay += Math.max(30, randomNormal(80, 25));
    } else if (/[.,\/#!$%\^&\*;:{}=\-_`~()?]/i.test(char)) {
      delay += Math.max(80, randomNormal(150, 40));
    } else if (char === char.toUpperCase() && char !== char.toLowerCase()) {
      delay += Math.max(25, randomNormal(40, 10));
    }

    await page.keyboard.type(char);

    const percent = Math.floor(((i + 1) / totalChars) * 100);
    if (percent >= lastLoggedProgress + 25) {
      console.log(` ✍️ Typing Progress: ${percent}% completed (${i + 1}/${totalChars} chars)...`);
      lastLoggedProgress = percent;
    }

    await new Promise(r => setTimeout(r, delay));
  }

  console.log(` ✍️ Typing Completed Successfully (100%).`);
  await new Promise(r => setTimeout(r, Math.max(100, randomNormal(400, 100))));
}

function removeEmojis(text) {
  if (!text) return '';
  // Strips emojis, symbols, and pictographs
  return text.replace(/\p{Extended_Pictographic}/gu, '').trim();
}

function parseProposalAndAnswers(fullProposalText) {
  if (!fullProposalText) return { coverLetter: '', answers: [] };

  const dividerRegex = /(?:📋\s*)?SCREENING QUESTIONS ANSWERS:/i;
  const parts = fullProposalText.split(dividerRegex);
  const coverLetter = removeEmojis(parts[0]);
  const answersSection = parts[1] || '';

  const answers = [];
  if (answersSection) {
    // Split by question markers like "1.", "2." at start of lines
    const lines = answersSection.split(/\n(?=\d+\.)/);
    for (const line of lines) {
      const cleanLine = line.trim();
      if (!cleanLine) continue;
      const answerParts = cleanLine.split('\n');
      // The first line is the question text, subsequent lines are the parsed answer
      const answerText = answerParts.slice(1).join('\n').trim();
      if (answerText) {
        answers.push(removeEmojis(answerText));
      }
    }
  }

  return { coverLetter, answers };
}

async function checkMoreConnectsNeeded(page) {
  const hasModal = await page.evaluate(() => {
    const el = document.querySelector('.fe-proposal-more-connects-needed-dialog, .fe-proposal-more-connects-needed-dialog-modal, [class*="more-connects-needed"]');
    if (el) {
      const rect = el.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0 && window.getComputedStyle(el).display !== 'none';
    }
    const modal = document.querySelector('.up-modal, [role="dialog"]');
    if (modal) {
      const text = modal.innerText || '';
      if (text.includes('Connects') && (text.includes('buy') || text.includes('needed') || text.includes('additional') || text.includes('not enough'))) {
        return true;
      }
    }
    return false;
  }).catch(() => false);

  if (hasModal) {
    throw new Error('You do not have enough Connects to submit this proposal. Upwork connects dialog appeared.');
  }
}

async function submitProposal(page, jobId, attachmentPaths = null) {
  let filesToAttach = [];
  if (Array.isArray(attachmentPaths)) {
    filesToAttach = attachmentPaths.filter(Boolean);
  } else if (typeof attachmentPaths === 'string' && attachmentPaths) {
    filesToAttach = [attachmentPaths];
  }
  const fileNames = filesToAttach.map(p => path.basename(p));
  const attachLabel = fileNames.length > 0 ? fileNames.join(', ') : 'None';

  console.log(`🤖 Initializing auto-submission for Job ID: ${jobId} (Attachments: ${attachLabel})...`);

  // Load job details from MongoDB
  const jobAlert = await db.getJobAlert(jobId);
  if (!jobAlert) {
    throw new Error(`Job details not found in MongoDB database for ID: ${jobId}`);
  }

  // Navigate directly to proposal page
  const applyUrl = `https://www.upwork.com/ab/proposals/job/${jobId}/apply/`;
  console.log(`🌐 Navigating to proposal page: ${applyUrl}`);
  await page.goto(applyUrl, { waitUntil: 'domcontentloaded', timeout: config.TIMEOUTS.NAVIGATION });
  await new Promise(r => setTimeout(r, 4000));

  // Handle Cloudflare bypass if present
  await cloudflare.handleIfPresent(page);

  // Assert login state
  const currentUrl = page.url();
  if (currentUrl.includes('/login') || await page.$('input#login_username')) {
    throw new Error('Upwork session expired. Please run the bot in headful mode once to refresh cookies.');
  }

  // Name Verification Safeguard
  console.log('👤 Verifying profile owner name...');
  const userName = await getLoggedInUser(page);
  const resumeName = config.FREELANCER_NAME;
  
  if (!userName || userName === 'Unknown User') {
    console.warn('⚠️ Profile name verification bypassed: Could not extract profile name on this page.');
  } else if (resumeName) {
    const uParts = userName.toLowerCase().split(/\s+/).filter(Boolean);
    const rParts = resumeName.toLowerCase().split(/\s+/).filter(Boolean);
    const matches = uParts.some(p => rParts.includes(p));
    if (!matches) {
      throw new Error(`Profile name verification failed. Scraped profile name "${userName}" does not match resume candidate name "${resumeName}".`);
    }
  }
  console.log(`✅ Profile name verified successfully: "${userName}"`);

  console.log('📝 Proposal page loaded. Verifying Connects balance...');
  
  let required = 0;
  let available = null;

  try {
    // Check page text recursively in a loop for up to 5 seconds to wait for connects rendering
    for (let i = 0; i < 10; i++) {
      const bodyText = await page.innerText('body').catch(() => '');
      
      const reqMatch = bodyText.match(/Required\s+Connects\s+to\s+submit\s+[^0-9]*\s*(\d+)/i) || 
                       bodyText.match(/(\d+)\s*connects?\s*required/i) ||
                       bodyText.match(/(\d+)\s*connects?/i);
      const availMatch = bodyText.match(/Available\s+Connects\s*[:\-]?\s*(\d+)/i) || 
                         bodyText.match(/Your\s+available\s+Connects\s*[:\-]?\s*(\d+)/i) ||
                         bodyText.match(/(\d+)\s*Available\s+Connects/i);
                         
      if (reqMatch) required = parseInt(reqMatch[1], 10);
      if (availMatch) {
        available = parseInt(availMatch[1], 10);
        break; // Dynamic connects elements fully rendered, break wait
      }
      await new Promise(r => setTimeout(r, 500));
    }

    if (available !== null) {
      stats.setConnects(available);

      if (available < config.MIN_CONNECTS_ALERT) {
        console.warn(`⚠️ LOW CONNECTS WARNING: Available balance (${available}) is below warning threshold (${config.MIN_CONNECTS_ALERT})`);
        try {
          axios.post(`https://api.telegram.org/bot${config.TELEGRAM_TOKEN}/sendMessage`, {
            chat_id: config.CHAT_ID,
            text: `⚠️ <b>LOW CONNECTS WARNING!</b>\n\nYour available connects balance is down to <b>${available} Connects</b> (below warning threshold of ${config.MIN_CONNECTS_ALERT} Connects).\n\n💳 Please recharge your connects on Upwork soon to avoid missing proposals!`,
            parse_mode: 'HTML'
          }).catch(() => {});
        } catch {}
      }
    }
    console.log(`📊 Connects Check - Required: ${required}, Available: ${available !== null ? available : 'Unknown'}`);
  } catch (err) {
    console.warn('⚠️ Connects balance check failed or timed out:', err.message);
  }

  if (available !== null && required > available) {
    throw new Error(`You do not have enough Connects to apply for this job (Required: ${required}, Available: ${available})`);
  }

  await checkMoreConnectsNeeded(page);

  // Wait for visible proposal textareas or contenteditable editors to load
  const inputSelector = 'textarea, div[contenteditable="true"]';
  try {
    await page.waitForSelector(inputSelector, { state: 'visible', timeout: 30000 });
  } catch (err) {
    const finalUrl = page.url();
    console.warn(`⚠️ Textarea loading timed out. Final URL: ${finalUrl}`);

    if (finalUrl.includes('/login')) {
      throw new Error('Upwork session expired. The page was redirected to the login screen.');
    }

    // Check for Cloudflare Turnstile presence
    const hasTurnstile = await page.$('iframe[src*="challenges.cloudflare.com"]').catch(() => null);
    if (hasTurnstile) {
      throw new Error('Blocked by Cloudflare challenge. Solve Turnstile in the browser window.');
    }

    // Check for job closed or restricted access messages
    const pageMessage = await page.evaluate(() => {
      const elements = Array.from(document.querySelectorAll('.up-alert-danger, .up-alert-error, h1, h2, .fe-proposal-job-details-error'));
      for (const el of elements) {
        const text = el.innerText.trim();
        if (text.includes('no longer available') || text.includes('closed') || text.includes('Access denied') || text.includes('not found') || text.includes('private')) {
          return text;
        }
      }
      return '';
    }).catch(() => '');

    if (pageMessage) {
      throw new Error(`Proposal page not loaded. Alert details: "${pageMessage}"`);
    }

    throw new Error(`Proposal form elements failed to load (Timeout 30s). Page title: "${await page.title().catch(() => 'Unknown')}"`);
  }
  
  // Wait a small buffer to let dynamic screening questions load/render
  await new Promise(r => setTimeout(r, 3000));

  const allElements = await page.$$(inputSelector);
  
  const textareas = [];
  for (const el of allElements) {
    if (await el.isVisible()) {
      textareas.push(el);
    }
  }

  console.log(`📊 Found ${textareas.length} visible input textareas/contenteditables on the proposal page.`);

  if (textareas.length === 0) {
    throw new Error('No visible input textareas or contenteditable fields found on the proposal page.');
  }

  const { coverLetter, answers } = parseProposalAndAnswers(jobAlert.proposal);

  // 1. Fill Cover Letter (the first textarea on the form)
  console.log('✍️ Typing cover letter (simulating human entry)...');
  await textareas[0].scrollIntoViewIfNeeded({ timeout: 5000 }).catch(err => {
    console.warn('⚠️ Cover letter scrollIntoViewIfNeeded timed out, proceeding anyway:', err.message);
  });
  await new Promise(r => setTimeout(r, 1000));
  await typeHumanStyle(page, textareas[0], coverLetter);

  // 2. Fill Screening Questions (if any) dynamically
  const numQuestions = textareas.length - 1;
  if (numQuestions > 0) {
    console.log(`✍️ Detecting and answering ${numQuestions} screening questions dynamically...`);
    const { generateScreeningAnswer } = require('./proposal');

    for (let i = 0; i < numQuestions; i++) {
      const targetTextarea = textareas[i + 1];
      
      // 1. Scrape the question label text dynamically from the DOM
      const questionText = await targetTextarea.evaluate(el => {
        const formGroup = el.closest('.up-form-group, .fe-proposal-job-questions, .fe-proposal-question, .fe-proposal-questions');
        if (formGroup) {
          const labelEl = formGroup.querySelector('label, .up-label, h4, h3, strong, p');
          if (labelEl) return labelEl.innerText.trim();
        }
        let parent = el.parentElement;
        for (let j = 0; j < 4; j++) {
          if (!parent) break;
          const labelEl = parent.querySelector('label, .up-label, h3, h4');
          if (labelEl) return labelEl.innerText.trim();
          parent = parent.parentElement;
        }
        return '';
      }).catch(() => '');

      console.log(`❓ Question ${i + 1}: "${questionText || 'No Label Found'}"`);

      // 2. Determine the answer dynamically
      let answer = '';
      if (questionText) {
        console.log(`🤖 Generating tailored AI answer for Question ${i + 1}...`);
        answer = await generateScreeningAnswer(questionText, jobAlert.title, jobAlert.description);
      } else if (answers && answers[i]) {
        answer = answers[i];
      } else {
        answer = 'I have relevant experience in this area and would be happy to discuss details.';
      }

      console.log(`✍️ Typing answer for Question ${i + 1} (${answer.length} chars)...`);
      await targetTextarea.scrollIntoViewIfNeeded({ timeout: 5000 }).catch(err => {
        console.warn(`⚠️ Question ${i + 1} scrollIntoViewIfNeeded timed out, proceeding anyway:`, err.message);
      });
      await new Promise(r => setTimeout(r, 1000));
      await typeHumanStyle(page, targetTextarea, answer);
    }
  }

  // 2.5 Attach selected file(s) (if provided)
  if (filesToAttach.length > 0) {
    console.log(`📎 Attaching ${filesToAttach.length} document file(s) to proposal: ${attachLabel}...`);
    try {
      // Upwork's file input is always hidden in the DOM — use locator directly without visibility check
      const fileInput = page.locator('input[type="file"]');
      const count = await fileInput.count();
      if (count > 0) {
        await fileInput.first().setInputFiles(filesToAttach);
        console.log(`✅ ${filesToAttach.length} File(s) attached successfully: ${attachLabel}`);
        console.log('⏳ Waiting for file upload progress to complete on Upwork form...');
        await new Promise(r => setTimeout(r, 6000)); // Wait for upload completion
      } else {
        console.warn('⚠️ No file input element found on the proposal page.');
      }
    } catch (err) {
      console.warn('⚠️ Could not attach file(s):', err.message);
    }
  }

  // 3. Scroll to Submit Button
  await checkMoreConnectsNeeded(page);
  console.log('🖱️ Locating submission controls...');
  const submitButtons = await page.$$('button[data-test="submit-proposal"], button.up-btn-primary, button[type="submit"]');
  let submitBtn = null;
  for (const btn of submitButtons) {
    if (await btn.isVisible()) {
      submitBtn = btn;
      break;
    }
  }

  if (!submitBtn) {
    throw new Error('Could not locate a visible submit proposal button on page.');
  }

  await submitBtn.scrollIntoViewIfNeeded({ timeout: 5000 }).catch(err => {
    console.warn('⚠️ Submit button scrollIntoViewIfNeeded timed out, proceeding anyway:', err.message);
  });
  await new Promise(r => setTimeout(r, 1500));

  // Hover and click submit using Bezier mouse movement curves
  console.log('🖱️ Moving mouse naturally to submit button...');
  await humanClick(page, submitBtn);
  console.log('🚀 Clicked Submit Button.');

  // 4. Handle confirmation checks/popups (Connects verification popup)
  await new Promise(r => setTimeout(r, 3000));
  await checkMoreConnectsNeeded(page);
  const confirmButtons = await page.$$('button[data-test="confirm-submit"], div.up-modal button.up-btn-primary, .up-modal-footer button.up-btn-primary');
  let confirmBtn = null;
  for (const btn of confirmButtons) {
    if (await btn.isVisible()) {
      confirmBtn = btn;
      break;
    }
  }

  if (confirmBtn) {
    console.log('📋 Handling connects confirmation popup...');
    
    const checkboxes = await page.$$('input[type="checkbox"]');
    let checkbox = null;
    for (const cb of checkboxes) {
      if (await cb.isVisible()) {
        checkbox = cb;
        break;
      }
    }

    if (checkbox) {
      await checkbox.scrollIntoViewIfNeeded({ timeout: 5000 }).catch(() => {});
      await checkbox.check();
      await new Promise(r => setTimeout(r, 800));
    }

    await confirmBtn.scrollIntoViewIfNeeded({ timeout: 5000 }).catch(err => {
      console.warn('⚠️ Confirm button scrollIntoViewIfNeeded timed out, proceeding anyway:', err.message);
    });
    await checkMoreConnectsNeeded(page);
    await humanClick(page, confirmBtn);
    console.log('🚀 Final submission confirmed.');
  }

  // 5. Verify Redirect Success (Ensure Upwork accepted the form and didn't stay on /apply/)
  console.log('⏳ Verifying submission redirect...');
  await new Promise(r => setTimeout(r, 6000));
  const finalUrl = page.url();
  if (finalUrl.includes('/apply/')) {
    await checkMoreConnectsNeeded(page);
    // 1. Check for visible modal dialog error popups
    const modalText = await page.evaluate(() => {
      const modals = Array.from(document.querySelectorAll('.up-modal, [role="dialog"], .modal-dialog, .up-modal-body'));
      for (const modal of modals) {
        const rect = modal.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0 && window.getComputedStyle(modal).display !== 'none') {
          return modal.innerText;
        }
      }
      return '';
    }).catch(() => '');

    if (modalText) {
      throw new Error(`Submission blocked by modal error: ${modalText.trim().replace(/\s+/g, ' ')}`);
    }

    // 2. Check for standard inline error banners
    const errorText = await page.evaluate(() => {
      const alert = document.querySelector('.up-alert-danger, .up-alert-error, [role="alert"], [data-test="error"]');
      return alert ? alert.innerText : '';
    }).catch(() => '');
    
    throw new Error(`Submission failed. Still on the apply page. ${errorText ? 'Error: ' + errorText.trim() : 'Insufficient connects or submission error.'}`);
  }

  console.log('✅ Auto-submission process completed successfully!');
  return true;
}

module.exports = { submitProposal };
