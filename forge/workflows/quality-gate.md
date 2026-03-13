<purpose>
Pre-PR quality pipeline. Orchestrates three audit agents (security, code review, performance)
in parallel, collects their structured JSON findings, groups results by severity, presents them
to the user for approval, creates fix tasks for approved findings, and spawns a fixer agent to
batch-apply all approved fixes. Capped at 1 round of fixes -- no recursive re-audit.
</purpose>

<process>

## 1. Scope Changed Files

Determine which files have changed on this branch relative to main:

```bash
CHANGED_FILES=$(git diff main...HEAD --name-only)
```

If `CHANGED_FILES` is empty, report that there are no changes to audit and stop.

Store the newline-separated file list for passing to each audit agent.

## 2. Resolve Models for Audit Agents

Resolve the model for each of the three audit agents. All three resolve calls are independent
and can run in parallel:

```bash
MODEL_SECURITY=$(node "$HOME/.claude/forge/bin/forge-tools.cjs" resolve-model forge-security-auditor --raw)
MODEL_REVIEWER=$(node "$HOME/.claude/forge/bin/forge-tools.cjs" resolve-model forge-code-reviewer --raw)
MODEL_PERF=$(node "$HOME/.claude/forge/bin/forge-tools.cjs" resolve-model forge-performance-auditor --raw)
```

If a model resolves to empty, omit the `model` parameter from the Agent call for that agent
(the default model will be used).

## 3. Spawn Audit Agents in Parallel

Spawn all three agents simultaneously using three Agent tool calls in the same response.
Pass each agent the list of changed files so they scope their analysis.

**Security Auditor:**
```
Agent(subagent_type="forge-security-auditor", model="<MODEL_SECURITY or omit>", prompt="
Audit the following changed files for security vulnerabilities.

Changed files:
<CHANGED_FILES>

Scope your analysis to these files only. Output your findings as raw JSON conforming to
agents/schemas/audit-findings.md. Do NOT wrap JSON in markdown fences.
")
```

**Code Reviewer:**
```
Agent(subagent_type="forge-code-reviewer", model="<MODEL_REVIEWER or omit>", prompt="
Review the following changed files for code quality issues.

Changed files:
<CHANGED_FILES>

Scope your review to these files only. Output your findings as raw JSON conforming to
agents/schemas/audit-findings.md. Do NOT wrap JSON in markdown fences.
")
```

**Performance Auditor:**
```
Agent(subagent_type="forge-performance-auditor", model="<MODEL_PERF or omit>", prompt="
Audit the following changed files for performance anti-patterns.

Changed files:
<CHANGED_FILES>

Scope your analysis to these files only. Output your findings as raw JSON conforming to
agents/schemas/audit-findings.md. Do NOT wrap JSON in markdown fences.
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

After parsing all three agent responses, check which succeeded and which failed.

**If all three agents failed**: Report the failure and stop. Show the raw error for each agent
so the user can debug.

**If 1 or 2 agents failed**: Continue with the results from agents that succeeded. Display a
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

**If all three agents succeeded**: Proceed normally with no warning.

## 6. Merge and Group Findings by Severity

Collect all findings from successful agents into a single list. Each finding retains its
`agent` origin from the parent response's `agent` field (add it to each finding if not
already present).

Group findings into two severity tiers:

- **Blockers**: findings with severity `critical` or `high`
- **Advisory**: findings with severity `medium`, `low`, or `info`

Sort each group by severity (critical before high; medium before low before info), then
by agent name, then by file path.

If both groups are empty (no findings from any agent), report a clean bill of health and stop:

```
------------------------------------------------------------
 Quality Gate: PASSED -- No issues found
------------------------------------------------------------
All audit agents completed successfully with zero findings.
Proceed with your PR.
------------------------------------------------------------
```

## 7. Present Blockers for Approval

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
to fix. Options should be the numbered findings plus "Fix all blockers" and "Skip all blockers":

```
AskUserQuestion(
  question: "Select which blocker findings to fix:",
  multiSelect: true,
  options: [
    "Fix all blockers",
    "1. [CRITICAL] Hardcoded database password in source",
    "2. [HIGH] Function exceeds 80 lines with deep nesting",
    ...
    "Skip all blockers"
  ]
)
```

Record the user's selections. If "Fix all blockers" is selected, mark all blocker findings
as approved. If "Skip all blockers" is selected, mark none. Otherwise, mark only the
individually selected findings.

## 8. Present Advisory Findings for Approval

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
    "Skip all advisory"
  ]
)
```

Record the user's selections using the same logic as step 7.

## 9. Create Fix Tasks and Spawn Fixer Agent

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

### 9a. Create Fix Task Beads

For each approved finding, create a task bead:

```bash
bd create --title="Fix: <finding title>" \
  --description="<finding description>\n\nFile: <file>:<line>\nAgent: <agent>\nSeverity: <severity>\nCategory: <category>\nRemediation: <remediation>" \
  --type=task --priority=<1 for critical, 2 for high, 3 for medium, 4 for low/info>
```

Collect all created task IDs.

### 9b. Spawn Fixer Agent

Spawn a single fixer agent to batch-apply all approved fixes in one pass. Do NOT spawn
one agent per finding -- batch them all into a single prompt.

Build a numbered list of all approved findings with their full details (file, line, description,
remediation). Pass this to a forge-executor agent:

```
Agent(subagent_type="forge-executor", prompt="
Apply the following quality-gate fixes. Each fix is an approved finding from audit agents.
Apply all fixes in a single pass, then create one atomic commit.

Fixes to apply:

<for each approved finding>
## Fix <N>: <title>
- File: <file>:<line>
- Severity: <severity>
- Category: <category> (from <agent>)
- Description: <description>
- Remediation: <remediation>
</for each>

Instructions:
1. Read each file that needs fixing
2. Apply the remediation for each finding
3. Run any relevant tests to verify fixes don't break anything
4. Create a single atomic git commit:
   Message: fix(quality-gate): apply <N> approved fixes from audit
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

## 10. Cap at 1 Round -- No Recursive Re-Audit

**IMPORTANT**: After the fixer agent completes, do NOT re-run the audit agents. The quality
gate is capped at exactly 1 round of fixes. This prevents infinite audit-fix loops and keeps
the workflow predictable.

Report the final summary:

```
------------------------------------------------------------
 Quality Gate: Complete
------------------------------------------------------------
Audit agents run:     <N successful> / 3
Total findings:       <N>
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
