'use strict';

/**
 * plan-review-commands.cjs -- Plan review, preview, and wave-computation commands.
 *
 * Commands: implementation-preview, plan-interactive-review
 */

const path = require('path');
const {
  bdArgs, bdJsonArgs, output, forgeError, validateId, normalizeChildren,
  unwrapBdArray, resolveSettings,
} = require('./core.cjs');
const { serveAndAwaitDecision } = require('./dev-server.cjs');
const { esc, COMPONENT_CSS, wrapPage, card, badge, tabs } = require('./design-system.cjs');
const { readAgentContextEntries } = require('./context-commands.cjs');

/**
 * Kahn's algorithm: compute dependency waves for a set of tasks.
 *
 * Builds an intra-phase dependency graph from pre-fetched taskDeps and runs a
 * BFS-style topological sort.  Tasks with unresolvable (circular / external)
 * dependencies are collected in a final wave tagged `circular_or_external_dependency`.
 *
 * @param {Array<{id: string, status: string}>} tasks - Flat task list.
 * @param {Object.<string, string[]>} taskDeps - Map of taskId -> array of dependency task IDs
 *   that are intra-phase and non-closed (as produced by the dep-list loop in each caller).
 * @returns {Array<{wave_number: number, tasks: Array, note?: string}>} Raw waves.
 *   Each wave contains the task objects from `tasks`; callers may enrich them after the call.
 */
function computeWaves(tasks, taskDeps) {
  const taskById = new Map(tasks.map(t => [t.id, t]));

  const inDegree = {};
  const dependents = {}; // taskId -> list of task IDs that depend on it
  for (const task of tasks) {
    inDegree[task.id] = (taskDeps[task.id] || []).length;
    dependents[task.id] = [];
  }
  for (const task of tasks) {
    for (const depId of (taskDeps[task.id] || [])) {
      if (dependents[depId]) {
        dependents[depId].push(task.id);
      }
    }
  }

  const waves = [];
  const assigned = new Set();
  // Seed: all tasks with zero in-degree
  let currentWave = tasks.filter(t => inDegree[t.id] === 0);

  while (currentWave.length > 0) {
    waves.push({
      wave_number: waves.length + 1,
      tasks: currentWave,
    });
    const nextWave = [];
    for (const t of currentWave) {
      assigned.add(t.id);
      for (const depId of (dependents[t.id] || [])) {
        inDegree[depId]--;
        if (inDegree[depId] === 0) {
          nextWave.push(taskById.get(depId));
        }
      }
    }
    currentWave = nextWave;
  }

  // Handle circular or external dependencies (remaining unassigned tasks)
  if (assigned.size < tasks.length) {
    const remaining = tasks.filter(t => !assigned.has(t.id));
    waves.push({
      wave_number: waves.length + 1,
      tasks: remaining,
      note: 'circular_or_external_dependency',
    });
  }

  return waves;
}

/**
 * Build intra-phase task dependency map for a set of tasks.
 * Calls bd dep list per task and filters to deps within the same phase
 * that are not yet closed. Used by both detect-waves and implementation-preview.
 *
 * @param {Array} tasks - array of task objects with .id and .status
 * @param {Set} phaseTaskIds - Set of task IDs in this phase
 * @param {Map} taskById - Map from task ID to task object
 * @returns {Object} taskDeps map: taskId -> array of blocking intra-phase dep IDs
 */
function buildIntraPhaseTaskDeps(tasks, phaseTaskIds, taskById) {
  // TODO(perf): N+1 subprocess -- calls bd dep list per task. Needs bd CLI batch-query support.
  const taskDeps = {};
  for (const task of tasks) {
    const depsRaw = bdArgs(['dep', 'list', task.id, '--type', 'blocks', '--json'], { allowFail: true });
    let deps = [];
    if (depsRaw) {
      // INTENTIONALLY SILENT: bd dep list may return non-JSON when no deps exist;
      // the fallback to empty array is the correct behavior.
      try { deps = JSON.parse(depsRaw); } catch { /* allowFail JSON parse fallback */ }
    }
    if (!Array.isArray(deps)) deps = [];
    const intraPhaseDeps = deps
      .filter(d => phaseTaskIds.has(d.id || d.dependency_id || d))
      .map(d => d.id || d.dependency_id || d)
      .filter(id => {
        const depTask = taskById.get(id);
        return depTask && depTask.status !== 'closed';
      });
    taskDeps[task.id] = intraPhaseDeps;
  }
  return taskDeps;
}

