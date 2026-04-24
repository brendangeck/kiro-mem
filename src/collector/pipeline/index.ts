/**
 * Pipeline — the chain of processors an Event traverses between the receiver
 * and storage.
 *
 * Stages (v1):
 *   dedup → privacy scrub → storage → async extraction
 *
 * Each processor is a pure input → output transform that conforms to the
 * {@link PipelineProcessor} interface. Stages are composed by
 * {@link createPipeline} into an ordered chain.
 */

import { spawn } from 'node:child_process';

import { parseMemoryRecord } from '../../types/index.js';
import type {
  KiroMemEvent,
  StorageBackend,
  EventIngestResponse,
} from '../../types/index.js';

// ── Stage result ────────────────────────────────────────────────────────

/**
 * Result of a single pipeline stage.
 * - `continue`: pass the (possibly transformed) event to the next stage.
 * - `halt`: stop processing; return the halt reason to the caller.
 */
export type StageResult =
  | { action: 'continue'; event: KiroMemEvent }
  | { action: 'halt'; response: EventIngestResponse };

// ── Processor interface ─────────────────────────────────────────────────

/**
 * A single processor in the pipeline chain. Each stage receives an event,
 * transforms or filters it, and returns a {@link StageResult}.
 *
 * Stages are independently testable: instantiate with mock deps, call
 * `process()`, assert the result.
 *
 * @see Requirements 17.1, 17.4
 */
export interface PipelineProcessor {
  readonly name: string;
  process(event: KiroMemEvent): StageResult | Promise<StageResult>;
}

// ── Pipeline interface ──────────────────────────────────────────────────

/**
 * The composed pipeline. Runs stages in order, writes to storage on
 * success, and fires async extraction.
 *
 * @see Requirements 17.2, 17.3
 */
export interface Pipeline {
  process(event: KiroMemEvent): Promise<EventIngestResponse>;
  /** The extraction stage, exposed for drain on shutdown. */
  readonly extraction: ExtractionStage;
}

// ── Pipeline options ────────────────────────────────────────────────────

/**
 * Configuration for {@link createPipeline}. All numeric fields have
 * sensible defaults documented inline.
 *
 * @see Requirements 4.1
 */
export interface PipelineOptions {
  storage: StorageBackend;
  /** Maximum concurrent `kiro-cli` extraction processes. Default `2`. */
  extractionConcurrency: number;
  /** Maximum queued extractions before oldest is dropped. Default `100`. */
  extractionQueueDepth: number;
  /** Per-extraction timeout in milliseconds. Default `30_000`. */
  extractionTimeout: number;
  /** Maximum entries in the in-memory dedup set. Default `10_000`. */
  dedupMaxSize: number;
}

// ── Extraction stage interface ──────────────────────────────────────────

/**
 * Configuration for {@link createExtractionStage}.
 *
 * @see Requirements 8.1, 9.1, 9.2, 9.3, 18.1, 18.3
 */
export interface ExtractionStageOptions {
  storage: StorageBackend;
  /** Maximum concurrent `kiro-cli` extraction processes. Default `2`. */
  concurrency: number;
  /** Maximum queued extractions before oldest is dropped. Default `100`. */
  queueDepth: number;
  /** Per-extraction timeout in milliseconds. Default `30_000`. */
  timeoutMs: number;
}

/**
 * Async extraction stage that enqueues events for background LLM
 * summarisation via `kiro-cli`.
 */
export interface ExtractionStage {
  /** Enqueue an event for async extraction. Returns immediately. */
  enqueue(event: KiroMemEvent): void;
  /** Wait for all pending extractions to complete (with timeout). */
  drain(timeoutMs: number): Promise<void>;
  /** Number of currently active `kiro-cli` processes. Exposed for testing. */
  readonly active: number;
}

// ── Dedup stage ─────────────────────────────────────────────────────────

