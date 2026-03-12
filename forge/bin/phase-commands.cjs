'use strict';

/**
 * phase-commands.cjs -- Phase-related forge-tools commands.
 *
 * Commands: phase-context, phase-ready, plan-check, preflight-check,
 *           detect-waves, checkpoint-save, checkpoint-load, verify-phase,
 *           add-phase, insert-phase, remove-phase, list-phases,
 *           resolve-phase, context-write, context-read
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const {
  bd, bdArgs, bdJson, output,
} = require('./core.cjs');

module.exports = {
  /**
   * Get phase context: phase details + all tasks + their statuses.
   */
  'phase-context'(args) {
    const phaseId = args[0];
    if (!phaseId) {
      console.error('Usage: forge-tools phase-context <phase-bead-id>');
      process.exit(1);
    }

    const phaseRaw = bdJson(`show ${phaseId}`);
    const phase = Array.isArray(phaseRaw) ? phaseRaw[0] : phaseRaw;
    const children = bdJson(`children ${phaseId}`);
    const tasks = Array.isArray(children) ? children : (children?.issues || children?.children || []);

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
      console.error('Usage: forge-tools phase-ready <phase-bead-id>');
      process.exit(1);
    }

    const children = bdJson(`children ${phaseId}`);
    const tasks = Array.isArray(children) ? children : (children?.issues || children?.children || []);

    const ready = tasks.filter(t => t.status === 'open');
    output({ phase_id: phaseId, ready_tasks: ready });
  },

  /**
   * Validate a phase plan: check acceptance criteria, labels, requirement coverage.
   */
  'plan-check'(args) {
    const phaseId = args[0];
    if (!phaseId) {
      console.error('Usage: forge-tools plan-check <phase-bead-id>');
      process.exit(1);
    }

    const phase = bdJson(`show ${phaseId}`);
    const children = bdJson(`children ${phaseId}`);
    const tasks = Array.isArray(children) ? children : (children?.issues || children?.children || []);

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
        fix: `Run: bd update <task-id> --acceptance_criteria="<specific, testable criteria>" for each task listed above.`,
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
    const parentId = phase?.parent || null;
    let uncoveredReqs = [];
    if (parentId) {
      const projectChildren = bdJson(`children ${parentId}`);
      const allIssues = Array.isArray(projectChildren)
        ? projectChildren
        : (projectChildren?.issues || projectChildren?.children || []);
      const requirements = allIssues.filter(i =>
        (i.labels || []).includes('forge:req')
      );

      for (const req of requirements) {
        const depsRaw = bd(`dep list ${req.id} --type validates --json`, { allowFail: true });
        let deps = [];
        if (depsRaw) {
          try { deps = JSON.parse(depsRaw); } catch { /* ignore */ }
        }
        if (!Array.isArray(deps) || deps.length === 0) {
          uncoveredReqs.push({ id: req.id, title: req.title });
        }
      }

      if (uncoveredReqs.length > 0) {
        const reqList = uncoveredReqs.map(r => `${r.id} (${r.title})`).join(', ');
        findings.push({
          number: findings.length + 1,
          severity: 'suggestion',
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
      console.error('Usage: forge-tools preflight-check <phase-bead-id>');
      process.exit(1);
    }

    const phase = bdJson(`show ${phaseId}`);
    const children = bdJson(`children ${phaseId}`);
    const tasks = Array.isArray(children) ? children : (children?.issues || children?.children || []);

    const issues = [];

    const depsRaw = bd(`dep list ${phaseId} --json`, { allowFail: true });
    let deps = [];
    if (depsRaw) {
      try { deps = JSON.parse(depsRaw); } catch { /* ignore */ }
    }
    const blockerDeps = Array.isArray(deps)
      ? deps.filter(d => d.type === 'blocks' || d.type === 'predecessor' || d.type === 'blocked-by')
      : [];
    const openBlockers = [];
    for (const dep of blockerDeps) {
      const blockerId = dep.from || dep.source || dep.id;
      if (!blockerId || blockerId === phaseId) continue;
      const blocker = bdJson(`show ${blockerId}`);
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
      console.error('Usage: forge-tools detect-waves <phase-bead-id>');
      process.exit(1);
    }

    const phase = bdJson(`show ${phaseId}`);
    const children = bdJson(`children ${phaseId}`);
    const tasks = Array.isArray(children) ? children : (children?.issues || children?.children || []);

    if (tasks.length === 0) {
      output({ phase_id: phaseId, waves: [], summary: { total_tasks: 0, total_waves: 0 } });
      return;
    }

    const phaseTaskIds = new Set(tasks.map(t => t.id));

    const taskDeps = {};
    for (const task of tasks) {
      const depsRaw = bd(`dep list ${task.id} --type blocks --json`, { allowFail: true });
      let deps = [];
      if (depsRaw) {
        try { deps = JSON.parse(depsRaw); } catch { /* ignore */ }
      }
      if (!Array.isArray(deps)) deps = [];
      const intraPhaseDeps = deps
        .filter(d => phaseTaskIds.has(d.id || d.dependency_id || d))
        .map(d => d.id || d.dependency_id || d)
        .filter(id => {
          const depTask = tasks.find(t => t.id === id);
          return depTask && depTask.status !== 'closed';
        });
      taskDeps[task.id] = intraPhaseDeps;
    }

    const waves = [];
    const assigned = new Set();

    while (assigned.size < tasks.length) {
      const wave = [];
      for (const task of tasks) {
        if (assigned.has(task.id)) continue;
        const unmetDeps = (taskDeps[task.id] || []).filter(d => !assigned.has(d));
        if (unmetDeps.length === 0) {
          wave.push(task);
        }
      }

      if (wave.length === 0) {
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
        break;
      }

      waves.push({
        wave_number: waves.length + 1,
        tasks: wave.map(t => ({
          id: t.id,
          title: t.title,
          status: t.status,
        })),
      });

      for (const t of wave) assigned.add(t.id);
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
      console.error('Usage: forge-tools checkpoint-save <phase-id> <checkpoint-json>');
      process.exit(1);
    }

    let checkpoint;
    try {
      checkpoint = JSON.parse(checkpointArg);
    } catch (err) {
      console.error(`Invalid checkpoint JSON: ${err.message}`);
      process.exit(1);
    }

    if (!checkpoint.timestamp) {
      checkpoint.timestamp = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
    }
    if (!checkpoint.phaseId) {
      checkpoint.phaseId = phaseId;
    }

    const checkpointJson = JSON.stringify(checkpoint);
    const notesValue = `forge:checkpoint ${checkpointJson}`;

    bdArgs(['update', phaseId, '--notes', notesValue], { allowFail: false });

    const memoryKey = `forge:checkpoint:${phaseId}`;
    bdArgs(['remember', '--key', memoryKey, checkpointJson], { allowFail: true });

    output({ saved: true, phaseId, checkpoint });
  },

  /**
   * Load execution checkpoint from phase bead notes.
   */
  'checkpoint-load'(args) {
    const phaseId = args[0];
    if (!phaseId) {
      console.error('Usage: forge-tools checkpoint-load <phase-id>');
      process.exit(1);
    }

    let checkpoint = null;

    try {
      const phaseRaw = bdJson(`show ${phaseId}`);
      const phase = Array.isArray(phaseRaw) ? phaseRaw[0] : phaseRaw;
      const notes = phase?.notes || '';
      const match = notes.match(/forge:checkpoint\s+(\{[\s\S]*\})/);
      if (match) {
        checkpoint = JSON.parse(match[1]);
      }
    } catch { /* corrupt or missing — handled below */ }

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
      } catch { /* ignore */ }
    }

    if (!checkpoint) {
      output({});
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
      console.error('Usage: forge-tools verify-phase <phase-bead-id>');
      process.exit(1);
    }

    const phaseRaw = bdJson(`show ${phaseId}`);
    const phase = Array.isArray(phaseRaw) ? phaseRaw[0] : phaseRaw;
    const children = bdJson(`children ${phaseId}`);
    const tasks = Array.isArray(children) ? children : (children?.issues || children?.children || []);

    const enrichedTasks = tasks.map(task => {
      const raw = bdJson(`show ${task.id}`);
      const full = Array.isArray(raw) ? raw[0] : raw;
      return {
        id: task.id,
        title: task.title || full?.title,
        status: task.status || full?.status,
        acceptance_criteria: full?.acceptance_criteria || '',
        notes: full?.notes || '',
      };
    });

    const closedTasks = enrichedTasks.filter(t => t.status === 'closed');
    const openTasks = enrichedTasks.filter(t => t.status !== 'closed');

    const parentId = phase?.parent || null;
    let requirements = [];
    if (parentId) {
      const projectChildren = bdJson(`children ${parentId}`);
      const allIssues = Array.isArray(projectChildren)
        ? projectChildren
        : (projectChildren?.issues || projectChildren?.children || []);
      requirements = allIssues.filter(i =>
        (i.labels || []).includes('forge:req')
      );
    }

    output({
      phase: { id: phase?.id, title: phase?.title, status: phase?.status, parent: parentId },
      tasks_to_verify: closedTasks,
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
      console.error('Usage: forge-tools add-phase <project-id> <milestone-id> <description>');
      process.exit(1);
    }

    const milestone = bdJson(`show ${milestoneId}`);
    if (!milestone || !milestone.id) {
      console.error(`ERROR: Milestone '${milestoneId}' not found.`);
      process.exit(1);
    }
    if (milestone.status === 'closed') {
      console.error(`ERROR: Milestone '${milestoneId}' is closed. Phases can only be added to active milestones.`);
      process.exit(1);
    }

    const children = bdJson(`children ${milestoneId}`);
    const issues = Array.isArray(children) ? children : (children?.issues || children?.children || []);
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
    try { created = JSON.parse(createRaw); if (Array.isArray(created)) created = created[0]; } catch { created = null; }
    if (!created || !created.id) {
      console.error('Failed to create phase bead');
      process.exit(1);
    }

    bd(`dep add ${created.id} ${milestoneId} --type=parent-child`);
    bd(`label add ${created.id} forge:phase`);

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
        bd(`dep add ${created.id} ${lastPhase.id}`);
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
      console.error('Usage: forge-tools insert-phase <project-id> <after-phase-number> <description>');
      process.exit(1);
    }

    const afterPhaseNum = parseInt(afterPhaseArg, 10);
    if (isNaN(afterPhaseNum)) {
      console.error(`Invalid phase number: ${afterPhaseArg}`);
      process.exit(1);
    }

    const children = bdJson(`children ${projectId}`);
    const issues = Array.isArray(children) ? children : (children?.issues || children?.children || []);
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
      console.error(`Phase ${afterPhaseNum} not found in project`);
      process.exit(1);
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
    try { created = JSON.parse(createRaw); if (Array.isArray(created)) created = created[0]; } catch { created = null; }
    if (!created || !created.id) {
      console.error('Failed to create phase bead');
      process.exit(1);
    }

    bd(`dep add ${created.id} ${projectId} --type=parent-child`);
    bd(`label add ${created.id} forge:phase`);
    bd(`dep add ${created.id} ${targetPhase.id}`);

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
      bd(`dep remove ${nextPhase.id} ${targetPhase.id}`, { allowFail: true });
      bd(`dep add ${nextPhase.id} ${created.id}`);
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
      console.error('Usage: forge-tools remove-phase <project-id> <phase-number> [--force]');
      process.exit(1);
    }

    const phaseNum = parseFloat(phaseNumArg);
    if (isNaN(phaseNum)) {
      console.error(`Invalid phase number: ${phaseNumArg}`);
      process.exit(1);
    }

    const children = bdJson(`children ${projectId}`);
    const issues = Array.isArray(children) ? children : (children?.issues || children?.children || []);
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
      console.error(`Phase ${phaseNum} not found in project`);
      process.exit(1);
    }

    if ((targetPhase.status === 'in_progress' || targetPhase.status === 'closed') && !force) {
      console.error(`Phase ${phaseNum} is ${targetPhase.status}. Use --force to remove anyway.`);
      process.exit(1);
    }

    const phaseChildren = bdJson(`children ${targetPhase.id}`);
    const tasks = Array.isArray(phaseChildren) ? phaseChildren : (phaseChildren?.issues || phaseChildren?.children || []);
    if (tasks.length > 0 && !force) {
      console.error(`Phase ${phaseNum} has ${tasks.length} tasks. Use --force to remove anyway.`);
      process.exit(1);
    }

    const targetDepsRaw = bd(`dep list ${targetPhase.id} --json`, { allowFail: true });
    let targetDeps = [];
    if (targetDepsRaw) {
      try { targetDeps = JSON.parse(targetDepsRaw); } catch { /* ignore */ }
    }
    if (!Array.isArray(targetDeps)) targetDeps = [];

    const predecessorDep = targetDeps.find(d => {
      const depId = d.dependency_id || d.id || d;
      const depPhase = phases.find(p => p.id === depId);
      return depPhase && (depPhase.labels || []).includes('forge:phase');
    });
    const predecessorId = predecessorDep ? (predecessorDep.dependency_id || predecessorDep.id || predecessorDep) : null;

    const successors = [];
    for (const phase of phases) {
      if (phase.id === targetPhase.id) continue;
      const depsRaw = bd(`dep list ${phase.id} --json`, { allowFail: true });
      let deps = [];
      if (depsRaw) {
        try { deps = JSON.parse(depsRaw); } catch { /* ignore */ }
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
      bd(`dep remove ${successor.id} ${targetPhase.id}`, { allowFail: true });
      if (predecessorId) {
        bd(`dep add ${successor.id} ${predecessorId}`);
      }
    }

    bd(`close ${targetPhase.id} --reason="Removed from roadmap"`);

    for (const task of tasks) {
      bd(`close ${task.id} --reason="Parent phase removed"`, { allowFail: true });
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
        bd(`update ${item.phase.id} --title="${newTitle}"`);
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
      console.error('Usage: forge-tools list-phases <project-id>');
      process.exit(1);
    }

    const children = bdJson(`children ${projectId}`);
    const issues = Array.isArray(children) ? children : (children?.issues || children?.children || []);
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
      console.error('Usage: forge-tools resolve-phase <project-id> <phase-number>');
      process.exit(1);
    }

    const num = parseInt(phaseNumber, 10);
    if (isNaN(num)) {
      console.error(`Invalid phase number: ${phaseNumber}`);
      process.exit(1);
    }

    const children = bdJson(`children ${projectId}`);
    if (!children) {
      output({ found: false, phase: null });
      return;
    }

    const issues = Array.isArray(children) ? children : (children.issues || children.children || []);
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
      output({ found: false, phase: null, available: numbered.map(e => ({ n: e.n, id: e.phase.id, title: e.phase.title })) });
    }
  },

  /**
   * Write structured agent context to a phase bead as a JSON comment.
   */
  'context-write'(args) {
    const phaseId = args[0];
    const jsonStr = args.slice(1).join(' ');
    if (!phaseId || !jsonStr) {
      console.error('Usage: forge-tools context-write <phase-id> <json-string>');
      process.exit(1);
    }

    let ctx;
    try {
      ctx = JSON.parse(jsonStr);
    } catch {
      console.error('Invalid JSON input');
      process.exit(1);
    }

    if (!ctx.agent || !ctx.status) {
      console.error('Required fields: agent, status');
      process.exit(1);
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

    const tmpFile = path.join(os.tmpdir(), `forge-ctx-${Date.now()}.json`);
    fs.writeFileSync(tmpFile, JSON.stringify(schema, null, 2));

    try {
      bdArgs(['comments', 'add', phaseId, '-f', tmpFile]);
      output({ written: true, phaseId, agent: schema.agent, task: schema.task });
    } finally {
      try { fs.unlinkSync(tmpFile); } catch {}
    }
  },

  /**
   * Read all structured JSON context comments from a phase bead.
   */
  'context-read'(args) {
    const phaseId = args[0];
    if (!phaseId) {
      console.error('Usage: forge-tools context-read <phase-id>');
      process.exit(1);
    }

    const comments = bdJson(`comments ${phaseId}`);
    if (!comments) {
      output({ phaseId, contexts: [] });
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
        // Not JSON — skip (free-text comment)
      }
    }

    output({ phaseId, contexts });
  },
};
