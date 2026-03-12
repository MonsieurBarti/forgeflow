<purpose>
Generate a self-contained HTML dashboard for the current Forge project showing progress,
phases with task checklists, requirement coverage, and blockers. Opens in browser on demand.
</purpose>

<process>

## 1. Find Project

```bash
PROJECT=$(node "$HOME/.claude/forge/bin/forge-tools.cjs" find-project)
```

Parse `project.id` from the result. If no project found, suggest `/forge:new`.

If a project ID was given as argument, use it directly.

## 2. Load Full Progress

```bash
PROGRESS=$(node "$HOME/.claude/forge/bin/forge-tools.cjs" full-progress <project-id>)
```

This returns JSON with: project info, progress summary, phases with tasks, requirement coverage.

## 3. Generate HTML Dashboard

```bash
node "$HOME/.claude/forge/bin/forge-tools.cjs" generate-dashboard <project-id>
```

This command:
1. Calls `full-progress` internally to get all data
2. Generates a self-contained HTML file with all CSS/JS inlined
3. Writes it to `.forge/forge-dashboard-<project-id>.html` in the current working directory
4. Returns the file path

The HTML follows the visual-explainer aesthetic:
- IBM Plex Sans + IBM Plex Mono fonts (Google Fonts CDN)
- CSS Grid layout with sticky sidebar TOC
- Blueprint/editorial color scheme
- Chart.js for progress visualization
- No `.node` CSS class

## 4. Open in Browser

```bash
open <html-file-path>
```

Report the file path to the user.

</process>
