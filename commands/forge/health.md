---
name: forge:health
description: Diagnose Forge project health and optionally repair issues
argument-hint: "[--fix]"
allowed-tools: Read, Bash, Grep, Glob, AskUserQuestion
---

<objective>
Diagnose the health of the current Forge project. Checks bead graph integrity (labels, dependencies, state consistency), Forge installation files, and YAML settings validity. Optionally repair fixable issues.
</objective>

<context>
Read the Forge conventions: @~/.claude/forge/references/conventions.md
</context>

<execution_context>
Execute the health workflow from @~/.claude/forge/workflows/health.md end-to-end.

When running diagnostics (step 2), use the health check command:
```bash
node "$HOME/.claude/forge/bin/forge-tools.cjs" health <project-id>
```

This returns a structured diagnostic report with issues categorized by severity.

If the user passed `--fix`, attempt automated repairs for fixable issues (step 3).
For issues that require human judgment, present them and ask for confirmation
before making changes.

Always present the full diagnostic report regardless of whether `--fix` is used.
</execution_context>
