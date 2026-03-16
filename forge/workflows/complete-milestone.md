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

Requirements are owned by phases, not the milestone directly. Traverse milestone -> phases -> phase children to find all forge:req beads.

Get all phases under the milestone:
```bash
bd children <milestone-id> --json
```

Filter to forge:phase beads. For each phase, get its children:
```bash
bd children <phase-id> --json
```

Filter to forge:req beads. Collect all requirements across all phases.

For each requirement, check if any task validates it:
```bash
bd dep list <req-id> --type validates --json
```

Report coverage:
```
Requirements: N/M satisfied
- REQ: <title> (Phase: <phase-name>) -- SATISFIED (validated by <task-ids>)
- REQ: <title> (Phase: <phase-name>) -- UNSATISFIED (no validating tasks found)
```

Record unsatisfied requirements as known gaps in the retrospective.

**Auto-close satisfied requirements:**

For each open forge:req bead found via the phase traversal that has `validates` links:

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

**IMPORTANT: NEVER close the project bead.** The project stays open permanently — it represents the repository itself. Only milestones are closed.

## 7b. Remove Worktrees

Clean up all worktrees created for phases, quick tasks, and debug tasks under this milestone.

First, get all phase IDs under the milestone:
```bash
bd children <milestone-id> --json
```

Filter to forge:phase beads. For each phase ID, remove its worktree if it exists:
```bash
# For each phase
git worktree remove .forge/worktrees/phase-<phaseId> --force 2>/dev/null || true
```

Also remove any quick-task and debug worktrees:
```bash
# Remove all quick and debug worktrees
for wt in .forge/worktrees/quick-* .forge/worktrees/debug-*; do
  [ -d "$wt" ] && git worktree remove "$wt" --force 2>/dev/null || true
done
```

Prune stale worktree references:
```bash
git worktree prune
```

If no worktrees exist (already removed or were never created), treat this as success — the cleanup goal is achieved either way.

## 7c. Cleanup Preview (dry-run)

Collect what would be cleaned by running each cleanup command in dry-run mode:

```bash
BEAD_PREVIEW=$(node "$HOME/.claude/forge/bin/forge-tools.cjs" milestone-close-beads <milestone-id> --dry-run)
MEMORY_PREVIEW=$(node "$HOME/.claude/forge/bin/forge-tools.cjs" milestone-purge-memories <milestone-id> --dry-run)
```

Also list the branches that will be deleted:
```bash
# Collect branches to delete
PHASE_BRANCHES=$(git branch --list 'forge/phase-*')
QUICK_BRANCHES=$(git branch --list 'forge/quick-*')
DEBUG_BRANCHES=$(git branch --list 'forge/debug-*')
MILESTONE_BRANCH="forge/milestone-<milestone-id>"
```

Display a formatted preview:

```
## Cleanup Preview

Branches to delete: <N>
<list: forge/phase-*, forge/quick-*, forge/debug-*, forge/milestone-<id>>

Beads to close: <N>
<list id + title, or "none">

Memories to purge: <N>
<list key names, or "none">
```

**If nothing to clean:** Skip steps 7d-7e. Note "Cleanup: nothing to do" and proceed to step 7g.

## 7d. User Confirmation

Use AskUserQuestion (multiSelect: false):
- header: "Cleanup"
- question: "Proceed with milestone cleanup?"
- options:
  - "Execute all cleanup" — proceed with all cleanup steps
  - "Skip cleanup" — skip directly to step 7g
  - "Cancel" — stop the workflow entirely

If "Cancel": stop the workflow.
If "Skip cleanup": proceed to step 7g with cleanup_skipped = true.

## 7e. Execute Cleanup

Delete branches for phases, quick tasks, debug tasks, and the milestone branch:

```bash
# Delete phase branches (local + remote)
for branch in $(git branch --list 'forge/phase-*' | tr -d ' '); do
  git branch -D "$branch" 2>/dev/null || true
  git push origin --delete "$branch" 2>/dev/null || true
done

# Delete quick-task branches (local + remote)
for branch in $(git branch --list 'forge/quick-*' | tr -d ' '); do
  git branch -D "$branch" 2>/dev/null || true
  git push origin --delete "$branch" 2>/dev/null || true
done

# Delete debug branches (local + remote)
for branch in $(git branch --list 'forge/debug-*' | tr -d ' '); do
  git branch -D "$branch" 2>/dev/null || true
  git push origin --delete "$branch" 2>/dev/null || true
done
```

