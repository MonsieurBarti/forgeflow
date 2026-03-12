#!/usr/bin/env node
'use strict';

/**
 * index.cjs -- Entry point for forge-tools. Merges all domain modules and dispatches commands.
 */

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
  console.error(`Unknown command: ${command}`);
  console.error(`Available: ${Object.keys(commands).join(', ')}`);
  process.exit(1);
}

try {
  commands[command](args);
} catch (err) {
  console.error(`Error in ${command}: ${err.message}`);
  process.exit(1);
}
