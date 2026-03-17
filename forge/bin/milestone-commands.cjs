'use strict';

/**
 * milestone-commands.cjs -- Milestone management commands for forge-tools.
 *
 * Commands: milestone-list, milestone-audit, milestone-create
 */

const {
  bd, bdArgs, bdJsonArgs, output, forgeError,
  validateId, normalizeChildren, collectMilestoneRequirements,
} = require('./core.cjs');

module.exports = {
  /**
   * List milestone beads under a project.
   */
  'milestone-list'(args) {
    const projectId = args[0];
    if (!projectId) {
      forgeError('MISSING_ARG', 'Missing required argument: project-id', 'Run: forge-tools milestone-list <project-id>');
    }
    validateId(projectId);

    const issues = normalizeChildren(bdJsonArgs(['children', projectId]));
    const milestones = issues.filter(i => (i.labels || []).includes('forge:milestone'));

    // TODO(perf): N+1 subprocess -- calls bd children per milestone. Batch when bd CLI supports bulk queries.
    const result = milestones.map(m => {
      const mIssues = normalizeChildren(bdJsonArgs(['children', m.id]));
      const phases = mIssues.filter(i => (i.labels || []).includes('forge:phase'));
      const reqs = collectMilestoneRequirements(m.id);

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
    }, 'milestones-list');
  },

  /**
   * Audit a milestone: check requirement coverage and phase completion.
   */
  'milestone-audit'(args) {
    const milestoneId = args[0];
    if (!milestoneId) {
      forgeError('MISSING_ARG', 'Missing required argument: milestone-id', 'Run: forge-tools milestone-audit <milestone-id>');
    }
    validateId(milestoneId);

    const milestone = bdJsonArgs(['show', milestoneId]);
    if (!milestone) {
      forgeError('NOT_FOUND', `Milestone not found: ${milestoneId}`, 'Verify the milestone ID with: forge-tools milestone-list <project-id>', { milestoneId });
    }

    const issues = normalizeChildren(bdJsonArgs(['children', milestoneId]));
    const phases = issues.filter(i => (i.labels || []).includes('forge:phase'));
    const requirements = collectMilestoneRequirements(milestoneId);

    // TODO(perf): N+1 subprocess -- calls bd children per phase. Batch when bd CLI supports bulk queries.
    const phaseHealth = phases.map(phase => {
      const pIssues = normalizeChildren(bdJsonArgs(['children', phase.id]));
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

    // TODO(perf): N+1 subprocess -- calls bd dep list per requirement. Batch when bd CLI supports bulk queries.
    const reqCoverage = requirements.map(req => {
      const depsRaw = bdArgs(['dep', 'list', req.id, '--direction=up', '--type', 'validates', '--json'], { allowFail: true });
      let validators = [];
      if (depsRaw) {
        try {
          const deps = JSON.parse(depsRaw);
          validators = Array.isArray(deps) ? deps : (deps.dependencies || []);
        } catch { /* INTENTIONALLY SILENT: non-JSON bd output falls back to empty/null */ }
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
    }, 'milestone-audit');
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
    validateId(projectId);

    const title = `Milestone: ${name}`;
    const createRaw = bdArgs(['create', `--title=${title}`, '--type=epic', '--priority=1', '--json']);
    let created;
    // INTENTIONALLY SILENT: bd create output format varies; null fallback triggers forgeError below.
    try { created = JSON.parse(createRaw); if (Array.isArray(created)) created = created[0]; } catch { created = null; }
    if (!created || !created.id) {
      forgeError('COMMAND_FAILED', 'Failed to create milestone bead', 'Check bd connectivity with: bd list --limit 1');
    }

    bdArgs(['label', 'add', created.id, 'forge:milestone']);
    bdArgs(['dep', 'add', created.id, projectId, '--type=parent-child']);

    output({
      ok: true,
      milestone_id: created.id,
      title,
      project_id: projectId,
    }, 'milestone-create');
  },
};
