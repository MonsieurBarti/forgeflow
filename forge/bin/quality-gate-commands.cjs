'use strict';

/**
 * quality-gate-commands.cjs -- Quality gate commands.
 *
 * Commands: quality-gate-fp-add, quality-gate-fp-list, quality-gate-fp-clear,
 *           quality-gate-report, quality-gate-triage
 *
 * Uses bd remember/memories/forget with key pattern forge:quality-gate:fp:<hash>
 * where hash is SHA-256 of agent+category+file+title (excludes line numbers).
 */

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { bd, bdArgs, output, forgeError, resolveSettings } = require('./core.cjs');
const { esc, CSS_VARS, COMPONENT_CSS, wrapPage, card, badge } = require('./design-system.cjs');
const { serveAndAwaitDecision } = require('./dev-server.cjs');

const FP_KEY_PREFIX = 'forge:quality-gate:fp:';

/**
 * Compute a deterministic FP hash from finding fields.
 * SHA-256 of concatenation: agent + category + file + title.
 * Line numbers are excluded so the same finding survives line shifts.
 */
function computeFpHash(agent, category, file, title) {
  const input = [agent, category, file, title].join('\x00');
  return crypto.createHash('sha256').update(input).digest('hex').slice(0, 16);
}

/**
 * Pre-seeded false-positive: bd CLI N+1 subprocess pattern.
 * This is a known architectural limitation that cannot be fixed without
 * a bd CLI bulk-query API.
 */
const SEED_FP = {
  agent: 'performance-auditor',
  category: 'n-plus-one',
  file: 'forge/bin/roadmap-commands.cjs',
  title: 'N+1 subprocess pattern in bd CLI calls',
};

/**
 * Auto-seed the known bd N+1 FP if no FPs exist yet.
 * Called by quality-gate-fp-list on first invocation.
 */
function autoSeedIfEmpty(existingFps) {
  if (Object.keys(existingFps).length > 0) return existingFps;

  const hash = computeFpHash(SEED_FP.agent, SEED_FP.category, SEED_FP.file, SEED_FP.title);
  const key = `${FP_KEY_PREFIX}${hash}`;
  const value = JSON.stringify(SEED_FP);

  bdArgs(['remember', '--key', key, value], { allowFail: true });

  // Return the seeded entry so callers see it immediately
  const seeded = {};
  seeded[key] = value;
  return seeded;
}

