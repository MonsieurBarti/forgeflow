'use strict';

// --- design-system.cjs ---
// Shared component library for all Forge HTML outputs.
// Every export is a pure function (no side effects, no file I/O) returning an HTML string.

// ---------------------------------------------------------------------------
// CSS_VARS -- dark glassmorphism theme, mirrors the dashboard :root block
// ---------------------------------------------------------------------------
const CSS_VARS = `
:root {
  --bg: #09090b;
  --surface: rgba(255,255,255,0.03);
  --surface-solid: #111113;
  --surface-2: rgba(255,255,255,0.06);
  --surface-hover: rgba(255,255,255,0.08);
  --border: rgba(255,255,255,0.06);
  --border-subtle: rgba(255,255,255,0.04);
  --text: #fafafa;
  --text-secondary: #a1a1aa;
  --text-muted: #71717a;
  --accent: #6366f1;
  --green: #22c55e;
  --orange: #f59e0b;
  --red: #ef4444;
  --blue: #3b82f6;
}`;

// ---------------------------------------------------------------------------
// esc -- HTML entity escaping (unified replacement for esc / escHtml)
// ---------------------------------------------------------------------------
function esc(s) {
  return String(s || '').replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
}

// ---------------------------------------------------------------------------
// wrapPage -- full HTML document boilerplate
// ---------------------------------------------------------------------------
function wrapPage(title, bodyHTML, extraCSS) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${esc(title)}</title>
<style>
${CSS_VARS}

* { box-sizing: border-box; margin: 0; padding: 0; }

body {
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
  background: var(--bg);
  color: var(--text);
  line-height: 1.6;
  min-height: 100vh;
}

code, .mono {
  font-family: ui-monospace, 'SF Mono', SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 0.8em;
  color: var(--text-muted);
}
${extraCSS ? '\n' + extraCSS : ''}
</style>
</head>
<body>
${bodyHTML}
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// card -- glassmorphism card component
// ---------------------------------------------------------------------------
/**
 * @param {string} [content] - Treated as trusted HTML. Callers must pre-escape
 *   any dynamic values before passing them as content to prevent XSS.
 */
function card({ title, content, className, style } = {}) {
  const cls = ['ds-card'];
  if (className) cls.push(className);
  const styleAttr = style ? ` style="${esc(style)}"` : '';
  const titleHTML = title ? `<div class="ds-card-title">${esc(title)}</div>` : '';
  return `<div class="${cls.join(' ')}"${styleAttr}>${titleHTML}<div class="ds-card-content">${content || ''}</div></div>`;
}

// Card CSS (importable via CARD_CSS for pages that use card())
const CARD_CSS = `
.ds-card {
  background: var(--surface);
  backdrop-filter: blur(24px);
  -webkit-backdrop-filter: blur(24px);
  border: 1px solid var(--border);
  border-radius: 12px;
  padding: 1.5rem;
  transition: transform 0.2s ease, border-color 0.2s ease, box-shadow 0.2s ease;
  position: relative;
  overflow: hidden;
}
.ds-card:hover {
  border-color: rgba(255,255,255,0.1);
  box-shadow: 0 8px 32px rgba(0,0,0,0.3);
}
.ds-card-title {
  font-size: 0.85rem;
  font-weight: 600;
  color: var(--text-secondary);
  margin-bottom: 0.75rem;
  text-transform: uppercase;
  letter-spacing: 0.03em;
}
.ds-card-content {
  font-size: 0.9rem;
}`;

// ---------------------------------------------------------------------------
// badge -- status badge span
// ---------------------------------------------------------------------------
const BADGE_VARIANTS = {
  done:    { bg: 'rgba(34,197,94,0.12)',  color: 'var(--green)' },
  active:  { bg: 'rgba(245,158,11,0.12)', color: 'var(--orange)' },
  pending: { bg: 'rgba(113,113,122,0.12)', color: 'var(--text-muted)' },
};

function badge(text, variant) {
  const v = BADGE_VARIANTS[variant] || BADGE_VARIANTS.pending;
  return `<span class="ds-badge" style="background:${v.bg};color:${v.color}">${esc(text)}</span>`;
}

const BADGE_CSS = `
.ds-badge {
  display: inline-block;
  font-size: 0.65rem;
  padding: 0.15rem 0.55rem;
  border-radius: 10px;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  font-weight: 600;
  line-height: 1.5;
}`;

// ---------------------------------------------------------------------------
// progressRing -- SVG progress ring with percentage label
// ---------------------------------------------------------------------------
function progressRing({ percent, size, strokeWidth, color } = {}) {
  const pct = Math.max(0, Math.min(100, Number(percent) || 0));
  const sz = Number(size) || 80;
  const sw = Number(strokeWidth) || 6;
  const clr = color || 'var(--accent)';
  const viewBox = sz;
  const radius = Math.round((sz / 2) - (sw / 2) - 2);
  const circumference = Math.round(2 * Math.PI * radius);
  const offset = Math.round(circumference * (1 - pct / 100));

  return `<div class="ds-ring-container" style="width:${sz}px;height:${sz}px;position:relative">
  <svg viewBox="0 0 ${viewBox} ${viewBox}" style="width:${sz}px;height:${sz}px;transform:rotate(-90deg)">
    <circle cx="${sz / 2}" cy="${sz / 2}" r="${radius}" fill="none" stroke="var(--surface-2)" stroke-width="${sw}" />
    <circle cx="${sz / 2}" cy="${sz / 2}" r="${radius}" fill="none" stroke="${esc(clr)}" stroke-width="${sw}" stroke-linecap="round" stroke-dasharray="${circumference}" stroke-dashoffset="${offset}" />
  </svg>
  <span style="position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);font-size:${Math.round(sz * 0.12)}px;font-weight:600;color:var(--text-secondary)">${pct}%</span>
</div>`;
}

