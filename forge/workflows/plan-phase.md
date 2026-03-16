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

## 5.5. Plan-Time Quality Gate (Shift-Left)

This step spawns three audit agents in parallel to review the planned tasks **before any code
is written**. The agents review task descriptions, files_affected, and acceptance criteria --
not code diffs, since no code exists yet.

The entire step is **non-blocking on failure/timeout**. If the gate mechanism itself errors,
log a warning and continue to step 6.

### 5.5a. Check shift_left_gates setting

```bash
SETTINGS=$(node "$HOME/.claude/forge/bin/forge-tools.cjs" settings-load)
```

Parse `shift_left_gates` from the settings JSON. It defaults to `true` if not present.

**If `shift_left_gates` is `false`**: Log "Plan-time quality gate skipped (shift_left_gates=false)" and skip directly to step 6. Do not resolve models or spawn agents.

**If `shift_left_gates` is `true` (default)**: Continue to 5.5b.

Also parse `shift_left_enforcement` from the settings JSON. Valid values are `advisory`
(default) and `enforced`. Store the value for use in step 5.5f.

### 5.5b. Gather task data for review

Collect the task design data from all tasks created in step 5. For each task, extract:
- Task ID and title
- Description
- Acceptance criteria
- `files_affected` from the task design JSON
- `approach` from the task design JSON

Format this into a `TASK_REVIEW_DATA` block:

```
<for each task created in step 5:>
### Task: <task-id> -- <task-title>
- Description: <task description>
- Acceptance criteria: <task acceptance criteria>
- Files affected: <files_affected from design JSON>
- Approach: <approach from design JSON>
</end task list>
```

### 5.5c. Resolve models for audit agents

Resolve the model for each of the three audit agents. All three resolve calls are independent
and can run in parallel:

```bash
MODEL_ARCHITECT=$(node "$HOME/.claude/forge/bin/forge-tools.cjs" resolve-model forge-architect --raw)
MODEL_SECURITY=$(node "$HOME/.claude/forge/bin/forge-tools.cjs" resolve-model forge-security-auditor --raw)
MODEL_PERF=$(node "$HOME/.claude/forge/bin/forge-tools.cjs" resolve-model forge-performance-auditor --raw)
```

If a model resolves to empty, omit the `model` parameter from the Agent call for that agent
(the default model will be used).

### 5.5d. Spawn three audit agents in parallel

Spawn all three agents simultaneously using three Agent tool calls in the same response.
Each agent receives the task data from step 5.5b -- NOT code diffs.

**forge-architect** (subagent_type="forge-architect"):
```
Agent(subagent_type="forge-architect", model="<MODEL_ARCHITECT or omit>", prompt="
Review the following planned tasks for architectural issues. These are task PLANS, not code
diffs -- no code has been written yet. Review the task descriptions, files_affected, acceptance
criteria, and approach for potential problems.

Phase: <phase title> (<phase-id>)
Description: <phase description>
Project: <project-id>

Project conventions (from CLAUDE.md):
<contents of project CLAUDE.md>

<TASK_REVIEW_DATA>

Check for:
1. Adherence to established project patterns and conventions
2. Consistency with existing architecture (file structure, naming, module boundaries)
3. Potential architectural concerns (coupling, layering violations, missing abstractions)
4. Alignment with project-level standards documented in CLAUDE.md
5. Whether files_affected lists are complete and reasonable for the described work

Output your findings as raw JSON (do NOT wrap in markdown fences):
{
  \"agent\": \"forge-architect\",
  \"findings\": [
    { \"task\": \"<task-id>\", \"severity\": \"critical\"|\"high\"|\"medium\"|\"low\"|\"info\", \"title\": \"<short title>\", \"description\": \"<what is wrong>\", \"recommendation\": \"<how to fix>\" }
  ],
  \"summary\": \"<one-line overall architectural assessment>\"
}

If all tasks look good, output findings as an empty array with a positive summary.
")
```

