---
name: forge:list-phase-assumptions
description: Surface Claude's assumptions about a phase approach before planning
argument-hint: "<phase-number-or-id>"
allowed-tools:
  - Read
  - Bash
  - Grep
  - Glob
  - AskUserQuestion
---

<objective>
Analyze a phase and surface Claude's assumptions about technical approach, implementation order,
scope boundaries, risk areas, and dependencies -- BEFORE planning begins.

Purpose: Help users see what Claude thinks before committing to a plan. Enables course correction
early when assumptions are wrong.

Key difference from forge:discuss-phase: This is ANALYSIS of what Claude thinks, not INTAKE of
what the user knows. Lightweight -- no agent spawn, no file creation, purely conversational.

Output: Assumptions presented conversationally. User corrections stored on the phase bead notes
(consumed by forge:plan).
</objective>

<context>
Read the Forge conventions: @~/.claude/forge/references/conventions.md
</context>

<execution_context>
Execute the list-phase-assumptions workflow from @~/.claude/forge/workflows/list-phase-assumptions.md end-to-end.

Phase argument: $ARGUMENTS (phase number or bead ID, required).

Phase is resolved via `forge-tools.cjs` commands:
```bash
node "$HOME/.claude/forge/bin/forge-tools.cjs" find-project
node "$HOME/.claude/forge/bin/forge-tools.cjs" project-context <project-id>
```

User corrections are stored on the phase bead via `bd update <phase-id> --notes`.
</execution_context>

<process>
1. Validate phase argument (error if missing or not found)
2. Load project context and phase details from beads
3. Analyze phase -- surface assumptions across five areas
4. Present assumptions with confidence levels
5. Prompt "What do you think?" and gather feedback
6. Store corrections on phase bead (if any)
7. Offer next steps (discuss context, plan phase, or re-examine)
</process>

<success_criteria>
- Phase validated against project
- Assumptions surfaced across five areas: technical approach, implementation order, scope, risks, dependencies
- Confidence levels marked where appropriate
- User prompted for feedback
- Corrections stored on phase bead for downstream consumption
- User knows next steps
</success_criteria>
