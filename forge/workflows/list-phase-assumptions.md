<purpose>
Surface Claude's assumptions about a phase before planning, enabling users to correct misconceptions early.

Key difference from discuss-phase: This is ANALYSIS of what Claude thinks, not INTAKE of what user knows.
No file output -- purely conversational to prompt discussion. User corrections are stored on the phase bead
so forge:plan can consume them.
</purpose>

<process>

<step name="resolve_phase" priority="first">
Phase number or ID from argument (required).

**If argument missing:**

```
Error: Phase number or ID required.

Usage: /forge:list-phase-assumptions <phase-number-or-id>
Example: /forge:list-phase-assumptions 3
```

Exit workflow.

**If argument provided:**

```bash
PROJECT=$(node "$HOME/.claude/forge/bin/forge-tools.cjs" find-project)
```

Extract the project ID, then:
```bash
CONTEXT=$(node "$HOME/.claude/forge/bin/forge-tools.cjs" project-context <project-id>)
```

Match the phase number to the ordered list of phases. If a phase ID was given directly, use it.

**If phase not found:**
```
Phase [X] not found in project.

Use /forge:progress to see available phases.
```
Exit workflow.

**If phase found:** Extract phase ID, title, description. Continue to load_context.
</step>

<step name="load_context">
Load project-level and prior phase context to ground the analysis.

**Step 1: Read project bead**
```bash
bd show <project-id> --json
```

Extract from project bead:
- **description** -- Vision, principles, non-negotiables
- **design** -- Scope/constraints
- **notes** -- Any approach decisions

**Step 2: Read prior phase context**

From the project-context output, for each phase before the current one:
- Read the `notes` field -- these are locked preferences and decisions
- Note any patterns (e.g., "user consistently prefers minimal UI")

**Step 3: Read phase bead details**
```bash
bd show <phase-id> --json
```

Extract the phase description, any existing notes, and requirement beads it validates:
```bash
bd dep list <phase-id> --type validates
```

This context grounds assumptions in actual project state rather than guessing from title alone.
</step>

<step name="analyze_phase">
Based on the phase description, project context, and prior phase decisions, identify assumptions
across five areas.

**1. Technical Approach:**
What libraries, frameworks, patterns, or tools would Claude use?
- "I'd use X library because..."
- "I'd follow Y pattern because..."
- "I'd structure this as Z because..."

**2. Implementation Order:**
What would Claude build first, second, third?
- "I'd start with X because it's foundational"
- "Then Y because it depends on X"
- "Finally Z because..."

**3. Scope Boundaries:**
What's included vs excluded in Claude's interpretation?
- "This phase includes: A, B, C"
- "This phase does NOT include: D, E, F"
- "Boundary ambiguities: G could go either way"

**4. Risk Areas:**
Where does Claude expect complexity or challenges?
- "The tricky part is X because..."
- "Potential issues: Y, Z"
- "I'd watch out for..."

**5. Dependencies:**
What does Claude assume exists or needs to be in place?
- "This assumes X from previous phases"
- "External dependencies: Y, Z"
- "This will be consumed by..."

**Grounding rules:**
- Check prior phase notes before assuming -- if a decision was already made, reference it
- Mark assumptions with confidence levels:
  - "Fairly confident: ..." (clear from phase description or project context)
  - "Assuming: ..." (reasonable inference)
  - "Unclear: ..." (could go multiple ways)
- Be honest about uncertainty -- the whole point is to surface what might be wrong
</step>

<step name="present_assumptions">
Present assumptions in a clear, scannable format:

```
## My Assumptions for Phase [X]: [Phase Name]

### Technical Approach
[List assumptions about how to implement]

### Implementation Order
[List assumptions about sequencing]

### Scope Boundaries
**In scope:** [what's included]
**Out of scope:** [what's excluded]
**Ambiguous:** [what could go either way]

### Risk Areas
[List anticipated challenges]

### Dependencies
**From prior phases:** [what's needed]
**External:** [third-party needs]
**Feeds into:** [what future phases need from this]

---

**What do you think?**

Are these assumptions accurate? Let me know:
- What I got right
- What I got wrong
- What I'm missing
```

Wait for user response.
</step>

<step name="gather_feedback">
**If user provides corrections:**

Acknowledge each correction clearly:

```
Key corrections:
- [correction 1]
- [correction 2]

This changes my understanding of [area]. [Summarize updated understanding]
```

Store corrections on the phase bead so forge:plan can consume them:
```bash
bd update <phase-id> --notes "<structured corrections block>"
```

The notes block should be structured as:
```markdown
# Phase [X]: [Name] - Assumption Review

**Reviewed:** [date]

## Confirmed Assumptions
- [assumption that user confirmed]

## Corrections
- [original assumption] -> [user's correction]

## Additional Context
- [anything the user added that wasn't in the original assumptions]
```

**If user confirms all assumptions:**

```
Assumptions validated. These will inform planning.
```

Store a brief confirmation note:
```bash
bd update <phase-id> --notes "Assumptions reviewed [date]: all confirmed. Ready for planning."
```

Continue to offer_next.
</step>

<step name="offer_next">
Present next steps:

```
What's next?
1. /forge:discuss-phase [X] -- Let me ask YOU questions to build comprehensive context
2. /forge:plan [X] -- Create detailed execution plans (assumptions will inform planning)
3. Re-examine assumptions -- I'll analyze again with your corrections
```

Use AskUserQuestion:
- header: "Next"
- question: "What would you like to do?"
- options:
  - "Discuss context (/forge:discuss-phase)" -- deep-dive into implementation decisions
  - "Plan this phase (/forge:plan)" -- proceed to planning with current understanding
  - "Re-examine assumptions" -- analyze again with corrections applied

If "Discuss context": Note that phase bead notes will inform the discussion
If "Plan this phase": Note that assumptions/corrections are stored and will be consumed
If "Re-examine": Return to analyze_phase with updated understanding from corrections
</step>

</process>

<success_criteria>
- Phase number validated against project
- Project context and prior phase decisions loaded
- Assumptions surfaced across five areas: technical approach, implementation order, scope, risks, dependencies
- Confidence levels marked where appropriate
- "What do you think?" prompt presented
- User feedback acknowledged and stored on phase bead
- Corrections structured for downstream consumption by forge:plan
- Clear next steps offered
</success_criteria>
