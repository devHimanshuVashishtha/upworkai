const axios = require('axios');
const fs = require('fs');
const path = require('path');
const config = require('./config');
const db = require('./db');
const { connectCDP, disconnect, bringChromeToFront } = require('./browser');
const { submitProposal } = require('./submitter');
const { rewriteProposal } = require('./proposal');
const stats = require('./stats');
const authSignals = require('./auth-signals');
let lastInteractionTime = 0;

const submissionQueue = [];
let isProcessingQueue = false;

// Multi-step conversation state tracker (keyed by chat_id)
const conversationState = {};

// Multi-select attachment selection state tracker (keyed by jobId)
const activeAttachmentSelections = {};

// Buffer queue for notifications while user is in active interactive sessions
const pendingAlertsQueue = [];

// User editing state tracker (keyed by chat_id)
const userStates = {};

const PAUSE_SIGNAL_HTML = '\n\n⏸️ <b>Scraper loop is currently paused.</b>\n👉 <b>Send /start to resume scanning.</b>';

const attachmentsDir = path.resolve(__dirname, '..', 'attachments');
if (!fs.existsSync(attachmentsDir)) {
  try {
    fs.mkdirSync(attachmentsDir, { recursive: true });
  } catch {}
}

function getAvailableAttachmentFiles() {
  const allowedExtensions = ['.pdf', '.zip', '.rar', '.png', '.jpg', '.jpeg', '.docx', '.txt'];
  const filesSet = new Set();
  const filePathsMap = {};

  // 1. Scan root directory (e.g. resume.pdf)
  try {
    const rootFiles = fs.readdirSync(path.resolve(__dirname, '..'))
      .filter(file => allowedExtensions.some(ext => file.toLowerCase().endsWith(ext)));
    for (const f of rootFiles) {
      const fullPath = path.resolve(__dirname, '..', f);
      if (fs.statSync(fullPath).isFile()) {
        filesSet.add(f);
        filePathsMap[f] = fullPath;
      }
    }
  } catch {}

  // 2. Scan attachments directory
  try {
    if (fs.existsSync(attachmentsDir)) {
      const attFiles = fs.readdirSync(attachmentsDir)
        .filter(file => allowedExtensions.some(ext => file.toLowerCase().endsWith(ext)));
      for (const f of attFiles) {
        const fullPath = path.resolve(attachmentsDir, f);
        if (fs.statSync(fullPath).isFile()) {
          filesSet.add(f);
          filePathsMap[f] = fullPath;
        }
      }
    }
  } catch {}

  return {
    files: Array.from(filesSet),
    filePathsMap
  };
}

function isUserBusy() {
  const now = Date.now();
  const INACTIVE_TIMEOUT = 3 * 60 * 1000;
  const INTERACTION_COOLDOWN = 30 * 1000; // 30 seconds interaction cooldown

  // 1. Check if user has interacted recently to avoid screen interruption
  if (now - lastInteractionTime < INTERACTION_COOLDOWN) {
    return true;
  }

  // 2. Check active conversation flows
  for (const chatId in conversationState) {
    const st = conversationState[chatId];
    if (st) {
      if (st.timestamp && (now - st.timestamp > INACTIVE_TIMEOUT)) {
        console.log(`⏰ Inactive conversation state timed out for Chat ID: ${chatId}`);
        delete conversationState[chatId];
      } else {
        return true;
      }
    }
  }

  // 3. Check onboarding / credentials state flows
  for (const chatId in userStates) {
    const st = userStates[chatId];
    if (st) {
      if (st.timestamp && (now - st.timestamp > INACTIVE_TIMEOUT)) {
        console.log(`⏰ Inactive user state timed out for Chat ID: ${chatId}`);
        delete userStates[chatId];
      } else {
        return true;
      }
    }
  }

  // 4. Check attachment selections
  for (const jobId in activeAttachmentSelections) {
    const st = activeAttachmentSelections[jobId];
    if (st) return true;
  }

  return false;
}

async function flushPendingAlerts() {
  if (pendingAlertsQueue.length === 0 || isUserBusy()) return;
  console.log(`🚀 User interactive session finished. Flushing ${pendingAlertsQueue.length} buffered job alert(s) to Telegram...`);

  while (pendingAlertsQueue.length > 0 && !isUserBusy()) {
    const item = pendingAlertsQueue.shift();
    try {
      await dispatchTelegramAlert(item.job, item.queryName, item.proposal, item.summary);
      await new Promise(r => setTimeout(r, 1500));
    } catch (err) {
      console.error('⚠️ Failed to dispatch buffered Telegram alert:', err.message);
    }
  }
}

// Background auto-flush checker
setInterval(() => {
  flushPendingAlerts();
}, 5000);

function buildAttachmentKeyboard(jobId) {
  const state = activeAttachmentSelections[jobId];
  if (!state) return { inline_keyboard: [] };

  const { files, selectedIndexes } = state;
  const inline_keyboard = files.map((file, idx) => {
    const isSelected = selectedIndexes.has(idx);
    const icon = isSelected ? '☑️' : '◻️';
    return [{ text: `${icon} ${file}`, callback_data: `attach_toggle:${jobId}:${idx}` }];
  });

  // Explicit button to prompt user to send any file in chat
  inline_keyboard.push([{ text: '📤 Upload New File via Chat', callback_data: `attach_upload_prompt:${jobId}` }]);

  const count = selectedIndexes.size;
  const doneText = count > 0 
    ? `🚀 Submit with ${count} Selected Attachment${count > 1 ? 's' : ''}` 
    : '🚀 Submit (No Attachments Selected)';

  inline_keyboard.push([{ text: doneText, callback_data: `attach_done:${jobId}` }]);
  inline_keyboard.push([{ text: '⏭️ Skip Attachment (Submit Now)', callback_data: `attach_skip:${jobId}` }]);

  return { inline_keyboard };
}

function buildDeleteProjectsKeyboard(deletedCount = 0) {
  const projects = config.PORTFOLIO_PROJECTS;
  if (!projects || projects.length === 0) {
    return null;
  }

  const inline_keyboard = projects.map((p, idx) => {
    return [{ text: `🗑️ Delete: ${p.name}`, callback_data: `delproject_idx:${idx}:${deletedCount}` }];
  });

  const cancelText = deletedCount > 0 ? `🏁 Done (${deletedCount} deleted)` : '❌ Cancel';
  inline_keyboard.push([{ text: cancelText, callback_data: `delproject_cancel:${deletedCount}` }]);
  return { inline_keyboard };
}

function buildDeleteQueriesKeyboard(deletedCount = 0) {
  const r = config.getRawRules();
  const queries = r.search_queries || [];
  if (queries.length === 0) return null;

  const inline_keyboard = queries.map((q, idx) => {
    return [{ text: `🗑️ Delete: "${q}"`, callback_data: `delquery_idx:${idx}:${deletedCount}` }];
  });

  const cancelText = deletedCount > 0 ? `🏁 Done (${deletedCount} deleted)` : '❌ Cancel';
  inline_keyboard.push([{ text: cancelText, callback_data: `delquery_cancel:${deletedCount}` }]);
  return { inline_keyboard };
}

