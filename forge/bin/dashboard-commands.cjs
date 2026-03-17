'use strict';

const fs = require('fs');
const path = require('path');
const {
  bdJsonArgs, output, forgeError, validateId,
  findGitRoot, parseFrontmatter, resolveSettings,
} = require('./core.cjs');
const { esc, CSS_VARS, wrapPage, card, badge, progressRing, statusDot, COMPONENT_CSS } = require('./design-system.cjs');
const { serveAndAwaitDecision } = require('./dev-server.cjs');
const {
  buildPhaseDetails, getRequirementCoverage,
  collectProjectIssues, sortPhaseDetails,
} = require('./project-commands.cjs');
/**
 * Gradient accent colors for milestone panels (cycling).
 * Shared by generateDashboardHTML and generateInteractiveDashboardHTML.
 */
const MILESTONE_GRADIENTS = [
  ['#667eea', '#764ba2'],
  ['#f093fb', '#f5576c'],
  ['#4facfe', '#00f2fe'],
  ['#43e97b', '#38f9d7'],
  ['#fa709a', '#fee140'],
  ['#a18cd1', '#fbc2eb'],
  ['#fccb90', '#d57eeb'],
  ['#e0c3fc', '#8ec5fc'],
];

/**
 * Base CSS shared by both the static dashboard (generateDashboardHTML) and the
 * interactive dashboard (generateInteractiveDashboardHTML).
 * The interactive variant appends its extra button/header styles on top.
 */
const DASHBOARD_BASE_CSS = `
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

  /* --- Stat card overrides on top of .ds-card --- */
  .overview-grid {
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    gap: 1rem;
    margin-bottom: 2.5rem;
  }
  .stat-card.ds-card::before {
    content: '';
    position: absolute;
    top: 0; left: 0; right: 0;
    height: 2px;
    background: var(--card-accent, var(--accent));
    opacity: 0;
    transition: opacity 0.2s ease;
  }
  .stat-card.ds-card:hover { transform: translateY(-2px); }
  .stat-card.ds-card:hover::before { opacity: 1; }
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

  /* --- Chart card overrides on top of .ds-card --- */
  .charts-row {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 1.5rem;
    margin-bottom: 2.5rem;
  }
  .chart-card.ds-card > .ds-card-content {
    display: flex;
    align-items: center;
    gap: 1.5rem;
  }
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

  /* --- Milestone tab gradient override --- */
  .ds-tab-active { border-bottom-color: var(--tab-c1, var(--accent)); }
  .tab-check {
    color: var(--green);
    margin-right: 0.35rem;
    font-weight: 700;
  }

  /* --- Milestone header overrides on top of .ds-card --- */
  .ms-header.ds-card {
    padding: 1.5rem 2rem;
    margin-top: 1.5rem;
    margin-bottom: 1.25rem;
  }
  .ms-header.ds-card > .ds-card-content {
    display: flex;
    justify-content: space-between;
    align-items: center;
  }
  .ms-header.ds-card::after {
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

  /* --- Mini-stat overrides on top of .ds-card --- */
  .ms-stats-row {
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    gap: 0.75rem;
    margin-bottom: 1.5rem;
  }
  .ms-mini-stat.ds-card {
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

  /* --- Phase card overrides on top of .ds-card --- */
  .phase-card.ds-card {
    border-radius: 10px;
    padding: 1.25rem 1.5rem;
    margin-bottom: 0.75rem;
  }
  .phase-card.ds-card:hover { transform: translateX(2px); }
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

  /* --- Quick tasks --- */
  .quick-tasks-section { margin-top: 2.5rem; }
  .quick-tasks-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(320px, 1fr));
    gap: 0.75rem;
  }
  .quick-pr-link {
    display: inline-block;
    margin-top: 0.5rem;
    font-size: 0.75rem;
    color: var(--accent);
    text-decoration: none;
    font-weight: 500;
    transition: color 0.15s ease;
  }
  .quick-pr-link:hover { color: var(--blue); text-decoration: underline; }

  /* --- Agent roster overrides on top of .ds-card --- */
  .agent-section { margin-top: 3rem; }
  .agent-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
    gap: 1rem;
  }
  .agent-card.ds-card {
    border-radius: 10px;
    padding: 1.25rem;
  }
  .agent-card.ds-card::before {
    content: '';
    position: absolute;
    top: 0; left: 0; right: 0;
    height: 2px;
    background: var(--agent-color);
    opacity: 0.6;
  }
  .agent-card.ds-card:hover {
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
    .quick-tasks-grid { grid-template-columns: 1fr; }
  }`;

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
      } catch { /* INTENTIONALLY SILENT: unreadable agent files are skipped during roster collection */ }
    }
  } catch { /* INTENTIONALLY SILENT: unreadable agents directory is non-fatal */ }

  return agents;
}

