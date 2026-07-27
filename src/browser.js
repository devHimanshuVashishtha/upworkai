const { chromium } = require('playwright-extra');
const stealth = require('puppeteer-extra-plugin-stealth')();
const { exec, execSync } = require('child_process');
const axios = require('axios');
const path = require('path');
const config = require('./config');

chromium.use(stealth);

function killPortProcess(port) {
  try {
    const isWin = process.platform === 'win32';
    if (isWin) {
      // Find process ID bound to the remote debugging port on Windows
      const output = execSync(`netstat -ano | findstr :${port}`, { stdio: ['pipe', 'pipe', 'ignore'] }).toString();
      const lines = output.split('\n');
      for (const line of lines) {
        const parts = line.trim().split(/\s+/);
        if (parts.length >= 5) {
          const pid = parts[parts.length - 1];
          if (pid && pid !== '0') {
            console.log(`🧹 Force closing orphaned process on port ${port} (PID: ${pid})...`);
            execSync(`taskkill /F /PID ${pid}`, { stdio: 'ignore' });
          }
        }
      }
    } else {
      // Linux/Mac process termination
      execSync(`lsof -t -i:${port} | xargs kill -9`, { stdio: 'ignore' });
    }
  } catch (e) {
    // Port not in use or process already terminated, ignore
  }
}

async function isPortActive(port) {
  try {
    await axios.get(`http://127.0.0.1:${port}/json/version`, { timeout: 1500 });
    return true;
  } catch {
    return false;
  }
}

async function ensureChromeRunning() {
  const port = config.CHROME_DEBUG_PORT;

  if (await isPortActive(port)) return;

  console.log(`🚀 Launching Chrome on port ${port}...`);

  const headlessFlag = config.HEADLESS ? '--headless=new' : '';
  const proxyFlag = config.PROXY_URL ? `--proxy-server="${config.PROXY_URL}"` : '';
  const isWin = process.platform === 'win32';
  
  const cmd = isWin
    ? `start "" "${config.CHROME_PATH}" --remote-debugging-port=${port} --user-data-dir="${config.BROWSER_DATA_DIR}" ${headlessFlag} ${proxyFlag} --start-maximized --disable-blink-features=AutomationControlled`
    : `"${config.CHROME_PATH}" --remote-debugging-port=${port} --user-data-dir="${config.BROWSER_DATA_DIR}" ${headlessFlag} ${proxyFlag} --start-maximized --disable-blink-features=AutomationControlled --no-sandbox --disable-setuid-sandbox --disable-dev-shm-usage --disable-gpu`;

  exec(cmd, (err) => {
    if (err && !err.killed) console.error('Chrome process error:', err.message);
  });

  console.log('⏳ Waiting for Chrome to start...');
  for (let i = 0; i < config.LIMITS.CHROME_STARTUP_RETRIES; i++) {
    await new Promise(r => setTimeout(r, 2000));
    if (await isPortActive(port)) {
      console.log('✅ Chrome is ready!');
      return;
    }
  }

  throw new Error(`Chrome failed to start on port ${port}. Ensure Google Chrome is installed.`);
}

async function connectCDP() {
  const port = config.CHROME_DEBUG_PORT;
  try {
    await ensureChromeRunning();
    console.log('🔌 Connecting to Chrome via CDP...');
    const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
    const contexts = browser.contexts();
    const context = contexts.length > 0 ? contexts[0] : await browser.newContext();
    return { browser, context };
  } catch (err) {
    console.warn(`⚠️ Playwright CDP connection failed: ${err.message}. Force closing locked browser processes...`);
    killPortProcess(port);
    await new Promise(r => setTimeout(r, 2000));
    
    // Retry launch and connection
    await ensureChromeRunning();
    console.log('🔌 Retrying connection to Chrome via CDP...');
    const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
    const contexts = browser.contexts();
    const context = contexts.length > 0 ? contexts[0] : await browser.newContext();
    return { browser, context };
  }
}

async function disconnect(browser, page) {
  if (page) {
    try { await page.close(); } catch {}
  }
  if (browser) {
    try {
      await browser.close();
      console.log('🔌 Disconnected from Chrome (stays open for next run).');
    } catch {}
  }
}

function bringChromeToFront() {
  const isWin = process.platform === 'win32';
  if (isWin) {
    const scriptPath = path.join(__dirname, 'bring_to_front.ps1');
    exec(`powershell -ExecutionPolicy Bypass -File "${scriptPath}"`, (err) => {
      if (err) console.warn('⚠️ Failed to focus Chrome via Win32 API helper:', err.message);
    });
  }
}

let tunnelProcess = null;
let tunnelUrl = null;

async function startRemoteDebuggerTunnel() {
  if (tunnelUrl) return tunnelUrl;
  
  console.log('🔌 Launching remote debugger tunnel via localtunnel...');
  return new Promise((resolve) => {
    const { spawn } = require('child_process');
    const isWin = process.platform === 'win32';
    // Run npx localtunnel --port 9222
    const cmd = isWin ? 'npx.cmd' : 'npx';
    tunnelProcess = spawn(cmd, ['localtunnel', '--port', '9222']);
    
    let resolved = false;
    const timeout = setTimeout(() => {
      if (!resolved) {
        console.warn('⚠️ Localtunnel connection timed out.');
        resolve(null);
      }
    }, 15000);

    tunnelProcess.stdout.on('data', (data) => {
      const output = data.toString();
      console.log(`[Localtunnel] ${output.trim()}`);
      
      const match = output.match(/your url is:\s*(https:\/\/[^\s]+)/i);
      if (match && match[1]) {
        tunnelUrl = match[1];
        clearTimeout(timeout);
        resolved = true;
        console.log(`✅ Remote debugger tunnel active at: ${tunnelUrl}`);
        resolve(tunnelUrl);
      }
    });

    tunnelProcess.stderr.on('data', (data) => {
      console.warn(`[Localtunnel Error] ${data.toString().trim()}`);
    });

    tunnelProcess.on('close', () => {
      tunnelProcess = null;
      tunnelUrl = null;
      console.log('🔌 Remote debugger tunnel closed.');
    });
  });
}

function stopRemoteDebuggerTunnel() {
  if (tunnelProcess) {
    tunnelProcess.kill();
    tunnelProcess = null;
    tunnelUrl = null;
    console.log('🔌 Stopped remote debugger tunnel.');
  }
}

module.exports = {
  connectCDP,
  disconnect,
  bringChromeToFront,
  killPortProcess,
  startRemoteDebuggerTunnel,
  stopRemoteDebuggerTunnel,
};
