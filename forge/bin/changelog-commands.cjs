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

  /**
   * Bump the version in package.json based on Conventional Commits.
   * Auto-detects bump level: breaking! -> major, feat -> minor, else -> patch.
   * Supports --level=major|minor|patch override.
   *
   * Args: [--level=major|minor|patch]
   */
  'version-bump'(args) {
    const levelFlag = (args || []).find(a => a.startsWith('--level='));
    const explicitLevel = levelFlag ? levelFlag.split('=')[1] : null;

    if (explicitLevel && !['major', 'minor', 'patch'].includes(explicitLevel)) {
      forgeError('INVALID_INPUT', `Invalid level: ${explicitLevel}`, 'Use --level=major|minor|patch');
    }

    // Find package.json
    const gitRoot = findGitRoot(process.cwd());
    const pkgPath = gitRoot ? path.join(gitRoot, 'package.json') : path.join(process.cwd(), 'package.json');

    let pkgText;
    try {
      pkgText = fs.readFileSync(pkgPath, 'utf8');
    } catch {
      forgeError('MISSING_FILE', 'package.json not found', `Expected at: ${pkgPath}. Ensure you are in a project directory.`);
    }

    let pkg;
    try {
      pkg = JSON.parse(pkgText);
    } catch {
      forgeError('INVALID_INPUT', 'package.json is not valid JSON', `Check syntax at: ${pkgPath}`);
    }

    const previousVersion = pkg.version || '0.0.0';

    // Determine bump level
    let level = explicitLevel;
    let autoDetected = !explicitLevel;

    if (!level) {
      // Auto-detect from CC types since last tag
      const lastTag = git(['describe', '--tags', '--abbrev=0'], { allowFail: true })?.trim() || '';
      const commits = parseConventionalCommits(lastTag);

      const hasBreaking = commits.some(c => c.breaking);
      const hasFeat = commits.some(c => c.type === 'feat');

      if (hasBreaking) level = 'major';
      else if (hasFeat) level = 'minor';
      else level = 'patch';
    }

    // Bump version
    const parts = previousVersion.split('.').map(Number);
    if (parts.length !== 3 || parts.some(isNaN)) {
      forgeError('INVALID_INPUT', `Current version "${previousVersion}" is not valid semver`, 'Version must be in X.Y.Z format');
    }

    if (level === 'major') {
      parts[0]++;
      parts[1] = 0;
      parts[2] = 0;
    } else if (level === 'minor') {
      parts[1]++;
      parts[2] = 0;
    } else {
      parts[2]++;
    }

    const newVersion = parts.join('.');

    // Validate the new version is strictly greater
    const prevParts = previousVersion.split('.').map(Number);
    const isGreater = parts[0] > prevParts[0] ||
      (parts[0] === prevParts[0] && parts[1] > prevParts[1]) ||
      (parts[0] === prevParts[0] && parts[1] === prevParts[1] && parts[2] > prevParts[2]);

    if (!isGreater) {
      forgeError('INVALID_INPUT', `Computed version ${newVersion} is not greater than current ${previousVersion}`, 'This should not happen. Check the bump logic or use --level to override.');
    }

    // Validate new version is strict semver
    if (!/^\d+\.\d+\.\d+$/.test(newVersion)) {
      forgeError('INVALID_INPUT', `Computed version "${newVersion}" is not valid semver`, 'Version must be in X.Y.Z format');
    }

    // Write back with 2-space indent (standard for package.json)
    pkg.version = newVersion;
    fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');

    output({
      bumped: true,
      previousVersion,
      newVersion,
      level,
      autoDetected,
    });
  },

  /**
   * Create a GitHub release with the latest CHANGELOG.md section as the body.
   * Creates a git tag, pushes it, and calls gh release create.
   *
   * Idempotency: aborts if tag or release already exists.
   */
  'release-create'(args) {
    const gitRoot = findGitRoot(process.cwd()) || process.cwd();

    // Read version from package.json
    const pkgPath = path.join(gitRoot, 'package.json');
    let version;
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
      version = pkg.version;
    } catch {
      forgeError('MISSING_FILE', 'package.json not found or invalid', `Expected at: ${pkgPath}`);
    }

    if (!version || !/^\d+\.\d+\.\d+$/.test(version)) {
      forgeError('INVALID_INPUT', `Version "${version}" is not valid semver`, 'Run forge-tools version-bump first');
    }

    const tag = `v${version}`;

    // Idempotency: check if tag already exists
    const existingTag = git(['tag', '--list', tag], { allowFail: true });
    if (existingTag) {
      forgeError('ALREADY_EXISTS', `Tag ${tag} already exists`, `A release for ${tag} may already exist. Check with: gh release view ${tag}`);
    }

    // Idempotency: check if release already exists
    const existingRelease = gh(['release', 'view', tag, '--json', 'url', '--jq', '.url'], { allowFail: true });
    if (existingRelease) {
      output({ created: false, tag, version, releaseUrl: existingRelease.trim(), reason: 'already_exists' });
      return;
    }

    // Extract the topmost version section from CHANGELOG.md
    const changelogPath = path.join(gitRoot, 'CHANGELOG.md');
    if (!fs.existsSync(changelogPath)) {
      forgeError('MISSING_FILE', 'CHANGELOG.md not found', 'Run forge-tools changelog-generate first');
    }

    const changelog = fs.readFileSync(changelogPath, 'utf8');
    const sectionRegex = /^## \[/m;
    const firstMatch = changelog.match(sectionRegex);
    if (!firstMatch) {
      forgeError('INVALID_INPUT', 'No version sections found in CHANGELOG.md', 'Run forge-tools changelog-generate first');
    }

    // Extract from first ## [ to the next ## [ (or EOF)
    const startIdx = firstMatch.index;
    const rest = changelog.slice(startIdx + 1);
    const nextMatch = rest.match(sectionRegex);
    const releaseBody = nextMatch
      ? changelog.slice(startIdx, startIdx + 1 + nextMatch.index).trim()
      : changelog.slice(startIdx).trim();

    // Write release body to a temp file (avoids shell arg length limits)
    const tmpDir = require('os').tmpdir();
    const notesFile = path.join(tmpDir, `forge-release-${tag}.md`);
    fs.writeFileSync(notesFile, releaseBody);

    try {
      // Create and push tag (never force)
      git(['tag', tag]);
      git(['push', 'origin', tag]);

      // Create release via gh CLI
      const releaseUrl = gh([
        'release', 'create', tag,
        '--title', tag,
        '--notes-file', notesFile,
      ]);

      output({ created: true, tag, version, releaseUrl: releaseUrl.trim() });
    } finally {
      // Clean up temp file
      try { fs.unlinkSync(notesFile); } catch { /* best-effort */ }
    }
  },

  // Expose helpers for internal reuse
  _parseConventionalCommits: parseConventionalCommits,
  _formatChangelogSection: formatChangelogSection,
  _groupBySection: groupBySection,
};
