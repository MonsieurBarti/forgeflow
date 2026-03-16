'use strict';

/**
 * git-commands.cjs -- Git isolation commands for forge-tools.
 *
 * Generalized commands:
 *   worktree-create-task, worktree-path, worktree-remove,
 *   task-branch-create, branch-push, pr-create, quick-pr-create
 *
 * Backward-compat wrappers (delegate to generalized commands):
 *   worktree-create, branch-create, quick-branch-create
 */

const fs = require('fs');
const path = require('path');
const { bd, bdArgs, bdJsonArgs, git, gh, output, forgeError, validateId, normalizeChildren, unwrapBdArray } = require('./core.cjs');

// --- Valid prefix values ---
const VALID_PREFIXES = new Set(['phase', 'quick', 'debug']);

/**
 * Parse a --prefix=<value> flag from args, defaulting to 'phase'.
 */
function parsePrefix(args) {
  const flag = args.find(a => a.startsWith('--prefix='));
  const prefix = flag ? flag.split('=')[1] : 'phase';
  if (!VALID_PREFIXES.has(prefix)) {
    forgeError('INVALID_INPUT', `Invalid prefix: ${prefix}`, 'Valid prefixes: phase, quick, debug');
  }
  return prefix;
}

/**
 * Parse a --base=<branch> flag from args, defaulting to 'main'.
 */
function parseBase(args) {
  const flag = args.find(a => a.startsWith('--base='));
  return flag ? flag.split('=')[1] : 'main';
}

/**
 * Resolve a worktree path and verify it stays within the expected base directory.
 * Accepts (prefix, id) and returns .forge/worktrees/<prefix>-<id>.
 */
function safeWorktreePath(prefix, id) {
  validateId(id);
  if (prefix && !VALID_PREFIXES.has(prefix)) {
    forgeError('INVALID_INPUT', `Invalid prefix: ${prefix}`, 'Valid prefixes: phase, quick, debug');
  }
  const baseDir = path.join(process.cwd(), '.forge', 'worktrees');
  const dirName = prefix ? `${prefix}-${id}` : id;
  const wtPath = path.join(baseDir, dirName);
  const resolved = path.resolve(wtPath);
  if (!resolved.startsWith(path.resolve(baseDir) + path.sep) && resolved !== path.resolve(baseDir)) {
    forgeError('INVALID_INPUT', 'Path traversal detected', 'IDs must not contain path separators or traversal sequences');
  }
  return wtPath;
}

