<purpose>
Orchestrate parallel codebase mapper agents to analyze codebase and produce structured documents in .forge/codebase/

Each agent has fresh context, explores a specific focus area, and writes documents directly. The orchestrator only receives confirmation + line counts, then writes a summary.

Output: .forge/codebase/ folder with 7 structured documents about the codebase state.
</purpose>

<philosophy>
**Why dedicated mapper agents:**
- Fresh context per domain (no token contamination)
- Agents write documents directly (no context transfer back to orchestrator)
- Orchestrator only summarizes what was created (minimal context usage)
- Faster execution (agents run simultaneously)

**Document quality over length:**
Include enough detail to be useful as reference. Prioritize practical examples (especially code patterns) over arbitrary brevity.

**Always include file paths:**
Documents are reference material for Claude when planning/executing. Always include actual file paths formatted with backticks: `src/services/user.ts`.
</philosophy>

<process>

<step name="check_existing">
Check if .forge/codebase/ already exists:

```bash
ls -la .forge/codebase/ 2>/dev/null
```

**If exists:**

```
.forge/codebase/ already exists with these documents:
[List files found]

What's next?
1. Refresh - Delete existing and remap codebase
2. Update - Keep existing, only update specific documents
3. Skip - Use existing codebase map as-is
```

Wait for user response.

If "Refresh": Delete .forge/codebase/, continue to create_structure
If "Update": Ask which documents to update, continue to spawn_agents (filtered)
If "Skip": Exit workflow

**If doesn't exist:**
Continue to create_structure.
</step>

<step name="create_structure">
Create .forge/codebase/ directory:

```bash
mkdir -p .forge/codebase
```

**Expected output files:**
- STACK.md (from tech mapper)
- INTEGRATIONS.md (from tech mapper)
- ARCHITECTURE.md (from arch mapper)
- STRUCTURE.md (from arch mapper)
- CONVENTIONS.md (from quality mapper)
- TESTING.md (from quality mapper)
- CONCERNS.md (from concerns mapper)

Continue to spawn_agents.
</step>

<step name="spawn_agents">
Spawn 4 parallel forge-codebase-mapper agents.

Use Agent tool with `subagent_type="forge-codebase-mapper"` and `run_in_background=true` for parallel execution.

**CRITICAL:** Use the dedicated `forge-codebase-mapper` agent, NOT `Explore`. The mapper agent writes documents directly.

**Agent 1: Tech Focus**

```
Agent(
  subagent_type="forge-codebase-mapper",
  run_in_background=true,
  description="Map codebase tech stack",
  prompt="Focus: tech

Analyze this codebase for technology stack and external integrations.

Write these documents to .forge/codebase/:
- STACK.md - Languages, runtime, frameworks, dependencies, configuration
- INTEGRATIONS.md - External APIs, databases, auth providers, webhooks

Explore thoroughly. Write documents directly using templates. Return confirmation only."
)
```

**Agent 2: Architecture Focus**

```
Agent(
  subagent_type="forge-codebase-mapper",
  run_in_background=true,
  description="Map codebase architecture",
  prompt="Focus: arch

Analyze this codebase architecture and directory structure.

Write these documents to .forge/codebase/:
- ARCHITECTURE.md - Pattern, layers, data flow, abstractions, entry points
- STRUCTURE.md - Directory layout, key locations, naming conventions

Explore thoroughly. Write documents directly using templates. Return confirmation only."
)
```

**Agent 3: Quality Focus**

```
Agent(
  subagent_type="forge-codebase-mapper",
  run_in_background=true,
  description="Map codebase conventions",
  prompt="Focus: quality

Analyze this codebase for coding conventions and testing patterns.

Write these documents to .forge/codebase/:
- CONVENTIONS.md - Code style, naming, patterns, error handling
- TESTING.md - Framework, structure, mocking, coverage

Explore thoroughly. Write documents directly using templates. Return confirmation only."
)
```

**Agent 4: Concerns Focus**

```
Agent(
  subagent_type="forge-codebase-mapper",
  run_in_background=true,
  description="Map codebase concerns",
  prompt="Focus: concerns

Analyze this codebase for technical debt, known issues, and areas of concern.

Write this document to .forge/codebase/:
- CONCERNS.md - Tech debt, bugs, security, performance, fragile areas

Explore thoroughly. Write document directly using template. Return confirmation only."
)
```

Continue to collect_confirmations.
</step>

<step name="collect_confirmations">
Wait for all 4 agents to complete.

Read each agent's output to collect confirmations.

**Expected confirmation format from each agent:**
```
## Mapping Complete

**Focus:** {focus}
**Documents written:**
- `.forge/codebase/{DOC1}.md` ({N} lines)
- `.forge/codebase/{DOC2}.md` ({N} lines)

Ready for orchestrator summary.
```

**What you receive:** Just file paths and line counts. NOT document contents.

If any agent failed, note the failure and continue with successful documents.

Continue to verify_output.
</step>

<step name="verify_output">
Verify all documents created successfully:

