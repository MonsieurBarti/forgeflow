<purpose>
Pre-PR quality pipeline. Orchestrates four audit agents (security, code review, performance,
architect) in parallel, collects their structured JSON findings, groups results by severity,
presents them to the user for approval, creates fix tasks for approved findings, and dispatches
approved fixes to domain-specific fixer agents (security-fixer, code-fixer, perf-fixer) in
parallel. Capped at 1 round of fixes -- no recursive re-audit.
</purpose>

<process>

## 1. Scope Changed Files

Determine which files have changed on this branch relative to main:

```bash
BASE=$(git merge-base HEAD main 2>/dev/null || git merge-base HEAD master 2>/dev/null)
CHANGED_FILES=$(git diff --name-only "$BASE"..HEAD)
```

If `CHANGED_FILES` is empty, report that there are no changes to audit and stop.

Store the newline-separated file list for passing to each audit agent.

## 2. Resolve Models for Audit Agents

Resolve the model for each of the four audit agents. All four resolve calls are independent
and can run in parallel:

```bash
MODEL_SECURITY=$(node "$HOME/.claude/forge/bin/forge-tools.cjs" resolve-model forge-security-auditor --raw)
MODEL_REVIEWER=$(node "$HOME/.claude/forge/bin/forge-tools.cjs" resolve-model forge-code-reviewer --raw)
MODEL_PERF=$(node "$HOME/.claude/forge/bin/forge-tools.cjs" resolve-model forge-performance-auditor --raw)
MODEL_ARCHITECT=$(node "$HOME/.claude/forge/bin/forge-tools.cjs" resolve-model forge-architect --raw)
```

If a model resolves to empty, omit the `model` parameter from the Agent call for that agent
(the default model will be used).

## 3. Spawn Audit Agents in Parallel

Spawn all four agents simultaneously using four Agent tool calls in the same response.
Pass each agent the list of changed files so they scope their analysis.

**forge-security-auditor** (subagent_type="forge-security-auditor"):
```
Agent(subagent_type="forge-security-auditor", model="<MODEL_SECURITY or omit>", prompt="
Audit the following changed files for security vulnerabilities.

<changed_files>
<CHANGED_FILES>
</changed_files>

Scope your analysis to these files only. Output your findings as raw JSON conforming to
agents/schemas/audit-findings.md. Do NOT wrap JSON in markdown fences.
")
```

**forge-code-reviewer** (subagent_type="forge-code-reviewer"):
```
Agent(subagent_type="forge-code-reviewer", model="<MODEL_REVIEWER or omit>", prompt="
Review the following changed files for code quality issues.

<changed_files>
<CHANGED_FILES>
</changed_files>

Scope your review to these files only. Output your findings as raw JSON conforming to
agents/schemas/audit-findings.md. Do NOT wrap JSON in markdown fences.
")
```

**forge-performance-auditor** (subagent_type="forge-performance-auditor"):
```
Agent(subagent_type="forge-performance-auditor", model="<MODEL_PERF or omit>", prompt="
Audit the following changed files for performance anti-patterns.

<changed_files>
<CHANGED_FILES>
</changed_files>

Scope your analysis to these files only. Output your findings as raw JSON conforming to
agents/schemas/audit-findings.md. Do NOT wrap JSON in markdown fences.
")
```

**forge-architect** (subagent_type="forge-architect"):
```
Agent(subagent_type="forge-architect", model="<MODEL_ARCHITECT or omit>", prompt="
Audit the following changed files for architectural violations and adherence issues.

<changed_files>
<CHANGED_FILES>
</changed_files>

Scope your analysis to these files only. Output your findings as raw JSON conforming to
agents/schemas/audit-findings.md with subagent_type='forge-architect'.
Do NOT wrap JSON in markdown fences.
")
```

## 4. Parse Agent Responses Tolerantly

Each agent should return raw JSON, but in practice the output may contain markdown fences,
trailing commentary, or partial formatting. Apply the following tolerant parsing logic to
each agent's response:

