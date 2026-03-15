'use strict';

/**
 * quality-gate-commands.cjs -- Quality gate false-positive persistence commands.
 *
 * Commands: quality-gate-fp-add, quality-gate-fp-list, quality-gate-fp-clear
 *
 * Uses bd remember/memories/forget with key pattern forge:quality-gate:fp:<hash>
 * where hash is SHA-256 of agent+category+file+title (excludes line numbers).
 */

const crypto = require('crypto');
const { bd, bdArgs, output, forgeError } = require('./core.cjs');

const FP_KEY_PREFIX = 'forge:quality-gate:fp:';

/**
 * Compute a deterministic FP hash from finding fields.
 * SHA-256 of concatenation: agent + category + file + title.
 * Line numbers are excluded so the same finding survives line shifts.
 */
function computeFpHash(agent, category, file, title) {
  const input = `${agent}${category}${file}${title}`;
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
      fps.push({ hash, key, ...finding });
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

    const key = `${FP_KEY_PREFIX}${params.hash}`;
    bdArgs(['forget', key]);

    output({ ok: true, hash: params.hash, key, message: `Cleared false-positive ${params.hash}` });
  },
};
