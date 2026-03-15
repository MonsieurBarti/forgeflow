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
Extract the project ID, then use `resolve-phase` for an **exact** numeric match
against `forge:phase`-labeled epics only:
```bash
PHASE=$(node "$HOME/.claude/forge/bin/forge-tools.cjs" resolve-phase <project-id> <phase-number>)
```
Parse `phase.id` from the result. If `found` is false, report available phases and stop.

If a phase ID was given directly, use it. If nothing was given, find the first unplanned phase (open, no children).

## 2. Check Prerequisites

Verify the phase is ready to plan:
- Status should be `open` (not already in_progress or closed)
- All blocking phases should be `closed`

```bash
bd show <phase-id> --json
```

If blocked, show what's blocking and suggest working on that first.

## 2.5. Fetch Phase Requirements and Cross-Phase Visibility

Fetch requirements owned by this phase (forge:req beads that are children of the phase):
```bash
bd children <phase-id> --json
```

Filter for beads with `forge:req` label. Store as `PHASE_REQS` (list of id, title, description).

For cross-phase visibility, find sibling phases and their requirements:
```bash
bd dep list <phase-id> --direction=up --type=parent-child --json
```

Inspect results for any parent bead with `forge:milestone` label. If a milestone is found, get all its phases:
```bash
bd children <milestone-id> --json
```

Filter for `forge:phase` beads (excluding the current phase). For each sibling phase, fetch its requirements:
```bash
bd children <sibling-phase-id> --json
```

Filter for `forge:req` label. Store as `SIBLING_REQS` (list of id, title, description, owning phase). This gives cross-phase visibility so the planner can wire `validates` dependencies for requirements owned by other phases when tasks in this phase also contribute to them.

If no milestone found, set `SIBLING_REQS` to empty.

## 3. Research

Skip this step if `--skip-research` was passed or `forge.auto_research` is `false`:
```bash
node "$HOME/.claude/forge/bin/forge-tools.cjs" config-get auto_research
```

Resolve the model for the researcher agent:
```bash
MODEL=$(node "$HOME/.claude/forge/bin/forge-tools.cjs" resolve-model forge-researcher --raw)
```

Query retrospective data from past phases:
```bash
RETRO=$(node "$HOME/.claude/forge/bin/forge-tools.cjs" retro-query <project-id>)
```

Parse JSON. If the command fails or `phase_count` is 0, set `RETRO_SECTION` to empty. Otherwise build `RETRO_SECTION`:

```
Retrospective data from <phase_count> past phase(s):

Lessons learned:
- [<phase_title>] <lesson>

Pitfall warnings:
- [<phase_title>] <pitfall>

Effectiveness summary:
- <phase_title>: rated <rating>/5 -- <findings> (<blockers> blocker(s))
```

Omit any sub-section whose source is empty. If all empty, set `RETRO_SECTION` to empty.

Spawn a **forge-researcher** agent:

```
Agent(subagent_type="forge-researcher", model="<resolved model or omit if null>", prompt="
Research how to implement this phase:

Phase: <phase title>
Goal: <phase description>
Project context: <project vision, relevant requirements>
Codebase: Read the current codebase to understand existing patterns.

<if RETRO_SECTION is non-empty, include it here verbatim>

Produce a concise research summary covering:
1. Recommended approach
2. Key patterns/libraries to use
3. Potential pitfalls (check retrospective data above for known issues)
4. Estimated complexity

Write your findings as a structured JSON context comment on the phase bead:
node \"$HOME/.claude/forge/bin/forge-tools.cjs\" context-write <phase-id> '{
  \"agent\": \"forge-researcher\",
  \"status\": \"completed\",
  \"findings\": [
    \"Recommended approach: <how to implement this>\",
    \"Standard stack: <libraries and tools to use>\",
    \"Architecture patterns: <established patterns for this domain>\",
    \"Common pitfalls: <mistakes and gotchas to avoid>\"
  ],
  \"decisions\": [
    \"Complexity estimate: <simple|medium|complex> -- <reasoning>\"
  ]
}'
")
```

Read back structured context:
```bash
RESEARCH_CTX=$(node "$HOME/.claude/forge/bin/forge-tools.cjs" context-read <phase-id>)
```

Parse JSON: find latest entry with `agent == "forge-researcher"` and `status == "completed"`. Extract `findings` and `decisions` arrays as bullet lists.

**Backward compatibility:** If `context-read` returns no structured entries, fall back to:
```bash
bd comments <phase-id>
```
Use most recent comment text as research findings.

## 4. Context Check and Approach Discussion

```bash
bd show <phase-id> --json
```

**If notes exist:** Skip inline discuss, proceed to step 5. Acknowledge: "Phase notes found -- proceeding with existing context."

**If notes are empty:** Run condensed inline discuss:

