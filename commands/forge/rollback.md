---
name: forge:rollback
description: Rollback a failed phase execution — revert commits, reopen tasks, restore pre-execution state
argument-hint: "<phase-id>"
allowed-tools: Read, Bash, Grep
---

<objective>
Rollback a failed or problematic phase execution using checkpoint data. Reverts git
commits made during execution, reopens tasks that were closed by execution (preserving
tasks that were already closed), and restores the phase to a re-executable state.
</objective>

<context>
Read the Forge conventions: @~/.claude/forge/references/conventions.md
</context>

<execution_context>
Execute the rollback workflow from @forge/workflows/rollback.md end-to-end.

Key safety rules:
- Use `git revert` (NOT `git reset --hard`) to undo commits
- Only reopen tasks closed during execution — check `preExistingClosed` from checkpoint
- Always show the user what will be reverted before executing git revert
- If no checkpoint exists, abort gracefully with a clear message
</execution_context>
