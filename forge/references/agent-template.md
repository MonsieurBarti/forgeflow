# Agent Template Reference

This document defines the standard structure for Forge agents. Use it as a blueprint
when creating new agents -- copy the skeleton, fill in your sections, and delete what
you do not need.

## Design principles

- **Under 200 lines.** Most agents land between 100-160 lines. If yours exceeds 200,
  you are probably encoding domain knowledge that belongs in a reference doc instead.
  The debugger (351 lines) and codebase-mapper (406 lines) are outliers with good
  reason -- do not use them as sizing models.
- **Vibe implies behavioral bias.** The vibe is not a job title or description. It
  tells the agent HOW to behave, not WHAT it does. Good: "Trust but verify -- then
  verify again". Bad: "Verifies tasks". The vibe should create a behavioral bias that
  resolves ambiguity in a predictable direction.
- **Sections are XML tags.** The agent file mixes YAML frontmatter with XML-tagged
  sections. The LLM reads these as structured instructions.
- **code_navigation uses an include.** Every agent that reads code should include
  `@forge/references/code-graph.md` rather than duplicating navigation instructions.

## Standard sections

The table below lists all standard sections. "Required" means every agent should have
it. "Optional" means include it only when relevant to the agent's role.

| Section | Required | Purpose |
|---------|----------|---------|
| Frontmatter | Yes | Identity, tool access, visual metadata |
| role | Yes | What the agent is and what it does |
| philosophy | Yes | How the agent thinks and resolves ambiguity |
| code_navigation | Yes* | Code-graph integration (skip only for agents that never read code) |
| execution_flow | Yes | Step-by-step process the agent follows |
| success_metrics | Yes | How to measure whether the agent performed well |
| deliverables | Yes | Concrete outputs the agent produces |
| constraints | Yes | Hard rules the agent must not violate |
| parallel_safety | Recommended | How to behave when running concurrently with other agents |
| deviation_rules | Optional | How to handle unexpected situations (mainly for executor-type agents) |
| output_format | Optional | Structured output schema (for audit agents that produce JSON) |

---

## Frontmatter

**Required.** YAML block at the top of every agent file.

```yaml
---
name: forge-<agent-name>
emoji: <single emoji keyword>
vibe: <behavioral bias in one sentence>
description: <what this agent does, when to use it -- 1-2 sentences>
tools: <comma-separated list of Claude tools the agent needs>
color: <display color for UI>
---
```

**Field notes:**

- `name`: Always prefixed with `forge-`. Lowercase, hyphen-separated.
- `emoji`: A single keyword (not a Unicode character). Examples: `hammer`, `shield`, `bug`, `compass`.
- `vibe`: One sentence that implies a behavioral bias. This is the most important line
  in the frontmatter -- it sets the agent's personality. Ask: "When this agent faces
  ambiguity, which direction should it lean?"
- `description`: Functional description. Mention when/why another agent or orchestrator
  would spawn this agent.
- `tools`: Only list tools the agent actually uses. Common sets:
  - Read-only agents: `Read, Bash, Grep, Glob`
  - Code-modifying agents: `Read, Write, Edit, Bash, Grep, Glob`
  - Research agents: add `WebSearch, WebFetch`
- `color`: For UI rendering. Pick something distinct from existing agents.

**Examples from existing agents:**

- `agents/forge-executor.md`: `vibe: Builds what the plan says, nothing more`
- `agents/forge-verifier.md`: `vibe: Trust but verify -- then verify again`
- `agents/forge-security-auditor.md`: `vibe: Finds what attackers would find first`
- `agents/forge-researcher.md`: `vibe: Looks before the team leaps`

---

## role

**Required.** Defines the agent's identity and primary responsibility.

```xml
<role>
You are a Forge <role-name> agent. Your job is to <primary responsibility>.
<Additional context about when/how the agent is spawned, if relevant.>
</role>
```

Keep this to 2-5 sentences. The role answers "what are you?" -- the philosophy answers
"how do you think?"

**Example** (from `agents/forge-verifier.md`):

```xml
<role>
You are a Forge verifier agent. Your job is to verify that completed tasks actually
meet their acceptance criteria. You run automated checks, inspect code, and produce
a verification report.
</role>
```

---

## philosophy

**Required.** Establishes the agent's decision-making framework. Each principle should
be a bolded one-liner followed by 1-2 sentences of explanation.

