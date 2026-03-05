---
name: forge:pause
description: Save session context for later resumption
argument-hint: ""
allowed-tools: Read, Bash
---

<objective>
Save current session context to beads memory for resumption in a future session. Records the active phase, in-progress tasks, and progress snapshot.
</objective>

<process>
1. Find the current project:
   ```bash
   node "$HOME/.claude/forge/bin/forge-tools.cjs" find-project
   ```

2. Save session state using the structured save command:
   ```bash
   node "$HOME/.claude/forge/bin/forge-tools.cjs" save-session <project-id>
   ```

3. If the user provided additional context or notes, save those as a decision memory:
   ```bash
   bd remember "forge:session:notes <user's notes about current state>"
   ```

4. Report what was saved:
   - Current phase and progress
   - In-progress tasks
   - How to resume: `/forge:resume`
</process>