/**
 * Collect structured plan data for a phase: tasks grouped into execution waves
 * with design fields, descriptions, acceptance criteria, and architect notes.
 *
 * Reusable helper that powers both implementation-preview and interactive plan UI.
 *
 * @param {string} phaseId - The phase bead ID.
 * @returns {{ phase_id: string, phase_title: string|null, total_tasks: number,
 *   total_files_affected: number, waves: Array, architect_summary: string|null }}
 *   Each wave.tasks entry includes: id, title, description, acceptance_criteria,
 *   files_affected, approach, complexity, architect_notes.
 */
function collectPlanData(phaseId) {
  validateId(phaseId);

  const phase = unwrapBdArray(bdJsonArgs(['show', phaseId]));
  const children = bdJsonArgs(['children', phaseId]);
  const tasks = normalizeChildren(children);

  // --- Collect design data per task ---
  // Design field is stored as JSON on the task bead; parse it for each task.
  const taskDesigns = {};
  for (const task of tasks) {
    let design = task.design || null;
    if (typeof design === 'string') {
      // INTENTIONALLY SILENT: design field may contain malformed JSON;
      // graceful degradation to defaults is the expected behavior.
      try { design = JSON.parse(design); } catch { design = null; }
    }
    // Normalize file paths: reject absolute paths and path traversal sequences.
    // NOTE: These paths are display-only (used in implementation-preview output).
    // They are never used for file I/O, so path.normalize() without path.resolve() is intentional.
    const rawPaths = (design && Array.isArray(design.files_affected)) ? design.files_affected : [];
    const safePaths = rawPaths
      .map(p => path.normalize(String(p)))
      .filter(p => !path.isAbsolute(p) && !p.startsWith('..'));
    taskDesigns[task.id] = {
      files_affected: safePaths,
      approach: (design && design.approach) ? String(design.approach) : 'No approach specified',
      complexity: (design && design.complexity) ? String(design.complexity) : null,
    };
  }

  // --- Read forge-architect context from phase comments ---
  let architectSummary = null;
  const architectNotesByTask = {};

  for (const entry of readAgentContextEntries(phaseId, 'forge-architect')) {
    if (entry.summary) {
      architectSummary = String(entry.summary);
    }
    for (const f of (entry.findings || [])) {
      if (!f.task) continue;
      if (!architectNotesByTask[f.task]) {
        architectNotesByTask[f.task] = [];
      }
      const note = [
        f.severity ? `[${f.severity}]` : null,
        f.description || null,
        f.recommendation ? `Recommendation: ${f.recommendation}` : null,
      ].filter(Boolean).join(' ');
      if (note) architectNotesByTask[f.task].push(note);
    }
  }

  // --- Detect execution waves via shared helper (Kahn's algorithm, O(V+E)) ---
  const phaseTaskIds = new Set(tasks.map(t => t.id));
  const taskById = new Map(tasks.map(t => [t.id, t]));

  const taskDeps = buildIntraPhaseTaskDeps(tasks, phaseTaskIds, taskById);

  // Enrich waves with per-task fields including description and acceptance_criteria
  const waves = computeWaves(tasks, taskDeps).map(w => ({
    ...w,
    tasks: w.tasks.map(t => ({
      id: t.id,
      title: t.title,
      description: t.description || null,
      acceptance_criteria: t.acceptance_criteria || t.acceptance || null,
      files_affected: taskDesigns[t.id].files_affected,
      approach: taskDesigns[t.id].approach,
      complexity: taskDesigns[t.id].complexity,
      architect_notes: architectNotesByTask[t.id] || [],
    })),
  }));

  // --- Compute total files affected (deduplicated across all tasks) ---
  const allFiles = new Set();
  for (const task of tasks) {
    for (const f of taskDesigns[task.id].files_affected) {
      allFiles.add(f);
    }
  }

  return {
    phase_id: phaseId,
    phase_title: phase?.title || null,
    total_tasks: tasks.length,
    total_files_affected: allFiles.size,
    waves,
    architect_summary: architectSummary,
  };
}

