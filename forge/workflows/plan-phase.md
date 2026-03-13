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

## 2.5. Detect Parent Milestone and Fetch Requirements

Check if the phase belongs to a milestone by looking for a parent-child dependency pointing
up to a milestone-labeled bead:

```bash
bd dep list <phase-id> --direction=up --type=parent-child --json
```

Inspect the results for any parent bead that has the `forge:milestone` label. To confirm,
check each parent candidate:

```bash
bd show <parent-id> --json
```

If a milestone is found, fetch its requirement beads:

```bash
bd dep list <milestone-id> --direction=up --type=parent-child --json
```

Filter this list for beads that have the `forge:req` label. For each req bead, note its
`id` and `title` (and `description` if present). Store the full list as
`MILESTONE_REQS` — a list of objects with `id`, `title`, and `description`.

If no milestone is found, set `MILESTONE_REQS` to empty and continue — the workflow
behaves unchanged.

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

Before spawning the researcher, query for retrospective data from past phases:
```bash
RETRO=$(node "$HOME/.claude/forge/bin/forge-tools.cjs" retro-query <project-id>)
```

Parse the JSON result. If the command fails or `phase_count` is 0, set `RETRO_SECTION` to
empty string. Otherwise, build `RETRO_SECTION` from the actual output fields:

```
Retrospective data from <phase_count> past phase(s):

Lessons learned:
<for each entry in lessons array>
- [<phase_title>] <lesson>
</for each>

⚠ Pitfall warnings:
<for each entry in pitfall_flags array>
- [<phase_title>] <pitfall>
</for each>

Effectiveness summary:
<for each phase_id, rating in effectiveness_ratings>
- <phase_title>: rated <rating>/5 — <findings> (<blockers> blocker(s))
</for each>
```

Omit any sub-section whose source array/object is empty. If all are empty, set
`RETRO_SECTION` to empty string.

Otherwise, spawn a **forge-researcher** agent to investigate the implementation approach:

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
    \"Complexity estimate: <simple|medium|complex> — <reasoning>\"
  ]
}'
")
```

After the researcher returns, read back the structured context to extract findings for the planner:

```bash
RESEARCH_CTX=$(node "$HOME/.claude/forge/bin/forge-tools.cjs" context-read <phase-id>)
```

Parse the JSON output: look for the latest entry with `agent == "forge-researcher"` and `status == "completed"`. Extract:
- `findings` array → join as bullet list for `Research findings`
- `decisions` array → join as bullet list (includes complexity estimate)

**Backward compatibility:** If `context-read` returns no structured entries (only free-text research comments exist), fall back to reading phase comments directly:
```bash
bd comments <phase-id>
```
Use the most recent comment text as the research findings. The planner prompt always receives a research findings string — either from structured JSON or from the free-text fallback.

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

**Step B: Identify 2-3 specific gray areas**

From the phase description and any codebase context, identify the 2-3 implementation
decisions that most affect what gets built. Think: what would change the outcome if decided
differently? These must be **phase-specific and concrete** — not generic category labels.

Domain-driven examples:
- "User authentication" -> "Session handling: cookie vs JWT?" / "Error responses: redirect or inline?" / "Recovery: email link or SMS?"
- "CLI for backups" -> "Output format: JSON, table, or plain text?" / "Progress: spinner, percentage, or silent?" / "On error: abort-all or skip-and-continue?"
- "Feed display" -> "Layout: cards vs list?" / "Empty state: illustration or text-only?" / "Load more: pagination or infinite scroll?"

**Do NOT use generic labels** like "UI", "UX", "Behavior", or "Performance". Each gray area must be a specific decision with concrete option tradeoffs.

**Step C: Present and discuss with user**

State the phase goal and frame the discussion:
```
Phase [X]: [Name]
Goal: [What this phase delivers]

Before I plan the tasks, I need a few concrete decisions.
```

Use AskUserQuestion (multiSelect: true) to let the user pick which areas to clarify:
- header: "Quick decisions"
- question: "Which of these need your input for [phase name]?"
- options: the 2-3 specific gray areas from Step B, each phrased as a concrete question
  (e.g., "Session handling: cookie vs JWT?" not "Session handling")

For each selected area, ask 1-2 focused follow-up questions using AskUserQuestion:
- header: "[Area]" (max 12 chars, abbreviate if needed)
- question: The specific decision to make
- options: 2-3 **concrete, named choices** — not abstract options. Annotate with codebase
  context if relevant (e.g., "Cards (reuses existing Card component)" vs "List (new pattern)").
  Include "You decide" when the choice is low-stakes.

Keep total questions to 4-6 across all areas. This is a focused alignment pass, not a full
discussion session. The goal is zero ambiguity entering execute — every task the planner
creates should be unambiguous given the notes produced here.

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
Research findings: <findings from step 3 — bullet list from structured JSON or free-text fallback; omit section if no research was done>
Complexity estimate: <from structured context decisions field if available>
User decisions: <approach decisions from step 4>
Retrospective insights: <if RETRO_SECTION from step 3 is non-empty, include lessons and pitfall flags here; otherwise omit this line>
Requirements addressed by this phase: <relevant requirement IDs and titles>

<if MILESTONE_REQS is non-empty, include this section — otherwise omit it entirely>
Milestone Requirements (forge:req beads that this phase must help satisfy):
<for each req in MILESTONE_REQS:>
- <req-id>: <req-title> — <req-description if present>

When creating tasks, wire validates dependencies for applicable requirements:
  bd dep add <task-id> <req-id> --type=validates
Do this for every task that directly implements or verifies a requirement above.
A single task may validate multiple requirements; a requirement may be validated by multiple
tasks. When in doubt, prefer to add the link — missing coverage is harder to fix than extra
coverage.
</end milestone section>

For each task:
1. Create the task bead with acceptance_criteria
2. Add parent-child dep to the phase
3. Add forge:task label
4. Add validates dep to requirements it fulfills (see milestone requirements above if present)
5. Add intra-phase dependencies ONLY when strictly necessary — when task B cannot start until it has the concrete output produced by task A (e.g. task B uses a file, API, or data structure that task A creates). Independent tasks that merely belong to the same phase should have NO inter-task dependency. When in doubt, leave tasks independent.
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

Add intra-phase dependencies ONLY when strictly necessary — when task B cannot start until it
has the concrete output produced by task A (e.g. task B uses a file, API, or data structure
that task A creates). Independent tasks that merely belong to the same phase should have NO
inter-task dependency. When in doubt, leave tasks independent.
```bash
bd dep add <task-b-id> <task-a-id>  # task B depends on A — only add when B truly needs A's output
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

Create a dedicated branch for this phase. The branch is created from current HEAD in the
milestone worktree (if one exists) or the main repo:

```bash
node "$HOME/.claude/forge/bin/forge-tools.cjs" branch-create <phase-id>
```

This creates the branch `forge/m<milestone-id>/phase-<phase-id>`. If the branch already
exists (e.g., re-running plan on a phase), the command is idempotent — it will report the
existing branch and check it out without error. If no milestone parent exists, a branch
named `forge/phase-<phase-id>` is created instead.

Suggest next step: `/forge:execute <phase-number>` or `/forge:plan <next-phase>`.

</process>
