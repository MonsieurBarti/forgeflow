<purpose>
Verify that a phase's tasks meet their acceptance criteria. Automated checks where possible,
then human UAT confirmation. Includes quality gate audit, re-verification after fixes, and
retrospective capture. Close verified work and update phase status.
</purpose>

<process>

## 1. Resolve Phase

If a phase number was given, resolve it:
```bash
PROJECT=$(node "$HOME/.claude/forge/bin/forge-tools.cjs" find-project)
CONTEXT=$(node "$HOME/.claude/forge/bin/forge-tools.cjs" project-context-slim <project-id>)
```
Cache PROJECT and CONTEXT for reuse in later steps (e.g., step 9). Do NOT re-call these commands.

Match phase number to ordered phases list. If a phase ID was given, use it directly. If no argument, find the current phase (most recent closed or in_progress).

## 2. Load Tasks with Acceptance Criteria

```bash
node "$HOME/.claude/forge/bin/forge-tools.cjs" verify-phase <phase-id>
```

Returns `tasks_to_verify` (closed tasks) and `tasks_still_open` (pending). Warn user if not all tasks are complete.

## 3. Automated Verification

For each task in `tasks_to_verify`, verify acceptance criteria programmatically:
- Run existing tests (`npm test`, `cargo test`, `pytest`, etc.)
- Check expected files exist
- Verify expected behavior via CLI commands
- Look for regressions

Resolve the verifier model:
```bash
MODEL=$(node "$HOME/.claude/forge/bin/forge-tools.cjs" resolve-model forge-verifier --raw)
```

For multi-task phases, spawn a **forge-verifier** agent (with `model` if non-empty). For single-task phases, verify inline.

Record results:
```bash
bd comments add <task-id> "Verification: <PASS|FAIL> - <details>"
```

## 4. UAT with User

Present each task's acceptance criteria and automated verification results. Ask user to confirm via AskUserQuestion:
- "Task: <title> -- Acceptance: <criteria> -- Auto-check: <PASS/FAIL>. Does this meet your expectations?"
- Options: "Yes, verified" / "No, needs work" / "Skip for now"

For tasks that need work:
```bash
bd reopen <task-id>
bd update <task-id> --notes="UAT feedback: <user's feedback>"
```

## 5. Update Phase Status

### Hard Gate: Block Closure on Failed Verification

Before calling `bd close`, tally verification verdicts from Steps 3 and 4.

**If any task has FAIL verdict** (automated or UAT rejection), MUST NOT close those tasks or the phase unless `--force` was passed.

```
------------------------------------------------------------
 Closure blocked: N task(s) failed verification.
------------------------------------------------------------

  - <task-title> (<task-id>): <reason>

Next steps:
  1. Fix failing tasks and re-run /forge:verify <phase>
  2. Or pass --force to override (not recommended)
------------------------------------------------------------
```

**If --force:** close despite failures with warning:
```
WARNING: Closing phase despite N failed task(s) -- --force override in effect.
```

### Close Verified Tasks

For each task that passed both automated and UAT verification, close it now.
The verify workflow is the sole owner of task closure -- executors only signal completion.

```bash
bd close <task-id> --reason="Verified: <summary of verification outcome>"
```

Do NOT close tasks that failed verification. Failed tasks get reopened for rework:
```bash
bd reopen <task-id>
bd update <task-id> --notes="Verification failed: <reason>"
```

### Normal Closure (all verified or --force)

All verified (or --force):
```bash
bd close <phase-id> --reason="All tasks verified via UAT"
```

Some need rework (no --force): keep phase `in_progress`, report tasks needing attention, suggest `/forge:execute <phase>`.

## 6. Quality Gate (Conditional Pre-PR Audit)

Runs only when phase is being closed. Skip if closure was blocked.

```bash
PRE_QG_SHA=$(git rev-parse HEAD)
```

**Check quality_gate setting:**
```bash
node "$HOME/.claude/forge/bin/forge-tools.cjs" settings-load
```

> Settings should be loaded once and cached for the entire workflow run.

- If `quality_gate` is `false`: skip, proceed to step 8.
- If `true` (or not explicitly false): run quality gate pipeline.

**Scope changed files:**
```bash
BASE=$(git merge-base HEAD main 2>/dev/null || git merge-base HEAD master 2>/dev/null)
CHANGED_FILES=$(git diff --name-only "$BASE"..HEAD)
```

If no files changed, skip silently.

**Run quality gate:** Follow `@~/.claude/forge/workflows/quality-gate.md`, passing changed files as scope. Spawns audit agents, collects findings, presents to user.

After completion:
- No findings: inform user, proceed to step 8.
- Findings present: user can approve/skip fixes via quality-gate workflow.
- Fixes applied: fixer agent handles commits.
- Sub-workflow aborted: treat as skipped.
- User skips all: proceed normally.

## 7. Re-verify After Quality Gate

Runs only when phase is being closed. Skip if closure was blocked or quality gate was skipped.

```bash
POST_QG_SHA=$(git rev-parse HEAD)
```

