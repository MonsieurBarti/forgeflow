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
1. Load session state:
   ```bash
   node "$HOME/.claude/forge/bin/forge-tools.cjs" load-session
   ```

2. If a project was found, load detailed phase context for the current phase:
   ```bash
   node "$HOME/.claude/forge/bin/forge-tools.cjs" phase-context <current-phase-id>
   ```

3. Check for any session notes:
   ```bash
   bd memories forge:session:notes
   ```

4. Present a summary:
   - Project name and overall progress
   - Current phase and task status
   - In-progress tasks that need attention
   - Any saved notes from previous session

5. Suggest next action based on state:
   - Has in-progress tasks -> "Continue with these tasks, or run `/forge:execute <phase>`"
   - Phase needs planning -> `/forge:plan <phase>`
   - Phase complete -> `/forge:verify <phase>`
   - No project found -> `/forge:new`
</process>
