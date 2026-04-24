/**
 * Property-based test: Uninstall --keep-data selective preservation.
 *
 * Feature: installer, Property 4: Uninstall --keep-data selective preservation
 *
 * For any existing install with random user data files, uninstall --keep-data
 * removes bin/, lib/, node_modules/ and preserves byte-identical kiro-learn.db,
 * settings.json, and logs/*.
 *
 * **Validates: Requirements 11.5**
 *
 * @see .kiro/specs/installer/design.md § Property 4
 */

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import type * as nodeOs from 'node:os';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import fc from 'fast-check';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

// Resolve symlinks (macOS /var → /private/var).
const tmpHome: string = realpathSync(
  mkdtempSync(join(tmpdir(), 'kiro-learn-keepdata-prop-')),
);

vi.mock('node:os', async (importOriginal) => {
  const original = (await importOriginal()) as typeof nodeOs;
  return {
    ...original,
    homedir: () => tmpHome,
  };
});

// Import after mock so vitest intercepts the module.
const { cmdUninstall, INSTALL_DIR } = await import(
  '../src/installer/index.js'
);

beforeEach(() => {
  rmSync(INSTALL_DIR, { recursive: true, force: true });
  rmSync(join(tmpHome, '.kiro'), { recursive: true, force: true });
});

afterAll(() => {
  rmSync(tmpHome, { recursive: true, force: true });
});

describe('Installer — property: uninstall --keep-data preservation (P4)', () => {
  it('--keep-data preserves data files and removes bin/lib/node_modules', () => {
    /**
     * **Validates: Requirements 11.5**
     *
     * Generate random file contents for data files, create a full install
     * directory, call cmdUninstall({ keepData: true }), and verify
     * selective preservation.
     */
    fc.assert(
      fc.property(
        fc.uint8Array({ minLength: 0, maxLength: 512 }),
        fc.uint8Array({ minLength: 0, maxLength: 256 }),
        fc.uint8Array({ minLength: 0, maxLength: 128 }),
        (dbData, settingsData, logData) => {
          // Clean up from previous iteration
          rmSync(INSTALL_DIR, { recursive: true, force: true });
          rmSync(join(tmpHome, '.kiro'), { recursive: true, force: true });

          // Create a full install directory structure
          mkdirSync(join(INSTALL_DIR, 'bin'), { recursive: true });
          mkdirSync(join(INSTALL_DIR, 'lib', 'shim'), { recursive: true });
          mkdirSync(join(INSTALL_DIR, 'node_modules', 'some-pkg'), {
            recursive: true,
          });
          mkdirSync(join(INSTALL_DIR, 'logs'), { recursive: true });
          mkdirSync(join(tmpHome, '.kiro', 'agents'), { recursive: true });

          // Write data files with random contents
          writeFileSync(join(INSTALL_DIR, 'kiro-learn.db'), dbData);
          writeFileSync(join(INSTALL_DIR, 'settings.json'), settingsData);
          writeFileSync(
            join(INSTALL_DIR, 'logs', 'collector-2025-01-01.log'),
            logData,
          );

          // Write some bin/lib/node_modules content to verify removal
          writeFileSync(
            join(INSTALL_DIR, 'bin', 'shim'),
            '#!/usr/bin/env node\n',
          );
          writeFileSync(
            join(INSTALL_DIR, 'lib', 'shim', 'index.js'),
            '// lib\n',
          );
          writeFileSync(
            join(INSTALL_DIR, 'node_modules', 'some-pkg', 'index.js'),
            '// pkg\n',
          );

          // Write package.json and collector.pid (should also be removed)
          writeFileSync(
            join(INSTALL_DIR, 'package.json'),
            '{"name":"kiro-learn-runtime"}\n',
          );
          writeFileSync(join(INSTALL_DIR, 'collector.pid'), '12345\n');

          // Suppress stdout/stderr from cmdUninstall
          const stdoutSpy = vi
            .spyOn(process.stdout, 'write')
            .mockImplementation(() => true);
          const stderrSpy = vi
            .spyOn(process.stderr, 'write')
            .mockImplementation(() => true);

          try {
            cmdUninstall({ keepData: true });
          } finally {
            stdoutSpy.mockRestore();
            stderrSpy.mockRestore();
          }

          // Verify data files are byte-identical
          const dbAfter = readFileSync(join(INSTALL_DIR, 'kiro-learn.db'));
          const settingsAfter = readFileSync(
            join(INSTALL_DIR, 'settings.json'),
          );
          const logAfter = readFileSync(
            join(INSTALL_DIR, 'logs', 'collector-2025-01-01.log'),
          );

          expect(Buffer.from(dbAfter)).toEqual(Buffer.from(dbData));
          expect(Buffer.from(settingsAfter)).toEqual(Buffer.from(settingsData));
          expect(Buffer.from(logAfter)).toEqual(Buffer.from(logData));

          // Verify bin/, lib/, node_modules/ are removed
          expect(existsSync(join(INSTALL_DIR, 'bin'))).toBe(false);
          expect(existsSync(join(INSTALL_DIR, 'lib'))).toBe(false);
          expect(existsSync(join(INSTALL_DIR, 'node_modules'))).toBe(false);

          // Verify package.json and collector.pid are removed
          expect(existsSync(join(INSTALL_DIR, 'package.json'))).toBe(false);
          expect(existsSync(join(INSTALL_DIR, 'collector.pid'))).toBe(false);
        },
      ),
      { numRuns: 50 },
    );
  });
});
