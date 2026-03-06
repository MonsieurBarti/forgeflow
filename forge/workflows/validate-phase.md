<purpose>
Retroactively audit validation coverage for a completed phase. Check that acceptance criteria
were actually met, identify gaps between promises and delivery, and optionally generate missing
tests to fill gaps. Reports coverage status on each task bead.
</purpose>

<process>

## 1. Resolve Phase

Parse `$ARGUMENTS` for a phase number (integer, decimal, or letter-suffix) or phase bead ID.

If no argument provided, find the most recently closed phase:
```bash
PROJECT=$(node "$HOME/.claude/forge/bin/forge-tools.cjs" find-project)
# Extract project ID from result
CONTEXT=$(node "$HOME/.claude/forge/bin/forge-tools.cjs" project-context <project-id>)
```

Match the phase number to the ordered phases list from project context.
If a phase ID was given directly, use it.

Verify the phase is closed or in_progress. If still open (not started):
```
ERROR: Phase has not been executed yet.
Run /forge:execute <phase> first, then validate.
```
Exit.

Present banner:
```
------------------------------------------------------------
 FORGE > VALIDATE PHASE {N}: {phase_title}
------------------------------------------------------------
```

## 2. Detect Input State and Load Tasks

Load all tasks in the phase:
```bash
node "$HOME/.claude/forge/bin/forge-tools.cjs" verify-phase <phase-id>
```

Classify input state:

| State | Condition | Action |
|-------|-----------|--------|
| **A** | Tasks have `acceptance_criteria` | Audit criteria against code and tests |
| **B** | Tasks closed but no `acceptance_criteria` | Reconstruct requirements from implementation |
| **C** | Phase not executed (all tasks open) | Exit with guidance |

For each task, extract:
- `title` -- what was implemented
- `acceptance_criteria` -- what "done" looks like
- `notes` -- implementation details, file paths
- `status` -- should be `closed` for completed tasks

Also check requirement traceability:
```bash
bd dep list <task-id> --type validates
```

Build a requirement map: task -> acceptance criteria -> requirements validated.

## 3. Discover Test Infrastructure

Identify the project's existing test setup:

```bash
# Find test directories and files
find . -type d -name "*test*" -o -name "*spec*" -o -name "*__tests__*" 2>/dev/null | head -20
find . -type f \( -name "*.test.*" -o -name "*.spec.*" -o -name "*_test.*" \) 2>/dev/null | head -20
# Check for test runners
ls package.json *.sln Cargo.toml pyproject.toml go.mod 2>/dev/null
```

Record: test framework, test command, test directory structure, naming conventions.

## 4. Cross-Reference: Criteria vs Tests

For each task with acceptance criteria:

1. **Find implementation files** from task notes or git history
2. **Find existing tests** that target those files (by filename, imports, test descriptions)
3. **Match each acceptance criterion** to existing tests

Record for each criterion: requirement -> test_file -> status.

## 5. Gap Analysis

Classify each acceptance criterion:

| Status | Criteria |
|--------|----------|
| **COVERED** | Test exists, targets the behavior, runs green |
| **PARTIAL** | Test exists but is incomplete or failing |
| **MISSING** | No test found for this criterion |

For State B tasks (no acceptance criteria): classify as MISSING with a note
that criteria were reconstructed from implementation.

Build gap list: `{ task_id, criterion, gap_type, suggested_test_path }`

If no gaps found, skip to Step 7 with `validation_status: compliant`.

## 6. Present Gap Plan and Fill

Present the gap analysis to the user:

```
AskUserQuestion(
  header: "Validation Gap Analysis",
  question: |
    ## Phase {N}: {phase_title}

    ### Coverage Summary
    | Status | Count |
    |--------|-------|
    | COVERED | {N} |
    | PARTIAL | {M} |
    | MISSING | {K} |

    ### Gaps Found
    {for each gap: task title -> criterion -> gap type -> suggested test}

    How would you like to proceed?
  options:
    - "Fix all gaps -- generate missing tests"
    - "Skip -- mark as manual-only"
    - "Cancel"
)
```

If "Fix all gaps":

Resolve the verifier model:
```bash
MODEL=$(node "$HOME/.claude/forge/bin/forge-tools.cjs" resolve-model forge-verifier --raw)
```

For phases with multiple gaps, spawn a **forge-verifier** agent (with `model` if non-empty):
- Provide: PLAN context, implementation files, gap list, test infrastructure details
- Constraint: never modify implementation files, max 3 debug iterations per test
- Expected output: test files + gap resolution status

For single gaps, generate the test inline following project conventions.

Handle verifier return:
- All gaps filled -> record tests, proceed to Step 7
- Partial -> record resolved gaps, move escalated to manual-only
- Escalate -> move all to manual-only

If "Skip": mark all gaps as manual-only, proceed to Step 7.

## 7. Update Task Beads with Validation Status

For each task, add a validation comment:
```bash
bd comments add <task-id> "Validation: <COVERED|PARTIAL|MISSING> - <summary>"
```

For tasks with new tests:
```bash
bd update <task-id> --notes="Validation tests: <test-file-paths>"
```

## 8. Commit Test Files

If test files were generated:
```bash
git add {test_files}
git commit -m "test(phase-{N}): add validation tests from forge:validate-phase"
```

## 9. Results and Routing

**Compliant (all criteria covered):**
```
------------------------------------------------------------
 FORGE > PHASE {N} VALIDATED -- ALL CRITERIA COVERED
------------------------------------------------------------

All acceptance criteria have automated verification.

| Task | Criteria | Status |
|------|----------|--------|
{per-task breakdown}

Next: /forge:progress or /forge:verify {N}
```

**Partial (some gaps remain):**
```
------------------------------------------------------------
 FORGE > PHASE {N} VALIDATED (PARTIAL)
------------------------------------------------------------

{M} criteria automated, {K} manual-only.

| Task | Criteria | Status |
|------|----------|--------|
{per-task breakdown}

### Manual-Only Items
{list of criteria that need manual verification}

Retry: /forge:validate-phase {N}
```

**State B (reconstructed):**
```
------------------------------------------------------------
 FORGE > PHASE {N} VALIDATED (RECONSTRUCTED)
------------------------------------------------------------

No acceptance criteria found on task beads. Validation was based on
implementation analysis. Consider adding criteria for future phases.

{coverage summary}
```

</process>

<success_criteria>
- [ ] Phase resolved and input state detected (A/B/C)
- [ ] State C exits cleanly with guidance
- [ ] Tasks loaded with acceptance criteria (or reconstructed for State B)
- [ ] Test infrastructure discovered
- [ ] Each criterion cross-referenced against existing tests
- [ ] Gaps classified as COVERED/PARTIAL/MISSING
- [ ] User gate with gap table and options
- [ ] Verifier spawned for gap filling (if requested)
- [ ] All three verifier return formats handled
- [ ] Task beads updated with validation comments
- [ ] Test files committed separately from docs
- [ ] Results with routing presented
</success_criteria>
