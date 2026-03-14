<purpose>
Generate unit and E2E tests for a completed phase based on task beads and their acceptance criteria.
Classifies each changed file into TDD (unit), E2E (browser), or Skip categories, presents a test
plan for user approval, then generates tests following RED-GREEN conventions.

Replaces ad-hoc `/forge:quick` prompts for test generation with a standardized workflow that uses
proper classification, quality gates, and gap reporting.
</purpose>

<process>

<step name="resolve_phase">
Parse `$ARGUMENTS` for:
- Phase number (integer, decimal, or letter-suffix) or phase bead ID
- Remaining text after phase identifier -> store as `$EXTRA_INSTRUCTIONS` (optional)

Example: `/forge:add-tests 3 focus on edge cases` -> phase 3, extra instructions "focus on edge cases"

If no argument provided:
```
ERROR: Phase number or ID required
Usage: /forge:add-tests <phase> [additional instructions]
Example: /forge:add-tests 3
Example: /forge:add-tests 3 focus on edge cases in the pricing module
```
Exit.

Find the project and resolve the phase:
```bash
PROJECT=$(node "$HOME/.claude/forge/bin/forge-tools.cjs" find-project)
# Extract project ID from result
CONTEXT=$(node "$HOME/.claude/forge/bin/forge-tools.cjs" project-context <project-id>)
```

Match the phase number to the ordered phases list from project context.
If a phase ID was given directly, use it.

Verify the phase exists and is closed or in_progress. If still open (not started):
```
ERROR: Phase has not been executed yet.
Run /forge:execute <phase> first, then add tests.
```
Exit.

Present banner:
```
------------------------------------------------------------
 FORGE > ADD TESTS -- Phase {N}: {phase_title}
------------------------------------------------------------
```
</step>

<step name="load_tasks_and_criteria">
Load all tasks in the phase with their acceptance criteria:

```bash
bd children <phase-id> --json
```

For each task, extract:
- `title` -- what was implemented
- `acceptance_criteria` -- what "done" looks like (the test specification)
- `notes` -- implementation details, file paths changed
- `status` -- should be `closed` for completed tasks

Also check requirement traceability:
```bash
bd dep list <task-id> --type validates
```

If no tasks have acceptance criteria:
```
WARNING: No acceptance criteria found on task beads.
Tests will be generated based on implementation analysis only.
```

Build a map of: task -> acceptance criteria -> implementation files -> requirements validated.
</step>

<step name="analyze_implementation">
From task notes and acceptance criteria, identify the files modified by the phase.

If task notes don't list files, use git to find them:
```bash
# Find commits related to this phase
git log --oneline --all --grep="phase" | head -20
# Or diff against the phase's starting point
```

For each file, classify into one of three categories:

| Category | Criteria | Test Type |
|----------|----------|-----------|
| **TDD** | Pure functions where `expect(fn(input)).toBe(output)` is writable | Unit tests |
| **E2E** | UI behavior verifiable by browser automation | Playwright/E2E tests |
| **Skip** | Not meaningfully testable or already covered | None |

**TDD classification -- apply when:**
- Business logic: calculations, pricing, tax rules, validation
- Data transformations: mapping, filtering, aggregation, formatting
- Parsers: CSV, JSON, XML, custom format parsing
- Validators: input validation, schema validation, business rules
- State machines: status transitions, workflow steps
- Utilities: string manipulation, date handling, number formatting

**E2E classification -- apply when:**
- Keyboard shortcuts: key bindings, modifier keys, chord sequences
- Navigation: page transitions, routing, breadcrumbs, back/forward
- Form interactions: submit, validation errors, field focus, autocomplete
- Selection: row selection, multi-select, shift-click ranges
- Drag and drop: reordering, moving between containers
- Modal dialogs: open, close, confirm, cancel
- Data grids: sorting, filtering, inline editing, column resize

**Skip classification -- apply when:**
- UI layout/styling: CSS classes, visual appearance, responsive breakpoints
- Configuration: config files, environment variables, feature flags
- Glue code: dependency injection setup, middleware registration, routing tables
- Migrations: database migrations, schema changes
- Simple CRUD: basic create/read/update/delete with no business logic
- Type definitions: records, DTOs, interfaces with no logic

Read each file to verify classification. Don't classify based on filename alone.
</step>

<step name="present_classification">
Present the classification to the user for confirmation:

