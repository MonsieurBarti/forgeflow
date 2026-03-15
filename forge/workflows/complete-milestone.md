<purpose>
Mark a milestone as complete. Verify all phases are closed, check for audit status,
generate a retrospective summary stored in the milestone bead, and close the milestone epic.
All state lives in the bead graph -- no file archival needed.
</purpose>

<process>

## 1. Find Project and Milestone

```bash
PROJECT=$(node "$HOME/.claude/forge/bin/forge-tools.cjs" find-project)
```

If no project found, report "No Forge project found" and suggest `/forge:new`. Stop.

Extract the project ID.

If a milestone ID was given as argument, use it directly.

Otherwise, list milestones to find the active one:
```bash
node "$HOME/.claude/forge/bin/forge-tools.cjs" milestone-list <project-id>
```

If no open milestones exist:
```
No active milestone found. Use /forge:new-milestone to start one.
```
Stop.

## 2. Check Audit Status

Look for audit results on the milestone bead:
```bash
bd show <milestone-id> --json
```

Check the design field for audit results (stored by /forge:audit-milestone).

**If no audit exists:**
```
No milestone audit found. Recommend running /forge:audit-milestone first
to verify requirements coverage and cross-phase integration.
```
Use AskUserQuestion:
- options: "Run audit first" | "Proceed without audit" | "Cancel"

**If audit found gaps:**
```
Milestone audit found gaps. Recommend running /forge:plan-milestone-gaps
to create phases that close the gaps, or proceed to accept as known debt.
```
Use AskUserQuestion:
- options: "Plan gap closure" | "Proceed anyway (accept gaps)" | "Cancel"

**If audit passed:** Proceed to step 3.

## 3. Verify Phase Completion

Get all phases under the milestone:
```bash
bd children <milestone-id> --json
```

Filter to forge:phase beads. Check each phase's status.

**If all phases are closed:** Continue.

**If some phases are still open:**
```
Incomplete phases found:
- Phase N: <name> (status: <status>)
- Phase M: <name> (status: <status>)
```

Use AskUserQuestion:
- options:
  - "Proceed anyway (mark incomplete phases as deferred)"
  - "Go back and finish them"
  - "Cancel"

If "Proceed anyway": Close incomplete phases with reason:
```bash
bd close <phase-id> --reason="deferred: milestone completion"
```

## 4. Gather Accomplishments

For each closed phase, extract what was accomplished:
```bash
bd show <phase-id> --json
```

Read the phase description and its closed tasks:
```bash
bd children <phase-id> --json
```

Compile 4-8 key accomplishments from across all phases.

Present to user for review:
```
Key accomplishments for this milestone:
1. <Achievement from phase 1>
2. <Achievement from phase 2>
...
```

## 5. Check Requirement Coverage

List all requirements under the milestone:
```bash
bd children <milestone-id> --json
```

Filter to forge:req beads. For each requirement, check if any task validates it:
```bash
bd dep list <req-id> --type validates --json
```

Report coverage:
```
Requirements: N/M satisfied
- REQ: <title> -- SATISFIED (validated by <task-ids>)
- REQ: <title> -- UNSATISFIED (no validating tasks found)
```

Record unsatisfied requirements as known gaps in the retrospective.

**Auto-close satisfied requirements:**

For each open forge:req bead under the milestone that has `validates` links:

```bash
bd dep list <req-id> --type validates --json
```

If ALL validating tasks have `status == "closed"`, close the requirement:

```bash
bd close <req-id> --reason="All validating tasks completed"
```

Report any auto-closed requirements alongside the coverage summary.

## 6. Generate Retrospective

Compile the milestone retrospective and store it in the bead:

```bash
bd update <milestone-id> --notes="Retrospective:

## Accomplishments
<accomplishment list>

## Requirements Coverage
<N/M requirements satisfied>
<list of unsatisfied requirements if any>

## Known Gaps / Tech Debt
<gaps from audit or uncovered requirements>

## Stats
- Phases: <N>
- Tasks completed: <M>
- Requirements satisfied: <X/Y>

Completed: <date>"
```

