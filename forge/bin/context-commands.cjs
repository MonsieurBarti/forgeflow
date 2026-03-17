'use strict';

/**
 * context-commands.cjs -- Agent context and retrospective commands.
 *
 * Commands: context-write, context-read, retro-query
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const {
  bdArgs, bdJsonArgs, output, forgeError, validateId, normalizeChildren,
} = require('./core.cjs');
const { validate } = require('../schemas/schemas.cjs');

/**
 * Read phase comments, parse JSON entries, and return context entries.
 *
 * Iterates over phase bead comments, silently skips non-JSON entries, and
 * returns parsed objects that have an `agent` field.  When `agentFilter` is
 * provided, only entries whose `agent` matches are returned.
 *
 * @param {string} phaseId - The phase bead ID.
 * @param {string|null} [agentFilter] - If set, only entries with this agent value are returned.
 *   Pass null (or omit) to return all entries that have an agent field.
 * @returns {Array<Object>} Parsed context entry objects.
 */
function readAgentContextEntries(phaseId, agentFilter = null) {
  const comments = bdJsonArgs(['comments', phaseId]);
  if (!comments) return [];

  const list = Array.isArray(comments) ? comments : (comments.comments || []);
  const entries = [];

  for (const c of list) {
    const body = c.body || c.content || c.text || '';
    try {
      const parsed = JSON.parse(body);
      if (!parsed.agent) continue;
      if (agentFilter !== null && parsed.agent !== agentFilter) continue;
      entries.push(parsed);
    } catch {
      // INTENTIONALLY SILENT: comments can be free-text (not JSON); skipping
      // non-JSON comments is the expected behavior when filtering for context entries.
    }
  }

  return entries;
}

