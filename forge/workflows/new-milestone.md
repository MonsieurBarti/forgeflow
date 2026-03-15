<purpose>
Start a new milestone cycle for an existing Forge project. Loads project context from the bead
graph, gathers milestone goals, creates a milestone epic bead, defines scoped requirements as
forge:req beads, and spawns the roadmapper to create a phased execution plan. Phase numbering
continues from previous work.
</purpose>

<process>

## 1. Find Project

```bash
PROJECT=$(node "$HOME/.claude/forge/bin/forge-tools.cjs" find-project)
```

If no project found, report "No Forge project found" and suggest `/forge:new`. Stop.

Extract the project ID.

## 2. Load Project Context

```bash
node "$HOME/.claude/forge/bin/forge-tools.cjs" project-context-slim <project-id>
```

From the result, extract:
- Project vision and description
- Existing requirements (forge:req beads) -- what's already been built
- Existing phases and their status -- what's been completed
- Any existing milestones (forge:milestone beads)

Present a summary of what shipped in the last milestone (if any).

## 3. Gather Milestone Goals

**If milestone name was passed as argument:** Use it as the starting point.

**Otherwise:** Ask the user with AskUserQuestion:
- header: "New Milestone"
- question: "What do you want to build next?"
- Allow freeform text response

Follow up with probing questions to clarify scope:
- What are the key features or capabilities?
- Who benefits most from this work?
- What constraints or dependencies exist?
- What does "done" look like for this milestone?

## 4. Create Milestone Epic

```bash
bd create --title="Milestone: <name>" \
  --description="<goal synthesized from answers>" \
  --design="<scope, constraints, and definition of done>" \
  --type=epic --priority=1 --json
```

Label and wire it:
```bash
bd label add <milestone-id> forge:milestone
bd dep add <milestone-id> <project-id> --type=parent-child
```

Save for reference:
```bash
bd remember --key "forge:milestone:<id>:goal" "<one-line goal>"
```

## 4b. Create Worktree

Create a git worktree for this milestone so phase work is isolated:
```bash
node "$HOME/.claude/forge/bin/forge-tools.cjs" worktree-create <milestone-id>
```

If the worktree already exists (e.g. re-running new-milestone), this command will report the existing path — treat this as success, not an error.

Get the worktree path and store it on the milestone bead:
```bash
WORKTREE_PATH=$(node "$HOME/.claude/forge/bin/forge-tools.cjs" worktree-path <milestone-id>)
bd remember --key "forge:milestone:<milestone-id>:worktree" "$WORKTREE_PATH"
```

## 5. Research Decision (Optional)

Use AskUserQuestion:
- header: "Research"
- question: "Research the domain ecosystem before creating the roadmap?"
- options:
  - "Research first (Recommended for new capabilities)"
  - "Skip research (go straight to roadmap)"

**If "Research first":**

Resolve the model for the researcher agent:
```bash
MODEL=$(node "$HOME/.claude/forge/bin/forge-tools.cjs" resolve-model forge-researcher --raw)
```

Spawn 2-4 parallel **forge-researcher** agents covering:
- Stack/library choices for new capabilities
- Feature patterns and best practices
- Architecture integration with existing codebase
- Common pitfalls

Record key findings as notes on the milestone bead:
```bash
bd update <milestone-id> --notes="Research findings: <key points>"
```

**If "Skip research":** Continue to step 6.

## 6. Create Phased Roadmap

Resolve the model for the roadmapper agent:
```bash
MODEL=$(node "$HOME/.claude/forge/bin/forge-tools.cjs" resolve-model forge-roadmapper --raw)
```

Use the Agent tool to spawn **forge-roadmapper** with (pass `model` if non-empty):
- The project ID, milestone ID, and milestone goal
- The user's milestone goals (features, constraints, definition of done)
- Phase numbering context (continue from last phase number)
- Any user-specified constraints on ordering

The roadmapper will:
1. Break the milestone goals into 5-12 concrete requirements
2. Propose 3-8 phases, assigning each requirement to the phase that delivers it
3. Create forge:req beads as children of each phase

Present the proposed phases and their requirements to the user for review. Let them reorder, merge, split, rename phases, and add/remove/modify requirements. Iterate until they approve.

Then create the approved phases:
```bash
# Use forge-tools for each phase (handles numbering, validation, and wiring):
node "$HOME/.claude/forge/bin/forge-tools.cjs" add-phase <project-id> <milestone-id> <phase-description>
```

This automatically wires each phase as a child of the milestone (parent-child dependency).
No separate wiring step needed.

For each requirement, create it as a child of its owning phase:
```bash
bd create --title="<requirement title>" \
  --description="<what this requirement means and why it matters>" \
  --type=feature --priority=<1-3> --json
bd dep add <req-id> <phase-id> --type=parent-child
bd label add <req-id> forge:req
```

Requirements are owned by phases, not the milestone. Each phase explicitly declares which
requirements it delivers.

## 7. Show Summary

Display the milestone structure:
```bash
bd dep tree <milestone-id>
```

Summarize:
- Milestone goal (one sentence)
- N requirements defined
- N phases planned
- Phase overview (numbered list with titles)
- Next step: `/forge:plan` to plan the first phase

Save milestone for future reference:
```bash
bd remember --key "forge:session:last-milestone" "<milestone-id>"
```

</process>

<success_criteria>
- [ ] Project found and context loaded
- [ ] Milestone goals gathered from user
- [ ] Milestone epic bead created with forge:milestone label
- [ ] Requirements defined as forge:req beads under phases
- [ ] Research completed (if selected)
- [ ] Roadmapper spawned with phase numbering context
- [ ] Phases created and wired to milestone and project
- [ ] User approved requirements and roadmap
- [ ] Worktree created and path stored via bd remember
- [ ] Summary shown with next steps
</success_criteria>