// TODO: generateDashboardHTML is ~810 lines. Break into smaller helpers (CSS builder,
// section renderers, page assembler) in a future phase to improve maintainability.
function generateDashboardHTML(data) {
  const {
    projectTitle, projectId, timestamp, progressPercent,
    totalPhases, completedPhases, phaseDetails, reqCoverage,
    milestones = [], agents = [], quickTasks = [],
  } = data;

  const phasesOpen = phaseDetails.filter(p => p.status === 'open').length;
  const phasesInProgress = phaseDetails.filter(p => p.status === 'in_progress').length;
  const reqsCovered = reqCoverage.filter(r => r.covered).length;
  const reqsTotal = reqCoverage.length;

  // Use module-level MILESTONE_GRADIENTS constant
  const gradients = MILESTONE_GRADIENTS;

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
    return `<button class="ds-tab${isActive ? ' ds-tab-active' : ''}" data-tab="${i}" style="--tab-c1:${grad[0]};--tab-c2:${grad[1]}">${checkmark}${esc(ms.title)}</button>`;
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
      const badgeVariant = phase.status === 'closed' ? 'done' : phase.status === 'in_progress' ? 'active' : 'pending';
      return card({
        className: `phase-card ${statusClass}`,
        content: `<div class="phase-header">
              <h3>${esc(phase.title)}</h3>
              ${badge(statusBadge, badgeVariant)}
            </div>
            ${phaseDescHTML}
            ${completionHTML}
            <div class="progress-bar-container">
              <div class="progress-bar" style="width:${pct}%;background:linear-gradient(90deg,${grad[0]},${grad[1]})"></div>
            </div>
            <div class="phase-stats">${phase.tasks_closed}/${phase.tasks_total} tasks &middot; ${pct}%</div>
            ${phase.tasks.length > 0 ? `<ul class="task-list">${tasksHTML}</ul>` : '<p class="no-tasks">No tasks</p>'}`,
      });
    }).join('\n');

    // Requirements for this milestone
    const msReqGridHTML = msReqs.map(r => {
      const cls = r.covered ? 'req-covered' : 'req-uncovered';
      return `<div class="req-cell ${cls}" title="${esc(r.title)} (${r.id})${r.covered ? ' — ' + r.covering_tasks + ' tasks' : ' — UNCOVERED'}">${esc(r.title.length > 30 ? r.title.slice(0, 28) + '\u2026' : r.title)}</div>`;
    }).join('\n');

    const msHeaderCard = card({
      className: 'ms-header',
      style: `--ms-c1:${grad[0]};--ms-c2:${grad[1]}`,
      content: `<div class="ms-header-content">
            <h2>${esc(ms.title)}</h2>
            ${ms.goal ? `<p class="ms-goal">${esc(ms.goal)}</p>` : ''}
          </div>
          ${progressRing({ percent: ms.progress, size: 80, strokeWidth: 5, color: grad[0] })}`,
    });

    const miniStats = [
      { val: ms.phase_count, lbl: 'Phases' },
      { val: ms.completed_count, lbl: 'Done' },
      { val: msReqs.length, lbl: 'Reqs' },
      { val: msCoveredReqs, lbl: 'Covered' },
    ].map(s => card({
      className: 'ms-mini-stat',
      content: `<span class="ms-mini-val">${s.val}</span><span class="ms-mini-lbl">${s.lbl}</span>`,
    })).join('\n');

    return `
      <div class="ds-tab-panel${isActive ? ' ds-tab-panel-active' : ''}" data-panel="${i}">
        ${msHeaderCard}
        <div class="ms-stats-row">
          ${miniStats}
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
    return card({
      className: 'agent-card',
      style: `--agent-color:${resolvedColor}`,
      content: `<div class="agent-vibe">${esc(a.vibe)}</div>
          <div class="agent-name">${esc(a.name)}</div>
          <div class="agent-desc">${esc(a.description)}</div>
          <span class="ds-badge" style="background:${resolvedColor}20;color:${resolvedColor};border:1px solid ${resolvedColor}40">${esc(a.color || 'default')}</span>`,
    });
  }).join('\n');

  // Quick task cards
  const quickTaskCardsHTML = quickTasks.map(qt => {
    const statusClass = qt.status === 'closed' ? 'phase-done' : qt.status === 'in_progress' ? 'phase-active' : 'phase-pending';
    const statusBadge = qt.status === 'closed' ? 'Done' : qt.status === 'in_progress' ? 'Active' : 'Open';
    const badgeVariant = qt.status === 'closed' ? 'done' : qt.status === 'in_progress' ? 'active' : 'pending';
    const childrenHTML = qt.children.length > 0 ? `<ul class="task-list">${qt.children.map(c => `<li class="${c.status === 'closed' ? 'task-done' : 'task-pending'}"><span class="task-icon">${c.status === 'closed' ? '&#x2713;' : '&#x25CB;'}</span> ${esc(c.title)}</li>`).join('\n')}</ul>` : '';
    const prLinkHTML = qt.prUrl && /^https?:\/\//i.test(qt.prUrl) ? `<a href="${esc(qt.prUrl)}" class="quick-pr-link" target="_blank" rel="noopener">View PR</a>` : '';
    return card({
      className: `phase-card ${statusClass}`,
      content: `<div class="phase-header">
              <h3>${esc(qt.title)}</h3>
              ${badge(statusBadge, badgeVariant)}
            </div>
            ${qt.description ? `<p class="phase-desc">${esc(qt.description)}</p>` : ''}
            ${childrenHTML}
            ${prLinkHTML}`,
    });
  }).join('\n');

  // Overall SVG progress rings data
  const phaseRingPct = progressPercent;
  const reqRingPct = reqsTotal > 0 ? Math.round((reqsCovered / reqsTotal) * 100) : 0;
  const reqRingColor = reqRingPct >= 80 ? '#22c55e' : reqRingPct >= 50 ? '#f59e0b' : '#ef4444';

  // Compose CSS: design-system component CSS + dashboard page-specific overrides
  const dashExtraCSS = COMPONENT_CSS + DASHBOARD_BASE_CSS;

  // Build stat cards using card()
  const statCardsHTML = [
    { cls: 'accent', style: '--card-accent:var(--accent)', value: totalPhases, label: 'Total Phases' },
    { cls: 'green', style: '', value: completedPhases, label: 'Completed' },
    { cls: 'orange', style: '', value: phasesInProgress, label: 'In Progress' },
    { cls: 'blue', style: '', value: reqsTotal, label: 'Requirements' },
  ].map(s => card({
    className: `stat-card ${s.cls}`,
    style: s.style || undefined,
    content: `<div class="stat-value">${s.value}</div><div class="stat-label">${s.label}</div>`,
  })).join('\n    ');

  // Build chart cards using card() + progressRing()
  const phaseChartCard = card({
    className: 'chart-card',
    content: `${progressRing({ percent: phaseRingPct, size: 120, strokeWidth: 6, color: '#22c55e' })}
      <div>
        <h3>Phase Completion</h3>
        <div class="chart-value">${completedPhases} / ${totalPhases}</div>
        <div class="chart-sub">${phasesInProgress} in progress, ${phasesOpen} open</div>
      </div>`,
  });
  const reqChartCard = card({
    className: 'chart-card',
    content: `${progressRing({ percent: reqRingPct, size: 120, strokeWidth: 6, color: reqRingColor })}
      <div>
        <h3>Requirement Coverage</h3>
        <div class="chart-value">${reqsCovered} / ${reqsTotal}</div>
        <div class="chart-sub">${reqsTotal - reqsCovered} uncovered</div>
      </div>`,
  });

  const dashBodyHTML = `
