/**
 * Canonical types for kiro-mem.
 *
 * The Event schema is the one-way-door contract. See AGENTS.md for the full
 * narrative. Additions are additive; breaking changes bump `schema_version`.
 */

/**
 * The discrete kinds of events a client may emit.
 *
 * - `prompt` — a user prompt to the agent
 * - `tool_use` — a single tool invocation within a prompt turn
 * - `session_summary` — a session-closing summary
 * - `note` — a manually recorded note (future use)
 */
export type EventKind = 'prompt' | 'tool_use' | 'session_summary' | 'note';

/**
 * Discriminated body. The `type` tells the collector how to interpret `content`.
 */
export type EventBody =
  | { type: 'text'; content: string }
  | { type: 'message'; turns: Array<{ role: string; content: string }> }
  | { type: 'json'; data: unknown };

export interface EventSource {
  surface: 'kiro-cli' | 'kiro-ide';
  version: string;
  client_id: string;
}

/**
 * Wire-level ingest unit. Posted by a shim to `POST /v1/events`.
 */
export interface KiroMemEvent {
  event_id: string;
  parent_event_id?: string;
  session_id: string;
  actor_id: string;
  namespace: string;
  schema_version: 1;

  kind: EventKind;
  body: EventBody;

  valid_time: string;

  source: EventSource;

  content_hash?: string;
}

/**
 * Processed, long-term memory unit extracted from one or more events by a
 * memory strategy. Stored under a namespace, retrieved at enrichment time.
 */
export interface MemoryRecord {
  record_id: string;
  namespace: string;
  strategy: string;
  title: string;
  summary: string;
  facts: string[];
  source_event_ids: string[];
  created_at: string;
}

/**
 * Result returned to the shim in response to a POST /v1/events call.
 */
export interface EventIngestResponse {
  event_id: string;
  stored: boolean;
  enrichment?: EnrichmentResult;
}

export interface EnrichmentResult {
  context: string;
  records: string[];
  latency_ms: number;
}

/**
 * Storage backend interface. Any backend (SQLite, pgvector, AgentCore) must
 * implement this. v1 ships only the SQLite implementation.
 */
export interface StorageBackend {
  putEvent(event: KiroMemEvent): Promise<void>;
  putMemoryRecord(record: MemoryRecord): Promise<void>;
  searchMemoryRecords(params: {
    namespace: string;
    query: string;
    limit: number;
  }): Promise<MemoryRecord[]>;
  close(): Promise<void>;
}
