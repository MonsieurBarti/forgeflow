'use strict';

/**
 * dev-server.cjs -- Single-shot promise-gated HTTP dev server.
 *
 * Exports a single async function that starts a local HTTP server,
 * opens the browser, and returns a promise that resolves when the
 * user submits a decision via POST /decide.
 *
 * No side effects on require -- only calling the exported function starts a server.
 */

const http = require('node:http');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');
const { URL } = require('node:url');

// ---------------------------------------------------------------------------
// TimeoutError -- distinguishable error for caller detection
// ---------------------------------------------------------------------------
class TimeoutError extends Error {
  constructor(ms) {
    super(`Dev server timed out after ${ms}ms`);
    this.name = 'TimeoutError';
    this.code = 'TIMEOUT';
  }
}

// ---------------------------------------------------------------------------
// openBrowser -- platform-appropriate browser launch (best-effort)
// ---------------------------------------------------------------------------
function openBrowser(url) {
  return new Promise((resolve) => {
    let cmd, args;
    if (process.platform === 'win32') {
      cmd = 'cmd.exe';
      args = ['/c', 'start', '', url];
    } else {
      cmd = process.platform === 'darwin' ? 'open' : 'xdg-open';
      args = [url];
    }
    execFile(cmd, args, { stdio: 'ignore' }, (err) => {
      if (err) {
        // On open failure, print URL so the user can open it manually.
        // Intentionally writing to stderr to avoid polluting structured stdout.
        process.stderr.write(`\nDev server running at: ${url}\n`);
      }
      // Always resolve -- browser open is best-effort.
      resolve();
    });
  });
}

// ---------------------------------------------------------------------------
// validateToken -- check ?token= query param against expected value
// ---------------------------------------------------------------------------
function validateToken(reqUrl, expectedToken) {
  try {
    // Construct a full URL for parsing; the host does not matter.
    const parsed = new URL(reqUrl, 'http://localhost');
    return parsed.searchParams.get('token') === expectedToken;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// serveAndAwaitDecision -- main exported function
// ---------------------------------------------------------------------------

/**
 * Start a single-shot HTTP server and wait for a user decision.
 *
 * @param {object} opts
 * @param {string} opts.html      - Full HTML string to serve on GET /
 * @param {number} [opts.timeout] - Timeout in ms (default 1800000 = 30 min)
 * @param {string} [opts.title]   - Page title (informational, not used in serving)
 * @returns {Promise<object>} Resolves with the parsed JSON body from POST /decide
 * @throws {TimeoutError} If the timeout elapses before a decision is received
 */
async function serveAndAwaitDecision({ html, timeout = 1800000, title } = {}) {
  if (!html || typeof html !== 'string') {
    throw new Error('dev-server: opts.html is required and must be a string');
  }

  const token = crypto.randomBytes(24).toString('base64url');
  const { promise, resolve, reject } = Promise.withResolvers();

  // Track whether the promise has settled so we don't double-resolve/reject.
  let settled = false;

  const server = http.createServer((req, res) => {
    // Validate token on every request.
    if (!validateToken(req.url, token)) {
      res.writeHead(403, { 'Content-Type': 'text/plain' });
      res.end('Forbidden');
      return;
    }

    const pathname = new URL(req.url, 'http://localhost').pathname;

    // GET / -- serve the caller-provided HTML.
    if (req.method === 'GET' && pathname === '/') {
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
      });
      res.end(html);
      return;
    }

    // POST /decide -- resolve the promise with the JSON body.
    if (req.method === 'POST' && pathname === '/decide') {
      const chunks = [];
      req.on('data', (chunk) => chunks.push(chunk));
      req.on('end', () => {
        try {
          const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
          if (!settled) {
            settled = true;
            resolve(body);
          }
        } catch (parseErr) {
          res.writeHead(400, { 'Content-Type': 'text/plain' });
          res.end('Invalid JSON');
        }
      });
      return;
    }

    // Anything else -- 404.
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not Found');
  });

  // Bind to loopback only, OS-assigned port.
  await new Promise((res, rej) => {
    server.listen(0, '127.0.0.1', () => res());
    server.on('error', rej);
  });

  const addr = server.address();
  const baseUrl = `http://127.0.0.1:${addr.port}/?token=${token}`;

  // Timeout -- reject with a distinguishable TimeoutError.
  const timer = setTimeout(() => {
    if (!settled) {
      settled = true;
      reject(new TimeoutError(timeout));
    }
  }, timeout);

  // Auto-open the browser (best-effort).
  await openBrowser(baseUrl);

  // Cleanup: after the promise settles (resolve or reject), close server + clear timer.
  try {
    return await promise;
  } finally {
    clearTimeout(timer);
    server.close();
  }
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------
module.exports = { serveAndAwaitDecision, TimeoutError };
