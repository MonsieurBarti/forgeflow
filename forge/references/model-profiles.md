# Model Profiles

Model profiles control which Claude model each Forge agent uses. This allows balancing quality vs token spend.

## Profile Definitions

| Agent | `quality` | `balanced` | `budget` |
|-------|-----------|------------|----------|
| forge-planner | opus | opus | sonnet |
| forge-roadmapper | opus | sonnet | sonnet |
| forge-executor | opus | sonnet | sonnet |
| forge-researcher | opus | sonnet | haiku |
| forge-verifier | sonnet | sonnet | haiku |
| forge-plan-checker | sonnet | sonnet | haiku |
| forge-debugger | opus | sonnet | sonnet |
| forge-codebase-mapper | sonnet | haiku | haiku |

## Profile Philosophy

**quality** - Maximum reasoning power
- Opus for all decision-making agents
- Sonnet for read-only verification
- Use when: quota available, critical architecture work

**balanced** (default) - Smart allocation
- Opus only for planning (where architecture decisions happen)
- Sonnet for execution and research (follows explicit instructions)
- Sonnet for verification (needs reasoning, not just pattern matching)
- Use when: normal development, good balance of quality and cost

**budget** - Minimal Opus usage
- Sonnet for anything that writes code
- Haiku for research and verification
- Use when: conserving quota, high-volume work, less critical phases

## Resolution Logic

1. Read settings (global + project layers from forge:settings)
2. Check `model_overrides` for agent-specific override
3. If no override, look up agent in profile table for active profile
4. Return `inherit` for opus-tier (avoids version conflicts)
5. Pass model parameter to Agent/Task call

## Per-Agent Overrides

Override specific agents without changing the entire profile:

```yaml
# In .forge/settings.yaml or ~/.claude/forge.local.md
model_overrides:
  forge-executor: opus
  forge-planner: haiku
```

Overrides take precedence over the profile. Valid values: `opus`, `sonnet`, `haiku`.

## Switching Profiles

Runtime: `/gsd:set-profile <profile>`

Settings key: `model_profile` (values: `quality`, `balanced`, `budget`)

## Design Rationale

**Why `inherit` instead of passing `opus` directly?**
Claude Code's `"opus"` alias maps to a specific model version. Organizations may
block older opus versions while allowing newer ones. Forge returns `"inherit"` for
opus-tier agents, causing them to use whatever opus version the user has configured
in their session. This avoids version conflicts and silent fallbacks to Sonnet.

**Why Opus for forge-planner?**
Planning involves architecture decisions, goal decomposition, and task design.
This is where model quality has the highest impact.

**Why Sonnet for forge-executor?**
Executors follow explicit PLAN.md instructions. The plan already contains the
reasoning; execution is implementation.

**Why Sonnet (not Haiku) for verifiers in balanced?**
Verification requires goal-backward reasoning -- checking if code delivers what
the phase promised, not just pattern matching. Sonnet handles this well; Haiku
may miss subtle gaps.

**Why Haiku for forge-codebase-mapper?**
Read-only exploration and pattern extraction. No reasoning required, just
structured output from file contents.
