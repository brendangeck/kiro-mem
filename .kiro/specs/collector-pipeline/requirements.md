# Requirements: Collector Pipeline

## Introduction

This document defines the requirements for the kiro-learn collector pipeline — the long-running local daemon that receives events over HTTP, processes them through a staged pipeline (dedup → privacy scrub → memory strategy extraction → storage), and answers synchronous retrieval requests within a bounded latency budget.

This spec builds on the contracts established in [event-schema-and-storage](../event-schema-and-storage/requirements.md): the canonical `KiroMemEvent` and `MemoryRecord` types, the `StorageBackend` interface, and the SQLite + FTS5 implementation. Those are consumed here, not redefined.

**In scope:** HTTP receiver, pipeline stages (dedup, privacy scrub, extraction), retrieval assembly, query layer, and the collector daemon wiring that ties them together.

**Out of scope:** Shim (`src/shim/`), installer (`src/installer/`), daemon lifecycle management (PID files, start/stop CLI), embeddings, semantic search, MCP tool wrappers.

## Glossary

- **Collector**: The long-running local daemon process that hosts the receiver, pipeline, retrieval, and query subsystems. Binds to `127.0.0.1` on a configurable port.
- **Receiver**: The HTTP endpoint (`POST /v1/events`) that accepts canonical `KiroMemEvent` JSON from shims.
- **Pipeline**: The ordered chain of processors an event traverses between the receiver and storage: dedup → privacy scrub → memory strategy extraction → storage.
- **Pipeline_Stage**: A single processor in the pipeline chain. Each stage receives an event (or derivative), transforms or filters it, and passes the result to the next stage.
- **Dedup_Stage**: The pipeline stage that rejects events whose `event_id` has already been processed in the current collector lifetime, before hitting storage.
- **Privacy_Scrub_Stage**: The pipeline stage that strips `<private>...</private>` tagged spans from event body content before anything reaches storage or LLM extraction.
- **Extraction_Stage**: The pipeline stage that invokes `kiro-cli` (→ Amazon Bedrock) to distill an event into a structured `MemoryRecord`. Runs asynchronously after the ingest response is returned.
- **Retrieval**: The synchronous context-retrieval path. When a `prompt` event arrives with `retrieve=true`, the retrieval subsystem searches existing memory records and returns formatted context within the latency budget. This is a read operation piggybacked on the POST — the shim gets relevant prior context in the same round trip as the event store.
- **Query_Layer**: The retrieval surface over stored memory records. v1 uses lexical FTS5 search scoped by namespace.
- **Latency_Budget**: The hard deadline (default 500 ms) for retrieval responses. The collector returns whatever results are available at deadline rather than failing.
- **StorageBackend**: The pluggable persistence interface defined in the event-schema-and-storage spec. The pipeline writes through this interface; it never reaches past it into a specific implementation.
- **Memory_Strategy**: The configurable rule that determines how events become memory records. v1 has one strategy: LLM summarization via `kiro-cli` → Amazon Bedrock.
- **EventIngestResponse**: The JSON response shape returned by `POST /v1/events`, containing `event_id`, `stored`, and optional `retrieval`.
- **RetrievalResult**: The context payload returned inline in the ingest response: `context` (formatted string), `records` (array of record IDs), `latency_ms`.

## Requirements

### Requirement 1: HTTP Receiver Endpoint

**User Story:** As a shim author, I want a single HTTP endpoint to POST canonical events to, so that capture is a single HTTP call with no routing ambiguity.

#### Acceptance Criteria

1. WHEN the Collector starts, THE Receiver SHALL bind an HTTP server to `127.0.0.1` on a configurable port (default `21100`).
2. WHEN a `POST /v1/events` request arrives with a valid JSON body, THE Receiver SHALL parse the body and pass it to `parseEvent` for Zod validation.
3. WHEN `parseEvent` succeeds, THE Receiver SHALL pass the validated event to the Pipeline for processing.
4. WHEN `parseEvent` throws `ZodError`, THE Receiver SHALL respond with HTTP `400` and a JSON body containing the Zod error path and message.
5. WHEN the request body is not valid JSON, THE Receiver SHALL respond with HTTP `400` and a JSON body containing a parse error message.
6. WHEN the request method is not `POST` or the path is not `/v1/events`, THE Receiver SHALL respond with HTTP `404`.
7. WHEN the request Content-Type header is present and is not `application/json`, THE Receiver SHALL respond with HTTP `415`.
8. WHEN the pipeline processes the event successfully, THE Receiver SHALL respond with HTTP `200` and a JSON body conforming to the `EventIngestResponse` type.
9. WHEN the pipeline encounters an internal error, THE Receiver SHALL respond with HTTP `500` and a JSON body containing an error message, and THE Receiver SHALL NOT expose internal stack traces in the response.

