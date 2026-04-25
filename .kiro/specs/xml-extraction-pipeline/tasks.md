# Implementation Plan: XML Extraction Pipeline

## Overview

Replace the current `kiro-cli chat --no-interactive` extraction approach with a structured XML-based extraction pipeline using `kiro-cli acp` (Agent Client Protocol) over stdio. The implementation introduces three new modules (ACP client, XML framer, XML parser), modifies the extraction stage to use them, extends the MemoryRecord schema with new required fields, and updates the compressor agent prompt in the installer.

## Status Summary

**Completed in initial build (Tasks 1–12).** The schema extension, XML framer, XML parser, extraction stage rewrite, compressor prompt update, modularity guards, test helpers, and integration tests are all done. All 281 unit tests pass.

**Remaining work (Task 13).** During integration testing we discovered the hand-rolled ACP JSON-RPC layer built in Tasks 5.1–5.5 did not match the real ACP spec at five separate points (wrong `initialize` params, wrong `session/new` params, wrong `session/prompt` shape, wrong notification method, wrong completion signal). We patched it to get a working connection, but the patched implementation still reimplements protocol plumbing the official SDK already provides. Task 13 replaces our hand-rolled transport with the official `@agentclientprotocol/sdk` so we get spec conformance, typed schemas, and future protocol updates for free.

## Tasks

- [x] 1. Extend MemoryRecord schema with new required fields
  - [x] 1.1 Add `concepts`, `files_touched`, and `observation_type` fields to `MemoryRecordSchema` in `src/types/schemas.ts`
    - _Requirements: 8.1, 8.2, 8.3_
  - [x] 1.2 Update `src/types/index.ts` to re-export `ObservationType` and `OBSERVATION_TYPES`
    - _Requirements: 8.1, 8.2, 8.3_
  - [x] 1.3 Write unit tests for the new required fields (`test/unit/schemas.newFields.test.ts`)
    - Happy path, missing-field rejection, enum validation, and boundary-length tests
    - _Requirements: 8.1, 8.2, 8.3_

- [x] 2. Implement XML Framer (`src/collector/pipeline/xml-framer.ts`)
  - [x] 2.1 `escapeXml` — replace `<`, `>`, `&`, `"`, `'` with XML entity references
    - _Requirements: 3.1, 3.2_
  - [x] 2.2 `frameEvent` — convert a `KiroMemEvent` to a `<tool_observation>` XML string; handles `json` / `text` / `message` body types
    - _Requirements: 2.1–2.7_
  - [x] 2.3 Property test P1: XML escape round-trip safety (`test/unit/xml-escape.property.test.ts`)
    - _Validates: Requirements 3.1, 3.2_
  - [x] 2.4 Property test P2: XML framing well-formedness (`test/unit/xml-framing.property.test.ts`)
    - _Validates: Requirements 2.1, 2.2, 2.6_
  - [x] 2.5 Property test P6: escape/unescape round-trip (`test/unit/xml-unescape-roundtrip.property.test.ts`)
    - _Validates: Requirement 3.3_
  - [x] 2.6 Unit tests for `frameEvent` (`test/unit/xml-framer.test.ts`) covering all body types, missing fields, escaping, and conditional `<output>`
    - _Requirements: 2.1–2.7_

- [x] 3. Implement XML Parser (`src/collector/pipeline/xml-parser.ts`)
  - [x] 3.1 `unescapeXml` — convert entity references back to their original characters
    - _Requirements: 4.8_
  - [x] 3.2 `parseMemoryXml` — extract `<memory_record>` blocks via regex, validate `type`, truncate to length limits, unescape
    - Exports `RawMemoryFields` and `ObservationType`
    - _Requirements: 4.1–4.8_
  - [x] 3.3 `isGarbageResponse` — detect non-empty text lacking both `<memory_record` and `<skip`
    - _Requirements: 5.1–5.4_
  - [x] 3.4 Property test P3: XML parse extracts all valid records (`test/unit/xml-parser.property.test.ts`)
    - _Validates: Requirements 4.1, 4.2_
  - [x] 3.5 Property test P4: empty/whitespace input handling (`test/unit/xml-parser-empty.property.test.ts`)
    - _Validates: Requirements 5.1, 5.4_
  - [x] 3.6 Property test P5: garbage detection correctness (`test/unit/xml-parser-garbage.property.test.ts`)
    - _Validates: Requirements 5.2, 5.3, 5.4_
  - [x] 3.7 Property test P9: title/summary length enforcement (`test/unit/xml-parser-truncation.property.test.ts`)
    - _Validates: Requirements 4.6, 4.7_
  - [x] 3.8 Unit tests for `parseMemoryXml` and `isGarbageResponse` (`test/unit/xml-parser.test.ts`) covering single/multi records, invalid types, missing fields, unescaping, and garbage categories
    - _Requirements: 4.1–4.8, 5.1–5.4_

