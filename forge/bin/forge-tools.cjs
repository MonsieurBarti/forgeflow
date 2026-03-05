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