### Requirement 2: Request Body Size Limit

**User Story:** As a collector operator, I want the receiver to reject oversized payloads before parsing, so that the daemon is not vulnerable to memory exhaustion from a malformed or malicious request.

#### Acceptance Criteria

1. WHEN a request body exceeds 2 MiB, THE Receiver SHALL respond with HTTP `413` before attempting JSON parse or Zod validation.
2. THE Receiver SHALL read the request body incrementally and abort once the size limit is exceeded, rather than buffering the entire body into memory first.

### Requirement 3: Retrieval Request Path

**User Story:** As a shim author, I want to request synchronous context retrieval when posting a `prompt` event, so that the agent receives relevant prior context before the model runs.

#### Acceptance Criteria

1. WHEN a `POST /v1/events` request includes the query parameter `retrieve=true`, THE Receiver SHALL request synchronous retrieval from the Retrieval subsystem after the event is stored.
2. WHEN retrieval is requested and the event's `kind` is `prompt`, THE Retrieval subsystem SHALL search existing memory records and return a `RetrievalResult`.
3. WHEN retrieval is requested and the event's `kind` is not `prompt`, THE Receiver SHALL store the event normally and return an `EventIngestResponse` without a `retrieval` field.
4. WHEN retrieval is not requested (no `retrieve=true` query parameter), THE Receiver SHALL store the event and return an `EventIngestResponse` without a `retrieval` field.
5. WHEN the `retrieve` query parameter is present with any value other than `true` (e.g., `retrieve=false`, `retrieve=1`, `retrieve=yes`), THE Receiver SHALL treat it as retrieval not requested.

### Requirement 4: Pipeline Stage Ordering

**User Story:** As a collector author, I want the pipeline stages to execute in a fixed, documented order, so that each stage's preconditions are met by the preceding stage's postconditions.

#### Acceptance Criteria

1. THE Pipeline SHALL execute stages in the following order: dedup → privacy scrub → storage. Memory strategy extraction runs asynchronously after the ingest response is returned.
2. WHEN the Dedup_Stage filters out an event, THE Pipeline SHALL skip all subsequent stages for that event and return an `EventIngestResponse` with `stored: false`.
3. WHEN the Privacy_Scrub_Stage completes, THE event passed to storage SHALL contain no `<private>...</private>` spans in any string field of the body.
4. WHEN the storage write completes, THE Pipeline SHALL return an `EventIngestResponse` with `stored: true` and the original `event_id`.

### Requirement 5: Deduplication Stage

**User Story:** As a pipeline author, I want in-memory dedup before hitting storage, so that redundant shim retries are rejected cheaply without a database round-trip.

#### Acceptance Criteria

1. THE Dedup_Stage SHALL maintain an in-memory set of recently seen `event_id` values for the current collector process lifetime.
2. WHEN an event arrives whose `event_id` is already in the dedup set, THE Dedup_Stage SHALL reject the event and THE Pipeline SHALL return `stored: false`.
3. WHEN an event arrives whose `event_id` is not in the dedup set, THE Dedup_Stage SHALL add the `event_id` to the set and pass the event to the next stage.
4. THE Dedup_Stage SHALL cap the in-memory set at a configurable maximum size (default 10,000 entries). WHEN the set reaches capacity, THE Dedup_Stage SHALL evict the oldest entry before inserting a new one.
5. WHEN the collector process restarts, THE Dedup_Stage SHALL start with an empty set. Storage-level idempotency (`INSERT OR IGNORE`) remains the durable dedup guarantee.

### Requirement 6: Privacy Scrub Stage

**User Story:** As a security-conscious user, I want `<private>...</private>` tagged spans stripped from event bodies before anything reaches storage or LLM extraction, so that sensitive information is never persisted or sent to an external service.

#### Acceptance Criteria

