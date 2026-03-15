<purpose>
Interactive configuration of Forge workflow toggles via multi-question prompt.
Two-layer override: global defaults (~/.claude/forge.local.md) win over built-in
defaults, and per-project overrides (.forge/settings.yaml) win over global.
</purpose>

<process>

<step name="load_current">
Load current effective settings (merged from defaults, global, and project):

```bash
node "$HOME/.claude/forge/bin/forge-tools.cjs" settings-load
```

Parse the result to understand current values and their sources.
</step>

<step name="present_settings">
Use AskUserQuestion with current values pre-selected:

```
AskUserQuestion([
  {
    question: "Auto-run research before planning?",
    header: "Research",
    multiSelect: false,
    options: [
      { label: "Yes", description: "Spawn researcher agent to investigate approach before planning" },
      { label: "No", description: "Skip research, plan directly from requirements" }
    ]
  },
  {
    question: "Run plan checker to validate plans?",
    header: "Plan Check",
    multiSelect: false,
    options: [
      { label: "Yes", description: "Verify plans have acceptance criteria, requirement coverage, correct deps" },
      { label: "No", description: "Skip plan validation" }
    ]
  },
  {
    question: "Require user discussion before planning?",
    header: "Discussion",
    multiSelect: false,
    options: [
      { label: "Yes (Recommended)", description: "Ask user about approach preferences before creating tasks" },
      { label: "No", description: "Plan autonomously without asking" }
    ]
  },
  {
    question: "Skip phase verification after execution?",
    header: "Verification",
    multiSelect: false,
    options: [
      { label: "No (Recommended)", description: "Run verification after phase execution" },
      { label: "Yes", description: "Skip verification, trust task acceptance criteria" }
    ]
  },
  {
    question: "Auto-commit after each completed task?",
    header: "Auto-Commit",
    multiSelect: false,
    options: [
      { label: "Yes (Recommended)", description: "Atomic commits after each task completion" },
      { label: "No", description: "Batch commits manually" }
    ]
  },
  {
    question: "Execute independent tasks in parallel?",
    header: "Parallel",
    multiSelect: false,
    options: [
      { label: "Yes (Recommended)", description: "Run wave tasks concurrently via subagents" },
      { label: "No", description: "Execute tasks sequentially" }
    ]
  },
  {
    question: "Run quality gate before creating PRs?",
    header: "Quality Gate",
    multiSelect: false,
    options: [
      { label: "Yes", description: "Run security, code review, and performance audits before PR" },
      { label: "No", description: "Skip quality gate" }
    ]
  },
  {
    question: "Run shift-left quality gates at plan-time and per-wave?",
    header: "Shift-Left Gates",
    multiSelect: false,
    options: [
      { label: "Yes", description: "Run architect, security, and perf reviews at plan-time and per-wave" },
      { label: "No", description: "Skip shift-left gates, rely on pre-PR quality gate only" }
    ]
  },
  {
    question: "How should shift-left gate findings be handled?",
    header: "Shift-Left Enforcement",
    multiSelect: false,
    options: [
      { label: "Advisory", description: "Report findings but continue execution" },
      { label: "Enforced", description: "Halt execution on findings and require user approval" }
    ]
  }
])
```

Map answers to settings values:
- Research: Yes=true, No=false -> `auto_research`
- Plan Check: Yes=true, No=false -> `plan_check`
- Discussion: Yes=true, No=false -> `require_discussion`
- Verification: No=false, Yes=true -> `skip_verification` (note: inverted question)
- Auto-Commit: Yes=true, No=false -> `auto_commit`
- Parallel: Yes=true, No=false -> `parallel_execution`
- Quality Gate: Yes=true, No=false -> `quality_gate`
- Shift-Left Gates: Yes=true, No=false -> `shift_left_gates`
- Shift-Left Enforcement: Advisory='advisory', Enforced='enforced' -> `shift_left_enforcement`
</step>

<step name="choose_scope">
Ask where to save:

```
AskUserQuestion([
  {
    question: "Where should these settings be saved?",
    header: "Scope",
    multiSelect: false,
    options: [
      { label: "This project only", description: "Save to .forge/settings.yaml (overrides global for this project)" },
      { label: "Global defaults", description: "Save to ~/.claude/forge.local.md (applies to all projects)" },
      { label: "Both", description: "Save as global defaults AND project settings" }
    ]
  }
])
```
</step>

<step name="save_settings">
Build the settings object from answers and save to the chosen scope(s):

```bash
# For project scope:
node "$HOME/.claude/forge/bin/forge-tools.cjs" settings-bulk project '{"key":"value",...}'

# For global scope:
node "$HOME/.claude/forge/bin/forge-tools.cjs" settings-bulk global '{"key":"value",...}'
```
</step>

<step name="confirm">
Reload and display the final effective settings:

```bash
node "$HOME/.claude/forge/bin/forge-tools.cjs" settings-load
```

Display:

```
Forge Settings Updated

| Setting              | Value | Source  |
|----------------------|-------|---------|
| Auto Research        | On    | project |
| Plan Check           | On    | global  |
| Require Discussion   | On    | default |
| Skip Verification    | Off   | project |
| Auto Commit          | On    | default |
| Parallel Execution   | On    | default |
| Quality Gate         | On    | default |

Source priority: project > global > default

Quick overrides:
- /forge:settings                     -- Interactive settings
- /forge:config set auto_research false -- Single toggle via config
```
</step>

</process>

<success_criteria>
- [ ] Current settings loaded from all layers
- [ ] User presented with 9 workflow toggles (7 boolean + 1 shift-left boolean + 1 shift-left enum)
- [ ] User chose save scope (project/global/both)
- [ ] Settings saved to chosen scope(s)
- [ ] Final effective settings displayed with sources
</success_criteria>
