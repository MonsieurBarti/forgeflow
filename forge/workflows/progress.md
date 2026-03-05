<purpose>
Display a rich progress dashboard for the current Forge project by querying the bead graph.
</purpose>

<process>

## 1. Find Project

```bash
PROJECT=$(node "$HOME/.claude/forge/bin/forge-tools.cjs" find-project)
```

If no project found, suggest `/forge:new`.

## 2. Load Full Progress

Use the comprehensive progress command that returns per-phase task details,
requirement coverage, and recent decisions in one call:

```bash
node "$HOME/.claude/forge/bin/forge-tools.cjs" full-progress <project-id>
```

## 3. Display Dashboard

Format the JSON response as a rich dashboard:

```
# <Project Name>

## Progress: [=========>          ] 37% (3/8 phases)

## Phases
  [x] Phase 1: Foundation        (4/4 tasks done)
  [x] Phase 2: Core API          (3/3 tasks done)
  [x] Phase 3: Auth Layer        (5/5 tasks done)
  [>] Phase 4: Frontend          (2/4 tasks done, 1 in progress)
  [ ] Phase 5: Testing           (blocked by Phase 4)
  [ ] Phase 6: Deployment        (blocked by Phase 5)

## Current Phase: Phase 4 - Frontend
  - [x] Set up React scaffold
  - [x] Create layout components
  - [>] Build dashboard page (in_progress)
  - [ ] Add authentication flow

## Requirements Coverage
  [x] 8/12 requirements have verified tasks
  [ ] 4 requirements pending: ...

## Recent Decisions
  - <from bd memories>
```

Use the `phases` array from the response to build per-phase task listings.
Use the `requirements` object to show coverage.
Use the `memories` field for recent decisions.

## 4. Suggest Next Action

Based on `current_phase` status and task states:
- Phase in progress with open tasks -> `/forge:execute <phase>`
- All phase tasks closed but phase not verified -> `/forge:verify <phase>`
- Phase closed/verified, next phase has no tasks -> `/forge:plan <next-phase>`
- All phases done -> "Project complete! Consider creating a new milestone."

</process>
