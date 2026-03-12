<purpose>
Research how to implement a phase. Spawns forge-researcher with phase context to investigate
the domain before planning begins. Creates a research bead with findings.
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

## 2. Check Existing Research

Look for an existing research bead under the phase:
```bash
bd children <phase-id> --json | jq '[.[] | select(.labels | contains(["forge:research"]))]'
```

**If research bead exists:** Offer the user three options:
1. **Update** -- re-run research and update the existing bead
2. **View** -- display existing findings
3. **Cancel** -- skip research

**If no research bead exists:** Continue to step 3.

## 3. Gather Phase Context

Load the project and phase context:
```bash
PROJECT=$(node "$HOME/.claude/forge/bin/forge-tools.cjs" find-project)
CONTEXT=$(node "$HOME/.claude/forge/bin/forge-tools.cjs" project-context <project-id>)
PHASE=$(bd show <phase-id> --json)
```

Present a brief summary:
- Phase title and goal
- Relevant requirements
- What the researcher will investigate

## 4. Spawn Researcher

Resolve the model for the researcher agent:
```bash
MODEL=$(node "$HOME/.claude/forge/bin/forge-tools.cjs" resolve-model forge-researcher --raw)
```

Spawn a **forge-researcher** agent:

```
Agent(subagent_type="forge-researcher", model="<resolved model or omit if null>", prompt="
Research how to implement this phase:

Phase: <phase title> (<phase-id>)
Goal: <phase description>
Project context: <project vision, relevant requirements>
Codebase: Read the current codebase to understand existing patterns.

Go beyond 'which library' to discover ecosystem knowledge:
1. What's the established architecture pattern for this domain?
2. What libraries form the standard stack?
3. What problems do people commonly hit?
4. What should NOT be hand-rolled?
5. What's current best practice vs what may be outdated?

Produce a concise research summary covering:
- **Recommended approach** -- how to implement this
- **Standard stack** -- libraries and tools to use
- **Architecture patterns** -- established patterns for this domain
- **Don't hand-roll** -- things that should use existing solutions
- **Common pitfalls** -- mistakes and gotchas to avoid
- **Complexity estimate** -- simple/medium/complex with reasoning

Write your findings as a structured JSON context comment on the phase bead using context-write:
node "$HOME/.claude/forge/bin/forge-tools.cjs" context-write <phase-id> '{
  "agent": "forge-researcher",
  "status": "completed",
  "findings": [
    "Recommended approach: <how to implement this>",
    "Standard stack: <libraries and tools to use>",
    "Architecture patterns: <established patterns for this domain>",
    "Do not hand-roll: <things that should use existing solutions>",
    "Common pitfalls: <mistakes and gotchas to avoid>"
  ],
  "decisions": [
    "Complexity estimate: <simple|medium|complex> — <reasoning>"
  ]
}'
")
```

## 5. Handle Return and Create Research Bead

**If researcher completed successfully:**

Create (or update) a research bead under the phase:
```bash
# Create research bead
bd create --title="Research: <phase title>" \
  --description="Research findings for phase implementation" \
  --notes="<researcher findings>" \
  --type=task --priority=2 --json
bd dep add <research-id> <phase-id> --type=parent-child
bd label add <research-id> forge:research
bd close <research-id> --reason="Research complete"
```

If updating an existing research bead:
```bash
bd update <research-id> --notes="<updated findings>"
```

Present findings to the user and suggest next steps:
- `/forge:plan <phase>` to plan the phase using the research
- Re-research with different focus if findings are insufficient

**If researcher returned incomplete results:**

Show what was attempted. Offer:
1. Re-run with additional context
2. Manual research
3. Proceed to planning anyway

</process>
