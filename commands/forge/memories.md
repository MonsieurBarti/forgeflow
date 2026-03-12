---
name: forge:memories
description: Show all Forge memories for the current project, grouped by type
argument-hint: ""
allowed-tools: Read, Bash, Grep, Glob
---

<objective>
Display all persisted Forge memories, grouped by type (project, phase, session, decisions). Memories are stored via `bd remember` and provide persistent context across sessions.
</objective>

<context>
Read the Forge conventions (especially the Memories section): @~/.claude/forge/references/conventions.md
</context>

<process>
1. Fetch all forge memories:
   ```bash
   bd memories forge:
   ```

2. Parse and group the results by memory type prefix:
   - **Project** — keys matching `forge:project:*` (vision, decisions, constraints)
   - **Phase** — keys matching `forge:phase:*` (approach, completed timestamps)
   - **Session** — keys matching `forge:session:*` (current-phase, project-id, notes)
   - **Other** — any remaining `forge:*` keys not matching the above

3. Present the grouped output in a readable format:
   - Use a header for each group
   - Show the memory key and its value
   - If a group has no entries, omit it from the output
   - If no memories exist at all, tell the user no forge memories are stored yet

4. After displaying memories, offer context:
   - Note that memories are written by Forge workflows automatically
   - Mention that `bd remember --key "<key>" "<value>"` adds a memory and `bd forget <key>` removes one
   - Suggest `/forge:resume` if the user wants to restore a full session context
</process>
