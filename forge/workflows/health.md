<purpose>
Diagnose the health of a Forge project. Forge is beads-native: persistent state lives in bd, config lives in YAML settings files (.forge/settings.yaml), and installation files live in ~/.claude/forge/. This workflow checks all three layers.
</purpose>

<process>

## 1. Find Project

```bash
PROJECT=$(node "$HOME/.claude/forge/bin/forge-tools.cjs" find-project)
```

If no project found, report "No Forge project found" and suggest `/forge:new`.

## 2. Run Diagnostics

```bash
HEALTH=$(node "$HOME/.claude/forge/bin/forge-tools.cjs" health <project-id>)
```

This performs the following checks:

### Structural Checks
- **Project label**: Project epic has `forge:project` label
- **Phase labels**: All phase epics have `forge:phase` label
- **Task labels**: All tasks have `forge:task` label
- **Parent links**: All phases are children of the project; all tasks are children of a phase

### Dependency Checks
- **Phase ordering**: Phases form a valid linear chain via `blocks` deps (no cycles, no gaps)
- **Orphaned phases**: Phases with no `blocks` relationship (disconnected from ordering)
- **Requirement coverage**: All `forge:req` beads have at least one `validates` dep from a task

### State Checks
- **Stale in-progress**: Tasks marked `in_progress` with no updates in 7+ days
- **Closed phase with open tasks**: Phase marked `closed` but has unclosed children
- **Open phase with all tasks closed**: Phase should be closeable

### Config Checks (.forge/settings.yaml)
- **Config validity**: All `forge.*` keys in settings.yaml have valid values
- **Known keys**: `forge.context_warning`, `forge.context_critical` are numeric 0-1
- **Known keys**: `forge.update_check`, `forge.auto_research` are boolean strings

### Installation Checks (~/.claude/forge/)
- **forge-tools.cjs**: Exists at `~/.claude/forge/bin/forge-tools.cjs`
- **Workflows**: All expected workflow files exist
- **Version file**: `~/.claude/forge/.forge-version` exists and is valid JSON

## 3. Display Report

Format and display:

```
# Forge Health Report

## Project: <name> (<id>)

### Structure
  [ok] Project label present
  [ok] 6/6 phases labeled
  [!!] 2 tasks missing forge:task label: <ids>
  [ok] All parent links valid

### Dependencies
  [ok] Phase chain valid (1 -> 2 -> 3 -> 4 -> 5 -> 6)
  [!!] 1 orphaned phase: <id> (no ordering deps)
  [ok] 8/8 requirements covered

### State
  [ok] No stale in-progress tasks
  [!!] Phase 3 closed but has 1 open task: <id>
  [--] Phase 4 has all tasks closed (suggest: close phase or verify)

### Config (.forge/settings.yaml)
  [ok] All forge.* config values valid
  [--] forge.context_warning not set (using default: 0.35)

### Installation (~/.claude/forge/)
  [ok] forge-tools.cjs found
  [ok] All workflows present
  [ok] Version file valid (v0.1.0)

## Summary: 2 errors, 1 warning, 1 suggestion
```

Severity levels:
- `[ok]` -- Healthy
- `[!!]` -- Error (should be fixed)
- `[--]` -- Warning/suggestion (optional fix)

## 4. Offer Repairs (if --fix or user requests)

For fixable issues, apply repairs:
- **Missing labels**: `bd update <id> --add-label <label>`
- **Closeable phases**: `bd close <phase-id>` (with user confirmation)
- **Stale in-progress**: Report to user for manual triage

For non-fixable issues, explain what needs manual attention.

## 5. Summary

Show final counts:
- Issues found / fixed / remaining
- Suggest next action based on project state

</process>
