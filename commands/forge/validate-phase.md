---
name: forge:validate-phase
description: Retroactively audit and fill validation gaps for a completed phase
argument-hint: "[phase-number-or-id]"
allowed-tools: Read, Write, Edit, Bash, Grep, Glob, Agent, AskUserQuestion
---

<objective>
Audit validation coverage for a completed phase. Check that acceptance criteria were actually
met (not just tasks closed), identify gaps between what was promised and what was delivered,
and optionally generate missing tests to fill gaps.

Three input states:
- (A) Phase has tasks with acceptance_criteria -- audit criteria against actual code/tests
- (B) Phase has closed tasks but no acceptance_criteria -- reconstruct from implementation
- (C) Phase not executed -- exit with guidance

Output: validation report on the bead + generated test files if gaps found.
</objective>

<context>
Read the Forge conventions: @~/.claude/forge/references/conventions.md
</context>

<execution_context>
Execute the validate-phase workflow from @~/.claude/forge/workflows/validate-phase.md end-to-end.

When resolving the phase (step 1), use forge-tools:
```bash
node "$HOME/.claude/forge/bin/forge-tools.cjs" find-project
node "$HOME/.claude/forge/bin/forge-tools.cjs" project-context <project-id>
```

When loading tasks for validation (step 2), use:
```bash
node "$HOME/.claude/forge/bin/forge-tools.cjs" verify-phase <phase-id>
```

This returns all tasks with their acceptance criteria pre-loaded.

When spawning verification agents for deep checks (step 5), use **forge-verifier** agents.
Resolve the model:
```bash
MODEL=$(node "$HOME/.claude/forge/bin/forge-tools.cjs" resolve-model forge-verifier --raw)
```

After validation, update task beads with coverage status:
```bash
bd comments add <task-id> "Validation: <COVERED|PARTIAL|MISSING> - <details>"
```
</execution_context>