<header class="dash-header">
  <h1>${esc(projectTitle)}</h1>
  <p class="subtitle">Generated ${timestamp} &middot; <code>${projectId}</code></p>
</header>

<div class="dash-body">

  <!-- Overview stat cards -->
  <div class="overview-grid">
    ${statCardsHTML}
  </div>

  <!-- SVG Progress Rings -->
  <div class="charts-row">
    ${phaseChartCard}
    ${reqChartCard}
  </div>

  <!-- Milestone tabs -->
  ${milestones.length > 0 ? `
  <div class="ds-tabs-container">
    <div class="ds-tabs-nav">
      ${milestoneTabsHTML}
    </div>
    ${milestonePanelsHTML}
  </div>` : `
  <div class="section-title">All Phases</div>
  ${phaseDetails.map((phase) => {
    const pct = phase.tasks_total > 0 ? Math.round((phase.tasks_closed / phase.tasks_total) * 100) : 0;
    const statusClass = phase.status === 'closed' ? 'phase-done' : phase.status === 'in_progress' ? 'phase-active' : 'phase-pending';
    const statusLabel = phase.status === 'closed' ? 'Done' : phase.status === 'in_progress' ? 'Active' : 'Pending';
    const badgeVariant = phase.status === 'closed' ? 'done' : phase.status === 'in_progress' ? 'active' : 'pending';
    return card({
      className: `phase-card ${statusClass}`,
      content: `<div class="phase-header"><h3>${esc(phase.title)}</h3>${badge(statusLabel, badgeVariant)}</div>
      <div class="progress-bar-container"><div class="progress-bar" style="width:${pct}%;background:var(--accent)"></div></div>
      <div class="phase-stats">${phase.tasks_closed}/${phase.tasks_total} tasks</div>`,
    });
  }).join('\n')}
  `}

  <!-- Quick Tasks -->
  ${quickTasks.length > 0 ? `
  <div class="quick-tasks-section">
    <h3 class="section-title">Quick Tasks</h3>
    <div class="quick-tasks-grid">
      ${quickTaskCardsHTML}
    </div>
  </div>` : ''}

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
  document.querySelectorAll('.ds-tab').forEach(function(tab) {
    tab.addEventListener('click', function() {
      var idx = this.getAttribute('data-tab');
      document.querySelectorAll('.ds-tab').forEach(function(t) { t.classList.remove('ds-tab-active'); });
      document.querySelectorAll('.ds-tab-panel').forEach(function(p) { p.classList.remove('ds-tab-panel-active'); });
      this.classList.add('ds-tab-active');
      var panel = document.querySelector('.ds-tab-panel[data-panel="' + idx + '"]');
      if (panel) panel.classList.add('ds-tab-panel-active');
    });
  });
