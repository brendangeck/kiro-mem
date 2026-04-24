# Implementation Plan: Collector Pipeline

## Overview

Implement the collector pipeline — the long-running local daemon that receives events over HTTP, processes them through staged pipeline processors (dedup → privacy scrub → storage → async extraction), and answers synchronous retrieval requests within a bounded latency budget. All pipeline modules interact with storage exclusively through the `StorageBackend` interface. The implementation builds on the existing event-schema-and-storage spec (types, schemas, SQLite backend).

## Tasks

- [x] 1. Update shared types and rename enrichment → retrieval
  - [x] 1.1 Rename `EnrichmentResult` to `RetrievalResult` and update `EventIngestResponse` in `src/types/index.ts`
    - Rename the `EnrichmentResult` interface to `RetrievalResult`
    - Change the `enrichment?` field on `EventIngestResponse` to `retrieval?: RetrievalResult`
    - Update all TSDoc comments to reflect the new terminology
    - Update any re-exports or references across the codebase
    - _Requirements: 3.2, 10.3, 14.1_

  - [x] 1.2 Move `src/collector/enrichment/` to `src/collector/retrieval/`
    - Delete the old `src/collector/enrichment/index.ts` stub
    - Create `src/collector/retrieval/index.ts` as the new module location
    - _Requirements: 10.1, 10.2_

- [x] 2. Implement pipeline core and processor interface
  - [x] 2.1 Define `PipelineProcessor`, `StageResult`, `Pipeline`, and `PipelineOptions` types in `src/collector/pipeline/index.ts`
    - Export `StageResult` discriminated union (`continue` | `halt`)
    - Export `PipelineProcessor` interface with `name` and `process` method
    - Export `Pipeline` interface with `process` method
    - Export `PipelineOptions` interface with storage, extraction config, and dedup config
    - Export `createPipeline` function signature
    - _Requirements: 17.1, 17.2, 17.3, 17.4, 4.1_

  - [x] 2.2 Implement `createDedupStage` — bounded LRU dedup using `Map`
    - Implement the dedup stage as a `PipelineProcessor`
    - Use `Map<string, true>` for O(1) lookup with insertion-order eviction
    - On duplicate `event_id`: return `{ action: 'halt', response: { event_id, stored: false } }`
    - On new `event_id`: add to set, evict oldest if at capacity, return `{ action: 'continue', event }`
    - Cap set at configurable `maxSize` (default 10,000)
    - _Requirements: 5.1, 5.2, 5.3, 5.4, 5.5_

  - [x] 2.3 Write property test: Dedup rejects duplicate event_ids (Property 5)
    - **Property 5: Dedup rejects duplicate event_ids**
    - For any valid event, submitting it twice returns `continue` then `halt` with `stored: false`
    - **Validates: Requirements 5.2, 5.3**

  - [x] 2.4 Write property test: Dedup set respects size bound (Property 6)
    - **Property 6: Dedup set respects size bound**
    - For any sequence of N distinct events where N > maxSize, the internal set never exceeds maxSize
    - **Validates: Requirements 5.4**

  - [x] 2.5 Implement `createPrivacyScrubStage` and `scrubPrivateSpans`
    - Export `scrubPrivateSpans(input: string): string` for direct testing
    - Implement single-pass scan: replace `<private>...</private>` spans with `[REDACTED]`
    - Handle nested tags (outermost pair is the boundary)
    - Handle unclosed tags (span extends to end of string)
    - Dispatch on `event.body.type`: `text` → scrub `content`; `message` → scrub each turn's `content`; `json` → recursive walk of all string values
    - Produce a new event object (immutability — never mutate the original)
    - _Requirements: 6.1, 6.2, 6.3, 6.4, 6.5, 6.6, 6.7_

  - [x] 2.6 Write property test: Privacy scrub completeness (Property 1)
    - **Property 1: Privacy scrub completeness**
    - For any event with `<private>` spans, scrubbing then `JSON.stringify` produces zero occurrences of `<private>`
    - Extend `test/arbitrary.ts` with `arbitraryEventWithPrivateSpans()` generator
    - **Validates: Requirements 4.3, 6.1, 6.2, 6.3, 6.5, 6.6, 7.1**

  - [x] 2.7 Write property test: Privacy scrub idempotency (Property 2)
    - **Property 2: Privacy scrub idempotency**
    - For any event, `scrub(scrub(event))` deep-equals `scrub(event)`
    - **Validates: Requirements 7.2**

  - [x] 2.8 Write property test: Privacy scrub immutability (Property 3)
    - **Property 3: Privacy scrub immutability**
    - For any event, a deep clone taken before scrubbing deep-equals the original after scrubbing
    - **Validates: Requirements 6.7**

  - [x] 2.9 Write property test: Privacy scrub identity on clean input (Property 4)
    - **Property 4: Privacy scrub identity on clean input**
    - For any event with no `<private>` substring, scrubbing produces a deep-equal result
    - Extend `test/arbitrary.ts` with `arbitraryCleanEvent()` generator
    - **Validates: Requirements 6.4**