1. WHEN an event body of type `text` contains one or more `<private>...</private>` spans, THE Privacy_Scrub_Stage SHALL remove each span (including the tags) and replace it with the literal string `[REDACTED]`.
2. WHEN an event body of type `message` contains `<private>...</private>` spans in any turn's `content` field, THE Privacy_Scrub_Stage SHALL apply the same replacement to each affected turn.
3. WHEN an event body of type `json` is received, THE Privacy_Scrub_Stage SHALL recursively walk all string values in the `data` object and apply the same replacement to any string containing `<private>...</private>` spans.
4. WHEN an event body contains no `<private>...</private>` spans, THE Privacy_Scrub_Stage SHALL pass the event through unchanged.
5. WHEN a `<private>` tag is opened but never closed (malformed), THE Privacy_Scrub_Stage SHALL treat the span as extending to the end of the string and replace from the opening tag onward with `[REDACTED]`.
6. WHEN `<private>...</private>` spans are nested, THE Privacy_Scrub_Stage SHALL treat the outermost pair as the span boundary and produce a single `[REDACTED]` replacement.
7. THE Privacy_Scrub_Stage SHALL produce a new event object; THE original event object SHALL NOT be mutated. (Immutability invariant.)

### Requirement 7: Privacy Scrub Round-Trip Property

**User Story:** As a pipeline author, I want to verify that the privacy scrub is thorough and idempotent, so that no `<private>` content leaks through.

#### Acceptance Criteria

1. FOR ALL valid events containing `<private>...</private>` spans, scrubbing then serializing the result SHALL produce a string that contains zero occurrences of the substring `<private>`. (Round-trip property; **testable as a property**.)
2. FOR ALL valid events, applying the Privacy_Scrub_Stage twice SHALL produce an output identical to applying it once. (Idempotency; **testable as a property**.)

### Requirement 8: Memory Strategy Extraction

**User Story:** As a collector author, I want events to be distilled into structured memory records via LLM summarization, so that long-term memory is built automatically from raw interactions.

#### Acceptance Criteria

1. WHEN an event is successfully stored, THE Extraction_Stage SHALL asynchronously invoke `kiro-cli` to extract a `MemoryRecord` from the event.
2. WHEN `kiro-cli` returns a valid extraction result, THE Extraction_Stage SHALL validate it with `parseMemoryRecord` and store it via `StorageBackend.putMemoryRecord`.
3. IF `kiro-cli` invocation fails (process exit non-zero, timeout, or network error), THEN THE Extraction_Stage SHALL log the error and continue without crashing the collector. The event remains stored; only the memory record is missing.
4. IF `kiro-cli` returns output that fails `parseMemoryRecord` validation, THEN THE Extraction_Stage SHALL log the validation error and discard the malformed record.
5. THE Extraction_Stage SHALL NOT block the ingest response. Extraction runs after the `EventIngestResponse` has been sent to the caller.
6. THE Extraction_Stage SHALL set the `MemoryRecord.namespace` to match the source event's `namespace`.
7. THE Extraction_Stage SHALL set `MemoryRecord.source_event_ids` to contain the source event's `event_id`.
8. THE Extraction_Stage SHALL set `MemoryRecord.strategy` to `"llm-summary"` for v1.

### Requirement 9: Extraction Concurrency Control

**User Story:** As a collector operator, I want extraction to be bounded in concurrency, so that a burst of events does not spawn unbounded `kiro-cli` processes.

#### Acceptance Criteria

1. THE Extraction_Stage SHALL limit concurrent `kiro-cli` invocations to a configurable maximum (default 2).
2. WHEN the concurrency limit is reached, THE Extraction_Stage SHALL queue pending extractions and process them in FIFO order as slots become available.
3. WHEN the extraction queue exceeds a configurable maximum depth (default 100), THE Extraction_Stage SHALL drop the oldest queued extraction and log a warning.

### Requirement 10: Retrieval Assembly

**User Story:** As a shim author, I want the collector to return relevant prior context when I post a prompt event with `retrieve=true`, so that the agent has continuity across sessions.

#### Acceptance Criteria

1. WHEN retrieval is requested for a `prompt` event, THE Retrieval subsystem SHALL query the Query_Layer for memory records matching the event's namespace and body content.
2. THE Retrieval subsystem SHALL format retrieved memory records into a single context string suitable for injection into an agent's context window.
3. THE Retrieval subsystem SHALL return a `RetrievalResult` containing the formatted `context`, the list of `records` (record IDs), and the `latency_ms` elapsed.
4. THE Retrieval subsystem SHALL extract a search query from the prompt event's body: for `text` bodies, use the `content` field; for `message` bodies, use the last turn's `content`; for `json` bodies, use `JSON.stringify(data)`.

### Requirement 11: Retrieval Latency Budget

**User Story:** As a shim author, I want retrieval to return within a hard deadline, so that the agent is never blocked waiting for context assembly.

#### Acceptance Criteria