<\/script>`;

  return wrapPage(`${projectTitle} - Dashboard`, dashBodyHTML, dashExtraCSS);
}

/**
 * Collect fresh dashboard data for a project. Extracted from generate-dashboard
 * so it can be reused by the /api/data route handler for live refresh.
 *
 * @param {string} projectId - The project bead ID
 * @returns {object} Dashboard data object matching generateDashboardHTML schema
 */
function collectDashboardData(projectId) {
  const project = bdJsonArgs(['show', projectId]);
  const { phases, requirements, milestoneDetails, quickTasks } = collectProjectIssues(projectId);

  const phaseDetails = sortPhaseDetails(buildPhaseDetails(phases, { includeMeta: true }));
  const reqCoverage = getRequirementCoverage(requirements);

  const totalPhases = phases.length;
  const completedPhases = phases.filter(p => p.status === 'closed').length;
  const progressPercent = totalPhases > 0 ? Math.round((completedPhases / totalPhases) * 100) : 0;

  const phaseDetailMap = new Map(phaseDetails.map(pd => [pd.id, pd]));
  const reqCoverageMap = new Map(reqCoverage.map(rc => [rc.id, rc]));

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

  const agents = collectAgentRoster();
  const projectTitle = project?.title || projectId;
  const timestamp = new Date().toISOString().replace('T', ' ').replace(/\.\d+Z/, ' UTC');

  return {
    projectTitle, projectId, timestamp, progressPercent,
    totalPhases, completedPhases,
    phaseDetails, reqCoverage,
    milestones: milestonesGrouped,
    agents,
    quickTasks,
  };
}

/**
 * Generate an interactive dashboard HTML page served via dev-server.
 * Embeds initial data as JSON plus a client-side renderDashboard(data) function
 * that rebuilds the content area on Refresh. Includes Refresh and Close buttons.
 *
 * The token is extracted from window.location.search at runtime (set by dev-server
 * in the URL as ?token=<TOKEN>), so no server-side token embedding is needed.
 *
 * The dashboard is read-only (no mutation actions).
 * All dynamic values are escaped via the esc() helper to prevent XSS.
 *
 * @param {object} data - Dashboard data from collectDashboardData()
 * @returns {string} Full HTML page string
 */
function generateInteractiveDashboardHTML(data) {
  const { projectTitle, projectId } = data;

  // Use module-level MILESTONE_GRADIENTS constant (shared with static dashboard)
  const gradients = MILESTONE_GRADIENTS;

  // Compose CSS: design-system components + dashboard page-specific + interactive-only overrides
  const dashExtraCSS = COMPONENT_CSS + DASHBOARD_BASE_CSS + `
  /* --- Interactive-only: flex header layout for action buttons --- */
  .dash-header {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
  }
  .dash-header-actions {
    display: flex;
    gap: 0.5rem;
    align-items: center;
    flex-shrink: 0;
  }
  .dash-btn {
    background: var(--surface);
    border: 1px solid var(--border);
    color: var(--text-secondary);
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    font-size: 0.8rem;
    font-weight: 500;
    padding: 0.5rem 1rem;
    border-radius: 8px;
    cursor: pointer;
    transition: background 0.2s ease, border-color 0.2s ease, color 0.2s ease;
  }
  .dash-btn:hover {
    background: var(--surface-hover);
    border-color: rgba(255,255,255,0.1);
    color: var(--text);
  }
  .dash-btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
  .dash-btn-primary {
    background: var(--accent);
    border-color: var(--accent);
    color: #fff;
  }
  .dash-btn-primary:hover {
    background: #818cf8;
    border-color: #818cf8;
  }
  .refresh-status {
    font-size: 0.7rem;
    color: var(--text-muted);
    min-width: 80px;
    text-align: right;
  }
  @media (max-width: 640px) {
    .dash-header { flex-direction: column; gap: 1rem; }
  }`;

  // Build client-side rendering script. All dynamic values are escaped via esc()
  // in the renderDashboard function to prevent XSS when rebuilding the DOM.
  // The use of container.innerHTML is safe here because every interpolated value
  // passes through the client-side esc() function first, matching the pattern
  // used by the server-side generateDashboardHTML and design-system.cjs.
  const clientScript = `
