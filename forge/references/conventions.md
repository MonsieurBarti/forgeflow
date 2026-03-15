# Forge Bead Conventions

This document defines how Forge uses beads to represent project management concepts.

## Labels

| Label | Applied To | Meaning |
|-------|-----------|---------|
| `forge:project` | Project epic | Top-level project container |
| `forge:milestone` | Milestone epic | A milestone within the project (groups phases and requirements) |
| `forge:phase` | Phase epic | A phase of work within the project |
| `forge:req` | Feature bead | A project requirement |
| `forge:task` | Task bead | An executable task within a phase |
| `forge:research` | Task bead | Research output for a phase |
| `forge:quick` | Task bead | A quick task (ad-hoc, outside phase roadmap) |
| `forge:debug` | Task bead | Active debug session (via /forge:debug) |
| `forge:monorepo` | Monorepo epic | Top-level monorepo container (parent of child `forge:project` beads) |

## Bead Types

| Concept | issue_type | Parent | Key Fields |
|---------|-----------|--------|------------|
| Project | `epic` | none | description (vision), design (scope/constraints) |
| Milestone | `epic` | project epic | description (goal), design (audit results), notes (retrospective) |
| Requirement | `feature` | project or milestone epic | acceptance_criteria, priority |
| Phase | `epic` | project epic | description (goal), notes (approach) |
| Task | `task` | phase epic | description (what), acceptance_criteria (done when), estimated_minutes |
| Research | `task` | phase epic | notes (findings) |
| Debug Session | `task` | none | description (symptoms), notes (investigation state), design (resolution) |
| Monorepo | `epic` | none | description (vision), design (workspace_path mapping as YAML) |

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

### Monorepo Hierarchy
A `forge:monorepo` bead is the top-level parent for repositories containing multiple
applications or packages. Each application gets its own `forge:project` child bead.

```
monorepo-abc depends on nothing (top-level)
project-app1 depends on monorepo-abc (parent-child)
project-app2 depends on monorepo-abc (parent-child)
```

The monorepo bead's `design` field stores workspace paths as YAML, mapping each child
project to its directory within the repository:

```yaml
workspace_paths:
  <project-id>: packages/app1
  <project-id>: apps/backend
```

Each child `forge:project` bead operates normally (has its own phases, tasks, etc.) but
is scoped to its `workspace_path`. The monorepo bead itself has no phases or tasks --
it exists solely as a grouping parent.

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

Forge uses `bd remember` for persistent context. All keys are namespaced under `forge:` and
can be listed at any time with `bd memories forge:` or via `/forge:memories`.

### Project Memories (`forge:project:<id>:*`)

| Key | Written by | Content |
|-----|-----------|---------|
| `forge:project:<id>:vision` | `/forge:new` | Project vision statement |
| `forge:project:<id>:decisions` | workflows | Key architecture / design decisions |

### Milestone Memories (`forge:milestone:<id>:*`)

| Key | Written by | Content |
|-----|-----------|---------|
| `forge:milestone:<id>:goal` | `/forge:new-milestone` | Milestone goal statement |

### Phase Memories (`forge:phase:<id>:*`)

| Key | Written by | Content |
|-----|-----------|---------|
| `forge:phase:<id>:approach` | `/forge:plan` | Chosen implementation approach for the phase |
| `forge:phase:<id>:completed` | `/forge:verify` | ISO timestamp when phase was verified complete |

### Session Memories (`forge:session:*`)

Session memories persist the most recent active context so sessions can be resumed.

| Key | Written by | Content |
|-----|-----------|---------|
| `forge:session:project-id` | `/forge:new`, `/forge:resume` | ID of the active project |
| `forge:session:current-phase` | `/forge:execute`, `/forge:plan` | ID of the currently active phase |
| `forge:session:last-milestone` | `/forge:new-milestone`, `/forge:new` | ID of the most recently created/active milestone |
| `forge:session:notes` | `/forge:pause` | Free-form notes saved at pause time |

### Codebase Memories (`forge:codebase:*`)

Persisted by the `persist_intelligence` step in `/forge:map-codebase`. These provide fast
codebase context for agents without reading the full `.forge/codebase/` documents. Re-running
map-codebase overwrites all keys with fresh values.

| Key | Source Document | Content |
|-----|----------------|---------|
| `forge:codebase:stack` | `STACK.md` | Languages, runtime, frameworks, key dependencies |
| `forge:codebase:arch` | `ARCHITECTURE.md` | Architectural pattern, layers, data flow, entry points |
| `forge:codebase:commands` | `STACK.md` | Build, test, run, lint commands |
| `forge:codebase:conventions` | `CONVENTIONS.md` | Code style, naming conventions, error handling patterns |
| `forge:codebase:concerns` | `CONCERNS.md` | Top technical debt items, fragile areas |

### Memory Lifecycle

```bash
# Write a memory
bd remember --key "forge:phase:<id>:approach" "Two-wave implementation: ..."

# Read a specific memory
bd memories forge:phase:<id>:approach

# List all forge memories (all types)
bd memories forge:

# Remove a memory
bd forget forge:session:notes
```

Use `/forge:memories` to browse all stored memories grouped by type.

## Code Navigation

For AST-aware code navigation (symbol definitions, references, impact analysis), see
`forge/references/code-graph.md`. When `code-graph` is installed, agents MUST use it
for structural queries. When absent, agents silently fall back to Grep/Glob.

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
