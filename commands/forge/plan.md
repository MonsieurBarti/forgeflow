---
name: forge:plan
description: Plan a phase -- research approach and create task beads with acceptance criteria
argument-hint: "[phase-number-or-id]"
allowed-tools: Read, Write, Bash, Grep, Glob, Agent, AskUserQuestion, WebFetch, WebSearch
---

<objective>
Plan a specific phase of the project. Research the implementation approach, then create task beads under the phase epic with clear acceptance criteria and requirement traceability.
</objective>

<context>
Read the Forge conventions: @~/.claude/forge/references/conventions.md
</context>

<execution_context>
Execute the plan-phase workflow from @~/.claude/forge/workflows/plan-phase.md end-to-end.
</execution_context>
