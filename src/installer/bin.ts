#!/usr/bin/env node
/**
 * CLI entry point for `kiro-learn`.
 *
 * Parses argv, dispatches to command handlers, sets exit code.
 * No third-party CLI framework — argv is simple enough for manual parsing.
 *
 * @see Requirements 1.1–1.9
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  cmdInit,
  cmdStart,
  cmdStop,
  cmdStatus,
  cmdUninstall,
} from './index.js';

const USAGE = `kiro-learn — continuous learning for Kiro agent sessions

Usage: kiro-learn <command> [options]

Commands:
  init        Install or upgrade kiro-learn
  start       Start the collector daemon
  stop        Stop the collector daemon
  status      Show install and daemon status
  uninstall   Remove kiro-learn

Options:
  --version   Show version
  --help      Show this help

Init options:
  --no-set-default  Don't set kiro-learn as default agent
  --yes, -y         Skip confirmation prompts
  --global-only     Force global-only scope

Uninstall options:
  --keep-data       Preserve database, settings, and logs
`;

(async () => {
  const args = process.argv.slice(2);
  const command = args[0];

  if (command === '--version') {
    const thisFile = fileURLToPath(import.meta.url);
    const pkgPath = path.resolve(path.dirname(thisFile), '..', '..', 'package.json');
    const pkgRaw = readFileSync(pkgPath, 'utf8');
    const pkg = JSON.parse(pkgRaw) as { version: string };
    process.stdout.write(`kiro-learn ${pkg.version}\n`);
    process.exitCode = 0;
    return;
  }

  if (command === '--help' || command === undefined) {
    process.stdout.write(USAGE);
    process.exitCode = 0;
    return;
  }

  const flags = args.slice(1);

  switch (command) {
    case 'init': {
      const setDefault = !flags.includes('--no-set-default');
      const yes = flags.includes('--yes') || flags.includes('-y');
      const globalOnly = flags.includes('--global-only');
      process.exitCode = await cmdInit({ setDefault, yes, globalOnly });
      break;
    }

    case 'start':
      process.exitCode = cmdStart();
      break;

    case 'stop':
      process.exitCode = cmdStop();
      break;

    case 'status':
      process.exitCode = cmdStatus();
      break;

    case 'uninstall': {
      const keepData = flags.includes('--keep-data');
      process.exitCode = cmdUninstall({ keepData });
      break;
    }

    default:
      process.stderr.write(`[kiro-learn] unknown command: ${command}\n`);
      process.stderr.write('Valid commands: init, start, stop, status, uninstall\n');
      process.exitCode = 1;
      break;
  }
})();
