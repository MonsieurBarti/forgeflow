'use strict';

/**
 * settings-commands.cjs -- Settings management commands for forge-tools.
 *
 * Commands: settings-load, settings-set, settings-clear, settings-bulk
 */

const fs = require('fs');
const path = require('path');
const {
  bd, bdArgs, output, forgeError,
  GLOBAL_SETTINGS_PATH, PROJECT_SETTINGS_NAME,
  SETTINGS_DEFAULTS, SETTINGS_DESCRIPTIONS, SETTINGS_ENUMS,
  parseSimpleYaml, toSimpleYaml, parseFrontmatter, writeFrontmatter,
  resolveSettings,
} = require('./core.cjs');

/**
 * Coerce string 'true'/'false' to boolean, pass through everything else.
 */
function coerceBool(v) {
  if (v === 'true') return true;
  if (v === 'false') return false;
  return v;
}

/**
 * Parse a dot-separated settings key into { topKey, subKey, isNested }.
 */
function parseDotKey(key) {
  const dotIdx = key.indexOf('.');
  const isNested = dotIdx !== -1;
  return {
    topKey: isNested ? key.slice(0, dotIdx) : key,
    subKey: isNested ? key.slice(dotIdx + 1) : null,
    isNested,
  };
}

/**
 * Load settings merged from defaults < global < project.
 * Returns { merged, sources }.
 */
function loadMergedSettings() {
  const merged = { ...SETTINGS_DEFAULTS };
  const sources = {};
  for (const key of Object.keys(SETTINGS_DEFAULTS)) {
    sources[key] = 'default';
  }

  try {
    const globalText = fs.readFileSync(GLOBAL_SETTINGS_PATH, 'utf8');
    const globalSettings = parseFrontmatter(globalText);
    for (const [key, val] of Object.entries(globalSettings)) {
      if (key in SETTINGS_DEFAULTS) {
        merged[key] = val;
        sources[key] = 'global';
      }
    }
  } catch {
    // INTENTIONALLY SILENT: global settings file is optional; defaults suffice
  }

  try {
    const projectPath = path.resolve(process.cwd(), PROJECT_SETTINGS_NAME);
    const projectText = fs.readFileSync(projectPath, 'utf8');
    const projectSettings = parseSimpleYaml(projectText);
    for (const [key, val] of Object.entries(projectSettings)) {
      if (key in SETTINGS_DEFAULTS) {
        merged[key] = val;
        sources[key] = 'project';
      }
    }
  } catch {
    // INTENTIONALLY SILENT: project settings file is optional; defaults suffice
  }

  return { merged, sources };
}

/**
 * Set a (possibly nested) key on a settings object.
 * Supports dot-notation keys via parseDotKey (topKey, subKey).
 */
function setNestedKey(obj, topKey, subKey, val) {
  if (subKey) {
    if (!obj[topKey] || typeof obj[topKey] !== 'object') obj[topKey] = {};
    obj[topKey][subKey] = val;
  } else {
    obj[topKey] = val;
  }
}

/**
 * Clear a (possibly nested) key from a settings object.
 * Removes empty parent objects after clearing a sub-key.
 */
function clearNestedKey(obj, topKey, subKey) {
  if (subKey && obj[topKey] && typeof obj[topKey] === 'object') {
    delete obj[topKey][subKey];
    if (Object.keys(obj[topKey]).length === 0) delete obj[topKey];
  } else {
    delete obj[topKey];
  }
}

/**
 * Read, parse, mutate, and write a settings file in one call.
 * Handles both global (frontmatter) and project (simple YAML) formats.
 *
 * @param {'global'|'project'} scope
 * @param {string} filePath - absolute path to the settings file
 * @param {function(object): void} mutatorFn - receives the parsed settings object; mutate in place
 */
function mutateSettingsFile(scope, filePath, mutatorFn) {
  if (scope === 'global') {
    let existing = {};
    let body = '';
    try {
      const text = fs.readFileSync(filePath, 'utf8');
      existing = parseFrontmatter(text);
      const bodyMatch = text.match(/^---\n[\s\S]*?\n---\n([\s\S]*)$/);
      if (bodyMatch) body = bodyMatch[1];
    } catch { /* INTENTIONALLY SILENT: file may not exist yet; will be created below */ }
    mutatorFn(existing);
    writeFrontmatter(filePath, existing, body);
  } else {
    let existing = {};
    try {
      existing = parseSimpleYaml(fs.readFileSync(filePath, 'utf8'));
    } catch { /* INTENTIONALLY SILENT: file may not exist yet; will be created below */ }
    mutatorFn(existing);
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(filePath, toSimpleYaml(existing));
  }
}

