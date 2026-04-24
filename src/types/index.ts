/**
 * Canonical types for kiro-learn.
 *
 * The `Event` schema is the one-way-door contract. See AGENTS.md for the
 * architectural narrative and
 * `.kiro/specs/event-schema-and-storage/design.md` for field-level details.
 *
 * Runtime shapes and validators live in `./schemas.js`; this module derives
 * TypeScript types from those schemas and re-exports them alongside the
 * interfaces used by the collector pipeline and storage layer.
 *
 * Additions to the `Event` or `MemoryRecord` shape MUST be additive; any
 * breaking change bumps `schema_version`.
 */

import type { KiroMemEvent, MemoryRecord } from './schemas.js';

export {
  EventBodySchema,
  EventSchema,
  EventSourceSchema,
  MemoryRecordSchema,
  ULID_RE,
  RECORD_ID_RE,
  NAMESPACE_RE,
  CONTENT_HASH_RE,
  parseEvent,
  parseMemoryRecord,
} from './schemas.js';

export type { KiroMemEvent, MemoryRecord } from './schemas.js';

/**
 * The discrete kinds of events a client may emit.
 *
 * - `prompt` — a user prompt to the agent
 * - `tool_use` — a single tool invocation within a prompt turn
 * - `session_summary` — a session-closing summary
 * - `note` — a manually recorded note (future use)
 *
 * Derived from {@link KiroMemEvent} so it stays in lockstep with the Zod
 * schema.
 *
 * @see Requirements 1.2
 */
export type EventKind = KiroMemEvent['kind'];

/**
 * Discriminated body. The `type` tells the collector how to interpret the
 * payload (text content, message turns, or arbitrary JSON data).
 *
 * @see Requirements 1.3
 */
export type EventBody = KiroMemEvent['body'];

/**
 * Provenance block — who emitted the event and from which client surface.
 *
 * @see Requirements 1.4
 */
export type EventSource = KiroMemEvent['source'];

/**
 * Parameters accepted by {@link StorageBackend.searchMemoryRecords}. The
 * `namespace` is treated as a prefix (trailing-slash convention); `query` is
 * a user-supplied string and is sanitized by the storage layer before being
 * passed to FTS5.
 *
 * @see Requirements 4.5, 8.3, 8.4
 */
export interface SearchParams {
  namespace: string;
  query: string;
  limit: number;
}

/**
 * Result returned to the shim in response to a `POST /v1/events` call. When
 * the shim requested synchronous retrieval, `retrieval` is populated.
 *
 * Not directly a requirement in this spec; part of the collector API
 * surface consumed by downstream receiver / retrieval specs.
 *
 * @see Requirements 1.5 (re-exported on the package entry point)
 */
export interface EventIngestResponse {
  event_id: string;
  stored: boolean;
  retrieval?: RetrievalResult;
}

/**
 * Context assembled by the retrieval subsystem for a single prompt-time
 * lookup. Returned inline in the ingest response.
 *
 * Not directly a requirement in this spec; part of the collector API
 * surface consumed by downstream retrieval specs.
 *
 * @see Requirements 1.5 (re-exported on the package entry point)
 */
export interface RetrievalResult {
  context: string;
  records: string[];
  latency_ms: number;
}

/**
 * Storage backend interface. Any backend (SQLite, pgvector, AgentCore) must
 * implement this identically. v1 ships only the SQLite implementation.
 *
 * Behavioral contracts (see design.md § Key Functions):
 * - `putEvent` is idempotent on `event_id`; duplicate calls are a no-op and
 *   do not re-stamp `transaction_time`.
 * - `getEventById` returns `null` for unknown ids; it does not throw.
 * - `putMemoryRecord` rejects on `record_id` collision.
 * - `searchMemoryRecords` returns at most `limit` records, all of whose
 *   namespaces start with the supplied `namespace` prefix.
 * - `close` is safe to call more than once.
 *
 * @see Requirements 4.1–4.6
 */
export interface StorageBackend {
  putEvent(event: KiroMemEvent): Promise<void>;
  getEventById(eventId: string): Promise<KiroMemEvent | null>;
  putMemoryRecord(record: MemoryRecord): Promise<void>;
  searchMemoryRecords(params: SearchParams): Promise<MemoryRecord[]>;
  close(): Promise<void>;
}