- [x] 4. Checkpoint — All unit tests pass after Tasks 1–3

- [x] 5. Implement initial hand-rolled ACP client (`src/collector/pipeline/acp-client.ts`)
  - **Note:** This task built a hand-rolled JSON-RPC transport. Integration testing revealed the hand-rolled protocol did not match the actual ACP spec. The implementation was patched to reach the correct on-wire shapes, but it still duplicates protocol plumbing the official SDK provides. Task 13 replaces it with the official SDK. The sub-tasks below are kept for historical traceability.
  - [x] 5.1 JSON-RPC types and `AcpClientOptions` / `AcpSession` interfaces
  - [x] 5.2 `createAcpSession` — spawn `kiro-cli acp`, readline-based stdout reader, pending-request map, handshake
  - [x] 5.3 `sendPrompt` — accumulate chunks, resolve on turn completion, enforce timeout
  - [x] 5.4 `destroy` — SIGTERM then SIGKILL after 2s
  - [x] 5.5 Unit tests with mocked child process (`test/unit/acp-client.test.ts`)

- [x] 6. Update extraction stage (`src/collector/pipeline/index.ts`)
  - [x] 6.1 `invokeCompressor` — frame → ACP session → parse → retry on garbage; always destroys the session in `finally`
    - _Requirements: 6.1, 6.2, 6.3, 6.6, 6.8_
  - [x] 6.2 `runExtraction` — handle multiple records per event with unique ULID-based `record_id`s
    - _Requirements: 6.1, 6.3, 6.4, 6.5_
  - [x] 6.3 `maxRetries` added to `ExtractionStageOptions` with a default of 3 and positive-integer validation
    - _Requirements: 6.7_
  - [x] 6.4 Removed `spawnKiroCli` and `extractBodyContent`; removed the direct `spawn` import
    - _Requirements: 6.1_
  - [x] 6.5 Unit tests for the updated stage (`test/unit/extraction-stage.test.ts`) covering valid XML, garbage retry, retry exhaustion, multi-record IDs, session cleanup on all paths
    - _Requirements: 6.1–6.8_

- [x] 7. Checkpoint — All unit tests pass after Tasks 1–6

- [x] 8. Update compressor agent prompt in installer
  - [x] 8.1 Replace the JSON-based `compressorPrompt` in `src/installer/index.ts` with the XML-based prompt from the design
    - _Requirements: 7.1–7.5_
  - [x] 8.2 Unit tests for the prompt (`test/unit/installer-compressor-prompt.test.ts`) verifying key XML markers are present and no JSON output references remain
    - _Requirements: 7.1–7.5_

- [x] 9. Verify modularity boundaries
  - [x] 9.1 Import boundary tests for the new pipeline modules (`test/unit/no-storage-in-xml-modules.test.ts`)
    - _Requirements: 9.1, 9.2, 9.3_

- [x] 10. Update test helpers
  - [x] 10.1 `arbitraryMemoryRecord()` in `test/helpers/arbitrary.ts` generates the new required fields
    - Also updated `test/helpers/fixtures.ts` so shared fixtures carry the new fields
    - _Requirements: 8.1, 8.2, 8.3_

- [x] 11. Update integration tests (`test/integ/extraction-pipeline.test.ts`)
  - [x] 11.1 Tests cover all four event kinds (`tool_use`, `prompt`, `session_summary`, `note`) and both the `text` and `message` body types, each driven through a real ACP session
    - Gated behind `kiro-cli acp --help` and the presence of the compressor agent config; skip gracefully otherwise
    - _Requirements: 1.1, 1.4, 1.5, 2.1, 4.1, 6.1_

- [x] 12. Final checkpoint — All 281 unit tests pass; TypeScript `tsc --noEmit` clean

