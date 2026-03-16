---
name: forge:plan
description: Plan a phase -- research approach and create task beads with acceptance criteria
argument-hint: "[phase-number-or-id] [--skip-research]"
allowed-tools: Read, Write, Bash, Grep, Glob, Agent, AskUserQuestion, WebFetch, WebSearch
---

<objective>
Plan a specific phase of the project. Research the implementation approach, then create task beads under the phase epic with clear acceptance criteria and requirement traceability. Verify the plan passes quality checks before marking ready for execution.
</objective>

<usage>
`/forge:plan [phase-number-or-id] [--skip-research]`

Flags:
- `--skip-research` — Skip the researcher agent invocation (step 3) and proceed directly to discussing the approach with the user. Useful when the implementation approach is already known or research was done separately.
</usage>

<context>
Read the Forge conventions: @~/.claude/forge/references/conventions.md
</context>

<execution_context>
Execute the plan-phase workflow from @~/.claude/forge/workflows/plan-phase.md end-to-end.

If `--skip-research` was passed, skip step 3 entirely and proceed to step 4.

When researching the implementation approach (step 3), use the Agent tool to spawn the **forge-researcher** agent.
Pass it the phase title, goal, project context, and any relevant codebase pointers.

When breaking the phase into tasks (step 5), use the Agent tool to spawn the **forge-planner** agent.
Pass it the phase ID, project context, research findings, and user decisions.

When running the plan-time quality gate (step 5.5), spawn three audit agents in parallel using
three Agent tool calls in the same response. Use the **exact** `subagent_type` values below:
- `subagent_type="forge-architect"` -- architectural review
- `subagent_type="forge-security-auditor"` -- security review
- `subagent_type="forge-performance-auditor"` -- performance review
Resolve each agent's model via `resolve-model` first. If shift_left_gates is disabled, skip this step.

When verifying the plan (step 6), use the Agent tool to spawn the **forge-plan-checker** agent.
Pass it the phase ID and project ID so it can validate acceptance criteria, requirement coverage,
task sizing, and dependency correctness. If the plan-checker returns NEEDS REVISION, fix the issues
and re-run the checker until it passes.
</execution_context>