// ---------------------------------------------------------------------------
// generatePlanReviewHTML -- interactive plan review page
// ---------------------------------------------------------------------------

/**
 * Generate an interactive HTML page for reviewing and editing a plan.
 *
 * Tasks are grouped by execution wave using the design-system tabs component.
 * Each task is rendered as a card with editable fields (title, description,
 * acceptance_criteria, approach, files_affected), a comment textarea, and a
 * Remove button. A sticky footer contains Approve and Reject buttons.
 *
 * Client-side JS tracks dirty fields and POSTs a batched payload to /decide.
 *
 * @param {object} data - Output of collectPlanData():
 *   { phase_id, phase_title, total_tasks, total_files_affected,
 *     waves: [{ wave_number, tasks: [{ id, title, description,
 *       acceptance_criteria, files_affected, approach, complexity,
 *       architect_notes }] }],
 *     architect_summary }
 * @returns {string} Complete HTML document string.
 */
function generatePlanReviewHTML(data) {
  const {
    phase_id = '',
    phase_title = '',
    total_tasks = 0,
    total_files_affected = 0,
    waves = [],
    architect_summary = null,
  } = data || {};

  // --- Build wave tab items and panel content ---
  const tabItems = waves.map(w => `Wave ${w.wave_number} (${w.tasks.length})`);

  function renderWavePanel(_label, idx) {
    const wave = waves[idx];
    if (!wave || !wave.tasks) return '';

    return wave.tasks.map(task => {
      const taskId = task.id || '';
      const filesStr = Array.isArray(task.files_affected)
        ? task.files_affected.join('\n')
        : String(task.files_affected || '');
      const architectNotes = Array.isArray(task.architect_notes) ? task.architect_notes : [];
      const complexityVariant = ['complex', 'medium'].includes(task.complexity) ? 'active' : 'pending';
      const complexityBadge = task.complexity
        ? badge(task.complexity, complexityVariant)
        : '';

      const architectNotesHTML = architectNotes.length > 0
        ? `<div class="plan-architect-notes">
            <div class="plan-field-label">Architect Notes</div>
            <div class="plan-notes-readonly">${architectNotes.map(n => `<div class="plan-note-item">${esc(n)}</div>`).join('\n')}</div>
          </div>`
        : '';

      const cardContent = `
        <div class="plan-task-fields" data-task-id="${esc(taskId)}">
          <div class="plan-field">
            <label class="plan-field-label" for="title-${esc(taskId)}">Title</label>
            <input type="text" id="title-${esc(taskId)}" class="plan-input plan-editable"
              data-task="${esc(taskId)}" data-field="title"
              value="${esc(task.title || '')}" />
          </div>
          <div class="plan-field">
            <label class="plan-field-label" for="desc-${esc(taskId)}">Description</label>
            <textarea id="desc-${esc(taskId)}" class="plan-textarea plan-editable"
              data-task="${esc(taskId)}" data-field="description"
              rows="3">${esc(task.description || '')}</textarea>
          </div>
          <div class="plan-field">
            <label class="plan-field-label" for="ac-${esc(taskId)}">Acceptance Criteria</label>
            <textarea id="ac-${esc(taskId)}" class="plan-textarea plan-editable"
              data-task="${esc(taskId)}" data-field="acceptance_criteria"
              rows="4">${esc(task.acceptance_criteria || '')}</textarea>
          </div>
          <div class="plan-field">
            <label class="plan-field-label" for="approach-${esc(taskId)}">Approach</label>
            <textarea id="approach-${esc(taskId)}" class="plan-textarea plan-editable"
              data-task="${esc(taskId)}" data-field="approach"
              rows="3">${esc(task.approach || '')}</textarea>
          </div>
          <div class="plan-field">
            <label class="plan-field-label" for="files-${esc(taskId)}">Files Affected (one per line)</label>
            <textarea id="files-${esc(taskId)}" class="plan-textarea plan-editable"
              data-task="${esc(taskId)}" data-field="files_affected"
              rows="3">${esc(filesStr)}</textarea>
          </div>
          ${architectNotesHTML}
          <div class="plan-field">
            <label class="plan-field-label" for="comment-${esc(taskId)}">Reviewer Comment</label>
            <textarea id="comment-${esc(taskId)}" class="plan-textarea plan-comment"
              data-task="${esc(taskId)}"
              rows="2" placeholder="Add a comment..."></textarea>
          </div>
          <div class="plan-task-actions">
            <button class="plan-btn plan-btn-remove" data-task="${esc(taskId)}">Remove Task</button>
          </div>
        </div>`;

      // Build card header manually to avoid card()'s internal esc() double-escaping the badge HTML
      const cardHeader = `<div class="plan-card-header">${esc(task.title || taskId)} <span class="plan-card-id">${esc(taskId)}</span> ${complexityBadge}</div>`;

      return card({
        content: cardHeader + cardContent,
        className: 'plan-task-card',
      });
    }).join('\n');
  }

  const tabsHTML = waves.length > 0
    ? tabs({ items: tabItems, activeIndex: 0, panelRenderer: renderWavePanel })
    : '<div class="plan-empty">No waves found in this plan.</div>';

  // --- Architect summary section ---
  const summaryHTML = architect_summary
    ? card({
        title: 'Architect Summary',
        content: `<div class="plan-architect-summary">${esc(architect_summary)}</div>`,
      })
    : '';

  // --- Phase header ---
  const headerHTML = `
  <div class="plan-header">
    <h1 class="plan-title">${esc(phase_title || 'Plan Review')}</h1>
    <div class="plan-meta">
      <span class="plan-meta-item">${badge(phase_id, 'pending')}</span>
      <span class="plan-meta-item">${total_tasks} task${total_tasks !== 1 ? 's' : ''}</span>
      <span class="plan-meta-item">${total_files_affected} file${total_files_affected !== 1 ? 's' : ''} affected</span>
    </div>
  </div>`;

  // --- Sticky footer ---
  const footerHTML = `
  <div class="plan-footer">
    <div class="plan-footer-inner">
      <span class="plan-footer-status" id="plan-status"></span>
      <button class="plan-btn plan-btn-reject" id="plan-reject">Reject</button>
      <button class="plan-btn plan-btn-approve" id="plan-approve">Approve</button>
    </div>
  </div>`;

  // --- Client-side JS for dirty tracking and submission ---
  const inlineJS = `
<script>
(function() {
  // Extract token from URL
  var params = new URLSearchParams(window.location.search);
  var token = params.get('token') || '';

  // Track original values for dirty detection
  var originals = {};
  var editables = document.querySelectorAll('.plan-editable');
  var commentEls = document.querySelectorAll('.plan-comment');
  editables.forEach(function(el) {
    var key = el.getAttribute('data-task') + ':' + el.getAttribute('data-field');
    originals[key] = el.value;
  });

  // Track removals
  var removals = new Set();

  // Remove button handlers
  document.querySelectorAll('.plan-btn-remove').forEach(function(btn) {
    btn.addEventListener('click', function() {
      var taskId = this.getAttribute('data-task');
      var taskCard = this.closest('.plan-task-card');
      if (removals.has(taskId)) {
        // Undo removal
        removals.delete(taskId);
        if (taskCard) taskCard.classList.remove('plan-task-removed');
        this.textContent = 'Remove Task';
      } else {
        removals.add(taskId);
        if (taskCard) taskCard.classList.add('plan-task-removed');
        this.textContent = 'Undo Remove';
      }
      updateStatus();
    });
  });

  function collectPayload(action) {
    var edits = [];
    var comments = [];

    editables.forEach(function(el) {
      var taskId = el.getAttribute('data-task');
      var field = el.getAttribute('data-field');
      var key = taskId + ':' + field;
      if (el.value !== originals[key]) {
        edits.push({ taskId: taskId, field: field, value: el.value });
      }
    });

    commentEls.forEach(function(el) {
      var taskId = el.getAttribute('data-task');
      var text = el.value.trim();
      if (text) {
        comments.push({ taskId: taskId, text: text });
      }
    });

    return {
      action: action,
      edits: edits,
      comments: comments,
      removals: Array.from(removals),
    };
  }

  function updateStatus() {
    var statusEl = document.getElementById('plan-status');
    var dirtyCount = 0;
    editables.forEach(function(el) {
      var key = el.getAttribute('data-task') + ':' + el.getAttribute('data-field');
      if (el.value !== originals[key]) dirtyCount++;
    });
    var commentCount = 0;
    commentEls.forEach(function(el) {
      if (el.value.trim()) commentCount++;
    });
    var parts = [];
    if (dirtyCount > 0) parts.push(dirtyCount + ' edit' + (dirtyCount !== 1 ? 's' : ''));
    if (commentCount > 0) parts.push(commentCount + ' comment' + (commentCount !== 1 ? 's' : ''));
    if (removals.size > 0) parts.push(removals.size + ' removal' + (removals.size !== 1 ? 's' : ''));
    statusEl.textContent = parts.length > 0 ? parts.join(', ') : '';
  }

  editables.forEach(function(el) {
    el.addEventListener('input', updateStatus);
  });
  commentEls.forEach(function(el) {
    el.addEventListener('input', updateStatus);
  });

  function submitDecision(action) {
    var payload = collectPayload(action);
    var approveBtn = document.getElementById('plan-approve');
    var rejectBtn = document.getElementById('plan-reject');
    var statusEl = document.getElementById('plan-status');

    approveBtn.disabled = true;
    rejectBtn.disabled = true;
    statusEl.textContent = 'Submitting...';

    fetch('/decide?token=' + encodeURIComponent(token), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    }).then(function(res) {
      if (!res.ok) throw new Error('Server returned ' + res.status);
      return res.json();
    }).then(function() {
      statusEl.textContent = 'Decision submitted. You can close this tab.';
      statusEl.style.color = 'var(--green)';
    }).catch(function(err) {
      approveBtn.disabled = false;
      rejectBtn.disabled = false;
      statusEl.textContent = 'Error: ' + err.message;
      statusEl.style.color = 'var(--red)';
    });
  }

  document.getElementById('plan-approve').addEventListener('click', function() {
    submitDecision('approve');
  });
  document.getElementById('plan-reject').addEventListener('click', function() {
    submitDecision('reject');
  });
})();
<\/script>`;

  // --- Page-specific CSS ---
  const extraCSS = `
  ${COMPONENT_CSS}

  body { padding: 32px; padding-bottom: 100px; }
  .container { max-width: 960px; margin: 0 auto; }

  /* Header */
  .plan-header { margin-bottom: 24px; }
  .plan-title {
    font-size: 24px; font-weight: 700; color: var(--text);
    margin-bottom: 8px;
  }
  .plan-meta {
    display: flex; align-items: center; gap: 12px;
    color: var(--text-muted); font-size: 13px;
  }

  /* Task cards */
  .plan-task-card { margin-bottom: 16px; }
  .plan-task-card.plan-task-removed {
    opacity: 0.4;
    border-color: var(--red);
  }
  .plan-task-fields { display: flex; flex-direction: column; gap: 12px; }
  .plan-card-header {
    font-size: 15px; font-weight: 600; color: var(--text);
    margin-bottom: 12px; display: flex; align-items: center; gap: 8px; flex-wrap: wrap;
  }
  .plan-card-id {
    font-size: 11px; font-weight: 400; color: var(--text-muted);
    font-family: monospace;
  }

  /* Form fields */
  .plan-field { display: flex; flex-direction: column; gap: 4px; }
  .plan-field-label {
    font-size: 12px; font-weight: 600; color: var(--text-muted);
    text-transform: uppercase; letter-spacing: 0.05em;
  }
  .plan-input, .plan-textarea {
    background: var(--surface-2); border: 1px solid var(--border);
    border-radius: 6px; padding: 8px 12px; color: var(--text);
    font-family: inherit; font-size: 14px; line-height: 1.5;
    transition: border-color 0.2s;
    width: 100%;
  }
  .plan-input:focus, .plan-textarea:focus {
    outline: none; border-color: var(--accent);
  }
  .plan-textarea { resize: vertical; min-height: 60px; }

  /* Architect notes (read-only) */
  .plan-architect-notes { margin-top: 4px; }
  .plan-notes-readonly {
    background: var(--surface-solid); border: 1px solid var(--border);
    border-radius: 6px; padding: 8px 12px; font-size: 13px;
    color: var(--text-secondary);
  }
  .plan-note-item { padding: 4px 0; border-bottom: 1px solid var(--border-subtle); }
  .plan-note-item:last-child { border-bottom: none; }

  /* Architect summary */
  .plan-architect-summary {
    color: var(--text-secondary); font-size: 14px; line-height: 1.6;
    white-space: pre-wrap;
  }

  /* Buttons */
  .plan-btn {
    border: 1px solid var(--border); border-radius: 6px;
    padding: 8px 16px; font-size: 13px; font-weight: 500;
    cursor: pointer; transition: background 0.2s, border-color 0.2s;
  }
  .plan-btn:disabled { opacity: 0.5; cursor: not-allowed; }
  .plan-btn-remove {
    background: transparent; color: var(--red); border-color: var(--red);
  }
  .plan-btn-remove:hover { background: rgba(239,68,68,0.1); }
  .plan-btn-approve {
    background: var(--green); border-color: var(--green); color: #fff; font-weight: 600;
  }
  .plan-btn-approve:hover { background: #16a34a; }
  .plan-btn-reject {
    background: transparent; color: var(--red); border-color: var(--red); font-weight: 600;
  }
  .plan-btn-reject:hover { background: rgba(239,68,68,0.1); }

  /* Task actions row */
  .plan-task-actions {
    display: flex; justify-content: flex-end; gap: 8px; margin-top: 4px;
  }

  /* Sticky footer */
  .plan-footer {
    position: fixed; bottom: 0; left: 0; right: 0;
    background: var(--surface-solid); border-top: 1px solid var(--border);
    padding: 12px 24px; z-index: 100;
    backdrop-filter: blur(24px); -webkit-backdrop-filter: blur(24px);
  }
  .plan-footer-inner {
    max-width: 960px; margin: 0 auto;
    display: flex; align-items: center; justify-content: flex-end; gap: 12px;
  }
  .plan-footer-status {
    flex: 1; color: var(--text-muted); font-size: 13px;
  }

  /* Empty state */
  .plan-empty {
    text-align: center; padding: 40px; color: var(--text-muted); font-size: 16px;
  }`;

  const bodyHTML = `
<div class="container">
  ${headerHTML}
  ${summaryHTML}
  ${tabsHTML}
</div>
${footerHTML}
${inlineJS}`;

  return wrapPage('Plan Review', bodyHTML, extraCSS);
}

