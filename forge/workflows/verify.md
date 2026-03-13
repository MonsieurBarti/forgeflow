<purpose>
Verify that a phase's tasks meet their acceptance criteria. Automated checks where possible,
then human UAT confirmation. Includes quality gate audit, re-verification after fixes, and
retrospective capture. Close verified work and update phase status.
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

### Hard Gate: Block Closure on Failed Verification

Before calling `bd close` on any task or the phase, tally the verification verdicts from
Step 3 and Step 4.

**If any task has a verdict of FAIL** (either from automated checks or UAT rejection),
the workflow MUST NOT call `bd close` on those tasks or the phase — unless the user
explicitly passed `--force`.

Output the following blocking message and stop:

```
------------------------------------------------------------
 Closure blocked: N task(s) failed verification.
------------------------------------------------------------

The following task(s) did not pass verification:
  - <task-title> (<task-id>): <reason>

Next steps:
  1. Fix the failing tasks and re-run /forge:verify <phase>
  2. Or pass --force to override and close despite failures (not recommended)
------------------------------------------------------------
```

**If --force was passed**, close despite failures but emit a clear warning first:

```
WARNING: Closing phase despite N failed task(s) — --force override in effect.
```

Then proceed with closure as normal.

### Normal Closure (all tasks verified or --force)

If all tasks verified (or --force override):
```bash
bd close <phase-id> --reason="All tasks verified via UAT"
```

If some tasks need rework (no --force):
- Keep phase as `in_progress`
- Report which tasks need attention
- Suggest `/forge:execute <phase>` to redo failed tasks

## 6. Quality Gate (Conditional Pre-PR Audit)

This step runs only when the phase is being closed (all tasks verified or --force override).
Skip this step if closure was blocked.

**Capture the pre-quality-gate commit SHA** (used by Step 7 to detect new commits):

```bash
PRE_QG_SHA=$(git rev-parse HEAD)
```

**Check the quality_gate setting:**

```bash
node "$HOME/.claude/forge/bin/forge-tools.cjs" settings-load
```

> **Note:** Settings should be loaded once and cached for the entire workflow run.
> Sub-workflows (e.g., quality-gate.md) should reuse these cached settings rather than
> re-invoking `settings-load`.

Parse the result and read the `quality_gate` value.

- If `quality_gate` is `false`, skip this step silently — proceed directly to step 8.
- If `quality_gate` is `true` (or not explicitly set to false), run the quality gate pipeline below.

**Scope changed files:**

Determine which files were changed in this phase branch relative to the base branch:
```bash
BASE=$(git merge-base HEAD main 2>/dev/null || git merge-base HEAD master 2>/dev/null)
CHANGED_FILES=$(git diff --name-only "$BASE"..HEAD)
```

If no files were changed, skip the quality gate silently.

**Run the quality gate pipeline:**

Follow the quality-gate workflow defined in `@~/.claude/forge/workflows/quality-gate.md`,
passing the list of changed files as scope. This workflow spawns the three audit agents
(security-auditor, code-reviewer, performance-auditor), collects findings in the shared
audit-findings schema, and presents them to the user.

**Present findings and apply fixes:**

After the quality gate workflow completes:

- If there are no findings (all agents report zero issues), inform the user and proceed to step 8.
- If there are findings, they are presented to the user as part of the quality-gate workflow.
  The user can approve fixes, skip individual findings, or skip all.
- If the user approves fixes and changes are applied, the quality-gate sub-workflow's fixer
  agent handles committing them. No additional `git add` / `git commit` is needed here.
- If the quality gate sub-workflow aborted due to agent failures, treat this step as skipped
  (no re-verification needed in Step 7).
- If the user skips all findings (approves none), proceed to step 8 normally with no
  additional commits.

## 7. Re-verify After Quality Gate

This step runs only when the phase is being closed (all tasks verified or --force override).
Skip this step if closure was blocked.

**Check whether quality gate produced new commits:**

Compare `HEAD` after Step 6 completes with `PRE_QG_SHA` captured at the start of Step 6.
If the quality gate was skipped (setting disabled, no changed files, or sub-workflow aborted),
skip this step as well.

