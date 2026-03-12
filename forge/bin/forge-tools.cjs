#!/usr/bin/env node
'use strict';

/**
 * forge-tools.cjs -- Thin wrapper: delegates all commands to index.cjs.
 * Kept for backwards compatibility so all existing workflow references continue to work.
 *
 * Usage: node forge-tools.cjs <command> [args]
 */

require('./index.cjs');