module.exports = {
  /**
   * Add a false-positive to the persistence store.
   *
   * Usage: quality-gate-fp-add --agent=<agent> --category=<category> --file=<file> --title=<title>
   */
  'quality-gate-fp-add'(args) {
    const params = {};
    for (const arg of args) {
      const match = arg.match(/^--(\w[\w-]*)=(.+)$/);
      if (match) {
        params[match[1]] = match[2];
      }
    }

    const { agent, category, file, title } = params;
    if (!agent) forgeError('MISSING_ARG', 'Missing required argument: --agent', 'Run: forge-tools quality-gate-fp-add --agent=<agent> --category=<category> --file=<file> --title=<title>');
    if (!category) forgeError('MISSING_ARG', 'Missing required argument: --category', 'Run: forge-tools quality-gate-fp-add --agent=<agent> --category=<category> --file=<file> --title=<title>');
    if (!file) forgeError('MISSING_ARG', 'Missing required argument: --file', 'Run: forge-tools quality-gate-fp-add --agent=<agent> --category=<category> --file=<file> --title=<title>');
    if (!title) forgeError('MISSING_ARG', 'Missing required argument: --title', 'Run: forge-tools quality-gate-fp-add --agent=<agent> --category=<category> --file=<file> --title=<title>');

    const hash = computeFpHash(agent, category, file, title);
    const key = `${FP_KEY_PREFIX}${hash}`;
    const value = JSON.stringify({ agent, category, file, title });

    bdArgs(['remember', '--key', key, value]);

    output({ ok: true, hash, key, finding: { agent, category, file, title } });
  },

  /**
   * List all known false-positives as a structured JSON array.
   * Auto-seeds the bd N+1 subprocess pattern if no FPs exist.
   *
   * Usage: quality-gate-fp-list
   */
  'quality-gate-fp-list'(_args) {
    const raw = bd(`memories ${FP_KEY_PREFIX} --json`, { allowFail: true });
    let memories = {};
    if (raw) {
      try {
        memories = JSON.parse(raw);
      } catch {
        // INTENTIONALLY SILENT: bd memories may return non-JSON for empty results.
      }
    }

    // Auto-seed if empty
    memories = autoSeedIfEmpty(memories);

    // Convert to structured array
    const fps = [];
    for (const [key, value] of Object.entries(memories)) {
      const hash = key.replace(FP_KEY_PREFIX, '');
      let finding;
      try {
        finding = JSON.parse(value);
      } catch {
        // INTENTIONALLY SILENT: malformed FP entry, skip it
        finding = { raw: value };
      }
      fps.push({ hash, key, agent: finding.agent, category: finding.category, file: finding.file, title: finding.title });
    }

    output({ ok: true, count: fps.length, false_positives: fps });
  },

  /**
   * Clear a specific false-positive by hash, or all FPs.
   *
   * Usage: quality-gate-fp-clear --hash=<hash>
   *        quality-gate-fp-clear --all
   */
  'quality-gate-fp-clear'(args) {
    const params = {};
    for (const arg of args) {
      if (arg === '--all') {
        params.all = true;
      } else {
        const match = arg.match(/^--(\w[\w-]*)=(.+)$/);
        if (match) {
          params[match[1]] = match[2];
        }
      }
    }

    if (params.all) {
      // Clear all FPs
      const raw = bd(`memories ${FP_KEY_PREFIX} --json`, { allowFail: true });
      let memories = {};
      if (raw) {
        try {
          memories = JSON.parse(raw);
        } catch {
          // INTENTIONALLY SILENT: no FPs to clear
        }
      }

      const keys = Object.keys(memories);
      let cleared = 0;
      for (const key of keys) {
        bdArgs(['forget', key], { allowFail: true });
        cleared++;
      }

      output({ ok: true, cleared, message: `Cleared ${cleared} false-positive(s)` });
      return;
    }

    if (!params.hash) {
      forgeError('MISSING_ARG', 'Missing required argument: --hash or --all', 'Run: forge-tools quality-gate-fp-clear --hash=<hash> or --all');
    }

    if (!/^[0-9a-f]{16}$/.test(params.hash)) {
      forgeError('INVALID_ARG', 'hash must be 16 hex characters', 'Run: forge-tools quality-gate-fp-list to see valid hashes');
    }

    const key = `${FP_KEY_PREFIX}${params.hash}`;
    bdArgs(['forget', key]);

    output({ ok: true, hash: params.hash, key, message: `Cleared false-positive ${params.hash}` });
  },

  /**
   * Generate a self-contained HTML quality gate report and open it in the browser.
   * The report file is ephemeral: auto-opened then deleted after 15 seconds.
   *
   * Usage: quality-gate-report --data='<JSON>'
   *
   * Expected --data schema:
   * {
   *   agents: [{ name, status, findingsCount }],
   *   findings: [{ severity, category, file, line, title, description, remediation, agent }],
   *   filteredFps: [{ hash, agent, category, file, title }],
   *   changedFiles: [string],
   *   summary: { totalBeforeFilter, totalAfterFilter, blockers, advisory, agentsRun, agentsFailed }
   * }
   */
  'quality-gate-report'(args) {
    let dataStr = '';
    for (const arg of args) {
      const match = arg.match(/^--data=(.+)$/s);
      if (match) dataStr = match[1];
    }

    if (!dataStr) {
      forgeError('MISSING_ARG', 'Missing required argument: --data', 'Run: forge-tools quality-gate-report --data=\'<JSON>\'');
    }

    let data;
    try {
      data = JSON.parse(dataStr);
    } catch (e) {
      forgeError('INVALID_JSON', `Failed to parse --data JSON: ${e.message}`, 'Ensure --data contains valid JSON');
    }

    const {
      agents = [],
      findings = [],
      filteredFps = [],
      changedFiles = [],
      summary = {},
    } = data;

    const totalFindings = summary.totalAfterFilter || findings.length;
    const hasBlockers = (summary.blockers || 0) > 0;
    const passed = totalFindings === 0;

    const html = generateReportHTML({
      agents, findings, filteredFps, changedFiles, summary, totalFindings, hasBlockers, passed,
      timestamp: new Date().toISOString(),
    });

    const reportPath = path.join(os.tmpdir(), `forge-quality-gate-${Date.now()}.html`);
    fs.writeFileSync(reportPath, html, 'utf8');

    // Open in browser — execFileSync avoids shell interpretation.
    // On Windows, 'start' is a shell builtin (not a binary), so we invoke
    // cmd.exe /c start instead; the empty '' arg is the window title.
    try {
      // Validate reportPath is within os.tmpdir() on all platforms.
      if (!reportPath.startsWith(os.tmpdir())) {
        throw new Error('reportPath is outside os.tmpdir() -- refusing to open');
      }
      if (process.platform === 'win32') {
        execFileSync('cmd.exe', ['/c', 'start', '', reportPath], { stdio: 'ignore' });
      } else {
        const openCmd = process.platform === 'darwin' ? 'open' : 'xdg-open';
        execFileSync(openCmd, [reportPath], { stdio: 'ignore' });
      }
    } catch { /* INTENTIONALLY SILENT: browser open is best-effort */ }

    // Schedule deletion after 15 seconds (allows slow browser cold-starts)
    setTimeout(() => {
      try { fs.unlinkSync(reportPath); } catch { /* INTENTIONALLY SILENT */ }
    }, 15000);

    output({ success: true, report_path: reportPath, findings_count: totalFindings });
  },

  /**
   * Interactive triage UI for quality gate findings.
   * Serves a browser-based triage page with checkboxes via dev-server, or falls
   * back to the static HTML report when web_ui is false.
   *
   * Returns a promise (async command). index.cjs handles the async dispatch.
   *
   * Usage: quality-gate-triage --data='<JSON>'
   *
   * Accepts the same --data schema as quality-gate-report.
   *
   * When web_ui=true:  starts dev-server, returns {fixIds[], ignoreIds[]} from user.
   * When web_ui=false: generates static report HTML and returns {fallback: true}.
   */
  'quality-gate-triage'(args) {
    let dataStr = '';
    for (const arg of args) {
      const match = arg.match(/^--data=(.+)$/s);
      if (match) dataStr = match[1];
    }

    if (!dataStr) {
      forgeError('MISSING_ARG', 'Missing required argument: --data', 'Run: forge-tools quality-gate-triage --data=\'<JSON>\'');
    }

    let data;
    try {
      data = JSON.parse(dataStr);
    } catch (e) {
      forgeError('INVALID_JSON', `Failed to parse --data JSON: ${e.message}`, 'Ensure --data contains valid JSON');
    }

    const settings = resolveSettings();

    const {
      agents = [],
      findings = [],
      filteredFps = [],
      changedFiles = [],
      summary = {},
    } = data;

    if (!settings.web_ui) {
      // Fallback: generate and open the static report, signal caller to use AskUserQuestion.
      // Emits a single output combining report path and fallback flag.
      const totalFindings = summary.totalAfterFilter || findings.length;
      const hasBlockers = (summary.blockers || 0) > 0;
      const passed = totalFindings === 0;

      const html = generateReportHTML({
        agents, findings, filteredFps, changedFiles, summary, totalFindings, hasBlockers, passed,
        timestamp: new Date().toISOString(),
      });

      const reportPath = path.join(os.tmpdir(), `forge-quality-gate-${Date.now()}.html`);
      fs.writeFileSync(reportPath, html, 'utf8');

      try {
        if (!reportPath.startsWith(os.tmpdir())) {
          throw new Error('reportPath is outside os.tmpdir() -- refusing to open');
        }
        if (process.platform === 'win32') {
          execFileSync('cmd.exe', ['/c', 'start', '', reportPath], { stdio: 'ignore' });
        } else {
          const openCmd = process.platform === 'darwin' ? 'open' : 'xdg-open';
          execFileSync(openCmd, [reportPath], { stdio: 'ignore' });
        }
      } catch { /* INTENTIONALLY SILENT: browser open is best-effort */ }

      setTimeout(() => {
        try { fs.unlinkSync(reportPath); } catch { /* INTENTIONALLY SILENT */ }
      }, 15000);

      output({ fallback: true, report_path: reportPath, findings_count: totalFindings });
      return;
    }

    // Return a promise -- index.cjs handles async dispatch
    return generateTriageAndServe({
      agents, findings, filteredFps, changedFiles, summary,
    });
  },
};

