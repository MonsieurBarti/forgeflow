---
name: forge:new
description: Initialize a new Forge project with vision, requirements, and phased roadmap
argument-hint: "[--auto @context-doc.md]"
allowed-tools: Read, Write, Bash, Grep, Glob, Agent, AskUserQuestion
---

<objective>
Initialize a new Forge project backed by beads. Guide the user through defining their project vision, requirements, and a phased roadmap -- all stored as structured beads with dependency relationships.
</objective>

<context>
Read the Forge conventions: @~/.claude/forge/references/conventions.md
</context>

<execution_context>
Execute the new-project workflow from @~/.claude/forge/workflows/new-project.md end-to-end.
</execution_context>
