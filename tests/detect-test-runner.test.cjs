'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const path = require('node:path');

const forgeToolsPath = path.resolve(__dirname, '..', 'forge', 'bin', 'forge-tools.cjs');

describe('detect-test-runner', () => {
  it('detects the Node.js test runner for this project', () => {
    const raw = execFileSync('node', [forgeToolsPath, 'detect-test-runner'], {
      encoding: 'utf8',
      timeout: 10_000,
      cwd: path.resolve(__dirname, '..'),
    });

    const result = JSON.parse(raw);

    // Verify all expected fields are present
    assert.ok('runner' in result, 'output should have runner field');
    assert.ok('command' in result, 'output should have command field');
    assert.ok('framework' in result, 'output should have framework field');
    assert.ok('test_directory' in result, 'output should have test_directory field');

    // This is a Node.js project using node --test
    assert.equal(result.runner, 'node');
    assert.equal(result.command, 'npm test');
    assert.equal(result.framework, 'node:test');
    assert.ok(result.test_directory, 'test_directory should not be null');
  });
});