```bash
POST_QG_SHA=$(git rev-parse HEAD)
```

- If `POST_QG_SHA` equals `PRE_QG_SHA` (no new commits from quality gate):
  Log `"No quality gate changes — skipping re-verification."` and proceed to Step 8.
  Note: if the quality gate ran but the user approved zero fixes, `POST_QG_SHA` will equal
  `PRE_QG_SHA` and this step is a no-op — this is expected behavior.

- If `POST_QG_SHA` differs (quality gate produced fix commits): run re-verification below.

**Re-run full automated verification:**

Re-run the same automated verification from Step 3 on ALL tasks (not just tasks affected by
the quality gate changes). This ensures the quality gate fixes did not break any acceptance
criteria.

Reuse the `MODEL` value resolved in Step 3. No need to call `resolve-model` again.

For phases with multiple tasks, spawn a **forge-verifier** agent (with `model` if non-empty)
to handle parallel re-verification. For single-task phases, verify inline.

Record re-verification results as comments:
```bash
bd comments add <task-id> "Re-verification (post quality gate): <PASS|FAIL> - <details>"
```

**Re-run UAT for newly failed tasks:**

Compare the re-verification results with the original Step 3 results. For any task that
**passed** in Step 3 but **failed** in re-verification (regression introduced by quality
gate fixes), re-run UAT (Step 4 logic) for those tasks only.

If no tasks newly failed, skip UAT re-run.

**Apply hard gate on re-verification failures:**

If any tasks fail re-verification, apply the same hard gate from Step 5:
- Do NOT close those tasks or the phase (unless `--force` was passed)
- Output the blocking message from Step 5 with the re-verification failures
- Suggest fixing the quality gate regressions and re-running `/forge:verify <phase>`

If all tasks pass re-verification, proceed to Step 8.

## 8. Capture Phase Retrospective

This step runs only when the phase is being closed (all tasks verified or --force override).
Skip this step if closure was blocked (no --force and tasks failed).

**Derive counts from phase context:**
- `task_count` = total number of tasks in `tasks_to_verify` + `tasks_still_open`
- `blocker_count` = number of tasks whose notes contain "BLOCKED"
- `forced` = true if --force was passed, false otherwise

**Ask for approach effectiveness rating:**

Use AskUserQuestion:
- Question: "How effective was the overall approach for this phase? Rate 1-5."
- Options: "1 - Poor" / "2 - Below average" / "3 - Average" / "4 - Good" / "5 - Excellent"

Store the numeric rating (1-5) as `approach_effectiveness`.

**Ask for key lessons:**

Use AskUserQuestion:
- Question: "Any key lessons learned from this phase? (Enter a short sentence, or leave blank to skip)"
- Options: free text input or "Skip"

If the user provides a lesson, store it as a single-element array: `["<lesson>"]`.
If the user skips, store an empty array: `[]`.

**Build the context-write payload using recognized schema fields:**

The context-write command only persists these fields: `agent`, `task`, `status`, `findings`,
`decisions`, `blockers`, `artifacts`, `next_steps`. All other fields are silently dropped.
Map the retrospective data as follows:

- **findings** array: Include the approach effectiveness rating as a structured string
  (`"Approach effectiveness: <N>/5"`), the task count (`"Task count: <N>"`), and each
  key lesson as a separate string entry.
- **decisions** array: If `--force` was used, include `"Phase closed with --force override"`.
  Otherwise leave empty.
- **blockers** array: If `blocker_count` > 0, include one entry per blocked task
  (`"BLOCKED: <task-title> (<task-id>)"`). Otherwise leave empty.

**Write the retrospective entry:**

```bash
node "$HOME/.claude/forge/bin/forge-tools.cjs" context-write <phase-id> \
  '{"agent":"forge-verifier","status":"completed","findings":["Approach effectiveness: <N>/5","Task count: <N>","<lesson1>"],"decisions":["<if forced>"],"blockers":["<if any>"]}'
```

