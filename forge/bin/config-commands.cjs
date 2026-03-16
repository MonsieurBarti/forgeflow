'use strict';

/**
 * config-commands.cjs -- Model resolution and config management commands for forge-tools.
 *
 * Commands: resolve-model, model-for-role, model-profiles, config-get, config-set, config-list, config-clear
 */

const {
  resolveAgentModel, loadModelProfile, loadModelOverrides,
  MODEL_PROFILES, ROLE_TO_AGENT,
  bd, bdArgs, output, forgeError,
} = require('./core.cjs');

module.exports = {
  /**
   * Resolve the model for a given agent.
   */
  'resolve-model'(args) {
    const rawFlag = args.includes('--raw');
    const agent = args.filter(a => a !== '--raw')[0];
    if (!agent) {
      forgeError('MISSING_ARG', 'Missing required argument: agent-name', 'Run: forge-tools resolve-model <agent-name> [--raw]');
    }

    const result = resolveAgentModel(agent);

    if (rawFlag) {
      process.stdout.write(result.model || '');
    } else {
      output({ agent: ROLE_TO_AGENT[agent] || agent, ...result, profile: loadModelProfile() }, 'resolve-model');
    }
  },

  /**
   * Backwards-compatible alias for resolve-model.
   */
  'model-for-role'(args) {
    const role = args[0];
    if (!role) {
      forgeError('MISSING_ARG', 'Missing required argument: role', 'Run: forge-tools model-for-role <role>');
    }

    const result = resolveAgentModel(role);
    output({ role, model: result.model, source: result.source }, 'resolve-role');
  },

  /**
   * Show all agent model assignments for the active profile.
   */
  'model-profiles'() {
    const profile = loadModelProfile();
    const overrides = loadModelOverrides();
    const agents = Object.keys(MODEL_PROFILES);

    const effective = {};
    for (const agent of agents) {
      const result = resolveAgentModel(agent);
      effective[agent] = result;
    }

    output({
      profile,
      overrides,
      effective,
      agents,
      available_profiles: ['quality', 'balanced', 'budget'],
    }, 'model-assignments');
  },

  /**
   * Get a Forge config value via bd kv.
   */
  'config-get'(args) {
    const key = args[0];
    if (!key) {
      forgeError('MISSING_ARG', 'Missing required argument: key', 'Run: forge-tools config-get <key>. List keys with: forge-tools config-list');
    }
    const fullKey = key.startsWith('forge.') ? key : `forge.${key}`;
    const value = bdArgs(['kv', 'get', fullKey], { allowFail: true });
    output({ key: fullKey, value: value || null }, 'config-get');
  },

  /**
   * Set a Forge config value via bd kv.
   */
  'config-set'(args) {
    const key = args[0];
    const value = args.slice(1).join(' ');
    if (!key || !value) {
      forgeError('MISSING_ARG', 'Missing required arguments: key and value', 'Run: forge-tools config-set <key> <value>. List keys with: forge-tools config-list');
    }
    const fullKey = key.startsWith('forge.') ? key : `forge.${key}`;
    bdArgs(['kv', 'set', fullKey, value]);
    output({ ok: true, key: fullKey, value }, 'config-set');
  },

  /**
   * List all Forge config values.
   */
  'config-list'() {
    const raw = bd('kv list --json', { allowFail: true });
    let kvMap = {};
    if (raw) {
      // INTENTIONALLY SILENT: bd kv list may return non-JSON; empty map is safe fallback
      try { kvMap = JSON.parse(raw); } catch { /* allowFail JSON parse fallback */ }
    }
    if (Array.isArray(kvMap)) {
      const obj = {};
      for (const item of kvMap) obj[item.key] = item.value;
      kvMap = obj;
    }
    const forgeKv = Object.entries(kvMap)
      .filter(([k]) => k.startsWith('forge.'))
      .map(([key, value]) => ({ key, value }));
    output({
      config: forgeKv,
      available_keys: [
        { key: 'forge.context_warning', default: '0.35', description: 'Context warning threshold (0-1)' },
        { key: 'forge.context_critical', default: '0.25', description: 'Context critical/block threshold (0-1)' },
        { key: 'forge.update_check', default: 'true', description: 'Enable update check on session start' },
        { key: 'forge.auto_research', default: 'true', description: 'Auto-run research before planning' },
      ],
    }, 'config-list');
  },

  /**
   * Clear a Forge config value.
   */
  'config-clear'(args) {
    const key = args[0];
    if (!key) {
      forgeError('MISSING_ARG', 'Missing required argument: key', 'Run: forge-tools config-clear <key>. List keys with: forge-tools config-list');
    }
    const fullKey = key.startsWith('forge.') ? key : `forge.${key}`;
    bdArgs(['kv', 'clear', fullKey], { allowFail: true });
    output({ ok: true, key: fullKey, cleared: true }, 'config-clear');
  },
};
