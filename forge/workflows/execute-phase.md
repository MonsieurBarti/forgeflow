<purpose>
Execute all planned tasks in a phase. Detect dependency waves and run independent tasks
in parallel via subagents. Each task gets an atomic git commit on completion.
</purpose>

<process>

## 1. Resolve Phase

If a phase number was given (e.g., "7"), resolve it with an **exact** numeric match so that
phase 7 never accidentally matches phase 17:
```bash
PROJECT=$(node "$HOME/.claude/forge/bin/forge-tools.cjs" find-project)
PHASE=$(node "$HOME/.claude/forge/bin/forge-tools.cjs" resolve-phase <project-id> <phase-number>)
```
Parse `phase.id` from the result. If `found` is false, report available phases and stop.

If a phase ID was given directly, use it.

If nothing was given, auto-detect by finding the current `in_progress` phase.

```bash
CONTEXT=$(node "$HOME/.claude/forge/bin/forge-tools.cjs" phase-context <phase-id>)
```

Verify phase is `in_progress` (has been planned). If not planned, suggest `/forge:plan` first.

## 1.5. Snapshot Starting Cost

Record cost baseline at phase start for token/cost tracking:

```bash
node "$HOME/.claude/forge/bin/forge-tools.cjs" cost-snapshot <phase-id> start
```

This is best-effort — if it fails, continue execution.

## 2. Switch to Phase Branch

Ensure commits land on the correct phase branch, not main. Use `branch-create` which is
idempotent — it creates the branch if missing or checks out the existing one:

```bash
node "$HOME/.claude/forge/bin/forge-tools.cjs" branch-create <phase-id>
```

Verify you are now on the phase branch:
```bash
CURRENT_BRANCH=$(git branch --show-current)
```

If the branch name does not contain the phase ID, **stop and report the issue**.
Do NOT proceed with execution on the wrong branch.

## 3. Load Checkpoint

Check for an existing checkpoint from a previous interrupted session:

```bash
CHECKPOINT=$(node "$HOME/.claude/forge/bin/forge-tools.cjs" checkpoint-load <phase-id>)
```

If the checkpoint contains `completedWaves`, note which waves have already been executed.
These will be skipped during wave execution in step 7.

## 4. Preflight Check

Run the preflight-check command to validate the phase is ready for execution:

```bash
PREFLIGHT=$(node "$HOME/.claude/forge/bin/forge-tools.cjs" preflight-check <phase-id>)
```

Parse the JSON result. If `verdict` is `FAIL`, display each issue from the `issues` array
to the user and **abort execution**. Do not proceed to wave detection or task execution.

If `verdict` is `PASS`, continue to the next step.

## 5. Gather Rollback Metadata

Before execution begins, capture state needed for potential rollback:

```bash
# Get tasks already closed before this execution run (properly quoted for JSON safety)
PRE_CLOSED="$(bd children <phase-id> --json | jq -c '[.[] | select(.status == "closed") | .id]')"

# Current branch and commit SHA
BRANCH="$(git branch --show-current)"
BASE_SHA="$(git rev-parse HEAD)"
```

Store these values (`preExistingClosed`, `branchName`, `baseCommitSha`) in every
checkpoint-save call during wave execution. This enables `/forge:rollback` to know
which tasks were closed by execution (vs already closed) and which commits to revert.

## 6. Detect Waves

Use the detect-waves tool to automatically group tasks by dependency order:

```bash
WAVES=$(node "$HOME/.claude/forge/bin/forge-tools.cjs" detect-waves <phase-id>)
```

This returns a JSON structure with:
- `waves`: array of wave objects, each containing `tasks_to_execute` and `tasks_already_done`
- `summary`: counts of open/in_progress/closed tasks

If `summary.tasks_open` is 0 and `summary.tasks_closed` equals `summary.total_tasks`,
the phase is already complete — skip to step 8.

If the output contains `circular_or_external_dependency`, report the cycle and ask the user
how to proceed.

## 7. Execute Waves

Before executing, resolve the model for the executor agent:
```bash
MODEL=$(node "$HOME/.claude/forge/bin/forge-tools.cjs" resolve-model forge-executor --raw)
```
If `MODEL` is non-empty, pass it to each Agent call below.

For each wave, in order:

### Wave N Execution

Skip waves where `tasks_to_execute` is empty (all tasks already done).

If a checkpoint was loaded in step 2 and this wave number is in `completedWaves`,
skip it (already completed in a previous session).

