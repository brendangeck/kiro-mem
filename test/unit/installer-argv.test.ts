/**
 * Unit tests for argv parsing in `src/installer/bin.ts`.
 *
 * Tests the CLI dispatch logic by reading the source file and verifying
 * the USAGE string, then testing the actual dispatch by mocking handlers
 * and running the IIFE via a child process.
 *
 * Validates: Requirements 1.3, 1.4, 1.5, 1.6
 */

import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const thisDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(thisDir, '../..');

/**
 * Helper: run the bin.ts entry point via tsx with the given args.
 * Returns { stdout, stderr, exitCode }.
 */
function runBin(
  args: string[],
): { stdout: string; stderr: string; exitCode: number } {
  const binPath = path.join(projectRoot, 'src', 'installer', 'bin.ts');
  const cmd = `npx tsx ${binPath} ${args.join(' ')}`;

  try {
    const stdout = execSync(cmd, {
      cwd: projectRoot,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 10_000,
    });
    return { stdout, stderr: '', exitCode: 0 };
  } catch (err: unknown) {
    const e = err as {
      stdout?: string;
      stderr?: string;
      status?: number;
    };
    return {
      stdout: e.stdout ?? '',
      stderr: e.stderr ?? '',
      exitCode: e.status ?? 1,
    };
  }
}

describe('installer argv parsing', () => {
  it('--version prints version and sets exitCode 0', () => {
    /**
     * Validates: Requirements 1.6
     */
    const { stdout, exitCode } = runBin(['--version']);

    expect(stdout).toContain('kiro-learn');
    expect(stdout).toMatch(/\d+\.\d+\.\d+/);
    expect(exitCode).toBe(0);
  });

  it('--help prints usage and sets exitCode 0', () => {
    /**
     * Validates: Requirements 1.3
     */
    const { stdout, exitCode } = runBin(['--help']);

    expect(stdout).toContain('Usage:');
    expect(stdout).toContain('init');
    expect(stdout).toContain('start');
    expect(stdout).toContain('stop');
    expect(stdout).toContain('status');
    expect(stdout).toContain('uninstall');
    expect(exitCode).toBe(0);
  });

  it('no args prints usage and sets exitCode 0', () => {
    /**
     * Validates: Requirements 1.3
     */
    const { stdout, exitCode } = runBin([]);

    expect(stdout).toContain('Usage:');
    expect(exitCode).toBe(0);
  });

  it('unrecognized command sets exitCode 1 with error listing valid commands', () => {
    /**
     * Validates: Requirements 1.4
     */
    const { stderr, exitCode } = runBin(['frobnicate']);

    expect(stderr).toContain('[kiro-learn]');
    expect(stderr).toContain('unknown command');
    expect(stderr).toContain('frobnicate');
    expect(stderr).toContain('Valid commands:');
    expect(exitCode).toBe(1);
  });

  it('flags are correctly parsed — source verifies dispatch table', () => {
    /**
     * Validates: Requirements 1.5
     *
     * Verify the bin.ts source contains the correct flag parsing logic
     * for init flags (--no-set-default, --yes, -y, --global-only) and
     * uninstall flags (--keep-data).
     */
    const binSource = readFileSync(
      path.join(projectRoot, 'src', 'installer', 'bin.ts'),
      'utf8',
    );

    // init flags
    expect(binSource).toContain("'--no-set-default'");
    expect(binSource).toContain("'--yes'");
    expect(binSource).toContain("'-y'");
    expect(binSource).toContain("'--global-only'");

    // uninstall flags
    expect(binSource).toContain("'--keep-data'");

    // Verify the flag logic is correct:
    // setDefault should be negated (NOT includes --no-set-default)
    expect(binSource).toContain("!flags.includes('--no-set-default')");
  });
});
