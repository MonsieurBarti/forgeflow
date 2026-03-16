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

When detecting waves (step 2), use forge-tools to automatically group tasks:
```bash
node "$HOME/.claude/forge/bin/forge-tools.cjs" detect-waves <phase-id>
```

When executing tasks in a wave (step 3), spawn **forge-executor** agents for each task.
If the wave has multiple independent tasks, spawn them **in parallel** using multiple
Agent tool calls in the same response. Pass each agent the task ID, description,
acceptance criteria, and phase context.

If the wave has only one task, execute it directly without spawning an agent
(saves context overhead).

After each wave completes, verify results with:
```bash
node "$HOME/.claude/forge/bin/forge-tools.cjs" phase-context <phase-id>
```

If any tasks failed or are blocked, report the status before proceeding to the next wave.

When running the per-wave shift-left gate (step 3.5), spawn two audit agents in parallel using
two Agent tool calls in the same response. Use the **exact** `subagent_type` values:
- `subagent_type="forge-security-auditor"` -- security audit of wave changes
- `subagent_type="forge-architect"` -- architectural audit of wave changes
Resolve each agent's model via `resolve-model` first. If shift_left_gates is disabled, skip this step.
</execution_context>
