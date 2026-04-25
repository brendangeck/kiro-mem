/**
 * Property-based tests for namespace determinism (Property 2).
 *
 * For any cwd string, calling `buildEvent` twice with the same cwd produces
 * identical `namespace` fields. For any two distinct cwd strings, the
 * `namespace` fields differ (with overwhelming probability, given SHA-256).
 *
 * **Validates: Requirements 3.4, 8.1, 8.2, 8.3, 8.4**
 *
 * @see .kiro/specs/shim/design.md § Correctness Properties — Property 2
 */

import { mkdtempSync, rmSync } from 'node:fs';
import type * as nodeOs from 'node:os';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import fc from 'fast-check';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

let tmpBase: string;

vi.mock('node:os', async (importOriginal) => {
  const original = (await importOriginal()) as typeof nodeOs;
  return {
    ...original,
    homedir: () => tmpBase,
  };
});

const { buildEvent } = await import('../../src/shim/shared/index.js');

describe('Property 2: Namespace determinism', () => {
  /**
   * `buildEvent` calls `realpathSync(cwd)` internally, so we need real
   * directories. We create a pool of distinct temp directories before the
   * suite runs and clean them up afterwards.
   */
  const dirs: string[] = [];
  const POOL_SIZE = 20;

  beforeAll(() => {
    tmpBase = mkdtempSync(join(tmpdir(), 'kiro-learn-ns-prop-'));
    for (let i = 0; i < POOL_SIZE; i++) {
      dirs.push(mkdtempSync(join(tmpdir(), `kiro-learn-ns-${String(i)}-`)));
    }
  });

  afterAll(() => {
    for (const d of dirs) {
      rmSync(d, { recursive: true, force: true });
    }
    rmSync(tmpBase, { recursive: true, force: true });
  });

  it('same cwd produces identical namespace across calls', () => {
    /**
     * **Validates: Requirements 3.4, 8.4**
     *
     * For any cwd from the pool, two independent `buildEvent` calls with
     * different kinds, bodies, and session IDs must produce events with
     * the same `namespace` field.
     */
    fc.assert(
      fc.property(
        fc.constantFrom(...dirs),
        fc.string({ minLength: 1, maxLength: 20 }),
        fc.string({ minLength: 1, maxLength: 20 }),
        (cwd, sessionA, sessionB) => {
          const e1 = buildEvent({
            kind: 'note',
            body: { type: 'text', content: 'session started' },
            sessionId: sessionA,
            cwd,
          });
          const e2 = buildEvent({
            kind: 'prompt',
            body: { type: 'text', content: 'hello' },
            sessionId: sessionB,
            cwd,
          });
          expect(e1.namespace).toBe(e2.namespace);
        },
      ),
      { numRuns: 20 },
    );
  });

  it('distinct cwds produce different namespaces', () => {
    /**
     * **Validates: Requirements 3.4, 8.1, 8.2, 8.3**
     *
     * For any two distinct directories from the pool, `buildEvent` must
     * produce events with different `namespace` fields. SHA-256 collision
     * probability on distinct inputs is negligible.
     */
    fc.assert(
      fc.property(
        fc.constantFrom(...dirs),
        fc.constantFrom(...dirs),
        (cwd1, cwd2) => {
          fc.pre(cwd1 !== cwd2);
          const e1 = buildEvent({
            kind: 'note',
            body: { type: 'text', content: '' },
            sessionId: 's1',
            cwd: cwd1,
          });
          const e2 = buildEvent({
            kind: 'note',
            body: { type: 'text', content: '' },
            sessionId: 's2',
            cwd: cwd2,
          });
          expect(e1.namespace).not.toBe(e2.namespace);
        },
      ),
      { numRuns: 20 },
    );
  });
});
