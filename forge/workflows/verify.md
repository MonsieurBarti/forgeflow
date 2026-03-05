<purpose>
Verify that a phase's tasks meet their acceptance criteria. Automated checks where possible,
then human UAT confirmation. Close verified work and update phase status.
</purpose>

<process>

## 1. Resolve Phase

Same resolution as other workflows. Load phase context:
```bash
PHASE=$(node "$HOME/.claude/forge/bin/forge-tools.cjs" phase-context <phase-id>)
```

## 2. Gather Acceptance Criteria

For each closed task in the phase, extract its acceptance_criteria:
```bash
bd show <task-id> --json
```

## 3. Automated Verification

For each task, attempt to verify acceptance criteria programmatically:
- Run existing tests (`npm test`, `cargo test`, `pytest`, etc.)
- Check that expected files exist
- Verify expected behavior via CLI commands
- Look for regressions

Record results as comments:
```bash
bd comments add <task-id> "Verification: <PASS|FAIL> - <details>"
```

## 4. UAT with User

Present each task's acceptance criteria and automated verification results.
Ask the user to confirm:

Use AskUserQuestion for each task (or batch if many):
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
bd dep list <task-id> --type=validates
```

Report any requirements that still have no validated tasks across all closed phases.

Suggest next step: `/forge:plan <next-phase>` or `/forge:progress`.

</process>
