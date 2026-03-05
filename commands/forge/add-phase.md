---
name: forge:add-phase
description: Add a new phase to the end of the project roadmap
argument-hint: <description>
allowed-tools: Bash, AskUserQuestion
---

<objective>
Add a new phase to the end of the current project's phase list. Creates a phase epic bead
with proper parent-child and ordering dependencies.
</objective>

<context>
Read the Forge conventions: @~/.claude/forge/references/conventions.md
</context>

<execution_context>

## 1. Parse Arguments

The argument is the phase description.
Example: `/forge:add-phase Add authentication system`

If no arguments provided:
```
ERROR: Phase description required
Usage: /forge:add-phase <description>
Example: /forge:add-phase Add authentication system
```
Exit.

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

## 3. Add the Phase

```bash
node "$HOME/.claude/forge/bin/forge-tools.cjs" add-phase <project-id> <description>
```

This handles:
- Determining the next phase number (max existing + 1)
- Creating the phase epic bead with `forge:phase` label
- Wiring `parent-child` dependency to the project
- Wiring `blocks` dependency to the last existing phase (ordering)

## 4. Show Result

Display a summary:
```
Phase N added to project:
- Title: Phase N: <description>
- Bead: <phase-id>
- Total phases: <count>

Next steps:
- /forge:plan N — plan this phase
- /forge:add-phase <description> — add another phase
- /forge:progress — see full roadmap
```

</execution_context>
