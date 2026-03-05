<purpose>
Initialize a new Forge project. Guide the user through defining their vision, requirements,
and a phased roadmap -- all stored as structured beads with dependency relationships.
</purpose>

<process>

## 1. Check for Existing Project

```bash
PROJECT=$(node "$HOME/.claude/forge/bin/forge-tools.cjs" find-project)
```

If a project already exists, show it and ask if the user wants to create a new one or work on the existing one.

## 2. Gather Project Vision

If `--auto @file` was provided, read the file for context. Otherwise, ask the user:

Use AskUserQuestion to ask these questions one at a time (adapt based on answers):

1. **What are you building?** (one sentence)
2. **Who is it for?** (target users/audience)
3. **What's the core value proposition?** (why does this need to exist?)
4. **What are the key constraints?** (tech stack, timeline, dependencies, etc.)
5. **What does v1 look like?** (minimum viable scope)

## 3. Create Project Epic

```bash
bd create --title="<project name>" \
  --description="<vision from answers above>" \
  --design="<scope and constraints>" \
  --type=epic --priority=1 --json
```

Then label it:
```bash
bd label add <project-id> forge:project
```

Save the vision as a memory:
```bash
bd remember "forge:project:<id>:vision <one-line vision>"
```

## 4. Define Requirements

Based on the user's v1 description, break it down into 5-12 concrete requirements.
Present them to the user for review before creating.

For each requirement:
```bash
bd create --title="<requirement title>" \
  --description="<what this requirement means>" \
  --acceptance_criteria="<how to know it's done>" \
  --type=feature --priority=<1-3> --json
bd dep add <req-id> <project-id> --type=parent-child
bd label add <req-id> forge:req
```

## 5. Create Phased Roadmap

Analyze the requirements and create 3-8 phases (ordered by dependency and complexity).
Each phase should have a clear goal and map to specific requirements.

Present the proposed phases to the user for review.

For each phase:
```bash
bd create --title="Phase N: <phase name>" \
  --description="<phase goal and what it achieves>" \
  --type=epic --priority=1 --json
bd dep add <phase-id> <project-id> --type=parent-child
bd label add <phase-id> forge:phase
```

Wire up phase ordering (each phase blocks the next):
```bash
bd dep add <phase-2-id> <phase-1-id>  # phase 2 depends on phase 1
bd dep add <phase-3-id> <phase-2-id>  # phase 3 depends on phase 2
# etc.
```

## 6. Show Roadmap

Display the full project structure:
```bash
bd dep tree <project-id>
```

Summarize:
- Project vision
- N requirements defined
- N phases planned
- Next step: `/forge:plan 1` to plan the first phase

Save project ID for future reference:
```bash
bd remember "forge:session:project-id <project-id>"
```

</process>