Before dispatching tasks, save a checkpoint (include rollback metadata from step 4):
```bash
node "$HOME/.claude/forge/bin/forge-tools.cjs" checkpoint-save <phase-id> '{"phaseId":"<phase-id>","completedWaves":[<previously completed wave numbers>],"currentWave":<N>,"taskStatuses":{<taskId>:<status>,...},"preExistingClosed":[<task IDs closed before execution>],"branchName":"<branch>","baseCommitSha":"<sha>","timestamp":"<ISO timestamp>"}'
```

Capture the current HEAD SHA before dispatching tasks (used by the per-wave quality gate):
```bash
WAVE_START_SHA=$(git rev-parse HEAD)
```

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
Phase Notes: <phase notes, omit if null>
Phase Design: <phase design, omit if null>
Project: <project vision>

Instructions:
1. Claim the task: bd update <task-id> --status=in_progress
2. Implement the task following the description and acceptance criteria
3. Run relevant tests to verify acceptance criteria are met
4. Verify you are on the phase branch (not main) before committing.
   Create an atomic git commit with a standardized message:
   Format: <type>(phase-<phase-id>): <summary> [task <task-id>]
   Where <type> is one of: feat, fix, refactor, test, docs, chore
   Example: feat(phase-abc12): add branch-create command [task xyz99]
   Use git add <specific files> — never git add . or git add -A
   NEVER run git merge or gh pr merge — merging is always left to the user
5. Signal completion: bd update <task-id> --notes="EXECUTION_COMPLETE: <brief summary of what was done>"

