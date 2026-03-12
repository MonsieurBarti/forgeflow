#!/usr/bin/env node
'use strict';

/**
 * core.cjs -- Shared helpers and constants for forge-tools modules.
 *
 * Exports: parseSimpleYaml, toSimpleYaml, parseFrontmatter, writeFrontmatter,
 *          isDoltConnectionError, restartDolt, bd, bdArgs, bdJson, git, gh,
 *          output, resolveAgentModel, loadModelProfile, loadModelOverrides,
 *          and all constants.
 */

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

// --- Settings Paths ---

const GLOBAL_SETTINGS_PATH = path.join(os.homedir(), '.claude', 'forge.local.md');
const PROJECT_SETTINGS_NAME = '.forge/settings.yaml';

// --- Settings Defaults ---

const SETTINGS_DEFAULTS = {
  skip_verification: false,
  auto_commit: true,
  require_discussion: true,
  auto_research: true,
  plan_check: true,
  parallel_execution: true,
};

const SETTINGS_DESCRIPTIONS = {
  skip_verification: 'Skip phase verification after execution',
  auto_commit: 'Auto-commit after each completed task',
  require_discussion: 'Require user discussion before planning',
  auto_research: 'Auto-run research before planning',
  plan_check: 'Run plan checker to validate plans',
  parallel_execution: 'Execute independent tasks in parallel',
};

// --- Model Profile Table ---
// Three tiers mapping agents to model classes.
// 'opus' resolves to 'inherit' at output (avoids version conflicts).
// See forge/references/model-profiles.md for rationale.

const MODEL_PROFILES = {
  'forge-planner':        { quality: 'opus',   balanced: 'opus',   budget: 'sonnet' },
  'forge-roadmapper':     { quality: 'opus',   balanced: 'sonnet', budget: 'sonnet' },
  'forge-executor':       { quality: 'opus',   balanced: 'sonnet', budget: 'sonnet' },
  'forge-researcher':     { quality: 'opus',   balanced: 'sonnet', budget: 'haiku' },
  'forge-verifier':       { quality: 'sonnet', balanced: 'sonnet', budget: 'haiku' },
  'forge-plan-checker':   { quality: 'sonnet', balanced: 'sonnet', budget: 'haiku' },
  'forge-debugger':       { quality: 'opus',   balanced: 'sonnet', budget: 'sonnet' },
  'forge-codebase-mapper':{ quality: 'sonnet', balanced: 'haiku',  budget: 'haiku' },
};

// Map old role names to new agent names for backwards compatibility
const ROLE_TO_AGENT = {
  planner: 'forge-planner',
  roadmapper: 'forge-roadmapper',
  executor: 'forge-executor',
  researcher: 'forge-researcher',
  verifier: 'forge-verifier',
  plan_checker: 'forge-plan-checker',
  debugger: 'forge-debugger',
  codebase_mapper: 'forge-codebase-mapper',
};

const DEFAULT_MODEL_PROFILE = 'balanced';

// --- Simple YAML Helpers ---

function parseSimpleYaml(text) {
  const result = {};
  let currentSection = null;
  for (const line of text.split('\n')) {
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const indent = line.match(/^(\s*)/)[1].length;
    const trimmed = line.trim();
    const colonIdx = trimmed.indexOf(':');
    if (colonIdx === -1) continue;
    const key = trimmed.slice(0, colonIdx).trim();
    let val = trimmed.slice(colonIdx + 1).trim();

    if (indent > 0 && currentSection) {
      // Nested key under current section
      if (val === 'true') val = true;
      else if (val === 'false') val = false;
      else if (/^\d+(\.\d+)?$/.test(val)) val = parseFloat(val);
      if (typeof result[currentSection] !== 'object') result[currentSection] = {};
      result[currentSection][key] = val;
    } else if (val === '') {
      // Section header (e.g., "models:")
      currentSection = key;
      if (!result[key]) result[key] = {};
    } else {
      currentSection = null;
      if (val === 'true') val = true;
      else if (val === 'false') val = false;
      else if (/^\d+(\.\d+)?$/.test(val)) val = parseFloat(val);
      result[key] = val;
    }
  }
  return result;
}

function toSimpleYaml(obj) {
  const lines = [];
  for (const [key, val] of Object.entries(obj)) {
    if (val && typeof val === 'object' && !Array.isArray(val)) {
      lines.push(`${key}:`);
      for (const [subKey, subVal] of Object.entries(val)) {
        lines.push(`  ${subKey}: ${subVal}`);
      }
    } else {
      lines.push(`${key}: ${val}`);
    }
  }
  return lines.join('\n') + '\n';
}

function parseFrontmatter(text) {
  const match = text.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return {};
  return parseSimpleYaml(match[1]);
}

function writeFrontmatter(filePath, data, body) {
  const yamlStr = toSimpleYaml(data);
  const content = `---\n${yamlStr}---\n${body || ''}`;
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(filePath, content);
}

// --- Helpers ---

function isDoltConnectionError(err) {
  const msg = (err.message || '') + (err.stderr || '');
  return /connection refused|dial tcp|dolt.*not running|unable to connect|connection reset|EOF/i.test(msg);
}

