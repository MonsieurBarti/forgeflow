---
name: forge:verify
description: Verify phase completion against acceptance criteria
argument-hint: "[phase-number-or-id]"
allowed-tools: Read, Write, Bash, Grep, Glob, Agent, AskUserQuestion
---

<objective>
Verify that a phase's tasks meet their acceptance criteria. Run automated checks where possible, then present results to the user for UAT confirmation. Close verified tasks and update phase status.
</objective>

<context>
Read the Forge conventions: @~/.claude/forge/references/conventions.md
</context>

<execution_context>
Execute the verify workflow from @~/.claude/forge/workflows/verify.md end-to-end.

When loading tasks for verification (step 2), use the batch verification command:
```bash
node "$HOME/.claude/forge/bin/forge-tools.cjs" verify-phase <phase-id>
```

This returns all tasks with their acceptance criteria pre-loaded, separated into
closed (to verify) and open (still pending) lists.

When running automated verification (step 3), spawn a **forge-verifier** agent
for parallel verification of multiple tasks. For single-task phases, verify inline.

When presenting UAT results (step 4), use AskUserQuestion for each task or batch
them if there are many. Include the acceptance criteria and automated check results.
</execution_context>