### Parsing Steps

1. **Strip markdown fences**: Remove lines matching `` ```json `` or `` ``` `` (with optional
   leading/trailing whitespace). Also handle `` ```javascript `` or bare `` ``` `` fences.

2. **Extract JSON object**: Find the first `{` and the last `}` in the response. Extract the
   substring between them (inclusive). This handles leading/trailing commentary.

3. **Parse JSON**: Attempt `JSON.parse()` (or equivalent) on the extracted string.

4. **Validate structure**: Confirm the parsed object has `agent` (string), `findings` (array),
   and `summary` (object with `total` and `by_severity`). If any field is missing, treat it
   as a parse failure for that agent.

5. **Fallback on failure**: If parsing fails at any step, record the agent as failed with the
   raw response text for debugging. Do not abort the entire pipeline.

### Example parse pseudocode

```
function parseAuditResponse(agentName, rawText):
  // Step 1: strip fences
  text = rawText.replace(/^\s*```\w*\s*$/gm, '')

  // Step 2: extract JSON
  firstBrace = text.indexOf('{')
  lastBrace = text.lastIndexOf('}')
  if firstBrace == -1 or lastBrace == -1 or lastBrace <= firstBrace:
    return { success: false, agent: agentName, error: "No JSON object found" }

  jsonStr = text.substring(firstBrace, lastBrace + 1)

  // Step 3: parse
  try:
    parsed = JSON.parse(jsonStr)
  catch:
    return { success: false, agent: agentName, error: "JSON parse error" }

  // Step 4: validate
  if !parsed.findings or !Array.isArray(parsed.findings):
    return { success: false, agent: agentName, error: "Missing findings array" }

  return { success: true, data: parsed }
```

## 5. Handle Partial Agent Failure

After parsing all four agent responses, check which succeeded and which failed.

**If all four agents failed**: Report the failure and stop. Show the raw error for each agent
so the user can debug.

**If 1-3 agents failed**: Continue with the results from agents that succeeded. Display a
warning listing which agents failed:

```
------------------------------------------------------------
 WARNING: Some audit agents failed to produce valid output
------------------------------------------------------------

  Failed agents:
  - <agent-name>: <error reason>

  Continuing with results from: <list of successful agents>
------------------------------------------------------------
```

**If all four agents succeeded**: Proceed normally with no warning.

## 6. Load and Filter Known False-Positives

Before merging findings, load the known false-positive list and filter them out.

```bash
FP_JSON=$(node "$HOME/.claude/forge/bin/forge-tools.cjs" quality-gate-fp-list)
```

Parse the `false_positives` array from the response. For each finding from all successful
agents, compute its FP hash (SHA-256 of agent+category+file+title, truncated to 16 hex chars)
and check if it matches any known FP hash. Remove matching findings from the results.

### FP hash computation pseudocode

```
function computeFpHash(agent, category, file, title):
  input = agent + '\x00' + category + '\x00' + file + '\x00' + title
  return sha256(input).hex().slice(0, 16)
```

If any findings were filtered, report the count:

```
------------------------------------------------------------
 Known false-positives filtered: <N>
