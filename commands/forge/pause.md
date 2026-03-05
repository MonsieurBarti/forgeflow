---
name: forge:pause
description: Save session context for later resumption
argument-hint: ""
allowed-tools: Read, Bash
---

<objective>
Save current session context to beads memory for resumption in a future session. Records the active phase, in-progress tasks, recent decisions, and any blockers.
</objective>

<process>
1. Find the current project: `node ~/.claude/forge/bin/forge-tools.cjs find-project`
2. Get progress: `node ~/.claude/forge/bin/forge-tools.cjs progress <project-id>`
3. Save session state:
   ```bash
   bd remember "forge:session:state $(date -u +%Y-%m-%dT%H:%M:%SZ) phase=<current-phase-id> tasks_in_progress=<ids> notes=<brief summary of where things stand>"
   ```
4. Report what was saved and how to resume: `/forge:resume`
</process>