module.exports = {
  // =========================================================================
  // Generalized commands
  // =========================================================================

  /**
   * Create a git worktree for a task at .forge/worktrees/<prefix>-<id>.
   * Usage: forge-tools worktree-create-task <id> --prefix=<phase|quick|debug> --base=<branch>
   */
  'worktree-create-task'(args) {
    const id = args.find(a => !a.startsWith('--'));
    if (!id) {
      forgeError('MISSING_ARG', 'Missing required argument: id', 'Run: forge-tools worktree-create-task <id> --prefix=<phase|quick|debug> [--base=<branch>]');
    }
    const prefix = parsePrefix(args);
    const base = parseBase(args);
    const wtPath = safeWorktreePath(prefix, id);
    const branch = `forge/${prefix}-${id}`;

    if (fs.existsSync(wtPath)) {
      const hint = 'Worktree already exists at ' + wtPath + '. Use it directly or remove with: forge-tools worktree-remove ' + id + ' --prefix=' + prefix;
      output({ created: false, path: wtPath, branch, reason: 'already_exists', suggestion: hint }, 'worktree-create');
      return;
    }

    fs.mkdirSync(path.dirname(wtPath), { recursive: true });

    const branches = git(['branch', '--list', branch], { allowFail: true });
    if (!branches) {
      git(['branch', branch, base]);
    }

    git(['worktree', 'add', wtPath, branch]);
    output({ created: true, path: wtPath, branch }, 'worktree-create');
  },

  /**
   * Create a branch for a task.
   * Usage: forge-tools task-branch-create <id> --prefix=<phase|quick|debug> --base=<branch>
   * Creates branch forge/<prefix>-<id> from --base (defaults to main).
   */
  'task-branch-create'(args) {
    const id = args.find(a => !a.startsWith('--'));
    if (!id) {
      forgeError('MISSING_ARG', 'Missing required argument: id', 'Run: forge-tools task-branch-create <id> --prefix=<phase|quick|debug> [--base=<branch>]');
    }
    const prefix = parsePrefix(args);
    const base = parseBase(args);
    const branch = `forge/${prefix}-${id}`;

    const existing = git(['branch', '--list', branch], { allowFail: true });
    if (existing) {
      git(['checkout', branch]);
      const hint = 'Branch ' + branch + ' already exists and has been checked out. Push with: forge-tools branch-push ' + branch;
      output({ created: false, branch, reason: 'already_exists', suggestion: hint }, 'task-branch-create');
      return;
    }

    git(['branch', branch, base]);
    git(['checkout', branch]);
    output({ created: true, branch, id, prefix, base }, 'task-branch-create');
  },

  /**
   * Get the worktree path for a task.
   * Usage: forge-tools worktree-path <id> [--prefix=<prefix>]
   *
   * When --prefix is provided, looks up .forge/worktrees/<prefix>-<id>.
   * When --prefix is omitted, falls back to legacy behavior: .forge/worktrees/<id>
   * (backward compat for milestone worktrees where the id was the full milestoneId).
   */
  'worktree-path'(args) {
    const id = args.find(a => !a.startsWith('--'));
    if (!id) {
      forgeError('MISSING_ARG', 'Missing required argument: id', 'Run: forge-tools worktree-path <id> [--prefix=<prefix>]');
    }
    const prefixFlag = args.find(a => a.startsWith('--prefix='));
    const prefix = prefixFlag ? prefixFlag.split('=')[1] : null;

    // Validate prefix if provided
    if (prefix && !VALID_PREFIXES.has(prefix)) {
      forgeError('INVALID_INPUT', `Invalid prefix: ${prefix}`, 'Valid prefixes: phase, quick, debug');
    }

    const wtPath = safeWorktreePath(prefix, id);
    const exists = fs.existsSync(wtPath);
    output({ path: wtPath, exists }, 'worktree-path');
  },

  /**
   * Remove a git worktree for a task.
   * Usage: forge-tools worktree-remove <id> [--prefix=<prefix>]
   *
   * When --prefix is provided, removes .forge/worktrees/<prefix>-<id>.
   * When --prefix is omitted, falls back to legacy behavior: .forge/worktrees/<id>.
   */
  'worktree-remove'(args) {
    const id = args.find(a => !a.startsWith('--'));
    if (!id) {
      forgeError('MISSING_ARG', 'Missing required argument: id', 'Run: forge-tools worktree-remove <id> [--prefix=<prefix>]');
    }
    const prefixFlag = args.find(a => a.startsWith('--prefix='));
    const prefix = prefixFlag ? prefixFlag.split('=')[1] : null;

    // Validate prefix if provided
    if (prefix && !VALID_PREFIXES.has(prefix)) {
      forgeError('INVALID_INPUT', `Invalid prefix: ${prefix}`, 'Valid prefixes: phase, quick, debug');
    }

    const wtPath = safeWorktreePath(prefix, id);

    if (!fs.existsSync(wtPath)) {
      output({ removed: false, reason: 'not_found', suggestion: 'Worktree not found. List existing worktrees with: git worktree list' }, 'worktree-remove');
      return;
    }

    git(['worktree', 'remove', wtPath, '--force'], { allowFail: true });

    try {
      const parent = path.dirname(wtPath);
      if (fs.existsSync(parent) && fs.readdirSync(parent).length === 0) {
        fs.rmdirSync(parent);
      }
    } catch { /* INTENTIONALLY SILENT: empty parent dir cleanup is best-effort */ }

    output({ removed: true, path: wtPath }, 'worktree-remove');
  },

  /**
   * Push a branch to origin.
   */
  'branch-push'(args) {
    const branch = args[0];
    if (!branch) {
      forgeError('MISSING_ARG', 'Missing required argument: branch', 'Run: forge-tools branch-push <branch-name>');
    }
    git(['push', '-u', 'origin', '--', branch]);
    output({ pushed: true, branch }, 'branch-push');
  },

  /**
   * Create a GitHub PR for a phase with a rich description.
   */
  'pr-create'(args) {
    const phaseId = args.find(a => !a.startsWith('--'));
    const base = parseBase(args);

    if (!phaseId) {
      forgeError('MISSING_ARG', 'Missing required argument: phase-id', 'Run: forge-tools pr-create <phase-id> [--base=<branch>]');
    }

    const phase = unwrapBdArray(bdJsonArgs(['show', phaseId]));
    const children = bdJsonArgs(['children', phaseId]);
    const tasks = normalizeChildren(children);

    // TODO(perf): N+1 subprocess -- calls bd dep list per task. Batch when bd CLI supports bulk queries.
    const reqCoverage = [];
    for (const task of tasks) {
      const taskDeps = bdJsonArgs(['dep', 'list', task.id]);
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

    const deps = bdJsonArgs(['dep', 'list', phaseId]);
    const depList = Array.isArray(deps) ? deps : (deps?.dependencies || []);
    const parentDep = depList.find(d => d.dependency_type === 'parent-child');

    let milestoneId = null;
    if (parentDep) {
      const parent = unwrapBdArray(bdJsonArgs(['show', parentDep.id]));
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
      const hint = 'A PR already exists for this branch. View it at: ' + existing;
      return output({ created: false, url: existing, branch, base, title, suggestion: hint }, 'pr-create');
    }

    try {
      const prUrl = gh([
        'pr', 'create',
        '--title', title,
        '--body', body,
        '--base', base,
        '--head', branch,
      ]);
      output({ created: true, url: prUrl, branch, base, title }, 'pr-create');
    } catch (err) {
      forgeError('COMMAND_FAILED', `Failed to create PR: ${err.message}`, 'Verify the branch has been pushed and try again with: forge-tools pr-create <phase-id>', { branch, base });
    }
  },

  /**
   * Create a simplified GitHub PR for a quick task.
   */
  'quick-pr-create'(args) {
    const quickId = args.find(a => !a.startsWith('--'));
    const base = parseBase(args);

    if (!quickId) {
      forgeError('MISSING_ARG', 'Missing required argument: quick-id', 'Run: forge-tools quick-pr-create <quick-id> [--base=<branch>]');
    }
    validateId(quickId);

    const quick = unwrapBdArray(bdJsonArgs(['show', quickId]));
    const children = bdJsonArgs(['children', quickId]);
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
      const hint = 'A PR already exists for this branch. View it at: ' + existing;
      return output({ created: false, url: existing, branch, base, title, suggestion: hint }, 'quick-pr-create');
    }

    try {
      const prUrl = gh([
        'pr', 'create',
        '--title', title,
        '--body', body,
        '--base', base,
        '--head', branch,
      ]);
      // Persist PR URL in bead notes so the dashboard can display it
      bdArgs(['update', quickId, `--notes=PR: ${prUrl.trim()}`], { allowFail: true });
      output({ created: true, url: prUrl, branch, base, title }, 'quick-pr-create');
    } catch (err) {
      forgeError('COMMAND_FAILED', `Failed to create PR: ${err.message}`, 'Verify the branch has been pushed and try again with: forge-tools quick-pr-create <quick-id>', { branch, base });
    }
  },

  // =========================================================================
  // Backward-compat wrappers
  // =========================================================================

  /**
   * LEGACY: Create a git worktree for a milestone.
   * Delegates to the old behavior: .forge/worktrees/<milestoneId> with branch forge/m-<milestoneId>.
   * Kept for backward compatibility with existing workflows.
   */
  'worktree-create'(args) {
    const milestoneId = args[0];
    if (!milestoneId) {
      forgeError('MISSING_ARG', 'Missing required argument: milestone-id', 'Run: forge-tools worktree-create <milestone-id>');
    }
    // Legacy path: .forge/worktrees/<milestoneId> (no prefix)
    const wtPath = safeWorktreePath(null, milestoneId);
    const branch = `forge/m-${milestoneId}`;

    if (fs.existsSync(wtPath)) {
      const hint = 'Worktree already exists at ' + wtPath + '. Use it directly or remove with: forge-tools worktree-remove ' + milestoneId;
      output({ created: false, path: wtPath, branch, reason: 'already_exists', suggestion: hint }, 'worktree-create');
      return;
    }

    fs.mkdirSync(path.dirname(wtPath), { recursive: true });

    const branches = git(['branch', '--list', branch], { allowFail: true });
    if (!branches) {
      git(['branch', branch], { allowFail: true });
    }

    git(['worktree', 'add', wtPath, branch]);
    output({ created: true, path: wtPath, branch }, 'worktree-create');
  },

  /**
   * LEGACY: Create a branch for a phase.
   * Auto-looks up milestone and creates forge/m-<milestone>-phase-<phaseId> or forge/phase-<phaseId>.
   * Kept for backward compatibility with existing workflows.
   */
  'branch-create'(args) {
    const phaseId = args[0];
    if (!phaseId) {
      forgeError('MISSING_ARG', 'Missing required argument: phase-id', 'Run: forge-tools branch-create <phase-id>');
    }

    const deps = bdJsonArgs(['dep', 'list', phaseId]);
    const depList = Array.isArray(deps) ? deps : [];
    const parentDeps = depList.filter(d => d.dependency_type === 'parent-child');

    let milestoneId = null;
    for (const dep of parentDeps) {
      const item = unwrapBdArray(bdJsonArgs(['show', dep.id]));
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
      const hint = 'Branch ' + branch + ' already exists and has been checked out. Push with: forge-tools branch-push ' + branch;
      output({ created: false, branch, reason: 'already_exists', suggestion: hint }, 'branch-create');
      return;
    }

    git(['branch', branch]);
    git(['checkout', branch]);
    output({ created: true, branch, phaseId, milestoneId }, 'branch-create');
  },

  /**
   * LEGACY: Create a branch for a quick task.
   * Kept for backward compatibility with existing workflows.
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
      const hint = 'Branch ' + branch + ' already exists and has been checked out. Push with: forge-tools branch-push ' + branch;
      output({ created: false, branch, reason: 'already_exists', suggestion: hint }, 'quick-branch-create');
      return;
    }

    git(['branch', branch]);
    git(['checkout', branch]);
    output({ created: true, branch, quickId }, 'quick-branch-create');
  },
};
