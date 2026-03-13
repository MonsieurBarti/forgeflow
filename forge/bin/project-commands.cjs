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
const {
  bd, bdArgs, bdJson, output,
  GLOBAL_SETTINGS_PATH, PROJECT_SETTINGS_NAME,
  SETTINGS_DEFAULTS, SETTINGS_DESCRIPTIONS,
  MODEL_PROFILES, ROLE_TO_AGENT,
  parseSimpleYaml, toSimpleYaml, parseFrontmatter, writeFrontmatter,
  resolveAgentModel, loadModelProfile, loadModelOverrides,
} = require('./core.cjs');

/**
 * Detect workspace packages from turbo.json, nx.json, or pnpm-workspace.yaml.
 * Returns { source: string, packages: Array<{ name: string, path: string }> }
 */
function detectWorkspaces(rootDir) {
  // Helper: expand simple glob patterns (e.g., "apps/*", "packages/*") to directories
  function expandGlobs(patterns, root) {
    const results = [];
    for (const pattern of patterns) {
      const clean = pattern.replace(/\/\*\*?$/, '').replace(/\*$/, '');
      if (clean.includes('*')) continue; // skip complex globs
      const dir = path.join(root, clean);
      if (fs.existsSync(dir) && fs.statSync(dir).isDirectory()) {
        // If the pattern ended with /*, list subdirectories
        if (pattern.endsWith('/*') || pattern.endsWith('/**')) {
          try {
            const entries = fs.readdirSync(dir, { withFileTypes: true });
            for (const entry of entries) {
              if (entry.isDirectory() && !entry.name.startsWith('.')) {
                const pkgPath = path.join(clean, entry.name);
                const pkgJsonPath = path.join(root, pkgPath, 'package.json');
                let name = entry.name;
                if (fs.existsSync(pkgJsonPath)) {
                  try {
                    const pkg = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf8'));
                    if (pkg.name) name = pkg.name;
                  } catch { /* use dir name */ }
                }
                results.push({ name, path: pkgPath });
              }
            }
          } catch { /* skip unreadable */ }
        } else {
          // Direct path (no glob)
          const pkgJsonPath = path.join(root, clean, 'package.json');
          let name = path.basename(clean);
          if (fs.existsSync(pkgJsonPath)) {
            try {
              const pkg = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf8'));
              if (pkg.name) name = pkg.name;
            } catch { /* use dir name */ }
          }
          results.push({ name, path: clean });
        }
      }
    }
    return results;
  }

  // Try pnpm-workspace.yaml
  const pnpmPath = path.join(rootDir, 'pnpm-workspace.yaml');
  if (fs.existsSync(pnpmPath)) {
    try {
      const raw = fs.readFileSync(pnpmPath, 'utf8');
      const parsed = parseSimpleYaml(raw);
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
  if (fs.existsSync(turboPath)) {
    // Turborepo uses package.json workspaces field
    const pkgPath = path.join(rootDir, 'package.json');
    if (fs.existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
        const workspaces = Array.isArray(pkg.workspaces) ? pkg.workspaces : (pkg.workspaces?.packages || []);
        if (workspaces.length > 0) {
          return { source: 'turbo.json+package.json', packages: expandGlobs(workspaces, rootDir) };
        }
      } catch { /* fall through */ }
    }
  }

  // Try nx.json
  const nxPath = path.join(rootDir, 'nx.json');
  if (fs.existsSync(nxPath)) {
    // Nx uses package.json workspaces or project.json files
    const pkgPath = path.join(rootDir, 'package.json');
    if (fs.existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
        const workspaces = Array.isArray(pkg.workspaces) ? pkg.workspaces : (pkg.workspaces?.packages || []);
        if (workspaces.length > 0) {
          return { source: 'nx.json+package.json', packages: expandGlobs(workspaces, rootDir) };
        }
      } catch { /* fall through */ }
    }
  }

  // Fallback: check package.json workspaces directly (yarn/npm workspaces)
  const rootPkgPath = path.join(rootDir, 'package.json');
  if (fs.existsSync(rootPkgPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(rootPkgPath, 'utf8'));
      const workspaces = Array.isArray(pkg.workspaces) ? pkg.workspaces : (pkg.workspaces?.packages || []);
      if (workspaces.length > 0) {
        return { source: 'package.json', packages: expandGlobs(workspaces, rootDir) };
      }
    } catch { /* fall through */ }
  }

  return { source: 'none', packages: [] };
}

