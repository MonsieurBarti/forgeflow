<purpose>
Execute small, ad-hoc tasks with Forge guarantees (atomic commits, bead-backed state tracking).
Creates a quick task bead under the project, spawns forge-planner (quick mode) + forge-executor(s),
and skips research and roadmap ceremony.

Flags: `--discuss` (lightweight discussion before planning), `--full` (plan-checking + verification).
Composable: `--discuss --full` gives both.
</purpose>

<process>

**Step 1: Parse arguments and get task description**

Parse `$ARGUMENTS` for:
- `--full` flag -> `$FULL_MODE` (true/false)
- `--discuss` flag -> `$DISCUSS_MODE` (true/false)
- Remaining text -> `$DESCRIPTION`

If `$DESCRIPTION` is empty, prompt:
```
AskUserQuestion(header: "Quick Task", question: "What do you want to do?", followUp: null)
```

Display banner based on active flags:
- Both: `FORGE > QUICK TASK (DISCUSS + FULL)` -- Plan checking + verification + discussion enabled
- Discuss only: `FORGE > QUICK TASK (DISCUSS)` -- Discussion phase enabled
- Full only: `FORGE > QUICK TASK (FULL MODE)` -- Plan checking + verification enabled
- Default: `FORGE > QUICK TASK`

---

**Step 2: Initialize and create quick task bead**

```bash
INIT=$(node "$HOME/.claude/forge/bin/forge-tools.cjs" init-quick "$DESCRIPTION")
```

Parse JSON for: `found`, `project_id`, `models` (planner, executor, plan_checker, verifier), `settings`.

If `found` is false, error: "No Forge project found. Run `/forge:new` first."

Store model values: `$PLANNER_MODEL`, `$EXECUTOR_MODEL`, `$CHECKER_MODEL`, `$VERIFIER_MODEL` (all may be null).

```bash
QUICK_BEAD=$(bd create --title="Quick: ${DESCRIPTION}" \
  --description="${DESCRIPTION}" \
  --type=task --priority=2 --json)
```

Extract `$QUICK_ID`, wire to project:
```bash
bd dep add $QUICK_ID $PROJECT_ID --type=parent-child
bd label add $QUICK_ID forge:quick
bd update $QUICK_ID --status=in_progress
```

Create branch:
```bash
node "$HOME/.claude/forge/bin/forge-tools.cjs" quick-branch-create $QUICK_ID
```

If branch creation fails, warn but continue. Report: `Created quick task: ${QUICK_ID} -- ${DESCRIPTION}`

---

**Step 3: Discussion phase (only when `$DISCUSS_MODE`)**

Skip entirely if NOT `$DISCUSS_MODE`.

**3a.** Analyze `$DESCRIPTION` to identify 2-4 gray areas using domain-aware heuristics:
- SEE -> layout, density, interactions, states
- CALL -> responses, errors, auth, versioning
- RUN -> output format, flags, modes, error handling
- READ -> structure, tone, depth, flow
- ORGANIZED -> criteria, grouping, naming, exceptions

**3b.** Present via AskUserQuestion (multiSelect: true):
- header: "Gray Areas"
- options: identified areas + "All clear" (skip discussion)

**3c.** For each selected area, ask 1-2 focused questions with concrete options. Max 2 questions per area. Collect into `$DECISIONS`.

**3d.** Save:
```bash
bd update $QUICK_ID --notes="Decisions: ${DECISIONS}"
```

---

**Step 4: Spawn planner (quick mode)**

```bash
CONTEXT=$(node "$HOME/.claude/forge/bin/forge-tools.cjs" project-context-slim $PROJECT_ID)
```

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
  bd create --title='<title>' --description='<what to do>' --acceptance='<done when>' --type=task --priority=2 --json
  bd dep add <task-id> ${QUICK_ID} --type=parent-child
  bd label add <task-id> forge:task
