---
name: forge:progress
description: Show project progress dashboard from bead graph
argument-hint: ""
allowed-tools: Read, Bash, Grep, Glob
---

<objective>
Display a rich progress dashboard for the current Forge project by querying the bead graph. Show phase completion, current work, blockers, and next steps.
</objective>

<context>
Read the Forge conventions: @~/.claude/forge/references/conventions.md
</context>

<execution_context>
Execute the progress workflow from @~/.claude/forge/workflows/progress.md end-to-end.
</execution_context>
