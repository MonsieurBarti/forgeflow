---
name: forge:config
description: View or modify Forge configuration
argument-hint: "[get|set|list|clear] [key] [value]"
allowed-tools: Bash
---

<objective>
Manage Forge configuration stored in YAML settings files (`.forge/settings.yaml`).
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

**Model profile keys** (per-role model assignment, stored in settings files):

| Key | Description |
|-----|-------------|
| `models.default` | Default model for all agent roles |
| `models.researcher` | Model for researcher agents |
| `models.planner` | Model for planner agents |
| `models.executor` | Model for executor agents |
| `models.verifier` | Model for verifier agents |
| `models.plan_checker` | Model for plan-checker agents |
| `models.roadmapper` | Model for roadmapper agents |

Model config is stored in settings files:
- **Global**: `~/.claude/forge.local.md` (YAML frontmatter)
- **Per-project**: `.forge/settings.yaml`

Set models via settings commands:
```bash
node "$HOME/.claude/forge/bin/forge-tools.cjs" settings-set global models.researcher claude-opus-4-6
node "$HOME/.claude/forge/bin/forge-tools.cjs" settings-set project models.executor claude-haiku-4-5-20251001
```

Resolution order: project `.forge/settings.yaml` > global `forge.local.md` > `models.default` > Claude Code default.

**"show models"**: Show effective model for each role.
```bash
node "$HOME/.claude/forge/bin/forge-tools.cjs" model-profiles
```

Hook/workflow config keys are stored with `forge.` prefix in settings files (e.g., `forge.context_warning`).
Users can specify keys with or without the prefix.

Format output as a readable table showing current values alongside defaults.
</execution_context>
