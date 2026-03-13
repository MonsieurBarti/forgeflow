<purpose>
Initialize a new Forge project. Guide the user through defining their vision, requirements,
and a phased roadmap -- all stored as structured beads with dependency relationships.

IMPORTANT: One project per repository. The project bead represents the entire product and
is NEVER closed. It stays open for the lifetime of the repository. New work is always
organized as milestones under the existing project via /forge:new-milestone.
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

## 0.5. Offer DoltHub Remote Setup

Check if a Dolt remote is already configured:
```bash
bd dolt remote list 2>&1
```

If **no remotes configured** and bead tracking was just initialized (step 0 ran `bd init`),
offer the user the option to set up DoltHub sync for their beads data.

Use AskUserQuestion:
- "Would you like to sync your project tracking data to DoltHub? This enables backup and collaboration. Free for public repos, free up to 1GB for private."
- Options: "Yes, set up DoltHub sync" / "No, keep beads local only"

If the user chooses yes:

1. **Check Dolt credentials exist:**
```bash
dolt creds ls 2>&1
```
If no credentials, run `dolt login` and wait for the user to complete browser auth.

2. **Ask for repo details** using AskUserQuestion:
   - Repo name (default: same as the directory name)
   - Visibility: Public (free unlimited) or Private (free up to 1GB, requires credit card on DoltHub)

3. **Guide repo creation:**
   DoltHub repos cannot be created via CLI — the user must create it on the web or via API token.

   Ask: "Do you have a DoltHub API token, or would you prefer to create the repo on the web?"
   - If **API token**: create the repo via API:
     ```bash
     curl -s -X POST "https://www.dolthub.com/api/v1alpha1/database" \
       -H "authorization: token <TOKEN>" \
       -H "content-type: application/json" \
       -d '{"ownerName":"<username>","repoName":"<repo-name>","visibility":"<public|private>"}'
     ```
   - If **web**: Tell the user to go to `https://www.dolthub.com/profile/new-repository`,
     create the repo with the chosen name and visibility, and come back.
     Wait for confirmation via AskUserQuestion: "Let me know when the DoltHub repo is created."

4. **Add the remote and push:**
```bash
# Get the Dolt username from config
DOLT_USER=$(dolt config --global --get user.name 2>/dev/null)

# Navigate to the project database inside .beads/dolt/
cd .beads/dolt/<prefix>/ && dolt remote add origin "$DOLT_USER/<repo-name>" && cd -

# Push initial data
bd dolt push
```

5. **Verify round-trip:**
```bash
bd dolt pull
```

If push/pull succeed, confirm: "DoltHub sync is active. Your beads data will sync to
https://www.dolthub.com/<username>/<repo-name>."

If the user declines or if remotes are already configured, skip silently.

## 1. Check for Existing Project

```bash
PROJECT=$(node "$HOME/.claude/forge/bin/forge-tools.cjs" find-project)
```

**HARD GUARD — one project per repository.** If a project already exists:
- Show the existing project name and ID
- Tell the user: "This repository already has a Forge project. Use `/forge:new-milestone` to start a new milestone cycle."
- **STOP.** Do not continue. Do not offer to create another project.

## 2. Gather Project Vision

**Bootstrap context:** Before asking questions, scan the repository for existing context:
- Read `README.md`, `package.json`, `Cargo.toml`, `pyproject.toml`, or equivalent to infer the project name and purpose
- Check git remote (`git remote get-url origin`) to infer the repo name
- Use this as a starting point — pre-fill what you can and only ask about gaps

**The project name should be the repository/product name** (e.g., "ForgeFlow", "MyApp"), NOT a version or milestone label. The project bead represents the entire product, not a release cycle.

**Auto mode** (`--auto @file`): Read the referenced file for context. Extract answers to the questions below from the document. If any are unclear, ask only about those gaps.

**Interactive mode** (default): Use AskUserQuestion to ask these questions one at a time. Adapt follow-up questions based on answers:

1. **What are you building?** (one sentence)
2. **Who is it for?** (target users/audience)
3. **What's the core value proposition?** (why does this need to exist?)
4. **What are the key constraints?** (tech stack, timeline, dependencies, etc.)
5. **What does v1 look like?** (minimum viable scope)

## 3. Create Project Epic

The title must be the **product/repo name** (e.g., "ForgeFlow"), not a version or milestone description.

```bash
bd create --title="<product name>" \
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

## 4. Create Default Milestone

Create a default milestone as a child of the project so that phases have a milestone to attach to:

```bash
bd create --title="Milestone 1" \
  --description="Initial milestone for the project. Covers the first set of phases toward v1." \
  --type=epic --priority=1 --json
```

Label and wire it:
```bash
bd label add <milestone-id> forge:milestone
bd dep add <milestone-id> <project-id> --type=parent-child
```

Save for future reference:
```bash
bd remember --key "forge:session:last-milestone" "<milestone-id>"
```

## 5. Define Requirements

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

## 6. Create Phased Roadmap

Resolve the model for the roadmapper agent:
```bash
MODEL=$(node "$HOME/.claude/forge/bin/forge-tools.cjs" resolve-model forge-roadmapper --raw)
```

Use the Agent tool to spawn **forge-roadmapper** with (pass `model` if non-empty):
- The project ID, milestone ID (Milestone 1), and vision
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
bd dep add <phase-id> <milestone-id> --type=parent-child
bd label add <phase-id> forge:phase

# Wire phase ordering (each phase blocks the next):
bd dep add <phase-2-id> <phase-1-id>  # phase 2 depends on phase 1
bd dep add <phase-3-id> <phase-2-id>  # phase 3 depends on phase 2
# etc.
```

## 7. Show Roadmap

Display the full project structure:
```bash
bd dep tree <project-id>
```

Summarize:
- Project vision (one sentence)
- Default milestone created (Milestone 1)
- N requirements defined
- N phases planned under Milestone 1
- Phase overview (numbered list with titles)
- Next step: `/forge:plan` to plan the first phase

Save project ID for future reference:
```bash
bd remember --key "forge:session:project-id" "<project-id>"
```

</process>
