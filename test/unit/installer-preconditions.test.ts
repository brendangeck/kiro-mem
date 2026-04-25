/**
 * Unit tests for `checkNodeVersion` and `checkKiroCli` in
 * `src/installer/index.ts`.
 *
 * Validates: Requirements N7, 16.1, 16.2, 16.4
 */

import { describe, expect, it, vi } from 'vitest';

// ── checkNodeVersion ────────────────────────────────────────────────────

describe('checkNodeVersion', () => {
  it('passes on Node 22+ (current runtime)', async () => {
    /**
     * Validates: Requirements N7
     */
    const { checkNodeVersion } = await import('../../src/installer/index.js');
    expect(() => checkNodeVersion()).not.toThrow();
  });

  it('throws with [kiro-learn] prefix on Node < 22', async () => {
    /**
     * Validates: Requirements N7
     */
    const { checkNodeVersion, MIN_NODE_VERSION } = await import(
      '../../src/installer/index.js'
    );
    const original = process.versions.node;
    Object.defineProperty(process.versions, 'node', {
      value: '18.19.0',
      writable: true,
      configurable: true,
    });

    try {
      expect(() => checkNodeVersion()).toThrow('[kiro-learn]');
      expect(() => checkNodeVersion()).toThrow(
        `Node.js ${MIN_NODE_VERSION} or later is required`,
      );
    } finally {
      Object.defineProperty(process.versions, 'node', {
        value: original,
        writable: true,
        configurable: true,
      });
    }
  });
});

// ── checkKiroCli ────────────────────────────────────────────────────────

vi.mock('node:child_process', async (importOriginal) => {
  const original = (await importOriginal()) as Record<string, unknown>;
  return {
    ...original,
    execSync: vi.fn((cmd: string, ...rest: unknown[]) => {
      if (typeof cmd === 'string' && cmd.startsWith('kiro-cli')) {
        throw new Error('kiro-cli not found');
      }
      return (original['execSync'] as (...args: unknown[]) => unknown)(cmd, ...rest);
    }),
  };
});

describe('checkKiroCli', () => {
  it('throws with install instructions when kiro-cli not found', async () => {
    /**
     * Validates: Requirements 16.1, 16.2, 16.4
     */
    const { checkKiroCli } = await import('../../src/installer/index.js');

    expect(() => checkKiroCli()).toThrow('[kiro-learn]');
    expect(() => checkKiroCli()).toThrow('kiro-cli is not installed');
    expect(() => checkKiroCli()).toThrow(
      'kiro-cli chat --no-interactive --agent kiro-learn-compressor',
    );
  });
});
