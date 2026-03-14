#!/usr/bin/env node
'use strict';

/**
 * Forge update check hook.
 * Runs on SessionStart. Compares installed version against package.json
 * in the source repo (if accessible) and notifies if an update is available.
 *
 * Non-blocking -- always exits cleanly. Debounces to once per 24 hours.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const CACHE_DIR = path.join(os.homedir(), '.cache', 'forge');
const STATE_FILE = path.join(CACHE_DIR, 'forge-update-check.json');
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours

async function main() {
  try {
    const input = await readStdin();
    // SessionStart hook -- input may be empty or JSON

    // Check if we should skip (debounce)
    let state = {};
    try {
      state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    } catch {
      // No state file yet
    }

    const now = Date.now();
    if (state.last_check && (now - state.last_check) < CHECK_INTERVAL_MS) {
      return; // Already checked recently
    }

    // Check if update check is disabled via bd kv
    try {
      const disabled = execFileSync('bd', ['kv', 'get', 'forge.update_check'], {
        encoding: 'utf8', timeout: 3000, stdio: ['pipe', 'pipe', 'pipe'],
      }).trim();
      if (disabled === 'false' || disabled === 'off' || disabled === '0') {
        return;
      }
    } catch {
      // Key not set -- default to enabled
    }

    // Get installed version from ~/.claude/forge/
    const installedPkgPath = path.join(os.homedir(), '.claude', 'forge', 'package.json');
    let installedVersion = null;
    try {
      const pkg = JSON.parse(fs.readFileSync(installedPkgPath, 'utf8'));
      installedVersion = pkg.version;
    } catch {
      // Not installed via package.json -- skip check
      return;
    }

    // Try to find source package.json (if we're in the forge repo)
    let sourceVersion = null;
    const candidates = [
      // Common locations relative to cwd
      path.join(process.cwd(), 'package.json'),
    ];

    for (const candidate of candidates) {
      try {
        const pkg = JSON.parse(fs.readFileSync(candidate, 'utf8'));
        if (pkg.name === 'forge') {
          sourceVersion = pkg.version;
          break;
        }
      } catch {
        continue;
      }
    }

    // Update state
    state.last_check = now;
    state.installed_version = installedVersion;
    state.source_version = sourceVersion;
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify(state));

    // Compare versions if both available
    if (sourceVersion && installedVersion && sourceVersion !== installedVersion) {
      console.error(
        `[forge] Update available: ${installedVersion} -> ${sourceVersion}. ` +
        `Run: node install.js`
      );
    }

    // Drift detection -- compare installed files against manifest hashes
    checkDrift();
  } catch {
    // Hooks must never block -- fail silently
  }
}

/**
 * Checks installed files against the SHA-256 manifest.
 * Reports drift (modified files) to stderr.
 * Silently skips if manifest does not exist.
 */
function checkDrift() {
  const claudeDir = path.join(os.homedir(), '.claude');
  const manifestPath = path.join(claudeDir, 'forge', '.forge-manifest.json');

  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch {
    // No manifest -- skip silently (backwards compat)
    return;
  }

  if (!manifest.files || typeof manifest.files !== 'object') return;

  let driftCount = 0;
  const resolvedClaudeDir = path.resolve(claudeDir) + path.sep;
  for (const [relPath, expectedHash] of Object.entries(manifest.files)) {
    try {
      const absPath = path.join(claudeDir, relPath);
      // Validate path stays within claudeDir to prevent traversal
      if (!path.resolve(absPath).startsWith(resolvedClaudeDir)) continue;
      const content = fs.readFileSync(absPath);
      const actualHash = crypto.createHash('sha256').update(content).digest('hex');
      if (actualHash !== expectedHash) {
        driftCount++;
      }
    } catch {
      // File missing or unreadable -- counts as drift
      driftCount++;
    }
  }

  if (driftCount > 0) {
    console.error(
      `[forge] Install drift detected: ${driftCount} file(s) modified since install. ` +
      `Run: node install.js`
    );
  }
}

function readStdin() {
  return new Promise((resolve) => {
    const timeout = setTimeout(() => resolve(''), 3000);
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => { data += chunk; });
    process.stdin.on('end', () => { clearTimeout(timeout); resolve(data); });
    process.stdin.on('error', () => { clearTimeout(timeout); resolve(''); });
  });
}

main();
