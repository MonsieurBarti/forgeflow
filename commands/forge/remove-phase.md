---
name: forge:remove-phase
description: Remove a phase from the roadmap and renumber subsequent phases
argument-hint: <phase-number>
allowed-tools: Bash, AskUserQuestion
---

<objective>
Remove an unstarted phase from the project roadmap. Closes the phase bead and its tasks,
rewires dependency chains, and renumbers subsequent phases to maintain a clean sequence.
</objective>

<context>
Read the Forge conventions: @~/.claude/forge/references/conventions.md
</context>

<execution_context>

## 1. Parse Arguments

The argument is the phase number to remove (integer or decimal).
Example: `/forge:remove-phase 5`
Example: `/forge:remove-phase 3.1`

If no argument provided:
```
ERROR: Phase number required
Usage: /forge:remove-phase <phase-number>
Example: /forge:remove-phase 5
```
Exit.

## 2. Find the Project

```bash
node "$HOME/.claude/forge/bin/forge-tools.cjs" find-project
```

If no project found:
```
ERROR: No Forge project found.
```
Exit.

## 3. Show Current Phases

```bash
node "$HOME/.claude/forge/bin/forge-tools.cjs" list-phases <project-id>
```

Verify the target phase exists and show what will happen.

## 4. Confirm Removal

Use AskUserQuestion to confirm:
```
Removing Phase <N>: <title>

This will:
- Close the phase bead and its <M> tasks
- Rewire dependencies to skip this phase
- Renumber subsequent phases (if integer phase)

Proceed? (yes/no)
```

If the phase is in_progress or closed, warn:
```
WARNING: Phase <N> is <status>. This is unusual.
Are you sure you want to remove it? (yes/no)
```

## 5. Execute Removal

If user confirms:
```bash
node "$HOME/.claude/forge/bin/forge-tools.cjs" remove-phase <project-id> <phase-number>
```

If the phase has tasks and is in_progress/closed, use `--force`:
```bash
node "$HOME/.claude/forge/bin/forge-tools.cjs" remove-phase <project-id> <phase-number> --force
```

This handles:
- Closing the phase bead with "Removed from roadmap" reason
- Closing child task beads
- Rewiring `blocks` dependencies (successors now depend on predecessor)
- Renumbering subsequent phases (decrementing numbers for integer phases)

## 6. Show Result

```
Phase <N> (<title>) removed.

Changes:
- Phase bead closed: <id>
- Tasks closed: <count>
- Dependencies rewired: <details>
- Phases renumbered: <count>
- Remaining phases: <count>

Next steps:
- /forge:progress — see updated roadmap
```

</execution_context>

<anti_patterns>
- Don't remove completed phases without --force
- Don't manually rewire dependencies — let forge-tools handle it
- Don't create placeholder beads for removed phases
</anti_patterns>
