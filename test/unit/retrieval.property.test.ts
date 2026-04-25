/**
 * Property-based tests for the retrieval assembly module.
 *
 * Feature: collector-pipeline, Property 9: Search query extraction correctness
 *
 * @see .kiro/specs/collector-pipeline/design.md § Property 9
 * @see .kiro/specs/collector-pipeline/requirements.md § Requirement 10.4
 */

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { extractSearchQuery, formatContext } from '../../src/collector/retrieval/index.js';
import type { KiroMemEvent } from '../../src/types/schemas.js';
import { arbitraryEvent, arbitraryMemoryRecord } from '../helpers/arbitrary.js';

// ── Tests ───────────────────────────────────────────────────────────────

describe('Retrieval — property: search query extraction correctness (P9)', () => {
  // Feature: collector-pipeline, Property 9: Search query extraction correctness

  it('extracts the correct search query for every body type', () => {
    /**
     * **Validates: Requirements 10.4**
     *
     * For any prompt event, the extracted query equals:
     * - `body.content` for text bodies
     * - `body.turns[body.turns.length - 1].content` for message bodies
     * - `JSON.stringify(body.data)` for json bodies
     */
    fc.assert(
      fc.property(
        arbitraryEvent().map(
          (event): KiroMemEvent => ({ ...event, kind: 'prompt' }),
        ),
        (event) => {
          const result = extractSearchQuery(event.body);

          switch (event.body.type) {
            case 'text':
              expect(result).toBe(event.body.content);
              break;
            case 'message': {
              const lastTurn = event.body.turns[event.body.turns.length - 1];
              expect(result).toBe(lastTurn?.content ?? '');
              break;
            }
            case 'json':
              expect(result).toBe(JSON.stringify(event.body.data));
              break;
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});


// ── Property 8 ──────────────────────────────────────────────────────────

describe('Retrieval — property: context formatting completeness (P8)', () => {
  // Feature: collector-pipeline, Property 8: Context formatting completeness

  it('formatted context contains header, each record title, summary, and facts', () => {
    /**
     * **Validates: Requirements 10.2, 13.1, 13.2, 13.4**
     *
     * For any non-empty array of valid MemoryRecords, the formatted context
     * contains the header, each record's title, summary, and facts entries.
     */
    fc.assert(
      fc.property(
        fc.array(arbitraryMemoryRecord(), { minLength: 1, maxLength: 5 }),
        (records) => {
          const result = formatContext(records);

          // (a) Header is present
          expect(result).toContain('## Prior observations from kiro-learn');

          // (b), (c), (d) Each record's title, summary, and facts are present
          for (const record of records) {
            expect(result).toContain(record.title);
            expect(result).toContain(record.summary);
            for (const fact of record.facts) {
              expect(result).toContain('- ' + fact);
            }
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});
