/**
 * Integration test: uninstall flows.
 *
 * Uses a temp directory as HOME. Creates a full install directory structure,
 * then tests both uninstall modes:
 *   1. cmdUninstall({ keepData: false }) — entire ~/.kiro-learn/ removed
 *   2. cmdUninstall({ keepData: true }) — selective removal
 *
 * Validates: Requirements 11.1–11.7
 */

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import type * as nodeOs from 'node:os';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Resolve symlinks so paths are consistent with realpathSync inside the module.
const tmpHome: string = realpathSync(
  mkdtempSync(join(tmpdir(), 'kiro-learn-uninstall-integ-')),
);

vi.mock('node:os', async (importOriginal) => {
  const original = (await importOriginal()) as typeof nodeOs;
  return {
    ...original,
    homedir: () => tmpHome,
  };
});

// Mock child_process so stopDaemon doesn't try to kill real processes.
vi.mock('node:child_process', () => ({
  execSync: vi.fn(() => Buffer.from('')),
  spawn: vi.fn(() => ({
    pid: 99999,
    unref: vi.fn(),
    on: vi.fn(),
  })),
}));

// Import after mocks so vitest intercepts the modules.
const { cmdUninstall, INSTALL_DIR } = await import('../src/installer/index.js');

// Suppress stdout/stderr noise
const stdoutSpy = vi.spyOn(process.stdout, 'write');
const stderrSpy = vi.spyOn(process.stderr, 'write');

beforeEach(() => {
  stdoutSpy.mockImplementation(() => true);
  stderrSpy.mockImplementation(() => true);
});

afterAll(() => {
  rmSync(tmpHome, { recursive: true, force: true });
});

/**
 * Helper: create a full install directory structure with data files.
 */
function createFullInstall(): void {
  // Core directories
  mkdirSync(join(INSTALL_DIR, 'bin'), { recursive: true });
  mkdirSync(join(INSTALL_DIR, 'lib', 'shim'), { recursive: true });
  mkdirSync(join(INSTALL_DIR, 'lib', 'collector'), { recursive: true });
  mkdirSync(join(INSTALL_DIR, 'lib', 'installer'), { recursive: true });
  mkdirSync(join(INSTALL_DIR, 'lib', 'types'), { recursive: true });
  mkdirSync(join(INSTALL_DIR, 'logs'), { recursive: true });
  mkdirSync(join(INSTALL_DIR, 'node_modules', '.package-lock'), {
    recursive: true,
  });

  // Bin wrappers
  writeFileSync(join(INSTALL_DIR, 'bin', 'shim'), '#!/usr/bin/env node\n');
  writeFileSync(join(INSTALL_DIR, 'bin', 'collector'), '#!/usr/bin/env node\n');
  writeFileSync(join(INSTALL_DIR, 'bin', 'kiro-learn'), '#!/usr/bin/env node\n');

  // Data files
  writeFileSync(join(INSTALL_DIR, 'kiro-learn.db'), 'sqlite-data');
  writeFileSync(
    join(INSTALL_DIR, 'settings.json'),
    JSON.stringify({ collector: { port: 21100 } }),
  );
  writeFileSync(
    join(INSTALL_DIR, 'logs', 'collector-2025-01-15.log'),
    'log data',
  );
  writeFileSync(
    join(INSTALL_DIR, 'package.json'),
    JSON.stringify({ name: 'kiro-learn-runtime', version: '0.3.0' }),
  );

  // Global agent configs
  mkdirSync(join(tmpHome, '.kiro', 'agents'), { recursive: true });
  writeFileSync(
    join(tmpHome, '.kiro', 'agents', 'kiro-learn.json'),
    '{"name":"kiro-learn"}',
  );
  writeFileSync(
    join(tmpHome, '.kiro', 'agents', 'kiro-learn-compressor.json'),
    '{"name":"kiro-learn-compressor"}',
  );
}

describe('uninstall — full removal (keepData: false)', () => {
  beforeEach(() => {
    createFullInstall();
    // Point cwd at tmpHome (global-only scope, no project detection)
    vi.spyOn(process, 'cwd').mockReturnValue(tmpHome);
  });

  afterEach(() => {
    // Clean up in case test fails
    rmSync(INSTALL_DIR, { recursive: true, force: true });
    rmSync(join(tmpHome, '.kiro'), { recursive: true, force: true });
  });

  it('removes entire ~/.kiro-learn/ directory', () => {
    const exitCode = cmdUninstall({ keepData: false });
    expect(exitCode).toBe(0);
    expect(existsSync(INSTALL_DIR)).toBe(false);
  });

  it('removes global agent configs', () => {
    const exitCode = cmdUninstall({ keepData: false });
    expect(exitCode).toBe(0);

    expect(
      existsSync(join(tmpHome, '.kiro', 'agents', 'kiro-learn.json')),
    ).toBe(false);
    expect(
      existsSync(
        join(tmpHome, '.kiro', 'agents', 'kiro-learn-compressor.json'),
      ),
    ).toBe(false);
  });

  it('returns 0 when not installed', () => {
    rmSync(INSTALL_DIR, { recursive: true, force: true });
    const exitCode = cmdUninstall({ keepData: false });
    expect(exitCode).toBe(0);
  });
});

describe('uninstall — keep data (keepData: true)', () => {
  beforeEach(() => {
    createFullInstall();
    vi.spyOn(process, 'cwd').mockReturnValue(tmpHome);
  });

  afterEach(() => {
    rmSync(INSTALL_DIR, { recursive: true, force: true });
    rmSync(join(tmpHome, '.kiro'), { recursive: true, force: true });
  });

  it('removes bin/, lib/, node_modules/', () => {
    const exitCode = cmdUninstall({ keepData: true });
    expect(exitCode).toBe(0);

    expect(existsSync(join(INSTALL_DIR, 'bin'))).toBe(false);
    expect(existsSync(join(INSTALL_DIR, 'lib'))).toBe(false);
    expect(existsSync(join(INSTALL_DIR, 'node_modules'))).toBe(false);
  });

  it('preserves kiro-learn.db', () => {
    cmdUninstall({ keepData: true });
    expect(existsSync(join(INSTALL_DIR, 'kiro-learn.db'))).toBe(true);
  });

  it('preserves settings.json', () => {
    cmdUninstall({ keepData: true });
    expect(existsSync(join(INSTALL_DIR, 'settings.json'))).toBe(true);
  });

  it('preserves logs/', () => {
    cmdUninstall({ keepData: true });
    expect(existsSync(join(INSTALL_DIR, 'logs'))).toBe(true);
    expect(
      existsSync(join(INSTALL_DIR, 'logs', 'collector-2025-01-15.log')),
    ).toBe(true);
  });

  it('removes global agent configs', () => {
    cmdUninstall({ keepData: true });

    expect(
      existsSync(join(tmpHome, '.kiro', 'agents', 'kiro-learn.json')),
    ).toBe(false);
    expect(
      existsSync(
        join(tmpHome, '.kiro', 'agents', 'kiro-learn-compressor.json'),
      ),
    ).toBe(false);
  });
});