// --- HTML report generator (inlined, only used by quality-gate-report) ---

const SEVERITY_COLORS = {
  critical: { bg: '#3b1219', border: '#f87171', text: '#fca5a5', badge: '#dc2626' },
  high:     { bg: '#3b1e0b', border: '#fb923c', text: '#fdba74', badge: '#ea580c' },
  medium:   { bg: '#3b350b', border: '#facc15', text: '#fde68a', badge: '#ca8a04' },
  low:      { bg: '#0b2a3b', border: '#38bdf8', text: '#7dd3fc', badge: '#0284c7' },
  info:     { bg: '#1a1a2e', border: '#6b7280', text: '#9ca3af', badge: '#4b5563' },
};

/**
 * Build severity-specific CSS rules shared between report and triage pages.
 */
function buildSeverityCSS() {
  return Object.entries(SEVERITY_COLORS).map(([sev, c]) => `
  .finding-${sev} { border-left: 3px solid ${c.border}; background: ${c.bg}; }
  .sev-${sev} { background: ${c.badge}; }
  .finding-title-${sev} { color: ${c.text}; }`).join('\n');
}

/**
 * Shared CSS template for verdict banner, stat cards, agent cards, finding cards,
 * collapsible sections, empty state, and footer. Used by both generateReportHTML
 * and generateTriageHTML.
 *
 * verdictColor and severityCSS depend on per-page data and are passed as arguments.
 */
