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
const { execFile } = require('child_process');
const { promisify } = require('util');
const execFileAsync = promisify(execFile);

const BRIDGE_FILE = path.join(os.tmpdir(), 'forge-context-bridge.json');

async function main() {
  try {
    const input = await readStdin();
    if (!input) {
      printStatus('forge', '');
      return;
    }

    const data = JSON.parse(input);

    // Write bridge file with context, cost, and token data
    const bridge = { timestamp: Date.now() };

    if (data.context_remaining !== undefined) {
      bridge.context_remaining = data.context_remaining;
    }

    // Cost data
    if (data.cost && data.cost.total_cost_usd !== undefined) {
      bridge.total_cost_usd = data.cost.total_cost_usd;
    }

    // Token data
    if (data.context_window) {
      if (data.context_window.total_input_tokens !== undefined) {
        bridge.input_tokens = data.context_window.total_input_tokens;
      }
      if (data.context_window.total_output_tokens !== undefined) {
        bridge.output_tokens = data.context_window.total_output_tokens;
      }
      if (data.context_window.current_usage !== undefined) {
        bridge.current_usage = data.context_window.current_usage;
      }
    }

    fs.writeFileSync(BRIDGE_FILE, JSON.stringify(bridge), { mode: 0o600 });

    // Try to get current project status with progress (async to avoid blocking)
    let status = '';
    try {
      const toolsPath = path.join(os.homedir(), '.claude', 'forge', 'bin', 'forge-tools.cjs');
      const { stdout: result } = await execFileAsync('node', [toolsPath, 'find-project'], {
        encoding: 'utf8', timeout: 3000,
      });

      const project = JSON.parse(result);
      if (project.found && project.projects && project.projects.length > 0) {
        const p = project.projects[0];
        // Try to get progress summary
        try {
          const { stdout: progressResult } = await execFileAsync('node', [toolsPath, 'progress', p.id], {
            encoding: 'utf8', timeout: 3000,
          });
          const progress = JSON.parse(progressResult);
          const pct = progress.progress?.percent || 0;
          const phase = progress.current_phase?.title || '';
          const phaseShort = phase.replace(/^Phase \d+:\s*/, '');
          status = `${p.title} [${pct}%]`;
          if (phaseShort) status += ` ${phaseShort}`;
        } catch {
          status = p.title || 'forge';
        }
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
