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

## 3. Research (Optional)

Spawn a forge-researcher agent to investigate the implementation approach:

```
Agent(subagent_type="forge-researcher", prompt="
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

Break the phase into 2-5 concrete tasks. For each task:

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

## 6. Verify Plan

Check coverage:
- Every task has acceptance_criteria
- Key requirements for this phase have at least one `validates` link
- Task dependency order makes sense

Present the plan to the user:
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
