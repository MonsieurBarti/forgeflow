#!/usr/bin/env node
'use strict';

/**
 * core.cjs -- Shared helpers and constants for forge-tools modules.
 *
 * Exports: parseSimpleYaml, toSimpleYaml, parseFrontmatter, writeFrontmatter,
 *          isDoltConnectionError, restartDolt, bd, bdArgs, bdJson, git, gh,
 *          output, forgeError, resolveAgentModel, loadModelProfile, loadModelOverrides,
 *          findGitRoot, resolveSettings, resolveSettingsPath, deepMerge,
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
  quality_gate: true,
};

const SETTINGS_DESCRIPTIONS = {
  skip_verification: 'Skip phase verification after execution',
  auto_commit: 'Auto-commit after each completed task',
  require_discussion: 'Require user discussion before planning',
  auto_research: 'Auto-run research before planning',
  plan_check: 'Run plan checker to validate plans',
  parallel_execution: 'Execute independent tasks in parallel',
  quality_gate: 'Run pre-PR quality pipeline (security, code review, performance audits)',
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
  'forge-security-auditor':  { quality: 'sonnet', balanced: 'sonnet', budget: 'haiku' },
  'forge-code-reviewer':     { quality: 'sonnet', balanced: 'sonnet', budget: 'haiku' },
  'forge-performance-auditor':{ quality: 'sonnet', balanced: 'sonnet', budget: 'haiku' },
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
  security_auditor: 'forge-security-auditor',
  code_reviewer: 'forge-code-reviewer',
  performance_auditor: 'forge-performance-auditor',
};

const DEFAULT_MODEL_PROFILE = 'balanced';

// --- Simple YAML Helpers ---

// Keys that must never be assigned to avoid prototype pollution
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

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
    if (FORBIDDEN_KEYS.has(key)) continue;
    let val = trimmed.slice(colonIdx + 1).trim();

    if (indent > 0 && currentSection) {
      // Nested key under current section (FORBIDDEN_KEYS already checked above)
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
    // Give Dolt a moment to become ready.
    // NOTE: Synchronous sleep via Atomics.wait blocks the event loop for 2s.
    // The execFileSync-based architecture prevents using async alternatives here.
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2000);
  } catch (_) {
    // Ignore restart errors; the retry will surface the real failure
  }
}

function _bdExec(argList, opts = {}) {
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
      return _bdExec(argList, { ...opts, _retry: true });
    }
    if (opts.allowFail) return '';
    throw err;
  }
}

function bd(args, opts = {}) {
  const argList = Array.isArray(args) ? args : args.split(/\s+/);
  return _bdExec(argList, opts);
}

function bdArgs(argList, opts = {}) {
  return _bdExec(argList, opts);
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
    const truncated = raw.length > 200 ? raw.slice(0, 200) + '...' : raw;
    console.error('[bdJson] Parse failure for:', args, 'raw:', truncated);
    return null;
  }
}

/**
 * Like bdJson() but accepts an array of arguments (safe from injection).
 * Appends --json to the argument list.
 */
