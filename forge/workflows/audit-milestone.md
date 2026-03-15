<purpose>
Verify a milestone achieved its definition of done by checking requirement coverage via
validates dependencies, aggregating phase task status, and assessing cross-phase integration.
All data comes from the bead graph -- no file-based verification needed.
</purpose>

<process>

## 1. Find Project and Milestone

```bash
PROJECT=$(node "$HOME/.claude/forge/bin/forge-tools.cjs" find-project)
```

If no project found, report "No Forge project found" and suggest `/forge:new`. Stop.

Extract the project ID.

If a milestone ID was given as argument, use it directly.

Otherwise, find the active milestone:
```bash
node "$HOME/.claude/forge/bin/forge-tools.cjs" milestone-list <project-id>
```

Select the most recent open or in_progress milestone.

## 2. Load Milestone Context

Get full audit data in a single call:
```bash
node "$HOME/.claude/forge/bin/forge-tools.cjs" milestone-audit <milestone-id>
```

This returns:
- `milestone`: milestone bead details
- `phases`: all phases with status and task counts
- `requirements`: all requirements with validates coverage
- `uncovered_requirements`: requirements with no validating tasks
- `phase_health`: per-phase breakdown of open/closed/total tasks

## 3. Spawn Integration Checker

If the milestone has multiple phases, check cross-phase integration.

Resolve the model:
```bash
MODEL=$(node "$HOME/.claude/forge/bin/forge-tools.cjs" resolve-model forge-verifier --raw)
```

Spawn a **forge-verifier** agent (with `model` if non-empty) to check:
- Cross-phase dependencies are wired correctly
- Tasks in later phases that depend on earlier phase outputs
- No orphan tasks referencing non-existent dependencies
- End-to-end user flows that span multiple phases

Provide the agent with:
- Phase list with their tasks and descriptions
- Requirement list with assigned phases
- Codebase context if available

## 4. Check Requirements Coverage

Requirements are owned by phases, not the milestone directly. The milestone-audit tool
(step 2) traverses milestone -> phases -> phase children to find all forge:req beads.
Use the `requirements` and `uncovered_requirements` fields from the audit data.

For each requirement found via the phase traversal:

```bash
bd dep list <req-id> --type validates --json
```

Classify each requirement:
- **Satisfied**: At least one closed task validates it
- **Partial**: Task validates it but task is still open
- **Unsatisfied**: No tasks validate it at all

**FAIL Gate**: Any unsatisfied requirement forces `gaps_found` status on the audit.

## 5. Aggregate Results

Combine:
- Requirement coverage (from step 4)
- Phase completion status (from step 2)
- Integration checker findings (from step 3)

Determine overall status:
- `passed` -- all requirements satisfied, all phases complete, integration clean
- `gaps_found` -- unsatisfied requirements or critical integration issues
- `tech_debt` -- all requirements met but integration issues or incomplete tasks

## 6. Store Audit Results

Store structured audit results in the milestone bead:

```bash
bd update <milestone-id> --design="Audit Results:

status: <passed|gaps_found|tech_debt>
audited: <timestamp>

Requirements: <N/M> satisfied
Phases: <N/M> complete
Integration: <clean|issues_found>

Unsatisfied Requirements:
<for each unsatisfied req:>
- <req-id>: <title> (assigned to Phase <N>)

Integration Issues:
<for each issue:>
- <description>

Tech Debt:
<for each item:>
- Phase <N>: <description>"
```

## 7. Present Results

Route by status:

**If passed:**
```
# Milestone Audit: PASSED

**<milestone name>**
Requirements: N/M satisfied
Phases: N/N complete
Integration: Clean

All requirements covered. Cross-phase integration verified.

---

Next: /forge:complete-milestone -- archive and close milestone
```

**If gaps_found:**
```
# Milestone Audit: GAPS FOUND

**<milestone name>**
Requirements: N/M satisfied
Phases: N/M complete

## Unsatisfied Requirements
- <req-title> (<req-id>) -- <reason>

## Integration Issues
- <issue description>

---

Next: /forge:plan-milestone-gaps -- create phases to close gaps
Also: /forge:complete-milestone -- proceed anyway (accept gaps as tech debt)
```

**If tech_debt:**
```
# Milestone Audit: TECH DEBT

**<milestone name>**
Requirements: N/M satisfied (all met)
Phases: N/M complete

All requirements met. Accumulated tech debt needs review:
- Phase N: <item>
- Phase M: <item>

---

Options:
A. /forge:complete-milestone -- accept debt, close milestone
B. /forge:plan-milestone-gaps -- address debt before completing
```

</process>

<success_criteria>
- [ ] Project and milestone identified
- [ ] Milestone context loaded (phases, requirements, tasks)
- [ ] Integration checker spawned for multi-phase milestones
- [ ] Requirement coverage checked via validates dependencies
- [ ] FAIL gate enforced -- unsatisfied requirements force gaps_found
- [ ] Audit results stored in milestone bead design field
- [ ] Results presented with actionable routing based on status
</success_criteria>