------------------------------------------------------------
```

Retain the filtered findings list for subsequent steps. The original total before filtering
should be noted for the final summary.

## 7. Merge and Group Findings by Severity

Collect all findings from successful agents into a single list (after FP filtering from
step 6). Each finding retains its `agent` origin from the parent response's `agent` field
(add it to each finding if not already present).

Group findings into two severity tiers:

- **Blockers**: findings with severity `critical` or `high`
- **Advisory**: findings with severity `medium`, `low`, or `info`

Sort each group by severity (critical before high; medium before low before info), then
by agent name, then by file path.

If both groups are empty (no findings from any agent), note the clean result but **continue
to step 8** to generate the PASSED report.

## 8. Generate Findings Report

Generate a comprehensive HTML report of all findings, regardless of whether there are findings
or not. This runs BEFORE the interactive approval steps so the user can view the visual report
while making approval decisions.

Assemble the report data payload from the current workflow state:

```
REPORT_DATA = {
  agents: [
    { name: "<agent-name>", status: "success" | "failed", findingsCount: <N> }
    // one entry per audit agent (including failed ones)
  ],
  findings: [
    // all findings after FP filtering from step 6, each with its `agent` field
  ],
  filteredFps: [
    // findings removed in step 6, each: { hash, agent, category, file, title }
  ],
  changedFiles: [
    // file list from step 1
  ],
  summary: {
    totalBeforeFilter: <count before step 6 filtering>,
    totalAfterFilter: <count after step 6 filtering>,
    blockers: <critical + high count>,
    advisory: <medium + low + info count>,
    agentsRun: <successful agent count>,
    agentsFailed: <failed agent count>
  }
}
```

Write the report data to a temp file first (avoids shell quoting issues with finding data
that may contain single quotes or special characters), then pass the file path:
```bash
# Write JSON to temp file to avoid shell escaping issues
REPORT_TMP=$(mktemp /tmp/forge-qg-data-XXXXXX.json)
cat > "$REPORT_TMP" <<'EOJSON'
<REPORT_DATA as JSON>
EOJSON
# Double quotes around $(cat ...) are mandatory to prevent word splitting
node "$HOME/.claude/forge/bin/forge-tools.cjs" quality-gate-report --data="$(cat "$REPORT_TMP")"
rm -f "$REPORT_TMP"
```

**Important:**
- Report generation failure MUST NOT abort the pipeline. If the command fails, log a warning
  and continue to step 9. Use allowFail or wrap in try/catch.
- This step runs even for zero-finding cases — the PASSED report is still generated.
- The report is ephemeral: it auto-opens in the browser and the file is deleted after 15 seconds.

If findings are empty (zero-finding clean run), report a clean bill of health and stop
(no approval steps needed):

```
------------------------------------------------------------
 Quality Gate: PASSED -- No issues found
------------------------------------------------------------
All audit agents completed successfully with zero findings.
Proceed with your PR.
------------------------------------------------------------
```

## 9. Present Blockers for Approval

If there are blocker findings (critical/high), present them first.

Format each finding as a numbered item:

```
BLOCKERS (critical/high severity) -- these should be fixed before merging:

  1. [CRITICAL] [security-auditor] src/api/auth.ts:42
     Hardcoded database password in source
     Remediation: Move the password to an environment variable

  2. [HIGH] [code-reviewer] src/utils/parser.ts:108
     Function exceeds 80 lines with deep nesting
     Remediation: Extract inner logic into named helper functions

  ...
```

Use AskUserQuestion with `multiSelect:true` to let the user select which blocker findings
to fix. Options should include "Mark as false-positive" alongside the existing options:

```
AskUserQuestion(
  question: "Select which blocker findings to fix:",
  multiSelect: true,
  options: [
    "Fix all blockers",
    "1. [CRITICAL] Hardcoded database password in source",
    "2. [HIGH] Function exceeds 80 lines with deep nesting",
    ...
    "Mark selected as false-positive",
    "Skip all blockers"
  ]
)
```

Record the user's selections. If "Fix all blockers" is selected, mark all blocker findings
as approved. If "Skip all blockers" is selected, mark none. Otherwise, mark only the
individually selected findings.

If "Mark selected as false-positive" is selected, persist each individually selected finding
as a false-positive so it is filtered out in future runs:

```bash
node "$HOME/.claude/forge/bin/forge-tools.cjs" quality-gate-fp-add \
  --agent=<agent> --category=<category> --file=<file> --title=<title>
```

Findings marked as false-positive are NOT approved for fixing -- they are simply excluded
from future runs.

## 10. Present Advisory Findings for Approval

If there are advisory findings (medium/low/info), present them next.

Format similarly to blockers:

```
ADVISORY (medium/low/info severity) -- recommended improvements:

  1. [MEDIUM] [performance-auditor] src/db/queries.ts:23
     Potential N+1 query in user loader loop
     Remediation: Use batch loading with findMany

  2. [LOW] [code-reviewer] src/components/Header.tsx:15
     Component could benefit from React.memo
     Remediation: Wrap in memo() to prevent unnecessary re-renders

  ...