/**
 * Configuration for {@link createDedupStage}.
 *
 * @see Requirements 5.4
 */
export interface DedupStageOptions {
  /** Maximum entries in the in-memory dedup set. Default `10_000`. */
  maxSize: number;
}

/**
 * A {@link PipelineProcessor} augmented with a read-only view of the
 * internal dedup set size, exposed for testing.
 */
export interface DedupStage extends PipelineProcessor {
  /** Current number of event_ids tracked in the dedup set. */
  readonly size: number;
}

/**
 * Create a bounded LRU dedup stage backed by a `Map<string, true>`.
 *
 * `Map` preserves insertion order, so eviction of the oldest entry is
 * `map.keys().next()` followed by `map.delete()`. Lookup and insert are
 * both O(1) amortized.
 *
 * @see Requirements 5.1, 5.2, 5.3, 5.4, 5.5
 */
export function createDedupStage(
  opts: DedupStageOptions = { maxSize: 10_000 },
): DedupStage {
  const seen = new Map<string, true>();

  return {
    name: 'dedup',

    get size(): number {
      return seen.size;
    },

    process(event: KiroMemEvent): StageResult {
      if (seen.has(event.event_id)) {
        return {
          action: 'halt',
          response: { event_id: event.event_id, stored: false },
        };
      }

      if (seen.size >= opts.maxSize) {
        const oldest = seen.keys().next().value;
        if (oldest !== undefined) {
          seen.delete(oldest);
        }
      }

      seen.set(event.event_id, true);
      return { action: 'continue', event };
    },
  };
}

// ── Privacy scrub stage ─────────────────────────────────────────────────

/** Opening tag for private spans. */
const OPEN_TAG = '<private>';

/** Closing tag for private spans. */
const CLOSE_TAG = '</private>';

/** Replacement text for redacted spans. */
const REPLACEMENT = '[REDACTED]';

/**
 * Core scrub function. Exported for direct testing.
 *
 * Replaces all `<private>...</private>` spans with `[REDACTED]`.
 * Handles nested tags (outermost pair is the boundary) and unclosed tags
 * (span extends to end of string). Produces a new string — the input is
 * never mutated.
 *
 * @see Requirements 6.1, 6.5, 6.6
 */
export function scrubPrivateSpans(input: string): string {
  let result = '';
  let pos = 0;

  while (pos < input.length) {
    const openIdx = input.indexOf(OPEN_TAG, pos);

    if (openIdx === -1) {
      // No more <private> tags; append remainder
      result += input.substring(pos);
      break;
    }

    // Append text before the opening tag
    result += input.substring(pos, openIdx);
    result += REPLACEMENT;

    // Find the matching close tag, handling nesting
    let depth = 1;
    let searchPos = openIdx + OPEN_TAG.length;

    while (depth > 0 && searchPos < input.length) {
      const nextOpen = input.indexOf(OPEN_TAG, searchPos);
      const nextClose = input.indexOf(CLOSE_TAG, searchPos);

      if (nextClose === -1) {
        // Unclosed tag: treat as extending to end of string
        searchPos = input.length;
        depth = 0;
      } else if (nextOpen !== -1 && nextOpen < nextClose) {
        // Nested open tag
        depth += 1;
        searchPos = nextOpen + OPEN_TAG.length;
      } else {
        // Close tag found
        depth -= 1;
        searchPos = nextClose + CLOSE_TAG.length;
      }
    }

    pos = searchPos;
  }

  return result;
}

/**
 * Recursively walk a JSON value and apply {@link scrubPrivateSpans} to
 * every string leaf. Returns a new value tree — the input is never mutated.
 */
function scrubJsonValue(value: unknown): unknown {
  if (typeof value === 'string') {
    return scrubPrivateSpans(value);
  }
  if (Array.isArray(value)) {
    return value.map(scrubJsonValue);
  }
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = scrubJsonValue(v);
    }
    return out;
  }
  // numbers, booleans, null — pass through unchanged
  return value;
}