Close beads and purge memories:
```bash
BEAD_RESULT=$(node "$HOME/.claude/forge/bin/forge-tools.cjs" milestone-close-beads <milestone-id>)
MEMORY_RESULT=$(node "$HOME/.claude/forge/bin/forge-tools.cjs" milestone-purge-memories <milestone-id>)
```

Each command is failure-tolerant internally (allowFail per item). Parse the JSON results.

## 7f. Cleanup Report

Append cleanup results to the step 8 report:

```
## Cleanup Results
- Worktrees removed: <N>
- Branches deleted: <N> (failed: <M>)
- Beads closed: <N> (failed: <M>)
- Memories purged: <N> (failed: <M>)
```

If any failures, list them so the user can investigate.

## 7g. Changelog and Release

Generate a changelog and optionally create a GitHub release for this milestone.

**Step 1: Generate changelog**
```bash
node "$HOME/.claude/forge/bin/forge-tools.cjs" changelog-generate
```

Parse the JSON result. If `generated` is false (no commits), skip this step.

**Step 2: Bump version**
```bash
node "$HOME/.claude/forge/bin/forge-tools.cjs" version-bump
```

Parse the JSON result. Display the version bump to the user:
```
Version bump: <previousVersion> → <newVersion> (<level>, <auto-detected or explicit>)
```

**Step 3: Commit release artifacts**
```bash
git add CHANGELOG.md package.json
git commit -m "chore: release v<newVersion>"
```

**Step 4: Ask user about creating a GitHub release**

Display a preview of the release:
```
Release preview:
  Tag: v<newVersion>
  Version: <previousVersion> → <newVersion>
  Changelog: <commitCount> commits across <sections count> sections
```

Use AskUserQuestion (multiSelect: false):
- header: "Release"
- question: "Create a GitHub release for v<newVersion>?"
- options:
  - "Create release" — tag, push, and create GitHub release
  - "Skip release" — keep changelog and version bump but don't create a release

**Step 5: Create release (if confirmed)**
```bash
node "$HOME/.claude/forge/bin/forge-tools.cjs" release-create
```

Parse the JSON result. Display the release URL if created.

If release-create fails, report the error but do not block milestone completion.

## 7h. Create PR to Main

Create a pull request from the milestone branch to main, collecting all milestone work:

```bash
git push origin forge/milestone-<milestone-id>

gh pr create \
  --base main \
  --head forge/milestone-<milestone-id> \
  --title "Milestone: <milestone-name>" \
  --body "## Summary

Closes milestone <milestone-id>.

### Accomplishments
<accomplishment list from step 4>

### Requirements Coverage
<N/M requirements satisfied>

### Phases
<list of phases with status>"
```

Display the PR URL to the user.

## 7i. Delete Milestone Branch (after merge)

After the PR is merged (or if the user confirms manual merge), delete the milestone branch:

```bash
git branch -D forge/milestone-<milestone-id> 2>/dev/null || true
git push origin --delete forge/milestone-<milestone-id> 2>/dev/null || true
```

**Note:** If the PR has not been merged yet, skip this step and remind the user to delete the branch after merging.

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
- [ ] Phase/quick/debug worktrees removed from .forge/worktrees/
- [ ] Cleanup preview shown (branches, beads, memories)
- [ ] User confirmed cleanup execution (or skipped)
- [ ] Cleanup executed (forge/phase-*, forge/quick-*, forge/debug-* branches deleted, beads closed, memories purged)
- [ ] Changelog generated from Conventional Commits (CHANGELOG.md)
- [ ] Version bumped in package.json (auto-detected from CC types)
- [ ] Release artifacts committed (CHANGELOG.md + package.json)
- [ ] User asked about GitHub release creation
- [ ] GitHub release created if confirmed (tag + push + gh release)
- [ ] PR created from forge/milestone-<id> to main via gh pr create
- [ ] Milestone branch (forge/milestone-<id>) deleted after PR merge
- [ ] Next steps presented to user
</success_criteria>
