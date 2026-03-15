<purpose>
Display Forge help -- either a command reference for existing projects or an interactive
onboarding flow for new users. The mode is determined by detecting the current project state.
</purpose>

<process>

## 1. Detect Project State

Run the help-context command to determine which mode to use:

```bash
CONTEXT=$(node "$HOME/.claude/forge/bin/forge-tools.cjs" help-context)
```

Parse the JSON result. If `mode` is `"reference"`, jump to **Step 2 (Reference Mode)**.
If `mode` is `"onboarding"`, jump to **Step 3 (Onboarding Mode)**.

## 2. Reference Mode

Output ONLY the reference content below. Do NOT add project-specific analysis, git status,
next-step suggestions, or any commentary beyond the reference.

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

**`/forge:validate-phase [phase-number]`**
Retroactively audit and fill validation gaps for a completed phase.

- Checks acceptance criteria were actually met (not just tasks closed)
- Identifies gaps between what was promised and what was delivered
- Classifies criteria as COVERED/PARTIAL/MISSING
- Optionally generates missing tests via forge-verifier agents

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

## Todo Capture

**`/forge:add-todo [description]`**
Capture an idea or task as a todo bead for later work.

- Creates a `forge:todo` labeled bead under the project epic
- No phase assignment -- lives in project backlog
- With description argument: uses it as the title directly
- Without argument: extracts context from recent conversation

**`/forge:check-todos [area]`**
List pending todos and select one to work on.

- Lists all open `forge:todo` beads with title, area, and age
- Optional area filter to narrow the list
- Select a todo to: work on it now (via `/forge:quick`), add to a phase, brainstorm, or delete

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
| Todo | Task | `forge:todo` |

## Common Workflows

**Starting a new project:**
```
/forge:new              # Define project, generate requirements and roadmap
/forge:plan 1           # Research and plan Phase 1
/forge:execute 1        # Build Phase 1
/forge:verify 1         # UAT against acceptance criteria
```

**Auditing a completed phase:**
```
/forge:validate-phase 2      # Check all criteria were actually met
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

**STOP here after displaying the reference. Do not continue to Step 3.**

## 3. Onboarding Mode

No Forge project was detected in the current directory. Guide the user through an interactive
getting-started flow.

### Step 1: Welcome and Intent

Display a welcome message:

> **Welcome to Forge!** No project detected in this directory.
>
> Forge is a project orchestration system for Claude Code. It helps you plan, execute, and
> verify complex software projects through structured phases and tasks.

Then use AskUserQuestion to ask what the user wants to do:

```
AskUserQuestion(
  question: "What would you like to do?",
  options: [
    "Start a new project - Set up Forge for this codebase",
    "Explore commands - See what Forge can do before committing",
    "Troubleshoot - I expected a project to exist here"
  ]
)
```

### Step 2: Based on Choice

**If "Start a new project":**

Display:

> To initialize a Forge project, run:
>
> ```
> /forge:new
> ```
>
> This will guide you through:
> 1. Describing your project vision and goals
> 2. Defining requirements with acceptance criteria
> 3. Creating a phased roadmap with dependency ordering
>
> **Tip:** If you have an existing design doc or PRD, you can fast-track setup:
> ```
> /forge:new --auto @your-design-doc.md
> ```

Use AskUserQuestion:
```
AskUserQuestion(
  question: "Ready to start?",
  options: [
    "Yes, run /forge:new now",
    "Show me the full command reference first"
  ]
)
```

If "Yes, run /forge:new now" -- invoke `/forge:new` directly.
If "Show me the full command reference first" -- display the reference content from Step 2.

**If "Explore commands":**

Display a curated subset of the most important commands:

> ### Essential Commands
>
> | Command | What it does |
> |---------|-------------|
> | `/forge:new` | Initialize a project with vision, requirements, and roadmap |
> | `/forge:plan <phase>` | Research and plan a phase with task breakdown |
> | `/forge:execute <phase>` | Build a phase with parallel task execution |
> | `/forge:verify <phase>` | Validate work against acceptance criteria |
> | `/forge:quick <task>` | One-off task without full project setup |
> | `/forge:progress` | Check project status and next steps |
> | `/forge:debug <issue>` | Systematic debugging with persistent state |
>
> **The typical flow:** `/forge:new` --> `/forge:plan 1` --> `/forge:execute 1` --> `/forge:verify 1` --> repeat
>
> Run `/forge:help` again after creating a project to see the full command reference.

**If "Troubleshoot":**

Display:

> Forge looks for a `forge:project` bead in your beads database. Here are common reasons
> it might not be found:
>
> 1. **No beads database:** Run `bd init` to initialize beads in this repo, then `/forge:new`
> 2. **Wrong directory:** Forge detects projects per-repo. Make sure you're in the right git root
> 3. **Database not synced:** Run `bd dolt pull` to sync from remote
> 4. **Project was created in a different repo:** Each repo has its own Forge project
>
> To check your beads status: `bd list --label forge:project`

</process>