function buildSharedCSS(verdictColor, severityCSS) {
  return `
  ${COMPONENT_CSS}

  body { padding: 32px; }
  .container { max-width: 900px; margin: 0 auto; }

  /* Verdict banner */
  .verdict-banner {
    text-align: center; padding: 32px 24px; border-radius: 12px; margin-bottom: 32px;
    background: linear-gradient(135deg, var(--surface-solid) 0%, #1a1a2e 100%);
    border: 2px solid ${verdictColor};
  }
  .verdict-icon { font-size: 48px; margin-bottom: 8px; }
  .verdict-text { font-size: 28px; font-weight: 700; letter-spacing: 2px; color: ${verdictColor}; }
  .verdict-sub { color: var(--text-muted); font-size: 14px; margin-top: 8px; }

  /* Stat cards */
  .stats-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(100px, 1fr)); gap: 12px; margin-top: 20px; }
  .stat-card {
    background: var(--surface-solid); border-radius: 8px; padding: 12px 16px; text-align: center;
    border: 1px solid var(--border);
  }
  .stat-value { font-size: 24px; font-weight: 700; color: var(--text); }
  .stat-label { font-size: 11px; color: var(--text-muted); text-transform: uppercase; letter-spacing: 1px; margin-top: 2px; }
  .text-ok { color: var(--green); }
  .text-warn { color: var(--orange); }
  .text-danger { color: var(--red); }
  .text-muted { color: var(--text-muted); }

  /* Agent cards */
  .agents-row { display: flex; gap: 12px; flex-wrap: wrap; margin-top: 24px; }
  .qg-agent-card {
    background: var(--surface-solid); border-radius: 8px; padding: 12px 16px;
    border: 1px solid var(--border); flex: 1; min-width: 140px;
  }
  .qg-agent-icon { font-size: 18px; font-weight: 700; }
  .agent-ok { color: var(--green); }
  .agent-fail { color: var(--red); }
  .qg-agent-name { color: var(--text); font-size: 13px; font-weight: 500; margin-top: 4px; }
  .qg-agent-count { color: var(--text-muted); font-size: 12px; }

  /* Details / collapsible */
  details > summary { list-style: none; }
  details > summary::-webkit-details-marker { display: none; }
  details > summary::before { content: '\\25B6 '; font-size: 10px; margin-right: 6px; color: var(--text-muted); }
  details[open] > summary::before { content: '\\25BC '; }

  /* Agent findings sections */
  .agent-section { margin-bottom: 24px; }
  .agent-summary {
    cursor: pointer; font-size: 16px; font-weight: 600; color: var(--text);
    padding: 8px 0; border-bottom: 1px solid var(--border); margin-bottom: 12px;
  }
  .agent-count { color: var(--text-muted); font-weight: 400; }
  .section-title {
    font-size: 18px; font-weight: 600; color: var(--text-secondary);
    margin: 32px 0 16px; border-bottom: 1px solid var(--border); padding-bottom: 8px;
  }

  /* Finding cards */
  .finding { padding: 12px 16px; border-radius: 6px; margin-bottom: 8px; }
  .finding-header { display: flex; align-items: center; gap: 8px; margin-bottom: 6px; flex-wrap: wrap; }
  .sev-badge {
    color: #fff; padding: 2px 8px; border-radius: 4px;
    font-size: 11px; font-weight: 600; text-transform: uppercase;
  }
  .finding-title { font-weight: 500; }
  .finding-location { color: var(--text-secondary); font-size: 13px; margin-bottom: 4px; }
  .finding-desc { color: #d4d4d8; font-size: 13px; margin-bottom: 6px; }
  .finding-fix { color: #86efac; font-size: 13px; }
  ${severityCSS}

  /* Collapsible sections */
  .collapsible-summary { cursor: pointer; font-size: 14px; font-weight: 600; color: var(--text-muted); padding: 8px 0; }
  .fp-section { margin-top: 32px; }
  .fp-list { margin-top: 8px; }
  .fp-item {
    padding: 6px 12px; background: var(--surface-solid); border-radius: 4px;
    margin-bottom: 4px; color: var(--text-muted); font-size: 13px;
  }
  .fp-agent { color: var(--text-secondary); }
  .changed-files-section { margin-top: 24px; }
  .changed-files-list { margin-top: 8px; columns: 2; column-gap: 16px; }
  .changed-file { color: var(--text-secondary); font-size: 12px; padding: 2px 0; }

  /* Empty state */
  .empty-state { text-align: center; padding: 40px; color: #3f3f46; font-size: 16px; margin-top: 32px; }

  /* Footer */
  .footer {
    text-align: center; color: #3f3f46; font-size: 12px;
    margin-top: 48px; padding-top: 16px; border-top: 1px solid var(--surface-solid);
  }`;
}

