---
name: forge:config
description: View or modify Forge configuration
argument-hint: "[get|set|list|clear] [key] [value]"
allowed-tools: Bash
---

<objective>
Manage Forge configuration stored in the beads key-value store (`bd kv`).
Configuration controls hook behavior (context thresholds, update checks)
and workflow preferences (auto-research).
</objective>

<execution_context>
Parse the user's intent from the argument:

**No argument or "list"**: Show all Forge config with current values and defaults.
```bash
node "$HOME/.claude/forge/bin/forge-tools.cjs" config-list
```

**"get KEY"**: Get a specific config value.
```bash
node "$HOME/.claude/forge/bin/forge-tools.cjs" config-get KEY
```

**"set KEY VALUE"**: Set a config value.
```bash
node "$HOME/.claude/forge/bin/forge-tools.cjs" config-set KEY VALUE
```

**"clear KEY"**: Remove a config value (revert to default).
```bash
node "$HOME/.claude/forge/bin/forge-tools.cjs" config-clear KEY
```

**Available configuration keys:**

| Key | Default | Description |
|-----|---------|-------------|
| `context_warning` | `0.35` | Context window warning threshold (0-1) |
| `context_critical` | `0.25` | Context window critical/block threshold (0-1) |
| `update_check` | `true` | Check for updates on session start |
| `auto_research` | `true` | Auto-run research before planning |

**Model profile keys** (per-role model assignment):

| Key | Default | Description |
|-----|---------|-------------|
| `model.default` | _(none)_ | Default model for all agent roles |
| `model.researcher` | _(none)_ | Model for researcher agents |
| `model.planner` | _(none)_ | Model for planner agents |
| `model.executor` | _(none)_ | Model for executor agents |
| `model.verifier` | _(none)_ | Model for verifier agents |
| `model.plan_checker` | _(none)_ | Model for plan-checker agents |
| `model.roadmapper` | _(none)_ | Model for roadmapper agents |

Per-project overrides use: `model.<project-id>.<role>` (e.g., `model.gsdb-abc.executor`).

Resolution order: project override > global role > `model.default` > Claude Code default.

**"show models"**: Show effective model for each role.
```bash
node "$HOME/.claude/forge/bin/forge-tools.cjs" model-profiles [project-id]
```

Keys are stored with `forge.` prefix in `bd kv` (e.g., `forge.context_warning`).
Users can specify keys with or without the prefix.

Format output as a readable table showing current values alongside defaults.
</execution_context>
