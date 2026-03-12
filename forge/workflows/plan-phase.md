<purpose>
Plan a specific phase of the project. Research the implementation approach, create task
beads with acceptance criteria, and link them to requirements for traceability.
</purpose>

<process>

## 1. Resolve Phase

If a phase number was given (e.g., "2"), find the exact matching phase bead:
```bash
PROJECT=$(node "$HOME/.claude/forge/bin/forge-tools.cjs" find-project)
```
Extract the project ID, then use `resolve-phase` to do an **exact** numeric match
against `forge:phase`-labeled epics only (prevents phase 7 from matching phase 17):
```bash
PHASE=$(node "$HOME/.claude/forge/bin/forge-tools.cjs" resolve-phase <project-id> <phase-number>)
```
Parse `phase.id` from the result. If `found` is false, report the available phases and stop.

If a phase ID was given directly, use it.

If nothing was given, find the first unplanned phase (open, no children).

## 2. Check Prerequisites

Verify the phase is ready to plan:
- Status should be `open` (not already in_progress or closed)
- All blocking phases should be `closed`

```bash
bd show <phase-id> --json
```

If blocked, show what's blocking and suggest working on that first.

## 3. Research

Skip this step and go to step 4 if any of the following is true:
- The `--skip-research` flag was passed by the user.
- `forge.auto_research` is `false`:

```bash
node "$HOME/.claude/forge/bin/forge-tools.cjs" config-get auto_research
```

Resolve the model for the researcher agent:
```bash
MODEL=$(node "$HOME/.claude/forge/bin/forge-tools.cjs" resolve-model forge-researcher --raw)
```

Otherwise, spawn a **forge-researcher** agent to investigate the implementation approach:

```
Agent(subagent_type="forge-researcher", model="<resolved model or omit if null>", prompt="
Research how to implement this phase:

Phase: <phase title>
Goal: <phase description>
Project context: <project vision, relevant requirements>
Codebase: Read the current codebase to understand existing patterns.

Produce a concise research summary covering:
1. Recommended approach
2. Key patterns/libraries to use
3. Potential pitfalls
4. Estimated complexity

Write your findings as a comment on the phase bead:
bd comments add <phase-id> '<findings>'
")
```

## 4. Context Check and Approach Discussion

Check whether the phase already has context notes:

```bash
bd show <phase-id> --json
```

Inspect the `notes` field.

**If notes already exist:** Skip the inline discuss and proceed directly to step 5. The
existing notes contain sufficient context for planning. Briefly acknowledge what context is
present (e.g., "Phase notes found -- proceeding with existing context.").

**If notes are empty or absent:** Run the following condensed inline discuss before
proceeding to step 5.

---

### Inline Discuss (runs only when no prior notes exist)

The goal is to capture a goal statement and key decisions so downstream planning is
grounded. This is intentionally lightweight -- not the full discuss-phase workflow.

**Step A: Scout codebase quickly**

Check whether relevant code exists to inform options:
```bash
ls src/ app/ lib/ 2>/dev/null | head -20
```

Read 1-2 of the most relevant existing files if they exist.

**Step B: Identify 2-3 gray areas**

From the phase description and any codebase context, identify the 2-3 implementation
decisions that most affect what gets built. Think: what would change the outcome if decided
differently? These are phase-specific, not generic categories.

Examples:
- "User authentication" -> Session handling, Error responses, Recovery flow
- "CLI for backups" -> Output format, Progress reporting, Error recovery

**Step C: Present and discuss with user**

Present the phase domain clearly:
```
Phase [X]: [Name]
Goal: [What this phase delivers]

I need a few quick decisions to guide planning.
```

Use AskUserQuestion (multiSelect: true) to let the user pick which gray areas to discuss:
- header: "Quick decisions"
- question: "Which areas need clarification for [phase name]?"
- options: the 2-3 gray areas identified above

For each selected area, ask 1-2 focused questions using AskUserQuestion:
- header: "[Area]" (max 12 chars)
- question: Specific decision
- options: 2-3 concrete choices (include "You decide" when reasonable)

