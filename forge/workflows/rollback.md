<purpose>
Rollback a failed phase execution. Reverts commits, reopens execution-closed tasks,
and restores the phase to a pre-execution state using checkpoint data.
</purpose>

<process>

## 1. Resolve Phase

Accept a phase ID argument. If not provided, auto-detect using the current session phase.

```bash
CONTEXT=$(node "$HOME/.claude/forge/bin/forge-tools.cjs" phase-context <phase-id>)
```

Verify the phase exists and is `in_progress`. If the phase is `closed`, warn the user
that rolling back a closed phase is unusual and confirm before proceeding.

## 2. Load Checkpoint

```bash
CHECKPOINT=$(node "$HOME/.claude/forge/bin/forge-tools.cjs" checkpoint-load <phase-id>)
```

If the checkpoint is empty or missing, abort with:
> No checkpoint found for phase `<phase-id>`. Rollback requires a checkpoint saved during execution.

Extract from the checkpoint:
- `preExistingClosed` — task IDs that were closed before execution (default: `[]`)
- `branchName` — the branch execution ran on
- `baseCommitSha` — the commit SHA before execution started
- `taskStatuses` — map of task IDs to their status at checkpoint time

If `baseCommitSha` is missing, warn that git rollback cannot be performed (only task
rollback will happen).

## 3. Reopen Execution-Closed Tasks

Get current task list:
```bash
TASKS=$(bd children <phase-id> --json)
```

For each task that is currently `closed` but whose ID is **not** in `preExistingClosed`:
```bash
bd update <task-id> --status=open
```

These are tasks that were closed during execution and need to be reopened.
Tasks in `preExistingClosed` stay closed — they were done before execution began.

## 4. Git Revert Commits

If `baseCommitSha` is present:

List commits made after the base:
```bash
git log --oneline <baseCommitSha>..HEAD
```

Show the user what will be reverted. If there are commits:
```bash
git revert --no-commit <baseCommitSha>..HEAD
git commit -m "revert: rollback phase <phase-id> execution"
```

This uses `git revert` (not `git reset --hard`) to preserve history safely.

If there are no commits after `baseCommitSha`, skip this step.

If `baseCommitSha` is missing, skip git rollback and inform the user that only task
status was rolled back.

## 5. Reopen Phase

If the phase was closed during execution, reopen it:
```bash
bd update <phase-id> --status=in_progress
```

## 6. Clear Checkpoint

Remove the checkpoint so the phase can be re-executed cleanly:
```bash
bd forget "forge:checkpoint:<phase-id>"
```

## 7. Summary

Report to the user:
- Number of tasks reopened (and which ones)
- Number of commits reverted (and the revert commit SHA)
- Current phase status
- Suggest next steps: fix issues, then `/forge:execute <phase-id>` again

</process>