**forge-security-auditor** (subagent_type="forge-security-auditor"):
```
Agent(subagent_type="forge-security-auditor", model="<MODEL_SECURITY or omit>", prompt="
Review the following planned tasks for security concerns. These are task PLANS, not code
diffs -- no code has been written yet. Review the task descriptions, files_affected, acceptance
criteria, and approach for potential security issues.

Phase: <phase title> (<phase-id>)
Description: <phase description>
Project: <project-id>

<TASK_REVIEW_DATA>

Check for:
1. Security risks in the planned approach (auth gaps, injection vectors, data exposure)
2. Missing security-related acceptance criteria (input validation, auth checks, rate limiting)
3. Sensitive files in files_affected that need extra scrutiny (credentials, configs, auth modules)
4. Whether the planned approach follows security best practices for the domain

Output your findings as raw JSON (do NOT wrap in markdown fences):
{
  \"agent\": \"forge-security-auditor\",
  \"findings\": [
    { \"task\": \"<task-id>\", \"severity\": \"critical\"|\"high\"|\"medium\"|\"low\"|\"info\", \"title\": \"<short title>\", \"description\": \"<what is wrong>\", \"recommendation\": \"<how to fix>\" }
  ],
  \"summary\": \"<one-line overall security assessment>\"
}

If all tasks look good, output findings as an empty array with a positive summary.
")
```

**forge-performance-auditor** (subagent_type="forge-performance-auditor"):
```
Agent(subagent_type="forge-performance-auditor", model="<MODEL_PERF or omit>", prompt="
Review the following planned tasks for performance concerns. These are task PLANS, not code
diffs -- no code has been written yet. Review the task descriptions, files_affected, acceptance
criteria, and approach for potential performance issues.

Phase: <phase title> (<phase-id>)
Description: <phase description>
Project: <project-id>

<TASK_REVIEW_DATA>

Check for:
1. Performance anti-patterns in the planned approach (N+1 queries, unbounded loops, missing caching)
2. Missing performance-related acceptance criteria (pagination, indexing, lazy loading)
3. Scalability concerns given the planned architecture
4. Whether files_affected suggest high-traffic paths that need performance attention

Output your findings as raw JSON (do NOT wrap in markdown fences):
{
  \"agent\": \"forge-performance-auditor\",
  \"findings\": [
    { \"task\": \"<task-id>\", \"severity\": \"critical\"|\"high\"|\"medium\"|\"low\"|\"info\", \"title\": \"<short title>\", \"description\": \"<what is wrong>\", \"recommendation\": \"<how to fix>\" }
  ],
  \"summary\": \"<one-line overall performance assessment>\"
}

If all tasks look good, output findings as an empty array with a positive summary.
")
```

### 5.5e. Parse agent responses tolerantly

Apply the same tolerant parsing logic from quality-gate.md step 4 to each agent's response:

1. **Strip markdown fences**: Remove lines matching `` ```json `` or `` ``` `` (with optional
   leading/trailing whitespace). Also handle `` ```javascript `` or bare `` ``` `` fences.

2. **Extract JSON object**: Find the first `{` and the last `}` in the response. Extract the
   substring between them (inclusive). This handles leading/trailing commentary.

3. **Parse JSON**: Attempt `JSON.parse()` (or equivalent) on the extracted string.

4. **Validate structure**: Confirm the parsed object has `agent` (string) and `findings` (array).
   If any required field is missing, treat it as a parse failure for that agent.

5. **Fallback on failure**: If parsing fails at any step, record the agent as failed with the
   raw response text for debugging. Do not abort the pipeline.

### Handling partial agent failure

After parsing all three agent responses, check which succeeded and which failed.

**If all three agents failed**: Log a warning and continue to step 6. Do NOT block the workflow:

```
------------------------------------------------------------
 WARNING: Plan-time quality gate -- all agents failed
------------------------------------------------------------
  Failed agents:
  - <agent-name>: <error reason>

  Continuing to plan verification.
------------------------------------------------------------
```

**If 1-2 agents failed**: Continue with the results from agents that succeeded. Display a
warning listing which agents failed:

```
------------------------------------------------------------
 WARNING: Some plan-time audit agents failed
------------------------------------------------------------
  Failed agents:
  - <agent-name>: <error reason>

  Continuing with results from: <list of successful agents>
------------------------------------------------------------
```

**If all three agents succeeded**: Proceed normally with no warning.

### 5.5f. Store findings and check enforcement

Collect all findings from successful agents into a single list. Each finding retains its
`agent` field identifying the source agent.

Store all findings via context-write on the phase bead:

```bash
node "$HOME/.claude/forge/bin/forge-tools.cjs" context-write <phase-id> '{
  "agent": "plan-time-gate",
  "status": "completed",
  "findings": [
    { "agent": "<source-agent>", "task": "<task-id>", "severity": "<severity>", "title": "<title>", "description": "<description>", "recommendation": "<recommendation>" }
  ],
  "summary": "<combined summary from all agents>"
}'
```