```xml
<philosophy>
**<Principle as imperative statement.>** <Why this matters and what it means in practice.
1-2 sentences.>

**<Another principle.>** <Explanation.>

**<Another principle.>** <Explanation.>
</philosophy>
```

Aim for 3-5 principles. Each one should help the agent resolve a specific type of
ambiguity it will face. Avoid generic advice ("be careful") -- every principle should
be specific enough to produce a different behavior if removed.

**Example** (from `agents/forge-executor.md`):

```xml
<philosophy>
**Read before you write.** Every minute spent understanding existing code saves ten
minutes of rework. You are not here to invent -- you are here to build what the plan
describes, in the style the codebase already uses.

**Scope is sacred.** The task description is your contract. If something is not in the
acceptance criteria, it is not your job. Resist the urge to refactor, optimize, or
"improve" things outside your scope.
</philosophy>
```

---

## code_navigation

**Required for any agent that reads source code.** Uses an include reference to the
shared code-graph instructions. Do not duplicate code-graph instructions in individual
agents.

```xml
<code_navigation>
@forge/references/code-graph.md
</code_navigation>
```

This injects the code-graph CLI reference (find, refs, context, impact, stats, circular)
and fallback behavior for when code-graph is not installed. Every agent that inspects
source code should include this section verbatim.

Skip this section only for agents that never need to navigate code (rare).

---

## execution_flow

**Required.** The step-by-step process the agent follows. Each step is a named XML
element inside the flow.

```xml
<execution_flow>

<step name="step_name">
Description of what this step does.
- Bullet points for sub-actions
- Include bash commands or code snippets where helpful:
```bash
example-command --flag <placeholder>
```
</step>

<step name="another_step">
Description of the next step.
</step>

</execution_flow>
```

**Guidelines:**

- Name steps with lowercase, underscore-separated identifiers.
- Steps should be sequential -- the agent follows them in order.
- Include concrete commands (bd, git, test runners) where applicable.
- 3-6 steps is typical. More than 8 suggests the agent is doing too much.

**Example** (from `agents/forge-researcher.md`):

```xml
<execution_flow>

<step name="understand">
Read the phase description and related requirements.
Understand what needs to be built and why.
</step>

<step name="explore_codebase">
Explore the existing codebase to understand:
- Current architecture and patterns
- Existing utilities and abstractions that can be reused
- Testing patterns in use
</step>

<step name="research_external">
If the phase involves external libraries or unfamiliar patterns:
- Search for best practices
- Check documentation for key libraries
- Look for common pitfalls and known issues
</step>

<step name="synthesize">
Produce a research summary covering:
1. Recommended approach
2. Key patterns
3. Reuse opportunities
4. Pitfalls
5. Complexity estimate
</step>

</execution_flow>
```

---

## success_metrics

**Required.** Measurable criteria for evaluating agent performance. Use bolded metric
names followed by a colon and the target.

```xml
<success_metrics>
- **<Metric name>:** <Measurable target or definition of success>
- **<Metric name>:** <Measurable target>
- **<Metric name>:** <Measurable target>
</success_metrics>
```

Aim for 3-5 metrics. Each should be observable -- if you cannot tell whether the metric
was met by looking at the agent's output, it is too vague.

**Example** (from `agents/forge-planner.md`):

```xml
<success_metrics>
- **Requirement coverage:** 100% of milestone requirements have at least one validates
  link from a task
- **Task independence:** At least 50% of tasks within a phase have no inter-task
  dependencies
- **Acceptance criteria quality:** Zero tasks flagged by plan-checker for vague or
  missing acceptance criteria
</success_metrics>
```

---

## deliverables

**Required.** Concrete outputs the agent produces. Be specific about format and
destination.

```xml
<deliverables>
- **<Deliverable name>:** <What it is, where it goes, what format>
- **<Deliverable name>:** <Description>
</deliverables>
```

**Example** (from `agents/forge-executor.md`):

```xml
<deliverables>
- **Code changes:** Files modified/created per the task description, matching project
  conventions
- **Atomic commit:** Single git commit with descriptive message referencing the task ID
- **Completion signal:** `bd update --notes="EXECUTION_COMPLETE: summary"` so the
  verifier can review and close
- **Blocker report (if applicable):** `bd update` with notes describing what is blocked
  and why
</deliverables>
```

---

## constraints

**Required.** Hard rules the agent must never violate. Write these as "Never..." or
"Do NOT..." statements for clarity.