1. THE Retrieval subsystem SHALL enforce a configurable latency budget (default 500 ms) measured from the start of the retrieval request.
2. WHEN the latency budget expires before retrieval completes, THE Retrieval subsystem SHALL return whatever results have been assembled so far (partial results).
3. WHEN the latency budget expires with zero results, THE Retrieval subsystem SHALL return a `RetrievalResult` with an empty `context` string, an empty `records` array, and the elapsed `latency_ms`.
4. THE Retrieval subsystem SHALL NOT return an error to the caller due to a latency budget expiration. Partial results are always preferable to errors.

### Requirement 12: Query Layer

**User Story:** As a retrieval author, I want a retrieval surface over stored memory records that is scoped by namespace and returns ranked results, so that retrieval context is relevant and isolated per project.

#### Acceptance Criteria

1. THE Query_Layer SHALL delegate to `StorageBackend.searchMemoryRecords` for v1 retrieval.
2. WHEN the Query_Layer receives a search request, THE Query_Layer SHALL pass the namespace, query string, and a configurable result limit (default 10) to the storage backend.
3. THE Query_Layer SHALL return results in the order provided by the storage backend (FTS5 rank for v1).
4. WHEN the storage backend returns an empty result set, THE Query_Layer SHALL return an empty array without error.

### Requirement 13: Retrieval Context Formatting

**User Story:** As a shim author, I want the retrieval context to be a well-structured string, so that the agent runtime can inject it directly into the context window without additional parsing.

#### Acceptance Criteria

1. THE Retrieval subsystem SHALL format each memory record as a block containing the record's title, summary, and facts.
2. THE Retrieval subsystem SHALL separate multiple memory record blocks with a blank line.
3. WHEN zero memory records are retrieved, THE Retrieval subsystem SHALL return an empty string as the `context` field.
4. THE Retrieval subsystem SHALL prefix the formatted context with a header line (e.g., `"## Prior observations from kiro-learn"`) when at least one record is present.

### Requirement 14: Collector Daemon Wiring

**User Story:** As an installer author, I want a single entry point that wires the receiver, pipeline, storage, retrieval, and query subsystems together, so that starting the collector is a single function call.

#### Acceptance Criteria

1. THE Collector module SHALL export a `startCollector` function that accepts a configuration object and returns a handle with a `close` method.
2. WHEN `startCollector` is called, THE Collector SHALL open the storage backend, create the pipeline with all stages, start the HTTP receiver, and wire the retrieval subsystem to the query layer.
3. WHEN the `close` method is called on the collector handle, THE Collector SHALL stop the HTTP server, drain in-flight requests, wait for pending extractions to complete (with a timeout), and close the storage backend.
4. THE Collector SHALL accept configuration for: HTTP port, storage backend path, retrieval latency budget, extraction concurrency limit, extraction queue depth, dedup set size, and result limit.
5. THE Collector SHALL use sensible defaults for all configuration values so that zero-config startup works.

### Requirement 15: Collector Localhost Binding

**User Story:** As a security-conscious user, I want the collector to bind only to localhost, so that the HTTP endpoint is not exposed to the network.

#### Acceptance Criteria

1. THE Collector SHALL bind the HTTP server exclusively to `127.0.0.1`.
2. THE Collector SHALL NOT accept connections from non-loopback interfaces.
3. THE Collector SHALL NOT support TLS in v1. The localhost-only binding is the security boundary.

### Requirement 16: Graceful Error Isolation

**User Story:** As a collector operator, I want a single bad event to not crash the daemon, so that the collector remains available for subsequent events.

#### Acceptance Criteria

1. WHEN any pipeline stage throws an unexpected error for a single event, THE Collector SHALL catch the error, log it, and respond with HTTP `500` for that request only.
2. WHEN the extraction stage fails for a single event, THE Collector SHALL continue processing subsequent events without interruption.
3. WHEN the storage backend becomes temporarily unavailable, THE Collector SHALL return HTTP `503` for affected requests and resume normal operation when the backend recovers.

### Requirement 17: Pipeline Processor Interface

**User Story:** As a pipeline author, I want each stage to conform to a common interface, so that stages are composable and testable in isolation.

#### Acceptance Criteria

1. THE Pipeline SHALL define a `PipelineProcessor` interface where each processor receives an event and returns either a transformed event or a signal to halt processing.
2. THE Pipeline SHALL compose processors into an ordered chain where the output of one processor is the input to the next.
3. WHEN a processor signals halt (e.g., dedup rejects), THE Pipeline SHALL stop processing and return the halt reason.
4. Each Pipeline_Stage SHALL be independently testable without requiring the full collector stack.

