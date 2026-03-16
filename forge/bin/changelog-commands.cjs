'use strict';

/**
 * changelog-commands.cjs -- Conventional Commits changelog and release commands.
 *
 * Commands: changelog-generate, version-bump, release-create
 */

const fs = require('fs');
const path = require('path');
const { git, gh, output, forgeError, findGitRoot } = require('./core.cjs');

// --- CC Type to Keep-a-Changelog section mapping ---

const TYPE_SECTION_MAP = {
  feat: 'Added',
  fix: 'Fixed',
  refactor: 'Changed',
  perf: 'Changed',
  docs: 'Documentation',
  revert: 'Removed',
};

// Section display order
const SECTION_ORDER = ['Added', 'Changed', 'Fixed', 'Removed', 'Documentation', 'Other'];

/**
 * Parse git log output into structured Conventional Commits.
 * Strips all scopes. Detects breaking changes.
 *
 * @param {string} fromRef  Start ref (tag or SHA). If empty, includes all commits.
 * @param {string} [toRef]  End ref. Defaults to HEAD.
 * @returns {Array<{type: string, description: string, breaking: boolean}>}
 */
function parseConventionalCommits(fromRef, toRef) {
  const logArgs = ['log', '--format=%s'];
  if (fromRef) {
    logArgs.push(`${fromRef}..${toRef || 'HEAD'}`);
  }

  const logOutput = git(logArgs, { allowFail: true });
  if (!logOutput) return [];

  const ccRegex = /^(feat|fix|refactor|perf|chore|docs|test|ci|build|style|revert)(\([^)]*\))?(!)?\s*:\s*(.+)$/;
  const commits = [];

  for (const line of logOutput.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    // Skip merge commits
    if (trimmed.startsWith('Merge ')) continue;

    const match = trimmed.match(ccRegex);
    if (!match) continue;

    const [, type, , bang, description] = match;
    commits.push({
      type,
      description: description.trim(),
      breaking: !!bang,
    });
  }

  return commits;
}

/**
 * Group commits by Keep-a-Changelog section.
 * Returns a Map preserving SECTION_ORDER.
 *
 * @param {Array} commits  Output of parseConventionalCommits()
 * @returns {Map<string, string[]>}  Section name -> list of descriptions
 */
function groupBySection(commits) {
  const groups = new Map();
  for (const section of SECTION_ORDER) {
    groups.set(section, []);
  }

  for (const commit of commits) {
    const section = TYPE_SECTION_MAP[commit.type] || 'Other';
    groups.get(section).push(commit.description);
  }

  return groups;
}

/**
 * Format grouped commits as a Keep-a-Changelog version section.
 *
 * @param {string} version  Version string (e.g. "0.3.0")
 * @param {string} date     ISO date string (e.g. "2026-03-16")
 * @param {Map} groups      Output of groupBySection()
 * @returns {string}  Formatted markdown section
 */
function formatChangelogSection(version, date, groups) {
  const lines = [`## [${version}] - ${date}`, ''];

  for (const section of SECTION_ORDER) {
    const items = groups.get(section);
    if (!items || items.length === 0) continue;
    lines.push(`### ${section}`, '');
    for (const desc of items) {
      lines.push(`- ${desc}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

module.exports = {
  /**
   * Generate a changelog from Conventional Commits since the last tag.
   * Writes/prepends to CHANGELOG.md in Keep-a-Changelog format.
   *
   * Args: [--tag=<from-tag>] [--version=<version>]
   */
  'changelog-generate'(args) {
    const tagFlag = (args || []).find(a => a.startsWith('--tag='));
    const versionFlag = (args || []).find(a => a.startsWith('--version='));

    // Determine the "since" tag
    let fromTag = tagFlag ? tagFlag.split('=')[1] : null;
    if (!fromTag) {
      // Auto-detect last tag
      fromTag = git(['describe', '--tags', '--abbrev=0'], { allowFail: true }) || '';
      fromTag = fromTag.trim();
    }

    // Parse commits
    const commits = parseConventionalCommits(fromTag);
    if (commits.length === 0) {
      output({ generated: false, reason: 'no_commits', fromTag: fromTag || '(all)', commitCount: 0 });
      return;
    }

    // Determine version for the header
    let version = versionFlag ? versionFlag.split('=')[1] : 'Unreleased';

    // If no explicit version, try to read from package.json
    if (!versionFlag) {
      const gitRoot = findGitRoot(process.cwd());
      if (gitRoot) {
        try {
          const pkg = JSON.parse(fs.readFileSync(path.join(gitRoot, 'package.json'), 'utf8'));
          if (pkg.version) version = pkg.version;
        } catch { /* best-effort */ }
      }
    }

    const date = new Date().toISOString().split('T')[0];
    const groups = groupBySection(commits);
    const newSection = formatChangelogSection(version, date, groups);

    // Count non-empty sections for output
    const sectionNames = [];
    for (const [name, items] of groups) {
      if (items.length > 0) sectionNames.push(name);
    }

    // Write/prepend to CHANGELOG.md
    const gitRoot = findGitRoot(process.cwd()) || process.cwd();
    const changelogPath = path.join(gitRoot, 'CHANGELOG.md');

    let content;
    if (fs.existsSync(changelogPath)) {
      const existing = fs.readFileSync(changelogPath, 'utf8');
      // Find insertion point: after the # Changelog header line
      const headerMatch = existing.match(/^# Changelog\s*\n/m);
      if (headerMatch) {
        const insertIdx = headerMatch.index + headerMatch[0].length;
        content = existing.slice(0, insertIdx) + '\n' + newSection + existing.slice(insertIdx);
      } else {
        // No header found, prepend everything
        content = `# Changelog\n\n${newSection}${existing}`;
      }
    } else {
      content = `# Changelog\n\nAll notable changes to this project will be documented in this file.\n\nThe format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).\n\n${newSection}`;
    }

    fs.writeFileSync(changelogPath, content);

    output({
      generated: true,
      path: changelogPath,
      commitCount: commits.length,
      sections: sectionNames,
      version,
      fromTag: fromTag || '(all)',
    });
  },

  // Expose the parser so version-bump can reuse it
  _parseConventionalCommits: parseConventionalCommits,
};
