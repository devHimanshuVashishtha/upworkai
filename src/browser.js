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
    ? `start "" "${config.CHROME_PATH}" --remote-debugging-port=${port} --user-data-dir="${config.BROWSER_DATA_DIR}" ${headlessFlag} ${proxyFlag} --remote-allow-origins=* --start-maximized --disable-blink-features=AutomationControlled --disable-extensions --disable-component-extensions-with-background-pages --disable-default-apps --mute-audio --no-default-browser-check --disable-background-networking --disable-background-timer-throttling --disable-backgrounding-occluded-windows --disable-renderer-backgrounding --disable-ipc-flooding-protection --disable-client-side-phishing-detection --disable-breakpad --disable-sync --force-color-profile=srgb --use-mock-keychain`
    : `"${config.CHROME_PATH}" --remote-debugging-port=${port} --user-data-dir="${config.BROWSER_DATA_DIR}" ${headlessFlag} ${proxyFlag} --remote-allow-origins=* --start-maximized --disable-blink-features=AutomationControlled --no-sandbox --disable-setuid-sandbox --disable-dev-shm-usage --disable-gpu --disable-extensions --disable-component-extensions-with-background-pages --disable-default-apps --mute-audio --no-default-browser-check --disable-background-networking --disable-background-timer-throttling --disable-backgrounding-occluded-windows --disable-renderer-backgrounding --disable-ipc-flooding-protection --disable-client-side-phishing-detection --disable-breakpad --disable-sync --force-color-profile=srgb --use-mock-keychain`;

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
let proxyServer = null;

function startCDPLookupProxy() {
  return new Promise((resolve, reject) => {
    if (proxyServer) {
      return resolve();
    }

    const http = require('http');
    const net = require('net');

    proxyServer = http.createServer((req, res) => {
      console.log(`[CDP Proxy] HTTP Request: ${req.method} ${req.url}`);
      
      const clientHost = req.headers.host || '127.0.0.1:9223';
      const headers = { ...req.headers };
      headers.host = '127.0.0.1:9222';
      
      // Strip all origin, referer, and proxy/forwarding headers to make the request look native to Chrome
      delete headers.origin;
      delete headers.referer;
      delete headers['x-forwarded-host'];
      delete headers['x-forwarded-for'];
      delete headers['x-forwarded-proto'];
      delete headers['forwarded'];
      delete headers['via'];

      const proxyReq = http.request({
        host: '127.0.0.1',
        port: 9222,
        path: req.url,
        method: req.method,
        headers: headers
      }, (proxyRes) => {
        const contentType = proxyRes.headers['content-type'] || '';
        const isJson = contentType.includes('application/json');
        const isHtml = contentType.includes('text/html');
        
        if (isJson || isHtml) {
          let body = '';
          proxyRes.on('data', (chunk) => { body += chunk; });
          proxyRes.on('end', () => {
            // Rewrite Chrome's 127.0.0.1 debugger links to use the public tunnel host!
            const rewrittenBody = body.replace(/127\.0\.0\.1:9222/g, clientHost)
                                      .replace(/localhost:9222/g, clientHost);
            
            const resHeaders = { ...proxyRes.headers };
            delete resHeaders['content-length']; // length changed
            
            res.writeHead(proxyRes.statusCode, resHeaders);
            res.end(rewrittenBody);
          });
        } else {
          res.writeHead(proxyRes.statusCode, proxyRes.headers);
          proxyRes.pipe(res);
        }
      });

      proxyReq.on('error', (err) => {
        console.error('[CDP Proxy Error] HTTP proxy request failed:', err.message);
        res.writeHead(502);
        res.end('Bad Gateway');
      });

      req.pipe(proxyReq);
    });

    proxyServer.on('upgrade', (req, socket, head) => {
      console.log(`[CDP Proxy] WS Upgrade: ${req.url}`);
      
      const headers = { ...req.headers };
      headers.host = '127.0.0.1:9222';
      
      // Strip origin, referer, and forwarding headers for WebSocket upgrade
      delete headers.origin;
      delete headers.referer;
      delete headers['x-forwarded-host'];
      delete headers['x-forwarded-for'];
      delete headers['x-forwarded-proto'];
      delete headers['forwarded'];
      delete headers['via'];

      let rawRequest = `${req.method} ${req.url} HTTP/${req.httpVersion}\r\n`;
      for (const [key, value] of Object.entries(headers)) {
        rawRequest += `${key}: ${value}\r\n`;
      }
      rawRequest += '\r\n';

      const targetSocket = net.connect(9222, '127.0.0.1', () => {
        targetSocket.write(rawRequest);
        if (head && head.length > 0) {
          targetSocket.write(head);
        }
        socket.pipe(targetSocket);
        targetSocket.pipe(socket);
      });

      targetSocket.on('error', (err) => {
        console.error('[CDP Proxy Error] Target connection failed:', err.message);
        socket.destroy();
      });
      socket.on('error', (err) => {
        targetSocket.destroy();
      });
    });

    proxyServer.on('error', (err) => {
      console.error('⚠️ CDP Lookup Proxy error:', err.message);
      reject(err);
    });

    proxyServer.listen(9223, '127.0.0.1', () => {
      console.log('🔌 CDP Lookup Proxy listening on port 9223 -> 9222 (Host header rewrite active)');
      resolve();
    });
  });
}