// --- Shared HTML fragment builders ---

/**
 * Build the verdict banner HTML (icon, text, sub-text) and return the verdict color.
 */
function buildVerdictHTML(totalFindings, agents, passed, hasBlockers) {
  const verdictColor = passed ? 'var(--green)' : hasBlockers ? 'var(--red)' : 'var(--orange)';
  const verdictText = passed ? 'PASSED' : hasBlockers ? 'BLOCKERS FOUND' : 'ADVISORY ONLY';
  const verdictIcon = passed ? '\u2713' : hasBlockers ? '\u2717' : '\u26A0';

  return {
    verdictColor,
    html: `
  <div class="verdict-banner">
    <div class="verdict-icon">${esc(verdictIcon)}</div>
    <div class="verdict-text">${esc(verdictText)}</div>
    <div class="verdict-sub">${totalFindings} finding${totalFindings !== 1 ? 's' : ''} across ${agents.length} agent${agents.length !== 1 ? 's' : ''}</div>
  </div>`,
  };
}

/**
 * Build the stats grid HTML from summary data.
 * Blocker/advisory counts are derived from findings via a single reduce pass
 * when not already present in summary.
 */
function buildStatsHTML(summary, findings, filteredFps, totalFindings) {
  const { blockerCount, advisoryCount } = findings.reduce((acc, f) => {
    if (f.severity === 'critical' || f.severity === 'high') acc.blockerCount++;
    else acc.advisoryCount++;
    return acc;
  }, { blockerCount: 0, advisoryCount: 0 });

  return `
    <div class="stats-grid">
      <div class="stat-card">
        <div class="stat-value">${summary.agentsRun || 0}</div>
        <div class="stat-label">Agents run</div>
      </div>
      <div class="stat-card">
        <div class="stat-value ${(summary.totalBeforeFilter || 0) > 0 ? 'text-warn' : 'text-ok'}">${summary.totalBeforeFilter || totalFindings}</div>
        <div class="stat-label">Total found</div>
      </div>
      <div class="stat-card">
        <div class="stat-value text-danger">${summary.blockers !== undefined ? summary.blockers : blockerCount}</div>
        <div class="stat-label">Blockers</div>
      </div>
      <div class="stat-card">
        <div class="stat-value text-warn">${summary.advisory !== undefined ? summary.advisory : advisoryCount}</div>
        <div class="stat-label">Advisory</div>
      </div>
      <div class="stat-card">
        <div class="stat-value text-muted">${filteredFps.length}</div>
        <div class="stat-label">FPs filtered</div>
      </div>
    </div>`;
}

/**
 * Build agent status cards HTML.
 */
function buildAgentCardsHTML(agents) {
  return agents.map(a => {
    const isOk = a.status === 'success' || a.status === 'completed';
    const cls = isOk ? 'agent-ok' : 'agent-fail';
    return `
      <div class="qg-agent-card">
        <div class="qg-agent-icon ${cls}">${isOk ? '\u2713' : '\u2717'}</div>
        <div class="qg-agent-name">${esc(a.name)}</div>
        <div class="qg-agent-count">${a.findingsCount || 0} finding${(a.findingsCount || 0) !== 1 ? 's' : ''}</div>
      </div>`;
  }).join('\n');
}