/**
 * Create a privacy scrub pipeline stage.
 *
 * Dispatches on `event.body.type`:
 * - `text` → scrub `body.content`
 * - `message` → scrub each turn's `content`
 * - `json` → recursive walk of all string values in `body.data`
 *
 * Produces a new event object (immutability — never mutates the original).
 *
 * @see Requirements 6.1, 6.2, 6.3, 6.4, 6.5, 6.6, 6.7
 */
export function createPrivacyScrubStage(): PipelineProcessor {
  return {
    name: 'privacy-scrub',

    process(event: KiroMemEvent): StageResult {
      const body = event.body;
      let scrubbedBody: KiroMemEvent['body'];

      switch (body.type) {
        case 'text': {
          scrubbedBody = {
            ...body,
            content: scrubPrivateSpans(body.content),
          };
          break;
        }
        case 'message': {
          scrubbedBody = {
            ...body,
            turns: body.turns.map((turn) => ({
              ...turn,
              content: scrubPrivateSpans(turn.content),
            })),
          };
          break;
        }
        case 'json': {
          scrubbedBody = {
            ...body,
            data: scrubJsonValue(body.data),
          };
          break;
        }
      }

      return {
        action: 'continue',
        event: { ...event, body: scrubbedBody },
      };
    },
  };
}

// ── Extraction stage ────────────────────────────────────────────────────

/**
 * Extract the body content from an event as a string suitable for passing
 * to `kiro-cli` via stdin.
 */
function extractBodyContent(event: KiroMemEvent): string {
  const body = event.body;
  switch (body.type) {
    case 'text':
      return body.content;
    case 'message':
      return body.turns.map((t) => `${t.role}: ${t.content}`).join('\n');
    case 'json':
      return JSON.stringify(body.data);
  }
}

/**
 * Spawn `kiro-cli` as a child process, pass event body via stdin, and
 * read the structured extraction result from stdout.
 *
 * Returns a promise that resolves with the parsed stdout JSON, or rejects
 * on timeout, non-zero exit, or spawn error.
 *
 * @see Requirements 18.1, 18.2, 18.3
 */
