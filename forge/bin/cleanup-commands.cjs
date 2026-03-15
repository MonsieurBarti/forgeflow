'use strict';

/**
 * cleanup-commands.cjs -- Milestone cleanup commands for forge-tools.
 *
 * Commands: milestone-cleanup-branches, milestone-close-beads, milestone-purge-memories
 */

const { bd, bdArgs, bdJson, git, output, forgeError, validateId, normalizeChildren } = require('./core.cjs');

/**
 * Collect all phase IDs that belong to a milestone.
 */
function collectPhaseIds(milestoneId) {
  const children = bdJson(`children ${milestoneId}`);
  const all = normalizeChildren(children);
  return all
    .filter(b => (b.labels || []).includes('forge:phase'))
    .map(b => b.id);
}

/**
 * Parse --dry-run flag from args.
 */
function isDryRun(args) {
  return args.includes('--dry-run');
}

module.exports = {
  /**
   * Find and delete local merged git branches for a milestone.
   * Matches both forge/m-<id>/phase-* and forge/m-<id>-phase-* conventions,
   * plus the milestone branch forge/m-<id> itself.
   */
  'milestone-cleanup-branches'(args) {
    const milestoneId = args[0];
    if (!milestoneId) {
      forgeError('MISSING_ARG', 'Missing required argument: milestone-id', 'Run: forge-tools milestone-cleanup-branches <milestone-id> [--dry-run]');
    }
    validateId(milestoneId);
    const dryRun = isDryRun(args);

    // Get all local branches merged into current HEAD
    const mergedRaw = git(['branch', '--merged'], { allowFail: true });
    if (!mergedRaw) {
      return output({ dry_run: dryRun, branches: [], deleted: [], failed: [] });
    }

    const mergedBranches = mergedRaw
      .split('\n')
      .map(b => b.replace(/^\*?\s+/, '').trim())
      .filter(Boolean);

    // Match branches belonging to this milestone:
    // - forge/m-<id>-phase-* (newer convention)
    // - forge/m-<id>/phase-* (older convention)
    // - forge/m-<id> (milestone branch itself)
    // - forge/quick-* branches linked to milestone phases (skip for now — too broad)
    const prefix1 = `forge/m-${milestoneId}-phase-`;
    const prefix2 = `forge/m-${milestoneId}/phase-`;
    const exact = `forge/m-${milestoneId}`;

    const targets = mergedBranches.filter(b =>
      b.startsWith(prefix1) || b.startsWith(prefix2) || b === exact
    );

    if (dryRun) {
      return output({ dry_run: true, branches: targets, count: targets.length });
    }

    const deleted = [];
    const failed = [];
    for (const branch of targets) {
      const result = git(['branch', '-d', branch], { allowFail: true });
      if (result !== '') {
        deleted.push(branch);
      } else {
        // allowFail returns '' on failure — check if branch still exists
        const still = git(['branch', '--list', branch], { allowFail: true });
        if (still) {
          failed.push(branch);
        } else {
          deleted.push(branch);
        }
      }
    }

    output({ dry_run: false, deleted, failed, count: deleted.length });
  },

  /**
   * Close all open/in_progress beads under a milestone tree.
   * Traverses: milestone -> phases -> tasks, plus direct children (requirements).
   */
  'milestone-close-beads'(args) {
    const milestoneId = args[0];
    if (!milestoneId) {
      forgeError('MISSING_ARG', 'Missing required argument: milestone-id', 'Run: forge-tools milestone-close-beads <milestone-id> [--dry-run]');
    }
    validateId(milestoneId);
    const dryRun = isDryRun(args);

    // Collect all beads under the milestone tree
    const directChildren = normalizeChildren(bdJson(`children ${milestoneId}`));
    const allBeads = [...directChildren];

    // For each phase, also collect its children (tasks)
    const phases = directChildren.filter(b => (b.labels || []).includes('forge:phase'));
    for (const phase of phases) {
      const phaseChildren = normalizeChildren(bdJson(`children ${phase.id}`));
      allBeads.push(...phaseChildren);
    }

    // Filter to open/in_progress only
    const openBeads = allBeads.filter(b => b.status === 'open' || b.status === 'in_progress');

    if (dryRun) {
      const preview = openBeads.map(b => ({
        id: b.id,
        title: b.title,
        status: b.status,
        type: b.issue_type,
      }));
      return output({ dry_run: true, beads: preview, count: preview.length });
    }

    const closed = [];
    const failed = [];
    for (const bead of openBeads) {
      const result = bdArgs(['close', bead.id, '--reason=cleanup: milestone completed'], { allowFail: true });
      if (result !== '') {
        closed.push(bead.id);
      } else {
        // Check if it's actually closed now
        const check = bdJson(`show ${bead.id}`);
        const item = Array.isArray(check) ? check[0] : check;
        if (item?.status === 'closed') {
          closed.push(bead.id);
        } else {
          failed.push(bead.id);
        }
      }
    }

    output({ dry_run: false, closed, failed, count: closed.length });
  },

  /**
   * Purge bd memories related to a milestone's phases.
   * Targets: forge:checkpoint:<phase-id>, forge:phase:<phase-id>:*, forge:session:*
   */
  'milestone-purge-memories'(args) {
    const milestoneId = args[0];
    if (!milestoneId) {
      forgeError('MISSING_ARG', 'Missing required argument: milestone-id', 'Run: forge-tools milestone-purge-memories <milestone-id> [--dry-run]');
    }
    validateId(milestoneId);
    const dryRun = isDryRun(args);

    // Get phase IDs under this milestone
    const phaseIds = collectPhaseIds(milestoneId);

    // Get all memories as JSON
    const allMemories = bdJson('memories');
    if (!allMemories || typeof allMemories !== 'object') {
      return output({ dry_run: dryRun, keys: [], purged: [], failed: [], count: 0 });
    }

    const allKeys = Object.keys(allMemories);
    const targetKeys = [];

    for (const key of allKeys) {
      // Match checkpoint keys: forge:checkpoint:<phase-id>
      for (const phaseId of phaseIds) {
        if (key === `forge:checkpoint:${phaseId}`) {
          targetKeys.push(key);
          break;
        }
      }

      // Match phase memory keys (colon-style): forge:phase:<phase-id>:*
      for (const phaseId of phaseIds) {
        const prefix = `forge:phase:${phaseId}:`;
        if (key.startsWith(prefix) && !targetKeys.includes(key)) {
          targetKeys.push(key);
          break;
        }
      }

      // Match phase memory keys (hyphenated-slug style from bd): forge-phase-<phase-id>-*
      for (const phaseId of phaseIds) {
        const prefix = `forge-phase-${phaseId}-`;
        if (key.startsWith(prefix) && !targetKeys.includes(key)) {
          targetKeys.push(key);
          break;
        }
      }

      // Match milestone-specific memory keys
      if (key === `forge:milestone:${milestoneId}:goal` || key === `forge:milestone:${milestoneId}:worktree`) {
        if (!targetKeys.includes(key)) {
          targetKeys.push(key);
        }
      }

      // Match session keys pointing to this milestone's phases
      if (key.startsWith('forge:session:')) {
        const val = String(allMemories[key] || '');
        for (const phaseId of phaseIds) {
          if (val.includes(phaseId) || val.includes(milestoneId)) {
            if (!targetKeys.includes(key)) {
              targetKeys.push(key);
            }
            break;
          }
        }
      }
    }

    if (dryRun) {
      return output({ dry_run: true, keys: targetKeys, count: targetKeys.length });
    }

    const purged = [];
    const failed = [];
    for (const key of targetKeys) {
      const result = bd(`forget ${key}`, { allowFail: true });
      if (result !== '') {
        purged.push(key);
      } else {
        // bd forget may return empty on success too — check if key still exists
        const check = bd(`memories ${key}`, { allowFail: true });
        if (check && check.includes(key)) {
          failed.push(key);
        } else {
          purged.push(key);
        }
      }
    }

    output({ dry_run: false, purged, failed, count: purged.length });
  },
};