- [x] 3. Implement extraction stage
  - [x] 3.1 Implement `createExtractionStage` with semaphore-based concurrency control
    - Implement `enqueue(event)` — adds to FIFO queue, calls `tryRunNext()`
    - Implement `drain(timeoutMs)` — waits for all pending extractions
    - Implement concurrency semaphore: track `active` count, process from queue when slots available
    - On queue overflow (exceeds `queueDepth`): drop oldest, log warning
    - Spawn `kiro-cli` via `node:child_process.spawn`, pass event body via stdin, read result from stdout
    - Enforce per-extraction timeout (default 30s), kill child on timeout
    - On success: validate with `parseMemoryRecord`, set `namespace`, `source_event_ids`, `strategy: 'llm-summary'`, call `storage.putMemoryRecord`
    - On failure: log warning, continue (event is stored, only memory record is missing)
    - _Requirements: 8.1, 8.2, 8.3, 8.4, 8.5, 8.6, 8.7, 8.8, 9.1, 9.2, 9.3, 18.1, 18.2, 18.3, 18.4_

  - [x] 3.2 Write property test: Extraction concurrency bound (Property 10)
    - **Property 10: Extraction concurrency bound**
    - For any sequence of N events where N > concurrency limit, the number of concurrently active processes never exceeds the configured limit
    - Use a mock `kiro-cli` spawner that tracks active count
    - **Validates: Requirements 9.1, 9.2**

- [x] 4. Implement pipeline composition
  - [x] 4.1 Implement `createPipeline` — compose stages into ordered chain with async extraction
    - Wire stages in fixed order: DedupStage → PrivacyScrubStage → StorageStage (calls `storage.putEvent`)
    - When a stage signals `halt`, stop and return the halt response
    - When all stages complete, return `{ event_id, stored: true }`
    - After returning the response, fire async extraction via `extractionStage.enqueue(event)`
    - Catch unexpected stage errors, log them, return a generic error response
    - _Requirements: 4.1, 4.2, 4.3, 4.4, 17.2, 17.3, 16.1, 16.2, 19.1, 19.2, 19.3_

- [x] 5. Checkpoint
  - Ensure all tests pass, ask the user if questions arise.

- [x] 6. Implement query layer and retrieval assembly
  - [x] 6.1 Implement `createQueryLayer` in `src/collector/query/index.ts`
    - Export `QueryLayer` interface with `search(namespace, query, limit)` method
    - Implement as thin pass-through to `storage.searchMemoryRecords({ namespace, query, limit })`
    - Return results in storage backend order
    - Return empty array (not error) when backend returns no results
    - _Requirements: 12.1, 12.2, 12.3, 12.4_

  - [x] 6.2 Implement `createRetrievalAssembler` in `src/collector/retrieval/index.ts`
    - Export `RetrievalResult`, `RetrievalAssembler`, `RetrievalDeps` interfaces
    - Implement `assemble(event, budgetMs)`:
      - Extract search query from event body (`text` → content, `message` → last turn content, `json` → JSON.stringify(data))
      - Use `Promise.race` between query and timeout for latency budget enforcement
      - On timeout or error: return `{ context: '', records: [], latency_ms }` (never error to caller)
      - Format results via `formatContext(records)` — header, title, summary, facts per record
    - _Requirements: 10.1, 10.2, 10.3, 10.4, 11.1, 11.2, 11.3, 11.4, 13.1, 13.2, 13.3, 13.4_

  - [x] 6.3 Write property test: Search query extraction correctness (Property 9)
    - **Property 9: Search query extraction correctness**
    - For any prompt event, the extracted query equals `body.content` for text, last turn's content for message, `JSON.stringify(body.data)` for json
    - **Validates: Requirements 10.4**

  - [x] 6.4 Write property test: Context formatting completeness (Property 8)
    - **Property 8: Context formatting completeness**
    - For any non-empty array of valid MemoryRecords, the formatted context contains the header, each record's title, summary, and facts
    - **Validates: Requirements 10.2, 13.1, 13.2, 13.4**

