'use strict';

/**
 * schemas.cjs -- Canonical JSON schemas for all forge-tools command outputs.
 *
 * Defines schema objects for every output() call site across all command modules.
 * Provides validate(schemaName, data) for warn-only runtime validation and
 * toMarkdown(schemaName) for generating agent-facing documentation.
 *
 * Zero external dependencies. Pure JS objects only.
 */

// --- Schema Definition Helpers ---

/**
 * Define a field: { type, required, description, enum?, items? }
 * Types: 'string', 'number', 'boolean', 'object', 'array', 'any'
 */
function req(type, description) {
  return { type, required: true, description };
}

function opt(type, description) {
  return { type, required: false, description };
}

// --- Schema Definitions ---
// Organized by command module. Each schema key matches the command name
// or a specific output variant (e.g. 'find-project.found', 'find-project.not-found').

const SCHEMAS = {

  // =========================================================================
  // core.cjs
  // =========================================================================

  'forge-error': {
    _description: 'Structured error output from forgeError()',
    _module: 'core',
    error:      req('boolean', 'Always true for errors'),
    code:       req('string',  'UPPER_SNAKE_CASE error code'),
    message:    req('string',  'Human-readable error description'),
    suggestion: req('string',  'Actionable next step to fix the issue'),
    context:    opt('object',  'Additional error context'),
  },

  // =========================================================================
  // phase-commands.cjs
  // =========================================================================

  'phase-context': {
    _description: 'Full phase context with tasks and summary',
    _module: 'phase-commands',
    phase:   req('object',  'Phase bead details: {id, title, description, notes, design, status}'),
    tasks:   req('array',   'Array of task beads under this phase'),
    summary: req('object',  'Summary counts: {total, ready, in_progress, done}'),
  },

  'ready-tasks': {
    _description: 'Tasks ready for execution in a phase',
    _module: 'phase-commands',
    phase_id:    req('string', 'Phase bead ID'),
    ready_tasks: req('array',  'Array of task beads with status=open'),
  },

  'plan-check': {
    _description: 'Plan verification results',
    _module: 'phase-commands',
    phase_id:    req('string', 'Phase bead ID'),
    phase_title: opt('string', 'Phase title'),
    total_tasks: req('number', 'Total task count'),
    verdict:     req('string', 'APPROVED or NEEDS_REVISION'),
    findings:    req('array',  'Array of finding objects'),
    issues:      req('array',  'Array of issue strings'),
    summary:     req('object', '{tasks_with_criteria, tasks_without_criteria, tasks_with_label, uncovered_requirements}'),
  },

  'preflight-check': {
    _description: 'Pre-execution validation results',
    _module: 'phase-commands',
    phase_id:    req('string', 'Phase bead ID'),
    phase_title: req('string', 'Phase title'),
    verdict:     req('string', 'PASS or FAIL'),
    issues:      req('array',  'Array of issue objects'),
  },

  'detect-waves': {
    _description: 'Dependency wave detection for phase execution',
    _module: 'phase-commands',
    phase_id:     req('string', 'Phase bead ID'),
    phase_title:  opt('string', 'Phase title'),
    phase_status: opt('string', 'Phase status'),
    waves:        req('array',  'Array of wave objects with tasks_to_execute and tasks_already_done'),
    summary:      req('object', '{total_tasks, total_waves, tasks_open?, tasks_in_progress?, tasks_closed?}'),
  },

  'checkpoint-save': {
    _description: 'Execution checkpoint saved',
    _module: 'phase-commands',
    saved:      req('boolean', 'Always true on success'),
    phase_id:   req('string',  'Phase bead ID'),
    checkpoint: req('object',  'The saved checkpoint data'),
  },

  'checkpoint-load': {
    _description: 'Loaded execution checkpoint (or not found)',
    _module: 'phase-commands',
    // When found, returns the checkpoint object directly (no wrapper)
    // When not found, returns {found: false, suggestion}
    found:      opt('boolean', 'false when no checkpoint exists'),
    suggestion: opt('string',  'Help text when not found'),
    // Checkpoint fields (present when found)
    completedWaves: opt('array',  'Array of completed wave numbers'),
    taskStatuses:   opt('object', 'Map of taskId -> status'),
    phase_id:       opt('string', 'Phase ID from checkpoint'),
    branchName:     opt('string', 'Git branch name'),
    baseCommitSha:  opt('string', 'Base commit SHA for rollback'),
    timestamp:      opt('string', 'ISO timestamp'),
    completed:      opt('boolean', 'Whether phase execution completed'),
  },

  'verify-phase': {
    _description: 'Phase verification data for acceptance criteria checking',
    _module: 'phase-commands',
    phase:              req('object', '{id, title, status, parent}'),
    tasks_to_verify:    req('array',  'Tasks with acceptance_criteria to verify'),
    tasks_still_open:   req('array',  'Tasks not yet closed'),
    total_tasks:        req('number', 'Total task count'),
    total_closed:       req('number', 'Closed task count'),
    total_open:         req('number', 'Open task count'),
    requirements_count: req('number', 'Number of forge:req beads'),
  },

  'add-phase': {
    _description: 'New phase added to roadmap',
    _module: 'phase-commands',
    ok:           req('boolean', 'Always true on success'),
    phase_id:     req('string',  'Created phase bead ID'),
    phase_number: req('number',  'Assigned phase number'),
    title:        req('string',  'Phase title'),
    description:  req('string',  'Phase description'),
    project_id:   req('string',  'Parent project ID'),
    milestone_id: opt('string',  'Parent milestone ID'),
    total_phases: req('number',  'Total phases after addition'),
  },

  'insert-phase': {
    _description: 'Phase inserted between existing phases',
    _module: 'phase-commands',
    ok:           req('boolean', 'Always true on success'),
    phase_id:     req('string',  'Created phase bead ID'),
    phase_number: req('number',  'Assigned phase number (decimal)'),
    after_phase:  req('number',  'Phase number this was inserted after'),
    title:        req('string',  'Phase title'),
    description:  req('string',  'Phase description'),
    project_id:   req('string',  'Parent project ID'),
    milestone_id: opt('string',  'Parent milestone ID'),
    rewired_next: opt('object',  'Next phase that was rewired: {id, title}'),
  },

  'remove-phase': {
    _description: 'Phase removed from roadmap',
    _module: 'phase-commands',
    ok:               req('boolean', 'Always true on success'),
    removed:          req('object',  '{id, title, phase_number}'),
    tasks_closed:     req('number',  'Number of tasks closed'),
    rewired:          req('object',  '{predecessor, successors}'),
    renumbered:       req('array',   'Array of renumbered phase objects'),
    remaining_phases: req('number',  'Phases remaining after removal'),
  },

  'list-phases': {
    _description: 'Phases with numbers for a project',
    _module: 'phase-commands',
    project_id: req('string', 'Project bead ID'),
    phases:     req('array',  'Array of {number, id, title, status}'),
    total:      req('number', 'Total phase count'),
  },

  'resolve-phase': {
    _description: 'Phase resolved by number',
    _module: 'phase-commands',
    found:      req('boolean', 'Whether the phase was found'),
    phase:      opt('object',  'Phase bead (when found)'),
    available:  opt('array',   'Available phase numbers (when not found)'),
    suggestion: opt('string',  'Help text (when not found)'),
  },

  'context-write': {
    _description: 'Structured context written to phase bead',
    _module: 'phase-commands',
    written:  req('boolean', 'Always true on success'),
    phase_id: req('string',  'Phase bead ID'),
    agent:    req('string',  'Agent name that wrote the context'),
    task:     opt('string',  'Task ID if context is task-scoped'),
  },

  'context-read': {
    _description: 'Structured context entries from a phase bead',
    _module: 'phase-commands',
    phase_id: req('string', 'Phase bead ID'),
    contexts: req('array',  'Array of context entry objects'),
  },

  'retro-query': {
    _description: 'Retrospective data from closed phases',
    _module: 'phase-commands',
    project_id:           req('string', 'Project bead ID'),
    phase_count:          req('number', 'Number of closed phases analyzed'),
    lessons:              req('array',  'Array of {phase_id, phase_title, lesson}'),
    pitfall_flags:        req('array',  'Array of pitfall warning objects'),
    effectiveness_ratings: req('array', 'Array of effectiveness rating objects'),
  },

  'detect-build-test': {
    _description: 'Build and test command detection results',
    _module: 'phase-commands',
    has_build:   req('boolean', 'Whether a build command was detected'),
    has_tests:   req('boolean', 'Whether test infrastructure was detected'),
    build_cmd:   opt('string',  'Detected build command'),
    test_cmd:    opt('string',  'Detected test command'),
    test_runner: opt('string',  'Detected test runner name'),
    source:      opt('string',  'Detection source (package.json, Cargo.toml, etc.)'),
  },

  'implementation-preview': {
    _description: 'Plan data with wave execution order',
    _module: 'phase-commands',
    phase_id:             opt('string', 'Phase bead ID'),
    phase_title:          opt('string', 'Phase title'),
    total_tasks:          opt('number', 'Total task count'),
    total_files_affected: opt('number', 'Total unique files affected'),
    waves:                req('array',  'Array of wave objects with tasks'),
    architect_summary:    opt('string', 'Summary from architect audit'),
  },

  'plan-interactive-review': {
    _description: 'Plan review decision (approve/reject/fallback)',
    _module: 'phase-commands',
    // Fallback mode
    fallback: opt('boolean', 'true when web_ui is disabled'),
    data:     opt('object',  'Plan data for CLI fallback display'),
    // Decision mode
    action:            opt('string', '"approve" or "reject"'),
    edits_applied:     opt('number', 'Number of edits applied'),
    comments_applied:  opt('number', 'Number of comments applied'),
    removals_applied:  opt('number', 'Number of removals applied'),
  },

  // =========================================================================
  // project-commands.cjs
  // =========================================================================

  'find-project': {
    _description: 'Project discovery result',
    _module: 'project-commands',
    found:         req('boolean', 'Whether a project was found'),
    project_id:    opt('string',  'Found project bead ID'),
    project_title: opt('string',  'Found project title'),
    projects:      opt('array',   'Array of all project beads'),
    source:        opt('string',  'Discovery source: argument, beads, cwd_monorepo, cwd_settings, monorepo_parent'),
    suggestion:    opt('string',  'Help text when not found'),
  },

  'find-project-memory': {
    _description: 'Project memory lookup result',
    _module: 'project-commands',
    ok:     req('boolean', 'Always true on success'),
    memory: req('any',     'The memory value'),
  },

  'project-context': {
    _description: 'Full project context for workflows',
    _module: 'project-commands',
    project:      req('object', 'Project bead details'),
    requirements: req('array',  'Array of forge:req beads'),
    phases:       req('array',  'Array of forge:phase beads'),
    summary:      req('object', '{total_requirements, ...}'),
  },

  'project-context-slim': {
    _description: 'Slim project context (truncated for agent prompts)',
    _module: 'project-commands',
    project:      req('object', 'Project bead details (truncated)'),
    requirements: req('array',  'Array of forge:req beads (truncated)'),
    phases:       req('array',  'Array of forge:phase beads (truncated)'),
    summary:      req('object', '{total_requirements, ...}'),
  },

  'progress': {
    _description: 'Project progress dashboard data',
    _module: 'project-commands',
    project:  req('object', '{id, title, status}'),
    progress: req('object', '{phases_total, phases_completed, phases_remaining, ...}'),
  },

  'dashboard': {
    _description: 'Dashboard generation result',
    _module: 'project-commands',
    // Static mode
    path:        opt('string', 'Path to generated HTML file'),
    projectId:   opt('string', 'Project bead ID'),
    timestamp:   opt('string', 'Generation timestamp'),
    // Interactive mode
    interactive: opt('boolean', 'true when served via dev-server'),
    action:      opt('string',  'User action from interactive mode'),
  },

  'session-save': {
    _description: 'Session state saved for forge:pause',
    _module: 'project-commands',
    saved:   req('boolean', 'Always true on success'),
    session: req('object',  'Saved session data'),
  },

  'session-load': {
    _description: 'Session state loaded for forge:resume',
    _module: 'project-commands',
    found:             req('boolean', 'Whether session data was found'),
    project:           opt('object',  '{id, title, status} when found'),
    current_phase:     opt('object',  '{id, title, status} or null'),
    tasks_in_progress: opt('array',   'In-progress tasks'),
    phases_completed:  opt('number',  'Count of completed phases'),
    memories:          opt('object',  'Raw bd memories when not found'),
    suggestion:        opt('string',  'Help text when not found'),
  },

  'health': {
    _description: 'Project health diagnostics',
    _module: 'project-commands',
    project:     req('object', '{id, title, status}'),
    diagnostics: req('array',  'Array of diagnostic check objects'),
    summary:     req('object', '{total_checks, healthy, ...}'),
  },

  'settings-load': {
    _description: 'Current settings with file paths',
    _module: 'project-commands',
    settings:     req('object', 'Resolved settings object'),
    global_path:  req('string', 'Path to global settings file'),
    project_path: req('string', 'Path to project settings file'),
  },

  'settings-set': {
    _description: 'Setting value updated',
    _module: 'project-commands',
    ok:    req('boolean', 'Always true on success'),
    scope: req('string',  '"global" or "project"'),
    key:   req('string',  'Setting key'),
    value: req('any',     'Parsed setting value'),
  },

  'settings-clear': {
    _description: 'Setting value cleared',
    _module: 'project-commands',
    ok:      req('boolean', 'Always true on success'),
    scope:   req('string',  '"global" or "project"'),
    key:     req('string',  'Setting key'),
    cleared: req('boolean', 'Always true'),
  },

  'settings-bulk-set': {
    _description: 'Multiple settings updated at once',
    _module: 'project-commands',
    ok:      req('boolean', 'Always true on success'),
    scope:   req('string',  '"global" or "project"'),
    updated: req('array',   'Array of {key, value, ok?, error?} results'),
  },

  'resolve-model': {
    _description: 'Resolved model for an agent',
    _module: 'project-commands',
    agent:   req('string',  'Normalized agent name'),
    model:   opt('string',  'Resolved model: inherit, sonnet, haiku, or null'),
    source:  opt('string',  'Resolution source: override, profile:<name>, or null'),
    profile: opt('string',  'Active model profile'),
  },

  'resolve-role': {
    _description: 'Resolved model for a role (backwards compat)',
    _module: 'project-commands',
    role:   req('string', 'Agent role name'),
    model:  opt('string', 'Resolved model'),
    source: opt('string', 'Resolution source'),
  },

  'model-assignments': {
    _description: 'All agent model assignments for active profile',
    _module: 'project-commands',
    profile:            req('string', 'Active model profile name'),
    overrides:          req('object', 'Per-agent overrides map'),
    effective:          req('object', 'Effective model map per agent'),
    agents:             req('array',  'Array of {agent, model, source}'),
    available_profiles: req('array',  'Array of valid profile names'),
  },

  'config-get': {
    _description: 'Forge config value',
    _module: 'project-commands',
    key:   req('string', 'Config key with forge. prefix'),
    value: opt('any',    'Config value or null'),
  },

  'config-set': {
    _description: 'Forge config value set',
    _module: 'project-commands',
    ok:    req('boolean', 'Always true on success'),
    key:   req('string',  'Config key with forge. prefix'),
    value: req('any',     'Stored config value'),
  },

  'config-list': {
    _description: 'All Forge config values',
    _module: 'project-commands',
    config:         req('object', 'Map of forge.* keys to values'),
    available_keys: req('array',  'Array of {key, default, description}'),
  },

  'config-clear': {
    _description: 'Forge config value cleared',
    _module: 'project-commands',
    ok:      req('boolean', 'Always true on success'),
    key:     req('string',  'Config key with forge. prefix'),
    cleared: req('boolean', 'Always true'),
  },

  'debug-sessions': {
    _description: 'Active debug sessions list',
    _module: 'project-commands',
    sessions:   req('array',  'Array of debug session objects'),
    suggestion: opt('string', 'Help text when empty'),
  },

  'debug-create': {
    _description: 'New debug session created',
    _module: 'project-commands',
    debug_id: req('string', 'Created debug bead ID'),
    slug:     req('string', 'URL-safe slug for the session'),
  },

  'debug-update': {
    _description: 'Debug session updated',
    _module: 'project-commands',
    updated: req('boolean', 'Always true on success'),
    id:      req('string',  'Debug bead ID'),
  },

  'todo-list': {
    _description: 'Pending forge:todo beads',
    _module: 'project-commands',
    todo_count: req('number', 'Number of todos'),
    todos:      req('array',  'Array of todo bead objects'),
    suggestion: opt('string', 'Help text when empty'),
  },

  'todo-create': {
    _description: 'New todo bead created',
    _module: 'project-commands',
    todo_id: req('string', 'Created todo bead ID'),
  },

  'milestones-list': {
    _description: 'Milestones under a project',
    _module: 'project-commands',
    project_id: req('string', 'Project bead ID'),
    milestones: req('array',  'Array of milestone objects'),
    total:      req('number', 'Total milestone count'),
  },

  'milestone-audit': {
    _description: 'Milestone audit against requirements',
    _module: 'project-commands',
    milestone:                req('object', '{id, title, status}'),
    phases:                   req('array',  'Array of phase health objects'),
    requirements:             req('array',  'Array of requirement coverage objects'),
    uncovered_requirements:   req('array',  'Requirements with no validates links'),
    partial_requirements:     req('array',  'Requirements partially covered'),
  },

  'milestone-create': {
    _description: 'New milestone created',
    _module: 'project-commands',
    ok:           req('boolean', 'Always true on success'),
    milestone_id: req('string',  'Created milestone bead ID'),
    title:        req('string',  'Milestone title'),
    project_id:   req('string',  'Parent project ID'),
  },

  'monorepo-init': {
    _description: 'Monorepo initialized',
    _module: 'project-commands',
    ok:               req('boolean', 'Always true on success'),
    monorepo_id:      req('string',  'Created monorepo bead ID'),
    title:            req('string',  'Monorepo title'),
    detection_source: req('string',  'How workspace structure was detected'),
    children:         req('array',   'Array of created child project objects'),
  },

  'monorepo-detect': {
    _description: 'Monorepo detection result',
    _module: 'project-commands',
    found:         req('boolean', 'Whether a monorepo/project was detected'),
    project_id:    opt('string',  'Detected project ID'),
    project_title: opt('string',  'Detected project title'),
    description:   opt('string',  'Project description'),
    models:        opt('object',  'Model assignment summary'),
  },

  'status': {
    _description: 'Session orientation dashboard',
    _module: 'project-commands',
    project:   req('object', '{id, title}'),
    milestone: opt('object', '{id, title, status}'),
  },

  'help-context': {
    _description: 'Help context for onboarding/reference',
    _module: 'project-commands',
    mode:          req('string',  '"onboarding" or "reference"'),
    reason:        opt('string',  'Why this mode was selected'),
    suggestion:    opt('string',  'Help text for onboarding mode'),
    project_id:    opt('string',  'Project ID in reference mode'),
    project_title: opt('string',  'Project title in reference mode'),
    has_milestone: opt('boolean', 'Whether a milestone exists'),
    has_phases:    opt('boolean', 'Whether phases exist'),
  },

  // =========================================================================
  // git-commands.cjs
  // =========================================================================

  'worktree-create': {
    _description: 'Git worktree creation result',
    _module: 'git-commands',
    created:    req('boolean', 'Whether worktree was created'),
    path:       req('string',  'Worktree filesystem path'),
    branch:     req('string',  'Git branch for the worktree'),
    reason:     opt('string',  'Why creation was skipped'),
    suggestion: opt('string',  'Help text'),
  },

  'worktree-path': {
    _description: 'Worktree path lookup',
    _module: 'git-commands',
    path:   req('string',  'Worktree filesystem path'),
    exists: req('boolean', 'Whether worktree exists on disk'),
  },

  'worktree-remove': {
    _description: 'Git worktree removal result',
    _module: 'git-commands',
    removed:    req('boolean', 'Whether worktree was removed'),
    path:       opt('string',  'Worktree path (when removed)'),
    reason:     opt('string',  'Why removal failed'),
    suggestion: opt('string',  'Help text'),
  },

  'branch-create': {
    _description: 'Phase branch creation result',
    _module: 'git-commands',
    created:     req('boolean', 'Whether branch was created'),
    branch:      req('string',  'Branch name'),
    phaseId:     opt('string',  'Phase bead ID'),
    milestoneId: opt('string',  'Milestone bead ID'),
    reason:      opt('string',  'Why creation was skipped'),
    suggestion:  opt('string',  'Help text'),
  },

  'branch-push': {
    _description: 'Branch pushed to origin',
    _module: 'git-commands',
    pushed: req('boolean', 'Always true on success'),
    branch: req('string',  'Branch name'),
  },

  'pr-create': {
    _description: 'GitHub PR creation result',
    _module: 'git-commands',
    created:    req('boolean', 'Whether PR was created'),
    url:        opt('string',  'PR URL'),
    branch:     req('string',  'Head branch'),
    base:       req('string',  'Base branch'),
    title:      req('string',  'PR title'),
    suggestion: opt('string',  'Help text when PR already exists'),
  },

  'quick-branch-create': {
    _description: 'Quick task branch creation result',
    _module: 'git-commands',
    created:    req('boolean', 'Whether branch was created'),
    branch:     req('string',  'Branch name'),
    quickId:    opt('string',  'Quick task bead ID'),
    reason:     opt('string',  'Why creation was skipped'),
    suggestion: opt('string',  'Help text'),
  },

  'quick-pr-create': {
    _description: 'Quick task PR creation result',
    _module: 'git-commands',
    created:    req('boolean', 'Whether PR was created'),
    url:        opt('string',  'PR URL'),
    branch:     req('string',  'Head branch'),
    base:       req('string',  'Base branch'),
    title:      req('string',  'PR title'),
    suggestion: opt('string',  'Help text when PR already exists'),
  },

  // =========================================================================
  // quality-gate-commands.cjs
  // =========================================================================

  'quality-gate-fp-add': {
    _description: 'False-positive added to store',
    _module: 'quality-gate-commands',
    ok:      req('boolean', 'Always true on success'),
    hash:    req('string',  'FP hash (16 hex chars)'),
    key:     req('string',  'Full bd memory key'),
    finding: req('object',  '{agent, category, file, title}'),
  },

  'quality-gate-fp-list': {
    _description: 'List of known false-positives',
    _module: 'quality-gate-commands',
    ok:              req('boolean', 'Always true'),
    count:           req('number',  'Number of false-positives'),
    false_positives: req('array',   'Array of {hash, key, agent, category, file, title}'),
  },

  'quality-gate-fp-clear': {
    _description: 'False-positive(s) cleared',
    _module: 'quality-gate-commands',
    ok:      req('boolean', 'Always true on success'),
    hash:    opt('string',  'Cleared FP hash (single mode)'),
    key:     opt('string',  'Cleared FP key (single mode)'),
    cleared: opt('number',  'Number cleared (all mode)'),
    message: req('string',  'Human-readable result message'),
  },

  'quality-gate-report': {
    _description: 'Quality gate HTML report generated',
    _module: 'quality-gate-commands',
    success:        req('boolean', 'Always true on success'),
    report_path:    req('string',  'Path to generated HTML file'),
    findings_count: req('number',  'Total findings after filtering'),
  },

  'quality-gate-triage': {
    _description: 'Quality gate triage result (interactive or fallback)',
    _module: 'quality-gate-commands',
    // Fallback mode
    fallback:       opt('boolean', 'true when web_ui is disabled'),
    report_path:    opt('string',  'Path to generated HTML file'),
    findings_count: opt('number',  'Total findings'),
    // Interactive mode (returns the decision object from dev-server)
    fixIds:    opt('array', 'Finding IDs the user selected for fixing'),
    ignoreIds: opt('array', 'Finding IDs the user chose to ignore'),
  },

  // =========================================================================
  // cleanup-commands.cjs
  // =========================================================================

  'milestone-cleanup-branches': {
    _description: 'Milestone branch cleanup result',
    _module: 'cleanup-commands',
    dry_run:  req('boolean', 'Whether this was a dry run'),
    branches: opt('array',   'Branches found (dry run)'),
    deleted:  opt('array',   'Branches deleted'),
    failed:   opt('array',   'Branches that failed to delete'),
    count:    req('number',  'Number of branches deleted or found'),
  },

  'milestone-close-beads': {
    _description: 'Milestone bead closure result',
    _module: 'cleanup-commands',
    dry_run: req('boolean', 'Whether this was a dry run'),
    beads:   opt('array',   'Beads preview (dry run)'),
    closed:  opt('array',   'Bead IDs closed'),
    failed:  opt('array',   'Bead IDs that failed to close'),
    count:   req('number',  'Number of beads closed or found'),
  },

  'milestone-purge-memories': {
    _description: 'Milestone memory purge result',
    _module: 'cleanup-commands',
    dry_run: req('boolean', 'Whether this was a dry run'),
    keys:    opt('array',   'Memory keys found (dry run)'),
    purged:  opt('array',   'Memory keys purged'),
    failed:  opt('array',   'Memory keys that failed to purge'),
    count:   req('number',  'Number of keys purged or found'),
  },

  // =========================================================================
  // roadmap-commands.cjs
  // =========================================================================

  'migrate-orphan-phases': {
    _description: 'Orphan phase migration result',
    _module: 'roadmap-commands',
    ok:                  req('boolean', 'Whether migration succeeded'),
    message:             opt('string',  'Status message'),
    orphans_found:       opt('number',  'Number of orphan phases linked'),
    milestones_created:  opt('number',  'Number of milestones auto-created'),
    actions:             opt('array',   'Array of action objects'),
    suggestion:          opt('string',  'Help text'),
  },

  // =========================================================================
  // changelog-commands.cjs
  // =========================================================================

  'changelog-generate': {
    _description: 'Changelog generation result',
    _module: 'changelog-commands',
    generated:   req('boolean', 'Whether changelog was generated'),
    path:        opt('string',  'Path to CHANGELOG.md'),
    commitCount: req('number',  'Number of CC commits found'),
    sections:    opt('array',   'Non-empty section names'),
    version:     opt('string',  'Version header used'),
    fromTag:     req('string',  'Starting tag or "(all)"'),
    reason:      opt('string',  'Why generation was skipped'),
  },

  'version-bump': {
    _description: 'Package version bumped',
    _module: 'changelog-commands',
    bumped:          req('boolean', 'Always true on success'),
    previousVersion: req('string',  'Version before bump'),
    newVersion:      req('string',  'Version after bump'),
    level:           req('string',  'Bump level: major, minor, or patch'),
    autoDetected:    req('boolean', 'Whether level was auto-detected from commits'),
  },

  'release-create': {
    _description: 'GitHub release creation result',
    _module: 'changelog-commands',
    created:    req('boolean', 'Whether release was created'),
    tag:        req('string',  'Git tag (e.g. v0.7.0)'),
    version:    req('string',  'Semver version'),
    releaseUrl: req('string',  'GitHub release URL'),
    reason:     opt('string',  'Why creation was skipped'),
  },

  // =========================================================================
  // Agent response schemas
  // =========================================================================

  'audit-findings': {
    _description: 'Structured audit findings from quality-gate and architect agents',
    _module: 'agent-response',
    agent:    req('string', 'Agent name that produced the findings (e.g. forge-quality-gate, forge-architect)'),
    findings: req('array',  'Array of finding objects: [{task?: string, file?: string, severity: "critical"|"high"|"medium"|"low"|"info", title: string, description: string, recommendation: string, category?: string}]'),
    summary:  req('object', 'Summary counts: {total: number, by_severity: {critical?: number, high?: number, medium?: number, low?: number, info?: number}}'),
  },

  'context-write-envelope': {
    _description: 'Structured context envelope written by agents to phase beads',
    _module: 'agent-response',
    agent:      req('string', 'Agent name that wrote the context'),
    task:       opt('string', 'Task bead ID if context is task-scoped'),
    status:     req('string', 'Completion status (e.g. completed, failed, blocked)'),
    findings:   opt('array',  'Array of finding objects'),
    decisions:  opt('array',  'Array of decision objects'),
    blockers:   opt('array',  'Array of blocker objects'),
    artifacts:  opt('array',  'Array of artifact objects'),
    next_steps: opt('array',  'Array of next-step strings or objects'),
    timestamp:  req('string', 'ISO 8601 timestamp of when context was written'),
  },

  'plan-audit': {
    _description: 'Plan-time audit response from architect or quality-gate agents',
    _module: 'agent-response',
    agent:    req('string', 'Agent name that produced the audit'),
    findings: req('array',  'Array of finding objects: [{task: string, severity: "critical"|"high"|"medium"|"low"|"info", title: string, description: string, recommendation: string}]'),
    summary:  req('string', 'Human-readable summary of the audit results'),
  },
};