If you encounter a blocker:
- bd update <task-id> --notes='BLOCKED: <description>'
- Do NOT close the task
- Report the blocker in your response
")
```

**Single task** — execute it directly without spawning an agent (saves context overhead).
Follow the same steps: claim, implement, verify, commit, signal completion.

### Wait for Wave Completion

After all agents in a wave complete, snapshot the cost delta for this wave:
```bash
node "$HOME/.claude/forge/bin/forge-tools.cjs" cost-snapshot <phase-id>
```

Then check results:
```bash
PHASE=$(node "$HOME/.claude/forge/bin/forge-tools.cjs" phase-context <phase-id>)
```

Review the updated task statuses:
- If all wave tasks signaled completion (EXECUTION_COMPLETE in notes) or are closed, proceed to the next wave
- If any task is still open or marked BLOCKED, report the status and decide:
  - Skip and continue to next wave (if non-blocking)
  - Fix the issue inline (if quick)
  - Stop execution and report (if the blocker affects downstream waves)

### Per-Wave Quality Gate

This gate runs after each wave completes and before proceeding to the next wave. It is
fault-tolerant: any error in the gate mechanism itself logs a warning and continues to the
next wave. The gate must never crash the execution loop.

**Step 1: Check if gate is enabled**

```bash
SETTINGS=$(node "$HOME/.claude/forge/bin/forge-tools.cjs" settings-load)
```

Parse `shift_left_gates` from the settings JSON. If `shift_left_gates` is `false` or not
present, skip this entire gate and proceed to the next wave.

**Step 2: Compute wave-scoped changed files**

Determine which files were changed by the tasks in the current wave only. Use the commit SHA
captured before this wave started (`WAVE_START_SHA`, recorded from `git rev-parse HEAD` before
dispatching the wave's tasks) and the current HEAD:

```bash
WAVE_START_SHA=<SHA captured before this wave's tasks were dispatched>
WAVE_CHANGED_FILES=$(git diff --name-only "$WAVE_START_SHA"..HEAD)
```

If `WAVE_CHANGED_FILES` is empty (no files changed in this wave), skip the gate and proceed
to the next wave.

**Step 3: Resolve models and spawn audit agents in parallel**

Resolve models for the two audit agents:

```bash
MODEL_SECURITY=$(node "$HOME/.claude/forge/bin/forge-tools.cjs" resolve-model forge-security-auditor --raw)
MODEL_ARCHITECT=$(node "$HOME/.claude/forge/bin/forge-tools.cjs" resolve-model forge-architect --raw)
```

Spawn both agents in parallel using two Agent tool calls in the same response:

**Security Auditor:**
```
Agent(subagent_type="forge-security-auditor", model="<MODEL_SECURITY or omit>", prompt="
Audit the following files changed in wave <N> for security vulnerabilities.

<changed_files>
<WAVE_CHANGED_FILES>
</changed_files>

Scope your analysis to these files only. These are the files changed by the current
execution wave, not the entire branch. Output your findings as raw JSON conforming to
agents/schemas/audit-findings.md. Do NOT wrap JSON in markdown fences.
")
```

**Architect:**
```
Agent(subagent_type="forge-architect", model="<MODEL_ARCHITECT or omit>", prompt="
Audit the following files changed in wave <N> for architectural violations and adherence issues.

<changed_files>
<WAVE_CHANGED_FILES>
</changed_files>

Scope your analysis to these files only. These are the files changed by the current
execution wave, not the entire branch. Output your findings as raw JSON conforming to
agents/schemas/audit-findings.md with subagent_type='forge-architect'.
Do NOT wrap JSON in markdown fences.
")
```

**Step 4: Parse agent responses tolerantly**

Apply the same tolerant parsing logic as quality-gate.md step 4 to each agent's response:

1. **Strip markdown fences**: Remove lines matching `` ```json `` or `` ``` ``.
2. **Extract JSON object**: Find the first `{` and the last `}`, extract the substring.
3. **Parse JSON**: Attempt `JSON.parse()` on the extracted string.
4. **Validate structure**: Confirm the parsed object has `findings` (array). If missing,
   treat as a parse failure for that agent.
5. **Fallback on failure**: Record the agent as failed. Do not abort the gate.

**Step 5: Handle partial agent failure**

- If one agent fails, continue with the other agent's results.
- If both agents fail, log a warning and continue to the next wave:

```
WARNING: Per-wave quality gate -- both audit agents failed for wave <N>. Continuing execution.
```

**Step 6: Apply enforcement mode**

Parse `shift_left_enforcement` from the settings JSON loaded in step 1. Valid values are
`advisory` (default) and `enforced`. If not present, default to `advisory`.

Collect all findings from successful agents into a single list.

**Advisory mode** (`shift_left_enforcement` is `advisory` or not set):

Log findings as a context comment on the phase bead silently. No user interaction, no blocking:

```bash
node "$HOME/.claude/forge/bin/forge-tools.cjs" context-write <phase-id> '{
  "agent": "wave-quality-gate",
  "task": "wave-<N>",
  "status": "completed",
  "findings": [
    // all findings from successful agents, each with agent origin, severity, file, description
  ]
}'
```

Proceed to the next wave immediately.

**Enforced mode** (`shift_left_enforcement` is `enforced`):

Check if any finding has severity `critical` or `high`.

If no critical/high findings exist, proceed to the next wave normally (advisory findings are
still logged via context-write as above).

If critical/high findings exist, halt execution and present findings via AskUserQuestion:

Format each critical/high finding as a numbered item:

```
PER-WAVE QUALITY GATE -- Wave <N> findings (critical/high):

  1. [CRITICAL] [security-auditor] src/api/auth.ts:42
     Hardcoded database password in source

  2. [HIGH] [architect] src/db/schema.ts:15
     Layering violation: direct DB access from controller
```

```
AskUserQuestion(
  question: "Wave <N> quality gate found critical/high issues. How to proceed?",
  multiSelect: false,
  options: [
    "Approve and continue to next wave",
    "Fix inline before continuing",
    "Abort execution"
  ]
)
```

- **Approve and continue**: Log findings via context-write (same as advisory) and proceed.
- **Fix inline**: Pause wave progression. The orchestrator should address the findings before
  continuing. After fixes are applied, proceed to the next wave.
- **Abort execution**: Stop the execution loop entirely. Report the findings and exit.

## 8. Phase Completion Check

After all waves complete:
```bash
PHASE=$(node "$HOME/.claude/forge/bin/forge-tools.cjs" phase-context <phase-id>)
```

If all tasks are closed:

First, save the final checkpoint:
```bash
node "$HOME/.claude/forge/bin/forge-tools.cjs" checkpoint-save <phase-id> '{"phaseId":"<phase-id>","completedWaves":[<all wave numbers>],"taskStatuses":{<all tasks>:"closed"},"timestamp":"<ISO timestamp>","completed":true}'
```

Then load settings to check the verification gate:
```bash
SETTINGS=$(node "$HOME/.claude/forge/bin/forge-tools.cjs" settings-load)
```

Parse `skip_verification` from the settings JSON. It defaults to `false` if not present.

**If `skip_verification` is true** — close the phase directly:
```bash
bd close <phase-id> --reason="All tasks completed"
bd remember --key "forge:phase:<id>:completed" "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
```

**If `skip_verification` is false (default)** — do NOT close the phase. Instead, inform the
user that all tasks are complete and that phase closure is owned by the verify workflow:

> All tasks in phase `<phase-id>` are complete. Run `/forge:verify <phase-id>` to validate
> acceptance criteria and close the phase. Phase closure is handled by the verify workflow.

If some tasks remain open, report what's left and suggest next steps.

## 9. Suggest Next Step

- If phase complete and `skip_verification` is false: run `/forge:verify <phase>` to validate and close the phase
- If phase complete and `skip_verification` is true: phase is already closed — run `/forge:plan <next-phase>` to continue
- If tasks remaining: fix blockers, then `/forge:execute <phase>` again
- Check overall progress: `/forge:progress`

</process>