```

Use AskUserQuestion with `multiSelect:true`:

```
AskUserQuestion(
  question: "Select which advisory findings to fix:",
  multiSelect: true,
  options: [
    "Fix all advisory",
    "1. [MEDIUM] Potential N+1 query in user loader loop",
    "2. [LOW] Component could benefit from React.memo",
    ...
    "Mark selected as false-positive",
    "Skip all advisory"
  ]
)
```

Record the user's selections using the same logic as step 9.

If "Mark selected as false-positive" is selected, persist each individually selected finding
as a false-positive for future runs:

```bash
node "$HOME/.claude/forge/bin/forge-tools.cjs" quality-gate-fp-add \
  --agent=<agent> --category=<category> --file=<file> --title=<title>
```

Findings marked as false-positive are NOT approved for fixing.

## 11. Create Fix Tasks and Spawn Fixer Agent

Combine all approved findings from both the blocker and advisory groups.

If no findings were approved (user skipped everything), report that no fixes will be applied
and stop:

```
------------------------------------------------------------
 Quality Gate: Complete -- No fixes requested
------------------------------------------------------------
<N> finding(s) identified, 0 approved for fixing.
Proceed with your PR when ready.
------------------------------------------------------------
```

If findings were approved, proceed:

### 11a. Create Fix Task Beads

For each approved finding, create a task bead:

```bash
bd create --title="Fix: <finding title>" \
  --description="<finding description>\n\nFile: <file>:<line>\nAgent: <agent>\nSeverity: <severity>\nCategory: <category>\nRemediation: <remediation>" \
  --type=task --priority=<1 for critical, 2 for high, 3 for medium, 4 for low/info>
