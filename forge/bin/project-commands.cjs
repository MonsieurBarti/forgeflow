'use strict';

/**
 * project-commands.cjs -- Project, settings, model, config, debug, todo, and milestone commands.
 *
 * Commands: find-project, progress, project-context, full-progress, generate-dashboard,
 *           save-session, load-session, settings-load, settings-set, settings-clear,
 *           settings-bulk, resolve-model, model-for-role, model-profiles,
 *           config-get, config-set, config-list, config-clear, health,
 *           debug-list, debug-create, debug-update, todo-list, todo-create,
 *           milestone-list, milestone-audit, milestone-create, monorepo-create, remember, init-quick
 */

const fs = require('fs');
const path = require('path');
const { homedir } = require('os');
const {
  bd, bdArgs, bdJson, output, forgeError, normalizeChildren,
  GLOBAL_SETTINGS_PATH, PROJECT_SETTINGS_NAME,
  SETTINGS_DEFAULTS, SETTINGS_DESCRIPTIONS,
  MODEL_PROFILES, ROLE_TO_AGENT,
  parseSimpleYaml, toSimpleYaml, parseFrontmatter, writeFrontmatter,
  resolveAgentModel, loadModelProfile, loadModelOverrides,
  findGitRoot,
} = require('./core.cjs');

/**
 * Parse a bd create result to extract the bead ID.
 * Tries JSON first, falls back to regex match.
 */
function parseBdCreateId(result) {
  if (!result) return null;
  try {
    const data = JSON.parse(result);
    return data.id || data.issue_id || null;
  } catch {
    const match = result.match(/([a-z]+-[a-z0-9]+)/);
    return match ? match[1] : null;
  }
}

/**
 * Coerce string 'true'/'false' to boolean, pass through everything else.
 */
function coerceBool(v) {
  if (v === 'true') return true;
  if (v === 'false') return false;
  return v;
}

/**
 * Parse a dot-separated settings key into { topKey, subKey, isNested }.
 */
function parseDotKey(key) {
  const dotIdx = key.indexOf('.');
  const isNested = dotIdx !== -1;
  return {
    topKey: isNested ? key.slice(0, dotIdx) : key,
    subKey: isNested ? key.slice(dotIdx + 1) : null,
    isNested,
  };
}

/**
 * Load settings merged from defaults < global < project.
 * Returns { merged, sources }.
 */
function loadMergedSettings() {
  const merged = { ...SETTINGS_DEFAULTS };
  const sources = {};
  for (const key of Object.keys(SETTINGS_DEFAULTS)) {
    sources[key] = 'default';
  }

  try {
    const globalText = fs.readFileSync(GLOBAL_SETTINGS_PATH, 'utf8');
    const globalSettings = parseFrontmatter(globalText);
    for (const [key, val] of Object.entries(globalSettings)) {
      if (key in SETTINGS_DEFAULTS) {
        merged[key] = val;
        sources[key] = 'global';
      }
    }
  } catch {
    // No global settings file
  }

  try {
    const projectPath = path.resolve(process.cwd(), PROJECT_SETTINGS_NAME);
    const projectText = fs.readFileSync(projectPath, 'utf8');
    const projectSettings = parseSimpleYaml(projectText);
    for (const [key, val] of Object.entries(projectSettings)) {
      if (key in SETTINGS_DEFAULTS) {
        merged[key] = val;
        sources[key] = 'project';
      }
    }
  } catch {
    // No project settings file
  }

  return { merged, sources };
}

/**
 * Stamp _sortKey on phase detail objects, sort, then clean up the transient key.
 */
function sortPhaseDetails(details) {
  for (const pd of details) {
    pd._sortKey = parseFloat((pd.title.match(/Phase\s+([\d.]+)/i) || [])[1]) || 999;
  }
  details.sort((a, b) => a._sortKey - b._sortKey);
  for (const pd of details) {
    delete pd._sortKey;
  }
  return details;
}

/**
 * Named color map (module-level constant for reuse).
 */
const COLOR_MAP = {
  red: '#e74c3c', orange: '#f39c12', yellow: '#f1c40f', green: '#2ecc71',
  blue: '#3498db', purple: '#9b59b6', cyan: '#00bcd4', pink: '#e91e63',
  indigo: '#6366f1', teal: '#14b8a6', amber: '#f59e0b', crimson: '#dc2626',
  magenta: '#d946ef', lime: '#84cc16', violet: '#8b5cf6', emerald: '#10b981',
  rose: '#f43f5e', sky: '#0ea5e9', slate: '#64748b', gray: '#6b7280',
  white: '#fafafa', gold: '#eab308',
};

/** Hex color pattern for validation */
const HEX_COLOR_RE = /^#[0-9a-fA-F]{3,6}$/;

/** Safe fallback color when an untrusted value fails validation */
const SAFE_FALLBACK_COLOR = '#8b949e';

/**
 * Expand simple glob patterns (e.g., "apps/*", "packages/*") to package directories.
 * Complex globs containing intermediate wildcards are skipped.
 */
function expandGlobs(patterns, root) {
  const results = [];
  for (const pattern of patterns) {
    const clean = pattern.replace(/\/\*\*?$/, '').replace(/\*$/, '');
    if (clean.includes('*')) continue; // skip complex globs
    const dir = path.join(root, clean);
    if (fs.statSync(dir, { throwIfNoEntry: false })?.isDirectory()) {
      // If the pattern ended with /*, list subdirectories
      if (pattern.endsWith('/*') || pattern.endsWith('/**')) {
        try {
          const entries = fs.readdirSync(dir, { withFileTypes: true });
          for (const entry of entries) {
            if (entry.isDirectory() && !entry.name.startsWith('.')) {
              const pkgPath = path.join(clean, entry.name);
              const pkgJsonPath = path.join(root, pkgPath, 'package.json');
              let name = entry.name;
              try {
                const pkg = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf8'));
                if (pkg.name) name = pkg.name;
              } catch { /* use dir name */ }
              results.push({ name, path: pkgPath });
            }
          }
        } catch { /* skip unreadable */ }
      } else {
        // Direct path (no glob)
        const pkgJsonPath = path.join(root, clean, 'package.json');
        let name = path.basename(clean);
        try {
          const pkg = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf8'));
          if (pkg.name) name = pkg.name;
        } catch { /* use dir name */ }
        results.push({ name, path: clean });
      }
    }
  }
  return results;
}

/**
 * Detect workspace packages from turbo.json, nx.json, or pnpm-workspace.yaml.
 * Returns { source: string, packages: Array<{ name: string, path: string }> }
 */
function detectWorkspaces(rootDir) {
  // Read root package.json once and reuse across all branches that need it
  let rootPkg = null;
  try {
    rootPkg = JSON.parse(fs.readFileSync(path.join(rootDir, 'package.json'), 'utf8'));
  } catch { /* no root package.json */ }

  // Try pnpm-workspace.yaml
  const pnpmPath = path.join(rootDir, 'pnpm-workspace.yaml');
  if (fs.existsSync(pnpmPath)) {
    try {
      const raw = fs.readFileSync(pnpmPath, 'utf8');
      // pnpm-workspace.yaml has: packages: ["apps/*", "packages/*"]
      // parseSimpleYaml may not handle arrays well, so parse manually
      const patterns = [];
      const lines = raw.split('\n');
      let inPackages = false;
      for (const line of lines) {
        if (/^packages\s*:/.test(line)) { inPackages = true; continue; }
        if (inPackages) {
          const m = line.match(/^\s*-\s*['"]?([^'"]+)['"]?\s*$/);
          if (m) patterns.push(m[1].trim());
          else if (line.trim() && !line.startsWith(' ') && !line.startsWith('\t')) break;
        }
      }
      if (patterns.length > 0) {
        return { source: 'pnpm-workspace.yaml', packages: expandGlobs(patterns, rootDir) };
      }
    } catch { /* fall through */ }
  }

  // Try turbo.json (Turborepo reads workspaces from package.json)
  const turboPath = path.join(rootDir, 'turbo.json');
  if (fs.existsSync(turboPath) && rootPkg) {
    const workspaces = Array.isArray(rootPkg.workspaces) ? rootPkg.workspaces : (rootPkg.workspaces?.packages || []);
    if (workspaces.length > 0) {
      return { source: 'turbo.json+package.json', packages: expandGlobs(workspaces, rootDir) };
    }
  }

  // Try nx.json
  const nxPath = path.join(rootDir, 'nx.json');
  if (fs.existsSync(nxPath) && rootPkg) {
    const workspaces = Array.isArray(rootPkg.workspaces) ? rootPkg.workspaces : (rootPkg.workspaces?.packages || []);
    if (workspaces.length > 0) {
      return { source: 'nx.json+package.json', packages: expandGlobs(workspaces, rootDir) };
    }
  }

  // Fallback: check package.json workspaces directly (yarn/npm workspaces)
  if (rootPkg) {
    const workspaces = Array.isArray(rootPkg.workspaces) ? rootPkg.workspaces : (rootPkg.workspaces?.packages || []);
    if (workspaces.length > 0) {
      return { source: 'package.json', packages: expandGlobs(workspaces, rootDir) };
    }
  }

  return { source: 'none', packages: [] };
}

/**
 * Extract workspace_path from a forge:project bead's design field.
 *
 * Two storage formats are supported:
 *   1. Nested map (monorepo parent): workspace_paths keyed by child bead ID
 *        workspace_paths:
 *          <bead-id>: packages/app1
 *   2. Flat field (child project beads):
 *        workspace_path: packages/app1
 *
 * Bead IDs match [a-z]+-[a-z0-9]+ and therefore never contain colons,
 * so YAML key parsing is unambiguous.
 *
 * Lookup cascade: (1) keyed by bead.id in workspace_paths, (2) flat workspace_path.
 * No sole-entry shortcut — a missing key means "not this bead's entry".
 *
 * Returns the path string for this bead, or null if not found.
 */
function extractWorkspacePath(bead) {
  if (!bead || !bead.design) return null;
  const parsed = parseSimpleYaml(bead.design);
  if (parsed.workspace_paths && typeof parsed.workspace_paths === 'object') {
    // workspace_paths is keyed by bead ID — look up this bead's own entry only
    if (parsed.workspace_paths[bead.id] !== undefined) {
      return String(parsed.workspace_paths[bead.id]);
    }
  }
  // Fallback: check for a flat workspace_path field (used by child project beads)
  if (parsed.workspace_path) return String(parsed.workspace_path);
  return null;
}

/**
 * Collect all phases and requirements for a project, traversing milestones.
 * Hierarchy: Project > Milestone > Phases/Requirements
 * Also picks up any phases/reqs still directly under the project (legacy).
 *
 * Returns:
 *   - milestones: raw milestone beads (for backward compat)
 *   - phases: flat array of all phases across milestones (for backward compat)
 *   - requirements: flat array of all requirements across milestones (for backward compat)
 *   - milestoneDetails: array of milestone objects with nested phases/requirements,
 *     each including { id, title, status, goal, phases, requirements, progress,
 *     phase_count, completed_count }
 */
