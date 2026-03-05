---
name: forge:insert-phase
description: Insert a phase between existing phases using decimal numbering (e.g., 3.1)
argument-hint: <after-phase-number> <description>
allowed-tools: Bash, AskUserQuestion
---

<objective>
Insert a decimal phase for urgent work discovered mid-project that must be completed
between existing integer phases. Uses decimal numbering (e.g., 3.1, 3.2) to preserve
the logical sequence without renumbering the entire roadmap.
</objective>

<context>
Read the Forge conventions: @~/.claude/forge/references/conventions.md
</context>

<execution_context>

## 1. Parse Arguments

First argument: integer phase number to insert after.
Remaining arguments: phase description.

Example: `/forge:insert-phase 3 Fix critical auth bug`
-> after = 3, description = "Fix critical auth bug"

If arguments missing:
```
ERROR: Both phase number and description required
Usage: /forge:insert-phase <after> <description>
Example: /forge:insert-phase 3 Fix critical auth bug
```
Exit.

Validate first argument is an integer.

## 2. Find the Project

```bash
node "$HOME/.claude/forge/bin/forge-tools.cjs" find-project
```

If no project found:
```
ERROR: No Forge project found.
Run /forge:new to initialize a project first.
```
Exit.

## 3. Insert the Phase

```bash
node "$HOME/.claude/forge/bin/forge-tools.cjs" insert-phase <project-id> <after-phase-number> <description>
```

This handles:
- Verifying the target phase exists
- Calculating the next decimal number (checking existing decimals)
- Creating the phase epic bead with `forge:phase` label
- Wiring `parent-child` to the project and `blocks` to the target phase
- Rewiring the next integer phase to depend on the new phase instead of the target

## 4. Show Result

Display a summary:
```
Phase N.M inserted after Phase N:
- Title: Phase N.M: <description>
- Bead: <phase-id>
- Ordering: Phase N -> Phase N.M -> Phase N+1

Next steps:
- /forge:plan N.M — plan this phase
- /forge:progress — see full roadmap
```

If dependency rewiring occurred, note it:
```
Dependency rewired: Phase N+1 now depends on Phase N.M (was Phase N)
```

</execution_context>

<anti_patterns>
- Don't use this for planned work at end of project (use /forge:add-phase)
- Don't insert before Phase 1 (decimal 0.1 makes no sense)
- Don't renumber existing phases
- Don't create tasks yet (that's /forge:plan)
</anti_patterns>