<script>
(function() {
  var TOKEN = new URLSearchParams(window.location.search).get('token') || '';
  var GRADIENTS = ${JSON.stringify(gradients)};
  var COLOR_MAP = ${JSON.stringify(COLOR_MAP)};
  var HEX_COLOR_RE = /^#[0-9a-fA-F]{3,6}$/;
  var SAFE_FALLBACK_COLOR = '#8b949e';
  var REFRESH_INTERVAL_MS = 30000;
  var lastRefreshTime = Date.now();

  function esc(s) {
    var d = document.createElement('div');
    d.appendChild(document.createTextNode(String(s || '')));
    return d.innerHTML;
  }

  var BADGE_VARIANTS = {
    done:    { bg: 'rgba(34,197,94,0.12)',  color: 'var(--green)' },
    active:  { bg: 'rgba(245,158,11,0.12)', color: 'var(--orange)' },
    pending: { bg: 'rgba(113,113,122,0.12)', color: 'var(--text-muted)' }
  };
  function buildBadge(text, variant) {
    var v = BADGE_VARIANTS[variant] || BADGE_VARIANTS.pending;
    return '<span class="ds-badge" style="background:' + v.bg + ';color:' + v.color + '">' + esc(text) + '</span>';
  }

  function buildRingSVG(sz, radius, sw, color, pct) {
    var c = Math.round(2 * Math.PI * radius);
    var off = Math.round(c * (1 - pct / 100));
    return '<div class="ds-ring-container" style="width:' + sz + 'px;height:' + sz + 'px;position:relative">' +
      '<svg viewBox="0 0 ' + sz + ' ' + sz + '" style="width:' + sz + 'px;height:' + sz + 'px;transform:rotate(-90deg)">' +
      '<circle cx="' + (sz/2) + '" cy="' + (sz/2) + '" r="' + radius + '" fill="none" stroke="var(--surface-2)" stroke-width="' + sw + '" />' +
      '<circle cx="' + (sz/2) + '" cy="' + (sz/2) + '" r="' + radius + '" fill="none" stroke="' + color + '" stroke-width="' + sw + '" stroke-linecap="round" stroke-dasharray="' + c + '" stroke-dashoffset="' + off + '" />' +
      '</svg>' +
      '<span style="position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);font-size:' + Math.round(sz * 0.12) + 'px;font-weight:600;color:var(--text-secondary)">' + pct + '%</span>' +
      '</div>';
  }

  function renderDashboard(data) {
    var milestones = data.milestones || [];
    var phaseDetails = data.phaseDetails || [];
    var reqCoverage = data.reqCoverage || [];
    var agents = data.agents || [];
    var quickTasks = data.quickTasks || [];

    var phasesOpen = phaseDetails.filter(function(p) { return p.status === 'open'; }).length;
    var phasesInProgress = phaseDetails.filter(function(p) { return p.status === 'in_progress'; }).length;
    var reqsCovered = reqCoverage.filter(function(r) { return r.covered; }).length;
    var reqsTotal = reqCoverage.length;
    var circumference = Math.round(2 * Math.PI * 54);
    var phaseRingPct = data.progressPercent;
    var reqRingPct = reqsTotal > 0 ? Math.round((reqsCovered / reqsTotal) * 100) : 0;

    // Determine active milestone
    var activeMsIdx = -1;
    for (var i = 0; i < milestones.length; i++) {
      if (milestones[i].status === 'in_progress') { activeMsIdx = i; break; }
    }
    if (activeMsIdx === -1) {
      for (var j = 0; j < milestones.length; j++) {
        if (milestones[j].status === 'open') { activeMsIdx = j; break; }
      }
    }
    if (activeMsIdx === -1) activeMsIdx = 0;

    // Update subtitle
    var subtitleEl = document.querySelector('.dash-header .subtitle');
    if (subtitleEl) subtitleEl.textContent = 'Generated ' + data.timestamp + ' \\u00b7 ' + data.projectId;

    var container = document.getElementById('dash-content');
    if (!container) return;

    var parts = [];

    // Overview stat cards (ds-card)
    parts.push('<div class="overview-grid">');
    parts.push('<div class="ds-card stat-card accent" style="--card-accent:var(--accent)"><div class="ds-card-content"><div class="stat-value">' + data.totalPhases + '</div><div class="stat-label">Total Phases</div></div></div>');
    parts.push('<div class="ds-card stat-card green"><div class="ds-card-content"><div class="stat-value">' + data.completedPhases + '</div><div class="stat-label">Completed</div></div></div>');
    parts.push('<div class="ds-card stat-card orange"><div class="ds-card-content"><div class="stat-value">' + phasesInProgress + '</div><div class="stat-label">In Progress</div></div></div>');
    parts.push('<div class="ds-card stat-card blue"><div class="ds-card-content"><div class="stat-value">' + reqsTotal + '</div><div class="stat-label">Requirements</div></div></div>');
    parts.push('</div>');

    // SVG Progress Rings (ds-card chart cards with ds-ring)
    parts.push('<div class="charts-row">');
    parts.push('<div class="ds-card chart-card"><div class="ds-card-content">');
    parts.push(buildRingSVG(120, 54, 6, '#22c55e', phaseRingPct));
    parts.push('<div><h3>Phase Completion</h3><div class="chart-value">' + data.completedPhases + ' / ' + data.totalPhases + '</div>');
    parts.push('<div class="chart-sub">' + phasesInProgress + ' in progress, ' + phasesOpen + ' open</div></div>');
    parts.push('</div></div>');

    var reqColor = reqRingPct >= 80 ? '#22c55e' : reqRingPct >= 50 ? '#f59e0b' : '#ef4444';
    parts.push('<div class="ds-card chart-card"><div class="ds-card-content">');
    parts.push(buildRingSVG(120, 54, 6, reqColor, reqRingPct));
    parts.push('<div><h3>Requirement Coverage</h3><div class="chart-value">' + reqsCovered + ' / ' + reqsTotal + '</div>');
    parts.push('<div class="chart-sub">' + (reqsTotal - reqsCovered) + ' uncovered</div></div>');
    parts.push('</div></div>');
    parts.push('</div>');

    // Milestone tabs
    if (milestones.length > 0) {
      parts.push('<div class="ds-tabs-container">');
      parts.push('<div class="ds-tabs-nav">');
      for (var mi = 0; mi < milestones.length; mi++) {
        var ms = milestones[mi];
        var grad = GRADIENTS[mi % GRADIENTS.length];
        var isActive = mi === activeMsIdx;
        var isDone = ms.status === 'closed';
        var checkmark = isDone ? '<span class="tab-check">&#x2713;</span>' : '';
        parts.push('<button class="ds-tab' + (isActive ? ' ds-tab-active' : '') + '" data-tab="' + mi + '" style="--tab-c1:' + grad[0] + ';--tab-c2:' + grad[1] + '">' + checkmark + esc(ms.title) + '</button>');
      }
      parts.push('</div>');

      for (var pi = 0; pi < milestones.length; pi++) {
        var msP = milestones[pi];
        var gradP = GRADIENTS[pi % GRADIENTS.length];
        var isActiveP = pi === activeMsIdx;
        var msPhases = msP.phases || [];
        var msReqs = msP.requirements || [];
        var msCoveredReqs = msReqs.filter(function(r) { return r.covered; }).length;

        parts.push('<div class="ds-tab-panel' + (isActiveP ? ' ds-tab-panel-active' : '') + '" data-panel="' + pi + '">');
        parts.push('<div class="ds-card ms-header" style="--ms-c1:' + gradP[0] + ';--ms-c2:' + gradP[1] + '"><div class="ds-card-content"><div class="ms-header-content"><h2>' + esc(msP.title) + '</h2>');
        if (msP.goal) parts.push('<p class="ms-goal">' + esc(msP.goal) + '</p>');
        parts.push('</div>');
        parts.push(buildRingSVG(80, 34, 5, gradP[0], msP.progress));
        parts.push('</div></div>');

        parts.push('<div class="ms-stats-row">');
        parts.push('<div class="ds-card ms-mini-stat"><div class="ds-card-content"><span class="ms-mini-val">' + msP.phase_count + '</span><span class="ms-mini-lbl">Phases</span></div></div>');
        parts.push('<div class="ds-card ms-mini-stat"><div class="ds-card-content"><span class="ms-mini-val">' + msP.completed_count + '</span><span class="ms-mini-lbl">Done</span></div></div>');
        parts.push('<div class="ds-card ms-mini-stat"><div class="ds-card-content"><span class="ms-mini-val">' + msReqs.length + '</span><span class="ms-mini-lbl">Reqs</span></div></div>');
        parts.push('<div class="ds-card ms-mini-stat"><div class="ds-card-content"><span class="ms-mini-val">' + msCoveredReqs + '</span><span class="ms-mini-lbl">Covered</span></div></div>');
        parts.push('</div>');

        parts.push('<div class="ms-body"><h3 class="section-title">Phases</h3>');
        if (msPhases.length === 0) {
          parts.push('<p class="empty-msg">No phases in this milestone</p>');
        } else {
          for (var phi = 0; phi < msPhases.length; phi++) {
            var phase = msPhases[phi];
            var pct = phase.tasks_total > 0 ? Math.round((phase.tasks_closed / phase.tasks_total) * 100) : 0;
            var statusClass = phase.status === 'closed' ? 'phase-done' : phase.status === 'in_progress' ? 'phase-active' : 'phase-pending';
            var statusBadge = phase.status === 'closed' ? 'Done' : phase.status === 'in_progress' ? 'Active' : 'Pending';
            var badgeVariant = phase.status === 'closed' ? 'done' : phase.status === 'in_progress' ? 'active' : 'pending';
            parts.push('<div class="ds-card phase-card ' + statusClass + '"><div class="ds-card-content">');
            parts.push('<div class="phase-header"><h3>' + esc(phase.title) + '</h3>' + buildBadge(statusBadge, badgeVariant) + '</div>');
            if (phase.description) parts.push('<p class="phase-desc">' + esc(phase.description) + '</p>');
            if (phase.status === 'closed' && phase.completed_at) {
              var compDate = new Date(phase.completed_at);
              parts.push('<div class="phase-completed">Completed ' + compDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) + '</div>');
            } else if (phase.status === 'closed') {
              parts.push('<div class="phase-completed">Completed</div>');
            }
            parts.push('<div class="progress-bar-container"><div class="progress-bar" style="width:' + pct + '%;background:linear-gradient(90deg,' + gradP[0] + ',' + gradP[1] + ')"></div></div>');
            parts.push('<div class="phase-stats">' + phase.tasks_closed + '/' + phase.tasks_total + ' tasks \\u00b7 ' + pct + '%</div>');
            if (phase.tasks && phase.tasks.length > 0) {
              parts.push('<ul class="task-list">');
              for (var ti = 0; ti < phase.tasks.length; ti++) {
                var t = phase.tasks[ti];
                var tIcon = t.status === 'closed' ? '&#x2713;' : t.status === 'in_progress' ? '&#x25B6;' : '&#x25CB;';
                var tCls = t.status === 'closed' ? 'task-done' : t.status === 'in_progress' ? 'task-active' : 'task-pending';
                var hasDetails = t.description || t.acceptance_criteria;
                parts.push('<li class="' + tCls + '"><details' + (hasDetails ? '' : ' class="no-detail"') + '>');
                parts.push('<summary><span class="task-icon">' + tIcon + '</span> ' + esc(t.title) + ' <code>' + esc(t.id) + '</code></summary>');
                if (hasDetails) {
                  parts.push('<div class="task-details">');
                  if (t.description) parts.push('<div class="task-desc"><strong>Description:</strong> ' + esc(t.description) + '</div>');
                  if (t.acceptance_criteria) parts.push('<div class="task-ac"><strong>Acceptance Criteria:</strong><pre>' + esc(t.acceptance_criteria) + '</pre></div>');
                  parts.push('</div>');
                }
                parts.push('</details></li>');
              }
              parts.push('</ul>');
            } else {
              parts.push('<p class="no-tasks">No tasks</p>');
            }
            parts.push('</div></div>');
          }
        }

        if (msReqs.length > 0) {
          parts.push('<h3 class="section-title">Requirements (' + msCoveredReqs + '/' + msReqs.length + ')</h3>');
          parts.push('<div class="req-grid">');
          for (var ri = 0; ri < msReqs.length; ri++) {
            var r = msReqs[ri];
            var rCls = r.covered ? 'req-covered' : 'req-uncovered';
            var rTitle = r.title.length > 30 ? r.title.slice(0, 28) + '\\u2026' : r.title;
            var rTooltip = r.title + ' (' + r.id + ')' + (r.covered ? ' \\u2014 ' + r.covering_tasks + ' tasks' : ' \\u2014 UNCOVERED');
            parts.push('<div class="req-cell ' + rCls + '" title="' + esc(rTooltip) + '">' + esc(rTitle) + '</div>');
          }
          parts.push('</div>');
        }
        parts.push('</div></div>');
      }
      parts.push('</div>');
    } else {
      // No milestones -- show flat phase list
      parts.push('<div class="section-title">All Phases</div>');
      for (var fi = 0; fi < phaseDetails.length; fi++) {
        var fp = phaseDetails[fi];
        var fpPct = fp.tasks_total > 0 ? Math.round((fp.tasks_closed / fp.tasks_total) * 100) : 0;
        var fpStatusClass = fp.status === 'closed' ? 'phase-done' : fp.status === 'in_progress' ? 'phase-active' : 'phase-pending';
        var fpStatusBadge = fp.status === 'closed' ? 'Done' : fp.status === 'in_progress' ? 'Active' : 'Pending';
        var fpBadgeVariant = fp.status === 'closed' ? 'done' : fp.status === 'in_progress' ? 'active' : 'pending';
        parts.push('<div class="ds-card phase-card ' + fpStatusClass + '"><div class="ds-card-content"><div class="phase-header"><h3>' + esc(fp.title) + '</h3>' + buildBadge(fpStatusBadge, fpBadgeVariant) + '</div>');
        parts.push('<div class="progress-bar-container"><div class="progress-bar" style="width:' + fpPct + '%;background:var(--accent)"></div></div>');
        parts.push('<div class="phase-stats">' + fp.tasks_closed + '/' + fp.tasks_total + ' tasks</div></div></div>');
      }
    }

    // Quick tasks
    if (quickTasks.length > 0) {
      parts.push('<div class="quick-tasks-section"><h3 class="section-title">Quick Tasks</h3><div class="quick-tasks-grid">');
      for (var qi = 0; qi < quickTasks.length; qi++) {
        var qt = quickTasks[qi];
        var qtStatusClass = qt.status === 'closed' ? 'phase-done' : qt.status === 'in_progress' ? 'phase-active' : 'phase-pending';
        var qtStatusBadge = qt.status === 'closed' ? 'Done' : qt.status === 'in_progress' ? 'Active' : 'Open';
        var qtBadgeVariant = qt.status === 'closed' ? 'done' : qt.status === 'in_progress' ? 'active' : 'pending';
        parts.push('<div class="ds-card phase-card ' + qtStatusClass + '"><div class="ds-card-content"><div class="phase-header"><h3>' + esc(qt.title) + '</h3>' + buildBadge(qtStatusBadge, qtBadgeVariant) + '</div>');
        if (qt.description) parts.push('<p class="phase-desc">' + esc(qt.description) + '</p>');
        if (qt.children && qt.children.length > 0) {
          parts.push('<ul class="task-list">');
          for (var ci = 0; ci < qt.children.length; ci++) {
            var ch = qt.children[ci];
            parts.push('<li class="' + (ch.status === 'closed' ? 'task-done' : 'task-pending') + '"><span class="task-icon">' + (ch.status === 'closed' ? '&#x2713;' : '&#x25CB;') + '</span> ' + esc(ch.title) + '</li>');
          }
          parts.push('</ul>');
        }
        if (qt.prUrl && /^https?:\/\//i.test(qt.prUrl)) parts.push('<a href="' + esc(qt.prUrl) + '" class="quick-pr-link" target="_blank" rel="noopener">View PR</a>');
        parts.push('</div></div>');
      }
      parts.push('</div></div>');
    }

    // Agents
    if (agents.length > 0) {
      parts.push('<div class="agent-section"><h3 class="section-title">Agent Roster</h3><div class="agent-grid">');
      for (var ai = 0; ai < agents.length; ai++) {
        var a = agents[ai];
        var colorVal = a.color || SAFE_FALLBACK_COLOR;
        var mapped = COLOR_MAP[colorVal.toLowerCase()];
        var resolvedColor = mapped || (HEX_COLOR_RE.test(colorVal) ? colorVal : SAFE_FALLBACK_COLOR);
        parts.push('<div class="ds-card agent-card" style="--agent-color:' + resolvedColor + '"><div class="ds-card-content">');
        parts.push('<div class="agent-vibe">' + esc(a.vibe) + '</div>');
        parts.push('<div class="agent-name">' + esc(a.name) + '</div>');
        parts.push('<div class="agent-desc">' + esc(a.description) + '</div>');
        parts.push('<span class="ds-badge" style="background:' + resolvedColor + '20;color:' + resolvedColor + ';border:1px solid ' + resolvedColor + '40">' + esc(a.color || 'default') + '</span>');
        parts.push('</div></div>');
      }
      parts.push('</div></div>');
    }

    // Safe DOM update: all interpolated values above are escaped via esc()
    container.innerHTML = parts.join('');

    // Re-attach milestone tab event listeners
    container.querySelectorAll('.ds-tab').forEach(function(tab) {
      tab.addEventListener('click', function() {
        var idx = this.getAttribute('data-tab');
        container.querySelectorAll('.ds-tab').forEach(function(t) { t.classList.remove('ds-tab-active'); });
        container.querySelectorAll('.ds-tab-panel').forEach(function(p) { p.classList.remove('ds-tab-panel-active'); });
        this.classList.add('ds-tab-active');
        var panel = container.querySelector('.ds-tab-panel[data-panel="' + idx + '"]');
        if (panel) panel.classList.add('ds-tab-panel-active');
      });
    });
  }

  // Initial render
  var initialData = ${JSON.stringify(data).replace(/<\/script>/gi, '<\\/script>')};
  renderDashboard(initialData);

  // Refresh button with 30s throttle
  var refreshBtn = document.getElementById('dash-refresh-btn');
  var refreshStatus = document.getElementById('dash-refresh-status');

  if (refreshBtn) {
    refreshBtn.addEventListener('click', function() {
      var now = Date.now();
      var elapsed = now - lastRefreshTime;
      if (elapsed < REFRESH_INTERVAL_MS) {
        var remaining = Math.ceil((REFRESH_INTERVAL_MS - elapsed) / 1000);
        if (refreshStatus) refreshStatus.textContent = 'Wait ' + remaining + 's';
        return;
      }
      refreshBtn.disabled = true;
      if (refreshStatus) refreshStatus.textContent = 'Refreshing...';
      fetch('/api/data?token=' + encodeURIComponent(TOKEN))
        .then(function(res) {
          if (!res.ok) throw new Error('HTTP ' + res.status);
          return res.json();
        })
        .then(function(freshData) {
          lastRefreshTime = Date.now();
          renderDashboard(freshData);
          if (refreshStatus) refreshStatus.textContent = 'Updated';
          setTimeout(function() { if (refreshStatus) refreshStatus.textContent = ''; }, 3000);
        })
        .catch(function(err) {
          if (refreshStatus) refreshStatus.textContent = 'Error';
          console.error('Refresh failed:', err);
        })
        .finally(function() {
          refreshBtn.disabled = false;
        });
    });
  }

  // Close button
  var closeBtn = document.getElementById('dash-close-btn');
  if (closeBtn) {
    closeBtn.addEventListener('click', function() {
      closeBtn.disabled = true;
      if (refreshBtn) refreshBtn.disabled = true;
      fetch('/decide?token=' + encodeURIComponent(TOKEN), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'close' })
      })
      .then(function() {
        document.body.textContent = '';
        var msg = document.createElement('div');
        msg.style.cssText = 'display:flex;align-items:center;justify-content:center;height:100vh;color:#71717a;font-size:1.1rem;';
        msg.textContent = 'Dashboard closed. You can close this tab.';
        document.body.appendChild(msg);
      })
      .catch(function(err) {
        console.error('Close failed:', err);
        closeBtn.disabled = false;
        if (refreshBtn) refreshBtn.disabled = false;
      });
    });
  }
})();
<\/script>`;

  const bodyHTML = `
