---
name: forge:help
description: Show available Forge commands and usage guide
argument-hint: ""
allowed-tools: Read, Bash
---

<objective>
Display the complete Forge command reference.

Output ONLY the reference content below. Do NOT add:
- Project-specific analysis
- Git status or file context
- Next-step suggestions
- Any commentary beyond the reference
</objective>

<execution_context>
@~/.claude/forge/workflows/help.md
</execution_context>

<process>
Output the complete Forge command reference from @~/.claude/forge/workflows/help.md.
Display the reference content directly — no additions or modifications.
</process>
