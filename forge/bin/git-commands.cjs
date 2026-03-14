'use strict';

/**
 * git-commands.cjs -- Git isolation commands for forge-tools.
 *
 * Commands: worktree-create, worktree-path, worktree-remove,
 *           branch-create, branch-push, pr-create,
 *           quick-branch-create, quick-pr-create
 */

const fs = require('fs');
const path = require('path');
const { bdJson, git, gh, output, forgeError, normalizeChildren } = require('./core.cjs');

/**
 * Validate a bead/milestone ID to prevent path traversal.
 * IDs must be lowercase alphanumeric with hyphens, e.g. "abc-1234".
 */
function validateId(id) {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) {
    forgeError('INVALID_INPUT', `Invalid ID format: ${id}`, 'IDs must contain only lowercase letters, digits, and hyphens');
  }
}

/**
 * Resolve a worktree path and verify it stays within the expected base directory.
 */
function safeWorktreePath(milestoneId) {
  validateId(milestoneId);
  const baseDir = path.join(process.cwd(), '.forge', 'worktrees');
  const wtPath = path.join(baseDir, milestoneId);
  const resolved = path.resolve(wtPath);
  if (!resolved.startsWith(path.resolve(baseDir) + path.sep) && resolved !== path.resolve(baseDir)) {
    forgeError('INVALID_INPUT', 'Path traversal detected', 'IDs must not contain path separators or traversal sequences');
  }
  return wtPath;
}

