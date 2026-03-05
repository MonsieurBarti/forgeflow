---
name: forge:help
description: Show available Forge commands and usage guide
argument-hint: ""
allowed-tools: Read
---

<objective>
Display a quick reference of all available Forge commands, agents, and workflows.
</objective>

<execution_context>
Output the following help guide directly (no tool calls needed):

## Forge — Project Orchestration for Claude Code

### Commands

| Command | Description |
|---------|-------------|
| `/forge:new` | Initialize a new project with vision, requirements, and phased roadmap |
| `/forge:plan [phase]` | Plan a phase — research approach and create task beads with acceptance criteria |
| `/forge:execute [phase]` | Execute tasks in a phase with wave-based parallelization |
| `/forge:verify [phase]` | Verify phase completion against acceptance criteria |
| `/forge:progress` | Show project progress dashboard from bead graph |
| `/forge:config` | View or modify configuration (`list`, `get`, `set`, `clear`) |
| `/forge:pause` | Save session context for later resumption |
| `/forge:resume` | Restore session context from previous pause |
| `/forge:help` | Show this help guide |

### Typical Workflow

```
/forge:new              # Define project, generate requirements and roadmap
/forge:plan 1           # Research and plan Phase 1
/forge:execute 1        # Build Phase 1 (parallelized task execution)
/forge:verify 1         # UAT against acceptance criteria
/forge:progress         # Check overall status, move to next phase
```

### Agents

Forge uses specialized subagents spawned automatically during workflows:

| Agent | Role |
|-------|------|
| **forge-researcher** | Investigates codebase and gathers context for planning |
| **forge-planner** | Creates detailed task breakdowns with acceptance criteria |
| **forge-plan-checker** | Validates plans against requirements |
| **forge-roadmapper** | Generates phased project roadmaps |
| **forge-executor** | Executes individual tasks within a phase |
| **forge-verifier** | Runs UAT verification against acceptance criteria |

### Hooks

| Hook | Event | Purpose |
|------|-------|---------|
| **forge-context-monitor** | PostToolUse | Tracks active project context and warns on context limits |
| **forge-statusline** | — | Displays current phase/task in the status bar |
| **forge-update-check** | SessionStart | Checks for new Forge versions |

### Configuration

Manage with `/forge:config`:

| Key | Default | Description |
|-----|---------|-------------|
| `context_warning` | `0.35` | Context window warning threshold (0-1) |
| `context_critical` | `0.25` | Context window critical/block threshold (0-1) |
| `update_check` | `true` | Check for updates on session start |
| `auto_research` | `true` | Auto-run research before planning |

### Data Model

Forge stores everything as beads:

| Concept | Bead Type |
|---------|-----------|
| Project | Epic with `forge:project` label |
| Requirement | Feature bead with `forge:req` label |
| Phase | Epic with `forge:phase` label |
| Task | Task bead under phase epic |
| Roadmap | Dependency tree on project epic |

### More Info

- Project repo: `git remote -v` to check
- Conventions: `~/.claude/forge/references/conventions.md`
</execution_context>
