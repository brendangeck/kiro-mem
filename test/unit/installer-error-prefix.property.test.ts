/**
 * Property-based test: Error message prefix.
 *
 * Feature: installer, Property 5: Error message prefix
 *
 * For any error condition that causes stderr output, the output contains
 * the [kiro-learn] prefix.
 *
 * **Validates: Requirements 13.5**
 *
 * @see .kiro/specs/installer/design.md § Property 5
 */

import { execSync } from 'node:child_process';
import {
  mkdtempSync,
  realpathSync,
  rmSync,
} from 'node:fs';
import type * as nodeOs from 'node:os';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fc from 'fast-check';
import { afterAll, describe, expect, it, vi } from 'vitest';

const thisDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(thisDir, '../..');
const binPath = path.join(projectRoot, 'src', 'installer', 'bin.ts');

// ── Child process helper for command rejection errors ───────────────────

/**
 * Run bin.ts with a single argument and return stdout, stderr, exitCode.
 */
function runBin(arg: string): { stdout: string; stderr: string; exitCode: number } {
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

// ── Mocked homedir tests for not-installed errors ───────────────────────

const tmpHome: string = realpathSync(
  mkdtempSync(join(tmpdir(), 'kiro-learn-errpfx-prop-')),
);

vi.mock('node:os', async (importOriginal) => {
  const original = (await importOriginal()) as typeof nodeOs;
  return {
    ...original,
    homedir: () => tmpHome,
  };
});

const { cmdStart, cmdStatus } = await import('../../src/installer/index.js');

afterAll(() => {
  rmSync(tmpHome, { recursive: true, force: true });
});

/** Valid commands that the CLI recognizes. */
const VALID_COMMANDS = new Set([
  'init',
  'start',
  'stop',
  'status',
  'uninstall',
  '--help',
  '--version',
]);

describe('Installer — property: error message prefix (P5)', () => {
  it('unrecognized commands produce stderr with [kiro-learn] prefix', () => {
    /**
     * **Validates: Requirements 13.5**
     *
     * Generate random invalid command strings and verify stderr contains
     * the [kiro-learn] prefix.
     */
    fc.assert(
      fc.property(
        fc
          .string({ minLength: 1, maxLength: 20 })
          .filter(
            (s) =>
              !VALID_COMMANDS.has(s) &&
              !s.includes('\0') &&
              !s.includes('\n'),
          ),
        (cmd) => {
          const result = runBin(cmd);
          expect(result.exitCode).toBe(1);
          expect(result.stderr).toContain('[kiro-learn]');
        },
      ),
      { numRuns: 50 },
    );
  });

  it('cmdStart when not installed produces stderr with [kiro-learn] prefix', () => {
    /**
     * **Validates: Requirements 13.5**
     *
     * When kiro-learn is not installed, cmdStart writes to stderr with
     * the [kiro-learn] prefix.
     */
    const chunks: string[] = [];
    const stderrSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation((chunk: string | Uint8Array) => {
        chunks.push(String(chunk));
        return true;
      });
    const stdoutSpy = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation(() => true);

    try {
      const exitCode = cmdStart();
      expect(exitCode).toBe(1);

      const stderr = chunks.join('');
      expect(stderr).toContain('[kiro-learn]');
    } finally {
      stderrSpy.mockRestore();
      stdoutSpy.mockRestore();
    }
  });

  it('cmdStatus when not installed produces stderr with [kiro-learn] prefix', () => {
    /**
     * **Validates: Requirements 13.5**
     *
     * When kiro-learn is not installed, cmdStatus writes to stderr with
     * the [kiro-learn] prefix.
     */
    const chunks: string[] = [];
    const stderrSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation((chunk: string | Uint8Array) => {
        chunks.push(String(chunk));
        return true;
      });
    const stdoutSpy = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation(() => true);

    try {
      const exitCode = cmdStatus();
      expect(exitCode).toBe(1);

      const stderr = chunks.join('');
      expect(stderr).toContain('[kiro-learn]');
    } finally {
      stderrSpy.mockRestore();
      stdoutSpy.mockRestore();
    }
  });
});