- [x] 13. Replace hand-rolled ACP transport with the official `@agentclientprotocol/sdk`
  - Context: Tasks 5.1–5.5 hand-rolled the JSON-RPC 2.0 transport. Integration testing against a real `kiro-cli acp` revealed five deviations from the actual ACP spec. We patched the client, but the patched code still reimplements protocol plumbing the official SDK already provides. This task swaps our hand-rolled transport for `@agentclientprotocol/sdk` while keeping the `AcpSession` facade identical so nothing downstream changes.
  - [x] 13.1 Add `@agentclientprotocol/sdk` as a runtime dependency
    - Pin to an exact version (no caret or tilde) so protocol behaviour is reproducible across installs
    - Update `package.json` and `package-lock.json`
    - _Requirements: 9.4_
  - [x] 13.2 Rewrite `src/collector/pipeline/acp-client.ts` on top of the SDK
    - Delete hand-rolled types: `JsonRpcRequest`, `JsonRpcResponse`, `JsonRpcNotification`, `SessionNotification`
    - Delete the `readline`-based line reader, monotonic ID counter, and `pending` request map — the SDK owns all of that
    - Import `ClientSideConnection`, `ndJsonStream`, and schema types from `@agentclientprotocol/sdk`
    - Spawn `kiro-cli acp --agent <agentName>`, build an `ndJsonStream` over its stdio, construct a `ClientSideConnection` with a minimal `Client` handler:
      - `sessionUpdate(params)` — accumulate `params.update.content.text` when `params.update.sessionUpdate === 'agent_message_chunk'`; ignore every other update kind
      - `requestPermission(...)` — return `{ outcome: { outcome: 'cancelled' } }` as a defensive default (the compressor has no tools)
    - Run the handshake via `connection.initialize({ protocolVersion: 1, capabilities: {}, clientInfo: { name: 'kiro-learn', version } })` and `connection.newSession({ cwd, mcpServers: [] })`; capture `sessionId`
    - In `sendPrompt`, race `connection.prompt({ sessionId, prompt: [{ type: 'text', text: content }] })` against a `setTimeout(timeoutMs)`; return the accumulated text on resolution, destroy the child and reject on timeout
    - Keep the `AcpSession` public surface identical (`sendPrompt(string): Promise<string>`, `destroy(): void`) so the Extraction_Stage needs no changes
    - _Requirements: 1.1–1.10_
  - [x] 13.3 Update unit tests (`test/unit/acp-client.test.ts`) for the SDK-based client
    - Replace the `node:child_process` + stdout/stdin mock with either (a) fake `Readable`/`Writable` streams wired through `ndJsonStream`, or (b) a direct mock of `ClientSideConnection` that injects resolved/rejected promises for `initialize`, `newSession`, and `prompt`
    - Coverage: successful handshake, `initialize` rejection, `newSession` rejection, `sendPrompt` accumulates chunks delivered via the `Client.sessionUpdate` handler, `sendPrompt` timeout kills the child and rejects, `destroy` SIGTERM→SIGKILL flow
    - Drop any assertions on hand-rolled JSON-RPC framing — that's now the SDK's responsibility, not ours to verify
    - _Requirements: 1.1–1.8_
  - [x] 13.4 Update import boundary guard (`test/unit/no-storage-in-xml-modules.test.ts`)
    - `acp-client.ts` may now import from `node:child_process`, `node:stream`, and `@agentclientprotocol/sdk`
    - Keep the prohibition on `src/collector/storage/`
    - _Requirements: 9.1_
  - [x] 13.5 Run the full unit suite (`npx vitest --run`) and `npx tsc --noEmit`; fix any regressions
  - [x] 13.6 Run the integration suite (`npm run test:integ`) against a real `kiro-cli acp` to confirm end-to-end handshake → prompt → streamed response → completion still works across all four event kinds and both body types
    - Suite skips gracefully when kiro-cli / agent config / Bedrock credentials are not present

## Notes

- Each task references specific requirements for traceability.
- Checkpoints ensure incremental validation; Task 13.5 and 13.6 are the final gates.
- Property tests validate universal correctness properties from the design document.
- Unit tests validate specific examples and edge cases.
- The project uses TypeScript with strict mode, vitest for testing, and fast-check for property-based tests.
- All modules follow the existing project conventions: ESM imports with `.js` extensions, `exactOptionalPropertyTypes` compliance, and `noUncheckedIndexedAccess` guards.
- **ACP spec reference:** the protocol is defined at [agentclientprotocol.com](https://agentclientprotocol.com). Kiro's agent layers vendor-specific notifications prefixed with `_kiro.dev/`; the SDK routes these to the `Client` handler for us to ignore.
