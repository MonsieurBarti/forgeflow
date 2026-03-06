<purpose>
Execute all planned tasks in a phase. Detect dependency waves and run independent tasks
in parallel via subagents. Each task gets an atomic git commit on completion.
</purpose>

<process>

## 1. Resolve Phase

Same resolution logic as plan-phase: accept phase number, ID, or auto-detect current.

```bash
CONTEXT=$(node "$HOME/.claude/forge/bin/forge-tools.cjs" phase-context <phase-id>)
```

Verify phase is `in_progress` (has been planned). If not planned, suggest `/forge:plan` first.

## 2. Detect Waves

Use the detect-waves tool to automatically group tasks by dependency order:

```bash
WAVES=$(node "$HOME/.claude/forge/bin/forge-tools.cjs" detect-waves <phase-id>)
```

This returns a JSON structure with:
- `waves`: array of wave objects, each containing `tasks_to_execute` and `tasks_already_done`
- `summary`: counts of open/in_progress/closed tasks

If `summary.tasks_open` is 0 and `summary.tasks_closed` equals `summary.total_tasks`,
the phase is already complete — skip to step 4.

If the output contains `circular_or_external_dependency`, report the cycle and ask the user
how to proceed.

## 3. Execute Waves

Before executing, resolve the model for the executor agent:
```bash
MODEL=$(node "$HOME/.claude/forge/bin/forge-tools.cjs" resolve-model forge-executor --raw)
```
If `MODEL` is non-empty, pass it to each Agent call below.

For each wave, in order:

### Wave N Execution

Skip waves where `tasks_to_execute` is empty (all tasks already done).

For tasks in this wave that are `open` or `in_progress`:

**Multiple independent tasks** — execute in **parallel** by spawning multiple forge-executor
agents simultaneously in the same response:

```
Agent(subagent_type="forge-executor", model="<resolved model or omit if null>", prompt="
Execute this task:

Task: <task title> (<task-id>)
Description: <task description>
Acceptance Criteria: <acceptance_criteria>
Phase Context: <phase description>
Project: <project vision>

Instructions:
1. Claim the task: bd update <task-id> --status=in_progress
2. Implement the task following the description and acceptance criteria
3. Run relevant tests to verify acceptance criteria are met
4. Create an atomic git commit with a descriptive message
5. Close the task: bd close <task-id> --reason='<brief summary of what was done>'

If you encounter a blocker:
- bd update <task-id> --notes='BLOCKED: <description>'
- Do NOT close the task
- Report the blocker in your response
")
```

**Single task** — execute it directly without spawning an agent (saves context overhead).
Follow the same steps: claim, implement, verify, commit, close.

### Wait for Wave Completion

After all agents in a wave complete, check results:
```bash
PHASE=$(node "$HOME/.claude/forge/bin/forge-tools.cjs" phase-context <phase-id>)
```

Review the updated task statuses:
- If all wave tasks closed successfully, proceed to the next wave
- If any task is still open or marked BLOCKED, report the status and decide:
  - Skip and continue to next wave (if non-blocking)
  - Fix the issue inline (if quick)
  - Stop execution and report (if the blocker affects downstream waves)

## 4. Phase Completion Check

After all waves complete:
```bash
PHASE=$(node "$HOME/.claude/forge/bin/forge-tools.cjs" phase-context <phase-id>)
```

If all tasks are closed:
```bash
bd close <phase-id> --reason="All tasks completed"
bd remember "forge:phase:<id>:completed $(date -u +%Y-%m-%dT%H:%M:%SZ)"
```

If some tasks remain open, report what's left and suggest next steps.

## 5. Suggest Next Step

- If phase complete: `/forge:verify <phase>` to verify, or `/forge:plan <next-phase>`
- If tasks remaining: fix blockers, then `/forge:execute <phase>` again
- Check overall progress: `/forge:progress`

</process>
