# Design System Audit

Audit of all 5 HTML generators for design-system.cjs consistency.

## Generator Status

| Generator | File | Imports DS | Uses COMPONENT_CSS | Components Used | Status |
|-----------|------|-----------|-------------------|-----------------|--------|
| generateDashboardHTML | project-commands.cjs | Yes | Yes (via wrapPage extraCSS) | card, badge, progressRing, statusDot, COMPONENT_CSS | Migrated |
| generateInteractiveDashboardHTML | project-commands.cjs | Yes | Yes (via wrapPage extraCSS) | ds-card, ds-badge, ds-tab, ds-tab-panel (class names in client JS) | Migrated |
| generateReportHTML | quality-gate-commands.cjs | Yes | Yes (via wrapPage extraCSS) | card, badge (via sevBadge helper) | Migrated |
| generateTriageHTML | quality-gate-commands.cjs | Yes | Yes (via wrapPage extraCSS) | card, badge (via sevBadge helper) | Migrated |
| generatePlanReviewHTML | phase-commands.cjs | Yes | Yes (inline in extraCSS) | card, badge, tabs | Already compliant |

## Design-System Components Used Per Generator

### generateDashboardHTML (project-commands.cjs)
- `card()` - stat cards, chart cards, milestone headers, mini-stats, phase cards, agent cards, quick task cards
- `badge()` - phase status badges (done/active/pending)
- `progressRing()` - phase completion and requirement coverage SVG rings
- `statusDot()` - available but unused (status conveyed via badge + phase-card border)
- `COMPONENT_CSS` - base styles via wrapPage extraCSS

### generateInteractiveDashboardHTML (project-commands.cjs)
- `ds-card` class - stat cards, chart cards, milestone headers, mini-stats, phase cards, agent cards (client-side JS)
- `ds-badge` class - phase/task status badges with inline variant colors (client-side JS)
- `ds-tab` / `ds-tab-active` - milestone tab navigation (client-side JS)
- `ds-tab-panel` / `ds-tab-panel-active` - milestone panel show/hide (client-side JS)
- `ds-ring-container` - progress ring containers with inline SVG (client-side JS)
- `COMPONENT_CSS` + `DASHBOARD_BASE_CSS` - base styles via wrapPage extraCSS

### generateReportHTML (quality-gate-commands.cjs)
- `card()` - stat cards, finding cards, agent status cards
- `badge()` via `sevBadge()` helper - severity badges (critical/high -> active, medium/low -> pending)
- `COMPONENT_CSS` - base styles via wrapPage extraCSS

### generateTriageHTML (quality-gate-commands.cjs)
- `card()` - stat cards, finding cards, agent status cards (shared via buildStatsHTML/buildAgentCardsHTML)
- `badge()` via `sevBadge()` - severity badges on findings
- `COMPONENT_CSS` - base styles via wrapPage extraCSS

### generatePlanReviewHTML (phase-commands.cjs)
- `card()` - task cards, architect summary card
- `badge()` - phase ID badge, task complexity badges
- `tabs()` - wave tab navigation with panel rendering
- `COMPONENT_CSS` - base styles inline in extraCSS

## Page-Specific CSS (Intentionally Not in Design System)

### Dashboard (DASHBOARD_BASE_CSS, 144 lines)
- `.dash-header` / `.dash-body` - page layout with gradient background
- `.overview-grid` / `.charts-row` / `.ms-stats-row` - grid layouts
- `.stat-card` overrides - accent stripe pseudo-element, hover transform, color variants
- `.chart-card` overrides - flex layout for ring + text
- `.ds-tab-active` override - per-milestone gradient border color (--tab-c1)
- `.tab-check` - checkmark icon for completed milestones
- `.ms-header` overrides - gradient stripe pseudo-element, flex layout
- `.ms-mini-stat` overrides - compact padding, centered text
- `.phase-card` overrides - status border-left colors, hover transform
- `.progress-bar-container` / `.progress-bar` - inline progress bars
- `.task-list` / `.task-details` - task list with expandable details
- `.req-grid` / `.req-cell` - requirement coverage heat map
- `.quick-tasks-grid` / `.quick-pr-link` - quick task section
- `.agent-card` overrides - agent color stripe, hover shadow
- Responsive breakpoints (1024px, 640px)

### Interactive Dashboard (page-specific overrides, ~50 lines)
- `.dash-header` override - flex layout for action buttons
- `.dash-header-actions` - button container
- `.dash-btn` / `.dash-btn-primary` - refresh/close buttons
- `.refresh-status` - refresh status text
- Responsive override for mobile header

### Quality Gate (buildSharedCSS, ~50 lines)
- `.verdict-banner` - verdict display with gradient and border effect
- `.finding-card` / `.finding-critical` etc. - severity-colored finding borders
- `.fp-item` / `.fp-section` - false-positive display
- `.changed-files-list` / `.changed-file` - file list column layout
- `.empty-state` / `.footer` - empty state and page footer
- `details` / `summary` - collapsible sections styling

### Plan Review (extraCSS, ~126 lines)
- `.plan-header` / `.plan-title` / `.plan-meta` - page header
- `.plan-task-card` / `.plan-task-removed` - task card states
- `.plan-field` / `.plan-field-label` / `.plan-input` / `.plan-textarea` - form fields
- `.plan-architect-notes` / `.plan-notes-readonly` - read-only architect notes
- `.plan-btn` / `.plan-btn-approve` / `.plan-btn-reject` / `.plan-btn-remove` - action buttons
- `.plan-footer` - sticky footer with approve/reject buttons
- `.plan-architect-summary` - summary section
- `.plan-empty` - empty state

## CSS Line Reduction

| Generator | Before (inline CSS) | After (page-specific only) | Reduction |
|-----------|-------------------|--------------------------|-----------|
| generateDashboardHTML | ~518 lines | ~144 lines | -374 lines |
| generateInteractiveDashboardHTML | ~192 lines | 0 (shares DASHBOARD_BASE_CSS) | -192 lines |
| quality-gate (shared) | ~90 lines | ~50 lines | -40 lines |
| plan-review | ~126 lines | ~126 lines (already compliant) | 0 |
| **Total** | **~926 lines** | **~320 lines** | **-606 lines** |
