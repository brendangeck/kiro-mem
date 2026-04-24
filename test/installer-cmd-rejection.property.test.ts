/**
 * Property-based test: Unrecognized command rejection.
 *
 * Feature: installer, Property 1: Unrecognized command rejection
 *
 * For any string not in {init, start, stop, status, uninstall, --help, --version},
 * the CLI produces exit code 1 and stderr lists valid commands.
 *
 * **Validates: Requirements 1.4**
 *
 * @see .kiro/specs/installer/design.md § Property 1
 */

import { execSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fc from 'fast-check';
import { describe, it, expect } from 'vitest';

const thisDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(thisDir, '..');
const binPath = path.join(projectRoot, 'src', 'installer', 'bin.ts');

/** The set of valid commands and flags that the CLI recognizes. */
const VALID_COMMANDS = new Set([
  'init',
  'start',
  'stop',
  'status',
  'uninstall',
  '--help',
  '--version',
]);

/**
 * Run bin.ts with a single argument and return stdout, stderr, exitCode.
 */
function runBin(arg: string): { stdout: string; stderr: string; exitCode: number } {
  // Shell-escape the argument to prevent injection
  const escaped = arg.replace(/'/g, "'\\''");
  const cmd = `npx tsx ${binPath} '${escaped}'`;

  try {
    const stdout = execSync(cmd, {
      cwd: projectRoot,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 15_000,
    });
    return { stdout, stderr: '', exitCode: 0 };
  } catch (err: unknown) {
    const e = err as { stdout?: string; stderr?: string; status?: number };
    return {
      stdout: e.stdout ?? '',
      stderr: e.stderr ?? '',
      exitCode: e.status ?? 1,
    };
  }
}

describe('Installer — property: unrecognized command rejection (P1)', () => {
  it('any non-valid command string produces exit 1 and stderr lists valid commands', () => {
    /**
     * **Validates: Requirements 1.4**
     */
    fc.assert(
      fc.property(
        fc
          .string({ minLength: 1, maxLength: 30 })
          .filter((s) => !VALID_COMMANDS.has(s) && !s.includes('\0') && !s.includes('\n')),
        (cmd) => {
          const result = runBin(cmd);
          expect(result.exitCode).toBe(1);
          expect(result.stderr).toContain('Valid commands:');
        },
      ),
      { numRuns: 100 },
    );
  });
});
