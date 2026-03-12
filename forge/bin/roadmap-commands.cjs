'use strict';

/**
 * roadmap-commands.cjs -- Roadmap management commands for forge-tools.
 *
 * Commands: migrate-orphan-phases
 *
 * Note: add-phase, insert-phase, remove-phase, list-phases, resolve-phase,
 *       context-write, context-read are in phase-commands.cjs.
 */

const { bd, bdJson, output } = require('./core.cjs');

module.exports = {
  /**
   * Migrate orphan phases (no milestone parent) to a milestone.
   */
  'migrate-orphan-phases'() {
    const projectsRaw = bd('list --label forge:project --json', { allowFail: true });
    if (!projectsRaw) {
      output({ ok: true, message: 'No projects found', actions: [] });
      return;
    }
    const projectsData = JSON.parse(projectsRaw);
    const projects = Array.isArray(projectsData) ? projectsData : (projectsData.issues || []);
    if (projects.length === 0) {
      output({ ok: true, message: 'No projects found', actions: [] });
      return;
    }

    const actions = [];

    for (const project of projects) {
      const childrenData = bdJson(`children ${project.id}`);
      const children = Array.isArray(childrenData) ? childrenData : (childrenData?.issues || childrenData?.children || []);

      const phases = children.filter(c => (c.labels || []).includes('forge:phase'));
      const milestones = children.filter(c => (c.labels || []).includes('forge:milestone'));

      const orphanPhases = [];
      for (const phase of phases) {
        const depsRaw = bd(`dep list ${phase.id} --json`, { allowFail: true });
        let deps = [];
        if (depsRaw) {
          try { deps = JSON.parse(depsRaw); } catch {}
          if (!Array.isArray(deps)) deps = deps.dependencies || [];
        }
        const hasMilestoneParent = deps.some(d =>
          (d.type === 'parent-child' || d.dependency_type === 'parent-child') &&
          milestones.some(m => m.id === (d.depends_on_id || d.id))
        );
        if (!hasMilestoneParent) {
          orphanPhases.push(phase);
        }
      }

      if (orphanPhases.length === 0) continue;

      let milestone = milestones.find(m => m.status !== 'closed');
      if (!milestone) {
        const created = bdJson(`create --title="Milestone 1" --description="Default milestone (auto-created by migration)" --type=epic --priority=1`);
        if (!created || !created.id) {
          actions.push({ project: project.id, error: 'Failed to create milestone' });
          continue;
        }
        bd(`dep add ${created.id} ${project.id} --type=parent-child`);
        bd(`label add ${created.id} forge:milestone`);
        milestone = { id: created.id, title: 'Milestone 1' };
        actions.push({ type: 'created_milestone', project: project.id, milestone_id: milestone.id });
      }

      for (const phase of orphanPhases) {
        bd(`dep add ${phase.id} ${milestone.id} --type=parent-child`);
        actions.push({ type: 'linked_phase', phase_id: phase.id, phase_title: phase.title, milestone_id: milestone.id });
      }
    }

    output({
      ok: true,
      orphans_found: actions.filter(a => a.type === 'linked_phase').length,
      milestones_created: actions.filter(a => a.type === 'created_milestone').length,
      actions,
    });
  },
};
