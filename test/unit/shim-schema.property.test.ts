/**
 * Property-based tests for event schema compliance (Property 3).
 *
 * For any valid hook input (generated via arbitrary generators for each hook
 * type), the constructed `KiroMemEvent` passes `parseEvent` validation.
 * The shim never produces an event that the collector would reject on schema
 * grounds.
 *
 * **Validates: Requirements 3.1–3.9, 4.1–4.5**
 *
 * @see .kiro/specs/shim/design.md § Correctness Properties — Property 3
 */

import { mkdtempSync, rmSync } from 'node:fs';
import type * as nodeOs from 'node:os';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import fc from 'fast-check';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { eventBodyArb } from '../helpers/arbitrary.js';

let tmpBase: string;

vi.mock('node:os', async (importOriginal) => {
  const original = (await importOriginal()) as typeof nodeOs;
  return {
    ...original,
    homedir: () => tmpBase,
  };
});

const { buildEvent } = await import('../../src/shim/shared/index.js');
const { parseEvent } = await import('../../src/types/index.js');

describe('Property 3: Event schema compliance', () => {
  let cwdDir: string;

  beforeAll(() => {
    tmpBase = mkdtempSync(join(tmpdir(), 'kiro-learn-schema-prop-'));
    cwdDir = mkdtempSync(join(tmpdir(), 'kiro-learn-schema-cwd-'));
  });

  afterAll(() => {
    rmSync(cwdDir, { recursive: true, force: true });
    rmSync(tmpBase, { recursive: true, force: true });
  });

  it('buildEvent output passes parseEvent for any valid kind/body/sessionId', () => {
    /**
     * **Validates: Requirements 3.1–3.9, 4.1–4.5**
     *
     * For any combination of valid kind, body variant, and session ID,
     * `buildEvent` must produce an event that passes the full Zod schema
     * validation in `parseEvent` — including ULID format, namespace
     * pattern, datetime format, source provenance, and body discriminated
     * union.
     */
    fc.assert(
      fc.property(
        fc.constantFrom(
          'prompt' as const,
          'tool_use' as const,
          'session_summary' as const,
          'note' as const,
        ),
        eventBodyArb(),
        fc.string({ minLength: 1, maxLength: 128 }).filter((s) => s.length > 0),
        (kind, body, sessionId) => {
          const event = buildEvent({ kind, body, sessionId, cwd: cwdDir });
          expect(() => parseEvent(event)).not.toThrow();
        },
      ),
      { numRuns: 50 },
    );
  });
});
