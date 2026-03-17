'use strict';

/**
 * project-commands.cjs -- Project, debug, and todo commands.
 *
 * Commands: find-project, progress, project-context, project-context-slim, full-progress,
 *           save-session, load-session, health,
 *           debug-list, debug-create, debug-update, todo-list, todo-create,
 *           monorepo-create, remember, init-quick, status, help-context
 *
 * Also exports shared helpers: buildPhaseDetails, getRequirementCoverage,
 *                              collectProjectIssues, sortPhaseDetails, resolveProject
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const {
  bd, bdArgs, bdJsonArgs, output, forgeError, validateId, normalizeChildren,
  GLOBAL_SETTINGS_PATH, PROJECT_SETTINGS_NAME, SETTINGS_DEFAULTS,
  parseSimpleYaml, parseFrontmatter,
  resolveAgentModel,
  findGitRoot,
} = require('./core.cjs');
const { loadMergedSettings } = require('./settings-commands.cjs');


/**
 * Parse a bd create result to extract the bead ID.
 * Tries JSON first, falls back to regex match.
 */
function parseBdCreateId(result) {
  if (!result) return null;
  try {
    const data = JSON.parse(result);
    return data.id || data.issue_id || null;
  } catch {
    // INTENTIONALLY SILENT: bd create output format varies between versions;
    // fallback to regex extraction handles non-JSON output gracefully.
    const match = result.match(/([a-z]+-[a-z0-9]+)/);
    return match ? match[1] : null;
  }
}


/**
 * Stamp _sortKey on phase detail objects, sort, then clean up the transient key.
 */
function sortPhaseDetails(details) {
  for (const pd of details) {
    pd._sortKey = parseFloat((pd.title.match(/Phase\s+([\d.]+)/i) || [])[1]) || 999;
  }
  details.sort((a, b) => a._sortKey - b._sortKey);
  for (const pd of details) {
    delete pd._sortKey;
  }
  return details;
}

/**
 * Named color map (module-level constant for reuse).
 */
const COLOR_MAP = {
  red: '#e74c3c', orange: '#f39c12', yellow: '#f1c40f', green: '#2ecc71',
  blue: '#3498db', purple: '#9b59b6', cyan: '#00bcd4', pink: '#e91e63',
  indigo: '#6366f1', teal: '#14b8a6', amber: '#f59e0b', crimson: '#dc2626',
  magenta: '#d946ef', lime: '#84cc16', violet: '#8b5cf6', emerald: '#10b981',
  rose: '#f43f5e', sky: '#0ea5e9', slate: '#64748b', gray: '#6b7280',
  white: '#fafafa', gold: '#eab308',
};

/** Hex color pattern for validation */
const HEX_COLOR_RE = /^#[0-9a-fA-F]{3,6}$/;

/** Safe fallback color when an untrusted value fails validation */
const SAFE_FALLBACK_COLOR = '#8b949e';

/**
 * Expand simple glob patterns (e.g., "apps/*", "packages/*") to package directories.
 * Complex globs containing intermediate wildcards are skipped.
 */
function expandGlobs(patterns, root) {
  const results = [];
  for (const pattern of patterns) {
    const clean = pattern.replace(/\/\*\*?$/, '').replace(/\*$/, '');
    if (clean.includes('*')) continue; // skip complex globs
    const dir = path.join(root, clean);
    if (fs.statSync(dir, { throwIfNoEntry: false })?.isDirectory()) {
      // If the pattern ended with /*, list subdirectories
      if (pattern.endsWith('/*') || pattern.endsWith('/**')) {
        try {
          const entries = fs.readdirSync(dir, { withFileTypes: true });
          for (const entry of entries) {
            if (entry.isDirectory() && !entry.name.startsWith('.')) {
              const pkgPath = path.join(clean, entry.name);
              const pkgJsonPath = path.join(root, pkgPath, 'package.json');
              let name = entry.name;
              try {
                const pkg = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf8'));
                if (pkg.name) name = pkg.name;
              } catch { /* INTENTIONALLY SILENT: package.json is optional; dir name suffices */ }
              results.push({ name, path: pkgPath });
            }
          }
        } catch { /* INTENTIONALLY SILENT: unreadable directory entries are skipped during workspace detection */ }
      } else {
        // Direct path (no glob)
        const pkgJsonPath = path.join(root, clean, 'package.json');
        let name = path.basename(clean);
        try {
          const pkg = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf8'));
          if (pkg.name) name = pkg.name;
        } catch { /* INTENTIONALLY SILENT: package.json is optional; dir name suffices */ }
        results.push({ name, path: clean });
      }
    }
  }
  return results;
}

/**
 * Detect workspace packages from turbo.json, nx.json, or pnpm-workspace.yaml.
 * Returns { source: string, packages: Array<{ name: string, path: string }> }
 */
function detectWorkspaces(rootDir) {
  // Read root package.json once and reuse across all branches that need it
  let rootPkg = null;
  try {
    rootPkg = JSON.parse(fs.readFileSync(path.join(rootDir, 'package.json'), 'utf8'));
  } catch { /* INTENTIONALLY SILENT: root package.json is optional for workspace detection */ }

  // Try pnpm-workspace.yaml
  const pnpmPath = path.join(rootDir, 'pnpm-workspace.yaml');
  if (fs.existsSync(pnpmPath)) {
    try {
      const raw = fs.readFileSync(pnpmPath, 'utf8');
      // pnpm-workspace.yaml has: packages: ["apps/*", "packages/*"]
      // parseSimpleYaml may not handle arrays well, so parse manually
      const patterns = [];
      const lines = raw.split('\n');
      let inPackages = false;
      for (const line of lines) {
        if (/^packages\s*:/.test(line)) { inPackages = true; continue; }
        if (inPackages) {
          const m = line.match(/^\s*-\s*['"]?([^'"]+)['"]?\s*$/);
          if (m) patterns.push(m[1].trim());
          else if (line.trim() && !line.startsWith(' ') && !line.startsWith('\t')) break;
        }
      }
      if (patterns.length > 0) {
        return { source: 'pnpm-workspace.yaml', packages: expandGlobs(patterns, rootDir) };
      }
    } catch { /* INTENTIONALLY SILENT: pnpm-workspace.yaml parse failure falls through to other detection methods */ }
  }

  // Try turbo.json (Turborepo reads workspaces from package.json)
  const turboPath = path.join(rootDir, 'turbo.json');
  if (fs.existsSync(turboPath) && rootPkg) {
    const workspaces = Array.isArray(rootPkg.workspaces) ? rootPkg.workspaces : (rootPkg.workspaces?.packages || []);
    if (workspaces.length > 0) {
      return { source: 'turbo.json+package.json', packages: expandGlobs(workspaces, rootDir) };
    }
  }

  // Try nx.json
  const nxPath = path.join(rootDir, 'nx.json');
  if (fs.existsSync(nxPath) && rootPkg) {
    const workspaces = Array.isArray(rootPkg.workspaces) ? rootPkg.workspaces : (rootPkg.workspaces?.packages || []);
    if (workspaces.length > 0) {
      return { source: 'nx.json+package.json', packages: expandGlobs(workspaces, rootDir) };
    }
  }

  // Fallback: check package.json workspaces directly (yarn/npm workspaces)
  if (rootPkg) {
    const workspaces = Array.isArray(rootPkg.workspaces) ? rootPkg.workspaces : (rootPkg.workspaces?.packages || []);
    if (workspaces.length > 0) {
      return { source: 'package.json', packages: expandGlobs(workspaces, rootDir) };
    }
  }

  return { source: 'none', packages: [] };
}

