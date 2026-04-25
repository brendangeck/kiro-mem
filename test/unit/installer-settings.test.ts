/**
 * Unit tests for settings file and status output.
 *
 * Uses a temp directory as INSTALL_DIR and HOME.
 * INSTALL_DIR is computed once at module load time, so tmpHome is stable.
 *
 * Validates: Requirements 14.1, 14.2, 14.3, N11
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
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Resolve symlinks so paths are consistent with realpathSync inside the module.
const tmpHome: string = realpathSync(
  mkdtempSync(join(tmpdir(), 'kiro-learn-settings-')),
);

vi.mock('node:os', async (importOriginal) => {
  const original = (await importOriginal()) as typeof nodeOs;
  return {
    ...original,
    homedir: () => tmpHome,
  };
});

// Import after mock so vitest intercepts the module.
const { writeSettings, cmdStatus, INSTALL_DIR } = await import(
  '../../src/installer/index.js'
);

afterAll(() => {
  rmSync(tmpHome, { recursive: true, force: true });
});

describe('writeSettings', () => {
  beforeEach(() => {
    mkdirSync(INSTALL_DIR, { recursive: true });
  });

  afterEach(() => {
    rmSync(INSTALL_DIR, { recursive: true, force: true });
  });

  it('default settings contain correct values', () => {
    /**
     * Validates: Requirements 14.1, 14.2
     *
     * When settings.json does not exist, writeSettings creates it with
     * the documented defaults.
     */
    writeSettings();

    const settingsPath = join(INSTALL_DIR, 'settings.json');
    expect(existsSync(settingsPath)).toBe(true);

    const settings = JSON.parse(readFileSync(settingsPath, 'utf8')) as {
      collector: { host: string; port: number };
      shim: { timeoutMs: number };
    };

    expect(settings.collector.port).toBe(21100);
    expect(settings.collector.host).toBe('127.0.0.1');
    expect(settings.shim.timeoutMs).toBe(2000);
  });

  it('existing settings file is not overwritten', () => {
    /**
     * Validates: Requirements 14.3
     *
     * When settings.json already exists, writeSettings must not modify it.
     */
    const settingsPath = join(INSTALL_DIR, 'settings.json');
    const customSettings = JSON.stringify({ custom: true, port: 9999 });
    writeFileSync(settingsPath, customSettings);

    writeSettings();

    const content = readFileSync(settingsPath, 'utf8');
    expect(content).toBe(customSettings);
  });
});

describe('cmdStatus', () => {
  beforeEach(() => {
    mkdirSync(INSTALL_DIR, { recursive: true });
  });

  afterEach(() => {
    rmSync(INSTALL_DIR, { recursive: true, force: true });
  });

  it('status output is in key-value format', () => {
    /**
     * Validates: Requirements N11
     *
     * When kiro-learn is installed, cmdStatus prints key: value pairs
     * that are parseable by scripts.
     */
    // Create a minimal install directory with a package.json
    writeFileSync(
      join(INSTALL_DIR, 'package.json'),
      JSON.stringify({ version: '0.3.0' }),
    );

    // Capture stdout
    const chunks: string[] = [];
    const writeSpy = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation((chunk: string | Uint8Array) => {
        chunks.push(String(chunk));
        return true;
      });

    // Also suppress stderr (stale PID warnings, etc.)
    const stderrSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);

    try {
      const exitCode = cmdStatus();

      expect(exitCode).toBe(0);

      const output = chunks.join('');
      const lines = output.trim().split('\n');

      // Each line should be in key: value format
      for (const line of lines) {
        expect(line).toMatch(/^[a-z_]+: .+$/);
      }

      // Verify specific keys are present
      expect(output).toContain('status:');
      expect(output).toContain('install_dir:');
      expect(output).toContain('database:');
      expect(output).toContain('database_exists:');
      expect(output).toContain('version:');
    } finally {
      writeSpy.mockRestore();
      stderrSpy.mockRestore();
    }
  });
});
