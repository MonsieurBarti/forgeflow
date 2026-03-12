#!/usr/bin/env node
'use strict';

/**
 * forge-tools.cjs -- Thin helper that queries beads and formats context for workflows.
 *
 * Unlike tools that do heavy state/roadmap/config CRUD on markdown files,
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
    return JSON.parse(raw);
  } catch {
    return null;
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

    // Legacy issues array for backwards compatibility
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
   * Validates: (a) all blocker/predecessor phases are closed,
   *            (b) at least one task exists under the phase,
   *            (c) all tasks have acceptance_criteria set.
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

    // Check (a): all blocker/predecessor phases are closed
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

    // Check (b): at least one task exists
    if (tasks.length === 0) {
      issues.push({
        type: 'no_tasks',
        severity: 'error',
        details: 'No tasks exist under this phase.',
      });
    }

    // Check (c): all tasks have acceptance_criteria
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
   * Save execution checkpoint to phase bead notes and bd remember.
   * Usage: forge-tools checkpoint-save <phase-id> <checkpoint-json>
   * Checkpoint JSON should contain: phaseId, completedWaves, taskStatuses, timestamp, sessionId
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

    // Ensure required fields and add timestamp if missing
    if (!checkpoint.timestamp) {
      checkpoint.timestamp = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
    }
    if (!checkpoint.phaseId) {
      checkpoint.phaseId = phaseId;
    }

    const checkpointJson = JSON.stringify(checkpoint);
    const notesValue = `forge:checkpoint ${checkpointJson}`;

    // Write to phase bead notes (durable storage)
    bdArgs(['update', phaseId, '--notes', notesValue], { allowFail: false });

    // Also store in bd remember for fast lookup
    const memoryKey = `forge:checkpoint:${phaseId}`;
    bdArgs(['remember', checkpointJson, '--key', memoryKey], { allowFail: true });

    output({ saved: true, phaseId, checkpoint });
  },

  /**
   * Load execution checkpoint from phase bead notes.
   * Usage: forge-tools checkpoint-load <phase-id>
   * Returns the stored checkpoint JSON or empty object if none found.
   */
  'checkpoint-load'(args) {
    const phaseId = args[0];
    if (!phaseId) {
      console.error('Usage: forge-tools checkpoint-load <phase-id>');
      process.exit(1);
    }

    let checkpoint = null;

    // Try loading from phase bead notes (primary/durable source)
    try {
      const phaseRaw = bdJson(`show ${phaseId}`);
      const phase = Array.isArray(phaseRaw) ? phaseRaw[0] : phaseRaw;
      const notes = phase?.notes || '';
      const match = notes.match(/forge:checkpoint\s+(\{[\s\S]*\})/);
      if (match) {
        checkpoint = JSON.parse(match[1]);
      }
    } catch { /* corrupt or missing — handled below */ }

    // Fallback: try bd memories if notes didn't have it
    if (!checkpoint) {
      try {
        const memKey = `forge:checkpoint:${phaseId}`;
        const mem = bdArgs(['memories', memKey], { allowFail: true });
        if (mem) {
          // memories output is freeform; look for JSON object
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

    const phaseRaw = bdJson(`show ${phaseId}`);
    // bd show --json returns an array; unwrap to single object
    const phase = Array.isArray(phaseRaw) ? phaseRaw[0] : phaseRaw;
    const children = bdJson(`children ${phaseId}`);
    const tasks = Array.isArray(children) ? children : (children?.issues || children?.children || []);

    // Enrich tasks with full details (acceptance_criteria, etc.)
    const enrichedTasks = tasks.map(task => {
      const raw = bdJson(`show ${task.id}`);
      // bd show --json returns an array; unwrap to single object
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
   * Resolve the model for a given agent.
   * Resolution order:
   *   1. Per-agent override from model_overrides in settings
   *   2. Profile table lookup (model_profile setting, default: balanced)
   *   3. null (agent not in profile table and no override)
   *
   * Opus-tier agents resolve to 'inherit' (use session default).
   *
   * Usage: forge-tools resolve-model <agent-name> [--raw]
   * Agents: forge-planner, forge-executor, forge-researcher, forge-verifier,
   *         forge-plan-checker, forge-roadmapper, forge-debugger, forge-codebase-mapper
   * Also accepts short names: planner, executor, researcher, etc.
   * --raw: output just the model string (no JSON wrapper)
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
   * Includes overrides and profile table lookup.
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
   * Initialize a quick task workflow.
   * Consolidates project lookup, model resolution for all agent roles,
   * and settings into a single call.
   *
   * Usage: forge-tools init-quick [description]
   * Returns: { project, models, settings }
   */
  'init-quick'(args) {
    const description = args.join(' ').trim() || null;

    // 1. Find project
    const projectResult = bd('list --label forge:project --json', { allowFail: true });
    let project = null;
    if (projectResult) {
      try {
        const data = JSON.parse(projectResult);
        const issues = Array.isArray(data) ? data : (data.issues || []);
        if (issues.length > 0) project = issues[0];
      } catch { /* parse error */ }
    }

    // 2. Resolve models for all quick-relevant roles via profile system
    const models = {
      planner: resolveAgentModel('forge-planner'),
      executor: resolveAgentModel('forge-executor'),
      plan_checker: resolveAgentModel('forge-plan-checker'),
      verifier: resolveAgentModel('forge-verifier'),
    };

    // 3. Load merged settings
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

  /**
   * List active debug sessions (beads with forge:debug label, not closed).
   * Returns: { sessions: [{ id, title, status, notes, description }] }
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
   * Usage: debug-create <slug> <description>
   * Returns: { debug_id, slug }
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
      // Try to extract ID from non-JSON output
      const match = result.match(/([a-z]+-[a-z0-9]+)/);
      debugId = match ? match[1] : null;
    }

    if (!debugId) {
      console.error('Failed to parse debug bead ID from:', result);
      process.exit(1);
    }

    // Label and claim the debug bead
    bd(`label add ${debugId} forge:debug`, { allowFail: true });
    bd(`update ${debugId} --status=in_progress`, { allowFail: true });

    output({ debug_id: debugId, slug });
  },

  /**
   * Update a debug session bead's notes or design fields.
   * Usage: debug-update <id> <field> <value>
   * Fields: notes, design, status
   * Returns: { updated: true, id }
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
   * List pending forge:todo beads (status=open).
   * Returns: { todo_count, todos: [{ id, title, status, description, notes, created_at }] }
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
   * Usage: todo-create <project-id> <title> [description] [area] [files]
   * Returns: { todo_id }
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

    // Label and wire to project
    bd(`label add ${todoId} forge:todo`, { allowFail: true });
    bd(`dep add ${todoId} ${projectId} --type=parent-child`, { allowFail: true });

    output({ todo_id: todoId });
  },

  /**
   * List milestone beads under a project.
   * Usage: forge-tools milestone-list <project-id>
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
      // Get phases under this milestone
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
   * Usage: forge-tools milestone-audit <milestone-id>
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

    // Get children (phases and requirements)
    const children = bdJson(`children ${milestoneId}`);
    const issues = Array.isArray(children) ? children : (children?.issues || children?.children || []);
    const phases = issues.filter(i => (i.labels || []).includes('forge:phase'));
    const requirements = issues.filter(i => (i.labels || []).includes('forge:req'));

    // Check phase health
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

    // Check requirement coverage via validates dependencies
    const reqCoverage = requirements.map(req => {
      const depsRaw = bd(`dep list ${req.id} --type validates --json`, { allowFail: true });
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
   * Usage: forge-tools milestone-create <project-id> <milestone-name>
   */
  'milestone-create'(args) {
    const projectId = args[0];
    const name = args.slice(1).join(' ');
    if (!projectId || !name) {
      console.error('Usage: forge-tools milestone-create <project-id> <milestone-name>');
      process.exit(1);
    }

    const title = `Milestone: ${name}`;
    const created = bdJson(`create --title="${title}" --type=epic --priority=1`);
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
   * Resolve a phase bead by project ID and phase number.
   * Queries only forge:phase labeled epics to avoid substring false-matches
   * (e.g. phase 7 must not match phase 17).
   *
   * Usage: forge-tools resolve-phase <project-id> <phase-number>
   * Returns: { found, phase } where phase is the exact matching bead.
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

    // Fetch only direct children of the project that carry the forge:phase label.
    const children = bdJson(`children ${projectId}`);
    if (!children) {
      output({ found: false, phase: null });
      return;
    }

    const issues = Array.isArray(children) ? children : (children.issues || children.children || []);
    const phases = issues.filter(i =>
      (i.labels || []).includes('forge:phase') && i.id !== projectId
    );

    // Sort phases by their natural order (by title prefix "Phase N:" or positional index).
    // We extract the leading number from the title when present, otherwise fall back to
    // the 1-based position in the children list so callers can use ordinal references.
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