## 7. Close Milestone

```bash
bd close <milestone-id> --reason="Milestone complete. <N> phases, <M/Y> requirements satisfied."
```

## 7b. Remove Worktree

Clean up the milestone worktree now that all phases are merged:
```bash
node "$HOME/.claude/forge/bin/forge-tools.cjs" worktree-remove <milestone-id>
```

If the worktree no longer exists (already removed or was never created), treat this as success — the cleanup goal is achieved either way.

**IMPORTANT: NEVER close the project bead.** The project stays open permanently — it represents the repository itself. Only milestones are closed.

## 7c. Cleanup Preview (dry-run)

Collect what would be cleaned by running each cleanup command in dry-run mode:

```bash
BRANCH_PREVIEW=$(node "$HOME/.claude/forge/bin/forge-tools.cjs" milestone-cleanup-branches <milestone-id> --dry-run)
BEAD_PREVIEW=$(node "$HOME/.claude/forge/bin/forge-tools.cjs" milestone-close-beads <milestone-id> --dry-run)
MEMORY_PREVIEW=$(node "$HOME/.claude/forge/bin/forge-tools.cjs" milestone-purge-memories <milestone-id> --dry-run)
```

Parse JSON from each. Display a formatted preview:

```
## Cleanup Preview

Branches to delete: <N>
<list branch names, or "none">

Beads to close: <N>
<list id + title, or "none">

Memories to purge: <N>
<list key names, or "none">
```

**If all three return count: 0:** Skip steps 7d-7e. Note "Cleanup: nothing to do" and proceed to step 8.

## 7d. User Confirmation

Use AskUserQuestion (multiSelect: false):
- header: "Cleanup"
- question: "Proceed with milestone cleanup?"
- options:
  - "Execute all cleanup" — proceed with all three cleanup steps
  - "Skip cleanup" — skip directly to step 8
  - "Cancel" — stop the workflow entirely

If "Cancel": stop the workflow.
If "Skip cleanup": proceed to step 8 with cleanup_skipped = true.

## 7e. Execute Cleanup

Call each command without --dry-run, in order (branches first since worktree was already removed in 7b):

```bash
BRANCH_RESULT=$(node "$HOME/.claude/forge/bin/forge-tools.cjs" milestone-cleanup-branches <milestone-id>)
BEAD_RESULT=$(node "$HOME/.claude/forge/bin/forge-tools.cjs" milestone-close-beads <milestone-id>)
MEMORY_RESULT=$(node "$HOME/.claude/forge/bin/forge-tools.cjs" milestone-purge-memories <milestone-id>)
```

Each command is failure-tolerant internally (allowFail per item). Parse the JSON results.

## 7f. Cleanup Report

Append cleanup results to the step 8 report:

```
## Cleanup Results
- Branches deleted: <N> (failed: <M>)
- Beads closed: <N> (failed: <M>)
- Memories purged: <N> (failed: <M>)
```

If any failures, list them so the user can investigate.

## 8. Report and Next Steps

```
# Milestone Complete

**<milestone name>**

Phases: <N> completed
Requirements: <M/Y> satisfied
<known gaps summary if any>

<if cleanup was executed, include cleanup results from step 7f>

Retrospective stored in milestone bead (<milestone-id>).

---

Next steps:
- /forge:new-milestone -- start next milestone cycle
- /forge:progress -- see updated project status
```

</process>

<success_criteria>
- [ ] Project and milestone identified
- [ ] Audit status checked (recommend audit if missing)
- [ ] All phases verified as closed (or deferred with user consent)
- [ ] Accomplishments extracted from phases
- [ ] Requirement coverage checked via validates dependencies
- [ ] Retrospective generated and stored in milestone bead notes
- [ ] Milestone epic closed
- [ ] Worktree removed via worktree-remove
- [ ] Cleanup preview shown (branches, beads, memories)
- [ ] User confirmed cleanup execution (or skipped)
- [ ] Cleanup executed (branches deleted, beads closed, memories purged)
- [ ] Next steps presented to user
</success_criteria>