/**
 * Extract workspace_path from a forge:project bead's design field.
 *
 * Two storage formats are supported:
 *   1. Nested map (monorepo parent): workspace_paths keyed by child bead ID
 *        workspace_paths:
 *          <bead-id>: packages/app1
 *   2. Flat field (child project beads):
 *        workspace_path: packages/app1
 *
 * Bead IDs match [a-z]+-[a-z0-9]+ and therefore never contain colons,
 * so YAML key parsing is unambiguous.
 *
 * Lookup cascade: (1) keyed by bead.id in workspace_paths, (2) flat workspace_path.
 * No sole-entry shortcut — a missing key means "not this bead's entry".
 *
 * Returns the path string for this bead, or null if not found.
 */
function extractWorkspacePath(bead) {
  if (!bead || !bead.design) return null;
  const parsed = parseSimpleYaml(bead.design);
  if (parsed.workspace_paths && typeof parsed.workspace_paths === 'object') {
    // workspace_paths is keyed by bead ID — look up this bead's own entry only
    if (parsed.workspace_paths[bead.id] !== undefined) {
      return String(parsed.workspace_paths[bead.id]);
    }
  }
  // Fallback: check for a flat workspace_path field (used by child project beads)
  if (parsed.workspace_path) return String(parsed.workspace_path);
  return null;
}

/**
 * Resolve the current project by auto-detecting from beads.
 * Returns { id, title } or null if no project found.
 * Uses workspace_path matching for monorepo disambiguation.
 */
function resolveProject() {
  const result = bd('list --label forge:project --json', { allowFail: true });
  if (!result) return null;
  try {
    const data = JSON.parse(result);
    const issues = Array.isArray(data) ? data : (data.issues || []);
    if (issues.length === 0) return null;
    if (issues.length === 1) {
      return { id: issues[0].id, title: issues[0].title || issues[0].subject };
    }
    // Multiple projects -- resolve by cwd workspace path match
    const cwd = process.cwd();
    const gitRoot = findGitRoot(cwd);
    if (gitRoot) {
      const relPath = path.relative(gitRoot, cwd).split(path.sep).join('/');
      for (const p of issues) {
        const wp = extractWorkspacePath(p);
        if (!wp) continue;
        const norm = path.normalize(wp.replace(/\/+$/, ''));
        if (norm.includes('..')) continue;
        if (relPath === norm || relPath.startsWith(norm + '/')) {
          return { id: p.id, title: p.title || p.subject };
        }
      }
    }
    // Fallback to first project
    return { id: issues[0].id, title: issues[0].title || issues[0].subject };
  } catch {
    // INTENTIONALLY SILENT: bd list parse failure means no project can be resolved;
    // returning null lets callers handle the missing-project case explicitly.
    return null;
  }
}

/**
 * Collect all phases and requirements for a project, traversing milestones.
 * Hierarchy: Project > Milestone > Phase > Requirement (3-level)
 * Also picks up any phases/reqs still directly under the project (legacy).
 * Legacy fallback: reqs found as direct milestone children are also included
 * for backward compatibility with closed milestones.
 *
 * Returns:
 *   - milestones: raw milestone beads (for backward compat)
 *   - phases: flat array of all phases across milestones (for backward compat)
 *   - requirements: flat array of all requirements across milestones (for backward compat)
 *   - milestoneDetails: array of milestone objects with nested phases/requirements,
 *     each including { id, title, status, goal, phases, requirements, progress,
 *     phase_count, completed_count }
 */
