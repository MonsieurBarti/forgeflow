#!/usr/bin/env node
'use strict';

/**
 * index.cjs -- Entry point for forge-tools. Merges all domain modules and dispatches commands.
 */

const { forgeError } = require('./core.cjs');
const phaseCommands = require('./phase-commands.cjs');
const contextCommands = require('./context-commands.cjs');
const projectCommands = require('./project-commands.cjs');
const settingsCommands = require('./settings-commands.cjs');
const gitCommands = require('./git-commands.cjs');
const roadmapCommands = require('./roadmap-commands.cjs');
const qualityGateCommands = require('./quality-gate-commands.cjs');
const cleanupCommands = require('./cleanup-commands.cjs');
const changelogCommands = require('./changelog-commands.cjs');

const commands = Object.assign(
  {},
  phaseCommands,
  contextCommands,
  projectCommands,
  settingsCommands,
  gitCommands,
  roadmapCommands,
  qualityGateCommands,
  cleanupCommands,
  changelogCommands
);

const [command, ...args] = process.argv.slice(2);

if (!command || command === '--help' || command === '-h') {
  console.log('Usage: forge-tools <command> [args]');
  console.log('\nCommands:');
  Object.keys(commands).forEach(cmd => console.log(`  ${cmd}`));
  process.exit(0);
}

if (!commands[command]) {
  forgeError('UNKNOWN_COMMAND', `Unknown command: ${command}`, `Available commands: ${Object.keys(commands).join(', ')}`, { command });
}

try {
  const result = commands[command](args);
  // Some commands (e.g. generate-dashboard, quality-gate-triage) return a Promise
  // when they start a dev-server. Use Promise.resolve() for uniform handling so
  // the process stays alive until the promise settles and errors are surfaced properly.
  Promise.resolve(result).catch((err) => {
    const code = err.code || 'COMMAND_FAILED';
    const suggestion = err.suggestion || `Run: forge-tools ${command} --help or check arguments`;
    forgeError(code, `Error in ${command}: ${err.message}`, suggestion, { command, error: err.message });
  });
} catch (err) {
  // Propagate specific error codes (e.g. BD_CONNECTION_ERROR) so consumers
  // can distinguish infrastructure failures from logical command errors.
  const code = err.code || 'COMMAND_FAILED';
  const suggestion = err.suggestion || `Run: forge-tools ${command} --help or check arguments`;
  forgeError(code, `Error in ${command}: ${err.message}`, suggestion, { command, error: err.message });
}