module.exports = {
  // Expose helper for programmatic use by other command modules
  readAgentContextEntries,

  /**
   * Write structured agent context to a phase bead as a JSON comment.
   */
  'context-write'(args) {
    const phaseId = args[0];
    const jsonStr = args.slice(1).join(' ');
    if (!phaseId || !jsonStr) {
      forgeError('MISSING_ARG', 'Missing required arguments: phase-id and json-string', 'Run: forge-tools context-write <phase-id> <json-string>');
    }
    validateId(phaseId);

    let ctx;
    try {
      ctx = JSON.parse(jsonStr);
    } catch {
      forgeError('INVALID_INPUT', 'Invalid JSON input', 'Provide valid JSON with at least "agent" and "status" fields');
    }

    if (!ctx.agent || !ctx.status) {
      forgeError('INVALID_INPUT', 'Missing required fields: agent and status', 'JSON must include "agent" and "status" fields, e.g. {"agent":"forge-executor","status":"completed"}');
    }
    if (ctx.agent.length > 128 || ctx.status.length > 128) {
      forgeError('INVALID_INPUT', 'Fields "agent" and "status" must not exceed 128 characters', 'Shorten the agent or status value to 128 characters or fewer');
    }

    const schema = {
      agent: ctx.agent,
      task: ctx.task || null,
      status: ctx.status,
      findings: ctx.findings || [],
      decisions: ctx.decisions || [],
      blockers: ctx.blockers || [],
      artifacts: ctx.artifacts || [],
      next_steps: ctx.next_steps || [],
      timestamp: new Date().toISOString(),
    };

    validate('context-write-envelope', schema);

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-'));
    const tmpFile = path.join(tmpDir, 'ctx.json');
    fs.writeFileSync(tmpFile, JSON.stringify(schema, null, 2));

    try {
      bdArgs(['comments', 'add', phaseId, '-f', tmpFile]);
      output({ written: true, phase_id: phaseId, agent: schema.agent, task: schema.task }, 'context-write');
    } finally {
      // INTENTIONALLY SILENT: temp file/dir cleanup is best-effort; failure to remove
      // a /tmp entry does not affect the command's result.
      try { fs.unlinkSync(tmpFile); } catch { /* cleanup best-effort */ }
      try { fs.rmdirSync(tmpDir); } catch { /* cleanup best-effort */ }
    }
  },

  /**
   * Read all structured JSON context comments from a phase bead.
   */
  'context-read'(args) {
    const phaseId = args[0];
    if (!phaseId) {
      forgeError('MISSING_ARG', 'Missing required argument: phase-id', 'Run: forge-tools context-read <phase-id>');
    }
    validateId(phaseId);

    // All structured context entries (any agent, must have a status field)
    const contexts = readAgentContextEntries(phaseId).filter(e => e.status);

    output({ phase_id: phaseId, contexts }, 'context-read');
  },

  /**
   * Query retrospective data from all closed phases under a project.
   * Aggregates findings from forge-verifier context entries into a structured summary.
   */
  'retro-query'(args) {
    const projectId = args[0];
    if (!projectId) {
      forgeError('MISSING_ARG', 'Missing required argument: project-id', 'Run: forge-tools retro-query <project-id>');
    }
    validateId(projectId);

    // Two-level traversal: project -> milestones -> phases (milestone hierarchy from Phase 9.1)
    const children = bdJsonArgs(['children', projectId]);
    const issues = normalizeChildren(children);
    const milestones = issues.filter(i => (i.labels || []).includes('forge:milestone'));
    const allIssues = [];
    const seenIds = new Set();
    const addIssues = (items) => {
      for (const i of items) {
        if (seenIds.has(i.id)) continue;
        seenIds.add(i.id);
        allIssues.push(i);
      }
    };
    for (const ms of milestones) {
      const msChildren = bdJsonArgs(['children', ms.id]);
      const msIssues = normalizeChildren(msChildren);
      addIssues(msIssues);
    }
    addIssues(issues); // Also collect legacy direct children
    const phases = allIssues.filter(i =>
      (i.labels || []).includes('forge:phase') && i.status === 'closed'
    );

    const lessons = [];
    const pitfallFlags = [];
    const effectivenessRatings = {};
    let phaseCount = 0;

    // TODO(perf): N+1 subprocess -- calls bd comments per closed phase. Needs bd CLI batch-query support.
    for (const phase of phases) {
      const comments = bdJsonArgs(['comments', phase.id]);
      if (!comments) continue;

      const list = Array.isArray(comments) ? comments : (comments.comments || []);
      let hasRetro = false;

      for (const c of list) {
        const body = c.body || c.content || c.text || '';
        let parsed;
        try {
          parsed = JSON.parse(body);
        } catch {
          // INTENTIONALLY SILENT: non-JSON comments are skipped when scanning
          // for structured forge-verifier context entries.
          continue;
        }

        if (parsed.agent !== 'forge-verifier' || parsed.status !== 'completed') continue;
        hasRetro = true;

        // Extract lessons from findings and decisions
        for (const f of (parsed.findings || [])) {
          lessons.push({ phase_id: phase.id, phase_title: phase.title, lesson: f });
        }
        for (const d of (parsed.decisions || [])) {
          lessons.push({ phase_id: phase.id, phase_title: phase.title, lesson: d });
        }

        // Extract pitfalls from blockers
        for (const b of (parsed.blockers || [])) {
          pitfallFlags.push({ phase_id: phase.id, phase_title: phase.title, pitfall: b });
        }

        // Build effectiveness rating from available data
        const findingsCount = (parsed.findings || []).length;
        const blockersCount = (parsed.blockers || []).length;
        effectivenessRatings[phase.id] = {
          phase_title: phase.title,
          findings: findingsCount,
          blockers: blockersCount,
          rating: blockersCount === 0 ? 'clean' : blockersCount <= 2 ? 'minor_issues' : 'significant_issues',
        };
      }

      if (hasRetro) phaseCount++;
    }

    output({
      project_id: projectId,
      phase_count: phaseCount,
      lessons,
      pitfall_flags: pitfallFlags,
      effectiveness_ratings: effectivenessRatings,
    }, 'retro-query');
  },
};