Replace placeholders with actual derived values before running.

Example with real values:
```bash
node "$HOME/.claude/forge/bin/forge-tools.cjs" context-write phase-abc123 \
  '{"agent":"forge-verifier","status":"completed","findings":["Approach effectiveness: 4/5","Task count: 5","Parallel agents reduced wall time significantly"],"decisions":[],"blockers":["BLOCKED: Fix auth flow (task-xyz)"]}'
```

## 9. Requirement Coverage Check

> **Note:** Reuse the project context fetched in Step 1 rather than re-invoking
> `project-context`. The phase and project data are unchanged within this workflow run.

Identify the parent milestone for this phase using the project context from Step 1.

Look up the phase's parent bead in the context. If no parent milestone exists, skip this step silently.

If a milestone is found, fetch its forge:req beads:
```bash
bd dep list <milestone-id> --type contains --json
# Filter results to beads with type forge:req
```

For each forge:req bead found, check whether any task in the current phase has a `validates` link to it:
```bash
bd dep list <req-id> --type validates --json
# Check if any of the validating task IDs belong to this phase's task list
```

> **Performance note:** The per-requirement `bd dep list` calls above produce O(M) subprocess
> invocations where M is the number of requirements. If the bd CLI gains a batch query mode
> in the future, prefer that to reduce overhead.

Build the coverage map:
- **Covered**: at least one task in this phase has a `validates` link to the req
- **Uncovered**: no task in this phase validates the req (may be covered by another phase)

If any reqs are uncovered, show a warning (not a hard failure):
```
------------------------------------------------------------
 WARNING: Uncovered Requirements in Parent Milestone
------------------------------------------------------------

The following milestone requirements have no validates link
from tasks in this phase. They may be covered by other phases,
or they may need attention.

  - <req-title> (<req-id>)
  - <req-title> (<req-id>)

To add coverage: bd dep add <task-id> <req-id> --type validates
Or run /forge:audit-milestone to check full milestone coverage.
------------------------------------------------------------
```

If all reqs are covered by this phase's tasks, or if no milestone/reqs exist, show nothing.

**Auto-close satisfied requirements:**

After the coverage check, iterate over ALL forge:req beads under the milestone (not just those
covered by this phase). For each open requirement:

```bash
bd dep list <req-id> --type validates --json
```

If the requirement has at least one `validates` link AND every validating task has `status == "closed"`,
close the requirement automatically:

```bash
bd close <req-id> --reason="All validating tasks completed"
```

If any requirements were auto-closed, report them:
```
Auto-closed satisfied requirements:
  - <req-title> (<req-id>)
```

Skip requirements that have no `validates` links (they can't be verified as satisfied).

## 10. Push Branch and Create Pull Request

After the phase is closed (all tasks verified) and requirement coverage is checked, push
the phase branch and open a PR for user review. Forge NEVER merges — the user reviews,
approves, and merges the PR themselves.

First, determine the current branch name (should be `forge/m<milestone-id>/phase-<phase-id>`
or `forge/phase-<phase-id>` if no milestone):
```bash
BRANCH=$(git branch --show-current)
```

Push the branch to origin:
```bash
node "$HOME/.claude/forge/bin/forge-tools.cjs" branch-push "$BRANCH"
```

If the branch push fails because no commits exist on it (nothing was changed), skip PR
creation and note this to the user.

Create the pull request with a rich description:
```bash
node "$HOME/.claude/forge/bin/forge-tools.cjs" pr-create <phase-id>
```

This creates a PR against the default base branch. The PR description is auto-generated
with the phase goal, task details, and requirement coverage. The user will review, approve,
and merge the PR at their discretion.

If the PR already exists (re-run scenario), `pr-create` will report the existing PR URL
gracefully without creating a duplicate.

Display the PR URL to the user and remind them:
> The PR is ready for your review. Forge does not merge — please review, approve, and merge
> when satisfied. Run `/forge:plan <next-phase>` to continue planning while the PR is open.

Suggest next step: `/forge:plan <next-phase>` or `/forge:progress`.

</process>
</output>
