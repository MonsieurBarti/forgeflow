#!/usr/bin/env node
'use strict';

/**
 * Forge context monitor hook.
 * Runs on PostToolUse. Monitors context window usage and injects warnings
 * when it gets low, suggesting to /clear and use /forge:resume.
 *
 * Based on the context-monitor pattern.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

const BRIDGE_DIR = path.join(os.homedir(), '.cache', 'forge');
const BRIDGE_FILE = path.join(BRIDGE_DIR, 'forge-context-bridge.json');
const DEFAULT_WARNING_THRESHOLD = 0.35;
const DEFAULT_CRITICAL_THRESHOLD = 0.25;
const DEBOUNCE_CALLS = 5;

let callCount = 0;
let cachedWarning = null;
let cachedCritical = null;

function getThreshold(key, fallback) {
  try {
    const val = execFileSync('bd', ['kv', 'get', key], {
      encoding: 'utf8', timeout: 2000, stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    const parsed = parseFloat(val);
    if (!isNaN(parsed) && parsed > 0 && parsed < 1) return parsed;
  } catch {
    // Key not set -- use default
  }
  return fallback;
}

async function main() {
  try {
    const input = await readStdin();
    if (!input) return;

    const data = JSON.parse(input);
    callCount++;

    if (callCount % DEBOUNCE_CALLS !== 0) return;

    // Load configurable thresholds (cache after first load)
    if (cachedWarning === null) {
      cachedWarning = getThreshold('forge.context_warning', DEFAULT_WARNING_THRESHOLD);
      cachedCritical = getThreshold('forge.context_critical', DEFAULT_CRITICAL_THRESHOLD);
    }

    let bridge = {};
    try {
      bridge = JSON.parse(fs.readFileSync(BRIDGE_FILE, 'utf8'));
    } catch {
      return; // No bridge data yet
    }

    const remaining = bridge.context_remaining;
    if (typeof remaining !== 'number') return;

    if (remaining < cachedCritical) {
      console.log(JSON.stringify({
        result: 'block',
        reason: `Context window critically low (${Math.round(remaining * 100)}% remaining). ` +
          'Use /forge:pause to save state, then /clear and /forge:resume in a fresh session.'
      }));
    } else if (remaining < cachedWarning) {
      // Warning only - don't block
      console.error(
        `[forge] Context at ${Math.round(remaining * 100)}%. Consider /forge:pause soon.`
      );
    }
  } catch {
    // Hooks must never block - fail silently
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