```bash
ls -la .forge/codebase/
wc -l .forge/codebase/*.md
```

**Verification checklist:**
- All 7 documents exist
- No empty documents (each should have >20 lines)

If any documents missing or empty, note which agents may have failed.

Continue to persist_intelligence.
</step>

<step name="persist_intelligence">
Persist key codebase insights to bd memories for fast agent lookup.

This step extracts concise summaries from the generated `.forge/codebase/` documents and saves them as granular memory keys. These memories give agents quick context about the codebase without needing to read the full documents.

**Note:** `bd remember` overwrites existing values by default, so re-running map-codebase will refresh all memories with the latest analysis.

For each memory key below, read the source document, extract a focused 3-8 line summary, and save it:

**1. Stack summary (from STACK.md):**
```bash
# Read .forge/codebase/STACK.md and extract: languages, runtime, frameworks, key dependencies
bd remember --key "forge:codebase:stack" "<concise 3-8 line summary of languages, runtime, frameworks, and key dependencies>"
```

**2. Architecture summary (from ARCHITECTURE.md):**
```bash
# Read .forge/codebase/ARCHITECTURE.md and extract: pattern, layers, data flow, entry points
bd remember --key "forge:codebase:arch" "<concise 3-8 line summary of architectural pattern, layers, data flow, and entry points>"
```

**3. Commands summary (from STACK.md):**
```bash
# Read .forge/codebase/STACK.md and extract: build, test, run, lint commands
bd remember --key "forge:codebase:commands" "<concise 3-8 line summary of build, test, run, and lint commands>"
```

**4. Conventions summary (from CONVENTIONS.md):**
```bash
# Read .forge/codebase/CONVENTIONS.md and extract: code style, naming, error handling patterns
bd remember --key "forge:codebase:conventions" "<concise 3-8 line summary of code style, naming conventions, and error handling patterns>"
```

**5. Concerns summary (from CONCERNS.md):**
```bash
# Read .forge/codebase/CONCERNS.md and extract: top tech debt items, fragile areas
bd remember --key "forge:codebase:concerns" "<concise 3-8 line summary of top technical debt items and fragile areas>"
```

After saving all 5 memories, verify they were persisted:

```bash
bd memories forge:codebase:
```

Continue to scan_for_secrets.
</step>

<step name="scan_for_secrets">
**CRITICAL SECURITY CHECK:** Scan output files for accidentally leaked secrets before committing.

Run secret pattern detection:

```bash
# Check for common API key patterns in generated docs
grep -E '(sk-[a-zA-Z0-9]{20,}|sk_live_[a-zA-Z0-9]+|sk_test_[a-zA-Z0-9]+|ghp_[a-zA-Z0-9]{36}|gho_[a-zA-Z0-9]{36}|glpat-[a-zA-Z0-9_-]+|AKIA[A-Z0-9]{16}|xox[baprs]-[a-zA-Z0-9-]+|-----BEGIN.*PRIVATE KEY|eyJ[a-zA-Z0-9_-]+\.eyJ[a-zA-Z0-9_-]+\.)' .forge/codebase/*.md 2>/dev/null && SECRETS_FOUND=true || SECRETS_FOUND=false
```

**If SECRETS_FOUND=true:**

```
SECURITY ALERT: Potential secrets detected in codebase documents!

Found patterns that look like API keys or tokens in:
[show grep output]

This would expose credentials if committed.

**Action required:**
1. Review the flagged content above
2. If these are real secrets, they must be removed before committing
3. Consider adding sensitive files to Claude Code "Deny" permissions

Pausing before commit. Reply "safe to proceed" if the flagged content is not actually sensitive, or edit the files first.
```

Wait for user confirmation before continuing to commit_codebase_map.

**If SECRETS_FOUND=false:**

Continue to commit_codebase_map.
</step>

<step name="commit_codebase_map">
Commit the codebase map:

```bash
git add .forge/codebase/*.md
git commit -m "docs: map existing codebase

Analyzed codebase with parallel mapper agents.
Created .forge/codebase/ with 7 structured documents."
```

Continue to offer_next.
</step>

<step name="offer_next">
Present completion summary and next steps.

**Get line counts:**
```bash
wc -l .forge/codebase/*.md
```

**Output format:**

```
Codebase mapping complete.

Created .forge/codebase/:
- STACK.md ([N] lines) - Technologies and dependencies
- ARCHITECTURE.md ([N] lines) - System design and patterns
- STRUCTURE.md ([N] lines) - Directory layout and organization
- CONVENTIONS.md ([N] lines) - Code style and patterns
- TESTING.md ([N] lines) - Test structure and practices
- INTEGRATIONS.md ([N] lines) - External services and APIs
- CONCERNS.md ([N] lines) - Technical debt and issues


---

## Next Up

**Initialize project** -- use codebase context for planning

`/forge:new`

---

**Also available:**
- Re-run mapping: `/forge:map-codebase`
- Review specific file: `cat .forge/codebase/STACK.md`
- Edit any document before proceeding

---
```

End workflow.
</step>

</process>
</output>