### Requirement 18: Extraction via kiro-cli

**User Story:** As a collector author, I want extraction to use `kiro-cli` as the sole LLM backend, so that no third-party API keys are required and all AI work goes through Amazon Bedrock.

#### Acceptance Criteria

1. THE Extraction_Stage SHALL invoke `kiro-cli` as a child process to perform LLM summarization.
2. THE Extraction_Stage SHALL pass the event body content to `kiro-cli` via stdin or a temporary file, and read the structured extraction result from stdout.
3. THE Extraction_Stage SHALL enforce a configurable per-extraction timeout (default 30 seconds). IF the timeout expires, THEN THE Extraction_Stage SHALL kill the child process and log the timeout.
4. THE Extraction_Stage SHALL NOT import or depend on any third-party LLM SDK (no OpenAI, Anthropic, Google AI, etc.).

### Requirement 19: No Mutation of Stored Events

**User Story:** As a storage author, I want the pipeline to never modify an event after it has been passed to `putEvent`, so that the storage layer's idempotency contract is not violated.

#### Acceptance Criteria

1. THE Pipeline SHALL pass a fully processed (deduped, scrubbed) event to `StorageBackend.putEvent` exactly once per accepted event.
2. THE Pipeline SHALL NOT call `putEvent` again with a modified version of the same `event_id`.
3. THE Pipeline SHALL NOT mutate the event object after passing it to `putEvent`.

### Requirement 20: Health Check Endpoint

**User Story:** As an installer author, I want a health check endpoint, so that the installer can verify the collector is running and ready to accept events.

#### Acceptance Criteria

1. WHEN a `GET /healthz` request arrives, THE Receiver SHALL respond with HTTP `200` and a JSON body `{ "status": "ok" }`.
2. THE health check endpoint SHALL NOT require authentication or any request body.

## Non-functional Requirements

### Performance

- N1. WHEN processing a single event (receive → validate → dedup → scrub → store), THE Collector SHALL complete the synchronous path in under 10 ms on commodity developer hardware (Apple M-series, Intel i7, or equivalent), excluding extraction.
- N2. WHEN retrieval is requested, THE Collector SHALL return the `EventIngestResponse` (including retrieval context) within the configured latency budget (default 500 ms).
- N3. THE Dedup_Stage's in-memory lookup SHALL complete in O(1) amortized time.

### Reliability

- N4. WHEN the collector process crashes and restarts, THE storage-level idempotency (`INSERT OR IGNORE`) SHALL prevent duplicate events from the same shim retry. No data is lost; at worst, extraction for in-flight events must be re-triggered.
- N5. THE Collector SHALL handle at least 100 concurrent ingest requests without dropping connections.

### Observability

- N6. THE Collector SHALL log each received event's `event_id`, `kind`, and processing outcome (stored, deduped, error) at `info` level.
- N7. THE Collector SHALL log extraction failures and retrieval timeouts at `warn` level.
- N8. THE Collector SHALL log startup and shutdown events at `info` level, including the bound address and port.

### Security

- N9. THE Collector SHALL bind exclusively to `127.0.0.1`. No remote access in v1.
- N10. THE Collector SHALL use Node.js built-in `node:http` module. No third-party HTTP framework dependencies in v1.
- N11. THE Collector SHALL validate all input through `parseEvent` (Zod) before any processing. No unvalidated data reaches the pipeline.

## Out of Scope (explicit)

The following are **not** in this spec. Each has a dedicated downstream spec or is deferred to a later milestone.

- Shim behavior (event building, local spool, transport to collector)
- Installer (`kiro-learn init`, daemon lifecycle, PID file, `~/.kiro-learn/` bootstrap)
- Daemon process management (daemonization, signal handling, PID files)
- Event schema or `MemoryRecord` type changes (owned by event-schema-and-storage spec)
- Storage backend implementation changes (owned by event-schema-and-storage spec)
- Embeddings, semantic search, hybrid retrieval (v2+)
- MCP tool wrappers (v3)
- TLS, authentication, or authorization on the HTTP endpoint (v4 cloud path)
- Remote/cloud storage backends (v4)
- `kiro-cli` implementation details (treated as an opaque subprocess)
- Settings file parsing and user-editable configuration (installer spec)
- Architecture documentation and docs platform setup (`docs/` directory, Mintlify, GitHub wiki, etc.) — dedicated downstream spec