function collectProjectIssues(projectId) {
  const issues = normalizeChildren(bdJson(`children ${projectId}`));

  const milestones = issues.filter(i => (i.labels || []).includes('forge:milestone'));
  const phases = [];
  const requirements = [];
  const seenIds = new Set();

  // Per-milestone grouping
  const milestoneDetails = [];

  const classifyIssue = (item) => {
    if ((item.labels || []).includes('forge:phase')) return 'phase';
    if ((item.labels || []).includes('forge:req')) return 'req';
    return null;
  };

  // Collect from milestones (correct hierarchy) with per-milestone grouping
  for (const ms of milestones) {
    const msIssues = normalizeChildren(bdJson(`children ${ms.id}`));

    const msPhases = [];
    const msReqs = [];
    for (const i of msIssues) {
      if (seenIds.has(i.id)) continue;
      seenIds.add(i.id);
      const kind = classifyIssue(i);
      if (kind === 'phase') { phases.push(i); msPhases.push(i); }
      else if (kind === 'req') { requirements.push(i); msReqs.push(i); }
    }

    const completedCount = msPhases.filter(p => p.status === 'closed').length;
    const phaseCount = msPhases.length;

    milestoneDetails.push({
      id: ms.id,
      title: ms.title,
      status: ms.status,
      goal: ms.description || '',
      phases: msPhases,
      requirements: msReqs,
      progress: phaseCount > 0 ? Math.round((completedCount / phaseCount) * 100) : 0,
      phase_count: phaseCount,
      completed_count: completedCount,
    });
  }

  // Also collect any legacy direct children (not already seen via milestones)
  const legacyPhases = [];
  const legacyReqs = [];
  for (const i of issues) {
    if (seenIds.has(i.id)) continue;
    seenIds.add(i.id);
    const kind = classifyIssue(i);
    if (kind === 'phase') { phases.push(i); legacyPhases.push(i); }
    else if (kind === 'req') { requirements.push(i); legacyReqs.push(i); }
  }

  // If there are legacy items not under any milestone, group them as "Ungrouped"
  if (legacyPhases.length > 0 || legacyReqs.length > 0) {
    const completedCount = legacyPhases.filter(p => p.status === 'closed').length;
    const phaseCount = legacyPhases.length;
    milestoneDetails.push({
      id: '_ungrouped',
      title: 'Ungrouped',
      status: 'open',
      goal: '',
      phases: legacyPhases,
      requirements: legacyReqs,
      progress: phaseCount > 0 ? Math.round((completedCount / phaseCount) * 100) : 0,
      phase_count: phaseCount,
      completed_count: completedCount,
    });
  }

  return { milestones, phases, requirements, milestoneDetails };
}

/**
 * Build phase detail objects for a list of phases.
 * When includeMeta is true, also fetches description and per-task acceptance_criteria
 * (used by generate-dashboard but not full-progress).
 */
function buildPhaseDetails(phases, { includeMeta = false } = {}) {
  // Fetch all phase completion timestamps in one call
  let completionTimestamps = {};
  if (includeMeta) {
    const raw = bd('memories forge:phase:', { allowFail: true }) || '';
    for (const line of raw.split('\n')) {
      const match = line.match(/forge:phase:([\w-]+):completed\s+(\S+)/);
      if (match) completionTimestamps[match[1]] = match[2];
    }
  }

  const details = [];
  for (const phase of phases) {
    const tasks = normalizeChildren(bdJson(`children ${phase.id}`));
    const entry = {
      id: phase.id,
      title: phase.title,
      status: phase.status,
      tasks_total: tasks.length,
      tasks_open: tasks.filter(t => t.status === 'open').length,
      tasks_in_progress: tasks.filter(t => t.status === 'in_progress').length,
      tasks_closed: tasks.filter(t => t.status === 'closed').length,
      tasks: includeMeta
        ? tasks.map(t => ({ id: t.id, title: t.title, status: t.status, description: t.description || '', acceptance_criteria: t.acceptance_criteria || '' }))
        : tasks.map(t => ({ id: t.id, title: t.title, status: t.status })),
    };
    if (includeMeta) {
      entry.description = phase.description || '';
      entry.completed_at = completionTimestamps[phase.id] || '';
    }
    details.push(entry);
  }
  return details;
}

/**
 * Build requirement coverage objects for a list of requirements.
 * Returns an array of { id, title, covered, covering_tasks }.
 */
function getRequirementCoverage(requirements) {
  const coverage = [];
  for (const req of requirements) {
    const depsRaw = bd(`dep list ${req.id} --direction=up --type validates --json`, { allowFail: true });
    let deps = [];
    if (depsRaw) {
      try { deps = JSON.parse(depsRaw); } catch { /* ignore */ }
    }
    coverage.push({
      id: req.id,
      title: req.title,
      covered: Array.isArray(deps) && deps.length > 0,
      covering_tasks: Array.isArray(deps) ? deps.length : 0,
    });
  }
  return coverage;
}

/**
 * Collect agent roster data by reading agents/*.md frontmatter.
 * Returns an array of { name, description, color, vibe } objects.
 * Looks for agents/ directory relative to the git root, falling back to cwd.
 */
function collectAgentRoster() {
  const gitRoot = findGitRoot(process.cwd());
  const searchDirs = [];
  if (gitRoot) searchDirs.push(path.join(gitRoot, 'agents'));
  searchDirs.push(path.join(process.cwd(), 'agents'));

  let agentsDir = null;
  for (const dir of searchDirs) {
    if (fs.existsSync(dir) && fs.statSync(dir).isDirectory()) {
      agentsDir = dir;
      break;
    }
  }

  if (!agentsDir) return [];

  const agents = [];
  try {
    const files = fs.readdirSync(agentsDir).filter(f => f.endsWith('.md')).sort();
    for (const file of files) {
      try {
        const content = fs.readFileSync(path.join(agentsDir, file), 'utf8');
        const fm = parseFrontmatter(content);
        if (fm.name) {
          agents.push({
            name: fm.name,
            description: fm.description || '',
            color: fm.color || '',
            vibe: fm.vibe || fm.emoji || '',
          });
        }
      } catch { /* skip unreadable agent files */ }
    }
  } catch { /* skip unreadable agents dir */ }

  return agents;
}

// generateDashboardHTML and esc are inlined here since they are only used in generate-dashboard.

