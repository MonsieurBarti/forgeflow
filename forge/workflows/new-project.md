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

   Ask: "Do you have a DoltHub API token (or `$DOLTHUB_TOKEN` env var set), or would you prefer to create the repo on the web?"
   - If **API token**: create the repo via API (uses `$DOLTHUB_TOKEN` env var if set, otherwise prompt for token):
     ```bash
     curl -s -X POST "https://www.dolthub.com/api/v1alpha1/database" \
       -H "authorization: token ${DOLTHUB_TOKEN}" \
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

## 4. Gather Milestone Goals

The first milestone captures the user's v1 vision. Reuse answers from step 2 to pre-fill:

- **Milestone name**: Derive from the v1 scope (e.g., "v1.0 — Core MVP"). Ask the user to
  confirm or rename via AskUserQuestion.
- **Goal**: Synthesize from the v1 answer in step 2.
- **Definition of done**: What does "shipped" look like for this milestone?

If the user already described v1 clearly enough in step 2, confirm rather than re-ask:
- header: "First Milestone"
- question: "I'll create your first milestone from the v1 scope you described. Sound good, or would you like to adjust the name/goal?"
- options: "Looks good" / "Let me adjust"

## 5. Create Milestone Epic

```bash
bd create --title="Milestone: <milestone name>" \
  --description="<goal synthesized from v1 answers>" \
  --design="<scope, constraints, and definition of done>" \
  --type=epic --priority=1 --json
```

Label and wire it:
```bash
bd label add <milestone-id> forge:milestone
bd dep add <milestone-id> <project-id> --type=parent-child
```

Save milestone goal and session reference:
```bash
bd remember --key "forge:milestone:<milestone-id>:goal" "<one-line goal>"
bd remember --key "forge:session:last-milestone" "<milestone-id>"
```

### 5b. Create Worktree

Create a git worktree for this milestone so phase work is isolated:
```bash
node "$HOME/.claude/forge/bin/forge-tools.cjs" worktree-create <milestone-id>
```

If the worktree already exists, treat this as success, not an error.

Get the worktree path and store it:
```bash
WORKTREE_PATH=$(node "$HOME/.claude/forge/bin/forge-tools.cjs" worktree-path <milestone-id>)
bd remember --key "forge:milestone:<milestone-id>:worktree" "$WORKTREE_PATH"
```

## 6. Define Requirements

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
bd dep add <req-id> <milestone-id> --type=parent-child
bd label add <req-id> forge:req
```

## 7. Research Decision (Optional)

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

**If "Skip research":** Continue to step 8.

## 8. Create Phased Roadmap

Resolve the model for the roadmapper agent:
```bash
MODEL=$(node "$HOME/.claude/forge/bin/forge-tools.cjs" resolve-model forge-roadmapper --raw)
```

Use the Agent tool to spawn **forge-roadmapper** with (pass `model` if non-empty):
- The project ID, milestone ID, and milestone goal
- All requirement IDs with their titles and descriptions
- Any user-specified constraints on ordering

The roadmapper will analyze requirements and propose 3-8 phases.

Present the proposed phases to the user for review. Let them reorder, merge, split, or rename phases. Iterate until they approve.

Then create the approved phases using forge-tools:
```bash
# Use forge-tools for each phase (handles numbering, validation, and wiring):
node "$HOME/.claude/forge/bin/forge-tools.cjs" add-phase <project-id> <milestone-id> <phase-description>
```

This automatically wires each phase as a child of the milestone (parent-child dependency).
No separate wiring step needed.

## 9. Show Summary

Display the full project structure:
```bash
bd dep tree <project-id>
```

Summarize:
- Project vision (one sentence)
- Milestone goal (one sentence)
- N requirements defined
- N phases planned under the milestone
- Phase overview (numbered list with titles)
- Next step: `/forge:plan` to plan the first phase

Save project ID for future reference:
```bash
bd remember --key "forge:session:project-id" "<project-id>"
```

</process>