```
AskUserQuestion(
  header: "Test Classification",
  question: |
    ## Files classified for testing

    ### TDD (Unit Tests) -- {N} files
    {list of files with brief reason}

    ### E2E (Browser Tests) -- {M} files
    {list of files with brief reason}

    ### Skip -- {K} files
    {list of files with brief reason}

    {if $EXTRA_INSTRUCTIONS: "Additional instructions: ${EXTRA_INSTRUCTIONS}"}

    ### Acceptance Criteria Coverage
    {for each task: task title -> criteria -> files covering it}

    How would you like to proceed?
  options:
    - "Approve and generate test plan"
    - "Adjust classification (I'll specify changes)"
    - "Cancel"
)
```

If user selects "Adjust classification": apply their changes and re-present.
If user selects "Cancel": exit gracefully.
</step>

<step name="discover_test_structure">
Before generating the test plan, discover the project's existing test structure.

**Primary detection -- use detect-test-runner:**
```bash
node "$HOME/.claude/forge/bin/forge-tools.cjs" detect-test-runner
```
This returns a JSON object with `runner`, `command`, `framework`, and `test_directory` fields.
Use these values as the authoritative test configuration for all subsequent steps.

**Fallback -- filesystem heuristics (only if detect-test-runner fails or returns incomplete data):**
```bash
# Find existing test directories
find . -type d -name "*test*" -o -name "*spec*" -o -name "*__tests__*" 2>/dev/null | head -20
# Find existing test files for convention matching
find . -type f \( -name "*.test.*" -o -name "*.spec.*" -o -name "*Tests.*" -o -name "*Test.*" \) 2>/dev/null | head -20
# Check for test runners
ls package.json *.sln Cargo.toml pyproject.toml 2>/dev/null
```

From the detection results, identify:
- Test directory structure (where unit tests live, where E2E tests live)
- Naming conventions (`.test.ts`, `.spec.ts`, `*Tests.fs`, `_test.go`, etc.)
- Test runner commands (how to execute unit tests, how to execute E2E tests)
- Test framework (Jest, Playwright, xUnit, pytest, cargo test, etc.)

**Test file naming convention for generated tests:**
Place per-task test files at: `tests/forge/<phase-slug>/task-<task-id>.<ext>`
The extension should match the detected framework and language:
- Node.js (node:test): `.test.cjs` (default for CommonJS projects)
- TypeScript (jest/vitest): `.test.ts`
- Python (pytest): `_test.py` or `test_*.py`
- Rust (cargo): placed in `src/` or `tests/` per Rust conventions
- Go: `_test.go`
For example: `tests/forge/phase-abc/task-xyz.test.cjs`

If test structure is ambiguous, ask the user:
```
AskUserQuestion(
  header: "Test Structure",
  question: "I found multiple test locations. Where should I create tests?",
  options: [list discovered locations]
)
```
</step>

<step name="generate_test_plan">
For each approved file, create a detailed test plan informed by acceptance criteria.

**For TDD files**, plan tests following RED-GREEN-REFACTOR:
1. Map acceptance criteria from the task bead to specific testable assertions
2. Identify testable functions/methods in the file
3. For each function: list input scenarios, expected outputs, edge cases
4. Note: since code already exists, tests may pass immediately -- that's OK, but verify they test the RIGHT behavior

**For E2E files**, plan tests following RED-GREEN gates:
1. Map acceptance criteria to user scenarios
2. For each scenario: describe the user action, expected outcome, assertions
3. Note: RED gate means confirming the test would fail if the feature were broken

Present the complete test plan:

```
AskUserQuestion(
  header: "Test Plan",
  question: |
    ## Test Generation Plan

    ### Unit Tests ({N} tests across {M} files)
    {for each file: test file path, list of test cases}
    {link each test case to the acceptance criteria it validates}

    ### E2E Tests ({P} tests across {Q} files)
    {for each file: test file path, list of test scenarios}

    ### Test Commands
    - Unit: {discovered test command}
    - E2E: {discovered e2e command}

    Ready to generate?
  options:
    - "Generate all"
    - "Cherry-pick (I'll specify which)"
    - "Adjust plan"
)
```

If "Cherry-pick": ask user which tests to include.
If "Adjust plan": apply changes and re-present.
</step>

<step name="execute_tdd_generation">
For each approved TDD test:

1. **Create test file** following discovered project conventions (directory, naming, imports)

2. **Write test** with clear arrange/act/assert structure:
   ```
   // Arrange -- set up inputs and expected outputs
   // Act -- call the function under test
   // Assert -- verify the output matches expectations
   ```

3. **Run the test**:
   ```bash
   {discovered test command}
   ```

4. **Evaluate result:**
   - **Test passes**: Good -- the implementation satisfies the test. Verify the test checks meaningful behavior (not just that it compiles).
   - **Test fails with assertion error**: This may be a genuine bug discovered by the test. Flag it:
     ```
     WARNING: Potential bug found: {test name}
     Expected: {expected}
     Actual: {actual}
     File: {implementation file}
     Task: {task bead ID} -- Criteria: {acceptance criteria}
     ```
     Do NOT fix the implementation -- this is a test-generation command, not a fix command. Record the finding.
   - **Test fails with error (import, syntax, etc.)**: This is a test error. Fix the test and re-run.
</step>

<step name="execute_e2e_generation">
For each approved E2E test:

1. **Check for existing tests** covering the same scenario:
   ```bash
   grep -r "{scenario keyword}" {e2e test directory} 2>/dev/null
   ```
   If found, extend rather than duplicate.

2. **Create test file** targeting the user scenario from acceptance criteria

3. **Run the E2E test**:
   ```bash
   {discovered e2e command}
   ```

4. **Evaluate result:**
   - **GREEN (passes)**: Record success
   - **RED (fails)**: Determine if it's a test issue or a genuine application bug. Flag bugs:
     ```
     WARNING: E2E failure: {test name}
     Scenario: {description}
     Task: {task bead ID}
     Error: {error message}
     ```
   - **Cannot run**: Report blocker. Do NOT mark as complete.
     ```
     BLOCKED: E2E blocker: {reason tests cannot run}
     ```

**No-skip rule:** If E2E tests cannot execute (missing dependencies, environment issues), report the blocker and mark the test as incomplete. Never mark success without actually running the test.
</step>

<step name="summary_commit_and_update">
Create a test coverage report:

```
------------------------------------------------------------
 FORGE > TEST GENERATION COMPLETE
------------------------------------------------------------

## Results

| Category | Generated | Passing | Failing | Blocked |
|----------|-----------|---------|---------|---------|
| Unit     | {N}       | {n1}    | {n2}    | {n3}    |
| E2E      | {M}       | {m1}    | {m2}    | {m3}    |

## Acceptance Criteria Coverage
{for each task: task title -> criteria covered by tests -> gaps}

## Files Created/Modified
{list of test files with paths}

## Coverage Gaps
{areas that couldn't be tested and why}

## Bugs Discovered
{any assertion failures that indicate implementation bugs}
```

If there are passing tests to commit:

```bash
git add {test files}
git commit -m "test(phase-{N}): add tests from forge:add-tests"
```

Update task beads with test file references:
```bash
bd update <task-id> --notes="Tests added: <test-file-paths>"
# For each task with test coverage, add a comment
bd comments add <task-id> "Tests generated: {N} unit, {M} e2e -- {pass/fail summary}"
```

Present next steps:

```
---

## Next Up

{if bugs discovered:}
**Fix discovered bugs:** `/forge:quick fix the {N} test failures discovered in phase {phase_number}`

{if blocked tests:}
**Resolve test blockers:** {description of what's needed}

{otherwise:}
**All tests passing!** Phase {phase_number} is fully tested.

---

**Also available:**
- `/forge:add-tests {next_phase}` -- test another phase
- `/forge:verify {phase_number}` -- run UAT verification

---
```
</step>

</process>

<success_criteria>
- [ ] Phase resolved and tasks loaded with acceptance criteria
- [ ] All changed files classified into TDD/E2E/Skip categories
- [ ] Classification presented to user and approved
- [ ] Project test structure discovered (directories, conventions, runners)
- [ ] Test plan presented to user and approved (linked to acceptance criteria)
- [ ] TDD tests generated with arrange/act/assert structure
- [ ] E2E tests generated targeting user scenarios
- [ ] All tests executed -- no untested tests marked as passing
- [ ] Bugs discovered by tests flagged (not fixed)
- [ ] Test files committed with proper message
- [ ] Task beads updated with test file references
- [ ] Coverage gaps documented
- [ ] Next steps presented to user
</success_criteria>