// --- Schema Names ---

const SCHEMA_NAMES = Object.keys(SCHEMAS);

// --- Type checking helpers ---

const TYPE_CHECKS = {
  string:  (v) => typeof v === 'string',
  number:  (v) => typeof v === 'number' && !isNaN(v),
  boolean: (v) => typeof v === 'boolean',
  object:  (v) => v !== null && typeof v === 'object' && !Array.isArray(v),
  array:   (v) => Array.isArray(v),
  any:     () => true,
};

// --- Validation ---

/**
 * Validate data against a named schema.
 * Always warn-only: logs to console.error on mismatch, never throws or exits.
 *
 * @param {string} schemaName  Name of the schema to validate against
 * @param {object} data        The data to validate
 * @returns {{ valid: boolean, errors: string[] }}
 */
function validate(schemaName, data) {
  try {
    const schema = SCHEMAS[schemaName];
    if (!schema) {
      // Unknown schema — pass through silently
      return { valid: true, errors: [] };
    }

    if (data === null || data === undefined || typeof data !== 'object') {
      const errors = [`[schema:${schemaName}] Expected object, got ${data === null ? 'null' : typeof data}`];
      console.error(errors[0]);
      return { valid: false, errors };
    }

    const errors = [];

    for (const [key, def] of Object.entries(schema)) {
      // Skip metadata keys
      if (key.startsWith('_')) continue;

      const value = data[key];

      // Check required fields
      if (def.required && (value === undefined || value === null)) {
        errors.push(`[schema:${schemaName}] Missing required field "${key}" (${def.type}): ${def.description}`);
        continue;
      }

      // Skip optional fields that are absent
      if (value === undefined || value === null) continue;

      // Type check
      const checker = TYPE_CHECKS[def.type];
      if (checker && !checker(value)) {
        errors.push(`[schema:${schemaName}] Field "${key}" expected ${def.type}, got ${Array.isArray(value) ? 'array' : typeof value}`);
      }
    }

    if (errors.length > 0) {
      for (const err of errors) {
        console.error(err);
      }
      return { valid: false, errors };
    }

    return { valid: true, errors: [] };
  } catch (err) {
    // Validation itself should never crash the caller
    const msg = `[schema:${schemaName}] Validation error: ${err.message}`;
    console.error(msg);
    return { valid: true, errors: [] };
  }
}

// --- Markdown Generation ---

/**
 * Generate a markdown documentation table for a named schema.
 *
 * @param {string} schemaName  Name of the schema
 * @returns {string}  Markdown string with field table
 */
function toMarkdown(schemaName) {
  const schema = SCHEMAS[schemaName];
  if (!schema) return `Unknown schema: ${schemaName}`;

  const desc = schema._description || schemaName;
  const mod = schema._module || 'unknown';

  const lines = [
    `# ${schemaName}`,
    '',
    `${desc}`,
    '',
    `**Module:** \`${mod}\``,
    '',
    '| Field | Type | Required | Description |',
    '|-------|------|----------|-------------|',
  ];

  for (const [key, def] of Object.entries(schema)) {
    if (key.startsWith('_')) continue;
    // Escape pipe characters in description
    const safeDesc = def.description.replace(/\|/g, '\\|');
    lines.push(`| \`${key}\` | ${def.type} | ${def.required ? 'yes' : 'no'} | ${safeDesc} |`);
  }

  lines.push('');
  return lines.join('\n');
}

module.exports = {
  SCHEMAS,
  SCHEMA_NAMES,
  validate,
  toMarkdown,
};