<header class="dash-header">
  <div>
    <h1>${esc(projectTitle)}</h1>
    <p class="subtitle">Generated ${esc(data.timestamp)} &middot; <code>${esc(projectId)}</code></p>
  </div>
  <div class="dash-header-actions">
    <span id="dash-refresh-status" class="refresh-status"></span>
    <button id="dash-refresh-btn" class="dash-btn">Refresh</button>
    <button id="dash-close-btn" class="dash-btn dash-btn-primary">Close</button>
  </div>
</header>

<div class="dash-body" id="dash-content">
  <!-- Content rendered by client-side JS -->
</div>

${clientScript}`;

  return wrapPage(`${projectTitle} - Dashboard`, bodyHTML, dashExtraCSS);
}


module.exports = {
  /**
   * Generate a project dashboard.
   *
   * When web_ui=true:  starts an interactive dev-server with live Refresh,
   *                    returns a promise (async command handled by index.cjs).
   * When web_ui=false: writes a static HTML file to .forge/ (original behavior).
   */
  'generate-dashboard'(args) {
    const projectId = args[0];
    if (!projectId) {
      forgeError('MISSING_ARG', 'Missing required argument: project-bead-id', 'Run: forge-tools generate-dashboard <project-bead-id>');
    }
    validateId(projectId);

    const settings = resolveSettings();

    if (settings.web_ui) {
      // Interactive mode: serve via dev-server with live refresh
      const data = collectDashboardData(projectId);

      // The token is generated internally by serveAndAwaitDecision and embedded
      // in the URL. Client-side JS extracts it from window.location.search.
      const htmlWithTokenExtraction = generateInteractiveDashboardHTML(data);

      // Register /api/data custom route that re-collects fresh data
      const routes = [
        {
          method: 'GET',
          path: '/api/data',
          handler: (_req, res, _token) => {
            try {
              const freshData = collectDashboardData(projectId);
              res.writeHead(200, {
                'Content-Type': 'application/json',
                'Cache-Control': 'no-store',
              });
              res.end(JSON.stringify(freshData));
            } catch (err) {
              res.writeHead(500, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: err.message }));
            }
          },
        },
      ];

      // Return promise -- index.cjs handles async dispatch
      return serveAndAwaitDecision({
        html: htmlWithTokenExtraction,
        title: `${data.projectTitle} - Dashboard`,
        routes,
      }).then((decision) => {
        output({ interactive: true, projectId, action: decision.action || 'close' }, 'dashboard');
      });
    }

    // Static mode: write HTML file to .forge/ directory (original behavior)
    const data = collectDashboardData(projectId);
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

    output({ path: resolvedFilePath, projectId, timestamp: data.timestamp }, 'dashboard');
  },

  // Named exports for other modules
  generateDashboardHTML,
  generateInteractiveDashboardHTML,
  collectDashboardData,
};