function collectProjectIssues(projectId) {
  const issues = normalizeChildren(bdJsonArgs(['children', projectId]));

  const milestones = issues.filter(i => (i.labels || []).includes('forge:milestone'));
  const phases = [];
  const requirements = [];
  const seenIds = new Set();

  // Per-milestone grouping
  const milestoneDetails = [];

  const classifyIssue = (item) => {
    if ((item.labels || []).includes('forge:phase')) return 'phase';
    if ((item.labels || []).includes('forge:req')) return 'req';
    if ((item.labels || []).includes('forge:quick')) return 'quick';
    return null;
  };

  // Quick tasks (direct children of project with forge:quick label)
  const quickTasks = [];

  // Collect from milestones (3-level: milestone -> phase -> req) with per-milestone grouping
  for (const ms of milestones) {
    const msIssues = normalizeChildren(bdJsonArgs(['children', ms.id]));

    const msPhases = [];
    const msReqs = [];

    for (const i of msIssues) {
      if (seenIds.has(i.id)) continue;
      seenIds.add(i.id);
      const kind = classifyIssue(i);
      if (kind === 'phase') {
        phases.push(i); msPhases.push(i);
        // Traverse phase children to find forge:req beads (3-level hierarchy)
        const phaseChildren = normalizeChildren(bdJsonArgs(['children', i.id]));
        for (const pc of phaseChildren) {
          if (seenIds.has(pc.id)) continue;
          seenIds.add(pc.id);
          if (classifyIssue(pc) === 'req') {
            requirements.push(pc); msReqs.push(pc);
          }
        }
      }
      // Legacy fallback: reqs found as direct milestone children (old data)
      else if (kind === 'req') { requirements.push(i); msReqs.push(i); }
    }

    const completedCount = msPhases.filter(p => p.status === 'closed').length;
    const phaseCount = msPhases.length;

    milestoneDetails.push({
      id: ms.id,
      title: ms.title,
      status: ms.status,
      goal: ms.description || '',
      phases: msPhases,
      requirements: msReqs,
      progress: phaseCount > 0 ? Math.round((completedCount / phaseCount) * 100) : 0,
      phase_count: phaseCount,
      completed_count: completedCount,
    });
  }

  // Also collect any legacy direct children (not already seen via milestones)
  const legacyPhases = [];
  const legacyReqs = [];
  for (const i of issues) {
    if (seenIds.has(i.id)) continue;
    seenIds.add(i.id);
    const kind = classifyIssue(i);
    if (kind === 'phase') { phases.push(i); legacyPhases.push(i); }
    else if (kind === 'req') { requirements.push(i); legacyReqs.push(i); }
    else if (kind === 'quick') {
      const children = normalizeChildren(bdJsonArgs(['children', i.id]));
      const prMatch = (i.notes || '').match(/PR:\s*(https?:\/\/\S+)/);
      quickTasks.push({
        id: i.id,
        title: i.title,
        status: i.status,
        description: i.description || '',
        children: children.map(c => ({ id: c.id, title: c.title, status: c.status })),
        prUrl: prMatch ? prMatch[1] : null,
      });
    }
  }

  // If there are legacy items not under any milestone, group them as "Ungrouped"
  if (legacyPhases.length > 0 || legacyReqs.length > 0) {
    const completedCount = legacyPhases.filter(p => p.status === 'closed').length;
    const phaseCount = legacyPhases.length;
    milestoneDetails.push({
      id: '_ungrouped',
      title: 'Ungrouped',
      status: 'open',
      goal: '',
      phases: legacyPhases,
      requirements: legacyReqs,
      progress: phaseCount > 0 ? Math.round((completedCount / phaseCount) * 100) : 0,
      phase_count: phaseCount,
      completed_count: completedCount,
    });
  }

  return { milestones, phases, requirements, milestoneDetails, quickTasks };
}

/**
 * Build phase detail objects for a list of phases.
 * When includeMeta is true, also fetches description and per-task acceptance_criteria
 * (used by generate-dashboard but not full-progress).
 */
function buildPhaseDetails(phases, { includeMeta = false } = {}) {
  // Fetch all phase completion timestamps in one call
  let completionTimestamps = {};
  if (includeMeta) {
    const raw = bd('memories forge:phase:', { allowFail: true }) || '';
    for (const line of raw.split('\n')) {
      const match = line.match(/forge:phase:([\w-]+):completed\s+(\S+)/);
      if (match) completionTimestamps[match[1]] = match[2];
    }
  }

  // TODO(perf): N+1 subprocess -- calls bd children per phase. Needs bd CLI batch-query support.
  const details = [];
  for (const phase of phases) {
    const tasks = normalizeChildren(bdJsonArgs(['children', phase.id]));
    const entry = {
      id: phase.id,
      title: phase.title,
      status: phase.status,
      tasks_total: tasks.length,
      tasks_open: tasks.filter(t => t.status === 'open').length,
      tasks_in_progress: tasks.filter(t => t.status === 'in_progress').length,
      tasks_closed: tasks.filter(t => t.status === 'closed').length,
      tasks: includeMeta
        ? tasks.map(t => ({ id: t.id, title: t.title, status: t.status, description: t.description || '', acceptance_criteria: t.acceptance_criteria || '' }))
        : tasks.map(t => ({ id: t.id, title: t.title, status: t.status })),
    };
    if (includeMeta) {
      entry.description = phase.description || '';
      entry.completed_at = completionTimestamps[phase.id] || '';
    }
    details.push(entry);
  }
  return details;
}

/**
 * Build requirement coverage objects for a list of requirements.
 * Returns an array of { id, title, covered, covering_tasks }.
 */
