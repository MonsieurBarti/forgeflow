---
name: forge:resume
description: Restore session context from previous pause
argument-hint: ""
allowed-tools: Read, Bash, Grep, Glob
---

<objective>
Restore context from a previous `/forge:pause`. Load the project, current phase, in-progress tasks, and recent decisions from beads memory.
</objective>

<process>
1. Recall session state: `bd memories forge:session`
2. Find the project: `node ~/.claude/forge/bin/forge-tools.cjs find-project`
3. Load progress: `node ~/.claude/forge/bin/forge-tools.cjs progress <project-id>`
4. Load current phase context: `node ~/.claude/forge/bin/forge-tools.cjs phase-context <phase-id>`
5. Check for in-progress tasks: `bd list --status=in_progress --label forge:task --json`
6. Present a summary of where things stand and suggest next action (plan, execute, or verify)
</process>
