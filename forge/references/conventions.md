# Forge Bead Conventions

This document defines how Forge uses beads to represent project management concepts.

## Labels

| Label | Applied To | Meaning |
|-------|-----------|---------|
| `forge:project` | Project epic | Top-level project container |
| `forge:phase` | Phase epic | A phase of work within the project |
| `forge:req` | Feature bead | A project requirement |
| `forge:task` | Task bead | An executable task within a phase |
| `forge:research` | Task bead | Research output for a phase |

## Bead Types

| Concept | issue_type | Parent | Key Fields |
|---------|-----------|--------|------------|
| Project | `epic` | none | description (vision), design (scope/constraints) |
| Requirement | `feature` | project epic | acceptance_criteria, priority |
| Phase | `epic` | project epic | description (goal), notes (approach) |
| Task | `task` | phase epic | description (what), acceptance_criteria (done when), estimated_minutes |
| Research | `task` | phase epic | notes (findings) |

## Dependency Patterns

### Phase Ordering
Phases are ordered via `blocks` dependencies:
```
phase-2 depends on phase-1 (blocks)
phase-3 depends on phase-2 (blocks)
```
This means `bd ready` naturally surfaces only unblocked phases.

### Requirement Traceability
Tasks link to the requirements they fulfill via `validates` dependencies:
```
task-1a validates req-1
task-2b validates req-1, req-3
```
This enables coverage checking: any requirement with no `validates` dep is uncovered.

### Task Dependencies Within a Phase
Tasks within a phase can depend on each other via `blocks`:
```
task-1b depends on task-1a (blocks)
```
This enables wave-based execution: wave 1 = tasks with no blockers, wave 2 = tasks blocked by wave 1, etc.

### Parent-Child Hierarchy
All beads are connected to their parent via `parent-child`:
```
phase-1 depends on project (parent-child)
task-1a depends on phase-1 (parent-child)
```

### Discovery Links
When work on one task reveals new work needed:
```
new-task depends on original-task (discovered-from)
```

## Status Flow

```
open -> in_progress -> closed
                    -> blocked (dependency-blocked, auto-detected by bd)
open -> deferred (explicitly deferred for later)
```

## Memories

Forge uses `bd remember` for persistent context:
- `forge:project:<id>:vision` -- Project vision statement
- `forge:project:<id>:decisions` -- Key architecture decisions
- `forge:phase:<id>:approach` -- Chosen implementation approach
- `forge:session:last-phase` -- Last active phase for resume

## Querying Patterns

```bash
# Find the project
bd list --label forge:project --json

# List all phases in order
bd children <project-id> --json | jq '[.[] | select(.labels | contains(["forge:phase"]))]'

# Get ready tasks in a phase
bd children <phase-id> --json | jq '[.[] | select(.status == "open")]'

# Check requirement coverage
bd list --label forge:req --json  # all requirements
bd dep list <req-id> --type validates  # tasks covering this req

# Get project progress
forge-tools progress <project-id>
```