function restartDolt() {
  try {
    execFileSync('bd', ['dolt', 'start'], {
      encoding: 'utf8',
      timeout: 15000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    // Give Dolt a moment to become ready
    const start = Date.now();
    while (Date.now() - start < 2000) { /* spin-wait */ }
  } catch (_) {
    // Ignore restart errors; the retry will surface the real failure
  }
}

function bd(args, opts = {}) {
  const argList = args.split(/\s+/);
  const _retry = opts._retry || false;
  try {
    const result = execFileSync('bd', argList, {
      encoding: 'utf8',
      timeout: 10000,
      stdio: ['pipe', 'pipe', 'pipe'],
      ...opts,
    });
    return result.trim();
  } catch (err) {
    if (!_retry && isDoltConnectionError(err)) {
      restartDolt();
      return bd(args, { ...opts, _retry: true });
    }
    if (opts.allowFail) return '';
    throw err;
  }
}

function git(args, opts = {}) {
  const argList = Array.isArray(args) ? args : args.split(/\s+/);
  try {
    const result = execFileSync('git', argList, {
      encoding: 'utf8',
      timeout: 30000,
      stdio: ['pipe', 'pipe', 'pipe'],
      ...opts,
    });
    return result.trim();
  } catch (err) {
    if (opts.allowFail) return '';
    throw err;
  }
}

function bdArgs(argList, opts = {}) {
  const _retry = opts._retry || false;
  try {
    const result = execFileSync('bd', argList, {
      encoding: 'utf8',
      timeout: 10000,
      stdio: ['pipe', 'pipe', 'pipe'],
      ...opts,
    });
    return result.trim();
  } catch (err) {
    if (!_retry && isDoltConnectionError(err)) {
      restartDolt();
      return bdArgs(argList, { ...opts, _retry: true });
    }
    if (opts.allowFail) return '';
    throw err;
  }
}

function bdJson(args) {
  const raw = bd(`${args} --json`);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (args.startsWith('show ') && Array.isArray(parsed)) {
      return parsed[0] !== undefined ? parsed[0] : null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function gh(args, opts = {}) {
  const argList = Array.isArray(args) ? args : args.split(/\s+/);
  try {
    const result = execFileSync('gh', argList, {
      encoding: 'utf8',
      timeout: 30000,
      stdio: ['pipe', 'pipe', 'pipe'],
      ...opts,
    });
    return result.trim();
  } catch (err) {
    if (opts.allowFail) return '';
    throw err;
  }
}

function output(data) {
  process.stdout.write(JSON.stringify(data, null, 2) + '\n');
}

// --- Model Resolution ---

/**
 * Load the active model profile name from settings layers.
 * Resolution: project model_profile > global model_profile > 'balanced'
 */
function loadModelProfile() {
  let profile = null;

  // Global layer
  try {
    const text = fs.readFileSync(GLOBAL_SETTINGS_PATH, 'utf8');
    const parsed = parseFrontmatter(text);
    if (parsed.model_profile) profile = parsed.model_profile;
  } catch { /* no global settings */ }

  // Project layer (overrides global)
  try {
    const projectPath = path.resolve(process.cwd(), PROJECT_SETTINGS_NAME);
    const parsed = parseSimpleYaml(fs.readFileSync(projectPath, 'utf8'));
    if (parsed.model_profile) profile = parsed.model_profile;
  } catch { /* no project settings */ }

  // Validate
  if (profile && !['quality', 'balanced', 'budget'].includes(profile)) {
    console.error(`Warning: unknown model_profile "${profile}", using "balanced"`);
    profile = null;
  }

  return profile || DEFAULT_MODEL_PROFILE;
}

/**
 * Load model_overrides from settings layers.
 * Returns merged map: { 'forge-planner': 'haiku', ... }
 */
function loadModelOverrides() {
  let overrides = {};

  // Global layer
  try {
    const text = fs.readFileSync(GLOBAL_SETTINGS_PATH, 'utf8');
    const parsed = parseFrontmatter(text);
    if (parsed.model_overrides && typeof parsed.model_overrides === 'object') {
      overrides = { ...parsed.model_overrides };
    }
  } catch { /* no global settings */ }

  // Project layer (overrides global per-key)
  try {
    const projectPath = path.resolve(process.cwd(), PROJECT_SETTINGS_NAME);
    const parsed = parseSimpleYaml(fs.readFileSync(projectPath, 'utf8'));
    if (parsed.model_overrides && typeof parsed.model_overrides === 'object') {
      overrides = { ...overrides, ...parsed.model_overrides };
    }
  } catch { /* no project settings */ }

  return overrides;
}

/**
 * Resolve the effective model for an agent name.
 * Returns { model, source } where model is 'inherit'|'sonnet'|'haiku'|null
 */
function resolveAgentModel(agentName) {
  // Normalize: accept both 'planner' and 'forge-planner'
  const normalized = ROLE_TO_AGENT[agentName] || agentName;

  // 1. Check per-agent overrides
  const overrides = loadModelOverrides();
  if (overrides[normalized]) {
    const raw = overrides[normalized];
    return { model: raw === 'opus' ? 'inherit' : raw, source: 'override' };
  }

  // 2. Look up in profile table
  const profileEntry = MODEL_PROFILES[normalized];
  if (!profileEntry) {
    return { model: null, source: null };
  }

  const profile = loadModelProfile();
  const raw = profileEntry[profile];
  return {
    model: raw === 'opus' ? 'inherit' : raw,
    source: `profile:${profile}`,
  };
}

module.exports = {
  // Constants
  GLOBAL_SETTINGS_PATH,
  PROJECT_SETTINGS_NAME,
  SETTINGS_DEFAULTS,
  SETTINGS_DESCRIPTIONS,
  MODEL_PROFILES,
  ROLE_TO_AGENT,
  DEFAULT_MODEL_PROFILE,
  // YAML helpers
  parseSimpleYaml,
  toSimpleYaml,
  parseFrontmatter,
  writeFrontmatter,
  // Connection helpers
  isDoltConnectionError,
  restartDolt,
  // Exec helpers
  bd,
  bdArgs,
  bdJson,
  git,
  gh,
  output,
  // Model resolution
  loadModelProfile,
  loadModelOverrides,
  resolveAgentModel,
};
