#!/usr/bin/env node
'use strict';

/**
 * core.cjs -- Shared helpers and constants for forge-tools modules.
 *
 * Exports: parseSimpleYaml, toSimpleYaml, parseFrontmatter, writeFrontmatter,
 *          isDoltConnectionError, restartDolt, bd, bdArgs, bdJson, git, gh,
 *          output, resolveAgentModel, loadModelProfile, loadModelOverrides,
 *          generateDashboardHTML, esc, and all constants.
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

// --- Dashboard HTML Generator ---

function esc(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function generateDashboardHTML(data) {
  const {
    projectTitle, projectId, timestamp, progressPercent,
    totalPhases, completedPhases, phaseDetails, reqCoverage,
  } = data;

  const phasesOpen = phaseDetails.filter(p => p.status === 'open').length;
  const phasesInProgress = phaseDetails.filter(p => p.status === 'in_progress').length;
  const reqsCovered = reqCoverage.filter(r => r.covered).length;
  const reqsTotal = reqCoverage.length;

  // Build phase cards HTML
  const phaseCardsHTML = phaseDetails.map((phase, i) => {
    const pct = phase.tasks_total > 0 ? Math.round((phase.tasks_closed / phase.tasks_total) * 100) : 0;
    const statusClass = phase.status === 'closed' ? 'phase-done' : phase.status === 'in_progress' ? 'phase-active' : 'phase-pending';
    const statusBadge = phase.status === 'closed' ? 'Done' : phase.status === 'in_progress' ? 'Active' : 'Pending';
    const tasksHTML = phase.tasks.map(t => {
      const icon = t.status === 'closed' ? '&#x2713;' : t.status === 'in_progress' ? '&#x25B6;' : '&#x25CB;';
      const cls = t.status === 'closed' ? 'task-done' : t.status === 'in_progress' ? 'task-active' : 'task-pending';
      const hasDetails = t.description || t.acceptance_criteria;
      const detailsHTML = hasDetails ? `
        <div class="task-details">
          ${t.description ? `<div class="task-desc"><strong>Description:</strong> ${esc(t.description)}</div>` : ''}
          ${t.acceptance_criteria ? `<div class="task-ac"><strong>Acceptance Criteria:</strong><pre>${esc(t.acceptance_criteria)}</pre></div>` : ''}
        </div>` : '';
      return `<li class="${cls}">
        <details${hasDetails ? '' : ' class="no-detail"'}>
          <summary><span class="task-icon">${icon}</span> ${esc(t.title)} <code>${t.id}</code></summary>
          ${detailsHTML}
        </details>
      </li>`;
    }).join('\n');
    const phaseDescHTML = phase.description ? `<p class="phase-desc">${esc(phase.description)}</p>` : '';
    return `
      <div class="phase-card ${statusClass}" id="phase-${phase.id}">
        <div class="phase-header">
          <h3>${esc(phase.title)}</h3>
          <span class="badge badge-${statusClass}">${statusBadge}</span>
        </div>
        ${phaseDescHTML}
        <div class="progress-bar-container">
          <div class="progress-bar" style="width:${pct}%"></div>
        </div>
        <div class="phase-stats">${phase.tasks_closed}/${phase.tasks_total} tasks &middot; ${pct}%</div>
        ${phase.tasks.length > 0 ? `<ul class="task-list">${tasksHTML}</ul>` : '<p class="no-tasks">No tasks</p>'}
      </div>`;
  }).join('\n');

  // Build requirement heat map HTML
  const reqGridHTML = reqCoverage.map(r => {
    const cls = r.covered ? 'req-covered' : 'req-uncovered';
    return `<div class="req-cell ${cls}" title="${esc(r.title)} (${r.id})${r.covered ? ' — ' + r.covering_tasks + ' tasks' : ' — UNCOVERED'}">${esc(r.title.length > 30 ? r.title.slice(0, 28) + '…' : r.title)}</div>`;
  }).join('\n');

  // Build blockers HTML
  const blockers = [];
  for (const phase of phaseDetails) {
    if (phase.status === 'blocked') {
      blockers.push({ type: 'phase', id: phase.id, title: phase.title });
    }
    for (const t of phase.tasks) {
      if (t.status === 'blocked') {
        blockers.push({ type: 'task', id: t.id, title: t.title, phase: phase.title });
      }
    }
  }
  const blockersHTML = blockers.length === 0
    ? '<p class="no-blockers">No blockers detected</p>'
    : blockers.map(b => `<div class="blocker-item"><span class="blocker-type">${b.type}</span> <strong>${esc(b.title)}</strong> <code>${b.id}</code>${b.phase ? ` <span class="blocker-phase">in ${esc(b.phase)}</span>` : ''}</div>`).join('\n');

  // Chart.js data
  const chartData = JSON.stringify({
    phaseLabels: ['Completed', 'In Progress', 'Open'],
    phaseValues: [completedPhases, phasesInProgress, phasesOpen],
    phaseColors: ['#2ecc71', '#f39c12', '#95a5a6'],
    reqLabels: ['Covered', 'Uncovered'],
    reqValues: [reqsCovered, reqsTotal - reqsCovered],
    reqColors: ['#2ecc71', '#e74c3c'],
  });

  // Sidebar TOC items
  const tocItems = [
    { href: '#overview', label: 'Overview' },
    { href: '#phases', label: 'Phases' },
    { href: '#requirements', label: 'Requirements' },
    { href: '#blockers', label: 'Blockers' },
    { href: '#charts', label: 'Charts' },
  ];
  const tocHTML = tocItems.map(t => `<a href="${t.href}">${t.label}</a>`).join('\n');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${esc(projectTitle)} — Dashboard</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@300;400;500;600;700&family=IBM+Plex+Mono:wght@400;500&display=swap" rel="stylesheet">
<script src="https://cdn.jsdelivr.net/npm/chart.js@4/dist/chart.umd.min.js"><\/script>
<style>
  :root {
    --bg: #0d1117;
    --surface: #161b22;
    --surface-2: #1c2128;
    --border: #30363d;
    --text: #e6edf3;
    --text-muted: #8b949e;
    --accent: #58a6ff;
    --green: #2ecc71;
    --orange: #f39c12;
    --red: #e74c3c;
    --blue: #58a6ff;
    --sidebar-w: 200px;
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: 'IBM Plex Sans', -apple-system, sans-serif;
    background: var(--bg);
    color: var(--text);
    line-height: 1.6;
    display: grid;
    grid-template-columns: var(--sidebar-w) 1fr;
    min-height: 100vh;
  }
  code, .mono { font-family: 'IBM Plex Mono', monospace; font-size: 0.85em; color: var(--text-muted); }

  /* Sidebar */
  .sidebar {
    position: sticky;
    top: 0;
    height: 100vh;
    background: var(--surface);
    border-right: 1px solid var(--border);
    padding: 2rem 1rem;
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }
  .sidebar h2 { font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.1em; color: var(--text-muted); margin-bottom: 0.5rem; }
  .sidebar a {
    display: block;
    color: var(--text-muted);
    text-decoration: none;
    padding: 0.4rem 0.75rem;
    border-radius: 6px;
    font-size: 0.9rem;
    transition: all 0.15s;
  }
  .sidebar a:hover { color: var(--text); background: var(--surface-2); }

  /* Main */
  .main { padding: 2.5rem 3rem; width: 100%; }
  .main h1 { font-size: 1.75rem; font-weight: 600; margin-bottom: 0.25rem; }
  .subtitle { color: var(--text-muted); font-size: 0.85rem; margin-bottom: 2rem; }

  /* Overview */
  .overview-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 1rem; margin-bottom: 2.5rem; }
  .stat-card {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 1.25rem;
  }
  .stat-card .stat-value { font-size: 2rem; font-weight: 700; line-height: 1; }
  .stat-card .stat-label { font-size: 0.8rem; color: var(--text-muted); margin-top: 0.25rem; }
  .stat-card.accent .stat-value { color: var(--accent); }
  .stat-card.green .stat-value { color: var(--green); }
  .stat-card.orange .stat-value { color: var(--orange); }

  /* Big progress */
  .big-progress { margin-bottom: 2.5rem; }
  .big-progress-bar {
    width: 100%;
    height: 12px;
    background: var(--surface-2);
    border-radius: 6px;
    overflow: hidden;
  }
  .big-progress-fill { height: 100%; background: linear-gradient(90deg, var(--green), var(--accent)); border-radius: 6px; transition: width 0.5s; }
  .big-progress-label { text-align: right; font-size: 0.85rem; color: var(--text-muted); margin-top: 0.25rem; }

  /* Section */
  section { margin-bottom: 2.5rem; }
  section h2 { font-size: 1.25rem; font-weight: 600; margin-bottom: 1rem; border-bottom: 1px solid var(--border); padding-bottom: 0.5rem; }

  /* Phase cards */
  .phase-card {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 1.25rem;
    margin-bottom: 1rem;
  }
  .phase-card.phase-active { border-left: 3px solid var(--orange); }
  .phase-card.phase-done { border-left: 3px solid var(--green); opacity: 0.8; }
  .phase-card.phase-pending { border-left: 3px solid var(--border); }
  .phase-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 0.5rem; }
  .phase-header h3 { font-size: 1rem; font-weight: 500; }
  .badge { font-size: 0.7rem; padding: 0.2rem 0.6rem; border-radius: 12px; text-transform: uppercase; letter-spacing: 0.05em; font-weight: 600; }
  .badge-phase-done { background: rgba(46,204,113,0.15); color: var(--green); }
  .badge-phase-active { background: rgba(243,156,18,0.15); color: var(--orange); }
  .badge-phase-pending { background: rgba(139,148,158,0.15); color: var(--text-muted); }
  .progress-bar-container { width: 100%; height: 4px; background: var(--surface-2); border-radius: 2px; overflow: hidden; margin-bottom: 0.35rem; }
  .progress-bar { height: 100%; background: var(--accent); border-radius: 2px; }
  .phase-stats { font-size: 0.8rem; color: var(--text-muted); margin-bottom: 0.5rem; }
  .task-list { list-style: none; padding: 0; }
  .task-list li { padding: 0.3rem 0; font-size: 0.85rem; display: flex; align-items: center; gap: 0.5rem; }
  .task-icon { width: 1.2em; text-align: center; flex-shrink: 0; }
  .task-done { color: var(--green); }
  .task-active { color: var(--orange); }
  .task-pending { color: var(--text-muted); }
  .no-tasks { color: var(--text-muted); font-size: 0.85rem; font-style: italic; }
  .phase-desc { color: var(--text-muted); font-size: 0.85rem; margin-bottom: 0.5rem; }
  .task-list details summary { cursor: pointer; display: flex; align-items: center; gap: 0.5rem; list-style: none; }
  .task-list details summary::-webkit-details-marker { display: none; }
  .task-list details[open] summary { margin-bottom: 0.4rem; }
  .task-details { margin-left: 1.7rem; padding: 0.5rem 0.75rem; background: var(--surface-2); border-radius: 6px; font-size: 0.8rem; color: var(--text-muted); }
  .task-details pre { white-space: pre-wrap; font-family: 'IBM Plex Mono', monospace; font-size: 0.78rem; margin-top: 0.25rem; }
  .task-desc, .task-ac { margin-bottom: 0.4rem; }
  .no-detail summary { cursor: default; }

  /* Requirements heat map */
  .req-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 0.5rem; }
  .req-cell {
    padding: 0.6rem 0.8rem;
    border-radius: 6px;
    font-size: 0.8rem;
    font-weight: 500;
  }
  .req-covered { background: rgba(46,204,113,0.12); color: var(--green); border: 1px solid rgba(46,204,113,0.25); }
  .req-uncovered { background: rgba(231,76,60,0.12); color: var(--red); border: 1px solid rgba(231,76,60,0.25); }

  /* Blockers */
  .blocker-item {
    background: rgba(231,76,60,0.08);
    border: 1px solid rgba(231,76,60,0.2);
    border-radius: 6px;
    padding: 0.75rem 1rem;
    margin-bottom: 0.5rem;
    font-size: 0.9rem;
  }
  .blocker-type { font-size: 0.7rem; text-transform: uppercase; color: var(--red); font-weight: 600; margin-right: 0.5rem; }
  .blocker-phase { color: var(--text-muted); font-size: 0.8rem; }
  .no-blockers { color: var(--green); font-size: 0.9rem; }

  /* Charts */
  .chart-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 2rem; }
  .chart-container { background: var(--surface); border: 1px solid var(--border); border-radius: 8px; padding: 1.5rem; }
  .chart-container h3 { font-size: 0.9rem; font-weight: 500; margin-bottom: 1rem; color: var(--text-muted); }
  canvas { max-height: 250px; }

  @media (max-width: 768px) {
    body { grid-template-columns: 1fr; }
    .sidebar { display: none; }
    .main { padding: 1.5rem; }
    .overview-grid { grid-template-columns: repeat(2, 1fr); }
    .chart-grid { grid-template-columns: 1fr; }
  }
