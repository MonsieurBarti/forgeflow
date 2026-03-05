---
name: forge:verify
description: Verify phase completion against acceptance criteria
argument-hint: "[phase-number-or-id]"
allowed-tools: Read, Write, Bash, Grep, Glob, Agent, AskUserQuestion
---

<objective>
Verify that a phase's tasks meet their acceptance criteria. Run automated checks where possible, then present results to the user for UAT confirmation. Close verified tasks and update phase status.
</objective>

<context>
Read the Forge conventions: @~/.claude/forge/references/conventions.md
</context>

<execution_context>
Execute the verify workflow from @~/.claude/forge/workflows/verify.md end-to-end.
</execution_context>