function getRequirementCoverage(requirements) {
  // TODO(perf): N+1 subprocess -- calls bd dep list per requirement. Needs bd CLI batch-query support.
  const coverage = [];
  for (const req of requirements) {
    const depsRaw = bdArgs(['dep', 'list', req.id, '--direction=up', '--type', 'validates', '--json'], { allowFail: true });
    let deps = [];
    if (depsRaw) {
      // INTENTIONALLY SILENT: bd dep list may return non-JSON when no deps exist.
      try { deps = JSON.parse(depsRaw); } catch { /* allowFail JSON parse fallback */ }
    }
    coverage.push({
      id: req.id,
      title: req.title,
      covered: Array.isArray(deps) && deps.length > 0,
      covering_tasks: Array.isArray(deps) ? deps.length : 0,
    });
  }
  return coverage;
}
module.exports = {
  /**
   * Find the project bead in the current beads database.
   */
  'find-project'(args) {
    // Explicit project argument takes precedence.
    if (args && args.length > 0) {
      const projectId = args[0];
      output({ found: true, project_id: projectId, source: 'argument' }, 'find-project');
      return;
    }

    const result = bd('list --label forge:project --json', { allowFail: true });
    if (result) {
      try {
        const data = JSON.parse(result);
        const issues = Array.isArray(data) ? data : (data.issues || []);
        if (issues.length === 1) {
          // Single project — backward compat, return it directly
          const project = issues[0];
          output({ found: true, project_id: project.id, project_title: project.title || project.subject, projects: issues, source: 'beads' }, 'find-project');
          return;
        }
        if (issues.length > 1) {
          // Multiple projects (monorepo) — resolve by cwd longest-prefix match
          const cwd = process.cwd();
          const gitRoot = findGitRoot(cwd);
          if (gitRoot) {
            const relPath = path.relative(gitRoot, cwd).split(path.sep).join('/');
            // Pre-compute workspace paths (O(N) scan is intentional at current monorepo scale)
            const wpMap = new Map(issues.map(p => [p.id, extractWorkspacePath(p)]));
            let bestMatch = null;
            let bestLen = -1;
            for (const project of issues) {
              const wp = wpMap.get(project.id);
              if (!wp) continue;
              const normalizedWp = path.normalize(wp.replace(/\/+$/, ''));
              // Reject paths that escaped the repo root via ".."
              if (normalizedWp.includes('..')) continue;
              // Check if relPath starts with this workspace_path
              if (relPath === normalizedWp || relPath.startsWith(normalizedWp + '/')) {
                if (normalizedWp.length > bestLen) {
                  bestLen = normalizedWp.length;
                  bestMatch = project;
                }
              }
            }
            if (bestMatch) {
              output({ found: true, project_id: bestMatch.id, project_title: bestMatch.title || bestMatch.subject, projects: issues, source: 'cwd_monorepo' }, 'find-project');
              return;
            }

            // No child matched — return forge:monorepo parent if one exists (only when inside a git repo)
            const monoResult = bd('list --label forge:monorepo --json', { allowFail: true });
            if (monoResult) {
              try {
                const monoData = JSON.parse(monoResult);
                const monoIssues = Array.isArray(monoData) ? monoData : (monoData.issues || []);
                if (monoIssues.length > 0) {
                  const mono = monoIssues[0];
                  output({ found: true, project_id: mono.id, project_title: mono.title || mono.subject, projects: issues, source: 'monorepo_parent' }, 'find-project');
                  return;
                }
              } catch { /* INTENTIONALLY SILENT: monorepo lookup failure falls through to first-project fallback */ }
            }
            // Still no match — return first project as last resort (only inside a git repo)
            const firstProject = issues[0];
            output({ found: true, project_id: firstProject.id, project_title: firstProject.title || firstProject.subject, projects: issues, source: 'beads' }, 'find-project');
            return;
          }
          // Outside a git repo — skip monorepo lookup; return first project
          const project = issues[0];
          output({ found: true, project_id: project.id, project_title: project.title || project.subject, projects: issues, source: 'beads' }, 'find-project');
          return;
        }
      } catch {
        // INTENTIONALLY SILENT: bd list JSON parse failure falls through to cwd settings check
      }
    }

    // Fallback: check .forge/settings.yaml in cwd for a project_id field.
    const settingsPath = path.join(process.cwd(), '.forge', 'settings.yaml');
    if (fs.existsSync(settingsPath)) {
      try {
        const raw = fs.readFileSync(settingsPath, 'utf8');
        const settings = parseSimpleYaml(raw);
        if (settings && settings.project_id) {
          output({ found: true, project_id: settings.project_id, source: 'cwd_settings' }, 'find-project');
          return;
        }
      } catch {
        // INTENTIONALLY SILENT: settings YAML parse failure falls through to found:false
      }
    }

    output({
      found: false,
      suggestion: 'Run /forge:new to initialize a project, or check that bd is running with: bd list'
    }, 'find-project');
  },

  /**
   * Record a project memory (wraps bd remember).
   */
  remember(args) {
    const memory = args.join(' ');
    if (!memory) {
      forgeError('MISSING_ARG', 'Missing required argument: text', 'Run: forge-tools remember <text-to-remember>');
    }
    bdArgs(['remember', ...args]);
    output({ ok: true, memory }, 'find-project');
  },

  /**
   * Get full project context for a workflow.
   */
  'project-context'(args) {
    const projectId = args[0];
    if (!projectId) {
      forgeError('MISSING_ARG', 'Missing required argument: project-bead-id', 'Run: forge-tools project-context <project-bead-id>');
    }
    validateId(projectId);

    const project = bdJsonArgs(['show', projectId]);
    const { phases, requirements } = collectProjectIssues(projectId);

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
    }, 'project-context');
  },

  /**
   * Get slim project context for phase resolution.
   * Returns project bead (id, title, status, description) plus phases and
   * requirements mapped to {id, title, status, description_first_line}.
   * Drastically smaller than project-context (~15KB vs ~135KB).
   */
  'project-context-slim'(args) {
    const projectId = args[0];
    if (!projectId) {
      forgeError('MISSING_ARG', 'Missing required argument: project-bead-id', 'Run: forge-tools project-context-slim <project-bead-id>');
    }
    validateId(projectId);

    const project = bdJsonArgs(['show', projectId]);
    const { phases, requirements } = collectProjectIssues(projectId);

    // Truncate descriptions to save tokens while keeping enough context for display
    const DESC_PREVIEW_CHARS = 80;
    const firstLine = (desc) => {
      if (!desc) return '';
      const line = desc.split('\n')[0].trim();
      if (line.length <= DESC_PREVIEW_CHARS) return line;
      return line.slice(0, DESC_PREVIEW_CHARS - 3) + '...';
    };

    const slim = (item) => ({
      id: item.id,
      title: item.title,
      status: item.status,
      description_first_line: firstLine(item.description),
    });

    // Compact output: top-level structure readable, array items as single-line
    // JSON to keep total payload small.
    const projectSlim = {
      id: project?.id,
      title: project?.title,
      status: project?.status,
      description: project?.description,
    };
    const reqSlim = requirements.map(slim);
    const phaseSlim = phases.map(slim);
    let closed = 0, inProgress = 0;
    for (const p of phases) {
      if (p.status === 'closed') closed++;
      else if (p.status === 'in_progress') inProgress++;
    }
    const summary = {
      total_requirements: requirements.length,
      total_phases: phases.length,
      phases_complete: closed,
      phases_in_progress: inProgress,
    };
    // Intentionally compact (not pretty-printed) to minimise token payload — do not switch to output()
    const toJsonLine = (o) => JSON.stringify(o);
    const out = `{"project":${toJsonLine(projectSlim)},"requirements":[${reqSlim.map(toJsonLine).join(',')}],"phases":[${phaseSlim.map(toJsonLine).join(',')}],"summary":${toJsonLine(summary)}}`;
    process.stdout.write(out + '\n');
  },

  /**
   * Get progress summary for a project.
   */
  progress(args) {
    const projectId = args[0];
    if (!projectId) {
      forgeError('MISSING_ARG', 'Missing required argument: project-bead-id', 'Run: forge-tools progress <project-bead-id>');
    }
    validateId(projectId);

    const project = bdJsonArgs(['show', projectId]);
    const { phases } = collectProjectIssues(projectId);

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
    }, 'progress');
  },

  /**
   * Get comprehensive progress with per-phase task breakdowns for the dashboard.
   */
  'full-progress'(args) {
    const projectId = args[0];
    if (!projectId) {
      forgeError('MISSING_ARG', 'Missing required argument: project-bead-id', 'Run: forge-tools full-progress <project-bead-id>');
    }
    validateId(projectId);

    const project = bdJsonArgs(['show', projectId]);
    const { phases, requirements } = collectProjectIssues(projectId);

    const phaseDetails = buildPhaseDetails(phases);
    const reqCoverage = getRequirementCoverage(requirements);

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
      phases: phaseDetails,
      requirements: {
        total: requirements.length,
        covered: reqCoverage.filter(r => r.covered).length,
        uncovered: reqCoverage.filter(r => !r.covered).map(r => ({ id: r.id, title: r.title })),
        details: reqCoverage,
      },
      memories: memories || null,
    }, 'progress');
  },

  /**
   * Save session state for forge:pause.
   */
  'save-session'(args) {
    const projectId = args[0];
    if (!projectId) {
      forgeError('MISSING_ARG', 'Missing required argument: project-bead-id', 'Run: forge-tools save-session <project-bead-id>');
    }
    validateId(projectId);

    const { phases } = collectProjectIssues(projectId);

    const currentPhase = phases.find(p => p.status === 'in_progress') || phases.find(p => p.status === 'open');
    const completedPhases = phases.filter(p => p.status === 'closed').length;

    // TODO(perf): N+1 subprocess -- calls bd children per non-closed phase. Needs bd CLI batch-query support.
    const inProgressTasks = [];
    for (const phase of phases) {
      if (phase.status === 'closed') continue;
      const tasks = normalizeChildren(bdJsonArgs(['children', phase.id]));
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

    const memoryKey = 'forge:session:state';
    const memoryValue = `${timestamp} project=${projectId} phase=${sessionData.current_phase || 'none'} progress=${completedPhases}/${phases.length} in_flight=${inProgressTasks.map(t => t.id).join(',')}`;
    bdArgs(['remember', '--key', memoryKey, memoryValue], { allowFail: true });

    output({ saved: true, session: sessionData }, 'session-save');
  },

  /**
   * Load session state for forge:resume.
   */
  'load-session'() {
    const memories = bd('memories forge:session', { allowFail: true });

    const projectResult = bd('list --label forge:project --json', { allowFail: true });
    let project = null;
    if (projectResult) {
      try {
        const data = JSON.parse(projectResult);
        const issues = Array.isArray(data) ? data : (data.issues || []);
        if (issues.length > 0) project = issues[0];
      } catch { /* INTENTIONALLY SILENT: non-JSON bd output falls back to no-project path */ }
    }

    if (!project) {
      output({
        found: false,
        memories: memories || null,
        suggestion: 'No project found. Run /forge:new to create a project, then /forge:plan to set up phases before resuming'
      }, 'session-load');
      return;
    }

    const { phases } = collectProjectIssues(project.id);
    const currentPhase = phases.find(p => p.status === 'in_progress') || phases.find(p => p.status === 'open');

    const inProgressTasks = [];
    if (currentPhase) {
      const tasks = normalizeChildren(bdJsonArgs(['children', currentPhase.id]));
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
    }, 'session-load');
  },

  /**
   * Diagnose project health.
   */
  health(args) {
    const projectId = args[0];
    if (!projectId) {
      forgeError('MISSING_ARG', 'Missing required argument: project-bead-id', 'Run: forge-tools health <project-bead-id>');
    }
    validateId(projectId);

    let project;
    try {
      project = bdJsonArgs(['show', projectId]);
    } catch { /* INTENTIONALLY SILENT — bd show exits non-zero for missing IDs; handled below */ }
    if (!project) {
      forgeError('NOT_FOUND', `Project not found: ${projectId}`, 'Verify the project ID with: forge-tools find-project, or run /forge:new to create a new project', { project_id: projectId });
    }

    const { phases, requirements } = collectProjectIssues(projectId);

    const diagnostics = { structure: [], dependencies: [], state: [], config: [], installation: [], orphans: [] };

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

    // TODO(perf): N+1 subprocess -- calls bd children per phase. Needs bd CLI batch-query support.
    // Cache phase children once for reuse in task-labels and closeable-phase loops.
    const phaseChildrenMap = new Map();
    for (const phase of phases) {
      const tasks = normalizeChildren(bdJsonArgs(['children', phase.id]));
      phaseChildrenMap.set(phase.id, tasks);
    }

    const allTasks = [];
    const unlabeledTasks = [];
    for (const phase of phases) {
      const tasks = phaseChildrenMap.get(phase.id);
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

    const uncoveredReqs = [];
    for (const req of requirements) {
      const deps = bdArgs(['dep', 'list', req.id, '--direction=up', '--type', 'validates'], { allowFail: true });
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

    const closedPhasesWithOpenTasks = [];
    const closeablePhases = [];
    for (const phase of phases) {
      const tasks = phaseChildrenMap.get(phase.id);
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

    const configIssues = [];
    const numericKeys = ['context_warning', 'context_critical'];
    const booleanKeys = ['update_check', 'auto_research'];

    for (const key of numericKeys) {
      const val = bdArgs(['kv', 'get', `forge.${key}`], { allowFail: true });
      if (val && val.trim() !== '') {
        const num = parseFloat(val.trim());
        if (isNaN(num) || num < 0 || num > 1) {
          configIssues.push({ key: `forge.${key}`, value: val.trim(), reason: 'must be a number between 0 and 1' });
        }
      }
    }

    for (const key of booleanKeys) {
      const val = bdArgs(['kv', 'get', `forge.${key}`], { allowFail: true });
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

    let globalSettingsOk = true;
    let globalSettingsMessage = '';
    if (fs.existsSync(GLOBAL_SETTINGS_PATH)) {
      try {
        const globalText = fs.readFileSync(GLOBAL_SETTINGS_PATH, 'utf8');
        const globalSettings = parseFrontmatter(globalText);
        const EXTRA_KNOWN_KEYS = new Set(['models', 'model_profile']);
        const unknownKeys = Object.keys(globalSettings).filter(k => !(k in SETTINGS_DEFAULTS) && !EXTRA_KNOWN_KEYS.has(k));
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
      } catch { /* INTENTIONALLY SILENT: invalid or missing JSON data is handled by null fallback */ }
    }

    diagnostics.installation.push({
      check: 'version_file',
      ok: versionOk,
      message: versionOk
        ? `Version file valid (v${versionInfo.version})`
        : 'Version file missing or invalid',
      severity: versionOk ? 'ok' : 'warning',
    });

    // Orphan detection: find forge-labeled beads with no parent-child dependency.
    // TODO(perf): N+1 subprocess -- calls bd dep list per unknown-parent bead. Needs bd CLI batch-query support.
    // Use phaseChildrenMap to skip beads already known to have parents (reduces N+1 impact).
    const beadsWithKnownParent = new Set();
    for (const [, phaseTasks] of phaseChildrenMap) {
      for (const t of phaseTasks) {
        beadsWithKnownParent.add(t.id);
      }
    }
    // Phases that are children of milestones are also known to have parents
    // (they were fetched via bdJsonArgs(['children', ms.id]) in the milestone traversal above).

    const orphans = [];
    const forgeBeads = [
      ...phases.map(p => ({ ...p, forge_label: 'forge:phase' })),
      ...allTasks.filter(t => (t.labels || []).includes('forge:task')).map(t => ({ ...t, forge_label: 'forge:task' })),
    ];
    for (const bead of forgeBeads) {
      // Skip beads already known to have a parent from phaseChildrenMap
      if (beadsWithKnownParent.has(bead.id)) continue;
      const depOutput = bdArgs(['dep', 'list', bead.id, '--direction=up', '--type=parent-child'], { allowFail: true });
      const hasParent = depOutput && depOutput.trim() !== '' && !depOutput.includes('No dependencies');
      if (!hasParent) {
        // Suggest the project itself as parent for phases, or the phase for tasks
        const suggestedParent = bead.forge_label === 'forge:phase' ? projectId : (bead.phase_id || projectId);
        orphans.push({
          id: bead.id,
          title: bead.title,
          label: bead.forge_label,
          suggested_fix: `bd dep add ${bead.id} ${suggestedParent} --type=parent-child`,
        });
      }
    }

    diagnostics.orphans.push({
      check: 'orphan_beads',
      ok: orphans.length === 0,
      message: orphans.length === 0
        ? 'No orphan beads found'
        : `${orphans.length} orphan bead(s) found without parent-child dependency`,
      severity: orphans.length > 0 ? 'warning' : 'ok',
      details: orphans,
    });

    const allChecks = [
      ...diagnostics.structure,
      ...diagnostics.dependencies,
      ...diagnostics.state,
      ...diagnostics.config,
      ...diagnostics.installation,
      ...diagnostics.orphans,
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
    }, 'health');
  },

  /**
   * List active debug sessions.
   */
  'debug-list'() {
    const result = bd('list --label forge:debug --status open --json', { allowFail: true });
    const debugHint = 'No active debug sessions. Start one with: forge-tools debug-create <slug>';
    if (!result) {
      output({ sessions: [], suggestion: debugHint }, 'debug-sessions');
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
      output({ sessions }, 'debug-sessions');
    } catch {
      // INTENTIONALLY SILENT: bd list JSON parse failure returns empty set with suggestion.
      // This is not a fatal error -- the user simply has no debug sessions.
      output({ sessions: [], suggestion: debugHint }, 'debug-sessions');
    }
  },

  /**
   * Create a new debug session bead.
   */
  'debug-create'(args) {
    const slug = args[0] || 'debug-session';
    const description = args.slice(1).join(' ') || '';
    const title = `Debug: ${slug}`;

    const result = bdArgs(['create', `--title=${title}`, `--description=${description}`, '--type=task', '--json']);
    if (!result) {
      forgeError('COMMAND_FAILED', 'Failed to create debug bead', 'Check bd connectivity with: bd list --limit 1');
    }

    const debugId = parseBdCreateId(result);

    if (!debugId) {
      forgeError('COMMAND_FAILED', 'Failed to parse debug bead ID from bd output', 'Check bd connectivity and try again', { rawOutput: result });
    }

    bdArgs(['label', 'add', debugId, 'forge:debug'], { allowFail: true });
    bdArgs(['update', debugId, '--status=in_progress'], { allowFail: true });

    output({ debug_id: debugId, slug }, 'debug-create');
  },

  /**
   * Update a debug session bead's notes or design fields.
   */
  'debug-update'(args) {
    const id = args[0];
    const field = args[1];
    const value = args.slice(2).join(' ');

    if (!id || !field) {
      forgeError('MISSING_ARG', 'Missing required arguments: id and field', 'Run: forge-tools debug-update <id> <field> <value>');
    }
    validateId(id);

    if (field === 'notes') {
      bdArgs(['update', id, `--notes=${value}`], { allowFail: true });
    } else if (field === 'design') {
      bdArgs(['update', id, `--design=${value}`], { allowFail: true });
    } else if (field === 'status') {
      const validStatuses = ['open', 'in_progress', 'closed', 'blocked', 'deferred'];
      if (!validStatuses.includes(value)) {
        forgeError('INVALID_INPUT', `Invalid status: ${value}`, `Must be one of: ${validStatuses.join(', ')}`, { value, validStatuses });
      }
      bdArgs(['update', id, `--status=${value}`], { allowFail: true });
    } else {
      forgeError('INVALID_INPUT', `Unknown field: ${field}`, 'Valid fields are: notes, design, status', { field });
    }

    output({ updated: true, id }, 'debug-update');
  },

  /**
   * List pending forge:todo beads.
   */
  'todo-list'() {
    const todoHint = 'No open todos. Create one with: forge-tools todo-create <project-id> <title>';
    const result = bd('list --label forge:todo --status open --json', { allowFail: true });
    if (!result) {
      output({ todo_count: 0, todos: [], suggestion: todoHint }, 'todo-list');
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
      output({ todo_count: todos.length, todos }, 'todo-list');
    } catch {
      // INTENTIONALLY SILENT: bd list JSON parse failure returns empty set with suggestion.
      // This is not a fatal error -- the user simply has no todos.
      output({ todo_count: 0, todos: [], suggestion: todoHint }, 'todo-list');
    }
  },

  /**
   * Create a new forge:todo bead under a project.
   */
  'todo-create'(args) {
    const projectId = args[0];
    const title = args[1];
    const description = args[2] || '';
    const area = args[3] || 'general';
    const files = args[4] || '';

    if (!projectId || !title) {
      forgeError('MISSING_ARG', 'Missing required arguments: project-id and title', 'Run: forge-tools todo-create <project-id> <title> [description] [area] [files]');
    }
    validateId(projectId);

    const descParts = [description];
    if (area) descParts.push(`Area: ${area}`);
    if (files) descParts.push(`Files: ${files}`);
    const fullDesc = descParts.filter(Boolean).join('\n');

    const result = bdArgs(['create', `--title=${title}`, `--description=${fullDesc}`, '--type=task', '--priority=3', '--json']);
    if (!result) {
      forgeError('COMMAND_FAILED', 'Failed to create todo bead', 'Check bd connectivity with: bd list --limit 1');
    }

    const todoId = parseBdCreateId(result);

    if (!todoId) {
      forgeError('COMMAND_FAILED', 'Failed to parse todo bead ID from bd output', 'Check bd connectivity and try again', { rawOutput: result });
    }

    bdArgs(['label', 'add', todoId, 'forge:todo'], { allowFail: true });
    bdArgs(['dep', 'add', todoId, projectId, '--type=parent-child'], { allowFail: true });

    output({ todo_id: todoId }, 'todo-create');
  },

  /**
   * Create a monorepo parent bead and child project beads for each workspace.
   */
  'monorepo-create'(args) {
    const name = args.join(' ').trim();
    if (!name) {
      forgeError('MISSING_ARG', 'Missing required argument: monorepo-name', 'Run: forge-tools monorepo-create <monorepo-name>');
    }

    // 1. Detect workspace packages
    const rootDir = process.cwd();
    const detected = detectWorkspaces(rootDir);

    // 2. Create monorepo parent bead
    const title = name;
    const createRaw = bdArgs(['create', `--title=${title}`, '--type=epic', '--priority=1', '--json']);
    let created;
    // INTENTIONALLY SILENT: bd create output format varies; null fallback triggers forgeError below.
    try { created = JSON.parse(createRaw); if (Array.isArray(created)) created = created[0]; } catch { created = null; }
    if (!created || !created.id) {
      forgeError('COMMAND_FAILED', 'Failed to create monorepo bead', 'Check bd connectivity with: bd list --limit 1');
    }

    bdArgs(['label', 'add', created.id, 'forge:monorepo']);

    // 3. Create child forge:project beads for each detected package
    // Children use flat workspace_path; the parent's workspace_paths map uses child bead IDs as keys.
    const children = [];
    for (const pkg of detected.packages) {
      const childRaw = bdArgs(['create', `--title=${pkg.name}`, '--type=epic', '--priority=2', '--json']);
      let child;
      // INTENTIONALLY SILENT: bd create output format varies; null fallback skips this package.
      try { child = JSON.parse(childRaw); if (Array.isArray(child)) child = child[0]; } catch { child = null; }
      if (!child || !child.id) continue;

      bdArgs(['label', 'add', child.id, 'forge:project']);
      bdArgs(['dep', 'add', child.id, created.id, '--type=parent-child']);
      // Child stores a flat workspace_path for direct lookup via extractWorkspacePath
      bdArgs(['update', child.id, `--design=workspace_path: ${pkg.path}`]);
      children.push({ id: child.id, name: pkg.name, path: pkg.path });
    }

    // Store workspace paths in the parent's design field keyed by child bead ID
    // so that extractWorkspacePath(parentBead) can resolve correctly when called
    // with a bead whose ID matches a child's ID.
    if (children.length > 0) {
      const yamlLines = ['workspace_paths:'];
      for (const child of children) {
        yamlLines.push(`  ${child.id}: ${child.path}`);
      }
      bdArgs(['update', created.id, `--design=${yamlLines.join('\n')}`]);
    }

    output({
      ok: true,
      monorepo_id: created.id,
      title,
      detection_source: detected.source,
      children,
    }, 'monorepo-init');
  },

  'init-quick'(args) {
    const description = args.join(' ').trim() || null;

    const projectResult = bd('list --label forge:project --json', { allowFail: true });
    let project = null;
    if (projectResult) {
      try {
        const data = JSON.parse(projectResult);
        const issues = Array.isArray(data) ? data : (data.issues || []);
        if (issues.length > 0) project = issues[0];
      } catch { /* INTENTIONALLY SILENT: non-JSON bd output falls back to empty/null */ }
    }

    const models = {
      planner: resolveAgentModel('forge-planner'),
      executor: resolveAgentModel('forge-executor'),
      plan_checker: resolveAgentModel('forge-plan-checker'),
      verifier: resolveAgentModel('forge-verifier'),
    };

    const { merged } = loadMergedSettings();

    output({
      found: !!project,
      project_id: project ? project.id : null,
      project_title: project ? project.title : null,
      description,
      models,
      settings: merged,
    }, 'monorepo-detect');
  },

  /**
   * Session orientation status: project, milestone, phase, tasks, context,
   * and suggested next action in a single JSON payload.
   *
   * Usage: forge-tools status [project-id]
   */
  status(args) {
    // 1. Find project (use argument or auto-detect via shared helper)
    let projectId = args[0] || null;
    let projectTitle = null;

    // Validate user-supplied ID to prevent injection
    if (projectId) {
      validateId(projectId);
    }

    if (!projectId) {
      const resolved = resolveProject();
      if (resolved) {
        projectId = resolved.id;
        projectTitle = resolved.title;
      }
    }

    if (!projectId) {
      forgeError('NO_PROJECT', 'No Forge project found', 'Run /forge:new to create a project');
    }

    // Fetch project bead if title not yet resolved
    if (!projectTitle) {
      const proj = bdJsonArgs(['show', projectId]);
      projectTitle = proj?.title || proj?.subject || projectId;
    }

    // 2. Collect milestones, phases, and find current phase
    const { milestoneDetails, phases } = collectProjectIssues(projectId);

    // Find active milestone (first in_progress, then first open)
    const activeMilestone = milestoneDetails.find(m => m.status === 'in_progress')
      || milestoneDetails.find(m => m.status === 'open')
      || (milestoneDetails.length > 0 ? milestoneDetails[0] : null);

    // Find current phase across all phases (in_progress first, then first open)
    const currentPhase = phases.find(p => p.status === 'in_progress')
      || phases.find(p => p.status === 'open')
      || null;

    // 3. Get task summary for the current phase
    let tasks = { total: 0, ready: 0, in_progress: 0, blocked: 0, done: 0 };
    if (currentPhase) {
      const children = normalizeChildren(bdJsonArgs(['children', currentPhase.id]));
      const open = children.filter(t => t.status === 'open').length;
      const inProgress = children.filter(t => t.status === 'in_progress').length;
      const closed = children.filter(t => t.status === 'closed').length;
      const blocked = children.filter(t => t.status === 'blocked').length;
      tasks = {
        total: children.length,
        ready: open,
        in_progress: inProgress,
        blocked,
        done: closed,
      };
    }

    // 4. Read bridge file for context %
    const bridgePath = path.join(os.tmpdir(), 'forge-context-bridge.json');
    let contextPercent = null;
    let bridgeNote = null;

    try {
      const raw = fs.readFileSync(bridgePath, 'utf8');
      const bridge = JSON.parse(raw);
      const ageMs = Date.now() - (bridge.timestamp || 0);
      const STALE_THRESHOLD_MS = 5 * 60 * 1000; // 5 minutes

      if (ageMs > STALE_THRESHOLD_MS) {
        bridgeNote = `Bridge data is stale (${Math.round(ageMs / 60000)} min old)`;
      } else {
        if (bridge.current_usage !== undefined) {
          contextPercent = Math.round(bridge.current_usage * 100);
        } else if (bridge.context_remaining !== undefined) {
          contextPercent = Math.round((1 - bridge.context_remaining) * 100);
        }
      }
    } catch {
      // INTENTIONALLY SILENT: bridge file is ephemeral and may not exist;
      // the note is surfaced in the output for the user.
      bridgeNote = 'Bridge file not found or unreadable';
    }

    // 5. Determine suggested next action (same logic as forge:progress)
    let suggestedAction = null;
    if (currentPhase) {
      if (currentPhase.status === 'in_progress' && (tasks.ready > 0 || tasks.in_progress > 0)) {
        suggestedAction = `/forge:execute ${currentPhase.id}`;
      } else if (currentPhase.status === 'in_progress' && tasks.ready === 0 && tasks.in_progress === 0 && tasks.done === tasks.total && tasks.total > 0) {
        suggestedAction = `/forge:verify ${currentPhase.id}`;
      } else if (currentPhase.status === 'open') {
        suggestedAction = `/forge:plan ${currentPhase.id}`;
      }
    }
    if (!suggestedAction) {
      const allDone = phases.length > 0 && phases.every(p => p.status === 'closed');
      if (allDone) {
        suggestedAction = 'Project complete!';
      } else {
        const nextOpen = phases.find(p => p.status === 'open');
        if (nextOpen) {
          suggestedAction = `/forge:plan ${nextOpen.id}`;
        }
      }
    }

    // 8. Output structured JSON
    output({
      project: {
        id: projectId,
        title: projectTitle,
      },
      milestone: activeMilestone ? {
        id: activeMilestone.id,
        title: activeMilestone.title,
      } : null,
      phase: currentPhase ? {
        id: currentPhase.id,
        title: currentPhase.title,
        status: currentPhase.status,
      } : null,
      tasks,
      context_percent: contextPercent,
      suggested_action: suggestedAction,
      ...(bridgeNote ? { _notes: { bridge: bridgeNote } } : {}),
    }, 'status');
  },

  /**
   * Detect current project state for the forge:help workflow.
   *
   * Returns structured JSON so the help workflow can decide between
   * reference mode (existing project) and onboarding mode (no project).
   *
   * Usage: forge-tools help-context
   *
   * Output (onboarding):
   *   { mode: 'onboarding', reason: 'no_project', suggestion: 'Run /forge:new to get started' }
   *
   * Output (reference):
   *   { mode: 'reference', project_id, project_title, has_milestone, has_phases, active_phase_number }
   */
  'help-context'(_args) {
    let project;
    try {
      project = resolveProject();
    } catch (err) {
      forgeError('BD_CONNECTION_ERROR', `Failed to detect project state: ${err.message}`, 'Check that bd is running and accessible');
    }

    if (!project) {
      output({ mode: 'onboarding', reason: 'no_project', suggestion: 'Run /forge:new to get started' }, 'help-context');
      return;
    }

    // Gather milestone and phase information
    let milestoneDetails, phases;
    try {
      const collected = collectProjectIssues(project.id);
      milestoneDetails = collected.milestoneDetails;
      phases = collected.phases;
    } catch (err) {
      forgeError('BD_CONNECTION_ERROR', `Failed to collect project data: ${err.message}`, 'Check that bd is running and accessible');
    }

    const hasMilestone = milestoneDetails.length > 0;
    const hasPhases = phases.length > 0;

    // Find active phase (in_progress first, then first open)
    const activePhase = phases.find(p => p.status === 'in_progress')
      || phases.find(p => p.status === 'open')
      || null;

    let activePhaseNumber = null;
    if (activePhase) {
      const match = (activePhase.title || '').match(/^Phase\s+([\d.]+)/i);
      activePhaseNumber = match ? parseFloat(match[1]) : null;
    }

    output({
      mode: 'reference',
      project_id: project.id,
      project_title: project.title,
      has_milestone: hasMilestone,
      has_phases: hasPhases,
      active_phase_number: activePhaseNumber,
    }, 'help-context');
  },

  // Shared helpers exported for dashboard-commands.cjs and other modules
  buildPhaseDetails,
  getRequirementCoverage,
  collectProjectIssues,
  sortPhaseDetails,
  resolveProject,
};