// ---------------------------------------------------------------------------
// statusDot -- colored status indicator dot
// ---------------------------------------------------------------------------
const STATUS_DOT_COLORS = {
  closed:      'var(--green)',
  done:        'var(--green)',
  in_progress: 'var(--blue)',
  active:      'var(--blue)',
  open:        'var(--text-muted)',
  pending:     'var(--text-muted)',
};

function statusDot(status) {
  const color = STATUS_DOT_COLORS[status] || 'var(--text-muted)';
  return `<span class="ds-status-dot" style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${color};margin-right:6px;vertical-align:middle"></span>`;
}

// ---------------------------------------------------------------------------
// table -- styled HTML table
// ---------------------------------------------------------------------------
/**
 * @param {string[]} [headers] - Column header labels; values are auto-escaped.
 * @param {string[][]} [rows] - Table body rows; cell values are treated as
 *   trusted HTML. Callers must pre-escape any dynamic content before passing
 *   it as a cell value to prevent XSS.
 * @param {string} [className] - Extra CSS class name(s) to add to the table.
 */
function table({ headers, rows, className } = {}) {
  const cls = ['ds-table'];
  if (className) cls.push(className);
  const headCells = (headers || []).map(h => `<th>${esc(h)}</th>`).join('');
  const bodyRows = (rows || []).map(row => {
    const cells = row.map(cell => `<td>${esc(String(cell))}</td>`).join('');
    return `<tr>${cells}</tr>`;
  }).join('\n');

  return `<table class="${cls.join(' ')}">
<thead><tr>${headCells}</tr></thead>
<tbody>
${bodyRows}
</tbody>
</table>`;
}

const TABLE_CSS = `
.ds-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 0.85rem;
}
.ds-table th {
  text-align: left;
  padding: 0.65rem 1rem;
  font-size: 0.7rem;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--text-muted);
  border-bottom: 1px solid var(--border);
}
.ds-table td {
  padding: 0.65rem 1rem;
  border-bottom: 1px solid var(--border-subtle);
  color: var(--text-secondary);
}
.ds-table tbody tr:hover {
  background: var(--surface-hover);
}`;

// ---------------------------------------------------------------------------
// tabs -- tab navigation with panel containers and switching JS
// ---------------------------------------------------------------------------
/**
 * @param {Function} [panelRenderer] - Return values are treated as trusted HTML.
 *   Callers must pre-escape any dynamic values in panelRenderer output to prevent XSS.
 */
function tabs({ items, activeIndex, panelRenderer } = {}) {
  const active = Number(activeIndex) || 0;
  const tabItems = (items || []);

  const navButtons = tabItems.map((item, i) => {
    const activeCls = i === active ? ' ds-tab-active' : '';
    return `<button class="ds-tab${activeCls}" data-ds-tab="${i}">${esc(item)}</button>`;
  }).join('\n    ');

  const panels = tabItems.map((item, i) => {
    const activeCls = i === active ? ' ds-tab-panel-active' : '';
    const content = typeof panelRenderer === 'function' ? panelRenderer(item, i) : '';
    return `<div class="ds-tab-panel${activeCls}" data-ds-panel="${i}">${content}</div>`;
  }).join('\n');

  const script = `<script>
(function() {
  var container = document.currentScript.parentElement;
  container.querySelectorAll('.ds-tab').forEach(function(tab) {
    tab.addEventListener('click', function() {
      var idx = this.getAttribute('data-ds-tab');
      container.querySelectorAll('.ds-tab').forEach(function(t) { t.classList.remove('ds-tab-active'); });
      container.querySelectorAll('.ds-tab-panel').forEach(function(p) { p.classList.remove('ds-tab-panel-active'); });
      this.classList.add('ds-tab-active');
      var panel = container.querySelector('.ds-tab-panel[data-ds-panel="' + idx + '"]');
      if (panel) panel.classList.add('ds-tab-panel-active');
    });
  });
})();
<\/script>`;

  return `<div class="ds-tabs-container">
  <div class="ds-tabs-nav">
    ${navButtons}
  </div>
${panels}
${script}
</div>`;
}

const TABS_CSS = `
.ds-tabs-container {
  margin-bottom: 2rem;
}
.ds-tabs-nav {
  display: flex;
  gap: 0.25rem;
  border-bottom: 1px solid var(--border);
  overflow-x: auto;
  scrollbar-width: none;
  -ms-overflow-style: none;
}
.ds-tabs-nav::-webkit-scrollbar { display: none; }
.ds-tab {
  background: none;
  border: none;
  color: var(--text-muted);
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
  font-size: 0.85rem;
  font-weight: 500;
  padding: 0.75rem 1.25rem;
  cursor: pointer;
  border-bottom: 2px solid transparent;
  transition: color 0.2s ease, border-color 0.2s ease;
  white-space: nowrap;
}
.ds-tab:hover {
  color: var(--text-secondary);
}
.ds-tab-active {
  color: var(--text);
  border-bottom-color: var(--accent);
}
.ds-tab-panel {
  display: none;
  padding-top: 1rem;
}
.ds-tab-panel-active {
  display: block;
}`;

// ---------------------------------------------------------------------------
// COMPONENT_CSS -- aggregated CSS for all components
// ---------------------------------------------------------------------------
const COMPONENT_CSS = [CARD_CSS, BADGE_CSS, TABLE_CSS, TABS_CSS].join('\n');

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------
module.exports = {
  CSS_VARS,
  CARD_CSS,
  BADGE_CSS,
  TABLE_CSS,
  TABS_CSS,
  COMPONENT_CSS,
  esc,
  wrapPage,
  card,
  badge,
  progressRing,
  statusDot,
  table,
  tabs,
};