function esc(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function generateDashboardHTML(data) {
  const {
    projectTitle, projectId, timestamp, progressPercent,
    totalPhases, completedPhases, phaseDetails, reqCoverage,
    milestones = [], agents = [],
  } = data;

  const phasesOpen = phaseDetails.filter(p => p.status === 'open').length;
  const phasesInProgress = phaseDetails.filter(p => p.status === 'in_progress').length;
  const reqsCovered = reqCoverage.filter(r => r.covered).length;
  const reqsTotal = reqCoverage.length;

  // Gradient accent colors per milestone (cycling)
  const gradients = [
    ['#667eea', '#764ba2'],
    ['#f093fb', '#f5576c'],
    ['#4facfe', '#00f2fe'],
    ['#43e97b', '#38f9d7'],
    ['#fa709a', '#fee140'],
    ['#a18cd1', '#fbc2eb'],
    ['#fccb90', '#d57eeb'],
    ['#e0c3fc', '#8ec5fc'],
  ];

  // Determine active milestone index (first in_progress, or first open, or 0)
  let activeMsIdx = milestones.findIndex(ms => ms.status === 'in_progress');
  if (activeMsIdx === -1) activeMsIdx = milestones.findIndex(ms => ms.status === 'open');
  if (activeMsIdx === -1) activeMsIdx = 0;

  // Build milestone tabs HTML
  const milestoneTabsHTML = milestones.map((ms, i) => {
    const grad = gradients[i % gradients.length];
    const isActive = i === activeMsIdx;
    const isDone = ms.status === 'closed';
    const checkmark = isDone ? '<span class="tab-check">&#x2713;</span>' : '';
    return `<button class="ms-tab${isActive ? ' active' : ''}" data-tab="${i}" style="--tab-c1:${grad[0]};--tab-c2:${grad[1]}">${checkmark}${esc(ms.title)}</button>`;
  }).join('\n      ');

  // Build milestone panels
  const milestonePanelsHTML = milestones.map((ms, i) => {
    const grad = gradients[i % gradients.length];
    const isActive = i === activeMsIdx;
    const msPhases = ms.phases || [];
    const msReqs = ms.requirements || [];
    const msCoveredReqs = msReqs.filter(r => r.covered).length;

    // Phase cards for this milestone
    const phaseCardsHTML = msPhases.map((phase) => {
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
      const completionHTML = phase.status === 'closed'
        ? `<div class="phase-completed">${phase.completed_at ? `Completed ${new Date(phase.completed_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}` : 'Completed'}</div>`
        : '';
      return `
          <div class="phase-card ${statusClass}">
            <div class="phase-header">
              <h3>${esc(phase.title)}</h3>
              <span class="badge badge-${statusClass}">${statusBadge}</span>
            </div>
            ${phaseDescHTML}
            ${completionHTML}
            <div class="progress-bar-container">
              <div class="progress-bar" style="width:${pct}%;background:linear-gradient(90deg,${grad[0]},${grad[1]})"></div>
            </div>
            <div class="phase-stats">${phase.tasks_closed}/${phase.tasks_total} tasks &middot; ${pct}%</div>
            ${phase.tasks.length > 0 ? `<ul class="task-list">${tasksHTML}</ul>` : '<p class="no-tasks">No tasks</p>'}
          </div>`;
    }).join('\n');

    // Requirements for this milestone
    const msReqGridHTML = msReqs.map(r => {
      const cls = r.covered ? 'req-covered' : 'req-uncovered';
      return `<div class="req-cell ${cls}" title="${esc(r.title)} (${r.id})${r.covered ? ' — ' + r.covering_tasks + ' tasks' : ' — UNCOVERED'}">${esc(r.title.length > 30 ? r.title.slice(0, 28) + '\u2026' : r.title)}</div>`;
    }).join('\n');

    return `
      <div class="ms-panel${isActive ? ' active' : ''}" data-panel="${i}">
        <div class="ms-header" style="--ms-c1:${grad[0]};--ms-c2:${grad[1]}">
          <div class="ms-header-content">
            <h2>${esc(ms.title)}</h2>
            ${ms.goal ? `<p class="ms-goal">${esc(ms.goal)}</p>` : ''}
          </div>
          <div class="ms-ring-wrap">
            <svg class="progress-ring" viewBox="0 0 80 80">
              <circle class="progress-ring-bg" cx="40" cy="40" r="34" />
              <circle class="progress-ring-fg" cx="40" cy="40" r="34"
                stroke-dasharray="${Math.round(2 * Math.PI * 34)}"
                stroke-dashoffset="${Math.round(2 * Math.PI * 34 * (1 - ms.progress / 100))}"
                style="stroke:${grad[0]}" />
            </svg>
            <span class="ring-label">${ms.progress}%</span>
          </div>
        </div>
        <div class="ms-stats-row">
          <div class="ms-mini-stat"><span class="ms-mini-val">${ms.phase_count}</span><span class="ms-mini-lbl">Phases</span></div>
          <div class="ms-mini-stat"><span class="ms-mini-val">${ms.completed_count}</span><span class="ms-mini-lbl">Done</span></div>
          <div class="ms-mini-stat"><span class="ms-mini-val">${msReqs.length}</span><span class="ms-mini-lbl">Reqs</span></div>
          <div class="ms-mini-stat"><span class="ms-mini-val">${msCoveredReqs}</span><span class="ms-mini-lbl">Covered</span></div>
        </div>
        <div class="ms-body">
          <h3 class="section-title">Phases</h3>
          ${phaseCardsHTML || '<p class="empty-msg">No phases in this milestone</p>'}
          ${msReqs.length > 0 ? `
          <h3 class="section-title">Requirements (${msCoveredReqs}/${msReqs.length})</h3>
          <div class="req-grid">${msReqGridHTML}</div>` : ''}
        </div>
      </div>`;
  }).join('\n');

  // Agent roster
  const agentCardsHTML = agents.map(a => {
    const colorVal = a.color || SAFE_FALLBACK_COLOR;
    const mapped = COLOR_MAP[colorVal.toLowerCase()];
    // Validate: must be a known named color or a valid hex color
    const resolvedColor = mapped || (HEX_COLOR_RE.test(colorVal) ? colorVal : SAFE_FALLBACK_COLOR);
    return `
        <div class="agent-card" style="--agent-color:${resolvedColor}">
          <div class="agent-vibe">${esc(a.vibe)}</div>
          <div class="agent-name">${esc(a.name)}</div>
          <div class="agent-desc">${esc(a.description)}</div>
          <span class="agent-badge" style="background:${resolvedColor}20;color:${resolvedColor};border:1px solid ${resolvedColor}40">${esc(a.color || 'default')}</span>
        </div>`;
  }).join('\n');

  // Overall SVG progress rings data
  const phaseRingPct = progressPercent;
  const reqRingPct = reqsTotal > 0 ? Math.round((reqsCovered / reqsTotal) * 100) : 0;
  const circumference = Math.round(2 * Math.PI * 54);

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${esc(projectTitle)} - Dashboard</title>
<style>
  :root {
    --bg: #09090b;
    --surface: rgba(255,255,255,0.03);
    --surface-solid: #111113;
    --surface-2: rgba(255,255,255,0.06);
    --surface-hover: rgba(255,255,255,0.08);
    --border: rgba(255,255,255,0.06);
    --border-subtle: rgba(255,255,255,0.04);
    --text: #fafafa;
    --text-secondary: #a1a1aa;
    --text-muted: #71717a;
    --accent: #6366f1;
    --green: #22c55e;
    --orange: #f59e0b;
    --red: #ef4444;
    --blue: #3b82f6;
  }

  * { box-sizing: border-box; margin: 0; padding: 0; }

  body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    background: var(--bg);
    color: var(--text);
    line-height: 1.6;
    min-height: 100vh;
  }

  code, .mono {
    font-family: ui-monospace, 'SF Mono', SFMono-Regular, Menlo, Consolas, monospace;
    font-size: 0.8em;
    color: var(--text-muted);
  }

  /* --- Header --- */
  .dash-header {
    padding: 2.5rem 3rem 2rem;
    border-bottom: 1px solid var(--border);
    background: linear-gradient(180deg, rgba(99,102,241,0.04) 0%, transparent 100%);
  }
  .dash-header h1 {
    font-size: 1.75rem;
    font-weight: 600;
    letter-spacing: -0.025em;
  }
  .dash-header .subtitle {
    color: var(--text-muted);
    font-size: 0.8rem;
    margin-top: 0.25rem;
  }

  .dash-body { padding: 2rem 3rem 4rem; max-width: 1280px; margin: 0 auto; }

  /* --- Glassmorphism stat cards --- */
  .overview-grid {
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    gap: 1rem;
    margin-bottom: 2.5rem;
  }
  .stat-card {
    background: var(--surface);
    backdrop-filter: blur(24px);
    -webkit-backdrop-filter: blur(24px);
    border: 1px solid var(--border);
    border-radius: 12px;
    padding: 1.5rem;
    transition: transform 0.2s ease, border-color 0.2s ease, box-shadow 0.2s ease;
    position: relative;
    overflow: hidden;
  }
  .stat-card::before {
    content: '';
    position: absolute;
    top: 0; left: 0; right: 0;
    height: 2px;
    background: var(--card-accent, var(--accent));
    opacity: 0;
    transition: opacity 0.2s ease;
  }
  .stat-card:hover {
    transform: translateY(-2px);
    border-color: rgba(255,255,255,0.1);
    box-shadow: 0 8px 32px rgba(0,0,0,0.3);
  }
  .stat-card:hover::before { opacity: 1; }
  .stat-card .stat-value {
    font-size: 2.25rem;
    font-weight: 700;
    line-height: 1;
    letter-spacing: -0.025em;
  }
  .stat-card .stat-label {
    font-size: 0.75rem;
    color: var(--text-muted);
    margin-top: 0.35rem;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    font-weight: 500;
  }
  .stat-card.accent { --card-accent: var(--accent); }
  .stat-card.accent .stat-value { color: var(--accent); }
  .stat-card.green { --card-accent: var(--green); }
  .stat-card.green .stat-value { color: var(--green); }
  .stat-card.orange { --card-accent: var(--orange); }
  .stat-card.orange .stat-value { color: var(--orange); }
  .stat-card.blue { --card-accent: var(--blue); }
  .stat-card.blue .stat-value { color: var(--blue); }

  /* --- SVG Progress Rings --- */
  .charts-row {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 1.5rem;
    margin-bottom: 2.5rem;
  }
  .chart-card {
    background: var(--surface);
    backdrop-filter: blur(24px);
    -webkit-backdrop-filter: blur(24px);
    border: 1px solid var(--border);
    border-radius: 12px;
    padding: 1.5rem;
    display: flex;
    align-items: center;
    gap: 1.5rem;
    transition: border-color 0.2s ease;
  }
  .chart-card:hover { border-color: rgba(255,255,255,0.1); }
  .chart-card h3 {
    font-size: 0.85rem;
    font-weight: 500;
    color: var(--text-secondary);
    margin-bottom: 0.25rem;
  }
  .chart-card .chart-value {
    font-size: 1.75rem;
    font-weight: 700;
    letter-spacing: -0.025em;
  }
  .chart-card .chart-sub {
    font-size: 0.75rem;
    color: var(--text-muted);
    margin-top: 0.15rem;
  }
  .ring-container {
    flex-shrink: 0;
    position: relative;
    width: 80px;
    height: 80px;
  }
  .ring-container svg {
    width: 80px;
    height: 80px;
    transform: rotate(-90deg);
  }
  .ring-container .ring-bg {
    fill: none;
    stroke: var(--surface-2);
    stroke-width: 6;
  }
  .ring-container .ring-fg {
    fill: none;
    stroke-width: 6;
    stroke-linecap: round;
    transition: stroke-dashoffset 1s ease;
  }
  .ring-pct {
    position: absolute;
    top: 50%; left: 50%;
    transform: translate(-50%, -50%);
    font-size: 0.85rem;
    font-weight: 600;
    color: var(--text-secondary);
  }

  @keyframes ring-fill {
    from { stroke-dashoffset: var(--ring-circumference); }
  }
  .ring-container .ring-fg {
    animation: ring-fill 1.2s ease forwards;
  }

  /* --- Milestone tabs --- */
  .ms-tabs-container { margin-bottom: 2.5rem; }
  .ms-tabs-nav {
    display: flex;
    gap: 0.25rem;
    border-bottom: 1px solid var(--border);
    margin-bottom: 0;
    overflow-x: auto;
    scrollbar-width: none;
    -ms-overflow-style: none;
  }
  .ms-tabs-nav::-webkit-scrollbar { display: none; }
  .ms-tab {
    background: none;
    border: none;
    color: var(--text-muted);
    font-family: 'IBM Plex Sans', sans-serif;
    font-size: 0.85rem;
    font-weight: 500;
    padding: 0.75rem 1.25rem;
    cursor: pointer;
    border-bottom: 2px solid transparent;
    transition: color 0.2s ease, border-color 0.2s ease;
    white-space: nowrap;
    position: relative;
  }
  .ms-tab:hover {
    color: var(--text-secondary);
  }
  .ms-tab.active {
    color: var(--text);
    border-bottom-color: var(--tab-c1);
  }
  .tab-check {
    color: var(--green);
    margin-right: 0.35rem;
    font-weight: 700;
  }

  /* --- Milestone panel --- */
  .ms-panel { display: none; }
  .ms-panel.active { display: block; }

  .ms-header {
    background: var(--surface);
    backdrop-filter: blur(24px);
    -webkit-backdrop-filter: blur(24px);
    border: 1px solid var(--border);
    border-radius: 12px;
    padding: 1.5rem 2rem;
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-top: 1.5rem;
    margin-bottom: 1.25rem;
    position: relative;
    overflow: hidden;
  }
  .ms-header::after {
    content: '';
    position: absolute;
    top: 0; left: 0; right: 0;
    height: 2px;
    background: linear-gradient(90deg, var(--ms-c1), var(--ms-c2));
  }
  .ms-header h2 {
    font-size: 1.25rem;
    font-weight: 600;
    letter-spacing: -0.015em;
    border: none;
    padding: 0;
    margin: 0;
  }
  .ms-goal {
    color: var(--text-muted);
    font-size: 0.8rem;
    margin-top: 0.35rem;
    max-width: 600px;
  }
  .ms-ring-wrap {
    position: relative;
    width: 80px;
    height: 80px;
    flex-shrink: 0;
  }
  .progress-ring {
    width: 80px;
    height: 80px;
    transform: rotate(-90deg);
  }
  .progress-ring-bg {
    fill: none;
    stroke: var(--surface-2);
    stroke-width: 5;
  }
  .progress-ring-fg {
    fill: none;
    stroke-width: 5;
    stroke-linecap: round;
    transition: stroke-dashoffset 1s ease;
    animation: ring-fill 1.2s ease forwards;
  }
  .ring-label {
    position: absolute;
    top: 50%; left: 50%;
    transform: translate(-50%, -50%);
    font-size: 0.85rem;
    font-weight: 600;
    color: var(--text-secondary);
  }

  .ms-stats-row {
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    gap: 0.75rem;
    margin-bottom: 1.5rem;
  }
  .ms-mini-stat {
    background: var(--surface);
    backdrop-filter: blur(16px);
    -webkit-backdrop-filter: blur(16px);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 0.75rem 1rem;
    text-align: center;
  }
  .ms-mini-val {
    display: block;
    font-size: 1.25rem;
    font-weight: 700;
    letter-spacing: -0.025em;
  }
  .ms-mini-lbl {
    display: block;
    font-size: 0.7rem;
    color: var(--text-muted);
    text-transform: uppercase;
    letter-spacing: 0.05em;
    margin-top: 0.1rem;
  }

  .ms-body { }
  .section-title {
    font-size: 0.85rem;
    font-weight: 600;
    color: var(--text-secondary);
    text-transform: uppercase;
    letter-spacing: 0.06em;
    margin-bottom: 1rem;
    margin-top: 1.5rem;
    padding-bottom: 0.5rem;
    border-bottom: 1px solid var(--border-subtle);
  }
  .empty-msg { color: var(--text-muted); font-size: 0.85rem; font-style: italic; }

  /* --- Phase cards --- */
  .phase-card {
    background: var(--surface);
    backdrop-filter: blur(16px);
    -webkit-backdrop-filter: blur(16px);
    border: 1px solid var(--border);
    border-radius: 10px;
    padding: 1.25rem 1.5rem;
    margin-bottom: 0.75rem;
    transition: border-color 0.2s ease, transform 0.15s ease;
  }
  .phase-card:hover {
    border-color: rgba(255,255,255,0.1);
    transform: translateX(2px);
  }
  .phase-card.phase-active { border-left: 3px solid var(--orange); }
  .phase-card.phase-done { border-left: 3px solid var(--green); }
  .phase-card.phase-pending { border-left: 3px solid var(--border); }
  .phase-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 0.5rem;
  }
  .phase-header h3 { font-size: 0.95rem; font-weight: 500; }
  .phase-desc { color: var(--text-muted); font-size: 0.8rem; margin-bottom: 0.5rem; }
  .phase-completed {
    font-size: 0.7rem;
    color: var(--green);
    margin-bottom: 0.5rem;
    font-weight: 500;
  }
  .badge {
    font-size: 0.65rem;
    padding: 0.15rem 0.55rem;
    border-radius: 10px;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    font-weight: 600;
  }
  .badge-phase-done { background: rgba(34,197,94,0.12); color: var(--green); }
  .badge-phase-active { background: rgba(245,158,11,0.12); color: var(--orange); }
  .badge-phase-pending { background: rgba(113,113,122,0.12); color: var(--text-muted); }
  .progress-bar-container {
    width: 100%;
    height: 3px;
    background: var(--surface-2);
    border-radius: 2px;
    overflow: hidden;
    margin-bottom: 0.35rem;
  }
  .progress-bar {
    height: 100%;
    border-radius: 2px;
    transition: width 0.6s ease;
  }
  .phase-stats { font-size: 0.75rem; color: var(--text-muted); margin-bottom: 0.5rem; }

  /* --- Task list --- */
  .task-list { list-style: none; padding: 0; }
  .task-list li {
    padding: 0.25rem 0;
    font-size: 0.8rem;
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }
  .task-icon { width: 1.2em; text-align: center; flex-shrink: 0; }
  .task-done { color: var(--green); }
  .task-active { color: var(--orange); }
  .task-pending { color: var(--text-muted); }
  .no-tasks { color: var(--text-muted); font-size: 0.8rem; font-style: italic; }
  .task-list details summary {
    cursor: pointer;
    display: flex;
    align-items: center;
    gap: 0.5rem;
    list-style: none;
    transition: color 0.15s ease;
  }
  .task-list details summary::-webkit-details-marker { display: none; }
  .task-list details summary:hover { color: var(--text); }
  .task-list details[open] summary { margin-bottom: 0.35rem; }
  .task-details {
    margin-left: 1.7rem;
    padding: 0.5rem 0.75rem;
    background: var(--surface-2);
    border-radius: 6px;
    font-size: 0.75rem;
    color: var(--text-muted);
  }
  .task-details pre {
    white-space: pre-wrap;
    font-family: ui-monospace, 'SF Mono', SFMono-Regular, Menlo, Consolas, monospace;
    font-size: 0.72rem;
    margin-top: 0.25rem;
  }
  .task-desc, .task-ac { margin-bottom: 0.35rem; }
  .no-detail summary { cursor: default; }

  /* --- Requirement grid --- */
  .req-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
    gap: 0.5rem;
  }
  .req-cell {
    padding: 0.5rem 0.75rem;
    border-radius: 8px;
    font-size: 0.75rem;
    font-weight: 500;
    transition: transform 0.15s ease;
  }
  .req-cell:hover { transform: translateY(-1px); }
  .req-covered { background: rgba(34,197,94,0.08); color: var(--green); border: 1px solid rgba(34,197,94,0.15); }
  .req-uncovered { background: rgba(239,68,68,0.08); color: var(--red); border: 1px solid rgba(239,68,68,0.15); }

  /* --- Agent roster --- */
  .agent-section { margin-top: 3rem; }
  .agent-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
    gap: 1rem;
  }
  .agent-card {
    background: var(--surface);
    backdrop-filter: blur(16px);
    -webkit-backdrop-filter: blur(16px);
    border: 1px solid var(--border);
    border-radius: 10px;
    padding: 1.25rem;
    transition: border-color 0.2s ease, transform 0.2s ease, box-shadow 0.2s ease;
    position: relative;
    overflow: hidden;
  }
  .agent-card::before {
    content: '';
    position: absolute;
    top: 0; left: 0; right: 0;
    height: 2px;
    background: var(--agent-color);
    opacity: 0.6;
  }
  .agent-card:hover {
    border-color: rgba(255,255,255,0.1);
    transform: translateY(-2px);
    box-shadow: 0 4px 24px rgba(0,0,0,0.3);
  }
  .agent-vibe {
    font-size: 0.7rem;
    color: var(--text-muted);
    font-style: italic;
    margin-bottom: 0.5rem;
  }
  .agent-name {
    font-size: 0.95rem;
    font-weight: 600;
    margin-bottom: 0.35rem;
    letter-spacing: -0.01em;
  }
  .agent-desc {
    font-size: 0.75rem;
    color: var(--text-muted);
    line-height: 1.5;
    margin-bottom: 0.75rem;
  }
  .agent-badge {
    display: inline-block;
    font-size: 0.65rem;
    padding: 0.15rem 0.5rem;
    border-radius: 6px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }

  /* --- Responsive --- */
  @media (max-width: 1024px) {
    .dash-body { padding: 1.5rem; }
    .dash-header { padding: 1.5rem; }
    .overview-grid { grid-template-columns: repeat(2, 1fr); }
    .charts-row { grid-template-columns: 1fr; }
    .ms-stats-row { grid-template-columns: repeat(2, 1fr); }
  }
  @media (max-width: 640px) {
    .dash-header { padding: 1.25rem; }
    .dash-header h1 { font-size: 1.25rem; }
    .dash-body { padding: 1rem; }
    .overview-grid { grid-template-columns: 1fr; }
    .charts-row { grid-template-columns: 1fr; }
    .ms-stats-row { grid-template-columns: repeat(2, 1fr); }
    .ms-header { flex-direction: column; gap: 1rem; text-align: center; }
    .agent-grid { grid-template-columns: 1fr; }
    .req-grid { grid-template-columns: 1fr; }
  }
