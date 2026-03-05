<purpose>
Plan a specific phase of the project. Research the implementation approach, create task
beads with acceptance criteria, and link them to requirements for traceability.
</purpose>

<process>

## 1. Resolve Phase

If a phase number was given (e.g., "2"), find the matching phase bead:
```bash
PROJECT=$(node "$HOME/.claude/forge/bin/forge-tools.cjs" find-project)
```
Extract the project ID, then:
```bash
CONTEXT=$(node "$HOME/.claude/forge/bin/forge-tools.cjs" project-context <project-id>)
```
Match the phase number to the ordered list of phases.

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

Check if auto-research is enabled (default: true):
```bash
node "$HOME/.claude/forge/bin/forge-tools.cjs" config-get auto_research
```

If `forge.auto_research` is `false`, skip research and go to step 4.

Resolve the model for the researcher role:
```bash
MODEL=$(node "$HOME/.claude/forge/bin/forge-tools.cjs" model-for-role researcher <project-id>)
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

If the user prefers to skip research (e.g., they already know the approach), this step
can be skipped by passing `--no-research` or when the user says so.

## 4. Discuss Approach with User

Present the research findings (if any) and the phase goal.
Ask the user:
1. Any preferences for implementation approach?
2. Any constraints or decisions to lock in?
3. Estimated number of tasks (suggest 2-5)?

Save decisions:
```bash
bd remember "forge:phase:<id>:approach <chosen approach>"
bd update <phase-id> --notes="Approach: <summary of decisions>"
```

## 5. Create Task Beads

Resolve the model for the planner role:
```bash
MODEL=$(node "$HOME/.claude/forge/bin/forge-tools.cjs" model-for-role planner <project-id>)
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

Resolve the model for the plan_checker role:
```bash
MODEL=$(node "$HOME/.claude/forge/bin/forge-tools.cjs" model-for-role plan_checker <project-id>)
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

Produce a PASS or NEEDS REVISION verdict.
")
```

**If NEEDS REVISION:** Fix the flagged issues (update acceptance criteria, add missing
validates links, resize tasks, fix deps), then re-run the plan-checker. Repeat until PASS.

**If PASS:** Present the verified plan to the user:
```bash
PHASE=$(node "$HOME/.claude/forge/bin/forge-tools.cjs" phase-context <phase-id>)
```

Show: tasks, their acceptance criteria, requirement links, and execution order (waves).

## 7. Mark Phase as Planned

```bash
bd update <phase-id> --status=in_progress
bd remember "forge:session:current-phase <phase-id>"
```

Suggest next step: `/forge:execute <phase-number>` or `/forge:plan <next-phase>`.

</process>