/**
 * Collect all phases and requirements for a project, traversing milestones.
 * Hierarchy: Project > Milestone > Phases/Requirements
 * Also picks up any phases/reqs still directly under the project (legacy).
 */
function collectProjectIssues(projectId) {
  const children = bdJson(`children ${projectId}`);
  const issues = Array.isArray(children) ? children : (children?.issues || children?.children || []);

  const milestones = issues.filter(i => (i.labels || []).includes('forge:milestone'));
  const phases = [];
  const requirements = [];
  const seenIds = new Set();

  const addIssues = (items) => {
    for (const i of items) {
      if (seenIds.has(i.id)) continue;
      seenIds.add(i.id);
      if ((i.labels || []).includes('forge:phase')) phases.push(i);
      else if ((i.labels || []).includes('forge:req') || i.issue_type === 'feature') requirements.push(i);
    }
  };

  // Collect from milestones (correct hierarchy)
  for (const ms of milestones) {
    const msChildren = bdJson(`children ${ms.id}`);
    const msIssues = Array.isArray(msChildren) ? msChildren : (msChildren?.issues || msChildren?.children || []);
    addIssues(msIssues);
  }

  // Also collect any legacy direct children
  addIssues(issues);

  return { milestones, phases, requirements };
}

// generateDashboardHTML and esc are inlined here since they are only used in generate-dashboard.

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

  const phaseCardsHTML = phaseDetails.map((phase) => {
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

  const reqGridHTML = reqCoverage.map(r => {
    const cls = r.covered ? 'req-covered' : 'req-uncovered';
    return `<div class="req-cell ${cls}" title="${esc(r.title)} (${r.id})${r.covered ? ' — ' + r.covering_tasks + ' tasks' : ' — UNCOVERED'}">${esc(r.title.length > 30 ? r.title.slice(0, 28) + '\u2026' : r.title)}</div>`;
  }).join('\n');

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

  const chartData = JSON.stringify({
    phaseLabels: ['Completed', 'In Progress', 'Open'],
    phaseValues: [completedPhases, phasesInProgress, phasesOpen],
    phaseColors: ['#2ecc71', '#f39c12', '#95a5a6'],
    reqLabels: ['Covered', 'Uncovered'],
    reqValues: [reqsCovered, reqsTotal - reqsCovered],
    reqColors: ['#2ecc71', '#e74c3c'],
  });

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
    --bg: #0d1117; --surface: #161b22; --surface-2: #1c2128; --border: #30363d;
    --text: #e6edf3; --text-muted: #8b949e; --accent: #58a6ff;
    --green: #2ecc71; --orange: #f39c12; --red: #e74c3c; --blue: #58a6ff;
    --sidebar-w: 200px;
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: 'IBM Plex Sans', -apple-system, sans-serif; background: var(--bg); color: var(--text); line-height: 1.6; display: grid; grid-template-columns: var(--sidebar-w) 1fr; min-height: 100vh; }
  code, .mono { font-family: 'IBM Plex Mono', monospace; font-size: 0.85em; color: var(--text-muted); }
  .sidebar { position: sticky; top: 0; height: 100vh; background: var(--surface); border-right: 1px solid var(--border); padding: 2rem 1rem; display: flex; flex-direction: column; gap: 0.5rem; }
  .sidebar h2 { font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.1em; color: var(--text-muted); margin-bottom: 0.5rem; }
  .sidebar a { display: block; color: var(--text-muted); text-decoration: none; padding: 0.4rem 0.75rem; border-radius: 6px; font-size: 0.9rem; transition: all 0.15s; }
  .sidebar a:hover { color: var(--text); background: var(--surface-2); }
  .main { padding: 2.5rem 3rem; width: 100%; }
  .main h1 { font-size: 1.75rem; font-weight: 600; margin-bottom: 0.25rem; }
  .subtitle { color: var(--text-muted); font-size: 0.85rem; margin-bottom: 2rem; }
  .overview-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 1rem; margin-bottom: 2.5rem; }
  .stat-card { background: var(--surface); border: 1px solid var(--border); border-radius: 8px; padding: 1.25rem; }
  .stat-card .stat-value { font-size: 2rem; font-weight: 700; line-height: 1; }
  .stat-card .stat-label { font-size: 0.8rem; color: var(--text-muted); margin-top: 0.25rem; }
  .stat-card.accent .stat-value { color: var(--accent); }
  .stat-card.green .stat-value { color: var(--green); }
  .stat-card.orange .stat-value { color: var(--orange); }
  .big-progress { margin-bottom: 2.5rem; }
  .big-progress-bar { width: 100%; height: 12px; background: var(--surface-2); border-radius: 6px; overflow: hidden; }
  .big-progress-fill { height: 100%; background: linear-gradient(90deg, var(--green), var(--accent)); border-radius: 6px; }
  .big-progress-label { text-align: right; font-size: 0.85rem; color: var(--text-muted); margin-top: 0.25rem; }
  section { margin-bottom: 2.5rem; }
  section h2 { font-size: 1.25rem; font-weight: 600; margin-bottom: 1rem; border-bottom: 1px solid var(--border); padding-bottom: 0.5rem; }
  .phase-card { background: var(--surface); border: 1px solid var(--border); border-radius: 8px; padding: 1.25rem; margin-bottom: 1rem; }
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
  .task-done { color: var(--green); } .task-active { color: var(--orange); } .task-pending { color: var(--text-muted); }
  .no-tasks { color: var(--text-muted); font-size: 0.85rem; font-style: italic; }
  .phase-desc { color: var(--text-muted); font-size: 0.85rem; margin-bottom: 0.5rem; }
  .task-list details summary { cursor: pointer; display: flex; align-items: center; gap: 0.5rem; list-style: none; }
  .task-list details summary::-webkit-details-marker { display: none; }
  .task-list details[open] summary { margin-bottom: 0.4rem; }
  .task-details { margin-left: 1.7rem; padding: 0.5rem 0.75rem; background: var(--surface-2); border-radius: 6px; font-size: 0.8rem; color: var(--text-muted); }
  .task-details pre { white-space: pre-wrap; font-family: 'IBM Plex Mono', monospace; font-size: 0.78rem; margin-top: 0.25rem; }
  .task-desc, .task-ac { margin-bottom: 0.4rem; }
  .no-detail summary { cursor: default; }
  .req-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 0.5rem; }
  .req-cell { padding: 0.6rem 0.8rem; border-radius: 6px; font-size: 0.8rem; font-weight: 500; }
  .req-covered { background: rgba(46,204,113,0.12); color: var(--green); border: 1px solid rgba(46,204,113,0.25); }
  .req-uncovered { background: rgba(231,76,60,0.12); color: var(--red); border: 1px solid rgba(231,76,60,0.25); }
  .blocker-item { background: rgba(231,76,60,0.08); border: 1px solid rgba(231,76,60,0.2); border-radius: 6px; padding: 0.75rem 1rem; margin-bottom: 0.5rem; font-size: 0.9rem; }
  .blocker-type { font-size: 0.7rem; text-transform: uppercase; color: var(--red); font-weight: 600; margin-right: 0.5rem; }
  .blocker-phase { color: var(--text-muted); font-size: 0.8rem; }
  .no-blockers { color: var(--green); font-size: 0.9rem; }
  .chart-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 2rem; }
  .chart-container { background: var(--surface); border: 1px solid var(--border); border-radius: 8px; padding: 1.5rem; }
  .chart-container h3 { font-size: 0.9rem; font-weight: 500; margin-bottom: 1rem; color: var(--text-muted); }
  canvas { max-height: 250px; }
  @media (max-width: 768px) { body { grid-template-columns: 1fr; } .sidebar { display: none; } .main { padding: 1.5rem; } .overview-grid { grid-template-columns: repeat(2, 1fr); } .chart-grid { grid-template-columns: 1fr; } }
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
      <div class="chart-container"><h3>Phase Status</h3><canvas id="phaseChart"></canvas></div>
      <div class="chart-container"><h3>Requirement Coverage</h3><canvas id="reqChart"></canvas></div>
    </div>
  </section>
