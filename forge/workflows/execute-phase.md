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

Group tasks by dependency wave:
- **Wave 1**: Tasks with no intra-phase blockers (all dependencies are outside the phase or closed)
- **Wave 2**: Tasks that depend only on Wave 1 tasks
- **Wave N**: Tasks that depend only on Wave 1..N-1 tasks

If all tasks are independent, there's a single wave.

## 3. Execute Waves

For each wave, in order:

### Wave N Execution

For tasks in this wave that are `open` or `in_progress`:

If multiple independent tasks exist in the wave, execute them in **parallel** by spawning
multiple forge-executor agents simultaneously:

```
Agent(subagent_type="forge-executor", prompt="
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

If only one task, execute it directly without spawning an agent (saves context overhead).

### Wait for Wave Completion

After all agents in a wave complete, check results:
```bash
PHASE=$(node "$HOME/.claude/forge/bin/forge-tools.cjs" phase-context <phase-id>)
```

If any tasks are still open (failed or blocked), report them before proceeding to the next wave.

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