module.exports = {
  /**
   * Create a git worktree at a deterministic path for a milestone.
   */
  'worktree-create'(args) {
    const milestoneId = args[0];
    if (!milestoneId) {
      forgeError('MISSING_ARG', 'Missing required argument: milestone-id', 'Run: forge-tools worktree-create <milestone-id>');
    }
    const wtPath = safeWorktreePath(milestoneId);
    const branch = `forge/m-${milestoneId}`;

    if (fs.existsSync(wtPath)) {
      output({ created: false, path: wtPath, branch, reason: 'already_exists' });
      return;
    }

    fs.mkdirSync(path.dirname(wtPath), { recursive: true });

    const branches = git(['branch', '--list', branch], { allowFail: true });
    if (!branches) {
      git(['branch', branch], { allowFail: true });
    }

    git(['worktree', 'add', wtPath, branch]);
    output({ created: true, path: wtPath, branch });
  },

  /**
   * Get the worktree path for a milestone.
   */
  'worktree-path'(args) {
    const milestoneId = args[0];
    if (!milestoneId) {
      forgeError('MISSING_ARG', 'Missing required argument: milestone-id', 'Run: forge-tools worktree-path <milestone-id>');
    }
    const wtPath = safeWorktreePath(milestoneId);
    const exists = fs.existsSync(wtPath);
    output({ path: wtPath, exists });
  },

  /**
   * Remove a git worktree for a milestone.
   */
  'worktree-remove'(args) {
    const milestoneId = args[0];
    if (!milestoneId) {
      forgeError('MISSING_ARG', 'Missing required argument: milestone-id', 'Run: forge-tools worktree-remove <milestone-id>');
    }
    const wtPath = safeWorktreePath(milestoneId);

    if (!fs.existsSync(wtPath)) {
      output({ removed: false, reason: 'not_found' });
      return;
    }

    git(['worktree', 'remove', wtPath, '--force'], { allowFail: true });

    try {
      const parent = path.dirname(wtPath);
      if (fs.existsSync(parent) && fs.readdirSync(parent).length === 0) {
        fs.rmdirSync(parent);
      }
    } catch { /* ignore */ }

    output({ removed: true, path: wtPath });
  },

  /**
   * Create a branch for a phase.
   */
  'branch-create'(args) {
    const phaseId = args[0];
    if (!phaseId) {
      forgeError('MISSING_ARG', 'Missing required argument: phase-id', 'Run: forge-tools branch-create <phase-id>');
    }

    const deps = bdJson(`dep list ${phaseId}`);
    const depList = Array.isArray(deps) ? deps : [];
    const parentDeps = depList.filter(d => d.dependency_type === 'parent-child');

    let milestoneId = null;
    for (const dep of parentDeps) {
      const raw = bdJson(`show ${dep.id}`);
      const item = Array.isArray(raw) ? raw[0] : raw;
      if ((item?.labels || []).includes('forge:milestone')) {
        milestoneId = dep.id;
        break;
      }
    }

    const branch = milestoneId
      ? `forge/m-${milestoneId}-phase-${phaseId}`
      : `forge/phase-${phaseId}`;

    const existing = git(['branch', '--list', branch], { allowFail: true });
    if (existing) {
      git(['checkout', branch]);
      output({ created: false, branch, reason: 'already_exists' });
      return;
    }

    git(['branch', branch]);
    git(['checkout', branch]);
    output({ created: true, branch, phaseId, milestoneId });
  },

  /**
   * Push a branch to origin.
   */
  'branch-push'(args) {
    const branch = args[0];
    if (!branch) {
      forgeError('MISSING_ARG', 'Missing required argument: branch', 'Run: forge-tools branch-push <branch-name>');
    }
    git(['push', '-u', 'origin', branch]);
    output({ pushed: true, branch });
  },

  /**
   * Create a GitHub PR for a phase with a rich description.
   */
  'pr-create'(args) {
    const phaseId = args[0];
    const baseFlag = args.find(a => a.startsWith('--base='));
    const base = baseFlag ? baseFlag.split('=')[1] : 'main';

    if (!phaseId) {
      forgeError('MISSING_ARG', 'Missing required argument: phase-id', 'Run: forge-tools pr-create <phase-id> [--base=<branch>]');
    }

    const phaseRaw = bdJson(`show ${phaseId}`);
    const phase = Array.isArray(phaseRaw) ? phaseRaw[0] : phaseRaw;
    const children = bdJson(`children ${phaseId}`);
    const tasks = normalizeChildren(children);

    // NOTE: N+1 subprocess pattern -- calls bd dep list per task.
    // Requires bd CLI bulk query support to optimize further.
    const reqCoverage = [];
    for (const task of tasks) {
      const taskDeps = bdJson(`dep list ${task.id}`);
      const taskDepList = Array.isArray(taskDeps) ? taskDeps : (taskDeps?.dependencies || []);
      const validates = taskDepList.filter(d => d.dependency_type === 'validates');
      for (const v of validates) {
        reqCoverage.push({ taskId: task.id, taskTitle: task.title, reqId: v.id });
      }
    }

    const taskLines = tasks.map(t => {
      const status = t.status === 'closed' ? 'x' : ' ';
      const ac = t.acceptance_criteria ? `\n    ${t.acceptance_criteria.split('\n').join('\n    ')}` : '';
      return `- [${status}] **${t.title}** (\`${t.id}\`)${ac}`;
    }).join('\n');

    let reqSection = '';
    if (reqCoverage.length > 0) {
      const byReq = {};
      for (const rc of reqCoverage) {
        if (!byReq[rc.reqId]) byReq[rc.reqId] = [];
        byReq[rc.reqId].push(rc.taskTitle);
      }
      const reqLines = Object.entries(byReq).map(([reqId, taskNames]) =>
        `- \`${reqId}\`: ${taskNames.join(', ')}`
      ).join('\n');
      reqSection = `\n## Requirement Coverage\n\n${reqLines}\n`;
    }

    const title = phase?.title || `Phase ${phaseId}`;
    const body = `## Phase Goal\n\n${phase?.description || 'N/A'}\n\n## Tasks\n\n${taskLines}\n${reqSection}\n---\n🤖 Generated by Forge`;

    const deps = bdJson(`dep list ${phaseId}`);
    const depList = Array.isArray(deps) ? deps : (deps?.dependencies || []);
    const parentDep = depList.find(d => d.dependency_type === 'parent-child');

    let milestoneId = null;
    if (parentDep) {
      const parentRaw = bdJson(`show ${parentDep.id}`);
      const parent = Array.isArray(parentRaw) ? parentRaw[0] : parentRaw;
      const parentLabels = parent?.labels || [];
      if (parentLabels.includes('forge:milestone')) {
        milestoneId = parentDep.id;
      }
    }

    const branch = milestoneId
      ? `forge/m-${milestoneId}-phase-${phaseId}`
      : `forge/phase-${phaseId}`;

    // Idempotency: if a PR already exists for this branch, return it
    const existing = gh(['pr', 'list', '--head', branch, '--json', 'url', '--jq', '.[0].url'], { allowFail: true });
    if (existing) {
      return output({ created: false, url: existing, branch, base, title });
    }

    try {
      const prUrl = gh([
        'pr', 'create',
        '--title', title,
        '--body', body,
        '--base', base,
        '--head', branch,
      ]);
      output({ created: true, url: prUrl, branch, base, title });
    } catch (err) {
      forgeError('COMMAND_FAILED', `Failed to create PR: ${err.message}`, 'Verify the branch has been pushed and try again with: forge-tools pr-create <phase-id>', { branch, base });
    }
  },

  /**
   * Create a branch for a quick task.
   */
  'quick-branch-create'(args) {
    const quickId = args[0];
    if (!quickId) {
      forgeError('MISSING_ARG', 'Missing required argument: quick-id', 'Run: forge-tools quick-branch-create <quick-id>');
    }

    const branch = `forge/quick-${quickId}`;

    const existing = git(['branch', '--list', branch], { allowFail: true });
    if (existing) {
      git(['checkout', branch]);
      output({ created: false, branch, reason: 'already_exists' });
      return;
    }

    git(['branch', branch]);
    git(['checkout', branch]);
    output({ created: true, branch, quickId });
  },

  /**
   * Create a simplified GitHub PR for a quick task.
   */
  'quick-pr-create'(args) {
    const quickId = args[0];
    const baseFlag = args.find(a => a.startsWith('--base='));
    const base = baseFlag ? baseFlag.split('=')[1] : 'main';

    if (!quickId) {
      forgeError('MISSING_ARG', 'Missing required argument: quick-id', 'Run: forge-tools quick-pr-create <quick-id> [--base=<branch>]');
    }

    const quickRaw = bdJson(`show ${quickId}`);
    const quick = Array.isArray(quickRaw) ? quickRaw[0] : quickRaw;
    const children = bdJson(`children ${quickId}`);
    const tasks = normalizeChildren(children);

    const taskLines = tasks.map(t => {
      const status = t.status === 'closed' ? 'x' : ' ';
      return `- [${status}] **${t.title}** (\`${t.id}\`)`;
    }).join('\n');

    const title = quick?.title || `Quick task ${quickId}`;
    const desc = quick?.description || 'N/A';
    const taskSection = taskLines ? `\n## Tasks\n\n${taskLines}\n` : '';
    const body = `## Summary\n\n${desc}\n${taskSection}\n---\n🤖 Generated by Forge`;

    const branch = `forge/quick-${quickId}`;

    // Idempotency: if a PR already exists for this branch, return it
    const existing = gh(['pr', 'list', '--head', branch, '--json', 'url', '--jq', '.[0].url'], { allowFail: true });
    if (existing) {
      return output({ created: false, url: existing, branch, base, title });
    }

    try {
      const prUrl = gh([
        'pr', 'create',
        '--title', title,
        '--body', body,
        '--base', base,
        '--head', branch,
      ]);
      output({ created: true, url: prUrl, branch, base, title });
    } catch (err) {
      forgeError('COMMAND_FAILED', `Failed to create PR: ${err.message}`, 'Verify the branch has been pushed and try again with: forge-tools quick-pr-create <quick-id>', { branch, base });
    }
  },
};