function spawnKiroCli(
  event: KiroMemEvent,
  timeoutMs: number,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const child = spawn('kiro-cli', ['extract'], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let killed = false;

    const timer = setTimeout(() => {
      killed = true;
      child.kill('SIGTERM');
      reject(new Error(`kiro-cli timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });

    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    child.on('error', (err: Error) => {
      clearTimeout(timer);
      reject(err);
    });

    child.on('close', (code: number | null) => {
      clearTimeout(timer);
      if (killed) return; // already rejected by timeout
      if (code !== 0) {
        reject(
          new Error(
            `kiro-cli exited with code ${code}${stderr ? ': ' + stderr.trim() : ''}`,
          ),
        );
        return;
      }
      try {
        resolve(JSON.parse(stdout));
      } catch {
        reject(new Error('kiro-cli returned invalid JSON'));
      }
    });

    // Pass event body content via stdin
    const content = extractBodyContent(event);
    child.stdin.write(content);
    child.stdin.end();
  });
}

/**
 * Create an extraction stage with semaphore-based concurrency control.
 *
 * Events are enqueued into a bounded FIFO queue. Up to `concurrency`
 * extractions run in parallel. When the queue overflows, the oldest
 * pending event is dropped with a warning.
 *
 * @see Requirements 8.1–8.8, 9.1–9.3, 18.1–18.4
 */
export function createExtractionStage(
  opts: ExtractionStageOptions,
): ExtractionStage {
  const { storage, concurrency, queueDepth, timeoutMs } = opts;

  let active = 0;
  const queue: KiroMemEvent[] = [];

  // Listeners waiting for all work to drain
  let drainResolvers: Array<() => void> = [];

  function notifyDrain(): void {
    if (active === 0 && queue.length === 0) {
      for (const resolve of drainResolvers) {
        resolve();
      }
      drainResolvers = [];
    }
  }

  async function runExtraction(event: KiroMemEvent): Promise<void> {
    try {
      const result = spawnKiroCli(event, timeoutMs);
      const raw = await result;
      const record = parseMemoryRecord(raw);

      // Overwrite required fields from the source event
      const enriched = {
        ...record,
        namespace: event.namespace,
        source_event_ids: [event.event_id],
        strategy: 'llm-summary' as const,
      };

      await storage.putMemoryRecord(enriched);
    } catch (error: unknown) {
      const message =
        error instanceof Error ? error.message : String(error);
      console.warn(
        `extraction failed for event ${event.event_id}: ${message}`,
      );
    }
  }

  function tryRunNext(): void {
    while (active < concurrency && queue.length > 0) {
      const event = queue.shift()!;
      active += 1;
      runExtraction(event).finally(() => {
        active -= 1;
        tryRunNext();
        notifyDrain();
      });
    }
  }

  return {
    get active(): number {
      return active;
    },

    enqueue(event: KiroMemEvent): void {
      if (queue.length >= queueDepth) {
        const dropped = queue.shift()!;
        console.warn(
          `extraction queue full, dropping event ${dropped.event_id}`,
        );
      }
      queue.push(event);
      tryRunNext();
    },

    drain(drainTimeoutMs: number): Promise<void> {
      // If nothing is pending, resolve immediately
      if (active === 0 && queue.length === 0) {
        return Promise.resolve();
      }

      return new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          // Remove this resolver from the list on timeout
          drainResolvers = drainResolvers.filter((r) => r !== wrappedResolve);
          resolve();
        }, drainTimeoutMs);

        const wrappedResolve = (): void => {
          clearTimeout(timer);
          resolve();
        };

        drainResolvers.push(wrappedResolve);
      });
    },
  };
}

// ── Factory ─────────────────────────────────────────────────────────────

/**
 * Create a composed pipeline that runs dedup → privacy scrub → storage,
 * then fires async extraction.
 *
 * @see Requirements 4.1, 4.2, 4.3, 4.4, 17.2, 17.3, 16.1, 16.2, 19.1, 19.2, 19.3
 */
export function createPipeline(opts: PipelineOptions): Pipeline {
  const { storage } = opts;

  // 1. Create stages
  const dedupStage = createDedupStage({ maxSize: opts.dedupMaxSize });
  const privacyScrubStage = createPrivacyScrubStage();
  const extractionStage = createExtractionStage({
    storage,
    concurrency: opts.extractionConcurrency,
    queueDepth: opts.extractionQueueDepth,
    timeoutMs: opts.extractionTimeout,
  });

  return {
    extraction: extractionStage,

    async process(event: KiroMemEvent): Promise<EventIngestResponse> {
      try {
        // 2a. Run dedup stage
        const dedupResult = await dedupStage.process(event);
        if (dedupResult.action === 'halt') {
          return dedupResult.response;
        }

        // 2b. Run privacy scrub stage
        const scrubResult = await privacyScrubStage.process(dedupResult.event);
        if (scrubResult.action === 'halt') {
          return scrubResult.response;
        }

        const scrubbedEvent = scrubResult.event;

        // 2c. Store the scrubbed event
        await storage.putEvent(scrubbedEvent);

        // 2d. Build response
        const response: EventIngestResponse = {
          event_id: event.event_id,
          stored: true,
        };

        // 2e. Fire async extraction (don't await)
        extractionStage.enqueue(scrubbedEvent);

        // 2f. Return the response
        return response;
      } catch (error: unknown) {
        const message =
          error instanceof Error ? error.message : String(error);
        console.error(
          `pipeline error for event ${event.event_id}: ${message}`,
        );
        return {
          event_id: event.event_id,
          stored: false,
        };
      }
    },
  };
}
