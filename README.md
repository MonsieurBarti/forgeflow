# Forge

Project orchestration for Claude Code, backed by [beads](https://github.com/steveyegge/beads).

Instead of managing state through markdown planning files, Forge uses beads as its data layer -- epics for milestones, dependency graphs for phase ordering, and bead metadata for plans, requirements, and verification.

## Prerequisites

- [Claude Code](https://claude.ai/claude-code) installed
- [beads](https://github.com/steveyegge/beads) (`bd`) installed and configured
- Node.js 18+

## Install

### Homebrew (macOS/Linux)

```bash
brew tap MonsieurBarti/forge
brew install forge
node "$(brew --prefix forge)/libexec/install.js"
```

### npm (any platform)

```bash
npx forge
```

### Manual

```bash
git clone https://github.com/MonsieurBarti/forge.git
cd forge
node install.js
```

The installer copies commands, agents, workflows, and hooks into `~/.claude/` and registers hooks in `settings.json`.

## Usage

All commands are available as Claude Code slash commands:

| Command | Description |
|---------|-------------|
| `/forge:new` | Initialize a new project with vision, requirements, and phased roadmap |
| `/forge:plan [phase]` | Plan a phase -- research approach and create task beads with acceptance criteria |
| `/forge:execute [phase]` | Execute tasks in a phase with wave-based parallelization |
| `/forge:verify [phase]` | Verify phase completion against acceptance criteria |
| `/forge:progress` | Show project progress dashboard from bead graph |
| `/forge:config` | View or modify configuration |
| `/forge:pause` | Save session context for later resumption |
| `/forge:resume` | Restore session context from previous pause |
| `/forge:help` | Show available commands and usage guide |

### Typical workflow

```
/forge:new              # Define project, generate requirements and roadmap
/forge:plan 1           # Research and plan Phase 1
/forge:execute 1        # Build Phase 1 (parallelized task execution)
/forge:verify 1         # UAT against acceptance criteria
/forge:progress         # Check overall status, move to next phase
```

## How It Works

Forge maps project management concepts to beads:

| Concept | Bead Representation |
|---------|-------------------|
| Project | Epic with `forge:project` label |
| Requirement | Feature bead with `acceptance_criteria`, `forge:req` label |
| Phase | Epic with `forge:phase` label, ordered via `blocks` deps |
| Task/Plan | Task bead under phase epic, `validates` deps to requirements |
| State | Bead statuses + `bd memories` |
| Roadmap | `bd dep tree` on the project epic |

## Architecture

```
commands/forge/         # Slash command definitions (thin wrappers)
forge/
  bin/forge-tools.cjs   # Helper CLI for querying beads context
  workflows/            # Orchestration logic (prompt engineering)
  references/           # Convention docs and examples
agents/                 # Subagent definitions (planner, executor, verifier, etc.)
hooks/                  # Context monitor, statusline, update checker
install.js              # Installer
```

### Agents

Forge uses specialized subagents for different workflow stages:

- **forge-researcher** -- Investigates codebase and gathers context for planning
- **forge-planner** -- Creates detailed task breakdowns with acceptance criteria
- **forge-plan-checker** -- Validates plans against requirements
- **forge-roadmapper** -- Generates phased project roadmaps
- **forge-executor** -- Executes individual tasks within a phase
- **forge-verifier** -- Runs UAT verification against acceptance criteria

### Hooks

- **forge-context-monitor** (PostToolUse) -- Tracks active project context
- **forge-statusline** -- Displays current phase/task in the status bar
- **forge-update-check** (SessionStart) -- Checks for new Forge versions

## Releasing

Releases are automated via GitHub Actions:

1. Update `version` in `package.json`
2. Commit and tag: `git tag v0.2.0`
3. Push: `git push origin v0.2.0`

The release workflow creates a GitHub Release with a tarball and auto-updates the Homebrew formula.

## License

MIT