</style>
</head>
<body>
<nav class="sidebar">
  <h2>Dashboard</h2>
  ${tocHTML}
</nav>
<main class="main">
  <h1>${esc(projectTitle)}</h1>
  <p class="subtitle">Generated ${timestamp} &middot; <code>${projectId}</code></p>

  <div class="big-progress" id="overview">
    <div class="big-progress-bar"><div class="big-progress-fill" style="width:${progressPercent}%"></div></div>
    <div class="big-progress-label">${progressPercent}% complete</div>
  </div>

  <div class="overview-grid">
    <div class="stat-card accent"><div class="stat-value">${totalPhases}</div><div class="stat-label">Total Phases</div></div>
    <div class="stat-card green"><div class="stat-value">${completedPhases}</div><div class="stat-label">Completed</div></div>
    <div class="stat-card orange"><div class="stat-value">${phasesInProgress}</div><div class="stat-label">In Progress</div></div>
    <div class="stat-card"><div class="stat-value">${reqsTotal}</div><div class="stat-label">Requirements</div></div>
  </div>

  <section id="phases">
    <h2>Phases</h2>
    ${phaseCardsHTML}
  </section>

  <section id="requirements">
    <h2>Requirement Coverage (${reqsCovered}/${reqsTotal})</h2>
    ${reqsTotal > 0 ? `<div class="req-grid">${reqGridHTML}</div>` : '<p style="color:var(--text-muted)">No requirements defined</p>'}
  </section>

  <section id="blockers">
    <h2>Blockers</h2>
    ${blockersHTML}
  </section>

  <section id="charts">
    <h2>Charts</h2>
    <div class="chart-grid">
      <div class="chart-container">
        <h3>Phase Status</h3>
        <canvas id="phaseChart"></canvas>
      </div>
      <div class="chart-container">
        <h3>Requirement Coverage</h3>
        <canvas id="reqChart"></canvas>
      </div>
    </div>
  </section>
</main>
<script>
  const d = ${chartData};
  const chartOpts = { responsive: true, plugins: { legend: { labels: { color: '#e6edf3', font: { family: 'IBM Plex Sans' } } } } };
  new Chart(document.getElementById('phaseChart'), {
    type: 'doughnut',
    data: { labels: d.phaseLabels, datasets: [{ data: d.phaseValues, backgroundColor: d.phaseColors, borderWidth: 0 }] },
    options: chartOpts,
  });
  new Chart(document.getElementById('reqChart'), {
    type: 'doughnut',
    data: { labels: d.reqLabels, datasets: [{ data: d.reqValues, backgroundColor: d.reqColors, borderWidth: 0 }] },
    options: chartOpts,
  });
<\/script>
</body>
</html>`;
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
  // Dashboard
  generateDashboardHTML,
  esc,
};
