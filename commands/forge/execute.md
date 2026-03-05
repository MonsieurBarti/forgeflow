---
name: forge:execute
description: Execute tasks in a phase with wave-based parallelization
argument-hint: "[phase-number-or-id]"
allowed-tools: Read, Write, Edit, Bash, Grep, Glob, Agent
---

<objective>
Execute all planned tasks in a phase. Detect dependency waves and run independent tasks in parallel via subagents. Each task gets an atomic git commit on completion.
</objective>

<context>
Read the Forge conventions: @~/.claude/forge/references/conventions.md
</context>

<execution_context>
Execute the execute-phase workflow from @~/.claude/forge/workflows/execute-phase.md end-to-end.
</execution_context>