function escapeHtml(text) {
  if (!text) return '';
  return text
    .toString()
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function buildRulesConfigHtml() {
  const r = config.getRawRules();
  const minBudget = r.min_budget || 0;
  const maxConnects = r.max_connects_limit || 'None';
  const queries = r.search_queries || [];

  return [
    '⚙️ <b>Current Rules Configuration</b>',
    '━━━━━━━━━━━━━━━━━━━━',
    `👤 <b>Freelancer Name:</b> ${config.FREELANCER_NAME || 'None'}`,
    `💰 <b>Min Budget:</b> $${minBudget}`,
    `💳 <b>Max Connects Limit:</b> ${maxConnects}`,
    `💤 <b>Sleep Schedule:</b> ${config.SLEEP_START_HOUR}:00 - ${config.SLEEP_END_HOUR}:00`,
    '',
    `🔎 <b>Queries (${queries.length}):</b>`,
    queries.map((q, idx) => `  ${idx + 1}. <code>${q}</code>`).join('\n') || '  None',
    '',
    `📝 <b>Commands to Edit:</b>`,
    `• <code>/setbudget</code> - Edit min budget`,
    `• <code>/setconnects</code> - Edit max connects limit`,
    `• <code>/addquery</code> - Add search query`,
    `• <code>/delquery</code> - Delete search query`,
    '━━━━━━━━━━━━━━━━━━━━'
  ].join('\n');
}

function buildJobAlertHtml(jobAlert, suffix = '') {
  const score = jobAlert.score || 'N/A';
  const connects = jobAlert.connects || 'N/A';

  const connectsLimit = config.MAX_CONNECTS_LIMIT;
  let connectsWarning = '';
  if (connectsLimit !== null && typeof jobAlert.connects === 'number' && jobAlert.connects > connectsLimit) {
    connectsWarning = `⚠️ <b>High Connects Alert: This job requires ${jobAlert.connects} Connects to apply!</b>\n\n`;
  }

  const parts = [
    `🎯 <b>Job Match Alert (${escapeHtml(jobAlert.queryName)})</b>`,
    `📌 <b>Title:</b> <a href="${escapeHtml(jobAlert.link)}">${escapeHtml(jobAlert.title)}</a>`,
    `⭐ <b>Match Score:</b> ${escapeHtml(score)}`,
    `💳 <b>Connects Required:</b> ${escapeHtml(connects)}`,
    '',
    `📋 <b>Requirements Summary:</b>`,
    escapeHtml(jobAlert.summary || 'No summary available.'),
  ];

  if (jobAlert.proposal) {
    parts.push(
      '',
      `📝 <b>AI Proposal (Tap to Copy):</b>`,
      `<pre>${escapeHtml(jobAlert.proposal)}</pre>`
    );
  }

  if (suffix) {
    parts.push('', suffix);
  }
  return connectsWarning + parts.join('\n');
}
function detectRequestedAttachment(text) {
  if (!text) return null;
  const lower = text.toLowerCase();

  if (lower.includes('attach resume') || lower.includes('upload resume') || lower.includes('send resume') || lower.includes('include resume')) {
    return 'Resume (PDF)';
  }
  if (lower.includes('attach portfolio') || lower.includes('upload portfolio') || lower.includes('share portfolio') || lower.includes('send portfolio') || lower.includes('portfolio pdf')) {
    return 'Portfolio / Work Samples (PDF)';
  }
  if (lower.includes('attach code') || lower.includes('upload code') || lower.includes('share github') || lower.includes('sample project') || lower.includes('attach project')) {
    return 'Project / Code Sample File';
  }
  
  // Generic regex match for attachment requests in job description
  const match = text.match(/(?:please\s+|must\s+|be\s+sure\s+to\s+)?(?:attach|upload|send|include)\s+[^.\n]{5,60}/i);
  if (match) {
    return match[0].trim();
  }
  
  return null;
}

async function sendTelegramAlert(job, queryName, proposal = '', summary = '') {
  if (isUserBusy()) {
    console.log(`⏳ User is currently busy in an active Telegram session/command. Buffering job alert for "${job.title}"...`);
    pendingAlertsQueue.push({ job, queryName, proposal, summary });
    return;
  }

  await dispatchTelegramAlert(job, queryName, proposal, summary);
}

async function dispatchTelegramAlert(job, queryName, proposal = '', summary = '') {
  let jobId = job.link ? job.link.match(/~[0-9a-fA-F]+/) : null;
  jobId = jobId ? jobId[0] : job.link;

  const jobAlert = {
    title: job.title,
    queryName,
    score: job.score,
    connects: job.connects,
    link: job.link,
    summary,
    proposal
  };

  const message = buildJobAlertHtml(jobAlert);

  const reply_markup = jobId ? {
    inline_keyboard: [
      [
        { text: 'Accept ✅', callback_data: `accept:${jobId}` },
        { text: 'Reject ❌', callback_data: `reject:${jobId}` }
      ]
    ]
  } : undefined;

  const authorizedUsers = await db.getAuthorizedUsers();

  for (const chatId of authorizedUsers) {
    try {
      await axios.post(`https://api.telegram.org/bot${config.TELEGRAM_TOKEN}/sendMessage`, {
        chat_id: chatId,
        text: message,
        parse_mode: 'HTML',
        reply_markup,
      });
    } catch (err) {
      if (err.response && err.response.data && err.response.data.description && err.response.data.description.includes('too long')) {
        console.warn(`⚠️ Telegram message too long for ${chatId}, splitting into two messages to prevent truncation...`);
        
        const fallbackMessage = buildJobAlertHtml({ ...jobAlert, proposal: '' });

        // 1. Send metadata card with buttons
        const cardRes = await axios.post(`https://api.telegram.org/bot${config.TELEGRAM_TOKEN}/sendMessage`, {
          chat_id: chatId,
          text: fallbackMessage,
          parse_mode: 'HTML',
          reply_markup,
        });

        const cardMessageId = cardRes.data && cardRes.data.result && cardRes.data.result.message_id;

        // 2. Send full copyable proposal text in a second message (as a direct reply to the card to link them)
        if (proposal && cardMessageId) {
          const maxProposalLen = 3500;
          let cleanProposal = proposal;
          if (cleanProposal.length > maxProposalLen) {
            cleanProposal = cleanProposal.substring(0, maxProposalLen) + '\n\n... [Proposal Truncated to fit Telegram limits]';
          }

          await axios.post(`https://api.telegram.org/bot${config.TELEGRAM_TOKEN}/sendMessage`, {
            chat_id: chatId,
            text: `📝 <b>AI Proposal (Tap to Copy):</b>\n\n<pre>${escapeHtml(cleanProposal)}</pre>`,
            parse_mode: 'HTML',
            reply_to_message_id: cardMessageId
          });
        }
      } else {
        console.error(`❌ Failed to send dispatch alert to ${chatId}:`, err.message);
      }
    }
  }
}

let pollingStarted = false;
let offset = 0;
let currentInterval = 3000;
const offsetPath = path.resolve(__dirname, '..', '.tg_offset.json');

// Load stored update_id offset on startup
try {
  if (fs.existsSync(offsetPath)) {
    const saved = JSON.parse(fs.readFileSync(offsetPath, 'utf8'));
    if (saved && typeof saved.offset === 'number') {
      offset = saved.offset;
      console.log(`📦 Loaded Telegram offset: ${offset} from .tg_offset.json`);
    }
  }
} catch (e) {
  console.warn('⚠️ Could not load saved Telegram offset file:', e.message);
}

// Background cleanup routine to evict expired edit sessions (10 minute TTL)
setInterval(() => {
  const now = Date.now();
  const TTL = 10 * 60 * 1000; 
  for (const chat_id in userStates) {
    if (userStates[chat_id] && now - userStates[chat_id].timestamp > TTL) {
      console.log(`🧹 Evicting abandoned edit session for Chat ID: ${chat_id}`);
      delete userStates[chat_id];
    }
  }
}, 120000); // Check every 2 minutes

let botUsername = null;
async function getBotUsername() {
  if (botUsername) return botUsername;
  try {
    const res = await axios.get(`https://api.telegram.org/bot${config.TELEGRAM_TOKEN}/getMe`);
    botUsername = res.data.result.username;
    return botUsername;
  } catch (err) {
    console.error('⚠️ Failed to get bot username:', err.message);
    return null;
  }
}

async function editMessageTextSafe(chat_id, message_id, textParts, jobId, customHeader = '🚨 <b>New Upwork Match! (Edited)</b>') {
  const buildText = (pText, sText) => {
    const parts = [
      customHeader,
      '',
      `<b>Title:</b> ${escapeHtml(textParts.title)}`,
      `<b>Search:</b> ${escapeHtml(textParts.queryName)}`,
      `<b>Match Score:</b> ${textParts.score ? `<b>${escapeHtml(textParts.score)}</b>` : 'Unknown'}`,
      `<b>Connects Required:</b> ${textParts.connects ? `${escapeHtml(textParts.connects.toString())} Connects` : 'Unknown'}`,
      `<b>Link:</b> <a href="${escapeHtml(textParts.link)}">Apply Here</a>`,
    ];
    if (sText) {
      parts.push('', '📋 <b>AI Job Summary:</b>', escapeHtml(sText));
    }
    if (pText) {
      parts.push('', '📝 <b>AI Proposal (Tap to Copy):</b>', `<pre>${escapeHtml(pText)}</pre>`);
    }
    return parts.join('\n');
  };

  const message = buildText(textParts.proposal, textParts.summary);
  const reply_markup = {
    inline_keyboard: [
      [
        { text: 'Accept ✅', callback_data: `accept:${jobId}` },
        { text: 'Reject ❌', callback_data: `reject:${jobId}` }
      ]
    ]
  };

  try {
    await axios.post(`https://api.telegram.org/bot${config.TELEGRAM_TOKEN}/editMessageText`, {
      chat_id,
      message_id,
      text: message,
      parse_mode: 'HTML',
      reply_markup,
    });
  } catch (err) {
    if (err.response && err.response.data && err.response.data.description && err.response.data.description.includes('too long')) {
      console.warn('⚠️ Edited message too long, sending fallback truncated proposal...');
      const truncatedProposal = textParts.proposal.substring(0, 3000) + '\n\n... [Proposal Truncated to fit Telegram limit]';
      const fallbackMessage = buildText(truncatedProposal, textParts.summary);
      await axios.post(`https://api.telegram.org/bot${config.TELEGRAM_TOKEN}/editMessageText`, {
        chat_id,
        message_id,
        text: fallbackMessage,
        parse_mode: 'HTML',
        reply_markup,
      });
    } else {
      throw err;
    }
  }
}

function startTelegramListener() {
  if (pollingStarted) return;
  pollingStarted = true;

  console.log('🤖 Telegram updates listener (polling) started...');
  
  // Register suggested bot commands with Telegram
  axios.post(`https://api.telegram.org/bot${config.TELEGRAM_TOKEN}/setMyCommands`, {
    commands: [
      { command: 'start', description: '▶️ Start / resume Upwork scraping cycle' },
      { command: 'accounts', description: '📂 Manage and switch Upwork profiles' },
      { command: 'users', description: '👥 Manage authorized users (Revoke access)' },
      { command: 'grant', description: '🤫 Grant silent access to a user via ID & username' },
      { command: 'status', description: '📊 Show live bot status, diagnostics and uptime' },
      { command: 'pause', description: '⏸️ Pause Upwork scraping cycle' },
      { command: 'rules', description: '⚙️ View current rules configuration' },
      { command: 'resume', description: '📄 View freelancer profile or upload new PDF' },
      { command: 'updateresume', description: '📤 Upload new PDF resume & update rules' },
      { command: 'addquery', description: '➕ Add a new search query' },
      { command: 'delquery', description: '❌ Delete an existing search query' },
      { command: 'setbudget', description: '💰 Set the minimum job budget' },
      { command: 'setconnects', description: '💳 Set the max connects warning threshold' },
      { command: 'projects', description: '📂 View all portfolio project links' },
      { command: 'addproject', description: '➕ Add a portfolio project link' },
      { command: 'delproject', description: '❌ Remove a portfolio project link' },
      { command: 'analytics', description: '📊 Show proposal conversion analytics and reports' }
    ]
  }).then(() => {
    console.log('✅ Telegram bot commands registered successfully.');
  }).catch(err => {
    console.warn('⚠️ Failed to register Telegram bot commands:', err.message);
  });

  getBotUsername().then((username) => {
    if (username) {
      console.log(`🤖 Logged in bot username: @${username}`);
    }
  });

  async function poll() {
    try {
      const response = await axios.get(`https://api.telegram.org/bot${config.TELEGRAM_TOKEN}/getUpdates?offset=${offset}&timeout=5`);
      const updates = response.data && response.data.result;
      
      // Reset backoff on success
      currentInterval = 3000;

      if (updates && updates.length > 0) {
        for (const update of updates) {
          offset = update.update_id + 1;
          
          // Persist the offset synchronously to prevent processing duplicates on restart
          try {
            fs.writeFileSync(offsetPath, JSON.stringify({ offset }), 'utf8');
          } catch (err) {
            console.error('⚠️ Failed to write Telegram offset file:', err.message);
          }

          if (update.callback_query) {
            await handleCallbackQuery(update.callback_query);
          } else if (update.message) {
            if (update.message.text) {
              await handleTextMessage(update.message);
            } else if (update.message.document) {
              await handleDocumentMessage(update.message);
            }
          }
        }
      }
    } catch (err) {
      if (err.response && err.response.status === 409) {
        // Exponential backoff jitter logic for duplicate polling conflicts
        currentInterval = Math.min(60000, currentInterval * 2 + Math.random() * 3000);
        console.warn(`🚨 Conflict (409): Dual-polling detected. Backing off for ${Math.round(currentInterval / 1000)}s...`);
      } else if (!err.message.includes('timeout') && !err.message.includes('code 502')) {
        console.error('⚠️ Telegram listener polling error:', err.message);
        currentInterval = Math.min(30000, currentInterval * 1.5);
      }
    }
    
    setTimeout(poll, currentInterval);
  }

  poll();
}

async function handleAccountsCallback(action, dataArg, chat_id, message_id) {
  try {
    if (action === 'accounts_add') {
      userStates[chat_id] = { action: 'awaiting_email', timestamp: Date.now() };
      await axios.post(`https://api.telegram.org/bot${config.TELEGRAM_TOKEN}/sendMessage`, {
        chat_id,
        text: '📧 <b>Add New Upwork Account:</b>\n\nPlease enter the Upwork <b>Login Email</b> for this account:',
        parse_mode: 'HTML'
      });
      return;
    }

    if (action === 'accounts_list_switch') {
      const accounts = await db.getAccounts();
      const activeEmail = config.activeAccountEmail;
      const inactiveAccounts = accounts.filter(acc => acc.email !== activeEmail);

      if (inactiveAccounts.length === 0) {
        await axios.post(`https://api.telegram.org/bot${config.TELEGRAM_TOKEN}/sendMessage`, {
          chat_id,
          text: 'ℹ️ <b>No other accounts configured</b> to switch to. Add a new account first!',
          parse_mode: 'HTML'
        });
        return;
      }

      const inlineKeyboard = {
        inline_keyboard: inactiveAccounts.map(acc => [
          { text: `🔄 Switch to: ${acc.name} (${acc.email})`, callback_data: `accounts_switch:${acc.email}` }
        ])
      };

      await axios.post(`https://api.telegram.org/bot${config.TELEGRAM_TOKEN}/sendMessage`, {
        chat_id,
        text: '🔄 <b>Select the account you want to switch to:</b>',
        parse_mode: 'HTML',
        reply_markup: inlineKeyboard
      });
      return;
    }

    if (action === 'accounts_list_delete') {
      const accounts = await db.getAccounts();
      if (accounts.length === 0) return;

      const inlineKeyboard = {
        inline_keyboard: accounts.map(acc => [
          { text: `❌ Delete: ${acc.name} (${acc.email})`, callback_data: `accounts_delete:${acc.email}` }
        ])
      };

      await axios.post(`https://api.telegram.org/bot${config.TELEGRAM_TOKEN}/sendMessage`, {
        chat_id,
        text: '❌ <b>Select the account you want to delete:</b>',
        parse_mode: 'HTML',
        reply_markup: inlineKeyboard
      });
      return;
    }

    if (action === 'accounts_switch') {
      const email = dataArg;
      console.log(`🔄 Switching active account to: ${email}`);
      
      const success = await db.setActiveAccount(email);
      if (success) {
        // Kill port process to terminate active browser session for clean switch
        try {
          const { killPortProcess } = require('./browser');
          killPortProcess(config.CHROME_DEBUG_PORT);
        } catch (err) {
          console.warn('⚠️ Failed to kill active Chrome process on port cleanup:', err.message);
        }

        // Reload active configuration
        await config.reloadActiveAccount();

        await axios.post(`https://api.telegram.org/bot${config.TELEGRAM_TOKEN}/sendMessage`, {
          chat_id,
          text: `🟢 <b>Account successfully switched!</b>\n\nActive profile is now: <b>${config.FREELANCER_NAME}</b> (<code>${config.activeAccountEmail}</code>)\n\n⚡ <i>Existing Chrome processes on port 9222 were force-closed. The next search cycle will launch using the new isolated profile.</i>`,
          parse_mode: 'HTML'
        });
      } else {
        await axios.post(`https://api.telegram.org/bot${config.TELEGRAM_TOKEN}/sendMessage`, {
          chat_id,
          text: '❌ Failed to switch account in database.',
          parse_mode: 'HTML'
        });
      }
      return;
    }

    if (action === 'accounts_delete') {
      const email = dataArg;
      console.log(`🗑️ Deleting account: ${email}`);

      const wasActive = (email === config.activeAccountEmail);
      const success = await db.deleteAccount(email);
      
      if (success) {
        if (wasActive) {
          // If active was deleted, reload config to fallback to default .env
          try {
            const { killPortProcess } = require('./browser');
            killPortProcess(config.CHROME_DEBUG_PORT);
          } catch {}
          await config.reloadActiveAccount();
        }

        await axios.post(`https://api.telegram.org/bot${config.TELEGRAM_TOKEN}/sendMessage`, {
          chat_id,
          text: `🗑️ <b>Account deleted successfully!</b>\n\nDeleted profile: <code>${email}</code>`,
          parse_mode: 'HTML'
        });
      } else {
        await axios.post(`https://api.telegram.org/bot${config.TELEGRAM_TOKEN}/sendMessage`, {
          chat_id,
          text: '❌ Failed to delete account from database.',
          parse_mode: 'HTML'
        });
      }
      return;
    }
  } catch (err) {
    console.error('❌ Error handling accounts callback query:', err.message);
  }
}

async function handleAccessCallback(action, targetChatId, chat_id, message_id) {
  try {
    if (action === 'access_grant_list') {
      const revoked = await db.getRevokedUsersDetailed();
      if (revoked.length === 0) {
        await axios.post(`https://api.telegram.org/bot${config.TELEGRAM_TOKEN}/editMessageText`, {
          chat_id,
          message_id,
          text: '👥 <b>Re-Authorize Users:</b>\n\nNo revoked users found in history.',
          parse_mode: 'HTML',
          reply_markup: {
            inline_keyboard: [[{ text: '🔙 Back to Users', callback_data: 'access_users_back' }]]
          }
        });
        return;
      }

      let message = '👥 <b>Re-Authorize Users:</b>\n\nSelect a revoked user to grant them access silently:\n━━━━━━━━━━━━━━━━━━━━\n';
      revoked.forEach((u, i) => {
        message += `${i + 1}. 👤 @${escapeHtml(u.username)} (<code>${u.chatId}</code>)\n`;
      });
      message += '━━━━━━━━━━━━━━━━━━━━';

      const inlineKeyboard = {
        inline_keyboard: revoked.map(u => [
          { text: `➕ Grant @${u.username}`, callback_data: `access_grant_user:${u.chatId}` }
        ])
      };
      inlineKeyboard.inline_keyboard.push([
        { text: '🔙 Back to Users', callback_data: 'access_users_back' }
      ]);

      await axios.post(`https://api.telegram.org/bot${config.TELEGRAM_TOKEN}/editMessageText`, {
        chat_id,
        message_id,
        text: message,
        parse_mode: 'HTML',
        reply_markup: inlineKeyboard
      });
      return;
    }

    if (action === 'access_grant_user') {
      const revoked = await db.getRevokedUsersDetailed();
      const user = revoked.find(u => u.chatId.toString() === targetChatId.toString());
      const username = user ? user.username : 'Unknown';

      await db.addAuthorizedUser(targetChatId, username);

      await axios.post(`https://api.telegram.org/bot${config.TELEGRAM_TOKEN}/editMessageText`, {
        chat_id,
        message_id,
        text: `🤫 <b>Silent Access Granted:</b>\n\n@${escapeHtml(username)} (<code>${targetChatId}</code>) has been authorized. No notification was sent to them.`,
        parse_mode: 'HTML',
        reply_markup: {
          inline_keyboard: [[{ text: '🔙 Back to Users', callback_data: 'access_users_back' }]]
        }
      });
      return;
    }

    if (action === 'access_users_back') {
      const users = await db.getAuthorizedUsersDetailed();
      const otherUsers = users.filter(u => u.chatId.toString() !== config.CHAT_ID.toString());
      const revokedUsers = await db.getRevokedUsersDetailed();

      let message = '';
      const inlineKeyboard = { inline_keyboard: [] };

      if (otherUsers.length === 0) {
        message = '👥 <b>Authorized Users</b>\n\nNo active secondary users are authorized.';
      } else {
        message = `👥 <b>Authorized Users (${otherUsers.length}):</b>\n\nSelect a user to revoke their access:\n━━━━━━━━━━━━━━━━━━━━\n`;
        otherUsers.forEach((u, i) => {
          message += `${i + 1}. 👤 @${escapeHtml(u.username)} (<code>${u.chatId}</code>)\n`;
        });
        message += '━━━━━━━━━━━━━━━━━━━━';

        otherUsers.forEach(u => {
          inlineKeyboard.inline_keyboard.push([
            { text: `🗑️ Revoke @${u.username}`, callback_data: `access_revoke:${u.chatId}` }
          ]);
        });
      }

      if (revokedUsers.length > 0) {
        inlineKeyboard.inline_keyboard.push([
          { text: '➕ Re-Authorize Revoked User', callback_data: 'access_grant_list' }
        ]);
      }

      await axios.post(`https://api.telegram.org/bot${config.TELEGRAM_TOKEN}/editMessageText`, {
        chat_id,
        message_id,
        text: message,
        parse_mode: 'HTML',
        reply_markup: inlineKeyboard
      });
      return;
    }

    if (action === 'access_revoke') {
      const users = await db.getAuthorizedUsersDetailed();
      const user = users.find(u => u.chatId.toString() === targetChatId.toString());
      const username = user ? user.username : 'Unknown';

      await db.removeAuthorizedUser(targetChatId);

      await axios.post(`https://api.telegram.org/bot${config.TELEGRAM_TOKEN}/editMessageText`, {
        chat_id,
        message_id,
        text: `🗑️ <b>Access Revoked:</b> @${escapeHtml(username)} (<code>${targetChatId}</code>) is no longer authorized.`,
        parse_mode: 'HTML',
        reply_markup: {
          inline_keyboard: [[{ text: '🔙 Back to Users', callback_data: 'access_users_back' }]]
        }
      });

      // Notify target user
      try {
        await axios.post(`https://api.telegram.org/bot${config.TELEGRAM_TOKEN}/sendMessage`, {
          chat_id: targetChatId,
          text: '🛑 <b>Access Revoked:</b>\n\nYour access to this bot has been revoked by the owner.',
          parse_mode: 'HTML'
        });
      } catch {}
      return;
    }

    const pending = await db.getPendingAccessRequest(targetChatId);
    if (!pending) {
      await axios.post(`https://api.telegram.org/bot${config.TELEGRAM_TOKEN}/editMessageText`, {
        chat_id,
        message_id,
        text: '⚠️ <b>Access Request Expired:</b> This request is no longer valid.',
        parse_mode: 'HTML'
      });
      return;
    }

    if (action === 'access_approve') {
      await db.addAuthorizedUser(targetChatId, pending.username);
      await db.deletePendingAccessRequest(targetChatId);

      await axios.post(`https://api.telegram.org/bot${config.TELEGRAM_TOKEN}/editMessageText`, {
        chat_id,
        message_id,
        text: `✅ <b>Access Approved:</b> @${escapeHtml(pending.username)} (<code>${targetChatId}</code>) is now authorized!`,
        parse_mode: 'HTML'
      });

      // Notify the target user
      await axios.post(`https://api.telegram.org/bot${config.TELEGRAM_TOKEN}/sendMessage`, {
        chat_id: targetChatId,
        text: '🎉 <b>Access Approved!</b>\n\nThe owner has approved your access. You will now receive job alerts and can control the bot.',
        parse_mode: 'HTML'
      });
    } else if (action === 'access_deny') {
      await db.denyAuthorizedUser(targetChatId, pending.username);
      await db.deletePendingAccessRequest(targetChatId);

      await axios.post(`https://api.telegram.org/bot${config.TELEGRAM_TOKEN}/editMessageText`, {
        chat_id,
        message_id,
        text: `❌ <b>Access Denied:</b> Denied request for @${escapeHtml(pending.username)} (<code>${targetChatId}</code>).`,
        parse_mode: 'HTML',
        reply_markup: {
          inline_keyboard: [[{ text: '🔙 Back to Users', callback_data: 'access_users_back' }]]
        }
      });

      // Notify the target user
      await axios.post(`https://api.telegram.org/bot${config.TELEGRAM_TOKEN}/sendMessage`, {
        chat_id: targetChatId,
        text: '❌ <b>Access Request Denied:</b>\n\nYour request to access this bot was denied by the owner.',
        parse_mode: 'HTML'
      });
    }
  } catch (err) {
    console.error('❌ Error handling access callback:', err.message);
  }
}

async function handleCallbackQuery(callbackQuery) {
  const { id, data, message } = callbackQuery;
  const chat_id = message.chat.id;
  const message_id = message.message_id;

  const parts = data.split(':');
  const action = parts[0];

  // 1. Check if this is an access approval/denial action
  if (action.startsWith('access_')) {
    if (chat_id.toString() !== config.CHAT_ID.toString()) {
      try {
        await axios.post(`https://api.telegram.org/bot${config.TELEGRAM_TOKEN}/answerCallbackQuery`, {
          callback_query_id: id,
          text: '❌ Only the bot owner can approve access requests!',
          show_alert: true
        });
      } catch {}
      return;
    }

    // Acknowledge the callback query immediately to stop the loading spinner
    try {
      await axios.post(`https://api.telegram.org/bot${config.TELEGRAM_TOKEN}/answerCallbackQuery`, {
        callback_query_id: id
      });
    } catch {}

    await handleAccessCallback(action, parts.slice(1).join(':'), chat_id, message_id);
    return;
  }

  // 2. Security check: Only allow authorized users to interact with other options
  const isAuthorized = await db.isUserAuthorized(chat_id);
  if (!isAuthorized) {
    try {
      await axios.post(`https://api.telegram.org/bot${config.TELEGRAM_TOKEN}/answerCallbackQuery`, {
        callback_query_id: id,
        text: '❌ Access Denied: You are not authorized to use this bot.',
        show_alert: true
      });
    } catch {}
    return;
  }

  lastInteractionTime = Date.now();

  // Acknowledge the callback query immediately to stop the loading spinner
  try {
    await axios.post(`https://api.telegram.org/bot${config.TELEGRAM_TOKEN}/answerCallbackQuery`, {
      callback_query_id: id
    });
  } catch {}

  if (action.startsWith('accounts_')) {
    await handleAccountsCallback(action, parts.slice(1).join(':'), chat_id, message_id);
    return;
  }

  if (action === 'startup_select') {
    const email = parts.slice(1).join(':');
    console.log(`🚀 Startup profile selected option: ${email}`);
    
    try {
      if (email === 'default') {
        await db.setActiveAccount(null);
        await config.reloadActiveAccount();
        
        await axios.post(`https://api.telegram.org/bot${config.TELEGRAM_TOKEN}/editMessageText`, {
          chat_id,
          message_id,
          text: '⚙️ <b>Running session using local fallback configuration credentials (.env).</b>\nScraper loop initializing...',
          parse_mode: 'HTML'
        });
        authSignals.emit('startup-profile-selected');
      } else if (email === 'load_env') {
        // Load settings from .env / rules.json and save to MongoDB
        const defaultEmail = process.env.UPWORK_EMAIL || 'default@example.com';
        const defaultPassword = process.env.UPWORK_PASSWORD || '';
        const defaultName = config.FREELANCER_NAME || 'Default Candidate';
        const rawRules = config.getRawRules();

        const newAccount = {
          email: defaultEmail.toLowerCase(),
          password: defaultPassword,
          name: defaultName,
          rules: rawRules,
          isActive: true
        };
        await db.saveAccount(newAccount);
        await db.setActiveAccount(newAccount.email);
        await config.reloadActiveAccount();

        await axios.post(`https://api.telegram.org/bot${config.TELEGRAM_TOKEN}/editMessageText`, {
          chat_id,
          message_id,
          text: `📥 <b>Loaded & saved profile from .env: ${defaultName}</b> (<code>${defaultEmail}</code>)\nScraper loop initializing...`,
          parse_mode: 'HTML'
        });
        authSignals.emit('startup-profile-selected');
      } else if (email === 'add_new') {
        userStates[chat_id] = { action: 'awaiting_email', timestamp: Date.now() };
        await axios.post(`https://api.telegram.org/bot${config.TELEGRAM_TOKEN}/editMessageText`, {
          chat_id,
          message_id,
          text: '📧 <b>Add New Upwork Account:</b>\n\nPlease type and send the Upwork <b>Login Email</b> for this account:',
          parse_mode: 'HTML'
        });
        // We do NOT emit startup-profile-selected here; the promise will wait until onboarding completes.
      } else {
        await db.setActiveAccount(email);
        await config.reloadActiveAccount();
        
        await axios.post(`https://api.telegram.org/bot${config.TELEGRAM_TOKEN}/editMessageText`, {
          chat_id,
          message_id,
          text: `🟢 <b>Profile selected: ${config.FREELANCER_NAME}</b> (<code>${config.activeAccountEmail}</code>)\nScraper loop initializing...`,
          parse_mode: 'HTML'
        });
        authSignals.emit('startup-profile-selected');
      }
    } catch (err) {
      console.error('⚠️ Failed to confirm startup selection:', err.message);
      // Fallback emit to unblock bot
      authSignals.emit('startup-profile-selected');
    }
    return;
  }

  const jobId = parts[1];
  const extraArg = parts.slice(2).join(':');

  if (action === 'reject') {
    console.log(`❌ Reject clicked for Job ID: ${jobId}`);

    try {
      const jobAlert = await db.getJobAlert(jobId);
      if (!jobAlert) throw new Error('Job alert details not found.');
      
      const updatedText = buildJobAlertHtml(jobAlert, '❓ <b>Do you want to edit this proposal using AI, edit it manually, or reject it completely?</b>');
      await axios.post(`https://api.telegram.org/bot${config.TELEGRAM_TOKEN}/editMessageText`, {
        chat_id,
        message_id,
        text: updatedText,
        parse_mode: 'HTML',
        reply_markup: {
          inline_keyboard: [
            [
              { text: 'Edit with AI 🤖', callback_data: `edit_prompt:${jobId}` },
              { text: 'Edit Manually ✍️', callback_data: `edit_manual:${jobId}` }
            ],
            [
              { text: 'Confirm Reject ❌', callback_data: `confirm_reject:${jobId}` }
            ]
          ]
        }
      });
    } catch (err) {
      console.error('⚠️ Failed to show reject options in Telegram:', err.message);
    }
  } else if (action === 'confirm_reject') {
    console.log(`❌ Confirm Reject clicked for Job ID: ${jobId}`);
    await db.updateJobStatus(jobId, 'rejected');
    stats.incrementRejected(1);

    try {
      const jobAlert = await db.getJobAlert(jobId);
      if (!jobAlert) throw new Error('Job alert details not found.');
      const updatedText = buildJobAlertHtml(jobAlert, '❌ <b>Rejected</b>');
      await axios.post(`https://api.telegram.org/bot${config.TELEGRAM_TOKEN}/editMessageText`, {
        chat_id,
        message_id,
        text: updatedText,
        parse_mode: 'HTML',
        reply_markup: { inline_keyboard: [] }
      });
      // Remove reply keyboard if active
      await axios.post(`https://api.telegram.org/bot${config.TELEGRAM_TOKEN}/sendMessage`, {
        chat_id,
        text: '❌ <b>Proposal Rejected.</b>',
        parse_mode: 'HTML',
        reply_markup: { remove_keyboard: true }
      });
    } catch (err) {
      console.error('⚠️ Failed to mark proposal as rejected in Telegram:', err.message);
    }
  } else if (action === 'edit_prompt') {
    console.log(`📝 Edit with AI prompted for Job ID: ${jobId}`);
    
    // Save state with timestamp so we can auto-cleanup inactive sessions
    userStates[chat_id] = { 
      action: 'awaiting_edit_prompt', 
      jobId, 
      originalMessageId: message_id,
      timestamp: Date.now()
    };

    try {
      const jobAlert = await db.getJobAlert(jobId);
      if (!jobAlert) throw new Error('Job alert details not found.');
      const updatedText = buildJobAlertHtml(jobAlert, '✍️ <b>Please reply to this alert with your specific AI editing instructions (e.g. "make it shorter", "focus on React Native").</b>');
      await axios.post(`https://api.telegram.org/bot${config.TELEGRAM_TOKEN}/editMessageText`, {
        chat_id,
        message_id,
        text: updatedText,
        parse_mode: 'HTML',
        reply_markup: { inline_keyboard: [] }
      });
    } catch (err) {
      console.error('⚠️ Failed to ask for AI edit prompt in Telegram:', err.message);
    }
  } else if (action === 'edit_manual') {
    console.log(`✍️ Edit Manually prompted for Job ID: ${jobId}`);
    
    // Save state with timestamp for manual edit path
    userStates[chat_id] = { 
      action: 'awaiting_manual_edit', 
      jobId, 
      originalMessageId: message_id,
      timestamp: Date.now()
    };

    try {
      const jobAlert = await db.getJobAlert(jobId);
      if (!jobAlert) throw new Error('Job alert details not found.');
      const updatedText = buildJobAlertHtml(jobAlert, '✍️ <b>Awaiting manual cover letter edit...</b>');
      await axios.post(`https://api.telegram.org/bot${config.TELEGRAM_TOKEN}/editMessageText`, {
        chat_id,
        message_id,
        text: updatedText,
        parse_mode: 'HTML',
        reply_markup: { inline_keyboard: [] }
      });

      // Send helper message to user to copy and resend
      await axios.post(`https://api.telegram.org/bot${config.TELEGRAM_TOKEN}/sendMessage`, {
        chat_id,
        text: '✍️ <b>Copy the proposal above (Tap to Copy), paste it in your chat box, edit it, and send it back to me.</b>',
        parse_mode: 'HTML'
      });
    } catch (err) {
      console.error('⚠️ Failed to ask for manual edit text in Telegram:', err.message);
    }
  } else if (action === 'accept') {
    console.log(`✅ Accept clicked for Job ID: ${jobId}`);

    const { files, filePathsMap } = getAvailableAttachmentFiles();
    
    // Auto pre-select resume.pdf if present
    const selectedIndexes = new Set();
    const resumeIdx = files.indexOf('resume.pdf');
    if (resumeIdx !== -1) {
      selectedIndexes.add(resumeIdx);
    }

    activeAttachmentSelections[jobId] = { files, filePathsMap, selectedIndexes, messageId: message_id, chatId: chat_id };

    try {
      const jobAlert = await db.getJobAlert(jobId);
      const fullText = (jobAlert ? (jobAlert.description || '') + ' ' + (jobAlert.summary || '') : '');
      const clientRequestedDoc = detectRequestedAttachment(fullText);

      let attachmentSubheader = '';
      if (clientRequestedDoc) {
        attachmentSubheader = `⚠️ <b>CLIENT ATTACHMENT REQUEST DETECTED!</b>\nThe client specifically requested: <i>"${escapeHtml(clientRequestedDoc)}"</i>\n\n📎 <b>Upload or Select Document below:</b>\n• Send document directly to this chat now (saves to your library)\n• OR tick saved files below to select/unselect\n• OR tap <b>⏭️ Skip Attachment</b>:`;
      } else {
        attachmentSubheader = `📎 <b>Do you want to attach any document/file to this proposal?</b>\n\n• Send/upload any document file directly to this chat now (saves to your library)\n• OR tick saved files below to select/unselect\n• OR tap <b>⏭️ Skip Attachment (Submit Now)</b> if no file is needed:`;
      }

      const alertHtml = buildJobAlertHtml(
        jobAlert || { title: 'Job Alert', queryName: 'Query', link: '#' },
        attachmentSubheader
      );
      const reply_markup = buildAttachmentKeyboard(jobId);

      await axios.post(`https://api.telegram.org/bot${config.TELEGRAM_TOKEN}/editMessageText`, {
        chat_id,
        message_id,
        text: alertHtml,
        parse_mode: 'HTML',
        reply_markup
      });
    } catch (err) {
      console.error('⚠️ Failed to show attachment choice layout in Telegram:', err.message);
    }
    return;

  } else if (action === 'attach_toggle') {
    const fileIdx = parseInt(extraArg, 10);
    const state = activeAttachmentSelections[jobId];
    if (state && !isNaN(fileIdx)) {
      if (state.selectedIndexes.has(fileIdx)) {
        state.selectedIndexes.delete(fileIdx);
      } else {
        state.selectedIndexes.add(fileIdx);
      }
      try {
        const jobAlert = await db.getJobAlert(jobId);
        const count = state.selectedIndexes.size;
        const subheader = count > 0
          ? `📎 <b>Attachment Options:</b> ${count} file(s) selected. Tap more to toggle or Submit:`
          : '📎 <b>Attachment Options:</b> Tap files to select/unselect one or more documents to attach, then tap Submit:';
        const alertHtml = buildJobAlertHtml(jobAlert || { title: 'Job Alert', queryName: 'Query', link: '#' }, subheader);
        const reply_markup = buildAttachmentKeyboard(jobId);

        await axios.post(`https://api.telegram.org/bot${config.TELEGRAM_TOKEN}/editMessageText`, {
          chat_id,
          message_id,
          text: alertHtml,
          parse_mode: 'HTML',
          reply_markup
        });
      } catch (err) {
        console.error('⚠️ Failed to update attachment toggle in Telegram:', err.message);
      }
    }

  } else if (action === 'attach_upload_prompt') {
    userStates[chat_id] = { action: 'awaiting_custom_attachment', jobId, originalMessageId: message_id, timestamp: Date.now() };
    try {
      await axios.post(`https://api.telegram.org/bot${config.TELEGRAM_TOKEN}/sendMessage`, {
        chat_id,
        text: '📤 <b>Upload New File:</b> Please send/attach your document file (.pdf, .zip, .docx, .png) directly to this Telegram chat now, and it will be saved to your Attachments Library and selected for this proposal!',
        parse_mode: 'HTML'
      });
    } catch {}

  } else if (action === 'delproject_idx') {
    const partsSub = (extraArg ? `${jobId}:${extraArg}` : jobId).split(':');
    const index = parseInt(partsSub[0], 10);
    const prevCount = parseInt(partsSub[1] || '0', 10);
    const newCount = prevCount + 1;

    const r = config.loadAndGetRules();
    if (r.portfolio_projects && !isNaN(index) && index >= 0 && index < r.portfolio_projects.length) {
      const deleted = r.portfolio_projects[index];
      r.portfolio_projects.splice(index, 1);
      const success = config.saveRules(r);

      try {
        const remainingCount = r.portfolio_projects.length;
        const updatedMarkup = buildDeleteProjectsKeyboard(newCount);
        const textMsg = success
          ? (remainingCount > 0
              ? `✅ <b>Deleted project "${escapeHtml(deleted.name)}"!</b> (${newCount} deleted so far)\n\n🗑️ Select another project to delete (or tap Done):`
              : `✅ <b>Deleted project "${escapeHtml(deleted.name)}"!</b>\n\n📂 All portfolio projects have been removed.`)
          : '❌ Failed to delete project.';

        await axios.post(`https://api.telegram.org/bot${config.TELEGRAM_TOKEN}/editMessageText`, {
          chat_id,
          message_id,
          text: textMsg,
          parse_mode: 'HTML',
          reply_markup: updatedMarkup || { inline_keyboard: [] }
        });
      } catch (err) {
        console.error('⚠️ Failed to edit delproject message:', err.message);
      }
    }

  } else if (action === 'delproject_cancel') {
    const count = parseInt(extraArg || jobId || '0', 10);
    const r = config.getRawRules();
    const remainingCount = (r.portfolio_projects || []).length;
    const textMsg = count > 0
      ? `✅ <b>Finished editing portfolio projects.</b> Total ${count} project(s) deleted.\nRemaining portfolio projects: ${remainingCount}`
      : '❌ <b>Project deletion cancelled. No projects were deleted.</b>';

    try {
      await axios.post(`https://api.telegram.org/bot${config.TELEGRAM_TOKEN}/editMessageText`, {
        chat_id,
        message_id,
        text: textMsg,
        parse_mode: 'HTML',
        reply_markup: { inline_keyboard: [] }
      });
    } catch {}

  } else if (action === 'delquery_idx') {
    const partsSub = (extraArg ? `${jobId}:${extraArg}` : jobId).split(':');
    const index = parseInt(partsSub[0], 10);
    const prevCount = parseInt(partsSub[1] || '0', 10);
    const newCount = prevCount + 1;

    const r = config.loadAndGetRules();
    if (r.search_queries && !isNaN(index) && index >= 0 && index < r.search_queries.length) {
      const deleted = r.search_queries[index];
      r.search_queries.splice(index, 1);
      const success = config.saveRules(r);
      if (success) stats.setPaused(true);

      try {
        const remainingCount = r.search_queries.length;
        const updatedMarkup = buildDeleteQueriesKeyboard(newCount);
        const textMsg = success
          ? (remainingCount > 0
              ? `✅ <b>Deleted search query "${escapeHtml(deleted)}"!</b> (${newCount} deleted so far)\n\n🔎 Select another search query to delete (or tap Done):\n\n⏸️ <b>Scraper loop is currently paused. Send /start to resume scanning.</b>`
              : `✅ <b>Deleted search query "${escapeHtml(deleted)}"!</b>\n\n🔎 All search queries have been removed.\n\n⏸️ <b>Scraper loop is currently paused. Send /start to resume scanning.</b>`)
          : '❌ Failed to delete search query.';

        await axios.post(`https://api.telegram.org/bot${config.TELEGRAM_TOKEN}/editMessageText`, {
          chat_id,
          message_id,
          text: textMsg,
          parse_mode: 'HTML',
          reply_markup: updatedMarkup || { inline_keyboard: [] }
        });
      } catch (err) {
        console.error('⚠️ Failed to edit delquery message:', err.message);
      }
    }

  } else if (action === 'delquery_cancel') {
    const count = parseInt(extraArg || jobId || '0', 10);
    const r = config.getRawRules();
    const remainingCount = (r.search_queries || []).length;
    const textMsg = count > 0
      ? `✅ <b>Finished editing search queries.</b> Total ${count} query(ies) deleted.\nRemaining search queries: ${remainingCount}\n\n⏸️ <b>Scraper loop is currently paused. Send /start to resume scanning.</b>`
      : '❌ <b>Query deletion cancelled. No search queries were deleted.</b>';

    try {
      await axios.post(`https://api.telegram.org/bot${config.TELEGRAM_TOKEN}/editMessageText`, {
        chat_id,
        message_id,
        text: textMsg,
        parse_mode: 'HTML',
        reply_markup: { inline_keyboard: [] }
      });
    } catch {}

  } else if (action === 'attach_done') {
    const state = activeAttachmentSelections[jobId];
    let attachmentPaths = [];
    if (state && state.selectedIndexes.size > 0) {
      attachmentPaths = Array.from(state.selectedIndexes).map(idx => {
        const fileName = state.files[idx];
        return (state.filePathsMap && state.filePathsMap[fileName]) 
          ? state.filePathsMap[fileName] 
          : path.resolve(__dirname, '..', fileName);
      });
    }
    delete activeAttachmentSelections[jobId];

    console.log(`📎 Attachments selected for Job ID: ${jobId} -> ${attachmentPaths.length} file(s)`);
    submissionQueue.push({ jobId, chat_id, message_id, attachmentPaths });
    await notifyQueueStatus(jobId, chat_id, message_id);

  } else if (action === 'attach_skip' || action === 'attach') {
    delete activeAttachmentSelections[jobId];
    let attachmentPaths = [];
    if (action === 'attach' && extraArg && extraArg !== 'skip') {
      attachmentPaths = [path.resolve(__dirname, '..', extraArg)];
    }
    console.log(`📎 Attachment skipped/single selected for Job ID: ${jobId} -> ${attachmentPaths.length} file(s)`);
    submissionQueue.push({ jobId, chat_id, message_id, attachmentPaths });
    await notifyQueueStatus(jobId, chat_id, message_id);
  }
}

// Helper to notify and trigger queued items
async function notifyQueueStatus(jobId, chat_id, message_id) {
  if (stats.isPaused()) {
    console.log(`📥 Scraper is paused. Job [${jobId}] added to submission queue (will submit when resumed via /start).`);
    try {
      const jobAlert = await db.getJobAlert(jobId);
      const queuedText = buildJobAlertHtml(
        jobAlert || { title: 'Job Alert', queryName: 'Query', link: '#' },
        '⏳ <b>Queued for auto-submission (Bot is paused. Will submit when resumed via /start)...</b>'
      );
      await axios.post(`https://api.telegram.org/bot${config.TELEGRAM_TOKEN}/editMessageText`, {
        chat_id,
        message_id,
        text: queuedText,
        parse_mode: 'HTML'
      });
    } catch (err) {
      console.error('⚠️ Failed to update card to paused queued status:', err.message);
    }
    return;
  }

  if (stats.isScraping()) {
    console.log(`📥 Scraper is active. Job [${jobId}] added to submission queue.`);
    try {
      const jobAlert = await db.getJobAlert(jobId);
      const queuedText = buildJobAlertHtml(jobAlert || { title: 'Job Alert', queryName: 'Query', link: '#' }, '⏳ <b>Queued for auto-submission (waiting for active search run to finish)...</b>');
      await axios.post(`https://api.telegram.org/bot${config.TELEGRAM_TOKEN}/editMessageText`, {
        chat_id,
        message_id,
        text: queuedText,
        parse_mode: 'HTML'
      });
    } catch (err) {
      console.error('⚠️ Failed to update card to queued status:', err.message);
    }
  } else {
    console.log(`📥 Scraper is idle. Job [${jobId}] queued for immediate execution.`);
    try {
      const jobAlert = await db.getJobAlert(jobId);
      const queuedText = buildJobAlertHtml(jobAlert || { title: 'Job Alert', queryName: 'Query', link: '#' }, '⏳ <b>Queued for auto-submission...</b>');
      await axios.post(`https://api.telegram.org/bot${config.TELEGRAM_TOKEN}/editMessageText`, {
        chat_id,
        message_id,
        text: queuedText,
        parse_mode: 'HTML'
      });
    } catch {}
    
    // Trigger execution instantly
    processQueue();
  }
}

async function executeQueuedSubmission(item) {
  const { jobId, chat_id, message_id, attachmentPaths, attachmentPath } = item;
  const pathsToAttach = attachmentPaths || (attachmentPath ? [attachmentPath] : []);
  const fileNames = pathsToAttach.map(p => path.basename(p));
  const attachLabel = fileNames.length > 0 ? fileNames.join(', ') : 'None';

  console.log(`🚀 Executing queued submission for Job ID: ${jobId} (Attachments: ${attachLabel})`);

  let jobAlert;
  try {
    jobAlert = await db.getJobAlert(jobId);
    if (!jobAlert) throw new Error('Job alert details not found.');
    const loadingText = buildJobAlertHtml(jobAlert, '⏳ <b>Preparing automatic submission on Upwork...</b>');

    await axios.post(`https://api.telegram.org/bot${config.TELEGRAM_TOKEN}/editMessageText`, {
      chat_id,
      message_id,
      text: loadingText,
      parse_mode: 'HTML',
      reply_markup: { inline_keyboard: [] }
    });
    // Send a new Telegram message to trigger push notification for start
    await axios.post(`https://api.telegram.org/bot${config.TELEGRAM_TOKEN}/sendMessage`, {
      chat_id,
      text: `🚀 <b>Applying Started:</b> Auto-submitting proposal for <i>"${escapeHtml(jobAlert.title)}"</i>...`,
      parse_mode: 'HTML',
      reply_markup: { remove_keyboard: true }
    });
  } catch (err) {
    console.error('⚠️ Failed to show submission loading status in Telegram:', err.message);
  }

  let browser, page;
  try {
    const connection = await connectCDP();
    bringChromeToFront();
    browser = connection.browser;
    const context = connection.context;
    page = await context.newPage();

    // Launch automated submitter with the selected attachment paths
    const success = await submitProposal(page, jobId, pathsToAttach);

    if (success) {
      await db.updateJobStatus(jobId, 'approved');
      stats.incrementSubmitted(1);
      const updatedJobAlert = await db.getJobAlert(jobId) || jobAlert;
      const successText = buildJobAlertHtml(updatedJobAlert, '✅ <b>Proposal submitted successfully on Upwork!</b>');
      await axios.post(`https://api.telegram.org/bot${config.TELEGRAM_TOKEN}/editMessageText`, {
        chat_id,
        message_id,
        text: successText,
        parse_mode: 'HTML'
      });
      // Send a new Telegram message to trigger push notification for success
      await axios.post(`https://api.telegram.org/bot${config.TELEGRAM_TOKEN}/sendMessage`, {
        chat_id,
        text: `✅ <b>Application Submitted:</b> Proposal for <i>"${escapeHtml(jobAlert.title)}"</i> has been successfully submitted to Upwork!`,
        parse_mode: 'HTML'
      });
    } else {
      throw new Error('Auto-submission failed during form interaction.');
    }
  } catch (err) {
    console.error(`❌ Auto-submission failed for Job [${jobId}]:`, err.message);
    
    const updatedJobAlert = await db.getJobAlert(jobId) || jobAlert;
    const errorText = buildJobAlertHtml(updatedJobAlert, `❌ <b>Submission Failed: ${escapeHtml(err.message)}</b>`);
    try {
      await axios.post(`https://api.telegram.org/bot${config.TELEGRAM_TOKEN}/editMessageText`, {
        chat_id,
        message_id,
        text: errorText,
        parse_mode: 'HTML',
        reply_markup: {
          inline_keyboard: [
            [
              { text: 'Retry Accept ✅', callback_data: `accept:${jobId}` },
              { text: 'Reject ❌', callback_data: `reject:${jobId}` }
            ]
          ]
        }
      });
    } catch {}
    // Send a new Telegram message to trigger push notification for failure
    try {
      await axios.post(`https://api.telegram.org/bot${config.TELEGRAM_TOKEN}/sendMessage`, {
        chat_id,
        text: `❌ <b>Application Failed:</b> Proposal for <i>"${escapeHtml(jobAlert.title)}"</i> failed to submit: ${escapeHtml(err.message)}`,
        parse_mode: 'HTML'
      });
    } catch {}
  } finally {
    if (browser) {
      try {
        await disconnect(browser, page);
      } catch {}
    }
  }
}

async function processQueue() {
  if (isProcessingQueue) return;
  if (stats.isPaused()) {
    console.log('⏸️ Scraper is paused. Queue processing suspended until /start.');
    return;
  }
  isProcessingQueue = true;

  try {
    while (submissionQueue.length > 0) {
      if (stats.isPaused()) {
        console.log('⏸️ Queue processing suspended because bot has been paused.');
        break;
      }

      // If a search run starts while we are processing, we should pause!
      if (stats.isScraping()) {
        console.log('⏸️ Pausing queue processing because a search run has started...');
        break;
      }

      const item = submissionQueue.shift();
      await executeQueuedSubmission(item);
      
      // Pace consecutive submissions (random 60-120s delay)
      if (submissionQueue.length > 0 && !stats.isScraping() && !stats.isPaused()) {
        const delay = Math.round(60 + Math.random() * 60);
        console.log(`⏳ Queue Pacing: Waiting ${delay} seconds before processing the next item...`);
        await new Promise(r => setTimeout(r, delay * 1000));
      }
    }
  } finally {
    isProcessingQueue = false;
  }
}

async function handleTextMessage(message) {
  const chat_id = message.chat.id;
  const text = message.text;

  // Security check: Only allow authorized users to control
  const isAuthorized = await db.isUserAuthorized(chat_id);
  if (!isAuthorized) {
    try {
      const pendingRequest = await db.getPendingAccessRequest(chat_id);
      if (pendingRequest) {
        await axios.post(`https://api.telegram.org/bot${config.TELEGRAM_TOKEN}/sendMessage`, {
          chat_id,
          text: '⏳ <b>Access Request Pending:</b>\n\nYour access request is still waiting for approval from the bot owner.',
          parse_mode: 'HTML'
        });
      } else {
        const username = message.from.username || message.from.first_name || 'Unknown';
        await db.createPendingAccessRequest(chat_id, username);
        
        await axios.post(`https://api.telegram.org/bot${config.TELEGRAM_TOKEN}/sendMessage`, {
          chat_id,
          text: '📥 <b>Access Request Sent:</b>\n\nYour request has been forwarded to the bot owner. You will be notified once they approve your access.',
          parse_mode: 'HTML'
        });

        // Notify the master owner
        await axios.post(`https://api.telegram.org/bot${config.TELEGRAM_TOKEN}/sendMessage`, {
          chat_id: config.CHAT_ID,
          text: `🔔 <b>New Access Request:</b>\n\n<b>User:</b> @${escapeHtml(username)} (${message.from.first_name || ''})\n<b>Chat ID:</b> <code>${chat_id}</code>\n\nWould you like to authorize this user to access the bot, receive notifications, and submit proposals?`,
          parse_mode: 'HTML',
          reply_markup: {
            inline_keyboard: [
              [
                { text: '✅ Approve Access', callback_data: `access_approve:${chat_id}` },
                { text: '❌ Deny Access', callback_data: `access_deny:${chat_id}` }
              ]
            ]
          }
        });
      }
    } catch (err) {
      console.error('❌ Failed to handle unauthorized user message:', err.message);
    }
    return;
  }

  lastInteractionTime = Date.now();

  // ---- Multi-account dynamic userStates interceptor ----
  if (userStates[chat_id]) {
    const state = userStates[chat_id];
    state.timestamp = Date.now();

    // 1. Awaiting email during onboarding
    if (state.action === 'awaiting_email') {
      state.email = text.trim();
      state.action = 'awaiting_password';
      try {
        await axios.post(`https://api.telegram.org/bot${config.TELEGRAM_TOKEN}/sendMessage`, {
          chat_id,
          text: '🔒 <b>Email received! Now send me the Upwork Password:</b>',
          parse_mode: 'HTML'
        });
      } catch {}
      return;
    }

    // 2. Awaiting password during onboarding
    if (state.action === 'awaiting_password') {
      state.password = text.trim();
      state.action = 'awaiting_name';
      try {
        await axios.post(`https://api.telegram.org/bot${config.TELEGRAM_TOKEN}/sendMessage`, {
          chat_id,
          text: '👤 <b>Password received! Now send me the Freelancer Display Name:</b>\n(e.g., Gyanesh Shukla)',
          parse_mode: 'HTML'
        });
      } catch {}
      return;
    }

    // 3. Awaiting name during onboarding
    if (state.action === 'awaiting_name') {
      state.name = text.trim();
      state.action = 'awaiting_min_budget';
      try {
        await axios.post(`https://api.telegram.org/bot${config.TELEGRAM_TOKEN}/sendMessage`, {
          chat_id,
          text: '💰 <b>Name received! Now send me the Minimum Job Budget limit in USD (e.g. 100 or 500):</b>',
          parse_mode: 'HTML'
        });
      } catch {}
      return;
    }

    // 3.1 Awaiting min budget during onboarding
    if (state.action === 'awaiting_min_budget') {
      const amount = parseInt(text.trim(), 10);
      if (isNaN(amount) || amount < 0) {
        try {
          await axios.post(`https://api.telegram.org/bot${config.TELEGRAM_TOKEN}/sendMessage`, {
            chat_id,
            text: '❌ <b>Invalid amount:</b> Please send a valid number (e.g. 100 or 500):',
            parse_mode: 'HTML'
          });
        } catch {}
        return;
      }
      state.minBudget = amount;
      state.action = 'awaiting_max_connects';
      try {
        await axios.post(`https://api.telegram.org/bot${config.TELEGRAM_TOKEN}/sendMessage`, {
          chat_id,
          text: '💳 <b>Minimum budget saved! Now send me the Maximum Connects Limit (e.g. 16 or 8) or send <code>none</code> to disable the limit:</b>',
          parse_mode: 'HTML'
        });
      } catch {}
      return;
    }

    // 3.2 Awaiting max connects during onboarding
    if (state.action === 'awaiting_max_connects') {
      const input = text.trim().toLowerCase();
      let limit = null;
      if (input !== 'none') {
        const amount = parseInt(input, 10);
        if (isNaN(amount) || amount <= 0) {
          try {
            await axios.post(`https://api.telegram.org/bot${config.TELEGRAM_TOKEN}/sendMessage`, {
              chat_id,
              text: '❌ <b>Invalid limit:</b> Please send a valid number (e.g. 8 or 16) or <code>none</code>:',
              parse_mode: 'HTML'
            });
          } catch {}
          return;
        }
        limit = amount;
      }
      state.maxConnectsLimit = limit;
      state.action = 'awaiting_resume';
      try {
        await axios.post(`https://api.telegram.org/bot${config.TELEGRAM_TOKEN}/sendMessage`, {
          chat_id,
          text: '📄 <b>Connects limit saved! Finally, upload/attach the PDF resume for this account:</b>\n(Bot will parse it and generate the default search queries and keywords automatically)',
          parse_mode: 'HTML'
        });
      } catch {}
      return;
    }

    // 4. Awaiting 2FA code submission
    if (state.action === 'awaiting_2fa') {
      const code = text.trim();
      authSignals.emit('2fa-code-received', { code });
      delete userStates[chat_id];
      try {
        await axios.post(`https://api.telegram.org/bot${config.TELEGRAM_TOKEN}/sendMessage`, {
          chat_id,
          text: '⏳ <b>Verification code received. Submitting login...</b>',
          parse_mode: 'HTML'
        });
      } catch {}
      return;
    }

    // 5. Awaiting dynamic login credentials prompt
    if (state.action === 'awaiting_login_creds') {
      const input = text.trim();
      if (input === '/env' || input.toLowerCase() === 'env') {
        authSignals.emit('login-credentials-received', { fallback: true });
        delete userStates[chat_id];
        try {
          await axios.post(`https://api.telegram.org/bot${config.TELEGRAM_TOKEN}/sendMessage`, {
            chat_id,
            text: '⏳ <b>Using default credentials from configuration...</b>',
            parse_mode: 'HTML'
          });
        } catch {}
        return;
      }

      const parts = input.split('|');
      if (parts.length >= 2) {
        const email = parts[0].trim();
        const password = parts.slice(1).join('|').trim();
        
        authSignals.emit('login-credentials-received', { email, password });
        delete userStates[chat_id];

        try {
          await axios.post(`https://api.telegram.org/bot${config.TELEGRAM_TOKEN}/sendMessage`, {
            chat_id,
            text: `⏳ <b>Credentials received. Attempting login as "${escapeHtml(email)}"...</b>`,
            parse_mode: 'HTML'
          });
        } catch {}
      } else {
        try {
          await axios.post(`https://api.telegram.org/bot${config.TELEGRAM_TOKEN}/sendMessage`, {
            chat_id,
            text: '❌ <b>Invalid Format:</b> Please send credentials as <code>email | password</code>, or send <b>/env</b> to fallback:',
            parse_mode: 'HTML'
          });
        } catch {}
      }
      return;
    }

    // 6. Awaiting security question answer
    if (state.action === 'awaiting_security_answer') {
      const answer = text.trim();
      authSignals.emit('security-answer-received', { answer });
      delete userStates[chat_id];
      try {
        await axios.post(`https://api.telegram.org/bot${config.TELEGRAM_TOKEN}/sendMessage`, {
          chat_id,
          text: '⏳ <b>Security answer received. Submitting verification...</b>',
          parse_mode: 'HTML'
        });
      } catch {}
      return;
    }
  }

  // ---- Multi-step conversation state interceptor ----
  if (conversationState[chat_id] && text && !text.startsWith('/')) {
    const state = conversationState[chat_id];
    state.timestamp = Date.now();

    if (state.flow === 'addproject') {
      if (state.step === 'url') {
        state.data.url = text.trim();
        state.step = 'name';
        try {
          await axios.post(`https://api.telegram.org/bot${config.TELEGRAM_TOKEN}/sendMessage`, {
            chat_id,
            text: '✅ Got it! Now send me the <b>project name</b>:',
            parse_mode: 'HTML'
          });
        } catch {}
        return;
      }
      if (state.step === 'name') {
        state.data.name = text.trim();
        state.step = 'description';
        try {
          await axios.post(`https://api.telegram.org/bot${config.TELEGRAM_TOKEN}/sendMessage`, {
            chat_id,
            text: '✅ Got it! Now send a <b>short description</b> of this project (or send <b>skip</b> to skip):',
            parse_mode: 'HTML'
          });
        } catch {}
        return;
      }
      if (state.step === 'description') {
        if (text.trim().toLowerCase() !== 'skip') {
          state.data.description = text.trim();
        }
        // Save the project
        const r = config.loadAndGetRules();
        if (!r.portfolio_projects) r.portfolio_projects = [];
        r.portfolio_projects.push(state.data);
        const success = config.saveRules(r);
        delete conversationState[chat_id];
        flushPendingAlerts();

        try {
          await axios.post(`https://api.telegram.org/bot${config.TELEGRAM_TOKEN}/sendMessage`, {
            chat_id,
            text: success
              ? `✅ <b>Project added successfully!</b>\n\n📌 <b>${escapeHtml(state.data.name)}</b>\n🔗 ${escapeHtml(state.data.url)}${state.data.description ? '\n📝 ' + escapeHtml(state.data.description) : ''}\n\nTotal portfolio projects: ${r.portfolio_projects.length}\nSend /addproject to add more or /projects to view all.`
              : '❌ Failed to save project.',
            parse_mode: 'HTML'
          });
        } catch {}
        return;
      }
    }

    if (state.flow === 'setbudget') {
      const amount = parseInt(text.trim(), 10);
      if (isNaN(amount) || amount < 0) {
        try {
          await axios.post(`https://api.telegram.org/bot${config.TELEGRAM_TOKEN}/sendMessage`, {
            chat_id,
            text: '❌ <b>Invalid Budget Amount:</b> Please send a valid number (e.g. 500 or 1500):',
            parse_mode: 'HTML'
          });
        } catch {}
        return;
      }

      const r = config.getRawRules();
      r.min_budget = amount;
      const success = config.saveRules(r);
      if (success) {
        stats.setPaused(false);
        try {
          const { triggerScrapeRun } = require('../scraper-bot');
          triggerScrapeRun();
        } catch {}
      }
      delete conversationState[chat_id];
      flushPendingAlerts();

      try {
        await axios.post(`https://api.telegram.org/bot${config.TELEGRAM_TOKEN}/sendMessage`, {
          chat_id,
          text: success
            ? `✅ <b>Minimum budget updated to $${amount}!</b>\n\n⚡ <i>Scraper is active! Search runs will continue automatically in the background.</i>`
            : '❌ Failed to save new rules configuration.',
          parse_mode: 'HTML'
        });
      } catch {}
      return;
    }

    if (state.flow === 'setconnects') {
      const input = text.trim().toLowerCase();
      let limit = null;
      let isDisable = false;

      if (input === 'none' || input === 'off' || input === 'disable') {
        isDisable = true;
      } else {
        limit = parseInt(input, 10);
        if (isNaN(limit) || limit <= 0) {
          try {
            await axios.post(`https://api.telegram.org/bot${config.TELEGRAM_TOKEN}/sendMessage`, {
              chat_id,
              text: '❌ <b>Invalid Connects Limit:</b> Please send a valid integer number (e.g. 16) or send <b>none</b> to disable:',
              parse_mode: 'HTML'
            });
          } catch {}
          return;
        }
      }

      const r = config.getRawRules();
      if (isDisable) {
        delete r.max_connects_limit;
      } else {
        r.max_connects_limit = limit;
      }
      const success = config.saveRules(r);
      if (success) {
        stats.setPaused(false);
        try {
          const { triggerScrapeRun } = require('../scraper-bot');
          triggerScrapeRun();
        } catch {}
      }
      delete conversationState[chat_id];
      flushPendingAlerts();

      try {
        await axios.post(`https://api.telegram.org/bot${config.TELEGRAM_TOKEN}/sendMessage`, {
          chat_id,
          text: success
            ? (isDisable
                ? '✅ <b>Max connects limit disabled!</b>\n\n⚡ <i>Scraper is active! Search runs will continue automatically in the background.</i>'
                : `✅ <b>Max connects limit set to ${limit} Connects!</b>\n\n⚡ <i>Scraper is active! Search runs will continue automatically in the background.</i>`)
            : '❌ Failed to save new rules configuration.',
          parse_mode: 'HTML'
        });
      } catch {}
      return;
    }

    if (state.flow === 'addquery') {
      const query = text.trim();
      if (!query) {
        try {
          await axios.post(`https://api.telegram.org/bot${config.TELEGRAM_TOKEN}/sendMessage`, {
            chat_id,
            text: '❌ <b>Query cannot be empty.</b> Please send a search query keyword:',
            parse_mode: 'HTML'
          });
        } catch {}
        return;
      }

      const r = config.getRawRules();
      if (!r.search_queries) r.search_queries = [];
      r.search_queries.push(query);
      const success = config.saveRules(r);
      if (success) {
        stats.setPaused(false);
        try {
          const { triggerScrapeRun } = require('../scraper-bot');
          triggerScrapeRun();
        } catch {}
      }
      delete conversationState[chat_id];
      flushPendingAlerts();

      try {
        await axios.post(`https://api.telegram.org/bot${config.TELEGRAM_TOKEN}/sendMessage`, {
          chat_id,
          text: success
            ? `✅ <b>Added search query: "${escapeHtml(query)}"!</b>\n\n⚡ <i>Scraper is active! Search runs will continue automatically in the background.</i>`
            : '❌ Failed to save new rules configuration.',
          parse_mode: 'HTML'
        });
      } catch {}
      return;
    }
  }

  // If user sends a command, cancel any active conversation flow
  if (text && text.startsWith('/') && conversationState[chat_id]) {
    delete conversationState[chat_id];
    flushPendingAlerts();
  }

  // Analytics command
  if (text === '/analytics') {
    const analytics = await db.getAnalyticsSummary();
    if (!analytics) {
      try {
        await axios.post(`https://api.telegram.org/bot${config.TELEGRAM_TOKEN}/sendMessage`, {
          chat_id,
          text: '📊 <b>Analytics Unavailable:</b> Could not connect to database.',
          parse_mode: 'HTML'
        });
      } catch {}
      return;
    }

    const queryList = analytics.queryBreakdown.map(q => `• <b>${escapeHtml(q._id || 'Unknown')}:</b> ${q.count} job(s)`).join('\n');

    const message = [
      '📊 <b>Upwork Assistant - Analytics Dashboard</b>',
      '━━━━━━━━━━━━━━━━━━━━',
      `🎯 <b>Total Matched Job Alerts:</b> ${analytics.totalAlerts}`,
      `✅ <b>Proposals Approved / Submitted:</b> ${analytics.approvedCount}`,
      `❌ <b>Proposals Rejected:</b> ${analytics.rejectedCount}`,
      `⏳ <b>Pending Review:</b> ${analytics.pendingCount}`,
      `📈 <b>Acceptance Rate:</b> ${analytics.conversionRate}%`,
      '━━━━━━━━━━━━━━━━━━━━',
      `🔥 <b>Top Performing Search Queries:</b>`,
      queryList || 'No data yet.'
    ].join('\n');

    try {
      await axios.post(`https://api.telegram.org/bot${config.TELEGRAM_TOKEN}/sendMessage`, {
        chat_id,
        text: message,
        parse_mode: 'HTML'
      });
    } catch {}
    return;
  }

  // Intercept accounts manager command
  if (text === '/accounts') {
    try {
      const accounts = await db.getAccounts();
      const activeEmail = config.activeAccountEmail;
      
      let message = '📂 <b>Upwork Accounts Manager</b>\n';
      message += '━━━━━━━━━━━━━━━━━━━━\n';
      
      if (accounts.length === 0) {
        message += '<i>No accounts registered. Use the button below to add your first account!</i>\n';
      } else {
        accounts.forEach((acc) => {
          const isActive = acc.email === activeEmail || (activeEmail === null && acc.isActive);
          message += `${isActive ? '🟢' : '⚪'} <b>${escapeHtml(acc.name)}</b>\n<code>${escapeHtml(acc.email)}</code>\n\n`;
        });
      }
      message += '━━━━━━━━━━━━━━━━━━━━';
      
      const inlineKeyboard = {
        inline_keyboard: [
          [
            { text: '➕ Add Account', callback_data: 'accounts_add' }
          ]
        ]
      };
      
      if (accounts.length > 0) {
        inlineKeyboard.inline_keyboard.push(
          [
            { text: '🔄 Switch Account', callback_data: 'accounts_list_switch' },
            { text: '❌ Delete Account', callback_data: 'accounts_list_delete' }
          ]
        );
      }
      
      await axios.post(`https://api.telegram.org/bot${config.TELEGRAM_TOKEN}/sendMessage`, {
        chat_id,
        text: message,
        parse_mode: 'HTML',
        reply_markup: inlineKeyboard
      });
    } catch (err) {
      console.error('⚠️ Failed to send accounts dashboard:', err.message);
    }
    return;
  }

  // Intercept authorized users manager command
  if (text === '/users') {
    try {
      if (chat_id.toString() !== config.CHAT_ID.toString()) {
        await axios.post(`https://api.telegram.org/bot${config.TELEGRAM_TOKEN}/sendMessage`, {
          chat_id,
          text: '❌ <b>Access Denied:</b> Only the primary owner can manage authorized users.',
          parse_mode: 'HTML'
        });
        return;
      }

      const users = await db.getAuthorizedUsersDetailed();
      const otherUsers = users.filter(u => u.chatId.toString() !== config.CHAT_ID.toString());
      const revokedUsers = await db.getRevokedUsersDetailed();

      if (otherUsers.length === 0 && revokedUsers.length === 0) {
        await axios.post(`https://api.telegram.org/bot${config.TELEGRAM_TOKEN}/sendMessage`, {
          chat_id,
          text: '👥 <b>Authorized Users:</b>\n\nNo secondary users have been authorized yet, and no history is available.',
          parse_mode: 'HTML'
        });
        return;
      }

      let message = '';
      const inlineKeyboard = { inline_keyboard: [] };

      if (otherUsers.length === 0) {
        message = '👥 <b>Authorized Users</b>\n\nNo active secondary users are authorized.';
      } else {
        message = `👥 <b>Authorized Users (${otherUsers.length}):</b>\n\nSelect a user to revoke their access:\n━━━━━━━━━━━━━━━━━━━━\n`;
        otherUsers.forEach((u, i) => {
          message += `${i + 1}. 👤 @${escapeHtml(u.username)} (<code>${u.chatId}</code>)\n`;
        });
        message += '━━━━━━━━━━━━━━━━━━━━';

        otherUsers.forEach(u => {
          inlineKeyboard.inline_keyboard.push([
            { text: `🗑️ Revoke @${u.username}`, callback_data: `access_revoke:${u.chatId}` }
          ]);
        });
      }

      if (revokedUsers.length > 0) {
        inlineKeyboard.inline_keyboard.push([
          { text: '➕ Re-Authorize Revoked User', callback_data: 'access_grant_list' }
        ]);
      }

      await axios.post(`https://api.telegram.org/bot${config.TELEGRAM_TOKEN}/sendMessage`, {
        chat_id,
        text: message,
        parse_mode: 'HTML',
        reply_markup: inlineKeyboard
      });
    } catch (err) {
      console.error('⚠️ Failed to send users management dashboard:', err.message);
    }
    return;
  }

  // Intercept silent access grant command
  if (text.startsWith('/grant')) {
    try {
      if (chat_id.toString() !== config.CHAT_ID.toString()) {
        await axios.post(`https://api.telegram.org/bot${config.TELEGRAM_TOKEN}/sendMessage`, {
          chat_id,
          text: '❌ <b>Access Denied:</b> Only the primary owner can grant access.',
          parse_mode: 'HTML'
        });
        return;
      }

      const args = text.split(/\s+/).slice(1);
      const targetChatId = args[0];
      const targetUsername = args[1] || 'Unknown';

      if (!targetChatId) {
        const revoked = await db.getRevokedUsersDetailed();
        if (revoked.length === 0) {
          await axios.post(`https://api.telegram.org/bot${config.TELEGRAM_TOKEN}/sendMessage`, {
            chat_id,
            text: '👥 <b>Re-Authorize Users:</b>\n\nNo revoked or denied users found in history.',
            parse_mode: 'HTML'
          });
          return;
        }

        let message = '👥 <b>Re-Authorize Users:</b>\n\nSelect a user to grant them access silently:\n━━━━━━━━━━━━━━━━━━━━\n';
        revoked.forEach((u, i) => {
          message += `${i + 1}. 👤 @${escapeHtml(u.username)} (<code>${u.chatId}</code>)\n`;
        });
        message += '━━━━━━━━━━━━━━━━━━━━';

        const inlineKeyboard = {
          inline_keyboard: revoked.map(u => [
            { text: `➕ Grant @${u.username}`, callback_data: `access_grant_user:${u.chatId}` }
          ])
        };

        await axios.post(`https://api.telegram.org/bot${config.TELEGRAM_TOKEN}/sendMessage`, {
          chat_id,
          text: message,
          parse_mode: 'HTML',
          reply_markup: inlineKeyboard
        });
        return;
      }

      if (isNaN(targetChatId)) {
        await axios.post(`https://api.telegram.org/bot${config.TELEGRAM_TOKEN}/sendMessage`, {
          chat_id,
          text: '⚠️ <b>Invalid Syntax:</b> Please use <code>/grant [chat_id] [username]</code>\n\nExample: <code>/grant 1767753057 Sup_riya1031</code>',
          parse_mode: 'HTML'
        });
        return;
      }

      await db.addAuthorizedUser(targetChatId, targetUsername);

      await axios.post(`https://api.telegram.org/bot${config.TELEGRAM_TOKEN}/sendMessage`, {
        chat_id,
        text: `✅ <b>Access Granted Silently:</b> @${escapeHtml(targetUsername)} (<code>${targetChatId}</code>) has been authorized. No notification was sent to them.`,
        parse_mode: 'HTML'
      });
    } catch (err) {
      console.error('⚠️ Failed to grant silent access:', err.message);
    }
    return;
  }

  // Intercept diagnostics status dashboard command
  if (text === '/status') {
    const currentStats = stats.getStats();
    const uptimeMs = Date.now() - currentStats.startTime;
    
    const uptimeSec = Math.floor(uptimeMs / 1000);
    const d = Math.floor(uptimeSec / (3600*24));
    const h = Math.floor((uptimeSec % (3600*24)) / 3600);
    const m = Math.floor((uptimeSec % 3600) / 60);
    
    const uptimeStr = [
      d > 0 ? `${d}d` : '',
      h > 0 ? `${h}h` : '',
      `${m}m`
    ].filter(Boolean).join(' ');

    const connectsText = currentStats.lastCheckedConnects !== null 
      ? `${currentStats.lastCheckedConnects} Connects` 
      : 'Unknown (Check on next bid)';

    const dashboard = [
      '📊 <b>Upwork Bot Status Dashboard</b>',
      '━━━━━━━━━━━━━━━━━━━━',
      `🟢 <b>Status:</b> Running`,
      `⏱️ <b>Uptime:</b> ${uptimeStr}`,
      `🔎 <b>Jobs Scanned:</b> ${currentStats.jobsScanned}`,
      `🎯 <b>Matches Found:</b> ${currentStats.matchesFound}`,
      `✅ <b>Proposals Submitted:</b> ${currentStats.proposalsSubmitted}`,
      `❌ <b>Proposals Rejected:</b> ${currentStats.proposalsRejected}`,
      `💳 <b>Available Connects:</b> ${connectsText}`,
      `💤 <b>Sleep Schedule:</b> ${config.SLEEP_START_HOUR}:00 - ${config.SLEEP_END_HOUR}:00`,
      '━━━━━━━━━━━━━━━━━━━━'
    ].join('\n');

    try {
      await axios.post(`https://api.telegram.org/bot${config.TELEGRAM_TOKEN}/sendMessage`, {
        chat_id,
        text: dashboard,
        parse_mode: 'HTML'
      });
    } catch (err) {
      console.error('⚠️ Failed to send Telegram status dashboard:', err.message);
    }
    return;
  }

  // Intercept scraper loop pause command
  if (text === '/pause') {
    stats.setPaused(true);
    try {
      await axios.post(`https://api.telegram.org/bot${config.TELEGRAM_TOKEN}/sendMessage`, {
        chat_id,
        text: '⏸️ <b>Scraper paused successfully!</b>\n\nUpwork search cycles are suspended.' + PAUSE_SIGNAL_HTML,
        parse_mode: 'HTML'
      });
    } catch {}
    return;
  }

  // Intercept scraper loop resume/start commands
  if (text === '/resume_scraper' || text === '/resume' || text === '/start') {
    // If the text is exactly "/resume" we show resume info, unless they meant resume_scraper
    if (text === '/resume') {
      stats.setPaused(true);
      try {
        await axios.post(`https://api.telegram.org/bot${config.TELEGRAM_TOKEN}/sendMessage`, {
          chat_id,
          text: `📄 <b>Freelancer Profile Info:</b>\n\n• <b>Freelancer Name:</b> ${config.FREELANCER_NAME || 'Unknown'}\n\n💡 <i>To upload a new PDF resume and regenerate all scraping rules, simply attach/upload a <b>.pdf</b> file directly to this chat window.</i>` + PAUSE_SIGNAL_HTML,
          parse_mode: 'HTML'
        });
      } catch {}
      return;
    }

    stats.setPaused(false);
    try {
      await axios.post(`https://api.telegram.org/bot${config.TELEGRAM_TOKEN}/sendMessage`, {
        chat_id,
        text: '⚡ <b>Scraper loop activated!</b>\n\nTriggering an Upwork search run immediately in the background...',
        parse_mode: 'HTML'
      });
    } catch {}

    // Trigger scraper run instantly
    try {
      const { triggerScrapeRun } = require('../scraper-bot');
      triggerScrapeRun();
    } catch (err) {
      console.error('⚠️ Failed to manually trigger scrape run:', err.message);
    }
    return;
  }

  if (text === '/rules') {
    const messageContent = buildRulesConfigHtml();
    try {
      await axios.post(`https://api.telegram.org/bot${config.TELEGRAM_TOKEN}/sendMessage`, {
        chat_id,
        text: messageContent,
        parse_mode: 'HTML'
      });
    } catch {}
    return;
  }

  // Intercept updateresume command to prompt for new PDF resume upload
  if (text === '/updateresume') {
    userStates[chat_id] = { action: 'awaiting_resume', timestamp: Date.now() };
    try {
      await axios.post(`https://api.telegram.org/bot${config.TELEGRAM_TOKEN}/sendMessage`, {
        chat_id,
        text: '📤 <b>Upload New Resume:</b> Please send/attach your new resume PDF file directly to this chat now. The bot will automatically parse the PDF, update your freelancer profile, and regenerate your scraping rules.',
        parse_mode: 'HTML'
      });
    } catch {}
    return;
  }

  // Intercept setbudget command
  if (text === '/setbudget' || (text && text.startsWith('/setbudget'))) {
    const args = text.replace('/setbudget', '').trim();
    if (!args) {
      const r = config.getRawRules();
      conversationState[chat_id] = { flow: 'setbudget', timestamp: Date.now() };
      try {
        await axios.post(`https://api.telegram.org/bot${config.TELEGRAM_TOKEN}/sendMessage`, {
          chat_id,
          text: `💰 <b>Set Minimum Job Budget</b>\nCurrent budget: <b>$${r.min_budget || 0}</b>\n\nSend me the new minimum budget amount in USD (e.g. 500 or 1500):`,
          parse_mode: 'HTML'
        });
      } catch {}
      return;
    }

    const amount = parseInt(args, 10);
    if (isNaN(amount) || amount < 0) {
      try {
        await axios.post(`https://api.telegram.org/bot${config.TELEGRAM_TOKEN}/sendMessage`, {
          chat_id,
          text: '❌ <b>Invalid Budget Amount:</b> Please send a valid number (e.g. <code>/setbudget 1500</code>):',
          parse_mode: 'HTML'
        });
      } catch {}
      return;
    }

    const r = config.getRawRules();
    r.min_budget = amount;
    const success = config.saveRules(r);
    if (success) stats.setPaused(true);
    
    try {
      await axios.post(`https://api.telegram.org/bot${config.TELEGRAM_TOKEN}/sendMessage`, {
        chat_id,
        text: success 
          ? `✅ <b>Minimum budget updated to $${amount}!</b>\n\n⏸️ <b>Scraper has been paused automatically while you edit rules. Send /start to resume scanning.</b>` 
          : '❌ Failed to save new rules configuration.',
        parse_mode: 'HTML'
      });
    } catch {}
    return;
  }

  // Intercept setconnects command
  if (text === '/setconnects' || (text && text.startsWith('/setconnects'))) {
    const args = text.replace('/setconnects', '').trim();
    if (!args) {
      const r = config.getRawRules();
      conversationState[chat_id] = { flow: 'setconnects', timestamp: Date.now() };
      try {
        await axios.post(`https://api.telegram.org/bot${config.TELEGRAM_TOKEN}/sendMessage`, {
          chat_id,
          text: `💳 <b>Set Max Connects Limit</b>\nCurrent limit: <b>${r.max_connects_limit || 'None'} Connects</b>\n\nSend me the new max connects warning limit (e.g. 16) or send <b>none</b> to disable:`,
          parse_mode: 'HTML'
        });
      } catch {}
      return;
    }

    if (args.toLowerCase() === 'none' || args.toLowerCase() === 'off' || args.toLowerCase() === 'disable') {
      const r = config.getRawRules();
      delete r.max_connects_limit;
      const success = config.saveRules(r);
      if (success) stats.setPaused(true);
      try {
        await axios.post(`https://api.telegram.org/bot${config.TELEGRAM_TOKEN}/sendMessage`, {
          chat_id,
          text: success 
            ? '✅ <b>Max connects limit disabled!</b>\n\n⏸️ <b>Scraper has been paused automatically. Send /start to resume scanning.</b>' 
            : '❌ Failed to save new rules configuration.',
          parse_mode: 'HTML'
        });
      } catch {}
      return;
    }

    const limit = parseInt(args, 10);
    if (isNaN(limit) || limit <= 0) {
      try {
        await axios.post(`https://api.telegram.org/bot${config.TELEGRAM_TOKEN}/sendMessage`, {
          chat_id,
          text: '❌ <b>Usage:</b> Send a number (e.g. <code>/setconnects 16</code>) or <code>/setconnects none</code>',
          parse_mode: 'HTML'
        });
      } catch {}
      return;
    }

    const r = config.getRawRules();
    r.max_connects_limit = limit;
    const success = config.saveRules(r);
    if (success) stats.setPaused(true);
    
    try {
      await axios.post(`https://api.telegram.org/bot${config.TELEGRAM_TOKEN}/sendMessage`, {
        chat_id,
        text: success 
          ? `✅ <b>Max connects limit set to ${limit}!</b>\n\n⏸️ <b>Scraper has been paused automatically. Send /start to resume scanning.</b>` 
          : '❌ Failed to save new rules configuration.',
        parse_mode: 'HTML'
      });
    } catch {}
    return;
  }

  // Intercept addquery command
  if (text === '/addquery' || (text && text.startsWith('/addquery'))) {
    const query = text.replace('/addquery', '').trim();
    if (!query) {
      conversationState[chat_id] = { flow: 'addquery', timestamp: Date.now() };
      try {
        await axios.post(`https://api.telegram.org/bot${config.TELEGRAM_TOKEN}/sendMessage`, {
          chat_id,
          text: '🔎 <b>Add New Search Query</b>\n\nSend me the search keyword/query you want to scan for (e.g. <code>flutter developer</code> or <code>next.js</code>):',
          parse_mode: 'HTML'
        });
      } catch {}
      return;
    }

    const r = config.getRawRules();
    if (!r.search_queries) r.search_queries = [];
    if (r.search_queries.map(q => q.toLowerCase()).includes(query.toLowerCase())) {
      try {
        await axios.post(`https://api.telegram.org/bot${config.TELEGRAM_TOKEN}/sendMessage`, {
          chat_id,
          text: `⚠️ <b>"${escapeHtml(query)}" is already in your search queries list!</b>`,
          parse_mode: 'HTML'
        });
      } catch {}
      return;
    }

    r.search_queries.push(query);
    const success = config.saveRules(r);
    if (success) stats.setPaused(true);
    
    try {
      await axios.post(`https://api.telegram.org/bot${config.TELEGRAM_TOKEN}/sendMessage`, {
        chat_id,
        text: success 
          ? `✅ <b>Added search query: "${escapeHtml(query)}"!</b>\n\n⏸️ <b>Scraper has been paused automatically while you edit rules. Send /start to resume scanning.</b>` 
          : '❌ Failed to save new rules configuration.',
        parse_mode: 'HTML'
      });
    } catch {}
    return;
  }

  // Intercept delquery command
  if (text === '/delquery' || (text && text.startsWith('/delquery'))) {
    const query = text.replace('/delquery', '').trim();
    const r = config.getRawRules();
    const queries = r.search_queries || [];

    if (queries.length === 0) {
      try {
        await axios.post(`https://api.telegram.org/bot${config.TELEGRAM_TOKEN}/sendMessage`, {
          chat_id,
          text: '🔎 <b>No search queries configured to delete.</b>\n\nUse /addquery to add search queries.',
          parse_mode: 'HTML'
        });
      } catch {}
      return;
    }

    if (!query) {
      const reply_markup = buildDeleteQueriesKeyboard();
      try {
        await axios.post(`https://api.telegram.org/bot${config.TELEGRAM_TOKEN}/sendMessage`, {
          chat_id,
          text: `🗑️ <b>Select a search query to delete:</b>\nTotal queries: ${queries.length}`,
          parse_mode: 'HTML',
          reply_markup
        });
      } catch {}
      return;
    }

    const index = queries.findIndex(q => q.toLowerCase() === query.toLowerCase());
    if (index === -1) {
      try {
        await axios.post(`https://api.telegram.org/bot${config.TELEGRAM_TOKEN}/sendMessage`, {
          chat_id,
          text: `⚠️ <b>"${escapeHtml(query)}" was not found in your search queries list!</b>`,
          parse_mode: 'HTML'
        });
      } catch {}
      return;
    }

    const deletedQuery = queries[index];
    queries.splice(index, 1);
    const success = config.saveRules(r);
    if (success) stats.setPaused(true);
    
    try {
      await axios.post(`https://api.telegram.org/bot${config.TELEGRAM_TOKEN}/sendMessage`, {
        chat_id,
        text: success 
          ? `✅ <b>Deleted search query: "${escapeHtml(deletedQuery)}"!</b>\n\n⏸️ <b>Scraper has been paused automatically while you edit rules. Send /start to resume scanning.</b>` 
          : '❌ Failed to save new rules configuration.',
        parse_mode: 'HTML'
      });
    } catch {}
    return;
  }

  // Portfolio project management commands
  if (text === '/projects') {
    const projects = config.PORTFOLIO_PROJECTS;
    if (projects.length === 0) {
      try {
        await axios.post(`https://api.telegram.org/bot${config.TELEGRAM_TOKEN}/sendMessage`, {
          chat_id,
          text: '📂 <b>No portfolio projects configured.</b>\n\nUse /addproject to add projects:\n<code>/addproject ProjectName | https://example.com | Short description</code>',
          parse_mode: 'HTML'
        });
      } catch {}
      return;
    }
    const list = projects.map((p, i) => `${i + 1}. <b>${escapeHtml(p.name)}</b>\n   ${escapeHtml(p.url)}${p.description ? '\n   ' + escapeHtml(p.description) : ''}`).join('\n\n');
    try {
      await axios.post(`https://api.telegram.org/bot${config.TELEGRAM_TOKEN}/sendMessage`, {
        chat_id,
        text: `📂 <b>Portfolio Projects (${projects.length}):</b>\n\n${list}\n\nUse /addproject or /delproject to manage.`,
        parse_mode: 'HTML'
      });
    } catch {}
    return;
  }

  if (text === '/addproject') {
    // Start interactive multi-step flow
    conversationState[chat_id] = { flow: 'addproject', step: 'url', data: {}, timestamp: Date.now() };
    try {
      await axios.post(`https://api.telegram.org/bot${config.TELEGRAM_TOKEN}/sendMessage`, {
        chat_id,
        text: '📂 <b>Add Portfolio Project</b>\n\nStep 1/3: Send me the <b>project URL</b> (e.g., https://myproject.com):',
        parse_mode: 'HTML'
      });
    } catch {}
    return;
  }

  if (text === '/delproject' || (text && text.startsWith('/delproject'))) {
    const projectNameArg = text.replace('/delproject', '').trim();
    const projects = config.PORTFOLIO_PROJECTS;

    if (!projects || projects.length === 0) {
      try {
        await axios.post(`https://api.telegram.org/bot${config.TELEGRAM_TOKEN}/sendMessage`, {
          chat_id,
          text: '📂 <b>No portfolio projects configured to delete.</b>\n\nUse /addproject to add portfolio projects.',
          parse_mode: 'HTML'
        });
      } catch {}
      return;
    }

    if (!projectNameArg) {
      // Show interactive inline list of delete buttons
      const reply_markup = buildDeleteProjectsKeyboard();
      try {
        await axios.post(`https://api.telegram.org/bot${config.TELEGRAM_TOKEN}/sendMessage`, {
          chat_id,
          text: `🗑️ <b>Select a portfolio project to delete:</b>\nTotal projects: ${projects.length}`,
          parse_mode: 'HTML',
          reply_markup
        });
      } catch {}
      return;
    }

    // Direct deletion by name (legacy support)
    const index = projects.findIndex(p => p.name.toLowerCase() === projectNameArg.toLowerCase());
    if (index === -1) {
      try {
        await axios.post(`https://api.telegram.org/bot${config.TELEGRAM_TOKEN}/sendMessage`, {
          chat_id,
          text: `⚠️ <b>Project "${escapeHtml(projectNameArg)}" not found!</b>\n\nUse /projects to see your current list.`,
          parse_mode: 'HTML'
        });
      } catch {}
      return;
    }

    const r = config.loadAndGetRules();
    const deleted = r.portfolio_projects.splice(index, 1)[0];
    const success = config.saveRules(r);

    try {
      await axios.post(`https://api.telegram.org/bot${config.TELEGRAM_TOKEN}/sendMessage`, {
        chat_id,
        text: success
          ? `✅ <b>Removed project: "${escapeHtml(deleted.name)}"</b>\n\nRemaining portfolio projects: ${r.portfolio_projects.length}`
          : '❌ Failed to save rules.',
        parse_mode: 'HTML'
      });
    } catch {}
    return;
  }

  // 1. Check if this is a pre-filled manual edit link submission containing the state-free metadata
  const linkMatch = text.match(/ID:~([^\s\n~]+)~([^\s\n~]+)/);
  if (linkMatch) {
    const jobId = linkMatch[1];
    const originalMessageId = parseInt(linkMatch[2], 10);
    console.log(`✍️ Received manual cover letter via pre-filled link for Job [${jobId}]`);

    // Clean up states and remove the metadata line from proposal text
    delete userStates[chat_id];
    const cleanProposalText = text.replace(/---\nDo not edit this line:\s*ID:~[^\s\n]+/i, '')
                                  .replace(/ID:~[^\s\n]+/i, '')
                                  .trim();

    let feedbackMessageId;
    try {
      const res = await axios.post(`https://api.telegram.org/bot${config.TELEGRAM_TOKEN}/sendMessage`, {
        chat_id,
        text: '⏳ <b>Updating proposal with your custom text...</b>',
        parse_mode: 'HTML',
        reply_to_message_id: message.message_id
      });
      feedbackMessageId = res.data.result.message_id;
    } catch {}

    try {
      const jobAlert = await db.getJobAlert(jobId);
      if (!jobAlert) throw new Error('Job alert details not found in database.');

      await db.saveJobAlert(
        { title: jobAlert.title, link: jobAlert.link, description: jobAlert.description, connects: jobAlert.connects, score: jobAlert.score },
        jobAlert.queryName,
        cleanProposalText,
        jobAlert.summary
      );

      await editMessageTextSafe(chat_id, originalMessageId, {
        title: jobAlert.title,
        queryName: jobAlert.queryName,
        score: jobAlert.score,
        connects: jobAlert.connects,
        link: jobAlert.link,
        summary: jobAlert.summary,
        proposal: cleanProposalText
      }, jobId, '🚨 <b>New Upwork Match! (Edited Manually)</b>');

      if (feedbackMessageId) {
        await axios.post(`https://api.telegram.org/bot${config.TELEGRAM_TOKEN}/deleteMessage`, {
          chat_id,
          message_id: feedbackMessageId
        });
      }

      // Remove reply keyboard if active
      await axios.post(`https://api.telegram.org/bot${config.TELEGRAM_TOKEN}/sendMessage`, {
        chat_id,
        text: '✅ <b>Cover letter updated.</b>',
        parse_mode: 'HTML',
        reply_markup: { remove_keyboard: true }
      });
    } catch (err) {
      console.error('❌ Failed to save manual proposal:', err.message);
      if (feedbackMessageId) {
        await axios.post(`https://api.telegram.org/bot${config.TELEGRAM_TOKEN}/editMessageText`, {
          chat_id,
          message_id: feedbackMessageId,
          text: `❌ <b>Failed to update proposal:</b> ${escapeHtml(err.message)}`,
          parse_mode: 'HTML'
        });
      }
    }
    return;
  }

  // 2. Fall back to state-based text input handlers
  const state = userStates[chat_id];
  if (!state) return;
  if (state.action !== 'awaiting_edit_prompt' && state.action !== 'awaiting_manual_edit') return;

  const { jobId, originalMessageId } = state;

  if (state.action === 'awaiting_manual_edit') {
    console.log(`✍️ Received manual cover letter text for Job [${jobId}]`);
    delete userStates[chat_id];

    let feedbackMessageId;
    try {
      const res = await axios.post(`https://api.telegram.org/bot${config.TELEGRAM_TOKEN}/sendMessage`, {
        chat_id,
        text: '⏳ <b>Updating proposal with your custom text...</b>',
        parse_mode: 'HTML',
        reply_to_message_id: message.message_id
      });
      feedbackMessageId = res.data.result.message_id;
    } catch {}

    try {
      const jobAlert = await db.getJobAlert(jobId);
      if (!jobAlert) throw new Error('Job alert details not found in database.');

      await db.saveJobAlert(
        { title: jobAlert.title, link: jobAlert.link, description: jobAlert.description, connects: jobAlert.connects, score: jobAlert.score },
        jobAlert.queryName,
        text,
        jobAlert.summary
      );

      await editMessageTextSafe(chat_id, originalMessageId, {
        title: jobAlert.title,
        queryName: jobAlert.queryName,
        score: jobAlert.score,
        connects: jobAlert.connects,
        link: jobAlert.link,
        summary: jobAlert.summary,
        proposal: text
      }, jobId, '🚨 <b>New Upwork Match! (Edited Manually)</b>');

      if (feedbackMessageId) {
        await axios.post(`https://api.telegram.org/bot${config.TELEGRAM_TOKEN}/deleteMessage`, {
          chat_id,
          message_id: feedbackMessageId
        });
      }

      // Remove reply keyboard if active
      await axios.post(`https://api.telegram.org/bot${config.TELEGRAM_TOKEN}/sendMessage`, {
        chat_id,
        text: '✅ <b>Cover letter updated.</b>',
        parse_mode: 'HTML',
        reply_markup: { remove_keyboard: true }
      });
    } catch (err) {
      console.error('❌ Failed to save manual proposal:', err.message);
      if (feedbackMessageId) {
        await axios.post(`https://api.telegram.org/bot${config.TELEGRAM_TOKEN}/editMessageText`, {
          chat_id,
          message_id: feedbackMessageId,
          text: `❌ <b>Failed to update proposal:</b> ${escapeHtml(err.message)}`,
          parse_mode: 'HTML'
        });
      }
    }
    return;
  }

  console.log(`✍️ Received edit instruction for Job [${jobId}]: "${text}"`);
  delete userStates[chat_id];

  // Notify user that we are regenerating
  let feedbackMessageId;
  try {
    const res = await axios.post(`https://api.telegram.org/bot${config.TELEGRAM_TOKEN}/sendMessage`, {
      chat_id,
      text: '⏳ <b>Regenerating proposal with your instructions...</b>',
      parse_mode: 'HTML',
      reply_to_message_id: message.message_id
    });
    feedbackMessageId = res.data.result.message_id;
  } catch (err) {
    console.error('⚠️ Failed to send loading message:', err.message);
  }

  try {
    const jobAlert = await db.getJobAlert(jobId);
    if (!jobAlert) throw new Error('Job alert details not found in database.');

    const newProposalText = await rewriteProposal(jobAlert.proposal, jobAlert.description, text);

    if (!newProposalText) throw new Error('Gemini failed to rewrite proposal.');

    await db.saveJobAlert(
      { title: jobAlert.title, link: jobAlert.link, description: jobAlert.description, connects: jobAlert.connects, score: jobAlert.score },
      jobAlert.queryName,
      newProposalText,
      jobAlert.summary
    );

    await editMessageTextSafe(chat_id, originalMessageId, {
      title: jobAlert.title,
      queryName: jobAlert.queryName,
      score: jobAlert.score,
      connects: jobAlert.connects,
      link: jobAlert.link,
      summary: jobAlert.summary,
      proposal: newProposalText
    }, jobId, '🚨 <b>New Upwork Match! (Edited)</b>');

    if (feedbackMessageId) {
      await axios.post(`https://api.telegram.org/bot${config.TELEGRAM_TOKEN}/deleteMessage`, {
        chat_id,
        message_id: feedbackMessageId
      });
    }

    // Remove reply keyboard if active
    await axios.post(`https://api.telegram.org/bot${config.TELEGRAM_TOKEN}/sendMessage`, {
      chat_id,
      text: '✅ <b>Cover letter updated.</b>',
      parse_mode: 'HTML',
      reply_markup: { remove_keyboard: true }
    });
  } catch (err) {
    console.error('❌ Failed to regenerate proposal:', err.message);
    if (feedbackMessageId) {
      await axios.post(`https://api.telegram.org/bot${config.TELEGRAM_TOKEN}/editMessageText`, {
        chat_id,
        message_id: feedbackMessageId,
        text: `❌ <b>Failed to regenerate proposal:</b> ${escapeHtml(err.message)}`,
        parse_mode: 'HTML'
      });
    }
  }
}

async function handleDocumentMessage(message) {
  const chat_id = message.chat.id;
  const doc = message.document;

  // Security check: Only allow authorized users to upload documents
  const isAuthorized = await db.isUserAuthorized(chat_id);
  if (!isAuthorized) {
    try {
      await axios.post(`https://api.telegram.org/bot${config.TELEGRAM_TOKEN}/sendMessage`, {
        chat_id,
        text: '❌ <b>Access Denied:</b> You are not authorized to upload files to this bot.',
        parse_mode: 'HTML'
      });
    } catch {}
    return;
  }

  lastInteractionTime = Date.now();

  const fileName = doc.file_name || `attachment_${Date.now()}.pdf`;
  const isAwaitingOnboardingResume = userStates[chat_id] && userStates[chat_id].action === 'awaiting_resume';
  const isResumeUpdate = fileName.toLowerCase() === 'resume.pdf' || isAwaitingOnboardingResume;

  // 1. Check if this is a resume update FIRST, before intercepting for proposal attachments!
  if (isResumeUpdate) {
    let onboardingData = null;
    if (isAwaitingOnboardingResume) {
      onboardingData = { ...userStates[chat_id] };
      delete userStates[chat_id];
    }
    stats.setPaused(true);

    if (doc.mime_type !== 'application/pdf') {
      try {
        await axios.post(`https://api.telegram.org/bot${config.TELEGRAM_TOKEN}/sendMessage`, {
          chat_id,
          text: '❌ <b>Invalid File:</b> Please upload your resume as a <b>PDF</b> document.',
          parse_mode: 'HTML'
        });
      } catch {}
      return;
    }

    let feedbackMessageId;
    try {
      const res = await axios.post(`https://api.telegram.org/bot${config.TELEGRAM_TOKEN}/sendMessage`, {
        chat_id,
        text: '⏳ <b>Downloading and parsing your new PDF resume...</b>',
        parse_mode: 'HTML'
      });
      feedbackMessageId = res.data.result.message_id;
    } catch {}

    try {
      const fileRes = await axios.get(`https://api.telegram.org/bot${config.TELEGRAM_TOKEN}/getFile?file_id=${doc.file_id}`);
      const filePath = fileRes.data.result.file_path;

      const fileUrl = `https://api.telegram.org/file/bot${config.TELEGRAM_TOKEN}/${filePath}`;
      const downloadRes = await axios.get(fileUrl, { responseType: 'arraybuffer' });
      const fileBuffer = Buffer.from(downloadRes.data);

      // Save resume locally
      let resumePath;
      if (onboardingData) {
        const safeEmail = onboardingData.email.replace(/[^a-zA-Z0-9]/g, '_');
        resumePath = path.resolve(__dirname, '..', `resume_${safeEmail}.pdf`);
      } else {
        const activeEmail = config.activeAccountEmail;
        if (activeEmail) {
          const safeEmail = activeEmail.replace(/[^a-zA-Z0-9]/g, '_');
          resumePath = path.resolve(__dirname, '..', `resume_${safeEmail}.pdf`);
        } else {
          resumePath = path.resolve(__dirname, '..', 'resume.pdf');
        }
      }
      fs.writeFileSync(resumePath, fileBuffer);

      // Parse resume to rules
      let generatedRules = {};
      try {
        const { parseResumeToRules } = require('./resume');
        generatedRules = await parseResumeToRules(resumePath);
      } catch (parseErr) {
        console.error('⚠️ Failed to parse resume using AI:', parseErr.message);
        generatedRules = {
          search_queries: ["ai developer", "software engineer"],
          target_keywords: ["javascript", "node"],
          ignore_keywords: ["wordpress"],
          min_budget: 100,
          portfolio_projects: []
        };
      }

      if (onboardingData) {
        // Apply on-boarded budget and connects limit directly to generated rules
        generatedRules.min_budget = onboardingData.minBudget || 0;
        generatedRules.max_connects_limit = onboardingData.maxConnectsLimit !== undefined ? onboardingData.maxConnectsLimit : null;

        // Save the new account in database
        const newAccount = {
          email: onboardingData.email,
          password: onboardingData.password,
          name: onboardingData.name,
          rules: generatedRules,
          isActive: true
        };
        await db.saveAccount(newAccount);
        await db.setActiveAccount(onboardingData.email);

        // Force close existing chrome and reload config
        try {
          const { killPortProcess } = require('./browser');
          killPortProcess(config.CHROME_DEBUG_PORT);
        } catch {}
        await config.reloadActiveAccount();
      } else {
        // Standard resume update: save rules for active account
        const activeEmail = config.activeAccountEmail;
        if (activeEmail) {
          await db.updateAccountRules(activeEmail, generatedRules);
          await config.reloadActiveAccount();
        } else {
          const rPath = path.resolve(__dirname, '..', 'rules.json');
          fs.writeFileSync(rPath, JSON.stringify(generatedRules, null, 2), 'utf8');
          config.reloadRules();
        }
      }

      // Automatically unpause and trigger a scrape run
      stats.setPaused(false);
      
      if (onboardingData) {
        // Emit signal to unblock startup selection loop
        authSignals.emit('startup-profile-selected');
      } else {
        try {
          const { triggerScrapeRun } = require('../scraper-bot');
          triggerScrapeRun();
        } catch (err) {
          console.warn('⚠️ Failed to auto-trigger scrape run after resume update:', err.message);
        }
      }

      if (feedbackMessageId) {
        await axios.post(`https://api.telegram.org/bot${config.TELEGRAM_TOKEN}/deleteMessage`, {
          chat_id,
          message_id: feedbackMessageId
        });
      }

      const activeName = config.FREELANCER_NAME || (onboardingData ? onboardingData.name : 'Unknown');
      const activeEmail = config.activeAccountEmail || (onboardingData ? onboardingData.email : '');

      await axios.post(`https://api.telegram.org/bot${config.TELEGRAM_TOKEN}/sendMessage`, {
        chat_id,
        text: onboardingData
          ? `✅ <b>New account registered successfully!</b>\n\nActive profile: <b>${escapeHtml(activeName)}</b> (<code>${escapeHtml(activeEmail)}</code>)\n\n⚡ <i>Scraping rules have been auto-generated from the resume. Search cycles will now run for this profile.</i>`
          : `✅ <b>Resume updated successfully!</b>\n\nFreelancer profile name is set to: <b>${escapeHtml(activeName)}</b>\nScraping search queries have been automatically regenerated and loaded!` + PAUSE_SIGNAL_HTML,
        parse_mode: 'HTML'
      });

      // Automatically show the updated rules configuration
      const rulesHtml = buildRulesConfigHtml();
      await axios.post(`https://api.telegram.org/bot${config.TELEGRAM_TOKEN}/sendMessage`, {
        chat_id,
        text: rulesHtml,
        parse_mode: 'HTML'
      });
    } catch (err) {
      console.error('❌ Failed to update resume from Telegram upload:', err.message);
      stats.setPaused(false);
      try {
        const { triggerScrapeRun } = require('../scraper-bot');
        triggerScrapeRun();
      } catch {}
      
      if (feedbackMessageId) {
        await axios.post(`https://api.telegram.org/bot${config.TELEGRAM_TOKEN}/editMessageText`, {
          chat_id,
          message_id: feedbackMessageId,
          text: `❌ <b>Failed to update resume:</b> ${escapeHtml(err.message)}`,
          parse_mode: 'HTML'
        });
      }
    }
    return;
  }

  // 2. Check if the user is explicitly in the flow of uploading a custom attachment for a specific proposal card
  const isAwaitingCustomAttachment = userStates[chat_id] && userStates[chat_id].action === 'awaiting_custom_attachment';
  if (isAwaitingCustomAttachment) {
    const state = userStates[chat_id];
    const activeJobId = state.jobId;
    const originalMessageId = state.originalMessageId;
    
    // Clean up userState and selections
    delete userStates[chat_id];
    if (activeAttachmentSelections[activeJobId]) {
      delete activeAttachmentSelections[activeJobId];
    }
    flushPendingAlerts();

    console.log(`📎 Received custom attachment document "${fileName}" for Job ID: ${activeJobId}`);

    let feedbackId;
    try {
      const res = await axios.post(`https://api.telegram.org/bot${config.TELEGRAM_TOKEN}/sendMessage`, {
        chat_id,
        text: `⏳ <b>Downloading "${escapeHtml(fileName)}" for proposal attachment...</b>`,
        parse_mode: 'HTML'
      });
      feedbackId = res.data.result.message_id;
    } catch {}

    try {
      const fileRes = await axios.get(`https://api.telegram.org/bot${config.TELEGRAM_TOKEN}/getFile?file_id=${doc.file_id}`);
      const filePath = fileRes.data.result.file_path;
      const fileUrl = `https://api.telegram.org/file/bot${config.TELEGRAM_TOKEN}/${filePath}`;
      const downloadRes = await axios.get(fileUrl, { responseType: 'arraybuffer' });
      const fileBuffer = Buffer.from(downloadRes.data);

      const destPath = path.resolve(__dirname, '..', fileName);
      fs.writeFileSync(destPath, fileBuffer);

      if (feedbackId) {
        await axios.post(`https://api.telegram.org/bot${config.TELEGRAM_TOKEN}/deleteMessage`, {
          chat_id,
          message_id: feedbackId
        });
      }

      const attachmentPaths = [destPath];
      submissionQueue.push({ jobId: activeJobId, chat_id, message_id: originalMessageId, attachmentPaths });

      await notifyQueueStatus(activeJobId, chat_id, originalMessageId);
      return;
    } catch (err) {
      console.error('❌ Failed to download custom Telegram attachment:', err.message);
    }
  }

  // 3. Save generic file to permanente Attachments Library
  let feedbackId;
  try {
    const res = await axios.post(`https://api.telegram.org/bot${config.TELEGRAM_TOKEN}/sendMessage`, {
      chat_id,
      text: `⏳ <b>Saving "${escapeHtml(fileName)}" to your Attachments Library...</b>`,
      parse_mode: 'HTML'
    });
    feedbackId = res.data.result.message_id;
  } catch {}

  try {
    const fileRes = await axios.get(`https://api.telegram.org/bot${config.TELEGRAM_TOKEN}/getFile?file_id=${doc.file_id}`);
    const filePath = fileRes.data.result.file_path;
    const fileUrl = `https://api.telegram.org/file/bot${config.TELEGRAM_TOKEN}/${filePath}`;
    const downloadRes = await axios.get(fileUrl, { responseType: 'arraybuffer' });
    const fileBuffer = Buffer.from(downloadRes.data);

    const destPath = path.resolve(attachmentsDir, fileName);
    fs.writeFileSync(destPath, fileBuffer);

    if (feedbackId) {
      await axios.post(`https://api.telegram.org/bot${config.TELEGRAM_TOKEN}/deleteMessage`, {
        chat_id,
        message_id: feedbackId
      });
    }

    const { files } = getAvailableAttachmentFiles();
    await axios.post(`https://api.telegram.org/bot${config.TELEGRAM_TOKEN}/sendMessage`, {
      chat_id,
      text: `✅ Saved <b>"${escapeHtml(fileName)}"</b> to your permanent Attachments Library!\n\nTotal saved attachments: ${files.length}\n💡 <i>This file will now appear as a checkbox option whenever you accept a job proposal.</i>`,
      parse_mode: 'HTML'
    });
    return;
  } catch (err) {
    console.error('❌ Failed to save document to Attachments Library:', err.message);
  }
}

async function promptStartupProfile() {
  try {
    const accounts = await db.getAccounts();
    
    let message = '🚀 <b>Upwork Scraper Bot Started!</b>\n\nPlease select the active Upwork profile you want to run for this session:';
    
    const inlineKeyboard = {
      inline_keyboard: []
    };

    if (accounts.length === 0) {
      message = '📂 <b>No Upwork Profiles Found in Database</b>\n\nPlease initialize the bot session using one of the options below:';
      inlineKeyboard.inline_keyboard.push([
        { text: '📥 Load & Save from .env', callback_data: 'startup_select:load_env' }
      ]);
      inlineKeyboard.inline_keyboard.push([
        { text: '➕ Add New Profile', callback_data: 'startup_select:add_new' }
      ]);
    } else {
      inlineKeyboard.inline_keyboard = accounts.map(acc => [
        { text: `🟢 ${acc.name} (${acc.email})`, callback_data: `startup_select:${acc.email}` }
      ]);
      // Add default config option
      inlineKeyboard.inline_keyboard.push([
        { text: '⚙️ Use Local fallback (.env)', callback_data: 'startup_select:default' }
      ]);
      inlineKeyboard.inline_keyboard.push([
        { text: '➕ Add New Profile', callback_data: 'startup_select:add_new' }
      ]);
    }

    await axios.post(`https://api.telegram.org/bot${config.TELEGRAM_TOKEN}/sendMessage`, {
      chat_id: config.CHAT_ID,
      text: message,
      parse_mode: 'HTML',
      reply_markup: inlineKeyboard
    });

    console.log('⏳ Waiting for startup profile selection on Telegram...');

    // Wait for button click signal
    await new Promise((resolve) => {
      authSignals.once('startup-profile-selected', () => {
        resolve();
      });
    });
  } catch (err) {
    console.error('❌ Failed to run startup profile prompt:', err.message);
  }
}

module.exports = {
  sendTelegramAlert,
  startTelegramListener,
  processQueue,
  getAvailableAttachmentFiles,
  buildJobAlertHtml,
  promptStartupProfile
};

// Listen for 2FA verification code request alerts from the browser auth module
authSignals.on('2fa-required', async ({ chatId }) => {
  userStates[chatId] = { action: 'awaiting_2fa', timestamp: Date.now() };
  try {
    await axios.post(`https://api.telegram.org/bot${config.TELEGRAM_TOKEN}/sendMessage`, {
      chat_id: chatId,
      text: '🔒 <b>Upwork 2FA Verification Code Required:</b>\n\nPlease enter the 6-digit verification code sent to your email or authenticator app:',
      parse_mode: 'HTML'
    });
  } catch (err) {
    console.error('⚠️ Failed to prompt user for 2FA code:', err.message);
  }
});

// Listen for dynamic credentials request from the browser auth module
authSignals.on('login-credentials-request', async ({ chatId }) => {
  userStates[chatId] = { action: 'awaiting_login_creds', timestamp: Date.now() };
  try {
    await axios.post(`https://api.telegram.org/bot${config.TELEGRAM_TOKEN}/sendMessage`, {
      chat_id: chatId,
      text: '🔑 <b>Upwork Login Session Required:</b>\n\nPlease send the credentials for this session in the format:\n<code>email | password</code>\n\nOr send <b>/env</b> to use the default credentials from configuration (Auto fallback in 1 minute):',
      parse_mode: 'HTML'
    });
  } catch (err) {
    console.error('⚠️ Failed to prompt user for login credentials:', err.message);
  }
});

// Listen for login failure alert to notify the user
authSignals.on('login-failed-alert', async ({ chatId, reason }) => {
  try {
    await axios.post(`https://api.telegram.org/bot${config.TELEGRAM_TOKEN}/sendMessage`, {
      chat_id: chatId,
      text: `⚠️ <b>Dynamic Login Failed:</b> ${reason}.\nTrying fallback login using default credentials from configuration...`,
      parse_mode: 'HTML'
    });
  } catch {}
});

// Listen for security question challenge request from the browser auth module
authSignals.on('security-question-required', async ({ chatId, question }) => {
  userStates[chatId] = { action: 'awaiting_security_answer', timestamp: Date.now() };
  try {
    await axios.post(`https://api.telegram.org/bot${config.TELEGRAM_TOKEN}/sendMessage`, {
      chat_id: chatId,
      text: `🔒 <b>Upwork Security Challenge:</b>\n\n<b>Question:</b> ${escapeHtml(question)}\n\nPlease enter the answer to this security question:`,
      parse_mode: 'HTML'
    });
  } catch (err) {
    console.error('⚠️ Failed to prompt user for security answer:', err.message);
  }
});
