#!/usr/bin/env node
'use strict';

/**
 * Forge statusline hook.
 * Renders current project/phase status in the Claude Code status bar.
 * Also writes bridge file for context-monitor to read.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

const BRIDGE_FILE = path.join(os.tmpdir(), 'forge-context-bridge.json');

async function main() {
  try {
    const input = await readStdin();
    if (!input) {
      printStatus('forge', '');
      return;
    }

    const data = JSON.parse(input);

    // Write bridge for context-monitor
    if (data.context_remaining !== undefined) {
      fs.writeFileSync(BRIDGE_FILE, JSON.stringify({
        context_remaining: data.context_remaining,
        timestamp: Date.now(),
      }));
    }

    // Try to get current project status
    let status = '';
    try {
      const result = execFileSync('node', [
        path.join(os.homedir(), '.claude', 'forge', 'bin', 'forge-tools.cjs'),
        'find-project',
      ], { encoding: 'utf8', timeout: 3000, stdio: ['pipe', 'pipe', 'pipe'] });

      const project = JSON.parse(result);
      if (project.found && project.projects && project.projects.length > 0) {
        const p = project.projects[0];
        status = p.title || 'forge';
      }
    } catch {
      // No project found or bd not available
    }

    printStatus('forge', status);
  } catch {
    printStatus('forge', '');
  }
}

function printStatus(prefix, detail) {
  const msg = detail ? `${prefix}: ${detail}` : prefix;
  // Statusline expects just the text
  process.stdout.write(msg);
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
