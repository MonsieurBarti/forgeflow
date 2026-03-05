---
name: forge:progress
description: Show project progress dashboard from bead graph
argument-hint: ""
allowed-tools: Read, Bash, Grep, Glob
---

<objective>
Display a rich progress dashboard for the current Forge project by querying the bead graph. Show phase completion, per-phase task breakdowns, requirement coverage, blockers, and next steps.
</objective>

<context>
Read the Forge conventions: @~/.claude/forge/references/conventions.md
</context>

<execution_context>
Execute the progress workflow from @~/.claude/forge/workflows/progress.md end-to-end.

When loading progress (step 2), use the comprehensive progress command:
```bash
node "$HOME/.claude/forge/bin/forge-tools.cjs" full-progress <project-id>
```

This returns per-phase task breakdowns, requirement coverage, and recent decisions
in a single call. Format the output as a rich dashboard with progress bars and
status indicators.

Suggest the appropriate next action based on current state:
- Phase in progress with ready tasks -> `/forge:execute <phase>`
- Phase complete but not verified -> `/forge:verify <phase>`
- Phase verified, next phase unplanned -> `/forge:plan <next-phase>`
- All phases done -> "Project complete!"
</execution_context>
