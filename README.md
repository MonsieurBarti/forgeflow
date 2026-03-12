<div align="center">

# Forge

**Project orchestration for Claude Code, backed by [beads](https://github.com/steveyegge/beads).**

Instead of managing state through markdown planning files, Forge uses beads as its data layer — epics for milestones, dependency graphs for phase ordering, and bead metadata for plans, requirements, and verification.

[![Tests](https://img.shields.io/github/actions/workflow/status/MonsieurBarti/forgeflow/ci.yml?branch=main&style=for-the-badge&logo=github&label=Tests)](https://github.com/MonsieurBarti/forgeflow/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/license-MIT-blue?style=for-the-badge)](LICENSE)

</div>

---

## Why Forge?

Spec-driven dev tools either over-engineer the workflow (sprint ceremonies, Jira boards, stakeholder syncs) or lose state across context resets. Forge takes a different approach:

- **Beads, not markdown files.** State lives in a queryable, dependency-aware data layer. No `TODO.md` drift, no stale planning docs.
- **Agent coordination built in.** Parallel researchers, planners, executors, and verifiers — each with fresh context windows.
- **Survives context rot.** Session dies? Your project state is in beads, not in a conversation you can't recover.

The complexity is in the system. What you see: a few commands that just work.

---

## Prerequisites

- [Claude Code](https://claude.ai/claude-code) installed
- [beads](https://github.com/steveyegge/beads) (`bd`) installed and configured
- Node.js 20+

## Install

```bash
git clone https://github.com/MonsieurBarti/forgeflow.git
cd forgeflow
node install.js
```

The installer copies commands, agents, workflows, and hooks into `~/.claude/` and registers hooks in `settings.json`.

---

## Getting Started

```
/forge:new              # Define project vision, generate requirements and roadmap
/forge:plan 1           # Research and plan Phase 1
/forge:execute 1        # Build Phase 1 (parallelized task execution)
/forge:verify 1         # UAT against acceptance criteria
/forge:progress         # Check overall status, move to next phase
```

**Already have code?** Run `/forge:map-codebase` first. It spawns parallel agents to analyze your stack, architecture, conventions, and concerns. Then `/forge:new` knows your codebase — questions focus on what you're adding.

---

## Command Reference

All commands are available as Claude Code slash commands (`/forge:<command>`).

### Core Workflow

| Command | Description |
|---------|-------------|
| `/forge:new` | Initialize a new project with vision, requirements, and phased roadmap |
| `/forge:plan [phase]` | Research approach and create task beads with acceptance criteria |
| `/forge:execute [phase]` | Execute tasks in a phase with wave-based parallelization |
| `/forge:verify [phase]` | Verify phase completion against acceptance criteria |
| `/forge:progress` | Show project progress dashboard from bead graph |

### Phase Management

| Command | Description |
|---------|-------------|
| `/forge:discuss-phase [N]` | Gather context through adaptive questioning before planning |
| `/forge:research-phase [N]` | Research how to implement a phase (standalone) |
| `/forge:list-phase-assumptions [N]` | Surface Claude's assumptions before planning |
| `/forge:add-phase` | Add a new phase to the end of the roadmap |
| `/forge:insert-phase` | Insert a phase between existing phases (decimal numbering, e.g. 3.1) |
| `/forge:remove-phase [N]` | Remove a phase and renumber subsequent phases |

### Milestone Lifecycle

| Command | Description |
|---------|-------------|
| `/forge:new-milestone` | Start a new milestone cycle with goals and requirements |
| `/forge:audit-milestone` | Audit milestone completion against original requirements |
| `/forge:complete-milestone` | Archive completed milestone — verify, summarize, and close |
| `/forge:plan-milestone-gaps` | Create phases to close gaps identified by audit |

### Quality & Validation

| Command | Description |
|---------|-------------|
| `/forge:validate-phase [N]` | Retroactively audit and fill validation gaps for a completed phase |
| `/forge:add-tests [N]` | Generate tests for completed phases based on acceptance criteria |
| `/forge:debug` | Systematic debugging with persistent state across context resets |

### Utilities

| Command | Description |
|---------|-------------|
| `/forge:quick` | Execute a quick task with Forge guarantees but skip optional agents |
| `/forge:map-codebase` | Analyze codebase with parallel mapper agents |
| `/forge:health` | Diagnose project health and optionally repair issues |
| `/forge:settings` | Configure workflow toggles (research, verification, parallelism) |
| `/forge:pause` | Save session context for later resumption |
| `/forge:resume` | Restore session context from previous pause |
| `/forge:cleanup` | Archive completed work — clean up bead graph after milestone |
| `/forge:add-todo` | Capture idea or task as todo from conversation context |
| `/forge:check-todos` | List pending todos and select one to work on |
| `/forge:help` | Show available commands and usage guide |

---

## How It Works

Forge maps project management concepts to beads:

| Concept | Bead Type | Label | Key Fields |
|---------|-----------|-------|------------|
| Project | Epic | `forge:project` | description (vision), design (scope/constraints) |
| Milestone | Epic | `forge:milestone` | description (goal), design (audit results) |
| Requirement | Feature | `forge:req` | acceptance_criteria, priority |
| Phase | Epic | `forge:phase` | description (goal), notes (approach) |
| Task | Task | `forge:task` | description, acceptance_criteria, estimated_minutes |
| Research | Task | `forge:research` | notes (findings) |
| Debug Session | Task | `forge:debug` | description (symptoms), notes (investigation state) |

**Dependency patterns:**
- Phases are ordered via `blocks` dependencies on the project epic
- Tasks validate requirements via `validates` dependencies
- The full roadmap is visible with `bd dep tree` on the project epic

**State is queryable:**
```bash
bd list --label forge:phase              # All phases
bd list --label forge:task --status open  # Remaining work
bd dep tree <project-id>                 # Full project graph
```

---

## Architecture

```
commands/forge/         # Slash command definitions (thin prompt wrappers)
forge/
  bin/forge-tools.cjs   # Helper CLI for querying beads context
  workflows/            # Orchestration logic (prompt engineering)
  references/           # Convention docs: labels, model profiles, questioning
agents/                 # Subagent definitions
hooks/                  # Runtime hooks
install.js              # Installer
```

### Agents

Forge uses specialized subagents, each spawned with a fresh context window:

| Agent | Role |
|-------|------|
| **forge-researcher** | Investigates codebase and gathers context for planning |
| **forge-planner** | Creates detailed task breakdowns with acceptance criteria |
| **forge-plan-checker** | Validates plans against requirements (verification loop) |
| **forge-roadmapper** | Generates phased project roadmaps from requirements |
| **forge-executor** | Executes individual tasks within a phase |
| **forge-verifier** | Runs UAT verification against acceptance criteria |
| **forge-debugger** | Systematic debugging with persistent investigation state |
| **forge-codebase-mapper** | Parallel codebase analysis (stack, architecture, conventions, concerns) |

### Hooks

| Hook | Event | Purpose |
|------|-------|---------|
| **forge-context-monitor** | PostToolUse | Tracks active project context |
| **forge-statusline** | — | Displays current phase/task in status bar |
| **forge-update-check** | SessionStart | Checks for new Forge versions |

### Execution Model

```
/forge:execute N
       |
       +-- Analyze plan dependencies
       |
       +-- Wave 1 (independent tasks):
       |     +-- Executor A (fresh 200K context) -> commit
       |     +-- Executor B (fresh 200K context) -> commit
       |
       +-- Wave 2 (depends on Wave 1):
       |     +-- Executor C (fresh 200K context) -> commit
       |
       +-- Verifier
             +-- Check codebase against phase goals
                   +-- PASS -> phase complete
                   +-- FAIL -> issues logged
```

---

## Configuration

Forge uses a two-layer settings system:

| Layer | Location | Scope |
|-------|----------|-------|
| Global | `~/.claude/forge.local.md` | All projects |
| Project | `.forge/settings.yaml` | Current project only |

Project settings override global. Both override built-in defaults.

```bash
/forge:settings                    # Interactive settings UI
/forge:settings get                # Show all effective settings
/forge:settings set KEY VALUE      # Set project-level setting
/forge:settings set --global KEY VALUE  # Set global setting
```

### Model Profiles

Control which Claude model each agent uses. Balance quality vs. token spend.

| Agent | `quality` | `balanced` (default) | `budget` |
|-------|-----------|----------------------|----------|
| forge-planner | opus | opus | sonnet |
| forge-roadmapper | opus | sonnet | sonnet |
| forge-executor | opus | sonnet | sonnet |
| forge-researcher | opus | sonnet | haiku |
| forge-verifier | sonnet | sonnet | haiku |
| forge-plan-checker | sonnet | sonnet | haiku |
| forge-debugger | opus | sonnet | sonnet |
| forge-codebase-mapper | sonnet | haiku | haiku |

Switch profiles: `/forge:settings set model_profile balanced`

Override individual agents:
```yaml
# .forge/settings.yaml
model_overrides:
  forge-executor: opus
  forge-researcher: haiku
```

---

## Beads Integration

Forge is built on beads. Every project artifact — requirements, phases, tasks, research, verification results — is a bead with typed dependencies.

**Why beads instead of markdown files?**

| Markdown files | Beads |
|---------------|-------|
| Drift from reality silently | Single source of truth with version history |
| No dependency awareness | `blocks`, `validates`, `discovered-from` relationships |
| Manual status tracking | Queryable state (`bd list --status open`) |
| Lost on context reset | Persisted in Dolt, survives session death |
| Flat structure | Dependency graphs (`bd dep tree`) |

**Labels used by Forge:**

| Label | Meaning |
|-------|---------|
| `forge:project` | Top-level project container |
| `forge:milestone` | Milestone within a project |
| `forge:phase` | Phase of work |
| `forge:req` | Project requirement |
| `forge:task` | Executable task |
| `forge:research` | Research output |
| `forge:quick` | Ad-hoc task outside phase roadmap |
| `forge:debug` | Active debug session |

---

## Releasing

Releases are automated via GitHub Actions:

1. Update `version` in `package.json`
2. Commit and tag: `git tag v0.2.0`
3. Push: `git push origin v0.2.0`

The release workflow creates a GitHub Release with a tarball.

---

## Acknowledgments

Forge is inspired by [Get Shit Done (GSD)](https://github.com/gsd-build/get-shit-done).

## License

MIT