- [x] 7. Implement HTTP receiver
  - [x] 7.1 Implement `startReceiver` in `src/collector/receiver/index.ts`
    - Export `ReceiverDeps`, `ReceiverOptions`, `ReceiverHandle` interfaces
    - Bind `node:http` server to `opts.host:opts.port`
    - Route `POST /v1/events` → ingest handler; `GET /healthz` → health check; everything else → 404
    - Enforce `Content-Type: application/json` when header is present (415 otherwise)
    - Read request body incrementally; abort with 413 if `maxBodyBytes` exceeded
    - Parse JSON (400 on syntax error), validate via `parseEvent` (400 on ZodError with error path, no stack traces)
    - Delegate to `pipeline.process(event)` for processing
    - If `retrieve=true` query param AND event kind is `prompt`, call `retrieval.assemble(event, budget)` and attach to response
    - Return `EventIngestResponse` as JSON with appropriate status codes
    - Implement `close()` for graceful shutdown (stop accepting, drain in-flight)
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 1.7, 1.8, 1.9, 2.1, 2.2, 3.1, 3.2, 3.3, 3.4, 3.5, 15.1, 15.2, 15.3, 16.1, 16.3, 20.1, 20.2_

  - [x] 7.2 Write property test: Retrieval gating (Property 7)
    - **Property 7: Retrieval gating**
    - For any event and any value of `retrieve`, the response contains a `retrieval` field if and only if `retrieve === "true"` AND `kind === "prompt"`
    - Use a mock pipeline and retrieval assembler
    - **Validates: Requirements 3.2, 3.3, 3.4, 3.5**

- [x] 8. Implement collector daemon wiring
  - [x] 8.1 Implement `startCollector` in `src/collector/index.ts`
    - Export `CollectorConfig` interface and `DEFAULT_COLLECTOR_CONFIG` with all defaults
    - Export `CollectorHandle` interface with `close()` method
    - Implement `startCollector(config?)`:
      - Merge provided config with defaults
      - Open storage via `openSqliteStorage` (the ONLY place that knows the concrete backend)
      - Create pipeline with all stages, injecting `StorageBackend`
      - Create query layer, injecting `StorageBackend`
      - Create retrieval assembler, injecting query layer
      - Start HTTP receiver, injecting pipeline and retrieval
      - Return handle with `close()` that: stops receiver, drains extraction, closes storage
    - _Requirements: 14.1, 14.2, 14.3, 14.4, 14.5, 15.1_

- [x] 9. Checkpoint
  - Ensure all tests pass, ask the user if questions arise.

- [x] 10. Add lint-style modularity guard test
  - [x] 10.1 Write guard test: no direct SQLite imports in pipeline modules
    - Create `test/no-sqlite-in-pipeline.test.ts` following the pattern in `test/no-private-scrub.test.ts`
    - Scan `src/collector/receiver/`, `src/collector/pipeline/`, `src/collector/retrieval/`, `src/collector/query/` for imports from `src/collector/storage/sqlite/`
    - Any match is a modularity violation — the test should fail with a clear message identifying the offending file and line
    - Strip comments before scanning (same approach as existing guard test)
    - _Requirements: Design § Modularity boundary_

- [x] 11. Final checkpoint
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional and can be skipped for faster MVP
- Each task references specific requirements for traceability
- Checkpoints ensure incremental validation
- Property tests validate universal correctness properties from the design document (P1–P10)
- The implementation language is TypeScript, matching the existing codebase
- All pipeline modules receive `StorageBackend` via dependency injection — only `src/collector/index.ts` imports from `src/collector/storage/sqlite/`
- Extend `test/arbitrary.ts` with new generators (`arbitraryEventWithPrivateSpans`, `arbitraryCleanEvent`) for property tests
- The existing `fast-check` and `vitest` dev dependencies are used for all testing