If no successful agents produced results, store a minimal context entry noting the gate was
attempted but all agents failed.

**Check enforcement mode** (from `shift_left_enforcement` parsed in step 5.5a):

**When `shift_left_enforcement` is `advisory` (default)**: Log findings for visibility but
do NOT block the workflow. Display a summary:

```
------------------------------------------------------------
 Plan-Time Quality Gate: <N> finding(s) [advisory mode]
------------------------------------------------------------
  <for each finding:>
  - [<SEVERITY>] [<agent>] <task-id>: <title>
    <description>
  </for each>

  Mode: advisory -- findings logged, workflow continues.
------------------------------------------------------------
```

If no findings, display:

```
------------------------------------------------------------
 Plan-Time Quality Gate: PASSED -- No issues found [advisory mode]
------------------------------------------------------------
```

Continue to step 6.

**When `shift_left_enforcement` is `enforced` and NO critical findings exist**: Log findings
(if any) and continue to step 6 normally:

```
------------------------------------------------------------
 Plan-Time Quality Gate: PASSED [enforced mode]
------------------------------------------------------------
  <N> finding(s), none critical. Workflow continues.
------------------------------------------------------------
```

**When `shift_left_enforcement` is `enforced` and critical findings exist**: Halt the
workflow and present findings via AskUserQuestion:

```
------------------------------------------------------------
 Plan-Time Quality Gate: BLOCKED [enforced mode]
------------------------------------------------------------
  <N> critical finding(s) require resolution before proceeding.

  <for each critical finding:>
  - [CRITICAL] [<agent>] <task-id>: <title>
    <description>
    Recommendation: <recommendation>
  </for each>
------------------------------------------------------------
```

```
AskUserQuestion(
  header: "Plan-time quality gate -- critical findings",
  question: "Critical findings found in planned tasks. How do you want to proceed?",
  multiSelect: false,
  options: [
    "Approve -- continue to plan verification despite critical findings",
    "Fix -- update task descriptions/acceptance criteria to address findings, then re-plan",
    "Abort -- stop planning and review findings"
  ]
)
```

- **Approve**: Log that the user approved critical findings and continue to step 6.
- **Fix**: Stop the workflow. Suggest updating task details via `bd update <task-id>` to
  address findings, then re-running `/forge:plan <phase>`.
- **Abort**: Stop the workflow. Display the full findings for review.

## 6. Verify Plan (Plan Verification Loop)

Run automated checks:
```bash
CHECK=$(node "$HOME/.claude/forge/bin/forge-tools.cjs" plan-check <phase-id>)
```

Resolve the model:
```bash
MODEL=$(node "$HOME/.claude/forge/bin/forge-tools.cjs" resolve-model forge-plan-checker --raw)
```

Gather project context for the checker:
```bash
SLIM=$(node "$HOME/.claude/forge/bin/forge-tools.cjs" project-context-slim "<project-id>")
```

Spawn a **forge-plan-checker** agent:

```
Agent(subagent_type="forge-plan-checker", model="<resolved model or omit if null>", prompt="
Verify the plan for this phase:

Phase ID: <phase-id>
Project ID: <project-id>
Project context: <SLIM output>

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

## 6.7. Interactive Plan Review & Approval Gate

Present the plan to the user for review and approval. This is a **hard gate** — the user
must explicitly approve before the phase is marked as planned.

```bash
RESULT=$(node "$HOME/.claude/forge/bin/forge-tools.cjs" plan-interactive-review <phase-id>)
```

Parse the JSON output. The command handles two modes:

### Interactive mode (web_ui=true)

The command serves an interactive HTML page via the dev server where the user can:
- Edit task fields (title, description, acceptance criteria, approach, files_affected)
- Add reviewer comments to tasks
- Remove tasks from the plan
- Approve or reject the plan

The command applies all mutations (edits, comments, removals) server-side via bd commands
before returning. The result payload:
- `{ action: "approve", edits_applied, comments_applied, removals_applied }` — proceed to step 7
- `{ action: "reject" }` — stop the workflow

### Fallback mode (web_ui=false)

The command returns `{ fallback: true, data: <plan data> }`. In this case, format a
human-readable summary from `data` grouped by execution wave:

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

### On approval
Proceed to step 7 (mark phase as planned).

### On rejection
Stop the workflow. Suggest:
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
