#!/usr/bin/env node
'use strict';

/**
 * index.cjs -- Entry point for forge-tools. Merges all domain modules and dispatches commands.
 */

const { forgeError } = require('./core.cjs');
const phaseCommands = require('./phase-commands.cjs');
const projectCommands = require('./project-commands.cjs');
const gitCommands = require('./git-commands.cjs');
const roadmapCommands = require('./roadmap-commands.cjs');

const commands = Object.assign(
  {},
  phaseCommands,
  projectCommands,
  gitCommands,
  roadmapCommands
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
  commands[command](args);
} catch (err) {
  // Propagate specific error codes (e.g. BD_CONNECTION_ERROR) so consumers
  // can distinguish infrastructure failures from logical command errors.
  const code = err.code || 'COMMAND_FAILED';
  const suggestion = err.suggestion || `Run: forge-tools ${command} --help or check arguments`;
  forgeError(code, `Error in ${command}: ${err.message}`, suggestion, { command, error: err.message });
}