// TODO: generateReportHTML (~240 lines) interleaves data transformation, CSS construction,
// and HTML assembly. Separate into distinct helpers in a future phase to improve readability.
function generateReportHTML({ agents, findings, filteredFps, changedFiles, summary, totalFindings, hasBlockers, passed, timestamp }) {
  // Group findings by agent
  const byAgent = {};
  for (const f of findings) {
    const a = f.agent || 'unknown';
    if (!byAgent[a]) byAgent[a] = [];
    byAgent[a].push(f);
  }

  const agentSectionHTML = Object.entries(byAgent).map(([agentName, agentFindings]) => {
    const sevOrder = { critical: 0, high: 1, medium: 2, low: 3, info: 4 };
    agentFindings.sort((a, b) => (sevOrder[a.severity] || 5) - (sevOrder[b.severity] || 5));

    const findingsHTML = agentFindings.map((f) => {
      const sev = f.severity || 'info';
      return `
        <div class="finding finding-${sev}">
          <div class="finding-header">
            <span class="sev-badge sev-${sev}">${esc(f.severity)}</span>
            <span class="finding-title finding-title-${sev}">${esc(f.title)}</span>
          </div>
          <div class="finding-location">${esc(f.file)}${f.line ? ':' + f.line : ''} &middot; ${esc(f.category)}</div>
          <div class="finding-desc">${esc(f.description)}</div>
          <div class="finding-fix"><strong>Fix:</strong> ${esc(f.remediation)}</div>
        </div>`;
    }).join('\n');

    const agentIcon = agentName.includes('security') ? '\u{1F6E1}' : agentName.includes('review') ? '\u{1F50D}' : '\u26A1';

    return `
      <div class="agent-section">
        <details open>
          <summary class="agent-summary">
            ${agentIcon} ${esc(agentName)} <span class="agent-count">(${agentFindings.length} finding${agentFindings.length !== 1 ? 's' : ''})</span>
          </summary>
          ${findingsHTML}
        </details>
      </div>`;
  }).join('\n');

  const fpHTML = filteredFps.length > 0 ? `
    <div class="fp-section">
      <details>
        <summary class="collapsible-summary">
          Filtered false-positives (${filteredFps.length})
        </summary>
        <div class="fp-list">
          ${filteredFps.map(fp => `
            <div class="fp-item">
              <span class="fp-agent">[${esc(fp.agent)}]</span> ${esc(fp.file)} &mdash; ${esc(fp.title)}
            </div>`).join('\n')}
        </div>
      </details>
    </div>` : '';

  const changedFilesHTML = changedFiles.length > 0 ? `
    <div class="changed-files-section">
      <details>
        <summary class="collapsible-summary">
          Changed files scoped (${changedFiles.length})
        </summary>
        <div class="changed-files-list">
          ${changedFiles.map(f => `<div class="changed-file mono">${esc(f)}</div>`).join('\n')}
        </div>
      </details>
    </div>` : '';

  const agentCardsHTML = buildAgentCardsHTML(agents);
  const statsHTML = buildStatsHTML(summary, findings, filteredFps, totalFindings);
  const { verdictColor, html: verdictBannerHTML } = buildVerdictHTML(totalFindings, agents, passed, hasBlockers);
  const severityCSS = buildSeverityCSS();
  const extraCSS = buildSharedCSS(verdictColor, severityCSS);

  const bodyHTML = `
<div class="container">
  ${verdictBannerHTML}

  ${agents.length > 0 ? `<div class="agents-row">${agentCardsHTML}</div>` : ''}

  ${statsHTML}

  ${totalFindings > 0 ? `
    <div class="section-title">Findings by Agent</div>
    ${agentSectionHTML}
  ` : `
    <div class="empty-state">
      No issues found. Clean bill of health.
    </div>
  `}

  ${fpHTML}

  ${changedFilesHTML}

  <div class="footer">
    Generated by Forge Quality Gate &middot; ${esc(timestamp)}
  </div>
</div>`;

  return wrapPage('Quality Gate Report', bodyHTML, extraCSS);
}

// --- Triage HTML generator + server launcher ---

/**
 * Build triage HTML page and serve it via dev-server. Resolves with the user's
 * {fixIds, ignoreIds} decision, which is output as JSON to stdout.
 */
async function generateTriageAndServe({ agents, findings, filteredFps, changedFiles, summary }) {
  const timestamp = new Date().toISOString();
  const html = generateTriageHTML({
    agents, findings, filteredFps, changedFiles, summary, timestamp,
  });

  const decision = await serveAndAwaitDecision({
    html,
    title: 'Quality Gate Triage',
    timeout: 1800000, // 30 minutes
  });

  output(decision);
}

