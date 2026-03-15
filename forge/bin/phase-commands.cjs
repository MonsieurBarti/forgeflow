'use strict';

/**
 * phase-commands.cjs -- Phase-related forge-tools commands.
 *
 * Commands: phase-context, phase-ready, plan-check, preflight-check,
 *           detect-waves, checkpoint-save, checkpoint-load, verify-phase,
 *           add-phase, insert-phase, remove-phase, list-phases,
 *           resolve-phase, context-write, context-read, retro-query
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const os = require('os');
const {
  bdArgs, bdJsonArgs, output, forgeError, validateId, normalizeChildren,
} = require('./core.cjs');

/**
 * Collect all forge:req beads from a milestone using 3-level traversal:
 *   milestone -> phases (forge:phase children) -> each phase's children filtered for forge:req
 *
 * Also includes legacy fallback: any forge:req beads that are direct children
 * of the milestone (old data where reqs lived under the milestone directly).
 *
 * @param {string} milestoneId  The milestone bead ID
 * @returns {Array} Deduplicated array of requirement beads
 */
function collectMilestoneRequirements(milestoneId) {
  const milestoneChildren = bdJsonArgs(['children', milestoneId]);
  const allMilestoneIssues = normalizeChildren(milestoneChildren);

  const seenIds = new Set();
  const requirements = [];

  const addReq = (req) => {
    if (seenIds.has(req.id)) return;
    seenIds.add(req.id);
    requirements.push(req);
  };

  // 3-level traversal: milestone -> phases -> phase children filtered for forge:req
  const phases = allMilestoneIssues.filter(i =>
    (i.labels || []).includes('forge:phase')
  );
  for (const phase of phases) {
    const phaseChildren = bdJsonArgs(['children', phase.id]);
    const phaseIssues = normalizeChildren(phaseChildren);
    for (const issue of phaseIssues) {
      if ((issue.labels || []).includes('forge:req')) {
        addReq(issue);
      }
    }
  }

  // Legacy fallback: direct milestone children with forge:req label
  for (const issue of allMilestoneIssues) {
    if ((issue.labels || []).includes('forge:req')) {
      addReq(issue);
    }
  }

  return requirements;
}

module.exports = {
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

    // Build taskById Map before the dep loop for O(1) lookups
    const taskById = new Map(tasks.map(t => [t.id, t]));

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

    // Kahn's algorithm: O(V+E) topological sort into dependency waves
    const inDegree = {};
    const dependents = {}; // taskId -> list of tasks that depend on it
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
        tasks: currentWave.map(t => ({
          id: t.id,
          title: t.title,
          status: t.status,
        })),
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
        tasks: remaining.map(t => ({
          id: t.id,
          title: t.title,
          status: t.status,
          blocked_by: taskDeps[t.id] || [],
        })),
        note: 'circular_or_external_dependency',
      });
    }

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

    // Allowlist: only spread known-safe checkpoint fields to prevent
    // arbitrary external data from being written to bead notes.
    const CHECKPOINT_ALLOWLIST = [
      'phaseId', 'phase_id', 'completedWaves', 'currentWave', 'taskStatuses',
      'preExistingClosed', 'branchName', 'baseCommitSha', 'timestamp', 'completed',
    ];
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

    output(checkpoint);
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

    const children = bdJsonArgs(['children', projectId]);
    const issues = normalizeChildren(children);
    const phases = issues.filter(i => (i.labels || []).includes('forge:phase'));

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

    bdArgs(['dep', 'add', created.id, projectId, '--type=parent-child']);
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

    const comments = bdJsonArgs(['comments', phaseId]);
    if (!comments) {
      output({ phase_id: phaseId, contexts: [] });
      return;
    }

    const list = Array.isArray(comments) ? comments : (comments.comments || []);
    const contexts = [];

    for (const c of list) {
      const body = c.body || c.content || c.text || '';
      try {
        const parsed = JSON.parse(body);
        if (parsed.agent && parsed.status) {
          contexts.push(parsed);
        }
      } catch {
        // INTENTIONALLY SILENT: comments can be free-text (not JSON); skipping
        // non-JSON comments is the expected behavior when filtering for context entries.
      }
    }

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
};