### Inline Discuss (runs only when no prior notes exist)

**Step A: Scout codebase quickly**
```bash
ls src/ app/ lib/ 2>/dev/null | head -20
```
Read 1-2 most relevant existing files if they exist.

**Step B: Identify 2-3 specific gray areas**

From the phase description and codebase context, identify the 2-3 decisions that most affect what gets built. Must be **phase-specific and concrete** -- not generic labels.

Examples:
- "User authentication" -> "Session handling: cookie vs JWT?" / "Recovery: email link or SMS?"
- "CLI for backups" -> "Output format: JSON, table, or plain text?" / "On error: abort-all or skip-and-continue?"

**Step C: Present and discuss with user**

State the phase goal, then use AskUserQuestion (multiSelect: true):
- header: "Quick decisions"
- question: "Which of these need your input for [phase name]?"
- options: the 2-3 specific gray areas phrased as concrete questions

For each selected area, ask 1-2 focused follow-ups with concrete, named choices. Include "You decide" for low-stakes choices. Keep total questions to 4-6.

**Step D: Store results as phase notes**
```bash
bd update <phase-id> --notes="## Goal

[One sentence: what this phase delivers and why]

## Key Decisions

- [Area]: [Decision captured]

## Claude's Discretion

[Areas where user said 'you decide']"
```

## 5. Create Task Beads

Resolve the model:
```bash
MODEL=$(node "$HOME/.claude/forge/bin/forge-tools.cjs" resolve-model forge-planner --raw)
```

Spawn a **forge-planner** agent:

```
Agent(subagent_type="forge-planner", model="<resolved model or omit if null>", prompt="
Break this phase into 2-5 concrete tasks:

Phase: <phase title> (<phase-id>)
Goal: <phase description>
Project: <project-id>
Research findings: <findings from step 3; omit if no research>
Complexity estimate: <from structured context if available>
User decisions: <approach decisions from step 4>
Retrospective insights: <if RETRO_SECTION non-empty; otherwise omit>
Requirements addressed by this phase: <relevant requirement IDs and titles>

<if PHASE_REQS is non-empty>
Phase Requirements (forge:req beads this phase owns and must deliver):
<for each req in PHASE_REQS:>
- <req-id>: <req-title> -- <req-description if present>

When creating tasks, wire validates dependencies for applicable requirements:
  bd dep add <task-id> <req-id> --type=validates
Do this for every task that directly implements or verifies a requirement.
A single task may validate multiple requirements; a requirement may be validated by multiple
tasks. When in doubt, prefer to add the link.
</end phase reqs section>

<if SIBLING_REQS is non-empty>
Cross-Phase Requirements (forge:req beads owned by sibling phases, for reference):
<for each req in SIBLING_REQS:>
- <req-id>: <req-title> (owned by <owning-phase-id>)

If any task in this phase also contributes to a sibling phase's requirement, wire a validates
dependency to it. This provides cross-phase traceability.
</end sibling reqs section>

For each task, determine:
- files_affected: list of file paths that will be created or modified
- approach: 1-2 sentence implementation summary
- complexity: simple | medium | complex

Then create the task:
1. Create the task bead with acceptance_criteria and --design containing JSON:
   bd create --title=\"<title>\" --description=\"<what>\" --acceptance=\"<criteria>\" \
     --design='{\"files_affected\":[\"path/to/file.ts\"],\"approach\":\"<summary>\",\"complexity\":\"<simple|medium|complex>\"}' \
     --type=task --priority=2 --json
2. Add parent-child dep to the phase
3. Add forge:task label
4. Add validates dep to requirements it fulfills
5. Add intra-phase dependencies ONLY when strictly necessary -- when task B cannot start until it has the concrete output produced by task A. Independent tasks should have NO inter-task dependency.
")
```

If creating tasks directly (small phase, clear scope):
```bash
bd create --title="<task title>" \
  --description="<what to implement>" \
  --acceptance="<specific, testable criteria>" \
  --design='{"files_affected":["path/to/file.ts"],"approach":"<1-2 sentence summary>","complexity":"<simple|medium|complex>"}' \
  --type=task --priority=2 --json
bd dep add <task-id> <phase-id> --type=parent-child
bd label add <task-id> forge:task
bd dep add <task-id> <req-id> --type=validates
```

Add intra-phase dependencies ONLY when task B truly needs task A's output:
```bash
bd dep add <task-b-id> <task-a-id>
```

## 5.5. Architect Review (Advisory)

This step is **advisory and non-blocking**. The workflow proceeds to plan verification regardless of the architect's findings or any failure in this step.

Resolve the model for the architect agent:
```bash
MODEL=$(node "$HOME/.claude/forge/bin/forge-tools.cjs" resolve-model forge-architect --raw)
```

Spawn a **forge-architect** agent:

