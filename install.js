#!/usr/bin/env node
'use strict';

/**
 * Forge installer.
 * Copies commands, workflows, agents, and hooks into ~/.claude/.
 * Registers hooks in settings.json.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const SRC = __dirname;
const CLAUDE_DIR = path.join(os.homedir(), '.claude');

const DIRS_TO_COPY = [
  { src: 'commands/forge', dest: 'commands/forge' },
  { src: 'forge', dest: 'forge' },
];

const AGENTS_GLOB = 'agents';
const HOOKS_DIR = 'hooks';

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function copyDir(src, dest) {
  ensureDir(dest);
  const entries = fs.readdirSync(src, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDir(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

function installCommands() {
  for (const { src, dest } of DIRS_TO_COPY) {
    const srcPath = path.join(SRC, src);
    const destPath = path.join(CLAUDE_DIR, dest);
    if (fs.existsSync(srcPath)) {
      console.log(`  Copying ${src} -> ${dest}`);
      copyDir(srcPath, destPath);
    }
  }
}

function installAgents() {
  const agentsDir = path.join(SRC, AGENTS_GLOB);
  const destDir = path.join(CLAUDE_DIR, 'agents');
  ensureDir(destDir);

  if (!fs.existsSync(agentsDir)) return;

  const files = fs.readdirSync(agentsDir).filter(f => f.startsWith('forge-') && f.endsWith('.md'));
  for (const file of files) {
    console.log(`  Copying agent: ${file}`);
    fs.copyFileSync(path.join(agentsDir, file), path.join(destDir, file));
  }
}

function installHooks() {
  const hooksDir = path.join(SRC, HOOKS_DIR);
  const destDir = path.join(CLAUDE_DIR, 'hooks');
  ensureDir(destDir);

  if (!fs.existsSync(hooksDir)) return;

  const files = fs.readdirSync(hooksDir).filter(f => f.startsWith('forge-') && f.endsWith('.js'));
  for (const file of files) {
    console.log(`  Copying hook: ${file}`);
    fs.copyFileSync(path.join(hooksDir, file), path.join(destDir, file));
  }
}

function registerHooks() {
  const settingsPath = path.join(CLAUDE_DIR, 'settings.json');
  let settings = {};

  if (fs.existsSync(settingsPath)) {
    try {
      settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    } catch {
      console.warn('  Warning: could not parse settings.json, creating new one');
    }
  }

  if (!settings.hooks) settings.hooks = {};

  // PostToolUse hook for context monitor
  const contextMonitorPath = path.join(CLAUDE_DIR, 'hooks', 'forge-context-monitor.js');
  if (!settings.hooks.PostToolUse) settings.hooks.PostToolUse = [];

  const hasContextMonitor = settings.hooks.PostToolUse.some(
    h => (h.hooks || []).some(hk => hk.command && hk.command.includes('forge-context-monitor'))
  );
  if (!hasContextMonitor) {
    settings.hooks.PostToolUse.push({
      hooks: [
        {
          type: 'command',
          command: `node "${contextMonitorPath}"`,
        },
      ],
    });
    console.log('  Registered PostToolUse hook: forge-context-monitor');
  }

  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
}

function main() {
  console.log('');
  console.log('  Forge - Project orchestration backed by beads');
  console.log('  =============================================');
  console.log('');

  // Check prerequisites
  try {
    const { execFileSync } = require('child_process');
    execFileSync('bd', ['--version'], { stdio: 'pipe' });
  } catch {
    console.error('  Error: beads (bd) not found. Install it first:');
    console.error('  https://github.com/steveyegge/beads');
    process.exit(1);
  }

  console.log('  Installing to:', CLAUDE_DIR);
  console.log('');

  installCommands();
  installAgents();
  installHooks();
  registerHooks();

  console.log('');
  console.log('  Done! Forge is installed.');
  console.log('');
  console.log('  Get started:');
  console.log('    /forge:new        - Initialize a new project');
  console.log('    /forge:progress   - Check project status');
  console.log('');
}

main();
