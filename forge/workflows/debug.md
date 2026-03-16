<purpose>
Orchestrator workflow for systematic debugging with bead-backed state.
Gathers symptoms, spawns forge-debugger agent, handles checkpoints and continuations.
Debug sessions are tracked as beads with the `forge:debug` label.
</purpose>

<process>

<step name="parse_arguments">
Parse `$ARGUMENTS` for the issue description. If empty, will check for active sessions.

Store result as `$DESCRIPTION` (may be empty).
</step>

<step name="check_active_sessions">
Check for active debug sessions:

```bash
node "$HOME/.claude/forge/bin/forge-tools.cjs" debug-list
```

Parse JSON result for `sessions` array.

**If active sessions exist AND `$DESCRIPTION` is empty:**
- Display sessions with ID, title, status, current hypothesis (from notes)
- Use AskUserQuestion: "Resume a session or describe a new issue?"
- Options: one per active session + "New issue"
- If user picks a session -> set `$DEBUG_ID` to that session's ID, go to `spawn_continuation`
- If user picks "New issue" -> prompt for description via AskUserQuestion

**If `$DESCRIPTION` provided OR no active sessions:**
- Continue to `gather_symptoms`
</step>

<step name="gather_symptoms">
Use AskUserQuestion for each symptom (skip any the user already provided in `$DESCRIPTION`):

1. **Expected behavior** - What should happen?
2. **Actual behavior** - What happens instead?
3. **Error messages** - Any errors? (paste or describe)
4. **Timeline** - When did this start? Ever worked?
5. **Reproduction** - How do you trigger it?

After all gathered, confirm ready to investigate.
</step>

<step name="create_debug_bead">
Create a debug session bead:

```bash
SLUG=$(echo "$DESCRIPTION" | tr '[:upper:]' '[:lower:]' | sed 's/[^a-z0-9]/-/g' | sed 's/--*/-/g' | cut -c1-30)
```

```bash
node "$HOME/.claude/forge/bin/forge-tools.cjs" debug-create "$SLUG" \
  "trigger: ${DESCRIPTION}
expected: ${EXPECTED}
actual: ${ACTUAL}
errors: ${ERRORS}
reproduction: ${REPRODUCTION}
timeline: ${TIMELINE}"
```

Parse the JSON response for `debug_id`. Store as `$DEBUG_ID`.

Resolve debugger model:
```bash
DEBUGGER_MODEL=$(node "$HOME/.claude/forge/bin/forge-tools.cjs" model-for-role debugger)
```

Report: `Debug session created: ${DEBUG_ID} -- ${SLUG}`

Detect active milestone (determines worktree base and PR target):
```bash
MILESTONE_ID=$(bd memories forge:session:last-milestone 2>/dev/null || echo "")
```

- If `$MILESTONE_ID` is non-empty, check that the bead has the `forge:milestone` label to confirm it is valid.
- Set `$BASE_BRANCH`:
  - With milestone: `forge/milestone-${MILESTONE_ID}`
  - Without milestone: `main`

Create worktree for git isolation:
```bash
# With milestone:
node "$HOME/.claude/forge/bin/forge-tools.cjs" worktree-create-task $DEBUG_ID --prefix=debug --base=forge/milestone-${MILESTONE_ID}

# Without milestone:
node "$HOME/.claude/forge/bin/forge-tools.cjs" worktree-create-task $DEBUG_ID --prefix=debug --base=main
```

Parse the JSON result for `path` (the worktree directory) and `branch`. Store `$WORKTREE_PATH` and `$DEBUG_BRANCH`.

If worktree creation fails, warn but continue (fall back to current working directory).

All subsequent debugger work happens inside `$WORKTREE_PATH`.
</step>

<step name="spawn_debugger">
Display banner:
```
------------------------------------------------------
 FORGE > DEBUGGING: ${SLUG}
------------------------------------------------------

Spawning debugger agent...
```

Spawn forge-debugger with filled prompt (pass `model` if `$DEBUGGER_MODEL` is non-null):

