<purpose>
Verify that a phase's tasks meet their acceptance criteria. Automated checks where possible,
then human UAT confirmation. Close verified work and update phase status.
</purpose>

<process>

## 1. Resolve Phase

If a phase number was given (e.g., "3"), resolve it:
```bash
node "$HOME/.claude/forge/bin/forge-tools.cjs" find-project
node "$HOME/.claude/forge/bin/forge-tools.cjs" project-context <project-id>
```
Match the phase number to the ordered phases list.

If a phase ID was given directly, use it.

If no argument, find the current phase (most recent closed or in_progress phase).

## 2. Load Tasks with Acceptance Criteria

Use the batch verification command to get all tasks with their criteria:
```bash
node "$HOME/.claude/forge/bin/forge-tools.cjs" verify-phase <phase-id>
```

This returns `tasks_to_verify` (closed tasks) and `tasks_still_open` (pending tasks).

If there are still-open tasks, warn the user that not all tasks are complete.

## 3. Automated Verification

For each task in `tasks_to_verify`, attempt to verify acceptance criteria programmatically:
- Run existing tests (`npm test`, `cargo test`, `pytest`, etc.)
- Check that expected files exist
- Verify expected behavior via CLI commands
- Look for regressions

Resolve the model for the verifier agent:
```bash
MODEL=$(node "$HOME/.claude/forge/bin/forge-tools.cjs" resolve-model forge-verifier --raw)
```

For phases with multiple tasks, spawn a **forge-verifier** agent (with `model` if non-empty) to handle
parallel verification. For single-task phases, verify inline.

Record results as comments:
```bash
bd comments add <task-id> "Verification: <PASS|FAIL> - <details>"
```

## 4. UAT with User

Present each task's acceptance criteria and automated verification results.
Ask the user to confirm using AskUserQuestion:

For each task (or batch if many):
- "Task: <title> -- Acceptance: <criteria> -- Auto-check: <PASS/FAIL>. Does this meet your expectations?"
- Options: "Yes, verified" / "No, needs work" / "Skip for now"

For tasks that need work:
```bash
bd reopen <task-id>
bd update <task-id> --notes="UAT feedback: <user's feedback>"
```

## 5. Update Phase Status

If all tasks verified:
```bash
bd close <phase-id> --reason="All tasks verified via UAT"
```

If some tasks need rework:
- Keep phase as `in_progress`
- Report which tasks need attention
- Suggest `/forge:execute <phase>` to redo failed tasks

## 6. Requirement Coverage Check

Check which requirements this phase's tasks validate:
```bash
bd dep list <task-id> --type validates
```

Report any requirements that still have no validated tasks across all closed phases.

Suggest next step: `/forge:plan <next-phase>` or `/forge:progress`.

</process>