</main>
<script>
  const d = ${chartData};
  const chartOpts = { responsive: true, plugins: { legend: { labels: { color: '#e6edf3', font: { family: 'IBM Plex Sans' } } } } };
  new Chart(document.getElementById('phaseChart'), { type: 'doughnut', data: { labels: d.phaseLabels, datasets: [{ data: d.phaseValues, backgroundColor: d.phaseColors, borderWidth: 0 }] }, options: chartOpts });
  new Chart(document.getElementById('reqChart'), { type: 'doughnut', data: { labels: d.reqLabels, datasets: [{ data: d.reqValues, backgroundColor: d.reqColors, borderWidth: 0 }] }, options: chartOpts });
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
        if (issues.length > 0) {
          // One project per repo — return the first (and should be only) project
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
      console.error('Usage: forge-tools remember <text>');
      process.exit(1);
    }
    bd(`remember ${memory}`);
    output({ ok: true, memory });
  },

  /**
   * Get full project context for a workflow.
   */
  'project-context'(args) {
    const projectId = args[0];
    if (!projectId) {
      console.error('Usage: forge-tools project-context <project-bead-id>');
      process.exit(1);
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
      console.error('Usage: forge-tools progress <project-bead-id>');
      process.exit(1);
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
      console.error('Usage: forge-tools full-progress <project-bead-id>');
      process.exit(1);
    }

    const project = bdJson(`show ${projectId}`);
    const { phases, requirements } = collectProjectIssues(projectId);

    const phaseDetails = [];
    for (const phase of phases) {
      const phaseChildren = bdJson(`children ${phase.id}`);
      const tasks = Array.isArray(phaseChildren) ? phaseChildren : (phaseChildren?.issues || phaseChildren?.children || []);

      phaseDetails.push({
        id: phase.id,
        title: phase.title,
        status: phase.status,
        tasks_total: tasks.length,
        tasks_open: tasks.filter(t => t.status === 'open').length,
        tasks_in_progress: tasks.filter(t => t.status === 'in_progress').length,
        tasks_closed: tasks.filter(t => t.status === 'closed').length,
        tasks: tasks.map(t => ({ id: t.id, title: t.title, status: t.status })),
      });
    }

    const reqCoverage = [];
    for (const req of requirements) {
      const depsRaw = bd(`dep list ${req.id} --direction=up --type validates --json`, { allowFail: true });
      let deps = [];
      if (depsRaw) {
        try { deps = JSON.parse(depsRaw); } catch { /* ignore */ }
      }
      reqCoverage.push({
        id: req.id,
        title: req.title,
        covered: Array.isArray(deps) && deps.length > 0,
        covering_tasks: Array.isArray(deps) ? deps.length : 0,
      });
    }

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
      console.error('Usage: forge-tools generate-dashboard <project-bead-id>');
      process.exit(1);
    }

    const project = bdJson(`show ${projectId}`);
    const { phases, requirements } = collectProjectIssues(projectId);

    const phaseDetails = [];
    for (const phase of phases) {
      const phaseChildren = bdJson(`children ${phase.id}`);
      const tasks = Array.isArray(phaseChildren) ? phaseChildren : (phaseChildren?.issues || phaseChildren?.children || []);
      phaseDetails.push({
        id: phase.id,
        title: phase.title,
        description: phase.description || '',
        status: phase.status,
        tasks_total: tasks.length,
        tasks_open: tasks.filter(t => t.status === 'open').length,
        tasks_in_progress: tasks.filter(t => t.status === 'in_progress').length,
        tasks_closed: tasks.filter(t => t.status === 'closed').length,
        tasks: tasks.map(t => ({ id: t.id, title: t.title, status: t.status, description: t.description || '', acceptance_criteria: t.acceptance_criteria || '' })),
      });
    }

    phaseDetails.sort((a, b) => {
      const numA = parseFloat((a.title.match(/Phase\s+([\d.]+)/i) || [])[1]) || 999;
      const numB = parseFloat((b.title.match(/Phase\s+([\d.]+)/i) || [])[1]) || 999;
      return numA - numB;
    });

    const reqCoverage = [];
    for (const req of requirements) {
      const depsRaw = bd(`dep list ${req.id} --direction=up --type validates --json`, { allowFail: true });
      let deps = [];
      if (depsRaw) { try { deps = JSON.parse(depsRaw); } catch { /* ignore */ } }
      reqCoverage.push({
        id: req.id,
        title: req.title,
        covered: Array.isArray(deps) && deps.length > 0,
        covering_tasks: Array.isArray(deps) ? deps.length : 0,
      });
    }

    const totalPhases = phases.length;
    const completedPhases = phases.filter(p => p.status === 'closed').length;
    const phasesInProgress = phases.filter(p => p.status === 'in_progress');
    const blockedPhases = phases.filter(p => p.status === 'blocked');
    const progressPercent = totalPhases > 0 ? Math.round((completedPhases / totalPhases) * 100) : 0;

    const projectTitle = project?.title || projectId;
    const timestamp = new Date().toISOString().replace('T', ' ').replace(/\.\d+Z/, ' UTC');

    const data = {
      projectTitle, projectId, timestamp, progressPercent,
      totalPhases, completedPhases, phasesInProgress, blockedPhases,
      phaseDetails, reqCoverage,
    };

    const html = generateDashboardHTML(data);

    const diagDir = path.join(process.cwd(), '.forge');
    fs.mkdirSync(diagDir, { recursive: true });
    const filePath = path.join(diagDir, `forge-dashboard-${projectId}.html`);
    fs.writeFileSync(filePath, html, 'utf8');

    output({ path: filePath, projectId, timestamp });
  },

  /**
   * Save session state for forge:pause.
   */
  'save-session'(args) {
    const projectId = args[0];
    if (!projectId) {
      console.error('Usage: forge-tools save-session <project-bead-id>');
      process.exit(1);
    }

    const children = bdJson(`children ${projectId}`);
    const issues = Array.isArray(children) ? children : (children?.issues || children?.children || []);
    const phases = issues.filter(i => (i.labels || []).includes('forge:phase'));

    const currentPhase = phases.find(p => p.status === 'in_progress') || phases.find(p => p.status === 'open');
    const completedPhases = phases.filter(p => p.status === 'closed').length;

    const inProgressTasks = [];
    for (const phase of phases) {
      if (phase.status === 'closed') continue;
      const phaseChildren = bdJson(`children ${phase.id}`);
      const tasks = Array.isArray(phaseChildren) ? phaseChildren : (phaseChildren?.issues || phaseChildren?.children || []);
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

    const memoryKey = `forge:session:state`;
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

    const children = bdJson(`children ${project.id}`);
    const issues = Array.isArray(children) ? children : (children?.issues || children?.children || []);
    const phases = issues.filter(i => (i.labels || []).includes('forge:phase'));
    const currentPhase = phases.find(p => p.status === 'in_progress') || phases.find(p => p.status === 'open');

    const inProgressTasks = [];
    if (currentPhase) {
      const phaseChildren = bdJson(`children ${currentPhase.id}`);
      const tasks = Array.isArray(phaseChildren) ? phaseChildren : (phaseChildren?.issues || phaseChildren?.children || []);
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
      console.error('Usage: forge-tools health <project-bead-id>');
      process.exit(1);
    }

    const project = bdJson(`show ${projectId}`);
    if (!project) {
      output({ error: 'Project not found', project_id: projectId });
      return;
    }

    const children = bdJson(`children ${projectId}`);
    const issues = Array.isArray(children) ? children : (children?.issues || children?.children || []);

    const phases = issues.filter(i =>
      (i.labels || []).includes('forge:phase') || i.issue_type === 'epic'
    ).filter(i => i.id !== projectId);
    const requirements = issues.filter(i =>
      (i.labels || []).includes('forge:req') || i.issue_type === 'feature'
    );

    const diagnostics = { structure: [], dependencies: [], state: [], config: [], installation: [] };

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

    const allTasks = [];
    const unlabeledTasks = [];
    for (const phase of phases) {
      const phaseChildren = bdJson(`children ${phase.id}`);
      const tasks = Array.isArray(phaseChildren) ? phaseChildren : (phaseChildren?.issues || phaseChildren?.children || []);
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
      const phaseChildren = bdJson(`children ${phase.id}`);
      const tasks = Array.isArray(phaseChildren) ? phaseChildren : (phaseChildren?.issues || phaseChildren?.children || []);
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

    const { homedir } = require('os');
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

    const allChecks = [
      ...diagnostics.structure,
      ...diagnostics.dependencies,
      ...diagnostics.state,
      ...diagnostics.config,
      ...diagnostics.installation,
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
      console.error('Usage: forge-tools settings-set <global|project> <key> <value>');
      process.exit(1);
    }

    const dotIdx = key.indexOf('.');
    const isNested = dotIdx !== -1;
    const topKey = isNested ? key.slice(0, dotIdx) : key;
    const subKey = isNested ? key.slice(dotIdx + 1) : null;

    const EXTRA_TOP_KEYS = ['model_profile', 'model_overrides'];
    if (!isNested && !(topKey in SETTINGS_DEFAULTS) && !EXTRA_TOP_KEYS.includes(topKey)) {
      console.error(`Unknown setting: ${key}`);
      console.error(`Available: ${Object.keys(SETTINGS_DEFAULTS).join(', ')}, model_profile, model_overrides.<agent>, models.<role>`);
      process.exit(1);
    }

    let parsedValue = value;
    if (value === 'true') parsedValue = true;
    else if (value === 'false') parsedValue = false;

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
      console.error('Scope must be "global" or "project"');
      process.exit(1);
    }
  },

  /**
   * Clear a setting from a scope.
   */
  'settings-clear'(args) {
    const scope = args[0];
    const key = args[1];

    if (!scope || !key) {
      console.error('Usage: forge-tools settings-clear <global|project> <key>');
      process.exit(1);
    }

    const dotIdx = key.indexOf('.');
    const isNested = dotIdx !== -1;
    const topKey = isNested ? key.slice(0, dotIdx) : key;
    const subKey = isNested ? key.slice(dotIdx + 1) : null;

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
      console.error('Usage: forge-tools settings-bulk <global|project> <json>');
      process.exit(1);
    }

    let updates;
    try {
      updates = JSON.parse(jsonStr);
    } catch {
      console.error('Invalid JSON');
      process.exit(1);
    }

    const results = [];
    for (const [key, value] of Object.entries(updates)) {
      if (!(key in SETTINGS_DEFAULTS)) continue;
      let parsedValue = value;
      if (value === 'true') parsedValue = true;
      else if (value === 'false') parsedValue = false;

      if (scope === 'global') {
        let existing = {};
        let body = '';
        try {
          const text = fs.readFileSync(GLOBAL_SETTINGS_PATH, 'utf8');
          existing = parseFrontmatter(text);
          const bodyMatch = text.match(/^---\n[\s\S]*?\n---\n([\s\S]*)$/);
          if (bodyMatch) body = bodyMatch[1];
        } catch { /* new file */ }
        existing[key] = parsedValue;
        writeFrontmatter(GLOBAL_SETTINGS_PATH, existing, body);
      } else if (scope === 'project') {
        const projectPath = path.resolve(process.cwd(), PROJECT_SETTINGS_NAME);
        let existing = {};
        try {
          existing = parseSimpleYaml(fs.readFileSync(projectPath, 'utf8'));
        } catch { /* new file */ }
        existing[key] = parsedValue;
        const dir = path.dirname(projectPath);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(projectPath, toSimpleYaml(existing));
      }
      results.push({ key, value: parsedValue });
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
      console.error('Usage: forge-tools resolve-model <agent-name> [--raw]');
      process.exit(1);
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
      console.error('Usage: forge-tools model-for-role <role>');
      process.exit(1);
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
      console.error('Usage: forge-tools config-get <key>');
      process.exit(1);
    }
    const fullKey = key.startsWith('forge.') ? key : `forge.${key}`;
    const value = bd(`kv get ${fullKey}`, { allowFail: true });
    output({ key: fullKey, value: value || null });
  },

  /**
   * Set a Forge config value via bd kv.
   */
  'config-set'(args) {
    const key = args[0];
    const value = args.slice(1).join(' ');
    if (!key || !value) {
      console.error('Usage: forge-tools config-set <key> <value>');
      process.exit(1);
    }
    const fullKey = key.startsWith('forge.') ? key : `forge.${key}`;
    bd(`kv set ${fullKey} ${value}`);
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
      console.error('Usage: forge-tools config-clear <key>');
      process.exit(1);
    }
    const fullKey = key.startsWith('forge.') ? key : `forge.${key}`;
    bd(`kv clear ${fullKey}`, { allowFail: true });
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

    const result = bd(`create --title="${title}" --description="${description}" --type=task --json`);
    if (!result) {
      console.error('Failed to create debug bead');
      process.exit(1);
    }

    let debugId;
    try {
      const data = JSON.parse(result);
      debugId = data.id || data.issue_id;
    } catch {
      const match = result.match(/([a-z]+-[a-z0-9]+)/);
      debugId = match ? match[1] : null;
    }

    if (!debugId) {
      console.error('Failed to parse debug bead ID from:', result);
      process.exit(1);
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
      console.error('Usage: debug-update <id> <field> <value>');
      process.exit(1);
    }

    if (field === 'notes') {
      bd(`update ${id} --notes="${value.replace(/"/g, '\\"')}"`, { allowFail: true });
    } else if (field === 'design') {
      bd(`update ${id} --design="${value.replace(/"/g, '\\"')}"`, { allowFail: true });
    } else if (field === 'status') {
      bd(`update ${id} --status=${value}`, { allowFail: true });
    } else {
      console.error(`Unknown field: ${field}. Use: notes, design, status`);
      process.exit(1);
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
      console.error('Usage: todo-create <project-id> <title> [description] [area] [files]');
      process.exit(1);
    }

    const descParts = [description];
    if (area) descParts.push(`Area: ${area}`);
    if (files) descParts.push(`Files: ${files}`);
    const fullDesc = descParts.filter(Boolean).join('\n');

    const result = bd(`create --title="${title.replace(/"/g, '\\"')}" --description="${fullDesc.replace(/"/g, '\\"')}" --type=task --priority=3 --json`);
    if (!result) {
      console.error('Failed to create todo bead');
      process.exit(1);
    }

    let todoId;
    try {
      const data = JSON.parse(result);
      todoId = data.id || data.issue_id;
    } catch {
      const match = result.match(/([a-z]+-[a-z0-9]+)/);
      todoId = match ? match[1] : null;
    }

    if (!todoId) {
      console.error('Failed to parse todo bead ID from:', result);
      process.exit(1);
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
      console.error('Usage: forge-tools milestone-list <project-id>');
      process.exit(1);
    }

    const children = bdJson(`children ${projectId}`);
    const issues = Array.isArray(children) ? children : (children?.issues || children?.children || []);
    const milestones = issues.filter(i => (i.labels || []).includes('forge:milestone'));

    const result = milestones.map(m => {
      const mChildren = bdJson(`children ${m.id}`);
      const mIssues = Array.isArray(mChildren) ? mChildren : (mChildren?.issues || mChildren?.children || []);
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
      console.error('Usage: forge-tools milestone-audit <milestone-id>');
      process.exit(1);
    }

    const milestone = bdJson(`show ${milestoneId}`);
    if (!milestone) {
      console.error(`Milestone not found: ${milestoneId}`);
      process.exit(1);
    }

    const children = bdJson(`children ${milestoneId}`);
    const issues = Array.isArray(children) ? children : (children?.issues || children?.children || []);
    const phases = issues.filter(i => (i.labels || []).includes('forge:phase'));
    const requirements = issues.filter(i => (i.labels || []).includes('forge:req'));

    const phaseHealth = phases.map(phase => {
      const pChildren = bdJson(`children ${phase.id}`);
      const pIssues = Array.isArray(pChildren) ? pChildren : (pChildren?.issues || pChildren?.children || []);
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
      console.error('Usage: forge-tools milestone-create <project-id> <milestone-name>');
      process.exit(1);
    }

    const title = `Milestone: ${name}`;
    const createRaw = bdArgs(['create', `--title=${title}`, '--type=epic', '--priority=1', '--json']);
    let created;
    try { created = JSON.parse(createRaw); if (Array.isArray(created)) created = created[0]; } catch { created = null; }
    if (!created || !created.id) {
      console.error('Failed to create milestone bead');
      process.exit(1);
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
   * Initialize a quick task workflow.
   */
  'monorepo-create'(args) {
    const name = args.join(' ').trim();
    if (!name) {
      console.error('Usage: forge-tools monorepo-create <monorepo-name>');
      process.exit(1);
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
      console.error('Failed to create monorepo bead');
      process.exit(1);
    }

    bd(`label add ${created.id} forge:monorepo`);

    // Store workspace paths in design field as YAML
    if (detected.packages.length > 0) {
      const yamlLines = ['workspace_paths:'];
      for (const pkg of detected.packages) {
        yamlLines.push(`  ${pkg.name}: ${pkg.path}`);
      }
      bdArgs(['update', created.id, `--design=${yamlLines.join('\n')}`]);
    }

    // 3. Create child forge:project beads for each detected package
    const children = [];
    for (const pkg of detected.packages) {
      const childRaw = bdArgs(['create', `--title=${pkg.name}`, '--type=epic', '--priority=2', '--json']);
      let child;
      try { child = JSON.parse(childRaw); if (Array.isArray(child)) child = child[0]; } catch { child = null; }
      if (!child || !child.id) continue;

      bd(`label add ${child.id} forge:project`);
      bd(`dep add ${child.id} ${created.id} --type=parent-child`);
      bdArgs(['update', child.id, `--design=workspace_path: ${pkg.path}`]);
      children.push({ id: child.id, name: pkg.name, path: pkg.path });
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

    const merged = { ...SETTINGS_DEFAULTS };
    try {
      const globalText = fs.readFileSync(GLOBAL_SETTINGS_PATH, 'utf8');
      const globalSettings = parseFrontmatter(globalText);
      for (const [key, val] of Object.entries(globalSettings)) {
        if (key in SETTINGS_DEFAULTS) merged[key] = val;
      }
    } catch { /* no global settings */ }
    try {
      const projectPath = path.resolve(process.cwd(), PROJECT_SETTINGS_NAME);
      const projectSettings = parseSimpleYaml(fs.readFileSync(projectPath, 'utf8'));
      for (const [key, val] of Object.entries(projectSettings)) {
        if (key in SETTINGS_DEFAULTS) merged[key] = val;
      }
    } catch { /* no project settings */ }

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