```
Agent(subagent_type="forge-debugger", model="<$DEBUGGER_MODEL or omit if null>", prompt="
<objective>
Investigate issue: ${SLUG}

**Summary:** ${DESCRIPTION}
**Debug bead:** ${DEBUG_ID}
</objective>

<symptoms>
expected: ${EXPECTED}
actual: ${ACTUAL}
errors: ${ERRORS}
reproduction: ${REPRODUCTION}
timeline: ${TIMELINE}
</symptoms>

<git_isolation>
Working directory: ${WORKTREE_PATH}
Branch: ${DEBUG_BRANCH}

IMPORTANT: All file reads, edits, and commands must use the worktree directory: ${WORKTREE_PATH}.
Before committing any changes, verify you are on the ${DEBUG_BRANCH} branch by running:
  git -C ${WORKTREE_PATH} branch --show-current
If you are NOT on ${DEBUG_BRANCH}, do NOT commit. Report as a blocker.
Use git add <specific files> -- never git add . or git add -A.
NEVER run git merge or gh pr merge.
</git_isolation>

<mode>
symptoms_prefilled: true
goal: find_and_fix
</mode>
")
```
</step>

<step name="handle_return">
Parse the agent's structured return:

**If `## ROOT CAUSE FOUND`:**
- Display root cause and evidence summary
- Use AskUserQuestion:
  - "Fix now" -> spawn fix executor (or re-spawn debugger with `goal: find_and_fix`)
  - "Plan fix" -> suggest `/forge:plan` or `/forge:quick`
  - "Manual fix" -> done

**If `## DEBUG COMPLETE`:**
- Display completion summary (root cause, fix, verification, commit)
- Push branch and create PR:

```bash
node "$HOME/.claude/forge/bin/forge-tools.cjs" branch-push ${DEBUG_BRANCH}
PR_RESULT=$(node "$HOME/.claude/forge/bin/forge-tools.cjs" quick-pr-create $DEBUG_ID --base=${BASE_BRANCH})
```

The `--base` flag targets the PR at the milestone branch (or `main` if no milestone).
Best-effort: if PR creation fails, warn and continue.

- Report session closed, display PR URL if available

**If `## CHECKPOINT REACHED`:**
- Present checkpoint details to user
- Get user response via AskUserQuestion
- If checkpoint type is `human-verify`:
  - If user confirms fixed: spawn continuation so agent can finalize/close
  - If user reports issues: spawn continuation so agent returns to investigation
- Go to `spawn_continuation`

**If `## INVESTIGATION INCONCLUSIVE`:**
- Show what was checked and eliminated
- Use AskUserQuestion:
  - "Continue investigating" -> spawn new debugger with additional context
  - "Manual investigation" -> done
  - "Add more context" -> gather more symptoms, update bead, spawn again
</step>

<step name="spawn_continuation">
When resuming or continuing after checkpoint, spawn fresh debugger:

```
Agent(subagent_type="forge-debugger", model="<$DEBUGGER_MODEL or omit if null>", prompt="
<objective>
Continue debugging: ${SLUG}
**Debug bead:** ${DEBUG_ID}
</objective>

<prior_state>
Load state from bead: bd show ${DEBUG_ID} --json
</prior_state>

<checkpoint_response>
**Type:** ${CHECKPOINT_TYPE}
**Response:** ${USER_RESPONSE}
</checkpoint_response>

<git_isolation>
Working directory: ${WORKTREE_PATH}
Branch: ${DEBUG_BRANCH}

IMPORTANT: All file reads, edits, and commands must use the worktree directory: ${WORKTREE_PATH}.
Before committing any changes, verify you are on the ${DEBUG_BRANCH} branch by running:
  git -C ${WORKTREE_PATH} branch --show-current
If you are NOT on ${DEBUG_BRANCH}, do NOT commit. Report as a blocker.
Use git add <specific files> -- never git add . or git add -A.
NEVER run git merge or gh pr merge.
</git_isolation>

<mode>
goal: find_and_fix
</mode>
")
```

After agent returns, go back to `handle_return`.
</step>

</process>

<success_criteria>
- [ ] Active sessions checked via debug-list
- [ ] Symptoms gathered (if new issue)
- [ ] Debug session bead created with forge:debug label
- [ ] Milestone detected via `bd memories forge:session:last-milestone` (or fallback to main)
- [ ] Branch created and worktree set up via `worktree-create-task` with --prefix=debug and correct --base
- [ ] forge-debugger spawned with bead ID, symptoms, and worktree/branch context
- [ ] Debugger verifies it is on forge/debug-<debug-id> branch before committing
- [ ] Checkpoints presented to user and responses relayed
- [ ] Continuation agents spawned with prior state from bead and git isolation context
- [ ] Root cause confirmed before fixing
- [ ] PR created on debug completion via `quick-pr-create` targeting milestone branch (or main)
</success_criteria>
