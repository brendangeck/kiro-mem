/**
 * Retrieval — the synchronous context-assembly path.
 *
 * When a `prompt` event arrives with retrieval requested, this module
 * retrieves relevant memory records from the query layer, formats them into
 * injection-ready context, and returns before the hard latency budget
 * expires. Partial results are preferable to errors.
 *
 * @see Requirements 10.1–10.4, 11.1–11.4, 13.1–13.4
 */

import type { KiroMemEvent, MemoryRecord } from '../../types/index.js';
import type { QueryLayer } from '../query/index.js';

/** Default number of memory records to retrieve per query. */
const DEFAULT_RESULT_LIMIT = 10;

/**
 * Context assembled by the retrieval subsystem for a single prompt-time
 * lookup. Returned inline in the ingest response.
 *
 * Wire-compatible with the `RetrievalResult` type in `src/types/index.ts`.
 *
 * @see Requirements 10.3
 */
export interface RetrievalResult {
  context: string;
  records: string[];
  latency_ms: number;
}

/**
 * The retrieval assembler interface. Assembles context from memory records
 * within a bounded latency budget.
 *
 * @see Requirements 10.1, 11.1
 */
export interface RetrievalAssembler {
  assemble(event: KiroMemEvent, budgetMs: number): Promise<RetrievalResult>;
}

/**
 * Dependencies injected into the retrieval assembler.
 */
export interface RetrievalDeps {
  query: QueryLayer;
  /** Maximum number of records to retrieve. Defaults to 10. */
  resultLimit?: number;
}

/**
 * Sentinel value used to detect timeout in `Promise.race`.
 * Not exported — internal implementation detail.
 */
const TIMEOUT_SENTINEL = Symbol('timeout');

/**
 * Extract a search query string from the event body.
 *
 * - `text` → `body.content`
 * - `message` → last turn's `content`
 * - `json` → `JSON.stringify(body.data)`
 *
 * Exported for direct testing in property tests (Task 6.3).
 *
 * @see Requirements 10.4
 */
export function extractSearchQuery(body: KiroMemEvent['body']): string {
  switch (body.type) {
    case 'text':
      return body.content;
    case 'message': {
      const lastTurn = body.turns[body.turns.length - 1];
      return lastTurn?.content ?? '';
    }
    case 'json':
      return JSON.stringify(body.data);
  }
}

/**
 * Format an array of memory records into a context string suitable for
 * injection into an agent's context window.
 *
 * Returns an empty string when the array is empty.
 *
 * Exported for direct testing in property tests (Task 6.4).
 *
 * @see Requirements 13.1, 13.2, 13.3, 13.4
 */
export function formatContext(records: MemoryRecord[]): string {
  if (records.length === 0) return '';

  const lines: string[] = ['## Prior observations from kiro-learn'];

  for (const record of records) {
    lines.push('');
    lines.push('### ' + record.title);
    lines.push('');
    lines.push(record.summary);
    if (record.facts.length > 0) {
      lines.push('');
      for (const fact of record.facts) {
        lines.push('- ' + fact);
      }
    }
  }

  return lines.join('\n');
}

/**
 * Create a retrieval assembler that searches memory records and formats
 * context within a bounded latency budget.
 *
 * The assembler never throws to the caller. On timeout or error it returns
 * an empty result with the elapsed latency.
 *
 * @see Requirements 10.1, 10.2, 11.1–11.4
 */
export function createRetrievalAssembler(deps: RetrievalDeps): RetrievalAssembler {
  const resultLimit = deps.resultLimit ?? DEFAULT_RESULT_LIMIT;

  return {
    async assemble(event: KiroMemEvent, budgetMs: number): Promise<RetrievalResult> {
      const startTime = Date.now();
      const elapsed = () => Date.now() - startTime;

      const searchQuery = extractSearchQuery(event.body);
      if (searchQuery === '') {
        return { context: '', records: [], latency_ms: elapsed() };
      }

      try {
        const raceResult = await Promise.race([
          deps.query.search(event.namespace, searchQuery, resultLimit),
          new Promise<typeof TIMEOUT_SENTINEL>((resolve) =>
            setTimeout(() => resolve(TIMEOUT_SENTINEL), budgetMs),
          ),
        ]);

        if (raceResult === TIMEOUT_SENTINEL) {
          return { context: '', records: [], latency_ms: elapsed() };
        }

        const records = raceResult as MemoryRecord[];
        const context = formatContext(records);
        const recordIds = records.map((r) => r.record_id);

        return { context, records: recordIds, latency_ms: elapsed() };
      } catch {
        return { context: '', records: [], latency_ms: elapsed() };
      }
    },
  };
}