function bdJsonArgs(argList) {
  const raw = _bdExec([...argList, '--json']);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (argList[0] === 'show' && Array.isArray(parsed)) {
      return parsed[0] !== undefined ? parsed[0] : null;
    }
    return parsed;
  } catch {
    const truncated = raw.length > 200 ? raw.slice(0, 200) + '...' : raw;
    console.error('[bdJsonArgs] Parse failure for:', argList.join(' '), 'raw:', truncated);
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

/**
 * Normalize the result of bdJson('children ...') into a flat array.
 * bd may return an array directly, or an object with .issues / .children.
 */
function normalizeChildren(raw) {
  return Array.isArray(raw) ? raw : (raw?.issues || raw?.children || []);
}

function output(data) {
  process.stdout.write(JSON.stringify(data, null, 2) + '\n');
}

/**
 * Emit a structured JSON error to stdout and exit with code 1.
 *
 * All forge-tools errors pass through this helper so that consuming workflows
 * receive a machine-readable object they can parse and act on.
 *
 * @param {string} code        UPPER_SNAKE_CASE error code (e.g. MISSING_ARG, NOT_FOUND)
 * @param {string} message     Human-readable description of what went wrong
 * @param {string} suggestion  Concrete next step the user can take to fix the issue
 * @param {object} [context]   Optional bag of extra data relevant to the error
 */
function forgeError(code, message, suggestion, context) {
  const payload = { error: true, code, message, suggestion };
  if (context !== undefined && context !== null) {
    payload.context = context;
  }
  process.stdout.write(JSON.stringify(payload, null, 2) + '\n');
  process.exit(1);
}

// --- Settings Resolution ---

// Module-level cache for findGitRoot results, keyed by normalized `from` path
const _gitRootCache = new Map();

// Module-level cache for resolveSettings results, keyed by normalized cwd
const _settingsCache = new Map();

/**
 * Find the git repository root from a given directory.
 * Results are memoized per normalized path to avoid redundant subprocess spawns.
 */
function findGitRoot(from) {
  const key = path.normalize(from || process.cwd());
  if (_gitRootCache.has(key)) return _gitRootCache.get(key);
  let result = null;
  try {
    result = execFileSync('git', ['rev-parse', '--show-toplevel'], {
      encoding: 'utf8',
      timeout: 5000,
      cwd: key,
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
  } catch (err) {
    // status 128 means not a git repo — expected; other errors are surprising
    if (err.status !== 128) {
      console.warn(`[findGitRoot] unexpected git error (status ${err.status}) for path "${key}"`);
    }
    result = null;
  }
  _gitRootCache.set(key, result);
  return result;
}

/**
 * Deep-merge source into target (mutates target). Source values win.
 * Objects are merged recursively; primitives and arrays are replaced.
 */
function deepMerge(target, source) {
  for (const key of Object.keys(source)) {
    if (
      source[key] && typeof source[key] === 'object' && !Array.isArray(source[key]) &&
      target[key] && typeof target[key] === 'object' && !Array.isArray(target[key])
    ) {
      deepMerge(target[key], source[key]);
    } else {
      target[key] = source[key];
    }
  }
  return target;
}

/**
 * Resolve the path to the nearest app-level .forge/settings.yaml between cwd
 * and the git root. Returns null if cwd is the git root or no app settings exist.
 */
function resolveSettingsPath(cwd, gitRoot) {
  if (!cwd || !gitRoot) return null;
  const normalCwd = path.resolve(cwd);
  const normalRoot = path.resolve(gitRoot);
  if (normalCwd === normalRoot) return null;

  // Walk from cwd up to (but not including) git root
  let dir = normalCwd;
  while (dir.startsWith(normalRoot + path.sep)) {
    const candidate = path.join(dir, PROJECT_SETTINGS_NAME);
    if (fs.existsSync(candidate)) return candidate;
    dir = path.dirname(dir);
  }
  return null;
}

/**
 * Resolve settings with cascading merge:
 *   1. SETTINGS_DEFAULTS as base
 *   2. git-root/.forge/settings.yaml merged over defaults
 *   3. app-level .forge/settings.yaml (if cwd is inside a workspace app) merged over root
 *
 * Returns the merged settings object.
 */
function resolveSettings(cwd) {
  const effectiveCwd = cwd || process.cwd();
  const cacheKey = path.normalize(effectiveCwd);
  if (_settingsCache.has(cacheKey)) return _settingsCache.get(cacheKey);
  const gitRoot = findGitRoot(effectiveCwd);

  // Start with defaults
  const settings = { ...SETTINGS_DEFAULTS };

  if (!gitRoot) return settings;

  // Layer 1: root settings
  const rootSettingsPath = path.join(gitRoot, PROJECT_SETTINGS_NAME);
  let rootSettings = {};
  try {
    rootSettings = parseSimpleYaml(fs.readFileSync(rootSettingsPath, 'utf8'));
  } catch { /* no root settings */ }
  deepMerge(settings, rootSettings);

  // Layer 2: app-level settings (only if cwd differs from git root)
  const appSettingsPath = resolveSettingsPath(effectiveCwd, gitRoot);
  if (appSettingsPath) {
    try {
      const appSettings = parseSimpleYaml(fs.readFileSync(appSettingsPath, 'utf8'));
      deepMerge(settings, appSettings);
    } catch { /* unreadable app settings */ }
  }

  _settingsCache.set(cacheKey, settings);
  return settings;
}

// --- Model Resolution ---

let _modelProfileCache = null;
let _modelOverridesCache = null;

/**
 * Load the active model profile name from settings layers.
 * Resolution: project model_profile > global model_profile > 'balanced'
 */
function loadModelProfile() {
  if (_modelProfileCache !== null) return _modelProfileCache;
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

  _modelProfileCache = profile || DEFAULT_MODEL_PROFILE;
  return _modelProfileCache;
}

/**
 * Load model_overrides from settings layers.
 * Returns merged map: { 'forge-planner': 'haiku', ... }
 */
function loadModelOverrides() {
  if (_modelOverridesCache !== null) return _modelOverridesCache;
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

  _modelOverridesCache = overrides;
  return _modelOverridesCache;
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
  bdJsonArgs,
  git,
  gh,
  output,
  normalizeChildren,
  forgeError,
  // Settings resolution
  findGitRoot,
  resolveSettings,
  resolveSettingsPath,
  deepMerge,
  // Model resolution
  loadModelProfile,
  loadModelOverrides,
  resolveAgentModel,
};