module.exports = {
  // Expose helpers for programmatic use by other command modules
  computeWaves,
  buildIntraPhaseTaskDeps,
  collectPlanData,
  generatePlanReviewHTML,

  /**
   * Generate a structured implementation preview for a phase.
   *
   * Delegates to collectPlanData() for data collection, then strips the
   * description and acceptance_criteria fields from each task to preserve
   * the original output schema.
   */
  'implementation-preview'(args) {
    const phaseId = args[0];
    if (!phaseId) {
      forgeError('MISSING_ARG', 'Missing required argument: phase-id', 'Run: forge-tools implementation-preview <phase-id>');
    }

    const data = collectPlanData(phaseId);

    // Strip description and acceptance_criteria to preserve original output schema
    const waves = data.waves.map(w => ({
      ...w,
      tasks: w.tasks.map(({ description, acceptance_criteria, ...rest }) => rest),
    }));

    output({ ...data, waves }, 'implementation-preview');
  },

  /**
   * Interactive plan review -- serve plan UI via dev-server or fall back to
   * AskUserQuestion when web_ui is disabled.
   *
   * Usage: forge-tools plan-interactive-review <phase-id>
   *
   * When web_ui=true: serves the interactive HTML page, waits for the user's
   * decision, applies mutations (edits, comments, removals), then outputs the
   * decision payload.
   *
   * When web_ui=false: outputs { fallback: true, data: <collectPlanData output> }
   * so the calling workflow can use AskUserQuestion instead.
   */
  'plan-interactive-review'(args) {
    const phaseId = args[0];
    if (!phaseId) {
      forgeError('MISSING_ARG', 'Missing required argument: phase-id',
        'Run: forge-tools plan-interactive-review <phase-id>');
    }
    validateId(phaseId);

    const settings = resolveSettings();
    const data = collectPlanData(phaseId);

    if (!settings.web_ui) {
      output({ fallback: true, data }, 'plan-interactive-review');
      return;
    }

    const html = generatePlanReviewHTML(data);

    // Return a promise -- index.cjs handles async dispatch
    return serveAndAwaitDecision({
      html,
      title: 'Plan Review',
      timeout: 1800000, // 30 minutes
    }).then((decision) => {
      // Apply mutations based on the decision payload
      const { action, edits = [], comments = [], removals = [] } = decision || {};

      if (action === 'reject') {
        output({ action: 'reject' }, 'plan-interactive-review');
        return;
      }

      // Group design-field edits by taskId to avoid read-modify-write clobber
      const designEdits = new Map(); // taskId -> { approach?, files_affected? }
      const simpleEdits = [];

      for (const edit of edits) {
        const { taskId, field, value } = edit;
        if (!taskId || !field || value === undefined) continue;
        validateId(taskId);

        if (field === 'approach' || field === 'files_affected') {
          if (!designEdits.has(taskId)) designEdits.set(taskId, {});
          designEdits.get(taskId)[field] = value;
        } else {
          simpleEdits.push(edit);
        }
      }

      // Apply simple edits (title, description, acceptance_criteria)
      let appliedCount = 0;
      for (const { taskId, field, value } of simpleEdits) {
        if (field === 'title') {
          bdArgs(['update', taskId, `--title=${value}`]);
          appliedCount++;
        } else if (field === 'description') {
          bdArgs(['update', taskId, `--description=${value}`]);
          appliedCount++;
        } else if (field === 'acceptance_criteria') {
          bdArgs(['update', taskId, `--acceptance=${value}`]);
          appliedCount++;
        }
      }

      // Apply grouped design-field edits (single read-modify-write per task)
      for (const [taskId, fields] of designEdits) {
        const task = unwrapBdArray(bdJsonArgs(['show', taskId]));
        let design = task.design || null;
        if (typeof design === 'string') {
          try { design = JSON.parse(design); } catch { design = {}; }
        }
        if (!design) design = {};

        if (fields.approach !== undefined) {
          design.approach = fields.approach;
        }
        if (fields.files_affected !== undefined) {
          // Sanitize paths: normalize, reject absolute and traversal paths
          design.files_affected = fields.files_affected.split('\n')
            .map(p => path.normalize(String(p).trim()))
            .filter(p => p && !path.isAbsolute(p) && !p.startsWith('..'));
        }

        bdArgs(['update', taskId, `--design=${JSON.stringify(design)}`]);
        appliedCount++;
      }

      // Apply comments
      for (const comment of comments) {
        const { taskId, text } = comment;
        if (!taskId || !text) continue;
        validateId(taskId);
        bdArgs(['comments', 'add', taskId, text]);
      }

      // Apply removals (hard close)
      for (const taskId of removals) {
        if (!taskId) continue;
        validateId(taskId);
        bdArgs(['close', taskId, '--reason=removed from plan']);
      }

      output({
        action: 'approve',
        edits_applied: appliedCount,
        comments_applied: comments.length,
        removals_applied: removals.length,
      }, 'plan-interactive-review');
    }).catch((err) => {
      forgeError('SERVER_ERROR', `Plan review server failed: ${err.message}`,
        'Retry or set web_ui=false to use the CLI fallback');
    });
  },
};
