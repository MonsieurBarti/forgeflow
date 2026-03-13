<purpose>
Execute small, ad-hoc tasks with Forge guarantees (atomic commits, bead-backed state tracking).
Quick mode creates a quick task bead under the project, spawns forge-planner (quick mode) +
forge-executor(s), and skips research and roadmap ceremony.

With `--discuss` flag: lightweight discussion phase before planning. Surfaces assumptions,
clarifies gray areas, captures decisions in the task bead so the planner treats them as locked.

With `--full` flag: enables plan-checking (max 2 iterations) and post-execution verification.

Flags are composable: `--discuss --full` gives discussion + plan-checking + verification.
</purpose>

<process>

**Step 1: Parse arguments and get task description**

Parse `$ARGUMENTS` for:
- `--full` flag -> store as `$FULL_MODE` (true/false)
- `--discuss` flag -> store as `$DISCUSS_MODE` (true/false)
- Remaining text -> use as `$DESCRIPTION` if non-empty

If `$DESCRIPTION` is empty after parsing, prompt user interactively:

```
AskUserQuestion(
  header: "Quick Task",
  question: "What do you want to do?",
  followUp: null
)
```

Store response as `$DESCRIPTION`.

Display banner based on active flags:

If `$DISCUSS_MODE` and `$FULL_MODE`:
```
------------------------------------------------------
 FORGE > QUICK TASK (DISCUSS + FULL)
------------------------------------------------------

Plan checking + verification + discussion enabled
```

If `$DISCUSS_MODE` only:
```
------------------------------------------------------
 FORGE > QUICK TASK (DISCUSS)
------------------------------------------------------

Discussion phase enabled -- surfacing gray areas before planning
```

If `$FULL_MODE` only:
```
------------------------------------------------------
 FORGE > QUICK TASK (FULL MODE)
------------------------------------------------------

Plan checking + verification enabled
```

Default (no flags):
```
------------------------------------------------------
 FORGE > QUICK TASK
------------------------------------------------------
```

---

**Step 2: Initialize and create quick task bead**

```bash
INIT=$(node "$HOME/.claude/forge/bin/forge-tools.cjs" init-quick "$DESCRIPTION")
```

Parse the JSON for: `found`, `project_id`, `models` (planner, executor, plan_checker, verifier),
`settings` (auto_commit, plan_check, parallel_execution, etc.).

If `found` is false, error: "No Forge project found. Run `/forge:new` first."

Store model values for later agent spawns:
- `$PLANNER_MODEL` = `models.planner.model` (may be null)
- `$EXECUTOR_MODEL` = `models.executor.model` (may be null)
- `$CHECKER_MODEL` = `models.plan_checker.model` (may be null)
- `$VERIFIER_MODEL` = `models.verifier.model` (may be null)

Create the quick task bead:
```bash
QUICK_BEAD=$(bd create --title="Quick: ${DESCRIPTION}" \
  --description="${DESCRIPTION}" \
  --type=task --priority=2 --json)
```

Extract `$QUICK_ID` from the JSON response.

Wire it to the project and label it:
```bash
bd dep add $QUICK_ID $PROJECT_ID --type=parent-child
bd label add $QUICK_ID forge:quick
bd update $QUICK_ID --status=in_progress
```

**Create branch for the quick task:**
```bash
node "$HOME/.claude/forge/bin/forge-tools.cjs" quick-branch-create $QUICK_ID
```

Verify the branch was created/checked out. If branch creation fails, warn but continue
(the task can still work on the current branch).

Report: `Created quick task: ${QUICK_ID} -- ${DESCRIPTION}`

---

**Step 3: Discussion phase (only when `$DISCUSS_MODE`)**

Skip this step entirely if NOT `$DISCUSS_MODE`.

Display:
```
------------------------------------------------------
 FORGE > DISCUSSING QUICK TASK
------------------------------------------------------

Surfacing gray areas for: ${DESCRIPTION}
```

**3a. Identify gray areas**

Analyze `$DESCRIPTION` to identify 2-4 gray areas -- implementation decisions that
would change the outcome and that the user should weigh in on.

Use domain-aware heuristics:
- Something users **SEE** -> layout, density, interactions, states
- Something users **CALL** -> responses, errors, auth, versioning
- Something users **RUN** -> output format, flags, modes, error handling
- Something users **READ** -> structure, tone, depth, flow
- Something being **ORGANIZED** -> criteria, grouping, naming, exceptions

Each gray area should be a concrete decision point, not a vague category.

**3b. Present gray areas**

```
AskUserQuestion(
  header: "Gray Areas",
  question: "Which areas need clarification before planning?",
  options: [
    { label: "${area_1}", description: "${why_it_matters_1}" },
    { label: "${area_2}", description: "${why_it_matters_2}" },
    { label: "${area_3}", description: "${why_it_matters_3}" },
    { label: "All clear", description: "Skip discussion -- I know what I want" }
  ],
  multiSelect: true
)
```

If user selects "All clear" -> skip to Step 4.