Keep total questions to 4-6 across all areas. This is a brief alignment pass, not a full
discussion session.

**Step D: Store results as phase notes**

After the brief discussion, write structured notes to the phase bead:

```bash
bd update <phase-id> --notes="## Goal

[One sentence: what this phase delivers and why it matters]

## Key Decisions

- [Area]: [Decision captured]
- [Area]: [Decision captured]

## Claude's Discretion

[Areas where user said 'you decide' or no strong preference expressed]"
```

---

Continue to step 5 (Create Task Beads) with the notes now populated.

## 5. Create Task Beads

Resolve the model for the planner agent:
```bash
MODEL=$(node "$HOME/.claude/forge/bin/forge-tools.cjs" resolve-model forge-planner --raw)
```

Spawn a **forge-planner** agent to break the phase into tasks:

```
Agent(subagent_type="forge-planner", model="<resolved model or omit if null>", prompt="
Break this phase into 2-5 concrete tasks:

Phase: <phase title> (<phase-id>)
Goal: <phase description>
Project: <project-id>
Research findings: <findings from step 3, if any>
User decisions: <approach decisions from step 4>
Requirements addressed by this phase: <relevant requirement IDs and titles>

For each task:
1. Create the task bead with acceptance_criteria
2. Add parent-child dep to the phase
3. Add forge:task label
4. Add validates dep to requirements it fulfills
5. Add inter-task dependencies if needed
")
```

If you prefer to create tasks directly (small phase, clear scope), do so manually:

```bash
bd create --title="<task title>" \
  --description="<what to implement>" \
  --acceptance_criteria="<specific, testable criteria>" \
  --type=task --priority=2 --json
bd dep add <task-id> <phase-id> --type=parent-child
bd label add <task-id> forge:task
```

Link tasks to requirements they fulfill:
```bash
bd dep add <task-id> <req-id> --type=validates
```

Add dependencies between tasks if needed:
```bash
bd dep add <task-b-id> <task-a-id>  # task B depends on task A
```

## 6. Verify Plan (Plan Verification Loop)

Run automated checks first:
```bash
CHECK=$(node "$HOME/.claude/forge/bin/forge-tools.cjs" plan-check <phase-id>)
```

Resolve the model for the plan-checker agent:
```bash
MODEL=$(node "$HOME/.claude/forge/bin/forge-tools.cjs" resolve-model forge-plan-checker --raw)
```

Then spawn a **forge-plan-checker** agent for thorough validation:

```
Agent(subagent_type="forge-plan-checker", model="<resolved model or omit if null>", prompt="
Verify the plan for this phase:

Phase ID: <phase-id>
Project ID: <project-id>

Check:
1. Every task has specific, testable acceptance criteria
2. Requirements addressed by this phase have validates links
3. Tasks are appropriately sized (completable in one session)
4. Dependencies are correct (no cycles, proper parent-child links)
5. All tasks have forge:task label

Run: node $HOME/.claude/forge/bin/forge-tools.cjs plan-check <phase-id>
for automated coverage data.

Produce an APPROVED or NEEDS REVISION verdict as structured JSON:
{
  "verdict": "APPROVED" | "NEEDS REVISION",
  "findings": [
    { "number": 1, "severity": "blocker"|"suggestion", "description": "...", "fix": "exact command or action" }
  ]
}
NEEDS REVISION MUST include at least one finding with severity=blocker.
APPROVED may only contain findings with severity=suggestion.
")
```

**If NEEDS REVISION:** Fix each blocker finding using its `fix` command, then re-run the
plan-checker. Repeat until APPROVED.

**If APPROVED:** Present the verified plan to the user:
```bash
PHASE=$(node "$HOME/.claude/forge/bin/forge-tools.cjs" phase-context <phase-id>)
```

Show: tasks, their acceptance criteria, requirement links, and execution order (waves).

## 7. Mark Phase as Planned

```bash
bd update <phase-id> --status=in_progress
```

Suggest next step: `/forge:execute <phase-number>` or `/forge:plan <next-phase>`.

</process>
