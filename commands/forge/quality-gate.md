---
name: forge:quality-gate
description: Run pre-PR quality pipeline (security, code review, performance audits) with user-approval flow
allowed-tools: Read, Write, Edit, Bash, Grep, Glob, Agent, AskUserQuestion
---

<objective>
Run the pre-PR quality gate pipeline. Spawns three audit agents in parallel (security, code review,
performance), collects findings, groups by severity, presents them to the user for approval, and
auto-fixes approved findings via a fixer agent. Capped at 1 round of fixes.
</objective>

<context>
Read the Forge conventions: @~/.claude/forge/references/conventions.md
</context>

<execution_context>
Execute the quality-gate workflow from @~/.claude/forge/workflows/quality-gate.md end-to-end.

When scoping changes (step 1), use:
```bash
git diff main...HEAD --name-only
```

When resolving models (step 2), resolve all three audit agent models:
```bash
MODEL_SECURITY=$(node "$HOME/.claude/forge/bin/forge-tools.cjs" resolve-model forge-security-auditor --raw)
MODEL_REVIEWER=$(node "$HOME/.claude/forge/bin/forge-tools.cjs" resolve-model forge-code-reviewer --raw)
MODEL_PERF=$(node "$HOME/.claude/forge/bin/forge-tools.cjs" resolve-model forge-performance-auditor --raw)
```

When spawning audit agents (step 3), spawn all three Agent calls in the **same response** so
they run in parallel. Pass the changed files list to each agent to scope their analysis.

When parsing agent responses (step 4), apply tolerant JSON parsing: strip markdown fences,
extract the JSON object between the first `{` and last `}`, validate the schema structure.
If an agent fails to produce valid JSON, continue with the other agents' results.

When presenting findings (steps 7-8), use AskUserQuestion with `multiSelect:true` for each
severity group (blockers first, then advisory). Let the user select which findings to fix.

When applying fixes (step 9), create fix task beads for each approved finding, then spawn a
single forge-executor agent to batch-apply all approved fixes in one commit.

The quality gate is capped at 1 round of fixes. After the fixer agent completes, do NOT
re-run audit agents. Report the summary and stop.
</execution_context>