")
```

Verify tasks created:
```bash
bd children $QUICK_ID --json
```

If no children, error: "Planner failed to create tasks for ${QUICK_ID}"

---

**Step 5: Plan-checker loop (only when `$FULL_MODE`)**

Skip entirely if NOT `$FULL_MODE`.

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

Scope: Quick task, not full phase. Skip roadmap checks.
${DISCUSS_MODE ? 'Context compliance: Does the plan honor locked decisions from bead notes?' : ''}

Produce a PASS or NEEDS REVISION verdict.
")
```

- **PASS:** proceed to step 6.
- **NEEDS REVISION:** revision loop (max 2 iterations). Re-spawn planner with issues, re-run checker. After 2 iterations, offer: 1) Force proceed, 2) Abort.

---

**Step 6: Spawn executor**

```bash
TASKS=$(bd children $QUICK_ID --json)
```

**Multiple independent tasks** -- spawn forge-executor agents in **parallel**:

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
   Format: feat(quick-${QUICK_ID}): <summary> [task <task-id>]
   Use git add <specific files> -- never git add . or git add -A
   NEVER run git merge or gh pr merge
5. Close the task: bd close <task-id> --reason='<brief summary>'

If blocked: bd update <task-id> --notes='BLOCKED: <description>' -- do NOT close.
")
```

**Single task** -- execute directly (saves context overhead).

After completion, verify all tasks closed via `bd children $QUICK_ID --json`.

---

**Step 7: Verification (only when `$FULL_MODE`)**

Skip entirely if NOT `$FULL_MODE`.

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

| Status | Action |
|--------|--------|
| PASSED | Continue to step 8 |
| NEEDS_REVIEW | Display items needing manual check, continue |
| GAPS_FOUND | Display gaps, offer: 1) Re-run executor, 2) Accept as-is |

---

**Step 7.5: Quality gate, push branch, and create PR**

Runs after verification (or execution if not `$FULL_MODE`). Skip if tasks remain open/blocked.

```bash
SETTINGS=$(node "$HOME/.claude/forge/bin/forge-tools.cjs" settings-load)
```

- If `quality_gate` is `false`: skip to push/PR.
- If `true`: scope changed files and run quality-gate workflow:

```bash
CHANGED_FILES=$(git diff main...HEAD --name-only)
```

If files changed, follow `@~/.claude/forge/workflows/quality-gate.md`. If user approves fixes, commit before proceeding.

**Push and PR:**
```bash
BRANCH=$(git branch --show-current)
node "$HOME/.claude/forge/bin/forge-tools.cjs" branch-push $BRANCH
PR_RESULT=$(node "$HOME/.claude/forge/bin/forge-tools.cjs" quick-pr-create $QUICK_ID)
```

Best-effort: if PR creation fails, warn and continue.

---

**Step 8: Close quick task and report**

```bash
bd close $QUICK_ID --reason="Quick task completed: ${DESCRIPTION}"
COMMIT=$(git rev-parse --short HEAD)
```

Display:
```
FORGE > QUICK TASK COMPLETE ${FULL_MODE ? '(FULL MODE)' : ''}

Quick Task: ${QUICK_ID} -- ${DESCRIPTION}
${FULL_MODE ? 'Verification: ${VERIFICATION_STATUS}' : ''}
Commit: ${COMMIT}
${PR_URL ? 'PR: ${PR_URL}' : ''}

Ready for next task: /forge:quick
```

</process>

<success_criteria>
- [ ] Project exists (find-project returns a project bead)
- [ ] User provides task description (or prompted interactively)
- [ ] `--full` and `--discuss` flags parsed when present
- [ ] Quick task bead created with `forge:quick` label and parent-child dep
- [ ] Branch forge/quick-<id> created after bead creation
- [ ] (--discuss) Gray areas identified, decisions captured in bead notes
- [ ] 1-3 task beads created with forge:task label, parent-child to quick bead
- [ ] (--full) Plan checker validates plan, revision loop capped at 2
- [ ] All tasks executed with atomic commits using feat(quick-<id>): format
- [ ] Executor verifies branch before committing, uses git add <specific files>
- [ ] (--full) Verification run and status recorded
- [ ] Quality gate runs when setting is true, skipped when false
- [ ] Branch pushed and PR created (best-effort)
- [ ] Quick task bead closed with completion reason
</success_criteria>
</output>