**3c. Discuss selected areas**

For each selected area, ask 1-2 focused questions via AskUserQuestion with
concrete options. Max 2 questions per area.

Collect all decisions into `$DECISIONS`.

**3d. Save decisions to bead**

```bash
bd update $QUICK_ID --notes="Decisions: ${DECISIONS}"
```

Report: `Context captured on bead ${QUICK_ID}`

---

**Step 4: Spawn planner (quick mode)**

Read project context:
```bash
CONTEXT=$(node "$HOME/.claude/forge/bin/forge-tools.cjs" project-context $PROJECT_ID)
```

Spawn forge-planner with quick mode constraints (pass `model` if `$PLANNER_MODEL` is non-null):

```
Agent(subagent_type="forge-planner", model="<$PLANNER_MODEL or omit if null>", prompt="
Create 1-3 focused tasks for this quick task:

Quick Task: ${DESCRIPTION}
Quick Task Bead: ${QUICK_ID}
Project Context: ${CONTEXT}
${DISCUSS_MODE ? 'User Decisions (locked -- do not revisit): ${DECISIONS}' : ''}

Instructions:
1. Read the project's CLAUDE.md for codebase conventions
2. Create 1-3 task beads (keep scope tight)
3. Wire each task as child of ${QUICK_ID}
4. Label each task forge:task
5. Add inter-task dependencies if needed

Constraints:
- No research phase -- go straight to task breakdown
- Tasks should be atomic and self-contained
- Each task needs clear acceptance_criteria
${FULL_MODE ? '- Each task MUST have specific, testable acceptance criteria' : ''}

For each task:
  bd create --title='<title>' --description='<what to do>' --acceptance_criteria='<done when>' --type=task --priority=2 --json
  bd dep add <task-id> ${QUICK_ID} --type=parent-child
  bd label add <task-id> forge:task
")
```

After planner returns, verify tasks were created:
```bash
bd children $QUICK_ID --json
```

If no children found, error: "Planner failed to create tasks for ${QUICK_ID}"

Report: "Plan created: N tasks under ${QUICK_ID}"

---

**Step 5: Plan-checker loop (only when `$FULL_MODE`)**

Skip this step entirely if NOT `$FULL_MODE`.

Display:
```
------------------------------------------------------
 FORGE > CHECKING PLAN
------------------------------------------------------

Spawning plan checker...
```

Spawn forge-plan-checker (pass `model` if `$CHECKER_MODEL` is non-null):

```
Agent(subagent_type="forge-plan-checker", model="<$CHECKER_MODEL or omit if null>", prompt="
Verify the plan for this quick task:

Quick Task Bead: ${QUICK_ID}
Task Description: ${DESCRIPTION}

Check:
1. Every task has specific, testable acceptance criteria
2. Tasks are appropriately sized (1-3 tasks for a quick task)
3. Dependencies are correct (no cycles)
4. All tasks have forge:task label

Run: bd children ${QUICK_ID} --json

Scope: This is a quick task, not a full phase. Skip checks that require a roadmap.
${DISCUSS_MODE ? 'Context compliance: Does the plan honor locked decisions from the bead notes?' : ''}

Produce a PASS or NEEDS REVISION verdict.
")
```

**Handle checker return:**

- **PASS:** Display confirmation, proceed to step 6.
- **NEEDS REVISION:** Display issues, enter revision loop (max 2 iterations).

**Revision loop:**

If iteration_count < 2:
- Re-spawn planner with checker issues for targeted fixes
- Re-run checker
- Increment iteration_count

If iteration_count >= 2:
- Display remaining issues
- Offer: 1) Force proceed, 2) Abort

---

**Step 6: Spawn executor**

Get the task list:
```bash
TASKS=$(bd children $QUICK_ID --json)
```

**Multiple tasks** -- detect waves and execute:
```bash
# Tasks under a quick bead are typically all independent (wave 1)
# But check for inter-task deps
```

For tasks in each wave:

**Multiple independent tasks** -- spawn forge-executor agents in **parallel** (pass `model` if `$EXECUTOR_MODEL` is non-null):

```
Agent(subagent_type="forge-executor", model="<$EXECUTOR_MODEL or omit if null>", prompt="
Execute this task:

Task: <task title> (<task-id>)
Description: <task description>
Acceptance Criteria: <acceptance_criteria>
Quick Task Context: ${DESCRIPTION}

Instructions:
1. Claim the task: bd update <task-id> --status=in_progress
2. Implement the task following the description and acceptance criteria
3. Run relevant tests to verify acceptance criteria are met
4. Verify you are on the forge/quick-${QUICK_ID} branch before committing.
   Create an atomic git commit with a standardized message:
   Format: feat(quick-${QUICK_ID}): <summary> [task <task-id>]
   Use git add <specific files> -- never git add . or git add -A
   NEVER run git merge or gh pr merge -- merging is always left to the user
5. Close the task: bd close <task-id> --reason='<brief summary>'

If you encounter a blocker:
- bd update <task-id> --notes='BLOCKED: <description>'
- Do NOT close the task
- Report the blocker in your response
")
```

