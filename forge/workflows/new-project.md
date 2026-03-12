<purpose>
Initialize a new Forge project. Guide the user through defining their vision, requirements,
and a phased roadmap -- all stored as structured beads with dependency relationships.
</purpose>

<process>

## 0. Initialize Bead Tracking

Check whether bead tracking is already initialized for this directory:

```bash
bd status 2>&1
```

If the output indicates bead tracking is not initialized (e.g., "no bead store", "not initialized", or a non-zero exit), ask the user for a short project prefix (e.g., "myapp") and initialize:

```bash
bd init --prefix <project_name>
```

If bead tracking is already initialized, skip this step silently and proceed.

## 1. Check for Existing Project

```bash
PROJECT=$(node "$HOME/.claude/forge/bin/forge-tools.cjs" find-project)
```

If a project already exists, show it and ask if the user wants to create a new one or work on the existing one.

## 2. Gather Project Vision

**Auto mode** (`--auto @file`): Read the referenced file for context. Extract answers to the questions below from the document. If any are unclear, ask only about those gaps.

**Interactive mode** (default): Use AskUserQuestion to ask these questions one at a time. Adapt follow-up questions based on answers:

1. **What are you building?** (one sentence)
2. **Who is it for?** (target users/audience)
3. **What's the core value proposition?** (why does this need to exist?)
4. **What are the key constraints?** (tech stack, timeline, dependencies, etc.)
5. **What does v1 look like?** (minimum viable scope)

## 3. Create Project Epic

```bash
bd create --title="<project name>" \
  --description="<vision synthesized from answers above>" \
  --design="<scope and constraints>" \
  --type=epic --priority=1 --json
```

Then label it:
```bash
bd label add <project-id> forge:project
```

Save the vision as a memory:
```bash
bd remember --key "forge:project:<id>:vision" "<one-line vision>"
```

## 4. Define Requirements

Based on the user's v1 description, break it down into 5-12 concrete requirements.

Present the full list to the user for review before creating any beads. Let them add, remove, or modify requirements. Iterate until they approve.

For each approved requirement, check if a bead with the same title already exists before creating:
```bash
# Check for existing bead with this title (label forge:req)
bd search "<requirement title>" --label forge:req --status all --json
```

- If a match with the exact title is found: skip creation, note "Skipping '<title>' — already exists as <id>", and use the existing ID for any dependency wiring.
- If no match: create normally.

```bash
# Only run if no existing match:
bd create --title="<requirement title>" \
  --description="<what this requirement means and why it matters>" \
  --type=feature --priority=<1-3> --json
bd dep add <req-id> <project-id> --type=parent-child
bd label add <req-id> forge:req
```

## 5. Create Phased Roadmap

Resolve the model for the roadmapper agent:
```bash
MODEL=$(node "$HOME/.claude/forge/bin/forge-tools.cjs" resolve-model forge-roadmapper --raw)
```

Use the Agent tool to spawn **forge-roadmapper** with (pass `model` if non-empty):
- The project ID and vision
- All requirement IDs with their titles and descriptions
- Any user-specified constraints on ordering

The roadmapper will analyze requirements and propose 3-8 phases.

Present the proposed phases to the user for review. Let them reorder, merge, split, or rename phases. Iterate until they approve.

Then create the approved phases. For each phase, check if a bead with the same title already exists before creating:
```bash
# Check for existing bead with this title (label forge:phase)
bd search "<Phase N: phase name>" --label forge:phase --status all --json
```

- If a match with the exact title is found: skip creation, note "Skipping '<title>' — already exists as <id>", and use the existing ID for dependency wiring.
- If no match: create normally.

```bash
# Only run if no existing match:
bd create --title="Phase N: <phase name>" \
  --description="<phase goal and what it achieves>" \
  --type=epic --priority=1 --json
bd dep add <phase-id> <project-id> --type=parent-child
bd label add <phase-id> forge:phase

# Wire phase ordering (each phase blocks the next):
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
- Project vision (one sentence)
- N requirements defined
- N phases planned
- Phase overview (numbered list with titles)
- Next step: `/forge:plan` to plan the first phase

Save project ID for future reference:
```bash
bd remember --key "forge:session:project-id" "<project-id>"
```

</process>
