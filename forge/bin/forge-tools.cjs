#!/usr/bin/env node
'use strict';

/**
 * forge-tools.cjs -- Thin helper that queries beads and formats context for workflows.
 *
 * Unlike GSD's gsd-tools.cjs which does heavy state/roadmap/config CRUD on markdown files,
 * forge-tools delegates most work to `bd` commands. This file mostly:
 * 1. Queries beads and formats results as context JSON for workflows
 * 2. Provides convenience wrappers for common bead patterns
 *
 * Usage: node forge-tools.cjs <command> [args]
 */

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const yaml = require ? null : null; // We'll parse YAML manually (simple subset)

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

function bd(args, opts = {}) {
  const argList = args.split(/\s+/);
  try {
    const result = execFileSync('bd', argList, {
      encoding: 'utf8',
      timeout: 10000,
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
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function output(data) {
  process.stdout.write(JSON.stringify(data, null, 2) + '\n');
}

// --- Commands ---

const commands = {
  /**
   * Get full project context for a workflow.
   * Returns: project epic, requirements, phases (ordered), current state.
   */
  'project-context'(args) {
    const projectId = args[0];
    if (!projectId) {
      console.error('Usage: forge-tools project-context <project-bead-id>');
      process.exit(1);
    }

    const project = bdJson(`show ${projectId}`);
    const children = bdJson(`children ${projectId}`);

    if (!children) {
      output({ project, requirements: [], phases: [], tasks: [] });
      return;
    }

    const issues = Array.isArray(children) ? children : (children.issues || children.children || []);

    const requirements = issues.filter(i =>
      (i.labels || []).includes('forge:req') || i.issue_type === 'feature'
    );
    const phases = issues.filter(i =>
      (i.labels || []).includes('forge:phase') || i.issue_type === 'epic'
    ).filter(i => i.id !== projectId);

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
   * Get phase context: phase details + all tasks + their statuses.
   */
  'phase-context'(args) {
    const phaseId = args[0];
    if (!phaseId) {
      console.error('Usage: forge-tools phase-context <phase-bead-id>');
      process.exit(1);
    }

    const phase = bdJson(`show ${phaseId}`);
    const children = bdJson(`children ${phaseId}`);
    const tasks = Array.isArray(children) ? children : (children?.issues || children?.children || []);

    const ready = tasks.filter(t => t.status === 'open');
    const inProgress = tasks.filter(t => t.status === 'in_progress');
    const done = tasks.filter(t => t.status === 'closed');

    output({
      phase,
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
   * Get progress summary for a project.
   */
  progress(args) {
    const projectId = args[0];
    if (!projectId) {
      console.error('Usage: forge-tools progress <project-bead-id>');
      process.exit(1);
    }

    const project = bdJson(`show ${projectId}`);
    const children = bdJson(`children ${projectId}`);
    const issues = Array.isArray(children) ? children : (children?.issues || children?.children || []);

    const phases = issues.filter(i =>
      (i.labels || []).includes('forge:phase')
    );

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
   * Validate a phase plan: check acceptance criteria, requirement coverage,
   * task labels, and parent-child links.
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

    const issues = [];
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
      issues.push({
        type: 'missing_acceptance_criteria',
        severity: 'error',
        tasks: tasksWithoutCriteria,
      });
    }

    if (tasksWithoutLabel.length > 0) {
      issues.push({
        type: 'missing_forge_task_label',
        severity: 'warning',
        tasks: tasksWithoutLabel,
      });
    }

    // Check requirement coverage via validates deps
    // Find the parent project to get requirements
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

      // Check which requirements have validates links from any task
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
        issues.push({
          type: 'uncovered_requirements',
          severity: 'warning',
          requirements: uncoveredReqs,
        });
      }
    }

    const passed = issues.filter(i => i.severity === 'error').length === 0;

    output({
      phase_id: phaseId,
      phase_title: phase?.title,
      total_tasks: tasks.length,
      verdict: passed ? 'PASS' : 'NEEDS_REVISION',
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
   * Detect dependency waves for phase execution.
   * Groups tasks into waves based on intra-phase blocking dependencies.
   * Wave 1: tasks with no intra-phase blockers
   * Wave 2: tasks that only depend on wave 1 tasks
   * Wave N: tasks that only depend on wave 1..N-1 tasks
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

    // Build set of task IDs in this phase
    const phaseTaskIds = new Set(tasks.map(t => t.id));

    // For each task, find its intra-phase blocking dependencies
    const taskDeps = {};
    for (const task of tasks) {
      const depsRaw = bd(`dep list ${task.id} --type blocks --json`, { allowFail: true });
      let deps = [];
      if (depsRaw) {
        try { deps = JSON.parse(depsRaw); } catch { /* ignore */ }
      }
      if (!Array.isArray(deps)) deps = [];
      // Only keep dependencies that are within this phase and still open
      const intraPhaseDeps = deps
        .filter(d => phaseTaskIds.has(d.id || d.dependency_id || d))
        .map(d => d.id || d.dependency_id || d)
        .filter(id => {
          const depTask = tasks.find(t => t.id === id);
          return depTask && depTask.status !== 'closed';
        });
      taskDeps[task.id] = intraPhaseDeps;
    }

    // Topological wave assignment
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
        // Circular dependency or all remaining tasks are blocked
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

    // Separate executable vs already-done tasks
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
   * Get comprehensive progress with per-phase task breakdowns for the dashboard.
   */
  'full-progress'(args) {
    const projectId = args[0];
    if (!projectId) {
      console.error('Usage: forge-tools full-progress <project-bead-id>');
      process.exit(1);
    }

    const project = bdJson(`show ${projectId}`);
    const children = bdJson(`children ${projectId}`);
    const issues = Array.isArray(children) ? children : (children?.issues || children?.children || []);

    const requirements = issues.filter(i =>
      (i.labels || []).includes('forge:req') || i.issue_type === 'feature'
    );
    const phases = issues.filter(i =>
      (i.labels || []).includes('forge:phase')
    );

    // Get task-level detail for each phase
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

    // Check requirement coverage
    const reqCoverage = [];
    for (const req of requirements) {
      const depsRaw = bd(`dep list ${req.id} --type validates --json`, { allowFail: true });
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

    // Get recent decisions
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
   * Save session state for forge:pause.
   * Captures current phase, in-progress tasks, and notes into bd remember.
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

    // Find in-progress tasks across all phases
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

    // Save structured session state
    const memoryKey = `forge:session:state`;
    const memoryValue = `${timestamp} project=${projectId} phase=${sessionData.current_phase || 'none'} progress=${completedPhases}/${phases.length} in_flight=${inProgressTasks.map(t => t.id).join(',')}`;
    bd(`remember "${memoryKey} ${memoryValue}"`);

    output({ saved: true, session: sessionData });
  },

  /**
   * Load session state for forge:resume.
   * Retrieves saved session state and current project/phase context.
   */
  'load-session'(args) {
    // Get saved session memories
    const memories = bd('memories forge:session', { allowFail: true });

    // Find project
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

    // Get current state
    const children = bdJson(`children ${project.id}`);
    const issues = Array.isArray(children) ? children : (children?.issues || children?.children || []);
    const phases = issues.filter(i => (i.labels || []).includes('forge:phase'));
    const currentPhase = phases.find(p => p.status === 'in_progress') || phases.find(p => p.status === 'open');

    // Get in-progress tasks
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
   * Get phase tasks with acceptance criteria for verification.
   */
  'verify-phase'(args) {
    const phaseId = args[0];
    if (!phaseId) {
      console.error('Usage: forge-tools verify-phase <phase-bead-id>');
      process.exit(1);
    }

    const phase = bdJson(`show ${phaseId}`);
    const children = bdJson(`children ${phaseId}`);
    const tasks = Array.isArray(children) ? children : (children?.issues || children?.children || []);

    // Enrich tasks with full details (acceptance_criteria, etc.)
    const enrichedTasks = tasks.map(task => {
      const full = bdJson(`show ${task.id}`);
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

    // Get parent project for requirement coverage check
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
   * Get a Forge config value via bd kv.
   * All Forge config keys are prefixed with "forge.".
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
    // Normalize: bd kv list may return {key:value} object or [{key,value}] array
    if (Array.isArray(kvMap)) {
      const obj = {};
      for (const item of kvMap) obj[item.key] = item.value;
      kvMap = obj;
    }
    // Filter to forge.* keys and convert to array format
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
   * Resolve the model for a given agent role.
   * Resolution order:
   *   1. Per-project override: .forge/settings.yaml models.<role>
   *   2. Global role default: ~/.claude/forge.local.md models.<role>
   *   3. Global fallback: models.default from either layer
   *   4. null (use Claude Code default)
   *
   * Usage: forge-tools model-for-role <role>
   * Roles: researcher, planner, executor, verifier, plan_checker, roadmapper
   */
  'model-for-role'(args) {
    const role = args[0];
    if (!role) {
      console.error('Usage: forge-tools model-for-role <role>');
      process.exit(1);
    }

    // Load models from both layers
    let globalModels = {};
    try {
      const text = fs.readFileSync(GLOBAL_SETTINGS_PATH, 'utf8');
      const parsed = parseFrontmatter(text);
      globalModels = (parsed.models && typeof parsed.models === 'object') ? parsed.models : {};
    } catch { /* no global settings */ }

    let projectModels = {};
    try {
      const projectPath = path.resolve(process.cwd(), PROJECT_SETTINGS_NAME);
      const parsed = parseSimpleYaml(fs.readFileSync(projectPath, 'utf8'));
      projectModels = (parsed.models && typeof parsed.models === 'object') ? parsed.models : {};
    } catch { /* no project settings */ }

    let model = null;
    let source = null;

    // 1. Per-project role override
    if (projectModels[role]) {
      model = projectModels[role];
      source = 'project';
    }

    // 2. Global role default
    if (!model && globalModels[role]) {
      model = globalModels[role];
      source = 'global';
    }

    // 3. Fallback: project default, then global default
    if (!model && projectModels['default']) {
      model = projectModels['default'];
      source = 'project:default';
    }
    if (!model && globalModels['default']) {
      model = globalModels['default'];
      source = 'global:default';
    }

    output({ role, model, source });
  },

  /**
   * Show all configured model profiles.
   * Reads from ~/.claude/forge.local.md (global) and .forge/settings.yaml (project).
   */
  'model-profiles'() {
    const roles = ['researcher', 'planner', 'executor', 'verifier', 'plan_checker', 'roadmapper'];

    let globalModels = {};
    try {
      const text = fs.readFileSync(GLOBAL_SETTINGS_PATH, 'utf8');
      const parsed = parseFrontmatter(text);
      globalModels = (parsed.models && typeof parsed.models === 'object') ? parsed.models : {};
    } catch { /* no global settings */ }

    let projectModels = {};
    try {
      const projectPath = path.resolve(process.cwd(), PROJECT_SETTINGS_NAME);
      const parsed = parseSimpleYaml(fs.readFileSync(projectPath, 'utf8'));
      projectModels = (parsed.models && typeof parsed.models === 'object') ? parsed.models : {};
    } catch { /* no project settings */ }

    // Build effective model per role
    const effective = {};
    for (const role of roles) {
      let model = null;
      let source = null;

      if (projectModels[role]) {
        model = projectModels[role];
        source = 'project';
      } else if (globalModels[role]) {
        model = globalModels[role];
        source = 'global';
      } else if (projectModels['default']) {
        model = projectModels['default'];
        source = 'project:default';
      } else if (globalModels['default']) {
        model = globalModels['default'];
        source = 'global:default';
      }

      effective[role] = { model, source };
    }

    output({
      effective,
      global_models: globalModels,
      project_models: projectModels,
      global_path: GLOBAL_SETTINGS_PATH,
      project_path: path.resolve(process.cwd(), PROJECT_SETTINGS_NAME),
      roles,
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
   * Diagnose project health: structural, dependency, and state issues.
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

    // --- Structure checks ---

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

    // Check tasks within each phase
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

    // --- Dependency checks ---

    const uncoveredReqs = [];
    for (const req of requirements) {
      const deps = bd(`dep list ${req.id} --type validates`, { allowFail: true });
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

    // --- State checks ---

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

    // --- Config checks (bd kv + .forge/settings.yaml) ---

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

    // Check .forge/settings.yaml project config
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

    // Check global settings (~/.claude/forge.local.md)
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

    // --- Installation checks (~/.claude/forge/) ---

    const forgeDir = path.join(os.homedir(), '.claude', 'forge');

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

    // --- Summary ---

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
   * Returns the effective settings with source annotations.
   */
  'settings-load'() {
    const merged = { ...SETTINGS_DEFAULTS };
    const sources = {};
    for (const key of Object.keys(SETTINGS_DEFAULTS)) {
      sources[key] = 'default';
    }

    // Layer 1: Global settings from ~/.claude/forge.local.md
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

    // Layer 2: Project settings from .forge/settings.yaml
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
    const scope = args[0]; // "global" or "project"
    const key = args[1];
    const value = args[2];

    if (!scope || !key || value === undefined) {
      console.error('Usage: forge-tools settings-set <global|project> <key> <value>');
      process.exit(1);
    }

    // Support dotted keys for nested sections (e.g., models.researcher)
    const dotIdx = key.indexOf('.');
    const isNested = dotIdx !== -1;
    const topKey = isNested ? key.slice(0, dotIdx) : key;
    const subKey = isNested ? key.slice(dotIdx + 1) : null;

    if (!isNested && !(topKey in SETTINGS_DEFAULTS)) {
      console.error(`Unknown setting: ${key}`);
      console.error(`Available: ${Object.keys(SETTINGS_DEFAULTS).join(', ')}, models.<role>`);
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
   * Clear a setting from a scope (reverts to lower layer or default).
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
   * Usage: forge-tools settings-bulk <global|project> '{"key":"value",...}'
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
      // Re-use settings-set logic inline
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
   * Add a new phase to the end of a project's phase list.
   * Creates the phase epic, wires parent-child and blocks dependencies.
   * Usage: forge-tools add-phase <project-id> <description>
   */
  'add-phase'(args) {
    const projectId = args[0];
    const description = args.slice(1).join(' ');
    if (!projectId || !description) {
      console.error('Usage: forge-tools add-phase <project-id> <description>');
      process.exit(1);
    }

    // Get existing phases
    const children = bdJson(`children ${projectId}`);
    const issues = Array.isArray(children) ? children : (children?.issues || children?.children || []);
    const phases = issues.filter(i => (i.labels || []).includes('forge:phase'));

    // Determine next phase number from titles
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

    // Create phase epic
    const created = bdJson(`create --title="${title}" --description="${description}" --type=epic --priority=1`);
    if (!created || !created.id) {
      console.error('Failed to create phase bead');
      process.exit(1);
    }

    // Add parent-child link to project
    bd(`dep add ${created.id} ${projectId} --type=parent-child`);
    // Add forge:phase label
    bd(`label add ${created.id} forge:phase`);

    // Wire ordering: new phase depends on the last existing phase
    if (phases.length > 0) {
      // Find the last phase (highest number or last in blocks chain)
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
      total_phases: phases.length + 1,
    });
  },

  /**
   * Insert a phase after a given phase using decimal numbering.
   * Usage: forge-tools insert-phase <project-id> <after-phase-number> <description>
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

    // Get existing phases
    const children = bdJson(`children ${projectId}`);
    const issues = Array.isArray(children) ? children : (children?.issues || children?.children || []);
    const phases = issues.filter(i => (i.labels || []).includes('forge:phase'));

    // Find the target phase
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

    // Find existing decimal phases after this integer to determine next decimal
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

    // Create phase epic
    const created = bdJson(`create --title="${title}" --description="${description}" --type=epic --priority=1`);
    if (!created || !created.id) {
      console.error('Failed to create phase bead');
      process.exit(1);
    }

    // Add parent-child link and label
    bd(`dep add ${created.id} ${projectId} --type=parent-child`);
    bd(`label add ${created.id} forge:phase`);

    // Wire ordering: new phase depends on target phase
    bd(`dep add ${created.id} ${targetPhase.id}`);

    // Find the next phase (the one that currently depends on the target)
    // and rewire it to depend on the new phase instead
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
      // Remove old dependency and add new one
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
   * Only allows removing phases that are not in_progress or closed.
   * Usage: forge-tools remove-phase <project-id> <phase-number> [--force]
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

    // Get existing phases
    const children = bdJson(`children ${projectId}`);
    const issues = Array.isArray(children) ? children : (children?.issues || children?.children || []);
    const phases = issues.filter(i => (i.labels || []).includes('forge:phase'));

    // Find the target phase
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

    // Check status
    if ((targetPhase.status === 'in_progress' || targetPhase.status === 'closed') && !force) {
      console.error(`Phase ${phaseNum} is ${targetPhase.status}. Use --force to remove anyway.`);
      process.exit(1);
    }

    // Check for tasks (children)
    const phaseChildren = bdJson(`children ${targetPhase.id}`);
    const tasks = Array.isArray(phaseChildren) ? phaseChildren : (phaseChildren?.issues || phaseChildren?.children || []);
    if (tasks.length > 0 && !force) {
      console.error(`Phase ${phaseNum} has ${tasks.length} tasks. Use --force to remove anyway.`);
      process.exit(1);
    }

    // Rewire dependencies: find phases that depended on the target
    // and make them depend on the target's dependency instead
    const targetDepsRaw = bd(`dep list ${targetPhase.id} --json`, { allowFail: true });
    let targetDeps = [];
    if (targetDepsRaw) {
      try { targetDeps = JSON.parse(targetDepsRaw); } catch { /* ignore */ }
    }
    if (!Array.isArray(targetDeps)) targetDeps = [];

    // Find which phase the target depends on (its predecessor)
    const predecessorDep = targetDeps.find(d => {
      const depId = d.dependency_id || d.id || d;
      const depPhase = phases.find(p => p.id === depId);
      return depPhase && (depPhase.labels || []).includes('forge:phase');
    });
    const predecessorId = predecessorDep ? (predecessorDep.dependency_id || predecessorDep.id || predecessorDep) : null;

    // Find phases that depend on the target (successors)
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

    // Rewire: each successor that depended on target now depends on target's predecessor
    for (const successor of successors) {
      bd(`dep remove ${successor.id} ${targetPhase.id}`, { allowFail: true });
      if (predecessorId) {
        bd(`dep add ${successor.id} ${predecessorId}`);
      }
    }

    // Close the phase bead with removal reason
    bd(`close ${targetPhase.id} --reason="Removed from roadmap"`);

    // Close any child tasks
    for (const task of tasks) {
      bd(`close ${task.id} --reason="Parent phase removed"`, { allowFail: true });
    }

    // Determine if renumbering is needed (only for integer phases)
    const isInteger = Number.isInteger(phaseNum);
    const renumbered = [];

    if (isInteger) {
      // Find phases with numbers > target that need renumbering
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

      // Renumber: decrement phase numbers
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
   * Usage: forge-tools list-phases <project-id>
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

    // Parse and sort by phase number
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
   * Find the project bead in the current beads database.
   */
  'find-project'() {
    const result = bd('list --label forge:project --json', { allowFail: true });
    if (!result) {
      output({ found: false });
      return;
    }
    try {
      const data = JSON.parse(result);
      const issues = Array.isArray(data) ? data : (data.issues || []);
      output({ found: issues.length > 0, projects: issues });
    } catch {
      output({ found: false });
    }
  },
};

// --- Main ---

const [command, ...args] = process.argv.slice(2);

if (!command || command === '--help' || command === '-h') {
  console.log('Usage: forge-tools <command> [args]');
  console.log('\nCommands:');
  Object.keys(commands).forEach(cmd => console.log(`  ${cmd}`));
  process.exit(0);
}

if (!commands[command]) {
  console.error(`Unknown command: ${command}`);
  console.error(`Available: ${Object.keys(commands).join(', ')}`);
  process.exit(1);
}

try {
  commands[command](args);
} catch (err) {
  console.error(`Error in ${command}: ${err.message}`);
  process.exit(1);
}