</style>
</head>
<body>

<header class="dash-header">
  <h1>${esc(projectTitle)}</h1>
  <p class="subtitle">Generated ${timestamp} &middot; <code>${projectId}</code></p>
</header>

<div class="dash-body">

  <!-- Overview stat cards -->
  <div class="overview-grid">
    <div class="stat-card accent" style="--card-accent:var(--accent)">
      <div class="stat-value">${totalPhases}</div>
      <div class="stat-label">Total Phases</div>
    </div>
    <div class="stat-card green">
      <div class="stat-value">${completedPhases}</div>
      <div class="stat-label">Completed</div>
    </div>
    <div class="stat-card orange">
      <div class="stat-value">${phasesInProgress}</div>
      <div class="stat-label">In Progress</div>
    </div>
    <div class="stat-card blue">
      <div class="stat-value">${reqsTotal}</div>
      <div class="stat-label">Requirements</div>
    </div>
  </div>

  <!-- SVG Progress Rings -->
  <div class="charts-row">
    <div class="chart-card">
      <div class="ring-container" style="--ring-circumference:${circumference}">
        <svg viewBox="0 0 120 120">
          <circle class="ring-bg" cx="60" cy="60" r="54" />
          <circle class="ring-fg" cx="60" cy="60" r="54"
            stroke="${'#22c55e'}"
            stroke-dasharray="${circumference}"
            stroke-dashoffset="${Math.round(circumference * (1 - phaseRingPct / 100))}"
            style="--ring-circumference:${circumference}" />
        </svg>
        <span class="ring-pct">${phaseRingPct}%</span>
      </div>
      <div>
        <h3>Phase Completion</h3>
        <div class="chart-value">${completedPhases} / ${totalPhases}</div>
        <div class="chart-sub">${phasesInProgress} in progress, ${phasesOpen} open</div>
      </div>
    </div>
    <div class="chart-card">
      <div class="ring-container" style="--ring-circumference:${circumference}">
        <svg viewBox="0 0 120 120">
          <circle class="ring-bg" cx="60" cy="60" r="54" />
          <circle class="ring-fg" cx="60" cy="60" r="54"
            stroke="${reqRingPct >= 80 ? '#22c55e' : reqRingPct >= 50 ? '#f59e0b' : '#ef4444'}"
            stroke-dasharray="${circumference}"
            stroke-dashoffset="${Math.round(circumference * (1 - reqRingPct / 100))}"
            style="--ring-circumference:${circumference}" />
        </svg>
        <span class="ring-pct">${reqRingPct}%</span>
      </div>
      <div>
        <h3>Requirement Coverage</h3>
        <div class="chart-value">${reqsCovered} / ${reqsTotal}</div>
        <div class="chart-sub">${reqsTotal - reqsCovered} uncovered</div>
      </div>
    </div>
  </div>

  <!-- Milestone tabs -->
  ${milestones.length > 0 ? `
  <div class="ms-tabs-container">
    <div class="ms-tabs-nav">
      ${milestoneTabsHTML}
    </div>
    ${milestonePanelsHTML}
  </div>` : `
  <div class="section-title">All Phases</div>
  ${phaseDetails.map((phase) => {
    const pct = phase.tasks_total > 0 ? Math.round((phase.tasks_closed / phase.tasks_total) * 100) : 0;
    const statusClass = phase.status === 'closed' ? 'phase-done' : phase.status === 'in_progress' ? 'phase-active' : 'phase-pending';
    const statusBadge = phase.status === 'closed' ? 'Done' : phase.status === 'in_progress' ? 'Active' : 'Pending';
    return `<div class="phase-card ${statusClass}">
      <div class="phase-header"><h3>${esc(phase.title)}</h3><span class="badge badge-${statusClass}">${statusBadge}</span></div>
      <div class="progress-bar-container"><div class="progress-bar" style="width:${pct}%;background:var(--accent)"></div></div>
      <div class="phase-stats">${phase.tasks_closed}/${phase.tasks_total} tasks</div>
    </div>`;
  }).join('\n')}
  `}

  <!-- Agent Roster -->
  ${agents.length > 0 ? `
  <div class="agent-section">
    <h3 class="section-title">Agent Roster</h3>
    <div class="agent-grid">
      ${agentCardsHTML}
    </div>
  </div>` : ''}

</div>

<script>
  // Tab switching
  document.querySelectorAll('.ms-tab').forEach(function(tab) {
    tab.addEventListener('click', function() {
      var idx = this.getAttribute('data-tab');
      document.querySelectorAll('.ms-tab').forEach(function(t) { t.classList.remove('active'); });
      document.querySelectorAll('.ms-panel').forEach(function(p) { p.classList.remove('active'); });
      this.classList.add('active');
      var panel = document.querySelector('.ms-panel[data-panel="' + idx + '"]');
      if (panel) panel.classList.add('active');
    });
  });
