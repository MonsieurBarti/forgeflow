'use strict';

/**
 * phase-commands.cjs -- Phase-related forge-tools commands.
 *
 * Commands: phase-context, phase-ready, plan-check, preflight-check,
 *           detect-waves, checkpoint-save, checkpoint-load, verify-phase,
 *           add-phase, insert-phase, remove-phase, list-phases,
 *           resolve-phase, context-write, context-read, retro-query,
 *           detect-build-test, implementation-preview
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const os = require('os');
const {
  bdArgs, bdJsonArgs, output, forgeError, validateId, normalizeChildren,
  collectMilestoneRequirements, findGitRoot,
} = require('./core.cjs');

/**
 * Detect build and test commands for the current project.
 *
 * Resolution order:
 *   1. Check bd memories for forge:codebase:commands (fast path).
 *   2. Fall back to filesystem detection: package.json, Cargo.toml, pyproject.toml.
 *
 * Shared helper so verify.md consumers and other callers can reference it.
 *
 * @returns {{ build_cmds: string[], test_cmds: string[], config_source: string|null, has_tests: boolean }}
 */
// Allowlist of safe command prefixes for memory-sourced commands
const SAFE_CMD_PREFIXES = /^(npm|npx|yarn|pnpm|cargo|python|python3|pytest|make|go|bun|deno|ruby|bundle|rake|mvn|gradle|dotnet)\b/;
// Reject commands containing shell metacharacters even when prefix passes allowlist
const SHELL_METACHAR_RE = /[;|&$`<>]/;

// Allowlist for checkpoint fields -- shared between checkpoint-save and checkpoint-load
// to prevent arbitrary external data from being written or output.
const CHECKPOINT_ALLOWLIST = [
  'phaseId', 'phase_id', 'completedWaves', 'currentWave', 'taskStatuses',
  'preExistingClosed', 'branchName', 'baseCommitSha', 'timestamp', 'completed',
];

/**
 * Check if real test files exist on disk.
 * Looks for common test directories (tests/, test/, __tests__/) and
 * test file patterns (*.test.*, *.spec.*) up to 2 levels deep.
 */
function hasActualTestFiles(root) {
  const testDirs = ['tests', 'test', '__tests__', 'spec'];
  for (const dir of testDirs) {
    const dirPath = path.join(root, dir);
    try {
      const stat = fs.statSync(dirPath);
      if (stat.isDirectory()) {
        const entries = fs.readdirSync(dirPath);
        if (entries.some(e => /\.(test|spec)\.\w+$/.test(e) || e.endsWith('.test') || e.endsWith('.spec'))) {
          return true;
        }
      }
    } catch { /* INTENTIONALLY SILENT: dir doesn't exist */ }
  }
  // Check src/ and root for *.test.* / *.spec.* files (1 level deep)
  for (const searchDir of [root, path.join(root, 'src')]) {
    try {
      const entries = fs.readdirSync(searchDir);
      if (entries.some(e => /\.(test|spec)\.\w+$/.test(e))) return true;
    } catch { /* INTENTIONALLY SILENT */ }
  }
  return false;
}

function detectBuildTest() {
  const root = findGitRoot(process.cwd()) || process.cwd();

  // --- Fast path: check bd memories ---
  const memRaw = bdArgs(['memories', 'forge:codebase:commands'], { allowFail: true });
  if (memRaw) {
    const buildCmds = [];
    const testCmds = [];
    // Memory text is freeform; extract lines mentioning build/test commands.
    const lines = memRaw.split('\n');
    for (const line of lines) {
      const trimmed = line.trim().toLowerCase();
      if (/\bbuild\b/.test(trimmed)) {
        const cmd = line.replace(/^[\s\-*]*(?:build\s*(?:command)?[:=]\s*)?/i, '').trim();
        if (cmd && SAFE_CMD_PREFIXES.test(cmd) && !SHELL_METACHAR_RE.test(cmd)) buildCmds.push(cmd);
      }
      if (/\btest\b/.test(trimmed)) {
        const cmd = line.replace(/^[\s\-*]*(?:test\s*(?:command)?[:=]\s*)?/i, '').trim();
        if (cmd && SAFE_CMD_PREFIXES.test(cmd) && !SHELL_METACHAR_RE.test(cmd)) testCmds.push(cmd);
      }
    }
    if (buildCmds.length > 0 || testCmds.length > 0) {
      return {
        build_cmds: buildCmds,
        test_cmds: testCmds,
        config_source: 'bd-memory',
        has_tests: testCmds.length > 0,
      };
    }
  }

  // --- Filesystem detection (anchored to git root) ---

  // package.json
  const pkgPath = path.join(root, 'package.json');
  try {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    const scripts = pkg.scripts || {};
    const buildCmds = scripts.build ? ['npm run build'] : [];
    const testCmds = scripts.test ? ['npm test'] : [];
    // Only claim has_tests when real test files exist on disk — a package.json
    // "test" script alone is insufficient (npm init seeds a placeholder script).
    const hasTestFiles = testCmds.length > 0 && hasActualTestFiles(root);
    return {
      build_cmds: buildCmds,
      test_cmds: testCmds,
      config_source: 'package.json',
      has_tests: hasTestFiles,
    };
  } catch {
    // INTENTIONALLY SILENT: missing or malformed package.json, fall through.
  }

  // Cargo.toml
  const cargoPath = path.join(root, 'Cargo.toml');
  if (fs.existsSync(cargoPath)) {
    return {
      build_cmds: ['cargo build'],
      test_cmds: ['cargo test'],
      config_source: 'Cargo.toml',
      has_tests: true,
    };
  }

  // pyproject.toml
  const pyprojectPath = path.join(root, 'pyproject.toml');
  try {
    const content = fs.readFileSync(pyprojectPath, 'utf8');
    const hasPytest = /pytest/i.test(content);
    const testCmds = hasPytest ? ['python -m pytest'] : ['python -m unittest discover'];
    return {
      build_cmds: [],
      test_cmds: testCmds,
      config_source: 'pyproject.toml',
      has_tests: true,
    };
  } catch {
    // INTENTIONALLY SILENT: missing or malformed pyproject.toml, fall through.
  }

  // No config files found
  return {
    build_cmds: [],
    test_cmds: [],
    config_source: null,
    has_tests: false,
  };
}


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
 * Read phase comments, parse JSON entries, and return context entries.
 *
 * Iterates over phase bead comments, silently skips non-JSON entries, and
 * returns parsed objects that have an `agent` field.  When `agentFilter` is
 * provided, only entries whose `agent` matches are returned.
 *
 * @param {string} phaseId - The phase bead ID.
 * @param {string|null} [agentFilter] - If set, only entries with this agent value are returned.
 *   Pass null (or omit) to return all entries that have an agent field.
 * @returns {Array<Object>} Parsed context entry objects.
 */
function readAgentContextEntries(phaseId, agentFilter = null) {
  const comments = bdJsonArgs(['comments', phaseId]);
  if (!comments) return [];

  const list = Array.isArray(comments) ? comments : (comments.comments || []);
  const entries = [];

  for (const c of list) {
    const body = c.body || c.content || c.text || '';
    try {
      const parsed = JSON.parse(body);
      if (!parsed.agent) continue;
      if (agentFilter !== null && parsed.agent !== agentFilter) continue;
      entries.push(parsed);
    } catch {
      // INTENTIONALLY SILENT: comments can be free-text (not JSON); skipping
      // non-JSON comments is the expected behavior when filtering for context entries.
    }
  }

  return entries;
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

  const phaseRaw = bdJsonArgs(['show', phaseId]);
  const phase = Array.isArray(phaseRaw) ? phaseRaw[0] : phaseRaw;
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

module.exports = {
  // Expose helpers for programmatic use by other commands and callers
  detectBuildTest,
  collectPlanData,
  /**
   * Get phase context: phase details + all tasks + their statuses.
   */
  'phase-context'(args) {
    const phaseId = args[0];
    if (!phaseId) {
      forgeError('MISSING_ARG', 'Missing required argument: phase-bead-id', 'Run: forge-tools phase-context <phase-bead-id>');
    }
    validateId(phaseId);

    const phaseRaw = bdJsonArgs(['show', phaseId]);
    const phase = Array.isArray(phaseRaw) ? phaseRaw[0] : phaseRaw;
    const children = bdJsonArgs(['children', phaseId]);
    const tasks = normalizeChildren(children);

    const ready = tasks.filter(t => t.status === 'open');
    const inProgress = tasks.filter(t => t.status === 'in_progress');
    const done = tasks.filter(t => t.status === 'closed');

    output({
      phase: {
        id: phase?.id,
        title: phase?.title,
        description: phase?.description,
        notes: phase?.notes || null,
        design: phase?.design || null,
        status: phase?.status,
      },
      tasks,
      summary: {
        total: tasks.length,
        ready: ready.length,
        in_progress: inProgress.length,
        done: done.length,
      },
    });
  },

  /**
   * Get ready work within a specific phase.
   */
  'phase-ready'(args) {
    const phaseId = args[0];
    if (!phaseId) {
      forgeError('MISSING_ARG', 'Missing required argument: phase-bead-id', 'Run: forge-tools phase-ready <phase-bead-id>');
    }
    validateId(phaseId);

    const children = bdJsonArgs(['children', phaseId]);
    const tasks = normalizeChildren(children);

    const ready = tasks.filter(t => t.status === 'open');
    output({ phase_id: phaseId, ready_tasks: ready });
  },

  /**
   * Validate a phase plan: check acceptance criteria, labels, requirement coverage.
   */
  'plan-check'(args) {
    const phaseId = args[0];
    if (!phaseId) {
      forgeError('MISSING_ARG', 'Missing required argument: phase-bead-id', 'Run: forge-tools plan-check <phase-bead-id>');
    }
    validateId(phaseId);

    const phase = bdJsonArgs(['show', phaseId]);
    const children = bdJsonArgs(['children', phaseId]);
    const tasks = normalizeChildren(children);

    const findings = [];
    const tasksWithoutCriteria = [];
    const tasksWithoutLabel = [];

    for (const task of tasks) {
      if (!task.acceptance_criteria || task.acceptance_criteria.trim() === '') {
        tasksWithoutCriteria.push({ id: task.id, title: task.title });
      }
      if (!(task.labels || []).includes('forge:task')) {
        tasksWithoutLabel.push({ id: task.id, title: task.title });
      }
    }

    if (tasksWithoutCriteria.length > 0) {
      const taskList = tasksWithoutCriteria.map(t => `${t.id} (${t.title})`).join(', ');
      findings.push({
        number: findings.length + 1,
        severity: 'blocker',
        description: `${tasksWithoutCriteria.length} task(s) are missing acceptance criteria: ${taskList}`,
        fix: `Run: bd update <task-id> --acceptance="<specific, testable criteria>" for each task listed above.`,
      });
    }

    if (tasksWithoutLabel.length > 0) {
      const taskList = tasksWithoutLabel.map(t => `${t.id} (${t.title})`).join(', ');
      findings.push({
        number: findings.length + 1,
        severity: 'suggestion',
        description: `${tasksWithoutLabel.length} task(s) are missing the forge:task label: ${taskList}`,
        fix: `Run: bd label add <task-id> forge:task for each task listed above.`,
      });
    }

    // Check requirement coverage via validates deps
    // 3-level traversal: phase -> parent milestone -> all phases -> each phase's children filtered for forge:req
    const parentId = phase?.parent || null;
    let uncoveredReqs = [];
    if (parentId) {
      const requirements = collectMilestoneRequirements(parentId);

      // TODO(perf): N+1 subprocess -- calls bd dep list per requirement. Needs bd CLI batch-query support.
      for (const req of requirements) {
        const depsRaw = bdArgs(['dep', 'list', req.id, '--direction=up', '--type', 'validates', '--json'], { allowFail: true });
        let deps = [];
        if (depsRaw) {
          // INTENTIONALLY SILENT: bd dep list may return non-JSON when no deps exist;
          // the fallback to empty array is the correct behavior.
          try { deps = JSON.parse(depsRaw); } catch { /* allowFail JSON parse fallback */ }
        }
        if (!Array.isArray(deps) || deps.length === 0) {
          uncoveredReqs.push({ id: req.id, title: req.title });
        }
      }

      if (uncoveredReqs.length > 0) {
        const reqList = uncoveredReqs.map(r => `${r.id} (${r.title})`).join(', ');
        findings.push({
          number: findings.length + 1,
          severity: 'blocker',
          description: `${uncoveredReqs.length} requirement(s) have no validates links from any task: ${reqList}`,
          fix: `Run: bd dep add <task-id> <req-id> --type=validates for each requirement to establish traceability.`,
        });
      }
    }

    const hasBlockers = findings.some(f => f.severity === 'blocker');
    const verdict = hasBlockers ? 'NEEDS_REVISION' : 'APPROVED';

    const issues = findings.map(f => ({
      type: f.severity === 'blocker' ? 'blocker' : 'suggestion',
      severity: f.severity === 'blocker' ? 'error' : 'warning',
      description: f.description,
      fix: f.fix,
    }));

    output({
      phase_id: phaseId,
      phase_title: phase?.title,
      total_tasks: tasks.length,
      verdict,
      findings,
      issues,
      summary: {
        tasks_with_criteria: tasks.length - tasksWithoutCriteria.length,
        tasks_without_criteria: tasksWithoutCriteria.length,
        tasks_with_label: tasks.length - tasksWithoutLabel.length,
        uncovered_requirements: uncoveredReqs.length,
      },
    });
  },

  /**
   * Pre-flight check before executing a phase.
   */
  'preflight-check'(args) {
    const phaseId = args[0];
    if (!phaseId) {
      forgeError('MISSING_ARG', 'Missing required argument: phase-bead-id', 'Run: forge-tools preflight-check <phase-bead-id>');
    }
    validateId(phaseId);

    const phase = bdJsonArgs(['show', phaseId]);
    const children = bdJsonArgs(['children', phaseId]);
    const tasks = normalizeChildren(children);

    const issues = [];

    const depsRaw = bdArgs(['dep', 'list', phaseId, '--json'], { allowFail: true });
    let deps = [];
    if (depsRaw) {
      // INTENTIONALLY SILENT: bd dep list may return non-JSON when no deps exist;
      // the fallback to empty array is the correct behavior.
      try { deps = JSON.parse(depsRaw); } catch { /* allowFail JSON parse fallback */ }
    }
    const blockerDeps = Array.isArray(deps)
      ? deps.filter(d => d.type === 'blocks' || d.type === 'predecessor' || d.type === 'blocked-by')
      : [];
    // TODO(perf): N+1 subprocess -- calls bd show per blocker dep. Needs bd CLI batch-query support.
    const openBlockers = [];
    for (const dep of blockerDeps) {
      const blockerId = dep.from || dep.source || dep.id;
      if (!blockerId || blockerId === phaseId) continue;
      const blocker = bdJsonArgs(['show', blockerId]);
      if (blocker && blocker.status !== 'closed') {
        openBlockers.push({ id: blockerId, title: blocker.title, status: blocker.status });
      }
    }
    if (openBlockers.length > 0) {
      const list = openBlockers.map(b => `${b.id} (${b.title}, status: ${b.status})`).join(', ');
      issues.push({
        type: 'blocker_phase_open',
        severity: 'error',
        details: `${openBlockers.length} blocker phase(s) are not closed: ${list}`,
      });
    }

    if (tasks.length === 0) {
      issues.push({
        type: 'no_tasks',
        severity: 'error',
        details: 'No tasks exist under this phase.',
      });
    }

    const tasksWithoutCriteria = tasks.filter(
      t => !t.acceptance_criteria || t.acceptance_criteria.trim() === ''
    );
    if (tasksWithoutCriteria.length > 0) {
      const list = tasksWithoutCriteria.map(t => `${t.id} (${t.title})`).join(', ');
      issues.push({
        type: 'missing_acceptance_criteria',
        severity: 'error',
        details: `${tasksWithoutCriteria.length} task(s) are missing acceptance_criteria: ${list}`,
      });
    }

    const verdict = issues.some(i => i.severity === 'error') ? 'FAIL' : 'PASS';

    output({
      phase_id: phaseId,
      phase_title: phase?.title,
      verdict,
      issues,
    });
  },

  /**
   * Detect dependency waves for phase execution.
   */
  'detect-waves'(args) {
    const phaseId = args[0];
    if (!phaseId) {
      forgeError('MISSING_ARG', 'Missing required argument: phase-bead-id', 'Run: forge-tools detect-waves <phase-bead-id>');
    }
    validateId(phaseId);

    const phase = bdJsonArgs(['show', phaseId]);
    const children = bdJsonArgs(['children', phaseId]);
    const tasks = normalizeChildren(children);

    if (tasks.length === 0) {
      output({ phase_id: phaseId, waves: [], summary: { total_tasks: 0, total_waves: 0 } });
      return;
    }

    const phaseTaskIds = new Set(tasks.map(t => t.id));
    const taskById = new Map(tasks.map(t => [t.id, t]));

    const taskDeps = buildIntraPhaseTaskDeps(tasks, phaseTaskIds, taskById);

    // Delegate wave computation to shared helper (Kahn's algorithm, O(V+E))
    const rawWaves = computeWaves(tasks, taskDeps);

    // Enrich each wave with detect-waves specific fields
    const waves = rawWaves.map(w => ({
      ...w,
      tasks: w.tasks.map(t => ({
        id: t.id,
        title: t.title,
        status: t.status,
        ...(w.note === 'circular_or_external_dependency' ? { blocked_by: taskDeps[t.id] || [] } : {}),
      })),
    }));

    const executableWaves = waves.map(w => ({
      ...w,
      tasks_to_execute: w.tasks.filter(t => t.status === 'open' || t.status === 'in_progress'),
      tasks_already_done: w.tasks.filter(t => t.status === 'closed'),
    }));

    output({
      phase_id: phaseId,
      phase_title: phase?.title,
      phase_status: phase?.status,
      waves: executableWaves,
      summary: {
        total_tasks: tasks.length,
        total_waves: waves.length,
        tasks_open: tasks.filter(t => t.status === 'open').length,
        tasks_in_progress: tasks.filter(t => t.status === 'in_progress').length,
        tasks_closed: tasks.filter(t => t.status === 'closed').length,
      },
    });
  },

  /**
   * Save execution checkpoint to phase bead notes and bd remember.
   */
  'checkpoint-save'(args) {
    const phaseId = args[0];
    const checkpointArg = args.slice(1).join(' ');
    if (!phaseId || !checkpointArg) {
      forgeError('MISSING_ARG', 'Missing required arguments: phase-id and checkpoint-json', 'Run: forge-tools checkpoint-save <phase-id> <checkpoint-json>');
    }
    validateId(phaseId);

    let parsed;
    try {
      parsed = JSON.parse(checkpointArg);
    } catch (err) {
      forgeError('INVALID_INPUT', `Invalid checkpoint JSON: ${err.message}`, 'Provide valid JSON as the second argument');
    }

    // Filter against CHECKPOINT_ALLOWLIST (module-level) to prevent
    // arbitrary external data from being written to bead notes.
    const checkpoint = {};
    for (const key of CHECKPOINT_ALLOWLIST) {
      if (parsed[key] !== undefined) checkpoint[key] = parsed[key];
    }
    checkpoint.timestamp = checkpoint.timestamp || new Date().toISOString().replace(/\.\d+Z$/, 'Z');
    checkpoint.phase_id = checkpoint.phase_id || parsed.phaseId || phaseId;
    // Remove camelCase variant if present (normalize to snake_case)
    delete checkpoint.phaseId;

    const checkpointJson = JSON.stringify(checkpoint);
    const notesValue = `forge:checkpoint ${checkpointJson}`;

    bdArgs(['update', phaseId, '--notes', notesValue], { allowFail: false });

    const memoryKey = `forge:checkpoint:${phaseId}`;
    bdArgs(['remember', '--key', memoryKey, checkpointJson], { allowFail: true });

    output({ saved: true, phase_id: phaseId, checkpoint });
  },

  /**
   * Load execution checkpoint from phase bead notes.
   */
  'checkpoint-load'(args) {
    const phaseId = args[0];
    if (!phaseId) {
      forgeError('MISSING_ARG', 'Missing required argument: phase-id', 'Run: forge-tools checkpoint-load <phase-id>');
    }
    validateId(phaseId);

    let checkpoint = null;

    try {
      const phaseRaw = bdJsonArgs(['show', phaseId]);
      const phase = Array.isArray(phaseRaw) ? phaseRaw[0] : phaseRaw;
      const notes = phase?.notes || '';
      const match = notes.match(/forge:checkpoint\s+(\{[\s\S]*\})/);
      if (match) {
        checkpoint = JSON.parse(match[1]);
      }
    } catch {
      // INTENTIONALLY SILENT: checkpoint data may be corrupt or missing;
      // the fallback to bd memories lookup below handles this gracefully.
    }

    if (!checkpoint) {
      try {
        const memKey = `forge:checkpoint:${phaseId}`;
        const mem = bdArgs(['memories', memKey], { allowFail: true });
        if (mem) {
          const jsonMatch = mem.match(/\{[\s\S]*\}/);
          if (jsonMatch) {
            checkpoint = JSON.parse(jsonMatch[0]);
          }
        }
      } catch {
        // INTENTIONALLY SILENT: bd memories may return non-JSON or fail;
        // returning found:false below is the correct fallback.
      }
    }

    if (!checkpoint) {
      output({ found: false, suggestion: 'No checkpoint found for this phase. Save one with: forge-tools checkpoint-save <phase-id> <checkpoint-json>' });
      return;
    }

    // Filter loaded checkpoint against allowlist to strip any unexpected keys
    // that may have been injected via bead notes or bd memories.
    const safe = {};
    for (const key of CHECKPOINT_ALLOWLIST) {
      if (checkpoint[key] !== undefined) safe[key] = checkpoint[key];
    }

    output(safe);
  },

  /**
   * Get phase tasks with acceptance criteria for verification.
   */
  'verify-phase'(args) {
    const phaseId = args[0];
    if (!phaseId) {
      forgeError('MISSING_ARG', 'Missing required argument: phase-bead-id', 'Run: forge-tools verify-phase <phase-bead-id>');
    }
    validateId(phaseId);

    const phaseRaw = bdJsonArgs(['show', phaseId]);
    const phase = Array.isArray(phaseRaw) ? phaseRaw[0] : phaseRaw;
    const children = bdJsonArgs(['children', phaseId]);
    const tasks = normalizeChildren(children);

    // TODO(perf): N+1 subprocess -- calls bd show per task. Needs bd CLI batch-query support.
    const enrichedTasks = tasks.map(task => {
      const raw = bdJsonArgs(['show', task.id]);
      const full = Array.isArray(raw) ? raw[0] : raw;
      return {
        id: task.id,
        title: task.title || full?.title,
        status: task.status || full?.status,
        acceptance_criteria: full?.acceptance_criteria || '',
        notes: full?.notes || '',
      };
    });

    // Tasks ready for verification: closed tasks OR in_progress tasks with EXECUTION_COMPLETE marker
    const executionCompleteTasks = enrichedTasks.filter(
      t => t.status === 'in_progress' && (t.notes || '').includes('EXECUTION_COMPLETE')
    );
    const closedTasks = enrichedTasks.filter(t => t.status === 'closed');
    const tasksToVerify = [...closedTasks, ...executionCompleteTasks];

    // Tasks still open: exclude closed and exclude EXECUTION_COMPLETE tasks
    const completedIds = new Set(tasksToVerify.map(t => t.id));
    const openTasks = enrichedTasks.filter(t => !completedIds.has(t.id));

    // 3-level traversal: phase -> parent milestone -> all phases -> each phase's children filtered for forge:req
    const parentId = phase?.parent || null;
    let requirements = [];
    if (parentId) {
      requirements = collectMilestoneRequirements(parentId);
    }

    output({
      phase: { id: phase?.id, title: phase?.title, status: phase?.status, parent: parentId },
      tasks_to_verify: tasksToVerify,
      tasks_still_open: openTasks,
      total_tasks: tasks.length,
      total_closed: closedTasks.length,
      total_open: openTasks.length,
      requirements_count: requirements.length,
    });
  },

  /**
   * Add a new phase to the end of a project's phase list.
   */
  'add-phase'(args) {
    const projectId = args[0];
    const milestoneId = args[1];
    const description = args.slice(2).join(' ');
    if (!projectId || !milestoneId || !description) {
      forgeError('MISSING_ARG', 'Missing required arguments: project-id, milestone-id, and description', 'Run: forge-tools add-phase <project-id> <milestone-id> <description>');
    }
    validateId(projectId);
    validateId(milestoneId);

    const milestone = bdJsonArgs(['show', milestoneId]);
    if (!milestone || !milestone.id) {
      forgeError('NOT_FOUND', `Milestone '${milestoneId}' not found`, 'Verify the milestone ID with: forge-tools milestone-list <project-id>', { milestoneId });
    }
    if (milestone.status === 'closed') {
      forgeError('INVALID_STATE', `Milestone '${milestoneId}' is closed`, 'Phases can only be added to active milestones. Create a new milestone or reopen the existing one.', { milestoneId, status: milestone.status });
    }

    const children = bdJsonArgs(['children', milestoneId]);
    const issues = normalizeChildren(children);
    const phases = issues.filter(i => (i.labels || []).includes('forge:phase'));

    let maxPhaseNum = 0;
    for (const phase of phases) {
      const match = (phase.title || '').match(/^Phase\s+(\d+)/i);
      if (match) {
        const num = parseInt(match[1], 10);
        if (num > maxPhaseNum) maxPhaseNum = num;
      }
    }
    const nextNum = maxPhaseNum + 1;
    const title = `Phase ${nextNum}: ${description}`;

    const createRaw = bdArgs(['create', `--title=${title}`, `--description=${description}`, '--type=epic', '--priority=1', '--json']);
    let created;
    // INTENTIONALLY SILENT: bd create output format varies; fallback to null triggers
    // the forgeError below which provides an actionable suggestion.
    try { created = JSON.parse(createRaw); if (Array.isArray(created)) created = created[0]; } catch { created = null; }
    if (!created || !created.id) {
      forgeError('COMMAND_FAILED', 'Failed to create phase bead', 'Check bd connectivity with: bd list --limit 1');
    }

    bdArgs(['dep', 'add', created.id, milestoneId, '--type=parent-child']);
    bdArgs(['label', 'add', created.id, 'forge:phase']);

    if (phases.length > 0) {
      let lastPhase = null;
      let lastNum = 0;
      for (const phase of phases) {
        const match = (phase.title || '').match(/^Phase\s+([\d.]+)/i);
        if (match) {
          const num = parseFloat(match[1]);
          if (num > lastNum) {
            lastNum = num;
            lastPhase = phase;
          }
        }
      }
      if (lastPhase) {
        bdArgs(['dep', 'add', created.id, lastPhase.id]);
      }
    }

    output({
      ok: true,
      phase_id: created.id,
      phase_number: nextNum,
      title,
      description,
      project_id: projectId,
      milestone_id: milestoneId,
      total_phases: phases.length + 1,
    });
  },

  /**
   * Insert a phase after a given phase using decimal numbering.
   */
  'insert-phase'(args) {
    const projectId = args[0];
    const afterPhaseArg = args[1];
    const description = args.slice(2).join(' ');
    if (!projectId || !afterPhaseArg || !description) {
      forgeError('MISSING_ARG', 'Missing required arguments: project-id, after-phase-number, and description', 'Run: forge-tools insert-phase <project-id> <after-phase-number> <description>');
    }
    validateId(projectId);

    const afterPhaseNum = parseInt(afterPhaseArg, 10);
    if (isNaN(afterPhaseNum)) {
      forgeError('INVALID_INPUT', `Invalid phase number: ${afterPhaseArg}`, 'Provide a numeric phase number. List phases with: forge-tools list-phases <project-id>');
    }

    // --- Find phases: try direct children of project first, then search milestone children ---
    let phases = [];
    const directChildren = bdJsonArgs(['children', projectId]);
    const directIssues = normalizeChildren(directChildren);
    phases = directIssues.filter(i => (i.labels || []).includes('forge:phase'));

    if (phases.length === 0) {
      // No phases directly under project -- search milestones
      const milestones = directIssues.filter(i => (i.labels || []).includes('forge:milestone'));
      for (const ms of milestones) {
        const msChildren = bdJsonArgs(['children', ms.id]);
        const msIssues = normalizeChildren(msChildren);
        const msPhases = msIssues.filter(i => (i.labels || []).includes('forge:phase'));
        phases = phases.concat(msPhases);
      }
    }

    let targetPhase = null;
    for (const phase of phases) {
      const match = (phase.title || '').match(/^Phase\s+([\d.]+)/i);
      if (match && parseFloat(match[1]) === afterPhaseNum) {
        targetPhase = phase;
        break;
      }
    }

    if (!targetPhase) {
      forgeError('NOT_FOUND', `Phase ${afterPhaseNum} not found in project`, 'List available phases with: forge-tools list-phases <project-id>', { projectId, phaseNumber: afterPhaseNum });
    }

    // --- Auto-detect parent milestone by walking parent-child deps from afterPhase ---
    // direction=down returns the bead's own parent-child dependencies (i.e. its parent).
    let parentId = projectId; // fallback: wire to project if no milestone found
    const parentDeps = bdJsonArgs(['dep', 'list', targetPhase.id, '--direction=down', '--type=parent-child']);
    if (Array.isArray(parentDeps)) {
      for (const dep of parentDeps) {
        const ancestorId = dep.id;
        if (!ancestorId) continue;
        const ancestor = bdJsonArgs(['show', ancestorId]);
        if (ancestor && (ancestor.labels || []).includes('forge:milestone')) {
          parentId = ancestorId;
          break;
        }
      }
    }

    // Re-query phases from the detected parent for accurate sibling enumeration
    if (parentId !== projectId) {
      const parentChildren = bdJsonArgs(['children', parentId]);
      const parentIssues = normalizeChildren(parentChildren);
      phases = parentIssues.filter(i => (i.labels || []).includes('forge:phase'));
    }

    let maxDecimal = 0;
    for (const phase of phases) {
      const match = (phase.title || '').match(/^Phase\s+([\d.]+)/i);
      if (match) {
        const num = parseFloat(match[1]);
        if (num > afterPhaseNum && num < afterPhaseNum + 1) {
          const decPart = Math.round((num - afterPhaseNum) * 10);
          if (decPart > maxDecimal) maxDecimal = decPart;
        }
      }
    }
    const nextDecimal = maxDecimal + 1;
    const phaseNum = `${afterPhaseNum}.${nextDecimal}`;
    const title = `Phase ${phaseNum}: ${description}`;

    const createRaw = bdArgs(['create', `--title=${title}`, `--description=${description}`, '--type=epic', '--priority=1', '--json']);
    let created;
    // INTENTIONALLY SILENT: bd create output format varies; fallback to null triggers
    // the forgeError below which provides an actionable suggestion.
    try { created = JSON.parse(createRaw); if (Array.isArray(created)) created = created[0]; } catch { created = null; }
    if (!created || !created.id) {
      forgeError('COMMAND_FAILED', 'Failed to create phase bead', 'Check bd connectivity with: bd list --limit 1');
    }

    bdArgs(['dep', 'add', created.id, parentId, '--type=parent-child']);
    bdArgs(['label', 'add', created.id, 'forge:phase']);
    bdArgs(['dep', 'add', created.id, targetPhase.id]);

    const nextPhaseNum = afterPhaseNum + 1;
    let nextPhase = null;
    for (const phase of phases) {
      const match = (phase.title || '').match(/^Phase\s+([\d.]+)/i);
      if (match && parseFloat(match[1]) === nextPhaseNum) {
        nextPhase = phase;
        break;
      }
    }

    if (nextPhase) {
      bdArgs(['dep', 'remove', nextPhase.id, targetPhase.id], { allowFail: true });
      bdArgs(['dep', 'add', nextPhase.id, created.id]);
    }

    output({
      ok: true,
      phase_id: created.id,
      phase_number: phaseNum,
      after_phase: afterPhaseNum,
      title,
      description,
      project_id: projectId,
      milestone_id: parentId !== projectId ? parentId : null,
      rewired_next: nextPhase ? { id: nextPhase.id, title: nextPhase.title } : null,
    });
  },

  /**
   * Remove a phase and renumber subsequent phases.
   */
  'remove-phase'(args) {
    const projectId = args[0];
    const phaseNumArg = args[1];
    const force = args.includes('--force');
    if (!projectId || !phaseNumArg) {
      forgeError('MISSING_ARG', 'Missing required arguments: project-id and phase-number', 'Run: forge-tools remove-phase <project-id> <phase-number> [--force]');
    }
    validateId(projectId);

    const phaseNum = parseFloat(phaseNumArg);
    if (isNaN(phaseNum)) {
      forgeError('INVALID_INPUT', `Invalid phase number: ${phaseNumArg}`, 'Provide a numeric phase number. List phases with: forge-tools list-phases <project-id>');
    }

    const children = bdJsonArgs(['children', projectId]);
    const issues = normalizeChildren(children);
    const phases = issues.filter(i => (i.labels || []).includes('forge:phase'));

    let targetPhase = null;
    for (const phase of phases) {
      const match = (phase.title || '').match(/^Phase\s+([\d.]+)/i);
      if (match && parseFloat(match[1]) === phaseNum) {
        targetPhase = phase;
        break;
      }
    }

    if (!targetPhase) {
      forgeError('NOT_FOUND', `Phase ${phaseNum} not found in project`, 'List available phases with: forge-tools list-phases <project-id>', { projectId, phaseNumber: phaseNum });
    }

    if ((targetPhase.status === 'in_progress' || targetPhase.status === 'closed') && !force) {
      forgeError('INVALID_STATE', `Phase ${phaseNum} is ${targetPhase.status}`, 'Use --force flag to remove anyway: forge-tools remove-phase <project-id> <phase-number> --force', { phaseNumber: phaseNum, status: targetPhase.status });
    }

    const phaseChildren = bdJsonArgs(['children', targetPhase.id]);
    const tasks = normalizeChildren(phaseChildren);
    if (tasks.length > 0 && !force) {
      forgeError('INVALID_STATE', `Phase ${phaseNum} has ${tasks.length} tasks`, 'Use --force flag to remove anyway: forge-tools remove-phase <project-id> <phase-number> --force', { phaseNumber: phaseNum, taskCount: tasks.length });
    }

    const targetDepsRaw = bdArgs(['dep', 'list', targetPhase.id, '--json'], { allowFail: true });
    let targetDeps = [];
    if (targetDepsRaw) {
      // INTENTIONALLY SILENT: bd dep list may return non-JSON when no deps exist.
      try { targetDeps = JSON.parse(targetDepsRaw); } catch { /* allowFail JSON parse fallback */ }
    }
    if (!Array.isArray(targetDeps)) targetDeps = [];

    const predecessorDep = targetDeps.find(d => {
      const depId = d.dependency_id || d.id || d;
      const depPhase = phases.find(p => p.id === depId);
      return depPhase && (depPhase.labels || []).includes('forge:phase');
    });
    const predecessorId = predecessorDep ? (predecessorDep.dependency_id || predecessorDep.id || predecessorDep) : null;

    // TODO(perf): N+1 subprocess -- calls bd dep list per phase to find successors. Needs bd CLI batch-query support.
    const successors = [];
    for (const phase of phases) {
      if (phase.id === targetPhase.id) continue;
      const depsRaw = bdArgs(['dep', 'list', phase.id, '--json'], { allowFail: true });
      let deps = [];
      if (depsRaw) {
        // INTENTIONALLY SILENT: bd dep list may return non-JSON when no deps exist.
        try { deps = JSON.parse(depsRaw); } catch { /* allowFail JSON parse fallback */ }
      }
      if (!Array.isArray(deps)) deps = [];
      const dependsOnTarget = deps.some(d => {
        const depId = d.dependency_id || d.id || d;
        return depId === targetPhase.id;
      });
      if (dependsOnTarget) {
        successors.push(phase);
      }
    }

    for (const successor of successors) {
      bdArgs(['dep', 'remove', successor.id, targetPhase.id], { allowFail: true });
      if (predecessorId) {
        bdArgs(['dep', 'add', successor.id, predecessorId]);
      }
    }

    bdArgs(['close', targetPhase.id, '--reason=removed-from-roadmap']);

    for (const task of tasks) {
      bdArgs(['close', task.id, '--reason=parent-phase-removed'], { allowFail: true });
    }

    const isInteger = Number.isInteger(phaseNum);
    const renumbered = [];

    if (isInteger) {
      const toRenumber = [];
      for (const phase of phases) {
        if (phase.id === targetPhase.id) continue;
        const match = (phase.title || '').match(/^Phase\s+(\d+)(?:\.(\d+))?:\s*(.*)$/i);
        if (match) {
          const num = parseInt(match[1], 10);
          const decimal = match[2] ? parseInt(match[2], 10) : null;
          const rest = match[3];
          if (num > phaseNum) {
            toRenumber.push({ phase, num, decimal, rest });
          }
        }
      }

      for (const item of toRenumber) {
        const newNum = item.decimal !== null
          ? `${item.num - 1}.${item.decimal}`
          : `${item.num - 1}`;
        const newTitle = `Phase ${newNum}: ${item.rest}`;
        bdArgs(['update', item.phase.id, `--title=${newTitle}`]);
        renumbered.push({ id: item.phase.id, old_title: item.phase.title, new_title: newTitle });
      }
    }

    output({
      ok: true,
      removed: { id: targetPhase.id, title: targetPhase.title, phase_number: phaseNum },
      tasks_closed: tasks.length,
      rewired: {
        predecessor: predecessorId,
        successors: successors.map(s => ({ id: s.id, title: s.title })),
      },
      renumbered,
      remaining_phases: phases.length - 1,
    });
  },

  /**
   * List phases with their numbers for phase management commands.
   */
  'list-phases'(args) {
    const projectId = args[0];
    if (!projectId) {
      forgeError('MISSING_ARG', 'Missing required argument: project-id', 'Run: forge-tools list-phases <project-id>');
    }
    validateId(projectId);

    const children = bdJsonArgs(['children', projectId]);
    const issues = normalizeChildren(children);
    const phases = issues.filter(i => (i.labels || []).includes('forge:phase'));

    const parsed = phases.map(p => {
      const match = (p.title || '').match(/^Phase\s+([\d.]+)/i);
      return {
        id: p.id,
        title: p.title,
        status: p.status,
        phase_number: match ? parseFloat(match[1]) : 999,
      };
    }).sort((a, b) => a.phase_number - b.phase_number);

    output({
      project_id: projectId,
      phases: parsed,
      total: parsed.length,
    });
  },

  /**
   * Resolve a phase bead by project ID and phase number.
   */
  'resolve-phase'(args) {
    const projectId = args[0];
    const phaseNumber = args[1];
    if (!projectId || !phaseNumber) {
      forgeError('MISSING_ARG', 'Missing required arguments: project-id and phase-number', 'Run: forge-tools resolve-phase <project-id> <phase-number>');
    }
    validateId(projectId);

    const num = parseInt(phaseNumber, 10);
    if (isNaN(num)) {
      forgeError('INVALID_INPUT', `Invalid phase number: ${phaseNumber}`, 'Provide a numeric phase number. List phases with: forge-tools list-phases <project-id>');
    }

    const children = bdJsonArgs(['children', projectId]);
    if (!children) {
      output({ found: false, phase: null, suggestion: 'No phases found for this project. Run /forge:plan to create phases, or verify the project ID with: bd show ' + projectId });
      return;
    }

    const issues = normalizeChildren(children);
    const phases = issues.filter(i =>
      (i.labels || []).includes('forge:phase') && i.id !== projectId
    );

    const numbered = phases.map((p, idx) => {
      const match = (p.title || '').match(/^Phase\s+(\d+)\b/i);
      return { phase: p, n: match ? parseInt(match[1], 10) : idx + 1 };
    });

    const found = numbered.find(entry => entry.n === num);
    if (found) {
      output({ found: true, phase: found.phase });
    } else {
      const availableNums = numbered.map(e => e.n).join(', ');
      output({ found: false, phase: null, available: numbered.map(e => ({ n: e.n, id: e.phase.id, title: e.phase.title })), suggestion: 'Phase ' + num + ' does not exist. Available phase numbers: ' + availableNums + '. Use one of these with: forge-tools resolve-phase ' + projectId + ' <number>' });
    }
  },

  /**
   * Write structured agent context to a phase bead as a JSON comment.
   */
  'context-write'(args) {
    const phaseId = args[0];
    const jsonStr = args.slice(1).join(' ');
    if (!phaseId || !jsonStr) {
      forgeError('MISSING_ARG', 'Missing required arguments: phase-id and json-string', 'Run: forge-tools context-write <phase-id> <json-string>');
    }
    validateId(phaseId);

    let ctx;
    try {
      ctx = JSON.parse(jsonStr);
    } catch {
      forgeError('INVALID_INPUT', 'Invalid JSON input', 'Provide valid JSON with at least "agent" and "status" fields');
    }

    if (!ctx.agent || !ctx.status) {
      forgeError('INVALID_INPUT', 'Missing required fields: agent and status', 'JSON must include "agent" and "status" fields, e.g. {"agent":"forge-executor","status":"completed"}');
    }
    if (ctx.agent.length > 128 || ctx.status.length > 128) {
      forgeError('INVALID_INPUT', 'Fields "agent" and "status" must not exceed 128 characters', 'Shorten the agent or status value to 128 characters or fewer');
    }

    const schema = {
      agent: ctx.agent,
      task: ctx.task || null,
      status: ctx.status,
      findings: ctx.findings || [],
      decisions: ctx.decisions || [],
      blockers: ctx.blockers || [],
      artifacts: ctx.artifacts || [],
      next_steps: ctx.next_steps || [],
      timestamp: new Date().toISOString(),
    };

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-'));
    const tmpFile = path.join(tmpDir, 'ctx.json');
    fs.writeFileSync(tmpFile, JSON.stringify(schema, null, 2));

    try {
      bdArgs(['comments', 'add', phaseId, '-f', tmpFile]);
      output({ written: true, phase_id: phaseId, agent: schema.agent, task: schema.task });
    } finally {
      // INTENTIONALLY SILENT: temp file/dir cleanup is best-effort; failure to remove
      // a /tmp entry does not affect the command's result.
      try { fs.unlinkSync(tmpFile); } catch { /* cleanup best-effort */ }
      try { fs.rmdirSync(tmpDir); } catch { /* cleanup best-effort */ }
    }
  },

  /**
   * Read all structured JSON context comments from a phase bead.
   */
  'context-read'(args) {
    const phaseId = args[0];
    if (!phaseId) {
      forgeError('MISSING_ARG', 'Missing required argument: phase-id', 'Run: forge-tools context-read <phase-id>');
    }
    validateId(phaseId);

    // All structured context entries (any agent, must have a status field)
    const contexts = readAgentContextEntries(phaseId).filter(e => e.status);

    output({ phase_id: phaseId, contexts });
  },

  /**
   * Query retrospective data from all closed phases under a project.
   * Aggregates findings from forge-verifier context entries into a structured summary.
   */
  'retro-query'(args) {
    const projectId = args[0];
    if (!projectId) {
      forgeError('MISSING_ARG', 'Missing required argument: project-id', 'Run: forge-tools retro-query <project-id>');
    }
    validateId(projectId);

    // Two-level traversal: project -> milestones -> phases (milestone hierarchy from Phase 9.1)
    const children = bdJsonArgs(['children', projectId]);
    const issues = normalizeChildren(children);
    const milestones = issues.filter(i => (i.labels || []).includes('forge:milestone'));
    const allIssues = [];
    const seenIds = new Set();
    const addIssues = (items) => {
      for (const i of items) {
        if (seenIds.has(i.id)) continue;
        seenIds.add(i.id);
        allIssues.push(i);
      }
    };
    for (const ms of milestones) {
      const msChildren = bdJsonArgs(['children', ms.id]);
      const msIssues = normalizeChildren(msChildren);
      addIssues(msIssues);
    }
    addIssues(issues); // Also collect legacy direct children
    const phases = allIssues.filter(i =>
      (i.labels || []).includes('forge:phase') && i.status === 'closed'
    );

    const lessons = [];
    const pitfallFlags = [];
    const effectivenessRatings = {};
    let phaseCount = 0;

    // TODO(perf): N+1 subprocess -- calls bd comments per closed phase. Needs bd CLI batch-query support.
    for (const phase of phases) {
      const comments = bdJsonArgs(['comments', phase.id]);
      if (!comments) continue;

      const list = Array.isArray(comments) ? comments : (comments.comments || []);
      let hasRetro = false;

      for (const c of list) {
        const body = c.body || c.content || c.text || '';
        let parsed;
        try {
          parsed = JSON.parse(body);
        } catch {
          // INTENTIONALLY SILENT: non-JSON comments are skipped when scanning
          // for structured forge-verifier context entries.
          continue;
        }

        if (parsed.agent !== 'forge-verifier' || parsed.status !== 'completed') continue;
        hasRetro = true;

        // Extract lessons from findings and decisions
        for (const f of (parsed.findings || [])) {
          lessons.push({ phase_id: phase.id, phase_title: phase.title, lesson: f });
        }
        for (const d of (parsed.decisions || [])) {
          lessons.push({ phase_id: phase.id, phase_title: phase.title, lesson: d });
        }

        // Extract pitfalls from blockers
        for (const b of (parsed.blockers || [])) {
          pitfallFlags.push({ phase_id: phase.id, phase_title: phase.title, pitfall: b });
        }

        // Build effectiveness rating from available data
        const findingsCount = (parsed.findings || []).length;
        const blockersCount = (parsed.blockers || []).length;
        effectivenessRatings[phase.id] = {
          phase_title: phase.title,
          findings: findingsCount,
          blockers: blockersCount,
          rating: blockersCount === 0 ? 'clean' : blockersCount <= 2 ? 'minor_issues' : 'significant_issues',
        };
      }

      if (hasRetro) phaseCount++;
    }

    output({
      project_id: projectId,
      phase_count: phaseCount,
      lessons,
      pitfall_flags: pitfallFlags,
      effectiveness_ratings: effectivenessRatings,
    });
  },

  /**
   * Detect build and test commands for the current project.
   * Returns deterministic JSON describing build/test commands.
   */
  'detect-build-test'(_args) {
    const result = detectBuildTest();
    output(result);
  },

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

    output({ ...data, waves });
  },
};
