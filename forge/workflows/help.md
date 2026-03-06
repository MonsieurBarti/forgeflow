<purpose>
Display the complete Forge command reference. Output ONLY the reference content. Do NOT add project-specific analysis, git status, next-step suggestions, or any commentary beyond the reference.
</purpose>

<reference>
# Forge Command Reference

**Forge** is project orchestration for Claude Code, backed by beads. It creates structured project plans with dependency-aware phases and tasks, optimized for agentic development.

## Quick Start

1. `/forge:new` - Initialize project (vision, requirements, phased roadmap)
2. `/forge:plan 1` - Research and plan Phase 1
3. `/forge:execute 1` - Execute Phase 1 (parallelized task execution)
4. `/forge:verify 1` - UAT against acceptance criteria
5. `/forge:progress` - Check status, move to next phase

## Core Workflow

```
/forge:new --> /forge:plan --> /forge:execute --> /forge:verify --> repeat
```

### Project Initialization

**`/forge:new [--auto @context-doc.md]`**
Initialize a new Forge project through guided flow.

- Deep questioning to understand what you're building
- Optional `--auto @file` to skip discussion and use existing context doc
- Requirements definition with structured scoping
- Roadmap creation with phased breakdown and success criteria

Creates beads: project epic (`forge:project`), requirement beads (`forge:req`), phase epics (`forge:phase`) with dependency wiring.

### Phase Planning

**`/forge:plan [phase-number]`**
Plan a phase -- research approach and create task beads with acceptance criteria.

- Spawns forge-researcher for codebase/ecosystem investigation
- Spawns forge-planner to create task breakdown
- Spawns forge-plan-checker to validate against requirements
- Each task gets acceptance criteria and requirement traceability

### Execution

**`/forge:execute [phase-number]`**
Execute tasks in a phase with wave-based parallelization.

- Detects dependency waves automatically
- Independent tasks run in parallel via forge-executor agents
- Each completed task gets an atomic git commit
- Updates task bead status on completion

### Verification

**`/forge:verify [phase-number]`**
Verify phase completion against acceptance criteria.

- Runs automated checks where possible
- Presents UAT results for user confirmation
- Closes verified tasks and updates phase status

### Quick Mode

**`/forge:quick [--full] [--discuss] <task description>`**
Execute small, ad-hoc tasks with Forge guarantees but skip optional agents.

- Default: skips research, discussion, plan-checker, verifier
- `--discuss`: lightweight discussion phase before planning
- `--full`: enables plan-checking and post-execution verification
- Flags are composable: `--discuss --full` for both

## Phase Management

**`/forge:add-phase <description>`**
Add a new phase to the end of the project roadmap.

- Creates phase epic with proper dependency wiring
- Uses next sequential phase number

**`/forge:insert-phase <after> <description>`**
Insert urgent work as decimal phase between existing phases.

- Creates intermediate phase (e.g., 3.1 between 3 and 4)
- Rewires dependency chain automatically

**`/forge:remove-phase <phase-number>`**
Remove a phase from the roadmap and renumber subsequent phases.

- Confirms before removal
- Closes phase and child task beads
- Rewires dependencies and renumbers remaining phases

## Progress & Session

**`/forge:progress`**
Show project progress dashboard from bead graph.

- Phase completion bars and task breakdowns
- Requirement coverage summary
- Blockers and next steps

**`/forge:pause`**
Save session context for later resumption.

- Records active phase, in-progress tasks, progress snapshot

**`/forge:resume`**
Restore session context from previous pause.

- Loads project, current phase, in-progress tasks, recent decisions

## Debugging

**`/forge:debug [issue description]`**
Systematic debugging with persistent state across context resets.

- Gathers symptoms through adaptive questioning
- Spawns forge-debugger agent for isolated investigation
- Survives `/clear` -- run `/forge:debug` with no args to resume
- Tracks sessions via `forge:debug` labeled beads

## Configuration

**`/forge:settings [get|set] [key] [value]`**
Configure workflow toggles with two-layer override (global + per-project).

| Key | Default | Description |
|-----|---------|-------------|
| `skip_verification` | `false` | Skip phase verification after execution |
| `auto_commit` | `true` | Auto-commit after each completed task |
| `require_discussion` | `true` | Require user discussion before planning |
| `auto_research` | `true` | Auto-run research before planning |
| `plan_check` | `true` | Run plan checker to validate plans |
| `parallel_execution` | `true` | Execute independent tasks in parallel |

Override layers (highest priority wins):
1. Per-project: `.forge/settings.yaml`
2. Global: `~/.claude/forge.local.md` (YAML frontmatter)
3. Built-in defaults

**`/forge:config [list|get|set|clear] [key] [value]`**
View or modify hook-level configuration (context thresholds, update checks).

**`/forge:health [--fix]`**
Diagnose project health and optionally repair issues.

- Checks bead graph integrity (labels, dependencies, state consistency)
- Validates Forge installation files
- `--fix` attempts automated repair for fixable issues

## Agents

Forge uses specialized subagents spawned automatically during workflows:

| Agent | Role |
|-------|------|
| **forge-researcher** | Investigates codebase and gathers context for planning |
| **forge-planner** | Creates detailed task breakdowns with acceptance criteria |
| **forge-plan-checker** | Validates plans against requirements |
| **forge-roadmapper** | Generates phased project roadmaps |
| **forge-executor** | Executes individual tasks within a phase |
| **forge-verifier** | Runs UAT verification against acceptance criteria |
| **forge-debugger** | Investigates bugs using scientific method with bead-backed state |

## Data Model

Forge stores everything as beads:

| Concept | Bead Type | Label |
|---------|-----------|-------|
| Project | Epic | `forge:project` |
| Requirement | Feature | `forge:req` |
| Phase | Epic | `forge:phase` |
| Task | Task | (under phase epic) |
| Debug session | Task | `forge:debug` |
| Quick task | Task | `forge:quick` |

## Common Workflows

**Starting a new project:**
```
/forge:new              # Define project, generate requirements and roadmap
/forge:plan 1           # Research and plan Phase 1
/forge:execute 1        # Build Phase 1
/forge:verify 1         # UAT against acceptance criteria
```

**Resuming work after a break:**
```
/forge:resume           # Restore context from previous session
/forge:progress         # See where you left off
```

**Adding urgent mid-project work:**
```
/forge:insert-phase 3 "Critical security fix"
/forge:plan 3.1
/forge:execute 3.1
```

**Quick ad-hoc task:**
```
/forge:quick Fix the login button hover state
/forge:quick --full Refactor auth middleware
```

**Debugging an issue:**
```
/forge:debug "form submission fails silently"
/clear
/forge:debug                                     # Resume from where you left off
```

## Getting Help

- `/forge:progress` -- check project status and next steps
- `/forge:health` -- diagnose project issues
- `/forge:settings` -- view/change workflow configuration
</reference>
