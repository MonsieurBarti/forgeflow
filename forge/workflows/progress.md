<purpose>
Display a rich progress dashboard for the current Forge project by querying the bead graph.
</purpose>

<process>

## 1. Find Project

```bash
PROJECT=$(node "$HOME/.claude/forge/bin/forge-tools.cjs" find-project)
```

If no project found, suggest `/forge:new`.

## 2. Load Full Context

```bash
PROGRESS=$(node "$HOME/.claude/forge/bin/forge-tools.cjs" progress <project-id>)
CONTEXT=$(node "$HOME/.claude/forge/bin/forge-tools.cjs" project-context <project-id>)
```

## 3. Display Dashboard

Format and display:

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
  [ ] Phase 7: Docs              (blocked by Phase 6)
  [ ] Phase 8: Polish            (blocked by Phase 7)

## Current Phase: Phase 4 - Frontend
  - [x] Set up React scaffold
  - [x] Create layout components
  - [>] Build dashboard page (in_progress)
  - [ ] Add authentication flow (blocked by dashboard)

## Requirements Coverage
  [x] 8/12 requirements have verified tasks
  [ ] 4 requirements pending: ...

## Recent Decisions
  - <from bd memories>
```

## 4. Suggest Next Action

Based on current state:
- Phase in progress with ready tasks -> `/forge:execute <phase>`
- Phase complete but not verified -> `/forge:verify <phase>`
- Phase verified, next phase unplanned -> `/forge:plan <next-phase>`
- All phases done -> "Project complete! Consider creating a new milestone."

</process>