<\/script>
</body>
</html>`;
}

module.exports = {
  /**
   * Find the project bead in the current beads database.
   */
  'find-project'(args) {
    // Explicit project argument takes precedence.
    if (args && args.length > 0) {
      const projectId = args[0];
      output({ found: true, project_id: projectId, source: 'argument' });
      return;
    }

    const result = bd('list --label forge:project --json', { allowFail: true });
    if (result) {
      try {
        const data = JSON.parse(result);
        const issues = Array.isArray(data) ? data : (data.issues || []);
        if (issues.length === 1) {
          // Single project — backward compat, return it directly
          const project = issues[0];
          output({ found: true, project_id: project.id, project_title: project.title || project.subject, projects: issues, source: 'beads' });
          return;
        }
        if (issues.length > 1) {
          // Multiple projects (monorepo) — resolve by cwd longest-prefix match
          const cwd = process.cwd();
          const gitRoot = findGitRoot(cwd);
          if (gitRoot) {
            const relPath = path.relative(gitRoot, cwd).split(path.sep).join('/');
            // Pre-compute workspace paths (O(N) scan is intentional at current monorepo scale)
            const wpMap = new Map(issues.map(p => [p.id, extractWorkspacePath(p)]));
            let bestMatch = null;
            let bestLen = -1;
            for (const project of issues) {
              const wp = wpMap.get(project.id);
              if (!wp) continue;
              const normalizedWp = path.normalize(wp.replace(/\/+$/, ''));
              // Reject paths that escaped the repo root via ".."
              if (normalizedWp.includes('..')) continue;
              // Check if relPath starts with this workspace_path
              if (relPath === normalizedWp || relPath.startsWith(normalizedWp + '/')) {
                if (normalizedWp.length > bestLen) {
                  bestLen = normalizedWp.length;
                  bestMatch = project;
                }
              }
            }
            if (bestMatch) {
              output({ found: true, project_id: bestMatch.id, project_title: bestMatch.title || bestMatch.subject, projects: issues, source: 'cwd_monorepo' });
              return;
            }

            // No child matched — return forge:monorepo parent if one exists (only when inside a git repo)
            const monoResult = bd('list --label forge:monorepo --json', { allowFail: true });
            if (monoResult) {
              try {
                const monoData = JSON.parse(monoResult);
                const monoIssues = Array.isArray(monoData) ? monoData : (monoData.issues || []);
                if (monoIssues.length > 0) {
                  const mono = monoIssues[0];
                  output({ found: true, project_id: mono.id, project_title: mono.title || mono.subject, projects: issues, source: 'monorepo_parent' });
                  return;
                }
              } catch { /* fall through */ }
            }
            // Still no match — return first project as last resort (only inside a git repo)
            const firstProject = issues[0];
            output({ found: true, project_id: firstProject.id, project_title: firstProject.title || firstProject.subject, projects: issues, source: 'beads' });
            return;
          }
          // Outside a git repo — skip monorepo lookup; return first project
          const project = issues[0];
          output({ found: true, project_id: project.id, project_title: project.title || project.subject, projects: issues, source: 'beads' });
          return;
        }
      } catch {
        // fall through to cwd check
      }
    }

    // Fallback: check .forge/settings.yaml in cwd for a project_id field.
    const settingsPath = path.join(process.cwd(), '.forge', 'settings.yaml');
    if (fs.existsSync(settingsPath)) {
      try {
        const raw = fs.readFileSync(settingsPath, 'utf8');
        const settings = parseSimpleYaml(raw);
        if (settings && settings.project_id) {
          output({ found: true, project_id: settings.project_id, source: 'cwd_settings' });
          return;
        }
      } catch {
        // fall through
      }
    }

    output({ found: false });
  },

  /**
   * Record a project memory (wraps bd remember).
   */
  remember(args) {
    const memory = args.join(' ');
    if (!memory) {
      forgeError('MISSING_ARG', 'Missing required argument: text', 'Run: forge-tools remember <text-to-remember>');
    }
    bdArgs(['remember', ...args]);
    output({ ok: true, memory });
  },

  /**
   * Get full project context for a workflow.
   */
  'project-context'(args) {
    const projectId = args[0];
    if (!projectId) {
      forgeError('MISSING_ARG', 'Missing required argument: project-bead-id', 'Run: forge-tools project-context <project-bead-id>');
    }

    const project = bdJson(`show ${projectId}`);
    const { phases, requirements } = collectProjectIssues(projectId);

    output({
      project,
      requirements,
      phases,
      summary: {
        total_requirements: requirements.length,
        total_phases: phases.length,
        phases_complete: phases.filter(p => p.status === 'closed').length,
        phases_in_progress: phases.filter(p => p.status === 'in_progress').length,
      },
    });
  },

  /**
   * Get progress summary for a project.
   */
  progress(args) {
    const projectId = args[0];
    if (!projectId) {
      forgeError('MISSING_ARG', 'Missing required argument: project-bead-id', 'Run: forge-tools progress <project-bead-id>');
    }

    const project = bdJson(`show ${projectId}`);
    const { phases } = collectProjectIssues(projectId);

    const totalPhases = phases.length;
    const completedPhases = phases.filter(p => p.status === 'closed').length;
    const currentPhase = phases.find(p => p.status === 'in_progress') || phases.find(p => p.status === 'open');

    const memories = bd('memories forge', { allowFail: true });

    output({
      project: { id: project?.id, title: project?.title, status: project?.status },
      progress: {
        phases_total: totalPhases,
        phases_completed: completedPhases,
        phases_remaining: totalPhases - completedPhases,
        percent: totalPhases > 0 ? Math.round((completedPhases / totalPhases) * 100) : 0,
      },
      current_phase: currentPhase ? { id: currentPhase.id, title: currentPhase.title, status: currentPhase.status } : null,
      memories: memories || null,
    });
  },

  /**
   * Get comprehensive progress with per-phase task breakdowns for the dashboard.
   */
  'full-progress'(args) {
    const projectId = args[0];
    if (!projectId) {
      forgeError('MISSING_ARG', 'Missing required argument: project-bead-id', 'Run: forge-tools full-progress <project-bead-id>');
    }

    const project = bdJson(`show ${projectId}`);
    const { phases, requirements } = collectProjectIssues(projectId);

    const phaseDetails = buildPhaseDetails(phases);
    const reqCoverage = getRequirementCoverage(requirements);

    const totalPhases = phases.length;
    const completedPhases = phases.filter(p => p.status === 'closed').length;
    const currentPhase = phases.find(p => p.status === 'in_progress') || phases.find(p => p.status === 'open');

    const memories = bd('memories forge', { allowFail: true });

    output({
      project: { id: project?.id, title: project?.title, status: project?.status },
      progress: {
        phases_total: totalPhases,
        phases_completed: completedPhases,
        phases_remaining: totalPhases - completedPhases,
        percent: totalPhases > 0 ? Math.round((completedPhases / totalPhases) * 100) : 0,
      },
      current_phase: currentPhase ? { id: currentPhase.id, title: currentPhase.title, status: currentPhase.status } : null,
      phases: phaseDetails,
      requirements: {
        total: requirements.length,
        covered: reqCoverage.filter(r => r.covered).length,
        uncovered: reqCoverage.filter(r => !r.covered).map(r => ({ id: r.id, title: r.title })),
        details: reqCoverage,
      },
      memories: memories || null,
    });
  },

  /**
   * Generate a self-contained HTML dashboard for a project.
   */
  'generate-dashboard'(args) {
    const projectId = args[0];
    if (!projectId) {
      forgeError('MISSING_ARG', 'Missing required argument: project-bead-id', 'Run: forge-tools generate-dashboard <project-bead-id>');
    }

    const project = bdJson(`show ${projectId}`);
    const { phases, requirements, milestoneDetails } = collectProjectIssues(projectId);

    // Build phaseDetails once (keyed by ID) and reqCoverage once globally
    const phaseDetails = sortPhaseDetails(buildPhaseDetails(phases, { includeMeta: true }));
    const reqCoverage = getRequirementCoverage(requirements);

    const totalPhases = phases.length;
    const completedPhases = phases.filter(p => p.status === 'closed').length;
    const progressPercent = totalPhases > 0 ? Math.round((completedPhases / totalPhases) * 100) : 0;

    // Index for O(1) lookups
    const phaseDetailMap = new Map(phaseDetails.map(pd => [pd.id, pd]));
    const reqCoverageMap = new Map(reqCoverage.map(rc => [rc.id, rc]));

    // Build milestone-grouped structure by slicing the pre-built maps
    const milestonesGrouped = milestoneDetails.map(ms => {
      const msPhaseDetails = sortPhaseDetails(
        ms.phases.map(p => phaseDetailMap.get(p.id)).filter(Boolean)
      );
      const msReqCoverage = ms.requirements
        .map(r => reqCoverageMap.get(r.id)).filter(Boolean);

      return {
        id: ms.id,
        title: ms.title,
        status: ms.status,
        goal: ms.goal,
        phases: msPhaseDetails,
        requirements: msReqCoverage,
        progress: ms.progress,
        phase_count: ms.phase_count,
        completed_count: ms.completed_count,
      };
    });

    // Collect agent roster
    const agents = collectAgentRoster();

    const projectTitle = project?.title || projectId;
    const timestamp = new Date().toISOString().replace('T', ' ').replace(/\.\d+Z/, ' UTC');

    const data = {
      projectTitle, projectId, timestamp, progressPercent,
      totalPhases, completedPhases,
      phaseDetails, reqCoverage,
      milestones: milestonesGrouped,
      agents,
    };

    const html = generateDashboardHTML(data);

    const diagDir = path.join(process.cwd(), '.forge');
    fs.mkdirSync(diagDir, { recursive: true });
    const filePath = path.join(diagDir, `forge-dashboard-${projectId}.html`);
    // Path traversal guard: ensure filePath stays within diagDir
    const resolvedDiagDir = path.resolve(diagDir);
    const resolvedFilePath = path.resolve(filePath);
    if (!resolvedFilePath.startsWith(resolvedDiagDir + path.sep) && resolvedFilePath !== resolvedDiagDir) {
      forgeError('INVALID_INPUT', 'Invalid dashboard file path', 'Ensure the project ID does not contain path traversal characters', { projectId });
    }
    fs.writeFileSync(resolvedFilePath, html, 'utf8');

    output({ path: resolvedFilePath, projectId, timestamp });
  },

  /**
   * Save session state for forge:pause.
   */
  'save-session'(args) {
    const projectId = args[0];
    if (!projectId) {
      forgeError('MISSING_ARG', 'Missing required argument: project-bead-id', 'Run: forge-tools save-session <project-bead-id>');
    }

    const { phases } = collectProjectIssues(projectId);

    const currentPhase = phases.find(p => p.status === 'in_progress') || phases.find(p => p.status === 'open');
    const completedPhases = phases.filter(p => p.status === 'closed').length;

    const inProgressTasks = [];
    for (const phase of phases) {
      if (phase.status === 'closed') continue;
      const tasks = normalizeChildren(bdJson(`children ${phase.id}`));
      for (const task of tasks) {
        if (task.status === 'in_progress') {
          inProgressTasks.push({ id: task.id, title: task.title, phase: phase.id });
        }
      }
    }

    const timestamp = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
    const sessionData = {
      project_id: projectId,
      timestamp,
      current_phase: currentPhase ? currentPhase.id : null,
      current_phase_title: currentPhase ? currentPhase.title : null,
      phases_completed: completedPhases,
      phases_total: phases.length,
      tasks_in_progress: inProgressTasks,
    };

    const memoryKey = 'forge:session:state';
    const memoryValue = `${timestamp} project=${projectId} phase=${sessionData.current_phase || 'none'} progress=${completedPhases}/${phases.length} in_flight=${inProgressTasks.map(t => t.id).join(',')}`;
    bdArgs(['remember', '--key', memoryKey, memoryValue], { allowFail: true });

    output({ saved: true, session: sessionData });
  },

  /**
   * Load session state for forge:resume.
   */
  'load-session'() {
    const memories = bd('memories forge:session', { allowFail: true });

    const projectResult = bd('list --label forge:project --json', { allowFail: true });
    let project = null;
    if (projectResult) {
      try {
        const data = JSON.parse(projectResult);
        const issues = Array.isArray(data) ? data : (data.issues || []);
        if (issues.length > 0) project = issues[0];
      } catch { /* ignore */ }
    }

    if (!project) {
      output({ found: false, memories: memories || null });
      return;
    }

    const { phases } = collectProjectIssues(project.id);
    const currentPhase = phases.find(p => p.status === 'in_progress') || phases.find(p => p.status === 'open');

    const inProgressTasks = [];
    if (currentPhase) {
      const tasks = normalizeChildren(bdJson(`children ${currentPhase.id}`));
      for (const task of tasks) {
        if (task.status === 'in_progress') {
          inProgressTasks.push({ id: task.id, title: task.title });
        }
      }
    }

    output({
      found: true,
      project: { id: project.id, title: project.title, status: project.status },
      current_phase: currentPhase ? { id: currentPhase.id, title: currentPhase.title, status: currentPhase.status } : null,
      tasks_in_progress: inProgressTasks,
      phases_completed: phases.filter(p => p.status === 'closed').length,
      phases_total: phases.length,
      memories: memories || null,
    });
  },

  /**
   * Diagnose project health.
   */
  health(args) {
    const projectId = args[0];
    if (!projectId) {
      forgeError('MISSING_ARG', 'Missing required argument: project-bead-id', 'Run: forge-tools health <project-bead-id>');
    }

    const project = bdJson(`show ${projectId}`);
    if (!project) {
      output({ error: 'Project not found', project_id: projectId });
      return;
    }

    const { phases, requirements } = collectProjectIssues(projectId);

    const diagnostics = { structure: [], dependencies: [], state: [], config: [], installation: [], orphans: [] };

    const hasProjectLabel = (project.labels || []).includes('forge:project');
    diagnostics.structure.push({
      check: 'project_label',
      ok: hasProjectLabel,
      message: hasProjectLabel ? 'Project label present' : 'Project missing forge:project label',
      fixable: !hasProjectLabel,
      fix_target: hasProjectLabel ? null : projectId,
    });

    const unlabeledPhases = phases.filter(p => !(p.labels || []).includes('forge:phase'));
    diagnostics.structure.push({
      check: 'phase_labels',
      ok: unlabeledPhases.length === 0,
      message: unlabeledPhases.length === 0
        ? `${phases.length}/${phases.length} phases labeled`
        : `${unlabeledPhases.length} phase(s) missing forge:phase label`,
      fixable: unlabeledPhases.length > 0,
      fix_targets: unlabeledPhases.map(p => p.id),
    });

    // Cache phase children once for reuse in task-labels and closeable-phase loops
    const phaseChildrenMap = new Map();
    for (const phase of phases) {
      const tasks = normalizeChildren(bdJson(`children ${phase.id}`));
      phaseChildrenMap.set(phase.id, tasks);
    }

    const allTasks = [];
    const unlabeledTasks = [];
    for (const phase of phases) {
      const tasks = phaseChildrenMap.get(phase.id);
      for (const t of tasks) {
        allTasks.push({ ...t, phase_id: phase.id });
        if (!(t.labels || []).includes('forge:task') && !(t.labels || []).includes('forge:research')) {
          unlabeledTasks.push(t);
        }
      }
    }

    diagnostics.structure.push({
      check: 'task_labels',
      ok: unlabeledTasks.length === 0,
      message: unlabeledTasks.length === 0
        ? `${allTasks.length} tasks properly labeled`
        : `${unlabeledTasks.length} task(s) missing forge:task label`,
      fixable: unlabeledTasks.length > 0,
      fix_targets: unlabeledTasks.map(t => t.id),
    });

    const uncoveredReqs = [];
    for (const req of requirements) {
      const deps = bd(`dep list ${req.id} --direction=up --type validates`, { allowFail: true });
      if (!deps || deps.trim() === '' || deps.includes('No dependencies')) {
        uncoveredReqs.push(req);
      }
    }

    diagnostics.dependencies.push({
      check: 'requirement_coverage',
      ok: uncoveredReqs.length === 0,
      message: uncoveredReqs.length === 0
        ? `${requirements.length}/${requirements.length} requirements covered`
        : `${uncoveredReqs.length} requirement(s) without task coverage`,
      severity: uncoveredReqs.length > 0 ? 'warning' : 'ok',
      details: uncoveredReqs.map(r => ({ id: r.id, title: r.title })),
    });

    const closedPhasesWithOpenTasks = [];
    const closeablePhases = [];
    for (const phase of phases) {
      const tasks = phaseChildrenMap.get(phase.id);
      const openTasks = tasks.filter(t => t.status !== 'closed');

      if (phase.status === 'closed' && openTasks.length > 0) {
        closedPhasesWithOpenTasks.push({ phase, open_tasks: openTasks });
      }
      if (phase.status !== 'closed' && tasks.length > 0 && openTasks.length === 0) {
        closeablePhases.push(phase);
      }
    }

    diagnostics.state.push({
      check: 'closed_phase_open_tasks',
      ok: closedPhasesWithOpenTasks.length === 0,
      message: closedPhasesWithOpenTasks.length === 0
        ? 'No closed phases with open tasks'
        : `${closedPhasesWithOpenTasks.length} closed phase(s) have open tasks`,
      severity: closedPhasesWithOpenTasks.length > 0 ? 'error' : 'ok',
      details: closedPhasesWithOpenTasks.map(x => ({
        phase_id: x.phase.id,
        phase_title: x.phase.title,
        open_task_ids: x.open_tasks.map(t => t.id),
      })),
    });

    diagnostics.state.push({
      check: 'closeable_phases',
      ok: closeablePhases.length === 0,
      message: closeablePhases.length === 0
        ? 'No phases ready to close'
        : `${closeablePhases.length} phase(s) have all tasks closed (suggest: verify/close)`,
      severity: closeablePhases.length > 0 ? 'suggestion' : 'ok',
      details: closeablePhases.map(p => ({ id: p.id, title: p.title })),
    });

    const configIssues = [];
    const numericKeys = ['context_warning', 'context_critical'];
    const booleanKeys = ['update_check', 'auto_research'];

    for (const key of numericKeys) {
      const val = bd(`kv get forge.${key}`, { allowFail: true });
      if (val && val.trim() !== '') {
        const num = parseFloat(val.trim());
        if (isNaN(num) || num < 0 || num > 1) {
          configIssues.push({ key: `forge.${key}`, value: val.trim(), reason: 'must be a number between 0 and 1' });
        }
      }
    }

    for (const key of booleanKeys) {
      const val = bd(`kv get forge.${key}`, { allowFail: true });
      if (val && val.trim() !== '') {
        if (!['true', 'false'].includes(val.trim().toLowerCase())) {
          configIssues.push({ key: `forge.${key}`, value: val.trim(), reason: 'must be true or false' });
        }
      }
    }

    diagnostics.config.push({
      check: 'bd_kv_config',
      ok: configIssues.length === 0,
      message: configIssues.length === 0
        ? 'All forge.* bd kv values valid'
        : `${configIssues.length} bd kv config value(s) invalid`,
      severity: configIssues.length > 0 ? 'error' : 'ok',
      details: configIssues,
    });

    const projectSettingsPath = path.resolve(process.cwd(), PROJECT_SETTINGS_NAME);
    let settingsOk = true;
    let settingsMessage = '';
    const settingsIssues = [];

    if (fs.existsSync(projectSettingsPath)) {
      try {
        const projectSettings = parseSimpleYaml(fs.readFileSync(projectSettingsPath, 'utf8'));
        for (const [key, val] of Object.entries(projectSettings)) {
          if (!(key in SETTINGS_DEFAULTS)) {
            settingsIssues.push({ key, value: val, reason: 'unknown setting key' });
          } else if (typeof SETTINGS_DEFAULTS[key] === 'boolean' && typeof val !== 'boolean') {
            settingsIssues.push({ key, value: val, reason: 'expected boolean (true/false)' });
          }
        }
        settingsOk = settingsIssues.length === 0;
        settingsMessage = settingsOk
          ? `.forge/settings.yaml valid (${Object.keys(projectSettings).length} keys)`
          : `${settingsIssues.length} issue(s) in .forge/settings.yaml`;
      } catch {
        settingsOk = false;
        settingsMessage = '.forge/settings.yaml exists but failed to parse';
      }
    } else {
      settingsMessage = '.forge/settings.yaml not found (using defaults)';
    }

    diagnostics.config.push({
      check: 'project_settings',
      ok: settingsOk,
      message: settingsMessage,
      severity: !settingsOk && settingsIssues.length > 0 ? 'warning' : 'ok',
      details: settingsIssues,
    });

    let globalSettingsOk = true;
    let globalSettingsMessage = '';
    if (fs.existsSync(GLOBAL_SETTINGS_PATH)) {
      try {
        const globalText = fs.readFileSync(GLOBAL_SETTINGS_PATH, 'utf8');
        const globalSettings = parseFrontmatter(globalText);
        const unknownKeys = Object.keys(globalSettings).filter(k => !(k in SETTINGS_DEFAULTS));
        globalSettingsOk = unknownKeys.length === 0;
        globalSettingsMessage = globalSettingsOk
          ? `Global settings valid (${Object.keys(globalSettings).length} keys)`
          : `${unknownKeys.length} unknown key(s) in global settings: ${unknownKeys.join(', ')}`;
      } catch {
        globalSettingsOk = false;
        globalSettingsMessage = 'Global settings file exists but failed to parse';
      }
    } else {
      globalSettingsMessage = 'No global settings file (using defaults)';
    }

    diagnostics.config.push({
      check: 'global_settings',
      ok: globalSettingsOk,
      message: globalSettingsMessage,
      severity: globalSettingsOk ? 'ok' : 'warning',
    });

    const forgeDir = path.join(homedir(), '.claude', 'forge');

    const expectedFiles = [
      { path: 'bin/forge-tools.cjs', label: 'forge-tools.cjs' },
      { path: 'workflows/new-project.md', label: 'new-project workflow' },
      { path: 'workflows/plan-phase.md', label: 'plan-phase workflow' },
      { path: 'workflows/execute-phase.md', label: 'execute-phase workflow' },
      { path: 'workflows/verify.md', label: 'verify workflow' },
      { path: 'workflows/progress.md', label: 'progress workflow' },
      { path: 'workflows/health.md', label: 'health workflow' },
      { path: 'references/conventions.md', label: 'conventions reference' },
    ];

    const missingFiles = [];
    for (const f of expectedFiles) {
      const full = path.join(forgeDir, f.path);
      if (!fs.existsSync(full)) {
        missingFiles.push(f.label);
      }
    }

    diagnostics.installation.push({
      check: 'forge_files',
      ok: missingFiles.length === 0,
      message: missingFiles.length === 0
        ? 'All Forge files present'
        : `Missing: ${missingFiles.join(', ')}`,
      severity: missingFiles.length > 0 ? 'error' : 'ok',
    });

    const versionFile = path.join(forgeDir, '.forge-version');
    let versionOk = false;
    let versionInfo = null;
    if (fs.existsSync(versionFile)) {
      try {
        versionInfo = JSON.parse(fs.readFileSync(versionFile, 'utf8'));
        versionOk = !!(versionInfo && versionInfo.version);
      } catch { /* invalid JSON */ }
    }

    diagnostics.installation.push({
      check: 'version_file',
      ok: versionOk,
      message: versionOk
        ? `Version file valid (v${versionInfo.version})`
        : 'Version file missing or invalid',
      severity: versionOk ? 'ok' : 'warning',
    });

    // Orphan detection: find forge-labeled beads with no parent-child dependency.
    // Use phaseChildrenMap to skip beads already known to have parents (avoids N+1 bd calls).
    const beadsWithKnownParent = new Set();
    for (const [, phaseTasks] of phaseChildrenMap) {
      for (const t of phaseTasks) {
        beadsWithKnownParent.add(t.id);
      }
    }
    // Phases that are children of milestones are also known to have parents
    // (they were fetched via bdJson(`children ${ms.id}`) in the milestone traversal above).

    const orphans = [];
    const forgeBeads = [
      ...phases.map(p => ({ ...p, forge_label: 'forge:phase' })),
      ...allTasks.filter(t => (t.labels || []).includes('forge:task')).map(t => ({ ...t, forge_label: 'forge:task' })),
    ];
    for (const bead of forgeBeads) {
      // Skip beads already known to have a parent from phaseChildrenMap
      if (beadsWithKnownParent.has(bead.id)) continue;
      const depOutput = bd(`dep list ${bead.id} --direction=up --type=parent-child`, { allowFail: true });
      const hasParent = depOutput && depOutput.trim() !== '' && !depOutput.includes('No dependencies');
      if (!hasParent) {
        // Suggest the project itself as parent for phases, or the phase for tasks
        const suggestedParent = bead.forge_label === 'forge:phase' ? projectId : (bead.phase_id || projectId);
        orphans.push({
          id: bead.id,
          title: bead.title,
          label: bead.forge_label,
          suggested_fix: `bd dep add ${bead.id} ${suggestedParent} --type=parent-child`,
        });
      }
    }

    diagnostics.orphans.push({
      check: 'orphan_beads',
      ok: orphans.length === 0,
      message: orphans.length === 0
        ? 'No orphan beads found'
        : `${orphans.length} orphan bead(s) found without parent-child dependency`,
      severity: orphans.length > 0 ? 'warning' : 'ok',
      details: orphans,
    });

    const allChecks = [
      ...diagnostics.structure,
      ...diagnostics.dependencies,
      ...diagnostics.state,
      ...diagnostics.config,
      ...diagnostics.installation,
      ...diagnostics.orphans,
    ];
    const errors = allChecks.filter(c => !c.ok && (c.severity === 'error' || c.fixable));
    const warnings = allChecks.filter(c => !c.ok && c.severity === 'warning');
    const suggestions = allChecks.filter(c => !c.ok && c.severity === 'suggestion');

    output({
      project: { id: project.id, title: project.title, status: project.status },
      diagnostics,
      summary: {
        total_checks: allChecks.length,
        healthy: allChecks.filter(c => c.ok).length,
        errors: errors.length,
        warnings: warnings.length,
        suggestions: suggestions.length,
      },
    });
  },

  /**
   * Load merged settings (defaults < global < project).
   */
  'settings-load'() {
    const { merged, sources } = loadMergedSettings();

    const settings = Object.keys(SETTINGS_DEFAULTS).map(key => ({
      key,
      value: merged[key],
      default: SETTINGS_DEFAULTS[key],
      source: sources[key],
      description: SETTINGS_DESCRIPTIONS[key],
    }));

    output({
      settings,
      global_path: GLOBAL_SETTINGS_PATH,
      project_path: path.resolve(process.cwd(), PROJECT_SETTINGS_NAME),
    });
  },

  /**
   * Set a setting value. Scope: "global" or "project".
   */
  'settings-set'(args) {
    const scope = args[0];
    const key = args[1];
    const value = args[2];

    if (!scope || !key || value === undefined) {
      forgeError('MISSING_ARG', 'Missing required arguments: scope, key, and value', 'Run: forge-tools settings-set <global|project> <key> <value>');
    }

    const { topKey, subKey, isNested } = parseDotKey(key);

    const EXTRA_TOP_KEYS = ['model_profile', 'model_overrides'];
    if (!isNested && !(topKey in SETTINGS_DEFAULTS) && !EXTRA_TOP_KEYS.includes(topKey)) {
      forgeError('INVALID_INPUT', `Unknown setting: ${key}`, `Available settings: ${Object.keys(SETTINGS_DEFAULTS).join(', ')}, model_profile, model_overrides.<agent>, models.<role>`, { key });
    }

    const parsedValue = coerceBool(value);

    function setNestedKey(obj, tKey, sKey, val) {
      if (sKey) {
        if (!obj[tKey] || typeof obj[tKey] !== 'object') obj[tKey] = {};
        obj[tKey][sKey] = val;
      } else {
        obj[tKey] = val;
      }
    }

    if (scope === 'global') {
      let existing = {};
      let body = '';
      try {
        const text = fs.readFileSync(GLOBAL_SETTINGS_PATH, 'utf8');
        existing = parseFrontmatter(text);
        const bodyMatch = text.match(/^---\n[\s\S]*?\n---\n([\s\S]*)$/);
        if (bodyMatch) body = bodyMatch[1];
      } catch { /* new file */ }
      setNestedKey(existing, topKey, subKey, parsedValue);
      writeFrontmatter(GLOBAL_SETTINGS_PATH, existing, body);
      output({ ok: true, scope, key, value: parsedValue });
    } else if (scope === 'project') {
      const projectPath = path.resolve(process.cwd(), PROJECT_SETTINGS_NAME);
      let existing = {};
      try {
        existing = parseSimpleYaml(fs.readFileSync(projectPath, 'utf8'));
      } catch { /* new file */ }
      setNestedKey(existing, topKey, subKey, parsedValue);
      const dir = path.dirname(projectPath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(projectPath, toSimpleYaml(existing));
      output({ ok: true, scope, key, value: parsedValue });
    } else {
      forgeError('INVALID_INPUT', `Invalid scope: ${scope}`, 'Scope must be "global" or "project"', { scope });
    }
  },

  /**
   * Clear a setting from a scope.
   */
  'settings-clear'(args) {
    const scope = args[0];
    const key = args[1];

    if (!scope || !key) {
      forgeError('MISSING_ARG', 'Missing required arguments: scope and key', 'Run: forge-tools settings-clear <global|project> <key>');
    }

    const { topKey, subKey } = parseDotKey(key);

    function clearNestedKey(obj, tKey, sKey) {
      if (sKey && obj[tKey] && typeof obj[tKey] === 'object') {
        delete obj[tKey][sKey];
        if (Object.keys(obj[tKey]).length === 0) delete obj[tKey];
      } else {
        delete obj[tKey];
      }
    }

    if (scope === 'global') {
      try {
        const text = fs.readFileSync(GLOBAL_SETTINGS_PATH, 'utf8');
        const existing = parseFrontmatter(text);
        const bodyMatch = text.match(/^---\n[\s\S]*?\n---\n([\s\S]*)$/);
        const body = bodyMatch ? bodyMatch[1] : '';
        clearNestedKey(existing, topKey, subKey);
        writeFrontmatter(GLOBAL_SETTINGS_PATH, existing, body);
      } catch { /* file doesn't exist, nothing to clear */ }
    } else if (scope === 'project') {
      const projectPath = path.resolve(process.cwd(), PROJECT_SETTINGS_NAME);
      try {
        const existing = parseSimpleYaml(fs.readFileSync(projectPath, 'utf8'));
        clearNestedKey(existing, topKey, subKey);
        fs.writeFileSync(projectPath, toSimpleYaml(existing));
      } catch { /* file doesn't exist */ }
    }

    output({ ok: true, scope, key, cleared: true });
  },

  /**
   * Bulk-set multiple settings at once from JSON input.
   */
  'settings-bulk'(args) {
    const scope = args[0];
    const jsonStr = args.slice(1).join(' ');

    if (!scope || !jsonStr) {
      forgeError('MISSING_ARG', 'Missing required arguments: scope and json', 'Run: forge-tools settings-bulk <global|project> <json>');
    }

    let updates;
    try {
      updates = JSON.parse(jsonStr);
    } catch {
      forgeError('INVALID_INPUT', 'Invalid JSON input', 'Provide valid JSON object, e.g. {"auto_commit":true,"skip_verification":false}');
    }

    const results = [];

    if (scope === 'global') {
      let existing = {};
      let body = '';
      try {
        const text = fs.readFileSync(GLOBAL_SETTINGS_PATH, 'utf8');
        existing = parseFrontmatter(text);
        const bodyMatch = text.match(/^---\n[\s\S]*?\n---\n([\s\S]*)$/);
        if (bodyMatch) body = bodyMatch[1];
      } catch { /* new file */ }
      for (const [key, value] of Object.entries(updates)) {
        if (!(key in SETTINGS_DEFAULTS)) continue;
        const parsedValue = coerceBool(value);
        existing[key] = parsedValue;
        results.push({ key, value: parsedValue });
      }
      writeFrontmatter(GLOBAL_SETTINGS_PATH, existing, body);
    } else if (scope === 'project') {
      const projectPath = path.resolve(process.cwd(), PROJECT_SETTINGS_NAME);
      let existing = {};
      try {
        existing = parseSimpleYaml(fs.readFileSync(projectPath, 'utf8'));
      } catch { /* new file */ }
      for (const [key, value] of Object.entries(updates)) {
        if (!(key in SETTINGS_DEFAULTS)) continue;
        const parsedValue = coerceBool(value);
        existing[key] = parsedValue;
        results.push({ key, value: parsedValue });
      }
      const dir = path.dirname(projectPath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(projectPath, toSimpleYaml(existing));
    }

    output({ ok: true, scope, updated: results });
  },

  /**
   * Resolve the model for a given agent.
   */
  'resolve-model'(args) {
    const rawFlag = args.includes('--raw');
    const agent = args.filter(a => a !== '--raw')[0];
    if (!agent) {
      forgeError('MISSING_ARG', 'Missing required argument: agent-name', 'Run: forge-tools resolve-model <agent-name> [--raw]');
    }

    const result = resolveAgentModel(agent);

    if (rawFlag) {
      process.stdout.write(result.model || '');
    } else {
      output({ agent: ROLE_TO_AGENT[agent] || agent, ...result, profile: loadModelProfile() });
    }
  },

  /**
   * Backwards-compatible alias for resolve-model.
   */
  'model-for-role'(args) {
    const role = args[0];
    if (!role) {
      forgeError('MISSING_ARG', 'Missing required argument: role', 'Run: forge-tools model-for-role <role>');
    }

    const result = resolveAgentModel(role);
    output({ role, model: result.model, source: result.source });
  },

  /**
   * Show all agent model assignments for the active profile.
   */
  'model-profiles'() {
    const profile = loadModelProfile();
    const overrides = loadModelOverrides();
    const agents = Object.keys(MODEL_PROFILES);

    const effective = {};
    for (const agent of agents) {
      const result = resolveAgentModel(agent);
      effective[agent] = result;
    }

    output({
      profile,
      overrides,
      effective,
      agents,
      available_profiles: ['quality', 'balanced', 'budget'],
    });
  },

  /**
   * Get a Forge config value via bd kv.
   */
  'config-get'(args) {
    const key = args[0];
    if (!key) {
      forgeError('MISSING_ARG', 'Missing required argument: key', 'Run: forge-tools config-get <key>. List keys with: forge-tools config-list');
    }
    const fullKey = key.startsWith('forge.') ? key : `forge.${key}`;
    const value = bdArgs(['kv', 'get', fullKey], { allowFail: true });
    output({ key: fullKey, value: value || null });
  },

  /**
   * Set a Forge config value via bd kv.
   */
  'config-set'(args) {
    const key = args[0];
    const value = args.slice(1).join(' ');
    if (!key || !value) {
      forgeError('MISSING_ARG', 'Missing required arguments: key and value', 'Run: forge-tools config-set <key> <value>. List keys with: forge-tools config-list');
    }
    const fullKey = key.startsWith('forge.') ? key : `forge.${key}`;
    bdArgs(['kv', 'set', fullKey, value]);
    output({ ok: true, key: fullKey, value });
  },

  /**
   * List all Forge config values.
   */
  'config-list'() {
    const raw = bd('kv list --json', { allowFail: true });
    let kvMap = {};
    if (raw) {
      try { kvMap = JSON.parse(raw); } catch { /* ignore */ }
    }
    if (Array.isArray(kvMap)) {
      const obj = {};
      for (const item of kvMap) obj[item.key] = item.value;
      kvMap = obj;
    }
    const forgeKv = Object.entries(kvMap)
      .filter(([k]) => k.startsWith('forge.'))
      .map(([key, value]) => ({ key, value }));
    output({
      config: forgeKv,
      available_keys: [
        { key: 'forge.context_warning', default: '0.35', description: 'Context warning threshold (0-1)' },
        { key: 'forge.context_critical', default: '0.25', description: 'Context critical/block threshold (0-1)' },
        { key: 'forge.update_check', default: 'true', description: 'Enable update check on session start' },
        { key: 'forge.auto_research', default: 'true', description: 'Auto-run research before planning' },
      ],
    });
  },

  /**
   * Clear a Forge config value.
   */
  'config-clear'(args) {
    const key = args[0];
    if (!key) {
      forgeError('MISSING_ARG', 'Missing required argument: key', 'Run: forge-tools config-clear <key>. List keys with: forge-tools config-list');
    }
    const fullKey = key.startsWith('forge.') ? key : `forge.${key}`;
    bdArgs(['kv', 'clear', fullKey], { allowFail: true });
    output({ ok: true, key: fullKey, cleared: true });
  },

  /**
   * List active debug sessions.
   */
  'debug-list'() {
    const result = bd('list --label forge:debug --status open --json', { allowFail: true });
    if (!result) {
      output({ sessions: [] });
      return;
    }
    try {
      const data = JSON.parse(result);
      const issues = Array.isArray(data) ? data : (data.issues || []);
      const sessions = issues.map(i => ({
        id: i.id,
        title: i.title || '',
        status: i.status || 'open',
        notes: i.notes || '',
        description: i.description || '',
      }));
      output({ sessions });
    } catch {
      output({ sessions: [] });
    }
  },

  /**
   * Create a new debug session bead.
   */
  'debug-create'(args) {
    const slug = args[0] || 'debug-session';
    const description = args.slice(1).join(' ') || '';
    const title = `Debug: ${slug}`;

    const result = bdArgs(['create', `--title=${title}`, `--description=${description}`, '--type=task', '--json']);
    if (!result) {
      forgeError('COMMAND_FAILED', 'Failed to create debug bead', 'Check bd connectivity with: bd list --limit 1');
    }

    const debugId = parseBdCreateId(result);

    if (!debugId) {
      forgeError('COMMAND_FAILED', 'Failed to parse debug bead ID from bd output', 'Check bd connectivity and try again', { rawOutput: result });
    }

    bd(`label add ${debugId} forge:debug`, { allowFail: true });
    bd(`update ${debugId} --status=in_progress`, { allowFail: true });

    output({ debug_id: debugId, slug });
  },

  /**
   * Update a debug session bead's notes or design fields.
   */
  'debug-update'(args) {
    const id = args[0];
    const field = args[1];
    const value = args.slice(2).join(' ');

    if (!id || !field) {
      forgeError('MISSING_ARG', 'Missing required arguments: id and field', 'Run: forge-tools debug-update <id> <field> <value>');
    }

    if (field === 'notes') {
      bdArgs(['update', id, `--notes=${value}`], { allowFail: true });
    } else if (field === 'design') {
      bdArgs(['update', id, `--design=${value}`], { allowFail: true });
    } else if (field === 'status') {
      const validStatuses = ['open', 'in_progress', 'closed', 'blocked', 'deferred'];
      if (!validStatuses.includes(value)) {
        forgeError('INVALID_INPUT', `Invalid status: ${value}`, `Must be one of: ${validStatuses.join(', ')}`, { value, validStatuses });
      }
      bdArgs(['update', id, `--status=${value}`], { allowFail: true });
    } else {
      forgeError('INVALID_INPUT', `Unknown field: ${field}`, 'Valid fields are: notes, design, status', { field });
    }

    output({ updated: true, id });
  },

  /**
   * List pending forge:todo beads.
   */
  'todo-list'() {
    const result = bd('list --label forge:todo --status open --json', { allowFail: true });
    if (!result) {
      output({ todo_count: 0, todos: [] });
      return;
    }
    try {
      const data = JSON.parse(result);
      const issues = Array.isArray(data) ? data : (data.issues || []);
      const todos = issues.map(i => ({
        id: i.id,
        title: i.title || '',
        status: i.status || 'open',
        description: i.description || '',
        notes: i.notes || '',
        created_at: i.created_at || i.created || '',
      }));
      output({ todo_count: todos.length, todos });
    } catch {
      output({ todo_count: 0, todos: [] });
    }
  },

  /**
   * Create a new forge:todo bead under a project.
   */
  'todo-create'(args) {
    const projectId = args[0];
    const title = args[1];
    const description = args[2] || '';
    const area = args[3] || 'general';
    const files = args[4] || '';

    if (!projectId || !title) {
      forgeError('MISSING_ARG', 'Missing required arguments: project-id and title', 'Run: forge-tools todo-create <project-id> <title> [description] [area] [files]');
    }

    const descParts = [description];
    if (area) descParts.push(`Area: ${area}`);
    if (files) descParts.push(`Files: ${files}`);
    const fullDesc = descParts.filter(Boolean).join('\n');

    const result = bdArgs(['create', `--title=${title}`, `--description=${fullDesc}`, '--type=task', '--priority=3', '--json']);
    if (!result) {
      forgeError('COMMAND_FAILED', 'Failed to create todo bead', 'Check bd connectivity with: bd list --limit 1');
    }

    const todoId = parseBdCreateId(result);

    if (!todoId) {
      forgeError('COMMAND_FAILED', 'Failed to parse todo bead ID from bd output', 'Check bd connectivity and try again', { rawOutput: result });
    }

    bd(`label add ${todoId} forge:todo`, { allowFail: true });
    bd(`dep add ${todoId} ${projectId} --type=parent-child`, { allowFail: true });

    output({ todo_id: todoId });
  },

  /**
   * List milestone beads under a project.
   */
  'milestone-list'(args) {
    const projectId = args[0];
    if (!projectId) {
      forgeError('MISSING_ARG', 'Missing required argument: project-id', 'Run: forge-tools milestone-list <project-id>');
    }

    const issues = normalizeChildren(bdJson(`children ${projectId}`));
    const milestones = issues.filter(i => (i.labels || []).includes('forge:milestone'));

    const result = milestones.map(m => {
      const mIssues = normalizeChildren(bdJson(`children ${m.id}`));
      const phases = mIssues.filter(i => (i.labels || []).includes('forge:phase'));
      const reqs = mIssues.filter(i => (i.labels || []).includes('forge:req'));

      const closedPhases = phases.filter(p => p.status === 'closed');
      const closedReqs = reqs.filter(r => r.status === 'closed');

      return {
        id: m.id,
        title: m.title,
        status: m.status,
        description: m.description,
        phases: phases.map(p => ({ id: p.id, title: p.title, status: p.status })),
        requirements: reqs.map(r => ({ id: r.id, title: r.title, status: r.status })),
        stats: {
          total_phases: phases.length,
          closed_phases: closedPhases.length,
          total_requirements: reqs.length,
          closed_requirements: closedReqs.length,
        },
      };
    });

    output({
      project_id: projectId,
      milestones: result,
      total: result.length,
    });
  },

  /**
   * Audit a milestone: check requirement coverage and phase completion.
   */
  'milestone-audit'(args) {
    const milestoneId = args[0];
    if (!milestoneId) {
      forgeError('MISSING_ARG', 'Missing required argument: milestone-id', 'Run: forge-tools milestone-audit <milestone-id>');
    }

    const milestone = bdJson(`show ${milestoneId}`);
    if (!milestone) {
      forgeError('NOT_FOUND', `Milestone not found: ${milestoneId}`, 'Verify the milestone ID with: forge-tools milestone-list <project-id>', { milestoneId });
    }

    const issues = normalizeChildren(bdJson(`children ${milestoneId}`));
    const phases = issues.filter(i => (i.labels || []).includes('forge:phase'));
    const requirements = issues.filter(i => (i.labels || []).includes('forge:req'));

    const phaseHealth = phases.map(phase => {
      const pIssues = normalizeChildren(bdJson(`children ${phase.id}`));
      const tasks = pIssues.filter(i => (i.labels || []).includes('forge:task'));
      const closedTasks = tasks.filter(t => t.status === 'closed');
      return {
        id: phase.id,
        title: phase.title,
        status: phase.status,
        total_tasks: tasks.length,
        closed_tasks: closedTasks.length,
        open_tasks: tasks.length - closedTasks.length,
      };
    });

    const reqCoverage = requirements.map(req => {
      const depsRaw = bd(`dep list ${req.id} --direction=up --type validates --json`, { allowFail: true });
      let validators = [];
      if (depsRaw) {
        try {
          const deps = JSON.parse(depsRaw);
          validators = Array.isArray(deps) ? deps : (deps.dependencies || []);
        } catch { /* parse error */ }
      }
      const closedValidators = validators.filter(v => v.status === 'closed');
      let coverage = 'unsatisfied';
      if (closedValidators.length > 0) coverage = 'satisfied';
      else if (validators.length > 0) coverage = 'partial';

      return {
        id: req.id,
        title: req.title,
        status: req.status,
        coverage,
        validator_count: validators.length,
        closed_validator_count: closedValidators.length,
      };
    });

    const uncovered = reqCoverage.filter(r => r.coverage === 'unsatisfied');
    const partial = reqCoverage.filter(r => r.coverage === 'partial');
    const satisfied = reqCoverage.filter(r => r.coverage === 'satisfied');

    output({
      milestone: { id: milestone.id, title: milestone.title, status: milestone.status },
      phases: phaseHealth,
      requirements: reqCoverage,
      uncovered_requirements: uncovered,
      partial_requirements: partial,
      satisfied_requirements: satisfied,
      summary: {
        total_phases: phases.length,
        closed_phases: phases.filter(p => p.status === 'closed').length,
        total_requirements: requirements.length,
        satisfied: satisfied.length,
        partial: partial.length,
        unsatisfied: uncovered.length,
      },
    });
  },

  /**
   * Create a milestone epic bead under a project.
   */
  'milestone-create'(args) {
    const projectId = args[0];
    const name = args.slice(1).join(' ');
    if (!projectId || !name) {
      forgeError('MISSING_ARG', 'Missing required arguments: project-id and milestone-name', 'Run: forge-tools milestone-create <project-id> <milestone-name>');
    }

    const title = `Milestone: ${name}`;
    const createRaw = bdArgs(['create', `--title=${title}`, '--type=epic', '--priority=1', '--json']);
    let created;
    try { created = JSON.parse(createRaw); if (Array.isArray(created)) created = created[0]; } catch { created = null; }
    if (!created || !created.id) {
      forgeError('COMMAND_FAILED', 'Failed to create milestone bead', 'Check bd connectivity with: bd list --limit 1');
    }

    bd(`label add ${created.id} forge:milestone`);
    bd(`dep add ${created.id} ${projectId} --type=parent-child`);

    output({
      ok: true,
      milestone_id: created.id,
      title,
      project_id: projectId,
    });
  },

  /**
   * Create a monorepo parent bead and child project beads for each workspace.
   */
  'monorepo-create'(args) {
    const name = args.join(' ').trim();
    if (!name) {
      forgeError('MISSING_ARG', 'Missing required argument: monorepo-name', 'Run: forge-tools monorepo-create <monorepo-name>');
    }

    // 1. Detect workspace packages
    const rootDir = process.cwd();
    const detected = detectWorkspaces(rootDir);

    // 2. Create monorepo parent bead
    const title = name;
    const createRaw = bdArgs(['create', `--title=${title}`, '--type=epic', '--priority=1', '--json']);
    let created;
    try { created = JSON.parse(createRaw); if (Array.isArray(created)) created = created[0]; } catch { created = null; }
    if (!created || !created.id) {
      forgeError('COMMAND_FAILED', 'Failed to create monorepo bead', 'Check bd connectivity with: bd list --limit 1');
    }

    bd(`label add ${created.id} forge:monorepo`);

    // 3. Create child forge:project beads for each detected package
    // Children use flat workspace_path; the parent's workspace_paths map uses child bead IDs as keys.
    const children = [];
    for (const pkg of detected.packages) {
      const childRaw = bdArgs(['create', `--title=${pkg.name}`, '--type=epic', '--priority=2', '--json']);
      let child;
      try { child = JSON.parse(childRaw); if (Array.isArray(child)) child = child[0]; } catch { child = null; }
      if (!child || !child.id) continue;

      bd(`label add ${child.id} forge:project`);
      bd(`dep add ${child.id} ${created.id} --type=parent-child`);
      // Child stores a flat workspace_path for direct lookup via extractWorkspacePath
      bdArgs(['update', child.id, `--design=workspace_path: ${pkg.path}`]);
      children.push({ id: child.id, name: pkg.name, path: pkg.path });
    }

    // Store workspace paths in the parent's design field keyed by child bead ID
    // so that extractWorkspacePath(parentBead) can resolve correctly when called
    // with a bead whose ID matches a child's ID.
    if (children.length > 0) {
      const yamlLines = ['workspace_paths:'];
      for (const child of children) {
        yamlLines.push(`  ${child.id}: ${child.path}`);
      }
      bdArgs(['update', created.id, `--design=${yamlLines.join('\n')}`]);
    }

    output({
      ok: true,
      monorepo_id: created.id,
      title,
      detection_source: detected.source,
      children,
    });
  },

  'init-quick'(args) {
    const description = args.join(' ').trim() || null;

    const projectResult = bd('list --label forge:project --json', { allowFail: true });
    let project = null;
    if (projectResult) {
      try {
        const data = JSON.parse(projectResult);
        const issues = Array.isArray(data) ? data : (data.issues || []);
        if (issues.length > 0) project = issues[0];
      } catch { /* parse error */ }
    }

    const models = {
      planner: resolveAgentModel('forge-planner'),
      executor: resolveAgentModel('forge-executor'),
      plan_checker: resolveAgentModel('forge-plan-checker'),
      verifier: resolveAgentModel('forge-verifier'),
    };

    const { merged } = loadMergedSettings();

    output({
      found: !!project,
      project_id: project ? project.id : null,
      project_title: project ? project.title : null,
      description,
      models,
      settings: merged,
    });
  },
};