**Single task** -- execute directly without spawning an agent (saves context overhead).

After all tasks complete, verify:
```bash
bd children $QUICK_ID --json
```

Check all tasks are closed. If any remain open or blocked, report status.

---

**Step 7: Verification (only when `$FULL_MODE`)**

Skip this step entirely if NOT `$FULL_MODE`.

Display:
```
------------------------------------------------------
 FORGE > VERIFYING RESULTS
------------------------------------------------------

Spawning verifier...
```

```
Agent(subagent_type="forge-verifier", model="<$VERIFIER_MODEL or omit if null>", prompt="
Verify quick task goal achievement.

Quick Task Bead: ${QUICK_ID}
Goal: ${DESCRIPTION}

Check:
1. Read each child task's acceptance criteria
2. Verify criteria are met in the actual codebase
3. Run relevant tests if applicable

Update quick task bead with verification status:
bd update ${QUICK_ID} --notes='Verification: <PASSED|GAPS_FOUND|NEEDS_REVIEW> -- <details>'
")
```

Read verification status from bead notes.

| Status | Action |
|--------|--------|
| PASSED | Store status, continue to step 8 |
| NEEDS_REVIEW | Display items needing manual check, continue |
| GAPS_FOUND | Display gaps, offer: 1) Re-run executor to fix, 2) Accept as-is |

---

**Step 7.5: Quality gate, push branch, and create PR**

This step runs after verification (or after execution if `$FULL_MODE` is false).
Skip this step if any tasks remain open or blocked.

**Check the quality_gate setting:**

```bash
SETTINGS=$(node "$HOME/.claude/forge/bin/forge-tools.cjs" settings-load)
```

Parse the result and read the `quality_gate` value.

- If `quality_gate` is `false`, skip the quality gate silently — proceed to push/PR.
- If `quality_gate` is `true` (or not explicitly set to false), run the quality gate pipeline:

**Scope changed files:**
```bash
CHANGED_FILES=$(git diff main...HEAD --name-only)
```

If no files were changed, skip the quality gate silently.

If files were changed, follow the quality-gate workflow defined in
`@~/.claude/forge/workflows/quality-gate.md`, passing the list of changed files as scope.
If the user approves fixes and changes are applied, commit them before proceeding.

**Push branch and create PR:**

```bash
BRANCH=$(git branch --show-current)
node "$HOME/.claude/forge/bin/forge-tools.cjs" branch-push $BRANCH
```

```bash
PR_RESULT=$(node "$HOME/.claude/forge/bin/forge-tools.cjs" quick-pr-create $QUICK_ID)
```

Parse `PR_RESULT` JSON. If `url` is present, store as `$PR_URL` and display to user.
Best-effort: if PR creation fails (no `url`, or `error` field present), warn and continue
to close. The code is on the branch either way.

---

**Step 8: Close quick task and report**

Close the quick task bead:
```bash
bd close $QUICK_ID --reason="Quick task completed: ${DESCRIPTION}"
```

Get the latest commit hash:
```bash
COMMIT=$(git rev-parse --short HEAD)
```

Display completion:

**If `$FULL_MODE`:**
```
---

FORGE > QUICK TASK COMPLETE (FULL MODE)

Quick Task: ${QUICK_ID} -- ${DESCRIPTION}
Verification: ${VERIFICATION_STATUS}
Commit: ${COMMIT}
${PR_URL ? 'PR: ${PR_URL}' : ''}

---

Ready for next task: /forge:quick
```

**If NOT `$FULL_MODE`:**
```
---

FORGE > QUICK TASK COMPLETE

Quick Task: ${QUICK_ID} -- ${DESCRIPTION}
Commit: ${COMMIT}
${PR_URL ? 'PR: ${PR_URL}' : ''}

---

Ready for next task: /forge:quick
```

</process>

<success_criteria>
- [ ] Project exists (find-project returns a project bead)
- [ ] User provides task description (or prompted interactively)
- [ ] `--full` and `--discuss` flags parsed from arguments when present
- [ ] Quick task bead created with `forge:quick` label and parent-child dep to project
- [ ] Branch forge/quick-<id> created after bead creation
- [ ] (--discuss) Gray areas identified and presented, decisions captured in bead notes
- [ ] 1-3 task beads created by planner with forge:task label, parent-child to quick bead
- [ ] (--full) Plan checker validates plan, revision loop capped at 2
- [ ] All tasks executed with atomic commits using feat(quick-<id>): format
- [ ] Executor verifies branch before committing, uses git add <specific files>
- [ ] (--full) Verification run and status recorded
- [ ] Quality gate runs when quality_gate setting is true, skipped when false
- [ ] Branch pushed and PR created (best-effort — warn on failure, do not block close)
- [ ] PR URL displayed in completion report when available
- [ ] Quick task bead closed with completion reason
</success_criteria>
