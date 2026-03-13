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
const { bdJson, git, gh, output } = require('./core.cjs');

module.exports = {
  /**
   * Create a git worktree at a deterministic path for a milestone.
   */
  'worktree-create'(args) {
    const milestoneId = args[0];
    if (!milestoneId) {
      console.error('Usage: forge-tools worktree-create <milestone-id>');
      process.exit(1);
    }
    const wtPath = path.join(process.cwd(), '.forge', 'worktrees', milestoneId);
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
      console.error('Usage: forge-tools worktree-path <milestone-id>');
      process.exit(1);
    }
    const wtPath = path.join(process.cwd(), '.forge', 'worktrees', milestoneId);
    const exists = fs.existsSync(wtPath);
    output({ path: wtPath, exists });
  },

  /**
   * Remove a git worktree for a milestone.
   */
  'worktree-remove'(args) {
    const milestoneId = args[0];
    if (!milestoneId) {
      console.error('Usage: forge-tools worktree-remove <milestone-id>');
      process.exit(1);
    }
    const wtPath = path.join(process.cwd(), '.forge', 'worktrees', milestoneId);

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
      console.error('Usage: forge-tools branch-create <phase-id>');
      process.exit(1);
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
      console.error('Usage: forge-tools branch-push <branch>');
      process.exit(1);
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
      console.error('Usage: forge-tools pr-create <phase-id> [--base=<branch>]');
      process.exit(1);
    }

    const phaseRaw = bdJson(`show ${phaseId}`);
    const phase = Array.isArray(phaseRaw) ? phaseRaw[0] : phaseRaw;
    const children = bdJson(`children ${phaseId}`);
    const tasks = Array.isArray(children) ? children : (children?.issues || children?.children || []);

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
      output({ created: false, error: err.message, branch, base });
      process.exit(1);
    }
  },

  /**
   * Create a branch for a quick task.
   */
  'quick-branch-create'(args) {
    const quickId = args[0];
    if (!quickId) {
      console.error('Usage: forge-tools quick-branch-create <quick-id>');
      process.exit(1);
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
      console.error('Usage: forge-tools quick-pr-create <quick-id> [--base=<branch>]');
      process.exit(1);
    }

    const quickRaw = bdJson(`show ${quickId}`);
    const quick = Array.isArray(quickRaw) ? quickRaw[0] : quickRaw;
    const children = bdJson(`children ${quickId}`);
    const tasks = Array.isArray(children) ? children : (children?.issues || children?.children || []);

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
      output({ created: false, error: err.message, branch, base });
    }
  },
};