```xml
<constraints>
- Never <prohibited action>
- Do NOT <another prohibited action>
- Always <required behavior>
- <Specific limitation on tool usage or scope>
</constraints>
```

Keep constraints to 4-7 items. If you need more, some may belong in the philosophy
section as soft guidance rather than hard rules.

**Example** (from `agents/forge-verifier.md`):

```xml
<constraints>
- Do NOT modify any code -- verification only
- Be thorough but practical
- If a criterion is ambiguous, note it rather than failing
- Always run the project's test suite as part of verification
- Never pass a task without checking every listed acceptance criterion
- Never report a failure without specifying which criterion failed and why
</constraints>
```

---

## parallel_safety

**Recommended.** Describes how the agent behaves when running concurrently with other
agents. Important for any agent that modifies files or state.

```xml
<parallel_safety>
When running in parallel with other <agent-type> agents:
- <Safety guarantee or behavior>
- <How conflicts are avoided or detected>
- <What to do if interference is detected>
</parallel_safety>
```

For read-only agents, this can be brief:

```xml
<parallel_safety>
Strictly read-only. Safe to run concurrently with any other agent.
</parallel_safety>
```

For agents that modify files or state, be specific about what they touch and how they
avoid conflicts.

---

## deviation_rules (optional)

For agents that may encounter unexpected situations (primarily executor-type agents).
Defines escalation behavior.

```xml
<deviation_rules>
If you encounter something unexpected:
1. Minor issues (typo, small refactor needed): fix it as part of the task
2. Related but separate work: create a new bead with discovered-from link
3. Blocking issues: update the task notes and do NOT close it
</deviation_rules>
```

---

## output_format (optional)

For audit agents that produce structured JSON output. Defines the schema and formatting
rules.

```xml
<output_format>
**CRITICAL: Final output MUST be raw JSON conforming to the audit findings schema.**

- No markdown fences around JSON. No commentary before or after.
- Agent identifier: `<agent-name>`
- Valid categories: <list>
</output_format>
```

See `agents/forge-security-auditor.md` and `agents/forge-performance-auditor.md` for
full examples of this pattern.

---

## Complete skeleton

Below is a minimal, copyable agent template. Replace all `<placeholders>` with your
values and remove sections marked optional if not needed.

```markdown
---
name: forge-<agent-name>
emoji: <emoji-keyword>
vibe: <behavioral bias -- not a job description>
description: <1-2 sentence description of what this agent does and when to use it>
tools: Read, Bash, Grep, Glob
color: <color>
---

<role>
You are a Forge <role-name> agent. Your job is to <primary responsibility in one
sentence>. <Additional context about spawning or scope.>
</role>

<philosophy>
**<Principle 1.>** <Why it matters. 1-2 sentences.>

**<Principle 2.>** <Why it matters. 1-2 sentences.>

**<Principle 3.>** <Why it matters. 1-2 sentences.>
</philosophy>

<code_navigation>
@forge/references/code-graph.md
</code_navigation>

<execution_flow>

<step name="step_one">
<What this step does.>
</step>

<step name="step_two">
<What this step does.>
</step>

<step name="step_three">
<What this step does.>
</step>

</execution_flow>

<success_metrics>
- **<Metric>:** <Measurable target>
- **<Metric>:** <Measurable target>
- **<Metric>:** <Measurable target>
</success_metrics>

<deliverables>
- **<Deliverable>:** <What, where, format>
- **<Deliverable>:** <What, where, format>
</deliverables>

<constraints>
- Never <prohibited action>
- Do NOT <prohibited action>
- Always <required behavior>
</constraints>

<parallel_safety>
When running in parallel with other agents:
- <Safety guarantee>
- <Conflict avoidance strategy>
</parallel_safety>
```

---

## Reference agents

These existing agents illustrate the pattern well at different complexity levels:

| Agent | Lines | Good example of |
|-------|-------|-----------------|
| `agents/forge-researcher.md` | 102 | Minimal agent -- clean, focused, under 110 lines |
| `agents/forge-verifier.md` | 116 | Standard pattern with all core sections |
| `agents/forge-executor.md` | 140 | Includes deviation_rules for handling unexpected work |
| `agents/forge-security-auditor.md` | 156 | Audit agent with output_format and structured JSON |
| `agents/forge-planner.md` | 121 | Clear execution steps with concrete bd commands |
