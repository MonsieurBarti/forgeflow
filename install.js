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
const crypto = require('crypto');
const { execFileSync } = require('child_process');

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

  // SessionStart hook for update check
  const updateCheckPath = path.join(CLAUDE_DIR, 'hooks', 'forge-update-check.js');
  if (!settings.hooks.SessionStart) settings.hooks.SessionStart = [];

  const hasUpdateCheck = settings.hooks.SessionStart.some(
    h => (h.hooks || []).some(hk => hk.command && hk.command.includes('forge-update-check'))
  );
  if (!hasUpdateCheck) {
    settings.hooks.SessionStart.push({
      hooks: [
        {
          type: 'command',
          command: `node "${updateCheckPath}"`,
        },
      ],
    });
    console.log('  Registered SessionStart hook: forge-update-check');
  }

  // Wire statusLine to forge-statusline.js
  const statusLinePath = path.join(CLAUDE_DIR, 'hooks', 'forge-statusline.js');
  settings.statusLine = `node "${statusLinePath}"`;

  // Copy package.json into installed forge dir for version comparison
  const srcPkg = path.join(SRC, 'package.json');
  const destPkg = path.join(CLAUDE_DIR, 'forge', 'package.json');
  if (fs.existsSync(srcPkg)) {
    fs.copyFileSync(srcPkg, destPkg);
  }

  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2), { mode: 0o600 });
}

/**
 * Collects all files under a directory recursively (absolute paths).
 */
function collectFiles(dir) {
  const results = [];
  if (!fs.existsSync(dir)) return results;
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...collectFiles(full));
    } else {
      results.push(full);
    }
  }
  return results;
}

/**
 * Computes SHA-256 hash of a file's contents.
 */
function hashFile(filePath) {
  const content = fs.readFileSync(filePath);
  return crypto.createHash('sha256').update(content).digest('hex');
}

/**
 * Writes .forge-manifest.json with SHA-256 hashes of all installed files.
 * Paths in the manifest are relative to CLAUDE_DIR (~/.claude/).
 */
function writeManifest() {
  const files = {};

  // Collect files from all installed directories
  const MANIFEST_NAME = '.forge-manifest.json';
  for (const { dest } of DIRS_TO_COPY) {
    const destPath = path.join(CLAUDE_DIR, dest);
    for (const filePath of collectFiles(destPath)) {
      if (path.basename(filePath) === MANIFEST_NAME) continue;
      const relPath = path.relative(CLAUDE_DIR, filePath);
      files[relPath] = hashFile(filePath);
    }
  }

  // Collect installed agent files
  const agentsDir = path.join(CLAUDE_DIR, 'agents');
  if (fs.existsSync(agentsDir)) {
    const agentFiles = fs.readdirSync(agentsDir).filter(f => f.startsWith('forge-') && f.endsWith('.md'));
    for (const file of agentFiles) {
      const filePath = path.join(agentsDir, file);
      const relPath = path.relative(CLAUDE_DIR, filePath);
      files[relPath] = hashFile(filePath);
    }
  }

  // Collect installed hook files
  const hooksDir = path.join(CLAUDE_DIR, 'hooks');
  if (fs.existsSync(hooksDir)) {
    const hookFiles = fs.readdirSync(hooksDir).filter(f => f.startsWith('forge-') && f.endsWith('.js'));
    for (const file of hookFiles) {
      const filePath = path.join(hooksDir, file);
      const relPath = path.relative(CLAUDE_DIR, filePath);
      files[relPath] = hashFile(filePath);
    }
  }

  // Read version from package.json
  let version = 'unknown';
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(SRC, 'package.json'), 'utf8'));
    version = pkg.version;
  } catch {
    // Fallback to unknown
  }

  // Build manifest with sorted keys for determinism
  const sortedFiles = {};
  for (const key of Object.keys(files).sort()) {
    sortedFiles[key] = files[key];
  }

  const manifest = {
    files: sortedFiles,
    generated_at: new Date().toISOString(),
    version,
  };

  const manifestPath = path.join(CLAUDE_DIR, 'forge', '.forge-manifest.json');
  ensureDir(path.dirname(manifestPath));
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
  console.log('  Generated .forge-manifest.json');
}

function main() {
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    console.log('Forge - Project orchestration for Claude Code');
    console.log('');
    console.log('Usage: node install.js');
    console.log('');
    console.log('Installs Forge commands, agents, workflows, and hooks into ~/.claude/');
    console.log('');
    console.log('Prerequisites:');
    console.log('  - Claude Code (https://claude.ai/claude-code)');
    console.log('  - beads (https://github.com/steveyegge/beads)');
    process.exit(0);
  }

  console.log('');
  console.log('  Forge - Project orchestration backed by beads');
  console.log('  =============================================');
  console.log('');

  // Check prerequisites
  try {
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
  writeManifest();

  console.log('');
  console.log('  Done! Forge is installed.');
  console.log('');
  console.log('  Get started:');
  console.log('    /forge:new        - Initialize a new project');
  console.log('    /forge:progress   - Check project status');
  console.log('');
}

main();
