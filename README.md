# Forge

GSD-style project orchestration for Claude Code, backed by [beads](https://github.com/steveyegge/beads).

Instead of managing state through markdown planning files, Forge uses beads as its data layer -- epics for milestones, dependency graphs for phase ordering, and bead metadata for plans, requirements, and verification.

## Prerequisites

- [Claude Code](https://claude.ai/claude-code) installed
- [beads](https://github.com/steveyegge/beads) (`bd`) installed and configured

## Install

```bash
node install.js
```

Or manually copy into `~/.claude/`:

```bash
cp -r commands/forge ~/.claude/commands/forge
cp -r forge ~/.claude/forge
cp -r agents ~/.claude/agents/
cp hooks/* ~/.claude/hooks/
```

## Usage

```
/forge:new              # Initialize a new project
/forge:plan [phase]     # Plan a phase (research + task creation)
/forge:execute [phase]  # Execute tasks in a phase
/forge:verify [phase]   # UAT against acceptance criteria
/forge:progress         # Status dashboard from bead graph
/forge:pause            # Save session context
/forge:resume           # Restore session context
```

## How It Works

Forge maps GSD concepts to beads:

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
  templates/            # Prompt templates for agents
  references/           # Convention docs and examples
agents/                 # Subagent definitions
hooks/                  # Context monitor, statusline
install.js              # Installer
```

## License

MIT