```

Collect all created task IDs.

### 11b. Batch Findings by Agent Origin and Spawn Domain-Specific Fixers

Group approved findings by their originating audit agent and map each group to the
corresponding fixer agent:

| Originating agent      | Fixer agent            |
|------------------------|------------------------|
| security-auditor       | forge-security-fixer   |
| code-reviewer          | forge-code-fixer       |
| performance-auditor    | forge-perf-fixer       |
| architect              | forge-code-fixer       |

Architect findings batch to forge-code-fixer alongside code-reviewer findings, since
architectural fixes are code refactors.

Only spawn a fixer for groups that have at least one approved finding. If a group has
zero findings, skip that fixer entirely. Spawn up to 3 fixer agents in parallel using
multiple Agent tool calls in the same response.

Resolve models for each fixer agent before spawning:

```bash
MODEL_SEC_FIXER=$(node "$HOME/.claude/forge/bin/forge-tools.cjs" resolve-model forge-security-fixer --raw)
MODEL_CODE_FIXER=$(node "$HOME/.claude/forge/bin/forge-tools.cjs" resolve-model forge-code-fixer --raw)
MODEL_PERF_FIXER=$(node "$HOME/.claude/forge/bin/forge-tools.cjs" resolve-model forge-perf-fixer --raw)
```

For each non-empty batch, spawn the corresponding fixer with only its domain-specific
findings. Each fixer receives only the findings relevant to its domain, not all findings.

**Security Fixer** (if security findings exist):
```
Agent(subagent_type="forge-security-fixer", model="<MODEL_SEC_FIXER or omit>", prompt="
Apply the following approved security fixes. Each fix was identified by the security-auditor.
Apply all fixes in a single pass, then create one atomic commit.

Fixes to apply:

<for each approved security finding>
## Fix <N>: <title>
- File: <file>:<line>
- Severity: <severity>
- Category: <category>
- Description: <description>
- Remediation: <remediation>
- Task ID: <task-id>
</for each>

Instructions:
1. Read each file that needs fixing
2. Apply the security remediation for each finding
3. Run any relevant tests to verify fixes don't break anything
4. Create a single atomic git commit:
   Message: fix(quality-gate): apply <N> security fixes from audit
   Use git add <specific files> -- never git add . or git add -A
   NEVER run git merge or gh pr merge
5. For each fix task, close it:
   bd close <task-id> --reason='Applied fix: <finding title>'

If a fix cannot be applied cleanly (e.g., conflicting changes, unclear remediation):
- Skip that fix
- Add a note to the task: bd update <task-id> --notes='Could not auto-fix: <reason>'
- Continue with remaining fixes
")
```

**Code Fixer** (if code review or architect findings exist):
```
Agent(subagent_type="forge-code-fixer", model="<MODEL_CODE_FIXER or omit>", prompt="
Apply the following approved code quality and architectural fixes. Fixes were identified by
the code-reviewer and/or forge-architect. Apply all fixes in a single pass, then create one
atomic commit.

Fixes to apply:

<for each approved code review or architect finding>
## Fix <N>: <title>
- File: <file>:<line>
- Severity: <severity>
- Category: <category>
- Description: <description>
- Remediation: <remediation>
- Task ID: <task-id>
</for each>

Instructions:
1. Read each file that needs fixing
2. Apply the refactoring for each finding
3. Run any relevant tests to verify fixes don't break anything
4. Create a single atomic git commit:
   Message: refactor(quality-gate): apply <N> code quality fixes from review
   Use git add <specific files> -- never git add . or git add -A
   NEVER run git merge or gh pr merge
5. For each fix task, close it:
   bd close <task-id> --reason='Applied fix: <finding title>'

If a fix cannot be applied cleanly (e.g., conflicting changes, unclear remediation):
- Skip that fix
- Add a note to the task: bd update <task-id> --notes='Could not auto-fix: <reason>'
- Continue with remaining fixes
")
```

**Performance Fixer** (if performance findings exist):
```
Agent(subagent_type="forge-perf-fixer", model="<MODEL_PERF_FIXER or omit>", prompt="
Apply the following approved performance fixes. Each fix was identified by the performance-auditor.
Apply all fixes in a single pass, then create one atomic commit.

Fixes to apply:

<for each approved performance finding>
## Fix <N>: <title>
- File: <file>:<line>
- Severity: <severity>
- Category: <category>
- Description: <description>
- Remediation: <remediation>
- Task ID: <task-id>
</for each>

Instructions:
1. Read each file that needs fixing
2. Apply the performance optimization for each finding
3. Run any relevant tests to verify fixes don't break anything
4. Create a single atomic git commit:
   Message: perf(quality-gate): apply <N> performance fixes from audit
   Use git add <specific files> -- never git add . or git add -A
   NEVER run git merge or gh pr merge
5. For each fix task, close it:
   bd close <task-id> --reason='Applied fix: <finding title>'

If a fix cannot be applied cleanly (e.g., conflicting changes, unclear remediation):
- Skip that fix
- Add a note to the task: bd update <task-id> --notes='Could not auto-fix: <reason>'
- Continue with remaining fixes
")
```

## 12. Cap at 1 Round -- No Recursive Re-Audit

**IMPORTANT**: After the fixer agents complete, do NOT re-run the audit agents. The quality
gate is capped at exactly 1 round of fixes. This prevents infinite audit-fix loops and keeps
the workflow predictable.

Report the final summary:

```
------------------------------------------------------------
 Quality Gate: Complete
------------------------------------------------------------
Audit agents run:     <N successful> / 4
Total findings:       <N total before FP filtering>
  False-positives filtered: <N>
  Blockers (crit/high): <N>
  Advisory (med/low/info): <N>
Approved for fixing:  <N>
Fixes applied:        (see fixer agent output)
------------------------------------------------------------
Re-audit skipped (1-round cap). Review the fixes manually
or run /forge:quality-gate again if needed.
------------------------------------------------------------
```

</process>
