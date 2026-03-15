'use strict';

/**
 * quality-gate-commands.cjs -- Quality gate commands.
 *
 * Commands: quality-gate-fp-add, quality-gate-fp-list, quality-gate-fp-clear, quality-gate-report
 *
 * Uses bd remember/memories/forget with key pattern forge:quality-gate:fp:<hash>
 * where hash is SHA-256 of agent+category+file+title (excludes line numbers).
 */

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { bd, bdArgs, output, forgeError } = require('./core.cjs');

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
};

// --- HTML report generator (inlined, only used by quality-gate-report) ---

function escHtml(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

const SEVERITY_COLORS = {
  critical: { bg: '#3b1219', border: '#f87171', text: '#fca5a5', badge: '#dc2626' },
  high:     { bg: '#3b1e0b', border: '#fb923c', text: '#fdba74', badge: '#ea580c' },
  medium:   { bg: '#3b350b', border: '#facc15', text: '#fde68a', badge: '#ca8a04' },
  low:      { bg: '#0b2a3b', border: '#38bdf8', text: '#7dd3fc', badge: '#0284c7' },
  info:     { bg: '#1a1a2e', border: '#6b7280', text: '#9ca3af', badge: '#4b5563' },
};

function generateReportHTML({ agents, findings, filteredFps, changedFiles, summary, totalFindings, hasBlockers, passed, timestamp }) {
  const blockerFindings = [];
  const advisoryFindings = [];
  for (const f of findings) {
    if (f.severity === 'critical' || f.severity === 'high') blockerFindings.push(f);
    else advisoryFindings.push(f);
  }

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
      const c = SEVERITY_COLORS[f.severity] || SEVERITY_COLORS.info;
      return `
        <div class="finding" style="border-left:3px solid ${c.border};background:${c.bg};padding:12px 16px;border-radius:6px;margin-bottom:8px">
          <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px">
            <span class="sev-badge" style="background:${c.badge};color:#fff;padding:2px 8px;border-radius:4px;font-size:11px;font-weight:600;text-transform:uppercase">${escHtml(f.severity)}</span>
            <span style="color:${c.text};font-weight:500">${escHtml(f.title)}</span>
          </div>
          <div style="color:#a1a1aa;font-size:13px;margin-bottom:4px">${escHtml(f.file)}${f.line ? ':' + f.line : ''} &middot; ${escHtml(f.category)}</div>
          <div style="color:#d4d4d8;font-size:13px;margin-bottom:6px">${escHtml(f.description)}</div>
          <div style="color:#86efac;font-size:13px"><strong>Fix:</strong> ${escHtml(f.remediation)}</div>
        </div>`;
    }).join('\n');

    const agentIcon = agentName.includes('security') ? '\u{1F6E1}' : agentName.includes('review') ? '\u{1F50D}' : '\u26A1';

    return `
      <div class="agent-section" style="margin-bottom:24px">
        <details open>
          <summary style="cursor:pointer;font-size:16px;font-weight:600;color:#e4e4e7;padding:8px 0;border-bottom:1px solid #27272a;margin-bottom:12px">
            ${agentIcon} ${escHtml(agentName)} <span style="color:#71717a;font-weight:400">(${agentFindings.length} finding${agentFindings.length !== 1 ? 's' : ''})</span>
          </summary>
          ${findingsHTML}
        </details>
      </div>`;
  }).join('\n');

  const fpHTML = filteredFps.length > 0 ? `
    <div style="margin-top:32px">
      <details>
        <summary style="cursor:pointer;font-size:14px;font-weight:600;color:#71717a;padding:8px 0">
          Filtered false-positives (${filteredFps.length})
        </summary>
        <div style="margin-top:8px">
          ${filteredFps.map(fp => `
            <div style="padding:6px 12px;background:#18181b;border-radius:4px;margin-bottom:4px;color:#71717a;font-size:13px">
              <span style="color:#a1a1aa">[${escHtml(fp.agent)}]</span> ${escHtml(fp.file)} &mdash; ${escHtml(fp.title)}
            </div>`).join('\n')}
        </div>
      </details>
    </div>` : '';

  const changedFilesHTML = changedFiles.length > 0 ? `
    <div style="margin-top:24px">
      <details>
        <summary style="cursor:pointer;font-size:14px;font-weight:600;color:#71717a;padding:8px 0">
          Changed files scoped (${changedFiles.length})
        </summary>
        <div style="margin-top:8px;columns:2;column-gap:16px">
          ${changedFiles.map(f => `<div style="color:#a1a1aa;font-size:12px;padding:2px 0;font-family:'IBM Plex Mono',monospace">${escHtml(f)}</div>`).join('\n')}
        </div>
      </details>
    </div>` : '';

  const agentCardsHTML = agents.map(a => {
    const isOk = a.status === 'success' || a.status === 'completed';
    const color = isOk ? '#22c55e' : '#ef4444';
    const icon = isOk ? '\u2713' : '\u2717';
    return `
      <div style="background:#18181b;border-radius:8px;padding:12px 16px;border:1px solid #27272a;flex:1;min-width:140px">
        <div style="color:${color};font-size:18px;font-weight:700">${icon}</div>
        <div style="color:#e4e4e7;font-size:13px;font-weight:500;margin-top:4px">${escHtml(a.name)}</div>
        <div style="color:#71717a;font-size:12px">${a.findingsCount || 0} finding${(a.findingsCount || 0) !== 1 ? 's' : ''}</div>
      </div>`;
  }).join('\n');

  const statsHTML = `
    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(100px,1fr));gap:12px;margin-top:20px">
      <div class="stat-card">
        <div class="stat-value">${summary.agentsRun || agents.length}</div>
        <div class="stat-label">Agents run</div>
      </div>
      <div class="stat-card">
        <div class="stat-value" style="color:${(summary.totalBeforeFilter || 0) > 0 ? '#fbbf24' : '#22c55e'}">${summary.totalBeforeFilter || totalFindings}</div>
        <div class="stat-label">Total found</div>
      </div>
      <div class="stat-card">
        <div class="stat-value" style="color:#ef4444">${summary.blockers || blockerFindings.length}</div>
        <div class="stat-label">Blockers</div>
      </div>
      <div class="stat-card">
        <div class="stat-value" style="color:#fbbf24">${summary.advisory || advisoryFindings.length}</div>
        <div class="stat-label">Advisory</div>
      </div>
      <div class="stat-card">
        <div class="stat-value" style="color:#71717a">${filteredFps.length}</div>
        <div class="stat-label">FPs filtered</div>
      </div>
    </div>`;

  const verdictColor = passed ? '#22c55e' : hasBlockers ? '#ef4444' : '#fbbf24';
  const verdictText = passed ? 'PASSED' : hasBlockers ? 'BLOCKERS FOUND' : 'ADVISORY ONLY';
  const verdictIcon = passed ? '\u2713' : hasBlockers ? '\u2717' : '\u26A0';

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Quality Gate Report</title>
<link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600;700&family=IBM+Plex+Sans:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>
  * { margin:0; padding:0; box-sizing:border-box; }
  body { background:#09090b; color:#e4e4e7; font-family:'IBM Plex Sans',system-ui,sans-serif; padding:32px; min-height:100vh; }
  code, .mono { font-family:'IBM Plex Mono',monospace; }
  .container { max-width:900px; margin:0 auto; }
  .verdict-banner {
    text-align:center; padding:32px 24px; border-radius:12px; margin-bottom:32px;
    background:linear-gradient(135deg, #18181b 0%, #1a1a2e 100%);
    border:2px solid ${verdictColor};
  }
  .verdict-icon { font-size:48px; margin-bottom:8px; }
  .verdict-text { font-size:28px; font-weight:700; letter-spacing:2px; color:${verdictColor}; }
  .verdict-sub { color:#71717a; font-size:14px; margin-top:8px; }
  .stat-card {
    background:#18181b; border-radius:8px; padding:12px 16px; text-align:center;
    border:1px solid #27272a;
  }
  .stat-value { font-size:24px; font-weight:700; color:#e4e4e7; }
  .stat-label { font-size:11px; color:#71717a; text-transform:uppercase; letter-spacing:1px; margin-top:2px; }
  details > summary { list-style:none; }
  details > summary::-webkit-details-marker { display:none; }
  details > summary::before { content:'\\25B6 '; font-size:10px; margin-right:6px; color:#71717a; }
  details[open] > summary::before { content:'\\25BC '; }
  .agents-row { display:flex; gap:12px; flex-wrap:wrap; margin-top:24px; }
  .section-title { font-size:18px; font-weight:600; color:#a1a1aa; margin:32px 0 16px; border-bottom:1px solid #27272a; padding-bottom:8px; }
  .footer { text-align:center; color:#3f3f46; font-size:12px; margin-top:48px; padding-top:16px; border-top:1px solid #18181b; }
</style>
</head>
<body>
<div class="container">
  <div class="verdict-banner">
    <div class="verdict-icon">${verdictIcon}</div>
    <div class="verdict-text">${verdictText}</div>
    <div class="verdict-sub">${totalFindings} finding${totalFindings !== 1 ? 's' : ''} across ${agents.length} agent${agents.length !== 1 ? 's' : ''}</div>
  </div>

  ${agents.length > 0 ? `<div class="agents-row">${agentCardsHTML}</div>` : ''}

  ${statsHTML}

  ${totalFindings > 0 ? `
    <div class="section-title">Findings by Agent</div>
    ${agentSectionHTML}
  ` : `
    <div style="text-align:center;padding:40px;color:#3f3f46;font-size:16px;margin-top:32px">
      No issues found. Clean bill of health.
    </div>
  `}

  ${fpHTML}

  ${changedFilesHTML}

  <div class="footer">
    Generated by Forge Quality Gate &middot; ${escHtml(timestamp)}
  </div>
</div>
</body>
</html>`;
}