- If `POST_QG_SHA == PRE_QG_SHA`: log "No quality gate changes -- skipping re-verification." Proceed to Step 8.
- If different: re-run full automated verification on ALL tasks. Reuse `MODEL` from Step 3. For multi-task phases, spawn **forge-verifier** agent.

```bash
bd comments add <task-id> "Re-verification (post quality gate): <PASS|FAIL> - <details>"
```

Re-run UAT only for tasks that passed in Step 3 but failed in re-verification (regressions). Apply same hard gate as Step 5.

## 8. Capture Phase Retrospective

Runs only when phase is being closed. Skip if blocked.

**Derive dynamic options from phase context:**
- `completed_tasks`: titles of all verified/closed tasks from Step 2 (`tasks_to_verify`)
- `blocked_tasks`: tasks whose notes contain "BLOCKED" (from `tasks_to_verify` and `tasks_still_open`)

**Question 1 -- What went well** via AskUserQuestion (multiSelect: true):
- Question: "What went well in this phase? Select all that apply."
- Options:
  - "Clean task execution"
  - "Good acceptance criteria"
  - "Effective parallel execution"
  - One entry per completed task title: "Completed: <task-title>"
  - "Other"
  - "Nothing notable"

**Question 2 -- What did not go well** via AskUserQuestion (multiSelect: true):
- Question: "What did not go well? Select all that apply."
- Options:
  - "Scope too large"
  - "Unclear criteria"
  - "Blockers delayed progress"
  - "Verification found regressions"
  - One entry per blocked task: "Blocked: <task-title> (<task-id>)"
  - "Other"
  - "Nothing notable"

**Question 3 -- Improvements for next time** via AskUserQuestion (multiSelect: true):
- Question: "What improvements would you suggest? Select all that apply."
- Options:
  - "Smaller scope per phase"
  - "Better acceptance criteria"
  - "More upfront research"
  - "Run tests earlier in the cycle"
  - "Better dependency ordering"
  - "Other"
  - "No improvements needed"

**Build context-write payload** from the 3 answers (recognized fields: `agent`, `task`, `status`, `findings`, `decisions`, `blockers`, `artifacts`, `next_steps`):
- **findings**: all selected items from Question 1 (what went well)
- **blockers**: all selected items from Question 2 (what didn't go well)
- **decisions**: all selected items from Question 3 (improvements)

```bash
node "$HOME/.claude/forge/bin/forge-tools.cjs" context-write <phase-id> \
  '{"agent":"forge-verifier","status":"completed","findings":["<went-well-1>","<went-well-2>"],"decisions":["<improvement-1>"],"blockers":["<didnt-go-well-1>"]}'
```

Example:
```bash
node "$HOME/.claude/forge/bin/forge-tools.cjs" context-write phase-abc123 \
  '{"agent":"forge-verifier","status":"completed","findings":["Clean task execution","Completed: Add retry logic"],"decisions":["Better acceptance criteria","Run tests earlier in the cycle"],"blockers":["Blockers delayed progress","Blocked: Fix auth flow (task-xyz)"]}'
```

## 9. Requirement Coverage Check

> Reuse the cached project-context-slim data from Step 1 to identify the parent milestone.

Identify parent milestone. If none, skip silently.

If milestone found, fetch forge:req beads:
```bash
bd dep list <milestone-id> --type contains --json
```

<!-- Known N+1 pattern: per-requirement bd dep list calls. Pending bd CLI batch query support. -->
For each req, check validates links from this phase's tasks:
```bash
bd dep list <req-id> --type validates --json
```

Build coverage map (covered vs uncovered). If uncovered reqs exist, show warning:
```
------------------------------------------------------------
 WARNING: Uncovered Requirements in Parent Milestone
------------------------------------------------------------

  - <req-title> (<req-id>)

To add coverage: bd dep add <task-id> <req-id> --type validates
Or run /forge:audit-milestone to check full milestone coverage.
------------------------------------------------------------
```

**Auto-close satisfied requirements:** For each open req with at least one `validates` link where ALL validating tasks are closed:
```bash
bd close <req-id> --reason="All validating tasks completed"
```

Report auto-closed requirements. Skip reqs with no `validates` links.

## 10. Push Branch and Create Pull Request

After phase closure and coverage check, push and open PR. Forge NEVER merges -- user reviews and merges.

```bash
BRANCH=$(git branch --show-current)
node "$HOME/.claude/forge/bin/forge-tools.cjs" branch-push "$BRANCH"
```

If no commits on branch, skip PR creation.

```bash
node "$HOME/.claude/forge/bin/forge-tools.cjs" pr-create <phase-id>
```

PR description auto-generated with phase goal, tasks, and coverage. If PR exists, reports existing URL gracefully.

Display PR URL:
> The PR is ready for your review. Forge does not merge -- please review, approve, and merge when satisfied. Run `/forge:plan <next-phase>` to continue.

Suggest next step: `/forge:plan <next-phase>` or `/forge:progress`.

</process>
</output>
</output>