/**
 * Generate an interactive triage HTML page with checkboxes per finding,
 * Select All / Deselect All toggle, and a Submit button that POSTs to /decide.
 *
 * Uses design-system.cjs components (wrapPage, card, badge) for consistent styling.
 * Accepts raw data only; totalFindings, hasBlockers, and passed are computed internally.
 */
function generateTriageHTML({ agents, findings, filteredFps, changedFiles, summary, timestamp }) {
  // Derive computed values from raw data internally
  const totalFindings = summary.totalAfterFilter !== undefined ? summary.totalAfterFilter : findings.length;
  const hasBlockers = (summary.blockers || 0) > 0 || findings.some(f => f.severity === 'critical' || f.severity === 'high');
  const passed = totalFindings === 0;

  const sevOrder = { critical: 0, high: 1, medium: 2, low: 3, info: 4 };

  // Assign each finding a stable ID based on its index in the original array
  const findingsWithIds = findings.map((f, i) => ({ ...f, _id: `finding-${i}` }));

  // Group with IDs attached
  const byAgentWithIds = {};
  for (const f of findingsWithIds) {
    const a = f.agent || 'unknown';
    if (!byAgentWithIds[a]) byAgentWithIds[a] = [];
    byAgentWithIds[a].push(f);
  }

  // Build finding rows grouped by agent
  const agentSectionsHTML = Object.entries(byAgentWithIds).map(([agentName, agentFindings]) => {
    agentFindings.sort((a, b) => (sevOrder[a.severity] || 5) - (sevOrder[b.severity] || 5));

    const agentIcon = agentName.includes('security') ? '\u{1F6E1}' : agentName.includes('review') ? '\u{1F50D}' : '\u26A1';

    const findingRowsHTML = agentFindings.map((f) => {
      const sev = f.severity || 'info';
      const isBlocker = sev === 'critical' || sev === 'high';
      const tierBadge = isBlocker
        ? badge('blocker', 'active')
        : badge('advisory', 'pending');

      return `
        <div class="triage-row finding-${sev}">
          <label class="triage-label">
            <input type="checkbox" class="triage-cb" data-id="${esc(f._id)}" checked>
            <div class="triage-content">
              <div class="finding-header">
                <span class="sev-badge sev-${sev}">${esc(f.severity)}</span>
                ${tierBadge}
                <span class="finding-title finding-title-${sev}">${esc(f.title)}</span>
              </div>
              <div class="finding-location">${esc(f.file)}${f.line ? ':' + f.line : ''} &middot; ${esc(f.category)}</div>
              <div class="finding-desc">${esc(f.description)}</div>
              <div class="finding-fix"><strong>Fix:</strong> ${esc(f.remediation)}</div>
            </div>
          </label>
        </div>`;
    }).join('\n');

    return card({
      title: `${agentIcon} ${esc(agentName)} (${agentFindings.length} finding${agentFindings.length !== 1 ? 's' : ''})`,
      content: findingRowsHTML,
    });
  }).join('\n');

  const agentCardsHTML = buildAgentCardsHTML(agents);
  const statsHTML = buildStatsHTML(summary, findings, filteredFps, totalFindings);
  const { verdictColor, html: verdictBannerHTML } = buildVerdictHTML(totalFindings, agents, passed, hasBlockers);

  // FP section (collapsed)
  const fpHTML = filteredFps.length > 0 ? `
    <div class="fp-section">
      <details>
        <summary class="collapsible-summary">
          Filtered false-positives (${filteredFps.length})
        </summary>
        <div class="fp-list">
          ${filteredFps.map(fp => `
            <div class="fp-item">
              <span class="fp-agent">[${esc(fp.agent)}]</span> ${esc(fp.file)} &mdash; ${esc(fp.title)}
            </div>`).join('\n')}
        </div>
      </details>
    </div>` : '';

  // Inline JS for checkbox interactions and form submission.
  // The token is extracted from window.location.search at runtime (set by dev-server
  // in the URL as ?token=<TOKEN>).
  const inlineJS = `
<script>
(function() {
  // Extract token from URL
  var params = new URLSearchParams(window.location.search);
  var token = params.get('token') || '';

  var selectAllBtn = document.getElementById('triage-select-all');
  var deselectAllBtn = document.getElementById('triage-deselect-all');
  var submitBtn = document.getElementById('triage-submit');
  var statusEl = document.getElementById('triage-status');
  var checkboxes = document.querySelectorAll('.triage-cb');

  function updateCounter() {
    var checked = document.querySelectorAll('.triage-cb:checked').length;
    var total = checkboxes.length;
    statusEl.textContent = checked + ' of ' + total + ' selected for fix';
  }

  selectAllBtn.addEventListener('click', function() {
    checkboxes.forEach(function(cb) { cb.checked = true; });
    updateCounter();
  });

  deselectAllBtn.addEventListener('click', function() {
    checkboxes.forEach(function(cb) { cb.checked = false; });
    updateCounter();
  });

  checkboxes.forEach(function(cb) {
    cb.addEventListener('change', updateCounter);
  });

  submitBtn.addEventListener('click', function() {
    var fixIds = [];
    var ignoreIds = [];
    checkboxes.forEach(function(cb) {
      var id = cb.getAttribute('data-id');
      if (cb.checked) fixIds.push(id);
      else ignoreIds.push(id);
    });

    submitBtn.disabled = true;
    submitBtn.textContent = 'Submitting...';

    fetch('/decide?token=' + encodeURIComponent(token), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fixIds: fixIds, ignoreIds: ignoreIds })
    }).then(function(res) {
      if (!res.ok) throw new Error('Server returned ' + res.status);
      return res.json();
    }).then(function() {
      submitBtn.textContent = 'Submitted';
      statusEl.textContent = 'Decision submitted. You can close this tab.';
      statusEl.style.color = 'var(--green)';
    }).catch(function(err) {
      submitBtn.disabled = false;
      submitBtn.textContent = 'Submit Decision';
      statusEl.textContent = 'Error: ' + err.message;
      statusEl.style.color = 'var(--red)';
    });
  });

  updateCounter();
})();
<\/script>`;

  const severityCSS = buildSeverityCSS();
  const extraCSS = buildSharedCSS(verdictColor, severityCSS) + `

  /* Triage-specific styles */
  .triage-controls {
    display: flex; align-items: center; gap: 12px;
    margin: 24px 0 16px; padding: 12px 16px;
    background: var(--surface-solid); border-radius: 8px; border: 1px solid var(--border);
  }
  .triage-btn {
    background: var(--surface-2); border: 1px solid var(--border); color: var(--text-secondary);
    padding: 6px 14px; border-radius: 6px; cursor: pointer; font-size: 13px; font-weight: 500;
    transition: background 0.2s, border-color 0.2s;
  }
  .triage-btn:hover { background: var(--surface-hover); border-color: rgba(255,255,255,0.12); }
  .triage-btn-primary {
    background: var(--accent); border-color: var(--accent); color: #fff; font-weight: 600;
  }
  .triage-btn-primary:hover { background: #4f46e5; }
  .triage-btn-primary:disabled { opacity: 0.5; cursor: not-allowed; }
  .triage-status { flex: 1; text-align: right; color: var(--text-muted); font-size: 13px; }
  .triage-row {
    padding: 12px 16px; border-radius: 6px; margin-bottom: 8px;
    transition: background 0.15s;
  }
  .triage-label {
    display: flex; align-items: flex-start; gap: 12px; cursor: pointer;
  }
  .triage-cb {
    margin-top: 4px; width: 16px; height: 16px; accent-color: var(--accent);
    cursor: pointer; flex-shrink: 0;
  }
  .triage-content { flex: 1; }`;

  const bodyHTML = `
<div class="container">
  ${verdictBannerHTML}

  ${agents.length > 0 ? `<div class="agents-row">${agentCardsHTML}</div>` : ''}

  ${statsHTML}

  ${totalFindings > 0 ? `
    <div class="triage-controls">
      <button class="triage-btn" id="triage-select-all">Select All</button>
      <button class="triage-btn" id="triage-deselect-all">Deselect All</button>
      <span class="triage-status" id="triage-status"></span>
      <button class="triage-btn triage-btn-primary" id="triage-submit">Submit Decision</button>
    </div>

    <div class="section-title">Findings by Agent</div>
    ${agentSectionsHTML}

    <div class="triage-controls" style="margin-top:32px">
      <button class="triage-btn" onclick="document.getElementById('triage-select-all').click()">Select All</button>
      <button class="triage-btn" onclick="document.getElementById('triage-deselect-all').click()">Deselect All</button>
      <span class="triage-status"></span>
      <button class="triage-btn triage-btn-primary" onclick="document.getElementById('triage-submit').click()">Submit Decision</button>
    </div>
  ` : `
    <div class="empty-state">
      No issues found. Clean bill of health.
    </div>
  `}

  ${fpHTML}

  <div class="footer">
    Generated by Forge Quality Gate &middot; ${esc(timestamp)}
  </div>
</div>
${inlineJS}`;

  return wrapPage('Quality Gate Triage', bodyHTML, extraCSS);
}