async function startRemoteDebuggerTunnel() {
  if (tunnelUrl) return tunnelUrl;
  
  try {
    await startCDPLookupProxy();
  } catch (err) {
    console.error('⚠️ Failed to start CDP Lookup Proxy:', err.message);
    return null;
  }

  console.log('🔌 Launching remote debugger tunnel via localtunnel...');
  
  // Method A: Try localtunnel
  let url = await new Promise((resolve) => {
    const { spawn } = require('child_process');
    const isWin = process.platform === 'win32';
    const cmd = isWin ? 'npx.cmd' : 'npx';
    tunnelProcess = spawn(cmd, ['localtunnel', '--port', '9223']);
    
    let resolved = false;
    const timeout = setTimeout(() => {
      if (!resolved) {
        console.warn('⚠️ Localtunnel connection timed out. Killing localtunnel process...');
        try { tunnelProcess.kill(); } catch {}
        resolve(null);
      }
    }, 12000);

    tunnelProcess.stdout.on('data', (data) => {
      const output = data.toString();
      console.log(`[Localtunnel] ${output.trim()}`);
      
      const match = output.match(/your url is:\s*(https:\/\/[^\s]+)/i);
      if (match && match[1]) {
        clearTimeout(timeout);
        resolved = true;
        resolve(match[1]);
      }
    });

    tunnelProcess.stderr.on('data', (data) => {
      console.warn(`[Localtunnel Error] ${data.toString().trim()}`);
    });

    tunnelProcess.on('close', () => {
      if (!resolved) resolve(null);
    });
  });

  if (url) {
    tunnelUrl = url;
    console.log(`✅ Remote debugger tunnel active via localtunnel: ${tunnelUrl}`);
    return tunnelUrl;
  }

  // Method B Fallback: Try SSH tunnel via localhost.run
  console.log('🔌 Localtunnel failed. Falling back to SSH Tunnel (localhost.run)...');
  
  url = await new Promise((resolve) => {
    const { spawn } = require('child_process');
    
    // Run ssh -o StrictHostKeyChecking=no -R 80:127.0.0.1:9223 nokey@localhost.run
    tunnelProcess = spawn('ssh', [
      '-o', 'StrictHostKeyChecking=no',
      '-o', 'ServerAliveInterval=30',
      '-R', '80:127.0.0.1:9223',
      'nokey@localhost.run'
    ]);

    let resolved = false;
    const timeout = setTimeout(() => {
      if (!resolved) {
        console.warn('⚠️ SSH Tunnel connection timed out. Killing SSH process...');
        try { tunnelProcess.kill(); } catch {}
        resolve(null);
      }
    }, 12000);

    tunnelProcess.stdout.on('data', (data) => {
      const output = data.toString();
      console.log(`[SSH Tunnel] ${output.trim()}`);
      
      // Match localhost.run URL: e.g. https://xxxx.lhr.life
      const match = output.match(/(https:\/\/[a-z0-9-.]+\.lhr\.life)/i);
      if (match && match[1]) {
        clearTimeout(timeout);
        resolved = true;
        resolve(match[1]);
      }
    });

    tunnelProcess.stderr.on('data', (data) => {
      console.warn(`[SSH Tunnel Error] ${data.toString().trim()}`);
    });

    tunnelProcess.on('close', () => {
      if (!resolved) resolve(null);
    });
  });

  if (url) {
    tunnelUrl = url;
    console.log(`✅ Remote debugger tunnel active via SSH: ${tunnelUrl}`);
    return tunnelUrl;
  }

  console.error('❌ All remote debugging tunnels failed.');
  return null;
}

function stopRemoteDebuggerTunnel() {
  if (tunnelProcess) {
    tunnelProcess.kill();
    tunnelProcess = null;
    console.log('🔌 Stopped remote debugger tunnel.');
  }
  if (proxyServer) {
    proxyServer.close();
    proxyServer = null;
    console.log('🔌 Stopped CDP Lookup Proxy.');
  }
  tunnelUrl = null;
}

module.exports = {
  connectCDP,
  disconnect,
  bringChromeToFront,
  killPortProcess,
  startRemoteDebuggerTunnel,
  stopRemoteDebuggerTunnel,
};