module.exports = {
  // Export loadMergedSettings as a named export so other modules can require it
  loadMergedSettings,

  /**
   * Load merged settings (defaults < global < project).
   */
  'settings-load'() {
    const { merged, sources } = loadMergedSettings();

    const settings = Object.keys(SETTINGS_DEFAULTS).map(key => ({
      key,
      value: merged[key],
      default: SETTINGS_DEFAULTS[key],
      source: sources[key],
      description: SETTINGS_DESCRIPTIONS[key],
    }));

    output({
      settings,
      global_path: GLOBAL_SETTINGS_PATH,
      project_path: path.resolve(process.cwd(), PROJECT_SETTINGS_NAME),
    }, 'settings-load');
  },

  /**
   * Set a setting value. Scope: "global" or "project".
   */
  'settings-set'(args) {
    const scope = args[0];
    const key = args[1];
    const value = args[2];

    if (!scope || !key || value === undefined) {
      forgeError('MISSING_ARG', 'Missing required arguments: scope, key, and value', 'Run: forge-tools settings-set <global|project> <key> <value>');
    }

    const { topKey, subKey, isNested } = parseDotKey(key);

    const EXTRA_TOP_KEYS = ['model_profile', 'model_overrides'];
    if (!isNested && !(topKey in SETTINGS_DEFAULTS) && !EXTRA_TOP_KEYS.includes(topKey)) {
      forgeError('INVALID_INPUT', `Unknown setting: ${key}`, `Available settings: ${Object.keys(SETTINGS_DEFAULTS).join(', ')}, model_profile, model_overrides.<agent>, models.<role>`, { key });
    }

    const parsedValue = coerceBool(value);

    // Validate enum-constrained settings
    if (!isNested && SETTINGS_ENUMS[topKey]) {
      const allowed = SETTINGS_ENUMS[topKey];
      if (!allowed.includes(parsedValue)) {
        forgeError('INVALID_INPUT', `Invalid value "${parsedValue}" for setting "${topKey}"`, `Allowed values: ${allowed.join(', ')}`, { key: topKey, value: parsedValue, allowed });
      }
    }

    if (scope === 'global' || scope === 'project') {
      const filePath = scope === 'global' ? GLOBAL_SETTINGS_PATH : path.resolve(process.cwd(), PROJECT_SETTINGS_NAME);
      mutateSettingsFile(scope, filePath, (existing) => { setNestedKey(existing, topKey, subKey, parsedValue); });
      output({ ok: true, scope, key, value: parsedValue }, 'settings-set');
    } else {
      forgeError('INVALID_INPUT', `Invalid scope: ${scope}`, 'Scope must be "global" or "project"', { scope });
    }
  },

  /**
   * Clear a setting from a scope.
   */
  'settings-clear'(args) {
    const scope = args[0];
    const key = args[1];

    if (!scope || !key) {
      forgeError('MISSING_ARG', 'Missing required arguments: scope and key', 'Run: forge-tools settings-clear <global|project> <key>');
    }

    const { topKey, subKey } = parseDotKey(key);

    if (scope === 'global' || scope === 'project') {
      const filePath = scope === 'global' ? GLOBAL_SETTINGS_PATH : path.resolve(process.cwd(), PROJECT_SETTINGS_NAME);
      try {
        mutateSettingsFile(scope, filePath, (existing) => { clearNestedKey(existing, topKey, subKey); });
      } catch { /* INTENTIONALLY SILENT: file may not exist; nothing to clear */ }
    }

    output({ ok: true, scope, key, cleared: true }, 'settings-clear');
  },

  /**
   * Bulk-set multiple settings at once from JSON input.
   */
  'settings-bulk'(args) {
    const scope = args[0];
    const jsonStr = args.slice(1).join(' ');

    if (!scope || !jsonStr) {
      forgeError('MISSING_ARG', 'Missing required arguments: scope and json', 'Run: forge-tools settings-bulk <global|project> <json>');
    }

    let updates;
    try {
      updates = JSON.parse(jsonStr);
    } catch {
      forgeError('INVALID_INPUT', 'Invalid JSON input', 'Provide valid JSON object, e.g. {"auto_commit":true,"skip_verification":false}');
    }

    const results = [];

    if (scope === 'global' || scope === 'project') {
      const filePath = scope === 'global' ? GLOBAL_SETTINGS_PATH : path.resolve(process.cwd(), PROJECT_SETTINGS_NAME);
      mutateSettingsFile(scope, filePath, (existing) => {
        for (const [key, value] of Object.entries(updates)) {
          if (!(key in SETTINGS_DEFAULTS)) continue;
          const parsedValue = coerceBool(value);
          // Validate enum-constrained settings
          if (SETTINGS_ENUMS[key]) {
            const allowed = SETTINGS_ENUMS[key];
            if (!allowed.includes(parsedValue)) {
              forgeError('INVALID_INPUT', `Invalid value "${parsedValue}" for setting "${key}"`, `Allowed values: ${allowed.join(', ')}`, { key, value: parsedValue, allowed });
            }
          }
          existing[key] = parsedValue;
          results.push({ key, value: parsedValue });
        }
      });
    }

    output({ ok: true, scope, updated: results }, 'settings-bulk-set');
  },
};