```
Agent(subagent_type="forge-architect", model="<resolved model or omit if null>", prompt="
Review the proposed tasks for architectural adherence:

Phase: <phase title> (<phase-id>)
Description: <phase description>
Project: <project-id>

Tasks created in this phase:
<for each task created in step 5:>
- <task-id>: <task-title>
  Acceptance criteria: <task acceptance criteria>
</end task list>

Project conventions (from CLAUDE.md):
<contents of project CLAUDE.md>

Review each task against the project's architectural conventions and patterns.
Check for:
1. Adherence to established project patterns and conventions
2. Consistency with existing architecture (file structure, naming, module boundaries)
3. Potential architectural concerns (coupling, layering violations, missing abstractions)
4. Alignment with project-level standards documented in CLAUDE.md

Write your findings as structured JSON context on the phase bead:
node \"$HOME/.claude/forge/bin/forge-tools.cjs\" context-write <phase-id> '{
  \"agent\": \"forge-architect\",
  \"status\": \"completed\",
  \"findings\": [
    { \"task\": \"<task-id>\", \"severity\": \"suggestion\"|\"concern\", \"description\": \"...\", \"recommendation\": \"...\" }
  ],
  \"summary\": \"<one-line overall architectural assessment>\"
}'

If all tasks look good, write findings as an empty array with a positive summary.
")
```

**On failure or timeout:** Log a warning ("Architect review skipped -- agent failed or timed out") and continue to plan verification. Do **not** abort the workflow.

The planner and plan-checker can review the architect's advisory findings via context-read on the phase bead in subsequent steps.

## 6. Verify Plan (Plan Verification Loop)

Run automated checks:
```bash
CHECK=$(node "$HOME/.claude/forge/bin/forge-tools.cjs" plan-check <phase-id>)
```

Resolve the model:
```bash
MODEL=$(node "$HOME/.claude/forge/bin/forge-tools.cjs" resolve-model forge-plan-checker --raw)
```

Spawn a **forge-plan-checker** agent:

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

Produce an APPROVED or NEEDS REVISION verdict as structured JSON:
{
  \"verdict\": \"APPROVED\" | \"NEEDS REVISION\",
  \"findings\": [
    { \"number\": 1, \"severity\": \"blocker\"|\"suggestion\", \"description\": \"...\", \"fix\": \"exact command or action\" }
  ]
}
NEEDS REVISION MUST include at least one blocker finding.
APPROVED may only contain suggestion findings.
")
```

**If NEEDS REVISION:** Fix each blocker using its `fix` command, then re-run checker. Repeat until APPROVED.

**If APPROVED:** Present verified plan:
```bash
PHASE=$(node "$HOME/.claude/forge/bin/forge-tools.cjs" phase-context <phase-id>)
```

Show tasks, acceptance criteria, requirement links, and execution order (waves).

## 6.5. Display Cost Estimate

```bash
node "$HOME/.claude/forge/bin/forge-tools.cjs" cost-estimate <phase-id>
```

Display to user. Best-effort -- if command fails, skip silently.

## 6.7. Implementation Preview & Approval Gate

Generate a detailed implementation preview and present it to the user for approval before
marking the phase as planned. This is a **hard gate** — the user must explicitly approve.

```bash
PREVIEW=$(node "$HOME/.claude/forge/bin/forge-tools.cjs" implementation-preview <phase-id>)
```

Parse the JSON output. Format a human-readable summary grouped by execution wave:

For each wave, show a table or structured list with per-task:
- **Title** and task ID
- **Files affected** (count and list)
- **Approach** (1-2 sentence summary)
- **Complexity** (simple/medium/complex)
- **Architect notes** (if any from step 5.5)

Include the `architect_summary` at the top if present.

Present via AskUserQuestion (single-select, not multiSelect):
- header: "Plan approval"
- question: "Approve this plan? <total_tasks> tasks, <total_files_affected> files affected"
- options:
  1. "Approve — start execution" (proceeds to step 7)
  2. "Reject — re-plan or adjust" (stops workflow)

**On approval:** Proceed to step 7 (mark phase as planned).

**On rejection:** Stop the workflow. Suggest:
- `/forge:plan <phase> --skip-research` to re-plan with different decisions
- Manual task edits via `bd update <task-id>` to adjust individual tasks

## 7. Mark Phase as Planned

```bash
bd update <phase-id> --status=in_progress
```

Create a dedicated branch:
```bash
node "$HOME/.claude/forge/bin/forge-tools.cjs" branch-create <phase-id>
```

Creates `forge/m<milestone-id>/phase-<phase-id>`. If branch exists, command is idempotent. Without a milestone parent, creates `forge/phase-<phase-id>`.

Suggest next step: `/forge:execute <phase-number>` or `/forge:plan <next-phase>`.

</process>
